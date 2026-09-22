import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { EewInput, EewUnitStep } from "../../contracts/p2-eew-unit.types";
import type { WeatherCurrentInput, WeatherCurrentUnitStep } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherTimeseriesInput, WeatherTimeseriesUnitStep } from "../../contracts/p2-weather-timeseries-unit.types";
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

const EMPTY: readonly never[] = Object.freeze([]);
const units = ["U-E", "U-W", "U-F"] as const;
// The single P2 route (order plan §6.2): headType → M01/M06/M08 → unit. Other families have no P2 unit.
const unitRoutes: ReadonlyMap<string, RuntimeUnitId> = new Map([
  ...["VXSE43", "VXSE44", "VXSE45"].map((type) => [type, "U-E"] as const),
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
  state: RuntimeState,
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
  }> = {},
): RuntimeStep {
  let next = state;
  let changedUnits: readonly UnitId[] = EMPTY;
  let outcomes: RuntimeStep["outcomes"] = EMPTY;
  let diagnostics: RuntimeStep["diagnostics"] = EMPTY;
  let effects: readonly RuntimeEffect[] = EMPTY;
  let notificationAttempts: RuntimeStep["notificationAttempts"] = EMPTY;
  let abortAttemptIds: RuntimeStep["abortAttemptIds"] = EMPTY;
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
  };
  const applyDeadlines = () => {
    if (clock == null || next.shutdown.finalizationAt != null) return;
    for (const unit of units) {
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
    intents: units.flatMap((unit) => next.units[unit].intents), channels: next.notificationChannels,
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
        if (candidate.disposition !== original.disposition) throw new Error("selection changed intent disposition");
        const channel = output.state.channels[candidate.channel];
        if ((channel.kind !== "running" && channel.kind !== "stopping")
          || !sameIntent(candidate, { ...channel.attempt, id: channel.attempt.intentId }))
          throw new Error("selection has no matching attempt");
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
      reduceUnit(candidate.unit, { kind: "intentUpdate", clock, intentUpdate: {
        id: original.id, attempts: candidate.attempts, nextAttemptAt: candidate.nextAttemptAt,
        disposition: candidate.disposition,
      } });
      const adopted = next.units[candidate.unit].intents.find((intent) => intent.id === original.id);
      if (adopted?.attempts !== candidate.attempts || adopted.nextAttemptAt !== candidate.nextAttemptAt
        || adopted.disposition !== candidate.disposition)
        throw new Error("unit did not adopt the correlated intent update");
    }
    const channelsChanged = (["desktop", "sound"] as const).some((name) => {
      const left = next.notificationChannels[name];
      const right = output.state.channels[name];
      if (left === right || left.kind === "idle" && right.kind === "idle") return false;
      if (left.kind === "running" && right.kind === "running") return left.attempt !== right.attempt;
      if (left.kind === "stopping" && right.kind === "stopping")
        return left.attempt !== right.attempt || left.stopByMonotonicMs !== right.stopByMonotonicMs;
      if (left.kind === "isolated" && right.kind === "isolated")
        return left.attemptId !== right.attemptId || left.sinceMonotonicMs !== right.sinceMonotonicMs || left.reason !== right.reason;
      return true;
    });
    if (channelsChanged)
      next = { ...next, notificationChannels: output.state.channels };
    output.diagnostics.forEach(diagnose);
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
        // Units re-run the common Head/date check themselves: one diagnostic per input, and
        // U-W keeps §7.8 freshness monitoring for rejected inputs (A1 freshnessException).
        if (unit != null && completion.result.kind === "decoded") {
          reduceUnit(unit, { kind: "receive", material: completion.result.material, clock: input.clock });
        } else {
          const details = completion.result.kind === "rejected"
            ? parserDiagnostic(completion.result.diagnostic.reason, completion.result.diagnostic.inputId)
            : (() => {
                const result = validateSemanticEnvelope(completion.result.material);
                return result.kind === "rejected" ? result.diagnostic : null;
              })();
          if (details != null) diagnose(details);
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
        if (clock != null && next.shutdown.stage === "running") {
          const before = deliveryState();
          const channelDue = Object.values(before.channels).some((channel) =>
            channel.kind === "running" && clock.monotonicMs >= channel.attempt.timeoutAtMonotonicMs
            || channel.kind === "stopping" && clock.monotonicMs >= channel.stopByMonotonicMs);
          if (channelDue || before.intents.some((intent) => intent.disposition === "pending"
            && (clock.wallTimeMs >= intent.nextAttemptAt || clock.wallTimeMs >= intent.expiresAt))) {
            if (calls.selectNotificationAttempt == null) throw new Error("A7 selection is not linked");
            const selection = calls.selectNotificationAttempt(before, clock);
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
            adoptDelivery(before, selection);
            notificationAttempts = selection.attempts;
            abortAttemptIds = selection.abortAttemptIds;
          }
        }
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
    const view = unit === "U-E" ? calls.toEewView?.(next.units["U-E"])
      : unit === "U-W" ? calls.toWeatherCurrentView?.(next.units["U-W"])
        : unit === "U-F" ? calls.toWeatherTimeseriesView?.(next.units["U-F"]) : undefined;
    if (view != null) views.push(view);
  }
  return { state: next, changedUnits, checkpointRequests: EMPTY, notificationAttempts, abortAttemptIds,
    effects, shutdownSummary: summary, outcomes, views: views.length === 0 ? EMPTY : views, diagnostics };
}

export { reduceRuntime, validateSemanticEnvelope };
