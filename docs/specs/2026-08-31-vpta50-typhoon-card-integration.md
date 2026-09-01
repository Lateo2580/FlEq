# VPTA50 TyphoonCard 統合仕様

- 日付: 2026-08-31
- 状態: ご主人裁定済み・全面再起草
- 採用案: VPTA50 を既存 `TyphoonCard` へ統合する
- 対象電文: VPTA50、VPTW60、VPTW61、VPTW62
- display protocol kind: 既存 `typhoon`
- display protocol version: v1 を維持
- standby persistence schema: v2 を維持
- 裁定待ち: なし

## 1. 目的と固定要件

VPTA50「台風の暴風域に入る確率」を、同一台風の VPTW 実況と一つの
`TyphoonCard` に統合して継続表示する。

この仕様の `MUST`、`MUST NOT`、`SHOULD` は規範要件である。
実装方式は本書で定めるが、次の機能と安全性質は変更しない。

### 1.1 機能スコープ

- VPTW と VPTA は、trim 後 nonblank かつ 128 文字以下の共通
  `EventID` が完全一致する場合だけ結合する。
- 台風番号、名称、かな名、発表官署、時刻から `EventID` を合成しない。
- VPTA が先着しても probability-only `TyphoonCard` を表示する。
- VPTW と VPTA の到着順にかかわらず最終 snapshot を同一にする。
- VPTA は最大 5 日積算確率、最大 5 府県、worst area とそのピーク時刻へ
  compact projection する。
- 最大確率同率の府県が 6 件以上でも、worst area の府県を表示府県リストへ
  必ず含める。
- VPTA の厳密な全ゼロ発表または取消は probability slice だけを削除し、
  同じ `EventID` の VPTW analysis slice を維持する。
- VPTW の取消、終了、期限切れは analysis slice だけを削除し、有効な VPTA が
  あれば probability-only card を維持する。
- VPTA の `TimeDefine` から絶対予測終了時刻を導出し、予測期間終了時に
  probability slice を失効させる。
- VPTA revision gate は durable とし、active watermark と cancellation tombstone を
  受理時刻起点で 7 日保持する。
- 表示中 probability subject と cancellation tombstone は capacity eviction から
  保護する。
- 有効な probability slice を永続化し、復元後は `restored: true` とする。
- 通知用の連続ゼロ履歴は表示 state と分離し、process-local のままにする。
- VPTA の確率値から警報 severity、警報色、通知の critical 判定を生成しない。
- 既存 `TyphoonCard`、`standby-card-header`、muted header、
  weather header token、full / compact / overflow の視覚言語を維持する。
- 実 fixture の 40 step を維持する。parser は 60 step まで通常 DTO として保持し、
  61 step 以上も切り捨てず `compactOnly` として保持する。
- CLI、ticker、通知が利用する詳細系列を削除せず、40 件へ切り詰めない。

browser protocol と persistence へ載せるのは card に必要な compact projection
だけである。raw XML、全地域、全時系列、daily 配列、parser diagnostics、内部 admission
context は複製しない。

### 1.2 固定する安全契約

- durable admission は fail-closed とする。受理後に projection の正しさを証明できない
  場合、旧 probability slice を残さず、commit 済み gate watermark だけを残す。
- VPTA 一電文の分類時計は `parsed.meta.receivedAtMs` から一度だけ確定し、
  projector、gate、reducer で読み直さない。
- gate commit、projection mutation、managed retention の保存所有権は monitor の
  VPTA completion adapter 一箇所に集約する。
- `StandbyStateStore.onDurable()` と VPTA completion の双方から同じ
  admission を保存しない。
- internal candidate、finalized classification、gate commit record、failure evidence を
  `ProcessOutcome`、`PresentationEvent`、personal overlay の event-file、browser
  protocol、snapshot、persistenceへ流出させない。
- router への同期再入で、先行電文の gate と後着電文の projection を混在させない。
- writer は validation、write、rename、backup failure を成功として返さない。
- gate commit 後の失敗では gate を rollback しない。保存を確定してから fail-loud にする。
- observer と表示の失敗は durable mutation の成否と分離し、完了済み通知、統計、表示を
  自動 replay しない。

### 1.3 非目標

- 新しい card kind、`CardKey`、solver candidate、pager key は追加しない。
- probability から台風の強さ、大きさ、警報段階を推定しない。
- VPTW と VPTA の revision family を統合しない。
- notification zero history を永続化しない。
- persistence schema version、display protocol versionを上げない。personal branch overlay の
  event-file versionも1から上げない。

## 2. 現行実装との接続点

実装時は次の現行呼出し列を前提にする。

1. `createMessageHandler().handler` が normalize、route classify、route tap、
   transport dedup、日時診断を行う。
2. 非火山の線形 route は `processMessage()`、`recordStats()`、
   notifier、`runDisplayPipeline()` へ進む。
3. `runDisplayPipeline()` の入口で `outcomeTaps` が実行される。
   public main に存在するのはこの汎用拡張点までであり、`EventFileWriter` の実装・配線は
   存在しない。
4. `toPresentationEvent()` と display preprocess の後、
   monitor の `displaySink.ingest()` が `StandbyStateStore.applyEvent()`
   を呼ぶ。
5. `StandbyStateStore` の durable listener は現状
   `StandbyPersistence.schedule(exportActiveState())` へ接続される。
6. monitor は revision gate、standby store、persistence を所有し、restore 後に
   60 秒 sweep を開始する。
7. shutdown は signal、REPL `quit`、readline close の三経路から到達する。

VPTA 統合はこの列を無視した別パイプラインにしない。内部 sidecar と completion adapter
を追加し、公開 outcome と event の既存用途を保つ。

実施レーンを次のとおり分離する。

- **public main lane**: `outcomeTaps`、public `ProcessOutcome`、そこから生成される
  `PresentationEvent` までの非流出境界を実装・試験する。main に
  `EventFileWriter` 名のclass、file、import、option、test、placeholderを追加しない。
- **personal branch overlay lane**: dmdata 再配信ポリシーに従う既存 overlay が
  `outcomeTaps` へ `EventFileWriter` を接続する。この spec を取り込む際は §10.5、§11.4.2、
  §12.7 の追従を必須とする。

overlay が public main checkout に存在しないことは正常であり、main lane の未実装・試験欠落と
判定しない。event-file 非流出契約そのものはレーン分離後も不変である。

### 2.1 parser と既存 presentation

- parser は `src/dmdata/typhoon-probability-parser.ts` の
  `parseTyphoonProbability()` を維持する。
- historical field 名 `series40` は固定長 40 を意味しない。
- 1〜60 step で他の fallback 条件がなければ `fallback: "none"` とし、
  全 step を保持する。
- 61 step 以上は全 step を保持したまま `fallback: "compactOnly"` とする。
- 600 地域超、decoded XML 5 MiB 超、duplicate diagnostic その他の既存 fallback
  条件を step 数だけで打ち消さない。
- CLI 用 `aggregateByPrefecture()`、formatter、ticker、notifier は
  compact standby projector に置き換えない。
- `processTyphoonProbability()` の責務は parse、level、notification baseline までとし、
  holder mutation は行わない。router integrationでは内部を parse preparation と
  stateless outcome baseline に分け、§5.3 の started境界を観測可能にする。
- 既存 level 契約を維持する。取消は frame / sound とも cancel、通常発表の frame は
  normal、`maxDaily5 > 0` の sound は normal、`maxDaily5 === 0` の
  sound は info とする。
- level helper の `null ?? 0` は通知 presentation の互換挙動に限る。
  durable all-zero判定、gate deactivation、projection削除の根拠には使用しない。
- stateless baseline の `suppressNotify` は false。accepted finalized classification
  をholderへ適用した結果だけが連続ゼロ抑制を上書きする。

### 2.2 revision family

subject は分離する。

```text
VPTW: typhoon:<EventID>
VPTA: typhoonProbability:<EventID>
```

VPTA は `reportDateTimeThenSerial` comparator、
`clearCurrent` cancellation policy、`allowMissingSerial: true`、
`maxSubjects: 256` を維持する。`durable` だけを true にし、
retention を 7 日へ固定する。

## 3. 単段の router 直列化

旧案の二段 ingress ticket、`pendingIngress / ready / discarded`、
VPTA 専用 FIFO は採用しない。router instance 全体を一つの同期
run-to-completion serializer で包む。

### 3.1 immutable envelope

public `handler(incoming)` は次を行う。

sticky poison が既に設定済みなら、時刻取得、normalization、clone、route分類より前に
`RouterSerializerPoisonedError` を送出する。healthy な場合だけ次へ進む。

1. 呼出し時点の `ingressObservedAtMs` を一度だけ確定する。
2. `normalizeTelegramMessage(incoming, ingressObservedAtMs)` を一度だけ実行する。
3. normalized message を structured clone し、全 object / array を deep-freeze する。
4. clone から route を一度だけ分類する。
5. `{ message, route, diagnostics, ingressObservedAtMs, ordinal, byteLength }` の immutable envelope
   を serializer へ渡す。

`normalizeTelegramMessage()` の既存 meta 保持契約を変更しない。incoming に message 内容と
整合する valid `meta` があれば、その object と `meta.receivedAtMs` を authoritative とし、
`ingressObservedAtMs` で再生成・上書きしない。meta が欠落または不正な場合だけ、normalizer が
envelope field と `ingressObservedAtMs` から完全な meta を再生成する。

従って pre-normalized message の同期再投入では、最初の ingress で確定した
`meta.receivedAtMs` を classification 時計にも維持する。`ingressObservedAtMs` は normalizer の
fallback 入力と ingress 診断にだけ使い、revision、分類、retention、forecast expiry の時計へ
流用しない。

`byteLength` は
`Buffer.byteLength(JSON.stringify(message), "utf8")` を一度だけ評価した値とする。
JSON serialization 自体が失敗した場合は stateful 処理前の serializer invariant failure
として fail-loud にする。

route tap、transport dedup、日時診断、parser、gate は全て同じ frozen
`message` graph を読む。tap 用の別 graph、gate 用の tap 前 clone、元
`incoming` を混在させない。`RoutedMessageTap` の message 型は
`ReadonlyDeep<WsDataMessage>` 相当へ変更し、tap mutation は許可しない。
mutation の試行で throw しても既存 tap 例外隔離へ入り、frozen graph は変わらない。

### 3.2 queue と順序

serializer が idle なら envelope を current owner として直ちに処理する。処理中の同期再入は
pending queue の末尾へ追加し、現在の owner が terminal になるまで開始しない。

```ts
const ROUTER_REENTRANT_QUEUE_MAX_ITEMS = 256;
const ROUTER_REENTRANT_QUEUE_MAX_BYTES = 64 * 1024 * 1024;
const ROUTER_MAX_DRAINED_ENVELOPES_PER_TURN = 512;
```

- capacity に数えるのは pending queue だけである。current owner は数にも byte にも
  含めない。
- idle 時の一件は serializer の byte limit で拒否しない。各 parser の既存入力上限を
  authoritative とする。
- pending 追加後の件数は 256 以下、byte 合計は 64 MiB 以下とする。
- 64 MiB は decoded XML 5 MiB の VPTA 正常入力を待機させられることを fixture で
  確認する。旧 2 MiB limit は使用しない。
- dequeue 時に pending count / byte から即時除去する。
- duplicate、日時拒否、ignore、raw fallback の marker を queue に残さない。各 envelope
  は dequeue 後に終端し、payload を解放する。
- 一 outermost turn で 512 envelope まで処理する。513 件目を開始する前に overload とする。
- ordinal は safe integer の単調増加値とし、overflow は invariant failure とする。

envelope の実処理順は既存順を保つ。

1. non-XML 判定
2. route taps
3. foundation received stats
4. transport dedup
5. 日時診断
6. explicit policy / ignore / raw 解決
7. processor と route 固有処理
8. outcome stats、notification、display pipeline

従って route tap 内で同一 `messageId` の C が再入しても、先行 A が
`transportDedup.accept()` を先に実行する。queue drain は public handler、
normalizer、classifier、route tap、dedup、日時診断を再実行しない。

### 3.3 overload、poison、error 順序

queue count、queue byte、drain step、ordinal、snapshot serialization、persistence dispatch
の infrastructure failure は serializer を sticky poison にする。

- current owner 以外の未開始 envelope を全て破棄し、queue count / byte をゼロへ戻す。
- 未開始 envelope の admission completion、gate、projection、holder、stats、notification、
  保存を捏造しない。
- poison 後は全 route を新しい envelope の作成前に
  `RouterSerializerPoisonedError` で拒否する。
- production に poison 解除、古い queue replay API を設けない。再開は新 router instance、
  通常は process restart だけで行う。
- tap が nested enqueue の overload error を捕捉しても poison latch は残す。
  outermost turn は次の callback boundary または owner 終了時に必ず fail-loud となる。
- non-VPTA outer の tap から VPTA overload が起きた場合も同じ規則である。
  non-VPTA outer を「poison の影響外」とする例外は設けない。

VPTA admission 自体の stage failure は、必要な fail-closed reconcile と同期保存に成功した
場合だけ recoverable drain error とする。recoverable error は発生順に記録し、pending
envelope を ordinal 順で最後まで処理する。

- recoverable error が一件ならその error を outermost return で再送出する。
- 二件以上なら発生順の `AggregateError` を一回送出する。
- infrastructure failure が後から起きた場合は、先行 recoverable errors、infrastructure
  cause、persistence cause の順に aggregate し、drain を停止する。
- error message、stack、XML、EventID、state payload を bounded diagnostic に含めない。

これにより drain 中の B、C、D がそれぞれ失敗しても、どの cause を保持するか、
どこまで続けるかが一意になる。

### 3.4 infrastructure failure 時の durable floor

outermost turn は、その turn で正常 completion が返した最新の
`StandbyPersistenceScheduleReceipt` を記録する。

completion 後の presentation、tap、observer、次 envelope の dequeue 前検査で serializer
poison が判明した場合、二回目の admission completion は発火しない。代わりに monitor の
`flushStandbyThrough(requiredSeq)` を一回呼ぶ。

- flush は呼出し時点の newest pending seq を exact target として固定する。
- target は `requiredSeq` 以上でなければならない。
- v2 / v1 の双方がその target seq を commit した場合だけ成功する。
- target が required receipt より新しい場合、新しい full snapshot が古い mutation を
  包含するため成功とする。
- pending がなくても writer の committed seq が `requiredSeq` 以上なら
  `alreadyWritten` として成功できる。
- mismatch、no pending かつ未書込、partial commit、write / rename / backup failure は
  成功にしない。

この flush により、accepted completion 後の display callback から queue overload が
発生しても、gate / projection の durable state を disk へ確定してから fail-loud にする。

## 4. VPTA の分類と admission

### 4.1 EventID と transient

```ts
const TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH = 128;
```

VPTA EventID は prefix 連結前に trim し、`string.length` で検査する。

- 1〜128 文字だけを subject、cancellation target、gate comparison、projection map key、
  notification holder key に使用する。
- 比較は case-sensitive とする。
- 欠落、空文字、129 文字以上は gate に入れず
  `StandbyFoundationResult.kind === "transient"` とする。
- transient outcome は `standbyStateMutationAccepted: false` と
  `standbyStateTransient: true` を持つ。
- transient marker は engine internal presentation flag に留め、protocol、snapshot、
  persistenceへ追加しない。
- router の standby rejection 通知抑止から、domain が
  `typhoonProbability` かつ transient の場合だけ除外する。
- transient は CLI、ticker、stats、既存 notifier へ渡すが、gate、projection、holder、
  managed subject、persistence completion を変更しない。
- transient は revision dedup されないため再配送で再通知され得る。
- 長さ超過 diagnostic は head type、length、reason だけを持ち、EventID 全文を記録しない。

VPTW の EventID も trim 後 nonblank でなければ統合しない。VPTW の既存上限を狭めず、
VPTA 側の 128 文字上限を満たす共通 key だけが combined card の対象になる。

### 4.2 一回だけの分類時計

EventID validation 後、gate 判定前に次を一度だけ確定する。

```ts
const classificationNowMs = parsed.meta.receivedAtMs;
```

finite safe integer かつ ECMAScript `Date` の有効 epoch 範囲でなければ
`invalidMeta` とする。incoming gate、projection、holder、managed subject を
変更しない。既に同じ admission で完了した retention maintenance は巻き戻さない。

projector、gate capacity candidate の `acceptedAtMs`、admission 前 expiry、
protection snapshot、finalized classification は同じ値を使用する。`Date.now()`、
gate 呼出時刻、reducer 時刻へ置換しない。

この値は §3.1 の normalizer が保持または生成した時刻であり、常に現在の handler 呼出時刻とは
限らない。valid meta を持つ pre-normalized / reentrant message は元の
`meta.receivedAtMs` を維持し、meta 欠落または不正な raw message だけが今回の
`ingressObservedAtMs` を得る。再投入のたびに classification clock を更新する実装を禁止する。

### 4.3 candidate と finalized classification

standby 用 projector は CLI aggregate と分離した pure function とする。

```ts
type TyphoonProbabilityActiveCandidate = Omit<
  TyphoonProbabilityState,
  "revision" | "appliedSemanticKey" | "restored"
>;

type TyphoonProbabilityCandidateResult =
  | { kind: "active"; candidate: TyphoonProbabilityActiveCandidate }
  | { kind: "deactivateAllZero" }
  | { kind: "cancel" }
  | { kind: "expired" }
  | { kind: "nonProjectable"; reason: VptaProjectionFailureReason };

interface TyphoonProbabilityCandidateClassification {
  nowMs: number;
  canonicalInfoType: CanonicalVptaInfoType;
  result: TyphoonProbabilityCandidateResult;
}

type FinalizedTyphoonProbabilityResult =
  | { kind: "active"; state: TyphoonProbabilityState }
  | Exclude<TyphoonProbabilityCandidateResult, { kind: "active" }>;

interface FinalizedTyphoonProbabilityClassification {
  nowMs: number;
  canonicalInfoType: CanonicalVptaInfoType;
  result: FinalizedTyphoonProbabilityResult;
  acceptedRevision: StandbyRevision;
  appliedSemanticKey: string;
}
```

- `projectTyphoonProbability(parsed, canonicalInfoType, classificationNowMs)` を一電文につき
  一回だけ実行する。
- candidate へ `revision`、`appliedSemanticKey`、
  `restored` を設定しない。
- gate が拒否した candidate を finalize しない。
- accepted commit record の binding と candidate を
  `finalizeTyphoonProbabilityClassification()` で一回だけ結合する。
- active state の `restored` は false とする。
- holder と standby reducer は同じ finalized classification を読む。再分類しない。

### 4.4 cancel

§5.2 で確定した `canonicalInfoType === "取消"` は `cancel` とする。
`parsed.infoType` または `parsed.meta.infoType` をこの分岐で読み直さない。

- EventID と revision metadata だけで gate 判定する。
- body、`TimeDefine`、regions を要求しない。
- gate 受理後、該当 EventID の probability slice だけを削除する。

### 4.5 TimeDefine の絶対時刻化

active / all-zero 判定前に absolute slot を構成する。

```ts
interface TyphoonProbabilitySlot {
  timeId: number;
  startsAtMs: number;
  endsAtMs: number;
}
```

- `baseTime` と `DateTime` は `Z` または明示 UTC offset
  付き ISO 8601 だけを受理する。
- timezone なし、invalid Date、unsafe epoch は拒否する。
- `timeId` は safe integer、1〜slot 数、一意な連続列 `1...N`
  とする。
- slot 数は 1〜60 とする。61 以上は parser DTO を維持したまま
  `nonProjectable` とする。
- `Duration` は固定長の正の ISO 8601 duration とする。year、month、week、
  負数、ゼロ、小数、解析不能値を拒否する。
- 一 slot は 24 時間以下、全 span は正かつ 120 時間以下とする。
- `endsAtMs = startsAtMs + durationMs` とし、overflow を拒否する。
- `startsAtMs`、`timeId` 順に整列し、最初の start は
  `baseTimeMs` と一致させる。
- 隣接 slot は `previous.endsAtMs === next.startsAtMs` とする。
  gap、overlap、逆転を拒否する。
- `series40[index]` は `timeId === index + 1` に対応させる。
- `forecastEndsAtMs` は最後の slot end とする。
- `classificationNowMs < forecastEndsAtMs` だけを有効側とし、境界時刻は
  `expired` とする。

全 slot は projection の一時値であり、protocol と persistence へ保存しない。

### 4.6 地域 validation

standby projection の全 region は次を満たす。

- 件数 1〜600。
- `areaCode`、`areaName`、`prefCode`、
  `prefName` は trim 後 nonblank で共通 field limit 内。
- `areaCode` は一意。同じ `prefCode` に異なる
  `prefName` を許可しない。
- `daily` は長さ 5。全要素は 0〜100 の finite safe integer である。
- `series40.length` は slot 数と一致し、各値は `null` または
  0〜100 の finite safe integerである。
- `parserDiagnostics.duplicateCodes` に trim 後 nonblank code が一件でも
  あれば、regions が一意に見えても projection 全体を拒否する。
- projector でも regions 自体の duplicate を防御検査する。
- duplicate evidence は trim、重複除去、code-unit 辞書順、bounded 件数とする。
- cancellation では body validation と duplicate diagnostic を参照しない。
- daily 単調性違反は parser diagnostic として維持する。`daily[4]` 自体が
  valid なら、この違反だけで active projection を捨てない。

duplicate、VPTA dataset 内の identity conflict、上限超過、invalid probability は
`nonProjectable` とする。

### 4.7 厳密な全ゼロ

`deactivateAllZero` は次を全て満たす場合だけ成立する。

- region が一件以上ある。
- slot と region validation を全て通る。
- 全 region の `daily[0...4]` が欠落なく数値 0 である。
- 全 region の全 `series40` が欠落なく数値 0 である。

`null`、欠落、不正値、空 regions、欠落 TimeDefine をゼロとみなさない。
`daily[4]` が全て 0 でも、他 daily または series に非ゼロ、`null`、
不正値があれば `nonProjectable` とする。gate の
`deactivationPredicate` はこの candidate kind だけを true とする。

### 4.8 active compact projection

少なくとも一 region の `daily[4] > 0` で全 validation を通った場合に
`active` とする。

府県集約:

- 5 日積算は `daily[4]` を authoritative とする。
- `prefCode` ごとに最大値を求め、同一府県では最大の region を代表とする。
- active prefecture は府県最大値 1 以上とする。
- 全 active prefecture を「確率降順、`prefCode` 昇順」で整列する。
- `activePrefectureCount` は省略前件数とする。
- `maxFiveDayProbability` は全 active prefecture の最大値とする。

worst area は次の全順序で一意に選ぶ。

1. 5 日積算確率の降順
2. series 最大確率の降順。positive value がない場合は最下位
3. 最大値が最初に現れる slot の `startsAtMs` 昇順
4. `prefCode` 昇順
5. `areaCode` 昇順

`topPrefectures` は次の手順で最大 5 件にする。

1. ranked list の先頭 5 件を選ぶ。
2. worst area の府県が含まれればそのまま使う。
3. 含まれず 5 件ある場合は通常順位 5 番目を外し、worst 府県を追加する。
4. 追加後に「確率降順、`prefCode` 昇順」で再整列する。

invariant:

- `topPrefectures.length === min(5, activePrefectureCount)`
- prefecture code は一意
- worst prefecture はちょうど一件含まれる
- worst と同 code の top entry は prefecture name と probability が完全一致する
- `topPrefectures[0].fiveDayProbability === maxFiveDayProbability`
- `worstArea.fiveDayProbability === maxFiveDayProbability`
- `activePrefectureCount - topPrefectures.length` が full の省略件数になる

`peakAt` は worst area の positive series 最大値が最初に現れる slot の start
とする。positive value がなければ null。同率は最初の slot とし、
`baseTimeMs <= peakAtMs < forecastEndsAtMs` を満たす。parser の既存
`peak.time` を無検証で転記しない。

probability-only identity として name、nameKana、remark、typhoonNumber を保持する。
combined card では VPTW の同名 field だけを authoritative とし、VPTA で補完も上書きも
しない。VPTW と VPTA の identity が食い違っても bounded diagnostic に留め、共通
EventID がvalidなら probability slice自体は維持する。

### 4.9 non-projectable と expired

gate が受理した正規報が `nonProjectable` または `expired` なら:

- 該当 EventID の旧 probability slice を削除する。
- VPTW analysis slice を変更しない。
- gate は `cancelled: false` の active gate-only watermark として保持する。
- 旧報の復活を durable watermark で防ぐ。
- EventID、canonical revision、bounded reason を diagnostic に残す。
- CLI、ticker、parser diagnostic の既存用途は維持する。

projection が元からなくても gate mutation は durable である。

## 5. atomic gate commit と一 admission の処理

### 5.1 authoritative immutable commit record

旧案の outer decision、mutable receipt、別 trusted snapshot の三重表現は廃止する。
gate 内部が prospective entry から一つの immutable commit record を構成し、その構成成功と
gate map の置換を一つの同期 operation にする。

```ts
interface AcceptedTyphoonProbabilityBinding {
  revision: StandbyRevision;
  appliedSemanticKey: string;
}

interface VptaAcceptedCommit {
  stateSubjectKey: string;
  revisionFamily: "VPTA50";
  decision: TelegramRevisionDecision & { accepted: true };
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: readonly string[];
  cancelled: boolean;
  acceptedAtMs: number;
  tombstoneRetentionMs: 604_800_000;
  binding: AcceptedTyphoonProbabilityBinding;
}

type VptaGateResult =
  | { kind: "accepted"; commit: VptaAcceptedCommit }
  | {
      kind: "suppressed";
      decision: TelegramRevisionDecision & { accepted: false };
      durableChanged: boolean;
    };
```

- comparison、ordered semantic keys、decision、binding を prospective entry から全て作り、
  deep validate、deep-freeze してから map を変更する。
- gate map は commit record が参照する同じ frozen canonical entry を保持する。
- record の構成または freeze に失敗した場合、incoming gate state を変更しない。
- accepted を示す別 decision object、commit 後の map 再検索 API、receipt adapter を作らない。
- binding の `StandbyRevision` は `reportTimeMs` と
  `serial: string | null` だけを持つ。
- binding report time は committed comparison epoch と一致する。
- numeric serial は canonical decimal string、missing は null とする。
- `binding.appliedSemanticKey === semanticKeys.at(-1)` とする。
- commit record は router-private internal sidecar にだけ保持する。

accepted 直後の invariant assert は candidate classification と commit を同時に検査する。

- `canonicalInfoType === "取消"` と candidate `cancel` は必要十分である。
- candidate が `cancel` または `deactivateAllZero` なら `commit.cancelled === true`。
- candidate が `active`、`expired`、`nonProjectable` なら
  `commit.cancelled === false`。
- `commit.comparison.infoType.raw / value` は candidate classification の
  `canonicalInfoType` と一致する。

一件でも違えば `gateCommitInvariant` とする。gate は rollbackせず、§5.9 の reconcileで
projectionを安全側へ閉じ、failed completionを保存してからfail-loudにする。

構造上 authoritative value が一つしかないため、receipt と trusted snapshot の不一致、
test seam からの改変、どちらを failure reconcile が信頼するかという状態を作らない。

### 5.2 serial と InfoType の canonicalization

VPTA serial は live、v1 migration、dual-write で同じ pure functionを使う。

```ts
type NormalizedVpta50Serial =
  | { kind: "missing" }
  | { kind: "numeric"; numeric: number; canonicalRaw: string }
  | { kind: "invalid" };
```

- null と厳密な空文字だけを missing とする。
- `/^\d+$/` かつ finite safe integer を numeric とする。
- `"01"` と `"1"` は numeric 1、canonical raw `"1"` とする。
- whitespace、符号、小数、英字、unsafe integer は invalid。trim で救済しない。
- missing と numeric を同一視しない。
- invalid から partial comparison、semantic key、commit record を作らない。

```ts
type CanonicalVptaInfoType = "発表" | "訂正" | "取消";
```

envelope 由来の `parsed.meta.infoType` と decoded XML 由来の
`parsed.infoType` から、commit 前に canonical InfoType を一つだけ確定する。

1. meta の raw と value が byte-for-byte 同じ canonical 三値であることを要求する。
2. decoded XML の値も、その同じ canonical value と byte-for-byte 一致させる。
3. 一致した値を `canonicalInfoType` とする。

generic parser が trim 後に認識できても `" 取消 "`、`"発表 "`、`"\t訂正"` は
`invalidRevision` とする。meta と decoded XML が異なる場合は
`infoTypeMismatch` とし、projector、capacity plan、gate evaluate / commit へ進めない。
raw 全文を diagnostic に残さず、envelope / decoded の valid flag と bounded reason だけを
記録する。

stateless outcome baseline、cancel 判定、projector、prospective capacity class、gate comparison、
semantic key、commit の `cancelled` は全て同じ `canonicalInfoType` を引数で受ける。
いずれも `parsed.infoType` または `parsed.meta.infoType` を再読しない。

full comparison は canonical EventID、`VPTA50`、report time、canonical serial、
この canonical InfoType を持つ。projection は full comparison を複製せず `StandbyRevision`
だけを持つ。

### 5.3 admission 開始境界、maintenance、protection

router の VPTA route は parse preparation と started admission を分離する。

1. `parseTyphoonProbability(message)` を一回実行する。
2. null なら既存 raw fallback とし、VPTA admission は未開始で completion を発火しない。
3. non-null なら §4.1 の EventID triage を行う。invalid / 過長なら同じ InfoType
   canonicalizerを通した stateless transient outcomeを作るが、VPTA admission は未開始で
   completionを発火しない。transient側のInfoType mismatch / baseline failureはrawへ落とさず、
   admission外のroute failureとしてfail-loudにする。
4. valid EventID を確定した直後を started admission の開始点とする。

現行の `processTyphoonProbability()` は parse と level baseline を一つの opaque call にせず、
router が上記境界を表現できる内部 seam へ分ける。parse-null だけを raw fallback とし、
started 後の outcome baseline / level helper の throw または invariant failure を raw へ
落とさない。`processorBaseline` の failed completion として fail-loud にする。

started admission は次の順で処理する。

1. classification clock を検証する。
2. canonical InfoType を確定し、decoded XML との一致を検証する。
3. canonical InfoType を渡して stateless outcome baseline を一回構成する。
4. 同じ canonical InfoType を渡して projector を一回実行する。
5. `classificationNowMs` で VPTA gate family を expire する。
6. expiry 後の active gate subject 集合を取得する。
7. 同じ時刻で期限切れ、gate orphan の probability projection を削除する。
8. store から active probability subjects の read-only snapshot を取得する。
9. snapshot を検証し、capacity bundle を組む。
10. serial を canonicalize する。InfoType は手順2の値を再利用する。
11. pure capacity plan を作る。
12. gate を evaluate / commit する。

`activeTyphoonProbabilitySubjects(nowMs)` は
`expiresAtMs > nowMs` の projection subject を重複なし、code-unit 辞書順で返し、
state を mutate しない。

provider result は array、全要素 string、exact
`typhoonProbability:<EventID>`、EventID 1〜128 文字、再構成一致を要求する。
`undefined`、non-array、invalid prefix、blank、過長、non-string は
fail-closed とする。

- incoming gate を評価しない。
- incoming projection、holder、managed subject、notification、display を変更しない。
- 先に確定した expiry / cleanup は維持する。
- bounded `vpta50ProtectionSnapshotInvalid` を記録する。

### 5.4 capacity bundle

live gate と persistence reader は同じ pure selector を使用する。

| class | 内容 | protected |
|---|---|---:|
| `P+G` | valid active projection と対応 active gate | yes |
| `GT` | projection のない valid cancelled tombstone | yes |
| `GA` | projection のない valid active watermark | no |

- incoming active は prospective `P+G`。
- incoming cancel / strict all-zero は prospective `GT`。
- incoming expired / non-projectable は prospective `GA`。
- existing gate が cancelled なら `GT`、active subject snapshot に含まれる
  non-cancelled gate は `P+G`、残りは `GA`。
- protected が 256 を超える場合は `protectedOverflow` とし、一件も
  protected eviction しない。
- protected が上限内なら全て保持し、必要数の `GA` だけを除外する。
- victim 全順序は `acceptedAtMs` 昇順、EventID code-unit 辞書順昇順。
- incoming 自身も候補に含める。incoming が victim なら candidate を拒否し、既存 entry
  を変更しない。
- existing subject の newer update は新 slot を使わないため 256 件時も受理できる。
- plan は gate mutation 前に完了し、commit 後の事後 eviction で帳尻を合わせない。

### 5.5 accepted 呼出し列

gate accepted 後は次の順にする。

1. commit record と candidate / canonical InfoType の対応 invariant を assert する。
2. generic revision decision callback。
3. persistence を所有しない standby revision observer。
4. candidate と commit binding の finalizer。
5. notification holder の atomic mutation。
6. public `ProcessOutcome` の構成。
7. outcome stats。
8. correlator と必要な同期 action。
9. notifier。
10. post-notifier stats。
11. `outcomeTaps`。public main は public outcome だけを渡す。
12. public `PresentationEvent` への変換。
13. diff、filter、summary、daily counter。
14. display sink の standby reducer と managed retention。
15. display sink の他 store / hub 処理。
16. mutation evidence の合流。
17. VPTA completion callback と persistence dispatch。
18. post-completion presentation。

external callback、observer、notifier、console、display から戻るたび serializer poison latch を
確認し、次の durable mutationへ進む前に停止できるようにする。

特に各 synchronous outcome tap の return または catch 直後に latch を検査する。通常の
tap throw と誤った async tap の rejection は従来どおり隔離・診断し、admission failure に
しない。一方、tap 内の同期再入が overload 等で sticky poison を設定した場合は、tap 側が
nested error を捕捉していても残りの tap と手順12以降へ進まず、§5.9 の
`outcomeTapPoison` へ遷移する。

### 5.6 public data と internal sidecar の分離

`FinalizedTyphoonProbabilityClassification` と commit record は public outcome
または event の property にしない。

```ts
interface VptaDisplayIngestCommand {
  domain: "typhoonProbability";
  finalized: FinalizedTyphoonProbabilityClassification;
  commit: VptaAcceptedCommit;
}

interface ProcessMessageInternalResult {
  outcome: ProcessOutcome;
  internal?: {
    vptaDisplayCommand: VptaDisplayIngestCommand;
  };
}
```

- router は `outcome` だけを stats、correlator、notifier、outcome taps、
  `toPresentationEvent()` へ渡す。
- internal command は router から monitor display sink の第二引数へ直接渡す。
- `PresentationEvent` と `ProcessOutcome` に
  `typhoonProbabilityClassification` その他の internal property を追加しない。

public main lane は、`outcomeTaps` に渡る public outcome と、同じ outcome から生成される
public `PresentationEvent` の双方を capture する。actual internal field に埋めた一意な sentinel
value を object / array 全体で再帰検索し、一件も到達しないことを試験する。少なくとも
`internal.vptaDisplayCommand`、`finalized.canonicalInfoType`、
`finalized.acceptedRevision`、`finalized.appliedSemanticKey`、
`commit.stateSubjectKey`、`commit.comparison`、`commit.semanticKeys`、
`commit.binding` の実 field ごとに異なる sentinel を使用する。generic な
`commit` 等の property 名だけで判定せず、fixture 固有 sentinel value の到達を検査する。

personal branch overlay lane は、main の型を広げず次を追従する。

- `EventFileWriter` は public outcome だけを受け、internal sidecar を受け取る API を持たない。
- event-file `version: 1`、existing event fields、body、raw、exploration hints の契約を
  変更しない。
- includeRaw true / false の双方で serialized event subtree を再帰検査し、上記の
  actual-field sentinel value が一件もないことを試験する。

この境界により、overlay の serializer で internal field を引き算するのではなく、writer の
入力に internal classification が到達しない構造にする。main lane は overlay 用stub、
conditional import、skip testを置いてこの追従を代替しない。

### 5.7 display sink と store mutation

display sink は public event を従来どおり各 store / hub へ渡し、VPTA internal command だけを
`StandbyStateStore.applyTyphoonProbabilityCommand()` へ渡す。

- reducer と managed retention は各 method 単位で atomic にする。
- reducer は projector、serial normalization、semantic-key generation、gate decision を
  再実行しない。
- reducer は current router owner の opaque token を assert する。token は保存・公開しない。
- standby reducer と retention の mutation evidence を、後続 store / hub より先に確保する。
- retention failure は完了済み reducer evidence を失わない。
- post-standby store / hub failure は `displaySinkPostStandby` として返し、
  完了済み standby evidence を失わない。
- `onChange()` listener は個別に catch し、後続 listener を呼ぶ。observer failure は
  mutation failure にしない。
- observer diagnostic は operation と失敗件数だけを持つ。

### 5.8 completion と persistence ownership

§5.3 で valid EventID を確定した時点から started admission とする。started admission は
accepted、suppressed、failed のいずれか一つの completion をちょうど一回発火する。
transport duplicate、日時拒否、ignore、parse-null raw fallback、transient、queue 待機中、
未開始破棄は started admission ではなく completion を発火しない。started 後の
`processorBaseline` failure は必ず failed completionへ閉じる。

```ts
type VptaAdmissionCompletion =
  | {
      kind: "accepted";
      nowMs: number;
      durableChanged: true;
      persistence: "deferred";
      changes: VptaDurableChangeFlags;
    }
  | {
      kind: "suppressed";
      nowMs: number;
      durableChanged: false;
      persistence: "none";
      changes: VptaDurableChangeFlags;
    }
  | {
      kind: "suppressed";
      nowMs: number;
      durableChanged: true;
      persistence: "deferred";
      changes: VptaDurableChangeFlags;
    }
  | {
      kind: "failed";
      nowMs: number;
      durableChanged: false;
      persistence: "none";
      changes: VptaDurableChangeFlags;
      stage: VptaFailureStage;
    }
  | {
      kind: "failed";
      nowMs: number;
      durableChanged: true;
      persistence: "immediate";
      changes: VptaDurableChangeFlags;
      stage: VptaFailureStage;
    };

interface VptaDurableChangeFlags {
  gateExpiry: boolean;
  projectionCleanup: boolean;
  incomingGate: boolean;
  projectionOrRetention: boolean;
}

type VptaPersistenceCompletionAck =
  | { kind: "notRequired" }
  | {
      kind: "scheduled";
      receipt: StandbyPersistenceScheduleReceipt;
    }
  | {
      kind: "flushed";
      receipt: StandbyPersistenceScheduleReceipt;
      result: Extract<
        StandbyPersistenceFlushThroughResult,
        { kind: "written" | "alreadyWritten" }
      >;
    }
  | {
      kind: "failed";
      operation:
        | "completionCallback"
        | "exportActiveState"
        | "schedule"
        | "flushThrough";
      completionAlreadyEmitted: boolean;
      receipt: StandbyPersistenceScheduleReceipt | null;
      cause: unknown;
    };

type VptaAdmissionCompletionAdapter = (
  completion: VptaAdmissionCompletion,
) => VptaPersistenceCompletionAck;
```

`durableChanged` は四 flag の OR から canonical constructor が再計算する。

- accepted は incoming gate commit があるため true / deferred。
- normal suppressed は false / none または true / deferred。
- failure は false / none または true / immediate。
- discriminated union にない durability / persistence 組合せを型上生成しない。
- callback は四 change flag と literal の一致も runtime assert し、不正なら I/O 前に
  fail-loud。
- callback failure、export failure、schedule failure、flush failureは第四の admission
  completion にしない。
- persistence failure後に同じ completion を再発火しない。
- outermost serializer は `scheduled / flushed` ack の最大 receipt seq を、その
  turn の durable floor として記録する。
- adapter は expected failureをthrowせず `failed` ackへ閉じる。schedule成功後に
  実行できる処理はreceiptの保存とreturnだけにし、「schedule済みだがreceipt不明」の窓を
  作らない。
- immediate flush failureのfailed ackはschedule receiptを保持する。export / schedule前の
  failureはreceipt nullとする。

VPTA admission 全体を monitor の
`withStandbyDurableNotificationsSuppressed()` 内で同期実行する。

- `StandbyStateStore.onDurable()` だけを抑止し、`onChange()` は
  抑止しない。
- scope は depth counter と `try/finally` で解除する。
- 抑止した durable listener を scope 終了時に replay しない。
- scope 内に await、timer、microtask boundary を置かない。
- completion adapter だけが final `exportActiveState()` と
  `StandbyPersistence.schedule()` を所有する。
- normal durable completion は schedule 一回。
- failed durable completion は schedule receipt を取得し
  `flushStandbyThrough(receipt.seq)` を一回実行する。
- persistence dispatch failureは serializer infrastructure failureとして poisonし、
  未開始 queue を破棄する。writer pending stateは保持し、自動 retryしない。

### 5.9 failure reconcile

gate commit 前の失敗は incoming gate を変更しない。先に成立した expiry / cleanup は維持し、
failed completionへ含める。

pre-gate stage は次を識別する。

`classificationClock`、`infoTypeCanonicalization`、`processorBaseline`、`projector`、
`admissionGateExpiry`、`activeSubjectSnapshot`、`projectionCleanup`、
`protectionSnapshot`、`serialCanonicalization`、`capacityPlan`、`gateEvaluate`。

gate commit 後の失敗は commit recordだけを基準に当該 probability subjectを reconcileする。

- commit が cancelled なら projection を削除する。
- finalized kind が active で、reducer が commit binding と完全一致する active state を
  atomic commit 済みならその projection を保持できる。
- active state の report time、serial、applied semantic key、subject、expiry のいずれかを
  証明できなければ projection を削除する。
- finalized kind が cancel、all-zero、expired、non-projectable なら projection を削除する。
- 新しい projection を failure path で合成しない。
- gate rollback、旧 projection の再結合、holder / stats / notifier / display の replayを
  行わない。
- VPTW analysis、別 EventID、別 domain を変更しない。
- reconcile後は `P+G`、`GA`、`GT` のいずれかに閉じる。

post-gate stage は少なくとも次を識別する。

`gateCommitInvariant`、`genericRevisionCallback`、
`standbyRevisionObserver`、`finalizer`、
`notificationHolder`、`outcomeBinding`、
`recordStats`、`correlator`、`notifier`、
`postNotifierStats`、`outcomeTapPoison`、`eventConversion`、
`displayPreprocess`、`standbyReducer`、
`managedRetention`、`displaySinkPostStandby`。

`outcomeTapPoison` は通常の tap exception を表さない。outcome tap の同期実行中に nested
router call が sticky poison を設定し、その latch を tap return / catch 直後に検出した場合だけ
使用する。この stage では gate nonrollback、fail-closed reconcile、failed completion、
immediate flush を順に完了し、recoverable drainへは戻らない。poison causeを保持したまま
未開始 queueを破棄し、outermost turnでfail-loudにする。

failure completion と immediate flush が成功してから recoverable error を drain error listへ
加える。flush が失敗したら infrastructure poison とし、元 cause、persistence cause の順で
aggregateする。

### 5.10 post-completion presentation

durable completion と persistence dispatch の後に、次を best-effort で行う。

| operation | 条件 | failure 後 |
|---|---|---|
| `publishStats` | 常に一回 | diagnostic 後も続行 |
| `focus` | displayed | throw 時は通常表示側へ続行 |
| `template` | focus で除外されない | render throw 時だけ通常表示へ fallback |
| `consoleOrDisplay` | 選択された一経路 | 別経路へ retry しない |
| `presentedStats` | output 成功時 | 表示を replay しない |

- displayed false は publishStats だけ。
- focus false + display rendererありは dim summaryだけ。
- focus false + rendererなしは既存互換で template判定へ進む。
- template が文字列ならその console 出力だけ。
- template console、compact console、displayFn の失敗後は別表示へ進まない。
- output 失敗では presented を加算しない。
- presented stats failureでも outputを再実行しない。
- 通常の presentation failure は gate、projection、completion、persistence、serializer healthを
  変更しない。
- callbackからの reentrant queue overloadだけは通常presentation failureとして隔離せず、
  §3.4 の durable floorを確定してfail-loudにする。

## 6. state、snapshot、通知履歴

### 6.1 probability state

`StandbyStateStore` に VPTW analysis map と分離した probability map を持つ。

```ts
interface TyphoonProbabilityState {
  eventId: string;
  sourceEventId: string;
  identity: {
    name: string | null;
    nameKana: string | null;
    remark: string | null;
    typhoonNumber: string | null;
  };
  baseTimeMs: number;
  maxFiveDayProbability: number;
  activePrefectureCount: number;
  topPrefectures: TyphoonProbabilityPrefectureState[];
  worstArea: TyphoonProbabilityWorstAreaState;
  revision: StandbyRevision;
  appliedSemanticKey: string;
  expiresAtMs: number;
  restored: boolean;
}

private typhoonProbabilities = new Map<string, TyphoonProbabilityState>();
```

map key は validated EventID とする。map には active projection だけを置き、all-zero、
cancel tombstone、expired / non-projectable watermark は置かない。runtime probability map
は 256 件以下とする。

### 6.2 VPTA transition

記号:

- `A0 / A1`: analysis slice なし / あり
- `P0 / P1`: probability slice なし / あり
- `GA`: projection を伴わない active VPTA gate
- `GT`: cancelled VPTA gate

| current | active | all-zero / cancel | expired / non-projectable |
|---|---|---|---|
| `A0/P0` | probability-only | visible empty + `GT` | visible empty + `GA` |
| `A0/P1` | probability 置換 | probability 削除 + `GT` | probability 削除 + `GA` |
| `A1/P0` | combined | analysis-only + `GT` | analysis-only + `GA` |
| `A1/P1` | probability だけ置換 | probability だけ削除 + `GT` | probability を fail-closed 削除 + `GA` |

- probability がなくても all-zero / cancel gate mutation は durable。
- probability がなくても expired / non-projectable gate mutation は durable。
- VPTA live update は probability の `restored` だけを false にする。
- VPTA input は analysis revision、expiry、restored、VPTW field を変更しない。

### 6.3 VPTW transition

| current | VPTW active | VPTW cancel / end / expiry |
|---|---|---|
| `A0/P0` | analysis-only | visible empty |
| `A0/P1` | combined | probability-only |
| `A1/P0` | analysis だけ置換 | card 削除 |
| `A1/P1` | analysis だけ置換 | probability-only |

- VPTW live update は analysis の `restored` だけを false にする。
- VPTW input は probability revision、expiry、restored、content を変更しない。

### 6.4 sweep

| state | condition | result |
|---|---|---|
| `P1` | forecast end 到達 | probability 削除。retention 内 `GA` は維持 |
| `P1 + active gate` | gate retention expiry | gate と probability を同じ maintenance で削除 |
| `P0 + GA` | gate retention expiry | gate だけ削除 |
| `P0 + GT` | tombstone retention expiry | gate だけ削除 |

analysis slice は全行で独立に維持する。cancelled gate と active projection の組は invariant
違反であり、restore / reconcile で projection を除外する。

stale、exact duplicate、semantic duplicate、invalid revision、capacity rejection は incoming
由来の projection、holder、managed subject を変更しない。alias migration と admission 前
maintenance は incoming suppression と独立した durable change として保存する。

### 6.5 notification zero history

`TyphoonProbabilityStateHolder` は process-local notification UX state として
維持し、最大 256 件、deterministic LRU、entry 自身の acceptedAt 起点 7 日 TTL とする。

accepted finalized classification だけを適用する。

| finalized kind | holder mutation |
|---|---|
| active | EventID、maxFiveDayProbability、acceptedAt を upsert |
| deactivateAllZero | 0 と acceptedAt を upsert |
| cancel | 当該 EventID を削除 |
| expired | 既存 entry を変更せず、新規作成しない |
| nonProjectable | 既存 entry を変更せず、新規作成しない |

- stale、duplicate、invalid、capacity rejection、snapshot invalid は holder を変更しない。
- admission 前 gate expiry / projection cleanup は holder の削除理由にしない。
- `retainEventIds(activeSubjects)` による即時削除を廃止する。
- accepted zero の直前 entry も zero の場合だけ `isUnchangedZero: true`。
- expired / nonProjectable は値、LRU、acceptedAt、TTL を延長しない。
- explicit cancellation だけが明示削除する。
- holder mutation は persistence callback を発火しない。

sequence:

- zero → nonProjectable / expired → newer zero は TTL 内なら抑制する。
- nonzero → nonProjectable / expired → zero は変更として通知する。
- zero → cancel → newer zero は新しい zero として一回通知され得る。
- restart 後は durable gate が exact / old replay を拒否する。genuinely newer zero は
  process-local history が空なら一回通知され得る。

### 6.6 snapshot authoritative rule

`kind: "typhoon"` item は analysis map と probability map の EventID union から
snapshot 時だけ生成する。

| field | analysis あり | probability-only |
|---|---|---|
| `typhoonKey` | EventID | VPTA EventID |
| name / kana / remark / number | VPTW | VPTA identity |
| category / class / position / pressure / wind / move | VPTW | null または既存 optional 省略 |
| reportDateTime | VPTW revision | VPTA revision |
| probability | probability state があれば付与 | 必須 |

VPTA は combined card の VPTW field を補完または上書きしない。

outer `ActiveStandbyCardV1`:

- key は既存 `typhoon:active`。
- `sourceEventIds` は visible slice の nonblank sourceEventId を重複除去し、
  code-unit 辞書順にする。
- `updatedAt` は visible slice の `revision.reportTimeMs` 最大値。
- `expiresAt` は visible slice の `expiresAtMs` 最大値。
- `restored` は visible slice の OR。
- analysis があれば severity は analysis だけから既存
  `typhoonStandbySeverity()` で決める。
- probability-only は severity `normal`。
- typhoon array は表示用 typhoonNumber、次に EventID の code-unit 辞書順。
- slice が消えたら残りだけから outer metadata を再計算する。

## 7. protocol と frontend

### 7.1 protocol

engine と frontend の `DisplayTyphoonV1` に同じ optional slice を追加する。

```ts
export interface DisplayTyphoonProbabilityPrefectureV1 {
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
}

export interface DisplayTyphoonProbabilityWorstAreaV1 {
  areaCode: string;
  areaName: string;
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
  peakAt: string | null;
}

export interface DisplayTyphoonProbabilityV1 {
  baseTime: string;
  forecastEndsAt: string;
  reportDateTime: string;
  maxFiveDayProbability: number;
  activePrefectureCount: number;
  topPrefectures: DisplayTyphoonProbabilityPrefectureV1[];
  worstArea: DisplayTyphoonProbabilityWorstAreaV1;
}

export interface DisplayTyphoonV1 {
  // existing fields
  probability?: DisplayTyphoonProbabilityV1;
}
```

- absent は field 省略とし null を書かない。
- `DISPLAY_PROTOCOL_VERSION` は 1 のまま。
- VPTW-only wire shape は optional field 省略以外変更しない。
- timestamp の numeric state を authoritative とし、ISO は snapshot 時に生成する。
- TimeDefine、all slots、regions、daily、series40、diagnostics、internal sidecar を載せない。

### 7.2 TyphoonCard

一台風 block 内に次の section を追加する。

```text
暴風域に入る確率（5日以内）
```

full:

- `最大5日確率 <n>%`
- 最大 5 府県の府県名と 5 日積算確率
- 省略があれば `ほか<n>府県等`
- worst area
- worst area の peakAt、null は `ピーク時刻不明`

compact:

- `5日以内 最大<n>%`
- 最大 3 府県
- 省略があれば `ほか<n>府県等`
- worst area と peakAt を一行

absolute ISO を `Asia/Tokyo` で format する。文字列 slice で日時を作らない。
probability-only でも header title は「台風情報」とする。

### 7.3 色

- probability 1 / 50 / 100% 等を severity、header tone、警報色へ変換しない。
- probability section に advisory / warning / emergency / critical の背景、bar、badge を
  追加しない。
- combined card は VPTW `intensityClass / sizeClass` だけを
  `typhoonHeaderTone()` へ渡す。
- probability-only は既存 `standby-card-header--muted`。
- weather header token は VPTW tone が存在するときだけ使用する。
- 新 color token、probability header band、独自 severity class を追加しない。
- 既存 foreground、muted text、hairline、spacing token を使う。
- `RestoredChip` と `UpdatedStamp` の位置を変えない。

### 7.4 full / compact / overflow

- `KNOWN_KINDS`、`CARD_ORDER`、
  `CENTER_ELIGIBLE_KEYS`、`ROTATION_REVERSE_ORDER`、
  `MAX_ROTATION_CANDIDATE_PASSES` を VPTA のために変えない。
- existing full → typhoon compact → rotation / overflow の順を維持する。
- probability-only も full / compact の双方で測定する。
- card が収まらなければ clip せず既存 rotation / overflow へ送る。
- overflow は typhoon card 一件と数え、probability を別 card として数えない。

candidate score:

```text
2 + 4 × visible typhoon count + 2 × probability slice count
```

score は content weight であり severity ではない。

measurement signature は analysis の既存 tuple に次の canonical tuple を追加する。

```ts
type ProbabilityMeasurementTuple =
  | ["probability", "absent"]
  | [
      "probability",
      "present",
      displayMode,
      eventId,
      baseTime,
      forecastEndsAt,
      reportDateTime,
      maxFiveDayProbability,
      activePrefectureCount,
      renderedOmittedLabel,
      Array<[prefectureCode, prefectureName, fiveDayProbability]>,
      [
        worstAreaCode,
        worstAreaName,
        worstPrefectureCode,
        worstPrefectureName,
        worstFiveDayProbability,
        worstPeakAtIso,
        renderedWorstPeakLabel,
      ],
      restored,
    ];
```

- full は表示 5 件、compact は表示 3 件を順序どおり全て含める。
- omitted label と JST peak label は実際の render 文字列を含める。
- null peak は `ピーク時刻不明` を含める。
- absent は専用 sentinel とする。
- canonical tuple 全体の `JSON.stringify()`、またはその全 bytes の hash を使う。
- code、name、probability、order、worst、peak、omitted count、mode、restored の変更で
  signature を変える。
- object identity だけが変わり表示値が同じなら変えない。

## 8. persistence schema と writer

### 8.1 schema

既存 root に optional projection と rollback metadata を追加する。

```ts
interface PersistedTyphoonProbabilityPrefectureV1 {
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
}

interface PersistedTyphoonProbabilityWorstAreaV1 {
  areaCode: string;
  areaName: string;
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
  peakAtMs: number | null;
}

interface PersistedTyphoonProbabilityStateV1 {
  key: string;
  sourceEventId: string;
  identity: {
    name: string | null;
    nameKana: string | null;
    remark: string | null;
    typhoonNumber: string | null;
  };
  baseTimeMs: number;
  maxFiveDayProbability: number;
  activePrefectureCount: number;
  topPrefectures: PersistedTyphoonProbabilityPrefectureV1[];
  worstArea: PersistedTyphoonProbabilityWorstAreaV1;
  revision: StandbyRevision;
  appliedSemanticKey: string;
  expiresAtMs: number;
}

interface PersistedTyphoonProbabilityGateMetadataV1 {
  stateSubjectKey: string;
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: string[];
  cancelled: boolean;
}

interface PersistedStandbyStateV1 {
  // existing fields
  typhoonProbabilities?: PersistedTyphoonProbabilityStateV1[];
  typhoonProbabilityGateMetadata?: PersistedTyphoonProbabilityGateMetadataV1[];
}
```

- `PERSIST_SCHEMA_VERSION` は 2。
- v2 の canonical pair は `typhoonProbabilities` と
  `telegramFoundation.standbyDomains.gateEntries` の VPTA entries。
- v2 root rollback mirror と standalone v1 に同じ projection、seen、gate metadata を書く。
- probability が空なら field を省略する。
- VPTA gate が空なら metadata field を省略する。
- `restored` は保存せず restore 時に true。
- existing `typhoons` は VPTW analysis だけ。
- projection と gate metadata は EventID / subject の code-unit 辞書順。
- semanticKeys の内部順は受理順であり sort しない。

### 8.2 projection invariant

authoritative field:

- EventID は outer `key`。
- report time / serial は `revision`。
- base は `baseTimeMs`、forecast end / expiry は `expiresAtMs`。
- peak は `worstArea.peakAtMs`。
- ISO mirror は保存しない。

validation:

- active probability は 1〜100。
- `maxFiveDayProbability` は top first と worst probability に一致。
- top length は `min(5, activePrefectureCount)`。
- top code は一意、確率降順、同率 code 昇順。
- worst prefecture は top にちょうど一件あり、name / probability が完全一致。
- `expiresAtMs > baseTimeMs`、差は 120 時間以下。
- non-null peak は `baseTimeMs <= peakAtMs < expiresAtMs`。
- zero projection を保存しない。

writer / reader は保存されていない全 prefecture ranking や除外された通常順位 5 番目を
推測しない。live projector が強制挿入済み compact list を作り、persistence は上記 local
invariantだけを検査する。不一致を暗黙補正せず subject bundle を除外する。

### 8.3 共通 field limit

```ts
TYPHOON_PROBABILITY_MAX_SUBJECTS = 256
TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS = 1024
TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES = 1024
TYPHOON_PROBABILITY_MAX_TOP_PREFECTURES = 5
TYPHOON_PROBABILITY_MAX_ACTIVE_PREFECTURES = 600
TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH = 128
TYPHOON_PROBABILITY_MAX_SOURCE_ID_LENGTH = 256
TYPHOON_PROBABILITY_MAX_CODE_LENGTH = 32
TYPHOON_PROBABILITY_MAX_NAME_LENGTH = 128
TYPHOON_PROBABILITY_MAX_REMARK_LENGTH = 256
TYPHOON_PROBABILITY_MAX_SEMANTIC_KEY_LENGTH = 1024
TYPHOON_PROBABILITY_ACCEPTED_AT_FUTURE_SKEW_MS = 15 * 60_000
TYPHOON_PROBABILITY_REPORT_FUTURE_SKEW_MS = 15 * 60_000
TELEGRAM_REVISION_MAX_SEMANTIC_KEYS = 32
```

live projector、reducer、writer、v2 reader、v1 migration は同じ boundary validator を使う。

| field | canonical range |
|---|---|
| EventID / projection key | trim 済み nonblank、1〜128、完全一致 |
| sourceEventId | trim 済み nonblank、1〜256 |
| area / prefecture code、typhoonNumber | nullableを除き nonblank、1〜32 |
| area / prefecture name、name、nameKana | nullableを除き nonblank、1〜128 |
| remark | null または trim 済み nonblank、1〜256 |
| applied / gate semantic key | trim 済み nonblank、1〜1,024 |
| raw regions / active prefectures | 1〜600 |
| topPrefectures | 1〜5、`min(5, activeCount)` |
| active probability | 1〜100 finite safe integer |
| raw probability | 0〜100 または許可された null |
| timestamp | finite safe integer、有効 Date epoch |
| semanticKeys | reserved legacy tombstone以外 1〜32 |

reader は trim、truncate、補完、code置換、numeric string化で救済しない。
live limit+1 は EventID だけ transient、他は nonProjectable。reducer は挿入拒否、
writer は I/O 前 fail-loud、reader は当該 bundle だけ除外する。

### 8.4 gate entry と semanticKeys

v2 VPTA gate と v1 metadata は次を検証する。

- subject は exact `typhoonProbability:<EventID>`。
- comparison subject と一致。
- eventId raw / value は prefix なし EventID と byte-for-byte 一致し valid。
- type raw / value は `VPTA50` と一致し valid。
- InfoType raw / value は canonical三値で一致し valid。
- reportDateTime は valid で raw 再parse epoch が一致。
- numeric serial は canonical raw / numeric が一致。missing は raw / numeric null、
  valid false。
- acceptedAt は `nowMs + 15分` 以下。
- report epoch は `acceptedAtMs + 15分` 以下。
- cancelled は boolean。
- InfoType cancel は cancelled true。逆は要求しないため all-zero deactivation の
  `発表 / 訂正 + cancelled true` を許可する。
- v2 writer は active / cancelled とも
  `tombstoneRetentionMs: 604800000` を明示する。

retention property 欠落だけは旧 v2 compatibility として 604800000 へ defaultし、
diagnostic + rewrite とする。explicit null、別型、別値、unsafe/nonfinite は present-invalid
として subject を claim / rejectし、legacy fallbackへ流さない。

semanticKeys は oldest → newest。

- 新 key は末尾。
- 32 件 compact は先頭の最古 key を除く。
- duplicate key は newest occurrence 一件を残し、他 key の相対順を維持する。
- persistence、restore、mirror compare で sort しない。
- active と通常 tombstone は unique nonblank 1〜32。

旧 v1 seen-only 専用 reserved shape:

```ts
entry.cancelled === true && entry.semanticKeys.length === 0
```

この形は metadata property が存在しない旧 v1 seen-only、または同じ旧形式の
missing-applied-key fallback からだけ生成・維持する。live admission、通常 active、
all-zero、cancel から空 keys を作らない。`cancelled: false + []` は常に不正。

### 8.5 projection / gate coupling

active projection の restore には一件の valid non-cancelled gate を要求する。

- domain / family / subject / EventID / type が一致。
- projection revision と gate report time / normalized serial が一致。
- semanticKeys が一件以上。
- `projection.appliedSemanticKey === gate.semanticKeys.at(-1)`。
- gate が retention 内。
- projection expiry が未来。

gate `[A, B]` と projection A は、A が配列内にあっても不一致として projection
を除外する。gate B と projection B だけを current pair とする。

projection 不正 / mismatch でも gate 自体が valid なら `GA` または
`GT` として旧報抑止に残せる。gate が不正なら projection を単独で残さない。
`GA / GT` に projection がないこと自体は orphan ではない。

### 8.6 domain-local salvage と capacity

reader は raw item / bundle を 1,024 件まで bounded parse する。1,025 件なら array の先頭を
採用せず、VPTA projection、VPTA gate、VPTA metadata、対応 seen を VPTA persistence
domain として除外する。VPTW analysis と他 domain は維持する。

1. optional property の own-property mode を確定する。
2. raw array 各件数を検査する。
3. deep validate する。この段階で canonical 256 limit を適用しない。
4. duplicate subject を入力順非依存で検出する。
5. EventID 単位に projection / gate / metadata / seen bundle を構成する。
6. bundle count hard limit を検査する。
7. coupling後に `P+G / GA / GT` へ分類する。
8. 257〜1,024 valid bundles は §5.4 の selector で 256 へする。

- duplicate は後勝ちにせず該当 subject の全 candidate を除外する。
- malformed top item、order、coupling、scalar が一件でもあれば projection subject 全体を
  除外する。
- projectionだけ落とし valid gateを再分類できる。
- protected `P+G / GT` が 257 件なら 256件を選ばず VPTA domain 全体を
  fail-closed 除外する。
- protected が 256 以下なら全 protected を維持し、`GA` だけを deterministic
  victim順で除外する。
- retained `P+G` は restored cardを生成できる。`GA / GT` は
  cardを生成しない。
- canonical rewrite 後の reload で除外 bundle を復活させない。

### 8.7 v2 authoritative と rollback mirror

正常な v2 canonical が存在すれば常に v2 を authoritative とする。v2 root rollback mirror
または standalone v1 の値で置換・追加しない。

canonical v2 から期待する rollback projectionを決定的に生成し、次を意味比較する。

- projection
- seen
- gate metadata
- subject、revision、comparison、ordered semanticKeys、cancelled
- acceptedAt、retention、projection有無、appliedSemanticKey

`savedAt`、file順、object key順は無視する。missing、malformed、duplicate、
extra、semantic mismatch は repair diagnostic と canonical rewrite を必須にする。
repair は v2 root mirror と standalone v1 の双方を同じ canonical state から再生成し、
二段目 reload で同じ repairを再要求しない。

### 8.8 v1 migration

root `typhoonProbabilityGateMetadata` を own-property で分類する。

| state | mode | legacy fallback |
|---|---|---:|
| property 自体なし | absent | yes |
| array、空配列を含む | present-array | no |
| null / object / scalar / undefined property | present-invalid | no |

present-invalid を absent / empty array に補正しない。standalone v1 では VPTA rollback domainを
除外し、正常 v2 の mirrorなら v2を維持してrepairする。present-arrayで特定subjectの
metadataが欠落してもlegacy fallbackへ流さない。

v1 seenは revision match前に normalized keyでgroup化する。同じ keyが二件以上なら
revision / forgetAt が同じでも全 candidateをduplicate rejectし、別migration pathへ
再投入しない。

`forgetAtMs` の境界:

```text
write:   forgetAtMs  = acceptedAtMs + 604800000 + 1
restore: acceptedAtMs = forgetAtMs - 604800000 - 1
```

file savedAt、migration now、report time を acceptedAt 起点へ使わない。acceptedAt は fixed
now + 15分、report time は acceptedAt + 15分までを inclusive に許可し、+1ms は拒否する。

present-array:

- metadata と一意 seen の subject、revision、canonical serial を照合する。
- metadata comparison、ordered keys、cancelled を authoritative とする。
- non-cancelled + latest-key projection は `P+G`。
- non-cancelled + projectionなし / expired / malformed / missing-key / old-key は
  projectionを除き `GA`。
- cancelled は projectionを除き `GT`。
- malformed / duplicate / mismatch はbundle reject。legacy fallbackなし。

absent legacy:

- `/^(発表|訂正):[0-9a-f]{64}$/` を満たす semantic key付き valid projection
  + 一意 seen から strict active `P+G` を再構成できる。
- projectionなし + 一意 seen は reserved empty-key `GT`。
- missing-applied-key projection + 一意 seen は projectionを捨て reserved
  empty-key `GT`。
- active InfoType は semantic key の canonical `発表: / 訂正:` prefixからだけ
  決める。
- tombstone InfoType は取消。
- semantic keyを推測、hash再生成、prefix置換しない。
- strict EventID、type、report ISO、serial、InfoTypeを全て生成できない場合はgateを作らない。

legacy mode、coupling、retention、mirror repairのdiagnosticは少なくとも
`vpta50V1GateMetadataPresentInvalid`、
`vpta50V1GateMetadataMissing`、
`vpta50V1MissingAppliedSemanticKey`、
`vpta50V1RevisionReconstructionFailed`、
`vpta50GateRetentionDefaulted`、
`vpta50GateRetentionInvalid`、
`vpta50PersistenceCouplingMismatch` をboundedに区別する。

static fixtureの expected comparison は helper で生成せず literalにする。
live→save→reload と v1→v2→reload で canonical ISO、`"01" → "1"`、missing
serial、InfoType、acceptedAtを再変化させない。

### 8.9 fail-loud writer

```ts
type StandbyPersistenceWriteFailureStage =
  | "validation"
  | "salvageBackup"
  | "mkdir"
  | "writeV2Temp"
  | "writeV1Temp"
  | "renameV2"
  | "renameV1"
  | "pendingUnavailable"
  | "pendingBehindRequiredSeq";

interface StandbyPersistenceScheduleReceipt {
  kind: "scheduled";
  seq: number;
}

type StandbyPersistenceFlushThroughResult =
  | {
      kind: "written";
      requiredSeq: number;
      targetSeq: number;
      writtenSeq: number;
      v2Committed: true;
      v1Committed: true;
    }
  | {
      kind: "alreadyWritten";
      requiredSeq: number;
      writtenSeq: number;
    }
  | {
      kind: "failed";
      requiredSeq: number;
      targetSeq: number | null;
      failedSeq: number | null;
      stage: StandbyPersistenceWriteFailureStage;
      pendingRetained: true;
      partialCommit: "none" | "v2Only" | "unknown";
      cause: unknown;
    };

type StandbyPersistenceSaveResult =
  | {
      kind: "written";
      requestedSeq: number;
      writtenSeq: number;
      v2Committed: true;
      v1Committed: true;
    }
  | {
      kind: "failed";
      requestedSeq: number | null;
      failedSeq: number | null;
      stage: StandbyPersistenceWriteFailureStage;
      pendingRetained: true;
      partialCommit: "none" | "v2Only" | "unknown";
      cause: unknown;
    };
```

- `schedule(state)` は v2 / v1 全 validation 後にだけ seq と pending を更新し、
  receiptを返す。
- validation failure は既存 pending、seq、timerを変更しない。
- `flushThrough(requiredSeq)` は current newest pending seqをtargetとして固定し、
  target exact writeを行う。
- `save(state)` は必ず typed resultを返す。
- salvage backup失敗では canonical writeへ進まない。
- mkdir、temp write、各renameを別stageにする。
- v2 rename後のv1 rename失敗は `partialCommit: "v2Only"`。
- failure stateはpendingへ戻す。よりnewer pendingがあればnewerを保持する。
- sync failure後はtimerを自動rearmしない。
- tmp cleanup failureで主failureを上書きしない。
- committed / renamed seqはv2 / v1双方のrename成功後だけ進める。
- async debounce failureもpendingとtyped lastFailureを保持し、monitorをunhealthyにする。
- no pending、seq behind、partial write、backup blockedを成功にしない。
- unexpected throwもcompletion / shutdown adapterがfailureとして捕捉する。

## 9. retention、restore、runtime、shutdown

### 9.1 retention

```ts
export const TYPHOON_PROBABILITY_RETENTION_MS =
  7 * 24 * 60 * 60_000;
```

startup、60 秒 runtime sweep、各 valid-EventID VPTA admission 直前に
`expireRevisionFamily("typhoonProbability", "VPTA50", nowMs, retention)`
を実行する。

- `nowMs - acceptedAtMs <= 7日` は保持。
- acceptedAt + 7日は保持。
- acceptedAt + 7日 + 1msで失効。
- active watermarkとcancelled tombstoneを同じ境界にする。
- gate expiry後にprojectionが残れば同じmaintenanceで削除する。
- forecast expiryだけならgate watermarkはretention内で維持する。

### 9.2 startup

`startupNowMs` を一度だけ取得し、load、migration、gate expiry、restore、
store sweepへ渡す。

1. v2 / v1をload、sanitize、migrateする。
2. canonical v2とrollback mirrorsを比較し、repair requirementを集計する。
3. durable gate entriesをrestoreする。
4. VPTAを含むfoundation familyをstartupNowMsでexpireする。
5. expiry後gateとcoupleしたstandby stateをrestoreする。
6. `standbyStore.sweep(startupNowMs)` を一回行う。
7. restore rewrite、salvage、mirror repair、foundation mutation、store mutationをORする。
8. final canonical stateを必要時だけ一回 `schedule()` する。
9. その後にruntime durable listenerを有効化する。

startup restoreはdurable callbackを直接発火しない。view notificationは許可する。
期限切れprojection、malformed VPTA、rollback mismatch、他domain expiryが同時でもscheduleは
一回。変更なしならゼロ回。repair後のreloadで同じrepairを再要求しない。

### 9.3 runtime sweep

60秒 sweepはstore expiry、VPTA gate expiry、projection coupling cleanupを一つの
mutation accumulatorへ合流する。

- persistence durable listenerを一時抑止するかsilent APIを使う。
- view notificationは維持する。
- durable changeが一件以上なら一回だけscheduleする。
- notification holder sweepはdurable changeへ含めない。

### 9.4 shutdown result

`StandbyPersistence.save()` の結果を全終了経路で検査する。

```ts
type ShutdownResult =
  | { kind: "completed"; exitCode: 0 }
  | {
      kind: "failed";
      exitCode: 1;
      failures: readonly (
        | {
            operation: "standbyPersistence";
            stage:
              | StandbyPersistenceWriteFailureStage
              | "exportActiveState";
          }
        | { operation: "shutdown"; stage: "unexpected" }
      )[];
    };
```

- monitorのstop callbackはsweepを停止し、timerを止め、現在の
  `exportActiveState()` をtyped `save()` へ渡して結果を返す。
- save failureのpendingを破棄しない。
- `createShutdownHandler()` は同じ `Promise<ShutdownResult>` を
  二重呼出しへ返し、cleanupを一回だけ行う。
- handler内部で `process.exit(0)` を呼ばない。
- standby saveが失敗してもsocket、manager、REPL、display、logger、他cacheのbest-effort
  cleanupを最後まで行う。
- export、validation、backup、write、rename failureはexitCode 1。

signalとREPLが同じ result-consumption adapterを使用する。

```ts
async function runShutdownAndRecordExitCode(): Promise<ShutdownResult> {
  let result: ShutdownResult;
  try {
    result = await shutdown();
  } catch {
    result = {
      kind: "failed",
      exitCode: 1,
      failures: [{ operation: "shutdown", stage: "unexpected" }],
    };
  }
  process.exitCode = result.exitCode;
  return result;
}
```

- `registerShutdownSignals()` はこのadapterのresultをawaitし、resultの
  `exitCode` で `process.exit()` を一回呼ぶ。
- REPL `quit` と readline `close` に渡す `onQuit` も
  このadapterとする。結果をvoid化しても `process.exitCode` は設定済みである。
- REPL command handlerはadapter rejectionをcatchし、`process.exitCode = 1` とする。
- shutdown本体のunexpected throwも各wrapperがexit code 1にする。
- signalだけをexit ownerにしてREPL resultを捨てる構成を禁止する。

## 10. 実装対象

書換え対象の実装単位を責務別に示す。実装時はこの表の外へ機能を拡張しない。

### 10.1 parser、projection、gate

| file | change |
|---|---|
| `src/dmdata/typhoon-probability-parser.ts` | 40 / 60 / 61 step、duplicate diagnostics、既存DTO維持 |
| `src/types.ts` | parser DTO既存契約、`series40`非固定長確認 |
| `src/engine/display/project-typhoon-probability.ts` | new pure projector、absolute slots、strict zero、worst insertion |
| `src/engine/messages/revision-family-registry.ts` | EventID limit、durable、7日、canonical serial / single InfoType |
| `src/engine/messages/telegram-revision-gate.ts` | comparison override、shared capacity selector、single immutable commit record |
| `src/engine/presentation/processors/process-typhoon-probability.ts` | parse preparation / stateless baseline seam、single InfoType input |
| `src/engine/presentation/processors/process-standby-foundation.ts` | candidate、maintenance、gate commit orchestration |
| `src/engine/presentation/processors/process-message.ts` | parse-null / transient / started境界、public outcome + private internal result |

### 10.2 public main lane: router、store、monitor

| file | change |
|---|---|
| `src/engine/messages/message-router.ts` | global serializer、valid meta保持、outcomeTapPoison、error aggregation、VPTA call order |
| `src/engine/messages/typhoon-probability-state.ts` | process-local zero history、TTL / LRU |
| `src/engine/display/standby-state-store.ts` | separate probability map、atomic command reducer、reconcile、snapshot union |
| `src/engine/display/types.ts` | internal ingest command / mutation evidence。public eventへclassificationを追加しない |
| `src/engine/monitor/display-sink.ts` | public eventとprivate VPTA commandの分離、standby evidence先取り |
| `src/engine/display/standby-persistence.ts` | schema、migration、validator、typed writer、flushThrough |
| `src/engine/monitor/monitor.ts` | persistence owner、listener suppression、startup/runtime merge、shutdown adapter |
| `src/engine/monitor/shutdown.ts` | typed result、cleanup、signal wrapper |
| `src/ui/repl.ts` | typed onQuit adapterのawait / rejection処理 |
| `src/ui/repl-handlers/operation-handlers.ts` | quitが共通adapterを使用 |

### 10.3 protocol、frontend、docs

| file | change |
|---|---|
| `src/engine/display/protocol.ts` | optional compact probability slice |
| `display/frontend/src/lib/protocol.ts` | engine copyと同期 |
| `display/frontend/src/components/TyphoonCard.svelte` | combined / probability-only、full / compact |
| `display/frontend/src/lib/typhoon-header-tone.ts` | probability非参照の固定 |
| `display/frontend/src/components/StandbyScreen.svelte` | score、canonical measurement signature |
| `display/frontend/src/lib/standby-cards.ts` | existing fallback順の回帰確認 |
| `docs/specs/telegram-foundation.md` | VPTA durable 7日、single commit、completion ownership |
| `docs/specs/engine.md` | stateless processor、private sidecar、保存owner |

### 10.4 public main lane: tests / fixtures

少なくとも次を変更または追加する。

- `test/dmdata/typhoon-probability-parser.test.ts`
- `test/engine/presentation/process-typhoon-probability.test.ts`
- `test/engine/presentation/processors/process-message.test.ts`
- `test/engine/message-router.test.ts`
- `test/engine/messages/message-router-display.test.ts`
- `test/engine/messages/typhoon-probability-state*.test.ts`
- `test/engine/telegram-foundation/phase3a-revision-gate.test.ts`
- `test/engine/telegram-foundation/phase3b-standby-domains.test.ts`
- `test/engine/telegram-foundation/phase0-manifest.ts`
- `test/engine/telegram-foundation/phase0-contract.test.ts`
- `test/engine/display/standby-state-store.test.ts`
- `test/engine/display/standby-persistence.test.ts`
- `test/engine/display/standby-wiring.test.ts`
- `test/engine/display/protocol-sync.test.ts`
- `test/engine/monitor/display-sink.test.ts`
- `test/engine/monitor/shutdown.test.ts`
- `display/frontend/src/components/__tests__/typhoon-card.test.ts`
- `display/frontend/src/lib/legacy-standby/solver.test.ts`
- `test/fixtures/typhoon-probability-card/expectations.json`
- `test/fixtures/typhoon-probability-card/synthetic_VPTA50_duplicate_area.xml`
- `test/fixtures/synthetic_VPTW60_TC2606.xml`
- `test/fixtures/standby-persistence/operational-v1.json`
- `test/fixtures/standby-persistence/operational-v2.json`
- `test/fixtures/standby-persistence/operational-expectations.json`

既存 CLI formatter、ticker formatter、notifier は削除・置換しない。

### 10.5 personal branch overlay: 必須追従

この表は personal branch overlay をcheckoutしているレーンだけで実施する。public main へ
同名fileを追加しない。

| overlay file | required follow-up |
|---|---|
| `src/engine/events/event-file-writer.ts` | public outcomeだけを受ける型境界、version 1、body / raw / exploration hints互換を維持。internal sidecar APIを追加しない |
| `test/engine/event-file-writer.test.ts` | includeRaw true / false、actual-field sentinel再帰非流出、existing serialized shape回帰 |

overlay 側でこの二項を未反映のままVPTA統合を取り込むことは禁止する。一方、これらのpathが
存在しないことをpublic main laneのfailureにしない。

## 11. 必須テスト

### 11.1 parser と projector

実 VPTA fixtures と静的 expectations で次を確認する。

- 40 TimeDefine / seriesを保持し、各PT3H slotとforecast endが一致する。
- 60 stepを他fallback条件なしでnormal保持する。
- 61 / 62 stepを切らずcompactOnly保持し、standbyはnonProjectable。
- 40 / 60 stepでも地域超過やduplicate等の他fallbackをnoneへしない。
- region順を変えてもprojectionが同じ。
- active count、max、top、worst、peakが静的literalと一致する。
- browser / persistenceに全region / slotがない。
- CLI / ticker detailが維持される。
- `processTyphoonProbability()` の直接呼出しではholderが変化せず、通常発表の
  baseline `suppressNotify` は false のままである。
- accepted sidecarをcompletion経路へ通した場合だけholder結果がnotificationへ反映される。

invalid grid table:

| input | expected |
|---|---|
| timezoneなし / invalid time | nonProjectable |
| duplicate / gap timeId | nonProjectable |
| zero / negative / fractional / calendar duration | nonProjectable |
| slot gap / overlap / reverse | nonProjectable |
| span 120h超 | nonProjectable |
| series length mismatch | nonProjectable |
| daily null / NaN / 101 | nonProjectable |
| parser duplicate diagnostic | nonProjectable |
| raw regions duplicate | nonProjectable |
| same prefCode different prefName | nonProjectable |

worst insertionは同率最大6府県を作り、通常6番目にseries peak最大を置く。
topが通常上位4件 + worst prefecture、通常5番目除外、再sort済みとなることを、
入力順の複数順列とpersistence round-tripで確認する。

duplicate XMLはparserのMap統合後にもduplicateCodesが残り、projectorがactive / zeroを
生成しないことを確認する。

### 11.2 transition と snapshot

同一 EventIDで VPTA→VPTW と VPTW→VPTA を実行し、normalized snapshotを完全一致させる。
`analysis × probability × VPTA kind` と
`analysis × probability × VPTW active/end` は §6 の全行をparameterized testにする。

各行で:

- slice数、card数、authoritative fields
- sourceEventIds、updatedAt、expiresAt、restored
- analysis / probability の相互非mutation
- gate-only / tombstoneの非表示
- forecast expiry / gate expiryの独立性
- startup、runtime、admission前maintenanceの同値性

を確認する。

### 11.3 gate、clock、capacity

- classification clockを一回だけ読み、gate前後でwall clockがforecast endを跨いでも
  classificationを変えない。
- candidateを一回だけ作り、rejectedではfinalizerを呼ばない。
- single commit recordの構成不能でgateが変わらない。
- commit recordがdeep-frozenで、mapのcanonical entryと同一意味。
- raw `"01"`、`"1"`、missing、invalid serial matrix。
- canonical / noncanonical InfoType matrix。
- envelope / decoded XML の `発表↔取消`、`訂正↔取消`、canonical↔noncanonical の
  全不一致でcandidate、capacity plan、gate commitがゼロ。
- canonical InfoTypeを両入力で一致させ、processor、projector、capacity、comparison、commitが
  同一値を受け取る。
- active / expired / nonProjectable ↔ `cancelled: false`、cancel / all-zero ↔
  `cancelled: true` の対応をassertし、故意の不一致は `gateCommitInvariant` へ閉じる。
- 7日 / +1ms retention boundary。
- provider invalid matrixとmaintenance preservation。
- 255 protected + 1 GA + incoming各class。
- 256 protected + 257th protected rejection。
- incoming GAがvictimになる場合に既存を変えない。
- same acceptedAtのEventID tie-breakがinput / restore順非依存。
- existing subject newer updateが256件で受理される。
- live selectorとreader selectorのretained / discarded集合が一致。

### 11.4 internal sidecar のレーン別検証

#### 11.4.1 public main lane

- public ProcessOutcome / PresentationEventにfinalized classification、commit record、
  comparison、semanticKeys、persistence receiptがない。
- private sidecarだけがdisplay sink第二引数へ届く。
- reducerがsidecarの同じfinalized objectを使い、再projectしない。
- stale / duplicate / invalid / capacity rejectionでsidecarを作らない。
- actual internal fieldごとの一意な sentinel valueを private sidecarへ入れ、outcome tapで
  captureしたpublic outcomeと、そのoutcomeから生成したPresentationEventのobject / arrayを
  再帰検査する。sentinel到達はゼロである。
- public mainに `EventFileWriter` の実装、import、option、fixture、testを追加しない。

#### 11.4.2 personal branch overlay lane

- EventFileWriterはpublic outcomeだけを受け、private sidecarを受けるAPIを持たない。
- main laneと同じactual-field sentinel fixtureを使用する。
- includeRaw true / falseのserialized JSONをvalue単位で再帰検査し、sentinel到達をゼロにする。
- event-file version 1、existing body、raw、exploration hintsを回帰確認する。
- overlay test不在時にmain testへskip / conditional branchを追加しない。

### 11.5 notification holder

- zero→zero suppress。
- zero→nonProjectable→zero suppress。
- zero→expired→zero suppress。
- nonzero→nonProjectable / expired→zero notify。
- zero→cancel→zero notify。
- TTL boundary、LRU 256 / 257。
- stale / duplicate / invalid / capacity rejection / transientでnonmutation。
- restart exact replay rejectionとgenuinely newer zero一回通知。

### 11.6 frontend

- analysis-only、probability-only、combined。
- full max5、compact max3、omitted label。
- worst / null peak、JST format。
- probability-only muted、combined VPTW toneのみ。
- probability 1 / 50 / 100でtone不変。
- RestoredChip / UpdatedStamp / ARIA。
- multiple typhoons、stable ordering、score。
- FHD、720p、narrowでoverlapなし。
- full不収容→compact、compact不収容→rotation / overflow、clipなし。
- measurement tupleの各field変更でremeasure、identityだけ変更でreuse。

### 11.7 router serializer と第12巡 regression

single-stage envelopeについて次を試験する。

1. route tap内で同一messageId・異内容のCを同期投入する。Aのdedupが先、Cがduplicateとなり、
   gate / projectionはAの内容だけになる。
2. tapがclassification、head、meta、xmlReport、bodyのmutationを試みる。frozen snapshotは
   変化せず、dedup、日時診断、parser、gateが同じgraphを読む。
3. outer Aがtransport duplicate / date rejectionでも、後着normal Cを処理する。
4. nested Cがduplicate / date rejectionならpayloadを即解放し、discard markerを残さない。
5. repeated duplicate / rejected nested inputsでpending count / byteが増え続けない。
6. current ownerがserialized 2 MiB + 1 byte、かつparser有効範囲のVPTAでも処理される。
7. decoded XML 5 MiB境界のvalid current inputがserializer byte limitでpoisonしない。
8. pending 256 / 257、64 MiB / +1 byte、drain 512 / 513境界。
9. completion後presentationからoverflowを発生させ、二回目completionなし、
   latest required receipt以上のexact targetをdual-write flushしてからthrowする。
10. B / Cのpre/post-gate recoverable failureを複数発生させ、queueを最後までdrainし、
    causeを発生順AggregateErrorにする。
11. B recoverable failureのflush後にCを処理し、B reconcileがprojection Cを触らない。
12. persistence failureをCで発生させ、Bまでのrecoverable causes、C cause、persistence
    causeの順でaggregateし、Dを開始しない。
13. non-VPTA outer route tapからnested VPTA overflowを発生させる。tap catch後もglobal
    poisonが残り、outermost turnがfail-loud、以後全routeを拒否する。
14. metaなしraw messageを時刻T1で投入するとT1が生成される。valid meta付きの同じ
    pre-normalized messageをT2で再投入してもmeta objectの意味とclassification clockはT1の
    ままにし、欠落 / invalid metaだけをT2から完全再生成する。

各 transport invocation の normalize、classify、route tap、received stats、dedup、date
diagnosticは一回。queued envelopeをpublic handlerへ戻さない。未開始破棄にcompletionや
side effectを作らない。

### 11.8 failure、completion、persistence

pre-gate stages:

`classificationClock`、`infoTypeCanonicalization`、`processorBaseline`、`projector`、
`admissionGateExpiry`、`activeSubjectSnapshot`、
`projectionCleanup`、`protectionSnapshot`、
`serialCanonicalization`、`capacityPlan`、`gateEvaluate`。

post-gate stagesは§5.9の全stage。

各stageで:

- completionが一回だけ。
- pre-commit incoming gate非mutation。
- post-commit gate nonrollback。
- reconcile後のP+G / GA / GT。
- observer exceptionの隔離。
- completed stats / notifier / store / hubのnon-replay。
- completion unionは `accepted + none`、`suppressed(false) + deferred`、
  `suppressed(true) + none`、`failed(false) + immediate`、
  `failed(true) + deferred` の各不正組合せがtypecheckで失敗する。
- no durable changeはschedule 0。
- durable normalはschedule 1。
- durable failureはschedule + flushThrough各1。
- flush成功前にerrorを再送出しない。
- persistence failureはpoison、pending保持、queue破棄。

開始境界は別途、parse-nullがraw fallbackかつcompletion 0、invalid / 過長 EventIDがtransient
かつcompletion 0、valid EventID後のlevel helper throwが `processorBaseline` failed completion 1
となることを試験する。

`outcomeTapPoison` は、accepted VPTA の outcome tap が同期再入でqueue overflowを起こすfixtureを
使う。通常tap throw / async rejectionは隔離されaccepted completionを維持する一方、sticky
poisonではfailed completionが一回、gate nonrollback、projection reconcile、schedule +
flushThrough各一回、event conversion / displayゼロ、outermost throw、後続全route拒否を確認する。

post-completion presentationは§5.10のoperation matrixを個別注入し、skip、fallback、retry回数、
presented statsを検証する。

### 11.9 persistence、migration、mirror

round-trip:

- VPTW-onlyはtyphoonsだけ。
- probability-onlyはtyphoonProbabilitiesだけ。
- combinedは二つの独立projectionから一cardへ戻る。
- P+Gだけがrestored cardを生成。
- GA / GT / projection-onlyは生成しない。
- live updateはprobability restoredだけfalse。

boundary matrixは EventID 128/129、source 256/257、code 32/33、name 128/129、
remark 256/257、semantic key 1024/1025、regions 600/601、top 5/6、keys 32/33、
probability 0/1/100/101/NaN/Infinity/fraction/unsafe を live、reducer、writer、readerで
共通実行する。

reader / writer:

- duplicate input順非依存。
- 256 / 257 canonical bundles。
- raw 1024 / 1025 items / bundles。
- protected 256 / 257。
- malformed VPTA + valid VPTA + same EventID VPTW + other domainのdomain-local salvage。
- write validation failure前後でexisting v2 / v1 bytes不変。
- tmp write、v2/v1 rename、backup、pending unavailable、pending behind required seq。
- v1 rename failureはv2Only、pending retained、committed seq非前進。

v1:

- absent / [] / valid array / null / object / scalar modes。
- metadata active P+G、active GA、cancelled GT、old-key projection→GA。
- malformed / missing metadataはfallbackなし。
- absent legacy active、seen-only empty-key GT、missing-key empty-key GT。
- static strict comparison fixture、future skew inclusive boundary。
- empty-key GT canonical rewrite / reload、cancelled false + [] rejection。
- same-revision A→B→C semantic key orderとv1/v2 decision一致。

mirror:

- source v2 root / standalone v1 × component projection / seen / metadata。
- missing、malformed、duplicate、extra、semantic mismatch。
- v2 canonical nonreplacement、one startup schedule、both mirrors repair、second reload clean。

実運用匿名化v1/v2 fixtureはload前にfake clockを固定する。retained pointerに少なくとも一件の
non-default domain leafを要求し、expired pointerをmemory / v2 / v1から除く。explicit
value replacementはstatic allowlistと完全一致させる。

### 11.10 startup と shutdown

startupはVPTA expiry、gate expiry、salvage、raw hard-limit rejection、mirror repair、
other-domain expiryの単独 / 全組合せでschedule 0 / 1を確認する。runtime sweepも複数mutationを
一回へ合流する。

shutdown:

- typed save success / validation / backup / write / each rename failure。
- stop callbackがsave resultを返す。
- completed exitCode 0、failed exitCode 1。
- failure後も全cleanup継続。
- duplicate callがsame promise、save / cleanup一回。
- signal success exit 0、failure exit 1。
- REPL quit failureでprocess.exitCode 1。
- readline close failureでもprocess.exitCode 1。
- unexpected throwも全三経路で1。
- failed pendingを破棄しない。

## 12. 受入条件

### 12.1 scope / projection

- [ ] merge keyはtrim後nonblank、128文字以下の共通EventIDだけ。
- [ ] VPTW / VPTA revision familyは分離。
- [ ] 128文字はdurable、129文字はtransientでCLI / ticker / notifierのみ。
- [ ] 40 / 60 / 61 stepと既存detail契約を維持。
- [ ] slot、region、duplicate、strict zero validationを実装。
- [ ] max、top、worst、peakを決定的に導出。
- [ ] 同率6府県で通常上位4件 + worst府県。
- [ ] nonProjectable / expiredは旧projectionを削除しGAを残す。

### 12.2 state / display

- [ ] analysis / probability mapを分離しsnapshot時だけunion。
- [ ] 両到着順の最終snapshotが一致。
- [ ] VPTA zero / cancelはprobabilityだけ、VPTW endはanalysisだけを削除。
- [ ] probability-only / analysis-only / combinedを表示。
- [ ] public main laneでprotocol v1、schema v2を維持。
- [ ] probability値からseverity /警報色を作らない。
- [ ] existing header、RestoredChip、UpdatedStamp、full / compact / overflowを維持。
- [ ] measurement signatureが全表示値を含む。

### 12.3 gate / retention / holder

- [ ] VPTA gateがdurable、max256、retention7日。
- [ ] classification clockをreceivedAtMsから一回だけ確定。
- [ ] envelope / decoded XML のInfoTypeを完全一致後に一値化し全段で共有。
- [ ] candidate kindとcommit.cancelledの対応をaccepted直後にassert。
- [ ] protection snapshotをgate前にvalidateしinvalidはfail-closed。
- [ ] P+G / GTをprotected、GAだけをdeterministic victimにする。
- [ ] 256 protected + 257thを既存evictionなしで拒否。
- [ ] gate / projection couplingがlatest semantic keyを要求。
- [ ] zero holderはprocess-local、TTL / LRU 256、active subject pruningなし。

### 12.4 orchestration / reentrancy

- [ ] 全routeをsingle-stage run-to-completion serializerへ通す。
- [ ] same immutable snapshotをtap、dedup、date、parser、gateが読む。
- [ ] valid pre-normalized metaは再投入時も保持し、欠落 / invalid時だけ入口時刻で再生成。
- [ ] outerがnestedより先にdedupを実行。
- [ ] discarded markerを保持しない。
- [ ] current ownerをpending count / byteへ含めない。
- [ ] valid 5MiB parser inputを旧2MiB limitで拒否しない。
- [ ] count / byte / drain limitとsticky global poisonを実装。
- [ ] recoverable failuresをdrain後に発生順aggregate。
- [ ] non-VPTA outerからのnested poisonもoutermostでfail-loud。
- [ ] outcome tap由来sticky poisonを `outcomeTapPoison` completion + flush後にfail-loud。

### 12.5 atomicity / persistence

- [ ] gateが一つのimmutable authoritative commit recordをatomic生成。
- [ ] accepted recordをcommit後map再検索または別receiptから再構成しない。
- [ ] candidateはaccepted後だけ一回finalize。
- [ ] public main laneでinternal sidecarをoutcome tap payload / PresentationEventへ載せない。
- [ ] actual internal fieldごとの一意なsentinelを両public payloadで再帰検査する。
- [ ] reducer / retentionをatomicにし、post-sink failureでもevidenceを保持。
- [ ] started admissionのaccepted / suppressed / failed completionは一回だけ。
- [ ] parse-null / transientは未開始、valid EventID後のbaseline failureはstarted failed。
- [ ] VPTA保存ownerはcompletion adapter一箇所。
- [ ] normal durableはschedule一回、failure durableはschedule + flushThrough一回。
- [ ] completion後infrastructure failureが最新required receiptをflushしてからthrow。
- [ ] writerがvalidation / backup / write / rename failureをtyped failureにする。
- [ ] v2 / v1双方のrename成功だけをwrittenとする。
- [ ] failure時pendingを保持しautomatic retryしない。

### 12.6 migration / shutdown

- [ ] domain-local salvage、raw1024、canonical256を分離。
- [ ] v2 canonicalをrollback mirrorで置換しない。
- [ ] v1 metadata own-property three-stateを実装。
- [ ] reserved legacy empty-key tombstoneだけを許可。
- [ ] v2 / v1へcomparison、ordered keys、cancelled、retentionをdual-write。
- [ ] startup / runtimeの複数mutationを一回のscheduleへ合流。
- [ ] shutdown typed resultをsignal、REPL quit、readline closeで共通消費。
- [ ] save失敗でexit 0にならず、残りcleanupを完了。

### 12.7 personal branch overlay: event-file 必須追従

- [ ] `EventFileWriter` はpublic outcomeだけを受け、internal sidecar APIを持たない。
- [ ] includeRaw true / falseの双方でactual-field sentinelがserialized subtreeへ流出しない。
- [ ] event-file `version: 1`を維持。
- [ ] existing body、raw、exploration hintsのserialized shapeを回帰確認する。
- [ ] overlay不在のpublic mainへwriter file、stub、conditional import、skip testを追加しない。

この小節はpersonal branch overlayを取り込む際の必須受入条件である。overlay pathが存在しない
public main laneではN/Aとし、§12.1〜§12.6および§12.8の合否を妨げない。

### 12.8 public main lane: verification

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run display:build`
- [ ] `npm run display:test`
- [ ] `npm run typecheck:test`
- [ ] `npm run test:shuffle`
