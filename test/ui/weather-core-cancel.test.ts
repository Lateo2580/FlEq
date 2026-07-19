import { describe, it, expect } from "vitest";
import { countActiveAndRelease, isCancelPath, isReleaseOnlyPath } from "../../src/ui/weather-core-cancel";
import type { WarningEntry } from "../../src/ui/weather-core-entry";

function st(status: string): WarningEntry {
  return {
    id: "x", kindCode: "03", kindName: "大雨警報", phenomenonFamily: "heavyRain",
    officialAlertLevel: 3, displaySeverity: "officialL3", resolutionSource: "map",
    status, areaName: "A",
  };
}

describe("countActiveAndRelease", () => {
  it("発表/継続=active、解除=release", () => {
    const e = [st("発表"), st("継続"), st("解除"), st("解除")];
    expect(countActiveAndRelease(e)).toEqual({ activeCount: 2, releaseCount: 2 });
  });
});

describe("isCancelPath / isReleaseOnlyPath", () => {
  it("infoType=取消 → isCancelPath", () => {
    expect(isCancelPath("取消", { activeCount: 0, releaseCount: 0 })).toBe(true);
  });
  it("発表 + active=0 + release>0 → isReleaseOnlyPath", () => {
    expect(isReleaseOnlyPath("発表", { activeCount: 0, releaseCount: 3 })).toBe(true);
  });
  it("発表 + active>0 → どちらでもない", () => {
    expect(isCancelPath("発表", { activeCount: 1, releaseCount: 0 })).toBe(false);
    expect(isReleaseOnlyPath("発表", { activeCount: 1, releaseCount: 0 })).toBe(false);
  });
  it("取消 は isReleaseOnlyPath にならない", () => {
    expect(isReleaseOnlyPath("取消", { activeCount: 0, releaseCount: 3 })).toBe(false);
  });
});
