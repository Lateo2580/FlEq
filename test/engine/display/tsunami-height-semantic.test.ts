import { describe, expect, it, vi } from "vitest";
import * as log from "../../../src/logger";
import type { SpecialValue } from "../../../src/types";
import { projectTsunamiHeightSemantic } from "../../../src/engine/display/tsunami-height-semantic";

function value(over: Partial<SpecialValue<number>> = {}): SpecialValue<number> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "unknown",
    lowerBound: null,
    upperBound: null,
    rawLowerBound: null,
    rawUpperBound: null,
    ...over,
  };
}

describe("projectTsunamiHeightSemantic", () => {
  it.each([
    ["exact", value({ raw: "3", value: 3, description: "３ｍ", presence: "value" }), {
      presence: "value", label: "３ｍ", value: 3, lowerBound: null, upperBound: null,
      badge: null, color: "normalRank", render: true,
    }],
    ["lower bound", value({ raw: "3", description: "巨大", presence: "qualitative", lowerBound: 3, rawLowerBound: "3" }), {
      presence: "qualitative", label: "巨大", value: null, lowerBound: 3, upperBound: null,
      badge: "≥", color: "safetyRank", render: true,
    }],
    ["range", value({ raw: "1〜4", description: "1〜4m", presence: "range", lowerBound: 1, upperBound: 4, rawLowerBound: "1", rawUpperBound: "4" }), {
      presence: "range", label: "1〜4m", value: null, lowerBound: 1, upperBound: 4,
      badge: "↔", color: "safetyUpperRank", render: true,
    }],
    ["qualitative", value({ raw: "巨大", description: "巨大", presence: "qualitative" }), {
      presence: "qualitative", label: "巨大", value: null, lowerBound: null, upperBound: null,
      badge: "?", color: "unknown", render: true,
    }],
    ["unknown", value({ raw: "未入電", description: "不明（未入電）", presence: "unknown" }), {
      presence: "unknown", label: "不明（未入電）", value: null,
      badge: "?", color: "unknown", render: true,
    }],
    ["empty", value({ raw: "", presence: "empty" }), {
      presence: "empty", label: "空欄", value: null, badge: "∅", color: "neutral", render: true,
    }],
    ["missing", value({ raw: null, presence: "missing" }), {
      presence: "missing", label: null, value: null, badge: null, color: "notRendered", render: false,
    }],
  ] as const)("%s の badge/color/render を保持する", (_name, source, expected) => {
    expect(projectTsunamiHeightSemantic(source)).toMatchObject(expected);
  });

  it("numeric body と condition を持つ観測中は exact numeric value と condition を保持する", () => {
    expect(projectTsunamiHeightSemantic(value({
      raw: "0.5", value: 0.5, condition: "観測中", description: "0.5m", presence: "value",
    }))).toMatchObject({
      presence: "value", value: 0.5, label: "0.5m", condition: "観測中", badge: null, render: true,
    });
  });

  it("unknown の raw NaN は保持するが可視 label には使わない", () => {
    expect(projectTsunamiHeightSemantic(value({
      raw: "NaN", condition: null, description: null, presence: "unknown",
    }))).toMatchObject({
      raw: "NaN", presence: "unknown", label: "不明", condition: null,
      value: null, badge: "?", color: "unknown", render: true,
    });
  });

  it("空白だけの description/condition は label 候補から除外する", () => {
    expect(projectTsunamiHeightSemantic(value({
      raw: "NaN", condition: "  ", description: "\t", presence: "unknown",
    }))).toMatchObject({ raw: "NaN", presence: "unknown", label: "不明", badge: "?" });
  });

  it.each([
    ["non-finite exact", value({ raw: "NaN", value: Number.NaN, presence: "value" })],
    ["negative exact", value({ raw: "-0.2", value: -0.2, presence: "value" })],
    ["non-finite bound", value({ raw: "Infinity", presence: "range", upperBound: Number.POSITIVE_INFINITY })],
    ["reversed range", value({ raw: "5〜1", presence: "range", lowerBound: 5, upperBound: 1 })],
    ["value presence with bounds", value({ raw: "3", value: 3, presence: "value", lowerBound: 3 })],
    ["range presence with value", value({ raw: "3", value: 3, presence: "range", lowerBound: 1, upperBound: 3 })],
    ["range without bounds", value({ raw: "", presence: "range" })],
    ["qualitative upper-only", value({ raw: "高い", presence: "qualitative", upperBound: 3 })],
  ] as const)("malformed %s は raw を保持して unknown へ降格する", (_name, malformed) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(projectTsunamiHeightSemantic(malformed)).toMatchObject({
        raw: malformed.raw,
        presence: "unknown",
        label: "不明",
        value: null,
        lowerBound: null,
        upperBound: null,
        badge: "?",
        color: "unknown",
        render: true,
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        "[tsunami-height-semantic] specialValueConflict: malformed TsunamiHeight",
      ));
    } finally {
      warn.mockRestore();
    }
  });

  it("逆転 range の raw bounds が無ければ降格前の数値を文字列で保全する", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(projectTsunamiHeightSemantic(value({
        raw: "5〜1", presence: "range", lowerBound: 5, upperBound: 1,
        rawLowerBound: null, rawUpperBound: null,
      }))).toMatchObject({
        presence: "unknown",
        lowerBound: null,
        upperBound: null,
        rawLowerBound: "5",
        rawUpperBound: "1",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("lowerBound exceeds upperBound"));
    } finally {
      warn.mockRestore();
    }
  });

  it("raw 空・bounds なし qualitative は condition の観測中を可視 label にする", () => {
    expect(projectTsunamiHeightSemantic(value({
      raw: "", value: null, condition: "観測中", description: null, presence: "qualitative",
    }))).toMatchObject({
      raw: "", presence: "qualitative", label: "観測中", condition: "観測中",
      value: null, lowerBound: null, upperBound: null, badge: "?", render: true,
    });
  });

  it("qualitative は numeric value が無く、scalar fallback でも zero を生成しない", () => {
    expect(projectTsunamiHeightSemantic(undefined, "巨大")).toMatchObject({
      raw: "巨大", presence: "qualitative", label: "巨大", value: null,
      lowerBound: null, badge: "?", render: true,
    });
  });
});
