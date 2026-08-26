# spec: briefing card の内容構造化（draft v0.2, 2026-08-27）

> 状態: **全裁定確定（2026-08-27 ご主人裁定: D1〜D4 すべて B）**。実装可能。

## §1 背景・目的

2026-08-27 朝、VPBS50「富山県気象防災速報（線状降水帯直前予測）」EventID `YJPNA202608270448_202608270448`、warning が Pi 実機で初めて briefing card として表示された。card projection 自体は `telegram-foundation.md` 第3縦切り裁定2どおり正しい。一方、現状の `BriefingCard.svelte` は `entry.headline` を16文字単位の blockへ分け、その散文を主面から順に表示するため、「何が・どこで・いつ」が定型化されず、速報カードの初見性が低い。

本 spec の目的は、standalone を含む全受理済み VPBS50 と fail-open 表示された VPOA50 のカード化を保ったまま、既知 kind の主面を構造化フィールドから機械的に組み立てることだ。headline の分かち書き、正規表現、地名抽出、要約生成、LLM 等の自然言語解析は使わない。未知の構造は現行 raw headline 表示へ戻し、情報を黙って消さない。

## §2 対象・非対象

対象:

- `briefing` card entry の表示用 kind 判定、定型 lead、対象地域、時刻、構造化 fact。
- engine/frontend 同期済み wire への additive な summary semantic。
- 既知、未知、複数 kind、取消、VPOA50 fail-open、late counterpart reconcile の表示内容。
- card pager 内での構造化主面と raw headline 全文の配置。

非対象:

- VPBS50／VPOA50 の受理資格、parser の severity 判定、通知、通知音、CLI、ticker sentence。
- card identity、TTL、容量、集約、generation、訂正／取消 lifecycle、late reconcile 原子性。
- solver、固定 page shell 高、probe、rotation、15秒 pager、layout motion の契約変更。
- headline の文意推定、未知語の既知 kind への近似、Area 名からの code 推定。
- カード化撤回、card 高さの拡大だけで散文を収める対応。

## §3 現状と一次 evidence

### 3.1 現行 wire／renderer

`DisplayBriefingEntryV1` は `title`、`headline`、`conditions`、code 付き `targetAreas`、`reportDateTime`、`publishingOffice`、`infoType`、engine 解決済み `frameLevel`、`severityEvidence`、`qualifier` を持つ。VPBS50 parser はさらに Body の `observations` を `observationType`、`description`、`value`、`unit`、`time`、`locationName`、`locationCode` として構造化済みだが、現行 card wire には載せていない。本変更では parser model に additive な `partKind` discriminant を加え、fact 化の唯一の種別根拠にする。

現行 renderer は title → raw headline → conditions → areas → qualifier → meta の順にすべてを page block 化する。このうち identity／pager／page shell は再利用できる。変更すべきなのは block の意味と順序であり、pager の時間・高さモデルではない。

### 3.2 実 fixture で確認できる形

| 種別 | 構造化された判定根拠 | 構造化された地域・fact | raw headline の形 |
|---|---|---|---|
| 線状降水帯発生 | VPBS50 `Condition=線状降水帯発生`、Body `EventName=線状降水帯発生` | `Area` 1..N、Event `Time` | 発生継続と危険度上昇を述べる散文 |
| 線状降水帯直前予測 | VPBS50 `Condition=線状降水帯直前`、Body `EventName=線状降水帯予想`、title 種別 `線状降水帯直前予測` | `Area` 1..N、Event `Time` | 「今後３時間以内」から始まる可能性・危険度の散文 |
| 記録的短時間大雨 | VPBS50 `Condition=記録雨`／`記録的短時間大雨`、または VPOA50 の `Information/Warning type=記録的短時間大雨情報（発表細分）` と Kind `Name/Code` | VPBS50 は降水の location、description、value、unit、time。VPOA50 は code 付き `Area` | 発生時刻、地点、1時間雨量、危険度を複数文で列挙 |
| 短時間大雪 | VPBS50 `Condition=短時間大雪` | 降雪の location、description、value、unit、time と code 付き `Area` | 観測量、継続見込み、交通障害を述べる散文 |

追跡済み一次入力は `test/fixtures/82_01_01_260324_VPBS50.xml`、`82_03_01_260324_VPBS50.xml`、`82_01_02_250630_VPBS50.xml`、`82_01_03_241031_VPBS50.xml`、`synthetic_VPBS50_*`、`phase6b_VPBS50_*`／`phase6b_VPOA50_*` の実6 pairである。

2026-08-27採取の Pi 実電文4通は `~/dev/fleq-corpus-6b-latter/raw-briefing-0827/` を provenance とする。実装ではこの4原文を取得日時、EventID、SHA-256とともに `test/fixtures/` へ fixture 化する。prefix は kind 判定に使わない。

| corpus 原文 | title | ReportDateTime | Condition | EventName | code付きArea |
|---|---|---|---|---|---|
| `VPBS50_YJPNA202608270448.xml` | 富山県気象防災速報（線状降水帯直前予測） | 2026-08-27T04:48:00+09:00 | 線状降水帯直前 | 線状降水帯予想 | 東部 `160010`、西部 `160020` |
| `VPBS50_YJPNB202608270448.xml` | 石川県気象防災速報（線状降水帯直前予測） | 2026-08-27T04:48:00+09:00 | 線状降水帯直前 | 線状降水帯予想 | 能登 `170020` |
| `VPBS50_HJPNA202608270258.xml` | 富山県気象防災速報（線状降水帯発生） | 2026-08-27T02:58:00+09:00 | 線状降水帯発生 | 線状降水帯発生 | 西部 `160020` |
| `VPBS50_HJPNB202608270308.xml` | 石川県気象防災速報（線状降水帯発生） | 2026-08-27T03:08:00+09:00 | 線状降水帯発生 | 線状降水帯発生 | 加賀 `170010`、能登 `170020` |

## §4 正規化モデル

### 4.1 additive summary semantic

engine 側で `DisplayBriefingEntryV1` に optional な `summary` を加え、frontend は文字列を再判定しない。名前は実装時の型レビューで調整してよいが、意味は次で固定する。

```ts
type DisplayBriefingKindV1 =
  | "linearRainObserved"
  | "linearRainPredicted"
  | "recordRain"
  | "shortSnow";

type BriefingObservationPartKind = "event" | "precipitation" | "snowfall" | "other";

/** parser が Body Item.Kind.Property.Type を exact mapping した結果。 */
interface WeatherObservation {
  // existing fields
  partKind: BriefingObservationPartKind;
}

// `partKind` の exact mapping。文字列の部分一致や headline は使わない。
// 気象現象の実況 -> event、雨の実況 -> precipitation、雪の実況 -> snowfall、その他 -> other

type DisplayBriefingFactV1 =
  | {
      kind: "event";
      label: "発生" | "予想";
      areaName: string | null;
      areaCode: string | null;
      at: string | null;
    }
  | {
      kind: "precipitation" | "snowfall";
      locationName: string | null;
      locationCode: string | null;
      /** JMAXML の description 属性。文として解析しない。 */
      description: string;
      value: number | null;
      unit: string | null;
      at: string | null;
    };

interface DisplayBriefingSummaryItemV1 {
  kind: DisplayBriefingKindV1;
  lead: string;
  /** Condition／Kind の入力順。同じ kind は最初の一件へ畳む。 */
  sourceOrdinal: number;
  facts: DisplayBriefingFactV1[];
}

interface DisplayBriefingSummaryV1 {
  mode: "structured" | "mixed" | "rawHeadlineFallback" | "cancellation";
  items: DisplayBriefingSummaryItemV1[];
  /** VPBS50 の kind-bearing Condition に未知値が一件でもあれば true。 */
  hasUnknownKind: boolean;
}
```

`summary` 欠落の旧 snapshot は `rawHeadlineFallback` と同じ現行描画へ fail-open する。発表時刻は既存 `reportDateTime` だけを使い、summary内に重複fieldを導入しない。既存 `headline` は wire から削除せず、既知 kind でも原文の真実源として保持する。`conditions`、`targetAreas`、`reportDateTime`、`severityEvidence` も置換しない。

frontend は summary を信頼して描画してはならない。`summary` が null／非 object、mode が4値以外、`structured` または `mixed` で `items` が空、item が object でない・`kind`／`lead`／`sourceOrdinal` が不正、`facts` が配列でない、または fact が上記 union shape を満たさない場合は、例外・部分描画・旧shapeの推測をせず entry 全体を `rawHeadlineFallback` として描画する。同じ guard は通常 snapshot と `reconcile` frame 内の card payload の双方へ適用し、reconcile frame の旧shapeも同じ fallback にする。

### 4.2 kind 判定

判定は engine で次の順に行う。NFKC は表記揺れ吸収に使ってよいが、headline は入力にしない。

1. VPBS50 は `Headline.Information/Item/Kind/Condition` のうち、情報種別を表す kind-bearing Condition だけを全件 exact allowlist へ写像する。`hasUnknownKind` と `mixed` の対象もこの集合だけである。
2. VPOA50 の `Condition=発表`、Body `Status=発表` 等の発表状態は kind-bearing Condition ではない。これらを `hasUnknownKind`／`mixed`／unknown 判定へ入れてはならない。VPOA50 は source type、Information／Warning の exact type、Kind `Name=記録的短時間大雨情報` と既存 code evidence から `recordRain` とする。EventID の J/K prefix や headline は使わない。
3. Condition が空の VPBS50 に限り、Head.Title の括弧内種別が exact allowlist と一致するときだけ title fallback を使う。括弧を持たない generic title や部分一致は unknown とする。
4. VPBS50の kind-bearing Condition が既知／未知で混在する場合は `mode="mixed"` とし、既知 item を構造化表示しつつ raw headline 全文も失わない。
5. VPBS50の全 kind-bearing Condition が未知、Condition が空かつ title fallback 不成立、必須構造が矛盾する場合は `rawHeadlineFallback` とする。未知語を最も近い既知 kind へ寄せない。
6. VPBS50の `InfoType=取消` は kind より先に `cancellation` とし、既存 cancel frame と10分TTLを保存する。VPOA50取消は cancellation／`recordRain` structured summaryへ混ぜず、既存どおり独立 `rawHeadlineFallback` のfail-open entryとして通常120分TTLを使う。

exact allowlist と定型 lead は次を初期値とする。

| 入力の exact 種別 | summary kind | 主面 lead |
|---|---|---|
| `線状降水帯発生` | `linearRainObserved` | `線状降水帯が発生` |
| `線状降水帯直前` | `linearRainPredicted` | `３時間以内に線状降水帯発生のおそれ` |
| `記録雨`／`記録的短時間大雨` | `recordRain` | `記録的短時間大雨` |
| `短時間大雪` | `shortSnow` | `短時間大雪` |

title fallback は括弧内が `線状降水帯発生`、`線状降水帯直前予測`、`記録的短時間大雨`、`短時間大雪` のいずれかに exact 一致する場合だけ同表へ写像する。新語を追加するときは実 XML fixture、期待表、unknown fallback 回帰を同時に追加する。

### 4.3 複数 kind と順序

- 全 Condition を処理し、先頭一件だけで代表させない。同じ summary kind の同義 Condition は最初の一件へ畳む。
- item 順は各 Condition に対応する `briefingSeverityEvidence.displaySeverity` の降順、null は最後尾、同順位は `sourceOrdinal` の昇順とする。`sourceOrdinal` は parser が情報タグを優先して正規化した後の Condition 順であり、独自のkind tie-breakを加えない。
- VPBS50の未知 kind-bearing Condition が一件でも混在すれば既知 item だけを表示して完了扱いにせず、raw headline の可読経路を同じ card 内に残す。
- summary item 数、fact 数、全対象地域をデータ層で切り捨てない。主面上限を採る場合も残りは pager 後段へ送る。

### 4.4 対象地域と時刻

- 地域 chip は既存 `targetAreas` の `{name, code}` を入力順で使い、code で安定重複除去する。名称だけの推定 merge、府県名からの細分推定、headline からの地名抽出は禁止する。
- VPOA50 の府県粒度 area と VPBS50 の細分 area は別の原文粒度である。late reconcile 後は既存 source→canonical replacement に従い VPBS50 側だけを表示し、両者を合成しない。
- 主面の時刻は `ReportDateTime` の発表時刻とする。Body Event／降水／降雪の `Time` は fact の観測・現象時刻であり、発表時刻の代わりにしない。
- 日付を省略して時刻だけ出すかは既存 card の当日表示規約に合わせるが、日跨ぎ／時刻不正では誤認させない。date gate 済み値を受信時刻へ差し替えない。

### 4.5 構造化 fact

fact は headline 文から抽出せず、`observations.partKind` とtyped値だけから作る。`partKind="other"` は fact 化しない。

| kind | 利用できる fact | 表示例 |
|---|---|---|
| `linearRainObserved` | Event の area、`EventName`、`Time` | `10:10 発生` |
| `linearRainPredicted` | Event の area、`EventName`、`Time` | `01:50 予想` |
| `recordRain` | precipitation の location、description、value/unit、time | `美幌町 約１００ミリ / 13:10` |
| `shortSnow` | snowfall の location、description、value/unit、time | `長浜市余呉町柳ケ瀬 37cm / 06:00` |

`description` は JMAXML の未検証ラベルとして表示できるが、typed 値との比較・矛盾判定・時間幅／qualifier の再解析をしない。VPOA50 は現 fixture に構造化雨量がないため、headline から雨量を抜かず lead、府県 chip、発表時刻、既存 `対応電文未確認` qualifier だけを出す。

## §5 主面と全文の情報階層

全分岐に共通する主面の順序は次とする。

1. 現行 frame level を反映する card header と source／InfoType。
2. 既知 kind の定型 lead。複数 kind は全 item を pager 対象にする。
3. code 付き対象地域 chip。
4. 発表時刻。VPOA50 qualifier は主面から降格しない。
5. D1 で採択した場合の構造化 fact。

既知 kind の raw headline は削除せず、D3 の裁定先で全文を読めるようにする。`rawHeadlineFallback` は D3 にかかわらず現行どおり raw headline を主面から表示する。`mixed` は構造化要点の直後から raw headline を同じ card pager に流す。headline が `null`／空なら title、全 Condition、全 Area、発表時刻を表示し、「本文なし」を明示して空カードにしない。取消は `気象防災速報を取消`、raw title、raw headline（存在時）、発表時刻を表示する。

card と ticker の併存は第3縦切り裁定7のまま維持する。ticker が同じ raw headline を一時表示していても、unknown fallback や D3 の全文保存を省略する根拠にしない。

## §6 pager・高さ・安定化

- `briefing` は既存 `PageableKey`、15秒 pager、partition probe、rotation appearance をそのまま使う。新しい別 timer や hover 専用表示を真実源にしない。
- structured summary、overflow 地域、fact、raw headline は独立して読める semantic block とし、固定件数で切らず `sequentialPartitionRanges()` へ渡す。
- solver 予約高、forced probe 高、live outer 高は現在の同一 page shell 契約高を維持する。構造化で自然高が下がっても card 固有の高さ定数や solver score を変えない。
- pending、infeasible、一 block fallback、page footer の現行防衛を保存し、overflow hidden による情報消失を完了扱いにしない。
- 同じ entry key の内容更新、source→canonical replacement、candidate 追加、severity 上昇、真の overflow に対する `fcba058` 安定化／解除条件を変更しない。表示 block identity は entry key＋semantic kind＋構造化 source ordinal／code から作り、headline 文言の hash や解析結果を card identity にしない。
- 全文を pager に置く案では P page の常駐表示は `15×P` 秒以内、rotation set が R 枚なら `15×R×P` 秒以内に全 block を一巡できる既存契約を適用する。

## §7 既存契約の保存境界

本変更は表示 projection の additive semantic と frontend block 構成だけに限定する。次を変更してはならない。

- kind は引き続き outer `briefing` 一つ、一 kind＝一 solver candidate、entry 最大128。
- `card:vpoa:<raw EventID|messageId>`／`card:vpbs:<raw EventID|messageId>` identity と raw spelling。
- date gate 済み `ReportDateTime + BRIEFING_CARD_TTL_MS(120分)`、late reconcile の `min(source, canonical)`。VPBS50取消だけは cancellation 10分TTL、VPOA50取消は独立fail-open entryの通常120分TTLとする。
- 複数 entry 集約、updatedAt＋stable key eviction、generation、一回性 metric。
- VPOA50→VPBS50 source remove＋canonical insert、ticker receipt 非依存の card reconcile、single reduce／authoritative snapshot 収束。
- display off/on と browser reconnect では monitor 所有の非永続card stateを保持する。process restart だけは空stateからfail-open再開する。旧 snapshot／unknown protocol もfail-openする。
- engine 解決済み severity／frame、通知本文／sound／CLI、ticker identity／TTL／scheduler／通知。
- `CARD_ORDER`、candidate presence／score、surface、solver、rotation membership、layout motion identity、既存 card の配置・高さ・priority。

headline を card wire に残すことは必須である。構造化表示の成功を根拠に raw field、fixture の原文、監査 evidence を削除しない。

## §8 裁定済み分岐（2026-08-27 ご主人裁定: 全件 B）

### D1: 既知 kind の定型要点の粒度【裁定: B】

- **案 A: lead＋地域＋発表時刻だけ**。Body の観測 fact は raw headline 後段だけに委ねる。
- **案 B: lead＋地域＋発表時刻＋構造化 fact**。主面に収まる fact を出し、残りは同じ pager 後段へ送る。headline 解析はしない。
- **推奨: B**。記録雨の地点・雨量、短時間大雪の地点・降雪量を構造化値のまま残せ、単なる種別ラベルへの過剰圧縮を避けられるためだ。

### D2: 主面の地域 chip 上限【裁定: B】

- **案 A: 主面から全件**。収まらない場合は同じ structured summary の連続ページへ送る。
- **案 B: 主面は先頭3件＋`ほかN地域`**。後段ページで code 付き全地域を表示する。
- **推奨: B**。初見性を保ちつつ、後段で全件を必ず読める。上限は描画だけであり state／wire の切捨てではない。

### D3: 既知 kind の raw headline 全文の置き場【裁定: B＝ticker のみ・カード主面/pager には載せない】

- **案 A: card pager 後段**。structured summary の後に原文全文を semantic block として巡回表示し、ticker も従来どおり併存する。
- **案 B: ticker のみ**。card は構造化要点に限定し、全文は既存 ticker で読む。unknown／mixed／取消だけは card 内 raw 表示を残す。
- **推奨: A**。ticker の表示時期や scheduler state に依存せず、card のactive TTL中に原文へ戻れる。既存「長文は pager」の裁定とも一致する。

### D4: raw title の主面配置【裁定: B】

- **案 A: raw title を主面に残す**。現行 title の直後に定型 lead を出す。
- **案 B: 主面は短い source header＋定型 lead**。D3=Aなら raw title は headline と同じ詳細ページへ移し、D3=Bなら wire に保持したまま card 主面では省略する。unknown／mixed／取消では主面に残す。
- **推奨: B**。`○○県気象防災速報（種別）` と定型 lead の重複を減らし、地域 chip と時刻を上段へ上げられるためだ。

## §9 実装単位

裁定後の依存順は次とする。

1. **fixture／pure derivation**: corpus provenance を持つ富山／石川×直前予測／発生の実4XMLを追加し、既存4種、synthetic、Phase 6B実6 pairを含む期待表を拡張する。headline 非参照、`partKind` exact mapping、unknown／mixed／VPBS50取消／VPOA50取消 test を先に置く。
2. **wire／state projection**: engine/frontend protocol に optional summary semantic と構造化 fact を同一変更単位で追加する。既存 headline／conditions／areas は維持し、summary欠落・不正shape・reconcile frame旧shapeを raw fallback にする。
3. **frontend component／pager**: 裁定済み主面順、詳細 block、地域 overflow、fact、fallback を `BriefingCard.svelte` へ接続する。既存 page shell、probe、coordinator、infeasible 防衛は変更しない。
4. **production-shaped gate**: standalone 4種、Pi実電文、VPOA50 fail-open、実6 pairの両到着順／late reconcile、unknown／mixed／cancelを実 parser→store→protocol→frontend reduce→render の一本鎖で固定する。

## §10 受入条件

### 10.1 機械検証: fixture 別期待表

| fixture／系列 | 期待 mode／kind | 主面の固定期待 | 全文・fallback期待 |
|---|---|---|---|
| `82_01_01_260324_VPBS50.xml` | structured／`linearRainObserved` | `線状降水帯が発生`、北西部・北東部・南部、10:19発表。D1=Bのevent factは各Areaの`線状降水帯発生`／10:10 | XML decode 後の raw headline と文字列完全一致で可読 |
| `82_03_01_260324_VPBS50.xml` | structured／`linearRainPredicted` | `３時間以内に線状降水帯発生のおそれ`、福岡地方、01:59発表。D1=Bのevent factは福岡地方 `線状降水帯予想`／01:50 | XML decode 後の raw headline と文字列完全一致で可読 |
| `82_01_02_250630_VPBS50.xml` | structured／`recordRain` | `記録的短時間大雨`、網走地方、13:29発表。D1=B: 美幌町／`約１００ミリ`／100／mm／13:10、 美幌／`９３ミリ`／93／mm／13:10 | raw headlineの4行を順序保持 |
| `82_01_03_241031_VPBS50.xml` | structured／`shortSnow` | `短時間大雪`、北部、06:13発表。D1=B: 長浜市余呉町柳ケ瀬／`３７センチ`／37／cm／06:00 | XML decode 後の raw headline と文字列完全一致で可読 |
| corpus `VPBS50_YJPNA202608270448.xml` | structured／`linearRainPredicted` | 富山東部 `160010`・西部 `160020`、04:48発表。D1=B: 各Area `線状降水帯予想`／04:40 | exact headline を fixture expected へ固定 |
| corpus `VPBS50_YJPNB202608270448.xml` | structured／`linearRainPredicted` | 石川能登 `170020`、04:48発表。D1=B: 能登 `線状降水帯予想`／04:40 | exact headline を fixture expected へ固定 |
| corpus `VPBS50_HJPNA202608270258.xml` | structured／`linearRainObserved` | 富山西部 `160020`、02:58発表。D1=B: 西部 `線状降水帯発生`／02:50 | exact headline を fixture expected へ固定 |
| corpus `VPBS50_HJPNB202608270308.xml` | structured／`linearRainObserved` | 石川加賀 `170010`・能登 `170020`、03:08発表。D1=B: 各Area `線状降水帯発生`／03:00 | exact headline を fixture expected へ固定 |
| `phase6b_VPBS50_*` 実6件 | structured／`recordRain` | canonical細分Area、各ReportDateTime、下表のD1=B静的fact | 各 raw headline の改行・順序保持 |
| `phase6b_VPOA50_*` 実6件 | structured／`recordRain` | 府県Area、各ReportDateTime、`対応電文未確認`。factは0件、雨量をheadline解析しない | raw headline保持。late pair後はsource entryなし |
| `synthetic_VPBS50_multi.xml` | **structured**／`recordRain`、`shortSnow` | displaySeverity降順、同義kind重複なし、全Area。D1=Bは短時間大雪の静的fact（長浜市余呉町柳ケ瀬／`３７センチ`／37／cm／06:00）を含む | 全kind／全地域が一巡 |
| `synthetic_VPBS50_unknown-tag.xml`／fallback／empty | rawHeadlineFallback | raw title、Condition、Area、発表時刻 | raw headlineを主面から表示 |
| `synthetic_VPBS50_cancel.xml` | cancellation | cancel frame、取消lead、発表時刻 | raw title／headline保持、10分TTL不変 |
| 新規 `synthetic_VPOA50_cancel.xml` | rawHeadlineFallback の独立fail-open entry | VPOA50取消の府県Area、通常120分TTL、VPOA50取消をVPBS50 cancellation／`recordRain` structured summaryへ写像しない | raw headline／qualifier保持 |
| VPBS50／VPOA50 entry のsummary=`null`／非object | rawHeadlineFallback | title、headline、Condition、Area、reportDateTimeの現行順 | 例外・空cardなし |
| VPBS50／VPOA50 entry のsummary.mode=unknown | rawHeadlineFallback | 同上 | unknown modeを推測しない |
| VPBS50／VPOA50 entry のsummary.mode=`structured`・items空 | rawHeadlineFallback | 同上 | 空structured cardなし |
| VPBS50／VPOA50 entry のitem／facts shape不正 | rawHeadlineFallback | 同上 | 部分summaryを描画しない |
| reconcile frame 内のVPBS50／VPOA50旧／不正summary shape | rawHeadlineFallback | source→canonical replacement後のcanonical entryを現行順で描画 | reconcile例外・ticker scheduler変更なし |

Phase 6B VPBS50 のD1=B fact expected は次の静的値とする。`description`、`value`、`unit`、`time` のいずれも parser 出力から期待値を生成しない。

| fixture | location（code） | description | value／unit | time |
|---|---|---|---|---|
| `phase6b_VPBS50_KJPDE202608201757_202608201757.xml` | 北塩原村 (`0740200`) | `約１００ミリ` | 100 mm | 17:50 |
| `phase6b_VPBS50_KJPTC202608211633_202608211633.xml` | さいたま市 (`1110000`) | `約１１０ミリ` | 110 mm | 16:20 |
| `phase6b_VPBS50_KJPTC202608221709_202608221709.xml` | 戸田市 (`1122400`) | `約１００ミリ` | 100 mm | 17:00 |
| `phase6b_VPBS50_KJPTK202608221709_202608221709.xml` | 北区 (`1311700`)、板橋区 (`1311900`) | 各`約１００ミリ` | 各100 mm | 各17:00 |
| `phase6b_VPBS50_KJPTK202608221709_202608221717.xml` | 板橋区 (`1311900`) | `１２０ミリ以上` | 120 mm | 17:00 |
| `phase6b_VPBS50_KJPTK202608221709_202608221727.xml` | 豊島区 (`1311600`) | `約１００ミリ` | 100 mm | 17:20 |

上表は parser 出力を期待値生成に使わず、raw XMLから転記した静的 expected とする。Pi fixture は corpus path、取得日時、EventID、原本識別子、SHA-256を記録する。EventID prefix は summary kind の入力でなく、known fixture の headline を無関係な散文へ置換しても kind／lead／Area／時刻が不変である metamorphic test を置く。逆にVPBS50の kind-bearing Condition／Kind／title種別を未知へ変えたときは raw fallback へ落ちることを固定する。

### 10.2 機械検証: gate

- pure derivation: 既知 exact allowlist、NFKC、VPOA50発表状態の除外、未知、mixed、multi、同義重複、VPBS50／VPOA50取消、headline非依存、`partKind`4値 exact mapping。
- state／protocol: optional field のengine/frontend byte同期、summary null／非object／unknown mode／empty structured／item・facts不正／reconcile旧shapeのruntime guard、headline／areas非欠落、identity／TTL／generation／capacity／reconcile不変。
- component: D1〜D4裁定値、1／3／4／12地域、長い名称、fact 0／1／多数、headline null／改行／長文、1 block infeasible、page footer、全文到達。
- layout: side／center／rotation、pending→確定、page advance、reconcile前後でsolver予約高＝probe高＝live outer高、`fcba058`固定。
- production: 実XML→実parser／processor→実store／hub→加工しないsnapshot／reconcile frame→frontend reduce→`BriefingCard` render の一本鎖。手組み DTO のみでは代用しない。

実装時の全ゲート:

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
npm run test:phase6b-production
```

### 10.3 実機目視（機械検証と分離）

- Pi の実 VPBS50 で、最初の可視ページに定型 lead、裁定済み件数の地域 chip、発表時刻が入り、散文が主役にならない。
- D1=Bなら雨量／降雪 fact の単位・地点・時刻が原文と一致し、headline 由来の誤抽出がない。
- D3=Aなら pager を一巡して raw headline 全文を読め、改行順が原文と一致する。unknown／mixed／取消は裁定にかかわらず raw 本文へ到達できる。
- 地域 chip、`ほかN地域`、page footer、qualifier が重ならず、side／center のいずれも縦横 overflow がない。
- page遷移、pending→確定、VPOA50→VPBS50 reconcile で外枠高・placement・rotation membershipが揺れず、source cardが残らない。
- ticker、OS通知、CLIが現行どおり併存し、同じ電文のcard構造化が通知 cadence やticker TTLへ影響しない。

## §11 本起草タスクの完了条件

文書のみのため build／test は **N/A**。既存コード、fixture、他文書は変更しない。`telegram-foundation.md` 第3縦切りの全12裁定、現行 briefing wire／renderer／pager、VPBS50 4種、synthetic、Phase 6B実6 pairと照合し、裁定待ちは §8 の A/B＋推奨へ限定する。
