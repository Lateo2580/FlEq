import { describe, expect, it } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { RuntimeState, RuntimeUnitId, UnitId } from "../../contracts/p2-shared-runtime.types";
import type {
  DisplayDomainView, DisplaySummaryItem, SnapshotProjectionState, VisibleNotice,
} from "../../contracts/p2-snapshot-sse.types";
import type { WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherTimeseriesSubject } from "../../contracts/p2-weather-timeseries-unit.types";
import { toWeatherCurrentView } from "../../src/units/weather-current/weather-current-unit";
import { toWeatherTimeseriesView } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import {
  allSubjects, atTime, combine, decode, eewReport, expectConsistent, expectMatchesReference, projected, projectionInput, received,
  reference, startup, step, timeseriesChange, unavailableChange,
} from "./projection-fixture";
import type { Step } from "./projection-fixture";

const at = 1780650000000;
const clock = { wallTimeMs: at, monotonicMs: 1 };
const LIMIT = 8_640_000_000_000_000;
const MAX = Number.MAX_SAFE_INTEGER;
const started = startup(clock);
const base = step(started.state, received("run", decode("81_02_01_260605_VPWP50_high_severity", "VPWP50"), clock)).state;
const wakkanai = base.units["U-F"].subjects[0];
const timeseriesUnavailable = () => timeseriesChange(wakkanai, { ...wakkanai, effective: "unavailable", unavailableReason: "capacityExceeded",
  periods: [], validUntil: null, lastKnown: null });

function first(value: Step = started, nowMs = at): SnapshotProjectionState {
  return projected(projectSnapshot(projectionInput(value, nowMs), null)).state;
}

// Legal-shaped padding: a long area name (U-F) and a long input id on an unavailable source (U-W), 1 byte per char.
function padded(timeseriesPad: number, weatherPad: number): Step {
  const strings = [...wakkanai.strings];
  strings[wakkanai.areas[0].name!] = "x".repeat(timeseriesPad);
  const subject: WeatherTimeseriesSubject = { ...wakkanai, strings };
  const source = wakkanai.source!;
  const weather: WeatherCurrentUnitState = { ...base.units["U-W"], unavailable: [{ subject: "normal/VPWW57/京都地方気象台",
    operation: "normal", reason: "coverageIncomplete", lastKnown: null,
    source: { ...source, family: "VPWW57", subject: "normal/VPWW57/京都地方気象台", inputId: "y".repeat(weatherPad) },
    affectedScope: [JSON.stringify(["VPWW57", "partial", "京都地方気象台", "all", ""])] }] };
  const units = { ...base.units, "U-W": weather, "U-F": { ...base.units["U-F"], subjects: [subject] } };
  const state: RuntimeState = { ...base, units, views: { ...base.views,
    "U-W": { ...toWeatherCurrentView(weather), admission: {}, contentRevision: "1:0" },
    "U-F": { ...toWeatherTimeseriesView(units["U-F"]), admission: {}, contentRevision: "1:0" } } };
  return { state, outcomes: [], displayChanges: allSubjects(state), admissionCounts: started.admissionCounts };
}

function project(value: Step) {
  const result = projected(projectSnapshot(projectionInput(value, at), null));
  expectConsistent(result.state, result.snapshot, result.utf8Bytes);
  return result;
}

describe("P2-A8-T07 contractBoundary (AC08/AC12)", () => {
  it("P2-A8-T07: total 1048575/1048576 stay full and 1048577 degrades only the over-budget domain", () => {
    const probe = project(padded(0, 0));
    for (const [total, delivery] of [[1_048_575, "full"], [1_048_576, "full"], [1_048_577, "summary"]] as const) {
      const result = project(padded(total - probe.utf8Bytes, 0));
      const full = result.snapshot.current.weatherTimeseries.delivery === "full";
      expect(full ? result.utf8Bytes : result.utf8Bytes - Buffer.byteLength(JSON.stringify(result.snapshot.current.weatherTimeseries))
        + result.state.domains.weatherTimeseries.utf8Bytes).toBe(total);
      expect(result.snapshot.current.weatherTimeseries.delivery).toBe(delivery);
      expect([result.snapshot.current.eew.delivery, result.snapshot.current.weatherCurrent.delivery]).toEqual(["full", "full"]);
      expect(result.utf8Bytes).toBeLessThanOrEqual(1_048_576);
    }
  });

  it("P2-A8-T07: over 1 MiB, a 65535/65536 byte domain stays full and a 65537 byte domain becomes a summary", () => {
    const big = 1_100_000;
    const probe = project(padded(big, 0));
    const weatherBase = probe.state.domains.weatherCurrent.utf8Bytes;
    for (const [size, delivery] of [[65_535, "full"], [65_536, "full"], [65_537, "summary"]] as const) {
      const result = project(padded(big, size - weatherBase));
      expect(result.state.domains.weatherCurrent.utf8Bytes).toBe(size);
      expect(result.snapshot.current.weatherCurrent.delivery).toBe(delivery);
      expect(result.snapshot.current.weatherTimeseries.delivery).toBe("summary");
      expect(result.snapshot.current.eew.delivery).toBe("full");
      // Summary rows keep training/test and the fault reasons of the full rows.
      expect(result.snapshot.current.weatherCurrent.items).toBe(result.state.domains.weatherCurrent.full.items);
      expect(result.snapshot.current.weatherCurrent.items[0].unavailable).toEqual({ coverageIncomplete: 1 });
      expect(result.snapshot.current.weatherCurrent.items.map((item) => item.operation)).toEqual(["normal", "training", "test"]);
    }
  });

  it("P2-A8-T07: the derived summary maxima (3558; U-E 1632, U-W 3525, U-F 2301) hold on the wire shape", () => {
    const row = (unit: RuntimeUnitId, operation: Operation): DisplaySummaryItem => ({
      operation, informationType: unit === "U-E" ? "eew" : unit === "U-W" ? "weather-warning" : "weather-warning-timeseries",
      // U-E publishes only A4 warningClass, so its highest class is "warning".
      activeCount: MAX, highestSeverity: unit === "U-E" ? "warning" : "specialWarning",
      areaCounts: unit === "U-E" ? { eewArea: MAX } : unit === "U-F" ? { forecastArea: MAX }
        : { prefecture: MAX, primary: MAX, municipalityGroup: MAX, municipality: MAX, stormSurge: MAX },
      updatedAt: -LIMIT, admission: { capacityExceeded: MAX },
      unavailable: unit === "U-E" ? {} : { capacityExceeded: MAX, historyUnavailable: MAX, coverageIncomplete: MAX },
      unconfirmed: { startup: MAX, disconnected: MAX, scopeCapacity: MAX, scopeRetired: MAX },
      unknownCode: unit === "U-E" ? {} : { unknown: MAX, missing: MAX, empty: MAX },
      freshness: unit !== "U-W" ? {} : { headMissing: MAX, reportDateTimeMissing: MAX, reportDateTimeInvalid: MAX,
        identityMissing: MAX, identityInvalid: MAX, requiredStructureMissing: MAX, requiredStructureInvalid: MAX, stale: MAX },
      confirmation: { state: "unconfirmed", confirmedAt: -LIMIT },
    });
    const wrapper = (unit: RuntimeUnitId): DisplayDomainView<never> => ({ unit, contentRevision: `${MAX}:7`,
      items: [row(unit, "normal"), row(unit, "training"), row(unit, "test")],
      delivery: "summary", reason: "snapshotBudget", originalBytes: MAX, budgetBytes: 65_536 });
    const sizes = (["U-E", "U-W", "U-F"] as const).map((unit) => Buffer.byteLength(JSON.stringify(wrapper(unit))));
    expect(sizes[0]).toBeLessThanOrEqual(1632);
    expect(sizes[1]).toBeLessThanOrEqual(3525);
    expect(sizes[2]).toBeLessThanOrEqual(2301);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3558);
  });

  it("P2-A8-T07: the maximal notice is 2000 bytes, 64 of them 128065 <= 131072; long control-character offices are cut", () => {
    const hex = "f".repeat(64);
    const office = Array.from({ length: 300 }, (_, index) => String.fromCharCode(index % 0x20)).join("");
    // Contract upper bound: longest kind, longest text and a 256-byte office of six-byte JSON escapes at once.
    const maximal: VisibleNotice = { id: hex, targetId: hex, unit: "U-W", kind: "unavailable", operation: "training",
      text: "緊急地震速報が警報に変わりました", expiresAt: -LIMIT,
      source: { id: hex, family: "VXSE43", office: "\u0001".repeat(256), officeTruncated: false, reportTime: -LIMIT } };
    expect(Buffer.byteLength(JSON.stringify(maximal))).toBe(2000);
    expect(Buffer.byteLength(JSON.stringify(Array(64).fill(maximal)))).toBe(128_065);

    const adopted = step(started.state, received("run", decode("15_16_02_251222_VPWW57", "VPWW57"), clock));
    const previous = projected(projectSnapshot(projectionInput(adopted, at), first())).state;
    for (const [value, text, truncated] of [[office, office.slice(0, 256), true], ["\ud800気".repeat(60), "\ufffd気".repeat(42) + "\ufffd", true],
      ["京都地方気象台", "京都地方気象台", false]] as const) {
      const { change, outcome } = unavailableChange(adopted.state, value);
      const result = projected(projectSnapshot(projectionInput({ ...adopted, outcomes: [outcome], displayChanges: [change] }, at), previous));
      expect(result.snapshot.notices).toMatchObject([{ kind: "unavailable", unit: "U-W", text: "気象警報の現況を確認できません",
        expiresAt: at + 60_000, source: { family: "VPWW57", office: text, officeTruncated: truncated } }]);
      expect(Buffer.byteLength(result.snapshot.notices[0].source!.office!)).toBeLessThanOrEqual(256);
    }
  });

  it.each([63, 64, 65])("P2-A8-T07: %i new normal EEW notices keep at most 64 and report the excess", (count) => {
    const previous = first();
    const value = combine(started.state, Array.from({ length: count }, (_, index) =>
      received("run", eewReport(String(20240417000000 + index)), clock)));
    const result = projected(projectSnapshot(projectionInput(value, at), previous));
    expect(result.snapshot.notices).toHaveLength(Math.min(count, 64));
    expect(result.diagnostics).toEqual(count > 64 ? [{ level: "WARN", component: "view-projector",
      reason: "snapshotNoticeCapacityExceeded", count: count - 64 }] : []);
  });

  it("P2-A8-T07: under capacity normal outranks training/test and normal EEW outranks normal weather", () => {
    const adopted = step(started.state, received("run", decode("15_16_02_251222_VPWW57", "VPWW57"), clock));
    const previous = projected(projectSnapshot(projectionInput(adopted, at), first())).state;
    const value = combine(adopted.state, [
      ...Array.from({ length: 3 }, (_, index) => received("run", eewReport(String(20240418000000 + index), "training"), clock)),
      ...Array.from({ length: 64 }, (_, index) => received("run", eewReport(String(20240417000000 + index)), clock))]);
    const { change, outcome } = unavailableChange(adopted.state, "京都地方気象台");
    const result = projected(projectSnapshot(projectionInput({ ...value, outcomes: [...value.outcomes, outcome],
      displayChanges: [...value.displayChanges, change] }, at), previous));
    expect(result.snapshot.notices).toHaveLength(64);
    expect(new Set(result.snapshot.notices.map((item) => `${item.operation}/${item.unit}`))).toEqual(new Set(["normal/U-E"]));
    expect(result.diagnostics).toMatchObject([{ reason: "snapshotNoticeCapacityExceeded", count: 4 }]);
  });

  it("P2-A8-T07 / PUBLICATION (a): an initial common-string rejection publishes nothing, then sequence 1", () => {
    const rejected = projectSnapshot(projectionInput(started, at, { generatedAt: "x".repeat(257) }), null);
    expect(rejected).toMatchObject({ kind: "rejected", reason: "snapshotStringLimitExceeded",
      diagnostics: [{ reason: "snapshotStringLimitExceeded" }] });
    expect(rejected.state).toMatchObject({ streamId: "stream", snapshot: null });
    const result = projected(projectSnapshot(projectionInput({ ...started, outcomes: [], displayChanges: [] }, at), rejected.state));
    expect(result.snapshot.sequence).toBe(1);
    expectMatchesReference(result.state, reference(started, at));
  });

  it("P2-A8-T07 / PUBLICATION (b): rejected steps keep internal deltas and notices; recovery publishes N+1 without double counting", () => {
    const published = projected(projectSnapshot(projectionInput(started, at), null));
    const one = combine(started.state, [received("run", eewReport("20240417000001"), clock)]);
    const counts = { ...one.admissionCounts, "U-W": { normal: 2, training: 0, test: 0 } };
    const two = combine(one.state, [received("run", eewReport("20240417000002"), clock)]);
    let state = published.state;
    for (const value of [one, two]) {
      const rejected = projectSnapshot(projectionInput({ ...value, admissionCounts: counts }, at, { generatedAt: "x".repeat(257) }), state);
      expect(rejected).toMatchObject({ kind: "rejected", reason: "snapshotStringLimitExceeded" });
      expect(rejected.state.snapshot).toBe(published.snapshot);
      state = rejected.state;
    }
    const pending = state.notices;
    expect(pending.map((item) => [item.kind, item.expiresAt])).toEqual([["eewNew", at + 15_000], ["eewNew", at + 15_000]]);
    // The recovery delta also updates an existing subject (before != null), not only additions.
    const three = combine(two.state, [received("run", eewReport("20240417000003", "test"), clock),
      received("run", eewReport("20240417000001", "normal", "37_01_01_240613_VXSE43", (xml) =>
        atTime(xml, "2024-04-17T23:15:09+09:00").replace("<Serial>1</Serial>", "<Serial>2</Serial>")), clock)]);
    expect(three.displayChanges.filter((item) => item.before != null && item.after != null)).toHaveLength(1);
    const recovered = projected(projectSnapshot(projectionInput({ ...three, admissionCounts: counts }, at + 1000), state));
    expect(recovered.snapshot.sequence).toBe(published.snapshot.sequence + 1);
    expect(recovered.snapshot.current.weatherCurrent.items[0].admission).toEqual({ capacityExceeded: 2 });
    expect(recovered.snapshot.notices.filter((item) => pending.some((old) => old.id === item.id && old.expiresAt === item.expiresAt)))
      .toHaveLength(2);
    expect(recovered.snapshot.notices).toHaveLength(3);
    expectMatchesReference(recovered.state, reference({ ...three, admissionCounts: counts }, at));
    const late = projected(projectSnapshot(projectionInput({ ...three, admissionCounts: counts }, at + 15_000), state));
    expect(late.snapshot.notices.map((item) => item.operation)).toEqual(["test"]);
  });

  it("P2-A8-T07 / RES-05 (ledger 50): a long failed-save reason is shortened on a scalar boundary, never a rejection", () => {
    const reason = `ENOSPC: /${"状態".repeat(200)}\ud800`;
    const failed = { "U-E": { kind: "failed" as const, stage: "write" as const, reason,
      currentGeneration: 1, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: 1 } };
    const shown = projected(projectSnapshot(projectionInput(started, at, { persistence: failed }), null)).snapshot.persistence["U-E"];
    if (shown?.kind !== "failed") throw new Error("expected a failed persistence");
    expect(Buffer.byteLength(shown.reason)).toBeLessThanOrEqual(256);
    expect(shown.reason.endsWith("[truncated:fieldLimit]")).toBe(true);
    expect(reason.startsWith(shown.reason.slice(0, -"[truncated:fieldLimit]".length))).toBe(true);
  });

  it.each([["U-E", 15_000], ["U-F", 60_000]] as const)("P2-A8-T07: %s TTL %i accepts both Date-range edges and rejects one past", (unit, ttl) => {
    const generate = (nowMs: number, previous: SnapshotProjectionState) => {
      if (unit === "U-E") {
        const value = combine(base, [received("run", eewReport("20240417000009"), clock)]);
        return projectSnapshot(projectionInput(value, nowMs), previous);
      }
      const { change, outcome } = timeseriesUnavailable();
      return projectSnapshot(projectionInput({ state: base, outcomes: [outcome], displayChanges: [change],
        admissionCounts: started.admissionCounts }, nowMs), previous);
    };
    const previous = (nowMs: number) => projected(projectSnapshot(projectionInput({ state: base, outcomes: [],
      displayChanges: allSubjects(base), admissionCounts: started.admissionCounts }, nowMs), null)).state;
    for (const nowMs of [-LIMIT, LIMIT - ttl]) {
      const result = projected(generate(nowMs, previous(nowMs)));
      expect(result.snapshot.notices.map((item) => item.expiresAt)).toEqual([nowMs + ttl]);
    }
    const before = previous(LIMIT - ttl);
    const rejected = generate(LIMIT - ttl + 1, before);
    expect(rejected).toMatchObject({ kind: "rejected", reason: "snapshotClockInvalid", diagnostics: [] });
    expect(rejected.state.snapshot).toBe(before.snapshot);
    expect(rejected.state.notices).toEqual([]);
    // The semantic delta itself is adopted even though publication is refused.
    const key = unit === "U-E" ? "eew" : "weatherTimeseries";
    expect(rejected.state.domains[key]).not.toBe(before.domains[key]);
  });

  it.each([LIMIT + 1, -LIMIT - 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("P2-A8-T07: nowMs %s is snapshotClockInvalid", (nowMs) => {
    const published = projected(projectSnapshot(projectionInput(started, at), null));
    const one = combine(started.state, [received("run", eewReport("20240417000001"), clock)]);
    const withNotice = projected(projectSnapshot(projectionInput(one, at), published.state));
    const value = combine(one.state, [received("run", eewReport("20240417000002"), clock)]);
    const rejected = projectSnapshot(projectionInput(value, nowMs), withNotice.state);
    expect(rejected).toMatchObject({ kind: "rejected", reason: "snapshotClockInvalid", diagnostics: [] });
    expect(rejected.state.snapshot).toBe(withNotice.snapshot);
    // No time-based reclaim and no new notice while the clock is invalid; the delta is adopted.
    expect(rejected.state.notices).toEqual(withNotice.state.notices);
    expect(rejected.state.domains.eew.full.items[0].activeCount).toBe(2);
  });

  it("P2-A8-T07 / AC08: the largest legal common metadata stays within 65536 bytes", () => {
    const control = Array.from({ length: 256 }, (_, index) => String.fromCharCode(index % 0x20)).join("");
    const units: readonly UnitId[] = ["U-E", "U-Q", "U-T", "U-N", "U-W", "U-L", "U-F", "U-B", "U-M", "U-Y", "U-V", "U-R"];
    const persistence = Object.fromEntries(units.map((unit) => [unit, { kind: "failed" as const, stage: "directorySync" as const,
      reason: control, currentGeneration: MAX, savedGeneration: MAX, savedCapturedAt: -LIMIT, savedAckAt: -LIMIT, dirtySince: -LIMIT }]));
    const result = projected(projectSnapshot(projectionInput(started, at, { streamId: control, generatedAt: control, persistence,
      connection: { state: "reconnecting", disconnectedAt: -LIMIT, lastInputAt: -LIMIT },
      worker: { state: "unresponsive", lastProgressAtMonotonicMs: -LIMIT, lastResponseAtMonotonicMs: -LIMIT } }), null));
    const common = { ...result.snapshot, current: { eew: 0, weatherCurrent: 0, weatherTimeseries: 0 }, notices: [] };
    expect(Buffer.byteLength(JSON.stringify(common))).toBeLessThanOrEqual(65_536);
  });
});
