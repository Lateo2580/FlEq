import { testTelegramMeta } from "../../helpers/telegram-meta";
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
    meta: testTelegramMeta(false),
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
        station: { name: "第二", levelM: null, trend: null, thresholdLabel: "氾濫危険水位超過", hydrograph: null },
      }],
    });
  });

  it("picks the highest-level station as the river representative (ties keep the first)", () => {
    const raw = parsed({
      rawStations: [
        station({ stationName: "下流", stationObservedLevel: "L3", headlineLevel: "L3" }),
        station({ stationName: "中流", stationCode: "s2", stationObservedLevel: "L4", headlineLevel: "L3" }),
        station({ stationName: "上流", stationCode: "s3", stationObservedLevel: "L4", headlineLevel: "L3" }),
      ],
    });
    const update = projectFloodUpdate(event(raw));
    expect(update?.mode).toBe("replace");
    if (update?.mode !== "replace") return;
    expect(update.rivers[0].station?.name).toBe("中流");
  });

  it.each([
    ["rising", [3.0, 3.02], "rising"],
    ["falling", [3.0, 2.98], "falling"],
    ["steady within threshold", [3.0, 3.005], "steady"],
  ] as const)("derives station trend (%s) from the nearest two series points", (_label, [now, next], expected) => {
    const raw = parsed({
      rawStations: [station({
        stationObservedLevel: "L3",
        headlineLevel: "L3",
        series: [
          { refId: "0", dateTime: T0_ISO, name: "現況", value: now, unit: "m", rawUnit: "m", condition: "正常", level: 3 },
          { refId: "1", dateTime: T0_ISO, name: "1H", value: next, unit: "m", rawUnit: "m", condition: "正常", level: 3 },
        ],
      })],
    });
    const update = projectFloodUpdate(event(raw));
    if (update?.mode !== "replace") throw new Error("expected replace");
    expect(update.rivers[0].station?.trend).toBe(expected);
  });

  it("leaves station trend null when the series has one point or fewer", () => {
    const oneAndZero = [
      parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", series: [
        { refId: "0", dateTime: T0_ISO, name: "現況", value: 3.0, unit: "m", rawUnit: "m", condition: "正常", level: 3 },
      ] })] }),
      parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", series: [] })] }),
    ];
    for (const raw of oneAndZero) {
      const update = projectFloodUpdate(event(raw));
      if (update?.mode !== "replace") throw new Error("expected replace");
      expect(update.rivers[0].station?.trend).toBeNull();
    }
  });

  it.each([
    ["L4 exceedance", "L4", { L4: 3.2 }, "氾濫危険水位 3.20m 超過"],
    ["L3 exceedance", "L3", { L3: 2.5 }, "避難判断水位 2.50m 超過"],
    ["L5 uses the L4 danger threshold", "L5", { L4: 3.2 }, "氾濫危険水位 3.20m 超過"],
    ["missing criterion falls back to the name only", "L4", { L4: null }, "氾濫危険水位超過"],
  ] as const)("labels the exceeded threshold (%s)", (_label, observed, crit, expected) => {
    const raw = parsed({
      rawStations: [station({
        stationObservedLevel: observed,
        headlineLevel: observed,
        criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m", ...crit },
      })],
    });
    const update = projectFloodUpdate(event(raw));
    if (update?.mode !== "replace") throw new Error("expected replace");
    expect(update.rivers[0].station?.thresholdLabel).toBe(expected);
  });

  it("reads levelM from the current observation and nulls it when the unit is not metres or the value is missing", () => {
    const withLevel = parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", series: [
      { refId: "0", dateTime: T0_ISO, name: "現況", value: 3.42, unit: "m", rawUnit: "m", condition: "正常", level: 3 },
    ] })] });
    const discharge = parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", measurement: "discharge", measurementUnit: "立方メートル毎秒", rawUnit: "立方メートル毎秒", series: [
      { refId: "0", dateTime: T0_ISO, name: "現況", value: 120, unit: "立方メートル毎秒", rawUnit: "立方メートル毎秒", condition: "正常", level: 3 },
    ] })] });
    const missing = parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", series: [
      { refId: "0", dateTime: T0_ISO, name: "現況", value: null, unit: "m", rawUnit: "m", condition: "欠測", level: null },
    ] })] });

    const levelOf = (raw: ParsedFloodForecastInfo): number | null => {
      const update = projectFloodUpdate(event(raw));
      if (update?.mode !== "replace") throw new Error("expected replace");
      return update.rivers[0].station?.levelM ?? null;
    };
    expect(levelOf(withLevel)).toBe(3.42);
    expect(levelOf(discharge)).toBeNull();
    expect(levelOf(missing)).toBeNull();
  });

  it("projects the full series into a hydrograph (index 0 observed, rest forecast) with L4 as the danger level", () => {
    const raw = parsed({ rawStations: [station({ stationObservedLevel: "L4", headlineLevel: "L4",
      criteria: { L1: null, L2: null, L3: null, L4: 3.2, L4Plan: 9.9, unit: "m", rawUnit: "m" },
      series: [
        { refId: "1", dateTime: "2026-07-21T05:00:00+09:00", name: "現況", value: 3.42, unit: "m", rawUnit: "m", condition: "上昇", level: 4 },
        { refId: "2", dateTime: "2026-07-21T06:00:00+09:00", name: "1H", value: 3.55, unit: "m", rawUnit: "m", condition: "上昇", level: 4 },
        { refId: "3", dateTime: "2026-07-21T07:00:00+09:00", name: "2H", value: 3.40, unit: "m", rawUnit: "m", condition: "下降", level: 4 },
      ] })] });
    const update = projectFloodUpdate(event(raw));
    if (update?.mode !== "replace") throw new Error("expected replace");
    expect(update.rivers[0].station?.hydrograph).toEqual({
      points: [
        { dateTime: "2026-07-21T05:00:00+09:00", valueM: 3.42, phase: "observed" },
        { dateTime: "2026-07-21T06:00:00+09:00", valueM: 3.55, phase: "forecast" },
        { dateTime: "2026-07-21T07:00:00+09:00", valueM: 3.40, phase: "forecast" },
      ],
      dangerLevelM: 3.2,
    });
  });

  it("nulls the hydrograph when the unit is not metres, the series is empty, or every value is missing", () => {
    const discharge = parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", measurement: "discharge", measurementUnit: "立方メートル毎秒", rawUnit: "立方メートル毎秒", series: [
      { refId: "1", dateTime: "2026-07-21T05:00:00+09:00", name: "現況", value: 120, unit: "立方メートル毎秒", rawUnit: "立方メートル毎秒", condition: "正常", level: 3 },
    ] })] });
    const empty = parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", series: [] })] });
    const allMissing = parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3", series: [
      { refId: "1", dateTime: "2026-07-21T05:00:00+09:00", name: "現況", value: null, unit: "m", rawUnit: "m", condition: "欠測", level: null },
    ] })] });
    const hydrographOf = (raw: ParsedFloodForecastInfo): unknown => {
      const update = projectFloodUpdate(event(raw));
      if (update?.mode !== "replace") throw new Error("expected replace");
      return update.rivers[0].station?.hydrograph ?? null;
    };
    expect(hydrographOf(discharge)).toBeNull();
    expect(hydrographOf(empty)).toBeNull();
    expect(hydrographOf(allMissing)).toBeNull();
  });

  it("keeps the hydrograph but nulls dangerLevelM when L4 is missing, and keeps a missing point as a null gap", () => {
    const raw = parsed({ rawStations: [station({ stationObservedLevel: "L3", headlineLevel: "L3",
      criteria: { L1: null, L2: null, L3: 2.5, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
      series: [
        { refId: "1", dateTime: "2026-07-21T05:00:00+09:00", name: "現況", value: 2.60, unit: "m", rawUnit: "m", condition: "上昇", level: 3 },
        { refId: "2", dateTime: "2026-07-21T06:00:00+09:00", name: "1H", value: null, unit: "m", rawUnit: "m", condition: "欠測", level: null },
        { refId: "3", dateTime: "2026-07-21T07:00:00+09:00", name: "2H", value: 2.70, unit: "m", rawUnit: "m", condition: "上昇", level: 3 },
      ] })] });
    const update = projectFloodUpdate(event(raw));
    if (update?.mode !== "replace") throw new Error("expected replace");
    const hydrograph = update.rivers[0].station?.hydrograph;
    expect(hydrograph?.dangerLevelM).toBeNull();
    expect(hydrograph?.points.map((point) => point.valueM)).toEqual([2.60, null, 2.70]);
  });

  it("builds a 7-point hydrograph for the representative station of a real VXKO50 fixture", () => {
    const msg = createMockWsDataMessage("16_10_01_260312_VXKO50.xml");
    const info = parseFloodForecast(msg);
    expect(info).not.toBeNull();
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
    if (update?.mode !== "replace") throw new Error("expected replace");
    const hydrograph = update.rivers[0].station?.hydrograph;
    expect(hydrograph?.points).toHaveLength(7);
    expect(hydrograph?.points[0].phase).toBe("observed");
    expect(hydrograph?.points.slice(1).every((point) => point.phase === "forecast")).toBe(true);
    expect(hydrograph?.points.some((point) => point.valueM != null)).toBe(true);
  });

  it.each([
    ["headline-only", parsed({ rawStations: [] }), "replace"],
    ["headline-only correction", parsed({ infoType: "訂正", rawStations: [] }), "replace"],
    ["unparseable structured-data-free report", parsed({ headlines: [], rawStations: [] }), "observeOnly"],
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
    ["16_05_01_210630_VXKO50.xml", "replace", ["1234567890|○○川|L3", "9876543210|△△川|L3"]],
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

  it("projects a Headline-only release as an explicit cancellation", () => {
    const msg = createMockWsDataMessage("16_14_01_251222_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    const raw = { ...info, rawStations: [] };
    expect(projectFloodUpdate(event(raw))).toEqual(expect.objectContaining({
      mode: "cancel",
      eventId: info.eventId,
    }));
  });

  it("fills representative station info when running a real VXKO50 fixture through the pipeline", () => {
    const msg = createMockWsDataMessage("16_10_01_260312_VXKO50.xml");
    const info = parseFloodForecast(msg);
    expect(info).not.toBeNull();
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
    expect(update?.mode).toBe("replace");
    if (update?.mode !== "replace") return;

    const byKey = new Map(update.rivers.map((river) => [river.riverKey, river]));

    // 緑川: 現況 L4 の中甲橋 (4.62m ≥ 氾濫危険水位 4.60m) が代表。
    // 現況 L1 の城南 (3.63m, headline 由来で L4 candidate) は代表にならず、
    // 「氾濫危険水位 6.20m 超過」の虚偽断定を出さない。
    const midori = byKey.get("8909100001");
    expect(midori?.level).toBe("L4");
    expect(midori?.station?.name).toBe("中甲橋");
    expect(midori?.station?.levelM).toBe(4.62);
    expect(midori?.station?.thresholdLabel).toBe("氾濫危険水位 4.60m 超過");

    // 加勢川: 大六橋のみ、現況 L2 (3.67m)。river 全体は headline 由来で L4 だが、
    // 現況が L3 未満なので thresholdLabel は null (断定を避ける)。
    const kaseigawa = byKey.get("8909100051");
    expect(kaseigawa?.level).toBe("L4");
    expect(kaseigawa?.station?.name).toBe("大六橋");
    expect(kaseigawa?.station?.levelM).toBe(3.67);
    expect(kaseigawa?.station?.thresholdLabel).toBeNull();

    // 御船川: 御船が現況 L3 (3.91m ≥ 避難判断水位 3.60m)。現況レベルと整合する断定。
    const mifunegawa = byKey.get("8909100068");
    expect(mifunegawa?.level).toBe("L4");
    expect(mifunegawa?.station?.name).toBe("御船");
    expect(mifunegawa?.station?.levelM).toBe(3.91);
    expect(mifunegawa?.station?.thresholdLabel).toBe("避難判断水位 3.60m 超過");
  });
});
