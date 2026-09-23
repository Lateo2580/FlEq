import type {
  ClockReading, JsonValue, PersistenceStatus, RuntimeState, RuntimeUnitId, RuntimeUnitStates, UnitCodec, UnitId,
} from "../../contracts/p2-shared-runtime.types";
import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { CompositionOptions, RuntimeCompositionRoot } from "../../src/runtime/composition-root";

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

// Test payloads carry bytes only; no production unit semantics are implemented here.
function fixtureState(values: Partial<Record<RuntimeUnitId, Fixture | string>> = {},
  persistence: Readonly<Partial<Record<RuntimeUnitId, PersistenceStatus>>> = {}, runId = "review"): RuntimeState {
  const payload = (unit: RuntimeUnitId) => typeof values[unit] === "string"
    ? { value: values[unit] } : values[unit] ?? { value: "" };
  const progress = (unit: RuntimeUnitId) => persistence[unit] ?? saved;
  return {
    runId,
    restoration: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } },
    admission: {},
    units: {
      "U-E": { ...payload("U-E"), schemaVersion: "p2-eew-unit-v1", current: [], gates: [], intents: [],
        deliveryRecords: [], notificationLatches: [], persistence: progress("U-E") },
      "U-W": { ...payload("U-W"), schemaVersion: "p2-weather-current-unit-v1", national: {}, partials: [],
        histories: [], ownership: {}, tombstones: [], freshness: [], unavailable: [], intents: [], persistence: progress("U-W") },
      "U-F": { ...payload("U-F"), schemaVersion: "p2-weather-timeseries-unit-v1", subjects: [], gates: [],
        intents: [], persistence: progress("U-F") },
    },
    checkpointAttempts: {}, deadlines: { "U-E": { monotonicMs: 0, wallTimeMs: null },
      "U-W": { monotonicMs: 0, wallTimeMs: null }, "U-F": { monotonicMs: 0, wallTimeMs: null } },
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

function fixtureDriver() {
  let update: RuntimeState | null = null;
  const step = <U extends RuntimeUnitId>(unit: U, previous: RuntimeUnitStates[U]) => ({
    state: update != null && fixtureValue(update.units[unit]) !== ""
      && (fixtureValue(update.units[unit]) !== fixtureValue(previous)
        || update.units[unit].persistence.currentGeneration !== previous.persistence.currentGeneration)
      ? update.units[unit] : previous,
    decisions: update != null && update.units[unit].persistence.currentGeneration > previous.persistence.currentGeneration
      ? [{ subject: "fixture", operation: "normal" as const, decision: "changed" as const,
        reason: null, change: "semantic" as const, currentEstablished: null }] : [],
    intents: [], outcomes: [], diagnostics: [],
    nextDeadline: { monotonicMs: 0, wallTimeMs: null },
  });
  const calls: CompositionOptions["runtimeCalls"] = {
    selectNotificationAttempt: (state) => ({ state, attempts: [], abortRequests: [], diagnostics: [] }),
    reduceEewUnit: (state) => step("U-E", state),
    reduceWeatherCurrentUnit: (state) => step("U-W", state),
    reduceWeatherTimeseriesUnit: (state) => step("U-F", state),
  };
  return { calls, update(root: RuntimeCompositionRoot, desired: RuntimeState, clock: ClockReading,
    correlations: Parameters<RuntimeCompositionRoot["dispatch"]>[2] = {}) {
    try { void root.state; } catch { root.startRuntime(desired.runId, clock, testNotificationChannels); }
    for (const unit of ["U-E", "U-W", "U-F"] as const) {
      const headType = unit === "U-E" ? "VXSE43" : unit === "U-W" ? "VPWW57" : "VPWP50";
      const target = desired.units[unit];
      if (fixtureValue(target) === "" && target.persistence.kind === "saved") continue;
      const previous = root.state.units[unit];
      const start = previous.persistence.currentGeneration;
      const end = target.persistence.currentGeneration;
      for (let generation = start + 1; generation <= end; generation++) {
        update = { ...root.state, units: { ...root.state.units, [unit]: {
          ...target, persistence: { ...target.persistence, currentGeneration: generation },
        } } };
        const inputId = correlations?.[unit]?.inputIds[0] ?? "adopted-input";
        const material = { headType, inputId } as DecodedMaterial;
        const completion = root.state.shutdown.stage === "running" || root.state.shutdown.stage === "mailboxDrain"
          ? { kind: "parser" as const, messageId: inputId, inputId, runId: desired.runId, inputSequence: generation,
            encodedByteLength: 0, startedMonotonicMs: clock.monotonicMs,
            completedMonotonicMs: clock.monotonicMs, result: { kind: "decoded" as const, material } }
          : { kind: "control" as const, messageId: "test-deadline", runId: desired.runId,
            encodedByteLength: 0, startedMonotonicMs: clock.monotonicMs,
            completedMonotonicMs: clock.monotonicMs, control: { kind: "deadline" as const, clock } };
        root.dispatch(root.state, { kind: "mailboxCompleted", clock, completion });
      }
    }
    update = null;
    return root.state;
  } };
}

export { fixtureState, fixtureValue, fixtureDriver, stringCodec, testNotificationChannels, recordingNotificationAdapter };
export type { Fixture };
