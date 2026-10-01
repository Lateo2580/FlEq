import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { UnitJob, UnitTable } from "../../contracts/p3-unit-table.types";
import type { NotificationDeliveryState, NotificationDeliveryStep, NotificationSelection } from "../../contracts/p2-notification-delivery.types";
import type {
  ClockReading,
  DiagnosticDetails,
  DiagnosticEvent,
  PersistenceStatus,
  RejectionReason,
  RuntimeInput,
  RuntimeState,
  RuntimeStep,
  RuntimeAdmission,
  RuntimeAdmissionCounts,
  RuntimeConfirmation,
  ConfirmationScope,
  CurrentConfirmationEvidence,
  RuntimeDisplayChange,
  RuntimeDisplaySubject,
  RuntimeUnitInputs,
  RuntimeUnitSteps,
  RuntimeViews,
  AdmissionRejection,
  RuntimeUnitStates,
  RuntimeUnitId,
  RuntimeEffect,
  ShutdownSummary,
  ShutdownStage,
  NotificationResult,
  NotificationIntent,
  SemanticEnvelopeResult,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { boundedString, boundDiagnosticDetails, completeDiagnostic, parserDiagnosticReasons } from "./runtime-diagnostic";
import { normalizeScopes, parseScopeToken, scopeContains } from "../domains/weather-current/weather-current";
import type { CodecMap } from "../checkpoint/checkpoint";
import { classifyHeadType, runtimeUnits } from "./unit-coverage";

const EMPTY: readonly never[] = Object.freeze([]);
const operations = ["normal", "training", "test"] as const;
const admissionRecordByteCache = new WeakMap<object, number>();
const stages = ["mailboxDrain", "sideEffectFinalization", "finalCheckpoint", "workerClose"] as const;
function rejection(material: DecodedMaterial, reason: RejectionReason): SemanticEnvelopeResult {
  return {
    kind: "rejected",
    reason,
    diagnostic: boundDiagnosticDetails({ level: "WARN", component: "shared-runtime", reason, inputId: material.inputId }),
  };
}

function reportDateTime(raw: string): number | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (match == null) return null;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) return null;
  const offsetMinutes = match[7] === "Z" ? 0 : (match[8] === "+" ? 1 : -1) * (Number(match[9]) * 60 + Number(match[10]));
  const local = new Date(value + offsetMinutes * 60_000);
  const actual = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  return actual.every((part, index) => part === Number(match[index + 1])) ? value : null;
}

function validateSemanticEnvelope(material: DecodedMaterial): SemanticEnvelopeResult {
  if (!material.xml.children.some((node) => node.kind === "element" && node.name === "Head")) {
    return rejection(material, "headMissing");
  }
  if (material.reportDateTimeRaw.trim() === "") return rejection(material, "reportDateTimeMissing");
  const reportDateTimeMs = reportDateTime(material.reportDateTimeRaw);
  if (reportDateTimeMs == null) return rejection(material, "reportDateTimeInvalid");
  return { kind: "accepted", envelope: { material, reportDateTimeMs } };
}

function parserDiagnostic(reason: string, inputId: string): DiagnosticDetails | null {
  const matched = parserDiagnosticReasons.find((candidate) => candidate === reason);
  if (matched == null) return null;
  return boundDiagnosticDetails({ level: "WARN", component: "parser", reason: matched, inputId });
}

function isRuntimeUnit(unit: UnitId): unit is RuntimeUnitId {
  return runtimeUnits.some((candidate) => candidate === unit);
}

type UnitInput = Extract<RuntimeUnitInputs[RuntimeUnitId], { kind: "receive" | "deadline" | "shutdown" | "intentUpdate" }>;

// Pairs a unit with its own state and the input: each case narrows all three together (P3-C0-NO-AS-FORM 1).
function unitJob(states: RuntimeUnitStates, unit: RuntimeUnitId, input: UnitInput): UnitJob {
  switch (unit) {
    case "U-E": return { unit, state: states[unit], input };
    case "U-W": return { unit, state: states[unit], input };
    case "U-F": return { unit, state: states[unit], input };
    default: { const missing: never = unit; throw new Error(`unit ${String(missing)} has no job`); }
  }
}

// The one place a unit reducer is called: the job's unit, state and input cannot come from different units.
function runUnitJob(units: UnitTable, job: UnitJob): RuntimeUnitSteps[RuntimeUnitId] {
  switch (job.unit) {
    case "U-E": return units[job.unit].reduce(job.state, job.input);
    case "U-W": return units[job.unit].reduce(job.state, job.input);
    case "U-F": return units[job.unit].reduce(job.state, job.input);
    default: { const missing: never = job; throw new Error(`unit job ${String(missing)} is not handled`); }
  }
}

function normalSubjects<K extends RuntimeUnitId>(units: UnitTable, unit: K, state: RuntimeUnitStates[K]) {
  return units[unit].normalDisplaySubjects(state);
}

function admissionCounts(admission: RuntimeAdmission): RuntimeAdmissionCounts {
  const count = (unit: RuntimeUnitId, operation: Operation) => {
    const slot = admission[unit]?.[operation];
    return (slot?.records.length ?? 0) + (slot?.overflow ? 1 : 0);
  };
  return Object.fromEntries(runtimeUnits.map((unit) => [unit, Object.fromEntries(operations.map((operation) =>
    [operation, count(unit, operation)]))])) as RuntimeAdmissionCounts;
}

function initialConfirmation(): RuntimeConfirmation {
  const slot = () => ({ whole: "startup" as const, counts: { startup: 1 }, confirmedScopeCount: 0,
    scopeBytes: 2, scopes: [], confirmedAt: null });
  const three = () => ({ normal: slot(), training: slot(), test: slot() });
  return { epoch: 0, afterInputSequence: -1,
    units: { "U-E": three(), "U-W": three(), "U-F": three() } };
}

type ConfirmationSlot = RuntimeConfirmation["units"][RuntimeUnitId][Operation];
type ScopeRecord = ConfirmationSlot["scopes"][number];
// P2-A1-CONFIRMATION bounds: records keep their scope object, so its key and byte length are
// serialized once per scope object, not once per retained scope on every update or disconnect.
const scopeKeyCache = new WeakMap<ConfirmationScope, string>();
const scopeByteCache = new WeakMap<ConfirmationScope, number>();
// JSON of { scope, reason, confirmedAt }: '{"scope":' ',"reason":' ',"confirmedAt":' '}' are 35 ASCII bytes.
const scopeBytes = (record: ScopeRecord) => {
  let bytes = scopeByteCache.get(record.scope);
  if (bytes == null) {
    bytes = new TextEncoder().encode(JSON.stringify(record.scope)).byteLength;
    scopeByteCache.set(record.scope, bytes);
  }
  return bytes + 35 + (record.reason == null ? 4 : record.reason.length + 2)
    + (record.confirmedAt != null && Number.isFinite(record.confirmedAt) ? String(record.confirmedAt).length : 4);
};
const scopeKey = (scope: ConfirmationScope) => {
  let key = scopeKeyCache.get(scope);
  if (key == null) {
    key = JSON.stringify(scope.kind === "unit"
      ? [scope.unit, scope.operation, "unit"]
      : scope.kind === "event" ? [scope.unit, scope.operation, "event", scope.eventId]
        : scope.kind === "area" ? [scope.unit, scope.operation, "area", scope.subject, scope.token]
          : [scope.unit, scope.operation, "series", "VPWP50", scope.office, scope.subject]);
    scopeKeyCache.set(scope, key);
  }
  return key;
};

function updateConfirmation(confirmation: RuntimeConfirmation, units: UnitTable, unit: RuntimeUnitId, operation: Operation,
  update: (slot: ConfirmationSlot, unitBytes: number, unitCount: number) => ConfirmationSlot): RuntimeConfirmation {
  const current = confirmation.units[unit][operation];
  const unitBytes = operations.reduce((sum, name) => sum + confirmation.units[unit][name].scopeBytes, 0);
  const unitCount = operations.reduce((sum, name) => sum + confirmation.units[unit][name].scopes.length, 0);
  let slot = update(current, unitBytes, unitCount);
  if (unitBytes - current.scopeBytes + slot.scopeBytes > 1_048_576
    || unitCount - current.scopes.length + slot.scopes.length > units[unit].confirmationScopeLimit)
    slot = { whole: "scopeCapacity", counts: { scopeCapacity: 1 }, confirmedScopeCount: 0,
      scopeBytes: 2, scopes: [], confirmedAt: null };
  if (slot === current) return confirmation;
  return { ...confirmation, units: { ...confirmation.units,
    [unit]: { ...confirmation.units[unit], [operation]: slot } } };
}

function updateScopes(confirmation: RuntimeConfirmation, units: UnitTable, incoming: readonly ConfirmationScope[], at: number | null): RuntimeConfirmation {
  const groups = new Map<string, { unit: RuntimeUnitId; operation: Operation; scopes: ConfirmationScope[] }>();
  for (const scope of incoming) {
    const key = JSON.stringify([scope.unit, scope.operation]);
    let group = groups.get(key);
    if (group == null) { group = { unit: scope.unit, operation: scope.operation, scopes: [] }; groups.set(key, group); }
    group.scopes.push(scope);
  }
  let next = confirmation;
  for (const group of groups.values()) next = updateConfirmation(next, units, group.unit, group.operation, (slot) => {
    const records = new Map(slot.scopes.map((item) => [scopeKey(item.scope), item]));
    const counts = { ...slot.counts };
    let bytes = slot.scopeBytes, confirmed = slot.confirmedScopeCount;
    const remove = (key: string) => {
      const old = records.get(key);
      if (old == null) return;
      bytes -= scopeBytes(old) + (records.size > 1 ? 1 : 0);
      if (old.reason == null) confirmed--;
      else {
        counts[old.reason] = (counts[old.reason] ?? 1) - 1;
        if (counts[old.reason] === 0) delete counts[old.reason];
      }
      records.delete(key);
    };
    let scopes = group.scopes;
    if (at != null && group.unit === "U-W") {
      const areas = new Map<string, Extract<ConfirmationScope, { kind: "area" }>[]>();
      for (const scope of scopes) if (scope.kind === "area") {
        const list = areas.get(scope.subject) ?? []; list.push(scope); areas.set(scope.subject, list);
      }
      scopes = [...areas.values()].flatMap((list) => normalizeScopes(list.map((scope) => scope.token))
        .map((token) => ({ ...list[0], token })));
    }
    // Only the incoming subjects' previous area records are compared, so only their tokens are parsed.
    const subjects = new Set(at == null ? [] : scopes.flatMap((scope) => scope.kind === "area" ? [scope.subject] : []));
    const bySubject = new Map<string, string[]>(), broad = new Map<string, string>();
    if (subjects.size !== 0) for (const [key, item] of records)
      if (item.scope.kind === "area" && subjects.has(item.scope.subject)) {
        const keys = bySubject.get(item.scope.subject) ?? [];
        keys.push(key); bySubject.set(item.scope.subject, keys);
        if (parseScopeToken(item.scope.token)?.[3] === "all") broad.set(item.scope.subject, key);
      }
    for (const scope of scopes) {
      const key = scopeKey(scope);
      if (at == null && records.has(key)) continue;
      if (at != null && scope.kind === "area") {
        const encompassing = records.get(broad.get(scope.subject) ?? "");
        if (encompassing?.scope.kind === "area" && encompassing.reason == null
          && scopeContains([encompassing.scope.token], [scope.token]) && scope.token !== encompassing.scope.token) {
          remove(key); continue;
        }
        if (parseScopeToken(scope.token)?.[3] === "all")
          for (const oldKey of bySubject.get(scope.subject) ?? []) {
            const old = records.get(oldKey);
            if (old?.scope.kind === "area" && scopeContains([scope.token], [old.scope.token])) remove(oldKey);
          }
      }
      remove(key);
      const reason = at == null ? slot.whole ?? "startup" : null;
      const record: ScopeRecord = { scope, reason, confirmedAt: at };
      bytes += scopeBytes(record) + (records.size === 0 ? 0 : 1);
      records.set(key, record);
      if (reason == null) confirmed++; else counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return { ...slot, scopes: [...records.values()], scopeBytes: bytes, counts, confirmedScopeCount: confirmed,
      confirmedAt: slot.whole == null && confirmed === records.size ? at ?? slot.confirmedAt : null };
  });
  return next;
}

function applyConfirmationEvidence(confirmation: RuntimeConfirmation, units: UnitTable,
  evidence: readonly CurrentConfirmationEvidence[], at: number): RuntimeConfirmation {
  return updateScopes(confirmation, units, evidence.flatMap((item) => item.scopes), at);
}

function addedScopes(changes: readonly RuntimeDisplayChange[]): ConfirmationScope[] {
  const scopes = (value: RuntimeDisplayChange["after"]): ConfirmationScope[] => {
    if (value == null) return [];
    if (value.unit === "U-E") return value.current == null ? []
      : [{ unit: "U-E", operation: value.operation, kind: "event", eventId: value.current.eventId }];
    if (value.unit === "U-F") return value.current == null || value.office == null ? []
      : [{ unit: "U-F", operation: value.operation, kind: "series", subject: value.subject, office: value.office }];
    return normalizeScopes([...(value.current == null ? [] : Object.keys(value.current.phenomena)),
      ...value.unavailable.flatMap((item) => item.affectedScope),
      // Only shown (suspect) freshness enters confirmation; older/same/unknown non-adoption raises no doubt (A5).
      ...value.freshness.filter((item) => item.freshnessSuspect).flatMap((item) => item.target.affectedScope)]).map((token) => ({
        unit: "U-W", operation: value.operation, kind: "area", subject: value.subject, token }));
  };
  return changes.flatMap((change) => {
    const previous = new Set(scopes(change.before).map(scopeKey));
    return scopes(change.after).filter((scope) => !previous.has(scopeKey(scope)));
  });
}

function retireConfirmation(confirmation: RuntimeConfirmation, units: UnitTable, changes: readonly RuntimeDisplayChange[],
  eew: RuntimeUnitStates["U-E"]): RuntimeConfirmation {
  if (!changes.some((change) => change.after == null)) return confirmation;
  const groups = new Map<string, { unit: RuntimeUnitId; operation: Operation; subjects: Set<string>; events: Set<string> }>();
  const liveEvents = changes.some((change) => change.after == null && change.unit === "U-E")
    ? new Set(eew.current.map((item) => JSON.stringify([item.operation, item.eventId]))) : null;
  for (const change of changes) if (change.after == null) {
    const key = JSON.stringify([change.unit, change.operation]);
    let group = groups.get(key);
    if (group == null) { group = { unit: change.unit, operation: change.operation,
      subjects: new Set(), events: new Set() }; groups.set(key, group); }
    group.subjects.add(change.subject);
    if (change.before?.unit === "U-E" && change.before.current != null
      && !liveEvents?.has(JSON.stringify([change.operation, change.before.current.eventId])))
      group.events.add(change.before.current.eventId);
  }
  let next = confirmation;
  for (const group of groups.values()) next = updateConfirmation(next, units, group.unit, group.operation, (slot) => {
    const scopes: ScopeRecord[] = [], removed: ScopeRecord[] = [];
    for (const item of slot.scopes) {
      const drop = item.scope.kind === "event" ? group.events.has(item.scope.eventId)
        : item.scope.kind === "area" || item.scope.kind === "series"
          ? group.subjects.has(item.scope.subject) : false;
      (drop ? removed : scopes).push(item);
    }
    if (removed.length === 0) return slot;
    const whole = slot.whole ?? (removed.some((item) => item.reason != null) ? "scopeRetired" : null);
    const counts = { ...slot.counts };
    for (const item of removed) if (item.reason != null) {
      counts[item.reason] = (counts[item.reason] ?? 1) - 1;
      if (counts[item.reason] === 0) delete counts[item.reason];
    }
    if (whole === "scopeRetired") counts.scopeRetired = 1;
    return { ...slot, scopes, whole, counts,
      scopeBytes: slot.scopeBytes - removed.reduce((sum, item) => sum + scopeBytes(item), 0)
        - (Math.max(slot.scopes.length - 1, 0) - Math.max(scopes.length - 1, 0)),
      confirmedScopeCount: slot.confirmedScopeCount - removed.filter((item) => item.reason == null).length,
      confirmedAt: whole == null ? slot.confirmedAt : null };
  });
  return next;
}

function lostConfirmation(confirmation: RuntimeConfirmation, units: UnitTable, afterInputSequence: number): RuntimeConfirmation {
  let next = { ...confirmation, epoch: confirmation.epoch + 1, afterInputSequence };
  for (const unit of runtimeUnits) for (const operation of operations)
    next = updateConfirmation(next, units, unit, operation, (slot) => {
      const scopes = slot.scopes.map((item) => ({ scope: item.scope, reason: "disconnected" as const, confirmedAt: null }));
      return { whole: "disconnected", counts: { disconnected: scopes.length + 1 },
        confirmedScopeCount: 0, scopeBytes: 2 + scopes.reduce((sum, item) => sum + scopeBytes(item), Math.max(scopes.length - 1, 0)),
        scopes, confirmedAt: null };
    });
  return next;
}

function updateAdmission(admission: RuntimeAdmission, unit: RuntimeUnitId,
  decisions: RuntimeUnitSteps[RuntimeUnitId]["decisions"]): RuntimeAdmission {
  let next = admission;
  for (const decision of [...decisions.filter((item) => item.decision === "capacityExceeded"),
    ...decisions.filter((item) => item.decision !== "capacityExceeded")]) {
    if (decision.decision !== "capacityExceeded" && (decision.decision !== "changed" || decision.currentEstablished == null)) continue;
    const operation = decision.operation;
    if (decision.decision === "changed" && next[unit]?.[operation] == null) continue;
    const slot = next[unit]?.[operation] ?? { records: [], overflow: false };
    let records = [...slot.records];
    let overflow = slot.overflow;
    if (decision.decision === "capacityExceeded") {
      const { rejection } = decision;
      const index = records.findIndex((item) => item.family === rejection.family && item.subject === decision.subject);
      const existing = records[index];
      const scope = existing?.affectedScope === "subject" || rejection.affectedScope === "subject" ? "subject" as const
        : existing == null ? rejection.affectedScope : normalizeScopes([...existing.affectedScope, ...rejection.affectedScope]);
      const candidate: AdmissionRejection = { subject: decision.subject, family: rejection.family,
        reportDateTimeMs: Math.max(existing?.reportDateTimeMs ?? -Infinity, rejection.reportDateTimeMs), affectedScope: scope };
      const proposed = index < 0 ? [...records, candidate] : records.map((item, at) => at === index ? candidate : item);
      const bytes = proposed.reduce((sum, record) => {
        let size = admissionRecordByteCache.get(record);
        if (size == null) {
          size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
          admissionRecordByteCache.set(record, size);
        }
        return sum + size;
      }, 2 + Math.max(proposed.length - 1, 0));
      if (proposed.length > 512 || bytes > 262_144) overflow = true;
      else records = proposed;
    } else {
      const evidence = decision.currentEstablished!;
      records = records.flatMap((record) => {
        if (record.family !== evidence.family || record.subject !== decision.subject
          || !(evidence.reportDateTimeMs > record.reportDateTimeMs)) return [record];
        if (record.affectedScope === "subject") return evidence.affectedScope === "subject" ? [] : [record];
        if (evidence.affectedScope === "subject") return [];
        const remaining = record.affectedScope.filter((token) => !scopeContains(evidence.affectedScope as readonly string[], [token]));
        return remaining.length === 0 ? [] : [{ ...record, affectedScope: remaining }];
      });
    }
    const byOperation = { ...next[unit] };
    if (records.length === 0 && !overflow) delete byOperation[operation];
    else byOperation[operation] = { records, overflow };
    next = { ...next, [unit]: byOperation };
  }
  return next;
}

function shutdownSummary(state: RuntimeState, clock: ClockReading): ShutdownSummary {
  const reasons: string[] = [];
  let code: ShutdownSummary["code"] = 0;
  const add = (reason: string, priority: 2 | 3 | 4) => {
    reasons.push(reason);
    if (code === 0 || priority === 3 || priority === 2 && code === 4) code = priority;
  };
  let latest: RuntimeState["shutdown"]["stageResults"]["mailboxDrain"];
  for (const stage of stages) {
    const observation = state.shutdown.stageResults[stage];
    if (observation == null) continue;
    latest = observation;
    const { result, pending } = observation;
    const priority = stage === "mailboxDrain" ? 3 : stage === "finalCheckpoint" ? 2 : 4;
    if (result.kind === "failed") add(stage + ":failed:" + result.reason, priority);
    const deadline = state.shutdown.deadlines[`${stage}MonotonicMs` as const];
    if (result.kind === "deadlineExceeded" || deadline != null && observation.clock.monotonicMs >= deadline)
      add(stage + ":deadlineExceeded", priority);
    if (stage === "mailboxDrain" && pending.mailboxPending + pending.mailboxInFlight > 0)
      add(stage + ":remainingInputs", 3);
    if (stage !== "mailboxDrain" && pending.batches > 0) add(stage + ":remainingBatches", 3);
    if (stage === "sideEffectFinalization" && pending.notificationAttempts > 0)
      add(stage + ":unconfirmedNotifications", 4);
    if (stage === "finalCheckpoint" && pending.unsavedUnits > 0) add(stage + ":unsavedUnits", 2);
    if (stage === "workerClose" && pending.workers > 0) add(stage + ":remainingWorkers", 4);
  }
  if (latest == null || state.shutdown.startedAt == null || state.shutdown.acceptedThroughSequence == null)
    throw new Error("shutdown has no terminal observation");
  return {
    code, reasons, requestedAt: state.shutdown.startedAt.wallTimeMs,
    finalizationAt: state.shutdown.finalizationAt, completedAt: clock.wallTimeMs,
    acceptedThroughSequence: state.shutdown.acceptedThroughSequence,
    pendingInputs: latest.pending.mailboxPending, inFlightInputs: latest.pending.mailboxInFlight,
    persistence: Object.fromEntries(runtimeUnits.map((unit) => [unit, state.units[unit].persistence])),
    droppedDiagnostics: latest.droppedDiagnostics,
  };
}

function viewBits(admission: RuntimeAdmission, unit: RuntimeUnitId): number {
  return (admission[unit]?.normal == null ? 0 : 1)
    | (admission[unit]?.training == null ? 0 : 2)
    | (admission[unit]?.test == null ? 0 : 4);
}

function projectView<K extends RuntimeUnitId>(state: RuntimeState, units: UnitTable, unit: K): RuntimeViews[K] {
  const admission = Object.fromEntries(operations.filter((operation) => state.admission[unit]?.[operation] != null)
    .map((operation) => [operation, "capacityExceeded" as const]));
  const normalBlocked = state.admission[unit]?.normal != null;
  const module = units[unit];
  const source = state.units[unit];
  const base = module.toView(normalBlocked ? module.withoutNormal(source) : source);
  return { ...base, admission,
    subjects: normalBlocked ? base.subjects.filter((item) => item.operation !== "normal" || module.keepsWhileNormalHidden(item)) : base.subjects,
    contentRevision: `${source.contentRevision}:${viewBits(state.admission, unit)}` };
}

function projectViews(state: RuntimeState, calls: Parameters<typeof reduceRuntime>[2],
  changed: readonly RuntimeUnitId[]): RuntimeViews {
  let views = state.views;
  for (const unit of changed) views = { ...views, [unit]: projectView(state, calls.units, unit) };
  return views;
}

function maskChanges(state: RuntimeState, next: RuntimeState, existing: readonly RuntimeDisplayChange[],
  units: UnitTable): RuntimeDisplayChange[] {
  const changes: RuntimeDisplayChange[] = [];
  for (const unit of runtimeUnits) {
    if ((state.admission[unit]?.normal == null) === (next.admission[unit]?.normal == null)) continue;
    const seen = new Set(existing.filter((item) => item.unit === unit && item.operation === "normal")
      .map((item) => item.subject));
    for (const value of normalSubjects(units, unit, next.units[unit])) {
      if (seen.has(value.subject)) continue;
      changes.push({ unit, operation: value.operation, subject: value.subject, before: value, after: value });
    }
  }
  return changes;
}

// The unit table is required: no missing unit function can be treated as success (P3-C0-TABLE-HOME).
// The notification calls stay optional until A7 is linked.
function reduceRuntime(
  state: RuntimeState | null,
  input: RuntimeInput,
  calls: Readonly<{
    units: UnitTable;
    selectNotificationAttempt?: (state: NotificationDeliveryState, clock: ClockReading) => NotificationSelection;
    applyNotificationResult?: (state: NotificationDeliveryState, result: NotificationResult, clock: ClockReading) => NotificationDeliveryStep;
    codecs?: CodecMap<RuntimeUnitStates>;
  }>,
): RuntimeStep {
  if (input.kind === "startup") {
    if (state != null) throw new Error("runtime already started");
    if (input.runId.length === 0 || !Number.isFinite(input.clock.wallTimeMs) || !Number.isFinite(input.clock.monotonicMs)
      || Object.keys(input.restored).length !== runtimeUnits.length || runtimeUnits.some((unit) => input.restored[unit] == null)
      || input.notificationChannels == null || Object.keys(input.notificationChannels).length !== 2
      || (["desktop", "sound"] as const).some((name) => {
        const channel = input.notificationChannels[name];
        return channel?.kind !== "idle";
      }))
      throw new RangeError("invalid startup input");
    const clean: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null };
    const initialUnits: RuntimeUnitStates = {
      "U-E": { schemaVersion: "p2-eew-unit-v1", contentRevision: 0, current: [], gates: [], intents: [], deliveryRecords: [], notificationLatches: [], persistence: clean },
      "U-W": { schemaVersion: "p2-weather-current-unit-v1", contentRevision: 0, national: {}, partials: [], histories: [], ownership: {},
        tombstones: [], freshness: [], unavailable: [], intents: [], persistence: clean },
      "U-F": { schemaVersion: "p2-weather-timeseries-unit-v1", contentRevision: 0, subjects: [], gates: [], intents: [], persistence: clean },
    };
    let initial: RuntimeState = {
      runId: input.runId, units: initialUnits,
      views: { "U-E": calls.units["U-E"].toView(initialUnits["U-E"]),
        "U-W": calls.units["U-W"].toView(initialUnits["U-W"]),
        "U-F": calls.units["U-F"].toView(initialUnits["U-F"]) },
      confirmation: initialConfirmation(),
      restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } },
      admission: {}, checkpointAttempts: {}, deadlines: { "U-E": null, "U-W": null, "U-F": null },
      notificationChannels: input.notificationChannels,
      notificationProbeComplete: false,
      notificationDeadlines: { desktop: {}, sound: {} },
      shutdown: { stage: "running", acceptedThroughSequence: null, startedAt: null, finalizationAt: null,
        stageResults: {}, deadlines: { overallMonotonicMs: null, mailboxDrainMonotonicMs: null,
          sideEffectFinalizationMonotonicMs: null, finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } },
    };
    const changedUnits: RuntimeUnitId[] = [];
    const generationInputIds: Partial<Record<RuntimeUnitId, readonly string[]>> = {};
    const outcomes: RuntimeStep["outcomes"][number][] = [];
    const diagnostics: DiagnosticEvent[] = [];
    const displayChanges: RuntimeDisplayChange[] = [];
    const restoreUnit = <K extends RuntimeUnitId>(unit: K) => {
      const restored = input.restored[unit];
      if (restored.kind === "empty" || restored.kind === "unavailable") {
        initial = { ...initial, restoration: { ...initial.restoration, [unit]: restored } };
        return;
      }
      const { envelope } = restored;
      const codec = calls.codecs?.[unit];
      if (envelope.unit !== unit || envelope.schemaVersion !== initial.units[unit].schemaVersion
        || !Number.isSafeInteger(envelope.generation) || envelope.generation < 1
        || !Number.isFinite(envelope.capturedAt) || codec == null)
        throw new RangeError("invalid restored unit envelope");
      const decoded = codec.decode(envelope.payload);
      if (decoded.kind !== "restored") {
        initial = { ...initial, restoration: { ...initial.restoration, [unit]: { kind: "unavailable", reason: "noValidSlot" } } };
        return;
      }
      const persistence: PersistenceStatus = { kind: "saved", currentGeneration: envelope.generation,
        savedGeneration: envelope.generation, savedCapturedAt: envelope.capturedAt, savedAckAt: null, dirtySince: null };
      const seeded = { ...decoded.state, persistence };
      // The one `as`: CodecMap is typed over JsonValue; this unit's own codec made both state and persisted payload.
      // With K generic the whole job escapes the correlated union here, so unit, state and input are checked by eye.
      const step = runUnitJob(calls.units, { unit, state: seeded,
        input: { kind: "restore", persisted: codec.encode(seeded), clock: input.clock } } as UnitJob);
      initial = { ...initial, units: { ...initial.units, [unit]: step.state },
        restoration: { ...initial.restoration, [unit]: { kind: "restored" } },
        deadlines: { ...initial.deadlines, [unit]: step.nextDeadline } };
      changedUnits.push(unit);
      if (step.state.persistence.currentGeneration > envelope.generation) generationInputIds[unit] = [];
      outcomes.push(...step.outcomes.map((outcome) => ({ unit, outcome })));
      displayChanges.push(...step.displayChanges.filter((change) => change.after != null)
        .map((change) => ({ ...change, before: null })));
      diagnostics.push(...step.diagnostics.map((details) => completeDiagnostic(details, input.clock, input.runId)));
    };
    for (const unit of runtimeUnits) restoreUnit(unit);
    const selected = reduceRuntime(initial, { kind: "mailboxCompleted", clock: input.clock, completion: {
      kind: "control", messageId: "startup", runId: input.runId, encodedByteLength: 0,
      startedMonotonicMs: input.clock.monotonicMs, completedMonotonicMs: input.clock.monotonicMs,
      control: { kind: "deadline", clock: input.clock },
    } }, calls);
    const views = projectViews(selected.state, calls, runtimeUnits);
    return { ...selected, state: { ...selected.state, views }, changedUnits: [...new Set([...changedUnits, ...selected.changedUnits])],
      generationInputIds: { ...generationInputIds, ...selected.generationInputIds },
      outcomes: [...outcomes, ...selected.outcomes], views: runtimeUnits.map((unit) => views[unit]),
      admissionCounts: admissionCounts(selected.state.admission),
      displayChanges: [...displayChanges, ...selected.displayChanges], diagnostics: [...diagnostics, ...selected.diagnostics] };
  }
  if (state == null) throw new Error("runtime has not started");
  let next = state;
  let changedUnits: readonly UnitId[] = EMPTY;
  const generationInputIds: Partial<Record<RuntimeUnitId, readonly string[]>> = {};
  let outcomes: RuntimeStep["outcomes"] = EMPTY;
  let displayChanges: RuntimeDisplayChange[] = [];
  let confirmationEvidence: CurrentConfirmationEvidence[] = [];
  const viewUnits = new Set<RuntimeUnitId>();
  let diagnostics: RuntimeStep["diagnostics"] = EMPTY;
  let effects: readonly RuntimeEffect[] = EMPTY;
  let notificationAttempts: RuntimeStep["notificationAttempts"] = EMPTY;
  let abortRequests: RuntimeStep["abortRequests"] = EMPTY;
  let summary: ShutdownSummary | null = null;
  const clock = input.kind === "checkpointCaptured" ? null
    : input.kind === "notificationResult" ? input.result.completedAt : input.clock;
  if (clock != null && (!Number.isFinite(clock.wallTimeMs) || !Number.isFinite(clock.monotonicMs)))
    throw new RangeError("runtime clock must be finite");

  const changed = (unit: RuntimeUnitId) => {
    if (!changedUnits.includes(unit)) changedUnits = [...changedUnits, unit];
  };
  const diagnose = (details: DiagnosticDetails) => {
    if (clock == null) throw new Error("diagnostic requires an explicit clock");
    diagnostics = [...diagnostics, completeDiagnostic(details, clock, state.runId)];
  };
  const setPersistence = (unit: RuntimeUnitId, persistence: PersistenceStatus) => {
    next = { ...next, units: { ...next.units, [unit]: { ...next.units[unit], persistence } } };
    changed(unit);
  };
  const reduceUnit = (unit: RuntimeUnitId, unitInput: UnitInput) => {
    const step = runUnitJob(calls.units, unitJob(next.units, unit, unitInput));
    const previous = next.units[unit];
    if (step.state.persistence.currentGeneration > previous.persistence.currentGeneration)
      generationInputIds[unit] ??= [];
    if (step.state !== previous) {
      const attempt = next.checkpointAttempts[unit];
      // The first changed durable generation after capture defines the next dirty interval.
      if (attempt != null && attempt.postCaptureDirtySince == null
        && step.state.persistence.currentGeneration > previous.persistence.currentGeneration
        && step.state.persistence.currentGeneration > attempt.generation) {
        next = { ...next, checkpointAttempts: { ...next.checkpointAttempts,
          [unit]: { ...attempt, postCaptureDirtySince: unitInput.clock.monotonicMs } } };
      }
      next = { ...next, units: { ...next.units, [unit]: step.state } };
      changed(unit);
    }
    const admission = updateAdmission(next.admission, unit, step.decisions);
    if (admission !== next.admission) {
      if (viewBits(next.admission, unit) !== viewBits(admission, unit)) viewUnits.add(unit);
      next = { ...next, admission };
      changed(unit);
    }
    const deadline = step.nextDeadline;
    if (deadline != null && (deadline.wallTimeMs == null && deadline.monotonicMs == null
      || deadline.wallTimeMs != null && !Number.isFinite(deadline.wallTimeMs)
      || deadline.monotonicMs != null && !Number.isFinite(deadline.monotonicMs)))
      throw new RangeError("unit returned an invalid deadline");
    const previousDeadline = next.deadlines[unit];
    if (deadline?.wallTimeMs !== previousDeadline?.wallTimeMs
      || deadline?.monotonicMs !== previousDeadline?.monotonicMs)
      next = { ...next, deadlines: { ...next.deadlines, [unit]: deadline } };
    if (step.outcomes.length !== 0) outcomes = [...outcomes,
      ...step.outcomes.map((outcome) => ({ unit, outcome }))];
    if (step.displayChanges.length !== 0) {
      displayChanges.push(...step.displayChanges);
      viewUnits.add(unit);
    }
    if (unitInput.kind === "receive") confirmationEvidence.push(...step.confirmationEvidence);
    step.diagnostics.forEach(diagnose);
    return step;
  };
  const applyDeadlines = (targets: readonly RuntimeUnitId[] = runtimeUnits) => {
    if (clock == null || next.shutdown.finalizationAt != null) return;
    for (const unit of targets) {
      const deadline = next.deadlines[unit];
      if (deadline != null && (deadline.wallTimeMs != null && clock.wallTimeMs >= deadline.wallTimeMs
        || deadline.monotonicMs != null && clock.monotonicMs >= deadline.monotonicMs))
        reduceUnit(unit, { kind: "deadline", clock });
    }
  };
  const unsavedUnits = () => runtimeUnits.filter((unit) => {
    const status = next.units[unit].persistence;
    return status == null || status.kind !== "saved" || status.currentGeneration !== status.savedGeneration;
  });
  const deliveryState = (): NotificationDeliveryState => ({
    intents: runtimeUnits.flatMap((unit) => next.units[unit].intents.filter((intent) =>
      intent.operation !== "normal" || next.admission[unit]?.normal == null)), channels: next.notificationChannels,
    deadlines: next.notificationDeadlines,
  });
  const sameIntent = (left: NotificationIntent, right: Pick<NotificationIntent, "id" | "unit" | "operation" | "subject" | "channel">) =>
    left.id === right.id && left.unit === right.unit && left.operation === right.operation
    && left.subject === right.subject && left.channel === right.channel;

  const adoptDelivery = (before: NotificationDeliveryState, output: NotificationDeliveryStep | NotificationSelection,
    result?: NotificationResult) => {
    if (clock == null) throw new Error("notification requires an explicit clock");
    // A7 owns selection/retry/abort policy. A1 only adopts correlated, existing identities.
    const byKey = new Map<string, NotificationIntent>();
    const duplicates = new Set<string>();
    const updates: Partial<Record<RuntimeUnitId, { original: NotificationIntent; candidate: NotificationIntent }[]>> = {};
    for (const intent of before.intents) {
      const key = JSON.stringify([intent.unit, intent.id]);
      if (byKey.has(key)) duplicates.add(key);
      else byKey.set(key, intent);
    }
    for (const candidate of output.state.intents) {
      const key = JSON.stringify([candidate.unit, candidate.id]);
      const original = byKey.get(key);
      if (original == null || duplicates.has(key) || !isRuntimeUnit(candidate.unit)
        || !sameIntent(original, candidate)) continue;
      if (original.attempts === candidate.attempts && original.nextAttemptAt === candidate.nextAttemptAt
        && original.disposition === candidate.disposition) continue;
      if (!Number.isSafeInteger(candidate.attempts) || candidate.attempts < original.attempts
        || !Number.isFinite(candidate.nextAttemptAt)) throw new RangeError("invalid notification intent update");
      if (original.disposition !== "pending" && candidate.disposition !== original.disposition) continue;
      if (result == null) {
        if (candidate.disposition !== original.disposition) {
          if (candidate.disposition !== "expired" || original.disposition !== "pending")
            throw new Error("selection changed intent disposition");
        } else {
          const channel = output.state.channels[candidate.channel];
          if ((channel.kind !== "running" && channel.kind !== "stopping")
            || !sameIntent(candidate, { ...channel.attempt, id: channel.attempt.intentId }))
            throw new Error("selection has no matching attempt");
        }
      } else {
        const channel = before.channels[result.channel];
        if ((channel.kind !== "running" && channel.kind !== "stopping")
          || channel.attempt.attemptId !== result.attemptId || result.intentId !== original.id
          || !sameIntent(original, { ...channel.attempt, id: channel.attempt.intentId })) continue;
        // Invalidated or late success cannot become delivered, even if a caller supplies it.
        if (candidate.disposition === "delivered" && (channel.kind !== "running"
          || result.kind !== "delivered" || original.disposition !== "pending"
          || clock.wallTimeMs >= original.expiresAt
          || clock.monotonicMs >= channel.attempt.timeoutAtMonotonicMs)) continue;
      }
      (updates[candidate.unit] ??= []).push({ original, candidate });
    }
    const adoptUnit = <K extends RuntimeUnitId>(unit: K) => {
      const changes = updates[unit];
      if (changes == null) return;
      const previousGeneration = next.units[unit].persistence.currentGeneration;
      const intentUpdates = changes.map(({ candidate }) => ({ id: candidate.id, attempts: candidate.attempts,
        nextAttemptAt: candidate.nextAttemptAt, disposition: candidate.disposition }));
      // ponytail: K <= 128, T only byte-bounded (256KiB/16MiB/32MiB); keep O(K + T) batching if budgets grow.
      reduceUnit(unit, { kind: "intentUpdate", clock,
        intentUpdate: intentUpdates.length === 1 ? intentUpdates[0] : intentUpdates });
      const adopted = next.units[unit];
      const intentsById = new Map(adopted.intents.map((intent) => [intent.id, intent]));
      const terminal = calls.units[unit].terminalIntents;
      const recordsById = terminal.kind === "deliveryRecords"
        ? new Map(terminal.records(adopted).map((record) => [record.intentId, record])) : null;
      for (const { original, candidate } of changes) {
        if (recordsById != null && candidate.disposition !== "pending") {
          // At the wall deadline A4 reclaims the terminal record in the same adoption.
          const reclaimed = candidate.disposition === "expired" && clock.wallTimeMs >= original.expiresAt;
          const record = recordsById.get(original.id);
          if ((!reclaimed && (record?.disposition !== candidate.disposition || record.expiresAt !== original.expiresAt))
            || intentsById.has(original.id)
            || adopted.persistence.currentGeneration <= previousGeneration)
            throw new Error("unit did not adopt the correlated intent update");
        } else {
          const intent = intentsById.get(original.id);
          if (intent?.attempts !== candidate.attempts || intent.nextAttemptAt !== candidate.nextAttemptAt
            || intent.disposition !== candidate.disposition)
            throw new Error("unit did not adopt the correlated intent update");
        }
      }
    };
    for (const unit of runtimeUnits) adoptUnit(unit);
    const channelsChanged = (["desktop", "sound"] as const).some((name) => {
      const left = next.notificationChannels[name];
      const right = output.state.channels[name];
      if (left === right || left.kind === "idle" && right.kind === "idle") return false;
      if (left.kind === "running" && right.kind === "running") return left.attempt !== right.attempt;
      if (left.kind === "stopping" && right.kind === "stopping")
        return left.attempt !== right.attempt || left.cause !== right.cause || left.stopByMonotonicMs !== right.stopByMonotonicMs;
      if (left.kind === "isolated" && right.kind === "isolated")
        return left.attemptId !== right.attemptId || left.sinceMonotonicMs !== right.sinceMonotonicMs || left.reason !== right.reason;
      if (left.kind === "unavailable" && right.kind === "unavailable") return left.reason !== right.reason;
      return true;
    });
    if (channelsChanged)
      next = { ...next, notificationChannels: output.state.channels };
    const ownerPending = runtimeUnits.flatMap((unit) => next.units[unit].intents)
      .filter((intent) => intent.disposition === "pending");
    const visible = new Set(before.intents.map((intent) => JSON.stringify([intent.unit, intent.id])));
    const adoptedDeadlines = { desktop: { ...output.state.deadlines.desktop }, sound: { ...output.state.deadlines.sound } };
    let deadlinesChanged = output.state.deadlines !== next.notificationDeadlines;
    for (const channel of ["desktop", "sound"] as const) {
      const owned = new Set(ownerPending.filter((intent) => intent.channel === channel)
        .map((intent) => JSON.stringify([intent.unit, intent.id])));
      for (const key of Object.keys(adoptedDeadlines[channel])) if (!owned.has(key)) {
        delete adoptedDeadlines[channel][key];
        deadlinesChanged = true;
      }
      for (const key of owned) if (!visible.has(key) && adoptedDeadlines[channel][key] == null) {
        const value = next.notificationDeadlines[channel][key];
        if (value != null) {
          adoptedDeadlines[channel][key] = value;
          deadlinesChanged = true;
        }
      }
    }
    if (deadlinesChanged)
      next = { ...next, notificationDeadlines: adoptedDeadlines };
    output.diagnostics.forEach(diagnose);
  };

  const reclaimExpired = () => {
    if (clock == null || next.shutdown.finalizationAt != null) return;
    const before: NotificationDeliveryState = { ...deliveryState(), intents: runtimeUnits.flatMap((owner) => next.units[owner].intents) };
    const expired = new Set(before.intents.filter((intent) => intent.disposition === "pending"
      && (clock.wallTimeMs >= intent.expiresAt
        || clock.monotonicMs >= (before.deadlines[intent.channel][JSON.stringify([intent.unit, intent.id])]
          ?.expiresAtMonotonicMs ?? Infinity))));
    if (expired.size === 0) return;
    const channels = { ...before.channels };
    const counts: Partial<Record<RuntimeUnitId, number>> = {};
    for (const intent of expired) {
      if (isRuntimeUnit(intent.unit)) counts[intent.unit] = (counts[intent.unit] ?? 0) + 1;
    }
    for (const name of ["desktop", "sound"] as const) {
      const channel = channels[name];
      if (channel.kind === "running" && before.intents.some((intent) => expired.has(intent)
        && sameIntent(intent, { ...channel.attempt, id: channel.attempt.intentId }))) {
        channels[name] = { kind: "stopping", attempt: channel.attempt, cause: "expired",
          stopByMonotonicMs: clock.monotonicMs + 1_000 };
        abortRequests = [...abortRequests, { attemptId: channel.attempt.attemptId, cause: "expired" }];
      }
    }
    adoptDelivery(before, {
      state: { ...before, channels, intents: before.intents.map((intent) => expired.has(intent)
        ? { ...intent, disposition: "expired" } : intent) },
      diagnostics: runtimeUnits.flatMap((owner) => {
        const count = counts[owner] ?? 0;
        return count === 0 ? [] : [{ level: "INFO", component: "runtime", reason: "notificationExpired", unit: owner, count }];
      }),
    });
  };

  const selectDelivery = () => {
    if (clock == null || next.shutdown.stage !== "running") return;
    const before = deliveryState();
    const ownerPending = runtimeUnits.flatMap((unit) => next.units[unit].intents)
      .filter((intent) => intent.disposition === "pending");
    if (ownerPending.length === 0 && before.channels.desktop.kind === "idle" && before.channels.sound.kind === "idle"
      && Object.keys(before.deadlines?.desktop ?? {}).length === 0
      && Object.keys(before.deadlines?.sound ?? {}).length === 0) return;
    const live = new Set(ownerPending
      .map((intent) => JSON.stringify([intent.unit, intent.id])));
    const deadlines = { desktop: { ...before.deadlines?.desktop }, sound: { ...before.deadlines?.sound } };
    let changedDeadline = before.deadlines == null;
    for (const channel of ["desktop", "sound"] as const) {
      for (const key of Object.keys(deadlines[channel])) if (!live.has(key)) {
        delete deadlines[channel][key];
        changedDeadline = true;
      }
      for (const intent of ownerPending) if (intent.channel === channel) {
        const key = JSON.stringify([intent.unit, intent.id]);
        if (deadlines[channel][key] == null) {
          changedDeadline = true;
          deadlines[channel][key] = {
          retryAtMonotonicMs: clock.monotonicMs + Math.max(0, intent.nextAttemptAt - clock.wallTimeMs),
          expiresAtMonotonicMs: clock.monotonicMs + Math.max(0, intent.expiresAt - clock.wallTimeMs),
          };
        }
      }
    }
    if (Object.keys(deadlines.desktop).length + Object.keys(deadlines.sound).length > 384)
      throw new RangeError("notification deadline capacity exceeded");
    const selectedState = { ...before, deadlines: changedDeadline ? deadlines : before.deadlines };
    if (changedDeadline) next = { ...next, notificationDeadlines: deadlines };
    if (!next.notificationProbeComplete) return;
    if (calls.selectNotificationAttempt == null) {
      if (before.intents.some((intent) => intent.disposition === "pending")) throw new Error("A7 selection is not linked");
      if (changedDeadline) next = { ...next, notificationDeadlines: deadlines };
      return;
    }
    const selection = calls.selectNotificationAttempt(selectedState, clock);
    for (const attempt of selection.attempts) {
      const intent = before.intents.find((candidate) => sameIntent(candidate, { ...attempt, id: attempt.intentId }));
      const updated = selection.state.intents.find((candidate) => sameIntent(candidate, { ...attempt, id: attempt.intentId }));
      const channel = selection.state.channels[attempt.channel];
      if (intent == null || intent.disposition !== "pending" || clock.wallTimeMs >= intent.expiresAt
        || updated == null || updated.attempts <= intent.attempts
        || before.intents.filter((candidate) => candidate.unit === intent.unit && candidate.id === intent.id).length !== 1
        || channel.kind !== "running" || channel.attempt.attemptId !== attempt.attemptId)
        throw new Error("A7 returned an uncorrelated attempt");
    }
    adoptDelivery(selectedState, selection);
    notificationAttempts = [...notificationAttempts, ...selection.attempts];
    abortRequests = [...abortRequests, ...selection.abortRequests];
  };

  if (input.kind === "notificationProbeCompleted" && !next.notificationProbeComplete) {
    if (Object.keys(input.channels).length !== 2 || (["desktop", "sound"] as const).some((name) => {
      const channel = input.channels[name];
      return channel?.kind !== "idle" && (channel?.kind !== "unavailable" || channel.reason !== "backendMissing");
    })) throw new RangeError("invalid notification probe result");
    next = { ...next, notificationChannels: input.channels, notificationProbeComplete: true };
    const missing = (["desktop", "sound"] as const).filter((name) => input.channels[name].kind === "unavailable").length;
    if (missing > 0) diagnose({ level: "WARN", component: "notification-delivery",
      reason: "notificationAttemptFailed", count: missing });
    reclaimExpired();
    selectDelivery();
  } else if (input.kind === "connectionLost") {
    if (!Number.isSafeInteger(input.acceptedThroughSequence) || input.acceptedThroughSequence < -1)
      throw new RangeError("invalid disconnect sequence");
    next = { ...next, confirmation: lostConfirmation(next.confirmation, calls.units, input.acceptedThroughSequence) };
  } else if (input.kind === "coverageVerified") {
    if (input.runId === next.runId && input.epoch === next.confirmation.epoch) {
      for (const scope of input.scopes) {
        if (!runtimeUnits.includes(scope.unit) || !operations.includes(scope.operation)
          || scope.kind === "event" && (scope.unit !== "U-E" || !/^\d{14}$/.test(scope.eventId))
          || scope.kind === "area" && (scope.unit !== "U-W" || !scope.subject
            || (() => { const tuple = parseScopeToken(scope.token); return tuple == null
              || scope.subject !== `${scope.operation}/${tuple[0]}/${tuple[2]}`; })())
          || scope.kind === "series" && (scope.unit !== "U-F" || !scope.subject.startsWith(`${scope.operation}/VPWP50/`)
            || scope.office !== scope.subject.slice(`${scope.operation}/VPWP50/`.length)))
          throw new RangeError("invalid verified scope");
      }
      const specific: Exclude<ConfirmationScope, { kind: "unit" }>[] = [];
      for (const scope of input.scopes) if (scope.kind === "unit") {
        next = { ...next, confirmation: updateConfirmation(next.confirmation, calls.units, scope.unit, scope.operation,
          (slot) => ({ ...slot, whole: null, counts: {}, confirmedScopeCount: 0, scopeBytes: 2,
            scopes: [], confirmedAt: input.clock.wallTimeMs })) };
      } else specific.push(scope);
      if (specific.length !== 0) next = { ...next, confirmation: applyConfirmationEvidence(next.confirmation, calls.units,
        [{ source: "acceptedReport", scopes: specific }], input.clock.wallTimeMs) };
    }
  } else if (input.kind === "checkpointCaptured") {
    const capture = input.capture;
    const previous = next.units[capture.unit].persistence;
    if (!Number.isSafeInteger(capture.generation) || capture.generation < 1 || !Number.isFinite(capture.capturedAt)
      || capture.attemptId.length === 0) throw new RangeError("invalid checkpoint capture");
    if (next.shutdown.stage !== "workerClose" && next.shutdown.stage !== "completed"
      && previous != null && capture.generation === previous.currentGeneration
      && capture.generation > (previous.savedGeneration ?? 0) && next.checkpointAttempts[capture.unit] == null) {
      next = { ...next, checkpointAttempts: { ...next.checkpointAttempts, [capture.unit]: {
        unit: capture.unit, attemptId: capture.attemptId, generation: capture.generation,
        capturedAt: capture.capturedAt, postCaptureDirtySince: null,
      } } };
    }
  } else if (input.kind === "mailboxCompleted" && input.completion.runId === state.runId) {
    if (input.completion.kind === "parser") {
      if (next.shutdown.finalizationAt == null) {
        const { completion } = input;
        // After mailboxDrain every unit has received `shutdown`; a late input stays unapplied (summary: remainingInputs).
        const draining = next.shutdown.stage === "running" || next.shutdown.stage === "mailboxDrain";
        const route = completion.result.kind === "decoded" ? classifyHeadType(completion.result.material.headType) : null;
        const unit = draining && route?.status === "ready" ? route.unit : undefined;
        if (draining) {
          // Reclaim before admission, without starting attempts before cancellation/replacement is known.
          if (unit != null && calls.units[unit].reclaimDeadlineBeforeReceive && next.deadlines[unit]?.wallTimeMs != null) applyDeadlines([unit]);
          reclaimExpired();
        }
        // Units re-run the common Head/date check themselves: one diagnostic per input, and
        // U-W keeps §7.8 freshness monitoring for rejected inputs (A1 freshnessException).
        if (unit != null && completion.result.kind === "decoded") {
          // Maintenance above has no parser attribution. Measure only this receive's durable adoption.
          const generationBeforeReceive = next.units[unit].persistence.currentGeneration;
          const received = reduceUnit(unit, { kind: "receive", material: completion.result.material, clock: input.clock });
          if (received.state.persistence.currentGeneration > generationBeforeReceive
            && received.decisions.some((decision) => decision.decision === "changed"))
            generationInputIds[unit] = [completion.inputId];
        } else if (completion.result.kind === "rejected") {
          const details = parserDiagnostic(completion.result.diagnostic.reason, completion.result.diagnostic.inputId);
          if (details != null) diagnose(details);
        } else if (route?.status === "ignored") {
          // P3-UNIT-TABLE-001: at most one diagnostic per input; ignored headTypes skip the envelope check.
          diagnose(boundDiagnosticDetails({ level: "INFO", component: "shared-runtime", reason: "routeIgnored", inputId: completion.inputId }));
        } else {
          const result = validateSemanticEnvelope(completion.result.material);
          if (result.kind === "rejected") diagnose(result.diagnostic);
          else if (route?.status === "notPorted")
            diagnose(boundDiagnosticDetails({ level: "INFO", component: "shared-runtime", reason: "routeNotPorted",
              unit: route.candidate, inputId: completion.inputId }));
          else if (route?.status === "unlisted")
            diagnose(boundDiagnosticDetails({ level: "WARN", component: "shared-runtime", reason: "routeUnlisted", inputId: completion.inputId }));
        }
        if (draining) {
          applyDeadlines(runtimeUnits.filter((owner) => owner !== unit));
          selectDelivery();
        }
      }
    } else {
      const { control } = input.completion;
      if (control.kind === "checkpointResult" && isRuntimeUnit(control.result.unit)) {
        const unit = control.result.unit;
        const { result } = control;
        const previous = next.units[unit].persistence;
        const attempt = next.checkpointAttempts[unit];
        if (previous != null && attempt != null && attempt.attemptId === result.attemptId
          && attempt.unit === result.unit && attempt.generation === result.generation
          && result.generation > (previous.savedGeneration ?? 0)
          && result.generation <= previous.currentGeneration) {
          const progress = {
            currentGeneration: previous.currentGeneration, savedGeneration: previous.savedGeneration,
            savedCapturedAt: previous.savedCapturedAt, savedAckAt: previous.savedAckAt, dirtySince: previous.dirtySince,
          };
          if (result.kind === "acknowledged") {
            const saved = previous.currentGeneration === result.generation;
            if (!saved && attempt.postCaptureDirtySince == null)
              throw new Error("checkpoint capture was not ordered before durable updates");
            setPersistence(unit, { ...progress, kind: saved ? "saved" : "pending",
              savedGeneration: result.generation, savedCapturedAt: attempt.capturedAt, savedAckAt: result.ackAt,
              dirtySince: saved ? null : attempt.postCaptureDirtySince });
          } else if (result.kind === "failed") {
            setPersistence(unit, { ...progress, kind: "failed", stage: result.stage, reason: boundedString(result.reason) });
          } else if (previous.kind !== "uncertain" || previous.attemptedGeneration !== result.generation) {
            setPersistence(unit, { ...progress, kind: "uncertain", attemptedGeneration: result.generation });
          }
          if (result.kind !== "uncertain") {
            const attempts = { ...next.checkpointAttempts };
            delete attempts[unit];
            next = { ...next, checkpointAttempts: attempts };
          }
        }
      } else if (control.kind === "deadline") {
        applyDeadlines();
        reclaimExpired();
        selectDelivery();
      } else if (control.kind === "shutdownRequested" && next.shutdown.stage === "running") {
        if (!Number.isSafeInteger(control.acceptedThroughSequence) || control.acceptedThroughSequence < 0)
          throw new RangeError("invalid shutdown input boundary");
        const start = input.clock;
        next = { ...next, shutdown: { stage: "mailboxDrain", startedAt: { ...start },
          acceptedThroughSequence: control.acceptedThroughSequence, finalizationAt: null, stageResults: {},
          deadlines: { overallMonotonicMs: start.monotonicMs + 30_000, mailboxDrainMonotonicMs: start.monotonicMs + 10_000,
            sideEffectFinalizationMonotonicMs: null, finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } } };
        effects = [{ kind: "stopInputAndDrainMailbox", acceptedThroughSequence: control.acceptedThroughSequence,
          deadlineMonotonicMs: start.monotonicMs + 10_000 }];
        const channels = { ...next.notificationChannels };
        for (const name of ["desktop", "sound"] as const) {
          const channel = channels[name];
          if (channel.kind === "running") {
            channels[name] = { kind: "stopping", attempt: channel.attempt, cause: "shutdown",
              stopByMonotonicMs: start.monotonicMs + 1_000 };
            abortRequests = [...abortRequests, { attemptId: channel.attempt.attemptId, cause: "shutdown" }];
          }
        }
        if (abortRequests.length !== 0) next = { ...next, notificationChannels: channels };
        diagnose({ level: "INFO", component: "shutdown", reason: "shutdownStarted" });
      }
    }
  } else if (input.kind === "notificationResult" && next.shutdown.finalizationAt == null) {
    reclaimExpired();
    const channel = next.notificationChannels[input.result.channel];
    const attemptId = channel.kind === "running" || channel.kind === "stopping" ? channel.attempt.attemptId
      : channel.kind === "isolated" ? channel.attemptId : null;
    if (attemptId === input.result.attemptId && (channel.kind === "isolated"
      || (channel.kind === "running" || channel.kind === "stopping") && channel.attempt.intentId === input.result.intentId)) {
      if (calls.applyNotificationResult == null) throw new Error("A7 result reducer is not linked");
      const before = deliveryState();
      adoptDelivery(before, calls.applyNotificationResult(before, input.result, input.result.completedAt), input.result);
      selectDelivery();
    }
  } else if (input.kind === "shutdownStageResult" && input.stage === next.shutdown.stage
    && next.shutdown.stageResults[input.stage] == null) {
    for (const value of [...Object.values(input.pending), ...Object.values(input.droppedDiagnostics)])
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("shutdown counts must be nonnegative safe integers");
    const { stage } = input;
    const pending = { ...input.pending };
    if (stage === "finalCheckpoint") pending.unsavedUnits = Math.max(pending.unsavedUnits, unsavedUnits().length);
    const observation = { result: input.result.kind === "failed"
      ? { kind: "failed" as const, reason: boundedString(input.result.reason) } : { ...input.result },
      pending, clock: { ...input.clock }, droppedDiagnostics: { ...input.droppedDiagnostics } };
    next = { ...next, shutdown: { ...next.shutdown, stageResults: { ...next.shutdown.stageResults, [stage]: observation } } };
    if (stage === "workerClose") {
      next = { ...next, shutdown: { ...next.shutdown, stage: "completed" } };
      summary = shutdownSummary(next, input.clock);
    } else {
      if (stage === "mailboxDrain") {
        for (const unit of runtimeUnits) reduceUnit(unit, { kind: "shutdown", clock: input.clock });
      } else if (stage === "sideEffectFinalization") {
        applyDeadlines();
        next = { ...next, shutdown: { ...next.shutdown, finalizationAt: input.clock.wallTimeMs } };
      }
      const nextStage: ShutdownStage = stage === "mailboxDrain" ? "sideEffectFinalization"
        : stage === "sideEffectFinalization" ? "finalCheckpoint" : "workerClose";
      const deadline = Math.min(input.clock.monotonicMs + (nextStage === "finalCheckpoint" ? 10_000 : 5_000),
        next.shutdown.deadlines.overallMonotonicMs!);
      next = { ...next, shutdown: { ...next.shutdown, stage: nextStage,
        deadlines: { ...next.shutdown.deadlines, [nextStage + "MonotonicMs"]: deadline } } };
      if (nextStage === "sideEffectFinalization") {
        const channels = { ...next.notificationChannels };
        let shortened = false;
        for (const name of ["desktop", "sound"] as const) {
          const channel = channels[name];
          if (channel.kind === "stopping" && channel.cause === "shutdown" && channel.stopByMonotonicMs > deadline) {
            channels[name] = { ...channel, stopByMonotonicMs: deadline };
            shortened = true;
          }
        }
        if (shortened) next = { ...next, notificationChannels: channels };
      }
      effects = nextStage === "sideEffectFinalization" ? [{ kind: "finalizeNotificationDelivery", deadlineMonotonicMs: deadline }]
        : nextStage === "finalCheckpoint" ? [{ kind: "startFinalCheckpoints", units: unsavedUnits(), deadlineMonotonicMs: deadline }]
          : [{ kind: "closeRuntimeWorkers", deadlineMonotonicMs: deadline, summary: shutdownSummary(next, input.clock) }];
      if (stage === "finalCheckpoint" && pending.unsavedUnits > 0)
        diagnose({ level: "ERROR", component: "shutdown", reason: "shutdownUnsavedUnits", count: pending.unsavedUnits });
    }
  }

  displayChanges.push(...maskChanges(state, next, displayChanges, calls.units));
  let confirmation = retireConfirmation(next.confirmation, calls.units, displayChanges, next.units["U-E"]);
  confirmation = updateScopes(confirmation, calls.units, addedScopes(displayChanges), null);
  if (input.kind === "mailboxCompleted" && input.completion.kind === "parser"
    && input.completion.inputSequence > confirmation.afterInputSequence)
    confirmation = applyConfirmationEvidence(confirmation, calls.units, confirmationEvidence, input.clock.wallTimeMs);
  if (confirmation !== next.confirmation) next = { ...next, confirmation };
  const views = viewUnits.size === 0 ? EMPTY : [...viewUnits].map((unit) => {
    next = { ...next, views: projectViews(next, calls, [unit]) };
    return next.views[unit];
  });
  return { state: next, changedUnits, generationInputIds, checkpointRequests: EMPTY, notificationAttempts, abortRequests,
    effects, shutdownSummary: summary, outcomes, views, admissionCounts: admissionCounts(next.admission),
    displayChanges, diagnostics };
}

export { reduceRuntime, validateSemanticEnvelope };
