# P0 corpus manifest

作成: `node reconstruction/tools/corpus/check-manifest.mjs --emit-skeleton` の標準出力から各行を目視分類し固定（未確認雛形は検査不合格）。このオプションがないと257件のpath・byte・hashを手転記する必要がある。別builder・依存追加なし。検査: `node reconstruction/tools/corpus/check-manifest.mjs`。
形式判断 A/B: A=`{meta, fixtures: CorpusFixture[]}`（推奨・採用案）、B=別途meta格納規約を裁定。基準OIDは`46ea274fc216475f003647cc3d6626d2f52ef9d3`。自己hashは先頭meta.sha256の64文字だけをASCIIの0に置換したUTF-8全bytesのSHA-256（改行・空白も対象）。編集後は同規則で再固定する。検査は通常のファイル全体hashも別に出す。生bytesの自己hash埋込みは循環する。FieldChangeはA=既存replayの`{field,from,to}`（推奨・採用案、構造変更は説明文字列）、B=未定義の型を次契約で裁定。
257件=XML236+JSON21。原本確認9（熊本8、WeatherCW VPWW56 1）・派生確認3・合成64・未確認181（取得元/hash不足156、Phase6B原本hashなし12、親原本不明コピー1、REST本文hashなし1、REST整形履歴なし4、checkpoint来歴不足6、Pi改変前hashなし1）。distributionは257件ともunconfirmed、利用規約・公開許可の個別根拠未確認。公開mainへの配置承認ではなく、既存fixtureの所在台帳だ。 改変欄の再確認: 追記2行（Pi手順1・WeatherCW親hash1）、edited→unknownの降格4行（operational-v1/v2と各anonymized版）。4行は元からsourceStrength=unconfirmedのため強度別件数は不変、modification.kindはbyteIdentical9・edited4・synthetic64・unknown180。
仮分類再導出: 官署名あり182・synthetic命名46・官署名○○の洪水7・WeatherCW抽出断片1。「182/47/7」の47は合成46と断片1を混ぜるため区別。官署あり群のVPWP50人工8と不正日時1も合成へ移し、最終XMLは原本9・派生2・合成55・未確認170。実在官署名では原本へ昇格しない。
JSONはcheckpoint9・restResponse4・expectedValues6・provenance2。判断 A/B: writer-outputはA=checkpoint（復元入力を優先、推奨・採用案）/B=expectedValues。旧hub出力はexpectedValuesだが独立oracleには使わない。replay日時変更はA=局所派生確認（親の配信原本性は未確認、推奨・採用案）/B=全てunconfirmed。コピーは親未確認ゆえbyteIdenticalにしない。外部corpus再取得・新規期待値・系列step・fixture追加なし。
対応規則: 以下は系列の材料割当であり系列合格ではない。全telegramXmlはO02、全checkpointはO07、REST応答は型に対応するO01/O03/O07、expectedValues/provenanceは本文の参照fixture・familyに対応するO02/O07/O09/O11の根拠に割り当てる（未対応なし）。日時nullは不存在または複数報で一意でないことをtransport.evidenceに記録。head.testは捏造せず、Control.Statusとreplay起源を分離。
route/familyはspec §4.3を適用（通常はheadType別family）。21route: eew=VXSE43/44/45、earthquake=VXSE51/52/53/61、lgObservation=VXSE62、seismicText=VXSE56/60・VZSE40、tsunami=VTSE41/51/52（51/52独立）、nankaiTrough=VYSE50/51/52/60、volcano=VFVO50/51・VFSVii(alert)/52/56(eruption)/53/54/55(ashfall)/60・VZVO40(短命)、weather=VPWS50・VPWW55–61（56独立）、weatherWarningTimeseries=VPWP50、briefing=VPBS50、legacyCounterpart=VPOA50・VPNO50、tornado=VPHW50/51、earlyWeather=VPAW51、climateInfo=VPZI50・VPCI50、weatherExplanation=VPCJ51・VPZJ51・VPFJ51・VMCJ53–55、heatAlert=VPFT50、typhoonAnalysis=VPTW60/61/62、typhoonProbability=VPTA50、floodForecast=VXKO50・VXSU50。ignoreは対象XMLなし、rawは未対応/不正の診断候補（WeatherCW断片を完全電文として受理しない）。
| 系列 | fixture選択・route/family対応・未充足条件 |
|---|---|
| O01 | eew・earthquake・volcano三slice・floodForecastのXML、RESTのVTSE41/VFVO50/54/55。発表/訂正/取消の個片はあるが、同一subject/revisionの完全履歴・重複/遅着stepは未作成。 |
| O02 | 全XMLの正常・empty・unknown・不正判別。`synthetic_*`、`81_*VPWP50*`、`76_*VPTA50*`、WeatherCW断片を含む。JSON期待値6本は対象familyの根拠、provenance2本は由来根拠。現状の個片を全familyの境界充足としない。 |
| O03 | weatherのVPWS50/VPWW系＋legacyCounterpartのVPNO50、`phase6b_*` VPOA50→VPBS50と`replay/*`。code00/所有現象/対応取消履歴のstep未作成。 |
| O04 | `vpws50-stale-lock/pi-stale-lock-state.json`＋VPWS50/VPWW*（weather）。既存README・`test/engine/messages/vpws50-stale-lock-recovery.test.ts`を根拠参照。8日前状態からの採否・官署/運用区分交差stepが不足。 |
| O05 | VTSE51/52 XML（tsunamiObservation各family）、特に`32-39_11_10_250206_VTSE51.xml`・`61_11_01_250206_VTSE52.xml`。station identityの根拠だけ。同revision分割・順序交換・同station訂正は不足。 |
| O06 | weatherのVPWS50/VPWW*、`vpws50-stale-lock/*`、`standby-persistence/*`。全国履歴2/partial8の境界・連続取消を結んだ履歴なし。 |
| O07 | 全checkpoint9本（standby-persistence8＋Pi状態1）、対応XMLとREST応答。v1/v2旧築migrationの材料であり新築checkpoint形式ではない。save/restart後の訂正・取消・unknownと通知期限の系列なし。 |
| O08 | 全XMLの対象/報告日時、特にVPFT50(heatAlert)、VFVO53(ashfall batch)、VPOA50/VPBS50(相関)。時計逆行・大幅補正・期限横断・入力停止のstepなし。 |
| O09 | 全XMLをbyteLengthで比較（VPWP50/VPTA50の大規模入力）、VXSE43/44/45・VTSE41優先割込み。`*capacity-expectations.json`は旧上限の参考のみ。最大XML・encode競合・burst・personal有効の時刻/実paint記録なし。 |
| O10 | 全checkpointと対応XML/REST（保存対象各family）。disk full/write遅延/rename前後kill/ack喪失/通知・export・stdout失敗の故障注入stepは全て未作成。 |
| O11 | `phase6b-legacy-card-production.json`(briefing)、`vpwp50-forecast-expectations.json`、`typhoon-probability-card/expectations.json`と対応XML、EEW/津波。SSE切断/slow client/更新合流/metadata churn/割込みのstep・新築期待値なし。 |
不足「正常」: 個片はあるが全21routeの原本確認が不足しignore対象は0本。REST取得見込み=VPWW53/54等のignore候補や各対応typeの発表報、契約・提供期間内の少数採取。公開許可と原本hashを同時に記録する（取得可能性は未実査の計画上の見立て）。
不足「訂正」: VFVO52/VFVO56と人工VXKO50には訂正片があるが全familyの同revision訂正連鎖なし。REST見込み=VXSE系/VFVO系/VXKO50等で訂正が発表された事例。未発生の組合せはsynthetic、原本確認とは分離。
不足「取消」: VXSE/VTSE/VFVO取消・人工VPWP50等の個片はあるが全familyの連続取消/重複/遅着系列なし。REST見込み=同EventIDの取消発表事例（VXSE51/52/53・VFVO52/56等）。遅着順序と重複はsyntheticなreplay操作で補う。
不足「解除」: VTSE41解除、VPNO50切替、VPTA50全ゼロ等はあるが区域別降格後の古報非復活系列なし。REST見込み=津波解除VTSE41、VPNO50区域解除、VXKO50解除、VPTA50消滅の前後報。制御した遅着はsynthetic。
不足「empty」: VPBS50/VPFT50人工空はあるがVPWP50/VPTA50 newer gate-onlyと全familyの明示空の期待判別なし。REST見込み=有効発表として空になる対象typeの観測事例があれば採取。欠落/空の意図的組合せはsyntheticで補い、合法性を別途公式仕様と照合。
不足「unknown」: 特殊震度/深さ/Magnitude・VPWP50未知コード等の個片はあるが洪水全unknown・復元直後unknown・運用区分交差系列なし。REST見込み=VXKO50水位不明やVXSE系未入電を含む事例。未観測形・矛盾入力はsynthetic。
不足「不正」: invalid-report-datetime・Head欠落はあるが壊れたXML/encode、必須運用区分欠落・矛盾・不正値の網羅なし。RESTで合法原本としての取得は見込まず、破損と拒否境界はsyntheticでしか制御できない。
不足「上限境界」: 大きい実XMLと旧容量期待JSONはあるが新築のbytes/node/depth/属性/text・履歴2/8・queue・SSE上限の直前/一致/+1系列なし。REST見込み=VPWP50/VPTA50の大規模正常報は参考負荷。厳密な閾値入力と故障/時計/SSE操作はsynthetic。取得も追加も次段の作者裁定待ち。
