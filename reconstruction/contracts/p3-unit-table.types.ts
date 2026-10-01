import type { EewDeliveryRecord } from "./p2-eew-unit.types";
import type {
  JsonValue,
  RuntimeDisplaySubject,
  RuntimeUnitId,
  RuntimeUnitInputs,
  RuntimeUnitSteps,
  RuntimeUnitStates,
  RuntimeViews,
  SubjectOutcome,
  UnitCodec,
  UnitId,
} from "./p2-shared-runtime.types";

// P3-UNIT-TABLE-001 (C0). One row per runtime unit; a unit lane adds its own row and nothing else here.
// Per-unit type rows (RuntimeUnitStates/Inputs/Steps/Views) live in p2-shared-runtime.types.ts; keyed maps
// fail to compile when a RuntimeUnitId has no entry, so they are the exhaustiveness check.

// Absence is explicit: a missing codec must not silently mean "not saved" (ledger 52 ③).
export type UnitPersistence<K extends RuntimeUnitId> =
  | Readonly<{ kind: "durable"; codec: UnitCodec<RuntimeUnitStates[K], JsonValue> }>
  | Readonly<{ kind: "ephemeral"; reason: string }>;

// Where a unit keeps an intent after it leaves pending (shared-runtime.ts:725-727 at 87fc5ed3).
export type TerminalIntentRecords<K extends RuntimeUnitId> =
  | Readonly<{ kind: "intents" }>
  | Readonly<{ kind: "deliveryRecords"; records: (state: RuntimeUnitStates[K]) => readonly EewDeliveryRecord[] }>;

// spec §3.2: reduceUnit/toView/encode/decode are reduce, toView and persistence.codec.
// nextDeadline stays on RuntimeUnitSteps[K].nextDeadline (P2-A1 B2); no separate function.
export type UnitModule<K extends RuntimeUnitId> = Readonly<{
  unit: K;
  reduce: (state: RuntimeUnitStates[K], input: RuntimeUnitInputs[K]) => RuntimeUnitSteps[K];
  toView: (state: RuntimeUnitStates[K]) => RuntimeViews[K];
  persistence: UnitPersistence<K>;
  // Former unit-variable branches in shared-runtime.ts (P3 order plan §4.1), one field per branch group.
  confirmationScopeLimit: number;
  withoutNormal: (state: RuntimeUnitStates[K]) => RuntimeUnitStates[K];
  keepsWhileNormalHidden: (subject: SubjectOutcome) => boolean;
  normalDisplaySubjects: (state: RuntimeUnitStates[K]) => Iterable<Extract<RuntimeDisplaySubject, Readonly<{ unit: K }>>>;
  terminalIntents: TerminalIntentRecords<K>;
  reclaimDeadlineBeforeReceive: boolean;
}>;

export type UnitTable = Readonly<{ [K in RuntimeUnitId]: UnitModule<K> }>;

// Correlated job: unit, state and input are narrowed together by one switch on job.unit.
export type UnitJob = {
  [K in RuntimeUnitId]: Readonly<{ unit: K; state: RuntimeUnitStates[K]; input: RuntimeUnitInputs[K] }>;
}[RuntimeUnitId];

// Coverage: every known headType has exactly one row. Rows absent from the table are "unlisted" at runtime.
export type CoverageRow =
  | Readonly<{ status: "ready"; unit: RuntimeUnitId }>
  | Readonly<{ status: "notPorted"; candidate: UnitId; reason: string }>
  | Readonly<{ status: "ignored"; reason: string }>;

export type CoverageClass = CoverageRow | Readonly<{ status: "unlisted" }>;
