import type { Operation, ProcessingMarks } from "./p1-parser-boundary.types";
import type { CheckpointMeasurement } from "./p2-eew-e01.types";
import type {
  CheckpointResult,
  ClockReading,
  CurrentConfirmationEvidence,
  DiagnosticEvent,
  MailboxCompletion,
  MailboxEnvelope,
  NotificationIntent,
  NotificationIntentUpdate,
  PersistenceStatus,
  RuntimeDisplayChange,
  RuntimePublishedOutcome,
  RuntimeRestoration,
  RuntimeUnitId,
  RuntimeUnitView,
} from "./p2-shared-runtime.types";

// P3-EXECUTION-SPLIT-001 (C3a). D-P3-1: the publisher is Node main; three resident worker_threads own the units.
// Every value below crosses a thread by structured clone: plain data only, no function, class instance or shared
// mutable reference (p3-execution-boundary.md §2). No parse tree, canonical unit state or checkpoint bytes appear here.

// One place per unit, kept as one column next to the unit list (P3-C3A-PLACE-COLUMN). Urgent and non-urgent units
// never share a place. An input whose headType is not ready (ignored / notPorted / unlisted) is decoded in "deferred".
export type ExecutionPlace = "urgent" | "weatherCurrent" | "deferred";

// workerData of one owner thread. publisherTimeOriginMs is the publisher's performance.timeOrigin.
// measured は測定の印（host の config.observe != null、P3-C4-AC04）。印があるときだけ owner は full parse と書込み権の着手の
// 時刻を取り、write を数える。印が無いときはどれも作らない。
export type OwnerStartData = Readonly<{ place: ExecutionPlace; stateDirectory: string; publisherTimeOriginMs: number;
  measured: boolean }>;

// P3-C4-WRITE-COUNT（RES-05）: 1 thread の write の回数（呼出しの数。diagnosticLog だけは追記した行の数）と byte の区分別の累積。checkpoint は checkpoint の file へ直接の
// write、tmp は rename で置き換える一時 file（checkpoint の保存・終了要約）、diagnosticLog は診断 log への追記、other はそれ以外。
export type WriteCounts = Readonly<Record<"checkpoint" | "tmp" | "diagnosticLog" | "other", Readonly<{ count: number; bytes: number }>>>;

// P3-C3A-CLOCK: two clocks, never mixed.
// Business time (receive application, deadlines, dirtySince, capturedAt, ackAt, mailbox settlement): the publisher's
// injected clock at post, extrapolated by real elapsed time: clock + (sharedNow - sharedMs), sharedNow being
// performance.timeOrigin + performance.now() (the same base in every thread). A fixed decision clock in the request
// (intentUpdate.decisionClock, finalize.cutoff) is used as is and never extrapolated.
// Measured time (T2, decode, processing marks, CheckpointMeasurement): the publisher's real monotonic clock,
// sharedNow - publisherTimeOriginMs, with no injected offset (P2-A10-AC03: measurements use Node's real monotonic clock).
export type SentClock = Readonly<{ clock: ClockReading; sharedMs: number }>;

export type ParserEnvelope = Extract<MailboxEnvelope, Readonly<{ payload: Readonly<{ kind: "parser" }> }>>;

// The mailbox settles a parser input by identity only; the decode result stays in the owner.
export type ParserSettlement = Omit<Extract<MailboxCompletion, Readonly<{ kind: "parser" }>>, "result">;

// Per owner at most one outstanding request of each kind except intentUpdate (at most 2 per channel: one reservation
// and one result update). The publisher sends nothing else (P3-C3A-AC15).
export type OwnerRequest = SentClock & (
  | Readonly<{ kind: "restore"; runId: string }>
  | Readonly<{ kind: "input"; envelope: ParserEnvelope }>
  | Readonly<{ kind: "deadline" }>
  // All-or-nothing: the owner adopts every update or none. The publisher binds requestId to its reservation
  // (attemptId and channel) and never lets the owner see channel state (P3-C3A-NOTIFY-ADOPT).
  // decisionClock is the unit input clock, as in P2: the selection clock, or the result's completedAt.
  | Readonly<{ kind: "intentUpdate"; requestId: string; unit: RuntimeUnitId; updates: readonly NotificationIntentUpdate[];
      decisionClock: ClockReading }>
  // The one global write right (spec §5.8). "reconcile" re-checks an uncertain unit (spec §5.7).
  | Readonly<{ kind: "checkpointGrant"; grantId: string; unit: RuntimeUnitId; mode: "save" | "reconcile";
      retryReason: CheckpointMeasurement["retryReason"] }>
  // spec §5.9 step 3 (each unit's declared shutdown input) and step 4 (last deadlines, then only checkpointGrant).
  | Readonly<{ kind: "shutdownInput" }>
  // cutoff is the one finalization clock for every owner, decided after every earlier request has been answered;
  // deadlines up to it are applied, later ones are not. Owners apply deadlines only while handling a request.
  // If the stage deadline passes before every earlier reply arrives, no cutoff is decided and finalizationAt stays null.
  | Readonly<{ kind: "finalize"; cutoff: ClockReading }>
);

// The publisher's bounded mirror entry for one unit. Sent only for units this step changed.
export type OwnerUnitDelta = Readonly<{
  unit: RuntimeUnitId;
  persistence: PersistenceStatus;
  admissionCounts: Readonly<Record<Operation, number>>;
  // null: unchanged in this step. A view is the admission-adjusted public view, never the unit state.
  view: RuntimeUnitView | null;
  // Pending intents only (at most 128 items / 128 KiB per unit, P2-A7-RES-01/02); terminal records stay in the owner.
  pendingIntents: readonly NotificationIntent[] | null;
}>;

export type OwnerOutput = Readonly<{
  units: readonly OwnerUnitDelta[];
  outcomes: readonly RuntimePublishedOutcome[];
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  // Event-scoped confirmation records the publisher retires: events no current subject of the owner still holds.
  retiredEvents: readonly Readonly<{ unit: RuntimeUnitId; operation: Operation; eventId: string }>[];
  diagnostics: readonly DiagnosticEvent[];
}>;

// One reply per request, sent in the order the owner applied them to its state (one port keeps that order);
// checkpointDone is sent when that attempt's filesystem operations have ended and its result has been applied.
export type OwnerReply =
  | Readonly<{ kind: "restored"; units: readonly (OwnerUnitDelta & Readonly<{
      restoration: RuntimeRestoration[RuntimeUnitId]; view: RuntimeUnitView; pendingIntents: readonly NotificationIntent[] }>)[];
      output: OwnerOutput }>
  // settlement times are business time (mailbox matching). processingStartedMs is T2 in measured time;
  // marks.workerTransferMs = T2 - (sharedMs - publisherTimeOriginMs).
  // full parse の区間（P3-C4-PARSE-MARK）は印が無いと null、parse tree の前で拒否された入力では終了が null。
  | Readonly<{ kind: "inputDone"; settlement: ParserSettlement; processingStartedMs: number; marks: ProcessingMarks;
      decode: Readonly<{ startedMonotonicMs: number; endedMonotonicMs: number; xmlParseStartedMonotonicMs: number | null;
        xmlParseEndedMonotonicMs: number | null }> | null; output: OwnerOutput }>
  | Readonly<{ kind: "deadlineDone"; output: OwnerOutput }>
  | Readonly<{ kind: "intentUpdateDone"; requestId: string; adopted: boolean; output: OwnerOutput }>
  // result null: nothing to save or reconcile at grant time. The publisher releases the write right on this reply only.
  // grantStartedMs（owner が権の処理を始めた測定時刻）と writeCounts（この owner の累積）は印が無いと null（P3-C4-AC04）。
  | Readonly<{ kind: "checkpointDone"; grantId: string; unit: RuntimeUnitId; result: CheckpointResult | null;
      measurements: readonly CheckpointMeasurement[]; grantStartedMs: number | null; writeCounts: WriteCounts | null;
      output: OwnerOutput }>
  | Readonly<{ kind: "shutdownInputDone"; output: OwnerOutput }>
  | Readonly<{ kind: "finalizeDone"; appliedThrough: ClockReading; output: OwnerOutput }>;
