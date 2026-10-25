import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline,
  SubjectOutcome, WallBasis,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  LandslideCurrent, LandslideInput, LandslideIntent, LandslideKindGroup, LandslideNotificationPayload, LandslideUnitCodec,
  LandslideUnitState, LandslideUnitStep, LandslideUnitView, PersistedLandslideUnit,
} from "../../../contracts/p3-landslide-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { readReportRef, stepVersion } from "../../contracts-revision/version"; import { validReportDateTime } from "../../domains/flood/flood";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import {
  BOUNDS, FAMILY, INFO_RANK, LIMITS, cut, groupOrder, levelOf, parseLandslide, validAreaCode, validKindCode, validOffice, validSerial,
} from "../../domains/landslide/landslide";
import type { LandslideCandidate } from "../../domains/landslide/landslide";
import {
  applyIntentUpdate, cancelText, freshState, heard, markNotice, noticeId, noticeKind, noticed, raiseEvidence, readIntentState, readNoticeMark, restoreStarted,
  shown, updateEvidence, versionDigest,
} from "../notice-mark";
import { cachedMin } from "../expiry";

// P3-UNIT-L-001（C10、I-U-L）: U-L の官署の current・通知・容量・codec・射影。

const SCHEMA = "p3-landslide-unit-v6" as const;
// P3-C10-CAPACITY=A・P3-C10-RES-01・RET-01〜04。
const CURRENT_LIMIT = 128, GENERATION_LIMIT = 2_097_152;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C10-SEM-01・02（元報の ReportDateTime からの絶対の長さ、P3-C10-RETENTION=A・P3-C10-ACTIVE-EXPIRY=C）。
const HOUR_MS = 3_600_000;
const ACTIVE_RETAIN_MS = 48 * HOUR_MS, INACTIVE_RETAIN_MS = 6 * HOUR_MS, EXPIRED_RETAIN_MS = 54 * HOUR_MS; // 記憶は表示の期限＋6 時間（P3-EF-D-EXPIRED-MEMORY=A）
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;

type Active = Extract<LandslideCurrent, Readonly<{ effective: "active" }>>;
type Level = LandslideNotificationPayload["level"];
type InternalStep = Omit<LandslideUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = LandslideUnitStep["decisions"][number];
type Change = readonly [before: LandslideCurrent | null, after: LandslideCurrent | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// 保留の印のある active は見えない記録として扱う（P3-EF-AC02 (2)）。
const visible = (value: LandslideCurrent | null): value is Active => value?.effective === "active" && value.expiryPending !== true;

// ---- byte の加算（I-U-L.computation。受信 1 回で state 全体を直列化しない） ----

const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
const commas = (length: number) => Math.max(length - 1, 0);
const listBytes = (values: readonly object[]): number => 2 + commas(values.length) + values.reduce((sum, item) => sum + bytes(item), 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-L", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7): envelope の inputBoundary と losses の最大
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T・U-Q・U-N・U-V と同じ予約）。4: 空の配列 2 つ。
function generationBytes(value: PersistedLandslideUnit): number {
  return emptyEnvelopeBytes + 62 - 4 + listBytes(value.currents) + listBytes(value.intents);
}

// ---- 期限（I-U-L.deadlines） ----

// P3-EF-AC11 (2): 根拠で当てない種類を比べないよう、表示の期限・回収の期限・保留の記録・intent の期限を別々に持つ。
const displayMin = cachedMin<LandslideCurrent>((item) => visible(item) ? item.retainUntil : Infinity);
const recallMin = cachedMin<LandslideCurrent>((item) => item.effective !== "active" ? item.retainUntil : Infinity);
const pendingMin = cachedMin<LandslideCurrent>((item) => item.effective === "active" && item.expiryPending === true ? item.retainUntil : Infinity);
const intentMin = cachedMin<LandslideIntent>((item) => item.expiresAt);
// nextDeadline は根拠によらず全部の期限の最小（保留の記録は元の表示の期限、P3-EF-AC11 (2)）。
const retainMin = cachedMin<LandslideCurrent>((item) => item.retainUntil);
const deadlineAt = (state: LandslideUnitState): number =>
  Math.min(retainMin(state.currents), intentMin(state.intents));
function nextDeadline(state: LandslideUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: LandslideUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

// ---- 索引（配列に結び付けた Map。受信ごとに配列を探し直さない、I-U-L.computation） ----

const indexCache = new WeakMap<readonly LandslideCurrent[], ReadonlyMap<string, number>>();
function indexOf(values: readonly LandslideCurrent[], subject: string): number | undefined {
  let index = indexCache.get(values);
  if (index == null) { index = new Map(values.map((item, at) => [item.subject, at])); indexCache.set(values, index); }
  return index.get(subject);
}
function replaceAt<T>(values: readonly T[], index: number | undefined, value: T): readonly T[] {
  return index == null ? [...values, value] : values.map((item, at) => at === index ? value : item);
}

// P3-C10-CAPACITY=A と P3-OPCAP-AC01: 129 件目は (1) retainUntil を過ぎた記録 (2) inactive (3) training/test (4) normal の active、それぞれ
// ReportDateTime の古い順で退去する。受ける報が training/test なら normal の記録は (1)〜(4) とも候補にせず、候補が無ければ null
// （受けた記録自身を退去する）。
// ponytail: 満杯の 128 件の素朴な線形の走査（上限は CURRENT_LIMIT で、保持と decode の両方で効く。台帳 47 の例外）。
// 第 1 段は受けた入力の根拠が verified のときだけ。保留の印のある記録は見えない記録の段に入る（P3-EF-AC03）。
function evictOne(values: readonly LandslideCurrent[], now: number, incoming: Operation, verified: boolean): LandslideCurrent | null {
  const tier = (item: LandslideCurrent) => verified && item.retainUntil <= now ? 0 : !visible(item) ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: LandslideCurrent | null = null;
  for (const item of values) {
    if (item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// P3-VM-AC03: 官署ごとに compareVersion で比べる（報番号・InfoType の順位は使わない）。同じ版の中身には InfoType を含める。
// held は手元の版を残して印を付ける報（印は保存の byte に入るが、上界が予算の内側なので fit を要さない、P3-VM-AC08）。
function judge(existing: LandslideCurrent | null, built: LandslideCurrent, candidate: LandslideCandidate) {
  return stepVersion(existing == null ? null : { version: existing.source, source: existing.source, cancelled: existing.effective === "cancelled" },
    existing?.unconfirmed ?? null, candidate.source, () => existing != null && existing.source.infoTypeRaw === candidate.source.infoTypeRaw
    // 期限切れの記憶は事実を持たないので InfoType だけで見る（Q-EF-PRECHECK (0)(b)、U-M と同じ）。
    && (existing.effective === "expired" || changed(existing, built).length === 0), candidate.cancelled);
}

// ---- 官署の current（I-U-L.currentSemantics） ----

const FIELDS = ["effective", "title", "kinds"] as const;
function changed(before: LandslideCurrent | null, after: LandslideCurrent): string[] {
  const read = (value: LandslideCurrent | null, field: string): unknown => value == null ? null
    : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  return FIELDS.filter((field) => !isDeepStrictEqual(read(before, field), read(after, field)));
}
function currentOf(candidate: LandslideCandidate, existing: LandslideCurrent | null, now: number): LandslideCurrent {
  const base = { subject: candidate.subject, operation: candidate.operation, office: candidate.office, source: candidate.source };
  const inactive = (effective: "ended" | "cancelled"): LandslideCurrent =>
    ({ ...base, retainUntil: candidate.reportDateTimeMs + INACTIVE_RETAIN_MS, effective });
  if (candidate.cancelled) return inactive("cancelled");
  // (1) active の区域が無い報は ended（inactive の記録は見えないまま source だけが進む）。取消の記録も ended にし、続く解除の報で
  // inactiveAdoption を繰り返さない。記録の無い官署に受理の時点で ReportDateTime+6 時間を過ぎた active 相当の報は active にしない
  // （P3-C10-ACTIVE-EXPIRY=C、同じ reduce で回収する）。
  if (candidate.kinds.length === 0 || existing == null && candidate.reportDateTimeMs + INACTIVE_RETAIN_MS <= now) return inactive("ended");
  return { ...base, retainUntil: candidate.reportDateTimeMs + ACTIVE_RETAIN_MS, effective: "active", title: candidate.title,
    kinds: candidate.kinds, truncated: candidate.truncated };
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// P3-C10-NOTICE-LEVELS=B（作者裁定）: 表に無い code（null）は warning で、上がったかの比較ではレベル 3 と同じ順位。
const SOUND: ReadonlyMap<LandslideKindGroup["level"], Level> = new Map([[5, "critical"], [4, "warning"], [3, "warning"], [2, "normal"],
  [null, "warning"]]);
const LEVEL_ORDER: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
const rankOf = (level: LandslideKindGroup["level"]): number => level ?? 3;
// 採用前の記録より上がった区域（新しい区域か順位の上がった区域）の段階の最大。上がった区域が無ければ normal。
function levelFor(before: LandslideCurrent | null, after: Active): Level {
  const previous = new Map<string, number>();
  if (visible(before)) for (const group of before.kinds) for (const area of group.areas) previous.set(area, rankOf(group.level));
  let level: Level = "normal";
  for (const group of after.kinds) {
    const sound = SOUND.get(group.level) ?? "warning";
    if (LEVEL_ORDER.indexOf(sound) > LEVEL_ORDER.indexOf(level)
      && group.areas.some((area) => (previous.get(area) ?? -Infinity) < rankOf(group.level))) level = sound;
  }
  return level;
}
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title、本文は Kind の名前ごとの区域の数と Headline（旧築 notifier.ts の組み方を区分ごとに）。
// 取消は取り消した記録の ReportDateTime（cancelledAt）を書く（P3-NL-AC10）。
function payloadOf(candidate: LandslideCandidate, after: LandslideCurrent, level: Level, cancelledAt: string | null = null): LandslideNotificationPayload {
  const prefix = PREFIX[candidate.operation];
  if (candidate.cancelled) {
    const text = cancelText(candidate.title, cancelledAt);
    return { domain: "weather", level: "cancel", title: cut(prefix + text.title, NOTICE_BOUNDS.title), body: cut(text.body, NOTICE_BOUNDS.body) };
  }
  const correction = candidate.infoRank === 2;
  const groups = visible(after) ? after.kinds.map((group) => `${group.name} ${group.areas.length}地域`) : [];
  const body = groups.length === 0 ? candidate.headline ?? candidate.title : [...groups, ...candidate.headline == null ? [] : [candidate.headline]].join(" / ");
  return { domain: "weather", level, title: cut(prefix + (correction ? `[訂正] ${candidate.title}` : candidate.title), NOTICE_BOUNDS.title),
    body: cut(correction ? `訂正: ${body}` : body, NOTICE_BOUNDS.body) };
}
// P3-NL-AC01: ID は世代番号を含まない。官署の系列の印に同じ版の鍵と種類があれば作らない。
function intentsFor(candidate: LandslideCandidate, transition: LandslideIntent["transition"], payload: LandslideNotificationPayload,
  now: number, mark: NoticeMark | undefined, version: string): LandslideIntent[] {
  if (noticed(mark, version, noticeKind(transition))) return [];
  // P3-C10-TRAINING=A: training/test は desktop だけ。
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: noticeId("U-L", candidate.subject, "", candidate.source, transition, channel), unit: "U-L",
    subject: candidate.subject, operation: candidate.operation, source: candidate.source, transition, channel, payload, createdAt: now,
    expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending",
    ...freshState("U-L", candidate.operation) }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-L の intent は全部 other の群（P3-C10-NOTICE-GROUP=A）。
function a7Order(left: LandslideIntent, right: LandslideIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// Q-NOTICE.capacity と P3-C10-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
function admit(current: readonly LandslideIntent[], fresh: readonly LandslideIntent[], cancelled: string | null):
  Readonly<{ intents: readonly LandslideIntent[]; admitted: readonly LandslideIntent[]; dropped: number }> {
  const superseded = new Set<LandslideIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.subject === cancelled || replaced.has(`${item.subject}\n${item.channel}`)) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => !superseded.has(item)), ...fresh];
  const out = new Set<LandslideIntent>();
  // 同じ群の中で A7 の選択順の後ろのものから外す。予約は配送の更新で伸びうる byte（P3-INTENT-UPDATE-RESERVE-001、式は写さない）。
  let count = pool.length, size = listBytes(pool) + pool.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  if (count > PENDING_ITEMS || size > PENDING_BYTES)
    for (const item of [...pool].sort(a7Order).reverse()) {
      if (count <= PENDING_ITEMS && size <= PENDING_BYTES) break;
      out.add(item);
      count--;
      size -= bytes(item) + 1 + deliveryGrowth(item);
    }
  const admitted = fresh.filter((item) => !out.has(item));
  // 新しい intent が容量で外れただけなら、既存の intent は変わらないので元の配列を返す（C9 の Q-C9-IMPL-AMEND(9)(e)）。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  // P3-NL-AC05 (1)(2): 置換・退去した intent は外す（結果は系列の印に残り、終端記録の予算と回収は無い）。
  const intents = [...current.filter((item) => !superseded.has(item) && !out.has(item)), ...admitted];
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- outcome と view ----

function factsOf(value: LandslideCurrent): Readonly<Record<string, JsonValue>> {
  return visible(value) ? { office: value.office, effective: value.effective, title: value.title, kinds: value.kinds, truncated: value.truncated }
    : { office: value.office, effective: value.effective };
}
function outcomeOf(value: LandslideCurrent, changedFields: readonly string[], extra: Readonly<Record<string, JsonValue>> = {}): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: { ...factsOf(value), ...extra }, changedFields };
}
// view の subject は識別だけを持つ（事実は currents にあり、二重に載せると snapshot の予算を食う。U-Q・U-N・U-V の先例）。
const outcomeCache = new WeakMap<LandslideCurrent, SubjectOutcome>();
function shownOutcome(value: LandslideCurrent): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = { ...outcomeOf(value, []), facts: { office: value.office, effective: value.effective } };
    outcomeCache.set(value, found);
  }
  return found;
}
function displaySubject(value: LandslideCurrent): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-L" }>> {
  return { unit: "U-L", operation: value.operation, subject: value.subject, office: value.office, current: visible(value) ? shown(value) : null,
    subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C10-SUBJECTS=A。一入力は官署の subject を 1 つだけ変え、一回の参照交換で確定する） ----

function receiveCandidate(state: LandslideUnitState, candidate: LandslideCandidate, clock: ClockReading, basis: WallBasis): Result {
  const now = clock.wallTimeMs;
  const { subject, operation } = candidate;
  const index = indexOf(state.currents, subject);
  const existing = index == null ? null : state.currents[index];
  const built = currentOf(candidate, existing, now), version = judge(existing, built, candidate);
  const warn = (missing: boolean): DiagnosticDetails => ({ level: "WARN", component: "landslide", inputId: candidate.source.inputId, unit: "U-L",
    reason: missing ? "requiredStructureMissing" : "landslideRevisionConflict" });
  // 取消以前の版は stale で、取消した subject を戻さない。同じ版で中身が同じなら duplicate、違えば先着を保って印を付ける（P3-VM-AC04）。
  if (version.kind !== "adopt") {
    const marked = version.kind !== "held" || existing == null || version.mark == null || existing.unconfirmed === version.mark ? state
      : { ...state, currents: replaceAt(state.currents, index, { ...existing, unconfirmed: version.mark }), persistence: dirty(state.persistence, clock.monotonicMs) };
    return { changes: [], step: { ...idle(marked), decisions: [{ subject, operation, decision: "unchanged", reason: version.kind === "duplicate" ? "duplicate" : "stale" }],
      diagnostics: version.kind === "held" ? [warn(version.missing)] : [] } };
  }
  // P3-NL-AC02 (2)(4): 通知の印は記録へ引き継ぐ。
  let next: LandslideCurrent = { ...built, ...version.mark == null ? {} : { unconfirmed: version.mark },
    ...existing?.notice == null ? {} : { notice: existing.notice } };
  const fields = visible(existing) || visible(next) ? changed(existing, next) : [];
  // 最終の状態に記録が残らない受理（遅着・自身の退去）は accepted に載せず currentEstablished も null（D-VANISHED=A、P3-OPCAP-AC02）。
  const decided = (change: "semantic" | "revisionOnly", kept = true): Decision => ({ subject, operation, decision: "changed", reason: null, change,
    currentEstablished: kept ? { family: FAMILY, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } : null });
  const accepted = (change: "semantic" | "revisionOnly", kept = true) => ({ kind: "accepted" as const, change,
    subjects: kept ? [outcomeOf(next, fields, visible(next) ? { areaNames: candidate.areaNames } : {})] : [] });
  const due = next.retainUntil <= now;
  // current を残さない受理でも、採用した取消はその subject の pending を置き換える（Q-C10-IMPL-AMEND(5)）。currents の参照は保ち、
  // intents が変わったときだけ保存世代を進める。
  const unkept = (): LandslideUnitState => {
    const notices = candidate.cancelled ? admit(state.intents, [], subject) : null;
    return notices == null || notices.intents === state.intents ? state
      : { ...state, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };
  };
  // 到着の時点で期限を過ぎた報は、記録が無ければ同じ reduce で回収して正味の current が変わらない（退去しない、P3-C10-RETENTION=A）。
  if (due && existing == null) {
    const change = fields.length !== 0 ? "semantic" as const : "revisionOnly" as const;
    return { changes: [], step: { ...idle(unkept()), decisions: [decided(change, false)], outcomes: [accepted(change, false)] } };
  }

  let currents: readonly LandslideCurrent[];
  let evicted: LandslideCurrent | null = null;
  if (index == null && state.currents.length >= CURRENT_LIMIT) {
    evicted = evictOne(state.currents, now, operation, basis === "verified");
    // training/test の報で退去できる記録が無ければ、受けた記録自身を退去する（currents の参照を変えない、通知しない）。
    if (evicted == null) return { changes: [], step: { ...idle(unkept()), decisions: [decided("revisionOnly", false)],
      outcomes: [accepted("revisionOnly", false)],
      diagnostics: [{ level: "INFO", component: "landslide", reason: "landslideCapacityEvicted", unit: "U-L", count: 1 }] } };
    const gone = evicted;
    currents = [...state.currents.filter((item) => item !== gone), next];
  } else currents = replaceAt(state.currents, index, next);
  // 退去を伴う受理は decision も outcome も semantic（U-N と同じ）。
  const change = fields.length !== 0 || evicted != null ? "semantic" as const : "revisionOnly" as const;

  // Q-NOTICE.generationTable。訂正は事実が同じでも作る。記録の無い官署か取消の記録への解除の報（inactiveAdoption）も作る。
  // 期限で回収される報・記憶だけの取消・endedの記録への解除では作らない。
  const correction = candidate.infoRank === 2;
  // P3-NL-AC09 (1): 取消は active だったか、系列の印に通知の証拠があるとき（H19）。
  const notify = !due && (candidate.cancelled ? visible(existing) || heard(existing?.notice) : correction || (visible(next) ? !visible(existing) || fields.length !== 0
    : visible(existing) || candidate.released && (existing == null || existing.effective === "cancelled")));
  const transition = candidate.cancelled ? "cancelled" as const : correction ? "updated" as const
    : visible(next) ? visible(existing) ? "updated" as const : "activated" as const : "released" as const;
  const level = candidate.cancelled ? "cancel" : visible(next) ? levelFor(existing, next) : "normal";
  // 版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const digest = notify ? versionDigest(candidate.source) : "";
  const fresh = notify ? intentsFor(candidate, transition, payloadOf(candidate, next, level, existing?.source.reportDateTimeRaw ?? null), now,
    existing?.notice, digest) : [];
  // 到着の時点で期限を過ぎた採用が前の active を置き換えるなら、取消でなくてもその pending を全部撤回する（D-WITHDRAW=A、P3-OPCAP-AC03）。
  const notices = admit(state.intents, fresh, candidate.cancelled || due && visible(existing) ? subject : null);
  // P3-NL-AC02 (3): admit を通った版と種類を官署の系列の印に足す（全 channel が断られた版は入れない）。
  if (notices.admitted.length !== 0) {
    const unmarked = next;
    next = { ...unmarked, notice: markNotice(unmarked.notice, digest, noticeKind(transition)) };
    currents = currents.map((item) => item === unmarked ? next : item);
  }
  const adopted: LandslideUnitState = { ...state, currents, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) };
  // 到着の時点で期限を過ぎた記録は採用して watermark を進め、同じ reduce で回収する（P3-C10-RETENTION=A）。
  const collected = deadlineAt(adopted) <= now ? collect(adopted, clock, basis) : null;
  const result = collected?.state ?? adopted;
  const diagnostics: DiagnosticDetails[] = version.missing ? [warn(true)] : [];
  if (evicted != null) diagnostics.push({ level: "INFO", component: "landslide", reason: "landslideCapacityEvicted", unit: "U-L", count: 1 });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "landslide", reason: "notificationCapacityEvicted", unit: "U-L",
    count: notices.dropped });
  return {
    changes: [...evicted == null ? [] : [[evicted, null] as const], [existing, next], ...collected?.changes ?? []],
    step: { state: result, nextDeadline: nextDeadline(result), decisions: [decided(change, !due)], intents: notices.admitted,
      outcomes: [accepted(change, !due)], diagnostics },
  };
}

function receive(state: LandslideUnitState, input: Extract<LandslideInput, { kind: "receive" }>): Result {
  const parsed = parseLandslide(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C10-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  return receiveCandidate(state, candidate, input.clock, input.basis ?? "verified");
}

// ---- 期限（I-U-L.deadlines。到来分だけを回収する） ----

// 期限切れの記憶（P3-EF-AC05 (2)(3)）: 事実を捨て、識別・source・印を残す。
function expiredOf(item: Active): LandslideCurrent {
  return { subject: item.subject, operation: item.operation, office: item.office, source: item.source,
    ...item.unconfirmed == null ? {} : { unconfirmed: item.unconfirmed }, ...item.notice == null ? {} : { notice: item.notice },
    retainUntil: reportMs(item.source) + EXPIRED_RETAIN_MS, effective: "expired" };
}

// 根拠ごとの当て方（P3-EF-AC02）: awaiting は何も当てない。unverified は表示の期限の来た記録に保留の印を付けるだけ。verified は表示の
// 期限の来た記録と保留の記録（時計によらず）を記憶に移し、retainUntil の来た記録と intent を回収する。
// ponytail: 128 官署の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: LandslideUnitState, clock: ClockReading, basis: WallBasis): Readonly<{ state: LandslideUnitState; changes: readonly Change[];
  expiredIntents: number }> {
  const now = clock.wallTimeMs, verified = basis === "verified";
  const shows = basis !== "awaiting" && displayMin(state.currents) <= now;
  const recalls = verified && (recallMin(state.currents) <= now || pendingMin(state.currents) !== Infinity);
  if (!shows && !recalls && !(verified && intentMin(state.intents) <= now)) return { state, changes: [], expiredIntents: 0 };
  const changes: Change[] = [];
  // P3-C10-ACTIVE-EXPIRY=C: 表示の期限切れも回収も通知しない。
  const currents = !shows && !recalls ? state.currents : state.currents.flatMap((item): LandslideCurrent[] => {
    let after: LandslideCurrent | null = item;
    if (item.effective === "active" && (item.expiryPending === true || item.retainUntil <= now))
      after = verified ? expiredOf(item) : item.expiryPending === true ? item : { ...item, expiryPending: true };
    if (verified && after.effective !== "active" && after.retainUntil <= now) after = null;
    if (after !== item) changes.push([item, after]);
    return after == null ? [] : [after];
  });
  const intents = !verified || intentMin(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - intents.length;
  const persisted = changes.length !== 0 || intents !== state.intents;
  return { state: persisted ? { ...state, currents: changes.length === 0 ? state.currents : currents, intents,
    persistence: dirty(state.persistence, clock.monotonicMs) } : state, changes, expiredIntents };
}

function deadlineStep(state: LandslideUnitState, clock: ClockReading, basis: WallBasis, shutdown: boolean): Result {
  const applied = collect(state, clock, basis);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "landslide",
    reason: "notificationExpired", unit: "U-L", count: applied.expiredIntents }];
  return { changes: applied.changes, step: { ...idle(applied.state),
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] : [], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

// P3-NL-AC02 (3)・AC08 (1): intent の官署の系列の印の証拠を上げる（下げない）。
function raiseNotices(state: LandslideUnitState, raised: ReadonlyMap<string, NoticeEvidence>): LandslideUnitState {
  let currents = state.currents;
  for (const [subject, evidence] of raised) {
    const at = indexOf(currents, subject), found = currents[at ?? -1];
    const notice = found?.notice == null ? undefined : raiseEvidence(found.notice, evidence);
    if (found != null && notice !== found.notice) currents = replaceAt(currents, at, { ...found, notice });
  }
  return currents === state.currents ? state : { ...state, currents };
}

function intentUpdate(state: LandslideUnitState, input: Extract<LandslideInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, LandslideIntent>();
  const raised = new Map<string, NoticeEvidence>();
  for (const update of updates) {
    const current = originals.get(update.id);
    const updated = current == null ? null : applyIntentUpdate(current, update);
    if (updated == null) continue;
    changedIntents.set(updated.id, updated);
    const evidence = updateEvidence(updated);
    if (evidence != null) raised.set(updated.subject, evidence);
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7〜C9 の先例）。pending でなくなった intent は外す（P3-NL-AC05 (1)）。
  const next = { ...raiseNotices(state, raised), intents: state.intents.flatMap((item) => {
    const updated = changedIntents.get(item.id);
    return updated == null ? [item] : updated.disposition === "pending" ? [updated] : [];
  }), persistence: dirty(state.persistence, input.clock.monotonicMs) };
  const adopted = [...changedIntents.values()];
  return { changes: [], step: { ...idle(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "deliveryOnly" as const, currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted" as const, change: "deliveryOnly" as const, subjects: [{ subject: item.subject,
      operation: item.operation, informationType: item.source.infoTypeRaw, transition: item.disposition, severity: null,
      source: item.source, facts: { intentId: item.id, channel: item.channel }, changedFields: ["intents"] }] })) } };
}

function restore(state: LandslideUnitState, persisted: PersistedLandslideUnit, clock: ClockReading, basis: WallBasis): Result {
  const decoded = landslideUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "landslide",
    reason: "requiredStructureInvalid", unit: "U-L" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。P3-NL-AC08 (1): started のまま残った
  // pending は通知したか不明として外し、系列の印の証拠を unknown にする。
  const restored = restoreStarted(decoded.state.intents);
  const base = { ...raiseNotices(decoded.state, new Map(restored.started.map((item) => [item.subject, "unknown" as const]))),
    intents: restored.intents, persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const applied = collect(base, clock, basis);
  const active = applied.state.currents.filter(visible);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "landslide",
    reason: "notificationExpired", unit: "U-L", count: applied.expiredIntents }];
  if (restored.started.length !== 0) diagnostics.push({ level: "INFO", component: "landslide", reason: "notificationOutcomeUnknown",
    unit: "U-L", count: restored.started.length });
  return { changes: active.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-L"], coverage: active.map((item) => item.subject), subjects: [] }], diagnostics } };
}

function reduceCore(state: LandslideUnitState, input: LandslideInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock, input.basis ?? "verified");
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, input.basis ?? "verified", false);
    case "shutdown": return deadlineStep(state, input.clock, input.basis ?? "verified", true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`landslide input ${String(missing)} is not handled`); }
  }
}

function reduceLandslideUnit(state: LandslideUnitState, input: LandslideInput): LandslideUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: LandslideCurrent | null; after: LandslideCurrent | null }>();
  for (const [before, after] of changes) {
    const key = (after ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: LandslideUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-L", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-L content revision exhausted");
  // P3-C10-N2: U-L は確認 scope を作らない。
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toLandslideView(state: LandslideUnitState): LandslideUnitView {
  const currents = state.currents.filter(visible);
  const subjects = currents.map(shownOutcome);
  return { unit: "U-L", semanticRevision: subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`).sort().join("|"),
  contentRevision: String(state.contentRevision), subjects, currents: currents.map((item) => shown(item)) };
}

// ---- codec（I-U-L.persisted・I-U-L.decode、唯一の LandslideUnitCodec） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const bounded = (value: unknown, limit: number): value is string => isText(value) && value.length <= limit;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null, limit = Infinity): T[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}
// I-U-L.subjects の形（`${operation}/VPWW56/${office}`、官署は Q-ENUM.identity の文字と長さ）。
function subjectOperation(subject: string): Operation | null {
  const match = /^(normal|training|test)\/VPWW56\/([\s\S]*)$/.exec(subject);
  return match == null || !validOffice(match[2]) ? null : operationOf(match[1]);
}
function reportRef(value: unknown, subject: string): ReportRef | null {
  const ref = readReportRef(value, LIMITS.controlDateTime);
  return ref == null || ref.family !== FAMILY || ref.subject !== subject || subjectOperation(subject) !== ref.operation
    // P3-VM-AC08: ReportDateTime は受理（A1）と同じ形だけを受ける（Date.parse は括弧の中の任意の文字を読み飛ばす）。
    || !validReportDateTime(ref.reportDateTimeRaw) || !validSerial(ref.serialRaw) || !INFO_RANK.has(ref.infoTypeRaw) ? null : ref;
}
// 受理と同じ上限（group 8・区域の延べ 256・code の形・level と code の一致・types.ts の順）。
function kindsRecord(value: unknown): LandslideKindGroup[] | null {
  const groups = list(value, (entry) => {
    const row = record(entry);
    const areas = list(row?.areas, (area) => isText(area) && validAreaCode(area) ? area : null, LIMITS.items);
    if (row == null || areas == null || areas.length === 0 || !isText(row.code) || !validKindCode(row.code) || row.code === "00"
      || !bounded(row.name, BOUNDS.kindName) || row.level !== levelOf(row.code)) return null;
    return { code: row.code, name: row.name, level: levelOf(row.code), areas };
  }, LIMITS.kinds);
  if (groups == null || groups.length === 0 || new Set(groups.map((item) => item.code)).size !== groups.length
    || groups.reduce((sum, item) => sum + item.areas.length, 0) > LIMITS.items
    || groups.some((item, at) => at > 0 && groupOrder(groups[at - 1], item) >= 0)) return null;
  return groups;
}
const FACT_KEYS = ["title", "kinds", "truncated", "expiryPending"];
function currentRecord(value: unknown): LandslideCurrent | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !isText(row.office) || !validOffice(row.office) || row.subject !== `${operation}/${FAMILY}/${row.office}`)
    return null;
  const source = reportRef(row.source, row.subject);
  if (source == null) return null;
  // P3-VM-AC04: 印は同じ官署（subject・operation）の報（取消の後の時刻の無い報の印も残る）。
  const mark = "unconfirmed" in row ? reportRef(row.unconfirmed, row.subject) : undefined;
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (mark === null || notice === null) return null;
  const base = { subject: row.subject, operation, office: row.office, source, ...mark == null ? {} : { unconfirmed: mark },
    ...notice == null ? {} : { notice } };
  if (row.effective !== "active") {
    // active 以外は事実を持たない（types.ts の判別共用体）。
    // 記憶は元報＋54 時間、ended・cancelled は＋6 時間の等式（P3-EF-AC14 (20)）。
    if (FACT_KEYS.some((key) => key in row)
      || row.retainUntil !== reportMs(source) + (row.effective === "expired" ? EXPIRED_RETAIN_MS : INACTIVE_RETAIN_MS)) return null;
    return row.effective === "ended" || row.effective === "cancelled" || row.effective === "expired"
      ? { ...base, retainUntil: row.retainUntil, effective: row.effective } : null;
  }
  const kinds = kindsRecord(row.kinds);
  if (kinds == null || !bounded(row.title, BOUNDS.title) || typeof row.truncated !== "boolean"
    || row.retainUntil !== reportMs(source) + ACTIVE_RETAIN_MS || "expiryPending" in row && row.expiryPending !== true) return null;
  return { ...base, retainUntil: row.retainUntil, effective: "active", title: row.title, kinds, truncated: row.truncated,
    ...row.expiryPending === true ? { expiryPending: true } : {} };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): LandslideIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const source = isText(row?.subject) ? reportRef(row.source, row.subject) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-L", operation, level);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-L.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || fields == null || !isText(row.id) || row.unit !== "U-L" || !isText(row.subject) || source.operation !== operation
    || payload.domain !== "weather" || !isText(payload.title) || payload.title === "" || !isText(payload.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-L", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition: "pending", ...fields };
}
function persisted(value: unknown): PersistedLandslideUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord, CURRENT_LIMIT), intents = list(row.intents, intentRecord);
  if (currents == null || intents == null || new Set(currents.map((item) => item.subject)).size !== currents.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。保存する intent は pending だけ（P3-NL-AC05）。
  const pendingBytes = listBytes(intents) + intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedLandslideUnit = { schemaVersion: SCHEMA, currents, intents };
  if (intents.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || generationBytes(result) > GENERATION_LIMIT) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const landslideUnitCodec: LandslideUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p3-landslide-unit-v1", "p3-landslide-unit-v2", "p3-landslide-unit-v3", "p3-landslide-unit-v4", "p3-landslide-unit-v5"], maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  // contentRevision・persistence は保存しない（I-U-L.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-landslide-unit-v6 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-L.runtimeRows）。
const landslideUnit = {
  unit: "U-L",
  reduce: reduceLandslideUnit,
  toView: toLandslideView,
  persistence: { kind: "durable", codec: landslideUnitCodec },
  confirmationScopeLimit: 512,
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-L">;

export { landslideUnit, landslideUnitCodec, reduceLandslideUnit, toLandslideView };
