import type { ClockReading, JsonValue, NotificationIntent, PersistenceStatus, ReportRef, SubjectOutcome } from "../../../contracts/p2-shared-runtime.types";
import type {
  EewDeliveryRecord,
  EewInput,
  EewUnitCodec,
  EewUnitState,
  EewUnitStep,
  EewUnitView,
  PersistedEewUnit,
} from "../../../contracts/p2-eew-unit.types";
import { nextEewDeadline, reduceEew } from "../../domains/eew/eew";

const SCHEMA = "p2-eew-unit-v1" as const;
const GENERATION_BYTES = 256 * 1024;
const INTENT_BYTES = 128 * 1024;
const encoder = new TextEncoder();

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function operation(value: unknown): value is NotificationIntent["operation"] {
  return value === "normal" || value === "training" || value === "test";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  const record = object(value);
  return record != null && Object.values(record).every(json);
}

function reportRef(value: unknown): value is ReportRef {
  const record = object(value);
  return record != null && typeof record.inputId === "string"
    && (record.origin === "live" || record.origin === "recovery" || record.origin === "replay")
    && operation(record.operation) && typeof record.family === "string" && typeof record.subject === "string"
    && typeof record.reportDateTimeRaw === "string" && typeof record.serialRaw === "string"
    && typeof record.infoTypeRaw === "string";
}

function intent(value: unknown): value is NotificationIntent {
  const record = object(value);
  return record != null && typeof record.id === "string" && record.unit === "U-E"
    && typeof record.subject === "string" && operation(record.operation) && reportRef(record.source)
    && ["activated", "updated", "cancelled", "released", "expired"].includes(String(record.transition))
    && (record.channel === "desktop" || record.channel === "sound")
    && !(record.operation !== "normal" && record.channel === "sound")
    && object(record.payload) != null && json(record.payload)
    && finite(record.createdAt) && finite(record.expiresAt) && finite(record.nextAttemptAt)
    && Number.isSafeInteger(record.attempts) && Number(record.attempts) >= 0
    && typeof record.configRevision === "string" && record.disposition === "pending"
    && record.expiresAt >= record.createdAt && record.expiresAt - record.createdAt <= 15_000
    && record.source.subject === record.subject && record.source.operation === record.operation;
}

function deliveryRecord(value: unknown): value is EewDeliveryRecord {
  const record = object(value);
  return record != null && typeof record.intentId === "string" && finite(record.expiresAt)
    && (record.disposition === "delivered" || record.disposition === "expired" || record.disposition === "superseded");
}

function generationByteLength(payload: PersistedEewUnit): number {
  return encoder.encode(JSON.stringify({
    schemaVersion: SCHEMA, unit: "U-E", generation: Number.MAX_SAFE_INTEGER,
    capturedAt: Number.MAX_SAFE_INTEGER, payload, sha256: "0".repeat(64),
  })).byteLength;
}

function persisted(value: unknown): PersistedEewUnit | null {
  const record = object(value);
  if (record == null || record.schemaVersion !== SCHEMA || !Array.isArray(record.intents)
    || !Array.isArray(record.deliveryRecords) || record.intents.length > 128
    || !record.intents.every(intent) || !record.deliveryRecords.every(deliveryRecord)) return null;
  const result: PersistedEewUnit = {
    schemaVersion: SCHEMA,
    intents: record.intents,
    deliveryRecords: record.deliveryRecords,
  };
  const pendingIds = new Set(result.intents.map((item) => item.id));
  if (pendingIds.size !== result.intents.length
    || result.deliveryRecords.some((item) => pendingIds.has(item.intentId))) return null;
  if (encoder.encode(JSON.stringify(result.intents)).byteLength > INTENT_BYTES
    || generationByteLength(result) > GENERATION_BYTES) return null;
  return result;
}

function cleanPersistence(): PersistenceStatus {
  return {
    kind: "saved", currentGeneration: 0, savedGeneration: 0,
    savedCapturedAt: null, savedAckAt: null, dirtySince: null,
  };
}

function dirty(persistence: PersistenceStatus, nowMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? nowMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}

function subject(intentValue: NotificationIntent, transition: string): SubjectOutcome {
  return {
    subject: intentValue.subject, operation: intentValue.operation,
    informationType: intentValue.source.infoTypeRaw, transition, severity: null,
    source: intentValue.source, facts: { intentId: intentValue.id, channel: intentValue.channel },
    changedFields: ["intents", "deliveryRecords"],
  };
}

function expire(state: EewUnitState, clock: ClockReading): Readonly<{
  state: EewUnitState;
  expired: readonly NotificationIntent[];
}> {
  const expired = state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= clock.wallTimeMs);
  if (expired.length === 0) return { state, expired };
  const ids = new Set(expired.map((item) => item.id));
  return {
    expired,
    state: {
      ...state,
      intents: state.intents.filter((item) => !ids.has(item.id)),
      deliveryRecords: [...state.deliveryRecords,
        ...expired.map((item) => ({ intentId: item.id, disposition: "expired" as const, expiresAt: item.expiresAt }))],
      persistence: dirty(state.persistence, clock.monotonicMs),
    },
  };
}

function restore(state: EewUnitState, value: PersistedEewUnit, clock: ClockReading): EewUnitStep {
  const decoded = eewUnitCodec.decode(value);
  if (decoded.kind === "invalid") return {
    state, nextDeadline: nextEewDeadline(state),
    decisions: [{ subject: "", operation: "normal", decision: "rejected", reason: "requiredStructureInvalid" }],
    intents: [], outcomes: [], diagnostics: [{ level: "WARN", component: "eew", reason: "requiredStructureInvalid", unit: "U-E" }],
  };
  const base = { ...decoded.state, persistence: state.persistence };
  const applied = expire(base, clock);
  const active = applied.state.intents.filter((item) => item.disposition === "pending" && item.expiresAt > clock.wallTimeMs);
  return {
    state: applied.state, nextDeadline: nextEewDeadline(applied.state), decisions: [], intents: active,
    outcomes: [{ kind: "recoveryApplied", scope: ["U-E"],
      coverage: active.map((item) => item.subject), subjects: active.map((item) => subject(item, "recovered")) }],
    diagnostics: [],
  };
}

function intentUpdate(state: EewUnitState,
  input: Extract<EewInput, { kind: "intentUpdate" }>): EewUnitStep {
  const current = state.intents.find((item) => item.id === input.intentUpdate.id);
  if (current == null || input.intentUpdate.attempts < current.attempts) return {
    state, nextDeadline: nextEewDeadline(state), decisions: [],
    intents: [], outcomes: [], diagnostics: [],
  };
  const disposition = input.clock.wallTimeMs >= current.expiresAt
    ? "expired" as const : input.intentUpdate.disposition;
  const updated: NotificationIntent = { ...current, ...input.intentUpdate, disposition };
  if (JSON.stringify(updated) === JSON.stringify(current)) return {
    state, nextDeadline: nextEewDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [],
  };
  const pending = disposition === "pending";
  const next: EewUnitState = {
    ...state,
    intents: pending
      ? state.intents.map((item) => item.id === updated.id ? updated : item)
      : state.intents.filter((item) => item.id !== updated.id),
    deliveryRecords: pending ? state.deliveryRecords : [...state.deliveryRecords,
      { intentId: updated.id, disposition, expiresAt: updated.expiresAt }],
    persistence: dirty(state.persistence, input.clock.monotonicMs),
  };
  return {
    state: next, nextDeadline: nextEewDeadline(next),
    decisions: [{ subject: current.subject, operation: current.operation,
      decision: "changed", reason: null, change: "deliveryOnly" }],
    intents: pending ? [updated] : [],
    outcomes: [{ kind: "accepted", change: "deliveryOnly", subjects: [subject(updated, disposition)] }],
    diagnostics: [],
  };
}

function reduceEewUnit(state: EewUnitState, input: EewInput): EewUnitStep {
  if (input.kind === "receive") return reduceEew(state, input);
  if (input.kind === "restore") return restore(state, input.persisted, input.clock);
  if (input.kind === "intentUpdate") return intentUpdate(state, input);
  const applied = expire(state, input.clock);
  if (input.kind === "deadline" && applied.expired.length === 0) return {
    state, nextDeadline: nextEewDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [],
  };
  const subjects = applied.expired.map((item) => subject(item, "expired"));
  return {
    state: applied.state, nextDeadline: nextEewDeadline(applied.state), decisions: applied.expired.map((item) => ({
      subject: item.subject, operation: item.operation, decision: "changed" as const,
      reason: null, change: "deliveryOnly" as const,
    })),
    intents: [],
    outcomes: input.kind === "deadline"
      ? [{ kind: "deadlineApplied", subjects }]
      : [{ kind: "batchCompleted", reason: "shutdown", subjects }],
    diagnostics: [],
  };
}

function toEewView(state: EewUnitState): EewUnitView {
  const subjects: SubjectOutcome[] = state.current.map((current) => ({
    subject: current.subject, operation: current.operation,
    informationType: current.source.infoTypeRaw, transition: "active", severity: null,
    source: current.source,
    facts: { family: current.family, serial: current.serial,
      prediction: current.prediction, retainedPrediction: current.retainedPrediction },
    changedFields: [],
  }));
  return {
    unit: "U-E",
    semanticRevision: state.gates.map((gate) =>
      `${gate.subject}:${gate.serial}:${gate.terminal ? 1 : 0}:${gate.source.reportDateTimeRaw}`).join("|"),
    persistence: state.persistence,
    subjects,
    activeCount: state.current.length,
    current: state.current,
  };
}

const eewUnitCodec: EewUnitCodec = {
  schemaVersion: SCHEMA,
  encode(state) {
    const value: PersistedEewUnit = {
      schemaVersion: SCHEMA,
      intents: state.intents,
      deliveryRecords: state.deliveryRecords,
    };
    if (persisted(value) == null) throw new Error("U-E checkpoint exceeds its persisted boundary");
    return value;
  },
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p2-eew-unit-v1 payload" } : {
      kind: "restored",
      state: {
        schemaVersion: SCHEMA, current: [], gates: [], intents: value.intents,
        deliveryRecords: value.deliveryRecords, persistence: cleanPersistence(),
      },
    };
  },
};

export { eewUnitCodec, reduceEewUnit, toEewView };
