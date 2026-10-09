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

// P3-UNIT-L-001 (C10, I-U-L). 土砂災害の警報・注意報（M07、VPWW56 = 気象警報・注意報（Ｒ０６）（土砂））。
// 官署ごとの current（D）だけを持つ。報は官署の市町村等の全区域を載せるので、新しい報が官署の current を置き換える。

// 市町村等の区域の Kind ごとのまとまり（P3-C10-AREAS）。code は Kind/Code の XML 文字列の trim（2 桁の数字）。
// level は公式の警戒レベル（Q-ENUM.codeTable: 29→2、09→3、49→4、39→5）。表に無い code は null で、active に残す（fail-bright）。
// name はその code の電文順で最初の Kind/Name（32 文字で切る、I-U-L.bounds）。areas は市町村等の Area/Code（数字だけ、16 byte 以下）を電文順に持つ
// （Item の Kind は 1 個なので区域は 1 つの group にだけ入る）。
// 区域の名前は持たない（U-W と同じく code だけ。名前は P4 の GIS と、採用時の outcome の facts から）。
export type LandslideKindGroup = Readonly<{
  code: string;
  name: string;
  level: 2 | 3 | 4 | 5 | null;
  areas: readonly string[];
}>;

// active の事実。kinds は level の高い順（null は 3 の直後）、同じ順位は code の昇順。区域の延べは 256 以下、group は 8 以下。
type LandslideCurrentFacts = Readonly<{
  effective: "active";
  title: string;
  kinds: readonly LandslideKindGroup[];
  truncated: boolean;
}>;

// 官署の current。subject = `${operation}/VPWW56/${office}`。office は Control/EditorialOffice（P3-C10-SUBJECTS）。
// source は subject の watermark と出典を兼ねる（その subject を変えた最新の採用報。解除・取消を含む）。
// retainUntil は記録を除く時刻: inactive は source の ReportDateTime + 21,600,000 ms（P3-C10-RETENTION）、active は
// + 172,800,000 ms（P3-C10-ACTIVE-EXPIRY=C、作者裁定）。active 以外は事実を持たない。
export type LandslideCurrent = Readonly<{
  subject: string;
  operation: Operation;
  office: string;
  source: ReportRef;
  retainUntil: number;
}> & (
  | LandslideCurrentFacts
  | Readonly<{ effective: "ended" | "cancelled" }>
);

// 気象の音（sound-design-system.md の分野別根音表）。A7 の群は unit で決まり、U-L は other（P3-C10-NOTICE-GROUP）。
export type LandslideNotificationPayload = Readonly<{
  domain: "weather";
  level: "info" | "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type LandslideIntent = NotificationIntent & Readonly<{ payload: LandslideNotificationPayload }>;

export type LandslideUnitState = Readonly<{
  schemaVersion: "p3-landslide-unit-v1";
  contentRevision: number;
  currents: readonly LandslideCurrent[];
  // Pending and terminal records; terminal ones leave at expiresAt and count in the generation byte budget.
  intents: readonly LandslideIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedLandslideUnit = Readonly<{
  schemaVersion: "p3-landslide-unit-v1";
  currents: readonly LandslideCurrent[];
  intents: readonly LandslideIntent[];
}>;

// active の current だけを載せる。全国の union（VPWS50 の土砂の区域との合成）は作らない（spec:479 の保存しないもの）。
export type LandslideUnitView = SharedUnitView & Readonly<{
  unit: "U-L";
  currents: readonly Extract<LandslideCurrent, Readonly<{ effective: "active" }>>[];
}>;

export type LandslideInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedLandslideUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type LandslideUnitStep = Readonly<{
  state: LandslideUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // 一入力の subject は官署の 1 つ（I-U-L.subjects）。識別できない拒否だけ subject は空文字。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly LandslideIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type LandslideUnitCodec = UnitCodec<LandslideUnitState, PersistedLandslideUnit> & Readonly<{
  schemaVersion: "p3-landslide-unit-v1";
}>;
