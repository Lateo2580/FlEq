import { describe, it, expect } from "vitest";
import { PREF_PLACEMENTS, GRID_ROWS, GRID_COLS } from "../../../src/ui/minimap/grid-layout";

describe("PREF_PLACEMENTS", () => {
  it("has exactly 47 placements", () => {
    expect(PREF_PLACEMENTS).toHaveLength(47);
  });

  it("has no duplicate prefecture IDs", () => {
    const ids = PREF_PLACEMENTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(47);
  });

  it("has no overlapping cells", () => {
    const occupied = new Set<string>();
    for (const p of PREF_PLACEMENTS) {
      for (const cell of p.cells) {
        const key = `${cell.row},${cell.col}`;
        expect(occupied.has(key), `cell (${key}) is occupied by multiple prefectures`).toBe(false);
        occupied.add(key);
      }
    }
  });

  it("all cells are within grid bounds", () => {
    for (const p of PREF_PLACEMENTS) {
      for (const cell of p.cells) {
        expect(cell.row, `${p.id} row ${cell.row}`).toBeGreaterThanOrEqual(0);
        expect(cell.row, `${p.id} row ${cell.row}`).toBeLessThan(GRID_ROWS);
        expect(cell.col, `${p.id} col ${cell.col}`).toBeGreaterThanOrEqual(0);
        expect(cell.col, `${p.id} col ${cell.col}`).toBeLessThan(GRID_COLS);
      }
    }
  });

  it("anchor is always one of the cells", () => {
    for (const p of PREF_PLACEMENTS) {
      const hasAnchor = p.cells.some((c) => c.row === p.anchor.row && c.col === p.anchor.col);
      expect(hasAnchor, `${p.id} anchor (${p.anchor.row},${p.anchor.col}) not in cells`).toBe(true);
    }
  });

  it("HK occupies 8 cells (4×2)", () => {
    const hk = PREF_PLACEMENTS.find((p) => p.id === "HK")!;
    expect(hk.cells).toHaveLength(8);
  });

  it("NI occupies 2 cells (2×1 horizontal)", () => {
    const ni = PREF_PLACEMENTS.find((p) => p.id === "NI")!;
    expect(ni.cells).toHaveLength(2);
    expect(ni.cells[0].row).toBe(ni.cells[1].row);
  });

  it("NA occupies 2 cells (1×2 vertical)", () => {
    const na = PREF_PLACEMENTS.find((p) => p.id === "NA")!;
    expect(na.cells).toHaveLength(2);
    expect(na.cells[0].col).toBe(na.cells[1].col);
  });
});
