# P4 B0 表示の wire の表 r1（P4-DISPLAY-WIRE-001 の起草の最初の成果物）

- 起草日: 2026-11-21（起草の子 r0。同日 r1 で統合担当の決め 5 つを当てた: Condition はコードで送る、D-B0-LETTER は A で確定、読めない報のカードを合計に入れた明記と短くした場合、最大予測震度のみの報の形を資料で確かめた、D-B0-NO-INTENSITY は A で確定）
- base: `a6d892773abd41bf5858f6df83786f6c823c5af5`（branch draft/p4-b0）。`git diff --stat 7b45edd6 a6d89277 -- reconstruction` は空なので、容量の設計 r2・r3（7b45edd6 で数えた）の行番号はこの base でも同じ行を指す。
- 目的: 契約の JSON を書く前に、型の上限・分野ごとの詳細の形・新旧の wire の切替点・配送済みの契約を変える所を表にする。
- 根拠: 計画 `reconstruction/contracts/p4-order-plan.md`（以下「計画:行」）§1.1・§2.1・§2.3・§3.1・§3.2・§4.1・§4.3、表示設計 spec `docs/specs/reconstruction-display-design.md`（以下「DS-…」の ID）、spec `docs/specs/reconstruction-p0-contracts.md`（以下「spec:行」）§7.10・§8.1〜§8.4・§16 の H37・H51、容量の設計 `~/dev/p4-b1-capacity-r2.md`・`-r3.md`（以下「r2」「r3」）、G0 の資材 `~/dev/p4-g0-assets-r0.md`（以下「G0:行」）、解説資料の読み通し `~/dev/p4-jma-readthrough-eew-quake-r0.md`（以下「読み通し」）。
- 統合担当の決め（覆さない）: (1) 地図の塗りは合成 1 枚（区域ごとに最大の段）、区域名は wire に載せず G0 の表から描画の側で引く。(2) view の `semanticRevision` と U-Q の `daily.counted` は wire に載せない。(3) 文字列の上限は B0 が持つ。(4) 型の最大値の試験で保護 3 分野の wire が 262,144 byte 以下を示すことを受入に入れる（D-H37-EXPECT を閉じる条件）。
- 印: **板待ち** は分野の板で決める数、**作者に聞ける** は板なしで作者に聞ける数。どちらも仮の数を置いて合計を出す。
- byte は UTF-8 の JSON（区切りの空白なし）。日本語の字は 1 字 3 byte。1 件の byte は、付録 A の欄の形に §1.2 の上限いっぱいの字を詰めて直列化した値。

## 0. 結論

- 保護 3 分野は、§1.2 の文字列の上限を置き、区域の Condition をコードで送れば、仮の数の最悪の組（津波 3 件・行 15・市区町村の塗り）で 234,129 byte（262,144 の余り 28,015）に入る（§1.3 の組 A）。
- この合計は、読めない報のカード（H43）を 3 分野ぶん今の長さ（1 本 28,276、計 84,828）で含む。
- この余りは、付録 A の鍵の付け方を変えるだけで数千 byte 動く大きさである。例えば EEW の区域の行の鍵 `c` を `code` にすると 188 行 × 3 byte で ＋564 になる。
- 余りを広げる手のうち、画面への影響が最も小さいのは、読めない報のカードの題と見出しを wire で短くすること（§6 の D-B0-CARD-TEXT、統合担当の推奨の向き）。題 32 字・見出し 128 字にすると、組 A は 171,921（余り 90,223）。
- ほかの手は、観測の震度の塗りを細分区域 188 の粒度にする（組 B、余り 54,357、M0-1 の板）、津波を 2 件にする（組 C、余り 47,714、作者）。
- r3 の 263,608（−1,464）との差は 3 つある。EEW の区域の行から区域名を外したこと（決め 1）、Condition の字を上限 48 byte に置いたこと、合成とカードの区域の欄を r3 §2 の [コード, 段の番号]（「以上」と「不明」を番号に含める）にしたこと。
- 合成 1 枚は、今の `areaRefs` と同じ参照数の Map に段を足した鍵で更新する。手間は、変わった 1 件の区域ぶん × 段の数（10）で済む（§5.1）。
- 台帳 98（深さ 150km より深い報と、観測点 1 点による震度予測の報で Intensity が出ない、解説:4176〜:4183）は、view の型を変えずに表せる。直すのは `eew.ts` の :191・:195・:201・:628〜:633 で、«» で引かれるのは :191 の 1 件。P2-EEW-UNIT-001 の familyTable の required の文も変わる（§5.2）。
- 設定した地域は、出ているカードごとの区域の [コード, 段の番号] から描画の側で引けるので、計画:259 は変えずに済む（r3 §2）。2 件のときの上位 2 行は引けないので、projector が作る（§5.3）。
- 最大予測震度のみの報は、全体の ForecastInt を持ち（解説:4221〜:4224）、Pref と OriginTime を持たない（解説:4391〜:4396・:3910〜:3915）。今の新築は VXSE45 として受け取れ、「以上」は今の `prediction.maximum`（To が over）で足りる。足すのは場所の文と、この報だという真偽（§5.4）。

## 1. 型の上限の表

### 1.1 保護 3 分野の要素

| 分野 | wire の要素 | 件数の上限（案と出どころ） | 超えた分の画面と残す順 | 1 件の byte | 最大の合計 |
|---|---|---|---|---|---|
| eew | 地図の合成 1 枚 [コード, 段の番号]（既知の最大の段。既知の段が無く不明だけの区域は −1） | 運用区分ごとに 1 枚、区域は 188（G0:31） | 超えない（区域の数が上界） | 10 | 1 枚 2,069。3 区分で 6,207 |
| eew | カードの見出し（札の字・警報か予報・第 N 報・最終・発表時刻・最大予測震度・震源名・M・深さ・仮定震源・検知だけの報・場所の文・長周期の最大・読めない印・状態の印） | 6 枚（DS-LAYOUT-06 の A〜F） | 7 件目は最終報の出た古いカードと入れ替える（DS-LAYOUT-07）。6 枚とも最終報の前のときは **板待ち**（E0-1、計画:685）。仮に「入らない EEW は合成にだけ入り、件数を出す」と置く | 1,114 | — |
| eew | 大カードの区域の行（コード・From・To・Condition・到達予想時刻・長周期階級。区域名は G0 から引く） | 1 件のときだけ 188 行（DS-EEW-13、DS-LAYOUT-05） | 超えない | 120（Condition はコード、§1.2） | C＝1 で 25,932（見出しと合成 1 枚を含む） |
| eew | 小さいカードの区域の最小の欄 [コード, 段の番号]（「以上」は番号に含める、r3 §2.3） | 2 件以上のとき、出ているカードごとに 188（r3 §2） | 超えない | 10 | C＝6 で 21,167（全部込み） |
| eew | 2 件のときの上位 2 行（大カードの行と同じ形。projector で作る分） | 2 件のときだけ、カードごとに 2 行（DS-EEWS-10） | 超えない | 120 | C＝2 で 8,921（全部込み） |
| eew | 運用区分 | 3 区分を同じ C に数え、合成は区分ごと（**作者に聞ける**、§6 の D-B0-OPERATION） | — | — | C は同時に 1 つの値なので、eew の最大は C＝1 の 25,932 |
| tsunami | 予報の見出し（EventID・区分・第 N 報・発表時刻・WarningComment・読めない印・状態の印・落としたコードの無い予報区の数） | 同時の EventID を 3（**作者に聞ける**、§6 の D-B0-TSUNAMI-COUNT。unit は 512 件まで持つ、`tsunami-unit.ts:33`） | 4 件目からは予報区の行を wire に載せず、件数を出す。塗りの合成には全件が入る。行を残す順は、最も重い区分（大津波警報 → 津波警報 → 津波注意報 → 津波予報）が上、同じ区分は新しい発表が上。落とした EventID は U-T の詳細の索引で読む（§2） | 2,305（WarningComment 2,048 byte を含む） | — |
| tsunami | 予報区の行（コード・区分・第 1 波・最大の高さ。予報区名は G0:37 の D から引く） | EventID ごとに 66（G0:37） | 超えない | 219 | — |
| tsunami | コードの無い予報区の行（名前で出す、`p3-tsunami-unit.types.ts:60`〜`:61`） | EventID ごとに 8（案。unit に件数の上限は無く、保存の世代の上限 `tsunami-unit.ts:37`〜`:39` だけで効く） | 9 行目からは件数を出し、詳細で読む。残す順は区分の重い順 | 358 | — |
| tsunami | 予報の塗りの合成・観測の予報区ごとの最大の合成 | 各 66 | 超えない | 22・34 | 2 枚で 3,848（落とした件数の欄を含む） |
| tsunami | 観測の表（観測点ごとの値） | wire に載せず、詳細の API（§2 の U-T）へ回す（r3 §1.2: 611 点を送ると ＋296,946 で入らない） | — | — | 0 |
| tsunami | 合計 | — | — | EventID 1 件 19,699 | T＝1 23,547、T＝2 43,246、T＝3 62,945 |
| earthquake | 今日の地震の行（最大震度・震源名・M か description・深さ・発生時刻・津波の評価の文・取消・状態の印） | 運用区分ごとに 5 行、3 区分で 15 行（今の `RECENT_LIMIT = 5`、`seismic-unit.ts:54`。**板待ち**: C0 の板） | 6 行目は unit が持たない（今の当日履歴は新しい 5 行だけ）。D-R58=A のページ送りで 6 行目からを読ませるなら unit の上限から上げる | 1,234 | 15 行で 18,526 |
| earthquake | 観測の震度の塗りの合成 | 市区町村 1,894（仮。**板待ち**: M0-1、計画:691） | 超えない | 14 | 28,411（細分区域 188 なら 2,069） |
| earthquake | 長周期の見出しと区域の塗りの合成 | 見出し 2 件（仮）、塗りは細分区域 188（**板待ち**: DS に部品が無い） | 3 件目からは新しい 2 件を残し、件数を出す | 189・10 | 2,285（件数の欄を含む） |
| earthquake | 合計 | — | — | — | 市区町村の粒度で 49,222、細分区域で 22,880 |
| 3 分野共通 | wrapper（unit・contentRevision・運用区分ごとの 3 行） | 分野ごとに 1 | — | 3,734（r2 §2 の W、`p2-snapshot-sse.json:359`） | 11,202 |
| 3 分野共通 | 読めない報のカード（H43） | 分野ごとに 8 枚（`checkpoint.ts:689`〜`:690`） | 古いカードから外す（`owner-runtime.ts:220`〜`:236`、r3 §3） | 今の長さで 1 本 28,276（1 枚 3,531 のうち題と見出しが各 1,536 byte、`checkpoint.ts:688` の CARD_TEXT）。wire で題 96 byte・見出し 384 byte にすると 1 本 7,540（§1.2、§6 の D-B0-CARD-TEXT） | 84,828（短くすると 22,620） |

- 段の番号: 0〜9 が震度 0・1・2・3・4・5弱・5強・6弱・6強・7。カードの欄は「以上」（To が over）を ＋10 で持つ（例 15 は「5弱以上」）。合成は「以上」を持たない（塗りは上の値、DS-MAP-12）。
- 合成の −1: From・To が unknown・empty で、既知の段を持つ地震が 1 つも無い区域。無いと、段の分からない区域が塗りなしに見え、DS-ALL-14（未確認を「なし」にしない）に反する。既知の段を持つ地震が 1 つでもあれば、その最大で塗る。描き方は M0・E0 の板で決める。
- 状態の印（未確認・復元・期限待ち・容量で入らなかった）: C2 が描く値を B0 が作る（計画:126）。カード・行・見出しごとに語の配列で持つ。
- wire に載せない欄: view の `semanticRevision`（決め 2、EEW の 1,024 gate で 60,415）、U-Q の `daily.counted`（決め 2）、view の `subjects`（画面が読まない、r3 §4）、地震ごとの震度の一覧（詳細の API へ、§2 の U-Q）。

件数の上限が画面の決まりから来ない 5 つの印のまとめ:

| 項 | 仮の数 | 印 | 1 つ増やすと |
|---|---|---|---|
| 運用区分 | 3 区分を同じ C に数え、合成は区分ごと | 作者に聞ける | 区分ごとに大カードを持たせると ＋2 × 25,932 で、組 A は 285,993 になり入らない |
| 津波の同時件数 | 3 | 作者に聞ける | 4 件目で ＋19,699（組 A は 253,828 で入る、余り 8,316） |
| 6 枚とも最終報の前の 7 件目 | 合成にだけ入れ、件数を出す | 板待ち（E0-1） | wire の byte は増えない（合成は全件から作る） |
| 今日の地震の行数 | 3 区分 × 5 | 板待ち（C0） | 1 行 ＋1,235 |
| 長周期 | 見出し 2・塗り 188 | 板待ち | 見出し 1 件 ＋190 |

### 1.2 文字列の上限（B0 が真実源、台帳 50）

上限は byte で置き、切るときは今の `wellFormedPrefix`（`view-projector.ts:658`）で UTF-8 の字の境で切り、欄ごとに切った印（`cut: true`）を付ける。
印の無い切り詰めは H34・H51 に反するので作らない。
コードの決まった値は、字でなくコードで送れる欄がある。その欄は 2 行に分けた。

| 文字列 | 上限（案） | 出どころ（今の上限） | 切ると画面から消えるもの | 残す順 |
|---|---|---|---|---|
| 震源名（EEW の Hypocenter/Area/Name、地震の行の hypocenterName） | 192 byte（64 字） | 地震の行の 64 字（`seismic-unit.ts:477`、型のコメント `p3-seismic-unit.types.ts:149`〜`:150`）に EEW も揃える。EEW は今 view に無い | 65 字目から後。震央地名の表の名前は 64 字より十分短い（最長の名を数えていない、未確認） | 頭から |
| M・深さの値の生の字 | 32 byte | 地震の行の magnitude の 32 字（`p3-seismic-unit.types.ts:150`） | 33 byte 目から後 | 頭から |
| M の description（「Ｍ８を超える巨大地震」） | 96 byte（32 字） | 同上 | 33 字目から後 | 頭から |
| 深さの description（「ごく浅い」「深さは７００ｋｍ以上」） | 96 byte（32 字） | 今 wire に無い（読み通し Q52-02） | 同上 | 頭から |
| 最大予測震度のみの報の場所の文 | 192 byte（64 字） | 今 wire に無い（計画:257〜:258） | 65 字目から後。DS は大カードで 12 字 1 行（DS-EEW-10）、小カードで 2 行（DS-EEWS-07） | 頭から |
| EEW の区域の Condition（コードで送る、統合担当の決め） | 字を送らず、`arrived`（「既に主要動到達と推測」）・`unknown`（表に無い値）・null（要素が無い）の 3 つ。描画の側が `arrived` を電文の字に戻す | 資料の値は 1 つだけ（解説:4613 の 2-1-5-3-7、値「既に主要動到達と推測」。この要素がある区域では ArrivalTime が出ない、:4617〜:4618） | 消えない（画面の字は今と同じ） | — |
| 同上の表に無い値（H51） | 黙って断らず、`unknown` にして区域の行に「区分不明」の印を出す。字は wire に載せず、原文は unit が持つ読めなかった所の印（H51 の折り畳み）で読む | — | その区域の Condition の字（印に置き換わる） | — |
| 到達予想時刻・発表時刻・発生時刻の生の字 | 40 byte | 地震の行の 40 文字で null にする規則（`p3-seismic-unit.types.ts:149`） | 時刻の字が出ず「時刻の不明」になる（P2-A9-AC10 の区別のまま） | — |
| 津波の WarningComment | 2,048 byte（約 680 字） | parser の 16,384 字。実測 1,796 byte（r3 §6） | 2,049 byte 目から後。全文は U-T の詳細（本文 1 件）で読む（§2）。**作者に見せる**（§6 の D-B0-TSUNAMI-COMMENT） | 頭から |
| 津波の第 1 波の状況の字（「第１波の到達を確認」など） | 48 byte（16 字） | parser の 16,384 字 | 17 字目から後 | 頭から |
| 津波の最大の高さの字（「巨大」「１０ｍ超」）と観測の最大の高さの字 | 24 byte（8 字） | 同上 | 9 字目から後 | 頭から |
| コードの無い予報区の名前 | 192 byte（64 字） | 同上 | 65 字目から後 | 頭から |
| コードの無い予報区の区分名（Kind/Name） | 96 byte（32 字） | 同上 | 33 字目から後 | 頭から |
| 今日の地震の津波の評価の文 | 384 byte（128 字） | 今の行の wire に無い。event の view の `tsunamiComment.text` は parser の 16,384 字 | 129 字目から後。DS-QROW-07 の例は 11 字 | 頭から。津波のコードの文だけを使い、EEW の付加文（0241 など）を混ぜない（読み通し Q53-09） |
| 読めない報のカードの題（Head/Title、wire だけ） | 96 byte（32 字）。保存の上限 1,536 byte（`checkpoint.ts:688`）は変えない | 保存と同じ 1,536 byte（`unreadable.ts:71`〜`:78` の textOf、r3 §3） | 33 字目から後。情報の題は「震源・震度に関する情報」で 11 字ほどなので、ふつうは消えない（実電文の最長は数えていない） | 頭から。全文は原文を開く形（H51、P4）で読む |
| 読めない報のカードの見出し（Head/Headline/Text、wire だけ） | 384 byte（128 字）。保存の上限は変えない | 同上 | 129 字目から後。長い見出しの報（津波・気象の警報の見出しなど）では文の後ろが画面のカードから消え、切った印が付く。**作者に見せる**（§6 の D-B0-CARD-TEXT） | 頭から。全文は原文を開く形で読む |

区域名・予報区名・市区町村名・府県名は wire に載せない（決め 1、計画 §5.3 の即断候補 C の A）。
震源名は G0 に震央地名の表が無い（r2 §5）ので wire に載せる。

### 1.3 保護 3 分野の合計と 262,144

| 組 | EEW | 津波 | 地震 | wrapper＋カード | 合計 | 余り |
|---|---|---|---|---|---|---|
| A: 津波 3 件・行 15・市区町村の塗り・Condition はコード・カードは今の長さ | 25,932 | 62,945 | 49,222 | 96,030 | **234,129** | **28,015** |
| A短: A のカードの題 96 byte・見出し 384 byte（D-B0-CARD-TEXT の A） | 25,932 | 62,945 | 49,222 | 33,822 | 171,921 | 90,223 |
| B: A の塗りを細分区域で | 25,932 | 62,945 | 22,880 | 96,030 | 207,787 | 54,357 |
| C: A の津波を 2 件で | 25,932 | 43,246 | 49,222 | 96,030 | 214,430 | 47,714 |

- 型の最大値の試験（決め 4）は組 A（D-B0-CARD-TEXT が A になれば組 A短）の形で組み、文字列はどれも §1.2 の上限いっぱいにする。
- 合計は付録 A の欄の形を直列化した値で、projector に通していない。projector の形ができたら同じ組を通して数え直す。
- 「wrapper＋カード」の列は wrapper 3 本（11,202）と読めない報のカード 3 本（今の長さで 84,828、短くすると 22,620）の和。r0 の合計にもカードは入っていた。
- r0 で Condition を字（上限 48 byte）で送ったときの組 A は 245,785（余り 16,359）だった。区域の欄を [コード, 段, 以上] の 3 つの値にし、Condition を字で 96 byte にすると 263,889 で越える。
- r3 §1.2 の組 A（263,608）は区域名を行に持ち、Condition を fixture の実寸で数えている。ここでは区域名を外し、Condition を上限で数えた。

### 1.4 残りの 9 分野と共通部

- 9 分野は B1 の表（計画 §4.3 の 1）で予算内の full か要約の max を数える。B0 が持つのは、要約のときの最初の取得の参照（§2）と文字列の上限の真実源だけ。
- 共通部（64 KiB、spec §8.3）に、退去の理由・件数の不明・通知の結果の不明（H17・H39）を分野ごとの数で置く。上界は 12 分野 × 理由の語の数で決まり、字を持たない。

## 2. 分野ごとの詳細の形（計画 §4.1 の表）

- owner は実行の場所（`unit-coverage.ts:15`〜`:17`）。HTTP は `GET /api/display/domains/{unit}/detail`（spec:1336 の 1）。
- 境界型は `OwnerRequest` の `detail` と `OwnerReply` の `detailDone`（`p3-execution-split.types.ts:73`・`:142`）に足す union の腕。
- S0 の client は 1 つで、同時 1 件・現在のページだけ（spec:1342）。応答の payload は表示語彙の行にし、ブラウザが分野の名前で分岐しない形にする（R46。§7 の I-B0-DETAIL-PAYLOAD）。
- 「要求を出す契約と起点」は、S0 の client を呼ぶカードの契約と、要求を出すきっかけ。

| 分野（unit） | 形 | 要約になったときの最初の要求の参照と版 | 境界型（worker の要求型） | owner | HTTP | 要求を出す契約と起点 |
|---|---|---|---|---|---|---|
| eew（U-E） | 取得不要（カードと一覧が全部 wire にある） | 要約にしない（H37） | なし | urgent | なし | なし |
| tsunami（U-T） | 概要＋索引とページ（観測の表、wire に載せなかった EventID）＋本文 1 件（WarningComment の全文） | 要約にしない（H37） | 新: `{ unit: "U-T", part: "index" \| "stations" \| "comment", id?, revision, page? }` | urgent | 新: `/api/display/domains/U-T/detail` | T0。観測の表を開く操作、切った印からの全文 |
| earthquake（U-Q） | 概要＋索引とページ（地震ごとの震度の一覧。観測点は今も view に無い、`seismic-unit.ts:257`・`:266`） | 要約にしない（H37） | 新: `{ unit: "U-Q", part: "index" \| "event", id?, revision, page }` | seismic | 新: `/api/display/domains/U-Q/detail` | C0 発注 2。今日の地震の行から詳細を開く操作 |
| weatherCurrent（U-W） | 索引とページ（既存） | `part=index`・`revision=contentRevision`（既存、spec:1336） | `WeatherCurrentDetailRequest`（既存） | weatherCurrent | 既存（`http-sse.ts:268`） | C0。府県のページを開くとき |
| weatherTimeseries（U-F） | 索引とページ（既存） | 同上（既存、`p3-uf-public.json:78`） | `WeatherTimeseriesDetailRequest`（既存） | deferred | 既存（`http-sse.ts:30`） | C1 |
| nankai（U-N） | 本文 1 件（既存）＋索引（新） | 新: `part=index`・`revision=contentRevision`・`page` | `BulletinTextRequest` に `part: "index"` を足す | urgent | 既存（`http-sse.ts:290`） | C1。到着時かクリックかは C1-1（計画:695） |
| volcano（U-V） | 同上 | 同上 | 同上 | urgent | 同上 | 同上 |
| localBulletins（U-M） | 概要＋本文 1 件（地震の解説 VXSE56・VXSE60・VZSE40、計画:177）＋索引 | 同上 | `BulletinTextRequest` の unit に `"U-M"` を足す | deferred | 新: `/api/display/domains/U-M/detail` | 同上 |
| landslide（U-L） | 概要（full）＋索引とページ（要約のときだけ使う） | `part=index`・`revision=contentRevision`・`page` | 新: `{ unit: "U-L", part: "index", revision, page }`（ページの項目は今の view の現況の要素） | deferred | 新 | C1。要約の「詳細は個別取得」からの操作（spec:1330） |
| flood（U-R） | 同上（水位のミニグラフは専用部品、R51） | 同上 | 同上（unit: "U-R"） | deferred | 新 | 同上 |
| briefing（U-B） | 同上 | 同上 | 同上（unit: "U-B"） | deferred | 新 | 同上 |
| typhoon（U-Y） | 同上（予報円は専用部品、R50） | 同上 | 同上（unit: "U-Y"） | deferred | 新 | 同上 |

U-N・U-V の要約に subject が無い件（r2 §2）の扱い:
- 本文の要求は view の `subject` と `revision` を渡す（spec:1339 の 4）。要約は subject を持たない（`p2-snapshot-sse.types.ts:63` の「no subject identifiers on wire」）。
- subject と revision の組は 1 組 約 170 byte で、U-N の情報は 64 件（`nankai-unit.ts:31`）、U-V の解説は 64 件（`volcano-unit.ts:35`）。64 × 170 ＝ 約 10.9 KB で、要約 4 KiB（spec §8.3）に入らない。
- そこで、U-F・U-W と同じ `part=index` を足し、要約の `contentRevision` から索引の 1 ページを取り、そこから本文を取る形にする。無いと、要約になった火山・南海トラフのカードから本文を開けない。

urgent の場所の詳細（U-T・U-N・U-V）の注意: 開始済みの射影の非中断区間も E01 の負荷条件に含める（spec:1288）。U-T の観測の表のページは EEW と同じ owner で作るので、1 ページの上限（64 KiB）の区間を PM の測定に入れる。

## 3. 新旧の wire の切替点

chrome-eew は、次を満たさない snapshot を丸ごと捨てる（`pure.ts:395`〜`:407`）: `schemaVersion === 1`、トップレベルの `semanticRevision` が string、`current.eew`・`current.tsunami` が unit・contentRevision・items 3 行と、full なら `view.current`・`view.forecasts` を持つ。
決め 2 が外すのは view の `semanticRevision`（`p2-shared-runtime.types.ts:196`）で、トップレベルの `semanticRevision`（`p2-snapshot-sse.types.ts:115`、作るのは `view-projector.ts:887`）は残す。
そこで、T0 までは 1 本の snapshot に旧形の `current.eew`・`current.tsunami`（schemaVersion 1 のまま）と新しい表示語彙（新しい欄 `display`、自分の版を持つ）を並べる（§7 の I-B0-LEGACY）。
`current.<分野>.view` を読む所は、`reconstruction/src`・`tools` では chrome-eew だけで、`reconstruction/test` に 35 file ある（10 分野を読むのは 24 file、eew・tsunami を読むのは 17 file）。B0 で 10 分野の旧 view を消すと、その 24 file の期待を直すことになる。

| 配送 | 読める組（producer → client） | 製品の入口 `/` | 旧形の欄 | 262,144 の試験が測るもの | 移行中の 1 MiB の合計 |
|---|---|---|---|---|---|
| 今（P3 の後） | 旧 projector → chrome-eew | chrome-eew（`host.ts:95`〜`:96`） | 12 分野の旧 view | — | 今のまま |
| B0 | B0 の projector → chrome-eew（`current.eew`・`current.tsunami`）、→ 新しい描画（`display`。S0 までは試験の client だけ） | chrome-eew | U-E・U-T の旧 view だけ残し、ほかの 10 分野の旧 view は消す（計画:208〜:209） | `display` の保護 3 分野だけ | 旧 U-E・U-T の view が上乗せされる。旧 U-E の view は semanticRevision だけで最大 60,415（r2 §4）、U-T は 43,135（r3 §4）。B0 の試験は旧形の分を別の行で数え、1 MiB 以下を示す |
| B1 | 同上 | chrome-eew | 同上 | 同上 | 同上（B1 の上界の式は `display` で数え、旧形の分は T0 まで別の行） |
| S0 | 同上。新しい描画の骨組みを別の path に出す最小の経路は B0 が `http-sse.ts` に作る（計画:229） | chrome-eew | 同上 | 同上 | 同上 |
| E0 発注 2 | 同上。EEW の runner を新しい描画の path へ向ける | chrome-eew | 同上 | 同上 | 同上 |
| T0 | B0 の projector → 新しい描画だけ | 新しい描画（`/` を切り替える） | U-E・U-T の旧 view を消し、`schemaVersion` を上げる。chrome-eew は版の不一致で捨てる（`pure.ts:396`）ので、T0 で chrome-eew の path を外す | 同上 | 旧形の上乗せが消える |
| FG | 同上 | 同上 | 旧の資材・設定・anchor を消すだけ（計画 §1.3） | 同上 | — |

schema 版の不一致: 新しい描画は `display` の版が自分の版でなければ、未知の payload を描かず「非対応」を出す（spec §8.3 の最後の行）。

## 4. 配送済みの契約を変える表（計画 §2.3 を詳しく）

- 「«» の行」は、契約の JSON などで `<path>:<行> «sha»` の形で引く行の数（checker が中身を照合する）。eew.ts 135・seismic-unit.ts 146・tsunami-unit.ts 104 で、別の子の値と一致した。
- 依頼文の `git grep -n "<path>:[0-9]"` は 137・147・105 になる。差は «» を持たない本文の参照で、次の行である。
  - eew.ts: `p3-persist-premises.md:37` と `p4-order-plan.md:174`。
  - seismic-unit.ts: `p3-persist-premises.md:31`。
  - tsunami-unit.ts: `p3-recovery.json:676`（«» の形でない書き方）。
- 「本文の短い参照」は、`eew.ts:191` のように path を略した本文の参照の行の数（checker は見ない）。
- 「ずれる」は、変える所に行を足したときに番号が動く «» の行（refs）。「中身」は、変える行そのものを引く «» の行で、行の字を変えると sha が外れる。

| 変える契約 | 変える file と所 | «» の行／本文の短い参照 | 行を足すと ずれる／中身 | 行を足さない書き方 | 運ぶ P4 の契約 | 永続 schema |
|---|---|---|---|---|---|---|
| `P2-SNAPSHOT-SSE-001` | `p2-snapshot-sse.types.ts`（`display` の欄） | 21／12 | :215 より後に置けば 0／0 | 表示語彙の型は新しい file（`p4-display-wire.types.ts`）に置く。この file は `DisplaySnapshot`（:110。中の :111・:121・:124 は «» で引かれる）の :135（`notices` の行、«» に無い）の末尾に 1 欄を足すだけ | B0 | 無し |
| 同上 | `view-projector.ts`（表示語彙の射影・合成 1 枚・文字列の上限） | 93／47 | :38 に足すと 54 行 78 refs ずれる。:906 は中身 7 refs | 射影は新しい file（`reconstruction/src/view-projector/display-wire.ts`）に置き、`projectSnapshot` からの呼び出しを «» に無い行の末尾に 1 つ足す。`STRING_BYTES`（:38）は動かさず、新しい file の上限の表を「表示用の文字列上限」の真実源にする | B0 → B1 → C2 | 無し |
| 同上 | `http-sse.ts`（詳細の経路 7 本・新しい描画の path） | 20／21 | :258 より後に置けば 0。経路を振る :208 は中身 1 ref | 経路の表と parse は :258 より後に足し、:208 は reanchor 1 件 | B0 | 無し |
| `P2-EEW-UNIT-001` | `p2-eew-unit.types.ts`（`EewCurrent` に震源名・M・深さ・検知だけの報・場所の文） | 7／8 | :48 に足すと 4 行 6 refs ずれる | `EewCurrent` の :47（`isAssumedHypocenter` の行、«» に無い）の末尾に足す。前例は同じ行の `reportAreas` | B0 | 無し（EEW の current は保存しない、spec:1325） |
| 同上 | `eew.ts`（Body/Text を非取消でも読む・欄を current に載せる） | 135／65 | :462 に足すと 49 行 87 refs、:828 に足すと 1 行 1 ref ずれる | 読む関数は最後の行（:836、中身 1 ref）より後に足す。current を作る :460・:461・:462 は中身 1・1・2 refs なので、«» に無い :463 の末尾に欄を足す | B0 | 無し |
| `P3-EEW-FACTS-001` | 契約の文だけ（`p3-eew-facts.json:237` の「areas のほかの facts を view に置かない」に例外を足す） | types は 1／3 | — | types は変えない（view に置く欄は `EewCurrent` の側に足す） | B0 | 無し |
| `P3-UNIT-Q-001` | `p3-seismic-unit.types.ts`（`SeismicRecentQuake` に深さ・description・津波の評価の文） | 3／2 | :159 に足すと 1 行 1 ref | :158 の末尾に足す | B0 | **有り**: `daily.recent` は保存する（`seismic-unit.ts:1671`）。版を上げ、P5 の前なので開発の保存は初期化する（p3plan:498）。1 行の上界 1,206 byte（`p3-seismic-unit.types.ts:150`）と capacityReserve を直す |
| 同上 | `seismic-unit.ts`（行を作る所 :475〜:479） | 146／55 | :478 に足すと 75 行 109 refs | :477〜:479 は «» に無いので、その行の末尾に足す | B0 → E0 発注 1 → N0 | 同上 |
| `P3-EXECUTION-SPLIT-001` | `p3-execution-split.types.ts`（`detail`・`detailDone` の union） | 21／16 | 変える行そのものが :73（中身 1 ref）と :142（中身 2 refs） | 新しい要求型を 1 つの別名にまとめて新しい file に置き、:73・:142 はその別名を足すだけにする。reanchor 3 件は避けられない | B0 | 無し |
| 同上（owner の振り分け） | `owner-runtime.ts`（`detailOwner` :737） | 76／67 | :737 は中身 1 ref、後ろに足すと 1 行 1 ref | 新しい分野の振り分けは file の最後（:776 より後）の関数に置き、:737 は reanchor 1 件 | B0 | 無し |
| `P3-UNIT-M-001`・`P3-BULLETIN-TEXT-API-001` | `local-bulletins.ts`（Body を読む）・`local-bulletins-unit.ts`・`p3-bulletin-text-api.types.ts` | 11／7・20／26・0／2 | local-bulletins.ts の :314〜:352 より後に «» は無い（0）。unit は :760 より後で 0 | 足す所はどれも最後の «» より後 | B0（C1 が描く） | 本文を保存しないなら無し（要確認） |
| `P3-TSUNAMI-UNIT-001` | `p3-tsunami-unit.types.ts`（観測の表が期限で閉じた印）・`tsunami-unit.ts` の `toTsunamiView`（:947〜:953） | 0／0・104／52 | types は 0。:947 は中身 4 refs、:947 より後に足すと 15 行 16 refs | types は自由に足せる。view の object の :950 は中身 1 ref なので、«» に無い :953（`observations` の行）の末尾に足す | B0 → N0 → T0 | 無し: 期限切れの観測は `effective: "expired"` と `validUntil` を持って保存に残る（`p3-tsunami-unit.types.ts:107`〜`:117`・`:148`〜`:155`）。閉じた印は保存の中身から作れる |
| `P3-LIFETIME-AND-EEW-GATE-001`・`P2-EEW-UNIT-001`（寿命） | `eew.ts:462`（最終報で current から外す） | 135（eew.ts） | :462 は中身 2 refs | B0 の範囲外（E0） | E0 | 無し |
| `P3-INT7-COLOR-001` | 新しいディスプレイの震度 7 | — | — | B0 の範囲外 | E0・M0 | 無し |
| `P3-UNIT-V-001`・`P3-CLI-REPL-001`・`P2-NOTIFICATION-DELIVERY-001`・`P2-CHROME-EEW-001` | 計画 §2.3 のとおり | 数えていない | — | B0 の範囲外 | C1・N0・R0・E0・T0・FG | 計画のとおり |

## 5. 問いの答え

### 5.1 合成の更新の計算量

- 今の `eewTally`（`view-projector.ts:181`〜`:193`）は、current の区域ごとに `op|eewArea|code` を 1 つ数え、`applyRefs`（`:488`）で変わった subject の分だけ足し引きする（P2-A8-COST）。
- 合成は、同じ足し引きに鍵 `op|eewPaint|code|段` の参照数の Map を 1 つ足して作る。段は塗りの値で、To が数か字ならその値、To が over か欠けなら From（DS-MAP-12・DS-EEW-09）。段の分からない区域は鍵 `op|eewPaint|code|?` で数え、既知の段の参照が 0 のときだけ合成に −1 を出す。
- 区域ごとの最大の段は、その区域の段の参照数を上から見て最初の 0 でない段。段は 10（0〜4・5弱・5強・6弱・6強・7）なので、1 区域 10 回。
- 最大の段を持っていた地震が取消・期限切れになると、その地震の区域の参照数を引き、引いた区域だけ上から見直す。手間はその地震の区域数 × 10 で、ほかの EEW を走査しない。
- 合成の配列は、見直した区域だけ書き換えた Map から公開ごとに 188 件で組む。188 は区域の数で決まる上界で、EEW の件数に比例しない。
- 無いと壊れる振る舞い: 合成を公開ごとに全 EEW から作り直すと、1,024 gate の付近で受信 1 回が全件 × 区域の走査になる（AGENTS.md の受信経路の計算量）。

### 5.2 台帳 98（Intensity の無い報、`eew.ts:191`〜`:194`）

- 対象は、解説:4176〜:4183 が Intensity を出さないとする報のうち 2 つ: 震源の深さが 150km より深く推定された報（PLUM 法による 2 点以上での震度予測がある場合を除く）と、観測点 1 点による震度予測の報。取消とリアルタイム震度電文は対象外。最大予測震度のみの報は別の条件で、Intensity を持つ（§5.4）。
- 今は非取消で Intensity・Forecast・全体の ForecastInt が無いと `requiredStructureMissing` で断る（`eew.ts:191`〜`:194`、契約 `p2-eew-unit.json:93`〜`:101` の required）。
- 受け取るとき、予測を `maximum` の From・To とも `{ kind: "missing" }`、`areaCoverage: "none"`、`areas: []` で持てば、`EewPrediction`（`p2-eew-unit.types.ts:31`〜`:35`）の型は変わらない。`MaterialValue` は missing を持つ（`p1-parser-boundary.types.ts:58`）。
- その形が通るかを読んだ所:
  - `hasKnownPrediction`（`eew.ts:239`〜`:244`）は偽になり、前の報の予測を `retainedPrediction` に残す（`:452`〜`:456`）。深い地震の続報で前の予測を消さない。
  - `eewTally` は区域が空なので塗りを足さない（`view-projector.ts:189`〜`:190`）。
  - `eewReportFacts`（`eew.ts:783`〜）は引数の `forecast` に null を受ける（:785〜:791 の `text`・`lgInt` は親が null なら null を返す）。区域の組み立ての所は読んでいない。
- 直す行:
  - :191 の条件を緩めても、:195 の `intensityNodes.length !== 1` が 0 件を `requiredStructureInvalid` で断る。:201 は `maximumNodes[0]` を読む。
  - 通知の字を作る :628〜:633 は、`candidate.prediction != null` のとき `forecast!` から ForecastInt の node を引く（:632〜:633）。Intensity の無い報では `forecast` が null なので、直さないと例外になる。
  - 行を足さずに書き換えれば、«» で引かれるのは :191 の 1 件（ほかに :206・:630 も «» で引かれるが、書き換える行ではない）。行を足すと :191 から後の 73 行 122 refs がずれる。
- 結論: view の型は変わらないので、計画:172 の行には足さず、別の小さい契約にする（P2-EEW-UNIT-001 の familyTable の required の改訂と、上の行の直し。H51）。
  - 画面に出すかは A で確定（統合担当）。受けて記録と通知の判定にだけ使いカードを出さない形は、H51 の「診断の 1 行だけを残して画面に何も残さない拒否は、この決まりに反する」（spec §16.4、spec:3204）に当たるので選ばない。最大予測震度の札に何の字を出すかは E0 の板で決める。通知の字は N0。

### 5.3 設定した地域

- 1 件のとき: 大カードの区域の行が全区域を持つので、描画の側で「設定した地域（市区町村）→ 細分区域のコード → 行」を引ける。市区町村はどれも細分区域 1 つだけに属する（G0:51 の I-1）。
- 2 件以上のとき: 出ているカードごとの [コード, 段の番号] から同じく引ける。計画:259 は変えずに済む（r3 §2.2 と同じ結論、統合担当が採った）。
  - 「以上」を段の番号に含めないと、設定した地域の札と一覧の札の 2 段（DS-INT-08・DS-INT-10）が引けない（§1.1 の段の番号）。
- 2 件のときの上位 2 行（DS-EEWS-10）は、到達予想時刻か Condition が要るので [コード, 段の番号] からは引けない。projector が上位 2 行を大カードの行の形で作る（§1.1、C＝2 で 8,921 に込み）。
- 仮定震源要素の報で PLUM の区域だけに札を出す決まり（DS-EEW-06）が、小さいカードの設定した地域の札にも効くかは DS に書かれていない（未確認）。効くなら最小の欄に PLUM の印（区域の Kind/Code の下 1 桁が 9、読み通し E-17）が要る。E0 の板で決める。
- 地域設定の置き場は R0 が決める。D-REMOTE=B で画面は Pi の中の 1 つだけなので、描画の側が読む地域設定は 1 つ。
- 札の字 A〜F と「出ているカード」は projector が決める（D-B0-LETTER=A、統合担当の確定）。描画の側で振ると、読み込み直しで札の字が変わり、DS-LAYOUT-06・DS-EEWS-04（並びは出た順で固定）に反する。
  - 選ぶ規則（DS-LAYOUT-07 と E0-1）が projector に入り、E0 が `display-wire.ts` を触る。計画の改訂は §9 に置く。

### 5.4 最大予測震度のみの報

資料の原文で確かめた形（解説資料、統合担当の照合と一致した）:

- 出る要素: Intensity（解説:4176〜:4183 の「出現しない」4 条件に、この報は入っていない）、Forecast の下の ForecastInt（「1 回」、解説:4221〜:4224）、Body/Text（観測点の所在地、解説:4759〜:4763）。
- 出ない要素: OriginTime（解説:3910〜:3915）と Pref（解説:4391〜:4396）。
- ForecastInt の値: From・To は通常同じ値で、「～程度以上」のときは To が over（解説:4221〜:4224・:4253〜:4255）。資料の事例は「最大震度５弱程度以上と推定」（解説:4773〜:4779）。
- 種類: 緊急地震速報（地震動予報）と緊急地震速報（予報）だけ（解説:3910・:4393・:4760）。警報（VXSE43）では出ない。

今の新築での扱い:

- VXSE45 では今も受け取れる。全体の ForecastInt があり、区域 0 件は VXSE45 で合法（`eew.ts:191`〜`:198`、契約 `p2-eew-unit.json` の VXSE45 の legalMissing）。予測は `areaCoverage: "none"` で current に載る。
- `eew.ts:192` の「VXSE43 で区域 0 件は断る」には掛からない（この報は VXSE43 で出ない）。
- 緊急地震速報（予報）の VXSE44 は、A1 の入口で無視している（`unit-coverage.ts:34`、R27「新築では非対応」）。予報の形で来たこの報は届かない。地震動予報（VXSE45）で同じ報が来るかは確かめていない。読み通し E-01 の名の食い違いと同じ根で、B0 では扱わない。

wire に足すもの:

- 場所の文: `EewCurrent` に、非取消の Body/Text から切り出した字を足す（§4 の P2-EEW-UNIT-001 の行、上限は §1.2 の 192 byte）。
  - 今は Body/Text を取消のときだけ読む（`eew.ts:828` の `cancelText`）。
  - 資料の事例の Text は 2 行で、1 行目が検知の時刻、2 行目が「千葉県銚子市付近」と空白の並びと「最大震度５弱程度以上と推定」（解説:4773〜:4779）。DS-EEW-11 は検知の時刻と「最大震度５弱程度以上と推定」を出さないので、2 行目の空白の並びの前を場所の文として切り出す案になる。
  - この規則の根拠は資料の事例 2 つだけで、公式サンプルと fixture に実例は 0 件（読み通し §7）。
  - 切り出せないときは場所の文を null にし、画面は場所の行を詰める（DS-EEWS-08。大カードは E0-5）。
- この報だという真偽（付録 A の `detectOnly`）: 電文に専用の印は無い（読み通し E-04）。「非取消で Body/Text がある」かつ「OriginTime が無い」で判定する。OriginTime は今 facts にしか無い（`p3-eew-facts.types.ts:21`）ので、unit が判定して `EewCurrent` に真偽を 1 つ足す。無いと、M・深さ・予測地域の行を出さない決まり（DS-EEW-11・DS-EEWS-07）と、地図に何も出さない決まり（DS-MAP-09）を描画の側が選べない。
- 「以上」の値の出どころ: 今の `prediction.maximum`（From 5-、To over）で足りる。chrome-eew も To の生の字が over かで読んでいる（`pure.ts:77`〜`:78`）。新しい欄は要らない。

## 6. 作者の分岐の候補（画面の出る／出ないが変わるもの）

| ID | 問い | ★推奨 | もう一方 |
|---|---|---|---|
| D-B0-OPERATION | 訓練・試験の EEW と津波をどう出すか | ★A 通常と同じ数え方にする。カードは 6 枚に一緒に数え、地図の塗りは運用区分ごとに分けて送る（3 区分が同時でも保護 3 分野に入る） | B 区分ごとに大カードと塗りを持つ（＋2 × 25,932 で組 A は 285,993 になり、262,144 に入らない） |
| D-B0-TSUNAMI-COMMENT | 津波の WarningComment が 2,048 byte を超えたとき | ★A 頭から 2,048 byte を出して切った印を付け、全文は詳細で読む | B 上限を置かない（16,384 字では保護 3 分野がどの組でも入らない、r3 §6） |
| D-B0-TSUNAMI-COUNT | 同時に全部を出す津波の EventID の数 | ★A 3 件（組 A の余り 28,015、組 A短なら 90,223。余りは鍵の付け方で数千 byte 動くので、型の最大値の試験で越えたら B に下げる） | B 2 件（組 C の余り 47,714。3 件目からは予報区の行を wire に載せず、塗りの合成と件数だけになり、行は詳細で読む） |
| D-B0-CARD-TEXT | 読めない報のカード（H43）の題と見出しを、画面へ送るときに短くするか（保存の上限 1,536 byte は変えない） | ★A 題 32 字・見出し 128 字で切り、切った印を付ける。全文は原文を開く形（H51）で読む。保護 3 分野の余りが 28,015 から 90,223 に広がる。消えるのは、見出しの 129 字目から後（長い見出しの報で、文の後ろがカードに出ず印が付く）と、題の 33 字目から後（実際の題は 11 字ほどで、ふつうは消えない） | B 今の 1,536 byte のまま送る（長い見出しもカードにそのまま出る。余りは 28,015） |

D-B0-LETTER（A）と D-B0-NO-INTENSITY（A）は統合担当が確定したので外した（§5.3・§5.2）。
観測の震度の塗りの粒度（M0-1）・今日の地震の行数（C0）・7 件目の EEW（E0-1）・長周期は板待ちなので、ここには入れない。

## 7. 統合担当の決めの候補（技術の細部）

- I-B0-LEGACY: T0 まで旧形と新しい語彙を ★A 1 本の snapshot に並べる（直列化は公開ごとに 1 回のまま）／B SSE を 2 本にする（公開ごとに直列化が 2 回、台帳 54）。
- I-B0-DETAIL-PAYLOAD: 詳細の応答を ★A worker の側で分野の DTO から表示語彙の行にして返す（R46、ブラウザが分野で分岐しない）／B 分野の DTO の union のまま返す（spec:1268 の字どおり）。A でも境界型（worker の要求と応答）は分野の DTO の union で、spec:1268 の「許可 field・行／項目境界・最大数」はそこに固定する。
- I-B0-QROW: 今日の地震の行の深さ・description・津波の評価の文を ★A unit の行に持つ（保存の版を上げ、開発の保存は初期化）／B projector が行の EventID から event の view を引く（event が容量で外れると行の欄が欠ける）。

## 8. 未確認

- 地震動予報（VXSE45）で最大予測震度のみの報が来るか（予報の VXSE44 は R27 で無視している、§5.4）。
- 最大予測震度のみの報の Text の実電文の形（資料の事例 2 つだけ）。
- 震央地名の最長の字数と、実電文の Condition・WarningComment・第 1 波の状況の字の長さの分布。
- 合計は付録 A の欄の形を直列化した値で、projector に通していない。
- §4 の「ずれる」は、変える所を推定した行で数えた。実装の位置が変われば数え直す。
- 市区町村等の区域の数が 1,892（G0 の lock）か 1,894（コード表）か（r2・G0 の未確認のまま）。§1 の合計は 1,894 で数えた。
- `eewReportFacts` の区域の組み立てが `forecast` の null で動くか（§5.2）。

## 付録 A 欄の形の見本（§1.3 の byte の元）

`<N byte>` は §1.2 の上限いっぱいの字に置き換えて数えた。
鍵の名前は数えるための仮の名で、B0 の型で決め直す。決め直したら §1.3 を数え直す。

- EEW のカードの見出し（1,114 byte）: `{"eventId":"<14字>","operation":"normal","letter":"A","warning":true,"serial":3,"final":false,"reportTime":"<40byte>","max":{"f":"5-","t":"over"},"hypo":{"name":"<192byte>","cut":false},"mag":{"v":"<32byte>","desc":"<96byte>","cut":false},"depth":{"v":"<32byte>","desc":"<96byte>","cut":false},"assumed":false,"detectOnly":false,"place":{"text":"<192byte>","cut":false},"lg":{"f":"4","t":"over"},"unread":true,"marks":["unconfirmed","restored","expiryPending","capacityExceeded"]}`
- EEW の大カードの区域の行（120 byte。`cd` は `arrived`・`unknown`・null。Condition と到達予想時刻は資料では同時に出ないが、型の最大は両方を数えた）: `{"c":"622","f":"5-","t":"over","cd":"arrived","at":"<40byte>","lg":{"f":"4","t":"over"}}`
- 小さいカードの区域の最小の欄（10 byte）: `["622",15]`（段の番号。「以上」は ＋10、§1.1）
- 合成の 1 区域（細分区域 10 byte、市区町村 14 byte）: `["622",-1]`（既知の最大の段の番号。不明だけの区域は −1）。長周期の塗りも同じ形
- 津波の予報の見出し（2,305 byte）: `{"eventId":"<14字>","operation":"normal","serial":3,"reportTime":"<40byte>","comment":{"text":"<2048byte>","cut":false},"unread":true,"marks":[…4 語],"omittedUnkeyed":0}`
- 津波の予報区の行（219 byte）: `{"c":"100","k":"majorWarning","first":{"raw":"<40byte>","cond":{"text":"<48byte>","cut":false}},"h":{"raw":"<24byte>","cut":false}}`
- コードの無い予報区の行（358 byte）: `{"name":{"text":"<192byte>","cut":false},"k":"51","kn":{"text":"<96byte>","cut":false}}`
- 津波の塗りの合成の 1 区域（22 byte）: `["100","majorWarning"]`。観測の最大の合成の 1 区域（34 byte）: `["100","<24byte>"]`
- 今日の地震の行（1,234 byte）: `{"eventId":"<14字>","operation":"normal","origin":"<40byte>","reportTime":"<40byte>","hypo":{"name":"<192byte>","cut":false},"mag":{"v":"<32byte>","desc":"<96byte>","cut":false},"depth":{"v":"<32byte>","desc":"<96byte>","cut":false},"maxInt":"5-","cancelled":false,"tsunami":{"text":"<384byte>","cut":false},"marks":[…4 語]}`
- 長周期の見出し（189 byte）: `{"eventId":"<14字>","operation":"normal","reportTime":"<40byte>","maxLg":"4","marks":[…4 語]}`
- 配列は `[` と `]` と区切りの `,` を数える。落とした件数の欄（`"omittedEvents":0` など）は数に含めた。

## 9. 計画の改訂の候補

- 計画 §3.2 の `view-projector.ts` の行（計画:223）: 所有と編集順「B0 → B1 → C2」に E0 を足す。札の字 A〜F と出ているカードを選ぶ規則（DS-LAYOUT-07・E0-1）を、E0 が `reconstruction/src/view-projector/display-wire.ts` に置くため（D-B0-LETTER=A）。順は B0 → B1 → E0（札の字と選ぶ規則だけ）→ C2。
