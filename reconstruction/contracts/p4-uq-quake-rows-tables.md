# P4-UQ-QUAKE-ROWS-001 の設計の表 r1（今日の地震の材料を新しい経路に足す）

- 起草: 2026-11-26 17:33（date の値。起草の子 r0）。基点 e5e65ac5cc817815eef1d69203a3d56f3dfc0225（branch draft/p4-uq-quake-rows）。行番号と anchor はこの HEAD の値。r1（2026-11-26 夜）は r0（9ff3cade）へのヘルツ（品質、NO-GO: P1 1・P2 6）と契約適合の子（条件付き GO: P2 2・P3 6）の指摘を統合担当がまとめた直し 11 件を当てた（対応は §11）。
- 範囲の元: 計画 reconstruction/contracts/p4-order-plan.md:124 «81df930d148e1b35»（C0 の依存の字）・reconstruction/contracts/p4-order-plan.md:192 «7fb74ce4b983f6c1»（Wave 2 の直列）・reconstruction/contracts/p4-order-plan.md:223 «a604c88e73f7fd83»（display-wire.ts の直列）・reconstruction/contracts/p4-order-plan.md:225 «ed4c1d57134bc802»（seismic-unit.ts の直列）。
- 作者の裁定は 2 つだけ（9 行を選ぶ母集団 P4-UQR-D-EDGE は作者待ち、§2.10）: A17（区分ごとに 9 行）と B4（発生の新しい順、上限の行を残すときも同じ順）。2026-11-26 15:06 の発言「作業お疲れ様です。地震・対応表ともに判断事項は全て推奨で進めてください！」を、判断カード `2026-11-26-P4-今日の地震の行の数と並び.md`（repo 外）の末尾「裁定」が A17・B4 の推奨と読んだ。ほかの決めは decisionBranches の統合担当の案（起草の子が置いた案、裁定前）。
- 範囲外: コードから札の字への対応と、深さの字（「以上」「未満」・欠け・読めない座標）。どちらも画面が変わる未裁定の問いなので §7 に C0（P4-STANDBY-CARDS-001、未起草）への問いとして書く。

## 0. 結論

- 行の数: unit の `RECENT_LIMIT` を 5 から 9 にする（A17）。区分ごとに数える形は変えない。wire は 3 区分を繋ぐだけなので最大 27 行。
- 行の並び: unit の当日履歴の recent を、発生の時刻の新しい順に並べる（B4）。受けるたびに「その地震を除いた行＋作った行」を並べ直し、先頭の 9 行を残す。9 行より古い地震は入らず、新しい行を押し出さない。並べる所は unit の 1 か所だけで、wire は並べ直さない。
- 津波のコード: unit の行に `tsunamiCodes`（4 桁の数字のコード、電文の順に最大 4 個）と `omittedTsunamiCodes`（落とした数）を足し、wire の行にそのまま載せる。保存の行の欄が増えるので、保存の版を v9 から v10 に上げ、復元で行の数・並び・EventID の一意を確かめる。
- 深さの「以上」: unit の行は今も深さの `range` と `bound` を保存している（reconstruction/src/units/seismic/seismic-unit.ts:411 «3b9428840ba7f607»）。wire が生の字だけを写しているので、wire の行に `depthBound`（"lower"・"upper"・null）を足す。保存は変わらない。
- 容量: 新しい欄込み・区分ごとに 9 行で、U-Q の型の最大は 77,279 byte、保護 3 分野（組 A短）は 202,669 byte で 262,144 に余り 59,475。M5 の導いた組は 1,911 公開で 1 MiB を越え、要約になるのは U-F だけ、収まらない公開は 0（§5）。依頼の止める条件には当たらない。

## 1. 今の材料と、どこが読むか

| 読む所 | file:行 | 今の振る舞い | 本契約で変わるか |
|---|---|---|---|
| 行の上限 | reconstruction/src/units/seismic/seismic-unit.ts:54 «5b20638b16ebc429» | `RECENT_LIMIT = 5` | 9 にする（行の中） |
| 今日の判定 | reconstruction/src/units/seismic/seismic-unit.ts:470 «5c9502c91a40cd3b»・reconstruction/src/units/seismic/seismic-unit.ts:471 «bd30394a2ae65b0a» | 発生時刻（無ければ報の ReportDateTime）が受信日と同じときだけ行に入れる。読めなければ入れない | :470 の発生時刻を :416 の boundTime を通した字にする（D-KEY=A。判定と並びの鍵を同じ字にそろえる） |
| 行の時刻の欄 | reconstruction/src/units/seismic/seismic-unit.ts:416 «8381eb3e8dd350c6»・reconstruction/src/units/seismic/seismic-unit.ts:476 «ae5d7bf973b11c83» | 発生時刻・報の時刻は 40 字を超えると null。報の時刻は行を作り直した報（最後に採った報）の値 | 変えない。並びの鍵はこの 2 つの欄から作る（§2.1）。報の時刻は受理が 25 字以内に限る（seismic.ts:58・:66）ので null にならない |
| 行を作る所 | reconstruction/src/units/seismic/seismic-unit.ts:479 «b81c845945742c8e» | 津波は評価の文だけ（VXSE52・VXSE53 の文、VXSE51 は null）、128 字で切る | 同じ所でコードの組を足す（§2.3） |
| 行を入れて切る所 | reconstruction/src/units/seismic/seismic-unit.ts:481 «5a0c6b63f1545473» | 作った行を先頭へ入れ、先頭の 5 行を残す（最後に受けた順） | 並べ直して先頭の 9 行を残す（§3） |
| 公開事実の津波の欄 | reconstruction/src/units/seismic/seismic-unit.ts:246 «142e88a6b31d85cb»・reconstruction/src/units/seismic/seismic-unit.ts:250 «7ecce1cc8e4edafa» | VXSE53・VXSE52 の新しい方、どちらも無ければ VXSE51 の寄与の固定付加文（コードの組と文） | 変えない。コードの組はこの寄与から取る |
| 固定付加文の受理 | reconstruction/src/domains/seismic/seismic.ts:188 «ad38c48131d2f23d» | Code の字を空白で割った全部の字。件数・字の形の上限は無い | 変えない。行に写すときに上限を当てる（§2.3） |
| 深さの受理 | reconstruction/src/domains/seismic/seismic.ts:165 «7572b73b89c45980»・reconstruction/src/domains/seismic/seismic.ts:167 «a8792c11809bf6f1» | description の「深さ N km 以上」は range lower、「未満」「以下」は range upper（2 つを区別しない）。数と食い違えば number のまま（depthConflict） | 変えない |
| 行の復元 | reconstruction/src/units/seismic/seismic-unit.ts:1599 «1ae058f5aa3719d2»・reconstruction/src/units/seismic/seismic-unit.ts:1617 «4d5976ed5fdb24ce» | 欄ごとに字の長さと形を確かめる。行の数は `RECENT_LIMIT` まで | 新しい欄と、行の並び・EventID の一意を確かめる（§2.6）。:1617 は他の契約が引くので変えず、:1614〜:1616・:1618〜:1620 の行の中に置く |
| 保存の版 | reconstruction/src/units/seismic/seismic-unit.ts:36 «c896f909a2139054» | p3-seismic-unit-v9 | v10（§2.6） |
| 保存の予算 | reconstruction/src/units/seismic/seismic-unit.ts:59 «61c045e083c85ef2»・reconstruction/src/units/seismic/seismic-unit.ts:63 «8cb830971ba4bd10»・reconstruction/src/units/seismic/seismic-unit.ts:69 «ebda797d76ae3016» | 当日の行に足した欄（B0）の増え `RECENT_GROWTH` が `MEMORY_GROWTH` を通って `GENERATION_LIMIT`・`RESERVE_BYTES` に入る。元の 5 行の欄は `283_209` の中（1 行 1,206 byte、1 字 3 byte） | :58〜:59 の行の中だけを変える（§4）。:63・:69 は変えない |
| wire の行 | reconstruction/src/view-projector/display-wire.ts:490 «0d89ea8c93445cb0»・reconstruction/src/view-projector/display-wire.ts:491 «0fd4e5e595d753ab» | 深さは生の字だけ（`valueText(rawOf(row.depth), null)`）、津波は文だけ | `depthBound`・`tsunamiCodes`・`omittedTsunamiCodes` を足す |
| wire の行の列 | reconstruction/src/view-projector/display-wire.ts:501 «015b54c047b5fe26» | 通常・訓練・試験の順に各区分の recent を繋ぐ。上限の定数は無い（15 は `RECENT_LIMIT`×3 から出る） | 変えない（最大 27 行になる） |
| 新しい経路の上界 | reconstruction/src/view-projector/display-wire.ts:544 «200e4e54f06f0a6b» | `NEW_PATH_FIXED_BOUND = 377_434`（9 分野の和がこれと合わせて 1 MiB に届かない間は全体を数えない近道） | 399,277 にする（§5.1）。下回ると近道が 1 MiB 越えを見落とす |
| 型 | reconstruction/contracts/p3-seismic-unit.types.ts:158 «1e8bf8f982e918f6»・reconstruction/contracts/p4-display-wire.types.ts:77 «6268402a8543ac81» | SeismicRecentQuake・EarthquakeRowWire | 行の中で欄を足す |
| 旧の経路の view | reconstruction/src/view-projector/view-projector.ts:463 «8c56caf1e30c6a7c» | U-Q の view の daily（recent を含む）を full の固定の部分として数える | 旧の /events の行の数と欄は D-LEGACY で決める（§6）。並びはどちらの案でも発生の新しい順 |

- `daily.recent` を読む所は、reconstruction/src の grep（`\.recent\b`・`recent\[`）で seismic-unit.ts のほかに display-wire.ts:501 だけ。reconstruction/src/cli・reconstruction/src/terminal に `daily` を読む行は無い（grep）。端末の画面は変わらない。

## 2. 決めること（統合担当の案。どれも裁定前）

### 2.1 並びの鍵（D-KEY）

| 案 | 中身 | 起きること |
|---|---|---|
| A 行の保存した欄から作り、今日の判定も同じ字にそろえる（推奨） | 鍵は `Date.parse(originTimeRaw ?? reportDateTimeRaw)`（行の欄、読めない値は最も古い扱い）。:470 の今日の判定も `boundTime(view.originTimeRaw) ?? 報の時刻` にする（40 字を超える発生時刻は、判定でも鍵でも無いものとして報の時刻を使う） | 鍵が行の欄だけで決まるので、復元の後も同じ順で、判定と鍵が食い違わない。発生時刻の無い行は、採用した報の時刻の位置へ動く（続報のたびに動く）。40 字を超える読める OriginTime の報は、今は発生日で判定するが、本契約の後は報の日で判定する（test/fixtures の OriginTime は最長 25 字で、この形は無い） |
| B 行に並びの鍵の数を保存する | 行を作るときの `origin`（:470 の値、40 字で切る前の字の ms）を新しい欄に持つ | 保存の欄がもう 1 つ増え、予算の式と decode の確かめも増える。40 字を超える発生時刻でも今日の判定と同じ値で並ぶ |

- 無いと何が壊れるか: 鍵が決まらないと B4 の「発生の新しい順」を unit が作れない。
- r0 の A は鍵だけを行の欄から作り、判定は 40 字で切る前の字のままだった。40 字を超える読める OriginTime の報は判定を通るのに保存の欄が null になり、報の時刻で並んで崩れる（ヘルツ P2）。r1 は判定を鍵の字にそろえた。
- A の根拠: test/fixtures の OriginTime は最長 25 字（例 `2026-11-26T10:00:00+09:00`、grep で数えた）で、40 字を超える形は無い。発生時刻の無い行は、OriginTime の無い VXSE61・VXSE53・VXSE52 と TargetDateTime の無い VXSE51 だけの地震（:235〜:236 の originOf）。

### 2.2 同時刻の順（D-TIE）

| 案 | 中身 | 起きること |
|---|---|---|
| A 時刻に直して比べ、同じ値は EventID の字の降順（推奨） | 鍵は ms の数。同じ ms なら EventID を UTF-16 の字の順で比べ、大きい方を上 | 順が行の集合だけで決まる（受けた順に依らない）。`+09:00` と `Z` の書き方の違う同じ時刻も同時刻になる |
| B 生の字で比べる | 発生時刻の字の降順 | 時差の書き方が違うと同じ時刻が別の位置になる |
| C 同じ値は後に受けた方を上 | 安定な並べ替えで新しい行を同時刻の先頭へ | 訂正のたびに同時刻の中で先頭へ動く（行の中の地震の訂正で位置が変わる） |

### 2.3 津波のコードの形（D-CODES）

| 案 | 保存と wire の形 | 1 行の byte（保存、escape の最悪の上限） |
|---|---|---|
| A 4 桁の数字のコードを電文の順に最大 4 個、外れた字と 5 個目からは数だけ（推奨） | `tsunamiCodes: string[]`（各 `^\d{4}$`、0〜4 個）・`omittedTsunamiCodes: number`（0 以上の安全整数）。strongest と omittedStrongest と同じ形 | ＋84 |
| B 最大 8 個（数を持たない） | `tsunamiCodes` だけ。9 個目からと形の外れた字は黙って落ちる | ＋73 |
| C Code の字を 1 本のまま（32 字で切る） | `tsunamiCode: string \| null` | ＋209 |

- 無いと何が壊れるか: コードが wire に無いと、C0 は札（DS-QROW-07・08、docs/specs/reconstruction-display-design.md:303 «c475f3e514d6d25e»・docs/specs/reconstruction-display-design.md:304 «63b49230db87d968»）を評価の文の字から推すしかない（DS-OPEN-12、docs/specs/reconstruction-display-design.md:414 «a4f0fb6c8a0b7105»）。
- A の根拠: fixture の実物は 1 報に 1〜2 個（`0215 0241`・`0211 0241`、c0-prep の数え。repo 外）。受理（seismic.ts:188）は件数も字の形も見ないので、保存の上限と decode の確かめが要る。数を持つので、落とした字があったことが画面の側に残る。
- 保存の byte は decode が各コードを `^\d{4}$` と確かめる前提で 1 字 1 byte。

### 2.4 コードを取る寄与（D-CODE-SOURCE）

| 案 | 中身 | 起きること |
|---|---|---|
| A 公開事実が選んだ寄与のコード（推奨） | :246 の寄与（VXSE53・VXSE52 の新しい方、無ければ VXSE51）の `codes`。文は今どおり VXSE51 なら null | VXSE51 の 0217（「今後の情報に注意してください。」）が wire に出る。DS-QROW-08 の「調査中」をコードから作れる |
| B 文と同じ寄与だけ（VXSE52・VXSE53） | VXSE51 のときはコードも空 | 震度速報だけの行は、コードからは「調査中」が分からない |

- 文の無い報（固定付加文が無い）は、どちらの案でも `tsunamiCodes` が空。VXSE51 だけの文の無い報と、VXSE53 の文の無い報は、コードでは区別できない。受理は Earthquake の無い VXSE53（Intensity だけ）も受ける（reconstruction/src/domains/seismic/seismic.ts:267 «4d953bc028d23a66» の次の行）ので、行の hypo が null かでも VXSE51 だけの行と見分けられない（判別できない。§7 の問い C0-Q1）。

### 2.5 深さの「以上」の載せ方（D-DEPTH）

| 案 | 中身 | 起きること |
|---|---|---|
| A 行に `depthBound` を別の欄で足す（推奨） | 行の depth が range なら bound、ほかは null | EEW のカードの型（DisplayValueText を共有）は変わらない |
| B DisplayValueText に bound を足す | depth・mag の値の型に欄 | EEW のカード・M の値の型も広がり、EEW の wire の最大も動く |

### 2.6 保存の版と読み戻し（D-RESTORE）

| 案 | 中身 | 起きること |
|---|---|---|
| A v10 に上げ、v9 は読まない。v10 の decode は区分ごとに行が 9 以下・鍵の降順（§2.2 の同時刻の順）・EventID の一意を確かめ、外れたら invalid（推奨） | 前例 P4-DW-AC16（reconstruction/contracts/p4-display-wire.json:684 «545ae74aa0f044cf»）と同じ。v9 の slot は一覧に無い版として unknownSchema で読まれ、その run で U-Q は保存しない（P3-MIG-AC01）。配送で、開発機の新築の U-Q-A.json・U-Q-B.json のうち v10 でない slot を作者の了承を得て消す（P3-MIG-AC02 (2)）。Pi は旧築なので消さない | v9 の 5 行（最後に受けた順）は読まれない。新築は未稼働で、P5 の前は保存の初期化を許す（作者の裁定 2026-10-20）。並びが崩れた・EventID が重なった保存を読むと、表示の行が規則の外になり、:481 の「その EventID の行を除く」が重なった行を両方消すので、境界で拒む。試験が手で組む当日履歴（seismic-capacity.test.ts:699・seismic-unit.test.ts:1160 は読めない字の発生時刻〔同じ鍵〕の行を EventID の昇順に並べる）は EventID の降順に組み直す |
| B v10 で decode は並びを確かめない | 保存は受けるたびに並べ直した列だけが書かれる | r0 の推奨。崩れた保存を読むと次の受信まで規則の外の並びが出る（ヘルツ P2） |
| C v9 を読んで並べ直す（移行） | v9 の行に新しい欄の空の値を足して並べ直す | 旧い形を読む移行を作る（AC16 は作らなかった）。新しい欄の値は v9 から作れない |

### 2.7 保存の予算の足し方（D-BUDGET）

| 案 | 中身 | 起きること |
|---|---|---|
| A `283_209` は変えず、:59 の `RECENT_GROWTH` を「27 行の全欄（元の欄＋B0 の 5 欄＋本契約の 2 欄）を 1 字 6 byte で数えた値 − `283_209` の中の 15×1,206」にする（推奨） | 27 行の最悪でも必ず入る。元の 15 行の 1 字 3 byte の残存（p4-display-wire-tables.md:242）もこの差で埋まる | :63・:69 の字と、`283_209` を引く契約の字が動かない |
| B 当日の行の全部（27 行の全欄）を 1 字 6 byte で数え直し、`283_209` の中の 5×1,206 を式から置き換える | A と同じ値 | `283_209` を引く契約（p3-seismic-unit.json:85・:310・:338、p3-seismic-event-limit.json:271 ほか）と :63・:69 の字が動く |

### 2.8 wire の行の上限（D-WIRE-CAP）

A wire に別の上限を置かず、unit の行（区分ごとに 9）をそのまま繋ぐ（推奨）。型の最大の script と表で 27 行と書く。B display-wire.ts に 27 の切りを足す（unit が既に 9 で切るので、切りの対象が無い）。

### 2.9 wire の版（D-VERSION）

A `p4-display-wire-v3` のまま（推奨）。行を読む描画（C0）はまだ無く、client の外形の確かめ（reconstruction/src/display/screen/client.ts の isWireSnapshot、:17〜:25）は分野の unit と contentRevision が字であることまでしか見ないので、行の欄が増えても弾かない。B `p4-display-wire-v4`（S0 の client の定数と、その行を引く契約の «» の付け直し、開いたままの画面は非対応の表示）。

### 2.10 9 行を選ぶ母集団（D-EDGE、作者待ち）

| 案 | 中身 | 起きること |
|---|---|---|
| A 持っている行と今回の行から選ぶ（推奨、条文は A の形） | 外した地震の行は戻さない | 鍵が古い側へ動く訂正（表 §3 の 13）で、外した間の地震が行に無いまま。unit の処理は行の配列だけ |
| B 端をまたいだときだけ、unit の event の記録から今日の地震を選び直す | 9 行目の外へ動いた・外から入った受信で、記録（EarthquakeEvent、区分をまたいで最大 1024 件）を走って今日の地震を並べ直す | 外した地震が戻る。受信 1 回の走査が記録の件数に比例する（AGENTS.md の受信経路の計算量に上限と計測の条文が要る）。記録から退去した地震は戻らない |

- 統合担当が作者に問うた（2026-11-26）。B4 の理由の字「起きにくい」はこのまま（判断カードの「起きない」は誤りと作者に伝えた）。

## 3. 並びの条文（受けた報の列 → 行の並び）

規則: 受信で行を作ったら（今日の判定 :471 を通り、active か既に行がある地震、:474）、「その EventID の行を除いた行」に作った行を足し、§2.1 の鍵の降順・§2.2 の同時刻の順で並べ、先頭の 9 行を残す。作った行が 10 番目以降に並び、その EventID の行が前に無かったときは、recent の配列を前と同じ object のまま残す（入らなかった地震で recent を作り替えない）。取消は、採用の後に active な寄与が残るかで分ける。全取消（active な寄与が無い）は今どおり、行があれば `{ ...前の行, cancelled: true }`（:480、鍵が変わらないので位置も変わらない）、行が無ければ作らない（:474）。一部取消（ほかの family の寄与が active のまま）は active の受信と同じで、採用の後の公開事実から行を作り直し、鍵も採用の後の facts から作る（位置が動きうる）。件数・最大震度・counted の規則は変えない。

場面はどれも 2026-11-26（JST）の通常の区分、時刻は発生時刻。行の列は上から。

| # | 受けた報の列 | 行の並び | 根拠 |
|---|---|---|---|
| 1 | 10:00 の地震 C の報 → 08:00 の A の報（遅れて着） → 09:00 の B の報 | C・B・A | 鍵の降順 |
| 2 | 1 の後に、A の訂正（発生時刻は 08:00 のまま、13:30 着） | C・B・A（A の中身だけ替わる） | 鍵が同じ。行の中の地震の訂正は位置を変えない |
| 3 | 1 の後に、A の訂正で発生時刻が 09:30 に | C・A・B | 発生時刻そのものが変わると、その時刻の位置へ（B4） |
| 4 | 1 の後に、OriginTime の無い D の報（報の時刻 11:05） | D・C・B・A | 発生時刻が無いので報の時刻で並ぶ（今日の判定と同じ字） |
| 5 | 4 の後に、D の報（OriginTime 09:45、11:20 着） | C・D・B・A | 発生時刻が付くと、その時刻の位置へ動く |
| 5' | 4 の後に、D の OriginTime の無い続報（報の時刻 11:20） | D・C・B・A（D の鍵は 11:20） | 一般則: 発生時刻の無い行は、採用した報の時刻の位置へ動く（鍵は行の報の時刻＝採用した報の ReportDateTime、D-KEY=A の性質） |
| 5'' | 1 の後に、H の震度速報 VXSE51（TargetDateTime 10:31）→ H の VXSE53（OriginTime 09:58） | H・C・B・A → C・H・B・A | VXSE51 の発生時刻は TargetDateTime（:236）、VXSE53 が来ると OriginTime（:235）に替わり、鍵が動く。実の地震のふつうの順 |
| 6 | 発生時刻が同じ 10:00:00 の E（EventID 20261126100001）と F（20261126100005）。F を先に受ける | F・E | 時刻に直して同じなら EventID の字の降順（D-TIE=A）。受けた順に依らない |
| 7 | Q1〜Q9（01:00〜09:00）が 9 行ある所に、00:30 の Q0 の報 | Q9〜Q1 のまま（recent は同じ object） | 9 行より古い 10 件目は入らず、新しい行を押し出さない。件数と最大震度は今どおり数える |
| 8 | 7 の後に、09:30 の Q10 の報 | Q10・Q9〜Q2（Q1 が外れる） | 新しい地震は入り、いちばん古い行が外れる |
| 9 | 7 の後に、Q0 の訂正（発生時刻 00:30 のまま） | 変わらない | 9 行の外の地震の訂正は、並べて 10 番目以降なら入らない |
| 10 | 7 の後に、Q0 の訂正で発生時刻が 05:30 に | Q9〜Q6・Q0・Q5〜Q2（Q1 が外れる） | 9 行の外の地震も、訂正で鍵が 9 行の内に入れば入る（今日の判定を通る間） |
| 11 | 7 の後に、Q0 の全取消（Q0 の寄与は VXSE53 だけ） | 変わらない（行は作らない） | 行の無い地震の全取消は今どおり行を作らない（:474） |
| 11' | 7 の後に、H の VXSE53（OriginTime 00:30）→ H の VXSE51（TargetDateTime 10:31）を受ける（どちらの後も facts の発生時刻は VXSE53 の 00:30〔:235〕で、H は 9 行の外）→ H の VXSE53 だけの取消 | H・Q9〜Q2（Q1 が外れる） | 一部取消。VXSE51 が active なので、採用の後の発生時刻は TargetDateTime 10:31（:236）になり、H は 10:31 の位置で入る |
| 12 | 7 の後に、Q5 の全取消 | Q9〜Q6・Q5（取消）・Q4〜Q1 | 全取消の行は位置を変えず、9 行の 1 つを占めたまま残る（DS-QROW-09） |
| 12' | 7 の後に、Q5 の VXSE51（TargetDateTime 09:40）を受け、Q5 の VXSE53 だけを取消 | Q5・Q9〜Q6・Q4〜Q1（Q5 は取消でない） | 一部取消。行の中の地震でも、採用の後の facts で作り直すので鍵が 05:00 から 09:40 に動く |
| 13 | 7 の後に、Q9 の訂正で発生時刻が 00:10 に | Q8〜Q1・Q9（Q0 は戻らない） | 外した地震の行を unit は持たないので、鍵が古い側へ動くと、間の 00:30 の Q0 は行に無いまま（既知の性質） |
| 14 | 00:01 着の OriginTime の無い G の報（報の時刻 00:01）→ G の報（OriginTime は前の日の 23:59） | G（鍵 00:01、中身は最初の報のまま） | 2 つ目の報は今日の判定（:471）を通らないので行を触らない。今のまま（本契約で変えない、outOfScope） |
| 15a | v9 の slot だけ（A・B のどちらも v9、または v9 と空） | checkpoint は unavailable（unknownSchema）を返し、その run は U-Q を保存しない | 一覧に無い版（reconstruction/src/checkpoint/checkpoint.ts:177 «b0d70fcd0041aaef»・reconstruction/src/checkpoint/checkpoint.ts:186 «9c82ce3abff6a475»）。行は読まれない |
| 15b | v10 と v9 の slot が並ぶ | v10 の slot から復元し、その run は保存しない（checkpointRestoreRejected の unknownSchema） | 同じ :177 の枝 |
| 15c | 作者の了承で開発機の v9 の slot を消した後（A・B とも無い） | empty（初期の state）から始まり、保存する | reconstruction/src/checkpoint/checkpoint.ts:173 «564a91036c15104a» |
| 15d | v10 の slot の payload が decode で invalid（行が 10 個・並びが崩れた・EventID が重なった・欄が上限の外） | unit の restore が requiredStructureInvalid の rejected を返し、state は初期のまま | reconstruction/src/units/seismic/seismic-unit.ts:1313 «f91fce8a083f2983» |
| 16 | v10 の保存（9 行）から同じ日に、確かめた時計で起動 | 保存した順のまま | 保存は受けるたびに並べ直した列。日が変わっていれば、復元の期限の回収（:1231）が当日履歴を空にする。時計が確かめられない間（awaiting・unverified）は回収を止める（:1196〜:1197）ので保存した順のまま残り、確かめた時計の期限で空になる（今のまま） |

- 計算量: 受信 1 回で並べ直すのは高々 10 行（その区分の 9 行と作った 1 行）。全件の走査や当日履歴の全体の直列化を足さない。byte は今の `historyBytes`（行の配列ごとの cache）のまま数える。

## 4. 保存の予算

`RECENT_GROWTH`（:59 の行の中）を次の和にする（D-BUDGET=A。数は `.tmp-uq/wire-max-uq.mjs` の seismicRecent、git に入らない）。

| 項 | 1 行 | 行の数 | byte |
|---|---|---|---|
| 足した欄（B0 の depth・magnitudeDescription・tsunamiComment・strongest・omittedStrongest と、本契約の tsunamiCodes 4 個・omittedTsunamiCodes）、1 字 6 byte、前の鍵との区切り 1 | 1,656 | 3 区分 × 9 | 44,712 |
| 元の欄（eventId 40・発生時刻と報の時刻 40 字・震源名 64 字・M と震度の値 32 字〔震度は fromTo〕・cancelled）、1 字 6 byte、行の区切り 1 | 2,310 | 3 区分 × 9 | 62,370 |
| `283_209` の中にある元の 15 行の分（P3-C7 の 1 行 1,206、1 字 3 byte）を引く | −1,206 | 3 区分 × 5 | −18,090 |
| 合計（今の 23,580 から） | | | 88,992（＋65,412） |

- 器と予約: `GENERATION_LIMIT` は 26,543,109 → 26,608,521、`RESERVE_BYTES` は 3,446,117 → 3,511,529（どちらも ＋65,412。r0 の 72,432 は元の 15 行を 1 字 3 byte のまま残し、27 行の最悪では 15×(2,310 − 1,206) ＝ 16,560 足りなかった〔ヘルツ P2〕。今の値は基点の build から読んだ `seismicUnitCodec.maxEnvelopeBytes` と、seismic-capacity.test.ts の式の写し）。
- 27 行の全欄を、復元の境界（長さだけを確かめる）に合わせて 1 字 6 byte で数える。`283_209` の字は変えず、その中の 15×1,206 を RECENT_GROWTH から引くので、元の 15 行の 1 字 3 byte の残存（p4-display-wire-tables.md:242）も埋まる。
- 試験の写し: seismic-unit.test.ts:35 と seismic-capacity.test.ts:23 の `MEMORY_GROWTH` の `3 * 5 * 1_572` を 88,992 に、seismic-capacity.test.ts:419 の期待の `3 * 5 * 1_572` も同じ数に。
- 器が広がるので、`maxEnvelopeBytes` を山の記録の effectiveLimits と照らす測り手（pi-measure.mjs）は、本契約の前に取った山の記録で limitMismatch になる（B0 の残存と同じ性質）。

## 5. 容量の数え直し

### 5.1 型の最大（`node .tmp-uq/wire-max-uq.mjs`。reconstruction/contracts/p4-display-wire-max.mjs の写しで、行に `tsunamiCodes: array(4, "9999")`・`omittedTsunamiCodes: MS`・`depthBound: widest(null, "lower", "upper")` を足し、rows を 27 にした）

| 形 | U-Q の最大 | 保護 3 分野（A短） | 262,144 の余り | 新しい経路の上界（newPath.sum） |
|---|---|---|---|---|
| 今（区分ごとに 5 行、今の欄） | 55,436 | 180,826 | 81,318 | 377,434 |
| 判断カード §5（9 行、今の欄、子 a17count） | 74,444 | 199,834 | 62,310 | 396,442 |
| 本契約（9 行、新しい欄） | 77,279 | 202,669 | 59,475 | 399,277 |

- 新しい欄で wire の 1 行が 105 byte 増える（27 行で 2,835）。
- 区分ごとに塗る組 R短（作者の選んだ組ではない）は余りが 10,389 → −11,454 になる。作者の選んだ組は A短（p4-display-wire.json の P4-DW-AC04）。
- `NEW_PATH_FIXED_BOUND`（display-wire.ts:544）は 399,277 にする。display-capacity.test.ts:287 の試験が script の newPath.sum と同じかを見るので、script と一緒に変える。

### 5.2 M5 の導いた組（`python3 .tmp-uq/m5.py`。a17count の count.py と同じ足し方で、`.tmp-s0/m2-M5.json`〔repo 外、9,244 公開、P4-UW-AREA-KIND-001 の前の値〕の 9 分野の byte に U-W の増えと上界を足した）

| U-W に足す | 上界 | 1 MiB を越えた公開 | 要約になる分野 | 最悪の公開（06-26 07:40:59） | 要約の後 | 収まらない |
|---|---|---|---|---|---|---|
| ＋40,696（a17count と同じ） | 377,434（5 行） | 1,621 | U-F だけ | 1,133,421 | 947,177 | 0 |
| 同 | 396,442（9 行、今の欄） | 1,789 | U-F だけ | 1,152,429 | 966,185 | 0 |
| 同 | 399,277（本契約） | 1,911 | U-F だけ | 1,155,264 | 969,020 | 0 |
| ＋40,732（最悪の公開の増え、量った 2 つの和の差から導いた） | 399,277 | 1,918 | U-F だけ | 1,155,300 | 969,056 | 0 |
| ＋49,186（P4-UW-AREA-KIND-001 の見積もり、通常と訓練） | 399,277 | 2,124 | U-F だけ | 1,163,754 | 977,510 | 0 |

- どの行も要約になるのは U-F だけで、2 つ目の U-M に届かない。収まらない公開は 0。
- 保護 3 分野は要約にならない（H37）。本契約の 9 行は上界 399,277 の中に入っている。

### 5.3 容量の表の 1,610 と a17count の 1,621 の差（11 公開）

- 容量の表 reconstruction/contracts/p4-display-capacity-tables.md:65 «d04ca2e6f76aeb84» の 1,610 公開・1,133,457 は、P4-UW-AREA-KIND-001 の配送で Mac mini が量り直した M5 の行（c7bdd8dd の木、Q-UAK-DELIVERY (1)）に 377,434 を足した値。量り直した行の 9 分野の和の最大は 756,023（reconstruction/contracts/p4-display-capacity-tables.md:64 «6f98719edc1cbf61»）。
- a17count の 1,621・1,133,421 は、量り直す前の m2-M5.json（9 分野の和の最大 715,291）の全部の公開の U-W に、U-W の最大どうしの差 40,696（229,286 − 188,590）を一律に足した値。
- 最悪の公開の差 36 byte: 量り直す前の最悪の公開 07:40:59 の U-W は 188,492、U-W の最大は 07:10:58 の 188,590（m2-M5.json）。量り直した行の 9 分野の和の最大は同じ 07:40:59 の 756,023（:64）で、715,291 ＋ 40,732。U-W のほかの分野が前と同じなら、07:40:59 の U-W の増えは 40,732（40,696 より 36 多い）で、1,133,457 − 1,133,421 ＝ 36 と合う（導いた値。ほかの分野が同じかは量った行で確かめていない）。
- 公開の数の差 11（推定）: 一律に ＋40,696 を足しても ＋40,732 を足しても 1,621 で同じ（§5.2 の script）なので、差は足す量の違いからは出ない。量り直した行で U-W のほかの分野が前と同じなら、公開ごとに U-W の増えが違う（その時刻に出ていた区域×種別の数で決まる）ことから出る、と読める。量り直した公開ごとの行は Mac mini の側にあり、起草の子は読んでいないので、この読みと「一律の足し方が公開の数を多めに数えるか」は確かめていない（最悪の公開では量った増え 40,732 が一律の 40,696 より大きい）。配送の前の数え直し（AC06 (3)）で統合担当が量った行から数える。

## 6. 旧の経路への影響（D-LEGACY）

- 旧の /events の U-Q の view は daily（recent を含む）をそのまま載せる（view-projector.ts:463、toSeismicView は state の daily を渡す）。並びは unit の state の並びなので、どちらの案でも旧の view の行も発生の新しい順になる。

| 案 | 中身 | 旧の U-Q の view の増え（上界、1 字 6 byte） | 前例 |
|---|---|---|---|
| A 旧の view にも 9 行と新しい 2 欄をそのまま出す（推奨） | view の形を変えない | ＋48,852（増えた 12 行 ×〔元の欄 2,310 ＋ 足した欄 1,656〕＋ 元の 15 行 × 新しい 2 欄 84。保存の増えと同じ） | P4-DW-AC16（B0 が行に足した欄は旧にも出た） |
| B 旧の view は区分ごとに先頭の 5 行と B0 までの欄に切る | 旧の projector が U-Q の view を旧の snapshot に入れる所（reconstruction/src/view-projector/view-projector.ts:799 «b66083ff9c611305»）で切る。toSeismicView では切らない（新しい経路の display-wire.ts:501・:734 も同じ view を読むので、toSeismicView で切ると新しい経路の 6〜9 行目が消える） | 0（並びは変わる） | P4-UAK-D-PLACE=A（旧の経路の出力を変えない側） |

- A の根拠: 旧の経路は T0 で消え、端末は daily を読まない。旧の U-Q は分野の予算 65,536 を既に越えうる（N2・N3 の旧の経路は U-Q を要約にしている、p4-display-capacity-tables.md の §2.2 の下の段落）ので、旧の要約の組が変わるのは旧の全体が 1 MiB を越える公開だけ。B は旧のためだけに投影の処理を足す。
- 旧の要約の規則・計量の式（fixedBytes）はどちらの案でも変えない。B を選ぶときは allowedPaths に view-projector.ts の :799 の行の中を足し、display-wire.ts:501 は変えない（AC09）。
- 端末（reconstruction/src/cli・reconstruction/src/terminal）は daily を読まない（grep 0 件）ので、端末の画面は変わらない。
- 試験の道具 reconstruction/test/disaster/runner.ts:657〜:658 は、旧の view の earthquake.recent の先頭 4 行を記録の画面の量として残す。行の並びが変わるので、記録に出る 4 行の中身が変わりうる。

## 7. C0（P4-STANDBY-CARDS-001、未起草）への未決の問い

本契約は wire に生の値を載せる所までで、下の問いは決めない。どれも画面の見え方が変わるので、C0 の起草で見本の図とともに作者に問う。

| id | 問い | 本契約の後に wire にある材料 |
|---|---|---|
| C0-Q1 | コードから札への対応。DS-QROW-07・08 の表に無い 0203（「この地震による津波の心配はありません。」）と 0241（「この地震について、緊急地震速報を発表しています。」）の扱い。1 報に 2 つ（`0211 0241`・`0215 0241`）来たときにどれで札を決めるか。固定付加文の無い VXSE53・VXSE52 の行の札（VXSE51 だけの文の無い行は DS-QROW-08 で「調査中」） | `tsunamiCodes`（電文の順）・`tsunami`（評価の文、VXSE51 は null）・`hypo`。受理は Earthquake の無い VXSE53 も受ける（seismic.ts:267 の VXSE53 の枝）ので、`hypo` が null でも VXSE51 だけの行とは限らず、wire の材料では「文の無い震度速報」を判別できない |
| C0-Q2 | 落としたコード（`omittedTsunamiCodes` が 1 以上）の見せ方 | `omittedTsunamiCodes` |
| C0-Q3 | 深さの字。「以上」（lower）の字、「未満」「以下」（受理が同じ upper に畳むので wire で区別できない）の字、深さの欠け（`depth` が null）、読めない座標（`depth.v` に座標の全体の生の字が入る）、0 の「ごく浅い」、700km 以上の書き方 | `depth.v`（座標の 3 つ目の生の字、m）・`depthBound`。depthConflict の報（数と description が食い違う）は bound が無い |
| C0-Q4 | 9 行の外の地震の見せ方（例「ほか 3 件」）。判断カードの A17 の推奨の理由の 3 つ目で「C0 の見本の図で別に聞く」とした | 区分ごとの `daily[].count`（全体の震度が既知の段階の地震の数。取消の行と、震度の分からない地震は数えない）と、行の数 |

## 8. ほかの契約・計画・spec の字で、改める必要がある所（改めていない。配送で統合担当が当てる）

数え方: contracts（*.json・*.md・*.mjs）と docs/specs の 2 本を、55,436・180,826・81,318・377,434・377_434・967,258・671,142・1,572・23,580・94,403・1,206・283,209・283_209・1,958,729・MEMORY_GROWTH・RECENT_GROWTH・「15 行」「5行」「5 行」で grep し（`.tmp-uq/g.py`、git に入らない。「15 行」「5行」「5 行」は U-Q の行の数を指すヒットだけを数えた）、全部のヒットを「改める」と「記録」に割った。「記録」は、閉じた questionResolutions・decisionBranches の reason・remaining、配送済みの契約の allowedPaths・artifactRequirements、前の契約の配送の記録と、その時点の値を書いた計算の字（件数 512 の時代の 1,958,729 など）で、その時の値なので改めない。

### 8.1 改める（今の規則・上限・条文として書いている字）

| file | 行 | 改める字 |
|---|---|---|
| reconstruction/contracts/p4-order-plan.md | :124・:192・:223・:225 | 本契約の起草済み・配送の印（C0 の依存の字、Wave 2 の「未起草」、直列の字）。:223 の display-wire.ts の直列の字に「quakeRow の行の中」のほか「:544 の NEW_PATH_FIXED_BOUND を 399,277 に広げる」を足す |
| 同 | :548 | 「今日の地震の行は最大 5 行」を区分ごとに 9 行に（カードの高さの試算は C0） |
| reconstruction/contracts/p3-seismic-unit.json | :694 | P3-C7-RET-03 の limit 5 を 9 に（本契約の P4-UQR-RET-01） |
| 同 | :799 | P3 の AC の「recent 5行」を、区分ごとに 9 行・発生の新しい順に |
| reconstruction/contracts/p3-seismic-unit.types.ts | :146〜:150 | SeismicRecentQuake の注記（新しい順に最大 5 行 → 発生の新しい順に最大 9 行、1 行 1,572 → 足した欄 1,656・元の欄 2,310）。実装の allowedPaths に入れる |
| reconstruction/contracts/p4-display-wire.json | :499・:515 | resourceLimits の scope の 180,826・377,434 を 202,669・399,277 に |
| 同 | :548・:569・:581・:702 | AC と試験の字の 180,826・81,318・377,434、:569 の「今日の地震は区分ごとに 5 行」 |
| 同 | :684 | P4-DW-AC16 の「1 行 1,572・15 行 23,580」（本契約が 27×(1,656＋2,310)−15×1,206 ＝ 88,992 に改めた） |
| reconstruction/contracts/p4-display-wire-tables.md | :16・:21・:60・:98〜:110・:206・:242・:411・:457・:461 | 地震の行の数（区分ごとに 9 行・3 区分で 27 行、:60 の「板待ち: C0」を外す）、地震の最大・保護 3 分野・上界の数（:98〜:110 の組の表の地震の列と合計・余り。区分ごとに塗る組の 116,568・37,542 も 27 行で数え直す）、U-Q の増え分、:457 の今日の地震の行の形に `tsunamiCodes`・`omittedTsunamiCodes`・`depthBound` |
| reconstruction/contracts/p4-display-capacity-tables.md | :13・:17・:28・:46・:51・:52・:65・:152・:154・:161・:185 | 上界 377,434（377_434）→ 399,277（:13・:17・:46・:52・:65・:154）、保護 3 分野 180,826 → 202,669（:52・:161）、967,258 → 989,101（:51・:52）、671,142 → 649,299（:152 の節の題）、U-Q の型の上限 55,436 → 77,279（:28）、E6 の U-Q の形（:185 の「区分ごとに 5 行」）、M5 の導いた組の公開の数（:13・:65、配送の前の数え直しの値で） |
| reconstruction/contracts/p4-display-capacity.json | :169・:281・:312・:389・:406・:417 | objective・scope・AC の 377,434・967,258・671,142、:389 の E6 の「区分ごとに 5 行」 |
| reconstruction/contracts/p4-display-vocab-tables.md | :16・:212・:219・:220・:222・:226・:229・:436・:443 | 保護 3 分野・上界・967,258・671,142 の数 |
| reconstruction/contracts/p4-display-vocab.json | :357・:439・:568 | scope・AC・試験の字の 180,826・967,258 |
| docs/specs/reconstruction-display-design.md | :414 | DS-OPEN-12 の「wire は文だけ」（コードは wire に載った。どの報にどのコードかと札の決め方は C0-Q1） |

- 契約の字を読む試験・checker の確かめ（r1）: p3-seismic-unit.json を読む試験は seismic-unit.test.ts:9 の import だけで、使うのは contract.fixtureIds（:777）。retentionLimits・decode の字を読む試験・checker は reconstruction/test・reconstruction/tools・reconstruction/src に無い（grep。host.ts の resourceLimits は worker の上限で別物）。sequences.json が引く p3-seismic-unit.json の行は :40・:113・:122・:183・:194・:205・:221・:257・:290・:297・:301 で、:305・:310・:694・:799 を引かない。だから :694・:799 は配送の commit で統合担当が当ててよい（実装の commit に入れなくても CI は赤くならない）。

### 8.2 書き換えずに本契約の側に記録する

- p3-seismic-unit.json:310（capacityReserve の「recent 5×1,206」）と :305（decode の「recent≤5」）は、他の契約の «» が引く（:310 を 7 本、:305 を 3 本）。字を変えると 10 本の付け直しが要るので、改めずに本契約の P4-UQR-RET-01・RES-01・AC04 を後の版として読む（:310 の 283,209 の式は D-BUDGET=A で変わらず、増えは RECENT_GROWTH に入る）。

### 8.3 記録（改めない）

- p4-display-wire.json:297・:334・:419・:420・:524・:603・:856・:857、p4-display-wire-tables.md:233・:238・:363・:390。
- p4-display-capacity.json:19・:41・:115・:116・:204、p4-display-capacity-tables.md:187・:220・:225・:236。
- p4-display-vocab.json:19・:159・:188、p4-display-vocab-tables.md:291、p4-uw-area-kind.json:101、p4-uw-area-kind-tables.md:115・:126。
- p3-seismic-unit.json:85・:90・:95・:100・:338・:815、p3-seismic-event-limit.json:40・:54・:61・:198・:271・:392、p3-seismic-reserve-close.json:67・:78・:191、p3-unit-q-capacity.json:68・:124・:140・:312・:677、p3-persist-premises.md:550。283,209 の式（:63・:69 の頭）は D-BUDGET=A で変わらないので、p3-seismic-event-limit.json:271 の器と予約の式も今の字のまま成り立つ。

### 8.4 «» の付け直し（配送の commit、統合担当）

- §8.1 で字を変える行を引く «»（11 本）: p4-display-wire-tables.md:60（p4-display-wire.json:574）、:99（p4-display-wire.json:583）、:206（p4-display-wire.json:550・p4-display-vocab.json:488）、:242（p4-display-wire.json:687）。p4-display-vocab-tables.md:219（p4-display-vocab.json:441）、:226（p4-display-vocab.json:442）。p4-display-capacity-tables.md:65（p4-uw-area-kind.json:313・p4-uw-area-kind-tables.md:115）。p4-order-plan.md:124（p4-display-shell-tables.md:488）、:223（p4-uw-area-kind-tables.md:69）。
- 実装で中身が変わる行を引く «»（3 本）: reconstruction/src/view-projector/display-wire.ts:544（p4-display-capacity.json:408）、reconstruction/src/runtime/owner-runtime.ts:84（p3-unit-q-capacity.json:476）、reconstruction/contracts/p4-display-wire-max.mjs:163（p4-display-wire.json:688）。
- 本契約の JSON と表の «» のうち、実装と §8.1 で中身が変わる行（seismic-unit.ts の :36・:54・:59・:470・:479・:481・:1599、display-wire.ts の :490・:491・:544、型の :77・:158、max の script の :86・:94・:163、owner-runtime.ts:84、試験の行、p4-display-capacity-tables.md の :28・:65、p4-display-wire-tables.md の :60・:99・:242、p4-display-wire.json:684、計画の 4 行）。
- p3-seismic-unit.json:310・:305 は §8.2 で字を変えないので、引く 10 本は動かない。:63・:69 を引く契約（p3-c7t05-fill・p3-currency-coverage・p3-disaster-capacity・p3-seismic-event-limit・p3-unit-q-capacity・p3-seismic-reserve-close）の «» も、行の字を変えないので動かない。
- 旧築（src/）は改める対象にしない。

## 9. 既存の試験で期待が変わる所（実装の前に分かっているもの）

| 試験 | 行 | 今の期待 | 変わる理由 |
|---|---|---|---|
| seismic-unit.test.ts（当日履歴） | :334〜:343 | 同じ発生時刻の 6 件で 6 行目が落ち、5 行（…05〜…01） | 9 行なので 6 件とも残る（…05〜…00、同時刻は EventID の降順） |
| seismic-unit.test.ts（復元の拒否） | :572 | 「recent > 5」で同じ行 6 つを invalid | 別の EventID の 10 行で invalid に（同じ行を並べると EventID の重なりでも invalid になり、件数の上限の確かめにならない） |
| seismic-unit.test.ts・seismic-capacity.test.ts | :35・:23・:419 | `MEMORY_GROWTH` の写しと期待の `3 * 5 * 1_572` | 88,992（§4） |
| seismic-unit.test.ts・seismic-capacity.test.ts（同時最大状態） | :1160・:699 | 当日履歴の上限を 5 行で組む（読めない字の発生時刻の行を EventID の昇順） | 9 行と新しい 2 欄の上限いっぱいで、EventID の降順に組む（上限の状態の試験なので。同じ鍵の行は EventID の降順でないと復元が invalid にする） |
| display-wire.test.ts（型の最大） | :68〜:73 | 行は 15、欄は今の型 | 27 行と新しい 3 欄（期待は script と同じ数のまま） |
| display-capacity-manifest.test.ts（P4-DC-T06 の E6 の部品 quakeAtShape） | :195〜:205 | 区分ごとに 5 行で U-Q の最大の形を組む | 区分ごとに 9 行で組む（期待は止まる所を実の byte で数え直す形なので変わらない。:254 より前なので行の数を変えない） |
| display-wire.test.ts（P4-DW-T12） | :482〜:507 | seismicRecent が `{ perRow, rows: 15, growth }`、足した欄は 5 つ | script の新しい形（perRow 1,656・baseRow 2,310・rows 27・reservedRows 15・reservedRow 1,206・growth 88,992）、足した欄は 7 つ |
| 版の字の 4 か所 | seismic-fixture.ts:17・display-wire-fixture.ts:27・shared-runtime.test.ts:74・seismic-capacity.test.ts:49 | p3-seismic-unit-v9 | v10 |

- 旧の経路と disaster の試験の確かめ（r1）: disaster.test.ts の P3-DC-T09（:243〜）は VXSE53 3 件で旧の U-Q の要約の境界を二分探索で数え直す形で、行の数・並びを期待に持たない。runner.ts の SCREEN_LIMITS（:657〜:658）の earthquake.recent の 4 行を期待に持つ試験は disaster.test.ts に無い（grep の screen は 0 件）。snapshot-sse の試験（boundaries・corpus・cost・http-sse・startup）に `recent` の字は無く（grep）、startup.test.ts:150〜:161 は 1 件の地震の項目だけを見る。AC08・allowedPaths に足す試験は無い。
- ほかに期待が動く試験が出たら、変える前に試験名・旧の期待・理由を報告して止める（AC08）。

## 10. 読んだ範囲

- 読んだ（r1 で足した所）: seismic-unit.ts の :1193〜:1232・:1312〜:1330・:1380〜:1393、seismic.ts の :260〜:272、checkpoint.ts の :150〜:200・:446〜:469、view-projector.ts の :790〜:800、disaster.test.ts の :243〜:300、display-capacity-manifest.test.ts の :195〜:235・:316〜:345、p3-seismic-unit.json の :305・:688〜:700。
- 読んだ: seismic-unit.ts の :1〜:170・:225〜:256・:395〜:486・:1415〜:1425・:1463〜:1468・:1575〜:1664、seismic.ts の :58〜:66・:150〜:189、display-wire.ts の :440〜:510・:536〜:547、p4-display-wire.types.ts の :50〜:99、p3-seismic-unit.types.ts の :25〜:224、view-projector.ts の :316〜:324・:450〜:481、client.ts の :17〜:36、runner.ts の :650〜:664、p4-display-wire-max.mjs の全部、check-contract.mjs の全部、seismic-unit.test.ts の :300〜:354・:486〜:500・:566〜:575・:1150〜:1170、seismic-capacity.test.ts の :15〜:30・:410〜:420・:690〜:705、display-wire.test.ts の :80〜:101・:455〜:508、seismic-fixture.ts の :67〜:88、p4-uw-area-kind の 3 file、p4-display-capacity-tables.md の :8〜:70、計画の :120〜:126・:188〜:227、表示設計 spec の :296〜:312・:410〜:416・:509〜:512・:556〜:559・:690〜:694、P3-MIG-AC01・AC02、P4-DW-AC16 の全文と配送の手順。
- grep: reconstruction/src と reconstruction/test の `\.recent\b`・`RECENT_LIMIT`・`MEMORY_GROWTH`・`p3-seismic-unit-v9`・`maxEnvelopeBytes`・`377_434`・`display-wire-max`、contracts の «» で本契約が変える file を引く行の全部（`.tmp-uq/cites.py`）、contracts と spec の 55,436・180,826・81,318・377,434・1,572・23,580・94,403・1,206。

## 11. r0 のレビューの指摘と r1 の対応

| 直し | 指摘（出どころ） | 当てた所 |
|---|---|---|
| — | 9 行を選ぶ母集団（ヘルツ P1） | 作者待ちの分岐 D-EDGE（§2.10）。条文は A の形のまま |
| 1 | 一部取消で行の外の地震が先頭に戻る（ヘルツ P2） | §3 の規則と 11'・12'、AC01 (3) |
| 2 | 復元の並びと EventID の重なり（ヘルツ P2） | §2.6 の D-RESTORE=A、§3 の 15d、AC04 (3)、T02 |
| 3 | 40 字を超える OriginTime で判定と鍵が食い違う（ヘルツ P2） | §2.1 の D-KEY=A（:470 を boundTime に）、§1、§3 の 5' の一般則 |
| 4 | 日の切替えと保存の版の場面（ヘルツ P2） | §3 の 15a〜15d・16 |
| 5 | 27 行の最悪で予約が 16,560 足りない（ヘルツ P2） | §2.7 の D-BUDGET=A、§4（88,992、器 26,608,521・予約 3,511,529） |
| 6 | 改訂の対象の漏れ・D-LEGACY=B の波及・hypo での判別（ヘルツ P2） | §8.1（:694・:548・capacity-tables :17・:154・wire-tables :108〜:110・:457）、§8.2（:305・:310）、§6 の B、§2.4、§7 の C0-Q1 |
| 7 | shuffle の command（適合 P2） | requiredCommands |
| 8 | «» の付け直しの一覧（適合 P2） | §8.4、artifactRequirements の配送の手順。:310・:305 は書き換えない側（§8.2） |
| 9 | 契約の字を読む試験・checker の確かめ | §8.1 の後の箇条 |
| 10 | §8.1 の漏れ・計画 :223 の字・行の数の書き方・RULINGS（適合 P3） | §8.1（wire.json:569・計画 :548・capacity.json:389）、allowedPaths と AC08、Q-UQR-RULINGS |
| 11 | 旧の経路の行を期待に持つ試験の確かめ | §9 の後の箇条 |
