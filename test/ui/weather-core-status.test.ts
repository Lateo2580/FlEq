import { describe, it, expect } from "vitest";
import { formatTransitionStatus } from "../../src/ui/weather-core-status";
import type { WarningEntry } from "../../src/ui/weather-core-entry";

function entry(p: Partial<WarningEntry>): WarningEntry {
  return {
    id: "x", kindCode: "03", kindName: "大雨警報", phenomenonFamily: "heavyRain",
    officialAlertLevel: 3, displaySeverity: "officialL3", resolutionSource: "map",
    status: "発表", areaName: "A", ...p,
  };
}

describe("formatTransitionStatus", () => {
  it("発表 + lastKindCode なし → '発表 ▲新規'", () => {
    expect(formatTransitionStatus(entry({ status: "発表" }))).toBe("発表 ▲新規");
  });
  it("同 family 低 severity → '▲ 注→警'", () => {
    expect(formatTransitionStatus(entry({
      status: "発表", lastKindCode: "10", lastKindName: "レベル２大雨注意報", displaySeverity: "officialL3",
    }))).toBe("▲ 注→警");
  });
  it("同 family 高 severity → '▽ 警→注'", () => {
    expect(formatTransitionStatus(entry({
      status: "発表", lastKindCode: "03", lastKindName: "レベル３大雨警報",
      displaySeverity: "officialL2", officialAlertLevel: 2,
    }))).toBe("▽ 警→注");
  });
  it("継続 → '継続'", () => {
    expect(formatTransitionStatus(entry({ status: "継続" }))).toBe("継続");
  });
  it("解除 → '▼解除'", () => {
    expect(formatTransitionStatus(entry({ status: "解除", displaySeverity: "release" }))).toBe("▼解除");
  });
});
