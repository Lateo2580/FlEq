import type { DecodedMaterial, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  CurrentConfirmationEvidence,
  ClockReading, WallBasis,
  DiagnosticDetails,
  NoticeMark,
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
// validUntil は source の ReportDateTime + 7×86,400,000 ms（P3-C8-RETENTION、JST の暦日は使わない）。warningUntil を持つ現況は +14 日（P3-NS-AC03）。
type NankaiCurrentFacts = Readonly<{
  effective: "active";
  infoSerial: NankaiInfoSerial | null;
  title: string;
  headline: string | null;
  truncated: boolean;
  validUntil: number;
  expiryPending?: true; // P3-EF-AC04・AC05 (1): 時計を確かめる前に validUntil が来た印（view から外し、事実と通知の印は残す）
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
  retainUntil: number; unconfirmed?: ReportRef; // P3-VM-AC04: 系統の未確認の印。取消・期限で事実の消えた現況には無い
  notice?: NoticeMark; // P3-NL-AC02: 系統の通知の印（記録と同じに生きる）。表示には出さない
}> & (
  // P3-NS-AC03: warningUntil（ReportDateTime + 7 日）は巨大地震警戒の現況だけが持ち、巨大地震注意へ移った後も残す。
  | (Readonly<{ line: "nankai"; status: NankaiCurrentStatus; warningUntil?: number }> & NankaiCurrentFacts)
  | (Readonly<{ line: "VYSE60"; status: "subsequentAdvisory" }> & NankaiCurrentFacts)
  | Readonly<{ line: "nankai"; effective: "ended" | "cancelled" | "expired" }>
  | Readonly<{ line: "VYSE60"; effective: "cancelled" | "expired" }>
);

export type NankaiCurrentLine = NankaiCurrent["line"];

// 情報系列（全文を保存する、P3-NS-AC01）。subject = `${operation}/${family}/${eventId}`。採用した全ての報が入る
// （現況を変える報は、現況が採用したときだけ）。cancelled と expired（表示の期限の後の記憶、P3-NS-AC04）は事実を捨てて source だけ残し、
// view に載らない。文字列の上限（I-U-N.bounds）: title 128、headline 512、text 4,096、nextAdvisory 512、infoKind 64 文字。
// validUntil は ReportDateTime + 7 日（P3-NS-SEM-03）、retainUntil は + 30 日（P3-NS-SEM-04）。
type NankaiInformationBase = Readonly<{
  subject: string;
  family: NankaiReportFamily;
  eventId: string;
  operation: Operation;
  source: ReportRef;
  retainUntil: number;
  unconfirmed?: ReportRef; // P3-VM-AC04・P3-NS-AC02: 情報 subject の未確認の印（保存する）
  notice?: NoticeMark; // P3-NL-AC02 (2): 情報系列の通知の印（記録と同じに生きる）。表示には出さない
}>;
type NankaiInformationHeading = Readonly<{
  effective: "active";
  infoKind: string | null;
  infoSerial: NankaiInfoSerial | null;
  title: string;
  headline: string | null;
  truncated: boolean;
  validUntil: number;
  expiryPending?: true; // P3-EF-AC02 (2)・Q-NS-PRECHECK (0)(c): 時計を確かめる前に validUntil が来た印（view から外し、本文と印は残す）
}>;
export type NankaiInformation = NankaiInformationBase & (
  | (NankaiInformationHeading & Readonly<{ text: string | null; nextAdvisory: string | null }>)
  | Readonly<{ effective: "cancelled" | "expired" }>
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
  schemaVersion: "p3-nankai-unit-v6";
  contentRevision: number;
  currents: readonly NankaiCurrent[];
  information: readonly NankaiInformation[];
  // Pending only (P3-NL-AC05): a terminal intent leaves and its result stays in the series' notice mark.
  intents: readonly NankaiIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedNankaiUnit = Readonly<{
  schemaVersion: "p3-nankai-unit-v6";
  currents: readonly NankaiCurrent[];
  intents: readonly NankaiIntent[];
  // 64 件以下・subject の重複なし（P3-NS-AC01）。鍵の無い保存物は invalid（旧保存は版で捨てる、P3-NS-AC08）。
  information: readonly NankaiInformation[];
}>;

// active の現況と active の情報の見出しだけを載せる。VYSE60（北海道・三陸沖後発地震注意情報）は南海トラフの現況を
// 上書きしない別の系統（P3-C8-VYSE60=A）。
export type NankaiUnitView = SharedUnitView & Readonly<{
  unit: "U-N";
  currents: readonly Extract<NankaiCurrent, Readonly<{ effective: "active" }>>[];
  information: readonly NankaiInformationView[];
}>;

export type NankaiInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "deadline"; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "restore"; persisted: PersistedNankaiUnit; clock: ClockReading; basis?: WallBasis }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading; basis?: WallBasis }>;

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
  schemaVersion: "p3-nankai-unit-v6";
}>;
