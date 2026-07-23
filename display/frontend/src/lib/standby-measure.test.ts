import { describe, expect, it } from "vitest";
import type { ActiveStandbyCardV1 } from "./protocol";
import { allMeasured, applyMeasurements, heightEstimator, pruneMeasurements } from "./standby-measure";

function card(key: string, updatedAt: string): ActiveStandbyCardV1 {
  return {
    key,
    sourceEventIds: [],
    updatedAt,
    expiresAt: null,
    restored: false,
    severity: "normal",
    kind: "typhoon",
    surface: "corner-right",
    data: { typhoons: [] },
  };
}

describe("standby-measure", () => {
  it("returns an immutable map and ignores sub-pixel same-version changes", () => {
    const m1 = applyMeasurements(new Map(), [{ key: "a", version: "v1", height: 100 }]);
    const m2 = applyMeasurements(m1, [{ key: "a", version: "v1", height: 100.5 }]);
    expect(m2.get("a")?.height).toBe(100);
    expect(m2).not.toBe(m1);

    const m3 = applyMeasurements(m2, [{ key: "a", version: "v1", height: 102 }]);
    expect(m3.get("a")?.height).toBe(102);
  });

  it("always accepts a new version even when the height delta is below one pixel", () => {
    const m1 = applyMeasurements(new Map(), [{ key: "a", version: "v1", height: 100 }]);
    const m2 = applyMeasurements(m1, [{ key: "a", version: "v2", height: 100.5 }]);
    expect(m2.get("a")).toEqual({ version: "v2", height: 100.5 });
  });

  it("requires every current item to have a matching measurement version", () => {
    const m = applyMeasurements(new Map(), [{ key: "a", version: "v1", height: 100 }]);
    expect(allMeasured(m, [{ key: "a", updatedAt: "v1" }])).toBe(true);
    expect(allMeasured(m, [{ key: "a", updatedAt: "v2" }])).toBe(false);
    expect(allMeasured(m, [{ key: "a", updatedAt: "v1" }, { key: "b", updatedAt: "v1" }])).toBe(false);
  });

  it("uses fallback for every item until all current items are measured, then uses measured heights", () => {
    const items = [card("a", "v1"), card("b", "v1")];
    const partial = applyMeasurements(new Map(), [{ key: "a", version: "v1", height: 120 }]);
    const estimatePartial = heightEstimator(partial, items, () => 240);
    expect(estimatePartial(items[0])).toBe(240);

    const full = applyMeasurements(partial, [{ key: "b", version: "v1", height: 130 }]);
    const estimateFull = heightEstimator(full, items, () => 240);
    expect(estimateFull(items[0])).toBe(120);
    expect(estimateFull(items[1])).toBe(130);
  });

  it("prunes measurements for items that no longer exist", () => {
    const measured = applyMeasurements(new Map(), [
      { key: "a", version: "v1", height: 1 },
      { key: "b", version: "v1", height: 2 },
    ]);
    expect([...pruneMeasurements(measured, [{ key: "a" }]).keys()]).toEqual(["a"]);
  });

  it("returns the same map when pruning removes nothing", () => {
    const measured = applyMeasurements(new Map(), [{ key: "a", version: "v1", height: 1 }]);
    expect(pruneMeasurements(measured, [{ key: "a" }])).toBe(measured);
  });
});

describe("standby-measure: 不正値ガード", () => {
  it("非有限・0 以下の高さ update は無視される", () => {
    const m1 = applyMeasurements(new Map(), [{ key: "a", version: "v1", height: 100 }]);
    const m2 = applyMeasurements(m1, [
      { key: "a", version: "v2", height: 0 },
      { key: "b", version: "v1", height: Number.NaN },
      { key: "c", version: "v1", height: -5 },
    ]);
    expect(m2.get("a")).toEqual({ version: "v1", height: 100 });
    expect(m2.has("b")).toBe(false);
    expect(m2.has("c")).toBe(false);
  });
});
