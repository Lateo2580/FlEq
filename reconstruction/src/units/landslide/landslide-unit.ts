import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline, SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  LandslideCurrent, LandslideInput, LandslideIntent, LandslideKindGroup, LandslideNotificationPayload, LandslideUnitCodec,
  LandslideUnitState, LandslideUnitStep, LandslideUnitView, PersistedLandslideUnit,
} from "../../../contracts/p3-landslide-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import {
  BOUNDS, FAMILY, INFO_RANK, LIMITS, cut, groupOrder, levelOf, parseLandslide, validAreaCode, validKindCode, validOffice, validSerial,
} from "../../domains/landslide/landslide";
import type { LandslideCandidate } from "../../domains/landslide/landslide";

// P3-UNIT-L-001（C10、I-U-L）: U-L の官署の current・通知・容量・codec・射影。

const SCHEMA = "p3-landslide-unit-v1" as const;
// P3-C10-CAPACITY=A・P3-C10-RES-01・RET-01〜04。
const CURRENT_LIMIT = 128, GENERATION_LIMIT = 2_097_152;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 98_304;
// P3-C10-SEM-01・02（元報の ReportDateTime からの絶対の長さ、P3-C10-RETENTION=A・P3-C10-ACTIVE-EXPIRY=C）。
const HOUR_MS = 3_600_000;
const ACTIVE_RETAIN_MS = 48 * HOUR_MS, INACTIVE_RETAIN_MS = 6 * HOUR_MS;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;

type Active = Extract<LandslideCurrent, Readonly<{ effective: "active" }>>;
type Level = LandslideNotificationPayload["level"];
type InternalStep = Omit<LandslideUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = LandslideUnitStep["decisions"][number];
type Change = readonly [before: LandslideCurrent | null, after: LandslideCurrent | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
const visible = (value: LandslideCurrent | null): value is Active => value?.effective === "active";

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
// 終端記録の合計（区切りの 1 byte を含む）。受理と decode で同じ式を使う（Q-NOTICE.capacity）。
const terminalBytes = (intents: readonly LandslideIntent[]): number =>
  intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-L", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T・U-Q・U-N・U-V と同じ予約）。4: 空の配列 2 つ。
function generationBytes(value: PersistedLandslideUnit): number {
  return emptyEnvelopeBytes + 62 - 4 + listBytes(value.currents) + listBytes(value.intents);
}

// ---- 期限（I-U-L.deadlines） ----

const deadlineCache = new WeakMap<readonly object[], number>();
function minOf<T extends object>(values: readonly T[], at: (value: T) => number): number {
  let min = deadlineCache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); deadlineCache.set(values, min); }
  return min;
}
const deadlineAt = (state: LandslideUnitState): number =>
  Math.min(minOf(state.currents, (item) => item.retainUntil), minOf(state.intents, (item) => item.expiresAt));
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

// P3-C10-CAPACITY=A: 129 件目は (1) retainUntil を過ぎた記録 (2) inactive (3) training/test (4) 受ける報が normal のときだけ normal、
// それぞれ ReportDateTime の古い順で退去する。受ける報が training/test で (1)〜(3) が無ければ null（受けた記録自身を退去する）。
// ponytail: 満杯の 128 件の素朴な線形の走査（上限は CURRENT_LIMIT で、保持と decode の両方で効く。台帳 47 の例外）。
function evictOne(values: readonly LandslideCurrent[], now: number, incoming: Operation): LandslideCurrent | null {
  const tier = (item: LandslideCurrent) => item.retainUntil <= now ? 0 : item.effective !== "active" ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: LandslideCurrent | null = null;
  for (const item of values) {
    if (tier(item) === 3 && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// P3-ORDER-AC01: ReportDateTime → InfoType の優先 → Serial（数として。欠落はどの数値よりも小）の辞書順。
function compare(candidate: LandslideCandidate, source: ReportRef): number {
  const time = candidate.reportDateTimeMs - reportMs(source);
  if (time !== 0) return Math.sign(time);
  const rank = candidate.infoRank - (INFO_RANK.get(source.infoTypeRaw) ?? 0);
  if (rank !== 0) return Math.sign(rank);
  const left = candidate.source.serialRaw, right = source.serialRaw;
  return left === right ? 0 : left === "" ? -1 : right === "" ? 1 : Math.sign(Number(left) - Number(right));
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
function payloadOf(candidate: LandslideCandidate, after: LandslideCurrent, level: Level): LandslideNotificationPayload {
  const prefix = PREFIX[candidate.operation];
  if (candidate.cancelled) return { domain: "weather", level: "cancel", title: cut(`${prefix}[取消] ${candidate.title}`, NOTICE_BOUNDS.title),
    body: "この情報は取り消されました" };
  const correction = candidate.infoRank === 2;
  const groups = visible(after) ? after.kinds.map((group) => `${group.name} ${group.areas.length}地域`) : [];
  const body = groups.length === 0 ? candidate.headline ?? candidate.title : [...groups, ...candidate.headline == null ? [] : [candidate.headline]].join(" / ");
  return { domain: "weather", level, title: cut(prefix + (correction ? `[訂正] ${candidate.title}` : candidate.title), NOTICE_BOUNDS.title),
    body: cut(correction ? `訂正: ${body}` : body, NOTICE_BOUNDS.body) };
}
function intentsFor(candidate: LandslideCandidate, transition: LandslideIntent["transition"], payload: LandslideNotificationPayload,
  generation: number, now: number): LandslideIntent[] {
  // P3-C10-TRAINING=A: training/test は desktop だけ。
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: `U-L:${candidate.subject}:${generation}:${channel}`, unit: "U-L", subject: candidate.subject,
    operation: candidate.operation, source: candidate.source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-L の intent は全部 other の群（P3-C10-NOTICE-GROUP=A）。
function a7Order(left: LandslideIntent, right: LandslideIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 終端記録の合計が 98,304 byte を超える分は、最古の終端記録から期限前に回収する。kept は今の配送の更新で終端にした記録で、回収しない
// （owner は更新した記録が残ることで照合する。C8 の Q-C8-IMPL-AMEND(1)）。kept だけで上限を超える分は元の pending の byte の内側。
function trimTerminal(intents: readonly LandslideIntent[], kept: ReadonlySet<string> = new Set()): readonly LandslideIntent[] {
  let terminal = terminalBytes(intents);
  if (terminal <= TERMINAL_BYTES) return intents;
  const gone = new Set<LandslideIntent>();
  for (const item of intents.filter((value) => value.disposition !== "pending" && !kept.has(value.id))
    .sort((left, right) => left.createdAt - right.createdAt)) {
    if (terminal <= TERMINAL_BYTES) break;
    gone.add(item);
    terminal -= bytes(item) + 1;
  }
  return intents.filter((item) => !gone.has(item));
}
// Q-NOTICE.capacity と P3-C10-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
function admit(current: readonly LandslideIntent[], fresh: readonly LandslideIntent[], cancelled: string | null):
  Readonly<{ intents: readonly LandslideIntent[]; admitted: readonly LandslideIntent[]; dropped: number }> {
  const superseded = new Set<LandslideIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.disposition === "pending" && (item.subject === cancelled || replaced.has(`${item.subject}\n${item.channel}`))) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
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
  // 新しい intent が容量で外れただけなら、既存の intent も終端記録も変わらないので元の配列を返す（C9 の Q-C9-IMPL-AMEND(9)(e)）。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  const intents = trimTerminal([...current.map((item) => superseded.has(item) || out.has(item)
    ? { ...item, disposition: "superseded" as const } : item), ...admitted]);
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
  return { unit: "U-L", operation: value.operation, subject: value.subject, office: value.office, current: visible(value) ? value : null,
    subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C10-SUBJECTS=A。一入力は官署の subject を 1 つだけ変え、一回の参照交換で確定する） ----

function receiveCandidate(state: LandslideUnitState, candidate: LandslideCandidate, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const { subject, operation } = candidate;
  const index = indexOf(state.currents, subject);
  const existing = index == null ? null : state.currents[index];
  const next = currentOf(candidate, existing, now);
  if (existing != null) {
    const order = compare(candidate, existing.source);
    // 取消以前の版は stale で、取消した subject を戻さない。同じ版・同じ InfoType は事実が同じなら duplicate、違えば先着を保つ。
    if (order <= 0) {
      const same = order === 0 && isDeepStrictEqual(changed(existing, next), []);
      return { changes: [], step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason: same ? "duplicate" : "stale" }],
        diagnostics: order === 0 && !same ? [{ level: "WARN", component: "landslide", reason: "landslideRevisionConflict",
          inputId: candidate.source.inputId, unit: "U-L" }] : [] } };
    }
  }
  const fields = visible(existing) || visible(next) ? changed(existing, next) : [];
  const decided = (change: "semantic" | "revisionOnly"): Decision => ({ subject, operation, decision: "changed", reason: null, change,
    currentEstablished: { family: FAMILY, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } });
  const accepted = (change: "semantic" | "revisionOnly") => ({ kind: "accepted" as const, change,
    subjects: [outcomeOf(next, fields, visible(next) ? { areaNames: candidate.areaNames } : {})] });
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
    return { changes: [], step: { ...idle(unkept()), decisions: [decided(change)], outcomes: [accepted(change)] } };
  }

  let currents: readonly LandslideCurrent[];
  let evicted: LandslideCurrent | null = null;
  if (index == null && state.currents.length >= CURRENT_LIMIT) {
    evicted = evictOne(state.currents, now, operation);
    // training/test の報で退去できる記録が無ければ、受けた記録自身を退去する（currents の参照を変えない、通知しない）。
    if (evicted == null) return { changes: [], step: { ...idle(unkept()), decisions: [decided("semantic")], outcomes: [accepted("semantic")],
      diagnostics: [{ level: "INFO", component: "landslide", reason: "landslideCapacityEvicted", unit: "U-L", count: 1 }] } };
    const gone = evicted;
    currents = [...state.currents.filter((item) => item !== gone), next];
  } else currents = replaceAt(state.currents, index, next);
  // 退去を伴う受理は decision も outcome も semantic（U-N と同じ）。
  const change = fields.length !== 0 || evicted != null ? "semantic" as const : "revisionOnly" as const;

  // Q-NOTICE.generationTable。訂正は事実が同じでも作る。記録の無い官署か取消の記録への解除の報（inactiveAdoption）も作る。
  // 期限で回収される報・記憶だけの取消・endedの記録への解除では作らない。
  const correction = candidate.infoRank === 2;
  const notify = !due && (candidate.cancelled ? visible(existing) : correction || (visible(next) ? !visible(existing) || fields.length !== 0
    : visible(existing) || candidate.released && (existing == null || existing.effective === "cancelled")));
  const transition = candidate.cancelled ? "cancelled" as const : correction ? "updated" as const
    : visible(next) ? visible(existing) ? "updated" as const : "activated" as const : "released" as const;
  const level = candidate.cancelled ? "cancel" : visible(next) ? levelFor(existing, next) : "normal";
  const fresh = notify ? intentsFor(candidate, transition, payloadOf(candidate, next, level), state.persistence.currentGeneration + 1, now) : [];
  const notices = admit(state.intents, fresh, candidate.cancelled ? subject : null);
  const adopted: LandslideUnitState = { ...state, currents, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };
  // 到着の時点で期限を過ぎた記録は採用して watermark を進め、同じ reduce で回収する（P3-C10-RETENTION=A）。
  const collected = deadlineAt(adopted) <= now ? collect(adopted, clock) : null;
  const result = collected?.state ?? adopted;
  const diagnostics: DiagnosticDetails[] = [];
  if (evicted != null) diagnostics.push({ level: "INFO", component: "landslide", reason: "landslideCapacityEvicted", unit: "U-L", count: 1 });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "landslide", reason: "notificationCapacityEvicted", unit: "U-L",
    count: notices.dropped });
  return {
    changes: [...evicted == null ? [] : [[evicted, null] as const], [existing, next], ...collected?.changes ?? []],
    step: { state: result, nextDeadline: nextDeadline(result), decisions: [decided(change)], intents: notices.admitted,
      outcomes: [accepted(change)], diagnostics },
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
  return receiveCandidate(state, candidate, input.clock);
}

// ---- 期限（I-U-L.deadlines。到来分だけを回収する） ----

// ponytail: 128 官署の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: LandslideUnitState, clock: ClockReading): Readonly<{ state: LandslideUnitState; changes: readonly Change[];
  expiredIntents: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0 };
  const changes: Change[] = [];
  // P3-C10-ACTIVE-EXPIRY=C: active も inactive も retainUntil の到来で黙って除く（通知しない）。
  const currents = minOf(state.currents, (item) => item.retainUntil) > now ? state.currents : state.currents.filter((item) => {
    if (item.retainUntil > now) return true;
    changes.push([item, null]);
    return false;
  });
  const intents = minOf(state.intents, (item) => item.expiresAt) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = intents === state.intents ? 0
    : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  const persisted = currents !== state.currents || intents !== state.intents;
  return { state: { ...state, currents, intents, persistence: persisted ? dirty(state.persistence, clock.monotonicMs) : state.persistence },
    changes, expiredIntents };
}

function deadlineStep(state: LandslideUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "landslide",
    reason: "notificationExpired", unit: "U-L", count: applied.expiredIntents }];
  return { changes: applied.changes, step: { ...idle(applied.state),
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] : [], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: LandslideUnitState, input: Extract<LandslideInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, LandslideIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changedIntents.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7〜C9 の先例）。更新で終端にした記録は期限前の回収から外す。
  const next = { ...state, intents: trimTerminal(state.intents.map((item) => changedIntents.get(item.id) ?? item), new Set(changedIntents.keys())),
    persistence: dirty(state.persistence, input.clock.monotonicMs) };
  const adopted = [...changedIntents.values()];
  return { changes: [], step: { ...idle(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "deliveryOnly" as const, currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted" as const, change: "deliveryOnly" as const, subjects: [{ subject: item.subject,
      operation: item.operation, informationType: item.source.infoTypeRaw, transition: item.disposition, severity: null,
      source: item.source, facts: { intentId: item.id, channel: item.channel }, changedFields: ["intents"] }] })) } };
}

function restore(state: LandslideUnitState, persisted: PersistedLandslideUnit, clock: ClockReading): Result {
  const decoded = landslideUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "landslide",
    reason: "requiredStructureInvalid", unit: "U-L" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。
  const applied = collect({ ...decoded.state, persistence: state.persistence }, clock);
  const shown = applied.state.currents.filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-L"], coverage: shown.map((item) => item.subject), subjects: [] }],
    diagnostics: applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "landslide", reason: "notificationExpired",
      unit: "U-L", count: applied.expiredIntents }] } };
}

function reduceCore(state: LandslideUnitState, input: LandslideInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, false);
    case "shutdown": return deadlineStep(state, input.clock, true);
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
  contentRevision: String(state.contentRevision), admission: {}, subjects, currents };
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
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || row.family !== FAMILY || row.subject !== subject || subjectOperation(subject) !== operation
    || !bounded(row.inputId, LIMITS.inputId) || !bounded(row.reportDateTimeRaw, LIMITS.reportDateTime)
    || !Number.isFinite(Date.parse(row.reportDateTimeRaw)) || !isText(row.serialRaw) || !validSerial(row.serialRaw)
    || !isText(row.infoTypeRaw) || !INFO_RANK.has(row.infoTypeRaw)
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  return { inputId: row.inputId, origin: row.origin, operation, family: FAMILY, subject, reportDateTimeRaw: row.reportDateTimeRaw,
    serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
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
const FACT_KEYS = ["title", "kinds", "truncated"];
function currentRecord(value: unknown): LandslideCurrent | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !isText(row.office) || !validOffice(row.office) || row.subject !== `${operation}/${FAMILY}/${row.office}`)
    return null;
  const source = reportRef(row.source, row.subject);
  if (source == null) return null;
  const base = { subject: row.subject, operation, office: row.office, source };
  if (row.effective !== "active") {
    // active 以外は事実を持たない（types.ts の判別共用体）。
    if (FACT_KEYS.some((key) => key in row) || row.retainUntil !== reportMs(source) + INACTIVE_RETAIN_MS) return null;
    return row.effective === "ended" || row.effective === "cancelled" ? { ...base, retainUntil: row.retainUntil, effective: row.effective } : null;
  }
  const kinds = kindsRecord(row.kinds);
  if (kinds == null || !bounded(row.title, BOUNDS.title) || typeof row.truncated !== "boolean"
    || row.retainUntil !== reportMs(source) + ACTIVE_RETAIN_MS) return null;
  return { ...base, retainUntil: row.retainUntil, effective: "active", title: row.title, kinds, truncated: row.truncated };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): LandslideIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const source = isText(row?.subject) ? reportRef(row.source, row.subject) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-L.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-L" || !isText(row.subject) || source.operation !== operation
    || payload.domain !== "weather" || !isText(payload.title) || payload.title === "" || !isText(payload.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-L", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision, disposition };
}
function persisted(value: unknown): PersistedLandslideUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord, CURRENT_LIMIT), intents = list(row.intents, intentRecord);
  if (currents == null || intents == null || new Set(currents.map((item) => item.subject)).size !== currents.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  const pending = intents.filter((entry) => entry.disposition === "pending");
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。終端記録は pending との合計で見る（Q-NOTICE.capacity）。
  const pendingBytes = listBytes(pending) + pending.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedLandslideUnit = { schemaVersion: SCHEMA, currents, intents };
  if (pending.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || pendingBytes + terminalBytes(intents) > PENDING_BYTES + TERMINAL_BYTES
    || generationBytes(result) > GENERATION_LIMIT) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const landslideUnitCodec: LandslideUnitCodec = {
  schemaVersion: SCHEMA,
  // contentRevision・persistence は保存しない（I-U-L.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-landslide-unit-v1 payload" }
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
  withoutNormal: (state) => ({ ...state, currents: state.currents.filter((item) => item.operation !== "normal") }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => state.currents.filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-L">;

export { landslideUnit, landslideUnitCodec, reduceLandslideUnit, toLandslideView };
