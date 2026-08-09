import { describe, expect, it } from "vitest";
import type { DisplayMagnitudeSemanticV1 } from "../protocol";
import {
  comparableMagnitudeRank,
  depthVisual,
  magnitudeVisual,
} from "../magnitude";

function semantic(overrides: Partial<DisplayMagnitudeSemanticV1>): DisplayMagnitudeSemanticV1 {
  return {
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
    badge: null,
    color: "notRendered",
    render: false,
    rank: { kind: "unranked" },
    ...overrides,
  };
}

describe("Magnitude/Depth semantic visual", () => {
  it("card の missing/empty/unknown/range と badge・condition・ARIA を固定する", () => {
    expect(magnitudeVisual(semantic({}), "9.0")).toMatchObject({ label: "—", badge: null, render: true });
    expect(depthVisual(semantic({ presence: "empty", label: "（空欄）", badge: "∅", color: "neutral", render: true }), "10km"))
      .toMatchObject({ label: "空欄", badge: "∅" });
    const unknown = magnitudeVisual(semantic({
      presence: "unknown", label: "M不明", condition: "不明", badge: "?", color: "unknown", render: true,
    }), "8.0");
    expect(unknown).toMatchObject({ label: "M不明", badge: "?" });
    expect(unknown.ariaLabel).toContain("条件: 不明");
    expect(depthVisual(semantic({
      presence: "range", label: "600km以上", condition: "600km以上", lowerBound: 600,
      badge: "≥", color: "safetyRank", render: true,
    }), "600km")).toMatchObject({ label: "600km以上", badge: "≥" });
  });

  it("map は semantic missing を描画せず、旧 scalar は fallback する", () => {
    expect(magnitudeVisual(semantic({}), "9.0", "map").render).toBe(false);
    expect(magnitudeVisual(undefined, "7.3", "map")).toMatchObject({ label: "M7.3", render: true });
  });

  it("SerializableMagnitudeRank は巨大を JSON 後も最上位として比較する", () => {
    const roundTrip = JSON.parse(JSON.stringify({ rank: { kind: "giant" } })) as { rank: { kind: "giant" } };
    expect(comparableMagnitudeRank(roundTrip.rank)).toBe(Number.POSITIVE_INFINITY);
    expect(comparableMagnitudeRank({ kind: "value", value: 9 })).toBe(9);
    expect(comparableMagnitudeRank({ kind: "range", lowerBound: 5, upperBound: 7 })).toBe(5);
    expect(comparableMagnitudeRank({ kind: "range", lowerBound: null, upperBound: 7 })).toBe(7);
  });
});
