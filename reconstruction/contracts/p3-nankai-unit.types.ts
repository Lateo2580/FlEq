import type { DecodedMaterial, Operation } from "./p1-parser-boundary.types";
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

// P3-UNIT-N-001 (C8, I-U-N). 南海トラフ（M05）。現況（D、spec:511）と情報系列（N、spec:512）を分ける。
export type NankaiReportFamily = "VYSE50" | "VYSE51" | "VYSE52" | "VYSE60";

// InfoSerial/Code の表（questionResolutions[Q-ENUM].codeTable、旧築 nankai-status.ts）で決まる南海トラフの現況の区分。
// investigating は P3-C8-INVESTIGATING=A（作者裁定）で作る。VYSE60 の系統は subsequentAdvisory だけ（型で縛る）。
export type NankaiCurrentStatus = "investigating" | "megaquakeWarning" | "megaquakeAdvisory";

// 報自身の InfoSerial。code は XML の文字列を trim したもの（P1 は "120" を number にするので使わない、Q-ENUM.codeTable）。
export type NankaiInfoSerial = Readonly<{ code: string; name: string | null }>;

// active の現況の事実。文字列の上限（I-U-N.bounds）: title 128 文字、headline 512 文字。超えたら切り詰めて truncated=true。
// validUntil は source の ReportDateTime + 7×86,400,000 ms（P3-C8-RETENTION、JST の暦日は使わない）。
type NankaiCurrentFacts = Readonly<{
  effective: "active";
  infoSerial: NankaiInfoSerial | null;
  title: string;
  headline: string | null;
  truncated: boolean;
  validUntil: number;
}>;

// 現況。subject = `${operation}/${line}/current`、operation と系統ごとに 1 件。source は系統の watermark と取消記憶を兼ね、
// 現況を変えた最新の採用報（調査終了・取消を含む）で、source.family は報の headType、source.subject は現況の subject。
// eventId は source の EventID（spec:511 の出典 EventID）。取消・訂正は source と同じ headType・EventID のときだけ現況に効く。
// active 以外は事実を持たない。ended は南海トラフの調査中の調査終了だけ（VYSE60 には無い）。
// retainUntil は watermark の保持で、source の ReportDateTime + 30 日。
export type NankaiCurrent = Readonly<{
  subject: string;
  operation: Operation;
  eventId: string;
  source: ReportRef;
  retainUntil: number;
}> & (
  | (Readonly<{ line: "nankai"; status: NankaiCurrentStatus }> & NankaiCurrentFacts)
  | (Readonly<{ line: "VYSE60"; status: "subsequentAdvisory" }> & NankaiCurrentFacts)
  | Readonly<{ line: "nankai"; effective: "ended" | "cancelled" | "expired" }>
  | Readonly<{ line: "VYSE60"; effective: "cancelled" | "expired" }>
);

export type NankaiCurrentLine = NankaiCurrent["line"];

// 情報系列（N、保存しない）。subject = `${operation}/${family}/${eventId}`。採用した全ての報が入る
// （現況を変える報は、現況が採用したときだけ）。cancelled は事実を捨てて source だけ残し、view に載らない。
// 文字列の上限（I-U-N.bounds）: title 128、headline 512、text 4,096、nextAdvisory 512、infoKind 64 文字。
// retainUntil は ReportDateTime + 7×86,400,000 ms（P3-C8-RETENTION）。
type NankaiInformationBase = Readonly<{
  subject: string;
  family: NankaiReportFamily;
  eventId: string;
  operation: Operation;
  source: ReportRef;
  retainUntil: number;
}>;
type NankaiInformationHeading = Readonly<{
  effective: "active";
  infoKind: string | null;
  infoSerial: NankaiInfoSerial | null;
  title: string;
  headline: string | null;
  truncated: boolean;
}>;
export type NankaiInformation = NankaiInformationBase & (
  | (NankaiInformationHeading & Readonly<{ text: string | null; nextAdvisory: string | null }>)
  | Readonly<{ effective: "cancelled" }>
);

// view・snapshot に載せる情報は見出しだけ（本文の text・nextAdvisory を外す。snapshot の予算、P3-C8-SNAPSHOT）。
export type NankaiInformationView = NankaiInformationBase & NankaiInformationHeading;

// 地震・EEW の音（sound-design-system.md の分野別根音表）。A7 の群は unit で決まり、U-N は other（P3-C7-NOTICE-GROUP）。
export type NankaiNotificationPayload = Readonly<{
  domain: "earthquake-eew";
  level: "info" | "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type NankaiIntent = NotificationIntent & Readonly<{ payload: NankaiNotificationPayload }>;

export type NankaiUnitState = Readonly<{
  schemaVersion: "p3-nankai-unit-v1";
  contentRevision: number;
  currents: readonly NankaiCurrent[];
  // N: 保存しない。復元の後は空から始まる（spec:512）。
  information: readonly NankaiInformation[];
  // Pending and terminal records; terminal ones leave at expiresAt and count in the generation byte budget.
  intents: readonly NankaiIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedNankaiUnit = Readonly<{
  schemaVersion: "p3-nankai-unit-v1";
  currents: readonly NankaiCurrent[];
  intents: readonly NankaiIntent[];
}>;

// active の現況と active の情報の見出しだけを載せる。VYSE60（北海道・三陸沖後発地震注意情報）は南海トラフの現況を
// 上書きしない別の系統（P3-C8-VYSE60=A）。
export type NankaiUnitView = SharedUnitView & Readonly<{
  unit: "U-N";
  currents: readonly Extract<NankaiCurrent, Readonly<{ effective: "active" }>>[];
  information: readonly NankaiInformationView[];
}>;

export type NankaiInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedNankaiUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type NankaiUnitStep = Readonly<{
  state: NankaiUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // subject は現況（`${operation}/${line}/current`）か情報（`${operation}/${family}/${eventId}`）。
  // 現況を変える報は両方の判定を返す（I-U-N.subjects）。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly NankaiIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type NankaiUnitCodec = UnitCodec<NankaiUnitState, PersistedNankaiUnit> & Readonly<{
  schemaVersion: "p3-nankai-unit-v1";
}>;
