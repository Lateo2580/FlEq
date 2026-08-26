# spec: 竜巻 rider の地域集約（draft, 2026-08-26）

> Status: **全裁定確定（2026-08-27 ご主人裁定: D2=A）**。D1-D＋D2-A で実装可能。
>
> 対象: VPHW50 / VPHW51 の待機画面 `WeatherAlertCard` 竜巻 rider
>
> 前提裁定: 地域数に応じた高さ予算や別 surface への退避ではなく、電文が全域発令を証明できる場合だけ地域名を集約する。

## §1 目的と非目的

県全体への竜巻注意情報を市町村等で全件列挙すると、rider が警報表示部より大きくなり、カード内ページ数も増える。本仕様は、**電文自身が全域を示す場合だけ**細粒度の全件を `○○県内全域` 等へ畳み、部分発令を市町村等のまま残す。

次は行わない。

- rider の高さを見て集約可否を変えない。入力が同じなら viewport、font、placement によらず同じ表示地域列になる。
- 全域を証明できない地域を件数閾値だけで粗い layer へ置換しない。
- rider を別カード、テロップ、CLI だけへ逃がさない。
- 既存のカード内ページング、`ValidDateTime`、通知重大度、目撃地域、世代管理の規則を変更しない。scope key の識別子は §4.3 の前提依存として別途是正する。
- 外部の市町村・細分区域マスタを参照しない。

## §2 調査結果と一次資料の根拠（base `06d515fd0`）

### §2.1 現行経路

1. `src/dmdata/tornado-parser.ts` は Headline と Body から `layers` を作るが、各 layer から Code `0` / Name `なし` を除き、active 地域だけを保持する。
2. `selectPreferredTornadoLayer()` は `市町村等` → `市町村等をまとめた地域等` → `一次細分区域等` → `発表細分` の順で最細粒度を選ぶ。
3. `src/engine/presentation/events/from-tornado.ts` は選択 layer の全件を `areaItems` / `areaNames` に射影する。
4. `StandbyStateStore.applyTornado()` は `areaItems` の名称を PublishingOffice 別 state へ保存し、snapshot で state を順序保持 `Set` により統合して `data.areas` を作る。これは現在実装の識別子であり、電文 roster の対象範囲を表すものではない。
5. 同じ `areaItems` はテロップ詳細にも使われる。このため `areaItems` 自体を粗粒度へ変えると rider だけでなくテロップからも市町村等が失われる。
6. CLI の通常表示は細粒度 layer の先頭30件と省略数、`detail tornado` は同じ細粒度 layer の全件を表示する（`d72394c`）。

### §2.2 一次資料の根拠

- 気象庁『[竜巻注意情報 XML の解説](https://dmdata.jp/docs/jma/manual/0252-0252.pdf)』（令和8年3月24日改訂）は、Body.Warning の type を「発表細分」「一次細分区域等」「市町村等をまとめた地域等」「市町村等」の4種と定義する。Kind は `Name=竜巻注意情報 | なし`、`Code=1 | 0`、`Status=発表 | なし` の二値である。同資料は InfoType を発表／訂正とし、取消の情報形態は存在しない。有効時間は約1時間である。
- 気象庁『[配信資料に関する技術情報第418号](https://www.data.jma.go.jp/suishin/jyouhou/pdf/418.pdf)』（平成27年）は、一次細分区域単位で発表状況を判別できる運用変更と、非発表区域も `Name=なし` / `Code=0` / `Status=なし` として全区域列挙する埼玉の公式電文例を示す。
- 2026-08-26取得の実電文では、埼玉 VPHW51 は一次細分3（発表1・なし2）／市町村63（発表19・なし44）、石川 VPHW51 は市町村19件すべて発表・なし0件だった。後者は石川県の全19市町村と一致した。

これらは roster が府県予報区（発表細分）内の全地域を表すという強い帰納的根拠である。ただし「全地域を必ず掲載する」という義務規定の明文は確認できていない。PublishingOffice は2026-05-28以降の実電文で全て `気象庁` であり、roster の対象範囲や県の識別子には使えない。

### §2.3 fixture の layer 構造

`test/fixtures` の竜巻3電文は、Headline.Information では主に active 対象を、Body.Warning では同じ4階層の active / `なし` を持つ。これは fixture での観測であって、すべての実運用電文で roster が完全・恒常的である証明ではない。Body の実測は次のとおりだ。

| fixture | 発表細分 | 一次細分 | まとめた地域 | 市町村等 | 判定例 |
|---|---:|---:|---:|---:|---|
| `19_01_01_091210_VPHW50.xml` | 1 active / 2 none | 1 / 2 | 5 / 4 | 53 / 8 | 東京地方のみ。東京都全域ではない |
| `19_03_01_130906_VPHW50.xml` | 1 / 0 | 4 / 0 | 11 / 0 | 24 / 0 | 長崎県全域 |
| `19_04_01_140425_VPHW51.xml` | 1 / 2 | 1 / 2 | 5 / 4 | 53 / 8 | 目撃付きだが地域境界は東京地方のみ |

東京 fixture の Body は、発表細分で `東京地方=active`、`伊豆諸島北部/南部=none`、市町村等で本土53件が active、島しょ8件が none である。長崎 fixture は4階層すべてに none がない。石川実電文の「なし0件・市町村19件全発表」は、none の存在を全域判定の必須条件にできない反例でもある。

各 layer は別 code 体系の平坦な一覧で、`市町村 code → 発表細分 code` の親参照は電文中にない。しかし一次資料の4層 roster 定義と全区域列挙の運用例に基づき、**4層全 Item が active**であれば府県予報区内全域と扱う。外部マスタや親子 join は用いない。

## §3 全域判定の正本

### §3.1 projection-local な証拠抽出

第一候補は `ParsedTornadoAdvisory` を拡張しない。`fromTornadoOutcome()` またはその純粋 helper が、表示射影の時だけ raw `outcome.msg` の Body.Warning を読んで次のローカル値を作り、既存 `info.layers` の active 投影と照合する。

```ts
interface TornadoCoverageLayer {
  type: string;
  source: "body";
  areas: TornadoArea[]; // status は active | none。none も捨てない
}
```

- roster の候補は **Body.Warning のみ**から読む。Headline は active-only であり、全域証明には使わない。
- 既存 `layers`、`activeAreaCount`、`selectPreferredTornadoLayer()` は一切意味を変えない。Body の局所読解結果でこれらを再構成・上書きしない。
- Body の各 Warning type、Area.Name、Area.Code、Kind が非空であることを証拠抽出には要求する。同一 layer 内の Area.Code 重複、同 code の active / none 競合、Name/Code/Kind/Status 不一致、未知 layer、必要 layer 欠落は `coverage = unproven` とする。
- `unproven`、Body 欠落、Body 構文不正のいずれでも、projection は既存 active `layers` だけを安全に salvage して細粒度表示にする。局所読解の失敗で `activeAreaCount` を 0 にしたり、官署 state を削除したりしてはならない。
- 将来どうしても `ParsedTornadoAdvisory` へ roster field を加える場合だけ、その field を revision semantic fingerprint から明示的に除外する。旧永続 state / 旧 projection の upgrade replay、revision gate、restore の互換 test を同じ変更単位で必須化する。

### §3.2 D1-D の全域条件（採用）

判定の主 pair は次とする。

- 細粒度側: type が完全一致する `竜巻注意情報（市町村等）`
- 上位側: type が完全一致する `竜巻注意情報（発表細分）`

`includes()` による曖昧一致は使わない。`市町村等をまとめた地域等` の誤採用を防ぐためだ。

`proven-full-scope` は、以下の論理積である。

1. XML path `Report/Body/Warning[@type]` に、4 type が各1個だけ存在する。
2. 各 `Warning/Item` は Area.Name、Area.Code、Kind.Name、Kind.Code、Kind.Status を持ち、公式二値のどちらかだけを表す。Area.Code の重複、同 code の status 競合、Name/Code/Status の組合せ不一致、未知 layer は失格とする。
3. 判定は現行 `deriveTornadoStatus(name, code)` と同じである。`Kind/Name === "なし"` **または** `Kind/Code === "0"` なら none、それ以外の公式 active 組（`竜巻注意情報` / `1` / `発表`）なら active とする。Status は公式二値との整合検証に使い、単独で active 化しない。
4. 4 layer の全 Item が active である。none Item が1件でもあれば部分発令であり、集約しない。
5. 既存 active-only `layers` の市町村 code 集合が、局所 roster の市町村 active code 集合と一致する。

この判定は「府県予報区（発表細分）内の全地域を4層で列挙する」という一次資料・公式例・実電文の帰納的根拠に依存する。XML に存在しない親子対応や外部マスタは使わない。

条件を一つでも満たさなければ `aggregation: "none"` とし、`selectPreferredTornadoLayer()` の active 全件をそのまま使う。これはデフォルトであり、古い電文の集約結果、title の県名、官署名、XML 上の並び順から全域を推測してはならない。

### §3.3 D1 の最終一覧

- **D1-A — 電文全体が全域なら集約**: active-only を見る旧案。roster 不完全時に偽陽性となるため不採用。
- **D1-B — active 発表細分ごとに集約**: XML にない親子対応を仮定するため不採用。
- **D1-C — none と親子対応を必須にする**: 石川実電文の「なし0件・全19市町村発表」と矛盾し、親子対応も XML にないため撤回。
- **D1-D — 4層全 Item active のときだけ集約（採用）**: §3.2 を満たすとき、発表細分 Area.Name を X として、`X` が都・道・府・県終端なら `X内全域`、それ以外なら `X全域` とする。layer 欠落、none 混在、判定不能、Body 不正は全て細粒度表示へ fail-closed する。

## §4 表示射影

### §4.1 rider 専用 projection

`PresentationEvent.areaItems` / `areaNames` / `areaCount` は、テロップと既存集計の正確な細粒度 source として変更しない。代わりに `PresentationEvent` へ tornado 専用の display bridge を持たせ、`fromTornadoOutcome()` で毎電文生成する。

```ts
tornadoDisplay?: {
  aggregation: "proven-full-scope" | "none";
  areaNames: string[];
  sourceAreaCount: number; // 集約前の active 細粒度件数
}
```

`StandbyStateStore.applyTornado()` だけが `event.tornadoDisplay.areaNames` を官署 state の `areas` に保存する。bridge がない旧入力・手組み test input は `event.areaItems.map(name)` へ fallback する。wire の `ActiveStandbyCardV1.data.areas` と永続化 shape は変えない。

これにより、rider だけを短くしつつ、テロップ詳細、`activeAreaCount`、フィルタ、通知、CLI detail の細粒度を維持できる。

### §4.2 全域ラベル

`proven-full-scope` 時だけ、対象発表細分の順序を表示順とする。各名称は次で整形する。

- `都` / `道` / `府` / `県` で終わる: `${name}内全域`（例: `長崎県内全域`）
- それ以外: `${name}全域`（例: `東京地方全域`）

title から県名を切り出したり、PublishingOffice から地域名を作ったりしない。発表細分が複数なら、存在する名称を各1要素として順番どおり出し、電文にない共通親名を合成しない。

集約しない場合は現行どおり最細粒度の active 名を全件保持する。表示上の区切りは既存 rider の `、` を維持する。

### §4.3 複数県・部分発令との混在

集約の対象範囲は PublishingOffice ではなく、電文の発表細分（府県予報区）である。したがって、A県の電文が `proven-full-scope`、B県が部分発令3市町村なら、正しい snapshot の `data.areas` は次の形になる。

```text
["A県内全域", "B市", "C町", "D村"]
```

rider 表示は `A県内全域、B市、C町、D村` となる。各電文内順序、順序保持 `Set` の重複除去は維持する。県名 prefix を各市町村へ新規付与することや、同名市町村問題の解消は本仕様外とする。

ただし現行の `tornado:${publishingOffice}` は、2026-05-28以降 PublishingOffice が一律 `気象庁` である実電文と整合しない。複数府県予報区の共存・続報置換を正しくする scope key / durable subject の是正は、本仕様の rider 集約を有効化する**前提依存**として別作業契約で確定する。この未是正のまま A県＋B県の混在を受入済みとは扱わない。

## §5 CLI・テロップとの線引き（D2: 裁定済み【A】・2026-08-27 ご主人）

- **案 A — rider のみ集約（推奨）**: §4.1 の bridge だけに集約を適用する。テロップは細粒度全件、CLI 通常表示は細粒度30件＋省略数、`detail tornado` は細粒度全件を維持する。CLI は高さ固定の rider ではなく、`d72394c` で全件確認経路を得た直後なので、正確な drill-down を優先する。
- **案 B — CLI 通常表示も同じ集約、detail は細粒度**: `displayTornadoAdvisory()` は `proven-full-scope` 時に `○○県内全域`、`displayTornadoAdvisoryDetail()` は常に市町村等全件を出す。通常面の表記は揃うが、「通常カードと detail は同じ細粒度 layer を基準にする」という `d72394c` の直近契約を改訂し、通常表示の `発表中 N地域` と表示行の件数が一致しなくなる。

D2-A を推奨する。どちらでも `detail tornado` とテロップから細粒度全件を失う案は採らない。

## §6 続報・訂正・自然失効・世代管理

- aggregation は累積 state ではなく、**revision gate を通過した各電文の raw Body と既存 active layers から毎回再計算**する。前報の判定結果は入力にしない。
- 同じ府県予報区 scope の全域→部分発令では、次の accepted event が細粒度名で state を丸ごと置換する。部分→全域では全域ラベルへ置換する。表示ラベルが変わるので既存 tornado page identity / resetKey も新世代として再分割する。
- 判定不能な続報は安全側に細粒度 fallback し、前報の全域ラベルを保持しない。Body 局所読解の失敗だけで active 0 / state 削除へ転落させない。
- 竜巻注意情報に取消電文はない。主経路は ValidDateTime（約1時間）での自然失効と、発表／訂正の完全 snapshot による続報置換である。訂正で roster が縮まない保証は置かない。
- 汎用の `InfoType=取消` または `activeAreaCount===0` 防御が入力された場合は、集約を試みず既存どおり該当 state を削除してよい。ただし通常の竜巻取消として受入条件を組まない。
- 訂正は既存 revision guard の受理規則に従う。古い reportDateTime / serial の電文は state と集約表示のどちらも巻き戻さない。
- 現行 revision family、ticker、standby の `tornado:${normalizeTornadoPublishingOffice(publishingOffice)}` は §4.3 の scope-key 是正までの既存実装である。集約ラベルを key に足して補うことはせず、府県予報区 scope を正本とする後続契約で一貫して置換する。
- `fragmentMerge=false`、scope 単位 `clearCurrent`、TTL（ValidDateTime、不在時+1h）、永続化・restore の意味を変えない。永続化されるのは従来どおり最終的な `areas: string[]` なので、復元後も集約済みラベルは同じ表示になる。
- VPHW51 の `sightingAreas` / `isSighted` は地域集約と独立である。目撃地域の粒度・severity・`false→true` ページ reset 契約を変更しない。

## §7 リスク、撤退条件、継続観測

D1-D の roster 完全性は、一次資料の運用説明・公式例・埼玉／石川の実電文からの**帰納的根拠**であり、「全地域を必ず掲載する」という義務規定の明文ではない。この不確実性を label や外部マスタで補わない。

実機で roster 不完全の反例（4 layer が揃って見えても、府県予報区内の実在地域が欠落する等）を1件でも観測したら、直ちに D1-D の集約を停止し、D1-C 相当の全件細粒度 fail-closed へ戻す。過去の全域 label を保持・推測しない。

継続観測では、少なくとも次を記録する。

- VPHW50/VPHW51、複数府県予報区、複数時刻について、4 layer ごとの Item 件数と active / none 件数。
- 訂正報で roster が縮小・置換される実例、および Body roster と既存 active `layers` の active code 集合の一致。
- 発表細分で `Status=なし` が出現するか、全 layer active の石川型電文が継続するか。
- PublishingOffice 一律 `気象庁` 下で、府県予報区 scope key を持たない既存 state が誤置換を起こさないか。

## §8 実装単位

裁定後は次の順に実装する。

1. projection-local roster reader: raw Body.Warning の4 type / Item / Kind / Area を局所抽出し、既存 `layers` を変更せずに公式二値の構造検証と active code 照合を行う。
2. pure projection: D1-D の「4 layer 全 Item active」判定、発表細分名のラベル整形、細粒度 fallback を副作用のない helper として追加する。
3. presentation: `fromTornadoOutcome()` で `tornadoDisplay` を生成し、`areaItems` は細粒度のまま維持する。
4. standby: `applyTornado()` が rider 用名称だけを保存し、続報・自然失効・復元を確認する。§4.3 の府県予報区 scope-key 前提を満たす契約なしに複数府県共存を有効化しない。
5. D2-B が裁定された場合に限り CLI 通常 formatter を同じ helper へ接続する。detail は接続しない。

## §9 受入条件

### §9.1 機械的チェックリスト

- [ ] projection-local reader test で長崎 fixture の Body roster が発表細分 `1/0`、一次細分 `4/0`、まとめた地域 `11/0`、市町村等 `24/0`（active/none）になる。
- [ ] 同 reader test で東京 VPHW50 / VPHW51 fixture が発表細分 `1/2`、一次細分 `1/2`、まとめた地域 `5/4`、市町村等 `53/8` になる。
- [ ] 局所 roster は `ParsedTornadoAdvisory` に追加・永続化されず、既存 `layers`、`selectPreferredTornadoLayer()`、`activeAreaCount`、revision semantic fingerprint は不変である。
- [ ] Body 欠落、必要 layer 欠落、空 Area.Code、空 Area.Name、Kind 欠落、重複 Warning type、重複 code、active/none 競合、Name/Code/Status 不一致、未知 layer、Headline-only の合成入力は全て集約せず、既存 active 細粒度へ fallback する。局所 Body 読解の失敗で `activeAreaCount=0` や state 削除を起こさない。
- [ ] D1-D では長崎 fixture が `aggregation="proven-full-scope"` / `["長崎県内全域"]`、東京 VPHW50 / VPHW51 は `aggregation="none"` / 市町村等53件になる。none 0件で4 layer 全 Item active の石川型合成電文も集約する。
- [ ] 全域ラベルの suffix は `東京都内全域` / `北海道内全域` / `大阪府内全域` / `長崎県内全域`、非都道府県名は `東京地方全域` になる。入力順と重複の契約を unit test する。
- [ ] `fromTornadoOutcome()` の `tornadoDisplay` は集約されても、`areaItems` / `areaNames` / `areaCount` は細粒度の code・名称・件数を保持する。
- [ ] `projectDisplayEvent()` の `tickerDetail` は全域集約後も細粒度名を含む。§4.3 の scope-key 是正まで current `groupKey` は変更せず、是正契約では ticker / revision family / durable state が同じ府県予報区 scope key を使うことを別途検証する。
- [ ] 府県予報区 scope-key の是正契約後に、standby store test で `A県内全域 + B県3市町村` の混在順序、府県予報区横断統合、同一 scope の全域→部分／部分→全域の完全置換を確認する。
- [ ] 世代遷移は次の5ケースを個別 test に分ける。(1) 遅着した古い発表の拒否、(2) 受理済み訂正の replay 拒否、(3) ValidDateTime 自然失効後に古い発表で state を復活させる試行の拒否、(4) TTL 後も durable revision gate が古い電文を拒否すること、(5) 永続 restore 後に同じ gate が働くこと。各ケースで旧集約ラベルの残留・復活がない。汎用取消入力の防御 test は別途追加してよいが、竜巻の通常系列としては扱わない。
- [ ] VPHW51 の目撃 severity、目撃地域、ページ reset と、通知音 warning の既存 test が不変である。
- [ ] D2-A なら CLI 通常30件上限と `detail tornado` 全件 test を不変で通す。D2-B なら通常=集約 / detail=細粒度全件の分岐 test を追加する。
- [ ] 1、2、5、12、多数市町村、全域＋部分混在の rider で既存ページングの入力が期待する `data.areas` と一致し、常駐時は **15×P秒以内**、weather rotation set がR枚のときは **15×R×P秒以内**に全要素を1回表示する。全 `data-page-probe-readable` の縦横 overflow は 0 とする。
- [ ] `git diff --check`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run typecheck:test`（変更対象 test が当該 tsconfig の検査範囲に入る場合。入らない場合は N/A の根拠を記録する）
- [ ] `npm run test:shuffle`（parser / revision / standby の共有・永続 state を触るため必須）
- [ ] `npm --prefix display run typecheck`
- [ ] `npm --prefix display run test`
- [ ] `npm --prefix display run build`

### §9.2 実機目視（機械 gate と分離）

- [ ] 長崎または石川型の D1-D fixture で rider が `長崎県内全域` の1要素になり、警報表示部より地域列挙が支配的に大きくならない。
- [ ] 東京 fixture 相当では `東京都内全域` を出さず、市町村等が既存ページングで巡回する。
- [ ] A県内全域＋B県3市町村で `A県内全域、B市、C町、D村` と読め、全域 label と部分地域の境界が曖昧でない。
- [ ] 続報で全域↔部分へ変化した際、旧ページや旧 label が残らず新しい先頭ページへ更新される。
- [ ] VPHW51 で目撃表示の強調が集約 label に埋もれず、ValidDateTime の自然失効後は rider 自体が消える。

目視は読みやすさと意図の確認であり、全域判定の正しさ、全件到達、overflow、世代置換の機械 gate の代用にはしない。

## §10 最終 D 一覧

| ID | 分岐 | 推奨 |
|---|---|---|
| D1 | A: active-only全域 / B: 発表細分ごと / C: none＋親子対応 / D: 4 layer 全 Item active | D: 4 layer 全 Item active のみ集約（親裁定により採用） |
| D2 | rider のみ集約 / CLI 通常表示も集約 | A: rider のみ。CLI 30件＋detail 全件と直近 `d72394c` の契約を維持する |
