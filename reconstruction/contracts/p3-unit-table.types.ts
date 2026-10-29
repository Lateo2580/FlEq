import type {
  ClockReading, JsonValue, RuntimeDisplayChange,
  RuntimeUnitId,
  RuntimeUnitInputs,
  RuntimeUnitSteps,
  RuntimeUnitStates,
  RuntimeViews,
  UnitCodec,
  UnitId, UnreadableCard, WallBasis,
} from "./p2-shared-runtime.types";

// P3-UNIT-TABLE-001 (C0). One row per runtime unit; a unit lane adds its own row and nothing else here.
// Per-unit type rows (RuntimeUnitStates/Inputs/Steps/Views) live in p2-shared-runtime.types.ts; keyed maps
// fail to compile when a RuntimeUnitId has no entry, so they are the exhaustiveness check.

// Absence is explicit: a missing codec must not silently mean "not saved" (ledger 52 ③).
export type UnitPersistence<K extends RuntimeUnitId> =
  | Readonly<{ kind: "durable"; codec: UnitCodec<RuntimeUnitStates[K], JsonValue> }>
  | Readonly<{ kind: "ephemeral"; reason: string }>;

// spec §3.2: reduceUnit/toView/encode/decode are reduce, toView and persistence.codec.
// nextDeadline stays on RuntimeUnitSteps[K].nextDeadline (P2-A1 B2); no separate function.
export type UnitModule<K extends RuntimeUnitId> = Readonly<{
  unit: K;
  reduce: (state: RuntimeUnitStates[K], input: RuntimeUnitInputs[K]) => RuntimeUnitSteps[K];
  toView: (state: RuntimeUnitStates[K]) => RuntimeViews[K];
  persistence: UnitPersistence<K>;
  // Former unit-variable branches in shared-runtime.ts (P3 order plan §4.1), one field per branch group.
  confirmationScopeLimit: number;
  reclaimDeadlineBeforeReceive: boolean;
  // P3-REC-AC07・AC12: 取り直しの採用の step の音と正味の表示の変化（owner-runtime が unit を import せずに呼ぶ。import の循環を作らない、台帳 104）。 at.live は採用の直前の live（U-T が候補の作成の外した保存待ちの pending を知る、Q-REC-PRECHECK-6 の N4）。
  recoveryNotices?: (open: RuntimeUnitStates[K], adopted: RuntimeUnitStates[K], at: Readonly<{ recoveryId: string; clock: ClockReading; basis: WallBasis; live: RuntimeUnitStates[K];
    card: Pick<UnreadableCard, "operation" | "receivedAt" | "inputId" | "headType"> | null }>) => RuntimeUnitStates[K];
  recoveryChanges?: (before: RuntimeUnitStates[K], after: RuntimeUnitStates[K]) => readonly RuntimeDisplayChange[];
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
