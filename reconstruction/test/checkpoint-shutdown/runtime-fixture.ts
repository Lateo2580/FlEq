import type {
  ClockReading, JsonValue, PersistenceStatus, RuntimeState, RuntimeUnitId, RuntimeUnitStates, UnitCodec, UnitId,
} from "../../contracts/p2-shared-runtime.types";
import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { initialUnits } from "../../src/runtime/owner-runtime";
import type { CompositionOptions } from "../../src/runtime/composition-root";
import { linkedUnitTable } from "../../src/runtime/composition-root";
import { initialConfirmation } from "../../src/runtime/shared-runtime";
import { envelope, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { callsWith } from "../unit-table/linked-calls";
import type { StubCalls } from "../unit-table/linked-calls";

const testNotificationChannels = { desktop: { kind: "idle" }, sound: { kind: "idle" } } as const;
function recordingNotificationAdapter() {
  return { run: async (attempt: Parameters<NonNullable<CompositionOptions["notificationAdapter"]>["run"]>[0],
    clock: () => ClockReading) => {
    return { kind: "delivered" as const, attemptId: attempt.attemptId, intentId: attempt.intentId,
      channel: attempt.channel, completedAt: clock() };
  }, abort: async () => {} };
}

type Fixture = Readonly<{ value: string; intentExpiresAt?: number; activeFixture?: string | null }>;
const saved: PersistenceStatus = { kind: "saved", currentGeneration: 1, savedGeneration: 1,
  savedCapturedAt: 0, savedAckAt: 0, dirtySince: null };
// A whole-runtime description of unit states (the owners hold the units; tests describe them together).
const baseline: RuntimeState = {
  runId: "review", units: initialUnits,
  views: { "U-E": linkedUnitTable["U-E"].toView(initialUnits["U-E"]), "U-W": linkedUnitTable["U-W"].toView(initialUnits["U-W"]),
    "U-F": linkedUnitTable["U-F"].toView(initialUnits["U-F"]), "U-T": linkedUnitTable["U-T"].toView(initialUnits["U-T"]),
    "U-Q": linkedUnitTable["U-Q"].toView(initialUnits["U-Q"]), "U-N": linkedUnitTable["U-N"].toView(initialUnits["U-N"]),
    "U-V": linkedUnitTable["U-V"].toView(initialUnits["U-V"]), "U-L": linkedUnitTable["U-L"].toView(initialUnits["U-L"]),
    "U-R": linkedUnitTable["U-R"].toView(initialUnits["U-R"]) },
  confirmation: initialConfirmation(),
  restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" }, "U-T": { kind: "empty" },
    "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" }, "U-L": { kind: "empty" }, "U-R": { kind: "empty" } },
  admission: {}, checkpointAttempts: {}, deadlines: { "U-E": null, "U-W": null, "U-F": null, "U-T": null, "U-Q": null, "U-N": null,
    "U-V": null, "U-L": null, "U-R": null },
  notificationChannels: testNotificationChannels, notificationProbeComplete: false, notificationDeadlines: { desktop: {}, sound: {} },
  shutdown: { stage: "running", acceptedThroughSequence: null, startedAt: null, finalizationAt: null, stageResults: {},
    deadlines: { overallMonotonicMs: null, mailboxDrainMonotonicMs: null, sideEffectFinalizationMonotonicMs: null,
      finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } },
};

// Test payloads carry bytes only; no production unit semantics are implemented here.
function fixtureState(values: Partial<Record<RuntimeUnitId, Fixture | string>> = {},
  persistence: Readonly<Partial<Record<RuntimeUnitId, PersistenceStatus>>> = {}, runId = "review"): RuntimeState {
  const payload = (unit: RuntimeUnitId) => typeof values[unit] === "string"
    ? { value: values[unit] } : values[unit] ?? { value: "" };
  const progress = (unit: RuntimeUnitId) => persistence[unit] ?? saved;
  return {
    ...baseline,
    runId,
    restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" }, "U-L": { kind: "empty" }, "U-R": { kind: "empty" } },
    admission: {},
    notificationProbeComplete: true,
    units: {
      "U-E": { ...payload("U-E"), schemaVersion: "p2-eew-unit-v1", contentRevision: 0, current: [], gates: [], intents: [],
        deliveryRecords: [], notificationLatches: [], persistence: progress("U-E") },
      "U-W": { ...payload("U-W"), schemaVersion: "p2-weather-current-unit-v1", contentRevision: 0, national: {}, partials: [],
        histories: [], ownership: {}, tombstones: [], freshness: [], unavailable: [], intents: [], persistence: progress("U-W") },
      "U-F": { ...payload("U-F"), schemaVersion: "p2-weather-timeseries-unit-v1", contentRevision: 0, subjects: [], gates: [],
        intents: [], persistence: progress("U-F") },
      "U-T": { ...payload("U-T"), schemaVersion: "p3-tsunami-unit-v1", contentRevision: 0, forecasts: [], observations: [],
        intents: [], persistence: progress("U-T") },
      "U-Q": { ...payload("U-Q"), ...initialUnits["U-Q"], persistence: progress("U-Q") },
      "U-N": { ...payload("U-N"), ...initialUnits["U-N"], persistence: progress("U-N") },
      "U-V": { ...payload("U-V"), ...initialUnits["U-V"], persistence: progress("U-V") },
      "U-L": { ...payload("U-L"), ...initialUnits["U-L"], persistence: progress("U-L") },
      "U-R": { ...payload("U-R"), ...initialUnits["U-R"], persistence: progress("U-R") },
    },
    checkpointAttempts: {}, deadlines: { "U-E": { monotonicMs: 0, wallTimeMs: null },
      "U-W": { monotonicMs: 0, wallTimeMs: null }, "U-F": { monotonicMs: 0, wallTimeMs: null },
      "U-T": { monotonicMs: 0, wallTimeMs: null }, "U-Q": { monotonicMs: 0, wallTimeMs: null },
      "U-N": { monotonicMs: 0, wallTimeMs: null }, "U-V": { monotonicMs: 0, wallTimeMs: null },
      "U-L": { monotonicMs: 0, wallTimeMs: null }, "U-R": { monotonicMs: 0, wallTimeMs: null } },
    notificationDeadlines: { desktop: {}, sound: {} },
    notificationChannels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
    shutdown: { stage: "running", acceptedThroughSequence: null, startedAt: null, finalizationAt: null, stageResults: {},
      deadlines: { overallMonotonicMs: null, mailboxDrainMonotonicMs: null, sideEffectFinalizationMonotonicMs: null,
        finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } },
  };
}

function fixtureValue(state: RuntimeUnitStates[RuntimeUnitId]): string {
  return "value" in state && typeof state.value === "string" ? state.value : "";
}

function stringCodec<U extends RuntimeUnitId>(unit: U): UnitCodec<RuntimeUnitStates[U], JsonValue> {
  return { schemaVersion: fixtureState().units[unit].schemaVersion, encode: fixtureValue,
    decode: (payload) => typeof payload === "string"
      ? { kind: "restored", state: fixtureState({ [unit]: payload }).units[unit] }
      : { kind: "invalid", reason: "not a string" } };
}

// Drives each owner's unit to a desired fixture state: the stub reducers return it for the inputs the driver submits.
function fixtureDriver() {
  let update: Partial<RuntimeUnitStates> | null = null;
  const only = <U extends RuntimeUnitId>(unit: U, state: RuntimeUnitStates[U]): Partial<RuntimeUnitStates> => {
    const result: Partial<RuntimeUnitStates> = {};
    result[unit] = state;
    return result;
  };
  const target = <U extends RuntimeUnitId>(unit: U): RuntimeUnitStates[U] | null => update?.[unit] ?? null;
  const step = <U extends RuntimeUnitId>(unit: U, previous: RuntimeUnitStates[U]) => {
    const desired = target(unit);
    return {
      state: desired != null && fixtureValue(desired) !== ""
        && (fixtureValue(desired) !== fixtureValue(previous)
          || desired.persistence.currentGeneration !== previous.persistence.currentGeneration)
        ? desired : previous,
      decisions: desired != null && desired.persistence.currentGeneration > previous.persistence.currentGeneration
        ? [{ subject: "fixture", operation: "normal" as const, decision: "changed" as const,
          reason: null, change: "semantic" as const, currentEstablished: null }] : [],
      intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [],
      nextDeadline: { monotonicMs: 0, wallTimeMs: null },
    };
  };
  const stubs: StubCalls = {
    selectNotificationAttempt: (state) => ({ state, attempts: [], abortRequests: [], diagnostics: [] }),
    reduceEewUnit: (state) => step("U-E", state),
    reduceWeatherCurrentUnit: (state) => step("U-W", state),
    reduceWeatherTimeseriesUnit: (state) => step("U-F", state),
    reduceTsunamiUnit: (state) => step("U-T", state),
    reduceSeismicUnit: (state) => step("U-Q", state),
    reduceNankaiUnit: (state) => step("U-N", state),
    reduceVolcanoUnit: (state) => step("U-V", state),
    reduceLandslideUnit: (state) => step("U-L", state),
    reduceFloodUnit: (state) => step("U-R", state),
  };
  let sequence = 0;
  return { calls: callsWith(stubs), stubs, async update(h: Harness, desired: RuntimeState, clock: ClockReading = h.clock(),
    inputIds: Readonly<Partial<Record<RuntimeUnitId, readonly string[]>>> = {}, byDeadline = false) {
    const { root } = h;
    try { void root.state; } catch {
      await startHarness(h, desired.runId, clock);
    }
    for (const unit of ["U-E", "U-W", "U-F", "U-T", "U-Q", "U-N", "U-V", "U-L", "U-R"] as const) {
      const wanted = desired.units[unit];
      if (fixtureValue(wanted) === "" && wanted.persistence.kind === "saved") continue;
      // One input reaches the wanted generation: with immediate saves (P3-UWR-AC03) one input per generation would save
      // every generation in between, which a test that jumps generations does not describe (P3-UWR-AC10(7)).
      if (root.state.mirror[unit].persistence.currentGeneration < wanted.persistence.currentGeneration) {
        update = only(unit, wanted);
        // Once the mailbox stops taking parser input (shutdown), or with byDeadline (an input the own-save hold would keep,
        // P3-UWR-AC04), the change arrives with a deadline request instead.
        if (!byDeadline && root.mailbox.stats(clock.monotonicMs).accepting)
          await submit(h, envelope(desired.runId, unitBodies[unit].headType, inputIds[unit]?.[0] ?? "adopted-input",
            unitBodies[unit].body, clock, ++sequence));
        else {
          root.tick(clock);
          await h.settle();
        }
      }
    }
    update = null;
    return root.state;
  },
  // Leaves one input per changed unit in the mailbox, not yet handed over: a later drain delivers it and the owner
  // adopts `desired` (any generation step) with these input ids.
  queue(h: Harness, desired: RuntimeState, clock: ClockReading = h.clock(),
    inputIds: Readonly<Partial<Record<RuntimeUnitId, readonly string[]>>> = {}) {
    update = { ...desired.units };
    for (const unit of ["U-E", "U-W", "U-F", "U-T", "U-Q", "U-N", "U-V", "U-L", "U-R"] as const) {
      const wanted = desired.units[unit];
      if (fixtureValue(wanted) === "" && wanted.persistence.kind === "saved") continue;
      const queued = h.root.mailbox.enqueue(envelope(desired.runId, unitBodies[unit].headType,
        inputIds[unit]?.[0] ?? "adopted-input", unitBodies[unit].body, clock, ++sequence));
      if (queued.kind !== "accepted") throw new Error(`mailbox rejected the queued ${unit} input`);
    }
  } };
}

// TEST-PATH (1): the state of one owner, cut from a whole-runtime fixture, for calling the owner core directly.
function ownerFixture(place: ExecutionPlace, whole: RuntimeState = fixtureState()): OwnerState {
  const unit = place === "urgent" ? "U-E" as const : place === "weatherCurrent" ? "U-W" as const : "U-F" as const;
  // urgent owns U-E, U-T, U-Q, U-N and U-V (P3-C5-PLACE=A, P3-C7-PLACE=A, P3-C8-PLACE=A, P3-C9-PLACE=A); each keeps its own admission,
  // deadline and attempt slots.
  const units = unit === "U-E" ? { "U-E": whole.units["U-E"], "U-T": whole.units["U-T"], "U-Q": whole.units["U-Q"], "U-N": whole.units["U-N"],
    "U-V": whole.units["U-V"] }
    : unit === "U-W" ? { "U-W": whole.units["U-W"] } : { "U-F": whole.units["U-F"], "U-L": whole.units["U-L"],
      "U-R": whole.units["U-R"] };
  // deferred owns U-F, U-L and U-R (P3-C10-PLACE=A, P3-C11-PLACE=A).
  const own = unit === "U-E" ? ["U-E", "U-T", "U-Q", "U-N", "U-V"] as const : unit === "U-F" ? ["U-F", "U-L", "U-R"] as const : [unit];
  const pick = <T>(value: (unit: RuntimeUnitId) => T | undefined) => Object.fromEntries(own.flatMap((item) => {
    const found = value(item);
    return found == null ? [] : [[item, found]];
  }));
  return { runId: whole.runId, place, units, admission: pick((item) => whole.admission[item]),
    deadlines: Object.fromEntries(own.map((item) => [item, whole.deadlines[item]])),
    checkpointAttempts: pick((item) => whole.checkpointAttempts[item]), accepting: true, finalized: false };
}

export { ownerFixture, fixtureState, fixtureValue, fixtureDriver, stringCodec, testNotificationChannels, recordingNotificationAdapter };
export type { Fixture };
