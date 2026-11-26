# P4-SHELL-TYPES-001 の設計の表 r0（新しい画面の型を 1 回で広げる）

起草 2026-11-26 12:4x〜12:5x、基点 main 7d89a98f（S0〔P4-DISPLAY-SHELL-001〕と P1〔P4-UW-AREA-KIND-001〕の配送の後）。2 回目（2026-11-26）に main 005f72fb の計画の改訂（S1 と E0 発注 1 の割り、本契約の順と依存）へ合わせ、«» を数え直した。
材料は作業ノート（repo の外）の下調べ 7 本（common-prereq・c0・e0・s1・c2・m0・r0、基点 8e071bb4）。下調べの記号は「C0 の C7」「E0 の T7」「S1 の B2」の形で引く。
下調べの引いた行を 7d89a98f で開き直した結果は作業ノートの段 0 の表（866 件、合う 811・行がずれた 31・字が変わった 24）。この表はずれた行を今の行で引く。
本表の分岐は全部「起草案」（統合担当が発注前点検で決める）。作者の裁定として引く字は repo の行にある物だけ。

## 0. 結論

- 型に入れるのは 6 つ: 行の対象の id（common-prereq の行 4）、行の中の字の束とカード単位の token（行 5）、カードの中のページの番号の持ち主と受け渡し（行 6）、時刻の字の関数（行 9）、地図の塗りの層（行 13）、区域名の file（行 1）。どれも画面の見え方を変えない（足すのは書ける形だけ）。
- 見た目（色・大きさ・字・出る/出ない・置き場）は決めない。カードの token の class と CSS は、それを使うカードの契約が tokens.ts と index.html に足す（計画 :227 のとおり S0 の所有の file を統合担当が合流）。カードの中のページの表示（「1/4」と点）も、カードがページごとの行の中に字と token で書く（frame は置き場を決めない）。
- 送る物: C2 の候補 5 つ（状態の札とお知らせの入れ物・幅の上限・押す相手・無受信の状態・timer の持ち主）、地域の値の届き方（行 22）、S1 発注 1 が読む側（frame が全ページの対象の id を出す形）、行 10・19・20。理由と行き先は §5。
- 作者の問いは 1 つ: 続報でカードの中のページを 1 ページ目へ戻すか（推奨は戻さない、計画 :814 の台帳 92 の行）。

## 1. 型ごとの「無いと壊れる受け手」

| # | 足す型・欄 | 無いと壊れる受け手（下調べの記号） | 出どころ |
|---|---|---|---|
| 1 | `ShellRow.id: string \| null` | S1 の L24（ページの先頭の対象の id を含むページを保つ、進捗を対象の id に付ける）と D-AC08（ページの集合の対象 id が有効な対象の集合と一致）を、区分ごとのカード（見本の場面 10・12 の右の列は全 12 ページ、DS-PAGE-12）で数えられない。C0 の G2、E0 の大カードの中のページ（DS-EEW-13） | spec:1506、spec:1845、DS:611、S0ty:14 |
| 2 | `ShellGroup`・`ShellPart`（`ShellRow.texts` の要素を字か束に） | E0 発注 1b（E0 の T7）の札の形（札の中の 2 段「5弱／以上」、220×140 の札の横の 2 段の字、右下の発表時刻）と C0 の C7（震度の札 72px の右に 3 行）。束が無いと、札の色（震度ごとの token、DS-INT-04）と 2 段の字を 1 つの箱にするのに、行の token に「震度×形」の組を作り、行の中の字の並びを span の順の CSS で決めることになる。§2.2 の割りの表 | DS:266、DS:273、DS:297、DS:355、S0ty:11 |
| 3 | `ShellCard.token`・`ShellDrawCard.token` | E0 発注 1b（E0 の T7）の警報の赤・予報の黄の 4px の枠（DS-CSS-08〜10）。今のカードの class は card と dim だけ（main.ts:142） | DS:388〜:390 |
| 4 | `ShellCard.inner`（ページごとの行）・`ShellFrameInput.innerPage`・`ShellFrame.innerPageCount` | E0 発注 1b（E0 の T8、大カードの「1/4」、DS-EEW-13）、C0 の G3（開いた今日の地震のページ、DS-OPEN-65 の案）、S1 発注 1（S1 の B4、カードの中のページも同じ送りに載せる）。今の slot のカードは forms[0] の全行を場所の矩形へ描き、あふれは切れる（frame.ts:130） | DS:343、DS:693、frame.ts:130 |
| 5 | `formatJstTime(value, "second" \| "minute")`（新しい `screen/time.ts`） | E0 発注 1b（E0 の T10、「23:15:10」、DS-TYPE-14）と C0（「05:07」、DS-QROW-04）。formatJst の字を切り出すと、読めない値の「時刻不明」が空の字になる。同じ照らし（暦に無い日付・時差の字）を C0 と E0 が別々に写すことになる | DS:163、DS:300、frame.ts:77 |
| 6 | `ShellAreaLayer`・`ShellMapPaint.layer` | M0 の Y1・E0 発注 2・T0・C0 発注 2。細分区域と津波予報区で同じ 3 桁が 60 個、震度の市区町村と気象の市町村等で同じ 7 桁が 1,707 個（うち名前の違う物 147。例 0123600 は渡島北斗市／北斗市）で、Code だけでは形が 1 つに決まらない | S0ty:66、spec:1437 |
| 7 | `screen/area-names.ts` の `areaName(table, code)` と生成の道具 | C0（市町村・府県・最も強い地域の名前）、E0（予測地域の名前、P4-DW-D-COMPOSITE で描画の側が引く）、T0、S1 の hover、R0（震度の市区町村）。wire は Code だけで、名前の表をブラウザへ届ける経路が無い（配るのは /display の html と /display/<名前>.js だけ、http-sse.ts:198・:323） | http-sse.ts:198、http-sse.ts:323 |

## 2. 型の変更（p4-display-shell.types.ts と新しい p4-shell-types.types.ts）

新しい型 3 つ（ShellAreaLayer・ShellGroup・ShellPart）は p4-shell-types.types.ts（起草で置いた）。p4-display-shell.types.ts は次のとおり行の中で書き換え、import の行を 1 つ足す（この file の行を引く «» はどの契約にも無い、`git grep` で確かめた）。

| 所 | 今 | 後 |
|---|---|---|
| S0ty:1 の次 | — | `import type { ShellAreaLayer, ShellPart } from "./p4-shell-types.types";` |
| S0ty:14 `ShellRow` | `{ height; token; texts: readonly ShellText[]; continuation }` | `{ id: string \| null; height; token; texts: readonly ShellPart[]; continuation }`（:12〜:13 のコメントに id の決まりを 1 文） |
| S0ty:24 `ShellCard` | `id; column; place; take; slot; mayHide;` | 末尾に `token: string \| null; inner: readonly (readonly ShellRow[])[] \| null;`（:19〜:22 のコメントに inner の決まりを 1 文） |
| S0ty:73 `ShellDrawCard` | `… under; rows;` | 末尾に `token: string \| null;` |
| S0ty:76 `ShellFrameInput` | `{ state; nowMs; page; shell }` | `page` の後に `innerPage: Readonly<Record<string, number>>` |
| S0ty:82 `ShellFrame` | `… pageCount; eew;` | `pageCount` の後に `innerPageCount: Readonly<Record<string, number>>` |
| S0ty:66 `ShellMapPaint` | `{ code; token }` | `{ layer: ShellAreaLayer; code; token }` |

### 2.1 行の対象の id（行 4、P4-ST-D-ROW-ID）

- 本文の行（forms の body・inner の各ページ・opened.rows の対象の行）は、その行が表す対象の id を持つ。head・continuation・飾りの行（ページの表示の行を含む）は null。
- 1 つの形の body の中、1 つの inner の全部のページの中、opened.rows の中で、null でない id は重ならない。同じ対象は snapshot と形をまたいで同じ字（例: 地震の行は区分と EventID、警報の行は府県・区分・種別の組・行の番号。字の作り方は書くカードの契約）。
- 対象の単位を「行」にしたのは、組（府県と種別の組）を単位にすると、組が 2 ページにまたがったとき「先頭の対象を含むページ」が 1 つに決まらないから。組や件は S1 が行の id から作れる。
- 読む側（frame が全ページの対象の id の組を出す形、S1 の §2 の 4）は入れない（§5 の S1 発注 1）。

### 2.2 行の中の字の束とカードの token（行 5、P4-ST-D-PART）

- 束は `{ token, texts: ShellText[] }` の 1 段。束の中に束は入れない。
- 字と束は `"texts" in part` で見分ける。ShellText の形は変えない（今の字の literal と試験の fixture をそのまま使える）。別案は ShellText と束の両方に kind を足す判別共用体（P4-ST-D-PART の D）で、今の字の literal（試験の fixture・smoke と、後のカードの全部の字）に kind が要る。
- 束の token・カードの token は、字と行の token と同じ tokens.ts の TOKEN_CLASS で class へ写し、表に無い token には class を付けない（S0 の AC09 (1)）。S0 は token の項を足さない（使うカードの契約が足す）。

受け手の形を 1 段で割れるか（DS の字と下調べの行から。class の名前・大きさは決めない）:

| 形 | 行（ShellRow） | 行の中の束・字 |
|---|---|---|
| EEW の小さいカード（DS-EEWS-06） | 1 行目〜5 行目を 1 つずつ | 1 行目: 字（札 A〜F）・字（「緊急地震速報（警報）」）・字（第 N 報）。2 行目: 束（最大予測震度の札: 字「5弱」・字「以上」）・字（地域）。3 行目: 字（「設定した地域」）・束（札）・字（地域）。4 行目: 字（「震源 ○○」）。5 行目: 字（「M6.6 深さ 40km」）。右下の発表時刻: 字（置き場は token の CSS） |
| EEW の大カード（DS-EEW、DS-CSS-08） | 見出しの行・最大予測震度の行・予測地域の行ごと | 最大予測震度の行: 束（220×140 の札: 字「5弱」・字「以上」）・束（札の横の 2 段: 字・字）。予測地域の行: 束（札）・字（地域）・字（到達予想） |
| 今日の地震の 1 行（DS-QROW-01） | 1 つ | 束（震度の札: 字）・束（1 行目: 字〔震源名〕）・束（2 行目: 字〔補足〕・字〔時刻〕）・束（3 行目: 字〔津波の札〕） |
| 警報のカードの府県の見出し＋最初の行（S0 の表 §4.5 の写し方） | 1 つ | 束（見出し: 字〔府県名〕）・束（最初の行: 字〔種別の組〕・字〔市町村〕） |
| カードの中のページの表示（§2.3） | ページの見出しの行の中 | 字（「2/4」）・束（点: 字〔空〕×ページの数、token は表の点の class） |

- 5 つとも束の中に束が要らない。2 段の受け手は無い（AGENTS.md の最小実装: 将来のための拡張点は作らない）。

### 2.3 カードの中のページ（行 6、P4-ST-D-INNER）

- 持ち主: 番号は scene（S1 発注 1、P4-SCENE-001。計画 :115 で S1 発注 1 は S0・本契約の後、Pi の段 1 を待たない）の状態が持ち、`ShellFrameInput.innerPage`（カードの id → 番号）で screenFrame へ渡す。S1 発注 1 までは main.ts が空の object（全部 1 ページ目）を渡す（列のページの番号を 0 のままにしている S0 と同じ形、main.ts:60）。
- 割り方（1 ページに何を入れるか）とページの表示（「1/4」と点、置き場）は書くカードの契約が決め、`inner` にページごとの行で返す。各ページの行はそのページに描く行の全部（frame は forms[0].head を足さない）。カードは各ページが何ページ中の何ページ目かを知っているので、表示はページの行の中に字と token で書ける（index.html の `.dot` は `.mark` の下に限っていない）。DS-EEW-13 と台帳 92 の「折り返して見せる」の当たり（E0 の F4）と DS-OPEN-65 は E0・C0 と作者の問い。
- 使う所: 緊急地震速報の場所に置いたカードと、開いたカード（列の外に描くカード）。列のカードのページは今のまま列の割り。inner が null のカードは今どおり（slot のカードは forms[0]、開いたカードは opened.rows）。
- frame: 番号のページを描く（ページの数以上なら最後のページ、負なら 1 ページ目。状態の番号は直さない、列と同じ、frame.ts:108）。描いたカードのうち inner のあるカードの id にページの数を `innerPageCount` で返す。mark は出さない（ShellDrawMark は列のページのまま）。
- 続報で 1 ページ目へ戻すかは作者の問い（Q-ST-INNER-RESET）。型はどちらの答えでも変わらない（番号を替えるのは S1 発注 1）。

### 2.4 時刻の字（行 9、P4-ST-D-TIME）

- `formatJstTime(value: number | string | null, unit: "second" | "minute"): string`。受ける値と照らしは formatJst と同じ（epoch ms か、Z・±hh:mm の時差を持つ ISO 8601。32,400,000 を足して getUTC* で読む）。second は「HH:mm:ss」、minute は「HH:mm」。読めない値は「時刻不明」。
- formatJst・clockText と一緒に新しい `screen/time.ts` に置き、frame.ts はそこから clockText を import する。カードの部品の file が frame.ts を import すると、frame.ts → cards.ts → 部品 → frame.ts の輪になり、試験が部品の file を先に import すると cards.ts の登録の const が未初期化の名前を読む。
- formatJst の字は変えない（S0 の T07 の期待のまま）。

### 2.5 地図の塗りの層（行 13、P4-ST-D-MAP-LAYER）

- `ShellAreaLayer` は G0 の manifest.json の layers の鍵 9 つ（pref・forecastLocalE・city・tsunamiArea・weatherPrefecture・weatherPrimary・weatherGroup・weatherCity・floodCity）。津波予報区が線であることは層で分かる（manifest の tsunamiArea の geometryType は polyline、manifest.json:919）ので、線の別の欄を足さない。
- wire の sys（"municipality" など）から層への対応は分野ごとに違う（U-W の気象の市町村等・U-L の土砂・U-V の火山、m0-prep の X11）ので、ここで決めない（M0 と各カードの契約）。
- S0 の screenFrame は map を空のまま返す（M0 が埋める）。

## 3. 区域名の file（行 1、P4-ST-D-NAMES）

### 3.1 形

- 生成の道具 `reconstruction/tools/gis/build-area-names.mjs`（新しい file）。G0 の known-codes.v1.json と area-codes.v1.json の名前の表 10 本（形の層 9 つ〔pref は area-codes の prefecture〕と津波予報区の結合表現 tsunamiAreaGroup）を読み、Code → 名前の表を層ごとに持つ `reconstruction/src/display/screen/area-names.ts` の字を返す関数 `buildAreaNames()` を export し、直に走らせたときは file に書く。型は `build-area-names.d.mts`（G0 の build-known-codes.d.mts と同じ形）。G0 の file と資材は変えない。
- 道具は manifest の layers の鍵と名前の表の組が合うことを確かめ、合わない・Code の重複・名前の空・形の違う行では止まる。
- area-names.ts は `areaName(table: ShellAreaLayer | "tsunamiAreaGroup", code: string): string | null` だけを末尾の `export { … }` で出す（P1-T04 は export function・export const を数える）。表に無いコードは null（名前を推して埋めない。どう出すかは読むカードの契約。VPWS50 の 15 コードを floodCity から補うかは C0）。
- 配る経路: screen の tsc が dist/screen/src/display/screen/area-names.js を作り、http-sse.ts:323 の名前の形 `[a-z0-9-]+` で /display/area-names.js として配られる。http-sse.ts と host.ts は変えない。

### 3.2 試し（作業ノート .tmp-st の写しの中、2026-11-26 12:39〜12:54）

| 項 | 結果 |
|---|---|
| 生成した area-names.ts | 148,943 byte（gzip level 6 で 48,253）、25 行、6,354 件（10 本の和） |
| 4 層だけ（pref・forecastLocalE・tsunamiArea・weatherCity） | 50,020 byte（gzip 16,876）。下調べ §2.1 の 50,101 は津波の結合表現を含み層の組が違う数 |
| tsc（screen の tsconfig、型の変更と frame.ts・main.ts・time.ts の試しの実装を当てた写し） | rc 0。型だけを当てた段では frame.ts:42・:133・:137、main.ts:77・:86・:162 の 6 か所が落ちた（§4 の書く所と同じ） |
| tsc（test/screen の frame・paginate・layers・client・static の試験と screen-fixture、§4 の fixture と import の直しを当てた写し） | rc 0。直さない段では frame.test.ts:38 と paginate.test.ts:17・:18・:31 の `.texts[0]?.text` が落ちる（ShellPart に text が無い） |
| vitest（同じ写しの 5 本、host.test.ts は dist の host が要るので外した） | 84 試験とも通る（期待は変えていない） |
| 出力 | dist の area-names.js 161,299 byte。名前は [a-z0-9-]+ に合う |
| 静的検査の語（AC09・AC11 の正規表現、DOM の語） | area-names.ts・time.ts とも 0 件。export function・export const は 0 件 |
| 試しの関数の値 | formatJstTime は 4 つの入力で "21:34:56"・"21:34"、読めない 6 つは「時刻不明」（TZ=America/New_York）。areaName は §7 の T01 の例の値どおり |
| VPWS50（15_18_01_250630）の市町村等の情報の Code | 1,718 個。weatherCity に無いのは 15 個で、15 個とも floodCity に名前がある（0920600 日光市、1410000 横浜市など） |

- 配るのは gzip しない JS で、cache-control は no-store（http-sse.ts:190）。画面を開くたびに読む。Pi の Chromium での読み込みの時間は測っていない（PI 発注 1 の段 1 で測る、§5）。

## 4. 書く所（実装の範囲）

| file | 書くこと | 行 |
|---|---|---|
| p4-display-shell.types.ts | §2 の表 | 行の中と import 1 行 |
| screen/time.ts（新しい） | formatJst・clockText を frame.ts から移し、formatJstTime を足す | — |
| screen/frame.ts | 時刻の関数を除き time.ts から clockText を import。sameRows に id と束の比べ、sameCard に token と inner の比べ（S0 の AC08 (12) の「全部の欄」を保つ）。draw に inner のページと token、frame に innerPageCount。export は screenFrame・shellSync | :10〜:12、:39〜:49、:60〜:88、:126〜:142、:145 |
| screen/main.ts | 束の描画（span の中に字の span、class は TOKEN_CLASS だけ、字は textContent）、描画の鍵 rowsKey に束の境目と token、カードの class に token、screenFrame の入力に innerPage（空の object） | :4、:60、:76〜:92、:142、:162 |
| screen/area-names.ts（新しい、生成物） | §3 | — |
| tools/gis/build-area-names.mjs・.d.mts（新しい） | §3 | — |
| test/screen/screen-fixture.ts | row に id: null、card の既定に token: null・inner: null、frameOf に token: null・innerPageCount: {}、行の先頭の字を読む textOf を足す（型のため。期待は変えない） | :6、:10〜:12、:15〜:17、:21 |
| test/screen/frame.test.ts | import の行（clockText・formatJst を time から、textOf）、input に innerPage: {}、:38 の `.texts[0]?.text` を textOf に（期待は変えない） | :5〜:6、:16、:38 |
| test/screen/paginate.test.ts | import に textOf、:17・:18・:31 の `.texts[0]?.text` を textOf に（期待は変えない） | :5、:17、:18、:31 |
| test/screen/smoke.mjs | T04（束と token の字の差し替え） | :24〜:37 |
| test/screen/shell-types.test.ts（新しい） | T01〜T03 | — |

- index.html・tokens.ts・layout.ts・client.ts・cards.ts は変えない。
- 受信経路の費用: 比べ（sameRows・sameCard）と描画の鍵は行と字と束の数に比例（今と同じ）。inner の比べはページの行の数に比例。screenFrame の inner の選びはカード 1 枚に定数。

## 5. 送る物と行き先

| 物 | 送る先 | 理由 |
|---|---|---|
| 状態の札とお知らせの入れ物（status の型を字の並びから広げる、列に属さない面の登録の口） | C2（P4-STATUS-NOTICES-001） | 形が C2 の F2（同時に出す数）・F3（上端の中央のほかに置き場が要るか）・G1（平常の定義、行 19）に依る。C2 は 45 秒の無受信で main.ts の購読と timer を足す（S0 の AC11 の改訂）ので、S0 の file を改める回はどちらにしても 1 回ある |
| 札の幅の上限 | C2 | C2 の F1（作者）。見た目 |
| 押す相手（札・ページの点・行の一部） | S1・C2 | S1 の A2・B6、C2 の F7。押下の事象の形は S1 の B5・B6 と一緒に決める。行 4 の id は相手の材料になる |
| 無受信の状態（45 秒） | C2 | 行 20（C2 の F13、作者）。client の状態に 1 つ足すのは C2 の S0 の改訂 |
| timer の持ち主 | S1・C2 | 型は要らない。main.ts の破棄の表（S0 の AC11 (1)）に載せる。AC11 (5) の「timer 1 本」は足す契約が改める |
| 地域の値の届き方（行 22） | R0 | wire に載る形なら型は変わらない（r0-prep §3.4）。別の GET・ブラウザの保存なら ShellCardSource か ShellFrameInput に欄が要る。どちらかは R0 の T2。先に引数を足すと使われない欄になる |
| frame が全ページの対象の id を出す形 | S1 発注 1（P4-SCENE-001） | S1 の B1（reducer を 1 本か）・B4（表示面の集合）・B5（描いたページと押下の照らし）で形が決まる。書く側（行 4 の id）は C0・E0・C2 が書き始める前に要るので本契約、読む側は S1 |
| 深さ・M の字（行 10） | C0・E0（作者の問い C0 の B5・E0 の F17） | 見た目。km への換算の純粋な関数を screen に 1 つ置くかは、U-Q の「以上」の欄（P2）と一緒に |
| 平常の定義（行 19） | C2 の G1（作者） | 見た目 |
| 警報のカードが画面にある値（E0 の E40）・カードに出ない件数（E0 の F1） | E0・R0 | 件数の置き場は作者の問い。中間の明るさの値は R0・PI |
| wire の sys から層への対応 | M0・各カードの契約 | 分野ごとに違う（§2.5） |
| area-names.js の Pi での読み込みの時間 | PI 発注 1 | 測っていない。148,943 byte が問題になれば層を絞る（生成の道具の表を減らす） |

## 6. 配送で統合担当が原文を改める項

1. P4-DISPLAY-SHELL-001 の JSON: AC01 (1) の file の列挙に time.ts・area-names.ts、AC01 (6) に「カードの中のページの番号も外から替える公開物を置かない（替えるのは S1）」、AC08 (2) の描く物にカードの token、AC08 (4) に列の外に描くカードの inner のページ、AC08 (12) の比べる欄に行の id・束・カードの token・inner、AC09 (1) に「束の字も text node、束とカードの token も固定表で class へ」、AC09 (3)(4) の置き場を time.ts、publicFunctions の formatJst・clockText を time.ts へ移し formatJstTime と areaName を足す。
2. 同じ契約の表: §2.4 の描く行（slot のカードと開いたカードの inner）、§2.5 の置き場と formatJstTime、§11 の :455「EEW の時刻の欄は E0 のカードが formatJst を使う」を formatJstTime に、§12 の 11（slot のカードの id は event ごとに 1 つ）に「inner の番号もこの id で引く」。
3. 計画（005f72fb）: 本契約の順（S0 の後・カードの契約の前、:192・:227）と、C0 発注 1（:124・:193・:866）・E0 発注 1b（:122・:193・:865）・S1 発注 1（:115・:193・:870）の依存、:227 の screen/ の行の字は計画に入った（改めない）。残るのは C2（:126・:193・:867）と M0 発注 1（:121・:193・:864）の依存に本契約を足すこと（C2 は ShellRow の id と束を書き、M0 発注 1 は ShellMapPaint.layer を書く）。
4. 上の 1〜3 が書き換える行を引く «»（005f72fb の木で数えた）: 計画の :121・:126・:193・:864・:867 を引く «» は 0 本。S0 の表 :455 を本契約の AC05 が 1 本。本契約の AC03 は計画 :227 を今の字（«bf70d2880e7bbf80»）で引き、:227 は本契約の配送では改めない。ほかの契約から S0 の JSON・表・型・screen の file の行を引く «» は 0 件（`git grep` で確かめた）。数は 005f72fb の木で、本契約の S0 の JSON・表の書き換え（1・2）で行が動けば、その後に数え直す。
5. 本契約の evidenceRefs のうち screen の file と S0 の型の行は実装で動く。配送で付け直す。

## 7. 試験の分け方

| 試験 | 中身 | 区分 |
|---|---|---|
| T01 | area-names.ts が buildAreaNames() の字と同じ。層をまたぐ同じ Code の名前が層ごとに違う（forecastLocalE と tsunamiArea の "100"、city と weatherCity の "0123600"）、tsunamiAreaGroup の "191"、表に無いコードは null。VPWS50（15_18_01_250630）の市町村等の Code 1,718 個のうち weatherCity が null を返すのは 15 個で、15 個とも floodCity に名前がある | 契約境界・corpus 履歴 |
| T02 | screenFrame の受入条件: 行の id だけ・束の token だけが違うカードで割りの使い回しが古い行を返さない、カードの token が ShellDrawCard へ、inner の番号のページ・最後のページへの丸め・innerPageCount・inner のカードに mark が付かない、inner の無い slot のカードは forms[0]（今どおり）、開いたカードの inner | 受入条件 |
| T03 | formatJstTime の second・minute、時差の字 3 種と epoch、読めない値、process.env.TZ を替えても同じ | 受入条件 |
| T04 | smoke.mjs（実 Chrome、統合担当が開発機で走らせる）: 束の中の字を `<img src=x onerror=…>`・`<script>` を含む字に替えても要素の数が変わらず実行される要素が 0、表に無い束の token・カードの token に class が付かない | 契約境界 |

- 既存の試験の期待は変えない。型のために変えるのは §4 の fixture と import と `.texts[0]?.text` の読みの行だけ（§3.2 の写しで 84 試験が通った）。S0 の T05（O11:6・7・8 の S0 分）・T06・T07（formatJst）はそのまま通る。inner の無い slot のカードが forms[0] を描くことは S0 の T06 には無く、本契約の T02 で見る。

## 8. 確かめた所（起草で開いた行）

- 型と screen: p4-display-shell.types.ts の全部、frame.ts・main.ts・layout.ts・client.ts・cards.ts・tokens.ts・index.html・tsconfig.json の全部、test/screen の screen-fixture.ts・static.test.ts の全部、frame.test.ts の :1〜:30、frame・paginate・layers・host・client の試験の toEqual・toMatchObject の行の全部と `.texts`・`.text` を読む行の全部、smoke.mjs の :1〜:60。
- S0 の契約: JSON の outOfScope・AC01〜AC16・publicFunctions・requiredCommands・testMapping（T02〜T12 の全文）、表の §2.4〜§2.6・§4.4・§11・§12。
- http-sse.ts の :155〜:165・:190〜:205・:315〜:333、display-wire.ts の :14〜:18、shared-runtime.ts の :214〜:224。
- G0: p4-gis-assets.types.ts の全部、manifest.json の layers の鍵と tsunamiArea・pref の項（:919 の geometryType）、known-codes.v1.json・area-codes.v1.json の鍵と件数、build-area-codes.mjs の :1〜:30、build-known-codes.mjs の :150〜:179、build-known-codes.d.mts、test/gis/known-codes.test.ts の import と生成の照らし、p4-gis-assets.json の allowedPaths と outOfScope。
- 計画 :115・:121〜:126・:192・:193・:194・:225〜:232・:814・:864〜:870・:939（005f72fb で開き直した）、AGENTS.md の :24・:26、p1-parser-boundary.test.ts の :110〜:115、tsconfig.json・tsconfig.test.json・vitest.config.ts。
- DS の :163・:239〜:241・:267〜:270・:297〜:300・:340〜:346・:355〜:363・:388〜:392・:610〜:612・:693、spec の :420〜:433・:1437・:1506・:1509・:1845。
- 他の契約から S0 の型・screen の file・S0 の JSON と表の行を引く «» の数（`git grep`、0 件）と、全契約の allowedPaths のうち screen/ と S0 の型を持つ物（S0 と本契約だけ）。
