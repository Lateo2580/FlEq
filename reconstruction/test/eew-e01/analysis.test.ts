import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { analyzeTrace, assembleTrials, buildHostIndex } from "./analysis.mjs";
import type { HostLine, Probe, Trial } from "./analysis.mjs";

// 実 Chrome・実 host の 1 run（3 試行）を縮めた fixture。実測の予備測定はこの test に入れない（CI で Chrome を起動しない）。
const fixture = JSON.parse(readFileSync("reconstruction/test/eew-e01/fixtures/e01-mini-run.json", "utf8")) as {
  trials: Trial[]; probes: Probe[]; hostLines: HostLine[]; traceEvents: unknown[];
};

type TraceEvent = { name: string; ph: string; ts: number; id2?: { local: string }; pid: number; args?: { data?: { detail: string; startTime: number }; frame_reporter?: { state: string } } };
// PipelineReporter のうち STATE_PRESENTED_ALL の終端（ts）。
const presentedEnds = (() => {
  const begins = new Map<string, TraceEvent>();
  const ends: number[] = [];
  for (const e of fixture.traceEvents.map((x) => x as TraceEvent).filter((x) => x.name === "PipelineReporter")) {
    const key = `${e.pid}|${e.id2?.local}`;
    if (e.ph === "b") begins.set(key, e);
    else if (begins.get(key)?.args?.frame_reporter?.state === "STATE_PRESENTED_ALL") ends.push(e.ts);
  }
  return ends;
})();

function assemble(patch: { lines?: HostLine[]; events?: unknown[]; trials?: Trial[] } = {}) {
  const host = buildHostIndex(patch.lines ?? fixture.hostLines);
  const chrome = analyzeTrace(patch.events ?? fixture.traceEvents);
  return { chrome, ...assembleTrials({ population: "fixedBacklog", run: 1, trials: patch.trials ?? fixture.trials, host, chromeByVersion: chrome.byVersion,
    probes: fixture.probes, blocks: [{ dataLoss: false }], callbackDeadlineMs: 10_000, missingAfterMs: 10_000 }) };
}

describe("P2-A10-T02 runner side: trace → EewTraceSample (real Chrome trace)", () => {
  it("T0〜T6 が一対一に結ばれ、T6 は候補 mark でなく実 paint（Commit を含む PipelineReporter の終端）、時計区間幅は 5ms 以内", () => {
    const { samples, injections } = assemble();
    expect(samples).toHaveLength(3);
    for (const [i, s] of samples.entries()) {
      expect(s.markers.map((m) => m.point)).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6"]);
      expect(s.missing).toBe(false);
      expect(s.correlation.displayVersion).not.toBeNull();
      expect(s.latencyUpperMs! - s.latencyLowerMs!).toBeLessThanOrEqual(5);
      expect(injections[i]!.outcome).toBe("callbackReached");
      const t6 = s.markers.find((m) => m.point === "T6");
      expect(t6).toMatchObject({ clock: "chrome", paintEvidenceId: expect.stringMatching(/^frame:\d+/) });
      // T6 は候補 mark でなく、STATE_PRESENTED_ALL の PipelineReporter の終端（trace 時計へ戻して一致する）。
      const mark = fixture.traceEvents.map((e) => e as TraceEvent).find((e) => e.name === "fleq:p2:eew:T6-candidate" &&
        (JSON.parse(e.args!.data!.detail) as { displayVersion: { sequence: number } }).displayVersion.sequence === s.correlation.displayVersion!.sequence)!;
      const traceTs = t6!.monotonicMs * 1000 + (mark.ts - mark.args!.data!.startTime * 1000);
      expect(presentedEnds.some((end) => Math.abs(end - traceTs) < 1)).toBe(true);
      expect(traceTs).toBeGreaterThan(mark.ts);
    }
  });

  it("host の T0 が無い投入は callbackTimeout の欠落、paint に結べない候補は T6 を作らず traceIncomplete（候補時刻を T6 に転記しない）", () => {
    const lost = fixture.trials[0]!.inputId;
    const noT0 = fixture.hostLines.filter((l) => !(l.t === "obs" && l.o.kind === "marker" && "inputId" in l.o && l.o.inputId === lost));
    const first = assemble({ lines: noT0 });
    expect(first.injections[0]).toMatchObject({ outcome: "callbackTimeout" });
    expect(first.samples[0]).toMatchObject({ missing: true, missingReason: "callbackNotReached" });

    // Commit / PipelineReporter を除くと、mark だけが残る。
    const marksOnly = fixture.traceEvents.filter((e) => (e as { name: string }).name.startsWith("fleq:p2:eew:"));
    const second = assemble({ events: marksOnly });
    for (const s of second.samples) {
      expect(s).toMatchObject({ missing: true, missingReason: "traceIncomplete", latencyLowerMs: null });
      expect(s.markers.some((m) => m.point === "T6")).toBe(false);
    }
  });
});

describe("P2-A10-T02 runner side: 版の結合（ヘルツ総合レビュー 指摘 2・3 の再現）", () => {
  it("同じ subject の版 A→B の候補が同じ Commit の前に出たら、T6 は提示された B だけに付き、A は replacedBeforePaint の traceIncomplete", () => {
    const original = analyzeTrace(fixture.traceEvents);
    const isA = (e: TraceEvent) => e.name === "fleq:p2:eew:T6-candidate" &&
      (JSON.parse(e.args!.data!.detail) as { displayVersion: { sequence: number } }).displayVersion.sequence === 11;
    // A（sequence 11）の候補の 0.1ms 後、同じ Commit の前（実 trace で mark → Commit は 547µs）に B（sequence 99）の候補を足す。
    const b = fixture.traceEvents.map((e) => e as TraceEvent).filter(isA).map((e) => {
      const detail = JSON.parse(e.args!.data!.detail) as { displayVersion: { sequence: number } };
      detail.displayVersion.sequence = 99;
      return { ...e, ts: e.ts + 100, args: { ...e.args, data: { detail: JSON.stringify(detail), startTime: e.args!.data!.startTime + 0.1 } } };
    });
    const { chrome, samples, details } = assemble({ events: [...fixture.traceEvents, ...b] });
    const keyOf = (sequence: number) => [...chrome.byVersion.keys()].find((k) => k.endsWith(`\u0000${sequence}`))!;
    const paintA = original.byVersion.get(keyOf(11))!.paint!;
    expect(chrome.byVersion.get(keyOf(11))).toMatchObject({ paint: null, replacedBeforePaint: true });
    expect(chrome.byVersion.get(keyOf(99))!.paint!.paintEvidenceId).toBe(paintA.paintEvidenceId);
    expect(samples[0]).toMatchObject({ missing: true, missingReason: "traceIncomplete" });
    expect(samples[0]!.markers.some((m) => m.point === "T6")).toBe(false);
    expect(details[0]).toMatchObject({ sample: "replacedBeforePaint" });
  });

  it("EEW の T0 と T2 の間に背景入力の T0 が入っても、処理区間の公開版で結合し欠落にしない", () => {
    const first = fixture.trials[0]!.inputId;
    const markerAt = (point: "T0" | "T2") => fixture.hostLines.findIndex((l) => l.t === "obs" && l.o.kind === "marker" && l.o.point === point && "inputId" in l.o && l.o.inputId === first);
    const at = markerAt("T2");
    const t0 = fixture.hostLines[markerAt("T0")]!;
    if (t0.t !== "obs" || t0.o.kind !== "marker" || t0.o.point !== "T0") throw new Error("fixture has no T0 for the first trial");
    const background: HostLine = { t: "obs", o: { ...t0.o, inputId: "input-background", monotonicMs: t0.o.monotonicMs + 0.05 } };
    const { samples } = assemble({ lines: [...fixture.hostLines.slice(0, at), background, ...fixture.hostLines.slice(at)] });
    for (const s of samples) {
      expect(s).toMatchObject({ missing: false, missingReason: null });
      expect(s.markers.some((m) => m.point === "T6")).toBe(true);
    }
  });
});

describe("P2-A10-T08 runner side: injection time", () => {
  it("投入記録は実投入時刻（投入側 hrtime）を持ち、予定時刻で代用しない", () => {
    const trials = fixture.trials.map((t) => ({ ...t, scheduledHrMs: t.scheduledHrMs - 123 }));
    const { injections } = assemble({ trials });
    injections.forEach((r, i) => {
      expect(r.injectedInjectorMonotonicMs).toBe(fixture.trials[i]!.injectedHrMs);
      expect(r.scheduledInjectorMonotonicMs).toBe(fixture.trials[i]!.scheduledHrMs - 123);
    });
  });
});
