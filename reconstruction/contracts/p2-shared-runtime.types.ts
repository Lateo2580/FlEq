import type {
  AcquisitionOrigin,
  DecodedMaterial,
  Operation,
  ParserMailboxItem,
  ParserMailboxResult,
} from "./p1-parser-boundary.types";
import type { EewUnitState } from "./p2-eew-unit.types";
import type { NotificationDeliveryState, NotificationSelection } from "./p2-notification-delivery.types";
import type { WeatherCurrentUnitState } from "./p2-weather-current-unit.types";
import type { WeatherTimeseriesUnitState } from "./p2-weather-timeseries-unit.types";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export type UnitId =
  | "U-E" | "U-Q" | "U-T" | "U-N" | "U-W" | "U-L"
  | "U-F" | "U-B" | "U-M" | "U-Y" | "U-V" | "U-R";

export type RuntimeUnitId = "U-E" | "U-W" | "U-F";

export type RuntimeUnitStates = Readonly<{
  "U-E": EewUnitState;
  "U-W": WeatherCurrentUnitState;
  "U-F": WeatherTimeseriesUnitState;
}>;

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
  reportDateTimeRaw: string;
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
  payload: Readonly<Record<string, JsonValue>>;
  createdAt: number;
  expiresAt: number;
  nextAttemptAt: number;
  attempts: number;
  configRevision: string;
  disposition: "pending" | "delivered" | "expired" | "superseded";
}>;

export type NotificationResult = Readonly<{
  attemptId: string;
  intentId: string;
  channel: NotificationIntent["channel"];
  completedAt: ClockReading;
}> & (
  | Readonly<{ kind: "delivered" }>
  | Readonly<{ kind: "failed"; reason: "adapterRejected" | "adapterError" }>
  | Readonly<{ kind: "timeout"; stopped: boolean }>
  | Readonly<{ kind: "aborted"; reason: "higherPriority" | "cancelled" | "expired" | "superseded" | "shutdown"; stopped: boolean }>
);

// A1 has already correlated the intent; selection does not fabricate a result.
export type NotificationIntentUpdate = Pick<NotificationIntent, "id" | "attempts" | "nextAttemptAt" | "disposition">;

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
  persistence: PersistenceStatus;
  subjects: readonly SubjectOutcome[];
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
  | "checkpointUncertain" | "checkpointRestoreRejected"
  | "mailboxRejectedDraining" | "mailboxRejectedItemLimit" | "mailboxRejectedByteLimit"
  | "mailboxStalled" | "mailboxLimitViolation"
  | "shutdownStarted" | "shutdownUnsavedUnits"
  | "diagnosticSinkFailed" | "diagnosticQueueOverflow"
  | "snapshotNoticeCapacityExceeded" | "snapshotCommonBudgetExceeded"
  | "snapshotStringLimitExceeded";

export type DiagnosticReason = ParserDiagnosticReason | RejectionReason | InfrastructureDiagnosticReason
  | "weatherCurrentCapacityEvicted" | "eewCapacityEvicted";

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

export type RuntimeState<UnitStates extends RuntimeUnitStates = RuntimeUnitStates> = Readonly<{
  runId: string;
  units: UnitStates;
  persistence: Readonly<Partial<Record<UnitId, PersistenceStatus>>>;
  checkpointAttempts: Readonly<Partial<Record<RuntimeUnitId, PendingCheckpointAttempt>>>;
  deadlines: Readonly<Record<RuntimeUnitId, RuntimeUnitDeadline | null>>;
  notificationChannels: NotificationDeliveryState["channels"];
  shutdown: ShutdownState;
}>;

export type RuntimeStep<UnitStates extends RuntimeUnitStates = RuntimeUnitStates> = Readonly<{
  state: RuntimeState<UnitStates>;
  changedUnits: readonly UnitId[];
  checkpointRequests: readonly CheckpointRequest[];
  notificationAttempts: NotificationSelection["attempts"];
  abortAttemptIds: NotificationSelection["abortAttemptIds"];
  effects: readonly RuntimeEffect[];
  shutdownSummary: ShutdownSummary | null;
  outcomes: readonly PublishedOutcome[];
  views: readonly UnitView[];
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
  inFlightMessageId: string | null;
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
  payload: JsonValue;
  sha256: string;
}>;

// Unit reducers own codecs; A3 calls them at capture/restore, not on idle ticks.
export type UnitCodec<State, Persisted extends JsonValue> = Readonly<{
  schemaVersion: string;
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
