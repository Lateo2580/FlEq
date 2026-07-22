import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import FloodWideCard from "../FloodWideCard.svelte";
import type { ActiveStandbyCardV1, DisplayFloodRiverV1 } from "../../lib/protocol";

const originalInnerHeight = window.innerHeight;

function river(index: number): DisplayFloodRiverV1 {
  return {
    riverKey: `river-${index}`, riverName: `第${index}川`, level: index === 1 ? "L4" : "L3",
    levelRank: index === 1 ? 40 : 30, kindName: index === 1 ? "氾濫危険情報" : "氾濫警戒情報",
    reportDateTime: "2026-07-21T00:00:00.000Z",
    station: index === 1 ? { name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過" } : null,
  };
}

function floodItem(count: number, restored = false): Extract<ActiveStandbyCardV1, { kind: "flood" }> {
  return {
    kind: "flood", surface: "clock-top-wide", key: "flood:active", sourceEventIds: ["flood-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z",
    restored, severity: "critical", data: { rivers: Array.from({ length: count }, (_, index) => river(index + 1)) },
  };
}

afterEach(() => Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight }));

describe("FloodWideCard", () => {
  it("lays rivers out in two columns and aggregates rows that do not fit", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const { container } = render(FloodWideCard, { item: floodItem(12) });
    expect(container.querySelectorAll(".river-cell")).toHaveLength(2);
    expect(container.querySelector(".more-rivers")?.textContent).toBe("ほか 10 河川");
    expect(container.textContent).toContain("第1川　氾濫危険情報（L4）");
  });

  it("caps visible cells to the taller 3-row cell estimate at a large viewport", () => {
    // innerHeight 1400 → maxHeight 420、(420-48)/120 = 3 grid 行 → cell 容量 6。
    // 12 河川なら最終行を集約に予約して 4 セル可視 + ほか 8 河川。
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1400 });
    const { container } = render(FloodWideCard, { item: floodItem(12) });
    expect(container.querySelectorAll(".river-cell")).toHaveLength(4);
    expect(container.querySelector(".more-rivers")?.textContent).toBe("ほか 8 河川");
  });

  it("lays the station out as a 2×2 label grid (観測所/水位/水位の情報/グラフ) and omits it for rivers without station data", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const { container } = render(FloodWideCard, { item: floodItem(4) });
    // river(1) だけ station を持つ (river 2-4 は station: null) → station-grid は 1 つ
    const grids = container.querySelectorAll(".station-grid");
    expect(grids).toHaveLength(1);
    const grid = grids[0];
    expect(grid.querySelector(".cell-station .stat-label")?.textContent).toBe("観測所");
    expect(grid.querySelector(".cell-station .stat-value")?.textContent).toBe("柏田");
    expect(grid.querySelector(".cell-level .stat-label")?.textContent).toBe("水位");
    expect(grid.querySelector(".cell-level .stat-value")?.textContent).toBe("3.42m ↑");
    expect(grid.querySelector(".cell-threshold .stat-label")?.textContent).toBe("水位の情報");
    expect(grid.querySelector(".cell-threshold .stat-value")?.textContent).toBe("氾濫危険水位 3.20m 超過");
  });

  it("omits the 水位 stat (not a placeholder) when levelM is missing, keeping 観測所 and 水位の情報", () => {
    const item: Extract<ActiveStandbyCardV1, { kind: "flood" }> = {
      kind: "flood", surface: "clock-top-wide", key: "flood:active", sourceEventIds: ["flood-1"],
      updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z", restored: false, severity: "warning",
      data: { rivers: [
        {
          riverKey: "r1", riverName: "耳川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報",
          reportDateTime: "2026-07-21T00:00:00.000Z",
          station: { name: "山陰", levelM: null, trend: null, thresholdLabel: "避難判断水位超過" },
        },
      ] },
    };
    const { container } = render(FloodWideCard, { item });
    expect(container.querySelector(".cell-station .stat-value")?.textContent).toBe("山陰");
    expect(container.querySelector(".cell-level")).toBeNull();
    expect(container.querySelector(".cell-threshold .stat-value")?.textContent).toBe("避難判断水位超過");
    expect(container.textContent).not.toContain("--");
  });

  it("keeps the specified width, height cap, clipping, and two-column grid contract", () => {
    const source = readFileSync(join(__dirname, "..", "FloodWideCard.svelte"), "utf8");
    expect(source).toContain("width: min(720px, 56vw)");
    expect(source).toContain("grid-template-columns: 1fr 1fr");
    expect(source).toContain("max-height: 30vh");
    expect(source).toContain("overflow: hidden");
  });

  it("renders the hydrograph SVG with an aria-label and omits it when the station has no hydrograph", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const item: Extract<ActiveStandbyCardV1, { kind: "flood" }> = {
      kind: "flood", surface: "clock-top-wide", key: "flood:active", sourceEventIds: ["flood-1"],
      updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z", restored: false, severity: "critical",
      data: { rivers: [
        {
          riverKey: "r1", riverName: "大淀川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
          reportDateTime: "2026-07-21T00:00:00.000Z",
          station: {
            name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過",
            hydrograph: {
              points: [
                { dateTime: "2026-07-21T05:00:00+09:00", valueM: 3.42, phase: "observed" },
                { dateTime: "2026-07-21T06:00:00+09:00", valueM: 3.55, phase: "forecast" },
                { dateTime: "2026-07-21T07:00:00+09:00", valueM: 3.40, phase: "forecast" },
              ],
              dangerLevelM: 3.2,
            },
          },
        },
        {
          riverKey: "r2", riverName: "小丸川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報",
          reportDateTime: "2026-07-21T00:00:00.000Z",
          station: { name: "高城", levelM: 2.18, trend: "steady", thresholdLabel: "避難判断水位 2.00m 超過" },
        },
      ] },
    };
    const { container } = render(FloodWideCard, { item });
    const svgs = container.querySelectorAll("svg.flood-graph");
    // hydrograph を持つ河川だけ SVG が出る (もう一方の station は hydrograph 無し)
    expect(svgs).toHaveLength(1);
    const svg = svgs[0];
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("現在 3.42m");
    expect(svg.getAttribute("aria-label")).toContain("氾濫危険水位 3.20m");
    // 危険線 1 本・現況塗り丸 1・予測点 2
    expect(svg.querySelectorAll("line")).toHaveLength(1);
    expect(svg.querySelectorAll("circle")).toHaveLength(3);
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(FloodWideCard, { item: floodItem(4, true) });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });

  it("段階カラー: L4 を含めば紫帯 (band-emergency) / 全 L3 なら赤帯 (band-red)。FloodCard と同型", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    // river(1) が L4 を含む混在 → 紫
    const mixed = render(FloodWideCard, { item: floodItem(4) });
    expect(mixed.container.querySelector(".flood-wide-card")?.classList.contains("band-emergency")).toBe(true);
    mixed.unmount();
    // 全河川 L3 → 赤
    const allL3: Extract<ActiveStandbyCardV1, { kind: "flood" }> = {
      kind: "flood", surface: "clock-top-wide", key: "flood:active", sourceEventIds: ["flood-1"],
      updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z", restored: false, severity: "warning",
      data: { rivers: [
        { riverKey: "r1", riverName: "浅川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: "2026-07-21T00:00:00.000Z", station: null },
      ] },
    };
    const red = render(FloodWideCard, { item: allL3 });
    expect(red.container.querySelector(".flood-wide-card")?.classList.contains("band-red")).toBe(true);
    expect(red.container.querySelector(".flood-wide-card")?.classList.contains("band-emergency")).toBe(false);
    red.unmount();
    // L5 氾濫発生を含めば専用帯 (band-flooding)
    const withL5: Extract<ActiveStandbyCardV1, { kind: "flood" }> = {
      kind: "flood", surface: "clock-top-wide", key: "flood:active", sourceEventIds: ["flood-1"],
      updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z", restored: false, severity: "critical",
      data: { rivers: [
        { riverKey: "r1", riverName: "大淀川", level: "L5", levelRank: 51, kindName: "氾濫発生情報", reportDateTime: "2026-07-21T00:00:00.000Z", station: null },
      ] },
    };
    const flooding = render(FloodWideCard, { item: withL5 });
    expect(flooding.container.querySelector(".flood-wide-card")?.classList.contains("band-flooding")).toBe(true);
    expect(flooding.container.querySelector(".flood-wide-card")?.classList.contains("band-emergency")).toBe(false);
  });
});
