import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { OwnerOutput, OwnerUnitDelta } from "../../contracts/p3-execution-split.types";
import type { NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type {
  ClockReading,
  DiagnosticDetails,
  RuntimeInput,
  RuntimeConfirmation,
  ConfirmationScope,
  CurrentConfirmationEvidence,
  RuntimeDisplayChange,
  RuntimeRestoration,
  RuntimeUnitId,
  RuntimeUnitView,
  RuntimeEffect,
  PersistenceStatus,
  ShutdownState,
  ShutdownSummary,
  ShutdownStage,
  NotificationIntent,
} from "../../contracts/p2-shared-runtime.types";
import { boundedString } from "./runtime-diagnostic";
import { normalizeScopes, parseScopeToken, scopeContains } from "../domains/weather-current/weather-current";
import { runtimeUnits } from "./unit-coverage";

// Domain modules keep importing the common envelope check from here.
export { validateSemanticEnvelope } from "./owner-runtime";

// P3-EXECUTION-SPLIT-001 (C3a): the publisher's own state. Units live in their owners; the publisher keeps only the
// bounded mirror each owner reports (view, persistence, admission counts, pending intents) and the cross-unit state:
// confirmation, restoration, notification channels and deadlines, and shutdown (P3-C3A-CONFIRMATION-HOME).
type MirrorUnit = Readonly<{
  persistence: PersistenceStatus;
  admissionCounts: Readonly<Record<Operation, number>>;
  view: RuntimeUnitView;
  pendingIntents: readonly NotificationIntent[];
}>;
type RuntimeMirror = Readonly<Record<RuntimeUnitId, MirrorUnit>>;

type PublisherState = Readonly<{
  runId: string;
  mirror: RuntimeMirror;
  restoration: RuntimeRestoration;
  confirmation: RuntimeConfirmation;
  notificationChannels: NotificationDeliveryState["channels"];
  notificationProbeComplete: boolean;
  notificationDeadlines: NotificationDeliveryState["deadlines"];
  shutdown: ShutdownState;
}>;

const operations = ["normal", "training", "test"] as const;
const stages = ["mailboxDrain", "sideEffectFinalization", "finalCheckpoint", "workerClose"] as const;

// One owner delta replaces only the fields it carries; null means unchanged (P3-C3A-VIEW-REVISION).
function applyDeltas(mirror: RuntimeMirror, deltas: readonly OwnerUnitDelta[]): RuntimeMirror {
  if (deltas.length === 0) return mirror;
  const next: Record<RuntimeUnitId, MirrorUnit> = { ...mirror };
  for (const delta of deltas) {
    const previous = next[delta.unit];
    if (delta.view != null && delta.view.unit !== delta.unit) throw new Error("owner view of another unit");
    next[delta.unit] = { persistence: delta.persistence, admissionCounts: delta.admissionCounts,
      view: delta.view ?? previous.view, pendingIntents: delta.pendingIntents ?? previous.pendingIntents };
  }
  return next;
}

function isEmptyOutput(output: OwnerOutput): boolean {
  return output.units.length === 0 && output.outcomes.length === 0 && output.displayChanges.length === 0
    && output.diagnostics.length === 0 && output.confirmationEvidence.length === 0 && output.retiredEvents.length === 0;
}

// The confirmation state after one owner output. evidenceSequence: the parser input this output answers, if any;
// its evidence counts only when it arrived after the last disconnect boundary (P2-A1-CONFIRMATION).
function confirmOutput(confirmation: RuntimeConfirmation, units: UnitTable, output: OwnerOutput,
  clock: ClockReading, evidenceSequence: number | null): RuntimeConfirmation {
  let next = retireConfirmation(confirmation, units, output.displayChanges, output.retiredEvents);
  next = updateScopes(next, units, addedScopes(output.displayChanges), null);
  if (evidenceSequence != null && evidenceSequence > next.afterInputSequence)
    next = applyConfirmationEvidence(next, units, output.confirmationEvidence, clock.wallTimeMs);
  return next;
}

function verifyCoverage(confirmation: RuntimeConfirmation, units: UnitTable, runId: string,
  input: Extract<RuntimeInput, { kind: "coverageVerified" }>): RuntimeConfirmation {
  if (input.runId !== runId || input.epoch !== confirmation.epoch) return confirmation;
  for (const scope of input.scopes) {
    if (!runtimeUnits.includes(scope.unit) || !operations.includes(scope.operation)
      || scope.kind === "event" && (scope.unit !== "U-E" && scope.unit !== "U-T" || !/^\d{14}$/.test(scope.eventId))
      || scope.kind === "area" && (scope.unit !== "U-W" || !scope.subject
        || (() => { const tuple = parseScopeToken(scope.token); return tuple == null
          || scope.subject !== `${scope.operation}/${tuple[0]}/${tuple[2]}`; })())
      || scope.kind === "series" && (scope.unit !== "U-F" || !scope.subject.startsWith(`${scope.operation}/VPWP50/`)
        || scope.office !== scope.subject.slice(`${scope.operation}/VPWP50/`.length)))
      throw new RangeError("invalid verified scope");
  }
  let next = confirmation;
  const specific: Exclude<ConfirmationScope, { kind: "unit" }>[] = [];
  for (const scope of input.scopes) if (scope.kind === "unit") {
    next = updateConfirmation(next, units, scope.unit, scope.operation,
      (slot) => ({ ...slot, whole: null, counts: {}, confirmedScopeCount: 0, scopeBytes: 2,
        scopes: [], confirmedAt: input.clock.wallTimeMs }));
  } else specific.push(scope);
  if (specific.length !== 0) next = applyConfirmationEvidence(next, units,
    [{ source: "acceptedReport", scopes: specific }], input.clock.wallTimeMs);
  return next;
}

function unsavedUnits(state: PublisherState): RuntimeUnitId[] {
  return runtimeUnits.filter((unit) => {
    const status = state.mirror[unit].persistence;
    return status.kind !== "saved" || status.currentGeneration !== status.savedGeneration;
  });
}

// spec §5.9 step 1: the shutdown request starts the stages; a running attempt stops with the shutdown cause.
function requestShutdown(state: PublisherState, clock: ClockReading, acceptedThroughSequence: number) {
  if (!Number.isSafeInteger(acceptedThroughSequence) || acceptedThroughSequence < 0)
    throw new RangeError("invalid shutdown input boundary");
  let next: PublisherState = { ...state, shutdown: { stage: "mailboxDrain", startedAt: { ...clock },
    acceptedThroughSequence, finalizationAt: null, stageResults: {},
    deadlines: { overallMonotonicMs: clock.monotonicMs + 30_000, mailboxDrainMonotonicMs: clock.monotonicMs + 10_000,
      sideEffectFinalizationMonotonicMs: null, finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } } };
  const effects: RuntimeEffect[] = [{ kind: "stopInputAndDrainMailbox", acceptedThroughSequence,
    deadlineMonotonicMs: clock.monotonicMs + 10_000 }];
  const channels = { ...next.notificationChannels };
  const abortRequests: { attemptId: string; cause: "shutdown" }[] = [];
  for (const name of ["desktop", "sound"] as const) {
    const channel = channels[name];
    if (channel.kind === "running") {
      channels[name] = { kind: "stopping", attempt: channel.attempt, cause: "shutdown",
        stopByMonotonicMs: clock.monotonicMs + 1_000 };
      abortRequests.push({ attemptId: channel.attempt.attemptId, cause: "shutdown" });
    }
  }
  if (abortRequests.length !== 0) next = { ...next, notificationChannels: channels };
  const diagnostics: DiagnosticDetails[] = [{ level: "INFO", component: "shutdown", reason: "shutdownStarted" }];
  return { state: next, effects, abortRequests, diagnostics };
}

// One stage's terminal observation. finalizationAt: for sideEffectFinalization, the cutoff wall clock, or null when no
// cutoff was decided before the stage deadline (P3-C3A-FINALIZE-TIMEOUT). unfixed: units whose owner was not fixed.
function observeStage(state: PublisherState, input: Extract<RuntimeInput, { kind: "shutdownStageResult" }>,
  finalizationAt: number | null, unfixed: readonly RuntimeUnitId[]) {
  let next = state;
  let effects: readonly RuntimeEffect[] = [];
  let summary: ShutdownSummary | null = null;
  const diagnostics: DiagnosticDetails[] = [];
  if (input.stage !== next.shutdown.stage || next.shutdown.stageResults[input.stage] != null)
    return { state: next, effects, summary, diagnostics };
  for (const value of [...Object.values(input.pending), ...Object.values(input.droppedDiagnostics)])
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("shutdown counts must be nonnegative safe integers");
  const { stage } = input;
  const pending = { ...input.pending };
  const unsaved = new Set([...unsavedUnits(next), ...unfixed]);
  if (stage === "finalCheckpoint") pending.unsavedUnits = Math.max(pending.unsavedUnits, unsaved.size);
  const observation = { result: input.result.kind === "failed"
    ? { kind: "failed" as const, reason: boundedString(input.result.reason) } : { ...input.result },
    pending, clock: { ...input.clock }, droppedDiagnostics: { ...input.droppedDiagnostics } };
  next = { ...next, shutdown: { ...next.shutdown, stageResults: { ...next.shutdown.stageResults, [stage]: observation } } };
  if (stage === "workerClose") {
    next = { ...next, shutdown: { ...next.shutdown, stage: "completed" } };
    summary = shutdownSummary(next, input.clock);
    return { state: next, effects, summary, diagnostics };
  }
  if (stage === "sideEffectFinalization") next = { ...next, shutdown: { ...next.shutdown, finalizationAt } };
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
    : nextStage === "finalCheckpoint" ? [{ kind: "startFinalCheckpoints",
      units: unsavedUnits(next).filter((unit) => !unfixed.includes(unit)), deadlineMonotonicMs: deadline }]
      : [{ kind: "closeRuntimeWorkers", deadlineMonotonicMs: deadline, summary: shutdownSummary(next, input.clock) }];
  if (stage === "finalCheckpoint" && pending.unsavedUnits > 0)
    diagnostics.push({ level: "ERROR", component: "shutdown", reason: "shutdownUnsavedUnits", count: pending.unsavedUnits });
  return { state: next, effects, summary, diagnostics };
}

function validateProbe(channels: Extract<RuntimeInput, { kind: "notificationProbeCompleted" }>["channels"]): void {
  if (Object.keys(channels).length !== 2 || (["desktop", "sound"] as const).some((name) => {
    const channel = channels[name];
    return channel?.kind !== "idle" && (channel?.kind !== "unavailable" || channel.reason !== "backendMissing");
  })) throw new RangeError("invalid notification probe result");
}

function initialConfirmation(): RuntimeConfirmation {
  const slot = () => ({ whole: "startup" as const, counts: { startup: 1 }, confirmedScopeCount: 0,
    scopeBytes: 2, scopes: [], confirmedAt: null });
  const three = () => ({ normal: slot(), training: slot(), test: slot() });
  return { epoch: 0, afterInputSequence: -1,
    units: { "U-E": three(), "U-W": three(), "U-F": three(), "U-T": three(), "U-Q": three(), "U-N": three() } };
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
    // I-U-T.confirmationScope: event の scope を持つのは表示中の VTSE41 の subject だけで、観測は確認の対象にしない。
    if (value.unit === "U-T") return value.current == null || !("areas" in value.current) ? []
      : [{ unit: "U-T", operation: value.operation, kind: "event", eventId: value.current.eventId }];
    // I-U-Q.confirmationScope（P3-C7-N2）: U-Q は確認 scope を作らない。
    if (value.unit === "U-Q") return [];
    // I-U-N.confirmationScope（P3-C8-N2）: U-N も確認 scope を作らない。
    if (value.unit === "U-N") return [];
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
  retired: OwnerOutput["retiredEvents"]): RuntimeConfirmation {
  if (!changes.some((change) => change.after == null)) return confirmation;
  const groups = new Map<string, { unit: RuntimeUnitId; operation: Operation; subjects: Set<string>; events: Set<string> }>();
  for (const change of changes) if (change.after == null) {
    const key = JSON.stringify([change.unit, change.operation]);
    let group = groups.get(key);
    if (group == null) { group = { unit: change.unit, operation: change.operation,
      subjects: new Set(), events: new Set() }; groups.set(key, group); }
    group.subjects.add(change.subject);
  }
  for (const event of retired) groups.get(JSON.stringify([event.unit, event.operation]))?.events.add(event.eventId);
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

function shutdownSummary(state: PublisherState, clock: ClockReading): ShutdownSummary {
  const reasons: string[] = [];
  let code: ShutdownSummary["code"] = 0;
  const add = (reason: string, priority: 2 | 3 | 4) => {
    reasons.push(reason);
    if (code === 0 || priority === 3 || priority === 2 && code === 4) code = priority;
  };
  let latest: ShutdownState["stageResults"]["mailboxDrain"];
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
    persistence: Object.fromEntries(runtimeUnits.map((unit) => [unit, state.mirror[unit].persistence])),
    droppedDiagnostics: latest.droppedDiagnostics,
  };
}

export {
  addedScopes, applyDeltas, confirmOutput, initialConfirmation, isEmptyOutput, lostConfirmation, observeStage, requestShutdown,
  shutdownSummary, unsavedUnits, validateProbe, verifyCoverage,
};
export type { MirrorUnit, PublisherState, RuntimeMirror };
