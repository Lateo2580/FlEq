import { describe, it, expect } from "vitest";
import type { JmaIntensity, JmaLgIntensity, SpecialValue } from "../../src/types";
import {
  evaluateIntensitySafetyRank,
  evaluateLgIntensitySafetyRank,
  intensityToRank,
  eewPessimisticIntensity,
  specialValueDisplaySemantic,
} from "../../src/utils/intensity";

describe("eewPessimisticIntensity (To 基準・悲観側)", () => {
  it("To 未設定なら From を返す", () => {
    expect(eewPessimisticIntensity("4")).toBe("4");
  });
  it("To が From より強ければ To を返す", () => {
    expect(eewPessimisticIntensity("4", "5-")).toBe("5-");
    expect(eewPessimisticIntensity("5-", "5+")).toBe("5+");
  });
  it("To が From 以下なら From を維持する (防御)", () => {
    expect(eewPessimisticIntensity("5-", "4")).toBe("5-");
  });
  it("To が不明ランク (over 等の特殊値) なら From に fallback する", () => {
    expect(eewPessimisticIntensity("5-", "over")).toBe("5-");
    expect(intensityToRank("over")).toBe(0); // fallback の前提
  });
});

function intensityValue(over: Partial<SpecialValue<JmaIntensity>>): SpecialValue<JmaIntensity> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
    ...over,
  };
}

function lgIntensityValue(over: Partial<SpecialValue<JmaLgIntensity>>): SpecialValue<JmaLgIntensity> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
    ...over,
  };
}

describe("evaluateIntensitySafetyRank", () => {
  it.each([
    ["exact 0", intensityValue({ raw: "0", value: "0", presence: "value" }), { kind: "known", lower: 0, upper: 0 }],
    ["exact 5弱", intensityValue({ raw: "5-", value: "5-", presence: "value" }), { kind: "known", lower: 5, upper: 5 }],
    ["range", intensityValue({ raw: "", presence: "range", lowerBound: "3", upperBound: "4" }), { kind: "known", lower: 3, upper: 4 }],
    ["lower only", intensityValue({ raw: "", presence: "range", lowerBound: "5-", upperBound: null }), { kind: "known", lower: 5, upper: null }],
    ["upper only", intensityValue({ raw: "", presence: "range", lowerBound: null, upperBound: "4" }), { kind: "known", lower: 0, upper: 4 }],
    ["missing", intensityValue({ presence: "missing" }), { kind: "unknown" }],
    ["empty", intensityValue({ raw: "", presence: "empty" }), { kind: "unknown" }],
    ["plain 未入電", intensityValue({ raw: "", condition: "未入電", presence: "unknown" }), { kind: "unknown" }],
    ["qualitative without bounds", intensityValue({ raw: "推定不能", presence: "qualitative" }), { kind: "unknown" }],
    ["5弱以上未入電", intensityValue({ raw: "", condition: "5弱以上未入電", presence: "qualitative", lowerBound: "5-" }), { kind: "known", lower: 5, upper: null }],
  ] as const)("%s", (_label, value, expected) => {
    expect(evaluateIntensitySafetyRank(value)).toEqual(expected);
  });

  it("plain 未入電と exact 震度0を kind で分離する", () => {
    expect(evaluateIntensitySafetyRank(intensityValue({ condition: "未入電", presence: "unknown" }))).toEqual({ kind: "unknown" });
    expect(evaluateIntensitySafetyRank(intensityValue({ raw: "0", value: "0", presence: "value" }))).toEqual({ kind: "known", lower: 0, upper: 0 });
  });
});

describe("evaluateLgIntensitySafetyRank", () => {
  it.each([
    ["exact 0", lgIntensityValue({ raw: "0", value: "0", presence: "value" }), { kind: "known", lower: 0, upper: 0 }],
    ["exact 4", lgIntensityValue({ raw: "4", value: "4", presence: "value" }), { kind: "known", lower: 4, upper: 4 }],
    ["range", lgIntensityValue({ raw: "", presence: "range", lowerBound: "1", upperBound: "3" }), { kind: "known", lower: 1, upper: 3 }],
    ["lower only", lgIntensityValue({ raw: "", presence: "range", lowerBound: "2", upperBound: null }), { kind: "known", lower: 2, upper: null }],
    ["未入電", lgIntensityValue({ condition: "未入電", presence: "unknown" }), { kind: "unknown" }],
  ] as const)("%s", (_label, value, expected) => {
    expect(evaluateLgIntensitySafetyRank(value)).toEqual(expected);
  });
});

describe("specialValueDisplaySemantic", () => {
  it.each([
    ["exact", intensityValue({ raw: "4", value: "4", presence: "value" }), { kind: "exact", color: "normalRank", badge: null, render: true }],
    ["lower bound", intensityValue({ presence: "range", lowerBound: "5-", upperBound: null }), { kind: "lowerBound", color: "safetyRank", badge: "≥", render: true }],
    ["range", intensityValue({ presence: "range", lowerBound: "3", upperBound: "4" }), { kind: "range", color: "safetyUpperRank", badge: "↔", render: true }],
    ["qualitative lower", intensityValue({ condition: "5弱以上未入電", presence: "qualitative", lowerBound: "5-" }), { kind: "lowerBound", color: "safetyRank", badge: "≥", render: true }],
    ["qualitative lower with upper", intensityValue({ presence: "qualitative", lowerBound: "5-", upperBound: "7" }), { kind: "lowerBound", color: "safetyRank", badge: "≥", render: true }],
    ["qualitative without bounds", intensityValue({ raw: "推定不能", presence: "qualitative" }), { kind: "unknown", color: "unknown", badge: "?", render: true }],
    ["unknown", intensityValue({ condition: "未入電", presence: "unknown" }), { kind: "unknown", color: "unknown", badge: "?", render: true }],
    ["empty", intensityValue({ raw: "", presence: "empty" }), { kind: "empty", color: "neutral", badge: "∅", render: true }],
    ["missing", intensityValue({ presence: "missing" }), { kind: "missing", color: "notRendered", badge: null, render: false }],
  ] as const)("%s", (_label, value, expected) => {
    expect(specialValueDisplaySemantic(value)).toEqual(expected);
  });
});
