import type {
  AcquisitionOrigin,
  DecodedMaterial,
  Operation,
  ParserMailboxItem,
  ParserMailboxResult,
} from "./p1-parser-boundary.types";
import type { EewCurrent, EewInput, EewUnitState, EewUnitStep } from "./p2-eew-unit.types";
import type { EewUnitView } from "./p2-eew-unit.types";
import type { NotificationDeliveryState, NotificationPriorityGroup, NotificationSelection } from "./p2-notification-delivery.types";
import type { WeatherCurrentInput, WeatherCurrentSnapshot, WeatherCurrentUnitState, WeatherCurrentUnitStep } from "./p2-weather-current-unit.types";
import type { WeatherCurrentUnitView } from "./p2-weather-current-unit.types";
import type { WeatherTimeseriesInput, WeatherTimeseriesPublicSubject, WeatherTimeseriesUnitState, WeatherTimeseriesUnitStep } from "./p2-weather-timeseries-unit.types";
import type { WeatherTimeseriesUnitView } from "./p2-weather-timeseries-unit.types";
import type { TsunamiForecastSubject, TsunamiInput, TsunamiObservationSubject, TsunamiUnitState, TsunamiUnitStep, TsunamiUnitView } from "./p3-tsunami-unit.types";
import type { EarthquakeEventView, LongPeriodSubject, SeismicInput, SeismicUnitState, SeismicUnitStep, SeismicUnitView } from "./p3-seismic-unit.types";
import type { NankaiCurrent, NankaiInformationView, NankaiInput, NankaiUnitState, NankaiUnitStep, NankaiUnitView } from "./p3-nankai-unit.types";
import type { VolcanoAlert, VolcanoAshfall, VolcanoBulletinView, VolcanoEruption, VolcanoInput, VolcanoUnitState, VolcanoUnitStep, VolcanoUnitView } from "./p3-volcano-unit.types";
import type { LandslideCurrent, LandslideInput, LandslideUnitState, LandslideUnitStep, LandslideUnitView } from "./p3-landslide-unit.types";
import type { FloodCurrent, FloodInput, FloodUnitState, FloodUnitStep, FloodUnitView } from "./p3-flood-unit.types";
import type { BriefingInput, BriefingUnitState, BriefingUnitStep, BriefingUnitView } from "./p3-briefing-unit.types";
import type { LocalBulletinsInput, LocalBulletinsUnitState, LocalBulletinsUnitStep, LocalBulletinsUnitView } from "./p3-local-bulletins-unit.types";
import type { TyphoonInput, TyphoonUnitState, TyphoonUnitStep, TyphoonUnitView } from "./p3-typhoon-unit.types";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export type UnitId =
  | "U-E" | "U-Q" | "U-T" | "U-N" | "U-W" | "U-L"
  | "U-F" | "U-B" | "U-M" | "U-Y" | "U-V" | "U-R";

export type RuntimeUnitId = "U-E" | "U-W" | "U-F" | "U-T" | "U-Q" | "U-N" | "U-V" | "U-L" | "U-R" | "U-B" | "U-M" | "U-Y";

// Per-unit type rows (one line per map). P3-UNIT-TABLE-001 keeps them adjacent and line-neutral:
// a unit lane adds its key to each of the three maps below.
export type RuntimeUnitStates = Readonly<{ "U-E": EewUnitState; "U-W": WeatherCurrentUnitState; "U-F": WeatherTimeseriesUnitState; "U-T": TsunamiUnitState; "U-Q": SeismicUnitState; "U-N": NankaiUnitState; "U-V": VolcanoUnitState; "U-L": LandslideUnitState; "U-R": FloodUnitState; "U-B": BriefingUnitState; "U-M": LocalBulletinsUnitState; "U-Y": TyphoonUnitState }>;
export type RuntimeUnitInputs = Readonly<{ "U-E": EewInput; "U-W": WeatherCurrentInput; "U-F": WeatherTimeseriesInput; "U-T": TsunamiInput; "U-Q": SeismicInput; "U-N": NankaiInput; "U-V": VolcanoInput; "U-L": LandslideInput; "U-R": FloodInput; "U-B": BriefingInput; "U-M": LocalBulletinsInput; "U-Y": TyphoonInput }>;
export type RuntimeUnitSteps = Readonly<{ "U-E": EewUnitStep; "U-W": WeatherCurrentUnitStep; "U-F": WeatherTimeseriesUnitStep; "U-T": TsunamiUnitStep; "U-Q": SeismicUnitStep; "U-N": NankaiUnitStep; "U-V": VolcanoUnitStep; "U-L": LandslideUnitStep; "U-R": FloodUnitStep; "U-B": BriefingUnitStep; "U-M": LocalBulletinsUnitStep; "U-Y": TyphoonUnitStep }>;

export type ClockReading = Readonly<{
  wallTimeMs: number;
  monotonicMs: number;
}>;

export type RuntimeUnitDeadline = Readonly<{
  // Either non-null deadline reaching its clock is sufficient; neither means outer null.
  wallTimeMs: number | null;
  monotonicMs: number | null;
}>;

export type RejectionReason =
  | "headMissing"
  | "reportDateTimeMissing"
  | "reportDateTimeInvalid"
  | "identityMissing"
  | "identityInvalid"
  | "requiredStructureMissing"
  | "requiredStructureInvalid";

export type SemanticEnvelope = Readonly<{
  material: DecodedMaterial;
  reportDateTimeMs: number;
}>;

export type SemanticEnvelopeResult =
  | Readonly<{ kind: "accepted"; envelope: SemanticEnvelope }>
  | Readonly<{ kind: "rejected"; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

export type ReportRef = Readonly<{
  inputId: string;
  origin: AcquisitionOrigin;
  operation: Operation;
  family: string;
  subject: string;
  reportDateTimeRaw: string; controlDateTimeRaw: string; // P3-VM-AC01: 比べる材料の Control/DateTime（無ければ空文字）。保存と復元まで運ぶ（H14）
  serialRaw: string;
  infoTypeRaw: string;
}>;

export type SaveFailureStage =
  | "encode" | "write" | "fileSync" | "close" | "rename" | "directorySync" | "verify";

export type SaveProgress = Readonly<{
  currentGeneration: number;
  savedGeneration: number | null;
  savedCapturedAt: number | null;
  savedAckAt: number | null;
  // Same-run clock.monotonicMs; startup cleanup uses the startup input clock.
  dirtySince: number | null;
}>;

export type PersistenceStatus =
  | (SaveProgress & Readonly<{ kind: "saved" }>)
  | (SaveProgress & Readonly<{ kind: "pending" }>)
  | (SaveProgress & Readonly<{ kind: "failed"; stage: SaveFailureStage; reason: string }>)
  | (SaveProgress & Readonly<{ kind: "uncertain"; attemptedGeneration: number }>);

export type NotificationTransition = "activated" | "updated" | "cancelled" | "released" | "expired";

export type NotificationIntent = Readonly<{
  id: string;
  unit: UnitId;
  subject: string;
  operation: Operation;
  source: ReportRef;
  transition: NotificationTransition;
  channel: "desktop" | "sound";
  // U-E keys/value domain: A4 EewNotificationPayload; other families keep their owner contract.
  payload: Readonly<Record<string, JsonValue>>;
  createdAt: number;
  expiresAt: number;
  nextAttemptAt: number;
  attempts: number;
  configRevision: string;
  disposition: "pending" | "delivered" | "expired" | "superseded";
  // P3-NL-AC06 (1): 試行の状態（null は試行していない）。started は予約の採用で付き、復元で残っていれば通知したか不明（P3-NL-AC08）。
  lastAttempt: "started" | "failed" | null;
  // P3-NL-AC06 (2): 1 回の鳴らし直しを使ったか（無いと上位群に切られるたびに鳴らし直し、回数を縛れない）。
  replayed: boolean;
  // P3-NL-AC11 (2): owner が作るときに決める A7 の群（発注 1 は A7 の group() と同じ値）。
  priorityGroup: NotificationPriorityGroup;
}>;

export type NotificationResult = Readonly<{
  attemptId: string;
  intentId: string;
  channel: NotificationIntent["channel"];
  completedAt: ClockReading;
}> & (
  | Readonly<{ kind: "delivered" }>
  // notStarted: 外へ何も出していないと証明できる失敗（P3-NL-AC06 (2)）。ほかの failed は起動した後の、結果の分からない終わり。
  | Readonly<{ kind: "failed"; reason: "adapterRejected" | "adapterError" | "notStarted" }>
  | Readonly<{ kind: "timeout"; stopped: boolean }>
  | Readonly<{ kind: "aborted"; reason: "higherPriority" | "expired" | "superseded" | "shutdown"; stopped: boolean }>
);

// A1 has already correlated the intent; selection does not fabricate a result.
// P3-NL-AC06 (1): expiresAt は 1 回の鳴らし直しでだけ変わる。lossReason は終端にする更新にだけ付く（H39 の通知の理由）。
export type NotificationLossReason = "notificationExpired" | "notificationExpiredClockUnverified" | "notificationOutcomeUnknown";
export type NotificationIntentUpdate = Pick<NotificationIntent, "id" | "attempts" | "nextAttemptAt" | "disposition" | "lastAttempt" | "replayed" | "expiresAt">
  & Readonly<{ lossReason: NotificationLossReason | null }>;

// P3-NL-AC02: 系列の通知の印。version は版の鍵（versionKey）の sha256 の先頭 16 桁、kinds はその版で作った種類（この順・重複なし）、
// evidence はその系列の通知が外へ出たかの証拠（下げない）、fragments は U-T の観測の fragment の鍵（版ごとに 16 件まで、P3-NL-AC03）。
export type NoticeKind = "report" | "cancel" | "expiry";
export type NoticeEvidence = "unattempted" | "possible" | "unknown";
export type NoticeMark = Readonly<{ version: string; kinds: readonly NoticeKind[]; evidence: NoticeEvidence; fragments?: readonly string[] }>;
// P3-NL-AC02 (6): U-T・U-Q の失敗の印（unit×operation ごと）。最後に作った失敗警報の段階と expiresAt。until まで同じか軽い段階の
// 失敗警報を作らない（終端の intent を外しても、鳴り終えた直後の同じ段階の拒否で鳴り直さない）。
export type FailureMark = Readonly<{ operation: Operation; level: "warning" | "critical"; until: number }>;

export type PublicValue = JsonValue;

export type SubjectOutcome = Readonly<{
  subject: string;
  operation: Operation;
  informationType: string;
  transition: string;
  severity: string | null;
  source: ReportRef | null;
  facts: Readonly<Record<string, PublicValue>>;
  changedFields: readonly string[];
}>;

export type PublishedOutcome =
  | Readonly<{ kind: "accepted"; change: "semantic" | "revisionOnly" | "deliveryOnly"; subjects: readonly SubjectOutcome[] }>
  | Readonly<{ kind: "batchCompleted"; reason: "deadline" | "interrupted" | "shutdown"; subjects: readonly SubjectOutcome[] }>
  | Readonly<{ kind: "deadlineApplied"; subjects: readonly SubjectOutcome[] }>
  | Readonly<{ kind: "recoveryApplied"; scope: readonly string[]; coverage: readonly string[]; subjects: readonly SubjectOutcome[] }>;

export type RuntimePublishedOutcome = Readonly<{ unit: RuntimeUnitId; outcome: PublishedOutcome }>;

export type OutcomePersistence = Readonly<{
  kind: "saved" | "pending" | "failed" | "uncertain";
  currentGeneration: number;
  savedGeneration: number | null;
}>;

export type OutcomeEnvelope = Readonly<{
  schemaVersion: number;
  outcomeId: string;
  runId: string;
  causeId: string;
  inputSequence: number | null;
  receivedAt: number | null;
  decidedAt: number;
  unit: UnitId;
  unitRevision: number;
  persistence: OutcomePersistence;
  outcome: PublishedOutcome;
}>;

export type UnitView = Readonly<{
  unit: UnitId;
  semanticRevision: string;
  // Changes exactly when public meaning changes; independent of gates, persistence and delivery.
  contentRevision: string;
  // Persistence is metadata in RuntimeState.units; it is not part of a reusable content view.
  subjects: readonly SubjectOutcome[];
}>;

export type RuntimeUnitView = EewUnitView | WeatherCurrentUnitView | WeatherTimeseriesUnitView | TsunamiUnitView | SeismicUnitView | NankaiUnitView | VolcanoUnitView | LandslideUnitView | FloodUnitView | BriefingUnitView | LocalBulletinsUnitView | TyphoonUnitView;

// P2-A1-DISPLAY-CHANGES: direct subject references avoid searching a whole view for a delta.
export type RuntimeDisplaySubject = Readonly<{
  operation: Operation;
  subject: string;
  office: string | null;
  subjects: readonly SubjectOutcome[];
}> & (
  | Readonly<{ unit: "U-E"; current: (EewCurrent & Readonly<{ eventId: string; warningClass: "forecast" | "warning" }>) | null }>
  | Readonly<{ unit: "U-W"; current: WeatherCurrentSnapshot | null;
      unavailable: WeatherCurrentUnitState["unavailable"]; freshness: readonly FreshnessRecord[] }>
  | Readonly<{ unit: "U-F"; current: WeatherTimeseriesPublicSubject | null }>
  | Readonly<{ unit: "U-T"; current: MarkViewed<TsunamiForecastSubject | TsunamiObservationSubject> | null }>
  // I-U-Q.view: subject は event の鍵か長周期の subject。
  | Readonly<{ unit: "U-Q"; current: EarthquakeEventView | MarkViewed<LongPeriodSubject> | null }>
  // I-U-N.view: subject は系統の現況か情報 subject（情報は見出しだけ）。
  | Readonly<{ unit: "U-N"; current: MarkViewed<NankaiCurrent> | NankaiInformationView | null }>
  // I-U-V.view: subject は三 slice の記録か解説 subject（解説は見出しだけ）。
  | Readonly<{ unit: "U-V"; current: MarkViewed<VolcanoAlert | VolcanoEruption | VolcanoAshfall> | VolcanoBulletinView | null }>
  // I-U-L.view: subject は官署の current（active だけ）。
  | Readonly<{ unit: "U-L"; current: MarkViewed<Extract<LandslideCurrent, Readonly<{ effective: "active" }>>> | null }>
  // I-U-R.view: subject は EventID の current（active だけ）。
  | Readonly<{ unit: "U-R"; current: MarkViewed<Extract<FloodCurrent, Readonly<{ effective: "active" }>>> | null }>
  // I-U-B.view: subject は系列の current（VPBS50 の active・VPOA50 の released だけ）。
  | Readonly<{ unit: "U-B"; current: BriefingUnitView["currents"][number] | null }>
  // I-U-M.view: subject は三 slice の記録（active だけ）。
  | Readonly<{ unit: "U-M"; current: LocalBulletinsUnitView["tornado"][number] | LocalBulletinsUnitView["heat"][number] | LocalBulletinsUnitView["transient"][number] | null }>
  // I-U-Y.view: subject は解析か確率の記録（active だけ）。
  | Readonly<{ unit: "U-Y"; current: TyphoonUnitView["analysis"][number] | TyphoonUnitView["probability"][number] | null }>
);

export type RuntimeDisplayChange = Readonly<{
  unit: RuntimeUnitId;
  operation: Operation;
  subject: string;
  before: RuntimeDisplaySubject | null;
  after: RuntimeDisplaySubject | null;
}>;

export type RuntimeViews = Readonly<{
  "U-E": EewUnitView;
  "U-W": WeatherCurrentUnitView;
  "U-F": WeatherTimeseriesUnitView;
  "U-T": TsunamiUnitView;
  "U-Q": SeismicUnitView;
  "U-N": NankaiUnitView;
  "U-V": VolcanoUnitView;
  "U-L": LandslideUnitView;
  "U-R": FloodUnitView;
  "U-B": BriefingUnitView;
  "U-M": LocalBulletinsUnitView;
  "U-Y": TyphoonUnitView;
}>;

export type FreshnessRecord = Readonly<{
  // §7.8 monitoring exception: rejected preserves business state; A5 may record
  // a validated target here without adopting the candidate or advancing its gate.
  target: Readonly<{ operation: Operation; family: string; subject: string; affectedScope: readonly string[] }>;
  candidateSource: ReportRef;
  currentSource: ReportRef | null;
  currentSemanticRevision: string | null;
  decision: string;
  reason: string;
  revisionOrder: "newer" | "same" | "older" | "unknown";
  freshnessSuspect: boolean;
  suspectedSource: ReportRef | null;
  confirmedScope: readonly string[];
  clearCondition: "sameTargetScopeAcceptedOrCoverageConfirmed";
}>;

export type DiagnosticLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type ParserDiagnosticReason =
  | "operationMissing" | "operationInvalid" | "operationMismatch" | "operationAmbiguous"
  | "formatUnsupported" | "inputTooLarge" | "envelopeInvalid" | "encodingUnsupported"
  | "compressionUnsupported" | "bodyDecodeFailed" | "expandedBodyInvalid"
  | "expandedBodyTooLarge" | "xmlLimitExceeded" | "xmlInvalid";

export type InfrastructureDiagnosticReason =
  | "checkpointEncodeFailed" | "checkpointWriteFailed" | "checkpointFileSyncFailed"
  | "checkpointCloseFailed" | "checkpointRenameFailed" | "checkpointDirectorySyncFailed"
  | "checkpointVerifyFailed" | "checkpointRetryScheduled" | "checkpointOverdue"
  | "checkpointUncertain" | "checkpointRestoreRejected" | "checkpointSchemaDiscarded"
  | "mailboxRejectedDraining" | "mailboxRejectedItemLimit" | "mailboxRejectedByteLimit"
  | "mailboxStalled" | "mailboxLimitViolation"
  | "shutdownStarted" | "shutdownUnsavedUnits"
  | "diagnosticSinkFailed" | "diagnosticQueueOverflow"
  | "snapshotNoticeCapacityExceeded" | "snapshotCommonBudgetExceeded"
  | "snapshotStringLimitExceeded"
  // P3-DMDATA-CONNECT-001 (AC05): the live dmdata connection's start, REST stage, error frame and liveness.
  | "dmdataSocketStarted" | "dmdataSubscriptionNarrowed" | "dmdataSocketListFailed" | "dmdataConnectionCapacityExceeded"
  | "dmdataSocketStartFailed" | "dmdataSocketStartUncertain" | "dmdataSocketCloseFailed" | "dmdataAuthRejected"
  | "dmdataErrorFrame" | "connectionLivenessExpired"
  // P3-EXECUTION-LIFECYCLE-001 (AC02): an owner stopped, and the inputs refused for a stopped or unresponsive owner.
  | "ownerStopped";

export type DiagnosticReason = ParserDiagnosticReason | RejectionReason | InfrastructureDiagnosticReason
  | "weatherCurrentCapacityEvicted" | "eewCapacityEvicted" | "eewHorizonStale" | "hostClockAhead" | "hostClockBehind" | "hostClockUnverified"
  // P3-TSUNAMI-UNIT-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-T capacity eviction.
  | "tsunamiRevisionConflict" | "tsunamiCapacityEvicted"
  // P3-UNIT-Q-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-Q capacity eviction. P3-QC-AC03 (6): 器の都合で観測点を畳んだ記録の数。
  | "seismicRevisionConflict" | "seismicCapacityEvicted" | "seismicStationsFolded"
  // P3-UNIT-N-001 Q-ENUM.diagnosticReasons: a same-revision conflict and an information-series eviction.
  | "nankaiRevisionConflict" | "nankaiCapacityEvicted"
  // P3-UNIT-V-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-V capacity eviction.
  | "volcanoRevisionConflict" | "volcanoCapacityEvicted"
  // P3-UNIT-L-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-L capacity eviction.
  | "landslideRevisionConflict" | "landslideCapacityEvicted"
  // P3-UNIT-R-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-R capacity eviction.
  | "floodRevisionConflict" | "floodCapacityEvicted"
  // P3-UNIT-B-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-B capacity eviction.
  | "briefingRevisionConflict" | "briefingCapacityEvicted"
  // P3-UNIT-M-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-M capacity eviction.
  | "localBulletinsRevisionConflict" | "localBulletinsCapacityEvicted"
  // P3-UNIT-Y-001 Q-ENUM.diagnosticReasons: a same-revision conflict and a U-Y capacity eviction.
  | "typhoonRevisionConflict" | "typhoonCapacityEvicted"
  | "notificationAttemptFailed" | "notificationExpired" | "notificationExpiredClockUnverified" | "notificationCapacityEvicted" | "notificationAdapterIsolated"
  // P3-NL-AC14 (3): 通知したか不明で終えた intent と、U-E の印を容量で捨てた件数。
  | "notificationOutcomeUnknown" | "noticeMarkEvicted"
  // P3-UNIT-TABLE-001: one per input whose headType is not routed to a unit (ignored / notPorted / absent from coverage).
  | "routeIgnored" | "routeNotPorted" | "routeUnlisted" | "ownerReplyLate"
  // P3-CC-AC07: one per input a unit could not make current because of its capacity. P3-WS-AC02: U-F が受理した報の読み飛ばし（INFO）と外の階層の知らない子（WARN）を報ごとに 1 件。P3-UM-AC03 (4): 原文を外した記録の数。
  | "capacityRejected" | "weatherTimeseriesElementSkipped" | "weatherTimeseriesScopeUnclear" | "unreadableDropped";

export type DiagnosticDetails = Readonly<{
  level: DiagnosticLevel;
  component: string;
  reason: DiagnosticReason;
  inputId?: string;
  unit?: UnitId;
  generation?: number;
  attemptId?: string;
  durationMs?: number;
  count?: number;
}>;

export type DiagnosticEvent = DiagnosticDetails & Readonly<{ timestamp: number; runId: string }>;

export type MailboxControl =
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "checkpointResult"; result: CheckpointResult; clock: ClockReading }>
  | Readonly<{ kind: "shutdownRequested"; acceptedThroughSequence: number; clock: ClockReading }>;

export type RuntimeInput =
  | Readonly<{ kind: "startup"; runId: string; clock: ClockReading; restored: Readonly<Record<RuntimeUnitId, RestoreUnitResult>>;
      notificationChannels: Readonly<Record<"desktop" | "sound", Extract<NotificationDeliveryState["channels"]["desktop"], { kind: "idle" }>>> }>
  | Readonly<{ kind: "notificationProbeCompleted"; channels: Readonly<Record<"desktop" | "sound", Extract<NotificationDeliveryState["channels"]["desktop"], { kind: "idle" | "unavailable" }>>>; clock: ClockReading }>
  | Readonly<{ kind: "connectionLost"; acceptedThroughSequence: number; clock: ClockReading }>
  | Readonly<{ kind: "coverageVerified"; runId: string; epoch: number; scopes: readonly ConfirmationScope[]; clock: ClockReading }>
  | Readonly<{ kind: "mailboxCompleted"; completion: MailboxCompletion; clock: ClockReading }>
  | Readonly<{ kind: "checkpointCaptured"; capture: CheckpointCapture }>
  | Readonly<{ kind: "notificationResult"; result: NotificationResult }>
  | Readonly<{
      kind: "shutdownStageResult";
      stage: Exclude<ShutdownStage, "running" | "completed">;
      result: ShutdownStageResult;
      pending: ShutdownPendingCounts;
      clock: ClockReading;
      droppedDiagnostics: ShutdownSummary["droppedDiagnostics"];
    }>;

export type ShutdownStage =
  | "running" | "mailboxDrain" | "sideEffectFinalization" | "finalCheckpoint" | "workerClose" | "completed";

export type ShutdownDeadlines = Readonly<{
  overallMonotonicMs: number | null;
  mailboxDrainMonotonicMs: number | null;
  sideEffectFinalizationMonotonicMs: number | null;
  finalCheckpointMonotonicMs: number | null;
  workerCloseMonotonicMs: number | null;
}>;

export type ShutdownPendingCounts = Readonly<{
  mailboxPending: number;
  mailboxInFlight: number;
  batches: number;
  notificationAttempts: number;
  unsavedUnits: number;
  workers: number;
}>;

export type ShutdownStageResult =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed"; reason: string }>
  | Readonly<{ kind: "deadlineExceeded" }>;

export type ShutdownState = Readonly<{
  stage: ShutdownStage;
  acceptedThroughSequence: number | null;
  startedAt: ClockReading | null;
  deadlines: ShutdownDeadlines;
  finalizationAt: number | null;
  // One terminal observation per stage, at most four; later stages never erase it.
  stageResults: Readonly<Partial<Record<Exclude<ShutdownStage, "running" | "completed">,
    Pick<Extract<RuntimeInput, { kind: "shutdownStageResult" }>, "result" | "pending" | "clock" | "droppedDiagnostics">>>>;
}>;

export type RuntimeEffect =
  | Readonly<{ kind: "stopInputAndDrainMailbox"; acceptedThroughSequence: number; deadlineMonotonicMs: number }>
  | Readonly<{ kind: "finalizeNotificationDelivery"; deadlineMonotonicMs: number }>
  | Readonly<{ kind: "startFinalCheckpoints"; units: readonly RuntimeUnitId[]; deadlineMonotonicMs: number }>
  | Readonly<{ kind: "closeRuntimeWorkers"; deadlineMonotonicMs: number; summary: ShutdownSummary }>;

export type RuntimeRestoration = Readonly<Record<RuntimeUnitId,
  Readonly<{ kind: "restored" | "empty" }> | Extract<RestoreUnitResult, { kind: "unavailable" }>>>;

// P2-A1-CONFIRMATION: restoration success never establishes current completeness.
// capacityExceeded: 容量の拒否で報を 1 つ取りこぼした unit/operation（P3-CC-AC02）。scopeCapacity（確認の記録を畳んだ印）とは別。
export type UnconfirmedReason = "startup" | "disconnected" | "scopeCapacity" | "scopeRetired" | "capacityExceeded";
export type ConfirmationScope = Readonly<{ operation: Operation }> & (
  | Readonly<{ unit: RuntimeUnitId; kind: "unit" }>
  // I-U-T.confirmationScope: U-T reuses the event row (VTSE41 EventID), no new row.
  | Readonly<{ unit: "U-E" | "U-T"; kind: "event"; eventId: string }>
  | Readonly<{ unit: "U-W"; kind: "area"; subject: string; token: string }>
  | Readonly<{ unit: "U-F"; kind: "series"; subject: string; office: string }>
);

// Emitted by A4/A5/A6 only after final admission of a current-establishing received report.
// capacityExceeded は負の証拠: 印を付けられない容量の拒否で、その unit/operation の whole を未確認にする（P3-CC-AC02）。
export type CurrentConfirmationEvidence =
  | Readonly<{ source: "acceptedReport"; scopes: readonly Exclude<ConfirmationScope, { kind: "unit" }>[] }>
  | Readonly<{ source: "capacityExceeded"; scopes: readonly Extract<ConfirmationScope, { kind: "unit" }>[] }>;

// 容量の拒否で更新できなかった記録の印（P3-CC-AC03）。値は最終確認として残し、source は拒否した報。
export type SubjectUnavailable = Readonly<{ reason: "capacityExceeded"; source: ReportRef }>;

export type RuntimeConfirmation = Readonly<{
  epoch: number;
  afterInputSequence: number;
  units: Readonly<Record<RuntimeUnitId, Readonly<Record<Operation, Readonly<{
    whole: UnconfirmedReason | null;
    // Derived counters, maintained by A1; A8 reads nine slots without walking scopes.
    counts: Readonly<Partial<Record<UnconfirmedReason, number>>>;
    confirmedScopeCount: number;
    // Incremental logical JSON byte count for this bounded scope array.
    scopeBytes: number;
    scopes: readonly Readonly<{ scope: ConfirmationScope; reason: UnconfirmedReason | null; confirmedAt: number | null }>[];
    confirmedAt: number | null;
  }>>>>>;
}>;

// P2-A1-AC09/Q-R20-CLEAR: unit-validated decision evidence; no XML or report body.
export type AdmissionEvidence = Readonly<{
  family: string;
  reportDateTimeMs: number;
  affectedScope: "subject" | readonly string[];
}>;

export type RuntimeState<UnitStates extends RuntimeUnitStates = RuntimeUnitStates> = Readonly<{
  runId: string;
  units: UnitStates;
  restoration: RuntimeRestoration;
  confirmation: RuntimeConfirmation;
  views: RuntimeViews;
  checkpointAttempts: Readonly<Partial<Record<RuntimeUnitId, PendingCheckpointAttempt>>>;
  deadlines: Readonly<Record<RuntimeUnitId, RuntimeUnitDeadline | null>>;
  notificationChannels: NotificationDeliveryState["channels"];
  notificationProbeComplete: boolean;
  notificationDeadlines: NotificationDeliveryState["deadlines"];
  shutdown: ShutdownState;
}>;

export type RuntimeStep<UnitStates extends RuntimeUnitStates = RuntimeUnitStates> = Readonly<{
  state: RuntimeState<UnitStates>;
  changedUnits: readonly UnitId[];
  // Present [] certifies only this step's generation change; absence is not [].
  // Accumulation and unknown generations: P2-A3-AC10.
  generationInputIds: Readonly<Partial<Record<RuntimeUnitId, readonly string[]>>>;
  checkpointRequests: readonly CheckpointRequest[];
  notificationAttempts: NotificationSelection["attempts"];
  abortRequests: NotificationSelection["abortRequests"];
  effects: readonly RuntimeEffect[];
  shutdownSummary: ShutdownSummary | null;
  outcomes: readonly RuntimePublishedOutcome[];
  views: readonly RuntimeUnitView[];
  displayChanges: readonly RuntimeDisplayChange[];
  diagnostics: readonly DiagnosticEvent[];
}>;

export type MailboxPriorityReason = "control" | "eewCandidate" | "tsunamiCandidate" | "normal";

export type MailboxEnvelope = Readonly<{
  messageId: string;
  runId: string;
  t0MonotonicMs: number;
  enqueuedMonotonicMs: number;
}> & (
  | Readonly<{ payload: Readonly<{ kind: "parser"; item: ParserMailboxItem }>; priorityReason: Exclude<MailboxPriorityReason, "control"> }>
  | Readonly<{ payload: Readonly<{ kind: "control"; control: MailboxControl }>; priorityReason: "control" }>
);

export type MailboxCompletion = Readonly<{
  messageId: string;
  runId: string;
  encodedByteLength: number;
  startedMonotonicMs: number;
  completedMonotonicMs: number;
}> & (
  | Readonly<{ kind: "parser"; inputId: string; inputSequence: number; result: ParserMailboxResult }>
  | Readonly<{ kind: "control"; control: MailboxControl }>
);

export type MailboxStats = Readonly<{
  accepting: boolean;
  pendingItems: number;
  pendingBytes: number;
  inFlightItems: number;
  inFlightBytes: number;
  inFlightMessageIds: readonly string[];
  inFlightControlMessageIds: readonly string[];
  lastProgressMonotonicMs: number | null;
  lastArrivalMonotonicMs: number | null;
  lastWorkerResponseMonotonicMs: number | null;
  nextDeadlineMonotonicMs: number | null;
  highWaterItems: number;
  highWaterBytes: number;
  oldestPendingAgeMs: number | null;
  oldestIncompleteAgeMs: number | null;
  accepted: number;
  completed: number;
  cancelled: number;
  rejected: number;
  limitViolations: number;
}>;

export type MailboxEnqueueResult =
  | Readonly<{ kind: "accepted"; stats: MailboxStats }>
  | Readonly<{ kind: "rejected"; reason: "draining" | "itemLimit" | "byteLimit"; stats: MailboxStats }>;

export type CheckpointEnvelope = Readonly<{
  schemaVersion: string;
  unit: UnitId;
  generation: number;
  capturedAt: number;
  payload: JsonValue; inputBoundary?: InputBoundary | null; // P3-VM-AC06: 書き手は常に書き、欄の無い保存は読み戻しで拒否する。省略は各 unit の上界を測る式だけ（JSON に出ない）
  losses?: readonly LossTally[]; // P3-NL-AC14: owner が capture で書き、復元で読む H39 の件数。行の無いときは欄を書かず、欄の無い envelope は空として読む
  sha256: string;
}>;

// P3-NL-AC14 (2)(3): unit の落とした件数（reason ごとに 1 行、operation は分けない）。count は安全な整数で飽和、lastAt は最後に足した手元の wall。
export type LossReason = NotificationLossReason | "notificationCapacityEvicted" | "noticeMarkEvicted" | "capacityRejected"
  | "eewCapacityEvicted" | "weatherCurrentCapacityEvicted" | "tsunamiCapacityEvicted" | "seismicCapacityEvicted" | "seismicStationsFolded" | "nankaiCapacityEvicted"
  | "volcanoCapacityEvicted" | "landslideCapacityEvicted" | "floodCapacityEvicted" | "briefingCapacityEvicted" | "localBulletinsCapacityEvicted"
  | "typhoonCapacityEvicted" | "unreadableDropped";
export type LossTally = Readonly<{ reason: LossReason; count: number; lastAt: number }>;

// Unit reducers own codecs; A3 calls them at capture/restore, not on idle ticks.
export type UnitCodec<State, Persisted extends JsonValue> = Readonly<{
  schemaVersion: string; discardableSchemaVersions?: readonly string[]; maxEnvelopeBytes?: number; // P3-VM-AC05: 捨ててよい旧い版（P5 の前だけ、C15 の配送までに空にする。省略は空）。P3-VM-AC06: 保存 1 世代の envelope の上限（capture の最後の守り）
  encode: (state: State) => Persisted;
  decode: (payload: JsonValue) => UnitDecodeResult<State>;
}>;

export type UnitDecodeResult<State> =
  | Readonly<{ kind: "restored"; state: State }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export type CheckpointRequest = Readonly<{
  attemptId: string;
  unit: UnitId;
  generation: number;
  reservedAt: number;
  capturedAt: number;
  envelope: CheckpointEnvelope;
  encodedByteLength: number;
}>;

export type CheckpointCapture = Pick<CheckpointRequest, "attemptId" | "generation" | "capturedAt"> & Readonly<{
  unit: RuntimeUnitId;
}>;

export type PendingCheckpointAttempt = CheckpointCapture & Readonly<{
  // Same monotonic clock as SaveProgress.dirtySince.
  postCaptureDirtySince: number | null;
}>;

export type CheckpointResult =
  | Readonly<{ kind: "acknowledged"; attemptId: string; unit: UnitId; generation: number; ackAt: number; encodedByteLength: number }>
  | Readonly<{ kind: "failed"; attemptId: string; unit: UnitId; generation: number; failedAt: number; stage: SaveFailureStage; reason: string; encodedByteLength: number }>
  | Readonly<{ kind: "uncertain"; attemptId: string; unit: UnitId; generation: number; observedAt: number; stage: "rename" | "directorySync" | "ack"; encodedByteLength: number }>;

export type RestoreUnitResult =
  | Readonly<{ kind: "restored"; envelope: CheckpointEnvelope; slot: "A" | "B" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "unavailable"; reason: "noValidSlot" | "unknownSchema" | "conflictingGeneration" }>;

export type ShutdownCode = 0 | 2 | 3 | 4;

export type ShutdownSummary = Readonly<{
  code: ShutdownCode;
  requestedAt: number;
  finalizationAt: number | null;
  completedAt: number;
  acceptedThroughSequence: number;
  pendingInputs: number;
  inFlightInputs: number;
  persistence: Readonly<Partial<Record<UnitId, PersistenceStatus>>>;
  reasons: readonly string[];
  droppedDiagnostics: Readonly<Record<DiagnosticLevel, number>>;
}>;

export type DiagnosticSinkResult =
  | Readonly<{ kind: "accepted"; queuedItems: number; queuedBytes: number }>
  | Readonly<{ kind: "dropped"; reason: "itemLimit" | "byteLimit" | "sinkUnavailable"; level: DiagnosticLevel; count: number }>;

export type ParserDiagnosticProjection = Readonly<{
  event: DiagnosticEvent;
  encodedByteLength: number;
  expandedByteLength: number | null;
}>;

export type DiagnosticReadQuery = Readonly<{
  level?: DiagnosticLevel;
  unit?: UnitId;
  fromTimestampMs?: number;
  throughTimestampMs?: number;
  limit: number;
}>;

export type DiagnosticReadResult = Readonly<{
  records: readonly DiagnosticEvent[];
  encodedByteLength: number;
  truncated: boolean;
}>;

// P3-VM-AC06: 時計の根拠の状態。K9（P3-CLOCK-CHECK-001）より先に合流した側が置く（Q-VM-NEIGHBOURS）。
export type WallBasis = "awaiting" | "verified" | "unverified";

// P3-VM-AC06・AC07: unit ごとの取り直しの境界（受信の順でそこ以前の、その unit への入力がすべてこの世代に入っている位置）。
// receivedAt.basis は受信の時点の根拠（K9 の前は null）、receivedAt は取り直しで進めた位置では null、dmdataTime は C16 まで null。
export type InputHole = "refused" | "disconnected" | "restarted";
export type InputBoundary = Readonly<{
  receivedAt: Readonly<{ wallTimeMs: number; basis: WallBasis | null }> | null;
  dmdataTime: number | null;
  dmdataId: string | null;
  oldestHole: InputHole | null;
}>;

// P3-UM-AC01（K14、H51）: 記録の中の読めなかった所の印。site は domain の warn の所の名（unit ごとの閉じた語）。compare は
// 「比べから外す」1 つの値の欄の比べの値の digest（16 hex、fragmentKey と同じ作り、P3-UM-AC04）。compareKeys は一覧の欄の比べの
// 要素の鍵の集合（128 件まで）。scope は印の効く範囲（U-F の区分不明の範囲、区域の code など。128 byte まで）。raw は欠片（boundedString）。
export type UnreadablePart = Readonly<{
  site: string;
  reason: "requiredStructureMissing" | "requiredStructureInvalid";
  scope?: string;
  compare?: string;
  compareKeys?: readonly string[];
  raw: string | null;
}>;
// rawDropped・partsCut は外した履歴の旗（原文を器の都合で外した、16 件を越えた所を省いた）。版の置換まで持ち越す（P3-UM-AC01 (3)）。
export type UnreadableMark = Readonly<{ parts: readonly UnreadablePart[]; headline: string | null; rawDropped?: true; partsCut?: true }>;

// P3-UM-AC08（K14、H43）: 報の全体が読めなかった電文のカード。owner が振り分け先の unit の envelope に書く（K8 の losses と同じ置き場）。
// count は知らない種類を headType ごとにまとめた件数（ほかは 1）。raw は展開した本文の先頭（16,384 byte）で、rawCut は切った印、
// rawDropped は器の都合で原文を外した印（raw は null、rawCut・areas とは独立）。areas は U-Y の確率の報の地域ごとの 5 日積算（読めない地域は null）。
export type UnreadableCardKind = "unknownType" | "unreadable" | "unidentified";
export type UnreadableCard = Readonly<{
  kind: UnreadableCardKind;
  inputId: string;
  headType: string;
  operation: Operation | null;
  receivedAt: number;
  reason: DiagnosticReason;
  title: string | null;
  headline: string | null;
  reportDateTimeRaw: string | null;
  raw: string | null;
  rawCut: boolean;
  rawDropped?: true;
  count: number;
  areas?: readonly Readonly<{ code: string; name: string; value: number | null }>[];
}>;

// P3-UM-AC12: 読めない EEW・津波の通知を重ねない印（U-E・U-T、unit×operation ごとに 1 つ）。FailureMark と違い info を持てる。
export type UnreadableNoticeMark = Readonly<{ operation: Operation; level: "info" | "normal" | "warning" | "critical"; until: number }>;

// P3-UM-AC10（P3-UM-D-VIEW）: view に渡す印。原文の本文は渡さず有無だけ。U-F の付加事項（site addition）は一覧に入れず、原文の有無を addition に。
export type UnreadableMarkView = Readonly<{
  parts: readonly Readonly<{ site: string; scope?: string; raw: boolean }>[];
  headline: boolean;
  addition?: true;
  rawDropped?: true;
  partsCut?: true;
}>;
// 記録の型の印を view の形に置き換えた型（各 unit の view の currents が使う、notice-mark.ts の shown が作る）。view の印は鍵を
// unreadableView・marineUnreadableView に替える（記録の型を受ける表示の関数〔chrome-eew の pure.ts〕へそのまま渡せるように）。
export type MarkViewed<T> = T extends unknown ? Omit<T, "unreadable" | "marineUnreadable">
  & Readonly<{ [K in Extract<keyof T, "unreadable" | "marineUnreadable"> as `${K}View`]?: UnreadableMarkView }> : never;
