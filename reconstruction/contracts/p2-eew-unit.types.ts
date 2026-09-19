import type { DecodedMaterial, MaterialValue, Operation } from "./p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  NotificationIntent,
  NotificationResult,
  PersistenceStatus,
  PublishedOutcome,
  ReportRef,
  RejectionReason,
  UnitCodec,
  UnitView as SharedUnitView,
} from "./p2-shared-runtime.types";

export type EewPredictionIntensity = Readonly<{
  from: MaterialValue;
  to: MaterialValue;
  condition: string | null;
  description: string | null;
}>;

export type EewPredictionArea = Readonly<{
  code: string;
  intensity: EewPredictionIntensity;
}>;

export type EewPrediction = Readonly<{
  maximum: EewPredictionIntensity;
  areaCoverage: "present" | "none";
  areas: readonly EewPredictionArea[];
}>;

export type EewCurrent = Readonly<{
  subject: string;
  operation: Operation;
  family: "VXSE43" | "VXSE44" | "VXSE45";
  source: ReportRef;
  serial: number;
  terminal: boolean;
  prediction: EewPrediction;
}>;

export type EewGate = Readonly<{
  subject: string;
  operation: Operation;
  family: EewCurrent["family"];
  serial: number;
  terminal: boolean;
  source: ReportRef;
}>;

export type EewDeliveryRecord = Readonly<{
  intentId: string;
  disposition: NotificationIntent["disposition"];
  expiresAt: number;
}>;

export type EewUnitState = Readonly<{
  schemaVersion: "p2-eew-unit-v1";
  current: readonly EewCurrent[];
  gates: readonly EewGate[];
  intents: readonly NotificationIntent[];
  deliveryRecords: readonly EewDeliveryRecord[];
  persistence: PersistenceStatus;
}>;

export type PersistedEewUnit = Readonly<{
  schemaVersion: "p2-eew-unit-v1";
  intents: readonly NotificationIntent[];
  deliveryRecords: readonly EewDeliveryRecord[];
}>;

export type EewUnitView = SharedUnitView & Readonly<{
  unit: "U-E";
  activeCount: number;
  current: readonly EewCurrent[];
}>;

export type EewInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; nowMs: number }>
  | Readonly<{ kind: "deadline"; nowMs: number }>
  | Readonly<{ kind: "restore"; persisted: PersistedEewUnit; nowMs: number }>
  | Readonly<{
      kind: "notificationResult";
      result: NotificationResult;
      intentUpdate: Pick<NotificationIntent, "id" | "attempts" | "nextAttemptAt" | "disposition">;
    }>
  | Readonly<{ kind: "shutdown"; nowMs: number }>;

export type EewUnitStep = Readonly<{
  state: EewUnitState;
  // Subject identity includes operation; compare these records with the sequence oracle.
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly" }>
  ))[];
  intents: readonly NotificationIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type EewUnitCodec = UnitCodec<EewUnitState, PersistedEewUnit> & Readonly<{
  schemaVersion: "p2-eew-unit-v1";
}>;
