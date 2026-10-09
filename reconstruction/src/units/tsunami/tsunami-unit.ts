import { isDeepStrictEqual } from "node:util";

import type { MaterialValue, Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline,
  SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  PersistedTsunamiUnit, TsunamiAreaClass, TsunamiEstimation, TsunamiForecastArea, TsunamiForecastSubject, TsunamiHeight,
  TsunamiInput, TsunamiIntent, TsunamiNotificationPayload, TsunamiObservationFamily, TsunamiObservationSubject,
  TsunamiReportSeries, TsunamiStation, TsunamiTransitionRecord, TsunamiUnitCodec, TsunamiUnitState, TsunamiUnitStep,
  TsunamiUnitView, TsunamiUnkeyedArea,
} from "../../../contracts/p3-tsunami-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { AREA_RANK, INFO_RANK, KIND_CLASS, parseTsunami, sameStation } from "../../domains/tsunami/tsunami";
import type { ForecastCandidate, ObservationCandidate } from "../../domains/tsunami/tsunami";

// P3-TSUNAMI-UNIT-001（C5、I-U-T）: U-T の意味・通知・容量・codec・射影。

const SCHEMA = "p3-tsunami-unit-v1" as const;
// P3-C5-CAPACITY=A と P3-C5-RES-01・RET-01〜03。
const FORECAST_LIMIT = 512, OBSERVATION_LIMIT = 512, STATION_LIMIT = 1024, GENERATION_LIMIT = 4_194_304;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C5-SEM-01（観測 24 時間）・SEM-02（非 active 7 日）・SEM-03/04（sound 60 秒・desktop 180 秒）。
const VALID_MS = 86_400_000, RETAIN_MS = 604_800_000;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const FAMILIES = ["VTSE51", "VTSE52"] as const;

type Subject = TsunamiForecastSubject | TsunamiObservationSubject;
type Level = TsunamiNotificationPayload["level"];
type InternalStep = Omit<TsunamiUnitStep, "displayChanges" | "confirmationEvidence">;
type Change = readonly [before: Subject | null, after: Subject | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;

// I-U-T.computation: 値に結び付けた encode byte を加算する（受信 1 回で state 全体を直列化しない）。
const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
function listBytes(values: readonly object[]): number {
  return values.reduce((sum, item) => sum + bytes(item), 2 + Math.max(values.length - 1, 0));
}
// 配送の更新で pending が伸びうる分の予約（P3-INTENT-UPDATE-RESERVE-001）。無いと上限ちょうどの pending が更新で伸び、decode が拒否する。
function reserve(values: readonly TsunamiIntent[]): number {
  return values.reduce((sum, item) => item.disposition === "pending" ? sum + deliveryGrowth(item) : sum, 0);
}
// 観測 subject は station・推定ごとの加算（station 1 点の更新で 1024 点を直列化し直さない）。
function subjectBytes(value: Subject): number {
  if (!("stations" in value)) return bytes(value);
  let size = byteCache.get(value);
  if (size == null) {
    size = encoder.encode(JSON.stringify({ ...value, stations: [], estimations: [] })).byteLength - 4
      + listBytes(value.stations) + listBytes(value.estimations);
    byteCache.set(value, size);
  }
  return size;
}
function sumBytes(values: readonly Subject[]): number {
  return values.reduce((sum, item) => sum + subjectBytes(item), Math.max(values.length - 1, 0));
}
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-T", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, forecasts: [], observations: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F と同じ予約）。
function generationBytes(forecasts: readonly Subject[], observations: readonly Subject[], intents: readonly TsunamiIntent[]): number {
  return emptyEnvelopeBytes + 62 + sumBytes(forecasts) + sumBytes(observations)
    + intents.reduce((sum, item) => sum + bytes(item) + (item.disposition === "pending" ? deliveryGrowth(item) : 0), Math.max(intents.length - 1, 0));
}

// nextDeadline の最小値は配列に結び付けて持つ（weather-timeseries-unit の先例）。
const deadlineCache = new WeakMap<readonly object[], number>();
function subjectDeadline(values: readonly Subject[]): number {
  let at = deadlineCache.get(values);
  if (at == null) {
    at = values.reduce((min, item) => Math.min(min,
      item.effective === "active" ? ("validUntil" in item ? item.validUntil ?? Infinity : Infinity) : item.retainUntil ?? Infinity), Infinity);
    deadlineCache.set(values, at);
  }
  return at;
}
function intentDeadline(values: readonly TsunamiIntent[]): number {
  let at = deadlineCache.get(values);
  if (at == null) { at = values.reduce((min, item) => Math.min(min, item.expiresAt), Infinity); deadlineCache.set(values, at); }
  return at;
}
function deadlineAt(state: TsunamiUnitState): number {
  return Math.min(subjectDeadline(state.forecasts), subjectDeadline(state.observations), intentDeadline(state.intents));
}
function nextDeadline(state: TsunamiUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: TsunamiUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}
function visible(value: Subject | null): boolean {
  return value != null && value.effective === "active";
}
function classOf(area: TsunamiForecastArea | TsunamiUnkeyedArea): TsunamiAreaClass {
  return "areaClass" in area ? area.areaClass : KIND_CLASS.get(area.kindCode) ?? "unknown";
}
function expireObservation(value: TsunamiObservationSubject, now: number): TsunamiObservationSubject {
  return { ...value, effective: "expired", stations: [], estimations: [], validUntil: null,
    retainUntil: (value.validUntil ?? now) + RETAIN_MS };
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const LEVELS = ["info", "normal", "warning", "critical"] as const;
const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// P2-A4 と同じ区分の注記行。
const LEAD: Readonly<Record<Operation, string>> = { normal: "",
  training: "訓練の電文です。通常運用の警報ではありません。\n", test: "試験の電文です。通常運用の警報ではありません。\n" };
const OBSERVATION_TITLE: Readonly<Record<TsunamiObservationFamily, string>> = {
  VTSE51: "津波観測に関する情報", VTSE52: "沖合の津波観測に関する情報" };

function maxLevel(left: Exclude<Level, "cancel">, right: Exclude<Level, "cancel">): Exclude<Level, "cancel"> {
  return LEVELS.indexOf(left) >= LEVELS.indexOf(right) ? left : right;
}
// P3-C5-NOTICE-LEVELS=A の変化の段階。
function riseLevel(value: TsunamiAreaClass): Exclude<Level, "cancel"> {
  return value === "majorWarning" ? "critical" : value === "warning" || value === "unknown" ? "warning"
    : value === "advisory" ? "normal" : "info";
}
// A7 の group()（notification-delivery.ts）と同じ判定。A7 は export しておらず変えない（outOfScope）ので写す。
function groupRank(intent: TsunamiIntent): number {
  return intent.operation === "normal" && (intent.payload.level === "warning" || intent.payload.level === "critical") ? 1 : 2;
}
function payloadOf(operation: Operation, level: Level, title: string, body: string, correction: boolean): TsunamiNotificationPayload {
  return { domain: "tsunami", level, title: PREFIX[operation] + (correction ? `[訂正] ${title}` : title),
    body: LEAD[operation] + (correction ? `訂正: ${body}` : body) };
}
function intentsFor(source: ReportRef, transition: TsunamiIntent["transition"], payload: TsunamiNotificationPayload,
  generation: number, now: number): TsunamiIntent[] {
  // P3-C5-TRAINING=A: training/test は desktop だけ。
  const channels = source.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: `U-T:${source.subject}:${generation}:${channel}`, unit: "U-T", subject: source.subject,
    operation: source.operation, source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}

// P3-C5-REPLACEMENT=A と Q-NOTICE.capacity。置換は同じ subject・channel で同群以上の pending だけ、取消は subject の全 pending。
function admit(current: readonly TsunamiIntent[], fresh: readonly TsunamiIntent[], cancelSubject: string | null):
  Readonly<{ intents: readonly TsunamiIntent[]; admitted: readonly TsunamiIntent[]; dropped: number }> {
  const pending = current.filter((item) => item.disposition === "pending");
  const superseded = new Set(cancelSubject == null ? [] : pending.filter((item) => item.subject === cancelSubject));
  const evicted = new Set<TsunamiIntent>();
  const admitted: TsunamiIntent[] = [];
  let refused = 0;
  for (const intent of fresh) {
    const rank = groupRank(intent);
    const live = pending.filter((item) => !superseded.has(item) && !evicted.has(item));
    const replaced = live.filter((item) => item.subject === intent.subject && item.channel === intent.channel && groupRank(item) >= rank);
    const kept = live.filter((item) => !replaced.includes(item));
    const values = [...kept, ...admitted, intent];
    const out: TsunamiIntent[] = [];
    // 予約込みの byte は初回に数え、退去のたびに 1 件分を引く（受理 1 回を O(pending) に保つ、P3-IUR-RES-03）。
    let count = values.length, size = listBytes(values) + reserve(values);
    const fits = () => count <= PENDING_ITEMS && size <= PENDING_BYTES;
    if (!fits()) {
      // 下位群だけを A7 の選択順の逆（期限・生成時刻・ID の遅い順）で必要数だけ退去する。同群以上は退去しない。
      const lower = kept.filter((item) => groupRank(item) > rank).sort((left, right) => right.expiresAt - left.expiresAt
        || right.createdAt - left.createdAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
      for (const item of lower) {
        if (fits()) break;
        out.push(item);
        count--;
        size -= bytes(item) + 1 + deliveryGrowth(item);
      }
      // channel ごとに全採用か未採用。未採用なら既存の pending を保つ。
      if (!fits()) { refused++; continue; }
    }
    for (const item of replaced) superseded.add(item);
    for (const item of out) evicted.add(item);
    admitted.push(intent);
  }
  const intents = [...current.map((item) => superseded.has(item) || evicted.has(item)
    ? { ...item, disposition: "superseded" as const } : item), ...admitted];
  return { intents, admitted, dropped: evicted.size + refused };
}

// ---- 容量（P3-C5-CAPACITY=A） ----

function tier(value: Subject, now: number): number | null {
  if (value.effective !== "active") return value.retainUntil != null && value.retainUntil <= now ? 0 : 1;
  return value.operation === "normal" ? null : 2;
}
function oldest(left: Subject, right: Subject): number {
  const time = Date.parse(left.source.reportDateTimeRaw) - Date.parse(right.source.reportDateTimeRaw);
  if (time !== 0) return time;
  const a = [left.operation, left.subject, left.source.inputId], b = [right.operation, right.subject, right.source.inputId];
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

// 超過した上限ごとに、その超過を実際に減らす subject だけを (1) 期限切れの非 active (2) 最古の非 active (3) training/test の
// active の順に退去する。normal の active だけで超えるなら null（capacityExceeded）。
// ponytail: 退去の順は超過の種類ごとに 1 回並べる。退去は稀で上限 512・1024 に限られる（AGENTS.md の稀な一括処理）。
function fit(forecasts: readonly TsunamiForecastSubject[], observations: readonly TsunamiObservationSubject[],
  intents: readonly TsunamiIntent[], target: string, now: number):
  Readonly<{ forecasts: readonly TsunamiForecastSubject[]; observations: readonly TsunamiObservationSubject[];
    evicted: readonly Subject[] }> | null {
  const obsCount = { VTSE51: 0, VTSE52: 0 }, stationCount = { VTSE51: 0, VTSE52: 0 };
  for (const item of observations) { obsCount[item.family]++; stationCount[item.family] += item.stations.length; }
  let forecastCount = forecasts.length;
  let size = generationBytes(forecasts, observations, intents);
  if (forecastCount <= FORECAST_LIMIT && size <= GENERATION_LIMIT && FAMILIES.every((family) =>
    obsCount[family] <= OBSERVATION_LIMIT && stationCount[family] <= STATION_LIMIT)) return { forecasts, observations, evicted: [] };
  const evicted = new Set<Subject>();
  const remove = (item: Subject) => {
    if (evicted.has(item)) return;
    evicted.add(item);
    size -= subjectBytes(item) + 1;
    if ("stations" in item) { obsCount[item.family]--; stationCount[item.family] -= item.stations.length; return; }
    forecastCount--;
    // P3-C5-OBS-LIFETIME=A: VTSE41 の退去は同じ operation・EventID の forecastEnded の観測を同じ参照交換で消す。
    for (const value of observations) if (value.effective === "forecastEnded" && value.operation === item.operation
      && value.eventId === item.eventId && value.subject !== target) remove(value);
  };
  const run = (pool: readonly Subject[], over: () => boolean): boolean => {
    if (!over()) return true;
    const ranked = pool.flatMap((item) => {
      const rank = item.subject === target || evicted.has(item) ? null : tier(item, now);
      return rank == null ? [] : [{ item, rank }];
    }).sort((left, right) => left.rank - right.rank || oldest(left.item, right.item));
    for (const { item } of ranked) { if (!over()) break; remove(item); }
    return !over();
  };
  const ok = run(forecasts, () => forecastCount > FORECAST_LIMIT)
    && FAMILIES.every((family) => run(observations.filter((item) => item.family === family), () => obsCount[family] > OBSERVATION_LIMIT))
    && FAMILIES.every((family) => run(observations.filter((item) => item.family === family && item.stations.length > 0),
      () => stationCount[family] > STATION_LIMIT))
    && run([...forecasts, ...observations], () => size > GENERATION_LIMIT);
  if (!ok) return null;
  return { forecasts: forecasts.filter((item) => !evicted.has(item)),
    observations: observations.filter((item) => !evicted.has(item)), evicted: [...evicted] };
}

// ---- outcome と view ----

function highest(value: Subject): TsunamiAreaClass | null {
  if ("stations" in value) return null;
  let best: TsunamiAreaClass | null = null;
  for (const area of [...value.areas, ...value.unkeyedAreas]) {
    const current = classOf(area);
    if (AREA_RANK[current] > 0 && (best == null || AREA_RANK[current] > AREA_RANK[best])) best = current;
  }
  return best;
}
const viewOutcomeCache = new WeakMap<Subject, SubjectOutcome>();
function subjectOutcome(value: Subject, extra: Readonly<Record<string, JsonValue>> | null = null,
  changedFields: readonly string[] = []): SubjectOutcome {
  const reusable = extra == null && changedFields.length === 0;
  const cached = reusable ? viewOutcomeCache.get(value) : undefined;
  if (cached != null) return cached;
  const facts: Record<string, JsonValue> = "stations" in value
    ? { family: value.family, eventId: value.eventId, effective: value.effective, stationCount: value.stations.length }
    : { family: "VTSE41", eventId: value.eventId, effective: value.effective };
  const result: SubjectOutcome = { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw,
    transition: value.effective, severity: highest(value), source: value.source, facts: { ...facts, ...extra }, changedFields };
  if (reusable) viewOutcomeCache.set(value, result);
  return result;
}
function displaySubject(value: Subject): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-T" }>> {
  return { unit: "U-T", operation: value.operation, subject: value.subject, office: null, current: value,
    subjects: [subjectOutcome(value)] };
}

// ---- VTSE41（I-U-T.forecastSemantics、Q-ENUM.revisionOrder） ----

function transitionOf(from: TsunamiAreaClass, to: TsunamiAreaClass, wasActive: boolean): TsunamiTransitionRecord["transition"] | null {
  const before = AREA_RANK[from], after = AREA_RANK[to];
  if (before === 0) return after === 0 ? null : wasActive ? "expanded" : "issued";
  if (after === 0) return "released";
  return after > before ? "upgraded" : after < before ? "downgraded" : null;
}

function forecastTitle(next: TsunamiForecastSubject, wasActive: boolean): string {
  // Q-NOTICE.payload: 直前が active の released は予報区域が残っていても解除。直前が active でない released は下の式で予報か解除。
  if (next.effective === "released" && wasActive) return "津波警報・注意報の解除";
  const areas = [...next.areas, ...next.unkeyedAreas];
  const named: readonly [TsunamiAreaClass, string][] = [["majorWarning", "大津波警報"], ["warning", "津波警報"]];
  for (const [value, name] of named) if (areas.some((area) => classOf(area) === value)) return name;
  const unknown = areas.find((area) => classOf(area) === "unknown");
  if (unknown != null) return unknown.kindName;
  return areas.some((area) => classOf(area) === "advisory") ? "津波注意報"
    : areas.some((area) => classOf(area) === "forecast") ? "津波予報" : "津波警報・注意報の解除";
}

function receiveForecast(state: TsunamiUnitState, candidate: ForecastCandidate, clock: ClockReading): Result {
  const index = state.forecasts.findIndex((item) => item.subject === candidate.subject);
  const existing = index < 0 ? null : state.forecasts[index];
  const unchanged = (reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason }],
      diagnostics } });
  if (existing != null) {
    const time = candidate.reportDateTimeMs - Date.parse(existing.source.reportDateTimeRaw);
    const rank = candidate.infoRank - (INFO_RANK.get(existing.source.infoTypeRaw.trim()) ?? 0);
    if (time < 0 || time === 0 && rank < 0) return unchanged("stale");
    if (time === 0 && rank === 0) {
      const same = existing.effective === "cancelled" ? candidate.cancelled : !candidate.cancelled
        && isDeepStrictEqual(existing.areas, candidate.areas) && isDeepStrictEqual(existing.unkeyedAreas, candidate.unkeyedAreas);
      // Q-REV: 同じ時刻・同じ InfoType で中身が違えば先着を保つ。
      return same ? unchanged("duplicate") : unchanged("stale", [{ level: "WARN", component: "tsunami",
        reason: "tsunamiRevisionConflict", inputId: candidate.source.inputId, unit: "U-T" }]);
    }
  }
  const now = clock.wallTimeMs;
  const wasActive = existing?.effective === "active";
  // P3-C5-TRANSITION-BASIS=A: 保存している区域との差。subject が無いか取消なら直前は全区域 none。
  const prior = existing == null || existing.effective === "cancelled" ? [] : existing.areas;
  const transitions: TsunamiTransitionRecord[] = [];
  let next: TsunamiForecastSubject;
  if (candidate.cancelled) {
    next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, source: candidate.source,
      effective: "cancelled", areas: [], unkeyedAreas: [],
      retainUntil: existing != null && !wasActive && existing.retainUntil != null ? existing.retainUntil : now + RETAIN_MS };
  } else {
    const before = new Map(prior.map((area) => [area.code, area]));
    const codes = new Set(candidate.areas.map((area) => area.code));
    for (const area of candidate.areas) {
      const from = before.get(area.code)?.areaClass ?? "none";
      const transition = transitionOf(from, area.areaClass, wasActive);
      if (transition != null) transitions.push({ areaCode: area.code, from, to: area.areaClass, transition });
    }
    for (const area of prior) if (!codes.has(area.code)) {
      const transition = transitionOf(area.areaClass, "none", wasActive);
      if (transition != null) transitions.push({ areaCode: area.code, from: area.areaClass, to: "none", transition });
    }
    // unkeyedAreas は effective と残った区分の段階にだけ数える（P3-C5-KIND-ENUM=B）。
    const active = [...candidate.areas, ...candidate.unkeyedAreas].some((area) => AREA_RANK[classOf(area)] >= 2);
    next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, source: candidate.source,
      effective: active ? "active" : "released", areas: candidate.areas, unkeyedAreas: candidate.unkeyedAreas,
      retainUntil: active ? null : existing?.effective === "released" && existing.retainUntil != null ? existing.retainUntil : now + RETAIN_MS };
  }
  const raised = transitions.filter((item) => item.transition === "issued" || item.transition === "expanded" || item.transition === "upgraded");
  const lowered = transitions.some((item) => item.transition === "downgraded" || item.transition === "released");
  const series: TsunamiReportSeries = raised.length !== 0 ? lowered ? "mixed" : "escalation" : lowered ? "deescalation" : "none";

  // P3-C5-OBS-LIFETIME=A: 同じ採用の中で同じ operation・EventID の観測の生死を決める。
  const changes: Change[] = [];
  let observationsChanged = false;
  const observations = state.observations.map((item) => {
    if (item.operation !== candidate.operation || item.eventId !== candidate.eventId) return item;
    let after = item;
    if (next.effective !== "active") {
      if ((item.effective === "active" || item.effective === "forecastEnded") && (item.effective !== "forecastEnded"
        || item.retainUntil !== next.retainUntil)) after = { ...item, effective: "forecastEnded", retainUntil: next.retainUntil };
    } else if (item.effective === "forecastEnded")
      after = item.validUntil != null && item.validUntil > now ? { ...item, effective: "active", retainUntil: null }
        : expireObservation(item, now);
    if (after !== item) { observationsChanged = true; changes.push([item, after]); }
    return after;
  });

  const generation = state.persistence.currentGeneration + 1;
  let fresh: TsunamiIntent[] = [];
  if (candidate.cancelled) {
    // 取消の前に active だった subject だけ通知する（Q-NOTICE.generationTable cancellation）。
    if (wasActive) fresh = intentsFor(candidate.source, "cancelled", payloadOf(candidate.operation, "cancel",
      "[取消] 津波警報・注意報・予報", "この情報は取り消されました", false), generation, now);
  } else {
    const rising = new Set(raised.map((item) => item.areaCode));
    const change = raised.reduce<Exclude<Level, "cancel">>((level, item) => maxLevel(level, riseLevel(item.to)), "info");
    const remaining = next.effective === "active" ? "normal" : "info";
    const title = forecastTitle(next, wasActive);
    const entries = [...candidate.areas.map((area) => ({ name: area.name, kind: area.kindName, raised: rising.has(area.code) })),
      ...candidate.unkeyedAreas.map((area) => ({ name: area.name, kind: area.kindName, raised: false }))];
    // escalation では上がった区域を先に並べる（Q-NOTICE.payload）。
    const ordered = rising.size === 0 ? entries : [...entries.filter((item) => item.raised), ...entries.filter((item) => !item.raised)];
    const parts = [[...new Set(ordered.map((item) => item.kind))].join("・"), ordered.slice(0, 3).map((item) => item.name).join(", "),
      candidate.headline ?? ""].filter((part) => part !== "");
    const transition = !wasActive && next.effective === "active" ? "activated" : wasActive && next.effective !== "active" ? "released" : "updated";
    fresh = intentsFor(candidate.source, transition, payloadOf(candidate.operation, maxLevel(change, remaining), title,
      parts.length === 0 ? title : parts.join(" / "), candidate.infoRank === 2), generation, now);
  }
  changes.push([existing, next]);
  const forecasts = index < 0 ? [...state.forecasts, next] : state.forecasts.map((item, at) => at === index ? next : item);
  const semantic = existing == null || existing.effective !== next.effective || observationsChanged
    || !isDeepStrictEqual(existing.areas, next.areas) || !isDeepStrictEqual(existing.unkeyedAreas, next.unkeyedAreas);
  return adopt(state, candidate, clock, { forecasts, observations, fresh, cancelSubject: candidate.cancelled ? candidate.subject : null,
    semantic, changes, target: next, facts: { areaTransitions: transitions, series } });
}

// ---- VTSE51/52（P3-C5-OBS-MERGE=A、P3-C5-OBS-LIFETIME=A） ----

function sameRevision(left: TsunamiStation["revision"], right: TsunamiStation["revision"]): boolean {
  return Date.parse(left.reportDateTimeRaw) === Date.parse(right.reportDateTimeRaw) && Number(left.serialRaw) === Number(right.serialRaw)
    && left.infoTypeRaw.trim() === right.infoTypeRaw.trim();
}

function receiveObservation(state: TsunamiUnitState, candidate: ObservationCandidate, clock: ClockReading): Result {
  const index = state.observations.findIndex((item) => item.subject === candidate.subject);
  const existing = index < 0 ? null : state.observations[index];
  const unchanged = (reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason }],
      diagnostics } });
  const conflict = () => unchanged("stale", [{ level: "WARN", component: "tsunami", reason: "tsunamiRevisionConflict",
    inputId: candidate.source.inputId, unit: "U-T" }]);
  // stationsを捨てた subject（取消・失効）は、より新しい revision から空の直前として始め直す。
  const base = existing == null || existing.effective === "cancelled" || existing.effective === "expired" ? null : existing;
  const emptyBase = base == null;
  let mode: "newer" | "higher" | "equal" = "newer";
  if (existing != null) {
    const time = candidate.reportDateTimeMs - Date.parse(existing.source.reportDateTimeRaw)
      || candidate.serial - Number(existing.source.serialRaw);
    const rank = candidate.infoRank - (INFO_RANK.get(existing.source.infoTypeRaw.trim()) ?? 0);
    if (time < 0 || time === 0 && rank < 0) return unchanged("stale");
    if (time === 0 && rank === 0) {
      if (candidate.cancelled) return unchanged("duplicate");
      if (emptyBase) return unchanged("stale");
      mode = "equal";
    } else if (time === 0) mode = "higher";
  }
  const now = clock.wallTimeMs;
  const wasActive = existing?.effective === "active";
  const forecast = state.forecasts.find((item) => item.operation === candidate.operation && item.eventId === candidate.eventId);
  let next: TsunamiObservationSubject;
  let touched = existing == null || existing.effective !== "active" && existing.effective !== "forecastEnded";
  if (candidate.cancelled) {
    next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, family: candidate.family,
      source: candidate.source, effective: "cancelled", stations: [], estimations: [], validUntil: null,
      retainUntil: existing != null && existing.effective !== "active" && existing.retainUntil != null ? existing.retainUntil : now + RETAIN_MS };
    touched = true;
  } else {
    // 受信 1 回につき既存の code → 要素の Map を 1 回作って引く（I-U-T.computation）。
    const stations = new Map((base?.stations ?? []).map((item) => [item.code, item]));
    for (const item of candidate.stations) {
      const old = stations.get(item.code);
      if (mode === "equal" && old != null && sameRevision(old.revision, item.revision)) {
        if (!sameStation(old, item)) return conflict();
        continue;
      }
      if (old == null || !sameStation(old, item)) touched = true;
      stations.set(item.code, item);
    }
    let estimations: readonly TsunamiEstimation[];
    if (mode === "newer" || base == null) {
      estimations = candidate.estimations;
      if (base != null && !isDeepStrictEqual(base.estimations, estimations)) touched = true;
    } else {
      const merged = new Map(base.estimations.map((item) => [item.areaCode, item]));
      for (const item of candidate.estimations) {
        const old = merged.get(item.areaCode);
        if (old != null && isDeepStrictEqual(old, item)) continue;
        if (mode === "equal" && old != null) return conflict();
        touched = true;
        merged.set(item.areaCode, item);
      }
      estimations = [...merged.values()];
    }
    if (mode === "equal" && !touched) return unchanged("duplicate");
    const validUntil = candidate.reportDateTimeMs + VALID_MS;
    const ended = forecast != null && forecast.effective !== "active";
    next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, family: candidate.family,
      source: candidate.source, effective: ended ? "forecastEnded" : "active", stations: [...stations.values()], estimations,
      validUntil, retainUntil: ended ? forecast.retainUntil : null };
    if (!ended && validUntil <= now) next = expireObservation(next, now);
  }
  const generation = state.persistence.currentGeneration + 1;
  const title = OBSERVATION_TITLE[candidate.family];
  // P3-C5-NOTICE-OBSERVATION=C: 観測は info。forecastEnded のままの採用では作らない（P3-C5-OBS-LIFETIME=A の例外）。
  const fresh = candidate.cancelled
    ? wasActive ? intentsFor(candidate.source, "cancelled", payloadOf(candidate.operation, "cancel", `[取消] ${title}`,
      "この情報は取り消されました", false), generation, now) : []
    : next.effective === "active" ? intentsFor(candidate.source, wasActive ? "updated" : "activated", payloadOf(candidate.operation,
      "info", title, [candidate.stations.slice(0, 3).map((item) => item.name).join(", "), candidate.headline ?? ""]
        .filter((part) => part !== "").join(" / ") || title, candidate.infoRank === 2), generation, now) : [];
  const observations = index < 0 ? [...state.observations, next] : state.observations.map((item, at) => at === index ? next : item);
  return adopt(state, candidate, clock, { forecasts: state.forecasts, observations, fresh,
    cancelSubject: candidate.cancelled ? candidate.subject : null, semantic: touched || existing?.effective !== next.effective,
    changes: [[existing, next]], target: next, facts: {} });
}

// 採用の共通部: 通知の収容、容量の退去、保存世代を一回の参照交換で確定する。
function adopt(state: TsunamiUnitState, candidate: ForecastCandidate | ObservationCandidate, clock: ClockReading, proposal: Readonly<{
  forecasts: readonly TsunamiForecastSubject[]; observations: readonly TsunamiObservationSubject[]; fresh: readonly TsunamiIntent[];
  cancelSubject: string | null; semantic: boolean; changes: readonly Change[]; target: Subject; facts: Readonly<Record<string, JsonValue>>;
}>): Result {
  const notices = admit(state.intents, proposal.fresh, proposal.cancelSubject);
  const fitted = fit(proposal.forecasts, proposal.observations, notices.intents, candidate.subject, clock.wallTimeMs);
  const evidence = { family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" as const };
  if (fitted == null) return { changes: [], step: { ...idle(state), decisions: [{ subject: candidate.subject,
    operation: candidate.operation, decision: "capacityExceeded", rejection: evidence }] } };
  const next: TsunamiUnitState = { ...state, forecasts: fitted.forecasts, observations: fitted.observations, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) };
  const change = proposal.semantic || fitted.evicted.length !== 0 ? "semantic" as const : "revisionOnly" as const;
  const diagnostics: DiagnosticDetails[] = [];
  if (fitted.evicted.length !== 0) diagnostics.push({ level: "INFO", component: "tsunami", reason: "tsunamiCapacityEvicted",
    unit: "U-T", count: fitted.evicted.length });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "tsunami", reason: "notificationCapacityEvicted",
    unit: "U-T", count: notices.dropped });
  return {
    changes: [...proposal.changes, ...fitted.evicted.map((item): Change => [item, null])],
    step: { state: next, nextDeadline: nextDeadline(next),
      decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "changed", reason: null, change,
        currentEstablished: evidence }],
      intents: notices.admitted,
      outcomes: [{ kind: "accepted", change, subjects: [subjectOutcome(proposal.target, proposal.facts,
        "stations" in proposal.target ? ["observations"] : ["forecasts"])] }],
      diagnostics },
  };
}

// ---- 期限（I-U-T.deadlines） ----

// 到来した分だけを回収する。到来していなければ同じ state 参照を返す。
function collect(state: TsunamiUnitState, clock: ClockReading): Readonly<{ state: TsunamiUnitState; changes: readonly Change[];
  expired: readonly TsunamiObservationSubject[]; expiredIntents: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expired: [], expiredIntents: 0 };
  const changes: Change[] = [];
  const expired: TsunamiObservationSubject[] = [];
  const forecasts = subjectDeadline(state.forecasts) > now ? state.forecasts : state.forecasts.filter((item) => {
    if (item.retainUntil == null || item.retainUntil > now) return true;
    changes.push([item, null]);
    return false;
  });
  const observations = subjectDeadline(state.observations) > now ? state.observations : state.observations.flatMap((item) => {
    if (item.effective !== "active") {
      if (item.retainUntil == null || item.retainUntil > now) return [item];
      changes.push([item, null]);
      return [];
    }
    if (item.validUntil == null || item.validUntil > now) return [item];
    const after = expireObservation(item, now);
    expired.push(after);
    const kept = after.retainUntil != null && after.retainUntil > now;
    changes.push([item, kept ? after : null]);
    return kept ? [after] : [];
  });
  const intents = intentDeadline(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = intents === state.intents ? 0
    : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  if (forecasts === state.forecasts && observations === state.observations && intents === state.intents)
    return { state, changes: [], expired: [], expiredIntents: 0 };
  return { state: { ...state, forecasts, observations, intents, persistence: dirty(state.persistence, clock.monotonicMs) },
    changes, expired, expiredIntents };
}

function deadlineStep(state: TsunamiUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock);
  const subjects = applied.expired.map((item) => subjectOutcome(item, null, ["effective", "stations", "validUntil"]));
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "tsunami",
    reason: "notificationExpired", unit: "U-T", count: applied.expiredIntents }];
  return { changes: applied.changes, step: { ...idle(applied.state),
    decisions: applied.expired.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const,
      reason: null, change: "semantic" as const, currentEstablished: null })),
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects }]
      : subjects.length === 0 ? [] : [{ kind: "deadlineApplied", subjects }],
    diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: TsunamiUnitState, input: Extract<TsunamiInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changed = new Map<string, TsunamiIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changed.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changed.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4 の先例）。
  const next = { ...state, intents: state.intents.map((item) => changed.get(item.id) ?? item),
    persistence: dirty(state.persistence, input.clock.monotonicMs) };
  const adopted = [...changed.values()];
  return { changes: [], step: { ...idle(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "deliveryOnly" as const, currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted" as const, change: "deliveryOnly" as const, subjects: [{ subject: item.subject,
      operation: item.operation, informationType: item.source.infoTypeRaw, transition: item.disposition, severity: null,
      source: item.source, facts: { intentId: item.id, channel: item.channel }, changedFields: ["intents"] }] })) } };
}

function restore(state: TsunamiUnitState, persisted: PersistedTsunamiUnit, clock: ClockReading): Result {
  const decoded = tsunamiUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "tsunami",
    reason: "requiredStructureInvalid", unit: "U-T" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。
  const applied = collect({ ...decoded.state, persistence: state.persistence }, clock);
  const shown = [...applied.state.forecasts, ...applied.state.observations].filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-T"], coverage: shown.map((item) => item.subject), subjects: [] }],
    diagnostics: applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "tsunami", reason: "notificationExpired",
      unit: "U-T", count: applied.expiredIntents }] } };
}

function receive(state: TsunamiUnitState, input: Extract<TsunamiInput, { kind: "receive" }>): Result {
  const parsed = parseTsunami(input.material);
  const noChange = (subject: string, operation: Operation): Result => ({ changes: [], step: { ...idle(state),
    decisions: [{ subject, operation, decision: "unchanged", reason: "noChange" }] } });
  switch (parsed.kind) {
    case "rejected": return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
      operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
    // Q-ENUM の VTSE51.legalMissing: 観測の無い報は state・watermark を変えず、intent・outcome・診断を出さない。
    case "noObservation": return noChange(parsed.subject, parsed.operation);
    case "accepted": {
      const { candidate } = parsed;
      // Q-NOTICE.recovery: origin=recovery は C16 の候補採用まで state に適用しない。
      if (candidate.source.origin === "recovery") return noChange(candidate.subject, candidate.operation);
      return candidate.kind === "forecast" ? receiveForecast(state, candidate, input.clock) : receiveObservation(state, candidate, input.clock);
    }
    default: { const missing: never = parsed; throw new Error(`tsunami parse result ${String(missing)} is not handled`); }
  }
}

function reduceCore(state: TsunamiUnitState, input: TsunamiInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, false);
    case "shutdown": return deadlineStep(state, input.clock, true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`tsunami input ${String(missing)} is not handled`); }
  }
}

function reduceTsunamiUnit(state: TsunamiUnitState, input: TsunamiInput): TsunamiUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: Subject | null; after: Subject | null }>();
  for (const [before, after] of changes) {
    const key = (after ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: TsunamiUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-T", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-T content revision exhausted");
  // I-U-T.confirmationScope: scope は常態を確立した（active になった）VTSE41 の採用からだけ出す。観測は対象外（P3-C5-N2）。
  const confirmationEvidence: TsunamiUnitStep["confirmationEvidence"] = input.kind !== "receive" ? []
    : step.decisions.flatMap((item) => {
      const current = item.decision === "changed" && item.currentEstablished?.family === "VTSE41"
        ? step.state.forecasts.find((value) => value.subject === item.subject) : undefined;
      return current?.effective === "active" ? [{ source: "acceptedReport" as const, scopes: [{ unit: "U-T" as const,
        operation: item.operation, kind: "event" as const, eventId: current.eventId }] }] : [];
    });
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence };
}

function toTsunamiView(state: TsunamiUnitState): TsunamiUnitView {
  const forecasts = state.forecasts.filter(visible), observations = state.observations.filter(visible);
  const shown: Subject[] = [...forecasts, ...observations];
  return { unit: "U-T", semanticRevision: shown.map((item) => `${item.subject}:${item.source.reportDateTimeRaw}:${item.source.serialRaw}:`
    + `${item.source.infoTypeRaw}`).sort().join("|"), contentRevision: String(state.contentRevision), admission: {},
  subjects: shown.map((item) => subjectOutcome(item)), forecasts, observations };
}

// ---- codec（I-U-T.persisted・I-U-T.decode、唯一の TsunamiUnitCodec） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const text = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown): value is number | null => value === null || finite(value);
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function reportRef(value: unknown): ReportRef | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !text(row.inputId) || !text(row.family) || !text(row.subject)
    || !text(row.reportDateTimeRaw) || !Number.isFinite(Date.parse(row.reportDateTimeRaw)) || !text(row.serialRaw)
    || !text(row.infoTypeRaw) || !INFO_RANK.has(row.infoTypeRaw.trim())
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  return { inputId: row.inputId, origin: row.origin, operation, family: row.family, subject: row.subject,
    reportDateTimeRaw: row.reportDateTimeRaw, serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
}
function materialValue(value: unknown): MaterialValue | null {
  const row = record(value);
  if (row == null) return null;
  if (row.kind === "missing") return { kind: "missing" };
  if ((row.kind === "empty" || row.kind === "unknown") && text(row.raw)) return { kind: row.kind, raw: row.raw };
  if (row.kind === "text" && text(row.raw) && text(row.value)) return { kind: "text", value: row.value, raw: row.raw };
  if (row.kind === "number" && text(row.raw) && finite(row.value)) return { kind: "number", value: row.value, raw: row.raw };
  if (row.kind === "range" && text(row.raw) && finite(row.value) && (row.bound === "lower" || row.bound === "upper"))
    return { kind: "range", bound: row.bound, value: row.value, raw: row.raw };
  return null;
}
function heightOf(value: unknown): TsunamiHeight | null | "invalid" {
  if (value === null) return null;
  const row = record(value);
  const material = materialValue(row?.value);
  if (row == null || material == null || !textOrNull(row.condition) || !textOrNull(row.description)) return "invalid";
  return { value: material, condition: row.condition, description: row.description };
}
// station・推定の高さは parser が作る種類（数値・NaN・範囲表記、Q-ENUM.invalid）だけ。
function measured(height: TsunamiHeight | null): boolean {
  return height == null || height.value.kind === "number" || height.value.kind === "unknown" || height.value.kind === "range";
}
function forecastArea(value: unknown): TsunamiForecastArea | null {
  const row = record(value), first = record(row?.firstHeight);
  const maxHeight = heightOf(row?.maxHeight);
  if (row == null || first == null || maxHeight === "invalid" || !text(row.code) || !/^\d{3}$/.test(row.code) || !text(row.name)
    || !text(row.kindCode) || !text(row.kindName) || !textOrNull(first.arrivalTimeRaw) || !textOrNull(first.condition)
    || row.areaClass !== (KIND_CLASS.get(row.kindCode) ?? "unknown")) return null;
  return { code: row.code, name: row.name, areaClass: KIND_CLASS.get(row.kindCode) ?? "unknown", kindCode: row.kindCode,
    kindName: row.kindName, firstHeight: { arrivalTimeRaw: first.arrivalTimeRaw, condition: first.condition }, maxHeight };
}
function unkeyedArea(value: unknown): TsunamiUnkeyedArea | null {
  const row = record(value);
  return row != null && text(row.name) && text(row.kindCode) && text(row.kindName)
    ? { name: row.name, kindCode: row.kindCode, kindName: row.kindName } : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
function forecastSubject(value: unknown): TsunamiForecastSubject | null {
  const row = record(value);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const areas = list(row?.areas, forecastArea), unkeyedAreas = list(row?.unkeyedAreas, unkeyedArea);
  if (row == null || operation == null || source == null || areas == null || unkeyedAreas == null || !text(row.eventId)
    || !/^\d{14}$/.test(row.eventId) || row.subject !== `${operation}/VTSE41/${row.eventId}` || source.subject !== row.subject
    || source.operation !== operation || source.family !== "VTSE41" || !finiteOrNull(row.retainUntil)
    || !unique(areas.map((area) => area.code))) return null;
  const active = [...areas, ...unkeyedAreas].some((area) => AREA_RANK[classOf(area)] >= 2);
  const effective = row.effective === "active" || row.effective === "released" || row.effective === "cancelled" ? row.effective : null;
  if (effective == null || (effective === "cancelled" ? areas.length !== 0 || unkeyedAreas.length !== 0 : active !== (effective === "active"))
    || (effective === "active") !== (row.retainUntil === null)) return null;
  return { subject: row.subject, eventId: row.eventId, operation, source, effective, areas, unkeyedAreas, retainUntil: row.retainUntil };
}
function station(value: unknown): TsunamiStation | null {
  const row = record(value), first = record(row?.firstHeight), max = record(row?.maxHeight), revision = record(row?.revision);
  const maxHeight = heightOf(max?.height);
  if (row == null || first == null || max == null || revision == null || maxHeight === "invalid" || !measured(maxHeight)
    || !text(row.code) || row.code === ""
    || !text(row.name) || !textOrNull(row.areaCode) || !textOrNull(row.areaName) || !textOrNull(row.sensor)
    || !textOrNull(first.arrivalTimeRaw) || !textOrNull(first.initial) || !textOrNull(first.condition)
    || !textOrNull(max.dateTimeRaw) || !textOrNull(max.condition) || !text(revision.reportDateTimeRaw)
    || !text(revision.serialRaw) || !text(revision.infoTypeRaw)) return null;
  return { code: row.code, name: row.name, areaCode: row.areaCode, areaName: row.areaName, sensor: row.sensor,
    firstHeight: { arrivalTimeRaw: first.arrivalTimeRaw, initial: first.initial, condition: first.condition },
    maxHeight: { dateTimeRaw: max.dateTimeRaw, condition: max.condition, height: maxHeight },
    revision: { reportDateTimeRaw: revision.reportDateTimeRaw, serialRaw: revision.serialRaw, infoTypeRaw: revision.infoTypeRaw } };
}
function estimation(value: unknown): TsunamiEstimation | null {
  const row = record(value), first = record(row?.firstHeight), max = record(row?.maxHeight);
  const height = heightOf(max?.height);
  if (row == null || first == null || max == null || height === "invalid" || !measured(height) || !text(row.areaCode) || row.areaCode === ""
    || !text(row.areaName) || !textOrNull(first.arrivalTimeRaw) || !textOrNull(first.condition) || !textOrNull(max.condition)) return null;
  return { areaCode: row.areaCode, areaName: row.areaName, firstHeight: { arrivalTimeRaw: first.arrivalTimeRaw, condition: first.condition },
    maxHeight: { condition: max.condition, height } };
}
function observationSubject(value: unknown): TsunamiObservationSubject | null {
  const row = record(value);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const family = row?.family === "VTSE51" || row?.family === "VTSE52" ? row.family : null;
  const stations = list(row?.stations, station), estimations = list(row?.estimations, estimation);
  const effective = row?.effective === "active" || row?.effective === "cancelled" || row?.effective === "forecastEnded"
    || row?.effective === "expired" ? row.effective : null;
  if (row == null || operation == null || source == null || family == null || stations == null || estimations == null
    || effective == null || !text(row.eventId) || !/^\d{14}$/.test(row.eventId)
    // reducer は serialRaw を数として比べる（Q-ENUM.priorityRule の Serial: 正整数）。
    || !/^[1-9]\d*$/.test(source.serialRaw.trim()) || !Number.isSafeInteger(Number(source.serialRaw))
    || row.subject !== `${operation}/tsunamiObservation:${family}/${row.eventId}` || source.subject !== row.subject
    || source.operation !== operation || source.family !== family || !finiteOrNull(row.validUntil) || !finiteOrNull(row.retainUntil)
    || !unique(stations.map((item) => item.code)) || !unique(estimations.map((item) => item.areaCode))
    || family === "VTSE51" && estimations.length !== 0
    || (effective === "cancelled" || effective === "expired") && (stations.length !== 0 || estimations.length !== 0)
    || (effective === "active") !== (row.retainUntil === null) || effective === "active" && row.validUntil === null) return null;
  return { subject: row.subject, eventId: row.eventId, operation, family, source, effective, stations, estimations,
    validUntil: row.validUntil, retainUntil: row.retainUntil };
}
const SUBJECT_FORM = /^(normal|training|test)\/(?:VTSE41|tsunamiObservation:VTSE5[12])\/\d{14}$/;
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intent(value: unknown): TsunamiIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const level = LEVEL_SET.find((item) => item === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((item) => item === row?.transition);
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((item) => item === row?.disposition);
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || disposition == null || !text(row.id) || row.unit !== "U-T" || !text(row.subject) || SUBJECT_FORM.exec(row.subject)?.[1] !== operation
    || source.subject !== row.subject || source.operation !== operation
    || payload.domain !== "tsunami" || !text(payload.title) || payload.title === ""
    || !text(payload.body) || payload.body === "" || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt)
    || !Number.isSafeInteger(row.attempts) || !text(row.configRevision) || row.expiresAt < row.createdAt) return null;
  const attempts = Number(row.attempts);
  if (attempts < 0) return null;
  return { id: row.id, unit: "U-T", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "tsunami", level, title: payload.title, body: payload.body }, createdAt: row.createdAt, expiresAt: row.expiresAt,
    nextAttemptAt: row.nextAttemptAt, attempts, configRevision: row.configRevision, disposition };
}
function persisted(value: unknown): PersistedTsunamiUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const forecasts = list(row.forecasts, forecastSubject), observations = list(row.observations, observationSubject);
  const intents = list(row.intents, intent);
  if (forecasts == null || observations == null || intents == null || forecasts.length > FORECAST_LIMIT
    || !unique([...forecasts, ...observations].map((item) => item.subject)) || !unique(intents.map((item) => item.id))) return null;
  for (const family of FAMILIES) {
    const own = observations.filter((item) => item.family === family);
    if (own.length > OBSERVATION_LIMIT || own.reduce((sum, item) => sum + item.stations.length, 0) > STATION_LIMIT) return null;
  }
  const pending = intents.filter((item) => item.disposition === "pending");
  if (pending.length > PENDING_ITEMS || listBytes(pending) + reserve(pending) > PENDING_BYTES
    || generationBytes(forecasts, observations, intents) > GENERATION_LIMIT) return null;
  return { schemaVersion: SCHEMA, forecasts, observations, intents };
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const tsunamiUnitCodec: TsunamiUnitCodec = {
  schemaVersion: SCHEMA,
  // state は reducer が上限の内側で作るので、encode は保存 field だけを並べる（contentRevision・persistence は保存しない）。
  encode: (state) => ({ schemaVersion: SCHEMA, forecasts: state.forecasts, observations: state.observations, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-tsunami-unit-v1 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-T.runtimeRows）。
const tsunamiUnit = {
  unit: "U-T",
  reduce: reduceTsunamiUnit,
  toView: toTsunamiView,
  persistence: { kind: "durable", codec: tsunamiUnitCodec },
  confirmationScopeLimit: 512,
  withoutNormal: (state) => ({ ...state, forecasts: state.forecasts.filter((item) => item.operation !== "normal"),
    observations: state.observations.filter((item) => item.operation !== "normal") }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => [...state.forecasts, ...state.observations]
    .filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-T">;

export { reduceTsunamiUnit, toTsunamiView, tsunamiUnit, tsunamiUnitCodec };
