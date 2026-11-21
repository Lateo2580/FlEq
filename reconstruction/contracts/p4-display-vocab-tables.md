# P4 9 分野の表示語彙の表 r0（P4-DISPLAY-VOCAB-001 の起草の最初の成果物）

- 起草日: 2026-11-21（起草の子 r0）。base: `37fbd7f3cf6a175af75067c0ad34efb590b1971d`（branch draft/p4-vocab）。
- 目的: B0（P4-DISPLAY-WIRE-001）が新しい経路 `/display-wire` に載せなかった 9 分野（U-W・U-F・U-N・U-V・U-L・U-R・U-B・U-M・U-Y）を、同じ経路に載せる形を決める。
- 入力の事実: 事実の表 r0（repo 外、main 093dc8b9 から起こした表 1・表 2）とヘルツの確かめ（repo 外、HEAD 37fbd7f3）。食い違う所はヘルツの返事を正にした（§3.1）。9 分野の domain・unit・型の file は 093dc8b9 と 37fbd7f3 の間で変わっていない（`git diff --stat 093dc8b9 37fbd7f3 -- reconstruction` で変わったのは eew・seismic・tsunami・owner-runtime・composition-root・http-sse と B0 の file）ので、事実の表の行番号は 9 分野についてそのまま効く。
- 読み比べ: B0 の表 r7 の §12（f3b61acf）は前提が崩れて外した案。語彙の種（見出し・事実の行・区域の一覧・文章）はそこから借りたが、写していない。崩れた 2 つ（辞書と構造の列）には §1.3 と §2 で行き先を 1 つずつ決めた。
- 範囲外: H17・H39 の値（P4-REMOVAL-LOSS-001、まだ契約は無い）、B1 の予算の配り方、U-M の本文（§8）、描き方（C0・C1・C2 の板）。
- 印: 「新しく切る」は今の view に無い切り方。「落とさない」は今の view の欄を wire から外さないこと。

## 0. 結論

- 9 分野の wire は 1 つの形（§1 の語彙の項目 `VocabItem`）に写す。単値と展開の欄は事実の行、上限のある列と辞書は一覧（`VocabList`）、台風の予報円と水位のミニグラフだけ専用部品（`special`）にする。
- 表 1 の ✕ 26 欄の行き先は、snapshot の一覧 23・専用部品 3・詳細だけ 0（§2）。共通の 3 種は、`subjects` を載せない、`unreadableCards` を B0 と同じ短いカードで載せる、`unreadableView` を印の真偽と parts の一覧で載せる。
- 新しく切るのは、unit が上限を持たない字の欄（U-W の names の値・U-F の office・U-R の浸水区域の名前 4 欄）と生の字の欄（時刻・番号・InfoType）で、実の電文と corpus では切れない長さに置く。もう 1 つ、9 分野の読めない報のカードの題と見出しを B0 と同じ 96・384 byte で切る案は実の字に届くので作者の分岐にした（§3.2、P4-DV-D-CARD-TEXT-9）。
- 予算: 9 分野は今の規則（全体が 1 MiB を超えたときだけ 65,536 を超えた分野を要約）を新しい経路にも当てる。上界は 180,826 ＋ 131,072 ＋ 65,536 ＋ 9 × 65,536 ＝ 967,258 で、1 MiB の余りは 81,318（§4）。B0 の表 r7 §12.4 の考え方は今も効く。
- 詳細: B0 の索引の `item`（U-L・U-R・U-B・U-Y）の中身を語彙の項目に変える。rev の式は変えない（§5）。
- U-M の本文は本契約に入れない（local-bulletins の unit と保存の形に手が入る、§8）。
- 直列: B0 → 本契約 → B1 → E0 発注 1（§7、統合担当の分岐）。

## 1. 語彙の形（単値と展開の欄を写す 1 つの形）

### 1.1 分野の包み

| 欄 | 形 | 出どころ |
|---|---|---|
| 包み（full） | `{ unit, contentRevision, items, delivery: "full", wire: VocabWire, cards }` | B0 の `DisplayWireDomain`（`p4-display-wire.types.ts:95`〜`:98`）に delivery を足した形 |
| 包み（要約） | `{ unit, contentRevision, items, delivery: "summary", reason: "snapshotBudget", originalBytes, budgetBytes, cards }` | 旧の要約（`view-projector.ts:761`〜`:765`）にカードを足した形（§4.2） |
| `VocabWire` | `{ items: VocabItem[], facts: VocabFact[] }`。facts は分野に 1 つの値（U-W の freshnessSuspectCount だけ） | §2 |
| 版 | `schemaVersion` を `p4-display-wire-v2` に上げる。`semanticRevision` は 12 分野の contentRevision の JSON 配列 | B0 の AC01（描画は自分の版でない snapshot を描かない） |

### 1.2 語彙の項目 `VocabItem`

| 欄 | 形 | 写すもの |
|---|---|---|
| `k` | 閉じたコード（§1.4 の 17 種） | view の配列の種類 |
| `op` | Operation | 記録の operation |
| `title` | `DisplayCutText` か null | view の `title` 欄（無い種類は null） |
| `time` | 字か null（40 byte を越えたら null） | source の reportDateTimeRaw |
| `serial` | 字か null（40 byte を越えたら null） | source の serialRaw |
| `marks` | `DisplayStateMark[]`（B0 の 4 語のまま） | unconfirmed → `unconfirmed`。B0 の marksOf と同じ |
| `unread` | 真偽 | `unreadableView` があるか（B0 の EEW のカードの `unread` と同じ） |
| `ref` | `{ part, id, rev }` か null | 詳細を開く参照（§5.2） |
| `facts` | `[label, value][]` | 単値と展開の欄（§1.3） |
| `lists` | `VocabList[]` | 上限のある列と辞書（§2） |
| `texts` | `[role, DisplayCutText][]` | headline・prevention などの文 |
| `special` | 専用部品か無し | 台風の frames、洪水の times と stations（§2.3） |

### 1.3 単値・展開・列の写し方

- 単値: `[label, value]`。label は view の欄の名（閉じた集合）、value は字・数・真偽・null。字の欄は `DisplayCutText`（§3.2 の上限で切る）。
- 展開: 形の決まった入れ子は欄ごとに分けて label を `親.子` にする（ReportRef は §1.2 の time・serial と `source.family`・`source.infoType`、`{code, name}` は `x.code`・`x.name`）。MaterialValue は `["sv", 種類, 下限, 上限, 生の字]`（種類は旧築の `protocol.ts` の exact・lowerBound・range・unknown・empty・missing。r7 §12.1 と同じ対応）。
- 一覧 `VocabList`: `{ role, label, sys, cols, facts, rows, unknown, omitted }`。rows は `[鍵, 名前 か null, ...値]` の配列で、値の欄の名は `cols` に 1 回だけ書く（値ごとに型の札を付けると U-Y の 384 区域で 65,536 を超えるため）。facts は一覧に 1 つの値（group の code・level など）。omitted は view が持つ省いた件数（例: ashfalls の omittedAreaCount）。
- 辞書（崩れた前提の 1 つ目）: 鍵の数に上限のある辞書は、鍵の昇順の一覧 1 つにする。U-W の codes と names は同じ鍵（Kind/Code）なので 1 つの一覧 `phenomena` の rows `[Kind/Code, Kind/Name, 区域の数]` に合わせる。Kind/Code は受理で 2 桁の数字に限る（`weather-current.ts:284`）ので鍵は 100 個まで、鍵の数で切らない。
- 構造の列（崩れた前提の 2 つ目）: group の列は group ごとに 1 つの一覧にし（role は view の欄の名、label は group の名前）、group の単値を一覧の facts に置く。読めない印の parts は §2.4。
- 副の ReportRef: `unconfirmed` は見出しの印 `unconfirmed`、U-V の `marineUnconfirmed` は事実の行 `marineUnconfirmed`（真偽）で、どちらも有無だけを載せる（B0 の marksOf と同じ）。U-V の `marineSource` は主の source と同じ規則で `marineSource.time`・`marineSource.serial`・`marineSource.family`・`marineSource.infoType` の事実の行にする（null なら欄ごと null）。
- 載せない欄（理由）: view の `semanticRevision`・`subjects`（B0 と同じ、§2.4）。記録の `subject`（ref の id の材料）。active だけの配列の `effective`（値が 1 つ。U-F と U-B は複数の値なので載せる）。`retainUntil`。source の inputId・origin・subject・controlDateTimeRaw（照合の材料。U-N・U-V の本文の rev は ref に作り済みで載る）。U-V の landEventId・marineEventId（型のコメントが取消の identity とする、`p3-volcano-unit.types.ts:74`〜`:75`）。`notice`・`marineNotice` と `expiryPending` は実の view に乗らない（事実の表 1.0b）。U-R の observedCompare は実の view で外す（ヘルツの返事 5、`flood-unit.ts:309`〜`:314`）。
- 並び: items は subject の昇順（受信ごとに二分探索で入れ外す、§6）。描く並びは C0・C1 の板。

### 1.4 項目の種類 `k`（17 種）

`weatherCurrent.area`・`weatherTimeseries.subject`・`nankai.current`・`nankai.information`・`volcano.alert`・`volcano.eruption`・`volcano.ashfall`・`volcano.bulletin`・`volcano.shortfall`・`landslide.office`・`flood.event`・`briefing.current`・`localBulletins.tornado`・`localBulletins.heat`・`localBulletins.transient`・`typhoon.analysis`・`typhoon.probability`。

- 描画は `k` と label・role で描き分け、分野（unit）の名前では分けない（R46）。

## 2. 行き先の表（表 1 の ✕ 26 欄と共通の 3 種）

列の意味: 行き先は「一覧」（snapshot の `lists`）・「専用」（`special`）・「詳細」（`/display-wire` の詳細の part）・「載せない」。上限は事実の表 1 とヘルツの返事 5 の値。新しく切る欄の値と落ちるものは §3.2。

### 2.1 U-W（最初の読み手は C0 発注 1 の気象の警報のカード）

| 欄 | 形と上限 | 行き先 | 新しく切るか | 画面から落ちるもの | 残りを読む所 |
|---|---|---|---|---|---|
| U-W areas（`p3-uw-canon.types.ts:24`） | `[層, Code][]`。区域 Code は数字だけで桁数・件数の定数なし（ヘルツの返事 5） | 一覧 role `areas`。層ごとに 1 つ（sys は層、rows は `[Code, null]`）。区域名は載せない（計画 §5.3 の即断候補 C=A、描画が引く） | 切らない（件数は分野の 65,536 と要約で閉じる） | 無し | — |
| U-W codes（:26） | 辞書 Kind/Code → 区域の数。鍵は 2 桁の数字（受理で検査） | names と合わせた一覧 role `phenomena` の 3 列目 | 切らない | 無し | — |
| U-W names（:28） | 辞書 Kind/Code → Kind/Name。値の字は unit の上限なし（text node の 16,384 字まで） | 一覧 `phenomena` の 2 列目（`DisplayCutText`） | 切る（§3.2 の 1,536 byte） | 1,536 byte を越えた Kind/Name の後ろ（実の Kind/Name は 10 字ほど） | U-W の詳細 part=areas の行の name（`p3-uw-canon.types.ts:52`〜`:53`） |
| U-W の単値（subject・operation・prefecture・id・revision・source・cellCount・restoredCellCount） | 単値と ReportRef | 見出しと事実の行。id・revision は ref（part=areas） | 生の字の欄だけ（§3.2） | 時刻・番号・InfoType が 40 byte を越えたときその欄が null | U-W の詳細 part=areas |
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
| U-R | inundation | group 2・text 256・全体 32,768 byte。区域の stationCode・cityCode・件数と name・prefecture・city・subCities は欄ごとの上限なし（ヘルツの返事 5、`flood.ts:353`〜`:373`） | group ごとの一覧 role `inundation`（label は kindName、facts に text、rows `[cityCode, name, stationCode, prefecture, city, subCities]`、omitted に omittedAreaCount） | 名前の 4 欄だけ切る（§3.2）。code と件数は切らない |
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
- 詳細だけに無いことの例外は字の残り（§3.2 の「残りを読む所」）。

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
| unreadableCards | UnreadableCardView の列。unit ごとに 8 枚 | 包みの `cards`（B0 の `DisplayWireCard`）。題と見出しを切るかは作者の分岐（P4-DV-D-CARD-TEXT-9、★A は B0 と同じ 96・384 byte）。原文は B0 の part=raw | 同じ部品（読めない報のカード）を 12 分野で 1 つにする。要約でも残す（§4.2） |
| unreadableView | `{ parts: {site, scope?, raw}[], headline, addition?, rawDropped?, partsCut? }`。parts 16 件・scope は JSON 長 128 byte・site は分野別の閉じた集合（ヘルツの返事 5） | 見出しの `unread`（真偽）と一覧 role `unreadable`（rows `[site, scope, raw]`、facts に headline・addition・rawDropped・partsCut） | 上限のある構造なので snapshot に載る（16 件 × 1 行 200 byte ほど）。U-W・U-F・U-N・U-V・U-M は項目を返す詳細が無いので、詳細へ置くと parts が読めなくなる（P4-DV-D-UNREADABLE-PARTS） |

## 3. 上限の表

### 3.1 ヘルツの返事 5 の訂正（事実の表 1 より優先）

| 訂正 | 中身 | 本契約での扱い |
|---|---|---|
| U-V ashfalls.eventId | 表 1 から落ちていた。上限 64 | 事実の行 `eventId`（切らない） |
| U-R observedCompare | 型にあっても実の view では外す（`flood-unit.ts:309`〜`:314`） | 載せない（§1.3） |
| U-B eventId | 上限 40（`briefing.ts:5`〜`:6`・`:68`） | 事実の行（切らない） |
| U-V shortfalls | id 64・最終時刻 40・serial は空か 10 桁以下 | 事実の行（切らない） |
| U-W 区域 Code・U-F areaCodes | 桁数・件数の定数なし（数字だけ） | 鍵なので切らない。分野の 65,536 と要約で閉じる |
| U-W・U-F の報鍵の官署名 | 長さの制限なし | 報鍵（subject）は載せない（ref の id の材料だけ） |
| source.reportDateTimeRaw の小数秒・serialRaw | 欄ごとの上限なし | §3.2 の生の字の欄（40 byte を越えたら null） |
| U-W の infoTypeRaw | 生の字のまま | §3.2 の生の字の欄 |
| U-W の affectedScope | unavailable の facts。上限なし | 載せない（§2.1） |
| U-R 浸水区域の stationCode・cityCode・件数 | 専用の上限なし、全体 32,768 byte | 鍵と件数は切らない、名前の 4 欄は §3.2 |
| U-W の府県・府県表示鍵 | 府県は 1〜2 桁、府県表示鍵は最大 16 字 | 事実の行 prefecture（切らない） |
| 有限の列 | M の tags 16 語 × 24、F の knownCodes 最大 11 種、unreadable parts 16 件・scope 128 byte、R の局別 riverCodes 最大 4 | §2 のとおり切らない |
| 入力 XML | 本文・要素の字（text node 16,384 字、`decode-material.ts:26`）・ノード数に上限 | 上限なしの字の欄の真の上限は 16,384 字（escape の最悪で 98,304 byte） |

### 3.2 新しく切る欄（P4-DW-D-STRING-SOURCE の上限の表に足す）

| 欄 | 上限（escape 後の byte） | 切ったときの印 | 画面から落ちるもの | 残りを読む所 |
|---|---|---|---|---|
| U-W の Kind/Name（phenomena の 2 列目） | 1,536 | `cut: true` | 1,536 byte から後 | U-W の詳細 part=areas の行の name |
| U-F の office（事実の行） | 256（U-F の索引の officeTruncated と同じ数、`weather-timeseries-unit.ts:613`） | `cut: true` | 256 byte から後 | 無し（U-F の索引も 256 で切る、今と同じ） |
| U-R の浸水区域の name・prefecture・city・subCities | 1,536 | `cut: true` | 1,536 byte から後 | 無し（残存。実の名前は 20 字ほど） |
| 生の字の欄（time・serial・`source.infoType`） | 40 | 欄を null（B0 の表 §1.3 の時刻の行と同じ） | その欄（時刻・番号・InfoType）が不明になる | 無し |
| 9 分野の読めない報のカードの題・見出し（作者の分岐 P4-DV-D-CARD-TEXT-9 の A） | 題 96・見出し 384（B0 の P4-DW-D-CARD-TEXT=A と同じ） | `cut: true` | 題の 33 字目ほど・見出しの 129 字目ほどから後（実の字が届く。B0 で作者に聞いた理由と同じ） | B0 の part=raw の原文 |

- unit が字数の上限を持つ欄（BOUNDS・LIMITS、UTF-16 の長さ）は新しく切らない。wire の上限はその字数 × 6 byte（escape の最悪）。
- 1,536 は `boundedString` と B0 の読めない報のカードの保存の上限と同じ単位・同じ数。実の電文で切れないことを corpus の受入（AC03）で示す。
- 鍵（区域 Code・Kind/Code・stationCode・cityCode）は切らない（切ると別の区域に読める）。
- 上限の表の置き場: B0 の上限の表 `WIRE_LIMITS` と切る関数 `cutText` を `display-wire.ts` から新しい file `display-vocab.ts` へ移し、本表の上限を同じ表に足す。`display-wire.ts` と `owner-runtime.ts` はどちらも `display-vocab.ts` から import する。表は 1 つのまま（P4-DW-D-STRING-SOURCE）。移す理由: `display-wire.ts` は domain の module（`domains/seismic`・`domains/tsunami`）を import し、owner-runtime がそれを読むと循環する。

## 4. 予算と 1 MiB

### 4.1 新しい経路の上界（script の出力から）

| 部分 | byte | 出どころ |
|---|---|---|
| 保護 3 分野（組 A短） | 180,826 | `node reconstruction/contracts/p4-display-wire-max.mjs` の newPath.protected |
| 通知 | 131,072 | 同 newPath.notices（64 件、spec §8.4） |
| 共通部 | 65,536 | 同 newPath.common（今の上界 49,443、`p3-recovery.json:952`） |
| 9 分野 | 9 × 65,536 ＝ 589,824 | 分野ごとに予算内の full か要約 |
| 合計 | 967,258 | 1 MiB の余り 81,318 |

- 数え方: script の newPath.sum（377,434）に 9 × 65,536 を足した（`node reconstruction/contracts/p4-display-wire-max.mjs` の出力を node で読んで足した。script は変えない）。
- B0 の表 r7 §12.4（余り 80,082）との差は、保護 3 分野の組 A短が 182,062 から 180,826 になった分（r11 の閉じた印の `ref` を外した分ほか）。
- 9 分野の要約は 3,882 byte 以下の包み（`p2-snapshot-sse.json:73`）に短いカード 8 枚（7,876 byte）を足しても 11,758 で、65,536 に入る。

### 4.2 9 分野の要約の規則（P4-DV-D-SUMMARY-RULE）

- 今の規則を新しい経路の 9 分野にそのまま当てる: 新しい経路の snapshot の全体が 1,048,576 を超えたときだけ、包みの byte が 65,536 を超えた 9 分野を要約にする（`view-projector.ts:904`〜`:906` と同じ式）。保護 3 分野は要約にしない（H37）。
- 上の上界により、要約にした後の全体は必ず 1 MiB に入る（要約にならない分野は 65,536 以下、要約は 11,758 以下）。新しい経路に全体の拒否は足さない。
- 分野の byte は語彙の形の byte で数える（view の形の byte ではない）。旧の経路で full の分野が新しい経路で要約になることはありうる（残存）。
- 要約でも `cards` を残す（旧の要約はカードを view ごと落とす）。読めない報のカード（H43）は 8 枚の短いカードで 7,876 byte に収まる。
- 無いと壊れる振る舞い: 規則が無いと、9 分野の合計が 671,142 を超えたとき新しい経路の snapshot が 1 MiB を超える。分野ごとの予算の配り方（土砂の 96,460 byte など）は B1 が決める。

## 5. 詳細の応答を語彙の行に変える（P4-DW-D-DETAIL-PAYLOAD=B が送った分）

### 5.1 B0 の §2.3 の part ごと

| part（B0 の表 §2.3） | 変えるか | 理由 |
|---|---|---|
| U-L・U-R・U-B・U-Y の索引の項目 `item` | 変える: 項目の中身を `VocabItem` にする（snapshot の項目と同じ関数で作る） | 9 分野の描画が項目を読む唯一の詳細。要約のときは索引だけが項目を運ぶ |
| 各分野の `index`（id・revision・operation・part の欄） | 変えない | 参照の形（B0 の表 §2.3） |
| U-N・U-V の本文 `text` と、U-N・U-V・U-M の索引の `text` の項目 | 変えない | 配送済みの口（P3-BULLETIN-TEXT-API-001）。U-M の `text` の項目は開ける要求の型が無い（`p3-bulletin-text-api.types.ts:6` は U-V・U-N だけ）。§8 |
| U-E の `areas`、U-T の `areas`・`stations`・`comment`、U-Q の `event` | 変えない | 保護 3 分野の専用部品（EEW・津波の大カード、地震の行）の材料（P4-DV-D-DETAIL-SCOPE） |
| 読めない報のカードの `raw` | 変えない | 原文の字 |
| U-W・U-F の既存の part | 変えない | 配送済みの口（P3-UW-CANON-001・P3-UF-PUBLIC-001）。形は既に行と項目 |

### 5.2 snapshot の項目の `ref`

| 種類 | part | id | rev |
|---|---|---|---|
| weatherCurrent.area | areas（U-W の既存の口） | 公開形の id | 公開形の revision |
| weatherTimeseries.subject | current（U-F の既存の口。lastKnown の part も同じ id と revision で開け、lastKnownPeriodCount が null でないときだけ開く） | 公開形の id | 公開形の revision |
| nankai.information・volcano.bulletin | text（本文の口） | view の生の subject | source の三つ組の JSON 配列の字 |
| ほかの 13 種 | — | — | `ref` は null（項目の全部が snapshot にあり、開く part が無い） |

### 5.3 開け直す型と変える配送済みの契約

| 開け直すもの | 所 | «» の行 | 変え方 |
|---|---|---|---|
| `p4-display-wire.types.ts` | `DisplayWireSnapshot`（:102〜:119）の current に 9 分野を足す、`DisplayWireVersion`（:101）を v2 に、`WireIndexEntry`（:134〜:138）の `item` を `VocabItem` に、語彙の型を足す | 0（どの契約も引かない） | 行の中と file の最後 |
| `display-wire.ts` | 9 分野の射影・要約の規則。`WIRE_LIMITS` と `cutText` を `display-vocab.ts` へ移して import する（§3.2） | 0 | 行の中と file の最後 |
| 新しい file `display-vocab.ts`（`reconstruction/src/view-projector/`） | view の要素 → `VocabItem` の純粋な関数 | — | 新しい file |
| `owner-runtime.ts` | `wireIndex` の `items`（:874）で項目を語彙に変えてからページに切る | :774 より後は 0 | :774 より後の行の中。import も :774 より後に置く |
| `composition-root.ts` | `wireInput`（:2497〜:2506）に 9 分野の view を足す | :2462 より後は 0 | :2462 より後の行の中 |
| 試験の期待 3 か所 | `test/display-wire/wire-client.ts:5`（版の字）、`test/display-wire/display-wire-root.test.ts:84`〜`:85`（current の鍵と包みの鍵。:80 の it の題も）、同じ file の :130〜:144 の it（U-F だけが変わる step で新しい経路は unchanged、:143）。:130 の it は U-F が新しい経路に載るので新しい経路も projected になる形に書き換える。経路ごとの公開の独立は :104 の it（旧の射影を unchanged に固定）が続けて見る | 0 | 行の中 |
| 試験の補助 2 か所 | `test/display-wire/display-wire-fixture.ts:82`（views に 9 分野の空の view を足す）、`display-wire-root.test.ts:135`（views に 9 分野の view を足す）。期待は変えない | 0 | 行の中 |
| P4-DISPLAY-WIRE-001 の条文 | AC01（9 分野は載せない）・AC08（payload は分野の DTO）・RES-03（377,434・縮退の規則を持たない）・D-DETAIL-PAYLOAD の reason・D-STRING-SOURCE の表の置き場（display-wire.ts → display-vocab.ts）・outOfScope の 9 分野の行 | p4-display-wire.json の行を引く契約は 0 | 配送の時に統合担当が行の中に本契約の ID の注記を書き、meta.sha256 を取り直す |
| 計画 `p4-order-plan.md` | §3.1 の Wave 2 の行（:192）と §3.2 の直列の行（:223）に本契約の名と位置 | 計画の行を引く契約あり（行を足さず行の中で直す） | 配送の時に統合担当 |

- `display-vocab.ts` が無いと壊れる振る舞い: owner（worker）の `wireIndex` と publisher（main）の `display-wire.ts` が同じ項目を別々に組み、snapshot と詳細で語彙が食い違う。owner-runtime は unit・domain の module を読むと循環するので（`owner-runtime.ts` の詳細の写しのコメント）、新しい file は contracts の型だけを import する。
- 変えないもの: `http-sse.ts`（`DetailPort` は `p4-display-wire.types.ts` の別名なので型の変更が届く）、`p3-execution-split.types.ts`（:73・:142 は別名）、`view-projector.ts` と旧 `/events`、P2-SNAPSHOT-SSE-001 の P2-A8-COST（新しい経路の直列化は公開ごとに 1 回のまま）。
- rev の式（その part が返す view の object の JSON の sha256）は変えない。項目の語彙は view の object の純粋な関数なので、object が同じなら語彙も同じ。

## 6. 受信経路の計算量（AGENTS.md）

| 手間 | 回数 | 上界 |
|---|---|---|
| 1. 項目を作り直す | その step の 9 分野の表示差分の subject ごとに 1 回（after から `VocabItem` を作り、その項目だけを直列化して byte を数える） | 変わった subject の数 |
| 2. 並びを直す | 変わった subject ごとに二分探索で入れ外す（B0 の insertSorted・removeSorted） | 変わった subject の数 × log(項目数) |
| 3. 分野の byte | 変わった項目の byte の差を足し引きする（全体を直列化しない） | 変わった subject の数 |
| 4. 要約の判定 | 12 分野の byte の和と 9 分野ごとの比べ | 定数 |
| 5. 公開の比べ | 分野の wire は変わらなければ前の object を使い、参照で比べる（B0 の sameSnapshot） | 定数 |
| 6. 最初の射影 | 9 分野の view を 1 回だけ全部読む（P2-A8-COST の最初の 1 回） | 起動と streamId の変わり目だけ |
| 7. view の固定の部分 | 表示差分に来ない欄（U-V の `shortfalls`、U-W の `freshnessSuspectCount`。`view-projector.ts:452` の fixedBytes が要素の外に数える部分）だけを、view の object が前の step と違うときに読み直す（`view-projector.ts:571` の条件と同じ）。要素の配列は読まない | 固定の部分の大きさ（U-V の shortfalls の件数） |

- 公開する配列の組み直し（変わった分野の items の写し）は分野の項目数に比例し、全件×全件にならない。
- 詳細の索引の語彙への変換は要求ごとにそのページの項目だけ（受信経路の外）。

## 7. 直列と依存（計画 §3.2）

| 衝突源 | 順 | 理由 |
|---|---|---|
| `display-wire.ts`・`p4-display-wire.types.ts` | B0 → 本契約 → B1 → E0 発注 1 → C2 → T0（P4-DV-D-ORDER） | B1 の仕事（落ちる順・予算の配り方）は新しい経路の 9 分野の要約の規則（§4.2）の上に載る。本契約の前の B1 には新しい経路で要約になる分野が無い。計画:192 は本契約と B1 を Wave 2 に並べ、計画:223 は本契約の位置を書いていない |
| `owner-runtime.ts` の `wireIndex` | B0 → 本契約 | 同じ関数の中 |
| P4-REMOVAL-LOSS-001（H17・H39） | 未決（Q-DV-REMOVAL-ORDER） | 同じ `display-wire.ts` の共通部を触る |
| C0 発注 1（Wave 3） | 本契約の後 | U-W の語彙を読む |

## 8. U-M の本文（計画 §2.3 の P3-UNIT-M-001・P3-BULLETIN-TEXT-API-001 の行）

- 決め: 本契約に入れない。小さい別の契約が既定（Q-DV-UM-BODY）。
- 理由: 本文を返すには (1) `local-bulletins.ts` で VXSE56・VXSE60・VZSE40 の本文を読む、(2) `local-bulletins-unit.ts` の記録（TransientCurrent に本文の欄が無い）と保存の形に本文を足す、(3) 本文の口の型 `p3-bulletin-text-api.types.ts` の unit に U-M を足す、が要る。本契約は local-bulletins の file も本文の口の型も触らない。`owner-runtime.ts` の本文の関数（bulletinText）は同じ file にあるが、本契約が触るのは :774 より後の `wireIndex` だけで、(1)(2) が無いと本文の関数を直しても返す字が無い。
- 今の状態: `wireIndex` の U-M の項目は `part: "text"` と生の subject・三つ組を載せるが、その要求を開ける型が無い（本文の口は U-V・U-N だけ）。描画は U-M の項目の本文を開かない（C1 の板まで）。

## 9. 分岐（作者 1 件・統合担当 5 件）

- 作者の分岐は 1 件（P4-DV-D-CARD-TEXT-9）。ほかが統合担当の理由: 本契約は今の view の欄を落とさず写し（§2）、ほかに新しく切るのは実の電文と corpus で切れない長さだけ（§3.2）。要約の規則の式は今と同じ（§4.2）。

| ID | 問い | ★推奨 | もう一方 |
|---|---|---|---|
| P4-DV-D-SUMMARY-RULE | 9 分野の要約の規則 | ★A 今の規則（全体が 1 MiB を超えたときだけ 65,536 を超えた 9 分野を要約）。要約でもカードを残す | B 分野ごとに 65,536 を超えたら常に要約（全体を見ない） |
| P4-DV-D-UNBOUNDED-TEXT | unit が上限を持たない字の欄 | ★A §3.2 の 1,536 byte（U-F の office は 256）で切って印 | B 切らない（1 つの欄が分野ごと要約にしうる） |
| P4-DV-D-UNREADABLE-PARTS | 読めない印の parts | ★A 見出しの真偽と snapshot の一覧（16 件） | B 真偽だけを snapshot に、parts は詳細（U-W・U-F・U-N・U-V・U-M では読めなくなる） |
| P4-DV-D-CARD-TEXT-9（作者） | 9 分野の読めない報のカードの題と見出しを、画面へ送るときに短くするか | ★A B0 と同じく題 96・見出し 384 byte で切って印、全文は原文で読む。初期画面から消えるのは題の 33 字目ほど・見出しの 129 字目ほどから後 | B 1,536 byte のまま（9 分野のカード 8 枚で 28,276 byte、分野の 65,536 の 4 割） |
| P4-DV-D-DETAIL-SCOPE | 語彙に変える詳細 | ★A U-L・U-R・U-B・U-Y の索引の項目だけ | B 保護 3 分野の areas・stations・event の行も語彙に |
| P4-DV-D-ORDER | display-wire.ts の直列の位置 | ★A B0 → 本契約 → B1 → E0 発注 1 | B B0 → B1 → 本契約 |

## 10. 未確認と証拠不足

- 証拠不足: 語彙の形の 9 分野の実の byte（corpus と災害の日の筋書き）は数えていない。旧の経路で full の分野が新しい経路で要約になる場合の数は B1。
- 証拠不足: U-Y の probability の 384 区域の 1 行の byte（cols の形で 1 行 60〜120 byte の見込み、384 行で 23,000〜46,000）は手で見積もった値で、script に通していない。
- 未確認: U-V・U-N の view を作る関数は開いていない（事実の表の「確かめられなかったこと」と同じ）。§2 の行き先は型から決めた。
- 未確認: 新しい経路の要約に残すカードを、新しい描画がどう描くか（C2 の板）。
