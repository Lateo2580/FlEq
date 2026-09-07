# 待機画面: 配信 metadata だけの state で全再計測を起こさない spec

> **裁定（2026-09-07 19:45、ご主人）**: §6 の 5 分岐はすべて A（除外リスト方式／stats は桁数化・sparkline 除外／latestQuake は updatedAtMs 据え置き／残る再計測負荷は別 spec／preview に ?metadataChurnMs= を追加）。本 spec は実装 spec として有効。対応 Issue #15。

> **対象 Issue**: [#15](https://github.com/Lateo2580/FlEq/issues/15)（`[display/performance] generatedAt・seqだけのstate更新でも待機画面の全再計測とページ切替の保留が発生する`）
> **基準 SHA**: Issue 本文は `a58a2f935b694cdbf26d0b054d3adfde9e9d040f`（2026-09-06 の main）。本 spec は `7aabcf251e5776b3aec3f0913bb623a5604036bc`（personal, 2026-09-07）で全 file:line を実測し直した。
> **前提となる再現テスト**: `display/frontend/src/components/__tests__/standby-metadata-resettle.test.ts`（未コミット・既存）。現行 4 件失敗 / 対照 2 件成功を本 spec 起草時に実走で確認済み（§4.1 に採取値）。
> **本 spec の範囲**: 再計測の**起動条件**だけを直す。DOM・CSS・wire・永続化・solver・probe 予算は変更しない。


## 1. 症状

待機画面は、カード内容も表示寸法も一切変わっていない `state` 配信を受け取っただけで、レイアウトの全再計測を最初からやり直す。

`StandbyScreen.svelte` の再計測トリガは `$effect.pre` の `contentKey` で、その先頭 2 要素が `snapshot.generatedAt` と `snapshot.seq` である（`display/frontend/src/components/StandbyScreen.svelte:2070`）。両者はレイアウトの入力ではない。`generatedAt` はサーバが配信時刻をそのまま ISO 文字列にした値で（`src/engine/display/state-store.ts:1237` の `new Date(nowMs).toISOString()`）、`seq` は hub が採番する全体の通し番号である（`display/frontend/src/lib/protocol.ts:1114-1115`）。`store.ts` の `state` 分岐は受信 snapshot を無条件に置き換えるため（`display/frontend/src/lib/store.ts:163-186`、特に 176 行）、この 2 値は state 配信のたびに必ず変わる。

`state` の配信は 500ms の debounce を挟んで繰り返される（`src/engine/display/hub.ts:568-580` の `markStateDirty()` と `STATE_DEBOUNCE_MS`）。契機には VPWS50 / VPWW56 の受理だけでなく、dirty 時の 5 秒 sweep、テロップ期限切れ、stats 変化、接続変化、60 秒周期の地震 store sweep が含まれる。電文が 1 通着いた後はテロップ期限切れが 5 秒刻みで断続的に dirty を立てるため、**画面の見た目が完全に静止している時間帯にも再計測が反復する**。

実機（Raspberry Pi 500）では SSE snapshot が 95KB（うち `standbyItems` 52KB）、電文直後は 370KB を 256KB 上限まで縮退した状態で稼働しており、ご主人により Chrome の「このページの応答がありません」ダイアログが観測されている。ただし**その応答停止が本経路単独の結果であることは未確認**である。本 spec は「不要な再計測の起動をなくす」ことだけを引き受け、応答停止の原因確定は §5.2 の実機採取に委ねる。

## 2. 根因（file:line）

### 2.1 contentKey が配信 metadata を含む

```ts
// display/frontend/src/components/StandbyScreen.svelte:2057-2079
$effect.pre(() => {
  const standbyContentIdentity = snapshot.standbyItems?.map(...).join(",") ?? "";
  const contentKey = [snapshot.generatedAt, snapshot.seq, snapshot.latestQuake?.updatedAtMs ?? "",
    selectedId ?? "", standbyContentIdentity,
    snapshot.weatherAlerts.map((alert) => alert.updatedAt).join(",")].join("|");
  const input = [contentKey, sseConnected].join("|");
  if (input !== lastInputKey) {
    lastInputKey = input;
    contentDemotionRequested = lastContentKey !== "" && contentKey !== lastContentKey;
    lastContentKey = contentKey;
    floorStage = committedStage;
    requestSettle();
  }
});
```

`input` が変われば無条件に `requestSettle()` へ進む。metadata 2 値が毎回変わる以上、この分岐は state 配信のたびに必ず成立する。

### 2.2 requestSettle() が捨てるもの・止めるもの

`requestSettle()`（`StandbyScreen.svelte:1982-2003`）は 1 回の呼び出しで次を行う。

| 行 | 動作 | 内容不変時の損失 |
|---|---|---|
| 1983-1984 | `epoch += 1` / `epochKey` 更新 | 確定済み epoch の破棄 |
| 1987-1988 | `weatherMeasurementContracts.clear()` / `weatherPartitionProbeContracts.clear()` | オブジェクト安定性キャッシュの全破棄 |
| 1989 | `layoutMotionCoordinator.preEpochCapture(epochKey)` | §2.3 参照。可視カードの全 DOM clone |
| 1990 | `coordinator.begin(epochKey)` | probe 調停の再開始 |
| 1991-1992 | `rotationScheduler.holdForEpoch()` / `cardPageCoordinator.holdForEpoch()` | ページ切替・rotation の保留 |
| 1996-1997 | `prefixMeasurements = {}` / `prefixMeasureEntries = []` | 分割候補の測定結果を全破棄 |

`holdForEpoch()` は `epochHeld = true` と `tickPending = true` を立て、タイマーを消し、rotation では進行中のトランジションを取り消す（`display/frontend/src/lib/legacy-standby/time-slice-scheduler.svelte.ts:139-146`、`487-493`）。`scheduleTimer()` は `epochHeld` の間タイマーを一切張らない（同 `234-236`）。

ここは正確に区別する必要がある。**ページ位置そのものは失われない** — `processTickInternal()` は `phaseStartedAtMs` を起点に壁時計から `elapsedTicks` を導くため（同 `249-278`、特に 255-257・276-277）、保留が解けた時点で本来あるべき位置へ追いつく。失われるのは (a) 進行中のトランジション（`cancelTransition()`、同 143 行）、(b) 保留中はタイマーが張られないこと自体である。したがって **settle が 500ms 以内に終わらない限り、次の epoch が来る前に保留が解けず、ページ切替が事実上停止しうる**。これが Issue 表題の「ページ切替の保留」の機序である。

### 2.3 epoch ごとに可視カードを全 clone する

`preEpochCapture()` は、可視状態の登録カードすべてについて `cloneNode(true)` でシェルを複製し、`getBoundingClientRect()` を読む（`display/frontend/src/lib/legacy-standby/layout-motion.svelte.ts:137-156`、特に 145・148 行）。これは FLIP アニメーションの前状態採取で、内容が変わる epoch には必要な処理だが、**内容不変の epoch では純粋な浪費**である。`standbyItems` が 52KB に達する実機では、待機画面の可視 DOM 全体の複製が 500ms ごとに走ることになる。Issue 本文はこのコストを名指ししていない。

### 2.4 settleMeasurements() の反復コスト

`settleMeasurements()`（`StandbyScreen.svelte:1809-1981`）は外側 `MAX_SETTLE_PASSES = 4`（+ 確認パス 1、同 83・86 行）を回し、各パス内で `await tick()` → `readMeasurements()` → `coordinator.drainProbes()` → `flushSync()` を `maxProbeSteps = MAX_PREFIX_ROWS * 4 + 1 = 513` を上限に繰り返す（同 1823-1860、`MAX_PREFIX_ROWS = 128` は 90 行）。`readMeasurements()` は登録ノード全件の border-box 高さと 14 個の追加寸法を読み直す（同 1303-1399、件数は 1397 行の `measurementReadCount`）。上限は「必ず 513 回回る」意味ではないが、**分割候補の多い天気カード等では、metadata 更新のたびに同一の分割探索をやり直す**。

### 2.5 レイアウト入力の被覆表 — 現行キーが generatedAt に依存して隠している穴

ここが本修正の核心である。`generatedAt` / `seq` は state 配信のたびに変わるため、**現行の contentKey は「実際のレイアウト入力を列挙していなくても正しく動いてしまう」**。2 フィールドを削るだけの修正は、下表の「未被覆」行をそのまま静かな取りこぼしに変える。

`DisplayStateSnapshotV1`（`display/frontend/src/lib/protocol.ts:1112-1150`）の全 field を、StandbyScreen の実参照（`grep -on "snapshot\.[a-zA-Z]*"` 実測）と CSS の実測から分類した。

| snapshot field | 寸法に効くか | 現行 contentKey | 根拠 file:line |
|---|---|---|---|
| `version` | 効かない | — | プロトコル定数 |
| `generatedAt` | **効かない** | 含む（本件） | `state-store.ts:1237` は `nowMs` の ISO |
| `seq` | **効かない** | 含む（本件） | `protocol.ts:1115` は hub 採番 |
| `activeEews` | 効かない | 未被覆 | StandbyScreen が読まない（緊急画面の入力） |
| `tsunami` | **効く** | **未被覆** | `StandbyScreen.svelte:806`（候補有無）・`837`（`coasts.length` から行数）・`2109-2110`（banner 描画） |
| `largeQuakes` | 効かない | 未被覆 | StandbyScreen が読まない |
| `weatherAlerts` | **効く（全体）** | `updatedAt` のみ | `341`（`hasWeather`）・`352`（role 順ソート）。穴は §2.6 |
| `weatherChange` | 効かない | 未被覆 | StandbyScreen が読まない |
| `weatherPromotion` | 効かない | 未被覆 | 同上 |
| `weatherL5Active` | 効かない | 未被覆 | 同上（night-dim は App の `dim` prop 経由） |
| `weatherExpandedKinds` | **効く** | **未被覆** | `383`（展開候補の照合） |
| `recentQuakes` | **効く** | **未被覆** | `305`・`995`（`recentVisible`）・`1389-1390`（`belowItemCount` / `belowContentHeight`）・`2441`（計測 shelf） |
| `latestQuake` | **効く** | `updatedAtMs` のみ | `556`・`828`・`838-839`（`intensityGroups` から行数）・`873` |
| `stats` | **効く** | **未被覆** | `994`（`statsVisible`）・`1389-1390`・`2440`（計測 shelf）。詳細は §2.7 |
| `severityTier` | **効く（間接）** | **未被覆** | **§2.8。StandbyScreen は直接読まないが CSS 経由で効く** |
| `backgroundTone` | 効かない | 未被覆 | `lib/theme.css:241-248` は `--bg` の色のみ |
| `connection` | **効く** | **未被覆** | `343`（`connectionVisible`）・`2456`・`2470`（`connectionMeasureEl`） |
| `recentTicker` | 効かない | 未被覆 | StandbyScreen が読まない（TickerLane の入力） |
| `standbyItems` | **効く** | `standbyContentIdentity` で被覆 | `314`・`2058-2069` |
| `mapLayers` | 効かない | 未被覆 | StandbyScreen が読まない |
| `tickerSynced` | 効かない | 未被覆 | `store.ts:170,177` の ticker 制御のみ |
| `frontendBuildId` | 効かない | 未被覆 | reload 判定のみ |

props 側も同様に分類する。

| prop | 寸法に効くか | 現行 input | 根拠 |
|---|---|---|---|
| `sseConnected` | **効く** | 含む（2071 行） | `343` の `connectionVisible` の第 1 項 |
| `selectedId`（内部 state） | **効く** | 含む（2070 行） | `2112` の `QuakeReplayCard` 差し替え |
| `now` | 効かない | 含まない（維持） | Clock の日付・時刻は幅のみ可変。`1384` が使うのは `clockRect.bottom`（垂直座標）で、`Clock.svelte:13-14` の行構成は分をまたいでも不変 |
| `dim` | 効かない | 含まない（維持） | `StandbyScreen.svelte:2581-2592` は `opacity` のみ |
| `reducedMotion` | 効かない | 含まない（維持） | `layout-motion.svelte.ts:179` の motion 分岐のみ |
| viewport 高 | **効く** | 別トリガ（維持） | `2081-2089` の `onViewportResize` が独自に `requestSettle()` |
| font 確定 | **効く** | 別トリガ（維持） | `2091` の `document.fonts.ready` |

### 2.6 気象警報は `updatedAt` だけでは訂正報を取りこぼす

`DisplayWeatherAlertV1` は wire 上 `source` / `label` / `role` / `totalAreas` / `items` / `updatedAt` の 6 field のみで、**revision serial を持たない**（`protocol.ts:533-540`）。`updatedAt` は active subject 群の最新 ReportDateTime から導出される（`.claude/rules/message-pipeline.md` の VPWW56 節）。一方エンジン側は ReportDateTime 同値時の revision 比較用 serial を別に持っており（`protocol.ts:823` の記述）、**同一 ReportDateTime の訂正報が受理されうる**。その場合 `updatedAt` は同値のまま `items` が変わる。

現在この穴は `generatedAt` が塞いでいる。2 フィールドを削るだけの修正は、この穴を「気象警報の訂正報でレイアウトが更新されない」という実害へ変える。

### 2.7 stats は「表示条件」と「桁数」だけが寸法に効く

`InstrumentRow.svelte` が描くのは sparkline SVG と 2 つの数値である。sparkline は `viewBox` が `0 0 120 20` 固定（同 `5-7`・`23`）で CSS も `width: 120px; height: 20px`（同 `39`）なので、**`sparklineData` の中身は寸法に一切効かない**。数値は `totalReceived` と `todayQuakeCount` のみ（同 `26`・`28`）で、`.instrument-row` に `font-variant-numeric: tabular-nums` が掛かっている（同 `37`）ため、**幅は桁数だけで決まる**。`todayMaxInt` / `todayMaxIntRank` / 運用カウンタ群（`protocol.ts:382-394`）は描画されない。

`sparklineData` は 1 分ごとに、`totalReceived` は電文受信ごとに変化する。前者を鍵に含めると毎分の再計測を招く。

### 2.8 severityTier は StandbyScreen が読まないのに寸法に効く

`App.svelte:272` は `<main data-tier={severityTier}>` を立てる。`lib/theme.css:346-353` はこの属性に対し、色だけでなく **`--num-weight` を `--type-weight-bold`(700) から `--type-weight-heavy`(800) へ離散上書き**する（値は同 `120-121`・`130`）。

`--num-weight` は待機画面が計測する複数のカードで消費されている。`InstrumentRow.svelte:40`、`RecentQuakes.svelte:113`、`BriefingCard.svelte:600`、`TyphoonCard.svelte:295,395`、`VolcanoCard.svelte:562`、`QuakeReplayCard.svelte:123,172`、`FloodWideCard.svelte:222`、`NumberUnit.svelte:10`。font-weight の変化は字送りを変えるため、`severityTier` の遷移は**実測寸法を変えうる**。

`severityTier` は StandbyScreen の props にも `snapshot.*` 参照にも現れない。したがって**「StandbyScreen が読んでいる snapshot field を列挙する」という素直な設計では原理的に見つからない**。この一件が §3.1 の設計選択を決める。

### 2.9 追加不要と確認したもの

Issue の修正方針に挙がっているが、**現行実装で既に満たされている**ため本 spec では作らない。

- **連続 state の合流**: `requestSettle()` は `settling` 中なら `settleRequested = true` を立てて即 return し（`StandbyScreen.svelte:1998-2001`）、走行中の settle が終わった時点で 1 回だけ後続を起こす（同 `1977-1980`）。N 個の連続 state は最大 1 個の後続 epoch へ畳まれる。加えて `coordinator` の supersede 判定（同 `1887-1889`・`1909-1912`）が旧 epoch の結果を新 snapshot へ適用させない。
- **ページ切替の残り時間の維持**: §2.2 のとおり位相は壁時計 anchor（`time-slice-scheduler.svelte.ts:255-257,276-277`）で、hold/release をまたいでも位置は保たれる。

## 3. 変更

### 3.0 Phase 0 申告

**規範ドキュメントの事前読み込みは不要**と判断する。理由は、本修正が DOM を 1 要素も増減させず、CSS を 1 行も変えず、token を参照しないためである。変更対象は `$effect.pre` 内のキー合成ロジックと、それを支える純関数、およびテストに限る。したがって `docs/specs/display-design-system.md`・`theme.css`・header/footer 統一 spec・錨カードの読み込みと、使用トークン／倣う錨の申告は求めない。

ただし §2.8 の理由から、**実装者は `lib/theme.css` の `main[data-tier]` / `main[data-background-tone]` ブロック（241-248・346-353 行）を読み、寸法に効く宣言が `--num-weight` 以外に増えていないことを実装時点で再確認すること**。これは意匠の準拠ではなく事実確認である。

### 3.1 設計の選定 — 除外リスト方式（推奨 A）

三案を比較した。

**案 A（推奨）: 除外リスト方式のクライアント側安定キー。** snapshot の全 field をキーに入れることを既定とし、「レイアウトに効かないことを file:line で証明できた field」だけを明示的に除外する。除外リストは `DisplayStateSnapshotV1` のキー集合に対する網羅性を型で強制し、protocol に field が増えたら**分類するまでコンパイルを通さない**。

採用理由は §2.8 に尽きる。`severityTier` は StandbyScreen の参照にも props にも現れないのに寸法に効く。「効くものを列挙する」方式（案 B）はこの種の間接依存を構造的に見落とす。除外リスト方式では、分類を怠った field は自動的に「再計測する」側へ倒れる。**取りこぼしの失敗モードが「無駄な再計測」（性能劣化のみ）になり、「レイアウトが更新されない」（表示の誤り）にならない。**

**案 B: 包含リスト方式。** 「効く入力」を手で列挙する。生成されるキーは最小で最速だが、§2.8 の間接依存と protocol 追加に対して脆い。§6 の分岐 1 で扱う。

**案 C: サーバ側 layout revision。** `state-store.ts:1233` の `snapshot()` に、レイアウトに効く state が変わったときだけ進む番号を持たせる。不採用とする。理由は三つ。(1) サーバが知っているのは domain state であって frontend のレイアウトに効く subset ではない。`stats.sparklineData` は毎分変わるがレイアウトには効かず（§2.7）、`severityTier` は色の tier でありながら効く（§2.8）。この対応表はサーバ側に置くと frontend の CSS 変更のたびにサーバを直すことになり、protocol に frontend の内部事情が漏れる。(2) additive field なので旧サーバ欠落時の fallback が要り、その fallback は結局クライアント側キーになる。両方を実装・保守することになる。(3) 変更範囲が engine 全域（`markStateDirty()` の全契機）へ広がり、main / personal の境界を跨ぐ。Issue の完了条件は frontend 単独で満たせる。

### 3.2 新しいキーの構成

`$effect.pre`（`StandbyScreen.svelte:2057-2079`）を次の形へ置き換える。関数本体は同ファイル内の純関数として切り出し、テストから直接呼べるようにする。

```
layoutKey(snapshot) =
  「snapshot の全 own property を安定順で直列化した文字列。ただし LAYOUT_IRRELEVANT_KEYS を除く」

input = [layoutKey(snapshot), selectedId ?? "", sseConnected].join("|")
```

`LAYOUT_IRRELEVANT_KEYS` は §2.5 の表で「効かない」に分類した field とする。

```
version, generatedAt, seq, activeEews, largeQuakes,
weatherChange, weatherPromotion, weatherL5Active,
backgroundTone, recentTicker, mapLayers, tickerSynced, frontendBuildId
```

型による網羅性の強制は、除外集合と採用集合の合併が `keyof DisplayStateSnapshotV1` と過不足なく一致することをコンパイル時に検査する形で行う（`Exclude` / `satisfies` の組で表現でき、実行時コストはゼロ）。protocol に field が増えると、どちらの集合にも入っていない間は型エラーになる。

`standbyItems` は既存の `standbyContentIdentity`（`2058-2069`）をそのまま使う。briefing / typhoon / weatherWarningForecast の測定タプルはレイアウト入力として既に精査済みで、汎用直列化より安定かつ小さいため置き換えない。

`stats` は §2.7 の実測に基づき、`sparklineData` / `todayMaxInt` / `todayMaxIntRank` / 運用カウンタ群を除き、`stats == null` の別と `totalReceived` / `todayQuakeCount` の**桁数**だけを採る。桁数化の根拠は `InstrumentRow.svelte:37` の `tabular-nums` である。これは §6 の分岐 2 で採否を確認する。

`severityTier` を新規にキーへ加える（§2.8）。

### 3.3 contentDemotionRequested の扱い

現行は `contentKey !== lastContentKey` で立つ（`2074`）。新実装でも同じ位置に置き、**新しい `layoutKey` の変化でのみ立てる**。metadata だけでは立たなくなる。

`layoutKey` は「レイアウトに効く入力の変化」であって「表示内容が減った可能性」ではないため、`connection` バッジの出現のような下位 stage 検討が不要な変化でも立つ。ただし**これは現行挙動と同じ**（現行は metadata 変化でも立っていたので、むしろ発火頻度は減る一方である）。挙動の保存を優先し、demotion 判定の意味論の見直しは本 spec の範囲外とする。

viewport resize 経路が `contentDemotionRequested = false` を明示する既存の扱い（`2086-2088`）は変更しない。

### 3.4 実 Chrome 検証のための preview harness（最小追加）

`display/frontend/src/preview/PreviewApp.svelte:352-355` の snapshot は gate scenario から `$derived` される固定値で、繰り返しの state 注入経路を持たない。`display/scripts/capture-legacy-standby.mjs` も settle 後の 1 枚を撮る道具であり、**「metadata だけの state を継続入力し続けたときの応答性」を測る手段が現状ない**。

そこで preview 限定のクエリパラメータを 1 つ追加する。`?metadataChurnMs=<正整数>` が与えられたとき、その間隔で `generatedAt` と `seq` **だけ**を書き換えた snapshot を流し込む。既定（パラメータ非指定）では現行と完全に同一の挙動とし、production の `App.svelte` は一切変更しない。

このハーネスは §5.2 の before/after 採取に使う。実走は親（Liebe）が担う。

### 3.5 変更しないもの

parser、router、formatter、notifier、engine 側の state / hub / 永続化、display protocol、`store.ts` の reduce、solver、`settleMeasurements()` のパス上限・probe 予算、`readMeasurements()` の読み取り項目、`preEpochCapture()` の実装、scheduler の位相計算、DOM 構造、CSS、theme token、`App.svelte`。

§2.3 の「内容不変でない epoch でも `preEpochCapture` が重い」問題と、`settleMeasurements()` に処理時間上限や分割実行を入れる話は本 spec の範囲外とし、§6 の分岐 4 に後続候補として置く。

## 4. テスト

### 4.1 既存の再現テストを受入テストへ昇格する

`display/frontend/src/components/__tests__/standby-metadata-resettle.test.ts` は既に (b) generatedAt only / (c) seq only / (d) 対照の 3 ケース × 2 レーンを持ち、期待値も修正後の姿で書かれている。**新規テストを起こさず、このファイルを受入テストへ格上げする。**

手順は次のとおり。

1. 冒頭 docstring（1-13 行）の「修正はしない・現行挙動の数値固定が目的」を、本 spec を参照する受入テストの説明へ書き換える。
2. §4.2 のケースを追加する。
3. 期待値（`282-284`・`290-292`・`303-304`）は変更しない。現状の期待値がそのまま修正後の受入条件である。

起草時に実走した現行値（`7aabcf2`、`--maxWorkers=2 --disable-console-intercept`）。

| レーン | ケース | epoch | pass | probe | rotationHold | cardPageHold |
|---|---|---|---|---|---|---|
| A | (b) generatedAt only | +1 | +2 | 0 | +1 | +1 |
| A | (c) seq only | +1 | +2 | 0 | +1 | +1 |
| A | (d) 実内容変更（対照） | +1 | +2 | 0 | +1 | +1 |
| B | (b) generatedAt only | +1 | +33 | +114 | +1 | +1 |
| B | (c) seq only | +1 | +33 | +114 | +1 | +1 |
| B | (d) 実内容変更（対照） | +1 | +33 | +120 | +1 | +1 |

結果は 4 件失敗・2 件成功。(b)(c) が (d) とほぼ同じコストを払っていることが数値で確定している。

### 4.2 追加ケース — 「時刻／seq が同じでも内容変更を取りこぼさない」

Issue の修正方針が名指しで警告している取りこぼしを、**§2.5 の表で「効く／未被覆」に分類した全 field について**閉じる。各ケースは `generatedAt` と `seq` を初回と同値に固定したまま、当該入力だけを変える。期待は `epoch` が 1 以上進むこと（(d) と同じ形の assertion）。

| ケース | 変える入力 | 守る穴 |
|---|---|---|
| (e) | `severityTier` を `calm` → `alert` | §2.8。`--num-weight` 700→800 |
| (f) | `stats` を `null` → 値あり、および `totalReceived` を桁数が変わる値へ | §2.7 |
| (g) | `recentQuakes` を 0 件 → 1 件、および先頭 5 件の内容変更 | §2.5 |
| (h) | `connection.dmdata` を `connected` → `disconnected` | §2.5。`connectionVisible` |
| (i) | `tsunami` を `null` → 値あり | §2.5 |
| (j) | `weatherExpandedKinds` の `areas` を変更 | §2.5 |
| (k) | `weatherAlerts[].items` を変え、`updatedAt` は据え置く | §2.6。訂正報の穴 |
| (l) | `latestQuake.updatedAtMs` を変更 | 既存被覆の維持確認 |
| (m) | `standbyItems` の briefing `generation` を変更 | 既存被覆の維持確認 |

加えて**負のケース**を 1 本置く。(n) `sparklineData` だけを変えた state では `epoch` が進まないこと。§2.7 の carve-out が意図どおりであることを固定する（§6 の分岐 2 が B 裁定なら本ケースは削除する）。

### 4.3 レーン B の数値の読み方（テストに注記として残す）

レーン B の baseline は `settled: "false"` である（§4.1 の実走出力）。jsdom + `StubResizeObserver` では初回 settle が 48 tick 以内に収束しない。したがって**レーン B の絶対値は実ブラウザの値ではなく、同一条件下の差分比較としてのみ意味を持つ**。この注記をテストファイルに残し、将来「実機で 114 回 probe が走る」と誤読されないようにする。

### 4.4 維持する既存テスト

次を無変更で緑に保つ。

- `display/frontend/src/components/__tests__/standby.test.ts`（2158 行。文字切れ・重なり・期限・ページ分割の主戦場）
- `emergency.test.ts` / `app-transition.test.ts`（緊急遷移）
- `capture-contract.test.ts` / `capture-design-alignment.test.ts` / `capture-center-stack-pregate.test.ts`
- `page-dots.test.ts` / `motion-wiring.test.ts` / `late-mount-regression.test.ts`
- `instrument-row.test.ts` / `recent-quakes.test.ts` / `connection-badge.test.ts`
- `briefing-card.test.ts` / `typhoon-card.test.ts` / `volcano-card.test.ts` / `weather-alert-card.test.ts` / `weather-warning-forecast-card.test.ts` / `flood-card.test.ts` / `flood-wide-card.test.ts`
- `display/frontend/src/preview/__tests__/legacy-improved-mock.test.ts`

## 5. 受入条件

### 5.1 機械的に確認できるもの

```bash
# 1. 受入テスト（§4.1 + §4.2）が全件緑
/Users/sayue/dev/FlEq/display/node_modules/.bin/vitest run --root /Users/sayue/dev/FlEq/display \
  frontend/src/components/__tests__/standby-metadata-resettle.test.ts \
  --maxWorkers=2 --disable-console-intercept

# 2. display 全体のテストが緑
npm --prefix display test -- --maxWorkers=2

# 3. frontend の型検査
npm --prefix display run typecheck

# 4. ビルド
npm --prefix display run build && npm run build && npm test
```

- (b) generatedAt only と (c) seq only の delta が両レーンで `{epoch:0, pass:0, enqueueProbe:0, rotationHold:0, cardPageHold:0}` になること。
- (d) 対照が両レーンで `epoch > 0` かつ `pass > 0` を保つこと。
- §4.2 の (e)〜(m) が全件 `epoch > 0`、(n) が `epoch === 0` になること。
- §4.4 の既存テストが 1 件も赤にならないこと。
- protocol に field を 1 つ足したとき、分類前は型エラーになること（実装者が一時的な追加で確認し、確認後に戻す）。

### 5.2 実 Chrome での応答維持（実走は親が担う）

`display/scripts/capture-legacy-standby.mjs` の headless 経路と §3.4 の `metadataChurnMs` を組み合わせ、**修正前後で同一条件の 2 回採取**を行う。`--window-size` だけでは viewport 高が枠分減るため、`Emulation.setDeviceMetricsOverride` を attach 直後に掛け、report に `innerWidth` / `innerHeight` を含める（既存の `deviceMetricsOverrideFor()` が `capture-browser-session.mjs:39-43` にある）。

採取する量は Issue コメントの指定に合わせる。

1. **画面と環境の記録**: 待機画面であること、表示中のカード構成、viewport / zoom / DPR、Chrome バージョン、稼働 SHA。緊急画面で起きた停止を本件へ帰属させない。
2. **2 条件の比較**: state 入力なしの確定状態と、`metadataChurnMs=500` で `generatedAt` / `seq` だけを更新し続ける状態。Performance 記録から `settleMeasurements` の所要時間、DOM 計測、layout、GC、epoch 数、pending probe 数、scheduler 保留時間を採る。回数上限があることと短時間で終わることは別なので、**所要時間を必ず測る**。
3. **ローカル fixture での再現**: サーバ応答待ちや同一端末の CPU 競合と区別する。元 snapshot・元電文を残す場合は機密情報を除去してから。
4. **長時間の応答維持**: `metadataChurnMs=500` を 10 分以上継続し、Chrome の応答ダイアログが出ないこと、ページ切替が止まらないことを確認する。

修正後に (2) の 2 条件の差が消えることが目標である。**なお、実機の Chrome 応答停止が本経路単独の結果であることは現時点で未確認であり、本修正で応答停止が解消しなかった場合も本 spec の受入は独立に成立する**（§5.1 と本節 (2) の差分消失で判定する）。解消しなければ #13 の Node 側と別経路を改めて切り分ける。

### 5.3 配送 gate

main へ push 後、GitHub Actions（Test workflow）の緑を配送条件に含める。`gh run list --limit 1` で run id を取り、`gh run watch <id> --exit-status` で確認する。赤なら同一サイクル内で対処し、次サイクルへ持ち越さない。

## 6. 判断分岐

### 分岐 1: キーの構成方式（推奨 A）

- **A（推奨）: 除外リスト方式**（§3.1）。分類漏れが「無駄な再計測」へ倒れ、「レイアウトが更新されない」へ倒れない。§2.8 の `severityTier` のような間接依存を構造的に拾える。代償はキー文字列が長くなること（`standbyItems` 52KB 相当の直列化が 500ms ごとに走る）。ただしこれは §2.3 の DOM 全 clone より一桁以上安く、かつ `standbyContentIdentity` として**現行が既に払っているコスト**である。
- **B: 包含リスト方式**。キーは最小。ただし §2.8 は手作業の列挙では見つからなかった事実であり、同種の間接依存が今後 CSS 側の変更で増えたとき、無症状のまま表示が古いまま止まる。採るなら「theme.css の `main[data-tier]` / `main[data-background-tone]` ブロックに寸法宣言を足したらキーを見直す」というコメントを両ファイルへ相互に残すことを必須条件とする。

### 分岐 2: stats の桁数化（推奨 A）

- **A（推奨）: 桁数化する**。`totalReceived` / `todayQuakeCount` を桁数へ写し、`sparklineData` を除外する。根拠は `InstrumentRow.svelte:37` の `tabular-nums` と `39` の固定 sparkline 寸法で、file:line で証明できる。効果は「電文受信のたびの再計測」と「毎分の再計測」の除去。
- **B: 値そのものを入れる**（`sparklineData` のみ除外）。より保守的。`totalReceived` は電文受信ごとに変わるので再計測が電文着信に連動する。実害は小さいが、Issue の「内容不変なら計測キャッシュを維持」の趣旨からは一歩後退する。

分岐 2 を B にする場合、§4.2 の (n) 負のケースは `sparklineData` のみを対象に残す。

### 分岐 3: `latestQuake` を `updatedAtMs` のまま据え置くか（推奨 A）

- **A（推奨）: 据え置く**。`updatedAtMs` は engine が採番する内容 revision であり、`intensityGroups` の変化は必ず revision を伴う。現行の被覆をそのまま維持し、変更を最小に保つ。
- **B: `latestQuake` 全体を直列化する**。除外リスト方式の一貫性は上がるが、`updatedAtMs` の revision 契約が壊れているなら本 spec とは別の bug であり、ここで隠すべきではない。

### 分岐 4: 残る再計測負荷への対処を本 spec に含めるか（推奨 A）

- **A（推奨）: 含めない**。§2.3 の `preEpochCapture` の全 clone、`settleMeasurements()` の処理時間上限・分割実行は、**本当に内容が変わった epoch のコスト**であり、起動条件の修正とは別の設計判断を要する。古い epoch の結果を新しい snapshot へ適用しないこと（現行の supersede 判定、§2.9）と、警報表示の迅速性を守る必要があるため、実機計測を踏まえた別 spec とする。#15 の完了条件は本 spec の範囲で満たせる。
- **B: `preEpochCapture` の skip 条件だけ本 spec に含める**。`skipMotion` 相当の条件で clone を省く。範囲は小さいが、モーションの前状態採取という別責務に手を入れることになり、既存の motion テストへ波及する。

### 分岐 5: preview harness の追加可否（推奨 A）

- **A（推奨）: `?metadataChurnMs=` を preview に追加する**（§3.4）。実 Chrome での before/after 比較の唯一の手段。preview 限定・既定無効・production 非変更。
- **B: 追加せず、Pi 実機の実 state 配信で観測する**。ハーネスの追加はゼロだが、比較条件を固定できず、before/after が測れない。


## 裁定ラベル案

- **対象**: `display/frontend/src/components/StandbyScreen.svelte` の `$effect.pre`（2057-2079）とそこから呼ぶ純関数、`display/frontend/src/components/__tests__/standby-metadata-resettle.test.ts`、`display/frontend/src/preview/PreviewApp.svelte` の preview 限定 churn パラメータ。
- **許容変更**: 再計測トリガのキー合成ロジックの置き換え、`LAYOUT_IRRELEVANT_KEYS` とその型レベル網羅検査の新設、`severityTier` のキーへの追加、`stats` の桁数化ヘルパ、再現テストの受入テスト化と §4.2 のケース追加、preview 限定 `metadataChurnMs` の追加（既定無効）。
- **禁止変更**: engine 側の全ファイル（`state-store.ts` / `hub.ts` を含む）、display protocol、`store.ts` の reduce、`App.svelte`、solver、`settleMeasurements()` のパス上限と probe 予算、`readMeasurements()` の読み取り項目、`preEpochCapture()` の実装、scheduler の位相計算、DOM 構造、CSS、theme token、`package.json` / `package-lock.json`、永続化・通知・parser・router・formatter。
- **配送先**: main → personal → Pi。main で §5.1 を満たし GitHub Actions 緑（§5.3）を確認してから personal へ rebase 追従、その後 Pi へ反映する。§5.2 の実機採取は Pi 反映後に親が実走する。
- **ロールバック**: 本弾の単一実装 commit を revert し、main → personal → Pi の順に再配送する。wire も永続化も変更しないため data migration は不要。
- **受入条件**: §5.1 の 4 コマンドが全て成功し、(b)(c) の delta が両レーンで全項目 0、(d) が両レーンで `epoch > 0` かつ `pass > 0`、§4.2 の (e)〜(m) が全件 `epoch > 0`、(n) が `epoch === 0`、§4.4 の既存テストが全件緑、protocol への field 追加が分類前に型エラーになること、未申告の範囲拡大がないこと。§5.2 は Pi 反映後の観測項目として別途報告し、**本 spec の配送可否判定には §5.1 と §5.3 のみを使う**。
