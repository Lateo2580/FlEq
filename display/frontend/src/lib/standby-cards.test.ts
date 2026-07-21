import { describe, expect, it } from "vitest";
import type { ActiveStandbyCardV1 } from "./protocol";
import {
  partitionStandbyItems,
  rightStackBudgetPx,
  selectRightStack,
  selectRightStackWithSummary,
} from "./standby-cards";

function item(kind: string, surface: string, key = kind): ActiveStandbyCardV1 {
  return {
    kind, surface, key, sourceEventIds: [], updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: null,
    restored: false, severity: "warning", data: {},
  } as unknown as ActiveStandbyCardV1;
}

describe("standby-cards", () => {
  it("partitions every supported surface and keeps unknown data without throwing", () => {
    const items = [
      item("heat", "corner-right"), item("flood", "clock-top-wide"), item("tornado", "weather-rider"),
      item("longPeriod", "quake-rider"), item("nankaiTrough", "clock-below"),
      item("future", "corner-right", "future-known-surface"), item("future", "future-surface"),
    ];
    expect(() => partitionStandbyItems(items)).not.toThrow();
    const result = partitionStandbyItems(items);
    expect(result.cornerRight.map((candidate) => candidate.key)).toEqual(["heat"]);
    expect(result.clockTopWide.map((candidate) => candidate.key)).toEqual(["flood"]);
    expect(result.weatherRider.map((candidate) => candidate.key)).toEqual(["tornado"]);
    expect(result.quakeRider.map((candidate) => candidate.key)).toEqual(["longPeriod"]);
    expect(result.clockBelow.map((candidate) => candidate.key)).toEqual(["nankaiTrough"]);
    expect(result.unknown.map((candidate) => candidate.key)).toEqual(["future-known-surface", "future"]);
  });

  it("applies the right-stack budget at card boundaries and sends oversized cards to overflow", () => {
    const cards = [item("heat", "corner-right", "first"), item("typhoon", "corner-right", "second"), item("volcano", "corner-right", "third")];
    const heights = new Map([["first", 300], ["second", 500], ["third", 200]]);
    const result = selectRightStack(cards, 700, (candidate) => heights.get(candidate.key)!);
    expect(result.visible.map((candidate) => candidate.key)).toEqual(["first", "third"]);
    expect(result.overflow.map((candidate) => candidate.key)).toEqual(["second"]);
  });

  it("720p 相当で WeatherAlertCard と overflow 要約を予算に含め、要約領域を常に予約する", () => {
    // 720px viewport - 80px ticker = 640px standby。CSS の上下余白 24px と一致させる。
    const budget = rightStackBudgetPx(640, 280, 0, 12);
    expect(budget).toBe(300);
    const cards = [item("volcano", "corner-right", "volcano"), item("typhoon", "corner-right", "typhoon")];
    const result = selectRightStackWithSummary(cards, budget, () => 180, 32, false, 12);
    expect(result.visible.map((candidate) => candidate.key)).toEqual(["volcano"]);
    expect(result.overflow.map((candidate) => candidate.key)).toEqual(["typhoon"]);
    expect(result.usedPx + result.summaryReservedPx).toBeLessThanOrEqual(budget);
    expect(result.summaryReservedPx).toBe(44);
  });
});
