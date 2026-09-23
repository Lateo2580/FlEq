import type { DecodedMaterial, MaterialValue, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  ClockReading,
  DiagnosticDetails,
  NotificationIntent,
  NotificationIntentUpdate,
  PersistenceStatus,
  PublishedOutcome,
  ReportRef,
  RejectionReason,
  RuntimeUnitDeadline,
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
  family: "VXSE43" | "VXSE45";
  source: ReportRef;
  serial: number;
  terminal: boolean;
  prediction: EewPrediction;
  isAssumedHypocenter: boolean;
  // Non-durable evidence from one report; prediction/source above remain the latest report.
  retainedPrediction: Readonly<{ prediction: EewPrediction; source: ReportRef }> | null;
}>;

export type EewGate = Readonly<{
  subject: string;
  operation: Operation;
  family: EewCurrent["family"];
  serial: number;
  terminal: boolean;
  source: ReportRef;
  noticeSource: Readonly<{ hypocenter: string | null; magnitude: string | null; isAssumedHypocenter: boolean }>;
}>;

export type EewDeliveryRecord = Readonly<{
  intentId: string;
  disposition: NotificationIntent["disposition"];
  expiresAt: number;
}>;

export type EewNotificationLatch = Readonly<{
  // P2-A4-AC11: operation + validated EventID, never the family-bearing subject.
  eventId: string;
  operation: Operation;
  firstReportNotified: boolean;
  warningNotified: boolean;
  vxse45Accepted: boolean;
  deliveryEvidence: "unattempted" | "possible" | "unknown";
  // Evidence predating this latch survives removal of its current/gate owners.
  preexisting: boolean;
  notifiedMaximumRank: number;
  // Bit n represents the normalized three-digit area Code n (0..999).
  notifiedWarningAreas: bigint;
}>;

// P2-A4-AC11: both channels carry the same owner-generated payload; A7 reads it unchanged.
export type EewNotificationPayload = Readonly<{
  domain: "earthquake-eew";
  level: "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type EewUnitState = Readonly<{
  schemaVersion: "p2-eew-unit-v1";
  current: readonly EewCurrent[];
  gates: readonly EewGate[];
  intents: readonly (NotificationIntent & Readonly<{ payload: EewNotificationPayload }>)[];
  deliveryRecords: readonly EewDeliveryRecord[];
  notificationLatches: readonly EewNotificationLatch[];
  // R35: absent means 0; receipt compares this non-persisted wall-clock boundary.
  evidenceUnknownUntil?: number;
  persistence: PersistenceStatus;
}>;

export type PersistedEewUnit = Readonly<{
  schemaVersion: "p2-eew-unit-v1";
  intents: readonly (NotificationIntent & Readonly<{ payload: EewNotificationPayload }>)[];
  deliveryRecords: readonly EewDeliveryRecord[];
}>;

export type EewUnitView = SharedUnitView & Readonly<{
  unit: "U-E";
  activeCount: number;
  current: readonly EewCurrent[];
}>;

export type EewInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedEewUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type EewUnitStep = Readonly<{
  state: EewUnitState;
  nextDeadline: RuntimeUnitDeadline | null;
  // Subject identity includes operation; compare these records with the sequence oracle.
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly (NotificationIntent & Readonly<{ payload: EewNotificationPayload }>)[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type EewUnitCodec = UnitCodec<EewUnitState, PersistedEewUnit> & Readonly<{
  schemaVersion: "p2-eew-unit-v1";
}>;
