import type { DecodedMaterial, MaterialValue, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  CurrentConfirmationEvidence,
  ClockReading, WallBasis,
  DiagnosticDetails,
  FailureMark,
  NoticeMark,
  NotificationIntent,
  NotificationIntentUpdate,
  PersistenceStatus,
  PublishedOutcome,
  ReportRef,
  RuntimeDisplayChange,
  RejectionReason,
  RuntimeUnitDeadline,
  SubjectUnavailable,
  UnitCodec,
  UnitView as SharedUnitView,
  MarkViewed,
  UnreadableMark,
} from "./p2-shared-runtime.types";

// P3-TSUNAMI-UNIT-001 (C5, I-U-T). Category/Kind/Code table (questionResolutions[Q-ENUM]):
// 52/53 majorWarning, 51 warning, 62 advisory, 71/72/73 forecast, 50/60 released, 00 none.
// "unknown" is a code outside the table (P3-C5-KIND-ENUM=B, author ruling 2026-10-06; ranked as warning).
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
  // P3-CC-AC03: 容量で更新できなかった報。印のある active の記録だけが鍵を持つ。
  unavailable?: SubjectUnavailable; unconfirmed?: ReportRef; // P3-VM-AC04: 未確認の印。印のある記録だけが鍵を持つ
  notice?: NoticeMark; // P3-NL-AC02: 通知の印（記録と同じに生きる）。印のある記録だけが鍵を持ち、表示には出さない
  unreadable?: UnreadableMark; // P3-UM-AC01: 読めなかった所の印（site は TsunamiUnreadableSite）。取消の記録は持たない
}>;

// P3-UM-AC01 (2): 印の site の表（domain の warn の所の名）。codec は表の外の site を読まない。
export type TsunamiUnreadableSite = "serial" | "forecastHeight" | "station" | "estimation";

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
  source: ReportRef; controlDateTimeRaw: string; // P3-VM-D-SAME-REPORT=A: 別の報と比べる Control/DateTime（採った同じ報の fragment の最大、読めなければ空）
  effective: "active" | "cancelled" | "forecastEnded" | "expired";
  stations: readonly TsunamiStation[];
  estimations: readonly TsunamiEstimation[];
  validUntil: number | null;
  retainUntil: number | null; unconfirmed?: ReportRef; // P3-VM-AC04: 未確認の印。印のある記録だけが鍵を持つ
  notice?: NoticeMark; // P3-NL-AC02・AC03: 通知の印（fragment の鍵を持つ）。表示には出さない
  expiryPending?: true; // P3-EF-AC06 (1): 時計を確かめる前に validUntil が来た active の観測の印（観測点と推定区域は残し、view から外す）
  // P3-UM-AC01 (3)(6): 読めなかった所の印。観測点・推定区域の part（scope はその code）は要素と一緒に次の版へ引き継ぐ。取消・期限切れは持たない。
  unreadable?: UnreadableMark;
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
  schemaVersion: "p3-tsunami-unit-v6";
  contentRevision: number;
  forecasts: readonly TsunamiForecastSubject[];
  observations: readonly TsunamiObservationSubject[];
  // Pending only (P3-NL-AC05): a terminal intent leaves and its result stays in the series' notice mark.
  intents: readonly TsunamiIntent[];
  failureMarks: readonly FailureMark[];
  persistence: PersistenceStatus;
}>;

export type PersistedTsunamiUnit = Readonly<{
  schemaVersion: "p3-tsunami-unit-v6";
  forecasts: readonly TsunamiForecastSubject[];
  observations: readonly TsunamiObservationSubject[];
  intents: readonly TsunamiIntent[];
  failureMarks: readonly FailureMark[];
}>;

// Active subjects only; inactive watermarks stay in the state.
export type TsunamiUnitView = SharedUnitView & Readonly<{
  unit: "U-T";
  forecasts: readonly MarkViewed<TsunamiForecastSubject>[];
  observations: readonly MarkViewed<TsunamiObservationSubject>[];
}>;

export type TsunamiInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "deadline"; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "restore"; persisted: PersistedTsunamiUnit; clock: ClockReading; basis?: WallBasis }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading; basis?: WallBasis }>;

export type TsunamiUnitStep = Readonly<{
  state: TsunamiUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // Subject identity includes operation; compare these records with the sequence oracle.
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded" }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly TsunamiIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type TsunamiUnitCodec = UnitCodec<TsunamiUnitState, PersistedTsunamiUnit> & Readonly<{
  schemaVersion: "p3-tsunami-unit-v6";
}>;
