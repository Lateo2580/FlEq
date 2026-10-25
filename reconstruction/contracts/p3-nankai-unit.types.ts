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
// validUntil は source の ReportDateTime + 7×86,400,000 ms（P3-C8-RETENTION、JST の暦日は使わない）。
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
  | (Readonly<{ line: "nankai"; status: NankaiCurrentStatus }> & NankaiCurrentFacts)
  | (Readonly<{ line: "VYSE60"; status: "subsequentAdvisory" }> & NankaiCurrentFacts)
  | Readonly<{ line: "nankai"; effective: "ended" | "cancelled" | "expired" }>
  | Readonly<{ line: "VYSE60"; effective: "cancelled" | "expired" }>
);

export type NankaiCurrentLine = NankaiCurrent["line"];

// 情報系列（N、事実は保存しない）。subject = `${operation}/${family}/${eventId}`。採用した全ての報が入る
// （現況を変える報は、現況が採用したときだけ）。cancelled は事実を捨てて source だけ残し、view に載らない。
// 文字列の上限（I-U-N.bounds）: title 128、headline 512、text 4,096、nextAdvisory 512、infoKind 64 文字。
// retainUntil は ReportDateTime + 7×86,400,000 ms（P3-C8-RETENTION）。
type NankaiInformationIdentity = Readonly<{
  subject: string;
  family: NankaiReportFamily;
  eventId: string;
  operation: Operation;
  retainUntil: number;
  // P3-NL-AC02 (2): 情報系列の通知の印。情報の本文は保存しないが、印は証拠と一緒に保存する。表示には出さない。
  notice?: NoticeMark;
}>;
type NankaiInformationBase = NankaiInformationIdentity & Readonly<{ source: ReportRef; unconfirmed?: ReportRef }>; // P3-VM-AC04: 情報系列の印は事実と同じく保存しない（spec:512 の N。保存すると上界が予算を越える、AC08）
type NankaiInformationHeading = Readonly<{
  effective: "active";
  infoKind: string | null;
  infoSerial: NankaiInfoSerial | null;
  title: string;
  headline: string | null;
  truncated: boolean;
}>;
// 受理の証拠（P3-AUTH-AC01）: 情報 subject の版の比較に要るものだけ。保存し、復元で証拠だけの情報 subject に戻る。
export type NankaiEvidence = Readonly<{
  subject: string;
  reportDateTimeMs: number;
  serialRaw: string;
  infoTypeRaw: string; controlDateTimeRaw: string; // P3-VM-AC01: 比べる材料の Control/DateTime
  notice?: NoticeMark; // P3-NL-AC02 (2): 保存の形だけが持つ（記録の notice の写し）
}>;
// evidence は復元した証拠だけの記録で、事実も source も持たず view・outcome・表示の変化に出ない。
export type NankaiInformation =
  | (NankaiInformationBase & (
    | (NankaiInformationHeading & Readonly<{ text: string | null; nextAdvisory: string | null }>)
    | Readonly<{ effective: "cancelled" }>
  ))
  | (NankaiInformationIdentity & Readonly<{ effective: "evidence"; evidence: NankaiEvidence }>);

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
  schemaVersion: "p3-nankai-unit-v5";
  contentRevision: number;
  currents: readonly NankaiCurrent[];
  // N: 事実は保存しない。復元の後は証拠だけの記録から始まる（spec:512、P3-AUTH-AC01）。
  information: readonly NankaiInformation[];
  // Pending only (P3-NL-AC05): a terminal intent leaves and its result stays in the series' notice mark.
  intents: readonly NankaiIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedNankaiUnit = Readonly<{
  schemaVersion: "p3-nankai-unit-v5";
  currents: readonly NankaiCurrent[];
  intents: readonly NankaiIntent[];
  // 64 件以下・subject の重複なし。鍵の無い保存物は invalid（旧保存は版で捨てる、P3-VM-AC08）。
  evidence: readonly NankaiEvidence[];
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
  schemaVersion: "p3-nankai-unit-v5";
}>;
