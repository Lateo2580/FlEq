# 待機画面 1 epoch の settle コスト削減 spec（GitHub Issue #15 第 3 便）

> **状態**: **段階 1 実装済み**（2026-09-09、ご主人裁定 🌙自走OK。分岐 1 は A、分岐 4 は C）。段階 2 以降は未着手で、§6 の残る分岐 5 件はご主人裁定待ち（うち分岐 5（段階 7）は (c) 製品緩和）。実装ベースは公開 main `592e5d2`。
>
> **改訂履歴**
>
> | 日付 | 内容 |
> |---|---|
> | 2026-09-09 | 起草＋独立レビュー反映（GO with fixes、12 指摘） |
> | 2026-09-09 | 段階 1 実装（分岐 1-A）。§3 段階 1 に確定した識別子・計測点・観測手順を追記 |
> | 2026-09-09 | 段階 1 の独立レビュー反映。**判定基準を (a) 測定事実の訂正として書き直した**——`data-settle-read-ms` は §2.7 (b) の `find` 走査を内側に含むので (a) 単独ではなく (a)+(b) の合算である（§2.8 末尾・§3 段階 1）。§5.2 に「B2 の比は下限値」を追記 |
>
> **基準 SHA**: `b98caed5f677c61d554d7fe79a2a158c872b157f`（worktree `~/dev/fleq-layout`、branch main）。第 2 便（段階 0 の計測ハーネスと `data-layout-motion-captured`）が入った状態。
>
> **前提**: 本 spec は第 2 便 `docs/specs/2026-09-08-standby-resettle-residual-load.md` の続きで、その **§1.3「1 epoch のコスト」だけ**を扱う。同 spec の段階 1（シェルフ凍結）は段階 0 の実測（shelfMutations = 0）で見送り裁定済み。ブラウザ側だけを対象とし、Node 側の周期（#13 段階 2＋4）と `vpwp50ProjectionRejected` の診断分離（#16）は範囲外。
>
> **意匠**: 本 spec は `docs/specs/display-design-system.md` のトークンにも header/footer 統一 spec にも触れない。**確定後の表示はどの段階でも不変**である。段階 5・6 だけが「確定に至る過程に中間フレームが出うる」という形で見え方に触れる。錨カードの参照は不要。
>
> **見立ての位置づけ（重要）**: §2 の pass 内訳は `data-measurement-pass` / `data-measurement-read-count` の実測時系列とコード読了の突き合わせで**確定**した。一方 §2.7 のとおり、**2,526ms の中身がノード読み取りなのか pass 位置とともに増える別の項なのかは、段階 0 のデータからは分離できない**（rc 線形 0.813 / idx 線形 0.823 / idx 二次 0.849 / rc 二次 0.848 が並ぶ）。したがって**段階 2 の効果は 0〜75% の幅でしか書けない**。段階 1 はこの幅を潰すためだけの段階である。
>
> **独立レビュー反映（2026-09-09、GO with fixes）**: 分岐 2 の推奨を A → **B**（flood / volcano / quake 限定）へ変更した。weather / tornado の probe が briefing と同型の失敗モードを独立に持つことが `weatherPrefixMeasurement`（`:497-511`）→ `weatherMeasurementRanges`（`:456-467`）→ `cachedPagePartitionMeasurement`（`:667-683`）の連鎖で確認できたため（High-1）。**段階 5 と 6 の優先順を入れ替えた**。readCount が epoch 内で単調増加のまま一度も戻らないという実データから、107 読みのうち約 106 回が外側 pass 1 周目に入っており、外側境界の分割は 2 片（約 2,478ms + 約 47ms）にしかならないと確定したため（High-2）。§2.7 を「pass とともに増えるコストの候補」へ、§2.8 を二次モデルとその含意へ書き直し、段階 1 の判定基準を `settleTrace=0/1` の比から `data-settle-read-ms ÷ epoch 総時間` へ変えた。算術を訂正した（28,526 → epoch 内 **28,100**、prefix 読み **21,466**、1 ノード **68.2 回**、long task は 12 件・中央値 **2,526ms**）。A13（旧 A11）の grep 条件を新識別子名で書き直した。

## 1. 症状

### 1.1 段階 0 の実測（2026-09-08、Mac、Chrome 152 headless、1920×1080）

preview `#legacy-standby-gate` `gateScenario=max`（59 カード）、`?contentChurnMs=5000&metadataChurnMode=reparse`、採取 60 秒。生データは scratchpad `stage0-results-2026-09-08T12-41-04.json`、スクリプトは `stage0-measure.mjs`。

| 指標 | 値 |
|---|---|
| 内容変化と long task の対応 | **12 回の内容変化に対し long task 12 件**（中央値 **2,526ms**、最小 2,454ms、最大 2,616ms） |
| `data-measurement-pass` の増分 | **107 / epoch**（12 epoch すべてで一定） |
| `data-measurement-read-count` の到達値 | **426**（epoch 冒頭で 62 まで落ちてから再び 426 まで単調に登る） |
| `data-layout-motion-captured` | 8 枚（全 epoch 一定） |
| `data-measurement-geometry-stage` | 1,297 観測すべて `0` |
| fps | 30.2（内容変化なしの control は 60） |

第 2 便 spec の「long task を伴う 10 epoch の平均合計 3,035ms」は epoch 境界への帰属ずれを含む。**内容変化 1 回 ＝ long task 1 件 ＝ 中央値 2,526ms** が正しい読みで、本 spec ではこちらを使う。

**この 1 個の long task が本 spec の対象である。** 平常時の metadata churn（reparse 主指標で 60 秒 10,204ms、最大片 103ms）は第 2 便の段階 0 で「本番の平常時は 107 秒に 1 回なので 0.05% 程度」と結論が出ており、本 spec では扱わない。

### 1.2 本番での効き

- 1 epoch のコストは**電文が届くたびに必ず出る**。Pi 実機の実測では 22.5 時間で seq 755 なので平常時は平均 107 秒に 1 回だが、警報時は連続する
- Pi は Mac の **4.6〜6.4 倍遅い**（session-log 2026-09-08 の #13 A/B 計測）。2,526ms × 4.6〜6.4 = **11.6〜16.2 秒**。電文 1 通ごとに画面がこの時間止まる
- 止まる間、時計・テロップ・ローテーションはすべて進まない。ご主人が「時計が止まる」と観測したのはこの症状の一部である（#13 で Node 側の 1.2 秒は解消済み、残るのはブラウザ側のこれ）

### 1.3 数値の再確認が要る点

段階 0 の 5 run はすべて URL に `gateScenario=max` を含む。`gateCapture` は `URLSearchParams.has("gateScenario")` で決まるので（`StandbyScreen.svelte:76-77`）、**計測中は常に gate 専用の経路が有効だった**。`gateCapture` の用途は 3 つある。

| 用途 | file:line | 段階 0 への影響 |
|---|---|---|
| fixture シナリオの選択 | URL の `gateScenario` そのもの | 59 カードの条件。**残す** |
| settle トレースの記録と DOM 属性への直列化 | `:1422-1436`, `:2253` | pass 数に対して二乗。**切り分けたい** |
| `recentHypocentersClipped` の視覚 assertion | `:1514`（`gateCapture &&` で `querySelectorAll` と rect 比較） | 確定時に 1 回。小さいが gate 専用 |

本番の Pi には `gateScenario` が付かないので後ろ 2 つは本番に無い。§2.7 のとおり実測からは分離できないため、段階 1 で切り分ける。

## 2. 根因（file:line、コード読了後）

### 2.1 `data-measurement-pass` は「外側 pass」ではなく `readMeasurements()` の呼び出し回数である（確定）

`measurementPass += 1` は `readMeasurements()` の末尾にある（`StandbyScreen.svelte:1404`）。外側ループの `pass` 変数（同 `:1829`）とは別物である。

したがって **passΔ = 107 は「1 epoch で `readMeasurements()` が 107 回走った」**という意味であり、`MAX_SETTLE_PASSES = 4`（同 `:84`）と矛盾しない。外側は 4＋post-commit 1 のままで、内側の probe ループ（同 `:1830-1866`、上限 `maxProbeSteps = MAX_PREFIX_ROWS * 4 + 1 = 513`、同 `:1833`）が 100 回超回っている。

**第 2 便 spec の「passΔ 107 / epoch」という表記は、外側 pass が 107 回という意味に読める。本 spec でその読みを訂正する。**

### 2.2 107 読みはほぼ全部が外側 pass 1 周目に入っている（強い推測・段階 1 で確定させる）

epoch 内の readCount 列は **一度も戻らずに単調増加する**（epoch 5 / epoch 8 の 107 増分すべてで確認）。prefix entry は epoch 冒頭の `prefixMeasureEntries = []`（同 `:2004`）以外では消えないので、これは「内側 probe ループが連続して回り続けた」ことと整合する。

外側ループの構造（同 `:1829-1988`）から次が導ける。

- 1 周目は `previous = ""` なので署名一致が起こりえず、内側ループを抜けたあと必ず `previous = next` して 2 周目へ行く
- 2 周目の内側 do-while は `await tick()` → `readMeasurements()` → `drainProbes()` → `flushSync()` の 1 巡で、pending probe が無いので即抜ける（**読み 1 回**）
- その直後に署名が一致して commit する

観測末尾の `..., 423, 423, 426, 426` と、最後の 1 読みだけが 47.6ms で他より重いことがこれと合う。つまり **106 読み（外側 1 周目）＋ 1 読み（外側 2 周目の確認）= 107**。

**これは強い推測であって直接観測ではない。** 外側 pass の内訳は `data-settle-trace`（同 `:2253`、`pass` と `step` を持つ）に出ているが、段階 0 のハーネスはこの属性を採っていない。段階 1 の観測対象に加えて確定させる。

### 2.3 `data-measurement-read-count` は累計ではなく「そのとき登録されているノード数」である（確定）

`measurementReadCount = measureNodes.size + prefixMeasureNodes.size + 14`（同 `:1403`）。累積カウンタではなく**瞬間値**である。14 は `readMeasurements()` の末尾で必ず読む固定の rect / computed style の本数（layout・3 トラック・2 シェルフ・南海・ローテーション指標・stats・recent・connection・時計・standby・baselineGap、同 `:1371-1402`）。

実測の下限 62 と上限 426 から、内訳が算術で確定する。

| 内訳 | 本数 | 根拠 |
|---|---|---|
| 計測シェルフのカード（`measureNodes`） | **48** | epoch 冒頭に prefix が 0 になった直後の読みが 62。62 − 14 = 48 |
| prefix probe（`prefixMeasureNodes`） | **0 → 364** | 到達値 426 − 14 − 48 = 364 |
| 固定読み | 14 | 上記 |

### 2.4 各 pass は「そのとき生えている全ノードを最初から読み直す」（確定）

`readMeasurements()`（同 `:1309-1405`）は毎回、

1. `measureNodes` を全件走査して `liveBorderBoxHeight()`（同 `:1304-1308`。`querySelector` ＋ `getBoundingClientRect()` ＋ `scrollHeight`）
2. `prefixMeasureNodes` を全件走査。`purpose: "page"` のものは `querySelector` × 2 ＋ `querySelectorAll` ＋ `getComputedStyle` ＋ 各 readable 領域の `clientHeight` / `clientWidth` / `scrollHeight` / `scrollWidth`（同 `:1316-1370`）
3. 固定 14 本

を行う。**キャッシュ判定は 1 件も無い。** 直前に `flushSync()`（同 `:1863`）で DOM を書いているので、読むたびに強制レイアウトが起きる read-after-write の反復である。

### 2.5 probe は 1 世代ずつしか生えない（確定）

`pagePartitionProbe()`（同 `:711-762`）は、キャッシュに無い range を聞かれると `coordinator.enqueueProbe()` して `null`（＝未知）を返す。パーティション探索は未知に当たった時点で止まる。`drainProbes()` は溜まった分を全部流すが（`epoch-coordinator.ts:72-75`）、探索は 1 レンダにつき「次に必要な 1 range」しか発見できない。

結果、probe ループは「数枚生やす → 全件読み直す」を繰り返す。実測の readCount 列がそれを裏取りしている（epoch 5 / epoch 8 で完全に同一）。

```
426, 62, 80, 80, 91, 91, 102, 102, 113, 113, 122, 122, 131, 131, 138, 138, ...
..., 405, 405, 411, 411, 420, 420, 423, 423, 426, 426
```

2 step ごとに 6〜18 本ずつ増え、増えるたびに**それまでの全件も読み直される**。probe の世代数は約 53、1 世代につき 2 読みである。

### 2.6 1 epoch のノード読み取り総数は 28,100 件（確定）

実測時系列（`rawObservations`、`.standby` の属性 MutationObserver）から readCount を積算する。epoch の 108 観測のうち先頭 1 件は**前 epoch の末尾状態**（rc = 426、`settled` は既に false）なので、epoch 内の読みは残り 107 件である。

| 量 | 値 |
|---|---|
| epoch 内のノード読み取り総数 | **28,100 件**（108 観測の単純和 28,526 から境界の 426 を引いた値） |
| うち prefix probe | **21,466 件** |
| うちカード＋固定（62 × 107） | **6,634 件** |
| 登録ノード最大 | 412 本 |
| 1 ノードあたりの読み直し回数 | **68.2 回** |

pass 間隔も同じ時系列から採れる。

| | epoch 5 | epoch 8 |
|---|---|---|
| epoch の総所要 | 2,524.8ms | 2,585.1ms |
| pass 間隔の平均 | 23.6ms | 24.2ms |
| readCount 62 付近の pass | 約 12ms | 約 12ms |
| readCount 426 付近の pass | 約 47ms | 約 48ms |

MutationObserver の callback は microtask チェックポイントで届くので、**1 個の long task の中でも pass ごとに時刻が採れている**。「1 epoch = 1 long task」と「pass ごとの CPU 時間が採れる」は矛盾しない。

### 2.7 pass とともに増えるコストの候補（すべて確定・規模だけが未分離）

pass が進むと重くなるのは実測で明らかだが、**重くなる理由の候補が複数あり、どれも pass 位置と単調に相関している**。

| # | 箇所 | 何に比例するか | 本番にあるか |
|---|---|---|---|
| (a) | `readMeasurements()` の DOM 読み `:1309-1405` | 登録ノード数（rc） | **ある** |
| (b) | `prefixMeasureEntries.find(...)` を prefix ループの**中**で呼ぶ `:1317` | ノード数 × entry 数（364 × 364 ≈ 13 万回／pass、107 pass で約 1,400 万回） | **ある** |
| (c) | `briefingPartitionRevision` `:900-904` / `weatherPartitionRevision` `:905-909` | `prefixMeasurements` 全件を `localeCompare` で sort して join。`prefixMeasurements` は毎 pass 再代入されるので毎 pass 再導出される | **ある**（production の template から読まれる） |
| (d) | `signature()` `:1437` | `measurements` ＋ `prefixMeasurements` の全件 sort と結合（約 412 件、10KB 級の文字列） | **ある**（外側 pass ごと。内側では gate 時のみ） |
| (e) | 可視ルートの `data-*` 属性 `:2246-2373` が **126 個**、うち 16 個が `JSON.stringify` | flushSync のたびに再評価 | **ある** |
| (f) | gate トレース `:1422-1436`, `:2253` | pass 数の二乗（配列コピー＋トレース全体の再直列化） | **無い** |

**(f) の総量は約 1.1MB で、1 秒級には届かない。** 二乗構造が実在することと、それが 2.5 秒の主因であることは別である。**§2.8 の二次項をまるごと (f) に帰属させてはいけない。**

### 2.8 帰属が確定できない（重要・段階 1 の存在理由）

pass 間隔 dt を 4 つのモデルで当てる。10 epoch × 107 点 = 1,070 点。

| モデル | 係数 | 決定係数 |
|---|---|---|
| rc 線形 | dt = 0.334 + 0.0871 × readCount | 0.813 |
| idx 線形 | dt = 7.841 + 0.2845 × passIndex | 0.823 |
| **idx 二次** | dt = 11.428 + 0.0871 × idx + 0.00183 × idx² | **0.849** |
| rc 二次 | dt = 11.136 − 0.0113 × rc + 0.00019 × rc² | 0.848 |

読み取れることは 3 つある。

1. **二次モデルが線形より当たる。** ただし idx 二次と rc 二次が 0.849 / 0.848 で並ぶので、**曲がりの原因が pass 位置なのかノード数なのかは相変わらず分離できない**。rc は idx とほぼ完全に共線（§2.5 の単調列）なので、両方を入れた回帰は rc の係数が負になる
2. **二次項だけでは観測の曲がりを説明しきらない。** idx 二次モデルの二次項は pass 107 で約 21ms だが、その pass の観測は約 47.6ms である。約半分は線形項と定数項が担っている
3. **段階 2 は pass 数を 1 回も減らさない。** probe の世代数（約 53）は探索の構造で決まり、キャッシュを入れても変わらない。したがって **pass に比例する項と pass² 項は段階 2 を入れても丸ごと残る**

結果として **段階 2 の効果は 0〜75% の幅**でしか書けない。

- rc モデルが真なら: prefix 読み 21,466 件のうち大半が消えて 28,100 → 約 7,000 件、2,526ms → **約 630ms**（−75%）
- idx モデルが真なら: 消えるのは (a) の一部だけで **約 2,500ms のまま**（−0%）

**段階 1 の判定基準**は `settleTrace=0/1` の比ではなく、**`data-settle-read-ms ÷ epoch 総時間`** を主指標にする。

**ただしこの比は (a) 単独の割合ではない。** §2.7 (b) の `prefixMeasureEntries.find(...)` は prefix ループの**中**、すなわち `readMeasurements()` の内側にある（実装後 `:1373`）。`data-settle-read-ms` は関数全体を包むので、**(a) DOM 読みと (b) の線形探索の合算**を測っている。(c) revision 導出は `$derived`、(d) `signature()` は settle ループ側、(e) 属性の再評価は flushSync 側、(f) トレースは `recordSettleTrace()` 側なので、いずれも比の外側に立つ。

したがって判定はこう読む。

- **比が高い** → 本丸は (a)+(b) のどちらか。§2.7 (b) を 1,400 万回と見積もっている以上、**比が高くても本丸が (b) である可能性は残る**。(a)/(b) の切り分けは、段階 3-1（`find` の Map 化）を先に単独で当てて `read-ms` の差分を採るのが最短である。それでも足りなければ段階 1 に「`find` の走査回数」を数える属性を足して直接分ける
- **比が低い** → (a) も (b) も本丸でない。(c)〜(f) 側、すなわち段階 3-2（revision 導出の差分化）と §2.7 (e) の診断属性の削減へ資源を振り向ける

`settleTrace=0/1` の差分は (f) の規模を押さえる副指標に落とす。

## 3. 変更案（段階分け）

**段階 1 が第 1 便である。** 段階 2 以降は段階 1 の数字を見てから、やるかどうかを含めて裁定する（分岐 4）。

| 段階 | 内容 | 分類 | 1 epoch の long task 合計 | 最大片 | 主なリスク |
|---|---|---|---|---|---|
| 1 | 帰属の分離（計測のみ） | 計測 | 変えない | 変えない | 無し（製品コード不変） |
| 2 | prefix 計測のキャッシュ（(b) 重複読みの排除） | 性能 | **2,526 → 630〜2,500ms（幅）** | 同左 | 世代キーの取りこぼしで古い寸法が確定 |
| 3 | `find` の Map 化・revision 導出の差分化 | 性能 | 段階 1 の実測で決まる | 同左 | ほぼ無し |
| 4 | カード計測の差分化（(a) 差分 settle） | 性能 | 段階 2 の後に再見積もり | 同左 | **可視カードの内容更新が画面に出ない** |
| 5 | 内側 probe ループの分割（(e)） | 応答性 | 変えない（+数百 ms） | 数十 ms | pass 途中に外部更新が割り込む窓 |
| 6 | 外側 pass 境界の rAF 分割（(d)） | 応答性 | 変えない（+約 17ms） | **2 片にしかならない** | 圧縮 CSS の中間状態が見える |
| 7 | ladder 段の早期打ち切り／壁時計上限 | **(c) 製品緩和** | 上限で固定 | 同左 | **はみ出し・文字切れが残る** |

### 段階 1: 帰属を分離する（製品コードは変更しない）

**狙い**: §2.8 の幅を潰す。段階 2 以降の削減率の分母と、そもそも段階 2 が正しい対象かを確定させる。

やること 4 つ。すべて preview / gate 限定で、production DOM とコードパスは変えない。

1. **`readMeasurements()` 自身の所要を計る観測点。** `partitionDebug || gateFixture != null` ガード（`:1996`, `:2257` の既存前例に倣う）で `data-settle-read-nodes`（epoch 内の累計ノード読み取り件数）と `data-settle-read-ms`（epoch 内の `readMeasurements` 実所要の累計）を可視ルートへ出す。**§2.8 の主指標はこの 2 本である**
2. **gate トレースを URL で切れるようにする。** `gateCapture` の 3 用途（§1.3）のうち、settle トレースの記録（`:1422-1436`, `:2253`）だけを新しい URL パラメータで止められるようにする。**`:1514` の `recentHypocentersClipped` は fixture 側に残す**（視覚 assertion であって性能計測の対象ではない）。既定は現行と同一
3. **prefix probe の key 別内訳を出す。** 現状の `data-prefix-probe-count`（`:2350`）は総数だけで、**分岐 2-B（flood / volcano / quake 限定キャッシュ）の効果を見積もれない**。key 別の件数を出す属性を preview 限定で足す
4. **`data-settle-trace`（`:2253`）をハーネスの観測対象に足す。** §2.2 の「106＋1」を直接観測で確定させる

**判定**（この順に見る）。**`data-settle-read-ms` は (a) と (b) の合算である**（§2.8 末尾）。`readMeasurements()` の内側には prefix ループの DOM 読みと `prefixMeasureEntries.find(...)` の両方が入っているので、比が高いことは「段階 2 が効く」を意味しない。

- `data-settle-read-ms ÷ epoch 総時間` が **7 割以上** → 本丸は (a)+(b) の中にある。ここから (a) と (b) を分けるため、**段階 3-1（`find` の Map 化）を単独で先に当てて `read-ms` の差分を採る**。差分が大きければ本丸は (b) で段階 2 は不要、小さければ (a) が本丸で段階 2 を本命にする（分岐 4）
- 同比が **3 割未満** → (a) も (b) も本丸でない。段階 2 を見送り、段階 3-2（revision 導出の差分化）と §2.7 (c)(e) の削減を優先する案をご主人へ差し戻す
- 中間 → key 別内訳と `settleTrace=0/1` の差分を添えてご主人裁定へ

#### 段階 1 の実装結果（2026-09-09、base `592e5d2`）

確定した識別子は次の 4 本。すべて `StandbyScreen.svelte` の中だけに現れ、`App.svelte` は 1 つも参照しない。

| 識別子 | 種別 | ガード | 意味 |
|---|---|---|---|
| `settleTrace` | URL パラメータ | `gateScenario` 有りのときだけ読む | `0` で settle トレースの**記録と直列化だけ**を止める。既定（未指定）は現行と同一 |
| `data-settle-read-nodes` | DOM 属性 | `partitionDebug \|\| gateFixture != null` | epoch 内の累計ノード読み取り件数。§2.6 の 28,100 件に対応する |
| `data-settle-read-ms` | DOM 属性 | 同上 | epoch 内の `readMeasurements()` 実所要の累計（ミリ秒、小数 3 桁）。**§2.8 の主指標**。関数全体を包むので §2.7 の (a) DOM 読みと (b) `find` 走査の**合算**である |
| `data-prefix-probe-key-counts` | DOM 属性 | 同上 | key 別内訳の JSON。`{"<key>": {"entries": n, "reads": m}}` |

実装上の確定事項が 4 つある。

1. **`gateCapture` の分割は 1 用途だけ**。新しい `settleTraceCapture`（`gateCapture && searchParams.get("settleTrace") !== "0"`）は `recordSettleTrace()` の早期 return と `data-settle-trace` の 2 箇所だけに入れた。fixture 選択（`gateScenario` そのもの）と `:1514` の `recentHypocentersClipped` は `gateCapture` のまま**触っていない**
2. **`data-settle-read-ms` の計測点は `readMeasurements()` の入口と末尾**。`performance.now()` を関数冒頭（ガード成立時のみ）で取り、`measurementPass += 1` の直後に差分を積む。**計測用の集計処理そのものは差分を取った後に走る**ので `read-ms` へ混入しない。production 経路はガードの真偽判定 1 回だけを通る（`performance.now()` を呼ばない）
3. **key 別 `reads` は読み取りループの外で数える**。「登録済み prefix ノードは 1 pass につき必ず 1 回読まれる」という不変量を使い、pass 末尾に `prefixMeasureNodes` を 1 周して key 別に積む。`readMeasurements()` の読み取り内容と順序は 1 行も変えていない
4. **spec §3 段階 1-3 は「件数」だが、実装は `entries` と `reads` の両方を出す**。分岐 2-B の効果は「prefix 読み 21,466 件のうち flood / volcano / quake が何件か」で決まり、epoch 末の entry 件数だけでは答えられない（早く生えた entry ほど読み直し回数が多い）ため。`entries` の総和は `data-prefix-probe-count` と一致する

**受入テスト**: `display/frontend/src/components/__tests__/standby-settle-cost-probe.test.ts`（14 件）。A1 を 6 ケース、A2 を 6 ケース、A13 を 2 ケースで固定した。4 つの契約（既定 props でのガード・トレース属性・**トレース記録そのもの**・`:1514` の非停止）はいずれも、実装を戻すとテストが落ちることを実測で確認している。

**親（Liebe）が CDP で採る手順**は §5.2 の測定文脈に加えて次のとおり。

- `settleTrace=1` 相当（パラメータ無し）と `settleTrace=0` の **2 run** を同じ手順・同じ時間帯で採る。URL は `#legacy-standby-gate?gateScenario=max&contentChurnMs=5000&metadataChurnMode=reparse`、off 側はこれに `&settleTrace=0` を足す
- `.standby` の属性 MutationObserver に `data-settle-read-nodes` / `data-settle-read-ms` / `data-prefix-probe-key-counts` / `data-settle-trace` の 4 本を足す（既存の `data-measurement-pass` / `data-measurement-read-count` はそのまま）
- **off run は開始時に `data-settle-trace` が null であることを確認してから採る**。パラメータの綴り違いや preview 側のキャッシュで `settleTrace=0` が効いていない run を「トレース off」として集計すると、B3 の差分がゼロに見えて (f) の規模を過小に読む
- **B2 の比**は epoch ごとに `(epoch 末の data-settle-read-ms) ÷ (その epoch の long task 所要)`。累計は settle 開始でゼロに戻るので、epoch 末の値がそのまま分子になる。epoch 総時間は §1.1 と同じく long task の duration を使う
- **B4** は `data-settle-trace` の各 entry の `pass` フィールドを数える。`pass: 1` の件数が約 106、`pass: 2` が 1 なら §2.2 が確定する。`settleTrace=0` の run では採れないので on 側の run で採る
- **B3** は 2 run の long task 中央値の差。これが §2.7 (f) の規模の上限になる

### 段階 2: prefix 計測を世代キーでキャッシュする（(b)）

**狙い**: §2.6 の prefix 読み 21,466 件を落とす。

**根拠と、その根拠が通らない範囲**。prefix probe のシェルは `renderPrefixProbe(entry)`（同 `:2220-2243`）で描かれ、`entry` の中身と snapshot に依存する。`plan` にも `selection` にも依存しない。しかし**すべての key がそうではない**。

| key | epoch 中に描画が変わるか | 根拠 |
|---|---|---|
| flood / volcano / quake | **変わらない** | `measurementRange={entry}` を渡すだけ（`:2221-2222`, `:2230-2235`, `:2240-2241`） |
| weather | **変わる** | `weatherPrefixMeasurement(entry)`（`:497-511`）が `weatherMeasurementRanges()`（`:456-467`）を呼び、それが `cachedPagePartitionMeasurement()`（`:667-683`、`prefixMeasurements[id]` を返す）を読む。**weather の probe が 1 枚解決するたび `pageCount` / `pageIndex` が変わり、`stableWeatherMeasurement` のキーが変わって既存 probe が再描画される** |
| tornado | **変わる** | `tornadoPrefixMeasurement(entry)`（`:532-560`）→ `tornadoMeasurementRanges()`（`:512-531`）で weather と同型。weather 側の解決にも連動する |
| briefing | **変わる可能性** | `briefingPartitionRevision`（`:900-904`）が `prefixMeasurements` の briefing 分から導出され、prop で渡る（`:2229`） |

**weather / tornado / briefing で幾何だけのキャッシュを入れると、`pageCount = 1` で測った高さが最終形に対して確定する。** 実機に文字切れが出る失敗モードで、jsdom では捕まえにくい。

**方式（分岐 2-B 推奨）**: キャッシュ対象を **flood / volcano / quake の prefix probe に限る**。それらについて、`prefixMeasurements[id]` に値があり、かつ測ったときの幾何世代キーが現在と一致するなら、そのノードを読まずに現在値を引き継ぐ。

**幾何世代キーに含めるもの**（コードで 1 件ずつ潰した結果）。

| 入力 | 判定 | 根拠 |
|---|---|---|
| `isCompressedGeometry(measurementGeometryStage)` | 含める | `ladder-compressed` が `--space-1`〜`--space-5` と `--edge` / `--gap` を差し替える（`:2247`, `:2522`） |
| `sideMeasureShelfWidthPx` / `centerMeasureShelfWidthPx` | 含める | シェルフ配下の折り返しが変わる |
| `centerTrackWidthPx` / `rightTrackWidthPx` | 含める | `briefingProbeWidth()`（`:945-952`）経由で `measurementWidthPx` に入り、`briefingSideChromeSignature`（`:956`）経由で id にも入る二重管理 |
| `layoutWidthPx` | 含める | 上記と独立に動きうる |
| `viewportHeightPx` | 含める | `briefingPageShellHeight`（`:896`）と `floodWideFixedHeightPx`（`:1227`）が依存する |
| `solvingCenterClusterHidden` | 含める | 中心クラスタの可視が変わるとセンターシェルフの幅が動く（`:1881-1885`） |
| `tornadoPagingContractActive()` | **含めない** | `tornadoItem` の有無と areas 件数だけを見る関数で（`:885-890`）、epoch 内で不変。`prefixMeasureEntries` を見るのは別関数 `tornadoPagingOrProbing()`（`:891-894`）で、probe の描画には入っていない |
| `weatherMeasurementPageFooter` | **含めない** | `weatherChromeSignature` 経由で **id そのもの**に入る（`:689`）。値が変われば別 id になり別ノードとして測られる |
| `plan` / `selection` | **含めない** | `renderPrefixProbe` は `entry` と snapshot しか読まない |

**失敗モード**: 上表に入れ忘れた入力があると、古い寸法で確定して実機にはみ出し・文字切れが出る。§4.2 で各入力を 1 つずつ動かすテストを 1 件ずつ置く。

**もう 1 つの失敗モード**: まだレイアウトされていないノードを 0 で確定してしまう。現行はページ probe 側に「未計測なら `delete nextPrefixes[id]` して保留」の判定がある（同 `:1341-1344`）。**キャッシュ判定は「値が存在するか」で行い、値が無いものは従来どおり毎回読む**。`purpose: "prefix"` の自然高さ側は高さ 0 をキャッシュしない条件を足す。

**効果の見積もり**: 上限（rc モデルが真かつ prefix 364 本の大半が flood / volcano / quake）で 2,526 → 約 630ms、下限（idx モデルが真、または対象 3 key の probe が少数）で **0**。段階 1 の key 別内訳と `read-ms` 比で確定する。

### 段階 3: pass に比例する非 DOM コストを潰す

段階 1 で `read-ms` 比が低く出た場合の主役になりうる。

1. `prefixMeasureEntries.find(...)`（同 `:1317`）をループの外で組んだ `Map<string, PrefixMeasureEntry>` に置き換える。§2.7 (b)
2. `briefingPartitionRevision` / `weatherPartitionRevision`（同 `:900-909`）の導出を差分化する。現状は `prefixMeasurements` 全件の sort と join を毎 pass やり直している。§2.7 (c)
3. `liveBorderBoxHeight()`（同 `:1304-1308`）の `querySelector` 結果を pass 内でキャッシュする

いずれも観測できる挙動を変えない純粋な内部変更である。**単独では配送しない**（効果が測定誤差に埋もれる）。2 は revision の**値**を変えてはならない（変えると partition の再実行契約が壊れる）ので、出力の同一性をテストで固定する。

### 段階 4: カード計測を差分化する（(a) 差分 settle）

**狙い**: 段階 2 のあと残るカード＋固定読み 6,634 件を削る。

**難しさは段階 2 より広い**。prefix probe と違い、シェルフのカードは `renderCard(key, variant, placement, measuring, selected = selection)`（同 `:2118`）で `selection` を既定引数に取る。`selection` は `promoteAndExpand(plan, ...)`（同 `:1142`）由来なので測るたびに変わりうる。さらに**カードの中身は snapshot の内容そのもの**なので、キーを取りこぼすと寸法だけでなく **`stats` の数値更新や `lastReceivedAt` のバッジが画面に出なくなる**。第 2 便の A4 / A5 が固定していた性質である。

**段階 2 を配送して実機で 1 週間問題が出るまで、この段階には着手しない。**

### 段階 5: 内側 probe ループを分割する（(e)）

**狙い**: §2.2 のとおり 107 読みのうち約 106 回が 1 つの内側ループに入っている。**最大片を下げられるのはここだけである。**

内側を N step ごとに rAF で切る。片は数十 ms まで下がり fps も保てる。

**代償**: 「probe の連鎖を同一 pass 内で完結させる」という設計前提（同 `:1860-1862` のコメント）を破る。probe の materialize と `hasPendingProbes()` 判定の間に外部 state 更新が割り込む窓が開く。採るなら「pass の途中で新 epoch が来たら即 supersede する」経路のテストを専用に足す。

**総所要は増える**（rAF 待ちが約 53 回入れば 1 秒近く伸びうる）。分割の粒度 N はその増分と最大片のトレードオフで決める。

### 段階 6: 外側 pass 境界を描画フレームへ譲る（(d)）— **段階 5 の補助**

内側 do-while を抜けた直後（同 `:1866` の直後）と、`nextHidden` が変わって `continue` する経路（同 `:1881-1885`）に `requestAnimationFrame` の 1 回待ちを入れる。後者を入れ忘れると中心クラスタの可視判定が振れる epoch だけ分割されない。

**単独では効かない。** §2.2 のとおり外側は実質 2 周なので、分割しても **約 2,478ms ＋ 約 47ms の 2 片**にしかならない。第 2 便 spec の「外側 5 pass で 1 片 500ms 台」は 107 ÷ 5 の仮定に基づいており、**実データがそれを否定している**。B7（最大片が総時間の 1/3 未満）は段階 6 単独では達成不能で、**段階 5 とセットでのみ意味を持つ**。

**制約**: 譲ると `ladder-compressed` の中間状態が描画されうる（第 2 便 §2.6）。対処は分岐 6。

### 段階 7: ladder 段の早期打ち切り／settle の壁時計上限 — **(c) 製品緩和**

2 案とも「収束を諦めて確定する」ので**表示品質を落とす**。

1. **ladder 段の早期打ち切り**: `MAX_SETTLE_PASSES` を減らす、または probe 予算 `maxProbeSteps`（同 `:1833`）を下げる。パーティション探索が途中で止まり、pager が「1 ページ 1 atom」のフォールバックへ落ちる
2. **壁時計上限**: `settleMeasurements()` に実時間の締切（例 250ms）を入れ、超えたら非収束経路（同 `:1940-1986`）で確定する

**どちらも遅い実機ほど当たる。** Pi は Mac の 4.6〜6.4 倍なので、Mac で当たらない締切が Pi では毎回当たる。`measurementNonConverged` が立つので診断はできるが、ご主人が実際に見る画面が劣化する。

**Liebe は独断しない。** 分岐 5 でご主人へ回す。推奨は不採用。

### やらないこと（本 spec の範囲外）

- 計測シェルフを `display: none` にする、`content-visibility` を掛ける。計測ができなくなるか計測値が変わる
- `MAX_PREFIX_ROWS` の縮小。レイアウト解の質を直接下げる
- 可視ルートの 126 個の診断属性を production から外すこと（§2.7 (e)）。Pi の観測手順（`data-rotation-*` / `data-measurement-*` の CDP 読み出し）がこれに依存しており、外すと過去の観測資材が動かなくなる。**別件として分岐 3 で扱う**
- weather / tornado / briefing の prefix 計測をキャッシュすること。段階 2 の対象外（分岐 2）
- 第 2 便の段階 1（シェルフ凍結）と段階 3（clone 削減）。後者の clone は 8 枚で、§2.6 の 28,100 件に対して無視できる
- `reducedMotion` prop が coordinator へ未配線であること（第 2 便 §2.4）。別バグ候補のまま
- 緊急画面（#18）、Node 側 sweep（#13 段階 2＋4）、`vpwp50ProjectionRejected`（#16）
- ディスプレイ意匠の変更

## 4. テスト

### 4.1 段階 1: 観測点（jsdom）

`display/frontend/src/components/__tests__/standby-settle-cost-probe.test.ts`（新規）。

- 既定 props（`partitionDebug` false・`gateFixture` 未指定＝`App.svelte` と同じ形）で `data-settle-read-nodes` / `data-settle-read-ms` / key 別 prefix 件数の属性が**存在しない**
- gate / preview props では存在し、`data-settle-read-nodes` が epoch 内で単調増加する
- 新 URL パラメータでトレース記録を切ったとき `data-settle-trace` が生えず、`gateScenario` だけのときは従来どおり生える（既定不変の固定）
- 同パラメータで `recentHypocentersClipped` の視覚 assertion（`:1514`）は**止まらない**

**実装済み（2026-09-09、14 ケース）**。上記 4 本に加えて次を固定した。

- **記録そのものが止まること**を属性とは独立に観測する。テンプレート側のガードだけが効いていても属性は消えるので、属性の有無を見るテストは記録が走り続ける退行を捕まえられない。`recordSettleTrace()` が probe step ごとに呼ぶ `coordinator.pendingProbeCount()` を数え、`settleTrace=0` で呼び出し回数が落ちることを確認する
- `:1514` の非停止は `.quakes-card .hypocenter` の `querySelectorAll` 呼び出し回数で直接観測する。jsdom の rect はすべて 0 なので `data-recent-hypocenters-horizontal-clipped` の値では「走った」と「走らなかった」を区別できない
- `data-settle-read-nodes` が epoch 内で単調非減少に増え、**epoch 境界でリセットされる**（次 epoch の途中値が前 epoch の累計より小さい）
- `data-settle-read-ms` が有限の非負値で、epoch の壁時計時間を超えない
- key 別内訳の `entries` の総和が `data-prefix-probe-count` と一致し、`reads` の総和が `data-settle-read-nodes` を超えない
- A13 の grep（§5.1 の運用注記）

### 4.2 段階 2: 幾何世代キーの取りこぼしが無いこと（jsdom）

`standby-prefix-measure-cache.test.ts`（新規）。§3 段階 2 の表の「含める」入力を 1 つずつ動かし、**それぞれで対象 key の prefix が読み直される**ことを固定する。

- 圧縮幾何の切り替え（stage 0 → 2）
- side / center シェルフ幅の変化
- `centerTrackWidthPx` / `rightTrackWidthPx` の変化
- `layoutWidthPx` の変化
- `viewportHeightPx` の変化
- `solvingCenterClusterHidden` の変化
- 上記のどれも動かない pass では、**同じ id の flood / volcano / quake ノードが 2 回読まれない**（ノードの `getBoundingClientRect` を `vi.spyOn` で計数）
- **weather / tornado / briefing の prefix は毎 pass 読まれる**（キャッシュ対象外であることの固定）

### 4.3 段階 2: 保留中のノードをキャッシュしないこと（jsdom）

- 値が未確定（`prefixMeasurements` に entry が無い）のノードは毎 pass 読まれる
- `purpose: "prefix"` で高さ 0 が返るノードはキャッシュされず、次の pass で読み直される

### 4.4 段階 2＋3: 読み取り件数の上限（jsdom）

**機械的な回帰の要**。gate fixture `max` 相当のシナリオで 1 epoch を回し、上限を固定する。

- `data-settle-read-nodes` の epoch 内増分が上限以下（**上限値は段階 1 の実測と分岐 2 の裁定後に確定する**。段階 1 の実測 28,100 件に対して置く）
- `data-measurement-pass` の epoch 内増分も上限（暫定 120）で固定する。§2.5 の probe 世代数が退行で増えたら落ちる
- 段階 3-2 の revision 差分化について、`briefingPartitionRevision` / `weatherPartitionRevision` の**出力文字列が現行と一致する**

### 4.5 段階 5: 内側ループの分割（jsdom）

- N step ごとに rAF が呼ばれる
- rAF 待ちの間に来た新 epoch で旧 epoch が supersede として降りる
- rAF 待ち中に `disposed` が立ったら commit も motion も走らない
- 分割の前後で最終的な `committedPlan` と `committedSelection` が一致する

### 4.6 段階 6: 外側 pass 境界（jsdom）

- 2 pass 以上の settle で rAF が pass 数 − 1 回呼ばれ、`nextHidden` の `continue` 経路でも入る

### 4.7 既存回帰

- `npm --prefix display run build` / `npm --prefix display test`（既存 2,073 件）
- `npm run build` / `npm test` / `npm run test:shuffle` / `npm run typecheck:test`
- 段階 2 は計測結果の持ち回りを変えるので `test:shuffle` を必須にする（AGENTS.md の規定）

### 4.8 実機採取（親が CDP で実走）

子の sandbox は listen 不可なので、`stage0-measure.mjs` の実走は親（Liebe）が担う。子は records に対する `--assert-from` で assertion を検証する。

## 5. 受入条件

### 5.1 機械的に確認できるもの（A）

| # | 条件 | 段階 | 確認方法 |
|---|---|---|---|
| A1 | 既定 props で `data-settle-read-nodes` / `data-settle-read-ms` / key 別 prefix 件数の属性が存在しない。gate / preview props でのみ存在する | 1 | 4.1 |
| A2 | 新 URL パラメータでトレース記録だけが止まり、`:1514` の視覚 assertion と fixture 選択は止まらない | 1 | 4.1 |
| A3 | §3 段階 2 の幾何世代キー「含める」入力すべてで、それぞれ対象 key の prefix 再読が起きる | 2 | 4.2 |
| A4 | weather / tornado / briefing の prefix がキャッシュ対象外であることが固定されている | 2 | 4.2 |
| A5 | 幾何世代キー入力が 1 つも動かない pass で、同じ flood / volcano / quake ノードが 2 回読まれない | 2 | 4.2 |
| A6 | 値が未確定の prefix ノードと高さ 0 のノードはキャッシュされない | 2 | 4.3 |
| A7 | gate `max` 相当の 1 epoch で `data-settle-read-nodes` の増分が上限以下 | 2＋3 | 4.4 |
| A8 | 同 epoch で `data-measurement-pass` の増分が上限（暫定 120）以下 | 2＋3 | 4.4 |
| A9 | `briefingPartitionRevision` / `weatherPartitionRevision` の出力が差分化の前後で一致 | 3 | 4.4 |
| A10 | 内側ループ分割で rAF が N step ごとに呼ばれ、supersede と `disposed` が正しく効き、確定結果が分割前と一致 | 5 | 4.5 |
| A11 | 外側 pass 境界で rAF が pass 数 − 1 回、`continue` 経路でも入る | 6 | 4.6 |
| A12 | build / test（display・root）/ shuffle / typecheck:test が全部成功 | 1〜6 | 4.7 |
| A13 | `display/frontend/src/App.svelte` に差分が無く、production パス（`src/App.svelte` から到達するモジュール）に対する **新 URL パラメータ名・`data-settle-read-nodes`・`data-settle-read-ms`・key 別 prefix 件数の属性名** の grep が 0 件（既存の `settleTrace` 変数名 `:245` `:1821` は対象外） | 1 | `git diff --stat` と grep |

> **A13 の運用（段階 1 実装時に確定）**: `StandbyScreen.svelte` 自身は `App.svelte` から到達する production モジュールなので、新識別子はそこに 1 件は必ず現れる。したがって grep の対象は「段階 1 の allowed_paths を除いた `display/frontend/src` 配下の全 `.ts` / `.svelte`」とする。**新識別子が他のどのモジュールにも漏れていないこと**が守る中身である。`settleTraceCapture`（内部名）は既存の `settleTrace` 変数と別語なので誤検出しない。テストは対象ファイル数が 50 を超えることを先に確認してから 0 件を主張する（空探索を合格と読まないため）。`App.svelte` 側は `partitionDebug` / `gateFixture` / `settleTrace` のいずれも含まないことを別ケースで固定する。
| A14 | `docs/specs/display-design-system.md` と `theme.css` に差分が無い | 1〜6 | `git diff --stat` |

### 5.2 実機（B、環境依存のため CI の合否には使わない）

**測定文脈を固定する。** Chrome 152 headless / 1920×1080 を `Emulation.setDeviceMetricsOverride` で attach 直後に設定（`--window-size` だけでは viewport 高が枠分減る。memory `feedback_headless_viewport_override`）／ preview `#legacy-standby-gate` `gateScenario=max`（59 カード）／`?contentChurnMs=5000&metadataChurnMode=reparse`／採取 60 秒／report に `innerWidth` と `innerHeight` を含める。capture の前に `npm --prefix display run build` を必ず通す（memory `feedback_capture_needs_display_build`）。**before / after は同じ手順・同じ時間帯で採り、after だけを載せない。**

> **B2 の比は下限値として読む。** 分母である preview epoch の long task には、production が払わないコストが乗っている。§2.7 (e) の可視ルート 126 診断属性の再評価、(f) の gate トレース、そして段階 1 で足した 3 属性の直列化である。分母だけが膨らむので **`data-settle-read-ms ÷ epoch 総時間` は production での真の比より小さく出る**。`settleTrace=0` の run を主に据えても落ちるのは (f) だけで、**(e) と段階 1 の 3 属性は残る**。判定が「3 割未満」に落ちたときは、この下限性を踏まえて (e) の寄与を別途見積もってから差し戻す。

| # | 条件 | 段階 | 測定 |
|---|---|---|---|
| B1 | 1 epoch の long task 合計・最大片・`data-settle-read-nodes`・`data-settle-read-ms`・`data-settle-trace` の外側 pass 内訳・prefix probe の key 別内訳が表になっている | 1 | 実 Chrome |
| B2 | **`data-settle-read-ms ÷ epoch 総時間`** が数値で書かれ、§3 段階 1 の判定 3 分岐のどれに落ちたかが明記されている | 1 | 実 Chrome |
| B3 | トレース記録の on / off で 1 epoch の差分が数値で書かれている（(f) の規模の副指標） | 1 | 実 Chrome |
| B4 | §2.2 の「外側 1 周目に約 106 読み」が `data-settle-trace` で裏取りされている | 1 | 実 Chrome |
| B5 | 1 epoch の long task 合計が段階 1 実測から減っている。削減幅の目標値は **B2 の結果を見て段階 2 着手時に確定する** | 2＋3 | 実 Chrome |
| B6 | `data-settle-read-nodes` の epoch 増分が段階 1 実測（28,100 件）から減っている | 2＋3 | 実 Chrome |
| B7 | churn 無指定の 60 秒で long task 0 件・fps 60（現状維持の回帰） | 1〜6 | 実 Chrome |
| B8 | metadata churn 500ms（reparse）の 60 秒で long task 合計が段階 0 実測（10,204ms）を**超えない** | 2〜6 | 実 Chrome |
| B9 | 1 epoch が **複数の task に分割され、最大の 1 片が epoch 総時間の 1/3 未満**。総所要の増加が分割粒度 N ごとに数値で示されている。**段階 6 単独では達成不能なので段階 5＋6 で判定する** | 5＋6 | 実 Chrome |
| B10 | Pi 実機の 1 epoch 所要が段階 1 実測から減っている。**目標値（当初案 4 秒）は B2 が rc 側に倒れた場合にのみ意味を持つ**ので、段階 1 後に確定する | 2＋3 | 実機・CDP |
| B11 | Pi 実機で 10 分以上の連続観察中に Chrome の「応答なし」が出ず、**ローテーションが進み続ける**（`data-rotation-active-key` が観察窓の中で 2 回以上変化し、`data-rotation-position` が更新される。目視の印象ではなく属性の変化で判定する） | 2＋3 | 実機・属性ポーリング |
| B12 | Pi 実機の目視で、実電文 1 通の到着でレイアウトのはみ出し・文字切れが出ない | 2＋4 | 実機・目視 |

### 5.3 スコープ外（本 spec の受入条件に入れない）

- Node 側 sweep の残り（#13 段階 2＋4）
- `vpwp50ProjectionRejected` の診断分離（#16）
- 緊急画面の遷移負荷（#18）
- `reducedMotion` prop の coordinator 未配線（別バグ候補）
- 第 2 便の段階 1（シェルフ凍結）と段階 3（clone 削減）

## 6. 判断分岐

### 分岐 1: 段階 1 のトレース分離をどう実装するか

- **A（推奨）: `gateCapture` の 3 用途（§1.3）を分け、settle トレースの記録だけを新しい URL パラメータで切れるようにする。既定は現行と同一。** `:1514` の `recentHypocentersClipped` は fixture 側に残す。変更は数行で、既存 gate テストの挙動を変えない
- **B: gate fixture を使わず、preview の通常経路で 59 カード相当の state を流す。** 製品コードを 1 行も触らないが、59 カードの state を組む資材が新たに要り、`gateScenario=max` と同じ条件である保証も無くなる
- **C: 分離せず、`data-settle-read-ms` だけで判定する。** §2.8 の主指標はもともとこちらなので、これでも段階 1 の目的は達せられる。トレースの規模（§2.7 (f)）は測れないままになる

### 分岐 2: 段階 2 のキャッシュ対象をどこまで広げるか

- **B（推奨）: flood / volcano / quake の prefix probe に限る。** weather（`:497-511` → `:456-467` → `:667-683`）と tornado（`:532-560` → `:512-531`）は、**probe が 1 枚解決するたび pageIndex / pageCount が変わって既存 probe が再描画される**。briefing も `briefingPartitionRevision`（`:900-904`）で同型。幾何だけのキャッシュを掛けると `pageCount = 1` で測った高さが最終形に対して確定し、**実機に文字切れが出る**。3 key に限れば失敗モードが構造的に起きない
- **A: 全 key を幾何世代キーでキャッシュする。** 削減幅は最大だが上の失敗モードを実装が背負う。**推奨しない**
- **C: weather / tornado / briefing も、それぞれの partition revision を第 2 層の無効化キーにして含める。** 理屈は通るが、revision は probe が解決するたび変わるので実質ほぼ毎 pass 無効化になり、B との差はほとんど無い。**実装の複雑さだけが増える**
- **D: キャッシュを入れず、段階 3 と段階 5＋6 に集中する。** 段階 1 で `read-ms` 比が低く出た場合の正しい選択

**段階 1 の key 別内訳（§3 段階 1-3）が出るまで B の効果は見積もれない。**

### 分岐 3: 可視ルートの 126 診断属性（§2.7 (e)）をどう扱うか

- **A（推奨）: 本 spec では触らない。** Pi の観測手順が `data-rotation-*` / `data-measurement-*` に依存しており、外すと過去の観測資材が動かなくなる。段階 1 の `data-settle-read-ms` で (a) 以外の規模がまとめて分かるので、必要なら別 spec で扱う
- **B: `JSON.stringify` を含む 16 属性だけを `partitionDebug || gateFixture != null` ガードへ移す。** production DOM が変わる。B11 の Pi 観測で使う属性は残るが、他の観測スクリプトが黙って空になる。**production gate（`npm run test:phase6b-production`）の追従が要る**

### 分岐 4: 配送をどこで切るか

- **C（推奨）: 段階 1 だけを第 1 便として配送し、その数字を見てから段階 2 以降をやるかどうかを含めて裁定する。** 根拠は §2.8。段階 2 の効果は 0〜75% の幅があり、`read-ms` 比が低ければ段階 2 は工数に見合わない。段階 1 は preview 限定で製品挙動を変えないので配送リスクが最小
- **A: 段階 1＋2＋3 を 1 便で配送する。** 往復は減るが、効果の分母が確定していない状態で世代キーという取りこぼしリスクのある構造を入れることになる
- **B: 段階 1＋5＋6 を第 1 便（応答性のみ）、段階 2＋3 を第 2 便。** 総量を減らさない段階 5＋6 を先に出すことになり、Pi の 11.6〜16.2 秒がそのまま残る。ただし**最大片は段階 5 でしか下がらない**ので、「止まって見える」ことだけを先に潰したいならこの順もありえる

### 分岐 5: 段階 7（ladder 早期打ち切り／壁時計上限）を採るか — **(c) 製品緩和**

- **A（推奨）: 採らない。** 収束を諦めて確定するとレイアウトが未収束のまま出て、実機にはみ出しと文字切れが残る
- **B: 採る。** 最悪ケースに硬い上限が付く。ただし Pi では常に締切側に当たる可能性があり、**ご主人が毎日見る画面の品質を落とす**。採るなら締切値は段階 2 の後の Pi 実測を採ってから決める

**この分岐は製品挙動を緩める提案なので、Liebe は独断しない。** 段階 1 の実測を添えてご主人へ回す。

### 分岐 6: 段階 5・6 で `ladder-compressed` の中間状態をどう扱うか

- **A（推奨）: 何もしない。** 段階 0 の epoch run では **1,297 観測すべてで `data-measurement-geometry-stage` が `0`** だった。`measurementGeometryStage` が動くのは stage 境界をまたぐ epoch だけで（`StandbyScreen.svelte:1842-1853`）、このシナリオでは 1 度も起きていない。起こらない問題に構造を足さない
- **B: `ladder-compressed` を可視ルートから外し、シェルフ側だけに掛ける。** 中間状態は構造的に見えなくなるが、シェルフ幅は `--edge` / `--gap` を含む式で決まっており、**計測値そのものが変わりうる**
- **C: settle 中は `committedStage` 由来に固定し、確定時に一度だけ切り替える。** `:1842-1853` の「圧縮境界をまたいだら測り直す」ロジックと真正面から衝突する

## 7. 裁定ラベル案（段階ごと、6 要素）

### 段階 1（帰属の分離・計測のみ）— **第 1 便・🌙自走OK・実装済み（2026-09-09）**

> 実装結果と確定した識別子は §3 段階 1 の「段階 1 の実装結果」を参照。受入は A1・A2・A12・A13・A14 が全件緑（jsdom 14 ケース＋ build / typecheck / display 2,087 件）。B1〜B4 は親の実 Chrome 採取待ち。

```
対象: display/frontend/src/components/StandbyScreen.svelte（gateCapture の用途分割と
      preview 限定の観測属性のみ）、
      display/frontend/src/components/__tests__/standby-settle-cost-probe.test.ts（新規）、
      scratchpad/stage0-measure.mjs（観測属性の追加。repo 外）、
      docs/specs/2026-09-09-standby-epoch-settle-cost.md（本 spec）
許容変更: gateCapture の用途分割（fixture 選択と :1514 の視覚 assertion は現行のまま）、
      partitionDebug || gateFixture != null ガード付きの data-settle-read-nodes /
      data-settle-read-ms / prefix probe の key 別件数の追加、テストの新規追加、
      計測スクリプトの観測属性追加、spec への実測結果の追記
禁止変更: settle ループの構造・readMeasurements の読み取り内容と順序・plan / selection /
      solvePlan・production の DOM 属性・App.svelte・theme.css・
      display-design-system.md・package.json / package-lock.json・
      layout-key.ts の除外リスト・既存の settleTrace 変数（:245, :1821）の意味
配送先: main → origin push → GitHub Actions 緑 → personal rebase → private push
      （Pi 反映は不要。preview 限定で production DOM は不変）
ロールバック: git revert <commit>（preview 限定なので production 影響なし）
受入条件: A1・A2・A12・A13・A14 の全件、B1〜B4 が実測で埋まっていること
```

### 段階 2＋3（prefix キャッシュと非 DOM コストの削減）— **分岐 2・分岐 4 の裁定後に配送可**

```
対象: display/frontend/src/components/StandbyScreen.svelte（readMeasurements と
      世代キー計算、revision 導出のみ）、
      display/frontend/src/components/__tests__/standby-prefix-measure-cache.test.ts（新規）、
      docs/specs/2026-09-09-standby-epoch-settle-cost.md
許容変更: flood / volcano / quake の prefix 計測を幾何世代キーでスキップ、
      prefixMeasureEntries の Map 化、revision 導出の差分化、
      liveBorderBoxHeight の querySelector キャッシュ、テストの追加
禁止変更: weather / tornado / briefing の prefix をキャッシュすること・
      測る対象そのもの（読む属性・判定式）・page probe の fit 判定・
      revision の出力文字列・plan / solvePlan / selection・
      MAX_SETTLE_PASSES / MAX_PREFIX_ROWS・可視 DOM の構造と属性・意匠トークン
配送先: main → origin push → GitHub Actions 緑 → personal rebase → private push → Pi 反映
ロールバック: git revert <commit> → npm run build → fqu で Pi 再反映
受入条件: A3〜A9・A12・A14 の全件、B5〜B8 の全件、B10・B11 を Pi で確認、B12 の目視。
      test:shuffle 必須
```

### 段階 4（カード計測の差分化）— **段階 2 の実機 1 週間観察後まで着手しない**

```
対象: display/frontend/src/components/StandbyScreen.svelte、
      display/frontend/src/lib/legacy-standby/layout-key.ts（キー生成の再利用のみ）、
      対応するテスト
許容変更: カードごとの描画入力キーによる読み飛ばし、テストの追加
禁止変更: layout-key.ts の除外リストへの field 追加（第 1 便で固めた分類を性能理由で緩めない）・
      可視 DOM・意匠トークン・solver
配送先: main → origin push → Actions 緑 → personal → Pi
ロールバック: git revert <commit> → 再ビルド → fqu
受入条件: 段階 2 の受入に加え、第 2 便 A4・A5 相当の内容更新テスト
      （stats の桁数不変の数値更新・切断中の lastReceivedAt）が stage 0 と stage 1+ の
      両方で緑であること
```

### 段階 5＋6（内側ループと外側 pass 境界の分割）— **分岐 4・分岐 6 の裁定後**

```
対象: display/frontend/src/components/StandbyScreen.svelte（settleMeasurements の
      内側 do-while と pass 境界のみ）、対応するテスト
許容変更: 内側 probe ループへの N step ごとの rAF 挿入、
      内側 do-while 脱出直後と nextHidden の continue 経路への rAF 1 回待ちの挿入、
      supersede 経路のテスト追加
禁止変更: probe の materialize 順序・commit / motion の呼び出し順・
      確定後の committedPlan / committedSelection の内容・可視 DOM・意匠トークン
配送先: main → origin push → Actions 緑 → personal → Pi
ロールバック: git revert <commit> → 再ビルド → fqu
受入条件: A10・A11・A12・A14、B7、B9（段階 5＋6 で判定）、Pi で B11
```

### 段階 7（ladder 早期打ち切り／壁時計上限）— **(c) 製品緩和・ご主人裁定まで配送不可**

分岐 5 が A（不採用）に倒れた場合は起票しない。B に倒れた場合のみ、段階 2 の後の Pi 実測を添えて別途ラベルを起こす。

## 8. 参照

- 第 2 便 spec: `docs/specs/2026-09-08-standby-resettle-residual-load.md`（HEAD `b98caed`）。§2.5 の settle ループ構造、§3.2 の rAF 分割、分岐 2〜5 は本 spec が引き継いでいる（§3.2 の「外側 5 pass で 1 片 500ms 台」は本 spec §2.2 で訂正）
- 第 1 便 spec: `docs/specs/2026-09-07-standby-sweep-hot-path.md`
- 段階 0 の生データ: scratchpad `stage0-results-2026-09-08T12-41-04.json`（`rawLongTasks` / `rawObservations`）、報告 `stage0-report.md`、スクリプト `stage0-measure.mjs`
- 実装の中心: `display/frontend/src/components/StandbyScreen.svelte`
  - `readMeasurements()` `:1309-1405`（prefix ループ `:1316-1370`、固定読み `:1371-1402`、`measurementReadCount` `:1403`、`measurementPass` `:1404`）
  - `liveBorderBoxHeight()` `:1304-1308`、`signature()` `:1406-1421`
  - `settleMeasurements()` `:1815-1988`（外側ループ `:1829`、内側 do-while `:1830-1866`、圧縮境界の再読 `:1842-1853`、`nextHidden` の continue `:1881-1885`、非収束経路 `:1940-1986`）
  - `recordSettleTrace()` `:1422-1436`、`gateCapture` `:76-77`、`recentHypocentersClipped` `:1514`、`data-settle-trace` `:2253`、`settleTrace` 宣言 `:245` / リセット `:1821`
  - probe 登録 `prefixHeight()` `:684-710` / `pagePartitionProbe()` `:711-762`、`cachedPagePartitionMeasurement()` `:667-683`
  - weather / tornado の probe 描画 `weatherMeasurementRanges()` `:456-467` / `weatherPrefixMeasurement()` `:497-511` / `tornadoMeasurementRanges()` `:512-531` / `tornadoPrefixMeasurement()` `:532-560`
  - `tornadoPagingContractActive()` `:885-890`、`briefingPageShellHeight` `:896`、`briefingPartitionRevision` `:900-904`、`weatherPartitionRevision` `:905-909`、`briefingProbeWidth()` `:945-952`、`briefingSideChromeSignature` `:956`、`floodWideFixedHeightPx` `:1227`、`selection` `:1142`
  - prefix シェルフの描画 `:2410-2411`（side）/ `:2446-2447`（center）、`renderPrefixProbe` snippet `:2220-2243`、`renderCard` snippet `:2118`
  - 可視ルートの属性 `:2246-2373`、`ladder-compressed` `:2247` / CSS `:2522`、`data-prefix-probe-count` `:2350`
  - `prefixMeasureEntries = []` `:2004`
- `epoch-coordinator.ts:72-75`（`drainProbes`）
- memory: `feedback_headless_viewport_override`（viewport override 必須）、`feedback_capture_needs_display_build`（capture 前の display build）、`feedback_probe_target_verification`（対象の実在と失敗件数を先に確定）、`feedback_spec_edit_classification`（(c) 製品緩和はご主人裁定）
