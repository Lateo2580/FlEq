import type {
  CheckpointMeasurement,
  EewCauseAssessment,
  EewInjectionRecord,
  EewMeasurementManifest,
  EewMeasurementRunResult,
  EewPopulation,
  EewReferencePopulation,
  EewTraceMarker,
  EewTracePoint,
  EewTraceSample,
  HealthLatencyRunResult,
  HealthLatencySample,
  P2LimitedE01Verdict,
  ProcessingMeasurement,
  VerificationStatus,
} from "../../../contracts/p2-eew-e01.types";
import type {
  P3E01Manifest,
  P3E01Verdict,
  P3EewEstablishment,
  P3EewInjectionRecord,
  P3EewPopulation,
  P3EewRunResult,
  P3EewTraceSample,
} from "../../../contracts/p3-e01-reaccept.types";
import { nonEmpty, P3_POPULATIONS, REFERENCE_POPULATIONS, ZERO_HASH } from "./frozen";

// P2-A10 の判定（AC02/03/04/06/10/11/16）。I/O も時計も持たない純粋関数。
// 無いと、runner が結果ごとに別の分位点・欠落規則を持ち、Pass/Fail が測定のたびに揺れる。

const DEADLINE_MS = 250; // P2-A10-DLV-01
const MAX_CLOCK_WIDTH_MS = 5; // P2-A10-RES-01
const HEALTH_DEADLINE_MS = 100; // P2-A10-DLV-04
const FORMAL_WARMUP = 100; // manifest 型のリテラル。正式標本は index [100, 1100)
const FORMAL_SAMPLES = 1000;
const POINTS: readonly EewTracePoint[] = ["T0", "T1", "T2", "T3", "T4", "T5", "T6"];

// p = ceil(q × n) 番目（1 始まり）。sorted は昇順。
const nearestRank = (sorted: readonly number[], q: number): number => sorted[Math.ceil(q * sorted.length) - 1]!;
const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

function quantiles(values: readonly number[]): Readonly<{ p50: number; p95: number; p99: number; max: number }> | null {
  if (values.length === 0) return null;
  const s = ascending(values);
  return { p50: nearestRank(s, 0.5), p95: nearestRank(s, 0.95), p99: nearestRank(s, 0.99), max: s[s.length - 1]! };
}

// P2 と P3 の標本・投入記録が共有する形（P3-C4-AC02: 判定規則は母集団の型によらず一つ）。
type TallySample = Omit<EewTraceSample, "schemaVersion" | "population"> & Readonly<{ population: string }>;
type TallyInjection = Omit<EewInjectionRecord, "population" | "outcome"> & Readonly<{ population: string; outcome: string }>;

function markerOf(sample: TallySample, point: EewTracePoint): EewTraceMarker | null {
  const found = sample.markers.filter((m) => m.point === point);
  return found.length === 1 ? found[0]! : null;
}

// Pass の根拠にできる標本か。T0〜T6 が一つずつ・Node 側が単調・T6 に実 paint 証拠・実在する版・時計区間がある。
function traceComplete(sample: TallySample, requireNormal: boolean): boolean {
  const ms = POINTS.map((p) => markerOf(sample, p));
  if (ms.some((m) => m == null || !Number.isFinite(m.monotonicMs))) return false;
  const node = ms.slice(0, 5).map((m) => m!.monotonicMs);
  if (node.some((v, i) => i > 0 && v < node[i - 1]!)) return false;
  const t6 = ms[6]!;
  if (t6.point !== "T6" || !nonEmpty(t6.paintEvidenceId) || !nonEmpty(t6.cardMarkerId) || !nonEmpty(t6.mapMarkerId)) return false;
  const c = sample.correlation;
  const lo = sample.latencyLowerMs;
  const up = sample.latencyUpperMs;
  return c.semanticRevision != null && c.displayVersion != null && sample.clockProbeId != null &&
    lo != null && up != null && lo <= up && (!requireNormal || c.operation === "normal");
}

type Tally = {
  total: number;
  missing: number;
  traceMissing: number;
  injectionFailures: number;
  wide: boolean;
  lows: number[];
  ups: number[];
  waits: number[];
  waitsOk: boolean;
  warmupOk: boolean;
  // 実送信→T6（投入側→host と host→Chrome の対応区間の合成）。投入側の対応が無い標本は入らない（件数が total に満たず未確認）。
  sendLows: number[];
  sendUps: number[];
  sendWide: boolean;
};

const runKey = (population: string, run: number): string => `${population}|${run}`;

function groupByRun<T extends { population: string; run: number; sampleIndex: number }>(items: readonly T[]): Map<string, Map<number, T[]>> {
  const groups = new Map<string, Map<number, T[]>>();
  for (const item of items) {
    const key = runKey(item.population, item.run);
    const byIndex = groups.get(key) ?? new Map<number, T[]>();
    byIndex.set(item.sampleIndex, [...(byIndex.get(item.sampleIndex) ?? []), item]);
    groups.set(key, byIndex);
  }
  return groups;
}

// run ごとの集計（分位点の入力・時計区間・欠落の規則）。P2 の summarizeEewE01 と P3 の summarizeP3E01 が共有する。
function tallies(samples: readonly TallySample[], injections: readonly (TallyInjection & { sampleIndex: number })[], missingAfterMs: number) {
  const sampleGroups = groupByRun(samples);
  const injectionGroups = groupByRun(injections);
  // 相関は一対一: 同じ inputId の標本が二つ以上あれば、どちらも Pass の根拠にしない。
  // inputId（input-<n>）は host ごとに 1 から数え直すので、runId と組にして数える（別 run の同じ番号を重複にしない）。
  const inputCount = new Map<string, number>();
  const inputKey = (c: EewTraceSample["correlation"]): string => `${c.runId}\u0000${c.inputId}`;
  // 版も一対一: 同じ (streamId, sequence) を持つ標本が複数あれば、どれも Pass の根拠にしない。
  const versionCount = new Map<string, number>();
  const versionKey = (s: TallySample): string | null => {
    const v = s.correlation.displayVersion;
    return v == null ? null : `${v.streamId}\u0000${v.sequence}`;
  };
  for (const s of samples) {
    const ik = inputKey(s.correlation);
    inputCount.set(ik, (inputCount.get(ik) ?? 0) + 1);
    const vk = versionKey(s);
    if (vk != null) versionCount.set(vk, (versionCount.get(vk) ?? 0) + 1);
  }

  return (population: string, run: number, formal: boolean, warmup: number, count: number): Tally => {
    const key = runKey(population, run);
    const bySample = sampleGroups.get(key) ?? new Map<number, TallySample[]>();
    const byInjection = injectionGroups.get(key) ?? new Map<number, TallyInjection[]>();
    // 正式は期待する全 index が分母（未到達も除外しない）。参考は打切りがあるので実在した index だけ。
    const indexes = formal
      ? Array.from({ length: count }, (_, k) => warmup + k)
      : [...new Set([...bySample.keys(), ...byInjection.keys()])].filter((k) => k >= warmup && k < warmup + count).sort((a, b) => a - b);
    const t: Tally = { total: indexes.length, missing: 0, traceMissing: 0, injectionFailures: 0, wide: false, lows: [], ups: [], waits: [], waitsOk: true,
      warmupOk: !formal || Array.from({ length: warmup }, (_, k) => k).every((k) => bySample.has(k)), sendLows: [], sendUps: [], sendWide: false };
    for (const k of indexes) {
      const ss = bySample.get(k) ?? [];
      const ij = byInjection.get(k) ?? [];
      if (ss.length > 1 || ij.length > 1) { t.traceMissing++; continue; }
      const s = ss[0];
      const inj = ij[0];
      if (inj != null && inj.outcome !== "callbackReached") {
        t.injectionFailures++;
        if (inj.outcome !== "notInjected") t.missing++; // 拒否・timeout は callback 未到達の欠落
        continue;
      }
      // 実投入→T0（受信 callback 以前の待ち）。投入側時計の対応不能は null のまま報告する。上限側で数える。
      if (inj != null) {
        const t0 = s == null ? null : markerOf(s, "T0");
        if (t0 == null || inj.injectedInjectorMonotonicMs == null || inj.hostOffsetLowerMs == null) t.waitsOk = false;
        else t.waits.push(t0.monotonicMs - inj.injectedInjectorMonotonicMs - inj.hostOffsetLowerMs);
      }
      if (s == null) { t.traceMissing++; continue; }
      if (s.missing) {
        if (s.missingReason === "paintNotObservedWithin10s" || s.missingReason === "callbackNotReached") t.missing++;
        else t.traceMissing++;
        continue;
      }
      // DLV-02: 遅延の下限が missingAfterMs を超えた標本は、missing=false でも欠落。
      if (s.latencyLowerMs != null && s.latencyLowerMs > missingAfterMs) { t.missing++; continue; }
      const c = s.correlation;
      const vk = versionKey(s);
      if (inj == null || inj.inputId !== c.inputId || inj.runId !== c.runId || inputCount.get(inputKey(c)) !== 1 || (vk != null && versionCount.get(vk) !== 1) || !traceComplete(s, formal)) {
        t.traceMissing++;
        continue;
      }
      t.lows.push(s.latencyLowerMs!);
      t.ups.push(s.latencyUpperMs!);
      if (s.latencyUpperMs! - s.latencyLowerMs! > MAX_CLOCK_WIDTH_MS) t.wide = true;
      // 実送信（投入側時計）を host 時計へ写した区間 [inj+ohLo, inj+ohHi] と T0→T6 の区間を合成する。
      const t0 = markerOf(s, "T0")!.monotonicMs;
      if (inj.injectedInjectorMonotonicMs != null && inj.hostOffsetLowerMs != null && inj.hostOffsetUpperMs != null) {
        const lo = s.latencyLowerMs! + t0 - inj.injectedInjectorMonotonicMs - inj.hostOffsetUpperMs;
        const up = s.latencyUpperMs! + t0 - inj.injectedInjectorMonotonicMs - inj.hostOffsetLowerMs;
        t.sendLows.push(lo);
        t.sendUps.push(up);
        if (up - lo > MAX_CLOCK_WIDTH_MS) t.sendWide = true;
      }
    }
    return t;
  };
}

// 正式の run の合否: 欠落 1 以上は Fail を優先。証拠不足・時計幅超過は未確認。p99(L)>250 は Fail、p99(U)≤250 だけ Pass。
function formalStatus(t: Tally, lows: readonly number[], ups: readonly number[], wide: boolean): VerificationStatus {
  if (t.missing > 0) return "Fail";
  const lo = lows.length === t.total ? quantiles(lows) : null;
  const up = ups.length === t.total ? quantiles(ups) : null;
  if (t.traceMissing > 0 || t.injectionFailures > 0 || wide || lo == null || up == null || !t.warmupOk) return "未確認";
  return lo.p99 > DEADLINE_MS ? "Fail" : up.p99 <= DEADLINE_MS ? "Pass" : "未確認";
}

function summarizeEewE01(
  manifest: EewMeasurementManifest,
  samples: readonly EewTraceSample[],
  injections: readonly EewInjectionRecord[],
): Readonly<{ runs: readonly EewMeasurementRunResult[]; verdict: P2LimitedE01Verdict }> {
  const tally = tallies(samples, injections, manifest.missingAfterMs);

  const runs: EewMeasurementRunResult[] = [];
  type Q = ReturnType<typeof quantiles>;
  // resultSha256 は 0 埋めのまま返し、保存直前に sealSelfHash で埋める。
  const build = (population: EewPopulation, scope: "formal" | "reference", run: 1 | 2 | 3, t: Tally, status: VerificationStatus, lo: Q, up: Q): EewMeasurementRunResult => {
    const wait = t.waitsOk ? quantiles(t.waits) : null;
    return {
      schemaVersion: "p2-eew-e01-result-v2", manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH,
      population, scope, run, status, samples: t.total, missing: t.missing, traceMissing: t.traceMissing, injectionFailures: t.injectionFailures,
      injectedToT0P50Ms: wait?.p50 ?? null, injectedToT0P99Ms: wait?.p99 ?? null, injectedToT0MaxMs: wait?.max ?? null,
      p50LowerMs: lo?.p50 ?? null, p50UpperMs: up?.p50 ?? null, p95LowerMs: lo?.p95 ?? null, p95UpperMs: up?.p95 ?? null,
      p99LowerMs: lo?.p99 ?? null, p99UpperMs: up?.p99 ?? null, maxLowerMs: lo?.max ?? null, maxUpperMs: up?.max ?? null,
      evidenceRefs: [],
    };
  };

  const formalStatuses: VerificationStatus[] = [];
  for (const run of [1, 2, 3] as const) {
    const t = tally(manifest.formal.population, run, true, FORMAL_WARMUP, FORMAL_SAMPLES);
    const allBounds = t.lows.length === t.total;
    const status = formalStatus(t, t.lows, t.ups, t.wide);
    formalStatuses.push(status);
    runs.push(build(manifest.formal.population, "formal", run, t, status, allBounds ? quantiles(t.lows) : null, allBounds ? quantiles(t.ups) : null));
  }

  // 参考: 遅延値は合否に使わない。実施不能（Blocked 打切り・標本ゼロ）だけを Blocked、他は N/A で報告する。
  const measured = (population: EewReferencePopulation): "measured" | "Blocked" => {
    const ref = manifest.reference[population];
    let performed = 0;
    for (let run = 1; run <= ref.runCount; run++) {
      const t = tally(population, run, false, ref.warmupPerRun, ref.samplesPerRun);
      const status: VerificationStatus = ref.stopCondition.kind === "blocked" || t.total === 0 ? "Blocked" : "N/A";
      if (status === "N/A") performed++;
      const has = t.lows.length > 0;
      runs.push(build(population, "reference", run as 1 | 2 | 3, t, status, has ? quantiles(t.lows) : null, has ? quantiles(t.ups) : null));
    }
    return performed === ref.runCount ? "measured" : "Blocked";
  };
  const referenceStatus = {
    maxVpws50DecodeStarted: measured("maxVpws50DecodeStarted"),
    maxWeatherCheckpointEncodeStarted: measured("maxWeatherCheckpointEncodeStarted"),
    maxForecastCheckpointSave: measured("maxForecastCheckpointSave"),
    forecastDeadlineOverlap: measured("forecastDeadlineOverlap"),
  };

  const status: VerificationStatus = formalStatuses.includes("Fail") ? "Fail"
    : formalStatuses.every((s) => s === "Pass") ? "Pass" : "未確認";
  return {
    runs,
    verdict: {
      label: "P2限定E01", status, referenceStatus,
      // 除外した 4 条件は未検証のまま残す（P3 最初の契約群で正式検収）。成功数へ含めない。
      evidenceRefs: REFERENCE_POPULATIONS.map((p) => `unverified:excludedFromP2Formal:${p}`),
    },
  };
}

// P3-C4-AC01/AC03(1): 試行が母集団の条件を作れたか（runner と summarizeP3E01 の入力の組み立てが同じものを使う）。時刻はすべて host の時計。
// target は対象処理の区間（parse・encode・保存・期限処理。衝突では VPWS50 の T1 を startMs に置く）。injectorSendHostMs は実送信を host 時計へ写した区間。
// T0 に届かない投入は成立とする: callbackNotReached の欠落として数え、不成立へ逃がさない。
type EstablishmentResult =
  | Readonly<{ established: true }>
  | Readonly<{ established: false; reason: "targetNotObserved" | "callbackOutsideTarget" | "sentAfterLargeFrameIngested" | "injectorClockUnavailable" }>;

function establishTrial(input: Readonly<{
  establishment: P3EewEstablishment;
  target: Readonly<{ startMs: number; endMs: number }> | null;
  t0Ms: number | null;
  injectorSendHostMs: Readonly<{ lowerMs: number; upperMs: number }> | null;
}>): EstablishmentResult {
  const { establishment: e, target, t0Ms } = input;
  if (e.kind === "none" || t0Ms == null) return { established: true };
  if (target == null) return { established: false, reason: "targetNotObserved" };
  switch (e.kind) {
    case "startOffset": {
      const offset = t0Ms - target.startMs;
      const inside = offset >= e.acceptedOffsetRangeMs[0] && offset <= e.acceptedOffsetRangeMs[1] && t0Ms <= target.endMs;
      return inside ? { established: true } : { established: false, reason: "callbackOutsideTarget" };
    }
    case "sentBeforeLargeFrameIngested":
      if (input.injectorSendHostMs == null) return { established: false, reason: "injectorClockUnavailable" };
      return input.injectorSendHostMs.upperMs < target.startMs ? { established: true } : { established: false, reason: "sentAfterLargeFrameIngested" };
    default: { const unknown: never = e; throw new Error(`unknown establishment ${String(unknown)}`); }
  }
}

// P3-C4-AC02: 6 母集団の E01。正式は各 run が単独で判定され、参考（scope reference）も同じ規則で判定して verdict に入れない。
// 不成立（overlapNotEstablished）の試行は index 空間の外で別に数え、Pass を妨げない。origin injectorSend は実送信→T6 で合否を付ける。
function summarizeP3E01(
  manifest: P3E01Manifest,
  samples: readonly P3EewTraceSample[],
  injections: readonly P3EewInjectionRecord[],
): Readonly<{ runs: readonly P3EewRunResult[]; verdict: P3E01Verdict }> {
  const indexed = injections.flatMap((i) => (i.sampleIndex != null && i.outcome !== "overlapNotEstablished" ? [{ ...i, sampleIndex: i.sampleIndex }] : []));
  const tally = tallies(samples, indexed, manifest.missingAfterMs);
  const attempts = new Map<string, { attempts: number; overlap: number }>();
  for (const i of injections) {
    const a = attempts.get(runKey(i.population, i.run)) ?? { attempts: 0, overlap: 0 };
    a.attempts++;
    if (i.outcome === "overlapNotEstablished") a.overlap++;
    attempts.set(runKey(i.population, i.run), a);
  }
  const all = (values: readonly number[], t: Tally) => (values.length === t.total ? quantiles(values) : null);

  const runs: P3EewRunResult[] = [];
  const populations = {} as Record<P3EewPopulation, VerificationStatus | "reference">;
  const formalStatuses: VerificationStatus[] = [];
  for (const population of P3_POPULATIONS) {
    const condition = manifest.populations[population];
    const statuses: VerificationStatus[] = [];
    for (let run = 1; run <= (condition.scope === "formal" ? manifest.runCount : 1); run++) {
      const t = tally(population, run, true, manifest.warmupPerRun, manifest.samplesPerRun);
      const a = attempts.get(runKey(population, run)) ?? { attempts: 0, overlap: 0 };
      const status: VerificationStatus = a.attempts === 0 ? "Blocked"
        : condition.origin === "injectorSend" ? formalStatus(t, t.sendLows, t.sendUps, t.sendWide) : formalStatus(t, t.lows, t.ups, t.wide);
      statuses.push(status);
      const [lo, up, sendLo, sendUp] = [all(t.lows, t), all(t.ups, t), all(t.sendLows, t), all(t.sendUps, t)];
      const wait = t.waitsOk ? quantiles(t.waits) : null;
      runs.push({
        schemaVersion: "p3-eew-e01-result-v1", manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH,
        population, scope: condition.scope, run: run as 1 | 2 | 3, status, samples: t.total, missing: t.missing, traceMissing: t.traceMissing,
        injectionFailures: t.injectionFailures, attempts: a.attempts, overlapNotEstablished: a.overlap,
        injectedToT0P50Ms: wait?.p50 ?? null, injectedToT0P99Ms: wait?.p99 ?? null, injectedToT0MaxMs: wait?.max ?? null,
        p50LowerMs: lo?.p50 ?? null, p50UpperMs: up?.p50 ?? null, p95LowerMs: lo?.p95 ?? null, p95UpperMs: up?.p95 ?? null,
        p99LowerMs: lo?.p99 ?? null, p99UpperMs: up?.p99 ?? null, maxLowerMs: lo?.max ?? null, maxUpperMs: up?.max ?? null,
        injectedToT6P50LowerMs: sendLo?.p50 ?? null, injectedToT6P50UpperMs: sendUp?.p50 ?? null, injectedToT6P99LowerMs: sendLo?.p99 ?? null,
        injectedToT6P99UpperMs: sendUp?.p99 ?? null, injectedToT6MaxLowerMs: sendLo?.max ?? null, injectedToT6MaxUpperMs: sendUp?.max ?? null,
        evidenceRefs: [],
      });
    }
    const aggregate: VerificationStatus = statuses.includes("Fail") ? "Fail" : statuses.every((s) => s === "Pass") ? "Pass" : "未確認";
    if (condition.scope === "formal") formalStatuses.push(aggregate);
    populations[population] = condition.scope === "formal" ? aggregate : "reference";
  }
  const status: VerificationStatus = formalStatuses.includes("Fail") ? "Fail" : formalStatuses.every((s) => s === "Pass") ? "Pass" : "未確認";
  return { runs, verdict: { label: "P3 E01", status, populations, evidenceRefs: [] } };
}

// 失敗は分母から除かず +∞ として分位点に含める。+∞ になる値は JSON にできないので null で報告する。
function summarizeHealthE02(manifest: EewMeasurementManifest, samples: readonly HealthLatencySample[]): readonly HealthLatencyRunResult[] {
  const results: HealthLatencyRunResult[] = [];
  for (const load of manifest.health.loads) {
    for (const run of [1, 2, 3] as const) {
      const mine = samples.filter((s) => s.load === load && s.run === run);
      const failures: Partial<Record<NonNullable<HealthLatencySample["failure"]>, number>> = {};
      const workerStates: Partial<Record<NonNullable<HealthLatencySample["worker"]>, number>> = {};
      const latencies = mine.map((s) => {
        const failure = s.failure ?? (s.bodyCompleteMonotonicMs == null ? "bodyIncomplete" : s.httpStatus !== 200 ? "non200" : null);
        if (failure != null) failures[failure] = (failures[failure] ?? 0) + 1;
        if (s.worker != null) workerStates[s.worker] = (workerStates[s.worker] ?? 0) + 1;
        return failure != null ? Infinity : s.bodyCompleteMonotonicMs! - s.requestStartMonotonicMs;
      });
      const q = quantiles(latencies);
      const finite = (v: number | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v);
      const duplicated = new Set(mine.map((s) => s.sampleIndex)).size !== mine.length; // 同じ標本の重複は数を水増しする
      const status: VerificationStatus = q == null || duplicated || mine.length < manifest.health.minSamplesPerRun ? "未確認"
        : q.p99 > HEALTH_DEADLINE_MS ? "Fail" : "Pass";
      results.push({
        schemaVersion: "p2-e02-result-v1", manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH,
        load, run, status, samples: mine.length, missing: Object.values(failures).reduce((a, b) => a + b, 0), failures,
        p99Ms: finite(q?.p99), maxMs: finite(q?.max), workerStates, evidenceRefs: [],
      });
    }
  }
  return results;
}

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

const BLOCKED = (evidenceRefs: readonly string[]): EewCauseAssessment => ({ cause: "unclassified", decision: "blocked", evidenceRefs, attemptedFixes: [] });

// 保存 record の結合検証。捕捉側（encode）は attempt ごとに一つだけ、execute 側（それ以外の stage）は encode 成功のときだけ在る。
function checkpointJoinProblem(checkpoints: readonly CheckpointMeasurement[]): string | null {
  const groups = new Map<string, CheckpointMeasurement[]>();
  for (const c of checkpoints) {
    if (!(c.endedMonotonicMs >= c.startedMonotonicMs)) return `clock:${c.runId}/${c.attemptId}/${c.stage}`;
    const key = `${c.runId}\u0000${c.attemptId}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const [key, group] of groups) {
    const label = key.replace("\u0000", "/");
    const encodes = group.filter((c) => c.stage === "encode");
    const rest = group.filter((c) => c.stage !== "encode");
    if (encodes.length !== 1) return `${encodes.length === 0 ? "captureMissing" : "encodeDuplicated"}:${label}`;
    const enc = encodes[0]!;
    if (group.some((c) => c.unit !== enc.unit || c.generation !== enc.generation || c.retryReason !== enc.retryReason ||
      c.inputIds.length !== enc.inputIds.length || c.inputIds.some((id, i) => id !== enc.inputIds[i]))) return `mismatch:${label}`;
    if (new Set(rest.map((c) => c.stage)).size !== rest.length) return `stageDuplicated:${label}`;
    if (enc.outcome === "failed" ? rest.length > 0 : rest.length === 0) return `executeSide:${label}`;
    if (rest.some((c) => c.startedMonotonicMs < enc.endedMonotonicMs)) return `clock:${label}`;
  }
  return null;
}

// unexplained: 4 成分で説明できない待ち。無いと競合する非 parse 処理の待ちが parse 主因に見える。
type Components = Record<"xmlParse" | "checkpointEncode" | "projectionFormatting" | "transferPaint" | "unexplained", number>;

// 主因は、他の全成分の合計を上回る成分（過半）。無ければ mixed。閾値は置かない。
// ponytail: 未達件数 × (processing + checkpoints) の一回きりの走査。runId で事前 group 化すれば下がる。
function attribute(late: readonly EewTraceSample[], processing: readonly ProcessingMeasurement[], checkpoints: readonly CheckpointMeasurement[]): Components | "blocked" {
  const sum: Components = { xmlParse: 0, checkpointEncode: 0, projectionFormatting: 0, transferPaint: 0, unexplained: 0 };
  for (const s of late) {
    const t = ["T0", "T2", "T3"].map((p) => markerOf(s, p as EewTracePoint)?.monotonicMs);
    const up = s.latencyUpperMs;
    const own = processing.find((p) => p.runId === s.correlation.runId && p.inputId === s.correlation.inputId);
    if (t.some((v) => v == null) || up == null || own == null) return "blocked";
    const [t0, t2, t3] = t as [number, number, number];
    // 待ち（T0→T3）に重なった run 内の parse（自入力・競合入力とも）と encode。区間の重なりを上限にする。
    let ownParse = 0;
    let parseSum = 0;
    let encodeSum = 0;
    for (const p of processing) {
      if (p.runId !== s.correlation.runId) continue;
      const parse = Math.min(p.marks.fullXmlParseMs ?? 0, overlap(t0, t3, p.startedMonotonicMs, p.endedMonotonicMs));
      sum.xmlParse += parse;
      parseSum += parse;
      if (p === own) ownParse = parse;
    }
    for (const c of checkpoints) {
      if (c.runId === s.correlation.runId && c.stage === "encode") encodeSum += overlap(t0, t3, c.startedMonotonicMs, c.endedMonotonicMs);
    }
    const projection = Math.max(0, t3 - t2 - ownParse);
    const transfer = Math.max(0, up - (t3 - t0));
    sum.checkpointEncode += encodeSum;
    sum.projectionFormatting += projection;
    sum.transferPaint += transfer;
    sum.unexplained += Math.max(0, up - (parseSum + encodeSum + projection + transfer));
  }
  return sum;
}

// 未説明が過半なら主因を確定できない（null → blocked）。
function dominant(sum: Components): Exclude<EewCauseAssessment["cause"], "none" | "unclassified"> | null {
  const total = Object.values(sum).reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  for (const [name, v] of Object.entries(sum) as [keyof Components, number][]) if (v > total - v) return name === "unexplained" ? null : name;
  return "mixed";
}

// 正式対象の未達だけを根拠に A/B を決める。参考測定は報告（evidenceRefs）だけ。結合・時計・対応が崩れたら推測せず blocked。
function classifyEewCause(
  samples: readonly EewTraceSample[],
  processing: readonly ProcessingMeasurement[],
  checkpoints: readonly CheckpointMeasurement[],
): EewCauseAssessment {
  const joinProblem = checkpointJoinProblem(checkpoints);
  if (joinProblem != null) return BLOCKED([`checkpointJoin:${joinProblem}`]);
  const ids = processing.map((p) => `${p.runId}\u0000${p.inputId}`);
  if (new Set(ids).size !== ids.length || processing.some((p) => !(p.endedMonotonicMs >= p.startedMonotonicMs))) return BLOCKED(["processingJoin"]);

  const isLate = (s: EewTraceSample): boolean => s.missing || (s.latencyUpperMs != null && s.latencyUpperMs > DEADLINE_MS);
  const refs: string[] = [];
  for (const population of REFERENCE_POPULATIONS) {
    const late = samples.filter((s) => s.population === population && isLate(s));
    if (late.length === 0) continue;
    const sum = attribute(late, processing, checkpoints);
    refs.push(`reference:${population}:${sum === "blocked" ? "unclassified" : dominant(sum) ?? "unclassified"}`);
  }

  const formal = samples.filter((s) => s.population === "fixedBacklog" && s.correlation.operation === "normal" &&
    s.sampleIndex >= FORMAL_WARMUP && s.sampleIndex < FORMAL_WARMUP + FORMAL_SAMPLES);
  const late = formal.filter(isLate);
  if (late.length === 0) {
    // 正式標本が (run, index) で 3 run × 1000 件そろっていなければ、未達なしとは言えない。
    const complete = formal.length === 3 * FORMAL_SAMPLES && new Set(formal.map((s) => `${s.run}|${s.sampleIndex}`)).size === formal.length;
    const unknown = !complete || formal.some((s) => s.latencyUpperMs == null);
    return { cause: "none", decision: unknown ? "notEvaluated" : "keepA", evidenceRefs: refs, attemptedFixes: [] };
  }
  // RES-01: 時計幅超過・遅延不明の未達標本(missing を除く)は B の根拠にしない。
  if (late.some((s) => !s.missing && (s.latencyLowerMs == null || s.latencyUpperMs == null || s.latencyUpperMs - s.latencyLowerMs > MAX_CLOCK_WIDTH_MS))) {
    return BLOCKED([...refs, "clockIntervalUnusable"]);
  }
  const sum = attribute(late, processing, checkpoints);
  const cause = sum === "blocked" ? null : dominant(sum);
  if (cause == null) return BLOCKED([...refs, "formalAttributionUnavailable"]);
  return { cause, decision: cause === "xmlParse" ? "requireParseWorkerB" : "fixNonParseCause", evidenceRefs: refs, attemptedFixes: [] };
}

export { quantiles, summarizeEewE01, summarizeHealthE02, classifyEewCause, checkpointJoinProblem, establishTrial, summarizeP3E01 };
export type { EstablishmentResult };
