import type {
  ClockReading, JsonValue, PersistenceStatus, RuntimeState, RuntimeUnitId, RuntimeUnitStates, UnitCodec, UnitId,
} from "../../contracts/p2-shared-runtime.types";
import type { CompositionOptions, RuntimeCompositionRoot } from "../../src/runtime/composition-root";

type Fixture = Readonly<{ value: string; intentExpiresAt?: number; activeFixture?: string | null }>;
const saved: PersistenceStatus = { kind: "saved", currentGeneration: 1, savedGeneration: 1,
  savedCapturedAt: 0, savedAckAt: 0, dirtySince: null };

// Test payloads carry bytes only; no production unit semantics are implemented here.
function fixtureState(values: Partial<Record<RuntimeUnitId, Fixture | string>> = {},
  persistence: Readonly<Partial<Record<RuntimeUnitId, PersistenceStatus>>> = {}, runId = "review"): RuntimeState {
  const payload = (unit: RuntimeUnitId) => typeof values[unit] === "string"
    ? { value: values[unit] } : values[unit] ?? { value: "" };
  const progress = (unit: RuntimeUnitId) => persistence[unit] ?? saved;
  return {
    runId,
    units: {
      "U-E": { ...payload("U-E"), schemaVersion: "p2-eew-unit-v1", current: [], gates: [], intents: [],
        deliveryRecords: [], persistence: progress("U-E") },
      "U-W": { ...payload("U-W"), schemaVersion: "p2-weather-current-unit-v1", national: {}, partials: [],
        histories: [], ownership: {}, tombstones: [], freshness: [], unavailable: [], intents: [], persistence: progress("U-W") },
      "U-F": { ...payload("U-F"), schemaVersion: "p2-weather-timeseries-unit-v1", subjects: [], gates: [],
        intents: [], persistence: progress("U-F") },
    },
    checkpointAttempts: {}, deadlines: { "U-E": { monotonicMs: 0, wallTimeMs: null },
      "U-W": { monotonicMs: 0, wallTimeMs: null }, "U-F": { monotonicMs: 0, wallTimeMs: null } },
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
  return { schemaVersion: "review-v1", encode: fixtureValue,
    decode: (payload) => typeof payload === "string"
      ? { kind: "restored", state: fixtureState({ [unit]: payload }).units[unit] }
      : { kind: "invalid", reason: "not a string" } };
}

function fixtureDriver() {
  let update: RuntimeState | null = null;
  const step = <U extends RuntimeUnitId>(unit: U, previous: RuntimeUnitStates[U]) => ({
    state: update != null && fixtureValue(update.units[unit]) !== ""
      && (fixtureValue(update.units[unit]) !== fixtureValue(previous)
        || update.units[unit].persistence.currentGeneration !== previous.persistence.currentGeneration)
      ? update.units[unit] : previous,
    decisions: [], intents: [], outcomes: [], diagnostics: [],
    nextDeadline: { monotonicMs: 0, wallTimeMs: null },
  });
  const calls: CompositionOptions["runtimeCalls"] = {
    reduceEewUnit: (state) => step("U-E", state),
    reduceWeatherCurrentUnit: (state) => step("U-W", state),
    reduceWeatherTimeseriesUnit: (state) => step("U-F", state),
  };
  return { calls, update(root: RuntimeCompositionRoot, desired: RuntimeState, clock: ClockReading,
    correlations: Parameters<RuntimeCompositionRoot["dispatch"]>[2] = {}) {
    update = desired;
    try {
      const input = { kind: "deadline", clock } as const;
      return root.dispatch(desired, { kind: "mailboxCompleted", clock, completion: {
        kind: "control", messageId: "test-update", runId: desired.runId, encodedByteLength: 0,
        startedMonotonicMs: clock.monotonicMs, completedMonotonicMs: clock.monotonicMs, control: input,
      } }, correlations).state;
    } finally { update = null; }
  } };
}

export { fixtureState, fixtureValue, fixtureDriver, stringCodec };
export type { Fixture };
