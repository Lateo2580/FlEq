# VPWS50「今回の変更」欄の密度とリボン意匠

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


> **Phase 0 申告（規範本文は 3.0）**
>
> - 使用する theme token: `--surface-panel-raised`, `--surface-highest`, `--hairline`, `--radius-m`, `--radius-s`, `--elevation-1`, `--space-1`〜`--space-7`, `--type-label-l-size`, `--type-label-m-size`, `--type-label-xs-size`, `--type-body-s-size`, `--type-label-weight`, `--type-label-weight-emphasized`, `--type-body-weight`, `--header-band-width`, `--header-weatherWarning-container`, `--header-weatherWarning-on`, `--header-band-weatherWarning`（定義: `display/frontend/src/lib/theme.css:90-110,116-148,161-175,182-211`）。新しい意味色・生の色値・同義トークンは追加しない。
> - runtime scale: `--panel-scale` は theme root の token 定義ではない。full layout だけが `.layout-full .panels` から `1.5` を注入し（`display/frontend/src/components/EmergencyScreen.svelte:235-237`）、それ以外は各 consumer の `var(--panel-scale, 1)` fallback で `1` として解決する（例: `display/frontend/src/components/WeatherEmergencyPanel.svelte:688-718`）。
> - 倣う錨: `WeatherAlertCard` の **DOM だけ**、すなわち `header > title + meta`（`display/frontend/src/components/WeatherAlertCard.svelte:432-435`）と、container 面・on 文字・下端 band の接続（`display/frontend/src/lib/theme.css:280-307`）。更新欄は小見出しなので standby 用 `.standby-card-header` class と fluid type、主 panel 用 64px 級 `--panel-header-font-size` / `--panel-header-padding-v` / `--panel-header-padding-h` / `--panel-header-min-h` は流用しない。物理的な上端 band は作らない。
> - 親 header の不変 cascade: L4 は `--header-weatherWarning-container` / `--header-weatherWarning-on` / `--header-band-weatherWarning`、L5 は後段 `.level-5 .heading` の白背景・黒文字・黒 band 反転を維持する（`display/frontend/src/components/WeatherEmergencyPanel.svelte:747-771`）。更新欄 local header だけを weatherWarning 三変数へ接続し、L5 の既存 raw 値を移植・token 化しない。
> - 高さ契約: live と同一 DOM/CSS の measurement shelf で border-box 実高を測る（`display/frontend/src/lib/measure-height.ts:19-27,109-118`; `display/frontend/src/components/WeatherEmergencyPanel.svelte:257-290,1012-1035`）。

## 1. 症状

2026-08-27 の秋田・富山 L4 事象で、ご主人の観測した問題は次の二点だ。

1. 「今回の変更」が変更一件につき一行の縦積みで、カード幅を使えていない。現在の通常表示は 4 件、compact 表示は 2 件までなので、変更が多いと代表項目以外が早期に省略され、状況の広がりを一覧しにくい。
2. 更新欄だけが左端の太いリボンで強調される。既存カードの「container 面 + on 文字 + 下端 band」という header language と方向・階層が揃っていない。

表示密度を上げる変更は更新欄の自然高を変える。見た目だけを詰めると、対象地域のページ分割、compact 配置、live と probe の差に波及する。このため本仕様は、情報表現と border-box 高さ測定を一つの契約として扱う。

## 2. 根因（file:line）

### 2.1 差分生成は engine で既に成立している

- VPWS50 の前回 snapshot と今回 snapshot の比較は `computeDisplayDiff` が担う（`src/engine/messages/vpws50-state.ts:451-525`）。`added` / `upgraded` / `downgraded` / `kindChanged` を分類し、前回にだけ存在するものを `released` としている（同 `:483-525`）。
- 最初の電文は比較対象がないため `displayDiff = null` であり、二通目以降だけに差分が付く（同 `:724-745`）。したがって実電文 fixture は単票ではなく before/after の対でなければ「今回の変更」を再現できない。
- 表示 store は五区分を wire item に平坦化し、地域 + 現象で重複排除する（`src/engine/display/weather-change-store.ts:61-91`）。受理済み VPWS50 だけを保持し、初報・取消・安全側でない状態では消去する（同 `:100-139`）。
- wire は最初に無加工の full snapshot を試す。その payload が予算を超えた場合だけ、`weatherChange` を 12 → 4 → 2 件へ順次縮退し、最終段は空 DTO ではなく `weatherChange: null` にする（`src/engine/display/http-server.ts:431-460,493-527`）。13 件を含む full payload がそのまま届く場合もある。

結論として、追加・解除・変更の区分計算が根因ではない。本仕様で engine の分類、TTL、wire schema、wire の **full → 縮退時 12 → 4 → 2 → null** を変更しない。通常 12 / compact 4 は 3.2 で新設する frontend 候補上限であり、wire 最大値とは呼ばない。

### 2.2 frontend が低密度の縦一列へ固定している

- `WeatherEmergencyPanel` は通常 4 件、compact 2 件で `selectWeatherChangeItems` を呼ぶ（`display/frontend/src/components/WeatherEmergencyPanel.svelte:63-70`）。
- 選別順と代表予約は `upgraded` → `added` → `kindChanged` → `downgraded` → `released` の順で実装されている（`display/frontend/src/lib/weather-panel.ts:707-775`）。文言は一件ごとに区分語を繰り返す（同 `:792-798`）。
- DOM は `.change-rows` の下に `.change-row` を縦積みするだけである（`display/frontend/src/components/WeatherEmergencyPanel.svelte:633-649`）。`.change-rows` も一列 grid で、各 row が wrap する（同 `:686-726`）。これが横幅を使えない直接原因だ。
- 既存仕様は通常 4 / compact 2 件、ページ送りなしを定める一方、Pi 観測後の件数調整を明示的に許容している（`docs/specs/emergency-change-display.md:236-258,396-411`）。本仕様はこの件数・レイアウト節だけを置換し、変更の出典、TTL、代表選別の優先順、無操作という既存契約は保持する。

### 2.3 左リボンが共通 header language から孤立している

- 更新欄は `border-left: 4px ... --header-band-weatherWarning` を持つ独立 surface である（`display/frontend/src/components/WeatherEmergencyPanel.svelte:686-710`）。
- 一方、共通 header は container 面、on 文字、下端 band の三つの semantic variable を一つの `header` box に接続する（`display/frontend/src/lib/theme.css:90-110,280-307`）。`WeatherAlertCard` の `header > title + meta` は、この DOM を実際に使う錨である（`display/frontend/src/components/WeatherAlertCard.svelte:432-435`）。物理的な上端 band は存在しない。
- design system は意味のある値を token へ接続し、local な補正値を増やさないことを求める（`docs/specs/display-design-system.md:21-24,46-76,91,134-143`）。左リボンだけを token 化しても、強調方向の不一致は残る。

### 2.4 自然高とページ分割が同じ測定系に入る

- `WeatherEmergencyPanel` は対象地域の live frame と隠し shelf を持ち、fragment の `getBoundingClientRect().height` を border-box として測ってページ分割する（`display/frontend/src/components/WeatherEmergencyPanel.svelte:161-179,217-290,303-390`）。shelf は画面外・非表示相当だが layout には載り、live と同じ fragment を描画する（同 `:561-630,1012-1035`）。
- `measureBorderHeight` は `ResizeObserverEntry.borderBoxSize` を優先し、fallback でも border-box を返す（`display/frontend/src/lib/measure-height.ts:19-27,109-118`）。
- footer/自然高契約は、通常 flow の自然な border-box 高を測り、実高変更時に再分割することを要求する（`docs/specs/2026-09-05-standby-card-page-footer-contract.md:14-24,32-64,78-90`）。probe/live 一致だけでなく stage・rotation・overflow まで比較するのが alignment 契約である（`docs/specs/2026-09-05-standby-card-design-alignment.md:174-204,309-316,470-520`）。

なお `WeatherEmergencyPanel` は `EmergencyScreen` 専用で、standby の stage/rotation 候補ではない（`display/frontend/src/components/EmergencyScreen.svelte:171-181,208-247`）。ここでいう「圧縮段との相互作用」は、既存 `compact` slot と wire 劣化段を尊重し、standby 用の新しい stage や rotation を持ち込まない、という境界を指す。

## 3. 変更

### 3.0 Phase 0 — token・錨・不変条件の申告

実装開始前に、PR 本文または実装ノートへ次を転記し、実値を確認する。

| 種別 | 採用する契約 |
| --- | --- |
| surface | `--surface-panel-raised`, `--surface-highest`, `--hairline`, `--radius-m`, `--radius-s`, `--elevation-1` |
| spacing | `--space-1`〜`--space-7`; 4px grid から外れる local magic number を作らない |
| type | chip は `--type-body-s-size` + `--type-body-weight`、小見出し title は `--type-label-l-size` + `--type-label-weight-emphasized`、group/summary は `--type-label-m-size`、meta/tail は `--type-label-xs-size` + `--type-label-weight` を runtime `--panel-scale` で拡縮する。standby の fluid type は流用しない |
| runtime scale | `--panel-scale` は `EmergencyScreen.svelte:235-237` が full layout にだけ `1.5` を注入する custom property。それ以外は consumer fallback `1`。`theme.css` 定義とは記録しない |
| local header geometry | `--space-1`〜`--space-7` と上記 fixed label type で小型 header を作り、band 幅だけ `--header-band-width` を使う。`--panel-header-font-size`, `--panel-header-padding-v`, `--panel-header-padding-h`, `--panel-header-min-h` は主 panel header 専用なので更新欄には使わない（定義: `display/frontend/src/lib/theme.css:161-167`） |
| semantic color | 更新欄 local header だけを `--header-weatherWarning-container` / `--header-weatherWarning-on` / `--header-band-weatherWarning` へ接続する。親は L4 の weatherWarning 三変数と、後段で勝つ L5 の既存白 / 黒 / 黒反転をそのまま維持する（`WeatherEmergencyPanel.svelte:747-771`） |
| 錨 | `WeatherAlertCard.svelte:432-435` の `header > title + meta` DOM と `theme.css:282-307` の flex / container / on / bottom-border 接続だけを倣う。`.standby-card-header` class、fluid type、padding は倣わない |
| 測定 | `measureBorderHeight` と既存 shelf。probe と live に同じ grouped-header / chip / omitted-tail DOM と CSS を使う |

#### 独立 DOC レビュー裁定（Sol high、read-only）

| # | 裁定 | 根拠と反映先 |
| --- | --- | --- |
| 1 | **a) 採用** | 指摘された token 名は現行 `theme.css` に存在せず、錨にも物理的な上端 band はない。Phase 0 と 3.3 を実在する `--header-weatherWarning-container` / `--header-weatherWarning-on` / `--header-band-weatherWarning`（親は weatherEmergency の対応三変数）、DOM-only 錨、小型 fixed type に訂正した。 |
| 2 | **a) 採用** | hero、action、alert names、sub section と change 外側 inset は可変または border-box 外だった。3.2 で全非変更部分の同型 reserve shell、margin を廃した inset wrapper、panel 実高・確定 budget・内容 fingerprint を含む key に置換した。 |
| 3 | **a) 採用** | `buildDegradeAttempts` は full を先に試し、最後は 0 件 DTO でなく `null` にする。2.1、3.2、5.1 を **full → 12 → 4 → 2 → null** へ訂正し、12 / 4 を frontend 固有上限として分離した。 |
| 4 | **a) 採用** | code-only `kindChanged` は store で DTO 化前に除外される。3.5 と 5.2/5.7 で engine 14件、表示可能13件、wire、chip、省略の oracle を別 field にした。 |
| 5 | **a) 採用** | 現行診断属性と alignment gate は unresolved、nonconverged、visible set、rotation omitted、全 tick を検査する。5.3〜5.6 に同じ gate と compact 文字下限を追加した。 |
| 6 | **a) 採用** | fragment key と cycler reset key は range/partition 由来であり、物理 page identity は再分割で変わる。3.4 と 5.6 で不変対象を論理地域 identity / 順序へ限定し、key 再生成・index 収束・追加地域初期 page を明記した。 |
| 7 | **a) 採用** | 種別⇔地域 spec と preview / capture / corpus が競合する。3.6、4、5.8、6 で同 spec を先行統合し、その合格 HEAD を本仕様の base とする直列化と単一 ownership を定めた。 |

#### 再レビュー残点の裁定（Sol high、read-only）

| # | 裁定 | 根拠と反映先 |
| --- | --- | --- |
| R1 | **a) 採用** | 現行 partition は同一 epoch 内で未測定候補の追加または一回の split だけを進める（`WeatherEmergencyPanel.svelte:318-360`）。3.2 と 5.5 で4-pass counterを外側 `{B, selected n}` publish だけへ限定し、partition 内部反復を除外した。 |
| R2 | **a) 採用** | `.role-weatherEmergency` の後に `.level-5 .heading` が勝ち、computed style は白 / 黒 / 黒になる（同 `:761-771`）。Phase 0、3.3、5.3 に L4 / L5 cascade の不変条件を追加した。 |
| R3 | **a) 採用** | 先行 capture schema は `phase=base|after` である（`docs/specs/2026-09-06-weather-alert-card-kind-area-association.md:169`）。3.5 と 5.8 で既存 phase を維持し、統合点は別 `checkpoint` field に分離した。 |
| R4 | **a) 採用** | `--panel-scale` は theme root でなく `EmergencyScreen.svelte:235-237` の runtime 注入である。spec 冒頭と 3.0 で出典を分け、非 full layout の fallback `1` も明記した。 |

不変条件は以下だ。

- engine の五区分、TTL、wire schema、wire の full / 縮退段は変えない。
- 対象地域の論理 identity・順序・重複なしを変えない。物理 page range、fragment key、partition signature、cycler reset key は新しい実高 partition から再生成する。
- 更新欄に操作、hover 前提、横 scroll、内部 timer、自動送りを追加しない。
- 色だけで区分を伝えない。区分名、件数、地域名、現象名、遷移を text として残す。
- 更新欄を通常 flow の `flex: 0 0 auto` に置く。`position: absolute/fixed`、負 margin、transform 縮小、`max-height` clip、scroll で高さを偽装しない。

### 3.1 裁定 1 — 密度の形

#### 選択肢

| 案 | 形 | 評価 |
| --- | --- | --- |
| A | 全項目を同じ横流し chip にする | 最も高密度だが、追加・解除・変更の境界が弱く、各 chip に区分語を繰り返すため長くなる。 |
| B | 二列 grid にする | 行の比較はしやすいが、長い地域名・現象名・`before → after` の組合せで列幅が不足しやすい。空き幅も列単位で残る。 |
| **C（推奨）** | **区分見出し + 区分内の横並び chip** | 区分語を一度だけ示し、可変長 chip を幅いっぱいに詰められる。五区分の意味と一覧性を両立する。 |

#### 採用仕様

- 表示順は既存どおり `upgraded` → `added` → `kindChanged` → `downgraded` → `released` とする。
- 件数が 0 の区分は DOM を生成しない。存在する区分は `change-group` atom とし、区分見出し、区分件数、chip list を一体で扱う。
- chip の本文は区分見出しで重複しない最短形とする。
  - `added`: `{地域}　{今回の種別}`
  - `released`: `{地域}　{前回の種別}`
  - `upgraded` / `downgraded` / `kindChanged`: `{地域}　{前回} → {今回}`
- chip はボタンではない。`role=button`、tab stop、click、hover だけの情報を持たせない。
- chip は `--surface-highest` + `--hairline` + `--radius-s` とする。長い日本語を完全な pill にせず、既存 shape hierarchy を維持する。
- 区分見出しと chip は折返し可能だが、chip 自体の途中を省略記号で切らない。長い語は chip 内で安全に wrap し、水平 overflow を作らない。
- 更新欄 header の meta に `VPWS50` と論理総件数を表示する。summary は区分別総数を text で保持し、chip が省略されても区分の存在が消えないようにする。

### 3.2 裁定 2 — 大量変更時の上限と溢れ方

#### 選択肢

| 案 | 形 | 評価 |
| --- | --- | --- |
| **A（推奨）** | **表示可能な代表 chip + 「ほか N 件」へ縮約** | 60 秒 TTL の一過性情報を一瞥でき、無操作表示のまま高さを確定できる。既存の代表予約アルゴリズムも再利用できる。 |
| B | 更新欄自体をページ送り atom にする | 情報は全件見せられるが、対象地域とは別の timer・page state・indicator・reset key が必要になり、短い TTL 中に見逃しを生む。 |
| C | stage ごとに段階圧縮する | standby solver との統合には向くが、この panel は emergency 専用で stage を持たない。`compact` と wire 劣化段へ第三の概念を足すことになる。 |

#### 採用仕様

- **frontend の新しい表示候補上限**を通常 12 件、compact 4 件とする。これは wire 上限ではない。full wire で表示可能変更が 13 件以上届いても、通常候補は代表 12 件から fit 探索を始める。
- ただし固定件数を無条件に描画しない。live と同じ幅・同じ DOM/CSS の shelf で、通常は 12 から、compact は 4 から候補数を減らし、panel の利用可能高に収まる最大候補を選ぶ。
- 候補削減は既存の category representative 選別を使い、先頭から単純切断しない。`upgraded` と `released` が同時に存在する場合は、少なくとも各 1 件を予約する。
- 一件以上を省略した場合、chip 群の末尾に一つだけ `ほか N 件` を表示する。これはページ操作ではなく、省略数を示す非対話の tail だ。
- 区分別総数は summary に残す。ある区分から表示 chip が 0 件になっても、`解除 3件` のように存在を確認できること。
- chip を一つも安全に置けない場合だけ summary-only を許す。初回測定が未確定の間も summary-only を保守 fallback とし、推測寸法で全件を描画しない。
- 1920×1080 と 1280×720 の受入 fixture では、`upgraded` と `released` が共存する限り両方を 1 件以上表示する。これを満たせない geometry は合格にしない。
- UI の論理総数は `受信 changes 数 + 受信 omitted 各区分の合計` とする。wire が full / 縮退 12 / 4 / 2 のどれでも、server が保持した omitted を UI fit 由来の omitted に加算し、`ほか N 件` を元の表示可能総数へ一致させる。`weatherChange: null` なら更新欄自体を表示しない。
- 本裁定は `docs/specs/emergency-change-display.md:236-258` の frontend 表示上限 4 / 2 を置換する。wire の full / 縮退 12 / 4 / 2 / null、TTL、代表優先順、非対話性は置換しない。

#### 高さの選択規則

1. live `.weather-panel` を `ResizeObserverEntry.borderBoxSize` で観測し、panel の border-box width / height と computed border / padding から flex children が使える content-box height `Hpanel` を得る。`layoutSettling=true` の sample は publish しない。
2. shelf に **非変更部分の同型 reserve shell** を置く。live と同じ width、`compact`、入力内容、class、font、CSS を使い、主 heading、hero、alert names、通常時 action、sub section、`.tiles` の block padding、全 gap / border を含める（実在 DOM: `WeatherEmergencyPanel.svelte:458-555`; CSS: 同 `:747-850`）。`.tile-where` は同じ border / padding / header chrome を持ち、`max(computed min-height: 5em, 見出し + 最小一断片を含む合法な一ページの自然高)` を reserve する。reserve shell は block-size を auto とし、flex の余剰高さを測定値へ混ぜない。この border-box 占有高を `Hreserve` とする。
3. 現行 `.weather-change` の外側 margin は section の border-box に入らない（同 `:686-695`）。実装では margin を撤去し、live / shelf 共通の `.weather-change-slot` wrapper が inline inset と下端 gap を Phase 0 の spacing token による padding として所有する。section 本体、外側 inset、下端 gap を含む wrapper の border-box 高を候補高 `Hcandidate(n)` とする。
4. candidate-independent budget を `B = Hpanel - Hreserve` と定義し、`B >= 0 && Hcandidate(n) <= B` を満たす最大の `n` を選ぶ。`Hreserve` に選択中の change DOM、高さ、対象地域の現在の flex 割当を入れない。これにより `大きい候補 → 対象地域縮小 → 小さい候補 → 対象地域拡大` の feedback loop を閉じる。
5. summary-only も `n=0` の実在候補として wrapper 込みで測る。それすら収まらない場合は `data-change-layout-unresolved="true"` とし、clip / scroll で成功に見せない。対象四 viewport ではこの状態を不合格とする。
6. measurement identity は少なくとも `changeKey`、`activationKey`、`compact`、panel border-box width / height、確定 `B`、`Hreserve`、非変更内容 fingerprint、change の表示可能論理 fingerprint、font epoch、layout-settling epoch を含む。非変更内容 fingerprint は level、heading / trigger、alert names、action の有無、sub kinds / counts、最小 where chrome/fragment を含める。
7. panel width / height、上記 fingerprint、font epoch のどれかが変われば旧候補を cache hit させず再測定する。pending 中は同じ identity の直前確定 layout だけを保持し、identity が異なる初回は summary-only とする。
8. 各 outer fit epoch で `n=0..limit` の全 change candidate を同じ shelf batch に render・測定し、測定が揃ってから `{Bq, selected n}` を一度 publish する。`Bq = round(B * devicePixelRatio) / devicePixelRatio` とし、subpixel noise を別値にしない。measurement identity が変わったら counter を 0 へ reset し、`data-change-measurement-pass` は初回 publish を 1、その後は `{Bq, selected n}` の公開値が前回から変わったときだけ増やす。`ResizeObserver` 通知だけ、同値 publish、font/layout pending は数えない。
9. publish 後に、実際に残った `whereFrame` の border-box を既存 `ResizeObserver` で測り直し、対象地域を再 partition する。既存の `layoutState=pending`、fragment candidate の測定、split-only refinement、そのための effect / `ResizeObserver` 反復は **outer fit pass に数えず**、既存 partition 自身の `ready` または `infeasible` まで待つ（現行: `WeatherEmergencyPanel.svelte:318-380`）。この内部反復へ新しい4回上限を掛けない。
10. `layoutState=ready` 後に同じ measurement identity、`Bq`、selected `n`、partition signature が連続二 sample 一致したら収束とする。local 上限 `MAX_CHANGE_FIT_PASSES = 4` は outer publish の変化だけに適用し、5回目の異なる `{Bq, selected n}` を publish しようとした場合だけ `data-change-measurement-nonconverged="true"` とする。partition が正当に5回以上 split refinement したことを nonconverged 理由にしてはならない。各 outer publish と内部 refinement は capture trace の `outerFitPublishes` / `partitionRefinementCount` へ分けて記録する。

### 3.3 裁定 3 — リボンの扱い

#### 選択肢

| 案 | 形 | 評価 |
| --- | --- | --- |
| **A（推奨）** | **左リボンを撤去し、container/on/bottom-band header に寄せる** | 強調方向と surface hierarchy が錨カードに揃う。既存 semantic token だけで実現できる。 |
| B | 左リボンを正式 token 化して残す | 色値の逸脱は消えるが、左方向の強調という design language の不一致は残る。 |
| C | bottom-band header と左リボンを併用する | 同じ意味を二重強調し、狭い compact slot の幅も失う。 |

#### 採用仕様

- `.weather-change` の `border-left` を撤去する。
- 更新欄の内側に `header > title + meta` を設ける。DOM の階層だけを `WeatherAlertCard` に倣い、物理表現は一つの container box、その on-color text、下端 band とする。上端 band は作らない。
- 外周 `.weather-change` が `overflow: hidden` と `--radius-m` を持ち、内側 header 自体には独自 radius を持たせない。
- local header は `.change-header` とし、主 header の `.heading` class を付けない。`background: var(--header-weatherWarning-container)`、`color: var(--header-weatherWarning-on)`、`border-bottom: var(--header-band-width) solid var(--header-band-weatherWarning)` へ接続する。親 panel の主 header は L4 で同じ weatherWarning 三変数を使い、L5 では後段 `.level-5 .heading` の `background: #fff`、`color: #000`、黒い bottom band が勝つ現行 cascade を無変更で維持する（`WeatherEmergencyPanel.svelte:747-771`）。L5 の反転を local header へ伝播させない。
- local header は小見出しである。title は fixed `--type-label-l-size` + `--type-label-weight-emphasized`、meta は fixed `--type-label-xs-size` + `--type-label-weight`、padding / gap は Phase 0 の spacing token を `--panel-scale` で拡縮する。主 panel 用 `--panel-header-font-size` / `--panel-header-padding-v` / `--panel-header-padding-h` / `--panel-header-min-h` と standby 用 `.standby-card-header` / fluid type は使わない。
- title は「今回の変更」、meta は `VPWS50 · {総件数}件` とする。source と総数を視覚・支援技術の双方で確認できること。
- `aria-live` は header/summary の一箇所に限定し、各 chip の再配置を個別読み上げさせない。

### 3.4 probe / live、ページ送り、stage / rotation の契約

- measurement shelf は live と同じ grouped-header / chip / tail component または同一 snippet を render する。probe 専用の短縮 DOM、別 padding、別 font、別 `display` を作らない。
- shelf 自体は既存どおり `aria-hidden`、`inert`、`pointer-events: none` とし、画面外に置く。測定対象を `display: none` にしない。
- 更新欄全体と group atom の測定は `measureBorderHeight` を使い、content-box 高や `scrollHeight` を意思決定の主値にしない。
- 確定後の probe と live は width / height とも差が 1 CSS px 以下でなければならない。
- 対象地域の既存 cycler 以外に pager、interval、rotation reset key を追加しない。更新欄の縮約は静的 atom である。
- standby stage solver は変更しない。alignment capture を回帰確認として実行し、既存の stage / placement / rotation 期待が変わらないことを確認する。
- 自然高により対象地域の page count / ranges は変わってよい。不変なのは地域の論理 identity、入力順、重複なし、全件到達性であり、物理 page identity ではない。
- range が変わったら `weatherAreaFragmentKey(groupKey, start, endExclusive)`、`weatherPartitionSignature(publicPages)`、`weatherPageCyclerResetKey(partitionSignature)` を新 range から再生成する（`display/frontend/src/lib/weather-panel.ts:271-278,649-659`）。旧 range の key を再利用しない。
- reset 後の active index は必ず `0 <= index < pageCount` へ収束させる。新 activation の final partition では、`resolveWeatherInitialPageIndex` による追加地域を含む page の初期選択を維持する（同 `:662-675`; `WeatherEmergencyPanel.svelte:382-407`）。同一 activation 内の geometry-only 再 partition は既存 reset-key 規則どおり index 0 へ戻してよい。
- 変更前後の page count / ranges、range 由来 key、初期 active index と、論理全項目が一度ずつ現れる証拠を残す。期待表は理由なしに更新しない。

### 3.5 fixture 裁定

#### 2026-08-27 秋田・富山 L4 の実電文 corpus

**要る。しかも before/after の二通一組が必要だ。** 初報単票では `displayDiff` が生成されないため、観測事象を回帰 fixture にするには同一系列の直前報と当該報が要る。

現 checkout にある実 VPWS50 は `test/fixtures/15_18_01_250630_VPWS50.xml` のみで、2019-10-12 の電文である（同 `:1-21`）。秋田と富山を含む（同 `:295-300,591-596`）ため parser・地域名の補助回帰には使えるが、2026-08-27 の真実源の代用とは表記しない。

実装時は、利用許諾のある 2026-08-27 の順序付き raw XML を、先行する種別⇔地域 spec が所有する `test/fixtures/weather-alert-kind-area/2026-08-27-*.xml` と同 directory の provenance manifest に一度だけ追加する。取得元、取得日時、利用条件、各 raw byte の SHA-256、匿名化・改行・整形の有無を記録する。本仕様はその pair を消費し、別名の複製や第二 manifest を作らない。取得できない場合は受入を「実 corpus 未充足」と明記し、synthetic だけで観測再現済みと扱わない。

#### 大量変更 synthetic fixture

**必須だ。** engine 差分 14 件の before/after pair を作る。その内訳を **表示可能な論理変更 13 件 + DTO 化前に除外される code-only `kindChanged` 1 件** とし、frontend 候補上限 12 の境界を跨ぐ。code-only 除外点は `src/engine/display/weather-change-store.ts:53-68`、frontend の防御的な同値判定は `display/frontend/src/lib/weather-panel.ts:715-721` である。

fixture は次を全て含む。

- 五区分すべて。
- 秋田・富山の地域名。
- `upgraded` と `released` の共存。
- 折返しを起こし得る長い地域名または警報種別。
- 表示対象になる `kindChanged` を表示可能 13 件の内側に含め、code だけが変わり表示上は同値となる非表示 `kindChanged` 1 件を別枠にする。
- fixture から DOM と独立に生成した oracle。最低限 `engineDiffCount=14`、`codeOnlyCount=1`、`displayableLogicalCount=13`、区分別表示可能総数、transport mode、wire `changes.length`、wire omitted 合計、表示 chip 数、UI omitted 数を別々に持つ。

wire oracle は次を固定する。full が payload 予算内なら 13 件を受信できる。縮退時は 12 / 4 / 2 件と区分別 omitted を受信し、最終段は `weatherChange=null` である。非 null の各段で `wire changes.length + wire omitted 合計 = 13`、UI で `表示 chip 数 + UI omitted 数 = 13` を満たす。code-only 1 件はどちらの 13 にも加えない。

各 capture record は、先行 schema の `phase=base|after` を変更せず、統合点を示す別 field `checkpoint=kind-area-after|change-density-after` を追加する。本仕様の比較では base record を `phase=base, checkpoint=kind-area-after`、after record を `phase=after, checkpoint=change-density-after` とする。そのうえで `fixtureId`、`fixtureProvenance=actual|synthetic`、`baselineOid`、`manifestHash`、`viewport`、`panelMode=normal|compact`、`transportMode=full|degraded-12|degraded-4|degraded-2|null`、`engineDiffCount`、`codeOnlyCount`、`displayableLogicalCount`、区分別 logical count、`wireChangeCount`、`wireOmittedCount`、`uiChipCount`、`uiOmittedCount`、`allowedDeltaReason` を必須 field とする。field 欠落、`phase` 値の拡張、phase/checkpoint の不正な組合せ、DOM から逆算した logical oracle、上の恒等式不成立は capture command の非 0 終了とする。

preview には単独 weather panel（通常）と mixed emergency panel（compact）の二 scenario を用意する。既存 preview weather fixture（`display/frontend/src/preview/fixtures.ts:2514-2560`）は `change` を持たないため、変更欄専用 scenario を別に置く。capture は `.weather-panel` と `.weather-change` の live/shelf geometry を記録できるようにする。

### 3.6 種別⇔地域 spec との直列化

共有相手は `docs/specs/2026-09-06-weather-alert-card-kind-area-association.md` である。同 spec も `display/frontend/src/preview/fixtures.ts`、`display/frontend/src/preview/PreviewApp.svelte`、`display/scripts/capture-legacy-standby.mjs`、2026-08-27 corpus / provenance を対象にする（同 `:123-147`）。並行実装は禁止し、次の順序へ固定する。

1. 種別⇔地域変更を先に main へ統合し、同 spec §5 の全 gate を通す。
2. その **合格済み HEAD OID**、fixture manifest hash、1920×1080 / 1280×720 の capture report ID と全 tick 結果を `kind-area-after` baseline として固定する。
3. 本密度変更はその同一 HEAD から開始する。共有三ファイルの base は必ず `kind-area-after` とし、統合前 main や両変更の混在 worktree を base にしない。
4. raw corpus / provenance manifest の owner は種別⇔地域変更とし、本仕様は read-only consumer になる。本仕様固有の synthetic change-density scenario だけを明確な namespace で追記し、raw の複製、別 manifest、同名 fixture を作らない。
5. 本仕様の base/after は同じ Chrome、font、真の viewport、fixture、tick で `kind-area-after` と `change-density-after` を比較する。先行 spec または manifest が後から変わった場合は baseline を stale とし、密度変更の capture を全て採り直す。

## 4. 対象ファイル

### 4.1 実装で変更する予定のファイル

- `display/frontend/src/components/WeatherEmergencyPanel.svelte`
  - grouped header/chip/tail DOM、左リボン撤去、candidate shelf、fit 選択、対象地域再測定。
- `display/frontend/src/lib/weather-panel.ts`
  - 五区分 grouping と、12 / 4 から代表を減らす純粋関数。既存優先順を保持する。
- `display/frontend/src/components/__tests__/emergency.test.ts`
  - DOM、区分、縮約、compact、probe/live、高さと対象地域 pagination の component test。
- `display/frontend/src/lib/__tests__/weather-change.test.ts`
  - 代表予約、五区分、`ほか N 件`、0 件 fallback の純粋関数 test。
- `display/frontend/src/preview/fixtures.ts`
- `display/frontend/src/preview/PreviewApp.svelte`
  - `kind-area-after` 統合後に、本仕様固有 namespace の synthetic capture scenario だけを追加する。
- `display/scripts/capture-legacy-standby.mjs`
  - `kind-area-after` の report schema を保ったまま、weather emergency panel、change surface、reserve shell、全 fit candidate の geometry / overflow / probe-live、独立 oracle、許容理由 enum を追記する。
- `test/fixtures/weather-alert-kind-area/synthetic-vpws50-change-density-before.xml`, `test/fixtures/weather-alert-kind-area/synthetic-vpws50-change-density-after.xml`
  - engine 14 件 / 表示可能 13 件を作る本仕様固有 pair。先行 fixture と名前を共有しない。
- 必要なら `test/engine/messages/vpws50-state-display.test.ts`
  - fixture を通した五区分、engine 14 / DTO 13 件境界、code-only 除外の確認だけ。分類ロジックの変更はしない。

### 4.2 原則変更しないファイル

- `src/engine/messages/vpws50-state.ts`
- `src/engine/display/weather-change-store.ts`
- `src/engine/display/http-server.ts`
- wire protocol / schema
- `display/frontend/src/components/StandbyScreen.svelte` と stage/rotation solver
- `display/frontend/src/lib/theme.css` の token 値
- `display/frontend/src/lib/measure-height.ts`（既存 helper で足りる。汎用的不具合が実証された場合だけ別裁定にする）
- `test/fixtures/weather-alert-kind-area/2026-08-27-*.xml` と同 directory の provenance manifest（先行する種別⇔地域 spec の所有物。本仕様は read-only で消費する）

共有三ファイルと corpus は 3.6 の直列化後だけ変更する。実装中に先行 spec の差分が未統合・再変更された場合、本仕様の作業を止めて新しい `kind-area-after` baseline を採り直す。

## 5. 受入条件

### 5.1 機能・意味

- [ ] 更新欄は五区分を 3.1 の順に group 化し、0 件 group を出さない。
- [ ] `added` / `released` / 三種の遷移で 3.1 の文言を満たし、区分名を chip ごとに反復しない。
- [ ] summary または header meta から、source `VPWS50`、論理総数、区分別総数を text として取得できる。
- [ ] engine の `computeDisplayDiff`、TTL、wire schema、wire の full / 縮退 12 / 4 / 2 / null 段に差分がない。
- [ ] 更新欄に page control、interval、scroll container、tab stop を追加していない。

### 5.2 密度・縮約

- [ ] synthetic before/after が engine 差分 14 件を生成し、そのうち code-only 1 件を除いた表示可能論理変更 13 件が五区分に属する。通常と compact の双方で `ほか N 件` が表示され、`N = 13 - 表示 chip 数` が成立する。
- [ ] full / 縮退 12 / 4 / 2 の各非 null transport case で、`wire changes + wire omitted = 13`、`表示 chip + UI omitted = 13` を満たす。full wire の `changes.length=13` を許容し、null case では更新欄が存在しない。
- [ ] 表示可能 13 件 fixture で全件を無条件に縦積みせず、縮約が実際に起きる。本仕様では内部改ページを合格代替にしない。
- [ ] 通常は最大 12、compact は最大 4 から fit 探索を始め、budget 内の最大候補を選ぶ。
- [ ] `upgraded` と `released` が共存する target viewport では、両区分の chip を最低 1 件ずつ表示する。
- [ ] summary-only は未測定初回または chip 1 件も安全に置けない geometry だけである。

### 5.3 意匠

- [ ] `.weather-change` の computed style に左側だけの 4px semantic ribbon がなく、`border-left-width` は他辺と同じ hairline である。
- [ ] 更新欄 header は一つの `header > title + meta` box で、computed background / color / bottom border が `--header-weatherWarning-container` / `--header-weatherWarning-on` / `--header-band-weatherWarning` に一致する。物理的な上端 band がない。
- [ ] 更新欄に `.standby-card-header` class と主 panel 用 `--panel-header-font-size` / `--panel-header-padding-v` / `--panel-header-padding-h` / `--panel-header-min-h` を使っていない。
- [ ] 親 panel header は L4 で `--header-weatherWarning-container` / `--header-weatherWarning-on` / `--header-band-weatherWarning` に一致し、L5 で既存 cascade 後の正規化済み computed background が white (`rgb(255, 255, 255)`)、color / bottom-border-color が black (`rgb(0, 0, 0)`) に一致する。更新欄 `.change-header` は `.heading` class を持たず、L4/L5 とも weatherWarning 三変数のままである。
- [ ] surface、hairline、radius、elevation、spacing、type に Phase 0 の token を使い、新しい raw color / 同義 token を追加していない。
- [ ] outer surface が radius と clipping を担い、内側 header に独自 radius がない。
- [ ] 4 capture すべてで chip の computed font-size は 14px 以上、summary / meta / omitted tail は 12px 以上である（`docs/specs/display-design-system.md:303-312`）。
- [ ] capture は `--panel-scale` の出典を `runtime-1.5 | consumer-fallback-1` として記録する。full layout は inherited custom property `1.5`、それ以外は property 未注入かつ consumer の computed geometry が倍率 `1` であり、theme root 由来と報告しない。

### 5.4 真の viewport と overflow

capture は browser の outer size ではなく `window.innerWidth × window.innerHeight` が次の値になったことを記録し、`document.fonts.ready` と layout settling 完了後の連続安定 sample で判定する。

| viewport | scenario | 必須状態 |
| --- | --- | --- |
| 1920×1080 | weather 単独 / normal | 表示可能 13 件 synthetic が縮約され、更新欄と対象地域が可視 |
| 1920×1080 | mixed emergency / compact | 表示可能 13 件 synthetic が縮約され、予約二区分が可視 |
| 1280×720 | weather 単独 / normal | 縮約後も対象地域最低高を維持 |
| 1280×720 | mixed emergency / compact | summary-only に逃げず、予約二区分が可視 |

各 capture で次を数値出力し、すべて 0 を要求する。

- document の横・縦 overflow。
- `.weather-panel`, `.weather-change`, change header, group list, 各 group, 各 chip, omitted tail, 対象地域 frame の `max(0, scrollWidth - clientWidth)` と `max(0, scrollHeight - clientHeight)`。
- viewport 外へ出た bounding rect の左右上下差分。

さらに 4 capture すべてで `data-change-layout-unresolved="false"`、`data-change-measurement-nonconverged="false"`、`data-change-measurement-settled="true"` を要求する。属性欠落を false とみなさない。

### 5.5 border-box 測定と probe/live 一致

- [ ] shelf は live と同じ width、DOM、class、font、padding、border、gap、chip 内容を使う。
- [ ] reserve shell は main heading、hero、alert names、action、sub section、tiles padding / gaps / borders、合法な対象地域最小一ページを含む。fixture ごとに各占有高、`Hreserve`、`Hpanel`、`B=Hpanel-Hreserve` を report する。
- [ ] 更新欄全体と group atom は `measureBorderHeight` による border-box 実高で判定し、`.weather-change-slot` が旧 margin 相当の全外側 inset / gap を含む。候補の外側に未計上 margin がない。
- [ ] 4 capture すべてで、確定した probe と live の width 差・height 差が各 1 CSS px 以下である。
- [ ] font/layout settling 中の値を確定せず、pending 中は直前の確定 layout、初回だけ summary-only を表示する。
- [ ] candidate-independent budget を使い、同じ fixture で候補数が二値振動しない。一つの outer epoch で `n=0..limit` の候補を同一 batch で測り、一度だけ選択を publish する。安定 sample 中に表示数、change height、対象地域 page count が不変である。
- [ ] measurement identity report に change / activation key、compact、panel border-box width / height、`B`、`Hreserve`、非変更内容 fingerprint、表示可能論理 fingerprint、font / settling epoch が揃う。各 field を一つずつ変えた test で旧 cache result を hit しない。
- [ ] `data-change-measurement-pass` は measurement identity ごとに 0 へ reset し、異なる `{Bq, selected n}` の outer publish だけを数える。初回は1、同値 `ResizeObserver` 通知、`layoutState=pending`、fragment candidate 測定、split-only refinement は増分0である。report の `Bq` は `round(B * devicePixelRatio) / devicePixelRatio` と一致する。
- [ ] 5回以上の正常な partition split を必要とする fixture が、outer pass 1のまま `layoutState=ready` と連続二 sample 一致へ到達し、`data-change-measurement-nonconverged="false"` になる。別 fixture で5回目の異なる outer publish を試みた場合だけ nonconverged=true・非0終了になる。

### 5.6 ページ送り・stage・期待表

- [ ] 更新欄の自然高変更後に対象地域を再分割し、全論理地域 identity が既存順でちょうど一度、いずれかの page range に含まれる。物理 page identity の一致は要求しない。
- [ ] page count / range が変わる case で fragment key、partition signature、cycler reset key が新 range から再生成され、旧 key と異なる。active index は範囲内へ収束し、新 activation の初期 page は追加地域を含む既存選択規則に一致する。
- [ ] 変更前後の対象地域 page count / ranges / range-derived keys / active index を test と capture artifact に記録する。変化があれば許容理由 enum と自然高差を添える。
- [ ] 更新欄用の page、timer、rotation reset key、standby stage を追加していない。
- [ ] standby design-alignment の既存 viewport matrix を **全 rotation tick** で走査し、`kind-area-after` に対して stage / compressed / placement、visible card の集合と順序、rotation keys / active key / position、failure count、omitted count を完全一致させる。baseline が 0 の failure / omitted は after も 0 とする。
- [ ] 各 standby tick で `data-layout-unresolved="false"`、`data-measurement-settled="true"`、`data-measurement-nonconverged="false"`、card/readable overflow 0 を満たす（現行属性: `display/frontend/src/components/StandbyScreen.svelte:1982-2005`; 規範: `docs/specs/2026-09-05-standby-card-design-alignment.md:513-520`）。単一 tick の成功で代用しない。
- [ ] capture schema の `allowedDeltaReason` は先行値を保って `none | weather-kind-group-page-metadata | vpws50-change-target-area-repartition` に拡張する。本仕様の base/after record で許せる非 `none` は最後の値だけで、対象地域 page count / ranges、range-derived fragment key / partition signature / cycler reset key / initial active index 以外の差を免除しない。
- [ ] 既存期待表を更新する場合は、fixture から独立生成した oracle、旧期待、実測前後、上記理由 enum、論理データ不変の証拠を同じ変更に残す。DOM を oracle にすること、enum 外の理由、assertion の削除、許容差だけの拡大、理由なしの snapshot 更新を合格にしない（`docs/specs/2026-09-05-standby-card-page-footer-contract.md:189-200`; `docs/specs/2026-09-05-standby-card-design-alignment.md:513-520`）。
- [ ] 現行 component test の通常 4 / compact 2 期待を更新する際は、「2026-08-27 観測に基づく幅利用と、本仕様の測定式上限へ置換」と理由を明記し、区分・文言・代表予約の assertion は保持する。

### 5.7 fixture と検証コマンド

- [ ] 2026-08-27 秋田・富山 L4 の順序付き raw before/after pair が共有 directory と単一 provenance manifest に存在する。存在しなければ本項を未充足として報告し、重複 fixture を作らない。
- [ ] 2019-10-12 corpus を使う場合、補助回帰と明記し、2026-08-27 corpus と誤記しない。
- [ ] synthetic fixture は engine 14 件 = 表示可能 13 件 + code-only 1 件で、五区分、秋田、富山、長文、予約二区分、表示可能 / 非表示の `kindChanged` を含む。oracle は fixture source から生成し、DOM 集計値から生成しない。
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run test:shuffle`（module scope の可変状態、共有 timer、永続化を触った場合は必須）
- [ ] `npm run typecheck:test`（変更 test が `tsconfig.test.json` の対象に含まれる場合）
- [ ] `npm run display:build`
- [ ] `npm run display:test`
- [ ] `npm --prefix display run typecheck`
- [ ] `npm --prefix display run docs:design:check`

### 5.8 共有物と baseline の直列化 gate

- [ ] 種別⇔地域 spec が先に統合済みで、その全受入条件が成功している。
- [ ] `kind-area-after` baseline に HEAD OID、manifest hash、Chrome / font、真の viewport、capture report ID、全 rotation tick が記録されている。
- [ ] 本仕様の実装開始 OID と `kind-area-after` の HEAD OID が一致する。不一致なら capture を開始せず baseline を採り直す。
- [ ] shared preview fixture / PreviewApp / capture script に両 spec の未統合差分が同時存在しない。
- [ ] report schema は先行する `phase=base|after` を保つ。base は `phase=base, checkpoint=kind-area-after`、after は `phase=after, checkpoint=change-density-after` の完全一致とし、旧 reader が `phase` をそのまま解釈できる。
- [ ] `change-density-after` は同一環境で `kind-area-after` と比較され、5.6 の非退行 gate を満たす。先行 spec または共有 manifest の hash が変わった record は stale として失敗する。

## 6. 裁定ラベル（案）

| ラベル | 裁定 |
| --- | --- |
| **対象** | VPWS50 `WeatherEmergencyPanel` の「今回の変更」欄、選別表示、measurement shelf、対象地域再分割、fixture/capture/test。 |
| **許容変更** | group + wrapping chip 化、通常 12 / compact 4 からの実高 fit、`ほか N 件`、container/on/bottom-band local header、自然高に伴う対象地域 page ranges と range-derived keys の変更。 |
| **禁止変更** | engine の差分意味、TTL、wire/schema と full / 縮退段、standby solver、更新欄内ページ送り、意味色追加、clip/scroll による隠蔽、論理地域の欠落・順序変更、種別⇔地域 spec と共有物を並行編集すること、raw corpus / provenance の複製。 |
| **配送先** | 最終対象は **main / personal / Pi のすべて**。種別⇔地域変更を main へ先行統合し、その合格 HEAD から本変更を main へ統合する。その後 personal で真の 1920×1080・1280×720 capture、合格 artifact 確認後に Pi。Pi は実機 viewport / font / 全 fit 診断の安定を gate とする。 |
| **ロールバック** | grouped change surface と fit 選択を一単位で戻し、既存 4 / 2 行表示へ戻す。engine/store/protocol を触らないため、データ移行や wire rollback は不要。 |
| **受入条件** | 5 章の全項目。特に直列 baseline、4 viewport/scenario の overflow 0・unresolved / nonconverged false、engine 14 / 表示可能 13 件での縮約、probe/live 1px 以内、compact 文字下限、対象地域全件保持、全 rotation tick の visible / failure / omitted 一致を必須 gate とする。 |
