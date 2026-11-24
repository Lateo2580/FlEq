# P4-DISPLAY-SHELL-001 の設計の表 r0（S0: 新しい画面の骨組み）

- 起草日: 2026-11-24（起草の子 r0）。base: draft/p4-s0 の `7ead43004a48a98292ae10eb6cb7ad7293c16085`。
- 範囲の真実源: 計画の S0 の行 reconstruction/contracts/p4-order-plan.md:114 «86d2b2b7211d64c4» と、表示設計 spec r4（`docs/specs/reconstruction-display-design.md`、以下 DS spec）の §4・§13〜§15。
- 計画・spec・DS spec は書き換えない。改める所は §12 に置き、統合担当が配送で当てる。
- 出どころの書き分け: 「作者の裁定」は作業ノート（repo 外）の S0 の準備の記録にある作者の言葉の「」の字で裏が取れる所だけに書く。spec が「統合担当の決め」「統合担当の読み」と書く所はそのまま写す。本起草で決めた所は「起草の読み」と書く。
- この回（r0 の 1 回目）は、ユーザーが押したときに層を入れ替える動きを書かない（§5.2）。

## 0. 結論

- 新しい画面は `reconstruction/src/display/screen/` の 1 つの directory に平らに置き、host が `/display` に出す（§6・§7）。`/` の chrome-eew はそのまま（切替は T0）。
- 描く値は純粋な関数 `screenFrame` が返し、DOM はその値だけを描く（§2.4）。X0 の Q-PWT3-ROWS-FN の関数はこれ。
- 配置は宣言値（§1）とカードが宣言した行の高さだけで計算し、DOM を測らない（§2.2・§4）。
- 3 つの層と覆い・暗くする・96px のずらしは `placeLayers` が返す（§3）。どの入力の組でも答えを返し、最上層の中の前後は入力で受ける。
- 決めていない所は契約の decisionBranches 4 件（MODULE-PATH・FONT・REPAGE-CAP・CLOCK-SIX）と unresolvedQuestions 4 件（SWAP・SECOND-GROUP・COLUMN-FLOW・STATUS-WORDS）。

## 1. 凍結する値（tokens.ts）

### 1.1 寸法と位置

| 項目 | 値 | 出どころ | 種類 |
|---|---|---|---|
| 画面 | 1920×1080 | docs/specs/reconstruction-display-design.md:170 «acb8d52f2074614c»、docs/specs/reconstruction-display-design.md:171 «69f213fe9a7a29fb» | spec の字 |
| 画面の縁 | 40 | docs/specs/reconstruction-display-design.md:182 «13e33171d634f654» | spec の字 |
| 左の列 | x 40・幅 540 | docs/specs/reconstruction-display-design.md:172 «2db40e9f8df8087a»（2026-11-23 の作者の裁定と spec が書く） | spec の字 |
| 右の列 | x 1340・幅 540（1920−40−540） | docs/specs/reconstruction-display-design.md:173 «0b95e7c272ff075b» | spec の字と算術 |
| 左の列の使える高さ | 903（上端 40） | docs/specs/reconstruction-display-design.md:614 «81463bdff3b8059f» | 統合担当の決め（14:5x） |
| 右の列の高さ | 1000（上端 40、下端 1040） | docs/specs/reconstruction-display-design.md:611 «1acc479a2b8b2998»（「列いっぱい（1000px）」）、docs/specs/reconstruction-display-design.md:332 «e3ec7013c0416cd9» | spec の字 |
| カードの間 | 17 | docs/specs/reconstruction-display-design.md:542 «064863dc9d475bd8» | 統合担当の決め |
| 時計 | 540×80、左 40・上 960（1080−40−80） | docs/specs/reconstruction-display-design.md:174 «6334b42e563cd7ee»、docs/specs/reconstruction-display-design.md:190 «7867ad904a981447»、docs/specs/reconstruction-display-design.md:368 «6a5d5cc9a5ec8043» | spec の字と算術 |
| 状態の札の置き場 | 横の中心 960・上端 40 | docs/specs/reconstruction-display-design.md:529 «725252d3d78bddaa» | 場所は作者の裁定 13:52（送信 13:51:15、「状態の印は上端中央としてください。」）、数は統合担当の読み。「上 40px」を上端と読むのは起草の読み |
| ずらす量 | 96 | docs/specs/reconstruction-display-design.md:638 «c3fa64086e7ecc0e» | 作者の裁定 21:59（「また、ずらす量は96pxにしてください。」） |
| 暗くする値 | 案 0.6（凍結しない） | docs/specs/reconstruction-display-design.md:690 «875d40a833e903b9» | 案。C0 で決める |
| 色 | DS-TOKEN-01〜37 の名前と値 | docs/specs/reconstruction-display-design.md:107 «e411e95be207a058» 〜 docs/specs/reconstruction-display-design.md:143 «e674c373891fc5d7» | spec の字 |

- 暗くする形は、明るさを下げてカードの面は不透明のままにする（CSS の不透明度で透かさない）。
  出どころは作者の 21:2x の案の字「影のように明るさを下げる」と、DS-MAP-22 の「面は不透明」（docs/specs/reconstruction-display-design.md:527 «8ca9084c0835f573»）。
  この形を選んだのは統合担当（作業ノートの 2026-11-24 20:3x、明るさを下げる形の図 sp-06b・17b・22b と比べた）。
- 見本の図 sp-* の「暗くする」は不透明度 0.6 で撮ってあり、後ろの地図が透ける。r0 が凍結する形（明るさを下げる）とは違う。DS-OPEN-62 の字「暗くする明るさ」は形が明るさの側。
- 1920×1080 でない画面は、全体を min（幅÷1920、高さ÷1080）倍に縮める（docs/specs/reconstruction-display-design.md:227 «6efaf7236fcfe135»、docs/specs/reconstruction-display-design.md:543 «b03570efb3238667»）。

### 1.2 最上層の緊急地震速報の場所（eewSlots）と時計（clockRect）

| 件数 | 場所（x, y, 幅, 高さ） | 出どころ |
|---|---|---|
| 1 | 右の列 (1340, 40, 540, 1000)、EewCard | docs/specs/reconstruction-display-design.md:195 «432da6df72399f46»、docs/specs/reconstruction-display-design.md:332 «e3ec7013c0416cd9»、docs/specs/reconstruction-display-design.md:634 «3a6a47e23ff0331b» |
| 2 | 右の列 (1340, 40, 540, 492)・(1340, 548, 540, 492)。間は 16 | docs/specs/reconstruction-display-design.md:351 «d40e59a09ff0a188»、docs/specs/reconstruction-display-design.md:659 «c97e2d927c3d6b99» |
| 3〜6 | 540×322 を上端 40・379・718。1〜3 番目は右の列（x 1340）、4〜6 番目は左の列（x 40）。間は 17 | docs/specs/reconstruction-display-design.md:196 «b906c023cbf567fd»、docs/specs/reconstruction-display-design.md:634 «3a6a47e23ff0331b»、docs/specs/reconstruction-display-design.md:351 «d40e59a09ff0a188» |

- DS-LAYER-03 の 40・379・718px は作者の 21:44 の「」の字には無く、DS-LAYOUT-05〜06 から来る（DS-LAYER-03 は「DS-LAYOUT-05〜11 のまま」と書く）。2 件の 548 は 40＋492＋16 の算術。
- 何番目の場所にどの札（A〜F）を置くか、空いた後と 7 件目（DS-LAYOUT-07〜11）は E0 が決める（docs/specs/reconstruction-display-design.md:197 «425c52f80687821c»）。S0 は場所の番号だけを受ける。
- clockRect: 0〜5 件は (40, 960, 540, 80)。6 件は (620, 960, 540, 80)（docs/specs/reconstruction-display-design.md:214 «3b3a0ad59e14fb18»。P4-DS-D-CLOCK-SIX の起草案 A）。DS-OPEN-48（docs/specs/reconstruction-display-design.md:676 «fcaa9edcb28b2f88»）は送り先が無い未決で、B（動かさない）は D-AC05 の「時計…を隠さない」（docs/specs/reconstruction-p0-contracts.md:1842 «bb8fc66481fec539»）に当たる。

## 2. 関数の入出力

型は `reconstruction/contracts/p4-display-shell.types.ts`。関数は純粋な file の末尾の `export { … }` で出す（P1-T04 が `export function`・`export const` を数える）。

### 2.1 tokens.ts

- `LAYOUT`: §1.1・§1.2 の値。`COLORS`: DS-TOKEN の名前→値。ShellText の token を class へ写す固定表もここ（表に無い token は class を付けない）。
- main.ts は起動の時に 1 回だけ、LAYOUT と COLORS を CSS の変数に入れる。index.html の style は変数だけを読み、px と色の字を直に書かない。

### 2.2 layout.ts

| 関数 | 入力 | 出力 | 決まり |
|---|---|---|---|
| `eewSlots(count)` | 1〜6 | ShellRect の配列（場所の番号の順） | §1.2 |
| `clockRect(count)` | 0〜6 | ShellRect | §1.2 |
| `placeLayers(input)` | ShellLayerInput（最上層の矩形の列〔前から奥の順〕と中間の層の矩形） | ShellLayerResult | §3 |
| `paginateColumn(column, cards)` | 列と、その列の ShellCard（slot が null） | ShellColumnPages | §4 |
| `pressShell(open, hit)` | 開いているかと押した所 | 開いているか | §5 |

### 2.3 client.ts（D02、docs/specs/reconstruction-p0-contracts.md:422 «5171404bc422a49d»）

- `acceptSnapshot(state, data)`: message の data の字を受けて新しい状態を返す。
  - JSON が読めない、外形が合わない: 状態を変えない。
  - schemaVersion が `"p4-display-wire-v3"`（reconstruction/contracts/p4-display-wire.types.ts:100 «97acae2a45f702ce»）でない: unsupported を立て、snapshot を描かない（docs/specs/reconstruction-p0-contracts.md:1391 «3f9c6bc381ec057b»）。
  - 同じ streamId で sequence が今以下: 捨てる。違う streamId: 置き換える（A9 の replaceDisplaySnapshot と同じ順）。
  - 外形として確かめるのは schemaVersion・streamId・sequence・semanticRevision と、current の 12 分野それぞれの unit と contentRevision。分野の中身はその分野を読むカードが確かめる（reconstruction/src/display/chrome-eew/pure.ts:387 «49c882312a743337»）。
  - changed: contentRevision が変わった分野。streamId が変われば 12 分野の全部。費用は 12 分野の数で、snapshot を直列化・走査しない。
- 詳細（D-AC12、docs/specs/reconstruction-p0-contracts.md:1849 «e09bf4fe43b4fa7f»）: 開いている詳細 1 件と取得中 1 件だけ。置き換えで、詳細の分野の contentRevision か streamId が変わったときだけ status を refetch にする。metadata だけ・ほかの分野だけの更新では保つ。`detailAnswered(state, response)` は応答を入れ、409 versionChanged なら refetch（P4-DC-AC04 (5)(a)、保留中に開いた詳細）。409 の body は WireDetailResponse の `{ kind: "error", reason: "versionChanged", revision }`（reconstruction/contracts/p2-weather-timeseries-unit.types.ts:179 «2568df56425bb4ea»、reconstruction/src/http-sse/http-sse.ts:33 «20d2663981904f12»）。9 分野の包みは要約の形でも unit と contentRevision を持つ（reconstruction/contracts/p4-display-wire.types.ts:248 «952066e41b148dc9»）ので、changed と refetch の決まりは 12 分野で同じ。詳細を開く UI と取得の要求の組み立ては、詳細を持つカードの契約（C0・C1）。
- 持つもの: 最新の snapshot 1 個・詳細 1 件・取得中 1 件（P4-DS-RET-01）。旧版・差分・通知の履歴を持たない。
- O11 の S0 分: O11:6 は画面の側の合流（animation frame ごとに最新 1 枚を描く）、O11:7 は metadata だけの更新で changed が空・開いているか・ページの番号・詳細が初期化されない、O11:8 は最新の snapshot の notices をそのまま持ち履歴を貯めない（docs/specs/reconstruction-p0-contracts.md:1787 «093b2c02be506dfb»）。SSE の側の O11:6 は B1（reconstruction/contracts/p4-display-capacity.json:487 «1428ba957654fca1»）。

### 2.4 frame.ts（Q-PWT3-ROWS-FN、reconstruction/contracts/p4-persona-walk-tools3.json:323 «210bdb0a83dd3b3c»）

- `screenFrame(input: ShellFrameInput): ShellFrame`。
  - input: client の状態、時刻（epoch ms）、列ごとのページの番号、開いているか、開いたカードを前にするか（openFront）。
  - カード: `cards.ts` の `CARD_SOURCES`（ShellCardSource の配列）を順に呼んで集める。S0 の登録は 0 本。各カードの契約が 1 行ずつ足す（reconstruction/contracts/p4-order-plan.md:227 «810399aebefa7fee»）。
  - 中間の層: 列ごとに `paginateColumn` の結果のうち、ページの番号のページ。番号がページの数以上なら最後のページ（自動の送りと番号の引継ぎは S1）。
  - 最上層: slot のあるカードを slot の小さい順に並べ、その順で `eewSlots`（枚数、6 まで）の場所に置く。7 枚目からは置かない（7 件目は E0、DS-LAYOUT-07）。開いているときは opened のあるカードの opened を、openFront が真なら最上層の先頭（前）、偽なら末尾（奥）に足す（DS-OPEN-46 は S0 では決めない、docs/specs/reconstruction-display-design.md:674 «35a2c44ae6f4d57f»）。
  - 層: 最上層と中間の層を `placeLayers` に渡し、cards（ShellDrawCard の列）と cover を返す。
  - 描く行: 中間の層は割りのページの行（head・continuation・本文）。slot のカードは forms[0] の head と本文を場所の矩形へ描く（大カードの中のページは E0）。開いたカードは opened.rows を opened.rect へ描く（ページは DS-OPEN-65、C0）。
  - 時計: `clockRect`（slot のあるカードの数）と `clockText(nowMs)`。
  - status: unsupported のとき 1 つ（字は Q-DS-STATUS-WORDS）。ほかは空（中身は C2）。
  - map・marks: 空の配列（M0 が埋める）。pageCount: 列ごとのページの数（S1 が読む）。
  - snapshot が無いか unsupported なら、カードを出さず時計と status だけ。
- DS-LAYER-16（開いている間は中間の層に今日の地震を描かない）は r0 で決めない。開いている間に中間の層へ今日の地震のカードを渡すかは、登録したカードの関数の側に残る（Q-DS-SECOND-GROUP）。
- main.ts は ShellFrame だけを描く。行の字と矩形を DOM の側で作らない。

### 2.5 frame.ts の時刻（P2-A9-AC10、reconstruction/contracts/p2-chrome-eew.json:502 «f17c6fe9984131d4»）

- `formatJst(value)`: epoch ms の数か、Z か ±hh:mm の時差を持つ ISO 8601 の字を受ける。epoch ms に 32,400,000 を足し、Date の getUTC* で読む。字は YYYY/MM/DD HH:mm:ss（0 埋め・24 時間制・時差の字なし）。null・時差の無い字・解釈できない値は「時刻不明」。
  - 時差の無い字を「時刻不明」にするのは起草の読み。時差の無い字を Date.parse に渡すと端末の時差で読まれ、P2-A9-AC10 の「端末のタイムゾーンに依存しない」に当たる。
- `clockText(epochMs)`: 同じ計算で「YYYY/MM/DD (曜) HH:mm」。曜は Sun Mon Tue Wed Thu Fri Sat（docs/specs/reconstruction-display-design.md:367 «0ba4a1081a227acb»、docs/specs/reconstruction-display-design.md:370 «4bad5bfae7e8b540»）。時計の時刻はブラウザの時計。
- 各分野の時刻の字の形（「02:50 更新」など）はカードの契約が formatJst の字から切り出すか、同じ計算を使う。

### 2.6 main.ts（DOM の入口）

- native EventSource で `/api/display/wire/events` を読む（reconstruction/src/http-sse/http-sse.ts:209 «4262a13fd737862f»）。受けた字を acceptSnapshot に渡し、animation frame ごとに最新の 1 枚から screenFrame を作って描く。
- changed が空の更新ではカードの DOM を作り直さない。カードの要素は id で持ち、行が変わったカードだけ字を差し替える。
- 字は text node だけ。token は tokens.ts の表で class へ写す（reconstruction/contracts/p2-chrome-eew.json:477 «886068cfc48e425c»）。
- 購読（EventSource、addEventListener、setTimeout・setInterval、requestAnimationFrame）は 1 つの破棄の表に登録して張る。張り直すときは先に表から外す。
- 時計は分の変わり目に 1 回だけ字を替える（timer 1 本）。画面の大きさは起動の時と resize の handler でだけ読む。
- 押した所（ShellHit）は ShellFrame の矩形から決め、pressShell に渡す。
- E04 の mark: 受けた時と、描いた後の最初の paint（§8）。

## 3. レイヤー（placeLayers）

### 3.1 決まり

| # | 決まり | 出どころ | 種類 |
|---|---|---|---|
| 1 | 層は 3 つ。最下層は地図、中間の層は列のカード、最上層は緊急地震速報のカードと押して開いたカード。列を問わない | docs/specs/reconstruction-display-design.md:632 «9cbaeef73e20db9b»、docs/specs/reconstruction-display-design.md:635 «191de465a690f18a» | 作者の案 21:2x、裁定 21:44、訂正 21:51（「上位レイヤーに配置するのはユーザー操作のカードと緊急性・速報性の高いカードが対象ですので、左列に限定されないこともあります。」） |
| 2 | 最上層は中間の層のカードを押し下げない。中間の層の矩形は最上層が無いときと同じ | docs/specs/reconstruction-display-design.md:633 «ddf642c59a7fbb9c» | 作者の裁定 21:44（「問1は覆う形で進め」） |
| 3 | 覆いの範囲 = 最上層の矩形 ＋ x と幅が同じで上下に並ぶ最上層のカードの間が 17px 以下のときのその間。中間の層はこの範囲の中を描かない（地図が見える） | docs/specs/reconstruction-display-design.md:659 «c97e2d927c3d6b99» | 作者の裁定 19:12（「問いについて「数える」ようにしてください。」）。「17px 以下」は 3 件の 17px と 2 件の 16px を 1 つに書いた起草の読み |
| 4 | 覆いの範囲と面が重なる中間の層のカードは暗くする | docs/specs/reconstruction-display-design.md:636 «6826f509c0c8bed0»、docs/specs/reconstruction-display-design.md:642 «e1bf9bd2a0c19116» | 作者の裁定 21:44（「暗くなったカードをクリックすると」）。一部だけ重なるカードも暗くするのは、DS-LAYER-11 の表が一部の重なり（場面 06 の今日の地震 10% など）を「覆われたカード」に数えることからの起草の読み |
| 5 | 全体が覆いの範囲に入る中間の層のカードは 96px ずらす。左の列のカードは右へ、右の列のカードは左へ | docs/specs/reconstruction-display-design.md:638 «c3fa64086e7ecc0e»、docs/specs/reconstruction-display-design.md:660 «55cb2d05aff8d8ae»、docs/specs/reconstruction-display-design.md:692 «199ef0e443a63d47» | 作者の裁定 21:44（「中間層のカード全体が最上層に覆われてしまったときは、中間層のカードをやや中央寄りにずらしてクリックできるようにしましょう。」）、量は 21:59、数え方は 19:12。向きを列で書いたのは統合担当の読み |
| 6 | 押して開いたカードに全体が覆われたカードも 96px ずらす | docs/specs/reconstruction-display-design.md:663 «a452930e56102224» | 作者の裁定 19:49（「ずらすようにしてください。」） |
| 7 | 最上層は入力の順（前から奥）のまま返す | docs/specs/reconstruction-display-design.md:674 «35a2c44ae6f4d57f» | 前後を決めない（DS-OPEN-46 は S1・E0） |
| 8 | 中間の層に緊急地震速報のカードを入れた入力の結果は凍結しない | docs/specs/reconstruction-display-design.md:691 «fc2a575d52284a33» | Q-DS-SWAP |
| 9 | 96px の押せる所の中身は凍結しない。r0 はずらしたカードをそのまま描く | docs/specs/reconstruction-display-design.md:695 «1a845b92b2682268» | 未決（C0・T0・E0） |

- 費用は最上層の数（7 以下: 緊急地震速報 6 と開いたカード 1）×中間の層の数。
- DS-LAYER-10（docs/specs/reconstruction-display-design.md:641 «407ac2a45d1459a6»）は覆う形の帰結の記録で、凍結する決まりではない（計画:114）。DS-LAYER-11 は覆いを測った場面の事実の表で、凍結しない。

### 3.2 場面の表（T02 の入力と期待）

中間の層の矩形は試験の入力で、決まりではない。右の列の警報のカード 40〜583 と津波のカード 315.5〜637.5 は DS-LAYER-15（docs/specs/reconstruction-display-design.md:661 «dfaea00ededfb554»）の見本の図の数、設定した地域のカード 40〜298.5 は作業ノートの見本の図 sf の数。今日の地震のカードの矩形は試験のために置いた。

| # | 最上層（前から奥） | 中間の層の入力 | 期待 |
|---|---|---|---|
| L1 | なし | 設定した地域 (40, 40, 540, 258.5)、右の警報 (1340, 40, 540, 543) | 暗くしない・ずらさない、cover は空 |
| L2 | 1 件 (1340, 40, 540, 1000) | 右の警報 (1340, 40, 540, 543) | 右の警報は暗くし、(1244, 40, 540, 543) へずらす（DS-LAYER-11 の場面 04） |
| L3 | 2 件 (1340, 40, 540, 492)・(1340, 548, 540, 492) | 右の警報 (1340, 40, 540, 543) | cover に間 (1340, 532, 540, 16) が入る。右の警報は暗くし、(1244, 40, …) へずらす（DS-LAYER-14 の 2 件） |
| L4 | 3 件 右の列 40・379・718 | 右の警報 (1340, 40, 540, 543) | cover に間 362〜379 と 701〜718 が入る。右の警報はずらす（場面 05、間を数えないと 96.9%） |
| L5 | 4 件（3 件 右、D (40, 40, 540, 322)） | 設定した地域 (40, 40, 540, 258.5)、今日の地震 (40, 315.5, 540, 300)、右の警報 | 設定した地域は暗くし (136, 40, …) へずらす。今日の地震は暗くするだけ（315.5〜362 が重なる）。右の警報はずらす（場面 06） |
| L6 | 津波＋4 件（D だけ左） | 設定した地域、津波 (40, 315.5, 540, 322) | 設定した地域はずらす。津波は暗くするだけ（場面 16） |
| L7 | 津波＋5 件（D・E 左） | 設定した地域、津波 (40, 315.5, 540, 322)、今日の地震 (40, 654.5, 540, 288.5) | cover に間 362〜379 が入る。設定した地域と津波はずらす。今日の地震は暗くするだけ（654.5〜701 が重なる、場面 17） |
| L8 | (40, 40, 540, 322)・(40, 400, 540, 322)（間 38） | (40, 300, 540, 150) | 間 362〜400 は cover に入らない。暗くするだけでずらさない（17px を越える間は数えない） |
| L9 | 開いたカード (40, 145, 540, 717) | 設定した地域 (40, 40, 540, 258.5)、津波 (40, 315.5, 540, 322) | 設定した地域は暗くするだけ、津波は (136, 315.5, …) へずらす（DS-LAYER-17、場面 24。開いたカードの矩形は DS-OPEN-65 の案の数を入力に使った） |
| L10 | 開いたカード、D (40, 40, 540, 322) の順と、その逆の順 | なし | top は入力の順のまま返る |

## 4. 列の割り（paginateColumn）

### 4.1 決まり

| # | 決まり | 出どころ | 種類 |
|---|---|---|---|
| 1 | カードの高さは種類ごとの固定値を持たず、中身の行の宣言した高さから計算する。配置は宣言した高さで組む | docs/specs/reconstruction-display-design.md:535 «3eab4d9a7d22e491»、docs/specs/reconstruction-display-design.md:503 «0b575fc39cfbbc04» | 作者の裁定 13:45（13:42 の「その2つの形でお願いします。」） |
| 2 | ページを送るカードは、いちばん高いページの高さで固定する。固定するのは同じカードの組が並ぶページの間で、並ぶカードの枚数が変わるページでは変わってよい | docs/specs/reconstruction-display-design.md:536 «84a2584a52ec00fe»、docs/specs/reconstruction-display-design.md:611 «1acc479a2b8b2998» | 作者の裁定 13:45（13:42）、2026-11-24 20:08（「変わってよい形で進めてください。」） |
| 3 | 組み方: 全ページを先に組み、カードごとに最大のページの高さを取り、その高さを当てて組み直す。割りが前の回と揃うまで組み直す | docs/specs/reconstruction-display-design.md:537 «56e0b67b91cfcd23»、docs/specs/reconstruction-display-design.md:615 «bfe39a9786975059» | 統合担当の実装の形・統合担当の決め（14:5x） |
| 4 | 入り切らないときは隠さず、その列のページを送る | docs/specs/reconstruction-display-design.md:539 «5c7631d951df848a» | 統合担当の案を作者が 13:52 に受けた（13:51 の「入りきらないときについて、案通りでお願いします。」） |
| 5 | 高さを先に取る順は 津波 → 設定した地域 → 今日の地震（take）。列の上下の順は 設定した地域 → 津波 → 今日の地震（place） | docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1»、docs/specs/reconstruction-display-design.md:593 «880aea340f7bd4bd»、docs/specs/reconstruction-display-design.md:594 «1568355604ac0289» | take は統合担当の読み（2026-11-24）。place は作者の裁定 15:56（「2. 設定地域カードを上にしましょう。」） |
| 6 | 左の列のカードの間は 17px。左の列の使える高さは 903px | docs/specs/reconstruction-display-design.md:542 «064863dc9d475bd8»、docs/specs/reconstruction-display-design.md:614 «81463bdff3b8059f» | 統合担当の決め |
| 7 | ページの番号は列ごとに 1 つ | docs/specs/reconstruction-display-design.md:609 «7e5ad94131634bba» | 統合担当の決め（16:1x） |
| 8 | 右の列のページの表示は、そのページで一番下のカードの最後の行。1 ページのときは出さない | docs/specs/reconstruction-display-design.md:610 «ca0991475f950aaa» | 統合担当の決め（16:1x）。行の高さは Q-DS-COLUMN-FLOW |
| 9 | 右の列で 1 枚だけのページはそのカードを列いっぱい（1000px）にする | docs/specs/reconstruction-display-design.md:611 «1acc479a2b8b2998» | 作者の裁定 20:08 |
| 10 | 行は字の 1 行の単位でページに分けてよい。続きのページは府県の見出しと種別の組を出し直す | docs/specs/reconstruction-display-design.md:612 «aea3fc7b49e541cc» | 統合担当の決め（14:5x）。ShellRow の continuation で受ける |
| 11 | 8 ページ以上は点を出さず字だけ | docs/specs/reconstruction-display-design.md:613 «363ac70cbc4a3838» | 統合担当の決め（14:5x）。ページの表示を描くのは S0 の DOM（表示の字の形は §4.4） |
| 12 | 今日の地震の形の順（ふつう 1 ページ → ふつうでページ送り → 圧縮 → 折りたたみ → 出さない）を、forms の順と maxPages・minBodyRows と mayHide で受ける | docs/specs/reconstruction-display-design.md:619 «0977920b24e986e2» | 作者の裁定 20:10 の問い 7（「判断事項についてはすべて推奨で大丈夫です。」）。受け方（forms）は起草の読み |
| 13 | 右の列でも「毎ページ出す要素」を受けられる形にする | docs/specs/reconstruction-display-design.md:679 «a2f2e42c58a2bc24» | 未決（中身は C0）。形の head で受ける |

- 形の選び: forms を順に試し、次の 3 つを満たす最初の形を使う。ページの数が maxPages 以下（null は上限なし）。最後を除く全部のページに本文の行が minBodyRows 以上入る。置かれる最初のページの残りの高さに head と本文の 1 行（minBodyRows が 0 の形は head だけ）が入る。どの形も満たさないとき、mayHide のカードは出さず、ほかのカードは最後の形を使う。
- mayHide のカードは、次のページへ回して形を満たすことをしない。DS-PAGE-07 が「13:52 の『1 行も入らないカードは次のページ』は、今日の地震については DS-QROW-18 の形の順に置き換わった」と書くため（docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1»）。ほかのカードは 1 行も入らないとき次のページへ回る。
- 1 行で列の高さを越える行は、その行だけのページに置く（越えた分はカードの中で切れる。行を列の高さ以下に宣言するのはカードの契約）。起草の読み。
- 計算量は 行の数×形の数×組み直しの回数 まで。DOM を読まない。結果は入力だけで決まる（台帳 37、reconstruction/contracts/p4-order-plan.md:808 «0554f4ef9e115079»）。

### 4.2 割りの組（T03 の入力と期待）

左の列（上端 40、使える高さ 903、下端 943）。行の高さは試験のために置いた数。

| # | 入力 | 期待 |
|---|---|---|
| P1 | カード 1 枚、形 1 つ（head 90、本文 100×3） | 1 ページ、(40, 40, 540, 390) |
| P2 | カード 1 枚、形 1 つ（head 90、本文 100×10） | 2 ページ（本文 8 行・2 行）。同じカードの組なので高さは 2 ページとも 890 |
| P3 | P2 の 9 行目に continuation（高さ 50 の 1 行） | 2 ページ目は head・continuation・9 行目・10 行目（340）。高さは 2 ページとも 890 |
| P4 | A（take 0・place 1、本文 700 の 1 行）と B（take 1・place 2、mayHide、形 F1〜F4）。B の形: F1 maxPages 1・minBodyRows 1・head 90・本文 100×2、F2 maxPages なし・minBodyRows 2・同じ行、F3 maxPages なし・minBodyRows 1・head 90・本文 50×1、F4 maxPages 1・minBodyRows 0・head 90・本文なし | A は (40, 40, 540, 700)。B に残る高さは 186（943−757）。F1・F2 は最初のページに head と本文 1 行（190）が入らず、F3 を使い (40, 757, 540, 140)。1 ページ |
| P5 | P4 の A を本文 786 にする（B に残る高さ 100） | F3（140）は入らず、F4 を使い (40, 843, 540, 90) |
| P6 | P4 の A を本文 806 にする（B に残る高さ 80） | どの形も入らず、mayHide の B は出さない。A だけの 1 ページ |
| P7 | 右の列（上端 40、高さ 1000）、カード 1 枚（head 90、本文 100×3） | 1 枚だけのページなので (1340, 40, 540, 1000) |

### 4.3 組み直しの上限（P4-DS-D-REPAGE-CAP の起草案 A）

- 1 列の組み直しは「列のカードの数＋1」回まで。各回は前の回の固定した高さを当てて組み、割りが前の回と同じになったら止める。上限で揃わなければ最後の回の割りを使い、passes に回数を出す。
- 上限の根拠: take で前のカードの高さだけが後ろのカードの割りを変えるなら、k 枚の列は k＋1 回で揃う（起草の読み、証明はしていない）。上限が無いと、揃わない入力で受信ごとの処理が止まらない。

### 4.4 r0 で決めない割りの細部（Q-DS-COLUMN-FLOW）

- place と take が違うときに、どのカードが先に次のページへ回るか。
- ページの少ないカードが、後ろのページで何を出すか（最後のページを出し続けるか、出さないか）。左右の列の間の進め方（見本の図はページの少ない列が最後のページのまま、作業ノート 2026-11-23 15:2x）は S1。
- 右の列のページの表示（#8）の行の高さを誰が宣言するか。ページの表示の字の形（「1/4」と点、DS-PAGE-08・14）の描き方。
- 発注前点検で、見本の図の割り（配置 sp の場面 10・12・17 など、作業ノートの sp-heights.json）と突き合わせた表をこの節に足す。

## 5. 押したとき（pressShell）

### 5.1 r0 で条文にする行

| 開いているか | 押した所（ShellHit） | 結果 | 出どころ |
|---|---|---|---|
| 開いていない | openable（暗くない今日の地震のカード） | 開く（全部の行が最上層に開く） | docs/specs/reconstruction-display-design.md:639 «c9a1a5a2e24078a9»。作者の裁定 21:44 の問い 2（「問2は推奨で進めていただきたい」） |
| 開いている | other（開いたカードの外の地図・時計・状態の札・最上層の緊急地震速報・暗くない中間の層のカード） | 閉じる | docs/specs/reconstruction-display-design.md:640 «ff1afed368948b52» の前半。作者の言葉 21:44「カード外部分をクリックしたときに展開を解除するようにしてください。」 |
| 開いている | shifted（ずれて出た所） | 閉じる。入れ替えない | docs/specs/reconstruction-display-design.md:663 «a452930e56102224»。作者の裁定 19:49 と見比べのページ版 10 の箇条 |
| 開いている | opened（開いたカードの中） | 変えない | 統合担当の決め（作業ノートの 2026-11-24 20:3x の表）。もう一度押して閉じる形は docs/specs/reconstruction-display-design.md:696 «72cbbbf6b60f51cc»（C0） |

- 開いている間も自動のページ送りを止めない（DS-LAYER-08 の「自動のページ送りは残す」。送るのは S1）。
- 津波の札を押して報を流し直す機能は作らない（docs/specs/reconstruction-display-design.md:658 «aa1e855dc2e8b752»、docs/specs/reconstruction-display-design.md:531 «da5a159a2642244d»。作者の裁定 13:52、13:51 の「流し直しを外してください。」）。
- r0 の実装は、開いていないときの dimmed・shifted と other では状態を変えない。開いているときの dimmed は閉じる。これは DS-LAYER-09 の後半（統合担当の読み、docs/specs/reconstruction-display-design.md:640 «ff1afed368948b52»）で、作業ノートでは「聞かずに進め、一覧で作者に見せる」と置いた所。計画:114 は 2 つ目の群に置くので、条文と試験は Q-DS-SECOND-GROUP の答えの後（2 回目）。

### 5.2 押して層を入れ替える動き（上がったカードの組、下がった緊急地震速報のカード、押して戻す）

作者の確認の後に起草する（Q-DS-SWAP。問い 1 の文 1〜3、DS-LAYER-06 の後半・DS-LAYER-15・DS-OPEN-63、暗い今日の地震を押したとき）。

## 6. host の配線（reconstruction/src/host/host.ts）

行を足さない。他の契約の «» が :23〜:684 の多くの行を引く（起草時に `git grep` で数えた。:12・:91・:98・:180・:628 を引く契約は 0）。
下の表の :12・:98・:180・:628 の «» は起草時の字で、実装が字を変えた後は合わなくなる。本契約の JSON はこの 4 行を引かない（表の file は checker の外）。

| 行 | 今の字（要旨） | 変え方 | 理由 |
|---|---|---|---|
| reconstruction/src/host/host.ts:12 «f4b10320134ad55c» | http-sse の import と DisplaySnapshot の型の import | 行の中に DisplayWireSnapshot の型の import を足す | (2)(3) の型 |
| :91（空の行） | — | `let latestWire: DisplayWireSnapshot \| null = null;` を置く | 表示の包みが読む変数は startRuntime より前に宣言する（reconstruction/src/host/host.ts:589 «7f172fccc2943a05»） |
| reconstruction/src/host/host.ts:98 «8462acde5031c2c6» | displayOptions の onSerialize と detail | 行の中に wireAssets（htmlPath `reconstruction/src/display/screen/index.html`、moduleDirectory `reconstruction/dist/screen/src/display/screen`）を足す | http-sse は wireAssets があるときだけ /display を出す（reconstruction/src/http-sse/http-sse.ts:151 «e01014c2d3332698»、reconstruction/src/http-sse/http-sse.ts:198 «2983faaca6303652»） |
| reconstruction/src/host/host.ts:180 «a56ac2644d37c97a» | root へ渡す display の object の後半 | 行の中に publishWire（latestWire を置き換え、`server?.publishWire(snapshot, urgent)`）と flushWire（`server?.flushWire()`）を足す | root は display の publishWire?・flushWire? を呼ぶ（reconstruction/src/runtime/composition-root.ts:143 «85f8cd15e6437efe»、reconstruction/src/runtime/composition-root.ts:992 «bc426f3e1ac45869»）。今の host は渡していない（reconstruction/src/host/host.ts:179 «03be71ad623bc519»） |
| reconstruction/src/host/host.ts:628 «a64363c499090257» | 開き直しで worker の値を渡す | 行の中に `if (latestWire != null) opened.publishWire(latestWire, true);` を足す | openWire はつないだ客に最後に公開した 1 通だけを書く（reconstruction/src/http-sse/http-sse.ts:355 «37aaf4e51c213ced»）。urgent を偽にすると最大 1 秒は何も届かない |

- 変えない行: reconstruction/src/host/host.ts:92 «e96e8b3876848ef5»、reconstruction/src/host/host.ts:95 «371bcde3a6b33955»、reconstruction/src/host/host.ts:96 «3eba4c9225f4762a»（`/` の chrome-eew、切替は T0）、reconstruction/src/host/host.ts:526 «e74d6a66c5815e63»、reconstruction/src/host/host.ts:536 «6a1da25a695ded94»、reconstruction/src/host/host.ts:629 «f08b37f228105594»。
- 停止の close の前の flush: root の停止の完了の project が `flushWire` を呼ぶ（reconstruction/src/runtime/composition-root.ts:992 «bc426f3e1ac45869»、P4-DC-AC04 (1)）。それは `root.shutdownRuntime`（:526）の中で起き、`closeDisplay`（:536）より前。host が flushWire を root に渡せば満たし、host は別の flush を足さない。shutdownRuntime が完了の段まで行かずに投げたときは保留（最大 1 秒分）が close で捨てられる。残存として書く。
- urgent は root が決めた値（`wire.urgent || stopped`）をそのまま server に渡す。
- 新しい画面の path は `/display`（reconstruction/src/http-sse/http-sse.ts:321 «4e7f7f00392b2039»）。E0 発注 2 の EEW の runner はここへ向ける（reconstruction/contracts/p4-order-plan.md:91 «a9368d6efdc9a4e0»）。

## 7. 置き場と build と配る経路

### 7.1 directory（P4-DS-D-MODULE-PATH の起草案 A）

`reconstruction/src/display/screen/`:

| file | 中身 | DOM |
|---|---|---|
| index.html | 画面の根の要素、style（CSS の変数を読む）、`<script type="module" src="/display/main.js">` | — |
| tsconfig.json | chrome-eew の tsconfig と同じ形（reconstruction/src/display/chrome-eew/tsconfig.json:8 «63b55f2ada487125»、reconstruction/src/display/chrome-eew/tsconfig.json:9 «3b6fd5df2e4fbb39»）、outDir は `../../../dist/screen` | lib に DOM |
| main.ts | EventSource・DOM・timer・performance.mark・押した所の判定 | 使う |
| tokens.ts | LAYOUT・COLORS・token の class の表 | 使わない |
| layout.ts | eewSlots・clockRect・placeLayers・paginateColumn・pressShell | 使わない |
| client.ts | acceptSnapshot・detailAnswered | 使わない |
| frame.ts | screenFrame・formatJst・clockText | 使わない |
| cards.ts | CARD_SOURCES（S0 は 0 本） | 使わない |

- 名前は [a-z0-9-]+ と拡張子だけ。server は `/display/<name>.js` を 1 つの moduleDirectory から 1 階層で配る（reconstruction/src/http-sse/http-sse.ts:323 «c9e50c28e896e7a6»）。import は同じ directory の `./<name>.js` と、契約の型の `import type` だけ。
- 部品ごとの directory（計画:227 の字）は、tsc が rootDir からの dir の形を dist に残すので 1 つの moduleDirectory に並ばない。§12 で計画:227 を「自分の部品の file」に改める。
- DOM の型を使うのは main.ts だけ。ほかの file は vitest（node）と root の tsconfig.test.json が読むので DOM の型を参照しない（reconstruction/contracts/p2-chrome-eew.json:633 «81593d9d26dc05df»）。

### 7.2 build と CI

下の表の «» は起草時の字で、実装の後は合わなくなる。本契約の JSON はこの 4 行を引かない。

| 所 | 変え方 |
|---|---|
| reconstruction/tsconfig.json:16 «ca7530796acf3763» | exclude に `"src/display/screen/**"` を行の中で足す（root の lib は ES2022 だけ） |
| .github/workflows/test.yml:86 «dd03eaeff6ad9708» | 行の中に `&& ./node_modules/.bin/tsc --project reconstruction/src/display/screen/tsconfig.json` を続ける |
| .github/workflows/test-windows.yml:49 «dd03eaeff6ad9708» | 同じ。:50 を P3-WINDOWS-CI-001 が引くので行を足さない |
| AGENTS.md:16 «822cf35f5bc51e4c» | reconstruction ゲートの命令の列に screen の tsc を行の中で足す（:24〜:28 を多くの契約が引く） |

- package.json の watch の命令は変えない。

### 7.3 書体（P4-DS-D-FONT、未決）

- Pi に BIZ UDPGothic が無い（統合担当の調べ）。今の server は書体の file を配れない（reconstruction/src/http-sse/http-sse.ts:198 «2983faaca6303652»）。
- 推奨 A: Pi の OS に入れて font-family の名前で指す。字の幅の表（docs/specs/reconstruction-display-design.md:560 «43627ca90f37ce4b»）は Pi に入れた file から作り、file の sha256 を表に書く。OS の package の有無と版は確かめていない。
- r0 の実装は font-family の名前だけを書き、書体の file を repo に入れない。

## 8. 試験の分け方

| どこで | 何を | testMapping |
|---|---|---|
| vitest（node） | 純粋な関数（tokens・eewSlots・clockRect・placeLayers・paginateColumn・pressShell・acceptSnapshot・detailAnswered・screenFrame・formatJst・clockText） | T01〜T07 |
| vitest（静的検査） | screen/** の字を読み、HTML を解釈させる API・layout を読む API・main.ts 以外の DOM の参照・file の名前 | T08 |
| vitest（host） | host を起こして /display・新しい経路・開き直し・停止の flush | T09 |
| 実 Chrome（smoke.mjs、統合担当が開発機で） | 字の差し替えで要素の数と実行 0、再接続とページの切替の後の listener・timer・EventSource の数、layout を読む API の呼びの数、E04 の 2 つの mark の差（記録だけ） | T10 |
| PM | E04 の正式の測定（暫定 p99≤250ms、docs/specs/reconstruction-p0-contracts.md:2055 «da2605b0ad504b31»）と Pi の Chromium の 72 時間（reconstruction/contracts/p4-order-plan.md:71 «a4785e44d38a663e»） | 本契約の外 |

- E04 の mark: 受けた時（message の handler の始め）と、描いた後の最初の paint（requestAnimationFrame の次の frame）に、sequence を名前に含む performance.mark を置く。計画は S0 と PM の分け方を書いていない（計画:114 と reconstruction/contracts/p4-order-plan.md:339 «284e39f8a0cb27c2»）。S0 の受入は測る所があることまで、と読んだ（起草の読み）。
- listener と timer の数は DOM の側なので vitest では数えない。破棄の表を 1 か所にし、smoke で数える。
- host の試験（T09）は reconstruction/test/briefing-unit/briefing-host.test.ts:140 «15ef9a67321ea8a9» の起こし方に倣う（試験の WebSocket の送り手、`displayPort: 0`、state と診断の dir は一時の dir）。host の戻りは displayPort・stop・openDisplay・closeDisplay を持つ（reconstruction/src/host/host.ts:664 «b40a72b18584486d»）。`reconstruction/test/cli/cli.test.ts` は host を vi.mock で置き換えるので使わない。XDG_CONFIG_HOME と保存の dir は一時の dir。

## 9. 足す仕組みと、無いと何が壊れるか

| 仕組み | 無いと壊れること |
|---|---|
| tokens.ts（LAYOUT・COLORS・token の表） | CSS と算術に px と色が 2 か所に書かれ、片方だけ変わると配置と描画がずれる。wire の字から class を組む形に戻る（P2-A9-AC08） |
| acceptSnapshot | 版の違う snapshot や古い sequence を描く（spec:1391）。metadata だけの更新でカードを作り直す（D-AC12） |
| 詳細の 1 件の状態と detailAnswered | 詳細を開いたまま内容が変わっても古い版を出し続けるか、metadata の更新ごとに取り直す（D-AC12） |
| eewSlots・clockRect | 緊急地震速報の場所と時計の位置の数が各カードの契約に散る |
| placeLayers | 覆い・暗くする・ずらすの判定が DOM の重なりで決まり、vitest で確かめられない |
| paginateColumn | 配置が DOM の計測に戻る（計画:114 の「無いと壊れる」、台帳 40） |
| forms・mayHide | 今日の地震の形の順（DS-QROW-18）を S0 の割りの外で決めることになり、C0 が S0 の file を変える |
| pressShell | 押したときの動きが DOM の handler の中にあり、試験できない |
| screenFrame | X0 の発注 3 が DOM を読むか依存を足す形になる（Q-PWT3-ROWS-FN の「無ければ」） |
| cards.ts の CARD_SOURCES | 各カードの契約が frame.ts を書き換え、直列になる（計画:227 の「1 行の登録だけ」） |
| 破棄の表（main.ts） | 再接続とページの切替で listener が増える（R52、reconstruction/contracts/p4-order-plan.md:71 «a4785e44d38a663e»） |
| performance.mark 2 つ | E04 を測る所が無く、PM が src を変える |
| formatJst・clockText | 各カードが日本時間の計算を別々に持つ（P2-A9-AC10） |
| host の latestWire | 表示の開き直しで、次の電文まで新しい画面が空 |

- 型の file（p4-display-shell.types.ts）の型はどれも上の関数の入出力で、ほかの契約（S1・E0・C0・M0・X0）が読む。実装が 1 つしかない interface・設定の層は足していない。

## 10. 凍結に入れた「統合担当の決め・読み」と、作者の裁定の区分

- 作者の裁定（「」の字で裏が取れる）: DS-LAYER-01・02・04・05・07（向きを除く）・08・09 の前半・12・13・14・17、DS-PAGE-02・03・12、DS-LAYOUT-25・DS-COL-04（15:56）、DS-LAYOUT-22 の場所（13:52）、DS-LAYOUT-24（13:52）、DS-QROW-18（20:10）。
- spec が作者の裁定と書くが、作業ノートの「」で本起草は確かめていないもの: DS-SIZE-03・04 の 540（2026-11-23）、DS-MAP-22 の層（13:03。「」は層の一文だけで、「面は不透明」は spec の地の文）。r0 はこれらを「spec の字」として引く。
- 統合担当の決め・読みとして凍結に入れた: DS-PAGE-04・07・09・10・11・13・14・15・16、DS-LAYOUT-22 の位置の数、DS-LAYER-03 の 40・379・718（DS-LAYOUT-05〜06 から）、ずらす向きを列で書いたこと（DS-OPEN-64）、暗くする形を明るさにしたこと（DS-OPEN-62 の形。値は凍結しない）。
- 起草の読み（統合担当の確定が要る）: 一部だけ重なるカードも暗くする（§3.1 の 4）、間は 17px 以下を数える（§3.1 の 3）、「上 40px」は上端、時差の無い字は「時刻不明」、1 行で列の高さを越える行の置き方、forms で DS-QROW-18 を受ける形、E04 の S0 と PM の分け方、decisionBranches の起草案 3 件（MODULE-PATH・REPAGE-CAP・CLOCK-SIX）。
- 凍結しない（2 つ目の群・後の契約）: DS-LAYER-06 の後半・09 の後半・10・11・15・16、DS-OPEN-46・62 の値・63・65・67・68。
- DS-MAP-24（警報以上が出ている間は右の列にカードがあり地図の見える幅は 760px）は S0 の条文に要らない（右の列の区分ごとのカードは C0 が登録する）ので引かない。

## 11. 計画・spec と当たった所

| 所 | 食い違い | r0 の扱い |
|---|---|---|
| 時計の位置 | spec:425（D05）の「右下時計」（docs/specs/reconstruction-p0-contracts.md:425 «8c167706c5a0a9ab»）、H03 の「地図の上の真ん中」（docs/specs/reconstruction-p0-contracts.md:3030 «c923951e64029e12»）と、計画・DS spec の「左下」 | 左下（reconstruction/contracts/p4-order-plan.md:787 «609c001782c081da»、DS-CLOCK-02）。spec の本文の改めは計画:386 の「表示設計 spec の凍結時」 |
| ヘッダ | spec:425 の「表示モード・接続状態だけのヘッダ」と H02 の「ヘッダの帯は作らない」（docs/specs/reconstruction-p0-contracts.md:3029 «a4fb170e00c3b22b»） | 帯を作らない（H02、reconstruction/contracts/p4-order-plan.md:786 «e22a0b111f2147a6»） |
| 検収端末 | spec:167（docs/specs/reconstruction-p0-contracts.md:167 «2cc109ef03d71ce4»）・:1688・:2961 の「開発機の Chrome」と、計画:383 の「S0 の凍結時に P4-PLAN-D-SCREEN の結果へ」（reconstruction/contracts/p4-order-plan.md:383 «ddfca608561e1297»） | smoke は開発機の Chrome。Pi の Chromium の資源は PM。spec の改めは §12 |
| P2-A9 の在り処 | 依頼の字は p2-snapshot-sse.json、定義は p2-chrome-eew.json | p2-chrome-eew.json の AC01・AC08・AC10 を引く（reconstruction/contracts/p2-chrome-eew.json:414 «3b73f7c36e965a88»） |
| P2-A9-AC01・AC10 の型 | 旧の DisplaySnapshot と旧の EEW の時刻の欄を名指す | 新しい経路の DisplayWireSnapshot に読み替える。EEW の時刻の欄は E0 のカードが formatJst を使う |
| O11:6 | 計画:72 の「6 は SSE と S0」と、B1 が SSE の側を持った | S0 は画面の側の合流だけ（AC15 (1)） |
| 部品の directory | 計画:227 の「各カードの契約は自分の部品の directory」と http-sse.ts:323 の 1 階層 | P4-DS-D-MODULE-PATH（起草案 A、§7.1） |
| host の配線の持ち主 | B1 の outOfScope「host.ts の配線（新しい経路を製品で流すのは E0 発注 2）」と、計画:229 の S0（2026-11-23） | S0 が持つ（reconstruction/contracts/p4-order-plan.md:229 «5087b78524621456»）。B1 の字は §12 で改める |
| D-AC18 | spec:1855 の「container／on／band、基準下辺 4px」（docs/specs/reconstruction-p0-contracts.md:1855 «28217bd0fdd3a039»）は DS spec の字に無い | S0 は DS-CSS-02 のカードの枠と見出しの行を持つ。「基準下辺 4px」「band」は DS の形に無いので条文にしない。統合担当が D-AC18 の字を DS の形に合わせるかを見る（§12） |
| D-AC02 | S0 の分の範囲を計画が書いていない | 空の災害カードを作らない・ページの外にも取消が効く・要約を無発令にしない、を骨組みの側で（AC08 (6)(7)）。状態の分は C2 |
| E04 | S0 と PM の分け方を計画が書いていない | S0 は測る所、PM が測る（§8） |

## 12. 配送で統合担当が原文を改める項

1. 計画:114 の S0 の行（reconstruction/contracts/p4-order-plan.md:114 «86d2b2b7211d64c4»）: 「1 つ目の群」に、凍結に入れた統合担当の決め・読み（§10）を足す。2 つ目の群の状態（Q-DS-SWAP・Q-DS-SECOND-GROUP）を書く。
2. 計画:227（reconstruction/contracts/p4-order-plan.md:227 «810399aebefa7fee»）: P4-DS-D-MODULE-PATH=A を確定したら、directory の名前を `screen` に、「自分の部品の directory」を「`reconstruction/src/display/screen/` の自分の部品の file と cards.ts の 1 行」に改める。
3. 計画:91（reconstruction/contracts/p4-order-plan.md:91 «a9368d6efdc9a4e0»）: 新しい画面の path が `/display` であることを書く。
4. 計画 §4.6 の「S0 の凍結時」の行: reconstruction/contracts/p4-order-plan.md:383 «ddfca608561e1297»（spec:167・:2959・:2961・:1688 を P4-PLAN-D-SCREEN の結果へ、Pi のブラウザの資源を予算に〔R52〕）、reconstruction/contracts/p4-order-plan.md:389 «5a5f5292467cc068»（spec:1845・:1847 に DS-LAYER-10 の例外）、reconstruction/contracts/p4-order-plan.md:394 «2717d3e984bf95f5»（spec:1597〜:1624 の列の割当を D-TSUNAMI-COLUMN=C の結果へ）。改め方は計画の字のとおり。B1 の Q-DC-SPEC-REVISION と同じく spec の本文を変えずに本契約を真実源とする形もある（統合担当が決める）。
5. 計画:937 の S0 の着手ゲート（reconstruction/contracts/p4-order-plan.md:937 «dc576f762ca61a46»）: P4-DS-D-MODULE-PATH・REPAGE-CAP・CLOCK-SIX の確定と Q-DS-COLUMN-FLOW・Q-DS-STATUS-WORDS の答えを足す。
6. 表示設計 spec: P4-DS-D-CLOCK-SIX=A を確定したら DS-OPEN-48 を閉じる。DS-OPEN-62 に「見本の図 sp-* は不透明度 0.6 で撮った、S0 は明るさを下げる形」を書く。DS-OPEN-64 は Q-DS-SECOND-GROUP の答えで閉じる。暗い今日の地震を押したとき（作業ノートの DS-OPEN-75）は spec に行が無いので、Q-DS-SWAP の答えに入らなければ DS-OPEN-75 として足す。
7. `reconstruction/contracts/p4-persona-walk-tools3.json` の Q-PWT3-ROWS-FN（reconstruction/contracts/p4-persona-walk-tools3.json:323 «210bdb0a83dd3b3c»）: 関数は frame.ts の screenFrame、DOM はその値だけを描く（P4-DS-AC08）と書く。
8. `reconstruction/contracts/p4-display-capacity.json` の outOfScope の「host.ts の配線（新しい経路を製品で流すのは E0 発注 2）」と Q-DC-DELIVERY の remaining の「host の配線…は E0 発注 2 か S0」: S0 に改める。
9. spec:1855（D-AC18）の字を DS-CSS-02 の形に合わせるか（§11）。

## 13. 確かめた所（起草時に開いた行）

- `reconstruction/src/host/host.ts`: :1〜:22（import）、:88〜:101、:176〜:182、:195〜:203、:511〜:538、:586〜:641、:664、:684〜:685。`reconstruction/test/briefing-unit/briefing-host.test.ts` の startP2Host の起こし方（:107・:127〜:141）。他の契約の «» が引く host.ts の行は `git grep` で数えた。
- `reconstruction/src/display/chrome-eew/`: main.ts の :1〜:12、index.html の :95〜:101、pure.ts の :385〜:418、tsconfig.json の全部。
- `reconstruction/src/http-sse/http-sse.ts` の :359〜:372 と、索引（作業ノートの s0-citations.md §3・§8）が file:行と anchor を書く行。`composition-root.ts` は :143 と :992（索引）。
- `reconstruction/tsconfig.json` の全部、`.github/workflows/test.yml` の :80〜:90、`test-windows.yml` の :44〜:52、`AGENTS.md` の :16。
- `reconstruction/contracts/p4-display-wire.types.ts` の :1〜:30・:90〜:100・:128〜:172・:244〜:250、`p2-weather-timeseries-unit.types.ts` の :172〜:182、`http-sse.ts` の :33・:209・:391、`p4-persona-walk-tools3.json` の :318〜:340、`p4-display-capacity.json` と表の file。
- 本表と契約が引く «» は、起草の道具で今の木の行の中身と 1 行だけの一致を確かめた。
