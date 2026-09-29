import type {
  EewInjectionRecord,
  EewMeasurementManifest,
  EewReferencePopulation,
  EewTraceMarker,
  EewTraceSample,
} from "../../contracts/p2-eew-e01.types";

// 判定試験用の合成入力。製品経路は通さない（T02/T07 の本体は後工程）。
let versionSeq = 0; // 版は標本ごとに一意
export const H = "a".repeat(64);

export function makeManifest(): EewMeasurementManifest {
  const ref = (load: "N" | "P" | "C") => ({
    load, trigger: "t", stateRef: "state.json", stateSha256: H, targetOffsetMs: 1 as const,
    acceptedOffsetRangeMs: [0, 5] as const, warmupPerRun: 0, samplesPerRun: 10, runCount: 1 as const,
    stopCondition: { kind: "sampleCount" as const, samples: 10 },
  });
  const load = (id: "N" | "P" | "C") => ({ id, fixtureRefs: ["f"], ordering: ["f"], offsetsMs: [0], durationMs: 1, sha256: H });
  const aux = { loads: ["N"] as const, minSamplesPerRun: null, runCount: null, condition: "c" };
  return {
    schemaVersion: "p2-eew-e01-manifest-v2", manifestId: "m1", manifestSha256: H, contractSha256: {},
    trialSetupRef: "ts.json", trialSetupSha256: H, smokeConditionsSha256: H, smokeConditionDifferences: [],
    measuredSseClients: 1, notificationProbe: { desktop: "idle", sound: "idle" },
    loads: { N: load("N"), P: load("P"), C: load("C") },
    formal: {
      population: "fixedBacklog", load: "N", trigger: "t",
      forecast: { subjects: 3, encodedBytes: 1000, saveCondition: "s", deadlineCondition: "d", allowed: { maxSubjects: 5, maxEncodedBytes: 2000 } },
    },
    reference: {
      maxVpws50DecodeStarted: ref("N"), maxWeatherCheckpointEncodeStarted: ref("N"),
      maxForecastCheckpointSave: ref("N"), forecastDeadlineOverlap: ref("N"),
    },
    warmupPerRun: 100, samplesPerRun: 1000, runCount: 3, missingAfterMs: 10000, callbackDeadlineAfterInjectionMs: 10000,
    quantile: "nearestRank", clockProbeEveryMs: 30000, maxClockIntervalWidthMs: 5,
    health: { loads: ["N", "P"], requestEveryMs: 1000, requestTimeoutMs: 1000, minSamplesPerRun: 1000, runCount: 3 },
    auxiliary: { E03: aux, E05: aux, E06: aux, E12: aux },
    chrome: { version: "154", foregroundTab: true, viewportCssPx: [1440, 900], dpr: 2, motion: "full" },
    nodeVersion: "24", osVersion: "x", device: "d", geometrySha256: H, fixtureSha256: {},
  };
}

export type Pop = "fixedBacklog" | EewReferencePopulation;

export function markers(base: number, opts: { t6?: boolean } = {}): EewTraceMarker[] {
  const m: EewTraceMarker[] = [
    { point: "T0", clock: "node", monotonicMs: base }, { point: "T1", clock: "node", monotonicMs: base + 1 },
    { point: "T2", clock: "node", monotonicMs: base + 2 }, { point: "T3", clock: "node", monotonicMs: base + 3 },
    { point: "T4", clock: "node", monotonicMs: base + 4 }, { point: "T5", clock: "chrome", monotonicMs: base + 90 },
  ];
  if (opts.t6 !== false) m.push({ point: "T6", clock: "chrome", monotonicMs: base + 100, paintEvidenceId: "pe", cardMarkerId: "c", mapMarkerId: "m" });
  return m;
}

export function sample(pop: Pop, run: 1 | 2 | 3, index: number, lo: number, up: number, patch: Partial<EewTraceSample> = {}): EewTraceSample {
  return {
    schemaVersion: "p2-eew-trace-v2", population: pop, run, sampleIndex: index,
    correlation: { runId: `r${run}`, inputId: `${pop}-${run}-${index}`, operation: "normal", subject: "s",
      semanticRevision: "1", displayVersion: { streamId: "st", semanticRevision: "1", sequence: ++versionSeq } },
    markers: markers(index * 1000), clockProbeId: "cp", latencyLowerMs: lo, latencyUpperMs: up, missing: false, missingReason: null,
    ...patch,
  };
}

export function injection(pop: Pop, run: 1 | 2 | 3, index: number, patch: Partial<EewInjectionRecord> = {}): EewInjectionRecord {
  return {
    runId: `r${run}`, inputId: `${pop}-${run}-${index}`, population: pop, run, sampleIndex: index,
    scheduledInjectorMonotonicMs: index * 1000, injectedInjectorMonotonicMs: index * 1000 - 7, outcome: "callbackReached",
    hostOffsetLowerMs: 5, hostOffsetUpperMs: 6, ...patch,
  };
}

// warm-up 100 + 正式 1000 の一 run 分。latency(k) は正式内の 0 始まり index。
export function formalRun(run: 1 | 2 | 3, latency: (k: number) => [number, number], mutate?: (k: number, s: EewTraceSample, i: EewInjectionRecord) => [EewTraceSample | null, EewInjectionRecord]) {
  const samples: EewTraceSample[] = [];
  const injections: EewInjectionRecord[] = [];
  for (let index = 0; index < 1100; index++) {
    const k = index - 100;
    const [lo, up] = k < 0 ? [9999, 9999] : latency(k);
    let s: EewTraceSample | null = sample("fixedBacklog", run, index, lo, up);
    let i = injection("fixedBacklog", run, index);
    if (k >= 0 && mutate) [s, i] = mutate(k, s, i);
    if (s != null) samples.push(s);
    injections.push(i);
  }
  return { samples, injections };
}
