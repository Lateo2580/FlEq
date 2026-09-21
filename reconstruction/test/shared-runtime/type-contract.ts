import { expectTypeOf } from "vitest";
import type {
  DiagnosticDetails, DiagnosticEvent, FreshnessRecord, NotificationIntent,
  ParserDiagnosticReason, PublishedOutcome, RejectionReason, ReportRef, SubjectOutcome, UnitView,
  RuntimeInput, RuntimeStep, RuntimeUnitStates, RuntimeUnitDeadline, NotificationIntentUpdate,
} from "../../contracts/p2-shared-runtime.types";
import type { Operation } from "../../contracts/p1-parser-boundary.types";

// T06: compiled by the CI type-check gate (tsc --project reconstruction/tsconfig.test.json), including negative checks.
expectTypeOf<PublishedOutcome["kind"]>().toEqualTypeOf<
  "accepted" | "batchCompleted" | "deadlineApplied" | "recoveryApplied"
>();
expectTypeOf<PublishedOutcome["subjects"]>().toEqualTypeOf<readonly SubjectOutcome[]>();
expectTypeOf<UnitView["subjects"]>().toEqualTypeOf<readonly SubjectOutcome[]>();
expectTypeOf<SubjectOutcome["changedFields"]>().toEqualTypeOf<readonly string[]>();
expectTypeOf<ReportRef["operation"]>().toEqualTypeOf<Operation>();
expectTypeOf<NotificationIntent["operation"]>().toEqualTypeOf<Operation>();
expectTypeOf<SubjectOutcome["operation"]>().toEqualTypeOf<Operation>();
declare const subject: SubjectOutcome;
const variants = [
  { kind: "accepted", change: "semantic", subjects: [subject, subject] },
  { kind: "batchCompleted", reason: "deadline", subjects: [subject] },
  { kind: "deadlineApplied", subjects: [subject] },
  { kind: "recoveryApplied", scope: ["scope"], coverage: ["scope"], subjects: [subject] },
] satisfies readonly PublishedOutcome[];
// @ts-expect-error delivery snapshots are not outcome variants
const invalidOutcome: PublishedOutcome = { kind: "snapshot", subjects: [] };
// @ts-expect-error arbitrary properties are not declared SubjectOutcome fields
const rawSubject: SubjectOutcome = { ...subject, raw: "<Report/>" };
declare const view: UnitView;
// @ts-expect-error a view contains current subjects, not an outcome history
const historyView: UnitView = { ...view, subjects: variants };
// @ts-expect-error operation is required on ReportRef
const missingOperation: ReportRef = { inputId: "", origin: "live", family: "", subject: "", reportDateTimeRaw: "", serialRaw: "", infoTypeRaw: "" };

// T07: every record field remains required and carries its declared boundary.
expectTypeOf<FreshnessRecord>().toEqualTypeOf<Readonly<{
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
}>>();
declare const freshness: FreshnessRecord;
// @ts-expect-error heartbeat is not a legal clearing condition
const heartbeat: FreshnessRecord = { ...freshness, clearCondition: "heartbeat" };
// @ts-expect-error all monitoring fields are required
const incomplete: FreshnessRecord = { target: freshness.target };

// R13: control metadata and concrete unit ownership stay in the shared contract.
expectTypeOf<keyof RuntimeUnitStates>().toEqualTypeOf<"U-E" | "U-W" | "U-F">();
expectTypeOf<RuntimeUnitDeadline>().toEqualTypeOf<Readonly<{ wallTimeMs: number | null; monotonicMs: number | null }>>();
expectTypeOf<NotificationIntentUpdate>().toEqualTypeOf<Pick<NotificationIntent, "id" | "attempts" | "nextAttemptAt" | "disposition">>();
expectTypeOf<RuntimeInput["kind"]>().toEqualTypeOf<"mailboxCompleted" | "checkpointCaptured" | "notificationResult" | "shutdownStageResult">();
expectTypeOf<RuntimeStep["effects"][number]["kind"]>().toEqualTypeOf<
  "stopInputAndDrainMailbox" | "finalizeNotificationDelivery" | "startFinalCheckpoints" | "closeRuntimeWorkers"
>();

// E23: exact fixed fields and closed reasons, not arbitrary strings.
expectTypeOf<keyof DiagnosticDetails>().toEqualTypeOf<
  "level" | "component" | "reason" | "inputId" | "unit" | "generation" | "attemptId" | "durationMs" | "count"
>();
expectTypeOf<keyof DiagnosticEvent>().toEqualTypeOf<keyof DiagnosticDetails | "timestamp" | "runId">();
// @ts-expect-error parser reason typos must fail compilation
const parserTypo: ParserDiagnosticReason = "xmlInvald";
// @ts-expect-error rejection reasons are closed
const rejectionTypo: RejectionReason = "invalid";
