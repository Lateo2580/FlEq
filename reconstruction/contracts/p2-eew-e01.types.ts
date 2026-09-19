import type { Operation, ProcessingMarks } from "./p1-parser-boundary.types";
import type { SaveFailureStage, UnitId } from "./p2-shared-runtime.types";
import type { DisplayVersion } from "./p2-snapshot-sse.types";

export type VerificationStatus = "Pass" | "Fail" | "Blocked" | "N/A" | "未確認";
export type EewPopulation = "fixedBacklog" | "maxVpws50ParseStarted" | "maxWeatherCheckpointEncodeStarted";
export type LoadProfileId = "N" | "P" | "C";
export type EewTracePoint = "T0" | "T1" | "T2" | "T3" | "T4" | "T5" | "T6";

export type EewTraceCorrelation = Readonly<{
  runId: string;
  inputId: string;
  operation: Operation;
  subject: string;
  // 未到達は null。欠落標本を正式母数から除外せず、架空の版を補わない。
  semanticRevision: string | null;
  displayVersion: DisplayVersion | null;
}>;

export type EewTraceMarker =
  | Readonly<{ point: "T0" | "T1" | "T2" | "T3" | "T4"; clock: "node"; monotonicMs: number }>
  | Readonly<{ point: "T5"; clock: "chrome"; monotonicMs: number }>
  | Readonly<{
      point: "T6";
      clock: "chrome";
      monotonicMs: number;
      paintEvidenceId: string;
      cardMarkerId: string;
      mapMarkerId: string;
    }>;

export type ClockCorrespondence = Readonly<{
  probeId: string;
  nodeSentMonotonicMs: number;
  chromeReceivedMonotonicMs: number;
  chromeSentMonotonicMs: number;
  nodeReceivedMonotonicMs: number;
  offsetLowerMs: number;
  offsetUpperMs: number;
  intervalWidthMs: number;
}>;

export type EewTraceSample = Readonly<{
  schemaVersion: "p2-eew-trace-v1";
  population: EewPopulation;
  run: 1 | 2 | 3;
  sampleIndex: number;
  correlation: EewTraceCorrelation;
  markers: readonly EewTraceMarker[];
  clockProbeId: string | null;
  latencyLowerMs: number | null;
  latencyUpperMs: number | null;
  missing: boolean;
  missingReason: "paintNotObservedWithin10s" | "traceIncomplete" | null;
}>;

export type ReplayLoad = Readonly<{
  id: LoadProfileId;
  fixtureRefs: readonly string[];
  ordering: readonly string[];
  offsetsMs: readonly number[];
  durationMs: number;
  sha256: string;
}>;

// P1 の七区間は変更しない。競合する非 EEW 入力も run/input と Node 時計で対応する。
export type ProcessingMeasurement = Readonly<{
  runId: string;
  inputId: string;
  startedMonotonicMs: number;
  endedMonotonicMs: number;
  marks: ProcessingMarks;
}>;

// A3 scheduleCheckpoint の捕捉/encodeとexecuteCheckpointの後続stageをrunId/attemptIdで結合する。
// encode失敗は捕捉側だけで完結する。成功も記録し、再encode・二重計上をせずDiagnosticEventと分ける。
export type CheckpointMeasurement = Readonly<{
  runId: string;
  inputIds: readonly string[];
  unit: UnitId;
  generation: number;
  attemptId: string;
  stage: SaveFailureStage;
  startedMonotonicMs: number;
  endedMonotonicMs: number;
  bytes: number;
  outcome: "succeeded" | "failed";
  retryReason: "notRetry" | "saveFailed" | "ackUncertain";
}>;

export type EewTrialSetup = Readonly<{
  schemaVersion: "p2-eew-trial-setup-v1";
  initialStateRef: string;
  initialStateSha256: string;
  initialCheckpoints: Readonly<Partial<Record<UnitId, Readonly<{
    ref: string | null;
    sha256: string | null;
  }>>>>;
  clock: Readonly<{ wallTimeOriginMs: number; monotonicOrigin: "runNodeClock" }>;
  resetBeforeEachTrial: readonly string[];
  prepareDirtyGeneration: readonly string[];
  preventReplacementUntilPaintOrTimeout: readonly string[];
}>;

export type EewMeasurementManifest = Readonly<{
  schemaVersion: "p2-eew-e01-manifest-v1";
  manifestId: string;
  manifestSha256: string;
  contractSha256: Readonly<Record<string, string>>;
  trialSetupRef: string;
  trialSetupSha256: string;
  loads: Readonly<Record<LoadProfileId, ReplayLoad>>;
  populations: Readonly<Record<EewPopulation, Readonly<{
    load: LoadProfileId;
    trigger: string;
    targetOffsetMs: 1;
    acceptedOffsetRangeMs: readonly [0, 5];
  }>>>;
  warmupPerRun: 100;
  samplesPerRun: 1000;
  runCount: 3;
  missingAfterMs: 10000;
  quantile: "nearestRank";
  clockProbeEveryMs: 30000;
  maxClockIntervalWidthMs: 5;
  chrome: Readonly<{
    version: string;
    foregroundTab: true;
    viewportCssPx: readonly [number, number];
    dpr: number;
    motion: "reduced" | "full";
  }>;
  nodeVersion: string;
  osVersion: string;
  device: string;
  geometrySha256: string;
  fixtureSha256: Readonly<Record<string, string>>;
}>;

export type EewMeasurementRunResult = Readonly<{
  schemaVersion: "p2-eew-e01-result-v1";
  manifestId: string;
  manifestSha256: string;
  resultSha256: string;
  population: EewPopulation;
  run: 1 | 2 | 3;
  status: VerificationStatus;
  samples: number;
  missing: number;
  traceMissing: number;
  p50LowerMs: number | null;
  p50UpperMs: number | null;
  p95LowerMs: number | null;
  p95UpperMs: number | null;
  p99LowerMs: number | null;
  p99UpperMs: number | null;
  maxLowerMs: number | null;
  maxUpperMs: number | null;
  evidenceRefs: readonly string[];
}>;

export type EewCauseAssessment = Readonly<{
  cause: "none" | "xmlParse" | "checkpointEncode" | "projectionFormatting" | "transferPaint" | "mixed" | "unclassified";
  decision: "keepA" | "requireParseWorkerB" | "fixNonParseCause" | "blocked" | "notEvaluated";
  evidenceRefs: readonly string[];
  attemptedFixes: readonly string[];
}>;
