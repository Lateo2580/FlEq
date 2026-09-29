import { describe, expect, it } from "vitest";

import type { CheckpointMeasurement, ProcessingMeasurement } from "../../contracts/p2-eew-e01.types";
import { classifyEewCause, summarizeEewE01, summarizeHealthE02 } from "../../src/measurement/eew-e01/judge";
import { formalRun, injection, makeManifest, markers, sample } from "./fixtures";

const manifest = makeManifest();
const flat = (lo: number, up: number) => () => [lo, up] as [number, number];

describe("P2-A10-T02 judgment (synthetic samples)", () => {
  it("run ごとに判定する: nearest-rank・warm-up 除外(Pass) / 欠落(Fail) / 時計幅超過(未確認)。合算で救済しない", () => {
    const r1 = formalRun(1, (k) => [(k + 1) * 0.2, (k + 1) * 0.2 + 2]);
    const r2 = formalRun(2, flat(100, 103), (k, s, i) => (k === 500
      ? [{ ...s, markers: markers(500_000, { t6: false }).slice(0, 3), correlation: { ...s.correlation, semanticRevision: null, displayVersion: null }, latencyLowerMs: null, latencyUpperMs: null, missing: true, missingReason: "paintNotObservedWithin10s" }, i]
      : [s, i]));
    const r3 = formalRun(3, (k) => (k === 7 ? [100, 110] : [100, 103]));
    const { runs, verdict } = summarizeEewE01(manifest, [r1, r2, r3].flatMap((r) => r.samples), [r1, r2, r3].flatMap((r) => r.injections));
    const [a, b, c] = runs.filter((r) => r.scope === "formal");
    expect(a).toMatchObject({ status: "Pass", samples: 1000, missing: 0, injectedToT0P50Ms: 2 });
    expect(a!.p99LowerMs).toBeCloseTo(990 * 0.2); // ceil(0.99×1000)=990 番目。warm-up の 9999 は混ざらない
    expect(a!.maxUpperMs).toBeCloseTo(202);
    expect(b).toMatchObject({ status: "Fail", missing: 1, p99LowerMs: null });
    expect(c).toMatchObject({ status: "未確認", traceMissing: 0 });
    expect(verdict).toMatchObject({ label: "P2限定E01", status: "Fail" });
  });

  it("p99(L)>250 は Fail、p99(L)≤250<p99(U) は未確認。参考だけが良好でも Pass にならない(AC10)", () => {
    const fail = formalRun(1, flat(300, 303));
    const grey = formalRun(2, flat(240, 260));
    const ref = Array.from({ length: 10 }, (_, k) => sample("maxVpws50DecodeStarted", 1, k, 1, 2));
    const refInj = Array.from({ length: 10 }, (_, k) => injection("maxVpws50DecodeStarted", 1, k));
    const { runs, verdict } = summarizeEewE01(manifest, [...fail.samples, ...grey.samples, ...ref], [...fail.injections, ...grey.injections, ...refInj]);
    expect(runs.filter((r) => r.scope === "formal").map((r) => r.status)).toEqual(["Fail", "未確認", "未確認"]);
    expect(runs.find((r) => r.population === "maxVpws50DecodeStarted")).toMatchObject({ scope: "reference", status: "N/A", samples: 10, p99UpperMs: 2 });
    expect(verdict.referenceStatus).toMatchObject({ maxVpws50DecodeStarted: "measured", forecastDeadlineOverlap: "Blocked" });
  });
});

describe("P2-A10-T08 injection and verdict boundary", () => {
  it("callback 未到達(拒否/timeout)は欠落で Fail、未投入は未確認。Pass の run だけなら P2限定E01 Pass で除外 4 条件は未検証のまま", () => {
    const timeout = formalRun(1, flat(100, 103), (k, s, i) => (k === 3 ? [null, { ...i, outcome: "callbackTimeout" as const }] : [s, i]));
    const notInjected = formalRun(2, flat(100, 103), (k, s, i) => (k === 3 ? [null, { ...i, outcome: "notInjected" as const, injectedInjectorMonotonicMs: null }] : [s, i]));
    const good = [formalRun(1, flat(100, 103)), formalRun(2, flat(100, 103)), formalRun(3, flat(100, 103))];
    const bad = summarizeEewE01(manifest, [...timeout.samples, ...notInjected.samples], [...timeout.injections, ...notInjected.injections]);
    expect(bad.runs.slice(0, 2)).toMatchObject([{ status: "Fail", missing: 1, injectionFailures: 1 }, { status: "未確認", missing: 0, injectionFailures: 1 }]);
    const ok = summarizeEewE01(manifest, good.flatMap((r) => r.samples), good.flatMap((r) => r.injections));
    expect(ok.verdict.status).toBe("Pass");
    expect(ok.verdict.evidenceRefs).toEqual(["maxVpws50DecodeStarted", "maxWeatherCheckpointEncodeStarted", "maxForecastCheckpointSave", "forecastDeadlineOverlap"].map((p) => `unverified:excludedFromP2Formal:${p}`));
    expect(Object.values(ok.verdict.referenceStatus)).toEqual(["Blocked", "Blocked", "Blocked", "Blocked"]);
  });
});

const run = "r1";
const late = (lo = 300, up = 305, index = 100) => sample("fixedBacklog", 1, index, lo, up, { markers: [
  { point: "T0", clock: "node", monotonicMs: 0 }, { point: "T1", clock: "node", monotonicMs: 1 }, { point: "T2", clock: "node", monotonicMs: 200 },
  { point: "T3", clock: "node", monotonicMs: 210 }, { point: "T4", clock: "node", monotonicMs: 212 }, { point: "T5", clock: "chrome", monotonicMs: 250 },
  { point: "T6", clock: "chrome", monotonicMs: 300, paintEvidenceId: "p", cardMarkerId: "c", mapMarkerId: "m" }] });
const ownProc = (parseMs: number): ProcessingMeasurement => ({ runId: run, inputId: "fixedBacklog-1-100", startedMonotonicMs: 200, endedMonotonicMs: 210,
  marks: { ingressJsonMs: 0, base64DecodeMs: 0, decompressionMs: 0, fullXmlParseMs: parseMs, metadataSpecialValueMs: 0, domainExtractionMs: 0, workerTransferMs: 0 } });
const cp = (stage: CheckpointMeasurement["stage"], patch: Partial<CheckpointMeasurement> = {}): CheckpointMeasurement => ({
  runId: run, inputIds: ["x"], unit: "U-W", generation: 1, attemptId: "a1", stage, startedMonotonicMs: 0, endedMonotonicMs: 190,
  bytes: 10, outcome: "succeeded", retryReason: "notRetry", ...patch });

describe("P2-A10-T03 cause attribution", () => {
  it("待ちに重なった encode は非 parse 主因、parse は B。参考の未達は報告だけ(A/B に使わない)", () => {
    const enc = [cp("encode"), cp("write", { startedMonotonicMs: 190, endedMonotonicMs: 191 })];
    expect(classifyEewCause([late()], [ownProc(0)], enc)).toMatchObject({ cause: "checkpointEncode", decision: "fixNonParseCause" });
    const competitor: ProcessingMeasurement = { ...ownProc(190), inputId: "other", startedMonotonicMs: 0, endedMonotonicMs: 190 };
    expect(classifyEewCause([late()], [ownProc(0), competitor], [])).toMatchObject({ cause: "xmlParse", decision: "requireParseWorkerB" });
    const refLate = { ...late(), population: "maxVpws50DecodeStarted" as const };
    const ontime = sample("fixedBacklog", 1, 101, 100, 103);
    // 正式標本が 3 run × 1000 件そろっていなければ keepA にしない
    expect(classifyEewCause([refLate, ontime], [ownProc(0), competitor], [])).toMatchObject({ cause: "none", decision: "notEvaluated" });
    const complete = ([1, 2, 3] as const).flatMap((r) => formalRun(r, flat(100, 103)).samples).filter((s) => s.sampleIndex >= 100);
    expect(classifyEewCause([refLate, ...complete], [ownProc(0), competitor], [])).toMatchObject({
      cause: "none", decision: "keepA", evidenceRefs: ["reference:maxVpws50DecodeStarted:xmlParse"] });
  });

  it("結合の欠落・重複・不一致は推測せず unclassified/blocked。encode 失敗が捕捉側だけで完結するのは正当", () => {
    const blocked = { cause: "unclassified", decision: "blocked" };
    const proc = [ownProc(0)];
    expect(classifyEewCause([late()], proc, [cp("encode")])).toMatchObject(blocked); // 成功 encode に execute 側が無い
    expect(classifyEewCause([late()], proc, [cp("encode"), cp("encode"), cp("write", { startedMonotonicMs: 190 })])).toMatchObject(blocked);
    expect(classifyEewCause([late()], proc, [cp("encode"), cp("write", { startedMonotonicMs: 190, generation: 2 })])).toMatchObject(blocked);
    expect(classifyEewCause([late()], proc, [cp("encode", { outcome: "failed", bytes: 0 })])).toMatchObject({ cause: "checkpointEncode" });
    expect(classifyEewCause([late()], [], [])).toMatchObject(blocked); // 自入力の七区間が無い
  });
});

describe("P2-A10-T03 attribution guards", () => {
  it("競合する非 parse 処理の待ち(未説明)は parse 主因にならず、時計幅超過・warm-up・training の未達も B の根拠にならない", () => {
    const base = late(300, 305, 100);
    const stuck = { ...base, markers: base.markers.map((m) => (m.point === "T2" ? { ...m, monotonicMs: 290 } : m.point === "T3" ? { ...m, monotonicMs: 300 } : m)) };
    const own: ProcessingMeasurement = { ...ownProc(5), startedMonotonicMs: 290, endedMonotonicMs: 300 };
    const competitor: ProcessingMeasurement = { ...ownProc(20), inputId: "other", startedMonotonicMs: 0, endedMonotonicMs: 290 };
    expect(classifyEewCause([stuck], [own, competitor], [])).toMatchObject({ cause: "unclassified", decision: "blocked" });
    const parseHeavy = [ownProc(0), { ...ownProc(190), inputId: "other", startedMonotonicMs: 0, endedMonotonicMs: 190 }];
    expect(classifyEewCause([late(200, 300)], parseHeavy, [])).toMatchObject({ decision: "blocked" }); // 幅 100ms
    const warm = late(300, 305, 5);
    const training = { ...late(), correlation: { ...late().correlation, operation: "training" as const } };
    const complete = ([1, 2, 3] as const).flatMap((r) => formalRun(r, flat(100, 103)).samples).filter((s) => s.sampleIndex >= 100);
    expect(classifyEewCause([warm, training, ...complete], parseHeavy, [])).toMatchObject({ cause: "none", decision: "keepA" });
  });
});

describe("P2-A10-T02 evidence rules", () => {
  it("warm-up 欠け・下限が10秒超・版の重複は Pass にならず、参考は全 run 実施でだけ measured", () => {
    const r1 = formalRun(1, flat(100, 103));
    r1.samples = r1.samples.filter((s) => s.sampleIndex >= 100);
    const r2 = formalRun(2, flat(100, 103), (k, s, i) => [k === 5 ? { ...s, latencyLowerMs: 20000, latencyUpperMs: 20003 } : s, i]);
    const r3 = formalRun(3, flat(100, 103), (k, s, i) => (k === 5 || k === 6
      ? [{ ...s, correlation: { ...s.correlation, displayVersion: { streamId: "st", semanticRevision: "1", sequence: 999_999_999 } } }, i] : [s, i]));
    const m = makeManifest();
    const twoRuns = { ...m, reference: { ...m.reference, maxVpws50DecodeStarted: { ...m.reference.maxVpws50DecodeStarted, runCount: 2 as const } } };
    const ref = Array.from({ length: 10 }, (_, k) => sample("maxVpws50DecodeStarted", 1, k, 1, 2));
    const refInj = Array.from({ length: 10 }, (_, k) => injection("maxVpws50DecodeStarted", 1, k));
    const { runs, verdict } = summarizeEewE01(twoRuns, [r1, r2, r3].flatMap((r) => r.samples).concat(ref), [r1, r2, r3].flatMap((r) => r.injections).concat(refInj));
    expect(runs.slice(0, 3)).toMatchObject([{ status: "未確認" }, { status: "Fail", missing: 1 }, { status: "未確認", traceMissing: 2 }]);
    expect(verdict.referenceStatus.maxVpws50DecodeStarted).toBe("Blocked");
  });
});

describe("P2-A10-T07 health judgment", () => {
  it("失敗を +∞ として分位点に含める: 11 件(1.1%)の失敗で Fail、標本不足は未確認、worker 状態と失敗分類を数える", () => {
    const mk = (run: 1 | 2 | 3, n: number, failures: number) => Array.from({ length: n }, (_, k) => ({
      load: "N" as const, run, sampleIndex: k, scheduledMonotonicMs: k * 1000, requestStartMonotonicMs: k * 1000,
      bodyCompleteMonotonicMs: k < failures ? null : k * 1000 + 10, httpStatus: k < failures ? null : 200,
      worker: (k % 2 === 0 ? "healthy" : "stalled") as "healthy" | "stalled", failure: k < failures ? ("timeout" as const) : null }));
    const results = summarizeHealthE02(manifest, [...mk(1, 1000, 0), ...mk(2, 1000, 11), ...mk(3, 999, 0)]);
    expect(results).toHaveLength(6);
    expect(results.slice(0, 3)).toMatchObject([
      { load: "N", status: "Pass", p99Ms: 10, workerStates: { healthy: 500, stalled: 500 } },
      { status: "Fail", p99Ms: null, missing: 11, failures: { timeout: 11 } },
      { status: "未確認", samples: 999 },
    ]);
    expect(summarizeHealthE02(manifest, [...mk(1, 1000, 0), mk(1, 1, 0)[0]!])[0]).toMatchObject({ status: "未確認", samples: 1001 }); // index 0 の重複
    const bad = summarizeHealthE02(manifest, [{ ...mk(1, 1, 0)[0]!, httpStatus: 500 }]);
    expect(bad[0]).toMatchObject({ failures: { non200: 1 }, missing: 1 });
    expect(results[3]).toMatchObject({ load: "P", status: "未確認", samples: 0 });
  });
});
