import type { ClockReading, NotificationIntent, PersistenceStatus, ReportRef, SubjectOutcome } from "../../../contracts/p2-shared-runtime.types";
import type {
  EewDeliveryRecord,
  EewInput,
  EewNotificationPayload,
  EewUnitCodec,
  EewUnitState,
  EewUnitStep,
  EewUnitView,
  PersistedEewUnit,
} from "../../../contracts/p2-eew-unit.types";
import { dirty, nextEewDeadline, notificationArrayBytes, reduceEew } from "../../domains/eew/eew";

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

function reportRef(value: unknown): value is ReportRef {
  const record = object(value);
  return record != null && typeof record.inputId === "string"
    && (record.origin === "live" || record.origin === "recovery" || record.origin === "replay")
    && operation(record.operation) && typeof record.family === "string" && typeof record.subject === "string"
    && typeof record.reportDateTimeRaw === "string" && typeof record.serialRaw === "string"
    && typeof record.infoTypeRaw === "string";
}

function intent(value: unknown): value is NotificationIntent & Readonly<{ payload: EewNotificationPayload }> {
  const record = object(value);
  const payload = object(record?.payload);
  return record != null && typeof record.id === "string" && record.unit === "U-E"
    && typeof record.subject === "string" && operation(record.operation) && reportRef(record.source)
    && ["activated", "updated", "cancelled", "released", "expired"].includes(String(record.transition))
    && (record.channel === "desktop" || record.channel === "sound")
    && !(record.operation !== "normal" && record.channel === "sound")
    && payload != null && Object.keys(payload).length === 4 && payload.domain === "earthquake-eew"
    && (payload.level === "warning" || payload.level === "critical" || payload.level === "cancel")
    && typeof payload.title === "string" && payload.title.length > 0
    && typeof payload.body === "string" && payload.body.length > 0
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

const generationEnvelopeBytes = generationByteLength({ schemaVersion: SCHEMA, intents: [], deliveryRecords: [] }) - 4;

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
    diagnostics: applied.expired.length === 0 ? [] : [{ level: "INFO", component: "eew",
      reason: "notificationExpired", unit: "U-E", count: applied.expired.length }],
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
  const updated = { ...current, ...input.intentUpdate, disposition };
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
      decision: "changed", reason: null, change: "deliveryOnly", currentEstablished: null }],
    intents: pending ? [updated] : [],
    outcomes: [{ kind: "accepted", change: "deliveryOnly", subjects: [subject(updated, disposition)] }],
    diagnostics: [],
  };
}

function reduceEewUnit(state: EewUnitState, input: EewInput): EewUnitStep {
  let step: EewUnitStep;
  if (input.kind === "receive") step = reduceEew(state, input);
  else if (input.kind === "restore") step = restore(state, input.persisted, input.clock);
  else if (input.kind === "intentUpdate") step = intentUpdate(state, input);
  else {
    const applied = expire(state, input.clock);
    const subjects = applied.expired.map((item) => subject(item, "expired"));
    step = {
      state: applied.state, nextDeadline: nextEewDeadline(applied.state), decisions: applied.expired.map((item) => ({
        subject: item.subject, operation: item.operation, decision: "changed" as const,
        reason: null, change: "deliveryOnly" as const, currentEstablished: null,
      })),
      intents: [],
      outcomes: input.kind === "deadline"
        ? applied.expired.length === 0 ? [] : [{ kind: "deadlineApplied", subjects }]
        : [{ kind: "batchCompleted", reason: "shutdown", subjects }],
      diagnostics: applied.expired.length === 0 ? [] : [{ level: "INFO", component: "eew",
        reason: "notificationExpired", unit: "U-E", count: applied.expired.length }],
    };
  }
  // Rejected/duplicate inputs must preserve the owner's state; deadline reclaims records even without pending intents.
  if (step.state === state && input.kind !== "deadline" && input.kind !== "shutdown") return step;
  let records = step.state.deliveryRecords.filter((record) => record.expiresAt > input.clock.wallTimeMs);
  let bytes = generationEnvelopeBytes + notificationArrayBytes(step.state.intents) + notificationArrayBytes(records);
  if (bytes > GENERATION_BYTES) {
    records.sort((left, right) => left.expiresAt - right.expiresAt);
    let removed = 0;
    while (bytes > GENERATION_BYTES && removed < records.length) {
      bytes -= notificationArrayBytes([records[removed]]) - 2 + (records.length - removed > 1 ? 1 : 0);
      removed++;
    }
    records = records.slice(removed);
  }
  if (records.length === step.state.deliveryRecords.length) return step;
  const next: EewUnitState = {
    ...step.state, deliveryRecords: records,
    persistence: step.state.persistence.currentGeneration === state.persistence.currentGeneration
      ? dirty(step.state.persistence, input.clock.monotonicMs) : step.state.persistence,
  };
  return { ...step, state: next, nextDeadline: nextEewDeadline(next) };
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
    admission: {},
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
        deliveryRecords: value.deliveryRecords, notificationLatches: [], persistence: cleanPersistence(),
      },
    };
  },
};

export { eewUnitCodec, reduceEewUnit, toEewView };
