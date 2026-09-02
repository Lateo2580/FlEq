# VFVO54/55 VolcanoCard 降灰 slice 統合仕様

- 日付: 2026-08-31
- 再起草: 2026-09-01
- 状態: ご主人裁定済み、実装待ち
- 作業基準として提示された HEAD: `a63327e`
- 採用案: VFVO54/55 を既存 `VolcanoCard` へ統合する
- 対象電文: VFVO54、VFVO55
- 非対象電文: VFVO53 は既存の定時・transient 表示を維持する
- display protocol kind: 既存 `volcano` を維持する
- persistence schema version: v2 を維持する
- volcano canonical generation: 1
- 裁定待ち: なし

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。

## 1. 目的と完成像

VFVO54「降灰予報（速報）」と VFVO55「降灰予報（詳細）」を、火山コード単位の継続状態として既存 `VolcanoCard` に統合する。

完成後は次を満たす。

- VFVO53 は従来どおり `VolcanoVfvo53Aggregator` で batch 表示・通知し、永続 state や `VolcanoCard` に入れない。
- VFVO54/55 は共通 subject `volcano:ashfall:<volcanoCode>` を使う。
- VFVO54 は速報 state、VFVO55 は詳細 state を形成する。
- 同一火山・同一 EventID lifecycle の後着 VFVO55 は VFVO54 を置換する。
- strictly newer な VFVO54 は、古い VFVO55 を新しい速報 lifecycle へ置換できる。
- 実 fixture `66_01_02_210514_VFVO54.xml` と `66_01_03_210514_VFVO55.xml` の共通 EventID `506` を lifecycle の固定例とする。
- 降灰 slice は全 `AshForecastPeriod.endTime` の最大値で一括失効する。
- 取消、自然失効、破損時 salvage は降灰 slice だけを削除し、同じ火山の警報・噴火 slice を維持する。
- alert、eruption、ashfall は独立した三 slice とする。
- `VolcanoCard` には速報／詳細、予報終了時刻、降灰量または小さな噴石、上位地域、省略件数を表示する。
- VFVO54/55 の CLI、ticker、notification、詳細 formatter は維持する。
- VFVO53 の batch、VFVO54/55 到着による即時割り込み、通知抑制を維持する。
- header tone は三 slice の最大 tone とする。
- VFVO54 単独は既存 weather-warning header、VFVO55 単独は muted header とする。
- 新しい色、header band、severity token、card kind を追加しない。
- revision gate を durable 化し、旧報、重複報、取消前報の復活を再起動後も抑止する。
- local ashfall state を安全に復元できない場合は VFVO54/55 REST replay で修復する。
- count 上限と UTF-8 byte 上限は persistence、wire とも AND 条件で適用する。
- v2 canonical と standalone v1 rollback は、正常な new writer 保存では意味一致する。
- v2／v1 rootは同じwall-clock非依存logical generationを持ち、部分commitでも新しい単独snapshotを選べる。
- 旧 v1/v2 実運用 JSON の load、migration、restore、sweep、再保存、再 reload を通す。
- 復元した active slice は runtime で `restored: true` とし、既存 `RestoredChip` を表示する。
- reader は new writer が生成できる全ての正常 runtime state を再読込できる。
- admission、restore、replay、writer は fail-closed とし、上限超過や coupling 不成立を truncate、後勝ち、暗黙補完で救済しない。

raw XML、polygon、全 period の全地域、plume direction、distance、thickness、本文は browser protocol と永続 state に複製しない。parser DTO と CLI 用詳細データは従来どおり維持する。

## 2. 非目標

- VFVO53 の表示内容、batch 単位、通知ポリシーを変更しない。
- parser DTO を standby 専用 DTO へ置換しない。
- `kind: "volcano"` を分割しない。
- alert／eruption の既存 revision ordering、通知 severity、CLI 表示を変更しない。
- REST item ID から未観測の受信順を合成しない。
- ash code、地域数、厚さから新しい header severity を推測しない。
- v2 と standalone v1 を一つの原子的pairとして読まず、fieldを相互mergeしない。各fileは単独で完全なsnapshotとし、logical generationはsource選択だけに使う。
- REST で過去 eruption の完全性を証明したと主張しない。利用可能な修復源は VFVO50 と VFVO54/55 である。

## 3. 現行実装との接続点

実装は現行の次の責務を拡張する。

| 現行責務 | 主な実ファイル | 本仕様での変更 |
|---|---|---|
| volcano parser | `src/dmdata/volcano-parser.ts` | DTO は維持し、compact projector へ入力する |
| family / revision | `src/engine/messages/revision-family-registry.ts`、`telegram-revision-gate.ts` | VFVO53 分離、VFVO54/55 durable gate |
| stateful route | `src/engine/messages/volcano-route-handler.ts` | 三 slice 共通 transaction coordinator |
| runtime owner | `src/engine/messages/volcano-state.ts` | composite と完全な三 slice を所有 |
| standby projection | `src/engine/display/project-standby.ts`、`standby-state-store.ts` | ashfall update、derived mirror、sweep |
| persistence | `src/engine/display/standby-persistence.ts` | generation 1 canonical、logical generation、v1 rollback、bounded reader／writer |
| startup / REST | `src/engine/startup/volcano-initializer.ts` | normal WS ingress と slice-local replay の合流 |
| composition root | `src/engine/monitor/monitor.ts` | restore、repair、保存予約の集約 |
| protocol / UI | `src/engine/display/protocol.ts`、`display/frontend/src/components/VolcanoCard.svelte` | ashfall DTO、tone、pager |

現行 `VolcanoStateHolder` は alert と eruption identity、`StandbyStateStore` は完全な eruption 表示を別々に持つ。本仕様では runtime の完全な三 slice を holder に集約し、standby を derived projection にする。ただし revision gate は引き続き `TelegramRevisionGate` が所有する。

## 4. 全体構造

### 4.1 runtime snapshot と ownership

domain content の正本は次の二つである。

1. `VolcanoStateHolder`
   - 火山コードごとの alert、eruption、ashfall slice
   - composite が生存している間の累積 `sourceEventIds`
2. `TelegramRevisionGate`
   - `volcanoAlert`、`volcanoEruption`、`volcanoAshfall` の active watermark／tombstone

これとは別に、復元可能性と永続 degraded 状態を表す control-plane 正本 `VolcanoRepairStateV1` を置く。holder／gateから空状態だけを見てrepair要否を推測してはならない。`VolcanoTransactionCoordinator` は三者を一つのversioned snapshotとして所有し、全mutationをこの単位でcommitする。

```ts
interface VolcanoRuntimeSnapshot {
  schemaGeneration: 1;
  runtimeVersion: number;
  holder: VolcanoHolderSnapshot;
  gates: TelegramRevisionGateSnapshot;
  repair: VolcanoRepairStateV1;
}
```

`runtimeVersion` はfinite safe integerであり、holder、gate、repairのいずれかが変わるcommitごとに一回だけ増える。各ownerを別時点でexportした値を寄せ集めて`VolcanoRuntimeSnapshot`を作ってはならない。

`StandbyStateStore`、browser DTO、v2 rollback array、standalone v1 は全てderived projectionであり、runtime snapshotへ逆流させない。ここでいう「二つの正本」はdomain content ownerの数であり、repair stateを暗黙の第三content ownerとして扱う意味ではない。

domain別lineage map、authorityの四直積、全stateful handoff buffer、commit manifestは設けない。

### 4.2 composite

holder は normalized volcano code を key に一つの composite を持つ。

```ts
interface VolcanoCompositeV2 {
  volcanoCode: string;
  volcanoName: string;
  sourceEventIds: string[];
  alert: PersistedVolcanoAlertSliceV2 | null;
  eruption: PersistedVolcanoEruptionSliceV2 | null;
  ashfall: VolcanoAshfallProjectionV1 | null;
}
```

- 三 slice のいずれかが active の場合だけ composite を保持する。
- 三 slice が全て null になった時点で composite と累積 `sourceEventIds` を一体で削除する。
- gate-only watermark／tombstone は composite を生成しない。
- slice mutation は対象 slice と composite 共通 metadata だけを変更する。他二 slice の値、revision、restored flag を変更しない。
- `sourceEventIds` は accepted になった alert／eruption／ashfall transport ID の flat cumulative unique set である。
- `sourceEventIds` は JavaScript code-unit辞書順のcanonical arrayとして保持する。
- `sourceEventIds`ごとのdomain provenanceは保存しない。表示、rollback、重複追跡に必要なのはaccepted transport IDの和集合だけである。alert slice／gateの`sourceFamily`は欠損判定に必要な別fieldであり、このflat setの分類には使わない。
- active replacement、取消、自然失効、wire omissionだけを理由に、composite 存続中の過去 ID を削除しない。
- stale、duplicate、invalid、transient、preflight rejection の ID は追加しない。
- current sourceを明示するslice（本仕様ではashfall）の `sourceEventId` は `sourceEventIds` に含まれなければならない。
- H0 から gate-only GA／GT を作るだけなら composite と `sourceEventIds` を作らない。
- alert または eruption が残る火山で ashfall cancellation を受理した場合、cancellation transport ID は既存 composite の `sourceEventIds` へ追加する。

### 4.3 完全な slice

alert slice は現行 `VolcanoAlertEntry` の `lastInfo` を除いた全fieldに、`StandbyRevision`、`appliedSemanticKey`、受理元の`sourceFamily`を加える。legacy migrationで一意に復元できないcurrent transport IDを必須fieldにしない。

```ts
type VolcanoAlertSourceFamily = "VFVO50" | "VFVO51" | "VFSVii";
type PersistedVolcanoAlertSourceFamily =
  | VolcanoAlertSourceFamily
  | "operationalV2Unknown";

interface PersistedVolcanoAlertSliceV2
  extends Omit<VolcanoAlertEntry, "lastInfo"> {
  sourceFamily: PersistedVolcanoAlertSourceFamily;
  operationalV2ResolutionId?: string;
  revision: StandbyRevision;
  appliedSemanticKey: string;
}
```

live inputの`sourceFamily`は実際に当該sliceを最後にmutationしたhead typeから設定する。VFVO51の一電文をsubject別に展開しても全entryは`"VFVO51"`である。別familyへ推測変換しない。

`"operationalV2Unknown"`は§15.5の現行operational-v2 migrationだけが作れる移行tagであり、実head typeを表す値ではない。active sliceを失わずに「VFVO50／VFVO51／VFSViiのどれかを決定できない」ことを保存する。未解決なら`operationalV2ResolutionId`を持たずmatching omissionを必須とし、operatorが§14.1.1のtransactionで受容またはclearした後だけmatching resolution IDを持つ。live／REST replay、一般salvageからこのtagを新規生成してはならない。known familyのsliceは`operationalV2ResolutionId`を持たない。

eruption slice は rollback 表示を holder だけから lossless に再生成できる形とする。

```ts
interface PersistedVolcanoEruptionSliceV2 {
  volcanoName: string;
  latestEvent: DisplayVolcanoEventV1;
  latestEventId: string | null;
  eventExpiresAtMs: number;
  revision: StandbyRevision;
  appliedSemanticKey: string;
  legacyV1Fallback?: boolean;
}
```

ashfall slice は §7 の compact projection とする。

`restored` は slice の runtime flag として holder／standby に付与できるが保存しない。

### 4.4 transaction coordinator

alert、eruption、ashfallのstateful inputは全て一つの`VolcanoTransactionCoordinator`を通す。現在のobjectを順に直接mutateしてはならない。

一 admission の手順は次である。

1. admission clocks を一度だけ確定する。
2. 対象 family の期限切れをglobal admission coordinator上の独立 transactionとしてsweepする。
3. coordinatorから`VolcanoRuntimeSnapshot`のversioned deep copyを一回で取得し、全domain persistence compositionのbase versionも固定する。
4. holderを変更する前のsnapshotだけを読み、subjectごとの`trackedBefore`、`isRenotification()`相当の`renotificationBefore`、presentation、base outcomeをimmutableな`VolcanoPresentationPlan`へprecomputeする。VFVO51は同一subjectの電文内最後のentryへ正規化してからplanを作る。
5. snapshotのscratch cloneに通常と同じgate decisionとslice reducerを適用する。
6. VFVO51の全subjectを同じscratchへ適用する。accepted subjects、correction、mutation kindなどgate decision由来のfieldだけをplanへ追記し、pre-mutation由来fieldを再計算しない。
7. scratchと同じbase versionの他domain snapshotからstandby projection、v2 canonical、v2 rollback、standalone v1、完成VolcanoCardを生成する。
8. schema、coupling、count、persistence byte、wire count／byte、global snapshot byteを全て検証する。
9. 一条件でも不成立ならscratchを捨てる。実gate、holder、repair、standby、generation、source IDs、callback、fileはcandidate由来では不変である。
10. preflight成功時、volcano runtime versionと全domain persistence composition versionが手順3と一致することを確認する。
11. await、clock取得、外部I/O、callbackを挟まず、global coordinatorの固定owner順`replacePrevalidated()`でholder、shared gate、repair、standbyを同期replaceし、各owner versionと全domain composition versionを一回増やす。
12. durable mutationなら、fallibleなnotification、CLI、ticker、displayより先にdurable callbackを一回呼ぶ。
13. 手順4のplanだけを使ってpresentation、notification、CLI、ticker、displayを発行する。commit後のholderを再読して`trackedBefore`やrenotificationを再評価しない。

手順2のexpiry transactionは自身のfull-file preflightとversion checkを通って先にcommitするため、後続input candidateが失敗しても維持し、保存要求を失わない。

durable callbackは保存予約を同期的にdirtyへ畳み込むnon-throwing APIとする。既存callbackを直ちにnon-throwing化できない場合はcommit直後の`try/finally`でdirty flag設定を保証してから例外を再送出する。後続のCLI／display／notifierの失敗によってdurable mutationの保存要求を失ってはならない。

commit関数はvalidation、capacity判定、serialization、generation加算、source ID追加、presentation評価を行わない。version mismatchはcommit関数へ入る前にstale candidateとしてretry／state-neutral rejectし、`replacePrevalidated()`中のunexpected throwだけをinvariant failureとしてfail-loudにする。

この clone-and-replace 方式により、real gate の `decide()` 前に個別 API を増やさず、現行 `TelegramRevisionGate` の規則を scratch 上で再利用できる。

## 5. revision family、identity、ordering

### 5.1 VFVO53

VFVO53 は専用 non-durable family へ分離する。

```ts
revisionFamily: "volcanoAshfallScheduled"
headTypes: ["VFVO53"]
subject: "volcano:ashfall-scheduled:<volcanoCode>"
cancellationPolicy: "markCancelled"
durable: false
retention: 36 hours
maxSubjects: 128
```

- gate 通過後だけ既存 aggregator へ入れる。
- CLI、ticker、notification、batch 表示を維持する。
- holder、standby、browser protocol、ashfall persistence へ入れない。
- VFVO54/55 の live 到着時は、durable admission の前に pending VFVO53 を `notify: false` で即時 flush する。
- REST historical replay は VFVO53 aggregator を interrupt しない。
- VFVO53 cancellation は VFVO54/55 state を変更しない。逆も同様である。

### 5.2 VFVO54/55

```ts
revisionFamily: "volcanoAshfall"
headTypes: ["VFVO54", "VFVO55"]
subject: "volcano:ashfall:<volcanoCode>"
cancellationPolicy: "clearCurrent"
durable: true
retention: 7 days
maxSubjects: 128
allowMissingSerial: true
comparator: "reportDateTimeThenSerialThenVariant"
```

subject helper は一箇所だけに置く。

```ts
function volcanoAshfallSubjectKey(
  volcanoCode: string,
): string | null;
```

volcano code は NFC、trim 後 nonblank、32 code units 以下、制御文字なしとする。leading zero と内部 whitespace を保持する。volcano name、EventID、head type、publishing office は subject に使わない。比較は case-sensitive とする。

### 5.3 EventID と source ID

active ashfall と通常 tombstone は actual EventID を必須とする。

```ts
VOLCANO_ASHFALL_MAX_EVENT_ID_LENGTH = 128
VOLCANO_MAX_SOURCE_ID_LENGTH = 256
```

- EventID は `info.meta.eventId.value` だけから取得する。
- EventID は trim 後 nonblank、128 code units 以下、制御文字なし、case-sensitiveとする。
- current source ID は transport message ID だけから取得し、trim 後 nonblank、256 code units 以下、case-sensitiveとする。
- EventID、source ID を code、report time、title から合成しない。
- invalid identity は state-neutral transient とする。gate、holder、standby、persistenceを変更せず、per-message CLI／ticker／notifierは既存transient policyを維持する。
- diagnostic へ長い ID 本文を出さず、type、code、長さ、reason だけを出す。

ashfallとalertに必要なprovenanceはgeneric gate entryのoptional discriminated fieldへ置く。comparisonのvariantはcomparison入力そのものへ置き、projectionの有無に依存させない。

```ts
interface TelegramRevisionComparisonInput {
  revision: TelegramRevision;
  stateSubjectKey: string | null;
  variantRank?: 0 | 1;
}

type PersistedVolcanoGateProvenanceV1 =
  | {
      kind: "alert";
      sourceFamily: PersistedVolcanoAlertSourceFamily | "unknown";
      operationalV2ResolutionId?: string;
    }
  | {
      kind: "ashfall";
      actualEventId: string | null;
      sourceType: "VFVO54" | "VFVO55" | null;
    };

interface PersistedTelegramRevisionGateEntryV2 {
  // existing fields
  comparison: TelegramRevisionComparisonInput;
  volcanoProvenance?: PersistedVolcanoGateProvenanceV1;
}
```

`TelegramRevisionGateInput`にも`variantRank?: 0 | 1`と`volcanoProvenance?`を追加する。gateはaccept時に`variantRank`をaccepted comparisonへcopyし、provenanceと一緒にclone／export／restoreする。canonical配置はactual EventIDとsource typeが`volcanoProvenance`、variant rankが`comparison.variantRank`だけであり、`legacyRevisionKey`やprojectionをcanonical代替にしない。

- `volcanoAlert`のlive gateは`kind:"alert"`と、`volcanoProvenance.sourceFamily`内の実head typeを必須とし、active sliceの`sourceFamily`と一致させる。generic `comparison.revision.type`は`"volcanoAlert"`のままである。live inputは`"operationalV2Unknown"`、`"unknown"`、resolution IDを設定しない。
- `"operationalV2Unknown"`は§15.5で一意に結合できた現行operational-v2 alert bundleだけに許可する。active sliceとgateは同じtagと同じoptional resolution IDを持つ。未解決なら同codeの`operationalV2ProvenanceLost` omission、解決済みなら同IDのaudit recordとcoupleする。
- `"unknown"`はactive sliceを持たないlegacy migration／salvageのgate-only watermark／tombstoneだけに許可し、同subjectまたはdomain-scopeのunrecoverable alert omissionを必須とする。
- `volcanoAshfall`のlive／new-writer gateは`kind:"ashfall"`を必須とする。P+G、GA、通常GTはactual EventID／source typeがnon-null、rankがsource typeと一致する。
- reserved legacy GTだけはactual EventID／source typeをともにnull、rankを1とする。mixed-nullは禁止する。
- 他familyは`volcanoProvenance`と`variantRank`を持たない。unknown fieldとして他familyのorderingへ混入させない。
- GA／GTのidentity、取消逆引き、v1 mirrorはgateに保存したcanonical fieldから生成する。projectionから回収しない。

### 5.4 serial normalization

live、REST、v1 migration、v2 restore は同じ関数を使用する。

```ts
type NormalizedVolcanoAshfallSerial =
  | { kind: "missing" }
  | { kind: "numeric"; numeric: number; canonicalRaw: string }
  | { kind: "invalid" };
```

- `null` と厳密な `""` だけを missing とする。
- `/^\d+$/` に一致し、finite safe integer へ変換できる値だけ numeric とする。
- `"01"` と `"1"` は numeric 1、canonical raw `"1"` とする。
- whitespace、符号、小数、指数、英字混在、unsafe integer は invalid とし、trim 救済しない。
- numeric と missing は unordered である。
- 両側 missing かつ同一 report time の場合だけ existing `allowMissingSerial` 規則で equal とする。

### 5.5 comparator と EventID preflight

比較順は次である。

1. strict report datetime
2. normalized serial
3. report time と serial が equal の場合だけ canonical `comparison.variantRank`

| type | variant rank |
|---|---:|
| VFVO54 | 0 |
| VFVO55 | 1 |

- report time または serial が異なる場合は variant rank を参照しない。
- persisted `comparison.variantRank` と `volcanoProvenance.sourceType` の不一致を拒否する。
- active live report の rank 欠落を推測しない。
- legacy reserved tombstone の rank 欠落だけは rank 1 へ一方向 migration できる。
- current actual EventID と incoming EventID が異なる場合、strictly newer revision だけが新 lifecycle を開始できる。
- different EventID の equal、older、unordered input を拒否する。

### 5.6 same-revision semantic history

ashfall gate は effective revision ごとに semantic key を oldest→newest で保持する。

```ts
VOLCANO_ASHFALL_MAX_SEMANTIC_KEYS = 32
```

- strictly newer revision では一件へ reset する。
- 既存 key の再送は exact duplicate とし、state、TTL、generation、source IDs、callback を変更しない。
- 同一revisionの未見keyは、semantic payloadが変わった`訂正`、またはmatching lifecycleをnon-cancelledからGTへ移す`取消`だけを受理する。既にGTのsame-revision取消は、許可されたcancellation correctionとして未見keyごとに一度だけ受理できる。
- 31→32 件は受理する。
- 32 件保持中の33件目の未見 same-revision payload は active、correction、cancellation とも fail-closed に拒否する。
- 最古 key を eviction しない。
- writer は33件以上を fail-loud、reader は subject-local corruption とする。
- active projection の `appliedSemanticKey` は常に `semanticKeys.at(-1)` と一致する。

## 6. 三時計

一 admission の時計を明示的に分離する。

```ts
interface VolcanoAdmissionTimes {
  acceptedAtMs: number;
  classificationNowMs: number;
  expiryNowMs: number;
}
```

| clock | 用途 |
|---|---|
| `acceptedAtMs` | gate retention 起点、v1 `forgetAtMs`、受信時 future-skew |
| `classificationNowMs` | ashfall active／expired 分類 |
| `expiryNowMs` | admission 前 gate expiry、startup／runtime sweep |

live input は transport 受信時刻を三 field 全てへ渡す。

REST historical input は次とする。

```ts
{
  acceptedAtMs: item.head.time の epoch,
  classificationNowMs: startupNowMs,
  expiryNowMs: startupNowMs,
}
```

- `acceptedAtMs` は REST 一覧 item の `head.time`（epoch ms）を証明軸とする。一覧の `receivedTime` field は WS data message 側に存在せず、journal 側の対応値がローカル時計しか持てないため、証明軸には採らない（§16.1 参照）。
- `head.time` は REST 一覧・WS journal の両側で取得できる唯一の server 時刻であり、cross-set 照合・coverage 境界・head sample fingerprint・`acceptedAtMs` を一貫してこの一軸で行う。
- `head.time` は timezone を持つ strict ISO として parse する。実応答では分単位に丸められ、秒以下は `00.000` で届く。
- `head.time` 軸により lower coverage 境界は実受信時刻より最大 60 秒早く判定され得るが、`>=` 判定により余分に含む方向であり安全側（7 日 retention に対して無視できる差）。
- replay で accepted time を startup 時刻へ延長しない。
- restore／migration は persisted accepted time を維持し、classification／expiry に固定 `startupNowMs` を渡す。
- 同じ admission 内で `Date.now()` を再取得しない。
- 三値は finite safe integer かつ ECMAScript Date 有効範囲とする。
- `acceptedAtMs <= expiryNowMs + 15分`、`reportTimeMs <= acceptedAtMs + 15分` を要求する。境界は許可し、+1ms は拒否する。

## 7. compact ashfall projector

### 7.1 classification

VFVO54/55 を一つへ分類する。

```ts
type VolcanoAshfallProjectionResult =
  | { kind: "active"; projection: VolcanoAshfallProjectionV1 }
  | { kind: "expired"; forecastEndsAtMs: number }
  | { kind: "nonProjectable"; reason: VolcanoAshfallProjectionDiagnostic }
  | { kind: "cancellation" }
  | { kind: "transient"; reason: VolcanoAshfallIdentityDiagnostic };
```

- identity／revision 不正は transient であり gate を作らない。
- valid revision だが安全な compact projection を作れない発表は nonProjectable とする。
- accepted expired／nonProjectable は古い projection を表示し続けず、non-cancelled gate-only GA を残す。
- parser DTO、CLI／ticker 用 raw detail は projector failure で破棄しない。

### 7.2 period validation

```ts
VOLCANO_ASHFALL_MAX_PERIODS = 24
VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD = 256
VOLCANO_ASHFALL_MAX_TOTAL_AREA_OCCURRENCES = 2048
VOLCANO_ASHFALL_MAX_PERIOD_DURATION_MS = 48 hours
VOLCANO_ASHFALL_MAX_FORECAST_SPAN_MS = 48 hours
VOLCANO_ASHFALL_MAX_START_BEFORE_REPORT_MS = 6 hours
```

全 period に次を要求する。

- period 数は1〜24。
- `StartTime` と `EndTime` は `Z` または明示 offset を持つ strict ISO。
- `startTimeMs < endTimeMs`。
- 各 duration は48時間以下。
- `maxEnd - minStart` は48時間以下。
- `minStart >= reportTimeMs - 6時間`。
- `maxEnd <= reportTimeMs + 48時間`。
- 各 period の area 数は1〜256。
- 全 area occurrence は2,048以下。
- gap、overlap、containment を許可する。
- input order を時系列の正本にしない。
- validation 後は end、start、元 index の昇順で決定的に扱う。
- 完全重複 period だけを一件へ正規化し、同時刻で payload が異なる period は別物とする。
- 一件でも invalid なら candidate 全体を nonProjectable にする。
- thickness／distance等のoptional numeric値が存在する場合、nonfinite値をnonProjectableとする。finite値はCLI DTOに維持するがcompact projectionへ保存しない。

```ts
forecastStartsAtMs = min(period.startTimeMs)
forecastEndsAtMs = max(period.endTimeMs)
```

ISO mirror は保存しない。

### 7.3 area identity

```text
code が nonblank: area:code:<normalizedCode>
code が空で name が nonblank: area:name:<normalizedName>
```

- code は NFC、trim、32 code units 以下、leading zero 保持。
- name は NFC、trim、連続 whitespace を半角 space 一つへ畳み、128 code units 以下。
- code／name とも空、または制御文字ありを拒否する。
- code を数値化せず、name fallback から synthetic code を作らない。
- 同一 code に複数 canonical name があれば candidate 全体を nonProjectable にする。
- 同一 name に異なる code は許可し、別 identity とする。
- code-less identity と code identity を混ぜない。

表示 label は code ありなら `<name>（<code>）`、なしなら `<name>` とする。visible text、ARIA、pager label、measurement signature は同じ identity 規則を使う。

### 7.4 ash group

| code | canonical label | hazard | order |
|---|---|---|---:|
| `75` | 小さな噴石の落下 | ballistic | 0 |
| `73` | 多量の降灰 | ash | 1 |
| `72` | やや多量の降灰 | ash | 2 |
| `71` | 少量の降灰 | ash | 3 |
| `70` | 降灰 | ash | 4 |

- known code と `ashName` の不一致を拒否する。
- unknown code は nonblank 8 code units 以下、name は nonblank 64 code units 以下とする。
- 同一 unknown code に複数 name があれば拒否する。
- unknown code は header severity を上げない。
- unknown group は known group 後に code 辞書順で並べる。
- group は最大8件。known group を優先し、残りを unknown code 順で選び、超過分を `omittedGroupCount` にする。
- code 70〜73 で同一 area が複数回現れた場合、最も重い code 一件へ集約する。
- code 75 は ash と独立して保持する。同一 area は ash 一回、ballistic 一回まで現れ得る。
- unknown は known ash／ballistic と統合しない。
- group 内 area は identity で一意とする。

area rank は `firstForecastEndAtMs`、`identityKey` の昇順とする。各 group は上位3地域だけを保存する。

```ts
VOLCANO_ASHFALL_MAX_TOP_AREAS_PER_GROUP = 3
VOLCANO_ASHFALL_MAX_GROUPS = 8
```

- `areaCount >= 1`。
- `topAreas.length === min(3, areaCount)`。
- `omittedAreaCount === areaCount - topAreas.length`。
- `firstForecastEndAtMs` は `forecastStartsAtMs < value <= forecastEndsAtMs`。
- 上位外は `ほか N 地域`、group 超過は `ほか N 区分` と表示する。

### 7.5 persisted projection

```ts
interface VolcanoAshfallTopAreaV1 {
  identityKey: string;
  code: string | null;
  name: string;
  firstForecastEndAtMs: number;
}

interface VolcanoAshfallGroupV1 {
  hazardClass: "ash" | "ballistic" | "unknown";
  ashCode: string;
  ashName: string;
  areaCount: number;
  topAreas: VolcanoAshfallTopAreaV1[];
  omittedAreaCount: number;
}

interface VolcanoAshfallProjectionV1 {
  stateSubjectKey: string;
  volcanoCode: string;
  volcanoName: string;
  eventId: string;
  sourceType: "VFVO54" | "VFVO55";
  sourceEventId: string;
  forecastStartsAtMs: number;
  forecastEndsAtMs: number;
  groups: VolcanoAshfallGroupV1[];
  omittedGroupCount: number;
  revision: StandbyRevision;
  appliedSemanticKey: string;
  generation: number;
}
```

raw XML、polygon、全 period、上位外 area name、thickness、direction、distance、body text、ISO／JST mirror、`restored` は保存しない。

### 7.6 persisted deep invariants

- 全 string／number を nested field まで検証する。
- timestamp、generation、count は finite safe integer とする。
- `stateSubjectKey === "volcano:ashfall:" + volcanoCode`。
- group key `hazardClass + ashCode` は一意で §7.4 順と一致する。
- `groups.length` は1〜8。
- `topAreas.length` は0ではなく `min(3, areaCount)` と一致する。
- `areaCount === topAreas.length + omittedAreaCount`。
- area identity を code／name から再導出し `identityKey` と完全一致させる。
- `omittedGroupCount`、`omittedAreaCount` は非負 safe integer。
- persisted projection の下限式を満たす。

```ts
const representedAreaLowerBound =
  groups.reduce((sum, group) => sum + group.areaCount, 0)
  + omittedGroupCount;

representedAreaLowerBound <= 2048;
```

writer/projector は omission 前の正確な total occurrence も2,048以下と確認する。2,048は許可、2,049は拒否する。

一件の malformed group／area／count／identity を黙って落とさず、その ashfall projection 全体を除外する。valid gate は GA として保持できる。

### 7.7 expiry

- `classificationNowMs < forecastEndsAtMs` なら active。
- `classificationNowMs === forecastEndsAtMs` なら expired。
- earlier period 終了時に部分再集約しない。
- natural expiry は projection だけを削除し、gate は non-cancelled GA として retention まで保持する。
- acceptedAt、revision、semantic keys、source IDs を自然失効で更新しない。

## 8. ashfall lifecycle と取消

### 8.1 state

- `H0`: projection なし、gate なし
- `H54`: rapid projection + non-cancelled gate
- `H55`: detailed projection + non-cancelled gate
- `GA`: projection なし + non-cancelled gate
- `GT`: projection なし + cancelled tombstone

### 8.2 transition matrix

| current | active | expired | nonProjectable | cancellation |
|---|---|---|---|---|
| H0 | H54／H55、generation 1 | GA | GA | valid code＋EventID なら GT |
| H54 | accepted なら incoming type へ置換、generation+1 | accepted なら GA | accepted なら GA | matching EventID なら GT |
| H55 | accepted なら incoming type へ置換、generation+1 | accepted なら GA | accepted なら GA | matching EventID なら GT |
| GA | strictly newer または許可 correction なら H54／H55、generation 1 | accepted なら GA 更新 | accepted なら GA 更新 | matching accepted なら GT |
| GT | strictly newer active だけ H54／H55、generation 1 | strictly newer なら GA | strictly newer なら GA | strictly newer または許可 correction なら GT 更新 |

- H54／H55 の rejected expired／nonProjectable は existing projection を消さない。
- different EventID の expired／nonProjectable は strictly newer の場合だけ existing projection を削除して GA にする。
- GT は equal active report で再開しない。
- accepted durable mutation は内容に関係なく callback 一回、rejected／duplicate はゼロとする。

### 8.3 generation

- H0→active は1。
- continuous active replacement、54↔55、new EventID、same-revision correction は+1。
- stale、duplicate、invalid、expired、nonProjectable、cancellation、wire omissionでは増やさない。
- active→GA／GT で projection generation は消える。
- GA／GT→active は1へ reset する。
- restore した active projection は保存 generation を維持し、次の continuous replacement で+1する。
- increment が `Number.MAX_SAFE_INTEGER` を超える candidate は fail-closed にする。
- pager atom は current `sourceEventId` も含むため、reset 後の generation 1 を旧 atom と同一視しない。

### 8.4 cancellation target

1. valid code があれば ashfall subject candidate を作る。
2. EventID もあれば current actual EventID と一致させる。
3. code が空なら gate の actual EventID provenance から一致 subject を逆引きする。
4. 一意な一件だけを target とする。
5. zero／multiple match、code／EventID mismatch は state-neutral reject とする。
6. current subject がなくても valid code＋EventID の cancellation は新規 GT を作れる。

- older／unordered cancellation は拒否する。
- equal cancellation は同 lifecycle の許可された初回または correction だけ受理する。
- repeated identical cancellation は TTL、acceptedAt、revision、semantic keys、source IDs、callback を更新しない。
- accepted cancellation は ashfall projection だけを削除し、gate を GT へ更新する。
- alert／eruption slice と gate を変更しない。

## 9. cross-slice、visibility、tone

### 9.1 independence matrix

| input | alert | eruption | ashfall |
|---|---|---|---|
| accepted alert active／release | 対象だけ更新／削除 | 不変 | 不変 |
| accepted eruption active／cancel | 不変 | 対象だけ更新／削除 | 不変 |
| eruption 24h expiry | 不変 | 削除 | 不変 |
| accepted ashfall | 不変 | 不変 | §8 |
| ashfall expiry／retention expiry | 不変 | 不変 | projection／gateだけ削除 |
| VFVO53 | 不変 | 不変 | 不変 |
| stale／duplicate／invalid | 不変 | 不変 | 不変 |

composite 共通 `sourceEventIds` と `volcanoName` の canonical 更新は slice field の変更とは数えない。名前更新は accepted input の nonblank canonical name だけを採用する。

### 9.2 card visibility

`VolcanoCard` は次のいずれかで存在する。

- alert level 4以上
- active warning-class alert
- active eruption
- active ashfall
- wire budgetで detail が省略された active ashfall

level 3以下 alert は単独で card を作らないが、eruption／ashfall により card がある場合は補助表示できる。GA／GT だけでは card を作らない。

### 9.3 tone lattice

```text
muted < advisory < warning < red < emergency
```

alert:

| state | tone |
|---|---|
| Lv5 | emergency |
| Lv4 | red |
| Lv3／active warning-class | warning |
| Lv2 | advisory |
| Lv1／info／none | muted |

eruption:

| state | tone |
|---|---|
| 噴火速報 | red |
| その他 active eruption | advisory |
| none | muted |

ashfall:

| state | tone |
|---|---|
| VFVO54 | warning |
| VFVO55／none | muted |

card tone は active slice の最大値とする。wire omitted ashfall も寄与する。unknown ash code、厚さ、地域数から tone を作らない。

card severity は emergency／red→critical、warning／advisory→warning、muted→normal とする。

これはstandby cardのtoneであり、既存per-message frameはVFVO53=`info`、VFVO54=`warning`、VFVO55=`normal`のまま変更しない。

## 10. holder、standby、runtime sweep

### 10.1 holder API

```ts
interface VolcanoStateHolder {
  snapshot(): VolcanoHolderSnapshot;
  replacePrevalidated(snapshot: VolcanoHolderSnapshot): void;
  composite(code: string): VolcanoCompositeV2 | undefined;
  sweep(nowMs: number): VolcanoSweepResult;
  exportPersistedState(): PersistedVolcanoStateV2;
  restorePersistedState(
    state: PersistedVolcanoStateV2,
    nowMs: number,
  ): VolcanoRestoreMutation;
}
```

- `snapshot()` は一論理時点の deep copy と version を返す。
- `replacePrevalidated()` は新しい reject 条件を持たない。
- `clear()` は三 slice と source IDs を消す。
- prompt status と `detail volcano` は従来どおり alert slice から作る。
- scratch replay も同じ snapshot／reducer を使う。

### 10.2 standby update

`VolcanoUpdate.kind` を `"alert" | "eruption" | "ashfall"` へ拡張する。

ashfall update は code、current source ID、projection または null、subject、classification、planned flat `sourceEventIds` を運ぶ。

- `volcanoStateMutationAccepted === true` の accepted inputだけを適用する。
- VFVO53 は update を生成しない。
- cancellation／expired／nonProjectable は `projection: null`。
- rejected／duplicate／transient は update を生成しない。
- standby の `sourceEventIds` は個別 append せず、holder composite の planned flat set で置換する。
- standby は canonical persistence の入力にならない。

### 10.3 runtime sweep

60秒 sweep は`StandbyPersistenceAdmissionCoordinator.sweepAll(nowMs)`の一candidateで次をscratch上に行う。

1. holder eruption expiry
2. holder ashfall expiry
3. volcano 三 family gate retention expiry
4. projection／gate coupling cleanup
5. derived standby volcano replace／delete
6. flood gate／holder／standby lifecycle
7. weather／tsunami／standby-domain gate retention
8. standby heat／typhoon／tornado／long-period／quake host／Nankai／briefing critical expiry

eruption expiry は同じscratch内で holder eruption を先に削除し、その結果からstandby eventを削除する。standby mirrorだけを期限切れにしてholderから再生成させてはならない。全ownerを含む完成v2／v1をpreflightし、version一致時に一回replaceしてからdurable saveを予約する。上記番号はreducer内の依存順であり、real ownerを逐次公開する順ではない。

- eruption expiry は既存 `revision.reportTimeMs + 24 hours` ちょうどで成立する。
- ashfall は `forecastEndsAtMs` ちょうどで成立する。
- ashfall gate retention は acceptedAt+7日ちょうどを保持し、+1msで削除する。
- repeated sweep は idempotent。
- durable change が一件以上ならglobal callback／schedule一回。
- preflight／version failureは全sweep candidateをstate-neutralに破棄してdiagnosticを出す。直前の正常commitが16MiB以内である以上、容量を減らすだけのsweepがbyte超過する場合はserializer invariant failureとして扱う。

## 11. browser protocol と UI

### 11.1 DTO

```ts
interface DisplayVolcanoAshfallAreaV1 {
  identityKey: string;
  code: string | null;
  name: string;
  displayLabel: string;
}

interface DisplayVolcanoAshfallGroupV1 {
  hazardClass: "ash" | "ballistic" | "unknown";
  ashCode: string;
  ashName: string;
  areas: DisplayVolcanoAshfallAreaV1[];
  omittedAreaCount: number;
}

interface DisplayVolcanoAshfallV1 {
  kind: "rapid" | "detailed";
  label: "降灰速報" | "降灰予報（詳細）";
  eventId: string;
  sourceEventId: string;
  forecastEndsAt: string;
  forecastEndLabel: string;
  groups: DisplayVolcanoAshfallGroupV1[];
  omittedGroupCount: number;
  generation: number;
}
```

`DisplayVolcanoEntryV1` に optional `ashfall?: DisplayVolcanoAshfallV1 | null`、card data に optional `headerTone` と `ashfallOmittedCount` を追加する。protocol version と `kind: "volcano"` は変えない。

new producer では、ashfall detail または正数 `ashfallOmittedCount` があるとき valid `headerTone` を必須とする。old snapshot で ashfall semantics がない場合だけ欠落を許可する。

`sourceType` から kind／label を決める。終了 ISO は numeric epoch から `new Date(...).toISOString()` で生成し、label は `Asia/Tokyo` 固定 `YYYY年M月D日 HH:mmまで` とする。frontend は ISO を独自再解釈しない。

outer card:

- `updatedAt`: 表示対象 active slice の revision report time 最大。
- independently visible alert があれば `expiresAt: null`。
- それ以外は eruption／ashfall expiry 最大。
- `restored`: 表示 active slice または wire omitted restored ashfall のいずれかが restored。
- `sourceEventIds`: 表示対象 composite の flat source IDs を unique sorted union。
- wire omission で outer source IDs を縮めない。

### 11.2 malformed wire fallback

- valid new snapshot は engine `headerTone` を authoritative に使う。
- ashfall semantics がない旧 snapshot は既存 alert／eruption fallback を使う。
- ashfall semantics があるのに tone 欠落／不正なら ashfall contribution を muted とする。
- malformed VFVO54 から warning、VFVO55 から advisory を推測しない。
- known alert／eruption tone は維持する。
- bounded diagnostic を一回記録する。

### 11.3 style と body

既存 token だけを使う。

| tone | style |
|---|---|
| emergency | `header-weatherEmergency-*` |
| red | `header-tsunamiWarning-*` |
| warning | `header-weatherWarning-*` |
| advisory | `header-weatherAdvisory-*` |
| muted | `standby-card-header--muted` |

ashfall body は label、終了時刻、hazard group、上位地域、地域省略、group省略の順に表示する。既存 spacing、border、type scale、`RestoredChip`、`UpdatedStamp` を維持する。

### 11.4 pager と measurement

既存 `volcano` CardKey と coordinator を使い、新しい solver candidate を追加しない。

atom:

- volcano summary
- group label
- area 一件
- omitted area count
- omitted group count
- wire omitted ashfall count

area 一件を最小 atom とし、一つの atom を複数 page に分割しない。group が page をまたぐ場合は label を再表示する。複数 page は既存 `N/M` footer、一 page は footer なしとする。

ashfall atom identity:

```text
<stateSubjectKey>|<sourceEventId>|<generation>|<ashCode>|<areaIdentityOrMarker>
```

array index を使わない。

measurement signature は header title／tone、restored、updatedAt、outer source IDs、三 slice の全 visible field、ashfall source ID／generation／終了 label／group／area identity／省略件数、pager identity、footer、placement、compact/full variant を canonical serialize して作る。配列長だけを使わない。

live card、side／center shelf、page probe は同じ `VolcanoCard` component と coordinator data を使う。

## 12. wire capacity

```ts
VOLCANO_ASHFALL_MAX_WIRE_SLICES = 64
VOLCANO_CARD_MAX_WIRE_BYTES = 64 * 1024
MAX_SNAPSHOT_BYTES = 256 * 1024 // existing global constant
```

完成 `ActiveStandbyCardV1` が count と UTF-8 byte の双方を満たすことを要求する。byte は `Buffer.byteLength(JSON.stringify(card), "utf8")` 相当で測る。

alert／eruption detail と outer source IDs は省略不可。ashfall detail だけを縮退対象とする。

selector order:

1. rapid を detailed より先
2. `forecastEndsAtMs` 昇順
3. report time 降順
4. volcano code 昇順

fixpoint:

1. 全 candidate を上記順に sort。
2. count 内の候補を仮採用。
3. `ashfallOmittedCount`、omitted rapid を含む tone、omitted restored、updatedAt、expiresAt、outer source IDs、pager metadata を含む完成 card を作る。
4. UTF-8 byte を測る。
5. count または byte 超過なら最低優先度 detail を一件戻す。
6. omitted count の桁数も含めて再生成・再測定する。
7. 双方を満たすまで繰り返す。

全 ashfall detail 省略後の minimum card も64KiBを超える prospective live mutation は gate commit 前に拒否する。wire omission は holder、gate、generation、source IDs、persistence を変更しない。

最大 supported snapshot は `encodeSseGuarded()` が non-null を返すことを実測する。1 byte over の synthetic snapshot は既存 fail-loud path に入れ、`standbyItems` を silent drop しない。

## 13. capacity と fail-closed admission

### 13.1 canonical limits

```ts
VOLCANO_ALERT_MAX_SUBJECTS = 128
VOLCANO_ERUPTION_MAX_SUBJECTS = 128
VOLCANO_ASHFALL_MAX_SUBJECTS = 128
VOLCANO_MAX_ACTIVE_COMPOSITES = 128
VOLCANO_ROLLBACK_MAX_RECORDS = 128
VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE = 4096
VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE = 1024 * 1024
STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE = 16 * 1024 * 1024
```

flat source ID 4,096 は旧四 domain×1,024 の total ceiling を保った単純化である。実効容量は1MiBとの積集合なので、長い ID を4,096件保持できる保証ではない。

family subject count は active projection、GA、GT の typed union で数える。active composite は三 slice の少なくとも一つを持つ volcano code の union で数える。

alert／eruptionのtombstone retentionは既存の30日／2日を維持し、capacityだけを各128 subjectへ揃える。

- 各 family は128件目まで count 上許可、129件目を拒否する。
- active composite は128件目まで許可、129件目を拒否する。
- rollback record は composite と一対一で最大128。
- GA／GT だけでは composite を増やさない。
- 三 family 最大 fixture は同じ128 volcano code に alert／eruption／ashfall を重ねる。
- 互いに異なる code で128件ずつ、384 composite を作ることはできない。
- existing subject 更新は count を増やさないが、byte 超過なら拒否する。
- capacity を空けるため既存 active／watermark／tombstone／source ID を eviction しない。
- VFVO51 は全 subject の prospective union を一 transaction で検査し、一件でも不成立なら全件拒否する。

### 13.2 byte scopes

v2 fileのcombined volcano subtreeは次を含めて1MiB以下とする。

- generation 1 canonical composites
- volcano 三 family canonical gate entries
- `telegramFoundation.volcano.active` rollback array
- v2 root `volcanoes` rollback array
- v1 seen／alert・ashfall gate metadata mirrors
- repair state

standalone v1 fileはroot volcanoes、seen、alert／ashfall gate metadata、repair stateを含むcombined volcano subtreeを1MiB以下とする。

これとは独立に、完成したv2 file全体とstandalone v1 file全体をそれぞれ16MiB以下とする。16MiBはwriterが実際にwriteするencoded buffer全体のUTF-8 byte上限であり、trailing newline等を出すならそれも含む。volcano subtreeだけの上限ではない。

この16MiBはparse前の入力資源上限であり、容量不変条件ではない。上限は正当なruntime stateが必ず収まる余裕を持たなければならない。admissionが正当なstateを拒否すると、それは容量保護ではなく可用性障害（当該domainのmutation拒否＝電文のsuppressed化）になる。実測では、VPWS50のhistory 8件×300〜430KBの全国スナップショットにpartialHistory 128 subject×8とpartialStreams 128を加えた正当な最大構成が約5.2MBに達する。16MiBはその約3倍の余裕を取った値である。この値はSD書込み頻度、SSE snapshotの256KB、volcano subtreeの1MiBとは独立に決まり、それらを連動させて変更しない。

- v2 と v1 の byte を合算しない。
- v2 内の二 rollback copy は実在する二 copy として二重計上する。
- count と byte は AND である。
- alert／eruption admissionもcompleted VolcanoCard、両volcano subtree、両file全体をpreflightする。
- tsunami、weather、flood、heatその他のpersisted domainも、stateful mutation前に同じ完成v2／v1 serializerを使って16MiB全file上限を検査する。volcano routeだけに検査を置いてはならない。
- 全domain共通のprospective persistence admissionはruntime mutationより前に行う。writerで初めて16MiB超過を発見して、正常runtime stateを保存不能にしてはならない。
- 既存subject更新も含め、いずれか一方のfileが16MiBを1 byteでも超えるcandidateは当該domain mutation全体をfail-closedに拒否する。16MiBちょうどは許可する。
- prospective full-file serializerはwriterと同じJSON shape／UTF-8 byte定義を使い、root `logicalGeneration`には最大20桁の`"18446744073709551615"`を入れて測る。次saveの桁上がりによってadmission時のbyte見積りを超えてはならない。`savedAt`はECMAScript `toISOString()`の最大27 code unitsを占めるplaceholderで測る。
- last committed／reserved logical generationがuint64最大で新しいsave世代を予約できない場合も、全domain durable mutationをruntime変更前にfail-closedとする。writerだけでoverflowを発見しない。

最大fixtureはalert 128＋eruption 128＋ashfall 128を同じ128 codeへ重ねたvolcano最大に加え、全persisted domainと`briefingCritical`の各count最大を持つrejection candidateと、16MiB以内のmax-admissible candidateを分ける。v2／v1のvolcano subtree、全file、minimum cardのexact byteをstatic JSONへ固定する。rejection candidateは16MiBを超えるよう構成した上で全file admissionによりcommit前に拒否され、16MiB以内の最大正常fixtureはreaderが全recordを再読込できなければならない。reviewで例示された津波観測の密な約4.85MB candidateは16MiB以下なのでrejection側ではなくadmissible側の実例である。

max-admissible fixtureはVPWS50の正当な最大shape、すなわちhistory 8件×全国areas約1,080件、partialHistory 128 subject×8、partialStreams 128を含める。この実serializer出力が16MiB以下であることを固定し、正当な最大構成がadmissionを通ることを回帰で守る。

定数選定のsanity checkは次である。これは受入判定ではなく、受入判定はactual serializerのexact byteとする。

```text
旧 structural units:
  alert 512 + eruption 512 + ashfall 128 + lineage 1152 = 2304
旧最小級 v2 subtree:
  1,505,071 bytes
新 structural units:
  alert 128 + eruption 128 + ashfall 128 + composite 128 = 512
線形概算:
  1,505,071 * 512 / 2304 ~= 334,461 bytes < 1MiB

既存最小級 eruption 512件:
  約77,000 bytes
非省略 alert 128 + eruption 128 の概算:
  77,000 * 256 / 512 ~= 38,500 bytes < 64KiB
```

flat source IDsや実文字列で上限を超える場合はcount内でも拒否するため、この概算から到達可能容量を推測しない。

### 13.3 全domain prospective admission

composition rootは、pair writerへ入る全runtime ownerを一論理時点へ束ねる`StandbyPersistenceAdmissionCoordinator`を一つ持つ。現行の`StandbyPersistence` callbackはこのcoordinatorのcommit後通知へ置換する。coordinatorは永続正本、full-state handoff buffer、commit manifestではなく、同期candidate検証とowner replaceの境界である。

snapshotとversion tokenは次で固定する。ここに未定義のdomain bagを置かない。

```ts
type StandbyPersistenceOwnerKey =
  | "telegramRevisionGate"
  | "standbyStateStore"
  | "vpws50State"
  | "vpww56State"
  | "tsunamiState"
  | "volcanoHolderAndRepair"
  | "floodForecastState";

interface StandbyPersistenceDomainSnapshots {
  telegramRevisionGate: TelegramRevisionGateSnapshot;
  standbyStateStore: StandbyStateStoreSnapshot;
  vpws50State: Vpws50StateSnapshot;
  vpww56State: Vpww56StateSnapshot;
  tsunamiState: TsunamiStateSnapshot;
  volcanoHolderAndRepair: {
    runtimeVersion: number;
    holder: VolcanoHolderSnapshot;
    repair: VolcanoRepairStateV1;
  };
  floodForecastState: FloodForecastStateSnapshot;
}

interface StandbyPersistenceVersionToken {
  compositionVersion: number;
  ownerVersions: Record<StandbyPersistenceOwnerKey, number>;
}

interface StandbyPersistenceAdmissionSnapshot {
  token: StandbyPersistenceVersionToken;
  domains: Readonly<StandbyPersistenceDomainSnapshots>;
}

type StandbyDurableMutationKey =
  | "weather:VPWS50"
  | "weather:VPWW56"
  | "tsunami:VTSE41"
  | "tsunamiObservation:VTSE51"
  | "tsunamiObservation:VTSE52"
  | "volcano:volcanoAlert"
  | "volcano:volcanoEruption"
  | "volcano:volcanoAshfall"
  | "floodForecast:floodForecast"
  | "standby:tornado"
  | "standby:heatAlert"
  | "standby:typhoonAnalysis"
  | "standby:nankaiTrough"
  | "standby:lgObservation"
  | "standby:briefingCritical"
  | "standby:quakeHost";

interface StandbyPersistenceCandidate {
  key: StandbyDurableMutationKey;
  base: StandbyPersistenceVersionToken;
  touchedOwners: readonly StandbyPersistenceOwnerKey[];
  domains: Readonly<StandbyPersistenceDomainSnapshots>;
  durableChanged: boolean;
}

type StandbyCandidateReducer<T> = (
  draft: StandbyPersistenceDomainSnapshots,
) =>
  | { kind: "accepted"; value: T; durableChanged: boolean }
  | { kind: "rejected"; reason: string };

type StandbyTransactionResult<T> =
  | { kind: "committed"; value: T; token: StandbyPersistenceVersionToken }
  | { kind: "rejected"; reason: string }
  | { kind: "staleVersion" };

interface AllDomainSweepResult {
  changedKeys: StandbyDurableMutationKey[];
  durableChanged: boolean;
}

interface StandbySerializationEnvelope {
  logicalGeneration: PersistenceLogicalGeneration;
  savedAt: string;
}

interface StandbyPersistenceAdmissionCoordinator {
  capture(): StandbyPersistenceAdmissionSnapshot;
  transact<T>(
    key: StandbyDurableMutationKey,
    touchedOwners: readonly StandbyPersistenceOwnerKey[],
    reduce: StandbyCandidateReducer<T>,
  ): StandbyTransactionResult<T>;
  restorePrevalidated(domains: StandbyPersistenceDomainSnapshots): void;
  sweepAll(nowMs: number): StandbyTransactionResult<AllDomainSweepResult>;
  captureSerializedPair(envelope: StandbySerializationEnvelope): {
    token: StandbyPersistenceVersionToken;
    v2: Uint8Array;
    v1: Uint8Array;
  };
  onDurable(callback: () => void): void;
}
```

`transact()`だけがnormal runtimeのcommit APIであり、capture→対象owner clone→reducer→実serializer preflight→version再確認→fixed-order replaceを同期実行する。`restorePrevalidated()`はsource readerが全schema／count／byteを検証済みのstartup前一回だけ、`captureSerializedPair()`はwriter／shutdownだけが使い、§14.7で同時に予約したgeneration／savedAtを渡す。`onDurable` callbackはnon-throwingである。`touchedOwners`は上表の固定owner順のunique arrayでなければstate-neutral rejectとし、callerが少ない集合を申告して検査を迂回できないよう`key`ごとの期待集合をcoordinator内registryで照合する。

各snapshot型は対応ownerの全runtime stateを含むdeep cloneであり、`cloneSnapshot()`、`replacePrevalidated(snapshot)`、finite safe integerの`version()`をexportする。`StandbyStateStoreSnapshot`はheat、typhoon、volcano derived mirror、flood、weather alerts、tornado、long-period、quake host、Nankai、revision guard、briefing entry／cancellation／watermark／raw aliasと各generationを全て含む。表示中のnoncritical briefingもcloneしてreplace時に失わないが、serializerへ出すのは従来どおりcritical lifecycleだけである。snapshot exportはclockを読まず、`savedAt`とlogical generationはsnapshot外でserializerがplaceholder／reserved値を注入する。`TelegramRevisionGateSnapshot`はtransientを含むgate全体をcloneするが、pair serializerへ出すのはdurable entryだけである。

`volcanoHolderAndRepair`とshared gateのvolcano subsetを同じtokenから組み合わせたものが§4.1の`VolcanoRuntimeSnapshot`である。別のgate copyを所有しない。`VolcanoTransactionCoordinator`はこのglobal coordinatorの`volcano:*` adapterであり、独自versionをcommitした後にglobal versionへ追認させる二段commitは禁止する。

現行HEADに存在する全durable mutation入口、scratch owner、実test pathは次で固定する。表のowner以外をpost-commitで追加mutationしてpair内容を変えてはならない。

表のscratch owner列は、そのkeyの`expectedTouchedOwners`と再確認する`ownerVersions`の集合そのものである。「standby projection」と記したrowは`standbyStateStore`、「gate」は`telegramRevisionGate`、「volcano holder＋repair」は`volcanoHolderAndRepair` tokenへ一対一に対応する。

test欄の`phase*.test.ts`は全て実在する`test/engine/telegram-foundation/`配下、その他のpathはrootからの完全pathである。

| durable key／head | scratch owner | candidate reducerを置く入口 | 置換する現行direct mutation | 実test path |
|---|---|---|---|---|
| `weather:VPWS50`／VPWS50・VPWW55/57-61 | gate、`Vpws50StateHolder`、standby weather projection | `process-weather.ts`がparse後に`reduceWeatherCandidate`を呼ぶ | `gate.decide()`→`diffAndUpdate*／restorePrevious*`→display sinkの`applyWeatherAlerts()` | `test/engine/presentation/processors/process-weather.test.ts`、`phase3b-vpws50-router.test.ts` |
| `weather:VPWS50`／VPNO50 emergency clear | gate（legacy transientを含む）、`Vpws50StateHolder`、standby weather projection | `process-message.ts`のlegacy counterpart branchが`reduceVpws50EmergencyClearCandidate`を呼ぶ | `clearEmergencyPartialAreas()`→`onVpws50StateMutationAccepted()`→display sinkのweather projection | `phase6b-legacy-counterpart.test.ts`、`phase3b-vpws50-router.test.ts` |
| `weather:VPWW56` | gate、`Vpww56StateHolder`、standby weather projection | 同上 | `gate.decide()`→`applyAccepted／clearSubject`→`applyWeatherAlerts()` | `test/engine/presentation/processors/process-weather.test.ts`、`phase3b-vpww56.test.ts` |
| `tsunami:VTSE41` | gate、`TsunamiStateHolder` | `process-tsunami.ts`のwhole-message reducer | line 183以降の`gate.decide()`→`applyAccepted／clearAccepted` | `test/engine/presentation/processors/process-tsunami.test.ts`、`phase3b-tsunami.test.ts` |
| `tsunamiObservation:VTSE51/52` | gate、`TsunamiStateHolder` | 同fileのfamily＋station item一括reducer | whole gate、item gate、`applyAcceptedObservations`、evicted code clearの逐次mutation | `phase3b-tsunami.test.ts`、`phase3b-tsunami-fixtures.test.ts` |
| `volcano:volcanoAlert` | gate、volcano holder＋repair、standby volcano mirror | `VolcanoTransactionCoordinator` | `volcano-route-handler.ts`のsubject別direct decide／holder更新 | `phase3b-volcano.test.ts`、`test/engine/volcano-route-handler.test.ts` |
| `volcano:volcanoEruption` | 同上 | 同上 | 同上 | 同上、`test/engine/messages/volcano-state-edgecase.test.ts` |
| `volcano:volcanoAshfall`／VFVO54/55 | 同上 | 同上 | 新規live／REST／sweep reducer | 同上、`test/engine/volcano-initializer.test.ts` |
| `floodForecast:floodForecast` | gate、`FloodForecastStateHolder`、standby flood reducer | `process-flood-forecast.ts`のEventID reducer | line 85以降の`gate.decide()`→`rollback／diffAndUpdate／touch／retainActiveEventIds`→display projection | `test/engine/presentation/processors/process-flood-forecast.test.ts`、`phase3b-flood.test.ts` |
| `standby:tornado` | gate、standby | `process-standby-foundation.ts`＋routerのdurable presentation reducer | gate commit後の`StandbyStateStore.applyEvent()` | `phase3b-standby-domains.test.ts`、`test/engine/display/standby-state-store.test.ts` |
| `standby:heatAlert` | gate、standby | 同上 | 同上 | 同上 |
| `standby:typhoonAnalysis` | gate、standby | 同上 | 同上 | 同上 |
| `typhoonProbability:VPTA50` | gate、standby probability projection | `process-message.ts`のtyped admission completion reducer | gate expiry／commit→holder／通知→display reducer後の保存予約 | `test/engine/messages/message-router-vpta.test.ts`、`standby-wiring.test.ts` |
| `weatherWarningTimeseries:VPWP50` | gate、standby weather-timeseries projection | `process-message.ts`のstandby foundation reducer | gate expiry／commit後のdisplay reducerをfinallyで一保存へ合流 | `phase3b-standby-domains.test.ts`、`standby-wiring.test.ts` |
| `standby:nankaiTrough` | gate、standby | 同上 | 同上 | 同上 |
| `standby:lgObservation` | gate、standby | 同上 | 同上 | 同上 |
| `standby:briefingCritical`／VPBS50・VPOA50 | gate（transientを含む）、standby内briefing全state | normal ingestはrouterの`reduceBriefingCandidate`、late counterpartはcomposition root注入の`reduceBriefingReconcileCandidate`を呼ぶ | `gateTransientOutcome`のreal gate commit＋display sink `applyEvent／reconcileBriefingCard`によるcritical entry、cancel、watermark、alias mutation | `test/engine/display/standby-state-store.test.ts`、`standby-persistence.test.ts`、`standby-wiring.test.ts` |
| `standby:quakeHost` | gate（transientを含む）、standby内quake host＋revision guard | routerのdurable presentation reducer | earthquake transient gate commit＋display sink `applyEvent()`のpost-gate mutation | `test/engine/display/standby-state-store.test.ts`、`standby-wiring.test.ts` |

`briefingCritical`はcommon gate policyの`durable:false`とは独立にpair fileへ保存されるdurable familyである。count fixtureはactive＋cancellation合計128、watermark 512、raw alias 512、各entryのnested limitを含める。`quakeHost`もcommon gate自体はtransientだがpair fileへ書かれるため同じadmissionを通す。いずれも16MiB rejection後にtransient watermarkだけを残して再送を抑止しないよう、gate mutationも同candidateへ入れる。root `seen`はstandby snapshotの一部として上記全rowで検査し、独立した抜け道を持たない。`typhoonProbability`とweather timeseriesはprojection／gateがpair fileへ書かれるため上表のcoordinator transactionへ入れる。Nankai information、VFVO53などpair fileへ書かれないtransient stateはこのmatrixへ入れない。

weather reducerはscratch holder更新後に既存pure helper `weatherAlertsFromVpws50／weatherAlertsFromVpww56`を呼び、scratch standbyへ`applyWeatherAlerts`相当を適用する。flood reducerはaccepted outcome相当のpure `projectFloodUpdate`を同じscratch standbyへ適用する。これらをpresentation eventのpost-commit display sinkまで遅らせない。standby-domain／briefing／quake-hostはparser outcomeからpure presentation eventを先に作り、そのeventをscratch `StandbyStateStore` reducerとcommit後side effectの双方へ使う。

処理APIは次の一経路だけを許す。

1. parse、formatter用計算、REST awaitはcoordinator外で行う。
2. `capture()`で全ownerを一同期区間にexportし、composition／owner versionを固定する。対象rowのownerだけmutable scratch cloneにし、他ownerはimmutable snapshotとして完成file生成に使う。
3. reducerはscratch gateの通常`decide`とscratch holder／standby mutatorを呼ぶ。scratch内callback／listener／I/O／clock取得は禁止する。station item、VFVO51 multi-subject、standby gate＋projectionを一candidateへまとめる。reducer後、`expectedTouchedOwners`外のsnapshotがbaseとdeep equalでなければrejectする。
4. candidate overlayから実writerと同じserializerでprospective v2／standalone v1を完成させ、domain count、briefing count、volcano subtree 1MiB、両full-file 16MiB、wireを検査する。logical generation／`savedAt`は§13.2の最大placeholderを使う。
5. `touchedOwners`のowner versionとcomposition versionを再確認する。untouched ownerもcomposition versionで一括保護されるため、古いother-domain snapshotを使えない。
6. await、clock、I/O、callbackを挟まず各`replacePrevalidated()`を固定owner順で実行する。replaceはthrowしないpure swapとし、全owner version、volcano runtime version、composition versionを各一回増やす。
7. commit後にglobal durable callbackを一回発行する。monitorはそこでlatest coherent snapshotをdirtyにする。domain別旧`on*RevisionDecision`から直接`schedule()`しない。
8. notifier、CLI、ticker、display hub、weather promotion、tornado detail cacheなどfallible side effectはdurable callback後に行う。display sinkはcommit済みstandbyを再mutationしない。

version mismatch、count／byte failure、reducer exceptionはcandidateを破棄してstate-neutral rejectとする。現在のmutate-in-place public APIはscratch adapterからだけ呼べるようprivate化するか、clone receiver上でだけ使用する。commit済みstateをtruncate／evictして16MiBへ戻すことは禁止する。

startup、sweep、RESTも同じ入口を使う。

- source選択後のstartupは全owner用snapshotを構築し、`restorePrevalidated()`でlistener登録前に一回replaceする。現行monitorのholder別`restorePersistedState()`／gate別`restoreDurableEntries()`逐次公開を行わない。
- `sweepAll(startupNowMs)`と60秒timerはgate family expiry、volcano holder expiry、flood lifecycle、standby／briefing expiryを一candidateでreduceし、完成pairをpreflightしてからcommitする。容量を減らすはずのsweepも検査を省略しない。
- `restoreTsunamiState`のREST itemと§16のvolcano REST rebaseはawait後に新しいtokenでcandidateを作る。startup時の古いsnapshotへ直接restoreしない。
- shutdown saveはcoordinatorの`captureSerializedPair()`を一回だけ使い、holder／gate／standbyを別時点でexportしない。

最大fixtureはregistryの全durable family、standby root、`briefingCritical`の上記count ceilingを列挙した`all-domains-count-maximum` candidateと、16MiB以内へ収まる`all-domains-max-admissible` candidateを別に持つ。前者が16MiBを超える場合の期待値はatomic rejectionであり、count ceilingを下げたり先頭N件へ切らない。dense VTSE51／52とbriefing maximumのどちらもfull-file byte計測へ含める。

count-maximum fixtureのfamily単位は次で固定する。nested holder／projection containerも各既存writer上限の最大shapeを使う。

| family／pair content | count ceiling |
|---|---:|
| VPWS50全国base＋VPWW55/57-61 partial | 129 subjects |
| VPWW56 | 128 subjects |
| VTSE41 | 512 subjects |
| VTSE51 station＋family watermark | 1,025 subjects |
| VTSE52 station＋family watermark | 1,025 subjects |
| volcanoAlert／volcanoEruption／volcanoAshfall | 各128 subjects、同じ128 codeへ重ねる |
| floodForecast | 512 subjects |
| tornado／heatAlert／typhoonAnalysis | 128／256／64 subjects |
| nankaiTrough／lgObservation | 1／256 subjects |
| briefingCritical | active＋cancellation 128、watermark 512、raw alias 512 |
| quakeHost | 1 state |

VPNO50はVPWS50 holderの既存subjectをclearする入口であり追加countを持たない。standby derived mirror、root `seen`、weather alert area、tsunami forecast／observation bodyなどは対応familyの同じmaximum candidateから生成し、別fixtureで小さく置換しない。

candidateはcommit／reject後に破棄し、REST await中のlive inputを保持する用途には使わない。

## 14. persistence

### 14.1 canonical generation 1

`PERSIST_SCHEMA_VERSION`は2のまま、volcano stateにgeneration 1を追加する。

```ts
interface PersistedVolcanoStateV2 {
  generation: 1;
  volcanoes: VolcanoCompositeV2[];
}

type VolcanoRepairTarget = "vfvo50" | "ashfall";

type VolcanoOmissionReason =
  | "sliceCorrupt"
  | "gateCorrupt"
  | "provenanceMissing"
  | "operationalV2ProvenanceLost"
  | "terminalQuarantine";

interface VolcanoAlertOmissionV1 {
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  sourceFamily: VolcanoAlertSourceFamily | "unknown";
  lastKnownComparison: TelegramRevisionComparisonInput | null;
  reason: VolcanoOmissionReason;
}

interface VolcanoEruptionOmissionV1 {
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  lastKnownComparison: TelegramRevisionComparisonInput | null;
  reason: VolcanoOmissionReason;
}

type VolcanoOperationalV2ResolutionAction =
  | "acceptCurrent"
  | "clearCurrent"
  | "acknowledgeDomainLoss";

interface VolcanoOperationalV2AlertResolutionV1 {
  resolutionId: string;
  omissionFingerprint: string;
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  action: VolcanoOperationalV2ResolutionAction;
  resolvedAtMs: number;
  actor: "local-repl";
  reason: string;
}

interface VolcanoRepairStateV1 {
  schemaGeneration: 1;
  vfvo50Repairable: boolean;
  ashfallRepairable: boolean;
  unrecoverableAlertOmissions: VolcanoAlertOmissionV1[];
  unrecoverableEruptionOmissions: VolcanoEruptionOmissionV1[];
  operationalV2AlertResolutions: VolcanoOperationalV2AlertResolutionV1[];
}

interface PersistedVolcanoFoundationV2 {
  // old reader compatibility mirror。
  authoritative: boolean;
  ashfallSchemaGeneration: 1;
  repairState: VolcanoRepairStateV1;
  state: PersistedVolcanoStateV2;
  active: PersistedVolcanoStateV1[];
  gateEntries: PersistedTelegramRevisionGateEntryV2[];
}
```

repair stateはRESTで回復可能な不足と、利用可能な履歴源では回復不能な欠損を分ける。

- `vfvo50Repairable`だけがVFVO50 replay targetを表す。
- `ashfallRepairable`だけがVFVO54/55 replay targetを表す。
- VFVO51／VFSVii由来またはprovenance不明のalert喪失は`unrecoverableAlertOmissions`へ入れ、omission自体をVFVO50 replay成功でclear可能なtargetへ変換しない。provenance不明時は回収可能なVFVO50部分のため`vfvo50Repairable`を別途立てても、omissionは残る。
- 現行operational-v2から内容を一意に結合できるが実head typeだけを回収できないactive alertは、sliceを捨てず`sourceFamily:"operationalV2Unknown"`として復元し、同codeの`reason:"operationalV2ProvenanceLost"` omissionを置く。このomissionもVFVO50 replayでは消さない。
- eruption喪失は`unrecoverableEruptionOmissions`へ入れ、REST targetに変換しない。
- `authoritative`はold reader用に`!repairState.vfvo50Repairable && repairState.unrecoverableAlertOmissions.length === 0`から導出する。VFVO50 coverageだけでunrecoverable omissionが残る状態を`true`へ戻してはならない。
- operator-accepted `operationalV2Unknown` baselineはactual source familyをknownへ書き換えない。対応omissionが監査recordへ置換され、かつ`vfvo50Repairable`も別途falseになった後は上記old-reader mirrorがtrueになり得るが、それはoperator受容済みというcontrol-plane事実によるもので、VFVO51／VFSVii historyを回収したとの主張ではない。
- new readerは`repairState`を正とし、`authoritative`と独立に組み合わせてcompletenessを推測しない。
- old schemaの`authoritative === false`は`vfvo50Repairable = true`として利用可能なVFVO50履歴を回収すると同時に、provenanceを持たないdomain scope／sourceFamily `"unknown"`の`unrecoverableAlertOmissions`も残す。VFVO50 replay後は前者だけをclearし、後者によってdegradedを維持する。
- ashfall generation／bundle不足は`ashfallRepairable`へmigrationする。
- new writer は `state: null` を書かない。
- complete empty と gate-only GA／GT は `{ generation: 1, volcanoes: [] }` と gate entries を保存する。

`VolcanoRepairTarget[]`はcontrol stateへ重複保存せず、`vfvo50Repairable`、`ashfallRepairable`のtrue値からこの順で導出する。

normal new runtime、complete empty、legacy repair-state migrationはいずれも`operationalV2AlertResolutions: []`から開始する。old inputのunknown fieldやlog textから監査recordを合成しない。

omission arrayは`scope`、`volcanoCode ?? ""`、`sourceFamily ?? ""`、canonical `lastKnownComparison`、`reason`のcode-unit辞書順でcanonicalizeし、完全重複を拒否する。`scope:"volcano"`はvalid codeを、`scope:"domain"`は`volcanoCode:null`かつ`lastKnownComparison:null`を要求する。各arrayは最大128件とし、129件目が必要なら恣意的subsetを残さず同種のdomain-scope一件へ保守的にcollapseする。domain-scope omissionは§14.1.1のoperator transactionまたは将来そのfamilyの完全coverage sourceが実装されるまで自動消去しない。

known-code omissionはdeep-validなsliceまたはgateから一意に得たcomparisonを`lastKnownComparison`へ保存する。両方から得た値が不一致、またはどちらも得られなければnullとする。unrecoverable alert omissionは同じcodeかつ同じ`sourceFamily`のlive mutationがそのcomparisonよりstrictly newerなactive／releaseを確立したときだけ削除できる。例外として`operationalV2ProvenanceLost`は、同codeのknown-family live inputが保存comparisonよりstrictly newerなactive／releaseを確立して旧baselineを完全にsupersedeした場合にも自動解消できる。eruption omissionも同じcodeのstrictly newer live eruption／valid cancellationだけで削除できる。`lastKnownComparison:null`はlive inputで自動解消しない。VFVO50／ashfall REST成功、単なるsave／reload、unrelated live inputでは削除しない。

`operationalV2AlertResolutions`は一回限りのoperational-v2 provenance移行に対する永続監査記録である。`resolutionId`は`sha256:`＋64 lowercase hex、`omissionFingerprint`はUTF-8 `JSON.stringify([scope, volcanoCode, sourceFamily, canonicalLastKnownComparison, reason])`のSHA-256を同形式で表す。`resolvedAtMs`はfinite safe integer、operator `reason`はNFC／trim後1〜256 code units・制御文字なしとする。`scope`、code、actionの整合をdeep validateし、同じresolution IDまたはomission fingerprintの重複を拒否する。code-level migrationとdomain-level collapseは同時に生成しないため上限は128件であり、監査記録をevict／truncateしない。live supersessionはoperator resolutionではないのでこのarrayへ偽の記録を追加しない。

### 14.1.1 operational-v2 provenance の明示解除

local REPLへ一つの管理commandを追加する。

```text
volcanorepair status
volcanorepair accept <omissionFingerprint> <reason...>
volcanorepair clear <omissionFingerprint> <reason...>
volcanorepair acknowledge-domain <omissionFingerprint> <reason...>
```

`status`は未解決の`operationalV2ProvenanceLost`だけをcode／scope、comparison、fingerprint、利用可能actionとともに表示し、raw bodyやsource IDを出さない。mutation commandはローカルREPLからだけ呼べる。network APIやREST repairへ公開しない。

`VolcanoTransactionCoordinator.resolveOperationalV2AlertOmission(request)`は次の契約を持つ。

```ts
interface ResolveOperationalV2AlertOmissionRequest {
  omissionFingerprint: string;
  action: VolcanoOperationalV2ResolutionAction;
  reason: string;
  expectedRuntimeVersion: number;
}

type ResolveOperationalV2AlertOmissionResult =
  | { kind: "committed"; resolutionId: string }
  | { kind: "notFound" | "staleVersion" | "invalidAction" | "admissionRejected" };
```

composition rootは`status()`と上記resolveだけを持つ`VolcanoRepairAdministration` facadeを作り、`ReplHandler` constructor／`ReplContext`へ注入する。operation handlerがpersistence fileを直接read／writeしたり、holderとgateを個別に触ったりしてはならない。`status()`は一回の`VolcanoRuntimeSnapshot`からfingerprintと`expectedRuntimeVersion`を返し、commandは表示したfingerprintに対してresolveする。

- `acceptCurrent`はcode-level omissionと、matching `operationalV2Unknown` active slice＋non-cancelled gateを要求する。内容は維持し、slice／gateへ同じresolution IDを設定してomissionを除く。
- `clearCurrent`はcode-level omissionを要求し、alert sliceだけを除く。matching gateはcomparison、semantic keys、acceptedAt、retentionを変えないgate-only watermarkとして残し、resolution IDを設定してomissionを除く。他sliceがなければcompositeだけを除く。
- `acknowledgeDomainLoss`はdomain-scope omissionだけを除き、slice／gateを合成しない。
- action名とscopeが合わない、fingerprintが変わった、既にlive supersession済み、matching bundleが崩れている場合はstate-neutral rejectとする。
- `resolvedAtMs`はrequest validation後に一度だけ取得し、resolution IDはUTF-8 `JSON.stringify([omissionFingerprint, action, reason, resolvedAtMs, "local-repl"])`のSHA-256とする。wall clockはrevision orderingやlogical generationへ使わない。
- scratchでomission除去、slice／gate変更、監査record追加、standby再射影を行い、通常のcount、volcano 1MiB、両full-file 16MiB、wire preflightを通す。version一致時だけ一回commitし、durable callback完了後にstructured audit logとREPL successを出す。preflight／save予約失敗を成功表示しない。
- このcommandは`vfvo50Repairable`／`ashfallRepairable`をclearしない。利用可能なREST coverageとoperatorによる履歴欠損の受容を別の事実として保つ。

composition rootはcoordinatorの`VolcanoRuntimeSnapshot`を一回だけ取得し、そこから一つの`VolcanoPersistenceSnapshot`を作る。holder／gate／repairを個別exportして時点一致を後から推測しない。

```ts
interface VolcanoPersistenceSnapshot {
  state: PersistedVolcanoStateV2;
  gateEntries: PersistedTelegramRevisionGateEntryV2[];
  repairState: VolcanoRepairStateV1;
}
```

authority、gate、stateが`PersistedVolcanoStateV2`内外へ重複して必須になる形は禁止する。holder snapshotはstateだけ、coordinator snapshotはstate＋gate＋repair stateの完全envelopeと責務を分ける。persistence exportは一つの`VolcanoRuntimeSnapshot`から作り、holder／gate／repairを別々に再読しない。

### 14.2 canonical→mirror direction

一つの composition snapshot から次を生成する。

1. v2 canonical `state`
2. v2 foundation `active`
3. v2 root `volcanoes`
4. standalone v1 `volcanoes`
5. v1 seen
6. v1 alert gate metadata
7. v1 ashfall gate metadata
8. v1 repair state

foundation active と v2 root volcanoes は同じ `rollbackVolcanoes` を deep clone し、canonical sort 後の JSON 値が完全一致する。standalone v1 も同じ record 集合と意味を持つ。

v2でcanonicalなrepair stateはfoundationの`repairState`だけである。v2 rootの`volcanoRepairState`はv1 compatibility mirrorであり、foundationから生成して完全一致を検査するが、foundation stateへ逆流させない。

`StandbyStateStore.exportActiveState().volcanoes` を canonical または rollback の生成元にしない。standby mirror との不一致は assertion／diagnostic であり、standby 側を採用しない。

### 14.3 gate／slice coupling

各 active slice は同じ typed subject の一意な non-cancelled gate を必要とする。

共通:

- slice revision report time／serial と gate comparison が一致する。
- `appliedSemanticKey === gate.semanticKeys.at(-1)`。
- ashfall current source ID は composite `sourceEventIds` に含まれる。alert／eruptionにlegacyから復元不能なcurrent transport IDを要求しない。
- gate-only watermark／tombstone は slice なしで valid。
- duplicate subject は後勝ちせず全 candidate を拒否する。

alert:

- active sliceとmatching gateは同じ`sourceFamily`を持つ。
- cancelled／gate-only alertもgate側の`volcanoProvenance.kind === "alert"`を維持する。
- sourceFamily `"unknown"` gateはactive sliceを持たず、同subjectまたはdomain-scopeのunrecoverable alert omissionとcoupleする。
- sourceFamily `"operationalV2Unknown"`は§15.5で結合したactive／gate-only bundleだけに許可する。resolution IDなしなら同codeの`operationalV2ProvenanceLost` omission、resolution IDありなら同ID／codeの`operationalV2AlertResolutions` recordを必須とする。omissionとresolution recordを同時にcoupleしない。
- known family、`operationalV2Unknown`、`unknown`を比較上のhead typeへ変換しない。gateのgeneric `comparison.revision.type`はregistry family、実source provenanceは`volcanoProvenance`だけを正とする。
- slice／gateのsource family不一致は両candidateを正常扱いせず、§14.6のprovenance付きsalvageへ渡す。

eruption:

- `eventExpiresAtMs === revision.reportTimeMs + 24 hours`。checked arithmetic を使う。
- `latestEvent` の label、event time、crater、plume height／directionを deep validate する。
- `latestEventId != null` なら gate `legacyRevisionKey === "volcano:event:" + latestEventId` かつ provenance `eventId`。
- `latestEventId == null` なら live code fallback provenanceだけを許可する。
- cancellation targetへ使う EventID と `latestEventId` が一致する。
- generation 1 canonical eruption を rollback mirror で補完しない。

ashfall:

- `P+G`: active projection＋matching non-cancelled gate。
- `GA`: projectionなし＋non-cancelled gate。
- `GT`: projectionなし＋cancelled gate。
- projection `eventId`／`sourceType`はgate `volcanoProvenance.actualEventId`／`sourceType`と一致し、source typeは`comparison.variantRank`と一致する。
- GA／GTもgate内のactual EventID、source type、variant rankを保持し、projection欠落をidentity欠落とみなさない。
- revision、semantic tailが一致する。
- projection expiry 後は GA、gate expiry 後は projection も削除する。

### 14.4 deep string limits

| field | max code units |
|---|---:|
| volcano code | 32 |
| volcano name | 128 |
| EventID | 128 |
| source ID | 256 |
| subject | 96 |
| ash code | 8 |
| ash name | 64 |
| area code | 32 |
| area name | 128 |
| identity key | 192 |
| semantic key | 128 |

unknown field は canonical へ転記しない。ISO mirror が存在する legacy input は numeric epoch の `toISOString()` と一致しなければならない。

### 14.5 reader raw hard limits

fileのJSON parse、deep validation、duplicate grouping、dedupe、migrationより前に、source file全体のraw UTF-8 byteを検査する。その後、containerを展開する前に各raw array countを検査する。

```ts
STANDBY_READER_MAX_RAW_FILE_BYTES_PER_SOURCE = 16 * 1024 * 1024
VOLCANO_READER_MAX_RAW_CANONICAL_COMPOSITES = 2048
VOLCANO_READER_MAX_RAW_ROLLBACK_VOLCANOES = 2048
VOLCANO_READER_MAX_RAW_ALERT_GATES = 1024
VOLCANO_READER_MAX_RAW_ERUPTION_GATES = 1024
VOLCANO_READER_MAX_RAW_ASHFALL_GATES = 512
VOLCANO_READER_MAX_RAW_VOLCANO_GATES_TOTAL = 2560
VOLCANO_READER_MAX_RAW_ALERT_SEEN = 1024
VOLCANO_READER_MAX_RAW_ERUPTION_SEEN = 1024
VOLCANO_READER_MAX_RAW_ASHFALL_SEEN = 512
VOLCANO_READER_MAX_RAW_VOLCANO_SEEN_TOTAL = 2560
VOLCANO_READER_MAX_RAW_ALERT_GATE_METADATA = 1024
VOLCANO_READER_MAX_RAW_ASHFALL_GATE_METADATA = 512
VOLCANO_READER_MAX_RAW_GATE_METADATA_TOTAL = 1536
VOLCANO_READER_MAX_RAW_SOURCE_EVENT_IDS_PER_RECORD = 8192
```

16MiBはv2 source file全体またはstandalone v1 source file全体のbyte長であり、volcano subtreeのbyte長ではない。§13.2のnew writerも同じserializer byte定義と16MiB上限を使うため、他domainを含む正常writer出力をraw readerがbyte上限だけで拒否することはない。v2とv1は別sourceとして各16MiBを検査し、合算しない。

readerの16MiBもwriterと同じくparse前の入力資源上限であり、§13.2と同値でなければならない。writer側だけを緩めると正常writer出力がstartupでoversized扱いになり、reader側だけを緩めるとadmissionが正当なstateを拒否したまま残る。値の根拠（正当なVPWS50最大構成の実測約5.2MBに対する約3倍の余裕）は§13.2に置き、両者を同時に変更する。

特に各canonical／rollback recordのflat `sourceEventIds.length`をelement validation前に検査する。16MiBだけに依存しない。8,192はraw scan許容、canonical 4,096はwriter許容である。

- generation 1の`sourceEventIds`はtrim済みnonblank、256 code units以下、unique、code-unit辞書順を要求する。
- pre-generation inputのvalid flat IDsはunique sortしてrewriteできる。
- 4,097〜8,192件のunique IDはcanonical overflowであり、先頭4,096件へtruncateしない。§14.6のflat lineage salvageを適用する。
- 8,193件以上はelementを走査せずraw hard-limit違反とする。

- raw duplicate を collapse して上限を回避しない。
- shared gate／seen／v1 gate metadataはfamily別とvolcano totalの双方を検査する。
- foundation active、v2 root、standalone v1 を別 container として検査する。
- raw full-file byteはv2とv1を別sourceとして測る。volcano subtreeだけを再serializeした値をfull-file raw guardの代用にしない。
- input order、Map order、先頭 N 件で subset を選ばない。

### 14.6 salvage

reader は最小単位を claim してから salvage する。

- minimally valid volcano code を持つ malformed composite はその code を claim する。
- duplicate code は同 code の全 candidate を拒否する。
- malformed ashfall sliceはashfallだけを除外し、valid alert／eruptionとgateを維持し、`repairState.ashfallRepairable = true`にする。
- malformed alert slice／gateでは、deep-validなsliceまたはgateのprovenanceが一意に`VFVO50`を示す場合は`vfvo50Repairable = true`にする。`VFVO51`／`VFSVii`ならcode＋familyの`unrecoverableAlertOmissions`を追加する。provenance欠落／不一致ならunknown omissionを追加し、失われたstateにVFVO50が含まれる可能性もあるため`vfvo50Repairable = true`も立てる。VFVO50 replay後もunknown omissionは残す。
- `operationalV2Unknown` slice／gate／omission／resolution couplingが壊れている場合、known familyへ昇格させない。deep-validな内容bundleだけをunresolved operational baselineへ戻せる場合はresolution IDを除いてomissionを復元し、それ以外はalert sliceを除外して最小scopeのunknown omissionと`vfvo50Repairable`を残す。壊れたauditからoperator受容を推測しない。
- valid non-cancelled alert gateだけが残っていても、source familyがVFVO51／VFSVii／unknownならVFVO50 repair成功条件に含めない。そのgateの永久残留をrepair pendingとは呼ばず、対応するpersistent degraded omissionとして保持する。
- malformed eruption slice／gateはeruptionだけを除外し、known codeまたはdomain scopeの`unrecoverableEruptionOmissions`、bounded diagnostic、rewriteを要求する。
- malformed gateは対応sliceを除外するが、除外前にdeep-valid sliceのsource provenanceを上記omission判定へ使える。壊れたfield自体からfamilyを推測しない。
- generation 1の`repairState`欠落／malformed／duplicate omissionはcomplete stateへ既定化しない。両repairable flagをtrue、alert／eruptionをdomain-scope omissionにしたconservative stateへ置換し、backup後rewriteする。
- malformed flat source IDs は record 全体を捨てず、deep-valid sliceが明示するcurrent source IDs（本仕様ではashfall）のunique sorted unionへ縮退できる。失われた過去 lineage は diagnostic と rewrite の対象にする。
- active ashfall current source IDがflat setにない場合、暗黙 appendせず ashfall projectionを除外し、gateをGAとして維持する。
- active sliceのない orphan compositeを除外する。
- malformed一火山が正常な別火山や他 domain を消してはならない。

source file全体のraw 16MiB超過はparse前の`oversized`であり、他方がusableな場合だけそのsourceへfallbackする。oversized sourceをcanonical snapshotで置換する場合も、raw本文をparseせずstream copyする§14.6のbackup成功を先に要求する。両sourceがoversized、またはoversized＋missing／invalid／ioErrorでusable sourceがない場合は§14.7のfatal startupであり、empty runtimeやvolcano quarantineを作らない。

combined volcano subtree invalid、canonical active composite 129件、family 129 subject、volcano subtree 1MiB超過、minimum card 64KiB超過など、raw上限内の選択sourceから他domainを安全に読め、record-local salvage後もvolcano条件だけを満たせない場合に限ってvolcano domain全体をterminal quarantineする。他domainは選択sourceのnormalized snapshotとdeep equalで維持し、rewrite後の完成file全体が16MiB以内であることも要求する。parse不能なfull-file sourceに対して「他domain deep equal」を主張しない。

quarantine canonical form:

```ts
{
  authoritative: false,
  ashfallSchemaGeneration: 1,
  repairState: {
    schemaGeneration: 1,
    vfvo50Repairable: true,
    ashfallRepairable: true,
    unrecoverableAlertOmissions: [{
      scope: "domain",
      volcanoCode: null,
      sourceFamily: "unknown",
      lastKnownComparison: null,
      reason: "terminalQuarantine",
    }],
    unrecoverableEruptionOmissions: [{
      scope: "domain",
      volcanoCode: null,
      lastKnownComparison: null,
      reason: "terminalQuarantine",
    }],
    operationalV2AlertResolutions: [],
  },
  state: { generation: 1, volcanoes: [] },
  active: [],
  gateEntries: [],
}
```

v2 root／standalone v1 volcanoes、volcano seen／metadataも空にし、他domainはdeep equalで維持する。VFVO50 replayが成功してもdomain-scope alert omissionとeruption omissionを維持し、修復済みとは扱わない。

salvage／quarantine、またはusableな他方sourceへfallbackしてinvalid／oversized原文を置換するrewrite前に、対象原文backupを成功させる。sourceごとに次のstate machineを持つ。

```text
pendingBackup -> scheduledRetry -> backedUp -> rewrite -> clean
```

- loadでsalvage／quarantine、またはusableな他方へのfallback後にinvalid／oversized sourceの置換が確定した時点を`pendingBackup`とし、canonical rewriteより先に一度backupを試みる。成功時は`backedUp`へ直接進める。fatal dispositionではこのstate machineを開始しない。
- backup失敗時は元fileを一byteも置換せず`scheduledRetry`へ進む。1s、2s、4s…最大60sのbounded exponential backoffをmonotonic timerで予約し、追加電文、次のdirty mutation、wall clock変化をtriggerにしない。
- いずれかのsourceが`pendingBackup`／`scheduledRetry`の間はpair writer全体へwrite barrierを置く。通常のlive／sweep dirtyはlatest snapshotへ集約するだけで、もう一方のfileを含むrenameを開始しない。これにより通常saveがbackup前rewriteを迂回しない。
- `scheduledRetry`はtimerごとに同じsource fingerprintのbackupを再試行する。失敗はattemptを増やして同state、成功は`backedUp`である。警告はrate limitするがretry回数に上限を設けない。
- backup fileのwrite／fsyncと可能ならdirectory fsyncが完了したときだけ`backedUp`とする。その直後に、現在のlatest prevalidated runtime snapshotを使う`rewrite`へ進む。load時snapshotへ巻き戻さない。
- canonical rewrite失敗はbackup済み原文を再copyせず、同じmonotonic bounded backoff timerで`rewrite`をretryする。追加電文をtriggerにせず、rewrite成功後だけ`clean`とする。
- shutdown flushはpending backup／scheduled retryを待たずbackupを一回即時試行し、`backedUp`／`rewrite`ならcanonical rewriteも一回即時試行する。backup失敗なら元fileを残してtyped incomplete resultを返し、canonical overwriteを行わない。rewrite失敗ならbackup済み原文と未置換sourceを残してincompleteを返す。次startupは残った原文から再びworkflowを開始する。
- backup pathはsource fingerprint単位でidempotentにし、同じ原文のretryで複数backupを増殖させない。

### 14.7 writer

writerはv2とstandalone v1をmemory上で完成させ、schema、mirror coupling、count、volcano subtree 1MiB、full-file 16MiB、wire invariantを全て検証してからI/Oを始める。invalid runtime stateをtruncateしない。

二fileは独立snapshotであり、readerはfieldを相互mergeしない。外部commit manifestは設けないが、部分commitの新旧判定用に両rootへ同じlogical generationを保存する。

```ts
type PersistenceLogicalGeneration = string;

interface PersistedStandbyStateV1 {
  // legacy reader inputではabsentを許す。new writerではrequired。
  logicalGeneration?: PersistenceLogicalGeneration;
}

PERSISTENCE_LOGICAL_GENERATION_PATTERN = /^(0|[1-9]\d{0,19})$/
PERSISTENCE_LOGICAL_GENERATION_MAX = 18_446_744_073_709_551_615n
```

`PersistedStandbyStateV2`は現行どおりv1 root fieldを継承するため同じfieldを持つ。new writerはv1／v2の両payloadで必須、legacy reader inputだけoptionalである。

値はJSON decimal stringとして保存し、比較／加算は`BigInt`で行う。wall clockとは独立である。own-property absentだけをlegacy扱いし、present-invalid、leading zero、uint64超過はsource invalidとする。これはashfall projectionの`generation`、volcano schema `generation`、runtime versionとは別の全file保存世代である。

保存順:

1. valid on-disk generationとprocess内last committed／reserved generationの最大値に1を加え、当該logical snapshotのgenerationとして予約する。初回legacy saveは1とする。
2. v2 payloadとstandalone v1 payloadを同じlogical snapshotから生成し、同じ`logicalGeneration`と`savedAt`を入れる。
3. 両temp fileをwrite、flush／fsyncする。
4. standalone v1 tempを固定v1 pathへatomic renameする。
5. v2 tempを固定v2 pathへatomic renameする。
6. directory fsyncがplatformでsupportedなら行う。
7. 両rename成功時だけsave successとする。

v1 rename後にv2 renameが失敗しても、各fileは単独で旧または新の完全snapshotである。retryする同じsnapshotは同じreserved generationを使う。一方でもrename済みのgenerationを別payloadへ再利用しない。より新しいruntime mutationがpending snapshotを置換する場合は、さらに大きいgenerationを予約する。uint64上限ではI/O前にfail-loudとする。

load source selection:

- 両sourceにvalid `logicalGeneration`があれば、数値が大きいsourceを選ぶ。`savedAt`は参照しない。したがって同一millisecondのv1先rename／v2失敗とwall clock逆行でも新v1を選べる。
- valid generationが同じならnew writerの同一logical snapshotでなければならない。v2から生成したv1 mirrorとstandalone v1の意味が一致すればv2を選ぶ。不一致ならv2をdeterministicに選び、`sameGenerationConflict` diagnosticとv1 rewriteを要求する。相互mergeしない。
- 一方だけにvalid generationがあれば原則そのsourceを選ぶ。ただしmarkerless sourceが既知legacy-writer shapeで、両`savedAt`がvalidかつmarkerless sourceだけがstrictly laterの場合は、rollback binaryの後保存としてmarkerless sourceを単独選択できる。equal／older／invalid timestampではgenerated sourceを選ぶ。
- 両方markerlessのlegacy sourceだけはvalid `savedAt`のstrict orderingを使い、equalならv2を選ぶ。時計逆行を補正しない。
- 選択sourceがinvalidなら他方のvalid sourceへfallbackできる。選択したsource以外からprojection、gate、repair state、source IDを補完しない。
- source選択後の次generationは、選ばなかったfileも含む全valid on-disk generationの最大値より大きくする。

sourceごとのterminal classificationとstartup dispositionをsource選択より先に確定する。

```ts
type StandbySourceReadState =
  | "missing"
  | "valid"
  | "salvageable"
  | "oversized"
  | "invalid"
  | "ioError";

type StandbyStartupDisposition =
  | { kind: "restored"; selectedSource: "v2" | "v1" }
  | { kind: "freshEmpty"; selectedSource: "none"; reason: "bothMissing" }
  | {
      kind: "fatal";
      selectedSource: "none";
      reason: "noUsableSource";
      sourceStates: Record<"v2" | "v1", StandbySourceReadState>;
    };
```

- `missing`は`ENOENT`だけ、`oversized`はraw 16MiB超過、`invalid`はraw上限内だがJSON／root schema／logical generation等がsource-level invalid、`salvageable`は§14.6のbounded salvageから完全snapshotを構成できるsource、`ioError`はpermissionを含むread failureである。I/O errorをmissingへ変換しない。
- `ioError`が一方でもあれば、他方がusableでもsource置換の安全性を証明できないため`kind:"fatal"`とする。それ以外で少なくとも一方がvalid／salvageableなら、その集合内だけでlogical generation規則を適用して一つを選び、`kind:"restored"`とする。oversized／invalidな他方のfieldをmergeしない。
- 両方がmissingの場合だけ、全ownerのcanonical empty snapshotを`restorePrevalidated()`し`kind:"freshEmpty"`とする。missingだけを理由に即時rewriteせず、最初のdurable mutationまたは正常shutdown saveでgeneration 1を作る。
- usable sourceが一つもなく、少なくとも一方がoversized／invalid／I/O errorなら`kind:"fatal"`である。新規empty runtime、volcano quarantine、部分domain salvageへfallbackしない。`startMonitor`はowner replace、REPL、display、REST、WebSocket、timer開始より前にtyped startup errorを返し、entrypointはnon-zeroで終了する。元file、temp、backup、canonical fileを一byteも変更しない。
- usable sourceを選べた状態で他方がoversized／invalidなら、runtimeは選択sourceの全domain snapshotから復元できる。ただし他方を置換するpair rewriteはそのsourceの§14.6 backup成功後だけ許す。missingな他方はbackup不要である。
- usable source＋missing counterpartは選択sourceから正常restoreし、counterpart生成のため`canonicalRewriteRequired = true`とする。backup／write barrierは不要だが、選択source以外からfieldを補完しない。
- backup後に生成するcanonical pairは、backup開始時のsnapshotではなく、選択sourceから復元して以後のlive／sweepを反映したlatest prevalidated coordinator snapshotから作る。`other domain deep equal`の比較元は選択したusable sourceをschema migration／expiryで正規化した全domain snapshotであり、parseしていないoversized sourceではない。
- `selectedSource:"none"`だけで正常emptyとfatalを表現しない。必ず`StandbyStartupDisposition.kind`を分岐し、fatalで初期化済みempty holderを通常runtimeとして公開してはならない。

pre-I/O validation failureでは temp を作らない。write、fsync、rename failureを成功扱いにせず typed failure と pending state を monitor へ返す。

## 15. standalone v1 rollback と migration

### 15.1 new v1 fields

v1 volcano record に optional `ashfall` を追加し、root に optional metadata を追加する。

```ts
interface PersistedVolcanoAlertGateMetadataV1 {
  stateSubjectKey: string;
  sourceFamily: PersistedVolcanoAlertSourceFamily | "unknown";
  operationalV2ResolutionId?: string;
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: string[];
  cancelled: boolean;
  acceptedAtMs: number;
  tombstoneRetentionMs: number;
  legacyRevisionKey: string | null;
  legacyRevisionKeyProvenance: "eventId" | "codeFallback" | null;
}

interface PersistedVolcanoAshfallGateMetadataV1 {
  stateSubjectKey: string;
  actualEventId: string | null;
  sourceType: "VFVO54" | "VFVO55" | null;
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: string[];
  cancelled: boolean;
}

interface PersistedVolcanoStateV1 {
  // existing fields。active alertがあるnew writer recordだけrequired。
  alertSourceFamily?: PersistedVolcanoAlertSourceFamily;
  alertOperationalV2ResolutionId?: string;
}

interface PersistedStandbyStateV1 {
  logicalGeneration?: PersistenceLogicalGeneration;
  volcanoAlertGateMetadata?:
    PersistedVolcanoAlertGateMetadataV1[];
  volcanoAshfallGateMetadata?:
    PersistedVolcanoAshfallGateMetadataV1[];
  volcanoRepairState?: VolcanoRepairStateV1;
}
```

v1 `seen` keyはashfallが`volcano:ashfall:<code>`、alertが`volcano:alert:<code>`である。`forgetAtMs`は各gateのretention（ashfall 7日、alert 30日）を使うchecked arithmeticで次から作る。

```text
forgetAtMs = acceptedAtMs + familyRetentionMs + 1ms
acceptedAtMs = forgetAtMs - familyRetentionMs - 1ms
```

new writerはalert／ashfall gateごとにv1 seenと対応metadataを書き、active projectionがあればv1 volcano mirrorも書く。canonical `repairState`は`volcanoRepairState`へmirrorし、active alert mirrorにも`alertSourceFamily`とoptional `alertOperationalV2ResolutionId`を保存する。known familyではresolution fieldを出さない。flat `sourceEventIds`はcanonical compositeの配列をそのままunique sorted mirrorとする。domain別`sourceLineage`は追加しない。root `logicalGeneration`は§14.7の同じv2世代である。

### 15.2 metadata shape

own-property で先に分類する。

| raw shape | mode | legacy fallback |
|---|---|---|
| property absent | absent | 許可 |
| array | present-array | 禁止 |
| null／object／scalar | present-invalid | 禁止 |

present-invalidをabsentに変換しない。alert／ashfallの各metadata propertyを別々に分類する。minimally valid subjectを持つmalformed／duplicate metadataはそのfamilyのsubjectをclaimし、matching projection／seenをlegacy fallbackへ戻さない。

`volcanoRepairState`もown-propertyでabsent／present-object／present-invalidへ分類する。new-format v1のdeep-valid present-objectだけがrepair stateをlosslessに復元できる。absentなlegacy v1は`vfvo50Repairable = true`にして利用可能な履歴を回収し、alert provenance不明を表すdomain scope／sourceFamily `"unknown"`のunrecoverable alert omissionも追加する。ashfall flagはmetadata／projection migration結果と合わせて保守的に決める。present-invalidは`vfvo50Repairable`／`ashfallRepairable`をtrueにし、alert／eruptionのdomain-scope omissionも追加する。壊れたobjectからfallback値を推測しない。

### 15.3 valid bundle

alert metadataはsubject／revision family、`comparison.revision.type.raw／value === "volcanoAlert"`、canonical report ISO／epoch、serial、infoType、semantic keys 1〜32、acceptedAt、retention、legacy key provenanceをdeep validateする。actual head typeはcomparisonから読まずmetadata `sourceFamily`を正とする。known familyはresolution IDを禁止する。`operationalV2Unknown`はmatching active mirror／gateと、未解決omissionまたは同IDのresolution auditを要求する。`unknown`はactive mirrorを禁止する。matching v1 seenは同じrevisionを持ち、`forgetAtMs === acceptedAtMs + tombstoneRetentionMs + 1`をchecked arithmeticで満たす。new-writer metadataは最大128 subjectである。reserved legacy alert GTだけは§15.4のunknown family／synthetic type／semantic keys 0件を許す。

ashfall metadata bundleは次のとおりである。

| bundle | cancelled | identity | semantic keys | infoType |
|---|---:|---|---:|---|
| P+G／GA | false | EventID／sourceType non-null | 1〜32 | 発表／訂正 |
| normal GT | true | EventID／sourceType non-null | 1〜32 | 取消 |
| reserved legacy GT | true | 両方 null | 0 | 取消 |

mixed-null は常に invalid。reserved legacy GT は上表の全条件、rank 1、canonical cancellation comparison が完全一致する場合だけ valid とする。live inputから reserved shape を作らない。

metadataはcomparison subject／family、canonical report ISO／epoch、normalized serial、`comparison.variantRank`、actual EventID、source type、infoType raw／value、acceptedAt future-skew、matching seen revision、retentionを検証する。P+G／GA／GTのcanonical ashfall gateへ同じ値を復元し、projectionの有無をidentity sourceにしない。

### 15.4 migration rules

- deep-valid alert metadata＋unique seen＋matching active alert sliceはsource familyを含むactive bundleを復元する。gate-only metadataもwatermark／tombstoneをlosslessに復元する。
- alert metadata absent＋active alert slice＋unique seenは、sliceのknown source family、revision、applied semantic tailとseenから一意にgateを再構成できる場合だけactive bundleへ移す。
- alert metadata absent＋unique gate-only seenはsource familyとsemantic payloadを回収できないため、reserved legacy alert GTとunrecoverable alert omissionへ移す。reserved shapeは`sourceFamily:"unknown"`、`cancelled:true`、semantic keys 0件、EventID null、type `"legacyVolcanoAlert"`、infoType `"取消"`、seen由来のreport time／serial、`acceptedAtMs = forgetAtMs - alertRetentionMs - 1`が全て成立する場合だけ作る。active alertを合成せず、equal／older liveを復活させず、`vfvo50Repairable`もtrueにする。duplicate／malformed seenではreserved gateも作らない。
- metadata、unique seen、projection、flat source IDs、gate couplingが全てvalidなら P+G を復元できる。
- metadata＋seen がvalidで projection欠落／expired／malformedなら GA。
- valid cancelled metadata＋seenはGTであり projectionを復元しない。
- metadata present-arrayでsubject itemが欠落／malformedなら fallbackしない。
- metadata absent＋unique valid seen は reserved legacy GTへ移行し、active projectionを復元しない。
- metadata absent＋seenなしはashfall gateを作らない。
- duplicate／malformed seenはgroup全件をconsume／rejectし、latestや最大forgetAtを選ばない。
- flat source IDs はそのまま canonical flat lineage候補であり、domain分類を推測しない。
- v1 migrationで安全なactive ashfallまたはgate bundleを復元できなければ`repairState.ashfallRepairable = true`にする。

new-format v2→v1→v2 round-tripはalert source family／operational-v2 resolution ID／gate-only provenance、ashfall P+G／GA／GT、actual EventID、source type、variant rankを含むcomparison、semantic key order、acceptedAt、generation、projection、flat source IDs、repair stateとresolution audit、logical generation、次報gate decisionを維持する。

実v3.4.0 writerがunknown top-level metadata／repair state／logical generationを落としたoutputは`metadata absent＋seen`としてreserved GTへfail-closed migrationし、active ashfallを復元しない。alertは`vfvo50Repairable`とprovenance不明のunrecoverable omission、ashfallは`ashfallRepairable`を要求する。fixtureはpinned artifact、input、outputのSHA-256と固定実行条件を持つ。

### 15.5 old v2 migration

pre-generation v2 の `state.alerts` と identity-only `state.eruptions` は legacy input とする。

- 現行operational-v2 writerのalert shapeは、holder `state.alerts[]`が`lastInfo`を保存せず、rollback volcanoが`alertRevision`のtime／serialだけを持ち、common gateがaccept時に`comparison.revision.type.raw／value`をともにregistry identity `"volcanoAlert"`へ正規化する形である。したがってこのgeneric typeをVFVO50／VFVO51／VFSViiのhead typeとして検査または逆変換してはならない。
- operational active bundleは、同じnormalized codeについてholder alert、非cancelled gate、rollback active recordが各一件だけ存在し、holderの全alert表示fieldとrollbackのalert表示field、gate／rollbackのreport time・serial、gate semantic tail、subject、retention、source ID集合がdeep-validかつ一致する場合に「内容は一意、実source familyだけ不明」と判定する。holder alertから完全sliceを作り、revisionは一致済みgate／rollback、`appliedSemanticKey`はgate tail、`sourceFamily:"operationalV2Unknown"`、resolution IDなしとする。gateにも同tagを設定し、code-level `operationalV2ProvenanceLost` omissionと`vfvo50Repairable = true`を保存する。current transport IDやhead typeを合成しない。
- deep-validなoperational gate-only watermark／tombstoneも、subjectが一意なら`operationalV2Unknown` gateとしてcomparison、semantic keys、cancelled、acceptedAt、retentionを維持し、同code omissionを置く。active holderがあるのにrollbackまたはgateとの結合に失敗した場合はactive sliceを復元せず、得られる最小scopeのunknown omissionへ落とす。codeすら安全に列挙できない場合だけdomain-scopeへcollapseする。
- transitional pre-generation inputがgeneric comparisonとは別のdeep-valid `volcanoProvenance.kind:"alert"`とknown source familyを既に持つ場合だけ、slice／gate一致を確認してknown familyへlossless migrationできる。`comparison.revision.type`の`"volcanoAlert"`または偶然のVFVO文字列だけをknown provenanceの根拠にしない。
- operational migrationで作ったunresolved bundleは§14.1.1のoperator transaction、または同codeをstrictly newerなknown-family live inputが完全にsupersedeするまでdegradedである。VFVO50 replay、save／reload、clock経過ではomissionもtagも消さない。
- identity-only eruption は matching gate と一意なrollback eruption projectionが revision、EventID、expiry=`report+24h`、semantic keyまで一致する場合だけ完全 eruption sliceへ移行する。
- 結合成功した eruption は `legacyV1Fallback: true` とし canonical rewriteする。
- missing、duplicate、不一致ならeruption sliceを除外し、unrecoverable eruption omissionとdiagnosticを残す。別sliceへ波及させない。
- generation 1 canonical が不完全な場合は rollback で補完しない。
- old ashfall active P+Gはprojectionのactual EventID／source typeとstrict gate comparisonが一致する場合だけcanonical `volcanoProvenance`と`comparison.variantRank`を補える。
- old ashfall GA／GTはprojectionを持たないため、strict gate comparison自身のEventID／head typeがvalidな場合だけcanonical fieldへ移す。fieldを確定できないGAはgateを除外し、GTは§15.3のreserved legacy GT完全predicateを満たす場合だけreserved GTへ移し、それ以外は除外する。いずれも`ashfallRepairable = true`とし、rankやtypeをprojection不在から推測しない。
- old ashfall generation欠落は`ashfallRepairable = true`にする。

## 16. REST repair と startup

### 16.1 原則

startup repair は stateful volcano 全体を buffer しない。primary WebSocket の通常 ingress を REST より先に開始し、live input は到着時に通常 transaction と side effect を一回だけ処理する。

REST は不足 family の historical input を scratch へ無副作用 replayし、最終時点の live stateへ同期的に rebase／replaceする。

この方式により次を保証する。

- REST await 中の alert／eruption／ashfall live mutationを失わない。
- VFVO53 は通常 aggregator で動き続ける。
- live VFVO54/55 は到着時に pending VFVO53 を直ちに通知なしflushする。
- buffered side effect の再発火や failure drain は存在しない。
- local clock と REST server receivedTime の大小比較を coverage proof に使わない。

### 16.2 repair target

- `repairState.vfvo50Repairable`がtrueならVFVO50をreplayする。
- `repairState.ashfallRepairable`がtrueならVFVO54とVFVO55をreplayする。
- VFVO53 は取得しない。
- eruption replay は行わない。
- targetは独立に成功／失敗できる。VFVO50成功時は`vfvo50Repairable`だけ、ashfall成功時は`ashfallRepairable`だけをfalseにする。
- ashfall targetはVFVO54とVFVO55の両endpointでlower／upper coverageが成立した場合だけ成功とする。片方のfailureでは`ashfallRepairable`をtrueのまま維持する。

VFVO50 repairは利用可能な数値alert streamの再構築であり、VFVO51／VFSVii／provenance不明alert／eruptionの全履歴を証明したとは扱わない。成功後も`unrecoverableAlertOmissions`と`unrecoverableEruptionOmissions`をbyte-for-byte維持し、old-reader `authoritative`を残存alert omissionから再導出する。

### 16.3 normal ingress repair journal

subscription acknowledgement 後、repair target typeだけについて bounded journal を記録する。

```ts
interface VolcanoRepairJournalItem {
  itemId: string;
  receivedTimeMs: number;
  sequence: number;
  encodedByteLength: number;
  normalizedInput: NormalizedVolcanoInput;
}

VOLCANO_REPAIR_JOURNAL_MAX_ITEMS = 512
VOLCANO_REPAIR_JOURNAL_MAX_BYTES = 4 * 1024 * 1024
```

journal はrepair targetの再構築と順序証明だけに使う。全stateful volcanoのholdback bufferではなく、input本体は到着時に通常ingressで処理し、notification／CLI／ticker／displayもその場で一回だけ発火する。journal replayではside effectを再発火しない。

`encodedByteLength`はitem ID、clock、sequence、normalized inputを含むjournal recordのcanonical JSONをUTF-8で測る。prospective count／byteに対してinclusive limitを判定する。

- 512件／4MiBちょうどは許可する。
- 513件目／4MiB+1で当該 repair proofを失敗させるが live inputを捨てない。
- disconnect、reconnect、subscription generation変更、target parse failureでproofを失敗させる。
- proof failure後も通常 ingressを継続する。

### 16.4 pagination と lower coverage

VFVO50、VFVO54、VFVO55 を別 query とし、各 page で `type`、`limit=100`、`formatMode=raw`、`xmlReport=true` を維持し、opaque `nextToken` を次 request の `cursorToken`へ渡す。

一覧応答は本文を含まない。revision／identity は `xmlReport.head` から構築する。`xmlReport=true` が無い場合は `reportDateTime`／`serial`／`infoType`／`eventId` が全て空になり identity 構築が必ず失敗するため、repair の list query は既定に頼らず毎回 `xmlReport=true` を明示する。実応答では `serial` が null の family（VFVO50）があり、`control.dateTime` は Z 表記、`head.reportDateTime` は +09:00 表記で届く。表記差を吸収するため revision 比較は epoch へ正規化した値で行う。

familyごとに checked arithmetic で lower boundary を定義する。

```ts
coverageStartMs = startupNowMs - familyRetentionMs;
```

- ashfall は7日、VFVO50 alert は既存 alert retentionを使う。
- underflow／invalid epochなら coverage failure。
- `receivedTimeMs === coverageStartMs` は replay対象。
- oldestが境界ちょうどで continuationがあれば次pageも取る。
- `receivedTimeMs < coverageStartMs` のitemは coverage sentinel にできるが scratchへ適用しない。
- terminal page 到達でも lower coverageは成立する。
- empty terminal first pageはcomplete empty。
- empty page＋nextTokenは追跡継続。
- page内／page間の newest-first を検証する。

inclusive limits:

- 128 pageでterminalなら成功、129 page目が必要なら失敗。
- type当たり12,800 relevant itemまで成功、12,801件目が必要なら失敗。
- Telegram Data 取得失敗（権限欠如、404、非 XML content-type、サイズ上限超過、network）、blank／repeated token、loop、endpoint error、strict receivedTime／revision／identity構築失敗はfailure。一覧 item に本文 field が無いこと自体は failure ではない（実 API の正常形である）。
- 同じtype queryの全historical pageを一つの`HistoricalPaginationUnion(type)`とし、そのunion内で同じitem IDが二回現れた場合は、同一page内／page間を問わずduplicate failureとする。

### 16.4.1 本文取得

一覧は本文を持たないため、replay に要る本文は Telegram Data v1 から別途取得する。

- **endpoint**: `https://data.api.dmdata.jp/v1/<id>`。一覧と同じ Basic 認証を使う。`Accept` は XML、`Accept-Encoding` は `identity` を明示する。
- **URL の組み立て**: id は一覧 item の `id` から自前で組む。item に `url` がある場合は組んだ URL と一致することを検証し、不一致なら取得失敗として扱う。外部応答の文字列をそのまま fetch 先にしない。
- **応答形**: 成功は HTTP 200／`application/xml`／生 XML（gzip なし）。404 は HTTP 404／`text/plain`／本文 `404 Not Found` で返り、JSON エラー形式ではない。したがって失敗判定は status code と content-type だけで行い、本文の形に依存させない。
- **取得対象**: coverage 窓内（relevant）の historical item のうち repair journal に無いものだけ。journal にある item は journal 側の normalized input を replay に使うので取得しない。head sample では一件も取得しない。
- **キャッシュ**: 同一 id は repair 1 回につき最大 1 リクエストとする。成功・失敗のいずれもキャッシュし、失敗した id を再取得しない。キャッシュは repair 呼び出し 1 回にスコープし、process 寿命に載せない。公式指針の「同じ id へ短期間に繰り返しリクエストしない」への対応である。
- **取得順**: 逐次とし、並列化しない。
- **上限**: 1 repair あたり 256 件、1 本文 4 MiB。inclusive 判定とし、超過は failure。
- **位置**: historical pagination 完了直後、head 安定ループ（ordinal 2 以降）の開始前に行う。取得の前後で transport（subscription generation）を再検証し、await 中の generation 変化を見逃さない。§16.5 手順 7 の「final scratch plan から同期 commit まで await を挟まない」は本文取得を pagination 側へ置くことで維持する。
- **失敗の扱い**: target 単位 fail-closed とする。reason は `forbidden`／`notFound`／`contentType`／`tooLarge`／`network`／`fetchLimitExceeded` を短い識別子として repair journal の failure reason に載せる。
- **権限欠如**: `telegram.data` 権限が無い契約では 403 が返る。この場合も target 単位 fail-closed であり、runtime state と repairable flag を変更しない。403 の failure reason は権限欠如の可能性を名指しする。

### 16.5 upper coverage

local／remote clockの比較ではなく、subscription generation と transport ID overlap で証明する。

1. normal WS subscription acknowledgement を first REST request より先に得る。
2. first REST head fingerprintを保持する。
3. historical pagination中、同じsubscription generationを維持する。
4. pagination後にheadを再取得する。
5. headに新しく現れた relevant item IDは全てjournalに存在しなければならない。
6. 最大4回のhead取得内で連続二回のfingerprint一致を得る。
7. final scratch planから同期commitまでawaitを挟まない。

4回目で安定すれば成功、5回目が必要ならfailure。REST `receivedTimeMs` と local subscription時刻を比較しないため、host clock skewでitemを取りこぼす分岐はない。

head **sample** fingerprint はrelevant itemの`[itemId, receivedTimeMs]`をitem IDのcode-unit辞書順へcanonicalizeした配列のhashとする。body内容やREST配列順をfingerprintの順序根拠にしない。これは head 応答が安定したことの判定に使う値である。

item head fingerprint はこれとは別の値であり、item 一件の identity を表す。`[headType, reportDateTime.epochMs, serial.raw, infoType.raw, eventId.raw]` の hash とし、cross-set 整合の照合軸とする。REST 側は `xmlReport.head` から、WS journal 側は parse 済み meta から同じ関数で作る。`reportDateTime` は Z 表記と +09:00 表記が混在するため raw 文字列ではなく epoch で比較する。両者は名前が紛らわしいので、実装では head sample 側と item 側を別名で表す。

duplicate判定のproof集合は次へ限定する。

- 一回のhead responseを`HeadSample(type, ordinal)`という独立集合とする。同じitem IDが単一sample内に二回現れた場合だけ、そのhead sampleのduplicate failureである。
- 別ordinalのhead sample間で同じitem IDが再出現することは安定性proofの前提であり、duplicateではない。
- `HistoricalPaginationUnion(type)`は§16.4の全pageを跨ぐ一集合であり、その内部の重複だけをhistorical duplicate failureとする。
- head sample、historical union、WS journalという異なるproof集合間の同一ID overlapはupper coverage／dedupeに必要であり、duplicateではない。同じIDの`receivedTimeMs`／head type／item head fingerprint／取得できる場合のbody fingerprintが集合間で食い違う場合はduplicateではなくtransport inconsistency failureとする。item head fingerprint は両側で必ず作れる主照合軸であり、body fingerprint は両側に本文があるときだけ照合する任意軸とする。
- journal内の同一ID再送はnormal ingressのduplicate規則で一度だけ処理し、proofでは最初のmatching sequenceを使う。identical再送そのものをREST duplicate failureへ読み替えない。

### 16.6 replay order と同時刻群

REST／WS dedupeより前の relevant REST union を `receivedTimeMs` ごとにgroup化する。

- groupが一件なら receivedTime昇順でreplayする。
- 同じreceivedTimeのgroupが複数件なら、groupの全item IDがjournalに存在する場合だけjournal sequence順を使う。
- 一部だけjournalにあるgroup、または一件もない複数groupはcoverage failure。
- group ordering proofの後に、既にnormal live ingressで適用済みのitem IDをREST scratch side effect対象からdedupeする。
- REST item IDをreport time、serial、variantのtie-breakに使わない。
- replay orderはgate comparatorのunorderedを上書きしない。missing serialとnumeric serialをreceivedTime順によってnewer／olderへ変換しない。
- duplicate failureの範囲は§16.4のhistorical union内と§16.5の単一head sample内だけである。集合間overlapはordering／dedupe入力として保持する。
- unequal receivedTimeではreceivedTime順をREST IDより優先する。

これにより「historical一件＋live一件」にdedupeして曖昧な同時刻groupを単一扱いすることを禁止する。

### 16.7 scratch rebase と commit

REST collection完了後、awaitなしの同期区間で次を行う。

1. current `VolcanoRuntimeSnapshot`、derived standby snapshot、全domain persistence composition snapshotを各versionとともに取得する。
2. holder、gate、repairを含むcurrent runtime snapshotをscratch cloneする。
3. ashfall両endpointのfull coverage成立時は、baselineのashfall sliceとashfall gateをscratch内だけで全件除き、baseline flat source IDsをcode別のscratch候補へ退避する。alert／eruptionとruntime実stateは変更しない。
4. ordering済みhistorical itemを三時計付きで通常と同じ transaction reducerへ適用する。subject／volcanoCode は `xmlReport.head` に無く本文からしか取れないため、その抽出と検査は§16.4.1 の本文取得後のこの commit 段で行う。抽出不能な item は proof failure ではなく target replay rejection として扱い、target 単位で fail-closed する。repairable flag は消さない。
5. REST集合にないjournal inputをsequence順で同じscratch reducerへ適用する。REST／journal同一item IDは一度だけ適用する。
6. final compositeが存続するcodeだけ、手順3のbaseline flat source IDsと再構築中のsource IDsをunique sortしてmergeする。H0／GA／GTだけならrecordを新設せず候補を捨てる。
7. VFVO50 repairはcurrent safe baselineへRESTをrebaseする。alert sliceだけが欠け、matching non-cancelled gateのprovenanceが`sourceFamily:"VFVO50"`の場合に限り、subject、revision、semantic key、payloadが完全一致するREST itemからsliceを再構成する。VFVO51／VFSVii／unknown gateをこの分岐で再構成または成功判定しない。このrepair-only分岐はgate、acceptedAt、TTL、semantic historyを更新せず、通常live duplicate規則には開放しない。
8. target外slice、gate、source IDs、全unrecoverable omissionと、REST開始後に通常ingressで成立したnewer target stateをscratchで維持する。
9. full coverageと必要なrepair-only reconstructionを満たしたtargetだけ、scratch内の対応する`vfvo50Repairable`／`ashfallRepairable`をfalseにする。unrecoverable omission arrayは変更しない。
10. scratchと手順1の他domain snapshotからcompleted v2、v1、両full-file 16MiB、wire、global snapshotを通常liveと同じpreflightへ通す。
11. volcano runtime versionと全domain composition versionの双方が一致するときだけ、holder、gate、repairを含む完成`VolcanoRuntimeSnapshot`へ同期replaceし、その結果からstandbyをreplaceしてcomposition versionを一回増やす。
12. REST historical／journal replayのnotification、CLI、ticker、stats、sound、display eventはゼロ。

preflightまたはversion check failureではruntimeを変更せずrepair stateを維持する。live inputは既に通常処理済みなのでdrainや再発火を行わない。

complete empty coverageもgeneration 1 empty stateと対応するrepairable flagのclearとしてcommitできる。ただしcomplete empty VFVO50 coverageはVFVO51／VFSVii／unknown alert omissionを消さず、complete empty ashfall coverageはalert／eruption omissionを消さない。

### 16.8 startup order と保存予約

`startupNowMs` を一度だけ取得する。

1. v2／v1 sourceを独立validateし、§14.7で一つ選ぶ。
2. dispositionがfatalならtyped errorを返し、以降を一つも実行しない。freshEmptyはcanonical all-owner empty snapshot、restoredは選択sourceだけから全domain snapshotを作る。
3. migrate／sanitize／claim／coupleし、logical generationとrepair stateを確定する。
4. gate、全holder、repair、standbyを`StandbyPersistenceDomainSnapshots`として構築し、coordinator `restorePrevalidated()`で一回restoreする。
5. holder eruption／ashfall expiry、gate retention、flood、briefingを含む`sweepAll(startupNowMs)`を一transactionで行う。
6. holderからstandby volcano projectionを含む全derived mirrorがcandidate内で一致することを確認する。
7. salvage、backup workflow、rewrite、repair targetを確定する。backup failure retry timerは後続電文なしでもここから独立に動く。
8. runtime durable listenerを保存予約だけ抑止する。
9. primary normal WebSocket subscriptionを開始する。
10. derived repair targetが空なら、degraded omissionが残っていても利用可能なRESTは呼ばず通常startupを継続する。
11. repair targetがあればtarget journalを開始しRESTを実行する。
12. targetごとにcoverage、scratch rebase、sync commitを行う。
13. startup中のnormal live durable mutationをdirty flagへ集約する。
14. restore、sweep、salvage、repair、mirror rewrite、live dirtyのORを一つ計算する。
15. trueなら persistence `schedule()`を一回だけ呼ぶ。
16. runtime durable listenerの通常scheduleを有効にする。
17. backup connectionはprimary repair終了後に開始する。

VFVO53 notification／display side effectは保存listener抑止中も通常どおりである。抑止するのは persistence schedule の重複だけである。

## 17. restore result と diagnostics

```ts
interface StandbyReadyRestoreResult {
  startup:
    | { kind: "restored"; selectedSource: "v2" | "v1" }
    | { kind: "freshEmpty"; selectedSource: "none"; reason: "bothMissing" };
  sourceStates: Record<"v2" | "v1", StandbySourceReadState>;
  canonicalRewriteRequired: boolean;
  repairState: VolcanoRepairStateV1;
  repairTargets: VolcanoRepairTarget[];
  salvagedCodes: string[];
  volcanoDomainQuarantined: boolean;
  selectedLogicalGeneration: string | null;
  backupStates: Partial<Record<
    "v2" | "v1",
    "clean" | "pendingBackup" | "scheduledRetry" | "backedUp" | "rewrite"
  >>;
}

interface StandbyFatalRestoreResult {
  startup: {
    kind: "fatal";
    selectedSource: "none";
    reason: "noUsableSource";
  };
  sourceStates: Record<"v2" | "v1", StandbySourceReadState>;
  canonicalRewriteRequired: false;
  backupStates: {};
}

type StandbyRestoreResult =
  | StandbyReadyRestoreResult
  | StandbyFatalRestoreResult;
```

fatal resultはempty `repairState`、repair target、quarantine snapshotを捏造しない。呼び出し側は`startup.kind`でnarrowしてからready-only fieldへ触る。

rewrite required:

- old generation migration
- generation 1 `state:null`
- expired slice／gate除外
- malformed／duplicate subject salvage
- v1 seen／metadata migration
- reserved legacy GT生成
- canonical sort／mirror不一致
- flat source lineage縮退
- terminal quarantine
- v1 source選択
- logical generation absent migration／same-generation conflict
- repair成功でrepairable flag変更
- omission追加／live supersessionによるknown omission解消
- operational-v2 provenance migrationまたはoperator resolution

diagnosticは reason、typed family、code／subjectのbounded representation、raw／canonical count、byte、startup disposition、selected sourceを記録する。fatalは各sourceのclassificationとbyte countだけを出し、長い EventID／source ID、raw bodyは記録しない。

## 18. 対象ファイル

実装時に変更し得る production file は次である。

| file | 変更内容 |
|---|---|
| `src/types.ts` | admission clocks、comparison variant、ashfall DTO、repair envelope |
| `src/dmdata/rest-client.ts` | cursor pagination、head refetch、query維持、`xmlReport=true`、Telegram Data v1 本文取得 |
| `src/dmdata/connection-manager.ts` | subscription acknowledgement／generationの公開 |
| `src/dmdata/ws-client.ts` | repair journal用transport identity／normalized input |
| `src/dmdata/multi-connection-manager.ts` | primary repair中のbackup開始順 |
| `src/engine/startup/telegram-adapter.ts` | REST receivedTimeとstartup clock分離、REST 生 XML の WsDataMessage 化 |
| `src/dmdata/telegram-meta.ts` | serial normalization helper |
| `src/engine/messages/revision-family-registry.ts` | VFVO53分離、VFVO54/55 durable family、128上限 |
| `src/engine/messages/telegram-revision-gate.ts` | clone／version／semantic key32上限、volcano provenance |
| `src/engine/messages/tsunami-state.ts` | transaction用clone／version／prevalidated replace |
| `src/engine/messages/vpws50-state.ts` | transaction用clone／version／prevalidated replace |
| `src/engine/messages/vpww56-state.ts` | transaction用clone／version／prevalidated replace |
| `src/engine/messages/flood-forecast-state.ts` | transaction用clone／version／prevalidated replace |
| `src/engine/messages/flood-forecast-lifecycle.ts` | sweepを全domain candidateへ接続 |
| `src/engine/messages/volcano-ashfall-projector.ts` | compact projector |
| `src/engine/messages/volcano-state.ts` | complete composite owner、source family、clone／replace／sweep |
| `src/engine/messages/volcano-route-handler.ts` | common transaction、pre-mutation presentation plan、VFVO53 interrupt |
| `src/engine/messages/message-router.ts` | durable presentation candidateをside effect前にcommit |
| `src/engine/presentation/processors/process-message.ts` | standby family candidateのdispatch |
| `src/engine/presentation/processors/process-standby-foundation.ts` | direct gate commitをscratch planへ置換 |
| `src/engine/presentation/processors/process-tsunami.ts` | gate＋holderのatomic candidate |
| `src/engine/presentation/processors/process-weather.ts` | gate＋weather holder＋standbyのatomic candidate |
| `src/engine/presentation/processors/process-flood-forecast.ts` | gate＋diff holder＋standbyのatomic candidate |
| `src/engine/presentation/types.ts` | ashfall accepted outcome |
| `src/engine/presentation/events/from-volcano.ts` | internal field copy |
| `src/engine/display/project-standby.ts` | ashfall update、VFVO53除外 |
| `src/engine/display/standby-state-store.ts` | full snapshot／prevalidated replace、derived ashfall、briefingCritical、restore、sweep |
| `src/engine/display/standby-persistence-admission.ts` | 全owner version token、candidate reducer、16MiB prospective admission |
| `src/engine/monitor/display-sink.ts` | durable post-commit mutationを除去し、hub side effectだけにする |
| `src/engine/display/volcano-card-projection.ts` | tone、wire fixpoint、JST label |
| `src/engine/display/protocol.ts` | ashfall DTO、tone、omitted count |
| `src/engine/display/constants.ts` | wire limits |
| `src/engine/display/standby-persistence.ts` | generation 1、logical generation、v1 rollback、16MiB full-file reader／writer、backup retry |
| `src/engine/startup/tsunami-initializer.ts` | REST restoreをcoordinator candidateへ接続 |
| `src/engine/startup/volcano-initializer.ts` | REST coverage、repair journal、scratch rebase |
| `src/engine/monitor/monitor.ts` | coordinator wiring、fatal startup、versioned repair state、backup timer／shutdown retry、save aggregation |
| `src/ui/repl.ts`、`src/ui/repl-handlers/types.ts` | volcano repair administrationをcontextへ注入 |
| `src/ui/repl-handlers/command-definitions.ts`、`operation-handlers.ts` | `volcanorepair` status／resolution command |
| `display/frontend/src/lib/protocol.ts` | engine protocol copy |
| `display/frontend/src/components/VolcanoCard.svelte` | ashfall body、tone、pager |
| `display/frontend/src/components/StandbyScreen.svelte` | measurement／page coordinator |
| `display/frontend/src/lib/legacy-standby/time-slice-scheduler.svelte.ts` | existing volcano page registration |
| `docs/display-reference.md` | display contract |
| `.claude/rules/message-pipeline.md` | VFVO53 non-durable、VFVO54/55 durableへ更新 |

主な test／fixture は全て実在する `test/**` または frontend test tree に置く。

| file | 観点 |
|---|---|
| `test/dmdata/volcano-parser.test.ts` | real fixture parser |
| `test/dmdata/rest-client.test.ts` | cursor、head、limits |
| `test/dmdata/ws-client.test.ts` | acknowledgement、generation、repair journal |
| `test/engine/telegram-foundation/phase3a-revision-gate.test.ts` | family、semantic keys、clone／version |
| `test/engine/telegram-foundation/phase3b-volcano.test.ts` | common transaction、VFVO51 atomicity |
| `test/engine/telegram-foundation/phase3b-tsunami.test.ts` | VTSE41／51／52 gate＋holder atomicity |
| `test/engine/telegram-foundation/phase3b-vpws50-router.test.ts` | VPWS50／地域報 transaction |
| `test/engine/telegram-foundation/phase3b-vpww56.test.ts` | VPWW56 transaction |
| `test/engine/telegram-foundation/phase3b-flood.test.ts` | flood gate＋holder＋standby transaction |
| `test/engine/telegram-foundation/phase3b-standby-domains.test.ts` | tornado／heat／typhoon／Nankai／long-period transaction |
| `test/engine/telegram-foundation/phase6b-legacy-counterpart.test.ts` | VPNO50 weather clearとbriefing late reconcileのtransaction |
| `test/engine/presentation/processors/process-tsunami.test.ts` | 現行mutation入口のscratch接続 |
| `test/engine/presentation/processors/process-weather.test.ts` | weather holder／projectionのscratch接続 |
| `test/engine/presentation/processors/process-flood-forecast.test.ts` | flood holder／projectionのscratch接続 |
| `test/engine/volcano-route-handler.test.ts` | VFVO53／54／55 routing／interrupt |
| `test/engine/volcano-route-handler-batch.test.ts` | VFVO53 batch回帰 |
| `test/engine/messages/volcano-state-edgecase.test.ts` | holder、slice independence、expiry、capacity |
| `test/engine/display/standby-state-store.test.ts` | derived reducer、restore、snapshot |
| `test/engine/display/standby-persistence.test.ts` | v1/v2、operational alert migration、source terminal、salvage、writer failure |
| `test/engine/display/standby-wiring.test.ts` | all-owner coordinator、startup／sweep／save aggregation |
| `test/engine/volcano-initializer.test.ts` | REST coverage、same-time、live rebase |
| `test/engine/tsunami-initializer.test.ts` | startup REST candidate／live rebase |
| `test/engine/display/http-server.test.ts` | maximum snapshot |
| `test/ui/repl-handlers/command-definitions.test.ts` | `volcanorepair` command公開 |
| `test/ui/repl.test.ts` | fingerprint／action／監査／reject表示 |
| `display/frontend/src/components/__tests__/volcano-card.test.ts` | tone、ARIA、pager |
| `display/frontend/src/components/__tests__/standby.test.ts` | measurement、geometry、rotation |
| `display/frontend/src/lib/legacy-standby/__tests__/solver.test.ts` | candidate数回帰 |

新規 fixture:

```text
test/fixtures/standby-persistence/
  operational-v1.json
  operational-v2.json
  operational-v2-active-alert.json
  operational-expectations.json
  volcano-capacity-expectations.json
  standby-all-domain-capacity-expectations.json
  v3.4.0-writer-input.json
  v3.4.0-writer-output.json
  v3.4.0-writer-provenance.json
```

実 VFVO54/55 XML fixture は変更しない。

## 19. 必須テスト

### 19.1 real fixture

VFVO54:

- type VFVO54、subKind rapid、code／EventID `506`、serial `1`
- report 2021-05-14 12:40 JST
- period一件、start 12:31、end 13:31 JST
- group 72／71／75
- 鹿児島市が ash と ballistic に独立出現
- label `降灰速報`、tone warning

VFVO55:

- type VFVO55、subKind detailed、code／EventID `506`、serial `1`
- report 12:51 JST、period六件、end 19:00 JST
- overlap／containment、天草市を含む集約、top3／omitted
- label `降灰予報（詳細）`、tone muted

54→55 replay の最終 projection は55一件だけとする。

### 19.2 projector boundaries

parameterized test:

- periods 0／24／25
- area per period 256／257
- total occurrence 2,048／2,049
- start==end、start>end
- duration／span 48hと+1ms
- report−6hと−1ms、report+48hと+1ms
- invalid ISO、timezone欠落、UTC/JST same epoch
- gap、overlap、containment、exact duplicate、same-time different payload
- code-less name、empty identity、same code different name、same name different code
- NFC、trim、whitespace normalization
- known wrong label、unknown stable/conflict
- duplicate occurrence、70→73 worst、ash＋75
- group 8／9、top3、omitted counts
- input順反転で同じprojection
- persisted `topAreas` と定数名の一致
- represented lower bound 2,048／2,049

### 19.3 lifecycle／clock

- H0→H54／H55、54→55、older54 reject、newer54 replacement
- same report／serial variant rank
- P+G／GA／GTでgateのactual EventID、source type、`comparison.variantRank`を保持し、54=0／55=1の不一致を拒否
- same／different EventIDのnewer／equal／older／unordered
- expired／nonProjectable new lifecycle
- serial `01`／`1`、missing／numeric unordered、invalid whitespace
- duplicate、correction A→B、B replay
- semantic keys 31→32成功、33拒否、strictly newer reset、save/reload後も復活なし
- generation continuous +1、GA／GT後1、save/reload後も1
- acceptedAt／classificationNow／expiryNowを別値で検証
- endsAt−1 active、endsAt expired
- report future-skew、acceptedAt future-skewの境界／+1ms

### 19.4 cancellation／cross product

- code＋EventID、code missing unique reverse lookup、zero／multiple、mismatch
- older／unordered／equal／newer cancellation
- repeated cancellationでTTL／source IDs不変
- H0→GT、compositeなしでrecordなし
- alert／eruption併存時のcancellation ID累積
- natural expiry→GA、retention boundary、manual sweepなしinput
- `A0/A1 × E0/E1 × H0/H54/H55/GA/GT × active/expired/nonProjectable/cancellation` の80ケース
- 各caseで他二slice deep equal、gate／repair state／generation／source IDs／callbackを静的期待値と比較
- eruption expiryでholder→standby→saveの順に削除し、次exportで再出現しない

### 19.5 capacity／transaction

- 各family 127→128成功、128→129拒否
- same128 codeに三familyを重ね active composite128
- 129番目 composite拒否
- gate-only GA／GTはcompositeを増やさない
- flat source IDs 4,096成功、4,097拒否
- existing updateでもv2／v1 volcano subtree、v2／v1 full-file、wire byte超過拒否
- VFVO51一subject failureで全subject rollback
- preflight failureでruntime gate／holder／repair／standby／generation／source IDs／callback／file不変
- candidate rejectionでもadmission前expiry dirtyを維持
- v2／v1 volcano subtree 1MiB exact／+1
- 全domain完成v2／v1 file 16MiB exact／+1。16MiB+1 candidateは発生domainを問わずruntime mutation前に拒否
- full-file preflightはlogical generation 9→10／最大20桁でもwriter実byte以上となる
- 16MiBを超えるdense tsunami candidate＋small volcanoを拒否し、16MiB以内のlarge other-domain＋最大許容volcanoをsave／reload。約4.85MBのdense tsunami candidateはadmissible側として通ることを確認する
- VPWS50の正当な最大shape（history 8×全国areas約1,080件、partialHistory 128×8、partialStreams 128）を含むmax-admissible fixtureがadmissionを通り、save→reloadで全record保持される
- VPWS50、VPWW56、VTSE41、VTSE51、VTSE52、volcano三family、flood、tornado、heat、typhoon、Nankai、long-period、briefingCritical、quakeHostの各実processor入口で16MiB+1を作り、gate／全holder／standby／callbackがdeep equalのまま拒否される
- `briefingCritical` active＋cancellation合計128、watermark 512、raw alias 512をall-domain maximum fixtureへ含め、count内byte超過とbyte内count超過を別々に検証する
- `all-domains-count-maximum`は16MiB超過ならatomic reject、`all-domains-max-admissible`はv2／v1 save→reload後に全owner意味一致とし、超過fixtureをtruncateして成功fixtureへ変えない
- completed card 64KiB exact／+1
- count内byte超過、byte内count超過
- maximum 128 volcano fixtureと全domain count-maximum fixtureのexact byteを固定し、16MiB以内fixtureだけsave→reload全件保持、超過fixtureはatomic reject
- pre-mutation snapshotから`trackedBefore`／`renotificationBefore`／presentationを固定し、commit後stateで再評価しない
- commit→durable callback→notifier／CLI／ticker／displayの順をspyで検証し、各fallible side effect throwでもdirty flagを保持

### 19.6 persistence／reader

- generation 1 active rapid／detailed P+G、GA、normal GT、legacy GT
- alert＋eruption＋ashfall、ashfall-only、complete empty、gate-only
- full eruption save/reload: latestEvent、EventID、revision、semantic、expiry exact report+24h
- eruption gate provenance／EventID mismatch拒否
- VFVO50／VFVO51／VFSVii alert sliceとgateのsource family一致、mismatch拒否、save／reload維持
- current operational-v2 active alertはgeneric gate type `volcanoAlert`、holderの`lastInfo`欠落、rollbackのtime／serial-onlyという実shapeから内容を維持し、`operationalV2Unknown` slice＋gate、code-level omission、`vfvo50Repairable:true`へ移行する
- operational-v2 holder／gate／rollbackのunique結合成功、duplicate、field mismatch、gate-only、cancelled、code不能domain collapseを固定fixtureで検証し、generic comparison typeからVFVO50／51／VFSViiを推測しない
- unresolved operational-v2 bundleはVFVO50 full coverage後もomissionが残る。strictly newer known-family live inputは同codeだけをsupersedeしてomissionを消し、equal／older／REST replayは消さない
- `volcanorepair status`、accept、clear、acknowledge-domainを検証する。stale fingerprint／version／scope不一致／16MiB rejectionではruntime、omission、audit、file、success出力が不変である
- acceptはactiveを維持、clearはalert sliceを除いてgate-only watermarkを維持、domain acknowledgeはcontentを合成しない。各成功はresolution auditをv2／v1へ保存し、reload後もID／reason／actor／actionが一致する
- old identity-only eruption migration success／missing／duplicate／mismatch
- malformed nested ashfall、group、area、identity、count、revision
- duplicate code／subjectを後勝ちにしない
- ashfall corruptionがalert／eruption／他domainを消さない
- VFVO50 alert corruptionは`vfvo50Repairable`だけを立て、full VFVO50 coverageでだけfalseに戻す
- VFVO51／VFSVii alert slice corruption＋valid gateはfamily付きunrecoverable omission、slice＋gate corruptionはunknown omissionとなり、VFVO50 coverage後も残って`authoritative:false`
- eruption corruptionはpersistent unrecoverable omissionとなり、save／reload／RESTで消えず、同codeのstrictly newer live stateだけで解消
- repair state欠落／malformedをcompleteへ既定化せずdomain-scope alert／eruption degradedへsalvage
- sourceEventIds raw 8,192／8,193をdeep validation前に判定
- canonical source IDs 4,096／4,097
- raw container limitsとfull-file raw 16MiB exact／+1。writerの16MiB exact outputをreaderが受理
- v1 oversized×v2 oversizedはfatal、v1 oversized×v2 validはv2を選択してoversized v1 backup後にlatest snapshotからpair rewrite、v1 oversized×v2 missingはfatalとする
- 対称なv2 oversized×v1 valid／oversized／missing、oversized×invalid、両missingも検証する。両missingだけfreshEmpty、usable sourceなしは全てstartup abortでowner／REPL／REST／WS／temp／backup／canonical writeなしとする
- 一方でもioErrorなら他方がvalidでもstartup abortし、permission failureをmissingまたはbackup retryへ読み替えない
- valid fallback＋oversized sourceでは、復元した全domainが選択sourceのnormalized snapshotと一致し、backup待ちlive mutationを含むlatest snapshotがrewriteされる。parseしていないoversized側との`other domain deep equal`をassertしない
- record-local salvage後の全体preflight
- terminal quarantine、他domain deep equal、VFVO50 success後もunknown alert／eruption degraded維持
- backup初回failureで元file不変、後続電文なしのtimer retryでbackup→rewrite成功
- scheduledRetry中のlive dirtyでpair writerがbarrierを迂回せず、成功後latest snapshotを保存
- backup／rewrite連続failureの1/2/4/…/60s backoff、shutdown最終retry成功／失敗、次startup再開、backup idempotence
- normal new writer v2／v1意味一致
- logical generationのv1 newer／v2 newer／equal mirror一致／equal conflict、uint64境界／overflow
- 同一`savedAt`のv1先rename→v2 failureで新v1選択、wall clock逆行でもgeneration優先
- generation片側absentのknown legacy writer、両側absentのsavedAt fallback、present-invalid generation拒否
- v1 rename後v2 failure、v2 missing／invalid fallback、pending retryでgeneration再利用なし
- pre-I/O validation failureでtempなし
- writer outputをreaderが自己拒否しない

### 19.7 v1 migration

- metadata absent／array／invalid own-property classification
- repair state absent／object／invalid own-property classification
- present-invalidでfallback禁止
- malformed／duplicate metadataがsubjectをclaim
- unique／duplicate／malformed seen
- P+G／GA／GT lifecycle matrixとmixed-null拒否
- reserved legacy GT完全predicate
- alert metadata absent＋unique seenのreserved legacy alert GT完全predicate、duplicate／malformed拒否
- acceptedAt=`forgetAt-retention-1`
- new-format v2→v1→v2でnext decision一致
- new-format v2→v1→v2でrepair state／logical generation一致
- old v2 active P+Gはstrict projection＋gateからcanonical provenanceを移行
- current operational-v2 alertはholder＋generic gate＋rollbackをunique結合して`operationalV2Unknown` baselineへ移行し、explicit gate provenanceがあるtransitional inputだけknown familyへ移行する
- old v2 GA／GTはgate自身からactual EventID／source type／rankを確定できる場合だけ通常bundle、不能GAは除外、不能GTは完全predicate時だけreserved GT
- old v3.4.0 writer outputはactive復元せずreserved GT＋VFVO50 repairable＋unknown alert omission＋ashfall repair
- flat source IDsをそのまま移行しdomain分類しない

### 19.8 REST／startup

- repair targetなしでRESTなし
- startup restoreはgate／standby／VPWS50／VPWW56／tsunami／volcano＋repair／floodの全ownerを一回の`restorePrevalidated()`で公開し、途中のholderだけをobserverが読めない
- startup／60秒sweepは全owner candidateを一つのfull-file preflightへ通し、briefingCriticalとfloodの同時expiryでもdurable callback／scheduleが一回である
- `restoreTsunamiState`とvolcano RESTはawait後の最新composition tokenへrebaseし、並行するweather／briefing／flood mutationを失わない
- source disposition fatalではstartup RESTを一件も発行せず、freshEmptyは両source missingだけである
- vfvo50-only、ashfall-only、both repair。unrecoverable omissionだけなら取得可能REST targetなし
- main-only repairでもnormal WS ingressが先行し、live mutationを保存
- VFVO53はnormal aggregator、live54/55でimmediate silent flush
- type／limit100／formatMode raw／xmlReport true／cursor維持
- 一覧 item に body キーが無い実採取 fixture を流して proof が成立する
- `xmlReport` 欠落応答では identity 構築が failure になり、runtime state が不変
- 本文は relevant かつ journal 未収の item だけ取得し、head sample では 0 件
- 同一 id は 1 回だけ取得する（成功・失敗とも id キャッシュ）
- `item.url` と組み立て URL の不一致は取得失敗
- data API の 404（HTTP 404／`text/plain`）と非 XML content-type をそれぞれ failure として識別する
- `telegram.data` 権限欠如（403）で target が fail-closed し runtime state と repairable flag が不変
- 本文取得上限 256／257 件、本文サイズ 4MiB／+1
- 本文取得の前後で transport を再検証し、取得中の generation 変化を failure にする
- subject／volcanoCode 抽出不能は proof failure ではなく target replay rejection
- coverageStart checked arithmetic、boundary included、older sentinel非適用
- terminal／empty terminal、empty＋next、token loop、newest-first違反
- page128 success／129 required failure、item12,800／12,801
- journal512／513、4MiB／+1、overflow inputはnormal処理済み
- disconnect／reconnect／generation change failure
- head4回目stable success／5回目required failure
- 単一head sample内duplicateはfailure、同じIDの別head sample再出現はstable proofとして成功
- historical同一page内／page間duplicateはunion failure、head／historical／journal間の同一ID overlapは成功
- proof集合間の同一IDでreceivedTime／head type／item head fingerprint不一致はtransport inconsistency failure。body fingerprint は両側にあるときだけ照合する
- REST/local clock offsetを変えてもcoverage結果不変
- same receivedTime groupをdedupe前unionで判定
- group全件journalならsequence順、一部journalならfailure
- REST ID辞書順とreceivedTime／journal順を逆にするfixture
- historical side effectゼロ、live side effect一回
- REST中のalert／eruption／ashfall live mutationをrebase後も維持
- REST final preflight中の他domain version changeはstale full-file snapshotをcommitせず、他domain mutationを維持してretry／failure
- full coverage時はscratch ashfallをclean rebuildし、RESTにないlive journal inputをsequence順で再適用する
- ashfall rebuild failure時はruntime baselineを維持し、journal side effectを再発火しない
- matching gateだけ残るVFVO50 alertをexact subject／revision／semantic payloadから再構成し、gate／TTLを更新しない
- full coverage時はreserved／normal gateを含むbaseline ashfallをscratch内だけで除いてREST historyからnormal bundleを再構成し、failure時はruntime baselineを維持
- final count／volcano subtree／full-file v2・v1 byte／wire failureでruntime deep equal、repair state維持
- complete empty successで対応repairable flagだけclearし、VFVO51／VFSVii／unknown alertとeruption omissionは維持
- startup scheduleは全mutation合計で最大一回、後続liveは通常schedule

### 19.9 frontend／wire／regression

- tone matrix全組、missing tone fallback、hidden rapid contribution
- existing CSS tokenだけ、RestoredChip、UpdatedStamp
- visible／ARIA／pager identity一致
- JST日／月／年跨ぎ
- area atom最小viewport、side／center、compact／full、rotation
- sourceEventId／generation correction、GA／GT reset後atom非再利用
- slice64／65、wire byte fixpoint、omitted桁数、minimum card
- `encodeSseGuarded()` maximum／+1
- VFVO53 parser、batch、interrupt、notification suppression
- VFVO54 warning、VFVO55 normal per-message severity
- CLI table、ticker body、notifier
- alert／eruption既存snapshot、empty-code eruption cancellation
- solver candidate数6、card order、display-off persistence

## 20. 受入条件

実装完了には次を全て満たす。

- [ ] §1 の完成像を満たし、非目標へ逸脱していない。
- [ ] domain content ownerはholder compositeとrevision gate、control-plane ownerはcoordinator内repair stateであり、一つのversioned runtime snapshotとしてcommitする。
- [ ] standby、v2 rollback、v1 rollbackはcanonicalへ逆流しない。
- [ ] VFVO53だけがscheduled non-durable familyである。
- [ ] VFVO54/55は共通 durable subject、7日retention、128上限である。
- [ ] 三時計をlive／REST／restoreで混同していない。
- [ ] projectorの全boundaryとcompact omissionが決定的である。
- [ ] H0/H54/H55/GA/GT、EventID、cancellation、generation規則を満たす。
- [ ] alert／eruption／ashfallの80 cross-productが他slice不変を証明する。
- [ ] current source IDとflat cumulative source IDsを区別し、composite消滅まで保持する。
- [ ] countとbyteをANDでgate commit前に検査し、全domain mutationがv2／v1 full-file 16MiB admissionを通る。
- [ ] 全durable familyとbriefingCritical／quakeHostのowner、processor reducer、version token、startup／sweep／REST入口が§13.3のmatrixどおり一つのcoordinatorへ接続され、post-commit holder mutationがない。
- [ ] family128／composite128／rollback128の最大fixtureが算術・serializationとも成立する。
- [ ] volcano subtree 1MiBと全file 16MiBのscopeが分離され、writerの全domain正常出力をreaderが全件再読込できる。
- [ ] flat rollback `sourceEventIds` にraw count hard limitがある。
- [ ] generation 1 canonical、full eruption、gate provenance、versioned repair stateのownerとschemaが一意である。
- [ ] alert slice／gateがVFVO50／VFVO51／VFSVii provenanceを保持し、VFVO50 repairableとunrecoverable alert omissionを混同しない。
- [ ] current operational-v2のgeneric `volcanoAlert` gateから実head typeを推測せず、結合可能なactive alertを`operationalV2Unknown` baselineとして維持する。
- [ ] operational-v2 omissionのlive supersessionとlocal `volcanorepair` transactionが定義どおりで、operator resolutionは永続auditを残しREST flagを暗黙clearしない。
- [ ] eruption喪失がpersistent degradedとしてsave／reloadされ、利用不能なRESTで修復済みにされない。
- [ ] ashfall gateのactual EventID／source type／variant rankがP+G／GA／GTでcanonicalに保存される。
- [ ] eruption expiryをholder ownerから行い、standbyだけのexpiryにしない。
- [ ] v2とv1を相互mergeせず、各file単独でload／rollbackできる。
- [ ] 外部manifestなしのrename failureで各fileが常に完全な旧または新snapshotであり、logical generationが同一millisecond／時計逆行を含む新旧を決める。
- [ ] v1 missing metadataをashfall reserved legacy GTまたはalert reserved legacy GTへfail-closed migrationし、利用可能なREST repairとdegraded stateを維持する。
- [ ] corruptionはslice／code／domainの最小安全単位でsalvageし、恣意的subsetを選ばない。
- [ ] 両source missingだけをfresh emptyとし、usable sourceなしのoversized／invalid組合せと、一方でもI/O errorの組合せはruntime初期化・quarantine・rewriteなしでstartup abortする。
- [ ] valid fallback後のbackup／rewriteは選択sourceの全domain snapshotを基準にし、oversized sourceの未解析domainをdeep-equal扱いしない。
- [ ] salvage backup failureが追加電文なしでretryされ、backup成功前に原文をrewriteせず、shutdownでも最終試行する。
- [ ] normal WS ingressがRESTより先行し、全stateful bufferを使わずlive mutationを保持する。
- [ ] REST lower boundary、sentinel非適用、upper overlapを証明する。
- [ ] same-time REST groupをdedupe前に検査し、partial WS observationをfailureにする。
- [ ] REST duplicate failureを単一head sample内とtype別historical pagination union内へ限定し、proof集合間overlapを許す。
- [ ] local handoff時計とREST時計を比較するproofが存在しない。
- [ ] live VFVO54/55がstartup repair中もVFVO53を即時silent flushする。
- [ ] startup、sweep、repair、live dirtyの保存予約が一回へ合流する。
- [ ] presentation／trackedBefore／renotificationをpre-mutation snapshotから固定し、durable callbackがfallible side effectより先に保証される。
- [ ] existing `volcano` card kind、solver candidate数、CSS token、CLI／ticker／notificationを維持する。
- [ ] operational v1/v2 fixtureとpinned v3.4.0 writer fixtureを固定clockで通す。
- [ ] 対象file／test pathが実treeと一致し、`src/**.test.ts`を受入testとして列挙していない。

最終検証:

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
```

永続 state、shared state、module scope counterを変更するため `npm run test:shuffle` は必須である。

## 21. 第6巡レビュー13件との対応

| # | 解消方針 |
|---:|---|
| 1 | holder／gateをcontent owner、repair stateをcontrol ownerとして明示し、coordinatorのversioned snapshotだけが完全envelopeを作る |
| 2 | authority完全性を廃止し、RESTで修復可能なVFVO50／ashfall flagとunrecoverable alert／eruption omissionを分離 |
| 3 | domain別shared lineageを廃止し、composite内flat source IDsへ統合。record-local salvage規則を一つにした |
| 4 | 全stateful bufferを廃止し、normal WS ingressをREST前に開始。VFVO50-only repairでも取りこぼし窓がない |
| 5 | local handoff clockとREST receivedTimeの比較を廃止し、subscription generation＋transport ID journalでupper coverageを証明 |
| 6 | `coverageStartMs = startupNowMs - retention`をchecked arithmeticで定義し、older sentinelをscratchへ適用しない |
| 7 | REST／WS dedupe前のsame-time unionをgroup化し、全itemのjournal順がないgroupをfailureにした |
| 8 | normal ingressを止めないため、live54/55がrepair中も到着時にVFVO53をsilent flushする |
| 9 | full eruption sliceをgate、EventID provenance、semantic tail、24h expiryまでcoupleする |
| 10 | holder sweepでeruptionを先に削除し、standby projectionとsaveをその結果から更新する |
| 11 | 各rollback recordのflat `sourceEventIds` にelement走査前raw count上限を追加 |
| 12 | persisted fieldを`topAreas`、定数を`VOLCANO_ASHFALL_MAX_TOP_AREAS_PER_GROUP`へ統一し、length=`min(3, areaCount)`を要求 |
| 13 | production／test pathを実treeへ訂正し、実行対象外の`src/**.test.ts`を削除 |

## 22. 独立検収レビュー8件との対応

| # | 解消方針 |
|---:|---|
| 1 | volcano subtree 1MiBとは別にv1／v2 full-file writer／readerを16MiBへ統一し、全domain mutationでprospective admissionする |
| 2 | 両file rootへwall clock非依存のuint64 decimal `logicalGeneration`を保存し、`savedAt`比較をlegacy fallbackだけへ限定する |
| 3 | alert slice／gateへsource familyを保存し、VFVO50 repairableとunrecoverable alert omissionを分離。eruption omissionも永続degraded化する |
| 4 | `VolcanoRepairStateV1`をcoordinatorのversioned runtime snapshotへ正式に含め、二正本宣言をdomain content限定とした |
| 5 | actual EventID／source typeをgate provenance、variant rankをcomparisonへcanonical保存し、GA／GTを含むmigrationを定義した |
| 6 | presentation／trackedBefore／renotificationをpre-mutation snapshotから固定し、durable callbackをfallible side effectより先に保証する |
| 7 | salvage backupをpendingBackup→scheduledRetry→backedUp→rewriteで再試行し、無電文timerとshutdown試験を追加した |
| 8 | head sampleごととhistorical pagination unionごとのproof集合を定義し、集合間overlapをduplicate failureから除外した |

## 23. scoped 再確認3件との対応

| # | 解消方針 |
|---:|---|
| 1 | 現行operational-v2のgeneric `volcanoAlert` comparison、`lastInfo`なしholder、time／serial-only rollbackを正式inputとし、active内容を`operationalV2Unknown` baselineで保持した。strictly newer live supersessionと、fingerprint付きlocal REPL transaction・永続audit・対象file／testを定義した |
| 2 | `StandbyPersistenceDomainSnapshots`、owner version token、全durable family＋briefingCritical／quakeHostのprocessor／holder／standby matrix、single commit API、startup／sweep／REST／shutdown経路、実test pathとmaximum fixtureを定義した |
| 3 | source classificationをdiscriminated union化し、両missingだけfresh empty、usable sourceなしはstartup abort、valid fallback時だけbackup後に選択source基準のlatest canonical pairをrewriteする組合せ試験を追加した |

## 24. 未解決事項

本 spec の範囲では決めず、別項目として持ち越す。

| # | 内容 |
|---:|---|
| 1 | §6 の `acceptedAtMs` 記述は `item.head.time` を証明軸とするよう改訂済み（旧稿は誤って `item.receivedTime` 由来と書いていた。参照番号も旧稿の「§12」から §6 へ訂正）。実応答では `head.time` が分単位で丸く、`receivedTime` はミリ秒まで入るため、`head.time` を使うと同時刻 group が増え ordering proof が落ちやすい。この穴は未解決のまま残す: 同分に複数件の historical item（例: 同一火山の VFVO54 と VFVO55 が同分）が journal 未収のとき、§16.6 の group ordering proof が成立せず `sameTimeGroupOrderingUnproven` で ashfall repair target が丸ごと fail-closed する（runtime state は不変、`ashfallRepairable` は true のまま維持）。REST 一覧の `receivedTime`／`serial` による同分 group 内 tiebreak（A+ 案）を将来採る場合は、(a) REST 側の値だけで total order を証明できること、(b) journal 側に対応 sequence があり競合した場合は journal を優先し tiebreak 側を採らず fail-closed とすること、(c) 混在 group（一部だけ journal 収録）で根拠なく順序を選ばないこと、の 3 条件を前提とする |
| 2 | 津波 VTSE41 の startup restore と legacy な volcano restore も同じ list query 経路を通り、`xmlReport` 無しでは meta が空になる同型の欠陥を持つ。本 spec の対象外として別項目で扱う |
| 3 | 旧版（full-file 上限なし）が書いた v2 を新版が読むときの互換は 16MiB 化で解消する。16MiB を超える旧 file は従来どおり oversized → v1 fallback → usable source なしなら fatal であり、本 spec で追加の移行経路は設けない |
