# P4 9 分野の表示語彙の表 r1（P4-DISPLAY-VOCAB-001）

- 起草: r0 は 2026-11-21（base 37fbd7f3）。r1 は同日、main db2b32d7 の上（draft/p4-vocab 3434966e）で、レビュー 2 本（ヘルツ〔NO-GO、P1 3・P2 5〕と契約適合〔NO-GO、P1 1・P2 7〕）と統合担当の決め 10 個を当てた。決めと直した所の対応は §11。発注前点検は 2026-11-22 に main 9c79d678 の上で行い、直した所と確かめた事実は §12。
- 目的: B0（P4-DISPLAY-WIRE-001）が新しい経路 `/display-wire` に載せなかった 9 分野（U-W・U-F・U-N・U-V・U-L・U-R・U-B・U-M・U-Y）を、同じ経路に載せる形を決める。
- 入力の事実: 事実の表 r0（repo 外、main 093dc8b9 から起こした表 1・表 2）とヘルツの確かめ（repo 外、HEAD 37fbd7f3）。食い違う所はヘルツの返事を正にした（§3.1）。9 分野の domain・unit・型の file は 093dc8b9 と db2b32d7 の間で変わっていないので、事実の表の行番号は 9 分野についてそのまま効く。
- 読み比べ: B0 の表 r7 の §12（f3b61acf）は前提が崩れて外した案。語彙の種はそこから借りたが写していない。崩れた 2 つ（辞書と構造の列）には §1.3 と §2 で行き先を 1 つずつ決めた。
- 範囲外: H17・H39 の値（P4-REMOVAL-LOSS-001）、B1 の予算の配り方、U-M の本文（P4-QUAKE-COMMENTARY-TEXT-001、§8）、描き方（C0・C1・C2 の板）。
- 印: 「新しく切る」は今の view に無い切り方。「落とさない」は今の view の欄を wire から外さないこと。

## 0. 結論

- 9 分野の wire は 1 つの形（§1 の語彙の項目 `VocabItem`）に写す。全項目に安定した `id` と版 `rev`（sha256([unit, operation, subject])、B0 の詳細の id と同じ式）を持たせ、並びも id で決める。
- 単値と展開の欄は事実の行、上限のある列と辞書は一覧（`VocabList`）、台風の予報円と水位のミニグラフだけ専用部品（`special`）。表示を終える期限（retainUntil・validUntil・activeUntil・visibleUntil・warningUntil・forecastEndsAt）は全部写す（§1.5）。
- 表 1 の ✕ 26 欄の行き先は、snapshot の一覧 23・専用部品 3・詳細だけ 0（§2）。共通の 3 種は、`subjects` を載せない、`unreadableCards` を B0 と同じ短いカードで載せる（D-B0-CARD-TEXT=A を当てる）、`unreadableView` を印の真偽と parts の一覧で載せる。
- 上限の無い字は snapshot で切って印、詳細では切らない（§3.2）。
- 要約は今の形（4 KiB 以下、カードを持たない）に戻す。要約の間も 9 分野の全項目を詳細から開ける（§5.3）。公開する snapshot は、全体が 1 MiB 以下ならそのまま、超えたら 65,536 を超えた 9 分野を要約にした後で 967,258 以下（§4.1）。
- 包みの items（件数の見出し）は旧の射影から借りず、新しい経路が受けた差分（停止の確定の差分を 1 度だけ当てたもの）から数える。保護 3 分野も同じ直しに入れる（§4.3）。
- 直列: `display-wire.ts` は B0 → 本契約 → P4-REMOVAL-LOSS-001 → B1 → E0 発注 1（計画 db2b32d7・3f778efc）。`http-sse.ts` は B0 → 本契約（9 分野の詳細の part と part=unreadable）→ B1 → R0 → T0（P4-DV-D-HTTP-PARTS=A で確定、計画 3f778efc の :230）。
- 作者の分岐は 1 件: 1 件で 1 応答に入らない詳細の項目の扱い（§3.2、P4-DV-D-ITEM-OVERSIZE）。

## 1. 語彙の形

### 1.1 分野の包みと snapshot の並び

| 欄 | 形 | 出どころ |
|---|---|---|
| 包み（full） | `{ unit, contentRevision, items, delivery: "full", wire: VocabWire, cards }` | B0 の `DisplayWireDomain`（`p4-display-wire.types.ts:95`〜`:98`）に delivery を足した形 |
| 包み（要約） | `{ unit, contentRevision, items, delivery: "summary", reason: "snapshotBudget", originalBytes, budgetBytes }`。カードを持たない | 旧の要約（`view-projector.ts:761`〜`:765`）と同じ形。spec:1381 の分野の要約 4 KiB 以下（`p2-snapshot-sse.json:73` の 3,882） |
| `items` | `DisplaySummaryItem` × 3（通常・訓練・試験） | 新しい経路の自分の差分から数える（§4.3） |
| `VocabWire` | `{ items: VocabItem[], facts: VocabFact[] }`。facts は分野に 1 つの値（U-W の freshnessSuspectCount だけ） | §2 |
| current の鍵の並び | `eew`・`tsunami`・`earthquake`・`weatherCurrent`・`weatherTimeseries`・`nankai`・`volcano`・`landslide`・`flood`・`briefing`・`localBulletins`・`typhoon`（B0 の 3 つの後に旧の並びで 9 つ） | B0 の並びを前に残す |
| 版 | `schemaVersion` を `p4-display-wire-v2`。`semanticRevision` は current の鍵の並びと同じ順の 12 分野の contentRevision の JSON 配列 | B0 の AC01（描画は自分の版でない snapshot を描かない） |

### 1.2 語彙の項目 `VocabItem`

| 欄 | 形 | 写すもの |
|---|---|---|
| `id` | 64 桁の hex | sha256(JSON.stringify([unit, operation, subject]))。volcano.shortfall の subject は unit が使う形 `${operation}/shortfall/${id}`（`volcano-unit.ts:1280`）で、通常の記録の subject と同じ hash の入力にならない（復元の境界は shortfall の id を ASCII 64 字以内しか見ず、記録の subject との重なりを検査しない、`volcano-unit.ts:1610`・`:1641`） |
| `rev` | 字 | その項目の版。view の object の JSON の sha256 の hex（B0 の DisplayDetailRef の rev と同じ式）。U-W・U-F は公開形の revision。§5.5 の part=item・unreadable の要求に使う |
| `k` | 閉じたコード（§1.4 の 17 種） | view の配列の種類 |
| `op` | Operation | 記録の operation |
| `title` | 字か null | view の `title` 欄（無い種類は null。unit が上限を持つので素の字） |
| `time` | 字か null（40 byte を越えたら null） | source の reportDateTimeRaw |
| `serial` | 字か null（40 byte を越えたら null） | source の serialRaw |
| `marks` | `DisplayStateMark[]`（B0 の 4 語のまま） | unconfirmed → `unconfirmed`。B0 の marksOf と同じ |
| `unread` | 真偽 | `unreadableView` があるか（B0 の EEW のカードの `unread` と同じ） |
| `ref` | `{ part, id, rev }` か null | 詳細を開く参照（§5.2） |
| `facts` | `[label, value][]` | 単値と展開の欄（§1.3）と表示の期限（§1.5） |
| `lists` | `VocabList[]` | 上限のある列と辞書（§2） |
| `texts` | `[role, 字][]` | headline・prevention などの文（unit が上限を持つので素の字） |
| `special` | 専用部品か無し | 台風の frames、洪水の times と stations（§2.3） |

- 並び: `VocabWire.items` は id の昇順。描く並びは C0・C1 の板（spec:1435 の同じ順位は安定した ID の辞書順）。

### 1.3 単値・展開・列の写し方

- 単値: `[label, value]`。value は字・数・真偽・null。字は unit が上限を持つ欄では素の字、§3.2 で新しく切る欄だけ `DisplayCutText`。
- 展開: 形の決まった入れ子は欄ごとに分けて label を `親.子` にする（主の ReportRef は §1.2 の time・serial と `source.family`・`source.infoType`、`{code, name}` は `x.code`・`x.name`）。
- MaterialValue（U-V の噴煙の 2 欄）: `["sv", kind, value, bound, raw]`。対応は実型（`p1-parser-boundary.types.ts:54` の MaterialValue）のとおり固定する。

| kind | value | bound | raw |
|---|---|---|---|
| `number` | 数 | null | 字 |
| `text` | 字（`text.value`） | null | 字 |
| `range` | 数 | `lower` か `upper` | 字 |
| `empty`・`unknown` | null | null | 字 |
| `missing` | null | null | null |

- 一覧 `VocabList`: `{ role, label, sys, cols, facts, rows, omitted }`。rows は `[鍵, 名前 か null, ...値]` の配列で、値の欄の名は `cols` に 1 回だけ書く。facts は一覧に 1 つの値（group の code・level など）。omitted は view が持つ省いた件数（例: ashfalls の omittedAreaCount）で、無い一覧は 0。`sys` は rows の鍵が `DisplayAreaSystem` の区域 Code のときだけその層（U-W の areas の各層、U-F の areaCodes は forecastArea、U-L の kinds と U-V の municipalities は municipality）、ほかは null。
- 辞書（崩れた前提の 1 つ目）: 鍵の数に上限のある辞書は、鍵の昇順の一覧 1 つにする。U-W は `codes` を基準に一覧 `phenomena` の rows `[Kind/Code, Kind/Name か null, 区域の数]` を作る。`names` は `codes` の部分集合（名前の無い Code は鍵を作らない、`p3-uw-canon.types.ts:27`）なので、`names` に無い Code の名前は null。Kind/Code は受理で 2 桁の数字に限る（`weather-current.ts:284`）ので鍵は 100 個まで。
- 構造の列（崩れた前提の 2 つ目）: group の列は group ごとに 1 つの一覧にし（role は view の欄の名、label は group の名前）、group の単値を一覧の facts に置く。読めない印の parts は §2.4。
- 副の ReportRef: `unconfirmed` は見出しの印、U-V の `marineUnconfirmed` は事実の行 `marineUnconfirmed`（真偽）で、どちらも有無だけを載せる（B0 の marksOf と同じ）。U-V の `marineSource` は主の source と同じ規則で `marineSource.time`・`marineSource.serial`・`marineSource.family`・`marineSource.infoType` の事実の行（null なら欄ごと null）。
- 載せない欄（理由）: view の `semanticRevision`・`subjects`（B0 と同じ、§2.4）。記録の `subject` の字そのもの（`id` の材料として載る。U-W・U-F は公開形の id が同じ式）。active だけの配列の `effective`（値が 1 つ。U-F と U-B は複数の値なので載せる）。source の inputId・origin・subject・controlDateTimeRaw（照合の材料。U-N・U-V の本文の rev は ref に作り済みで載る）。U-V の landEventId・marineEventId（型のコメントが取消の identity とする、`p3-volcano-unit.types.ts:74`〜`:75`）。`notice`・`marineNotice` と `expiryPending` は実の view に乗らない（事実の表 1.0b）。U-R の observedCompare は実の view で外す（`flood-unit.ts:309`〜`:314`）。

### 1.4 項目の種類 `k`（17 種）と閉じた語

`weatherCurrent.area`・`weatherTimeseries.subject`・`nankai.current`・`nankai.information`・`volcano.alert`・`volcano.eruption`・`volcano.ashfall`・`volcano.bulletin`・`volcano.shortfall`・`landslide.office`・`flood.event`・`briefing.current`・`localBulletins.tornado`・`localBulletins.heat`・`localBulletins.transient`・`typhoon.analysis`・`typhoon.probability`。

- `VocabItem` は `k` で分けた判別共用体にし、`k` ごとに facts の label・一覧の role と cols・texts の role・special の種類を閉じた union 型で固定する（spec:1268 の許可 field の固定）。型に無い label・role は作れない。
- 描画は `k` と label・role で描き分け、分野（unit）の名前では分けない（R46）。

### 1.5 表示を終える期限（統合担当の決め 2）

全部の期限の欄を事実の行に写す（label は view の欄の名）。「効く」はその unit が表示から外す判定に使う欄。

| 種類 | 写す期限の欄 | 表示の終わりに効く欄 | 出どころ |
|---|---|---|---|
| weatherCurrent.area | 無し（公開形に期限の欄が無い。取消・解除・置換で消える） | — | `p3-uw-canon.types.ts:12`〜`:33` |
| weatherTimeseries.subject | validUntil | validUntil は noActiveItems への変わり目で、表示は残る。表示から外す retainUntil は公開形に無い（Q-DV-UF-RETAIN） | `weather-timeseries-unit.ts:128`〜`:137` |
| nankai.current | validUntil・warningUntil・retainUntil | validUntil（表示の終わり）、warningUntil（巨大地震警戒から注意への段下げ） | `nankai-unit.ts:83`〜`:87`・`:177` |
| nankai.information | validUntil・retainUntil | validUntil（過ぎると expiryPending で view から外れる） | `p3-nankai-unit.types.ts:80`・`:91` |
| volcano.alert | retainUntil | 無し（active の警報は期限で消えない） | `volcano-unit.ts:104` |
| volcano.eruption | validUntil・retainUntil | validUntil | `volcano-unit.ts:105` |
| volcano.ashfall | forecastStartsAt・forecastEndsAt・retainUntil | forecastEndsAt | `volcano-unit.ts:106` |
| volcano.bulletin | retainUntil（解説の view に validUntil は無い、`p3-volcano-unit.types.ts:167`〜`:191`） | retainUntil（shownDeadline が validUntil・forecastEndsAt の無い記録で retainUntil に落ちる） | `volcano-unit.ts:127`〜`:128` |
| volcano.shortfall | 無し | — | `p3-volcano-unit.types.ts:194`〜`:203` |
| landslide.office | retainUntil | retainUntil | `landslide-unit.ts:75`・`:408` |
| flood.event | retainUntil | retainUntil | `flood-unit.ts:90`・`:463` |
| briefing.current | retainUntil | retainUntil | `briefing-unit.ts:123` |
| localBulletins.tornado・heat | activeUntil・retainUntil | activeUntil | `local-bulletins-unit.ts:110`〜`:113` |
| localBulletins.transient | visibleUntil・retainUntil | visibleUntil | `local-bulletins-unit.ts:112` |
| typhoon.analysis・probability | activeUntil・retainUntil | activeUntil | `typhoon-unit.ts:82` |

## 2. 行き先の表（表 1 の ✕ 26 欄と共通の 3 種）

列の意味: 行き先は「一覧」（snapshot の `lists`）・「専用」（`special`）・「詳細」（`/display-wire` の詳細の part）・「載せない」。上限は事実の表 1 とヘルツの返事 5 の値。新しく切る欄の値と落ちるものは §3.2。

### 2.1 U-W（最初の読み手は C0 発注 1 の気象の警報のカード）

| 欄 | 形と上限 | 行き先 | 新しく切るか | 画面から落ちるもの | 残りを読む所 |
|---|---|---|---|---|---|
| U-W areas（`p3-uw-canon.types.ts:24`） | `[層, Code][]`。区域 Code は数字だけで桁数・件数の定数なし（ヘルツの返事 5） | 一覧 role `areas`。層ごとに 1 つ（sys は層、rows は `[Code, null]`）。区域名は載せない（計画 §5.3 の即断候補 C=A、描画が引く） | 切らない（件数は分野の 65,536 と要約で閉じる） | 無し | — |
| U-W codes（:26） | 辞書 Kind/Code → 区域の数。鍵は 2 桁の数字（受理で検査） | 一覧 `phenomena` の鍵と 3 列目（rows の基準） | 切らない | 無し | — |
| U-W names（:28） | 辞書 Kind/Code → Kind/Name。codes の部分集合。値の字は unit の上限なし（text node の 16,384 字まで） | 一覧 `phenomena` の 2 列目（`DisplayCutText`、名前の無い Code は null） | snapshot で切る（§3.2 の 1,536 byte） | snapshot では 1,536 byte から後（実の Kind/Name は 10 字ほど） | 詳細 part=item（§5.5、切らない） |
| U-W の単値（operation・prefecture・id・revision・source・cellCount・restoredCellCount） | 単値と ReportRef | 見出しと事実の行。id は `VocabItem.id` と同じ字、revision は ref（part=areas） | 生の字の欄だけ（§3.2） | 時刻・番号・InfoType が 40 byte を越えたときその欄が null | U-W の詳細 part=areas と part=item |
| U-W freshnessSuspectCount（view） | 単値 | `VocabWire.facts` | 切らない | 無し | — |
| U-W の表示差分の unavailable・freshness・currentActive・currentScope（`p2-shared-runtime.types.ts:213`） | 監視の行と鮮度の記録。affectedScope は件数・字の上限なし（ヘルツの返事 5） | 載せない。view の areas に無い（表示差分の材料だけ）。unavailable は今の notices（VisibleNotice の unavailable）で出る | — | 無し（今の view にも無い） | 旧と同じ notices |

- 区域と種別の対応（どの区域にどの警報が出ているか）は今の公開形に無く、詳細 part=areas の行で読む（P3-UW-CANON-001 の決め）。本契約は公開形を変えない（Q-DV-UW-AREA-KIND）。

### 2.2 U-F から U-Y（✕ 23 欄）

| 分野 | 欄 | 形と上限 | 行き先 | 新しく切るか |
|---|---|---|---|---|
| U-F | areaCodes | 字の列。区域 Code は数字だけで桁数・件数の定数なし（ヘルツの返事 5） | 一覧 role `areaCodes`（sys forecastArea） | 切らない |
| U-F | knownCodes | 字の列。最大 11 種・2 桁 | 一覧 role `knownCodes` | 切らない |
| U-F | unreadableView | 共通の 3 種と同じ（§2.4） | §2.4 | 切らない |
| U-V | alerts.municipalities | `{kindName, codes[]}` の列。group 8・codes 128・kindName 32 | group ごとの一覧 role `municipalities`（label は kindName、sys municipality） | 切らない |
| U-V | alerts.marineAreas | group 4・codes 32 | group ごとの一覧 role `marineAreas` | 切らない |
| U-V | alerts.marineUnreadableView | 読めない印 | 一覧 role `marineUnreadable`＋事実 `marineUnread`（§2.4 と同じ形） | 切らない |
| U-V | eruptions.municipalities | code の列。128 件・code 16 | 一覧 role `municipalities` | 切らない |
| U-V | ashfalls.groups | group 8。要素は hazardClass・ashCode・ashName・areaCount・topAreas 3・omittedAreaCount | group ごとの一覧 role `ashGroup`（facts に hazardClass・ashCode・areaCount、rows に topAreas、omitted に omittedAreaCount） | 切らない |
| U-V | bulletins.volcanoCodes | code の列。128 件 | 一覧 role `volcanoCodes` | 切らない |
| U-L | kinds | `{code, name, level, areas[]}` の列。group 8・区域の延べ 256・name 32・区域の code 16 | group ごとの一覧 role `kinds`（facts に code・level、label に name、rows に区域） | 切らない |
| U-R | kinds | `{code, name, level, rivers[]}` の列。group 16・河川の延べ 32・name 32 | group ごとの一覧 role `kinds` | 切らない |
| U-R | times | 字の列。40 点 | 専用 `floodSeries`（§2.3） | 切らない |
| U-R | stations | 20 局・40 点・局名 48・code 20・局別 riverCodes 4 | 専用 `floodSeries`（§2.3） | 切らない |
| U-R | inundation | group 2・text 256・全体 32,768 byte。区域の stationCode・cityCode・件数と name・prefecture・city・subCities は欄ごとの上限なし（ヘルツの返事 5、`flood.ts:353`〜`:373`） | group ごとの一覧 role `inundation`（label は kindName、facts に text、rows `[cityCode, name, stationCode, prefecture, city, subCities]`、omitted に omittedAreaCount） | 名前の 4 欄だけ snapshot で切る（§3.2）。詳細では切らない。code と件数は切らない |
| U-B | items（VPBS50） | `{kind, condition, areas[]}` の列。item 4・区域の延べ 16 | item ごとの一覧 role `items` | 切らない |
| U-B | observations | 8 件。要素は part・areaCode・areaName・label・value・unit・approximation・time | 一覧 role `observations` | 切らない |
| U-B | areas（VPOA50） | `{code, name}` の列。16 件 | 一覧 role `areas` | 切らない |
| U-M | tornado.areas | `{layer, code, name}` の列。128 件・name 24 | 一覧 role `areas`（rows `[code, name, layer]`） | 切らない |
| U-M | transient.areas | 16 件・name 24 | 一覧 role `areas` | 切らない |
| U-M | transient.tags | 16 語 × 24 UTF-16 単位（`local-bulletins.ts:351`） | 一覧 role `tags`（rows `[語, null]`） | 切らない |
| U-Y | analysis.frames | 24 frame・軸 2 | 専用 `typhoonFrames`（§2.3） | 切らない |
| U-Y | probability.prefectures | `{code, name}` の列。96 件・name 24 | 一覧 role `prefectures` | 切らない |
| U-Y | probability.areas | 384 件。要素は code・name・prefectureCode・daily 5・peak・peakSlot | 一覧 role `areas`（cols は prefectureCode・d1〜d5・peak・peakSlot） | 切らない |

- U-N の ✕ は 0 欄（infoSerial は展開）。U-F の unreadableView は共通の 3 種と重なる（ヘルツの返事 5）ので、固有の ✕ は 25 欄・行き先の数は一覧 22・専用 3 と数えてもよい。
- 詳細だけに置く ✕ 欄は無い。理由: 26 欄とも今の view にあり、旧 `/events` の full は全部を配る。詳細へ移すと初期画面から消える（作者の分岐になる）。どの欄を描くかは C0・C1 の板で、描かないと決めた欄を外すのはその板の契約。容量は B1（予算の配り方）。

### 2.3 専用部品（語彙の外、計画 §4.1）

| 部品 | 形 | 上限 |
|---|---|---|
| `typhoonFrames` | U-Y の analysis の frames を view の形のまま（TyphoonFrame）。投影後の座標と SVG path は入れない（spec §8.1） | 24 frame・軸 2（`typhoon.ts` の上限）。字の欄は unit の上限 |
| `floodSeries` | U-R の times と stations を view の形のまま（FloodStation） | 20 局・40 点（`flood.ts:22`〜`:23`） |

- 無いと壊れる振る舞い: 予報円の中心・半径・軸と、局ごとの 40 点の値は一覧の rows（鍵・名前・単値の列）に収まらず、収めると描画が分野ごとの組み直しを持つ（R46 の逆）。

### 2.4 共通の 3 種

| 欄 | 形と上限 | 行き先 | 理由 |
|---|---|---|---|
| subjects | SubjectOutcome の列（facts が辞書、件数・字の上限なし） | 載せない | B0 も載せない（B0 の表 §1.2 の「wire に載せない欄」）。消えた理由と件数は P4-REMOVAL-LOSS-001 が outcome から作る |
| unreadableCards | UnreadableCardView の列。U-M は 16 枚・ほかは 8 枚、U-Y は 1 枚に areas を 384 件・24,576 byte まで（`checkpoint.ts:689`〜`:691`） | full の包みの `cards`（B0 の `DisplayWireCard`。題 96・見出し 384 byte で切る、D-B0-CARD-TEXT=A を当てる、P4-DV-D-CARD-TEXT-9）。原文は B0 の part=raw。要約はカードを持たない（旧の要約と同じ） | 同じ部品（読めない報のカード）を 12 分野で 1 つにする。カードの byte は full の包みの 65,536 に入れて数える |
| unreadableView | `{ parts: {site, scope?, raw}[], headline, addition?, rawDropped?, partsCut? }`。欠片の鍵は (site, scope)（`unreadable.ts:88`）で、1 つの印に parts 16 件まで（U-F の addition の欠片も 16 件に入る）。U-V の警報は陸上の印と海上の印（marineUnreadableView）を別々に持つので 1 項目で 32 件まで。scope は JSON 長 128 byte・site は分野別の閉じた集合、部分の原文と見出しの原文は各 1,538 byte まで（`unreadable.ts:13`・`:228`） | 見出しの `unread`（真偽）と一覧 role `unreadable`・`marineUnreadable`（rows `[site, scope, raw]`、facts に headline・addition・rawDropped・partsCut）。部分の原文（raw が真）は §5.5 の part=unreadable で開く | 上限のある構造なので snapshot に載る。U-W・U-F・U-N・U-V・U-M は項目を返す詳細が要約の索引か part=item にしか無いので、snapshot に置かないと full の間に parts を読む所が無い |

## 3. 上限の表

### 3.1 ヘルツの返事 5 の訂正（事実の表 1 より優先）

| 訂正 | 中身 | 本契約での扱い |
|---|---|---|
| U-V ashfalls.eventId | 表 1 から落ちていた。上限 64 | 事実の行 `eventId`（切らない） |
| U-R observedCompare | 型にあっても実の view では外す（`flood-unit.ts:309`〜`:314`） | 載せない（§1.3） |
| U-B eventId | 上限 40（`briefing.ts:5`〜`:6`・`:68`） | 事実の行（切らない） |
| U-V shortfalls | id 64・最終時刻 40・serial は空か 10 桁以下 | 事実の行（切らない）。id は `VocabItem.id` の材料 |
| U-W 区域 Code・U-F areaCodes | 桁数・件数の定数なし（数字だけ） | 鍵なので切らない。分野の 65,536 と要約で閉じる |
| U-W・U-F の報鍵の官署名 | 長さの制限なし | 報鍵（subject）は字のまま載せない（`id` の材料だけ） |
| source.reportDateTimeRaw の小数秒・serialRaw | 欄ごとの上限なし | §3.2 の生の字の欄（snapshot で 40 byte を越えたら null） |
| U-W の infoTypeRaw | 生の字のまま | §3.2 の生の字の欄 |
| U-W の affectedScope | unavailable の facts。上限なし | 載せない（§2.1） |
| U-R 浸水区域の stationCode・cityCode・件数 | 専用の上限なし、全体 32,768 byte | 鍵と件数は切らない、名前の 4 欄は §3.2 |
| U-W の府県・府県表示鍵 | 府県は 1〜2 桁、府県表示鍵は最大 16 字 | 事実の行 prefecture（切らない） |
| 有限の列 | M の tags 16 語 × 24、F の knownCodes 最大 11 種、unreadable parts は 1 つの印に 16 件（U-V の警報は陸上・海上の両側で 32 件）・scope 128 byte、R の局別 riverCodes 最大 4 | §2 のとおり切らない |
| 入力 XML | 本文・要素の字（text node 16,384 字、`decode-material.ts:26`）・ノード数に上限 | 上限なしの字の欄の真の上限は 16,384 字（escape の最悪で 98,304 byte） |

### 3.2 新しく切る欄（snapshot だけで切り、詳細では切らない）

| 欄 | snapshot の上限（escape 後の byte） | 切ったときの印 | snapshot から落ちるもの | 全文を読む所 |
|---|---|---|---|---|
| U-W の Kind/Name（phenomena の 2 列目） | 1,536 | `cut: true` | 1,536 byte から後 | 詳細 part=item（§5.5） |
| U-F の office（事実の行） | 256 | `cut: true` | 256 byte から後 | 詳細 part=item（§5.5） |
| U-R の浸水区域の name・prefecture・city・subCities | 1,536 | `cut: true` | 1,536 byte から後 | 詳細の索引の項目（§5.3）と part=item |
| 生の字の欄（time・serial・`source.infoType`） | 40 | 欄を null（B0 の表 §1.3 の時刻の行と同じ） | その欄（時刻・番号・InfoType）が不明になる | 詳細の項目（生の字の欄も詳細では切らない） |
| 9 分野の読めない報のカードの題・見出し（D-B0-CARD-TEXT=A を当てる） | 題 96・見出し 384 | `cut: true` | 題の 33 字目ほど・見出しの 129 字目ほどから後 | B0 の part=raw の原文 |

- 詳細（索引の項目と part=item）は同じ関数で作り、切る段だけを外す（上限の表を渡さない）。型は snapshot と同じで、snapshot で `DisplayCutText` の欄は詳細でも `DisplayCutText`（`cut: false`）にする（k ごとの閉じた union を 1 つに保つ）。
- 詳細の 1 件が 1 応答の 65,536 byte に入らないことは合法の電文でもありうる: U-R の 1 件は escape の最悪（1 字 6 byte・数は最長の表現）で、浸水想定地区を除いて 72,781 byte、浸水想定地区の上限 32,768 を足して 105,549 byte と見積もった（flood.ts の BOUNDS・LIMITS から node で組んだ形）。U-W も異なる 2 コードに各 16,384 字の名前があれば全文だけで 98,304 byte になる。そのとき part=item は B0 の 503、索引はその項目を印で示すだけになる。その項目が 1 応答に入らない間は、snapshot で切った字の続き（full の間も戻らない）と、要約の間のその項目の中身が読めない（作者の分岐 P4-DV-D-ITEM-OVERSIZE）。
- U-F の office の 2 つの切れ目: snapshot は escape 後の 256 byte（`WIRE_LIMITS` と同じ単位）、U-F の既存の索引は素の UTF-8 の 256 byte（`weather-timeseries-unit.ts:613`〜`:623`、孤立サロゲートは U+FFFD）。引用符・バックスラッシュ・制御文字を含む官署名では snapshot の方が手前で切れる。揃えずに両方を残す（既存の索引は P3-UF-PUBLIC-001 の形）。
- unit が字数の上限を持つ欄（BOUNDS・LIMITS、UTF-16 の長さ）は新しく切らない。wire の上限はその字数 × 6 byte（escape の最悪）。
- 鍵（区域 Code・Kind/Code・stationCode・cityCode）は切らない（切ると別の区域に読める）。
- 上限の表の置き場: B0 の上限の表 `WIRE_LIMITS` と切る関数 `cutText` を新しい file `display-vocab.ts` へ移し、本表の上限を同じ表に足す。`display-wire.ts` は import して同じ名で再 export する（`display-wire.test.ts:21` が `display-wire` から import するので壊さない）。`owner-runtime.ts` は `display-vocab.ts` から import する。表は 1 つのまま（P4-DW-D-STRING-SOURCE）。移す理由: `display-wire.ts` は domain の module（`domains/seismic`・`domains/tsunami`）を import し、owner-runtime がそれを読むと循環する。

## 4. 予算と 1 MiB

### 4.1 新しい経路の上界（数え直し）

| 部分 | byte | 出どころ |
|---|---|---|
| 保護 3 分野（組 A短） | 180,826 | `node reconstruction/contracts/p4-display-wire-max.mjs` の newPath.protected |
| 通知 | 131,072 | 同 newPath.notices（64 件、spec §8.4） |
| 共通部 | 65,536 | 同 newPath.common（今の上界 49,443、`p3-recovery.json:952`） |
| 9 分野の要約 1 つ | 3,882 以下 | `p2-snapshot-sse.json:73`（spec:1381 の 4 KiB）。新しい経路の要約は旧と同じ形 |
| 9 分野の full 1 つ（要約にしないとき） | 制限なし（全体が 1 MiB 以下の間） | 今の規則（§4.2） |
| 9 分野の full 1 つ（全体が 1 MiB を超えた後に残るもの） | 65,536 以下 | 同上 |

- 全公開の上界は 1,048,576（ヘルツの指摘に答える形）: (a) 全体が 1,048,576 以下なら、9 分野が 65,536 を超えていても full のまま公開し、その公開は 1,048,576 以下。(b) 超えたら 65,536 を超えた 9 分野を要約にし、残る full はどれも 65,536 以下、要約はどれも 3,882 以下なので、公開は 180,826 ＋ 131,072 ＋ 65,536 ＋ 9 × 65,536 ＝ 967,258 以下（9 分野がちょうど 65,536 の full のとき最大、1 MiB の余り 81,318）。
- 数え方: script の newPath.sum（377,434）に 9 × 65,536 を足した（`node reconstruction/contracts/p4-display-wire-max.mjs` の出力を node で読んで足した。script は変えない）。
- 9 分野のカードは full の包みに入り、包みの byte に数える。U-Y のカード 8 枚の区域列（1 枚 24,576 byte まで）や U-M の 16 枚で包みが 65,536 を超えても、(b) の場合は要約になってカードごと外れる（旧の要約と同じ）ので上界は崩れない。
- 保護 3 分野のカードは区域列を持たない（区域列は U-Y だけ、`checkpoint.ts:689`〜`:691`）ので、B0 の 180,826 の数え方（1 枚 459 byte と題・見出し）のまま効く。

### 4.2 9 分野の要約の規則（統合担当の決め 4）

- 今の規則を新しい経路の 9 分野にそのまま当てる: 新しい経路の snapshot の全体が 1,048,576 を超えたときだけ、包みの byte が 65,536 を超えた 9 分野を要約にする（`view-projector.ts:904`〜`:906` と同じ式）。保護 3 分野は要約にしない（H37）。
- 要約の形は旧と同じ（`view-projector.ts:761`〜`:765`）で、カードを持たない。要約の間に読める範囲と入口は §5.3。
- 分野の byte は語彙の形の byte で数える（view の形の byte ではない）。旧の経路で full の分野が新しい経路で要約になる（またはその逆）ことはありうる（残存）。
- 無いと壊れる振る舞い: 規則が無いと、9 分野の合計が 671,142 を超えたとき新しい経路の snapshot が 1 MiB を超える。分野ごとの予算の配り方（土砂の 96,460 byte など）は B1 が決める。

### 4.3 包みの items を新しい経路の差分から数える（統合担当の決め 3、台帳 147）

- 今の B0: 保護 3 分野の包みの items は旧の射影の state から借りる（`display-wire.ts:622`・`:624`・`:626` の `input.domains.*.full.items`）。旧の射影は停止の確定の差分を受けない（`composition-root.ts:1601` は差分を新しい経路の `wireChanges` にだけ積む）ので、確定の時の期限で消えた記録を有効と数えたまま公開する。
- 差分の併せ方: 同じ (unit, operation, subject) の差分が 1 回の公開に 2 回以上あれば、最初の before と最後の after を使う（`projectSnapshot` と同じ）。B0 の `changesOf` は after だけを残すが、items の数えは before が要る。
- 直し: 新しい経路は 12 分野とも自分の `projectDomain` の state を持ち、自分が受けた差分（`wireChanges` と step の差分を合わせ、停止の確定の差分を 1 度だけ当てたもの）と確認の状態（`state.confirmation`、`composition-root.ts:239` と同じ）から items を数える。`view-projector.ts` は `projectDomain` と 12 個の tally の関数を file の最後の新しい export の行で出すだけで、旧の出力と `:932` の export の行は変えない。保護 3 分野も同じ直しに入れる（B0 の file を開いて、同じ借り方であることを確かめた）。
- 受入の試験（ヘルツのイベント列、U-R・同じ運用区分）: (1) 有効な洪水 1 件を受ける → 新しい経路の items の activeCount 1 (2) 期限で消える → 0 (3) 再起動して別の有効な記録を復元 → 1 (4) 取り直しを採用（有効 1 件のまま）→ 1 (5) その 1 件の期限が shutdown の入力と cutoff の間に来て、停止の確定で回収される (6) 次の公開で、full でも要約でも activeCount が 0、語彙の項目も 0 件、索引の項目も 0 件。
- 費用: `projectDomain` は配送済みの増分の計算（P2-A8-COST）で、移行中は旧と新で 2 回走る（B0 の二重の射影と同じ扱い）。変わった subject の数 K に比例する分のほか、分野ごとに索引の写し（areaRefs・severityRefs・timeRefs の Map の写し、`view-projector.ts:583`〜`:585`）と時刻の走査（`latest`）が索引の大きさ N に比例する（旧の射影と同じ O(N)、全件×全件ではない）。
- `projectDomain` は最初の射影の差分が view を覆わないと止まる（`view-projector.ts` の startup の検査）。製品では起動の step の差分が全部の subject を足す（P2-A1-DISPLAY-CHANGES）ので覆う。B0 の試験の補助 `wire(units, changes, null)` には覆わない形の呼び出しがありうるので、実装は期待を変えずに補助で差分を組み直し、直した呼び出しの数を成果物に書く。
- 画面のお知らせ（notices）は今も旧の射影から借りる（本契約の範囲外、§10）。

## 5. 詳細

### 5.1 part ごとに変えるか（B0 の §2.3 の行）

| part | 変えるか | 理由 |
|---|---|---|
| U-L・U-R・U-B・U-Y の索引の項目 `item` | 変える: 項目を語彙の項目（索引用の閉じた型）にし、字は切らない | 9 分野の項目を要約の間に読む口 |
| U-N・U-V・U-M の索引の `text` の項目 | 変える: 9 分野の全部の項目（U-N の現況・情報、U-V の警報・噴火・降灰・解説・不足、U-M の竜巻・熱中症・短命）を `item` の項目にし、U-N の情報と U-V の解説の本文の参照（id は生の subject、rev は三つ組）は項目の `ref` に移す。U-M の text の項目は外す（開ける要求が無かった） | 要約の間に警報・噴火・降灰・現況・竜巻・熱中症が読めなかった（契約適合 P2-3） |
| 各分野の `index` の要求・参照（id を持たない、revision は分野の contentRevision） | 変えない | 参照の形（B0 の表 §2.3） |
| U-N・U-V の本文 `text` | 変えない | 配送済みの口（P3-BULLETIN-TEXT-API-001） |
| U-E の `areas`、U-T の `areas`・`stations`・`comment`、U-Q の `event` | 変えない | 保護 3 分野の専用部品（EEW・津波の大カード、地震の行）の材料（P4-DV-D-DETAIL-SCOPE） |
| 読めない報のカードの `raw` | 変えない | 原文の字 |
| U-W・U-F の既存の part | 変えない | 配送済みの口（P3-UW-CANON-001・P3-UF-PUBLIC-001） |

- 索引の項目の型: `{ id, revision, operation, part: "item", item }` の item は、索引に出る 15 種（17 種から weatherCurrent.area と weatherTimeseries.subject を除く）の閉じた共用体にし、unit ごとに出せる種類を型で縛る（U-L は landslide.office だけ、など）。id と revision は元の view の object で作る（今の式のまま）。

### 5.2 snapshot の項目の `ref`

| 種類 | part | id | rev |
|---|---|---|---|
| weatherCurrent.area | areas（U-W の既存の口） | 公開形の id | 公開形の revision |
| weatherTimeseries.subject | current（U-F の既存の口。lastKnown の part も同じ id と revision で開け、lastKnownPeriodCount が null でないときだけ開く） | 公開形の id | 公開形の revision |
| nankai.information・volcano.bulletin | text（本文の口） | view の生の subject | source の三つ組の JSON 配列の字 |
| ほかの 13 種 | — | — | `ref` は null（項目の全部が snapshot にあり、開く part が無い。全文は §5.5 の part=item） |

### 5.3 要約の間の入口と到達（統合担当の決め 4）

| 分野 | 要約の間の入口 | 読める範囲 |
|---|---|---|
| U-W | U-W の P3 の索引（既存の口・既存の URL、`part=index&revision=<contentRevision>`） | 府県の行ごとの areas・lastKnown の詳細。語彙の項目そのものは §5.5 の part=item |
| U-F | U-F の P3 の索引（既存の口・既存の URL） | subject ごとの current・lastKnown。語彙の項目そのものは §5.5 の part=item |
| U-N・U-V・U-L・U-R・U-B・U-M・U-Y | B0 の新しい経路の part=index（包みの contentRevision） | 全部の項目（§5.1 の item の項目） |

- 索引のページ: 1 ページに 32 件まで。HTTP の本文を wrapper 込みで加算して 65,536 に入らない項目は、そのページに置かず次のページの先頭へ繰り越す（ページの境は先頭から詰めて決める）。1 件だけで 1 ページに入らない項目は、そのページに `{ index, reason: "pageBudget", id, revision }` で示し、次のページへ進む（part=item も 1 応答に入らないので、その間は中身が読めない。§3.2、P4-DV-D-ITEM-OVERSIZE）。pageCount は全部の項目を覆うページの数。
- ページの境を決めるには前のページの項目の byte が要る。統合担当の決め 8（当該ページだけを変換）と合わせるため、owner は索引の版（unit の state の object）ごとに 1 度だけ全部の項目を変換して境を数えて持つ（P4-DV-D-INDEX-PAGING=A）。この版ごとの 1 回の変換の手間は、PM（P4-DISPLAY-MEASURE-001）へ送る測定の項目に足す（spec:1288 の開始済みの射影の非中断区間、B0 の表 §9 の rev の作り直しと同じ扱い）。

### 5.4 開け直す型と変える配送済みの契約

| 開け直すもの | 所 | «» の行 | 変え方 |
|---|---|---|---|
| `p4-display-wire.types.ts` | `DisplayWireSnapshot`（:102〜:119）の current に 9 分野、`DisplayWireVersion`（:101）を v2、`WireIndexEntry`（:134〜:138）の item を索引用の語彙の型にし、使わなくなる `part: "text"` の項目（:136）を外す（足す前に引く）、`WireDetailRequest`・`WireDetailResponse` に §5.5 の part、語彙の型 | 0（どの契約も引かない） | 行の中と file の最後 |
| `display-wire.ts` | 9 分野の射影・要約の規則・12 分野の items（§4.3）。`WIRE_LIMITS` と `cutText` を `display-vocab.ts` から import して再 export | P4-TSUNAMI-MULTI-EVENT-001 が :31（`WIRE_LIMITS` の eventId の行）を、P4-REMOVAL-LOSS-001 が :27（`VERSION`）・:114（`refOf`）・:580 を引く（発注前点検、§12）。配送で付け直す | 行の中と file の最後 |
| 新しい file `display-vocab.ts`（`reconstruction/src/view-projector/`） | view の要素 → 語彙の項目の純粋な関数（snapshot は切る、詳細は切らない）、`WIRE_LIMITS`、`cutText` | — | 新しい file。contracts の型だけを import する |
| `view-projector.ts` | `projectDomain` と 12 個の tally の関数を file の最後の新しい export の行で出す | :906・:932 が引かれる。最後の行（:936）より後は 0 | file の最後に 1 行足すだけ |
| `owner-runtime.ts` | `wireIndex`（:872）の 7 分野の項目、ページの境（§5.3）、§5.5 の part | :774 より後は 0 | :774 より後の行の中。import も :774 より後に置く |
| `composition-root.ts` | `wireInput`（:2497〜:2506）に 9 分野の view と `state.confirmation` を足し、旧の射影の domains を渡さない | :2462 より後は 0 | :2462 より後の行の中 |
| `http-sse.ts` | `parseWireDetail`（:362〜:380）に §5.5 の part（P4-DV-D-HTTP-PARTS=A） | :258 より後は 0 | :258 より後の行の中 |
| 試験の期待 4 か所 | `test/display-wire/wire-client.ts:5`（版の字）、`display-wire-root.test.ts:84`〜`:85`（current の鍵と包みの鍵、:80 の it の題）、同じ file の :130〜:144 の it、`display-wire-detail.test.ts:74`〜`:103`（U-N・U-V の text の項目を item の項目の ref から開く）と :138（U-M の索引の revision が view の object の sha256 になる） | 0 | 行の中 |
| 試験の補助 2 か所 | `test/display-wire/display-wire-fixture.ts:82`、`display-wire-root.test.ts:135`（views に 9 分野の view と confirmation を足す）。期待は変えない | 0 | 行の中 |
| P4-DISPLAY-WIRE-001 の条文（統合担当の配送の一覧（AC07 (4)・allowedPaths と同じ列挙） (a)） | contract.objective、AC01、AC08、RES-03、P4-DW-D-DETAIL-PAYLOAD の reason、P4-DW-D-STRING-SOURCE、P4-DW-D-SCOPE-NARROW の A、P4-DW-T08 の behavior、outOfScope の 9 分野の行。行の中に本契約の ID の注記を書き meta.sha256 を取り直す（p4-display-wire.json の行は P4-REMOVAL-LOSS-001 が :189〔P4-DW-D-SCOPE-NARROW の A〕を引くので配送で付け直す、§12） | P4-REMOVAL-LOSS-001 が :189 を引く（(d)） | 行の中 |
| `p4-display-wire-tables.md`（統合担当の配送の一覧（AC07 (4)・allowedPaths と同じ列挙） (b)） | :177・:178・:179（§2.2 の U-N・U-V・U-M・U-L・U-R・U-B・U-Y の行）、:190・:192（§2.3 の参照の表の項目と本文の行）、:206（§3.2 の 377,434・縮退の規則を持たない）、:215（読める組の表の B0 の後の行）に本契約の ID の注記。:192 は B0 の AC08 が、:206・:215 は B0 の AC01 が «» で引くので付け直す | :192 を B0 の AC08、:206 を B0 の AC01 と本契約、:215 を B0 の AC01 が引く（行の中を変えたら付け直す） | 行の中 |
| P4-TSUNAMI-MULTI-EVENT-001・P4-REMOVAL-LOSS-001 の «»（統合担当の配送の一覧（AC07 (4)・allowedPaths と同じ列挙） (d)、発注前点検で足した） | TME の `display-wire.ts:31`（配送の木では `display-vocab.ts` の `WIRE_LIMITS` の行）、REMOVAL-LOSS の `display-wire.ts:27`・`:114`・`:580` と `p4-display-wire.json:189` を配送の木の行に付け直し、両契約の meta.sha256 を取り直す。本契約自身の «»（p4-display-wire.types.ts:101・:102・:134、display-wire.ts:622、owner-runtime.ts:874、composition-root.ts:2497、http-sse.ts:362、test/display-wire/ の wire-client.ts:5・display-wire-root.test.ts:143・display-wire.test.ts:21、p4-display-wire-tables.md:206）も配送の木の行に付け直す | 本契約の実装の後の check-contract はこの 2 契約と本契約で FAIL しうる（見込みの FAIL、AC07 (2)） | 行の中 |
| 計画 `p4-order-plan.md`（統合担当の配送の一覧（AC07 (4)・allowedPaths と同じ列挙） (c)） | 済み: 統合担当が 3f778efc で :192（Wave 2）・:223（snapshot の型の直列）・:230（http-sse.ts の直列）を行の中で直した。配送で触る行は無い | — | — |

- :130〜:144 の it の直し方（B0 の P4-DW-T08 の条文を残す）: 本契約の後は 12 分野とも新しい経路に載るので、U-F だけが変わる step では新しい経路も変わる。新しい経路に載らない欄だけが変わる受信の step は、もう組めない: 表示差分は必ず分野の contentRevision を上げて包みに載り、期限の欄も載り（決め 2）、notices は旧から借り、共通部の connection・worker は両方の比べが全部の欄を見る（`sameSnapshot` と `comparable`）。旧だけが変わるのは旧の経路の要約の切替（12 分野の view の形の合計が 1 MiB を越える）だけで、試験で組むには 1 MiB の view が要る。it は「旧の射影が projected を返す step で、新しい経路の入力（差分・views・共通部）が前と同じなら新しい経路は unchanged」を、旧の射影の入力だけを変えて組む形に書き換える。経路ごとの公開の独立は :104 の it（旧の射影を unchanged に固定）が逆向きを見る。
- `display-vocab.ts` が無いと壊れる振る舞い: owner（worker）と publisher（main）が同じ項目を別々に組み、snapshot と詳細で語彙が食い違う。owner-runtime は unit・domain の module を読むと循環する（`owner-runtime.ts` の詳細の写しのコメント）。
- 変えないもの: `p3-execution-split.types.ts`（:73・:142 は `p4-display-wire.types.ts` の別名なので型の変更が届く）、旧 `/events` の出力、P2-SNAPSHOT-SSE-001 の P2-A8-COST（新しい経路の直列化は公開ごとに 1 回のまま）。
- rev の式（その part が返す view の object の JSON の sha256）は変えない。語彙は view の object の純粋な関数なので、object が同じなら語彙も同じ。

### 5.5 新しい part（統合担当の決め 5・6、P4-DV-D-HTTP-PARTS）

| part | 要求 | 応答 | 無いと壊れる振る舞い |
|---|---|---|---|
| `item` | `{ unit: 9 分野, part: "item", id, revision }`（page なし。id は `VocabItem.id`、revision は view の object の sha256。U-W・U-F は公開形の id・revision） | 切らない語彙の項目 1 件 | U-W の Kind/Name・U-F の官署名の全文がどこからも読めない（U-W の詳細の行は pageBudget で繰り越さず、U-F の索引は 256 byte で切る） |
| `unreadable` | `{ unit: 9 分野, part: "unreadable", id, revision }` | `{ sides: [{ side: "land" か "marine", parts: [{ site, scope か null, raw か null }], headline か null }] }`。side は印ごと（U-V の警報だけ marine を持ち、ほかは land だけ）。parts は欠片の鍵 (site, scope) ごとに 1 件で、U-F の付加事項は site `addition` の欠片として parts に入る（view では一覧から外し addition の真偽にした分、`unreadable.ts:325`〜`:328`）。両側で parts 32 件・見出し 2 つまで、1 件 1,538 byte で数えて 58,004 byte ほどで 1 応答に入る | 一覧 unreadable の raw が真の部分の原文を開く part が無い（H51、契約適合の証拠不足） |

- どちらも owner の `wireDetail` で読むだけ（state も期限も動かさない）、1 応答 65,536 を越えたら B0 の 503。U-W の要求は今の U-W の口（part は index・areas・lastKnown）と part の名が重ならないので、owner の振り分け（`isWireDetail`）で part=item・unreadable の U-W・U-F を新しい part に送る。
- `http-sse.ts` の `parseWireDetail` を触るので、計画 §3.2 の `http-sse.ts` の直列（B0 → B1 → R0 → T0）に本契約を入れる: B0 → 本契約 → B1 → R0 → T0。

## 6. 受信経路の計算量（AGENTS.md）

| 手間 | 回数 | 上界 |
|---|---|---|
| 1. 項目を作り直す | その step の 9 分野の表示差分の subject ごとに 1 回（after から語彙の項目を作り、その項目だけを直列化して byte を数え、view の object の sha256 で `rev` を作る） | 変わった subject の数 K |
| 2. 並びを直す | 変わった K 件を id で並べ、前の並び（N 件）と 1 度だけ併合して新しい配列を作る（1 件ごとの splice をしない） | O(N ＋ K log K)。K 件の 1 件ずつの splice の O(KN) にしない |
| 3. 分野の byte | 変わった項目の byte の差を足し引きする（全体を直列化しない） | K |
| 4. 要約の判定 | 12 分野の byte の和と 9 分野ごとの比べ | 定数 |
| 5. 公開の比べ | 分野の wire は変わらなければ前の object を使い、参照で比べる（B0 の sameSnapshot） | 定数 |
| 6. 最初の射影 | 9 分野の view を 1 回だけ全部読む（P2-A8-COST の最初の 1 回） | 起動と streamId の変わり目だけ |
| 7. view の固定の部分 | 表示差分に来ない欄（U-V の `shortfalls`、U-W の `freshnessSuspectCount`。`view-projector.ts:452` の fixedBytes が要素の外に数える部分）だけを、view の object が前の step と違うときに読み直す（`view-projector.ts:571` の条件と同じ） | 固定の部分の大きさ（U-V の shortfalls の件数） |
| 8. items（§4.3） | 12 分野の `projectDomain` を差分だけで回す（配送済みの増分の計算） | 変わった subject の数 K に比例する分と、変わった分野ごとの索引の Map の写しと時刻の走査の O(N)（`view-projector.ts:583`〜`:585`、旧の射影と同じ） |

- 詳細の索引の境は要求の側（受信経路の外）で、unit の state の版ごとに 1 度だけ数える（§5.3）。

## 7. 直列と依存

| 衝突源 | 順 | 出どころ |
|---|---|---|
| `display-wire.ts`・`p4-display-wire.types.ts` | B0 → 本契約 → P4-REMOVAL-LOSS-001 → B1 → E0 発注 1 → C2 → T0 | 計画 db2b32d7 の §3.2 の行（統合担当が書いた） |
| `owner-runtime.ts` の `wireIndex`・`wireDetail` | B0 → 本契約 | 同じ関数の中 |
| `http-sse.ts` | B0 → 本契約 → B1 → R0 → T0 | 計画 3f778efc の :230（P4-DV-D-HTTP-PARTS=A で確定） |
| `view-projector.ts` | 本契約は file の最後に export の行を足すだけ。B1 の要約の規則（:904〜:906）とぶつからない | §4.3 |
| C0 発注 1（Wave 3） | 本契約の後 | U-W の語彙を読む |

## 8. U-M の本文

- 本文は P4-QUAKE-COMMENTARY-TEXT-001（計画 db2b32d7 の §2.3 の行、未起草）が持つ。本契約は local-bulletins の file も本文の口の型も触らない。
- 本契約の後、U-M の索引の項目は `item`（localBulletins の 3 種）になり、生の subject と三つ組だけの `text` の項目は外す。本文の契約は、短命の地震の解説の項目の `ref` に本文の参照を足す。

## 9. 分岐

| ID | 種類と状態 | 問い | ★推奨／決め | もう一方 |
|---|---|---|---|---|
| P4-DV-D-SUMMARY-RULE | 統合担当・確定 | 9 分野の要約の規則 | 今の規則・今の要約の形（カードを持たない） | 分野ごとに常に要約、要約にカードを残す |
| P4-DV-D-UNBOUNDED-TEXT | 統合担当・確定 | 上限の無い字 | snapshot で切って印、詳細では切らない | どちらでも切る、切らない |
| P4-DV-D-UNREADABLE-PARTS | 統合担当・確定 | 読めない印の parts | snapshot に一覧、部分の原文は part=unreadable | 真偽だけ |
| P4-DV-D-CARD-TEXT-9 | 統合担当・確定 | 9 分野のカードの題と見出し | D-B0-CARD-TEXT=A を当てる | 1,536 byte のまま |
| P4-DV-D-DETAIL-SCOPE | 統合担当・確定 | 語彙に変える詳細 | 9 分野の索引の項目と §5.5 の part だけ | 保護 3 分野の行も |
| P4-DV-D-ORDER | 統合担当・確定 | display-wire.ts の直列 | B0 → 本契約 → P4-REMOVAL-LOSS-001 → B1 | — |
| P4-DV-D-ITEM-ID | 統合担当・確定 | 安定した ID | 全項目に id、並びも id | — |
| P4-DV-D-EXPIRY | 統合担当・確定 | 表示の期限 | 全部写す | — |
| P4-DV-D-OWN-ITEMS | 統合担当・確定 | 包みの items | 新しい経路の差分から数える（保護 3 分野も） | 旧から借りる |
| P4-DV-D-HTTP-PARTS | 統合担当・確定 | part=item・unreadable と http-sse.ts の直列 | 本契約で足し、http-sse.ts の直列を B0 → 本契約 → B1 → R0 → T0 に | 足さない（U-F の官署名の 257 byte 目から後と部分の原文が読めない） |
| P4-DV-D-ITEM-OVERSIZE | 作者・起草案 | 1 件で 1 応答（65,536 byte）に入らない詳細の項目（U-R の escape の最悪 105,549 byte、U-W の 2 コードに各 16,384 字の名前で 98,304 byte） | ★A 索引に印 `{ index, reason: "pageBudget", id, revision }` だけを出し、part=item は B0 の 503。その項目が 1 応答に入らない間は、snapshot で切った字の続き（full の間も戻らない）と、要約の間のその項目の中身が読めない。実の電文では起きない見込み。A が成り立つのは B1 の通常合法最大の manifest（E13a）が最悪の 1 件を含まない場合だけで、含むなら spec:1341（通常合法 corpus の全ページで省略 0 件）で受入不可なので B に替える | B part=item をページに切り、1 件が 1 応答を超えうる 9 分野の項目の全部（U-W の phenomena と areas の一覧、U-R の stations・浸水想定地区の rows、U-Y の区域の rows、U-V の市町村の一覧、U-L の区域の一覧など、一覧と専用部品の rows）を 1 ページずつ返す。既存の U-W の areas の詳細も超えた行を繰り越さない（`weather-current-public.ts:290`）ので同じ形で直す B を選ぶときは発注の前に allowedPaths・AC05・outOfScope を改める。B でも 1 行・1 つの値だけで 1 応答を超えるもの（U-W の名前、4 byte の字で 65,536 byte）は切れずに残る |
| P4-DV-D-INDEX-PAGING | 統合担当・確定 | 索引のページの境 | 繰り越し、境は state の版ごとに 1 度数えて持つ（版ごとの変換の手間は PM の測定へ） | 32 件の固定ページで当該ページだけ変換し、省いた項目は印から part=item で開く |

- 作者の分岐は 1 件（P4-DV-D-ITEM-OVERSIZE）。統合担当の決め 1〜10 は画面から何も落ちない側を選んだが、1 件で 1 応答に入らない項目は、その間 snapshot で切った字の続きと要約の間の中身が読めない。

## 10. 未確認と証拠不足

- 証拠不足: 語彙の形の 9 分野の実の byte（corpus と災害の日の筋書き）は数えていない。旧の経路で full の分野が新しい経路で要約になる場合の数は B1。
- 証拠不足: U-Y の probability の 384 区域の 1 行の byte（cols の形で 1 行 60〜120 byte の見込み）は script に通していない。U-R の 1 件の 105,549 byte は view の形の見積もりで、語彙の形では cols の分だけ変わる。9 分野の実の電文の 1 件の最大は発注前点検で写した（§12.3）。語彙の形の実の byte は実装が無いので、成果物の残存に書かせる（artifactRequirements）。
- 確かめた（発注前点検 2026-11-22）: U-V・U-N の view を作る関数（`toVolcanoView`・`toNankaiView`）を開き、§2 の U-V の 6 欄と U-N の行と突き合わせて食い違いは 0（§12.4）。
- 確かめた（発注前点検 2026-11-22）: 新しい経路の notices は旧の射影から借りるので、停止の確定の差分で消えた記録のお知らせが expiresAt まで残る並びが組める（§12.5）。扱いは P4-REMOVAL-LOSS-001 の発注前点検で決める（同契約の Q-RL-PRECHECK に、閉じる条文にするか受け手を名指すかを統合担当が書いた）。

## 11. r1 の対応（統合担当の決め 10 個とレビュー）

| 決め | 直した所 |
|---|---|
| 1 安定した ID | §1.2 の `id`・並び、§1.3 の載せない欄、AC01・AC02、P4-DV-D-ITEM-ID |
| 2 表示を終える期限 | §1.5、AC02、P4-DV-D-EXPIRY、Q-DV-UF-RETAIN |
| 3 停止の確定の集計 | §4.3（保護 3 分野も）、AC11・T06、P4-DV-D-OWN-ITEMS |
| 4 要約 | §1.1・§4・§5.3、AC04・AC05、P4-DV-D-SUMMARY-RULE、P4-DV-D-INDEX-PAGING |
| 5 上限の無い字 | §3.2・§5.5、AC03、P4-DV-D-UNBOUNDED-TEXT |
| 6 読めない印の parts | §2.4・§5.5、AC08、P4-DV-D-HTTP-PARTS |
| 7 カードの題と見出し | §2.4・§3.2、P4-DV-D-CARD-TEXT-9（確定） |
| 8 ヘルツ P2 | §1.3（names は codes の部分集合、sv の表）、§6 の併合、§5.1 の索引の閉じた型、§5.3 の版ごとの境 |
| 9 契約適合 P2 | §5.4（B0 の注記の全部・再 export・:130 の it・閉じた union）、AC07 |
| 10 契約適合 P3 | §1.1（鍵と semanticRevision の並び）、§1.3（unknown を外す・sys・素の字）、readPaths、O09 は T02 |

## 12. 発注前点検（2026-11-22、main 9c79d678 の上）

### 12.1 «» の数え直し

- 本契約が変える file の最後の «»（本契約を除く全契約）は、`owner-runtime.ts` :774（P4-UW-RECOVERY-CUT-001）、`composition-root.ts` :2462（P3-E05P-TYPHOON-001）、`view-projector.ts` :932（P3-WEATHER-SHAPE-001、最後の行は :936）、`http-sse.ts` :258（P3-CLI-REPL-001）で、起草の時と同じ。起草の木 3434966e から 9c79d678 までに、これらの file と `display-wire.ts`・`p4-display-wire.types.ts`・`test/display-wire/` は変わっていない（変わったのは `tsunami.ts` の 2 行と `format.ts` の 1 行）。
- 起草の時の「`display-wire.ts` を引く «» は 0」「`p4-display-wire.json` の行を引く契約は 0」は、いまの木では成り立たない。起草の後に入った 2 契約が引く:
  - P4-TSUNAMI-MULTI-EVENT-001（配送済み）: `display-wire.ts:31`（`WIRE_LIMITS` の eventId の行）。本契約は `WIRE_LIMITS` を `display-vocab.ts` へ移すので外れる。
  - P4-REMOVAL-LOSS-001（未割当）: `display-wire.ts:27`（`VERSION`、本契約が v2 にする）・`:114`（`refOf`）・`:580`、`p4-display-wire.json:189`（P4-DW-D-SCOPE-NARROW の A、配送の一覧 (a) で注記を書く行）。
- check-contract は baseOid が未割当の契約の «» も照合する（P4-REMOVAL-LOSS-001 も PASS の行に出る）。付け直さないと本契約の配送の commit で CI が赤になるので、統合担当の配送の一覧に (d) を足した（AC07 (4)・allowedPaths・§5.4 の 3 か所）。(d) には本契約自身の «» で実装の後に外れうる行も並べた。
- `p4-display-wire-tables.md` の :206・:215 は本契約のほかに B0 の AC01 も引く（:192 は B0 の AC08）。配送の一覧 (b) の字を直した。
- 実装担当への字: 実装の後の check-contract は、上の 2 契約と本契約自身の «»（(d) に並べた行）で FAIL しうる。見込みの FAIL で、統合担当が配送で付け直す。check-contract は契約ごとに最初の FAIL で止まるので、実装担当は FAIL の出た契約と行を書いて返し、付け直さない（AC07 (2)、requiredCommands、artifactRequirements）。

### 12.2 U-W・U-F の part=item・unreadable の経路

- 経路: `http-sse.ts` の path の振り分け（:209、境より前、変えない）→ `parseWireDetail`（:362〜:379、境より後）→ `composition-root.ts` の詳細の union（:2438、`WireDetailRequest` の別名を引くので型の変更がそのまま届く）と unit による行き先（:1844 の `executionPlaces`。`unit-coverage.ts` で U-W は weatherCurrent、U-F は deferred の owner）→ `owner-runtime.ts` の `detailOwner`（:737、境より前、`isWireDetail` を先に見る）→ `isWireDetail`・`wireDetail`（:836〜:838・:908〜、境より後）。
- 境より前の行と `p3-execution-split.types.ts`（:73・:142 は型の名前を引くだけ）で変える行は 0。
- 実装で踏みやすい所が 2 つあり、AC12 に書いた:
  - `isWireDetail` は今、U-W を外し、`WIRE_UNITS` に U-F が無い。直さないと U-W の part=item・unreadable は `weatherCurrentDetail` へ、U-F は `bulletinText`（U-N の information を読む）へ着く。
  - U-W・U-F の revision は公開形の 10 進の字（U-F は `weather-timeseries-unit.ts:547`、U-W は内容版）。`parseWireDetail` の 64 桁の hex の検査（:373）より前に分岐を置く。

### 12.3 9 分野の 1 件の最大（P4-DV-D-ITEM-OVERSIZE の reason）

- 量り: 2026-11-22、main 034c515d の dist の unit に、手元の電文（`reconstruction/test/` の xml・manifest の telegramXml・`test/fixtures/`・気象庁の公式サンプル）を 1 通ずつ空の状態から通し、`toView` の要素 1 つの `Buffer.byteLength(JSON.stringify(item))` を数えた（view の形、非 ASCII を escape しない、包みと `subjects` を除く 1 件だけ）。034c515d から 9c79d678 までに 9 分野の unit・domain の src は変わっていない。
- 結果: 最大は U-Y の probability の 32,891 byte（65,536 の 50.2%、`76_01_01_200630_VPTA50`、区域 273・府県 45）、次が U-R の 6,211（9.5%）。ほかの 7 分野は 6,000 未満（U-M 5,282・U-W 4,666〔時刻順に 1 つの状態へ通した累積で 5,594〕・U-B 1,922・U-V 1,886・U-F 1,491・U-N 1,143・U-L 835）。実の電文で 65,536 に届く分野は無い。
- U-Y を unit の上限（区域 384・府県 96・名前 24 字）まで 3 byte の字の名前で埋めると、view の形で 76,074 byte で 65,536 を超え、語彙の形（鍵を落とした rows の粗い写し）で 52,842 byte。語彙の形の数は実装が無いので見積もり。
- 定義の違い: P4-DV-D-ITEM-OVERSIZE の reason の 105,549（U-R）・98,304（U-W）は escape の最悪の合法の見積もりで、上の実測（escape なし）と同じ比べに並べない。
- A が成り立つ条件（B1 の通常合法最大の manifest E13a が最悪の 1 件を含まないこと）は、計画 §4.3 の 6（E13a に入れるもの）の行の中に書いた。

### 12.4 U-V・U-N の view を作る関数（§10 の未確認 1）

- `toVolcanoView`（`volcano-unit.ts`）は active で保留でない記録を `shown`（`notice-mark.ts`）で返し、解説は `headingOf` で text・nextAdvisory を外す。`shown` は notice・marineNotice を外して unreadable・marineUnreadable を view の印にするだけで、値を変えない。`toNankaiView`（`nankai-unit.ts`）も currents を `shown`、information を `headingOf` で返す。
- §2 の U-V の 6 欄（alerts の municipalities・marineAreas、marineUnreadableView、eruptions の municipalities、ashfalls の groups、bulletins の volcanoCodes）の上限は、domain の入口（`volcano.ts` の BOUNDS・LIMITS・ASH）と codec の両方で表と同じ。U-N の列は subjects だけで、infoSerial は単値（§2.2 と一致）。食い違いは 0。
- 書き足し 3 つ（行き先は変えない）: alerts の codes 128・32 は group ごとではなく全 group の合計。警報の区域 code は 16 字まで（codec）。unreadableCards は `toView` ではなく owner（`owner-runtime.ts`）が全 unit に付ける。

### 12.5 新しい経路の notices（§10 の未確認 2）

- 新しい経路は notices を旧の射影の state から写す（`composition-root.ts:2505` の `notices: previous.notices` → `display-wire.ts` の `notices: input.notices`）。旧の射影の notice は差分（`view-projector.ts:831`）・取消の outcome・TTL（`:861`）でしか消えず、停止の確定の差分は新しい経路にだけ渡る（`composition-root.ts:1601`）。
- 組める並び（U-E）: t=0 に報時刻から 595 秒たった EEW の新しい報を受ける（currentUntil は t+5s、旧の射影の notice の expiresAt は t+15s）→ t+2s に停止が始まる → t+6s の確定で期限の回収が差分を出し、新しい経路の U-E は current を外す → 旧の射影は差分を受けないので「緊急地震速報を確認」の notice が新しい経路に t+15s まで残る（ほかの 11 unit は 60 秒、`view-projector.ts` の TTL）。最後の段がそれより前なら、最後の snapshot に残る。
- 本契約の範囲（9 分野の語彙と items）の外。受け持つ字は P4-REMOVAL-LOSS-001・計画の B1 の行のどちらにも無かったので、統合担当が P4-REMOVAL-LOSS-001 の Q-RL-PRECHECK に「消え方の届け方で閉じる条文にするか、閉じないなら受け手を名指す」を足した。新築は切替の前なので、画面に出るのは新しい経路を開いた試しの画面だけ。

### 12.6 そのほか

- Q-DV-UW-AREA-NAMES: G0 発注 2 の区域コードの表で 4 層は名前つきで揃った（府県予報区等 64・一次細分区域等 142・市町村等をまとめた地域等 375・市町村等 1,805）。高潮予報区間の層は表と型に無く、市町村等の表は市全体のコード（1410000 横浜市など）を持たず分けたコードだけで、VPWS50 の fixture（`15_18_01_250630_VPWS50`）の市町村等のコード 15 個が表に無い（15 個とも floodCity にはある）。止めるのは C0 発注 1 で、開けたままにした。
- Q-DV-UF-RETAIN: 開けたまま（止めるのは C1 の板）。U-F の state は retainUntil を持ち、公開形は validUntil だけを写す。P2-A8-T06 は retainUntil が先に過ぎた記録の回収の試験で、公開形から欄を消した記録ではない（契約の字を直した）。開け直すときに外れうる «» を数えた（契約の resolveBy）。
- 費用: 12 分野の projectDomain が移行中に旧と新で 2 回走ることは、P2-A8-COST（1 回の射影の規則）にも B0 の例外（直列化の回数と段 1 の記録）にも書かれていなかった。統合担当の決め P4-DV-D-DOUBLE-PROJECTION で本契約に書き、計画 Wave 4 の PI 発注 1 の行の中に足した。
- 直列: P4-DV-D-ORDER と Q-DV-REMOVAL-ORDER の順は、P4-REMOVAL-LOSS-001 の P4-RL-D-ORDER=A（2026-11-22）と同じ。字に確定の日付を足した。

### 12.7 配送（2026-11-22）で写した実装の事実と残存

- 実装の外れで採用したもの（契約適合レビュー）:
  - 最初の射影の差分が view を覆わない `wire(…, null)` の呼び出し 3 か所（`display-wire.test.ts`）は、差分の側ではなく保護 3 分野の view を差分から組み直す補助で直した。期待は変えていない（AC07 (3) に注記）。
  - 事実の行を 2 つ足した: U-R の `inundation`（浸水想定地区の有無の真偽。鍵が無い〔読めない〕と空を分ける）と、U-B の VPOA50 の `inherited: null`。§2.2 の行き先は変えない。
  - U-W の part=unreadable は sides がいつも空。U-W の公開形が読めない印を持たないため（§2.4 の「9 分野」の書き方とずれる）。U-W の読めない報は B0 のカードと part=raw で読む。
  - 保護 3 分野の包みに delivery の鍵は無い（B0 のまま）。`VocabWire` は分野ごとの型にせず k の union。
  - 1 件で 1 応答に入らない索引の項目は、いつもその項目だけのページになる。
- 1 MiB の判定は、9 分野の和が 671,142（1,048,576 − B0 の上界 377,434）を越えたときだけ全体を数え、数えるときは保護 3 分野・通知・復旧の digest の byte を object ごとに覚えて変わった object だけを数え直す（品質レビューの P3 の直し）。
- 残存:
  - T06 は「受ける → 停止の確定 → 公開」の列だけで、期限で消える → 再起動・復元 → 取り直しの採用は流していない。U-R の場面は composition-root を通さない（EEW の場面は通す）。
  - O09 の試験は restart で状態が空に戻り、失敗注入 55 回と fixtureId の無い受信 2 回を飛ばす（品質レビューの P3）。
  - `VocabIndexItem<Unit>` は型を出しただけで、索引の応答を縛らない（契約適合の P3）。
  - T07 は U-W の lastKnown を通していない。
  - U-W の分野は語彙の形で 1 通 93,743 byte になる fixture がある（`synthetic_VPWS50_national_training_0907_1301`、旧の view の形でも 110,616）。全体が 1 MiB を越えない間は full のまま。B1 の材料。1 件の最大は U-Y の 16,406 byte、ほかの分野は 7,006 以下（実装の子の量り、語彙の形）。
  - 671,142 の近道は、B0 の上界 377,434 が保護 3 分野・通知・共通部の実の上界であることを script の数で頼る（契約適合の証拠不足）。
  - snapshot の rev と owner の revision の一致は、U-R・U-N・U-V を関数で、U-L・U-B・U-M・U-Y を corpus の試験（T01・T04・T07）でだけ示す。
  - 削除候補: `display-wire-root.test.ts` の停止の場面の件数の照合は、直前の同じ停止の場面へ移せば停止待ち 1 回（約 5 秒）を省ける（品質レビュー）。
