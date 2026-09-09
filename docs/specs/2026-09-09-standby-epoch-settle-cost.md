# 待機画面 1 epoch の settle コスト削減 spec（GitHub Issue #15 第 3 便）

> **状態**: 段階 1 配送・実測反映（2026-09-09）。**段階 2 は計測で否定され見送り。** **段階 2'（外側 77% の帰属分離）は実装済み・実機実測待ち**で、観測属性 5 区分／8 属性と受入テストが入り A2b・A12・A13・A14 は緑。B4b・B4c の採取手順は §4.8' にある。§6 の分岐がご主人裁定待ちで、うち分岐 5（段階 7）は (c) 製品緩和に該当する。
>
> **基準 SHA**: `b98caed5f677c61d554d7fe79a2a158c872b157f`（worktree `~/dev/fleq-layout`、branch main）。第 2 便（段階 0 の計測ハーネスと `data-layout-motion-captured`）が入った状態。
>
> **前提**: 本 spec は第 2 便 `docs/specs/2026-09-08-standby-resettle-residual-load.md` の続きで、その **§1.3「1 epoch のコスト」だけ**を扱う。同 spec の段階 1（シェルフ凍結）は段階 0 の実測（shelfMutations = 0）で見送り裁定済み。ブラウザ側だけを対象とし、Node 側の周期（#13 段階 2＋4）と `vpwp50ProjectionRejected` の診断分離（#16）は範囲外。
>
> **意匠**: 本 spec は `docs/specs/display-design-system.md` のトークンにも header/footer 統一 spec にも触れない。**確定後の表示はどの段階でも不変**である。段階 5・6 だけが「確定に至る過程に中間フレームが出うる」という形で見え方に触れる。錨カードの参照は不要。
>
> **改訂履歴**: 2026-09-09 起草 → 同日 独立レビュー反映（GO with fixes、分岐 2 を A→B・段階 5/6 の入れ替え・算術訂正）→ 同日 **段階 1 実測反映（B2 = 0.179 で段階 2 見送り、段階 2' を新設、§10 に再構成材料）** → 同日 **段階 2' 実装（観測属性 5 区分／8 属性・計数器は非リアクティブな素の `let`・採取手順 §4.8' を追加）**。
>
> **見立ての位置づけ（重要）**: §2 の pass 内訳は `data-measurement-pass` / `data-measurement-read-count` の実測時系列とコード読了の突き合わせで**確定**した。一方 §2.7 のとおり、**2,526ms の中身がノード読み取りなのか pass 位置とともに増える別の項なのかは、段階 0 のデータからは分離できない**（rc 線形 0.813 / idx 線形 0.823 / idx 二次 0.849 / rc 二次 0.848 が並ぶ）。起草時点では段階 2 の効果を 0〜75% の幅でしか書けなかった。**段階 1 の実測（§9）でこの幅は潰れ、答えは「DOM 読みは 18% だけ」だった**（§2.9）。残る約 77% の内訳は依然として未知で、それを掘るのが段階 2' である。
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

起草時点では **段階 2 の効果は 0〜75% の幅**でしか書けなかった。段階 1 の実測（§9）でこの幅は潰れた。

### 2.9 段階 1 の実測が出した答え（確定）

`data-settle-read-ms ÷ epoch の long task 合計` の中央値は **0.179**（read-ms 413.8ms / long task 2,291.5ms、完全 epoch 10 件）。§3 段階 1 の判定 3 分岐のうち **「3 割未満」に落ちた**。

| 区分 | ms（1 epoch 中央値） | 比 | 中身 |
|---|---|---|---|
| `readMeasurements()` の内側 | **414** | **18%** | §2.7 (a) DOM 読み ＋ (b) `find` の O(n²) |
| gate トレース（production には無い） | **114** | **5%** | §2.7 (f)。trace on / off の差 |
| **`readMeasurements()` の外側** | **約 1,764** | **約 77%** | §2.7 (c)(d)(e) と、下の §2.10 |

- **rc モデルも idx モデルも「DOM 読みが主因」という含意では否定された。** ノード読み 28,100 件は算術どおり実在するが、それに費やしているのは 414ms しかない
- **B2 は下限値である。** 分母の preview epoch には production が払わないコスト（(e) の可視ルート 126 診断属性、(f) のトレース、段階 1 で足した 3 属性）が乗る。ただし (f) が実測 5% と小さいので、(e) を全部差し引いても 18% が 3 割に届く余地は薄い

### 2.10 外側 77% の最有力候補（推測・段階 2' で確定させる）

コードを追うと、**prefix probe の「描画」が pass ごとにパーティション探索をやり直す**構造が見つかる。

- `renderPrefixProbe` の weather 分岐は `measurement={weatherPrefixMeasurement(entry)}`（`:2227`）、tornado 分岐は `tornadoPrefixMeasurement(entry)`（`:2239`）を**テンプレート式として**呼ぶ
- `weatherPrefixMeasurement()`（`:497-511`）は `weatherMeasurementRanges()`（`:456-467`）を呼び、それが `sequentialPartitionRanges()`（`page-partition.ts:264`）で候補を先頭から線形に走査する。各 step で `rangeFor()` が tails 配列を組み、`cachedPagePartitionMeasurement()`（`:667-683`）が `prefixMeasureId()` で文字列 id を組み立てて `prefixMeasurements` を引く
- `tornadoPrefixMeasurement()`（`:532-560`）は `weatherMeasurementRanges()` に加えて `tornadoMeasurementRanges()`（`:512-531`）を呼び、後者は**tornado の各 range × weather の全 range** の二重ループで `cachedPagePartitionMeasurement()` を呼ぶ
- `stableWeatherMeasurement()`（`:515-521`）が memo するのは**結果オブジェクトの同一性だけ**で、キーを組むために ranges の計算自体は毎回走る
- これらは `prefixMeasurements` を読むので、**`readMeasurements()` が毎 pass それを再代入するたびに全 prefix 項目の式が再評価される**

段階 1 実測の key 別内訳では **tornado 45.4% ＋ weather 40.4% ＝ prefix entry の 86%**（1 epoch あたり tornado 180 件 / weather 154 件）である。334 項目 × 107 pass ≈ **35,700 回のパーティション探索**が 1 epoch で走っている計算になる。

**これは推測であって計測ではない。** 段階 2' で `weatherMeasurementRanges` / `tornadoMeasurementRanges` の呼び出し回数と累計 ms を直接採る。

## 3. 変更案（段階分け）

**段階 1 は配送済みで、実測が §9 に出ている。** その結果、**段階 2 は見送りになった**。次の第 2 便候補は段階 2'（計測のみ）である。

| 段階 | 内容 | 分類 | 1 epoch の long task 合計 | 状態 |
|---|---|---|---|---|
| 1 | 帰属の分離（計測のみ） | 計測 | 変えない | **配送済み・実測 §9** |
| 2 | prefix 計測のキャッシュ | 性能 | **上限 −2%** | **見送り（計測で否定）** |
| **2'** | **外側 77% の帰属分離（計測のみ）** | **計測** | **変えない** | **第 2 便候補** |
| 3 | `find` の Map 化・revision 導出の差分化 | 性能 | 3-1 は 18% の内数、3-2 は外側 | 段階 2' の後 |
| 4 | カード計測の差分化 | 性能 | 18% の内数（上限 −4%） | 優先度低下 |
| 5 | 内側 probe ループの分割 | 応答性 | 変えない（総所要は増える） | 最大片を下げる唯一の手 |
| 6 | 外側 pass 境界の rAF 分割 | 応答性 | 変えない | 段階 5 の補助 |
| 7 | ladder 早期打ち切り／壁時計上限 | **(c) 製品緩和** | 上限で固定 | 分岐 5・裁定待ち |

### 段階 1: 帰属を分離する（製品コードは変更しない）

**狙い**: §2.8 の幅を潰す。段階 2 以降の削減率の分母と、そもそも段階 2 が正しい対象かを確定させる。**実施済み。結果は §9。**

やること 4 つ。すべて preview / gate 限定で、production DOM とコードパスは変えない。

1. **`readMeasurements()` 自身の所要を計る観測点。** `partitionDebug || gateFixture != null` ガード（`:1996`, `:2257` の既存前例に倣う）で `data-settle-read-nodes`（epoch 内の累計ノード読み取り件数）と `data-settle-read-ms`（epoch 内の `readMeasurements` 実所要の累計）を可視ルートへ出す。**§2.8 の主指標はこの 2 本である**
2. **gate トレースを URL で切れるようにする。** `gateCapture` の 3 用途（§1.3）のうち、settle トレースの記録（`:1422-1436`, `:2253`）だけを新しい URL パラメータで止められるようにする。**`:1514` の `recentHypocentersClipped` は fixture 側に残す**（視覚 assertion であって性能計測の対象ではない）。既定は現行と同一
3. **prefix probe の key 別内訳を出す。** 現状の `data-prefix-probe-count`（`:2350`）は総数だけで、**分岐 2-B（flood / volcano / quake 限定キャッシュ）の効果を見積もれない**。key 別の件数を出す属性を preview 限定で足す
4. **`data-settle-trace`（`:2253`）をハーネスの観測対象に足す。** §2.2 の「106＋1」を直接観測で確定させる

**判定**（この順に見る）。

- `data-settle-read-ms ÷ epoch 総時間` が **7 割以上** → (a) が本丸。段階 2 を本命として進める（分岐 4）
- 同比が **3 割未満** → (a) は本丸でない。段階 2 を見送り、段階 3 と §2.7 (c)(e) の削減を優先する案をご主人へ差し戻す
- 中間 → key 別内訳と `settleTrace=0/1` の差分を添えてご主人裁定へ

**実測は 0.179 で「3 割未満」に落ちた（§9）。** この spec は以降その前提で書かれている。

### 段階 2: prefix 計測を世代キーでキャッシュする（(b)）— **見送り（段階 1 の計測で否定）**

**狙い（当初）**: §2.6 の prefix 読み 21,466 件を落とす。

**見送りの根拠（確定）**。段階 1 の実測（§9）で 2 つが分かった。

1. **`readMeasurements()` の内側は epoch 全体の 18% しかない。** prefix 読み 21,466 件を 1 件残らず消しても、上限は 18% × (21,466 ÷ 28,100) = **13.7%**
2. **キャッシュしてよい key は 3 つだけで、その読みは全体の 10.9%** である（flood 824 ＋ volcano 1,212 ＋ quake 1,018 = 3,054 件 / 28,100 件）。分岐 2-B の効果上限は 18% × 10.9% = **約 2.0%**（1 epoch 2,291ms のうち約 45ms）。しかも各ノードの初回読みは必ず要るので実際はこれより小さい

**2% のために「古い寸法で確定して実機に文字切れが出る」失敗モードを背負う理由が無い。** 段階 2 は見送る（分岐 2 も同時に閉じる）。

以下の分析は、**将来 prefix 計測に手を入れる別 spec が出たときの前提資料として残す**。とくに weather / tornado / briefing がキャッシュ不可である理由は、段階 2' の設計にもそのまま効く。

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

**効果の見積もり（段階 1 実測で確定）**: 分岐 2-B で **上限 2.0%（約 45ms）**。全 key を対象にしても上限 13.7%。**見送り。**

### 段階 2': 外側 77% を帰属分離する（計測のみ・製品コードの挙動は変えない）— **実装済み（2026-09-09）・実測待ち**

> **実装状態**: 観測属性 5 区分／8 属性と `standby-settle-attribution-probe.test.ts` を投入済み。A2b・A12・A13・A14 は緑。**B4b・B4c は親の CDP 実走待ち**で、採取手順は §4.8' に置いた。
>
> 起草時の想定と 1 点違ったところがある。**計数器を `$state` にできない**。`weatherMeasurementRanges` / `tornadoMeasurementRanges` / `solvePlan` と 2 つの partition revision は `$derived` またはテンプレート式の中で走るので、そこで signal を書くと Svelte 5 が `state_unsafe_mutation` を投げる。加えて 1 epoch に数百回の signal 書き込みは可視ルートを無効化し、**測ろうとしている数値そのものを膨らませる**。そこで素の `let` に貯め、reaction の外（`recordSettleReadCost` の末尾と settled publish）で 1 本の `$state` ミラーへ写している。§3 の「観測自体が観測対象を汚さない形にする」の具体化であって、設計方針の変更ではない。

**狙い**: §2.9 で「1 epoch の 77%（約 1,764ms）が `readMeasurements()` の外側にある」ことは確定したが、**その中の内訳は未知**である。段階 1 と同じ型（preview / gate 限定の累計 ms 属性）で 1 段掘る。ここを外すと、次の性能改修が段階 2 と同じく「上限 2% の対象」を掘り当てる。

**採る 5 区分**（すべて `partitionDebug || gateFixture != null` ガード、epoch 内の累計 ms と呼び出し回数）。ms と `-calls` を数えると **DOM 属性は 8 本**になる。以降「5 区分」と「8 属性」は同じものを指す。

| 属性 | 何を計るか | 対応する §2.7 / §2.10 |
|---|---|---|
| `data-settle-partition-ms` / `-calls` | `weatherMeasurementRanges()`（`:456-467`）と `tornadoMeasurementRanges()`（`:512-531`）の中で費やした時間と呼び出し回数 | §2.10 の最有力候補 |
| `data-settle-revision-ms` | `briefingPartitionRevision` / `weatherPartitionRevision`（`:900-909`）の導出 | §2.7 (c) |
| `data-settle-signature-ms` / `-calls` | `signature()`（`:1406-1421`）の全件 `localeCompare` sort と結合 | §2.7 (d) |
| `data-settle-flush-ms` | 内側ループの `flushSync()`（`:1863`）と圧縮境界の `flushSync()`（`:1845`）、および `await tick()`（`:1830`, `:1846`）の前後差 | §2.7 (e)。Svelte の再レンダと 126 診断属性の直列化がここに入る |
| `data-settle-solve-ms` / `-calls` | `solvePlan()` の実行時間と回数（`plan` の pull・`nextCenterClusterHidden` の `unresolved` から） | 未分類の残余 |

**設計上の注意**（段階 1 の実装で学んだこと）。

- **観測自体が観測対象を汚さない形にする。** JSON 文字列の属性は毎観測で読むと settle の long task に乗る。段階 1 と同じく、`data-measurement-settled` が true へ倒れた直後の別 task で epoch 末の値を 1 回だけ採る
- **計測点は「時刻の差」だけを足す。** `performance.now()` の 2 回呼びを関数の入口と出口に置く形に限り、ロジックの順序も分岐も変えない。ガードが false のときは加算そのものを行わない
- **`flushSync` の計測は上位からの包み込みになる**ので、他の 4 本と重複計上しうる。**重複を承知の上で「包含関係のある内訳」として報告し、差し引き算はレポート側でやる**。5 本の合計が 77% を超えても異常ではない

**判定**（段階 2' の後に決めること）。

- 単一の項目が **外側の 5 割以上** を占める → その項目に対する局所修正を段階 3' として起票する。§2.10 が当たっていれば `weatherMeasurementRanges` の pass 内メモ化（334 項目が同じ (placement, rows, footer) を何百回も計算し直している疑い）が候補になる
- どの項目も 3 割に届かず散っている → **局所修正では届かない**。§10 の再構成材料へ送る
- `data-settle-flush-ms` が支配的 → 分岐 3-B（診断属性の production ガード）の価値が上がるので、その裁定をご主人へ回す

**この段階は製品の挙動を 1 つも変えない。** 段階 1 と同じ理由で配送リスクが最小である。

### 段階 3: pass に比例する非 DOM コストを潰す

段階 1 の実測で、3 項目の位置づけが分かれた。

| # | 内容 | 効果の上限 | 状態 |
|---|---|---|---|
| 3-1 | `prefixMeasureEntries.find(...)`（同 `:1317`）を `Map<string, PrefixMeasureEntry>` に置き換える。§2.7 (b) | **18% の内数**。`find` は `readMeasurements()` の中にあり、その 414ms を DOM 読みと分け合っている。単体では数十 ms | 段階 2' の内訳を待つ必要は無いが、単独配送はしない |
| 3-2 | `briefingPartitionRevision` / `weatherPartitionRevision`（同 `:900-909`）の導出を差分化。§2.7 (c) | **外側 77% の内数**。規模は段階 2' の `data-settle-revision-ms` で確定する | 段階 2' の後 |
| 3-3 | `liveBorderBoxHeight()`（同 `:1304-1308`）の `querySelector` を pass 内でキャッシュ | 18% の内数。48 × 107 = 5,136 回ぶん | 3-1 と同じ便 |

いずれも観測できる挙動を変えない純粋な内部変更である。**単独では配送しない**（効果が測定誤差に埋もれる）。3-2 は revision の**値**を変えてはならない（変えると partition の再実行契約が壊れる）ので、出力の同一性をテストで固定する。

### 段階 4: カード計測を差分化する（(a) 差分 settle）

**狙い**: カード＋固定読み 6,634 件を削る。**段階 1 の実測で優先度は下がった**——6,634 件は 28,100 件の 23.6% で、その全部を消しても上限は 18% × 23.6% = **約 4%** である。

**難しさは段階 2 より広い**。prefix probe と違い、シェルフのカードは `renderCard(key, variant, placement, measuring, selected = selection)`（同 `:2118`）で `selection` を既定引数に取る。`selection` は `promoteAndExpand(plan, ...)`（同 `:1142`）由来なので測るたびに変わりうる。さらに**カードの中身は snapshot の内容そのもの**なので、キーを取りこぼすと寸法だけでなく **`stats` の数値更新や `lastReceivedAt` のバッジが画面に出なくなる**。第 2 便の A4 / A5 が固定していた性質である。

**段階 2 が見送りになったので、このゲートは「段階 2' の内訳で外側に手を入れ、実機で 1 週間問題が出ないこと」へ読み替える。** 上限 4% に対して失敗モードが重いので、着手は最後で良い。

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

### 4.2' 段階 2': 観測点（jsdom）

`standby-settle-attribution-probe.test.ts`（**投入済み 2026-09-09**、10 ケース）。段階 1 の `standby-settle-cost-probe.test.ts` と同型。

- 既定 props で段階 2' の 5 本（`data-settle-partition-ms` / `-calls`、`-revision-ms`、`-signature-ms` / `-calls`、`-flush-ms`、`-solve-ms` / `-calls`）が**存在しない**
- gate / preview props では存在し、epoch 内で単調増加する
- ガードが false のとき、計測用の `performance.now()` 呼び出しが 1 回も起きない（`vi.spyOn(performance, "now")` で計数）
- 各 `-calls` が対応する関数の実呼び出し回数と一致する（`vi.spyOn` で突き合わせ）

### 4.2 段階 2: 幾何世代キーの取りこぼしが無いこと（jsdom）— **見送りにつき着手しない**

`standby-prefix-measure-cache.test.ts`（新規）。§3 段階 2 の表の「含める」入力を 1 つずつ動かし、**それぞれで対象 key の prefix が読み直される**ことを固定する。

- 圧縮幾何の切り替え（stage 0 → 2）
- side / center シェルフ幅の変化
- `centerTrackWidthPx` / `rightTrackWidthPx` の変化
- `layoutWidthPx` の変化
- `viewportHeightPx` の変化
- `solvingCenterClusterHidden` の変化
- 上記のどれも動かない pass では、**同じ id の flood / volcano / quake ノードが 2 回読まれない**（ノードの `getBoundingClientRect` を `vi.spyOn` で計数）
- **weather / tornado / briefing の prefix は毎 pass 読まれる**（キャッシュ対象外であることの固定）

### 4.3 段階 2: 保留中のノードをキャッシュしないこと（jsdom）— **見送りにつき着手しない**

- 値が未確定（`prefixMeasurements` に entry が無い）のノードは毎 pass 読まれる
- `purpose: "prefix"` で高さ 0 が返るノードはキャッシュされず、次の pass で読み直される

### 4.4 段階 3: 読み取り件数の上限と revision の同一性（jsdom）

**機械的な回帰の要**。gate fixture `max` 相当のシナリオで 1 epoch を回し、上限を固定する。

- `data-settle-read-nodes` の epoch 内増分が **28,100 件以下**（段階 1 の実測値。段階 3 は読み件数を増やさないことの回帰）
- `data-measurement-pass` の epoch 内増分も上限（暫定 120）で固定する。§2.5 の probe 世代数が退行で増えたら落ちる
- 段階 3-2 の revision 差分化について、`briefingPartitionRevision` / `weatherPartitionRevision` の**出力文字列が現行と一致する**
- 段階 2' の 5 本の属性が、段階 3 の前後で「合計が減る／件数は不変」であること

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

### 4.8' 段階 2' の採取手順（親が CDP で実走・B4b / B4c）

測定文脈は §5.2 の固定条件をそのまま使う（Chrome 152 headless、`Emulation.setDeviceMetricsOverride` で 1920×1080、preview `#legacy-standby-gate` `gateScenario=max`、`?contentChurnMs=5000&metadataChurnMode=reparse`、60 秒、採取前に `npm --prefix display run build`）。**ただし段階 2' では URL に `&settleTrace=0` を必須で足す。**

`gateScenario` が付くと `gateCapture`（`StandbyScreen.svelte:76-77`）が true になり、`settleTraceCapture`（`:86`）も既定で true になる。すると `recordSettleTrace`（`:1584`）が **probe step ごとに `signature()` を余分に呼ぶ**。この呼び出しは production には存在しないので、`settleTrace=0` を付けないと `data-settle-signature-ms` / `-calls` と `data-settle-flush-ms` が gate 専用のコストで膨らみ、B4c の判定を歪める。段階 1 の実測で on / off の差は 114.0ms（epoch の 5.0%）だった（§9 B3）。**分母も揃える**: `outer_total` は §9 の **off 列**（long task 合計 2,177.5ms、read-ms 407.7ms）を基準にする。

**計測スクリプトに足す属性（5 区分／8 属性）**。段階 1 の 3 属性と同じく `data-measurement-settled` が true へ倒れた**直後の別 task（`setTimeout` 0）で epoch 末の値を 1 回だけ読む**。どれも epoch 内で単調に伸びるだけなので、MutationObserver の `attributeFilter` に入れて毎観測で読む必要はない（入れると観測コストが long task に乗る。§9 の計測手法メモ）。

| 属性 | 型 | 意味 |
|---|---|---|
| `data-settle-partition-ms` / `-calls` | ms（小数 3 桁）/ 整数 | `weatherMeasurementRanges()` ＋ `tornadoMeasurementRanges()` の累計と回数 |
| `data-settle-revision-ms` | ms | `briefingPartitionRevision` ＋ `weatherPartitionRevision` の導出 |
| `data-settle-signature-ms` / `-calls` | ms / 整数 | `signature()` の累計と回数 |
| `data-settle-flush-ms` | ms | 内側 probe ループの `await tick()` ×2 と `flushSync()` ×2 |
| `data-settle-solve-ms` / `-calls` | ms / 整数 | `solvePlan()` の累計と回数 |

**包含関係と差し引きの式**。`flush` は上位から他を包む。`signature` は `plan` を読むので、その pass で `plan` が無効化されていれば `solve` を内側に含む。`solve` は `weather` / `tornado` の 2 関数を含まない（`candidates()` は `measured()` しか読まない）。

**`flush_ms` は上限値である。** `publishSettleAttribution()`（`:1444`）が pass ごとに `$state` ミラーを書くので、8 属性の再直列化が**次の flush に乗る**。つまり `flush_ms` は自分の結論を一部作っている。診断属性の直列化コストを含んだ上限として読み、「flush 支配」の判定に落ちたときは分岐 3-B の対象に段階 1・2' の観測属性自身も含めて数える。

**計測されない `flushSync` が 4 箇所ある**（すべて残余に入る）。hidden 集合が変わった直後（`:2074`）、post-commit の drain 後（`:2115`）、確定 commit の `flushSync(cb)` 2 箇所（`:2091`, `:2147`）、`publishSettledGeometry` の `flushSync(cb)`（`:1925`）。いずれも外側 pass 境界に 1 回ずつしか出ないので内側ループの 107 回に比べれば小さいはずだが、**残余が大きく出たらここを疑う**のが最初の一手である。

**3 番目の partition 探索が帰属の外にある。** `floodWidePartitionInfeasible`（`:1166-1174`）は `sequentialPartitionRanges` を呼ぶが、`renderFloodWide`（`:1304`）経由のテンプレート経路なので **partition にも solve にも入らない**（solver 側の `floodWideVisibleAllowed` は `floodWideProbeResult` を読むだけで探索しない）。flood の探索コストは残余に落ちる。したがって:

```
outer_total      = long_task_total − data-settle-read-ms          （§2.9 の約 1,764ms）
flush_exclusive  = data-settle-flush-ms
                   − (partition_in_flush + revision_in_flush + solve_in_flush)
```

`*_in_flush` は epoch 内で直接は割れない。**割らずに次の 2 通りの合計で上下を挟む**のが実用的である。

```
上限側（重複を許す合計）= partition_ms + revision_ms + signature_ms + flush_ms + solve_ms
下限側（flush を代表に取る）= flush_ms + max(0, signature_ms − solve_ms) + 外側に出た分
残余（未帰属）            = outer_total − flush_ms − max(0, signature_ms − solve_ms)
```

**5 区分の合計が outer_total を超えても異常ではない**（§3 段階 2' の但し書き）。報告では上限側・下限側・残余の 3 数を並べ、包含している項目を明示する。

**依存集合の注記**: 2 本の revision と `plan` の `$derived` は body で `settleCostProbe` を読むので、依存に `partitionDebug` / `gateFixture` が加わる。どちらも実行時に変化しない props なので再計算のタイミングは変わらない。

**判定 3 分岐（B4c、§3 段階 2' の再掲）**。分母は `outer_total`。

| 観測 | 判定 | 次の一手 |
|---|---|---|
| 単一項目が **5 割以上** | 局所修正が届く | その項目を段階 3' として起票。`partition` が来たら `weatherMeasurementRanges` の pass 内メモ化が第 1 候補 |
| どの項目も **3 割未満**で散る | 局所修正では届かない | §10 の再構成材料へ送る |
| `flush_ms` が支配的 | 再レンダと 126 診断属性が主因 | 分岐 3-B（診断属性の production ガード）の価値が上がる。ご主人裁定へ回す |

`-calls` は「1 epoch あたり何回走ったか」の裏取りに使う。§2.10 の見積もり（334 項目 × 107 pass ≈ 35,700 回）と `data-settle-partition-calls` が桁で合わなければ、**見立ての側を疑う**。

## 5. 受入条件

### 5.1 機械的に確認できるもの（A）

| # | 条件 | 段階 | 確認方法 |
|---|---|---|---|
| A1 | 既定 props で `data-settle-read-nodes` / `data-settle-read-ms` / key 別 prefix 件数の属性が存在しない。gate / preview props でのみ存在する | 1 | 4.1 |
| A2 | 新 URL パラメータでトレース記録だけが止まり、`:1514` の視覚 assertion と fixture 選択は止まらない | 1 | 4.1 |
| A2b | 既定 props で段階 2' の 5 本が存在せず、ガード false のとき `performance.now()` が 1 回も呼ばれない。gate / preview props では存在し、`-calls` が実呼び出し回数と一致する | 2' | 4.2' |
| A3 | §3 段階 2 の幾何世代キー「含める」入力すべてで、それぞれ対象 key の prefix 再読が起きる | 2（見送り） | 4.2 |
| A4 | weather / tornado / briefing の prefix がキャッシュ対象外であることが固定されている | 2 | 4.2 |
| A5 | 幾何世代キー入力が 1 つも動かない pass で、同じ flood / volcano / quake ノードが 2 回読まれない | 2 | 4.2 |
| A6 | 値が未確定の prefix ノードと高さ 0 のノードはキャッシュされない | 2 | 4.3 |
| A7 | gate `max` 相当の 1 epoch で `data-settle-read-nodes` の増分が 28,100 件以下 | 3 | 4.4 |
| A8 | 同 epoch で `data-measurement-pass` の増分が 107（段階 1 実測）以下 | 3 | 4.4 |
| A9 | `briefingPartitionRevision` / `weatherPartitionRevision` の出力が差分化の前後で一致 | 3-2 | 4.4 |
| A10 | 内側ループ分割で rAF が N step ごとに呼ばれ、supersede と `disposed` が正しく効き、確定結果が分割前と一致 | 5 | 4.5 |
| A11 | 外側 pass 境界で rAF が pass 数 − 1 回、`continue` 経路でも入る | 6 | 4.6 |
| A12 | build / test（display・root）/ shuffle / typecheck:test が全部成功 | 1〜6 | 4.7 |
| A13 | `display/frontend/src/App.svelte` に差分が無く、production パス（`src/App.svelte` から到達するモジュール）に対する **新 URL パラメータ名・`data-settle-read-nodes`・`data-settle-read-ms`・key 別 prefix 件数の属性名・段階 2' の 5 本の属性名** の grep が 0 件（既存の `settleTrace` 変数名 `:245` `:1821` は対象外） | 1・2' | `git diff --stat` と grep |
| A14 | `docs/specs/display-design-system.md` と `theme.css` に差分が無い | 1〜6 | `git diff --stat` |

### 5.2 実機（B、環境依存のため CI の合否には使わない）

**測定文脈を固定する。** Chrome 152 headless / 1920×1080 を `Emulation.setDeviceMetricsOverride` で attach 直後に設定（`--window-size` だけでは viewport 高が枠分減る。memory `feedback_headless_viewport_override`）／ preview `#legacy-standby-gate` `gateScenario=max`（59 カード）／`?contentChurnMs=5000&metadataChurnMode=reparse`／採取 60 秒／report に `innerWidth` と `innerHeight` を含める。capture の前に `npm --prefix display run build` を必ず通す（memory `feedback_capture_needs_display_build`）。**before / after は同じ手順・同じ時間帯で採り、after だけを載せない。**

| # | 条件 | 段階 | 測定 |
|---|---|---|---|
| B1 | 1 epoch の long task 合計・最大片・`data-settle-read-nodes`・`data-settle-read-ms`・`data-settle-trace` の外側 pass 内訳・prefix probe の key 別内訳が表になっている | 1 | 実 Chrome |
| B2 | **`data-settle-read-ms ÷ epoch 総時間`** が数値で書かれ、§3 段階 1 の判定 3 分岐のどれに落ちたかが明記されている | 1 | 実 Chrome |
| B3 | トレース記録の on / off で 1 epoch の差分が数値で書かれている（(f) の規模の副指標） | 1 | 実 Chrome |
| B4 | §2.2 の「外側 1 周目に約 106 読み」が `data-settle-trace` で裏取りされている | 1 | 実 Chrome |
| B4b | 段階 2' の 5 本が実測で埋まり、外側 1,764ms の内訳が表になっている。**包含関係のある項目（flush 系）を明示して差し引きを示す** | 2' | 実 Chrome |
| B4c | §3 段階 2' の判定 3 分岐のどれに落ちたかが明記されている | 2' | 実 Chrome |
| B5 | 1 epoch の long task 合計が段階 1 実測（中央値 2,291.5ms）から減っている。削減幅の目標値は **段階 2' の内訳を見て着手時に確定する** | 3 | 実 Chrome |
| B6 | `data-settle-read-nodes` の epoch 増分が段階 1 実測（28,100 件）を**超えない** | 3 | 実 Chrome |
| B7 | churn 無指定の 60 秒で long task 0 件・fps 60（現状維持の回帰） | 1〜6 | 実 Chrome |
| B8 | metadata churn 500ms（reparse）の 60 秒で long task 合計が段階 0 実測（10,204ms）を**超えない** | 3〜6 | 実 Chrome |
| B9 | 1 epoch が **複数の task に分割され、最大の 1 片が epoch 総時間の 1/3 未満**。総所要の増加が分割粒度 N ごとに数値で示されている。**段階 6 単独では達成不能なので段階 5＋6 で判定する** | 5＋6 | 実 Chrome |
| B10 | Pi 実機の 1 epoch 所要が段階 1 実測から減っている。**当初案の「4 秒」は B2 が rc 側に倒れた場合の値だった。B2 = 0.179 で否定されたので、目標値は段階 2' の内訳から立て直す** | 3 | 実機・CDP |
| B11 | Pi 実機で 10 分以上の連続観察中に Chrome の「応答なし」が出ず、**ローテーションが進み続ける**（`data-rotation-active-key` が観察窓の中で 2 回以上変化し、`data-rotation-position` が更新される。目視の印象ではなく属性の変化で判定する） | 3・5 | 実機・属性ポーリング |
| B12 | Pi 実機の目視で、実電文 1 通の到着でレイアウトのはみ出し・文字切れが出ない | 3・4 | 実機・目視 |

### 5.3 スコープ外（本 spec の受入条件に入れない）

- Node 側 sweep の残り（#13 段階 2＋4）
- `vpwp50ProjectionRejected` の診断分離（#16）
- 緊急画面の遷移負荷（#18）
- `reducedMotion` prop の coordinator 未配線（別バグ候補）
- 第 2 便の段階 1（シェルフ凍結）と段階 3（clone 削減）

## 6. 判断分岐

### 分岐 1: 段階 1 のトレース分離をどう実装するか — **A で実施済み（2026-09-09）**

- **A（推奨）: `gateCapture` の 3 用途（§1.3）を分け、settle トレースの記録だけを新しい URL パラメータで切れるようにする。既定は現行と同一。** `:1514` の `recentHypocentersClipped` は fixture 側に残す。変更は数行で、既存 gate テストの挙動を変えない
- **B: gate fixture を使わず、preview の通常経路で 59 カード相当の state を流す。** 製品コードを 1 行も触らないが、59 カードの state を組む資材が新たに要り、`gateScenario=max` と同じ条件である保証も無くなる
- **C: 分離せず、`data-settle-read-ms` だけで判定する。** §2.8 の主指標はもともとこちらなので、これでも段階 1 の目的は達せられる。トレースの規模（§2.7 (f)）は測れないままになる

### 分岐 2: 段階 2 のキャッシュ対象をどこまで広げるか — **閉じた（段階 1 の計測で段階 2 ごと見送り）**

- **B（推奨）: flood / volcano / quake の prefix probe に限る。** weather（`:497-511` → `:456-467` → `:667-683`）と tornado（`:532-560` → `:512-531`）は、**probe が 1 枚解決するたび pageIndex / pageCount が変わって既存 probe が再描画される**。briefing も `briefingPartitionRevision`（`:900-904`）で同型。幾何だけのキャッシュを掛けると `pageCount = 1` で測った高さが最終形に対して確定し、**実機に文字切れが出る**。3 key に限れば失敗モードが構造的に起きない
- **A: 全 key を幾何世代キーでキャッシュする。** 削減幅は最大だが上の失敗モードを実装が背負う。**推奨しない**
- **C: weather / tornado / briefing も、それぞれの partition revision を第 2 層の無効化キーにして含める。** 理屈は通るが、revision は probe が解決するたび変わるので実質ほぼ毎 pass 無効化になり、B との差はほとんど無い。**実装の複雑さだけが増える**
- **D: キャッシュを入れず、段階 3 と段階 5＋6 に集中する。** 段階 1 で `read-ms` 比が低く出た場合の正しい選択

**段階 1 の key 別内訳が出た結果、B の効果上限は 2.0%（約 45ms）だった。** 選ぶべきは **D（キャッシュを入れない）**で、この分岐は裁定を要さず閉じる。ご主人へ回す必要は無い。

### 分岐 3: 可視ルートの 126 診断属性（§2.7 (e)）をどう扱うか

- **A（推奨・ただし段階 2' の結果次第で B へ倒れうる）: 本 spec では触らない。** Pi の観測手順が `data-rotation-*` / `data-measurement-*` に依存しており、外すと過去の観測資材が動かなくなる。**段階 2' の `data-settle-flush-ms` が外側の支配項だと出たら、この分岐の価値が上がる**ので、そのときご主人へ回す
- **B: `JSON.stringify` を含む 16 属性だけを `partitionDebug || gateFixture != null` ガードへ移す。** production DOM が変わる。B11 の Pi 観測で使う属性は残るが、他の観測スクリプトが黙って空になる。**production gate（`npm run test:phase6b-production`）の追従が要る**

### 分岐 4: 配送をどこで切るか

**第 1 便（段階 1）は配送済み。** 残りをどう切るか。

- **C（推奨）: 段階 2'（計測のみ）を第 2 便にする。** 段階 1 と同じ理由——外側 77% の内訳が分からないまま性能改修に入ると、段階 2 と同じく「上限 2% の対象」を掘り当てる。段階 2' は製品挙動を変えないので配送リスクが最小で、1 便で次の判断材料が揃う
- **A: 段階 2' を飛ばし、§2.10 の仮説を信じて `weatherMeasurementRanges` のメモ化を直接実装する。** 当たれば往復が 1 回減る。外すと、根拠の無い最適化を production へ入れたことになる。**§2.10 は推測であって計測ではない**ので推奨しない
- **B: 段階 5＋6（応答性）を先に出す。** 総量は減らないが**最大片は段階 5 でしか下がらない**。「1 epoch 2.3 秒が 1 回」を「数十 ms が数十回」に変えるだけでも、Pi の「時計が止まる」体感は変わる。ご主人が体感の改善を最優先するならこの順もありえる

### 分岐 5: 段階 7（ladder 早期打ち切り／壁時計上限）を採るか — **(c) 製品緩和**

- **A（推奨）: 採らない。** 収束を諦めて確定するとレイアウトが未収束のまま出て、実機にはみ出しと文字切れが残る
- **B: 採る。** 最悪ケースに硬い上限が付く。ただし Pi では常に締切側に当たる可能性があり、**ご主人が毎日見る画面の品質を落とす**。採るなら締切値は段階 2 の後の Pi 実測を採ってから決める

**この分岐は製品挙動を緩める提案なので、Liebe は独断しない。** 段階 1 の実測を添えてご主人へ回す。

### 分岐 6: 段階 5・6 で `ladder-compressed` の中間状態をどう扱うか

- **A（推奨）: 何もしない。** 段階 0 の epoch run では **1,297 観測すべてで `data-measurement-geometry-stage` が `0`** だった。`measurementGeometryStage` が動くのは stage 境界をまたぐ epoch だけで（`StandbyScreen.svelte:1842-1853`）、このシナリオでは 1 度も起きていない。起こらない問題に構造を足さない
- **B: `ladder-compressed` を可視ルートから外し、シェルフ側だけに掛ける。** 中間状態は構造的に見えなくなるが、シェルフ幅は `--edge` / `--gap` を含む式で決まっており、**計測値そのものが変わりうる**
- **C: settle 中は `committedStage` 由来に固定し、確定時に一度だけ切り替える。** `:1842-1853` の「圧縮境界をまたいだら測り直す」ロジックと真正面から衝突する

## 7. 裁定ラベル案（段階ごと、6 要素）

### 段階 1（帰属の分離・計測のみ）— **第 1 便・配送済み 2026-09-09**

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

### 段階 2'（外側 77% の帰属分離・計測のみ）— **実装済み 2026-09-09・配送待ち**

```
対象: display/frontend/src/components/StandbyScreen.svelte（preview 限定の観測属性 5 本と
      その加算コードのみ）、
      display/frontend/src/components/__tests__/standby-settle-attribution-probe.test.ts（新規）、
      scratchpad/stage1-measure.mjs 相当の計測スクリプト（repo 外）、
      docs/specs/2026-09-09-standby-epoch-settle-cost.md（本 spec）
許容変更: partitionDebug || gateFixture != null ガード付きで data-settle-partition-ms/-calls、
      data-settle-revision-ms、data-settle-signature-ms/-calls、data-settle-flush-ms、
      data-settle-solve-ms/-calls を可視ルートへ追加。各計測点は performance.now() の
      入口/出口 2 回呼びと累計加算のみ。テストの新規追加、計測スクリプト、spec への実測追記
禁止変更: 関数の呼び出し順序・分岐・戻り値・settle ループの構造・readMeasurements の
      読み取り内容・plan / selection / solvePlan の結果・production の DOM 属性・
      App.svelte・theme.css・display-design-system.md・package.json / package-lock.json・
      layout-key.ts の除外リスト・段階 1 で足した 3 属性の意味
配送先: main → origin push → GitHub Actions 緑 → personal rebase → private push
      （Pi 反映は不要。preview 限定で production DOM は不変）
ロールバック: git revert <commit>（preview 限定なので production 影響なし）
受入条件: A2b・A12・A13・A14 の全件、B4b・B4c が実測で埋まっていること
```

### 段階 2＋3（prefix キャッシュと非 DOM コストの削減）— **段階 2 は見送り。3 のみ段階 2' の後**

```
対象: display/frontend/src/components/StandbyScreen.svelte（readMeasurements と
      世代キー計算、revision 導出のみ）、
      display/frontend/src/components/__tests__/standby-prefix-measure-cache.test.ts（新規）、
      docs/specs/2026-09-09-standby-epoch-settle-cost.md
許容変更: prefixMeasureEntries の Map 化（3-1）、revision 導出の差分化（3-2）、
      liveBorderBoxHeight の querySelector キャッシュ（3-3）、テストの追加
禁止変更: prefix 計測のキャッシュ（段階 2 は見送り）・
      測る対象そのもの（読む属性・判定式）・page probe の fit 判定・
      revision の出力文字列・plan / solvePlan / selection・
      MAX_SETTLE_PASSES / MAX_PREFIX_ROWS・可視 DOM の構造と属性・意匠トークン
配送先: main → origin push → GitHub Actions 緑 → personal rebase → private push → Pi 反映
ロールバック: git revert <commit> → npm run build → fqu で Pi 再反映
受入条件: A7・A8・A9・A12・A14 の全件、B5〜B8 の全件、B10・B11 を Pi で確認、B12 の目視。
      test:shuffle 必須
```

### 段階 4（カード計測の差分化）— **上限 4%。段階 2' と段階 3 の後**

```
対象: display/frontend/src/components/StandbyScreen.svelte、
      display/frontend/src/lib/legacy-standby/layout-key.ts（キー生成の再利用のみ）、
      対応するテスト
許容変更: カードごとの描画入力キーによる読み飛ばし、テストの追加
禁止変更: layout-key.ts の除外リストへの field 追加（第 1 便で固めた分類を性能理由で緩めない）・
      可視 DOM・意匠トークン・solver
配送先: main → origin push → Actions 緑 → personal → Pi
ロールバック: git revert <commit> → 再ビルド → fqu
受入条件: 段階 3 の受入に加え、第 2 便 A4・A5 相当の内容更新テスト
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
- **段階 1 の生データ: scratchpad `stage1-results-2026-09-09T01-17-41.json`、報告 `stage1-report.md`**（§9 の一次資料）
- `page-partition.ts:264`（`sequentialPartitionRanges`）、`StandbyScreen.svelte:515-521`（`stableWeatherMeasurement`）
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

## 9. 段階 1 計測結果（2026-09-09、Mac、Chrome 152.0.7977.83 headless、1920×1080、on / off 各 60 秒）

preview `#legacy-standby-gate` `gateScenario=max`（59 カード）、`?contentChurnMs=5000&metadataChurnMode=reparse`。完全に採取窓へ入った epoch 各 10 件で統計を採った。生データは scratchpad `stage1-results-2026-09-09T01-17-41.json`、報告は `stage1-report.md`。

| 指標 | on（トレースあり） | off（トレース停止） |
|---|---|---|
| 1 epoch の long task 合計（中央値） | **2,291.5ms** | 2,177.5ms |
| `data-settle-read-ms`（中央値） | **413.8ms** | 407.7ms |
| `data-settle-read-nodes` | **28,100 件**（全 epoch 一定） | 28,100 件 |
| `data-measurement-pass` の増分 | 107 | 107 |
| prefix entries | 364 | 364 |
| **B2 = read-ms ÷ long task 合計** | **0.179**（平均 0.163） | 0.188 |

### B1: read-nodes の突き合わせ

10 epoch すべてで **28,100 件ちょうど**。§2.6 の算術見積もりとの比 1.00。読み取り件数の理解は確定した。

### B2: 判定は「3 割未満」

0.179 は §3 段階 1 の 3 分岐のうち **「3 割未満 → (a) は本丸でない」**に落ちた。1 epoch の内訳は §2.9 の表のとおりで、`readMeasurements()` の内側は 18%、gate トレースが 5%、**残る約 77%（約 1,764ms）は `readMeasurements()` の外側**にある。

**B2 は下限値である。** 分母には production が払わないコスト（可視ルートの 126 診断属性・gate トレース・段階 1 で足した 3 属性の直列化）が乗る。ただし実測で切り分けられた (f) が 5% しかないので、(e) を全部差し引いても 18% が 3 割に届く余地は薄い。

### B3: gate トレースの規模

on / off の差は **114.0ms（on の 5.0%）**。§2.7 (f) の二乗構造は実在するが、2.3 秒の主因ではないことが確定した。read-ms は on 413.8ms / off 407.7ms でほぼ動かず、run 間の環境差が無いことの裏取りになっている。

### B4: 外側 pass の分布（§2.2 の確定）

10 epoch すべてで **pass 1 = 106 読み、pass 2 = 1 読み**（合計 1,070 件のうち pass 1 が 1,060 件）。§2.2 の「強い推測」は**確定**した。段階 6（外側 pass 境界の rAF 分割）が 2 片にしかならないことも同時に確定した。

### prefix probe の key 別内訳

| key | entries / epoch | reads / epoch | prefix reads 比 | 全 reads 比 |
|---|---|---|---|---|
| tornado | 180.0 | 9,738 | 45.4% | 34.7% |
| weather | 154.0 | 8,674 | 40.4% | 30.9% |
| volcano | 12.0 | 1,212 | 5.6% | 4.3% |
| quake | 10.0 | 1,018 | 4.7% | 3.6% |
| flood | 8.0 | 824 | 3.8% | 2.9% |

**キャッシュしてよい 3 key（flood / volcano / quake）の合計は 3,054 件で、全 28,100 件の 10.9%。** 分岐 2-B の効果上限は 18% × 10.9% = **2.0%（約 45ms）**。これが段階 2 見送りの直接の根拠である。

同時に、**tornado ＋ weather が prefix entry の 86%** を占めることも分かった。§2.10 の仮説（probe の描画がパーティション探索をやり直す）が当たっていれば、外側 77% の主因はここになる。

### 計測手法のメモ（次の段階へ引き継ぐ）

`data-settle-trace` と `data-prefix-probe-key-counts` は JSON 文字列なので、MutationObserver の `attributeFilter` に入れて毎観測で読むと**観測コストが settle の long task に乗って B3 を汚す**。段階 1 では両方を filter から外し、`data-measurement-settled` が true へ倒れた直後の別 task（`setTimeout` 0）で epoch 末の値を 1 回だけ採った。どちらも epoch 内で単調に伸びるだけなので epoch 末の値で足りる。**段階 2' の 5 本も同じ扱いにする。**

## 10. レイアウト再構成へ送る材料

局所修正で届く範囲が、段階 1 の実測で数値として確定した。**再構成の是非を検討するときはこの節を持っていく。**

### 確定した事実

- **1 epoch = 2.3 秒（Mac）、Pi 換算 11〜15 秒**。電文が届くたびに毎回出る
- **107 回の `readMeasurements()`** が 1 個の long task に入る。うち 106 回は外側 pass の 1 周目
- **DOM 読みは 18%（414ms）しかない。** ノード読み 28,100 件という数の大きさは実在するが、時間の主因ではない
- **残り約 77%（1,764ms）は settle ループの「pass ごとの再計算と再描画」**である。pass ごとに走るのは、`$derived` の再評価、`signature()` の全件 sort、2 本の partition revision の全件 sort、`flushSync()` による 2 面シェルフ（最大 412 ノード）の再レンダと可視ルート 126 属性の再評価、そして probe 描画側のパーティション再計算（§2.10、未計測）
- **pass 数 107 は探索の構造で決まる。** `pagePartitionProbe` は未知の range に当たると `null` を返して探索を打ち切り、次の pass で 1 世代ぶんだけ DOM を生やす（§2.5）。約 53 世代 × 2 読み。**キャッシュも差分化も、この 107 を 1 回も減らさない**

### 局所修正の限界

| 手段 | 効果の上限 | 根拠 |
|---|---|---|
| prefix 計測のキャッシュ（段階 2） | **2.0%** | §9 の key 別内訳。安全にキャッシュできるのは 3 key = 10.9% だけ |
| 全 prefix をキャッシュ（安全でない） | 13.7% | 18% × 76.4% |
| カード計測の差分化（段階 4） | 4% | 18% × 23.6% |
| `find` の Map 化ほか（段階 3-1・3-3） | 18% の内数、実質数十 ms | `readMeasurements()` の中で DOM 読みと分け合う |
| gate トレースの停止（段階 1 で実施） | 5%（production には元から無い） | §9 の B3 |
| 外側 pass 境界の rAF 分割（段階 6） | **0%**（2 片になるだけ） | §9 の B4 |
| 内側 probe ループの分割（段階 5） | **0%**（総所要はむしろ増える） | 最大片は下がるが総量は不変 |

**すべて足しても総量の 2 割に届かない。** 残り 8 割は「107 回の pass それぞれで、412 ノードのシェルフを描き直して全件を sort し直す」という**構造そのもの**が生んでいる。

### 再構成が触るべき軸

1. **pass 数を構造的に減らす。** 現状のパーティション探索は「1 世代生やして全部測り直す」を約 53 回繰り返す。候補を先に列挙してまとめて生やす、あるいは高さを DOM 計測ではなく計算で見積もる設計に変えれば、107 が 1 桁になりうる
2. **シェルフの規模を減らす。** 2 面 × 412 ノードを常時 mount して `visibility: hidden` で置いている（`display: none` にすると測れない）。計測のたびにこの全部がレイアウト対象になる
3. **pass ごとの全件 sort をやめる。** `signature()` と 2 本の partition revision が、毎 pass 400 件超を `localeCompare` で並べ替えている。増分更新できる構造にする
4. **診断属性の量。** 可視ルートに 126 個、うち 16 個が `JSON.stringify`。`flushSync` のたびに再評価される（分岐 3）

**この 4 つはどれも「今の設計の中の最適化」では届かない。** 段階 2' の内訳が「どの項目も 3 割に届かず散っている」と出たら、局所修正の打ち止めを宣言してこの節を再構成の入口にする。
