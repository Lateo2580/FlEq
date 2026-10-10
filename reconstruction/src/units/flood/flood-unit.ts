import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline, SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  FloodCriteria, FloodCurrent, FloodInput, FloodIntent, FloodKindGroup, FloodNotificationPayload, FloodRiver, FloodStation, FloodUnitCodec,
  FloodUnitState, FloodUnitStep, FloodUnitView, PersistedFloodUnit,
} from "../../../contracts/p3-flood-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import {
  BOUNDS, LIMITS, cut, infoRankOf, levelOf, loneSurrogate, parseFlood, validEventId, validHeadType, validInputId, validKindCode, validName,
  validReportDateTime, validRiverCode, validSerial, validStationCode, validTime, validValue,
} from "../../domains/flood/flood";
import type { FloodCandidate } from "../../domains/flood/flood";

// P3-UNIT-R-001（C11、I-U-R）: U-R の EventID の current・通知・容量・codec・射影。

const SCHEMA = "p3-flood-unit-v1" as const;
// P3-C11-CAPACITY=A・P3-C11-RES-01（P3-C11-BOUNDS=B）・RET-01〜04。
const CURRENT_LIMIT = 512, GENERATION_LIMIT = 16_777_216;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 98_304;
// P3-C11-SEM-01・02（元報の ReportDateTime からの絶対の長さ、P3-C11-RETENTION=A・P3-C11-ACTIVE-EXPIRY=D）。
const RETAIN_MS = 129_600_000;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;

type Active = Extract<FloodCurrent, Readonly<{ effective: "active" }>>;
type Level = FloodNotificationPayload["level"];
type InternalStep = Omit<FloodUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = FloodUnitStep["decisions"][number];
type Change = readonly [before: FloodCurrent | null, after: FloodCurrent | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
const visible = (value: FloodCurrent | null): value is Active => value?.effective === "active";

// ---- byte の加算（I-U-R.computation。受信 1 回で state 全体を直列化しない） ----

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
const terminalBytes = (intents: readonly FloodIntent[]): number =>
  intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-R", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-L ほかと同じ予約）。4: 空の配列 2 つ。
function generationBytes(value: PersistedFloodUnit): number {
  return emptyEnvelopeBytes + 62 - 4 + listBytes(value.currents) + listBytes(value.intents);
}

// ---- 期限（I-U-R.deadlines） ----

const deadlineCache = new WeakMap<readonly object[], number>();
function minOf<T extends object>(values: readonly T[], at: (value: T) => number): number {
  let min = deadlineCache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); deadlineCache.set(values, min); }
  return min;
}
const deadlineAt = (state: FloodUnitState): number =>
  Math.min(minOf(state.currents, (item) => item.retainUntil), minOf(state.intents, (item) => item.expiresAt));
function nextDeadline(state: FloodUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: FloodUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

// ---- 索引（配列に結び付けた Map。受信ごとに配列を探し直さない、I-U-R.computation） ----

const indexCache = new WeakMap<readonly FloodCurrent[], ReadonlyMap<string, number>>();
function indexOf(values: readonly FloodCurrent[], subject: string): number | undefined {
  let index = indexCache.get(values);
  if (index == null) { index = new Map(values.map((item, at) => [item.subject, at])); indexCache.set(values, index); }
  return index.get(subject);
}
function replaceAt<T>(values: readonly T[], index: number | undefined, value: T): readonly T[] {
  return index == null ? [...values, value] : values.map((item, at) => at === index ? value : item);
}

// P3-C11-CAPACITY=A: 513 件目は (1) retainUntil を過ぎた記録 (2) inactive (3) training/test (4) 受ける報が normal のときだけ normal、
// それぞれ ReportDateTime の古い順で退去する。受ける報が training/test で (1)〜(3) が無ければ null（受けた記録自身を退去する）。
// ponytail: 満杯の 512 件の素朴な線形の走査（上限は CURRENT_LIMIT で、保持と decode の両方で効く。台帳 47 の例外）。
function evictOne(values: readonly FloodCurrent[], now: number, incoming: Operation): FloodCurrent | null {
  const tier = (item: FloodCurrent) => item.retainUntil <= now ? 0 : item.effective !== "active" ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: FloodCurrent | null = null;
  for (const item of values) {
    if (tier(item) === 3 && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// ReportDateTime、同時刻なら Serial（数として）、なお同じなら InfoType の優先。
function compare(candidate: FloodCandidate, source: ReportRef): number {
  const time = candidate.reportDateTimeMs - reportMs(source);
  if (time !== 0) return Math.sign(time);
  const serial = Number(candidate.source.serialRaw) - Number(source.serialRaw);
  if (serial !== 0) return Math.sign(serial);
  return Math.sign(candidate.infoRank - (infoRankOf(source.infoTypeRaw) ?? 0));
}

// ---- EventID の current（I-U-R.currentSemantics） ----

// 同じ版の重複の判定は公開事実、semantic の判定はそれに basisReportDateTimeRaw を足す（Q-ENUM.revisionOrder・currentSemantics(4)）。
const FACTS = ["effective", "title", "areaName", "kinds", "times", "stations"] as const;
const FIELDS = [...FACTS, "basisReportDateTimeRaw"] as const;
function changed(before: FloodCurrent | null, after: FloodCurrent, fields: readonly string[] = FIELDS): string[] {
  const read = (value: FloodCurrent | null, field: string): unknown => value == null ? null
    : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  return fields.filter((field) => !isDeepStrictEqual(read(before, field), read(after, field)));
}
function currentOf(candidate: FloodCandidate, existing: FloodCurrent | null): FloodCurrent {
  const base = { subject: candidate.subject, operation: candidate.operation, headType: candidate.headType, eventId: candidate.eventId,
    source: candidate.source, retainUntil: candidate.reportDateTimeMs + RETAIN_MS };
  if (candidate.cancelled) return { ...base, effective: "cancelled" };
  // P3-C11-UNKNOWN=A: 河川の段階を読めない報は active の記録の事実を保ち、事実を出した報の時刻を basis に持つ。
  if (candidate.kinds.length === 0 && visible(existing))
    return { ...base, effective: "active", title: existing.title, areaName: existing.areaName, kinds: existing.kinds, times: existing.times,
      stations: existing.stations, basisReportDateTimeRaw: existing.basisReportDateTimeRaw ?? existing.source.reportDateTimeRaw,
      truncated: existing.truncated };
  // P3-C11-ACTIVE-LEVEL=A: level が 0 でない group（表に無い code を含む）が 1 つでもあれば active、全部 0 なら ended。
  if (candidate.kinds.length !== 0 && candidate.kinds.every((group) => group.level === 0)) return { ...base, effective: "ended" };
  return { ...base, effective: "active", title: candidate.title, areaName: candidate.areaName, kinds: candidate.kinds, times: candidate.times,
    stations: candidate.stations, basisReportDateTimeRaw: null, truncated: candidate.truncated };
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// P3-C11-NOTICE-LEVELS=E（作者裁定）: 表に無い code（null）は warning で、上がったかの比較ではレベル 3 と同じ順位。
const SOUND: ReadonlyMap<number | null, Level> = new Map([[5, "critical"], [4, "warning"],
  [3, "warning"], [2, "normal"], [null, "warning"]]);
const LEVEL_ORDER: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
const louder = (left: Level | null, right: Level | null): Level | null =>
  left == null || right != null && LEVEL_ORDER.indexOf(right) > LEVEL_ORDER.indexOf(left) ? right : left;
const rankOf = (level: FloodKindGroup["level"]): number => level ?? 3;
// 河川ごとの段階。rivers が空の group は group の code を 1 つの河川として数える（Q-NOTICE.level）。
function riverLevels(value: Active): Map<string, FloodKindGroup["level"]> {
  const levels = new Map<string, FloodKindGroup["level"]>();
  for (const group of value.kinds)
    if (group.rivers.length === 0) levels.set(`#${group.code}`, group.level);
    else for (const river of group.rivers) levels.set(river.code, group.level);
  return levels;
}
const observedMax = (value: Active): number => value.stations.reduce((max, station) => Math.max(max, station.levels[0] ?? -1), -1);
// 採用前の記録と比べた機会と段階（P3-C11-NOTICE-LEVELS=E）。changed は河川の段階が変わったか観測の最大が 2 以上へ上がったか。
function noticeOf(before: FloodCurrent | null, after: Active): Readonly<{ changed: boolean; level: Level }> {
  if (after.kinds.length === 0) return visible(before) ? { changed: false, level: "normal" } : { changed: true, level: "warning" };
  const previous = visible(before) ? riverLevels(before) : new Map<string, FloodKindGroup["level"]>();
  const current = riverLevels(after);
  let rivers = previous.size !== current.size;
  let level: Level | null = null;
  for (const [code, value] of current) {
    const old = previous.get(code);
    if (old !== value) rivers = true;
    if (value !== 0 && (old === undefined ? -Infinity : rankOf(old)) < rankOf(value)) level = louder(level, SOUND.get(value) ?? "warning");
  }
  const observed = observedMax(after);
  if (observed >= 2 && observed > (visible(before) ? observedMax(before) : -1)) level = louder(level, SOUND.get(observed) ?? null);
  return { changed: rivers || level != null, level: level ?? "normal" };
}
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title。本文は Headline、無ければ group ごとの河川名、それも無ければ題。
function payloadOf(candidate: FloodCandidate, after: FloodCurrent, level: Level): FloodNotificationPayload {
  const prefix = PREFIX[candidate.operation];
  if (candidate.cancelled) return { domain: "weather", level: "cancel", title: cut(`${prefix}[取消] ${candidate.title}`, NOTICE_BOUNDS.title),
    body: "この情報は取り消されました" };
  const correction = candidate.infoRank === 2;
  const groups = visible(after) ? after.kinds.map((group) => [group.name, group.rivers.map((river) => river.name).join("・")]
    .filter((part) => part !== "").join(" ")).join(" / ") : "";
  const body = candidate.headline ?? (groups !== "" ? groups : candidate.title);
  return { domain: "weather", level, title: cut(prefix + (correction ? `[訂正] ${candidate.title}` : candidate.title), NOTICE_BOUNDS.title),
    body: cut(correction ? `訂正: ${body}` : body, NOTICE_BOUNDS.body) };
}
function intentsFor(source: Readonly<{ subject: string; operation: Operation; source: ReportRef }>, transition: FloodIntent["transition"],
  payload: FloodNotificationPayload, generation: number, now: number, channels: readonly ("desktop" | "sound")[]): FloodIntent[] {
  return channels.map((channel) => ({ id: `U-R:${source.subject}:${generation}:${channel}`, unit: "U-R", subject: source.subject,
    operation: source.operation, source: source.source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}
// P3-C11-TRAINING=A: training/test は desktop だけ。
const channelsOf = (operation: Operation) => operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
// A7 の選択順（期限 → 生成時刻 → ID）。U-R の intent は全部 other の群（P3-C11-NOTICE-GROUP=A）。
function a7Order(left: FloodIntent, right: FloodIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 終端記録の合計が 98,304 byte を超える分は、最古の終端記録から期限前に回収する。kept は今の配送の更新で終端にした記録で、回収しない
// （owner は更新した記録が残ることで照合する。C8 の Q-C8-IMPL-AMEND(1)）。kept だけで上限を超える分は元の pending の byte の内側。
function trimTerminal(intents: readonly FloodIntent[], kept: ReadonlySet<string> = new Set()): readonly FloodIntent[] {
  let terminal = terminalBytes(intents);
  if (terminal <= TERMINAL_BYTES) return intents;
  const gone = new Set<FloodIntent>();
  for (const item of intents.filter((value) => value.disposition !== "pending" && !kept.has(value.id))
    .sort((left, right) => left.createdAt - right.createdAt)) {
    if (terminal <= TERMINAL_BYTES) break;
    gone.add(item);
    terminal -= bytes(item) + 1;
  }
  return intents.filter((item) => !gone.has(item));
}
// Q-NOTICE.capacity と P3-C11-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
function admit(current: readonly FloodIntent[], fresh: readonly FloodIntent[], cancelled: string | null):
  Readonly<{ intents: readonly FloodIntent[]; admitted: readonly FloodIntent[]; dropped: number }> {
  const superseded = new Set<FloodIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.disposition === "pending" && (item.subject === cancelled || replaced.has(`${item.subject}\n${item.channel}`))) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
  const out = new Set<FloodIntent>();
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

function factsOf(value: FloodCurrent): Readonly<Record<string, JsonValue>> {
  return visible(value) ? { eventId: value.eventId, effective: value.effective, title: value.title, areaName: value.areaName, kinds: value.kinds,
    times: value.times, stations: value.stations, basisReportDateTimeRaw: value.basisReportDateTimeRaw, truncated: value.truncated }
    : { eventId: value.eventId, effective: value.effective };
}
function outcomeOf(value: FloodCurrent, changedFields: readonly string[], extra: Readonly<Record<string, JsonValue>> = {}): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: { ...factsOf(value), ...extra }, changedFields };
}
// view の subject は識別だけを持つ（事実は currents にあり、二重に載せると snapshot の予算を食う。U-L ほかの先例）。
const outcomeCache = new WeakMap<FloodCurrent, SubjectOutcome>();
function shownOutcome(value: FloodCurrent): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = { ...outcomeOf(value, []), facts: { eventId: value.eventId, effective: value.effective } };
    outcomeCache.set(value, found);
  }
  return found;
}
function displaySubject(value: FloodCurrent): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-R" }>> {
  return { unit: "U-R", operation: value.operation, subject: value.subject, office: null, current: visible(value) ? value : null,
    subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C11-SUBJECTS=A。一入力は EventID の subject を 1 つだけ変え、一回の参照交換で確定する） ----

function receiveCandidate(state: FloodUnitState, candidate: FloodCandidate, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const { subject, operation } = candidate;
  const unchanged = (reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason }], diagnostics } });
  // P3-C11-ACTIVE-EXPIRY.lateRule: 受理の時点で ReportDateTime+36 時間を過ぎた報は、記録の有無によらず state を変えない。
  if (candidate.reportDateTimeMs + RETAIN_MS <= now) return unchanged("stale");
  const index = indexOf(state.currents, subject);
  const existing = index == null ? null : state.currents[index];
  const next = currentOf(candidate, existing);
  if (existing != null) {
    const order = compare(candidate, existing.source);
    // 取消以前の版は stale で、取消した subject を戻さない。同じ版・同じ InfoType は事実が同じなら duplicate、違えば先着を保つ。
    if (order < 0) return unchanged("stale");
    if (order === 0) return changed(existing, next, FACTS).length === 0 ? unchanged("duplicate")
      : unchanged("stale", [{ level: "WARN", component: "flood", reason: "floodRevisionConflict", inputId: candidate.source.inputId, unit: "U-R" }]);
  }
  const fields = visible(existing) || visible(next) ? changed(existing, next) : [];
  const decided = (change: "semantic" | "revisionOnly"): Decision => ({ subject, operation, decision: "changed", reason: null, change,
    currentEstablished: { family: candidate.headType, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } });
  const accepted = (change: "semantic" | "revisionOnly") => ({ kind: "accepted" as const, change,
    subjects: [outcomeOf(next, fields, visible(next) && candidate.headline != null ? { headline: candidate.headline } : {})] });

  let currents: readonly FloodCurrent[];
  let evicted: FloodCurrent | null = null;
  if (index == null && state.currents.length >= CURRENT_LIMIT) {
    evicted = evictOne(state.currents, now, operation);
    // training/test の報で退去できる記録が無ければ、受けた記録自身を退去する（currents の参照を変えない、通知しない）。採用した取消は
    // その subject の pending を置き換え、intents が変わったときだけ保存世代を進める（C10 の Q-C10-IMPL-AMEND(5)）。
    if (evicted == null) {
      const notices = candidate.cancelled ? admit(state.intents, [], subject) : null;
      const kept = notices == null || notices.intents === state.intents ? state
        : { ...state, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };
      return { changes: [], step: { ...idle(kept), decisions: [decided("semantic")], outcomes: [accepted("semantic")],
        diagnostics: [{ level: "INFO", component: "flood", reason: "floodCapacityEvicted", unit: "U-R", count: 1 }] } };
    }
    const gone = evicted;
    currents = [...state.currents.filter((item) => item !== gone), next];
  } else currents = replaceAt(state.currents, index, next);
  // 退去を伴う受理は decision も outcome も semantic（U-N・U-L と同じ）。
  const change = fields.length !== 0 || evicted != null ? "semantic" as const : "revisionOnly" as const;

  // Q-NOTICE.generationTable。訂正は事実が同じでも作る。記録の無い subject か取消の記録への解除の報（inactiveAdoption）も作る。
  // 記憶だけの取消・ended の記録への解除・河川の段階も観測の最大も上がらない報では作らない。
  const correction = candidate.infoRank === 2;
  const notice = visible(next) ? noticeOf(existing, next) : null;
  const notify = candidate.cancelled ? visible(existing) : correction || (notice != null ? notice.changed
    : visible(existing) || existing == null || existing.effective === "cancelled");
  const transition = candidate.cancelled ? "cancelled" as const : correction ? "updated" as const
    : visible(next) ? visible(existing) ? "updated" as const : "activated" as const : "released" as const;
  const level = candidate.cancelled ? "cancel" : notice?.level ?? "normal";
  const fresh = notify ? intentsFor(candidate, transition, payloadOf(candidate, next, level), state.persistence.currentGeneration + 1, now,
    channelsOf(operation)) : [];
  const notices = admit(state.intents, fresh, candidate.cancelled ? subject : null);
  const result: FloodUnitState = { ...state, currents, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };
  const diagnostics: DiagnosticDetails[] = [];
  if (evicted != null) diagnostics.push({ level: "INFO", component: "flood", reason: "floodCapacityEvicted", unit: "U-R", count: 1 });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "flood", reason: "notificationCapacityEvicted", unit: "U-R",
    count: notices.dropped });
  return {
    changes: [...evicted == null ? [] : [[evicted, null] as const], [existing, next]],
    step: { state: result, nextDeadline: nextDeadline(result), decisions: [decided(change)], intents: notices.admitted,
      outcomes: [accepted(change)], diagnostics },
  };
}

function receive(state: FloodUnitState, input: Extract<FloodInput, { kind: "receive" }>): Result {
  const parsed = parseFlood(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C11-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  return receiveCandidate(state, candidate, input.clock);
}

// ---- 期限（I-U-R.deadlines。到来分だけを回収する） ----

// P3-C11-ACTIVE-EXPIRY=D: active の記録の回収では desktop だけの期限切れを 1 件作る（ended・cancelled の回収では作らない）。
function expiryPayload(value: Active): FloodNotificationPayload {
  const prefix = PREFIX[value.operation];
  return { domain: "weather", level: "info", title: cut(`${prefix}[期限切れ] ${value.title}`, NOTICE_BOUNDS.title),
    body: cut(`${value.areaName === "" ? "この" : `${value.areaName}の`}洪水予報は36時間続報がなく、現況を確認できません`, NOTICE_BOUNDS.body) };
}
// ponytail: 512 subject の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: FloodUnitState, clock: ClockReading): Readonly<{ state: FloodUnitState; changes: readonly Change[];
  expiredIntents: number; intents: readonly FloodIntent[]; dropped: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0, intents: [], dropped: 0 };
  const changes: Change[] = [];
  const generation = state.persistence.currentGeneration + 1;
  const expiry: FloodIntent[] = [];
  const currents = minOf(state.currents, (item) => item.retainUntil) > now ? state.currents : state.currents.filter((item) => {
    if (item.retainUntil > now) return true;
    changes.push([item, null]);
    if (visible(item)) expiry.push(...intentsFor(item, "expired", expiryPayload(item), generation, now, ["desktop"]));
    return false;
  });
  const remaining = minOf(state.intents, (item) => item.expiresAt) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = remaining === state.intents ? 0
    : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  const notices = admit(remaining, expiry, null);
  const persisted = currents !== state.currents || notices.intents !== state.intents;
  return { state: { ...state, currents, intents: notices.intents,
    persistence: persisted ? dirty(state.persistence, clock.monotonicMs) : state.persistence },
  changes, expiredIntents, intents: notices.admitted, dropped: notices.dropped };
}

function deadlineStep(state: FloodUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock);
  const diagnostics: DiagnosticDetails[] = [];
  if (applied.expiredIntents !== 0) diagnostics.push({ level: "INFO", component: "flood", reason: "notificationExpired", unit: "U-R",
    count: applied.expiredIntents });
  if (applied.dropped !== 0) diagnostics.push({ level: "INFO", component: "flood", reason: "notificationCapacityEvicted", unit: "U-R",
    count: applied.dropped });
  return { changes: applied.changes, step: { ...idle(applied.state), intents: applied.intents,
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] : [], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: FloodUnitState, input: Extract<FloodInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, FloodIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changedIntents.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7〜C10 の先例）。更新で終端にした記録は期限前の回収から外す。
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

// Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。期限を過ぎた記録と intent は、復元の後の
// 最初の期限処理で回収する（active の期限切れの desktop はそこで作る、P3-C11-ACTIVE-EXPIRY=D）。
function restore(state: FloodUnitState, persisted: PersistedFloodUnit): Result {
  const decoded = floodUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "flood",
    reason: "requiredStructureInvalid", unit: "U-R" }] } };
  const restored = { ...decoded.state, persistence: state.persistence };
  const shown = restored.currents.filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(restored),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-R"], coverage: shown.map((item) => item.subject), subjects: [] }] } };
}

function reduceCore(state: FloodUnitState, input: FloodInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, false);
    case "shutdown": return deadlineStep(state, input.clock, true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`flood input ${String(missing)} is not handled`); }
  }
}

function reduceFloodUnit(state: FloodUnitState, input: FloodInput): FloodUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: FloodCurrent | null; after: FloodCurrent | null }>();
  for (const [before, after] of changes) {
    const key = (after ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: FloodUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-R", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-R content revision exhausted");
  // P3-C11-N2: U-R は確認 scope を作らない。
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toFloodView(state: FloodUnitState): FloodUnitView {
  const currents = state.currents.filter(visible);
  const subjects = currents.map(shownOutcome);
  return { unit: "U-R", semanticRevision: subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`).sort().join("|"),
  contentRevision: String(state.contentRevision), admission: {}, subjects, currents };
}

// ---- codec（I-U-R.persisted・I-U-R.decode、唯一の FloodUnitCodec。受理と同じ上限を確かめる） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const bounded = (value: unknown, limit: number): value is string => isText(value) && value.length <= limit;
const boundedName = (value: unknown, limit: number): value is string => bounded(value, limit) && validName(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
// 受理が作りうる数（11 文字以下の `-?[0-9]{1,6}(\.[0-9]{1,3})?`）か null。
const measured = (value: unknown): number | null | undefined => value === null ? null
  : finite(value) && validValue(String(value)) ? value : undefined;
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null, limit = Infinity): T[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}
// I-U-R.subjects の形（`${operation}/${headType}/${eventId}`、Q-ENUM.identity の文字と長さ）。
function subjectParts(subject: string): Readonly<{ operation: Operation; headType: string; eventId: string }> | null {
  const match = /^(normal|training|test)\/([A-Z0-9]+)\/([\s\S]*)$/.exec(subject);
  const operation = operationOf(match?.[1]);
  return match == null || operation == null || !validHeadType(match[2]) || !validEventId(match[3]) ? null
    : { operation, headType: match[2], eventId: match[3] };
}
function reportRef(value: unknown, subject: string): ReportRef | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  const parts = subjectParts(subject);
  if (row == null || operation == null || parts == null || row.family !== parts.headType || row.subject !== subject || parts.operation !== operation
    || !isText(row.inputId) || !validInputId(row.inputId) || !isText(row.reportDateTimeRaw) || !validReportDateTime(row.reportDateTimeRaw)
    || !isText(row.serialRaw) || !validSerial(row.serialRaw) || !isText(row.infoTypeRaw) || infoRankOf(row.infoTypeRaw) == null
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  return { inputId: row.inputId, origin: row.origin, operation, family: parts.headType, subject, reportDateTimeRaw: row.reportDateTimeRaw,
    serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
}
// 受理と同じ上限（group 16・河川の延べ 32・code の形と重複・level と code の一致・rivers が空の group は truncated のときだけ）。
function kindsRecord(value: unknown, truncated: boolean): FloodKindGroup[] | null {
  const codes = new Set<string>();
  let total = 0;
  const groups = list(value, (entry) => {
    const row = record(entry);
    const rivers = list(row?.rivers, (river): FloodRiver | null => {
      const item = record(river);
      if (item == null || !isText(item.code) || !validRiverCode(item.code) || codes.has(item.code) || !boundedName(item.name, BOUNDS.name)) return null;
      codes.add(item.code);
      return { code: item.code, name: item.name };
    }, LIMITS.rivers);
    if (row == null || rivers == null || rivers.length === 0 && !truncated || !isText(row.code) || !validKindCode(row.code)
      || !boundedName(row.name, BOUNDS.name) || row.level !== levelOf(row.code)) return null;
    total += rivers.length;
    return { code: row.code, name: row.name, level: levelOf(row.code), rivers };
  }, LIMITS.groups);
  if (groups == null || total > LIMITS.rivers || new Set(groups.map((item) => item.code)).size !== groups.length) return null;
  return groups;
}
const POINT_LEVELS = [0, 1, 2, 3, 4, 5] as const;
function pointLevel(item: unknown): Readonly<{ level: FloodStation["levels"][number] }> | null {
  if (item === null) return { level: null };
  const found = POINT_LEVELS.find((level) => level === item);
  return found == null ? null : { level: found };
}
const CRITERIA_KEYS = ["level1", "level2", "level3", "level4", "level4Plan"] as const;
function stationRecord(value: unknown, points: number, riverCodes: ReadonlySet<string>): FloodStation | null {
  const row = record(value), criteriaRow = record(row?.criteria);
  if (row == null || criteriaRow == null || !isText(row.code) || !validStationCode(row.code) || !boundedName(row.name, BOUNDS.stationName)
    || (row.measurement !== "waterLevel" && row.measurement !== "discharge")) return null;
  const links = list(row.riverCodes, (code) => isText(code) && riverCodes.has(code) ? code : null, LIMITS.sections);
  const values = list(row.values, (item) => {
    const read = measured(item);
    return read === undefined ? null : { value: read };
  });
  const levels = list(row.levels, pointLevel);
  const criteria: { -readonly [K in keyof FloodCriteria]: number | null } = { level1: null, level2: null, level3: null, level4: null, level4Plan: null };
  for (const key of CRITERIA_KEYS) {
    const read = measured(criteriaRow[key]);
    if (read === undefined) return null;
    criteria[key] = read;
  }
  if (links == null || values == null || levels == null || new Set(links).size !== links.length || values.length !== points
    || levels.length !== points) return null;
  return { code: row.code, name: row.name, riverCodes: links, measurement: row.measurement, criteria, values: values.map((item) => item.value),
    levels: levels.map((item) => item.level) };
}
const FACT_KEYS = ["title", "areaName", "kinds", "times", "stations", "basisReportDateTimeRaw", "truncated"];
function currentRecord(value: unknown): FloodCurrent | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  const parts = isText(row?.subject) ? subjectParts(row.subject) : null;
  if (row == null || operation == null || parts == null || !isText(row.subject) || parts.operation !== operation || row.headType !== parts.headType
    || row.eventId !== parts.eventId) return null;
  const source = reportRef(row.source, row.subject);
  if (source == null || row.retainUntil !== reportMs(source) + RETAIN_MS) return null;
  const base = { subject: row.subject, operation, headType: parts.headType, eventId: parts.eventId, source, retainUntil: row.retainUntil };
  if (row.effective !== "active") {
    // active 以外は事実を持たない（types.ts の判別共用体）。
    if (FACT_KEYS.some((key) => key in row)) return null;
    return row.effective === "ended" || row.effective === "cancelled" ? { ...base, effective: row.effective } : null;
  }
  if (typeof row.truncated !== "boolean" || !bounded(row.title, BOUNDS.title) || loneSurrogate(row.title)
    || !bounded(row.areaName, BOUNDS.areaName) || row.areaName !== "" && !validName(row.areaName)
    || row.basisReportDateTimeRaw !== null && !(isText(row.basisReportDateTimeRaw) && validReportDateTime(row.basisReportDateTimeRaw))) return null;
  const kinds = kindsRecord(row.kinds, row.truncated);
  const times = list(row.times, (item) => isText(item) && validTime(item) ? item : null, LIMITS.points);
  if (kinds == null || times == null) return null;
  const rivers = new Set(kinds.flatMap((group) => group.rivers.map((river) => river.code)));
  const stations = list(row.stations, (item) => stationRecord(item, times.length, rivers), LIMITS.stations);
  if (stations == null || new Set(stations.map((item) => `${item.code}\n${item.name}`)).size !== stations.length) return null;
  return { ...base, effective: "active", title: row.title, areaName: row.areaName, kinds, times, stations,
    basisReportDateTimeRaw: row.basisReportDateTimeRaw, truncated: row.truncated };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): FloodIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const source = isText(row?.subject) ? reportRef(row.source, row.subject) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-R.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-R" || !isText(row.subject) || source.operation !== operation
    || payload.domain !== "weather" || !isText(payload.title) || payload.title === "" || !isText(payload.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-R", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision, disposition };
}
function persisted(value: unknown): PersistedFloodUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord, CURRENT_LIMIT), intents = list(row.intents, intentRecord);
  if (currents == null || intents == null || new Set(currents.map((item) => item.subject)).size !== currents.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  const pending = intents.filter((entry) => entry.disposition === "pending");
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。終端記録は pending との合計で見る（Q-NOTICE.capacity）。
  const pendingBytes = listBytes(pending) + pending.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedFloodUnit = { schemaVersion: SCHEMA, currents, intents };
  if (pending.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || pendingBytes + terminalBytes(intents) > PENDING_BYTES + TERMINAL_BYTES
    || generationBytes(result) > GENERATION_LIMIT) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const floodUnitCodec: FloodUnitCodec = {
  schemaVersion: SCHEMA,
  // contentRevision・persistence は保存しない（I-U-R.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-flood-unit-v1 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-R.runtimeRows）。
const floodUnit = {
  unit: "U-R",
  reduce: reduceFloodUnit,
  toView: toFloodView,
  persistence: { kind: "durable", codec: floodUnitCodec },
  confirmationScopeLimit: 512,
  withoutNormal: (state) => ({ ...state, currents: state.currents.filter((item) => item.operation !== "normal") }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => state.currents.filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-R">;

export { floodUnit, floodUnitCodec, reduceFloodUnit, toFloodView };
