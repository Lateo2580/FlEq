import { describe, it, expect } from "vitest";
import {
  flattenEntries,
  formatSeriesWindows,
  formatPeakBySeries,
  formatCriteriaTimeBySeries,
  partitionBySeverity,
  summarizeAdvisoryByPhenomenon,
  projectForecastOccurrences,
  vpwp50ForecastLabel,
  vpwp50StableKey,
} from "../../src/engine/presentation/weather-severity-pyramid";
import type {
  SeriesWindow,
  WeatherSeverityEntry,
} from "../../src/engine/presentation/weather-severity-pyramid";
import type {
  ParsedWeatherWarningTimeseriesInfo,
  WeatherWarningTimeseriesArea,
  WeatherWarningTimeseriesKind,
  SignificancyInfo,
  SignificancyValue,
  TimeWindow,
} from "../../src/types";
import { parseWeatherWarningTimeseries } from "../../src/dmdata/weather-warning-timeseries-parser";
import { classifySignificancyCode } from "../../src/dmdata/weather-warning-timeseries-significancy";
import {
  createMockWsDataMessage,
  FIXTURE_VPWP50_NAGANO,
  FIXTURE_VPWP50_CRITERIA_PERIOD,
  FIXTURE_VPWP50_HIGH_SEVERITY,
  FIXTURE_VPWP50_LOCAL_IDENTITY,
  readFixture,
} from "../helpers/mock-message";

interface Vpwp50ForecastExpectations {
  subjectKey: string;
  reportTimeMs: number;
  occurrence: {
    phenomenonName: string;
    significancyCode: string;
    timeRef: string;
    startsAt: string;
    endsAt: string;
    forecastLabel: string;
  };
  stableKeys: Record<"group" | "areaTarget" | "localTarget" | "period" | "pagerAnchor", string>;
  forecastLabels: [string, string, string][];
}

const forecastExpectations = JSON.parse(
  readFixture("vpwp50-forecast-expectations.json"),
) as Vpwp50ForecastExpectations;

describe("VPWP50 lossless forecast projection", () => {
  it("projects visible known and unknown siblings without collapsing code 21 and 22", () => {
    const parsed = parseWeatherWarningTimeseries(
      createMockWsDataMessage(FIXTURE_VPWP50_LOCAL_IDENTITY),
    );
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    const entries = projectForecastOccurrences(parsed);
    const sediment = entries.filter((entry) => entry.phenomenonName === "土砂災害危険度" && entry.local == null);
    expect(sediment.map((entry) => entry.significancy.code)).toEqual(["21", "22", "31", "99", "41"]);
    expect(sediment.map((entry) => entry.forecastLabel)).toEqual([
      "土砂災害（警戒レベル2）の予測",
      "土砂災害（警戒レベル2相当）の予測",
      "土砂災害（警戒レベル3相当）の予測",
      "土砂災害（区分不明）の予測",
      "土砂災害（警戒レベル4相当）の予測",
    ]);
    expect(entries.filter((entry) => entry.phenomenonName === "雷").map((entry) => entry.significancy.code)).toEqual(["20", "99"]);
  });

  it.each(forecastExpectations.forecastLabels)("uses the authoritative label for %s code %s", (name, code, expected) => {
    expect(vpwp50ForecastLabel(name, classifySignificancyCode(name, code))).toBe(expected);
  });

  it.each(["00", "01", "11"])("does not project non-visible code %s", (code) => {
    expect(vpwp50ForecastLabel("雨", classifySignificancyCode("雨", code))).toBeNull();
  });

  it("matches the static digest keys for group, target, period, and anchor", () => {
    const occurrence = forecastExpectations.occurrence;
    const group = vpwp50StableKey("group", [
      occurrence.phenomenonName, occurrence.significancyCode,
      occurrence.forecastLabel, "officialL2",
    ]);
    const areaTarget = vpwp50StableKey("target", [forecastExpectations.subjectKey, "area", "code:200010"]);
    expect(group).toBe(forecastExpectations.stableKeys.group);
    expect(areaTarget).toBe(forecastExpectations.stableKeys.areaTarget);
    expect(vpwp50StableKey("target", [forecastExpectations.subjectKey, "local", "code:200010", "code:L001"]))
      .toBe(forecastExpectations.stableKeys.localTarget);
    expect(vpwp50StableKey("period", [group, areaTarget, 1, "3h", occurrence.startsAt, occurrence.endsAt]))
      .toBe(forecastExpectations.stableKeys.period);
    expect(vpwp50StableKey("anchor", [forecastExpectations.subjectKey, forecastExpectations.reportTimeMs, "1", group, areaTarget, 0]))
      .toBe(forecastExpectations.stableKeys.pagerAnchor);
    for (const key of Object.values(forecastExpectations.stableKeys)) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("rejects unsupported stable-key component values at runtime", () => {
    expect(() => vpwp50StableKey("group", [Number.NaN])).toThrow();
    expect(() => vpwp50StableKey("group", [1.5])).toThrow();
  });
});

function makeEmptyInfo(): ParsedWeatherWarningTimeseriesInfo {
  return {
    infoType: "発表",
    targetArea: { name: "長野県", code: "200000" },
    areas: [],
    unknownCodes: [],
    maxKnownSignificancy: null,
    fallback: "none",
  } as unknown as ParsedWeatherWarningTimeseriesInfo;
}

function sigInfo(code: string, severity: "advisory" | "warning" | "special" = "warning"): SignificancyInfo {
  const compactMap: Record<string, string> = { "10": "注", "20": "警", "30": "特", "40": "L4" };
  return {
    code,
    known: true,
    rank: 0,
    family: "grade",
    label: `code-${code}`,
    compact: compactMap[code] ?? code,
    severity,
  };
}

function tw(startName: string, count: number, contiguous = true): TimeWindow {
  return { startName, endName: startName, count, contiguous };
}

function sigValue(
  code: string,
  severity: "advisory" | "warning" | "special",
  timeRef: string,
  window: TimeWindow,
): SignificancyValue {
  return {
    info: sigInfo(code, severity),
    timeRef,
    timeWindow: window,
  };
}

function kindSig(type: string, base: SignificancyValue): WeatherWarningTimeseriesKind {
  return {
    type,
    partKind: "Significancy",
    significancyWorst: { base },
  };
}

function area(
  name: string,
  code: string,
  kinds1: WeatherWarningTimeseriesKind[] = [],
  kinds2: WeatherWarningTimeseriesKind[] = [],
  kinds3: WeatherWarningTimeseriesKind[] = [],
): WeatherWarningTimeseriesArea {
  return { name, code, kinds: { 1: kinds1, 2: kinds2, 3: kinds3 } };
}

function makeInfoWithAreas(areas: WeatherWarningTimeseriesArea[]): ParsedWeatherWarningTimeseriesInfo {
  return {
    infoType: "発表",
    targetArea: { name: "長野県", code: "200000" },
    areas,
    unknownCodes: [],
    maxKnownSignificancy: null,
    fallback: "none",
  } as unknown as ParsedWeatherWarningTimeseriesInfo;
}

describe("flattenEntries", () => {
  it("空 areas でも例外を投げず空配列を返す", () => {
    const result = flattenEntries(makeEmptyInfo());
    expect(result).toEqual([]);
  });

  it("単一 area の base のみ — kind 1 件を 1 entry / 1 window として返す", () => {
    const areas = [
      area("北部", "200010", [
        kindSig("大雨", sigValue("20", "warning", "t1", tw("22日朝", 1))),
      ]),
    ];
    const result = flattenEntries(makeInfoWithAreas(areas));
    expect(result).toHaveLength(1);
    expect(result[0].phenomenon).toBe("大雨");
    expect(result[0].areaName).toBe("北部");
    expect(result[0].code).toBe("20");
    expect(result[0].severity).toBe("warning");
    expect(result[0].windows).toHaveLength(1);
    expect(result[0].windows[0].series).toBe("3h");
    expect(result[0].windows[0].timeRef).toBe("t1");
  });

  it("3h と 24h の同 (種別,地域,Code) は 1 entry / windows=2 に保持 (合算しない)", () => {
    const areas = [
      area(
        "北部",
        "200010",
        [kindSig("大雨", sigValue("20", "warning", "t1", tw("22日朝", 2)))],
        [kindSig("大雨", sigValue("20", "warning", "t2", tw("22日", 1)))],
      ),
    ];
    const result = flattenEntries(makeInfoWithAreas(areas));
    expect(result).toHaveLength(1);
    expect(result[0].windows).toHaveLength(2);
    expect(result[0].windows.find((w) => w.series === "3h")?.window?.count).toBe(2);
    expect(result[0].windows.find((w) => w.series === "24h")?.window?.count).toBe(1);
  });

  it("severity が below/none の Significancy は pyramid 対象外として skip する", () => {
    const info = {
      infoType: "発表",
      targetArea: { name: "長野県", code: "200000" },
      areas: [
        {
          name: "北部",
          code: "200010",
          kinds: {
            1: [
              {
                type: "大雨",
                partKind: "Significancy",
                significancyWorst: {
                  base: {
                    info: { code: "00", compact: "解除", label: "解除", known: true, severity: "below" },
                    timeRef: "1",
                    timeWindow: { startName: "朝", endName: "朝", count: 1, contiguous: true },
                  },
                  locals: [],
                },
              },
            ],
            2: [],
            3: [],
          },
        },
      ],
      unknownCodes: [],
      maxKnownSignificancy: null,
      fallback: "none",
    } as never;

    expect(flattenEntries(info)).toEqual([]);
  });
});

describe("formatSeriesWindows", () => {
  it("空配列なら null", () => {
    expect(formatSeriesWindows([])).toBeNull();
  });

  it("1 window のみ — prefix なしで startName を返す", () => {
    const w: SeriesWindow = {
      series: "3h",
      timeRef: "t1",
      window: { startName: "22日朝", endName: "22日朝", count: 1, contiguous: true },
      tsNum: 1,
    };
    expect(formatSeriesWindows([w])).toBe("22日朝");
  });

  it("複数 window — 自動で series prefix が付く", () => {
    const ws: SeriesWindow[] = [
      {
        series: "3h",
        timeRef: "t1",
        window: { startName: "22日朝", endName: "22日昼", count: 2, contiguous: true },
        tsNum: 1,
      },
      {
        series: "24h",
        timeRef: "t2",
        window: { startName: "22日", endName: "22日", count: 1, contiguous: true },
        tsNum: 2,
      },
    ];
    expect(formatSeriesWindows(ws)).toBe("3h:22日朝-22日昼(2枠) / 24h:22日");
  });
});

describe("formatPeakBySeries", () => {
  it("peak なしなら null", () => {
    const w: SeriesWindow = { series: "3h", timeRef: "t1", tsNum: 1 };
    expect(formatPeakBySeries([w])).toBeNull();
  });

  it("単一 peak — デフォルト alwaysPrefix=false で prefix なし", () => {
    const w: SeriesWindow = {
      series: "3h",
      timeRef: "t1",
      peak: { date: "22日", term: "朝" },
      tsNum: 1,
    };
    expect(formatPeakBySeries([w])).toBe("22日朝");
  });

  it("単一 peak でも alwaysPrefix=true なら prefix が付く", () => {
    const w: SeriesWindow = {
      series: "3h",
      timeRef: "t1",
      peak: { date: "22日", term: "朝" },
      tsNum: 1,
    };
    expect(formatPeakBySeries([w], true)).toBe("3h:22日朝");
  });

  it("複数 peak は alwaysPrefix=false でも自動で prefix が付く", () => {
    const ws: SeriesWindow[] = [
      { series: "3h", timeRef: "t1", peak: { date: "22日", term: "朝" }, tsNum: 1 },
      { series: "24h", timeRef: "t2", peak: { date: "22日", term: "昼前" }, tsNum: 2 },
    ];
    expect(formatPeakBySeries(ws)).toBe("3h:22日朝 / 24h:22日昼前");
  });
});

describe("formatCriteriaTimeBySeries", () => {
  it("criteriaPeriod なしなら null", () => {
    const w: SeriesWindow = { series: "3h", timeRef: "t1", tsNum: 1 };
    expect(formatCriteriaTimeBySeries([w])).toBeNull();
  });

  it("単一 criteria — デフォルトで prefix なし", () => {
    const w: SeriesWindow = {
      series: "3h",
      timeRef: "t1",
      criteriaPeriod: {
        sentence: "x",
        criteriaClass: "土砂災害警戒レベル4相当",
        time: "2026-06-22T03:00:00+09:00",
        duration: "PT4H",
      },
      tsNum: 1,
    };
    expect(formatCriteriaTimeBySeries([w])).toBe("22 03:00");
  });

  it("単一でも alwaysPrefix=true なら prefix が付く", () => {
    const w: SeriesWindow = {
      series: "3h",
      timeRef: "t1",
      criteriaPeriod: {
        sentence: "x",
        criteriaClass: "土砂災害警戒レベル4相当",
        time: "2026-06-22T03:00:00+09:00",
        duration: "PT4H",
      },
      tsNum: 1,
    };
    expect(formatCriteriaTimeBySeries([w], true)).toBe("3h:22 03:00");
  });
});

function entry(
  severity: "special" | "warning" | "advisory" | "unknown",
  phenomenon: string,
): WeatherSeverityEntry {
  const severityToDisplaySeverity = {
    special: "nonLevelSpecial",
    warning: "nonLevelWarning",
    advisory: "nonLevelAdvisory",
    unknown: "unknown",
  } as const;
  const displaySeverity = severityToDisplaySeverity[severity];
  return {
    id: `${phenomenon}|北部|${displaySeverity}|30|`,
    phenomenon,
    kindLabel: `${phenomenon}${severity}`,
    severity,
    areaName: "北部",
    code: "30",
    windows: [],
    propertyType: phenomenon,
    localAreaNames: [],
    unknownCodes: [],
    worstCode: "30",
    localKey: "",
    displaySeverity,
    officialAlertLevel: null,
    resolutionSource: "map",
  };
}

describe("partitionBySeverity", () => {
  it("空配列は 4 区分すべて空", () => {
    const p = partitionBySeverity([]);
    expect(p.special).toEqual([]);
    expect(p.warning).toEqual([]);
    expect(p.advisory).toEqual([]);
    expect(p.unknown).toEqual([]);
  });

  it("special / warning / advisory / unknown を 1 件ずつ振り分け", () => {
    const list = [
      entry("special", "大雨"),
      entry("warning", "大雨"),
      entry("advisory", "雷"),
      entry("unknown", "?99"),
    ];
    const p = partitionBySeverity(list);
    expect(p.special).toHaveLength(1);
    expect(p.warning).toHaveLength(1);
    expect(p.advisory).toHaveLength(1);
    expect(p.unknown).toHaveLength(1);
    expect(p.special[0].phenomenon).toBe("大雨");
    expect(p.advisory[0].phenomenon).toBe("雷");
  });
});

describe("summarizeAdvisoryByPhenomenon", () => {
  it("空配列なら空配列", () => {
    expect(summarizeAdvisoryByPhenomenon([])).toEqual([]);
  });

  it("phenomenon ごとに distinct areaName をカウントし、count 降順 → phenomenon localeCompare で sort", () => {
    const mk = (phenomenon: string, areaName: string, code: string): WeatherSeverityEntry => ({
      id: `${phenomenon}|${areaName}|nonLevelAdvisory|${code}|`,
      phenomenon,
      kindLabel: `${phenomenon}注意報`,
      severity: "advisory",
      areaName,
      code,
      windows: [],
      propertyType: phenomenon,
      localAreaNames: [],
      unknownCodes: [],
      worstCode: code,
      localKey: "",
      displaySeverity: "nonLevelAdvisory",
      officialAlertLevel: null,
      resolutionSource: "map",
    });
    const advisory: WeatherSeverityEntry[] = [
      mk("大雨", "北部", "10"),
      mk("雷", "北部", "14"),
      mk("雷", "中部", "14"),
      mk("雷", "南部", "14"),
      // 同じ phenomenon + 同じ areaName は distinct で 1 件扱い
      mk("雷", "北部", "14"),
    ];
    const result = summarizeAdvisoryByPhenomenon(advisory);
    expect(result).toEqual([
      { phenomenon: "雷", count: 3 },
      { phenomenon: "大雨", count: 1 },
    ]);
  });
});

describe("WeatherSeverityEntry.id + flattenEntries v3.2", () => {
  it("各 entry に id フィールドがある (実 fixture)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseWeatherWarningTimeseries(msg)!;
    const entries = flattenEntries(info);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.id).toBeDefined();
      expect(e.id.length).toBeGreaterThan(0);
      // id は組み立て規則 "propertyType|areaName|displaySeverity|worstCode|localKey" に従う (Phase B)
      expect(e.id).toBe(
        `${e.propertyType}|${e.areaName}|${e.displaySeverity}|${e.worstCode}|${e.localKey}`,
      );
    }
  });

  it("同一 propertyType + areaName + severity でも Code 違いで id が異なる (synthetic)", () => {
    // 同一 area に Code 30 (warning) と Code 41 (warning) を並べ、両 entry の id が unique であることを確認。
    const areas = [
      area(
        "北部",
        "200010",
        [
          kindSig("大雨", sigValue("30", "warning", "t1", tw("22日朝", 1))),
          kindSig("土砂災害", sigValue("41", "warning", "t2", tw("22日昼", 1))),
        ],
      ),
    ];
    const entries = flattenEntries(makeInfoWithAreas(areas));
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 念のため両 entry が含まれる
    expect(ids.some((id) => id.endsWith("|30|"))).toBe(true);
    expect(ids.some((id) => id.endsWith("|41|"))).toBe(true);
  });

  it("Base entry の localAreaNames に Local 一覧が入る (synthetic: base + locals 同居)", () => {
    // 同 kind.type "高潮危険度" に Base + Local 2件 (稚内海岸/礼文海岸) を同居させる。
    const baseValue = sigValue("41", "warning", "t1", tw("5日夜", 1));
    const localA = sigValue("41", "warning", "tA", tw("5日夜", 1));
    const localB = sigValue("31", "warning", "tB", tw("5日夜", 1));
    const kindWithLocals: WeatherWarningTimeseriesKind = {
      type: "高潮危険度",
      partKind: "Significancy",
      significancyWorst: {
        base: baseValue,
        locals: [
          { areaName: "稚内海岸", value: localA },
          { areaName: "礼文海岸", value: localB },
        ],
      },
    };
    const areas = [area("稚内市", "0121400", [kindWithLocals])];
    const entries = flattenEntries(makeInfoWithAreas(areas));

    const baseEntry = entries.find(
      (e) => e.propertyType === "高潮危険度" && e.localKey === "",
    );
    expect(baseEntry).toBeDefined();
    expect(baseEntry!.areaName).toBe("稚内市");
    expect(baseEntry!.localAreaNames).toEqual(
      expect.arrayContaining(["稚内海岸", "礼文海岸"]),
    );
    expect(baseEntry!.localAreaNames.length).toBe(2);
  });

  it("Local entry は localKey が空文字でない (実 fixture: CRITERIA_PERIOD)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_CRITERIA_PERIOD);
    const info = parseWeatherWarningTimeseries(msg)!;
    const entries = flattenEntries(info);
    const localEntries = entries.filter((e) => e.areaName.includes("/"));
    expect(localEntries.length).toBeGreaterThan(0);
    for (const e of localEntries) {
      expect(e.localKey).not.toBe("");
      // localKey は areaName の "/" 後ろ部分と一致する
      const afterSlash = e.areaName.split("/")[1];
      expect(e.localKey).toBe(afterSlash);
    }
    // Base 由来 (areaName に "/" 無し) は localKey === ""
    const baseEntries = entries.filter((e) => !e.areaName.includes("/"));
    for (const e of baseEntries) {
      expect(e.localKey).toBe("");
    }
  });

  it("SeriesWindow.tsNum が 1/2/3 のいずれか (実 fixture)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_NAGANO);
    const info = parseWeatherWarningTimeseries(msg)!;
    const entries = flattenEntries(info);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      for (const w of e.windows) {
        expect([1, 2, 3]).toContain(w.tsNum);
        // tsNum と series の対応一致を確認 (1->3h, 2->24h, 3->day)
        const expected = w.tsNum === 1 ? "3h" : w.tsNum === 2 ? "24h" : "day";
        expect(w.series).toBe(expected);
      }
    }
  });

  it("propertyType / worstCode / unknownCodes が充填される", () => {
    // 既知 Code (warning 30) と未知 Code (99) を同 area に並べる
    const unknownInfo: SignificancyInfo = {
      code: "99",
      known: false,
      rank: 999,
      family: "grade",
      label: "未知Code 99",
      compact: "?99",
      severity: "unknown",
    };
    const unknownValue: SignificancyValue = {
      info: unknownInfo,
      timeRef: "t9",
      timeWindow: tw("22日夜", 1),
    };
    const areas = [
      area(
        "北部",
        "200010",
        [
          kindSig("大雨", sigValue("30", "warning", "t1", tw("22日朝", 1))),
          {
            type: "未知",
            partKind: "Significancy",
            significancyWorst: { base: unknownValue },
          },
        ],
      ),
    ];
    const entries = flattenEntries(makeInfoWithAreas(areas));
    const known = entries.find((e) => e.code === "30");
    const unknown = entries.find((e) => e.code === "99");
    expect(known).toBeDefined();
    expect(known!.propertyType).toBe("大雨");
    expect(known!.worstCode).toBe("30");
    expect(known!.unknownCodes).toEqual([]);
    expect(unknown).toBeDefined();
    expect(unknown!.propertyType).toBe("未知");
    expect(unknown!.worstCode).toBe("99");
    expect(unknown!.unknownCodes).toEqual(["99"]);
    expect(unknown!.severity).toBe("unknown");
  });
});

describe("WeatherSeverityEntry の 2 系統フィールド (Phase B)", () => {
  const info = (): ParsedWeatherWarningTimeseriesInfo =>
    parseWeatherWarningTimeseries(createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY))!;

  it("alertLevel 系 entry: displaySeverity=officialLN + officialAlertLevel", () => {
    const official = flattenEntries(info()).filter((e) => e.officialAlertLevel != null);
    expect(official.length).toBeGreaterThan(0);
    for (const e of official) {
      expect(e.displaySeverity).toBe(`officialL${e.officialAlertLevel}`);
      expect(e.resolutionSource).toBe("map");
    }
  });

  it("grade 系 entry: nonLevel* + officialAlertLevel=null / 全 entry が displaySeverity を持つ", () => {
    for (const e of flattenEntries(info())) {
      expect(e.displaySeverity).toBeDefined();
      if (e.displaySeverity.startsWith("nonLevel")) expect(e.officialAlertLevel).toBeNull();
    }
  });

  it("entry id は displaySeverity を含む (stable id の 2 系統化)", () => {
    const e = flattenEntries(info())[0];
    expect(e.id).toContain(e.displaySeverity);
  });

  it("maxDisplaySeverity invariant: info の maxDisplaySeverity はいずれかの entry の displaySeverity に一致する (high_severity fixture)", () => {
    // Task 1 委譲 invariant: 表示母集団と代表が一致しなければバナー収集が空になる
    const parsed = info();
    expect(parsed.maxDisplaySeverity).not.toBeNull();
    const entries = flattenEntries(parsed);
    expect(entries.some((e) => e.displaySeverity === parsed.maxDisplaySeverity)).toBe(true);
  });
});
