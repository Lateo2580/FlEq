# P0 完了資材 ④ corpus 不足系列の REST 取得計画

起草: 2026-09-16（ヘルツ Astra high 独立レビュー 3 巡、条件付き GO の条件反映済み）。対象は `README.md` 末尾の不足 8 種（正常・訂正・取消・解除・empty・unknown・不正・上限境界）と、`sequences.json` で `input.acquisition` に「REST見込み」を記した未充足 19 件。**この文書は計画であり、取得の実行・fixture 追加・manifest 更新は作者裁定の後に行う。** 取得しても synthetic の代替ではなく、原本確認済み fixture として系列の錨を増やすのが目的。

## 1. 前提の硬い事実

| 事実 | 出典 |
|---|---|
| 一覧は `GET https://api.dmdata.jp/v2/telegram`（Telegram List v2）。パラメータ: `type`（前方一致、またはカンマ区切り最大 5 つ）、`classification`、`xmlReport`（**既定 false**。true で `xmlReport.control/head` が item に載る）、`test`（既定 `no`、`including`／`only`）、`formatMode`（既定 raw）、`datetime`（**【実験】** `開始~終了` 形式の受信日時絞り込み）、`cursorToken`、`limit`（既定 20、最大 100） | dmdata docs `telegram.list/`（2026-09-16 取得） |
| 本文は一覧の `body` に入らず、各 item の `url`（`https://data.api.dmdata.jp/v1/<id>`）を GET する | Vault `Knowledge/Dev/2026-08-24-dmdata-rest電文採取の実際` |
| 提供期間は 2025-07-01 以降「直近約 180 日分」（2026-09-16 起点で **2026-03-20** より前は Telegram List では取れない）。**EEW 関連電文は Telegram List に表示されない** | 同 docs |
| 2026-08-23 の採取では、`type` フィルタ併用時に `nextToken` が前進せず（2 ページ目以降が同一スパンを反復）、実効的に「型別 1 ページ（100 件）」しか遡れなかった。**2026-09-16 の probe で再現せず**: VXSE53 で同一パラメータ＋`cursorToken` の 2 ページ目は前進した（重複 0、2026-08-19〜08-30）。`datetime` 絞り込みも効いた（VPWP50 2026-06-05 で 100 件、VPWW55 2026-08-30 で 61 件） | Vault 同上、`~/dev/fleq-corpus-p0/probe-20260916.json` |
| 地震イベントは `GET /v2/gd/earthquake?limit=100` の `cursorToken` が前進し、`/v2/gd/earthquake/<eventId>` の詳細で当該電文一覧が取れる。各電文の **`originalId`** を `data.api.dmdata.jp/v1/<originalId>` に渡すと raw XML（`id` と `url` は JSON 変換版） | 同 Vault、熊本 7/28 の 8 通採取実績 |
| Archive List v2（`GET /v2/archive`、`archive.list` 権限、**契約中の配信区分のみ**）は配信区分ごとの日別 `.tar.gz` の一覧。応答は `id／classification／date／dataCount／fileSize／url`、`datetime` で日付範囲指定。本体は Archive Data v1（`GET https://data.api.dmdata.jp/v1/archive/:id`、**別権限 `archive.data`**）で、解凍後の `telegrams.json` を参照して個別電文を辿る。同じ id への短期間の反復要求は禁止。**保存開始**: 地震津波・火山・気象警報・定時報は **2020-11-18 12 時**、EEW（予報・警報）は **2022-07-20 15 時**。FlEq 契約での両権限の有無は**未確認** | dmdata docs `archive.list/`・`v1/archive.data/`（2026-09-16 取得） |
| レート制限（公式）: ドメイン×IP ごとに 10 分 2000 req。**`data.api.dmdata.jp/v1/:id` と `/v1/archive/:id` は 5 分 50 req**。429 は指数バックオフ、`Retry-After` があれば尊重 | dmdata docs `reference/api/v2`、`src/dmdata/rest-client.ts:140` |
| 作者の低負荷要望: リクエスト間 1 秒、保存上限 40 件／回、窓は必要最小限、保存済みは再取得しない | Vault 同上（2026-08-23） |
| 既存スクリプト `~/dev/fleq-corpus-6b-latter/dmdata-window-capture.js`（依存なし Node、`--type --from --to --out`、span 反復検出・`MAX_SAVED`・既存 skip）。`xmlReport`・`datetime` は未対応 | 同ディレクトリ |
| manifest 記録欄: `acquisition.kind="dmdataCaptured"`＋`locator`＋`acquiredAt`＋`evidenceRefs`、`sourceStrength="confirmedOriginal"` は原本 hash 照合が要る、`distribution` は `publicApproved / privateOnly / unconfirmed` で**確認状態を必ず記録する** | spec §9.5 必須規則 |
| 既存 257 件は `distribution` が全件 `unconfirmed`。checker は列挙値を検査するだけで公開を防がない | `README.md`、`check-manifest.mjs` |
| 昇格は checker 3 本の同時更新を要する: `check-manifest.mjs` は 257／XML 236／JSON 21 を定数で固定（`:21-23` のファイル数、`:50` の manifest 件数、`:85` の fixtureId 一意数）、`check-sequences.mjs:17` は `meta.manifestSha256` を manifest の自己 hash と照合、`check-contract.mjs:43-44` は manifest と sequences 両方の自己 hash を照合し、`:100` で全 fixtureId の一致を要求 | 各 checker |

## 2. 不足 8 種 × 取得可否

| 種 | REST で埋まる可能性があるもの | REST では埋まらないもの（synthetic 確定） |
|---|---|---|
| 正常 | 21 route それぞれの発表報の原本（窓内で発表があった型に限る）。ignore 候補（VPWW53/54 等）の実物。**今回の初回 probe（§7）の対象外で、別段階として扱う** | 窓内に発表がない型（VTSE41/51/52、VYSE 系、噴火警報など事象依存） |
| 訂正 | 窓内に `InfoType=訂正` が発表された事例（地震は GD 経路、他は Telegram List、窓外は Archive） | 同 revision 訂正が見つからない family |
| 取消 | 同 EventID の取消発表事例（VXSE51/52/53、VFVO52/56 等） | 遅着順序・重複（replay 操作で作る） |
| 解除 | VTSE41 解除・VPNO50 区域解除・VXKO50 解除・VPTA50 消滅の前後報 | 制御した遅着 |
| empty | 有効発表として空になる VPWP50・VPTA50 の gate-only 報（**本文確認が要る**） | 欠落・空の意図的組合せ |
| unknown | VXKO50 水位不明、VXSE 系「未入電」を含む実報（**本文確認が要る**） | 未観測形・矛盾入力 |
| 不正 | **なし**（合法原本としては取れない） | 壊れた XML・encode・必須欄欠落は全て synthetic |
| 上限境界 | VPWP50/VPTA50 の大規模正常報（参考負荷のみ） | bytes/node/depth/属性/text の閾値直前・一致・+1 |

## 3. ② の「REST 見込み」19 件と取得経路の照合

錨の EventID／ReportDateTime を Telegram List の 180 日窓（2026-03-20 以降）と照合した。**「窓外」は「同 EventID を Telegram List で取れない」の意味で、取得不能ではない**（Archive で届く可能性が残る）。「見込み」列は 2026-09-16 の probe（19 req＋生 item 保存 4 req、本文なし）の実測で置き換えた。分類は 候補あり／探索範囲内に見つからず／本文確認待ち／取得失敗。

| 系列 | step | 対象 | 錨の日時 | List 窓 | 取れる経路 | 見込み |
|---|---|---|---|---|---|---|
| O01 | 4, 11 | VXSE43/45 同 revision 訂正 | 2024-04-17 | 外 | **D（Archive）のみ**（EEW 保存開始 2022-07-20 以降）。EEW は Telegram List に出ないので経路 A の別事例張り替えも不可 | VXSE43: **取得失敗**（`eew.warning` の archive 一覧が 402 `Not contract.`）→ synthetic。VXSE45: **候補あり**（`eew.forecast` 2024-04-18 の archive、dataCount 72・fileSize 15,505。`archive.data` 権限は本文取得で確認） |
| O01 | 29–32 | VFVO50 火山 306 続報・訂正・取消・重複 | 2020-05-22 | 外 | **Archive 保存開始（2020-11-18）より前**。通常の探索対象から外す。別事例は A（噴火警報の取消は稀事象） | 別事例: VFVO50 直近 18 件（2026-04-28〜09-12）は全て発表・訂正なし → **探索範囲内に見つからず**。ただし **VFVO52 に同 EventID `20260807015800_506` の 発表 01:58→訂正 02:07（serial 1 同士）の実連鎖あり（候補あり、本文確認待ち 2 件）**。噴火 slice の錨として張り替え候補 |
| O01 | 37–39 | VFVO55 火山 506 訂正・取消・重複 | 2021-05-14 | 外 | D（Archive、保存開始後）。別事例は A | **候補あり**（`telegram.volcano` 2021-05-15 の archive、dataCount 106・fileSize 500,185）。直近 VFVO55 24 件は全て発表 |
| O01 | 52–54 | VXSE53 熊本 20260728162718 訂正・取消・重複 | 2026-07-28 | **内** | B（GD 詳細 1 req） | **探索範囲内に見つからず**: GD 詳細の電文 8 通（VXSE51×4・VXSE53×2・VXSE61・VXSE62）は全て発表。同 EventID の訂正・取消は synthetic。直近 VXSE51/52/53 各 100 件も全て発表 |
| O02 | 3 | VPWP50 稚内 合法 empty | 2026-06-05 | 内 | A（`datetime` 指定を試す） | **本文確認待ち 1 件**: `datetime` で 6/5 に到達（100 件、nextToken あり）。稚内の 18:01 JST 報は無く、**23:00 JST 報**（id `06864b91…`）がある。empty かは本文で確定 |
| O02 | 21–22 | VPTA50 TC2606 全ゼロ後続報・gate-only | 2026-06-02 | 内 | A | 1 ページは 2026-08-05〜09-16（100 件、nextToken あり）。6/2 は 2 ページ目以降。**候補あり（未到達、cursor で遡れる見込み）** |
| O02 | 25 | VXKO50 全水位 unknown | 2019-05-27（合成 EventID） | 外 | A で別事例（洪水予報は事象依存） | 1 ページは 2026-05-20〜09-09（100 件、通常 53・訓練 47）。全水位 unknown かは本文でしか分からず **本文確認待ち（件数未定）**。錨は張り替え前提 |
| O03 | 14 | VPWW55 福井 code00 | 2026-08-30 | 内 | A（`datetime` 指定を試す） | **本文確認待ち 1 件**: `datetime` で 8/30 に到達（61 件）。福井地方気象台の **11:40 JST 報**（id `ccd3ec41…`）が錨に一致（同日 10 報あり、連鎖材料）。code00 かは本文で確定 |
| O09 | 17–18 | VTSE41 20110311 解除・降格 | 2011-03-11 | 外 | **Archive 保存開始より前**。通常の探索対象から外す。別事例は C（待ち伏せ）＋D（取り逃し回収） | 直近 VTSE41 17 件（2026-03-26〜07-28、通常 13・訓練 4）は全て発表。解除・降格の実例は **探索範囲内に見つからず** → 待ち伏せ C か synthetic |

## 4. 取得経路

| 経路 | 使う場面 | 要求数の目安 |
|---|---|---|
| A. Telegram List 型別窓 | 窓内の事例。まず `type`＋`xmlReport=true`＋`limit=100` の 1 ページ、届かなければ `datetime` 指定と `cursorToken` 引継ぎを試す | 一覧 1〜数 req／型、本文は選んだ件数だけ |
| B. GD earthquake | VXSE51/52/53/61/62 の訂正・取消（イベント単位で遡れる） | 一覧は探索上限 20 req（到達実績は probe で記録）、詳細は候補イベントだけ、本文は `originalId` 経由 |
| C. 待ち伏せ（発生後の手動採取） | 稀事象: 津波注意報以上の解除・降格、噴火警報の取消、洪水予報 | 事象後に経路 A で 1 ページ。取り逃したら翌日以降に経路 D |
| D. Archive | 保存開始後の窓外錨（EEW 2024-04-17、VFVO55 2021-05-14）と、C の取り逃し回収。VFVO50 2020-05 と VTSE41 2011 は保存開始前で対象外 | 採用候補ごとに `GET /v2/archive?classification=<区分>&datetime=<日>~<翌日>` で `fileSize`・`dataCount` を見てから裁定。本体は 1 日 1 区分 1 ファイル（`archive.data` 権限） |

C は cron や常駐監視を**作らない**。自動化で変わるのは捕捉率で、手動運用は見逃しを許容する（§8 D-4）。

## 5. 負荷予算

| 項目 | 値 | 根拠 |
|---|---|---|
| `api.dmdata.jp`（一覧・GD・archive.list）の間隔 | 1 req／秒以上あける | 作者要望。公式 2000/10 分の 1/3 以下 |
| `data.api.dmdata.jp`（本文・archive 本体）の間隔 | **10 秒**あける | 公式 5 分 50 req に対し 30 req／5 分で余裕を残す |
| 本文取得の上限 | 30 件／回、60 件／日 | `MAX_SAVED` 40 より下げる。probe で件数を先に確定してから本文を取る |
| 再取得 | しない（保存済み `id` は skip） | 既存スクリプトの既存 skip を流用 |
| 429・再試行 | 待機は `max(通常間隔, Retry-After, 指数バックオフ 1s→2s→4s)`、3 回で中止。再試行も上の予算に数える | 公式の指示、`rest-client.ts:140` と同じ扱い |
| 探索上限 | GD 一覧 20 req、Telegram List は型ごとに 5 req、archive.list は 3 req | 到達実績と分けて記録する |
| 実行時間帯 | 気象警報の集中発表時（大雨・台風接近中）の回避を優先する。C の「事象後 24 時間以内」は回避と両立する場合だけ。逃した分は D で回収、取れなければ synthetic | サーバ負荷への配慮 |

## 6. 記録形式と昇格の 2 段階

**段階 1（取得）**: repo 外 `~/dev/fleq-corpus-p0/<YYYYMMDD>-<type>/` に raw 本文を**受領 bytes のまま無整形で**保存し、同じ名前の `.item.json` に一覧／GD／archive の元 item を丸ごと残す。`index.json` に 1 件 1 行で記録する。

```
{ id, originalId|null, requestUrl, headType(itemの head.type), reportDateTime, eventId|null, serial|null, infoType|null,
  controlStatus|null, sha256(受領bytes), byteLength, acquiredAt, route: "typeWindow"|"gdEarthquake"|"archive",
  probeRef, distribution: "unconfirmed", distributionNote: "<確認未了の理由>" }
```

`sha256`・`byteLength` は受領直後に計算し、`acquiredAt` は実際の取得時刻（合成しない）。`headType`・`infoType` は item の metadata から取り、XML 本文から復元して一致確認する形にはしない（旧パーサも `msg.head.type` を受け取る側なので循環する）。`distribution` は取得時点で `unconfirmed` と未確認理由を記録し、空欄にしない。

**Archive だけは記録を二段に分ける**（受領するのは `.tar.gz` で、Archive List の item に個別電文の `head.type`・`InfoType` は無い）。

```
archive 段: { archiveId, requestUrl, classification, date, sha256(受領 tar.gz), byteLength, acquiredAt }
採用 XML 段: { archiveId, pathInArchive, sha256(無改変で抽出した XML), byteLength, telegramsJsonEntry(該当行をそのまま),
             headType/infoType/eventId/serial/controlStatus は telegrams.json と本文から }
```

fixture の hash は採用 XML 段と照合し、`evidenceRefs` で archive 段へつなぐ。`transport.evidence` には「metadata は archive 内 `telegrams.json`、配信 item ではない」と書く。

**段階 2（昇格、裁定後）**: 系列の錨として採用が決まった件だけを扱う。1 件でも足すと checker 3 本の固定値と参照 hash が全て変わるので、**次を 1 commit の同時更新契約として行う**。

1. `test/fixtures/` へ配置（命名は既存に倣う。例 `32-35_01_01_260824_VXSE51.xml`。`json-converted/` は置かない）
2. `manifest.json`: 行を追加し、`acquisition.kind="dmdataCaptured"`・`locator=requestUrl`・`acquiredAt`・`evidenceRefs=[index の行, .item.json（Archive は archive 段＋採用 XML 段）, 受領 hash]`、`transport.evidence` に「head.type は配信 item の metadata（Archive は `telegrams.json`）、Control.Status は本文」と書く。`sourceStrength="confirmedOriginal"` は受領 bytes（Archive は無改変抽出後の XML）の hash と配置後 hash が一致した件だけ。`distribution` は裁定値、確認日と根拠は `acquisition.evidenceRefs` に文字列で残す（型は変えない）。`meta.sha256` を再固定
3. `check-manifest.mjs` の固定値 4 か所（`:21-23` のファイル数 257／236／21、`:50` の manifest 件数 257、`:85` の fixtureId 一意数 257）と `:137` の PASS 表示を新しい件数に更新
4. `sequences.json`: 該当 step の `fixtureId` を差し替え、`expectedRef` を `unmet:Oxx:n` から `expected:Oxx:n` へ、対応する expectation の ID も同時に変更（`check-sequences.mjs:130-138`）。新しい XML に合わせて合成時計（`receivedAt`・`evaluatedAt`）を再導出する（`:64` の「受信は報告日時より前にできない」を守る）。`meta.manifestSha256` と自己 hash を再固定
5. `p1-parser-boundary.json`: `fixtureIds` に追加、`meta.manifestSha256`・`meta.sequencesSha256`・自己 hash を再固定
6. `node check-manifest.mjs`・`check-sequences.mjs`・`check-contract.mjs` の 3 本 PASS を確認してから commit

**公開先の分岐**: main へ置けるのは `distribution="publicApproved"` の件だけ。`privateOnly` は personal ブランチにだけ置く（main には fixture も manifest 行も出さない）。`unconfirmed` のままの件は昇格しない（段階 1 に留める）。

`acquiredAt`（実取得時刻）と系列の合成 `receivedAt` は昇格後も別の値として保つ。

## 7. 手順

1. **probe（裁定後の最初の 1 回、本文なし、api.dmdata.jp のみ再試行なしで 19 req）**: 対象は §3 の 19 件だけ。正常原本（VPWW53/54 等の ignore 候補や 21 route の発表報）は別段階にする
   - 経路 B: `gd/earthquake/20260728162718` の詳細 1 req
   - 経路 A: 下の 12 型を `type=<T>&xmlReport=true&test=including&formatMode=raw&limit=100` で 1 ページずつ。first/last `head.time`（窓幅）、件数、`xmlReport.head.infoType`／`eventId`／`serial` の分布を記録
     - VXSE51 VXSE52 VXSE53 VFVO50 VFVO52 VFVO56 VFVO55 VTSE41 VPTA50 VPWP50 VPWW55 VXKO50
   - 経路 A 追試（該当型のみ）: VPWP50 と VPWW55 は錨の日を `datetime=<当日 00:00>~<翌日 00:00>` で 1 req ずつ。届いたかを記録
   - カーソル追試（VXSE53 の 1 型に限定）: 1 ページ目と同じ `type/xmlReport/test/formatMode/datetime/limit` を維持したまま `cursorToken=<前応答の nextToken>` で 2 ページ目を 1 回だけ取得し、item ID 集合と受信日時範囲が前進したか反復したかを記録する（型別 5 req の内数）
   - 経路 D（一覧のみ、本体は取らない）: `GET /v2/archive?classification=eew.warning&datetime=2024-04-17~2024-04-18`（VXSE43 用）、`GET /v2/archive?classification=eew.forecast&datetime=2024-04-17~2024-04-18`（VXSE45 用。警報区分の応答から予報区分の可否は判断しない）、`GET /v2/archive?classification=telegram.volcano&datetime=2021-05-14~2021-05-15` を 1 req ずつ、計 3 req（採用候補の日付・区分ごとに `fileSize`・`dataCount` を見る。結果・権限・本文予算は区分ごとに分けて記録）。応答が 403 でも「契約外」とは確定せず、応答理由付きの「取得失敗」として記録し、契約区分・`archive.list` 権限・`archive.data` 権限を分けて確認する（一覧が通っても本体権限は別）
   - 結果を `~/dev/fleq-corpus-p0/probe-<date>.json` に残し、各対象を **候補あり／探索範囲内に見つからず／本文確認待ち／取得失敗** の 4 分類にする
2. probe 結果を §3 の表に書き戻す。「探索範囲内に見つからず」は synthetic 候補で、「本文確認待ち」（empty・unknown・code00）は少数本文サンプルの承認を作者に求める。「取得失敗」は再試行か見送り
3. 本文取得（裁定後）: 候補件数を作者に提示し、承認された件だけを §5 の予算で取る。1 回 30 件以内
4. 検証: 取得 XML を `test/fixtures` へは置かずに、`src/dmdata` の該当パーサで parse が通ること（旧築パーサは資材として持ち越すので判定に使ってよい）と、本文の `Control/Status`・`Head/InfoType`・`EventID` が item の metadata と一致することを確認する
5. 昇格（§6 段階 2）は別 commit

## 8. 裁定点（推奨を先頭に）

- **D-1 窓外の錨の扱い**（VXSE43/45・VFVO50・VFVO55・VTSE41）:
  - **A（推奨）**: Archive 保存開始後の 2 件（EEW 2024-04-17、VFVO55 2021-05-14）は probe で権限と対象日の `fileSize` を確認し、可能なら同 EventID を Archive から取る。保存開始前の 2 件（VFVO50 2020-05、VTSE41 2011）と、Archive が届かない型は、窓内の同型事例で錨を張り替える。張り替えは step 範囲・subject・revision・再投入 fixture・合成時計を**ケース単位で一括再導出**し、原本で埋まる step だけ採用して不足 step（同 revision 訂正・取消・重複・遅着のうち原本に無いもの）は synthetic のまま残す。理由: 原本連鎖は synthetic より強い根拠になり、期待値は元電文から再導出できる。O01 の必須系列は「訂正 or 取消」ではなく訂正・取消・重複・遅着の全部なので、部分採用を許さないと結局全部 synthetic になる
  - B: 既存の錨は変えず、不足 step は全て synthetic。REST は「正常」の原本確認だけに使う（Archive も使わない）
  - C: Archive だけ試し、別事例への張り替えはしない
- **D-2 公開可否の既定**:
  - **A（推奨）**: 取得時は `unconfirmed`＋未確認理由。昇格時に 1 件ずつ `publicApproved`（main 可）か `privateOnly`（personal のみ）を裁定し、根拠と確認日を manifest に残す。理由: 既存 257 件も全件未確認のまま。公開 main へ実電文を置く判断は再配信ポリシーと同じ重さ
  - B: 全件 `privateOnly` に固定し、新築の系列は personal でだけ完全に走る
- **D-3 probe の実行時期**:
  - **A（推奨）**: この計画の承認と同時に probe（§7 手順 1、本文なし 19 req）だけ実行し、§3 の見込み列を実測値に置き換える。理由: 「取れるか」が分からないまま D-1 を裁定すると synthetic の範囲を決められない。本文サンプル（empty・unknown・code00 の確定用）は probe 後に件数を示して別途承認
  - B: probe も本文取得と同じ扱いで別途裁定
- **D-4 待ち伏せの運用**:
  - **A（推奨）**: 常駐は作らず手動運用にする。**見逃しを許容し、P0/P1 を事象待ちで止めない。** 実行時期は §5 の集中発表時回避を優先し、回避と両立するときだけ事象後 24 時間以内に経路 A。逃した分は翌日以降に経路 D で回収、それも届かなければ synthetic で進める。バックログ ⏳待ち節に「津波解除・噴火警報取消・洪水予報の発生待ち」を置く。理由: 自動化が上げるのは捕捉率だけで、Archive で翌日回収できるなら常駐の価値は薄い
  - B: Pi の journal を見て自動採取する常駐を作る

## 9. 非対象

- 不正・上限境界の系列（REST では取れないと確定済み。synthetic の設計は P1 の Q-LIMIT と別契約）
- JMA 公開 XML（`jmaPublished`）からの取得。dmdata で足りない事象に限って別途検討
- 新築 ingress（B03）の REST 復旧機能の設計。spec §10.5 と N2 の範囲で、corpus 取得とは分ける
- 正常原本（21 route の発表報・ignore 候補）の採取は別段階（§2）。Q-OP の a/n 実受信例（WTJPii）も同じ段階で扱う
- バックログ P2-3（VPTA50/VPWP50 の timeId 不連続 corpus）は経路 A の VPTA50/VPWP50 probe と同じ一覧で観測できるので、probe 結果を P2-3 にも転記する。ただし P2-3 の目的（timeId 欠番の機械集計）はこの計画の受入条件に含めない
