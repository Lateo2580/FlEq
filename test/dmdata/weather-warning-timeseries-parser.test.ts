import { describe, it, expect } from "vitest";
import {
  createMockWsDataMessage,
  FIXTURE_VPWP50_SOYA_01,
  FIXTURE_VPWP50_SOYA_02,
  FIXTURE_VPWP50_SOYA_03,
  FIXTURE_VPWP50_SOYA_04,
  FIXTURE_VPWP50_HIGH_SEVERITY,
  FIXTURE_VPWP50_UNKNOWN_CODE,
  FIXTURE_VPWP50_CANCEL,
  FIXTURE_VPWP50_HEAD_MISSING,
  FIXTURE_VPWP50_CRITERIA_PERIOD,
  FIXTURE_VPWP50_LOCAL_AREA,
  FIXTURE_VPWP50_CRITERIA_PROPERTY_SIBLING,
  FIXTURE_VPWP50_LOCAL_IDENTITY,
  createMockWsDataMessageFromXml,
  readFixture,
} from "../helpers/mock-message";
import { parseWeatherWarningTimeseries } from "../../src/dmdata/weather-warning-timeseries-parser";
import {
  classifySignificancyCode,
  pickWorstKnownSignificancy,
} from "../../src/dmdata/weather-warning-timeseries-significancy";
import { parseStrictElapsedDuration } from "../../src/dmdata/timeseries-common";
import { weatherWarningTimeseriesFrameLevel } from "../../src/engine/presentation/level-helpers";

describe("VPWP50 strict elapsed duration", () => {
  it.each([
    ["PT0S", null],
    ["PT3H", 3 * 60 * 60_000],
    ["P1DT2H30M", (24 * 60 + 2 * 60 + 30) * 60_000],
    ["P1DT", null],
    ["P1D", 24 * 60 * 60_000],
    ["PT", null],
    ["PT1.5H", null],
    ["-PT1H", null],
  ] as const)("parses only the bounded XSD duration subset: %s", (input, expected) => {
    expect(parseStrictElapsedDuration(input)).toBe(expected);
  });
});

describe("VPWP50 forecast occurrence / identity projection", () => {
  it("retains every Significancy occurrence and leaves ambiguous or invalid slots unresolved", () => {
    const info = parseWeatherWarningTimeseries(
      createMockWsDataMessage(FIXTURE_VPWP50_LOCAL_IDENTITY),
    );
    expect(info).not.toBeNull();
    if (info == null) return;
    const north = info.areas.find((area) => area.identityKey === "code:200010");
    expect(north?.name).toBe("長野県 北部");
    const sediment = north?.kinds[1].find((kind) => kind.type === "土砂災害危険度");
    expect(sediment?.significancyOccurrences?.base?.map((entry) => entry.info.code)).toEqual([
      "21", "22", "31", "99", "41",
    ]);
    expect(sediment?.significancyOccurrences?.base?.map((entry) => entry.slot == null)).toEqual([
      false, false, true, true, true,
    ]);
    expect(sediment?.significancyOccurrences?.base?.[0]?.slot).toMatchObject({
      series: "3h",
      startsAt: "2026-06-06T00:00:00.000Z",
      endsAt: "2026-06-06T03:00:00.000Z",
      name: "６日 昼前",
    });
  });

  it("keeps code, code-less, and parent-scoped identities distinct while excluding conflicts", () => {
    const info = parseWeatherWarningTimeseries(
      createMockWsDataMessage(FIXTURE_VPWP50_LOCAL_IDENTITY),
    );
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(info.areas.map((area) => area.identityKey).sort()).toEqual([
      "code:200010", "code:200020", "name:長野県 北部",
    ]);
    const north = info.areas.find((area) => area.identityKey === "code:200010");
    const locals = north?.kinds[1]
      .flatMap((kind) => kind.significancyOccurrences?.locals ?? [])
      .map((local) => local.identityKey);
    expect(locals).toEqual(["code:L001", "name:沿岸 東部"]);
    expect(north?.kinds[1]
      .flatMap((kind) => kind.significancyOccurrences?.locals ?? [])
      .find((local) => local.identityKey === "code:L001")?.value).toHaveLength(1);
    expect(locals).not.toContain("code:L002");
    const otherParent = info.areas.find((area) => area.identityKey === "code:200020");
    expect(otherParent?.kinds[1].flatMap((kind) =>
      kind.significancyOccurrences?.locals ?? []).map((local) => local.identityKey)).toEqual(["code:L001"]);
    expect(info.maxKnownSignificancy?.code).toBe("41");
    expect(info.unknownCodes.map((entry) => entry.code)).not.toContain("98");
  });

  it("combines same-type occurrence collections across duplicate Area items", () => {
    const xml = readFixture(FIXTURE_VPWP50_LOCAL_IDENTITY).replace(
      "<Kind><Property><Type>雨</Type><SignificancyPart><Base>",
      "<Kind><Property><Type> 土砂災害危険度 </Type><SignificancyPart><Base>",
    );
    const info = parseWeatherWarningTimeseries(
      createMockWsDataMessageFromXml(xml, "VPWP50"),
    );
    expect(info).not.toBeNull();
    if (info == null) return;
    const north = info.areas.find((area) => area.identityKey === "code:200010");
    const sediment = north?.kinds[1].filter((kind) => kind.type === "土砂災害危険度");
    expect(sediment).toHaveLength(2);
    expect(sediment?.[0]?.significancyOccurrences?.base?.map((entry) => entry.info.code))
      .toEqual(["21", "22", "31", "99", "41", "30"]);
    expect(sediment?.[1]?.significancyOccurrences).toBeUndefined();
  });
});

describe("weather-warning-timeseries-parser (実物 fixture)", () => {
  it("実物 #1 (宗谷 #1) をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_SOYA_01);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(info.type).toBe("VPWP50");
    expect(info.title).toContain("宗谷");
    expect(info.controlTitle).toContain("気象警報・注意報時系列情報");
    expect(info.areas.length).toBeGreaterThan(0);
    expect(info.fallback).toBe("none");
  });

  it("実物 #1 で Code 11 (警戒レベル2未満) が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_SOYA_01);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    // 全 Area で低 severity (Code 00/01/11 のみ) のはず
    expect(info.maxKnownSignificancy).not.toBeNull();
    expect(info.maxKnownSignificancy?.known).toBe(true);
    expect(info.unknownCodes).toHaveLength(0);
  });

  it("実物 #1 に Local 階層が含まれる (濃霧/風/潮位)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_SOYA_01);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    // どこかの Area の Kind に locals があるはず
    const hasLocals = info.areas.some((a) =>
      [a.kinds[1], a.kinds[2], a.kinds[3]].some((kinds) =>
        kinds.some(
          (k) =>
            (k.significancyWorst?.locals && k.significancyWorst.locals.length > 0) ||
            (k.quantitativeWorst?.locals && k.quantitativeWorst.locals.length > 0) ||
            (k.windWorst?.locals && k.windWorst.locals.length > 0),
        ),
      ),
    );
    expect(hasLocals).toBe(true);
  });

  it.each([
    ["#2", FIXTURE_VPWP50_SOYA_02],
    ["#3", FIXTURE_VPWP50_SOYA_03],
    ["#4", FIXTURE_VPWP50_SOYA_04],
  ])("実物 %s をパースできる", (_, fixture) => {
    const msg = createMockWsDataMessage(fixture);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(info.type).toBe("VPWP50");
    expect(info.areas.length).toBeGreaterThan(0);
  });
});

describe("classifySignificancyCode (公式 11 Code + 未知)", () => {
  it.each([
    ["00", "none", "none", 0, true],
    ["01", "grade", "below", 1, true],
    ["11", "alertLevel", "below", 1, true],
    ["20", "grade", "advisory", 2, true],
    ["21", "alertLevel", "advisory", 2, true],
    ["22", "alertLevel", "advisory", 2, true],
    ["30", "grade", "warning", 3, true],
    ["31", "alertLevel", "warning", 3, true],
    ["41", "alertLevel", "warning", 4, true],
    ["50", "grade", "special", 5, true],
    ["51", "alertLevel", "special", 5, true],
  ])(
    "Code %s → family=%s severity=%s rank=%s known=%s",
    (code, family, severity, rank, known) => {
      const info = classifySignificancyCode("土砂災害", code);
      expect(info.family).toBe(family);
      expect(info.severity).toBe(severity);
      expect(info.rank).toBe(rank);
      expect(info.known).toBe(known);
    },
  );

  it("未知 Code 99 は unknown 扱い + 表示 ?99 + rank 999", () => {
    const info = classifySignificancyCode("土砂災害", "99");
    expect(info.known).toBe(false);
    expect(info.family).toBe("unknown");
    expect(info.severity).toBe("unknown");
    expect(info.rank).toBe(999);
    expect(info.compact).toBe("?99");
    expect(info.label).toContain("99");
  });

  it("未知 Code 12 (推測補完禁止) も unknown 扱い", () => {
    const info = classifySignificancyCode("大雨", "12");
    expect(info.known).toBe(false);
    expect(info.compact).toBe("?12");
  });
});

describe("pickWorstKnownSignificancy (未知 Code 除外)", () => {
  it("既知のみで rank 最大を選ぶ", () => {
    const candidates = [
      classifySignificancyCode("X", "11"),
      classifySignificancyCode("X", "30"),
      classifySignificancyCode("X", "21"),
    ];
    const worst = pickWorstKnownSignificancy(candidates);
    expect(worst?.code).toBe("30");
    expect(worst?.rank).toBe(3);
  });

  it("未知 Code (rank 999) が混じっても無視して既知から選ぶ", () => {
    const candidates = [
      classifySignificancyCode("X", "30"),
      classifySignificancyCode("X", "99"), // rank 999 だが known=false
      classifySignificancyCode("X", "21"),
    ];
    const worst = pickWorstKnownSignificancy(candidates);
    expect(worst?.code).toBe("30");
    expect(worst?.known).toBe(true);
  });

  it("全て未知なら null", () => {
    const candidates = [
      classifySignificancyCode("X", "99"),
      classifySignificancyCode("X", "12"),
    ];
    expect(pickWorstKnownSignificancy(candidates)).toBeNull();
  });

  it("空配列なら null", () => {
    expect(pickWorstKnownSignificancy([])).toBeNull();
  });

  it("同 rank なら severity 優先 (special > warning)", () => {
    const candidates = [
      classifySignificancyCode("X", "30"),
      classifySignificancyCode("X", "31"),
    ];
    const worst = pickWorstKnownSignificancy(candidates);
    expect(worst?.severity).toBe("warning");
  });
});

describe("R1 #2: TimeDefineMap 活用 (worst の時刻幅 + 連続/非連続)", () => {
  it("土砂 (Code 41) 連続枠 (refID 1-2) で timeWindow.contiguous=true, count=2", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const dosha = info.areas[0]?.kinds[1].find(
      (k) => k.type === "土砂災害危険度",
    );
    const w = dosha?.significancyWorst?.base?.timeWindow;
    expect(w).toBeDefined();
    expect(w?.count).toBe(2);
    expect(w?.contiguous).toBe(true);
    expect(w?.startName).toBe("夜のはじめ頃");
    expect(w?.endName).toBe("夜遅く");
  });

  it("大雨浸水 (Code 50 単独) で timeWindow.count=1", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const ooame = info.areas[0]?.kinds[1].find(
      (k) => k.type === "大雨浸水危険度",
    );
    const w = ooame?.significancyWorst?.base?.timeWindow;
    expect(w?.count).toBe(1);
    expect(w?.startName).toBe("夜のはじめ頃");
  });

  it("Precipitation 数値系 (worst 80mm) も timeWindow を持つ", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const precip = info.areas[0]?.kinds[1].find(
      (k) => k.partKind === "Precipitation",
    );
    expect(precip?.quantitativeWorst?.base?.timeWindow?.count).toBe(1);
    expect(precip?.quantitativeWorst?.base?.timeWindow?.startName).toBe(
      "夜のはじめ頃",
    );
  });
});

describe("R1 #1 / R2 Info #3: CriteriaPeriod が Property 直下兄弟形状でも拾える", () => {
  it("Property 直下 CriteriaPeriod が Significancy にペアで保持される", () => {
    const msg = createMockWsDataMessage(
      FIXTURE_VPWP50_CRITERIA_PROPERTY_SIBLING,
    );
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const dosha = info.areas[0]?.kinds[1].find(
      (k) => k.type === "土砂災害危険度",
    );
    expect(dosha?.significancyWorst?.base?.criteriaPeriod).toBeDefined();
    expect(dosha?.significancyWorst?.base?.criteriaPeriod?.sentence).toContain(
      "Property 直下兄弟形",
    );
  });

  it("CriteriaClass nest 形 (<Name>/<Code>) が `name (code)` で取れる [R1 #3]", () => {
    const msg = createMockWsDataMessage(
      FIXTURE_VPWP50_CRITERIA_PROPERTY_SIBLING,
    );
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const dosha = info.areas[0]?.kinds[1].find(
      (k) => k.type === "土砂災害危険度",
    );
    const cls = dosha?.significancyWorst?.base?.criteriaPeriod?.criteriaClass;
    expect(cls).toContain("土砂災害警戒レベル4相当");
    expect(cls).toContain("41");
  });
});

describe("R1 #11: special は critical に昇格 (計画 GO 反映済)", () => {
  it("高 severity (Code 50) で frame level = critical", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("critical");
  });
});

describe("人工 fixture: 高 severity (Code 30/41/50 + PeakTime)", () => {
  it("最大は Code 50 (特別警報級) + frame level critical", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(info.maxKnownSignificancy?.code).toBe("50");
    expect(info.maxKnownSignificancy?.severity).toBe("special");
    expect(info.unknownCodes).toHaveLength(0);
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("critical");
  });

  it("PeakTime が Significancy にペアで保持される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const hasPeak = info.areas.some((a) =>
      [a.kinds[1], a.kinds[2], a.kinds[3]].some((kinds) =>
        kinds.some(
          (k) => k.significancyWorst?.base?.peak != null,
        ),
      ),
    );
    expect(hasPeak).toBe(true);
  });

  it("数値系 (Precipitation higherIsWorse) が 80mm worst として抽出", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const precip = info.areas[0]?.kinds[1].find(
      (k) => k.partKind === "Precipitation",
    );
    expect(precip?.quantitativeWorst?.base?.value).toBe(80);
    expect(precip?.metricMeta?.direction).toBe("higherIsWorse");
  });
});

describe("Phase B: maxDisplaySeverity / maxDisplayRankSignificancy 導出", () => {
  it("maxDisplaySeverity は DISPLAY_SEVERITY_RANK で選ぶ (rank 比較と逆転するケース)", () => {
    // high_severity fixture の実態 (実読確認済み 2026-06-11): 土砂災害危険度 Property に 41/41/31、
    // 大雨浸水危険度 Property に 50/30/20。rank 比較なら 50 (rank5) が勝つが、
    // display rank では officialL4 (90) > nonLevelSpecial (85) なので officialL4 が代表
    const info = parseWeatherWarningTimeseries(
      createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY),
    )!;
    expect(info.maxDisplaySeverity).toBe("officialL4");
    expect(info.maxDisplayRankSignificancy?.code).toBe("41");
  });

  it("maxDisplaySeverity: 取消電文では null (literal 構築パスの漏れ検出)", () => {
    const info = parseWeatherWarningTimeseries(
      createMockWsDataMessage(FIXTURE_VPWP50_CANCEL),
    )!;
    expect(info.infoType).toBe("取消");
    expect(info.maxDisplaySeverity).toBeNull();
    expect(info.maxDisplayRankSignificancy).toBeNull();
    expect(info.maxSoundLevel).toBeNull();
  });

  // 2026-06-12 共存エッジ解消: 音は maxDisplaySeverity (1 点代表) と独立の集合ベース。
  // high_severity fixture は 41 (officialL4 → 音 warning) と 50 (nonLevelSpecial → 音 critical)
  // が共存するため、表示代表は officialL4 のまま音は critical (特別警報側が勝つ)
  it("maxSoundLevel: 41+50 共存で critical (rank 代表 officialL4 に潰されない)", () => {
    const info = parseWeatherWarningTimeseries(
      createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY),
    )!;
    expect(info.maxDisplaySeverity).toBe("officialL4");
    expect(info.maxSoundLevel).toBe("critical");
  });
});

describe("人工 fixture: unknown_code (本体最大と分離保持)", () => {
  it("既知 Code 31 が maxKnownSignificancy、未知 99 と 12 は unknownCodes へ", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_UNKNOWN_CODE);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(info.maxKnownSignificancy?.code).toBe("31");
    expect(info.maxKnownSignificancy?.known).toBe(true);
    const codes = info.unknownCodes.map((u) => u.code);
    expect(codes).toContain("99");
    expect(codes).toContain("12");
  });

  it("未知 Code 含むため frame level = warning に昇格", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_UNKNOWN_CODE);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("warning");
  });

  it("未知 Code には propertyType と areaName が紐づく", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_UNKNOWN_CODE);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const u99 = info.unknownCodes.find((u) => u.code === "99");
    expect(u99?.propertyType).toBe("大雨浸水危険度");
    expect(u99?.areaName).toBe("稚内市");
  });
});

describe("人工 fixture: cancel (取消)", () => {
  it("InfoType=取消、areas 空、frame level = cancel", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_CANCEL);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    expect(info.infoType).toBe("取消");
    expect(info.areas).toHaveLength(0);
    expect(info.maxKnownSignificancy).toBeNull();
    expect(weatherWarningTimeseriesFrameLevel(info)).toBe("cancel");
  });
});

describe("人工 fixture: head_missing (null fallback)", () => {
  it("Head 欠落で parser は null を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HEAD_MISSING);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).toBeNull();
  });
});

describe("人工 fixture: criteria_period (Local + PeakTime 同居)", () => {
  it("土砂 CriteriaPeriod が Base に保持される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_CRITERIA_PERIOD);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const dosha = info.areas[0]?.kinds[1].find(
      (k) => k.type === "土砂災害危険度",
    );
    expect(dosha?.significancyWorst?.base?.criteriaPeriod).toBeDefined();
    expect(dosha?.significancyWorst?.base?.criteriaPeriod?.criteriaClass).toContain(
      "土砂",
    );
  });

  it("高潮 Local (稚内海岸 + 礼文海岸) が階層保持される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_CRITERIA_PERIOD);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const koshio = info.areas[0]?.kinds[1].find(
      (k) => k.type === "高潮危険度",
    );
    expect(koshio?.significancyWorst?.locals).toBeDefined();
    expect(koshio?.significancyWorst?.locals?.length).toBeGreaterThanOrEqual(2);
    const localNames = koshio?.significancyWorst?.locals?.map(
      (l) => l.areaName,
    );
    expect(localNames).toContain("稚内海岸");
    expect(localNames).toContain("礼文海岸");
  });

  it("稚内海岸 Local の CriteriaPeriod が保持される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_CRITERIA_PERIOD);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const koshio = info.areas[0]?.kinds[1].find(
      (k) => k.type === "高潮危険度",
    );
    const wakkanai = koshio?.significancyWorst?.locals?.find(
      (l) => l.areaName === "稚内海岸",
    );
    expect(wakkanai?.value.criteriaPeriod).toBeDefined();
    expect(wakkanai?.value.criteriaPeriod?.criteriaClass).toContain("高潮");
  });
});

describe("人工 fixture: local_area (風速 + 視程 + 湿度 worst 方向)", () => {
  it("風速 Local (陸上 15m/s / 海上 25m/s) が paired 形で保持", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_LOCAL_AREA);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const wind = info.areas[0]?.kinds[1].find(
      (k) => k.partKind === "WindPaired",
    );
    expect(wind?.windWorst?.locals).toBeDefined();
    const kaijou = wind?.windWorst?.locals?.find((l) => l.areaName === "海上");
    expect(kaijou?.value.speed).toBe(25);
    expect(kaijou?.value.direction).toBe("西南西"); // WindSpeed 最大時の WindDirection
  });

  it("視程 Local が lowerIsWorse で worst (陸上 100m / 海上 50m) を抽出", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_LOCAL_AREA);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const visibility = info.areas[0]?.kinds[1].find(
      (k) => k.partKind === "Visibility",
    );
    expect(visibility?.metricMeta?.direction).toBe("lowerIsWorse");
    const rikujou = visibility?.quantitativeWorst?.locals?.find(
      (l) => l.areaName === "陸上",
    );
    const kaijou = visibility?.quantitativeWorst?.locals?.find(
      (l) => l.areaName === "海上",
    );
    expect(rikujou?.value.value).toBe(100); // 最小 (worst)
    expect(kaijou?.value.value).toBe(50);   // さらに最小
  });

  it("湿度 (lowerIsWorse) で最小 25% を worst として抽出", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_LOCAL_AREA);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info).not.toBeNull();
    if (info == null) return;
    const humidity = info.areas[0]?.kinds[1].find(
      (k) => k.partKind === "Humidity",
    );
    expect(humidity?.metricMeta?.direction).toBe("lowerIsWorse");
    expect(humidity?.quantitativeWorst?.base?.value).toBe(25);
  });
});

describe("段階 fallback (decoded byte 長と Area 数)", () => {
  // 実物 4 件はいずれも 270-427KB なので fallback: "none" のはず
  it.each([
    [FIXTURE_VPWP50_SOYA_01, "none"],
    [FIXTURE_VPWP50_SOYA_02, "none"],
    [FIXTURE_VPWP50_SOYA_03, "none"],
    [FIXTURE_VPWP50_SOYA_04, "none"],
  ])("%s → fallback=%s", (fixture, expected) => {
    const msg = createMockWsDataMessage(fixture);
    const info = parseWeatherWarningTimeseries(msg);
    expect(info?.fallback).toBe(expected);
  });
});
