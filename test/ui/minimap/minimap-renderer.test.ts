import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import type { PresentationEvent, PresentationAreaItem } from "../../../src/engine/presentation/types";
import type { MinimapCell, BlockId } from "../../../src/ui/minimap/types";
import {
  renderMinimap,
  buildMinimapCells,
  shouldShowMinimap,
  renderMinimapForEvent,
  ALL_BLOCK_IDS,
} from "../../../src/ui/minimap";

// ── Helpers ──

/** Create a minimal PresentationEvent for testing */
function makePresentationEvent(
  overrides: Partial<PresentationEvent> & { domain: PresentationEvent["domain"] },
): PresentationEvent {
  return {
    id: "test-id",
    classification: "telegram.earthquake",
    domain: "earthquake",
    type: "VXSE53",
    infoType: "発表",
    title: "テスト",
    headline: null,
    reportDateTime: "2024-01-01T00:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "warning",
    isCancellation: false,
    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw: null,
    ...overrides,
  };
}

function makeAreaItem(name: string, maxInt?: string, kind?: string): PresentationAreaItem {
  return { name, maxInt, kind };
}

// ── renderMinimap ──

describe("renderMinimap", () => {
  it("produces 4 lines of output", () => {
    const cells: MinimapCell[] = ALL_BLOCK_IDS.map((blockId) => ({
      blockId,
      content: ".",
    }));
    const lines = renderMinimap(cells);
    expect(lines).toHaveLength(4);
  });

  it("renders HKD on the first line (indented)", () => {
    const cells: MinimapCell[] = ALL_BLOCK_IDS.map((blockId) => ({
      blockId,
      content: blockId === "HKD" ? "4" : ".",
    }));
    const lines = renderMinimap(cells);
    // HKD is at col 3 -> 27 chars of leading space
    expect(lines[0]).toContain("HKD 4");
  });

  it("renders the correct blocks on each row", () => {
    const cells: MinimapCell[] = ALL_BLOCK_IDS.map((blockId) => ({
      blockId,
      content: ".",
    }));
    const lines = renderMinimap(cells);

    // Row 0: HKD
    expect(lines[0]).toContain("HKD");
    // Row 1: TOH, KKS, IZO
    expect(lines[1]).toContain("TOH");
    expect(lines[1]).toContain("KKS");
    expect(lines[1]).toContain("IZO");
    // Row 2: HKR, TOK, KIN, CHG
    expect(lines[2]).toContain("HKR");
    expect(lines[2]).toContain("TOK");
    expect(lines[2]).toContain("KIN");
    expect(lines[2]).toContain("CHG");
    // Row 3: SKK, KNB, KNS, OKN
    expect(lines[3]).toContain("SKK");
    expect(lines[3]).toContain("KNB");
    expect(lines[3]).toContain("KNS");
    expect(lines[3]).toContain("OKN");
  });

  it("applies color to cells with a color property", () => {
    const prevLevel = chalk.level;
    chalk.level = 3; // force color output
    try {
      const cells: MinimapCell[] = [
        { blockId: "HKD", content: "4", color: chalk.red },
        ...ALL_BLOCK_IDS.filter((id) => id !== "HKD").map(
          (blockId) => ({ blockId, content: "." }) as MinimapCell,
        ),
      ];
      const lines = renderMinimap(cells);
      // The HKD cell should contain ANSI escape codes from chalk.red
      expect(lines[0]).toContain("\u001b[");
    } finally {
      chalk.level = prevLevel;
    }
  });
});

// ── buildMinimapCells ──

describe("buildMinimapCells", () => {
  it("builds cells for earthquake with area items", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 3,
      areaItems: [
        makeAreaItem("石川県能登", "6+"),
        makeAreaItem("新潟県上越", "5-"),
        makeAreaItem("石川県加賀", "5+"),
      ],
    });
    const cells = buildMinimapCells(event);
    const hkr = cells.find((c) => c.blockId === "HKR");
    const niigata = cells.find((c) => c.blockId === "HKR");
    // HKR should have the max of "6+" (石川) and "5-" (新潟 also in HKR)
    expect(hkr?.content).toBe("6+");
  });

  it("builds cells for tsunami with kind-based abbreviation", () => {
    const event = makePresentationEvent({
      domain: "tsunami",
      classification: "telegram.earthquake",
      type: "VTSE41",
      areaCount: 2,
      forecastAreaCount: 2,
      frameLevel: "critical",
      areaItems: [
        makeAreaItem("北海道太平洋沿岸東部", undefined, "大津波警報"),
        makeAreaItem("青森県日本海沿岸", undefined, "津波警報"),
      ],
    });
    const cells = buildMinimapCells(event);
    const hkd = cells.find((c) => c.blockId === "HKD");
    const toh = cells.find((c) => c.blockId === "TOH");
    expect(hkd?.content).toBe("MJ");
    expect(toh?.content).toBe("WN");
  });

  it("fills unmatched blocks with '.'", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 1,
      areaItems: [makeAreaItem("沖縄県", "3")],
    });
    const cells = buildMinimapCells(event);
    const hkd = cells.find((c) => c.blockId === "HKD");
    expect(hkd?.content).toBe(".");
  });

  it("returns 12 cells (one per block)", () => {
    const event = makePresentationEvent({ domain: "earthquake", areaItems: [] });
    const cells = buildMinimapCells(event);
    expect(cells).toHaveLength(12);
  });
});

// ── shouldShowMinimap ──

describe("shouldShowMinimap", () => {
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 120, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: originalColumns, writable: true, configurable: true });
  });

  it("returns true for earthquake with maxIntRank >= 4", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 1,
      maxIntRank: 4,
      areaItems: [makeAreaItem("東京都", "4")],
    });
    expect(shouldShowMinimap(event)).toBe(true);
  });

  it("returns true for earthquake with areaCount >= 4", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 5,
      maxIntRank: 2,
      areaItems: [
        makeAreaItem("東京都", "2"),
        makeAreaItem("神奈川県", "2"),
        makeAreaItem("千葉県", "2"),
        makeAreaItem("埼玉県", "2"),
        makeAreaItem("栃木県", "1"),
      ],
    });
    expect(shouldShowMinimap(event)).toBe(true);
  });

  it("returns false for earthquake with small maxIntRank and few areas", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 2,
      maxIntRank: 2,
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });

  it("returns false for cancelled events", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      isCancellation: true,
      areaCount: 5,
      maxIntRank: 5,
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });

  it("returns false for narrow terminal", () => {
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true, configurable: true });
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 5,
      maxIntRank: 5,
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });

  it("returns true for EEW with forecastAreaCount > 0", () => {
    const event = makePresentationEvent({
      domain: "eew",
      classification: "eew.forecast",
      type: "VXSE45",
      forecastAreaCount: 3,
    });
    expect(shouldShowMinimap(event)).toBe(true);
  });

  it("returns false for EEW with forecastAreaCount 0", () => {
    const event = makePresentationEvent({
      domain: "eew",
      classification: "eew.forecast",
      type: "VXSE45",
      forecastAreaCount: 0,
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });

  it("returns true for tsunami with warning-level frameLevel", () => {
    const event = makePresentationEvent({
      domain: "tsunami",
      type: "VTSE41",
      frameLevel: "warning",
      areaCount: 2,
      forecastAreaCount: 2,
    });
    expect(shouldShowMinimap(event)).toBe(true);
  });

  it("returns false for tsunami with info frameLevel", () => {
    const event = makePresentationEvent({
      domain: "tsunami",
      type: "VTSE41",
      frameLevel: "info",
      areaCount: 1,
      forecastAreaCount: 1,
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });

  it("returns false for volcano domain", () => {
    const event = makePresentationEvent({
      domain: "volcano" as PresentationEvent["domain"],
      type: "VFVO50",
      areaCount: 1,
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });

  it("returns false for nankaiTrough domain", () => {
    const event = makePresentationEvent({
      domain: "nankaiTrough",
      type: "VYSE50",
      areaCount: 1,
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });

  it("returns false for raw domain", () => {
    const event = makePresentationEvent({
      domain: "raw",
      type: "UNKNOWN",
    });
    expect(shouldShowMinimap(event)).toBe(false);
  });
});

// ── renderMinimapForEvent ──

describe("renderMinimapForEvent", () => {
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 120, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: originalColumns, writable: true, configurable: true });
  });

  it("returns lines for a qualifying earthquake event", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 5,
      maxIntRank: 5,
      areaItems: [
        makeAreaItem("石川県能登", "5-"),
        makeAreaItem("新潟県上越", "4"),
        makeAreaItem("東京都", "3"),
        makeAreaItem("大阪府", "2"),
        makeAreaItem("福岡県", "1"),
      ],
    });
    const result = renderMinimapForEvent(event);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(4);
  });

  it("returns null when conditions are not met", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 1,
      maxIntRank: 1,
    });
    const result = renderMinimapForEvent(event);
    expect(result).toBeNull();
  });
});
