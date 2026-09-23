import { isDeepStrictEqual } from "node:util";

import type { JsonValue, NotificationIntent, PersistenceStatus, PublishedOutcome, ReportRef, RuntimeUnitDeadline, SubjectOutcome } from "../../../contracts/p2-shared-runtime.types";
import type { PersistedWeatherTimeseriesUnit, WeatherTimeseriesInput, WeatherTimeseriesSnapshot,
  WeatherTimeseriesSubject, WeatherTimeseriesUnitCodec, WeatherTimeseriesUnitState, WeatherTimeseriesUnitStep,
  WeatherTimeseriesUnitView } from "../../../contracts/p2-weather-timeseries-unit.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { EMPTY, inspect } from "../../domains/weather-timeseries/weather-timeseries";

const SCHEMA = "p2-weather-timeseries-unit-v1" as const;
const LIMIT = 33_554_432, SUBJECT_LIMIT = 512, RETAIN = 7 * 86_400_000;
const encoder = new TextEncoder();
const cache = new WeakMap<object, number>();
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-F", generation: 0,
  capturedAt: 0, payload: { schemaVersion: SCHEMA, subjects: [], gates: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;

function bytes(value: object): number {
  let size = cache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; cache.set(value, size); }
  return size;
}
function arrayBytes(values: readonly object[]): number {
  return values.reduce((sum, item) => sum + bytes(item), Math.max(values.length - 1, 0));
}
function measure(subjects: readonly WeatherTimeseriesSubject[], gates: readonly { source: ReportRef }[],
  intents: readonly NotificationIntent[], generation: number, capturedAt: number): number {
  if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isFinite(capturedAt)
    || JSON.stringify(generation).length > 32 || JSON.stringify(capturedAt).length > 32)
    throw new RangeError("invalid U-F checkpoint generation or capture time");
  return emptyEnvelopeBytes + 62 + arrayBytes(subjects) + arrayBytes(gates) + arrayBytes(intents);
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function deadline(state: WeatherTimeseriesUnitState): RuntimeUnitDeadline | null {
  const times = state.subjects.flatMap((item) => [item.validUntil, item.retainUntil]).filter((value): value is number => value != null);
  const intentTimes = state.intents.filter((item) => item.disposition === "pending").map((item) => item.expiresAt);
  return times.length + intentTimes.length === 0 ? null : { wallTimeMs: Math.min(...times, ...intentTimes), monotonicMs: null };
}
function step(state: WeatherTimeseriesUnitState): WeatherTimeseriesUnitStep {
  return { state, nextDeadline: deadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}
function outcome(item: WeatherTimeseriesSubject, changedFields: readonly string[]): SubjectOutcome {
  const known = item.periods.flatMap((row) => {
    const value = item.values[row[10]];
    return value.kind === "significancy" && value.name.kind !== "empty" && value.name.kind !== "missing" && value.code.kind === "text"
      && /^(?:00|01|11|20|21|22|30|31|41|50|51)$/.test(value.code.raw) ? [value.code.raw] : [];
  });
  return { subject: item.subject, operation: item.operation, informationType: item.source?.infoTypeRaw ?? "",
    transition: item.effective, severity: null, source: item.source,
    facts: { effective: item.effective, periodCount: item.periods.length,
      knownMaxCode: known.length === 0 ? null : known.sort().at(-1)! }, changedFields };
}
function collect(state: WeatherTimeseriesUnitState, wallTimeMs: number, monotonicMs: number): {
  state: WeatherTimeseriesUnitState; outcomes: WeatherTimeseriesUnitStep["outcomes"];
  decisions: WeatherTimeseriesUnitStep["decisions"] } {
  const expired: WeatherTimeseriesSubject[] = [];
  const retained: WeatherTimeseriesSubject[] = [];
  let removed = false;
  for (const item of state.subjects) {
    if (item.retainUntil <= wallTimeMs) { removed = true; continue; }
    if (item.validUntil != null && item.validUntil <= wallTimeMs) {
      const next = { ...item, ...EMPTY, effective: "noActiveItems" as const, validUntil: null };
      expired.push(next); retained.push(next);
    } else retained.push(item);
  }
  const expiredIntents = state.intents.filter((item) => item.expiresAt <= wallTimeMs);
  if (!removed && expired.length === 0 && expiredIntents.length === 0)
    return { state, decisions: [], outcomes: [] };
  const subjects = retained;
  const keys = new Set(subjects.map((item) => item.subject));
  const next = { ...state, subjects,
    gates: state.gates.filter((item) => keys.has(item.subject)),
    intents: state.intents.filter((item) => item.expiresAt > wallTimeMs),
    persistence: dirty(state.persistence, monotonicMs) };
  return { state: next,
    decisions: expired.map((item) => ({ subject: item.subject, operation: item.operation,
      decision: "changed" as const, reason: null, change: "semantic" as const, currentEstablished: null })),
    outcomes: expired.length === 0 ? [] : [{ kind: "deadlineApplied", subjects: expired.map((item) =>
      outcome(item, ["effective", "periods", "validUntil"])) }] };
}
// AC04/Q-PERIOD: table indexes are local to each snapshot and have no semantic identity.
function periodMeaning(snapshot: WeatherTimeseriesSnapshot, row: WeatherTimeseriesSnapshot["periods"][number]) {
  const text = (index: number | null) => index == null ? null : snapshot.strings[index];
  const series = snapshot.series[row[0]], time = series.timeDefines[row[8]], area = snapshot.areas[row[1]],
    kind = snapshot.kinds[row[2]], local = row[5] == null ? null : snapshot.locals[row[5]];
  return [series.meteorologicalInfosPosition, series.timeSeriesInfoPosition,
    [text(time.timeId), text(time.dateTimeRaw), text(time.durationRaw), text(time.name), time.startMs, time.endMs],
    [text(area.code), text(area.name)], [text(kind.status), text(kind.dateTimeRaw), text(kind.dateTimeType)],
    text(row[3]), text(row[4]), local == null ? null : [text(local.code), text(local.areaNameCode),
      text(local.areaName), text(local.name), local.anonymousPosition], text(row[6]), text(row[7]),
    snapshot.attributes[row[9]].map(([name, value]) => [text(name), text(value)]), snapshot.values[row[10]]];
}
function sameSource(left: ReportRef, right: ReportRef): boolean {
  return left.operation === right.operation && left.family === right.family && left.subject === right.subject
    && left.reportDateTimeRaw === right.reportDateTimeRaw && left.serialRaw === right.serialRaw
    && left.infoTypeRaw === right.infoTypeRaw;
}
function replace(state: WeatherTimeseriesUnitState, item: WeatherTimeseriesSubject): WeatherTimeseriesUnitState {
  return { ...state,
    subjects: [...state.subjects.filter((old) => old.subject !== item.subject), item],
    gates: [...state.gates.filter((old) => old.subject !== item.subject),
      { subject: item.subject, operation: item.operation, source: item.source! }] };
}
function fits(state: WeatherTimeseriesUnitState, generation: number, capturedAt: number): boolean {
  return state.subjects.length <= SUBJECT_LIMIT
    && measure(state.subjects, state.gates, state.intents, generation, capturedAt) <= LIMIT;
}
function evict(state: WeatherTimeseriesUnitState, target: string, generation: number, capturedAt: number): WeatherTimeseriesUnitState {
  let next = state;
  const candidates = () => [...next.subjects].filter((item) => item.subject !== target && item.operation !== "normal")
    .sort((a, b) => Date.parse(a.source?.reportDateTimeRaw ?? "") - Date.parse(b.source?.reportDateTimeRaw ?? "")
      || a.subject.localeCompare(b.subject));
  for (const candidate of candidates()) {
    if (candidate.lastKnown == null) continue;
    next = { ...next, subjects: next.subjects.map((item) => item === candidate ? { ...item, lastKnown: null } : item) };
    if (fits(next, generation, capturedAt)) break;
  }
  return next;
}
function reduceWeatherTimeseries(state: WeatherTimeseriesUnitState,
  input: Extract<WeatherTimeseriesInput, { kind: "receive" }>): WeatherTimeseriesUnitStep {
  const checked = inspect(input.material);
  if (checked.kind === "rejected") return { ...step(state),
    decisions: [{ subject: checked.subject, operation: input.material.operation, decision: "rejected", reason: checked.reason }],
    diagnostics: [checked.diagnostic] };
  const candidate = checked.candidate, { source } = candidate;
  const collected = collect(state, input.clock.wallTimeMs, input.clock.monotonicMs);
  const base = collected.state;
  const previous = base.subjects.find((item) => item.subject === source.subject);
  const gate = base.gates.find((item) => item.subject === source.subject);
  if (gate != null) {
    const order = candidate.reportDateTimeMs - Date.parse(gate.source.reportDateTimeRaw);
    const reason = order < 0 ? "stale" : order === 0 && sameSource(source, gate.source) ? "duplicate"
      : order === 0 && !(candidate.cancelled && gate.source.infoTypeRaw !== "取消") ? "stale" : null;
    if (reason != null) return { ...step(base), decisions: [{ subject: source.subject, operation: source.operation,
      decision: "unchanged", reason }], outcomes: collected.outcomes };
  }
  const snapshot = candidate.cancelled || candidate.validUntil == null || candidate.validUntil <= input.clock.wallTimeMs
    ? EMPTY : candidate.snapshot;
  const normal: WeatherTimeseriesSubject = { ...snapshot, subject: source.subject, operation: source.operation, source,
    effective: candidate.cancelled ? "cancelled" : snapshot.periods.length === 0 ? "noActiveItems" : "active",
    unavailableReason: null, lastKnown: null, affectedScope: "subject",
    validUntil: snapshot.periods.length === 0 ? null : candidate.validUntil,
    retainUntil: candidate.reportDateTimeMs + RETAIN };
  const evidence = { family: "VPWP50", reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" as const };
  const change = previous != null && previous.effective === normal.effective && previous.validUntil === normal.validUntil
    && previous.periods.length === normal.periods.length && previous.periods.every((row, index) =>
      isDeepStrictEqual(periodMeaning(previous, row), periodMeaning(normal, normal.periods[index])))
    ? "revisionOnly" as const : "semantic" as const;
  const changedFields = change === "revisionOnly" ? ["source", "retainUntil"] : ["source", "effective", "periods", "validUntil", "retainUntil"];
  let proposed = replace(base, normal);
  const generation = state.persistence.currentGeneration + 1;
  if (!fits(proposed, generation, input.clock.wallTimeMs)) {
    proposed = evict(proposed, source.subject, generation, input.clock.wallTimeMs);
    if (!fits(proposed, generation, input.clock.wallTimeMs)) {
      for (const item of [...proposed.subjects].filter((entry) => entry.subject !== source.subject && entry.operation !== "normal")
        .sort((a, b) => Date.parse(a.source?.reportDateTimeRaw ?? "") - Date.parse(b.source?.reportDateTimeRaw ?? "")
          || a.subject.localeCompare(b.subject))) {
        proposed = { ...proposed, subjects: proposed.subjects.filter((entry) => entry !== item),
          gates: proposed.gates.filter((entry) => entry.subject !== item.subject) };
        if (fits(proposed, generation, input.clock.wallTimeMs)) break;
      }
    }
  }
  let adopted = normal, established: typeof evidence | null = evidence;
  if (!fits(proposed, generation, input.clock.wallTimeMs)) {
    const lastKnown: WeatherTimeseriesSnapshot | null = previous == null ? null
      : previous.effective === "unavailable" ? previous.lastKnown
        : { strings: previous.strings, attributes: previous.attributes, values: previous.values,
          series: previous.series, areas: previous.areas, locals: previous.locals, kinds: previous.kinds,
          periods: previous.periods };
    adopted = { ...normal, ...EMPTY, effective: "unavailable", unavailableReason: "capacityExceeded",
      validUntil: null, lastKnown };
    proposed = replace(proposed, adopted);
    established = null;
    if (!fits(proposed, generation, input.clock.wallTimeMs)) {
      adopted = { ...adopted, lastKnown: null };
      proposed = replace(proposed, adopted);
    }
  }
  if (!fits(proposed, generation, input.clock.wallTimeMs)) return { ...step(state),
    decisions: [{ subject: source.subject, operation: source.operation, decision: "capacityExceeded", rejection: evidence }] };
  proposed = { ...proposed, persistence: dirty(state.persistence, input.clock.monotonicMs) };
  const finalFields = established == null ? ["source", "effective", "periods", "validUntil", "retainUntil",
    "unavailableReason", "lastKnown", "affectedScope"] : changedFields;
  const deadlineOutcomes: PublishedOutcome[] = [];
  for (const event of collected.outcomes) {
    if (event.kind !== "deadlineApplied") { deadlineOutcomes.push(event); continue; }
    const subjects = event.subjects.filter((item) => item.subject !== source.subject);
    if (subjects.length > 0) deadlineOutcomes.push({ kind: "deadlineApplied", subjects });
  }
  return { ...step(proposed), decisions: [{ subject: source.subject, operation: source.operation,
    decision: "changed", reason: null, change: established == null ? "semantic" : change,
    currentEstablished: established }],
    outcomes: [...deadlineOutcomes, { kind: "accepted", change: established == null ? "semantic" : change,
      subjects: [outcome(adopted, finalFields)] }] };
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function index(value: unknown, length: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < length;
}
function materialValue(value: unknown): boolean {
  const row = object(value);
  if (row == null) return false;
  if (row.kind === "missing") return true;
  if (row.kind === "empty" || row.kind === "unknown") return typeof row.raw === "string";
  if (row.kind === "text") return typeof row.raw === "string" && typeof row.value === "string";
  if (row.kind === "number") return typeof row.raw === "string" && finite(row.value);
  return row.kind === "range" && typeof row.raw === "string" && finite(row.value)
    && (row.bound === "lower" || row.bound === "upper");
}
function compoundField(value: unknown): boolean {
  const row = object(value);
  return row != null && typeof row.name === "string" && Array.isArray(row.attributes)
    && row.attributes.every((entry: unknown) => { const attr = object(entry);
      return attr != null && typeof attr.name === "string" && typeof attr.value === "string"; })
    && (materialValue(row.value) || Array.isArray(row.value) && row.value.every(compoundField));
}
function storedValue(value: unknown): boolean {
  const row = object(value);
  if (row == null) return false;
  if (row.kind === "significancy") return materialValue(row.name) && materialValue(row.code);
  if (row.kind === "peakTime" || row.kind === "criteriaPeriod")
    return Array.isArray(row.fields) && row.fields.every(compoundField);
  return materialValue(value);
}
function reportRef(value: unknown): value is ReportRef {
  const row = object(value);
  return row != null && typeof row.inputId === "string"
    && (row.origin === "live" || row.origin === "recovery" || row.origin === "replay")
    && (row.operation === "normal" || row.operation === "training" || row.operation === "test")
    && row.family === "VPWP50" && typeof row.subject === "string" && row.subject !== ""
    && typeof row.reportDateTimeRaw === "string" && Number.isFinite(Date.parse(row.reportDateTimeRaw))
    && typeof row.serialRaw === "string" && typeof row.infoTypeRaw === "string";
}
function snapshot(value: unknown): value is WeatherTimeseriesSnapshot {
  const record = object(value);
  if (record == null || !Array.isArray(record.strings) || !record.strings.every((item) => typeof item === "string")
    || !Array.isArray(record.attributes) || !Array.isArray(record.values) || !Array.isArray(record.series)
    || !Array.isArray(record.areas) || !Array.isArray(record.locals) || !Array.isArray(record.kinds)
    || !Array.isArray(record.periods)) return false;
  const strings = record.strings.length, series = record.series as unknown[];
  const areas = record.areas as unknown[], kinds = record.kinds as unknown[], locals = record.locals as unknown[];
  const attributes = record.attributes as unknown[], values = record.values as unknown[];
  if (!record.attributes.every((set) => Array.isArray(set) && set.every((pair) => Array.isArray(pair)
    && pair.length === 2 && pair.every((entry) => index(entry, strings))))) return false;
  if (!record.values.every(storedValue)) return false;
  if (!series.every((entry) => { const row = object(entry); return row != null
    && Number.isSafeInteger(row.meteorologicalInfosPosition) && Number(row.meteorologicalInfosPosition) >= 0
    && Number.isSafeInteger(row.timeSeriesInfoPosition) && Number(row.timeSeriesInfoPosition) >= 0
    && Array.isArray(row.timeDefines) && row.timeDefines.every((time: unknown) => { const t = object(time);
      return t != null && index(t.timeId, strings) && index(t.dateTimeRaw, strings)
        && index(t.durationRaw, strings) && (t.name === null || index(t.name, strings))
        && finite(t.startMs) && finite(t.endMs) && t.endMs > t.startMs; }); })) return false;
  if (!record.areas.every((entry) => { const row = object(entry); return row != null && index(row.code, strings)
    && (row.name === null || index(row.name, strings)); })) return false;
  if (!record.locals.every((entry) => { const row = object(entry); return row != null
    && [row.code, row.areaNameCode, row.areaName, row.name].every((part) => part === null || index(part, strings))
    && (row.anonymousPosition === null || Number.isSafeInteger(row.anonymousPosition)
      && Number(row.anonymousPosition) >= 0); })) return false;
  if (!record.kinds.every((entry) => { const row = object(entry); return row != null
    && [row.status, row.dateTimeRaw, row.dateTimeType].every((part) => part === null || index(part, strings)); })) return false;
  return record.periods.every((entry) => Array.isArray(entry) && entry.length === 11
    && index(entry[0], series.length) && index(entry[1], areas.length)
    && index(entry[2], kinds.length) && index(entry[3], strings) && index(entry[4], strings)
    && (entry[5] === null || index(entry[5], locals.length)) && index(entry[6], strings)
    && (entry[7] === null || index(entry[7], strings))
    && index(entry[8], (series[entry[0]] as { timeDefines: unknown[] }).timeDefines.length)
    && index(entry[9], attributes.length) && index(entry[10], values.length));
}
function persisted(payload: unknown): PersistedWeatherTimeseriesUnit | null {
  const row = object(payload);
  if (row?.schemaVersion !== SCHEMA || !Array.isArray(row.subjects) || row.subjects.length > SUBJECT_LIMIT
    || !Array.isArray(row.gates) || !Array.isArray(row.intents)) return null;
  if (!row.subjects.every((value) => { const item = object(value), source = object(item?.source);
    return snapshot(value) && typeof item?.subject === "string" && item.subject !== ""
      && ["normal", "training", "test"].includes(String(item.operation))
      && ["active", "noActiveItems", "cancelled", "unavailable"].includes(String(item.effective))
      && (item.unavailableReason === null || ["capacityExceeded", "historyUnavailable", "coverageIncomplete"].includes(String(item.unavailableReason)))
      && (item.lastKnown === null || snapshot(item.lastKnown))
      && (item.affectedScope === "subject" || Array.isArray(item.affectedScope)
        && item.affectedScope.every((part: unknown) => typeof part === "string"))
      && (item.validUntil === null || finite(item.validUntil)) && finite(item.retainUntil)
      && (reportRef(item.source) && source?.subject === item.subject && source.operation === item.operation
        || item.source === null && item.effective === "unavailable" && item.unavailableReason === "coverageIncomplete")
      && item.subject.startsWith(`${item.operation}/VPWP50/`) && item.subject.length > `${item.operation}/VPWP50/`.length
      && (source === null || item.retainUntil === Date.parse(String(source.reportDateTimeRaw)) + RETAIN)
      && (item.effective !== "unavailable" || item.unavailableReason != null
        && Array.isArray(item.periods) && item.periods.length === 0); })) return null;
  if (new Set(row.subjects.map((item) => item.subject)).size !== row.subjects.length
    || !row.gates.every((entry) => { const gate = object(entry), source = object(gate?.source);
      return gate != null && typeof gate.subject === "string" && reportRef(gate.source)
        && source?.subject === gate.subject && source.operation === gate.operation; })
    || new Set(row.gates.map((item) => item.subject)).size !== row.gates.length
    || row.gates.length > row.subjects.length
    || row.subjects.some((item) => item.source !== null && !(row.gates as Record<string, unknown>[]).some((gate) =>
      gate.subject === item.subject && gate.operation === item.operation && isDeepStrictEqual(item.source, gate.source)))
    || row.gates.some((gate) => !(row.subjects as Record<string, unknown>[]).some((item) => item.subject === gate.subject
      && item.operation === gate.operation && (item.source === null || isDeepStrictEqual(item.source, gate.source))))
    || row.intents.some((entry) => object(entry)?.unit !== "U-F")) return null;
  const value = row as PersistedWeatherTimeseriesUnit;
  return measure(value.subjects, value.gates, value.intents, 0, 0) <= LIMIT ? value : null;
}
const weatherTimeseriesUnitCodec: WeatherTimeseriesUnitCodec = {
  schemaVersion: SCHEMA,
  encode(state) {
    const value = persisted({ schemaVersion: SCHEMA, subjects: state.subjects, gates: state.gates, intents: state.intents });
    if (value == null) throw new Error("invalid U-F checkpoint payload");
    return value;
  },
  decode(payload: JsonValue) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p2-weather-timeseries-unit-v1 payload" }
      : { kind: "restored", state: { ...value, persistence: { kind: "saved", currentGeneration: 0,
        savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } };
  },
};
function reduceWeatherTimeseriesUnit(state: WeatherTimeseriesUnitState, input: WeatherTimeseriesInput): WeatherTimeseriesUnitStep {
  if (input.kind === "receive") return reduceWeatherTimeseries(state, input);
  if (input.kind === "restore") {
    const decoded = weatherTimeseriesUnitCodec.decode(input.persisted);
    if (decoded.kind === "invalid") return { ...step(state), decisions: [{ subject: "", operation: "normal",
      decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "weather-timeseries",
      reason: "requiredStructureInvalid", unit: "U-F" }] };
    const base = { ...decoded.state, persistence: state.persistence };
    const applied = collect(base, input.clock.wallTimeMs, input.clock.monotonicMs);
    return { ...step(applied.state), outcomes: [{ kind: "recoveryApplied", scope: ["U-F"],
      coverage: applied.state.subjects.map((item) => item.subject), subjects: [] }] };
  }
  if (input.kind === "intentUpdate") {
    const current = state.intents.find((item) => item.id === input.intentUpdate.id);
    if (current == null || input.intentUpdate.attempts < current.attempts) return step(state);
    const updated = { ...current, ...input.intentUpdate };
    if (updated.attempts === current.attempts && updated.nextAttemptAt === current.nextAttemptAt
      && updated.disposition === current.disposition) return step(state);
    const next = { ...state, intents: state.intents.map((item) => item === current ? updated : item),
      persistence: dirty(state.persistence, input.clock.monotonicMs) };
    return { ...step(next), decisions: [{ subject: current.subject, operation: current.operation,
      decision: "changed", reason: null, change: "deliveryOnly", currentEstablished: null }],
      intents: updated.disposition === "pending" ? [updated] : [],
      outcomes: [{ kind: "accepted", change: "deliveryOnly", subjects: [{ subject: current.subject,
        operation: current.operation, informationType: current.source.infoTypeRaw, transition: updated.disposition,
        severity: null, source: current.source, facts: { intentId: current.id }, changedFields: ["intents"] }] }] };
  }
  const applied = collect(state, input.clock.wallTimeMs, input.clock.monotonicMs);
  if (input.kind === "deadline") return { ...step(applied.state), decisions: applied.decisions, outcomes: applied.outcomes };
  return { ...step(applied.state), outcomes: [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] };
}
function toWeatherTimeseriesView(state: WeatherTimeseriesUnitState): WeatherTimeseriesUnitView {
  return { unit: "U-F", semanticRevision: state.subjects.map((item) =>
    `${item.subject}:${item.source?.reportDateTimeRaw ?? ""}:${item.source?.serialRaw ?? ""}:${item.source?.infoTypeRaw ?? ""}:${item.effective}`)
    .sort().join("|"), persistence: state.persistence, admission: {}, series: state.subjects,
    subjects: state.subjects.map((item) => outcome(item, [])) };
}
export { reduceWeatherTimeseries, reduceWeatherTimeseriesUnit, toWeatherTimeseriesView, weatherTimeseriesUnitCodec };
