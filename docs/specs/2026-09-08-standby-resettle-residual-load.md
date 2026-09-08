# 待機画面 再計測残り負荷 spec（GitHub Issue #15 第 2 便）

> **状態**: 起草＋独立レビュー反映（2026-09-08）。裁定前。§6 の分岐 6 件はご主人裁定待ちで、うち分岐 5 は (c) 製品緩和に該当する。
>
> **基準 SHA**: `f8e2c688fb25b555b0a3e579c4c70210d2cda7dd`（worktree `~/dev/fleq-layout`、branch main）。第 1 便 `65d6f9b`（#15）・`0198ddc`（#18）・`f8e2c68`（#13）が入った状態。
>
> **前提**: 本 spec は **ブラウザ側（待機画面）だけ**を扱う。Node 側の周期停止は #13 で解決済み（Pi `/healthz` 停止 1.2 秒 → max 19ms）。`vpwp50ProjectionRejected` の診断分離は #16 の担当で、本 spec の受入条件には含めない。
>
> **見立ての訂正（重要）**: 引き継ぎメモは残り負荷を「`preEpochCapture` の全 clone・settle 時間上限」と名指ししていた。**コードを読んだ結果、churn 計測で観測された 6.5 秒/60 秒に `preEpochCapture` は 1 回も入っていない。** 理由は §2.1 に書く。`preEpochCapture` と settle 時間上限は「実内容が変わったときの 1 epoch あたりのコスト」という**別の症状**であり、本 spec ではそれを §2.4 以降で別立てにする。
>
> **分岐 7-A レビュー反映（2026-09-08、独立レビュー GO with fixes）**: §7 に「分岐 7-A 追加ラベル」を新設し段階 0 ラベルとの自己矛盾を解消（F6）。`fontsReady` ゲートにより**実機の初回 commit epoch は epoch 1 ではなく非 0 になる**ことを §3.0 と B6 に明記（F1）。A14 と §4.7 を追加（F7）。属性が瞬間値であること（F2）と `churnRootAttrMutations` への影響（F3）を §3.0 に追記。行番号を訂正（F8）。**F5 の「render 直後は属性が生えない」は実測で覆った**（`$effect.pre` が mount 前に epoch 1 を開くので render 直後から `"0"` が出る）ため、`"0"` が出ることの固定として §4.7 に読み替えた。
>
> **分岐 7 裁定反映（2026-09-08）**: ご主人裁定 **A**。`StandbyScreen.svelte` に `data-layout-motion-captured` を `partitionDebug || gateFixture != null` ガード付きで追加した（production DOM は不変）。§3.0 の「段階 0 では採れない」節を観測点の仕様と親の CDP 読み出し手順へ差し替え、B0 に clone 枚数を戻し、**B6 の保留を解除**した。
>
> **実装反映（2026-09-08、段階 0 実装後の独立レビュー GO with fixes）**: §3.0 に「preview 限定の観測点」節を新設し、`?churnProbe=1`・`window.__fleqChurnProbe`・`data-churn-*` 8 属性の名前と意味・既定 off・probe は計測を歪めるので別 run、を明記した。帰属の権威は Performance トレース Bottom-Up のままで、カウンタは突き合わせ材料と位置づける。**`preEpochCapture` の clone 枚数は段階 0 では採れない**ことを §3.0 に明記し、測定手段の可否を**分岐 7**（新設）に切り出して B0 から外し B6 を保留にした。§7 段階 0 の「対象」に本 spec 自身を足し（配送 diff は 4 ファイル）、「許容変更」に観測点を足した。
>
> **レビュー反映（2026-09-08、独立レビュー GO with fixes）**: §2.2 の伝播説明を Svelte 5 の pull 規則へ (a) 訂正（F8）。`requestSettle` の呼び出し点を 5 → 6 か所へ (a) 訂正（F1）。§3.1 の実現可能性の制約を追記（F2）。§5.2 の B4 / B5 を測れる形へ (b) 改訂（F4 / F5）。**構成そのものを「段階 0 を第 1 便にして価値判断してから先へ進む」へ変更**（分岐 6 の推奨を A → C）。分岐 1 は推奨を取り下げ保留とし、第 3 の候補（シェルフの settle 後 unmount）を追加（F13）。

## 1. 症状

### 1.1 第 1 便の after に残った負荷（実 Chrome、2026-09-07 20:40）

Chrome 152 headless、1920×1080（`Emulation.setDeviceMetricsOverride`）、preview `#legacy-standby-gate` `gateScenario=max`（59 カード）、`?metadataChurnMs=500`、採取 60 秒。計測資材は scratchpad `churn-measure.mjs`。

| | churn | epochΔ | 計測 passΔ | long task 数 | long task 合計 | >100ms | fps |
|---|---|---|---|---|---|---|---|
| before（第 1 便 前） | 500ms | 23 | 2,461 | 23 | 61,952ms | 23 | 0.4 |
| **after（第 1 便 後）** | **500ms** | **0** | **0** | **119** | **6,530ms** | **0** | **57.9** |
| after | なし | 0 | 0 | 0 | 0 | 0 | 60 |

**after の 119 件・合計 6,530ms が本 spec の対象**である。60 秒 ÷ 500ms = 120 回の state 配信に対して long task が 119 件なので、**state 配信 1 回あたり約 55ms の main thread 占有**が残っている。すべて 100ms 未満なので Chrome の「応答なし」ダイアログは出ず、fps も 57.9 で維持されている。

### 1.2 この 55ms が本番でどれだけ効くか（過大評価しないための注記）

- Pi 実機の実測では 22.5 時間で seq 755、**state は平均 107 秒に 1 回**（session-log 2026-09-07 §Pi 実機の観測）。churn 500ms は本番の 200 倍以上の頻度をわざと作った合成条件である
- サーバ側 state の最短間隔は 500ms（debounce）で、電文受理直後とテロップ期限切れの前後だけ数秒刻みで連続する
- したがって **§1.1 の 6.5 秒/60 秒をそのまま「本番で 11% の CPU を食っている」と読んではいけない**。本番の平常時は 107 秒に 55ms = 0.05% 程度である

同時に、**本番の 1 回は churn の 1 回より重い**。churn ハーネスは `scenarioSnapshot` を spread して `generatedAt` / `seq` だけを差し替えるので、`standbyItems` などの入れ子オブジェクトは前回と同一参照のまま流れる（`display/frontend/src/preview/PreviewApp.svelte:417-426`）。本番の state は SSE のペイロードを毎回 `JSON.parse` するので（`display/frontend/src/lib/connection.svelte.ts:84`）、**入れ子まで含めた全オブジェクトが毎回新しい**。参照比較で伝播が止まる箇所が本番には無いので、§1.1 の 55ms は本番に対する**下限**である。§3.0 の reparse モードが本番形状の実値を出す。

### 1.3 まだ測っていない症状（本 spec の第 2 の対象）

実内容が変わったとき、つまり実電文が届いて epoch が開くときのコストは、#15 の計測では **before 側にしか現れていない**。before の 23 epoch で 61,952ms なので **1 epoch あたり約 2.7 秒**だが、この採取は main の build/test と同時刻に走っており CPU 競合を含む（session-log 2026-09-07 §#15 実 Chrome before/after の注記）。Apple M5 の headless でこの値なので、Raspberry Pi 500 ではさらに重い。

**平常時の 55ms より、電文 1 通ごとの数百 ms〜数秒のほうがご主人の体感に効く可能性が高い。** 平常時の負荷は 107 秒に 1 回しか来ないが、1 epoch のコストは**電文が届くたびに必ず出る**。ただし現時点で after 側の 1 epoch コストは未計測であり、これは推測である。§3.0（段階 0）でまず測る。**この 2 つの数字が揃うまで、段階 1 以降のどれをやるべきかは決まらない。** それが本 spec を「段階 0 を第 1 便にする」構成にした理由である（分岐 6）。

## 2. 根因（file:line、コード読了後）

### 2.1 `preEpochCapture` は churn の残り負荷に含まれない

`LayoutMotionCoordinator.preEpochCapture()`（`display/frontend/src/lib/legacy-standby/layout-motion.svelte.ts:137-157`）の**唯一の呼び出し点は `requestSettle()` の中**である（`display/frontend/src/components/StandbyScreen.svelte:1990`）。`requestSettle()` を呼ぶのは次の 6 か所である。

| 呼び出し元 | file:line | churn 中に発火するか |
|---|---|---|
| 入力 effect（contentKey 変化時のみ） | `StandbyScreen.svelte:2076-2082` | しない（キーが不変だから第 1 便が効いた） |
| `scheduleBriefingProbeSettle()` の microtask | 同 `:276-287`（呼び出し元は `:754`） | しない（`measurementSettled` が立っている状態で briefing / weather の probe 契約が動いたときだけ。churn 中は probe が動かない） |
| viewport resize | 同 `:2085-2093` | しない |
| `document.fonts.ready` | 同 `:2095` | しない（初回のみ） |
| mount 時の epoch 0 | 同 `:2098` | しない（初回のみ） |
| `testBeforeTerminalCommit` | 同 `:1940` | しない（テスト専用フック） |

epochΔ = 0 は「`requestSettle()` が 60 秒間 1 度も呼ばれなかった」ことの直接証拠なので、**`preEpochCapture` も settle ループも 1 度も走っていない**。6,530ms はすべて別の経路である。

### 2.2 残り負荷の実体（推定、§3.0 で確定させる）

Svelte 5 の `$derived` は pull 型で、上流が参照等価なら下流は再計算されない。したがって「snapshot の識別子が変われば 50 個の derived が全部再評価される」わけではない。**churn ハーネス下で実際に再点火する経路は 3 本に絞れる。**

| # | 経路 | file:line | 再点火する理由 |
|---|---|---|---|
| (i) | `displayWeatherAlerts` → `weatherItemKindKeys` → `weatherDisplayGroups` | `StandbyScreen.svelte:352-354` → `:355-360` → `:365` | `[...snapshot.weatherAlerts].sort(...)` が**無条件に新配列を返す**ので、中身が同じでも下流が全部無効化される |
| (ii) | `plan`（レイアウトソルバ本体） | 同 `:1136`、`stage` は `:1138` | 可視ルートの `data-solver-stage={stage}`（同 `:2243`）が常時レンダなので `plan` は必ず pull される。`plan` は `solvePlan()` → `candidates()`（同 `:817`）→ `candidatePresent()`（同 `:806-816`）と `candidateScore()`（同 `:837-841`）を経由し、これらが `snapshot.tsunami` / `snapshot.latestQuake` を**直読みする**（同 `:807,829,838-840,874`）。つまり `plan` は snapshot に直接依存しており、churn のたびにソルバが再実行される |
| (iii) | `selection` と 2 面のシェルフ DOM 再評価 | 同 `:1137`、シェルフは `:2368-2405` / `:2407-2446` | シェルフの `renderCard` 呼び出しは既定引数 `selected = selection`（同 `:2112`）を使うので `selection` が pull される。`selection` は `promoteAndExpand(plan, ...)` なので (ii) と連動して毎回新オブジェクトになり、シェルフ配下のカード props が更新される |

対照的に、`standbyItems`（同 `:315`）は churn ハーネスでは `snapshot.standbyItems` が同一参照で流れるため（`PreviewApp.svelte:417-426`）**参照等価で止まり**、`unknownInputs` / `knownItems`（同 `:316-317`）とその下流 9 個の `itemOf` derived（同 `:320-327,341`）は再計算されない。**本番（`JSON.parse` で毎回新オブジェクト、`connection.svelte.ts:84`）ではこの打ち切りが無くなるので、この経路も追加で点火する。** §1.2 で 55ms を下限と呼んだのはこの差である。

**DOM の量**（(iii) のコストを決める要因）は、2 面のシェルフに次が同時に載る。

- `CARD_ORDER` 9 種（同 `:90`）× `compact` / `expanded` / `full` の 3 変種 × 2 面 = 最大 54 枚の計測カード（同 `:2370-2374`, `:2409-2413`）
- partition preflight のカード群（weather / briefing / flood / volcano、同 `:2376-2404`, `:2415-2443`）
- prefix probe の可変個数（同 `:2402-2404`, `:2441-2443`。`prefixMeasureEntries` 由来で、`MAX_PREFIX_ROWS = 128`（同 `:91`）が上限を決める）
- stats / recentQuakes の計測 wrapper（同 `:2444-2445`）

生きているカードは 8 枚程度（同 `:2469,2477,2486,2493`）なので、DOM 量はシェルフ側が支配的である。シェルフは `visibility: hidden` で z-index -1（同 `:2524`）だが **`display: none` ではないのでレイアウト計算からは外れていない**（外すと計測できなくなる）。

**この節の (i)(ii)(iii) の比率は未実測である。** どれが 55ms の大半かで段階 1 の設計が変わるので、§3.0 で帰属させてから決める。

### 2.3 第 1 便のキー計算自体のコスト（小さいが毎回かかる）

入力 effect（`StandbyScreen.svelte:2058-2083`）は state ごとに次を計算する。

- `standbyContentIdentity`（同 `:2059-2070`）: `standbyItems` を map し、`typhoon` は `typhoonMeasurementTuple()`（同 `:2017-2057`）で、`weatherWarningForecast` は pager atom で `JSON.stringify` する
- `standbyLayoutKey()`（`display/frontend/src/lib/legacy-standby/layout-key.ts:212-221`）: `weatherAlerts` / `recentQuakes` / `weatherExpandedKinds` / `tsunami`（`observations` 除く）を丸ごと `JSON.stringify` する（同 `:112-114,168-172,191-196`）

Pi の SSE snapshot は 95KB（うち `standbyItems` 52KB）なので、直列化の対象は数十 KB。単体では数 ms 程度と見込むが、これも §3.0 で実測する。**この計算をやめることはできない**（キーが再計測の可否を決めている）。

### 2.4 `preEpochCapture` の全 clone（実 epoch のコスト、別症状）

`preEpochCapture()` は登録済みカードのうち可視のものすべてについて `cloneNode(true)` で DOM サブツリーを丸ごと複製する（`layout-motion.svelte.ts:143-153`）。1 枚あたり `cloneNode(true)` ＋ `stripDuplicateIds()` の `querySelectorAll("[id]")` 全走査（同 `:68-71`）＋ `getBoundingClientRect()`（同 `:149`）＋ `textContent` のサブツリー全走査（同 `:150`）が走る。

この clone（`shell`）を実際に使うのは、**内容が変わったカードとサイズが変わったカード、および消えたカードだけ**である（同 `:211-224` の `contentChanged || resized`、および `:226-235` の `unusedCapture`）。位置だけが動いたカードは `motionFrames` で本体を動かすので shell を使わない（同 `:216-220`）。実運用の epoch では変わるカードが 1〜2 枚なので、**大半の clone は作られて捨てられる**。

無駄が構造的に確定している経路が 2 つある。

- `reducedMotion()` が true のとき: `runForEpoch` は入口で `capture.clear()` するだけで clone を 1 つも使わない（同 `:179-183`）。`preEpochCapture` は `reducedMotion()` を見ていない
- 初回 commit のとき: `runForEpoch(..., { skipMotion: firstCommit })`（`StandbyScreen.svelte:1929,1972`）で同じ経路に入る

**ただし前者の実効性には注意が要る。** StandbyScreen は `reducedMotion` を prop で受け取っているが（同 `:34,38`）、`createLayoutMotionCoordinator` の options には渡していない（同 `:267-270`）。coordinator は既定の media query 実装（`layout-motion.svelte.ts:120-122`）を使う。Pi の Chrome は `prefers-reduced-motion: reduce` ではないので、**この経路は Pi では発火しない**。段階 3-1 は性能改善ではなく「無駄が構造的に確定している場所を塞ぐ正しさの保全」として位置づける。prop が未配線であること自体は別バグ候補として §3 の「やらないこと」に記す。

### 2.5 settle ループは回数で有界だが時間では有界でない

`settleMeasurements()`（`StandbyScreen.svelte:1810-1982`）の外側ループは `MAX_SETTLE_PASSES = 4`（同 `:84`）＋ post-commit 1（同 `:87`）で有界だが、内側の probe ループは `maxProbeSteps = MAX_PREFIX_ROWS * 4 + 1 = 513`（同 `:1828`）まで回る。1 step ごとに `await tick()`（同 `:1830`、圧縮境界をまたぐときは同 `:1845` にもう 1 回）→ `readMeasurements()` → `flushSync()`（同 `:1858`）が走る（同 `:1829-1861`）。

`readMeasurements()`（同 `:1304-1409`）は登録された全計測ノードと prefix ノードを走査し、`getBoundingClientRect()` / `clientHeight` / `scrollHeight` / `getComputedStyle()` を読む。読むたびに直前の `flushSync()` の書き込みが強制レイアウトを引き起こす、典型的な read-after-write の反復である。#15 の再現テストでは **1 epoch = `readMeasurements` 33 回 ＋ probe drain 114 回**（子 repro-15 の計測）。

`await tick()` は microtask なので、**この 33 回 × 114 回はすべて 1 つの task の中で連続実行される**。だから 1 epoch が丸ごと 1 個の long task になる。回数の上限はあっても、**壁時計の上限は無い**。

### 2.6 settle 中に可視 CSS が動く（段階 2 の制約）

`measurementGeometryStage` は可視ルート `.standby` の class を切り替える（`StandbyScreen.svelte:2241` の `class:ladder-compressed={measurementGeometryStage >= 2}`）。この class は `--space-1` 〜 `--space-5` と `--edge` / `--gap` を圧縮値へ差し替える（同 `:2515-2523`）。settle の途中で `measurementGeometryStage` は書き換わる（同 `:1843,1901,1957`）ので、**settle を複数フレームに分割すると、確定前の圧縮／非圧縮が実際に画面へ出る**。現状は 1 task で走り切るので中間状態が描画されない。これは偶然ではなく、分割案の前提条件になる。

生きているカードの中身自体は `renderPlan` = `committedPlan ?? initialRenderPlan`（同 `:1155-1157`）を通るので、settle 中も**カードの配置と選択は動かない**。動くのは間隔トークンだけである。

## 3. 変更案（段階分け）

**段階 0 が第 1 便である。** 段階 1 以降は段階 0 の数字を見てから、やるかどうかを含めて裁定する（分岐 6）。

### 段階 0: 帰属と価値判断の材料を採る（製品コードは変更しない）

§2.2 は推定であり、§1.3 の 1 epoch コストは未計測である。**段階 1 以降の価値はこの 2 つで決まる**ので、先に測る。

**採る数字 3 種**（測定文脈は §5.2 の固定値に従う）。

1. **本番形状の churn 負荷（主指標）**。`?metadataChurnMs` に「毎回 snapshot を `JSON.parse(JSON.stringify(...))` して流す」モードを足す（例 `?metadataChurnMode=reparse`、既定は現行と完全に同一）。§1.2 のとおり現行ハーネスは入れ子参照を共有していて本番より軽いので、**reparse モードの数字を本番相当の主指標**とし、現行の参照共有モードは第 1 便との before / after 比較用の副指標に落とす
2. **55ms の内訳（帰属）**。実 Chrome の Performance トレースを Bottom-Up で見て、§2.2 の 3 経路へ帰属させる: (i) `displayWeatherAlerts` 系の weather kind 解決、(ii) `plan` / `solvePlan` のソルバ再実行、(iii) `selection` 由来のシェルフ DOM 再評価。§2.3 のキー計算（`standbyLayoutKey` / `typhoonMeasurementTuple`）も併せて切り出す。**帰属の権威はこのトレースであり、下の観測点カウンタは突き合わせ材料である**
3. **1 epoch のコスト（after 側、未測定）**。preview 限定で `?contentChurnMs=<ms>`（既定無効）を足し、実内容が変わる state を周期的に流す。1 epoch あたりの long task の**個数と各片の長さ**、`data-measurement-pass` の増分を採る。§1.3 の「before で 2.7 秒」が after でどこまで残っているかを確定させる。**`preEpochCapture` の clone 枚数は段階 0 では採れない**（下記）

#### preview 限定の観測点（段階 0 で置くもの）

`?churnProbe=1`（**既定 off**）を立てたときだけ、`PreviewApp` が `.screen-area` 配下に `MutationObserver` を張り、churn 1 回ぶんの DOM 再評価を 3 つへ切り分ける。観測対象は `.screen-area` 配下だけで、カウンタを載せる `<main>` は観測範囲の外なので自己再発火しない。

| カウンタ | 意味 |
|---|---|
| `shelfMutations` | `.measure-shelf` / `.center-measure-shelf` 配下の DOM 変異数。§2.2 の経路 (iii) を直接押さえる |
| `rootAttrMutations` | `.standby` 自身の診断属性の書き換え数 |
| `liveMutations` | 生きているカード側の DOM 変異数 |

読み出しは 2 経路で、値は同じである。

- `window.__fleqChurnProbe()` — `{ mode, metadataChurnMs, metadataChurnTick, contentChurnMs, contentChurnTick, probe, shelfMutations, rootAttrMutations, liveMutations }`。churn パラメータが 1 つでも有効なときだけ生える
- `<main class="preview-screen">` の `data-churn-mode` / `-metadata-ms` / `-metadata-tick` / `-content-ms` / `-content-tick` / `-shelf-mutations` / `-root-attr-mutations` / `-live-mutations` の 8 属性。churn 無指定なら 1 つも出ない

**観測自体が main thread を食うので、`churnProbe` は主指標の run では立てない。** 帰属 run を別に走らせ、主指標（reparse churn の long task 合計）は probe 無しの数字を使う。

#### `preEpochCapture` の clone 枚数の観測点（分岐 7-A、裁定 A で実装済み）

`LayoutMotionCoordinator.diagnostics()` は `captured`（clone 枚数）を返すが（`layout-motion.svelte.ts:249`）、coordinator のインスタンスは `StandbyScreen.svelte` の内部に閉じていて DOM 属性としても公開されていなかった。**分岐 7 がご主人裁定 A（2026-09-08）で確定したので、`StandbyScreen.svelte` に観測点 1 行を置いた。**

- **属性名**: `.standby` の `data-layout-motion-captured`（`StandbyScreen.svelte:2257`）
- **ガード**: `partitionDebug || gateFixture != null`。`:2174` の briefing partition debug と同じ preview/gate 限定の前例に倣う。production の `App.svelte:284-294` はどちらの prop も渡さないので、**属性は生えず、値の書き込みも起きない**（`:1996` の書き込み側にも同じガードを置いた）
- **値の意味**: 現在の計測 epoch の頭で `preEpochCapture` が clone した可視カードの枚数。`diagnostics().captured` は `runForEpoch` が `capture` を捨てた時点で 0 に戻る一過性の値なので、`requestSettle` の中で `preEpochCapture` の**直後**にスナップショットして `$state` に控える（`StandbyScreen.svelte:271,1996`）。次の epoch が開くまで値は据え置かれる
- **基準は「フォント確定後の最初の settle epoch」であって epoch 1 ではない**（F1）。`settleMeasurements` は `fontsReady` が false の間は `:1816` で早期 return する。`fontsReady` の初期値は `document.fonts == null`（`:266`）なので、**実ブラウザでは false** で始まる。epoch 1 は mount 前の `$effect.pre`（`:2064`、`requestSettle()` 行は `:2087`）が開くが、登録カードがまだ無いので枚数 0 を書いたまま settle せずに終わる。実際に commit するのは `document.fonts.ready` 後の `requestSettle()`（`:2101`）が開く epoch で、**その時点ではカードが登録済みなので枚数は非 0** になる。jsdom は `document.fonts` を持たないため `fontsReady` が最初から true で、epoch 1 がそのまま settle して 0 を出す。**この 0 は jsdom 固有の姿であり、実機の期待値ではない**

**親が CDP で読む方法**: 測定文脈は §5.2 の固定値（Chrome 152 headless / 1920×1080 / preview `#legacy-standby-gate` `gateScenario=max`）。preview は `PreviewApp.svelte:900` で `partitionDebug={true}` を常に渡すので、gate run ではガードが立つ。読むタイミングは **`data-measurement-settled="true"` になった直後**で、`document.querySelector('.standby').dataset.layoutMotionCaptured` を `data-measurement-epoch` と対にして採る。epoch ごとに 1 点ずつ、`?contentChurnMs` の周期に合わせてポーリングする。**属性が無い場合はガードが立っていないか、まだ 1 epoch も開いていない**のどちらかで、「clone 0 枚」とは区別すること（0 枚なら `"0"` が出る。Svelte の `set_attribute` は値が `== null` のときだけ `removeAttribute` するので、数値 0 は属性として残る）。

**この属性は累計ではなく瞬間値である**（F2）。settle 中に `requestSettle` が重なると `preEpochCapture` はそのたび clone を取り直すが、属性に残るのは**最後の 1 回ぶんだけ**で、途中の epoch の枚数は上書きされて失われる。実機で 1 epoch あたりの総 clone 数を積みたくなっても、**累計カウンタは足さない**（観測自体が段階 3 の測りたい負荷を太らせる）。必要なら settled=true の各点をポーリングして親側で積む。

**`?churnProbe=1` との相互作用**（F3）: この属性は `.standby` 自身の属性なので、値が変わるたび `churnRootAttrMutations`（`PreviewApp.svelte:229`、`data-churn-root-attr-mutations`）に epoch あたり 1 件乗る。分岐 7-A 追加**前**に採った `rootAttrMutations` の値とは直接比較できない。

ハーネスの作りは第 1 便の `metadata-churn.ts`（`display/frontend/src/preview/metadata-churn.ts:12-16`）と `PreviewApp.svelte:154-165,417-426` に倣い、**production の `App.svelte` は一切変更しない**。段階 0 の成果物は数値表であり、製品コードの挙動は変わらない。

### 段階 1: churn 時の再点火を止める（設計は段階 0 の帰属で決める）

**狙い**: §2.2 の (i)(ii)(iii) を止める。**方式は分岐 1 で保留**しており、段階 0 の帰属結果によって候補 A / B / C のどれを採るかが変わる。ここでは各候補の実装制約だけを確定させておく。

#### 候補 A（シェルフとソルバ入力だけを `layoutSnapshot` にする）の実装制約

当初案は「計測シェルフとソルバ入力だけ `layoutSnapshot` を読み、生きているカードは `snapshot` を読む」だった。**この分離はコードの現状ではそのまま実現できない。** 理由は 3 つある。

1. `renderCard` snippet（`StandbyScreen.svelte:2112`）は**シェルフ（同 `:2372,2411`）と生きているカード（同 `:2469,2477,2486,2493`）で共有**されており、本体が `snapshot` を直読みする（同 `:2113-2120`）。分離するには snippet に snapshot を引数で通すか、snippet を複製する必要がある
2. `candidatePresent()`（同 `:806-816`）は**シェルフの `{#if}`（同 `:2370,2409`）とソルバの `candidates()`（同 `:817`）で共有**されている
3. `itemOf` 由来の 9 個の derived（同 `:320-327,341`）も両方から読まれる

したがって候補 A の実装コストは「prop を 1 つ足す」ではなく「snippet と述語群を測定用／描画用の 2 系統へ分ける」である。**候補 B より安全だが、候補 B より実装が大きい。** この事実を伏せて A を推奨しない。

#### 候補 B（生きているカードも含めて全部 `layoutSnapshot` にする）

実装は最小（入口で 1 つ差し替える）だが、キーの取りこぼしが**表示が更新されない**へ直結する。`layout-key.ts:10-11` が明示的に避けた失敗モードで、第 1 便の設計判断を性能のために覆すことになる。

鮮度を保つ必要がある描画点は `snapshot.` を読む全 34 か所のうち次のとおり（`grep -n "snapshot\." StandbyScreen.svelte` の全件）。

| 行 | 位置づけ | 凍結してよいか |
|---|---|---|
| `:306` | `$effect` 内（`recentQuakes` で選択中カードを閉じる） | 可（`recentQuakes` はキーに全体が入る、`layout-key.ts:196`） |
| `:315` | `standbyItems` derived | 可（`standbyContentIdentity` がキー） |
| `:342-344` | `hasWeather` / `hasQuake` / `connectionVisible` | `:344` は要注意（`connection.dmdata` はキーに入るので可） |
| `:353` | `displayWeatherAlerts` | 可 |
| `:384` | weather kind 解決 | 可 |
| `:557,829,838-840,874,995-996,1290,1390-1391` | ソルバ・計測の入力 | 可 |
| `:807` | `candidatePresent` | 可 |
| `:2059` | 入力 effect のキー計算 | **不可**（キー自体をここで作る） |
| `:2113-2120,2215-2216` | `renderCard` / prefix probe 本体 | シェルフ経由は可、生きているカード経由は不可 |
| `:2444-2445` | `.center-measure-shelf` 内の stats / recentQuakes 計測ノード | 可 |
| `:2460,2474` | ConnectionBadge（stage 0 / stage 1+） | **不可**（切断中の「最終受信 HH:MM」は分をまたいで動くが、キーは `formatHm` 後の文字列なので凍結すると表示が止まる） |
| `:2462` | stage 0 の clock-below（stats / recentQuakes） | **stats は不可**（`statsPart` は桁数だけをキーに採る、`layout-key.ts:125-129`）。recentQuakes は可 |
| `:2479-2480` | stage 1+ の stats / recentQuakes | **stats は不可**、recentQuakes は可 |

つまり候補 B を採るなら、`:2460,2462,2474,2479` の stats と connection だけは `snapshot` に据え置く例外配線が必要で、**「全部差し替えるだけ」では済まない**。

#### 候補 C（settle 終了後にシェルフを unmount する、F13）

`measured()`（同 `:780-786`）は live DOM ではなく `measurements` の state キャッシュを読む。したがって settle が終わったあとのシェルフ DOM は、次の epoch が始まるまで誰も読まない。シェルフ 2 面を `{#if !measurementSettled}` で囲えば、**churn 中はシェルフの DOM がそもそも存在せず、(iii) の再評価がゼロになる**。凍結キーの取りこぼしという失敗モード自体が発生しない点が A / B と決定的に違う。

**要検証（段階 0 で確かめる）**:

- epoch ごとに最大 54 枚＋probe 群を mount / unmount するコストが、churn で節約する分を食い潰さないか
- `captureMeasure`（同 `:788-`）の再登録と `measureNodes` の張り直しが epoch 境界で正しく起きるか。unmount 中に `readMeasurements()` が走ると `measurements` が空になり `measured()` が `defaultHeight` へ落ちる（同 `:786`）ので、mount の完了と `readMeasurements` の順序が崩れないこと
- partition probe の契約（`weatherPartitionProbeContracts` / `weatherMeasurementContracts`、同 `:1988-1989` で epoch ごとにクリアされる）が unmount をまたいで壊れないこと

**段階 0 の帰属で (iii) の DOM 再評価が支配的と出た場合、候補 C を第一候補にする。**

### 段階 2: settle を描画フレームへ譲る

**狙い**: §2.5 の 1 epoch = 1 long task を分割する。合計時間は減らないが、Chrome の「応答なし」判定とフリーズ感が減り、時計とテロップが止まりにくくなる。

**方式**: 外側 pass の境界に `requestAnimationFrame` の 1 回待ちを足す。具体的には内側 do-while を抜けた直後（`StandbyScreen.svelte:1861` の直後）と、`nextHidden` が変わって `continue` する経路（同 `:1875-1880`）の両方に入れる。**後者を入れ忘れると、中心クラスタの可視判定が振れる epoch だけ分割されない。** 内側の probe ループは分割しない（probe の連鎖を同一 pass 内で完結させる設計が同 `:1855-1858` のコメントで明示されている）。

**効果の限界を先に書く**。外側は最大 5 pass なので、分割で得られる片の数は最大 5 個である。1 epoch が 2.7 秒なら 1 片は 500ms 台で、**100ms 未満にはならない**。「Chrome の応答なしダイアログを避ける」には足りるが、「fps を保つ」には足りない。**内側 probe ループも分割するかは分岐 3 で裁定する。**

**制約**: §2.6 のとおり、譲ると `ladder-compressed` の中間状態が描画されうる。対処は分岐 2 で扱う。

**確定時刻への影響**: rAF を最大 5 回待つので確定が約 83ms（@60fps）遅れる。生きているカードは `committedPlan` を描いているので、遅れて見えるのは「新しい電文がレイアウトへ反映される瞬間」だけである。

### 段階 3: `preEpochCapture` の無駄な clone を除く

**狙い**: §2.4 の構造的な無駄だけを、判定を増やさずに除く。

1. `preEpochCapture()` の **clone ループ（`layout-motion.svelte.ts:142-153`）だけ**を `this.reducedMotion()` が true のときスキップする。`cancelActiveRun()`（同 `:154`）と `this.capture` / `this.captureEpoch` の設定（同 `:155-156`）は**従来どおり実行する**。走行中の WAAPI を止める責務と epoch の記録はここにしか無く、飛ばすと supersede が壊れる。`runForEpoch` は同 `:179-183` でどのみち capture を捨てるので、外形の挙動は完全に同一
2. `requestSettle()` が「初回 commit になる epoch」（`committedPlan == null`）では `preEpochCapture` を呼ばない（`StandbyScreen.svelte:1983-2004`）

2 について、`runForEpoch` 側の `firstCommit` は commit 直前に `committedPlan == null` で決まる（同 `:1894,1950`）。これを `requestSettle` 時点（同 `:1990`）へ前倒しできる根拠は、**`committedPlan` が null から非 null へ変わる唯一の経路が commit 自身であり、その commit より前に supersede が起きた場合は `break` して `runForEpoch` に到達しない**（同 `:1890,1910-1913`）ことである。つまり「requestSettle 時点で null なら、その epoch が `runForEpoch` に到達したときも必ず `firstCommit` が true」が成り立つ。

§2.4 のとおり **1 は Pi では発火しない**（coordinator に `reducedMotion` prop が配線されていないため）。性能ではなく正しさの保全として入れる。

### 段階 4: settle の壁時計上限 — **(c) 製品緩和**

`settleMeasurements()` に実時間の締切（例 250ms）を入れ、超えたら現在の plan で terminal commit（`StandbyScreen.svelte:1935-1976` の非収束経路）へ落とす。

**これは表示品質を落とす変更である。** 遅い実機（Raspberry Pi 500）では毎回締切に当たり、はみ出し・文字切れを残したまま確定しうる。`measurementNonConverged` が立つので診断はできるが、ご主人が実際に見る画面が劣化する。**推奨は不採用**（分岐 5）。

### やらないこと（本 spec の範囲外）

- 計測シェルフを `display: none` にする、または `content-visibility` を掛ける。計測ができなくなる、あるいは計測値が変わる（候補 C の unmount は「計測が終わったあとに消す」なので別物）
- `MAX_SETTLE_PASSES` / `MAX_PREFIX_ROWS` の縮小。レイアウト解の質を直接下げる
- `layout-key.ts` の除外リストへの field 追加。第 1 便で file:line 付きの証明を要求する形に固めた分類であり、性能を理由に緩めない
- **`reducedMotion` prop を coordinator へ配線すること**（§2.4）。挙動が変わる修正であり、`prefers-reduced-motion` 環境でのアニメーション有無に影響する。**別バグ候補として起票し、本 spec では触らない**
- 緊急画面（`EmergencyScreen`）の負荷。#18 の担当
- Node 側 sweep（#13 段階 2＋4）、`vpwp50ProjectionRejected` の診断分離（#16）
- ディスプレイ意匠の変更。**本 spec は `docs/specs/display-design-system.md` のトークンにも header/footer 統一 spec にも触れない**（段階 4 を採る場合のみ、確定前レイアウトが見える時間が伸びるという形で意匠に影響しうる。その場合は改めて意匠側の確認が要る）

## 4. テスト

### 4.1 段階 1: churn で再点火しないこと（jsdom）

第 1 便のテスト `display/frontend/src/components/__tests__/standby-metadata-resettle.test.ts` の describe 構成に倣い、metadata-only の 4 ケース（`generatedAt` のみ／`seq` のみ／接続中の `lastReceivedAt`／`tsunami.observations` のみ）で次を assert する。

- 採用した候補に応じた不変条件: 候補 A / B なら**シェルフ配下の要素ノードが同一インスタンスのまま**（更新前に採った `Node` 参照が更新後も同一オブジェクトかつ `isConnected`）。候補 C なら **`measurementSettled` が true の間シェルフが DOM に存在しないこと**
- **ソルバ呼び出し回数が増えないこと**。確認方法は 1 つに固定する: `solvePlan` をモジュール境界で `vi.spyOn` し、呼び出し回数を直接数える（`data-solver-stage` は値が同じなら差が出ないので判定に使わない）
- `data-measurement-pass` と `data-measurement-epoch` が不変（既存 assertion）

内容変更ケースでは**逆に再点火すること**を同じ方法で assert する。対象は第 1 便テストの内容変更 describe 群を全件そのまま使う（テスト追加時に describe 名を引用して列挙し、「(d)(e)〜(m)(p)」のような略記を spec にもテストにも残さない）。これが無いと「凍りっぱなし」の退行を検出できない。

### 4.2 段階 1: 鮮度が保たれること（jsdom）

§3.1 候補 B の表で「不可」と分類した 4 描画点を全件押さえる。

- `stats.totalReceived` を `1234 → 1235`（桁数不変）に変えた state で、stage 0（`:2462`）と stage 1+（`:2479`）の `InstrumentRow` の描画テキストが**両方**更新されること。かつ再計測は起きないこと
- `connection.dmdata = "disconnected"` の状態で `lastReceivedAt` を分をまたいで進め、stage 0（`:2460`）と stage 1+（`:2474`）の ConnectionBadge の「最終受信 HH:MM」が**両方**更新されること
- 接続中（バッジ非表示）で `lastReceivedAt` だけが動いても再計測が起きないこと（第 1 便の回帰）
- `.center-measure-shelf` 内の計測ノード（`:2444-2445`）は凍結側でよいので、更新されなくても落ちない

### 4.3 段階 2: pass 境界で譲っていること（jsdom）

- `requestAnimationFrame` をフェイクにして、settle が 2 pass 以上必要なケースで **rAF が pass 数 − 1 回呼ばれる**こと
- `nextHidden` が変わって `continue` する経路（`:1875-1880`）でも rAF が入ること
- rAF を待っている間に新しい epoch が来たら、旧 epoch が supersede として正しく降りること（`superseded` 経路、同 `:1890,1910-1913,1945,1964`）。**これは段階 2 で新たに開く窓なので必ず書く**
- `disposed` が rAF 待ちの間に立った場合に、`completeRun` も `publishSettledGeometry` も走らないこと

### 4.4 段階 3: clone をしないこと（jsdom）

- `reducedMotion` が true の coordinator で `preEpochCapture` を呼び、`diagnostics().captured` が 0 であること。**同時に、走行中の run が cancel され `captureEpoch` が設定されること**（`cancelActiveRun` / `captureEpoch` を飛ばしていないことの直接確認）
- 初回 commit の epoch で `preEpochCapture` が呼ばれないこと
- **2 epoch 目以降では clone 枚数が 0 でないこと**（前倒し判定が広すぎて全 epoch で clone を止めてしまう退行の検出）
- 移動・内容変更・消失の 3 パターンのアニメーションが現行と同じであること（`display/frontend/src/lib/legacy-standby/__tests__/layout-motion.test.ts` の既存ケースが全件緑のまま）

### 4.5 既存回帰

- `npm --prefix display run build`
- `npm --prefix display test`（第 1 便の実績 2,040 件）
- `npm test`（root、#13 後 6,878 件）
- `npm run test:shuffle`
- `npm run typecheck:test`
- ローカルゲートは `--maxWorkers=2` で静音実行する（memory `feedback_local_gate_low_parallel`）

### 4.6 実機採取（親が CDP で実走）

**jsdom の緑は transition とレイアウトの証明にならない。** どの段階も、実 Chrome の採取が無ければ配送根拠にしない。測定文脈は §5.2 に固定値で書く。子エージェントの sandbox は listen できないので、**実走は親（Liebe）が担い、子は records に対する `--assert-from` で assertion を検証する**（memory `feedback_capture_diagnostics_in_contract`）。

### 4.7 分岐 7-A: clone 枚数の観測点（jsdom）

`display/frontend/src/components/__tests__/standby-layout-motion-captured.test.ts`。

- **既定 props で `.standby` に `data-layout-motion-captured` が生えない**（production DOM 不変の固定）。同じケースで内容変更により epoch が実際に進んでいることと、coordinator 側の clone が実際に走っていること（mock で採った枚数が非 0）を併せて確認し、「属性が無いのは何も起きていないから」ではないことを示す
- `gateFixture` 付き、および `partitionDebug` 単独（preview の実経路）で属性が生え、値が `diagnostics().captured` と一致する
- **clone 0 枚の epoch では属性が消えず文字列 `"0"` が出る**（Svelte の `set_attribute` は `== null` のときだけ `removeAttribute` する）。jsdom では `fontsReady` が最初から true なので epoch 1 がそのまま settle し、この 0 を直接観測できる（§3.0 の F1 注記のとおり実機の姿とは異なる）
- 内容変更後の epoch で値が 0 でない

**この節は jsdom の値である。** 実機の枚数の妥当性は B6 で採る。

## 5. 受入条件

### 5.1 機械的に確認できるもの（A）

| # | 条件 | 段階 | 確認方法 |
|---|---|---|---|
| A1 | metadata-only の 4 ケースで、採用候補に応じた不変条件が成立（A/B はシェルフ DOM が同一インスタンス、C は `measurementSettled` 中シェルフ非存在） | 1 | 4.1 |
| A2 | 同 4 ケースで `solvePlan` の呼び出し回数が増えない（`vi.spyOn` で直接計数） | 1 | 4.1 |
| A3 | 第 1 便テストの内容変更 describe 群が全件、再点火と再計測を起こす | 1 | 4.1 |
| A4 | `stats` の桁数不変の数値更新が stage 0（`:2462`）と stage 1+（`:2479`）の**両方**で描画に反映され、再計測は起こさない | 1 | 4.2 |
| A5 | 切断中の `lastReceivedAt` 更新が stage 0（`:2460`）と stage 1+（`:2474`）の**両方**のバッジに反映される／接続中は再計測を起こさない | 1 | 4.2 |
| A6 | 2 pass 以上の settle で rAF が pass 数 − 1 回呼ばれ、`nextHidden` の `continue` 経路でも入る | 2 | 4.3 |
| A7 | rAF 待ちの間に来た新 epoch で旧 epoch が supersede として降りる | 2 | 4.3 |
| A8 | rAF 待ち中に `disposed` が立ったら commit も motion も走らない | 2 | 4.3 |
| A9 | `reducedMotion` true で clone 枚数が 0、かつ `cancelActiveRun` と `captureEpoch` 設定は従来どおり走る | 3 | 4.4 |
| A10 | 初回 commit の epoch で `preEpochCapture` が呼ばれず、**2 epoch 目以降では clone 枚数が 0 でない** | 3 | 4.4 |
| A11 | `layout-motion.test.ts` の既存ケースが全件緑 | 3 | 4.4 |
| A12 | build / test（display・root）/ shuffle / typecheck:test が全部成功 | 0〜3 | 4.5 |
| A13 | `display/frontend/src/App.svelte` に差分が無く、かつ production パス（`src/App.svelte` から到達するモジュール）に対する `metadata-churn` / `contentChurn` の grep が 0 件 | 0 | `git diff --stat` と grep |
| A14 | 既定 props（`partitionDebug` false・`gateFixture` 未指定＝`App.svelte:284-294` と同じ形）で `.standby` に `data-layout-motion-captured` が**存在しない**。gate / preview props では存在し、値が coordinator の `diagnostics().captured` と一致する | 分岐 7-A | 4.7 |

### 5.2 実機（B、環境依存のため CI の合否には使わない）

**測定文脈を固定する。** Chrome 152 headless / 1920×1080 を `Emulation.setDeviceMetricsOverride` で attach 直後に設定（`--window-size` だけでは viewport 高が枠分減る。memory `feedback_headless_viewport_override`）／ preview `#legacy-standby-gate` `gateScenario=max`（59 カード）／採取 60 秒／report に `innerWidth` と `innerHeight` を含める。capture の前に `npm --prefix display run build` を必ず通す（memory `feedback_capture_needs_display_build`）。

| # | 条件 | 段階 | 測定 |
|---|---|---|---|
| B0 | §3.0 の 3 種の数字（reparse churn / 帰属内訳 / 1 epoch コスト）が採れており、reparse モードが主指標として表になっている。**`preEpochCapture` の clone 枚数も `data-layout-motion-captured` から epoch 対で採る**（分岐 7-A 実装後。読み方は §3.0） | 0 | 実 Chrome |
| B1 | `?metadataChurnMs=500&metadataChurnMode=reparse` の 60 秒で long task 合計が **段階 0 実測値の半分以下** | 1 | 実 Chrome |
| B2 | 同条件で fps が 55 以上、100ms 超の long task が 0 件 | 1 | 実 Chrome |
| B3 | churn 無指定の 60 秒で long task 0 件・fps 60（現状維持の回帰） | 1〜3 | 実 Chrome |
| B4 | `?contentChurnMs` で 1 epoch が **2 個以上の task に分割され、最大の 1 片が epoch 総時間の 1/3 未満**（外側 5 pass の分割では 100ms 未満には届かない。§3.2 の限界を参照） | 2 | 実 Chrome |
| B5 | 同条件で 1 epoch の総所要時間の増加が **絶対値 +120ms 以内**（rAF 5 回ぶんの約 83ms ＋余裕。相対 % は段階 1 が効くほど厳しくなるので使わない） | 2 | 実 Chrome |
| B6 | `?contentChurnMs` で `preEpochCapture` の clone 枚数が、**初回 commit の epoch**（実機ではフォント確定後の最初の settle epoch。epoch 1 ではない。§3.0 の F1 注記）で 0、それ以降の epoch で 0 でない。**分岐 7-A の `data-layout-motion-captured` で測定可能（保留解除、2026-09-08）**。段階 3 着手**前**の実機は初回 commit epoch でも非 0 になるのが正常で、この行は段階 3 の after でのみ判定する | 3 | 診断属性 `.standby[data-layout-motion-captured]` を `data-measurement-epoch` と対でポーリング |
| B7 | Pi 実機で 10 分以上の連続観察中に Chrome の「応答なし」が出ず、**ローテーションが進み続ける**（`data-rotation-active-key` が観察窓の中で 2 回以上変化し、`data-rotation-position` が更新される。目視の印象ではなく属性の変化で判定する） | 1＋2＋3 | 実機・属性ポーリング |

**before / after は同じ手順・同じ時間帯で採る。** after だけを載せない。第 1 便の before は main の build/test と同時刻に走って CPU 競合を含んでいたので、同じ轍を踏まない。

### 5.3 スコープ外（本 spec の受入条件に入れない）

- Node 側 sweep の残り（#13 段階 2＋4）
- `vpwp50ProjectionRejected` の診断分離（#16）
- 緊急画面の遷移負荷（#18 の実 Chrome gate）
- `reducedMotion` prop の coordinator 未配線（別バグ候補、§3 の「やらないこと」）
- volcano salvage の `discarded=109` 別件

## 6. 判断分岐

### 分岐 1: 段階 1 の方式 — **保留（段階 0 の帰属結果で決める）**

当初は候補 A を推奨していたが、**A の実装が「prop を 1 つ足す」では済まないことが判明した**（§3.1、`renderCard` snippet と `candidatePresent` がシェルフと生きているカードで共有されている）ため推奨を取り下げる。段階 0 の帰属を見てから選ぶ。

- **候補 A: シェルフとソルバ入力だけ `layoutSnapshot`。** 失敗モードが第 1 便で承認済みのものと同型（hidden なシェルフが古い内容で計測される）に留まり、表示は決して古くならない。ただし snippet と述語群を 2 系統へ分ける実装が要る
- **候補 B: 生きているカードも含めて全部 `layoutSnapshot`。** 実装は最小だが、キーの取りこぼしが**表示の更新漏れ**へ直結する。§3.1 の表で「不可」とした 4 描画点の例外配線も要る
- **候補 C: settle 終了後にシェルフを unmount（`{#if !measurementSettled}`）。** 凍結キーの失敗モード自体が発生しないのが決定的な利点。§3.1 の 3 点（mount コスト・`captureMeasure` 再登録・probe 契約）が要検証。**段階 0 で (iii) の DOM 再評価が支配的と出たら第一候補**
- **候補 D: 何もしない。** §1.2 のとおり本番の平常時負荷は 0.05% 程度である。段階 0 の reparse 実測がそれでも小さければ、段階 1 を丸ごと見送って段階 2＋3 に集中するのが正しい

### 分岐 2: 段階 2 で `ladder-compressed` の中間状態をどう扱うか

- **A（推奨）: まず段階 0 の採取で「中間状態が実際に何フレーム見えるか」を確かめ、見えないなら何もしない。** `measurementGeometryStage` が動くのは stage 境界をまたぐ epoch だけで（`StandbyScreen.svelte:1837-1848`）、多くの epoch では初期値のまま確定する。起こらない問題に構造を足さない
- **B: `ladder-compressed` を可視ルートから外し、シェルフ側だけに掛ける。** 中間状態は構造的に見えなくなるが、シェルフ幅は `--edge` / `--gap` を含む式で決まっており（同 `:2524`）、**計測値そのものが変わりうる**
- **C: settle 中は `ladder-compressed` を `committedStage` 由来に固定し、確定時に一度だけ切り替える。** 中間状態は見えないが、`:1837-1848` の「圧縮境界をまたいだら測り直す」ロジックと真正面から衝突する

### 分岐 3: 段階 2 で内側 probe ループも分割するか

§3.2 のとおり、外側 pass だけの分割では 1 片が 500ms 台までしか下がらない。

- **A（推奨）: まず外側だけで配送し、段階 0 の B4 実測を見てから内側を判断する。** 内側の probe 連鎖は「同一 pass 内で完結させる」ことが設計の前提としてコメントに明記されており（`StandbyScreen.svelte:1855-1858`）、分割すると probe の materialize と `hasPendingProbes()` の判定の間に外部の state 更新が割り込む窓が開く。外側だけでも「応答なしダイアログ」は避けられる見込み
- **B: 内側も N step ごとに rAF を挟む。** 1 片は数十 ms まで下がり fps も保てるが、上の窓を自分で開けることになる。開けるなら「pass の途中で新 epoch が来たら即 supersede する」経路のテストを分岐 3-B 専用に足す

### 分岐 4: `preEpochCapture` の clone を「変わりうるカードだけ」に絞るか

- **A（推奨）: 絞らない。段階 3 は「捨てられることが確定している clone」だけを除く。** shell が要るかどうか（`contentChanged || resized`）は capture 時点では未知で、サイズ変化は他カードの変化からも波及する。予測を外すと**アニメーションが静かに欠ける**という、テストで捕まえにくい失敗になる
- **B: 入力が変わったカードだけ clone する。** 効果は大きいが、上の予測を実装が背負う。段階 0 の 1 epoch 帰属で「大半が clone」と出た場合にのみ、別 spec として検討する

### 分岐 5: 段階 4（settle の壁時計上限）を採るか — **(c) 製品緩和**

- **A（推奨）: 採らない。** 締切で打ち切るとレイアウトが未収束のまま確定し、はみ出しと文字切れが実機に出る。段階 2 で long task が切れれば「応答なし」は解ける見込みで、そのときこの緩和は要らない
- **B: 採る（例 250ms）。** 最悪ケースの所要時間に硬い上限が付く。ただし Pi では常に締切側に当たる可能性があり、**ご主人が毎日見る画面の品質を落とす**。採るなら締切値は Pi の実測 1 epoch 所要時間を採ってから決める

**この分岐は製品挙動を緩める提案なので、Liebe は独断しない。** 段階 0 の実測を添えてご主人へ回す。

### 分岐 6: 配送をどこで切るか

- **C（推奨）: 段階 0 だけを第 1 便として配送し、その数字を見てから段階 1 以降をやるかどうかを含めて裁定する。** 根拠は 2 つ。(1) 本番の平常時負荷は 107 秒に 1 回 × 55ms = 0.05% 程度で、**段階 1 単独の体感利得はほぼ無い**。(2) 一方 1 epoch のコストは電文が届くたびに必ず出る（before 実測 2.7 秒、after 未計測）。**reparse モードと 1 epoch の数字を見るまで、段階 1 の価値は確定できない。** 段階 0 は preview 限定で製品挙動を変えないので、配送のリスクも最小
- **A: 段階 0＋1 を第 1 便、段階 2＋3 を第 2 便。** 往復は減るが、段階 1 の方式が分岐 1 で保留されている以上、同じ便で決め切るには帰属の数字を先に採る必要があり、結局 C と同じ順序になる
- **B: 段階 1＋2＋3 を 1 便で配送する。** 実機で退行が出たときに原因の切り分けが 3 段階ぶん増える

### 分岐 7: `preEpochCapture` の clone 枚数をどう採るか — **裁定 A 確定（2026-09-08）**

§3.0 のとおり `diagnostics().captured` は `StandbyScreen.svelte` の内部に閉じており、段階 0 の禁止変更に触れずには読めなかった。B6 の測定手段がこの分岐に依存していた。

- **A（採用・ご主人裁定 2026-09-08）: `StandbyScreen.svelte` に `data-layout-motion-captured` を 1 行足し、`partitionDebug || gateFixture != null` で囲う。** `:2174` の briefing partition debug と同じ preview/gate 限定の既存前例に倣う形で、production の DOM は変わらない。段階 3 の受入（A10・B6）は本来この数字を要求しているので、段階 3 に着手するなら遅かれ早かれ要る
- **B（不採用）: 諦める。** 段階 3 の効果は「捨てられることが確定している clone を除く」正しさの保全であって性能ではない（§2.4 のとおり Pi では `reducedMotion` 経路が発火しない）ので、枚数を測らずに jsdom の A9・A10 だけで受けるという選択もありえた。ただし実機での退行検出力は落ちる

**実装（2026-09-08）**: 属性・ガード・値の意味・親の読み方は §3.0 の「観測点」節にまとめた。受入テストは `display/frontend/src/components/__tests__/standby-layout-motion-captured.test.ts`（(a) 既定で属性が生えない／(b) gate・preview で coordinator の実値と一致／(c) 初回 0・2 epoch 目以降で非 0）。

## 7. 裁定ラベル案（段階ごと、6 要素）

各段階の 6 要素がすべて埋まっていることを配送前に確認する。**空欄が 1 つでもあれば配送不可**（`.claude/rules/autonomous-cycle.md`）。

### 段階 0（帰属計測・preview ハーネス）— **第 1 便**

```
対象: display/frontend/src/preview/metadata-churn.ts, display/frontend/src/preview/PreviewApp.svelte,
      display/frontend/src/preview/__tests__/metadata-churn.test.ts,
      docs/specs/2026-09-08-standby-resettle-residual-load.md（本 spec 自身）
      → 配送 diff はこの 4 ファイルのみ
      （計測スクリプトは scratchpad に置く。repo 外なので diff 照合の対象に含めない）
許容変更: preview 限定の churn モード追加（?metadataChurnMode=reparse・?contentChurnMs=<ms>、
          既定は現行と完全同一）／preview 限定の観測点追加（?churnProbe=1 で有効化する
          MutationObserver カウンタ、window.__fleqChurnProbe、<main> の data-churn-* 8 属性。
          いずれも既定 off・churn 無指定なら DOM に現れない。詳細は §3.0）
禁止変更: display/frontend/src/App.svelte・components/ 配下・lib/ 配下の製品コード、layout-key.ts の分類
          （分岐 7-A の観測点は本ラベルの対象外。別便・別ラベルとして下の
            「分岐 7-A 追加ラベル」で配送する）
配送先: main → personal → Pi（preview 限定なので Pi の表示挙動は不変）
ロールバック: git revert <commit>
受入条件: A13（App.svelte 差分ゼロ＋production パスへの grep 0 件）・A12（全ゲート緑）・
          パラメータ非指定時に preview の DOM が現行と一致すること（data-churn-* が 1 つも出ない）・
          B0（3 種の数字が表になっていること。clone 枚数は分岐 7-A 配送後に同じ表へ足す）
```

### 分岐 7-A 追加ラベル（`preEpochCapture` clone 枚数の観測点）— **ご主人裁定 2026-09-08**

段階 0 の禁止変更が `components/` 配下を閉じているため、観測点は**段階 0 とは別の便・別のラベル**で配送する。

```
対象: display/frontend/src/components/StandbyScreen.svelte
      （partitionDebug || gateFixture != null ガード付きの観測点 1 行と書き込み 1 箇所、
        および $state 宣言 1 行）
      display/frontend/src/components/__tests__/standby-layout-motion-captured.test.ts（新規）
      docs/specs/2026-09-08-standby-resettle-residual-load.md（本 spec 自身）
許容変更: 上記の観測点と、書き込み側・描画側の両方に置くガードのみ
禁止変更: ガード無しの属性出力、累計カウンタの追加、段階 1〜4 の先取り（凍結・unmount・
          rAF 分割・clone 削減）、layout-motion.svelte.ts / layout-key.ts /
          connection.svelte.ts / App.svelte の変更、package*.json
配送先: main → personal → Pi（production の DOM は不変なので Pi の表示挙動は変わらない）
ロールバック: git revert <commit>（単一 commit）
受入条件: A14（既定 props で属性が生えない／gate・preview で実値と一致）・A12（全ゲート緑）・
          B6（段階 3 の after で判定。着手前は非 0 が正常）
```

### 段階 1（churn 再点火の停止）— **方式が分岐 1 で保留のため配送不可**

```
対象: display/frontend/src/components/StandbyScreen.svelte,
      display/frontend/src/components/__tests__/standby-metadata-resettle.test.ts（追記）
許容変更: 分岐 1 で裁定された候補（A / B / C）の実装のみ
禁止変更: layout-key.ts の分類（除外リストへの field 追加）、§3.1 の表で「不可」とした 4 描画点の凍結、
          MAX_SETTLE_PASSES / MAX_PREFIX_ROWS、意匠トークン
配送先: main → personal → Pi
ロールバック: git revert <commit>
受入条件: A1〜A5・A12、実機 B1〜B3（before/after を同一手順で採取）
```

**「許容変更」が分岐 1 の裁定に依存しているため、現状この段階は配送不可・準備作業止まりである。** 分岐 1 が決まった時点でラベルを埋め直す。

### 段階 2（settle のフレーム分割）

```
対象: display/frontend/src/components/StandbyScreen.svelte,
      display/frontend/src/components/__tests__/standby.test.ts（追記）
許容変更: 外側 pass 境界（:1861 直後）と nextHidden continue 経路（:1875-1880）への rAF 1 回待ち、
          supersede / dispose の窓に対する防御
禁止変更: 内側 probe ループの分割（分岐 3 B は別裁定）、MAX_SETTLE_PASSES /
          MAX_POST_COMMIT_VERIFICATION_PASSES の変更、壁時計での打ち切り（段階 4 は別裁定）、
          ladder-compressed の付与先変更（分岐 2 B/C は別裁定）
配送先: main → personal → Pi
ロールバック: git revert <commit>
受入条件: A6〜A8・A12、実機 B4・B5・B3、Pi で B7
```

### 段階 3（preEpochCapture の無駄 clone 除去）

```
対象: display/frontend/src/lib/legacy-standby/layout-motion.svelte.ts,
      display/frontend/src/components/StandbyScreen.svelte,
      display/frontend/src/lib/legacy-standby/__tests__/layout-motion.test.ts（追記）
許容変更: reducedMotion 時の clone ループのみスキップ（cancelActiveRun と captureEpoch は保持）、
          初回 commit epoch での preEpochCapture 非呼び出し
禁止変更: 「変わりそうなカードだけ clone」の予測導入（分岐 4 B）、runForEpoch のアニメーション判定、
          shell の attach / detach 順序、reducedMotion prop の coordinator への配線（別件）
配送先: main → personal → Pi
ロールバック: git revert <commit>
受入条件: A9〜A12、実機 B6・B3
```

### 段階 4（settle の壁時計上限）— **ご主人裁定まで配送不可**

```
対象: 未定（分岐 5 が A なら着手しない）
許容変更: 未定
禁止変更: 未定
配送先: 未定
ロールバック: 未定
受入条件: 未定
```

**6 要素が埋まっていないので、この段階は配送不可・準備作業止まりである。** 分岐 5 が B で裁定された場合にのみ、Pi の 1 epoch 実測を添えてラベルを埋め直す。

## 8. 参照

- Issue #15（本文・第 1 便の配送コメント）
- 第 1 便: main `65d6f9b`、spec `docs/specs/2026-09-07-standby-metadata-resettle.md`
- 節構成の型: `docs/specs/2026-09-07-standby-sweep-hot-path.md`
- session-log: `~/Obsidian/Liebe/Session-log/2026-09/2026-09-07-fleq-performance-root-cause.md`
- ハンドオフ: `~/Obsidian/Liebe/Artifacts/Handoffs/2026-09-08-fleq-performance-lane-close-handoff.md`
- memory: `feedback_observation_driven_debugging`・`feedback_capture_diagnostics_in_contract`・`feedback_headless_viewport_override`・`feedback_capture_needs_display_build`・`feedback_green_tests_not_proof`・`feedback_local_gate_low_parallel`

## 段階 0 計測結果（2026-09-08 21:41〜21:46、Mac、Chrome 152 headless、1920×1080、各 60 秒）

| run | churn | long task 合計 | >100ms | 最大片 | fps | captured |
|---|---|---|---|---|---|---|
| control | なし | 0ms | 0 | 0 | 60 | 8 |
| shared | meta 500ms | 8,948ms | 0 | 82ms | 54.5 | 8 |
| reparse（主指標） | meta 500ms | 10,204ms | 2 | 103ms | 54.2 | 8 |
| probe | meta 500ms | 10,996ms | 1 | 112ms | 53.8 | 8 |
| epoch | content 5000ms | 30,349ms | 12 | **2,616ms** | 30.2 | 8 |

- 帰属カウンタ（probe run、churn 121 回）: shelfMutations **0**、rootAttrMutations 27、liveMutations 263（2.2 件/churn）。隠しシェルフの DOM 変異は起きていない。§2.2 の経路 (iii) は DOM 側では確認できず、churn コストは生きているカード側の再評価に帰属する見立てへ更新
- 1 epoch: 内容変化 1 回につき single long task **2,487〜2,616ms**（epoch 10 件平均 3,035ms）、passΔ 107 / epoch、readCount ≈ 426、clone 8 枚。第 1 便 before の 2.7 秒と同水準で、電文が届くたびに約 2.5 秒描画が止まる
- 結論: 段階 1（シェルフ凍結）の本番利得は小さい。次の優先は **1 epoch の settle コスト**（pass 数の削減・分割）。段階 1〜4 の裁定はこの結果を前提に行う
- 生データ: scratchpad `stage0-results-2026-09-08T12-41-04.json`、スクリプト `stage0-measure.mjs`
