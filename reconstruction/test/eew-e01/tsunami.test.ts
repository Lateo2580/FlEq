import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { P3TsunamiE01Manifest, P3TsunamiInjectionRecord, P3TsunamiPopulation, P3TsunamiTraceSample } from "../../contracts/p3-tsunami-e01.types";
import type { TsunamiAreaTransition, TsunamiUnitState } from "../../contracts/p3-tsunami-unit.types";
import { buildTsunamiPaint } from "../../src/display/chrome-eew/pure";
import { P3_TSUNAMI_POPULATIONS, sealSelfHash, verifyFrozenP3TsunamiManifest } from "../../src/measurement/eew-e01/frozen";
import { establishTsunamiTrial, summarizeP3TsunamiE01, transitionQuotas } from "../../src/measurement/eew-e01/judge";
import { toTsunamiView } from "../../src/units/tsunami/tsunami-unit";
import { analyzeTrace, assembleTsunamiTrials, buildHostIndex, candidateKey } from "./analysis.mjs";
import type { ChromeCandidateEntry, HostLine, Probe, TsunamiTrial } from "./analysis.mjs";
import { injection, sample } from "./fixtures";
import { TARGET_WAIT_MS, nextTransition, predictParseDelay, readDiagnosticsStrict, selectAuxWindows, settleDone, trialTarget, tsunamiStateBreaks } from "./run.mjs";
import * as auxMeasures from "./aux-measures.mjs";
import type { HostRecord } from "./aux-measures.mjs";
import { RELEASE_FIXTURE, TEMPLATE_FIXTURES, buildP3TsunamiManifest, buildTemplates, emptyTsunamiState, receiveTsunami, stopFromPreliminary, tsunamiReport } from "./tsunami.mjs";

const repo = join(__dirname, "../../..");
const machine = { chromeVersion: "154.0.8037.97", nodeVersion: "v22.23.2", osVersion: "27.0.0 arm64", device: "test" };
const built = () => buildP3TsunamiManifest({ id: "p3-c6-test", ...machine });
const T6T = "fleq:p3:tsunami:T6-candidate";

// ── 判定（T01: AC01・AC02） ──
// 母集団 pop の 1 run（warm-up 100 + 正式 1000）。遷移は系列の中で順に回す。latency(k, transition) は正式内の 0 始まり index の [L, U]。
function tsunamiRun(manifest: P3TsunamiE01Manifest, pop: P3TsunamiPopulation, run: 1 | 2 | 3,
  latency: (k: number, transition: TsunamiAreaTransition) => [number, number] = () => [100, 103]) {
  const transitions = manifest.populations[pop].transitions;
  const samples: P3TsunamiTraceSample[] = [];
  const injections: P3TsunamiInjectionRecord[] = [];
  for (let index = 0; index < 1100; index++) {
    // 正式は凍結した割り当て（余りは後ろの遷移、発令系 333/333/334）どおりに遷移を配る。
    const transition = index < 100 ? transitions[index % transitions.length]! : transitions[transitions.length - 1 - ((index - 100) % transitions.length)]!;
    const [lo, up] = index < 100 ? [9999, 9999] : latency(index - 100, transition);
    const inputId = `${pop}-${run}-${index}`;
    const s = sample("fixedBacklog", run, index, lo, up);
    samples.push({ ...s, schemaVersion: "p3-tsunami-trace-v1", population: pop, transition, correlation: { ...s.correlation, inputId } });
    injections.push({ ...injection("fixedBacklog", run, index), population: pop, inputId, attemptIndex: index, transition, notEstablishedReason: null });
  }
  return { samples, injections };
}
const allRuns = (manifest: P3TsunamiE01Manifest, latency: (pop: P3TsunamiPopulation, run: 1 | 2 | 3) => (k: number, t: TsunamiAreaTransition) => [number, number]) =>
  P3_TSUNAMI_POPULATIONS.flatMap((pop) => ([1, 2, 3] as const).map((run) => tsunamiRun(manifest, pop, run, latency(pop, run))));
const noBreaks = { tsunamiCapacityEvicted: 0, tsunamiCapacityExceeded: 0, eewCapacityExceeded: 0, tsunamiRevisionConflict: 0, staleTarget: 0 };
// 全窓の stateBreaks の記録（judge の 4 つ目の引数は必須、Q-C6-IMPL-AMEND）。patch で 1 窓だけ差し替える。
const windows = (patch: Partial<Record<string, typeof noBreaks>> = {}) => P3_TSUNAMI_POPULATIONS.flatMap((population) =>
  ([1, 2, 3] as const).map((run) => ({ population, run, stateBreaks: patch[`${population}|${run}`] ?? noBreaks })));

describe("P3-C6-T01 the tsunami E01 verdict (AC01・AC02)", () => {
  const manifest = built().manifest;
  it("not-established trials are counted by reason (the reasons sum to the total) outside the sample index and do not block Pass; a window with one stateBreak or without its record is 未確認; one Fail run fails the verdict", () => {
    const ok = allRuns(manifest, () => () => [100, 103]);
    const reasons = ["primeNotSettled", "startOffset", "eewOrder", "conditionDeviation"] as const;
    const notEstablished: P3TsunamiInjectionRecord[] = reasons.map((reason, k) => ({ ...injection("fixedBacklog", 1, 0), population: "escalation:maxVpws50ParseStarted",
      inputId: `ne-${k}`, attemptIndex: 1100 + k, sampleIndex: null, outcome: "overlapNotEstablished", transition: "issued", notEstablishedReason: reason }));
    const passed = summarizeP3TsunamiE01(manifest, ok.flatMap((r) => r.samples), [...ok.flatMap((r) => r.injections), ...notEstablished], windows());
    expect(passed.runs.find((r) => r.population === "escalation:maxVpws50ParseStarted" && r.run === 1)).toMatchObject({ status: "Pass", samples: 1000, attempts: 1104,
      overlapNotEstablished: 4, overlapNotEstablishedByReason: { primeNotSettled: 1, startOffset: 1, eewOrder: 1, conditionDeviation: 1 }, injectionFailures: 0 });
    expect(passed.verdict).toMatchObject({ label: "P3 tsunami E01", status: "Pass" });

    const broken = summarizeP3TsunamiE01(manifest, ok.flatMap((r) => r.samples), ok.flatMap((r) => r.injections),
      windows({ "deescalation:eewTogether|2": { ...noBreaks, tsunamiRevisionConflict: 1 } }));
    expect(broken.runs.find((r) => r.population === "deescalation:eewTogether" && r.run === 2)?.status).toBe("未確認");
    expect(broken.verdict).toMatchObject({ status: "未確認", populations: { "deescalation:eewTogether": "未確認", "escalation:fixedBacklog": "Pass" } });
    const unrecorded = summarizeP3TsunamiE01(manifest, ok.flatMap((r) => r.samples), ok.flatMap((r) => r.injections),
      windows().filter((w) => !(w.population === "escalation:eewTogether" && w.run === 1)));
    expect(unrecorded.runs.find((r) => r.population === "escalation:eewTogether" && r.run === 1)).toMatchObject({ status: "未確認", stateBreaks: null });

    const oneFail = allRuns(manifest, (pop, run) => (pop === "deescalation:fixedBacklog" && run === 3 ? () => [300, 303] : () => [100, 103]));
    expect(summarizeP3TsunamiE01(manifest, oneFail.flatMap((r) => r.samples), oneFail.flatMap((r) => r.injections), windows()).verdict)
      .toMatchObject({ status: "Fail", populations: { "deescalation:fixedBacklog": "Fail" } });
  });

  it("reports each transition; a transition whose p99 upper bound exceeds 250 ms leaves the series Pass when the series p99 is within 250 ms", () => {
    // 発令の 5 標本だけ 260〜262ms: 系列（1,000）の p99 は 990 番目で 250 以内、発令（333）の p99 は 330 番目で 262。
    let late = 0;
    const runs = allRuns(manifest, (pop, run) => (pop === "escalation:fixedBacklog" && run === 1
      ? (_k, t) => (t === "issued" && late++ < 5 ? [260, 262] : [100, 103]) : () => [100, 103]));
    const run1 = summarizeP3TsunamiE01(manifest, runs.flatMap((r) => r.samples), runs.flatMap((r) => r.injections), windows()).runs
      .find((r) => r.population === "escalation:fixedBacklog" && r.run === 1)!;
    expect(run1).toMatchObject({ status: "Pass", p99UpperMs: 103 });
    expect(run1.byTransition.issued).toMatchObject({ expected: 333, samples: 333, missing: 0, p99UpperMs: 262, maxUpperMs: 262 });
    expect(run1.byTransition.expanded).toMatchObject({ expected: 334, samples: 334, p99UpperMs: 103 });
  });
});

// ── 組み立て（T01: AC02・AC06(5)）。host の行・Chrome の候補は合成する ──
const obs = (o: Record<string, unknown>): HostLine => ({ t: "obs", o } as HostLine);
const at = (point: "T0" | "T1" | "T2", inputId: string, monotonicMs: number) => obs({ kind: "marker", point, runId: "r", inputId, monotonicMs });
const version = (sequence: number) => ({ streamId: "st", semanticRevision: String(sequence), sequence });
const published = (point: "T3" | "T4", sequence: number, monotonicMs: number) => obs({ kind: "marker", point, runId: "r", displayVersion: version(sequence), monotonicMs });
const SUBJECT = "normal/VTSE41/20261009060010";
const MAJOR = { present: true, areas: [{ code: "311", areaClass: "majorWarning" }] };
// prime（input-1、版 1）→ target（input-2、版 2）→ 次の入力（input-3）の T2 で target の窓が閉じ、その後に版 3。
const lines: HostLine[] = [{ t: "meta", runId: "r", nodeVersion: "v22", startedWallMs: 0 }, { t: "clock", hrtimeNs: "0", perfNowMs: 0 },
  at("T0", "input-1", 900), at("T1", "input-1", 901), at("T2", "input-1", 902), published("T3", 1, 905), published("T4", 1, 906),
  at("T0", "input-2", 1000), at("T1", "input-2", 1001), at("T2", "input-2", 1002), published("T3", 2, 1010), published("T4", 2, 1011),
  at("T0", "input-3", 1100), at("T1", "input-3", 1101), at("T2", "input-3", 1102), published("T3", 3, 1110)];
const probes: Probe[] = [{ probeId: "p", atHrMs: 1000, chosen: { nodeSentHrMs: 999, nodeReceivedHrMs: 1001, chromeReceivedMonotonicMs: 1000, chromeSentMonotonicMs: 1000 }, attempts: [] }];
const entry = (sequence: number, present: boolean, areas: readonly { code: string; areaClass: string }[], chromeMs: number): [string, ChromeCandidateEntry] => [
  candidateKey(version(sequence), SUBJECT, T6T),
  { candidate: { name: T6T, displayVersion: version(sequence), operation: "normal", subject: SUBJECT, present, cardMarkerId: "c", coastMarkerId: "coast:x",
    areas: areas.map((a) => ({ code: a.code, areaClass: a.areaClass as "majorWarning" })) }, paint: { chromeMs, paintEvidenceId: "frame:1", hasScreenshot: false }, replacedBeforePaint: false }];
const trial = (expectedPaint: typeof MAJOR, prime: TsunamiTrial["prime"]): TsunamiTrial => ({ attemptIndex: 100, index: 100, inputId: "input-2", subject: SUBJECT,
  scheduledHrMs: 990, injectedHrMs: 995, block: 0, phase: "formal", transition: "upgraded", expectedPaint, prime, eew: null, establishment: { established: true } });
const assemble = (trials: TsunamiTrial[], candidates: [string, ChromeCandidateEntry][], dataLoss = false) => assembleTsunamiTrials({ population: "escalation:fixedBacklog", run: 1, trials,
  host: buildHostIndex(lines), chromeByVersion: new Map(), chromeByCandidate: new Map(candidates), probes, blocks: [{ dataLoss }], callbackDeadlineMs: 10_000, missingAfterMs: 10_000 });

describe("P3-C6-T01 binding the tsunami T6 inside the target's version window (AC02・AC06(5))", () => {
  it("a candidate whose areas differ from expectedPaint is not T6, and a matching candidate in a later version outside the window is not picked: the sample is missing", () => {
    const { samples, details } = assemble([trial(MAJOR, null)], [entry(2, true, [{ code: "311", areaClass: "warning" }], 1050), entry(3, true, MAJOR.areas, 1150)]);
    expect(samples[0]).toMatchObject({ missing: true, missingReason: "paintNotObservedWithin10s", transition: "upgraded" });
    expect(details[0]).toMatchObject({ sample: "noMatchingCandidate" });
  });

  it("a release's present false candidate is its T6; a prime the trace shows painted after the target's T0 makes the sample traceIncomplete", () => {
    const released = assemble([trial({ present: false, areas: [] }, null)], [entry(2, false, [], 1050)]);
    expect(released.samples[0]).toMatchObject({ missing: false, latencyLowerMs: expect.closeTo(48.89, 1), schemaVersion: "p3-tsunami-trace-v1" });
    expect(released.samples[0]!.markers.find((m) => m.point === "T6")).toMatchObject({ monotonicMs: 1050, mapMarkerId: "coast:x" });
    const prime = { inputId: "input-1", paintRequired: true, expectedPaint: { present: true, areas: [{ code: "311", areaClass: "warning" }] } };
    const settled = assemble([trial(MAJOR, prime)], [entry(1, true, prime.expectedPaint.areas, 950), entry(2, true, MAJOR.areas, 1050)]);
    expect(settled.samples[0]).toMatchObject({ missing: false });
    // trace のブロックに dataLoss があれば、候補と paint が結べても標本にしない（Q-C6-IMPL-AMEND (14)）。
    const lost = assemble([trial(MAJOR, prime)], [entry(1, true, prime.expectedPaint.areas, 950), entry(2, true, MAJOR.areas, 1050)], true);
    expect([lost.samples[0], lost.details[0]]).toMatchObject([{ missing: true, missingReason: "traceIncomplete" }, { sample: "traceIncomplete(dataLoss)" }]);
    const late = assemble([trial(MAJOR, prime)], [entry(1, true, prime.expectedPaint.areas, 1000), entry(2, true, MAJOR.areas, 1050)]);
    expect(late.samples[0]).toMatchObject({ missing: true, missingReason: "traceIncomplete" });
    expect(late.details[0]).toMatchObject({ sample: "primeSettledNotConfirmedByTrace" });
  });

  it("the EEW reference of an EEW-together trial is built even when the tsunami trial was not established, and keeps its phase and state", () => {
    const eewSubject = "normal/VXSE45/20261009062000";
    const eewEntry: [string, ChromeCandidateEntry] = [candidateKey(version(3), eewSubject, "fleq:p2:eew:T6-candidate"), { candidate: { name: "fleq:p2:eew:T6-candidate",
      operation: "normal", subject: eewSubject, cardMarkerId: "c", mapMarkerId: "m", mapAreaCodes: [] }, paint: { chromeMs: 1150, paintEvidenceId: "frame:2", hasScreenshot: false },
    replacedBeforePaint: false }];
    const notEstablished = { ...trial(MAJOR, null), index: null, establishment: { established: false, reason: "eewOrder" }, eew: { inputId: "input-3", subject: eewSubject } };
    const { injections, eewReference } = assemble([notEstablished], [eewEntry]);
    expect(injections[0]).toMatchObject({ outcome: "overlapNotEstablished", notEstablishedReason: "eewOrder" });
    expect(eewReference).toMatchObject([{ phase: "formal", established: false, missingReason: null, latencyLowerMs: expect.closeTo(48.89, 1) }]);
  });

  it("an EEW candidate and two tsunami subjects' candidates of the same version are all kept, keyed by (version, subject, mark name)", () => {
    const dv = { streamId: "st", semanticRevision: "1", sequence: 7 };
    const markEvent = (name: string, detail: Record<string, unknown>) => ({ name, ph: "R", pid: 1, ts: 1000, args: { data: { startTime: 1, detail: JSON.stringify({ name, displayVersion: dv, ...detail }) } } });
    const tsunami = (subject: string) => ({ operation: "normal", subject, present: true, cardMarkerId: "c", coastMarkerId: "k", areas: [{ code: "311", areaClass: "majorWarning" }] });
    const frame = (name: string, ph: "b" | "e", ts: number, args: Record<string, unknown> = {}) => ({ name, ph, ts, pid: 1, cat: "disabled-by-default-devtools.timeline.frame", id2: { local: "0x1" }, args });
    const reporter = { frame_reporter: { state: "STATE_PRESENTED_ALL", frame_sequence: 5 } };
    const events = [markEvent("fleq:p2:eew:T6-candidate", { operation: "normal", subject: "normal/VXSE45/1", cardMarkerId: "c", mapMarkerId: "m", mapAreaCodes: [] }),
      markEvent(T6T, tsunami("normal/VTSE41/a")), markEvent(T6T, tsunami("normal/VTSE41/b")),
      frame("PipelineReporter", "b", 1050, reporter), frame("Commit", "b", 1100), frame("Commit", "e", 1200), frame("PipelineReporter", "e", 1500, reporter)];
    const analyzed = analyzeTrace(events);
    const keys = ["normal/VXSE45/1|fleq:p2:eew:T6-candidate", `normal/VTSE41/a|${T6T}`, `normal/VTSE41/b|${T6T}`].map((k) => {
      const [subject, name] = k.split("|");
      return analyzed.byCandidate.get(candidateKey(dv, subject!, name!));
    });
    expect(keys.map((e) => e?.paint?.paintEvidenceId)).toEqual(["frame:5", "frame:5", "frame:5"]);
    expect(analyzed.byVersion.get("st\u00007")?.candidate?.subject).toBe("normal/VXSE45/1");
  });
});

// ── template と C5 の reducer（T02: corpus 履歴、O09:23 の型） ──
describe("P3-C6-T02 the five templates through the C5 reducer", () => {
  it("the draft's templates are the reducer's facts and the page's paint rule, and 100 round-robin trials per series keep them with one subject per EventID, no eviction and no stale report", () => {
    const templates = buildTemplates();
    const draft = JSON.parse(readFileSync(join(repo, "reconstruction/test/eew-e01/evidence/p3-tsunami/manifest.draft.json"), "utf8"));
    expect(draft.templates).toEqual(templates);
    expect(templates.map((t) => [t.transition, t.expectedSeries, t.expectedTransitions.map((x) => `${x.areaCode}:${x.transition}`).join(",")])).toEqual([
      ["issued", "escalation", "311:issued"], ["upgraded", "escalation", "311:upgraded"], ["expanded", "escalation", "312:expanded"],
      ["released", "deescalation", "311:released,312:released"], ["downgraded", "deescalation", "311:downgraded,312:downgraded"]]);
    const byTransition = new Map(templates.map((t) => [t.transition, t]));
    const paintOf = (state: TsunamiUnitState, subject: string) => {
      const forecasts = toTsunamiView(state).forecasts;
      return { present: forecasts.some((s) => s.subject === subject), areas: buildTsunamiPaint(forecasts).areasBySubject.get(subject) ?? [] };
    };
    for (const series of [["issued", "upgraded", "expanded"], ["released", "downgraded"]] as const) {
      let state = emptyTsunamiState();
      let clock = Date.parse("2026-06-05T18:00:00+09:00");
      const send = (fixture: string, eventId: string) => { clock += 1000; const step = receiveTsunami(state, tsunamiReport(fixture, { eventId, reportAtMs: clock }), clock); state = step.state; return step; };
      // warm-up の EventID で 10 試行してから解除し、正式の EventID で 100 試行（窓の subject は 2 つまで、RES-03）。
      for (const [eventId, trials] of [["20261009061000", 10], ["20261009061011", 100]] as const) {
        for (let k = 0; k < trials; k++) {
          const template = byTransition.get(series[k % series.length])!;
          const subject = `normal/VTSE41/${eventId}`;
          const prime = send(TEMPLATE_FIXTURES[template.transition].prime, eventId);
          // 窓の最初の発令系の prime だけが display changes 0（subject が前後とも view 外）。区域が同じでも表示中の prime は描き直す。
          expect(prime.displayChanges.length).toBe(k === 0 && series[0] === "issued" ? 0 : 1);
          expect(paintOf(state, subject)).toEqual(template.expectedPrimePaint);
          const target = send(TEMPLATE_FIXTURES[template.transition].target, eventId);
          const facts = target.outcomes.flatMap((o) => (o.kind === "accepted" ? o.subjects : []))[0]?.facts;
          expect([facts?.["series"], facts?.["areaTransitions"]]).toEqual([template.expectedSeries, template.expectedTransitions]);
          expect(paintOf(state, subject)).toEqual(template.expectedPaint);
          for (const step of [prime, target]) {
            expect(step.decisions.map((d) => d.decision)).toEqual(["changed"]);
            expect(step.diagnostics.filter((d) => d.reason === "tsunamiCapacityEvicted" || d.reason === "tsunamiRevisionConflict")).toEqual([]);
          }
        }
        if (eventId === "20261009061000") send(RELEASE_FIXTURE, eventId);
      }
      expect(state.forecasts).toHaveLength(2);
    }
  });
});

// ── 凍結の照合（T06: AC10） ──
describe("P3-C6-T06 freezing the tsunami manifest (AC10)", () => {
  const b = built();
  const inputs = (manifestText = b.manifestText, patch: Partial<Parameters<typeof verifyFrozenP3TsunamiManifest>[0]> = {}) => ({ manifestText, smokeConditionsText: b.smokeText,
    sequencesText: b.sequencesText, coastJsonText: b.coastJsonText, fixtureTexts: b.fixtureTexts, contractTexts: b.contractTexts, inherited: { manifestText: b.c4Text }, ...patch });
  const reseal = (mutate: (m: Record<string, any>) => void) => {
    const m = JSON.parse(b.manifestText);
    mutate(m);
    return sealSelfHash(`${JSON.stringify({ ...m, manifestSha256: "0".repeat(64) }, null, 2)}\n`, "manifestSha256");
  };
  it("the self hash, contract hashes, the inherited C4 manifest, the template bodies, coastSha256, the C6 smoke conditions and o09Subset verify; one change anywhere is refused", () => {
    expect(verifyFrozenP3TsunamiManifest(inputs()).manifest.manifestId).toBe("p3-c6-test");
    expect(() => verifyFrozenP3TsunamiManifest(inputs(b.manifestText.replace('"primeLeadMs": 1500', '"primeLeadMs": 1501')))).toThrow(/mismatch/);
    const contractId = "P3-TSUNAMI-E01-001";
    expect(() => verifyFrozenP3TsunamiManifest(inputs(undefined, { contractTexts: { ...b.contractTexts, [contractId]: b.contractTexts[contractId]!.replace("津波", "つなみ") } }))).toThrow(/contract digest/);
    expect(() => verifyFrozenP3TsunamiManifest(inputs(undefined, { inherited: { manifestText: b.c4Text.replace('"periodMs": 1370', '"periodMs": 1371') } }))).toThrow(/mismatch/);
    const body = Object.keys(b.fixtureTexts)[0]!;
    expect(() => verifyFrozenP3TsunamiManifest(inputs(undefined, { fixtureTexts: { ...b.fixtureTexts, [body]: `${b.fixtureTexts[body]} ` } }))).toThrow(/body/);
    expect(() => verifyFrozenP3TsunamiManifest(inputs(undefined, { coastJsonText: b.coastJsonText.replace("311", "319") }))).toThrow(/coastSha256/);
    expect(() => verifyFrozenP3TsunamiManifest(inputs(undefined, { smokeConditionsText: b.smokeText.replace('"dpr": 2', '"dpr": 3') }))).toThrow(/mismatch/);
    expect(() => verifyFrozenP3TsunamiManifest(inputs(reseal((m) => { m["o09Subset"].positions = [999]; })))).toThrow(/O09/);
  });

  it("refuses a missing population, a template series that does not match its transition, a wrong establishment pairing, eewEventIds outside EEW together (or missing there) and a reused EventID", () => {
    const refuses = (mutate: (m: Record<string, any>) => void, pattern: RegExp) => expect(() => verifyFrozenP3TsunamiManifest(inputs(reseal(mutate)))).toThrow(pattern);
    refuses((m) => { delete m["populations"]["deescalation:eewTogether"]; }, /populations/);
    refuses((m) => { m["templates"][0].expectedSeries = "deescalation"; }, /expectedSeries/);
    refuses((m) => { m["populations"]["escalation:fixedBacklog"].establishment = { kind: "primeSettledEewOrder" }; }, /establishment/);
    refuses((m) => { m["populations"]["escalation:maxVpws50ParseStarted"].establishment = { kind: "primeSettled" }; }, /establishment/);
    refuses((m) => { m["populations"]["escalation:fixedBacklog"].eewEventIds = m["populations"]["escalation:eewTogether"].eewEventIds; }, /eewEventIds/);
    refuses((m) => { m["populations"]["deescalation:eewTogether"].eewEventIds = null; }, /eewEventIds/);
    refuses((m) => { m["populations"]["deescalation:fixedBacklog"].tsunamiEventIds.warmup = m["populations"]["escalation:fixedBacklog"].tsunamiEventIds.warmup; }, /EventIDs/);
    refuses((m) => { m["populations"]["escalation:fixedBacklog"].transitions = ["released", "downgraded"]; }, /transitions/);
  });
});

// ── 成立の判定と報の作り方（T07: AC06） ──
describe("P3-C6-T07 establishment of a tsunami trial and the report builder (AC06)", () => {
  const prime = (patch: Partial<Parameters<typeof establishTsunamiTrial>[0]["prime"]> = {}) => ({ paintRequired: true, paintHostMs: { lowerMs: 900, upperMs: 902 },
    replyMs: 850, ackMs: 950, ...patch });
  const judge = (input: Partial<Parameters<typeof establishTsunamiTrial>[0]>) => establishTsunamiTrial({ establishment: { kind: "primeSettled" }, t0Ms: 1000,
    prime: prime(), target: null, eewInputDoneMs: null, ...input });
  it("primeSettled needs the prime's paint upper bound and the U-T ack before the target's T0 (a straddling interval fails); only a prime without display changes uses its reply row", () => {
    expect(judge({}).established).toBe(true);
    expect(judge({ prime: prime({ ackMs: null }) })).toEqual({ established: false, reason: "primeNotSettled" });
    expect(judge({ prime: prime({ ackMs: 1001 }) })).toEqual({ established: false, reason: "primeNotSettled" });
    expect(judge({ prime: prime({ paintHostMs: null }) })).toEqual({ established: false, reason: "primeNotSettled" });
    expect(judge({ prime: prime({ paintHostMs: { lowerMs: 999, upperMs: 1001 } }) })).toEqual({ established: false, reason: "primeNotSettled" });
    expect(judge({ prime: prime({ paintRequired: false, paintHostMs: null }) }).established).toBe(true);
    expect(judge({ prime: prime({ paintRequired: false, paintHostMs: null, replyMs: 1001 }) })).toEqual({ established: false, reason: "primeNotSettled" });
    expect(judge({ t0Ms: null, prime: prime({ ackMs: null }) }).established).toBe(true);
  });

  it("primeSettledStartOffset keeps C4's −0.1/0/5/5.1 ms boundaries; primeSettledEewOrder needs the target's T0 at or before the VXSE45's inputDone", () => {
    const startOffset = { kind: "startOffset", targetOffsetMs: 1, acceptedOffsetRangeMs: [0, 5], span: "population" } as const;
    const offset = (t0Ms: number) => judge({ establishment: { kind: "primeSettledStartOffset", startOffset }, t0Ms, target: { startMs: 1000, endMs: 2000 } });
    expect([999.9, 1000, 1005, 1005.1].map((t0) => offset(t0).established)).toEqual([false, true, true, false]);
    expect(offset(1005.1)).toEqual({ established: false, reason: "startOffset" });
    const eew = (eewInputDoneMs: number | null) => judge({ establishment: { kind: "primeSettledEewOrder" }, eewInputDoneMs });
    expect([eew(1000).established, eew(999.9), eew(null)]).toEqual([true, { established: false, reason: "eewOrder" }, { established: false, reason: "eewOrder" }]);
  });

  it("a report from a template differs from the fixture only in EventID and the head date-times; a same-second report with other areas is stale with tsunamiRevisionConflict and counts as a stateBreak", () => {
    const fixture = readFileSync(join(repo, "test/fixtures/synthetic_VTSE41_e01_311major.xml"), "utf8").split("\n");
    const report = tsunamiReport("synthetic_VTSE41_e01_311major", { eventId: "20261009061010", reportAtMs: Date.parse("2026-06-05T18:00:01+09:00") }).split("\n");
    const changed = fixture.flatMap((line, i) => (line === report[i] ? [] : [line.trim().replace(/>.*</, "><")]));
    expect(report).toHaveLength(fixture.length);
    expect(changed).toEqual(["<DateTime></DateTime>", "<ReportDateTime></ReportDateTime>", "<TargetDateTime></TargetDateTime>", "<EventID></EventID>"]);
    expect(report.find((line) => line.includes("<ReportDateTime>"))?.trim()).toBe("<ReportDateTime>2026-06-05T18:00:01+09:00</ReportDateTime>");

    const atMs = Date.parse("2026-06-05T18:00:00+09:00");
    const first = receiveTsunami(emptyTsunamiState(), tsunamiReport("synthetic_VTSE41_e01_311warning", { eventId: "20261009061010", reportAtMs: atMs }), atMs);
    const conflict = receiveTsunami(first.state, tsunamiReport("synthetic_VTSE41_e01_311major", { eventId: "20261009061010", reportAtMs: atMs }), atMs);
    expect(conflict.decisions).toMatchObject([{ decision: "unchanged", reason: "stale" }]);
    const host = { processing: [{ inputId: "input-9" }], raised: new Map<string, number>() };
    expect(tsunamiStateBreaks({ diagnostics: { records: conflict.diagnostics, problems: [] }, trials: [{ phase: "formal", inputId: "input-9" }], host }).stateBreaks)
      .toEqual({ ...noBreaks, tsunamiRevisionConflict: 1, staleTarget: 1 });
  });
});

// ── 窓の異常の観測の完全性（T07: AC06(7)・Q-C6-IMPL-AMEND の契約境界） ──
describe("P3-C6-T07 stateBreaks come from the host's records and are null when a record cannot be read", () => {
  const clean = { records: [], problems: [] };
  // EEW 同時の正式の 1 試行: prime（input-1）・target（input-2）・VXSE45（input-3）。
  const trialOf = { phase: "formal", inputId: "input-2", block: 0, prime: { inputId: "input-1" }, eew: { inputId: "input-3" } };
  const processed = { processing: ["input-1", "input-2", "input-3"].map((inputId) => ({ inputId })) };
  it("counts a capacity-exceeded prime and VXSE45 that no snapshot showed (SSE kept only the later snapshot): the U-T report raised no generation, the VXSE45 left no EEW candidate", () => {
    const { stateBreaks, stateBreaksIncomplete } = tsunamiStateBreaks({ diagnostics: clean, trials: [trialOf], blocks: [{ dataLoss: false }],
      host: { ...processed, raised: new Map([["input-2|U-T", 4]]) }, eewReference: [{ inputId: "input-3", missingReason: "paintNotObserved" }] });
    expect([stateBreaks, stateBreaksIncomplete]).toEqual([{ ...noBreaks, tsunamiCapacityExceeded: 1, eewCapacityExceeded: 1 }, []]);
    expect(tsunamiStateBreaks({ diagnostics: clean, trials: [trialOf], blocks: [{ dataLoss: false }], host: { ...processed,
      raised: new Map([["input-1|U-T", 3], ["input-2|U-T", 4]]) }, eewReference: [{ inputId: "input-3", missingReason: null }] }).stateBreaks).toEqual(noBreaks);
  });

  it("an unparsable diagnostic line, dropped diagnostics, a missing shutdown summary, an unprocessed report or trace data loss make the window's stateBreaks null", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-c6-diagnostics-"));
    try {
      const write = (lines: readonly string[], summary: unknown) => {
        writeFileSync(join(dir, "diagnostics-1.jsonl"), `${lines.join("\n")}\n`);
        if (summary === undefined) rmSync(join(dir, "shutdown-summary.json"), { force: true });
        else writeFileSync(join(dir, "shutdown-summary.json"), JSON.stringify(summary));
        return readDiagnosticsStrict(dir);
      };
      const zero = { droppedDiagnostics: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 } };
      const conflictRow = JSON.stringify({ level: "WARN", reason: "tsunamiRevisionConflict", inputId: "input-2" });
      expect(write([conflictRow], zero)).toEqual({ records: [{ level: "WARN", reason: "tsunamiRevisionConflict" }], problems: [] });
      const host = { ...processed, raised: new Map([["input-1|U-T", 3], ["input-2|U-T", 4]]) };
      const eewReference = [{ inputId: "input-3", missingReason: null }];
      const breaks = (diagnostics: ReturnType<typeof readDiagnosticsStrict>, patch: Record<string, unknown> = {}) =>
        tsunamiStateBreaks({ diagnostics, trials: [trialOf], blocks: [{ dataLoss: false }], host, eewReference, ...patch }).stateBreaks;
      expect(breaks(write([conflictRow], zero))).toEqual({ ...noBreaks, tsunamiRevisionConflict: 1 });
      expect(breaks(write([conflictRow, "{broken"], zero))).toBeNull();
      expect(breaks(write([conflictRow], { droppedDiagnostics: { DEBUG: 0, INFO: 2, WARN: 0, ERROR: 0 } }))).toBeNull();
      expect(breaks(write([conflictRow], undefined))).toBeNull();
      expect(breaks(write([conflictRow], zero), { host: { processing: [{ inputId: "input-1" }, { inputId: "input-3" }], raised: host.raised } })).toBeNull();
      expect(breaks(write([conflictRow], zero), { blocks: [{ dataLoss: true }] })).toBeNull();
      expect(readDiagnosticsStrict(join(dir, "absent")).problems).toEqual(["diagnostics directory missing"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads back only a droppedDiagnostics of four non-negative integers and diagnostic rows with level and reason; any other shape leaves stateBreaks null", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-c6-diagnostics-shape-"));
    try {
      const read = (lines: readonly string[], summary: unknown) => {
        writeFileSync(join(dir, "diagnostics-1.jsonl"), `${lines.join("\n")}\n`);
        writeFileSync(join(dir, "shutdown-summary.json"), JSON.stringify(summary));
        return tsunamiStateBreaks({ diagnostics: readDiagnosticsStrict(dir), trials: [trialOf], blocks: [{ dataLoss: false }], eewReference: [{ inputId: "input-3", missingReason: null }],
          host: { ...processed, raised: new Map([["input-1|U-T", 3], ["input-2|U-T", 4]]) } }).stateBreaks;
      };
      const row = JSON.stringify({ level: "INFO", reason: "tsunamiCapacityEvicted" });
      const zero = { droppedDiagnostics: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 } };
      expect(read([row], zero)).toEqual({ ...noBreaks, tsunamiCapacityEvicted: 1 });
      for (const summary of [{ droppedDiagnostics: {} }, { droppedDiagnostics: 0 }, { droppedDiagnostics: { DEBUG: 0, INFO: 0, WARN: -1, ERROR: 0 } }, null]) expect(read([row], summary)).toBeNull();
      for (const line of ["null", "{}", JSON.stringify({ level: "WARN" }), "[]"]) expect(read([row, line], zero)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── AC08④（C5 から引き継いだ U-E と U-T の同時 dirty）の準備（Q-C6-IMPL-AMEND (9)） ──
describe("P3-C6 AC08④ preparation: the E14 bundle with VTSE41 and the --aux window ids", () => {
  it("a bundle whose U-E and U-T intervals overlap while U-F and U-W finish later is linked with overlapUnits U-E・U-T, and notSimultaneous under C4's all-unit rule", () => {
    const obs = (o: Record<string, unknown>) => ({ t: "obs", o } as HostRecord);
    const units = { "U-E": [100, 160], "U-T": [105, 150], "U-F": [300, 500], "U-W": [320, 700] } as const;
    const records = Object.entries(units).flatMap(([unit, [start, done]]) => [
      obs({ kind: "generationRaised", runId: "r", inputId: `in-${unit}`, unit, generation: 2, monotonicMs: start }),
      obs({ kind: "checkpointGrant", runId: "r", grantId: `g-${unit}`, unit, attemptIds: [], dirtyObservedMonotonicMs: null, grantSentMonotonicMs: start,
        ownerStartedMonotonicMs: start, doneReceivedMonotonicMs: done, result: { kind: "acknowledged", generation: 2 } })]);
    const bundle = { k: 0, inputIds: Object.fromEntries(Object.keys(units).map((u) => [u, `in-${u}`])) };
    expect(auxMeasures.summarizeE14(records, { bundles: [{ ...bundle, overlapUnits: ["U-E", "U-T"] }] })).toMatchObject({ linked: 1,
      units: { "U-E": { max: 60 }, "U-T": { max: 45 } } });
    expect(auxMeasures.summarizeE14(records, { bundles: [bundle] })).toMatchObject({ linked: 0, unconfirmed: { notSimultaneous: 1 } });
  });

  it("an --aux id that is not a window stops the run instead of measuring nothing", () => {
    const list = [{ id: "e14-run1" }, { id: "e03-run1" }];
    expect(selectAuxWindows(list, "e14-run1")).toEqual([{ id: "e14-run1" }]);
    expect(() => selectAuxWindows(list, "E14,e14-run1")).toThrow(/unknown --aux window id: E14/);
  });
});

// ── encode 直後の較正（Q-C6-IMPL-AMEND (10)）: UWR の後の版では U-W の保存が引き金の送信の数十 ms 後に始まる ──
describe("P3-C6 encode-started calibration after the write-right change", () => {
  it("the median of the last ten 'encode start of the trigger's save − trigger send' predicts about 30 ms and the target is the save that contains the trigger, not a nearer background save; T0 1 ms after it is established", () => {
    const trials = Array.from({ length: 10 }, (_, i) => ({ trigger: { inputId: `trig-${i}`, injectedHrMs: i * 3000 } }));
    const encodeStarts = new Map(trials.map((t, i) => [t.trigger.inputId, t.trigger.injectedHrMs + 5 + 25 + (i % 3) * 2]));
    const predicted = predictParseDelay(trials, encodeStarts, 5);
    expect(predicted).toBeCloseTo(27, 0);
    const encode = (attemptId: string, inputIds: string[], start: number) => ({ unit: "U-W", stage: "encode", attemptId, generation: 1, startedMonotonicMs: start,
      endedMonotonicMs: start + 40, inputIds });
    const host = { decode: new Map(), t1: new Map(), t2: new Map(), processing: [], raised: new Map(),
      checkpoints: [encode("bg", ["background-1"], 30_029), encode("own", ["trig-x"], 30_036)] };
    const trial = { trigger: { inputId: "trig-x", injectedHrMs: 30_000, calibrated: true, predictedTickHostMs: 30_005 + predicted! } };
    const target = trialTarget("maxWeatherCheckpointEncodeStarted", trial, host, 5);
    expect(target).toEqual({ startMs: 30_036, endMs: 30_076 });
    const startOffset = { kind: "startOffset", targetOffsetMs: 1, acceptedOffsetRangeMs: [0, 5], span: "population" } as const;
    expect(establishTsunamiTrial({ establishment: { kind: "primeSettledStartOffset", startOffset }, t0Ms: 30_037, target,
      prime: { paintRequired: false, paintHostMs: null, replyMs: 1, ackMs: 2 }, eewInputDoneMs: null }).established).toBe(true);
    expect(trialTarget("maxWeatherCheckpointEncodeStarted", { trigger: { ...trial.trigger, inputId: "trig-missing" } }, host, 5)).toBeNull();
  });

  it("a trial whose target interval did not come stops waiting after TARGET_WAIT_MS instead of the 11 s settle limit, and counts as not established", () => {
    const base = { established: false, complete: false, offset: true, target: null, sentHrMs: 1000, settleBy: 12_000 };
    expect(settleDone({ ...base, nowHrMs: 1000 + TARGET_WAIT_MS - 1 })).toBe(false);
    expect(settleDone({ ...base, nowHrMs: 1000 + TARGET_WAIT_MS + 1 })).toBe(true);
    expect(settleDone({ ...base, target: { startMs: 0, endMs: 1 }, nowHrMs: 1000 + TARGET_WAIT_MS + 1 })).toBe(false);
    const startOffset = { kind: "startOffset", targetOffsetMs: 1, acceptedOffsetRangeMs: [0, 5], span: "population" } as const;
    expect(establishTsunamiTrial({ establishment: { kind: "primeSettledStartOffset", startOffset }, t0Ms: 1001, target: null,
      prime: { paintRequired: false, paintHostMs: null, replyMs: 1, ackMs: 2 }, eewInputDoneMs: null })).toEqual({ established: false, reason: "startOffset" });
  });
});

// AC08・Q-C6-IMPL-AMEND (11): 凍結の候補の stopCondition は母集団ごとの予備から C4 と同じ式で決まる。
describe("P3-C6 stopCondition from each population's preliminary run", () => {
  it("10/10, 10/12, 20/29 and 20/24 give 1,623, 2,093, 2,267 and 1,815 attempts, and maxDurationMs is (60 s + one trial × attempts) × 1.25", () => {
    expect([[10, 10], [10, 12], [20, 29], [20, 24]].map(([successes, trials]) => stopFromPreliminary({ successes: successes!, trials: trials!, msPerAttempt: 3000 }).maxAttempts))
      .toEqual([1623, 2093, 2267, 1815]);
    expect(stopFromPreliminary({ successes: 10, trials: 10, msPerAttempt: 3465.673 })).toMatchObject({ maxDurationMs: 7105985, wilsonLower: expect.closeTo(0.722, 3) });
  });
});

// P3-C6-POP-SHAPE=A・Q-C6-IMPL-AMEND (12): 遷移ごとの標本の数は凍結した割り当てにそろえる。
describe("P3-C6 transition quotas (POP-SHAPE=A)", () => {
  const manifest = built().manifest;
  it("a transition that never establishes is tried again until its quota is met, and a run whose counts miss the quotas is not Pass", () => {
    const transitions = manifest.populations["escalation:fixedBacklog"].transitions;
    const quotas = transitionQuotas(transitions, 1000);
    expect(quotas).toEqual({ issued: 333, upgraded: 333, expanded: 334 });
    // 発令だけが成立しない筋書き: 成立数のいちばん少ない遷移を選ぶので、1,600 試行のあいだ発令を試し続け、他の遷移の標本も増えない。
    const established = new Map<TsunamiAreaTransition, number>();
    const tried: TsunamiAreaTransition[] = [];
    for (let k = 0; k < 1600; k++) {
      const transition = nextTransition(transitions, quotas, established);
      tried.push(transition);
      if (transition !== "issued") established.set(transition, (established.get(transition) ?? 0) + 1);
    }
    expect(new Set(tried)).toEqual(new Set(["issued"]));
    // 成立は全部そろったが割り当てに届かない run（旧来の巡回で発令が 0 件、引上げ・区域拡大で 1,000 件）は、遅延がすべて基準内でも未確認。
    const runs = P3_TSUNAMI_POPULATIONS.flatMap((pop) => ([1, 2, 3] as const).map((run) => tsunamiRun(manifest, pop, run)));
    const skewed = runs.map((r) => ({ samples: r.samples.map((sample) => (sample.population === "escalation:fixedBacklog" && sample.run === 1 && sample.transition === "issued"
      ? { ...sample, transition: "upgraded" as const } : sample)), injections: r.injections }));
    const result = summarizeP3TsunamiE01(manifest, skewed.flatMap((r) => r.samples), skewed.flatMap((r) => r.injections), windows());
    expect(result.runs.find((r) => r.population === "escalation:fixedBacklog" && r.run === 1)).toMatchObject({ status: "未確認",
      evidenceRefs: ["transitionQuotaUnmet:issued=0/333", "transitionQuotaUnmet:upgraded=666/333"] });
    expect(result.verdict.status).toBe("未確認");
    // 割り当てどおりに成立した試行が積み上がる筋書きでは、どの遷移も割り当てちょうどで止まる。
    const fair = new Map<TsunamiAreaTransition, number>();
    for (let k = 0; k < 1000; k++) { const t = nextTransition(transitions, quotas, fair); fair.set(t, (fair.get(t) ?? 0) + 1); }
    expect(Object.fromEntries(fair)).toEqual(quotas);
  });
});
