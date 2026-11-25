# P4-DISPLAY-SHELL-001 の設計の表 r11（S0: 新しい画面の骨組み）

- 起草日: 2026-11-24（起草の子 r0。1 回目は base `7ead43004a48a98292ae10eb6cb7ad7293c16085`、2 回目は 1 回目の commit `ded0cd79da3b6ecf33cd45f5589a796e05eb2d2c` の上で、作者の裁定 2026-11-24 20:46・20:54 を当てた。3 回目は同じ木の上で、統合担当の決め D1〜D4〔2026-11-24 21:2x〕を当てた。r1 は r0〔457f0cda〕へのヘルツ〔Astra high、read-only〕の独立レビュー〔NO-GO、指摘 13 件〕と統合担当の決め〔2026-11-24 21:4x、根 A〜F〕を当てた。対応は §14。r2 は r1〔80b07fd4〕へのヘルツの再確認〔NO-GO、残り 8・14〜17〕と統合担当の決め〔2026-11-24 22:0x、R1〜R5〕を当てた。対応は §15。r3 は r2〔915ca317〕へのヘルツの 3 巡目〔NO-GO、指摘 18〕と契約適合レビュー〔条件付き GO、P2 2・P3 11〕と、作者の裁定 2026-11-25 07:0x〔分岐 4 つを A〕を当てた。対応は §16。r4 は r3〔04ad088b〕へのヘルツの 4 巡目〔NO-GO、18 の直し残りと 19〕を当て、同じ決まりを書いた場所と、型の欄の作る所・読む所・試験を数え直した。対応は §17。r5 は r4〔7c743b51〕の同じ決まりの場所の突き合わせ〔食い違い 10 件・古い字 5 か所〕と統合担当の決め 2026-11-25 07:2x を当てた。対応は §18。r6 は r5〔2a785dcc〕へのヘルツの 5 巡目〔指摘 20〕と、作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS）と、spec の字の直しを当てた。対応は §19。r7 は発注前点検の Q-DS-COLUMN-FLOW の細部 a〜f と P7 を統合担当の決め 2026-11-25 19:07 で写した。対応は §20。r8 はヘルツの指摘 21・22 と spec §0 の DS 版 41。対応は §21。r9 はヘルツの指摘 23。対応は §22。r10 は実装〔826b2afb・9e240899・8b6f18d4〕とそのレビューで出た字。対応は §23。r11 は Q-DS-FORM-FIT への作者の裁定 2026-11-26 06:45。対応は §24）。
- 範囲の真実源: 計画の S0 の行 reconstruction/contracts/p4-order-plan.md:114 «c38868f9bf244f45» と、表示設計 spec r4（`docs/specs/reconstruction-display-design.md`、以下 DS spec）の §4・§13〜§15。
- 計画と spec は書き換えない。DS spec は 2 回目に限り、統合担当の指示で §15 の 11 行を行の中で改め、末尾に DS-LAYER-18・19 と DS-OPEN-75 の 3 行を足した（705 行）。3 回目は末尾に DS-LAYER-20・21 の 2 行を、r1 は DS-LAYER-22、r2 は DS-LAYER-23 の 1 行ずつを足した（709 行）。r3 は行を足さず、:7・:586・:611・:640・:660・:662・:676・:690・:706・:707・:709 の出どころの字を行の中で直した。ほかに改める所は §12 に置き、統合担当が配送で当てる。
- 出どころの書き分け: 「作者の裁定」は作業ノート（repo 外）の S0 の準備の記録にある作者の言葉の「」の字で裏が取れる所だけに書く。spec が「統合担当の決め」「統合担当の読み」と書く所はそのまま写す。本起草で決めた所は「起草の読み」と書き、統合担当が 2026-11-25 07:05 に今の字のまま確定した 8 件は「統合担当の決め（07:05 確定）」と書く（§10）。
- 1 回目は押して層を入れ替える動きを書かなかった。2 回目に作者の答え（20:46・20:54）で §5.2 を起草し、Q-DS-SWAP・Q-DS-SECOND-GROUP を閉じた。

## 0. 結論

- 新しい画面は `reconstruction/src/display/screen/` の 1 つの directory に平らに置き、host が `/display` に出す（§6・§7）。`/` の chrome-eew はそのまま（切替は T0）。
- 描く値は純粋な関数 `screenFrame` が返し、DOM はその値だけを描く（§2.4）。X0 の Q-PWT3-ROWS-FN の関数はこれ。
- 配置は宣言値（§1）とカードが宣言した行の高さだけで計算し、DOM を測らない（§2.2・§4）。
- 3 つの層と覆い・暗くする・96px のずらしは `placeLayers` が返す（§3）。どの入力の組でも答えを返し、最上層の中の前後は入力で受ける。
- 押して層を入れ替える動きは、状態を「開いているか」「上がったカードの id の組」「最後に見た緊急地震速報のカードの組」にし、下がった緊急地震速報のカードはそこから導く（§5.2）。カードの位置は上がっているかどうかに依らない（D1、DS-LAYER-20）。
- 決めていない所は無い（unresolvedQuestions は 0。実装の 3 巡目のレビューの後に開いた Q-DS-FORM-FIT は、作者の裁定 2026-11-26 06:45「判断についてはA(判断カードでのAダッシュ)で進めてください。」で閉じた）。発注の時に決めていない所は無かった（Q-DS-COLUMN-FLOW は統合担当 2026-11-25 19:30 に表 §4.5 で閉じた）。発注は baseOid の割り当ての後。Q-DS-STATUS-WORDS は作者の裁定 2026-11-25 19:09で閉じた。P4-DS-D-READINGS は作者の裁定 2026-11-25 18:50 で A。MODULE-PATH・REPAGE-CAP・CARD-BOUND は統合担当が A で確定、OPEN-WHILE-EEW・SECOND-GROUP・CLOCK-SIX・FONT は作者の裁定 2026-11-25 07:0x で A。

## 1. 凍結する値（tokens.ts）

### 1.1 寸法と位置

| 項目 | 値 | 出どころ | 種類 |
|---|---|---|---|
| 画面 | 1920×1080 | docs/specs/reconstruction-display-design.md:170 «acb8d52f2074614c»、docs/specs/reconstruction-display-design.md:171 «69f213fe9a7a29fb» | spec の字 |
| 画面の縁 | 40 | docs/specs/reconstruction-display-design.md:182 «13e33171d634f654» | spec の字 |
| 左の列 | x 40・幅 540 | docs/specs/reconstruction-display-design.md:172 «2db40e9f8df8087a»（2026-11-23 の作者の裁定と spec が書く） | spec の字 |
| 右の列 | x 1340・幅 540（1920−40−540） | docs/specs/reconstruction-display-design.md:173 «0b95e7c272ff075b» | spec の字と算術 |
| 左の列の使える高さ | 903（上端 40） | docs/specs/reconstruction-display-design.md:614 «81463bdff3b8059f» | 統合担当の決め（14:5x） |
| 右の列の高さ | 1000（上端 40、下端 1040） | docs/specs/reconstruction-display-design.md:611 «379eee6db9c243bb»（「列いっぱい（1000px）」）、docs/specs/reconstruction-display-design.md:332 «e3ec7013c0416cd9» | spec の字 |
| カードの間 | 17 | docs/specs/reconstruction-display-design.md:542 «064863dc9d475bd8» | 統合担当の決め |
| 時計 | 540×80、左 40・上 960（1080−40−80） | docs/specs/reconstruction-display-design.md:174 «6334b42e563cd7ee»、docs/specs/reconstruction-display-design.md:190 «7867ad904a981447»、docs/specs/reconstruction-display-design.md:368 «6a5d5cc9a5ec8043» | spec の字と算術 |
| 状態の札の置き場 | 横の中心 960・上端 40 | docs/specs/reconstruction-display-design.md:529 «725252d3d78bddaa» | 場所は作者の裁定 13:52（送信 13:51:15、「状態の印は上端中央としてください。」）、数は統合担当の読み。「上 40px」を上端と読むのは統合担当の決め（2026-11-25 07:05 に起草の読みを今の字のまま確定）で、作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS） |
| ページの表示の行（PAGE_MARK_ROW） | 37.5（字 30px × 行の高さ 1.25） | docs/specs/reconstruction-display-design.md:667 «0655eee5323b21b4»（fx-card-pg の字 30px）、docs/specs/reconstruction-display-design.md:381 «3dbd7da628040ff3»（行の高さ 1.25） | DS の bundle.css の値。統合担当の決め 2026-11-25 19:07（表 §4.4 の c） |
| ページの表示の行の上の間（PAGE_MARK_GAP） | 8（右の列。PAGE_MARK_ROW と合わせて 45.5 をそのカードの高さに数える） | 図の道具の実測 .tmp-s0/sp-rows.md の :7 | 統合担当の決め 2026-11-25 19:12。上の間が 8 でないカードを右の列に足す契約は、その契約でこの宣言値を改める |
| 間（space） | s3 12・s4 16・s5 24。行の左右の内側 s5、見出しの行の間 s4、行の区切りの下の内側 s3、状態の札の内側 s3 | docs/specs/reconstruction-display-design.md:179 «a0e59cb9a7dd5cc0»、docs/specs/reconstruction-display-design.md:180 «a329b0855a96aad6»、docs/specs/reconstruction-display-design.md:181 «a2347bb336166126» | 値は spec の字（DS-SIZE-10〜12）、使う所は tokens.ts のコメントの字（状態の札の内側は spec に字が無く、形は C2）。LAYOUT に足したのは統合担当の決め 2026-11-25 21:5x、r10-items.md の #18 |
| カード（card） | border 2・radius 4・text 30・headText 40・divider 2 | docs/specs/reconstruction-display-design.md:382 «657b231cb36d34af» | spec の字（DS-CSS-02）。headText・divider を LAYOUT に足したのは統合担当の決め 2026-11-25 21:5x、r10-items.md の #18 |
| 時計の字（clockText） | date 30・time 56・gap 18・padTop 6 | docs/specs/reconstruction-display-design.md:392 «aa60be29754c4014»、docs/specs/reconstruction-display-design.md:369 «76ade127260fe06b» | spec の字（DS-CSS-12・DS-CLOCK-03）。padTop を LAYOUT に足したのは統合担当の決め 2026-11-25 21:5x、r10-items.md の #18。時計の justify-content: center と line-height: 1 は DS の bundle.css :88〜:90（.fx-clock、撮った矩形が DS の見本と一致、2026-11-25 21:52） |
| ページの点（dots） | on 16・off 12・line 2・gap 12 | docs/specs/reconstruction-display-design.md:541 «44e052f31d6014ce» | spec の字（DS-PAGE-08） |
| ずらす量 | 96 | docs/specs/reconstruction-display-design.md:638 «d7d60f20f976c065» | 作者の裁定 21:59（「また、ずらす量は96pxにしてください。」） |
| 暗くする値 | 案 0.6（凍結しない） | docs/specs/reconstruction-display-design.md:690 «4c4aed70b2fd6a66» | 案。C0 で決める |
| 色 | DS-TOKEN-01〜37 の名前と値 | docs/specs/reconstruction-display-design.md:107 «e411e95be207a058» 〜 docs/specs/reconstruction-display-design.md:143 «e674c373891fc5d7» | spec の字 |

- 暗くする形は、明るさを下げてカードの面は不透明のままにする（CSS の不透明度で透かさない）。
  出どころは作者の 2026-11-23 21:2x の案の字「影のように明るさを下げる」と、DS-MAP-22 の「面は不透明」（docs/specs/reconstruction-display-design.md:527 «8ca9084c0835f573»）。
  この形を選んだのは統合担当（作業ノートの 2026-11-24 20:3x、明るさを下げる形の図 sp-06b・17b・22b と比べた）で、見比べのページ版 13 で作者に見せ、作者の裁定 2026-11-25 07:0x（「判断事項については、全て推奨で進めてください。」）（P4-DS-D-SECOND-GROUP=A）で形を凍結した。値は凍結しない（DS-OPEN-62、C0）。
- 見本の図 sp-* の「暗くする」は不透明度 0.6 で撮ってあり、後ろの地図が透ける。r0 が凍結する形（明るさを下げる）とは違う。DS-OPEN-62 の字「暗くする明るさ」は形が明るさの側。
- 1920×1080 でない画面は、全体を min（幅÷1920、高さ÷1080）倍に縮める（docs/specs/reconstruction-display-design.md:227 «6efaf7236fcfe135»、docs/specs/reconstruction-display-design.md:543 «b03570efb3238667»）。

### 1.2 最上層の緊急地震速報の場所（eewSlots）と時計（clockRect）

| 件数 | 場所（x, y, 幅, 高さ） | 出どころ |
|---|---|---|
| 1 | 右の列 (1340, 40, 540, 1000)、EewCard | docs/specs/reconstruction-display-design.md:195 «432da6df72399f46»、docs/specs/reconstruction-display-design.md:332 «e3ec7013c0416cd9»、docs/specs/reconstruction-display-design.md:634 «85a712019d005f04» |
| 2 | 右の列 (1340, 40, 540, 492)・(1340, 548, 540, 492)。間は 16 | docs/specs/reconstruction-display-design.md:351 «d40e59a09ff0a188»、docs/specs/reconstruction-display-design.md:659 «c97e2d927c3d6b99» |
| 3〜6 | 540×322 を上端 40・379・718。1〜3 番目は右の列（x 1340）、4〜6 番目は左の列（x 40）。間は 17 | docs/specs/reconstruction-display-design.md:196 «b906c023cbf567fd»、docs/specs/reconstruction-display-design.md:634 «85a712019d005f04»、docs/specs/reconstruction-display-design.md:351 «d40e59a09ff0a188» |

- DS-LAYER-03 の 40・379・718px は作者の 21:44 の「」の字には無く、DS-LAYOUT-05〜06 から来る（DS-LAYER-03 は「DS-LAYOUT-05〜11 のまま」と書く）。2 件の 548 は 40＋492＋16 の算術。
- 何番目の場所にどの札（A〜F）を置くか、空いた後と 7 件目（DS-LAYOUT-07〜11）は E0 が決める（docs/specs/reconstruction-display-design.md:197 «425c52f80687821c»）。S0 は場所の番号だけを受ける。
- clockRect: 入力はframe に置いた緊急地震速報のカードの枚数（frame.eew.length、最大 6）。0〜5 件は (40, 960, 540, 80)。6 件は (620, 960, 540, 80)（docs/specs/reconstruction-display-design.md:214 «3b3a0ad59e14fb18»。P4-DS-D-CLOCK-SIX=A、作者の裁定 2026-11-25 07:0x）。DS-OPEN-48（docs/specs/reconstruction-display-design.md:676 «c2c0fca4230d28ab»）は作者の裁定 2026-11-25 07:0x（P4-DS-D-CLOCK-SIX=A）で閉じた。B（動かさない）は D-AC05 の「時計…を隠さない」（docs/specs/reconstruction-p0-contracts.md:1842 «bb8fc66481fec539»）に当たる。

## 2. 関数の入出力

型は `reconstruction/contracts/p4-display-shell.types.ts`。関数は純粋な file の末尾の `export { … }` で出す（P1-T04 が `export function`・`export const` を数える）。

### 2.1 tokens.ts

- `LAYOUT`: §1.1・§1.2 の値。`COLORS`: DS-TOKEN の名前→値。ShellText の token と行（ShellRow）の token を class へ写す固定表もここ（表に無い token は class を付けない）。
- main.ts は起動の時に 1 回だけ、LAYOUT と COLORS を CSS の変数に入れる。index.html の style は変数だけを読み、px と色の字を直に書かない。

### 2.2 layout.ts

| 関数 | 入力 | 出力 | 決まり |
|---|---|---|---|
| `eewSlots(count)` | 1〜6 | ShellRect の配列（場所の番号の順） | §1.2 |
| `clockRect(count)` | 0〜6（frame に置いた緊急地震速報のカードの枚数（frame.eew.length、最大 6）） | ShellRect | §1.2 |
| `placeLayers(input)` | ShellLayerInput（緊急地震速報の場所・開いたカード・上がったカードの id・列のカードの割りの位置） | ShellLayerResult | §3 |
| `paginateColumn(column, cards)` | 列と、その列の ShellCard（slot が null） | ShellColumnPages | §4 |
| `reduceShell(state, event)` | ShellState と ShellEvent（press: その時の ShellFrame と押した点、sync: 緊急地震速報のカードの id の組と開けるカードがあるか） | ShellState | §5 |

### 2.3 client.ts（D02、docs/specs/reconstruction-p0-contracts.md:422 «5171404bc422a49d»）

- `acceptSnapshot(state, data)`: message の data の字を受けて新しい状態を返す。
  - JSON が読めない、外形が合わない: 状態を変えない。schemaVersion が字でない・無いときは外形が合わない側で、状態を変えない（数の schemaVersion は作り手から出ない〔wire の型は字の literal〕。統合担当の決め 2026-11-25 21:3x・21:5x、r10-items.md の #9）。
  - 字の schemaVersion が `"p4-display-wire-v3"`（reconstruction/contracts/p4-display-wire.types.ts:100 «97acae2a45f702ce»）でない: unsupported を立て、snapshot を描かない（docs/specs/reconstruction-p0-contracts.md:1391 «3f9c6bc381ec057b»）。
  - 同じ streamId で sequence が今以下: 捨てる。違う streamId: 置き換える（A9 の replaceDisplaySnapshot と同じ順）。
  - 外形として確かめるのは schemaVersion・streamId・sequence・semanticRevision と、current の 12 分野それぞれの unit と contentRevision。分野の中身はその分野を読むカードが確かめる（reconstruction/src/display/chrome-eew/pure.ts:387 «49c882312a743337»）。
  - changed: contentRevision が変わった分野。streamId が変われば 12 分野の全部。費用は 12 分野の数で、snapshot を直列化・走査しない。
- 詳細（D-AC12、docs/specs/reconstruction-p0-contracts.md:1849 «e09bf4fe43b4fa7f»）: 開いている詳細 1 件と取得中 1 件だけ。置き換えで、詳細の分野の contentRevision が変わったか、streamId が変わったか、詳細の分野の unit が新しい snapshot に無いときだけ status を refetch にする（unit が無いときは統合担当の決め 2026-11-25 21:3x、r10-items.md の #10）。metadata だけ・ほかの分野だけの更新では保つ。`detailRequested(state, request)` は詳細を loading にし、要求した時の streamId を持たせた新しい object にする。`detailAnswered(state, asked, answer)` は、asked が今の詳細の object と同じで、asked.streamId が今の snapshot の streamId と同じときだけ応答を採る。ほか（stream が変わった後に遅れて届いた旧い応答、置き換えた後の応答）は捨てる（ヘルツの指摘 11）。main.ts は HTTP の 200 と 409 の body だけをそのまま answer にし、ほか（400・429・503・504・responseTooLarge）と通信の失敗は { kind: "failed", reason } に変えて渡す（変えるのは main.ts だけで、detailAnswered は変換しない）。詳細の取得と、200・409 以外の応答を failed に変える所と、log（reason "detailFailed"）は、最初に詳細を開くカードの契約（C0・C1）が main.ts に足す（S0 に呼び手が無い。統合担当の決め 2026-11-25 21:3x、r10-items.md の #11）。detailAnswered は、採った answer の kind が ok なら status を ready にして response に入れ、kind が error で reason が versionChanged なら refetch、kind が failed（とそのほかの error）なら failed にする（409 は P4-DC-AC04 (5)(a)、保留中に開いた詳細）。理由は main.ts が log（reason "detailFailed"）に残す。この決まりはここと AC03 (5) に同じ字で書く。画面に出す字は「詳細を表示できません」（作者の裁定 2026-11-25 19:09、AC10 (3)）。409 の body は WireDetailResponse の `{ kind: "error", reason: "versionChanged", revision }`（reconstruction/contracts/p2-weather-timeseries-unit.types.ts:179 «2568df56425bb4ea»、reconstruction/src/http-sse/http-sse.ts:33 «20d2663981904f12»）。9 分野の包みは要約の形でも unit と contentRevision を持つ（reconstruction/contracts/p4-display-wire.types.ts:248 «952066e41b148dc9»）ので、changed と refetch の決まりは 12 分野で同じ。詳細を開く UI と取得の要求の組み立ては、詳細を持つカードの契約（C0・C1）。
- 持つもの: 最新の snapshot 1 個・詳細 1 件・取得中 1 件（P4-DS-RET-01）。旧版・差分・通知の履歴を持たない。
- O11 の S0 分: O11:6 は画面の側の合流（animation frame ごとに最新 1 枚を描く）、O11:7 は metadata だけの更新で changed が空・開いているか・ページの番号・詳細が初期化されない、O11:8 は最新の snapshot の notices をそのまま持ち履歴を貯めない（docs/specs/reconstruction-p0-contracts.md:1787 «093b2c02be506dfb»）。SSE の側の O11:6 は B1（reconstruction/contracts/p4-display-capacity.json:487 «1428ba957654fca1»）。

### 2.4 frame.ts（Q-PWT3-ROWS-FN、reconstruction/contracts/p4-persona-walk-tools3.json:323 «210bdb0a83dd3b3c»）

- `screenFrame(input: ShellFrameInput): ShellFrame`。
  - input: client の状態、時刻（epoch ms）、列ごとのページの番号、ShellState。
  - カード: `cards.ts` の `CARD_SOURCES`（ShellCardEntry〔source と max〕の配列）を順に呼んで集める。S0 の登録は 0 本。各カードの契約が 1 行ずつ足す（reconstruction/contracts/p4-order-plan.md:227 «d0b772e0ecc3ed64»）。
  - 中間の層: 列ごとに `paginateColumn` の結果のうち、ページの番号のページ。番号がページの数以上なら最後のページ（自動の送りと番号の引継ぎは S1）。
  - 最上層: slot のあるカードを slot の小さい順に並べ、その順で `eewSlots`（枚数、6 まで）の場所に置く。7 枚目からは置かない（7 件目は E0、DS-LAYOUT-07）。置いたカードの id を frame の eew に返す。開いているときは opened のあるカードの opened を open として placeLayers に渡す。上がったカードと下げる緊急地震速報のカードは placeLayers が決める（§3.1・§5.2）。
  - 層: 緊急地震速報の場所・開いたカード・raised（今のページの列のカードにある id だけ）・列のカードを `placeLayers` に渡し、cards（ShellDrawCard の列。最上層を前から奥、続けて中間の層を奥から手前）と cover を返す。開いたカードは frame の cards の先頭に置く。開いたカードは左の列にしか無く、開いている間は左の列に緊急地震速報のカードが無い（DS-LAYER-23）ので、最上層のほかのカードと面で重ならず、前後を決めない（DS-OPEN-46 は S1・E0）。
  - 集め方（screenFrame と shellSync が同じく使う。AC08 (3)(5)）: snapshot が無いか unsupported ならカード無し。ほかは CARD_SOURCES を順に呼び、各 entry の返したカードを前から max 枚だけ使う。
  - `shellSync(state, nowMs)`: 上の集め方で集めたカードから、slot のカードの id（slot の順、6 まで）と、opened のあるカードがあるかを sync の事象にして返す（frame の組み立てはしない）。
  - frame の shell には組んだ時の ShellState をそのまま入れる（R2）。
  - CARD_SOURCES は ShellCardEntry（source と max）の配列。max は source の作りで決まる数（例: 区分ごとのカードは区分の数）。source が max を越えて返したときは前から max 枚だけを使い、診断を 1 件残す（frame の diagnostics に reason "cardSourceOverMax"・登録の番号・返した枚数・max を入れ、main.ts が console へ出す。黙って落とさない）。列のカードの数の上限 K は、その列に置かれうる entry の max の和（P4-DS-D-CARD-BOUND=A、統合担当の決め 2026-11-24 22:0x）。
  - 割りは、paginateColumn の入力の全部（列と、その列の ShellCard の全部の欄: id・place・take・slot・mayHide・forms の head と body の各行の height・token・texts〔text と token〕・continuation・maxPages・minBodyRows・opened）が、その列で最後に割った時と同じなら前の結果を使う。純粋な関数の結果の使い回しで、frame.ts は列ごとに最後の 1 組（入力と結果）を覚える。比べは行の数に比例。同じ入力なら同じ結果なので、覚えても答えは変わらない（ヘルツの指摘 18）。metadata だけの snapshot、ページを送るだけの frame、時計だけの更新では入力が同じなので組み直さない（R3）。
  - ページの表示: 列のページに mark があれば、右の列は mark.cardId のカードの ShellDrawCard の mark に、at を "last"・dots を mark.dots にして入れる。左の列は、そのページの mayHide のカード（今日の地震）の mark に、at を "head"・dots を偽にして入れる（DS-QROW-21）。text は「ページの番号＋1/ページの数」の字（例「2/4」）。右の列の at "last" は、そのページで一番下のカードの最後の行として、カードの下端に置く形（表 §4.4 の c）。左の列の 2 ページ以上の各ページには mayHide のカードがある（AC05 (7)(d)、表 §4.4 の d）（R4）。
  - 描く行: 中間の層は割りのページの行（head・continuation・本文）。slot のカードは forms[0] の head と本文を場所の矩形へ描く（大カードの中のページは E0）。開いたカードは opened.rows を opened.rect へ描く（ページは DS-OPEN-65、C0）。
  - 時計: `clockRect`（frame に置いた緊急地震速報のカードの枚数（frame.eew.length、最大 6）。7 枚目からは置かないので数えない）と `clockText(nowMs)`。
  - status: 次の順に札を入れる。(1) unsupported のとき、版が合わないときの札「受け取った情報を表示できません」 (2) state.detail.status が failed のとき、詳細を読めなかったときの札「詳細を表示できません」。両方なら版が合わない方を先に置く。どちらも無ければ空（中身は C2）。failed の札は detailRequested で loading になるか、置き換えで refetch になれば次の frame で消える。字は作者の裁定 2026-11-25 19:09（ヘルツの指摘 19）。
  - map・marks: 空の配列（M0 が埋める）。pageCount: 列ごとのページの数（S1 が読む）。開いている間の左の列の pageCount は、開いたカードを外した割りのページの数。その送りの受け方は S1 が決める（統合担当の決め 2026-11-25 21:3x、r10-items.md の #16）。
  - snapshot が無いか unsupported なら、カードを出さず時計と status だけ。
- 開いている間は、中間の層に開いたカード（opened のあるカード）を渡さない（DS-LAYER-16、docs/specs/reconstruction-display-design.md:662 «f0b7e6009716cb45»。統合担当の決め・読み（作者の裁定 2026-11-25 07:0x（「判断事項については、全て推奨で進めてください。」）、P4-DS-D-SECOND-GROUP=A で凍結））。
- main.ts は ShellFrame だけを描く。行の字と矩形を DOM の側で作らない。

### 2.5 frame.ts の時刻（P2-A9-AC10、reconstruction/contracts/p2-chrome-eew.json:502 «f17c6fe9984131d4»）

- `formatJst(value)`: epoch ms の数か、Z か ±hh:mm の時差を持つ ISO 8601 の字を受ける。epoch ms に 32,400,000 を足し、Date の getUTC* で読む。字は YYYY/MM/DD HH:mm:ss（0 埋め・24 時間制・時差の字なし）。null・時差の無い字・暦に無い日付・24 時・解釈できない値は「時刻不明」（暦に無い日付と 24 時は統合担当の決め 2026-11-25 21:3x、r10-items.md の #13）。
  - 時差の無い字を「時刻不明」にするのは統合担当の決め（2026-11-25 07:05 に起草の読みを今の字のまま確定）。時差の無い字を Date.parse に渡すと端末の時差で読まれ、P2-A9-AC10 の「端末のタイムゾーンに依存しない」に当たる。
- `clockText(epochMs)`: 同じ計算で「YYYY/MM/DD (曜) HH:mm」。曜は Sun Mon Tue Wed Thu Fri Sat（docs/specs/reconstruction-display-design.md:367 «0ba4a1081a227acb»、docs/specs/reconstruction-display-design.md:370 «4bad5bfae7e8b540»）。時計の時刻はブラウザの時計。
- 各分野の時刻の字の形（「02:50 更新」など）はカードの契約が formatJst の字から切り出すか、同じ計算を使う。

### 2.6 main.ts（DOM の入口）

- native EventSource で `/api/display/wire/events` を読み、`addEventListener("snapshot", …)` で受ける（server は名前つきの `event: snapshot` で送る、reconstruction/src/http-sse/http-sse.ts:161 «4510bdbbc4904e3e»。既存の画面も同じ名前、reconstruction/src/display/chrome-eew/client.ts:17 «ead7de0311c4c83a»。`message` では受からない、ヘルツの指摘 5）（reconstruction/src/http-sse/http-sse.ts:209 «4262a13fd737862f»）。受けた字を acceptSnapshot に渡し、採るたびに reduceShell に shellSync の sync を当てる（合流しない。ヘルツの指摘 4）。描くのは animation frame ごとに最新の 1 枚だけで、描く前にも同じ nowMs で sync を当ててから screenFrame を作る。
- カードの DOM の比べ先は最後に描いた版（各分野の contentRevision と各カードの行）。最後に描いた版から変わらないカードの DOM を作り直さない。acceptSnapshot の changed は直前に採った版との差で、詳細の refetch にだけ使う（合流した間の変化を落とさないため、ヘルツの指摘 4）。
- 字は text node だけ。token は tokens.ts の表で class へ写す（reconstruction/contracts/p2-chrome-eew.json:477 «886068cfc48e425c»）。
- 購読（EventSource、addEventListener、setTimeout・setInterval、requestAnimationFrame）は 1 つの破棄の表に登録して張る。張り直すときは先に表から外す。
- 時計は分の変わり目に 1 回だけ字を替える（timer 1 本）。画面の大きさは起動の時と resize の handler でだけ読む。
- 押した点は画面の倍率（DS-SCREEN-02）で割って 1920×1080 の座標にし、そのとき描いている ShellFrame と一緒に reduceShell に press で渡す。相手は reduceShell が §5.1 の決まりで決める。
- E04 の mark: 受けた時と、描いた後の最初の paint（§8）。

## 3. レイヤー（placeLayers）

### 3.1 決まり

| # | 決まり | 出どころ | 種類 |
|---|---|---|---|
| 1 | 層は 3 つ。最下層は地図、中間の層は列のカードと下がった緊急地震速報のカード、最上層は緊急地震速報のカードと押して開いたカードと押して上がったカード。列を問わない | docs/specs/reconstruction-display-design.md:632 «9cbaeef73e20db9b»、docs/specs/reconstruction-display-design.md:635 «191de465a690f18a» | 作者の案 2026-11-23 21:2x、裁定 21:44、訂正 21:51（「上位レイヤーに配置するのはユーザー操作のカードと緊急性・速報性の高いカードが対象ですので、左列に限定されないこともあります。」） |
| 2 | 列のカードの割りの位置を押し下げない | docs/specs/reconstruction-display-design.md:633 «ddf642c59a7fbb9c» | 作者の裁定 21:44（「問1は覆う形で進め」） |
| 3 | 間: 宣言値で上下に隣り合う緊急地震速報の場所の間（3 件のとき 362〜379・701〜718 の 17px、2 件のとき 532〜548 の 16px）。宣言値に無い並びの間は数えない | docs/specs/reconstruction-display-design.md:659 «c97e2d927c3d6b99» | 作者の裁定 19:12（「問いについて「数える」ようにしてください。」）。16・17px は DS-LAYER-13 の字（17px 以下に広げない、根 C） |
| 4 | 列のカード（上がったカードを含む）は「覆い E」で決める。覆い E は緊急地震速報のカード全部（最上層のものも下がったものも）の場所の矩形とその間（3）と開いたカードの矩形。覆い E と面が重なれば暗くし（上がったカードは暗くしない）、全体が入れば左の列は右へ・右の列は左へ 96px ずらす。上げても下げても列のカードは横に動かない | docs/specs/reconstruction-display-design.md:636 «d4deb691f152f56f»、docs/specs/reconstruction-display-design.md:642 «e1bf9bd2a0c19116»、docs/specs/reconstruction-display-design.md:638 «d7d60f20f976c065»、docs/specs/reconstruction-display-design.md:660 «c0845684bcc64dc5»、docs/specs/reconstruction-display-design.md:692 «0bfc84c49a8e8ac5»、docs/specs/reconstruction-display-design.md:663 «3f8ce75d003426b5»、docs/specs/reconstruction-display-design.md:706 «08990d19480f4bdc» | 作者の裁定 21:44（「暗くなったカードをクリックすると」「中間層のカード全体が最上層に覆われてしまったときは、中間層のカードをやや中央寄りにずらしてクリックできるようにしましょう。」）、量 21:59、間を数える 19:12、開いたカード 19:49。向きを列で書いたことは統合担当の決め（表 §10）。覆い E を緊急地震速報のカード全部で取ること（D1 は統合担当の決め 2026-11-24 21:2x で、作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS））。一部だけ重なるカードも暗くするのは統合担当の決め（2026-11-25 07:05 に起草の読みを今の字のまま確定）。根拠は DS-LAYER-11 の表と、2026-11-23 21:44 の裁定の時の見比べのページ版 6 の問い 1 の箇条「覆う形では、少しでも重なったカードを暗くした。津波のカードは 14% しか覆われていないのに、全体が暗くなり見出しも隠れる。5 件では 95% が覆われる。」（統合担当の字、作業ノート）。作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS） |
| 5 | 上がったカードは raised の id で列のカードにあり、緊急地震速報の場所に面で重なるもの。4 の位置のまま最上層に置く（DS-LAYER-18 は 4 の帰結）。重ならない id は上がっていない扱い（D2） | docs/specs/reconstruction-display-design.md:637 «607da88cacaf0a69»、docs/specs/reconstruction-display-design.md:703 «a9201cfba7958180»、docs/specs/reconstruction-display-design.md:706 «08990d19480f4bdc» | 作者の裁定 21:44・20:46。D2 は統合担当の決め（表 §10） |
| 6 | 緊急地震速報の場所のうち上がったカードの矩形と面で重なるものは、何枚でも全部中間の層へ下げて暗くする。under は重なる上がったカードの id | docs/specs/reconstruction-display-design.md:661 «17c95a272fa4b451»、docs/specs/reconstruction-display-design.md:637 «607da88cacaf0a69» | 文 1（作者が 20:54 に受けた） |
| 7 | 下がった緊急地震速報のカードは、上がったカードの矩形の和に全体が入れば中央寄りへ 96px ずらす（列のカードと同じく、左の列は右へ、右の列は左へ。列は場所の列）。最上層の緊急地震速報のカードはずらさず、暗くしない（開いたカードとも上がったカードとも重ならない） | docs/specs/reconstruction-display-design.md:704 «7e3a9c21b1209f8f»、docs/specs/reconstruction-display-design.md:709 «4458c7a23a81d028» | 文 4（作者が 20:54 に受けた）、DS-LAYER-23（統合担当の決め 2026-11-24 22:0x。DS-LAYER-22 の 1 文目の「開いたカード」の所を改めた） |
| 8 | 描く順: 最上層は 開いたカード（frame の先頭）・緊急地震速報のカード・上がったカード。これらは面で重ならないので前後は描きに効かない。中間の層は奥から 列のカード → 下がった緊急地震速報のカード | docs/specs/reconstruction-display-design.md:706 «08990d19480f4bdc»、docs/specs/reconstruction-display-design.md:709 «4458c7a23a81d028» | 下がったカードが手前（D1）は統合担当の決め 2026-11-24 21:2x で、作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS）。開いたカードがほかと重ならないのは DS-LAYER-23 |
| 9 | cover（中間の層を描かない範囲）は、最上層のカードの矩形と、上下に隣り合う最上層の緊急地震速報の場所の間（3）。下がったカードの間は入らない | docs/specs/reconstruction-display-design.md:659 «c97e2d927c3d6b99» | 19:12 の字「最上層のカードが縦に続く範囲」 |
| 10 | 96px の押せる所の中身は凍結しない。r1 はずらしたカードをそのまま描く | docs/specs/reconstruction-display-design.md:695 «afadb0d2c42d70b3» | 未決（C0・T0・E0） |
| 11 | 入力の条件: 列のカードの高さは間（16・17px）より大きい（最小は折りたたみの見出しの 90px）。開いたカードの矩形は左の列の x（40〜580）の中にある。open があるとき、緊急地震速報の場所は 3 件以下（左の列に無い。DS-LAYER-23）。条件を破る入力の答えは定めない | docs/specs/reconstruction-display-design.md:709 «4458c7a23a81d028» | 統合担当の決め 2026-11-24 21:4x（根 A の 2）・2026-11-24 22:0x（R1） |

- 費用（n は今のページの列のカードの数）: 列のカードと覆い E の照合は 1 枚につき場所 6・間 5・開いたカード 1 の定数。上がったカードは n 枚まで、下げる照合は場所 6×上がったカード。下がった緊急地震速報のカードのずらしの判定は 6 枚それぞれに上がったカード（n 枚まで）の区間を並べて和を取る。合わせて O(n log n)。n は K（列のカードの数の上限、§4.3）以下。最上層の枚数は 7 を越えうる（上がったカードは n 枚まで、ヘルツの指摘 8）。
- DS-LAYER-10（docs/specs/reconstruction-display-design.md:641 «407ac2a45d1459a6»）は覆う形の帰結の記録で、凍結する決まりではない（計画:114）。DS-LAYER-11 は覆いを測った場面の事実の表で、凍結しない。

### 3.2 場面の表（T02・T11 の入力と期待）

L1〜L9 は placeLayers の入力（raised は空、T02）。「最上層」の列は、緊急地震速報の場所（eew）と開いたカード（open）として渡す。L11〜L14 は raised のある入力（T11）。どれも placeLayers に矩形を直に渡す（screenFrame を通さない。ヘルツの指摘 9）。

| # | 最上層 | 列のカードの入力 | 期待 |
|---|---|---|---|
| L1 | なし | 設定した地域 (40, 40, 540, 258.5)、右の警報 (1340, 40, 540, 543) | 暗くしない・ずらさない、cover は空 |
| L2 | 1 件 (1340, 40, 540, 1000) | 右の警報 (1340, 40, 540, 543) | 右の警報は暗くし、(1244, 40, 540, 543) へずらす（DS-LAYER-11 の場面 04） |
| L3 | 2 件 (1340, 40, 540, 492)・(1340, 548, 540, 492) | 右の警報 (1340, 40, 540, 543) | cover に間 (1340, 532, 540, 16) が入る。右の警報は暗くし、(1244, 40, …) へずらす（DS-LAYER-14 の 2 件） |
| L4 | 3 件 右の列 40・379・718 | 右の警報 (1340, 40, 540, 543) | cover に間 362〜379 と 701〜718 が入る。右の警報はずらす（場面 05、間を数えないと 96.9%） |
| L5 | 4 件（3 件 右、D (40, 40, 540, 322)） | 設定した地域 (40, 40, 540, 258.5)、今日の地震 (40, 315.5, 540, 300)、右の警報 (1340, 40, 540, 543) | 設定した地域は暗くし (136, 40, …) へずらす。今日の地震は暗くするだけ（315.5〜362 が重なる）。右の警報はずらす（場面 06） |
| L6 | 津波＋4 件（D だけ左） | 設定した地域、津波 (40, 315.5, 540, 322) | 設定した地域はずらす。津波は暗くするだけ（場面 16） |
| L7 | 津波＋5 件（D・E 左） | 設定した地域、津波 (40, 315.5, 540, 322)、今日の地震 (40, 654.5, 540, 288.5) | cover に間 362〜379 が入る。設定した地域と津波はずらす。今日の地震は暗くするだけ（654.5〜701 が重なる、場面 17） |
| L9 | 開いたカード (40, 145, 540, 717) | 設定した地域 (40, 40, 540, 258.5)、津波 (40, 315.5, 540, 322) | 設定した地域は暗くするだけ、津波は (136, 315.5, …) へずらす（DS-LAYER-17、場面 24。開いたカードの矩形は DS-OPEN-65 の案の数を入力に使った） |
| L11（場面 22k） | 3 件（右の列 A 40〜362・B 379〜701・C 718〜1040）。raised: 右の警報 | 右の警報 (1340, 40, 540, 543) | 右の警報は覆い E に全体が入るので (1244, 40, 540, 543) で、最上層・暗くない。A・B は警報の矩形と重なるので中間の層へ下がり、暗く、ずれない（x 1784〜1880 が手前のカードの外）。under はどちらも警報の id。C は最上層のまま |
| L12（場面 23k） | 津波＋5 件（左の列 D 40〜362・E 379〜701）。raised: 津波 | 設定した地域 (40, 40, 540, 258.5)、津波 (40, 315.5, 540, 322) | 津波は (136, 315.5, 540, 322) で最上層・暗くない。D・E は下がって暗く、ずれない（x 40〜136 が手前のカードの外）。設定した地域は覆い E（D・E と間）に全体が入るので、D が下がっても (136, 40, …) のまま暗い。中間の層の描く順は 設定した地域 → D・E |
| L13（文 4） | 5 件（左の列 D・E）。raised: 今日の地震 | 今日の地震 (40, 315.5, 540, 464.5) | 今日の地震は覆い E（40〜701）に全体が入らないので (40, 315.5, …) のまま最上層。D は 315.5〜362 だけが重なり暗く、ずれない。E（379〜701）は上がった今日の地震（315.5〜780）に全体が入るので暗く、(136, 379, 540, 322) へずれる（DS-LAYER-19）。今日の地震を押す動き自体は DS-OPEN-75（決まるまでは入れ替え） |
| L14（D2） | 4 件（左の列 D 40〜362）。raised: 今日の地震 | 今日の地震 (40, 700, 540, 200) | 今日の地震は D に重ならないので上がっていない扱い。中間の層で暗くなく、D は最上層のまま |

- L11・L12 の数は作業ノートの 20:50 の行（図 sp-22k・23k を見た記録）と、統合担当が図 sp-23k を目で見た記録（設定した地域は x 136 のまま暗く、下がった D がその手前）と同じ。L13 は作業ノートの 20:46 の例を算術で確かめた。
- r0 の L8（宣言値に無い間 38px）と L10（openFront の真と偽）は外した（根 C・根 F）。r1 の L15（左の列に緊急地震速報があるときに開いたカード）は、DS-LAYER-23 で作れない組になったので外した（r2）。

## 4. 列の割り（paginateColumn）

### 4.1 決まり

| # | 決まり | 出どころ | 種類 |
|---|---|---|---|
| 1 | カードの高さは種類ごとの固定値を持たず、中身の行の宣言した高さから計算する。配置は宣言した高さで組む | docs/specs/reconstruction-display-design.md:535 «3eab4d9a7d22e491»、docs/specs/reconstruction-display-design.md:503 «0b575fc39cfbbc04» | 作者の裁定 13:45（13:42 の「その2つの形でお願いします。」） |
| 2 | ページを送るカードは、いちばん高いページの高さで固定する。固定するのは同じカードの組（そのページに並ぶカードの id の列が同じ。統合担当の決め 2026-11-25 21:04）が並ぶページの間で、並ぶカードの枚数が変わるページでは変わってよい | docs/specs/reconstruction-display-design.md:536 «84a2584a52ec00fe»、docs/specs/reconstruction-display-design.md:611 «379eee6db9c243bb» | 作者の裁定 13:45（13:42）、2026-11-24 20:08（「変わってよい形で進めてください。」） |
| 3 | 組み方: 全ページを先に組み、カードごとに最大のページの高さを取り、その高さを当てて組み直す。固定した高さは、次の回で、同じカードの組（2 の id の列）が並ぶページのそのカードにだけ当てる（統合担当の決め 2026-11-25 19:30）。割りが前の回と揃うまで組み直す | docs/specs/reconstruction-display-design.md:537 «27a1d3578ae8be1f»、docs/specs/reconstruction-display-design.md:615 «bfe39a9786975059» | 統合担当の実装の形・統合担当の決め（14:5x） |
| 4 | 入り切らないときは隠さず、その列のページを送る | docs/specs/reconstruction-display-design.md:539 «5c7631d951df848a» | 統合担当の案を作者が 13:52 に受けた（13:51 の「入りきらないときについて、案通りでお願いします。」） |
| 5 | 高さを先に取る順は 津波 → 設定した地域 → 今日の地震（take）。列の上下の順は 設定した地域 → 津波 → 今日の地震（place） | docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1»、docs/specs/reconstruction-display-design.md:593 «880aea340f7bd4bd»、docs/specs/reconstruction-display-design.md:594 «1568355604ac0289» | take は統合担当の読み（2026-11-24）。place は作者の裁定 15:56（「2. 設定地域カードを上にしましょう。」） |
| 6 | 左の列のカードの間は 17px。左の列の使える高さは 903px | docs/specs/reconstruction-display-design.md:542 «064863dc9d475bd8»、docs/specs/reconstruction-display-design.md:614 «81463bdff3b8059f» | 統合担当の決め |
| 7 | ページの番号は列ごとに 1 つ | docs/specs/reconstruction-display-design.md:609 «7e5ad94131634bba» | 統合担当の決め（16:1x） |
| 8 | 右の列のページの表示は、そのページで一番下のカードの最後の行として、カードの下端に置く。1 ページのときは出さない。表示の行を数えるかは、まず数えずに割り、2 ページ以上になった列は表示の行（右の列 45.5px）を数えて割り直して決める。1 ページの列は数えない。数えて割り直したとき、形が変わらなければ 1 ページにはならない（ページの先頭の行が変わって continuation の出し直しが要らなくなると、ページの数は減ることがある。例: 右の列に head 90・本文 400・400・100・400・350、4 行目だけ continuation 400 の 1 枚で 3 → 2 ページ。ヘルツの実装のレビュー 4 巡目）。形の選び（AC05 (3)）が別の形へ移って 1 ページになったら、数えて割り直した結果をそのまま使い、表示は出さない（数えない割りへは戻らない。45.5px の分は空いてよい。図の道具と同じ動き。統合担当の決め 2026-11-25 19:36）。入力の条件 (h) の下では起きない（右の列に形を選ぶカードが無く、左の列は表示の行が 0）。表示の行を数えるかを先に決め、その後に固定の組み直しをする（統合担当の決め 2026-11-25 19:30） | docs/specs/reconstruction-display-design.md:610 «2add107071eeb1e1» | 統合担当の決め（16:1x）。カードの下端の読みと行の高さは表 §4.4 の c（統合担当の決め 2026-11-25 19:07） |
| 9 | 2 ページ以上の右の列で、1 枚だけのページはそのカードを列いっぱい（1000）にする。1 ページの列のカードは伸ばさない | docs/specs/reconstruction-display-design.md:611 «379eee6db9c243bb» | 1000 と「列いっぱい」は統合担当の字（作者の 2026-11-24 20:08 の字は「変わってよい形で進めてください。」）。1 ページの列で伸ばさないのは、表 §3.2 の L1・L2・L4 と、作者が 2026-11-24 20:54 に受けた版 13 の図 sp-05 の右の警報が 40〜583（543px）であることから（統合担当の決め 2026-11-25 19:07） |
| 10 | 行は字の 1 行の単位でページに分けてよい。続きのページは府県の見出しと種別の組を出し直す | docs/specs/reconstruction-display-design.md:612 «aea3fc7b49e541cc» | 統合担当の決め（14:5x）。ShellRow の continuation で受ける |
| 11 | 8 ページ以上は点を出さず字だけ | docs/specs/reconstruction-display-design.md:613 «363ac70cbc4a3838» | 統合担当の決め（14:5x）。ページの表示を描くのは S0 の DOM（字の形は AC08 (11) の「ページの番号＋1/ページの数」、点の描き方は表 §4.4 の f） |
| 12 | 今日の地震の形の順（ふつう 1 ページ → ふつうでページ送り → 圧縮 → 折りたたみ → 出さない）を、forms の順と maxPages・minBodyRows と mayHide で受ける | docs/specs/reconstruction-display-design.md:619 «0977920b24e986e2» | 作者の裁定 20:10 の問い 7（「判断事項についてはすべて推奨で大丈夫です。」）。受け方（forms）は統合担当の決め（2026-11-25 07:05 に起草の読みを今の字のまま確定） |
| 13 | 右の列でも「毎ページ出す要素」を受けられる形にする | docs/specs/reconstruction-display-design.md:679 «25e7d6e80255662c» | 未決（中身は C0）。形の head で受ける |

- 形の選び: forms を順に試し、次の 4 つを満たす最初の形を使う。ページの数が maxPages 以下（null は上限なし）。最後を除く全部のページに本文の行が minBodyRows 以上入る。置かれる最初のページの残りの高さに head と本文の 1 行（minBodyRows が 0 の形は head だけ）が入る。本文のどの行も、本文の無い形のカードだけが並ぶ新しいページの残りの高さに、head とその行の continuation と一緒に入る（本文の 1 行目の continuation は描かないので数えない。右の列で表示の行を数える割りでは 45.5px も合わせる。入らない行が 1 つでもある形は満たさない。mayHide でないカードは 下の入力の条件の (b)(c)(e) がこれを保証する。ヘルツの指摘 23、統合担当の決め 2026-11-25 20:04）。どの形も満たさないとき、mayHide のカードは出さず、ほかのカードは最後の形を使う。
- mayHide のカードは、次のページへ回して形を満たすことをしない。DS-PAGE-07 が「13:52 の『1 行も入らないカードは次のページ』は、今日の地震については DS-QROW-18 の形の順に置き換わった」と書くため（docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1»）。ほかのカードは 1 行も入らないとき次のページへ回る。
- 入力の条件（カードの契約が宣言する。条件を破る入力の答えは定めない・試験しない。破る入力でも割りは止まる: 新しいページに 1 行も入らないときは、次のページでその 1 行を置いて進む（答えは定めない。統合担当の決め 2026-11-25 21:04・22:15））: (a) どの形も head だけで列の高さ以下（本文の無い形を含む、ヘルツの指摘 17）。(b) どの形も「head と、本文のどの 1 行とその行の continuation」の高さの和が列の高さ以下（指摘 10）。(c) 右の列は (a)(b) に 45.5px（PAGE_MARK_ROW 37.5＋PAGE_MARK_GAP 8）を足しても列の高さ以下。左の列は 0（見出しの行の中。実測 sp-rows.md の :8 で、見出しの行 50px は表示の有無で変わらない）（表 §4.4 の e。統合担当の決め 2026-11-25 19:12）。(d) 左の列で本文を持つ形のカードは mayHide のカードだけ（破る入力の答えは定めない）。これで左の列の 2 ページ以上の各ページには mayHide のカードがあり、ページの表示はその見出しの行に置ける（表 §4.4 の d）（統合担当の決め 2026-11-24 21:4x の根 E・2026-11-24 22:0x の R5）。(e) 列ごとの合計: その列に置かれうるカードの組で、mayHide でないカードのうち本文の無い形を選びうるカードの head（形が 2 つ以上あればいちばん高いもの）の和とカードの間 17 が列の高さ以下。さらに mayHide でないカードの本文を持つどの形についても、その和に、その形の head と本文のどの 1 行とその行の continuation の高さ、mayHide のカードの本文の無い形の head（いちばん高いもの）、それぞれのカードの間 17 を足し、右の列はページの表示の 45.5px を足しても列の高さ以下（ヘルツの指摘 21、統合担当の決め 2026-11-25 19:29。後の和に mayHide のカードの本文の無い形を入れるのは統合担当の決め 2026-11-25 19:34。表 §4.4 の g）。(f) mayHide のカードは、その列で take がいちばん後ろ（mayHide のカードが 2 枚以上あるときは、それらより後ろに mayHide でないカードを置かない。破る入力の答えは定めない。出どころは DS-PAGE-07 の今日の地震（残りに入る形）、docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1»。統合担当の決め 2026-11-25 19:34。表 §4.4 の h）。(g) 開けるカード（opened のあるカード）は、その列で place がいちばん後ろ（今日の地震は満たす。破る入力の答えは定めない。統合担当の決め 2026-11-25 21:5x、r10-items.md の #16）。(h) 形を選ぶカード（形が 2 つ以上、null でない maxPages、2 以上の minBodyRows、mayHide のどれか 1 つでも当たるカード）は、入力の左の列に 1 枚まで、右の列に 0 枚。左の列の 1 枚の take は、その列のほかのどのカードの take よりも大きい（今は今日の地震だけで、満たす。規則の字は統合担当の案〔判断カードの A′〕で、作者の裁定 2026-11-26 06:45「判断についてはA(判断カードでのAダッシュ)で進めてください。」で採った。次の 2 文は統合担当の字: 破る入力の答えは定めない。形を選ぶカードがほかに要る契約〔T0 の津波の小さい形など〕は、その契約でこの条件と形の選びを広げる） (i) 本文のある形の minBodyRows は 1 以上（0 は本文の無い形だけ。破る入力の答えは定めない。統合担当の決め 2026-11-26 06:47、r10-items.md の #8）。
- 計算量は §4.3 の費用のとおり（形の選び 2 回まで・流し k＋2 回まで、P4-DS-RES-02）。DOM を読まない。結果は入力だけで決まる（同じ入力からは同じ結果。これは結果の性質で、入力の条件ではない）（台帳 37、reconstruction/contracts/p4-order-plan.md:808 «0554f4ef9e115079»）。

### 4.2 割りの組（T03 の入力と期待）

左の列（上端 40、使える高さ 903、下端 943）。行の高さは試験のために置いた数。

| # | 入力 | 期待 |
|---|---|---|
| P1 | mayHide のカード 1 枚、形 1 つ（maxPages なし・minBodyRows 1・head 90・本文 100×3） | 1 ページ、(40, 40, 540, 390) |
| P2 | mayHide のカード 1 枚、形 1 つ（maxPages なし・minBodyRows 1・head 90・本文 100×10） | 2 ページ（本文 8 行・2 行）。同じカードの組なので高さは 2 ページとも 890 |
| P3 | P2 の 9 行目に continuation（高さ 50 の 1 行） | 2 ページ目は head・continuation・9 行目・10 行目（340）。高さは 2 ページとも 890 |
| P4 | A（take 0・place 1、本文の無い形: head 700）と B（take 1・place 2、mayHide、形 F1〜F4）。B の形: F1 maxPages 1・minBodyRows 1・head 90・本文 100×2、F2 maxPages なし・minBodyRows 2・同じ行、F3 maxPages なし・minBodyRows 1・head 90・本文 50×1、F4 maxPages 1・minBodyRows 0・head 90・本文なし | A は (40, 40, 540, 700)。B に残る高さは 186（943−757）。F1・F2 は最初のページに head と本文 1 行（190）が入らず、F3 を使い (40, 757, 540, 140)。1 ページ |
| P5 | P4 の A を head 786 にする（B に残る高さ 100） | F3（140）は入らず、F4 を使い (40, 843, 540, 90) |
| P6 | P4 の A を head 806 にする（B に残る高さ 80） | どの形も入らず、mayHide の B は出さない。A だけの 1 ページ |
| P7 | 右の列（上端 40、高さ 1000）、カード 1 枚（head 90、本文 100×3） | 1 ページの列なので伸ばさず (1340, 40, 540, 390)。mark は null（DS-PAGE-11・12、表 §4.4 の P7） |
| P8 | 右の列、カード X（take 0・place 0、head 90・本文 100×2）と Y（take 1・place 1、head 90・本文 100×20） | 3 ページ（Y の本文 5・8・7 行。一番下の Y は表示の 45.5 を高さに数える）。X は本文の載る 1 ページ目だけに出て、2 ページ目からは Y だけで、1 枚だけのページなので Y は (1340, 40, 540, 1000)（表 §4.4 の b・P7）。2 ページ以上なので各ページに mark があり、cardId はそのページで一番下のカード（1 ページ目は Y）、pages は結果のページの数、dots は真（DS-PAGE-11） |
| P9 | 右の列、カード 1 枚（head 90・本文 100×70） | 9 ページ（本文 8 行ずつ、最後は 6 行。1 ページに入るのは 1000−90−45.5＝864.5 に 8 行）で、mark の dots は偽（DS-PAGE-14） |
| P10 | 左の列、カード A（take 0・place 0、本文の無い形: head 200）と mayHide の Q（take 1・place 1、形 1 つ: maxPages なし・minBodyRows 1・head 90・本文 100×10） | 2 ページ。A は本文の無い形なので両方のページに (40, 40, 540, 200)。Q は (40, 257, 540, 590) に本文 5 行ずつ（943−257＝686 に head と 5 行の 590 が入り、6 行の 690 は入らない）。左の列の表示の行は 0（表 §4.4 の b・e） |
| P11 | 左の列、カード A（take 0・place 0、本文の無い形: head 700）と mayHide の Q（take 1・place 1、形 1 つ: maxPages なし・minBodyRows 1・head 90・本文 50 と 800） | 残り 186 に head と 1 行目の 140 は入るが、2 行目の 890 はどのページにも入らないので、形を満たさず Q は出さない。A だけの 1 ページで (40, 40, 540, 700) |

- P8・P9 の数は、右の列で一番下のカードに表示の 45.5（PAGE_MARK_ROW 37.5＋PAGE_MARK_GAP 8、表 §4.4 の c）を数えて出した。P8 の 1 ページ目は X（40〜330）の後に Y が 347 から入り、残り 693 に head・表示と本文 5 行（635.5）が入る。

### 4.3 組み直しの上限（P4-DS-D-REPAGE-CAP=A、P4-DS-D-CARD-BOUND=A）

- 列のカードの数に、データで越えられない上限は今の型に無い（ShellCardSource は枚数の限られない配列を返す。r2 で確かめた）。そこで登録の欄に max を持たせ、列のカードの数の上限 K を、その列に置かれうる登録の max の和にする（P4-DS-D-CARD-BOUND=A、統合担当の決め 2026-11-24 22:0x。S0 は登録 0 本なので K は 0 で、各カードの契約が登録するたびに増える）。
- 1 列の割りは、表示の行を数えるかを決める数えない割り（AC05 (10)）1 回、2 ページ以上の列は表示の行を数える割り（固定なし）1 回と固定の組み直し k 回まで、合わせて k＋2 回まで（k はその時の列のカードの枚数〔登録の max で切った後〕。K はその列に置かれうる登録の max の和で、k は K 以下なので K＋2 回以下。数える割り 1 回と固定の組み直し k 回の和 k＋1 が REPAGE-CAP=A の「列のカードの数＋1」。数え方は統合担当の決め 2026-11-25 21:04 で 19:36 の数え方を改め、k と K を分けたのは統合担当の決め 2026-11-25 21:5x）。固定の組み直しの各回は前の回の固定した高さを当てて組み（固定した高さは、次の回で、同じカードの組（§4.1 の 2）が並ぶページのそのカードにだけ当てる（統合担当の決め 2026-11-25 19:30））、割りが前の回と同じになったら止める（比べるのは数える割りどうし）。上限で揃わなければ最後に組んだ回の割りを画面に出す（隠さない・空にしない）。
- 費用（ヘルツの指摘 8）: 形の選びは列の割りの中で 2 回まで（数えない割りと数える割り）で、1 回は 行×形×K（形は列の全部のカードの形の数）。流しは 1 回 行×K で、合わせて k＋2 回まで（K＋2 回以下）。返すページの行の参照はページの数×head と continuation の行の数で、head と continuation の行の数はカードの契約が決める定数。K は登録で決まる定数なので、受信 1 回の費用は行の数に比例する（統合担当の決め 2026-11-25 21:3x・21:5x・22:15、r10-items.md の #6）。
- 組み直しが走るのは、§2.4 の割りの使い回しの条件（paginateColumn の入力の全部が最後に割った時と同じ）に当たらない frame だけ。条件の字は AC08 (12) と §2.4 の 2 か所で同じ（ヘルツの指摘 18）。
- 上限で止まったときの割りで保たれるもの（入力の条件を満たす入力で）: 列の高さ以下、本文はちょうど 1 つのページ、同じカードの組が並ぶページの間でカードの高さが同じ。保たれないもの: 固定した高さが、その割りのいちばん高いページの高さと等しいこと（DS-PAGE-03 の「いちばん高いページの高さ」。カードの下が空くことがある）。
- 上限の根拠: take で前のカードの高さだけが後ろのカードの割りを変えるなら、k 枚の列は k＋1 回で揃う（起草の読み、証明はしていない）。上限が無いと、揃わない入力で受信ごとの処理が止まらない。

### 4.4 割りの細部（統合担当の決め 2026-11-25 19:07。作者の字ではない。i の (h) だけは、統合担当の案を作者の裁定 2026-11-26 06:45 で採った）

材料は子 s0-conform の調べ（作業ノートの .tmp-s0/q-ds-precheck.md）。図の道具（scenes.py）の行は、本起草では開いていない。

| 項 | 決まり | 出どころ |
|---|---|---|
| a | 高さは take の順に先に取る。本文を持つカードが 2 枚以上ある列では、本文を place の順に詰める（前のカードの本文が全部置き終わってから次のカードの本文を始める）（今の場面では §4.5 の sp-10・sp-12 の右の 1 ページ目〔特別警報の続きに警報〕）。固定した高さを当てたカードの高さは max（固定した高さ, 宣言した行の高さの和）（統合担当の決め 2026-11-25 21:04） | DS-PAGE-07（docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1»）・DS-LAYOUT-25 に、どちらが次のページへ回るかの字が無い。図の道具は take の前の 2 枚を全ページに置き、今日の地震だけを流す |
| b | 本文の行を持つ形（body が空でない形）を選んだカードは、本文の載るページにだけ出る。本文の無い形（head だけ）を選んだカードは、その列の全部のページに出る。どちらの形かは各カードの契約が forms で宣言し、S0 の条文はカードの名前で決めない（例: 今の見本の図では設定した地域・津波は本文の無い形、右の列の特別警報は本文のある形） | 見本の図 sp-10 の右（1 ページ目だけ特別警報、版 11 で作者が 2026-11-24 20:08 に受けた形）と sp-11・sp-12・sp-20 の左（図の道具の割り）。型に欄を足さない。津波のカードを 2 ページ目以降にも出す図を作者に見せた記録は無い（spec の DS-OPEN-76） |
| c | 右の列のページの表示は、そのページで一番下のカードの最後の行として、カードの下端に置く（版 11 の図 sp-10-wide-p2 の形）。tokens.ts に、表示の行の高さ PAGE_MARK_ROW 37.5px（字 30px × 行の高さ 1.25、DS の bundle.css の値）と、その上の間 PAGE_MARK_GAP 8px を宣言し、合わせて 45.5px をそのカードの高さに数える（統合担当の決め 2026-11-25 19:12。出どころは図の道具の実測 .tmp-s0/sp-rows.md の :7: sp-10 右・sp-12 右で行 37.5、上の間 8、その下にカードの下端の余白）。右の列で上の間が 8px でないカードを足す契約は、その契約でこの宣言値を改める。型に欄は足さない。表示の行を数えるかは、まず数えずに割り、2 ページ以上になった列は表示の行（右の列 45.5px）を数えて割り直して決める。1 ページの列は数えない。数えて割り直したとき、形が変わらなければ 1 ページにはならない（ページの先頭の行が変わって continuation の出し直しが要らなくなると、ページの数は減ることがある。例: 右の列に head 90・本文 400・400・100・400・350、4 行目だけ continuation 400 の 1 枚で 3 → 2 ページ。ヘルツの実装のレビュー 4 巡目）。形の選び（AC05 (3)）が別の形へ移って 1 ページになったら、数えて割り直した結果をそのまま使い、表示は出さない（数えない割りへは戻らない。45.5px の分は空いてよい。図の道具と同じ動き。統合担当の決め 2026-11-25 19:36）。入力の条件 (h) の下では起きない（右の列に形を選ぶカードが無く、左の列は表示の行が 0）。表示の行を数えるかを先に決め、その後に固定の組み直しをする（統合担当の決め 2026-11-25 19:30） | DS-PAGE-11（docs/specs/reconstruction-display-design.md:610 «2add107071eeb1e1»）は置き場だけで高さの字が無い。カードの下端の読みは版 11 の図の形 |
| d | 左の列で本文を持つ形のカードは mayHide のカードだけ（破る入力の答えは定めない）。これで左の列の 2 ページ以上の各ページには mayHide のカードがあり、ページの表示はその見出しの行に置ける | 条文は無い。図の道具では左の列で流れるのは今日の地震だけ |
| e | AC05 (7)(c): 右の列は (a)(b) に 45.5px（PAGE_MARK_ROW 37.5＋PAGE_MARK_GAP 8）を足しても列の高さ以下。左の列は 0（見出しの行の中。実測 sp-rows.md の :8 で、見出しの行 50px は表示の有無で変わらない） | c と d から |
| f | 点の描き方: 「1/4」の字の後に、今のページは塗った 16px の丸、ほかは 2px の線の 12px の丸、間は 12px（DS-PAGE-08）。8 ページ以上は点を出さず字だけ（DS-PAGE-14）。左の列（今日の地震の見出しの行）は字だけ（DS-QROW-21） | docs/specs/reconstruction-display-design.md:541 «44e052f31d6014ce»、docs/specs/reconstruction-display-design.md:613 «363ac70cbc4a3838»、docs/specs/reconstruction-display-design.md:622 «75d449cf21a3211f» |
| g | AC05 (7)(e): 列ごとの合計。mayHide でないカードのうち本文の無い形を選びうるカードの head の和とカードの間が列の高さ以下。さらに mayHide でないカードの本文を持つどの形についても、その和に head・本文のどの 1 行・continuation と mayHide のカードの本文の無い形の head とカードの間を足し、右の列は 45.5 を足しても列の高さ以下。mayHide のカードを前の和に入れないのは、形が入らなければ出さない（AC05 (3)）ので本文の無いカードだけの列を詰まらせないから（P6）。後の和に入れるのは、出たときは全部のページに出て、本文を持つカードのページの残りを減らすから | ヘルツの指摘 21（右の列の head 800 の本文の無いカードと head 90・本文 80×2 のカードは 800＋17＋90＋80＋45.5＝1032.5、左の列の head 500 の本文の無いカード 2 枚は 1017＞903 で、どちらも外れる）。統合担当の決め 2026-11-25 19:29。後の和に mayHide のカードを入れたのは起草の字で、統合担当の決め 2026-11-25 19:34で確定した（例: 右の列で本文を持つ B〔head 90・本文 100・continuation 50〕の後に mayHide の M〔head 700〕が 1 ページ目に入ると、2 ページ目は 90＋50＋100＋45.5＋17＋700＝1002.5 で入らない）。r11 の (h) の下では、左の列の本文を持つカードは mayHide の 1 枚だけ（(d)）で、右の列に mayHide のカードは無いので、後の和の mayHide の項に当たるカードは無い。この例も (h) の外 |
| h | AC05 (7)(f): mayHide のカードは、その列で take がいちばん後ろ。mayHide のカードが take で前にあると、出たときに後ろの mayHide でないカードより先に高さを取り、(e) で押さえられない | DS-PAGE-07 の今日の地震（残りに入る形）（docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1»）。統合担当の決め 2026-11-25 19:34。§4.2 の P1〜P11 は全部満たす（mayHide のカードがあるのは P1〜P6・P10・P11 で、どれも take がいちばん後ろ）。(h) はこの条件を含む |
| i | AC05 (7)(h)(i): 形を選ぶカードは左の列に 1 枚まで、右の列に 0 枚で、take がいちばん大きい。本文のある形の minBodyRows は 1 以上。形を選ぶカードが 2 枚以上あるか、後ろに高さを取るカードがあると、先に選んだ形の条件が後のカードで破れ、場所があるのにカードを消す入力がある（P12・P13 とヘルツの 3 枚の例。入力の置き場は JSON の Q-DS-R11）。1 枚で最後なら、選んだ時の割りがそのまま最後の割りになる | 作者の裁定 2026-11-26 06:45「判断についてはA(判断カードでのAダッシュ)で進めてください。」（判断カードの A′）。(i) は統合担当の決め 2026-11-26 06:47。§4.2 の P1〜P11 は全部満たす（形を選ぶカードは P1〜P6・P10・P11 の左の列の 1 枚だけで take が最大、P7〜P9 は形 1 つ・maxPages なし・minBodyRows 1 で mayHide なし。minBodyRows 0 は P4〜P6 の本文の無い F4 だけ） |
| P7 | 2 ページ以上の右の列で、1 枚だけのページはそのカードを列いっぱい（1000）にする。1 ページの列のカードは伸ばさない | 1000 と「列いっぱい」は統合担当の字（作者の 2026-11-24 20:08 の字は「変わってよい形で進めてください。」）。1 ページの列で伸ばさないのは、表 §3.2 の L1・L2・L4 と、作者が 2026-11-24 20:54 に受けた版 13 の図 sp-05 の右の警報が 40〜583（543px）であることから（統合担当の決め 2026-11-25 19:07） |

- 左右の列の間の進め方（見本の図はページの少ない列が最後のページのまま、作業ノート 2026-11-23 15:2x）は S1。
- c の上の間は、r7 の 1 回目では欄が無く決めが要る所だったが、統合担当の決め 2026-11-25 19:12で tokens.ts の PAGE_MARK_GAP 8 にした（型に欄は足さない）。

### 4.5 見本の図の 5 場面を r7 の条文で割り直した結果（Q-DS-COLUMN-FLOW、統合担当 2026-11-25 19:30 に閉じた）

証拠の file は作業の file で、.tmp-s0/ にあり git に入らない: q-ds-redivide.md（子 s0-conform が r7 の条文を script にして割り直した結果、64 行）・sp-rows-order.json（行の並び）・sp-rows.md（行の高さの実測、版 39 の DS で 1920×1080）。行の高さは図の道具の実測を写したもので、別の経路では出していない。

- 写し方（気象の警報のカードの契約 C0 の宣言の形、統合担当の決め 2026-11-25 19:25。S0 に決まりは足さない）: 行の上の間とカードの上下の余白は、行と head の高さに含めて宣言する。head は 90（上の余白 20＋見出し 50＋下の余白 20）。本文の行は「その行の高さ＋その行の上の間」（気象の警報のカードは 8 か 0、今日の地震は 12）。府県の見出しは次の行と 1 つの ShellRow にする。府県の見出しで始まらない行には continuation を 1 つ付け、高さは 52.5＋8＋（8−その行の上の間）（上の間 0 の行は 68.5、8 の行は 60.5）。左の列の設定した地域・津波は本文の無い形。今の型の欄（ShellRow の height・continuation）で全部表せ、AC05 (7)(b) の条件も全部の行で満たす。
- 上の間が記録に無い 11 行（null）の埋め方: カードの最初の行は見出しからの間（気象の警報 8・今日の地震 12）。右の列でページの境にあたる 11 行は sp-rows.md の :16 で埋めた（0 が 17・35・52・70・106・124・159・196 行目、8 が 87・141・177 行目）。この 11 行は割り直しでも全部ページの頭に来て、continuation の高さが上の間を打ち消すので、埋めた値は結果に効かない。

| 場面・列 | ページの数（割り直し／道具） | ページごとの行の範囲 | カードの矩形（top・height） | 固定した高さ・回数 |
|---|---|---|---|---|
| sp-10 右 | 12／12 | 12 ページとも合う（p1 特別警報 0〜11・警報 12〜16、p2 17〜34 … p12 196〜199） | p1 特別警報 40・602、警報 659・354。p2〜p12 警報 40・1000（中身の高さ 971.5〜399.5 も sp-rows.md と合う） | 警報（1 枚の組）995.5、2 回で揃う |
| sp-12 右 | 12／12 | sp-10 右と同じで合う | 同じで合う | 同じ |
| sp-11 左 | 3／3 | 0〜3・4〜7・8 で合う | 今日の地震 315.5・609.5 で 3 ページとも合う | 609.5、2 回 |
| sp-12 左 | 6／6 | 0・1・2〜3・4〜5・6〜7・8 で合う | 707.5・222 で 6 ページとも合う | 222、2 回 |
| sp-20 左 | 2／2 | 0・1 で合う | 707.5・205.5 で合う | 205.5、2 回 |

- 5 場面とも合い、合わない場面は無い。
- 5 場面の入力は入力の条件 (a)〜(f) を全部満たす（統合担当の決め 2026-11-25 19:34の後に確かめた。mayHide と take は入力の file に無いので、今日の地震だけを mayHide、take を DS-PAGE-07 の順とした）。右の列（sp-10・sp-12）: head 90、本文の 1 行と continuation のいちばん高い組は 75＋8＋60.5（上の間 0 なら 75＋0＋68.5）＝143.5、府県の見出しと次の行の ShellRow も 8＋52.5＋8＋75＝143.5 で、90＋143.5＋45.5＝279 ≦ 1000（(a)〜(c)、本文の無い形のカードと mayHide のカードは無いので (e) も同じ数）。左の列: (e) の前の和は sp-11 が 258.5、sp-12 左・sp-20 左が 311.5＋17＋322＝650.5 で ≦ 903、本文を持つ形は mayHide の今日の地震だけで (d) を満たし、後の和の対象は無い。今日の地震の本文の 1 行は最大 185＋12（ふつう）で 90＋197＝287 ≦ 903（(b)）。今日の地震は take が最後で (f) を満たす。r10 の (g) は、今日の地震が place でも最後（DS-LAYOUT-25）なので満たす。r11 の (h) は、形を選ぶカードが左の列の今日の地震 1 枚だけで take が最後なので満たす。
- 図の道具だけが持つ 2 つの決まりは、r7 の条文では要らない。「固定すると入らないカードは固定しない」は、カードの組ごとに固定する AC05 (5)(6) で同じになる（p1 の警報は特別警報と 2 枚の組なので固定されない）。「ページの末尾に残った府県の見出しを次へ送る」は、府県の見出しと次の行を 1 つの ShellRow にする写し方で同じになる。
- 2 通りに読めて結果が変わった字は、AC05 (6) の固定した高さを当てる先だけ。「カードごとにどのページにも当てる」と読むと、sp-10 右・sp-12 右の p1 に警報が入らず 12 ページとも行の範囲がずれる。AC05 (6)・表 §4.1 の 3・§4.3 に当てる先を書いた（統合担当の決め 2026-11-25 19:30）。表示の行を数えるかの決め方も AC05 (10)・表 §4.1 の 8・§4.4 の c に書いた（5 場面には効かない）。
- 確かめていない所: 今日の地震の形の選び（AC05 (3)）は、道具が選んだ形の行（sp-11 はふつう、sp-12 左・sp-20 左は圧縮）で割っただけで、ほかの形が条件を満たさないことは確かめていない。左の列の行の上の間で推定とある行は 12 として使った。

## 5. 押したとき（reduceShell）

### 5.1 押した点の相手

- 相手は、その点に描かれている一番手前の面（DS-LAYER-22、docs/specs/reconstruction-display-design.md:708 «d098a45b3e060ae8»。統合担当の決め 2026-11-24 21:4x、根 A の 2）。frame の cards を、最上層は前から奥へ、続けて中間の層を手前から奥へ見て、矩形が点を含む最初のカード。中間の層のカードは、点が frame の cover の中なら当たらない（最上層のカードの間は中間の層を描かず地図を見せているので、地図）。どれにも当たらなければ地図。時計と状態の札は地図と同じ扱い（変えない）。
- 開いているときは、frame の最上層の先頭が開いたカード（§3.1 の 8）。

### 5.2 reduceShell の表

| 開いているか | 事象と相手 | 結果 | 出どころ |
|---|---|---|---|
| どちらでも | press・frame.shell が今の state と同じ object でない（snapshot を受けて状態が変わった後、次に描く前の押下） | 変えない | docs/specs/reconstruction-display-design.md:709 «4458c7a23a81d028»（DS-LAYER-23、R2。ヘルツの指摘 15） |
| 開いていない | press・最上層のカード（上がったカード・最上層の緊急地震速報） | 変えない | 統合担当の決め（作業ノートの 2026-11-24 20:3x の表） |
| 開いていない | press・下がった緊急地震速報のカード（under が空でない） | raised から under の id を外す | docs/specs/reconstruction-display-design.md:637 «607da88cacaf0a69»（DS-LAYER-06 の後半、文 2） |
| 開いていない | press・暗い列のカード（ずれて出た所を含む） | raised に id を足す | docs/specs/reconstruction-display-design.md:661 «17c95a272fa4b451»（DS-LAYER-15、文 1） |
| 開いていない | press・暗い列のカードで openable（緊急地震速報に覆われた今日の地震） | 暗いカードと同じく raised に足す | docs/specs/reconstruction-display-design.md:705 «71b0045df6757fc6»（DS-OPEN-75、S1・E0）。決まるまでの動き |
| 開いていない | press・暗くない openable（今日の地震のカード）で、state.eew が 3 件以下（左の列に緊急地震速報のカードが無い） | 開く（全部の行が最上層に開く） | docs/specs/reconstruction-display-design.md:639 «c9a1a5a2e24078a9»。作者の裁定 21:44 の問い 2（「問2は推奨で進めていただきたい」） |
| 開いていない | press・暗くない openable で、state.eew が 4 件以上（左の列に緊急地震速報のカードがある） | 変えない | docs/specs/reconstruction-display-design.md:709 «4458c7a23a81d028»（DS-LAYER-23、R1。P4-DS-D-OPEN-WHILE-EEW=A、作者の裁定 2026-11-25 07:0x） |
| 開いていない | press・暗くない、openable でない列のカード／地図 | 変えない | 統合担当の決め（同じ表） |
| 開いている | press・点が開いたカードの中 | 変えない | 統合担当の決め（同じ表）。もう一度押して閉じる形は docs/specs/reconstruction-display-design.md:696 «f9f222a93fbbcd43»（C0） |
| 開いている | press・ほかの全部 | 閉じる。raised は変えない | docs/specs/reconstruction-display-design.md:640 «646c1e6ed4cecacc»。前半は作者の言葉 21:44「カード外部分をクリックしたときに展開を解除するようにしてください。」、後半（暗いカードの上を押しても閉じる）は統合担当の読み。ずれて出た所は docs/specs/reconstruction-display-design.md:663 «3f8ce75d003426b5»（版 10 の箇条で統合担当の決め。作者の 2026-11-24 19:49 の「」は「ずらすようにしてください。」だけ）。後半とずれて出た所は作者の裁定 2026-11-25 07:0x（「判断事項については、全て推奨で進めてください。」）（P4-DS-D-SECOND-GROUP=A）で凍結 |
| どちらでも | sync・eew の組が state.eew の組と違う（event が増えた・減った・入れ替わった） | raised を空、閉じる、eew を新しい組に | docs/specs/reconstruction-display-design.md:707 «d5532af5eeb3647d»（DS-LAYER-21、D3） |
| 開いている | sync・組が同じで openable が偽（今日の地震のカードが無い） | 閉じる | docs/specs/reconstruction-display-design.md:708 «d098a45b3e060ae8»（DS-LAYER-22、根 A の 3） |
| どちらでも | sync・ほか（同じ event の続報、並びだけの違いを含む） | 変えない | 同上 |

- main.ts は snapshot を採るたびに sync を当て（合流しない）、描く前にも同じ nowMs で当てる。{A} → {A, B} → {A} が描く前に届いても、最初の変化で raised が空になる（ヘルツの指摘 4、根 A の 4）。その間の押下は、描いてある frame の shell が今の state と違うので何も変えない（R2）。
- 左の列に緊急地震速報のカードがあるかは、sync の eew の件数（slot の順で 4 件目からが左の列）から reducer が知る。開いた矩形を reducer に渡さない。
- 開いている間も自動のページ送りを止めない（DS-LAYER-08 の「自動のページ送りは残す」。送るのは S1）。開いている間の左の列の pageCount は、開いたカードを外した割りのページの数。その送りの受け方は S1 が決める（統合担当の決め 2026-11-25 21:3x、r10-items.md の #16）。
- 津波の札を押して報を流し直す機能は作らない（docs/specs/reconstruction-display-design.md:658 «aa1e855dc2e8b752»、docs/specs/reconstruction-display-design.md:531 «da5a159a2642244d»。作者の裁定 13:52、13:51 の「流し直しを外してください。」）。
- D3 が働くには、E0 が slot のカードの id を event ごとに 1 つにする（続報で id を変えない）。§12 の 11。
- sync の組の比べは id の組の等しさで、費用は id の数（6 まで）。

### 5.3 T04 の点の組（frame は §3.2 の placeLayers の結果から試験の中で組む）

| # | frame | 点 | 相手 | 結果 |
|---|---|---|---|---|
| Q1 | L4（右の警報は (1244, 40, …) で暗い）、開いていない | (1500, 370) | 地図（A と B の間 362〜379 は cover） | 変えない（ヘルツの指摘 2） |
| Q2 | 同じ | (1260, 300) | 暗い列のカード（ずれて出た 1244〜1340） | raised に警報 |
| Q3 | 同じ | (1500, 300) | 最上層の A | 変えない |
| Q4 | L12（raised: 津波） | (60, 100) | 下がった D（設定した地域は 136 から右） | raised から津波を外す |
| Q5 | 同じ | (600, 100) | 暗い設定した地域（D は 580 まで） | raised に設定した地域を足す |
| Q6 | L9（開いている） | (300, 500) | 開いたカード | 変えない |
| Q7 | 同じ | (700, 300) | 地図 | 閉じる |
| Q8 | L14（緊急地震速報 4 件、今日の地震は暗くない）、開いていない | (300, 800) | 暗くない今日の地震（openable） | 変えない（左の列に D がある、DS-LAYER-23） |
| Q9 | 緊急地震速報 3 件（右の列）、今日の地震 (40, 315.5, 540, 300) は暗くない、開いていない | (300, 400) | 暗くない今日の地震（openable） | 開く |

### 5.4 状態（S1〜S6）

| # | 決まり | 出どころ |
|---|---|---|
| S1 | 状態は「開いているか」「上がったカードの id の組（raised）」「最後に見た緊急地震速報のカードの id の組（eew）」だけ。左の列に緊急地震速報のカードがあるかは eew の件数から導く | D1（統合担当の決め 2026-11-24 21:2x、作者の裁定 2026-11-25 18:50 で A、P4-DS-D-READINGS）、D3（統合担当の決め・読み（作者の裁定 2026-11-25 07:0x（「判断事項については、全て推奨で進めてください。」）、P4-DS-D-SECOND-GROUP=A で凍結））、DS-LAYER-23 |
| S2 | 上がったカードの層と位置と下がるカードとずらしは placeLayers が決める（§3.1） | docs/specs/reconstruction-display-design.md:706 «08990d19480f4bdc»（DS-LAYER-20） |
| S3 | 下がったカードを押すと under の id を raised から外す。外した後に重なる上がったカードが無くなった緊急地震速報のカードは最上層へ戻り、上がっていたカードは中間の層の同じ位置へ戻る（押す前の重なりに戻る） | docs/specs/reconstruction-display-design.md:637 «607da88cacaf0a69»（文 2） |
| S4 | raised の id が今のページの列のカードに無いときは無視する（状態から消すのは S1・E0） | 統合担当の決め（2026-11-25 07:05 に起草の読みを今の字のまま確定） |
| S5 | sync は snapshot を採るたびと描く前に当てる。組が変わったら raised を空にし閉じる。今日の地震のカードが無くなったら閉じる | docs/specs/reconstruction-display-design.md:707 «d5532af5eeb3647d»、docs/specs/reconstruction-display-design.md:708 «d098a45b3e060ae8»（D3、根 A の 3・4） |
| S6 | 押下は描いた frame とその shell の組に当てる。shell が今の state と同じ object でなければ変えない（reduceShell は変えないとき同じ object を返す） | docs/specs/reconstruction-display-design.md:709 «4458c7a23a81d028»（DS-LAYER-23、R2） |

### 5.5 閉じた所と、後の契約へ送る所

- 閉じた（統合担当の決め 2026-11-24 21:2x・2026-11-24 21:4x・2026-11-24 22:0x）: 緊急地震速報の組が変わったとき（D3）、今のページに無い id（S4）、ずれていたかを持たない（状態の数を減らした所）、押した点の相手（根 A の 2）、今日の地震のカードが無くなったときの開いた状態（根 A の 3）、描く前の合流と D3（根 A の 4）、開いたカードと左の列の緊急地震速報のカード・上がったカード・下がったカードの組は作らない（R1、DS-LAYER-23）、状態が変わった後の旧い frame への押下は効かない（R2）。D1（下げたカードと列のカードの前後、横に動かない）は統合担当の決めのまま作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS）。
- 後の契約へ送る: DS-OPEN-45（下がった緊急地震速報のカードを続報・時間で戻すか、上がったカードの寿命。S1・E0。決まるまでは D3）、DS-OPEN-46（開いたカードと緊急地震速報のカードの前後。S1・E0。決まるまでは左の列に緊急地震速報のカードがある間は開かない、DS-LAYER-23）、DS-OPEN-75（暗い今日の地震を押したとき。S1・E0。決まるまでは入れ替え）。
- r2 の直しの後も決まらない組: 間（16・17px）だけに入る高さの列のカードと、左の列の x の外にある開いた矩形は入力の条件の外で、答えを定めない（§3.1 の 11）。左の列のページに mayHide のカードが無い組は、r7 の入力の条件（AC05 (7)(d)）で作れない。

## 6. host の配線（reconstruction/src/host/host.ts）

行を足さない。他の契約の «» が :23〜:684 の多くの行を引く（起草時に `git grep` で数えた。:12・:91・:98・:180・:606・:628 を引く契約は 0）。
下の表の :12・:98・:180・:606・:628 の «» は起草時の字で、実装が字を変えた後は合わなくなる。本契約の JSON はこの 5 行を引かない（表の file は checker の外）。

| 行 | 今の字（要旨） | 変え方 | 理由 |
|---|---|---|---|
| reconstruction/src/host/host.ts:12 «f4b10320134ad55c» | http-sse の import と DisplaySnapshot の型の import | 行の中に DisplayWireSnapshot の型の import を足す | (2)(3) の型 |
| :91（空の行） | — | `let latestWire: DisplayWireSnapshot \| null = null;` を置く | 表示の包みが読む変数は startRuntime より前に宣言する（reconstruction/src/host/host.ts:589 «7f172fccc2943a05»） |
| reconstruction/src/host/host.ts:98 «8462acde5031c2c6» | displayOptions の onSerialize と detail | 行の中に wireAssets（htmlPath `reconstruction/src/display/screen/index.html`、moduleDirectory `reconstruction/dist/screen/src/display/screen`）を足す | http-sse は wireAssets があるときだけ /display を出す（reconstruction/src/http-sse/http-sse.ts:151 «e01014c2d3332698»、reconstruction/src/http-sse/http-sse.ts:198 «2983faaca6303652»） |
| reconstruction/src/host/host.ts:180 «a56ac2644d37c97a» | root へ渡す display の object の後半 | 行の中に publishWire（latestWire を置き換え、`server?.publishWire(snapshot, urgent)`）と flushWire（`server?.flushWire()`）を足す | root は display の publishWire?・flushWire? を呼ぶ（reconstruction/src/runtime/composition-root.ts:143 «85f8cd15e6437efe»、reconstruction/src/runtime/composition-root.ts:992 «bc426f3e1ac45869»）。今の host は渡していない（reconstruction/src/host/host.ts:179 «03be71ad623bc519»） |
| reconstruction/src/host/host.ts:606 «5ed3099d844595fa» | closeServer の始まり | 行の中の `{` の後に `open.flushWire();` を足す（close の前に保留を、詰まっていない client に書く） | closeServer は停止の finally の closeDisplay（:536）、並行した closeDisplay（:633〜:640）、開く途中の停止（:625）、起動の失敗（:201）の全部の close の入口。http-sse の close は保留の timer を消して client を destroy する（reconstruction/src/http-sse/http-sse.ts:259 «2f21ef90938f67c1»・:260）ので、ここで flush しないと停止の完了の前の例外と並行した closeDisplay で保留が消える（ヘルツの指摘 6） |
| reconstruction/src/host/host.ts:628 «a64363c499090257» | 開き直しで worker の値を渡す | 行の中に `if (latestWire != null) opened.publishWire(latestWire, true);` を足す | openWire はつないだ客に最後に公開した 1 通だけを書く（reconstruction/src/http-sse/http-sse.ts:355 «37aaf4e51c213ced»）。urgent を偽にすると最大 1 秒は何も届かない |

- 変えない行: reconstruction/src/host/host.ts:92 «e96e8b3876848ef5»、reconstruction/src/host/host.ts:95 «371bcde3a6b33955»、reconstruction/src/host/host.ts:96 «3eba4c9225f4762a»（`/` の chrome-eew、切替は T0）、reconstruction/src/host/host.ts:526 «e74d6a66c5815e63»、reconstruction/src/host/host.ts:536 «6a1da25a695ded94»、reconstruction/src/host/host.ts:629 «f08b37f228105594»。
- 停止の close の前の flush: 正常な停止では、root の停止の完了の project が projected なら急ぎの完全な版を公開し、unchanged なら flushWire を呼ぶ（reconstruction/src/runtime/composition-root.ts:992 «bc426f3e1ac45869»、P4-DC-AC04 (1)）。それは `root.shutdownRuntime`（:526）の中で `closeDisplay`（:536）より前に起きる。r1 は closeServer（:606）でも close の前に flushWire を呼ぶので、停止の完了の前の例外（finally から closeDisplay）と、停止を待つ間の closeDisplay でも、その時の保留が、詰まっていない client に書かれてから close する。残る場合: close の後に root が作った版は届かない（server が null。latestWire に残り、開き直しで送る。停止中は開き直せない）。書き込みが詰まっている客（前の write が false を返し drain を待つ客）には保留は書かれず、その客の待ちに置かれるまでで、close の destroy で届かない（P4-DC-AC04 (7) の残存。統合担当の決め 2026-11-25 21:3x、r10-items.md の #12）。最後の write が false を返した客には、書いた直後の destroy で届かないことがある（P4-DC-AC04 (7) と同じ）。
- urgent は root が決めた値（`wire.urgent || stopped`）をそのまま server に渡す。
- 新しい画面の path は `/display`（reconstruction/src/http-sse/http-sse.ts:321 «4e7f7f00392b2039»）。E0 発注 2 の EEW の runner はここへ向ける（reconstruction/contracts/p4-order-plan.md:91 «16c59b4b17071c38»）。

## 7. 置き場と build と配る経路

### 7.1 directory（P4-DS-D-MODULE-PATH=A）

`reconstruction/src/display/screen/`:

| file | 中身 | DOM |
|---|---|---|
| index.html | 画面の根の要素、style（CSS の変数を読む）、`<script type="module" src="/display/main.js">` | — |
| tsconfig.json | chrome-eew の tsconfig と同じ形（reconstruction/src/display/chrome-eew/tsconfig.json:8 «63b55f2ada487125»、reconstruction/src/display/chrome-eew/tsconfig.json:9 «3b6fd5df2e4fbb39»）、outDir は `../../../dist/screen` | lib に DOM |
| main.ts | EventSource・DOM・timer・performance.mark・押した所の判定 | 使う |
| tokens.ts | LAYOUT・COLORS・token の class の表 | 使わない |
| layout.ts | eewSlots・clockRect・placeLayers・paginateColumn・reduceShell | 使わない |
| client.ts | acceptSnapshot・detailRequested・detailAnswered | 使わない |
| frame.ts | screenFrame・shellSync・formatJst・clockText | 使わない |
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

### 7.3 書体（P4-DS-D-FONT=A、作者の裁定 2026-11-25 07:0x）

- Pi に BIZ UDPGothic が無い（統合担当の調べ）。今の server は書体の file を配れない（reconstruction/src/http-sse/http-sse.ts:198 «2983faaca6303652»）。
- A: Pi の OS に入れて font-family の名前で指す。字の幅の表（docs/specs/reconstruction-display-design.md:560 «43627ca90f37ce4b»）は Pi に入れた file から作り、file の sha256 を表に書く。OS の package の有無と版は確かめていない。
- 実装は font-family の名前だけを書き、書体の file を repo に入れない。Pi の package の有無と版は Pi の配送の手順で確かめる。

## 8. 試験の分け方

| どこで | 何を | testMapping |
|---|---|---|
| vitest（node） | 純粋な関数（eewSlots・clockRect・placeLayers・paginateColumn・reduceShell・shellSync・acceptSnapshot・detailRequested・detailAnswered・screenFrame・formatJst・clockText） | T02〜T07・T11・T12 |
| vitest（静的検査） | screen/** の字を読み、HTML を解釈させる API・layout を読む API・main.ts 以外の DOM の参照・file の名前・observer と canvas の参照・旧の経路（DisplaySnapshot・chrome-eew・"/events"）の参照 | T08 |
| vitest（host） | host を起こして /display・新しい経路・開き直し・停止の flush | T09 |
| 実 Chrome（smoke.mjs、統合担当が開発機で） | 名前つきの `snapshot` の 1 通が画面に出る、カードの面の色と時計の位置が tokens.ts の値で描かれる（T01 を外してここで見る、根 F）、字の差し替えで要素の数と実行 0、再接続とページの切替の後の listener・timer・EventSource の数、layout を読む API の呼びの数、E04 の 2 つの mark の差（記録だけ） | T10 |
| PM | E04 の正式の測定（暫定 p99≤250ms、docs/specs/reconstruction-p0-contracts.md:2055 «da2605b0ad504b31»）と Pi の Chromium の 72 時間（reconstruction/contracts/p4-order-plan.md:71 «a4785e44d38a663e»） | 本契約の外 |

- E04 の mark: 受けた時（snapshot の event の handler の始め）と、描いた後の最初の paint（requestAnimationFrame の次の frame）に、streamId と sequence を名前に含む performance.mark を置く。mark は直近の 64 版の分だけ残し（P4-DS-RET-03）、描く前に合流した版と、描画の止まる間の版の received も消す（統合担当の決め 2026-11-25 21:3x・21:5x、r10-items.md の #14）。PM の p99 は走行中に読む。分け方は統合担当の決め（2026-11-25 07:05 に起草の読みを今の字のまま確定）。計画は S0 と PM の分け方を書いていない（計画:114 と reconstruction/contracts/p4-order-plan.md:339 «284e39f8a0cb27c2»）。S0 の受入は測る所があることまで、と読んだ。
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
| reduceShell | 押したときの動きと、緊急地震速報の組が変わったときの戻し（D3）が DOM の handler の中にあり、試験できない。押した点の相手を DOM の重なりに任せると、間を押したときの相手が決まらない（ヘルツの指摘 2） |
| shellSync | snapshot を採るたびに緊急地震速報の組と開けるカードを見る所が無いと、描く前の合流で D3 の変化を落とす（ヘルツの指摘 4）か、無くなった今日の地震の開いた状態が残る（指摘 3） |
| detailRequested と ShellDetail の streamId | 遅れて届いた旧い stream の応答を採る（ヘルツの指摘 11） |
| frame の shell（R2） | 状態が変わった後、まだ描いてある旧い frame を押すと、閉じたはずの開いたカードの外で入れ替えが起きる（ヘルツの指摘 15） |
| 登録の max（K）と frame の diagnostics | 列のカードの数が限られず、組み直しの費用が受信ごとに列のカードの数の 2 乗になる（ヘルツの指摘 8）。越えた分を黙って落とすと、source の実装の誤りが画面の欠けとしてだけ残る |
| ShellRow の token | 見出しの行と行の区切りの形（DS-CSS-02）を行の class で付けられず、main.ts が行の字や位置から形を決めることになる |
| ShellDrawCard の mark | paginateColumn のページの表示が画面へ届く道が無い（ヘルツの指摘 16） |
| host の closeServer の flushWire | 停止の完了の前の例外や並行した closeDisplay で保留が消える（ヘルツの指摘 6） |
| ShellState（開いているか・raised・eew）と ShellDrawCard の under | 下がった緊急地震速報のカードを押したときに、どの上がったカードを戻すかが決まらない（文 2）。下がったカードそのものを状態に持つと、緊急地震速報の増減のたびに状態を直す処理が要る |
| screenFrame | X0 の発注 3 が DOM を読むか依存を足す形になる（Q-PWT3-ROWS-FN の「無ければ」） |
| cards.ts の CARD_SOURCES | 各カードの契約が frame.ts を書き換え、直列になる（計画:227 の「1 行の登録だけ」） |
| 破棄の表（main.ts） | 再接続とページの切替で listener が増える（R52、reconstruction/contracts/p4-order-plan.md:71 «a4785e44d38a663e»） |
| performance.mark 2 つ | E04 を測る所が無く、PM が src を変える |
| formatJst・clockText | 各カードが日本時間の計算を別々に持つ（P2-A9-AC10） |
| host の latestWire | 表示の開き直しで、次の電文まで新しい画面が空 |

- 型の file（p4-display-shell.types.ts）の型はどれも上の関数の入出力で、ほかの契約（S1・E0・C0・M0・X0）が読む。実装が 1 つしかない interface・設定の層は足していない。
- ページの番号を外から替える公開物は置かない（番号を替えるのは S1。統合担当の決め 2026-11-25 21:3x、r10-items.md の #17）。

## 10. 凍結に入れた「統合担当の決め・読み」と、作者の裁定の区分

- 作者の裁定（「」の字で裏が取れる）: 状態の札の字「受け取った情報を表示できません」・「詳細を表示できません」（作者の裁定 2026-11-25 19:09。選んだ選択肢の字で、選択肢は統合担当の字）、DS-LAYER-01・02・04・05・07（向きを除く）・08・09 の前半・12・13・14・17・18、DS-LAYER-06 の前半（2026-11-23 21:44）、DS-LAYER-06 の後半・15・19 と DS-OPEN-63（統合担当の読みを作者が 2026-11-24 20:54 に受けた）、DS-PAGE-02・03・12、DS-PAGE-06（統合担当の案を作者が 2026-11-23 13:51:15 に受けた）、DS-LAYOUT-25・DS-COL-04（15:56）、DS-LAYOUT-22 の場所（13:52）、DS-LAYOUT-24（13:52）、DS-QROW-18（20:10）。2026-11-25 07:0x の作者の言葉「判断事項については、全て推奨で進めてください。」で A にした分岐: P4-DS-D-OPEN-WHILE-EEW・SECOND-GROUP・CLOCK-SIX・FONT（中身は帯に出した A の字＝契約 r2 の A）。
- spec が作者の裁定と書くが、作業ノートの「」で本起草は確かめていないもの: DS-SIZE-03・04 の 540（2026-11-23）、DS-MAP-22 の層（13:03。「」は層の一文だけで、「面は不透明」は spec の地の文）。r0 はこれらを「spec の字」として引く。
- 統合担当の決め・読みとして凍結に入れた: DS-PAGE-04・07・09・10・11・13・14・15・16、DS-LAYOUT-22 の位置の数、DS-LAYER-03 の 40・379・718（DS-LAYOUT-05〜06 から）、P4-DS-D-MODULE-PATH・REPAGE-CAP（2026-11-24 21:1x）、根 A〜F（2026-11-24 21:4x、DS-LAYER-22）のうち、押した点の相手・close の前の flush・カードが消えたら閉じる・合流と sync、D2（2026-11-24 21:2x、DS-LAYER-20）、ずらす向きを列で書いたこと（DS-OPEN-64）、R2〜R5（2026-11-24 22:0x）、P4-DS-D-CARD-BOUND（2026-11-24 22:0x）。ここまでは作者への問いにしない（統合担当の決め 2026-11-24 22:0x。D1 は 2026-11-25 07:2x に P4-DS-D-READINGS へ入れた）。2026-11-25 07:05 に今の字のまま確定した起草の読み 8 件: 一部だけ重なるカードも暗くする（§3.1 の 4）、「上 40px」は上端、時差の無い字は「時刻不明」、forms で DS-QROW-18 を受ける形、E04 の S0 と PM の分け方、CLOCK-SIX の起草案（作者の A で閉じた）、§5.4 の S4、左の列のページの表示を mayHide のカードの見出しに置くこと（§2.4）。
- 作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS、作者の言葉「判断事項については、すべて推奨で進めてください。」。見た目に別の案がある物で、中身は帯に統合担当が書いた A「このまま」と 4 つの字。条文は今の図の形の 1 本）: 一部だけ覆われたカードも暗くする（AC06 (5)）、左の列のページの表示は今日の地震の見出しの行（AC08 (11)）、状態の印の「上 40px」は上端（AC10 (2)）、D1（版 13 の図 sp-23k の形: 上げても下げても列のカードは横に動かない（覆いは緊急地震速報のカード全部で取る）、下がったカードは上がっていない列のカードの手前に描く（DS-LAYER-20）。見比べのページ版 13 の箇条「押す前と押した後で、どのカードも横に動かない。」と図 sp-23k で作者に見せた。箇条の字は作業ノート）。
- 作者の裁定 2026-11-25 07:0x（「判断事項については、全て推奨で進めてください。」）で A（P4-DS-D-SECOND-GROUP）: 暗くする形を明るさにしたこと（DS-OPEN-62 の形。値は凍結しない）、開いている間は暗いカードの上を押しても閉じるだけ（DS-LAYER-09 の後半）、開いている間は元のカードを描かない（DS-LAYER-16）、D3（DS-LAYER-21）。
- 作者の裁定 2026-11-25 07:0x（「判断事項については、全て推奨で進めてください。」）で A（P4-DS-D-OPEN-WHILE-EEW）: 左の列に緊急地震速報のカードがある間は今日の地震を押しても開かない（R1、DS-LAYER-23）。
- 入力の条件 (h)（統合担当の案の判断カードの A′ を、作者の裁定 2026-11-26 06:45「判断についてはA(判断カードでのAダッシュ)で進めてください。」で採った）。(i) は統合担当の決め 2026-11-26 06:47。
- 凍結しない（後の契約）: DS-LAYER-10・11、DS-OPEN-45・46・62 の値・65・67・68・75。
- DS-MAP-24（警報以上が出ている間は右の列にカードがあり地図の見える幅は 760px）は S0 の条文に要らない（右の列の区分ごとのカードは C0 が登録する）ので引かない。

## 11. 計画・spec と当たった所

| 所 | 食い違い | r0 の扱い |
|---|---|---|
| 時計の位置 | spec:425（D05）の「右下時計」（docs/specs/reconstruction-p0-contracts.md:425 «8c167706c5a0a9ab»）、H03 の「地図の上の真ん中」（docs/specs/reconstruction-p0-contracts.md:3030 «c923951e64029e12»）と、計画・DS spec の「左下」 | 左下（reconstruction/contracts/p4-order-plan.md:787 «609c001782c081da»、DS-CLOCK-02）。spec の本文の改めは計画:386 の「表示設計 spec の凍結時」 |
| ヘッダ | spec:425 の「表示モード・接続状態だけのヘッダ」と H02 の「ヘッダの帯は作らない」（docs/specs/reconstruction-p0-contracts.md:3029 «a4fb170e00c3b22b»） | 帯を作らない（H02、reconstruction/contracts/p4-order-plan.md:786 «e22a0b111f2147a6»） |
| 検収端末 | spec:167（docs/specs/reconstruction-p0-contracts.md:167 «2cc109ef03d71ce4»）・:1688・:2961 の「開発機の Chrome」と、計画:383 の「S0 の凍結時に P4-PLAN-D-SCREEN の結果へ」（reconstruction/contracts/p4-order-plan.md:383 «d032ca260ac4d42b»） | smoke は開発機の Chrome。Pi の Chromium の資源は PM。spec の本文は置き換えない（Q-DS-SPEC-REVISION） |
| P2-A9 の在り処 | 依頼の字は p2-snapshot-sse.json、定義は p2-chrome-eew.json | p2-chrome-eew.json の AC01・AC08・AC10 を引く（reconstruction/contracts/p2-chrome-eew.json:414 «3b73f7c36e965a88»） |
| P2-A9-AC01・AC10 の型 | 旧の DisplaySnapshot と旧の EEW の時刻の欄を名指す | 新しい経路の DisplayWireSnapshot に読み替える。EEW の時刻の欄は E0 のカードが formatJst を使う |
| O11:6 | 計画:72 の「6 は SSE と S0」と、B1 が SSE の側を持った | S0 は画面の側の合流だけ（AC15 (1)） |
| 部品の directory | 計画:227 の「各カードの契約は自分の部品の directory」と http-sse.ts:323 の 1 階層 | P4-DS-D-MODULE-PATH=A（§7.1） |
| host の配線の持ち主 | B1 の outOfScope「host.ts の配線（新しい経路を製品で流すのは E0 発注 2）」と、計画:229 の S0（2026-11-23） | S0 が持つ（reconstruction/contracts/p4-order-plan.md:229 «5087b78524621456»）。B1 の字は §12 で改める |
| D-AC18 | spec:1855 の「container／on／band、基準下辺 4px」（docs/specs/reconstruction-p0-contracts.md:1855 «28217bd0fdd3a039»）は DS spec の字に無い | S0 は DS-CSS-02 のカードの枠と見出しの行を持つ。「基準下辺 4px」「band」は DS の形に無いので条文にしない。spec の本文は置き換えず AC13 (3) を真実源とする（Q-DS-SPEC-REVISION） |
| D-AC02 | S0 の分の範囲を計画が書いていない | 空の災害カードを作らない・ページの外にも取消が効く・要約を無発令にしない、を骨組みの側で（AC08 (6)(7)）。状態の分は C2 |
| E04 | S0 と PM の分け方を計画が書いていない | S0 は測る所、PM が測る（§8） |
| D-AC05 | spec:1842（docs/specs/reconstruction-p0-contracts.md:1842 «bb8fc66481fec539»）の overlay は §8.6 の詳細の overlay の行で、周囲の概要矩形が不変・減光と下端の補正・時計とページの操作と緊急の大カードを隠さない、を求める | S0 分は AC13 (1)(2)。下端の補正とページの操作を隠さないの 2 つは C0（DS-OPEN-65、開いたカードの下端とページの表示）へ送る。押して上げたカードが緊急地震速報のカード（大カードを含む）の手前に出る形は、作者の裁定（2026-11-23 21:44・21:51、2026-11-24 20:54）による「緊急大カードを隠さない」の例外で、ユーザーが押した間だけ、緊急地震速報のカードの組が変われば戻る（DS-LAYER-21）。spec の本文は置き換えず AC13 (5) を真実源とする（Q-DS-SPEC-REVISION） |
| 詳細の応答 | http-sse.ts:414 の responseTooLarge の応答は、WireDetailResponse の union に無い（B0・B1 の型の欠け） | S0 では直さない。main.ts が 200・409 以外の応答と通信の失敗を `{ kind: "failed", reason }`（ShellDetailAnswer）に変えて渡す（表 §2.3、AC03 (5)）。詳細の取得と、200・409 以外の応答を failed に変える所と、log（reason "detailFailed"）は、最初に詳細を開くカードの契約（C0・C1）が main.ts に足す（S0 に呼び手が無い。統合担当の決め 2026-11-25 21:3x、r10-items.md の #11） |
| schemaVersion の字でない値 | spec:1391（docs/specs/reconstruction-p0-contracts.md:1391 «3f9c6bc381ec057b»）は schema の不一致で非対応を明示すると書き、字でない・無い値を分けていない | schemaVersion が字でない・無いときは外形が合わない側で、状態を変えない（数の schemaVersion は作り手から出ない〔wire の型は字の literal〕。統合担当の決め 2026-11-25 21:3x・21:5x、r10-items.md の #9）（表 §2.3、AC03 (2)） |
| 計画:114 の群 | DS-LAYER-03 は 1 つ目の群で spec :634 も作者の裁定 21:44 と書くが、40・379・718px は 21:44 の「」に無く DS-LAYOUT-05〜06 から来る。DS-OPEN-64 は 2 つ目の群だが、作者に聞かず統合担当の決め（2026-11-24 22:0x）で凍結した | §12 の 16 で計画の字を改める |

## 12. 配送で統合担当が原文を改める項

2026-11-26 の配送で当てた物と当てなかった物は JSON の questionResolutions の Q-DS-DELIVERY・Q-DS-SPEC-REVISION。

1. 計画:114 の S0 の行（reconstruction/contracts/p4-order-plan.md:114 «c38868f9bf244f45»）: 「1 つ目の群」に、凍結に入れた統合担当の決め・読み（§10）を足す。「2 つ目の群」の字を改める: DS-LAYER-06 の後半・15 と DS-OPEN-63 は 2026-11-24 20:54 の作者の確認つきで凍結へ移った（文 1・2・4）、DS-LAYER-18（20:46）・19 も凍結、DS-LAYER-09 の後半・16・21 と DS-OPEN-62 の形は作者の裁定 2026-11-25 07:0x（P4-DS-D-SECOND-GROUP=A）、DS-LAYER-23 の開かない所は同じ裁定（P4-DS-D-OPEN-WHILE-EEW=A）、DS-LAYER-20・22・23 の残りは統合担当の決め、D1 と見た目の 3 つは作者の裁定 2026-11-25 18:50 で A（P4-DS-D-READINGS）。凍結しないのは DS-LAYER-10・11、DS-OPEN-62 の値・65・67、DS-OPEN-75（S1・E0）。S0 の行を配送済みにする。
2. 計画:227（reconstruction/contracts/p4-order-plan.md:227 «d0b772e0ecc3ed64»）: P4-DS-D-MODULE-PATH=A を確定したら、directory の名前を `screen` に、「自分の部品の directory」を「`reconstruction/src/display/screen/` の自分の部品の file と cards.ts の 1 行」に改める。
3. 計画:91（reconstruction/contracts/p4-order-plan.md:91 «16c59b4b17071c38»）: 新しい画面の path が `/display` であることを書く。
4. 計画 §4.6 の「S0 の凍結時」の行: reconstruction/contracts/p4-order-plan.md:383 «d032ca260ac4d42b»（spec:167・:2959・:2961・:1688 を P4-PLAN-D-SCREEN の結果へ、Pi のブラウザの資源を予算に〔R52〕）、reconstruction/contracts/p4-order-plan.md:389 «f0d422374901263a»（spec:1845・:1847 に DS-LAYER-10 の例外）、reconstruction/contracts/p4-order-plan.md:394 «83949472d1d9ef02»（spec:1597〜:1624 の列の割当を D-TSUNAMI-COLUMN=C の結果へ）。改め方は計画の字のとおり。B1 の Q-DC-SPEC-REVISION と同じく spec の本文を変えずに本契約を真実源とする形もある（統合担当が決める）。〔本文を置き換えない形に決めた（統合担当の決め、Q-DS-SPEC-REVISION）〕
5. 計画:937 の S0 の着手ゲート（reconstruction/contracts/p4-order-plan.md:937 «dc576f762ca61a46»）: 発注前点検の問いは全部閉じた（Q-DS-COLUMN-FLOW は統合担当 2026-11-25 19:30、Q-DS-STATUS-WORDS は作者の裁定 2026-11-25 19:09。READINGS・MODULE-PATH・REPAGE-CAP・CARD-BOUND・OPEN-WHILE-EEW・SECOND-GROUP・CLOCK-SIX・FONT は閉じた）。
6. 表示設計 spec: DS-OPEN-48 は r3 で閉じた。DS-OPEN-62・63・64・65・69、DS-LAYER-06・09・15・16 の字と DS-LAYER-18〜23・DS-OPEN-75 の 7 行は 2 回目〜r2 に、分岐の裁定の後の出どころの字（:640・:662・:676・:690・:707・:709）と D1 の根拠（:706）と DS-LAYER-14・DS-PAGE-12 の出どころは r3 に当てた（済み）。READINGS の裁定（2026-11-25 18:50）の字は r6 で :636・:706 と契約に当てた（済み）。
7. `reconstruction/contracts/p4-persona-walk-tools3.json` の Q-PWT3-ROWS-FN（reconstruction/contracts/p4-persona-walk-tools3.json:323 «210bdb0a83dd3b3c»）: 関数は frame.ts の screenFrame、DOM はその値だけを描く（P4-DS-AC08）と書く。
8. `reconstruction/contracts/p4-display-capacity.json` の outOfScope の「host.ts の配線（新しい経路を製品で流すのは E0 発注 2）」と Q-DC-DELIVERY の remaining の「host の配線…は E0 発注 2 か S0」: S0 に改める。
9. spec:1855（D-AC18）の字を DS-CSS-02 の形に合わせるか（§11）。〔本文を置き換えない形に決めた（統合担当の決め、Q-DS-SPEC-REVISION）〕
10. DS（「FlEq 表示 D1 夜」）の README へ、次の版で写す: DS-LAYER-06 の後半・15 の出どころ（20:54）、DS-LAYER-18〜21・DS-OPEN-75 の新しい行（r6 で spec の :703〜:709 を版 40 の README の行〔:241〜:246・:268〕に付け直した）、DS-OPEN-62 の形（明るさを下げる）と 63・64 を閉じたこと、DS-OPEN-65 を C0 へ送ること、DS-OPEN-69 の条件（場面 22k）、README:234 の案の行（0.6・ずらしを当てる・向き）の改め。写したら spec の §0 の sha256 と、新しい 7 行（DS-LAYER-18〜23・DS-OPEN-75）の「README の行は無い」を改める。
11. E0 の起草: slot のカードの id は event ごとに 1 つ（続報で変えない）。DS-LAYER-21（D3）がこの id の組で緊急地震速報の組の変化を見るため。
12. S1・E0 の起草: DS-OPEN-46・75 を決めたら、本契約の DS-LAYER-23（左の列に緊急地震速報のカードがある間は開かない）を契約の改訂で改める。DS-LAYER-22 の 1 文目の「開いたカード」の所は DS-LAYER-23 で改めた（spec の :708 は変えていない。DS の次の版で写すときに 1 文にまとめる）。
13. 計画:114 の 2 つ目の群の字は、P4-DS-D-SECOND-GROUP の作者の確認の後に改める（1 の字はそれまで当てない）。
14. 各カードの契約: 登録の max は自分の source の作りで決まる数にし、source が max を越えないことを自分の試験で示す（S0 は越えたときの診断までを持つ、P4-DS-D-CARD-BOUND=A）。
15. D-AC05（spec:1842）: 押して上げたカードが緊急地震速報のカード（大カードを含む）の手前に出る形を、作者の裁定（2026-11-23 21:44・21:51、2026-11-24 20:54）による例外として書く（ユーザーが押した間だけ、組が変われば戻る、DS-LAYER-21）。下端の補正とページの操作を隠さないは C0（DS-OPEN-65）。〔本文を置き換えない形に決めた（統合担当の決め、Q-DS-SPEC-REVISION）〕
16. 計画:114 の群の分け方: DS-LAYER-03 の 40・379・718px は DS-LAYOUT-05〜06 から来ると書く。DS-OPEN-64 は 2 つ目の群から統合担当の決め（2026-11-24 22:0x）へ移したと書く。
17. §12 の 1・2・3・7・9・18 が書き換える行を引く本契約の «» 9 本（計画 :114 が 3 本、:227 が 2 本、:91、:124〔この節の 18〕、p4-persona-walk-tools3.json:323、p0-contracts:1855）を、書き換えの後に付け直す。〔配送で付け直した数は Q-DS-DELIVERY の (3)〕
18. 計画の C0 の行（reconstruction/contracts/p4-order-plan.md:124 «a8d42a2d3348eb19»）: 詳細の取得と、200・409 以外の応答を failed に変える所と、log（reason "detailFailed"）は、最初に詳細を開くカードの契約（C0・C1）が main.ts に足す、の受けを書く（統合担当の決め 2026-11-25 21:3x、r10-items.md の #11）。
19. S1 の起草: 開いている間の左の列の pageCount は、開いたカードを外した割りのページの数。その送りの受け方は S1 が決める（統合担当の決め 2026-11-25 21:3x、r10-items.md の #16）。
20. 各カードの契約（C0・T0 ほか）: 形を選ぶカード（形が 2 つ以上・null でない maxPages・2 以上の minBodyRows・mayHide）は左の列の take がいちばん後ろの 1 枚（今日の地震）だけ（AC05 (7)(h)）。ほかに要る契約は、その契約で (h) と形の選び（layout.ts の choose）を広げる。津波の小さい形（docs/specs/reconstruction-display-design.md:540 «032bc9d035afefb1» が T0 へ送った字）は、津波が先に高さを取るので今の順では使われず、T0 が扱いを決める。本文のある形の minBodyRows は 1 以上（(i)）。計画の C0・T0 の行に配送で書く。

## 13. 確かめた所（起草時に開いた行）

- `reconstruction/src/host/host.ts`: :1〜:22（import）、:88〜:101、:176〜:182、:195〜:203、:511〜:538、:586〜:641、:664、:684〜:685。`reconstruction/test/briefing-unit/briefing-host.test.ts` の startP2Host の起こし方（:107・:127〜:141）。他の契約の «» が引く host.ts の行は `git grep` で数えた。
- `reconstruction/src/display/chrome-eew/`: main.ts の :1〜:12、index.html の :95〜:101、pure.ts の :385〜:418、tsconfig.json の全部。
- `reconstruction/src/http-sse/http-sse.ts` の :359〜:372 と、索引（作業ノートの s0-citations.md §3・§8）が file:行と anchor を書く行。`composition-root.ts` は :143 と :992（索引）。
- `reconstruction/tsconfig.json` の全部、`.github/workflows/test.yml` の :80〜:90、`test-windows.yml` の :44〜:52、`AGENTS.md` の :16。
- `reconstruction/contracts/p4-display-wire.types.ts` の :1〜:30・:90〜:100・:128〜:172・:244〜:250、`p2-weather-timeseries-unit.types.ts` の :172〜:182、`http-sse.ts` の :33・:209・:391、`p4-persona-walk-tools3.json` の :318〜:340、`p4-display-capacity.json` と表の file。
- 本表と契約が引く «» は、起草の道具で今の木の行の中身と 1 行だけの一致を確かめた（2 回目は DS spec の 11 行を改めたので全部を数え直した）。
- 2 回目: 作業ノート（.tmp-s0/s0-prework.md）の :556〜:574（20:46・20:50・20:54）、DS spec の :7・:586・:637〜:705。3 回目: DS spec の :706・:707（足した行）。

## 14. r1 の対応（r0 へのヘルツの独立レビュー〔NO-GO、P1 1・P2 11・P3 1〕と統合担当の決め 2026-11-24 21:4x）

| 指摘 | 確かめた行 | 対応 |
|---|---|---|
| 1 開いたカードが下がった緊急地震速報の 96px を消す | 表 §3.1 の 6・7（r0） | 直した。§3.1 の 7、L15、AC06 (7)、T11 |
| 2 間を押したときの相手 | 表 §3.1 の 3・9、§5.1（r0） | 直した。§5.1、§3.1 の 11、AC07、T04 の点の組 Q1〜Q8 |
| 3 開いた今日の地震が消えても開いた状態が残る | 表 §5.1（r0） | 直した。sync の openable、AC07 (10)、T12 |
| 4 描く前の合流が D3 を落とす | 表 §2.6（r0） | 直した。§2.6、§5.2、AC16 (4)、T12 |
| 5 SSE の event の名前 | http-sse.ts:161 の `event: snapshot`、chrome-eew/client.ts:17 | 直した。§2.6、AC03 (1)、T10 (e) |
| 6 停止の前の例外と並行した closeDisplay で保留が消える | http-sse.ts:258〜:260、host.ts:606〜:610・:633〜:640 | 直した。§6 の :606、AC02 (6)、T09 (d) |
| 7 凍結の根拠 | 契約の Q-DS-SECOND-GROUP、spec の DS-LAYER-09・16・62 | 直した。P4-DS-D-SECOND-GROUP、§10、§3.1 の 3 |
| 8 最上層 7 枚の上限と費用 | 契約の P4-DS-RES-01、表 §3.1 の費用 | 直した。§3.1 の費用、§4.3、RES-01 |
| 9 T11 は正しい割りで落ちる | 表 §3.2・L11（r0） | 直した。T11 は placeLayers、AC13 (1) |
| 10 どのページにも載らない合法な行 | 表 §4.1（r0） | 直した。§4.1 の入力の条件、AC05 (7) |
| 11 遅れて届いた旧い応答 | http-sse.ts:413（応答に streamId） | 直した。§2.3、AC03 (5)、T05 |
| 12 ページの表示と urgent の検収 | 表 §4.2、契約の T03・T09 | 直した。P7〜P9、T03、T09 (b) |
| 13 削れる所 | 型の openFront・passes、T01 | 直した。openFront・passes・ShellHit を外し、T01 を T10 へ寄せた |

## 15. r2 の対応（r1 へのヘルツの再確認〔NO-GO、残り 8・14〜17〕と統合担当の決め 2026-11-24 22:0x）

| 指摘 | 対応 |
|---|---|
| 8 再割りの 2 乗の費用 | 登録の max で列のカードの数の上限 K を作り（P4-DS-D-CARD-BOUND=A）、組み直しを K＋1 回まで、費用を行の数×形の数×（K＋1）にした。組み直しは行の中身が変わった frame だけ〔r4 で AC08 (12) の入力の全部の一致に改めた〕（§2.4・§4.3、AC05 (6)(8)、RES-02） |
| 14 ずらした緊急地震速報の間に覆いが残る | 組を作らない形で止めた。最上層の緊急地震速報のカードがずれるのは開いたカードに覆われたときだけで、DS-LAYER-23 で開いている間は左の列に緊急地震速報のカードが無く、右の列のカードは開いたカードと重ならない。最上層の緊急地震速報は宣言値の場所から動かないので、間は宣言値のままで正しい（§3.1 の 7・11、AC06 (7)） |
| 15 同期の後に旧い frame を押す | frame に shell を持たせ、今の state と同じ object でなければ押下は効かない（R2、§5.2 の 1 行目・S6、AC07 (0)、T12 (e)） |
| 16 mark が画面へ届かない | screenFrame が mark を ShellDrawCard の mark へ渡す形に決めた（右の列は最後の行・点あり、左の列は今日の地震の見出し・点なし。§2.4、AC08 (10)、T06 (g)、T10 (e)） |
| 17 本文の無い形の head | head だけで列の高さ以下を独立の入力の条件にした（§4.1 の (a)、AC05 (7)） |

## 16. r3 の対応（r2〔915ca317〕へのヘルツの 3 巡目と契約適合レビュー、作者の裁定 2026-11-25 07:0x）

| 指摘 | 対応 |
|---|---|
| ヘルツ 18 割りの使い回しの条件に place・take が抜ける | 条件を「paginateColumn の入力の全部が同じとき」にした（§2.4、AC08 (12)、T06 (h) に place を入れ替えた前後の配置） |
| 適合 P2-1 起草の読みが確定も分岐も無く凍結 | 統合担当が 2026-11-25 07:05 に 8 件を確定（§10）。見た目の 3 つと D1 は P4-DS-D-READINGS |
| 適合 P2-2 D1 の記録の食い違い | Q-DS-SWAP-HOLES を改め、契約と spec :706 の根拠を「版 13 の箇条と図 sp-23k で作者に見せた」にした。D1 は READINGS |
| 適合 P3-3 ずれて出た所を押しても閉じるだけを 19:49 の裁定と書いた | 版 10 の箇条の統合担当の決めと書き、SECOND-GROUP=A で凍結（§5.2、AC07 (6)） |
| 適合 P3-4 OPEN-WHILE-EEW の reason の「」 | 「」を外し「21:44 に作者が推奨で受けた問い 2」とした |
| 適合 P3-5 D-AC05 | AC13 に S0 分と C0 へ送る 2 つと例外を書いた（§11、§12 の 15） |
| 適合 P3-6 計画:114 の群の分け方 | §11 と §12 の 16 |
| 適合 P3-7 §12 の改め方 | §12 の 1・5・6・10 を改め、15〜17 を足した。spec の出どころの字は r3 で当てた |
| 適合 P3-8 縮め方の試験 | T10 (f) |
| 適合 P3-9 observer・canvas・旧 full.view | AC11 (1)、AC09 (1)、T08 |
| 適合 P3-10 409 以外の詳細の応答 | failed と ShellDetailAnswer（AC03 (5)、T05、§11、Q-DS-STATUS-WORDS） |
| 適合 P3-11 古い字 | §0、§7.1、§2.3、§2.4、§10、CLOCK-SIX・FONT の kind、artifactRequirements、AC14、時刻の日付 |

## 17. r4 の対応（r3〔04ad088b〕へのヘルツの 4 巡目〔NO-GO、18 の直し残りと 19〕）

| 指摘 | 対応 |
|---|---|
| 18 AC05 (6)・表 §4.3・RES-02 に古い「行の中身が変わった frame だけ」が残る | 3 か所とも AC08 (12) を指す字にした。条件の字は AC08 (12) と §2.4 だけに書く |
| 19 詳細の failed が frame へ届かない | frame.status に failed の札を入れる条件と順（版が合わない方が先）を §2.4・AC10 (3)・AC08 (5) に書き、T06 (j) に failed → detailRequested・refetch で消える境界を入れた |
| 突き合わせ | 同じ決まりの場所を数え直し、型の欄の作る所・読む所・試験を数えた。ShellColumnPages の column は誰も読まないので外した。T06 (a)(c)(k) と T10 (a) に、試験の無かった欄（map・marks・pageCount・shellSync の出力・token の class）を入れた |

## 18. r5 の対応（r4〔7c743b51〕の同じ決まりの場所の突き合わせと統合担当の決め 2026-11-25 07:2x）

| 番号 | 対応 |
|---|---|
| 1a shellSync の集め方 | 集め方を §2.4 に 1 か所書き、screenFrame（AC08 (3)(5)）と shellSync（AC16 (4)、T06 (k)、型の ShellEvent のコメント）がそこを指す |
| 1b 当てる時 | 「採るたび」に揃えた（型の ShellEvent のコメント） |
| 3a・3b D1 | D1 は全部 P4-DS-D-READINGS。READINGS の 4 つ目を「版 13 の図 sp-23k の形」にし、§3.1 の 4・8、§5.4 の S1、§5.5、§10、契約の SECOND-GROUP の reason を合わせた。D2 は統合担当の決めのまま |
| 3c Q-DS-R1-REVIEW の 1 | 履歴の字だと分かる注を付けた |
| 3d 下がったカードのずらす向き | AC06 (7)、§3.1 の 7 |
| 4a ページの表示の字の形 | §4.1 の 11 と §4.4 を、点の描き方だけが未決の字にした。Q-DS-COLUMN-FLOW に点の描き方を足した |
| 5a allowedPaths の行の一覧 | :91・:606 を足した |
| 5b 停止の前の例外 | T09 (d) |
| 6a 同じ入力から同じ結果 | AC05 (7) で入力の条件から外し、結果の性質に置いた（§4.1 も同じ） |
| 6b open と左の列の緊急地震速報 | AC06 (10)、§3.1 の 11 |
| 詳細の failed の 3 つ | 変換は main.ts だけ、ready・refetch・failed の決め方、引数の名前 answer を §2.3 と AC03 (5) に同じ字で書いた |
| 古い字 5 か所 | §7.3、outOfScope と artifactRequirements の FONT、§8 の E04 の mark、§8 の T08 の行 |

## 19. r6 の対応（r5〔2a785dcc〕へのヘルツの 5 巡目〔指摘 20〕、作者の裁定 2026-11-25 18:50、spec の字）

| 項 | 対応 |
|---|---|
| 指摘 20 時計へ渡す件数 | clockRect の入力を「frame に置いた緊急地震速報のカードの枚数（frame.eew.length、最大 6）」と、§1.2・§2.2・§2.4・AC04 (3)・AC13 (2)・publicFunctions・型の ShellFrame のコメントに同じ字で書いた。T06 (l) に 7 枚の入力を足した |
| P4-DS-D-READINGS | 作者の裁定 2026-11-25 18:50 で A（作者の言葉「判断事項については、すべて推奨で進めてください。」）。確認待ちの字を裁定済みの字に直した（条文の形・数・条件は変えない） |
| spec の字 | :36・:537・:611・:630・:634・:636・:638・:660・:663・:703〜:709 と、README の行番号（版 40 で :241 より後が 6 行ずれた）を当てた。spec §0 を DS 版 40（2026-11-25 18:56 に送った、Artifact の側の 43、1795600621-e081）の版の字と 5 file の sha256 に改めた（:7・:9・:16〜:38・:580〜:582・:586） |

## 20. r7 の対応（発注前点検の Q-DS-COLUMN-FLOW の細部、統合担当の決め 2026-11-25 19:07）

| 項 | 対応 |
|---|---|
| a〜f・P7 | AC05 (2)(4)(5)(7)(9)(10)、AC08 (11)、AC04 (1)、表 §1.1・§2.4・§4.1・§4.2・§4.4、型のコメントに同じ字で書いた。T03 に P10 を足し、P7・P8 の期待を改めた |
| 突き合わせ | §4.5（5 場面とも b の決まりで合う。ページの数は実測待ち） |
| Q-DS-COLUMN-FLOW | 1 回目は requiredEvidence をページの数の確かめだけに縮め、細部は Q-DS-COLUMN-FLOW-DETAILS に書いた。続きで、c の上の間を統合担当の決め 2026-11-25 19:12で PAGE_MARK_GAP 8 にし、行の高さの実測（sp-rows.md）との突き合わせを §4.5 に書いた。行の並びが sp-rows.md に無く、右の列の p2〜p12 と左の 2 場面の行の数は照らせなかったので閉じていない。§4.2 の P8・P9 は 45.5 を数えた数（3 ページ・9 ページ）にした |
| spec | DS-PAGE-11・DS-PAGE-12 の字と、末尾に DS-OPEN-76 |
| Q-DS-STATUS-WORDS | 作者の裁定 2026-11-25 19:09で閉じた。「受け取った情報を表示できません」と「詳細を表示できません」を AC03 (5)・AC10 (3)・AC14・T06 (a)(j)、§0・§2.3・§2.4・§10・§12 の 5 に同じ字で書いた |

## 21. r8 の対応（ヘルツの指摘 21・22、spec §0 を DS 版 41 に）

| 項 | 対応 |
|---|---|
| 21 | 入力の条件 (e)（列ごとの合計、統合担当の決め 2026-11-25 19:29）を AC05 (7)・表 §4.1・§4.4 の g に同じ字で書いた。mayHide のカードは前の和に入れず、後の和に入れた（§4.4 の g） |
| 22 | §4.2 の P10 の Q の高さを 590 にした（686 に head と 5 行の 590）。P1〜P9 を条文どおりに数え直し、数は合っていた。P1〜P3 のカードを mayHide に、P4〜P6 の A を本文の無い形にした（前の字は左の列で本文を持つ形が mayHide でなく、入力の条件 (d) を破っていた） |
| spec §0 | DS 版 41（2026-11-25 19:24 に送った、Artifact の側の 44、1795602261-396f）に合わせ、sha256 の 3 行と、今の真実源を版 40 と書いた字を改めた。§15 の頭に版 41 で写した 2 つを書いた |
| 割り直しの結果 | §4.5 を子 s0-conform の割り直し（.tmp-s0/q-ds-redivide.md）の結果に書き直し、Q-DS-COLUMN-FLOW を閉じた（統合担当 2026-11-25 19:30）。発注の条件は baseOid の割り当ての後にした |
| 固定と表示の行 | AC05 (6)・表 §4.1 の 3・§4.3 に固定した高さを当てる先を、AC05 (10)・表 §4.1 の 8・§4.4 の c に表示の行を数えるかの決め方を書いた（統合担当の決め 2026-11-25 19:30） |
| 19:34 の決め | (e) の後の和に mayHide のカードの本文の無い形を入れる起草の字を確定し（表 §4.4 の g）、入力の条件 (f)（mayHide のカードは take がいちばん後ろ）を AC05 (7)・表 §4.1・§4.4 の h に書いた（統合担当の決め 2026-11-25 19:34）。§4.2 と §4.5 の 5 場面の入力は (a)〜(f) を満たす |
| 19:36 の決め | 割りの上限を「数えない割り 1 回＋2 ページ以上の列の固定の組み直し K＋1 回、合わせて K＋2 回」にし、AC05 (6)(8)・P4-DS-RES-02・表 §4.1 の計算量の行・§4.3 に書いた。数えて割り直して形が移り 1 ページになったときは、その結果を使い表示は出さない、を AC05 (10)・表 §4.1 の 8・§4.4 の c に書いた（統合担当の決め 2026-11-25 19:36）。T03 に上限の回数を見る項は無い〔回数と費用の字は r10 で改めた。今の字は §4.3〕 |

## 22. r9 の対応（ヘルツの指摘 23）

| 項 | 対応 |
|---|---|
| 23 | 形の選び（AC05 (3)、§4.1）に、本文のどの行も新しいページの残りの高さに入る、という 4 つ目の条件を足した（統合担当の決め 2026-11-25 20:04。作者の字ではない）。無いと、1 行目は入り 2 行目がどのページにも入らない mayHide のカードで、割りが終わらないか AC05 (7) の「本文の行はちょうど 1 つのページ」を破る。§4.2 に P11（ヘルツの例）を足し、T03 に入れた |

## 23. r10 の対応（実装のレビュー 3 巡と統合担当の決め 2026-11-25 21:04〜22:0x。作者の字ではない）

項の番号は作業の file（.tmp-s0/r10-items.md、git に入らない）の番号。出どころのレビューの全文は .tmp-s0/hertz-impl-r1.md〜r3.md（git に入らない）。「21:3x」「21:5x」「22:0x」は、その一覧と依頼に書いてある時刻の字。ここの番号と、§14〜§22 の契約のレビューの「ヘルツの指摘 N」は別の番号。

| 項 | 対応 |
|---|---|
| #1・#4 | 回数: k と K を分け、数えない割り 1 回＋数える割り 1 回＋固定の組み直し k 回＝k＋2 回（K＋2 回以下）。止めるかの比べは数える割りどうし（AC05 (6)、P4-DS-RES-02、§4.3。§21 の 19:36 の行に注） |
| #2 | 同じカードの組は、そのページに並ぶカードの id の列（AC05 (5)(6)、§4.1 の 2・3、§4.3） |
| #3 | place の順に詰める＝前のカードの本文が全部置き終わってから次。固定した高さは max（AC05 (4)、§4.4 の a） |
| #5 | 入力の条件を破る入力でも割りは止まる（AC05 (7)、§4.1） |
| #6 | 費用の式（AC05 (8)、P4-DS-RES-02、artifactRequirements、§4.1、§4.3） |
| #9 | schemaVersion が字でない・無い（AC03 (2)、§2.3、§11） |
| #10 | 詳細の分野の unit が無いときも refetch（AC03 (5)、T05、§2.3、型のコメント） |
| #11 | 詳細の取得・failed への変換・log は最初に詳細を開くカードの契約（AC03 (5)、outOfScope、§2.3、§11、§12 の 18、型のコメント） |
| #12 | closeServer の flush が書くのは詰まっていない client まで（AC02 (6)、§6） |
| #13 | 暦に無い日付・24 時は「時刻不明」（AC09 (3)、T07、§2.5） |
| #14 | mark の名前と直近 64 版（AC12 (1)(3)、P4-DS-RET-03、§8） |
| #15 | 行の token とカードの線 2px（AC08 (12)、AC09 (1)、AC13 (3)、§2.1、§2.4、§9） |
| #16 | 開いている間の左の列の pageCount と入力の条件 (g)（AC05 (7)、AC07 (7)、§2.4、§4.1、§4.5、§5.2、§12 の 19、型のコメント） |
| #17 | ページの番号を外から替える公開物は置かない（AC01 (6)、§9） |
| #18 | LAYOUT に足した値（AC04 (1)、§1.1） |
| 当てていない #7・#8・P12・P13 | r10 では Q-DS-FORM-FIT（作者の裁定待ち）に置いた。r11 で閉じた（§24） |

## 24. r11 の対応（Q-DS-FORM-FIT）

| 項 | 対応 |
|---|---|
| Q-DS-FORM-FIT | 作者の裁定 2026-11-26 06:45「判断についてはA(判断カードでのAダッシュ)で進めてください。」（判断カード「列の割りの形の選び」の A′）。入力の条件 (h) を足した（AC05 (7)、§4.1、§4.4 の i、§4.5）。コードの形の選びは 9e240899 の形へ戻した。P12・P13 とヘルツの 3 枚の例は (h) の外で、T03 は P1〜P11 のまま。乱数の証拠（.tmp-s0/conform/card2.mjs、git に入らない、2026-11-26 06:48 に r11 のコードの写しで）: (h)(i) を満たす入力 12 万組×3（seed 5・77・2026）で、形の条件の違反 0・余計に消したカード 0・余計に後の形 0・AC05 (7) の性質の違反 0。同じ数え方で、右の列にも形を選ぶカードを 1 枚許す入力（(h) の外）では余計に消したカードが出る |
| #8 | 入力の条件 (i)（統合担当の決め 2026-11-26 06:47） |
| 統合担当の字 | AC05 (7) の性質に、出した mayHide のカードの maxPages と minBodyRows を足した（T03 の試験が見ている性質）。AC05 (10)・§4.1 の 8・§4.4 の c の「形の選びが別の形へ移って 1 ページになる」は、(h) の下では起きないと書いた |
| 4 巡目のレビュー（5cfbd2fa、ヘルツ GO・契約適合 条件付き GO、どれも P3） | 2026-11-26 06:58 の統合担当の決め: AC05 (10) の「ページの数は減らない」を「1 ページにはならない」に（ヘルツ 1）。形の選びの 4 つ目の条件に、1 行目の continuation は数えないと書いた（コードは 9e240899 から同じ、適合 1）。frame.test.ts の (d) の side を本文の無い形に（AC05 (7)(d) を満たす入力、適合 2）。(h) の出どころの字（適合 3）、§12 の 20 と型のコメント（適合 4）、P12・P13 の入力の置き場（適合 5）。製品のコードは変えていない |
