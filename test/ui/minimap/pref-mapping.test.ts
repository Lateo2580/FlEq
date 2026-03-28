import { describe, it, expect } from "vitest";
import { mapAreaToPref, PREF_DEFS } from "../../../src/ui/minimap/pref-mapping";

describe("PREF_DEFS", () => {
  it("has exactly 47 definitions", () => {
    expect(PREF_DEFS).toHaveLength(47);
  });
});

describe("mapAreaToPref", () => {
  it("maps '石川県能登地方' to IS", () => {
    expect(mapAreaToPref("石川県能登地方")).toBe("IS");
  });

  it("maps '東京都23区' to TY", () => {
    expect(mapAreaToPref("東京都23区")).toBe("TY");
  });

  it("maps '沖縄県' to OK", () => {
    expect(mapAreaToPref("沖縄県")).toBe("OK");
  });

  it("maps '北海道太平洋沿岸東部' to HK", () => {
    expect(mapAreaToPref("北海道太平洋沿岸東部")).toBe("HK");
  });

  it("maps '福岡県' to FO", () => {
    expect(mapAreaToPref("福岡県")).toBe("FO");
  });

  it("maps '宮崎県' to MZ", () => {
    expect(mapAreaToPref("宮崎県")).toBe("MZ");
  });

  it("maps '兵庫県南部' to HG", () => {
    expect(mapAreaToPref("兵庫県南部")).toBe("HG");
  });

  it("maps '長野県中部' to NA", () => {
    expect(mapAreaToPref("長野県中部")).toBe("NA");
  });

  it("maps '東京島しょ部' to TY (not separate)", () => {
    expect(mapAreaToPref("東京島しょ部")).toBe("TY");
  });

  it("maps '小笠原諸島' to TY", () => {
    expect(mapAreaToPref("小笠原諸島")).toBe("TY");
  });

  it("maps '奄美群島' to KG", () => {
    expect(mapAreaToPref("奄美群島")).toBe("KG");
  });

  it("returns null for unknown area name", () => {
    expect(mapAreaToPref("不明な地域")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(mapAreaToPref("")).toBeNull();
  });
});
