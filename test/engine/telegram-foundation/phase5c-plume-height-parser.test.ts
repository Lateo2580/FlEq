import { describe, expect, it } from "vitest";
import { extractSpecialValue } from "../../../src/dmdata/special-value";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import type { PlumeHeightSemantic } from "../../../src/types";
import {
  comparePlumeHeight,
  formatPlumeHeightSpecialValue,
  plumeHeightCanonicalEquals,
  plumeHeightLegacyAdapter,
  plumeHeightSerializableRank,
  plumeHeightSortRank,
} from "../../../src/utils/plume-height";
import { resolveVolcanoPresentation } from "../../../src/engine/presentation/volcano-presentation";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFVO52_ERUPTION_2,
  FIXTURE_VFVO52_ERUPTION_3,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFVO56_FLASH_2,
  FIXTURE_VFVO56_FLASH_3,
  FIXTURE_VFVO56_FLASH_4,
  FIXTURE_VFVO60_PLUME,
  readFixture,
} from "../../helpers/mock-message";

function plumeFixture(
  craterNode: string,
  seaLevelNode?: string,
): ReturnType<typeof parseVolcanoTelegram> {
  let xml = readFixture(FIXTURE_VFVO52_ERUPTION_1).replace(
    /<jmx_eb:PlumeHeightAboveCrater\b[^>]*\/>/,
    craterNode,
  );
  if (seaLevelNode !== undefined) {
    xml = xml.replace(
      /<jmx_eb:PlumeHeightAboveSeaLevel\b[^>]*\/>/,
      seaLevelNode,
    );
  }
  return parseVolcanoTelegram(createMockWsDataMessageFromXml(xml, "VFVO52"));
}

function semantic(
  value: PlumeHeightSemantic["value"],
  unit: PlumeHeightSemantic["unit"] = "m",
): PlumeHeightSemantic {
  return { reference: "aboveCrater", unit, value };
}

describe("Phase 5C PlumeHeight parser and common helpers", () => {
  it("既存 fixture から火口上 m と海抜 FT を変換せず別 canonical field に保持する", () => {
    const parsed = parseVolcanoTelegram(createMockWsDataMessage(FIXTURE_VFVO60_PLUME));
    expect(parsed?.kind).toBe("plume");
    if (parsed?.kind !== "plume") return;

    expect(parsed.plumeHeight).toBe(1800);
    expect(parsed.plumeHeightAboveCraterValue).toEqual({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "1800", value: 1800, condition: null, description: "火口上1800m", presence: "value",
      },
    });
    expect(parsed.plumeHeightAboveSeaLevelValue).toEqual({
      reference: "aboveSeaLevel",
      unit: "FT",
      value: {
        raw: "9400", value: 9400, condition: null, description: "海抜9400FT", presence: "value",
      },
    });
  });

  it.each([
    [
      "雲中",
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="雲中">3000</jmx_eb:PlumeHeightAboveCrater>',
      { presence: "qualitative", value: null, condition: "雲中", diagnostics: ["specialValueConflict"] },
      3000,
      false,
    ],
    [
      "観測できず",
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="観測できず">3200</jmx_eb:PlumeHeightAboveCrater>',
      { presence: "unknown", value: null, condition: "観測できず", diagnostics: ["specialValueConflict"] },
      3200,
      false,
    ],
    [
      "以上",
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="以上">3000</jmx_eb:PlumeHeightAboveCrater>',
      { presence: "range", value: null, lowerBound: 3000, upperBound: null },
      3000,
      false,
    ],
  ] as const)("合成 fixture の %s を canonical 化して legacy scalar は維持する", (
    _label,
    node,
    expected,
    legacyHeight,
    legacyUnknown,
  ) => {
    const parsed = plumeFixture(node);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toMatchObject(expected);
    expect(parsed.plumeHeight).toBe(legacyHeight);
    expect(parsed.plumeHeightUnknown).toBe(legacyUnknown);
  });

  it("shadow XML tree から raw/condition/description を無加工で保持し、legacy は trim 後を再現する", () => {
    const parsed = plumeFixture(
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="　雲中　" '
      + 'description="　火口上  3000m　">  003000m  </jmx_eb:PlumeHeightAboveCrater>',
    );
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toMatchObject({
      raw: "  003000m  ",
      presence: "qualitative",
      condition: "　雲中　",
      description: "　火口上  3000m　",
    });
    expect(parsed.plumeHeight).toBe(3000);
    expect(parsed.plumeHeightUnknown).toBe(false);
  });

  it("観測阻害 condition は本文 NaN より優先する", () => {
    const parsed = plumeFixture(
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="雲中">NaN</jmx_eb:PlumeHeightAboveCrater>',
    );
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toMatchObject({
      raw: "NaN", value: null, condition: "雲中", presence: "qualitative",
    });
  });

  it("観測阻害 condition は明示 From/To より優先し、共存を矛盾として残す", () => {
    const parsed = plumeFixture(
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="雲中">'
      + "<From>2000</From><To>4000</To>"
      + "</jmx_eb:PlumeHeightAboveCrater>",
    );
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toEqual({
      raw: "",
      value: null,
      condition: "雲中",
      description: null,
      presence: "qualitative",
      rawLowerBound: "2000",
      rawUpperBound: "4000",
      diagnostics: ["specialValueConflict"],
    });
  });

  it("本文の bound 表現を lower-only range にし、legacy warning corpus と一致させる", () => {
    const parsed = plumeFixture(
      '<jmx_eb:PlumeHeightAboveCrater unit="m">3000以上</jmx_eb:PlumeHeightAboveCrater>',
    );
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toEqual({
      raw: "3000以上",
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: 3000,
      upperBound: null,
    });
    expect(parsed.plumeHeight).toBe(3000);
    expect(resolveVolcanoPresentation(parsed, new VolcanoStateHolder()).frameLevel).toBe("warning");
  });

  it.each(["雲中ではない", "非雲中"])("否定形 condition %s は値を抑止せず診断する", (condition) => {
    const parsed = plumeFixture(
      `<jmx_eb:PlumeHeightAboveCrater unit="m" condition="${condition}">3000</jmx_eb:PlumeHeightAboveCrater>`,
    );
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toEqual({
      raw: "3000",
      value: 3000,
      condition,
      description: null,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it.each(["3000以上ではない", "非3000以上"])("range 否定形 condition %s は range 化しない", (condition) => {
    const parsed = plumeFixture(
      `<jmx_eb:PlumeHeightAboveCrater unit="m" condition="${condition}">3000</jmx_eb:PlumeHeightAboveCrater>`,
    );
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toEqual({
      raw: "3000",
      value: 3000,
      condition,
      description: null,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it.each([
    ["missing", "", { raw: null, presence: "missing", value: null }],
    [
      "empty",
      '<jmx_eb:PlumeHeightAboveCrater unit="m"></jmx_eb:PlumeHeightAboveCrater>',
      { raw: "", presence: "empty", value: null },
    ],
    [
      "本文 雲中",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">雲中</jmx_eb:PlumeHeightAboveCrater>',
      { raw: "雲中", presence: "qualitative", value: null },
    ],
    [
      "本文 観測できず",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">観測できず</jmx_eb:PlumeHeightAboveCrater>',
      { raw: "観測できず", presence: "unknown", value: null },
    ],
    [
      "本文 不明",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">不明</jmx_eb:PlumeHeightAboveCrater>',
      { raw: "不明", presence: "unknown", value: null },
    ],
    [
      "明示 From/To",
      '<jmx_eb:PlumeHeightAboveCrater unit="m"><From>2000</From><To>4000</To>'
      + "</jmx_eb:PlumeHeightAboveCrater>",
      { raw: "", presence: "range", value: null, lowerBound: 2000, upperBound: 4000 },
    ],
    [
      "description bound",
      '<jmx_eb:PlumeHeightAboveCrater unit="m" description="火口上3000m以上">3000'
      + "</jmx_eb:PlumeHeightAboveCrater>",
      { raw: "3000", presence: "range", value: null, lowerBound: 3000, upperBound: null },
    ],
  ] as const)("parser 状態機械を XML 経由で固定する: %s", (_label, node, expected) => {
    const parsed = plumeFixture(node);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toMatchObject(expected);
  });

  it("海抜 FT でも特殊状態を変換せず保持する", () => {
    const parsed = plumeFixture(
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="不明" />',
      '<jmx_eb:PlumeHeightAboveSeaLevel unit="FT" condition="観測できず">12000'
      + "</jmx_eb:PlumeHeightAboveSeaLevel>",
    );
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveSeaLevelValue).toEqual({
      reference: "aboveSeaLevel",
      unit: "FT",
      value: {
        raw: "12000",
        value: null,
        condition: "観測できず",
        description: null,
        presence: "unknown",
        diagnostics: ["specialValueConflict"],
      },
    });
  });

  it("未対応語は unmappedSpecialValue にし、数値本文との矛盾を記録する", () => {
    expect(extractSpecialValue("PlumeHeight", {
      "#text": "2500",
      "@_condition": "視程不良",
    })).toEqual({
      raw: "2500",
      value: 2500,
      condition: "視程不良",
      description: null,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it("共通 formatter は range と、分類を決めた特殊語の raw/condition 優先を保つ", () => {
    expect(formatPlumeHeightSpecialValue(semantic({
      raw: "3000", value: null, condition: "以上", description: null,
      presence: "range", lowerBound: 3000, upperBound: null,
    }))).toBe("3000m以上");
    expect(formatPlumeHeightSpecialValue(semantic({
      raw: "雲中", value: null, condition: null, description: "火口上雲中", presence: "qualitative",
    }))).toBe("雲中");
    expect(formatPlumeHeightSpecialValue(semantic({
      raw: "3000", value: null, condition: "観測できず", description: null, presence: "unknown",
    }))).toBe("観測できず");
    expect(formatPlumeHeightSpecialValue(semantic({
      raw: "NaN", value: null, condition: null, description: null, presence: "unknown",
    }))).toBe("不明");
  });

  it("canonical equality と serializable rank は基準・単位を保ち、異単位比較を拒む", () => {
    const range = semantic({
      raw: "3000", value: null, condition: "以上", description: null,
      presence: "range", lowerBound: 3000, upperBound: null,
    });
    const sameCanonical = semantic({
      ...range.value,
      raw: "３０００",
      diagnostics: ["specialValueConflict"],
    });
    const feet = { ...range, unit: "FT" as const };
    expect(plumeHeightCanonicalEquals(range, sameCanonical)).toBe(true);
    expect(plumeHeightCanonicalEquals(range, feet)).toBe(false);
    expect(plumeHeightSerializableRank(range)).toEqual({
      kind: "range", reference: "aboveCrater", unit: "m", lowerBound: 3000, upperBound: null,
    });
    expect(plumeHeightSortRank(range)).toBe(3000);
    expect(comparePlumeHeight(range, feet)).toBeNull();
    expect(JSON.parse(JSON.stringify(plumeHeightSerializableRank(range)))).toEqual(
      plumeHeightSerializableRank(range),
    );
  });

  it.each([
    ["10進固定", "0x10", null, 0, false],
    ["前後空白", "  3000  ", null, 3000, false],
    ["数値接尾辞", "3000m", null, 3000, false],
    ["全角数字", "３０００", null, null, false],
    ["空文字", "", null, null, false],
    ["不明 condition", "3000", "不明", null, true],
  ] as const)("legacy adapter は旧 parseInt/unknown 挙動を再現する: %s", (
    _label,
    raw,
    condition,
    plumeHeight,
    plumeHeightUnknown,
  ) => {
    expect(plumeHeightLegacyAdapter(raw, condition)).toEqual({
      plumeHeight,
      plumeHeightUnknown,
    });
  });

  it("rank は全形状の serialize-safe object と基準違いを固定する", () => {
    const exact = semantic({
      raw: "3000", value: 3000, condition: null, description: null, presence: "value",
    });
    const lowerOnly = semantic({
      raw: "2500", value: null, condition: "以上", description: null,
      presence: "range", lowerBound: 2500, upperBound: null,
    });
    const upperOnly = semantic({
      raw: "3000", value: null, condition: "以下", description: null,
      presence: "range", lowerBound: null, upperBound: 3000,
    });
    const both = semantic({
      raw: "2000-4000", value: null, condition: null, description: null,
      presence: "range", lowerBound: 2000, upperBound: 4000,
    });
    const unranked = semantic({
      raw: "雲中", value: null, condition: "雲中", description: null, presence: "qualitative",
    });
    expect(plumeHeightSerializableRank(exact)).toEqual({
      kind: "value", reference: "aboveCrater", unit: "m", value: 3000,
    });
    expect(plumeHeightSerializableRank(lowerOnly)).toEqual({
      kind: "range", reference: "aboveCrater", unit: "m",
      lowerBound: 2500, upperBound: null,
    });
    expect(plumeHeightSerializableRank(upperOnly)).toEqual({
      kind: "range", reference: "aboveCrater", unit: "m",
      lowerBound: null, upperBound: 3000,
    });
    expect(plumeHeightSerializableRank(both)).toEqual({
      kind: "range", reference: "aboveCrater", unit: "m",
      lowerBound: 2000, upperBound: 4000,
    });
    expect(plumeHeightSortRank(exact)).toBe(3000);
    expect(plumeHeightSortRank(lowerOnly)).toBe(2500);
    expect(plumeHeightSortRank(upperOnly)).toBe(3000);
    expect(plumeHeightSortRank(both)).toBe(2000);
    expect(plumeHeightSerializableRank(unranked)).toEqual({
      kind: "unranked", reference: "aboveCrater", unit: "m",
    });
    expect(plumeHeightSortRank(unranked)).toBeNull();
    const allRanks = [exact, lowerOnly, upperOnly, both, unranked]
      .map(plumeHeightSerializableRank);
    expect(JSON.parse(JSON.stringify(allRanks))).toEqual(allRanks);
    expect(comparePlumeHeight(exact, { ...exact, reference: "aboveSeaLevel" })).toBeNull();
  });

  it.each([
    [
      "2999",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">2999</jmx_eb:PlumeHeightAboveCrater>',
      "normal",
    ],
    [
      "3000",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">3000</jmx_eb:PlumeHeightAboveCrater>',
      "warning",
    ],
    [
      "3000以上",
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="以上">3000</jmx_eb:PlumeHeightAboveCrater>',
      "warning",
    ],
    [
      "本文3000以上",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">3000以上</jmx_eb:PlumeHeightAboveCrater>',
      "warning",
    ],
  ] as const)("本番 presentation の legacy warning 境界を固定する: %s", (
    _label,
    node,
    frameLevel,
  ) => {
    const parsed = plumeFixture(node);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(resolveVolcanoPresentation(parsed, new VolcanoStateHolder()).frameLevel).toBe(frameLevel);
  });

  it.each([
    [FIXTURE_VFVO52_ERUPTION_1, null, true, "normal"],
    [FIXTURE_VFVO52_ERUPTION_2, null, true, "warning"],
    [FIXTURE_VFVO52_ERUPTION_3, null, true, "cancel"],
    [FIXTURE_VFVO56_FLASH_1, null, false, "critical"],
    [FIXTURE_VFVO56_FLASH_2, null, false, "critical"],
    [FIXTURE_VFVO56_FLASH_3, null, false, "critical"],
    [FIXTURE_VFVO56_FLASH_4, null, false, "cancel"],
  ] as const)("本番 presentation の fixture warning corpus: %s", (
    fixture,
    height,
    unknown,
    frameLevel,
  ) => {
    const parsed = parseVolcanoTelegram(createMockWsDataMessage(fixture));
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeight).toBe(height);
    expect(parsed.plumeHeightUnknown).toBe(unknown);
    expect(resolveVolcanoPresentation(parsed, new VolcanoStateHolder()).frameLevel).toBe(frameLevel);
  });
});
