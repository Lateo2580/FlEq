# 気象危険警報カードの種別・地域対応を保つ spec

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


## 1. 症状

ご主人が 2026-08-27 の秋田・富山 L4 事象で観測した症状は、`WeatherAlertCard`（header が「気象危険警報」となる待機カード）に複数の警報種別と県別地域が並ぶと、どの地域がどの種別に属するかを一瞥で確定できないことだった。左列に種別見出しが続き、右列に地域群が続く組版になり、読む側が列を横断して対応を推測する必要があった。この観測記録を症状の真実源とし、現 checkout の既存 corpus を当日の再現資料とはみなさない。

`test/fixtures/15_18_01_250630_VPWS50.xml:1-21` は 2019-10-12 の全国集約 VPWS50 である。同 corpus は粗い府県レイヤーに秋田県を `:295-300`、富山県を `:591-596` に含むが、引用可能な code 49 は `:363-372` では茨城県、`:663-672` では山梨県に属する。さらに parser は市町村等の最細粒度レイヤーを優先する（`src/dmdata/weather-parser.ts:90-108`）。従って、この corpus の役割は parser、code 49、入力順、layer 選択の**補助回帰**に限定し、2026-08-27 の秋田・富山 L4 や画面症状の再現済み証拠とは呼ばない。

実装時は、(a) 利用許諾を確認した 2026-08-27 の raw XML から観測画面の state を再構成できる最小の順序付き電文集合と provenance、(b) その表示形を小さく固定した synthetic preview fixture を別々に用意する。raw XML を取得できない場合も synthetic fixture で DOM / geometry の実装は検証できるが、受入結果には「観測形の synthetic 再現、2026-08-27 実 corpus 未充足」と明記し、実 corpus 検証済みへ格上げしない。既存 max fixture `display/frontend/src/preview/fixtures.ts:2578-2583` と capture 側入力 `display/scripts/capture-legacy-standby.mjs:1036-1050` も密度の補助資料であり、当日再現 fixture の代用にはしない。

単一種別では種別がカード全体へ自然に掛かるため症状は起きにくい。複数種別・複数地域、特に L4 と通常警報が混在する場合を主対象とする。

## 2. 根因（file:line）

1. `WeatherAlertCard` は、wire の item を kindKey ごとに source 横断で統合し、地域を union する（`display/frontend/src/components/WeatherAlertCard.svelte:120-159`）。この段階では種別と地域の対応は失われていない。
2. visible page は area 一件ごとの `pageCandidates` で構成され（同 `:161-210`）、現在 page の地域だけを item ごとへ戻している（同 `:229-252`）。したがって一つの種別が複数 page に分かれ得る。
3. DOM は `ul > li[data-kind-key] > .kind + .pref-group*` で、種別と地域には最小限の親子関係がある（同 `:436-458`）。しかし種別を明示した semantic group / label relationship はなく、CSS の視覚的な group 境界とテスト可能な DOM 契約がない。
4. 本文 `ul` は `column-count: 2; column-fill: balance`、`li` は `break-inside: auto` である（同 `:486-502`）。`pref-group` だけが `break-inside: avoid`（同 `:520-529`）なので、同じ `li` の `.kind` と後続 `.pref-group` は multicol fragment として別列へ分かれ得る。DOM 上は親子でも、画面上の対応線が消える直接原因はこの分断である。
5. 横幅・高さは右上カードの `max-height: min(44vh, 280px)`（同 `:465-477`）と live / measurement shelf の実高で管理される。`StandbyScreen` は weather を side / center の preflight で別々に測る（`display/frontend/src/components/StandbyScreen.svelte:2115-2119,2153-2159`）ため、組版の高さ増を CSS 補償だけで隠すと probe と live の整合を壊す。
6. 同カードは weather pager と tornado rider pager を同居させる。tornado page は全 weather page との組合せが確認されるまで publish しない（`WeatherAlertCard.svelte:288-356`、その組合せを固定するテスト `__tests__/weather-alert-card.test.ts:535-552`）。weather 側の page 範囲が変われば、rider 側も全組合せを再測定する必要がある。

従って「種別と地域の DOM 上の親子が全くない」は現状の事実ではない。問題は、親子を利用者が読める不可分の視覚 group にしておらず、CSS columns がその group を断片化できる点にある。

## 3. 変更

### 3.1 先行申告: 意匠の錨と使用 token

本変更の錨カードは、共通 header / footer の正系である WeatherAlertCard 自身と、通常フロー footer の契約である FloodCard / FloodWideCard とする。後者を正系と明記した根拠は `docs/specs/2026-09-05-standby-card-page-footer-contract.md:18-24,32-64`、WeatherAlertCard の四 row（header / body / footer / rider）契約は同 spec `:83-90` である。header は同カードの `.standby-card-header` 接続を維持し、色 role・header tone は変更しない。

使用する既存 token は次に限定する。新しい色値、spacing 値、card 高 token は追加しない。

| 用途 | token | 根拠 |
|---|---|---|
| カード面・境界・形状 | `--surface-standby`, `--hairline`, `--radius-standby`, `--elevation-2` | `display/frontend/src/lib/theme.css:169-175,195-203` と現カード `WeatherAlertCard.svelte:465-469` |
| 警報種別の意味色 | `--role-weatherEmergency`, `--role-weatherWarning`, `--role-weatherAdvisory` | `theme.css:57-74`、現 `.rank-* .kind` `WeatherAlertCard.svelte:507-519` |
| 基本文字・地域補足 | `--fg`, `--role-muted`, `--type-body-weight-emphasized`, `--type-label-l-fluid`, `--type-body-s-fluid`, `--type-label-s-fluid` | `theme.css:32-34,74,123-159`、現地域組版 `WeatherAlertCard.svelte:520-555` |
| group 間隔・本文 gutter | `--space-1`, `--space-2`, `--space-3`, `--space-4` | `theme.css:199-211`、現本文 `WeatherAlertCard.svelte:486-495,520-528` |
| header / page footer | `--header-weather*-container/on/band`, `--header-band-width`, `--type-title-s-fluid`, footer の `--space-1`, `--space-4`, `--radius-s`, `--type-label-xs-size` | `theme.css:99-110,280-334` |

`display-design-system.md` は WeatherAlertCard を、280px 上限・省略の可視化・header/body/footer/rider の通常フローを持つカードとして規定する（`docs/specs/display-design-system.md:241-243,255-261`）。この規範に従い、密度を保つための負 margin、局所 padding 縮小、absolute 化、または multi-kind 本文の収容失敗を隠す新規 clip / ellipsis は採らない。既存外殻の `overflow: hidden` は containment として、tornado の既存最終 `clip-rider` は infeasible 防衛として維持する。

### 3.2 裁定点 1 — 構造

| 案 | 内容 | 多種別・多地域時の高さ / rotation | 判定 |
|---|---|---|---|
| A. 種別ごとの縦 group | 複数種別時だけ、各種別を `li[data-weather-kind-group]` とし、左に種別、右にその地域群を置く二列 grid を一つの視覚 group とする。group 間を縦に積み、カード本文には CSS multicol を使わない。`aria-labelledby` で group と種別を結び、地域群は当該 group の子だけにする。 | 二列本文より高くなり得る。実高を shelf で測り、weather card 内の page range / page count は変わり得る。ただし外側の card rotation、表示カード集合、solver omitted、選抜地域数は §3.5 の非退行 gate を越えて悪化させない。 | **推奨・採用案**。種別と地域を同じ視線の行に固定し、DOM と視覚を同じ group 境界にする。 |
| B. 区切り線 + 行揃え | 現在の二 column flow を維持し、種別間へ hairline を入れ、種別と最初の地域だけを揃える。 | 高さ増は小さいが、折返し・column balance 後に後続地域が別列へ移るため対応が再び曖昧になる。page / rotation への影響は小さいが症状を根治しない。 | 不採用。 |
| C. 地域行への種別 badge | 各県・地域行に短縮種別 badge を繰り返す。 | 種別名の重複と badge 折返しで、地域数に比例して最も高くなる。ページ数・rotation が増え、L4 の長い名称を短縮すると意味を失う。 | 不採用。 |

採用案の DOM は概念上次とする（class 名は実装で固定する）。

```text
ul[data-page-probe-body][data-weather-kind-layout=multi]
  li[data-weather-kind-group][data-kind-key][aria-labelledby=INSTANCE-weather-kind-…]
    span#INSTANCE-weather-kind-….weather-kind-group__kind   ← 種別
    div.weather-kind-group__areas                   ← この種別の .pref-group* と .omitted
```

`li` の outer identity は既存 `data-kind-key` を維持する。kind は `white-space: nowrap` を維持し、地域側だけを折り返す。group を CSS columns の中で分けないのではなく、複数種別形では columns 自体を止める。このため、kind 見出しだけが左列、地域だけが右列へ流れる経路を構造的に除去できる。

`INSTANCE` は `kindKey` から作らず、Svelte 5 の `$props.id()` または同等の SSR / hydration 安定な component-instance prefix を用いる。同じ content を持つ live、side shelf、center shelf、forced probe が同時に存在しても document-wide に ID が重複してはならない。`aria-labelledby` の参照先は必ず当該 `li` 内の種別要素である。

### 3.3 裁定点 2 — 高さ増と page atom

| 案 | 内容 | page / rider / rotation への影響 | 判定 |
|---|---|---|---|
| A. 種別 group fragment を表示 atom にする | 各 page では `kindKey` ごとに連続する地域と tail を一つの `data-weather-kind-group` として描く。同種別が page 境界を越える場合は、次 page に同じ種別見出しを再掲し、その page の地域だけを同じ group に入れる。group の内部を visual columns / page 内で分割しない。 | CSS grid 化の実高で partition を再測定する。card 内の page range と page count は変わり得る。tornado の `weatherPages × tornadoPages` probe は side / center ごとに新 range の完全 Cartesian 積を再実行する。page が複数なら既存 footer を表示する。外側 rotation と地域 omitted の悪化は許さない。 | **推奨・採用案**。一画面で読める group を atom とし、既存の area identity を温存する。 |
| B. 既存 area atom のまま | `pageCandidates` と range だけを残し、page 内の種別見出しを先頭で一度だけ出す。 | 実装差分は小さいが、page 先頭でない地域群の種別が見えず、group が page / line wrap で再び切れる。 | 不採用。 |

採用案は `pageCandidates` の occurrence-aware area vector、`weatherPagerLogicalItems`、kind ごとの `omittedAreaCount` sentinel を変更しない（`WeatherAlertCard.svelte:161-195,400-420`）。pager key / namespace と concrete page identity の**生成規則**、診断用 logical / `data-weather-pager-reset-items` vector の内容・順序を維持し、range から `visibleItems` を再構成した後の表示 group を変更する。final range が変われば、それを入力にした concrete page identity 列は §5.12 の許可差分として変わり得る。固定対象は生成規則、occurrence-aware logical vector、sentinel であり、旧 range から生成された concrete identity 列ではない。weather の `pageCoordinator.register()` は `resetKey` を渡しておらず（同 `:215-221`）、scheduler は省略時に空文字を使う（`display/frontend/src/lib/legacy-standby/time-slice-scheduler.svelte.ts:603-628`）。従って、この診断 vector を scheduler の「reset 元」とは呼ばない。

これは巨大な一種別を「全地域を一枚へ強制して infeasible」にする案ではない。range 内の連続 fragment を独立した group にし、続ページで見出しを再掲するため、既存の area 単位 partition の情報到達性と高さ上限を両立する。

`sequentialPartitionRanges()` は測定値が許す最大連続接頭辞を page にし、未測定 candidate には provisional range を返す（`display/frontend/src/lib/legacy-standby/page-partition.ts:264-305`）。weather はその pending provisional range を現行どおり coordinator へ登録・表示する（`WeatherAlertCard.svelte:197-227`）。一方、tornado は全 required composition の確定まで旧 confirmed registration を維持する（同 `:288-356`）。両者を「測定済み page だけ atomic publish」と一括りにしない。partition algorithm / scheduler API は変更しない。range と `data-card-page-identities` は footer spec の診断値であり、自然高差で変わり得る（`2026-09-05-standby-card-page-footer-contract.md:88-90`）。

#### 3.3.1 footer chrome を含む probe / live 一致

現行 normal measurement shelf は `pageCandidates.length > 8 || pageTruncated` から footer を推定する（`WeatherAlertCard.svelte:255-275`）。multi-kind grid では 8 candidate 以下でも実高で複数 page になり得るため、この件数 heuristic を final chrome の根拠に使わない。

footer 決定は同一 payload・placement・width に対する単調な二段階とする。

1. footer なし chrome の独立 cache generation で `sequentialPartitionRanges()` を candidate index 0 から実行し、全 candidate prefix を測定して provisional partition を得る。
2. 結果が複数 page、または truncated なら、footer あり chrome の**別の独立 cache generation**を開始する。第1段階の range / fit result を final 入力として流用せず、`sequentialPartitionRanges()` を candidate index 0 から再実行し、各 page boundary で全 candidate prefix を再探索して footer-present の final partition を得る。第1段階と同じ range が新 generation でも fit した結果として一致することだけは許す。footer の追加が page 数を減らすことはないため、ここから footer なしへ戻らない。
3. final が一 pageかつ非 truncated のときだけ footer なしを確定する。normal shelf、forced page shelf、live card は、この確定した同じ boolean を描く。

weather の page-fit / prefix cache identity には少なくとも独立 chrome generation、`placement`、実測 width、global `single|multi`、footer `absent|present`、range、tail、選抜地域数、logical payload fingerprint を含める。footer-absent / footer-present generation 間で range や fit result を cache hit させず、final chrome が確定するまで solver へ旧 geometry と新 geometry を混在させない。測定対象は card root と全 `[data-page-probe-readable]` で、header / body / **footer** / tornado rider を含む同じ shell とする（現行全 shell 測定は `StandbyScreen.svelte:1048-1111`）。確定後の shelf と live は footer の有無、width、border-box height、range ごとの fit 判定が一致し、rect 差は各 1 CSS px 以下でなければならない。

### 3.4 裁定点 3 — 単一種別

| 案 | 内容 | 判定 |
|---|---|---|
| A. 現状の二 column 地域組版を維持 | 種別数が 1 のときは、現 `ul` / `.pref-group` の二 column 表示を保つ。新 group data attribute は付けてもよいが、multi grid と separator は適用しない。 | **推奨・採用案**。対応の曖昧さがなく、既存の密度・高さ・page 期待を不用意に変えない。 |
| B. 常に種別 group grid | 一種別でも左に種別、右に地域を置く。 | 不採用。横幅を消費して高さ増だけを導入する。 |

種別数は source bucket 数でも現在 page の `visibleItems` 数でもなく、source 横断 union 後の global `items`（`WeatherAlertCard.svelte:123-159`）の `kindKey` 数で判定する。mode は card の存続中、全 page と measurement shelf で同じ `data-weather-kind-layout="single|multi"` として公開する。global multi-kind の続ページに一種別しか見えていなくても `multi` のままとする。複数 source bucket が同一 kind へ union された結果一種別なら `single` とする。vpws50 / vpww56 の同一 kind は今後も一 group へ統合し、重複地域を出さない（既存契約とテストは `display/frontend/src/components/__tests__/weather-alert-card.test.ts:710-780`）。

### 3.5 ページ送り、竜巻 rider、header / footer の不変条件

- weather pager の key は `weather`、tornado pager の key は `tornado` のままとし、両者の位置表示を統合しない。footer は weather page、rider 内 marker は tornado page を表す（`WeatherAlertCard.svelte:216-227,342-356,459-460`）。
- DOM 順は `header → body ul → weather footer → tornado rider` のままにする。四 row grid と通常フロー footer を壊さない（同 `:464-477,556`）。
- group grid による自然高差は footer を含む side / center shelf、rotation slot の live surface で測り直す。`StandbyScreen` が real card を rotation slot へ描く経路（`StandbyScreen.svelte:2221-2237`）を別実装で測ってはならない。
- 既存 selection は kind ごとに地域 prefix と omitted count を配る（`StandbyScreen.svelte:400-440`）。本変更は選抜、source union、総数、省略件数を変更しない。tail は該当 kind group の最後にだけ描く。
- 1920×1080 は footer spec の `fhdMax`、1280×720 は `hdMax` の base / after 契約（`docs/specs/2026-09-05-standby-card-page-footer-contract.md:140-145,187`）を維持する。両 viewport で visible card 集合、unresolved、overflow は完全一致、rotation keys / active set / failure count / omitted count は完全一致とする。1280×720 は stage / compressed / placement / rotation / Typhoon variant も完全一致する。1920×1080 は既存裁定どおり stage / compressed / rotation なし / omitted 0 / visible card 集合を一致させ、左右列の割当だけを診断値とする。
- selected weather rows は `after >= base`、kind 別 `omittedAreaCount` は `after <= base` を全 kind で満たす。新規 kind の欠落、別 kind への残置移動、総論理地域数の差は不可とする。高さ増を理由に地域の表示選抜を減らしてはならない。
- 許容する自動差分は weather card 内の page range / page count / range 由来 identity に限る。外側 rotation、visible card、stage / placement の既存固定項目、選抜地域、omitted の悪化は期待表更新で許可しない。満たせない場合は実装を blocked とし、footer contract を上書きする別の明示裁定を先に求める。
- 実測で A案が既存 layout gate を満たせない場合、card max-height の増加、文字縮小、scroll、multi-kind 本文の新規 clip / ellipsis、情報削除、B/C への無断切替をしてはならない。既存外殻 containment と tornado infeasible の最終 clip は維持する。実測値、影響した range / stage / rotation、代替案を記録して spec 裁定へ戻す。

本節は `docs/specs/standby-legacy-improvement.md:159` の「WeatherAlertCard は対象地域を二列組版する」を **global multi-kind のときだけ**上書きする。global single-kind の二列規範、外殻 `overflow: hidden`、`docs/specs/2026-08-23-tornado-card-paging.md:53-56` の tornado aggregate → final clip 防衛は上書きしない。

### 3.6 独立 DOC レビュー 8 点の裁定

| # | 裁定 | 根拠と反映先 |
|---:|---|---|
| 1 | **a) 採用** | 2019 corpus の日時・code 49 の帰属・parser の最細粒度優先から、2026-08-27 再現とする根拠がなかった。§1 と §5.1 で補助回帰へ訂正し、provenance 付き raw と synthetic を分離した。 |
| 2 | **a) 採用** | solver の weather 選抜量が実高へ依存し、`StandbyScreen.svelte:400-440` で omitted が増え得る。§3.5 と §5.9 で outer rotation / visible set の一致、selected rows / kind omitted の非退行を固定した。 |
| 3 | **a) 採用** | 現行の `> 8` footer heuristic は新 grid の実高 pagination を表せない。§3.3.1 と §5.7 で footer chrome の二段階測定、cache identity、shelf / live 一致を必須化した。 |
| 4 | **a) 採用** | provisional publish は weather、atomic confirmed publish は tornado だけであり、weather registration に `resetKey` はない。§3.3 と §5.10 の用語・受入条件を現実装へ合わせた。 |
| 5 | **a) 採用** | 既存 `toContain` test と report は Cartesian 完全性や変更理由を証明しない。§5.11–13 に side / center の Set 完全一致、pending identity、必須 report schema と stage 3 全 tick を定めた。 |
| 6 | **a) 採用** | live と複数 shelf が同時 DOM に存在するため kindKey 由来 ID は衝突する。§3.2 と §5.3 に instance prefix と document-wide 一意性を定めた。 |
| 7 | **a) 採用** | page の `visibleItems.length` で分岐すると page ごとに layout が反転する。§3.4 と §5.5 に global merged items 由来の安定 mode と二つの境界 test を定めた。 |
| 8 | **a) 採用** | 既存外殻 containment と tornado 最終防衛まで一律禁止すると既存 spec と衝突する。§3.1 / §3.5 / §6 で禁止を multi-kind 収容隠しの新規 clip に限定し、旧二列規範の上書き範囲を明示した。 |

### 3.7 再レビュー残点 2 件の裁定

| # | 裁定 | 根拠と反映先 |
|---:|---|---|
| 1 | **a) 採用** | final range と range 由来 identity の変化を許しながら concrete identity 列を固定するのは自己矛盾だった。§3.3 / §5.10 / §5.12 で、生成規則・logical vector・sentinel は不変、concrete identity 列は許可差分、と分離した。 |
| 2 | **a) 採用** | footer 追加で旧最大 prefix が fail した場合、旧 range の再測定だけでは新しい最大 prefix を得られない。§3.3.1 / §5.7 で footer-present の独立 generation と先頭からの全 prefix 再探索を必須化した。 |

## 4. 対象ファイル

実装対象:

- `display/frontend/src/components/WeatherAlertCard.svelte` — multi-kind group DOM / CSS、global layout mode、instance-unique label ID、page fragment での見出し再掲、確定 footer chrome。
- `display/frontend/src/components/StandbyScreen.svelte` — 新 group 実高と footer chrome を既存 side / center / rider probe へ通す measurement context / cache identity のみ。solver / stage API は変更しない。
- `test/fixtures/weather-alert-kind-area/2026-08-27-*.xml` および同 directory の provenance manifest — 利用許諾済み raw を取得できた場合だけ追加する。取得不能なら空の placeholder を作らず、受入報告を実 corpus 未充足とする。
- `display/frontend/src/preview/fixtures.ts` — 実 corpus と混同しない固定名の synthetic L4 multi-kind fixture と、8 candidate 以下で実高二 page になる footer 境界 fixture を追加する。
- `display/frontend/src/preview/PreviewApp.svelte` — 上記 fixture を単独で観測できる固定 hash scenario へ接続する。
- `display/scripts/capture-legacy-standby.mjs` — 1920×1080 / 1280×720 capture、DOM group assertion、probe / live chrome、non-regression、Cartesian probe、必須 report schema、理由 enum と非0終了 assertion。
- `docs/specs/display-design-system.md` — §5 の WeatherAlertCard 記述へ multi-kind の「種別 → 地域」group と single-kind 例外を追記する。§8 GENERATED は変更しない。

テスト対象:

- `display/frontend/src/components/__tests__/weather-alert-card.test.ts`
- `display/frontend/src/components/__tests__/standby.test.ts`
- `display/frontend/src/preview/__tests__/legacy-improved-mock.test.ts`
- parser → display の既存 weather corpus test または同責務の新規 test（2019 補助 corpus と、取得できた場合の 2026-08-27 raw を明確に別 case とする）
- capture script の既存 test（scenario / report / 非0終了 assertion の最小範囲）

変更対象外:

- parser、engine、protocol / wire、永続化、通知、CLI。
- `page-partition.ts` の algorithm、`time-slice-scheduler.svelte.ts` の API、pager namespace / key、logical item identity、weather registration の空 `resetKey` semantics。
- theme token の値、header tone / severity の意味、竜巻 paging 意味論、対象外カード。

## 5. 受入条件

1. **corpus の分離**: `test/fixtures/15_18_01_250630_VPWS50.xml` は 2019 補助 corpus と明記した test で parser / code 49 / layer 選択の実出力を固定し、秋田・富山 L4 の再現 assertion を置かない。2026-08-27 raw を追加する場合は、観測 state の再構成に必要な順序付き全電文、取得元、取得日時、利用条件、各 raw byte の SHA-256、匿名化・改行・整形の有無を provenance manifest に必須とする。欠落 field、hash 不一致、順序不足は test failure とする。取得できない場合は synthetic だけを残し、実装完了報告へ「2026-08-27 実 corpus 未充足」を残す。
2. **synthetic 観測形**: preview fixture は名前で synthetic と判別でき、L4 を含む異なる二 kindKey、各二地域以上、秋田県と富山県の地域、kind ごとに異なる地域集合を持つ。別に、総 page candidate 数が 8 以下なのに multi-kind grid の実高で二 page になる境界 fixture を持つ。source 横断同一 kind の union、同名異 code、kind 別 `omittedAreaCount` の既存 test は維持する。
3. **DOM と ID**: 各 `li[data-weather-kind-group]` は一意の `data-kind-key` と `aria-labelledby` を持ち、全 `.pref-group` / `.omitted` はちょうど一つの group の descendant である。同じ payload の live、side shelf、center shelf、forced probe を同時 mount した document で、全 label ID の出現数が1、`document.getElementById(labelId)` が当該 `li` の子、参照切れ0であることを test する。
4. **multi geometry**: global multi-kind では computed `column-count` が `1`（または CSS columns を使わない等価状態）で、各 group は種別列と地域列を持つ。種別 rect と同 group の先頭地域 rect は block 軸で交差し、別 group の地域を対応先としないことを browser geometry で assert する。
5. **layout mode の境界**: `data-weather-kind-layout` は global merged `items` だけから決まる。少なくとも「global multi-kind / 現 page の visibleItems は一種別だけ → 全 page で `multi`」「source bucket は複数 / union 後一種別 → `single`」を component test で固定し、page tick や shelf 種別で mode が変わらない。
6. **single 維持**: global single-kind は現状の `column-count: 2`、地域入力順、県 → 市区町村 hierarchy、`.pref-group { break-inside: avoid }` を維持し、multi grid / badge / separator を適用しない。
7. **footer 込み probe / live**: §5.2 の 8 candidate 以下・実高二 page fixture を side / center の双方で測る。footer なし provisional → footer あり final の二段階を report し、footer-present 段階は別 generation id で candidate index 0 から `sequentialPartitionRanges()` を再実行して、各 page boundary の全 prefix を再探索する。第1段階の range / fit cache を hit せず、final ranges が第2段階の結果だけから生成されたことを assert する。range は新測定の結果として第1段階と一致してよい。同じ final composition の normal shelf / forced shelf / live について `data-weather-kind-layout`、footer 有無 / 数、width、card border-box height、各 range の fit boolean、page count が一致し、寸法差は各 1 CSS px 以下である。cache key には §3.3.1 の全 field が現れ、chrome generation、footer mode、または width だけ異なる旧 result を hit させない。
8. **真の viewport と overflow**: synthetic L4 multi-kind scenario を Chrome の真の viewport 1920×1080 と 1280×720 で、`document.fonts.ready`、measurement settled 後に capture する。各 live page で `data-layout-unresolved="false"`、card / `[data-page-probe-readable]` の縦横 overflow 0（許容 1 CSS px）、`data-page-viewport-overflow-keys=""`、group / footer / rider overlap 0 を assert する。PNG と geometry report を全 card page 分残す。
9. **solver 非退行 gate**: fresh base と after を同じ fixture / viewport / tick で比較する。1920×1080 / 1280×720 の双方で visible card 集合、rotation keys / active set / failure count / omitted count、unresolved、overflow を完全一致させる。1280×720 は stage / compressed / placement / Typhoon variant も完全一致、1920×1080 は stage / compressed / rotation なし / omitted 0 を一致させ、既存契約どおり左右列割当だけを診断値とする。旧 DOM の base は kind 帰属を取得できないため code（欠ける場合は name）の cross-kind 初出 projection と件数を after の同 projection に完全一致させ、omitted は legacy 表示順を fixture oracle の kind 順へ明示射影して kind ごとに `after <= base` を検査する。after は独立 oracle に対して logical total、kind 集合、kind ごとの地域帰属・順序を完全一致させ、同じ code が別 kind に属する場合も両方を保持する。`selectedWeatherRows.after >= base` と合わせ、一つでも破れば期待更新せず非0終了する。
10. **weather pager**: pending 中の weather provisional range が現行どおり登録・可視であること、weather registration の `resetKey` が空文字のままであること、pager key / namespace と concrete page identity の生成規則が不変であることを test する。`pageCandidates` の occurrence-aware logical vector、診断用 `weatherPagerLogicalItems` / `data-weather-pager-reset-items` vector の順序・内容、kind ごとの omitted sentinel を固定する。final range から生成される concrete page identity 列は固定対象にせず、§5.12 の `weather-kind-group-page-metadata` 許可差分として比較・記録する。diagnostic vector を scheduler reset 元と表記しない。
11. **tornado Cartesian / pending**: placement ごと・一つの settled probe generation ごとに final range token を正規化し、`Set(observedFinalCompositions) === Set(finalWeatherRanges × finalTornadoRanges)`、重複0を side / center 双方で assert する。partition 探索中の非 final prefix probe は別 field に記録する。weather または tornado probe pending 中は tornado coordinator の confirmed identities / active identity / page count が直前確定値から不変で、provisional rider は読めても未確認 registration を publish しない。weather footer と tornado marker、四 row DOM、rider 下角も維持する。
12. **capture report schema**: 各 record は `fixtureId`、`fixtureProvenance=actual|synthetic`、`viewport`、`rotationTick`、`cardPageTick`、`phase=base|after`、`allowedDeltaReason=none|weather-kind-group-page-metadata`、fixture から独立生成した `logicalOracle`、selected weather rows、kind 別 omitted と base の canonical kind への明示 projection、visible cards、rotation / rotation surface 到達可否（stage・rotation members・非到達理由）/ failure / omitted、overflow / unresolved、weather footer chrome、final weather / tornado ranges、final Cartesian probe 組合せを持つ。field 欠落、DOM 自身を oracle にした値、許可 enum 外、組合せ不足は非0終了とする。`weather-kind-group-page-metadata` は card 内 range / count / range 由来 identity だけが変化した record に限り、§5.9 の値を免除しない。
13. **全 tick 到達**: 各 viewport で実際に到達した最終 stage、rotation members、`rotationSurface=reachable|unreachable` を全 record に明示し、同じ viewport の全 cell で stage / rotation keys を一致させる。stage 0–2 は非 rotation の `rotationTick=0` とする。stage 3 かつ weather が rotation member なら `reachable` とし、weather が visible になる全 rotation tick を列挙して各 tick の `cardPageTick=0..P-1` を capture する。stage 3 未到達または stage 3 でも weather が rotation member でない場合は `unreachable` とし、理由、到達 stage、実 rotation members を record に残して `rotationTick=0` の全 page を capture する。主 fixture は weather と時計だけの stage 0 最小構成を維持し、第3 fixture は足さない。空洞化防止の pressure owner は footer-boundary fixture とし、その 2 viewport matrix に stage 1 以上の cell を少なくとも一つ必須とする。stage 3 の reachable cell で全 weather-visible tick を単一 tick に短縮すること、weather が hidden の tick、briefing 専用 loop の代用を認めない。全 page を合わせて logical oracle の地域が順序どおり一度ずつ到達し、tail は対応 kind の最終 fragment に一度だけ現れる。base / after の到達 stage と rotation surface は §5.9 どおり完全一致させる。
14. **検証コマンド**: 実装後は `npm run build` と `npm test` を必須で成功させる。component DOM / fixture / capture の共有状態または module scope を変更した場合は `npm run test:shuffle` も必須とし、test 型対象へ触れた場合は `npm run typecheck:test` を実行する。

## 6. 裁定ラベル（案）

| 要素 | 案 |
| --- | --- |
| 対象 | WeatherAlertCard の複数種別・複数地域時に、種別と地域を一つの読み取り可能な group にする DOM / CSS / page 表示 atom、および footer 込みの同一 probe / live chrome。 |
| 許容変更 | WeatherAlertCard の multi-kind DOM / CSS / instance ID / global mode / footer chrome、必要最小限の shelf cache context、provenance 付き raw fixture（取得可能時）、synthetic preview / scenario、capture report / card 内 page metadata expectation、component・preview test、design-system §5 のカタログ。 |
| 禁止変更 | parser、engine、wire、永続化、通知、CLI、theme token 値、header tone / severity、solver / partition / scheduler API、pager namespace / key / logical identity / weather の空 resetKey、tornado paging 意味論、文字縮小・情報削除、multi-kind 本文の収容失敗を隠す新規 scroll / clip / ellipsis、§5.9 の非退行値を期待表で緩和すること。既存外殻 containment と tornado 最終 clip は維持する。 |
| 配送先 | 既存 `weather` pager と既存 `WeatherAlertCard` の side / center / rotation surface。新しいカード、別 pager、別の durable state は作らない。 |
| ロールバック | DOM / CSS、shelf chrome / cache context、preview / capture fixture を戻せば、wire・pager logical vector・scheduler state・永続化形式に影響を残さない。range の変化は実高由来の診断値であり、保存データの migration を伴わない。 |
| 受入条件 | §5 の 1–14。特に corpus の provenance 分離、DOM 親子と document-wide ID 一意性、footer 込み probe / live 一致、1920×1080 / 1280×720 の solver / omitted 非退行、weather×tornado の完全 Cartesian probe を満たすこと。 |
