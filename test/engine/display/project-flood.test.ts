import { describe, expect, it } from "vitest";
import { maxFloodLevel } from "../../../src/dmdata/flood-level";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { projectFloodUpdate, floodRiverKey, normalizeRiverName } from "../../../src/engine/display/project-flood";
import { fromFloodForecastOutcome } from "../../../src/engine/presentation/events/from-flood-forecast";
import type { FloodForecastOutcome, PresentationEvent } from "../../../src/engine/presentation/types";
import type { FloodStation, ParsedFloodForecastInfo } from "../../../src/types";
import { createMockWsDataMessage } from "../../helpers/mock-message";

const T0_ISO = "2026-07-21T05:00:00+09:00";

function station(overrides: Partial<FloodStation> = {}): FloodStation {
  return {
    stationName: "第一観測所",
    stationCode: "station-1",
    riverNames: ["多摩川"],
    primaryRiverCode: "8303050001",
    primaryRiverName: "多摩川",
    prefName: null,
    cityName: null,
    cityCode: null,
    location: null,
    measurement: "water_level",
    measurementUnit: "m",
    rawUnit: "m",
    series: [],
    criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
    stationObservedLevel: "L2",
    headlineKindCode: "30",
    headlineLevel: "L3",
    mainItemCode: "1",
    mainTextHash: "hash",
    ...overrides,
  };
}

function parsed(overrides: Partial<ParsedFloodForecastInfo> = {}): ParsedFloodForecastInfo {
  return {
    schema: "vxko50",
    typeCode: "VXKO50",
    infoKind: "指定河川洪水予報",
    infoType: "発表",
    serial: 1,
    eventId: "event-1",
    controlTitle: "指定河川洪水予報",
    headTitle: "多摩川氾濫警戒情報",
    reportDateTime: T0_ISO,
    targetDateTime: null,
    isTest: false,
    notice: null,
    headlines: [{
      scope: "河川",
      rawScopeLabel: "指定河川洪水予報（河川）",
      kindName: "氾濫警戒情報",
      kindCode: "30",
      headlineText: "多摩川氾濫警戒情報",
      condition: "",
      areas: [{ name: "多摩川", code: "8303050001" }],
    }],
    rawStations: [station()],
    inundationAreas: [],
    rainfallSummaries: [],
    floodAssumptions: [],
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    ...overrides,
  };
}

function event(raw: ParsedFloodForecastInfo, overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  const levels = raw.rawStations.flatMap((candidate) => [candidate.stationObservedLevel, candidate.headlineLevel]);
  const maximum = maxFloodLevel(levels);
  return {
    id: "message-1",
    classification: "telegram.weather",
    domain: "floodForecast",
    type: raw.typeCode,
    infoType: raw.infoType,
    title: raw.headTitle,
    controlTitle: raw.controlTitle,
    headline: raw.headlines[0]?.headlineText ?? raw.headTitle,
    reportDateTime: raw.reportDateTime,
    publishingOffice: raw.publishingOffice,
    isTest: false,
    frameLevel: maximum === "L4" || maximum === "L5" ? "critical" : "warning",
    isCancellation: raw.infoType === "取消",
    eventId: raw.eventId,
    serial: String(raw.serial),
    areaNames: raw.rawStations.map((candidate) => candidate.stationName),
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: raw.rawStations.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw,
    ...overrides,
  };
}

describe("projectFloodUpdate", () => {
  it("normalizes full-width characters and whitespace for fallback river keys", () => {
    expect(normalizeRiverName("　多 摩　川 ＡＢＣ　")).toBe("多摩川ABC");
    expect(floodRiverKey(station({ primaryRiverCode: "", primaryRiverName: " 多摩　川 " }), "気象庁"))
      .toBe("name:多摩川");
    expect(floodRiverKey(station({ primaryRiverCode: null, primaryRiverName: "　" }), "関東地方整備局"))
      .toBe("station:関東地方整備局:station-1");
  });

  it("aggregates stations by river, takes both observed and headline levels, and drops levels below L3", () => {
    const raw = parsed({
      rawStations: [
        station({ stationName: "第一", stationObservedLevel: "L2", headlineLevel: "L3" }),
        station({ stationName: "第二", stationCode: "station-2", stationObservedLevel: "L4", headlineLevel: "L3" }),
        station({ stationName: "第三", stationCode: "station-3", primaryRiverCode: "8303050002", primaryRiverName: "浅川", stationObservedLevel: "L2", headlineLevel: "L2" }),
      ],
    });

    expect(projectFloodUpdate(event(raw))).toEqual({
      mode: "replace",
      eventId: "event-1",
      reportDateTime: T0_ISO,
      serial: "1",
      rivers: [{
        riverKey: "8303050001",
        riverName: "多摩川",
        level: "L4",
        levelRank: 40,
        kindName: "氾濫警戒情報",
        reportDateTime: T0_ISO,
      }],
    });
  });

  it.each([
    ["headline-only", parsed({ rawStations: [] }), "observeOnly"],
    ["structured-data-free correction", parsed({ infoType: "訂正", rawStations: [] }), "observeOnly"],
    ["cancellation", parsed({ infoType: "取消", rawStations: [] }), "cancel"],
  ] as const)("classifies %s as %s", (_label, raw, expectedMode) => {
    expect(projectFloodUpdate(event(raw))).toEqual(expect.objectContaining({ mode: expectedMode }));
  });

  it("returns null for other presentation domains", () => {
    expect(projectFloodUpdate(event(parsed(), { domain: "weather" }))).toBeNull();
  });

  const fixtureCases = [
    ["16_01_01_220728_VXKO50.xml", "replace", []],
    ["16_02_01_220728_VXKO50.xml", "replace", ["1234567890|○○川|L3", "9876543210|△△川|L3"]],
    ["16_02_02_220728_VXKO50.xml", "replace", ["8909040001|六角川|L3"]],
    ["16_03_01_220728_VXKO50.xml", "replace", ["1234567890|○○川|L3", "9876543210|△△川|L3"]],
    ["16_04_01_220728_VXKO50.xml", "replace", ["1234567890|○○川|L5", "9876543210|△△川|L5"]],
    ["16_05_01_210630_VXKO50.xml", "observeOnly", []],
    ["16_06_01_220728_VXKO50.xml", "replace", ["1234567890|○○川|L4", "9876543210|△△川|L4"]],
    ["16_07_01_220728_VXKO50.xml", "replace", ["1234567890|○○川|L4", "9876543210|△△川|L4"]],
    ["16_10_01_260312_VXKO50.xml", "replace", ["8909100001|緑川|L4", "8909100051|加勢川|L4", "8909100068|御船川|L4"]],
    ["16_11_01_260312_VXKO50.xml", "replace", ["8202110001|最上川|L5", "8202110221|丹生川|L5", "8202110170|最上小国川|L5"]],
    ["16_11_02_260312_VXKO50.xml", "replace", ["8202110001|最上川|L5", "8202110221|丹生川|L5", "8202110170|最上小国川|L5"]],
    ["16_12_01_260312_VXKO50.xml", "replace", ["8303030001|利根川|L5"]],
    ["16_14_01_251222_VXKO50.xml", "replace", []],
    ["synthetic_VXKO50_code31.xml", "replace", ["1234567890|○○川|L3"]],
    ["synthetic_VXKO50_correction.xml", "replace", ["1234567890|○○川|L3"]],
    ["synthetic_VXKO50_cancel.xml", "cancel", []],
    ["91_01_01_241031_VXSU50.xml", "replace", []],
  ] as const;

  it.each(fixtureCases)("runs %s through parser → presentation → projection", (fixture, expectedMode, expectedRivers) => {
    const msg = createMockWsDataMessage(fixture);
    const info = parseFloodForecast(msg);
    expect(info, `${fixture} should parse`).not.toBeNull();
    if (info == null) return;
    const outcome: FloodForecastOutcome = {
      domain: "floodForecast",
      msg,
      headType: msg.head.type,
      statsCategory: "floodForecast",
      parsed: info,
      diff: null,
      maxLevel: "unknown",
      maxRank: -1,
      stats: { shouldRecord: true, eventId: info.eventId },
      presentation: { frameLevel: "info" },
    };
    const update = projectFloodUpdate(fromFloodForecastOutcome(outcome));
    expect(update?.mode).toBe(expectedMode);
    const rivers = update?.mode === "replace"
      ? update.rivers.map((river) => `${river.riverKey}|${river.riverName}|${river.level}`)
      : [];
    expect(rivers).toEqual(expectedRivers);
  });
});
