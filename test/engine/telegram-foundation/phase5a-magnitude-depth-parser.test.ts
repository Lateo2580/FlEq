import { describe, expect, it } from "vitest";
import { parseEarthquakeTelegram } from "../../../src/dmdata/telegram-parser";
import { extractSpecialValue } from "../../../src/dmdata/special-value";
import type { SpecialValue } from "../../../src/types";
import {
  formatDepthSpecialValue,
  formatMagnitudeSpecialValue,
  magnitudeSerializableRank,
  magnitudeSortRank,
  specialValueCanonicalEquals,
} from "../../../src/utils/magnitude";
import { comparableMagnitudeRank } from "../../../display/frontend/src/lib/magnitude";
import {
  createMockWsDataMessageFromXml,
  readFixture,
  FIXTURE_VXSE52_HYPO_4,
  FIXTURE_VXSE61_1,
} from "../../helpers/mock-message";

function parseFixture(name: string) {
  return parseEarthquakeTelegram(
    createMockWsDataMessageFromXml(readFixture(name), "VXSE52"),
  )?.earthquake;
}

function parseCoordinateFixture(coordinate: string) {
  const source = readFixture("synthetic_phase5a_depth_missing.xml");
  const xml = source.replace("+35.0+139.0/", coordinate);
  expect(xml).not.toBe(source);
  return parseEarthquakeTelegram(
    createMockWsDataMessageFromXml(xml, "VXSE52"),
  )?.earthquake;
}

function parseMagnitudeFixture(raw: string) {
  const source = readFixture("synthetic_phase5a_magnitude_unknown.xml");
  const xml = source.replace(
    '<jmx_eb:Magnitude type="Mj" condition="不明">NaN</jmx_eb:Magnitude>',
    `<jmx_eb:Magnitude type="Mj">${raw}</jmx_eb:Magnitude>`,
  );
  expect(xml).not.toBe(source);
  return parseEarthquakeTelegram(
    createMockWsDataMessageFromXml(xml, "VXSE52"),
  )?.earthquake;
}

describe("Phase 5A Magnitude/Depth parser contract", () => {
  it("VXSE52 の巨大 Magnitude を shadow XML の canonical value として保持する", () => {
    const earthquake = parseEarthquakeTelegram(
      createMockWsDataMessageFromXml(readFixture(FIXTURE_VXSE52_HYPO_4), "VXSE52"),
    )?.earthquake;

    expect(earthquake?.magnitude).toBe("");
    expect(earthquake?.magnitudeValue).toMatchObject({
      raw: "NaN",
      value: null,
      condition: "不明",
      description: "Ｍ８を超える巨大地震",
      presence: "qualitative",
    });
    expect(formatMagnitudeSpecialValue(earthquake!.magnitudeValue!)).toBe("M8 を超える巨大地震");
    expect(magnitudeSortRank(earthquake!.magnitudeValue!)).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ["M不明", "synthetic_phase5a_magnitude_unknown.xml", {
      magnitude: "",
      magnitudeValue: { raw: "NaN", value: null, condition: "不明", presence: "unknown" },
    }],
    ["ごく浅い", "synthetic_phase5a_depth_shallow.xml", {
      depth: "ごく浅い",
      depthValue: { raw: "-0", value: null, presence: "qualitative" },
    }],
    ["深さ成分欠落", "synthetic_phase5a_depth_missing.xml", {
      depth: "",
      depthValue: { raw: null, value: null, presence: "missing" },
    }],
    ["深さ600km以上", "synthetic_phase5a_depth_600km_or_more.xml", {
      depth: "600km",
      depthValue: { raw: "-600000", value: null, presence: "range", lowerBound: 600, upperBound: null },
    }],
    ["深さ range 矛盾", "synthetic_phase5a_depth_range_conflict.xml", {
      depth: "500km",
      depthValue: {
        raw: "-500000",
        value: 500,
        presence: "value",
        diagnostics: ["specialValueConflict"],
      },
    }],
  ] as const)("%s を canonical と旧 scalar adapter へ分離する", (
    _label,
    fixture,
    expected,
  ) => {
    const earthquake = parseFixture(fixture);
    expect(earthquake).toMatchObject(expected);
  });

  it("Magnitude/Depth の矛盾、canonical equality、formatter、巨大 rank を共通 helper で固定する", () => {
    const giant: SpecialValue<number> = {
      raw: "NaN",
      value: null,
      condition: "不明",
      description: "Ｍ８を超える巨大地震",
      presence: "qualitative",
    };
    const range: SpecialValue<number> = {
      raw: "600",
      value: null,
      condition: "以上",
      description: "深さ600km以上",
      presence: "range",
      lowerBound: 600,
    };
    const equivalentBounds: SpecialValue<number> = {
      ...range,
      lowerBound: 600,
      upperBound: null,
      raw: "６００",
      description: "深さ６００ｋｍ以上",
      diagnostics: ["specialValueConflict"],
    };

    expect(formatDepthSpecialValue(range)).toBe("600km以上");
    expect(magnitudeSortRank(giant)).toBeGreaterThan(magnitudeSortRank(range)!);
    expect(JSON.parse(JSON.stringify(magnitudeSerializableRank(giant)))).toEqual({
      kind: "giant",
    });
    expect(specialValueCanonicalEquals(range, equivalentBounds)).toBe(true);
    expect(specialValueCanonicalEquals(range, { ...range, lowerBound: 500 })).toBe(false);
  });

  it.each([
    ["7.25", 7.25, "7.3", "M7.3"],
    ["7.24", 7.24, "7.2", "M7.2"],
    ["７．３", 7.3, "", "M7.3"],
  ] as const)("Magnitude raw=%s は canonical と旧丸め adapter を分離する", (
    raw,
    canonical,
    legacy,
    formatted,
  ) => {
    const earthquake = parseMagnitudeFixture(raw);
    expect(earthquake?.magnitudeValue).toMatchObject({
      raw,
      value: canonical,
      presence: "value",
    });
    expect(earthquake?.magnitude).toBe(legacy);
    expect(formatMagnitudeSpecialValue(earthquake!.magnitudeValue!)).toBe(formatted);
  });

  it("Magnitude/Depth formatter は両側 range と未知 qualitative を保持する", () => {
    expect(formatMagnitudeSpecialValue({
      raw: "5～7",
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: 5,
      upperBound: 7,
    })).toBe("M5.0～7.0");
    expect(formatDepthSpecialValue({
      raw: "5～7",
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: 5,
      upperBound: 7,
    })).toBe("5～7km");
    expect(formatMagnitudeSpecialValue({
      raw: "解析保留",
      value: null,
      condition: null,
      description: null,
      presence: "qualitative",
    })).toBe("解析保留");
    expect(formatDepthSpecialValue({
      raw: "解析保留",
      value: null,
      condition: null,
      description: null,
      presence: "qualitative",
    })).toBe("解析保留");
  });

  it.each([
    "+35.0+139.0-10000",
    "+35.0+139.0-10000BROKEN",
    "JUNK+35.0+139.0-10000/",
    "+35.0+139.0-10000+1/",
    "+35.0+139.0-10000//",
  ])("形式不正 Coordinate %s は depth missing・旧 scalar 空文字にする", (coordinate) => {
    const earthquake = parseCoordinateFixture(coordinate);
    expect(earthquake).toMatchObject({
      latitude: "",
      longitude: "",
      depth: "",
      depthValue: { raw: null, value: null, presence: "missing" },
    });
  });

  it.each([
    ["+35.0+139.0-999/", "-999", 999, "999km"],
    ["+35.0+139.0-1000/", "-1000", 1, "1km"],
    ["+35.0+139.0-12.5/", "-12.5", 12.5, "12.5km"],
    ["+35.0+139.0-1000.5/", "-1000.5", 1.0005, "1.0005km"],
    ["+35.0+139.0-.5/", "-.5", 0.5, "0.5km"],
  ] as const)("Coordinate %s の m/km 境界・負値・小数を旧算法のまま解釈する", (
    coordinate,
    raw,
    canonical,
    legacy,
  ) => {
    const earthquake = parseCoordinateFixture(coordinate);
    expect(earthquake?.depthValue).toMatchObject({ raw, value: canonical, presence: "value" });
    expect(earthquake?.depth).toBe(legacy);
  });

  it.each([
    ["condition-only", { "@_condition": "Ｍ８を超える巨大地震" }],
    ["body-only", { "#text": "Ｍ８を超える巨大地震" }],
  ] as const)("%s の巨大 Magnitude は qualitative・最上位 rank にする", (_label, node) => {
    const value = extractSpecialValue("Magnitude", node);
    expect(value).toMatchObject({ value: null, presence: "qualitative" });
    expect(magnitudeSortRank(value)).toBe(Number.POSITIVE_INFINITY);
    expect(formatMagnitudeSpecialValue(value)).toBe("M8 を超える巨大地震");
  });

  it.each([
    ["不明ではない", "Magnitude"],
    ["巨大地震ではない", "Magnitude"],
    ["ごく浅いではない", "Depth"],
  ] as const)("否定形 condition %s は既知特殊語にせず valid 本文を保持する", (
    condition,
    domain,
  ) => {
    expect(extractSpecialValue(domain, {
      "#text": domain === "Magnitude" ? "6.5" : "10",
      "@_condition": condition,
    })).toMatchObject({
      value: domain === "Magnitude" ? 6.5 : 10,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it("Depth condition の数値付き終端 bound を canonical range にする", () => {
    expect(extractSpecialValue("Depth", {
      "#text": "600",
      "@_condition": "600km以上",
    })).toEqual({
      raw: "600",
      value: null,
      condition: "600km以上",
      description: null,
      presence: "range",
      lowerBound: 600,
      upperBound: null,
    });
  });

  it("Magnitude の既知終端 qualifier は canonical range と diagnostics で共有する", () => {
    expect(extractSpecialValue("Magnitude", {
      "#text": "6.5",
      "@_condition": "推定値以上",
    })).toEqual({
      raw: "6.5",
      value: null,
      condition: "推定値以上",
      description: null,
      presence: "range",
      lowerBound: 6.5,
      upperBound: null,
    });
    expect(extractSpecialValue("Magnitude", {
      "#text": "6.5",
      "@_condition": "推定値以上ではない",
    })).toMatchObject({
      value: 6.5,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it.each([
    ["Magnitude raw", "Magnitude", { "#text": "解析保留" }, { raw: "解析保留" }],
    [
      "Magnitude description",
      "Magnitude",
      { "@_description": "解析保留" },
      { raw: "", description: "解析保留" },
    ],
    ["Depth raw", "Depth", { "#text": "解析保留" }, { raw: "解析保留" }],
    [
      "Depth description",
      "Depth",
      { "@_description": "解析保留" },
      { raw: "", description: "解析保留" },
    ],
  ] as const)("未知 qualitative (%s) は raw/description と unmapped 診断を保持する", (
    _label,
    domain,
    node,
    source,
  ) => {
    const value = extractSpecialValue(domain, node) as SpecialValue<number>;
    expect(value).toMatchObject({
      ...source,
      value: null,
      presence: "qualitative",
      diagnostics: ["unmappedSpecialValue"],
    });
    expect(domain === "Magnitude"
      ? formatMagnitudeSpecialValue(value)
      : formatDepthSpecialValue(value)).toBe("解析保留");
  });

  it("serialize-safe Magnitude rank は全 kind を JSON round-trip できる", () => {
    const ranks = [
      magnitudeSerializableRank({
        raw: "巨大地震",
        value: null,
        condition: null,
        description: null,
        presence: "qualitative",
      }),
      magnitudeSerializableRank({
        raw: "6.5",
        value: 6.5,
        condition: null,
        description: null,
        presence: "value",
      }),
      magnitudeSerializableRank({
        raw: "5～7",
        value: null,
        condition: null,
        description: null,
        presence: "range",
        lowerBound: 5,
        upperBound: 7,
      }),
      magnitudeSerializableRank({
        raw: "不明",
        value: null,
        condition: "不明",
        description: null,
        presence: "unknown",
      }),
    ];
    expect(JSON.parse(JSON.stringify(ranks))).toEqual([
      { kind: "giant" },
      { kind: "value", value: 6.5 },
      { kind: "range", lowerBound: 5, upperBound: 7 },
      { kind: "unranked" },
    ]);
  });

  it.each([
    ["両側 range", {
      raw: "5～7", value: null, condition: null, description: null,
      presence: "range" as const, lowerBound: 5, upperBound: 7,
    }],
    ["lower-only", {
      raw: "5以上", value: null, condition: "以上", description: null,
      presence: "range" as const, lowerBound: 5, upperBound: null,
    }],
    ["upper-only", {
      raw: "7以下", value: null, condition: "以下", description: null,
      presence: "range" as const, lowerBound: null, upperBound: 7,
    }],
    ["exact", {
      raw: "6", value: 6, condition: null, description: null,
      presence: "value" as const,
    }],
    ["giant", {
      raw: "巨大地震", value: null, condition: null, description: null,
      presence: "qualitative" as const,
    }],
  ] satisfies ReadonlyArray<readonly [string, SpecialValue<number>]>) (
    "共通 rank と frontend rank は %s で一致する",
    (_label, value) => {
      expect(magnitudeSortRank(value)).toBe(
        comparableMagnitudeRank(magnitudeSerializableRank(value)),
      );
    },
  );

  it("Coordinate description 終端の 深さ ごく浅い と非0本文の矛盾を記録する", () => {
    expect(extractSpecialValue("Depth", {
      "#text": "10",
      "@_description": "北緯３５度　東経１３９度　深さ ごく浅い",
    })).toEqual({
      raw: "10",
      value: 10,
      condition: null,
      description: "北緯３５度　東経１３９度　深さ ごく浅い",
      presence: "value",
      diagnostics: ["specialValueConflict"],
    });
  });

  it("VXSE61 は十進度 Coordinate の raw・description を canonical Depth に使う", () => {
    const earthquake = parseEarthquakeTelegram(
      createMockWsDataMessageFromXml(readFixture(FIXTURE_VXSE61_1), "VXSE61"),
    )?.earthquake;
    expect(earthquake?.depthValue).toMatchObject({
      raw: "-20000",
      value: 20,
      description: "北緯３４．８度　東経１３８．５度　深さ　２０ｋｍ",
      presence: "value",
    });
    expect(earthquake?.depth).toBe("20km");
  });

  it("Magnitude と Depth の既知 qualifier と数値本文の矛盾を diagnostics へ残す", () => {
    expect(extractSpecialValue("Magnitude", {
      "#text": "6.5",
      "@_description": "Ｍ８を超える巨大地震",
    })).toMatchObject({
      value: null,
      presence: "qualitative",
      diagnostics: ["specialValueConflict"],
    });
    expect(extractSpecialValue("Depth", {
      "#text": "10",
      "@_description": "ごく浅い",
    })).toMatchObject({
      value: 10,
      presence: "value",
      diagnostics: ["specialValueConflict"],
    });
  });
});
