# P4 B0 表示の wire の表 r6（P4-DISPLAY-WIRE-001 の起草の最初の成果物）

- 起草日: 2026-11-21（起草の子 r0。同日 r1 で統合担当の決め 5 つ、r2 でヘルツの総合レビュー〔base 35a54c81、NO-GO〕の 12 件、r3 でヘルツの再レビュー〔base 7ca0ea5e、NO-GO〕と統合担当の進め方の 3 つの変更、r4 でヘルツの 3 巡目〔base 516dc575、NO-GO〕の残り 3 件〔作者裁定 2026-11-21 07:51: 直してヘルツには閉じたかだけを見てもらう〕を当てた。対応は §10。r5 は契約 r0 の起草の時の呼び名で、本文は r4 のまま。r6 で契約 r0 の契約適合レビュー〔NO-GO、P1 1・P2 8・P3 16〕を当て、§12・§13 を足した。対応は §11）
- base: `7ca0ea5e0c40a7619158eb0d5467666147a76d59`（branch draft/p4-b0）。
- 目的: 契約の JSON を書く前に、型の上限・区域の扱い・分野ごとの詳細の形・新旧の wire の切替点・配送済みの契約を変える所を表にする。
- 根拠: 計画 `reconstruction/contracts/p4-order-plan.md`（以下「計画:行」）、表示設計 spec `docs/specs/reconstruction-display-design.md`（以下「DS-…」の ID）、spec `docs/specs/reconstruction-p0-contracts.md`（以下「spec:行」）、容量の設計 `~/dev/p4-b1-capacity-r0.md`〜`-r3.md`（以下「r0」〜「r3」）、G0 の資材 `~/dev/p4-g0-assets-r0.md`（以下「G0:行」）、解説資料の読み通し `~/dev/p4-jma-readthrough-eew-quake-r0.md`（以下「読み通し」）、解説資料の原文（以下「解説:行」）と地震火山関連コード表（以下「コード表:行」）。repo の外の文書は契約の readPaths に入らないので、B0 の実装に要る中身（容量の設計 r2 §2 の 12 分野の表など）は §12・§13 に写した。
- 統合担当の決め（覆さない）: (1) 地図の塗りは合成 1 枚、区域名は G0 の表から描画の側で引く。(2) view の `semanticRevision` と U-Q の `daily.counted` は wire に載せない。(3) 文字列の上限は B0 が持つ。(4) 型の最大値の試験で保護 3 分野の wire が 262,144 byte 以下を示す（D-H37-EXPECT を閉じる条件）。(5) EEW の区域の Condition はコードで送る。(6) 札の字 A〜F と出ているカードは projector が決める（D-B0-LETTER=A）。(7) 移行中は SSE を分ける（I-B0-LEGACY=A、ヘルツの再レビューで可）。(8) 詳細の節は配送済みの形を引き、新しく作らない。(9) 9 分野と共通部の表示語彙も B0 が持つ。範囲は今の view の欄を語彙へ写すところまで（§12・§13、契約適合レビュー r0 の P1-1 の (a)）。(10) B0〜B1 の間の新しい経路の 1 MiB は今の規則をそのまま当て、保護 3 分野は要約にしない（§12.4）。(11) EEW のカードが 6 枚とも最終報の前のとき、通常の報は訓練・試験のカードより先に入る（§1.2、spec:1636）。
- 262,144 の出どころ: 1,048,576 − 9 × 65,536 − 131,072 − 65,536（`view-projector.ts:35`〜`:37`、spec §8.3）。
- byte の数え方: 公開は `JSON.stringify(snapshot)`（`http-sse.ts:250`）。文字列の上限は escape した後の JSON の byte（引用符を除く、`runtime-diagnostic.ts:13`〜`:20` の `boundedString` と同じ単位）。**合計は手で足さず、`reconstruction/contracts/p4-display-wire-max.mjs` が §1 の表から最大の形の object を組んで `JSON.stringify` の byte で数えた値を置く**（実行は `node reconstruction/contracts/p4-display-wire-max.mjs`、B0 の受入の「型の最大値の試験」の下書き）。
- 印: **板待ち** は分野の板で決める数、**作者に聞ける** は板なしで作者に聞ける数。

## 0. 結論

- 保護 3 分野の最悪の組（訓練・試験は地図に塗らない・津波 3 件・行 15・市区町村の塗り・読めない報のカードは今の長さ）は 243,262 byte、262,144 の余りは 18,882（§1.4 の組 A、script の出力）。
- r2 の 234,495 から増えたのは、null が番号より長い欄を null で数えた、閉じた観測の印を 3 区分とも数えた、詳細を開く参照（id と rev、各 128 byte ほど）をカード・見出し・行に足した分。
- 読めない報のカードを短くすると 182,062（余り 80,082）。r6 で、短いカードの題と見出しを {text, cut} にした分（1 枚 42 byte、3 分野 24 枚で 1,008）を足した。区分ごとに塗る形はカードが今の長さだと −52,047 で入らず、短くすると 9,153 で入る。付加文（WarningComment）を全部載せる形は、区分ごと＋短いカードでは −58,431 で入らない（§6 の数は裁定の時の r5 のまま）。
- 詳細の節は配送済みの形に倣う（§2）。ページの切り方は U-W の「wrapper 込みの byte を加算で数え、入らない項目は `{ index, reason: "pageBudget" }` で省く」（P3-UWC-AC06 (3)・P3-UWC-RES-05）をそのまま使う。版は U-F・U-W の id（sha256）と、その part が返す view の object の JSON の sha256 を rev にする形（返す内容が変われば必ず変わる。格納幅は 64 桁のまま）。
- U-E の未知区域・未知 Condition は、H43 と同じ原文（part=raw）からは読めない。受理した EEW の原文は保存しない（`eew-unit.ts:20`「U-E の記録は印を持たない」）。U-W の `areas` に倣う U-E の `areas` で、current の区域の全行から読む。カードには参照（id と rev）を載せ、byte に数えた。
- r4（ヘルツの 3 巡目）: 地震の既知でない区域の件数（行・長周期の見出し・合成ごと）を script に足して数え直した（§1.4）。詳細の rev は、その part が返す view の object の JSON の sha256 にした（§2.1、土砂の held の例）。U-Q の既知でない区域を読む part は `event` に揃えた。日次行の `ref` の rev は欠けうる形にした（§5.6）。
- wire に足す欄の全部について、値が変わる遷移が内容版か表示差分を動かすかを §1.6 に並べた。動かないのは 2 つ（津波の閉じた観測の印、EEW の未確認の印）で、直しを §4 に足した。
- r6: 9 分野は今の view の欄を語彙（事実の行・区域の一覧・文章・共通の見出し）へ機械的に写す（§12）。9 分野の最大は分野ごとに 65,536（予算内の full）か要約（3,734 以下）で、新しい経路の上界は 9 × 65,536 ＋ 通知 131,072 ＋ 共通部 65,536 ＋ 保護 3 分野 182,062 ＝ 968,494（1 MiB の余り 80,082、script の出力）。
- r6: 共通部は今の snapshot の形をそのまま写し、H17（消えた理由）と H39（落とした件数・件数の不明・通知したか不明）だけを足す（§13）。足す分の最大は 8,525 byte で、今の共通部の上界 49,443 と合わせて 57,968（共通部 65,536 の余り 7,568、script の出力）。

## 1. 型の上限の表

### 1.1 区域の扱い（受理と復元で共通の規則）

今の受理は区域の数を地理資材で止めていない（EEW は `eew.ts:212`〜`:218`、津波は `tsunami.ts:100`〜`:101` と復元の `tsunami-unit.ts:1053`〜`:1056`・`:1088`〜`:1092`、地震は `seismic.ts:125`〜`:129`）。
B0 は区域を次の規則で wire にする。
規則は projector（新しい file `display-wire.ts`）だけに置き、unit の view を入力にするので、受理の後も復元の後も同じに効く（ヘルツの再レビュー #2 で成立）。parser と unit は変えない。

| 場合 | 地図の合成 | カードの行・最小の欄 | 件数と印 | 読める場所 |
|---|---|---|---|---|
| 既知コード（細分区域 188〔G0:31〕、津波予報区 66〔G0:37〕、市区町村 1,894〔G0:51 の I-1〕） | 塗る | 行を出す | — | wire |
| 同じ報の中で同じコードが重なる | 最も重い段で 1 回数える | 1 行にまとめる（最も重い段の行、同じ段なら到達予想時刻の早い行） | `dupAreas` | wire（まとめた行）と詳細の `areas`（全行） |
| 既知でないコード | 塗らない | 行を出さない | `unknownAreas` と印（字は DS の板） | 詳細（U-E・U-T は `areas`、U-Q は `event`。§2） |
| コードの無い区域（津波のコードなし予報区） | 塗らない | 名前の行を 8 行まで | 9 行目からは `omittedUnkeyed` | U-T の詳細の `areas` |

- 無いと壊れる振る舞い: 既知でない区域を黙って外すと spec:1587 と H51 に反し、地理資材の件数を上界にすると受理できる 1 報で wire の上界が破れる。
- G0 の既知コードの表（置き場の path は G0 の契約が決める）は B0 の実装の前に要る（§9）。契約の baseOid は、Q-DW-G0-CODES を閉じ、P4-GIS-ASSETS-001 を依存に、その表の path を readPaths に足してから割り当てる。1,892 と 1,894 の差は G0 で決まる。script は 1,894 で数えた。

### 1.2 保護 3 分野の要素（件数の上限）

段の番号: 0〜9 が震度 0〜7（5弱・5強・6弱・6強を含む 10 段）、10 が over（To だけ）、−1 が「不明」、−2 が表外の値、欠けは null。
カードの最小の欄は「以上」を ＋10 で持つ。合成は既知の最大の段で塗り、既知の段が 1 つも無い区域だけ −1（−1 は「不明」で、塗りなしと分ける。H51）。区域の段は塗りの値で、To が数か字ならその値、To が over か欠けなら From（DS-EEW-09・DS-INT-08 の「札の色は下の値」）。
1 件の byte は script が数える（付録 A の形）。

| 分野 | wire の要素 | 件数の上限（案と出どころ） | 超えた分の画面と残す順 |
|---|---|---|---|
| eew | 地図の合成 [コード, 段の番号] | 既知の細分区域 188、塗る区分ごとに 1 枚（§1.4） | 超えない |
| eew | カードの見出し（札の字・区分・警報か予報・第 N 報・最終・発表時刻・最大予測震度・震源名・M・深さ・震央の位置・仮定震源・検知だけの報・場所の文・長周期の最大・読めない印・状態の印・`unknownAreas`・`dupAreas`・詳細の参照 `ref`） | 6 枚（DS-LAYOUT-06）。6 枚は運用区分をまたいで数える（**板待ちの仮の数**、E0-1） | 7 件目は最終報の出た古いカードと入れ替える（DS-LAYOUT-07、E0 が置く）。6 枚とも最終報の前は **板待ち**（E0-1、DS-OPEN-31 の板へ渡す）。B0 の仮の規則: 通常の報は訓練・試験のカードより先に入る。7 件目が通常の報で訓練・試験のカードがあれば、出た順の最も古い訓練・試験のカードを外してそこへ入れ、外した報は件数だけになる（訓練・試験は地図に塗らないので合成にも入らない、P4-DW-D-OPERATION=A）。7 件目が訓練・試験の報か、6 枚とも通常の報なら、7 件目はカードに出ず、合成（通常の報だけ）と件数に入る。根拠は spec:1636（通常運用の緊急表示を訓練側で隠さない）。判断カード 2-1 が裁定したのは地図の塗りだけで、6 枚の数え方は裁定していない |
| eew | 大カードの区域の行（コード・From/To・Condition のコード・到達の状況のコード〔コード表:204〜:209〕・到達予想時刻・長周期階級） | 1 件のときだけ、既知の 188 行まで | 超えない |
| eew | 小さいカードの最小の欄 [コード, 段の番号] | 2 件以上のとき、出ているカードごとに既知の 188 | 超えない |
| eew | 2 件のときの上位 2 行（projector が作る） | カードごとに 2 行（DS-EEWS-10） | 超えない |
| tsunami | 予報の見出し（EventID・区分・第 N 報・発表時刻・WarningComment・読めない印・状態の印・`omittedUnkeyed`・`unknownAreas`・`dupAreas`・`ref`） | 同時の EventID を 3（**作者に聞ける**、D-B0-TSUNAMI-COUNT。unit は 512 件、`tsunami-unit.ts:33`） | 4 件目から（COUNT=B なら 3 件目から）は予報区の行を wire に載せず件数を出す。塗りの合成には全件が入る。残す順は最も重い区分が上（表外の `unknown` は警報と同じ順位、`p3-tsunami-unit.types.ts:26`〜`:28`）、同じ区分は新しい発表が上 |
| tsunami | 予報区の行（コード・区分のコード・第 1 波・最大の高さ） | EventID ごとに既知の 66 | 超えない |
| tsunami | コードの無い予報区の行（名前・区分のコード） | EventID ごとに 8（案。unit に件数の上限は無い） | 9 行目からは件数。残す順は区分の重い順 |
| tsunami | 予報の塗りの合成・観測の予報区ごとの最大の合成 | 各 66、塗る区分ごとに 1 組 | 超えない |
| tsunami | 観測の表が期限で閉じた印（`closedObservations`、§5.5） | 3 区分とも、区分ごとに新しい 4 件（塗る区分の選び方によらない） | 5 件目からは件数 |
| tsunami | 観測の表（観測点ごとの値） | wire に載せず詳細へ（r3 §1.2: 611 点で ＋296,946） | — |
| earthquake | 今日の地震の行（最大震度・震源名・M か description・深さ・発生時刻・津波の評価の文・取消・震度速報だけの行の最も強い地域のコード・状態の印・`unknownAreas`・`ref`〔rev は欠けうる、§5.6〕） | 区分ごとに 5 行、3 区分で 15 行（`seismic-unit.ts:54`。**板待ち**: C0） | 6 行目は unit が持たない |
| earthquake | 当日の件数と最大震度（取消を除く、H18） | 区分ごとに 1 | 超えない |
| earthquake | 観測の震度の塗りの合成と、合成ごとの `unknownAreas`（行に出ない地震〔前の日・6 件目から〕の既知でない区域も数える） | 既知の市区町村 1,894（仮。**板待ち**: M0-1）、塗る区分ごと | 超えない |
| earthquake | 長周期の見出し（`unknownAreas` を含む）と区域の塗りの合成（合成ごとの `unknownAreas` を含む） | 見出し 2 件（仮）、塗りは既知の細分区域 188、塗る区分ごと（**板待ち**） | 3 件目からは新しい 2 件を残し、件数 |
| 3 分野共通 | wrapper | 分野ごとに 1。上界 3,882（summary wrapper の最大、`p2-snapshot-sse.json:73`） | — |
| 3 分野共通 | 読めない報のカード（H43） | 分野ごとに 8 枚（`checkpoint.ts:689`〜`:690`）。今の長さで 1 本 28,276、題 96 byte・見出し 384 byte なら 7,540 | 古いカードから外す（`owner-runtime.ts:220`〜`:236`） |

wire に載せない欄: view の `semanticRevision`、U-Q の `daily.counted`、view の `subjects`、地震ごとの震度の一覧（詳細へ）。

### 1.3 文字列の上限と有限のコード（B0 が真実源、台帳 50）

- 上限は escape した後の byte。切るときは `boundedString` と同じ数え方で字の境で切り、欄ごとに `cut: true` を付ける。字数は目安で、境界は byte。
- 有限の値はコードで送る。表外の値は −2 か `unknown` にして印を出す（H51）。script は、同じ欄に入りうる値のうち直列化が最も長いもの（null・false・負の番号を含む）で数える（ヘルツの再レビュー #3）。

| 欄 | 形と上限（案） | 出どころ | 切ると画面から消えるもの |
|---|---|---|---|
| From/To・最大震度・長周期の最大 | 段の番号 | 解説:4227〜:4256 | 消えない |
| EEW の区域の Condition | `arrived`・`unknown`・null | 解説:4613（値は 1 つ）、:4617〜:4618 | 消えない。`unknown` は「区分不明」の印、字は U-E の `areas` で読む |
| EEW の区域の到達の状況 | 0・1・9・−2・null | コード表:204〜:209 | 消えない |
| 津波の区分 | `majorWarning`〜`unknown` の 7 語 | `p3-tsunami-unit.types.ts:25`〜`:28` | 消えない（Kind/Name の字は載せない） |
| 震源名 | 192 byte | 地震の行の 64 字（`p3-seismic-unit.types.ts:149`〜`:150`） | 上限から後 |
| 震央の位置（Coordinate の生の字） | 64 byte | `eew.ts:814` | 上限から後。× 印の位置が出ない |
| M・深さの値／description | 32 byte／96 byte | `p3-seismic-unit.types.ts:150`・読み通し Q52-02 | 上限から後 |
| 最大予測震度のみの報の場所の文 | 192 byte | §5.4 | 上限から後 |
| 時刻の生の字 | 40 byte | `p3-seismic-unit.types.ts:149` | 時刻の不明になる |
| EventID | 40 byte | `seismic.ts:55`〜`:60` | 受理で止まる |
| 番号・件数 | 最大の安全整数 | `eew.ts:162`〜`:167` | — |
| 詳細の参照 `ref` | id 64・rev 64（sha256 の hex。rev はその part が返す view の object の JSON の sha256、§2.1） | U-F・U-W の id（`p2-weather-timeseries-unit.types.ts:126`〜`:127`、`p3-uw-canon.types.ts:16`〜`:17`） | — |
| 津波の WarningComment | D-B0-TSUNAMI-COMMENT。A: 2,048 byte。B: unit が持つ 4,096 字（`tsunami.ts:197`、P3-VAT-D-T-LIMIT）を escape の最悪で 24,576 byte | 同左 | A は 2,049 byte 目から後（全文は詳細の `comment`） |
| 津波の第 1 波の状況／高さの字 | 48 byte／24 byte | parser の 16,384 字 | 上限から後 |
| コードの無い予報区の名前 | 192 byte | 同上 | 上限から後 |
| 今日の地震の津波の評価の文 | 384 byte | event の view の `tsunamiComment.text`。津波のコードの文だけ（読み通し Q53-09） | 上限から後 |
| 読めない報のカードの題／見出し（wire だけ） | D-B0-CARD-TEXT。A: 96 byte／384 byte で、題と見出しはどちらも {text, cut}。B: 1,536 byte のまま | `checkpoint.ts:688`・`runtime-diagnostic.ts:14` | A は題の 33 字目ほど・見出しの 129 字目ほどから後（目安。境界は escape 後の byte） |

### 1.4 保護 3 分野の合計と 262,144（script の出力）

| 組 | 地図を塗る区分 | 津波 | 地震の塗り | カード | 付加文 | EEW | 津波 | 地震 | wrapper＋カード | 合計 | 余り |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** | 通常だけ | 3 件 | 市区町村 | 今 | 2,048 byte | 27,656 | 64,296 | 54,836 | 96,474 | **243,262** | **18,882** |
| A短 | 通常だけ | 3 件 | 市区町村 | 短 | 2,048 byte | 27,656 | 64,296 | 54,836 | 35,274 | 182,062 | 80,082 |
| A-B | 通常だけ | 3 件 | 細分区域 | 今 | 2,048 byte | 27,656 | 64,296 | 28,494 | 96,474 | 216,920 | 45,224 |
| A-C | 通常だけ | 2 件 | 市区町村 | 今 | 2,048 byte | 27,656 | 45,229 | 54,836 | 96,474 | 224,195 | 37,949 |
| R | 区分ごと | 3 件 | 市区町村 | 今 | 2,048 byte | 29,741 | 72,008 | 115,968 | 96,474 | 314,191 | −52,047 |
| R短 | 区分ごと | 3 件 | 市区町村 | 短 | 2,048 byte | 29,741 | 72,008 | 115,968 | 35,274 | 252,991 | 9,153 |
| R-B | 区分ごと | 3 件 | 細分区域 | 今 | 2,048 byte | 29,741 | 72,008 | 36,942 | 96,474 | 235,165 | 26,979 |
| R-C | 区分ごと | 2 件 | 市区町村 | 今 | 2,048 byte | 29,741 | 52,941 | 115,968 | 96,474 | 295,124 | −32,980 |
| 付加文全部 | 通常だけ | 3 件 | 市区町村 | 今 | 全部 | 27,656 | 131,880 | 54,836 | 96,474 | 310,846 | −48,702 |
| 付加文全部＋短 | 通常だけ | 3 件 | 市区町村 | 短 | 全部 | 27,656 | 131,880 | 54,836 | 35,274 | 249,646 | 12,498 |
| 区分ごと＋短＋付加文全部 | 区分ごと | 3 件 | 市区町村 | 短 | 全部 | 29,741 | 139,592 | 115,968 | 35,274 | 320,575 | −58,431 |
| 同上＋津波 2 件 | 区分ごと | 2 件 | 市区町村 | 短 | 全部 | 29,741 | 97,997 | 115,968 | 35,274 | 278,980 | −16,836 |
| 区分ごと＋短＋細分区域 | 区分ごと | 3 件 | 細分区域 | 短 | 2,048 byte | 29,741 | 72,008 | 36,942 | 35,274 | 173,965 | 88,179 |

- EEW は C＝1・C＝2・C＝6 の最大（script の `eew()`）。
- 型の最大値の試験（決め 4）は、裁定で選ばれた組（A短）の形で組む。script は、組 A短 の余り・共通部の余り（§13）・新しい経路の 1 MiB の余り（§12.4）のどれかが負なら exit 1 で終わる。
- 短いカードは題と見出しを {text, cut} で数える（r6、契約適合レビュー r0 の P3-16）。1 欄 21 byte、1 枚 42 byte、3 分野 24 枚で 1,008 byte。今の長さのカード（B）は切らないので印を持たない。
- 合計は欄の形を直列化した値で、projector に通していない（ヘルツのレビューの証拠不足のまま）。
- 付加文の「全部」は 4,096 字が全部 escape で 6 byte になる最悪で数えた。日本語の字だけなら 1 件 12,288 byte。

### 1.5 初期画面に出ないものと見せ方

| 対象 | 初期画面（snapshot だけ）で読める範囲 | 詳細を取ったときに読める範囲 | 取り方 |
|---|---|---|---|
| 津波の WarningComment | A: 頭から 2,048 byte と印／B: unit が持つ 4,096 字の全部 | 4,096 字の全部（U-T の `comment`） | D-B0-TSUNAMI-COMMENT |
| コードの無い予報区の 9 行目から | 件数 | 全部（U-T の `areas`） | D-B0-TSUNAMI-DETAIL |
| 津波の観測の表 | 予報区ごとの最大の合成 | 全部（U-T の `stations`） | 同上 |
| 4 件目から（COUNT=B なら 3 件目から）の津波の予報区の行 | 件数と予報の塗り | 全部（U-T の `index` → `areas`） | 同上 |
| 既知でない区域 | 件数と印 | 全部（U-E・U-T は `areas`、U-Q は `event`） | 印からの操作 |
| EEW の未知の Condition の字 | 「区分不明」の印 | 字（U-E の `areas`。current の view に原文の字がある、`p2-eew-unit.types.ts:19`〜`:24`） | 印からの操作 |
| 読めない報のカードの原文（H43・H51） | 題と見出しと原文の有無（`hasRaw`、`owner-runtime.ts:196`〜`:198`） | 原文（`raw`、§2）。器の都合で消えていれば印（カードの `rawDropped`・`rawCut`、spec:3208） | 操作 |

「裏で取る」は、カードのページ送りがそのページに来たときに S0 の client が取りに行く形（同時 1 件・現在のページだけ、spec:1342）。

### 1.6 wire に足す欄の値が変わる遷移と公開（ヘルツの再レビュー #15）

owner は、表示差分があるか内容版が変わったときだけ view を出し直す（`owner-runtime.ts:307`〜`:312`）。読めない報のカードは置いた step で出し直す（`:335`〜`:348`）。

| 欄 | 値が変わる遷移 | 表示差分か内容版を動かすか | 直し |
|---|---|---|---|
| EEW のカードの欄（震源名・M・深さ・震央・仮定震源・検知だけ・場所の文・最大予測震度・区域の行・最小の欄・`unknownAreas`・`dupAreas`・最終・`ref`） | 新しい版を採る（current を作り直す）・取消・期限切れ・退去 | 動かす（`eew.ts:596` の `previous !== projected`、`:380`・`:593`。内容版は `eew-unit.ts:322`〜`:323`） | 無し |
| EEW の札の字・出ているカード | EEW の表示差分 | projector の state で、表示差分のたびに決め直す | 無し |
| EEW の状態の印「未確認」 | 版を決められない報（held）で gate に印が付く（`eew.ts:489`〜`:495`） | **動かさない**（gate だけを変え、current も表示差分も変えない） | §4: held の分岐で、current のある subject は印を写した current を作って `changed` を呼ぶ。:489（1 ref）・:495（3 refs）の reanchor が要る。印を EEW のカードに出さない形もある（今の view にこの印は無い） |
| 津波の予報の欄（行・付加文・`unknownAreas`・`dupAreas`・`omittedUnkeyed`・`ref`） | 版を採る・取消・解除 | 動かす（`tsunami-unit.ts:927`〜`:930`、内容版は :943） | 無し |
| 津波の観測の最大の合成 | 観測の版を採る・期限切れ・期限待ち | 動かす（見える↔見えないが変わる、`:131` の `visible`） | 無し |
| 津波の閉じた観測の印 | active → expired | 動かす（見えるから見えないへ） | 無し |
| 同上 | 期限待ち → expired、expired → 記録の削除（保持期限、`:778`〜`:781`） | **動かさない**（両側とも見えないので `:929` で飛ばし、:943 は内容版を上げない） | §4: :943 の内容版の条件に「閉じた印の集合が変わった」を足す（U-Q の当日履歴と同じ形、`seismic-unit.ts:1376`）。:943 は 1 ref |
| 同上 | expired → active（同じ観測の報が来た） | 動かす | 無し |
| 今日の地震の行・当日の件数と最大震度・最も強い地域 | 当日履歴の変化（日付の切り替えを含む） | 動かす（`seismic-unit.ts:1376` の `step.state.daily !== state.daily`） | 無し |
| 観測の震度の塗り・長周期の見出しと塗り・地震の `unknownAreas`・`ref` | event・長周期の版を採る・取消・期限切れ | 動かす（`seismic-unit.ts:1370`〜`:1373`） | 無し |
| 津波・地震の状態の印（未確認・期限待ち・容量） | 印の付いた記録の object が替わる | 動かす（表示差分は object の同一性で比べる、`tsunami-unit.ts:929`。U-Q の `listed` の期限待ちの扱いは読んでいない、未確認） | 無し（U-Q の期限待ちは要確認） |
| 読めない報のカード（`rawDropped`・`rawCut` を含む） | カードを置く・原文を外す・古いカードを外す | 動かす（どれも `placeCard` の中で、置いた step で出し直す、`owner-runtime.ts:220`〜`:236`・`:348`） | 無し |

## 2. 分野ごとの詳細の形（配送済みの形に倣う）

### 2.1 倣う形（確かめた事実）

- **ページの切り方**（確かめ (i)）: U-W は 1 ページの件数を固定し（行 256・索引 32、`weather-current-public.ts:35`）、HTTP の本文を wrapper 込みで加算して数え、入らない行は値を入れず `{ index, reason: "pageBudget" }` にする（P3-UWC-AC06 (3)、P3-UWC-RES-05「数えるのは HTTP の本文の全部」、`weather-current-public.ts:293`〜`:306`）。U-F も同じ形で、予約 4,096 byte を引いた 61,440 byte で切る（`weather-timeseries-unit.ts:610`・`:659`）。項目の境界で切り、wrapper 込みの byte を保証している。B0 の新しい part はこの形をそのまま使い、足す規則は無い。
  - 省いた項目は index で示すだけで、ほかのページでは読めない。U-F は「実例の全ページで omitted が 0 件」を試験で確かめる（P3-UFP-T08）。B0 も通常合法 corpus で省略 0 件を受入にする（spec:1341 の最後の文）。
  - r2 で置いた 64 行・16 KiB などの数は消した。
- **版**（確かめ (ii)）: U-F・U-W の対象 1 件は id＝`JSON.stringify([unit, operation, subject])` の sha256 の hex、revision＝その object を作った step の内容版（`p2-weather-timeseries-unit.types.ts:126`〜`:129`、`p3-uw-canon.types.ts:16`〜`:19`）。U-V・U-N の本文は id＝subject、revision＝source の三つ組の JSON（spec:1339 の 4）。
  - B0 の新しい part は id を U-F・U-W と同じ sha256 にし、rev を「その part が返す view の object（U-E は current、U-T は予報・観測の subject、U-Q は event、U-L などは現況の要素）の `JSON.stringify` の sha256 の hex」にする。読めない報のカードの原文（`raw`）はこの規則から外し、§2.2 の例外の形（id＝カードの inputId、rev＝`receivedAt`）だけで決める。格納幅は 64 桁のまま。
  - 倣う所: U-W の revision は「この object を作った step の内容版」（`p3-uw-canon.types.ts:19`）で、返す内容が変わらなければ版も据え置く（`weather-current-public.ts:135`〜`:136` の、行が同じなら前の object を使い回す所）。B0 は同じ性質（返す内容が変われば版が変わり、変わらなければ同じ）を、unit の state に版の欄を足さずに持たせる。owner は要求を受けたとき、その object を同じ view の形にして同じ式で作り直して照合する。
  - source の三つ組だけでは足りない例（ヘルツの 3 巡目 #2）: 土砂の held の報では `{ ...existing, unconfirmed: version.mark }` を作り、source は変わらない（`landslide-unit.ts:282`）。表示差分が出て（`:284`）、内容版が進み（`:520`）、view は `shown(item)` で印を残したまま返す（`:529`、`notice-mark.ts:164`）。source の列の hash なら rev が同じになり古い応答が通るが、object の JSON の hash なら印の分だけ変わる。
  - U-Q の event は寄与ごとに source を持ち（`p3-seismic-unit.types.ts:207`）、どの寄与が変わっても event の object が変わるので、同じ式で閉じる。
  - 費用: hash を作るのは表示差分のあった subject だけで、projector は今もその object の byte を数えるために直列化している（`view-projector.ts:185` の `utf8(current)` など）。受信経路の計算量の族は増えない。
- **原文**（確かめ (iii)）: U-E の未知区域・未知 Condition は H43 と同じ `raw` からは読めない。受理した EEW の原文は保存しない（`eew-unit.ts:20`）。読むのは current の view の区域の全行（未知コードと Condition の字を含む）で、U-W の `areas` に倣う。カードに要るのは `ref`（id と rev）で、byte は §1.4 に入れた。
- 運用区分: id の sha256 に operation が入るので、同じ EventID が区分ごとにある U-T（`p3-tsunami-unit.types.ts:63`〜`:67`）でも区分の対象に届く。索引の項目にも operation を載せる（U-W の索引と同じ）。要求は operation を持たない（U-W の要求 `p3-uw-canon.types.ts:47`〜`:49` と同じ。対象は id で決まる）。
- B0 の所有に入れる union: `p3-execution-split.types.ts:73`・`:142`、`composition-root.ts:2438`、`http-sse.ts:35`〜`:36`、`owner-runtime.ts:737`。`composition-root.ts:1844` は `unit` で場所を選ぶので変えない。

### 2.2 分野ごとの表（倣う形と差分）

| 分野（unit） | 倣う配送済みの形 | 差分 | 要約になったときの最初の要求 | owner | 要求を出す契約と起点 |
|---|---|---|---|---|---|
| eew（U-E） | U-W の `areas`（行のページ・pageBudget） | id・rev は §2.1。行は current の区域の全行（未知コード・重なった行・Condition の字） | 要約にしない（H37） | urgent | E0。印からの操作 |
| tsunami（U-T） | 索引は U-W の `index`、予報区と観測点は U-W の `areas`、付加文は U-V・U-N の本文 1 件 | part は `index`・`areas`（既知・未知・コードなしの全行）・`stations`・`comment`。付加文は 4,096 字で、escape の最悪 24,576 byte でも 1 応答に入る | 要約にしない（H37） | urgent | T0。D-B0-TSUNAMI-DETAIL |
| earthquake（U-Q） | 索引は U-W の `index`、震度の要素は U-W の `areas` | part は `index`・`event`（震度の要素と既知でない区域。U-Q の既知でない区域を読む part は `event` だけで、`areas` は置かない）。rev は event の object の JSON の sha256（§2.1） | 要約にしない（H37） | seismic | C0 発注 2。行から開く操作 |
| weatherCurrent（U-W） | 既存（P3-UW-CANON-001） | 無し | 既存（`part=index`・`revision=contentRevision`） | weatherCurrent | C0 |
| weatherTimeseries（U-F） | 既存（P3-UF-PUBLIC-001） | 無し | 既存 | deferred | C1 |
| nankai・volcano（U-N・U-V） | 本文は既存（P3-BULLETIN-TEXT-API-001）、索引は U-W の `index` | `part=index` を足す（要約に subject が無いため。subject と revision の組 約 170 byte × 64 件で要約 4 KiB に入らない、`nankai-unit.ts:31`・`volcano-unit.ts:35`） | `part=index`・`revision=contentRevision`・`page` | urgent | C1（C1-1） |
| localBulletins（U-M） | 同上 | 本文の unit に `U-M` を足す（地震の解説、計画:177） | 同上 | deferred | C1 |
| landslide・flood・briefing・typhoon | 索引は U-W の `index`、項目は U-W の `areas` | 項目は今の view の現況の要素 | 同上 | deferred | C1。要約の「詳細は個別取得」から（spec:1330） |
| 読めない報のカード | U-V・U-N の本文 1 件 | `raw`（§2.1 の rev の共通規則の例外: id＝カードの inputId、rev＝`receivedAt`）。カードは inputId と受信時刻で 1 枚に決まり、原文が器の都合で外れたかは応答の中の `rawDropped`・`rawCut` で返す（版の不一致にしない）。原文は 16,382 byte まで（`checkpoint.ts:688`）で 1 応答に入る | — | そのカードの unit の owner | C2。操作 |

urgent の場所の詳細は、開始済みの射影の非中断区間も E01 の負荷条件に含める（spec:1288）。

## 3. 新旧の wire の切替点

### 3.1 chrome-eew が読む形

`pure.ts:395`〜`:407` が `schemaVersion === 1`・トップレベルの `semanticRevision`・`current.eew`・`current.tsunami` を検査し、full では `pure.ts:353`〜`:358`・`:370`〜`:382` の旧形を読む。`current.<分野>.view` を読むのは src・tools では chrome-eew だけ、test に 35 file。

### 3.2 移行中（B0〜T0）: SSE を分ける（I-B0-LEGACY=A）

- 旧 `/events` は今の projector の出力のまま。新しい描画は新しい経路で `display` だけの snapshot を受ける。1 MiB の判定は経路ごと（旧は今の規則。新は B0〜B1 の間も今の規則をそのまま当て、保護 3 分野は要約にしない〔§12.4〕。B1 で新の規則に替える）。
- 旧画面と runner の保証は今と同じ規則（全体超過のとき予算超過の旧分野を要約）。B0 が旧 view に欄を足す（§4 の EEW・地震の行など）ので、C4・C6 の manifest で旧 full が予算に入ることは B0 で数え直す（ヘルツの証拠不足）。
- 費用: 公開ごとに射影と直列化が経路ごとに 1 回ずつ、計 2 回。これは配送済みの P2-A8-COST（`p2-snapshot-sse.json:99`「最終配送 JSON ≤ 1 MiB の直列化は一公開につき 1 回」）とぶつかるので、§4 で移行中の例外として改める。
- 理由の訂正: r2 の「新築が Pi で動く前の移行中だけ」は誤り。PI 発注 1（Wave 4）は T0（Wave 6）より前なので、Pi の段 1 は二重の射影の下で走る。段 1 の記録に二重の射影の下だと書き、公開の費用に依る値は段 1 で決めない。正式測定（PM）は T0 の後。

| 配送 | 読める組 | 製品の入口 `/` | 旧の経路 |
|---|---|---|---|
| B0 | 旧 → chrome-eew、`display-wire.ts` → 新しい描画（S0 までは試験の client だけ） | chrome-eew | 今のまま |
| B1・S0・E0 発注 2 | 同上。EEW の runner は E0 発注 2 で新しい描画へ | chrome-eew | 今のまま |
| T0 | 新しい描画だけ | 新しい描画 | 旧の経路・旧の出力を消し、`schemaVersion` を上げ、chrome-eew の path を外す。直列化は 1 回に戻る |
| FG | 同上 | 同上 | 旧の資材・設定・anchor を消すだけ |

## 4. 配送済みの契約を変える表

「«» の行」は `<path>:<行> «sha»` の形で引く行の数（checker が照合）。eew.ts 135・seismic-unit.ts 146・tsunami-unit.ts 104（依頼の `git grep` では 137・147・105、差は «» の無い本文の参照）。

| 変える契約 | 変える file と所 | «» の行 | 行を足すと ずれる／中身 | 行を足さない書き方 | 運ぶ P4 の契約 | 永続 schema |
|---|---|---|---|---|---|---|
| `P2-SNAPSHOT-SSE-001`（P2-A8-COST の例外） | 契約の文: `p2-snapshot-sse.json:99` の「一公開につき 1 回」に、B0〜T0 の例外（経路ごとに 1 回で各経路の全 client が共有、計数は経路ごとと合計の両方、T0 で 1 回へ戻す） | :97・:99・:100 が各 1 ref | 文の改訂は中身 1 ref | reanchor 1 件 | B0（例外を入れる）→ T0（例外を消す） | 無し |
| `P2-SNAPSHOT-SSE-001` | 新しい file `p4-display-wire.types.ts`・`display-wire.ts`。`p2-snapshot-sse.types.ts`・`view-projector.ts` は T0 まで変えない | 21・93 | — | 新しい file | B0 → B1 → E0 発注 1 → T0 | 無し |
| 同上 | `http-sse.ts`（新しい SSE の経路・新しい描画の path・新しい詳細の経路・`DetailPort`） | 20 | 経路はどれも request handler の中で振る（`/` と module は :198〜:201、詳細は :208、`/events` の 404 は :209）。:204・:208・:232・:245・:258 に各 1 ref で、:258 より前に行を足すとずれる。:258 より後は 0 | 行の中: :35（`DetailPort` の別名）、:160（新しい経路の clients・latest の宣言を行の末尾に）、:198〜:201（新しい描画の path）、:209（新しい SSE の経路と新しい詳細の経路を、`/events` の 404 の判定の前に同じ行で振る）。行を足すのは :258 より後（新しい経路の publish・client の関数）だけ。:208 は変えない（変えるなら p3-uw-canon の付け直し 1 件）。付け直し 0 | B0 → B1 → R0 → T0 | 無し |
| 同上 | `composition-root.ts`（詳細の union、新しい射影の呼び出しと公開、unit ごとの H39 の件数） | 227。最後の «» は :2462 | :985・:2439 に 1 ref ずつ（変えない）。:143・:437・:556・:822・:986・:997・:2438 は 0 | 行の中: :2438（DetailRequest・DetailResponse）、:143（display の口に新しい経路の公開）、:437（新しい射影の state の field と unit ごとの losses の field）、:556・:822（delta の losses を field に写す。:556 は復元、:822 は出力）、:986（新しい射影を呼ぶ）、:997（新しい経路へ公開する）。関数を足すのは :2462 より後だけ。付け直し 0 | B0 | 無し |
| `P2-EEW-UNIT-001` | `p2-eew-unit.types.ts`（`EewCurrent` に震源名・M・深さ・震央・検知だけ・場所の文・未確認の印） | 7 | :48 に足すと 4 行 6 refs | :47 の末尾 | B0 → 台帳 98 → E0 発注 1 | 無し（current は保存しない） |
| 同上 | `eew.ts`（Body/Text・OriginTime を読む、current に載せる、held の印を current に写して `changed`、区域の Kind/Code を読む） | 135 | :462 に足すと 49 行 87 refs。held の分岐 :489・:495 は中身 1・3 refs。:824 は 1 ref、:825 は 0 | 読む関数は :836（export の行、1 ref）より後、current の欄は :463 の末尾、held は :489〜:495 の行の中で書き換え（reanchor 4 件）、区域の Kind/Code は :825 の行の末尾 | 同上 | 無し |
| `P3-EEW-FACTS-001` | `p3-eew-facts.types.ts:14`（区域の Kind/Code）と契約の文（`p3-eew-facts.json:237` に例外） | 1 | :14 は 0 ref | :14 の末尾、読む所は `eew.ts:825` の末尾 | B0 | 無し |
| `P3-UNIT-Q-001` | `p3-seismic-unit.types.ts`: :158（行の欄）・:180・:192・:256（版の字）。`seismic-unit.ts`: :36（SCHEMA）・:477〜:479（行を作る所）・:1593〜:1602（decode で行を項目ごとに組み立てる）・:57〜:60（増え分の定数と MEMORY_GROWTH）。`owner-runtime.ts:84`（U-Q の初期 state の版）。試験 3 file の版の字（`test/seismic-unit/seismic-fixture.ts`・`seismic-capacity.test.ts`・`test/shared-runtime/shared-runtime.test.ts`） | 3・146・76 | types は :86・:138・:161 に 1 ref ずつで、変える行は 0。seismic-unit は :39 に 2・:63 に 6・:66 に 3・:69 に 4 で、変える行は 0。owner-runtime.ts:84 は 1 ref（p3-unit-q-capacity）。:478 に行を足すと 75 行 109 refs | どれも行の中か行の末尾。上界は «» 0 の :57〜:60 に増え分の定数を置いて MEMORY_GROWTH に足す（:63 の GENERATION_LIMIT と :69 の RESERVE_BYTES は MEMORY_GROWTH を足しているので中身が変わらない）。`283_209` は直さない。付け直しは owner-runtime.ts:84 の 1 件 | B0 → E0 発注 1 → N0 | **有り**。版を p3-seismic-unit-v9 に上げ、旧い形を読む移行を作らない（discardableSchemaVersions に足さない、P3-MIG-AC02 (2)）。開発機の古い slot は作者の了承で消し、Pi は旧築なので消さない |
| `P3-EXECUTION-SPLIT-001` | `p3-execution-split.types.ts:73`・`:142`（詳細の要求と応答）・`:100`（`OwnerUnitDelta` に `losses?`）、`owner-runtime.ts:737` | 21・76 | :73・:142・:737 は中身 1・2・1 refs。:100 は 0 | 別名を足す。:100 は行の末尾。reanchor 4 件 | B0 | 無し |
| `P3-EXECUTION-SPLIT-001`（owner の返信） | `owner-host.ts:299`・`:405`（delta に unit の losses を載せる） | 50 | :300・:404 に 1 ref ずつ（変えない）。:299・:405 は 0 | 行の中。付け直し 0 | B0 | 無し（losses の保存は今の envelope のまま） |
| `P3-VERSION-MATERIAL-001`（InputBoundaries、P3-VM-AC06・AC07） | `checkpoint.ts:842`（`InputBoundaries` に穴の種類だけを返す読むだけの関数、§13.2） | 46 | :845 に 1 ref（変えない）。:842 は 0 | :842 の行の中。付け直し 0 | B0 | 無し |
| `P3-UNIT-M-001`・`P3-BULLETIN-TEXT-API-001` | `local-bulletins.ts`・`local-bulletins-unit.ts`・`p3-bulletin-text-api.types.ts` | 11・20・0 | 最後の «» より後で 0 | 最後の «» より後 | B0（C1 が描く） | 本文を保存しないなら無し |
| `P3-TSUNAMI-UNIT-001` | `p3-tsunami-unit.types.ts`（`closedObservations`）・`tsunami-unit.ts:953`（view）・`:943`（内容版の条件に閉じた印の集合の変化を足す） | 0・104 | :943 は中身 1 ref、:950 は中身 1 ref | view は :953 の末尾、:943 は行の中で書き換え（reanchor 1 件） | B0 → N0 → T0 | 無し（保存の中身から作る） |
| `P3-UNIT-L-001`・`P3-UNIT-R-001`・`P3-UNIT-B-001`・`P3-UNIT-Y-001`・`P3-UNIT-N-001`・`P3-UNIT-V-001` | landslide・flood・briefing・typhoon・nankai・volcano の unit の file（索引の part） | — | file の最後に足すので 0 | file の最後に足す。«» の影響 0 | B0（C1 が描く） | 無し |
| 配送済みの条文に残る版の字（`p3-seismic-expiry-view.json:194` の「schemaVersion p3-seismic-unit-v8」など） | 改訂しない | — | — | その契約が版を上げた時の記録で、今の版の真実源は `seismic-unit.ts` の SCHEMA と型。U-Q の上界の字 `283_209` を書いた条文（`p3-seismic-event-limit.json:271` など）も、B0 は `283_209` を直さず MEMORY_GROWTH に足すので改訂しない。器と予約の合計を書いた条文（`p3-seismic-event-limit.json` の器 26,519,529 の見込み〔:191〕、`p3-disaster-pi-measure.json`・`p3-final-gate.json` の測りの記録）も、その配送の時点の値の記録なので改訂しない。B0 の後の器と予約は実装が dist の export で数えて成果物に書く | — | — |
| 台帳 98 の契約（新しい小さい契約） | `eew.ts:191`・`:195`・`:201`・`:628`〜`:638`、`p2-eew-unit.json:93`〜`:101` | :191 が 1 ref | 行を足すと 73 行 122 refs | 行の中で書き換え | B0 → 台帳 98 → E0 発注 1 | 無し |
| `P3-LIFETIME-AND-EEW-GATE-001`ほか計画 §2.3 の残り | 計画のとおり | — | — | B0 の範囲外 | 計画のとおり | 計画のとおり |

- U-Q の増え分（r6、契約適合レビュー r0 の P2-3）: 行に足す欄の最長（depth は magnitude と同じ MaterialValue の上限〔raw・value 32 字〕、magnitudeDescription 32 字、tsunamiComment 128 字、strongest は区域コード 8 個と省いた件数。1 字 3 byte、`p3-seismic-unit.types.ts` の行のコメントと同じ数え方）で 1 行 892 byte、15 行（区分 3 × 5 行）で 13,380 byte。実装は sizeOf で同じ形を数えて定数にし、MEMORY_GROWTH に足す。型の 1 行の最大のコメント（1,206 byte）も同じ行の中で直す。

## 5. 問いの答え

### 5.1 合成の更新の計算量（ヘルツの再レビューで成立）

| 手間 | 回数 | 上界 |
|---|---|---|
| 1. 変わった subject の入力区域を読む | 変わった subject の before と after の区域の数（未知も件数に数える） | ほかの EEW の区域は読まない |
| 2. 変わった既知区域の最大を引き直す | 参照数が変わった既知区域ごとに段 10 を上から見る（鍵 `op|eewPaint|code|段` と `op|eewPaint|code|?`、`applyRefs` の「0 なら削除」） | 既知区域の数 × 10 |
| 3. 公開する配列を組む | 塗る区分ごとに既知区域の数 | EEW の件数に比例しない |
| 4. 地震の合成（観測の震度・長周期） | その step で変わった event・長周期の subject（displayChanges）の before と after の区域だけを読み、参照数（鍵 `op|quakePaint|code|段`・`op|lgPaint|code|段`）を足し引きする。参照数が変わった既知区域ごとに段 10 を上から見る | 市区町村 1,894 × 10、細分区域 188 × 10。event の数（上限 1024）に比例しない。前の日・6 件目からの地震の区域も、変わったときだけ読む |
| 5. 津波の合成（予報・観測の最大） | その step で変わった予報・観測の subject の before と after の予報区だけを読み、参照数を足し引きする。参照数が変わった予報区ごとに区分 7 語を上から見る | 66 × 7。EventID の数（上限 512）に比例しない |
| 6. 閉じた観測の印（§5.5） | その step で変わった記録（before と after）だけから、閉じた印の集合を足し引きする。全記録を走査しない | 変わった記録の数 |
| 7. 9 分野の語彙（§12） | その step で表示差分のあった subject の item だけを作り直し、その item の byte を数える（今の projector と同じ、`view-projector.ts:185`） | 変わった subject の数 |

metadata だけの更新は今の参照の使い回し（`view-projector.ts:571`〜`:580`）を保ち、要約→full でも数え直さない。

### 5.2 台帳 98（ヘルツの再レビューで成立）

- 対象: 深さ 150km より深い報（PLUM 2 点以上を除く）と、観測点 1 点による震度予測の報（解説:4176〜:4183）。
- 確定（H51）: 受けて読めた中身を残す。予測は maximum の From・To とも missing、区域 0 件（型は変わらない）。カードの種類と音は作者（D-B0-NO-INTENSITY）。
- 直す行: `eew.ts:191`・`:195`・`:201`・`:628`〜`:638`。«» は :191 の 1 件。

### 5.3 設定した地域と札の字

- 1 件のときは大カードの行から、2 件以上のときはカードごとの [コード, 段の番号] から、描画の側で引ける（計画:259 は変えない）。2 件のときの上位 2 行は projector が作る。
- 仮定震源要素の報の札（DS-EEW-06）は、行の到達の状況が 9 の区域だけに出せる。小さいカードの設定した地域の札に効くかは DS に無い（未確認）。
- 札の字 A〜F と出ているカードは projector が決め、選ぶ規則（DS-LAYOUT-07・E0-1）は E0 が `display-wire.ts` に置く。

### 5.4 最大予測震度のみの報（ヘルツの再レビューで成立）

- 形: Intensity・全体の ForecastInt・Text は出る、OriginTime・Pref は出ない（解説:3910〜:3915・:4221〜:4224・:4391〜:4396・:4759〜:4763）。今の新築は VXSE45 で受け取れる。「以上」は `prediction.maximum` で足りる。
- `detectOnly` は VXSE45・非取消・Intensity と ForecastInt がある・区域 0 件・OriginTime が無い・Text がある、を全部満たすときだけ真。1 つでも欠ければふつうの報。
- 場所の文は Text の 2 行目の空白の並びの前を切り出す案。根拠は事例 2 つだけ（証拠不足）。切り出せないとき（2 行目が無い・空白の並びが無い・切り出した字が空）は場所の文を null にし、画面は場所の行を詰める（計画:257、作者裁定 2026-11-19）。切り出した字は 192 byte（§1.3）で切り、cut の印を付ける。

### 5.5 津波の観測が閉じた印

- 値: `closedObservations`（運用区分・EventID・family・閉じた時刻＝`retainUntil − RETAIN_MS`・`ref`）。区分ごとに新しい 4 件と件数。
- 出す版: active → expired の版（表示差分あり）と、期限待ち → expired の版（§4 の :943 の直しで内容版が上がる）。
- 消す版: 記録が消える版（保持期限 7 日、:778〜:781。§4 の直しで内容版が上がる）か、同じ観測が active に戻った版。
- 画面に何日出すかは T0 の板（T0-2）で、値が出ている範囲の中で決める。

### 5.6 日次行だけ残った地震の `ref`

- 今日の地震の行から詳細を開く操作がある（§2.2 の U-Q の起点、C0 発注 2）ので、日次行は `ref` を持つ。
- 日次行は source を持たず（`p3-seismic-unit.types.ts:151`）、event は期限や退去で消えても日次行は日付の境まで残りうる（`seismic-unit.ts:1228`）。
- 決め: 日次行の `ref` は id（eventId から作れる）を必ず持ち、rev は同じ snapshot に event があるときだけ載せる。event が無いときは rev を null にし、画面は開く操作を出さない。古い rev で要求が来たときは、配送済みの U-W と同じく対象の消滅（`versionChanged`、`revision: null`、`weather-current-public.ts:288`）を返す。

## 6. 作者の分岐の候補（画面の出る／出ないが変わるもの）

数字は script の出力（§1.4）。起点は組 A（243,262、余り 18,882）。r6 で短いカードに cut の印を数え、短いカードの組は 1,008 byte 増えた（§1.4）。下の表は裁定の時に見せた r5 の数のまま残す。どの分岐も入る・入らないは変わらない。

| ID | 問い | ★推奨 | もう一方 |
|---|---|---|---|
| D-B0-OPERATION | 訓練・試験の EEW・津波・地震を地図に塗るか | ★A 通常だけ塗る（余り 18,882）。訓練・試験はカードと行に区分の印で出す。閉じた観測の印は 3 区分とも残す。初期画面から消えるのは、訓練・試験の地図の塗り | B 区分ごとに塗る。カードが今の長さなら 314,191 で入らない。短くすれば 251,983（余り 10,161）。短く＋細分区域なら 172,957（余り 89,187） |
| D-B0-TSUNAMI-COUNT | 予報区の行を wire に載せる津波の EventID の数 | ★A 3 件（余り 18,882） | B 2 件（224,195、余り 37,949）。3 件目からは予報区の行が初期画面に出ず、件数と塗りになる |
| D-B0-TSUNAMI-COMMENT | 付加文を初期画面にどこまで出すか（unit は 4,096 字で切っている） | ★A 頭から 2,048 byte と切った印。全文は詳細で読む | B 4,096 字の全部を載せる。組 A では 310,846 で入らない。カードを短くすれば 248,638（余り 13,506）。区分ごと＋短いカードでは 319,567、津波 2 件にしても 277,972 で入らない |
| D-B0-TSUNAMI-DETAIL | wire に載せない津波の行（コードなし予報区の 9 行目から・観測の表・COUNT を超えた EventID の予報区の行）を、どう読ませるか | ★A カードのページ送りがそのページに来たら裏で取りに行く（操作なしで読める） | B 操作したときだけ取る。初期画面では件数・予報の塗り・観測の予報区ごとの最大の塗りが残り、行は触るまで読めない |
| D-B0-CARD-TEXT | 読めない報のカードの題と見出しを、画面へ送るときに短くするか（保存の 1,536 byte は変えない） | ★A 題 96 byte・見出し 384 byte（escape 後。字数の目安は題 32 字・見出し 128 字）で切って印を付け、全文は原文を開く（余り 81,090）。初期画面から消えるのは、題の 33 字目ほどから後と見出しの 129 字目ほどから後 | B 1,536 byte のまま（余り 18,882） |
| D-B0-NO-INTENSITY | 予測震度の無い EEW（深さ 150km 超・観測点 1 点）のカードと音 | ★A ふつうの EEW のカード、最大予測震度の札は値を出さない形（字は E0 の板）。音はほかの EEW と同じ判定 | B 別の形のカードにし、鳴らさない。どちらも受けて読めた中身は残す（H51） |

板待ち（M0-1・C0・E0-1・長周期）と、統合担当が決めたもの（Condition の符号化・札の字・SSE の分離）は入れない。

## 7. 統合担当の決め（確定 2026-11-21、契約 r0 の decisionBranches の P4-DW-D-DETAIL-PAYLOAD・D-QROW・D-EEW-UNCONFIRMED）

- I-B0-DETAIL-PAYLOAD: ★A 詳細の応答を worker の側で表示語彙の行にして返す（R46）／B 分野の DTO の union のまま。A でも境界型は分野の DTO の union で、許可欄はそこに固定する（spec:1268）。
- I-B0-QROW: ★A 今日の地震の行の欄を unit の行に持つ（保存の版を上げ、開発の保存は初期化）。
- I-B0-EEW-UNCONFIRMED: ★A held の印を current に写して表示差分を出す（§1.6・§4）／B EEW のカードに未確認の印を出さない（今の view にも無い）。画面の出る／出ないが変わるので、B を選ぶなら作者に戻す。

## 8. 未確認と証拠不足

- 証拠不足: 合計は projector に通していない。案 A での C4・C6 の旧 full の保証（B0 が旧 view に欄を足すため数え直しが要る）。二重の射影の Pi の費用。最大予測震度のみの報の実電文。
- 未確認: U-Q の `listed` の期限待ちの扱い（§1.6）。小さいカードの設定した地域の札の PLUM。震央地名の最長。1,892 と 1,894。
- 未確認（r6）: H17 の消えた理由（§13.2）で、取消・期限切れが unit ごとに outcome の transition と deadlineApplied に出るか。U-E の取消は `view-projector.ts` の notice の取り下げ（transition の cancelled・released）で確かめた。ほかの unit は実装の試験で出し、分けられない消え方は `unknown` で出る。最大予測震度のみの報の場所の文の切り出しの根拠は事例 2 つ（§5.4、証拠不足のまま）。

## 9. 計画の改訂の候補

| 計画の所 | 改訂の中身 | 理由 |
|---|---|---|
| §3.2 の snapshot の型と projector の行（計画:223） | 「B0（新しい file）→ B1 → E0 発注 1（`display-wire.ts` の札の字と選ぶ規則だけ）→ T0（旧の経路と旧の出力の撤去・版上げ）」。C2 は外す（描画の directory だけを触る） | D-B0-LETTER=A、T0 の旧形撤去。計画:193 で E0 発注 1 と C2 は並走するが、別の file なので並走できる |
| §3.2 の `http-sse.ts` の行（計画:230） | 「B0 → B1 → R0 → T0」 | T0 が旧の経路を消す。R0 は Wave 4、T0 は Wave 6 |
| §3.2 の unit の view 型の行（計画:224）と `eew.ts` | 「B0 → 台帳 98 の契約 → E0 発注 1」を `eew.ts`・`p2-eew-unit.types.ts`・`p2-eew-unit.json` の直列に | 同じ file を触る |
| §3.2 に行を足す: `composition-root.ts:2438`・`owner-runtime.ts`（`detailOwner`）・`p2-snapshot-sse.json`（P2-A8-COST） | B0 の所有。P2-A8-COST の例外は T0 で消す | 詳細の union を B0 が全部作る。移行中の例外 |
| §3.1 の Wave | B0 実装の前に G0 の既知コードの表。台帳 98 は B0 の後・E0 発注 1 の前。T0 に旧の経路の撤去と版上げ。PI 発注 1 の段 1 は二重の射影の下で走ると書く | §1.1、§3.2 |
| §2.1 の B0 の依存 | 「G0 の既知コードの表」を足す | §1.1 |
| §3.1 の新旧の切替点（計画:209「ほかの 10 分野は B0 の配送で表示語彙だけにする」） | 「旧 `/events` は 12 分野とも今の出力のまま T0 まで残す。新しい経路は B0 の配送で 12 分野を表示語彙にする（保護 3 分野は §1、9 分野は §12）」 | I-B0-LEGACY=A で旧の経路を分けたため、旧の側から分野を外さない |
| §1.1 の 1（計画:35〜）と §4.3 の 1（計画:306〜:309） | 「12 分野の表（いつも送る事実・個別取得・要約の最小事実・最大 byte）は B0 の表 §12 が持つ。B1 は落ちる順と残す順位・予算の配り方・公開頻度を持つ」 | 契約適合レビュー r0 の P1-1。9 分野の語彙の形を B0 が持たないと、型の凍結の後に C0・C1・C2 が `display-wire.ts` と型を開け直す |
| §4.1 の語彙の最初の形（計画:248〜:249） | 「最初の形は B0 の表 §12.1。専用部品の形（台風の予報円・水位のミニグラフ）も §12.3 で B0 が持つ」 | 同上 |
| PM（`P4-DISPLAY-MEASURE-001`）へ送る項 | spec:1288 の開始済みの射影の非中断区間の測定に、詳細の rev の作り直し（owner が要求ごとに object を view の形にして sha256 を作る分）を含める | ヘルツの 4 巡目の証拠不足（版の作り直しの実時間）。urgent の場所の詳細は EEW と同じ owner で走る（§2.2） |

## 10. ヘルツの再レビュー（r2）と統合担当の指示への対応

| 項 | 当て方 |
|---|---|
| #2・#10・#13 の参照と版（P1） | §2.1: id は U-F・U-W の sha256。rev は r2 で source の三つ組の列の sha256 にし、r4 (b) でその part が返す view の object の JSON の sha256 に置き換えた（下の r4 (b) の行）。U-E は原文からは読めないので U-W の `areas` に倣い、カードに `ref` を載せて byte に数えた。U-T の未知区域は `areas` に入れた |
| #13 のページの 64 KiB（P1） | §2.1: U-W の加算と pageBudget の省略に倣い、出どころの無い数は消した。通常合法 corpus で省略 0 件を受入にする |
| #3・#4（P2） | script で null を含む最長の値で数え、閉じた観測の印を 3 区分とも数えた |
| #6（P2） | §3.2・§4: P2-A8-COST の移行中の例外の行と、「Pi で動く前」の理由の訂正 |
| #11（P2） | §6: 数字を script の出力にし、組み合わせの合計を足した。DETAIL を COUNT に連動、操作のときに残る塗りを書いた。CARD-TEXT に題の 33 字目からを書いた |
| #14（P2） | §9: `http-sse.ts` は B0 → B1 → R0 → T0 |
| #15（P2） | §1.6: 族の表。直しは津波の :943 と EEW の held の 2 つ（§4） |
| 進め方 2 | `p4-display-wire-max.mjs` を置き、§1.4 と §6 をその出力にした |
| r4 (a) P1 地震の既知でない区域 | script の地震の行・長周期の見出し・合成ごとに `unknownAreas` を足し、§1.1・§1.2・§1.5・付録を揃え、§1.4・§6 を出力で置き換えた |
| r4 (b) P1 rev | §2.1: rev はその part が返す view の object の JSON の sha256（U-W の「返す内容が変われば版が変わる」に倣う、土砂の held の例） |
| r4 (b) P2 U-Q の part | §1.1・§1.5・§2.2 とも `event` |
| r4 証拠不足 日次行の ref | §5.6: id は必ず持ち、rev は event があるときだけ。古い rev には消滅を返す |

**(a) snapshot の wire と (b) 詳細の要求・応答・ページの境**: (a) の型（§1 の要素・文字列の上限・`ref` の id 64 と rev 64）は、(b) の 1 項目の最大やページの件数に依らない。(b) は配送済みの U-W の加算と pageBudget の省略で 1 応答 64 KiB を守り、(a) が持つのは最初の要求を組む `ref` と分野の `contentRevision` だけ。

## 11. r6 の対応（契約 r0 の契約適合レビュー、NO-GO）

レビューの ID ごとに、直した所か直さない理由。契約は `p4-display-wire.json`（r1）。

| ID | 直した所 |
|---|---|
| P1-1 語彙と共通部の形が無い | (a) を範囲を絞って取った（統合担当の決め）。§12（語彙の形・9 分野の載せ方・専用部品・1 MiB）と §13（共通部・H17・H39）を足し、script に 1 MiB と共通部の勘定を足した。計画の改訂は §9 に 3 行。契約は AC14・AC15・P4-DW-D-VOCAB・P4-DW-D-NEW-PATH-BUDGET・RES-03・RES-04 |
| P2-1 G0 待ちが止まらない | §1.1 の G0 の行。契約は artifactRequirements の最初の作業（baseOid は Q-DW-G0-CODES を閉じ、P4-GIS-ASSETS-001 を依存に、G0 の表の path を readPaths に足してから）、blocks に AC03・AC05・AC10、部分着手の blocked の文を消した |
| P2-2 allowedPaths が狭い | §4 の http-sse・composition-root・eew の行（行は実物で確かめた）。契約の allowedPaths と Q-DW-ANCHORS |
| P2-3 U-Q の版上げの 1 セット | §4 の U-Q の行（版の字 5 か所・decode・上界は MEMORY_GROWTH に足して付け直し 0・試験 3 file）。契約は AC16・T12・配送の手順（artifactRequirements）・allowedPaths |
| P2-4 配送済み契約の原文改訂 | §4 の版の字の行（改訂しない理由）。契約は AC06 を「配送済み契約の原文改訂」にし、P2-A8-COST と `p3-eew-facts.json:237` を並べた |
| P2-5 地震・津波の合成の計算量 | §5.1 に 4〜7 の行。契約は AC05・T02 |
| P2-6 H17・H39 の値 | §13・script。契約は AC15・T11 |
| P2-7 AC09・AC01 に試験が無い | 契約は T08（AC01）・T09（AC09） |
| P2-8 訓練が通常のカードを外す | §1.2 の EEW のカードの行（spec:1636 の決まり。外れた訓練・試験の報は件数だけ）。契約は P4-DW-D-SEVENTH-OPERATION・AC03・AC10・operationContract |
| P3-1 | §7 の見出しを「決め」に直した |
| P3-2 | 1 行目を r6 にし、§10 の 1 行目に r4 (b) で置き換えたことを書いた |
| P3-3 | §2.1 の運用区分の行（要求は operation を持たない）。契約は AC08 |
| P3-4 | §1.2 の EEW のカードの行（板待ちの仮の数）。契約は AC03 |
| P3-5 | 契約の AC07 の根拠を §1.6 の表の行に替えた |
| P3-6 | 契約の AC02 から spec:1587 を外し、§1.1 の H51 の行にした |
| P3-7 | 契約の AC の根拠を見出しから数の行に替えた |
| P3-8 | §1.2 の −1 の行の DS-ALL-14 を外し、DS-EEW-09・DS-INT-08 にした。契約の AC10 は DS-LAYOUT-06〜11 と DS-EEW-09 を引く |
| P3-9 | §4 に 6 unit の行（file の最後、«» の影響 0）。契約の allowedPaths |
| P3-10 | 契約の AC04 から「消す」を外し、試験は script の数と照らすだけにした |
| P3-11 | 契約の T07 に、違反を 1 つ仕込んだ形で落ちることを足した |
| P3-12 | 契約の fixtureIds に VTSE51・VTSE52・VXSE56 と 9 分野の電文を足し、T06 の corpus の範囲を書いた |
| P3-13 | 契約の artifactRequirements の残存に §8 の未確認を足し、AC09 に場所の文の切り出しと詰め方（§5.4）を足した |
| P3-14 | 契約の AC07 (2) に「decision は unchanged のまま、current の版は O01:3 のまま」を足した |
| P3-15 | 直さない。eew.ts を触る順は B0 → 台帳 98 の契約 → E0 発注 1 の直列のまま（同じ file）。新築は稼働していないので急ぎではない。作者への一言は統合担当が添える |
| P3-16 | script に短いカードの cut の印（1 枚 42 byte）を足した。§1.4 |

## 12. 表示語彙の最初の形と 9 分野の載せ方（r6）

無いと壊れる振る舞い: 9 分野の語彙の形を B0 が持たないと、weatherCurrent は C0 発注 1、残りは C1、共通部は C2 が `display-wire.ts` と型を触る。Wave 3（計画:193）の E0 発注 1 ∥ C0 発注 1 ∥ C2 が同じ file でぶつかり、計画 §1.1 の 1 が避けた「凍結の後に型を開け直す」になる。
範囲: 9 分野は、今の view の欄を項目ごとに語彙へ写すところまで（落とさない・足さない）。どれを画面に描くかは C0・C1 の板で決める。

### 12.1 語彙の形（判別共用体）

鍵の名前は仮の名で、B0 の型で決め直す。

| 種 | 形 | 上限 |
|---|---|---|
| 分野の包み | 今の `DisplayDomainView` の包みのまま（unit・contentRevision・items×3・delivery、要約の形も同じ、`p2-snapshot-sse.types.ts:80`〜`:88`）。full のときは `view` の代わりに `display: { items, facts }`（facts は分野に 1 つの値の事実の行） | 分野ごとに 65,536（§12.4） |
| 共通の見出し `head` | `{ kind, operation, title, time, serial, marks, ref }`。kind は分野の中の種別の有限のコード（例 `nankai.current`）。title は {text, cut} か null。time・serial は電文の生の字（source の reportDateTimeRaw・serialRaw）か null。ref は詳細の参照（§2.1）か null | kind 64 byte、time・serial 40 byte。marks は `unconfirmed`・`restored`・`expiryPending`・`capacityExceeded`・`unreadable`・`cut` の部分集合 |
| 事実の行 `facts` | `{ part: "facts", rows: [label, value][] }`。label は view の欄の名前（有限のコード）、value は型付きの値 | 行の数は view の欄の数（新しく切らない） |
| 区域の一覧 `areas` | `{ part: "areas", role, system, items: [code, name, values][], unknownAreas, omitted }`。role はまとまりの名前（view の group の名前か欄の名前）、system は `DisplayAreaSystem` か null、name は view が名前を持つ区域だけ（ほかは null で、描画が G0 の表から引く）、values は区域ごとの型付きの値の列（無ければ空） | 件数は unit の上限のまま（例: 土砂の区域の延べ 256、洪水の河川の延べ 32、台風の確率の地域 384） |
| 文章 `text` | `{ part: "text", role, text: {text, cut} }`。role は文の種類の有限のコード（`headline`・`prevention`・`inundation` など） | §12.2 |
| 型付きの値 | `["num", 数か null]`・`["code", 字]`・`["time", 生の字か ms]`・`["str", {text, cut}]`・`["bool", 真偽]`・`["sv", 種類, 下限, 上限, 生の字]` | sv の種類は旧築の意味の数値（`src/engine/display/protocol.ts:24`〜`:32`・`src/types.ts:88`〜`:94`）: `exact`（印なし）・`lowerBound`（≥）・`range`（↔）・`unknown`（?）・`empty`（∅）・`missing`（描かない）。MaterialValue は number・text→exact、range の lower→lowerBound、range の upper→range、unknown→unknown、empty→empty、missing→missing |

1 つの item は `{ head, parts }`。parts は view の欄の順に並べる（group ごとの事実の行と区域の一覧は隣に置く）。

### 12.2 9 分野の字の上限

- unit が字数の上限を持つ欄は、その字数 × 6 byte（escape の最悪）を上限にして、wire で新しく切らない（例: 南海トラフの title 128 字 → 768 byte、headline 512 字 → 3,072 byte）。
- unit が上限を持たない欄は 1,536 byte（`runtime-diagnostic.ts` の boundedString と同じ単位）で切り、cut の印を付ける。全文は詳細で読む（U-N・U-V の本文、U-W・U-F の詳細の口）。
- 9 分野の byte は分野の 65,536 と要約の規則で閉じる（§12.4）ので、9 分野は型の最大値の試験の対象にしない。上限の表は `display-wire.ts` の 1 つ（P4-DW-D-STRING-SOURCE）に、9 分野の欄も並べる。

### 12.3 専用部品（語彙の外、計画:249）

| 部品 | 形 | 上限 |
|---|---|---|
| 台風の予報円 `typhoonFrames` | TyphoonFrame の center（緯度経度の度）・circleRadiusKm・storm・gale・stormWarning（閾値と軸の方位・半径）を view の形のまま、frame ごとに 1 つ（`p3-typhoon-unit.types.ts` の TyphoonFrame）。投影後の座標と SVG path は入れない（spec §8.1） | frames 24・軸 2（`typhoon.ts:19`）。方位の字は 24 byte |
| 水位のミニグラフ `floodSeries` | FloodCurrent の times と stations（code・name・riverCodes・measurement・criteria・values・levels）を view の形のまま（`p3-flood-unit.types.ts` の FloodStation） | stations 20・points 40（`flood.ts:22`〜`:23`）。名前は §12.2 |

EEW・津波の大カードは §1 の形（保護 3 分野）。

### 12.4 9 分野の最大と新しい経路の 1 MiB

- 9 分野の最大は、分野ごとに 65,536（予算内の full）か要約（3,734 以下、`view-projector.ts:761`〜`:765`）。
- B0〜B1 の間の新しい経路の 1 MiB の振る舞い: 今の規則（全体が 1 MiB を超えたとき、65,536 を超えた分野を要約にする、`view-projector.ts:35`〜`:37`・`:904`〜`:906`）を新しい経路にもそのまま当て、保護 3 分野は要約にしない。要約の形は今の要約のまま（U-N・U-V・U-M は §2.2 の part=index で最初の要求を組む）。
- 上界（script の出力）: 9 × 65,536（589,824）＋ 通知 131,072 ＋ 共通部 65,536 ＋ 保護 3 分野 182,062（組 A短）＝ 968,494。1 MiB の余り 80,082。
- 新しい経路の要約は語彙の形の byte で決まる。旧の経路で full の分野が新しい経路で要約になることはありうる（残存に書く）。

### 12.5 9 分野の表（今の view の欄 → 語彙の種）

全分野で載せない欄（理由）: `semanticRevision`・`subjects`（統合担当の決め (2) と同じ、§1.2 の「wire に載せない欄」）。`contentRevision` は包みに載る。記録の `subject`（ref の id の材料で、id に入る）。`effective` は view が active だけを載せる配列（U-N・U-V・U-L・U-R・U-M・U-Y）では値が 1 つなので載せない（U-F と U-B は値が複数あるので事実の行に写す）。記録の照合の材料（source・marineSource の ReportRef のうち inputId・origin・subject・controlDateTimeRaw、`retainUntil`）。通知の印 `notice`・`marineNotice`（型のコメント「表示には出さない」）。U-V の `landEventId`・`marineEventId`・`landKind`・`marineKind`（family ごとの取消の identity、型のコメント）。
全分野で共通に写す欄: source の family・reportDateTimeRaw・serialRaw・infoTypeRaw → 見出しの time・serial と事実の行。`unconfirmed`（ReportRef）→ 印 unconfirmed。`expiryPending` → 印 expiryPending。`truncated` → 印 cut。`unreadableView` → 印 unreadable と事実の行 `unreadable`（site・scope・原文の有無の列と headline・addition・rawDropped・partsCut の真偽）。`unreadableCards` → §1.2 と同じ読めない報のカード（D-B0-CARD-TEXT=A）。ref の rev は §2.1（U-W・U-F は今の id・revision）。

| 分野（view の配列） | 共通の見出し | 事実の行 | 区域の一覧 | 文章 | 専用部品 |
|---|---|---|---|---|---|
| weatherCurrent `areas[]`（WeatherCurrentPublicArea） | kind `weatherCurrent.area`、operation、source、ref（id・revision） | prefecture・codes（Kind/Code ごとの区域の数）・names（Kind/Code ごとの Kind/Name）・cellCount・restoredCellCount | areas（[区域の層, Code]、層ごとに 1 つ、system は層） | — | — |
| weatherCurrent（分野の値） | — | 包みの facts に freshnessSuspectCount | — | — | — |
| weatherTimeseries `series[]` | kind `weatherTimeseries.subject`、operation、title に office、source、ref（id・revision） | effective・unavailableReason・validUntil・unknownCode の unknown・missing・empty・periodCount・lastKnownPeriodCount | areaCodes（role `all`）・knownCodes（role `known`） | — | — |
| nankai `currents[]` | kind `nankai.current`、title、source | line・status・eventId・infoSerial の code と name・validUntil・warningUntil | — | headline | — |
| nankai `information[]` | kind `nankai.information`、title、source、ref | family・eventId・infoKind・infoSerial の code と name・validUntil | — | headline | — |
| volcano `alerts[]` | kind `volcano.alert`、title に volcanoName、source | volcanoCode・eventId・kind の code・name・condition・lastKind の code と name・level・coordinate・海上の報（marineSource の family・reportDateTimeRaw・serialRaw）・海上の未確認（marineUnconfirmed の有無）・海上の読めない印（marineUnreadableView） | municipalities（group ごと、role は kindName、system は municipality）・marineAreas（group ごと、role は kindName） | headline・prevention | — |
| volcano `eruptions[]` | kind `volcano.eruption`、title に volcanoName、source | volcanoCode・eventId・flash・phenomenon の code と name・eventDateTimeRaw・craterName・plumeAboveCrater（sv）・plumeAboveSeaLevel（sv）・plumeDirection・validUntil | municipalities（code の列） | headline | — |
| volcano `ashfalls[]` | kind `volcano.ashfall`、title に volcanoName、source | volcanoCode・eventId・variant・forecastStartsAt・forecastEndsAt・omittedGroupCount。group ごとに hazardClass・ashCode・ashName・areaCount | group ごとの topAreas（[code, name, [firstForecastEndAt]]、omitted は omittedAreaCount） | headline | — |
| volcano `bulletins[]` | kind `volcano.bulletin`、title、source、ref | family・eventId・volcanoCodes（code の列）・extraordinary | — | headline | — |
| volcano `shortfalls[]` | kind `volcano.shortfall`、operation | id・slice・scope・volcanoCode・lastKnown の reportDateTimeRaw と serialRaw・reason | — | — | — |
| landslide `currents[]` | kind `landslide.office`、title、source | office。group ごとに code・name・level | group ごとの areas（role は name、system は municipality） | — | — |
| flood `currents[]` | kind `flood.event`、title に areaName、source | headType・eventId・basisReportDateTimeRaw・observedCompare。group ごとに code・name・level | group ごとの rivers（[code, name]）。inundation の group ごとの areas（[cityCode, name, [stationCode, prefecture, city, subCities]]、role は kindName、omitted は omittedAreaCount） | inundation の group ごとの text | floodSeries（times・stations） |
| briefing `currents[]`（VPBS50 の active・VPOA50 の released） | kind `briefing.report` か `briefing.recordRain`、source | headType・series・eventId・effective・editorialOffice・inherited。items ごとに kind・condition。observations ごとに part・areaCode・areaName・label・value・unit・approximation・time | items ごとの areas（[code, name]）。VPOA50 の areas | headline | — |
| localBulletins `tornado[]` | kind `localBulletins.tornado`、source | editorialOffice・activeUntil・sighted | layer ごとの areas（[code, name]、role は layer、system は層の名が `DisplayAreaSystem` にあればそれ、無ければ null） | headline | — |
| localBulletins `heat[]` | kind `localBulletins.heat`、source | editorialOffice・activeUntil・targetDate・areaName | — | headline | — |
| localBulletins `transient[]` | kind `localBulletins.<family>`、source | family・editorialOffice・visibleUntil・tags（字の列） | areas（[code, name]） | headline | — |
| typhoon `analysis[]` | kind `typhoon.analysis`、title に name.name、source | name の nameKana・number・remark・baseTime・activeUntil。frame ごとに kind・hours・validTime・category・intensity・size・location・moveDirection・moveSpeedKmh・moveCondition・pressureHpa・maxWindMs・maxGustMs | — | — | typhoonFrames（frame ごとの center・circleRadiusKm・storm・gale・stormWarning） |
| typhoon `probability[]` | kind `typhoon.probability`、title に name.name、source | name の nameKana・number・remark・baseTime・slotCount・maxFiveDay・activeUntil | prefectures（[code, name]）・areas（[code, name, [prefectureCode, daily 5 つ, peak, peakSlot]]） | — | — |

容量の設計 r2 §2 の 12 分野の表との対応（写し）: 9 分野の「いつも送る事実」は上の表の語彙で、どれを描くかは C0・C1 の板。「個別取得へ回す事実」は §2.2 の詳細の part（U-W の areas・lastKnown、U-F の current・lastKnown、U-N・U-V・U-M の本文と index、U-L・U-R・U-B・U-Y の index）。「要約の最小事実と最初の取得の参照」は今の要約の 3 行と §2.2 の最初の要求。「最大 byte」は §12.4 の 65,536 か要約。r2 §2 の実測（土砂の同時最大 96,460、洪水の 512 subject で 2,979,640 など）は、どの分野が予算を超えて要約になるかの材料で、B1 が使う。

## 13. 共通部と H17・H39（r6）

無いと壊れる振る舞い: 退去の理由・件数の不明・通知の結果の不明を作る側が無いと、C2 が描く値が無く、取消・期限切れ・押し出しが画面で見分けられない（H17）、落とした件数が 1 か所に出ない（H39）。

### 13.1 今の snapshot の形をそのまま写すもの

| 欄 | 形（出どころ） |
|---|---|
| 版の欄 | schemaVersion（新しい経路の版。旧の 1 とは別の値で、型が決める）・streamId・sequence・generatedAt・semanticRevision（`p2-snapshot-sse.types.ts:110`〜`:115`） |
| connection・worker | `DisplayConnectionView`・`DisplayWorkerView`（:34〜:46） |
| persistence・recovery・channels | `:118`〜`:120`、`DisplayRecoveryView`（:50〜:51） |
| notices | `VisibleNotice`（:98〜:108、64 件・131,072 byte） |

今の共通部（notices を除く）の上界は 49,443 byte（`p3-recovery.json:952` の保守の再計算: persistence の 12 unit がどれも failed で reason が全部 escape の 6 倍、digest 16,384、EEW の札 2,048、進み具合 4,096）。この検算は 2026-10-28 の値で、その後の共通部の型の変更は channels の `failing`（b55e31c9）だけ（最長の語 `unavailable` は変わらない。`git log --since=2026-10-28` で p2-snapshot-sse.types.ts・p3-recovery.types.ts を確かめた）。

### 13.2 足すもの

**H39 の件数 `losses`**: 12 unit ごとに 1 行 `{ unit, dropped, evicted, missed, outcomeUnknown, unreadable, hole }`。

- 区分の欄は [件数, 最後に足した時刻] か null（その区分の行が無い）。件数は unit の LossTally（`p2-shared-runtime.types.ts:551`）の count を区分ごとに足し（安全な整数で飽和）、時刻は lastAt の最大。理由の内訳は画面に出さない（spec 16.2.6「分野と件数だけ」）。
- 件数は owner が持つ間だけで、行は lastAt＋24 時間を過ぎると capture と復元で外れる（P3-NOTICE-LEDGER-001 の P3-NL-AC14 の (6)）。unit ごとの理由は最大 9（同 (7)）。

| 区分 | LossReason（`p2-shared-runtime.types.ts:547`〜`:550`、20 語） | spec の言葉 |
|---|---|---|
| dropped | notificationExpired・notificationExpiredClockUnverified・notificationCapacityEvicted | 落としたもの（通知） |
| evicted | eewCapacityEvicted・weatherCurrentCapacityEvicted・tsunamiCapacityEvicted・seismicCapacityEvicted・nankaiCapacityEvicted・volcanoCapacityEvicted・landslideCapacityEvicted・floodCapacityEvicted・briefingCapacityEvicted・localBulletinsCapacityEvicted・typhoonCapacityEvicted・seismicStationsFolded・noticeMarkEvicted・unreadableDropped | 押し出したもの |
| missed | capacityRejected | 取りこぼしたもの |
| outcomeUnknown | notificationOutcomeUnknown | 通知したか不明・出し直さない（H48） |
| unreadable | unreadableReport | 読めなかった報（H43 を H39 のまとめへ） |

- `hole`: unit の最古の穴の種類（`refused`・`disconnected`・`restarted`、`p2-shared-runtime.types.ts:637`）か null。publisher の `InputBoundaries` の unit の oldestHole を読む。`boundary(unit)`（`checkpoint.ts:842`）は位置が無いと null を返して穴の種類も落とすので使わず、`:842` の行の中に穴の種類だけを返す読むだけの関数を足す。件数の分からない欠けを 0 件と出さない（spec 16.2.6）。U-E・U-F は穴を持たない（`checkpoint.ts` の UnitInputs の holes、P3-RB-D-UF=B）ので hole は常に null で、EEW の切れていた間は今の `recovery.eewUnverified`（H28）で出る。
- 置き場は共通部。notices は 64 件で押し出されるので置かない。
- 運ぶ道: owner の state の losses（`owner-runtime.ts:47`）→ `OwnerUnitDelta` に `losses?`（変わった step だけ書き、無ければ前のまま。envelope の losses と同じ書き方。`owner-host.ts:299`・`:405`）→ composition-root の unit ごとの field（§4）→ 射影。旧 `/events` の出力と view は変えない（view に載せると旧の `full.view` の byte が変わる）。

**H17 の消えた理由 `removals`**: `{ items: [{ unit, operation, reason, at, ref: { id } }], omitted }`。新しい 32 件と、外した件数。

- reason は `cancelled`・`expired`・`evicted`・`unknown`。id は sha256([unit, operation, subject])（notice の targetId と同じ）。at はその step の wall の時刻。
- 決め方（同じ step の材料だけを、unit・operation・subject の鍵の Map で引く。全件の走査をしない）: displayChanges の after が null の subject について、(1) 同じ step の accepted の outcome でその subject の transition が `cancelled` なら cancelled。(2) 同じ step の deadlineApplied の outcome にその subject があるか、transition が `expired` なら expired。(3) transition が `released`（通常の解除）なら載せない。(4) どれでもなく、同じ step でその unit の losses の evicted の件数が増えたなら evicted。(5) どれでもなければ unknown（分からない消え方を取消・期限切れに読み替えない、H51）。
- 何秒出すかは C2 の板。B0 は新しい 32 件を残して at を載せる。
- 材料は composition-root の project() に来る outcomes・displayChanges（今の snapshotInput と同じ）と、上の losses。

### 13.3 上限と勘定（script の出力）

- losses 12 行・removals 32 件の最大で 8,525 byte（鍵 2 つの区切りを含む）。
- 今の共通部の上界 49,443 と合わせて 57,968。共通部 65,536 の余り 7,568。
- notices は今の 64 件・131,072 byte のまま（§12.4 の 131,072）。

## 付録 A 欄の形（script の object と同じ）

鍵の名前は数えるための仮の名で、B0 の型で決め直す。決め直したら script を直して §1.4 を出し直す。
欄の形の真実源は `p4-display-wire-max.mjs` で、ここには主な形だけを写す（`<N>` は escape 後 N byte、`MS` は最大の安全整数）。

- EEW のカードの見出し: `{"eventId":"<40>","operation":"training","letter":"A","warning":false,"serial":MS,"final":false,"reportTime":"<40>","max":{"f":null,"t":null},"hypo":{"text":"<192>","cut":false},"mag":{"v":"<32>","desc":"<96>","cut":false},"depth":{…同じ},"epi":{"text":"<64>","cut":false},"assumed":false,"detectOnly":false,"place":{"text":"<192>","cut":false},"lg":{"f":null,"t":null},"unread":false,"marks":[…4 語],"unknownAreas":MS,"dupAreas":MS,"ref":{"id":"<64>","rev":"<64>"}}`
- EEW の大カードの区域の行: `{"c":"622","f":null,"t":null,"cd":"arrived","ks":null,"at":"<40>","lg":{"f":null,"t":null}}`
- 小さいカードの最小の欄 `["622",null]`、合成の 1 区域 `["622",-1]`、市区町村の合成 `["2230600",-1]`
- 津波の予報の見出し: `{"eventId":"<40>","operation":"training","serial":MS,"reportTime":"<40>","comment":{"text":"<2048>","cut":false},"unread":false,"marks":[…],"omittedUnkeyed":MS,"unknownAreas":MS,"dupAreas":MS,"ref":{…}}`
- 津波の予報区の行: `{"c":"100","k":"majorWarning","first":{"raw":"<40>","cond":{"text":"<48>","cut":false}},"h":{"raw":"<24>","cut":false}}`
- 閉じた観測の印: `{"eventId":"<40>","family":"VTSE51","closedAt":MS,"ref":{…}}`
- 今日の地震の行（`unknownAreas` と、rev が欠けうる `ref` を含む）: `{"eventId":"<40>","operation":"training","origin":"<40>","reportTime":"<40>","hypo":{…},"mag":{…},"depth":{…},"maxInt":null,"cancelled":false,"tsunami":{"text":"<384>","cut":false},"strongest":["622",…8 つ],"omittedStrongest":MS,"marks":[…],"unknownAreas":MS,"ref":{"id":"<64>","rev":"<64> か null"}}`
