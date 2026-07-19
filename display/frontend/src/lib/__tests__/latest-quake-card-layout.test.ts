import { describe, expect, it } from "vitest";
import { shouldCompactTopGroup, splitTopGroup, TOP_GROUP_COMPACT_AREA_THRESHOLD } from "../latest-quake-card-layout";
import type { DisplayIntensityGroupV1 } from "../protocol";

function group(intensity: string, rank: number, areas: string[]): DisplayIntensityGroupV1 {
  return { intensity, rank, areas, omittedAreaCount: 0 };
}

describe("splitTopGroup", () => {
  it("先頭 (最大震度) を top、残りを rest として分割する", () => {
    const groups = [group("7", 9, ["宮城県栗原市"]), group("6強", 8, ["福島県白河市"]), group("6弱", 7, ["岩手県大船渡市"])];
    const { top, rest } = splitTopGroup(groups);
    expect(top).toEqual(groups[0]);
    expect(rest).toEqual([groups[1], groups[2]]);
  });

  it("1件のみなら top だけで rest は空", () => {
    const groups = [group("5弱", 5, ["宮崎市"])];
    const { top, rest } = splitTopGroup(groups);
    expect(top).toEqual(groups[0]);
    expect(rest).toEqual([]);
  });

  it("空配列なら top は null、rest は空", () => {
    const { top, rest } = splitTopGroup([]);
    expect(top).toBeNull();
    expect(rest).toEqual([]);
  });
});

describe("shouldCompactTopGroup", () => {
  it("null なら false", () => {
    expect(shouldCompactTopGroup(null)).toBe(false);
  });

  it("地域件数が閾値以下なら false (3.11 級相当)", () => {
    expect(shouldCompactTopGroup(group("6強", 8, Array.from({ length: 19 }, (_, i) => `地域${i}`)))).toBe(false);
    expect(shouldCompactTopGroup(group("7", 9, Array.from({ length: TOP_GROUP_COMPACT_AREA_THRESHOLD }, (_, i) => `地域${i}`)))).toBe(false);
  });

  it("地域件数が閾値を超えたら true (南海トラフ級、153件相当)", () => {
    expect(shouldCompactTopGroup(group("7", 9, Array.from({ length: TOP_GROUP_COMPACT_AREA_THRESHOLD + 1 }, (_, i) => `地域${i}`)))).toBe(true);
    expect(shouldCompactTopGroup(group("7", 9, Array.from({ length: 153 }, (_, i) => `地域${i}`)))).toBe(true);
  });
});
