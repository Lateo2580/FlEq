import { describe, it, expect, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import type { PresentationEvent, PresentationAreaItem } from "../../../src/engine/presentation/types";
import type { MinimapCell } from "../../../src/ui/minimap/types";
import {
  renderMinimap,
  buildMinimapCells,
  shouldShowMinimap,
  renderMinimapForEvent,
} from "../../../src/ui/minimap/minimap-renderer";
import { ALL_PREF_IDS } from "../../../src/ui/minimap/grid-layout";

// ── Helpers ──

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
  it("produces 12 lines of output", () => {
    const cells: MinimapCell[] = ALL_PREF_IDS.map((prefId) => ({
      prefId,
      content: "..",
    }));
    const lines = renderMinimap(cells);
    expect(lines).toHaveLength(12);
  });

  it("renders HK on the first line", () => {
    const cells: MinimapCell[] = ALL_PREF_IDS.map((prefId) => ({
      prefId,
      content: prefId === "HK" ? "5-" : "..",
    }));
    const lines = renderMinimap(cells);
    expect(lines[0]).toContain("HK:5-");
  });

  it("renders multi-cell prefecture with continuation markers", () => {
    const prevLevel = chalk.level;
    chalk.level = 0;
    try {
      const cells: MinimapCell[] = ALL_PREF_IDS.map((prefId) => ({
        prefId,
        content: prefId === "HK" ? "6+" : "..",
      }));
      const lines = renderMinimap(cells);
      expect(lines[0]).toContain("·····");
      expect(lines[1]).toContain("·····");
    } finally {
      chalk.level = prevLevel;
    }
  });

  it("renders non-matching prefectures with dim code", () => {
    const prevLevel = chalk.level;
    chalk.level = 0;
    try {
      const cells: MinimapCell[] = ALL_PREF_IDS.map((prefId) => ({
        prefId,
        content: "..",
      }));
      const lines = renderMinimap(cells);
      expect(lines[4]).toContain("OK:..");
    } finally {
      chalk.level = prevLevel;
    }
  });

  it("applies color to matching cells", () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      const cells: MinimapCell[] = ALL_PREF_IDS.map((prefId) => ({
        prefId,
        content: prefId === "TY" ? "6+" : "..",
        color: prefId === "TY" ? chalk.red : undefined,
      }));
      const lines = renderMinimap(cells);
      expect(lines[7]).toContain("\u001b[");
    } finally {
      chalk.level = prevLevel;
    }
  });
});

// ── buildMinimapCells ──

describe("buildMinimapCells", () => {
  it("returns 47 cells (one per prefecture)", () => {
    const event = makePresentationEvent({ domain: "earthquake", areaItems: [] });
    const cells = buildMinimapCells(event);
    expect(cells).toHaveLength(47);
  });

  it("maps earthquake areas to correct prefectures", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 2,
      areaItems: [
        makeAreaItem("石川県能登", "6+"),
        makeAreaItem("東京都", "4"),
      ],
    });
    const cells = buildMinimapCells(event);
    const is = cells.find((c) => c.prefId === "IS");
    const ty = cells.find((c) => c.prefId === "TY");
    expect(is?.content).toBe("6+");
    expect(ty?.content).toBe("4");
  });

  it("takes max intensity when multiple areas match same prefecture", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 2,
      areaItems: [
        makeAreaItem("石川県能登", "6+"),
        makeAreaItem("石川県加賀", "5+"),
      ],
    });
    const cells = buildMinimapCells(event);
    const is = cells.find((c) => c.prefId === "IS");
    expect(is?.content).toBe("6+");
  });

  it("maps tsunami areas with kind abbreviations", () => {
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
    const hk = cells.find((c) => c.prefId === "HK");
    const ao = cells.find((c) => c.prefId === "AO");
    expect(hk?.content).toBe("MJ");
    expect(ao?.content).toBe("WN");
  });

  it("fills unmatched prefectures with '..'", () => {
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 1,
      areaItems: [makeAreaItem("沖縄県", "3")],
    });
    const cells = buildMinimapCells(event);
    const hk = cells.find((c) => c.prefId === "HK");
    expect(hk?.content).toBe("..");
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

  it("returns false for narrow terminal (< 80)", () => {
    Object.defineProperty(process.stdout, "columns", { value: 70, writable: true, configurable: true });
    const event = makePresentationEvent({
      domain: "earthquake",
      areaCount: 5,
      maxIntRank: 5,
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

  it("returns true for EEW with forecastAreaCount > 0", () => {
    const event = makePresentationEvent({
      domain: "eew",
      classification: "eew.forecast",
      type: "VXSE45",
      forecastAreaCount: 3,
    });
    expect(shouldShowMinimap(event)).toBe(true);
  });

  it("returns true for tsunami with warning frameLevel", () => {
    const event = makePresentationEvent({
      domain: "tsunami",
      type: "VTSE41",
      frameLevel: "warning",
      areaCount: 2,
      forecastAreaCount: 2,
    });
    expect(shouldShowMinimap(event)).toBe(true);
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
    expect(result!.length).toBeGreaterThanOrEqual(12);
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
