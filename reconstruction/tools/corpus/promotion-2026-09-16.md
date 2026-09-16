# P0 完了資材 ④ 段階 2: 取得済み候補の昇格 spec（2026-09-16）

起草: 2026-09-16 昼（ヘルツ Astra high 独立レビュー 2 巡、条件付き GO の指摘 7 件＋再レビュー 5 点を反映済み。残条件は「実裁定の反映後に 3 checker 再実行」）。`rest-acquisition-plan.md` §6 段階 2 の実行 spec。対象は 2026-09-16 の probe と本文 10 件（`~/dev/fleq-corpus-p0/index.json`）で「候補あり」になった 3 群と、その照合で判明した既存 fixture 5 本の来歴確定。**この文書は裁定前の spec で、fixture 配置・manifest／sequences／contract の更新・checker 定数の変更は §8 の裁定後に 1 commit で行う。** 裁定前に repo へ入るのはこの .md と計画書の訂正だけ。

## 1. 照合で確定した硬い事実（2026-09-16 13:40〜13:50 実測、レビューで独立再計算済み）

| # | 対象 | 照合方法 | 結果 |
|---|---|---|---|
| F1 | `test/fixtures/18_00_01_260830_VPWW55_fukui_downgrade.xml`（14,429 B、sha256 `0af49a7b…2af8`） | 本文取得した福井 8/30 11:40 報（data.api id `ccd3ec41…77c9`、受領 14,429 B）と sha256 比較 | **バイト一致**。既存 fixture が配信原本と同一 |
| F2 | `77_01_01_240613_VXSE45.xml`（1,884 B）／`77_01_26_240613_VXSE45.xml`（22,002 B）／`36_01_10_240613_VXSE44.xml`（11,670 B） | Archive `eew.forecast` 2024-04-17（archiveId `WU3Ipn1_…AItMQ`、tar.gz sha256 `1d317cbf…b547`）の同 EventID・同 Serial の XML と比較 | **不一致だが、正規化を当てると全 bytes 一致**。正規化は ① `<Text/>` → `<Text></Text>`（Headline/Text が空の報だけ。serial 1 と VXSE44 serial 10 に各 1 か所、**serial 26 は Headline が非空なので 0 か所**）② `jmx_eb:Coordinate` の `datum="日本測地系"` 属性を除去 ③ 末尾改行 1 byte を除去。親 XML の sha256: serial 1 `f8cfb9ab…e7f9`（1,903 B）、serial 26 `192ce8f6…d291`（22,027 B）、VXSE44 serial 10 `f1485eb2…60df`（11,689 B） |
| F3 | `77_01_33_240613_VXSE45.xml`（1,043 B、InfoType=取消・Serial 32・23:17:00） | 同 Archive の VXSE45 全 33 報を走査、serial 32 発表（sha256 `29acc684…b434`、20,948 B）からの復元を試行 | **取消報は archive に存在しない**（archive 全体の VXSE45 66 報も取消 0）。serial 32 発表に次の 7 点（changes 配列 7 要素。ReportDateTime と TargetDateTime は別要素）を当てると全 bytes 一致: Control/DateTime `14:16:58Z`→`14:17:00Z`、Head/ReportDateTime `23:16:58`→`23:17:00`、Head/TargetDateTime 同、InfoType 発表→取消、**Headline 全体を `<Headline><Text></Text></Headline>` に置換**、Body を `<Text>先ほどの、緊急地震速報（地震動予報）を取り消します。</Text>` に置換、末尾改行除去。これは「復元手順が一意に定まる親候補」であり、過去にこの親から作られたという履歴証明ではない |
| F4 | `37_01_01/02/03_240613_VXSE43.xml` | Archive `eew.warning` 2024-04-17 は 402 `Not contract.`（`probe-20260916.json`） | 照合不能。**unconfirmed のまま** |
| F5 | 取得 VFVO52 `20260807015800_506` 発表（01:58、2,630 B、sha256 `2a33394c…7acd`）と訂正（02:07、2,658 B、`324a3b07…880e`） | tag 分割 diff | 差分は Control/DateTime（16:58:56Z→17:07:34Z）・Head/ReportDateTime（01:58→02:07）・**Head/InfoType（発表→訂正）**・`PlumeDirection` の値と `description` 属性（東→西）・Body 末尾 `<Text>流向を訂正</Text>` の 5 点。**EventID・Serial（1）・TargetDateTime は同一**。訂正は同 Serial・新 ReportDateTime で、`sequences.json` が「同一 revision 訂正」と呼ぶ「直前報と同じ報番号・ReportDateTime」の形ではない（O01:11・18・30 の `input.required`） |
| F6 | 取得 VPWW55 福井 15:03（14,594 B、`c794ab26…7712`）・20:04（11,562 B、`ba204403…da0e`） | 本文の `<Code>00</Code>` 計数と `Headline` | 15:03 は code00 が 0（警報→注意報の降格）、20:04 は **code00 ×16・Headline は全区域「解除」**。官署は福井地方気象台、EventID 空。11:40 の有効な大雨現象は 20:04 で全て解除される（区域集合の照合済み） |
| F7 | 上記 5 本の取得 XML | 旧築パーサ（`parseVolcanoTelegram`／`parseWeatherWarning`、`createMockWsDataMessageFromXml` 経由）で parse | 5 本とも non-null。VFVO52 は kind=eruption、infoType 発表／訂正を保持。repo 内にテストは置かず scratchpad から `vitest run --dir` で実行（レビューでは未再確認） |

出典ファイル: `~/dev/fleq-corpus-p0/index.json`（10 行）、`~/dev/fleq-corpus-p0/20260916-archive/adopted-xml-eew.forecast-2024-04-17.json`（採用 XML 段 4 行、`telegrams.json` の該当行をそのまま同梱）。

## 2. 処置の一覧（fixture 追加 3 本・既存行の来歴確定 5 本・据え置き 3 本）

**来歴（sourceStrength／modification）の確定と、公開可否（distribution）の裁定は別の欄で、別に進める。** 既存 5 本は来歴だけ確定し、distribution は §8 P-3 の裁定値を入れる（裁定が無い欄は `unconfirmed` のまま）。新規 3 本は distribution の裁定が `publicApproved` の時だけ配置する。

| 群 | fixture | 処置 | sourceStrength → | modification | 系列への影響 |
|---|---|---|---|---|---|
| ② 福井 | `18_00_01_260830_VPWW55_fukui_downgrade.xml`（既存） | **来歴確定（ファイル不変）**。F1 の一致で原本確認 | unconfirmed → **confirmedOriginal** | byteIdentical、parentSha256 null | O03:12 の fixtureId 不変。step の expectationBasis と expectation の basisRefs を同時に「原本確認済み」文言へ（`check-sequences.mjs:91` が完全一致を要求） |
| ② 福井 | **新規** `18_00_01_260830_VPWW55_fukui_release.xml`（20:04 code00 ×16） | **追加・採用**。O03:14（unmet）の錨 | confirmedOriginal | byteIdentical | O03:14 を `expected:O03:14` に昇格。§4 |
| ② 福井 | 取得 15:03 報（警報→注意報） | **段階 1 に留める**（§8 P-2 が B なら新 step として挿入） | — | — | 注意報への降格そのものの検証は省略される |
| ① 桜島 | **新規** `43_04_01_260807_VFVO52.xml`（発表）・`43_04_02_260807_VFVO52.xml`（訂正） | **追加・採用**。O01 末尾に新ケース 5 step | confirmedOriginal ×2 | byteIdentical | §3。unmet は減らない（F5: 同時刻訂正ではない） |
| ③ EEW | `77_01_01_240613_VXSE45.xml`・`36_01_10_240613_VXSE44.xml`（既存） | **来歴確定（ファイル不変）**。F2 の正規化 3 点を `changes` に記録 | unconfirmed → **confirmedDerived** | edited、parentFixtureId null、parentSha256 = archive XML の sha256、changes 3 件 | O01:9・14、O09:12 の fixtureId 不変 |
| ③ EEW | `77_01_26_240613_VXSE45.xml`（既存） | 同上。**changes は 2 件**（datum・末尾改行） | unconfirmed → **confirmedDerived** | edited、changes 2 件 | O01:10 不変 |
| ③ EEW | `77_01_33_240613_VXSE45.xml`（既存） | **来歴確定（ファイル不変）**。F3 | unconfirmed → **synthetic** | synthetic、parentSha256 = serial 32 発表の sha256、changes 7 件 | O01:12・13 の fixtureId 不変。「原本の取消」ではないことが台帳に載る |
| ③ EEW | `37_01_01/02/03_240613_VXSE43.xml` | 据え置き（F4） | unconfirmed | — | — |
| ③ EEW | archive の VXSE44/45 各 33 報 | 段階 1 に留める。O01/O09 の発表系列を原本 33 報に張り替えるのは別 spec（step 数が変わる） | — | — | — |

fixture 件数: 257（XML 236・JSON 21）→ **260（XML 239・JSON 21）**。P-2 が B なら 261／240。

`transport.evidence` は来歴確定した行で次に統一する: 「head.type と classification は配信 item の metadata（Archive は `telegrams.json`）、Control.Status は本文。head.test は item の `head.test=false`。replay を operation=test とは扱わない」。77_01_33 だけは「合成元（serial 32 発表）の archive metadata を継承。取消報としての配信 metadata は存在しない」と書く。既存の「ファイル名から補完」文言は残さない（原本照合済みの行では虚偽になる）。

## 3. O01 新ケース（桜島 VFVO52、step 56〜60）

既存 55 step の後ろに追加する。位置の付け替えはない（`check-sequences.mjs:39` の `position = index+1` を満たす）。合成時計は `restart` を ReportDateTime ちょうど、初回受信を +1 ms とする既存規約（O01:15〜16 と同形）に倣う。

| position | action | fixtureId | receivedAt / evaluatedAt | decision | effective | subjects[0].revision | checks（要旨） |
|---|---|---|---|---|---|---|---|
| 56 | restart | null | null / **1786035480000**（=2026-08-07T01:58:00+09:00） | null | null | — | 隔離 harness を空 state で起動: 桜島 VFVO52 同 Serial 訂正 |
| 57 | receive | `test__fixtures__43_04_01_260807_VFVO52` | 1786035480001 | changed/semantic | active | `normal/volcano:eruption/20260807015800_506` @ 01:58:00+09:00 / `1` / 発表 | eruption 桜島 506、code52、流向 東。EventID→火山 identity 保持 |
| 58 | receive | `test__fixtures__43_04_02_260807_VFVO52` | **1786036020000**（=02:07:00+09:00） | changed/semantic | active | 同 subject @ 02:07:00+09:00 / `1` / 訂正 | **同 Serial・新 ReportDateTime の訂正を stale と誤判定しない**。流向 東→西・`<Text>流向を訂正</Text>` は表示差分あり。通知有無は Q-NOTICE |
| 59 | receive | `test__fixtures__43_04_02_260807_VFVO52` | 1786036020001 | unchanged/duplicate | active | 同上 | 訂正重複で追加通知 0、revision 不変 |
| 60 | receive | `test__fixtures__43_04_01_260807_VFVO52` | 1786036020002 | unchanged/stale | active | @ 01:58:00 / `1` / 発表 | 遅着した発表報で流向 東 を復活させない。訂正済み current 維持 |

- `operationExpected` は 4 receive とも `normal`（本文 Control.Status=通常、`check-sequences.mjs:59-62` の照合を通る）。`inputSource` は `replay`。
- `expectationBasis`: `L1: docs/specs/reconstruction-p0-contracts.md:1777 O01` と `L2: test/fixtures/43_04_0N_260807_VFVO52.xml:1 原本確認済み（dmdata Telegram List item id と受領 hash 一致、manifest 参照）`。restart は既存と同じ `:1758` と `:736`。
- 取消・同時刻訂正はこの事例に無い。O01:18・30（同時刻訂正 synthetic）と O01:29・31・32（VFVO50 続報・取消・重複）は **unmet のまま**。README の unmet 表は O01=14 のまま、O03=4→3、計 138→137。
- 既存 O01:26〜28（2020-05-22 VFVO52、EventID 不一致の訂正・取消）は触らない。新ケースはその補完で、置換ではない。

## 4. O03:14 の充足（福井 20:04 code00）

- `fixtureId`: null → `test__fixtures__18_00_01_260830_VPWW55_fukui_release`。`expectedRef`: `unmet:O03:14` → `expected:O03:14`。expectation の `expectedId` も同じ値へ（`check-sequences.mjs:130-138`）。
- `receivedAt`／`evaluatedAt`: 1788057660000（11:41 の合成値）→ **1788087840000**（=2026-08-30T20:04:00+09:00。`:64` の「受信は報告日時より前にできない」を守る）。O03:15 は restart なので時計は自由に戻る。
- `subjects[0]`: `normal/VPWW55/福井地方気象台` @ `2026-08-30T20:04:00+09:00` / null / 発表。
- `decision`: changed/semantic、`effective`: inactive／cause released（現行値を維持）。`notices`／`intents` は null のまま（Q-NOTICE）。
- `input`: null（充足したので `unmet` 契約の `input.required` は消す。`:134` は unmet 側の検査）。
- `checks`: 「福井 VPWW55 の所有現象だけ終了。別官署／別 type の現象（O03:7 の VPWS50 base・O03:9 の VPWW57 京都、いずれも synthetic 未充足）を消さない。code00 ×16 の全区域解除で福井の current は空、base の再露出なし」。
- `expectationBasis`: L1 `:1779 O03` と L2 `test/fixtures/18_00_01_260830_VPWW55_fukui_release.xml:1 原本確認済み（…）`。step と expectation の両方に同じ配列を置く。
- 11:40 → 20:04 の間の実報（15:03 注意報降格）を省く影響: 20:04 時点の福井 current が実運用では「注意報」だが系列では「危険警報（11:40）」から直接解除になる。code00 の意味（所有現象の終了）は同じで、O03 の受入条件（所有交差・base 非再露出）に差はない。**注意報への降格そのものの検証は省略される**。降格後の古報非復活は既に O03:13 が扱っている（O06 は履歴 2／8 境界・連続取消の系列で、降格→古報再投入の step は無い。必要なら別途 step を指定する）。

## 5. manifest 行の書き方（行ごと）

共通: `documentTimes` は本文の ReportDateTime／TargetDateTime を raw で。`distribution` は §8 P-3 の裁定値（裁定が無い行は `unconfirmed`）。`acquisition.evidenceRefs` の末尾に「distribution=<値>: <日付> ご主人裁定、根拠 <一文>」（unconfirmed なら「distribution=unconfirmed: <未確認の理由>」）を文字列で残す（型は変えない）。**外部親の sha256（64 桁）は evidenceRefs の文字列自体に完全形で書く**（`check-manifest.mjs:111` は参照先ファイルを辿らない）。

| fixtureId | acquisition | modification | evidenceRefs（要旨。実際の文字列には 64 桁 hash を含める） |
|---|---|---|---|
| `18_00_01_260830_VPWW55_fukui_downgrade`（既存） | kind `dmdataCaptured`、locator `https://data.api.dmdata.jp/v1/ccd3ec41…77c9`、acquiredAt `2026-09-16T03:34:08.550Z` | byteIdentical、parent null | `~/dev/fleq-corpus-p0/index.json` 行 3（id と受領 sha256 `0af49a7b…2af8`・14,429 B が checkout bytes と一致）；`.item.json`（datetime-VPWW55-20260830 の item）；distribution 行 |
| `18_00_01_260830_VPWW55_fukui_release`（新） | 同、locator `…/04a50f9f…5152`、acquiredAt `2026-09-16T03:41:45.984Z` | byteIdentical | index 行 10；受領 sha256 `ba204403…da0e`・11,562 B |
| `43_04_01_260807_VFVO52`（新） | 同、locator `…/0872b87e…62f1`、acquiredAt `2026-09-16T03:33:48.031Z` | byteIdentical | index 行 1；`list-VFVO52-page1.json`；受領 sha256 `2a33394c…7acd`・2,630 B |
| `43_04_02_260807_VFVO52`（新） | 同、locator `…/c263a221…bc3c`、acquiredAt `2026-09-16T03:33:58.381Z` | byteIdentical | index 行 2；受領 sha256 `324a3b07…880e`・2,658 B |
| `77_01_01_240613_VXSE45`（既存） | kind `dmdataCaptured`、locator `dmdata:archive:WU3Ipn1_…AItMQ#VXSE45_RJTD_20240417141457799_6283fa8.xml`、**acquiredAt null**（この fixture 自体の持込時刻は不明。合成しない） | edited、parentFixtureId null、parentSha256 `f8cfb9ab…e7f9`、changes: `{field:"/Report/Head/Headline/Text", from:"<Text/>", to:"<Text></Text>"}`、`{field:"/Report/Body/Earthquake/Hypocenter/Area/jmx_eb:Coordinate@datum", from:"日本測地系", to:null}`、`{field:"trailing newline", from:"\\n", to:null}` | adopted 行 1（親 sha256 の完全形、archive tar.gz sha256 `1d317cbf…b547`）；「正規化を当てた親と全 bytes 一致、2026-09-16 照合。持込経路の履歴は未確認」 |
| `77_01_26_240613_VXSE45`（既存） | 同、`#VXSE45_RJTD_20240417141538365_bd658f3.xml`、acquiredAt null | edited、parentSha256 `192ce8f6…d291`、**changes 2 件**（datum・trailing newline。Headline/Text は非空で変更なし） | adopted 行 2 |
| `36_01_10_240613_VXSE44`（既存） | 同、`#VXSE44_RJTD_20240417141503829_f668d1f.xml`、acquiredAt null | edited、parentSha256 `f1485eb2…60df`、changes 3 件 | adopted 行 3 |
| `77_01_33_240613_VXSE45`（既存） | kind `generated`、locator `dmdata:archive:WU3Ipn1_…AItMQ#VXSE45_RJTD_20240417141658099_712d751.xml`（復元手順が一意に定まる親候補）、acquiredAt null | **synthetic**、parentSha256 `29acc684…b434`、changes 7 件: Control/DateTime `2024-04-17T14:16:58Z`→`14:17:00Z`、Head/ReportDateTime `23:16:58`→`23:17:00`、Head/TargetDateTime 同、Head/InfoType `発表`→`取消`、`/Report/Head/Headline` 全体→`<Headline><Text></Text></Headline>`、`/Report/Body`→`<Text>先ほどの、…取り消します。</Text>`、trailing newline 除去 | adopted 行 4（親 sha256 の完全形）；「同 EventID の取消報は archive 33 報に存在しない（2026-09-16 走査）。上の 7 点で親から全 bytes を復元できるが、過去にそう作られたという履歴証明ではない」 |

sourceStrength: confirmedOriginal 4（うち既存 1）、confirmedDerived 3、synthetic 1。

## 6. 同時更新（1 commit）

1. fixture 3 本を `test/fixtures/` に受領 bytes のまま配置（`json-converted/` は置かない）
2. `manifest.json`: §5 の **3 行を追加・既存 5 行を更新**、`meta.sha256` を再固定
3. `check-manifest.mjs`: `:21-23` を 260／239／21、`:50`・`:85` を 260、`:137` の PASS 文字列を `(239 XML + 21 JSON)` に
4. `sequences.json`: §3 の 5 step＋5 expectation を O01 に追加、§4 で O03:14 を書き換え、O03:12 の L2 文言を step と expectation の両方で更新。`meta.manifestSha256` と自己 hash を再固定。`unmet` 総数は 138→**137**
5. `p1-parser-boundary.json`: `fixtureIds` に 3 件追加（`check-contract.mjs:100` は全件一致を要求）。**契約本文の件数も更新する**: `:84` objective の「全257 fixture」→260、`:483` P1-AC01 と `:500` P1-T01 の「236件／236 XML」→239、`:507` P0-CHECK-CONTRACT の behavior「全257 fixture」→260、`:511` の「257 fixture台帳」→260、`:542`・`:549` requiredEvidence の「全236 XML」→239。`meta.manifestSha256`・`meta.sequencesSha256`・自己 hash を再固定。`contract.baseOid` は触らない（`unassigned` のまま。発注時に統合担当が設定）。`expectedDecisions`／`expectationEvidence` に O03 は無いので O03:14 の昇格で参照更新は不要
6. `README.md`: `:3`・`:5`・`:44` の件数（257→260、XML 236→239）、`:5` の強度別（原本 9→13・派生 3→6・合成 64→65・未確認 181→176。XML 内訳は原本 9→13・派生 2→5・合成 55→56・未確認 170→165）、**distribution 集計**（全件 unconfirmed → publicApproved n／unconfirmed 260−n、n は P-3 の裁定で決まる）、**modification 集計**（byteIdentical 9→13・edited 4→7・synthetic 64→65・unknown 180→175）、unmet 表（O03=4→3、計 137）、O01／O03 行の「未作成」記述。不足「訂正」「解除」の行に「原本 1 例あり」を追記。`:66`・`:70` の Q-LIMIT／Q-OP 計測値は 2026-09-16 の 236 本走査の記録なので書き換えない（再計測時に更新）
7. `rest-acquisition-plan.md:42` の「差分は Control/DateTime と末尾 `<Text>流向を訂正</Text>` のみ」を F5 の 5 点に訂正（本 spec と同じ commit。裁定前でも .md なので先に直してよい）
8. `node reconstruction/tools/corpus/check-manifest.mjs`・`check-sequences.mjs`・`node reconstruction/contracts/check-contract.mjs` の 3 本 PASS を確認
9. `npm run build && npm test`: 旧テストに fixture 総件数を固定するものは無く、走査型（`test/dmdata/weather-warning-fixture-coverage.test.ts:9`）は `15_*_VPWW*.xml` だけを拾うので今回の 3 本は対象外。それでも実行して緑を確認する

hash の再固定順は manifest → sequences → contract（後段が前段の `meta.sha256` を参照するため）。機械作業は scratchpad の `promote.mjs`（鏡像ディレクトリで dry-run 済み、3 checker PASS）で行い、README と計画書の訂正は手で入れる。**dry-run の manifest には仮の裁定日 `2026-09-17` と仮の根拠文が入っている**。実反映では P-3 の実際の裁定日と根拠文を引数で与えて再生成する（checker は裁定の実在を検査しない）。

## 7. 公開先の分岐

- 新規 3 本は **「3 本とも `publicApproved` で main に配置」か「昇格を見送り段階 1 に留める」の二択**にする。`privateOnly` で personal にだけ置く運用は今回作らない。理由: fixture を personal にだけ置くと manifest・sequences・contract・README の内容と参照 hash が main と personal で全て分岐し、以後の main 追従 rebase のたびに 4 ファイルの衝突を手で解く。定数 4 か所の衝突に収まらない（`check-sequences.mjs:17`・`check-contract.mjs:43`・`:100`）
- 既存 5 本の来歴確定（sourceStrength／modification）は distribution の裁定と独立に main で行う。distribution が `unconfirmed` のままでも来歴欄は更新できる（欄が別）。ファイルは既に main にあり、配置の判断は既に済んでいる
- publicApproved の commit は main で 1 commit → origin push → CI（fixture・JSON は `paths-ignore` 対象外なので Test が走る）→ personal を rebase → private push。Pi 反映は不要（fixture と契約 JSON は実行時に読まれない）

## 8. 裁定点（推奨を先頭に）

- **P-1 桜島 VFVO52 の扱い**
  - **A（推奨）**: O01 末尾に新ケース 5 step として採用（§3）。理由: 「同 Serial・新 ReportDateTime の訂正は stale ではない」は revision 比較の実装が最初に踏む段差で、synthetic では作者の思い込みが入る。原本 2 本で固定できる
  - B: 昇格せず段階 1 に留める（同時刻訂正の unmet を埋めないため）
- **P-2 福井 15:03 報の扱い**
  - **A（推奨）**: 20:04 だけを O03:14 に採用し、15:03 は段階 1 に留める（§4）。理由: O03 の受入条件（所有交差・base 非再露出）に 15:03 は効かず、挿入すると O03:15〜24 の 10 step と expectation ID を付け替える。注意報降格の検証は省略になる
  - B: 15:03 を新 step 14（警報→注意報、changed/semantic・active）として挿入し、20:04 を step 15 に。O03:16〜25 へ付け替え
- **P-3 distribution（1 件ずつ、D-2 A）**。「既に main にある」は根拠にならない（README `:5` は既存 257 本を全件未確認と明記）。規約の当たり: dmdata サービス利用規約 **14 項 1 号**は特則のない気象庁情報について無加工電文を含む二次利用を認める。**15 項**は法人契約とそれ以外を分け、EEW の公開 API 利用・第三者への表示や鳴動を個別に扱う。開発 fixture の一般的な除外は規約に無い（2026-09-16 ヘルツ確認、https://dmdata.jp/terms/ ）
  - **A（推奨）**: 気象・火山の 4 本（新規 `43_04_01`・`43_04_02`・`fukui_release` と既存 `fukui_downgrade`）は **14 項 1 号を根拠に `publicApproved`**（ご主人が条文を読んで同意した日付を根拠に書く）。EEW の既存 4 本（`77_01_01`・`77_01_26`・`36_01_10`・`77_01_33`）は来歴だけ確定し、**distribution は `unconfirmed` のまま**（15 項の契約区分・既存許可の範囲・過去電文と派生電文の公開 repo 同梱の扱いを確認してから別途裁定）。理由: 規約の条文が違う 2 群を同じ裁定で束ねない。EEW 4 本はファイルも系列も変わらないので、distribution を後回しにしても昇格 commit は成立する
  - B: 15 項の適用・契約区分・既存許可の範囲を確認できた場合に、EEW 4 本も含めて 8 本とも `publicApproved`（確認した条項と日付を根拠に書く。確認を省いて B にはしない）
  - C: 新規 3 本の昇格を見送り、来歴確定 5 本だけを commit（distribution 全て `unconfirmed`）
- **P-4 原本確認のための追加本文取得（3 req、data.api 10 秒間隔）**
  - **A（推奨）**: `18_00_01_260830_VPWW55_fukui_L5.xml`（06:51、O03:8・13 の錨）と VPTA50 `76_01_02`（serial 41）・`76_01_03`（serial 87）の配信 item を本文取得し hash 照合。一致すれば**次の commit**で confirmedOriginal に（ファイル不変・総件数不変。既存 3 行更新・原本 16／未確認 173・byteIdentical 16／unknown 172 になり、README 集計と 3 JSON の hash を再固定する）。本 spec の昇格 commit には含めない。理由: 一覧に item があり（`datetime-VPWW55-20260830.json`・`list-VPTA50-page3.json`）、1 件 1 req で 3 本の原本確認が取れる
  - B: 今回は見送り

## 9. 非対象

- 同時刻訂正・取消・重複・遅着の synthetic 設計（O01:11・18・29〜32、O03:7・9）。P1 以降の synthetic 契約
- archive の EEW 33 報を O01:8〜14・O09:12 の発表系列に張り替える作業（step 数が変わるので別 spec）
- VXSE43（eew.warning）の原本照合（契約外）
- 2021-05-14 volcano archive（VFVO55 0 通）と 2024-04-18 eew.forecast の再利用（今回の対象なし）
- `check-manifest.mjs` の固定値を動的化する改修（バックログ「行番号根拠を文字列アンカーへ」と同じ層。本 spec は定数の書き換えで通す）
- 注意報降格→古報再投入の系列（O03:13 の範囲外。必要なら別途 step を指定）
