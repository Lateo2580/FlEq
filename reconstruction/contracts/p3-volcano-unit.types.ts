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

// P3-UNIT-V-001 (C9, I-U-V). 火山（M14 警報・M15 噴火・M16 降灰と短命情報）。三 slice（D）と、保存しない
// 定時降灰・解説（N）を一つの unit に置く（spec:484、:550）。
// VFSV は配信の headType（coverage の VFSV50〜61）。corpus の VFSVii は file 名の略記で、配信されない（P3-C0-MANIFEST-EXCEPTION）。
export type VolcanoMarineFamily =
  | "VFSV50" | "VFSV51" | "VFSV52" | "VFSV53" | "VFSV54" | "VFSV55"
  | "VFSV56" | "VFSV57" | "VFSV58" | "VFSV59" | "VFSV60" | "VFSV61";
export type VolcanoAlertFamily = "VFVO50" | "VFVO51" | VolcanoMarineFamily;
export type VolcanoReportFamily =
  | VolcanoAlertFamily | "VFVO52" | "VFVO53" | "VFVO54" | "VFVO55" | "VFVO56" | "VFVO60" | "VZVO40";

// Kind の code は XML の文字列の trim（P1 は "13" を number にするので使わない、Q-ENUM.codeTable）。
export type VolcanoKind = Readonly<{ code: string; name: string; condition: string | null }>;
// 対象市町村・対象海上予報区は Kind の名前ごとに code だけを持つ（名前は P4 の GIS と outcome の facts から。I-U-V.bounds）。
export type VolcanoAreaGroup = Readonly<{ kindName: string; codes: readonly string[] }>;

// 記録の共通部。source は subject の watermark と出典を兼ねる（その subject を変えた最新の採用報）。
// retainUntil は記録を除く時刻（source の ReportDateTime から、P3-C9-RETENTION）。
type VolcanoRecordBase = Readonly<{
  subject: string;
  operation: Operation;
  eventId: string;
  source: ReportRef;
  retainUntil: number;
}>;

// 警報（M14、D）。subject = `${operation}/volcano:alert/${volcanoCode}`。VFVO50・VFVO51 の火山 entry・VFSV が同じ subject を更新する。
// active は P3-C9-ALERT-ACTIVE の有効な区分だけ。active の間は期限で消えない（警報は解除の報まで続く）。
type VolcanoAlertFacts = Readonly<{
  effective: "active";
  volcanoName: string;
  kind: VolcanoKind;
  lastKind: Readonly<{ code: string; name: string }> | null;
  // 11〜15 の code だけが数値の level を持つ。非数値の区分（22・23・36 など）は null。
  level: 2 | 3 | 4 | 5 | null;
  headline: string | null;
  municipalities: readonly VolcanoAreaGroup[];
  marineAreas: readonly VolcanoAreaGroup[];
  coordinate: string | null;
  truncated: boolean;
}>;
// 警報だけは watermark を family ごとに持つ（P3-C9-MARINE=A）: source は VFVO50・VFVO51、marineSource は VFSV。
// 少なくとも一方は非 null で、retainUntil は新しい方の ReportDateTime から数える。
// landKind は source の family（VFVO50・VFVO51）が最後に伝えた区分（source が null か、VFVO50 の取消の後は null）。VFSV の取消の後に
// active が残るかを、残る family が自分の区分で支えるかで決める（Q-C9-IMPL-AMEND(9)(a)）。
// eventId は記録の最新の書き手の EventID（表示・outcome）。landEventId（source と組）・marineEventId（marineSource と組）は
// family ごとの取消の identity で、火山コードの無い取消はこれで結び付く。null はその側が無いか、旧保存で分からない（P3-AUTH-AC03・AC06）。
export type VolcanoAlert = Readonly<{
  subject: string;
  operation: Operation;
  volcanoCode: string;
  eventId: string;
  source: ReportRef | null;
  marineSource: ReportRef | null;
  landEventId: string | null;
  marineEventId: string | null;
  landKind: VolcanoKind | null;
  retainUntil: number;
}> & (
  | VolcanoAlertFacts
  | Readonly<{ effective: "ended" | "cancelled" }>
);

// 噴火（M15、D）。subject = `${operation}/volcano:eruption/${eventId}`（VFVO52・VFVO56 で共通、P3-C9-ERUPTION-SUBJECT）。
// volcanoCode は報の火山コード（EventID からは推測しない）。null は未受信の対象の取消の記憶だけ。
// validUntil は source の ReportDateTime + 86,400,000 ms（旧築 volcano-state.ts の DAY_MS）。
type VolcanoEruptionFacts = Readonly<{
  effective: "active";
  volcanoName: string;
  flash: boolean;
  phenomenon: Readonly<{ code: string; name: string }>;
  eventDateTimeRaw: string | null;
  craterName: string | null;
  plumeAboveCrater: MaterialValue;
  plumeAboveSeaLevel: MaterialValue;
  plumeDirection: string | null;
  headline: string | null;
  municipalities: readonly string[];
  truncated: boolean;
  validUntil: number;
}>;
export type VolcanoEruption = VolcanoRecordBase & (
  | (Readonly<{ volcanoCode: string }> & VolcanoEruptionFacts)
  | Readonly<{ volcanoCode: string | null; effective: "cancelled" | "expired" }>
);

// 降灰予報の速報・詳細（M16、D）。subject = `${operation}/volcano:ashfall/${volcanoCode}`、VFVO54/55 の共通系列。
// forecastEndsAt の到来で expired（旧築 sweep の forecastEndsAtMs）。group と地域の形は旧築 volcano-ashfall-projector.ts の投影。
export type VolcanoAshfallGroup = Readonly<{
  hazardClass: "ballistic" | "ash" | "unknown";
  ashCode: string;
  ashName: string;
  areaCount: number;
  topAreas: readonly Readonly<{ code: string | null; name: string; firstForecastEndAt: number }>[];
  omittedAreaCount: number;
}>;
type VolcanoAshfallFacts = Readonly<{
  effective: "active";
  volcanoName: string;
  variant: "VFVO54" | "VFVO55";
  headline: string | null;
  forecastStartsAt: number;
  forecastEndsAt: number;
  groups: readonly VolcanoAshfallGroup[];
  omittedGroupCount: number;
  truncated: boolean;
}>;
export type VolcanoAshfall = VolcanoRecordBase & Readonly<{ volcanoCode: string }> & (
  | VolcanoAshfallFacts
  | Readonly<{ effective: "cancelled" | "expired" }>
);

// 定時の降灰予報（VFVO53、N）。subject = `${operation}/VFVO53/${volcanoCode}`。重複判定と batch の材料だけで、view に載らない。
export type VolcanoScheduledAshfall = VolcanoRecordBase & Readonly<{
  volcanoCode: string;
  effective: "active" | "cancelled";
  volcanoName: string;
  // 最も重い降灰の区分名（通知の body、旧築 buildAshfallSummary）。
  topAshName: string | null;
}>;

// VFVO53 の待機 batch（N、spec:582）。鍵は運用区分と ReportDateTime。quiet・maxWait は単調時計で数える（時計の逆行で止まらない）。
export type VolcanoAshfallBatch = Readonly<{
  operation: Operation;
  reportDateTimeRaw: string;
  startedAtMonotonicMs: number;
  lastAtMonotonicMs: number;
  subjects: readonly string[];
}>;

// 解説・短命情報（VFVO51・VFVO60・VZVO40、N）。subject = `${operation}/${family}/${eventId}`（P3-C9-BULLETIN）。
type VolcanoBulletinBase = Readonly<{
  subject: string;
  family: "VFVO51" | "VFVO60" | "VZVO40";
  eventId: string;
  operation: Operation;
  source: ReportRef;
  retainUntil: number;
}>;
type VolcanoBulletinHeading = Readonly<{
  effective: "active";
  title: string;
  headline: string | null;
  volcanoCodes: readonly string[];
  extraordinary: boolean;
  truncated: boolean;
}>;
export type VolcanoBulletin = VolcanoBulletinBase & (
  | (VolcanoBulletinHeading & Readonly<{ text: string | null; nextAdvisory: string | null }>)
  | Readonly<{ effective: "cancelled" }>
);
// view・snapshot には見出しだけを載せる（本文を外す、P3-C9-SNAPSHOT）。
export type VolcanoBulletinView = VolcanoBulletinBase & VolcanoBulletinHeading;

// 復旧不足（D、spec:484「取消・復旧不足」、P3-C9-SHORTFALL）。作るのは移行（C15）だけで、live の受理では作らない。
export type VolcanoShortfall = Readonly<{
  id: string;
  operation: Operation;
  slice: "alert" | "eruption" | "ashfall";
  // volcano は火山 1 つ、domain は slice 全体の不足。volcanoCode は volcano のときだけ非 null。
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  lastKnown: Readonly<{ reportDateTimeRaw: string; serialRaw: string }> | null;
  reason: "provenanceMissing" | "sliceCorrupt" | "gateCorrupt" | "operationUnknown" | "terminalQuarantine";
}>;

// 火山の音（sound-design-system.md の分野別根音表、G4）。
export type VolcanoNotificationPayload = Readonly<{
  domain: "volcano";
  level: "info" | "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type VolcanoIntent = NotificationIntent & Readonly<{ payload: VolcanoNotificationPayload }>;

export type VolcanoUnitState = Readonly<{
  schemaVersion: "p3-volcano-unit-v1";
  contentRevision: number;
  alerts: readonly VolcanoAlert[];
  eruptions: readonly VolcanoEruption[];
  ashfalls: readonly VolcanoAshfall[];
  shortfalls: readonly VolcanoShortfall[];
  // N: 保存しない。復元の後は空から始まる（spec:484、:504）。
  scheduledAshfalls: readonly VolcanoScheduledAshfall[];
  batch: VolcanoAshfallBatch | null;
  bulletins: readonly VolcanoBulletin[];
  // Pending and terminal records; terminal ones leave at expiresAt and count in the generation byte budget.
  intents: readonly VolcanoIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedVolcanoUnit = Readonly<{
  schemaVersion: "p3-volcano-unit-v1";
  alerts: readonly VolcanoAlert[];
  eruptions: readonly VolcanoEruption[];
  ashfalls: readonly VolcanoAshfall[];
  shortfalls: readonly VolcanoShortfall[];
  intents: readonly VolcanoIntent[];
}>;

// active の三 slice、解説の見出し、復旧不足を載せる。unavailable・復旧不足を「警報なし」に読み替えない。
export type VolcanoUnitView = SharedUnitView & Readonly<{
  unit: "U-V";
  alerts: readonly Extract<VolcanoAlert, Readonly<{ effective: "active" }>>[];
  eruptions: readonly Extract<VolcanoEruption, Readonly<{ effective: "active" }>>[];
  ashfalls: readonly Extract<VolcanoAshfall, Readonly<{ effective: "active" }>>[];
  bulletins: readonly VolcanoBulletinView[];
  shortfalls: readonly VolcanoShortfall[];
}>;

export type VolcanoInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedVolcanoUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  // 復旧不足の明示解決（P3-C9-SHORTFALL）。CLI の volcanorepair からの結線は C18。
  | Readonly<{ kind: "shortfallResolution"; id: string; action: "acceptCurrent" | "clearCurrent" | "acknowledgeDomainLoss"; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type VolcanoUnitStep = Readonly<{
  state: VolcanoUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // subject は I-U-V.subjects の形。VFVO51 は火山 entry ごとの警報 subject と解説 subject の両方を返す。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly VolcanoIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type VolcanoUnitCodec = UnitCodec<VolcanoUnitState, PersistedVolcanoUnit> & Readonly<{
  schemaVersion: "p3-volcano-unit-v1";
}>;
