import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import FloodCard from "../FloodCard.svelte";
import type { ActiveStandbyCardV1, DisplayFloodRiverV1 } from "../../lib/protocol";

function river(key: string, level: "L3" | "L4" | "L5" = "L3"): DisplayFloodRiverV1 {
  return {
    riverKey: key, riverName: `${key}川`, level, levelRank: level === "L3" ? 30 : level === "L4" ? 40 : 51,
    kindName: level === "L3" ? "氾濫警戒情報" : level === "L4" ? "氾濫危険情報" : "氾濫発生情報",
    reportDateTime: "2026-07-21T00:00:00.000Z",
  };
}

function floodItem(rivers: DisplayFloodRiverV1[]): Extract<ActiveStandbyCardV1, { kind: "flood" }> {
  return {
    kind: "flood", surface: "corner-right", key: "flood:active", sourceEventIds: ["flood-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z",
    restored: false, severity: rivers.some((candidate) => candidate.levelRank >= 40) ? "critical" : "warning",
    data: { rivers },
  };
}

describe("FloodCard", () => {
  it("renders one river per row with kind and level", () => {
    const { container } = render(FloodCard, { item: floodItem([river("多摩", "L4"), river("浅", "L3")]) });
    const rows = [...container.querySelectorAll(".river-row")].map((row) => row.textContent);
    expect(rows).toEqual(["多摩川　氾濫危険情報（L4）", "浅川　氾濫警戒情報（L3）"]);
  });

  it("uses warning-level styling when every river is L3 and critical styling for L4+", () => {
    const warning = render(FloodCard, { item: floodItem([river("多摩", "L3")]) });
    expect(warning.container.querySelector(".flood-card")?.classList.contains("critical")).toBe(false);
    warning.unmount();
    const critical = render(FloodCard, { item: floodItem([river("多摩", "L5")]) });
    expect(critical.container.querySelector(".flood-card")?.classList.contains("critical")).toBe(true);
  });
});
