import { describe, expect, it } from "vitest";
import { nextCenterClusterHidden, type CenterClusterItem } from "../center-cluster";

const decide = (previous: readonly CenterClusterItem[], capacity: number, required: Record<string, number>) => nextCenterClusterHidden({
  previous, capacity, baseGap: 10,
  unresolved: (hidden, available) => available < (required[hidden.join(",")] ?? Number.POSITIVE_INFINITY),
});

describe("center-cluster reduction hysteresis", () => {
  it("holds below H and restores recent then stats above H", () => {
    expect(decide(["stats", "recent-quakes"], 119, { "stats": 100 })).toEqual(["stats", "recent-quakes"]);
    expect(decide(["stats", "recent-quakes"], 120, { "stats": 99 })).toEqual(["stats"]);
    expect(decide(["stats"], 120, { "": 99 })).toEqual([]);
  });
  it("reduces stats before recent-quakes and has no clock member", () => {
    expect(decide([], 100, { "": 101, "stats": 100 })).toEqual(["stats"]);
    expect(decide([], 100, { "": 101, "stats": 101 })).toEqual(["stats", "recent-quakes"]);
  });
});
