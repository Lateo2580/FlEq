import { describe, it, expect } from "vitest";
import {
  FLOOD_LEVEL_RANK, FLOOD_KIND_CODE_TO_LEVEL,
  type FloodReportSchema, type FloodKindCode, type FloodLevel,
  type FloodInfoScope, type FloodMeasurement, type FloodMeasurementUnit,
} from "../../src/types";
import type {
  ParsedFloodForecastInfo, FloodHeadline, FloodStation, FloodSeriesWindow,
  FloodCriteria, InundationArea, RainfallSummary, FloodAssumptionPart,
} from "../../src/types";

describe("flood basic types + constants", () => {
  it("FLOOD_LEVEL_RANK has all keys with correct values", () => {
    expect(FLOOD_LEVEL_RANK).toEqual({
      release: 5, L1: 10, L2: 20, L3: 30, L4: 40, L5: 51, unknown: -1,
    });
  });
  it("FLOOD_KIND_CODE_TO_LEVEL maps all known codes", () => {
    expect(FLOOD_KIND_CODE_TO_LEVEL["10"]).toBe("release");
    expect(FLOOD_KIND_CODE_TO_LEVEL["20"]).toBe("L2");
    expect(FLOOD_KIND_CODE_TO_LEVEL["21"]).toBe("L2");
    expect(FLOOD_KIND_CODE_TO_LEVEL["30"]).toBe("L3");
    expect(FLOOD_KIND_CODE_TO_LEVEL["31"]).toBe("L3");
    expect(FLOOD_KIND_CODE_TO_LEVEL["40"]).toBe("L4");
    expect(FLOOD_KIND_CODE_TO_LEVEL["41"]).toBe("L4");
    expect(FLOOD_KIND_CODE_TO_LEVEL["51"]).toBe("L5");
    expect(FLOOD_KIND_CODE_TO_LEVEL["53"]).toBe("L5");
    expect(FLOOD_KIND_CODE_TO_LEVEL["unknown"]).toBe("unknown");
  });
  it("type aliases compile", () => {
    const schema: FloodReportSchema = "vxko50";
    const code: FloodKindCode = "30";
    const level: FloodLevel = "L3";
    const scope: FloodInfoScope = "河川";
    const measurement: FloodMeasurement = "water_level";
    const unit: FloodMeasurementUnit = "m";
    expect([schema, code, level, scope, measurement, unit]).toEqual(["vxko50", "30", "L3", "河川", "water_level", "m"]);
  });
});

describe("flood interfaces", () => {
  it("ParsedFloodForecastInfo compiles with all fields", () => {
    const info: ParsedFloodForecastInfo = {
      schema: "vxko50", typeCode: "VXKO50",
      infoKind: "指定河川洪水予報", infoType: "発表",
      serial: 1, eventId: "830303020300",
      controlTitle: "指定河川洪水予報", headTitle: "○○川上流氾濫注意情報",
      reportDateTime: "2019-05-09T20:40:00+09:00", targetDateTime: null,
      isTest: false, notice: null,
      headlines: [], rawStations: [],
      inundationAreas: [], rainfallSummaries: [], floodAssumptions: [],
      publishingOffice: "", editorialOffice: "",
    };
    expect(info.schema).toBe("vxko50");
  });
  it("FloodStation compiles with headlineKindCode + mainItemCode + mainTextHash", () => {
    const s: FloodStation = {
      stationName: "○○", stationCode: "12345678901234567",
      riverNames: ["○○川"], primaryRiverCode: "1234567890",
      primaryRiverName: "○○川", prefName: null, cityName: null, cityCode: null, location: null,
      measurement: "water_level", measurementUnit: "m", rawUnit: "m",
      series: [], criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
      stationObservedLevel: "L2", headlineKindCode: "30", headlineLevel: "L3",
      mainItemCode: "1", mainTextHash: "0".repeat(40),
    };
    expect(s.headlineKindCode).toBe("30");
  });
  it("FloodStation.mainItemCode null + mainTextHash '' (Headline-only fallback)", () => {
    const s: FloodStation = {
      stationName: "S", stationCode: "x", riverNames: [],
      primaryRiverCode: null, primaryRiverName: null,
      prefName: null, cityName: null, cityCode: null, location: null,
      measurement: "water_level", measurementUnit: "m", rawUnit: "m",
      series: [], criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
      stationObservedLevel: "unknown", headlineKindCode: "unknown", headlineLevel: "unknown",
      mainItemCode: null, mainTextHash: "",
    };
    expect(s.mainItemCode).toBeNull();
  });
});
