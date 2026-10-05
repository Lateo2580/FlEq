import type { DecodedMaterial, MaterialValue, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  CurrentConfirmationEvidence,
  ClockReading,
  DiagnosticDetails,
  NotificationIntent,
  NotificationIntentUpdate,
  PersistenceStatus,
  PublishedOutcome,
  ReportRef,
  RuntimeDisplayChange,
  RejectionReason,
  RuntimeUnitDeadline,
  UnitCodec,
  UnitView as SharedUnitView,
} from "./p2-shared-runtime.types";

// P3-TSUNAMI-UNIT-001 (C5, I-U-T). Category/Kind/Code table (questionResolutions[Q-ENUM]):
// 52/53 majorWarning, 51 warning, 62 advisory, 71/72/73 forecast, 50/60 released, 00 none.
// "unknown" is a code outside the table, kept only under P3-C5-KIND-ENUM=B (ranked as warning).
export type TsunamiAreaClass = "majorWarning" | "warning" | "advisory" | "forecast" | "released" | "none" | "unknown";

// Per area between the subject's previous adopted report and this one (questionResolutions[P3-C5-E01-SERIES]).
export type TsunamiAreaTransition = "issued" | "expanded" | "upgraded" | "downgraded" | "released";

export type TsunamiTransitionRecord = Readonly<{
  areaCode: string;
  from: TsunamiAreaClass;
  to: TsunamiAreaClass;
  transition: TsunamiAreaTransition;
}>;

// "mixed" reports carry both directions; §7.5 samples use only escalation or deescalation inputs.
export type TsunamiReportSeries = "escalation" | "deescalation" | "mixed" | "none";

export type TsunamiHeight = Readonly<{
  value: MaterialValue;
  condition: string | null;
  description: string | null;
}>;

export type TsunamiForecastArea = Readonly<{
  code: string;
  name: string;
  // Derived from kindCode by the Q-ENUM table; decode rejects a mismatch.
  areaClass: TsunamiAreaClass;
  kindCode: string;
  kindName: string;
  firstHeight: Readonly<{ arrivalTimeRaw: string | null; condition: string | null }>;
  maxHeight: TsunamiHeight | null;
}>;

// Area/Item without Area/Code under P3-C5-KIND-ENUM=B: shown by name and counted for effective and the remaining level, never keyed or diffed.
export type TsunamiUnkeyedArea = Readonly<{ name: string; kindCode: string; kindName: string }>;

// subject = `${operation}/VTSE41/${eventId}`. released keeps its (forecast-only) areas; only cancelled has areas = [].
export type TsunamiForecastSubject = Readonly<{
  subject: string;
  eventId: string;
  operation: Operation;
  source: ReportRef;
  effective: "active" | "released" | "cancelled";
  areas: readonly TsunamiForecastArea[];
  unkeyedAreas: readonly TsunamiUnkeyedArea[];
  retainUntil: number | null;
}>;

export type TsunamiObservationFamily = "VTSE51" | "VTSE52";

export type TsunamiStation = Readonly<{
  code: string;
  name: string;
  areaCode: string | null;
  areaName: string | null;
  sensor: string | null;
  firstHeight: Readonly<{ arrivalTimeRaw: string | null; initial: string | null; condition: string | null }>;
  maxHeight: Readonly<{ dateTimeRaw: string | null; condition: string | null; height: TsunamiHeight | null }>;
  // Revision of the adopted report that last set this station (same-revision fragment and correction rules).
  revision: Pick<ReportRef, "reportDateTimeRaw" | "serialRaw" | "infoTypeRaw">;
}>;

// VTSE52 Body/Tsunami/Estimation/Item; always [] for VTSE51.
export type TsunamiEstimation = Readonly<{
  areaCode: string;
  areaName: string;
  firstHeight: Readonly<{ arrivalTimeRaw: string | null; condition: string | null }>;
  maxHeight: Readonly<{ condition: string | null; height: TsunamiHeight | null }>;
}>;

// subject = `${operation}/tsunamiObservation:${family}/${eventId}`; source is the family watermark.
// forecastEnded keeps stations (only the view drops it); cancelled and expired keep the watermark only.
export type TsunamiObservationSubject = Readonly<{
  subject: string;
  eventId: string;
  operation: Operation;
  family: TsunamiObservationFamily;
  source: ReportRef;
  effective: "active" | "cancelled" | "forecastEnded" | "expired";
  stations: readonly TsunamiStation[];
  estimations: readonly TsunamiEstimation[];
  validUntil: number | null;
  retainUntil: number | null;
}>;

// Both channels carry the same owner-generated payload; A7 maps domain/level to the sound and the priority group.
export type TsunamiNotificationPayload = Readonly<{
  domain: "tsunami";
  level: "info" | "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type TsunamiIntent = NotificationIntent & Readonly<{ payload: TsunamiNotificationPayload }>;

export type TsunamiUnitState = Readonly<{
  schemaVersion: "p3-tsunami-unit-v1";
  contentRevision: number;
  forecasts: readonly TsunamiForecastSubject[];
  observations: readonly TsunamiObservationSubject[];
  // Pending and terminal records; terminal ones leave at expiresAt and count in the generation byte budget.
  intents: readonly TsunamiIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedTsunamiUnit = Readonly<{
  schemaVersion: "p3-tsunami-unit-v1";
  forecasts: readonly TsunamiForecastSubject[];
  observations: readonly TsunamiObservationSubject[];
  intents: readonly TsunamiIntent[];
}>;

// Active subjects only; inactive watermarks stay in the state.
export type TsunamiUnitView = SharedUnitView & Readonly<{
  unit: "U-T";
  forecasts: readonly TsunamiForecastSubject[];
  observations: readonly TsunamiObservationSubject[];
}>;

export type TsunamiInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedTsunamiUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type TsunamiUnitStep = Readonly<{
  state: TsunamiUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // Subject identity includes operation; compare these records with the sequence oracle.
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly TsunamiIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type TsunamiUnitCodec = UnitCodec<TsunamiUnitState, PersistedTsunamiUnit> & Readonly<{
  schemaVersion: "p3-tsunami-unit-v1";
}>;
