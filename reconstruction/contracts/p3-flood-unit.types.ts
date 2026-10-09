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

// P3-UNIT-R-001 (C11, I-U-R). 指定河川洪水予報（M13、VXKO50〜89）と水位周知河川に関する情報（VXSU50〜59）。
// 予報区域・発表区間（EventID）ごとの current（D）だけを持つ。報はその EventID の河川・観測所を全部載せるので、新しい報が current を置き換える。

// Headline の「（河川）」Information の Item ごとのまとまり（P3-C11-FACTS）。code は Kind/Code の trim（2 桁の数字）。
// level は Q-ENUM.codeTable（10→0 解除、20・21・22→2、30・31→3、40・41→4、51・53→5）。表に無い code は null で、解除として数えない（fail-bright）。
// rivers は Area の code（数字だけ、16 byte 以下）と name（32 単位をコードポイントの境界で切る）を電文順に。同じ報で Kind/Code は重複しない。
// 上限は P3-C11-BOUNDS=B（作者裁定 2026-10-10 朝）: group 16・河川の延べ 32。超えた分は捨てて truncated（group は段階の低い方から）。
export type FloodRiver = Readonly<{ code: string; name: string }>;

export type FloodKindGroup = Readonly<{
  code: string;
  name: string;
  level: 0 | 2 | 3 | 4 | 5 | null;
  rivers: readonly FloodRiver[];
}>;

// 基準水位（流量）。Criteria の type の段で引く（P3-C11-STATIONS）。無効・欠落は null。単位は観測所の measurement のまま。
export type FloodCriteria = Readonly<{
  level1: number | null;
  level2: number | null;
  level3: number | null;
  level4: number | null;
  level4Plan: number | null;
}>;

// 観測所（P3-C11-STATIONS、R51）。HydrometricStationPart の Area の code（数字だけ、20 byte 以下）と name で一意。
// riverCodes は、各 ChargeSection の text の最初の改行より前（trim）と同じ名前の、切り捨ての後の rivers の code を
// ChargeSection の電文順に重複なく並べたもの（無ければ空。読む ChargeSection は 4 個まで、実配信の最大は 3）。
// values・levels は記録の times と同じ長さで、i=0 が現況、以降が予測。値の無い点は null（欠測を 0 や正常に読み替えない、spec:1468）。
// VXSU は観測 series を持たないので times も values も空（spec:526）。
export type FloodStation = Readonly<{
  code: string;
  name: string;
  riverCodes: readonly string[];
  measurement: "waterLevel" | "discharge";
  criteria: FloodCriteria;
  values: readonly (number | null)[];
  levels: readonly (0 | 1 | 2 | 3 | 4 | 5 | null)[];
}>;

// active の事実。kinds が空なのは河川の段階を一度も読めていない記録（P3-C11-UNKNOWN）。
// basisReportDateTimeRaw は、最新の採用報が河川の段階を持たず前の事実を保ったときの、その事実を出した報の ReportDateTime の raw。
// 最新の報から事実を作ったときは null。
type FloodCurrentFacts = Readonly<{
  effective: "active";
  title: string;
  areaName: string;
  kinds: readonly FloodKindGroup[];
  times: readonly string[];
  stations: readonly FloodStation[];
  basisReportDateTimeRaw: string | null;
  truncated: boolean;
}>;

// EventID の current。subject = `${operation}/${headType}/${eventId}`（P3-C11-SUBJECTS）。
// source は subject の watermark と出典を兼ねる（その subject を変えた最新の採用報。解除・取消を含む）。
// retainUntil は記録を除く時刻: effective によらず source の ReportDateTime + 129,600,000 ms（36 時間、P3-C11-ACTIVE-EXPIRY=D）。
// active の回収では desktop だけの期限切れを 1 件作る。active 以外は事実を持たない。
export type FloodCurrent = Readonly<{
  subject: string;
  operation: Operation;
  headType: string;
  eventId: string;
  source: ReportRef;
  retainUntil: number;
}> & (
  | FloodCurrentFacts
  | Readonly<{ effective: "ended" | "cancelled" }>
);

// 気象の音（sound-design-system.md の分野別根音表）。A7 の群は unit で決まり、U-R は other（P3-C11-NOTICE-GROUP）。
export type FloodNotificationPayload = Readonly<{
  domain: "weather";
  level: "info" | "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type FloodIntent = NotificationIntent & Readonly<{ payload: FloodNotificationPayload }>;

export type FloodUnitState = Readonly<{
  schemaVersion: "p3-flood-unit-v1";
  contentRevision: number;
  currents: readonly FloodCurrent[];
  // Pending and terminal records; terminal ones leave at expiresAt and count in the generation byte budget.
  intents: readonly FloodIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedFloodUnit = Readonly<{
  schemaVersion: "p3-flood-unit-v1";
  currents: readonly FloodCurrent[];
  intents: readonly FloodIntent[];
}>;

// active の current だけを載せる。表示用の観測所の複製や河川ごとの代表観測所は作らない（spec:485 の保存しないもの、P4）。
export type FloodUnitView = SharedUnitView & Readonly<{
  unit: "U-R";
  currents: readonly Extract<FloodCurrent, Readonly<{ effective: "active" }>>[];
}>;

export type FloodInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedFloodUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type FloodUnitStep = Readonly<{
  state: FloodUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // 一入力の subject は EventID の 1 つ（I-U-R.subjects）。識別できない拒否だけ subject は空文字。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly FloodIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type FloodUnitCodec = UnitCodec<FloodUnitState, PersistedFloodUnit> & Readonly<{
  schemaVersion: "p3-flood-unit-v1";
}>;
