# P0 corpus manifest

作成: `node reconstruction/tools/corpus/check-manifest.mjs --emit-skeleton` の標準出力から各行を目視分類し固定（未確認雛形は検査不合格）。このオプションがないと260件のpath・byte・hashを手転記する必要がある。別builder・依存追加なし。検査: `node reconstruction/tools/corpus/check-manifest.mjs`。
形式判断 A/B: A=`{meta, fixtures: CorpusFixture[]}`（推奨・採用案）、B=別途meta格納規約を裁定。基準OIDは`46ea274fc216475f003647cc3d6626d2f52ef9d3`。自己hashは先頭meta.sha256の64文字だけをASCIIの0に置換したUTF-8全bytesのSHA-256（改行・空白も対象）。編集後は同規則で再固定する。検査は通常のファイル全体hashも別に出す。生bytesの自己hash埋込みは循環する。FieldChangeはA=既存replayの`{field,from,to}`（推奨・採用案、構造変更は説明文字列）、B=未定義の型を次契約で裁定。
260件=XML239+JSON21（2026-09-16 昇格: `promotion-2026-09-16.md`、新規3・既存5の来歴確定）。原本確認16（熊本8、WeatherCW VPWW56 1、dmdata 原本照合7: 福井VPWW55 06:51・11:40 既存＋20:04 新規、桜島VFVO52 発表・訂正 新規、VPTA50 TC2606 serial 41・87 既存。P-4 の3本は同日夕に本文3 reqで一致）・派生確認6（+3: EEW 2024-04-17 の77_01_01・77_01_26・36_01_10 は archive 原本の派生）・合成65（+1: 77_01_33 の取消は archive に無い合成）・未確認173（2026-09-12 の181＝取得元/hash不足156、Phase6B原本hashなし12、親原本不明コピー1、REST本文hashなし1、REST整形履歴なし4、checkpoint来歴不足6、Pi改変前hashなし1 から福井2・VPTA50 2・EEW4を来歴確定で除いた）。distributionは publicApproved 7（気象・火山7本、利用規約14項1号、2026-09-16 裁定 R8 P-3 A・P-4 A）／unconfirmed 253（EEW 4本は15項の確認待ち、他は個別根拠未確認）。公開mainへの配置承認は上記7本だけで、他は既存fixtureの所在台帳だ。 改変欄の再確認: 追記2行（Pi手順1・WeatherCW親hash1）、edited→unknownの降格4行（operational-v1/v2と各anonymized版）。4行は元からsourceStrength=unconfirmedのため強度別件数は不変、modification.kindはbyteIdentical16・edited7・synthetic65・unknown172（2026-09-16 夕）。
仮分類再導出: 官署名あり182・synthetic命名46・官署名○○の洪水7・WeatherCW抽出断片1。「182/47/7」の47は合成46と断片1を混ぜるため区別。官署あり群のVPWP50人工8と不正日時1も合成へ移し、最終XMLは原本9・派生2・合成55・未確認170（2026-09-12）→ 原本16・派生5・合成56・未確認162（2026-09-16 夕、P-4 反映後）。実在官署名では原本へ昇格しない。
JSONはcheckpoint9・restResponse4・expectedValues6・provenance2。判断 A/B: writer-outputはA=checkpoint（復元入力を優先、推奨・採用案）/B=expectedValues。旧hub出力はexpectedValuesだが独立oracleには使わない。replay日時変更はA=局所派生確認（親の配信原本性は未確認、推奨・採用案）/B=全てunconfirmed。コピーは親未確認ゆえbyteIdenticalにしない。外部corpus再取得・新規期待値・系列step・fixture追加なし。
対応規則: 以下は系列の材料割当であり系列合格ではない。全telegramXmlはO02、全checkpointはO07、REST応答は型に対応するO01/O03/O07、expectedValues/provenanceは本文の参照fixture・familyに対応するO02/O07/O09/O11の根拠に割り当てる（未対応なし）。日時nullは不存在または複数報で一意でないことをtransport.evidenceに記録。head.testは捏造せず、Control.Statusとreplay起源を分離。
route/familyはspec §4.3を適用（通常はheadType別family）。21route: eew=VXSE43/44/45、earthquake=VXSE51/52/53/61、lgObservation=VXSE62、seismicText=VXSE56/60・VZSE40、tsunami=VTSE41/51/52（51/52独立）、nankaiTrough=VYSE50/51/52/60、volcano=VFVO50/51・VFSVii(alert)/52/56(eruption)/53/54/55(ashfall)/60・VZVO40(短命)、weather=VPWS50・VPWW55–61（56独立）、weatherWarningTimeseries=VPWP50、briefing=VPBS50、legacyCounterpart=VPOA50・VPNO50、tornado=VPHW50/51、earlyWeather=VPAW51、climateInfo=VPZI50・VPCI50、weatherExplanation=VPCJ51・VPZJ51・VPFJ51・VMCJ53–55、heatAlert=VPFT50、typhoonAnalysis=VPTW60/61/62、typhoonProbability=VPTA50、floodForecast=VXKO50・VXSU50。ignoreは対象XMLなし、rawは未対応/不正の診断候補（WeatherCW断片を完全電文として受理しない）。
| 系列 | fixture選択・route/family対応・未充足条件 |
|---|---|
| O01 | eew・earthquake・volcano三slice・floodForecastのXML、RESTのVTSE41/VFVO50/54/55。発表/訂正/取消の個片はあるが、同一subject/revisionの完全履歴・重複/遅着stepは未作成。2026-09-16: 桜島VFVO52 原本2報で同Serial・新ReportDateTime訂正→重複→遅着のケース（O01:56〜60）を追加。同時刻訂正・取消はunmetのまま。 |
| O02 | 全XMLの正常・empty・unknown・不正判別。`synthetic_*`、`81_*VPWP50*`、`76_*VPTA50*`、WeatherCW断片を含む。JSON期待値6本は対象familyの根拠、provenance2本は由来根拠。現状の個片を全familyの境界充足としない。 |
| O03 | weatherのVPWS50/VPWW系＋legacyCounterpartのVPNO50、`phase6b_*` VPOA50→VPBS50と`replay/*`。code00は2026-09-16に福井20:04原本でO03:14を充足。所有現象/対応取消履歴のstep未作成。 |
| O04 | `vpws50-stale-lock/pi-stale-lock-state.json`＋VPWS50/VPWW*（weather）。既存README・`test/engine/messages/vpws50-stale-lock-recovery.test.ts`を根拠参照。8日前状態からの採否・官署/運用区分交差stepが不足。 |
| O05 | VTSE51/52 XML（tsunamiObservation各family）、特に`32-39_11_10_250206_VTSE51.xml`・`61_11_01_250206_VTSE52.xml`。station identityの根拠だけ。同revision分割・順序交換・同station訂正は不足。 |
| O06 | weatherのVPWS50/VPWW*、`vpws50-stale-lock/*`、`standby-persistence/*`。全国履歴2/partial8の境界・連続取消を結んだ履歴なし。 |
| O07 | 全checkpoint9本（standby-persistence8＋Pi状態1）、対応XMLとREST応答。v1/v2旧築migrationの材料であり新築checkpoint形式ではない。save/restart後の訂正・取消・unknownと通知期限の系列なし。 |
| O08 | 全XMLの対象/報告日時、特にVPFT50(heatAlert)、VFVO53(ashfall batch)、VPOA50/VPBS50(相関)。時計逆行・大幅補正・期限横断・入力停止のstepなし。 |
| O09 | 全XMLをbyteLengthで比較（VPWP50/VPTA50の大規模入力）、VXSE43/44/45・VTSE41優先割込み。`*capacity-expectations.json`は旧上限の参考のみ。最大XML・encode競合・burst・personal有効の時刻/実paint記録なし。 |
| O10 | 全checkpointと対応XML/REST（保存対象各family）。disk full/write遅延/rename前後kill/ack喪失/通知・export・stdout失敗の故障注入stepは全て未作成。 |
| O11 | `phase6b-legacy-card-production.json`(briefing)、`vpwp50-forecast-expectations.json`、`typhoon-probability-card/expectations.json`と対応XML、EEW/津波。SSE切断/slow client/更新合流/metadata churn/割込みのstep・新築期待値なし。 |
不足「正常」: 個片はあるが全21routeの原本確認が不足しignore対象は0本。REST取得見込み=VPWW53/54等のignore候補や各対応typeの発表報、契約・提供期間内の少数採取。公開許可と原本hashを同時に記録する（取得可能性は未実査の計画上の見立て）。
不足「訂正」: VFVO52/VFVO56と人工VXKO50には訂正片があるが全familyの同revision訂正連鎖なし。原本1例あり（2026-09-16、桜島VFVO52 同Serial・新ReportDateTime訂正。同時刻訂正ではない）。REST見込み=VXSE系/VFVO系/VXKO50等で訂正が発表された事例。未発生の組合せはsynthetic、原本確認とは分離。
不足「取消」: VXSE/VTSE/VFVO取消・人工VPWP50等の個片はあるが全familyの連続取消/重複/遅着系列なし。REST見込み=同EventIDの取消発表事例（VXSE51/52/53・VFVO52/56等）。遅着順序と重複はsyntheticなreplay操作で補う。
不足「解除」: VTSE41解除、VPNO50切替、VPTA50全ゼロ等はあるが区域別降格後の古報非復活系列なし。原本1例あり（2026-09-16、福井VPWW55 20:04 code00×16）。REST見込み=津波解除VTSE41、VPNO50区域解除、VXKO50解除、VPTA50消滅の前後報。制御した遅着はsynthetic。
不足「empty」: VPBS50/VPFT50人工空はあるがVPWP50/VPTA50 newer gate-onlyと全familyの明示空の期待判別なし。REST見込み=有効発表として空になる対象typeの観測事例があれば採取。欠落/空の意図的組合せはsyntheticで補い、合法性を別途公式仕様と照合。
不足「unknown」: 特殊震度/深さ/Magnitude・VPWP50未知コード等の個片はあるが洪水全unknown・復元直後unknown・運用区分交差系列なし。REST見込み=VXKO50水位不明やVXSE系未入電を含む事例。未観測形・矛盾入力はsynthetic。
不足「不正」: invalid-report-datetime・Head欠落はあるが壊れたXML/encode、必須運用区分欠落・矛盾・不正値の網羅なし。RESTで合法原本としての取得は見込まず、破損と拒否境界はsyntheticでしか制御できない。
不足「上限境界」: 大きい実XMLと旧容量期待JSONはあるが新築のbytes/node/depth/属性/text・履歴2/8・queue・SSE上限の直前/一致/+1系列なし。REST見込み=VPWP50/VPTA50の大規模正常報は参考負荷。厳密な閾値入力と故障/時計/SSE操作はsynthetic。取得も追加も次段の作者裁定待ち。

系列起草: `sequences.json` は O01〜O11 の `steps` と、`expectedRef` で結ぶ `expectations`。各stepのfield集合・順序・nullableはspec §9.5どおり。
形式 A/B: A=`{meta,sequences,expectations,unresolvedQuestions}`（推奨・採用）、B=別file分割。自己hashはmanifestと同規約、baseOidは本契約`3669dfd6a`、参照manifestは`meta.manifestSha256`で固定（manifestの来歴baseとは別）。
期待値型 A/B: A=Step/Effectiveの部分射影＋subjectsの入力revision tuple・notices/intents・basis・input・checks（推奨・採用）、B=未定義ExpectedDecision/EvidenceRefを先に全面設計。型と各fieldの必要理由はmetaに記載。
比較: `checks`にcurrent/watermark/tombstone/履歴/副作用/性能条件、`input`に制御操作または必要入力形とREST見込み/syntheticを記す。nullは非適用かQ-*未決で、未決を一致と数えない。
時計: 全値は合成epoch ms。原XML日時は変更せず、独立ケースのrestartで初期時計/stateを固定。旧checkpointはsavedAt、Pi stale-lockは8日差。replay起源とControl.Statusを分離しhead.testを捏造しない。
unmet（系列別）: O01=14、O02=12、O03=3、O04=5、O05=12、O06=24、O07=1、O08=4、O09=57、O10=0、O11=5（計137、2026-09-16。起草時は O03=4・計138）。fixtureId=nullと`unmet:Oxx:n`で明示、依存する後続stepも条件付き。O05の分割/順序交換はsynthetic待ち。
検査 A/B: A=別`check-sequences.mjs`（推奨・採用）、B=既存checkerへ一体化。別fileがないと来歴と系列受入の検査が混在するため分離し、既存hash関数/定数はexportして再利用。追加検査はP0受入条件と参照・型・時計の契約境界だけ。
実行: `node reconstruction/tools/corpus/check-manifest.mjs` と `node reconstruction/tools/corpus/check-sequences.mjs`。後者も前者を実行する。build/vitest=N/A（契約対象外）。検査PASSは意味oracle/故障注入/実paintの実行PASSではない。
未決: 末尾unresolvedQuestionsの11件にowner/blocks/resolveBy。fixture追加・REST取得・manifest更新なし。2026-09-14「すべてA」は作業の3分岐への裁定。Q5-a・Q5-b・Q7はspec §15.1どおり未裁定（owner user、期限P4着手前）で、裁定依存の期待はnullとQ-NOTICE等で区別する。

## P1 parser boundary contract

作成: `reconstruction/contracts/p1-parser-boundary.json` はspec §14.1の全fieldを持ち、`fixtureIds`でmanifest全260件（2026-09-16 昇格後）、`sequenceIds`と`expectedRef`でO02/O09およびO01の運用区分stepを参照する。`expectedRef`先のdecisionがnullなら合格値に数えない。保存単位は実装しないため`persistenceUnits: []`とし、全`I-U-*`は運用区分の下流伝播先としてのみ`integrationContractIds`に列挙する。

型判断 A/B: A=`p1-parser-boundary.types.ts`へ依存なしのTypeScript型として分離（推奨・暫定採用）、B=JSON内文字列。Aがないと実装側が`Operation`・取得起源・三判定源のpresence・拒否reasonをコンパイル時に参照できない。自己hashはmanifestと同規約で、参照したmanifest/sequencesの`meta.sha256`も固定する。

検査: `node reconstruction/contracts/check-contract.mjs`。このcheckerがないと§14.1必須field・全fixture参照・sequence/expectedRef実在・null decision除外・未決owner/resolveBy・自己hashの破損をP0完了前に検出できない。hash関数・規約・zero hashは`check-manifest.mjs`からexportを再利用し、複製しない。build/vitestは契約起草ではN/A、P1実装完了時は`npm run build`と`npm test`を必須とする。

未決: Q-OPは合法なStatus非提供形式、Q-ENUMは非operation拒否とunavailable、Q-LIMITはXML構造上限だけをowner/blocks/resolveBy付きで残す。operation reason四種、8 MiBのWS/REST入力、展開後10 MiB、Q-NOTICE-Q7の2026-09-14裁定（spec §11全行）は契約側で閉じた。manifest/sequences自体は変更しない。

### 2026-09-15 独立レビュー反映（上記P1記述の更新）

D01は型分離Aを裁定済み（2026-09-15 ご主人）。D03はA=起草来歴`meta.draftedFromOid`と実装開始`contract.baseOid`を分離（推奨・暫定採用）、B=空契約を先にlandする2段commit。来歴と開始条件の混同を防ぐため分離し、`unassigned`はWARN付き起草PASS・実装着手不可。main掲載後、統合担当が契約を含むOIDを発注commitで設定し自己hashを再固定する。実装checkoutは指定OIDに固定し、発注OIDは委譲文で受け取る（別資材のJSONは作らない。checkerはcheckout内のJSONしか読まないため）。checkerは`P1_BASE_OID=<oid>`（未設定なら`contract.baseOid`）を入力口とし、OID指定時に`git cat-file -e <oid>:reconstruction/contracts/p1-parser-boundary.json`で存在を検証する。引数でなく環境変数なのはimport先`check-manifest.mjs`がargvを所有するため。見出し行の参照は本文として許す（空行・罫線・コードフェンスは拒否）。前回D02（sequencesの16参照+1）はbase汚染の誤診断につき不採用。

hashは先頭`meta.draftedFromOid`に続く`meta.sha256`の64文字だけをASCII 0に置換して全UTF-8 bytesを計算する。`sha256`・`zeroHash`・`hashConvention`は既存`check-manifest.mjs`のexportを使う。manifest/sequencesの自己hashを参照し直す。field集合は検査するが一般fieldの順序は強制しない。

保存単位を扱わないため`integrationContractIds: []`へ更新し、伝播先は`operationContract.propagation`に保持する。展開失敗等は診断の`undetermined`と観測済みsourceだけを記録する。未判定を表せないと壊れたXMLへ架空の区分を補うため、この診断状態が必要だ。四source状態は維持する。

新築検証はrepo rootで`./node_modules/.bin/tsc --project reconstruction/tsconfig.json`と`./node_modules/.bin/vitest run --config reconstruction/vitest.config.ts`。P1実装が両設定を作り、新築src/testを対象にし、出力を`reconstruction/dist/`へ隔離する。rootのcleanを呼ばず旧distを削除・上書きしない。今回の起草検査は従来の3つのnode checkerのみ、build/vitest=N/A。

七区間は§9.4の名前付きdurationMsとしてP1-AC14/P1-T07に対応し、最大VPWS50のenvelope・194period VPWP50・特殊値VXSE53を計測する。T0〜T6実paint時刻とは別。未実行はnullと理由を記録する。Q-OP期限は②のB03/B04境界契約前へ戻し、先行可能な独立作業をblocks欄へ明記した。Q-NOTICE-Q7の採否は閉じ、training/test通知・訓練音の具体条件はP2通知契約へ引き継ぐ。

### Q-LIMIT 計測（2026-09-16、P1 契約 requiredEvidence の 1 点目）

manifest の telegramXml 236 本を Python `xml.etree` で走査した最大値。parse 失敗 0。byteLength 4,567,490（`15_18_01_250630_VPWS50`）、node 数 155,247（同 VPWS50）、depth 12（`10_04_03_170913_VPTW60`）、1 node の属性数 5（`81_01_01_260129_VPWP50`）、属性値 36 文字（`32-35_01_03_240613_VXSE53`）、text 3,852 文字（`66_01_01_210517_VFVO53`）。node 数の上位 5 は VPWS50 が独占する。開始上限候補は最大正常 fixture に 2 倍の余裕を置いた node 320,000・depth 24・属性 16・属性値 256・text 16,384 を起点に P1-T05 で決める（この値は候補であり採用値ではない）。再計測は同じ走査（要素数・最大深さ・最大属性数・最長属性値・最長 text）を行えば足りる。

### Q-OP 根拠（2026-09-16、P1 契約 requiredEvidence の 1 点目）

Control.Status が形式上 notProvided になる合法入力は、WS `data` の `format` が `a/n` または `binary` の電文。dmdata WebSocket v2 仕様は `xmlReport` を「format が xml か json のときに含む」と定めるので、これらの電文では `xmlReport.control.status` も本文の `Control/Status` も存在せず、`head.test` だけが残る（三判定源のうち 1 源のみ）。FlEq が購読する区分では telegram.earthquake に WEPA60（a/n）・IXAC41（binary）、telegram.weather に WTJPii（a/n）が該当する（dmdata 電文データ一覧、2026-09-16 取得。telegram.volcano・eew.* は XML のみ）。既存型 `WsDataMessage.format` は `"xml" | "a/n" | "binary" | "json" | null` で、この形式を既に受ける。corpus 側の実例: telegramXml 236 本のうち `Control/Status` 欠落は 0、`Control` 自体の欠落は WeatherCW 抽出断片 1 本のみ（既知の断片、合法電文ではない）。Status 値の分布は 通常 223・訓練 5・試験 7。a/n・binary の実受信例は未取得で、必要なら REST 取得計画の probe で WTJPii の 1 ページを確認する（これも作者裁定後）。

### Q-OP 三判定源 matrix と必須 field 表（2026-09-16、P1 契約 requiredEvidence の 2 点目）

出典は dmdata docs `reference/api/v2/websocket/`（type="data" の field 表）と `reference/api/v2/socket.start/`（2026-09-16 取得）、電文一覧 `docs/telegrams/`。FlEq の socket.start は `classifications`・`test`・`appName`・`formatMode:"raw"` だけを送り `formats` を指定しない（`src/dmdata/rest-client.ts:528-533`）ので、契約区分に a/n・binary の型があればそのまま届く。対象は telegram.earthquake の WEPA60（a/n）・IXAC41（binary）、telegram.weather の WTJPii（a/n、ii=21〜26 定時・31〜36 臨時）。telegram.volcano・eew.forecast・eew.warning は XML のみ。

仕様の硬い 2 文（原文）: head.test は「訓練・試験等のテスト電文かどうか。**注意：XML以外は常にfalse**」。socket.start の test は「**注意：XML電文以外のテスト配信は no 時も配信されます。本文中を参照するようにしてください。**」。つまり a/n・binary では head.test が定数 false で、テスト電文の判別は本文形式ごとの内部表記にしか無い。

必須 field 表（type="data"。「いつも」は仕様の必須、「内容による」は仕様の任意）:

| field | xml | json | a/n | binary | 備考 |
|---|---|---|---|---|---|
| type／version／classification／id／passing | いつも | いつも | いつも | いつも | 共通 envelope |
| head.type／author／time／designation | いつも | いつも | いつも | いつも | designation は通常 null |
| head.target | 内容による | 内容による | 内容による | 内容による | 対象観測地点コード |
| head.test | いつも（実値） | いつも（実値） | いつも（**常に false**） | いつも（**常に false**） | XML 以外は定数 |
| head.xml | 内容による（true） | 内容による | 内容による（false／無し） | 内容による（false／無し） | |
| xmlReport.control.status（envelope Status） | あり | あり | **無し** | **無し** | 「format=xml または json 時」のみ |
| xmlReport.head.* | あり | あり | 無し | 無し | 同上 |
| 本文 Control/Status | あり（full parse） | JSON 変換版の control.status | **無し**（XML ではない） | **無し** | |
| format／compression／encoding／body | いつも | いつも（compression null・utf-8） | いつも | いつも | |

三判定源 matrix（`OperationEvidence` の sourceState で表す）:

| format | headTest | envelopeStatus | controlStatus | 帰結 |
|---|---|---|---|---|
| xml | provided（実値） | provided | provided | 三源を正規化して一致なら resolved、不一致は operationMismatch、欠落は operationMissing、不正値は operationInvalid |
| json | provided | provided | provided（JSON 内 control.status） | FlEq は `formatMode:"raw"` なので受けない。契約の対象外（xml と同じ扱いにするかは B03 で決める） |
| a/n | provided だが定数 false | notProvided | notProvided | 実値を持つ源が 0。**notProvided を normal の根拠にしない**規則により resolved にできない → operationAmbiguous（三源の存在状態を診断に残す）。format 境界で先に「XML でない」として拒否するなら、その reason は Q-ENUM 側で定める |
| binary | 同上 | notProvided | notProvided | 同上 |

Control.Status が形式上 notProvided になる合法入力は a/n・binary の 2 形式で、どちらも head.test が仕様上の定数なので「head.test だけで normal と判定する」経路を作らないことが B03/B04 の受入条件になる。テスト電文が test=no でも届く以上、a/n・binary を normal として業務 state に流す実装は訓練電文を本番表示する経路になる。実受信例（WEPA60・WTJPii）は未取得で、operationAmbiguous fixture は REST 取得計画の別段階（WTJPii 1 ページ、作者裁定後）で採るか synthetic で作る。json は FlEq の運用外なので fixture を作らない。
