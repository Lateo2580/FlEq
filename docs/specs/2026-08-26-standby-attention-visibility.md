# 待機／緊急カードの未読情報可視化（draft）

> Status: decision required
>
> Draft date: 2026-08-26
>
> Scope: `TsunamiPanel` / `QuakePanel` の無標識スクロール、`TsunamiStandbyBanner` / `HeatAlertCard` のマーキー単独依存、`RecentQuakes` の狭幅折返し

> **spec 系譜**: `standby-layout-redesign.md` は 2026-08-15 裁定済みの凍結グリッド路線であり、同書にある Heat marquee 廃止規定は本 spec へ適用しない。本 spec は `standby-legacy-improvement.md:161` の「Heat marquee で全件到達」を、静的アンカーを必須化した補助マーキーへ**上書き改訂**する。凍結された grid／surface／stage の方針を復活・変更するものではない。

## §1 目的と規範

本仕様は、待機画面と緊急画面で「情報は存在するが、画面外にあることや到達方法が分からない」状態をなくす。要件そのものは、**重要情報を無標識の隠しスクロールまたはマーキーだけへ置かない**、**続きの存在・総量・到達方法を静止要素で示す**、**clip を収容策にしない**、とする。視線動線監査 C6 は checkout 外の Vault 記録にある外部出典であり、ここでは引用の存在に依存せず、この本文を実装の規範とする。

この仕様でいう **未読** は人ごとの既読管理ではない。現在の表示世代に属するページのうち、端末上で所定の保持時間を満了していないものを **未表示** として扱う。ブラウザ再起動をまたぐ永続化、利用者の本人識別、クリックによる既読確定は行わない。

共通原則は次のとおりとする。

1. 重要情報の存在、総量、現在位置、残りの有無を静止要素だけで判別できる。
2. スクロールやマーキーは全件走査の補助手段にはできるが、情報の存在を知る唯一の手段にはしない。
3. 自動ページ送りを採る場合も、表示中のページは静止し、ページ切替だけを短い既存 transition で表す。
4. `prefers-reduced-motion: reduce` でも情報と自動巡回は失わず、切替 animation の duration だけを 0ms にする。
5. D1-A の離散ページでは、追加・訂正で未表示情報が増えたことを、ページ位置とは別の常設表示で知らせる。D1-B は D2-B に限定し、未表示追跡を行わない。

## §2 対象外と維持事項

- 気象緊急パネルの行動文位置は変更しない。
- EEW／Quake の震源名を主役とする文字サイズ、ウェイト、色、配置上の視覚階層は変更しない。
- `RecentQuakes` は折返しと列配置だけを直し、震源名・震度・統計の意味、順序、文字の視覚ウェイトを変更しない。
- §4.1 の津波 `eventId` 最小 DTO 拡張を除き、緊急パネルの優先順位、待機カードの surface 選択、ticker、通知、電文 DTO は変更しない。
- 停止手段を持つ静止モードの新設は対象外である。既存 design system に記録された将来課題をこの仕様だけで解決したとは扱わない。

## §3 現状挙動と目標挙動

### §3.1 無標識スクロール — TsunamiPanel / QuakePanel

#### 現状

- `TsunamiPanel.svelte` の `.tiles` は `overflow-y:auto` だが scrollbar を非表示にする。予報区と観測の各 tile 内には既に `PageDots` と `createPageCycler()` がある一方、両 tile を包む外側 viewport が別にスクロールできるため、下側 tile 全体が画面外でも「続きがある」「現在どこにいる」が見えない。
- `QuakePanel.svelte` は件数が閾値を超える場合には詳細ページングを使うが、静的リスト枝の `.groups` は `overflow-y:auto` と scrollbar 非表示の組合せである。件数上は静的表示と判定されても、compact や高さの小さい配置では一部地域が画面外になり得る。
- いずれも pointer、wheel、touch を使わない常設表示では、画面外情報へ自動では到達しない。

#### 目標

- D1 のどちらを選んでも、scrollbar を消したまま無標識の `overflow-y:auto` を残さない。
- 表示面には最低限、内容種別、現在位置 `k/P` または scroll の現在位置、残りの量を常設する。D1-A + D2-A のときだけ、これに未表示量を加える。
- TsunamiPanel では予報区と観測を別々の隠れた縦領域にしない。D1-A では既存の予報区ページと観測ページを `coast:*` / `observation:*` の安定 identity を持つ一つの順序列へ平坦化し、同時に二重 pager を見せない。最大観測などの固定サマリはどのページでも残す。
- QuakePanel では D1-A 選択時、静的枝を「1 ページで収まる場合」に限定し、実測で収まらなければ件数閾値にかかわらずページ列へ移す。全地域がいずれか一ページに一度だけ属する。
- 1 ページだけなら位置表示は省略できるが、2 ページ以上、または D1-B で続きがある場合は省略しない。

### §3.2 マーキー単独依存 — TsunamiStandbyBanner / HeatAlertCard

#### 現状

- `TsunamiStandbyBanner.svelte` の対象地域は小さいマーキーだけで示され、通常 motion では `left:100%` から入る。初期フレームでは警報種別と件数は見えても、具体的な「どこ」が存在しない時間がある。
- 同 banner の reduced-motion fallback は全種別を連結するが、2 行 clamp で末尾を隠し得る。
- `HeatAlertCard.svelte` の対象府県も一行マーキーが全件の唯一の表示である。長い一覧は開始時に右外へ出ており、reduced-motion は2行 clampになる。

#### 目標

- 両 component に、motion の有無に左右されない **静的アンカー**を置く。初回 paint から少なくとも実在する先頭地域名と総対象数を表示し、`ほか n` または `未表示 n` で続きの存在を明示する。
- 通常 motion のマーキーは静的アンカーと別レーンに置き、全件と警報種別の走査を補完する。マーキーがまだ入場していない瞬間、animation が失敗した場合、撮影用 `staticMarquee` の場合でも、対象の存在と続きの量は分かる。
- reduced-motion ではマーキーを止めるだけで全件経路を失わない。固定行数 clamp で終端を捨てず、収容単位へ分割した静止ページを自動巡回し、切替 duration を 0ms にする。ページ送り自体は継続する。
- 静的アンカーの完全な文言を `aria-label` にだけ逃がすことは、視覚上の常設表示の代替にしない。

#### 静的アンカーの高さ契約

- **TsunamiStandbyBanner**: 新しい縦行は加えない。既存 `.banner-areas` の一行を、左の静的アンカーと右の補助 scan viewport に**置換**する。前者は常時表示、後者だけが marquee／reduce 時の静止ページになる。header、count chip、type token、津波 role 色、左上 surface、既存 stage は不変である。従って同一幅・同一 font metrics で banner root の許容高は変更前と同値（差 1px 以下）でなければならない。
- **HeatAlertCard**: `.areas` の marquee 行は補助レーンとして残し、その直前に D4 の静的アンカー行を**一行追加**する。アンカーは 3→2→1 府県へ縮めて既存 `max-height:160px` 内へ収め、先頭1府県・総数・続き表示を clip しない。header typography、warning／critical の帯、`surface: "corner-right"`、同一入力における StandbyScreen の stage／surface 選択は不変である。
- 両 card は、静的アンカー込みの live border-box 高を measurement／solver の入力にする。アンカー追加を `overflow:hidden`、行の負の margin、別 stage への昇格で隠してはならない。現 stage・surface で収まらなければ、先頭表示数を減らす。それでも先頭1府県が収まらないときは `表示領域不足` と総数を明示して診断へ出す。

### §3.3 狭幅はみ出し — RecentQuakes

#### 現状

`RecentQuakes.svelte` は 960px 以下で `.hypocenter` に `min-width:max-content`、`overflow:visible` を指定する。極端に長い震源名では flex item が縮まず、右側の M／深さ／時刻を押し出すか、行境界を越える。

#### 目標

- 狭幅でも `.hypocenter` の `min-width:0` を維持し、component 外へ横にはみ出さない。
- 統計三列は一つの意味グループとして保ち、列内の順序を変えない。
- 震源名の文字列を一行の `max-content` に固定しない。D5 の選択に従い、折返しまたは統計行の明示的な次行送りで完全値を視覚的に読めるようにする。
- viewport 幅だけでなく実際の card inline-size に追従できるよう、実装時は container query を優先する。既存 960px media query を残す場合も、狭い親 track で同じ保証を満たすことを実測する。

## §4 既存資産の再利用方針

### §4.1 津波 episode identity の正本と伝搬

`DisplayTsunamiInputV1`（`display/frontend/src/lib/protocol.ts:261` と engine 側の同型 protocol）へ、最小拡張として `eventId: string | null` を追加する。これは page identity 専用の新規採番値ではない。**正本は VTSE41 の XML `Head.EventID`**であり、`fromTsunamiOutcome()` が既に作る `PresentationEvent.eventId` を、そのまま display projection へ伝搬する。

経路は次で固定する。

1. `src/engine/presentation/events/from-tsunami.ts` が `xmlReport.head.eventId` を `PresentationEvent.eventId` として供給する。
2. `src/engine/display/project-event.ts` の tsunami branch が、`event.eventId` を trim した非空文字列だけ `DisplayTsunamiInputV1.eventId` へ投影し、それ以外は null とする。`reportDateTime`、表示用 coast 名、message id から episode を再生成しない。
3. `DisplayStateStore` は `dto.emergency.eventId` を `this.tsunami` へ保持し、snapshot／SSE／reconnect seed で欠落させない。`tsunamiSeedFromParsed()` も、復元済み `ParsedTsunamiInfo.meta.eventId` の同じ正本を投影する。
4. `deriveEmergencyPanels()` は固定の `"tsunami:current"` をやめ、正規化済み eventId による `"tsunami:<eventId>"` を panel key とする。`TsunamiPanel` はその eventId を reset／未表示世代の episode key として読む。

`eventId` が null、空、または空白だけの旧 server／不完全電文は `null` とする。この場合は episode を推測して継承しない。derive key は `tsunami:unkeyed:<updatedAtMs>` とし、各受理 payload を fresh episode として reset する。これは未表示状態の誤った持越しを防ぐ fail-safe であり、keyed VTSE41 の通常経路では発生しない。取消は既存どおり `tsunami:null` へ遷移し、取消 DTO に episode を捏造しない。

### §4.2 pageCoordinator / partition

`legacy-standby/time-slice-scheduler.svelte.ts` の `CardPageCoordinator` は quake、weather、briefing、flood、tornado まで一般化され、次を既に持つ。

- 安定 page identity、`resetKey`、現在 index、任意ページへの `jumpTo`
- 新規 identity の pending 管理、削除時の後継ページ選択
- real 15秒送りと rotation appearance に連動する logical 送り
- layout epoch 中の hold、diagnostics、dispose

D1-A ではこの契約を再利用し、緊急 panel 用に名前空間を分けた key（例: `emergency-quake-regions` / `emergency-tsunami-details`）を追加するか、同じ契約を持つ薄い adapter を置く。standby の `quake` key と emergency の地域ページを同一 live instance／同一 key で共有してはならない。緊急画面の既存 10秒保持を維持するため、coordinator の `periodMs` を既存 `PAGE_HOLD_MS` に合わせる。

行数の見積りだけで切らず、weather／flood と同じ `sequentialPartitionRanges` + 実測 probe の考え方を使う。probe 未計測中は provisional range を表示し、空欄や無標識 clip へ退避しない。1 行も収まらない infeasible は明示診断し、見出し＋件数＋`表示領域不足` を残す。

D1-B の場合も item identity、content fingerprint、diagnostics は共通化するが、scroll position から「未表示」を推測する別状態機械は作らない。D1-B は D2-B だけを許可する。

### §4.3 item fingerprint と未表示状態

- item identity は、表示順を含む stable key とする。code があるものは `areaCode`／`kindCode`、`stationCode` を優先し、欠落時だけ正規化済み表示名＋`occurrenceIndex` を使う。並び替えは identity の並び替えとして扱い、同名を一つへ併合しない。
- item content fingerprint は、画面に出る値だけを順序固定の canonical JSON で表した hash とする。津波 coast なら kind、maxHeight と semantic、firstHeight、観測なら area／station、arrival、initial、maxHeight と semantic、condition を含む。Heat は targetDate、severity、areaName、isSpecial を含む。Quake は intensity／rank と地域列を含む。`updatedAtMs`、`reportDateTime`、animation 時刻、実測高さは含めない。null と欠落は同じ canonical null へ正規化する。
- page fingerprint は page header context と、表示順どおりの `[item identity, item content fingerprint]` 列で作る。page range の境界が変われば、その page fingerprint も変わる。
- 表示世代は episode identity と、順序付き item identity、page fingerprint、表示に影響する severity の組で作る。初回 mount と別 episode への切替では全ページを未表示にする。同一 episode の続報では fingerprint が新規または変化したページだけを未表示へ追加し、変更のない stable page を毎回未表示へ戻さない。severity 上昇は全ページを見直す reset とする。
- ページが active になった瞬間ではなく、通常のページ保持時間を満了した時点でそのページを表示済みにする。途中で別画面へ切り替わった場合は未表示のままとする。
- 表示例は `2/5・未表示3` とする。0 件になったら `全件巡回済` を短時間表示してから `2/5` のみに縮退できる。
- 未表示集合はメモリ内だけに置き、unmount／別 event への切替で破棄する。再起動後に「既読済み」と誤認させない。

既存 coordinator の `pendingKeys` は「追加ページを旧一周へ安全に合流させる」ための状態として再利用できるが、保持時間満了を表す read receipt ではない。未表示数を出す場合は `pendingKeys` の名前を既読意味に読み替えず、別の `unseenIdentities` と diagnostics を追加する。

マーキーカードの `ほか n` は「静的アンカーには載っていない項目数」を表し、走行完了に合わせて減算しない。動く文字を見たことを既読とはみなさず、動的な未表示追跡は D1 の panel page と、reduce 時の静止ページに限定する。

### §4.4 reduced motion の唯一の所有者

- `App.svelte` を `prefers-reduced-motion` の唯一の listener 所有者に確定する。既存の `matchMedia` subscription が保持する reactive boolean を、`StandbyScreen` と `EmergencyScreen` の props として下ろし、さらに TsunamiPanel／QuakePanel／TsunamiStandbyBanner／HeatAlertCard と pager へ渡す。
- `EmergencyScreen`、各 panel、各 banner/card、`createPageCycler()` は新たな `matchMedia` listener を作らない。`createPageCycler()` は外部から与えられる reactive reduced value を読むだけに変更する。
- listener の add/remove は App の単一 `$effect` が所有する。App unmount 時はその cleanup が `MediaQueryList.removeEventListener` を一度だけ呼び、child unmount、panel 差替え、page coordinator dispose は listener cleanup を担当しない。
- reduce 時は fade、FLIP、marquee transform を 0ms／none にするが、10秒保持、ページ送り、現在位置、未表示数は維持する。
- reduce 時の2行 clampは、全件へ到達できる静止ページへ置換する。clamp は静的アンカーの補足文にだけ使え、全件経路には使わない。

## §5 裁定待ち分岐

以下は本 draft では確定しない。実装着手前にご主人の裁定を受ける。

### D1: 無標識スクロールの置換方式

- **案 A — 固定高＋自動ページングへ統一（推奨）**: TsunamiPanel は予報区／観測を一つの page sequence に平坦化し、QuakePanel は高さ実測で1ページ以上へ分割する。`k/P・未表示n` を常設し、scroll container を撤去する。
- **案 B — native scroll＋常設標識**: scrollbar を可視にし、上下端の `続き n項目` と現在位置を sticky 表示する。wheel／touch／キー操作で到達する。未表示数は表示しない（D2-B 固定）。
- **推奨理由**: 放送型 kiosk では手動操作が保証されない。案 A だけが、見ているだけでも全件へ到達し、既存 coordinator／partition の第三例（flood）をそのまま横展開できる。案 B は運用上必ず操作できる端末に限定する必要がある。

### D2: 未表示状態の粒度

- **案 A — 表示世代ごとの未表示ページ数を追跡（推奨）**: `k/P・未表示n` を表示し、各ページの保持完了で減らす。追加・変更ページだけ再度未表示にする。
- **案 B — 位置と総数だけを表示**: `k/P` または `下にn項目` は常設するが、巡回済みかどうかは追跡しない。
- **依存制約**: D1-A は A/B のいずれも選べる。**D1-B を選んだ場合は D2-B のみ許可し、D2-A や scroll を離散未表示へ読み替える案は採らない。**
- **推奨理由**: 案 B は到達方法を示せても、新着がまだ画面に現れていないことを区別できない。案 A は既存 page identity を利用でき、永続化なしで監査所見の「未読状態が分からない」を直接塞げる。

### D3: 津波バナーの静的化粒度【確定・裁定不要】

- 静的 anchor は **最上位区分の先頭1予報区＋全体総数**に確定する。例: `対象 6予報区・先頭 宮崎県（ほか5）`。区分別件数は既存 chip、全件と各区分の対応は右側の補助 scan viewport／reduce 時の静止ページで示す。
- 区分ごとの先頭地域を常設する案は採らない。一行の左 anchor＋右 scan viewport 置換では、3区分同時発令時に各区分の地域名・件数を収められず、§3.2 の高さ不変契約を破るためである。

### D4: 熱中症カードの静的化粒度

- **案 A — 実測で収まる先頭1〜3府県＋総数（推奨）**: 2行以内で3→2→1件へ段階的に減らし、最低1件は完全表示する。例 `東京都・大阪府・福岡県（対象40、ほか37）`。
- **案 B — 先頭1府県＋総数で固定**: 例 `先頭 東京都・対象40都府県`。残りは補助マーキー／reduce 時の静止ページで示す。
- **推奨理由**: 案 A は card 高を守りながら初見の地域手掛かりを増やせる。固定件数を無理に詰めず、weather／flood の実測 probe を再利用できる。案 B は実装と高さ契約が単純だが、全国的な発表で情報密度が低い。

### D5: RecentQuakes の狭幅 reflow

- **案 A — 統計列を明示的に次行へ送る（推奨）**: 震度 chip／震源名／津波印を1行目、M／深さ／時刻を2行目の右寄せ group とする。震源名は `min-width:0`、折返し可、`overflow-wrap:anywhere` とする。
- **案 B — flex の自然折返しを維持**: `min-width:max-content` を撤去し、空きがあるときは統計を同じ行、足りないときだけ次行へ送る。
- **推奨理由**: 案 A は統計列の位置と順序が安定する。案 B は通常幅で一行の密度を保てるが、境界付近で行ごとの配置がばらつきやすい。

## §6 実装単位

裁定後は次の単位で進める。各単位は対象 component test と diagnostics を同じ patch に含める。

1. **共通状態**: page identity、未表示集合、保持完了、`k/P・未表示n` view model、reduced-motion 配線を追加する。
2. **津波 identity**: protocol の `eventId` 拡張、`PresentationEvent` → project-event → state store → snapshot → reconnect seed → derive key → TsunamiPanel reset の経路を一単位で配線する。null fallback と取消もこの単位で test する。
3. **緊急 panel**: D1 に従い TsunamiPanel／QuakePanel の隠し scroll を置換する。D1-A では partition probe、固定本文高、単一 pager、fingerprint による reset／update を配線する。
4. **待機マーキー**: TsunamiStandbyBanner／HeatAlertCard に D3／D4 の静的アンカーを追加し、マーキーを補助へ降格する。§3.2 の高さ契約を measurement に接続し、reduce 時の clamp を全件静止ページへ置換する。
5. **狭幅履歴**: RecentQuakes を D5 の reflow に変更し、長名 fixture と container 境界を追加する。
6. **preview／design system 同期**: 通常、dim、critical、reduced-motion、長大データの fixture と診断属性を追加し、C6 相当の本文要件を design system の生成元へ反映する。

実装対象候補は `display/frontend/src/components/` の5 component、`display/frontend/src/lib/legacy-standby/` の coordinator／partition、`EmergencyScreen.svelte`、対応する `__tests__`、preview fixtures、design system 生成元である。最終 allowed paths は実装契約ごとに改めて限定する。

## §7 受入条件

### §7.1 機械的に確認する項目

- [ ] `TsunamiPanel` / `QuakePanel` の可読領域に `overflow-y:auto` と scrollbar 非表示の組合せが残らない。D1-B の場合は visible scrollbar、sticky な続き表示、位置更新の test がある。
- [ ] D1-A では 0／1／2／多数件、compact／通常、予報区のみ／観測のみ／両方の各 fixture で、全 input identity が page sequence に重複なく一度ずつ含まれる。
- [ ] 2ページ以上で `k/P` が DOM に常設される。D1-A + D2-A の場合は未表示数も常設され、手動 jump と自動保持完了で値が正しく変わる。
- [ ] D1-A + D2-A では、active page が保持時間を満了する前の unmount／panel 切替で未表示数が減らず、満了後だけ減る。D1-B では未表示 state／diagnostic を作らない。
- [ ] 同一 episode の追加・訂正では page fingerprint が新規／変化した page だけ未表示へ入り、別 event、severity 上昇、順序付き identity の置換では定義どおり reset する。時刻だけの変化、undefined/null の表現差、measurement 値では reset しない。
- [ ] XML EventID → `PresentationEvent.eventId` → `DisplayTsunamiInputV1.eventId` → state snapshot/reconnect seed → `deriveEmergencyPanels` key → `TsunamiPanel` reset が同じ値である。異なる EventID は必ず fresh episode、同じ EventID の続報は同じ episode、null／空／空白は `tsunami:unkeyed:<updatedAtMs>` の fail-safe reset、取消は null state になる。
- [ ] coordinator の layout epoch hold 中にページが進まず、release 後に一度だけ進む。dispose 後に coordinator timer が残らない。
- [ ] `matchMedia("(prefers-reduced-motion: reduce)")` の listener は App に一つだけある。StandbyScreen、EmergencyScreen、4対象 component、pager は listener を作らず、App unmount の cleanup で一度だけ解除される。
- [ ] `prefers-reduced-motion: reduce` でも全ページが巡回し、fade／FLIP／marquee animation は 0ms／none、現在位置と、D1-A + D2-A の未表示数は残る。
- [ ] 津波 banner は初回 paint で実在する予報区名と総数を静的表示し、複数区分の全地域が補助マーキーまたは静止ページに含まれる。
- [ ] 熱中症 card は1／2／3／40府県で、初回 paint の静的アンカーに最低1府県と総数があり、全府県が補助経路へ含まれる。`ほかn` の n が一致する。
- [ ] TsunamiStandbyBanner は anchor 追加後も同一幅・font metrics で root 高が baseline ±1px、HeatAlertCard は `max-height:160px` 内で root の `scrollHeight <= clientHeight + 1` を満たす。両者は同一入力で typography token、stage、surface を変えず、solver の selected height と live height の差が 1px 以下である。
- [ ] `staticMarquee` でも静的アンカーと全件経路が失われず、通常表示の animation 契約は補助レーンだけに残る。
- [ ] reduced-motion の全件経路に `line-clamp`／ellipsis による終端欠落がない。
- [ ] `RecentQuakes` は非常に長い日本語名、空白なしASCII、意味値 badge、津波印ありの組合せで card root の `scrollWidth <= clientWidth + 1` を満たし、統計三列が全て可視である。
- [ ] source guard で `RecentQuakes` 狭幅規則の `min-width:max-content`／`overflow:visible` 再導入と、対象4 component の無標識 scroll／マーキー単独表示の再導入を検知する。
- [ ] diagnostics／capture report に現在 page、総 page、未表示数、infeasible、横 overflow を出し、fixture 期待表と一致する。

実ブラウザ geometry gate は `capture-legacy-standby.mjs` 系 runner を拡張して実行する。fixture `attention-visibility-standby` は多区分津波 banner、Heat 40府県、長名 RecentQuakes を、`attention-visibility-emergency` は予報区・観測とも多頁の TsunamiPanel と多頁 QuakePanel を含める。実装完了時は build 後、`--report` を付けずに次を実行する。

```sh
npm --prefix display run build
CHROME_BIN="${CHROME_BIN:-chrome}" node display/scripts/capture-legacy-standby.mjs --fixture attention-visibility-standby --scenario 7 --viewport 1920x1080 --viewport 1366x768 --viewport 1280x720 --viewport 960x620 --out-dir display/artifacts/attention-visibility
CHROME_BIN="${CHROME_BIN:-chrome}" node display/scripts/capture-legacy-standby.mjs --fixture attention-visibility-emergency --scenario 7 --viewport 1920x1080 --viewport 1366x768 --viewport 1280x720 --viewport 960x620 --out-dir display/artifacts/attention-visibility
```

runner は fixture を allowlist 化し、各 viewport で card／page viewport の縦横 overflow、page indicator と body の重なり、anchor・現在位置・D1-A 時の未表示表示の欠落、Heat の 160px 超過、Tsunami banner の baseline 高差、RecentQuakes の横 overflow を diagnostics 属性から検証する。これらのいずれか、fixture expectation の不一致、Chrome 起動失敗、120秒 watchdog timeout、未知 fixture は例外にして**非ゼロ終了**とする。PNG/JSON は目視用成果物であり、存在だけでは gate 成功としない。

実装完了時の gate:

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run test:shuffle`（coordinator、timer、共有状態を触るため必須）
- [ ] `npm run typecheck:test`
- [ ] `npm run display:build`
- [ ] `npm run display:test`
- [ ] `npm --prefix display run typecheck`
- [ ] `npm --prefix display run docs:design:check`

### §7.2 ご主人が実機で目視する項目

- [ ] 1920×1080、1366×768、1280×720 と狭幅境界の上下で、予報区／観測／地域一覧に「まだ続く」ことと現在位置が一瞥で分かる。
- [ ] 津波複数区分、熱中症40府県で、表示直後から具体的な地名があり、右外から文字が入るまで空欄に見えない。
- [ ] 通常 motion でページ保持時間が読み切れる長さで、切替が二重 pagerや競合する motionに見えない。
- [ ] reduced-motion で動きは抑えられつつ、待てば全件が現れ、ページ位置と未表示数の変化を追える。
- [ ] dim／critical overlay でも静的アンカー、`k/P`、未表示表示が沈みすぎず、警報種別色との主従が崩れない。
- [ ] 24インチFHD・視聴距離1.0〜1.5mで、静的アンカーと続き表示を読める。
- [ ] RecentQuakes の極端な長名で統計が画面外へ押し出されず、5件の行間とクリック領域が不自然に重ならない。
- [ ] 本仕様対象外の気象行動文位置、EEW／Quake 震源名の視覚ウェイトが変更前と同じである。

## §8 完了の定義

ご主人が D1〜D5 を裁定し、選択された枝の component test、geometry test、diagnostics、preview fixture、design system 記述が同じ契約を示し、§7.1 の全 gate と §7.2 の実機目視を通過した時点で実装完了とする。未裁定のまま推奨案を実装へ固定しない。
