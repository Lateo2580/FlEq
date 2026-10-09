import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  RuntimeUnitDeadline,
  RuntimeUnitId,
  RuntimeUnitStates,
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
import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import {
  capturedOwner, checkpointResultOwner, deadlineOwner, receiveOwner, unitAdmissionCounts, validateSemanticEnvelope,
} from "../../src/runtime/owner-runtime";
import type { OwnerState, ParserCompletion } from "../../src/runtime/owner-runtime";
import { fixtureState, ownerFixture } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, idleChannels, manualAdapter, seeded, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { CodecMap } from "../../src/checkpoint/checkpoint";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import type { NotificationCalls, PublisherInput } from "../../src/runtime/composition-root";
import { observeStage, requestShutdown } from "../../src/runtime/shared-runtime";
import type { PublisherState } from "../../src/runtime/shared-runtime";
import { callsWith } from "../unit-table/linked-calls";
import type { StubCalls } from "../unit-table/linked-calls";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";
import { reduceWeatherCurrentUnit, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { reduceWeatherTimeseriesUnit, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";

const clock = { wallTimeMs: 1_780_650_000_001, monotonicMs: 12 } as const;
const savedProgress: PersistenceStatus = Object.freeze({ kind: "saved", currentGeneration: 1, savedGeneration: 1,
  savedCapturedAt: 10, savedAckAt: 20, dirtySince: null });

const noHistory = { dayKey: null, count: 0, maxInt: null, countedEventIds: [], recent: [] } as const;
function initialState(progress: PersistenceStatus = savedProgress): RuntimeState {
  const baseline = fixtureState({}, {}, "run");
  return {
    ...baseline,
    runId: "run",
    restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" }, "U-L": { kind: "empty" } },
    admission: {},
    notificationProbeComplete: true,
    units: {
      "U-E": { schemaVersion: "p2-eew-unit-v1", contentRevision: 0, current: [], gates: [], intents: [], deliveryRecords: [], notificationLatches: [], persistence: progress },
      "U-W": { schemaVersion: "p2-weather-current-unit-v1", contentRevision: 0, national: {}, partials: [], histories: [], ownership: {},
        tombstones: [], freshness: [], unavailable: [], intents: [], persistence: progress },
      "U-F": { schemaVersion: "p2-weather-timeseries-unit-v1", contentRevision: 0, subjects: [], gates: [], intents: [], persistence: progress },
      // U-T, U-Q, U-N, U-V and U-L stay clean here: these cases describe the three earlier units (P3-C5-AC14, P3-C7, P3-C8, P3-C9 and P3-C10
      // add their rows only).
      "U-T": { schemaVersion: "p3-tsunami-unit-v1", contentRevision: 0, forecasts: [], observations: [], intents: [], persistence: savedProgress },
      "U-Q": { schemaVersion: "p3-seismic-unit-v1", contentRevision: 0, earthquakes: [], longPeriods: [], daily: {
        normal: noHistory, training: noHistory, test: noHistory }, intents: [], persistence: savedProgress },
      "U-N": { schemaVersion: "p3-nankai-unit-v1", contentRevision: 0, currents: [], information: [], intents: [], persistence: savedProgress },
      "U-V": { schemaVersion: "p3-volcano-unit-v1", contentRevision: 0, alerts: [], eruptions: [], ashfalls: [], shortfalls: [],
        scheduledAshfalls: [], batch: null, bulletins: [], intents: [], persistence: savedProgress },
      "U-L": { schemaVersion: "p3-landslide-unit-v1", contentRevision: 0, currents: [], intents: [], persistence: savedProgress },
    },
    checkpointAttempts: {}, deadlines: { "U-E": null, "U-W": null, "U-F": null, "U-T": null, "U-Q": null, "U-N": null, "U-V": null, "U-L": null },
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

// TEST-PATH (1): owner core inputs.
const places = ["urgent", "weatherCurrent", "deferred"] as const satisfies readonly ExecutionPlace[];
const completion = (result: ParserMailboxResult, runId = "run"): ParserCompletion => ({ runId,
  inputId: result.kind === "decoded" ? result.material.inputId : result.diagnostic.inputId, result });
const units = (stubs: StubCalls = {}) => callsWith(stubs).units;

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

// routeのない入力の代表。VXSE51 は U-Q で ready になった（P3-C7）ので、notPorted のまま残る VXSE56 にする。
const valid = fixture("test/fixtures/32-35_09_01_191111_VXSE56.xml", "VXSE56");


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

// The same trap on one owner: listing its units or reading U-E's current is business-state traversal.
function savedOwner(place: ExecutionPlace, inspect: () => void): OwnerState {
  const owner = ownerFixture(place, savedState(inspect));
  return Object.freeze({ ...owner, units: new Proxy(Object.freeze({ ...owner.units }),
    { ownKeys(target) { inspect(); return Reflect.ownKeys(target); } }) });
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
  return { state, nextDeadline: null, decisions: [], intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] };
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

const temporary: string[] = [];
const roots: { diagnostics: { flush(): Promise<void> } }[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.diagnostics.flush();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 3 });
});
function config() {
  const path = mkdtempSync(join(tmpdir(), "fleq-c3a-runtime-"));
  temporary.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}
const noAttempts = (delivery: NotificationDeliveryState): NotificationSelection =>
  ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] });
const STATUS: Readonly<Record<Operation, string>> = { normal: "通常", training: "訓練", test: "試験" };
function materialOf(body: Uint8Array, headType: string, inputId: string): DecodedMaterial {
  const entered = ingestXmlData({ kind: "replay", inputId, inputSequence: 1, receivedAt: clock.wallTimeMs, origin: "replay",
    headType, body });
  if (entered.kind !== "accepted") throw new Error(`ingress rejected ${inputId}`);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(`decode rejected ${inputId}`);
  return decoded.material;
}

// TEST-PATH (2): the publisher and three in-process owners on a settable clock; attempts end when the test finishes them.
async function runtime(stubs: StubCalls = {}, start: ClockReading = clock,
  options: Readonly<{ probe?: boolean; codecs?: CodecMap<RuntimeUnitStates> }> = {}) {
  let now = start;
  const calls = callsWith(stubs);
  const seeds = seeded(calls.units);
  const notices = manualAdapter();
  const h = harnessedRoot(config(), options.codecs ?? linkedUnitCodecs, { clock: () => now, notificationAdapter: notices.adapter,
    runtimeCalls: { units: seeds.units, selectNotificationAttempt: calls.selectNotificationAttempt,
      applyNotificationResult: calls.applyNotificationResult } });
  roots.push(h.root);
  await startHarness(h, "run", now, options.probe ?? true);
  return { h, root: h.root, seeds, notices,
    at(time: ClockReading) { now = time; },
    input: (path: string, headType: string, inputId: string, at: ClockReading, sequence: number) =>
      submit(h, envelope("run", headType, inputId, readFileSync(path), at, sequence)) };
}
// The publisher's own stage machine (spec §5.9) is a pure function of its state: a fixture of the whole runtime
// becomes the publisher state with each unit's mirror.
function publisherState(whole: RuntimeState): PublisherState {
  const mirror = <K extends RuntimeUnitId>(unit: K) => ({ persistence: whole.units[unit].persistence,
    admissionCounts: { normal: 0, training: 0, test: 0 }, view: whole.views[unit],
    pendingIntents: whole.units[unit].intents.filter((item) => item.disposition === "pending") });
  return { runId: whole.runId, mirror: { "U-E": mirror("U-E"), "U-W": mirror("U-W"), "U-F": mirror("U-F"), "U-T": mirror("U-T"),
    "U-Q": mirror("U-Q"), "U-N": mirror("U-N"), "U-V": mirror("U-V"), "U-L": mirror("U-L") },
    restoration: whole.restoration, confirmation: whole.confirmation, notificationChannels: whole.notificationChannels,
    notificationProbeComplete: whole.notificationProbeComplete, notificationDeadlines: whole.notificationDeadlines,
    shutdown: whole.shutdown };
}

// Sets one unit's intents (and persistence) inside its owner.
async function seedIntents(r: Awaited<ReturnType<typeof runtime>>, unit: RuntimeUnitId, intents: readonly ReturnType<typeof intent>[],
  persistence: PersistenceStatus = savedProgress, deadline: RuntimeUnitDeadline | null = null) {
  if (unit === "U-E") await r.seeds.eew(r.h, { ...r.h.unit("U-E"), intents, persistence }, deadline);
  else if (unit === "U-W") await r.seeds.weather(r.h, { ...r.h.unit("U-W"), intents, persistence }, deadline);
  else await r.seeds.series(r.h, { ...r.h.unit("U-F"), intents, persistence }, deadline);
}
describe("P2 shared runtime", () => {
  it("P2-A1-T08 contractBoundary / AC08: startup is the only null-state input and runs once", async () => {
    // U-F has no codec here, so its restore is unavailable (unknownSchema) as in the P2 startup input.
    const h = harnessedRoot(config(), { "U-E": linkedUnitCodecs["U-E"], "U-W": linkedUnitCodecs["U-W"] }, { clock: () => clock });
    expect(() => h.root.state).toThrow("runtime has not received its initial state");
    h.root.mailbox.enqueue(envelope("fresh", "VXSE43", "early", unitBodies["U-E"].body, clock));
    h.root.pump();
    expect(h.sent).toEqual([]);
    await startHarness(h, "fresh", clock, false);
    expect(h.root.state).toMatchObject({ runId: "fresh", restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" },
      "U-F": { kind: "unavailable", reason: "unknownSchema" } },
    mirror: { "U-E": { persistence: { currentGeneration: 0 }, admissionCounts: { normal: 0, training: 0, test: 0 } } } });
    await expect(h.root.startRuntime("fresh", clock, idleChannels)).rejects.toThrow("runtime already started");
  });

  it("P2-A1-PROBE / A8-AC01 acceptance: startup publishes three views and waits for one explicit probe", async () => {
    const r = await runtime({}, clock, { probe: false });
    const started = r.root.state;
    expect(runtimeUnits.map((unit) => started.mirror[unit].view.unit)).toEqual(["U-E", "U-W", "U-F"]);
    expect(started.notificationProbeComplete).toBe(false);
    expect(Object.fromEntries(runtimeUnits.map((unit) => [unit, started.mirror[unit].admissionCounts]))).toEqual({
      "U-E": { normal: 0, training: 0, test: 0 }, "U-W": { normal: 0, training: 0, test: 0 }, "U-F": { normal: 0, training: 0, test: 0 } });
    const probe = { kind: "notificationProbeCompleted", clock,
      channels: { desktop: { kind: "idle" }, sound: { kind: "unavailable", reason: "backendMissing" } } } as const;
    r.root.dispatch(probe);
    const completed = r.root.state;
    expect(completed.notificationProbeComplete).toBe(true);
    expect(completed.notificationChannels.sound.kind).toBe("unavailable");
    expect(completed.mirror).toBe(started.mirror);
    r.root.dispatch(probe);
    expect(r.root.state).toBe(completed);
  });

  it("P2-A1-ADMISSION-COUNTS / A8-AC02 contractBoundary: 1 to 2 changes counts without rebuilding views", () => {
    const calls = { ...unitCalls, reduceEewUnit: (unit: EewUnitState, input: EewInput): EewUnitStep => ({
      ...unitReply(unit, input), decisions: input.kind !== "receive" ? [] : input.material.inputId.startsWith("clear")
        ? [{ subject: input.material.inputId === "clear0" ? "s0" : "s1", operation: "normal",
          decision: "changed", reason: null, change: "semantic",
          currentEstablished: { family: "VXSE43", reportDateTimeMs: 100, affectedScope: "subject" } }]
        : [{ subject: input.material.inputId, operation: "normal", decision: "capacityExceeded",
          rejection: { family: "VXSE43", reportDateTimeMs: 10, affectedScope: "subject" } }],
    }) };
    const enter = (state: OwnerState, id: string) => receiveOwner(state,
      completion({ kind: "decoded", material: { headType: "VXSE43", inputId: id } as DecodedMaterial }), clock, units(calls));
    const counts = (state: OwnerState, unit: RuntimeUnitId) => unitAdmissionCounts(state.admission, unit);
    const first = enter(ownerFixture("urgent", initialState()), "s0");
    const second = enter(first.state, "s1");
    expect(counts(first.state, "U-E").normal).toBe(1);
    expect(counts(second.state, "U-E").normal).toBe(2);
    // No view is rebuilt for a count-only change (the owner sends no view).
    expect(second.views).toEqual([]);
    expect(second.displayChanges).toEqual([]);
    expect(second.state.units["U-E"]?.contentRevision).toBe(first.state.units["U-E"]?.contentRevision);
    const partlyCleared = enter(second.state, "clear0");
    expect(counts(partlyCleared.state, "U-E").normal).toBe(1);
    expect(partlyCleared.views).toEqual([]);
    const cleared = enter(partlyCleared.state, "clear1");
    expect(counts(cleared.state, "U-E").normal).toBe(0);
    expect(counts(cleared.state, "U-W").normal).toBe(0);
    expect(counts(cleared.state, "U-F").normal).toBe(0);
  });

  it("P2-A1-CONFIRMATION / A8-AC11 contractBoundary: disconnect sequence excludes queued evidence", async () => {
    const r = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: noAttempts }, at(0));
    await r.input("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43", "first", at(0), 1);
    const slot = r.root.state.confirmation.units["U-E"].normal;
    expect(slot.whole).toBe("startup");
    expect(slot.confirmedScopeCount).toBe(1);
    expect(slot.scopes).toHaveLength(1);
    const firstSerial = r.h.unit("U-E").current[0].serial;
    r.at(at(1));
    r.root.dispatch({ kind: "connectionLost", clock: at(1), acceptedThroughSequence: 2 });
    expect(r.root.state.confirmation.epoch).toBe(1);
    expect(r.root.state.confirmation.units["U-E"].normal.counts.disconnected).toBe(2);
    r.at(at(2));
    await r.input("test/fixtures/37_01_02_240613_VXSE43.xml", "VXSE43", "newer", at(2), 2);
    expect(r.root.state.confirmation.units["U-E"].normal.confirmedScopeCount).toBe(0);
    expect(r.h.unit("U-E").current[0].source.inputId).toBe("newer");
    expect(r.h.unit("U-E").current[0].serial).toBeGreaterThan(firstSerial);
    const queued = r.root.state.confirmation;
    r.root.dispatch({ kind: "coverageVerified", runId: "other", epoch: 1,
      scopes: [{ unit: "U-E", operation: "normal", kind: "unit" }], clock: at(3) });
    expect(r.root.state.confirmation).toBe(queued);
    r.root.dispatch({ kind: "coverageVerified", runId: "run", epoch: 1,
      scopes: [{ unit: "U-E", operation: "normal", kind: "unit" }], clock: at(4) });
    expect(r.root.state.confirmation.units["U-E"].normal).toMatchObject({ whole: null, counts: {}, confirmedAt: 1004 });
  });

  it("P2-A1-CONFIRMATION.startup contractBoundary: a non-suspect freshness record adds no confirmation scope", async () => {
    const token = JSON.stringify(["VPWW57", "partial", "office", "all", ""]);
    const source = { inputId: "late", origin: "replay" as const, operation: "normal" as const, family: "VPWW57",
      subject: "normal/VPWW57/office", reportDateTimeRaw: "", serialRaw: "", infoTypeRaw: "発表" };
    const after = { unit: "U-W" as const, operation: "normal" as const, subject: source.subject, office: "office",
      current: null, unavailable: [], subjects: [], freshness: [{ target: { operation: "normal" as const, family: "VPWW57",
        subject: source.subject, affectedScope: [token] }, candidateSource: source, currentSource: null,
        currentSemanticRevision: null, decision: "rejected", reason: "reportDateTimeMissing", revisionOrder: "unknown" as const,
        freshnessSuspect: false, suspectedSource: null, confirmedScope: [],
        clearCondition: "sameTargetScopeAcceptedOrCoverageConfirmed" as const }] };
    const r = await runtime({ ...unitCalls, reduceWeatherCurrentUnit: (unit: WeatherCurrentUnitState, input: WeatherCurrentInput) =>
      ({ ...unitReply(unit, input), displayChanges: input.kind !== "receive" ? [] : [{ unit: "U-W" as const, operation: "normal" as const,
        subject: source.subject, before: null, after }] }) });
    const baseline = r.root.state.confirmation.units["U-W"].normal;
    await r.input("test/fixtures/15_16_02_251222_VPWW57.xml", "VPWW57", "late", clock, 1);
    expect(r.root.state.confirmation.units["U-W"].normal).toBe(baseline);
  });

  it("P2-A1-CONFIRMATION / A8-AC11 contractBoundary: excess scopes fold into a safe whole marker", async () => {
    const scopes = Array.from({ length: 513 }, (_, index) => ({ unit: "U-F" as const,
      operation: "normal" as const, kind: "series" as const,
      subject: `normal/VPWP50/office-${index}`, office: `office-${index}` }));
    const r = await runtime();
    r.root.dispatch({ kind: "coverageVerified", runId: "run", epoch: 0, scopes, clock: at(1) });
    expect(r.root.state.confirmation.units["U-F"].normal).toMatchObject({ whole: "scopeCapacity",
      counts: { scopeCapacity: 1 }, confirmedScopeCount: 0, scopes: [] });
  });

  it("P2-A1-CONFIRMATION regression: W coverage confirms and compacts only contained scopes", async () => {
    const area = (office: string, code: string) => ({ unit: "U-W" as const, operation: "normal" as const,
      kind: "area" as const, subject: `normal/VPWW55/${office}`,
      token: JSON.stringify(["VPWW55", "partial", office, code === "" ? "all" : "気象警報・注意報（市町村等）", code]) });
    const r = await runtime();
    r.root.dispatch({ kind: "coverageVerified", runId: "run", epoch: 0,
      scopes: [area("office", "100"), area("office", "200"), area("other", "100")], clock: at(0) });
    r.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: 0, clock: at(1) });
    r.root.dispatch({ kind: "coverageVerified", runId: "run", epoch: 1, scopes: [area("office", "")], clock: at(2) });
    const slot = r.root.state.confirmation.units["U-W"].normal;
    expect(slot.scopes).toHaveLength(2);
    expect(slot.scopes.find((item) => item.scope.kind === "area" && item.scope.subject.endsWith("/office")))
      .toMatchObject({ reason: null, confirmedAt: 1002 });
    expect(slot.counts).toEqual({ disconnected: 2 });
    expect(slot.whole).toBe("disconnected");
    expect(slot.confirmedScopeCount).toBe(1);
    expect(slot.scopeBytes).toBe(Buffer.byteLength(JSON.stringify(slot.scopes)));
  });

  it("P2-A1-CONFIRMATION regression: replacement and disconnect retain the unit byte bound", async () => {
    const scope = (office: string) => ({ unit: "U-F" as const, operation: "normal" as const,
      kind: "series" as const, subject: `normal/VPWP50/${office}`, office });
    const overhead = Buffer.byteLength(JSON.stringify({ scope: scope(""), reason: null, confirmedAt: 0 }));
    const office = "x".repeat(Math.floor((1_048_576 - 6 - overhead - 4) / 2));
    const inputs: PublisherInput[] = [
      { kind: "coverageVerified", runId: "run", epoch: 0, scopes: [scope(office)],
        clock: { wallTimeMs: 9_000_000_000_000_000, monotonicMs: 1 } },
      { kind: "connectionLost", acceptedThroughSequence: 0, clock: at(1) },
    ];
    // Each input starts from the same first coverage, so each gets its own runtime.
    for (const input of inputs) {
      const r = await runtime();
      r.root.dispatch({ kind: "coverageVerified", runId: "run", epoch: 0,
        scopes: [scope(office)], clock: { wallTimeMs: 0, monotonicMs: 0 } });
      expect(r.root.state.confirmation.units["U-F"].normal.scopes).toHaveLength(1);
      r.root.dispatch(input);
      const slots = r.root.state.confirmation.units["U-F"];
      expect(slots.normal).toMatchObject({ whole: "scopeCapacity", scopes: [], counts: { scopeCapacity: 1 } });
      expect(Object.values(slots).reduce((bytes, item) => bytes + item.scopeBytes, 0)).toBeLessThanOrEqual(1_048_576);
    }
  });

  // A10 AC15: the stringify count of one receive / one disconnect must not grow with the retained scopes.
  const areaScope = (office: string) => ({ unit: "U-W" as const, operation: "normal" as const, kind: "area" as const,
    subject: `normal/VPWW55/${office}`, token: JSON.stringify(["VPWW55", "partial", office, "all", ""]) });
  const retainedScopes = async (count: number, stubs: StubCalls = {}) => {
    const r = await runtime(stubs);
    r.root.dispatch({ kind: "coverageVerified", runId: "run", epoch: 0,
      scopes: Array.from({ length: count }, (_, index) => areaScope(`office-${index}`)), clock: at(0) });
    return r;
  };
  const stringifyCalls = async (act: () => Promise<void> | void) => {
    const stringify = vi.spyOn(JSON, "stringify");
    try { await act(); return stringify.mock.calls.length; } finally { stringify.mockRestore(); }
  };
  it("P2-A1-CONFIRMATION regression / A10 AC15: receive evidence serializes the incoming scope, not the retained ones", async () => {
    const calls = { ...unitCalls, reduceWeatherCurrentUnit: (unit: WeatherCurrentUnitState, input: WeatherCurrentInput) =>
      ({ ...unitReply(unit, input), confirmationEvidence: input.kind !== "receive" ? []
        : [{ source: "acceptedReport" as const, scopes: [areaScope("incoming")] }] }) };
    const count = async (retained: number) => {
      const r = await retainedScopes(retained, calls);
      const input = envelope("run", "VPWW57", "incoming", readFileSync("test/fixtures/15_16_02_251222_VPWW57.xml"), clock, 1);
      const serialized = await stringifyCalls(() => submit(r.h, input));
      expect(r.root.state.confirmation.units["U-W"].normal.scopes.length).toBe(retained + 1);
      return serialized;
    };
    expect(await count(400)).toBe(await count(200));
  });

  it("P2-A1-CONFIRMATION regression / A10 AC15: a disconnect re-marks retained scopes without serializing them", async () => {
    const count = async (retained: number) => {
      const r = await retainedScopes(retained);
      const serialized = await stringifyCalls(() => {
        r.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: 0, clock: at(1) });
      });
      const slot = r.root.state.confirmation.units["U-W"].normal;
      expect(slot.counts).toEqual({ disconnected: retained + 1 });
      expect(slot.scopeBytes).toBe(Buffer.byteLength(JSON.stringify(slot.scopes)));
      return serialized;
    };
    expect(await count(400)).toBe(await count(200));
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
        return { state: unit, nextDeadline: null, decisions, intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] };
      },
      toEewView: (unit: EewUnitState) => ({ unit: "U-E" as const, semanticRevision: "s",
        contentRevision: String(unit.contentRevision), admission: {}, activeCount: 1, current: unit.current,
        subjects: [{ subject: "s", operation: "normal" as const,
          informationType: "", transition: "active", severity: null, source: null, facts: {}, changedFields: [] }] }),
    };
    const enter = (previous: OwnerState, inputId: string) => receiveOwner(previous,
      completion({ kind: "decoded", material: { headType: "VXSE43", inputId } as DecodedMaterial }), clock, units(calls));
    const rejected = enter(ownerFixture("urgent", initialState()), "reject");
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
    const rejected = receiveOwner(ownerFixture("deferred", { ...initial, units: { ...initial.units, "U-F": unit } }),
      completion({ kind: "decoded", material: { headType: "VPWP50", inputId: "rejected" } as DecodedMaterial }), clock, units({
        reduceWeatherTimeseriesUnit: (state): WeatherTimeseriesUnitStep => ({ state, nextDeadline: null,
          decisions: [{ subject: normal.subject, operation: "normal", decision: "capacityExceeded",
            rejection: { family: "VPWP50", reportDateTimeMs: clock.wallTimeMs, affectedScope: "subject" } }],
          intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] }),
        toWeatherTimeseriesView: (state) => ({ unit: "U-F", semanticRevision: "old-active",
          contentRevision: String(state.contentRevision), admission: {}, series: state.subjects,
          subjects: state.subjects.map((item) => ({ subject: item.subject, operation: item.operation,
            informationType: "", transition: item.effective, severity: null, source: item.source,
            facts: { periodCount: item.periods.length }, changedFields: [] })) }),
      }));
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
      return { state: unit, nextDeadline: null, decisions, intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] };
    } };
    const enter = (state: OwnerState, inputId: string) => receiveOwner(state,
      completion({ kind: "decoded", material: { headType: "VPWW55", inputId } as DecodedMaterial }), clock, units(calls)).state;
    const rejected = enter(ownerFixture("weatherCurrent", initialState()), "reject");
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
      return { state: unit, nextDeadline: null, decisions, intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] };
    } };
    const enter = (state: OwnerState, inputId: string) => receiveOwner(state,
      completion({ kind: "decoded", material: { headType: "VXSE43", inputId } as DecodedMaterial }), clock, units(calls)).state;
    const overflowed = enter(ownerFixture("urgent", initial), "overflow");
    expect(overflowed.admission["U-E"]?.normal).toMatchObject({ overflow: true, records });
    const reduced = enter(overflowed, "clear");
    expect(reduced.admission["U-E"]?.normal).toMatchObject({ overflow: true, records: records.slice(1) });
  });
  afterEach(() => vi.restoreAllMocks());

  it("P2-A1-T01 acceptance / AC01: saved pre-deadline state has zero work in 1,000 ticks", () => {
    // AC11(f): measured on each owner's reducer call; notification and shutdown outputs belong to the publisher.
    const inspect = vi.fn();
    const owners = places.map((place) => savedOwner(place, inspect));
    const linked = units();
    const clone = vi.spyOn(globalThis, "structuredClone");
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    for (let index = 0; index < 1_000; index += 1) for (const saved of owners) {
      const step = deadlineOwner(saved, clock, linked);
      expect(step.state).toBe(saved);
      expect(step.displayChanges).toEqual([]);
      for (const effects of [step.changedUnits, step.outcomes, step.views, step.diagnostics, step.retiredEvents,
        step.confirmationEvidence]) expect(effects).toEqual([]);
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("P2-A1-T02 contractBoundary / AC02: runtime input branches never serialize or copy business state", () => {
    const maximum = fixture("test/fixtures/15_18_01_250630_VPWS50.xml", "VPWS50");
    // AC11(f): measured on the owner's branches; shutdown and notification results are publisher inputs (no unit state).
    const inspect = vi.fn();
    const owner = (place: ExecutionPlace) => savedOwner(place, inspect);
    const linked = units(unitCalls);
    const owners = [
      ["deferred", (state: OwnerState) => receiveOwner(state, completion({ kind: "decoded", material: valid }), clock, linked)],
      ["deferred", (state: OwnerState) => receiveOwner(state, completion({ kind: "decoded", material: { ...valid, infoTypeRaw: "取消" } }), clock, linked)],
      ["weatherCurrent", (state: OwnerState) => receiveOwner(state, completion({ kind: "decoded", material: maximum }), clock, linked)],
      ["deferred", (state: OwnerState) => receiveOwner(state, completion({ kind: "decoded", material: { ...valid, reportDateTimeRaw: "" } }), clock, linked)],
      ["deferred", (state: OwnerState) => receiveOwner(state, completion({ kind: "rejected", diagnostic: {
        inputId: "parser-rejected", reason: "xmlInvalid", encodedByteLength: 0,
        expandedByteLength: null, operation: { kind: "undetermined", sources: {} },
      } }), clock, linked)],
      ...places.map((place) => [place, (state: OwnerState) => deadlineOwner(state, clock, linked)] as const),
      ["urgent", (state: OwnerState) => checkpointResultOwner(state, {
        kind: "acknowledged", attemptId: "save", unit: "U-E", generation: 1,
        ackAt: clock.wallTimeMs, encodedByteLength: 100,
      }, linked)],
    ] as const;
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    const clone = vi.spyOn(globalThis, "structuredClone");
    // The routed VPWS50 reaches a no-op unit: this measures the owner's own branches, not unit admission cost.
    const ownerSteps = owners.map(([place, request]) => {
      const state = owner(place);
      const step = request(state);
      expect(step.state).toBe(state);
      expect(step.views).toEqual([]);
      return step;
    });
    expect(ownerSteps.map((step) => step.diagnostics.map((entry) => entry.reason))).toEqual([
      ["routeNotPorted"], ["routeNotPorted"], [], ["reportDateTimeMissing"], ["xmlInvalid"], [], [], [], [],
    ]);
    // Diagnostic string byte accounting is allowed; state serialization is not.
    expect(stringify.mock.calls.every(([value]) => typeof value === "string")).toBe(true);
    expect(inspect).not.toHaveBeenCalled(); // Business-state traversal is forbidden; root copies are unrestricted.
    expect(parse).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it("P2-A1-T03 corpusHistory / AC03: O02:8 and O02:10 reject in fixed priority without state change", () => {
    const inspect = vi.fn();
    const urgent = savedOwner("urgent", inspect);
    const headMissing = fixture("test/fixtures/81_05_01_260605_VPWP50_head_missing.xml", "VPWP50");
    const invalidDate = fixture("test/fixtures/telegram-foundation/invalid-report-datetime.xml", "VXSE51");
    expect(validateSemanticEnvelope(headMissing)).toMatchObject({ kind: "rejected", reason: "headMissing" });
    expect(validateSemanticEnvelope(invalidDate)).toMatchObject({ kind: "rejected", reason: "reportDateTimeInvalid" });
    expect(validateSemanticEnvelope({ ...valid, reportDateTimeRaw: "2026-02-30T00:00:00+09:00" })).toMatchObject({ kind: "rejected", reason: "reportDateTimeInvalid" });
    expect(validateSemanticEnvelope({ ...headMissing, reportDateTimeRaw: "not-a-date" })).toMatchObject({ kind: "rejected", reason: "headMissing" });
    expect(validateSemanticEnvelope({ ...valid, reportDateTimeRaw: "" })).toMatchObject({ kind: "rejected", reason: "reportDateTimeMissing" });
    // O02:8 (VPWP50) is routed to U-F, whose receive owns its runtime rejection (A6 AC01). O02:10 (VXSE51) is routed to
    // U-Q on the urgent owner since P3-C7, which rejects it with the same common check.
    for (const material of [invalidDate]) {
      const step = receiveOwner(urgent, completion({ kind: "decoded", material }), clock, units());
      expect(step.state).toBe(urgent);
      expect(step.changedUnits).toEqual([]);
      expect(step.diagnostics).toHaveLength(1);
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("P2-A1-T04 contractBoundary: preserves independent state references for three operations", async () => {
    const r = await runtime({ selectNotificationAttempt: noAttempts });
    const notices = (["normal", "training", "test"] as const).map((operation) => intent("U-E", operation));
    await r.seeds.eew(r.h, { ...r.h.unit("U-E"), intents: notices });
    const xml = readFileSync("test/fixtures/32-35_09_01_191111_VXSE56.xml", "utf8");
    for (const [index, operation] of (["normal", "training", "test"] as const).entries()) {
      const body = Buffer.from(xml.replace("<Status>通常</Status>", `<Status>${STATUS[operation]}</Status>`));
      const material = materialOf(body, "VXSE56", `operation-${operation}`);
      expect(validateSemanticEnvelope(material)).toMatchObject({ kind: "accepted", envelope: { material: { operation } } });
      const eew = r.h.unit("U-E");
      const mirror = r.root.state.mirror;
      r.at(at(1));
      await submit(r.h, envelope("run", "VXSE56", `operation-${operation}`, body, at(1), 10 + index));
      expect(r.root.state.mirror).toBe(mirror);
      expect(r.h.unit("U-E")).toBe(eew);
    }
  });

  it("B1 contractBoundary: old ack retains the first post-capture monotonic dirty time across the 3s boundary", () => {
    const reading = (ms: number): ClockReading => ({ wallTimeMs: 1_800_000_000_000 + ms, monotonicMs: ms });
    const pending: PersistenceStatus = { ...savedProgress, kind: "pending", currentGeneration: 2, dirtySince: 1 };
    const initial = freeze(ownerFixture("urgent", initialState(pending)));
    const capture = { unit: "U-E" as const, attemptId: "capture", generation: 2, capturedAt: reading(2).wallTimeMs };
    let current = capturedOwner(initial, capture, units()).state;
    expect(capturedOwner(initial, capture, units()).state).toEqual(current);
    expect(current.checkpointAttempts["U-E"]).toEqual({ ...capture, postCaptureDirtySince: null });
    expect(capturedOwner(current, capture, units()).state).toBe(current);
    expect(capturedOwner(current, { ...capture, attemptId: "overlap" }, units()).state).toBe(current);
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
    const first = deadlineOwner(freeze(current), reading(5), units(calls));
    current = deadlineOwner(freeze(first.state), reading(6), units(calls)).state;
    expect(current.checkpointAttempts["U-E"]?.postCaptureDirtySince).toBe(5);
    current = checkpointResultOwner(current, {
      ...capture, kind: "uncertain", observedAt: reading(7).wallTimeMs, stage: "ack", encodedByteLength: 10,
    }, units()).state;
    expect(current.units["U-E"]?.persistence?.kind).toBe("uncertain");
    const ack: CheckpointResult = { ...capture, kind: "acknowledged", ackAt: reading(8).wallTimeMs, encodedByteLength: 10 };
    expect(checkpointResultOwner(current, { ...ack, attemptId: "wrong" }, units()).state).toBe(current);
    expect(checkpointResultOwner(current, { ...ack, generation: 3 }, units()).state).toBe(current);
    const step = checkpointResultOwner(freeze(current), ack, units());
    expect(step.state.units["U-E"]?.persistence).toEqual({ kind: "pending", currentGeneration: 4, savedGeneration: 2,
      savedCapturedAt: reading(2).wallTimeMs, savedAckAt: reading(8).wallTimeMs, dirtySince: 5 });
    const dirtySince = step.state.units["U-E"]!.persistence.dirtySince!;
    // A3 scheduleCheckpoint consumes this timestamp as monotonic milliseconds, not wall time.
    expect(reading(3_005).monotonicMs - dirtySince > 3_000).toBe(false);
    expect(reading(3_006).monotonicMs - dirtySince > 3_000).toBe(true);
    expect(reading(4_005).monotonicMs - dirtySince).toBe(4_000);
    expect(step.state.checkpointAttempts["U-E"]).toBeUndefined();
    expect(step.state.units["U-E"]?.current).toBe(initial.units["U-E"]?.current);
    // The other units are not in this owner.
    expect(step.state.units["U-W"]).toBeUndefined();
    expect(step.state).not.toHaveProperty("persistence");
    expect(checkpointResultOwner(step.state, ack, units()).state).toBe(step.state);
    const latest = { ...capture, attemptId: "latest", generation: 4, capturedAt: reading(4_007).wallTimeMs };
    current = capturedOwner(step.state, latest, units()).state;
    const saved = checkpointResultOwner(current, { ...ack, ...latest, ackAt: reading(4_008).wallTimeMs }, units()).state;
    expect(saved.units["U-E"]?.persistence).toMatchObject({ kind: "saved", currentGeneration: 4, savedGeneration: 4,
      savedCapturedAt: reading(4_007).wallTimeMs, savedAckAt: reading(4_008).wallTimeMs, dirtySince: null });
    expect(stringify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it("B1 contractBoundary: uncertainty retains correlation; matched encode failure releases it without rollback", () => {
    const initial = freeze(ownerFixture("deferred", initialState({ ...savedProgress, kind: "pending", currentGeneration: 2, dirtySince: 100 })));
    const capture = { unit: "U-F" as const, attemptId: "encode", generation: 2, capturedAt: 200 };
    const captured = capturedOwner(initial, capture, units()).state;
    const uncertain: CheckpointResult = {
      ...capture, kind: "uncertain", stage: "ack", observedAt: 1001, encodedByteLength: 0,
    };
    const held = checkpointResultOwner(captured, uncertain, units()).state;
    expect(held.units["U-F"]?.persistence).toMatchObject({ kind: "uncertain", attemptedGeneration: 2, dirtySince: 100, savedGeneration: 1 });
    expect(held.checkpointAttempts).toBe(captured.checkpointAttempts);
    expect(checkpointResultOwner(held, uncertain, units()).state).toBe(held);
    const failure: CheckpointResult = {
      ...capture, kind: "failed", stage: "verify", failedAt: 1002, reason: "verify rejected", encodedByteLength: 0,
    };
    const failed = checkpointResultOwner(freeze(held), failure, units()).state;
    expect(failed.units["U-F"]?.persistence).toEqual({ ...initial.units["U-F"]?.persistence, kind: "failed", stage: "verify", reason: "verify rejected" });
    expect(failed.checkpointAttempts["U-F"]).toBeUndefined();
    expect(failed.units["U-F"]?.subjects).toBe(initial.units["U-F"]?.subjects);
    // The other units are not in this owner.
    expect(failed.units["U-W"]).toBeUndefined();
    expect(checkpointResultOwner(failed, failure, units()).state).toBe(failed);
    expect(checkpointResultOwner(initial, failure, units()).state).toBe(initial);
    const retry = { ...capture, attemptId: "retry" };
    const retried = capturedOwner(failed, retry, units()).state;
    expect(retried.checkpointAttempts["U-F"]).toEqual({ ...retry, postCaptureDirtySince: null });
    const encodeFailed = checkpointResultOwner(retried, {
      ...retry, kind: "failed", stage: "encode", failedAt: 1003, reason: "encode rejected", encodedByteLength: 0,
    }, units()).state;
    expect(encodeFailed.units["U-F"]?.persistence).toMatchObject({ kind: "failed", stage: "encode", currentGeneration: 2 });
    expect(encodeFailed.checkpointAttempts["U-F"]).toBeUndefined();
  });

  it("B2 contractBoundary: either clock dispatches exactly once to each due unit and adopts its returned deadline", () => {
    const initial = initialState();
    const pending = { ...initial, deadlines: {
      "U-E": { wallTimeMs: 1010, monotonicMs: null },
      "U-W": { wallTimeMs: 9999, monotonicMs: 10 },
      "U-F": { wallTimeMs: 1011, monotonicMs: 11 },
      "U-T": null,
      "U-Q": null,
      "U-N": null,
      "U-V": null,
      "U-L": null,
    } };
    const eew = vi.fn((unit: EewUnitState, input: EewInput) => unitReply(unit, input));
    const outcome = { kind: "deadlineApplied" as const, subjects: [] };
    const weather = vi.fn((unit: WeatherCurrentUnitState, input: WeatherCurrentInput) => ({
      ...unitReply(unit, input), state: { ...unit }, outcomes: [outcome],
    }));
    const series = vi.fn((unit: WeatherTimeseriesUnitState, input: WeatherTimeseriesInput) => unitReply(unit, input));
    const view = { unit: "U-W" as const, semanticRevision: "revision", contentRevision: "0",
      admission: {}, subjects: [], national: {}, partials: [], freshnessSuspectCount: 0 };
    const toView = vi.fn(() => view);
    const calls = { reduceEewUnit: eew, reduceWeatherCurrentUnit: weather, reduceWeatherTimeseriesUnit: series,
      toWeatherCurrentView: toView };
    // Each owner applies only its own units' due deadlines on its deadline request (P3-C3A-DEADLINES).
    const frozen = freeze(pending);
    const [urgent, weatherCurrent, deferred] = places.map((place) =>
      deadlineOwner(ownerFixture(place, frozen), at(10), units(calls)));
    expect(eew.mock.calls).toEqual([[initial.units["U-E"], { kind: "deadline", clock: at(10) }]]);
    expect(weather.mock.calls).toEqual([[initial.units["U-W"], { kind: "deadline", clock: at(10) }]]);
    expect(series).not.toHaveBeenCalled();
    expect({ ...urgent.state.deadlines, ...weatherCurrent.state.deadlines, ...deferred.state.deadlines })
      .toEqual({ ...pending.deadlines, "U-E": null, "U-W": null });
    expect(urgent.state.units["U-E"]).toBe(initial.units["U-E"]);
    expect(deferred.state.units["U-F"]).toBe(initial.units["U-F"]);
    expect(weatherCurrent.state.units["U-W"]?.freshness).toBe(initial.units["U-W"].freshness);
    expect(weatherCurrent.outcomes[0]).toEqual({ unit: "U-W", outcome });
    expect([urgent, weatherCurrent, deferred].flatMap((step) => step.views)).toEqual([]);
    expect(toView).not.toHaveBeenCalled();
    for (const step of [urgent, weatherCurrent, deferred])
      expect(deadlineOwner(step.state, at(10), units(calls)).state).toBe(step.state);
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
    const initial = freeze(publisherState(initialState()));
    const requested = requestShutdown(initial, at(0), 9);
    expect(requested.effects).toEqual([{ kind: "stopInputAndDrainMailbox", acceptedThroughSequence: 9, deadlineMonotonicMs: 10_000 }]);
    expect(completeDiagnostic(requested.diagnostics[0], at(0), initial.runId))
      .toMatchObject({ reason: "shutdownStarted", runId: "run", timestamp: 1000 });
    let state = requested.state;
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
      // Every owner was fixed at the cutoff, the clock the stage ended at.
      const observe = (from: PublisherState, observed: typeof input) => observeStage(from, observed, observed.clock.wallTimeMs, []);
      if (index === 0) {
        expect(observe(state, { ...input, stage: "workerClose" }).state).toBe(state);
        expect(() => observe(state, { ...input, pending: { ...pending, batches: -1 } })).toThrow(RangeError);
      }
      const step = observe(freeze(state), input);
      state = step.state;
      expect(state.shutdown.stageResults[stage]?.pending).toEqual(pending);
      expect(observe(state, input).state).toBe(state);
      expect(Object.keys(state.shutdown.stageResults)).toHaveLength(index + 1);
      if (stage === "mailboxDrain") {
        expect(step.effects).toEqual([{ kind: "finalizeNotificationDelivery", deadlineMonotonicMs: 5100 }]);
      } else if (stage === "sideEffectFinalization") {
        expect(state.shutdown.finalizationAt).toBe(1200);
        expect(step.effects).toEqual([{ kind: "startFinalCheckpoints", units: [], deadlineMonotonicMs: 10200 }]);
      } else if (stage === "finalCheckpoint") {
        expect(step.effects[0]).toMatchObject({ kind: "closeRuntimeWorkers", deadlineMonotonicMs: 5300,
          summary: { code: codes[0], requestedAt: 1000, finalizationAt: 1200, completedAt: 1300,
            acceptedThroughSequence: 9, droppedDiagnostics: { WARN: 2 } } });
      } else {
        expect(state.shutdown.stage).toBe("completed");
        expect(step.summary).toMatchObject({ code: codes[1], completedAt: 1400, droppedDiagnostics: { WARN: 3 } });
        if (failure != null) expect(step.summary?.reasons).toContain(failure + ":failed:fault");
      }
      if (stage !== "workerClose") expect(step.summary).toBeNull();
    }
    expect(initial.shutdown.stage).toBe("running");
  });
  it("B3 contractBoundary: stage timeout is monotonic, bounded by overall deadline, and freezes final generations", () => {
    let state = publisherState(initialState({ ...savedProgress, kind: "pending", currentGeneration: 2, dirtySince: 100 }));
    state = requestShutdown(state, at(0), 1).state;
    const all = ["U-E", "U-W", "U-F"] as const;
    const observe = (stage: Extract<RuntimeInput, { kind: "shutdownStageResult" }>["stage"], ms: number,
      result: ShutdownStageResult = { kind: "completed" }) => observeStage(state, {
      kind: "shutdownStageResult", stage, result, pending: noPending,
      clock: { wallTimeMs: 1000 - ms, monotonicMs: ms }, droppedDiagnostics: dropped,
    }, null, stage === "mailboxDrain" ? [] : all);
    state = observe("mailboxDrain", 10_000).state; // Equal deadline, even with wall clock moved backwards.
    expect(state.shutdown.deadlines.sideEffectFinalizationMonotonicMs).toBe(15_000);
    // P3-C3A-FINALIZE-TIMEOUT (A): the stage ended before every earlier reply (U-E's save was in flight), so no
    // cutoff was decided and no owner is fixed.
    state = observe("sideEffectFinalization", 28_000, { kind: "deadlineExceeded" }).state;
    expect(state.shutdown.deadlines.finalCheckpointMonotonicMs).toBe(30_000);
    expect(state.shutdown.finalizationAt).toBeNull();
    const close = observe("finalCheckpoint", 29_000);
    expect(close.state.shutdown.stageResults.finalCheckpoint?.pending.unsavedUnits).toBe(3);
    state = close.state;
    // AC11 D4: the save's late acknowledgement only releases the write right; the mirror is not updated.
    const done = observe("workerClose", 29_500);
    expect(done.summary?.code).toBe(3);
    expect(done.summary?.reasons).toEqual([
      "mailboxDrain:deadlineExceeded", "sideEffectFinalization:deadlineExceeded", "finalCheckpoint:unsavedUnits",
    ]);
    expect(done.summary?.persistence["U-E"]?.kind).toBe("pending");
    expect(done.summary?.persistence).toEqual({
      "U-E": done.state.mirror["U-E"].persistence,
      "U-W": done.state.mirror["U-W"].persistence,
      "U-F": done.state.mirror["U-F"].persistence,
      "U-T": done.state.mirror["U-T"].persistence,
      "U-Q": done.state.mirror["U-Q"].persistence,
      "U-N": done.state.mirror["U-N"].persistence,
      "U-V": done.state.mirror["U-V"].persistence,
      "U-L": done.state.mirror["U-L"].persistence,
    });
  });

  it("B4 contractBoundary: selection and result use each owning unit intentUpdate with atomic channel adoption", async () => {
    for (const unit of runtimeUnits) {
      const notice = intent(unit);
      const selected = attempt(notice);
      // Without A7 a pending intent cannot be selected.
      const bare = await runtime(unitCalls, at(1));
      await expect(seedIntents(bare, unit, [notice])).rejects.toThrow("A7 selection is not linked");
      const selection = vi.fn((delivery: NotificationDeliveryState) => delivery.channels.desktop.kind !== "idle"
        || delivery.intents.length === 0 ? noAttempts(delivery) : {
          state: { channels: { ...delivery.channels, desktop: { kind: "running" as const, attempt: selected } },
            intents: delivery.intents.map((value) => ({ ...value, attempts: 1, nextAttemptAt: 2000 })), deadlines: delivery.deadlines },
          attempts: [selected], abortRequests: [], diagnostics: [],
        });
      const result: NotificationResult = { kind: "delivered", attemptId: selected.attemptId, intentId: notice.id,
        channel: "desktop", completedAt: at(2) };
      const apply = vi.fn((delivery: NotificationDeliveryState, actual: NotificationResult, reading: ClockReading) => {
        expect(actual).toBe(result);
        expect(reading).toBe(result.completedAt);
        return { state: { channels: { ...delivery.channels, desktop: { kind: "idle" as const } },
          intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" as const })), deadlines: delivery.deadlines },
          diagnostics: [] };
      });
      // No unit is saved here: each adoption would start a save at once (P3-UWR-AC03), and the pending generation below
      // is the adoption's (AC10(7)).
      const r = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: selection, applyNotificationResult: apply }, at(1),
        { codecs: {} });
      const others = runtimeUnits.filter((candidate) => candidate !== unit).map((candidate) => r.h.unit(candidate));
      await seedIntents(r, unit, [notice]);
      expect(selection.mock.calls[0][0].channels).toEqual(idleChannels);
      expect(r.h.unit(unit).intents[0]).toMatchObject({ attempts: 1, nextAttemptAt: 2000, disposition: "pending" });
      expect(r.h.unit(unit).persistence).toMatchObject({ kind: "pending", currentGeneration: 2 });
      // AC11(d): the attempt starts once the owner adopted the reservation's update.
      expect(r.notices.runs.map((run) => run.attempt)).toEqual([selected]);
      expect(r.root.state.notificationChannels.sound).toEqual({ kind: "idle" });
      expect(runtimeUnits.filter((candidate) => candidate !== unit).map((candidate) => r.h.unit(candidate))).toEqual(others);
      r.at(at(2));
      r.notices.finish(result);
      await r.h.settle();
      if (unit === "U-E") {
        expect(r.h.unit("U-E").intents).toEqual([]);
        expect(r.h.unit("U-E").deliveryRecords).toContainEqual({ intentId: notice.id, disposition: "delivered", expiresAt: 5000 });
        // A late timeout at the wall deadline: the record is reclaimed with the expiry.
        const late = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: vi.fn(selection.getMockImplementation()!),
          applyNotificationResult: (delivery) => ({ state: { ...delivery,
            channels: { ...delivery.channels, desktop: { kind: "idle" } },
            intents: delivery.intents.map((value) => ({ ...value, disposition: "expired" })) }, diagnostics: [] }) }, at(1));
        await seedIntents(late, unit, [notice]);
        late.at(at(4000));
        late.notices.finish({ kind: "timeout", stopped: true, attemptId: selected.attemptId, intentId: notice.id,
          channel: "desktop", completedAt: at(4000) });
        await late.h.settle();
        expect(late.h.unit("U-E").intents).toEqual([]);
        expect(late.h.unit("U-E").deliveryRecords).toEqual([]);
        expect(late.h.unit("U-E").persistence.currentGeneration).toBe(3);
        expect(late.root.state.notificationChannels.desktop.kind).toBe("idle");
      } else expect(r.h.unit(unit).intents[0]).toMatchObject({ disposition: "delivered", attempts: 1, expiresAt: 5000 });
      expect(r.h.unit(unit).persistence.currentGeneration).toBe(3);
      expect(r.root.state.notificationChannels.desktop.kind).toBe("idle");
      expect(apply).toHaveBeenCalledTimes(1);
    }
  });

  it("P2-A1-T12 regression / AC11: monotonic expiry without an attempt reaches U-E terminal records", async () => {
    const material = fixture("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43");
    const received = reduceEewUnit(initialState().units["U-E"], { kind: "receive", material, clock: at(0) });
    const r = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: noAttempts }, at(0));
    await r.seeds.eew(r.h, received.state, received.nextDeadline);
    expect(Object.keys(r.root.state.notificationDeadlines.desktop)).toHaveLength(1);
    const rewound = { wallTimeMs: 900, monotonicMs: 15_001 };
    r.at(rewound);
    r.root.tick(rewound);
    await r.h.settle();
    expect(r.notices.runs).toEqual([]);
    expect(r.h.unit("U-E").intents).toEqual([]);
    expect(r.h.unit("U-E").deliveryRecords).toEqual(received.intents.map((item) => ({
      intentId: item.id, disposition: "expired", expiresAt: item.expiresAt,
    })));
  });

  it("P2-A1-T12 contractBoundary / TIME: reclaims 128 monotonic-expired intents before receiving a new event", async () => {
    const owner = vi.fn(reduceEewUnit);
    const selection = vi.fn(noAttempts);
    const r = await runtime({ ...unitCalls, reduceEewUnit: owner, selectNotificationAttempt: selection }, at(0));
    await seedIntents(r, "U-E", Array.from({ length: 128 }, (_, index) => ({ ...intent("U-E"), id: `occupied-${index}`, expiresAt: 16_000 })));
    owner.mockClear();
    selection.mockClear();
    const late = { wallTimeMs: 900, monotonicMs: 15_000 };
    r.at(late);
    await r.input("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43", "event", late, 1);
    // P3-C3B-AC08 (AC06(e), back to before D3): the input's unit has its 128 monotonic-expired intents reclaimed first.
    const update = owner.mock.calls[0][1];
    if (update.kind !== "intentUpdate" || "id" in update.intentUpdate) throw new Error("batch expiry expected");
    expect(update.intentUpdate).toHaveLength(128);
    expect(update.intentUpdate.every((item) => item.disposition === "expired")).toBe(true);
    expect(owner.mock.calls[1][1].kind).toBe("receive");
    expect(r.h.unit("U-E").intents.map((value) => value.channel)).toEqual(["desktop", "sound"]);
    expect(r.h.unit("U-E").current).toHaveLength(1);
    expect(r.h.unit("U-E").deliveryRecords).toHaveLength(128);
    expect(r.h.unit("U-E").notificationLatches[0].firstReportNotified).toBe(true);
  });

  it("P2-A1-T12 regression / TIME: monotonic expiry stops a running attempt with expired before reclaiming its deadline", async () => {
    const select = vi.fn((delivery: NotificationDeliveryState): NotificationSelection => {
      if (delivery.channels.desktop.kind !== "idle") return noAttempts(delivery);
      const notice = delivery.intents.find((value) => value.channel === "desktop" && value.disposition === "pending" && value.attempts === 0);
      if (notice == null) return noAttempts(delivery);
      const selected = attempt(notice);
      return { state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "running", attempt: selected } },
        intents: delivery.intents.map((value) => value === notice ? { ...value, attempts: 1 } : value) },
        attempts: [selected], abortRequests: [], diagnostics: [] };
    });
    const r = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: select }, at(0));
    await r.input("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43", "first", at(0), 1);
    const active = r.notices.runs[0].attempt;
    const key = JSON.stringify(["U-E", active.intentId]);
    expect(r.root.state.notificationDeadlines.desktop[key]?.expiresAtMonotonicMs).toBe(15_000);
    const late = { wallTimeMs: 900, monotonicMs: 15_000 };
    r.at(late);
    await r.input("test/fixtures/37_01_02_240613_VXSE43.xml", "VXSE43", "followup", late, 2);
    // P3-C3B-AC08 (AC06(e), back to before D3): the old intents are reclaimed as expired before the follow-up is received,
    // and the running attempt stops with cause expired.
    expect(r.notices.aborts).toEqual([active.attemptId]);
    expect(r.root.state.notificationChannels.desktop).toEqual({ kind: "stopping", attempt: active,
      cause: "expired", stopByMonotonicMs: 16_000 });
    expect(r.root.state.notificationDeadlines.desktop[key]).toBeUndefined();
    expect(r.h.unit("U-E").deliveryRecords).toHaveLength(2);
    expect(r.h.unit("U-E").deliveryRecords.every((record) => record.disposition === "expired")).toBe(true);
    const followups = r.h.unit("U-E").intents;
    expect(followups.map((notice) => notice.channel)).toEqual(["desktop", "sound"]);
    for (const notice of followups) {
      expect(notice.payload).toMatchObject({ level: "critical", title: "緊急地震速報（警報）" });
      expect(notice.payload.body).toMatch(/^続報: /);
      expect(notice).toMatchObject({ attempts: 0, createdAt: 900, expiresAt: 15_900 });
      expect(r.root.state.notificationDeadlines[notice.channel]).toEqual({
        [JSON.stringify(["U-E", notice.id])]: { retryAtMonotonicMs: 15_000, expiresAtMonotonicMs: 30_000 },
      });
    }
    expect(r.notices.runs).toHaveLength(1);
    const last = select.mock.calls.at(-1)![0];
    expect(last.channels.desktop).toEqual(r.root.state.notificationChannels.desktop);
    expect(last.deadlines).toEqual(r.root.state.notificationDeadlines);
    expect(last.intents).toEqual(followups);
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
    const entered = ingestXmlData({ inputId: "unchanged-hazard-followup", inputSequence: 2,
      receivedAt: at(15_000).wallTimeMs, origin: "replay", kind: "replay", headType: "VXSE43",
      body: Buffer.from(readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8")
        .replace("<Serial>1</Serial>", "<Serial>2</Serial>")) });
    if (entered.kind !== "accepted") throw new Error("invalid synthetic follow-up");
    const decoded = decodeMaterial(entered.item);
    if (decoded.kind !== "decoded") throw new Error("invalid synthetic follow-up");
    const continued = receiveOwner(ownerFixture("urgent", state), completion(decoded), at(15_000), units());
    expect(continued.state.units["U-E"]?.persistence.currentGeneration).toBe(before + 1);
    expect(continued.state.units["U-E"]?.deliveryRecords).toEqual([]);
    expect(continued.state.units["U-E"]?.intents).toEqual([]);
    expect(continued.state.units["U-E"]?.current[0].serial).toBe(2);
    expect(continued.generationInputIds).toEqual({ "U-E": [] });
  });

  it("P2-A1-T12 contractBoundary / AC11 R35 R36: hazard increase stops the old attempt and cancellation follows delivery evidence", async () => {
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
    const r = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: select, applyNotificationResult: apply }, at(0));
    await r.input("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43", "first", at(0), 1);
    expect(r.notices.runs).toHaveLength(1);
    const active = r.notices.runs[0].attempt;
    const key = JSON.stringify(["U-E", active.intentId]);
    r.at(at(1));
    await r.input("test/fixtures/37_01_02_240613_VXSE43.xml", "VXSE43", "second", at(1), 2);
    expect(r.root.state.notificationDeadlines.desktop[key]).toBeUndefined();
    expect(r.notices.aborts).toEqual([active.attemptId]);
    expect(r.notices.runs).toHaveLength(1);
    expect(r.h.unit("U-E").notificationLatches[0].deliveryEvidence).toBe("possible");
    const followups = r.h.unit("U-E").intents;
    expect(followups).toHaveLength(2);
    for (const notice of followups) expect(notice.payload.body).toMatch(/^続報: /);
    r.at(at(2));
    await r.input("test/fixtures/37_01_03_240613_VXSE43.xml", "VXSE43", "third", at(2), 3);
    expect(r.notices.aborts).toEqual([active.attemptId]);
    expect(r.notices.runs).toHaveLength(1);
    expect(r.h.unit("U-E").intents).toHaveLength(2);
    expect(r.h.unit("U-E").intents.every((notice) => notice.payload.level === "cancel")).toBe(true);
    expect(r.h.unit("U-E").deliveryRecords).toContainEqual({ intentId: active.intentId,
      disposition: "superseded", expiresAt: active.expiresAt });
    for (const notice of followups) expect(r.h.unit("U-E").deliveryRecords).toContainEqual({
      intentId: notice.id, disposition: "superseded", expiresAt: notice.expiresAt,
    });
    r.at(at(3));
    r.notices.finish({ kind: "aborted", stopped: true, reason: "superseded", attemptId: active.attemptId,
      intentId: active.intentId, channel: "desktop", completedAt: at(3) });
    await r.h.settle();
    expect(r.notices.runs).toHaveLength(2);
    const replacement = r.notices.runs[1].attempt;
    expect(replacement.intentId).not.toBe(active.intentId);
    const replacementKey = JSON.stringify(["U-E", replacement.intentId]);
    const expires = r.root.state.notificationDeadlines.desktop[replacementKey]!.expiresAtMonotonicMs;
    r.at(at(5_003));
    r.root.tick(at(5_003));
    await r.h.settle();
    expect(r.notices.aborts).toEqual([active.attemptId, replacement.attemptId]);
    r.at(at(5_004));
    r.notices.finish({ kind: "timeout", stopped: true, attemptId: replacement.attemptId, intentId: replacement.intentId,
      channel: "desktop", completedAt: at(5_004) });
    await r.h.settle();
    expect(r.notices.runs).toHaveLength(2);
    expect(r.root.state.notificationChannels.desktop.kind).toBe("idle");
    expect(r.root.state.notificationDeadlines.desktop[replacementKey]).toEqual({ retryAtMonotonicMs: 6_004, expiresAtMonotonicMs: expires });

    // R35: the same reports remain silent on cancellation when A1 never selected an attempt.
    const waiting = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: noAttempts }, at(0));
    for (const [index, file] of ["37_01_01", "37_01_02", "37_01_03"].entries()) {
      waiting.at(at(index));
      await waiting.input(`test/fixtures/${file}_240613_VXSE43.xml`, "VXSE43", `waiting-${index}`, at(index), index + 1);
      expect(waiting.notices.runs).toEqual([]);
      expect(waiting.h.unit("U-E").notificationLatches[0].deliveryEvidence).toBe("unattempted");
      expect(waiting.h.unit("U-E").intents).toHaveLength(index === 2 ? 0 : 2);
      if (index === 1) expect(waiting.h.unit("U-E").intents[0].payload.body).toMatch(/^続報: /);
    }
    expect(waiting.h.unit("U-E").current).toEqual([]);
    expect(waiting.h.unit("U-E").deliveryRecords).toHaveLength(4);
    expect(waiting.h.unit("U-E").deliveryRecords.every((record) => record.disposition === "superseded")).toBe(true);
    expect(waiting.root.state.notificationDeadlines).toEqual({ desktop: {}, sound: {} });
  });

  it("P2-A1-T12 contractBoundary / TIME: admission filtering retains the owner's monotonic deadline", async () => {
    const notice = intent("U-E");
    // One capacity rejection hides U-E normal intents from selection (admission count > 0).
    const blocking = (unit: EewUnitState, input: EewInput): EewUnitStep => input.kind === "receive" && input.material.inputId === "block"
      ? { ...unitReply(unit, input), decisions: [{ subject: "s", operation: "normal", decision: "capacityExceeded",
        rejection: { family: "VXSE43", reportDateTimeMs: 1, affectedScope: "subject" } }] }
      : reduceEewUnit(unit, input);
    const r = await runtime({ ...unitCalls, reduceEewUnit: blocking }, at(0));
    await r.input("test/fixtures/37_01_01_240613_VXSE43.xml", "VXSE43", "block", at(0), 1);
    await seedIntents(r, "U-E", [notice]);
    const key = JSON.stringify(["U-E", notice.id]);
    const deadline = r.root.state.notificationDeadlines.desktop[key];
    expect(deadline).toEqual({ retryAtMonotonicMs: 0, expiresAtMonotonicMs: 4_000 });
    r.at({ wallTimeMs: 500, monotonicMs: 1 });
    r.root.tick({ wallTimeMs: 500, monotonicMs: 1 });
    await r.h.settle();
    expect(r.root.state.notificationDeadlines.desktop[key]).toBe(deadline);
    r.at({ wallTimeMs: 400, monotonicMs: 4_000 });
    r.root.tick({ wallTimeMs: 400, monotonicMs: 4_000 });
    await r.h.settle();
    expect(r.h.unit("U-E").intents).toEqual([]);
    expect(r.h.unit("U-E").deliveryRecords).toContainEqual({
      intentId: notice.id, disposition: "expired", expiresAt: notice.expiresAt,
    });
    expect(r.root.state.notificationDeadlines.desktop[key]).toBeUndefined();
  });

  it("P2-A1-T12 contractBoundary / TIME: 384 pending deadlines stay stable across ordinary reevaluation", async () => {
    const notices = (unit: RuntimeUnitId) => Array.from({ length: 128 }, (_, index) => ({
      ...intent(unit), id: `${unit}-${index}`, expiresAt: 100_000,
    }));
    const r = await runtime({ ...unitCalls, selectNotificationAttempt: noAttempts }, at(0));
    for (const unit of runtimeUnits) await seedIntents(r, unit, notices(unit));
    expect(Object.keys(r.root.state.notificationDeadlines.desktop)).toHaveLength(384);
    const stringify = vi.spyOn(JSON, "stringify");
    for (let index = 0; index < 30; index++) {
      const deadlines = r.root.state.notificationDeadlines;
      r.at(at(index + 1));
      r.root.tick(at(index + 1));
      await r.h.settle();
      expect(r.root.state.notificationDeadlines).toBe(deadlines);
    }
    expect(stringify.mock.calls.some(([value]) => value === r.root.state.notificationDeadlines
      || value === r.root.state.notificationDeadlines.desktop)).toBe(false);
  });

  it("P2-A1-T12 contractBoundary / AC11: shutdown fixes the running abort cause and stop deadline at request", () => {
    const notice = intent("U-E");
    const active = attempt(notice);
    const initial = initialState();
    const running = publisherState({ ...initial, notificationChannels: { ...initial.notificationChannels,
      desktop: { kind: "running", attempt: active } } });
    const requested = requestShutdown(running, at(0), 1);
    expect(requested.abortRequests).toEqual([{ attemptId: active.attemptId, cause: "shutdown" }]);
    expect(requested.state.notificationChannels.desktop).toEqual({ kind: "stopping", attempt: active,
      cause: "shutdown", stopByMonotonicMs: 1_000 });
    const existing = { ...running, notificationChannels: { ...running.notificationChannels,
      desktop: { kind: "stopping" as const, attempt: active, cause: "timeout" as const, stopByMonotonicMs: 500 } } };
    const preserved = requestShutdown(existing, at(0), 1);
    expect(preserved.abortRequests).toEqual([]);
    expect(preserved.state.notificationChannels.desktop).toBe(existing.notificationChannels.desktop);
  });

  it("P2-A1-T12 contractBoundary / TIME: 128 pending plus 4000 terminal intents expire with linear owner work", async () => {
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
    const r = await runtime({
      selectNotificationAttempt: noAttempts,
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
    }, at(0));
    await r.seeds.weather(r.h, { ...weather.state, persistence: savedProgress });
    await r.seeds.series(r.h, { ...series.state, persistence: savedProgress });
    const seededGeneration = { "U-W": r.h.unit("U-W").persistence.currentGeneration, "U-F": r.h.unit("U-F").persistence.currentGeneration };
    owner["U-W"].reads = owner["U-F"].reads = 0;
    const start = performance.now();
    const late = { wallTimeMs: 500, monotonicMs: 4_000 };
    r.at(late);
    r.root.tick(late);
    await r.h.settle();
    console.info("128 pending + 4000 terminal", { totalMs: performance.now() - start, owner });
    for (const unit of ["U-W", "U-F"] as const) {
      expect(r.h.unit(unit).intents).toHaveLength(4_128);
      expect(r.h.unit(unit).intents.slice(4_000).every((notice) => notice.disposition === "expired")).toBe(true);
      expect(r.h.unit(unit).persistence.currentGeneration).toBe(seededGeneration[unit] + 128);
      expect(owner[unit].reads).toBeLessThan(20 * 4_128);
    }
    expect(r.root.state.notificationDeadlines).toEqual({ desktop: {}, sound: {} });
    // deferred also owns U-L (P3-C10-PLACE=A), idle here.
    expect(r.h.owners.get("weatherCurrent")!["state"]!.deadlines).toEqual({ "U-W": { wallTimeMs: 5_000, monotonicMs: null } });
    expect(r.h.owners.get("deferred")!["state"]!.deadlines).toEqual({ "U-F": { wallTimeMs: 5_000, monotonicMs: null }, "U-L": null });
    r.at(at(4_000));
    r.root.tick(at(4_000));
    await r.h.settle();
    expect(r.h.unit("U-W").intents).toEqual([]);
    expect(r.h.unit("U-F").intents).toEqual([]);
    for (const [codec, payload] of [[weatherCurrentUnitCodec, weatherPayload], [weatherTimeseriesUnitCodec, seriesPayload]] as const) {
      expect(codec.decode({ ...payload, intents: [...payload.intents, { ...payload.intents[4_000], id: "overflow" }] }).kind).toBe("invalid");
      expect(codec.decode({ ...payload, intents: [{ ...payload.intents[4_000], payload: { body: "x".repeat(131_072) } }] }).kind).toBe("invalid");
    }
  });

  it("B4 contractBoundary: stopped=false is preserved; invalidated and cross-operation results cannot deliver", async () => {
    const notice = intent("U-E", "training");
    const active = attempt(notice);
    // A7 double: the training intent starts `active`; from 9 ms on the running attempt stops with timeout.
    const select = (delivery: NotificationDeliveryState, reading: ClockReading): NotificationSelection => {
      const channel = delivery.channels.desktop;
      if (channel.kind === "running" && reading.monotonicMs >= 9) return { state: { ...delivery, channels: { ...delivery.channels,
        desktop: { kind: "stopping", attempt: channel.attempt, cause: "timeout", stopByMonotonicMs: 9 } } },
        attempts: [], abortRequests: [{ attemptId: channel.attempt.attemptId, cause: "timeout" }], diagnostics: [] };
      const pending = delivery.intents.find((value) => value.id === notice.id && value.attempts === 0);
      if (channel.kind !== "idle" || pending == null) return noAttempts(delivery);
      return { state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "running", attempt: active } },
        intents: delivery.intents.map((value) => value === pending ? { ...value, attempts: 1 } : value) },
        attempts: [active], abortRequests: [], diagnostics: [] };
    };
    const stopping = async (apply: NotificationCalls["applyNotificationResult"]) => {
      const r = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: select, applyNotificationResult: apply }, at(1));
      await seedIntents(r, "U-E", [notice]);
      r.at(at(9));
      r.root.tick(at(9));
      await r.h.settle();
      expect(r.root.state.notificationChannels.desktop).toMatchObject({ kind: "stopping", cause: "timeout" });
      return r;
    };
    const timeout: NotificationResult = { kind: "timeout", stopped: false, attemptId: active.attemptId, intentId: notice.id,
      channel: "desktop", completedAt: at(10) };
    const apply = vi.fn((delivery: NotificationDeliveryState, actual: NotificationResult) => {
      expect(actual).toBe(timeout);
      return { state: { intents: delivery.intents, channels: { ...delivery.channels,
        desktop: { kind: "isolated" as const, attemptId: active.attemptId, sinceMonotonicMs: 10, reason: "stopUnconfirmed" as const } },
        deadlines: delivery.deadlines }, diagnostics: [{ level: "WARN" as const, component: "test-boundary", reason: "mailboxStalled" as const }] };
    });
    const isolated = await stopping(apply);
    const unit = isolated.h.unit("U-E");
    isolated.at(at(10));
    isolated.notices.finish(timeout);
    await isolated.h.settle();
    expect(isolated.root.state.notificationChannels.desktop.kind).toBe("isolated");
    expect(isolated.h.unit("U-E")).toBe(unit);
    await isolated.root.diagnostics.flush();
    expect((await isolated.root.readDiagnostics({ limit: 256 })).records)
      .toContainEqual(expect.objectContaining({ reason: "mailboxStalled", timestamp: 1010, runId: "run" }));
    // A success after the attempt was stopped (invalidated) cannot deliver.
    const late = await stopping((delivery) => ({ state: { ...delivery,
      intents: delivery.intents.map((value) => ({ ...value, disposition: "delivered" })) }, diagnostics: [] }));
    const before = late.h.unit("U-E");
    late.at(at(11));
    late.notices.finish({ kind: "delivered", attemptId: active.attemptId, intentId: notice.id, channel: "desktop", completedAt: at(11) });
    await late.h.settle();
    expect(late.h.unit("U-E")).toBe(before);
    // A normal intent expiring while the training attempt runs stops nothing.
    const normal = { ...intent("U-E"), expiresAt: 1_010 };
    const crossed = await runtime({ ...unitCalls, reduceEewUnit, selectNotificationAttempt: (delivery, reading) =>
      reading.monotonicMs >= 9 ? noAttempts(delivery) : select(delivery, reading) }, at(0));
    await seedIntents(crossed, "U-E", [notice, normal]);
    const running = crossed.root.state.notificationChannels.desktop;
    expect(running).toMatchObject({ kind: "running", attempt: active });
    crossed.at(at(10));
    crossed.root.tick(at(10));
    await crossed.h.settle();
    expect(crossed.h.unit("U-E").intents.map((value) => value.id)).toEqual([notice.id]);
    expect(crossed.notices.aborts).toEqual([]);
    expect(crossed.root.state.notificationChannels.desktop).toBe(running);
  });

  it("AC05 contractBoundary: completion runId must match the fixed runtime run", () => {
    const owner = ownerFixture("deferred", state);
    const step = receiveOwner(owner, completion({ kind: "decoded", material: { ...valid, reportDateTimeRaw: "" } }, "another-run"),
      clock, units());
    expect(step.state).toBe(owner);
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
      const [event] = receiveOwner(ownerFixture("deferred", state), completion({ kind: "decoded",
        material: { ...valid, inputId: long, reportDateTimeRaw: "" } }), clock, units()).diagnostics;
      expect(event).toMatchObject({ timestamp: clock.wallTimeMs, runId: "run", reason: "reportDateTimeMissing" });
    }
  });
});
