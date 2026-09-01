# VPWP50 独立「気象警報予測」カード仕様

- 日付: 2026-08-31
- 状態: ご主人裁定済み・再起草版（C-1 を含む）
- 採用案: 案 A — VPWP50 専用の独立 standby card
- C-1 裁定: 2026-08-31、案 C — semantic key 欠落 projection を破棄し、seen-only tombstone へ移行
- 対象電文: VPWP50（気象警報・注意報時系列情報）
- display protocol kind: `weatherWarningForecast`
- 永続 schema version: v2 を維持する

## 1. 目的

VPWP50 が示す気象警報・注意報級の予測を、standby 画面へ継続表示する。

次を保証する。

- 発表官署＋対象地域を単位とする active state を保持する。
- parser が、系列・地域・Property ごとの全 Significancy occurrence を `tsNum` と絶対時刻 slot 付きで保持する。
- 既存 CLI / ticker 用の worst projection と、standby card 用の全 occurrence projection を分離する。
- card 用 projection を現象・severity 別に集約する。
- 現象名、対象地域、予測時間帯を表示する。
- 最大 severity に応じて既存 weather 系の三色ヘッダを使用する。
- カードタイトルで「予測情報」であることを明示する。
- 取消は該当 subject だけを削除する。
- TimeDefine による予測期間が終了した要素を period 単位で自然失効させる。
- より高い severity の period が終了しても、後続する低い severity の period を失わない。
- unknown code が既知 code と同居しても、unknown occurrence を失わない。
- revision gate を durable 化し、訂正・取消・旧報抑止を再起動後も維持する。
- active watermark と cancellation tombstone の双方を、受理時刻から 7 日で v1 / v2 同時に失効させる。
- active state を永続化し、有効な予測を `restored: true` で復元する。
- 多数の地域・現象を既存 pager によって欠落なく閲覧できるようにする。

CLI の VPWP50 詳細表示、ticker、通知は維持する。独立カードはそれらを置換せず、既存 worst 表示契約も変更しない。

本書では§3をnormative contract、§5をその機械試験、§6を完了確認用indexとする。
同じ要件を巡目別の追補として重ねず、reader / writer / live reducerが共有する不変条件は
§3の一箇所へ集約する。§5 / §6の略記は§3の上限・順序・fail-closed単位を緩和しない。

## 2. 現状

### 2.1 parser と表示用集約

- VPWP50 parser は `src/dmdata/weather-warning-timeseries-parser.ts:851` にある。
- TimeDefine は `src/dmdata/weather-warning-timeseries-parser.ts:774` で解析される。
- 共通 TimeDefine DTO は `src/dmdata/timeseries-common.ts:15` にあり、`dateTime`、`duration`、`name` を保持している。
- 現在の `TimeWindow` は `src/types.ts:1668` にあり、絶対開始・終了時刻を保持しない。
- `pickWorstSignificancyFromCollection()` は `src/dmdata/weather-warning-timeseries-parser.ts:268` で系列・地域・Property ごとの worst 一件だけを `significancyWorst` に残す。
- `flattenEntries()` は `src/engine/presentation/weather-severity-pyramid.ts:81` にあり、`significancyWorst` だけを読む。
- `81_06_01_260605_VPWP50_criteria_period.xml` には L4 の後に L3、L2 が続く列があるが、現行 projection では L4 以外が active card 用入力に残らない。
- `81_03_01_260605_VPWP50_unknown_code.xml` では Code 31 と Code 99 が同じ Property に存在するが、現行 `flattenEntries()` には worst として選ばれない Code 99 が現れない。

したがって、現行 `flattenEntries()` は CLI、ticker、通知、detail cache の worst 表示には利用できるが、severity が時間とともに変化する active card の真実源にはできない。

本仕様では、既存 `significancyWorst` と `flattenEntries()` を互換用に維持し、全 Significancy occurrence を読む card 専用 projection を別に追加する。

### 2.2 route と revision gate

- route は `src/engine/messages/route-catalog.ts:211` に登録されている。
- presentation processor は `src/engine/presentation/processors/process-weather-warning-timeseries.ts:17` にある。
- PresentationEvent への変換は `src/engine/presentation/events/from-weather-warning-timeseries.ts:9` にある。
- `process-message.ts` は `src/engine/presentation/processors/process-message.ts:190` で `gateStandbyOutcome()` を通している。
- 既存 subject は `src/engine/messages/revision-family-registry.ts:338` で次の形式に構成される。

```text
weatherTimeseries:<発表官署>:code:<対象地域コード>
weatherTimeseries:<発表官署>:name:<対象地域名>
weatherTimeseries:<発表官署>:scope:all
```

- revision policy は `src/engine/messages/revision-family-registry.ts:431` にある。
- subject comparator は `reportDateTimeThenSerial`、取消 policy は `clearCurrent` である。
- 現在は同ファイル `:439` で `durable: false` のため、revision watermark と取消 tombstone は再起動で失われる。
- 現在の retention は 36 時間だが、実 VPWP50 fixture には発表から約 67 時間後まで続く TimeDefine がある。active forecast の寿命より gate が先に失効し得る。

### 2.3 現在の出力

- CLI は `src/ui/display-adapter.ts:85` から VPWP50 formatter を呼ぶ。
- ticker sentence は `src/engine/display/ticker-sentence.ts:352` で構築される。
- detail cache は `src/engine/messages/vpwp50-detail-cache.ts:48` にあり、直近一報を `vpwp50-latest.json` へ保存する。
- detail cache は subject 別 active state ではなく、全体で一つの「直近詳細」である。取消、複数官署 scope、予測期間の部分失効を所有できないため、standby card の真実源には使用できない。

### 2.4 standby と frontend

- `StandbyStateStore.applyEvent()` の switch は `src/engine/display/standby-state-store.ts:274` にあるが、`weatherWarningTimeseries` case はない。
- `snapshotItems()` は同ファイル `:1481`、export は `:1600`、restore は `:1658` にあるが、VPWP50 active state は扱わない。
- active standby protocol union は `src/engine/display/protocol.ts:966` にあるが、VPWP50 用 kind はない。
- frontend の認識済み kind は `display/frontend/src/components/StandbyScreen.svelte:87` に固定されている。
- card order は同ファイル `:88` にあり、VPWP50 用 card は登録されていない。
- pager key は `display/frontend/src/lib/legacy-standby/types.ts:6`、scheduler の全 key は `display/frontend/src/lib/legacy-standby/time-slice-scheduler.svelte.ts:11` に固定されている。

したがって、現状の VPWP50 は transient な CLI、ticker、通知と直近 detail cache に限られ、standby 画面には継続表示されない。

## 3. 変更点

### 3.1 名称の設計原則

VPWP50 の表示名称は、電文が直接提供する Property.Type、Significancy、警戒レベル相当、警報・注意報級の区分だけから構成する。

次を必須規律とする。

- 「竜巻注意情報の予測」という名称を使用しない。
- VPWP50 の「雷」は、竜巻注意情報や突風の予測を意味しない。
- 雷 entry は、Significancy が注意報級なら「雷注意報級の予測」等と表示する。
- 雷 entry から「竜巻」「突風」「竜巻注意情報」を推定・補完しない。
- 竜巻注意情報は VPHW50 / VPHW51 と既存 tornado state の責務とする。
- alert-level 系は「土砂災害（警戒レベル4相当）の予測」等、VPWP50 が明示する公式 label を用いる。
- grade 系は「大雨特別警報級の予測」「暴風警報級の予測」「雷注意報級の予測」等とする。
- unknown code は「雷（区分不明）の予測」等とし、警報級・注意報級を推測しない。
- frontend は Property.Type や code から名称を再解釈せず、engine が生成した `forecastLabel` をそのまま描画する。

カードの固定タイトルは次とする。

```text
気象警報予測
```

名称規律の機械検査は、選択した field 名の列挙ではなく、VPWP50 card に属する各 subtree の全 string leaf を再帰収集して行う。

対象 subtree は次とする。

- engine protocol DTO の `weatherWarningForecast` subtree
- pager coordinator の `weatherWarningForecast` record
- preview fixture の `weatherWarningForecast` subtree
- measurement shelf、side / center probe、rotation render に渡す snapshot subtree

object の全 property value と配列要素を再帰走査し、型が `string` の値を全て収集する。`forecastLabel`、title、補助 label 等の既知 field だけを手作業で抽出してはならない。

render 結果では、card root 配下の次を全て収集する。

- 全 text node
- 全 `aria-*` 属性
- `title` 属性
- computed accessible name
- pager footer と coordinator が生成した表示文字列

雷由来の test case では、収集した全文字列のいずれにも次の部分文字列を許さない。

```text
竜巻注意情報
竜巻
突風
```

検査 scope は `weatherWarningForecast` card に限定し、既存 tornado card 等の正当な文字列を混ぜない。

### 3.2 全 Significancy occurrence と絶対時刻 slot

既存 CLI / ticker 用の worst projection と、card 用の全 occurrence projection を分離する。

```ts
interface ForecastTimeSlot {
  tsNum: 1 | 2 | 3;
  series: "3h" | "24h" | "day";
  timeRef: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

interface SignificancyOccurrence {
  info: SignificancyInfo;
  tsNum: 1 | 2 | 3;
  timeRef: string;
  slot: ForecastTimeSlot | null;
  peak?: SignificancyPeakTime;
  criteriaPeriod?: SignificancyCriteriaPeriod;
}

interface WeatherWarningTimeseriesKind {
  // 既存 fields
  significancyWorst?: PartValue<SignificancyValue>;
  significancyOccurrences?: PartValue<SignificancyOccurrence[]>;
}

interface AreaIdentity {
  key: string;
  name: string;
  code: string | null;
}

interface LocalIdentity {
  key: string;
  name: string;
  code: string | null;
}
```

parser は系列、Area / Local、Property ごとに、構文上取得できた全 Significancy を `significancyOccurrences` へ保持する。

- 既知 code、unknown code、注意報未満、解除を含め、worst 選定前の occurrence を欠落させない。
- `significancyWorst` は全 occurrence から従来規則で別途導出し、既存 CLI / ticker / notifier の出力契約を維持する。
- unknown occurrence は既知 occurrence と同じ collection に残し、既存 `unknownCodes` にも従来どおり記録する。
- PeakTime / CriteriaPeriod は同一 `refID` のものだけを occurrence に対応付ける。
- card 用 projection では「一致しなければ先頭要素を流用する」fallback を行わない。

card 専用に `projectForecastOccurrences()` を追加する。

- `flattenEntries()` は既存 worst 用 API として維持し、card reducer から呼ばない。
- `projectForecastOccurrences()` は `significancyOccurrences` を読み、known visible severity と unknown を一件ずつ出力する。
- `none`、`below`、`release` は active card へ出力しない。
- 同じ Property 内で Code 31 と Code 99 が同居する場合、両方を独立 occurrence として出力する。
- Code 21 と Code 22 が同居する場合、同じ `officialL2` でも code と公式 label を保持した独立 occurrence とする。
- L4、L3、L2 が異なる slot にある場合、三つすべてを出力する。

TimeDefine から slot への変換規則は次とする。

1. occurrence の `refID` は同じ `TimeSeriesInfo` 内の TimeDefine だけで解決する。
2. `DateTime` は timezone offset または `Z` 付き ISO 8601 とし、local-time-only は拒否する。
3. `startsAt` は canonical UTC ISO とする。
4. `Duration` は整数の day / hour / minute / second からなる正の elapsed duration だけを許す。year、month、week、符号、小数、空、全成分0は拒否する。
5. `endsAt` は `startsAtMs + durationMs` の canonical UTC ISO とする。
6. 加算結果が safe integer または ECMAScript Date 範囲を外れる場合は不正 slot とする。
7. `endsAtMs > startsAtMs` を必須とする。
8. 同一 series 内の重複 `timeId` は ambiguous とし、その refID を参照する全 occurrence を `slot: null` にする。
9. refID / 参照先欠落、不正 DateTime / Duration の occurrence は `slot: null` のまま DTO に残す。
10. card projection は unresolved occurrence だけを除外し、正常な sibling occurrence を維持する。
11. unresolved 一件を理由に entry、Property、subject 全体を削除しない。
12. unresolved 理由は telegram 単位の bounded diagnostic とする。
13. `TimeDefine.Name` は表示補助だけに使う。
14. `reportDateTime + 固定 TTL` を予測終了時刻の代用にしない。

Area identity は parser 段階で確定する。

```text
normalizedAreaCode =
  Area.Code を trim

normalizedAreaName =
  Area.Name を Unicode NFC 化
  → trim
  → 連続 whitespace を単一 U+0020 へ畳む

areaIdentityKey =
  normalizedAreaCode が nonblank
    ? "code:" + normalizedAreaCode
    : "name:" + normalizedAreaName
```

- `normalizedAreaName` が空なら当該 Area を除外する。
- parser は空 code を直接 map key にせず、`areaIdentityKey` を使用する。
- `WeatherWarningTimeseriesArea` に parser-authoritative な `identityKey` を保持する。
- card projector はこの key を使い、名称 fallback を再生成しない。
- code-less の同じ normalized name は同じ identity とする。
- code-less の異名 Area は別 identity とする。
- code ありと code-less は同名でも別 identity とする。
- 異なる nonblank code は同名でも別 identity とする。
- protocol の `areaCode` は code-less の場合 `null` とする。

Area code-name 対応は一 parsed VPWP50 subject の全 `TimeSeriesInfo`、Property、series を通じて一意でなければならない。

- 同じ `code:<normalizedAreaCode>` と同じ normalized name の duplicate Area は occurrence collection を結合し、完全 duplicate occurrence だけを一件へ畳む。
- 同じ `code:<normalizedAreaCode>` に異なる normalized name が一件でも対応した場合、その Area identity の全 candidateを subject 全体から除外する。
- conflict は Property / series 単位に限定せず、同一 subject 全体で判定する。
- conflict Area に属する base occurrence と全 Local candidate を除外する。
- 正常な別 Area identity、別 subject、他 domain へ波及させない。
- 後勝ち、先勝ち、出現数多数決、最初の series 優先を行わない。
- input 順に依存しない bounded `vpwp50AreaIdentityConflict` diagnostic を一 identity 一回記録する。
- code-less Area は normalized name 自体が identity なので、異なる name 間の code-name conflict 判定対象にはしない。

Significancy `Local` も parser 段階で identity を確定する。raw Local code は次の順で取得する。

1. `Local.Code` text
2. `AreaName` の schema-defined `code` attribute
3. どちらもなければ code-less

両方が nonblank で trim 後の値が異なる場合は ambiguous Local として除外する。

```text
normalizedLocalCode =
  raw Local code を trim

normalizedLocalName =
  Local.AreaName を Unicode NFC 化
  → trim
  → 連続 whitespace を単一 U+0020 へ畳む

localIdentityKey =
  normalizedLocalCode が nonblank
    ? "code:" + normalizedLocalCode
    : "name:" + normalizedLocalName
```

- normalized name が空なら code の有無にかかわらず Local だけを除外し、親 Area の base occurrence へ統合しない。
- `LocalValue` は normalized `areaName`、`code`、`identityKey` を保持する。
- code ありと code-less は同名でも別 identity とする。
- code-less の異名 Local は別 identity とする。
- 同じ親 Area 内で同名・別 code Local は別 identity とする。
- 同じ Local codeでも親 Area identityが異なれば別 target とする。
- Local code-name 対応の conflict scope は、同じ parsed subject と同じ親 `AreaIdentity.key` の全 Property / series とする。
- 同じ親 Area と同じ code identityに異なる normalized name が一件でも対応した場合、その Local identity の全 candidateを subject 全体から除外する。
- 同じ Local codeが別の親 Areaに現れることは conflict としない。
- 同じ identity / normalized name の duplicate Local は occurrence collectionを結合し、完全 duplicate occurrenceだけを一件へ畳む。
- code-less Local は normalized name 自体がidentityなので、異名同士を conflict とせず別 targetにする。
- 後勝ち、Property単位の別名許容、series単位の別名許容を行わない。
- conflict結果はinput順に依存させず、bounded `vpwp50LocalIdentityConflict` diagnosticへ集約する。
- Local conflict は親 Area base、正常な別 Local、別 Area、別 subjectへ波及させない。
- Local identity は Area identity と同じ normalization helper を使用する。

card 用の derived key は、実装ごとに異なる tuple encoding を選ばない。次の一つの
helper で固定する。

```ts
type Vpwp50KeyKind = "group" | "target" | "occurrence" | "period" | "anchor";

function vpwp50StableKey(
  kind: Vpwp50KeyKind,
  components: readonly (string | number | null)[],
): string {
  const canonicalTuple = JSON.stringify([
    "vpwp50-key-v1",
    kind,
    ...components,
  ]);
  return createHash("sha256")
    .update(canonicalTuple, "utf8")
    .digest("base64url");
}
```

- component は正規化済みの `string`、safe integer の `number`、または明示的な
  `null` に限り、`undefined`、object、array、非有限数を渡さない。
- `JSON.stringify()` の対象は上記一次元 array だけであり、object property order に
  依存しない。
- 戻り値は padding なし base64url の SHA-256、すなわち
  `/^[A-Za-z0-9_-]{43}$/` と完全一致する43文字とする。
- key kind は tuple の一要素であり、異なる kind の同じ component 列を同一 key に
  しない。
- reducer、card builder、reader、writer、test fixture はこの helper を共有する。
  別の length-prefixed encoder、hex digest、文字列連結へ差し替えない。
- sanitizer は DTO から再構成できる group、target、period、anchor の tuple を再計算
  して一致を要求する。runtime-only occurrence key は parser / reducer 内だけで使う。
- digest key が同じで canonical tuple が異なる事象を検出した場合は、後勝ちにせず
  当該 subject projection 全体を fail-closed とする。

この固定長 encoding は semantic identity を変えない。64KiB 判定を key encoder の
実装選択に依存させないための wire 表現契約である。

target key は conflict scope と一致する stable tuple とする。

```text
Area target key =
  vpwp50StableKey("target", [
    subjectKey,
    "area",
    parentAreaIdentityKey
  ])

Local target key =
  vpwp50StableKey("target", [
    subjectKey,
    "local",
    parentAreaIdentityKey,
    localIdentityKey
  ])
```

- Area conflict は `parentAreaIdentityKey` 単位、Local conflict は `(parentAreaIdentityKey, localIdentityKey)` 単位で判定する。
- target key は normalized表示名だけから生成しない。
- reducer / sanitizer / writer は同じ式と `vpwp50StableKey()` で target key を再計算する。
- duplicate target key の拒否scopeは、同一`DisplayWeatherWarningForecastGroupV1.targets`配列内とする。
- 同一group内で同じtarget keyが複数ある場合は後勝ちにせず、当該group内の対応identity bundleを除外する。
- subject全体で要求する一意性はtarget key単独ではなく、`(group.key, target.key)`の組とする。
- 雨・風など異なるgroupに同じArea / Local targetが存在し、target keyが同一になることは正常とする。
- 異なるgroup間の同一target keyをduplicateとして除外または統合してはならない。
- multiplicity判定はinput group / target順に依存させない。

`Vpwp50DetailCache` は詳細再表示専用とする。`significancyOccurrences`、Area / Local identity、absolute slot は runtime-only とし、detail cache writer は既存 detail DTO を明示的に組み立て、`vpwp50-latest.json` へ偶発的に保存しない。

### 3.3 active-state reducer

VPWP50 専用 active reducer を追加し、`StandbyStateStore` が所有する。

state map の key は新しく発明せず、既存 `event.standbyStateSubject` をそのまま使用する。

```ts
interface WeatherWarningForecastState {
  subjectKey: string;
  sourceEventId: string;
  publishingOffice: string;
  targetAreaName: string | null;
  targetAreaCode: string | null;
  groups: DisplayWeatherWarningForecastGroupV1[];
  revision: StandbyRevision;
  appliedSemanticKey: string;
  expiresAtMs: number;
  restored: boolean;
}
```

`StandbyStateStore` はgate判定前のread-only protection snapshotとして次を公開する。

```ts
activeWeatherWarningForecastSubjects(nowMs: number): string[];
```

このmethodは次を満たす。

- `expiresAtMs > nowMs`かつ一件以上の有効periodを持つprojectionの`subjectKey`だけを返す。
- 重複除去後の辞書順とする。
- stateをprune、evict、mutateしない。
- callback、generation、persistence予約を発生させない。
- gate判定前に§3.8のadapterから呼ぶ。

`sourceEventId` は次の順序で最初の nonblank かつ§3.9の長さ上限内の値を採用する。

1. parsed VPWP50 / PresentationEvent の EventID
2. parsed telegram meta の message ID
3. `event.id`

trim 後に空文字となる値は採用しない。永続 state と outer `sourceEventIds` に空文字または上限超過文字列を入れてはならない。

通常処理規則は次とする。

1. `event.domain !== "weatherWarningTimeseries"` は処理しない。
2. `standbyStateMutationAccepted !== true` または subject 不明なら active state を変更しない。
3. 取消なら、同じ subject key の state だけを削除する。
4. 発表・訂正では `projectForecastOccurrences(parsed)` を呼ぶ。`flattenEntries()` は呼ばない。
5. 各 occurrence から、`endsAtMs > nowMs` の resolved slot だけを残す。
6. occurrence を §3.4 の group identity で集約する。
7. 同一 group 内では対象地域を parser-authoritative な Area / Local identity で集約し、§3.4 の partition 後 merge 規則で slot を period 化する。
8. full canonical period list に §3.13 の immutable pager anchor を割り当てる。
9. valid period がない新報は、その subject の既存 active state を削除する。
10. 同一 subject の新報・受理済み訂正は、旧 projection 全体を置換する。
11. 他官署または他対象地域の subject は変更しない。
12. `expiresAtMs` は state 内に残る全 period の最大 `endsAtMs` とする。
13. live event から生成した state は `restored: false` とする。
14. state の追加、置換、削除、部分失効は `durableChanged: true` とする。
15. L4 period の終了後も、同じ subject に有効な L3 / L2 period があれば state と card を維持する。
16. known occurrence の終了後も、有効な unknown occurrence があれば unknown group を維持する。

subject数上限はreducer到達前の§3.8 admissionで処理する。

- 新規subjectを追加するとVPWP50 gate familyが513件になる場合、gate mutation前に`capacityExceeded`で拒否する。
- rejected subjectをreducerへ渡さない。
- 既存512 subjectのprojectionまたはgateをevictしない。
- subject 513件目を「gate受理後のprojection failure」へ流してはならない。
- existing subjectのnewer updateは512件時も通常gate判定へ進める。
- admission前expiryでsubjectが511件以下になった場合は、新規subjectを通常判定できる。

gate が既に受理した同一subject candidateは、既存projectionを変更する前に、§3.9のnested schema、card全体period数、wire byte invariantを検証する。

prospective cardは、同一subjectの旧projectionを一時的に除いた他subject群へcandidate projectionを加えて構成する。検査中にruntime mapを変更してはならない。

次のいずれかが上限を超えるcandidateを、切り詰め、部分受理、他subject evictionで救済してはならない。

- subject内group数
- group内target数
- target内period数
- subject内総period数
- 全active subjectを集約したcard内総period数
- pager anchor内period数
- string / nested arrayの個別上限
- canonical `weatherWarningForecast` card itemのUTF-8 JSON byte数

上限は§3.9の定数を使用する。card byte数は最終的なouter item、`sourceEventIds`、全group / target / periodを含むcanonical `ActiveStandbyCardV1`を`JSON.stringify()`し、`Buffer.byteLength(..., "utf8")`で測る。

nestedまたはwire上限超過はgate受理後のfail-closed projection failureとする。

- candidate projection全体を受理しない。
- candidateのgroup / target / periodを一件もruntime stateへ入れない。
- 同subjectの既存projectionがあれば削除する。新gate revisionと古いprojectionをcouplingさせて残さない。
- 正常な別subjectのprojectionをevictまたは縮退しない。
- 既存projectionを削除した場合は`viewChanged: true`、`durableChanged: true`とする。
- 既存projectionがない場合でも、受理済みgate mutationはrollbackせずdurableのまま保持する。
- gateは`cancelled: false`のactive gate-only watermarkとする。
- gate-only watermarkからcard、`RestoredChip`、pager registrationを生成しない。
- aggregate pipeline resultはgate mutationまたはprojection削除を理由に`durableChanged: true`とする。
- count超過は`vpwp50ProjectionCapacityExceeded`、wire byte超過は`vpwp50ProjectionWireBudgetExceeded`をsubject bundleあたり一回記録する。
- diagnosticにはsubject key、超過階層、actual count / bytes、limit、candidate revision、既存projection削除有無を含める。
- 次のgenuinely newerかつ全上限内のreportはactive projectionを再構築できる。
- period expiryによってcard budgetへ空きが生じた後も、既存gateよりnewerなreportだけがprojectionを再構築できる。
- runtime invariantがこの経路以外から破られた場合、writerは§3.9の規則でfail-loudとする。

gate が受理した後に `sourceEventId` または `event.standbyAppliedSemanticKey` を解決できない場合も no-op にしない。

- 既存 subject projection があれば削除する。
- 削除時は `viewChanged: true`、`durableChanged: true` とする。
- 既存 projection がなければ store mutation は false でよいが、受理済み gate mutationは durable のまま保持する。
- gate decision を rollback しない。
- active gate watermark は、当該報より古い VPWP50 の復活防止に使用する。
- gate-only watermark から card を生成しない。
- source ID 欠落または上限超過は `vpwp50MissingSourceEventId`、semantic key 欠落は `vpwp50MissingAppliedSemanticKey` として bounded diagnostic を残す。
- gate mutation または projection 削除のいずれかが成立した場合、最新の gate-only canonical state を保存する。
- 次の正常な newer report は active projection を再構築できる。

source ID、semantic key、nested capacity の失敗分岐でも、既存 projection と最新 gate の revision / semantic coupling が食い違う状態を残してはならない。

target identityには表示名だけでなくparser-authoritativeなArea / Local identityを残す。

- Area target keyはsubject key、`"area"`、親Area identityのstable tupleとする。
- Local target keyはsubject key、`"local"`、親Area identity、Local identityのstable tupleとする。
- codeありAreaは`code:<normalizedAreaCode>`。
- code-less Areaは`name:<normalizedAreaName>`。
- codeありLocalは`code:<normalizedLocalCode>`。
- code-less Localは`name:<normalizedLocalName>`。
- 同名・別codeのAreaまたはLocalを統合しない。
- 同じLocal codeでも親Areaが異なれば統合しない。
- Localを親Areaのbase targetへ暗黙統合しない。

### 3.4 現象・severity 別集約と slot → period 変換

protocol projection は次の形とする。

```ts
type DisplayWeatherWarningForecastSeriesV1 = "3h" | "24h" | "day";

interface DisplayWeatherWarningForecastPeriodV1 {
  key: string;
  tsNum: 1 | 2 | 3;
  series: DisplayWeatherWarningForecastSeriesV1;
  startsAt: string;
  endsAt: string;
  label: string;
  pagerAnchorKey: string;
  pagerAnchorOrdinal: number;
  pagerSlot: 0 | 1 | 2 | 3;
}

interface DisplayWeatherWarningForecastTargetV1 {
  key: string;
  scope: "area" | "local";
  name: string;
  parentAreaName: string;
  areaCode: string | null;
  localCode: string | null;
  periods: DisplayWeatherWarningForecastPeriodV1[];
}

interface DisplayWeatherWarningForecastGroupV1 {
  key: string;
  phenomenonName: string;
  significancyCode: string;
  forecastLabel: string;
  displaySeverity: DisplaySeverity;
  severity: StandbySeverity;
  targets: DisplayWeatherWarningForecastTargetV1[];
}

interface DisplayWeatherWarningForecastCardDataV1 {
  groups: DisplayWeatherWarningForecastGroupV1[];
}
```

target fieldは次をauthoritativeとする。

- `scope: "area"`では`name === parentAreaName`、`localCode === null`。
- `scope: "local"`では`name`がnormalized Local name、`parentAreaName`がnormalized親Area name。
- `areaCode`は親Areaのnormalized code。code-lessなら`null`。
- `localCode`はLocalのnormalized code。code-less Localなら`null`。
- target keyはこれらのfieldとsubject keyから§3.3の式で再計算できなければならない。
- frontendはtarget keyまたはcodeから表示名を再生成しない。

`phenomenonName` は表示用翻訳値ではなく、parser が保持した raw `Property.Type` の canonical 値そのものとする。

```text
phenomenonName === normalizePropertyType(raw Property.Type)
propertyType    === phenomenonName
```

`normalizePropertyType` は parser で既に行う XML text の Unicode NFC、trim、連続whitespace normalizationだけとする。別名、短縮名、localized label、severity 由来名称へ置換しない。

- live group identity の `propertyType` と persisted DTO の `phenomenonName` は同じ authoritative string とする。
- group key の再計算には `phenomenonName` を使用する。
- frontend は `phenomenonName` を別の property type へ変換しない。
- 将来表示名を変更する場合は別 display-only field を追加し、`phenomenonName` を identity field から転用しない。

engine側に完全なlabel生成関数を一つだけ置く。

```ts
function vpwp50ForecastLabel(
  phenomenonName: string,
  significancy: SignificancyInfo,
): string | null
```

生成規則は次とする。

```text
baseName =
  normalizeKindName(phenomenonName, "below")

grade label =
  normalizeKindName(phenomenonName, significancy.severity)
  + "級の予測"

alert-level label =
  baseName
  + "（"
  + significancy.label
  + "）の予測"

unknown label =
  baseName
  + "（区分不明）の予測"
```

分岐を次に固定する。

- `family === "grade"`かつseverityが`advisory | warning | special`ならgrade label。
- `family === "alertLevel"`かつknown visible codeならalert-level label。
- `family === "unknown"`またはunknown codeならunknown label。
- severityが`none | below`、release相当、またはvisibleでない場合は`null`。
- unknown codeから注意報級、警報級、警戒レベルを推測しない。
- raw「雨」は既存`KIND_NAME_MAP`によりbase「大雨」とする。
- raw「雪」はbase「大雪」、raw「波」はbase「波浪」とする。
- raw「風」はseverityに応じて既存overrideの「強風注意報」「暴風警報」「暴風特別警報」を使用する。
- raw「雷」＋Code 20は「雷注意報級の予測」とする。
- `significancy.label`はalert-level系だけに使用し、Code 21「警戒レベル2」とCode 22「警戒レベル2相当」を区別する。
- frontend、pager、previewは`forecastLabel`を再生成または短縮しない。

静的代表値は次とする。

| phenomenonName | code | family | forecastLabel |
|---|---:|---|---|
| `雨` | 20 | grade | `大雨注意報級の予測` |
| `雨` | 30 | grade | `大雨警報級の予測` |
| `雨` | 50 | grade | `大雨特別警報級の予測` |
| `風` | 20 | grade | `強風注意報級の予測` |
| `風` | 30 | grade | `暴風警報級の予測` |
| `風` | 50 | grade | `暴風特別警報級の予測` |
| `雷` | 20 | grade | `雷注意報級の予測` |
| `土砂災害危険度` | 21 | alertLevel | `土砂災害（警戒レベル2）の予測` |
| `土砂災害危険度` | 22 | alertLevel | `土砂災害（警戒レベル2相当）の予測` |
| `土砂災害危険度` | 31 | alertLevel | `土砂災害（警戒レベル3相当）の予測` |
| `高潮危険度` | 41 | alertLevel | `高潮（警戒レベル4相当）の予測` |
| `土砂災害危険度` | 51 | alertLevel | `土砂災害（警戒レベル5相当）の予測` |
| `雷` | 99 | unknown | `雷（区分不明）の予測` |

group identity は次の tuple とする。

```text
vpwp50StableKey("group", [
  phenomenonName,
  significancyCode,
  forecastLabel,
  displaySeverity
])
```

group key はこの tuple の43文字 digest とし、別 encoding を選ばない。

- `significancyCode` は occurrence が保持する raw code の trim 後 nonblank 値とする。
- known code の `forecastLabel` は `vpwp50ForecastLabel()` の結果と完全一致させる。
- Code 21「警戒レベル2」と Code 22「警戒レベル2相当」は同じ `officialL2` でも別 group とする。
- unknown code も raw code ごとに別 group とする。
- `displaySeverity` だけが同じ occurrence を同一 group に畳まない。
- frontend は group code または severity から label を再生成しない。
- sanitizer / writerは`phenomenonName`と`significancyCode`からSignificancy registryを引き、`forecastLabel`を再計算して完全一致を検証する。

target identity は次とする。

- Area targetはparserのArea identityを使用する。
- Local targetは親Area identity＋parserのLocal identityを使用する。
- subject keyはcard全体を横断した衝突防止prefixとしてtarget keyに含める。
- code-less fallbackはparserが作ったidentity keyを使用し、reducerで名称mapを作り直さない。
- 同一group内のduplicate target keyは後勝ちにせず、対応identity bundleを除外する。
- 異なるgroupでは同じtarget keyを持つことを許可し、`(group.key, target.key)`をsubject内の一意な組とする。
- 同じArea targetが雨・風など複数groupに現れる正常系を、一方のgroupだけへ統合または除外しない。

occurrence key は runtime-only とし、次の組から `vpwp50StableKey("occurrence", …)`
で生成する。

```text
subject key、target key、phenomenonName、Significancy code、forecastLabel、
displaySeverity、tsNum、series、timeRef、startsAt、endsAt
```

`timeRef` の長さ・形式検査は parser / occurrence projection 段階で完了させる。
occurrence key、`timeRef`、構成 occurrence 一覧は protocol period DTO と persistence
へ保存しない。結合後の一 period は複数 `timeRef` 由来になり得るため、単一
`timeRef` を period へ暗黙追加してはならない。

period 化は target 内で最初に次の identity へ partition する。

```text
tsNum
+ series
+ significancyCode
+ forecastLabel
+ displaySeverity
```

各 partition の中だけで sort、duplicate 除去、区間結合を行う。

1. occurrence を `startsAtMs`、`endsAtMs`、numeric-aware `timeRef`、occurrence key の順に安定整列する。
2. occurrence key と時間範囲が完全一致する duplicate は一件へ畳む。
3. `next.startsAtMs > current.endsAtMs` は gap とし、別 period にする。
4. `next.startsAtMs === current.endsAtMs` は接続とし、一つの period へ結合する。
5. `next.startsAtMs < current.endsAtMs` は overlap とし、区間の和集合へ結合する。
6. partition identity が異なる occurrence は、時刻順で間に挟まっていても現在 partition の merge を中断しない。
7. A `[0,10]`、B `[1,2]`、A `[2,12]` は、先に A / B へ partition し、A を `[0,12]` へ結合してから B と並べる。
8. `timeRef` の数値差や TimeDefine.Name を gap / connection 判定に使用しない。
9. 異なる `tsNum` または series は、絶対時刻、code、label、severity が一致しても結合しない。
10. partition ごとの merge 完了後、全 period を開始時刻、終了時刻、`tsNum`、series、key の順に安定整列する。
11. target は `scope`、areaCode、localCode、target key、名称の順に並べる。
12. group は severity 降順、`phenomenonName`、Significancy code の numeric-aware 順、`forecastLabel`、group key の順に並べる。

period key は persistence から再計算できる次の tuple だけで生成する。

```text
vpwp50StableKey("period", [
  group.key,
  target.key,
  tsNum,
  series,
  startsAt,
  endsAt
])
```

構成 occurrence key と `timeRef` は period key に含めない。これらは merge 入力の
dedup / canonical sort にだけ使い、結合後 DTO には一意な単一値がないためである。
`label` と pager anchor field も period key に含めない。sanitizer / writer は上記
persisted field から period key を再計算し、完全一致を要求する。

full projection の accepted replacement 時に、各 `(group, target)` の全 period を canonical 順に並べ、immutable pager anchor を一度だけ割り当てる。

```text
pagerAnchorOrdinal = floor(initialPeriodOrdinal / 4)
pagerSlot          = initialPeriodOrdinal % 4
pagerAnchorKey     = vpwp50StableKey("anchor", [
  subjectKey,
  revision.reportTimeMs,
  normalized revision serial,
  group.key,
  target.key,
  pagerAnchorOrdinal
])
```

anchor tupleの`normalized revision serial`は、§3.10と同じnormalizerによるcanonical
decimal string、serial missingなら`null`とする。空文字と`null`を別keyにせず、raw
`"01"`と`"1"`も同じnumeric 1へ正規化する。invalid serialのprojectionは生成しない。

anchor 規則は次とする。

- `initialPeriodOrdinal` は accepted report の full canonical period list 上の 0-based ordinal とする。
- 同一 accepted projection generation 内では、period expiry や unknown / known group の部分失効によって anchor を再計算しない。
- 先頭 period が失効しても、同じ anchor に属する後続 period の `pagerAnchorKey`、`pagerAnchorOrdinal`、`pagerSlot` を維持する。
- 一 anchor の全 period が失効した場合だけ、その atom を削除する。
- 先行 anchor が空になっても、後続 anchor の ordinal と identity を詰め直さない。
- genuinely newer な accepted report が projection 全体を置換した場合は、新 revision を含む式で anchor を再計算してよい。
- export / restore は anchor field をそのまま保持し、restore 時に残存 period の先頭から chunk を作り直さない。
- sanitizer / writer は outer subject revision と group / target / ordinal から `pagerAnchorKey` を再計算して一致を検証する。
- `pagerSlot` に 0 からの連続性は要求しない。先行 period expiry 後の gap は schema-valid とする。
- 同じ target 内で `(pagerAnchorOrdinal, pagerSlot)` は一意でなければならない。
- 一 anchor に属する retained period は最大4件とする。

period の canonical timezone 規則は次とする。

- `startsAt` / `endsAt` は canonical UTC ISO を保持する。
- 表示 `label` は engine が `Asia/Tokyo` 固定で生成する。
- process locale、host timezone、frontend browser timezone を使用しない。
- frontend は timestamp から label を再計算しない。
- 時刻は24時間制、`HH:mm` のゼロ埋めとする。
- 月日には先頭ゼロを付けない。
- 区切りは U+2013 EN DASH `–` とする。

| JST 上の範囲 | label |
|---|---|
| 同日 | `M月D日 HH:mm–HH:mm` |
| 日または月を跨ぐが同年 | `M月D日 HH:mm–M月D日 HH:mm` |
| 年を跨ぐ | `YYYY年M月D日 HH:mm–YYYY年M月D日 HH:mm` |

同一 instant を `Z` と `+09:00` で入力した場合、canonical period と JST label は同一でなければならない。

各表示 atom は、少なくとも現象名、対象地域、予測時間帯を一組で表示する。複数 series は「3時間」「24時間」「日単位」を既存 VPWP50 の表現に合わせて区別する。

### 3.5 severity とヘッダ

group の `severity` は engine で確定し、frontend で文字列から再判定しない。

- critical: `officialL5`、`officialL4`、`nonLevelSpecial`
- warning: `officialL3`、`nonLevelWarning`
- normal: `officialL2`、`nonLevelAdvisory`、`officialL1`
- unknown: 既存 VPWP50 の見落とし防止契約に合わせ、card severity は最低 warning とする
- `release`: active group に含めない

outer card の severity は、全 active subject・全 group の最大値とする。

ヘッダは最大 severity に応じて既存 weather token を使う。

| 最大 severity | 使用する既存 token |
|---|---|
| critical | `--header-weatherEmergency-*` |
| warning | `--header-weatherWarning-*` |
| normal / info | `--header-weatherAdvisory-*` |

新しい色、独自グラデーション、独自ヘッダ帯は追加しない。

### 3.6 protocol kind

`ActiveStandbyCardV1` に次を追加する。

```ts
ActiveStandbyBaseV1 & {
  kind: "weatherWarningForecast";
  surface: "corner-right";
  data: DisplayWeatherWarningForecastCardDataV1;
}
```

outer card の契約は次とする。

- `key`: `weatherWarningForecast:active`
- `sourceEventIds`: 全 active subject の nonblank `sourceEventId` を重複除去し、code-point 昇順へ安定整列した配列
- `updatedAt`: active state の revision 時刻の最大
- `expiresAt`: 全 period の `endsAt` の最大
- `restored`: active state に `restored: true` が一件以上あれば true
- `severity`: 全 group の最大 severity
- `data.groups`: 全 subject を横断して集約した表示 group

EventID が空の実 VPWP50ではmessage IDまたは`event.id` fallbackが`sourceEventIds`に入る。空文字、空白だけの文字列、重複ID、入力順に依存する並びを許さない。

`weatherWarningForecast` cardは次のwire invariantを必須とする。

- 全active subjectを横断したperiod総数は128件以下。
- canonical card itemのUTF-8 JSON byte数は64KiB以下。
- countとbyteの両方を満たす場合だけwire-validとする。
- 128 periodであっても64KiBを超える組合せはwire-invalidとする。
- 64KiB以内でも129 periodはwire-invalidとする。
- gate-only watermark / tombstoneはcard itemへ入らないためperiod / card byte集計対象外とする。
- `MAX_SNAPSHOT_BYTES`は既存の256KiBを維持する。
- 64KiBはsnapshot上限の4分の1とし、既存の他card、snapshot envelope、SSE framing用のheadroomを確保する。
- `standbyItems`を縮退しない現行`degradeSnapshotToBudget()`へ、VPWP50 projectionの救済を委ねてはならない。
- wire-invalid projectionはserver送信時ではなく、reducer / reader / writerの共通invariantで除外する。
- 最大wire-valid fixtureを含む`type: "snapshot"`と`type: "state"`の双方が`encodeSseGuarded()`を通過しなければならない。

`DISPLAY_PROTOCOL_VERSION`は1のままとし、additiveな新kindとする。engine / frontendのprotocol同期区間は同時に更新する。

### 3.7 standby-state-store の新規 case

`StandbyStateStore.applyEvent()` に `weatherWarningTimeseries` case を追加する。

併せて次を行う。

- mutation acceptance guard の対象へ `weatherWarningTimeseries` を追加する。
- reducer へ PresentationEvent と `nowMs` を渡す。
- `managedStandbySubjects` の reconcile が `weatherTimeseries:` subject を削除できるようにする。
- `snapshotItems()` へ `weatherWarningForecast` card を追加する。
- `sweep()` で period 単位の期限切れを除外する。
- 一部 period だけが期限切れた場合も group / target / state を再構成する。
- 最後の period が期限切れた subject を削除する。
- export / restore を active reducer と接続する。
- restore 時に期限切れ period を除外し、残った state を `restored: true` にする。

取消 card は作らない。取消 event は subject state の即時削除だけを行い、取消通知・ticker は既存経路に任せる。

### 3.8 revision gate の durable 化と active retention

`WEATHER_TIMESERIES_REVISION_FAMILY_POLICY` を次のように変更する。

- `durable: true`
- `cancellationPolicy: "clearCurrent"` を維持
- `maxSubjects: 512` を維持
- cancellation tombstone retention を7日とする
- active watermark も acceptedAt 起点の7日で明示的に失効させる
- admission 直前の active retention expiry を有効にする
- family capacity modeを新規subject fail-closedとする
- VPWP50 familyではcapacity victim evictionを行わない

```ts
export const WEATHER_TIMESERIES_RETENTION_MS =
  7 * 24 * 60 * 60_000;
```

policy には次の明示 field を持たせる。

```ts
activeRetentionMs: WEATHER_TIMESERIES_RETENTION_MS
familyCapacityMode: "rejectNewSubject"
```

通常の `TelegramRevisionGate` sweep は durable active watermark を削除しないため、policy の `durable: true` と `tombstoneRetentionMs` だけで active retention を満たしたことにしてはならない。

VPWP50 は既存の `expireRevisionFamily()` と同じ `>` 境界を使い、次の三経路で期限処理する。

1. VPWP50 gate 判定の直前
2. 起動時、`standbyDomains.gateEntries` restore 直後かつ projection coupling restore より前
3. monitor 所有の60秒 `sweepStandbyFoundation(nowMs)` 内

gate判定直前の処理順を次に固定する。

1. `parsed.meta.receivedAtMs` を admission の `nowMs` とする。
2. subject extractorでsubject形式と§3.9の文字列上限を検証する。
3. `processStandbyFoundation()` が `revisionGate.decide()` を呼ぶ前に、VPWP50 family の `expireRevisionFamily()` 相当を実行する。
4. expiry で削除した subject key と `changed` を bounded result として取得する。
5. expired subject に対応する active projection を削除する。
6. projection cleanup と gate expiry を一つの pre-admission durable mutation に束ねる。
7. expiry後のgate family subject集合をread-onlyで取得する。
8. `activeWeatherWarningForecastSubjects(nowMs)`を取得し、`activeFamilySubjects`としてgateへ供給する。
9. incoming subjectが既存family subjectでなく、expiry後のfamily subject数が512件なら、gate stateをmutateする前に`capacityExceeded`で拒否する。
10. 前項以外では、active protection集合と`familyCapacityMode: "rejectNewSubject"`を付けて`decide()`を実行する。
11. incoming report が accepted、suppressed、invalid、capacity rejected のいずれでも、pre-admission expiry mutation を失わない。
12. pre-admission expiry、incoming gate mutation、projection mutation を受信処理の最後に一回の persistence 予約へ合流する。

expiry API は少なくとも次を返せる契約とする。

```ts
interface RevisionFamilyExpiryResult {
  changed: boolean;
  expiredStateSubjectKeys: string[];
}
```

capacity preflight用にgateはVPWP50 familyのcurrent subject keyをread-onlyで返せなければならない。

```ts
revisionFamilySubjectKeys(
  domain: string,
  revisionFamily: string,
): string[];
```

このAPIはstateをprune、compact、evictしてはならない。

subject capacity規則を次に固定する。

- family subject 上限512は active pair、active gate-only watermark、tombstone-only bundleを合算した gate bundle 上限である。
- card period上限が128であり、active projectionは最低一件のperiodを持つため、wire-validなactive pair数は最大128件である。
- 512 gate bundleすべてがactive pairになる状態はschema-validではない。
- 511件以下で新規subjectを受理できる。
- 512件目を受理できる。
- 512件存在する状態で513件目となる新規subjectは`capacityExceeded`。
- 513件目ではgate entry、projection、gate-only watermark、tombstoneを生成しない。
- 既存512件からvictimを選ばない。
- `evictedStateSubjectKey`、`cardEvictedKey`、managed-subject deletion経路をVPWP50 admissionに作らない。
- capacity preflightはactive projection providerの件数ではなく、expiry後のgate family subject key総数を使用する。
- `activeWeatherWarningForecastSubjects(nowMs)`はwire-valid active projection subjectだけを返し、gate-only / tombstone-only subjectを含めない。
- 既存subjectのnewer updateまたはvalid cancellationは512件時も通常判定する。
- 既存subject updateがprospective card上限を超えた場合は、gate受理後のprojection fail-closed規則を適用する。
- admission前expiryで一件消えた場合、そのcall内で新規subjectを受理できる。
- capacity rejection単独ではdurable mutationまたは保存予約を生成しない。
- 同callでpre-admission expiryがあれば、そのexpiry分だけはdurable mutationとして保存する。
- capacity rejectionでは`Vpwp50DetailCache`、notification holder相当、standby reducerを更新しない。
- `vpwp50SubjectCapacityExceeded`をboundedに記録し、subject、actual 512、limit 512、incoming revisionを含める。

`ProcessDeps` / router callback は、incoming decision が rejected でも pre-admission expiry result を monitor へ伝える。`onStandbyRevisionDecision` の `decision.accepted` だけを persistence 条件にして expiry を捨ててはならない。

retention 境界は次とする。

- `nowMs - acceptedAtMs <= 7日` は保持する。
- `nowMs - acceptedAtMs > 7日` で削除する。
- `acceptedAtMs + 7日` に残る。
- `acceptedAtMs + 7日 + 1ms` で消える。

したがって、60秒 timer がまだ発火していなくても、境界後に到着した電文は期限切れ watermark / tombstone によって拒否されない。他の revision validation、subject validation、capacity validation による拒否は従来どおりである。

起動時 expiry、60秒 sweep、admission 前 expiry のいずれでも gate が変化した場合、foundation durable mutationとして現在stateの保存を予約する。同じ処理内でactive projectionのperiod expiryまたはincoming replacementが起きても、保存予約は一回へまとめる。

gate expiry 後も対応する active projection が残る異常状態では、その subject projection を削除して `vpwp50ActiveBeyondGateRetention` 診断を残す。

v1 rollback の `seen.forgetAtMs` は次で生成し、v2 の `>` 境界と一致させる。

```text
forgetAtMs =
  acceptedAtMs
  + WEATHER_TIMESERIES_RETENTION_MS
  + 1
```

monitor の `standbyDomains.gateEntries` export filter に `weatherWarningTimeseries` を追加する。

新規 live VPWP50 projectionでは、`standbyAppliedSemanticKey` を nonblank 必須値として保存し、v2 load 時に次を照合する。

- subject key
- revision の reportDateTime / normalized serial
- gate の最新 semantic key
- gate が cancellation 状態でないこと

照合できない projection は表示せず、domain-local repair とする。active projection が消えた後も、有効期限内の active watermark または cancellation tombstone は旧報抑止のため保持してよい。

### 3.9 persistence schema と domain-local salvage

既存 standby persistence envelope に、projection と v1 rollback gate metadata 用の optional field を追加する。

```ts
interface PersistedWeatherWarningForecastStateV1 {
  subjectKey: string;
  sourceEventId: string;
  publishingOffice: string;
  targetAreaName: string | null;
  targetAreaCode: string | null;
  groups: DisplayWeatherWarningForecastGroupV1[];
  revision: StandbyRevision;
  appliedSemanticKey: string;
  expiresAtMs: number;
}

interface PersistedWeatherWarningForecastGateMetadataV1 {
  stateSubjectKey: string;
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: string[];
  cancelled: boolean;
}

interface PersistedStandbyStateV1 {
  // 既存 fields
  weatherWarningForecasts?: PersistedWeatherWarningForecastStateV1[];
  weatherWarningForecastGateMetadata?: PersistedWeatherWarningForecastGateMetadataV1[];
}
```

- `PERSIST_SCHEMA_VERSION` は v2 のままとする。
- v2 は optional projection と `standbyDomains` の gate entry を canonical state とする。
- standalone v1 rollback file には `weatherWarningForecasts`、`seen`、`weatherWarningForecastGateMetadata` を意味的に一致させて書く。
- v2 root に存在する metadata は rollback mirror であり、正常な v2 canonical gate より authoritative にしない。
- active projection が空なら `weatherWarningForecasts` を省略する。
- VPWP50 gate が空なら `weatherWarningForecastGateMetadata` を省略する。
- projection のない active gate-only watermark と tombstone-only state でも、gate が存在する限り v1 metadata を省略しない。
- `restored` は保存せず、restore 時に設定する。
- raw XML、runtime occurrence collection、TimeDefine、parser diagnostics は保存しない。
- projection は subject / group / target / period の canonical 順、metadata は `stateSubjectKey` 順で保存する。

新規 writer と v2 sanitizer は projection の `appliedSemanticKey` に次の canonical form を要求する。

```text
^(発表|訂正):[0-9a-f]{64}$
```

v1 gate metadata の nonempty `semanticKeys` は次の canonical formを要求する。

```text
^(発表|訂正|取消):[0-9a-f]{64}$
```

- projection の key を `compactPersistedSemanticKeys()` で片側だけ修復してはならない。
- projection と gate metadata / gate entry の双方が同じ canonical key を保持しなければならない。
- non-canonical projection key は subject projection を除外する。
- v2 gate が正常なら、projection 除外後も active gate-only watermarkとして残してよい。
- writer runtime state に non-canonical projection key があれば fail-loud とする。

容量・文字列・wire上限を次に固定する。

```ts
WEATHER_WARNING_FORECAST_MAX_SUBJECTS = 512
WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT = 128
WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP = 128
WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET = 128
WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT = 128
WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD = 128
WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM = 4
WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES = 64 * 1024

WEATHER_WARNING_FORECAST_READER_MAX_RAW_PROJECTION_ITEMS = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_METADATA_ITEMS = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_SEEN_ITEMS = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_V2_GATE_ITEMS = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_BUNDLES = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_GROUP_ITEMS_PER_SUBJECT = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_TARGET_ITEMS_PER_GROUP = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_TARGET_ITEMS_PER_SUBJECT = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_PERIOD_ITEMS_PER_TARGET = 1_024
WEATHER_WARNING_FORECAST_READER_MAX_RAW_PERIOD_ITEMS_PER_SUBJECT = 1_024

STANDBY_PERSISTENCE_READER_MAX_RAW_SHARED_SEEN_ITEMS =
  TELEGRAM_REVISION_MAX_ENTRIES // 16_384
STANDBY_PERSISTENCE_READER_MAX_RAW_STANDBY_DOMAIN_GATE_ITEMS =
  TELEGRAM_REVISION_MAX_ENTRIES // 16_384

VPWP50_MAX_SOURCE_EVENT_ID_LENGTH = 256
VPWP50_MAX_SUBJECT_KEY_LENGTH = 1_024
VPWP50_MAX_PUBLISHING_OFFICE_LENGTH = 256
VPWP50_MAX_AREA_NAME_LENGTH = 256
VPWP50_MAX_AREA_CODE_LENGTH = 64
VPWP50_MAX_LOCAL_NAME_LENGTH = 256
VPWP50_MAX_LOCAL_CODE_LENGTH = 64
VPWP50_MAX_PHENOMENON_NAME_LENGTH = 128
VPWP50_MAX_SIGNIFICANCY_CODE_LENGTH = 32
VPWP50_MAX_FORECAST_LABEL_LENGTH = 256
VPWP50_MAX_TIME_REF_LENGTH = 64
VPWP50_MAX_TIME_NAME_LENGTH = 128
VPWP50_MAX_IDENTITY_KEY_LENGTH = 1_024
VPWP50_DERIVED_KEY_LENGTH = 43

TELEGRAM_REVISION_MAX_SEMANTIC_KEYS = 32
VPWP50_REPORT_FUTURE_SKEW_MS = 15 * 60_000
VPWP50_ACCEPTED_AT_FUTURE_SKEW_MS = 15 * 60_000
```

`WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT`は従来案の16,384から128へ引き下げる。`WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP`も、nonempty targetが最低一件のperiodを消費するcanonical invariantに合わせ、512から128へ引き下げる。

各canonical unitはnonemptyでなければならない。

- subjectは一件以上のgroupを持つ。
- groupは一件以上のtargetを持つ。
- targetは一件以上のperiodを持つ。
- 空になったtarget、group、subjectはcanonical stateへ残さない。

したがって、有効上限は一つの階層定数だけではなく、次の全制約の最小値とする。

```text
effective admissible count =
  min(
    current hierarchy limit,
    remaining subject period budget,
    remaining card period budget,
    maximum count fitting the remaining 64KiB card byte budget
  )
```

具体的には次となる。

- 一subjectのgroup数は最大128だが、各groupが最低一periodを必要とするため、subject / cardの残period予算が128未満ならその値が実効上限となる。
- 一groupのtarget数は最大128だが、各targetが最低一periodを必要とするため、subject / cardの残period予算が実効上限をさらに狭める。
- 一targetのperiod数は、target、subject、cardの各period上限と残予算の最小値とする。
- 全active subjectのperiod総数は128以下とする。
- family gate bundleは512件まで保持できるが、wire-valid active pairはperiod総数により最大128件となる。
- 64KiB byte上限がcount上限より先に到達する場合は、byte上限を実効上限とする。
- `limit`受理試験は、他の階層上限、card period上限、byte上限をすべて満たす生成可能なfixtureでだけ成立させる。
- ある階層の宣言上限だけを満たし、上位period / byte予算を超えるfixtureを「limit受理」としてはならない。

長さ尺度はJavaScriptの`string.length`、すなわちUTF-16 code unit数とする。wire byte数は次の共通pure helperで測る。

```ts
function weatherWarningForecastCardJsonBytes(
  item: Extract<ActiveStandbyCardV1, {
    kind: "weatherWarningForecast";
  }>,
): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}
```

- name、office、phenomenonはUnicode NFC、trim、連続whitespace normalization後に測る。
- code、source ID、subject、semantic key、各stable keyはtrim後に測る。
- group / target / occurrence / period / pager anchor key は「上限以内」ではなく、
  `vpwp50StableKey()` が返す43文字のbase64url canonical formとの完全一致を要求する。
- `VPWP50_MAX_TIME_REF_LENGTH`と`VPWP50_MAX_TIME_NAME_LENGTH`はparser / runtime
  occurrence用であり、persisted period sanitizerのfield要件ではない。
- normalization前に切り詰めて上限へ合わせてはならない。
- 上限超過stringをhash、substring、省略表示でschema-validに見せてはならない。
- count上限とwire byte上限はAND条件とし、各string上限のCartesian productをwire-validとはみなさない。
- live reducerはprospective active mapからcardを構成し、各階層の実効上限、period総数、card byte数をmutation前に検査する。
- readerはvalid active pairをgate `acceptedAtMs`降順、subject key昇順で処理し、prospective cardが全count上限とbyte上限を満たすprojectionだけを保持する。
- readerでcard上限へ入らないactive pairはprojectionだけを除外し、valid gateをactive gate-only watermarkとして保持する。
- readerは一件を除外した後も後続の小さいprojectionを検討し、結果をinput順に依存させない。
- writerは全runtime projectionを集約したcardが全count上限とbyte上限を満たすことを確認し、違反時はsalvageせずfail-loudとする。
- live reducer、export、writer、v2 sanitizer、v1 migration、restoreは同じcount定数、実効上限helper、byte helperを使用する。
- nested string / count / wire上限超過は§3.3のprojection fail-closedとする。
- subject key上限超過はgate mutation前に拒否する。
- writerで上限違反を検出した場合は正常fileを置換しない。
- `MAX_SNAPSHOT_BYTES`またはHTTP serverの縮退ラダーを変更しない。

count / wire の複合違反では、最初に見つけた一理由だけを記録してはならない。candidateを変更する前に全制約を評価し、成立した全違反種別を一つのbounded diagnosticへcanonical順で格納する。

```ts
type Vpwp50ProjectionLimitReasonCode =
  | "groupsPerSubject"
  | "targetsPerGroup"
  | "periodsPerTarget"
  | "periodsPerAnchor"
  | "periodsPerSubject"
  | "periodsPerCard"
  | "cardJsonBytes";

interface Vpwp50ProjectionLimitReason {
  code: Vpwp50ProjectionLimitReasonCode;
  actual: number;
  declaredLimit: number;
  effectiveLimit: number | null;
  violatingUnitCount: number;
  limitingHierarchies: readonly Vpwp50ProjectionLimitReasonCode[];
  samplePaths: readonly string[];
}

interface Vpwp50ProjectionLimitDiagnostic {
  subjectKey: string;
  candidateRevision: StandbyRevision;
  existingProjectionDeleted: boolean;
  reasons: readonly Vpwp50ProjectionLimitReason[];
}
```

`reasons` のcanonical順は次とする。

1. `groupsPerSubject`
2. `targetsPerGroup`
3. `periodsPerTarget`
4. `periodsPerAnchor`
5. `periodsPerSubject`
6. `periodsPerCard`
7. `cardJsonBytes`

追加規則は次とする。

- 同じreason codeは一entryへ集約する。
- local unit型では`actual`を違反unit中の最大値、`violatingUnitCount`を違反unit総数とする。
- count reasonごとに、original candidateでそのreasonに違反するunitの集合を
  `U_code`とする。local reason（`targetsPerGroup`、`periodsPerTarget`、
  `periodsPerAnchor`）では全違反group / target / anchorを含め、
  subject / card reasonでは当該candidateのsubject / card unitを一件だけ含める。
  `U_code`はcanonical escaped path昇順で確定し、診断計算中にunitを一件ずつ除外
  したり、先に縮めたunitを集合から外したりしない。
- count reasonの候補値は一つの共通整数`N`である。各candidate `N`について、`U_code`の
  **全unitへ同時に**、そのunitのchildをcanonical順の先頭`min(N, actualUnitCount)`件へ
  制限する。その結果空になったancestorをcanonical規則どおり除外し、`U_code`外のunitと
  他のactive subjectをoriginal candidateのまま固定したprospective cardを構成する。
  次の集合をreasonごとに独立に求める。

```text
A_code = {
  N ∈ integers
  | 0 <= N <= declaredLimit
  | prospectiveCard(code, N) が全count / byte制約を満たす
}
```

- `A_code`がnonemptyなら`effectiveLimit = max(A_code)`とする。
- `A_code`がemptyなら`effectiveLimit = null`とする。これは「当該reasonの`U_code`
  だけを共通Nで調整しても、固定した別unitの独立違反が残り、合法なprospective cardを
  一件も構成できない」ことの唯一の表現である。
- `effectiveLimit: 0`はN=0のprojection pruningで全制約を満たせる有効な数値解であり、
  `null`と同一視しない。空集合を`0`、`-1`、`NaN`、`undefined`、field省略で表さない。
- unitごとに別々のNを求めてmin / max / averageで集約すること、一unitだけを縮めて
  次unitのNを求めること、最初に見つかった違反unitを代表にすることを禁止する。
  binary searchでも線形scanでも同じ共通Nを返し、raw input順のprefixは使わない。
- `cardJsonBytes` reasonだけは`actual`を実UTF-8 bytes、`declaredLimit`と
  `effectiveLimit`をともに65,536とし、`null`にはしない。
- non-null reasonの`limitingHierarchies`はoriginal candidateで同時成立した違反のうち、
  当該unit自身とそのancestor count、およびcard byte制約をcanonical reason順で列挙する。
  `effectiveLimit + 1`で最初に失敗する一理由だけへ縮めない。
- null reasonの`limitingHierarchies`は、当該`code`と、`prospectiveCard(code, 0)`でなお
  成立する全count / byte reasonの和集合とする。独立したsibling reasonも含め、上記
  canonical reason順で重複除去する。存在しない`effectiveLimit + 1`を評価しない。
- `samplePaths`はcanonical subject / group / target / anchor key順の先頭8件までとし、診断を無制限に増やさない。
- `samplePaths`は全reason entryの必須fieldであり、goldenの完全一致対象とする。
- pathは表示名やarray indexではなく、次のASCII grammarで作る。

```text
subject unit: subjects/<subjectKey>/<groups|periods>
group unit:   subjects/<subjectKey>/groups/<groupKey>/<targets|periods>
target unit:  subjects/<subjectKey>/groups/<groupKey>/targets/<targetKey>/periods
anchor unit:  subjects/<subjectKey>/groups/<groupKey>/targets/<targetKey>/anchors/<anchorKey>/periods
card unit:    card/weatherWarningForecast:active/<periods|jsonBytes>
```

- component中の`~`と`/`はJSON Pointerと同じ順で`~0`、`~1`へescapeする。
- 複数unit違反時はescaped pathのcode-point昇順で先頭8件を採る。
- `limitingHierarchies`は上記reason順で重複除去する。
- candidateの配列順、Map挿入順、最初に見つかった違反へ依存させない。
- `reasons`が空でなければprojection全体をfail-closedとし、一部group / targetだけをlive stateへ採用しない。
- string個別上限違反は既存のfield boundary diagnosticを使い、このcount / wire reasonsへ混在させない。
- diagnostic生成のために上限超過candidateをruntime stateまたはwriterへcommitしてはならない。


readerは一回だけ確定した`restoreNowMs`を使用し、次の順序で処理する。

1. persistence rootとoptional metadata containerを分類する。
2. projection、metadata、VPWP50 seen、v2 gateのraw item hard limitを検査する。
3. metadata claim / duplicate、seen grouping、v2 gate validationを行い、projectionは
   child containerへ入らずにsubject scalarとgate / seen couplingだけを検査する。
4. 各projectionへ`groups`→`targets`→`periods`のnested raw length-only preflightを
   適用する。overflow subjectはprojection全体を除外し、valid gateをgate-onlyで残す。
5. preflightを通過したprojectionだけperiod / target / group child validationを行い、
   除外childがexpiry witnessになり得るかを記録する。
6. deep-valid targetへ全group横断のArea / Local identity名称整合検査を行い、conflict
   identityをparserと同じscopeで除外してexpiry witness集合へ加える。
7. child salvage後もsubjectがnonemptyなら、persisted `expiresAtMs`とdeep-valid periodの最大`endsAtMs`を照合する。
8. expiry witnessを失った、またはouter couplingが一致しないsubject projectionをsubject単位で除外する。
9. coupling-valid subjectについて、periodごとに`endsAtMs <= restoreNowMs`を期限切れとして除外する。
10. 空になったtarget、group、subjectを順に除外する。
11. 期限切れ除外後にperiodが残るsubjectは、runtime `expiresAtMs`を残存periodの最大
   `endsAtMs`から再導出する。これはstep 7〜8でpersisted outer couplingを証明した後の
   時間経過によるcanonicalizationであり、malformed child salvageの暗黙修復ではない。
   periodが残らなければsubjectを除外する。
12. retained active projectionへ`restored: true`を設定する。
13. gate `acceptedAtMs`降順、subject key昇順でactive pairを処理する。
14. `restored: true`を含む実際の`ActiveStandbyCardV1`を構成し、period総数と64KiB byte上限を検査する。
15. budget内のactive pairだけをcommitし、除外projectionのvalid gateをgate-onlyへ再分類する。
16. salvage、expiry、coupling rejection、wire除外があればcanonical rewriteを要求する。

次を禁止する。

- child salvage後の`expiresAtMs`不一致を、retained periodの最大値へ黙って書き換えること。
- expiry witnessになり得るmalformed childだけを落としてsubjectを復元すること。
- coupling rejectionされたprojectionまたはmatching seenをlegacy active、seen-only、C-1へ再投入すること。
- 期限切れperiodを含むpersisted projectionへ先にcard budgetを適用すること。
- `restored: false`を仮定したcard byte数でrestore admissionを決めること。
- restore途中でsystem clockを読み直すこと。
- byte budget判定後に`restored`を書き換えること。
- period expiry後の小さいcanonical projectionを、expiry前byte数だけを理由に除外すること。

`restored`は永続DTOへ保存しないが、JSONの`false`と`true`には1 byteの差がある。readerのwire判定は必ずpost-restore DTOを使用し、この差も実測byte数へ含める。

scalar / gate routing後も復元候補として残るpersisted projectionの`groups` / `targets` /
`periods`には、childのschema predicate、key再計算、duplicate検出、expiry witness収集
より前に、subject単位のnested raw container preflightを適用する。v2 canonical、v1
rollback、metadataなしlegacy active migrationの各projectionで同じhelperを使う。
C-1のmissing-key projectionはscalar routingでprojection自体を捨て、childを一件も
走査せず§3.14のseen-only tombstone判定へ進むため、このpreflightの復元候補ではない。

preflightは次の三phaseを順に実行する。

1. raw subjectの`groups`がarrayなら、group itemを一件も読む前に`groups.length`を読む。
   1,024件を超えれば直ちにoverflowとし、group / target / period itemを走査しない。
   non-arrayなら既存のmalformed subject契約で除外し、descendantなしとして扱う。
2. group数が上限内の場合だけ、最大1,024件のraw groupを**container headerとしてのみ**
   走査する。recordの`targets`がarrayなら、group scalar predicateより先に各
   `targets.length`を読み、`max(targets.length)`と全groupの`sum(targets.length)`を
   計算する。一groupまたはsubject累計のいずれかが1,024件を超えればsubjectを
   overflowとし、target itemもperiod itemも一件も走査しない。non-array `targets`は
   後段のmalformed group判定へ渡し、このphaseでは長さ0として数える。
3. target数の一group上限とsubject累計上限がともに成立した場合だけ、全group合計で
   最大1,024件のraw targetをcontainer headerとして走査する。recordの`periods`が
   arrayなら、target scalar predicateより先に各`periods.length`を読み、
   `max(periods.length)`とsubject内の`sum(periods.length)`を計算する。一targetまたは
   subject累計のいずれかが1,024件を超えればsubjectをoverflowとし、period itemを
   一件も走査しない。non-array `periods`は後段のmalformed target判定へ渡し、この
   phaseでは長さ0として数える。

ここで許されるheader操作は、JSON由来valueのrecord / array判定、対象propertyの取得、
`array.length`読取り、safe integerのmax / sumだけである。group / targetの他scalarが
明らかにmalformedでも、そのscalar predicateを先に呼んで巨大descendantのpreflightを
迂回してはならない。三phaseを全て通過した後にだけ、最大1,024件のperiod itemへdeep
predicateとexpiry witness収集を行う。

nested raw overflow診断はsubjectごとに一回の
`vpwp50ReaderNestedRawLimitExceeded`へ集約する。

```ts
type Vpwp50NestedRawLimitReasonCode =
  | "groupsPerSubject"
  | "targetsPerGroup"
  | "targetsPerSubject"
  | "periodsPerTarget"
  | "periodsPerSubject";

interface Vpwp50NestedRawLimitReason {
  code: Vpwp50NestedRawLimitReasonCode;
  actual: number;
  limit: 1_024;
}

interface Vpwp50NestedRawLimitDiagnostic {
  subjectKey: string | null;
  reasons: readonly Vpwp50NestedRawLimitReason[];
  canonicalRewriteRequired: true;
}
```

- `actual`は順に`groups.length`、最大`targets.length`、全`targets.length`合計、最大
  `periods.length`、全`periods.length`合計とする。
- `reasons`は上記unionの順とする。同じphaseでlocal最大とsubject累計が同時に違反
  すれば双方を記録する。より浅いphaseがoverflowした場合は、未走査の深いphaseの
  reasonを推測しない。
- deep-valid childをまだ確定できない時点なので、`subjectKey`はtrim後nonblank、
  VPWP50 subject形式、`VPWP50_MAX_SUBJECT_KEY_LENGTH`以内のminimally extractable
  stringだけを用い、それ以外は`null`とする。malformed keyをpathへ埋め込まない。
- overflow時の最小安全単位は**当該subject projection全体**である。prefix salvage、
  group / target単位salvage、outer expiryの再計算を行わず、expiry coupling diagnosticも
  追加しない。
- 対応するgate bundleが独立にvalidならgateをactive gate-only watermarkとして残す。
  projectionとmatching seenをlegacy active、projection-free seen-only、C-1へ戻さない。
  これはpreflight到達前に完結するC-1案Cのroutingを変更しない。
- 正常な別subjectと他persistence domainを維持し、projection除外をcanonical rewrite
  する。save→reload後も除外projectionを復活させない。
- reader用1,024件上限をlive / writerのcanonical 128件上限へ流用しない。writerは
  canonical nested上限とcard 128 period＋64KiB ANDをI/O前に検査する。



period sanitizerは次を検証する。

- key、`tsNum`、series、canonical ISO、`startsAt < endsAt`、JST label
- period keyとpager anchor keyの43文字canonical form
- group、target、`tsNum`、series、`startsAt`、`endsAt`からperiod keyを再計算して一致
- `pagerAnchorKey`がouter subject revision、group、target、ordinalから再計算した値と一致
- `pagerAnchorOrdinal`が0以上のsafe integer
- `pagerSlot`が0〜3
- 同じtarget内のanchor / slot重複なし
- 一anchorあたりperiod 4件以下
- 先頭slot欠落やanchor ordinal gapは部分expiry後の正当stateとして許可
- malformed periodは原則としてperiod単位で除外するが、後述のexpiry witness規則を満たさなければsubject全体を拒否する

persisted period DTOは`timeRef`を持たず、sanitizerも要求しない。`timeRef`はslotを
解決した occurrence 段階でのみ検査する。複数 occurrence を結合したperiodへ、先頭・
末尾その他任意の一件の`timeRef`を代表値として保存してはならない。

target sanitizerは次を検証する。

- raw `periods.length`のnested preflightがtarget scalar predicateより先に完了していること
- key、scope、name、parentAreaName、areaCode、localCode、period container
- 各stringの個別上限
- `scope: "area"`では`name === parentAreaName`かつ`localCode === null`
- `scope: "local"`ではnonblank local name
- parent Area / Local identityを再計算できること
- target keyがsubject、scope、Area identity、Local identityから再計算した値と一致
- duplicate target keyは同一groupの`targets`配列内だけで検出し、後勝ちにしない
- subject全体のmultiplicity keyは`(group.key, target.key)`とする
- 異なるgroupに同じtarget keyが存在することを許可する
- period count上限
- malformed targetを除外するときは、全descendant periodについてexpiry witness規則を適用する

group sanitizerは次を検証する。

- raw `targets.length`のnested preflightがgroup scalar predicateより先に完了していること
- key、`phenomenonName`、`significancyCode`、`forecastLabel`、severity、targets
- 各stringの個別上限
- `phenomenonName`はcanonical raw `Property.Type`としてtrim後nonblank
- `vpwp50ForecastLabel()`でlabelを再計算し完全一致
- group keyを`phenomenonName`、code、label、displaySeverityから再計算して一致
- duplicate group identityは後勝ちにしない
- target count上限
- malformed groupを除外するときは、全descendant periodについてexpiry witness規則を適用する

subject sanitizerは次を検証する。

- raw `groups.length`と全nested container headerのpreflightがchild predicateより先に完了していること
- scalar field、revision、sourceEventId、canonical `appliedSemanticKey`
- subject、source ID、office、対象地域名・codeの個別上限
- group countとsubject内総period数
- `expiresAtMs`がfinite safe integerかつ有効なDate範囲
- child salvage後のdeep-valid periodが一件以上
- persisted `expiresAtMs`がdeep-valid periodの最大`endsAtMs`と一致
- duplicate subjectは全projectionを除外
- malformed subjectが正常な別VPWP50 subjectや他domainを失効させない

subject sanitizerは、各targetのdeep structural validation後、expiry coupling判定前に、
同一subjectの**全groupを横断したpersisted identity整合検査**を行う。target keyに名称が
含まれないこと、duplicate target keyの拒否scopeが同一group内であることを理由に、
この検査を省略してはならない。

各deep-valid targetからparserと同じnormalization helperで次を再構成する。

```text
parentAreaIdentityKey =
  areaCode != null
    ? "code:" + trim(areaCode)
    : "name:" + normalizeName(parentAreaName)

localIdentityKey =
  scope === "local"
    ? localCode != null
      ? "code:" + trim(localCode)
      : "name:" + normalizeName(name)
    : null
```

subject全体について、次の二mapをgroup順に依存せず構成する。

```text
areaNames[parentAreaIdentityKey] += normalizeName(parentAreaName)
localNames[(parentAreaIdentityKey, localIdentityKey)] += normalizeName(name)
```

- `areaNames`はarea targetとlocal targetの双方を全groupから収集する。
- `localNames`は`scope === "local"`だけを収集する。
- 同じkeyに同じnormalized nameが複数回現れることは正常である。
- code-less identityはnormalized name自体をkeyに含むため、異名は別identityである。
- code identityのname集合が二件以上ならpersisted Area conflictとする。
- 同じ親Area内のLocal code identityのname集合が二件以上ならpersisted Local conflictとする。
- Area conflictでは、その`parentAreaIdentityKey`を持つarea targetと配下の全local targetを
  **全groupから**除外する。
- Local conflictでは、該当`(parentAreaIdentityKey, localIdentityKey)`のlocal targetだけを
  **全groupから**除外し、親Area base targetと正常な別Localは維持する。
- Area conflictとLocal conflictが重なる場合はArea除外を優先し、同じtargetを二重計上
  しない。
- 除外後に空になったtarget / group / subjectはcanonical nonempty規則でpruneする。
- conflictで除外したtarget配下のraw periodはexpiry witness上のexcluded childとして
  扱う。outer witnessを維持できなければsubject projection全体を除外し、valid gateを
  active gate-onlyとして維持する。
- 後勝ち、最初のgroup優先、severity優先、名称多数決で修復しない。
- `vpwp50PersistedAreaIdentityConflict` / `vpwp50PersistedLocalIdentityConflict`をsubject
  ごとにboundedに記録し、conflict identity keyをcode-point昇順の先頭8件まで持たせる。
- 正常な別identity、別subject、他persistence domainへ波及させない。

これにより、同じArea codeを雨groupでは「長野県北部」、風groupでは「長野県南部」
とするpersisted DTOや、同じ親Area＋Local codeをgroupごとに別名とするDTOは、live
parserと同じscopeでsalvageされる。同名のidentityが複数groupに正常共存する契約は
維持する。

persisted `expiresAtMs`はreaderにおけるexpiry integrity witnessとする。live projectorと
writerはperiodから導出するが、readerは不一致を暗黙再計算で修復しない。

readerはraw childをdeep-valid / excludedへ分類した後、subjectごとに次を一度計算する。

```text
outer = persistedSubject.expiresAtMs
retainedMax = deep-validで残る全periodのmax(endsAtMs)、なければnull
excludedEnds = 除外child配下の全raw periodから独立にparseできたendsAtMs列
excludedUnknownCount = endsAtMsをfinite safe integerかつDate範囲内へ
                       parseできない除外raw period数
retainedOuterWitness = outerがvalidかつ、deep-valid periodにendsAtMs === outerがある
```

child unitを最小安全単位で除外できる必要十分条件は次のすべてである。

1. `outer`がfinite safe integerかつECMAScript Date範囲内。
2. `excludedUnknownCount === 0`。
3. `excludedEnds`に`endsAtMs > outer`がない。
4. `retainedMax === outer`。
5. deep-valid periodが一件以上残る。

`excludedEnds`の一件が`outer`と等しいこと自体はsubject rejection理由ではない。同じ
最大終了時刻を持つdeep-valid siblingが残り、`retainedOuterWitness === true`なら、
malformed childだけを除外できる。最大時刻tieを`endsAtMs < outer`必須として拒否しては
ならない。

逆に、最大終了時刻を持つperiodをすべて除外して`retainedMax < outer`となる場合は
witnessを失っている。outerをretainedMaxへ巻き戻さずsubject projection全体を除外し、
対応するvalid gateをactive gate-only watermarkとして維持する。除外raw periodの
`endsAtMs`が不明、`outer`より後、またはdeep-valid periodが空の場合もsubject単位で
除外する。

expiry coupling診断は一subject一回の`vpwp50SubjectExpiryCouplingRejected`へ集約し、
単一`reason`ではなくcanonical `reasons`配列を持つ。

```ts
type Vpwp50ExpiryCouplingReason =
  | "invalidOuterExpiry"
  | "removedExpiryWitness"
  | "outerDerivedMismatch";

interface Vpwp50ExpiryCouplingDiagnostic {
  subjectKey: string;
  persistedExpiresAtMs: number | null;
  retainedMaxEndsAtMs: number | null;
  excludedUnknownEndsAtCount: number;
  excludedChildKinds: readonly ("period" | "target" | "group")[];
  excludedChildCount: number;
  reasons: readonly Vpwp50ExpiryCouplingReason[];
  canonicalRewriteRequired: true;
}
```

reason成立条件と順序は次で固定する。

1. `invalidOuterExpiry`: persisted outerがfinite safe integerまたはDate範囲でない。
2. `removedExpiryWitness`: 除外raw periodの`endsAtMs`が一件でも不明・不正、outer
   より後、またはouterと等しい除外periodがあるのにdeep-validなouter witnessがない。
3. `outerDerivedMismatch`: outerがvalidで、`retainedMax == null`または
   `retainedMax !== outer`。

- 成立した全reasonを上記順で一度ずつ入れる。走査順や最初のfailureで打ち切らない。
- `invalidOuterExpiry`と`removedExpiryWitness`は同時に成立し得る。その場合も二件を
  この順で記録する。
- `excludedChildKinds`は`period`、`target`、`group`の順で重複除去する。
- raw child payloadや無制限のperiod一覧をdiagnosticへ含めない。
- coupling rejection後のprojection / seenをlegacy fallbackまたはC-1へ戻さない。

writerは同じcouplingをI/O開始前に検査し、不一致をfail-loudとする。live projector /
reducerはmutation前にcanonical `expiresAtMs`を導出し、この不一致をruntime stateへ
入れない。

VPWP50 persistence readerは、metadata claimやduplicate groupingより前に、入力sourceごとのraw container preflightを行う。

`weatherWarningForecastGateMetadata`のroot propertyはown-property判定により次の三状態へ分類する。

```ts
type Vpwp50MetadataRootState =
  | "absent"
  | "present-array"
  | "present-invalid";

const hasGateMetadataProperty =
  Object.prototype.hasOwnProperty.call(
    root,
    "weatherWarningForecastGateMetadata",
  );
```

| 状態 | 条件 |
|---|---|
| `absent` | property自体が存在しない |
| `present-array` | propertyが存在し、値がarray。空配列を含む |
| `present-invalid` | propertyが存在し、値が`null`、object、scalar、boolean、string、number、own `undefined`その他non-array |

`metadataRootState`はraw root分類時に一度だけ確定し、その後candidateが0件になっても再分類しない。

規則は次とする。

- metadataなしlegacy active migration、projection-free seen-only、C-1案Cへ進めるのは`metadataRootState === "absent"`の場合だけとする。
- empty arrayは`present-array`であり、`absent`へ読み替えない。
- `present-array`ではmetadata candidateによるclaim結果をauthoritativeとする。
- projectionまたはseenが存在するのに対応metadataがない場合も、`present-array`ならmetadataなしlegacy fallbackへ流さない。
- malformed / duplicate metadataの除外後に配列が空になっても`present-array`のままとする。
- `present-invalid`をmetadata欠落へ読み替えない。
- standalone v1の`present-invalid`では、VPWP50 projection、VPWP50 seen、VPWP50 metadataを一つのrollback domainとして除外し、他domainを維持する。
- 正常なv2 canonical stateが存在する場合、v2 root rollback mirrorまたはstandalone v1の`present-invalid`はcanonical stateを置換しない。mirror diagnosticとcanonical rewriteだけを要求する。
- `vpwp50V1GateMetadataPresentInvalid`をboundedに記録する。
- explicit `null`、object、scalarをempty arrayへ暗黙変換しない。

raw hard limitは、distinct subjectまたはbundleへ畳み込む前のitem件数へ適用する。

shared arrayはVPWP50 candidateを抽出する前に、array自身へ次のouter preflightを
適用する。HEADの`validDomainArray(value.seen, ...)`、
`sanitizeStandbyDomainsFoundation()`の`.flatMap()` / `.filter()`は配列全体を走査する
ため、VPWP50 candidate上限だけではscanをboundできない。

| shared raw container | outer raw上限 | overflow時の安全単位 |
|---|---:|---|
| standalone v1 / v2 rollback mirror root `seen` | 16,384 item | `root.seen` container全体 |
| v2 `telegramFoundation.standbyDomains.gateEntries` | 16,384 item | `foundation.standbyDomains` container全体 |

outer preflight規則は次とする。

1. propertyのarray判定後、itemを一件もpredicate評価する前に`array.length`を読む。
2. 16,384件以下だけを既存generic sanitizerとVPWP50 candidate抽出へ渡す。
3. 16,385件以上では先頭16,384件を採用せず、shared container全体を除外する。
4. overflow判定のためにitemを走査しない。`length`だけで確定する。
5. non-VPWP50 item、malformed item、duplicate itemもouter raw countに含める。
6. outer preflight通過後にだけ、VPWP50 namespace candidateを最大1,025件まで数え、
   下表のdomain-local 1,024件上限を適用する。
7. shared container overflowは`vpwp50ReaderSharedContainerLimitExceeded`をsourceごとに
   一回記録し、container、`actual=array.length`、limit、source kindを持たせる。
8. standalone v1の`seen` overflowはrootの他fieldを維持し、`seen`だけを空として
   canonical rewriteする。VPWP50 projectionはgateを再構成できないため表示しない。
9. v2 `standbyDomains.gateEntries` overflowは`standbyDomains`だけを空 foundationへ
   domain-local repairし、他foundation domainを維持する。VPWP50 projectionは
   coupling不能なので除外する。
10. 正常なv2 rootを読み込めた場合、そのv2をauthoritativeとする既存優先順位を
    変えない。standalone v1 `seen` overflow、metadata overflow、rollback mirror
    overflowを理由にv1でv2 canonical stateを置換しない。
11. v2 root内の`standbyDomains`だけがoverflowしても、v2 top levelを不在扱いにして
    standalone v1へfallbackしない。v2の他domainを採用し、壊れたdomainをrepairする。
12. standalone v1へfallbackできるのは、従来どおりv2 fileが不在、JSON不正、または
    top-level全体がsanitizerを通らず`state: null`となる場合だけである。
13. canonical writerはfull root `seen`とfull `standbyDomains.gateEntries`が各16,384件
    以下であることをtemp write前に検証する。超過時は一部を切り捨てずfail-loudとし、
    最後の正常fileを置換しない。

| raw source | raw candidateの定義 | 上限 |
|---|---|---:|
| `weatherWarningForecasts` | domain専用raw arrayの全item | 1,024 |
| `weatherWarningForecastGateMetadata` | `present-array`の全item | 1,024 |
| v1 `seen` | minimally extractable keyが`weatherTimeseries:` VPWP50 namespaceに属するraw item | 1,024 |
| v2 `standbyDomains.gateEntries` | raw domain / revisionFamilyが`weatherWarningTimeseries` / `VPWP50`を指すitem | 1,024 |

追加規則は次とする。

- domain専用projectionまたはmetadata propertyがnon-arrayなら既存のpresent-invalid / malformed container契約を適用する。
- shared `seen` / v2 gate arrayは上記16,384件outer preflightを通った場合だけ一度走査し、VPWP50 raw candidateを最大1,025件まで数えた時点でdomain-local overflowを確定できる。
- 0〜1,024件は全件を後続scanへ渡す。
- 513件はraw container違反ではなく、後段のcanonical bundle 512件salvage対象になり得る。
- 1,025件以上では先頭1,024件だけを採用しない。
- 同一subjectのduplicate 1,025件も、bundle一件へ畳み込む前にraw hard-limit違反とする。
- raw overflowしたsourceではVPWP50 candidateを一件も復元せず、legacy fallbackへ流さない。
- standalone v1だけがsourceならVPWP50 rollback domainをfail-closedで除外し、他domainを維持する。
- 正常なv2 canonical stateがあり、rollback mirror側だけがoverflowした場合はv2 canonicalを維持し、rollback mirror repairとcanonical rewriteを要求する。
- v2 canonical VPWP50 gate candidate自体がoverflowした場合はVPWP50 canonical persistence domainを除外し、他standby domainを維持する。
- `vpwp50ReaderRawLimitExceeded`をsourceごとに一回記録し、container、actual count、limit、source kindを含める。
- canonical writerが出力できるprojection、metadata、VPWP50 gate bundleは各512件以下とする。
- reader用raw上限1,024をwriter上限として使用しない。

source-level raw hard-limit preflightを全て通過した後にだけmetadata claim phase、seen
grouping、v2 gate validation、distinct bundle構成へ進む。projection内のnested raw
container preflightはbundleを対応付けた後、child predicateより前に別途適用する。


claim phaseではraw metadata arrayを一度だけ走査する。metadata candidateが次を満たす場合、他fieldがmalformedでも当該subjectをclaimする。

- candidateがnon-null object
- own propertyとして`stateSubjectKey`を持つ
- `stateSubjectKey`がstring
- trim後nonblank
- VPWP50 subject形式
- `VPWP50_MAX_SUBJECT_KEY_LENGTH`以内

trim後subjectを`claimedMetadataSubjects`へ追加する。

- comparison、semanticKeys、cancelled、seen couplingを検査する前にclaimする。
- minimally valid subjectを持つcandidateが一件でもあれば、同subjectのprojection candidateと全matching seen candidateをmetadata migration用としてconsumeする。
- deep validation失敗後にprojection / seenをlegacy active、legacy seen-only、C-1、standalone fallbackへ戻してはならない。
- 同じnormalized subjectをclaimするcandidateが二件以上あれば、valid / invalidの組合せを問わずduplicate metadata bundleとする。
- duplicate時は全metadata candidate、projection candidate、matching seen candidateをconsume / rejectする。
- 後勝ち、valid candidate優先、最新comparison選択を行わない。
- minimally valid subjectを抽出できないmetadata itemはどのsubjectもclaimせず、bounded malformed-item diagnosticだけを記録する。
- claim、duplicate、consume結果をraw metadata配列順に依存させない。

claim後、一意なmetadata candidateには次のdeep validationを適用する。

- `comparison`がv2 gateと同じdeep validatorを通る
- `comparison.stateSubjectKey === stateSubjectKey`
- `semanticKeys`が32件以下のunique canonical string配列
- metadata comparisonのreport time / normalized serialが対応v1 seenと一致する
- matching seen key groupが一件だけ
- metadata subject / seen / projectionのmatching結果をinput順に依存させない

さらに、metadataとv2 VPWP50 gate entryの双方へ同じstatus matrixを適用する。
`latestSemanticKey`はordered `semanticKeys`の末尾とする。

| status | `cancelled` | `comparison.revision.infoType.value` | `semanticKeys` | latest prefix |
|---|---:|---|---|---|
| normal active | `false` | `発表` または `訂正` | 1〜32件。全件が`発表:`または`訂正:` | infoTypeと一致 |
| normal tombstone | `true` | `取消` | 1〜32件。過去のactive keyを含んでもよい | `取消:` |
| synthetic tombstone | `true` | `取消` | 空配列 | なし |

synthetic tombstoneは、§3.10のmetadataなしprojection-free seen-onlyまたは§3.14
C-1案Cが生成し、その後writerがv2 / v1 metadataへcanonical tripleのまま
dual-writeする形式である。したがって二段reloadでは、`cancelled: true`、infoType
`取消`、空`semanticKeys`の組そのものをcanonical synthetic tombstoneとして受理する。
空key列からactive stateを推測してはならない。

次の組合せはdeep-invalidとする。

- `cancelled: false`＋infoType `取消`
- `cancelled: true`＋infoType `発表` / `訂正`
- normal activeの空`semanticKeys`
- normal activeのkey列に`取消:`が一件でもある
- normal activeのlatest prefixとinfoTypeが不一致
- normal tombstoneのlatest prefixが`取消:`でない
- synthetic tombstoneのnonempty `semanticKeys`

active projectionを結合できるのはnormal activeだけであり、projectionの
`appliedSemanticKey`は`latestSemanticKey`と完全一致する。normal / synthetic
tombstoneはprojectionを復元しない。status matrix不一致を`cancelled`、infoType、
semantic key prefixのどれかから推測修復してはならず、当該claimed bundleをreject
する。v2 canonicalでも同じsubject bundleだけをrepairし、正常な別subjectを維持する。

metadata arrayの512件canonical上限は、このitem deep validation段階では適用しない。513件目をscan前またはclaim前に切り捨ててはならない。

一意candidateがdeep validationに失敗した場合もsubject claimは取り消さない。

- 当該subject bundleを復元しない。
- consumed projection / seenを他migration経路へ流さない。
- `vpwp50V1GateMetadataInvalidClaimedSubject`をsubjectあたり一回記録する。
- duplicateの場合は`vpwp50V1GateMetadataDuplicateClaimedSubject`を記録する。
- canonical rewriteを要求する。
- 正常な別subjectと他domainを維持する。

projectionとgate / seenのbundleを次に分類する。

1. **active pair**: projection＋`cancelled: false` gate
2. **active gate-only watermark**: projectionなし＋`cancelled: false` gate
3. **tombstone-only bundle**: projectionなし＋`cancelled: true` gate

- active projectionをgateなしで保持しない。
- active pairのprojection revision / semantic keyはgateと一致させる。
- active gate-only watermarkは正当な表示なしstateとする。
- tombstone-only bundleも正当な表示なしstateとする。
- gate-only stateからcard、`RestoredChip`、pagerを生成しない。
- v1 metadataがある場合、projectionの有無から`cancelled`を推測しない。
- `cancelled: false` metadata＋projectionなしはactive gate-onlyとして復元する。
- `cancelled: true` metadataはprojectionを復元しない。

raw metadata、projection、seen、v2 gateのunionからdistinct bundleを構成した後に、reader bundle上限を適用する。

- distinct raw bundle数1,024件まではbounded inputとして処理する。
- 1,025件以上ではVPWP50 persistence domainをfail-closedで除外し、先頭だけを採用しない。
- valid bundleが512件以下なら全件を次のcard budget段階へ渡す。
- valid bundleが513〜1,024件なら、gate `acceptedAtMs`降順、subject key昇順で決定的に512件を残す。
- これは外部fileのreader salvage契約であり、live admissionの513件目契約ではない。
- active pairはprojection / gateを一緒に保持または破棄する。
- active gate-only / tombstone-onlyはgateだけを保持する。
- v1では§3.10の式で復元したacceptedAtMsを使用する。
- input順を変えてもretained集合を同じにする。
- repair diagnosticとcanonical rewriteを予約する。
- bundle上限salvage後に、expiry除外、`restored: true`設定、global card count / byte budgetを前節の順序で適用する。
- bundle上限で保持されたactive pairも、global card budgetに入らなければprojectionだけを除外してgate-onlyへ再分類できる。

live subject 513件目は§3.8でgate mutation前に拒否する。live reducerがsubject数limit+1を処理する分岐を持ってはならない。


live reducerのnested上限超過は§3.3のfail-closed契約に従う。readerはdomain-local salvage、writerはruntime invariant違反でfail-loudとする。

- writerはv2 canonical、v1 projection、v1 seen、v1 gate metadataの全体をtemp write前にmemory上で検証する。
- 一方のfileだけを更新した後に他方のvalidation失敗を検出する順序にしない。
- writer failure時は最後の正常fileを維持する。

### 3.10 v1 migration と dual-write

既存の v2 canonical / standalone v1 rollback 契約を維持する。

- 正常な v2 canonical を authoritative とする。
- v2 不在時の standalone v1 fallback を維持する。
- v2 / v1 の `weatherWarningForecasts` は同じ canonical projection を書く。
- v2 `standbyDomains.gateEntries` に VPWP50 durable gate を書く。
- v1 `seen` に同じ gate revision を書く。
- v1 `weatherWarningForecastGateMetadata` に comparison、ordered semantic keys、cancelled を書く。
- v1 seen key は `weatherTimeseries:` subject key とする。
- writer が出力する gate 一件に seen / metadata を各一件要求する。
- active pair、active gate-only、tombstone-only のいずれでも metadata を省略しない。

v1 `forgetAtMs` と migration の `acceptedAtMs` は次とする。

```text
forgetAtMs =
  acceptedAtMs
  + WEATHER_TIMESERIES_RETENTION_MS
  + 1

acceptedAtMs =
  forgetAtMs
  - WEATHER_TIMESERIES_RETENTION_MS
  - 1
```

migration時刻、file `savedAt`、restore時刻を新しいretention起点にしない。

acceptedAt共通preflightは次の全経路へ適用する。

1. metadata付きmigration
2. metadataなしlegacy active migration
3. metadataなしprojection-free legacy seen-only tombstone
4. C-1案C
5. v2 sanitizer

共通規則は次とする。

- migrationへ固定 `nowMs` を渡す。
- `acceptedAtMs` は finite safe integer かつ ECMAScript Date 有効範囲内。
- `acceptedAtMs <= nowMs + VPWP50_ACCEPTED_AT_FUTURE_SKEW_MS`。
- `acceptedAtMs === nowMs + 15分` は許可。
- `acceptedAtMs === nowMs + 15分 + 1ms` は拒否。
- future-skew違反を `nowMs`、`savedAt`、report time で補正しない。
- v2 sanitizerも同じ固定時計と境界を使用する。

v1 seen は revision matching より前に key 単位で group 化する。

1. minimally valid な trim 後 seen key を抽出する。
2. VPWP50 subject形式かつ文字列上限内のseenだけを候補とする。
3. 同じ normalized `seen.key` の全 candidateをgroup化する。
4. groupが一件だけの場合に限り後続検査へ進む。
5. 二件以上ならrevision / `forgetAtMs`の同異を問わずduplicate bundleとする。
6. duplicate groupの全seenをconsumed / rejectedとし、metadata、legacy active、legacy seen-only、C-1、standalone fallbackへ再投入しない。
7. 後勝ち、最新revision、最大 / 最小forgetAtを選ばない。
8. input順を変えてもrejection、diagnostic、consumed集合を同じにする。

v1 serial は次のように正規化する。

```ts
type NormalizedLegacySerial =
  | { kind: "missing" }
  | { kind: "numeric"; numeric: number; canonicalRaw: string }
  | { kind: "invalid" };
```

- `null` / `""` は missing。
- `/^\d+$/` かつ finite safe integerだけnumeric。
- `"01"` / `"1"` はnumeric 1として一致。
- canonical rawは`String(numeric)`。
- whitespace、符号、小数、英字、unsafe integerはinvalid。
- numeric / missingは一致しない。
- invalid serialからgateを生成しない。

reportDateTime reconstruction は次を要求する。

- `reportTimeMs` が finite safe integer かつ有効な Date 範囲。
- canonical UTC ISOへ変換し、再parse epochが一致。
- acceptedAt共通preflight成立。
- 加算がsafe integer範囲内。
- `reportTimeMs <= acceptedAtMs + VPWP50_REPORT_FUTURE_SKEW_MS`。
- `reportTimeMs === acceptedAtMs + 15分` は許可。
- `reportTimeMs === acceptedAtMs + 15分 + 1ms` は再構成不能。
- failure時にacceptedAtを補正しない。

本仕様で「valid legacy seen」と呼ぶものは、次をすべて満たす一件だけとする。

- normalized seen key groupが一件だけ。
- VPWP50 subject形式とstring上限を満たす。
- `forgetAtMs` がsafe integerかつ有効なDate範囲。
- 上式からacceptedAtをsafeに復元できる。
- acceptedAt共通preflightを通る。
- normalized serialがinvalidではない。
- reportDateTimeをcanonical UTC ISOとして再構成できる。
- report future-skewを通る。
- subject-bound eventId、VPWP50 type、canonical reportDateTime、normalized serial、対象経路のinfoTypeからstrict comparison全fieldを生成できる。

metadata / projectionと組み合わせる経路では、さらにsubject / normalized revisionが一致しなければならない。projection-free legacy seen-only tombstoneでは比較対象projectionがないため、seen自身のsubject / revisionからstrict comparisonを構成する。

zero match、duplicate group、revision mismatch、acceptedAt / report preflight失敗では再構成しない。検査対象として消費したseenを別fallbackへ戻さない。

strict comparison field は次とする。

```ts
interface ReconstructedVpwp50Comparison {
  revision: {
    eventId: StrictTextMeta;
    type: StrictTextMeta;
    reportDateTime: StrictDateTimeMeta;
    serial: TelegramSerial;
    infoType: StrictInfoTypeMeta;
  };
  stateSubjectKey: string;
}
```

- `stateSubjectKey`: matched trim後subject
- `eventId.raw/value`: subject key、`valid: true`
- `type.raw/value`: `"VPWP50"`、`valid: true`
- `reportDateTime`: canonical UTC ISO、epoch、`valid: true`
- numeric serial: canonical raw / numeric / `valid: true`
- missing serial: raw null / numeric null / `valid: false`
- active infoType: `"発表"`または`"訂正"`
- tombstone infoType: `"取消"`

canonical semantic key は次とする。

```text
active projection appliedSemanticKey:
  ^(発表|訂正):[0-9a-f]{64}$

gate metadata semantic key:
  ^(発表|訂正|取消):[0-9a-f]{64}$
```

- migration中にdigest、prefix置換、trim以外のnormalizationでkeyを修復しない。
- non-canonical keyをactive projectionとして復元しない。
- projectionだけをcanonicalizeしてgateとcoupleしない。
- metadata付きbundleでprojection keyだけが不正ならprojectionを除外し、valid gateをgate-onlyで維持できる。
- metadataなしbundleでprojection keyが不正ならprojection / matched seenをbundle拒否し、seen-only tombstoneへ再解釈しない。
- `vpwp50V1NonCanonicalAppliedSemanticKey` を一bundle一回記録する。
- 二段reloadでkeyを再変化させない。

#### metadata 付き v1 migration

metadata migrationは§3.9のraw claim tableをauthoritativeとする。

1. normalized subjectをclaimしたmetadata candidate数を確認する。
2. candidateが一件であっても、deep validation前に同subjectのprojectionと全matching seenをconsumeする。
3. candidateがduplicateまたはdeep-invalidならsubject bundle全体を拒否し、consumed projection / seenをmetadataなしmigration、legacy seen-only、C-1へ再投入しない。
4. 一意かつdeep-validなmetadataだけを後続処理へ渡す。
5. metadata subjectと同じseen key groupが一件だけであることを確認する。
6. metadata comparisonとseenのsubject、reportTimeMs、normalized serialを照合する。
7. seenがvalid legacy seenであることを確認する。
8. acceptedAtをforgetAt式から復元する。
9. metadataのcomparison、semanticKeys、cancelledをそのままv2 gateへ復元する。
10. `cancelled: false`＋valid projectionはrevision / canonical latest key coupling成立時だけ復元する。
11. `cancelled: false`＋projectionなし・期限切れ・malformedはactive gate-onlyとする。
12. `cancelled: true`はprojectionを復元せずtombstone-onlyとする。
13. subject / revision mismatch、invalid retention、acceptedAt / report future-skew違反ではbundleを復元しない。
14. rejected seen groupを他migration経路へ再投入しない。

metadata付きinputではprojectionの有無から`cancelled`を推測せず、active gate-onlyをtombstone化しない。malformedまたはduplicate metadataを除外した結果を「metadata欠落」と再解釈してはならない。

#### metadata のない legacy v1 migration

本節へ入れる必要十分条件は、対象migration sourceについてraw root分類時に確定した次の条件である。

```ts
metadataRootState === "absent"
```

次の条件は本節へ入る根拠にならない。

- `present-array`が空配列である。
- `present-array`内に当該subjectのmetadataがない。
- metadata candidateが全てmalformedとして除外された。
- metadata candidateがduplicateとして全て拒否された。
- claim phase後のvalid metadata件数が0件になった。
- `present-invalid`をsanitizerが除外した。

`metadataRootState`はmigration中に再計算しない。`present-array`または`present-invalid`のprojection / seenをlegacy active、projection-free seen-only、C-1へ流してはならない。

`metadataRootState === "absent"`の場合に限り、active projectionの復元には次をすべて要求する。

- valid legacy seenが一件だけ。
- projectionとseenのsubject / normalized revisionが一致。
- projectionにcanonical nonblank `appliedSemanticKey`。
- semantic key prefixからactive infoTypeを一意に復元可能。
- strict comparison全fieldを生成可能。
- projectionがdeep validation、expiry coupling、acceptedAt / report future-skewを通る。

active gateの`semanticKeys`はprojectionのcanonical `appliedSemanticKey`一件から構成する。

`metadataRootState === "absent"`かつprojectionが存在せず、valid legacy seenだけが一件ある場合は、active / cancelledを識別できないlegacy inputとして、保守的に次のtombstoneへ移行する。

- `cancelled: true`
- `semanticKeys: []`
- strict subject-bound eventId
- type `"VPWP50"`
- canonical reportDateTime
- normalized serial
- infoType `"取消"`
- acceptedAtはforgetAt式から復元
- 表示、projection、card、chip、pagerなし

このprojection-free legacy seen-only経路にもacceptedAt / report future-skewを適用する。どちらかが不成立ならtombstoneを生成せず、seenを他fallbackへ戻さない。

legacy seen-only非対称は`metadataRootState === "absent"`のinputだけに許可し、`vpwp50V1GateMetadataMissing`を記録する。新writerのdual-writeへは適用しない。

reconstruction失敗時は次とする。

- active projection、gate、seen-only tombstoneを生成しない。
- partial comparison、synthetic EventID、synthetic semantic keyを生成しない。
- matching候補seen groupをfallbackへ戻さない。
- `vpwp50V1RevisionReconstructionFailed`を記録する。
- failure fieldに`metadataRootState`、`seenKeyCount`、`revisionMatch`、`acceptedAtFutureSkew`、`reportFutureSkew`、`appliedSemanticKeyCanonicality`、`projectionFreeSeenOnly`を含める。
- canonical rewriteを予約する。
- 正常な別subjectと他domainを維持する。

C-1 missing-key projectionは、同じ`metadataRootState === "absent"`条件を満たす場合だけ§3.14へ進める。

### 3.11 frontend card

新規 `WeatherWarningForecastCard.svelte` を追加する。

- 共通 `standby-card-header` を使用する。
- タイトルは常に「気象警報予測」とする。
- header meta に `RestoredChip` と `UpdatedStamp` を配置する。
- `RestoredChip` は `item.restored === true` の場合だけ表示する。
- severity に応じて既存 weather header token を選ぶ。
- 本文は engine の `forecastLabel`、本節のtarget label、period labelを表示する。
- Significancy code、Property.Type、雷と竜巻の関係をfrontendで再解釈しない。
- card surface、border、radius、shadow、spacing、文字階層は既存standby cardに合わせる。
- 新しい色、帯、severity icon、点滅を追加しない。

target labelはDTOのauthoritative fieldだけから次の純粋関数で生成する。

```ts
function vpwp50ForecastTargetLabel(
  target: DisplayWeatherWarningForecastTargetV1,
): string {
  const parent =
    target.areaCode == null
      ? target.parentAreaName
      : `${target.parentAreaName}（${target.areaCode}）`;

  if (target.scope === "area") {
    return parent;
  }

  const local =
    target.localCode == null
      ? target.name
      : `${target.name}（${target.localCode}）`;

  return `${parent} / ${local}`;
}
```

規則は次とする。

- `scope === "area"`でもcodeがあれば`parentAreaName（areaCode）`を表示する。
- `scope === "area"`でcode-lessなら`parentAreaName`だけを表示する。
- `scope === "local"`は親AreaとLocalの双方を必ず含める。
- codeがあるpartはnormalized codeを全角括弧で付記する。
- code-less partは名称だけを使う。
- Local separatorはASCII space＋`/`＋ASCII spaceとする。
- 同名・別codeのAreaは常に異なる完全labelとなる。
- collision時だけcodeを足すcontext-dependent分岐を作らない。
- frontend、DOM text、`title`、ARIA target text、pager atom label、coordinator fingerprint、preview fixtureは同じ関数の結果を使用する。
- frontend / pagerで名称を短縮、再正規化、codeから逆引きしない。
- DTOの`name` / `parentAreaName`自体は変更せず、target labelをidentity keyとして使わない。

静的期待値は次とする。

| scope | parentAreaName | areaCode | name | localCode | target label |
|---|---|---|---|---|---|
| area | `長野県北部` | `200010` | `長野県北部` | null | `長野県北部（200010）` |
| area | `長野県北部` | `200020` | `長野県北部` | null | `長野県北部（200020）` |
| area | `長野県北部` | null | `長野県北部` | null | `長野県北部` |
| local | `長野県北部` | `200010` | `沿岸` | `001` | `長野県北部（200010） / 沿岸（001）` |
| local | `長野県南部` | `200020` | `沿岸` | `001` | `長野県南部（200020） / 沿岸（001）` |
| local | `長野県北部` | null | `沿岸` | null | `長野県北部 / 沿岸` |
| local | `長野県北部` | `200010` | `沿岸` | null | `長野県北部（200010） / 沿岸` |
| local | `長野県北部` | null | `沿岸` | `001` | `長野県北部 / 沿岸（001）` |

pager atomの表示 / accessible labelは次を使用する。

```text
pager target label =
  vpwp50ForecastTargetLabel(target)

pager atom label =
  forecastLabel
  + " / "
  + pager target label
```

ARIA accessible nameではこのatom labelを省略せず、表示中period labelを既存順で付加する。ellipsisは視覚表示だけに許可し、`title`、ARIA、coordinator、previewにはtarget label全文を残す。

### 3.12 StandbyScreen と layout solver 登録

`StandbyScreen.svelte` に次を追加する。

- `KNOWN_KINDS` へ `weatherWarningForecast`
- `itemOf("weatherWarningForecast")`
- `CARD_ORDER` へ独立 card
- candidate presence 判定
- candidate score
- compact measurement shelf
- side / center probe
- live render
- rotation render
- page diagnostics
- snapshot content identity

通常の active weather card を予測 card より先に配置する。

```text
... → weather → weatherWarningForecast → briefing → ...
```

`display/frontend/src/lib/legacy-standby/solver.ts` も同時に更新する。

- `CENTER_ELIGIBLE_KEYS` に `weatherWarningForecast` を追加する。
- `ROTATION_REVERSE_ORDER` は card order の逆順関係を保ち、`briefing` と `weather` の間に `weatherWarningForecast` を追加する。
- rotation candidate が 6 件から 7 件になるため、`MAX_ROTATION_CANDIDATE_PASSES` を `7` に更新する。
- 上限コメントも「既存 6 件＋forecast」へ更新する。
- candidate が 7 件ある場合に最後の candidate まで評価され、固定 pass 上限によって一件落ちないことを solver test で固定する。
- center spill、rotation、failed candidate、previous plan の各経路で新 card が既存 card を不正に脱落させないことを検証する。
- preview の solver source contract も `7` へ更新する。

registry policy は固定 card TTL を持たず、TimeDefine expiry を使用する。wire sorting 上の priority は briefing と volcano の間とする。

### 3.13 pager

`weatherWarningForecast` に独立 pager state を持たせる。

追加対象は次のとおり。

- `CardKey`
- `PagePartitionKey`
- `PageableKey`
- scheduler の `PAGEABLE_KEYS`
- coordinator の runtime / substate / label / fingerprint record
- StandbyScreen の page probe と diagnostics
- preview の exhaustive pager record

pager coordinator の card label は「気象警報予測」とし、engine title と一致させる。

一target全体を不可分atomにせず、§3.4でperiodに保存したimmutable anchor単位へ分割する。

```ts
export const WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM = 4;
```

pager atomは次とする。

```text
(group key, target key, pagerAnchorKey)
```

atom構築規則は次とする。

1. retained periodを`pagerAnchorOrdinal`、`pagerSlot`、period canonical orderで並べる。
2. 同じ`pagerAnchorKey`のperiodを一atomへまとめる。
3. 一atomは1〜4 periodとする。
4. `pagerSlot`にgapがあっても詰め直さない。
5. anchor ordinalにgapがあっても後続anchorをrenumberしない。
6. group label、target label、retained periodを一緒に描画する。
7. 一つのperiodを複数atomへ入れない。
8. group / targetが異なるperiodを同一atomへ混ぜない。
9. fresh projectionのatom数は、各`(group, target)` partitionのperiod数を`nᵢ`として次で求める。

```text
freshAtomCount =
  Σ ceil(nᵢ / WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM)
```

10. 単一targetへ128 periodを置いた場合は32 atomとなる。
11. 128 targetへ一periodずつ分散した場合は128 atomとなる。
12. 一般形では`freshAtomCount <= totalPeriodCount <= 128`であり、最大atom数は128である。
13. 各periodはちょうど一atomへ所属する。
14. partial expiry後はimmutable anchor gapを維持するため、retained period数だけからatomを再chunkしない。
15. partial expiry後のatom数は元のfresh atom集合以下とし、無関係な後続atomを新規生成しない。

atom identity は次から決定する。

```text
group key
+ target key
+ pagerAnchorKey
```

first period key、last period key、current period count、current continuation indexをidentityへ含めない。

-先頭period expiry後も同anchorのidentityを維持する。
-先行anchor消滅後も後続atom identityを維持する。
-新しいaccepted reportによるprojection全置換時だけ、新revisionに基づくanchorへ置換してよい。

fingerprintは次を含める。

- group key
- target key
- pager anchor key / ordinal
- retained period key、label、`tsNum`、series、slot
- group severity
-現在表示するcontinuation text

period expiryでは影響を受けたatomのfingerprintだけを更新する。先行period / atomの失効を理由に無関係な後続atomを削除・再登録しない。

continuation表示は現在到達可能なatom列から`続き n/m`を算出してよいが、表示上のn/mをatom identityへ使わない。

表示規則は次とする。

- group / target labelは一行ellipsis、全文はaccessible nameまたは`title`
- period labelは一行、frontendで再整形しない
- continuationは既存muted text内に表示
-一ページならfooterなし
-複数ページなら既存pager footer / indicator
- shelf probeとlive cardは同じatom / footer条件
- state消滅時だけpager registration解除
- rotationは既存logical pager contractを使用

最大atomは「group一行＋target / continuation一行＋period四行＋既存chrome」とする。

`1920x1080`、`1512x982`、`1280x720`、`960x620`でgeometry testを行う。

-最小viewportでも最大atomがfeasible
- `data-page-viewport-overflow-keys`に`weatherWarningForecast`が現れない
- 128 periodの全atomへ到達可能
- pager partitionはatom境界だけ
-本文、pager、header、`RestoredChip`が重ならない
- coordinator / ARIA / preview文字列が名称規律を満たす

新しいpager UI、色、独自header帯は作らない。

### 3.14 裁定済み（2026-08-31・案 C）

#### C-1: legacy v1 projection に `appliedSemanticKey` が欠落する場合

新規writerではcanonical `appliedSemanticKey`とgate metadataを必須とする。案Cは、対象migration sourceのroot分類が次を満たすlegacy v1 projectionだけに適用する。

```ts
metadataRootState === "absent"
```

加えて、projectionの`appliedSemanticKey`が欠落し、対応し得るseenが存在しなければならない。

ご主人裁定により、**案C — projectionを捨て、seen-only tombstoneへ移行する**を採用する。

`present-array`と`present-invalid`は本節の「metadataなし」に含めない。

- empty `present-array`でもC-1へ進めない。
- 当該subjectのmetadata candidateがない`present-array`でもC-1へ進めない。
- malformed / duplicate metadata除外後にvalid candidateが0件でもC-1へ進めない。
- `present-invalid`を除外した結果を`absent`へ読み替えない。

metadata付きinputは§3.10を優先する。

- `cancelled: false` metadataがvalidなら、missing-key projectionを除外してactive gate-only watermarkを復元する。
- `cancelled: true` metadataならtombstoneを復元する。
- metadataが明示するgate statusをprojection欠落から推測し直さない。
- metadata付きbundleを本節のlegacy案Cで一律tombstone化しない。


legacy案Cのmigration契約は次とする。

1. trim後nonblankの`appliedSemanticKey`を持たないprojectionをactive projectionとして復元しない。
2. projectionのsubject keyと完全一致するseen key groupを§3.10の規則で取得する。
3. 同じseen keyを持つcandidateが一件だけの場合に限りrevision matchingへ進む。
4. 同じkeyのseenが別revisionで併存する場合もduplicateとし、全candidateを消費してbundle rejectionとする。
5. subject、reportTimeMs、normalized serialが一致することを確認する。
6. acceptedAtMsを`forgetAtMs - retention - 1`から復元する。
7. acceptedAtMsがmigration固定`nowMs + 15分`以下であることを確認する。
8. report time / Date範囲 / retention / report timeのacceptedAt＋15分条件を検証する。
9. zero match、duplicate key、revision mismatch、invalid serial、invalid retention、acceptedAt future-skew違反、report future-skew違反ではtombstoneを生成しない。
10. duplicate seenはsame / different revision、same / different `forgetAtMs`の全組でduplicateとする。
11. candidate seenのinput順を変えても結果を同じにする。
12. projectionと同key seen groupを一般fallbackへ再投入しない。
13. semantic key、hash、synthetic provenanceを生成しない。
14. card、`RestoredChip`、pager registrationを生成しない。
15. genuinely newerなlive VPWP50は通常active stateを再構築できる。

生成するtombstoneは次を満たす。

```ts
{
  domain: "weatherWarningTimeseries",
  revisionFamily: "VPWP50",
  stateSubjectKey: matchedSubjectKey,
  comparison: {
    stateSubjectKey: matchedSubjectKey,
    revision: {
      eventId: {
        raw: matchedSubjectKey,
        value: matchedSubjectKey,
        valid: true,
      },
      type: {
        raw: "VPWP50",
        value: "VPWP50",
        valid: true,
      },
      reportDateTime: {
        raw: new Date(seen.revision.reportTimeMs).toISOString(),
        epochMs: seen.revision.reportTimeMs,
        valid: true,
      },
      serial: normalizedSerialComparison,
      infoType: {
        raw: "取消",
        value: "取消",
        valid: true,
      },
    },
  },
  semanticKeys: [],
  cancelled: true,
  acceptedAtMs:
    seen.forgetAtMs - WEATHER_TIMESERIES_RETENTION_MS - 1,
  tombstoneRetentionMs: WEATHER_TIMESERIES_RETENTION_MS,
}
```

追加規則は次とする。

- comparison revisionは一意なseen key groupの一件から構成する。
- `eventId`はsubject-bound identityとする。
- typeは`VPWP50`、infoTypeは`取消`
- numeric serialはcanonical decimal、missingはraw / numeric null、valid false
- nonnumeric serialでは生成しない
- reportTimeMsはvalid Date範囲のsafe integer
- `acceptedAtMs <= migrationNowMs + VPWP50_ACCEPTED_AT_FUTURE_SKEW_MS`
- acceptedAtの15分ちょうどは許可、15分＋1msは拒否
- `reportTimeMs <= acceptedAtMs + VPWP50_REPORT_FUTURE_SKEW_MS`
- report timeの15分ちょうどは許可、15分＋1msは拒否
- acceptedAtMsをmigration nowMs / savedAtで置換しない
- `semanticKeys: []`、`cancelled: true`
- v1再保存時のforgetAtMsは元値と一致
- `acceptedAtMs + 7日`では保持し、＋1msで失効
- tombstone-only bundleをprojection欠落として破棄しない

strict fieldを再構成できない場合はpartial gateを生成しない。

- `vpwp50V1RevisionReconstructionFailed`を記録する。
- missing-key projectionと同key candidate seen全件をfallbackから復活させない。
- canonical rewriteを予約する。

`vpwp50V1MissingAppliedSemanticKey`を一subject bundleあたり一回記録する。diagnosticにはsubject、projection revision、seen key count、seen revisionsのbounded summary、raw / normalized serial、acceptedAt future-skew、report future-skew、projection破棄、tombstone生成成否を含める。

matching seen key groupが複数件の場合は、revision、forgetAtMsの大小またはinput順で一件を選ばない。

この裁定は`metadataRootState === "absent"`と確定したlegacy v1 migration inputだけに適用する。empty arrayを含む`present-array`、`present-invalid`、新規writer、v2 canonical dataには適用しない。keyが欠落する新形式projectionはmalformed subjectとして除外する。keyが存在するがnon-canonicalなprojectionも本節のmissing-key案Cへ流さない。

## 4. 対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/types.ts` | 全 Significancy occurrence、Area / Local identity、`tsNum`、absolute slot の runtime 型 |
| `src/dmdata/timeseries-common.ts` | strict DateTime / Duration 解決、duplicate timeId 検出 |
| `src/dmdata/weather-warning-timeseries-parser.ts` | 全 occurrence 保持、absolute slot、Area / Local code・name identity、duplicate Local |
| `src/dmdata/weather-warning-timeseries-significancy.ts` | Code registry、`KIND_NAME_MAP`、engine forecast label生成の参照元 |
| `src/engine/presentation/weather-severity-pyramid.ts` | 既存 `flattenEntries()` 維持、card 専用 `projectForecastOccurrences()` |
| `src/engine/messages/revision-family-registry.ts` | durable 化、7日 retention、admission 前 active retention、512 subject、`rejectNewSubject` capacity mode |
| `src/engine/messages/telegram-revision-gate.ts` | detailed family expiry、read-only family subject keys、VPWP50 no-eviction capacity preflight |
| `src/engine/presentation/processors/process-standby-foundation.ts` | VPWP50 admission直前expiry、active subject保護集合、513件目gate前拒否 |
| `src/engine/presentation/processors/process-message.ts` | pre-admission expiry / capacity result の伝播 |
| `src/engine/messages/message-router.ts` | expiry callback / durable mutation wiring |
| `src/engine/display/standby-state-store.ts` | reducer、active subject snapshot、prospective card count / wire budget、nested fail-closed cleanup、snapshot、sweep、export、restore |
| `src/engine/display/weather-warning-forecast-active-reducer.ts` | subject reducer、forecast label、Area / Local target identity、group内duplicate scope、partition後period merge、JST label、card全体period上限 |
| `src/engine/display/weather-warning-forecast-wire.ts` | 新規。canonical card構築、period総数、UTF-8 JSON byte計測、64KiB invariant |
| `src/engine/display/protocol.ts` | DTO、target scope / Local code、group code、period tsNum、`weatherWarningForecast` kind |
| `display/frontend/src/lib/protocol.ts` | engine protocol との同期 |
| `src/engine/display/standby-registry.ts` | card policy、priority |
| `src/engine/display/standby-persistence.ts` | string / count / wire上限、nested raw preflight、全group横断identity、metadata raw subject claim、acceptedAt future-skew、seen key bundle、capacity salvage、strict migration、dual-write、coupling |
| `src/engine/monitor/monitor.ts` | gate export、startup / 60秒 / admission mutation の保存 |
| `src/engine/messages/vpwp50-detail-cache.ts` | runtime-only field の偶発保存防止 |
| `display/frontend/src/components/WeatherWarningForecastCard.svelte` | card、engine生成label、Local target、continuation atom |
| `display/frontend/src/components/StandbyScreen.svelte` | kind、candidate、render、measurement、pager 登録 |
| `display/frontend/src/lib/legacy-standby/types.ts` | card / partition / pageable key |
| `display/frontend/src/lib/legacy-standby/time-slice-scheduler.svelte.ts` | pager runtime、continuation fingerprint、label |
| `display/frontend/src/lib/legacy-standby/solver.ts` | center / rotation 登録、candidate pass 7 |
| `display/frontend/src/preview/LegacyImprovedMock.svelte` | pager record、forecastLabel代表値、Code 21 / 22、128-period preview |
| `display/scripts/capture-legacy-standby.mjs` | 960x620 を含む continuation geometry contract |
| `test/dmdata/weather-warning-timeseries-parser.test.ts` | 全 occurrence、Area / Local identity、empty / duplicate Local、invalid / duplicate TimeDefine |
| `test/ui/weather-severity-pyramid.test.ts` | worst 非回帰、forecastLabel静的表、Code 21 / 22、known / unknown 共存 |
| `test/engine/telegram-foundation/phase3a-revision-gate.test.ts` | startup / timer / admission前7日境界、512 / 513 no-eviction |
| `test/engine/telegram-foundation/phase3b-standby-domains.test.ts` | durable policy、active protection、capacity rejection、訂正、取消、v1/v2同値 |
| `test/engine/display/standby-state-store.test.ts` | reducer、active subject snapshot、source / semantic / nested / card wire capacity fail-closed、period expiry、restore |
| `test/engine/display/standby-persistence.test.ts` | string / count / wire上限、nested raw preflight、persisted identity、metadata subject claim、acceptedAt、duplicate seen key、bundle capacity、dual-write、旧実データ |
| `test/engine/display/sse-clients.test.ts` | 128 period・64KiB最大cardを含むsnapshot / stateの`encodeSseGuarded()`境界 |
| `test/engine/display/http-server.test.ts` | 最大VPWP50 cardと既存max snapshot fixtureの縮退後wire通過、standbyItems非縮退 |
| `test/engine/display/standby-wiring.test.ts` | startup / 60秒 / admission 保存予約 |
| `test/engine/display/protocol-sync.test.ts` | engine / frontend protocol 同期 |
| `display/frontend/src/components/__tests__/weather-warning-forecast-card.test.ts` | DTO再帰文字列、forecastLabel、Area / Local一意label、JST label、continuation、ARIA |
| `display/frontend/src/components/__tests__/standby.test.ts` | StandbyScreen、128-period overflow、Area label、geometry |
| `display/frontend/src/preview/__tests__/legacy-improved-mock.test.ts` | recursive strings、forecastLabel、Area / Local label、128-period preview、solver pass |
| `display/frontend/src/lib/legacy-standby/__tests__/page-partition.test.ts` | continuation atom partition |
| `display/frontend/src/lib/legacy-standby/__tests__/time-slice-scheduler.test.ts` | atom fingerprint、進行、解除 |
| `display/frontend/src/lib/legacy-standby/__tests__/solver.test.ts` | rotation 7 candidate、bounded pass |
| `test/fixtures/vpwp50-forecast-expectations.json` | 固定時計、occurrence、forecastLabel、period、Area / Local label、JST label、count / wire boundary |
| `test/fixtures/81_09_01_260605_VPWP50_local_identity.xml` | codeあり / code-less / duplicate / conflict Local synthetic fixture |
| `test/fixtures/standby-persistence/operational-v1-anonymized.json` | 実運用旧 v1 fixture |
| `test/fixtures/standby-persistence/operational-v2-anonymized.json` | 実運用旧 v2 fixture |
| `test/fixtures/standby-persistence/operational-expectations.json` | 固定時計、JSON Pointer、明示値置換 allowlist |

parser route、既存 VPWP50 CLI formatter、ticker sentence、notifier の既存 worst 出力契約は変更しない。

## 5. テスト観点

### 5.1 実 VPWP50 と全 occurrence

各実 XML fixture は `vpwp50-forecast-expectations.json` の `nowMs` で fake system time を固定し、parserからfrontend DTOまで通す。合成DTOだけで受入済みにしない。

- `FIXTURE_VPWP50_NAGANO` 等でTimeDefineをabsolute slotへ変換する。
- parserが全Significancyを`tsNum`、`timeRef`、slot付きで保持する。
- CLI / ticker用`significancyWorst` / `flattenEntries()`を変更しない。
- card projectorがworst以外のvisible occurrenceも返す。
- criteria-period fixtureでL4 refID 1 / 2、L3 refID 3、L2 refID 4を保持する。
- L4終了後はL3 / L2、L3終了後はL2を残し、L2終了時にsubjectを消す。
- high-severity fixtureで特別警報級後の警報級・注意報級を失わない。
- unknown fixtureでCode 31 / 99を同時表示する。
- parser→reducer→snapshot→protocol→frontendの対応を確認する。

Code 21 / 22共存fixtureで次を確認する。

- 公式labelがそれぞれ「警戒レベル2」「警戒レベル2相当」。
- 同じ`displaySeverity`でも別group。
- group key、code、forecastLabelが異なる。
- DTO、DOM、ARIA、pager fingerprintで相互置換されない。
- occurrence順を逆転しても同じ結果。

Area identity fixtureを追加する。

| raw Area入力 | canonical code | canonical name | identity / 期待 |
|---|---|---|---|
| Code欠落、Name ` 長野県　北部 ` | null | `長野県 北部` | `name:長野県 北部` |
| Code ` 200010 `、Name `長野県北部` | `200010` | `長野県北部` | `code:200010` |
| 同code `200010`、同nameのduplicate | `200010` | 同一 | occurrence結合 |
| 同code `200010`、name `長野県北部` / `長野県南部` | — | conflict | 当該Area identity全除外 |
| code `200010` / `200020`、同name | 各code | 同一 | 別Area identity、表示labelも別 |

- Area code-name conflictをsubject全体のProperty / seriesで検出する。
- conflict Areaのbase / Local candidateをすべて除外する。
- 正常な別Areaは維持する。
- code-less同名を別series間で同じidentityへ集約する。
- codeあり同名Areaとcode-less Areaを区別する。
- input Area / series順を逆転してもtarget、period、diagnosticを一致させる。
- code `200010` / `200020`、同nameのAreaを同じgroupに入れ、別targetとして保持する。
- 前項のDOM、`title`、ARIA、pager、coordinator、preview labelをそれぞれ`名称（200010）` / `名称（200020）`へ固定する。
- code-less Areaは名称だけのlabelとする。

duplicate target scopeを独立試験にする。

1. 同じsubject / Area identityを雨groupと風groupの双方へ入れる。
2. target key自体は両groupで同一になることを確認する。
3. `(rainGroupKey, targetKey)`と`(windGroupKey, targetKey)`が別の正常identityとなることを確認する。
4. 雨・風の両group、両target、両periodを維持する。
5. 同一group内へ同じtarget keyを二件入れた場合だけ当該groupのidentity bundleを拒否する。
6. group / target入力順を逆転しても同じ結果とする。

各ケースで次を確認する。

- parserがcanonical `code`、`areaName`、`identityKey`を保持する。
- reducerがsubject＋親Area identity＋Local identityからtarget keyを作る。
- conflict scopeとtarget key componentが一致する。
- input Local、Property、series順を逆転してもtarget、period、diagnosticが一致する。
- Local conflictが正常な別Local、親Area base、別Areaへ波及しない。
- Area conflictだけはそのArea配下のLocalへ連動する。
- DTOの`scope`、`name`、`parentAreaName`、`areaCode`、`localCode`が期待値と一致する。
- §3.11のtarget labelをDOM、ARIA、pager、previewで静的期待値と比較する。
- 親Area A / Bの同名Local `沿岸`が異なる完全labelになる。

### 5.2 複数官署 scope

- 同じ対象地域で発表官署が異なる二 subject が共存する。
- 同じ官署で対象地域コードが異なる二 subject が共存する。
- 一方の訂正が他方を置換しない。
- 一方の取消が他方を削除しない。
- outer card は全 active subject を集約する。
- 同名・別コード地域を誤って統合しない。

### 5.3 訂正・取消・旧報と gate retention

- 新しい通常報が同一 subject を置換する。
- 同 revision の受理済み訂正が一度だけ置換される。
- 同じ訂正の replay は抑止される。
- 古い通常報は retention 内の state を変更しない。
- 取消は対象 subject を即時削除する。
- 取消後の旧報は retention 内では state を復活させない。
- durable gate restore 後も retention 内の旧報を拒否する。
- 取消後に、より新しい正規報が来れば active state を作れる。

active watermark と cancellation tombstone の双方について、acceptedAt を `T0` として次の境界を固定する。

| 時刻 | v2 gate | v1 seen / migration | 旧報判定 |
|---|---|---|---|
| `T0 + 7日 - 1ms` | 残る | 残る | 拒否 |
| `T0 + 7日` | 残る | 残る | 拒否 |
| `T0 + 7日 + 1ms` | 消える | 消える | retention による拒否なし |

次の admission test では startup sweep、60秒 sweep、手動 `expireRevisionFamily()` を呼ばない。

1. `T0` で active watermark または cancellation tombstone を作る。
2. timer を進めず、次の入力の `meta.receivedAtMs` を境界時刻に設定する。
3. VPWP50 を通常の `processStandbyFoundation()` 経路へ投入する。
4. admission 直前 expiry と、その後の gate decision を検査する。

期待値は次とする。

- `T0 + 7日` の入力では旧 gate が残り、同一または古い report を拒否する。
- `T0 + 7日 + 1ms` の入力では、gate decision 前に旧 gate が消える。
- 境界後の report は、期限切れ gate だけを理由に拒否されない。
- incoming report が他の理由で invalid / rejected でも、pre-admission expiry は commit される。
- expired subject の既存 projection が削除される。
- expiry と projection cleanup が durable mutation になる。
- incoming decision が rejected でも canonical 保存が予約される。
- incoming が accepted して同 subject を再作成する場合、expiry cleanup と replacement が一回の保存予約へ合流する。
- active watermark と tombstone の双方で同じ結果になる。

さらに次を確認する。

- 起動時 restore 直後に期限超過 gate が削除され、canonical rewrite が一回予約される。
- 60秒 sweep で期限超過 gate が削除され、foundation durable mutation として保存される。
- active watermark expiry と period expiry が同じ sweep で起きても保存予約は一回。
- v2 canonical と v1 rollback を reload し、境界の各時刻で同じ判定になる。
- active projection が gate より長く残る異常 fixture では projection も削除され、診断が記録される。

### 5.4 slot → period と予測期限

すべての時刻試験で `vi.useFakeTimers()` と `vi.setSystemTime()` を使用し、reducer / restore へ同じ `nowMs` を渡す。

基本境界は次とする。

- `nowMs === endsAtMs - 1` では period が active。
- `nowMs === endsAtMs` では period が active projection から除外される。
- 複数 period の一部だけが終了した場合、終了分だけを削除する。
- group 内の最後の period が終了したら target を削除する。
- target がなくなった group を削除する。
- group がなくなった subject を削除する。
- 全 subject がなくなったら card を削除する。
- expiry sweep が view と durable state の双方を更新する。
- restore によって予測期間を延長しない。

slot 解決と period 変換は次の表を自動試験にする。

| 入力 | 期待結果 |
|---|---|
| 同一 partition で gap | 別 period |
| 同一 partition で端点接続 | 一つの連続 period |
| 同一 partition で overlap | 区間和集合となる一 period |
| 接続するが code / label / severity が異なる | 別 partition、別 period |
| 同一 slot の完全 duplicate | 一件へ畳む |
| 同一 series の duplicate TimeDefine ID | その refID だけ unresolved |
| 複数 refID の一件だけ参照先欠落 | 解決済み slot は残る |
| 別 series に同名 refID | cross-series 解決しない |
| timezone なし DateTime | 当該 slot だけ除外 |
| parse 不能 DateTime | 当該 slot だけ除外 |
| 空、0、負、小数、year / month / week Duration | 当該 slot だけ除外 |
| end が Date 範囲外 | 当該 slot だけ除外 |
| 入力 occurrence 順を逆転 | period と key が同一 |

partition 後 merge を専用試験にする。

```text
A: code=21, [0,10]
B: code=22, [1,2]
A: code=21, [2,12]
```

期待値は次とする。

- A と B を先に別 partition へ分ける。
- A の二区間を `[0,12]` へ結合する。
- B は `[1,2]` のまま残る。
- 入力順を `A-B-A`、`A-A-B`、逆順にしても結果が同一。
- 単一時刻列の current accumulator により A が二 period へ分裂しない。

JST label は equivalent instant と calendar boundary を固定する。

- `2026-06-05T21:00:00Z` と `2026-06-06T06:00:00+09:00` から同じ label を得る。
- 同日: `6月6日 06:00–09:00`
- 日跨ぎ: `6月6日 23:00–6月7日 02:00`
- 月跨ぎ: `6月30日 23:00–7月1日 02:00`
- 年跨ぎ: `2026年12月31日 23:00–2027年1月1日 02:00`
- test process の `TZ` を UTC / Asia/Tokyo に変えても結果が同じ。
- frontend browser timezone を変えても engine label をそのまま表示する。

日本語の TimeDefine.Name、numeric refID の連番、reportDateTime＋固定 TTL から期限や接続を推測しない。

### 5.5 unknown severity

- unknown-only Property の occurrence を欠落させない。
- known code と unknown code が同じ Property に存在しても、両 occurrence を保持する。
- `81_03_01_260605_VPWP50_unknown_code.xml` の Code 31 / refID 1 と Code 99 / refID 2 が同時に card projection へ現れる。
- Code 31 の period 終了後も Code 99 が有効なら unknown group を残す。
- `displaySeverity: "unknown"` を維持する。
- 行ラベルは「区分不明」とし、警報級・注意報級を推測しない。
- card header は既存の見落とし防止規則に従い、unknown-only なら最低 warning 色になる。
- unknown と既知 critical が共存した場合、critical header を降格させない。

### 5.6 名称規律の機械試験

`vpwp50ForecastLabel()`をengine単体で静的表試験する。

| raw Property.Type | Code | DTO `forecastLabel` |
|---|---:|---|
| `雨` | 20 | `大雨注意報級の予測` |
| `雨` | 30 | `大雨警報級の予測` |
| `雨` | 50 | `大雨特別警報級の予測` |
| `風` | 20 | `強風注意報級の予測` |
| `風` | 30 | `暴風警報級の予測` |
| `風` | 50 | `暴風特別警報級の予測` |
| `雷` | 20 | `雷注意報級の予測` |
| `土砂災害危険度` | 21 | `土砂災害（警戒レベル2）の予測` |
| `土砂災害危険度` | 22 | `土砂災害（警戒レベル2相当）の予測` |
| `土砂災害危険度` | 31 | `土砂災害（警戒レベル3相当）の予測` |
| `高潮危険度` | 41 | `高潮（警戒レベル4相当）の予測` |
| `土砂災害危険度` | 51 | `土砂災害（警戒レベル5相当）の予測` |
| `雷` | 99 | `雷（区分不明）の予測` |

Code 00 / 01 / 11の非visible入力ではlabel生成結果が`null`となり、groupを生成しない。

各代表値は次の全段で同じ文字列を静的期待値として持つ。

- engine projector戻り値
- protocol DTOの`forecastLabel`
- persistence export / reload後の`forecastLabel`
- preview fixture
- DOM text
- ARIA / accessible name
- pager coordinator record

frontendがphenomenon、code、severityからlabelを再生成して一致したように見せる試験は禁止する。DTOの`forecastLabel`自体をassertする。

test helper は、指定された DTO / record subtree を再帰走査して全 string leaf を収集する。

```ts
function collectStringLeaves(value: unknown): string[];
```

契約は次とする。

- object の全 own enumerable value を再帰走査する。
- array の全要素を再帰走査する。
- string value は field 名にかかわらず全て収集する。
- `forecastLabel`、title、label 等の手動 field allowlist を使用しない。
- null、number、boolean は収集しない。
- cycle を受け取らない protocol / fixture DTO に限定する。

対象は次とする。

- engine DTO の `weatherWarningForecast` subtree
- pager coordinator の該当 record
- preview fixture の該当 subtree
- measurement、probe、rotation snapshot の該当 subtree

rendered card root では次を全て収集する。

- text node
- `aria-*`
- `title`
- computed accessible name
- pager footer / indicator text

雷由来の test case では、収集した全 string のいずれにも次が含まれないことを検証する。

```text
竜巻注意情報
竜巻
突風
```

検査 scope は `weatherWarningForecast` に限定し、既存 tornado card の文字列を混ぜない。

併せて次を確認する。

- frontend が `forecastLabel` を改変せず描画する。
- pager coordinator label が「気象警報予測」。
- preview と production render の名称が一致する。
- 雷 entry が tornado state、card、subject、pager を生成しない。
- DTO に将来 optional string field を追加した場合も、helper 変更なしで検査対象になる。

### 5.7 pager overflow と layout solver

pagerについて次を確認する。

-一ページに収まる場合はfooterを表示しない。
-多数現象・地域では複数ページへ分割する。
-全anchor atomがいずれか一ページに現れる。
-現象名、対象地域、予測時間帯の対応が崩れない。
-訂正またはperiod expiryで必要なfingerprintだけが更新される。
-active page削除時に安定したsuccessorを選ぶ。
-card消滅時にpager stateを解除する。
-side、center、rotationでoverflowしない。
-footer、本文、`RestoredChip`が重ならない。

単一target fixtureと多数target分散fixtureを分けてgeometry / pager試験する。

単一targetに128 periodを入れるfixtureでは次を確認する。

- `WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM === 4`
- fresh projectionで128 periodが32 anchor / atomへ分割される
- 各atomのperiod数が1〜4
- period欠落・重複・順序逆転なし
- 全period keyが一atomへちょうど一回所属
- atom identityがgroup key、target key、`pagerAnchorKey`から構成される
- first / last period key、period count、continuation indexをidentityへ含めない
- `pagerAnchorOrdinal` / `pagerSlot`がfull canonical listから決定的に割り当てられる
- anchor keyがsubject revision、group、target、ordinalから再計算できる
- `960x620`で最大atomがfeasible
- 全32 atomへpager操作または時間進行で到達可能
- accessible nameにellipsis前の全文が残る
- 既存muted textとpager footerを使用する

一般形のworst-caseとして、一groupに128 targetを置き、各targetへ一periodだけを持たせるfixtureを追加する。

- subject / cardのperiod総数は128
- target数はcanonical上限128
- 各targetが独立したpartitionとなる
- `Σ ceil(1 / 4) === 128`により128 atomとなる
- atomを異なるtarget間でまとめない
- 全128 atomへ到達可能
- target label、period label、ARIA、coordinator labelの対応が崩れない
- 最小viewportでも一atom単位ではfeasible
- `data-page-viewport-overflow-keys`に`weatherWarningForecast`が現れない
- side、center、rotationの全surfaceで本文、footer、header、`RestoredChip`が重ならない
- atom投入順またはtarget入力順を逆転してもcanonical pager順とpage partitionが一致する

mixed partition fixtureでは、period数`[1, 2, 4, 5, 7, 109]`について、atom数が`Σ ceil(nᵢ / 4)`と一致することを確認する。

expiry anchor fixtureを独立させる。

1. period 0〜11を3 anchorへ割り当てる。
2. anchor 0の先頭periodだけをexpiryさせる。
3.同anchorの残存periodが元のanchor key / ordinal / slotを維持する。
4. anchor 1 / 2のidentityとregistrationが変化しない。
5. anchor 0の全periodをexpiryさせる。
6. anchor 0だけが消え、anchor 1 / 2をrenumberしない。
7. continuation表示のn/mが変化してもatom identityは変化しない。
8. save → reload後もanchor gapとidentityを維持する。
9. genuinely newer reportによるprojection全置換では新revision anchorへ更新できる。
10. expiryによって後続atomを総削除・再登録していないことをcoordinator spyで確認する。

layout solverについて次を確認する。

- `CENTER_ELIGIBLE_KEYS`に`weatherWarningForecast`
- `ROTATION_REVERSE_ORDER`に既定関係
- `MAX_ROTATION_CANDIDATE_PASSES === 7`
- 7件目まで評価
-全candidateをdisplayed / failedへ決定的分類
-入力順を変えても最終solutionが安定
- preview source contractが固定値7を検査

### 5.8 復元、coupling、domain-local salvage

- 有効な複数subjectをexport→restoreできる。
- restored active projectionは`restored: true`。
- 一件以上のrestored active pairがあればcardと`RestoredChip`を表示する。
- live更新subjectは`restored: false`。
- restore時点で期限切れperiodは表示しない。
- projection / gateのsubject、revision、semantic key不一致ではprojectionを復元しない。
- gate-only / tombstone-onlyからcard、chip、pagerを生成しない。
- blank / 上限超過sourceEventId、blank / non-canonical appliedSemanticKeyを復元しない。

`phenomenonName` / `forecastLabel` couplingをlive→export→restoreで固定する。

- normalized raw `Property.Type`をparserからprojectorへ渡す。
- live `phenomenonName`がそのstringと一致する。
- DTO labelが`vpwp50ForecastLabel()`静的期待値と一致する。
- group keyをphenomenon、code、label、severityから再計算できる。
- export後も翻訳・短縮・severity名へ置換しない。
- restore後も同じidentityになる。
- persisted fieldの一部改変を除外し、暗黙修復しない。

live subject capacityをparser→provider→gate→reducerの統合試験にする。

512 bundle fixtureはwire-validなactive pairと表示なしbundleを分離して構成する。

- active pair 128件。各projectionは一periodだけを持つ。
- active gate-only watermark 192件。
- tombstone-only bundle 192件。
- gate family bundle総数は512件。
- active projection period総数は128件。
- canonical card JSONは64KiB以下となる短いfixture値を使用し、実byte数をassertする。

試験手順は次とする。

1. gateへ512 subject bundleを用意する。
2. VPWP50 forecast projection mapへactive pair 128件だけを用意する。
3. `revisionFamilySubjectKeys()`が512件を重複なし・辞書順で返す。
4. `activeWeatherWarningForecastSubjects(nowMs)`がactive projectionの128 subjectだけを重複なし・辞書順で返す。
5. gate capacity preflightが512件のfamily subject総数を使用する。
6. protection provider結果として128 active subjectだけを`activeFamilySubjects`へ供給する。
7. 513件目のvalid VPWP50を投入する。
8. gate mutation前に`capacityExceeded`、`accepted: false`となる。
9. 513件目のgate / watermark / projectionを作らない。
10. 既存512 gate bundleをevictしない。
11. 既存128 active projectionを削除しない。
12. gate-only / tombstone-only bundleをactive projectionとして誤分類しない。
13. eviction metadata / managed deletionを発生させない。
14. reducerを呼ばない。
15. detail cache、notifier state、保存予約を変更しない。
16. diagnosticを一回記録する。
17. reload後も512 gate bundleと128 active projectionを保持する。
18. reload後のproviderも128 active subjectだけを返す。
19. retained gate-only / tombstone-only bundleからcard、chip、pagerを生成しない。

511→512受理境界は別fixtureとする。

- active pair 127件×一period
- gate-only / tombstone-only 384件
- gate bundle総数511件
- 新規active一件を受理した後、gate bundle512件、active pair128件、card period128件となる
- providerは受理前127件、受理後128件を返す
- prospective cardが64KiB以下であることを確認する

補助境界は次とする。

- 512件時のexisting update / cancellationは通常ordering。
- admission前expiryで空きができれば新規subjectを受理。
- capacity rejection単独は`durableChanged: false`。
- 同callのpre-admission expiryだけはdurable changeとして保存。
- active gate-onlyをvictimにして新規subjectを受理しない。
- provider件数128だけをfamily subject総数と誤認しない。
- existing gate-only subjectをactiveへ更新した結果cardが129 periodになる場合、gateは通常orderingで受理するがprojectionはwire fail-closedとなり、gate-onlyのまま残る。

nested live limitは、各階層の宣言上限だけでなく、subject period予算、card period予算、64KiB byte予算を合わせた実効上限で検査する。

- non-nullかつ1以上の`effectiveLimit` fixtureでは、`effectiveLimit - 1`と
  `effectiveLimit`を受理する。
- non-null `effectiveLimit`では`effectiveLimit + 1`を切り詰めずprojection全体として
  拒否する。`null`では加減算せず、別枝のno-solution goldenを適用する。
- local hierarchy limitが大きくても、上位periodまたはbyte予算が先に尽きれば、その小さい値を実効上限とする。
- limit受理fixtureは他階層のinvariantをすべて満たす生成可能な構成にする。
- 既存projectionがある場合だけ`viewChanged: true`。
- gate mutationを含むaggregateは`durableChanged: true`。
- 全違反reasonをcanonical順の単一配列として記録する。
- limit+1 runtime stateをwriterへ渡さない。
- 別subjectの正常projectionをevictしない。

count境界はwire byte上限とのANDで固定する。宣言上限128を、そのshapeが64KiBに
収まるという意味へ読み替えない。

| 検査対象 | count fixture | 期待 |
|---|---|---|
| group / subject | 各groupに一target・一period | 下記の固定shapeでは100 / 101受理、102はbyte超過、128はcount内だがbyte超過、129は複合違反 |
| target / group | 一group、各targetに一period | 127 / 128受理、129はtarget・subject period・card period違反 |
| period / target | 一group・一target | 127 / 128受理、129はperiod・subject period・card period違反 |
| subject total period | 任意の合法partition | 127 / 128受理、129拒否 |
| card total period | 複数subjectへ分散可 | 127 / 128受理、129拒否 |
| anchor内period | 同一target・同一anchor | 3 / 4受理、5拒否 |

group fixtureはkey encodingとbyte期待値を一意にするため、次の値を固定する。

- subject: `weatherTimeseries:a:scope:all`
- source ID / office / target name: `a`
- code-less Area identity: `name:a`
- group `i`（`i = 0..groupCount - 1`）: `phenomenonName: "雨"`、`significancyCode: "u${i}"`、
  `forecastLabel: "大雨（区分不明）の予測"`、`displaySeverity: "unknown"`、
  `severity: "warning"`
- period: `tsNum: 1`、series `3h`、
  `2026-01-01T00:00:00.000Z`〜`2026-01-01T01:00:00.000Z`、
  label `1月1日 09:00–10:00`
- derived keyはすべて§3.2の43文字`vpwp50StableKey()`
- outer itemは§3.6の全fieldを持ち、`restored: false`

このliteral shapeのUTF-8 JSON byte静的期待値は次とする。

| group数 | bytes | 期待 |
|---:|---:|---|
| 100 | `64,845` | 受理 |
| 101 | `65,492` | 受理 |
| 102 | `66,139` | `cardJsonBytes`で拒否 |
| 128 | `82,961` | countは宣言上限内だが`cardJsonBytes`で拒否 |
| 129 | `83,608` | 下記4reasonで拒否 |

byte値はproduction helperから期待値を作らず、fixture JSONにliteralとして保存する。
fixture loaderが実itemを構成して`Buffer.byteLength(JSON.stringify(item), "utf8")`と
比較する。derived keyをlength-prefixed raw tupleやhex digestへ変えるとこのgoldenが
失敗し、encoder変更を暗黙に許さない。

129 group fixtureの`reasons`は次の4件とする。全entryの必須`samplePaths`も比較対象
から外さない。

```json
[
  {
    "code": "groupsPerSubject",
    "actual": 129,
    "declaredLimit": 128,
    "effectiveLimit": 101,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "groupsPerSubject",
      "periodsPerSubject",
      "periodsPerCard",
      "cardJsonBytes"
    ],
    "samplePaths": [
      "subjects/weatherTimeseries:a:scope:all/groups"
    ]
  },
  {
    "code": "periodsPerSubject",
    "actual": 129,
    "declaredLimit": 128,
    "effectiveLimit": 101,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "periodsPerSubject",
      "periodsPerCard",
      "cardJsonBytes"
    ],
    "samplePaths": [
      "subjects/weatherTimeseries:a:scope:all/periods"
    ]
  },
  {
    "code": "periodsPerCard",
    "actual": 129,
    "declaredLimit": 128,
    "effectiveLimit": 101,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "periodsPerCard",
      "cardJsonBytes"
    ],
    "samplePaths": [
      "card/weatherWarningForecast:active/periods"
    ]
  },
  {
    "code": "cardJsonBytes",
    "actual": 83608,
    "declaredLimit": 65536,
    "effectiveLimit": 65536,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "cardJsonBytes"
    ],
    "samplePaths": [
      "card/weatherWarningForecast:active/jsonBytes"
    ]
  }
]
```

次を確認する。

- `reasons`が上記順・上記4件・全fieldで完全一致する。
- `samplePaths`を比較対象から除外せず、空配列で代用しない。
- 最初の`groupsPerSubject`または`cardJsonBytes`だけを記録して終了しない。
- group配列を逆転してもreason配列と集約値が一致する。
- local unitの`samplePaths`はcanonical key順の先頭8件、subject / card unitは上記
  canonical path一件となる。
- writerへ同じcandidateを渡した場合はsalvageせずfail-loudとなる。

複数local unitの`effectiveLimit`集約は、period / target fixtureで独立に固定する。

1. 一subject・一groupに、canonical target keyが異なる二targetを置く。
2. 各targetへ129 periodを置き、各anchorは最大4 period、他のnested invariantは全て
   満たす。短いauthoritative stringを使い、各targetのcanonical先頭64 period、合計
   128 periodから作るcardが64KiB以下であることを実byte数でassertする。
3. original candidateの`periodsPerTarget` reasonは`actual: 129`、
   `violatingUnitCount: 2`とする。
4. 二targetへ同じcandidate `N`を同時適用すると、`N = 64`は合計128 periodで全制約を
   満たし、`N = 65`は合計130 periodでsubject / card period上限を超える。したがって
   `periodsPerTarget.effectiveLimit === 64`とする。
5. targetごとに単独計算した128を採用すること、一方を128・他方を0へすること、先頭
   targetを先に縮めた残予算から後続targetの値を求めることを禁止する。
6. `samplePaths`は二targetのescaped canonical path昇順とする。
7. target arrayと各targetのperiod arrayをともに反転したfixtureでも、reason全field、
   common `effectiveLimit`、prospective 64 / 65境界を完全一致させる。

混合reasonのno-solution branchは、前項とは別fixture / goldenにする。

- subjectは`weatherTimeseries:a:scope:all`とする。
- group Aは`phenomenonName: "雨"`、`significancyCode: "uA"`、
  `forecastLabel: "大雨（区分不明）の予測"`、`displaySeverity: "unknown"`、
  `severity: "warning"`とする。target `i = 0..128`のcode-less Area nameは
  `i.toString(36)`とし、各targetに一periodを置く。
- group Bはgroup Aの`significancyCode`だけを`"uB"`へ変え、code-less Area target
  `name:b`を一件、そのtargetへ129 periodを置く。
- 全periodは`tsNum: 1`、series `3h`とする。group Aのperiodは全て
  `2026-01-01T00:00:00.000Z`〜`01:00:00.000Z`、group Bのperiod `i`は同基点から
  `2 * i`時間後に開始し一時間後に終了する。JST labelは§3.4 helperで生成する。
- anchor計算用revisionは`reportTimeMs: 1767139200000`、normalized serial `"1"`とし、
  periodをtargetごとにcanonical順で最大4件ずつanchorへ割り当てる。両groupの他fieldも
  deep-validにする。
- original candidateは258 periodで、`targetsPerGroup`、`periodsPerTarget`、
  `periodsPerSubject`、`periodsPerCard`、`cardJsonBytes`の全reasonを持つ。
- card outerはkey `weatherWarningForecast:active`、source IDs `["a"]`、updatedAt
  `2025-12-31T00:00:00.000Z`、original expiresAt `2026-01-11T17:00:00.000Z`、
  `restored: false`、severity `warning`、surface `corner-right`とする。
- UTF-8 JSON byte goldenはgroup Aだけ`56,254`、group Bだけ`37,596`、original
  candidate `93,595`とする。前二件は129 periodでも64KiB以下なので、null reasonの
  `limitingHierarchies`へ`cardJsonBytes`を入れない。
- subject / card periodのcanonical flattened順ではgroup Aが先となり、N=128のprefix
  cardは`55,821` bytesで全制約を満たす。N=129ではgroup Aの129 target違反が成立する
  ため、`periodsPerSubject`と`periodsPerCard`の`effectiveLimit`は128とする。

group A key、group B key、group B target keyはfixture expectationへ次のliteralを置き、
production diagnosticから期待値を生成しない。

```text
group A:       twH0dYevGFciRxiBDeYhCmLcIFrctn4k_6Z7Pz4QAS8
group B:       VnV-CHEOKdaXAKEQb6L-4l3enTedkvIyVan0w-MDoC8
group B target:yTVprt4v2XxZLreTuIY6ufL9Oxu_nlKQE9CrgX5H9bc
```

`targetsPerGroup`だけを調整するとN=0でもgroup Bの129 period targetが残り、
`periodsPerTarget`だけを調整するとN=0でもgroup Aの129 targetが残る。両reasonの
`A_code`がemptyであることをN=0〜128の全候補評価で確認し、次をfull no-solution
reason goldenとする。

```json
[
  {
    "code": "targetsPerGroup",
    "actual": 129,
    "declaredLimit": 128,
    "effectiveLimit": null,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "targetsPerGroup",
      "periodsPerTarget",
      "periodsPerSubject",
      "periodsPerCard"
    ],
    "samplePaths": [
      "subjects/weatherTimeseries:a:scope:all/groups/twH0dYevGFciRxiBDeYhCmLcIFrctn4k_6Z7Pz4QAS8/targets"
    ]
  },
  {
    "code": "periodsPerTarget",
    "actual": 129,
    "declaredLimit": 128,
    "effectiveLimit": null,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "targetsPerGroup",
      "periodsPerTarget",
      "periodsPerSubject",
      "periodsPerCard"
    ],
    "samplePaths": [
      "subjects/weatherTimeseries:a:scope:all/groups/VnV-CHEOKdaXAKEQb6L-4l3enTedkvIyVan0w-MDoC8/targets/yTVprt4v2XxZLreTuIY6ufL9Oxu_nlKQE9CrgX5H9bc/periods"
    ]
  },
  {
    "code": "periodsPerSubject",
    "actual": 258,
    "declaredLimit": 128,
    "effectiveLimit": 128,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "periodsPerSubject",
      "periodsPerCard",
      "cardJsonBytes"
    ],
    "samplePaths": [
      "subjects/weatherTimeseries:a:scope:all/periods"
    ]
  },
  {
    "code": "periodsPerCard",
    "actual": 258,
    "declaredLimit": 128,
    "effectiveLimit": 128,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "periodsPerCard",
      "cardJsonBytes"
    ],
    "samplePaths": [
      "card/weatherWarningForecast:active/periods"
    ]
  },
  {
    "code": "cardJsonBytes",
    "actual": 93595,
    "declaredLimit": 65536,
    "effectiveLimit": 65536,
    "violatingUnitCount": 1,
    "limitingHierarchies": [
      "cardJsonBytes"
    ],
    "samplePaths": [
      "card/weatherWarningForecast:active/jsonBytes"
    ]
  }
]
```

- 上記五reasonの全fieldとoriginal `cardJsonBytes.actual`をfixture JSONの静的literalで
  比較し、production byte helperから期待値を生成しない。
- group array、group Aのtarget array、group Bのperiod arrayを全て反転しても、full
  reason配列と上記no-solution goldenをbyte-for-byte一致させる。
- JSON round-trip後もrequired fieldの`null`を保持し、field省略または0へ変換しない。
- control fixtureでは、64KiB以下の既存128-period cardを固定し、incoming違反targetの
  childをN=0で全除外した場合だけ合法にする。このreasonは`effectiveLimit: 0`となり、
  no-solution fixtureの`null`と区別する。
- 既存の同一reason二target fixtureは`effectiveLimit: 64`の数値枝として維持する。

target 511 / 512 / 513をcanonical受理境界として生成しない。targetのcanonical宣言上限は128であり、metadata containerの511 / 512 / 513試験とは分離する。

subject 512 / 513はnested projection境界ではなく、§3.8のgate family capacity試験だけで固定する。


各stringは上限、上限＋1を試験する。ただし、複数max-length stringの組合せが64KiBを超える場合、個別string上限ではなくcard byte上限による拒否として分類する。

wire byte境界は共通card builderで次を試験する。

1. ASCII fillerをauthoritative string fieldへ分配し、canonical card itemのUTF-8 JSON byte数が`64 * 1024 - 1`、`64 * 1024`、`64 * 1024 + 1`となるfixtureを作る。
2. `64KiB - 1`とexact `64KiB`を受理する。
3. `64KiB + 1`はprojection全体をfail-closedで拒否する。
4. exact 128 periodかつ64KiB以下の最大valid fixtureを作る。
5. fixtureを実`DisplayStateSnapshotV1.standbyItems`へ入れる。
6. `{ type: "snapshot", snapshot }`と`{ type: "state", snapshot }`の双方で`encodeSseGuarded()`がnon-nullとなる。
7. SSE framing込みの実byte数が`MAX_SNAPSHOT_BYTES`以下であることをassertする。
8. 既存max non-VPWP snapshot fixtureへ最大valid VPWP50 cardを加え、`degradeSnapshotToBudget()`後のmessageが`encodeSseGuarded()`を通る。
9. 前項の縮退で`weatherWarningForecast` standby item、period、pager anchorを削除または書き換えていない。
10. 129 periodまたはcard JSON 64KiB＋1はsnapshot生成前に拒否され、HTTP接続切断へ到達しない。
11. 従来の16,384 period最小DTO相当はsubject count preflightで拒否され、大容量JSONをruntime stateへ保持しない。

live candidateがcard全体count / byte上限を超える場合は、同subjectの旧projectionだけを削除し、accepted gateをactive gate-onlyとして保持する。別subjectのprojectionは維持する。

readerのcanonicalization順序をfixed `restoreNowMs`で試験する。

1. gate / seenとprojection scalarのcouplingを行う。
2. nested raw containerをlength-only preflightする。
3. preflight通過subjectだけをdeep child validationする。
4. 全group横断identity整合とexpiry witness couplingを行う。
5. `endsAtMs <= restoreNowMs`のperiodを除外する。
6. 空target / group / subjectを除外する。
7. retained projectionへ`restored: true`を設定する。
8. post-expiryかつ`restored: true`のwire DTOを構成する。
9. そのDTOへperiod総数と64KiB budgetを適用する。
10. retained / gate-only bundleをcommitする。
11. canonical rewrite後にsave / reloadする。

次の境界fixtureを固定する。

- live `restored: false`のcardがexact 64KiB。save後、fixed clockでreloadすると`restored: true`となり、JSONが1 byte小さい`64KiB - 1`で受理される。
- persisted projectionから作る実際の`restored: true` cardがexact 64KiB。仮に`restored: false`なら`64KiB + 1`となるfixtureを受理する。
- post-restore `restored: true` cardが`64KiB + 1`となるfixtureはprojectionを除外する。
- expiry前には64KiBを超えるが、期限切れperiod除外後の`restored: true` cardが64KiB以下となるfixtureはretained projectionを復元する。
- expiry除外後も64KiB＋1となるfixtureはprojectionを除外し、valid gateをgate-onlyで保持する。
- 全fixtureでload、sanitizer、migration、expiry、restore、card budgetへ同じ`restoreNowMs`を渡す。
- save→reload→再保存→二段目reload後にperiod集合、gate status、restored表示、byte数が再変化しない。
- writerはruntimeの実際の`restored`値を含むcardを同じhelperで検証する。

readerのglobal card salvageを次で固定する。

- bundle capacity salvage後のactive pairをgate `acceptedAtMs`降順、subject key昇順で処理する。
- 各projectionをwhole subject単位でprospective cardへ追加する。
- period総数128件以下かつcard JSON 64KiB以下となるprojectionだけを保持する。
- 上限へ入らないprojectionは除外し、対応valid gateをactive gate-onlyへ再分類する。
- 一件の除外後も後続の小さいprojectionを検討する。
- retained projection集合、gate-only集合、diagnosticをinput順に依存させない。
- budget判定はexpiry除外と`restored: true`設定の後に行う。
- canonical rewrite後のreloadで除外projectionを復活させない。
- writerは同じ違反をsalvageせずfail-loudとする。

salvageは次を確認する。

- malformed subjectだけを除外
- malformed period / target / groupを最小安全単位で除外
- duplicate unitは後勝ちにしない
- Area / Local target couplingを検出
- malformed anchor / duplicate slotを検出
- expiry後のanchor先頭slot欠落を許可
- input順非依存
- 正常な別subject / domainを維持
- canonical rewrite後に除外unitを復活させない

persisted identityの全group横断検査を、live parser fixtureとは独立したDTO改変試験で
固定する。

1. 同一subjectの雨groupへArea code `200010`・`長野県北部`、風groupへ同code・
   `長野県南部`を置く。target / period / group keyを含む他fieldはdeep-validとする。
2. conflict periodより後に終了する正常なArea code `200020`を置き、そのperiodをouter
   expiry witnessとする。restoreでは`code:200010`のarea targetと配下local targetを
   雨・風その他の全groupから除外し、`code:200020`だけを維持する。
3. area targetがなくlocal targetだけに現れる親Area名の矛盾も、`areaNames`へ両方を
   収集して同じArea conflictとする。
4. 同じ親Area code / normalized parent nameの下で、Local code `001`を雨groupでは
   `松本地域`、風groupでは`大北地域`とする。`(code:200010, code:001)`のlocal targetを
   全groupから除外し、親Area base target、Local code `002`、別Areaを維持する。
5. conflict targetの除外で空になったgroupだけをpruneする。正常な同名code identityの
   group横断重複は保持し、code-lessの異名は別identityとして保持する。
6. Area / Local conflict targetがpersisted outerの唯一のwitnessであるvariantでは、
   outerを巻き戻さずsubject projection全体を除外し、valid gateをactive gate-onlyで
   維持する。
7. group、targetの入力順を反転してもretained target / period、prune結果、expiry
   coupling結果、conflict diagnosticのidentity key順を一致させる。
8. save→reload後に除外identityを復活させず、正常な別subjectと他domainを維持する。

nested raw container preflightは、canonical 128件境界とは独立したreader defensive
boundaryとして次を固定する。1,024件側は**raw preflight通過**を意味し、その後のdeep
canonical count / wire検査によるprojection拒否を妨げない。

| phase | raw fixture | preflight期待 |
|---|---|---|
| groups / subject | 1,024 / 1,025 group | 1,024は次phaseへ、1,025はgroup item未走査でsubject overflow |
| targets / group | 一groupに1,024 / 1,025 target | 1,024は次phaseへ、1,025はtarget item未走査でsubject overflow |
| targets / subject | 二groupに512＋512 / 513＋512 target | 1,024は次phaseへ、1,025はtarget item未走査でsubject overflow |
| periods / target | 一targetに1,024 / 1,025 period | 1,024はdeep phaseへ、1,025はperiod item未走査でsubject overflow |
| periods / subject | 二targetに512＋512 / 513＋512 period | 1,024はdeep phaseへ、1,025はperiod item未走査でsubject overflow |

- group scalarがmalformedかつ`targets.length === 1_025`のfixtureでも、group predicate
  より先にtarget-container overflowを検出する。
- target scalarがmalformedかつ`periods.length === 1_025`のfixtureでも、target
  predicateより先にperiod-container overflowを検出する。
- sanitizer predicate spyで、groups、targets、periodsのどのphaseでoverflowしても
  group / target / periodのdeep predicateが全て0 callであることを確認する。
  container header probeはpredicate callへ数えず、expiry witness用のdescendant
  `endsAtMs` parserも0 callとする。
- local最大とsubject累計が同phaseで違反するfixtureでは、診断の両reason、`actual`、
  1,024上限をcanonical順で完全一致させる。
- overflow subjectのprojection全体を除外し、valid gateをactive gate-onlyで維持する。
  同じrootの正常な別subjectと他domainは維持し、legacy / seen-only / C-1へ流さない。
- group / target配列を反転してもpreflight結果と集約diagnosticを一致させる。
- canonical rewrite→reload後もgate-onlyのままで、overflow projectionを復活させない。

expiry witnessを伴うchild salvageは次のfixtureで固定する。

1. 非最大periodのkeyが破損しているが、そのperiodのvalid `endsAtMs`はouter `expiresAtMs`未満。
   - 当該periodだけを除外する。
   - 最大periodとouter `expiresAtMs`のcouplingが残る。
   - subject projectionを復元する。
   - child salvage diagnosticとcanonical rewriteを要求する。
2. 最大`endsAtMs`を持つperiodのkeyが破損し、outer `expiresAtMs`がそのperiodの終了時刻と一致。
   - 最大periodだけを除いてouter expiryを再計算しない。
   - subject projection全体を除外する。
   - valid gateはactive gate-onlyとして維持する。
   - `vpwp50SubjectExpiryCouplingRejected`の`reasons`を
     `["removedExpiryWitness", "outerDerivedMismatch"]`とする。
3. 全childはdeep-validだがouter `expiresAtMs`だけが最大periodと不一致。
   - subject projection全体を除外する。
   - `reasons`を`["outerDerivedMismatch"]`とする。
4. malformed childの`endsAtMs`自体が不正または欠落。
   - 最大periodでないと証明できないためsubject projection全体を除外する。
5. malformed non-max child、正常な別subject、正常な他domainを同じfixtureへ入れる。
   - 正常部分だけを維持する。
6. child / group / target配列順を反転しても復元、diagnostic、rewrite結果を一致させる。
7. canonical save→reload後に除外subject projectionが復活せず、valid gate-only stateが維持される。
8. coupling rejectionされたprojection / seenをlegacy active、seen-only、C-1へ流さない。
9. 最大`endsAtMs`が同じperiodを二件持ち、一方のkeyだけが破損している。
   - 正常なもう一件が`endsAtMs === outer expiresAtMs`を証明する。
   - malformed period一件だけを除外し、subjectを復元する。
   - `endsAtMs < outer`を要求してsubject全体を拒否しない。
   - 二件の入力順と、malformed / validの配置を入れ替えても結果が同じ。
10. 最大時刻tieの二件がともmalformedで、deep-validなouter witnessが残らない。
    - subject projection全体を除外する。
    - `reasons`に`removedExpiryWitness`、`outerDerivedMismatch`をこの順で含める。
11. outer expiryがinvalidで、除外childの`endsAtMs`も不正である複合fixture。
    - `reasons`は`["invalidOuterExpiry", "removedExpiryWitness"]`と完全一致する。
    - 最初に走査したfailureだけを単一reasonとして記録しない。
12. `reasons`、`excludedChildKinds`、countを含む診断全体をinput順反転後も完全一致させる。

外部readerの513 bundle capacityは、次の二fixtureへ分離する。

#### Fixture A: metadata-backed 513 bundle

- metadata rootは`present-array`。
- active pair 128件。各projectionは一period。
- active gate-only watermark 193件。
- metadata付きtombstone-only bundle 192件。
- metadata-backed bundle総数513件。
- metadata arrayは513件。
- 各bundleに対応する一意なvalid seenを持つ。
- active projection period総数128件。
- C-1 projection / tombstoneを含めない。
- canonical card JSONは64KiB以下。
- acceptedAt / subject keyを静的に配置し、deterministic selectorが除外する一件をgate-only bundleへ固定する。

Fixture Aでは次を確認する。

- live 513件目admissionとは別契約である。
- raw metadata 513件をhard-limit違反として拒否しない。
- 全513 metadata candidateをclaim / validateしてからbundle salvageする。
- deterministicに新しい512 bundleを保持する。
- active pairはprojection / gateを一体で保持または破棄する。
- active gate-only / tombstone-onlyはgateだけを保持する。
- metadata `cancelled`をprojection有無から推測しない。
- retained active pair128件からforecast state、card、`RestoredChip`、pager atom / registrationを生成する。
- providerはretained gate bundle512件ではなく、retained active projection128件だけを返す。
- retained gate-only / tombstone-onlyからcard、chip、pagerを生成しない。
- discarded bundleからcard、chip、pagerを生成しない。
- input順を逆転してもretained bundle集合、表示projection、provider集合、card、pager結果が同じになる。
- canonical rewrite後のmetadata、gate bundleは512件、active projectionは128件となる。
- save / reload後も除外bundleが復活しない。

#### Fixture B: root absent C-1

- `weatherWarningForecastGateMetadata` property自体を持たず、`metadataRootState === "absent"`。
- canonical `appliedSemanticKey`を欠くlegacy projectionを一件持つ。
- 同subject / revisionのvalid seenを一件だけ持つ。
- metadata array、metadata-backed bundle、513件capacity inputを持たない。
- 正常な別standby domainの非default leafを一件持つ。

Fixture Bでは次を確認する。

- C-1案Cによりprojectionを破棄する。
- `cancelled: true`、`semanticKeys: []`のseen-only tombstoneを一件生成する。
- card、`RestoredChip`、pagerを生成しない。
- bundle capacity salvageを発生させない。
- 正常な別domainを維持する。
- propertyをempty arrayへ変更したnegative fixtureではC-1を実行しない。
- save / reload後もtombstone statusとstrict comparisonを維持する。

### 5.9 永続 migration と固定時計

旧v1 / v2 fixtureは実運用JSONの匿名化copyを使い、`operational-expectations.json`にfixture path、fixed nowMs、retained / expired pointer、v1 / v2再保存path、replacement allowlistを静的定義する。

load前にfake timerを設定し、sanitizer、migration、restore、startup sweep、admissionへ同じclockを渡す。

一つのflowでold JSON load→migration / sanitizer→gate / store restore→startup sweep→export→v2 / v1再保存→v2 reload / v1再migration→pointer / 他domain / allowlist検査を行う。

新形式v1 rollbackはprojection、seen、metadataを検査する。

metadata付きactive pair:

- projection、metadata、一意なvalid seenが同subject / revision
- `cancelled: false`
- latest canonical semantic keyがprojectionと一致
- strict comparison一致
- acceptedAtがforgetAt式と一致
- projection / gate双方を復元

metadata root containerとraw subject claimをparameterized testする。

metadata root containerの三状態を次で固定する。

| raw property | 分類 | 期待 |
|---|---|---|
| propertyなし | `absent` | metadataなしlegacy migrationを許可 |
| `[]` | `present-array` | legacy fallback禁止 |
| valid array 511件 | `present-array` | 全件scan、511 bundleまで保持可能 |
| valid array 512件 | `present-array` | 全件scan、canonical上限512 |
| valid array 513件 | `present-array` | 全件scan後、metadata-backed bundle selectorで512件へsalvage |
| explicit `null` | `present-invalid` | fallback禁止、VPWP50 rollback domain除外 |
| object | `present-invalid` | fallback禁止、VPWP50 rollback domain除外 |
| string / number / boolean | `present-invalid` | fallback禁止、VPWP50 rollback domain除外 |
| own `undefined`の手組みobject | `present-invalid` | fallback禁止 |
| array 1,024件 | `present-array` | bounded scan |
| array 1,025件 | raw hard-limit違反 | VPWP50 rollback domain除外、先頭採用禁止 |

511 / 512件fixtureはgate-only / tombstone-onlyを中心に構成し、card period上限と混同しない。513件fixtureは§5.8 Fixture Aのmetadata-backed構成を使用する。C-1は同fixtureへ混在させず、§5.8 Fixture Bの`metadataRootState === "absent"`専用fixtureで検証する。

各container caseで次を確認する。

- own-property判定で`absent`とexplicit valueを区別する。
- empty arrayをproperty欠落へ読み替えない。
- raw scan後にvalid metadataが0件でもroot stateを再分類しない。
- `present-invalid`をempty arrayへ補正しない。
- `present-array` / `present-invalid`でlegacy active、projection-free seen-only、C-1へ流さない。
- 正常v2 canonicalがある場合はcanonical stateを維持し、rollback mirrorだけをrepairする。
- standalone v1だけの場合はVPWP50 rollback domainを除外し、他domainを維持する。
- diagnosticとcanonical rewriteを要求する。
- rewrite後はcanonical arrayまたはgate空時のproperty省略となる。
- 二段目reloadで同じcontainer diagnosticが再発しない。

projection、seen、v2 gateにもmetadataと同型のraw hard-limit matrixを適用する。

| raw source | 1,024件 | 1,025件 |
|---|---|---|
| `weatherWarningForecasts` | 全件scan | VPWP50 source domain除外 |
| VPWP50 namespaceのv1 `seen` | 全件group化 | group化前にVPWP50 rollback domain除外 |
| v2 VPWP50 gate candidate | 全件validate | bundle化前にVPWP50 canonical domain除外 |

shared array outer preflightはVPWP50 candidate matrixと分離して固定する。

| shared source | raw shape | 期待 |
|---|---|---|
| v1 `seen` | non-VP / malformed padding 16,383件＋valid VPWP50 seen 1件 | outer 16,384件を通過し、VPWP50 candidate一件を後続検査へ渡す |
| v1 `seen` | non-VP / malformed padding 16,384件＋valid VPWP50 seen 1件 | outer 16,385件で`root.seen`全体を除外し、先頭採用しない |
| v2 `standbyDomains.gateEntries` | non-VP / malformed padding 16,383件＋valid VPWP50 gate 1件 | outer 16,384件を通過し、generic validation後にVPWP50一件を扱う |
| v2 `standbyDomains.gateEntries` | non-VP / malformed padding 16,384件＋valid VPWP50 gate 1件 | outer 16,385件でfoundation domain全体を除外し、先頭採用しない |

各fixtureでpaddingをVPWP50 candidate countへ含めない一方、outer raw countには含める。
paddingの先頭 / 末尾入替えと全配列反転でも結果を一致させる。predicate spyにより、
16,385件overflow時はitem predicateが一度も呼ばれないことを確認する。

source優先順位fixtureも追加する。

- 正常v2 canonical gate / projection＋同じv2 root rollback `seen` overflowでは、
  canonical VPWP50 stateを維持し、root `seen` mirrorだけrepairする。
- 正常v2 canonical＋standalone v1 shared `seen` overflowでは、正常v2のVPWP50
  active pair / gate-only / tombstoneをそのまま採用し、standalone mirrorだけrepairする。
- v2 rootは正常だがv2 `standbyDomains.gateEntries`がouter overflowの場合、v2の
  他domainを採用し、VPWP50 projection / gateを除外する。standalone v1でVPWP50を
  穴埋めしない。
- v2 top-level全体が不正で`state: null`の場合だけ、outer preflightを通るstandalone
  v1へ既存fallbackする。
- canonical rewrite後の二段reloadでは、shared outer overflow diagnosticを再発させない。

各sourceで次を確認する。

- 1,024件の全candidateを先頭部分だけでなく全件scanする。
- 1,025件では先頭1,024件を採用しない。
- 1,025件を全て同一subject duplicateにしても、一bundleへ畳み込む前にraw limit違反となる。
- input順を反転してもoverflow判定が一致する。
- standalone v1 overflowでは正常な別domainを維持する。
- 正常v2 canonical＋rollback mirror overflowではv2 canonicalを維持し、mirror repairだけを要求する。
- v2 canonical VPWP50 gate overflowではVPWP50 domainを除外し、他standby domainを維持する。
- `vpwp50ReaderRawLimitExceeded`のcontainer、actual、limit、source kindを静的期待値で検査する。
- repair後の二段reloadで同じraw-limit diagnosticが再発しない。

`present-array`のmetadata candidate claimを次で固定する。

| raw metadata candidate | 同subject projection / seen | 期待 |
|---|---|---|
| minimally valid subject＋valid metadata一件 | valid | metadata migration |
| minimally valid subject＋malformed comparison | valid | bundle rejection、fallback禁止 |
| minimally valid subject＋malformed semanticKeys | valid | bundle rejection、fallback禁止 |
| minimally valid subject＋invalid cancelled | valid | bundle rejection、fallback禁止 |
| 同subjectのvalid＋invalid metadata二件 | valid | duplicate bundle rejection |
| 同subjectのinvalid metadata二件 | valid | duplicate bundle rejection |
| minimally valid subjectを持たないmalformed item | 別のvalid subjectあり | valid subjectをclaimしない |

各invalid / duplicate caseで次を確認する。

- raw metadata scan時点でnormalized subjectがclaimされる。
- matching projectionと同keyの全seenがconsumeされる。
- sanitizer後にmetadata candidateが消えても、metadata欠落へ再分類されない。
- legacy active migrationへ流れない。
- projection-free legacy seen-only tombstoneへ流れない。
- C-1案Cへ流れない。
- active projection、gate、tombstone、card、chip、pagerを生成しない。
- subject別diagnosticとcanonical rewriteを要求する。
- metadata / projection / seenの配列順を全順列で変えても結果が同じになる。
- 正常な別subjectと他domainを維持する。

metadata付きactive gate-only:

- projectionなし＋`cancelled: false`
- migration後もactive gate-only
- card / chip / pagerなし
- same-revision correctionへのdecisionがv2直接loadと一致
- `clearCurrent`でtombstone由来staleへ変質しない

metadata付きtombstone:

- projectionなし＋`cancelled: true`
- semanticKeys / comparisonを維持
- 同revision active reportを復活させない

metadata / v2 gate status matrixを同じparameterized tableで固定する。

| cancelled | infoType | semanticKeys | 期待 |
|---:|---|---|---|
| false | 発表 | `[発表:<hex64>]` | normal active |
| false | 訂正 | `[発表:<hex64>, 訂正:<hex64>]` | normal active、latestをprojection keyに要求 |
| true | 取消 | `[発表:<hex64>, 取消:<hex64>]` | normal tombstone |
| true | 取消 | `[]` | canonical synthetic tombstone、二段reloadでも維持 |
| false | 取消 | `[取消:<hex64>]` | reject |
| true | 発表 / 訂正 | 対応active key | reject |
| false | 発表 / 訂正 | `[]` | reject |
| false | 発表 / 訂正 | 一件でも`取消:`を含む | reject |
| false | 訂正 | latestが`発表:` | reject |
| true | 取消 | nonemptyだがlatestが`発表:` / `訂正:` | reject |

reject caseはprojectionを復元せず、claimed metadata bundleならprojection / seenを
consumeしてfallbackへ戻さない。v2では当該subjectだけをrepairする。active caseでは
latest keyと`appliedSemanticKey`を照合し、tombstone caseではprojectionを常に除外する。

v2 active gate-only→v1 rollback→migrationではstatus、comparison、semanticKeys、acceptedAt、retentionを維持し、同revision correctionへのdecisionを一致させ、projectionを生成しない。

`metadataRootState === "absent"`のlegacy migrationは次とする。

- canonical projection＋一意なvalid seenはactive migration。
- projectionなし＋一意なvalid seenは保守的seen-only tombstone。
- missing-key projectionはC-1案C。
- root stateはraw container分類時に確定し、migration途中で再計算しない。
- legacy非対称をnew writer outputへ適用しない。

negative fixtureを次で固定する。

- empty `present-array`＋canonical projection＋seenではactive migrationしない。
- empty `present-array`＋projectionなしseenではseen-only tombstoneを生成しない。
- empty `present-array`＋missing-key projection＋seenではC-1を実行しない。
- nonempty `present-array`に当該subject metadataがない場合もlegacy fallbackしない。
- malformed / duplicate metadata除外後にvalid candidateが0件でもlegacy fallbackしない。
- `present-invalid`からlegacy fallbackしない。
- 各negative fixtureでprojection / seenをconsumeし、card、gate、tombstone、chip、pagerを生成せず、diagnosticとcanonical rewriteを要求する。

seen key duplicate matrixはmetadata active、legacy active、legacy seen-only、C-1の四経路で固定する。

| 同じseen.key候補 | 期待 |
|---|---|
| 一件 | 後続strict検査へ進む |
| same revision・same forgetAt二件 | rejection |
| same revision・different forgetAt二件 | rejection |
| different revision・same forgetAt二件 | rejection |
| different revision・different forgetAt二件 | rejection |

duplicateでは全candidateをconsume / rejectし、一件選択、最大revision / forgetAt選択、fallback再投入を行わない。全順列で同じ結果とし、正常な別subjectを維持する。

acceptedAt future-skewを次の五経路で固定する。

1. metadata active
2. legacy active
3. projection-free legacy seen-only tombstone
4. C-1
5. v2 sanitizer

| acceptedAtMs | 期待 |
|---|---|
| `nowMs - 1ms` | 許可 |
| `nowMs` | 許可 |
| `nowMs + 15分` | 許可 |
| `nowMs + 15分 + 1ms` | 非生成 / v2 bundle除外 |
| invalid Date range | 非生成 |
| unsafe integer | 非生成 |

不成立時はprojection、gate、seen-only tombstone、C-1 tombstoneを生成しない。v2では当該bundleだけをrepairし、seenをfallbackへ戻さず、時刻を補正せず、diagnosticとrewriteを要求する。

report future-skewも同じ五経路で固定する。

| reportTimeMs | 期待 |
|---|---|
| `acceptedAtMs + 15分` | 生成 |
| `acceptedAtMs + 15分 + 1ms` | 非生成 |
| invalid Date range | 非生成 |
| unsafe addition | 非生成 |

projection-free legacy seen-only専用fixtureは次を検証する。

- metadata / projectionがなく、同じseen key groupが一件だけ。
- seen keyがvalid VPWP50 subject。
- forgetAt式からacceptedAtを復元。
- acceptedAt / report future-skew成立。
- strict subject-bound eventId。
- type `"VPWP50"`。
- canonical UTC reportDateTime。
- normalized serial。
- infoType `"取消"`。
- `cancelled: true`、`semanticKeys: []`。
- projection、card、chip、pagerなし。
- forgetAt / 7日境界を維持。
- acceptedAt=`nowMs + 15分`とreport=`acceptedAt + 15分`の両境界を許可。
- 各＋1msではtombstoneを生成しない。
- failure seenをactive / C-1 / standalone fallbackへ戻さない。
- `vpwp50V1GateMetadataMissing`またはreconstruction diagnosticを記録する。
- save→reload後もstrict comparisonとtombstone statusを維持する。

serial matrixは従来どおりとする。

| projection / seen serial | 期待 |
|---|---|
| `"1"` / `"1"` | numeric 1 |
| `"01"` / `"1"` | numeric 1、canonical raw `"1"` |
| `null` / `""` | missing、raw null |
| `""` / `null` | missing、raw null |
| numeric / missing | mismatch |
| `"A1"`、`" 1"`、`"1.0"`、unsafe integer | invalid |

projection-free seen-onlyではprojection serialがないため、seen serial単体を同じnormalizerへ通し、numeric / missingだけを許可する。

canonical semantic key試験では発表 / 訂正＋lowercase hex64を受理し、uppercase、63 / 65桁、unknown prefix、raw payload、pre-digest keyを拒否する。projectionだけをcompactせず、metadata付きならgate-onlyを維持でき、metadataなしならbundle拒否とする。non-canonical keyをC-1へ流さない。

C-1案C fixtureは§5.8 Fixture Bを使用し、`metadataRootState === "absent"`、missing-key projection、一意なvalid seen、acceptedAt / report preflight、strict comparison、取消infoType、empty semantic keys、表示なし、forgetAt / 7日境界を検証する。

duplicate / mismatch / preflight failureでは不成立とし、seenをfallbackへ戻さない。次のroot形状では同じprojection / seenを与えてもC-1を実行しない。

- empty `present-array`
- 当該subject metadataなしのnonempty `present-array`
- malformed metadataだけを持つ`present-array`
- duplicate metadataだけを持つ`present-array`
- `present-invalid`

metadata-backed 513 bundle fixtureへC-1 projectionまたはC-1 tombstoneを混在させない。

migration後はv2 reload / v1再migrationを必須とし、comparison、semanticKeys、cancelled、acceptedAt、projection有無、ISO、serialを二段目で変化させない。

XML fixture expectationsにはfixed nowMs、Area / Local raw XMLとcanonical identity、target label、forecastLabel、occurrence / period key、pager anchor、JST label、endsAt境界を静的定義する。

## 6. 受入条件

以下は完了確認用のindexである。§3の全normative contractを実装し、§5の全fixture /
境界 / 全順列 / 二段reload試験を通すことを受入条件とする。このchecklistだけを満たし、
§3または§5の細則を省略してはならない。

### Parser・projection・identity

- [ ] C-1裁定日2026-08-31・案Cと、独立card案Aを維持する。
- [ ] parserが全Significancy occurrenceを`tsNum`、series、`timeRef`、absolute slot
  付きで保持し、既存`significancyWorst` / `flattenEntries()`を変更しない。
- [ ] known / unknown、Code 21 / 22、L4→L3→L2を別occurrence / groupとして維持する。
- [ ] Area / Local identityをNFC・whitespace・code fallback規則でparser段階に確定する。
- [ ] Area conflictはsubject全体、Local conflictはsubject＋親Area単位で検出し、
  input順に依存させない。
- [ ] target identityとduplicate scopeが`(group.key, target.key)`であり、別groupの
  同じtargetを正常に共存させる。
- [ ] derived keyは`vpwp50StableKey()`のbase64url SHA-256 43文字に固定し、
  group / target / period / anchor keyをpersisted fieldから再計算する。
- [ ] occurrence keyと`timeRef`はruntime-onlyで、persisted period DTO / sanitizerへ
  単一`timeRef`を追加しない。
- [ ] period keyをgroup、target、`tsNum`、series、`startsAt`、`endsAt`だけから
  再計算する。
- [ ] slot解決、partition後merge、gap / connection / overlap、JST labelが§3.2 /
  §3.4どおりで、host / browser timezoneに依存しない。
- [ ] `endsAt - 1ms`ではactive、`endsAt`では失効し、period→target→group→subject
  の順で空unitを除外する。

### Live state・wire・gate

- [ ] state mapは既存`event.standbyStateSubject`を使い、他官署・他地域subjectを
  訂正 / 取消で変更しない。
- [ ] source IDをEventID→message ID→`event.id`で解決し、source / semantic key
  欠落やprojection失敗時は旧projectionを削除してaccepted gate-onlyを維持する。
- [ ] gateはdurable、active watermark / tombstoneはacceptedAt起点7日で、
  startup・60秒sweep・admission直前の三経路が同じ`>`境界を使う。
- [ ] `T0 + 7日`で保持し、`T0 + 7日 + 1ms`でgateと対応projectionを失効させる。
- [ ] VPWP50 familyは512 bundleで、513件目の新規subjectをgate mutation前に
  fail-closedとし、既存bundleをevictしない。
- [ ] active protection providerは有効projection subjectだけ、capacity preflightは
  gate-only / tombstoneを含むfamily subject総数を使う。
- [ ] incoming rejection時も同callのpre-admission expiryを失わず、保存予約を一回へ
  合流する。
- [ ] nested count、全card 128 period、canonical card JSON 64KiBをAND条件で
  prospective mapへ適用する。
- [ ] count / byte違反はcandidate全体を拒否し、別subjectを縮退・evictせず、
  writerではI/O前にfail-loudとする。
- [ ] 固定group shapeが100=`64,845`、101=`65,492`、102=`66,139`、
  128=`82,961`、129=`83,608` bytesとなる。
- [ ] 129-group診断は`groupsPerSubject`、`periodsPerSubject`、
  `periodsPerCard`、`cardJsonBytes`の4reasonをcanonical順で持つ。
- [ ] 全projection-limit reasonが必須`samplePaths`を持ち、fixture literalとの
  全field完全一致を行う。
- [ ] 複数local unitの`effectiveLimit`は違反unit集合へ共通Nを同時適用して求め、
  二target×129 period fixtureで64、target / period入力反転後も同値となる。
- [ ] `effectiveLimit`はrequired `number | null`とし、候補集合emptyだけを`null`、
  N=0の有効解を数値0として区別し、`cardJsonBytes`は常に65,536とする。
- [ ] 129-target group＋129-period targetの混合fixtureで二local reasonを`null`とする
  no-solution goldenを全field一致させ、group / target / period反転後も同値となる。
- [ ] exact 128 periodかつ64KiB以下の最大valid cardを含むsnapshot / stateが
  `encodeSseGuarded()`を通り、server縮退がcard内容を変えない。

### Persistence・migration・salvage

- [ ] schema version 2を維持し、v2 canonical gate、v1 projection / seen / metadataを
  意味的同一にdual-writeする。
- [ ] active pair、active gate-only、normal tombstone、empty-key synthetic tombstoneを
  区別し、表示はactive pairだけから作る。
- [ ] metadata / v2 gateが`cancelled`、comparison infoType、ordered semantic keyの
  latest prefixを§3.9のstatus matrixどおり相互検証する。
- [ ] projectionのcanonical `appliedSemanticKey`がnormal active gateのlatest keyと
  一致し、tombstoneへprojectionを結合しない。
- [ ] synthetic tombstoneを`cancelled: true`、infoType `取消`、empty keysのまま
  v2 / v1二段reloadできる。
- [ ] metadata rootをown-propertyで`absent` / `present-array` /
  `present-invalid`へ一度だけ分類する。
- [ ] metadataなしlegacy active、projection-free seen-only、C-1へ進む必要十分条件を
  `metadataRootState === "absent"`とする。
- [ ] raw metadata claimがdeep validation前にsubjectをconsumeし、invalid /
  duplicate後にlegacy fallbackやC-1へ戻さない。
- [ ] C-1はmissing-key projectionを破棄し、一意でstrictなmatching seenだけから
  `cancelled: true`、empty keysのseen-only tombstoneを作る。
- [ ] C-1 / legacy migrationがacceptedAt・report future skew、serial normalization、
  forgetAt逆算、7日境界を固定時計で検証し、synthetic keyを生成しない。
- [ ] projection、metadata、VPWP50 seen / v2 gateのraw candidate 1,024 / 1,025境界を
  distinct bundle化前に適用する。
- [ ] persisted projectionのgroups / targets / periodsへ1,024件のper-container / subject
  cumulative length-only preflightをchild predicate前に適用する。
- [ ] nested raw overflowではdescendantとexpiry witnessを走査せずsubject projection
  全体を除外し、valid gateをgate-onlyで維持して正常な別subject / domainを残す。
- [ ] shared v1 `seen`とv2 `standbyDomains.gateEntries`自身へ16,384 itemのouter
  preflightをpredicate評価前に適用し、writerも同じfull-container上限をI/O前に
  fail-loudで検証する。
- [ ] non-VP / malformed padding込み16,384 / 16,385 fixtureで、overflow時に先頭だけを
  採用せずshared container安全単位を除外する。
- [ ] 正常v2＋standalone v1 overflowではv2 authoritativeを維持し、v2のdomain-local
  overflowをstandalone v1で穴埋めしない。
- [ ] external readerの513 bundleは全claim後にacceptedAt降順＋subject昇順で512へ
  salvageし、live 513 rejectionと混同しない。
- [ ] readerは固定`restoreNowMs`でgate / scalar coupling→nested preflight→deep child
  validation→全group横断identity→expiry witness→期限切れ除外→`restored: true`→
  card budget→commitの順を守る。
- [ ] persisted Area / Local code identityの名称集合を全group横断で検査し、conflict
  identityをlive parserと同じscopeで全groupから除外してexpiry witnessへ反映する。
- [ ] 最大終了時刻tieでdeep-valid outer witnessが残る場合、malformed siblingだけを
  salvageする。
- [ ] outer witnessを全て失う、unknown end、outer mismatchの場合はsubject projection
  全体を除外し、valid gateをgate-onlyで維持する。
- [ ] expiry coupling診断は`invalidOuterExpiry`、`removedExpiryWitness`、
  `outerDerivedMismatch`の成立した全reasonをcanonical `reasons`配列へ入れる。
- [ ] child / subject / bundle / wire salvageとcanonical rewriteがinput順非依存で、
  正常な別subject・別domainを維持し、二段reloadで除外unitを復活させない。

### Frontend・pager・名称

- [ ] protocol kind `weatherWarningForecast`をadditiveに追加し、
  `DISPLAY_PROTOCOL_VERSION === 1`を維持する。
- [ ] card titleは「気象警報予測」、通常weatherの直後、briefingの前に配置する。
- [ ] engine生成`forecastLabel`とauthoritative target / period labelをfrontendで
  再解釈・短縮しない。
- [ ] DTO / pager / preview / probe subtreeの全string leafと、DOM text・ARIA・title・
  accessible nameを再帰検査する。
- [ ] 雷由来card subtreeに「竜巻注意情報」「竜巻」「突風」が一切なく、tornado stateを
  生成しない。
- [ ] existing weather severity tokenだけを使い、新色・独自帯・点滅を追加しない。
- [ ] pager atomを`(group key, target key, pagerAnchorKey)`とし、一atom最大4 period、
  immutable anchor / slot gapをexpiry・save・reload後も維持する。
- [ ] 単一target 128 period=32 atom、128 target×一period=128 atomとなり、全atomへ
  到達できる。
- [ ] solverへkindを登録し、`MAX_ROTATION_CANDIDATE_PASSES === 7`、960x620を含む
  全viewport / side / center / rotationでoverflow・重なりがない。

### 検証

- [ ] 実VPWP50 XMLをparser→projection→reducer→protocol→frontendまで固定時計で通す。
- [ ] operational v1 / v2匿名化fixtureをload→migration→restore→sweep→dual-save→
  v2 reload / v1再migrationまで通し、allowlist外の値を変えない。
- [ ] `npm run build`が成功する。
- [ ] `npm test`が成功する。
- [ ] 永続化・共有状態を変更するため`npm run test:shuffle`が成功する。
