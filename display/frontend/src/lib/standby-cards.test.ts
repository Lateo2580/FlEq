import { describe, expect, it } from "vitest";
import type { ActiveStandbyCardV1 } from "./protocol";
import { partitionStandbyItems, selectRightStack } from "./standby-cards";

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
      item("longPeriod", "quake-rider"), item("nankaiTrough", "clock-below"), item("future", "future-surface"),
    ];
    expect(() => partitionStandbyItems(items)).not.toThrow();
    const result = partitionStandbyItems(items);
    expect(result.cornerRight.map((candidate) => candidate.key)).toEqual(["heat"]);
    expect(result.clockTopWide.map((candidate) => candidate.key)).toEqual(["flood"]);
    expect(result.weatherRider.map((candidate) => candidate.key)).toEqual(["tornado"]);
    expect(result.quakeRider.map((candidate) => candidate.key)).toEqual(["longPeriod"]);
    expect(result.clockBelow.map((candidate) => candidate.key)).toEqual(["nankaiTrough"]);
    expect(result.unknown.map((candidate) => candidate.key)).toEqual(["future"]);
  });

  it("applies the right-stack budget at card boundaries and sends oversized cards to overflow", () => {
    const cards = [item("heat", "corner-right", "first"), item("typhoon", "corner-right", "second"), item("volcano", "corner-right", "third")];
    const heights = new Map([["first", 300], ["second", 500], ["third", 200]]);
    const result = selectRightStack(cards, 700, (candidate) => heights.get(candidate.key)!);
    expect(result.visible.map((candidate) => candidate.key)).toEqual(["first", "third"]);
    expect(result.overflow.map((candidate) => candidate.key)).toEqual(["second"]);
  });
});
