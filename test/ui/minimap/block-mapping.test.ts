import { describe, it, expect } from "vitest";
import { mapAreaToBlock, BLOCK_DEFS, ALL_BLOCK_IDS } from "../../../src/ui/minimap";

describe("mapAreaToBlock", () => {
  it("maps '石川県能登地方' to HKR", () => {
    expect(mapAreaToBlock("石川県能登地方")).toBe("HKR");
  });

  it("maps '東京都' to KKS (mainland Tokyo)", () => {
    expect(mapAreaToBlock("東京都")).toBe("KKS");
  });

  it("maps '沖縄県' to OKN", () => {
    expect(mapAreaToBlock("沖縄県")).toBe("OKN");
  });

  it("maps '北海道太平洋沿岸東部' to HKD", () => {
    expect(mapAreaToBlock("北海道太平洋沿岸東部")).toBe("HKD");
  });

  it("maps '東京島しょ' to IZO (not KKS)", () => {
    expect(mapAreaToBlock("東京島しょ")).toBe("IZO");
  });

  it("maps '小笠原諸島' to IZO", () => {
    expect(mapAreaToBlock("小笠原諸島")).toBe("IZO");
  });

  it("maps '福岡県' to KNB", () => {
    expect(mapAreaToBlock("福岡県")).toBe("KNB");
  });

  it("maps '宮崎県' to KNS", () => {
    expect(mapAreaToBlock("宮崎県")).toBe("KNS");
  });

  it("maps '奄美群島' to KNS", () => {
    expect(mapAreaToBlock("奄美群島")).toBe("KNS");
  });

  it("maps '兵庫県南部' to KIN", () => {
    expect(mapAreaToBlock("兵庫県南部")).toBe("KIN");
  });

  it("returns null for unknown area name", () => {
    expect(mapAreaToBlock("不明な地域")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(mapAreaToBlock("")).toBeNull();
  });
});

describe("BLOCK_DEFS", () => {
  it("has exactly 12 blocks", () => {
    expect(BLOCK_DEFS).toHaveLength(12);
  });

  it("ALL_BLOCK_IDS matches BLOCK_DEFS order", () => {
    expect(ALL_BLOCK_IDS).toEqual(BLOCK_DEFS.map((b) => b.id));
  });
});
