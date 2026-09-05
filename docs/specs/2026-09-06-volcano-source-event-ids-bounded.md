# 火山 composite の `sourceEventIds` 有界化

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


- 日付: 2026-09-06
- 状態: 実装前仕様（独立 DOC review／再レビュー残点反映後 OK）
- 優先度: P1（Sol Pro 外部レビュー指摘 4）
- リリース: v3.5.0 後に実装する

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。今夜の範囲は spec 起草と DOC review だけであり、コード、永続 JSON、Pi の実データは変更しない。

## 1. 症状

現行 composite は、生存している間に受理した alert／eruption／ashfall の WebSocket／REST transport message ID を flat な累積集合 `sourceEventIds` へ足し続ける。active replacement、取消、自然失効、wire omission では過去 ID を削らない契約である（`docs/specs/2026-08-31-vfvo54-ashfall-slice.md:124-135`）。

そのため一火山が 4,096 unique IDs に達すると、次の新報だけでなく、他 slice を残して alert／eruption／ashfall を解除する終端報も transaction ごと拒否される。Pi 実測の桜島は最大 101 件で急発は未観測だが、これは 128 又は 4,096 の安全性を証明しない。`sourceEventIds` は業務 identity ではなく diagnostic provenance であり、その資源予算の枯渇を業務電文の受理可否へ伝播させていることが問題だ。

本変更の目的は、各 active slice の現在 transport source を失わず、直近 provenance を有限に保ちつつ、**provenance 履歴だけ**を理由に新報又は解除を拒否しないことだ。revision gate の watermark／tombstone、JMA EventID、slice の revision／semantic key、表示内容の意味はこの変更で置換しない。

## 2. 根因（file:line）

- composite shape は source の domain provenance を持たない flat array である（`src/engine/messages/volcano-state.ts:124-130`）。上限は `VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE = 4096`（`:27`）。
- `VolcanoStateHolder.addSource()` は未知 ID の追加時に 4,096 件なら false を返す（`src/engine/messages/volcano-state.ts:416-423`）。alert／eruption／ashfall の active mutation と各 `clear*` はすべてこれを失敗として返す（`:444-618`）。
- 通常 ingress の `clearVolcanoSlice()` は、生存 composite に terminal transport ID を追加できなければ失敗する（`src/engine/messages/volcano-route-handler.ts:353-397`）。active／terminal の適用失敗は coordinator の scratch transaction 全体を破棄する（`:302-335`, `:695-697`, `:860-870`）。
- REST repair 用 clear に同じ検査があり（`src/engine/startup/volcano-initializer.ts:862-895`）、baseline union が 4,096 件を超えると `vfvo50SourceCapacityExceeded`／`ashfallSourceCapacityExceeded` で transaction を拒否する（`:1081-1093`, `:1137-1198`, `:1249-1278`）。実際の `restRepair` は monitor で `VolcanoRepairAdministration` へ配線される（`src/engine/monitor/monitor.ts:1146-1165`）。
- admission owner invariant と preflight にも同じ上限があり、正常 writer 前に `volcanoSourceCapacityExceeded` となる（`src/engine/display/standby-persistence-admission.ts:308-327`, `:595-604`）。同 preflight は holder、repair、durable volcano gates の canonical JSON が 1 MiB を超える場合も拒否する（`:605-623`）。
- persistence writer／reader は generation 1 の `sourceEventIds` を unique code-unit sorted array、最大 4,096 件に固定する（`src/engine/display/standby-persistence.ts:7119-7188`, `:7308-7315`）。salvage reader の raw hard limit は 8,192 件である（`:8012-8024`, `:8137-8168`, `:8384-8440`）。
- 現行旧版 reader は `volcano.state.generation === 1` だけを canonical state と認識し、それ以外は pre-generation shape の `alerts`／`eruptions` を要求する（`src/engine/display/standby-persistence.ts:7548-7555`, `:8384-8447`）。同一 `logicalGeneration` の usable v2/v1 pair では v2 が authority なので、未知 generation を v1 mirror が自動救済する保証はない（`:1213-1233`）。
- display mirror は holder の `composite.sourceEventIds` をそのまま outer card source IDs に写す（`src/engine/display/standby-state-store.ts:2222-2256`）。canonical field を tail に変えるだけでは active current source が表示 mirror／rollback mirrorから消える。
- transport message ID と JMA EventID は別 identity である。eruption の cancellation subject は現状火山コードであり（`src/engine/messages/revision-family-registry.ts:672-685`）、ashfall だけは gate の `actualEventId` mismatch guard を持つ（`src/engine/messages/telegram-revision-gate.ts:911-921`）。tail membership を取消対象照合に流用してはならない。

## 3. 変更

### 3.1 canonical ownership と generation 契約

`sourceEventIds` を「生存期間の全 accepted transport IDs」から「current source IDs 以外の有界 provenance tail」へ変更する。canonical volcano state は generation 2 とする。

```ts
interface PersistedVolcanoAlertSliceV3 extends PersistedVolcanoAlertSliceV2 {
  sourceEventId: string | null;
}

interface PersistedVolcanoEruptionSliceV3 extends PersistedVolcanoEruptionSliceV2 {
  sourceEventId: string | null;
}

interface VolcanoCompositeV3 {
  volcanoCode: string;
  volcanoName: string;
  // oldest -> newest; current source IDs は含めない
  sourceEventIds: string[];
  alert: PersistedVolcanoAlertSliceV3 | null;
  eruption: PersistedVolcanoEruptionSliceV3 | null;
  ashfall: VolcanoAshfallProjectionV1 | null; // existing sourceEventId is current
}

interface PersistedVolcanoStateV3 {
  generation: 2;
  volcanoes: VolcanoCompositeV3[];
  // current old reader が pre-generation input として復元するための enumerable bridge
  alerts: LegacyPersistedVolcanoStateV2["alerts"];
  eruptions: LegacyPersistedVolcanoStateV2["eruptions"];
  ashfalls: NonNullable<LegacyPersistedVolcanoStateV2["ashfalls"]>;
}
```

- `alert.sourceEventId` と `eruption.sourceEventId` は、当該 slice を最後に active 化した accepted transport ID である。generation 1／legacy input で復元不能な場合だけ `null` を許容し、ID を捏造しない。
- ashfall の既存 `sourceEventId` は current source のまま使う。active slices が参照する全 non-null current ID は tail から除く。同じ ID を複数 slice が共有してもよい。
- canonical tail は acceptance 順（oldest -> newest）、unique、最大128件とする。従来の code-unit sort は generation 2 tail では使わない。
- `PersistedStandbyState.version` は **2 のまま**、v1/v2 pair の `logicalGeneration` と選択規則も変更しない。両 mirror は同じ `logicalGeneration` で書く。
- `telegramFoundation.volcano.state.generation` は **2**、`VolcanoRuntimeSnapshot.schemaGeneration` も **2** にする。holder snapshot は同 runtime snapshot に内包し、別の永続 generation を追加しない。
- ashfall projection 自体は変えないため `ashfallSchemaGeneration` は **1 のまま**、repair shape も変えないため `repairState.schemaGeneration` は **1 のまま**とする。
- new writer は canonical `volcano.state` を generation 2 だけで書く。ただし同 state に上記 `alerts`／`eruptions`／`ashfalls` bridge を enumerable に dual-write し、旧版 reader が pre-generation path で domain を quarantine せず復元できるようにする。new reader は bridge を authority にせず、generation 2 `volcanoes` だけを正とする。

### 3.2 R1: tail 上限、単位、eviction、1 MiB gate

| 案 | 規則 | 評価 |
| --- | --- | --- |
| A（推奨） | per-composite は count-only `N=128`、oldest-first。期間上限と解除済み分類は持たない。さらに 1 MiB／16 MiB serialization gate 前に deterministic global tail compaction を行う。 | current source と業務 state を保護し、履歴だけの admission reject を防げる。clock skew や新しい状態分類を増やさない。 |
| B | 4,096、TTL、又は解除済み優先 eviction を残し、1 MiB 超過は従来どおり reject する。 | 4,096 又は byte gate で同じ可用性障害が残る。解除済み provenance の分類 owner も存在しないため採らない。 |

採用は A とする。128 は桜島101件に対する「安全余裕」ではなく、受理の正否に使わない diagnostic tail の per-composite 資源予算である。実測101件は fixture の現実性を示すだけで、上限根拠又は将来最大値とはしない。

通常 mutation／migration はまず各 tail を末尾128件へ縮める。その後、admission は scratch transaction 内で final derived mirror／serialized pair を確定して publish する**前**に次を実行する。

1. holder から provisional derived mirror を作り、holder composites、repair、durable volcano gates を現行 preflight と同じ canonical JSON で測る。provisional v1/v2 serialized pair の各 file sizeも測る。
2. volcano subtree が1 MiB超、又は v1/v2 file が各16 MiB超なら、non-empty tail を持つ composite のうち tail が最長のものを選び、その oldest 1件を消す。同長なら `volcanoCode` の code-unit昇順を tie-breaker とする。
3. derived mirror を作り直して再計測し、上限内になるまで2を繰り返す。current source IDs、slice、gate、repair record はこの compaction で消さない。実装は複数件をまとめて削除してよいが、1件ずつ適用した上記 victim sequence と最終 state／bytes が一致しなければならない。
4. 全 tail が空でも超過する場合だけ、履歴以外の既存 capacity failure として `volcanoBaseSubtreeBytesExceeded` 又は既存 file-byte reason を返す。`volcanoSourceCapacityExceeded` は廃止する。

compaction は read-only `preflight()` の副作用にせず、scratch holder の正規化 mutation として一 transaction 内で一度だけ owner version／durable change に反映する。したがって standby mirror、canonical state、rollback mirror は全て compaction 後の同じ tail を投影する。

transaction owner は次の二経路に分ける。

- volcano family transaction が 1 MiB 又は16 MiB compactionを必要とする場合は、既存の expected owners `telegramRevisionGate`／`standbyStateStore`／`volcanoHolderAndRepair` の scratch 内で業務 mutation と一緒に行う。commit、logical generation reservation、durable callback は全体で各一回だけとする。
- **非火山 transaction の expected owners は拡張しない。** 非火山 candidate が16 MiBを超え、volcano tailを削れば収まる場合は、その candidateを未commitのまま破棄し、captured tokenとtail fingerprintに束縛した victim planを作る。専用 key `volcano:sourceProvenanceCompaction` の先行 normalization transactionを、expected owners `standbyStateStore`／`volcanoHolderAndRepair` だけで一度実行し、その後に元の reducerを元のowner集合で一度だけretryする。gate／repairは容量計算で読むだけで変更しない。
- normalization transaction は必要な headroom 分だけ §3.2 の victim sequenceを適用し、二 owner の version、logical generation、durable callbackを各一回だけ進める。retry後の本来の非火山 commitはそれ自身の version／generation／callbackを別に一回だけ進める。compactionと本来の mutationを一 callbackに偽装せず、同じ normalizationを二度emitしない。
- plan作成後に token又はtail fingerprintが変わった場合は compactionも元 mutationもcommitせず `staleVersion` とする。無制限の内部retryは禁止し、callerの通常retryへ返す。startup migrationで compactionが要る場合も、ingress開始前に同じ専用 normalization transactionを一度使う。

### 3.3 R2: transport provenance と family 固有 EventID identity

| 案 | 規則 | 評価 |
| --- | --- | --- |
| A（推奨） | tail membership は受理条件にも取消対象同定にも使わない。業務 identity は family ごとに火山コード／JMA EventID／gate identity で照合する。 | transport message ID と JMA EventID を分離し、eviction が受理を変えない。既存 gate の責務とも一致する。 |
| B | incoming 取消・訂正が tail の transport ID を参照するとみなし、hit／miss で warn、ignore、accept を分ける。 | 現入力モデルにその参照 field はなく、試験を構成できない。誤った identity 結合なので採らない。 |

採用は A とする。旧案の「evict 済み transport source を参照したら warn + fail-open」は撤回する。incoming 電文から過去 transport ID を照合する経路は追加せず、tail miss warning も出さない。family ごとの normative rule は次とする。

- **alert**: 火山コードを lifecycle subject とする。revision gate、source family、revision、semantic key だけを照合し、JMA EventID 又は transport tail を取消対象に使わない。
- **ashfall / 取消**: gate の `volcanoProvenance.actualEventId` と incoming JMA EventID の一致を必須とし、mismatch は revision の新しさにかかわらず `cancelTargetMismatch` とする。
- **ashfall / 訂正**: tail有界化では現行gateを厳格化しない。同じEventIDは既存correction規則、異なるEventIDは relation が strictly newer の場合だけ新 lifecycleとして受理し、non-newer mismatchは `cancelTargetMismatch` とする。
- **ashfall / 通常発表**: `InfoType=発表` かつ relation が strictly newer なら、異なる EventID を新 lifecycle として受理し current projection／gate identityを置換する。equal／older／unordered は既存判定に従い、EventID mismatchで旧 lifecycleを上書きしない。これは現行 gate の「cancellation 又は non-newer の mismatchだけを拒否する」意味を維持する。
- **eruption / EventIDあり**: cancellation の nonblank JMA EventID は current `latestEventId` と一致し、gate の `legacyRevisionKey === "volcano:event:" + EventID` かつ `legacyRevisionKeyProvenance === "eventId"` を満たさなければならない。異なる EventID、同じ火山コード、より新しい revision の取消も reject する。
- **eruption / 空コード逆引き**: nonblank EventID に一致する current slice／gate subject が一意な場合だけ code を解決する。0件又は複数件は reject し、EventID が提供された場合に legacy code fallback へ落としてはならない。
- **eruption / EventID欠落**: 現行 gate の意味を維持する。explicit nonblank volcano code があれば code subject の cancellationとして評価し、active sliceの `latestEventId` 有無を追加の拒否条件にしない。codeもEventIDも無い場合は subjectを同定できないため state-neutral rejectとする。
- **eruption / 訂正**: current EventID と異なる EventID を持つ `InfoType=訂正` は `eventIdMismatch` として reject する。異なる EventID の新規・続報 lifecycle は訂正とは分け、既存 revision-family rule に従う。

eruption cancellation の holder／gate 状態は次で固定する。ここで「同一取消」は semantic key が既存 tombstone tail に一致する入力、「matching EventID」は `latestEventId` 又は `legacyRevisionKey` の eventId provenance に一致する入力を指す。

| holder | gate | cancellation target | decision／mutation |
| --- | --- | --- | --- |
| active sliceあり | non-cancelled active gate | nonblank EventIDあり | current sliceとgateの両方にmatchすれば accepted `clearCurrent`。mismatchは `cancelTargetMismatch`。 |
| active sliceあり | non-cancelled active gate | explicit code、EventID欠落 | code subjectとして既存gate判定を行い、acceptedならsliceをclearしてgateをtombstone化する。EventID欠落だけで厳格化しない。 |
| sliceなし | non-cancelled gate-only watermark | matching EventID又はexplicit code | holderを要求せず、accepted cancellationならgateだけをtombstone化する。compositeは生成しない。 |
| sliceなし | cancelled gate-only tombstone | 同一取消（explicit code、又は空code＋一意なmatching EventID） | tombstoneのsemantic keysから `semanticDuplicate`。holder mutation、outcome、通知、永続callbackを発生させない。restart後も同じ。 |
| sliceなし | cancelled gate-only tombstone | nonblank EventID mismatch | subjectを誤解決せず `cancelTargetMismatch` 又は対象なしのstate-neutral reject。code fallbackへ落とさない。 |
| sliceなし | gateなし | explicit nonblank code | 現行 H0→gate-only tombstoneを維持する。accepted cancellationはcomposite／tailを作らない。 |
| sliceなし | gateなし | codeなし | nonblank EventIDで一意なactive／tombstone subjectを引けなければstate-neutral reject。新subjectを推測しない。 |

空コード＋EventIDの逆引きは active stateだけでなく、retention内の durable gate-only watermark／tombstoneも検索対象とする。同じ terminal reportを別transport message IDで再受信しても、transport tailではなく tombstone の legacy EventID keyとsemantic keyで同じ subjectへ戻し、`semanticDuplicate` と判定する。

### 3.4 R3: generation 1 migration、rollback mirror、downgrade

| 案 | 規則 | 評価 |
| --- | --- | --- |
| A（推奨） | generation 1/2 両対応 reader、読込時 generation 2 canonical migration、旧版向け bridge と v1 rollback mirror の dual-write を行う。 | current old reader が v2 authority を選んでも quarantine せず、旧版への downgrade と再upgradeを機械検証できる。 |
| B | new reader の一方向 migration だけを実装し、旧版は generation 2 非対応とする。 | 同一 logical generation では v2 が優先され、v1 mirror への fallback が保証されない。rollback 手順として不十分なので採らない。 |

採用は A とする。generation 1 flat `sourceEventIds` は acceptance order を失っているため、valid unique code-unit sort を作り、active ashfall current ID を除いた末尾128件を deterministic migration tail とする。alert／eruption current transport ID は復元不能なので `null` とする。4,097--8,192件も raw hard limit 内なら同じ手順で generation 2 へ縮小し、「先頭4096件」を中間 canonical state として作らない。8,193件以上は既存 quarantine／salvage policy に従う。

generation 2 から作る `telegramFoundation.volcano.active` と standalone v1 `volcanoes` rollback mirror の `sourceEventIds` は、次の **rollback union** とする。

```ts
uniqueCodeUnitSort([
  ...composite.sourceEventIds,          // bounded tail
  composite.alert?.sourceEventId,
  composite.eruption?.sourceEventId,
  composite.ashfall?.sourceEventId,
].filter(isNonNullCanonicalId))
```

rollback union は最大131件で、ashfall current source を必ず含む。v1 mirror は chronological tail と per-slice transport ownershipを表現できないため、それらは downgrade 時に lossless と主張しない。一方、code/name、active alert／eruption／ashfall content、JMA EventID、revision、gate、repair state、表示用 source union は保存必須である。

current old reader が generation 2 state を pre-generation shape として読むため、bridge arrays と rollback `active` を常に一緒に出す。旧版 reader で new pair を読み、v2 authority が選択され、volcano domain が quarantine されないことを release artifact 相当の frozen reader oracle で確認する。old writer が generation 1 pair を再保存した後に new reader で再upgradeできることも確認する。

bridge／mirror の生成・破損時契約は次とする。

- writer は generation 2 canonical `volcanoes` から bridge `alerts`／`eruptions`／`ashfalls`、foundation `active`、standalone v1 `volcanoes` を毎回再生成する。runtime又は呼出し元が渡した既存mirrorを継ぎ足し、部分更新し、authorityとして再利用してはならない。
- generation 2 reader は canonical `volcanoes` を唯一の content authority とする。bridge／activeが欠落、malformed、又はcanonicalから再生成したexpectedと不一致でも、それらからcurrent source、slice、tailを補完・上書きしない。
- canonicalがdeep-validでbridge／mirrorだけが壊れている場合は、canonicalを復元してsourceを `salvageable` とし、元のv2/v1 pairを同一incidentのpaired backupへ保存してから、canonical由来のbridge／mirrorを次の `logicalGeneration` でpair rewriteする。repair stateはcanonicalにある値を維持し、mirror破損だけでdomain omissionを捏造しない。
- canonical自体がinvalidな場合は既存のgeneration 2 canonical salvage／terminal quarantineを適用し、bridge又はsame-generation v1 mirrorをcanonical補完に使わない。paired source選択のauthorityをmirror差異だけでv1へ移さない。
- frozen old-reader oracleはalert-only、eruption-only、ashfall P+G、gate-only watermark、gate-only tombstone、三slice併存、null current、shared current、tail 0／128／global compact済みを含むmatrixで実行する。happy path一件だけを旧版互換の根拠にしない。

先行互換リリースは挟まない。compatibility bridge による binary downgrade を対応範囲とする。ただし personal／Pi へ初回配送する直前はプロセス停止中に v1/v2 の**同一 logical generation pair**を一組として backup する。想定外の互換失敗時だけ旧 binary へ戻し、同じ停止中にこの pair を二本とも復元する。片方だけの復元、異なる generation の混在、稼働中の差替えは禁止する。main は frozen old-reader round-trip test を通過するまで personal へ配送しない。

### 3.5 R4: 既存4096上限

| 案 | 規則 | 評価 |
| --- | --- | --- |
| A（推奨） | holder、route、REST merge、writer、admission の normal-state 4096上限を撤去し、per-composite 128 + global byte compaction に置換する。raw reader 8192 guard は維持する。 | 4096 到達を業務 admission failure から除去しつつ、入力資源防御と1 MiB／16 MiB budgetを維持できる。 |
| B | 4096 を二重の安全弁として残す。 | 128 tail 下では冗長で、旧 reject path が再び active／terminal／repair を止めるため採らない。 |

採用は A とする。128 は**唯一の operational capacity ではない**。128 active composites、各 family 128 subjects、1 MiB volcano subtree、各 file 16 MiB、raw reader 8,192件は別々の上限として残る。ただし §3.2 の compaction により、provenance tail が存在することだけを理由に1 MiB／16 MiB rejectしてはならない。

### 3.6 全 removal path と REST provenance merge

- active replacement は新 transport ID を current に設定した後、旧 current ID が他の active slice の current でなければ tail newest へ移す。
- clear／cancel／release は対象 slice を外した後、その旧 current ID と terminal report transport IDを順に tail newest へ加える。ただし remaining slice の current と一致する ID は tail に入れない。同一 ID は最後の出現だけを残す。
- natural expiry と gate coupling cleanup (`retainActiveSubjects`) も、他 slice が composite を存続させる場合は消える slice の non-null current ID を tail newest へ移す。最後の slice が消える場合は composite と tail を一体で削除する。
- REST repair の staging のための一時 clear は business removal ではなく、そこで tail を更新しない。repair 開始時 baseline を別に保持し、commit candidate で一度だけ merge する。
- REST merge の eviction precedence は **古い REST historical < repair開始時 baseline < repair中 live journal** とする。各 segment 内は accepted replay order、重複は優先度が高い segment／同 segment の最後の出現を残す。最終 current IDs を全て除き、末尾128件を取ってから §3.2 の global compaction を適用する。古い REST history が baseline 又は live journal provenance を追い出してはならない。

### 3.7 display projection と rollback projection

standby outer `sourceEventIds` は tail だけでなく、§3.4 の rollback union と同じ `tail ∪ all non-null current IDs` の unique code-unit sort とする。card、standby snapshot、v1 mirror は同じ helper を使い、ashfall current、alert current、eruption current が tail eviction 又は shared-current transition で消えないようにする。表示 projection は diagnostic union を受け取るだけで、tail order や per-slice ownershipを公開しない。

## 4. 対象ファイル

実装時の変更対象は次に限定する。今夜は本 spec 以外を変更しない。parser、通知文言、一般 CLI の意味変更は対象外である。

| 区分 | ファイル | 変更責務 |
| --- | --- | --- |
| runtime model | `src/engine/messages/volcano-state.ts` | V3 current source、128 tail、全 removal path、snapshot/export/restore、rollback union helper。 |
| normal ingress | `src/engine/messages/volcano-route-handler.ts` | terminal append 前提の撤去、eruption EventID family rules、transaction result。 |
| gate identity | `src/engine/messages/revision-family-registry.ts`, `src/engine/messages/telegram-revision-gate.ts` | ashfallのnewer非取消 lifecycle、eruption active／gate-only target、tombstone EventID逆引き、明示的 reject reason。 |
| coordinator / administration | `src/engine/messages/volcano-transaction-coordinator.ts` | runtime schema generation 2、scratch compaction、repair administration の原子性。 |
| startup / REST repair | `src/engine/startup/volcano-initializer.ts` | repair clear、ordered baseline/historical/live merge、4096 reject撤去。 |
| REST wiring | `src/engine/monitor/monitor.ts` | `restRepair` 配線の互換確認。signature 変更が不要なら無変更とする。 |
| admission | `src/engine/display/standby-persistence-admission.ts` | owner invariant 128化、専用normalization key／expected owners、deterministic compaction、1 MiB／16 MiB preflight と base-only failure reason。 |
| display mirror | `src/engine/display/standby-state-store.ts` | tailではなく rollback union を outer source IDs へ投影する。 |
| persistence / rollback | `src/engine/display/standby-persistence.ts` | generation 2、generation 1/2 reader、canonical由来bridge、破損時paired backup/rewrite、v1 mirror union、raw guard、旧reader matrix。 |
| normative predecessor | `docs/specs/2026-08-31-vfvo54-ashfall-slice.md` | 実装時に旧 flat/cumulative/sorted/no-eviction/mirror 契約（`:83-135`, `:720-731`, `:794-801`, `:890-915`, `:1320-1327`, `:1402-1409`, `:1613`, `:2137-2139`, `:2250-2256`）を本仕様へ同期する。 |
| unit / integration tests | `test/engine/volcano-state.test.ts`, `test/engine/volcano-route-handler.test.ts`, `test/engine/volcano-initializer.test.ts`, `test/engine/monitor/volcano-rest-repair.test.ts`, `test/engine/telegram-foundation/phase3b-volcano.test.ts` | §5 の mutation、EventID、REST、boundary tests。 |
| persistence / display tests | `test/engine/display/standby-persistence.test.ts`, `test/engine/display/standby-wiring.test.ts`, `test/engine/display/standby-state-store.test.ts`, `test/engine/display/volcano-card-projection.test.ts`, `test/fixtures/standby-persistence/` | byte cross-product、old-reader、migration、rollback、outer union、Pi fixture。 |

## 5. 受入条件

全項目は実電文の長期 replay 完成を前提にしない。transport IDs、JMA EventID、revision、gate、slice を直接生成する deterministic unit／integration fixture で機械検証する。永続化・shared state を触るため、実装時は `npm run build`、`npm test`、`npm run test:shuffle`、`npm run typecheck:test` をすべて成功させる。

1. **off-by-one のない N 境界**: current `S0` を seed し、その後 `k` 回 replacement した時点を `current=Sk`, `tail.length=min(k,128)` と定義する。`k=127` は `S0...S126`、`k=128` は `S0...S127`、`k=129` は `S1...S128` を oldest->newest で保持することを assert する。
2. **旧4096境界**: 同じ sequence の `k=4095`, `4096`, `4097` を個別に観測し、current がそれぞれ `S4095`, `S4096`, `S4097`、tail が直前128件、gate と holder が各回同じ scratch transaction で commit されることを assert する。4096起因 reject reason は発生しない。
3. **全 active／terminal mutation**: alert／eruption／ashfall の replacement と、他 slice を残す cancel／release／clear を4097後に行う。current、tail、gate tombstone、standby mirror が一 commit で一致すること、最後の slice clear は composite 全体を消すことを assert する。
4. **family identity**: alert code lifecycle、ashfallの「取消／訂正／通常発表」× actualEventId same/different × newer/equal/older、eruption exact EventID、異なるEventID＋同code＋newer revision、EventID欠落、空code一意逆引き、空code 0件／複数件、訂正でEventID変更を独立 table test にする。ashfallはdifferent EventIDのstrictly-newer通常発表と訂正を受理し、cancellationはrejectすることを固定する。tail hit／miss は入力軸にせず、同じ family decision が tail 内容に依存しない metamorphic test を置く。
5. **shared current**: 同じ current ID を二 slice に持たせ、一方の replacement／clear／natural expiry／gate cleanup でその ID が tail に入らず、他方 current と outer union に残ることを assert する。最後の参照が消え、composite が残る場合だけ tail newest へ一度入る。
6. **natural removal**: eruption expiry、ashfall expiry、`retainActiveSubjects` の alert／eruption／ashfall cleanup を全て試し、他 slice が残る場合の current→tail、最後の slice の composite削除、owner version の一 commit増分を assert する。
7. **REST precedence**: overlapping ID を含む historical、baseline、live journal を作り、`historical < baseline < live`、segment内 accepted order、last occurrence wins を exact array で assert する。古い REST history を大量に追加しても baseline／live の新しい provenance と final current が追い出されない。
8. **REST／administration integration**: normal ingress と `VolcanoRepairAdministration.restRepair` の双方で N+1 と4097超を通す。`vfvo50SourceCapacityExceeded`／`ashfallSourceCapacityExceeded`／`volcanoSourceCapacityExceeded` を発生させず、active slice、gate、repair、standby mirror が整合して commit する。
9. **1 MiB cross-product**: 128 composites × 128 tail × 256 code-unit unique IDs の deterministic maximum fixture をメモリ上で生成する。compaction前が1 MiB超であること、compaction後の subtreeと両 serialized files が各上限内であること、全 current IDs／slice／gate／repairが不変であること、同じ入力から同じ evicted IDs と bytes が得られることを assert する。
10. **base-only byte failure**: tailsを全て空にしても1 MiBを超える synthetic baseを作り、`volcanoBaseSubtreeBytesExceeded` で rejectすることを assert する。tailが一件でも残ったまま同 reason を返すことを禁止する。既存128 composite／family／16 MiB file gatesも維持する。
11. **Pi generation 1 fixture**: anonymized old-format pair と checked-in manifest を一組用意する。fixture は桜島101 unique IDsと、2026-09-04観測のレベルなし64火山相当を含む。「レベルなし」は `alert != null && alert.alertLevel === null && alert.alertClass != null && alert.alertClass.isActive === true && alert.warningKind === alert.alertClass.name` を全て満たす canonical active alertだけと定義する。eruption／ashfallだけのcomposite、`alertClass == null`、inactive class、数値levelありは数えない。manifestに64 codesの固定sort済みlistを持ち、件数だけで代用しない。64件全ての code、name、alertLevel、alertLevelCode、alertClass全field、warningKind、action、sourceFamily、matching gate、repair stateをstatic expectedと照合し、migration、restart、REST repair、rollback後も維持する。
12. **Pi fixture provenance**: manifest に原 snapshot の採取日時、実測期間の開始／終了、logicalGeneration、桜島ID件数、ID code-unit長の min/max と固定bucket histogram、原本SHA-256、anonymized fixture SHA-256を literal 値で記録する。実装が生成した値をexpectedに流用せず、欠落 field、101件以外、上記predicateで64件以外、又は64-code list不一致なら testを失敗させる。leveled active、inactive class、alert欠落を各一件含むnegative fixtureでcountが増えないこともassertする。認証情報と個人情報は fixture に含めない。
13. **generation 1/2 migration**: generation 1 の101件、4,095件、4,096件、4,097件、8,192件、8,193件を分ける。8,192以下は current ashfallを保護して generation 2 tailへ移行、8,193は既存 raw quarantine／salvageとなることを assert する。write→new read の runtime snapshotは完全一致する。
14. **旧版 rollback／bridge matrix**: new writer の同一 logicalGeneration v2/v1 pair を frozen v3.5.0 reader oracleへ渡し、§3.4の全matrixでv2が選択されてもterminal quarantineにならず、ashfall currentがrollback `sourceEventIds` に含まれることをassertする。old read→old write generation1→new readも行い、downgrade semantic fieldsが一致することをassertする。単一のalert-only happy pathだけでは合格にしない。
15. **display union**: tailが空／128／global compact済み、三 current が別ID／shared ID、legacy nullを組み合わせ、standby/card/v1 mirrorが `tail ∪ non-null current` の同じ unique sortを返すことを assert する。
16. **static removal of old contract**: normal-state 4096 check と旧 cumulative/sorted/no-eviction 文言が holder、route、REST、admission、persistence、先行 normative spec に残らないことを targeted code/doc search で確認する。8192 は raw-input guardだけ、4095/4096/4097 は test dataだけに残せる。
17. **terminal tombstone duplicate**: eruption active→matching取消→gate-only tombstoneを作り、同一取消を別transport IDでlive再送した場合とrestart後に再送した場合を試す。空code＋EventIDはdurable tombstoneのlegacy keyから同じsubjectへ一意に戻り、両方とも `semanticDuplicate`、holder/outcome/notification/persistence callbackは全て不変であることをassertする。gate-only non-cancelled→tombstone、H0 explicit-code→tombstone、EventID mismatch／0件／複数件も§3.3表どおり固定する。
18. **cross-family normalization owner**: 非火山candidateで16 MiBを越え、volcano tailを削れば収まるfixtureを置く。元candidateは未commit、専用normalizationのchanged ownersはexactly `standbyStateStore`／`volcanoHolderAndRepair`、各owner version・logical generation・durable callbackは一回だけ進み、元mutationのretryは元のexpected ownersだけを各一回進めてacceptedになることをassertする。`invalidTouchedOwners`／`unexpectedOwnerMutation`、二重callbackを許さない。token driftでは両方をcommitせず `staleVersion` とする。
19. **bridge corruption／divergence**: generation 2 canonicalを固定したまま、bridge missing、container malformed、alert/eruption/ashfall divergence、active rollback union欠落、same-generation v1 mismatchを個別fixtureにする。new readerはcanonicalを補完なしで復元し、paired backup後に次logicalGenerationで全mirrorをcanonicalからrewriteする。rewrite pairはfrozen old-reader matrixを通り、canonical invalid＋bridge validはbridge救済せず既存salvage／quarantineへ進むことをassertする。
20. **Pi level-less predicate**: §5.11のpredicateをtest helper一箇所に固定し、manifestのsort済み64 codesとexact一致させる。64件の全field round-tripに加え、leveled／inactive／alert-nullのnegative各一件を投入してcountが64のまま変わらないことをassertする。
21. **release gate**: 実電文 replay は追加 confidence signal にできるが完了条件ではない。上記 synthetic boundary、byte cross-product、Pi migration/restore/rollback、old-reader bridge/downgrade、terminal tombstone、cross-family normalization owner、normal/REST transaction suiteの全通過を必須とする。

## 6. 裁定ラベル（案）

朝の一括裁定用。各 label は実装 issue の acceptance heading にそのまま使える。

| Label | 決めること | 提案 |
| --- | --- | --- |
| R1 `tail-budget` | tail と byte budget | A: per-composite count 128、oldest-first、最長tail優先のglobal compaction。非火山16 MiB超過は専用先行normalizationとし、ownerを暗黙拡張しない。 |
| R2 `identity` | 取消／訂正 identity | A: transport tailを受理に使わない。ashfallはdifferent EventIDのstrictly-newer非取消を許し、eruptionはactive／gate-only／不在表に従う。 |
| R3 `migration-rollback` | generation と旧版互換 | A: top-level v2維持、volcano generation2、canonical由来bridge + rollback union、破損時paired backup/rewrite、旧reader matrix。 |
| R4 `capacity` | 4096 と byte gate | A: normal-state 4096を撤去、8192 raw guardと1 MiB／16 MiBを維持し、tailを先にcompactする。 |
| R5 `verification` | 最小 release gate | A: 境界値、128×128×256、ashfall lifecycle、eruption tombstone replay、owner version/callback、bridge divergence、Pi厳密predicate。 |
| R6 `delivery` | main / personal / Pi | A: mainで全suite→personalで停止backup/restore rehearsal→Piでmatched-pair backup後配送。各段を通過するまで次へ進めない。 |

## 7. 独立 DOC review 指摘の処置

| # | 重要度 | 判定 | 反映内容／理由 |
| --- | --- | --- | --- |
| 1 | High | **a) 採用** | §3.1/3.4で全generation、legacy bridge、rollback union、旧reader oracle、downgrade、main/personal/Pi backupを固定した。一方向migrationだけではv2優先時のquarantineを防げないためだ。 |
| 2 | High | **a) 採用** | §3.3でtransport provenanceとJMA EventIDを分離した。旧R2のtail miss warn案は入力モデルに存在しないため撤回し、family別照合と反例testへ置換した。 |
| 3 | High | **a) 採用** | §3.2/3.5で「128が唯一のcapacity」を撤回し、1 MiB／16 MiB前のdeterministic tail compactionと128×128×256 testを追加した。履歴以外のbase overflowだけは明示reasonでrejectする。 |
| 4 | High | **a) 採用** | §4へadmission、standby mirror、先行normative spec、projection/wiring testsを追加し、monitorの実restRepair配線も根因へ記載した。 |
| 5 | Medium | **a) 採用** | §3.6でnatural expiry、gate cleanup、shared current、REST三segment precedenceを裁定した。一時repair clearはbusiness removalから分離した。 |
| 6 | Medium | **a) 採用** | §5でS0 seedによるoff-by-one排除、4095/4096/4097、shared/expiry、101 IDs＋レベルなし64火山、採取期間・ID長分布・hashをliteral manifestとして機械化した。128は診断予算と明記した。 |

## 8. 再レビュー残点の処置

| # | 重要度 | 判定 | 反映内容／理由 |
| --- | --- | --- | --- |
| 1 | High | **a) 採用** | §3.3でashfallの取消／訂正／通常発表を分離し、different EventIDでもstrictly-newer非取消は新lifecycleとして受理すると固定した。tail有界化で現行gateを不要に厳格化しないためだ。 |
| 2 | Medium | **a) 採用** | §3.3にeruptionのactive／gate-only watermark／tombstone／不在表を追加した。terminal後の同一取消はdurable tombstoneのEventID keyとsemantic keyからrestart後も `semanticDuplicate` とし、EventID-less code取消は現行意味を維持する。 |
| 3 | High | **a) 採用** | §3.2で非火山owner集合の拡張を退け、専用先行normalization transactionを裁定した。compactionと元mutationのversion／generation／callbackを別々に一回へ固定した。 |
| 4 | Medium | **a) 採用** | §3.4でwriter再生成、canonical-only authority、bridge不一致時のpaired backup＋rewrite、canonical invalid時の非補完、旧reader matrixを定義した。 |
| 5 | Medium | **a) 採用** | §5.11/12/20でlevel-lessを厳密predicateと64-code listで定義し、leveled／inactive／alert-nullのnegative fixtureを要求した。 |
