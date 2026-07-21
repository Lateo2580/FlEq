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
  };
}

function floodItem(count: number): Extract<ActiveStandbyCardV1, { kind: "flood" }> {
  return {
    kind: "flood", surface: "clock-top-wide", key: "flood:active", sourceEventIds: ["flood-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z",
    restored: false, severity: "critical", data: { rivers: Array.from({ length: count }, (_, index) => river(index + 1)) },
  };
}

afterEach(() => Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight }));

describe("FloodWideCard", () => {
  it("lays rivers out in two columns and aggregates rows that do not fit", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const { container } = render(FloodWideCard, { item: floodItem(12) });
    expect(container.querySelectorAll(".river-row")).toHaveLength(4);
    expect(container.querySelector(".more-rivers")?.textContent).toBe("ほか 8 河川");
    expect(container.textContent).toContain("第1川　氾濫危険情報（L4）");
  });

  it("keeps the specified width, height cap, clipping, and two-column grid contract", () => {
    const source = readFileSync(join(__dirname, "..", "FloodWideCard.svelte"), "utf8");
    expect(source).toContain("width: min(720px, 56vw)");
    expect(source).toContain("grid-template-columns: 1fr 1fr");
    expect(source).toContain("max-height: 30vh");
    expect(source).toContain("overflow: hidden");
  });
});
