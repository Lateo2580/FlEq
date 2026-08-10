import { describe, expect, it } from "vitest";
import { extractSpecialValue } from "../../../src/dmdata/special-value";
import { parseTyphoonAnalysis } from "../../../src/dmdata/typhoon-analysis-parser";
import type { SpecialValue } from "../../../src/types";
import { specialValueCanonicalEquals } from "../../../src/utils/magnitude";
import {
  comparableNumericSpecialValueRank,
  formatNumericSpecialValue,
  movementSpeedQualitativeDisplay,
  numericSpecialValueSerializableRank,
  numericSpecialValueSortRank,
} from "../../../src/utils/numeric-special-value";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VPTW60_2020,
  readFixture,
} from "../../helpers/mock-message";

const FIRST_KMH_SPEED =
  '<jmx_eb:Speed description="毎時２０キロ" unit="km/h" type="移動速度">20</jmx_eb:Speed>';
const FIRST_PRESSURE =
  '<jmx_eb:Pressure description="中心気圧１００２ヘクトパスカル" unit="hPa" type="中心気圧">1002</jmx_eb:Pressure>';
const FIRST_MAX_WIND_MS =
  '<jmx_eb:WindSpeed description="中心付近の最大風速１５メートル" condition="中心付近" unit="m/s" type="最大風速">15</jmx_eb:WindSpeed>';

const TYPHOON_NUMERIC_DOMAIN_MATRIX = [
  ["Pressure", "hPa", FIRST_PRESSURE],
  ["WindSpeed", "m/s", FIRST_MAX_WIND_MS],
  ["MovementSpeed", "km/h", FIRST_KMH_SPEED],
] as const;

function parseFirstFrameWithSpeed(speedXml: string) {
  const xml = readFixture(FIXTURE_VPTW60_2020).replace(FIRST_KMH_SPEED, speedXml);
  return parseTyphoonAnalysis(
    createMockWsDataMessageFromXml(xml, "VPTW60"),
  )!.frames[0];
}

describe("Phase 5B typhoon numeric parser contract", () => {
  it("複数単位併記から km/h・hPa・m/s だけを canonical と scalar へ採用する", () => {
    const info = parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2020))!;
    const now = info.frames[0];

    expect(now.center.moveSpeedKmh).toBe(20);
    expect(now.center.moveSpeedKmhValue).toMatchObject({
      raw: "20", value: 20, presence: "value",
    });
    expect(now.center.pressureHpa).toBe(1002);
    expect(now.center.pressureHpaValue).toMatchObject({
      raw: "1002", value: 1002, presence: "value",
    });
    expect(now.wind?.maxWindMs).toBe(15);
    expect(now.wind?.maxWindMsValue).toMatchObject({
      raw: "15", value: 15, condition: "中心付近", presence: "value",
    });
    expect(now.wind?.maxWindMsValue?.diagnostics).toBeUndefined();
    expect(now.wind?.maxGustMs).toBe(23);
    expect(now.wind?.maxGustMsValue).toMatchObject({
      raw: "23", value: 23, presence: "value",
    });
  });

  it("description-only の ゆっくり を self-closing 本文から qualitative にする", () => {
    const frame = parseFirstFrameWithSpeed(
      '<jmx_eb:Speed description="ゆっくり" unit="km/h" type="移動速度"/>',
    );
    expect(frame.center.moveSpeedKmh).toBeNull();
    expect(frame.center.moveSpeedKmhValue).toEqual({
      raw: "",
      value: null,
      condition: null,
      description: "ゆっくり",
      presence: "qualitative",
    });
  });

  it.each(["ゆっくり", "ほとんど停滞"])(
    "condition-only の %s を qualitative にする",
    (condition) => {
      const frame = parseFirstFrameWithSpeed(
        `<jmx_eb:Speed condition="${condition}" unit="km/h" type="移動速度"/>`,
      );
      expect(frame.center.moveSpeedKmhValue).toMatchObject({
        raw: "", condition, presence: "qualitative",
      });
    },
  );

  it("未知 self-closing Condition を empty にせず qualitative＋診断で保持する", () => {
    const frame = parseFirstFrameWithSpeed(
      '<jmx_eb:Speed condition="停滞気味" unit="km/h" type="移動速度"/>',
    );
    expect(frame.center.moveSpeedKmh).toBeNull();
    expect(frame.center.moveSpeedKmhValue).toEqual({
      raw: "",
      value: null,
      condition: "停滞気味",
      description: null,
      presence: "qualitative",
      diagnostics: ["unmappedSpecialValue"],
    });
  });

  it("数値本文付き未知 Condition は scalar/canonical value と conflict 診断を保持する", () => {
    const frame = parseFirstFrameWithSpeed(
      '<jmx_eb:Speed condition="停滞気味" unit="km/h" type="移動速度">7.25</jmx_eb:Speed>',
    );
    expect(frame.center.moveSpeedKmh).toBe(7.25);
    expect(frame.center.moveSpeedKmhValue).toEqual({
      raw: "7.25",
      value: 7.25,
      condition: "停滞気味",
      description: null,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it.each(["Pressure", "WindSpeed", "MovementSpeed"] as const)(
    "%s の未知 Condition を qualitative/value と診断へ落とさず分離する",
    (domain) => {
      expect(extractSpecialValue(domain, {
        "@_condition": "判定保留",
      })).toEqual({
        raw: "",
        value: null,
        condition: "判定保留",
        description: null,
        presence: "qualitative",
        diagnostics: ["unmappedSpecialValue"],
      });
      expect(extractSpecialValue(domain, {
        "#text": "12.5",
        "@_condition": "判定保留",
      })).toMatchObject({
        raw: "12.5",
        value: 12.5,
        presence: "value",
        diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
      });
    },
  );

  it.each(TYPHOON_NUMERIC_DOMAIN_MATRIX)(
    "%s の不正単位・桁あふれ・empty raw・全角数値を対称に固定する",
    (domain, unit, fixtureElement) => {
      const source = readFixture(FIXTURE_VPTW60_2020);
      const invalidUnitElement = fixtureElement.replace(`unit="${unit}"`, 'unit="invalid"');
      const xml = source.replace(fixtureElement, invalidUnitElement);
      expect(xml).not.toBe(source);
      const frame = parseTyphoonAnalysis(
        createMockWsDataMessageFromXml(xml, "VPTW60"),
      )!.frames[0];
      const invalidUnit = domain === "Pressure"
        ? { scalar: frame.center.pressureHpa, canonical: frame.center.pressureHpaValue }
        : domain === "WindSpeed"
          ? { scalar: frame.wind?.maxWindMs, canonical: frame.wind?.maxWindMsValue }
          : { scalar: frame.center.moveSpeedKmh, canonical: frame.center.moveSpeedKmhValue };
      expect(invalidUnit.scalar).toBeNull();
      expect(invalidUnit.canonical).toEqual({
        raw: null,
        value: null,
        condition: null,
        description: null,
        presence: "missing",
      });

      const fullWidthRaw = "　＋１２．５　";
      expect(extractSpecialValue(domain, {
        "#text": fullWidthRaw,
        "@_unit": unit,
      })).toEqual({
        raw: fullWidthRaw,
        value: 12.5,
        condition: null,
        description: null,
        presence: "value",
      });

      const overflowRaw = "9".repeat(400);
      expect(extractSpecialValue(domain, {
        "#text": overflowRaw,
        "@_unit": unit,
      })).toEqual({
        raw: overflowRaw,
        value: null,
        condition: null,
        description: null,
        presence: "qualitative",
        diagnostics: ["unmappedSpecialValue"],
      });

      for (const raw of ["", " ", "　"]) {
        expect(extractSpecialValue(domain, {
          "#text": raw,
          "@_unit": unit,
        })).toEqual({
          raw,
          value: null,
          condition: null,
          description: null,
          presence: "empty",
        });
      }
    },
  );

  it("未知の本文定性語は raw を変更せず qualitative＋診断で保持する", () => {
    expect(extractSpecialValue("MovementSpeed", {
      "#text": "  停滞気味  ",
      "@_unit": "km/h",
    })).toEqual({
      raw: "  停滞気味  ",
      value: null,
      condition: null,
      description: null,
      presence: "qualitative",
      diagnostics: ["unmappedSpecialValue"],
    });
  });

  it("既知語は NFKC 後の完全一致と肯定的終端一致で認識し、否定形は値を無効化しない", () => {
    expect(extractSpecialValue("Pressure", {
      "#text": "ＮａＮ",
      "@_unit": "ｈＰａ",
    })).toMatchObject({ raw: "ＮａＮ", presence: "unknown" });
    expect(extractSpecialValue("MovementSpeed", {
      "@_description": "移動速度２０ｋｍ／ｈではほとんど停滞",
    })).toMatchObject({ presence: "qualitative" });
    expect(extractSpecialValue("MovementSpeed", {
      "#text": "10",
      "@_condition": "ゆっくりではない",
    })).toMatchObject({
      value: 10,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it("description は MovementSpeed の既知語だけを分類し、Pressure/WindSpeed では値を変えない", () => {
    expect(extractSpecialValue("Pressure", {
      "#text": "1002",
      "@_description": "解析不能",
      "@_unit": "hPa",
    })).toEqual({
      raw: "1002",
      value: 1002,
      condition: null,
      description: "解析不能",
      presence: "value",
    });
    expect(extractSpecialValue("WindSpeed", {
      "#text": "20",
      "@_description": "なし",
      "@_unit": "m/s",
    })).toEqual({
      raw: "20",
      value: 20,
      condition: null,
      description: "なし",
      presence: "value",
    });
    expect(extractSpecialValue("MovementSpeed", {
      "#text": "20",
      "@_description": "ゆっくり",
      "@_unit": "km/h",
    })).toMatchObject({
      raw: "20",
      value: null,
      description: "ゆっくり",
      presence: "qualitative",
    });
  });

  it("condition=なし の 0m/s は qualitative と旧 scalar 0 を両立する", () => {
    const frame = parseTyphoonAnalysis(
      createMockWsDataMessage(FIXTURE_VPTW60_2020),
    )!.frames.at(-1)!;
    expect(frame.wind?.maxWindMs).toBe(0);
    expect(frame.wind?.maxWindMsValue).toMatchObject({
      raw: "0", condition: "なし", presence: "qualitative",
    });
  });

  it("WindSpeed condition=値なし は既存どおり empty とし、未知語診断を付けない", () => {
    expect(extractSpecialValue("WindSpeed", {
      "@_condition": "値なし",
      "@_unit": "m/s",
    })).toEqual({
      raw: "",
      value: null,
      condition: "値なし",
      description: null,
      presence: "empty",
    });
  });

  it("range は WindSpeed だけに適用し、Pressure/MovementSpeed は value＋未知 Condition 診断にする", () => {
    expect(extractSpecialValue("WindSpeed", {
      "#text": "25", "@_condition": "以上", "@_unit": "m/s",
    })).toMatchObject({ presence: "range", lowerBound: 25, upperBound: null });

    for (const domain of ["Pressure", "MovementSpeed"] as const) {
      expect(extractSpecialValue(domain, {
        "#text": "25", "@_condition": "以上",
      })).toMatchObject({
        value: 25,
        presence: "value",
        diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
      });
    }
  });

  it.each([
    ["From only", { From: "950" }, "950", null],
    ["To only", { To: "960" }, null, "960"],
    ["両側", { From: "950", To: "960" }, "950", "960"],
  ] as const)("Pressure/MovementSpeed の構造化 bounds (%s) は range にしない", (
    _label,
    bounds,
    rawLowerBound,
    rawUpperBound,
  ) => {
    for (const domain of ["Pressure", "MovementSpeed"] as const) {
      expect(extractSpecialValue(domain, bounds)).toEqual({
        raw: "",
        value: null,
        condition: null,
        description: null,
        presence: "qualitative",
        rawLowerBound,
        rawUpperBound,
        diagnostics: ["unmappedSpecialValue"],
      });
    }
  });

  it("Pressure/MovementSpeed は構造化 bounds より数値本文を優先し、診断と raw bounds を残す", () => {
    for (const domain of ["Pressure", "MovementSpeed"] as const) {
      expect(extractSpecialValue(domain, {
        "#text": "955",
        From: "950",
        To: "960",
      })).toEqual({
        raw: "955",
        value: 955,
        condition: null,
        description: null,
        presence: "value",
        rawLowerBound: "950",
        rawUpperBound: "960",
        diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
      });
    }
  });

  it("既知特殊 Condition は Pressure/MovementSpeed の構造化 bounds より優先する", () => {
    expect(extractSpecialValue("Pressure", {
      "@_condition": "解析不能",
      From: "950",
      To: "960",
    })).toEqual({
      raw: "",
      value: null,
      condition: "解析不能",
      description: null,
      presence: "unknown",
      rawLowerBound: "950",
      rawUpperBound: "960",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
    expect(extractSpecialValue("MovementSpeed", {
      "@_condition": "ほとんど停滞",
      From: "5",
      To: "10",
    })).toEqual({
      raw: "",
      value: null,
      condition: "ほとんど停滞",
      description: null,
      presence: "qualitative",
      rawLowerBound: "5",
      rawUpperBound: "10",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it("WindSpeed の構造化 bounds は From/To を canonical range にする", () => {
    expect(extractSpecialValue("WindSpeed", {
      From: "25",
      To: "30",
      "@_unit": "m/s",
    })).toEqual({
      raw: "",
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: 25,
      upperBound: 30,
      rawLowerBound: "25",
      rawUpperBound: "30",
    });
  });

  it.each([
    ["Pressure", "解析不能", "unknown"],
    ["WindSpeed", "なし", "qualitative"],
  ] as const)("%s の既知特殊語 %s は self-closing Condition から分類する", (
    domain,
    condition,
    presence,
  ) => {
    expect(extractSpecialValue(domain, {
      "@_condition": condition,
    })).toMatchObject({ raw: "", condition, presence });
  });

  it.each([
    ["Pressure", "解析不能"],
    ["WindSpeed", "なし"],
    ["MovementSpeed", "ゆっくり"],
  ] as const)("%s の raw/Condition 否定形 %sではない は既知特殊語にしない", (
    domain,
    term,
  ) => {
    expect(extractSpecialValue(domain, {
      "#text": `${term}ではない`,
    })).toMatchObject({
      raw: `${term}ではない`,
      presence: "qualitative",
      diagnostics: ["unmappedSpecialValue"],
    });
    expect(extractSpecialValue(domain, {
      "#text": "10",
      "@_condition": `${term}ではない`,
    })).toMatchObject({
      value: 10,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it.each([
    ["Pressure", "解析不能"],
    ["WindSpeed", "なし"],
  ] as const)("%s の description-only %s は self-closing 本文を分類しない", (
    domain,
    description,
  ) => {
    expect(extractSpecialValue(domain, {
      "@_description": description,
    })).toEqual({
      raw: "",
      value: null,
      condition: null,
      description,
      presence: "empty",
    });
  });

  it("formatter・canonical equality・serializable rank は全比較形を維持する", () => {
    const exact: SpecialValue<number> = {
      raw: "7.25", value: 7.25, condition: null, description: null, presence: "value",
    };
    const range: SpecialValue<number> = {
      raw: "5～7", value: null, condition: null, description: null, presence: "range",
      lowerBound: 5, upperBound: 7,
    };
    const qualitative: SpecialValue<number> = {
      raw: "未整理", value: null, condition: "ゆっくり", description: "ほとんど停滞",
      presence: "qualitative",
    };

    expect(formatNumericSpecialValue(exact, "m/s")).toBe("7.25m/s");
    expect(formatNumericSpecialValue(range, "km/h")).toBe("5～7km/h");
    expect(formatNumericSpecialValue(qualitative, "km/h")).toBe("ほとんど停滞");
    expect(formatNumericSpecialValue({
      ...qualitative, description: null, condition: null,
    }, "km/h")).toBe("未整理");
    expect(movementSpeedQualitativeDisplay({
      ...qualitative, description: "　ゆっくり　",
    })).toEqual({ text: "　ゆっくり　", kind: "slow" });
    expect(movementSpeedQualitativeDisplay({
      ...qualitative, description: null, condition: null,
    })).toBeNull();
    expect(specialValueCanonicalEquals(range, {
      ...range, raw: "５～７", lowerBound: 5, upperBound: 7,
    })).toBe(true);
    expect(numericSpecialValueSortRank(range)).toBe(5);

    const ranks = [
      numericSpecialValueSerializableRank(exact),
      numericSpecialValueSerializableRank(qualitative),
      numericSpecialValueSerializableRank({
        ...range, lowerBound: 5, upperBound: null,
      }),
      numericSpecialValueSerializableRank({
        ...range, lowerBound: null, upperBound: 7,
      }),
    ];
    expect(JSON.parse(JSON.stringify(ranks))).toEqual([
      { kind: "value", value: 7.25 },
      { kind: "unranked" },
      { kind: "range", lowerBound: 5, upperBound: null },
      { kind: "range", lowerBound: null, upperBound: 7 },
    ]);
    expect(ranks.map(comparableNumericSpecialValueRank)).toEqual([7.25, null, 5, 7]);
  });
});
