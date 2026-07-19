import { describe, it, expect } from "vitest";
import { intensityToRank, eewPessimisticIntensity } from "../../src/utils/intensity";

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
