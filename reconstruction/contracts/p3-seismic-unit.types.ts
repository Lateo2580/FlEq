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

// P3-UNIT-Q-001 (C7, I-U-Q). 地震（M02）は operation・EventID ごとの event に family ごとの寄与を持ち、
// 長周期（M03、VXSE62）は同じ EventID の別 subject にする（I-U-Q.subjects）。
export type EarthquakeFamily = "VXSE51" | "VXSE52" | "VXSE53" | "VXSE61";

// 震源。深さは km。欠落（missing）と 0 を区別し、「600km以上」は下限 range（P1 の MaterialValue と同じ種類）。
// depthConflict は Coordinate の数値と description の範囲が食い違うとき true（数値を採る。Q-ENUM.invalid）。
export type SeismicHypocenter = Readonly<{
  originTimeRaw: string | null;
  arrivalTimeRaw: string | null;
  name: string | null;
  code: string | null;
  coordinateRaw: string | null;
  latitude: MaterialValue;
  longitude: MaterialValue;
  depthKm: MaterialValue;
  depthConflict: boolean;
  magnitude: MaterialValue;
  magnitudeType: string | null;
  magnitudeCondition: string | null;
  magnitudeDescription: string | null;
}>;

// 震度・長周期階級の値。From/To を持つ MaxInt（synthetic_phase4a_VXSE51_special の Pref）だけ fromTo、ほかは P1 の MaterialValue のまま。
// 段階と safety rank は I-U-Q.intensityScale の 1 つの表で決める。
export type SeismicIntensityValue = MaterialValue | Readonly<{ kind: "fromTo"; from: MaterialValue; to: MaterialValue }>;

// Intensity/Observation の Pref・Area・City・IntensityStation を一列にした要素。code が null の要素は名前で表示し、
// 区域の鍵・差分に使わない（P3-C5-KIND-ENUM=B の型）。値は P1 の MaterialValue のまま（全角・未入電の下限 range・
// 空・欠落・unknown を区別する）。
export type SeismicIntensityItem = Readonly<{
  level: "pref" | "area" | "city" | "station";
  code: string | null;
  name: string;
  parentCode: string | null;
  maxInt: SeismicIntensityValue;
  maxLgInt: SeismicIntensityValue;
}>;

export type SeismicIntensityObservation = Readonly<{
  maxInt: SeismicIntensityValue;
  maxLgInt: SeismicIntensityValue;
  lgCategory: string | null;
  items: readonly SeismicIntensityItem[];
}>;

// Comments/ForecastComment の固定付加文。未確認を「なし」にしない（spec:1466）ので、欠落は null。
export type SeismicTsunamiComment = Readonly<{ codes: readonly string[]; text: string | null }>;

// family ごとの最新の採用報。source が family の watermark と取消記憶を兼ねる。cancelled は事実を捨てて source だけ残し、
// title は空文字、ほかは null（取消記憶の byte の上限を件数から決めるため、P3-C7-CAPACITY）。
// targetDateTimeRaw は Head/TargetDateTime。Body に OriginTime の無い VXSE51 の発生時刻に使う（I-U-Q.originTime）。
export type EarthquakeContribution = Readonly<{
  family: EarthquakeFamily;
  source: ReportRef;
  effective: "active" | "cancelled";
  targetDateTimeRaw: string | null;
  title: string;
  headline: string | null;
  hypocenter: SeismicHypocenter | null;
  intensity: SeismicIntensityObservation | null;
  tsunamiComment: SeismicTsunamiComment | null;
}>;

// 強震保持の根拠（event が導いた全体の震度が既知の段階の 7、event の発生時刻から 12 時間。旧築 QUAKE_EXTREME_HOLD_MS）。
export type StrongShakingHold = Readonly<{
  originTimeRaw: string;
  until: number;
  establishedBy: Pick<ReportRef, "family" | "reportDateTimeRaw" | "serialRaw" | "infoTypeRaw">;
}>;

// 一つの地震。contributions は family ごとに最大 1 件。retainUntil = 最新の採用報の ReportDateTime + 24 時間。
export type EarthquakeEvent = Readonly<{
  eventId: string;
  operation: Operation;
  contributions: readonly EarthquakeContribution[];
  strongHold: StrongShakingHold | null;
  retainUntil: number;
}>;

// VXSE62。subject = `${operation}/VXSE62/${eventId}`。retainUntil = 最新の採用報の ReportDateTime + 36 時間。
// cancelled は寄与と同じく事実を持たない（title は空文字、headline・hypocenter・intensity は null）。
export type LongPeriodSubject = Readonly<{
  subject: string;
  eventId: string;
  operation: Operation;
  source: ReportRef;
  effective: "active" | "cancelled";
  title: string;
  headline: string | null;
  hypocenter: SeismicHypocenter | null;
  intensity: SeismicIntensityObservation | null;
  retainUntil: number;
}>;

// 当日地震履歴（operation ごと。日の基準は P3-C7-DAILY-BASIS）。件数と最大震度は全体の震度が既知の段階（I-U-Q.intensityScale）の
// event だけを数え、取消で減らさない。recent は新しい順に最大 5 行、countedEventIds は最大 2048 件（P3-C7-DAILY）。
// 文字列の上限（P3-C7-DAILY）: originTimeRaw・reportDateTimeRaw は 40 文字を超えたら null、hypocenterName は 64 文字に切り詰め、
// magnitude・maxInt の raw と value は 32 文字に切り詰める。1 行の最大は 1,166 byte（I-U-Q.capacityReserve）。
export type SeismicRecentQuake = Readonly<{
  eventId: string;
  originTimeRaw: string | null;
  reportDateTimeRaw: string | null;
  hypocenterName: string | null;
  magnitude: MaterialValue;
  maxInt: SeismicIntensityValue;
  cancelled: boolean;
}>;

export type SeismicDailyHistory = Readonly<{
  dayKey: string | null;
  count: number;
  maxInt: MaterialValue | null;
  countedEventIds: readonly string[];
  recent: readonly SeismicRecentQuake[];
}>;

// 地震・EEW の音（sound-design-system.md の分野別根音表）。A7 の優先群は unit で決め、domain では決めない（P3-C7-NOTICE-GROUP）。
export type SeismicNotificationPayload = Readonly<{
  domain: "earthquake-eew";
  level: "info" | "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type SeismicIntent = NotificationIntent & Readonly<{ payload: SeismicNotificationPayload }>;

export type SeismicUnitState = Readonly<{
  schemaVersion: "p3-seismic-unit-v1";
  contentRevision: number;
  earthquakes: readonly EarthquakeEvent[];
  longPeriods: readonly LongPeriodSubject[];
  daily: Readonly<Record<Operation, SeismicDailyHistory>>;
  // Pending and terminal records; terminal ones leave at expiresAt and count in the generation byte budget.
  intents: readonly SeismicIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedSeismicUnit = Readonly<{
  schemaVersion: "p3-seismic-unit-v1";
  earthquakes: readonly EarthquakeEvent[];
  longPeriods: readonly LongPeriodSubject[];
  daily: Readonly<Record<Operation, SeismicDailyHistory>>;
  intents: readonly SeismicIntent[];
}>;

// event の公開事実（I-U-Q.earthquakeSemantics）。subject は event の鍵 `${operation}/earthquake/${eventId}` で、判定の
// family subject とは別（RuntimeDisplaySubject と表示差分の鍵）。originTimeRaw は OriginTime、無ければ VXSE51 の Head/TargetDateTime。
// tsunamiCommentFamily が VXSE51 のときは「今後の情報に注意」などで、津波の評価ではない。
export type EarthquakeEventView = Readonly<{
  subject: string;
  eventId: string;
  operation: Operation;
  sources: readonly ReportRef[];
  originTimeRaw: string | null;
  hypocenter: SeismicHypocenter | null;
  intensity: SeismicIntensityObservation | null;
  tsunamiComment: SeismicTsunamiComment | null;
  tsunamiCommentFamily: "VXSE51" | "VXSE52" | "VXSE53" | null;
  strongHold: StrongShakingHold | null;
}>;

// active な event と長周期 subject だけを載せる。取消済みの寄与だけになった event は載せない。
export type SeismicUnitView = SharedUnitView & Readonly<{
  unit: "U-Q";
  earthquakes: readonly EarthquakeEventView[];
  longPeriods: readonly LongPeriodSubject[];
  daily: Readonly<Record<Operation, SeismicDailyHistory>>;
}>;

export type SeismicInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedSeismicUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type SeismicUnitStep = Readonly<{
  state: SeismicUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // subject は family の subject（`${operation}/${headType}/${eventId}`、sequences の期待と同じ）。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly SeismicIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type SeismicUnitCodec = UnitCodec<SeismicUnitState, PersistedSeismicUnit> & Readonly<{
  schemaVersion: "p3-seismic-unit-v1";
}>;
