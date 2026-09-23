import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
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
import type { EewInput, EewUnitState, EewUnitStep } from "../../contracts/p2-eew-unit.types";
import type { WeatherCurrentInput, WeatherCurrentUnitState, WeatherCurrentUnitStep } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherTimeseriesInput, WeatherTimeseriesSubject, WeatherTimeseriesUnitState, WeatherTimeseriesUnitStep } from "../../contracts/p2-weather-timeseries-unit.types";
import type { NotificationAttempt, NotificationDeliveryState, NotificationSelection, NotificationDeliveryStep } from "../../contracts/p2-notification-delivery.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { boundDiagnosticDetails, completeDiagnostic } from "../../src/runtime/runtime-diagnostic";
import { reduceRuntime, validateSemanticEnvelope } from "../../src/runtime/shared-runtime";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";
import { reduceWeatherCurrentUnit, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { reduceWeatherTimeseriesUnit, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";

const clock = { wallTimeMs: 1_780_650_000_001, monotonicMs: 12 } as const;
const savedProgress: PersistenceStatus = Object.freeze({ kind: "saved", currentGeneration: 1, savedGeneration: 1,
  savedCapturedAt: 10, savedAckAt: 20, dirtySince: null });

function initialState(progress: PersistenceStatus = savedProgress): RuntimeState {
  return {
    runId: "run",
    restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } },
    admission: {},
    units: {
      "U-E": { schemaVersion: "p2-eew-unit-v1", current: [], gates: [], intents: [], deliveryRecords: [], notificationLatches: [], persistence: progress },
      "U-W": { schemaVersion: "p2-weather-current-unit-v1", national: {}, partials: [], histories: [], ownership: {},
        tombstones: [], freshness: [], unavailable: [], intents: [], persistence: progress },
      "U-F": { schemaVersion: "p2-weather-timeseries-unit-v1", subjects: [], gates: [], intents: [], persistence: progress },
    },
    checkpointAttempts: {}, deadlines: { "U-E": null, "U-W": null, "U-F": null },
    notificationChannels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
    notificationDeadlines: { desktop: {}, sound: {} },
    shutdown: { stage: "running", acceptedThroughSequence: null, startedAt: null, finalizationAt: null, stageResults: {},
      deadlines: { overallMonotonicMs: null, mailboxDrainMonotonicMs: null, sideEffectFinalizationMonotonicMs: null,
        finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } },
  };
}
const state = initialState();

function parserInput(result: ParserMailboxResult, runId = "run"): Extract<RuntimeInput, { kind: "mailboxCompleted" }> {
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
function intent(unit: RuntimeUnitId, operation: Operation = "normal"): NotificationIntent & Readonly<{ payload: { domain: "earthquake-eew"; level: "warning"; title: string; body: string } }> {
  return { id: unit + operation, unit, operation, subject: "same", channel: "desktop", transition: "activated",
    source: { inputId: "source", origin: "live", operation, family: "family", subject: "same",
      reportDateTimeRaw: "", serialRaw: "1", infoTypeRaw: "発表" },
    payload: { domain: "earthquake-eew", level: "warning", title: "EEW", body: "EEW" }, createdAt: 1_000, expiresAt: 5_000, nextAttemptAt: 1_000, attempts: 0,
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
    for (const update of "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate) {
      const original = state.intents.find((notice) => notice.id === update.id);
      if (original != null && (original.attempts !== update.attempts || original.nextAttemptAt !== update.nextAttemptAt
        || original.disposition !== update.disposition)) {
        state = { ...state, intents: state.intents.map((notice) => notice === original ? { ...notice, ...update } : notice),
          persistence: { ...state.persistence, kind: "pending", currentGeneration: state.persistence.currentGeneration + 1,
            dirtySince: state.persistence.dirtySince ?? input.clock.monotonicMs } };
      }
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
  it("P2-A1-T08 contractBoundary / AC08: startup is the only null-state input and runs once", () => {
    const startup = { kind: "startup" as const, runId: "fresh", clock,
      restored: { "U-E": { kind: "empty" as const }, "U-W": { kind: "empty" as const },
        "U-F": { kind: "unavailable" as const, reason: "unknownSchema" as const } } };
    expect(() => reduceRuntime(null, parserInput({ kind: "decoded", material: {
      headType: "VXSE43", inputId: "early" } as DecodedMaterial })))
      .toThrow("runtime has not started");
    const started = reduceRuntime(null, startup);
    expect(started.state).toMatchObject({ runId: "fresh", restoration: startup.restored,
      admission: {}, units: { "U-E": { persistence: { currentGeneration: 0 } } } });
    expect(started.generationInputIds).toEqual({});
    expect(() => reduceRuntime(started.state, startup)).toThrow("runtime already started");
  });

  it("P2-A1-T09 contractBoundary / AC09-10: only a newer established current clears a bounded rejection", () => {
    const calls = {
      reduceEewUnit: (unit: EewUnitState, input: EewInput): EewUnitStep => {
        const evidence = { family: "VXSE43", reportDateTimeMs: input.kind === "receive"
          ? input.material.inputId === "new" ? 13 : input.material.inputId === "old" ? 11 : 12 : 12,
          affectedScope: "subject" as const };
        const decisions: EewUnitStep["decisions"] = input.kind !== "receive" ? []
          : input.material.inputId === "reject" ? [{ subject: "s", operation: "normal", decision: "capacityExceeded", rejection: evidence }]
            : [{ subject: "s", operation: "normal", decision: "changed", reason: null,
              change: "semantic", currentEstablished: evidence }];
        return { state: unit, nextDeadline: null, decisions, intents: [], outcomes: [], diagnostics: [] };
      },
      toEewView: (unit: EewUnitState) => ({ unit: "U-E" as const, semanticRevision: "s",
        persistence: unit.persistence, admission: {}, subjects: [{ subject: "s", operation: "normal" as const,
          informationType: "", transition: "active", severity: null, source: null, facts: {}, changedFields: [] }] }),
    };
    const enter = (previous: RuntimeState, inputId: string) => reduceRuntime(previous,
      parserInput({ kind: "decoded", material: { headType: "VXSE43", inputId } as DecodedMaterial }), calls);
    const rejected = enter(initialState(), "reject");
    expect(rejected.state.admission["U-E"]?.normal?.records).toMatchObject([{ subject: "s", reportDateTimeMs: 12 }]);
    expect(rejected.views[0]).toMatchObject({ admission: { normal: "capacityExceeded" }, subjects: [] });
    const stale = enter(rejected.state, "old");
    expect(stale.state.admission["U-E"]?.normal?.records).toHaveLength(1);
    const cleared = enter(stale.state, "new");
    expect(cleared.state.admission["U-E"]?.normal).toBeUndefined();
    expect(cleared.views[0].subjects).toHaveLength(1);
    expect(cleared.generationInputIds).toEqual({});
  });

  it("P2-A1-T09 regression / AC09: U-F capacity stage four hides normal active in both public view paths", () => {
    const normal: WeatherTimeseriesSubject = {
      subject: "normal/VPWP50/office", operation: "normal", source: null, effective: "active",
      unavailableReason: null, lastKnown: null, affectedScope: "subject", validUntil: clock.wallTimeMs + 3_600_000,
      retainUntil: clock.wallTimeMs + 7 * 86_400_000,
      strings: ["1", "2026-06-05T00:00:00+09:00", "PT1H", "100", "area", "element"],
      attributes: [[]], values: [{ kind: "text", value: "value", raw: "value" }],
      series: [{ meteorologicalInfosPosition: 0, timeSeriesInfoPosition: 0, timeDefines: [{
        timeId: 0, dateTimeRaw: 1, durationRaw: 2, name: null, startMs: clock.wallTimeMs,
        endMs: clock.wallTimeMs + 3_600_000,
      }] }], areas: [{ code: 3, name: 4 }], locals: [], kinds: [{ status: null, dateTimeRaw: null, dateTimeType: null }],
      periods: [[0, 0, 0, 0, 0, null, 5, null, 0, 0, 0]],
    };
    const training = { ...normal, subject: "training/VPWP50/office", operation: "training" as const };
    const initial = initialState();
    const unit = { ...initial.units["U-F"], subjects: [normal, training] };
    const rejected = reduceRuntime({ ...initial, units: { ...initial.units, "U-F": unit } },
      parserInput({ kind: "decoded", material: { headType: "VPWP50", inputId: "rejected" } as DecodedMaterial }), {
        reduceWeatherTimeseriesUnit: (state): WeatherTimeseriesUnitStep => ({ state, nextDeadline: null,
          decisions: [{ subject: normal.subject, operation: "normal", decision: "capacityExceeded",
            rejection: { family: "VPWP50", reportDateTimeMs: clock.wallTimeMs, affectedScope: "subject" } }],
          intents: [], outcomes: [], diagnostics: [] }),
        toWeatherTimeseriesView: (state) => ({ unit: "U-F", semanticRevision: "old-active",
          persistence: state.persistence, admission: {}, series: state.subjects,
          subjects: state.subjects.map((item) => ({ subject: item.subject, operation: item.operation,
            informationType: "", transition: item.effective, severity: null, source: item.source,
            facts: { periodCount: item.periods.length }, changedFields: [] })) }),
      });
    expect(rejected.state.units["U-F"]).toBe(unit);
    expect(rejected.generationInputIds).toEqual({});
    expect(rejected.views[0]).toEqual(expect.objectContaining({ admission: { normal: "capacityExceeded" },
      series: [training], subjects: [expect.objectContaining({ subject: training.subject, operation: "training" })] }));
  });

  it("P2-A1-T09 contractBoundary / AC09: weather scope clears only the confirmed office and area", () => {
    const area = (office: string, code: string) => JSON.stringify(["VPWW55", "partial", office,
      "気象警報・注意報（市町村等）", code]);
    const left = area("京都地方気象台", "123");
    const right = area("京都地方気象台", "456");
    const other = area("大阪管区気象台", "123");
    const calls = { reduceWeatherCurrentUnit: (unit: WeatherCurrentUnitState,
      input: WeatherCurrentInput): WeatherCurrentUnitStep => {
      const id = input.kind === "receive" ? input.material.inputId : "";
      const decisions = id === "reject" ? [{ subject: "s", operation: "normal" as const,
        decision: "capacityExceeded" as const, rejection: { family: "VPWW55", reportDateTimeMs: 12,
          affectedScope: [left, right] } }]
        : [{ subject: "s", operation: "normal" as const, decision: "changed" as const,
          reason: null, change: "semantic" as const, currentEstablished: { family: "VPWW55",
            reportDateTimeMs: 13, affectedScope: [id === "other" ? other : id === "left" ? left : right] } }];
      return { state: unit, nextDeadline: null, decisions, intents: [], outcomes: [], diagnostics: [] };
    } };
    const enter = (state: RuntimeState, inputId: string) => reduceRuntime(state,
      parserInput({ kind: "decoded", material: { headType: "VPWW55", inputId } as DecodedMaterial }), calls).state;
    const rejected = enter(initialState(), "reject");
    expect(enter(rejected, "other").admission["U-W"]?.normal?.records[0].affectedScope).toEqual([left, right]);
    const partial = enter(rejected, "left");
    expect(partial.admission["U-W"]?.normal?.records[0].affectedScope).toEqual([right]);
    expect(enter(partial, "right").admission["U-W"]?.normal).toBeUndefined();
  });

  it("P2-A1-T09 contractBoundary / RES-04: overflow retains known records and cannot self-clear", () => {
    const records = Array.from({ length: 512 }, (_, index) => ({ subject: `s-${index}`, family: "VXSE43",
      reportDateTimeMs: 12, affectedScope: "subject" as const }));
    const initial: RuntimeState = { ...initialState(), admission: { "U-E": { normal: { records, overflow: false } } } };
    const calls = { reduceEewUnit: (unit: EewUnitState, input: EewInput): EewUnitStep => {
      const id = input.kind === "receive" ? input.material.inputId : "";
      const decisions: EewUnitStep["decisions"] = id === "overflow"
        ? [{ subject: "new", operation: "normal", decision: "capacityExceeded",
          rejection: { family: "VXSE43", reportDateTimeMs: 13, affectedScope: "subject" } }]
        : [{ subject: "s-0", operation: "normal", decision: "changed", reason: null,
          change: "semantic", currentEstablished: { family: "VXSE43", reportDateTimeMs: 14,
            affectedScope: "subject" } }];
      return { state: unit, nextDeadline: null, decisions, intents: [], outcomes: [], diagnostics: [] };
    } };
    const enter = (state: RuntimeState, inputId: string) => reduceRuntime(state,
      parserInput({ kind: "decoded", material: { headType: "VXSE43", inputId } as DecodedMaterial }), calls).state;
    const overflowed = enter(initial, "overflow");
    expect(overflowed.admission["U-E"]?.normal).toMatchObject({ overflow: true, records });
    const reduced = enter(overflowed, "clear");
    expect(reduced.admission["U-E"]?.normal).toMatchObject({ overflow: true, records: records.slice(1) });
  });
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
      for (const effects of [step.changedUnits, step.checkpointRequests, step.notificationAttempts, step.abortRequests, step.effects,
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
    // The routed VPWS50 reaches a no-op unit: this measures A1's own branches, not unit admission cost.
    const steps = inputs.map((input) => reduceRuntime(saved, input, unitCalls));
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
    // O02:8 (VPWP50) is routed to U-F, whose receive owns its runtime rejection (A6 AC01).
    for (const material of [invalidDate]) {
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
      expect(reduceRuntime(separated, { ...parserInput({ kind: "decoded", material }), clock: at(1) }, {
        selectNotificationAttempt: (delivery) => ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }),
      }).state.units).toBe(separated.units);
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
    const view = { unit: "U-W" as const, semanticRevision: "revision", persistence: savedProgress, admission: {}, subjects: [] };
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
    expect(step.views[0]).toEqual(view);
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
          intents: delivery.intents.map((value) => ({ ...value, attempts: 1, nextAttemptAt: 2000 })), deadlines: delivery.deadlines },
        attempts: [selected], abortRequests: [], diagnostics: [],
      }));
      const step = reduceRuntime(state, tick, { ...unitCalls, reduceEewUnit, selectNotificationAttempt: selection });
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
          intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" as const })), deadlines: delivery.deadlines },
          diagnostics: [] };
      });
      const done = reduceRuntime(freeze(step.state), { kind: "notificationResult", result }, {
        ...unitCalls, reduceEewUnit, applyNotificationResult: apply,
        selectNotificationAttempt: (delivery) => ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }),
      });
      if (unit === "U-E") {
        expect(done.state.units[unit].intents).toEqual([]);
        expect(done.state.units[unit].deliveryRecords).toContainEqual({ intentId: notice.id, disposition: "delivered", expiresAt: 5000 });
        const late = reduceRuntime(step.state, { kind: "notificationResult", result: {
          kind: "timeout", stopped: true, attemptId: selected.attemptId, intentId: notice.id,
          channel: "desktop", completedAt: at(4000),
        } }, {
          ...unitCalls, reduceEewUnit,
          applyNotificationResult: (delivery) => ({ state: { ...delivery,
            channels: { ...delivery.channels, desktop: { kind: "idle" } },
            intents: delivery.intents.map((value) => ({ ...value, disposition: "expired" })) }, diagnostics: [] }),
          selectNotificationAttempt: (delivery) => ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }),
        });
        expect(late.state.units[unit].intents).toEqual([]);
        expect(late.state.units[unit].deliveryRecords).toEqual([]);
        expect(late.state.units[unit].persistence.currentGeneration).toBe(3);
        expect(late.state.notificationChannels.desktop.kind).toBe("idle");
      } else expect(done.state.units[unit].intents[0]).toMatchObject({ disposition: "delivered", attempts: 1, expiresAt: 5000 });
      expect(done.state.units[unit].persistence?.currentGeneration).toBe(3);
      expect(done.state.notificationChannels.desktop.kind).toBe("idle");
      expect(reduceRuntime(done.state, { kind: "notificationResult", result }).state).toBe(done.state);
    }
  });

  it("P2-A1-T12 regression / AC11: monotonic expiry without an attempt reaches U-E terminal records", () => {
    const material = fixture("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43");
    const baseline = initialState();
    const received = reduceEewUnit(baseline.units["U-E"], { kind: "receive", material, clock: at(0) });
    const initial = { ...baseline, units: { ...baseline.units, "U-E": received.state } };
    const seeded = reduceRuntime(initial, controlInput({ kind: "deadline", clock: at(0) }), {
      ...unitCalls, reduceEewUnit,
      selectNotificationAttempt: (delivery) => ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }),
    });
    expect(Object.keys(seeded.state.notificationDeadlines.desktop)).toHaveLength(1);
    const rewound = { wallTimeMs: 900, monotonicMs: 15_001 };
    const expired = reduceRuntime(seeded.state, controlInput({ kind: "deadline", clock: rewound }), {
      ...unitCalls, reduceEewUnit,
      selectNotificationAttempt: (delivery) => ({ state: { ...delivery,
        intents: delivery.intents.map((value) => ({ ...value, disposition: "expired" as const })),
        deadlines: { desktop: {}, sound: {} } }, attempts: [], abortRequests: [], diagnostics: [] }),
    });
    expect(expired.notificationAttempts).toEqual([]);
    expect(expired.state.units["U-E"].intents).toEqual([]);
    expect(expired.state.units["U-E"].deliveryRecords).toEqual(received.intents.map((item) => ({
      intentId: item.id, disposition: "expired", expiresAt: item.expiresAt,
    })));
    expect(expired.generationInputIds).toEqual({ "U-E": [] });
  });

  it("P2-A1-T12 contractBoundary / TIME: reclaims 128 monotonic-expired intents before receiving a new event", () => {
    const initial = initialState();
    const occupied = { ...initial, units: { ...initial.units, "U-E": { ...initial.units["U-E"],
      intents: Array.from({ length: 128 }, (_, index) => ({ ...intent("U-E"), id: `occupied-${index}`, expiresAt: 16_000 })) } } };
    const seeded = reduceRuntime(occupied, controlInput({ kind: "deadline", clock: at(0) }), {
      ...unitCalls, reduceEewUnit,
      selectNotificationAttempt: (delivery) => ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }),
    });
    const selection = vi.fn((delivery: NotificationDeliveryState) => ({ state: delivery,
      attempts: [], abortRequests: [], diagnostics: [] }));
    const owner = vi.fn(reduceEewUnit);
    const material = fixture("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43");
    const received = reduceRuntime(seeded.state, { ...parserInput({ kind: "decoded", material }),
      clock: { wallTimeMs: 900, monotonicMs: 15_000 } }, { ...unitCalls, reduceEewUnit: owner, selectNotificationAttempt: selection });
    const update = owner.mock.calls[0][1];
    if (update.kind !== "intentUpdate" || "id" in update.intentUpdate) throw new Error("batch expiry expected");
    expect(update.intentUpdate).toHaveLength(128);
    expect(update.intentUpdate.every((item) => item.disposition === "expired")).toBe(true);
    expect(owner.mock.calls[1][1].kind).toBe("receive");
    expect(selection).toHaveBeenCalledTimes(1);
    expect(selection.mock.calls[0][0].intents).toHaveLength(2);
    expect(received.state.units["U-E"].intents.map((value) => value.channel)).toEqual(["desktop", "sound"]);
    expect(received.state.units["U-E"].deliveryRecords).toHaveLength(128);
    expect(received.state.units["U-E"].notificationLatches[0].firstReportNotified).toBe(true);
    expect(received.generationInputIds).toEqual({ "U-E": [material.inputId] });
  });

  it("P2-A1-T12 regression / TIME: monotonic expiry stops a running attempt with expired before reclaiming its deadline", () => {
    const select = vi.fn((delivery: NotificationDeliveryState): NotificationSelection => {
      if (delivery.channels.desktop.kind === "stopping") return { state: delivery, attempts: [], abortRequests: [], diagnostics: [] };
      const notice = delivery.intents.find((value) => value.channel === "desktop" && value.disposition === "pending");
      if (delivery.channels.desktop.kind !== "idle" || notice == null) throw new Error("expiry cause was lost before A7 selection");
      const selected = attempt(notice);
      return { state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "running", attempt: selected } },
        intents: delivery.intents.map((value) => value === notice ? { ...value, attempts: 1 } : value) },
        attempts: [selected], abortRequests: [], diagnostics: [] };
    });
    const calls = { ...unitCalls, reduceEewUnit, selectNotificationAttempt: select };
    const received = reduceRuntime(initialState(), { ...parserInput({ kind: "decoded",
      material: fixture("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43") }), clock: at(0) }, calls);
    const active = received.notificationAttempts[0];
    const key = JSON.stringify(["U-E", active.intentId]);
    expect(received.state.notificationDeadlines.desktop[key]?.expiresAtMonotonicMs).toBe(15_000);
    const expired = reduceRuntime(received.state, { ...parserInput({ kind: "decoded",
      material: fixture("test/fixtures/37_01_02_240613_VXSE43.xml", "VXSE43") }),
      clock: { wallTimeMs: 900, monotonicMs: 15_000 } }, calls);
    expect(expired.abortRequests).toEqual([{ attemptId: active.attemptId, cause: "expired" }]);
    expect(expired.state.notificationChannels.desktop).toEqual({ kind: "stopping", attempt: active,
      cause: "expired", stopByMonotonicMs: 16_000 });
    expect(expired.state.notificationDeadlines).toEqual({ desktop: {}, sound: {} });
    expect(expired.state.units["U-E"].intents).toEqual([]);
    expect(expired.state.units["U-E"].deliveryRecords.every((record) => record.disposition === "expired")).toBe(true);
    expect(expired.notificationAttempts).toEqual([]);
    expect(select.mock.calls[1][0].channels.desktop).toEqual(expired.state.notificationChannels.desktop);
    expect(select.mock.calls[1][0].deadlines).toEqual({ desktop: {}, sound: {} });
  });

  it("P2-A1-AC10 regression / R45: a non-notifying follow-up does not own terminal-record reclamation", () => {
    const initial = initialState();
    const material = fixture("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43");
    let eew = reduceEewUnit(initial.units["U-E"], { kind: "receive", material, clock: at(0) }).state;
    for (const notice of eew.intents) eew = reduceEewUnit(eew, { kind: "intentUpdate", clock: at(1),
      intentUpdate: { id: notice.id, attempts: 1, nextAttemptAt: 1_000, disposition: "delivered" } }).state;
    const before = eew.persistence.currentGeneration;
    expect(eew.deliveryRecords).toHaveLength(2);
    const state: RuntimeState = { ...initial, units: { ...initial.units, "U-E": eew },
      deadlines: { ...initial.deadlines, "U-E": { wallTimeMs: 16_000, monotonicMs: null } } };
    const continued = reduceRuntime(state, { ...parserInput({ kind: "decoded",
      material: fixture("test/fixtures/37_01_02_240613_VXSE43.xml", "VXSE43") }), clock: at(15_000) }, { ...unitCalls, reduceEewUnit });
    expect(continued.state.units["U-E"].persistence.currentGeneration).toBe(before + 1);
    expect(continued.state.units["U-E"].deliveryRecords).toEqual([]);
    expect(continued.state.units["U-E"].intents).toEqual([]);
    expect(continued.state.units["U-E"].current[0].serial).toBe(2);
    expect(continued.generationInputIds).toEqual({ "U-E": [] });
  });

  it("P2-A1-T12 contractBoundary / AC11: real receive cancellation stops the running attempt before selecting its replacement", () => {
    const select = vi.fn((delivery: NotificationDeliveryState, reading: ClockReading): NotificationSelection => {
      const channel = delivery.channels.desktop;
      if (channel.kind === "running") {
        const present = delivery.intents.some((notice) => notice.id === channel.attempt.intentId
          && notice.operation === channel.attempt.operation && notice.disposition === "pending");
        const cause = !present ? "superseded" : reading.monotonicMs >= channel.attempt.timeoutAtMonotonicMs ? "timeout" : null;
        if (cause != null) return { state: { ...delivery, channels: { ...delivery.channels,
          desktop: { kind: "stopping", attempt: channel.attempt, cause, stopByMonotonicMs: reading.monotonicMs + 1_000 } } },
          attempts: [], abortRequests: [{ attemptId: channel.attempt.attemptId, cause }], diagnostics: [] };
      }
      const notice = delivery.intents.find((value) => value.channel === "desktop" && value.disposition === "pending"
        && reading.monotonicMs >= delivery.deadlines.desktop[JSON.stringify([value.unit, value.id])]!.retryAtMonotonicMs);
      if (channel.kind !== "idle" || notice == null) return { state: delivery, attempts: [], abortRequests: [], diagnostics: [] };
      const deadline = delivery.deadlines.desktop[JSON.stringify([notice.unit, notice.id])]!;
      const selected: NotificationAttempt = { ...attempt(notice), attemptId: `${notice.id}:${notice.attempts + 1}`,
        selectedAtMonotonicMs: reading.monotonicMs,
        timeoutAtMonotonicMs: Math.min(reading.monotonicMs + 5_000, deadline.expiresAtMonotonicMs) };
      return { state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "running", attempt: selected } },
        intents: delivery.intents.map((value) => value === notice ? { ...value, attempts: value.attempts + 1 } : value) },
        attempts: [selected], abortRequests: [], diagnostics: [] };
    });
    const apply = (delivery: NotificationDeliveryState, result: NotificationResult, reading: ClockReading): NotificationDeliveryStep => {
      const channel = delivery.channels.desktop;
      if (channel.kind !== "stopping" || channel.attempt.attemptId !== result.attemptId
        || (result.kind !== "aborted" && result.kind !== "timeout") || !result.stopped) return { state: delivery, diagnostics: [] };
      const key = JSON.stringify([channel.attempt.unit, channel.attempt.intentId]);
      const retry = result.kind === "timeout";
      return { state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "idle" } },
        intents: delivery.intents.map((notice) => retry && notice.id === channel.attempt.intentId
          && notice.operation === channel.attempt.operation ? { ...notice, nextAttemptAt: reading.wallTimeMs + 1_000 } : notice),
        deadlines: retry ? { ...delivery.deadlines, desktop: { ...delivery.deadlines.desktop,
          [key]: { ...delivery.deadlines.desktop[key]!, retryAtMonotonicMs: reading.monotonicMs + 1_000 } } } : delivery.deadlines }, diagnostics: [] };
    };
    const calls = { ...unitCalls, reduceEewUnit, selectNotificationAttempt: select, applyNotificationResult: apply };
    const first = fixture("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43");
    const received = reduceRuntime(initialState(), { ...parserInput({ kind: "decoded", material: first }), clock: at(0) }, calls);
    const active = received.notificationAttempts[0];
    expect(received.notificationAttempts).toHaveLength(1);
    const key = JSON.stringify(["U-E", active.intentId]);
    const continued = reduceRuntime(received.state, { ...parserInput({ kind: "decoded",
      material: fixture("test/fixtures/37_01_02_240613_VXSE43.xml", "VXSE43") }), clock: at(1) }, calls);
    expect(continued.state.notificationDeadlines.desktop[key]).toBe(received.state.notificationDeadlines.desktop[key]);
    const cancelled = reduceRuntime(continued.state, { ...parserInput({ kind: "decoded",
      material: fixture("test/fixtures/37_01_03_240613_VXSE43.xml", "VXSE43") }), clock: at(2) }, calls);
    expect(select).toHaveBeenCalledTimes(3);
    expect(cancelled.abortRequests).toEqual([{ attemptId: active.attemptId, cause: "superseded" }]);
    expect(cancelled.notificationAttempts).toEqual([]);
    expect(cancelled.state.units["U-E"].intents.every((notice) => notice.payload.level === "cancel")).toBe(true);
    expect(cancelled.state.units["U-E"].deliveryRecords).toContainEqual({ intentId: active.intentId,
      disposition: "superseded", expiresAt: active.expiresAt });
    const stopped = reduceRuntime(cancelled.state, { kind: "notificationResult", result: { kind: "aborted", stopped: true,
      reason: "superseded", attemptId: active.attemptId, intentId: active.intentId, channel: "desktop", completedAt: at(3) } }, calls);
    const replacement = stopped.notificationAttempts[0];
    expect(stopped.notificationAttempts).toHaveLength(1);
    expect(replacement.intentId).not.toBe(active.intentId);
    const replacementKey = JSON.stringify(["U-E", replacement.intentId]);
    const expires = stopped.state.notificationDeadlines.desktop[replacementKey]!.expiresAtMonotonicMs;
    const timedOut = reduceRuntime(stopped.state, controlInput({ kind: "deadline", clock: at(5_003) }), calls);
    expect(timedOut.abortRequests).toEqual([{ attemptId: replacement.attemptId, cause: "timeout" }]);
    const retry = reduceRuntime(timedOut.state, { kind: "notificationResult", result: { kind: "timeout", stopped: true,
      attemptId: replacement.attemptId, intentId: replacement.intentId, channel: "desktop", completedAt: at(5_004) } }, calls);
    expect(retry.notificationAttempts).toEqual([]);
    expect(retry.state.notificationChannels.desktop.kind).toBe("idle");
    expect(retry.state.notificationDeadlines.desktop[replacementKey]).toEqual({ retryAtMonotonicMs: 6_004, expiresAtMonotonicMs: expires });
  });

  it("P2-A1-T12 contractBoundary / TIME: admission filtering retains the owner's monotonic deadline", () => {
    const notice = intent("U-E");
    const initial = initialState();
    const state: RuntimeState = { ...initial,
      units: { ...initial.units, "U-E": { ...initial.units["U-E"], intents: [notice] } },
      admission: { "U-E": { normal: { records: [], overflow: true } } },
    };
    const seeded = reduceRuntime(state, controlInput({ kind: "deadline", clock: at(0) }));
    const key = JSON.stringify(["U-E", notice.id]);
    const deadline = seeded.state.notificationDeadlines.desktop[key];
    expect(deadline).toEqual({ retryAtMonotonicMs: 0, expiresAtMonotonicMs: 4_000 });
    const later = reduceRuntime(seeded.state, controlInput({ kind: "deadline",
      clock: { wallTimeMs: 500, monotonicMs: 1 } }));
    expect(later.state.notificationDeadlines.desktop[key]).toBe(deadline);
    const expired = reduceRuntime(later.state, controlInput({ kind: "deadline",
      clock: { wallTimeMs: 400, monotonicMs: 4_000 } }), { ...unitCalls, reduceEewUnit });
    expect(expired.state.units["U-E"].intents).toEqual([]);
    expect(expired.state.units["U-E"].deliveryRecords).toContainEqual({
      intentId: notice.id, disposition: "expired", expiresAt: notice.expiresAt,
    });
    expect(expired.state.notificationDeadlines.desktop[key]).toBeUndefined();
    expect(expired.generationInputIds).toEqual({ "U-E": [] });
    const viaResult = reduceRuntime(later.state, { kind: "notificationResult", result: {
      kind: "failed", reason: "adapterError", attemptId: "stale", intentId: notice.id,
      channel: "desktop", completedAt: { wallTimeMs: 400, monotonicMs: 4_000 },
    } }, { ...unitCalls, reduceEewUnit });
    expect(viaResult.state.units["U-E"].intents).toEqual([]);
    expect(viaResult.state.notificationDeadlines.desktop[key]).toBeUndefined();
  });

  it("P2-A1-T12 contractBoundary / TIME: 384 pending deadlines stay stable across ordinary reevaluation", () => {
    const initial = initialState();
    const notices = (unit: RuntimeUnitId) => Array.from({ length: 128 }, (_, index) => ({
      ...intent(unit), id: `${unit}-${index}`, expiresAt: 100_000,
    }));
    const state: RuntimeState = { ...initial, units: {
      "U-E": { ...initial.units["U-E"], intents: notices("U-E") },
      "U-W": { ...initial.units["U-W"], intents: notices("U-W") },
      "U-F": { ...initial.units["U-F"], intents: notices("U-F") },
    } };
    const calls = { selectNotificationAttempt: (delivery: NotificationDeliveryState): NotificationSelection => ({
      state: delivery, attempts: [], abortRequests: [], diagnostics: [],
    }) };
    let current = reduceRuntime(state, controlInput({ kind: "deadline", clock: at(0) }), calls).state;
    expect(Object.keys(current.notificationDeadlines.desktop)).toHaveLength(384);
    const stringify = vi.spyOn(JSON, "stringify");
    for (let index = 0; index < 30; index++) {
      const step = reduceRuntime(current, controlInput({ kind: "deadline", clock: at(index + 1) }), calls);
      expect(step.state).toBe(current);
      current = step.state;
    }
    expect(stringify.mock.calls.some(([value]) => value === current.notificationDeadlines
      || value === current.notificationDeadlines.desktop)).toBe(false);
  });

  it("P2-A1-T12 contractBoundary / AC11: shutdown fixes the running abort cause and stop deadline at request", () => {
    const notice = intent("U-E");
    const active = attempt(notice);
    const initial = initialState();
    const running: RuntimeState = { ...initial, notificationChannels: { ...initial.notificationChannels,
      desktop: { kind: "running", attempt: active } } };
    const requested = reduceRuntime(running, controlInput({ kind: "shutdownRequested",
      acceptedThroughSequence: 1, clock: at(0) }));
    expect(requested.abortRequests).toEqual([{ attemptId: active.attemptId, cause: "shutdown" }]);
    expect(requested.state.notificationChannels.desktop).toEqual({ kind: "stopping", attempt: active,
      cause: "shutdown", stopByMonotonicMs: 1_000 });
    const existing: RuntimeState = { ...running, notificationChannels: { ...running.notificationChannels,
      desktop: { kind: "stopping", attempt: active, cause: "timeout", stopByMonotonicMs: 500 } } };
    const preserved = reduceRuntime(existing, controlInput({ kind: "shutdownRequested",
      acceptedThroughSequence: 1, clock: at(0) }));
    expect(preserved.abortRequests).toEqual([]);
    expect(preserved.state.notificationChannels.desktop).toBe(existing.notificationChannels.desktop);
  });

  it("P2-A1-T12 contractBoundary / TIME: 128 pending plus 4000 terminal intents expire with linear owner work", () => {
    const initial = initialState();
    const notices = (unit: "U-W" | "U-F") => {
      const base = intent(unit);
      const source = { ...base.source, family: unit === "U-W" ? "VPWS50" : "VPWP50", reportDateTimeRaw: "2026-09-23T00:00:00Z" };
      return Array.from({ length: 4_128 }, (_, index): NotificationIntent => ({ ...base, source,
        id: `${unit}-${index}`, disposition: index < 4_000 ? "delivered" : "pending" }));
    };
    const weatherPayload = weatherCurrentUnitCodec.encode({ ...initial.units["U-W"], intents: notices("U-W") });
    const seriesPayload = weatherTimeseriesUnitCodec.encode({ ...initial.units["U-F"], intents: notices("U-F") });
    const weather = weatherCurrentUnitCodec.decode(weatherPayload);
    const series = weatherTimeseriesUnitCodec.decode(seriesPayload);
    if (weather.kind !== "restored" || series.kind !== "restored") throw new Error("boundary payload must restore");
    const owner: Record<"U-W" | "U-F", { reads: number; ms: number }> = { "U-W": { reads: 0, ms: 0 }, "U-F": { reads: 0, ms: 0 } };
    for (const [unit, state] of [["U-W", weather.state], ["U-F", series.state]] as const) {
      for (const notice of state.intents) {
        const id = notice.id;
        Object.defineProperty(notice, "id", { enumerable: true, get: () => { owner[unit].reads++; return id; } });
      }
    }
    const calls = {
      selectNotificationAttempt: (delivery: NotificationDeliveryState): NotificationSelection => ({
        state: delivery, attempts: [], abortRequests: [], diagnostics: [],
      }),
      reduceWeatherCurrentUnit: (state: WeatherCurrentUnitState, input: WeatherCurrentInput) => {
        const start = performance.now();
        const step = reduceWeatherCurrentUnit(state, input);
        owner["U-W"].ms += performance.now() - start;
        return step;
      },
      reduceWeatherTimeseriesUnit: (state: WeatherTimeseriesUnitState, input: WeatherTimeseriesInput) => {
        const start = performance.now();
        const step = reduceWeatherTimeseriesUnit(state, input);
        owner["U-F"].ms += performance.now() - start;
        return step;
      },
    };
    const seeded = reduceRuntime({ ...initial, units: { ...initial.units, "U-W": weather.state, "U-F": series.state } },
      controlInput({ kind: "deadline", clock: at(0) }), calls).state;
    owner["U-W"].reads = owner["U-F"].reads = 0;
    const start = performance.now();
    const expired = reduceRuntime(seeded, controlInput({ kind: "deadline",
      clock: { wallTimeMs: 500, monotonicMs: 4_000 } }), calls);
    console.info("128 pending + 4000 terminal", { totalMs: performance.now() - start, owner });
    for (const unit of ["U-W", "U-F"] as const) {
      expect(expired.state.units[unit].intents).toHaveLength(4_128);
      expect(expired.state.units[unit].intents.slice(4_000).every((notice) => notice.disposition === "expired")).toBe(true);
      expect(expired.state.units[unit].persistence.currentGeneration).toBe(seeded.units[unit].persistence.currentGeneration + 128);
      expect(owner[unit].reads).toBeLessThan(20 * 4_128);
    }
    expect(expired.state.notificationDeadlines).toEqual({ desktop: {}, sound: {} });
    expect(expired.state.deadlines).toMatchObject({
      "U-W": { wallTimeMs: 5_000, monotonicMs: null }, "U-F": { wallTimeMs: 5_000, monotonicMs: null },
    });
    const collected = reduceRuntime(expired.state, controlInput({ kind: "deadline", clock: at(4_000) }), calls);
    expect(collected.state.units["U-W"].intents).toEqual([]);
    expect(collected.state.units["U-F"].intents).toEqual([]);
    for (const [codec, payload] of [[weatherCurrentUnitCodec, weatherPayload], [weatherTimeseriesUnitCodec, seriesPayload]] as const) {
      expect(codec.decode({ ...payload, intents: [...payload.intents, { ...payload.intents[4_000], id: "overflow" }] }).kind).toBe("invalid");
      expect(codec.decode({ ...payload, intents: [{ ...payload.intents[4_000], payload: { body: "x".repeat(131_072) } }] }).kind).toBe("invalid");
    }
  });

  it("B4 contractBoundary: stopped=false is preserved; invalidated and cross-operation results cannot deliver", () => {
    const selectNotificationAttempt = (delivery: NotificationDeliveryState) => ({ state: delivery,
      attempts: [], abortRequests: [], diagnostics: [] });
    const initial = initialState();
    const notice = intent("U-E", "training");
    const active = attempt(notice);
    const state: RuntimeState = { ...initial,
      units: { ...initial.units, "U-E": { ...initial.units["U-E"], intents: [notice] } },
      notificationChannels: { ...initial.notificationChannels, desktop: { kind: "stopping", attempt: active, cause: "timeout", stopByMonotonicMs: 9 } } };
    const timeout: NotificationResult = { kind: "timeout", stopped: false, attemptId: active.attemptId, intentId: notice.id,
      channel: "desktop", completedAt: at(10) };
    const apply = vi.fn((delivery: NotificationDeliveryState,
      actual: NotificationResult) => {
      expect(actual).toBe(timeout);
      return { state: { intents: delivery.intents, channels: { ...delivery.channels,
        desktop: { kind: "isolated" as const, attemptId: active.attemptId, sinceMonotonicMs: 10, reason: "stopUnconfirmed" as const } },
        deadlines: delivery.deadlines }, diagnostics: [{ level: "WARN" as const, component: "test-boundary", reason: "mailboxStalled" as const }] };
    });
    const isolated = reduceRuntime(freeze(state), { kind: "notificationResult", result: timeout }, { ...unitCalls, applyNotificationResult: apply, selectNotificationAttempt });
    expect(isolated.state.notificationChannels.desktop.kind).toBe("isolated");
    expect(isolated.state.units).toBe(state.units);
    expect(isolated.diagnostics[0]).toMatchObject({ timestamp: 1010, runId: "run" });
    const success: NotificationResult = { kind: "delivered", attemptId: active.attemptId, intentId: notice.id,
      channel: "desktop", completedAt: at(11) };
    const late = reduceRuntime(state, { kind: "notificationResult", result: success }, {
      ...unitCalls, selectNotificationAttempt, applyNotificationResult: (delivery) => ({ state: { ...delivery,
        intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" })) }, diagnostics: [] }),
    });
    expect(late.state.units).toBe(state.units);
    const crossed = { ...state, notificationChannels: { ...state.notificationChannels,
      desktop: { kind: "running" as const, attempt: { ...active, operation: "normal" as const } } } };
    expect(reduceRuntime(crossed, { kind: "notificationResult", result: success }, {
      ...unitCalls, selectNotificationAttempt, applyNotificationResult: (delivery) => ({ state: { ...delivery,
        intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" })) }, diagnostics: [] }),
    }).state.units).toBe(state.units);
    const normal = { ...notice, operation: "normal" as const, source: { ...notice.source, operation: "normal" as const } };
    const expiredNormal: RuntimeState = { ...initial,
      units: { ...initial.units, "U-E": { ...initial.units["U-E"], intents: [normal] } },
      notificationChannels: { ...initial.notificationChannels, desktop: { kind: "running", attempt: active } },
      notificationDeadlines: { desktop: { [JSON.stringify([normal.unit, normal.id])]: {
        retryAtMonotonicMs: 0, expiresAtMonotonicMs: 10,
      } }, sound: {} },
    };
    const crossedExpiry = reduceRuntime(expiredNormal, controlInput({ kind: "deadline", clock: at(10) }), {
      ...unitCalls, reduceEewUnit, selectNotificationAttempt,
    });
    expect(crossedExpiry.state.units["U-E"].intents).toEqual([]);
    expect(crossedExpiry.abortRequests).toEqual([]);
    expect(crossedExpiry.state.notificationChannels.desktop).toBe(expiredNormal.notificationChannels.desktop);
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
});
