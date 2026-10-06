import type {
  EewInjectionRecord,
  EewMeasurementManifest,
  EewMeasurementRunResult,
  EewTraceSample,
  LoadProfileId,
  VerificationStatus,
} from "./p2-eew-e01.types";

// P3-C4-AC01: the six EEW populations (spec §7.5 1〜3, R61's four conditions, the collision test).
// All of them inherit the loads and initial states of A10's a10-p2-20260930b unchanged.
// maxVpws50ParseStarted is triggered by the full XML parse start, not decode start (e01:562 (5)); it is a new ID
// because A10's maxVpws50DecodeStarted measured a different start point.
export type P3EewPopulation =
  | "fixedBacklog"
  | "maxVpws50ParseStarted"
  | "maxWeatherCheckpointEncodeStarted"
  | "maxForecastCheckpointSave"
  | "forecastDeadlineOverlap"
  | "maxVpws50ReceivedThenEew";

// How the runner decides, right after each trial, that the trial established its population's condition.
// Only established trials get a formal sampleIndex (P3-C4-AC03).
export type P3EewEstablishment =
  | Readonly<{ kind: "none" }>
  // spec:1133: injected 1 ms after the target start; T0 must fall 0〜5 ms after it while the target still runs.
  // span（P3-C4-ALT-SHAPE=A）: "population" は AC01 の母集団ごとの対象、"encodeThroughWrite" は期限回収で起きた U-F の保存の試行全体
  // （encode 開始〜write 完了）で、forecastDeadlineOverlap だけが使ってよい。判定の純関数は変えず、runner の対象の区間だけを切り替える。
  | Readonly<{ kind: "startOffset"; targetOffsetMs: 1; acceptedOffsetRangeMs: readonly [0, 5]; span: "population" | "encodeThroughWrite" }>
  // Collision: the EEW's actual send (injector clock, upper bound on the host clock) precedes the large frame's T1.
  | Readonly<{ kind: "sentBeforeLargeFrameIngested" }>;

export type P3EewPopulationCondition = Readonly<{
  // "reference": one run of the same warm-up and 1,000 samples, reported and never in the verdict
  // (the collision population when P3-C4-COLLISION-VERDICT=A).
  scope: "formal" | "reference";
  load: LoadProfileId;
  periodMs: number;
  trigger: string;
  stateRef: string;
  stateSha256: string;
  establishment: P3EewEstablishment;
  // The verdict's start point: "T0" (spec §7.5) or "injectorSend" (the collision population when
  // P3-C4-COLLISION-VERDICT=B: actual send → T6). The ruling rewrites only scope and origin.
  origin: "T0" | "injectorSend";
  // fixedBacklog only (A10's formal.forecast, checked by forecastWithinAllowance); null for the others.
  forecast: EewMeasurementManifest["formal"]["forecast"] | null;
  // Per window (population × run). maxAttempts counts every trial including the 100 warm-up trials; reaching either
  // limit before the 1,000th established formal trial makes the window Blocked.
  stopCondition: Readonly<{ maxAttempts: number; maxDurationMs: number }>;
  // 保存・期限回収の母集団（maxWeatherCheckpointEncodeStarted・maxForecastCheckpointSave・forecastDeadlineOverlap）で、引き金を予測した
  // tick の何 ms 前に送るか。ほかは null。正式の runner はこの値を使い、既定値（600・2,400ms）を使わない（P3-C4-AC13(1)）。
  triggerLeadMs: number | null;
}>;

export type P3E01Manifest = Readonly<
  Omit<EewMeasurementManifest, "schemaVersion" | "formal" | "reference" | "auxiliary"> & {
    schemaVersion: "p3-e01-manifest-v1";
    // A10's results under this manifest are never rewritten (plan §3.2).
    inheritsManifestId: "a10-p2-20260930b";
    populations: Readonly<Record<P3EewPopulation, P3EewPopulationCondition>>;
    // P3-C4-RUNNER-LIVENESS (Q-C2-RUNNER-LIVENESS): without pings, a window with a frame gap of 90 s or more
    // reconnects mid-window (A10's load N: 597,969 ms within one replay, 632,884 ms across the wrap).
    liveness: Readonly<{ pingEveryMs: 20000; maxFrameGapMs: 90000 }>;
    // E14 は同時 dirty の束の窓（P3-C4-E14-WINDOW=A）、ownerHeap は inputDone の heap だけを取る補助窓（P3-C4-OWNER-HEAP=B'）。
    auxiliary: Readonly<Record<"E03" | "E05" | "E06" | "E07" | "E12" | "E14" | "E15" | "ownerHeap", Readonly<{
      loads: readonly LoadProfileId[];
      minSamplesPerRun: number | null;
      runCount: number | null;
      condition: string;
      // E14 の束の間隔だけが非 null。
      intervalMs: number | null;
      // A window may be shared only when every sharing measurement's own condition holds; E01 windows are never shared.
      sharesWindowWith: string | null;
    }>>>;
    // P3-C4-MACHINES: the machine of each role, recorded with its actual Chrome/OS/Node at freeze.
    machines: Readonly<Record<"formal" | "gate" | "piBackend", string>>;
    // Q-C4-O09-SUBSET: O09 のうち C4 が閉じる step の位置。sequencesSha256 は sequences.json の meta.sha256（凍結の時に決める）。
    o09Subset: Readonly<{ sequenceId: "O09"; sequencesSha256: string; positions: readonly number[] }>;
    // plan §4.5: where each condition is judged as product performance; the Mac results of C4 are not that judgment.
    judgmentPlaces: Readonly<Record<"E01" | "E02" | "E03" | "E05" | "E06" | "E07" | "E14" | "E15", string>>;
  }
>;

export type P3EewTraceSample = Readonly<
  Omit<EewTraceSample, "schemaVersion" | "population"> & { schemaVersion: "p3-eew-trace-v1"; population: P3EewPopulation }
>;

// attemptIndex numbers every trial of the window, warm-up included. Warm-up trials get sampleIndex 0〜99 in order
// without the establishment check (spec:1118: separate fixed inputs). Formal trials are checked, and only established
// ones get 100〜1099. overlapNotEstablished trials stay outside the sample index space, are counted apart from
// injectionFailures, and never block Pass (spec:1133: reported with the reason).
export type P3EewInjectionRecord = Readonly<
  Omit<EewInjectionRecord, "population" | "outcome" | "sampleIndex"> & {
    population: P3EewPopulation;
    attemptIndex: number;
    sampleIndex: number | null;
    outcome: EewInjectionRecord["outcome"] | "overlapNotEstablished";
  }
>;

// scope is kept: a reference run gets its status by the same E01 rules and stays out of the verdict.
// injectedToT6*: actual send → T6, composed from the injector→host and host→Chrome correspondence intervals
// (null when either is unavailable). The verdict uses it only for origin "injectorSend".
export type P3EewRunResult = Readonly<
  Omit<EewMeasurementRunResult, "schemaVersion" | "population"> & {
    schemaVersion: "p3-eew-e01-result-v1";
    population: P3EewPopulation;
    attempts: number;
    overlapNotEstablished: number;
    injectedToT6P50LowerMs: number | null;
    injectedToT6P50UpperMs: number | null;
    injectedToT6P99LowerMs: number | null;
    injectedToT6P99UpperMs: number | null;
    injectedToT6MaxLowerMs: number | null;
    injectedToT6MaxUpperMs: number | null;
  }
>;

// Pass only when every formal population passes in every run. P4/P5 populations are not included.
export type P3E01Verdict = Readonly<{
  label: "P3 E01";
  status: VerificationStatus;
  populations: Readonly<Record<P3EewPopulation, VerificationStatus | "reference">>;
  evidenceRefs: readonly string[];
}>;
