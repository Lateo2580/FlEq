import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { EewInput, EewUnitStep, PersistedEewUnit } from "../../contracts/p2-eew-unit.types";
import type { WeatherCurrentInput, WeatherCurrentUnitStep, PersistedWeatherCurrentUnit } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherTimeseriesInput, WeatherTimeseriesUnitStep, PersistedWeatherTimeseriesUnit } from "../../contracts/p2-weather-timeseries-unit.types";
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
  AdmissionRejection,
  RuntimeUnitStates,
  RuntimeUnitId,
  RuntimeEffect,
  ShutdownSummary,
  ShutdownStage,
  NotificationResult,
  NotificationIntent,
  UnitView,
  SemanticEnvelopeResult,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { boundedString, boundDiagnosticDetails, completeDiagnostic, parserDiagnosticReasons } from "./runtime-diagnostic";
import { normalizeScopes, scopeContains } from "../domains/weather-current/weather-current";
import type { CodecMap } from "../checkpoint/checkpoint";

const EMPTY: readonly never[] = Object.freeze([]);
const units = ["U-E", "U-W", "U-F"] as const;
const admissionRecordByteCache = new WeakMap<object, number>();
// The single P2 route (order plan §6.2): headType → M01/M06/M08 → unit. Other families have no P2 unit.
const unitRoutes: ReadonlyMap<string, RuntimeUnitId> = new Map([
  ...["VXSE43", "VXSE45"].map((type) => [type, "U-E"] as const),
  ...["VPWS50", "VPWW55", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61", "VPNO50"].map((type) => [type, "U-W"] as const),
  ["VPWP50", "U-F"],
]);
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
  return unit === "U-E" || unit === "U-W" || unit === "U-F";
}

function updateAdmission(admission: RuntimeAdmission, unit: RuntimeUnitId,
  decisions: EewUnitStep["decisions"] | WeatherCurrentUnitStep["decisions"] | WeatherTimeseriesUnitStep["decisions"]): RuntimeAdmission {
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
    persistence: Object.fromEntries(units.map((unit) => [unit, state.units[unit].persistence])),
    droppedDiagnostics: latest.droppedDiagnostics,
  };
}

// These are the concrete A4/A5/A6/A7 pure calls, not implementations or a registry.
// Until delivery they must be supplied explicitly; no missing reducer is treated as success.
function reduceRuntime(
  state: RuntimeState | null,
  input: RuntimeInput,
  calls: Readonly<{
    reduceEewUnit?: (state: RuntimeUnitStates["U-E"], input: EewInput) => EewUnitStep;
    reduceWeatherCurrentUnit?: (state: RuntimeUnitStates["U-W"], input: WeatherCurrentInput) => WeatherCurrentUnitStep;
    reduceWeatherTimeseriesUnit?: (state: RuntimeUnitStates["U-F"], input: WeatherTimeseriesInput) => WeatherTimeseriesUnitStep;
    toEewView?: (state: RuntimeUnitStates["U-E"]) => UnitView;
    toWeatherCurrentView?: (state: RuntimeUnitStates["U-W"]) => UnitView;
    toWeatherTimeseriesView?: (state: RuntimeUnitStates["U-F"]) => UnitView;
    selectNotificationAttempt?: (state: NotificationDeliveryState, clock: ClockReading) => NotificationSelection;
    applyNotificationResult?: (state: NotificationDeliveryState, result: NotificationResult, clock: ClockReading) => NotificationDeliveryStep;
    codecs?: CodecMap<RuntimeUnitStates>;
  }> = {},
): RuntimeStep {
  if (input.kind === "startup") {
    if (state != null) throw new Error("runtime already started");
    if (input.runId.length === 0 || !Number.isFinite(input.clock.wallTimeMs) || !Number.isFinite(input.clock.monotonicMs)
      || Object.keys(input.restored).length !== units.length || units.some((unit) => input.restored[unit] == null))
      throw new RangeError("invalid startup input");
    const clean: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null };
    let initial: RuntimeState = {
      runId: input.runId, units: {
        "U-E": { schemaVersion: "p2-eew-unit-v1", current: [], gates: [], intents: [], deliveryRecords: [], notificationLatches: [], persistence: clean },
        "U-W": { schemaVersion: "p2-weather-current-unit-v1", national: {}, partials: [], histories: [], ownership: {},
          tombstones: [], freshness: [], unavailable: [], intents: [], persistence: clean },
        "U-F": { schemaVersion: "p2-weather-timeseries-unit-v1", subjects: [], gates: [], intents: [], persistence: clean },
      }, restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } },
      admission: {}, checkpointAttempts: {}, deadlines: { "U-E": null, "U-W": null, "U-F": null },
      notificationChannels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      notificationDeadlines: { desktop: {}, sound: {} },
      shutdown: { stage: "running", acceptedThroughSequence: null, startedAt: null, finalizationAt: null,
        stageResults: {}, deadlines: { overallMonotonicMs: null, mailboxDrainMonotonicMs: null,
          sideEffectFinalizationMonotonicMs: null, finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } },
    };
    const changedUnits: RuntimeUnitId[] = [];
    const generationInputIds: Partial<Record<RuntimeUnitId, readonly string[]>> = {};
    const outcomes: RuntimeStep["outcomes"][number][] = [];
    const diagnostics: DiagnosticEvent[] = [];
    for (const unit of units) {
      const restored = input.restored[unit];
      if (restored.kind === "empty" || restored.kind === "unavailable") {
        initial = { ...initial, restoration: { ...initial.restoration, [unit]: restored } };
        continue;
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
        continue;
      }
      const persistence: PersistenceStatus = { kind: "saved", currentGeneration: envelope.generation,
        savedGeneration: envelope.generation, savedCapturedAt: envelope.capturedAt, savedAckAt: null, dirtySince: null };
      const seeded = { ...decoded.state, persistence };
      let step: EewUnitStep | WeatherCurrentUnitStep | WeatherTimeseriesUnitStep;
      if (unit === "U-E") {
        if (calls.reduceEewUnit == null || calls.codecs?.["U-E"] == null) throw new Error("U-E restore is not linked");
        step = calls.reduceEewUnit(seeded as RuntimeUnitStates["U-E"],
          { kind: "restore", persisted: calls.codecs["U-E"].encode(seeded as RuntimeUnitStates["U-E"]) as PersistedEewUnit, clock: input.clock });
      } else if (unit === "U-W") {
        if (calls.reduceWeatherCurrentUnit == null || calls.codecs?.["U-W"] == null) throw new Error("U-W restore is not linked");
        step = calls.reduceWeatherCurrentUnit(seeded as RuntimeUnitStates["U-W"],
          { kind: "restore", persisted: calls.codecs["U-W"].encode(seeded as RuntimeUnitStates["U-W"]) as PersistedWeatherCurrentUnit, clock: input.clock });
      } else {
        if (calls.reduceWeatherTimeseriesUnit == null || calls.codecs?.["U-F"] == null) throw new Error("U-F restore is not linked");
        step = calls.reduceWeatherTimeseriesUnit(seeded as RuntimeUnitStates["U-F"],
          { kind: "restore", persisted: calls.codecs["U-F"].encode(seeded as RuntimeUnitStates["U-F"]) as PersistedWeatherTimeseriesUnit, clock: input.clock });
      }
      initial = { ...initial, units: { ...initial.units, [unit]: step.state },
        restoration: { ...initial.restoration, [unit]: { kind: "restored" } },
        deadlines: { ...initial.deadlines, [unit]: step.nextDeadline } };
      changedUnits.push(unit);
      if (step.state.persistence.currentGeneration > envelope.generation) generationInputIds[unit] = [];
      outcomes.push(...step.outcomes);
      diagnostics.push(...step.diagnostics.map((details) => completeDiagnostic(details, input.clock, input.runId)));
    }
    const selected = reduceRuntime(initial, { kind: "mailboxCompleted", clock: input.clock, completion: {
      kind: "control", messageId: "startup", runId: input.runId, encodedByteLength: 0,
      startedMonotonicMs: input.clock.monotonicMs, completedMonotonicMs: input.clock.monotonicMs,
      control: { kind: "deadline", clock: input.clock },
    } }, calls);
    return { ...selected, changedUnits: [...new Set([...changedUnits, ...selected.changedUnits])],
      generationInputIds: { ...generationInputIds, ...selected.generationInputIds },
      outcomes: [...outcomes, ...selected.outcomes], views: changedUnits.filter((unit) => !selected.changedUnits.includes(unit)).flatMap((unit) => {
        const view = unit === "U-E" ? calls.toEewView?.(initial.units["U-E"])
          : unit === "U-W" ? calls.toWeatherCurrentView?.(initial.units["U-W"])
            : calls.toWeatherTimeseriesView?.(initial.units["U-F"]);
        return view == null ? [] : [view];
      }).concat(selected.views), diagnostics: [...diagnostics, ...selected.diagnostics] };
  }
  if (state == null) throw new Error("runtime has not started");
  let next = state;
  let changedUnits: readonly UnitId[] = EMPTY;
  const generationInputIds: Partial<Record<RuntimeUnitId, readonly string[]>> = {};
  let outcomes: RuntimeStep["outcomes"] = EMPTY;
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
  const reduceUnit = (unit: RuntimeUnitId, unitInput: Extract<EewInput,
    { kind: "receive" | "deadline" | "shutdown" | "intentUpdate" }>) => {
    let step: EewUnitStep | WeatherCurrentUnitStep | WeatherTimeseriesUnitStep;
    switch (unit) {
      case "U-E":
        if (calls.reduceEewUnit == null) throw new Error("U-E reducer is not linked");
        step = calls.reduceEewUnit(next.units[unit], unitInput); break;
      case "U-W":
        if (calls.reduceWeatherCurrentUnit == null) throw new Error("U-W reducer is not linked");
        step = calls.reduceWeatherCurrentUnit(next.units[unit], unitInput); break;
      case "U-F":
        if (calls.reduceWeatherTimeseriesUnit == null) throw new Error("U-F reducer is not linked");
        step = calls.reduceWeatherTimeseriesUnit(next.units[unit], unitInput); break;
    }
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
    if (step.outcomes.length !== 0) outcomes = [...outcomes, ...step.outcomes];
    step.diagnostics.forEach(diagnose);
    return step;
  };
  const applyDeadlines = (targets: readonly RuntimeUnitId[] = units) => {
    if (clock == null || next.shutdown.finalizationAt != null) return;
    for (const unit of targets) {
      const deadline = next.deadlines[unit];
      if (deadline != null && (deadline.wallTimeMs != null && clock.wallTimeMs >= deadline.wallTimeMs
        || deadline.monotonicMs != null && clock.monotonicMs >= deadline.monotonicMs))
        reduceUnit(unit, { kind: "deadline", clock });
    }
  };
  const unsavedUnits = () => units.filter((unit) => {
    const status = next.units[unit].persistence;
    return status == null || status.kind !== "saved" || status.currentGeneration !== status.savedGeneration;
  });
  const deliveryState = (): NotificationDeliveryState => ({
    intents: units.flatMap((unit) => next.units[unit].intents.filter((intent) =>
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
    for (const candidate of output.state.intents) {
      const matches = before.intents.filter((intent) => sameIntent(intent, candidate));
      if (matches.length !== 1 || !isRuntimeUnit(candidate.unit)
        || before.intents.filter((intent) => intent.unit === candidate.unit && intent.id === candidate.id).length !== 1) continue;
      const original = matches[0];
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
      const previousGeneration = next.units[candidate.unit].persistence.currentGeneration;
      reduceUnit(candidate.unit, { kind: "intentUpdate", clock, intentUpdate: {
        id: original.id, attempts: candidate.attempts, nextAttemptAt: candidate.nextAttemptAt,
        disposition: candidate.disposition,
      } });
      if (candidate.unit === "U-E" && candidate.disposition !== "pending") {
        const adopted = next.units["U-E"];
        // At the wall deadline A4 reclaims the terminal record in the same adoption.
        const reclaimed = candidate.disposition === "expired" && clock.wallTimeMs >= original.expiresAt;
        if ((!reclaimed && !adopted.deliveryRecords.some((record) => record.intentId === original.id
          && record.disposition === candidate.disposition && record.expiresAt === original.expiresAt))
          || adopted.intents.some((intent) => sameIntent(intent, original))
          || adopted.persistence.currentGeneration <= previousGeneration)
          throw new Error("unit did not adopt the correlated intent update");
      } else {
        const adopted = next.units[candidate.unit].intents.find((intent) => intent.id === original.id);
        if (adopted?.attempts !== candidate.attempts || adopted.nextAttemptAt !== candidate.nextAttemptAt
          || adopted.disposition !== candidate.disposition)
          throw new Error("unit did not adopt the correlated intent update");
      }
    }
    const channelsChanged = (["desktop", "sound"] as const).some((name) => {
      const left = next.notificationChannels[name];
      const right = output.state.channels[name];
      if (left === right || left.kind === "idle" && right.kind === "idle") return false;
      if (left.kind === "running" && right.kind === "running") return left.attempt !== right.attempt;
      if (left.kind === "stopping" && right.kind === "stopping")
        return left.attempt !== right.attempt || left.cause !== right.cause || left.stopByMonotonicMs !== right.stopByMonotonicMs;
      if (left.kind === "isolated" && right.kind === "isolated")
        return left.attemptId !== right.attemptId || left.sinceMonotonicMs !== right.sinceMonotonicMs || left.reason !== right.reason;
      return true;
    });
    if (channelsChanged)
      next = { ...next, notificationChannels: output.state.channels };
    const ownerPending = units.flatMap((unit) => next.units[unit].intents)
      .filter((intent) => intent.disposition === "pending");
    const visible = new Set(before.intents.map((intent) => JSON.stringify([intent.unit, intent.id])));
    const adoptedDeadlines = { desktop: { ...output.state.deadlines.desktop }, sound: { ...output.state.deadlines.sound } };
    for (const channel of ["desktop", "sound"] as const) {
      const owned = new Set(ownerPending.filter((intent) => intent.channel === channel)
        .map((intent) => JSON.stringify([intent.unit, intent.id])));
      for (const key of Object.keys(adoptedDeadlines[channel])) if (!owned.has(key)) delete adoptedDeadlines[channel][key];
      for (const key of owned) if (!visible.has(key) && adoptedDeadlines[channel][key] == null) {
        const value = next.notificationDeadlines[channel][key];
        if (value != null) adoptedDeadlines[channel][key] = value;
      }
    }
    if (JSON.stringify(next.notificationDeadlines) !== JSON.stringify(adoptedDeadlines))
      next = { ...next, notificationDeadlines: adoptedDeadlines };
    output.diagnostics.forEach(diagnose);
  };

  const selectDelivery = () => {
    if (clock == null || next.shutdown.stage !== "running") return;
    const before = deliveryState();
    const ownerPending = units.flatMap((unit) => next.units[unit].intents)
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

  if (input.kind === "checkpointCaptured") {
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
        const unit = draining && completion.result.kind === "decoded" ? unitRoutes.get(completion.result.material.headType) : undefined;
        if (draining) {
          // Reclaim before admission, without starting attempts before cancellation/replacement is known.
          if (unit === "U-E" && next.deadlines[unit]?.wallTimeMs != null) applyDeadlines([unit]);
          const before: NotificationDeliveryState = { ...deliveryState(),
            intents: units.flatMap((owner) => next.units[owner].intents) };
          const expired = before.intents.filter((intent) => intent.disposition === "pending"
            && (input.clock.wallTimeMs >= intent.expiresAt
              || input.clock.monotonicMs >= (before.deadlines[intent.channel][JSON.stringify([intent.unit, intent.id])]
                ?.expiresAtMonotonicMs ?? Infinity)));
          if (expired.length !== 0) {
            const channels = { ...before.channels };
            // Fix the cause while the expired identity/deadline still exists; adoptDelivery then reclaims the map.
            for (const name of ["desktop", "sound"] as const) {
              const channel = channels[name];
              if (channel.kind === "running" && expired.some((intent) => sameIntent(intent,
                { ...channel.attempt, id: channel.attempt.intentId }))) {
                channels[name] = { kind: "stopping", attempt: channel.attempt, cause: "expired",
                  stopByMonotonicMs: input.clock.monotonicMs + 1_000 };
                abortRequests = [...abortRequests, { attemptId: channel.attempt.attemptId, cause: "expired" }];
              }
            }
            adoptDelivery(before, {
              state: { ...before, channels, intents: before.intents.map((intent) => expired.includes(intent)
                ? { ...intent, disposition: "expired" } : intent) },
              diagnostics: units.flatMap((owner) => {
                const count = expired.filter((intent) => intent.unit === owner).length;
                return count === 0 ? [] : [{ level: "INFO", component: "runtime", reason: "notificationExpired", unit: owner, count }];
              }),
            });
          }
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
        } else if (completion.result.kind !== "decoded" || completion.result.material.headType !== "VXSE44") {
          const details = completion.result.kind === "rejected"
            ? parserDiagnostic(completion.result.diagnostic.reason, completion.result.diagnostic.inputId)
            : (() => {
                const result = validateSemanticEnvelope(completion.result.material);
                return result.kind === "rejected" ? result.diagnostic : null;
              })();
          if (details != null) diagnose(details);
        }
        if (draining) {
          applyDeadlines(units.filter((owner) => owner !== unit));
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
        diagnose({ level: "INFO", component: "shutdown", reason: "shutdownStarted" });
      }
    }
  } else if (input.kind === "notificationResult" && next.shutdown.finalizationAt == null) {
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
        for (const unit of units) reduceUnit(unit, { kind: "shutdown", clock: input.clock });
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
      effects = nextStage === "sideEffectFinalization" ? [{ kind: "finalizeNotificationDelivery", deadlineMonotonicMs: deadline }]
        : nextStage === "finalCheckpoint" ? [{ kind: "startFinalCheckpoints", units: unsavedUnits(), deadlineMonotonicMs: deadline }]
          : [{ kind: "closeRuntimeWorkers", deadlineMonotonicMs: deadline, summary: shutdownSummary(next, input.clock) }];
      if (stage === "finalCheckpoint" && pending.unsavedUnits > 0)
        diagnose({ level: "ERROR", component: "shutdown", reason: "shutdownUnsavedUnits", count: pending.unsavedUnits });
    }
  }

  const views: UnitView[] = [];
  for (const unit of changedUnits) {
    const normalBlocked = next.admission[unit as RuntimeUnitId]?.normal != null;
    // Project through the unit's own view builder so dedicated current fields and counts agree.
    const eew = next.units["U-E"];
    const weather = next.units["U-W"];
    const timeseries = next.units["U-F"];
    const { normal: _normal, ...otherNational } = weather.national;
    const view = unit === "U-E" ? calls.toEewView?.(normalBlocked
      ? { ...eew, current: eew.current.filter((item) => item.operation !== "normal") } : eew)
      : unit === "U-W" ? calls.toWeatherCurrentView?.(normalBlocked
        ? { ...weather, national: otherNational, partials: weather.partials.filter((item) => item.operation !== "normal") } : weather)
        : unit === "U-F" ? calls.toWeatherTimeseriesView?.(normalBlocked
          ? { ...timeseries, subjects: timeseries.subjects.filter((item) => item.operation !== "normal") } : timeseries) : undefined;
    if (view != null) {
      views.push({ ...view,
        admission: normalBlocked ? { normal: "capacityExceeded" } : {},
        subjects: normalBlocked ? view.subjects.filter((subject) => subject.operation !== "normal") : view.subjects });
    }
  }
  return { state: next, changedUnits, generationInputIds, checkpointRequests: EMPTY, notificationAttempts, abortRequests,
    effects, shutdownSummary: summary, outcomes, views: views.length === 0 ? EMPTY : views, diagnostics };
}

export { reduceRuntime, validateSemanticEnvelope };
