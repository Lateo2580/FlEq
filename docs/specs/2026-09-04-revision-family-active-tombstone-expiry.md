# revision family の active / tombstone expiry 分離

- 日付: 2026-09-04
- 状態: 実装前仕様（裁定済み: A）
- 作業基準 HEAD: `a98de9854a37d9286c9ccd823b0ac2578cdfc348`
- 優先度: P0

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。

## 1. 背景

revision gate の durable state には、現在有効な watermark (`cancelled: false`) と、取消済みの
tombstone (`cancelled: true`) が同じ family 内に保存される。前者は終端報、情報固有の有効期限又は
明示した active lifecycle まで残す状態、後者は旧報の復活を防ぐ有限履歴であり、保持理由が異なる。

Pi の 2026-09-04 観測では、受理から 25 日経過した active `volcanoAlert` が 64 件ある。全て level 1
で表示対象外だが、現実装は 30 日を超えると 60 秒 sweep 又は起動時 sweep で解除報なしに削除する。
前日の「9/9 ごろ自然消滅」という見込みは、この誤った tombstone TTL の流用に依存していた。

ご主人の裁定は A で確定した。`volcanoAlert` に `activeRetentionMs` を与えず、64 件は残し、配送時の
migration / 手動 repair は行わない。ただし同じ修正を全 coordinated family へ適用すると、VPTA50 と
flood を含む正当な active expiry まで失うため、本仕様で family 全件を監査して lifecycle を明示する。

## 2. 根因

`RevisionFamilyPolicy` は tombstone と active の保持期間を別 field で表す。前者は必須の
`tombstoneRetentionMs`、後者は任意の `activeRetentionMs` である
（`src/engine/messages/revision-family-registry.ts:76-83`）。しかし現実装はこの区別を global sweep に
渡していない。

- `TelegramRevisionGate.expireRevisionFamilyDetailed()` は `cancelled` を判定せず、family の regular
  state 全てを渡された一つの `retentionMs` で削除する。さらに matching transient も各 entry 自身の
  retention ではなく同じ引数で削除する（`src/engine/messages/telegram-revision-gate.ts:1520-1557`）。
- `StandbyPersistenceAdmissionCoordinator.sweepAll()` は coordinated family の
  `policy.tombstoneRetentionMs` を上記 API に渡す（`src/engine/display/standby-persistence-admission.ts:686-705`）。
  その結果、`activeRetentionMs` 未指定でも active が tombstone TTL で消える。
- gate expiry 後、coordinator は volcano、VPWS50、VPWW56、VTSE41、flood、VPTA50、VPWP50 と standby
  projection を gate の残存 subject に結合し直すため、誤削除が holder / card に伝播する
  （`standby-persistence-admission.ts:708-797`）。
- 同じ `sweepAll()` は起動時 `monitor.ts:593-614` と 60 秒 timer `monitor.ts:706-725` の双方から呼ばれる。

この誤りは active を全て無期限にすれば直るものではない。VPTA50 は startup、admission 前、既存 test が
active を含む 7 日 expiry を固定する（`monitor.ts:472-474`、`process-message.ts:632-637`、
`test/engine/telegram-foundation/phase3a-vpta-revision-gate.test.ts:149-165`）。flood も policy と holder が
36 時間 lifecycle を共有し、active gate / holder の退場が既存 test で固定される
（`revision-family-registry.ts:547-564`、`src/engine/messages/flood-forecast-lifecycle.ts:13-35`、
`test/engine/telegram-foundation/phase3b-flood.test.ts:590-625`）。

## 3. 改修

### 3.1 採用 API

既存 `expireRevisionFamily()` / `expireRevisionFamilyDetailed()` の「active、tombstone、matching transient
に同じ単一 retention を適用する」意味は変えない。`TelegramRevisionGate` へ policy lifecycle 用の新 API
を追加する。

```ts
interface RevisionFamilyLifecycleRetention {
  tombstoneRetentionMs: number | null;
  activeRetentionMs?: number;
}

expireRevisionFamilyByLifecycle(
  domain: string,
  revisionFamily: string,
  nowMs: number,
  retention: RevisionFamilyLifecycleRetention,
): RevisionFamilyExpiryResult;
```

削除条件は次だけとする。

```ts
const retentionMs = state.cancelled
  ? retention.tombstoneRetentionMs
  : retention.activeRetentionMs;
if (retentionMs != null && nowMs - state.acceptedAtMs > retentionMs) deleteState();
```

- tombstone は `tombstoneRetentionMs` が non-null のときだけ失効する。
- active は `activeRetentionMs` が non-null のときだけ失効する。未指定を tombstone TTL で補わない。
- strict `>`、expired subject の code-unit sort、capacity warning の re-arm、owner version の一回だけの
  加算は既存 detailed API と同じ契約にする。
- matching transient dedupe state に active / tombstone policy TTL を適用しない。同じ API 内で各 entry
  自身の `retentionMs` だけを評価し、strict `>` で失効させる。これにより 60 秒 `sweepAll()` の periodic
  回収を失わず、受信時の既存 sweep（`telegram-revision-gate.ts:1712-1729`）とも境界を一致させる。

新 API を選ぶ理由は、既存の単一 retention API を使う明示的な局所 window を壊さず、policy を使う caller
で active 未指定を意味どおり扱えるためだ。既存 API の引数意味を変更すると、火山 REST replay 等の
直接 caller が暗黙に active を無期限化するため採用しない。

### 3.2 lifecycle 分類の原則

分類は gate active watermark の寿命を表す。holder / card の表示寿命とは別である。

1. **(i) active 無期限**: 解除、取消、全解除、状態遷移等の終端電文が定義される family。holder の
   safety TTL で表示が先に消えても、遅延旧報を拒否する watermark は残す。
2. **(ii) policy TTL**: 情報自体に有効期限があり、既存 policy / test が固定 horizon で active gate も
   失効させる family。`activeRetentionMs` を明示する。
3. **(iii) holder 同時終了**: 可変の holder expiry が唯一の lifecycle authority で、同じ transaction で
   gate active も削除すべき family。本監査では該当なしとする。holder expiry 後も遅延報防止 watermark を
   残す既存契約、又は固定 policy TTL が全件にあり、新たにこの結合を導入する根拠がないためだ。

capacity は lifecycle と直交する。全 family は有限 `maxSubjects` 又は固定 subject で bounded であり、
active 無期限を理由に既存 active を tombstone TTL で evict してはならない。

### 3.3 coordinated family 全件監査

監査対象は coordinator の全 16 family である
（`src/engine/display/standby-persistence-admission.ts:194-215`）。「現行 TTL」は policy 値、分類は本変更後の
active gate 契約である。`holder expiry` があっても、それだけで (iii) にはしない。

| family | 分類 / active 契約 | holder lifecycle・終端 | 容量 / 根拠・既存試験 |
|---|---|---|---|
| VPWS50 | **(i)** 未指定 | complete / partial current は後報と取消で置換する。canonical holder 自体に時刻 expiry はなく、derived weather view だけ report+24h（`src/engine/messages/vpws50-state.ts:911-935`、`src/engine/display/standby-state-store.ts:1770-1803`）。 | base 1＋partial 128、tombstone 7日（`revision-family-registry.ts:763-785`）。最大 active fixture は `test/engine/display/standby-wiring.test.ts:1267-1300`。 |
| VPWW56 | **(ii) 6時間（裁定済み）** | no-active-area / 取消が stream を clear する。holder は gate coupling、derived view は report+24h（`revision-family-registry.ts:787-814`、`src/engine/messages/vpww56-state.ts:151-167`、`standby-state-store.ts:1865-1880`）。 | 128、tombstone 6h。policy / round-trip は `test/engine/telegram-foundation/phase3b-vpww56.test.ts:132-165`、24h view は同 `:462-495`。`activeRetentionMs` に同じ6時間を明示し、現行の gate / holder coupling と表示寿命を維持する。 |
| VTSE41 | **(i) 無期限（裁定済み）** | Kind Code 60 の全解除又は取消が keyed warning と観測を畳む。holder に時刻 expiry はないため、active はその終端まで保持する（`src/engine/messages/tsunami-state.ts:350-414`）。 | 512、tombstone 7日（`revision-family-registry.ts:816-838`）。active restart 保持は `test/engine/telegram-foundation/phase3b-tsunami.test.ts:951-985`。`activeRetentionMs` は追加せず、tombstone TTL による7日後の自然消滅を廃止する。 |
| VTSE51 | **(i)** 未指定 | 警報非 active 化又は family 取消で観測を clear し、11分では切らない（`tsunami-state.ts:370-373, 463-465`）。 | whole 1＋station 1,024、tombstone 無期限（`revision-family-registry.ts:709-750`）。独立 family / 上限試験は `phase3b-tsunami.test.ts:3239-3260`。現挙動も無期限。 |
| VTSE52 | **(i)** 未指定 | VTSE51 と同じだが独立 family。警報継続中の観測更新を time-based に落とさない（`revision-family-registry.ts:709-750`）。 | whole 1＋station 1,024、tombstone 無期限。同試験 `phase3b-tsunami.test.ts:3239-3260` で独立性と上限を固定。 |
| volcanoAlert | **(i) 裁定 A** | release / cancel / level 1 inactive が alert slice を clear する（`revision-family-registry.ts:627-664`）。alert 自体に時刻 expiry はなく、coupling は gate active を正とする（`src/engine/messages/volcano-state.ts:684-706`）。 | 128、tombstone 30日。128/129 境界は `test/engine/telegram-foundation/phase3b-volcano.test.ts:1126-1157`。Pi の64件は保持し migration しない。 |
| volcanoEruption | **(i)** 未指定 | cancellation が終端。holder projection は report+24h で自然消灯するが gate watermark は別に残す（`revision-family-registry.ts:666-688`、`src/engine/messages/volcano-state.ts:631-645`、`docs/specs/2026-08-31-vfvo54-ashfall-slice.md:737-750`）。 | 128、tombstone 2日。2日を active に使わない契約は `docs/specs/telegram-foundation.md:676-677`、24h表示試験は `test/engine/display/standby-state-store.test.ts:1967-1988`、取消後の新 lifecycle は `phase3b-volcano.test.ts:1024-1058`。 |
| volcanoAshfall | **(ii) 7日** | projection は `forecastEndsAtMs` ちょうどで GA へ移り、gate は acceptedAt+7日を保持して +1ms で消える（`docs/specs/2026-08-31-vfvo54-ashfall-slice.md:572-578, 733-750`）。 | 128、tombstone 7日（`revision-family-registry.ts:315-335`）。同 spec `:905-912` が128/129境界を固定。`activeRetentionMs` に同じ7日を追加する。 |
| floodForecast | **(ii) 36h** | active gate と holder は同じ36h horizon で退場し、projection を同期する（`src/engine/messages/flood-forecast-lifecycle.ts:13-35`）。 | 512、tombstone 36h（`revision-family-registry.ts:503-564`）。active gate / holder の36h退場は `test/engine/telegram-foundation/phase3b-flood.test.ts:590-625`。 |
| tornado | **(ii) 36h** | card は電文 `ValidDateTime`、欠落時 report+1h で自然失効する（`standby-state-store.ts:1909-1930, 2484-2490`）。gate はその後も遅延旧報を防ぎ、現行36h horizon を維持する。 | 128、tombstone 36h（`revision-family-registry.ts:397-406`）。自然失効後の旧報拒否は `docs/specs/2026-08-26-tornado-area-aggregation.md:150-159, 198`、上限は `phase3b-standby-domains.test.ts:612-645`。 |
| heatAlert | **(ii) 3日** | card は JST 対象日24:00で自然失効する（`src/engine/display/project-standby.ts:35-54`、`standby-state-store.ts:2436-2442`）。gate は既存3日 horizon を維持する。 | 256、tombstone 3日（`revision-family-registry.ts:408-418`）。holder 境界は `test/engine/display/standby-state-store.test.ts:1100-1117`、active gate 3日 expiry は `test/engine/display/standby-wiring.test.ts:1654-1712`。 |
| typhoonAnalysis | **(i)** 未指定 | `transitionedToLow` / `formationCancelled` が terminal。card safety TTL は report+24h（`revision-family-registry.ts:420-432`、`standby-state-store.ts:2000-2039, 2443-2449`）。 | 64、tombstone 7日。terminal test は `test/engine/telegram-foundation/phase3b-standby-domains.test.ts:153-165`、24h/取消は `standby-state-store.test.ts:1660-1701`。 |
| VPTA50 | **(ii) 7日** | probability projection と gate を admission 前、startup、runtime で同じ7日 horizon に保つ（`src/engine/presentation/processors/process-message.ts:625-654`、`src/engine/monitor/monitor.ts:461-474`）。 | 256、tombstone 7日（`revision-family-registry.ts:434-445`）。strict境界は `test/engine/telegram-foundation/phase3a-vpta-revision-gate.test.ts:149-165`、既存 spec は `docs/specs/2026-08-31-vpta50-typhoon-card-integration.md:149-152, 646-663`。 |
| VPWP50 | **(ii) 7日** | gate active / tombstone は7日、projection は TimeDefine ごとの expiry。受信前 expiry が両 state を消す（`revision-family-registry.ts:476-490`、`src/engine/presentation/processors/process-standby-foundation.ts:46-67`）。 | 512、reject-new。両 state の strict境界は `test/engine/telegram-foundation/phase3a-revision-gate.test.ts:1219-1245`、既存 spec は `docs/specs/2026-08-31-vpwp50-forecast-card.md:2289-2305`。 |
| nankaiTrough | **(i)** 未指定 | info serial の deactivate 又は取消が fixed current を終える。card safety TTL は7日（`revision-family-registry.ts:447-456`、`standby-state-store.ts:1883-1906, 2502-2506`）。 | fixed 1、tombstone 30日。active / cancellation round-trip は `test/engine/telegram-foundation/phase3b-standby-domains.test.ts:648-735`。 |
| VXSE62 | **(ii) 36h** | long-period holder は quake host expiry 又は report+12h で消えるが、gate は現行36h horizon まで遅延観測を拒否する（`standby-state-store.ts:1933-1963, 2491-2496`）。 | 256、tombstone 36h（`revision-family-registry.ts:492-502`）。markCancelled と round-trip は `phase3b-standby-domains.test.ts:387-395, 648-735`。 |

`docs/specs/telegram-foundation.md:645-661` の集約表には、現 HEAD の registry や後発 ashfall spec と異なる
旧値（例: VPWS50 tombstone 無期限、volcano 上限512、旧 ashfall family）が残る。本監査は現 HEAD の実コード
と日付の新しい family spec を正とし、その集約表の同期修正は allowed path 外なので行わない。

### 3.4 policy と caller の変更

(ii) に確定した family へ次を追加する。これは既存 `tombstoneRetentionMs` の**値変更ではなく**、現在の
active expiry を lifecycle 分離後も維持するため同じ値を `activeRetentionMs` に明示する変更である。
backlog で禁止された「registry retention 値の変更」には当たらず、本仕様の対象に含める。

```ts
TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY.activeRetentionMs =
  TYPHOON_PROBABILITY_RETENTION_MS;
FLOOD_FORECAST_REVISION_FAMILY_POLICY.activeRetentionMs =
  FLOOD_FORECAST_RETENTION_MS;
VOLCANO_ASHFALL_REVISION_FAMILY_POLICY.activeRetentionMs = 7 * 24 * 60 * 60_000;
TORNADO_REVISION_FAMILY_POLICY.activeRetentionMs = STANDBY_DOMAIN_RETENTION_MS;
HEAT_ALERT_REVISION_FAMILY_POLICY.activeRetentionMs = HEAT_RETENTION_MS;
LG_OBSERVATION_REVISION_FAMILY_POLICY.activeRetentionMs = STANDBY_DOMAIN_RETENTION_MS;
VPWW56_REVISION_FAMILY_POLICY.activeRetentionMs = VPWW56_TOMBSTONE_RETENTION_MS;
```

VPWP50 は既に `activeRetentionMs: WEATHER_TIMESERIES_RETENTION_MS` を持つ。VTSE41 を含む (i) family
には追加しない。

`StandbyPersistenceAdmissionCoordinator.sweepAll()` は全 coordinated family で新 lifecycle API を呼ぶ。
`tombstoneRetentionMs == null` を理由に family loop を skip せず、policy の両値を渡す。changed family だけを
既存 durable mutation key に記録し、holder coupling と全 owner preflight を一 transaction に保つ。

直接 caller も同じ policy 契約へ切り替える。

- VPTA50: `monitor.ts:472-474, 570-572` と `process-message.ts:632-637, 845-848`。
- flood: `process-flood-forecast.ts:104-111`、`flood-forecast-lifecycle.ts:20-35`、
  `monitor.ts:527-535`。
- VPWP50: admission 前 `process-standby-foundation.ts:46-67` と startup 先行 expiry
  `monitor.ts:466-471, 573-578`。policy の active / tombstone 7日を共に渡し、双方の失効を維持する。

火山 REST repair の局所 replay window（`src/engine/startup/volcano-initializer.ts:1270-1276`）は、active と
tombstone を同じ明示 horizon で閉じる caller なので既存 API に残す。実装後、production の旧 API caller
はこのような局所同一-lifecycle の allowlist だけとし、上記 policy caller が残っていないことを検索で固定する。

### 3.5 policy lifecycle と VPWP50 projection / capacity の分離

現 `processStandbyFoundation()` は `policy.activeRetentionMs != null` 一条件のブロックで、family gate の expiry、
VPWP50 projection の剪定、VPWP50 capacity 保護用 active subject の取得を全て行う
（`src/engine/presentation/processors/process-standby-foundation.ts:46-67`）。さらに generic standby transaction は
全 policy に VPWP50 用 callback を渡し（`src/engine/presentation/processors/process-message.ts:237-252`）、
`maintainWeatherWarningForecastSubjects()` は受け取った subject 集合にない VPWP50 projection を削除する
（`src/engine/display/standby-state-store.ts:570-584`）。従って tornado、heatAlert、VXSE62 へ
`activeRetentionMs` を追加するだけでは、当該 family の subject を VPWP50 subject と誤用し、有効な forecast を
全削除し得る。

実装は次の二ブロックを独立させる。

1. **policy lifecycle expiry**: family の admission-local expiry は (i) / (ii) を問わず §3.1 の新 API へ
   policy の active / tombstone retention をそのまま渡す。実行条件を `activeRetentionMs` の有無や VPWP50 identity
   と結合せず、active 未指定の family でも tombstone と固有 TTL transient を評価する。このブロックは
   projection callback を一切呼ばない。coordinator の admission 前 `sweepAll()` と completion-owned VPWP50
   経路のどちらでも、durable mutation は既存どおり一つの transaction / reservation に収める。
2. **VPWP50 projection / capacity**: gate subject の列挙、`maintainWeatherWarningForecastSubjects()`、
   `activeWeatherWarningForecastSubjects()`、`familySubjectCount` の算出は、次の exact identity のときだけ行う。

```ts
const ownsVpwp50Projection = policy.domain === "weatherWarningTimeseries"
  && policy.revisionFamily === "VPWP50";
```

`process-standby-foundation.ts` はこの guard を correctness boundary として必須化する。加えて
`process-message.ts` の call site も上記 identity で二 callback を scope し、非 VPWP50 policy には必ず
`undefined` を渡す。これは coordinator ありの transaction branch（同 `:237-252`）だけでなく、現在 `deps` を
そのまま渡す coordinator なしの direct branch（同 `:300`）にも適用する。router は coordinator の有無と
無関係に二 callback を組み立てるため（`src/engine/messages/message-router.ts:960, 1011-1020`）、direct branch での
filter を省略してはならない。callee guard と両 call branch の filter のどちらか一方だけの防御にはしない。
tornado、heatAlert、VXSE62 の lifecycle expiry が VPWP50 gate / projection / capacity latch 又は
`[VPWP50] vpwp50ActiveBeyondGateRetention` warning に触れることを禁止する。

### 3.6 対象ファイル

- `src/engine/messages/revision-family-registry.ts`
- `src/engine/messages/telegram-revision-gate.ts`
- `src/engine/display/standby-persistence-admission.ts`
- `src/engine/presentation/processors/process-message.ts`
- `src/engine/presentation/processors/process-standby-foundation.ts`
- `src/engine/presentation/processors/process-flood-forecast.ts`
- `src/engine/messages/flood-forecast-lifecycle.ts`
- `src/engine/monitor/monitor.ts`
- §6 に列挙する test files

## 4. 判断分岐

### 4.1 ご主人裁定 A（確定）

`volcanoAlert` は (i) とし、`activeRetentionMs` を与えない。Pi の受理後25日 active 64件は残し、
migration / 手動 repair / 配送時剪定は行わない。真の解除は release、cancel、level 1 inactive 等の
終端報で行う。現在の64件は level 1 で表示対象外、family は128件上限かつ `rejectNewSubject` で bounded
なので、差分は保存サイズだけである。

不採用案は次のとおりだ。

- **B（不採用）**: `volcanoAlert` に有限 `activeRetentionMs` を与える。電文仕様にない日数で active alert を
  誤解除するため採らない。
- **C（不採用）**: 配送時に一度だけ migration / 手動 repair で level 1 を剪定する。正当な解除報なしに
  durable state を変える運用となるため採らない。将来容量圧迫を実測した場合は別 operator spec とする。

### 4.2 ご主人裁定（VPWW56 / VTSE41、確定）

- **VPWW56 は (ii)** とする。`activeRetentionMs = VPWW56_TOMBSTONE_RETENTION_MS`（6時間）を追加し、
  現行の gate / holder coupling と約6時間の自然消滅を維持する。終端報より先に active を落とし得るが、
  今回は製品の見え方を変えないことを優先する。
- **VTSE41 は (i)** とする。`activeRetentionMs` を追加せず、全解除又は取消まで無期限に保持する。
  終端報が欠けた場合は7日後も表示が残り得るが、実警報を tombstone の compact TTL だけで消さないことを
  優先する。512 subject 上限により容量は bounded である。

## 5. 受入条件（機械検証）

### 5.1 lifecycle API 単体

全 fixture は subject を逆 code-unit 順で seed し、境界呼出し前後の gate `version()` と
`expiredStateSubjectKeys` も assertion する。

1. active=7日 / tombstone=30日: T0+7日ちょうどでは無変更、+1ms（及び8日後）では active だけを削除し、
   tombstone を残す。
2. active未指定 / tombstone=30日: T0+30日ちょうどでは無変更、31日後では tombstone だけを削除し、
   active を残す。
3. active=7日 / tombstone=null: T0+7日ちょうどでは無変更、8日後では active だけを削除し、tombstone を残す。
4. regular state と、policy TTL より長い固有 retention の transient state を同居させる。active / tombstone
   の expiry 時刻に lifecycle API を呼んでも transient は byte-for-byte 不変とする。その後、transient
   自身の `acceptedAtMs + retentionMs` ちょうどでは残り、+1ms の lifecycle API と受信時 general sweep の
   双方でだけ削除される。
5. 既存 capacity-latch fixture（`test/engine/telegram-foundation/phase3a-revision-gate.test.ts:842-861`）を
   `maxSubjects: 1` の synthetic family と新 lifecycle API へ移す。一件受理後の二件目拒否で warning が1回、
   active expiry の +1ms で空きを作り、再充填後の次の拒否で warning が exactly 2回目まで再発する。
   expiry 境界ちょうどでは削除も re-arm もせず、最初の latch が維持されることも固定する。

各ケースで、削除がない呼出しは owner version 不変、同一呼出しで一件以上削除しても owner version は
exactly +1、返す subject は code-unit 昇順とする。active と tombstone が同時に対象になる追加 case でも
加算は一回だけとする。regular と固有 TTL 到達済み transient が同じ呼出しで消える場合も、重複を除いた
subject union を code-unit sort し、version は +1 だけとする。

### 5.2 policy / coordinator 回帰

- (i) 確定 family は **VPWS50、VTSE41、VTSE51、VTSE52、volcanoAlert、volcanoEruption、
  typhoonAnalysis、nankaiTrough** の8件である。registry の table-driven test で各 policy について
  `Object.hasOwn(policy, "activeRetentionMs") === false` を exact assertion する。tombstone TTL +1 後も
  active gate を保持し、cancelled だけを policy TTL で消す。VTSE51/52 は tombstone null のため両 state を
  保持する。
- (ii) 確定 family は **VPWW56、volcanoAshfall、floodForecast、tornado、heatAlert、VPTA50、VPWP50、
  VXSE62** の8件である。`activeRetentionMs` と `tombstoneRetentionMs` が監査表の同一値であることを registry
  test で固定し、境界ちょうどで双方保持、+1msで双方削除する。
- VPTA50 は active と cancelled が7日+1msで gate から消え、projection も admission 前、startup、runtime
  の各経路で消える。既存 `phase3a-vpta-revision-gate.test.ts:149-165` の active 境界を維持する。
- flood は36h+1msで active gate、cancelled gate、holder、standby projection が同一 transaction の結果に
  そろう。`phase3b-flood.test.ts:590-625` の active gate / holder 期待を維持する。
- heatAlert は `activeRetentionMs === HEAT_RETENTION_MS` を固定する。
  `standby-wiring.test.ts:1654-1712` は `cancelled:false` seed のまま新 lifecycle API で3日+1msに失効させ、
  「admission 前 expiry は後続 candidate rejection で巻き戻らない」という本来の目的を維持する。
- VPWW56 は active / cancelled とも6時間ちょうどで残り、+1msで gate と coupled holder が消える。この境界は
  `process-message.ts:509-513` から `processWeather()` → `processWeatherWithAdmission()`
  （`src/engine/presentation/processors/process-weather.ts:25-105`）の production transaction を通す独立 test とする。
  同 test は非期限切れの active VPWP50 gate / projection を seed し、VPWW56 admission の前後で両 snapshot が
  deep equal であることも固定する。`processStandbyFoundation()` / generic callback-spy matrix は通さない。
  VTSE41 は7日+1msでも active gate / keyed warning / observation を保持し、cancelled だけが消える。
- active VPWP50 gate と非期限切れ projection を seed した状態から、tornado、heatAlert、VXSE62 を
  一 family ずつ generic admission transaction へ通す。各 transaction の前後で VPWP50 gate snapshot、
  weather-warning forecast projection、active subject 集合を deep equal とし、VPWP50 capacity latch と
  `[VPWP50] vpwp50ActiveBeyondGateRetention` warning call count も不変とする。各非 VPWP50 transaction では
  §3.5 の二 callback が呼ばれないことを spy で固定する。
- 同じ tornado、heatAlert、VXSE62 の table を `persistenceAdmission: undefined` でも実行し、coordinator なしの
  `ProcessDeps` に二 callback の spy を与える。direct branch が非 VPWP50 policy では両 field を `undefined` に
  override して `processStandbyFoundation()` を呼ぶこと、各 family の処理を完走しても元の spy が双方 exactly
  0 call であること、seed 済み VPWP50 gate / projection snapshot が不変であることを固定する。

### 5.3 指定 end-to-end 回帰

- `volcanoAlert` の acceptedAt から31日超の active を `sweepAll()` しても gate、
  `VolcanoStateHolder` alert slice、derived standby projection が残る。policy の `activeRetentionMs` は
  own-property を持たないことを assertion する。
- 同じ31日超の cancelled `volcanoAlert` は gate から消え、coupling 後に対象 holder / derived state が
  存在しない。active と cancelled を別 subject にして相互影響がないことも確認する。
- VPWP50 は active / cancelled とも7日+1msで消える。受信前 expiry と startup 先行 expiry の双方を通す。
- 31日超 active `volcanoAlert` を含む v2 を `save → 別 instance で loadWithResult → admission restore →
  startup sweep → save → 再 reload` し、gate entry、holder slice、standby projection、logical content を
  各段階で維持する。
- startup monitor composition test は同 v2 から起動し、最初の canonical save 後にも対象 active が残り、
  `startupSweep.value.durableChanged` が unrelated mutation なしには false であることを確認する。

## 6. テスト変更

- `test/engine/telegram-foundation/phase3a-revision-gate.test.ts` に §5.1 の synthetic matrix を追加する。
  同 file `:1230-1240` の VPWP50 期待値 `[active, cancelled] → []` は**変更しない**。呼出しを新 lifecycle
  API と policy の両 retention へ変更し、「全 family に tombstone TTL を適用」ではなく「VPWP50 は
  active / tombstone が同じ7日」として test 名を明確化する。同 file `:842-861` の capacity fixture も
  新 API 版を追加し、expiry による warning re-arm を固定する。
- `test/engine/telegram-foundation/phase3a-vpta-revision-gate.test.ts`、
  `phase3b-flood.test.ts` は既存 active expiry を維持し、cancelled と startup/runtime 経路を補う。
- `test/engine/display/standby-wiring.test.ts` は heat 回帰、coordinator の全 policy matrix、generic transaction と
  coordinator なし direct branch の VPWP50 callback 分離、`processWeatherWithAdmission()` を通る VPWW56 専用
  回帰、candidate rejection 非 rollback、save/reload を担当する。
- `test/engine/monitor/` の startup persistence composition test（又は既存
  `standby-wiring.test.ts:1986` 以降の startMonitor fixture）に31日 volcano と VPTA / VPWP50 を加える。
- 実装時は永続化・共有 state を変更するため、通常 build/test に加えて `npm run test:shuffle` を必須とする。

## 7. ロールバック

persistence schema は変えないため binary rollback は可能だが、旧 `sweepAll()` へ戻すと active の誤削除を
再導入する。特に裁定 A で残した30日超 `volcanoAlert` は、rollback 後の最初の sweep で失われ得る。
rollback 前に v2 canonical と v1 mirror を退避し、削除された gate / holder state は電文再取得なしに復元
できないことを運用上明記する。追加した `activeRetentionMs` を残したまま lifecycle API だけ戻す部分 rollback
は禁止する。policy の意味と全 caller を一単位で戻す。
