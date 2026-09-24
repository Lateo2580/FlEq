import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading,
  FreshnessRecord,
  JsonValue,
  NotificationIntent,
  PersistenceStatus,
  ReportRef,
  RuntimeDisplaySubject,
  SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  PersistedWeatherCurrentUnit,
  WeatherCurrentHistory,
  WeatherCurrentInput,
  WeatherCurrentSnapshot,
  WeatherCurrentTombstone,
  WeatherCurrentUnitCodec,
  WeatherCurrentUnitState,
  WeatherCurrentUnitStep,
  WeatherCurrentUnitView,
} from "../../../contracts/p2-weather-current-unit.types";
import {
  WEATHER_FAMILIES,
  capacityUnavailable,
  dirty,
  expireIntents,
  nextWeatherCurrentDeadline,
  normalizeScopes,
  parseScopeToken,
  reduceWeatherCurrentMeaning,
  scopeContains,
  validScopeSet,
  validateWeatherCandidate,
} from "../../domains/weather-current/weather-current";
import type { CurrentChange } from "../../domains/weather-current/weather-current";
import { serializedEnvelope } from "../../checkpoint/checkpoint";

const SCHEMA = "p2-weather-current-unit-v1" as const;
type InternalStep = Omit<WeatherCurrentUnitStep, "displayChanges" | "confirmationEvidence">;
const GENERATION_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const operations = ["normal", "training", "test"] as const;
// A1 AC09 / spec 5.6: restored references stay unconfirmed until their own report is adopted.
// A symbol survives immutable snapshot copies but never enters the checkpoint JSON.
const restoredAt = Symbol("restoredAt");
const recordByteCache = new WeakMap<object, number>();
const mapByteCache = new WeakMap<object, number>();
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-W", generation: 0,
  capturedAt: 0, payload: { schemaVersion: SCHEMA, national: {}, partials: [], histories: [], ownership: {},
    tombstones: [], freshness: [], unavailable: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;

function recordBytes(value: object): number {
  let bytes = recordByteCache.get(value);
  if (bytes == null) {
    bytes = encoder.encode(JSON.stringify(value)).byteLength;
    recordByteCache.set(value, bytes);
  }
  return bytes;
}

function arrayBytes(values: readonly object[]): number {
  return values.reduce((sum, value) => sum + recordBytes(value), Math.max(values.length - 1, 0));
}

function mapBytes(values: Readonly<Record<string, object | string>>): number {
  const cached = mapByteCache.get(values);
  if (cached != null) return cached;
  const entries = Object.entries(values);
  const bytes = entries.reduce((sum, [key, value]) => sum + encoder.encode(JSON.stringify(key)).byteLength + 1
    + (typeof value === "string" ? encoder.encode(JSON.stringify(value)).byteLength : recordBytes(value)),
    Math.max(entries.length - 1, 0));
  mapByteCache.set(values, bytes);
  return bytes;
}

function reservedGenerationBytes(state: WeatherCurrentUnitState, capturedAt: number): number {
  const generation = state.persistence.currentGeneration;
  if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isFinite(capturedAt)
    || JSON.stringify(generation).length > 32 || JSON.stringify(capturedAt).length > 32)
    throw new RangeError("invalid checkpoint generation or capture time");
  return emptyEnvelopeBytes + 62 + mapBytes(state.national) + arrayBytes(state.partials)
    + arrayBytes(state.histories) + mapBytes(state.ownership) + arrayBytes(state.tombstones)
    + arrayBytes(state.freshness) + arrayBytes(state.unavailable) + arrayBytes(state.intents);
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function operation(value: unknown): value is Operation {
  return value === "normal" || value === "training" || value === "test";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  const record = object(value);
  return record != null && Object.values(record).every(json);
}

function reportRef(value: unknown, unvalidatedTime = false): value is ReportRef {
  const record = object(value);
  return record != null && typeof record.inputId === "string"
    && (record.origin === "live" || record.origin === "recovery" || record.origin === "replay")
    && operation(record.operation) && (WEATHER_FAMILIES as readonly string[]).includes(String(record.family))
    && typeof record.subject === "string" && record.subject !== ""
    && typeof record.reportDateTimeRaw === "string" && (unvalidatedTime || Number.isFinite(Date.parse(record.reportDateTimeRaw)))
    && typeof record.serialRaw === "string" && typeof record.infoTypeRaw === "string";
}

function snapshot(value: unknown): value is WeatherCurrentSnapshot {
  const record = object(value);
  const phenomena = object(record?.phenomena);
  if (record == null || typeof record.subject !== "string" || !operation(record.operation)
    || (record.scope !== "national" && record.scope !== "partial") || typeof record.office !== "string"
    || record.office.trim() === "" || !reportRef(record.source) || phenomena == null || !json(phenomena)) return false;
  const source = record.source;
  return source.subject === record.subject && source.operation === record.operation
    && (record.scope === "national") === (source.family === "VPWS50");
}

function history(value: unknown): value is WeatherCurrentHistory {
  const record = object(value);
  return record != null && typeof record.subject === "string" && operation(record.operation)
    && Array.isArray(record.reports) && record.reports.length > 0 && record.reports.every(snapshot)
    && record.reports.every((item) => item.subject === record.subject && item.operation === record.operation);
}

function tombstone(value: unknown): value is WeatherCurrentTombstone {
  const record = object(value);
  const tuple = Array.isArray(record?.affectedScope) && typeof record.affectedScope[0] === "string"
    ? parseScopeToken(record.affectedScope[0]) : null;
  return record != null && typeof record.subject === "string" && operation(record.operation)
    && reportRef(record.source) && record.source.subject === record.subject && record.source.operation === record.operation
    && Array.isArray(record.affectedScope) && record.affectedScope.every((item) => typeof item === "string")
    && validScopeSet(record.affectedScope) && tuple?.[0] === record.source.family;
}

function intent(value: unknown): value is NotificationIntent {
  const record = object(value);
  return record != null && typeof record.id === "string" && record.unit === "U-W"
    && typeof record.subject === "string" && operation(record.operation) && reportRef(record.source)
    && ["activated", "updated", "cancelled", "released", "expired"].includes(String(record.transition))
    && (record.channel === "desktop" || record.channel === "sound")
    && object(record.payload) != null && json(record.payload)
    && finite(record.createdAt) && finite(record.expiresAt) && finite(record.nextAttemptAt)
    && Number.isSafeInteger(record.attempts) && Number(record.attempts) >= 0
    && typeof record.configRevision === "string"
    && ["pending", "delivered", "expired", "superseded"].includes(String(record.disposition))
    && record.expiresAt >= record.createdAt && record.source.subject === record.subject
    && record.source.operation === record.operation;
}

function freshness(value: unknown): value is FreshnessRecord {
  const record = object(value);
  const target = object(record?.target);
  const targetTuple = Array.isArray(target?.affectedScope) && typeof target.affectedScope[0] === "string"
    ? parseScopeToken(target.affectedScope[0]) : null;
  return record != null && target != null && operation(target.operation)
    && (WEATHER_FAMILIES as readonly string[]).includes(String(target.family))
    && typeof target.subject === "string" && Array.isArray(target.affectedScope)
    && target.affectedScope.every((item) => typeof item === "string") && validScopeSet(target.affectedScope)
    && reportRef(record.candidateSource, record.revisionOrder === "unknown") && (record.currentSource === null || reportRef(record.currentSource))
    && (record.currentSemanticRevision === null || typeof record.currentSemanticRevision === "string")
    && typeof record.decision === "string" && typeof record.reason === "string"
    && ["newer", "same", "older", "unknown"].includes(String(record.revisionOrder))
    && typeof record.freshnessSuspect === "boolean" && (record.suspectedSource === null || reportRef(record.suspectedSource))
    && Array.isArray(record.confirmedScope) && record.confirmedScope.every((item) => typeof item === "string")
    && (record.confirmedScope.length === 0 || validScopeSet(record.confirmedScope))
    && record.clearCondition === "sameTargetScopeAcceptedOrCoverageConfirmed"
    && record.candidateSource.operation === target.operation && record.candidateSource.family === target.family
    && record.candidateSource.subject === target.subject
    && targetTuple?.[0] === target.family
    && (record.currentSource === null || record.currentSource.operation === target.operation
      && record.currentSource.family === target.family && record.currentSource.subject === target.subject)
    && (record.suspectedSource === null || record.suspectedSource.operation === target.operation
      && record.suspectedSource.family === target.family && record.suspectedSource.subject === target.subject)
    && (record.confirmedScope.length === 0 || parseScopeToken(record.confirmedScope[0])?.[0] === target.family
      && parseScopeToken(record.confirmedScope[0])?.[2] === targetTuple[2]);
}

function unavailable(value: unknown): value is WeatherCurrentUnitState["unavailable"][number] {
  const record = object(value);
  if (record == null || typeof record.subject !== "string" || !operation(record.operation)
    || !["capacityExceeded", "historyUnavailable", "coverageIncomplete"].includes(String(record.reason))
    || record.reason !== "coverageIncomplete" && record.source === null
    || !(record.source === null || reportRef(record.source)) || !(record.lastKnown === null || snapshot(record.lastKnown))
    || !Array.isArray(record.affectedScope) || !record.affectedScope.every((item) => typeof item === "string")
    || !validScopeSet(record.affectedScope)) return false;
  const tuple = parseScopeToken(record.affectedScope[0]);
  if (tuple == null) return false;
  return (record.source == null || record.source.subject === record.subject && record.source.operation === record.operation
      && record.source.family === tuple[0])
    && (record.lastKnown == null || record.lastKnown.subject === record.subject
      && record.lastKnown.operation === record.operation && record.lastKnown.source.family === tuple[0]
      && record.lastKnown.scope === tuple[1] && record.lastKnown.office === tuple[2]);
}

function persistedValue(value: unknown): PersistedWeatherCurrentUnit | null {
  const record = object(value);
  const national = object(record?.national);
  const ownership = object(record?.ownership);
  if (record == null || record.schemaVersion !== SCHEMA || national == null
    || Object.keys(national).some((key) => !operation(key))
    || Object.entries(national).some(([key, item]) => !snapshot(item) || item.scope !== "national" || item.operation !== key)
    || ownership == null || Object.values(ownership).some((item) => typeof item !== "string")
    || !Array.isArray(record.partials) || !record.partials.every(snapshot)
    || record.partials.some((item) => item.scope !== "partial") || record.partials.length > 128
    || !Array.isArray(record.histories) || !record.histories.every(history)
    || !Array.isArray(record.tombstones) || !record.tombstones.every(tombstone)
    || !Array.isArray(record.freshness) || !record.freshness.every(freshness)
    || !Array.isArray(record.unavailable) || !record.unavailable.every(unavailable)
    || !Array.isArray(record.intents) || !record.intents.every(intent)) return null;

  const result: PersistedWeatherCurrentUnit = {
    schemaVersion: SCHEMA,
    national: national as PersistedWeatherCurrentUnit["national"],
    partials: record.partials,
    histories: record.histories,
    ownership: ownership as Readonly<Record<string, string>>,
    tombstones: record.tombstones.map((item) => ({ ...item, affectedScope: normalizeScopes(item.affectedScope) })),
    freshness: record.freshness.map((item) => ({ ...item,
      target: { ...item.target, affectedScope: normalizeScopes(item.target.affectedScope) },
      confirmedScope: normalizeScopes(item.confirmedScope) })),
    unavailable: record.unavailable.map((item) => ({ ...item, affectedScope: normalizeScopes(item.affectedScope) })),
    intents: record.intents,
  };
  const nationalHistory = result.histories.flatMap((item) => item.reports).filter((item) => item.scope === "national");
  if (nationalHistory.length > 2 || new Set(result.partials.map((item) => item.subject)).size !== result.partials.length
    || new Set(result.histories.map((item) => `${item.operation}\u0000${item.subject}`)).size !== result.histories.length
    || result.histories.some((item) => new Set(item.reports.map((report) => report.source.inputId)).size !== item.reports.length)
    || result.histories.some((item) => item.reports.some((report) => report.scope === "partial")
      && result.histories.flatMap((other) => other.reports).filter((report) => report.scope === "partial"
        && report.office === item.reports[0].office && report.source.family === item.reports[0].source.family).length > 8)
    || new Set(result.intents.map((item) => item.id)).size !== result.intents.length) return null;
  const pending = result.intents.filter((item) => item.disposition === "pending");
  if (pending.length > 128 || encoder.encode(JSON.stringify(pending)).byteLength > 131_072) return null;
  // Payload-only boundary: UnitCodec has no capture clock/generation on decode.
  // Receive admission below adds subject bytes and reserves the envelope numeric fields.
  return encoder.encode(JSON.stringify(result)).byteLength <= GENERATION_BYTES ? result : null;
}

function persistedFromState(state: WeatherCurrentUnitState): PersistedWeatherCurrentUnit {
  return { schemaVersion: SCHEMA, national: state.national, partials: state.partials,
    histories: state.histories, ownership: state.ownership, tombstones: state.tombstones,
    freshness: state.freshness, unavailable: state.unavailable, intents: state.intents };
}

function cleanPersistence(): PersistenceStatus {
  return { kind: "saved", currentGeneration: 0, savedGeneration: 0,
    savedCapturedAt: null, savedAckAt: null, dirtySince: null };
}

function subject(intentValue: NotificationIntent, transition: string): SubjectOutcome {
  return { subject: intentValue.subject, operation: intentValue.operation,
    informationType: intentValue.source.infoTypeRaw, transition, severity: null,
    source: intentValue.source, facts: { intentId: intentValue.id, channel: intentValue.channel },
    changedFields: ["intents"] };
}

function noChange(state: WeatherCurrentUnitState): InternalStep {
  return { state, nextDeadline: nextWeatherCurrentDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

function compareSnapshot(left: WeatherCurrentSnapshot, right: WeatherCurrentSnapshot): number {
  const time = Date.parse(left.source.reportDateTimeRaw) - Date.parse(right.source.reportDateTimeRaw);
  if (time !== 0) return time;
  const a = [left.operation, left.subject, left.source.inputId];
  const b = [right.operation, right.subject, right.source.inputId];
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function removeSubject(state: WeatherCurrentUnitState, subjectValue: string, operationValue: Operation): WeatherCurrentUnitState {
  const national = { ...state.national };
  if (national[operationValue]?.subject === subjectValue) delete national[operationValue];
  return { ...state, national,
    partials: state.partials.filter((item) => item.subject !== subjectValue || item.operation !== operationValue),
    histories: state.histories.filter((item) => item.subject !== subjectValue || item.operation !== operationValue),
    ownership: Object.fromEntries(Object.entries(state.ownership)
      .filter(([key, value]) => value !== subjectValue || !key.startsWith(`${operationValue}\u0000`))),
    intents: state.intents.filter((item) => item.subject !== subjectValue || item.operation !== operationValue) };
}

function fitNormalByByte(state: WeatherCurrentUnitState, capturedAt: number, touched: CurrentChange): Readonly<{ state: WeatherCurrentUnitState; count: number }> {
  let next = state;
  let count = 0;
  while (reservedGenerationBytes(next, capturedAt) > GENERATION_BYTES) {
    const historyCandidates = next.histories.flatMap((entry) => entry.reports.map((report) => ({ entry, report })))
      .filter(({ report }) => report.operation !== "normal").sort((a, b) => compareSnapshot(a.report, b.report));
    if (historyCandidates.length !== 0) {
      const evicted = historyCandidates[0];
      next = { ...next, histories: next.histories.flatMap((entry) => {
        if (entry !== evicted.entry) return [entry];
        const reports = entry.reports.filter((report) => report !== evicted.report);
        return reports.length === 0 ? [] : [{ ...entry, reports }];
      }) };
      count++;
      continue;
    }
    const partial = next.partials.filter((item) => item.operation !== "normal").sort(compareSnapshot)[0];
    if (partial != null) { touched(partial, null, partial.operation, partial.subject); next = removeSubject(next, partial.subject, partial.operation); count++; continue; }
    const national = Object.values(next.national).filter((item): item is WeatherCurrentSnapshot => item != null && item.operation !== "normal")
      .sort(compareSnapshot)[0];
    if (national != null) { touched(national, null, national.operation, national.subject); next = removeSubject(next, national.subject, national.operation); count++; continue; }
    break;
  }
  return { state: next, count };
}

function reduceWeatherCurrentCore(state: WeatherCurrentUnitState,
  input: Extract<WeatherCurrentInput, { kind: "receive" }>, touched: CurrentChange): InternalStep {
  const changes: Parameters<CurrentChange>[] = [];
  const collect: CurrentChange = (...change) => { changes.push(change); };
  const adopt = (step: InternalStep): InternalStep => {
    if (step.state !== state) for (const change of changes) touched(...change);
    return step;
  };
  const step = reduceWeatherCurrentMeaning(state, input, collect);
  const fits = (value: WeatherCurrentUnitState) => reservedGenerationBytes(value, input.clock.wallTimeMs) <= GENERATION_BYTES;
  if (step.state === state || fits(step.state)) return adopt(step);
  if (!step.decisions.some((item) => item.decision === "changed")) return {
    ...step, state, nextDeadline: nextWeatherCurrentDeadline(state),
    diagnostics: [...step.diagnostics, { level: "WARN", component: "weather-current",
      reason: "checkpointEncodeFailed", unit: "U-W", inputId: input.material.inputId }],
  };
  const validated = validateWeatherCandidate(input.material, state);
  if (validated.kind === "rejected" || validated.candidate.ignored) return step;
  const adopted = [...Object.values(step.state.national), ...step.state.partials].some((item) =>
    item?.subject === validated.candidate.subject && item.operation === validated.candidate.operation
    && item.source.inputId === input.material.inputId);
  if (adopted && validated.candidate.operation === "normal") {
    const fitted = fitNormalByByte(step.state, input.clock.wallTimeMs, collect);
    if (fits(fitted.state)) return adopt(fitted.count === 0 ? step : {
      ...step, state: fitted.state,
      diagnostics: [...step.diagnostics, { level: "INFO", component: "weather-current",
        reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: fitted.count }],
    });
  }
  const unavailable = step.state.unavailable.some((item) => item.subject === validated.candidate.subject
    && item.source?.inputId === input.material.inputId) ? step
    : capacityUnavailable(state, validated.candidate, "capacityExceeded",
    validated.candidate.scope === "national" ? state.national[validated.candidate.operation]?.subject === validated.candidate.subject
      ? state.national[validated.candidate.operation]! : null
      : state.partials.find((item) => item.subject === validated.candidate.subject) ?? null,
    input.clock.monotonicMs);
  if (fits(unavailable.state)) return unavailable;
  // AC11 degradation: drop the unsavable lastKnown first, then refuse without touching state.
  const dropped = { ...unavailable.state, unavailable: unavailable.state.unavailable.map((item) =>
    item.subject === validated.candidate.subject && item.operation === validated.candidate.operation
      ? { ...item, lastKnown: null } : item) };
  if (fits(dropped)) return { ...unavailable, state: dropped };
  return { ...noChange(state),
    decisions: [{ subject: validated.candidate.subject, operation: validated.candidate.operation,
      decision: "capacityExceeded", rejection: { family: validated.candidate.family,
        reportDateTimeMs: validated.candidate.reportDateTimeMs!, affectedScope: validated.candidate.affectedScope } }],
    diagnostics: [{ level: "WARN", component: "weather-current",
      reason: "checkpointEncodeFailed", unit: "U-W", inputId: input.material.inputId }] };
}

function restore(state: WeatherCurrentUnitState, value: PersistedWeatherCurrentUnit,
  clock: ClockReading): InternalStep {
  const decoded = weatherCurrentUnitCodec.decode(value);
  if (decoded.kind === "invalid") return {
    state, nextDeadline: nextWeatherCurrentDeadline(state),
    decisions: [{ subject: "", operation: "normal", decision: "rejected", reason: "requiredStructureInvalid" }],
    intents: [], outcomes: [], diagnostics: [{ level: "WARN", component: "weather-current",
      reason: "requiredStructureInvalid", unit: "U-W" }],
  };
  const previous = (item: WeatherCurrentSnapshot) => ({ ...item, [restoredAt]: state.persistence.savedCapturedAt });
  const base = { ...decoded.state, persistence: state.persistence,
    national: Object.fromEntries(Object.entries(decoded.state.national).map(([operation, item]) => [operation, previous(item)])),
    partials: decoded.state.partials.map(previous),
    histories: decoded.state.histories.map((history) => ({ ...history, reports: history.reports.map(previous) })),
  };
  const applied = expireIntents(base, clock.wallTimeMs, clock.monotonicMs);
  const active = applied.state.intents.filter((item) => item.disposition === "pending" && item.expiresAt > clock.wallTimeMs);
  return { state: applied.state, nextDeadline: nextWeatherCurrentDeadline(applied.state), decisions: [], intents: active,
    outcomes: [{ kind: "recoveryApplied", scope: ["U-W"],
      coverage: [...Object.values(applied.state.national), ...applied.state.partials]
        .filter((item): item is WeatherCurrentSnapshot => item != null).map((item) => item.subject),
      subjects: [] }], diagnostics: [] };
}

function coverageConfirmed(state: WeatherCurrentUnitState,
  input: Extract<WeatherCurrentInput, { kind: "coverageConfirmed" }>): InternalStep {
  if (!(WEATHER_FAMILIES as readonly string[]).includes(input.family) || !validScopeSet(input.affectedScope)
    || parseScopeToken(input.affectedScope[0])?.[0] !== input.family) return noChange(state);
  const freshness = state.freshness.filter((record) => !(record.target.operation === input.operation
    && record.target.family === input.family && record.target.subject === input.subject
    && scopeContains(input.affectedScope, record.target.affectedScope)));
  const unavailable = state.unavailable.filter((record) => !(record.operation === input.operation
    && record.subject === input.subject && scopeContains(input.affectedScope, record.affectedScope)));
  if (freshness.length === state.freshness.length && unavailable.length === state.unavailable.length) return noChange(state);
  const next = { ...state, freshness, unavailable, persistence: dirty(state.persistence, input.clock.monotonicMs) };
  return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
    decisions: [{ subject: input.subject, operation: input.operation,
      decision: "changed", reason: null, change: "revisionOnly", currentEstablished: null }], intents: [],
    outcomes: [{ kind: "recoveryApplied", scope: input.affectedScope,
      coverage: input.affectedScope, subjects: [] }], diagnostics: [] };
}

function intentUpdate(state: WeatherCurrentUnitState,
  input: Extract<WeatherCurrentInput, { kind: "intentUpdate" }>): InternalStep {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changed = new Map<string, NotificationIntent>();
  let persistence = state.persistence;
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts) continue;
    if (current.attempts === update.attempts && current.nextAttemptAt === update.nextAttemptAt
      && current.disposition === update.disposition) continue;
    changed.set(current.id, { ...current, ...update });
    persistence = dirty(persistence, input.clock.monotonicMs);
  }
  if (changed.size === 0) return noChange(state);
  const adopted = [...changed.values()];
  const next = { ...state, intents: state.intents.map((item) => changed.get(item.id) ?? item), persistence };
  return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation,
      decision: "changed", reason: null, change: "deliveryOnly", currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted", change: "deliveryOnly", subjects: [subject(item, item.disposition)] })), diagnostics: [] };
}

function reduceCore(state: WeatherCurrentUnitState, input: WeatherCurrentInput, touched: CurrentChange): InternalStep {
  if (input.kind === "receive") return reduceWeatherCurrentCore(state, input, touched);
  if (input.kind === "restore") return restore(state, input.persisted, input.clock);
  if (input.kind === "coverageConfirmed") return coverageConfirmed(state, input);
  if (input.kind === "intentUpdate") return intentUpdate(state, input);
  const applied = expireIntents(state, input.clock.wallTimeMs, input.clock.monotonicMs);
  if (input.kind === "deadline" && applied.expired.length === 0) return noChange(state);
  const subjects = applied.expired.map((item) => subject(item, item.disposition === "pending" ? "expired" : item.disposition));
  return { state: applied.state, nextDeadline: nextWeatherCurrentDeadline(applied.state),
    decisions: applied.expired.map((item) => ({ subject: item.subject, operation: item.operation,
      decision: "changed" as const, reason: null, change: "deliveryOnly" as const, currentEstablished: null })), intents: [],
    outcomes: input.kind === "deadline" ? [{ kind: "deadlineApplied", subjects }]
      : [{ kind: "batchCompleted", reason: "shutdown", subjects }], diagnostics: [] };
}

function currentSubject(item: WeatherCurrentSnapshot & { readonly [restoredAt]?: number | null }): SubjectOutcome {
  return {
    subject: item.subject, operation: item.operation, informationType: item.source.infoTypeRaw,
    transition: restoredAt in item ? "restoredUnconfirmed" : "active", severity: null, source: item.source,
    facts: { family: item.source.family, scope: item.scope, office: item.office, phenomena: item.phenomena,
      ...(restoredAt in item ? { currentConfirmed: false, savedCapturedAt: item[restoredAt] ?? null } : {}) },
    changedFields: [],
  };
}
function unavailableSubject(item: WeatherCurrentUnitState["unavailable"][number]): SubjectOutcome {
  return {
    subject: item.subject, operation: item.operation, informationType: item.source?.infoTypeRaw ?? "",
    transition: "unavailable", severity: null, source: item.source,
    facts: { reason: item.reason, affectedScope: item.affectedScope }, changedFields: [],
  };
}
function toWeatherCurrentView(state: WeatherCurrentUnitState): WeatherCurrentUnitView {
  const currents = [...Object.values(state.national), ...state.partials]
    .filter((item): item is WeatherCurrentSnapshot => item != null);
  const subjects: SubjectOutcome[] = [...currents.map(currentSubject), ...state.unavailable.map(unavailableSubject)];
  return { unit: "U-W", semanticRevision: [
    ...currents.map((item) => `${item.subject}:${item.source.reportDateTimeRaw}:${item.source.serialRaw}`),
    ...state.tombstones.map((item) => `${item.subject}:t:${item.source.reportDateTimeRaw}`),
    ...state.unavailable.map((item) => `${item.subject}:u:${item.reason}:${item.source?.reportDateTimeRaw ?? ""}`),
  ].sort().join("|"), contentRevision: String(state.contentRevision), admission: {}, subjects,
  national: Object.fromEntries(Object.entries(state.national).filter(([, item]) => item != null && !(restoredAt in item))),
  partials: state.partials.filter((item) => !(restoredAt in item)),
  freshnessSuspectCount: state.freshness.filter((item) => item.freshnessSuspect).length };
}

const weatherCurrentUnitCodec: WeatherCurrentUnitCodec = {
  schemaVersion: SCHEMA,
  encode(state) {
    const value = persistedValue(persistedFromState(state));
    if (value == null) throw new Error("U-W checkpoint exceeds or violates its persisted boundary");
    return value;
  },
  decode(payload) {
    const value = persistedValue(payload);
    return value == null ? { kind: "invalid", reason: "invalid p2-weather-current-unit-v1 payload" } : {
      kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence() },
    };
  },
};

function displaySubjects(state: WeatherCurrentUnitState, targets?: ReadonlySet<string>, currents?: readonly WeatherCurrentSnapshot[]): Map<string, RuntimeDisplaySubject & { unit: "U-W" }> {
  type Row = { current: WeatherCurrentSnapshot | null; unavailable: WeatherCurrentUnitState["unavailable"][number][];
    freshness: FreshnessRecord[]; operation: Operation; subject: string; office: string | null };
  const rows = new Map<string, Row>();
  const row = (operation: Operation, subject: string): Row => {
    const key = JSON.stringify([operation, subject]);
    let found = rows.get(key);
    if (found == null) { found = { current: null, unavailable: [], freshness: [], operation, subject, office: null }; rows.set(key, found); }
    return found;
  };
  for (const item of currents ?? [...Object.values(state.national), ...state.partials]) if (item != null
    && (targets == null || targets.has(JSON.stringify([item.operation, item.subject])))) {
    const target = row(item.operation, item.subject); target.current = item; target.office = item.office;
  }
  for (const item of state.unavailable) {
    if (targets != null && !targets.has(JSON.stringify([item.operation, item.subject]))) continue;
    const target = row(item.operation, item.subject);
    target.unavailable.push(item);
    target.office ??= item.lastKnown?.office ?? parseScopeToken(item.affectedScope[0])?.[2] ?? null;
  }
  for (const item of state.freshness) {
    if (targets != null && !targets.has(JSON.stringify([item.target.operation, item.target.subject]))) continue;
    const target = row(item.target.operation, item.target.subject);
    target.freshness.push(item);
    target.office ??= parseScopeToken(item.target.affectedScope[0])?.[2] ?? null;
  }
  return new Map([...rows].map(([key, item]) => [key, { unit: "U-W" as const,
    operation: item.operation, subject: item.subject, office: item.office,
    current: item.current, unavailable: item.unavailable, freshness: item.freshness,
    subjects: [...(item.current == null ? [] : [currentSubject(item.current)]), ...item.unavailable.map(unavailableSubject)] }]));
}

function reduceWeatherCurrentUnit(state: WeatherCurrentUnitState, input: WeatherCurrentInput): WeatherCurrentUnitStep {
  const currents = new Map<string, { before: WeatherCurrentSnapshot | null; after: WeatherCurrentSnapshot | null }>();
  const step = reduceCore(state, input, (before, after, operation, subject) => {
    const key = JSON.stringify([operation, subject]);
    currents.set(key, { before: currents.has(key) ? currents.get(key)!.before : before, after });
  });
  const displayChanges: WeatherCurrentUnitStep["displayChanges"][number][] = [];
  const currentChanged = step.state.national !== state.national || step.state.partials !== state.partials;
  const monitorChanged = step.state.unavailable !== state.unavailable || step.state.freshness !== state.freshness;
  if (currentChanged || monitorChanged) {
    // A8-COST: every current change reaches `touched` except the unavailable replacement
    // (domain addUnavailable, unit capacityUnavailable/dropped), which always replaces the monitor
    // records. Look up only those subjects; when national/partials keep their reference, after = before.
    if (monitorChanged) for (const decision of step.decisions) {
      const key = JSON.stringify([decision.operation, decision.subject]);
      if (currents.has(key)) continue;
      const find = (value: WeatherCurrentUnitState) => value.national[decision.operation]?.subject === decision.subject
        ? value.national[decision.operation]!
        : value.partials.find((item) => item.operation === decision.operation && item.subject === decision.subject) ?? null;
      const before = find(state);
      currents.set(key, { before, after: currentChanged ? find(step.state) : before });
    }
    const targets = new Set(currents.keys());
    const before = input.kind === "restore" ? new Map<string, RuntimeDisplaySubject & { unit: "U-W" }>()
      : displaySubjects(state, targets, [...currents.values()].flatMap((item) => item.before == null ? [] : [item.before]));
    const after = input.kind === "restore" ? displaySubjects(step.state)
      : displaySubjects(step.state, targets, [...currents.values()].flatMap((item) => item.after == null ? [] : [item.after]));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(key) ?? null, current = after.get(key) ?? null;
      const same = old != null && current != null && old.current === current.current
        && old.unavailable.length === current.unavailable.length
        && old.unavailable.every((item, index) => item === current.unavailable[index])
        && old.freshness.length === current.freshness.length
        && old.freshness.every((item, index) => item === current.freshness[index]);
      if (!same && (old != null || current != null)) displayChanges.push({ unit: "U-W",
        operation: (current ?? old)!.operation, subject: (current ?? old)!.subject, before: old, after: current });
    }
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1))
    throw new RangeError("U-W content revision exhausted");
  const confirmationEvidence: WeatherCurrentUnitStep["confirmationEvidence"] = input.kind === "receive"
    ? step.decisions.flatMap((item) => item.decision === "changed" && item.currentEstablished != null
      ? [{ source: "acceptedReport" as const, scopes: item.currentEstablished.affectedScope.map((token) => ({
        unit: "U-W" as const, operation: item.operation, kind: "area" as const, subject: item.subject, token,
      })) }] : []) : [];
  return { ...step, state: displayChanges.length !== 0
    ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence };
}

function reduceWeatherCurrent(state: WeatherCurrentUnitState,
  input: Extract<WeatherCurrentInput, { kind: "receive" }>): WeatherCurrentUnitStep {
  return reduceWeatherCurrentUnit(state, input);
}

export { displaySubjects, reduceWeatherCurrent, reduceWeatherCurrentUnit, toWeatherCurrentView, weatherCurrentUnitCodec };
