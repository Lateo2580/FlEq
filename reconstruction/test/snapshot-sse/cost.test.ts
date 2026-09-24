import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeInput, RuntimeState, RuntimeStep } from "../../contracts/p2-shared-runtime.types";
import type { SnapshotProjectionInput, SnapshotProjectionResult, SnapshotProjectionState } from "../../contracts/p2-snapshot-sse.types";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { toEewView } from "../../src/units/eew/eew-unit";
import { toWeatherCurrentView } from "../../src/units/weather-current/weather-current-unit";
import { toWeatherTimeseriesView } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import {
  allSubjects, atTime, calls, combine, decode, eewReport, expectConsistent, expectMatchesReference, projected, projectionInput,
  received, reference, startup, step,
} from "./projection-fixture";

const at = 1780650000000;
const clock = { wallTimeMs: at, monotonicMs: 1 };
afterEach(() => { vi.restoreAllMocks(); });

const office = (xml: string, name: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${name}</EditorialOffice>`);
const timeseries = (name: string, time = "2026-06-05T17:00:00+09:00") => decode("81_02_01_260605_VPWP50_high_severity", "VPWP50",
  (xml) => atTime(office(xml, name), time), `F/${name}/${time}`);

// Everything A8 could measure per unit: the owner objects that populate each full view.
function elements(state: RuntimeState) {
  return {
    eew: new Set<object>(state.units["U-E"].current),
    weather: new Set<object>([...Object.values(state.units["U-W"].national).filter((item) => item != null), ...state.units["U-W"].partials]),
    timeseries: new Set<object>(state.units["U-F"].subjects),
  };
}

// Projects one step while recording what JSON.stringify saw.
function measure(input: SnapshotProjectionInput, previous: SnapshotProjectionState, before: RuntimeState, after: RuntimeState) {
  const known = [elements(before), elements(after)];
  // The delta's own before/after elements (owners may hand an equal-content copy of the stored one).
  const delta = new Map<object, "eew" | "weather" | "timeseries">();
  for (const change of input.displayChanges) for (const side of [change.before, change.after]) if (side?.current != null)
    delta.set(side.current, side.unit === "U-E" ? "eew" : side.unit === "U-W" ? "weather" : "timeseries");
  const whole = new Set<object>([before.views["U-E"], before.views["U-W"], before.views["U-F"], after.views["U-E"],
    after.views["U-W"], after.views["U-F"], before.units["U-E"], before.units["U-W"], before.units["U-F"],
    after.units["U-E"], after.units["U-W"], after.units["U-F"], ...[before, after].flatMap((state) => [state.views["U-E"].current,
      state.views["U-E"].subjects, state.views["U-W"].partials, state.views["U-W"].subjects, state.views["U-F"].series,
      state.views["U-F"].subjects])]);
  const measured = { eew: 0, weather: 0, timeseries: 0, unchanged: 0, whole: 0, snapshots: 0, stringifiedBytes: 0 };
  const original = JSON.stringify;
  // The projector never passes a replacer or indentation.
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
    const text = original(value);
    measured.stringifiedBytes += text?.length ?? 0;
    if (typeof value === "object" && value != null) {
      const own = delta.get(value);
      if (own != null) measured[own]++;
      else if (known.some((set) => set.eew.has(value) || set.weather.has(value) || set.timeseries.has(value))) measured.unchanged++;
      if (whole.has(value)) measured.whole++;
      // A complete snapshot (domain bodies present) is serialized by the HTTP side, never here.
      if ("current" in value && typeof value.current === "object" && value.current != null && "eew" in value.current
        && typeof value.current.eew === "object") measured.snapshots++;
    }
    return text;
  });
  const start = performance.now();
  const result: SnapshotProjectionResult = projectSnapshot(input, previous);
  const ms = performance.now() - start;
  spy.mockRestore();
  return { result, ms, measured };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * p) - 1];
}

describe("P2-A8-T06 regression (AC06/AC13)", () => {
  it("P2-A8-T06: generatedAt-only is unchanged; metadata and admission-count-only changes advance sequence, not content", () => {
    const started = startup(clock);
    const adopted = step(started.state, received("run", decode("15_16_02_251222_VPWW57", "VPWW57"), clock));
    const first = projected(projectSnapshot(projectionInput(started, at), null));
    const second = projected(projectSnapshot(projectionInput(adopted, at), first.state));
    const same = projectSnapshot(projectionInput({ ...adopted, displayChanges: [], outcomes: [] }, at + 1), second.state);
    expect(same.kind).toBe("unchanged");
    expect(same.state.snapshot).toBe(second.snapshot);
    const saved = { ...adopted.state.units["U-W"].persistence, kind: "saved" as const, savedAckAt: at };
    const ack = projected(projectSnapshot(projectionInput({ ...adopted, displayChanges: [], outcomes: [] }, at,
      { persistence: { ...projectionInput(adopted, at).persistence, "U-W": saved } }), second.state));
    expect([ack.snapshot.sequence, ack.snapshot.semanticRevision]).toEqual([second.snapshot.sequence + 1, second.snapshot.semanticRevision]);
    expect(ack.state.domains).toEqual(second.state.domains);
    const counts = (normal: number) => ({ ...adopted.admissionCounts, "U-W": { normal, training: 0, test: 0 } });
    let state = ack.state;
    for (const count of [1, 2, 1, 0]) {
      const { result, measured } = measure(projectionInput({ ...adopted, admissionCounts: counts(count), displayChanges: [],
        outcomes: [] }, at), state, adopted.state, adopted.state);
      const next = projected(result);
      expect(next.snapshot.sequence).toBe(state.snapshot!.sequence + 1);
      expect(next.snapshot.semanticRevision).toBe(second.snapshot.semanticRevision);
      expect(next.snapshot.current.weatherCurrent.items[0].admission).toEqual(count === 0 ? {} : { capacityExceeded: count });
      expect([measured.eew, measured.weather, measured.timeseries, measured.unchanged, measured.whole]).toEqual([0, 0, 0, 0, 0]);
      state = next.state;
    }
  });

  it("P2-A8-T06: U-F retainUntil removal with no outcome still reduces bytes and aggregates", () => {
    const started = startup(clock);
    const adopted = combine(started.state, [received("run", timeseries("稚内地方気象台", "2026-06-05T17:00:00+09:00"), clock),
      received("run", timeseries("網走地方気象台", "2026-06-05T16:00:00+09:00"), clock)]);
    const first = projected(projectSnapshot(projectionInput(adopted, at), null));
    const removed = adopted.state.units["U-F"].subjects[1];
    const retainUntil = removed.retainUntil;
    const collected = step(adopted.state, { kind: "mailboxCompleted", clock: { wallTimeMs: retainUntil, monotonicMs: 2 },
      completion: { kind: "control", messageId: "tick", runId: "run", encodedByteLength: 0, startedMonotonicMs: 2,
        completedMonotonicMs: 2, control: { kind: "deadline", clock: { wallTimeMs: retainUntil, monotonicMs: 2 } } } });
    // The retained subject leaves with no PublishedOutcome at all, only a display change.
    expect(collected.outcomes.flatMap((item) => item.outcome.subjects.map((subject) => subject.subject))).not.toContain(removed.subject);
    expect(collected.displayChanges.filter((item) => item.after == null).map((item) => item.subject)).toEqual([removed.subject]);
    const result = projected(projectSnapshot(projectionInput(collected, retainUntil), first.state));
    expectConsistent(result.state, result.snapshot, result.utf8Bytes);
    expectMatchesReference(result.state, reference(collected, retainUntil));
    expect(result.state.domains.weatherTimeseries.utf8Bytes).toBeLessThan(first.state.domains.weatherTimeseries.utf8Bytes);
    expect([first.snapshot.current.weatherTimeseries.items[0].activeCount,
      result.snapshot.current.weatherTimeseries.items[0].activeCount]).toEqual([2, 0]);
  });

  it("P2-A8-T06: summary→full re-measures only the changed subject", () => {
    const started = startup(clock);
    const training = (xml: string) => atTime(xml.replace("<Status>通常</Status>", "<Status>訓練</Status>"), "2026-06-05T16:00:00+09:00");
    const adopted = combine(started.state, [received("run", decode("81_09_01_260605_VPWP50", "VPWP50"), clock),
      received("run", decode("81_09_01_260605_VPWP50", "VPWP50", training, "training-nagano"), clock),
      received("run", timeseries("稚内地方気象台"), clock)]);
    const first = projected(projectSnapshot(projectionInput(adopted, at), null));
    expect(first.snapshot.current.weatherTimeseries.delivery).toBe("summary");
    // A newer training 取消 empties the large training series; the other series stay untouched.
    const cancel = (xml: string) => training(xml).replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
      .replace("<ReportDateTime>2026-06-05T16:00:00+09:00</ReportDateTime>", "<ReportDateTime>2026-06-05T16:30:00+09:00</ReportDateTime>");
    const collected = step(adopted.state, received("run", decode("81_09_01_260605_VPWP50", "VPWP50", cancel, "training-cancel"), clock));
    const removed = collected.displayChanges.flatMap((item) => [item.before?.current, item.after?.current]).filter((item) => item != null);
    const { result, measured } = measure(projectionInput(collected, at), first.state, adopted.state, collected.state);
    const full = projected(result);
    expect(full.snapshot.current.weatherTimeseries.delivery).toBe("full");
    // Only the changed training series (both sides) is measured; the kept subjects are reused.
    expect(collected.displayChanges).toHaveLength(1);
    expect(measured.timeseries).toBe(removed.length);
    expect([measured.unchanged, measured.eew, measured.weather, measured.whole]).toEqual([0, 0, 0, 0]);
    expectConsistent(full.state, full.snapshot, full.utf8Bytes);
    expectMatchesReference(full.state, reference(collected, at));
  });

  it("P2-A8-T06 / P2-A8-COST.acceptance: near the legal retention bounds each update measures only its own subject", () => {
    const views = { eew: 0, weather: 0, timeseries: 0 };
    const counting = { ...calls,
      toEewView: (state: Parameters<typeof toEewView>[0]) => { views.eew++; return toEewView(state); },
      toWeatherCurrentView: (state: Parameters<typeof toWeatherCurrentView>[0]) => { views.weather++; return toWeatherCurrentView(state); },
      toWeatherTimeseriesView: (state: Parameters<typeof toWeatherTimeseriesView>[0]) => { views.timeseries++; return toWeatherTimeseriesView(state); } };
    const run = (state: RuntimeState, input: RuntimeInput): RuntimeStep => reduceRuntime(state, input, counting);
    let state = startup(clock).state;
    // RES-07: U-E 512 per family, U-W 3 national + 128 partial, U-F 512 subjects (built by the real reducers).
    for (let index = 0; index < 512; index++) {
      state = run(state, received("run", eewReport(String(20240417000000 + index)), clock)).state;
      state = run(state, received("run", eewReport(String(20240417000000 + index), "normal", "77_01_01_240613_VXSE45"), clock)).state;
    }
    for (const operation of ["通常", "訓練", "試験"])
      state = run(state, received("run", decode("15_18_01_250630_VPWS50", "VPWS50",
        (xml) => xml.replace("<Status>通常</Status>", `<Status>${operation}</Status>`), `national-${operation}`), clock)).state;
    for (let index = 0; index < 128; index++) state = run(state, received("run", decode("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => office(xml, `官署${index}`), `partial-${index}`), clock)).state;
    for (let index = 0; index < 512; index++) state = run(state, received("run", timeseries(`官署${index}`), clock)).state;
    expect([state.units["U-E"].current.length, Object.keys(state.units["U-W"].national).length, state.units["U-W"].partials.length,
      state.units["U-F"].subjects.length]).toEqual([1024, 3, 128, 512]);
    // AC12: at the legal bounds every full domain exceeds 64 KiB, so all three degrade and the total stays <= 1 MiB.
    const initial = projected(projectSnapshot(projectionInput({ state, outcomes: [], displayChanges: allSubjects(state),
      admissionCounts: startup(clock).admissionCounts }, at), null));
    expectConsistent(initial.state, initial.snapshot, initial.utf8Bytes);
    let projection = initial.state;
    const capacity = { snapshot: initial.utf8Bytes, eew: projection.domains.eew.utf8Bytes,
      weather: projection.domains.weatherCurrent.utf8Bytes, timeseries: projection.domains.weatherTimeseries.utf8Bytes,
      summaries: (["eew", "weatherCurrent", "weatherTimeseries"] as const).map((key) =>
        Buffer.byteLength(JSON.stringify(initial.snapshot.current[key]))) };
    expect((["eew", "weatherCurrent", "weatherTimeseries"] as const).map((key) => initial.snapshot.current[key].delivery))
      .toEqual(["summary", "summary", "summary"]);
    expect(Math.max(...capacity.summaries)).toBeLessThanOrEqual(3558);
    expect(initial.utf8Bytes).toBeLessThanOrEqual(1_048_576);

    const scenarios: Readonly<Record<string, (index: number) => RuntimeInput>> = {
      eew: (index) => received("run", eewReport("20240417000000", "normal", "37_01_01_240613_VXSE43", (xml) =>
        atTime(xml, new Date(Date.parse("2024-04-17T23:14:59+09:00") + (index + 1) * 1000).toISOString())
          .replace("<Serial>1</Serial>", `<Serial>${index + 2}</Serial>`)), clock),
      metadata: (index) => ({ kind: "connectionLost", acceptedThroughSequence: index, clock }),
      weather: (index) => received("run", decode("15_16_02_251222_VPWW57", "VPWW57", (xml) => atTime(office(xml, "官署0"),
        new Date(Date.parse("2020-06-22T23:00:00+09:00") + (index + 1) * 60_000).toISOString()), `W-${index}`), clock),
      timeseries: (index) => received("run", timeseries("官署0",
        new Date(Date.parse("2026-06-05T17:00:00+09:00") + (index + 1) * 1000).toISOString()), clock),
    };
    const report: Record<string, unknown> = { capacityBytes: capacity };
    let lastInputAt = 0;
    for (const [name, input] of Object.entries(scenarios)) {
      const times: number[] = [];
      const counts = { a1Views: { eew: 0, weather: 0, timeseries: 0 }, measured: { eew: 0, weather: 0, timeseries: 0 },
        unchanged: 0, whole: 0, snapshots: 0, maxStringifiedBytes: 0, changes: 0 };
      for (let index = 0; index < 110; index++) {
        const before = { ...views };
        const next = run(state, input(index));
        const viewDelta = { eew: views.eew - before.eew, weather: views.weather - before.weather, timeseries: views.timeseries - before.timeseries };
        const { result, ms, measured } = measure(projectionInput(next, at, { connection: { state: "connected",
          disconnectedAt: null, lastInputAt: ++lastInputAt } }), projection, state, next.state);
        if (result.kind === "rejected") throw new Error(result.reason);
        state = next.state;
        projection = result.state;
        if (index < 10) continue;
        times.push(ms);
        for (const key of ["eew", "weather", "timeseries"] as const) {
          counts.a1Views[key] += viewDelta[key];
          counts.measured[key] += measured[key];
        }
        counts.whole += measured.whole;
        counts.unchanged += measured.unchanged;
        counts.snapshots += measured.snapshots;
        counts.changes += next.displayChanges.length;
        counts.maxStringifiedBytes = Math.max(counts.maxStringifiedBytes, measured.stringifiedBytes);
      }
      report[name] = { ...counts, p50Ms: percentile(times, 0.5), p99Ms: percentile(times, 0.99) };
      // Upstream views/states are never stringified whole; only the changed subject's before/after are measured.
      // Unchanged subjects are never re-measured; the changed one is measured at most on its two sides.
      expect([counts.unchanged, counts.whole, counts.snapshots]).toEqual([0, 0, 0]);
      const own = { eew: "eew", metadata: null, weather: "weather", timeseries: "timeseries" }[name];
      for (const key of ["eew", "weather", "timeseries"] as const) {
        expect(counts.measured[key]).toBeLessThanOrEqual(key === own ? 2 * counts.changes : 0);
        expect(counts.measured[key]).toBeGreaterThanOrEqual(key === own ? counts.changes : 0);
        expect(counts.a1Views[key]).toBe(key === own ? 100 : 0);
      }
    }
    expectMatchesReference(projection, reference({ state, outcomes: [], displayChanges: [],
      admissionCounts: startup(clock).admissionCounts }, at, { connection: { state: "connected", disconnectedAt: null, lastInputAt } }));
    console.info(JSON.stringify({ test: "P2-A8-T06", ...report }));
  }, 120_000);
});
