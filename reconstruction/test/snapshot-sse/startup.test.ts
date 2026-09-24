import { describe, expect, it } from "vitest";

import type { CheckpointEnvelope, RuntimeInput, RuntimeState, RuntimeUnitId, RuntimeUnitStates } from "../../contracts/p2-shared-runtime.types";
import type { WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { toWeatherCurrentView } from "../../src/units/weather-current/weather-current-unit";
import { toWeatherTimeseriesView } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import {
  allSubjects, decode, expectConsistent, projected, projectionInput, received, startup, step,
} from "./projection-fixture";

const at = 1780650000000;
const clock = { wallTimeMs: at, monotonicMs: 1 };
const keys = ["eew", "weatherCurrent", "weatherTimeseries"] as const;

const training = (xml: string) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>");

function adopt(files: readonly (readonly [string, string, ((xml: string) => string)?])[]): RuntimeState {
  let state = startup(clock).state;
  for (const [file, type, transform] of files) state = step(state, received("run", decode(file, type, transform), clock)).state;
  return state;
}

function envelope<U extends RuntimeUnitId>(unit: U, state: RuntimeUnitStates[U]): CheckpointEnvelope {
  const codec = linkedUnitCodecs[unit];
  if (codec == null) throw new Error(`${unit} codec is not linked`);
  return { schemaVersion: state.schemaVersion, unit, generation: 1, capturedAt: at - 1000,
    payload: codec.encode(state), sha256: "0".repeat(64) };
}

describe("P2-A8-T01 contractBoundary (AC01/AC02/AC10/AC11)", () => {
  const source = adopt([["15_16_02_251222_VPWW57", "VPWW57"], ["81_03_01_260605_VPWP50_unknown_code", "VPWP50"]]);
  const restorations: Readonly<Record<string, Extract<RuntimeInput, { kind: "startup" }>["restored"]>> = {
    empty: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } },
    unavailable: { "U-E": { kind: "unavailable", reason: "noValidSlot" }, "U-W": { kind: "unavailable", reason: "unknownSchema" },
      "U-F": { kind: "unavailable", reason: "conflictingGeneration" } },
    // U-E persists only intents, so its restored current is always empty.
    restored: { "U-E": { kind: "restored", slot: "A", envelope: envelope("U-E", source.units["U-E"]) },
      "U-W": { kind: "restored", slot: "B", envelope: envelope("U-W", source.units["U-W"]) },
      "U-F": { kind: "restored", slot: "A", envelope: envelope("U-F", source.units["U-F"]) } },
  };

  it.each(Object.keys(restorations))("P2-A8-T01: %s startup publishes all three domains with nine whole markers", (kind) => {
    const started = startup(clock, restorations[kind]);
    const first = projected(projectSnapshot(projectionInput(started, at), null));
    expectConsistent(first.state, first.snapshot, first.utf8Bytes);
    // Startup/restoration never creates a new notice.
    expect(first.snapshot).toMatchObject({ sequence: 1, recovery: started.state.restoration,
      channels: { desktop: "checking", sound: "checking" }, notices: [] });
    for (const key of keys) {
      expect(first.snapshot.current[key].delivery).toBe("full");
      for (const item of first.snapshot.current[key].items)
        expect(item).toMatchObject({ unconfirmed: { startup: expect.any(Number) }, confirmation: { state: "unconfirmed", confirmedAt: null } });
    }
    if (kind === "restored") {
      // Restoration success is not current confirmation; restored W is not shown as confirmed active.
      expect(first.snapshot.current.weatherCurrent.items[0]).toMatchObject({ activeCount: 0,
        unconfirmed: { startup: expect.any(Number) } });
      expect(first.snapshot.current.weatherTimeseries.items[0]).toMatchObject({ activeCount: 1 });
      expect(first.snapshot.current.eew.items[0].activeCount).toBe(0);
    }
    // R41: the probe result replaces checking; the attempt payload never reaches the wire.
    const probed = step(started.state, { kind: "notificationProbeCompleted", clock,
      channels: { desktop: { kind: "idle" }, sound: { kind: "unavailable", reason: "backendMissing" } } });
    const next = projected(projectSnapshot(projectionInput(probed, at), first.state));
    expect(next.snapshot.channels).toEqual({ desktop: "available", sound: "unavailable" });
    expect(next.snapshot.semanticRevision).toBe(first.snapshot.semanticRevision);
    expect(next.state.domains.weatherTimeseries).toBe(first.state.domains.weatherTimeseries);
  });

  it("P2-A8-T01: a partial new report confirms only its scope, never the whole slot", () => {
    const started = startup(clock, restorations.empty);
    const first = projected(projectSnapshot(projectionInput(started, at), null));
    const adopted = step(started.state, received("run", decode("15_16_02_251222_VPWW57", "VPWW57"), clock));
    const next = projected(projectSnapshot(projectionInput(adopted, at), first.state));
    const [normal, training, test] = next.snapshot.current.weatherCurrent.items;
    expect(normal).toMatchObject({ unconfirmed: { startup: 1 }, confirmation: { state: "partial", confirmedAt: null } });
    for (const item of [training, test, ...next.snapshot.current.eew.items, ...next.snapshot.current.weatherTimeseries.items])
      expect(item.confirmation.state).toBe("unconfirmed");
  });

  it("P2-A8-T01: active, all three unavailable reasons, unknown Code, freshness and unconfirmed coexist in one row", () => {
    const real = adopt([["15_16_02_251222_VPWW57", "VPWW57"], ["81_03_01_260605_VPWP50_unknown_code", "VPWP50"],
      ["81_09_01_260605_VPWP50", "VPWP50"], ["81_09_01_260605_VPWP50", "VPWP50", training]]);
    const kyoto = real.units["U-W"].partials[0];
    const token = (office: string) => JSON.stringify(["VPWW57", "partial", office, "all", ""]);
    const weather: WeatherCurrentUnitState = { ...real.units["U-W"],
      unavailable: (["capacityExceeded", "historyUnavailable", "coverageIncomplete"] as const).map((reason, index) => ({
        subject: `normal/VPWW57/官署${index}`, operation: "normal" as const, reason, source: null, lastKnown: null,
        affectedScope: [token(`官署${index}`)] })),
      freshness: [{ target: { operation: "normal", family: "VPWW57", subject: kyoto.subject, affectedScope: [token(kyoto.office)] },
        candidateSource: { ...kyoto.source, inputId: "late" }, currentSource: kyoto.source, currentSemanticRevision: null,
        decision: "unchanged", reason: "stale", revisionOrder: "newer", freshnessSuspect: true,
        suspectedSource: { ...kyoto.source, inputId: "late" }, confirmedScope: [],
        clearCondition: "sameTargetScopeAcceptedOrCoverageConfirmed" }] };
    const wakkanai = real.units["U-F"].subjects[0];
    const timeseries: WeatherTimeseriesUnitState = { ...real.units["U-F"], subjects: [...real.units["U-F"].subjects,
      { ...wakkanai, subject: "normal/VPWP50/網走地方気象台", effective: "unavailable", unavailableReason: "capacityExceeded",
        periods: [], validUntil: null, lastKnown: null }] };
    const state: RuntimeState = { ...real, units: { ...real.units, "U-W": weather, "U-F": timeseries },
      views: { ...real.views,
        "U-W": { ...toWeatherCurrentView(weather), admission: {}, contentRevision: "9:0" },
        "U-F": { ...toWeatherTimeseriesView(timeseries), admission: {}, contentRevision: "9:0" } } };
    const result = projected(projectSnapshot(projectionInput({ state, outcomes: [], displayChanges: allSubjects(state),
      admissionCounts: { "U-E": { normal: 0, training: 0, test: 0 }, "U-W": { normal: 2, training: 0, test: 0 },
        "U-F": { normal: 0, training: 0, test: 0 } } }, at), null));
    expectConsistent(result.state, result.snapshot, result.utf8Bytes);
    const weatherRow = result.snapshot.current.weatherCurrent.items[0];
    expect(weatherRow).toMatchObject({ activeCount: 1, highestSeverity: "danger", admission: { capacityExceeded: 2 },
      unavailable: { capacityExceeded: 1, historyUnavailable: 1, coverageIncomplete: 1 },
      freshness: { stale: 1 }, unconfirmed: { startup: 1 } });
    // Two Nagano series (normal + training) exceed 1 MiB: only U-F becomes a summary, rows unchanged.
    const summary = result.snapshot.current.weatherTimeseries;
    expect(result.state.domains.weatherTimeseries.utf8Bytes).toBeGreaterThan(1_048_576);
    expect(summary).toMatchObject({ delivery: "summary", reason: "snapshotBudget", budgetBytes: 65_536,
      originalBytes: result.state.domains.weatherTimeseries.utf8Bytes });
    expect(summary.items).toBe(result.state.domains.weatherTimeseries.full.items);
    expect(summary.items[0]).toMatchObject({ activeCount: 2, unavailable: { capacityExceeded: 1 },
      unknownCode: { unknown: 2 }, unconfirmed: { startup: 1 } });
    expect(summary.items[1]).toMatchObject({ operation: "training", activeCount: 1, highestSeverity: "advisory" });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4096);
    expect([result.snapshot.current.eew.delivery, result.snapshot.current.weatherCurrent.delivery]).toEqual(["full", "full"]);
  });
});
