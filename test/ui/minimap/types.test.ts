import { describe, it, expect } from "vitest";
import type { PrefId, PrefDef, MinimapCell } from "../../../src/ui/minimap/types";

describe("PrefId type", () => {
  it("accepts valid prefecture codes", () => {
    const ids: PrefId[] = [
      "HK", "AO", "IT", "MG", "AK", "YG", "FS",
      "IB", "TC", "GU", "ST", "CB", "TY", "KN",
      "NI", "TM", "IS", "FI", "YN", "NA", "GI", "SZ", "AI", "ME",
      "SI", "KY", "OS", "HG", "NR", "WA",
      "TT", "SM", "OY", "HS", "YA",
      "TK", "KA", "EH", "KO",
      "FO", "SG", "NS", "KU", "OI", "MZ", "KG", "OK",
    ];
    expect(ids).toHaveLength(47);
  });
});

describe("MinimapCell", () => {
  it("can be constructed with PrefId", () => {
    const cell: MinimapCell = { prefId: "TY", content: "6+", color: undefined };
    expect(cell.prefId).toBe("TY");
    expect(cell.content).toBe("6+");
  });
});
