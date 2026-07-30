import { describe, expect, it } from "vitest";
import { quakeMapRankClass, quakeMapRankToken } from "../quake-map-colors";

describe("quake map colors", () => {
  it("rank 1〜9 を既存 --int-* token と同じ意味へ対応させる", () => {
    expect(Array.from({ length: 9 }, (_, index) => quakeMapRankClass(index + 1))).toEqual([
      "quake-map-rank-1",
      "quake-map-rank-2",
      "quake-map-rank-3",
      "quake-map-rank-4",
      "quake-map-rank-5",
      "quake-map-rank-6",
      "quake-map-rank-7",
      "quake-map-rank-8",
      "quake-map-rank-9",
    ]);
    expect(Array.from({ length: 9 }, (_, index) => quakeMapRankToken(index + 1))).toEqual([
      "var(--int-1)",
      "var(--int-2)",
      "var(--int-3)",
      "var(--int-4)",
      "var(--int-5)",
      "var(--int-6)",
      "var(--int-7)",
      "var(--int-8-bg)",
      "var(--int-9-bg)",
    ]);
  });

  it("未観測と未知震度を別 class にする", () => {
    expect(quakeMapRankClass(undefined)).toBe("quake-map-unobserved");
    expect(quakeMapRankClass(null)).toBe("quake-map-unobserved");
    expect(quakeMapRankClass(0)).toBe("quake-map-unknown");
    expect(quakeMapRankClass(10)).toBe("quake-map-unknown");
    expect(quakeMapRankClass(1.5)).toBe("quake-map-unknown");
    expect(quakeMapRankToken(10)).toBeNull();
  });
});
