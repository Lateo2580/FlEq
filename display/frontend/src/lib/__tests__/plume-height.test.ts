import { describe, expect, it } from "vitest";
import type { DisplayPlumeHeightSemanticV1 } from "../protocol";
import {
  comparablePlumeHeightRank,
  plumeHeightVisual,
} from "../plume-height";

function semantic(
  overrides: Partial<DisplayPlumeHeightSemanticV1>,
): DisplayPlumeHeightSemanticV1 {
  return {
    reference: "aboveCrater",
    unit: "m",
    raw: null,
    presence: "missing",
    label: null,
    condition: null,
    description: null,
    value: null,
    lowerBound: null,
    upperBound: null,
    rawLowerBound: null,
    rawUpperBound: null,
    diagnostics: [],
    badge: null,
    color: "notRendered",
    render: false,
    rank: { kind: "unranked", reference: "aboveCrater", unit: "m" },
    ...overrides,
  };
}

describe("PlumeHeight semantic visual", () => {
  it("card の exact/range/unknown/empty/missing と condition 入り ARIA を固定する", () => {
    expect(plumeHeightVisual(semantic({
      raw: "3000", presence: "value", label: "3000m", value: 3000,
      badge: null, color: "normalRank", render: true,
      rank: { kind: "value", reference: "aboveCrater", unit: "m", value: 3000 },
    }), 3000, false)).toMatchObject({
      render: true, label: "3000m", numericValue: 3000, unit: "m", badge: null,
      tooltip: null, ariaLabel: null,
    });
    expect(plumeHeightVisual(semantic({
      raw: "３０００", presence: "value", label: "3000m", value: 3000,
      badge: null, color: "normalRank", render: true,
      rank: { kind: "value", reference: "aboveCrater", unit: "m", value: 3000 },
    }), null, false)).toMatchObject({
      render: false, numericValue: null, badge: null, tooltip: null, ariaLabel: null,
    });
    expect(plumeHeightVisual(semantic({
      raw: "3000m", presence: "qualitative", label: "3000m",
      diagnostics: ["unmappedSpecialValue"], badge: "?", color: "unknown", render: true,
    }), 3000, false)).toMatchObject({
      render: true, label: "3000m", numericValue: 3000, badge: null,
      tooltip: null, ariaLabel: null,
    });
    expect(plumeHeightVisual(semantic({
      raw: "視程不良", presence: "qualitative", label: "視程不良",
      diagnostics: ["unmappedSpecialValue"], badge: "?", color: "unknown", render: true,
    }), null, false)).toMatchObject({ render: false, badge: null });
    expect(plumeHeightVisual(semantic({}), 3000, false)).toMatchObject({
      render: true, label: "3000m", numericValue: 3000, badge: null,
      tooltip: null, ariaLabel: null,
    });
    expect(plumeHeightVisual(semantic({
      raw: "NaN", presence: "unknown", label: "不明",
      badge: "?", color: "unknown", render: true,
    }), null, false)).toMatchObject({
      render: false, numericValue: null, badge: null, tooltip: null, ariaLabel: null,
    });
    const range = plumeHeightVisual(semantic({
      raw: "3000", presence: "range", label: "3000m以上", condition: "以上",
      lowerBound: 3000, badge: "≥", color: "safetyRank", render: true,
      rank: {
        kind: "range", reference: "aboveCrater", unit: "m",
        lowerBound: 3000, upperBound: null,
      },
    }), 3000, false);
    expect(range).toMatchObject({ label: "3000m以上", badge: "≥", numericValue: null });
    expect(range.tooltip).toContain("条件: 以上");
    expect(range.ariaLabel).toContain("以上、下限値");
    expect(plumeHeightVisual(semantic({
      raw: "観測できず", presence: "unknown", label: "観測できず", condition: "観測できず",
      badge: "?", color: "unknown", render: true,
    }), null, true)).toMatchObject({ label: "観測できず", badge: "?" });
    expect(plumeHeightVisual(semantic({
      raw: "", presence: "empty", label: "（空欄）", badge: "∅", color: "neutral", render: true,
    }), null, false)).toMatchObject({ label: "空欄", badge: "∅" });
    expect(plumeHeightVisual(semantic({}), null, false)).toMatchObject({ render: false, label: "—" });
  });

  it("wire rank は全形状を engine と同じ代表値へ写す", () => {
    expect(comparablePlumeHeightRank({
      kind: "value", reference: "aboveCrater", unit: "m", value: 3000,
    })).toBe(3000);
    expect(comparablePlumeHeightRank({
      kind: "range", reference: "aboveCrater", unit: "m", lowerBound: 2000, upperBound: 4000,
    })).toBe(2000);
    expect(comparablePlumeHeightRank({
      kind: "range", reference: "aboveCrater", unit: "m", lowerBound: null, upperBound: 4000,
    })).toBe(4000);
    expect(comparablePlumeHeightRank({
      kind: "unranked", reference: "aboveCrater", unit: "m",
    })).toBeNull();
  });
});
