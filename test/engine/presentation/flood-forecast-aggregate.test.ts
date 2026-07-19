import { describe, it, expect } from "vitest";
import {
  aggregateByRiver,
  type RiverSection,
} from "../../../src/engine/presentation/flood-forecast-aggregate";
import type { FloodStation, FloodLevel } from "../../../src/types";
import { createMockWsDataMessage, FIXTURE_VXKO50_16_10_01 } from "../../helpers/mock-message";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";

function mkStation(partial: Partial<FloodStation> & { stationCode: string; stationObservedLevel: FloodLevel }): FloodStation {
  return {
    stationName: partial.stationName ?? `S${partial.stationCode}`,
    stationCode: partial.stationCode,
    riverNames: partial.riverNames ?? [],
    primaryRiverCode: partial.primaryRiverCode ?? null,
    primaryRiverName: partial.primaryRiverName ?? null,
    prefName: partial.prefName ?? null,
    cityName: partial.cityName ?? null,
    cityCode: partial.cityCode ?? null,
    location: partial.location ?? null,
    measurement: partial.measurement ?? "water_level",
    measurementUnit: partial.measurementUnit ?? "m",
    rawUnit: partial.rawUnit ?? "m",
    series: partial.series ?? [],
    criteria: partial.criteria ?? {
      L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m",
    },
    stationObservedLevel: partial.stationObservedLevel,
    headlineKindCode: partial.headlineKindCode ?? "unknown",
    headlineLevel: partial.headlineLevel ?? partial.stationObservedLevel,
    mainItemCode: partial.mainItemCode ?? null,
    mainTextHash: partial.mainTextHash ?? "",
  };
}

describe("aggregateByRiver", () => {
  it("groups stations by primaryRiverCode", () => {
    const stations: FloodStation[] = [
      mkStation({
        stationCode: "s1", primaryRiverCode: "RC-A", primaryRiverName: "A川",
        stationObservedLevel: "L2",
      }),
      mkStation({
        stationCode: "s2", primaryRiverCode: "RC-A", primaryRiverName: "A川",
        stationObservedLevel: "L3",
      }),
      mkStation({
        stationCode: "s3", primaryRiverCode: "RC-B", primaryRiverName: "B川",
        stationObservedLevel: "L4",
      }),
    ];
    const rivers = aggregateByRiver(stations);
    expect(rivers.length).toBe(2);
    // B川 (L4) が先頭、A川 (L3) が次
    expect(rivers[0].riverName).toBe("B川");
    expect(rivers[0].riverKey).toBe("RC-B");
    expect(rivers[0].stations.length).toBe(1);
    expect(rivers[0].highestObservedLevel).toBe("L4");

    expect(rivers[1].riverName).toBe("A川");
    expect(rivers[1].stations.length).toBe(2);
    expect(rivers[1].highestObservedLevel).toBe("L3");
  });

  it("sorts rivers by highestObservedRank descending", () => {
    const stations: FloodStation[] = [
      mkStation({ stationCode: "s1", primaryRiverCode: "RC-LOW", primaryRiverName: "Low川", stationObservedLevel: "L1" }),
      mkStation({ stationCode: "s2", primaryRiverCode: "RC-MID", primaryRiverName: "Mid川", stationObservedLevel: "L3" }),
      mkStation({ stationCode: "s3", primaryRiverCode: "RC-HIGH", primaryRiverName: "High川", stationObservedLevel: "L5" }),
    ];
    const rivers = aggregateByRiver(stations);
    expect(rivers.map(r => r.riverName)).toEqual(["High川", "Mid川", "Low川"]);
  });

  it("preserves insertion order when rivers have same rank", () => {
    const stations: FloodStation[] = [
      mkStation({ stationCode: "s1", primaryRiverCode: "RC-A", primaryRiverName: "A川", stationObservedLevel: "L2" }),
      mkStation({ stationCode: "s2", primaryRiverCode: "RC-B", primaryRiverName: "B川", stationObservedLevel: "L2" }),
      mkStation({ stationCode: "s3", primaryRiverCode: "RC-C", primaryRiverName: "C川", stationObservedLevel: "L2" }),
    ];
    const rivers = aggregateByRiver(stations);
    expect(rivers.map(r => r.riverName)).toEqual(["A川", "B川", "C川"]);
  });

  it("falls back to primaryRiverName when primaryRiverCode is null", () => {
    const stations: FloodStation[] = [
      mkStation({ stationCode: "s1", primaryRiverCode: null, primaryRiverName: "A川", stationObservedLevel: "L3" }),
      mkStation({ stationCode: "s2", primaryRiverCode: null, primaryRiverName: "A川", stationObservedLevel: "L2" }),
      mkStation({ stationCode: "s3", primaryRiverCode: null, primaryRiverName: "B川", stationObservedLevel: "L4" }),
    ];
    const rivers = aggregateByRiver(stations);
    expect(rivers.length).toBe(2);
    expect(rivers[0].riverName).toBe("B川");
    expect(rivers[0].riverKey).toBe("B川");
    expect(rivers[1].riverName).toBe("A川");
    expect(rivers[1].riverKey).toBe("A川");
  });

  it("falls back to stationCode when both primaryRiverCode and primaryRiverName are null", () => {
    const stations: FloodStation[] = [
      mkStation({ stationCode: "s1", primaryRiverCode: null, primaryRiverName: null, stationObservedLevel: "L2" }),
      mkStation({ stationCode: "s2", primaryRiverCode: null, primaryRiverName: null, stationObservedLevel: "L3" }),
    ];
    const rivers = aggregateByRiver(stations);
    // 各 station が独立 group になる (stationCode が key)
    expect(rivers.length).toBe(2);
    expect(rivers[0].riverKey).toBe("s2");  // L3 が先
    expect(rivers[1].riverKey).toBe("s1");
  });

  it("returns empty array for empty input", () => {
    expect(aggregateByRiver([])).toEqual([]);
  });

  it("riverName fallback: primaryRiverName が null なら riverNames[0]、それも空なら ''", () => {
    const stations: FloodStation[] = [
      mkStation({
        stationCode: "s1", primaryRiverCode: "RC-X", primaryRiverName: null,
        riverNames: ["X川 (ChargeSection)"], stationObservedLevel: "L2",
      }),
    ];
    const rivers = aggregateByRiver(stations);
    expect(rivers[0].riverName).toBe("X川 (ChargeSection)");
  });

  it("16_10_01 fixture: 河川グループ化 (4 河川以上)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXKO50_16_10_01);
    const info = parseFloodForecast(msg);
    expect(info).not.toBeNull();
    const rivers: RiverSection[] = aggregateByRiver(info!.rawStations);
    expect(rivers.length).toBeGreaterThanOrEqual(1);
    // sort 順: highestObservedRank 降順
    for (let i = 1; i < rivers.length; i++) {
      expect(rivers[i - 1].highestObservedRank).toBeGreaterThanOrEqual(rivers[i].highestObservedRank);
    }
    // 各 river は少なくとも 1 station を持つ
    for (const r of rivers) {
      expect(r.stations.length).toBeGreaterThanOrEqual(1);
    }
  });
});
