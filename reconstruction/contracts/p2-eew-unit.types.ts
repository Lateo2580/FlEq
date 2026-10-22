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
  eventId: string;
  warningClass: "forecast" | "warning";
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
  // P3-LIFETIME-AND-EEW-GATE-001: 非保存。無いと current/gate の期限を nextDeadline に出せず F01 が残る。
  // この版の current の期限（current を作らなかった版・失効後は null、P3-LIFE-SEM-01）。
  currentUntil: number | null;
  // gate の期限（最後に採用した版の起点＋24 時間、P3-LIFE-RET-01）。
  retainUntil: number;
  // [予測全体, warningClass] の JSON の sha256（取消は null）。current の無い同版訂正を見分ける（P3-LIFE-D-F17KEY）。
  predictionKey: string | null; unconfirmed?: ReportRef; // P3-VM-AC04: 未確認の印（gate と同じく非保存、Q-VM-PRECHECK-2A の (1)(c)）
}>;

export type EewNotificationLatch = Readonly<{
  // P2-A4-AC11: operation + validated EventID, never the family-bearing subject.
  eventId: string;
  operation: Operation;
  firstReportNotified: boolean;
  warningNotified: boolean;
  vxse45Accepted: boolean;
  deliveryEvidence: "unattempted" | "possible" | "unknown";
  notifiedMaximumRank: number;
  // Bit n represents the normalized three-digit area Code n (0..999).
  notifiedWarningAreas: bigint;
}>;

// P3-NL-AC04 (1): family ごとの記録。その family で最後に採った版の比べる材料（compareVersion と Serial の例外に渡す欄）と、その版が
// 取消か、その版で作った種類（報・取消、この順）。生値は保存の形にそろえる（40 文字の JSON 1 byte 文字か空、Serial は trim）。
export type EewNoticeFamily = Readonly<{
  family: "VXSE43" | "VXSE45";
  reportDateTimeRaw: string;
  controlDateTimeRaw: string;
  serialRaw: string;
  cancelled: boolean;
  kinds: readonly ("report" | "cancel")[];
}>;

// P3-NL-AC04 (1): U-E の EventID ごとの通知の印（保存する）。latch の欄（区域は bigint の 16 進の文字列、0 は "0"）と、印の期限
// （その EventID で最後に採った版の起点＋24 時間を下げない）と family ごとの記録（VXSE43・VXSE45 の 2 件まで、この順）。
export type EewNoticeMark = Omit<EewNotificationLatch, "notifiedWarningAreas"> & Readonly<{
  notifiedWarningAreas: string;
  retainUntil: number;
  families: readonly EewNoticeFamily[];
}>;

// P2-A4-AC11: both channels carry the same owner-generated payload; A7 reads it unchanged.
// P3-NL-AC12: normal は最終報（H06、earthquake-eew-normal.wav）。
export type EewNotificationPayload = Readonly<{
  domain: "earthquake-eew";
  level: "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type EewUnitState = Readonly<{
  schemaVersion: "p2-eew-unit-v4";
  contentRevision: number;
  current: readonly EewCurrent[];
  gates: readonly EewGate[];
  // Pending only (P3-NL-AC05): a terminal intent leaves and its result stays in the EventID's notice mark.
  intents: readonly (NotificationIntent & Readonly<{ payload: EewNotificationPayload }>)[];
  // P3-NL-AC04: EventID ごとの通知の印（gate と別の寿命、2,048 件まで）。
  notices: readonly EewNoticeMark[];
  // R35: absent means 0; receipt compares this non-persisted wall-clock boundary (restore sets it for 10 minutes).
  evidenceUnknownUntil?: number;
  // P3-EVICT-AC01(7): 非保存。容量の退去で消した normal の gate の報時刻（生値）の family ごとの最大。不在は退去なし。
  evictedNormalReportMs?: Readonly<Partial<Record<EewCurrent["family"], number>>>;
  persistence: PersistenceStatus;
}>;

export type PersistedEewUnit = Readonly<{
  schemaVersion: "p2-eew-unit-v4";
  intents: readonly (NotificationIntent & Readonly<{ payload: EewNotificationPayload }>)[];
  notices: readonly EewNoticeMark[];
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
  intents: readonly (NotificationIntent & Readonly<{ payload: EewNotificationPayload }>)[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type EewUnitCodec = UnitCodec<EewUnitState, PersistedEewUnit> & Readonly<{
  schemaVersion: "p2-eew-unit-v4";
}>;
