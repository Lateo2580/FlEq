# spec r-e: 河川洪水カードの改ページ導入（draft v3.1, 2026-08-23）

> v3 → v3.1: Sol 再レビュー残 2 点を確定——probe sentinel の数値契約（§3.2a）／pending 中の描画対象を provisional range 込みに修正（§3.3c）。

> v1 → v2: Terra high 設計レビュー反映（thread 01a02bfe-…）。
> v2 → v3: Sol high 独立 DOC レビュー（thread 01a02c06-…、判定: 要修正）の P1×4・P2×2・P3×2 を反映。
> 主変更: 固定高を「契約高定数」に確定して partition との循環を切断（§3.4）／solver 全経路への配線を単位 3 に明記（§5）／identity 維持の意味を「reset しない」に限定定義（§3.2c）／pending 遷移状態を定義（§3.3c）／acceptance を feasible/infeasible で分離（§6）／--report は DOM 属性形式に確定し capture allowlist 更新を含む（§3.5）。
> 判断分岐 D1/D2/D4/D5/D6 はご主人裁定済み（すべて推奨側で確定）。

## §1 背景・目的

従来フォーマット改良ラウンド（〜2026-08-23 main `5d396d0`）で洪水カードは「先頭 k 河川＋『ほか n 河川』集約」で高さ 200px / 30vh に収めている。この集約は r-e までの暫定（ご主人裁定済み）。r-e では weather/quake カードの改ページ資産 `CardPageCoordinator` を流用し、**集約で隠していた河川をページ送りで全件表示**する。

原則: 「常時 or 輪番で必ず表示・隠さない」三層設計の完成形。集約行は改ページでも物理的に 1 行も置けない infeasible fallback にのみ残す。

## §2 現状（実コード確認済み・Terra/Sol 照合済み）

- 供給: `flood-active-reducer.ts:118` — `surface: rivers>=4 ? "clock-top-wide" : "corner-right"`。表示順は severity・revision・名称で変動（`:107`）
- 狭幅 `FloodCard.svelte`: 全河川を DOM に出し CSS で隠す純 CSS 集約（`:25-26` data 属性、`:89-90` 通常幅 2 件、`:98-107` @container ≤320px で 1 件）。`.height-budgeted{min-height:200px}`（`:47`）で集約後もソルバ渡し高を維持
- ワイド `FloodWideCard.svelte`: `layoutFloodWideRows()`（`standby-cards.ts:198-220`、見積り定数 88/160/40px、2 列グリッド）で行数決定し末尾に `{kind:"more"}`。wide→compact fallback は `floodWideRowsIncludeDetail()`（`:225-239`）→ `StandbyScreen.svelte:559-567 floodWideDetailAllowed()`（純関数・coordinator 非依存）
- 改ページ資産: `time-slice-scheduler.svelte.ts` の `CardPageCoordinator`（15s tick / rotation logical モード / resetKey `:582` / epoch hold `:477-490`）＋ `page-partition.ts` の `sequentialPartitionRanges`（CardKey 非依存。`fixedHeightPx` を**入力として受け**、probe（fit sentinel）と比較して range を切る `:15,:44`。probe 未計測時は provisional range＋pending を返す `:38`。最初の 1 件も収まらなければ `ranges: []` `:49`）＋実測 probe（`StandbyScreen.svelte:426-444`、高さではなく fit 判定を返す）＋計測棚
- 固定高の現行経路: solver が使うのは `selectedHeight`／`measuredHeight`／rotation slot 高（`StandbyScreen.svelte:541,:580,:601`）。`pageFixedHeight`（`:521-523`）は live wrapper の style にのみ届く。flood は variant 棚高（max-height で切れた高さ）を使っており page 高の証明にならない
- 構造制約: `PageableCardKey = "quake" | "weather"`（`time-slice-scheduler.svelte.ts:11`）。**全 key 列挙箇所**（型 `:11`・3 record 初期化 `:431-433`・`realKeys` `:462`・appearance guard `:621`・`diagnostics()` の `cards` `:673` と `activeSubstates` `:677`・`dispose()` の 3 record 初期化 `:691`）を漏れなく改修する——数の約束ではなく「`PageableCardKey` を列挙する全箇所」を対象とする
- `PageAreaEntry`（`types.ts:99-105`）は型自体は generic（kindKey/area/areaCode/occurrenceIndex）→ adapter で再利用可。coordinator のページ identity は各ページ先頭 entry から作る（`WeatherAlertCard.svelte:181,:184`）
- 診断は 2 系統: compact visibility 検査＝集約 variant 期待（`StandbyScreen.svelte:1002-1035`）、wide＝overflow 検査（`:1037-1048`）。置換は別々に行う
- `--report` は capture script の**属性 allowlist 明示列挙**で抽出する（`display/scripts/capture-legacy-standby.mjs:175`）——DOM に属性を足すだけでは出ない

## §3 設計

### 3.1 coordinator 拡張

- `PageableCardKey` に `"flood"` を追加し、§2 の全 key 列挙箇所を同時改修
- 洪水は `ROTATION_REVERSE_ORDER` / `CENTER_ELIGIBLE_KEYS` の一員なので weather と同じ契約: rotation member 時は logical モード（輪番再登場で 1 ページ進む）、center 常駐時は real モード（15s tick）。既存 `register({rotationMember})` の分岐をそのまま使う

### 3.2 ページ分割 — 実測 probe 方式（weather 同型）【D2 確定】

**a. partition と identity**
- `sequentialPartitionRanges("flood", ...)` を使う。`fixedHeightPx` には §3.4 の**契約高定数**を渡す。probe は既存 API（数値を `fixedHeightPx` と比較する契約 `page-partition.ts:44`）を型変更せずに使い、**sentinel 値契約を「fit = 0 ／ fail = `fixedHeightPx + 1`」と定める**——現行 quake/weather の `fixedHeightPx=1` に対する 0/2 と同じ規則の一般化で、契約高 200/30vh でも fail が `fixedHeightPx` を必ず超えるため誤判定しない（`PartitionProbe` の boolean 化は行わない）。probe の実体は計測棚の per-entry forced-range 描画（weather の `pagePartitionProbe` と同じ経路）で、洪水の計測棚に entry 単位の計測点を追加する
- identity: 既存 `PageAreaEntry` を `{kindKey: river.kindName, area: river.riverName, areaCode: river.riverKey, occurrenceIndex}` で写像（型拡張なし）。riverKey は「現行 snapshot 内で reducer が重複排除する安定キー」であり page identity 用途には十分（恒久一意の保証とは主張しない）

**b. wide 適格判定の循環切断**
- wide/compact の形態選択に live pagination を使うと「形態選択 ⇄ 棚 mount ⇄ coordinator 登録 ⇄ reset」の循環が生じる。wide 適格性判定は **coordinator 非登録の専用 probe（1 河川を強制した fit 判定）** で行い、live pager への登録は**選択済みの一形態のみ**とする。`floodWideDetailAllowed()` の「純関数・coordinator 非依存」という現行性質を保存する

**c. resetKey と再分割方針【D6 確定】**
- resetKey は**順序付き riverKey 列**＋形態（wide/compact）。順序変更・集合変化・形態切替は reset（coordinator の resetKey 契約 `:582` に整合）
- 同一集合・同一順序で内容更新（観測所・文言変化）により probe 結果とページ境界が変わった場合は **reset しない**。このとき spec が要求するのは「1 ページ目への強制復帰が起きないこと」のみで、**表示位置の厳密維持は要求しない**——ページ identity は各ページ先頭 entry 由来（`WeatherAlertCard.svelte:181,:184`）のため、境界移動で旧 active identity が消えた場合は coordinator の既存削除遷移（次の stable page へ移る・starvation 回避 `:588`）に従う

### 3.3 カード改修

**a. paged 描画**
- `FloodCard.svelte` / `FloodWideCard.svelte` に weather 同型の props を追加: `pageCoordinator` / `rotationMember` / `partitionProbe` / `pagePlacement` / `measurementRange` / `measurementPageFooter`（`measuring ? undefined : coordinator` の慣例踏襲）。計測用 props と **forced-range 描画**（probe が footer 込み page shell と同条件で測るための受け口、`WeatherAlertCard.svelte:201` と同契約）を含む
- 現在ページの range で `item.data.rivers` をスライスして描画。CSS 集約（`data-flood-aggregated-*`・@container 切替・`.more-rivers` の集約系）は撤去し、狭幅の折返し（`white-space:normal`）だけ残す
- `layoutFloodWideRows` の「ほか n」集約は撤去し、1 ページの収容判定は partition が担う
- ページバッジ: weather と同じ `card-page-footer`（`data-card-page-indicator`、「1/2」）。位置規約は r-h 裁定を踏襲

**b. infeasible の描画状態定義【D4 確定】**
- partition の**確定** `ranges: []` は「空へ退避」ではなく明示の描画状態として扱う。優先順位:
  1. wide の 1 河川 probe が fail → **compact へ降格**（既存 fallback 経路の probe ベース置換）
  2. compact でも 1 河川 probe が fail → **aggregate fallback**（集約行のみのカード）を描画
  3. aggregate fallback 自身も契約高に収まることを probe する。それも fail なら header＋集約行を契約高内で clip 許容（最終防衛、診断属性で可視化）
- infeasible 状態は `--report` に専用属性で出す（§3.5）

**c. pending（probe 未計測）中の遷移状態**
- 棚未計測で partition が provisional range＋pending を返す間（`page-partition.ts:38`）:
  - **partition が返す現在の range（未確定の provisional `[start, end)` を含む）をそのまま描画**する（「確定済み prefix のみ」ではない——先頭 entry 未計測でも partition は provisional range を返すため、描画対象は常に「現在 partition の active range」で統一）。新規ページの defer 等は weather の既存 pending 慣例に従う
  - カード高は §3.4 の契約高で**先行固定**する（pending 中も高さ契約を破らない。provisional 1 page を「非 paged」扱いにしない）
  - **infeasible fallback（§3.3b）と wide→compact 降格は確定 `ranges: []` でのみ発火**し、provisional では発火しない
  - 計測棚幅 0（未確定）のときの wide 昇格不可という現行 fail-safe（`floodWideDetailAllowed()` の「不明は昇格許可ではない」）は維持する

### 3.4 高さ契約【D5 確定・v3 で決定手順を確定】

- **洪水の page 固定高は「契約高定数」とする**: compact = 200px（現行 `.height-budgeted`/`max-height` 契約と同値）、wide = viewport 高×0.3（現行 `max-height:30vh` 契約と同値）。この値は footer を含む page shell 全体の高さ予算であり、probe は「footer と header を除いた本文領域に entry が収まるか」を fit sentinel で判定する。**固定高を実測から導出しない**ことで「partition が固定高を要求し、固定高が partition 結果を要求する」循環（Sol P1-1）を構造的に排除する
- **同一の契約高を solver 全経路と live に流す**: `selectedHeight`／`measuredHeight`／rotation slot reserve（`StandbyScreen.svelte:541,:580,:601`）と live outer `paged-card` の `pageFixedHeight`（`:521-523`）がすべて flood の同じ page-shell 契約高を使う。二つの経路が別の値を持った瞬間にクリップか配置不整合が起きるため、単位 3 の完了条件に含める（§5）
- ページ有効時（2 ページ以上）と pending 中（§3.3c）は契約高で固定。`FloodCard` の `.height-budgeted{min-height:200px}` は非 paged 経路（確定 1 ページ完結）限定に残す
- `FloodWideCard` の内側 grid height transition（`:75-80`）は paged 時は停止して固定高に従う

### 3.5 診断・番兵の同期

- compact visibility 検査（集約 variant 期待、`:1002-1035`）と wide overflow 検査（`:1037-1048`）を**別々に**置換: compact は「現在ページの期待 range と可視河川数」照合へ、wide は overflow 検査を paged 描画に追従
- inactive rotation wrapper に mount された flood が可読性診断の偽陽性を出さないこと（既存 quake/weather の慣例に従う）
- `--report` の flood ページ番兵は **DOM data 属性形式に確定**（JSON フィールド案は不採用）: flood 専用の `data-flood-page`／`data-flood-page-keys`／`data-flood-page-identities`／`data-flood-page-infeasible`（命名は既存 `data-card-page*` と衝突しない flood prefix）。実装は 3 点セット——①StandbyScreen への属性出力 ②capture script（`capture-legacy-standby.mjs:175`）の**属性 allowlist への追加** ③期待表・fixture assertion の更新。`cardDiagnostics("flood")` のページ数・activeKey を番兵化。E fixture 7 経路の flood 期待値（`data-flood-form`・footer 有無・可視件数）を更新

## §4 判断分岐（ご主人裁定済み・2026-08-23）

- **D1 対象形態**: 両形態に導入【確定】
- **D2 分割方式**: 実測 probe 方式【確定】（§3.4 契約高＋§3.2b 専用 probe が前提）
- **D4 集約行**: infeasible fallback のみ（§3.3b の 3 段防衛）【確定】
- **D5 高さ契約**: 契約高定数（compact 200px／wide 30vh）で固定【確定・v3 で決定手順を定数化】
- **D6 reset 方針**: 順序変更 = reset・内容更新のみ = reset しない（表示位置の厳密維持は要求しない、§3.2c）【確定】

## §5 実装単位（ヘルツ委譲・v3 で境界を再定義）

1. **coordinator 拡張**: `PageableCardKey` + 全 key 列挙箇所（§2 参照）＋ unit test
2. **洪水 pagination 計測基盤**: identity adapter＋カードの計測用 props（`measurementRange`/`measurementPageFooter`）と forced-range 描画＋計測棚 entry 計測点＋probe 経路＋ unit test（**カードの計測経路はこの単位。live 経路は単位 3**）
3. **live 配線**: StandbyScreen の props 注入・**契約高の solver 全経路接続（`selectedHeight`/`measuredHeight`/rotation slot reserve/`pageFixedHeight` が同一値であること・完了条件に含む）**・wide 適格判定の専用 probe 置換・infeasible/pending 状態機械＋ standby test
4. **カード live 描画**: FloodCard / FloodWideCard の paged 描画・CSS 集約撤去・page footer ＋ component test。**`preview/LegacyImprovedMock.svelte` の独立 pager 実装（自前の `PageableCardKey` 列挙・`:111` 以下）への flood 追加もこの単位**（mock は lib と独立コピーのため単位 1 では触らない——2026-08-23 単位 1 停止点裁定）
5. **診断・番兵同期**: compact/wide 検査の別置換・--report 属性 3 点セット（属性出力・capture allowlist・期待表/fixture）・E fixture

依存順: 1 → 2 → 3 → 4 → 5（3 と 4 は同一 patch でも可、レビューは分ける）

## §6 acceptance

**feasible な構成（通常 viewport・fixture）:**
- [ ] n 河川（n=1,2,3,5,12）で全河川がページ巡回で表示される（15×R×P 上界は **flood を含む** rotation 構成で検証。既存上界試験は weather 専用のため flood 版を追加）
- [ ] 2 ページ以上のとき page footer「k/P」表示、1 ページ時は footer なし
- [ ] rotation 所属時は輪番再登場でのみ進む（logical）、center 常駐時は 15s tick（real）。flood＋quake/weather 同時 real の共存ケースを含む
- [ ] epoch hold 中の洪水再登場でページが即時に進まず、layout motion 解放後に一度だけ進む
- [ ] wide↔compact 形態切替・河川集合/順序変化で 1 ページ目へ reset
- [ ] 同一集合・同一順序の内容更新では **activeIndex の 1 ページ目への強制復帰が起きない**（境界不変なら同一ページ表示維持。境界移動時は coordinator の既存削除遷移に従うことを観測可能な形で検証——追加・削除・並び替え・詳細更新を個別に）
- [ ] paged・pending 時のカード高（solver 渡し＝live outer）が契約高定数で一致し、ページ送り・pending→確定遷移で高さが揺れない
- [ ] 幅境界（wide 400px・compact 320px）× side/center の page probe が footer と実 river/station 内容込みで fit 判定する
- [ ] pending 中は現在 partition の active range（provisional 含む）を描画・fallback 非発火・契約高で先行固定（§3.3c）

**infeasible な構成（1 河川行も置けない極端な狭さの専用 fixture）:**
- [ ] 3 段防衛（wide→compact→aggregate fallback→clip 許容）が定義どおり遷移する（全件巡回は要求しない）
- [ ] `data-flood-page-infeasible` が --report に出る

**番兵・回帰:**
- [ ] inactive rotation wrapper の flood が可読性診断の偽陽性を出さない
- [ ] --report で既存 quake/weather の `data-card-page*` と衝突せず、flood 専用属性が capture allowlist 経由で出力される
- [ ] 洪水可読性検査（compact/wide 別）・--report 期待表・E fixture が新契約でグリーン
- [ ] root / display / personal 全テストグリーン（shuffle 含む）
