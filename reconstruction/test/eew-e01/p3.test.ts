import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { CheckpointMeasurement, EewTraceSample } from "../../contracts/p2-eew-e01.types";
import type { P3E01Manifest, P3EewInjectionRecord, P3EewPopulation, P3EewTraceSample } from "../../contracts/p3-e01-reaccept.types";
import { HARNESS_TRIAL_SETUP, sealSelfHash, verifyFrozenP3Manifest } from "../../src/measurement/eew-e01/frozen";
import { establishTrial, summarizeP3E01 } from "../../src/measurement/eew-e01/judge";
import { checkpointWindows } from "./ac15.mjs";
import { assembleP3Trials, assembleTrials, buildHostIndex, rejectionReasons } from "./analysis.mjs";
import type { ChromeVersionEntry, HostLine, Probe } from "./analysis.mjs";
import { summarizeE15 } from "./aux-measures.mjs";
import type { HostRecord } from "./aux-measures.mjs";
import { buildP3Manifest, contractTextsOf } from "./draft.mjs";
import { injection, sample } from "./fixtures";
import { BACKEND_ONLY_CHROME, calibratedSendAt, chromeWindowsRefused, frameGapMeter, livenessBlocked, manifestChromeVersion, parseArgs, populationSpec, predictParseDelay,
  predictTick, publishedBy, reclaimTickToEncodeMs, scanHostLines, startInjector, trialTarget } from "./run.mjs";
import { auxWindows, currentsExpiredAtMeasure, expirySplit, waitFillExpiry } from "./windows.mjs";

const machine = { chromeVersion: "154.0.8037.92", nodeVersion: "v22.23.2", osVersion: "27.0.0 arm64", device: "test" };
// O09 の位置は凍結で空を拒否するので、契約の expectedDecisions（O09:2・O09:12）を置く。
const built = (collisionVerdict: "A" | "B" = "A") => buildP3Manifest({ id: "p3-test", collisionVerdict, ...machine, o09Positions: [2, 12] });

// 母集団 pop の 1 run（warm-up 100 + 正式 1000）。latency(k) は正式内の 0 始まり index の [L, U]。
function p3Run(pop: P3EewPopulation, run: 1 | 2 | 3, latency: (k: number) => [number, number], patchInjection: (i: P3EewInjectionRecord) => P3EewInjectionRecord = (i) => i) {
  const samples: P3EewTraceSample[] = [];
  const injections: P3EewInjectionRecord[] = [];
  for (let index = 0; index < 1100; index++) {
    const [lo, up] = index < 100 ? [9999, 9999] : latency(index - 100);
    const inputId = `${pop}-${run}-${index}`;
    const s: EewTraceSample = sample("fixedBacklog", run, index, lo, up);
    samples.push({ ...s, schemaVersion: "p3-eew-trace-v1", population: pop, correlation: { ...s.correlation, inputId } });
    injections.push(patchInjection({ ...injection("fixedBacklog", run, index), population: pop, inputId, attemptIndex: index }));
  }
  return { samples, injections };
}
const formalPops: P3EewPopulation[] = ["fixedBacklog", "maxVpws50ParseStarted", "maxWeatherCheckpointEncodeStarted", "maxForecastCheckpointSave", "forecastDeadlineOverlap"];
const allFormal = (latency: (pop: P3EewPopulation, run: 1 | 2 | 3) => (k: number) => [number, number]) => formalPops.flatMap((pop) => ([1, 2, 3] as const).map((run) => p3Run(pop, run, latency(pop, run))));
const judge = (m: P3E01Manifest, runs: ReturnType<typeof p3Run>[]) => summarizeP3E01(m, runs.flatMap((r) => r.samples), runs.flatMap((r) => r.injections));

describe("P3-C4-T01 establishment, overlapNotEstablished and the P3 verdict (AC01/AC02/AC03)", () => {
  it("startOffset: T0 at start −0.1/0/5/5.1 ms is not/is/is/not established, and a target that ended before T0 is not; the collision needs the send upper bound before the VPWS50 T1", () => {
    const startOffset = { kind: "startOffset", targetOffsetMs: 1, acceptedOffsetRangeMs: [0, 5], span: "population" } as const;
    const at = (t0Ms: number, endMs = 2000) => establishTrial({ establishment: startOffset, target: { startMs: 1000, endMs }, t0Ms, injectorSendHostMs: null }).established;
    expect([999.9, 1000, 1005, 1005.1].map((t0) => at(t0))).toEqual([false, true, true, false]);
    expect(at(1003, 1002)).toBe(false);
    const collision = (upperMs: number) => establishTrial({ establishment: { kind: "sentBeforeLargeFrameIngested" }, target: { startMs: 500, endMs: 500 }, t0Ms: 800,
      injectorSendHostMs: { lowerMs: upperMs - 0.02, upperMs } });
    expect([collision(499.9).established, collision(500).established]).toEqual([true, false]);
    // T0 に届かない投入は不成立へ逃がさない（callbackNotReached の欠落として数える）。
    expect(establishTrial({ establishment: startOffset, target: null, t0Ms: null, injectorSendHostMs: null })).toEqual({ established: true });
    expect(establishTrial({ establishment: startOffset, target: null, t0Ms: 1, injectorSendHostMs: null })).toEqual({ established: false, reason: "targetNotObserved" });
  });

  it("overlapNotEstablished trials carry no sampleIndex, are counted apart from injectionFailures and do not block Pass; one formal Fail fails the verdict, a 未確認 run without Fail leaves it 未確認, and the reference collision stays out", () => {
    const manifest = built("A").manifest;
    const ok = allFormal(() => () => [100, 103]);
    const notEstablished: P3EewInjectionRecord[] = Array.from({ length: 37 }, (_, k) => ({ ...injection("fixedBacklog", 1, 0), population: "maxVpws50ParseStarted",
      inputId: `ne-${k}`, attemptIndex: 1100 + k, sampleIndex: null, outcome: "overlapNotEstablished" }));
    const passed = summarizeP3E01(manifest, ok.flatMap((r) => r.samples), [...ok.flatMap((r) => r.injections), ...notEstablished]);
    expect(passed.runs.find((r) => r.population === "maxVpws50ParseStarted" && r.run === 1))
      .toMatchObject({ status: "Pass", samples: 1000, attempts: 1137, overlapNotEstablished: 37, injectionFailures: 0, missing: 0 });
    expect(passed.verdict).toMatchObject({ label: "P3 E01", status: "Pass", populations: { maxVpws50ReceivedThenEew: "reference", fixedBacklog: "Pass" } });
    expect(passed.runs.find((r) => r.population === "maxVpws50ReceivedThenEew")).toMatchObject({ scope: "reference", status: "Blocked", attempts: 0 });

    const oneFail = allFormal((pop, run) => (pop === "maxForecastCheckpointSave" && run === 2 ? () => [300, 303] : () => [100, 103]));
    expect(judge(manifest, oneFail).verdict).toMatchObject({ status: "Fail", populations: { maxForecastCheckpointSave: "Fail" } });
    const oneWide = allFormal((pop, run) => (pop === "forecastDeadlineOverlap" && run === 3 ? (k) => (k === 0 ? [100, 106] : [100, 103]) : () => [100, 103]));
    expect(judge(manifest, oneWide).verdict).toMatchObject({ status: "未確認", populations: { forecastDeadlineOverlap: "未確認", fixedBacklog: "Pass" } });
  });

  it("origin injectorSend judges actual send → T6: T0→T6 within 250 ms passes under origin T0 (A, reference) but the same samples fail under B when the send→T6 p99 lower bound exceeds 250 ms", () => {
    // T0 は index×1000、実送信は T0 の 20ms 前、host 時計への対応は [5, 6]: 実送信→T0 ∈ [14, 15]、実送信→T6 ∈ [254, 257]。
    const late = p3Run("maxVpws50ReceivedThenEew", 1, () => [240, 242], (i) => ({ ...i, injectedInjectorMonotonicMs: i.attemptIndex * 1000 - 20 }));
    const [a, b] = (["A", "B"] as const).map((v) => judge(built(v).manifest, [late]).runs.find((r) => r.population === "maxVpws50ReceivedThenEew" && r.run === 1));
    expect(a).toMatchObject({ scope: "reference", status: "Pass", p99UpperMs: 242, injectedToT6P99LowerMs: 254, injectedToT6P99UpperMs: 257 });
    expect(b).toMatchObject({ scope: "formal", status: "Fail", p99UpperMs: 242, injectedToT6P99LowerMs: 254 });
  });
});

// 観測行: T0〜T2 は inputId つき、T3 は版つき。
const obs = (o: Record<string, unknown>): HostLine => ({ t: "obs", o } as HostLine);
const mark = (point: "T0" | "T1" | "T2", inputId: string, monotonicMs: number) => obs({ kind: "marker", point, runId: "r", inputId, monotonicMs });
const version = (sequence: number) => ({ streamId: "s", semanticRevision: String(sequence), sequence });
const t3 = (sequence: number, monotonicMs: number) => obs({ kind: "marker", point: "T3", runId: "r", displayVersion: version(sequence), monotonicMs });
const head: HostLine[] = [{ t: "meta", runId: "r", nodeVersion: "v22", startedWallMs: 0 }, { t: "clock", hrtimeNs: "0", perfNowMs: 0 }];
const places: Record<string, string> = { X: "urgent", Y: "urgent", W: "weatherCurrent", Z: "urgent" };
const placeOf = (id: string) => places[id] ?? null;
const chromeOf = (entries: [number, string][]) => new Map<string, ChromeVersionEntry>(entries.map(([sequence, subject]) => [`s\u0000${sequence}`,
  { t5Ms: null, candidate: { operation: "normal", subject, cardMarkerId: "c", mapMarkerId: "m", mapAreaCodes: [] }, paint: { chromeMs: 1000 + sequence, paintEvidenceId: `frame:${sequence}`, hasScreenshot: false }, replacedBeforePaint: false }]));
const probe: Probe = { probeId: "p", atHrMs: 0, chosen: { nodeSentHrMs: 0, nodeReceivedHrMs: 0.5, chromeReceivedMonotonicMs: 0.2, chromeSentMonotonicMs: 0.3 }, attempts: [] };
const assemble = (lines: HostLine[], ids: string[], chrome: Map<string, ChromeVersionEntry>, rejections = new Map<string, string>()) => assembleTrials({
  population: "fixedBacklog", run: 1, trials: ids.map((inputId, k) => ({ index: 100 + k, inputId, subject: `eew-${inputId}`, scheduledHrMs: 0, injectedHrMs: 0, block: 0 })),
  host: buildHostIndex([...head, ...lines]), chromeByVersion: chrome, probes: [probe], blocks: [{ dataLoss: false }], callbackDeadlineMs: 10_000, missingAfterMs: 10_000, placeOf, rejections });

describe("P3-C4-T02 version binding per execution place in observation row order (AC03(2), C3a handover)", () => {
  it("an urgent EEW keeps its own T3 when a weatherCurrent T2 comes between (even if that T2 is later in monotonic time), and a row-order T2_X→T3_X→T2_Y binds X to T3_X although T2_Y < T3_X in monotonic time", () => {
    const lines = [mark("T0", "X", 1), mark("T1", "X", 2), mark("T2", "X", 10), mark("T0", "W", 3), mark("T1", "W", 4), mark("T2", "W", 50), t3(7, 30),
      mark("T0", "Y", 5), mark("T1", "Y", 6), mark("T2", "Y", 12), t3(8, 40)];
    expect(publishedBy(lines, 0, "X", placeOf)).toEqual([version(7)]);
    expect(publishedBy(lines, 0, "Y", placeOf)).toEqual([version(8)]);
    // 窓に入った別の場所の T3 は Chrome の subject で外れ、単調時刻の窓 [T2_X, T2_Y) から外れる T3_X（30 > 12）も自分の版に結び付く。
    const { samples } = assemble(lines, ["X", "Y"], chromeOf([[7, "eew-X"], [8, "eew-Y"]]));
    expect(samples.map((s) => [s.correlation.inputId, s.correlation.displayVersion?.sequence, s.missing])).toEqual([["X", 7, false], ["Y", 8, false]]);
  });

  it("the window closes at the same place's next T2 row, or at the end of the record; an input rejected after T0 becomes a missing sample carrying the diagnostic reason string as is", () => {
    const lines = [mark("T0", "X", 1), mark("T1", "X", 2), mark("T2", "X", 10), mark("T0", "Z", 3), mark("T1", "Z", 4), mark("T2", "Z", 20), t3(9, 25)];
    // X の窓は Z の T2 で閉じるので T3(9) は Z の窓にだけ入る。Z の窓は記録の終わりで閉じる。
    expect(publishedBy(lines, 0, "X", placeOf)).toEqual([]);
    expect(publishedBy(lines, 0, "Z", placeOf)).toEqual([version(9)]);
    const { samples, details } = assemble(lines, ["X", "Z"], chromeOf([[9, "eew-Z"]]), new Map([["X", "someFutureOwnerReason"]]));
    expect(samples[0]).toMatchObject({ missing: true, missingReason: "paintNotObservedWithin10s" });
    expect(details[0]).toMatchObject({ sample: "rejected", rejectedReason: "someFutureOwnerReason" });
    expect(samples[1]).toMatchObject({ missing: false, correlation: { displayVersion: version(9) } });
    // 拒否の理由は WARN・ERROR の診断だけから取る（INFO の通常の出来事を拒否と呼ばない）。
    expect([...rejectionReasons([{ inputId: "X", reason: "a", level: "WARN" }, { inputId: "X", reason: "b", level: "ERROR" }, { inputId: "Z", reason: "notificationExpired", level: "INFO" }])])
      .toEqual([["X", "a,b"]]);
  });

  it("AC03(1) boundary: an established trial becomes a p3 sample with its sampleIndex, a non-established one only an overlapNotEstablished injection record with sampleIndex null", () => {
    const lines = [mark("T0", "X", 1), mark("T1", "X", 2), mark("T2", "X", 10), t3(7, 12), mark("T0", "N", 20), mark("T1", "N", 21), mark("T2", "N", 22)];
    const trial = (inputId: string, index: number | null, attemptIndex: number) => ({ index, attemptIndex, inputId, subject: `eew-${inputId}`, scheduledHrMs: 0, injectedHrMs: 0, block: 0 });
    const { samples, injections } = assembleP3Trials({ population: "maxVpws50ParseStarted", run: 1, trials: [trial("X", 100, 100), trial("N", null, 101)],
      host: buildHostIndex([...head, ...lines]), chromeByVersion: chromeOf([[7, "eew-X"]]), probes: [probe], blocks: [{ dataLoss: false }],
      callbackDeadlineMs: 10_000, missingAfterMs: 10_000, placeOf });
    expect(samples.map((s) => [s.schemaVersion, s.sampleIndex, s.correlation.inputId, s.missing])).toEqual([["p3-eew-trace-v1", 100, "X", false]]);
    expect(injections.map((i) => [i.inputId, i.attemptIndex, i.sampleIndex, i.outcome])).toEqual([["X", 100, 100, "callbackReached"], ["N", 101, null, "overlapNotEstablished"]]);
  });
});

describe("P3-C4-T04 injector liveness (Q-C2-RUNNER-LIVENESS, injector side only)", () => {
  // 周期の timer と間隔の時計は偽にし（実時間に頼らない）、WS の配送だけは実物で、送った ping が全部届くのを待ってから閉じる。
  // 閉じた直後に数えると、最後の ping が terminate で落ちるか未配送で、送出と受信の数が 1 ずれることがあった。
  it("the injector sends ping frames at its interval while data is idle, and its record carries the ping count and the largest frame gap", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const cleanups: (() => unknown)[] = [];
    const client: { terminate(): void }[] = [];
    try {
      const injector = await startInjector({ add: (fn) => { cleanups.push(fn); } }, { pingEveryMs: 20_000, now: () => Date.now() });
      const { default: WebSocket } = await import("ws");
      const socket = new WebSocket(injector.url);
      client.push(socket);
      let received = 0;
      socket.on("message", (raw) => { if (JSON.parse(String(raw)).type === "ping") received += 1; });
      await injector.connected();
      injector.sendStart();
      // data の空き 140 秒（host の生存期限 90 秒より長い）の間、20 秒ごとに ping が出る。
      vi.advanceTimersByTime(140_000);
      injector.stopPings();
      while (received < injector.meter.pings) await new Promise((done) => setImmediate(done));
      await injector.close();
      expect([injector.meter.pings, received, injector.meter.maxFrameGapMs]).toEqual([7, 7, 20_000]);
    } finally {
      vi.useRealTimers();
      for (const socket of client) socket.terminate();
      for (const fn of cleanups) await fn();
    }
  });

  it("a recorded frame gap of 90 s or more makes the window Blocked", () => {
    let now = 0;
    const meter = frameGapMeter(() => now);
    meter.sent("start");
    now = 20_000; meter.sent("ping");
    now = 109_999.9; meter.sent("data");
    expect(livenessBlocked([meter], 90_000)).toBeNull();
    now = 199_999.9; meter.close();
    expect(meter).toMatchObject({ pings: 1, frames: 3, maxFrameGapMs: 90_000 });
    expect(livenessBlocked([meter], 90_000)).toMatch(/frame gap 90000ms >= 90000ms/);
  });
});

describe("P3-C4-T06 save occupancy after C1 (verify only on the no-memory path)", () => {
  const cp = (attemptId: string, stage: CheckpointMeasurement["stage"], from: number, to: number, bytes = 0): HostRecord => ({ t: "obs", o: { kind: "checkpoint", measurement: {
    runId: "r", inputIds: [], unit: "U-W", generation: 1, attemptId, stage, startedMonotonicMs: from, endedMonotonicMs: to, bytes, outcome: "succeeded", retryReason: "notRetry" } } });
  const steady = [cp("a", "encode", 0, 4, 900), cp("a", "write", 5, 6, 900), cp("a", "fileSync", 6, 8), cp("a", "close", 8, 9), cp("a", "rename", 9, 10), cp("a", "directorySync", 10, 12)];
  const noMemory = [cp("b", "encode", 20, 23, 900), cp("b", "directorySync", 25, 26), cp("b", "verify", 26, 30, 900)];

  it("a steady save is occupied by encode only in summarizeE15 and checkpointWindows; a verify stage is counted apart and added to neither encode nor write", () => {
    expect(summarizeE15(steady).units?.["U-W"]).toMatchObject({ occupiedMsLower: 4, verifyCount: 0, writeBytes: 900 });
    expect(checkpointWindows(steady).map((w) => [w.kind, w.fromMs, w.toMs])).toEqual([["encode", 0, 4], ["gap", 4, 5]]);
    const both = summarizeE15([...steady, ...noMemory]);
    expect(both.units?.["U-W"]).toMatchObject({ occupiedMsLower: 7, encodeBytes: 1800, writeBytes: 900, verifyCount: 1, verifyBytes: 900, verifyMs: 4 });
    expect(both.byteViolations).toBe(0);
    expect(checkpointWindows(noMemory).map((w) => [w.kind, w.fromMs, w.toMs])).toEqual([["encode", 20, 23], ["verify", 26, 30], ["gap", 23, 25]]);
  });
});

describe("P3-C4-T07 P3 manifest freeze (AC10)", () => {
  const verify = (manifestText: string, b = built()) => verifyFrozenP3Manifest({ manifestText, trialSetupText: b.trialSetupText, smokeConditionsText: b.smokeText, sequencesText: b.sequencesText,
    contractTexts: b.contractTexts, inherited: { manifestText: b.a10Text, initialStateText: b.initialStateText } });
  // 書き換える field だけの形（凍結物の改変を作るため）。
  type Editable = { loads: { N: { offsetsMs: number[] } }; populations: Record<string, { stateSha256: string; origin: string }>;
    contractSha256: Record<string, string>; auxiliary: Record<string, { sharesWindowWith: string | null }> };
  const reseal = (text: string, patch: (m: Editable) => void) => {
    const m = JSON.parse(text) as Editable;
    patch(m);
    return sealSelfHash(`${JSON.stringify(m, null, 2)}\n`, "manifestSha256");
  };

  it("the self hash, the contract hashes and the inherited A10 loads, initial state and fixtures verify; one change anywhere is refused", () => {
    for (const v of ["A", "B"] as const) expect(verify(built(v).manifestText).manifest.populations.maxVpws50ReceivedThenEew.origin).toBe(v === "A" ? "T0" : "injectorSend");
    const text = built().manifestText;
    expect(() => verify(text.replace('"periodMs": 3000', '"periodMs": 3001'))).toThrow("manifestSha256 mismatch");
    expect(() => verify(reseal(text, (m) => { m.loads.N.offsetsMs[0] += 1; }))).toThrow("load N differs from a10-p2-20260930b");
    expect(() => verify(reseal(text, (m) => { m.populations.maxForecastCheckpointSave.stateSha256 = "b".repeat(64); }))).toThrow("state is not the inherited initial state");
    expect(() => verify(reseal(text, (m) => { m.populations.maxVpws50ReceivedThenEew.origin = "injectorSend"; }))).toThrow("scope/origin");
    expect(() => verify(reseal(text, (m) => { m.contractSha256["P3-E01-REACCEPT-001"] = "c".repeat(64); }))).toThrow("contract hash: P3-E01-REACCEPT-001");
    expect(() => verify(reseal(text, (m) => { m.auxiliary.E07.sharesWindowWith = "e01-fixedBacklog-run1"; }))).toThrow("E01 windows are never shared");
    const b = built();
    expect(() => verifyFrozenP3Manifest({ manifestText: text, trialSetupText: b.trialSetupText, smokeConditionsText: b.smokeText, sequencesText: b.sequencesText, contractTexts: b.contractTexts,
      inherited: { manifestText: b.a10Text, initialStateText: `${b.initialStateText} ` } })).toThrow("initial-state sha256");
  });
});

describe("P3-C4-T09 frozen conditions read by the runner (AC13(1)(2)(7))", () => {
  const verify = (manifestText: string, b = built()) => verifyFrozenP3Manifest({ manifestText, trialSetupText: b.trialSetupText, smokeConditionsText: b.smokeText,
    sequencesText: b.sequencesText, contractTexts: b.contractTexts, inherited: { manifestText: b.a10Text, initialStateText: b.initialStateText } });
  type Editable = { populations: Record<string, { triggerLeadMs: number | null; establishment: { span?: string } }>; o09Subset: { sequencesSha256: string; positions: number[] } };
  const reseal = (text: string, patch: (m: Editable) => void) => {
    const m = JSON.parse(text) as Editable;
    patch(m);
    return sealSelfHash(`${JSON.stringify(m, null, 2)}\n`, "manifestSha256");
  };

  it("the runner takes the lead and the span of population 5 from the manifest; the freeze refuses a misplaced span or lead and an O09 subset not of these sequences", () => {
    const b = buildP3Manifest({ id: "p3-test", ...machine, lead: { forecastDeadlineOverlap: 1234 }, deadlineSpan: "encodeThroughWrite", o09Positions: [2, 12] });
    const manifest = verify(b.manifestText, b).manifest;
    const spec = populationSpec(manifest, "forecastDeadlineOverlap", 1, 100, 1000, { maxAttempts: 2000, maxDurationMs: 1 });
    expect([spec.leadMs, spec.span]).toEqual([1234, "encodeThroughWrite"]);
    expect(populationSpec(manifest, "maxVpws50ParseStarted", 1, 100, 1000, { maxAttempts: 2000, maxDurationMs: 1 }).leadMs).toBeNull();
    // span "encodeThroughWrite" の対象は encode 開始〜write 完了（元の対象の encode の区間ではない）。
    const checkpoints = [{ unit: "U-F", stage: "encode", attemptId: "a", generation: 8, startedMonotonicMs: 1000, endedMonotonicMs: 1001 },
      { unit: "U-F", stage: "write", attemptId: "a", generation: 8, startedMonotonicMs: 1002, endedMonotonicMs: 1010 }];
    const trial = { trigger: { inputId: "input-1", injectedHrMs: 0, predictedTickHostMs: 1000 } };
    const host = { decode: new Map(), t1: new Map(), t2: new Map([["input-1", 0]]), processing: [{ inputId: "input-1" }], raised: new Map([["input-1|U-F", 7]]), checkpoints };
    expect([trialTarget("forecastDeadlineOverlap", trial, host, 0, spec.span), trialTarget("forecastDeadlineOverlap", trial, host, 0)])
      .toEqual([{ startMs: 1000, endMs: 1010 }, { startMs: 1000, endMs: 1001 }]);
    // 対象は期限回収（入力の行の無い世代）を含む保存だけ: 採用 7 の保存そのもの、採用 7・背景の入力 8 の保存は選ばない。採用 7 の後に回収 8 と
    // 背景 9 がまとまった保存は選ぶ。採用の行が無い引き金（stale）は対象なし。
    const raised = (pairs: [string, number][]) => ({ ...host, raised: new Map([["input-1|U-F", 7], ...pairs]) });
    const at = (generation: number) => ({ ...host, checkpoints: checkpoints.map((c) => ({ ...c, generation })) });
    expect(trialTarget("forecastDeadlineOverlap", trial, { ...at(7), raised: raised([]).raised }, 0, spec.span)).toBeNull();
    expect(trialTarget("forecastDeadlineOverlap", trial, raised([["input-9|U-F", 8]]), 0, spec.span)).toBeNull();
    expect(trialTarget("forecastDeadlineOverlap", trial, { ...at(9), raised: raised([["input-9|U-F", 9]]).raised }, 0, spec.span)).toEqual({ startMs: 1000, endMs: 1010 });
    expect(trialTarget("forecastDeadlineOverlap", trial, { ...host, raised: new Map() }, 0, spec.span)).toBeNull();
    // 安全側の取りこぼし: 背景 8 の受信の中で回収がまとまり、続く背景 9 までの保存は、どの世代にも入力の行があるので選ばない。
    expect(trialTarget("forecastDeadlineOverlap", trial, { ...at(9), raised: raised([["input-8|U-F", 8], ["input-9|U-F", 9]]).raised }, 0, spec.span)).toBeNull();
    // mailbox が完了を受けなかった返信（T2 の行だけで processing の行が無い）があれば、行の無い世代を回収と読まない。
    expect(trialTarget("forecastDeadlineOverlap", trial, { ...host, t2: new Map([["input-1", 0], ["input-9", 1]]) }, 0, spec.span)).toBeNull();
    expect(() => verify(reseal(b.manifestText, (m) => { m.populations.maxForecastCheckpointSave.establishment.span = "encodeThroughWrite"; }), b)).toThrow("establishment");
    expect(() => verify(reseal(b.manifestText, (m) => { m.populations.maxVpws50ParseStarted.triggerLeadMs = 600; }), b)).toThrow("triggerLeadMs");
    expect(() => verify(reseal(b.manifestText, (m) => { m.o09Subset.sequencesSha256 = "d".repeat(64); }), b)).toThrow("o09Subset sequencesSha256");
    expect(() => verify(reseal(b.manifestText, (m) => { m.o09Subset.positions = [2, 999]; }), b)).toThrow("o09Subset positions");
  });

  it("population 2 records its predicted parse delay: none for the first ten trials, then the median of the latest ten", () => {
    const trials = Array.from({ length: 12 }, (_, i) => ({ trigger: { inputId: `t${i}`, injectedHrMs: i * 100 } }));
    // host の時計 = 投入側 + 5。parse 開始 − 実送信は 20 + i。
    const parseStarts = new Map(trials.map((t, i) => [t.trigger.inputId, t.trigger.injectedHrMs + 5 + 20 + i]));
    expect(predictParseDelay(trials.slice(0, 9), parseStarts, 5)).toBeNull();
    expect(predictParseDelay(trials.slice(0, 10), parseStarts, 5)).toBe(24.5);
    expect(predictParseDelay(trials, parseStarts, 5)).toBe(26.5);
  });
});

describe("P3-C4-T09 / R1〜R3 boundaries of the frozen manifest and the runner's recorded prediction", () => {
  const verify = (manifestText: string, b = built(), sequencesText = b.sequencesText) => verifyFrozenP3Manifest({ manifestText, trialSetupText: b.trialSetupText,
    smokeConditionsText: b.smokeText, sequencesText, contractTexts: b.contractTexts, inherited: { manifestText: b.a10Text, initialStateText: b.initialStateText } });
  type Editable = { extra?: number; health: { loads: string[] }; o09Subset: { positions: number[] };
    populations: Record<string, { establishment: { span?: string; acceptedOffsetRangeMs?: number[] } }>;
    auxiliary: Record<string, { runCount: number | null; minSamplesPerRun: number | null; intervalMs: number | null }> };
  const reseal = (text: string, patch: (m: Editable) => void) => {
    const m = JSON.parse(text) as Editable;
    patch(m);
    return sealSelfHash(`${JSON.stringify(m, null, 2)}\n`, "manifestSha256");
  };

  it("R3: a value the reader would drop is refused, not silently removed (span on fixedBacklog, a 3-element range, 3 health loads, an extra key, no O09 position)", () => {
    const text = built().manifestText;
    expect(() => verify(reseal(text, (m) => { m.populations.fixedBacklog.establishment.span = "population"; }))).toThrow("population fixedBacklog establishment");
    expect(() => verify(reseal(text, (m) => { m.populations.maxVpws50ParseStarted.establishment.acceptedOffsetRangeMs = [0, 5, 9]; }))).toThrow("acceptedOffsetRangeMs");
    expect(() => verify(reseal(text, (m) => { m.health.loads = ["N", "P", "C"]; }))).toThrow("health conditions");
    expect(() => verify(reseal(text, (m) => { m.extra = 1; }))).toThrow("manifest must have exactly");
    expect(() => verify(reseal(text, (m) => { m.o09Subset.positions = []; }))).toThrow("o09Subset positions");
  });

  it("R1/R2: E14 and ownerHeap need positive integer counts (E14 at most 512 bundles); E14 windows follow its runCount", () => {
    const text = built().manifestText;
    expect(() => verify(reseal(text, (m) => { m.auxiliary.E14.minSamplesPerRun = 1.5; }))).toThrow("auxiliary E14 counts");
    expect(() => verify(reseal(text, (m) => { m.auxiliary.E14.minSamplesPerRun = 513; }))).toThrow("auxiliary E14 needs");
    expect(() => verify(reseal(text, (m) => { m.auxiliary.ownerHeap.minSamplesPerRun = 0; }))).toThrow("auxiliary ownerHeap counts");
    expect(() => verify(reseal(text, (m) => { m.auxiliary.E14.runCount = 0; }))).toThrow("auxiliary E14 counts");
    // 工程2c: 訂正の通知予約の期限 15 秒と束がぶつからないよう、E14 の間隔は 20 秒以上。
    expect(() => verify(reseal(text, (m) => { m.auxiliary.E14.intervalMs = 15_000; }))).toThrow("auxiliary E14 intervalMs");
    const b = built();
    const manifest = verify(reseal(b.manifestText, (m) => { m.auxiliary.E14.runCount = 3; }), b).manifest;
    const ids = auxWindows({ manifest, initialState: JSON.parse(b.initialStateText), counts: {} }).map((w) => w.id).filter((id) => id.startsWith("e14-"));
    expect(ids).toEqual(["e14-run1", "e14-run2", "e14-run3"]);
  });

  it("T09: a sequences text whose meta matches but whose body was changed is refused; population 2's prediction stays on the trial record", () => {
    const b = built();
    expect(() => verify(b.manifestText, b, b.sequencesText.replace('"position": 2,', '"position": 2 ,'))).toThrow("o09Subset sequencesSha256");
    const trigger: { injectedHrMs: number; predictedParseDelayMs?: number | null } = { injectedHrMs: 1000 };
    expect([calibratedSendAt(trigger, 24.5, 1), trigger.predictedParseDelayMs]).toEqual([1025.5, 24.5]);
    expect([calibratedSendAt(trigger, null, 1), trigger.predictedParseDelayMs]).toEqual([1001, null]);
  });
});

// P3-MH-T03: 3 つの保存母集団の較正（UWR の後の保存の始まり、P3-MH-AC03）。
describe("P3-MH-T03 calibrated triggers of the three save populations (AC03)", () => {
  const cp = (unit: string, attemptId: string, stage: string, inputIds: string[], from: number, to: number, generation = 1) => obs({ kind: "checkpoint", measurement: {
    runId: "r", inputIds, unit, generation, attemptId, stage, startedMonotonicMs: from, endedMonotonicMs: to, bytes: 0, outcome: "succeeded", retryReason: "notRetry" } });
  const tick = (monotonicMs: number) => obs({ kind: "mailbox", runId: "r", monotonicMs, trigger: "tick" });

  it("(1) the delay is the median of the latest ten 'own save encode start − trigger send', null before ten trials", () => {
    // host の時計 = 投入側 + 5。引き金を含む U-F の保存の encode 開始 − 実送信は 30 + i。
    const trials = Array.from({ length: 12 }, (_, i) => ({ trigger: { inputId: `t${i}`, injectedHrMs: i * 3000 } }));
    const scan = scanHostLines(trials.map((t, i) => cp("U-F", `a${i}`, "encode", [t.trigger.inputId], t.trigger.injectedHrMs + 5 + 30 + i, t.trigger.injectedHrMs + 60)));
    expect([predictParseDelay(trials.slice(0, 9), scan.saveStarts["U-F"], 5), predictParseDelay(trials.slice(0, 10), scan.saveStarts["U-F"], 5),
      predictParseDelay(trials, scan.saveStarts["U-F"], 5)]).toEqual([null, 34.5, 36.5]);
  });

  it("(2) the tick phase comes from the mailbox tick rows only; checkpoint encode rows mixed in do not change it", () => {
    const ticks = Array.from({ length: 15 }, (_, i) => tick(437 + i * 1000));
    const mixed = ticks.flatMap((t, i) => [t, cp("U-F", `a${i}`, "encode", [], 437 + i * 1000 + 180, 437 + i * 1000 + 181)]);
    const [only, both] = [scanHostLines(ticks), scanHostLines(mixed)].map((s) => predictTick(s.ticks, 15_000, 1200));
    expect([only, both]).toEqual([16_437, 16_437]);
  });

  it("(2) regression: the deadline delay is measured from the tick that reclaimed (the targeted tick at or after validUntil), not the tick just before a save that started more than a second later", () => {
    // 回収の要求は 1000ms の tick、owner の応答待ちの間に 2000ms の tick の行が出て、encode 開始は 2300ms。遅れは 1300ms（300ms ではない）。
    const ticks = [0, 1000, 2000, 3000];
    const origin = 1_780_650_000_000;
    expect(reclaimTickToEncodeMs(ticks, { predictedTickHostMs: 1000, validUntilWallMs: origin + 1000 }, 2300, origin)).toBe(1300);
    // 狙った tick ではまだ期限前（validUntil が tick の後）、狙った tick の行が ±500ms に無い試行は較正に使わない。
    expect([reclaimTickToEncodeMs(ticks, { predictedTickHostMs: 1000, validUntilWallMs: origin + 1200 }, 2300, origin),
      reclaimTickToEncodeMs([0, 2000], { predictedTickHostMs: 1000, validUntilWallMs: origin + 1000 }, 2300, origin)]).toEqual([null, null]);
  });

  it("(3) a calibrated trial targets the save holding its trigger (the whole save for maxForecastCheckpointSave) and, for the deadline, the reclaim save even 500 ms or more from the predicted tick", () => {
    const host = { decode: new Map(), t1: new Map(), t2: new Map([["input-1", 0]]), processing: [{ inputId: "input-1" }], raised: new Map([["input-1|U-F", 7]]),
      checkpoints: [{ unit: "U-W", stage: "encode", attemptId: "w", generation: 3, startedMonotonicMs: 900, endedMonotonicMs: 903, inputIds: ["input-9"] },
        { unit: "U-W", stage: "encode", attemptId: "w1", generation: 4, startedMonotonicMs: 950, endedMonotonicMs: 952, inputIds: ["input-1"] },
        { unit: "U-F", stage: "encode", attemptId: "f", generation: 7, startedMonotonicMs: 960, endedMonotonicMs: 965, inputIds: ["input-1"] },
        { unit: "U-F", stage: "write", attemptId: "f", generation: 7, startedMonotonicMs: 966, endedMonotonicMs: 990, inputIds: ["input-1"] },
        { unit: "U-F", stage: "encode", attemptId: "g", generation: 8, startedMonotonicMs: 2700, endedMonotonicMs: 2701, inputIds: [] },
        { unit: "U-F", stage: "write", attemptId: "g", generation: 8, startedMonotonicMs: 2702, endedMonotonicMs: 2720, inputIds: [] }] };
    const calibrated = { trigger: { inputId: "input-1", injectedHrMs: 0, calibrated: true, predictedTickHostMs: 2000 } };
    expect([trialTarget("maxWeatherCheckpointEncodeStarted", calibrated, host, 0), trialTarget("maxForecastCheckpointSave", calibrated, host, 0),
      trialTarget("forecastDeadlineOverlap", calibrated, host, 0, "encodeThroughWrite")])
      .toEqual([{ startMs: 950, endMs: 952 }, { startMs: 960, endMs: 990 }, { startMs: 2700, endMs: 2720 }]);
    // C4 の記録（較正の印が無く predictedTickHostMs を持つ）は ±500ms の絞り込みのまま。
    expect(trialTarget("forecastDeadlineOverlap", { trigger: { inputId: "input-1", injectedHrMs: 0, predictedTickHostMs: 2000 } }, host, 0, "encodeThroughWrite")).toBeNull();
  });
});

// P3-MH-T05: harness の 1 組の照合・照合の集合・正式の CLI・backend 単独の manifest。
describe("P3-MH-T05 the harness pair, the contract set, the formal CLI and the backend-only manifest (AC05)", () => {
  const harness = () => buildP3Manifest({ id: "p3-harness-test", ...machine, o09Positions: [2, 12], trialSetup: HARNESS_TRIAL_SETUP.ref });
  const verify = (manifestText: string, b: ReturnType<typeof harness>, contractTexts = b.contractTexts) => verifyFrozenP3Manifest({ manifestText, trialSetupText: b.trialSetupText,
    smokeConditionsText: b.smokeText, sequencesText: b.sequencesText, contractTexts, inherited: { manifestText: b.a10Text, initialStateText: b.initialStateText } });
  type Editable = { trialSetupRef: string; trialSetupSha256: string; contractSha256: Record<string, string> };
  const reseal = (text: string, patch: (m: Editable) => void) => {
    const m = JSON.parse(text) as Editable;
    patch(m);
    return sealSelfHash(`${JSON.stringify(m, null, 2)}\n`, "manifestSha256");
  };

  it("the harness pair verifies with the harness contract key; another ref or hash, or a harness manifest without P3-MEASURE-HARNESS-001, is refused; the default is still the A10 pair", () => {
    const b = harness();
    const a10 = built();
    expect([b.manifest.trialSetupRef, a10.manifest.trialSetupRef]).toEqual([HARNESS_TRIAL_SETUP.ref, JSON.parse(a10.a10Text).trialSetupRef]);
    expect(b.initialStateText).toBe(readFileSync(JSON.parse(b.trialSetupText).initialStateRef, "utf8"));
    expect(verify(b.manifestText, b).manifest.populations.fixedBacklog.stateRef).toBe(`${JSON.parse(b.trialSetupText).initialStateRef}#populations.fixedBacklog`);
    expect(() => verify(reseal(b.manifestText, (m) => { m.trialSetupRef = "reconstruction/test/eew-e01/evidence/p3-harness/other.json"; }), b)).toThrow("trialSetup differs");
    expect(() => verify(reseal(b.manifestText, (m) => { m.trialSetupSha256 = "e".repeat(64); }), b)).toThrow("trialSetup differs");
    expect(() => verify(reseal(b.manifestText, (m) => { delete m.contractSha256["P3-MEASURE-HARNESS-001"]; }), b)).toThrow("lacks P3-MEASURE-HARNESS-001");
  });

  it("the runner passes exactly the manifest's contract keys; a key whose contract is missing stops the check", () => {
    const b = harness();
    const keys = Object.keys(b.manifest.contractSha256);
    expect(Object.keys(contractTextsOf(keys)).sort()).toEqual([...keys].sort());
    const withUnknown = reseal(b.manifestText, (m) => { m.contractSha256["P3-NOT-A-CONTRACT-001"] = "f".repeat(64); });
    expect(() => verify(withUnknown, b, contractTextsOf(Object.keys(JSON.parse(withUnknown).contractSha256)))).toThrow("contract text missing: P3-NOT-A-CONTRACT-001");
  });

  it("--node goes with --manifest and --only does not; a backend-only manifest never launches Chrome and refuses the E01 windows", async () => {
    expect(parseArgs(["--manifest", "m.json", "--node", "/usr/bin/node", "--windows", "e03-run1"]).selected).toEqual(["e03-run1"]);
    expect(() => parseArgs(["--manifest", "m.json", "--only", "fixedBacklog"])).toThrow("--only is allowed only with --preliminary");
    const backend = { chrome: { version: BACKEND_ONLY_CHROME } };
    expect(await manifestChromeVersion(backend, () => { throw new Error("Chrome launched"); })).toBe(BACKEND_ONLY_CHROME);
    expect([chromeWindowsRefused(backend, ["e03-run1", "e03-run2"]), chromeWindowsRefused(backend, ["e03-run1", "e01-fixedBacklog-run1"])])
      .toEqual([null, "the backend-only manifest cannot run windows that need Chrome: e01-fixedBacklog-run1"]);
    expect(chromeWindowsRefused({ chrome: { version: "154.0.8037.92" } }, ["e01-fixedBacklog-run1"])).toBeNull();
  });
});

// P3-MH-FULL-STATE=D の境界（品質レビュー P2-2・P2-3）: 失効の待ちの上限と、P 窓の測定の開始の期限。
describe("P3-MH-T02/AC02 regressions: the expiry-wait limit and the P-window measurement start", () => {
  const expected = { snapshotActive: { eew: "512/0/0", weatherCurrent: "127/1/1" }, checkpoint: { "U-F.subjects": 511 } };
  const after = { ...expected, snapshotActive: { ...expected.snapshotActive, eew: "0/0/0" } };
  const run = (answerAtMs: number) => {
    let now = 1_000_000 + 659_500;
    const filled = { record: { eewOriginWallMs: 1_000_000 } as { eewOriginWallMs: number; expiry?: unknown }, expected };
    const done = waitFillExpiry({ check: () => {}, wallMs: () => now }, { dir: "unused", progress: {} }, filled,
      { observe: async () => { now = answerAtMs; return after; }, pause: async () => { throw new Error("no second poll expected"); } });
    return { done, filled };
  };

  it("a matching /snapshot requested before origin + 660 s but answered after it is refused, not started", async () => {
    await expect(run(1_000_000 + 661_000).done).rejects.toThrow("stateNotReproducible");
    const inTime = run(1_000_000 + 659_900);
    await inTime.done;
    expect(inTime.filled.record.expiry).toMatchObject({ observedAfterExpiry: after });
  });

  it("a P window whose E02 client started its first request only after the fill's currents expired is Blocked (currentsExpiredBeforeMeasure)", () => {
    // host の時計 = runner の hrtime（clock 行が 0/0）。充填の起点 1,000,000、host の壁時計の起点 400,000 なので期限は host 1,200,000ms。
    const records = [{ t: "clock", hrtimeNs: "0", perfNowMs: 0 }];
    const client = { start: { hrtimeNs: String(1_199_000n * 1_000_000n), perfNowMs: 50 }, end: { hrtimeNs: String(1_300_000n * 1_000_000n) } };
    const row = (requestStartMonotonicMs: number) => ({ requestStartMonotonicMs, bodyCompleteMonotonicMs: requestStartMonotonicMs + 3, httpStatus: 200, failure: null });
    const split = (first: number) => expirySplit(records, [row(first), row(first + 1000)], client, { wallOriginMs: 400_000 }, { eewOriginWallMs: 1_000_000 });
    // client の起動は期限の前（host 1,199,000）でも、最初の要求が期限の後（50＋1,100 → host 1,200,100）なら Blocked。
    expect([split(1_150).measureStartHostMs, currentsExpiredAtMeasure(split(1_150))]).toEqual([1_200_100, expect.stringContaining("currentsExpiredBeforeMeasure")]);
    expect(currentsExpiredAtMeasure(split(950))).toBeNull();
  });
});
