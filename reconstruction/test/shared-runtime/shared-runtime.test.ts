import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedMaterial, Operation, ParserMailboxResult } from "../../contracts/p1-parser-boundary.types";
import type {
  CheckpointResult,
  DiagnosticDetails,
  MailboxControl,
  RuntimeInput,
  RuntimeState,
  PersistenceStatus,
  ClockReading,
  NotificationIntent,
  NotificationResult,
  RuntimeUnitId,
  ShutdownStageResult,
  ShutdownPendingCounts,
} from "../../contracts/p2-shared-runtime.types";
import type { EewInput, EewUnitState } from "../../contracts/p2-eew-unit.types";
import type { WeatherCurrentInput, WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherTimeseriesInput, WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { boundDiagnosticDetails, completeDiagnostic } from "../../src/runtime/runtime-diagnostic";
import { reduceRuntime, validateSemanticEnvelope } from "../../src/runtime/shared-runtime";

const clock = { wallTimeMs: 1_780_650_000_001, monotonicMs: 12 } as const;
const savedProgress: PersistenceStatus = Object.freeze({ kind: "saved", currentGeneration: 1, savedGeneration: 1,
  savedCapturedAt: 10, savedAckAt: 20, dirtySince: null });

function initialState(progress: PersistenceStatus = savedProgress): RuntimeState {
  return {
    runId: "run",
    units: {
      "U-E": { schemaVersion: "p2-eew-unit-v1", current: [], gates: [], intents: [], deliveryRecords: [], persistence: progress },
      "U-W": { schemaVersion: "p2-weather-current-unit-v1", national: {}, partials: [], histories: [], ownership: {},
        tombstones: [], freshness: [], unavailable: [], intents: [], persistence: progress },
      "U-F": { schemaVersion: "p2-weather-timeseries-unit-v1", subjects: [], gates: [], intents: [], persistence: progress },
    },
    checkpointAttempts: {}, deadlines: { "U-E": null, "U-W": null, "U-F": null },
    notificationChannels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
    shutdown: { stage: "running", acceptedThroughSequence: null, startedAt: null, finalizationAt: null, stageResults: {},
      deadlines: { overallMonotonicMs: null, mailboxDrainMonotonicMs: null, sideEffectFinalizationMonotonicMs: null,
        finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } },
  };
}
const state = initialState();

function parserInput(result: ParserMailboxResult, runId = "run"): RuntimeInput {
  return {
    kind: "mailboxCompleted",
    clock,
    completion: {
      kind: "parser",
      messageId: "message",
      runId,
      encodedByteLength: 1,
      startedMonotonicMs: 1,
      completedMonotonicMs: 2,
      inputId: result.kind === "decoded" ? result.material.inputId : result.diagnostic.inputId,
      inputSequence: 1,
      result,
    },
  };
}

function fixture(path: string, headType: string): DecodedMaterial {
  const inputId = path;
  const entered = ingestXmlData({
    kind: "replay",
    inputId,
    inputSequence: 1,
    receivedAt: clock.wallTimeMs,
    origin: "replay",
    headType,
    body: readFileSync(path),
  });
  if (entered.kind !== "accepted") throw new Error(`ingress rejected ${path}`);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(`decode rejected ${path}`);
  return decoded.material;
}

const valid = fixture("test/fixtures/telegram-foundation/phase7_5_VXSE51_20260728162718_059a2b392646.xml", "VXSE51");


function controlInput(control: MailboxControl): RuntimeInput {
  return { kind: "mailboxCompleted", clock: control.clock, completion: {
    kind: "control", messageId: "control", runId: "run", encodedByteLength: 0,
    startedMonotonicMs: 1, completedMonotonicMs: 2, control,
  } };
}

function savedState(inspect: () => void) {
  const initial = initialState();
  const unit = Object.freeze({
    ...initial.units["U-E"],
    get current() { inspect(); return []; },
  });
  return Object.freeze({
    ...initial, units: new Proxy(Object.freeze({ ...initial.units, "U-E": unit }),
      { ownKeys(target) { inspect(); return Reflect.ownKeys(target); } }),
  });
}

const at = (ms: number): ClockReading => ({ wallTimeMs: 1_000 + ms, monotonicMs: ms });
const noPending: ShutdownPendingCounts = { mailboxPending: 0, mailboxInFlight: 0, batches: 0,
  notificationAttempts: 0, unsavedUnits: 0, workers: 0 };
const dropped = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
const runtimeUnits = ["U-E", "U-W", "U-F"] as const;
function intent(unit: RuntimeUnitId, operation: Operation = "normal"): NotificationIntent {
  return { id: unit + operation, unit, operation, subject: "same", channel: "desktop", transition: "activated",
    source: { inputId: "source", origin: "live", operation, family: "family", subject: "same",
      reportDateTimeRaw: "", serialRaw: "1", infoTypeRaw: "発表" },
    payload: {}, createdAt: 1_000, expiresAt: 5_000, nextAttemptAt: 1_000, attempts: 0,
    configRevision: "1", disposition: "pending" };
}
function attempt(notice: NotificationIntent): NotificationAttempt {
  return { attemptId: "attempt-" + notice.id, intentId: notice.id, unit: notice.unit, subject: notice.subject,
    operation: notice.operation, channel: notice.channel, priorityGroup: "other", payload: notice.payload,
    soundAsset: null, selectedAtMonotonicMs: 1, timeoutAtMonotonicMs: 2_000, expiresAt: notice.expiresAt };
}

// Contract doubles only: exercise A1's call/adoption boundary, not unit meanings or A7 policy.
function unitReply<S extends EewUnitState | WeatherCurrentUnitState | WeatherTimeseriesUnitState>(
  unit: S, input: EewInput | WeatherCurrentInput | WeatherTimeseriesInput,
) {
  let state = unit;
  if (input.kind === "intentUpdate") {
    const update = input.intentUpdate;
    const original = unit.intents.find((notice) => notice.id === update.id);
    if (original != null && (original.attempts !== update.attempts || original.nextAttemptAt !== update.nextAttemptAt
      || original.disposition !== update.disposition)) {
      state = { ...unit, intents: unit.intents.map((notice) => notice === original ? { ...notice, ...update } : notice),
        persistence: { ...unit.persistence, kind: "pending", currentGeneration: unit.persistence.currentGeneration + 1,
          dirtySince: unit.persistence.dirtySince ?? input.clock.monotonicMs } };
    }
  }
  return { state, nextDeadline: null, decisions: [], intents: [], outcomes: [], diagnostics: [] };
}
const unitCalls = {
  reduceEewUnit: (unit: EewUnitState, input: EewInput) => unitReply(unit, input),
  reduceWeatherCurrentUnit: (unit: WeatherCurrentUnitState, input: WeatherCurrentInput) => unitReply(unit, input),
  reduceWeatherTimeseriesUnit: (unit: WeatherTimeseriesUnitState, input: WeatherTimeseriesInput) => unitReply(unit, input),
};
function freeze<T>(value: T): T {
  if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe("P2 shared runtime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("P2-A1-T01 acceptance / AC01: saved pre-deadline state has zero work in 1,000 ticks", () => {
    const inspect = vi.fn();
    const saved = savedState(inspect);
    const input = controlInput({ kind: "deadline", clock });
    const clone = vi.spyOn(globalThis, "structuredClone");
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    for (let index = 0; index < 1_000; index += 1) {
      const step = reduceRuntime(saved, input);
      expect(step.state).toBe(saved);
      for (const effects of [step.changedUnits, step.checkpointRequests, step.notificationAttempts, step.abortAttemptIds, step.effects,
        step.outcomes, step.views, step.diagnostics]) expect(effects).toEqual([]);
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("P2-A1-T02 contractBoundary / AC02: runtime input branches never serialize or copy business state", () => {
    const maximum = fixture("test/fixtures/15_18_01_250630_VPWS50.xml", "VPWS50");
    const inspect = vi.fn();
    const saved = savedState(inspect);
    const inputs = [
      parserInput({ kind: "decoded", material: valid }),
      parserInput({ kind: "decoded", material: { ...valid, infoTypeRaw: "取消" } }),
      parserInput({ kind: "decoded", material: maximum }),
      parserInput({ kind: "decoded", material: { ...valid, reportDateTimeRaw: "" } }),
      parserInput({ kind: "rejected", diagnostic: {
        inputId: "parser-rejected", reason: "xmlInvalid", encodedByteLength: 0,
        expandedByteLength: null, operation: { kind: "undetermined", sources: {} },
      } }),
      controlInput({ kind: "deadline", clock }),
      controlInput({ kind: "checkpointResult", clock, result: {
        kind: "acknowledged", attemptId: "save", unit: "U-E", generation: 1,
        ackAt: clock.wallTimeMs, encodedByteLength: 100,
      } }),
      controlInput({ kind: "shutdownRequested", clock, acceptedThroughSequence: 1 }),
      { kind: "notificationResult", result: {
        kind: "timeout", stopped: false, attemptId: "notice", intentId: "intent",
        channel: "sound", completedAt: clock,
      } },
    ] satisfies RuntimeInput[];
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const steps = inputs.map((input) => reduceRuntime(saved, input));
    expect(steps.map((step) => step.diagnostics.map((entry) => entry.reason))).toEqual([
      [], [], [], ["reportDateTimeMissing"], ["xmlInvalid"], [], [], ["shutdownStarted"], [],
    ]);
    for (const [index, step] of steps.entries()) {
      const input = inputs[index];
      if (input.kind === "mailboxCompleted" && input.completion.kind === "control"
        && input.completion.control.kind === "shutdownRequested") {
        expect(step.state.shutdown.stage).toBe("mailboxDrain");
        expect(step.state.units).toBe(saved.units);
      } else expect(step.state).toBe(saved);
      expect(step.checkpointRequests).toEqual([]);
      expect(step.views).toEqual([]);
    }
    // Diagnostic string byte accounting is allowed; state serialization is not.
    expect(stringify.mock.calls.every(([value]) => typeof value === "string")).toBe(true);
    expect(inspect).not.toHaveBeenCalled(); // Business-state traversal is forbidden; root copies are unrestricted.
    expect(parse).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it("P2-A1-T03 corpusHistory / AC03: O02:8 and O02:10 reject in fixed priority without state change", () => {
    const inspect = vi.fn();
    const saved = savedState(inspect);
    const headMissing = fixture("test/fixtures/81_05_01_260605_VPWP50_head_missing.xml", "VPWP50");
    const invalidDate = fixture("test/fixtures/telegram-foundation/invalid-report-datetime.xml", "VXSE51");
    expect(validateSemanticEnvelope(headMissing)).toMatchObject({ kind: "rejected", reason: "headMissing" });
    expect(validateSemanticEnvelope(invalidDate)).toMatchObject({ kind: "rejected", reason: "reportDateTimeInvalid" });
    expect(validateSemanticEnvelope({ ...valid, reportDateTimeRaw: "2026-02-30T00:00:00+09:00" })).toMatchObject({ kind: "rejected", reason: "reportDateTimeInvalid" });
    expect(validateSemanticEnvelope({ ...headMissing, reportDateTimeRaw: "not-a-date" })).toMatchObject({ kind: "rejected", reason: "headMissing" });
    expect(validateSemanticEnvelope({ ...valid, reportDateTimeRaw: "" })).toMatchObject({ kind: "rejected", reason: "reportDateTimeMissing" });
    for (const material of [headMissing, invalidDate]) {
      const step = reduceRuntime(saved, parserInput({ kind: "decoded", material }));
      expect(step.state).toBe(saved);
      expect(step.changedUnits).toEqual([]);
      expect(step.notificationAttempts).toEqual([]);
      expect(step.diagnostics).toHaveLength(1);
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("P2-A1-T04 contractBoundary: preserves independent state references for three operations", () => {
    const initial = initialState();
    const notices = (["normal", "training", "test"] as const).map((operation) => intent("U-E", operation));
    const separated = { ...initial, units: { ...initial.units, "U-E": { ...initial.units["U-E"], intents: notices } } };
    for (const operation of ["normal", "training", "test"] as const) {
      const material = { ...valid, operation };
      expect(validateSemanticEnvelope(material)).toMatchObject({ kind: "accepted", envelope: { material: { operation } } });
      expect(reduceRuntime(separated, parserInput({ kind: "decoded", material })).state.units).toBe(separated.units);
    }
  });

  it("B1 contractBoundary: old ack retains the first post-capture monotonic dirty time across the 3s boundary", () => {
    const reading = (ms: number): ClockReading => ({ wallTimeMs: 1_800_000_000_000 + ms, monotonicMs: ms });
    const pending: PersistenceStatus = { ...savedProgress, kind: "pending", currentGeneration: 2, dirtySince: 1 };
    const initial = freeze(initialState(pending));
    const capture = { unit: "U-E" as const, attemptId: "capture", generation: 2, capturedAt: reading(2).wallTimeMs };
    let current = reduceRuntime(initial, { kind: "checkpointCaptured", capture }).state;
    expect(reduceRuntime(initial, { kind: "checkpointCaptured", capture }).state).toEqual(current);
    expect(current.checkpointAttempts["U-E"]).toEqual({ ...capture, postCaptureDirtySince: null });
    expect(reduceRuntime(current, { kind: "checkpointCaptured", capture }).state).toBe(current);
    expect(reduceRuntime(current, { kind: "checkpointCaptured", capture: { ...capture, attemptId: "overlap" } }).state).toBe(current);
    const calls = { reduceEewUnit: (unit: EewUnitState) => ({
      ...unitReply(unit, { kind: "deadline", clock: reading(5) }),
      state: { ...unit, persistence: { ...unit.persistence, kind: "pending" as const,
        currentGeneration: unit.persistence.currentGeneration + 1 } },
      nextDeadline: { wallTimeMs: null, monotonicMs: 6 },
    }) };
    current = { ...current, deadlines: { ...current.deadlines, "U-E": { wallTimeMs: reading(5).wallTimeMs, monotonicMs: null } } };
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const first = reduceRuntime(freeze(current), controlInput({ kind: "deadline", clock: reading(5) }), calls);
    current = reduceRuntime(freeze(first.state), controlInput({ kind: "deadline", clock: reading(6) }), calls).state;
    expect(current.checkpointAttempts["U-E"]?.postCaptureDirtySince).toBe(5);
    current = reduceRuntime(current, controlInput({ kind: "checkpointResult", clock: reading(7), result: {
      ...capture, kind: "uncertain", observedAt: reading(7).wallTimeMs, stage: "ack", encodedByteLength: 10,
    } })).state;
    expect(current.units["U-E"].persistence?.kind).toBe("uncertain");
    const ack: CheckpointResult = { ...capture, kind: "acknowledged", ackAt: reading(8).wallTimeMs, encodedByteLength: 10 };
    expect(reduceRuntime(current, controlInput({ kind: "checkpointResult", clock: reading(8),
      result: { ...ack, attemptId: "wrong" } })).state).toBe(current);
    expect(reduceRuntime(current, controlInput({ kind: "checkpointResult", clock: reading(8),
      result: { ...ack, generation: 3 } })).state).toBe(current);
    const step = reduceRuntime(freeze(current), controlInput({ kind: "checkpointResult", clock: reading(8), result: ack }));
    expect(step.state.units["U-E"].persistence).toEqual({ kind: "pending", currentGeneration: 4, savedGeneration: 2,
      savedCapturedAt: reading(2).wallTimeMs, savedAckAt: reading(8).wallTimeMs, dirtySince: 5 });
    const dirtySince = step.state.units["U-E"].persistence!.dirtySince!;
    // A3 scheduleCheckpoint consumes this timestamp as monotonic milliseconds, not wall time.
    expect(reading(3_005).monotonicMs - dirtySince > 3_000).toBe(false);
    expect(reading(3_006).monotonicMs - dirtySince > 3_000).toBe(true);
    expect(reading(4_005).monotonicMs - dirtySince).toBe(4_000);
    expect(step.state.checkpointAttempts["U-E"]).toBeUndefined();
    expect(step.state.units["U-E"].current).toBe(initial.units["U-E"].current);
    expect(step.state.units["U-W"]).toBe(initial.units["U-W"]);
    expect(step.state).not.toHaveProperty("persistence");
    expect(reduceRuntime(step.state, controlInput({ kind: "checkpointResult", clock: reading(4_006), result: ack })).state).toBe(step.state);
    const latest = { ...capture, attemptId: "latest", generation: 4, capturedAt: reading(4_007).wallTimeMs };
    current = reduceRuntime(step.state, { kind: "checkpointCaptured", capture: latest }).state;
    const saved = reduceRuntime(current, controlInput({ kind: "checkpointResult", clock: reading(4_008),
      result: { ...ack, ...latest, ackAt: reading(4_008).wallTimeMs } })).state;
    expect(saved.units["U-E"].persistence).toMatchObject({ kind: "saved", currentGeneration: 4, savedGeneration: 4,
      savedCapturedAt: reading(4_007).wallTimeMs, savedAckAt: reading(4_008).wallTimeMs, dirtySince: null });
    expect(stringify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it("B1 contractBoundary: uncertainty retains correlation; matched encode failure releases it without rollback", () => {
    const initial = freeze(initialState({ ...savedProgress, kind: "pending", currentGeneration: 2, dirtySince: 100 }));
    const capture = { unit: "U-F" as const, attemptId: "encode", generation: 2, capturedAt: 200 };
    const captured = reduceRuntime(initial, { kind: "checkpointCaptured", capture }).state;
    const uncertain = controlInput({ kind: "checkpointResult", clock: at(1), result: {
      ...capture, kind: "uncertain", stage: "ack", observedAt: 1001, encodedByteLength: 0,
    } });
    const held = reduceRuntime(captured, uncertain).state;
    expect(held.units["U-F"].persistence).toMatchObject({ kind: "uncertain", attemptedGeneration: 2, dirtySince: 100, savedGeneration: 1 });
    expect(held.checkpointAttempts).toBe(captured.checkpointAttempts);
    expect(reduceRuntime(held, uncertain).state).toBe(held);
    const failure = controlInput({ kind: "checkpointResult", clock: at(2), result: {
      ...capture, kind: "failed", stage: "verify", failedAt: 1002, reason: "verify rejected", encodedByteLength: 0,
    } });
    const failed = reduceRuntime(freeze(held), failure).state;
    expect(failed.units["U-F"].persistence).toEqual({ ...initial.units["U-F"].persistence, kind: "failed", stage: "verify", reason: "verify rejected" });
    expect(failed.checkpointAttempts["U-F"]).toBeUndefined();
    expect(failed.units["U-F"].subjects).toBe(initial.units["U-F"].subjects);
    expect(failed.units["U-W"]).toBe(initial.units["U-W"]);
    expect(reduceRuntime(failed, failure).state).toBe(failed);
    expect(reduceRuntime(initial, failure).state).toBe(initial);
    const retry = { ...capture, attemptId: "retry" };
    const retried = reduceRuntime(failed, { kind: "checkpointCaptured", capture: retry }).state;
    expect(retried.checkpointAttempts["U-F"]).toEqual({ ...retry, postCaptureDirtySince: null });
    const encodeFailed = reduceRuntime(retried, controlInput({ kind: "checkpointResult", clock: at(3), result: {
      ...retry, kind: "failed", stage: "encode", failedAt: 1003, reason: "encode rejected", encodedByteLength: 0,
    } })).state;
    expect(encodeFailed.units["U-F"].persistence).toMatchObject({ kind: "failed", stage: "encode", currentGeneration: 2 });
    expect(encodeFailed.checkpointAttempts["U-F"]).toBeUndefined();
  });

  it("B2 contractBoundary: either clock dispatches exactly once to each due unit and adopts its returned deadline", () => {
    const initial = initialState();
    const pending = { ...initial, deadlines: {
      "U-E": { wallTimeMs: 1010, monotonicMs: null },
      "U-W": { wallTimeMs: 9999, monotonicMs: 10 },
      "U-F": { wallTimeMs: 1011, monotonicMs: 11 },
    } };
    const eew = vi.fn((unit: EewUnitState, input: EewInput) => unitReply(unit, input));
    const outcome = { kind: "deadlineApplied" as const, subjects: [] };
    const weather = vi.fn((unit: WeatherCurrentUnitState, input: WeatherCurrentInput) => ({
      ...unitReply(unit, input), state: { ...unit }, outcomes: [outcome],
    }));
    const series = vi.fn((unit: WeatherTimeseriesUnitState, input: WeatherTimeseriesInput) => unitReply(unit, input));
    const view = { unit: "U-W" as const, semanticRevision: "revision", persistence: savedProgress, subjects: [] };
    const toView = vi.fn(() => view);
    const calls = { reduceEewUnit: eew, reduceWeatherCurrentUnit: weather, reduceWeatherTimeseriesUnit: series,
      toWeatherCurrentView: toView };
    const tick = controlInput({ kind: "deadline", clock: at(10) });
    expect(() => reduceRuntime(pending, tick)).toThrow("U-E reducer is not linked");
    const step = reduceRuntime(freeze(pending), tick, calls);
    expect(eew.mock.calls).toEqual([[initial.units["U-E"], { kind: "deadline", clock: at(10) }]]);
    expect(weather.mock.calls).toEqual([[initial.units["U-W"], { kind: "deadline", clock: at(10) }]]);
    expect(series).not.toHaveBeenCalled();
    expect(step.state.deadlines).toEqual({ ...pending.deadlines, "U-E": null, "U-W": null });
    expect(step.state.units["U-E"]).toBe(initial.units["U-E"]);
    expect(step.state.units["U-F"]).toBe(initial.units["U-F"]);
    expect(step.state.units["U-W"].freshness).toBe(initial.units["U-W"].freshness);
    expect(step.outcomes[0]).toBe(outcome);
    expect(step.views[0]).toBe(view);
    expect(toView).toHaveBeenCalledWith(step.state.units["U-W"]);
    expect(reduceRuntime(step.state, tick, calls).state).toBe(step.state);
    expect(eew).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "success", codes: [0, 0], failure: null, pendingStage: null },
    { name: "drain failure survives all later success", codes: [3, 3], failure: "mailboxDrain", pendingStage: null },
    { name: "finalization failure is 4", codes: [4, 4], failure: "sideEffectFinalization", pendingStage: null },
    { name: "save failure outranks worker failure", codes: [2, 2], failure: "finalCheckpoint", pendingStage: "workerClose" },
    { name: "worker failure", codes: [0, 4], failure: "workerClose", pendingStage: null },
    { name: "remaining batch outranks save failure", codes: [3, 3], failure: "finalCheckpoint", pendingStage: "sideEffectFinalization" },
  ] as const)("B3 acceptance: $name", ({ codes, failure, pendingStage }) => {
    const initial = freeze(initialState());
    const start = controlInput({ kind: "shutdownRequested", clock: at(0), acceptedThroughSequence: 9 });
    let step = reduceRuntime(initial, start);
    expect(step.effects).toEqual([{ kind: "stopInputAndDrainMailbox", acceptedThroughSequence: 9, deadlineMonotonicMs: 10_000 }]);
    expect(step.diagnostics[0]).toMatchObject({ reason: "shutdownStarted", runId: "run", timestamp: 1000 });
    expect(reduceRuntime(step.state, start).state).toBe(step.state);
    const names = ["mailboxDrain", "sideEffectFinalization", "finalCheckpoint", "workerClose"] as const;
    for (const [index, stage] of names.entries()) {
      const pending = { ...noPending };
      // Counts whose work belongs to a later stage must not cause premature failure.
      if (stage === "mailboxDrain") Object.assign(pending, { batches: 2, notificationAttempts: 1, unsavedUnits: 3, workers: 1 });
      if (stage === pendingStage) {
        if (stage === "sideEffectFinalization") pending.batches = 1;
        if (stage === "workerClose") pending.workers = 1;
      }
      const input: Extract<RuntimeInput, { kind: "shutdownStageResult" }> = {
        kind: "shutdownStageResult", stage, result: stage === failure ? { kind: "failed", reason: "fault" } : { kind: "completed" },
        pending, clock: at(100 + index * 100), droppedDiagnostics: { ...dropped, WARN: index },
      };
      if (index === 0) {
        expect(reduceRuntime(step.state, { ...input, stage: "workerClose" }, unitCalls).state).toBe(step.state);
        expect(() => reduceRuntime(step.state, { ...input, pending: { ...pending, batches: -1 } }, unitCalls)).toThrow(RangeError);
      }
      const previous = step.state;
      step = reduceRuntime(freeze(previous), input, unitCalls);
      expect(step.state.shutdown.stageResults[stage]?.pending).toEqual(pending);
      expect(reduceRuntime(step.state, input, unitCalls).state).toBe(step.state);
      expect(Object.keys(step.state.shutdown.stageResults)).toHaveLength(index + 1);
      if (stage === "mailboxDrain") {
        expect(step.effects).toEqual([{ kind: "finalizeNotificationDelivery", deadlineMonotonicMs: 5100 }]);
      } else if (stage === "sideEffectFinalization") {
        expect(step.state.shutdown.finalizationAt).toBe(1200);
        expect(step.effects).toEqual([{ kind: "startFinalCheckpoints", units: [], deadlineMonotonicMs: 10200 }]);
      } else if (stage === "finalCheckpoint") {
        expect(step.effects[0]).toMatchObject({ kind: "closeRuntimeWorkers", deadlineMonotonicMs: 5300,
          summary: { code: codes[0], requestedAt: 1000, finalizationAt: 1200, completedAt: 1300,
            acceptedThroughSequence: 9, droppedDiagnostics: { WARN: 2 } } });
      } else {
        expect(step.state.shutdown.stage).toBe("completed");
        expect(step.shutdownSummary).toMatchObject({ code: codes[1], completedAt: 1400, droppedDiagnostics: { WARN: 3 } });
        if (failure != null) expect(step.shutdownSummary?.reasons).toContain(failure + ":failed:fault");
      }
      if (stage !== "workerClose") expect(step.shutdownSummary).toBeNull();
    }
    expect(initial.shutdown.stage).toBe("running");
  });

  it("B3 contractBoundary: stage timeout is monotonic, bounded by overall deadline, and freezes final generations", () => {
    let state = initialState({ ...savedProgress, kind: "pending", currentGeneration: 2, dirtySince: 100 });
    state = reduceRuntime(state, { kind: "checkpointCaptured",
      capture: { unit: "U-E", attemptId: "late-ack", generation: 2, capturedAt: 500 } }).state;
    state = reduceRuntime(state, controlInput({ kind: "shutdownRequested", acceptedThroughSequence: 1, clock: at(0) })).state;
    const observe = (stage: Extract<RuntimeInput, { kind: "shutdownStageResult" }>["stage"], ms: number,
      result: ShutdownStageResult = { kind: "completed" }) => reduceRuntime(state, {
      kind: "shutdownStageResult", stage, result, pending: noPending,
      clock: { wallTimeMs: 1000 - ms, monotonicMs: ms }, droppedDiagnostics: dropped,
    }, unitCalls);
    state = observe("mailboxDrain", 10_000).state; // Equal deadline, even with wall clock moved backwards.
    expect(state.shutdown.deadlines.sideEffectFinalizationMonotonicMs).toBe(15_000);
    state = observe("sideEffectFinalization", 28_000, { kind: "deadlineExceeded" }).state;
    expect(state.shutdown.deadlines.finalCheckpointMonotonicMs).toBe(30_000);
    const tickState = { ...state, deadlines: { ...state.deadlines, "U-E": { wallTimeMs: 0, monotonicMs: 0 } } };
    expect(reduceRuntime(tickState, controlInput({ kind: "deadline", clock: at(29_000) })).state).toBe(tickState);
    const close = observe("finalCheckpoint", 29_000);
    expect(close.state.shutdown.stageResults.finalCheckpoint?.pending.unsavedUnits).toBe(3);
    state = close.state;
    state = reduceRuntime(state, controlInput({ kind: "checkpointResult", clock: at(29_001), result: {
      kind: "acknowledged", unit: "U-E", attemptId: "late-ack", generation: 2, ackAt: 1500, encodedByteLength: 1,
    } })).state;
    const done = observe("workerClose", 29_500);
    expect(done.shutdownSummary?.code).toBe(3);
    expect(done.shutdownSummary?.reasons).toEqual([
      "mailboxDrain:deadlineExceeded", "sideEffectFinalization:deadlineExceeded", "finalCheckpoint:unsavedUnits",
    ]);
    expect(done.shutdownSummary?.persistence["U-E"]?.kind).toBe("saved");
    expect(done.shutdownSummary?.persistence).toEqual({
      "U-E": done.state.units["U-E"].persistence,
      "U-W": done.state.units["U-W"].persistence,
      "U-F": done.state.units["U-F"].persistence,
    });
  });

  it("B4 contractBoundary: selection and result use each owning unit intentUpdate with atomic channel adoption", () => {
    for (const unit of runtimeUnits) {
      const initial = initialState();
      const notice = intent(unit);
      const selected = attempt(notice);
      const state = freeze({ ...initial, units: { ...initial.units, [unit]: { ...initial.units[unit], intents: [notice] } } });
      const tick = controlInput({ kind: "deadline", clock: at(1) });
      expect(() => reduceRuntime(state, tick, unitCalls)).toThrow("A7 selection is not linked");
      const selection = vi.fn((delivery: NotificationDeliveryState) => ({
        state: { channels: { ...delivery.channels, desktop: { kind: "running" as const, attempt: selected } },
          intents: delivery.intents.map((value) => ({ ...value, attempts: 1, nextAttemptAt: 2000 })) },
        attempts: [selected], abortAttemptIds: [], dirtyUnits: [unit], diagnostics: [],
      }));
      const step = reduceRuntime(state, tick, { ...unitCalls, selectNotificationAttempt: selection });
      expect(selection.mock.calls[0][0].channels).toBe(state.notificationChannels);
      expect(step.state.units[unit].intents[0]).toMatchObject({ attempts: 1, nextAttemptAt: 2000, disposition: "pending" });
      expect(step.state.units[unit].persistence).toMatchObject({ kind: "pending", currentGeneration: 2 });
      expect(step.notificationAttempts).toEqual([selected]);
      expect(step.state.notificationChannels.sound).toBe(state.notificationChannels.sound);
      for (const other of runtimeUnits.filter((candidate) => candidate !== unit)) expect(step.state.units[other]).toBe(state.units[other]);
      const result: NotificationResult = { kind: "delivered", attemptId: selected.attemptId, intentId: notice.id,
        channel: "desktop", completedAt: at(2) };
      const apply = vi.fn((delivery: Parameters<typeof selection>[0], actual: NotificationResult, reading: ClockReading) => {
        expect(actual).toBe(result);
        expect(reading).toBe(result.completedAt);
        return { state: { channels: { ...delivery.channels, desktop: { kind: "idle" as const } },
          intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" as const })) },
          dirtyUnits: [unit], diagnostics: [] };
      });
      const done = reduceRuntime(freeze(step.state), { kind: "notificationResult", result }, { ...unitCalls, applyNotificationResult: apply });
      expect(done.state.units[unit].intents[0]).toMatchObject({ disposition: "delivered", attempts: 1, expiresAt: 5000 });
      expect(done.state.units[unit].persistence?.currentGeneration).toBe(3);
      expect(done.state.notificationChannels.desktop.kind).toBe("idle");
      expect(reduceRuntime(done.state, { kind: "notificationResult", result }).state).toBe(done.state);
    }
  });

  it("B4 contractBoundary: stopped=false is preserved; invalidated and cross-operation results cannot deliver", () => {
    const initial = initialState();
    const notice = intent("U-E", "training");
    const active = attempt(notice);
    const state: RuntimeState = { ...initial,
      units: { ...initial.units, "U-E": { ...initial.units["U-E"], intents: [notice] } },
      notificationChannels: { ...initial.notificationChannels, desktop: { kind: "stopping", attempt: active, stopByMonotonicMs: 9 } } };
    const timeout: NotificationResult = { kind: "timeout", stopped: false, attemptId: active.attemptId, intentId: notice.id,
      channel: "desktop", completedAt: at(10) };
    const apply = vi.fn((delivery: { intents: readonly NotificationIntent[]; channels: RuntimeState["notificationChannels"] },
      actual: NotificationResult) => {
      expect(actual).toBe(timeout);
      return { state: { intents: delivery.intents, channels: { ...delivery.channels,
        desktop: { kind: "isolated" as const, attemptId: active.attemptId, sinceMonotonicMs: 10, reason: "stopUnconfirmed" as const } } },
        dirtyUnits: [], diagnostics: [{ level: "WARN" as const, component: "test-boundary", reason: "mailboxStalled" as const }] };
    });
    const isolated = reduceRuntime(freeze(state), { kind: "notificationResult", result: timeout }, { ...unitCalls, applyNotificationResult: apply });
    expect(isolated.state.notificationChannels.desktop.kind).toBe("isolated");
    expect(isolated.state.units).toBe(state.units);
    expect(isolated.diagnostics[0]).toMatchObject({ timestamp: 1010, runId: "run" });
    const success: NotificationResult = { kind: "delivered", attemptId: active.attemptId, intentId: notice.id,
      channel: "desktop", completedAt: at(11) };
    const late = reduceRuntime(state, { kind: "notificationResult", result: success }, {
      ...unitCalls, applyNotificationResult: (delivery) => ({ state: { ...delivery,
        intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" })) }, dirtyUnits: ["U-E"], diagnostics: [] }),
    });
    expect(late.state.units).toBe(state.units);
    const crossed = { ...state, notificationChannels: { ...state.notificationChannels,
      desktop: { kind: "running" as const, attempt: { ...active, operation: "normal" as const } } } };
    expect(reduceRuntime(crossed, { kind: "notificationResult", result: success }, {
      ...unitCalls, applyNotificationResult: (delivery) => ({ state: { ...delivery,
        intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" })) }, dirtyUnits: ["U-E"], diagnostics: [] }),
    }).state.units).toBe(state.units);
    const finalized = { ...state, shutdown: { ...state.shutdown, stage: "finalCheckpoint" as const, finalizationAt: 1000 } };
    expect(reduceRuntime(finalized, { kind: "notificationResult", result: success }).state).toBe(finalized);
  });

  it("AC05 contractBoundary: completion runId must match the fixed runtime run", () => {
    const input = parserInput({ kind: "decoded", material: { ...valid, reportDateTimeRaw: "" } }, "another-run");
    const step = reduceRuntime(state, input);
    expect(step.state).toBe(state);
    expect(step.diagnostics).toEqual([]);
  });

  it("P2-A1-T05a contractBoundary / AC05: projection strips extra fields from structurally typed variables", () => {
    const details = {
      level: "WARN", component: "parser", reason: "xmlInvalid", inputId: "input",
      unit: "U-E", generation: 1, attemptId: "attempt", durationMs: 2, count: 3,
      raw: "<Report>secret</Report>", token: "secret", timestamp: -1, runId: "forged",
      toJSON: () => { throw new Error("must not serialize caller"); },
    } satisfies DiagnosticDetails & {
      raw: string; token: string; timestamp: number; runId: string; toJSON: () => never;
    };
    const projected = {
      level: "WARN", component: "parser", reason: "xmlInvalid", inputId: "input",
      unit: "U-E", generation: 1, attemptId: "attempt", durationMs: 2, count: 3,
    };
    expect(boundDiagnosticDetails(details)).toEqual(projected);
    expect(completeDiagnostic(details, clock, "run")).toEqual({
      timestamp: clock.wallTimeMs, ...projected, runId: "run",
    });
  });

  it("P2-A1-T05b contractBoundary / AC05: all text fields fit escaped UTF-8 budget and retain identifiers", () => {
    for (const text of ["a", "地震😀", "\u0000\n\r\t\"\\", "\ud800"]) {
      const long = text.repeat(9000);
      const details = {
        level: "ERROR", component: "checkpoint", reason: "checkpointWriteFailed",
        inputId: long, attemptId: long, unit: "U-E", generation: Number.MAX_VALUE,
        durationMs: Number.MAX_VALUE, count: Number.MAX_VALUE,
      } satisfies DiagnosticDetails;
      for (const ids of [
        { component: "checkpoint", runId: "run" },
        { component: long, runId: long },
      ]) {
        const event = completeDiagnostic({ ...details, component: ids.component }, clock, ids.runId);
        expect(Buffer.byteLength(JSON.stringify(event) + "\n")).toBeLessThanOrEqual(8192);
        expect(event.level).toBe("ERROR");
        expect(event.reason).toBe("checkpointWriteFailed");
        for (const key of ["inputId", "attemptId", "component", "runId"] as const) {
          expect(event[key]).not.toBe("");
          if ((key === "component" ? ids.component : key === "runId" ? ids.runId : long).length > 900)
            expect(event[key]).toContain("[truncated:fieldLimit]");
        }
        if (ids.runId === "run") {
          expect(event.runId).toBe("run");
          expect(event.component).toBe("checkpoint");
        }
      }
      const semantic = validateSemanticEnvelope({ ...valid, inputId: long, reportDateTimeRaw: "" });
      if (semantic.kind !== "rejected") throw new Error("rejection expected");
      expect(Buffer.byteLength(JSON.stringify(semantic.diagnostic))).toBeLessThanOrEqual(8192);
      const [event] = reduceRuntime(state, parserInput({ kind: "decoded",
        material: { ...valid, inputId: long, reportDateTimeRaw: "" } }, "run")).diagnostics;
      expect(event).toMatchObject({ timestamp: clock.wallTimeMs, runId: "run", reason: "reportDateTimeMissing" });
    }
  });

  it("P2-A1-T06/T07 contractBoundary: TypeScript compiles positive and negative shared type contracts", () => {
    const result = spawnSync(process.execPath, [
      "node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--skipLibCheck",
      "--target", "ES2022", "--module", "commonjs", "--types", "node", "--esModuleInterop",
      "reconstruction/test/shared-runtime/type-contract.ts",
      "reconstruction/test/shared-runtime/shared-runtime.test.ts",
    ], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
