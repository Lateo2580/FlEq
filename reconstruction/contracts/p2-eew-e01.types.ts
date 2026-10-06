import type { Operation, ProcessingMarks } from "./p1-parser-boundary.types";
import type { SaveFailureStage, UnitId } from "./p2-shared-runtime.types";
import type { DisplayVersion, DisplayWorkerView } from "./p2-snapshot-sse.types";
import type { ExecutionPlace, OwnerHeap, WriteCounts } from "./p3-execution-split.types";
import type { NotificationChannel } from "./p2-notification-delivery.types";

export type VerificationStatus = "Pass" | "Fail" | "Blocked" | "N/A" | "未確認";
// P2限定E01（R61）: 正式対象は fixedBacklog だけ。参考測定は単一スレッドで §7.5 の重畳 T0 が成立しない条件で、合否に使わない。
export type EewFormalPopulation = "fixedBacklog";
export type EewReferencePopulation =
  // 起点は host が decodeMaterial() 呼出し直前に記録した実単調時刻。full parse 開始の証拠ではない。
  | "maxVpws50DecodeStarted"
  | "maxWeatherCheckpointEncodeStarted"
  | "maxForecastCheckpointSave"
  | "forecastDeadlineOverlap";
export type EewPopulation = EewFormalPopulation | EewReferencePopulation;
export type LoadProfileId = "N" | "P" | "C";
// T0 は host の WS 受信 callback の実入口、T2 は P2 では処理開始（worker 開始ではない）。
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

// A9 が performance.mark の detail に載せる。名前はこの二つだけ。run/input との結合と paintEvidenceId は A10 が付ける。
export type ChromeEewMarkerDetail =
  | Readonly<{ name: "fleq:p2:eew:T5"; displayVersion: DisplayVersion }>
  | Readonly<{
      name: "fleq:p2:eew:T6-candidate";
      displayVersion: DisplayVersion;
      operation: Operation;
      subject: string;
      cardMarkerId: string;
      mapMarkerId: string;
      // 空配列は区域なし（旧塗り除去）の候補。
      mapAreaCodes: readonly string[];
    }>;

// runner が CDP で呼ぶ A9 の応答。Node 側の送受信時刻は runner が取る。
export type ChromeClockProbeResponse = Readonly<{
  probeId: string;
  chromeReceivedMonotonicMs: number;
  chromeSentMonotonicMs: number;
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
  schemaVersion: "p2-eew-trace-v2";
  population: EewPopulation;
  run: 1 | 2 | 3;
  sampleIndex: number;
  correlation: EewTraceCorrelation;
  markers: readonly EewTraceMarker[];
  clockProbeId: string | null;
  latencyLowerMs: number | null;
  latencyUpperMs: number | null;
  missing: boolean;
  missingReason: "paintNotObservedWithin10s" | "traceIncomplete" | "callbackNotReached" | null;
}>;

// host のイベントループから独立した投入側の記録（R61）。同一スレッドの timer 予定時刻を実投入時刻に代用しない。
export type EewInjectionRecord = Readonly<{
  runId: string;
  inputId: string;
  population: EewPopulation;
  run: 1 | 2 | 3;
  sampleIndex: number;
  scheduledInjectorMonotonicMs: number;
  injectedInjectorMonotonicMs: number | null;
  outcome: "callbackReached" | "notInjected" | "rejected" | "callbackTimeout";
  // 投入側時計から host の Node 単調時計への対応区間。対応不能は null で未確認。
  hostOffsetLowerMs: number | null;
  hostOffsetUpperMs: number | null;
}>;

// host → runner の観測はこの一経路だけ（startP2Host の config.observe）。
export type P2HostObservation =
  | Readonly<{ kind: "marker"; point: "T0" | "T1" | "T2"; runId: string; inputId: string; monotonicMs: number }>
  | Readonly<{ kind: "marker"; point: "T3" | "T4"; runId: string; displayVersion: DisplayVersion; monotonicMs: number }>
  // P3-C4-PARSE-MARK: full parse は最初の全文走査の開始から parse tree の完成まで（印が無いと null）。
  | Readonly<{ kind: "decode"; runId: string; inputId: string; startedMonotonicMs: number; endedMonotonicMs: number;
      xmlParseStartedMonotonicMs: number | null; xmlParseEndedMonotonicMs: number | null }>
  | Readonly<{ kind: "publishSerialization"; displayVersion: DisplayVersion; bytes: number; durationMs: number }>
  | Readonly<{ kind: "processing"; measurement: ProcessingMeasurement }>
  | Readonly<{ kind: "checkpoint"; measurement: CheckpointMeasurement }>
  // P3-C2-START-RECORD: control frame receipt for the live dmdata evidence. errorClose is an error frame's boolean close, else null.
  | Readonly<{ kind: "controlFrame"; frameType: "start" | "ping" | "error"; monotonicMs: number; errorClose: boolean | null }>
  // P3-C4-AC04(2)、E14: 書込み権 1 回に 1 行。dirtyObserved は権の送出の時点で未保存の最古の世代を publisher が最初に反映した
  // 時刻（未保存の世代が無い照合では null）。attemptIds は同じ返信の CheckpointMeasurement のもの。result は返信の CheckpointResult
  // の種類と世代（保存不要は null）で、E14 の ack を返信の単位で結ぶ（P3-C4-AC13(3)⑤）。
  | Readonly<{ kind: "checkpointGrant"; runId: string; grantId: string; unit: UnitId; attemptIds: readonly string[];
      dirtyObservedMonotonicMs: number | null; grantSentMonotonicMs: number; ownerStartedMonotonicMs: number;
      doneReceivedMonotonicMs: number; result: Readonly<{ kind: "acknowledged" | "failed" | "uncertain"; generation: number }> | null }>
  // P3-C4-AC13(3)②（工程2c）: publisher が inputDone を反映した時点で、その返信の inputGenerations にある unit ごとに 1 行（E14 の束の起点）。
  | Readonly<{ kind: "generationRaised"; runId: string; inputId: string; unit: UnitId; generation: number; monotonicMs: number }>
  // P3-C4-OWNER-HEAP=B': heap を持つ owner の返信を host が受けた時点で 1 行。inputId は inputDone のときだけ。
  | Readonly<{ kind: "ownerHeap"; runId: string; place: ExecutionPlace; replyKind: "deadlineDone" | "inputDone"; inputId: string | null;
      monotonicMs: number } & OwnerHeap>
  // 通知の初回試行が採用の返信を待つ時間（P3-C4-AC13(5)、Q-C3A-C4-MEASURES）: 予約の返信ごとに 1 行。予約の送出→返信の受信→adapter 呼出しの開始（採用されず始めなければ
  // null）。intent 生成からの待ちは createdAtWallMs と reservationSentWallMs の差。E01 の合否に使わない。
  | Readonly<{ kind: "notificationAdoption"; runId: string; channel: NotificationChannel; intentId: string; unit: UnitId; attempts: number;
      createdAtWallMs: number; reservationSentWallMs: number; reservationSentMonotonicMs: number; replyReceivedMonotonicMs: number;
      adopted: boolean; attemptStartedMonotonicMs: number | null }>
  // P3-C4-WRITE-COUNT、E15: 停止時に thread ごとに 1 行。confirmed が false なら counts と測定記録の両方から write が欠けうるので、
  // その窓の E15 は未確認。
  | Readonly<{ kind: "writeCount"; runId: string; thread: ExecutionPlace | "publisher"; confirmed: boolean; counts: WriteCounts }>
  // E15: 終了要約の書き手（診断 sink）が一時 file を書く試行ごとに 1 行。publisher の tmp を包みと独立に照らす（P3-C4-AC05）。
  | Readonly<{ kind: "shutdownSummaryWrite"; runId: string; bytes: number }>
  // P3-C4-E07-SOURCE（B）、E07: host の tick ごとと投入側の ping の受信ごとの入力 mailbox。accepted は mailbox が受理した累計で、
  // その行がどの frame までを含むかを示す。
  | Readonly<{ kind: "mailbox"; runId: string; monotonicMs: number; trigger: "tick" | "ping"; pendingItems: number;
      pendingBytes: number; inFlightItems: number; inFlightBytes: number; oldestPendingAgeMs: number | null;
      oldestIncompleteAgeMs: number | null; highWaterItems: number; highWaterBytes: number; limitViolations: number;
      accepted: number }>;

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

type ChromeConditions = Readonly<{
  version: string;
  foregroundTab: true;
  viewportCssPx: readonly [number, number];
  dpr: number;
  motion: "reduced" | "full";
}>;

// A9 実 Chrome smoke 前に先行凍結する A10 管理の条件（二段凍結の一段目）。marker 名と probe 方式は契約で固定済み。
export type ChromeSmokeConditions = Readonly<{
  schemaVersion: "p2-chrome-smoke-conditions-v1";
  // トップレベルの本 field だけを 64 個の ASCII 0 に置換した保存 UTF-8 bytes の sha256（契約と同じ自己 hash 規約）。
  // 凍結後のファイルは統合担当の再凍結でだけ変える。
  conditionsSha256: string;
  chrome: ChromeConditions;
  geometrySha256: string;
  // A9 questionResolutions[P2-A9-GEOMETRY].paintExpectations の参照。
  paintExpectationsRef: string;
  fixtureSha256: Readonly<Record<string, string>>;
}>;

export type ReferenceStopCondition =
  | Readonly<{ kind: "sampleCount"; samples: number }>
  | Readonly<{ kind: "elapsed"; maxDurationMs: number }>
  | Readonly<{ kind: "blocked"; reason: "stateNotReproducible" | "overlapNotEstablished" | "clockCorrespondenceUnavailable" | "injectionFailed" }>;

export type EewMeasurementManifest = Readonly<{
  schemaVersion: "p2-eew-e01-manifest-v2";
  manifestId: string;
  manifestSha256: string;
  contractSha256: Readonly<Record<string, string>>;
  trialSetupRef: string;
  trialSetupSha256: string;
  smokeConditionsSha256: string;
  smokeConditionDifferences: readonly string[];
  measuredSseClients: 1;
  notificationProbe: Readonly<Record<"desktop" | "sound", "idle" | "unavailable">>;
  loads: Readonly<Record<LoadProfileId, ReplayLoad>>;
  // 正式対象は固定負荷1つ×3 run。U-F が許容範囲を外れた試行は別条件として記録する。
  formal: Readonly<{
    population: EewFormalPopulation;
    load: LoadProfileId;
    trigger: string;
    forecast: Readonly<{
      subjects: number;
      encodedBytes: number;
      saveCondition: string;
      deadlineCondition: string;
      allowed: Readonly<{ maxSubjects: number; maxEncodedBytes: number }>;
    }>;
  }>;
  reference: Readonly<Record<EewReferencePopulation, Readonly<{
    load: LoadProfileId;
    trigger: string;
    stateRef: string;
    stateSha256: string;
    targetOffsetMs: 1;
    acceptedOffsetRangeMs: readonly [0, 5];
    // RET-02 の 300 とは別に条件ごとに事前固定する。
    warmupPerRun: number;
    samplesPerRun: number;
    runCount: 1 | 2 | 3;
    // 件数・経過時間・Blocked 理由だけ。遅延の観測値を打切り条件にしない。
    stopCondition: ReferenceStopCondition;
  }>>>;
  warmupPerRun: 100;
  samplesPerRun: 1000;
  runCount: 3;
  missingAfterMs: 10000;
  callbackDeadlineAfterInjectionMs: 10000;
  quantile: "nearestRank";
  clockProbeEveryMs: 30000;
  maxClockIntervalWidthMs: 5;
  health: Readonly<{ loads: readonly ["N", "P"]; requestEveryMs: 1000; requestTimeoutMs: number; minSamplesPerRun: 1000; runCount: 3 }>;
  auxiliary: Readonly<Record<"E03" | "E05" | "E06" | "E12", Readonly<{
    loads: readonly LoadProfileId[];
    minSamplesPerRun: number | null;
    runCount: number | null;
    condition: string;
  }>>>;
  chrome: ChromeConditions;
  nodeVersion: string;
  osVersion: string;
  device: string;
  geometrySha256: string;
  fixtureSha256: Readonly<Record<string, string>>;
}>;

export type EewMeasurementRunResult = Readonly<{
  schemaVersion: "p2-eew-e01-result-v2";
  manifestId: string;
  manifestSha256: string;
  resultSha256: string;
  population: EewPopulation;
  scope: "formal" | "reference";
  run: 1 | 2 | 3;
  // reference の遅延値は合否に使わない。実施不能だけを Blocked とする。
  status: VerificationStatus;
  samples: number;
  missing: number;
  traceMissing: number;
  injectionFailures: number;
  // 実投入→T0（受信 callback 以前の待ち）。投入側時計の対応不能は null。
  injectedToT0P50Ms: number | null;
  injectedToT0P99Ms: number | null;
  injectedToT0MaxMs: number | null;
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

// 最大負荷・受信 callback 以前の待ち・除外した重畳条件の保証を含まない。
export type P2LimitedE01Verdict = Readonly<{
  label: "P2限定E01";
  status: VerificationStatus;
  referenceStatus: Readonly<Record<EewReferencePopulation, "measured" | "Blocked">>;
  evidenceRefs: readonly string[];
}>;

export type HealthLatencySample = Readonly<{
  load: "N" | "P";
  run: 1 | 2 | 3;
  sampleIndex: number;
  scheduledMonotonicMs: number;
  requestStartMonotonicMs: number;
  bodyCompleteMonotonicMs: number | null;
  httpStatus: number | null;
  worker: DisplayWorkerView["state"] | null;
  // 失敗は分母から除かず、遅延 +∞ として分位点に含める。
  failure: "bodyIncomplete" | "non200" | "invalidBody" | "timeout" | null;
}>;

export type HealthLatencyRunResult = Readonly<{
  schemaVersion: "p2-e02-result-v1";
  manifestId: string;
  manifestSha256: string;
  resultSha256: string;
  load: "N" | "P";
  run: 1 | 2 | 3;
  status: VerificationStatus;
  samples: number;
  missing: number;
  failures: Readonly<Partial<Record<"bodyIncomplete" | "non200" | "invalidBody" | "timeout", number>>>;
  p99Ms: number | null;
  maxMs: number | null;
  workerStates: Readonly<Partial<Record<DisplayWorkerView["state"], number>>>;
  evidenceRefs: readonly string[];
}>;

// R62: 報告だけで上限にしない。
export type PublishCostReport = Readonly<{
  window: string;
  publishCount: number;
  totalJsonBytes: number;
  maxJsonBytes: number;
  serializeP50Ms: number | null;
  serializeP99Ms: number | null;
  serializeMaxMs: number | null;
}>;

export type EewCauseAssessment = Readonly<{
  cause: "none" | "xmlParse" | "checkpointEncode" | "projectionFormatting" | "transferPaint" | "mixed" | "unclassified";
  decision: "keepA" | "requireParseWorkerB" | "fixNonParseCause" | "blocked" | "notEvaluated";
  evidenceRefs: readonly string[];
  attemptedFixes: readonly string[];
}>;
