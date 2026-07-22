import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import FloodCard from "../FloodCard.svelte";
import type { ActiveStandbyCardV1, DisplayFloodRiverV1, DisplayFloodStationV1 } from "../../lib/protocol";

function river(key: string, level: "L3" | "L4" | "L5" = "L3", station: DisplayFloodStationV1 | null = null): DisplayFloodRiverV1 {
  return {
    riverKey: key, riverName: `${key}川`, level, levelRank: level === "L3" ? 30 : level === "L4" ? 40 : 51,
    kindName: level === "L3" ? "氾濫警戒情報" : level === "L4" ? "氾濫危険情報" : "氾濫発生情報",
    reportDateTime: "2026-07-21T00:00:00.000Z", station,
  };
}

function floodItem(rivers: DisplayFloodRiverV1[], restored = false): Extract<ActiveStandbyCardV1, { kind: "flood" }> {
  return {
    kind: "flood", surface: "corner-right", key: "flood:active", sourceEventIds: ["flood-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z",
    restored, severity: rivers.some((candidate) => candidate.levelRank >= 40) ? "critical" : "warning",
    data: { rivers },
  };
}

describe("FloodCard", () => {
  it("renders one river per row with kind and level", () => {
    const { container } = render(FloodCard, { item: floodItem([river("多摩", "L4"), river("浅", "L3")]) });
    const rows = [...container.querySelectorAll(".river-row")].map((row) => row.textContent);
    expect(rows).toEqual(["多摩川　氾濫危険情報（L4）", "浅川　氾濫警戒情報（L3）"]);
  });

  it("段階カラー: L3=赤帯 (band-red) / L4=紫帯 (band-emergency) / L5=氾濫発生専用帯 (band-flooding)。カード内最高レベルで決める", () => {
    const l3 = render(FloodCard, { item: floodItem([river("多摩", "L3")]) });
    expect(l3.container.querySelector(".flood-card")?.classList.contains("band-red")).toBe(true);
    expect(l3.container.querySelector(".flood-card")?.classList.contains("band-emergency")).toBe(false);
    l3.unmount();
    // L3 と L4 が混在 → 最高レベル L4 で紫
    const mixed = render(FloodCard, { item: floodItem([river("浅", "L3"), river("多摩", "L4")]) });
    expect(mixed.container.querySelector(".flood-card")?.classList.contains("band-emergency")).toBe(true);
    mixed.unmount();
    // L5 氾濫発生は専用 class (黒帯・白枠・白リボン・黄文字)。最高レベルが L5 なら L4 混在でも flooding
    const l5 = render(FloodCard, { item: floodItem([river("多摩", "L5"), river("浅", "L4")]) });
    expect(l5.container.querySelector(".flood-card")?.classList.contains("band-flooding")).toBe(true);
    expect(l5.container.querySelector(".flood-card")?.classList.contains("band-emergency")).toBe(false);
  });

  it("renders a station sub-row with level, trend arrow, and threshold when present", () => {
    const { container } = render(FloodCard, { item: floodItem([
      river("大淀", "L4", { name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過" }),
    ]) });
    const subRows = [...container.querySelectorAll(".station-row")].map((row) => row.textContent);
    expect(subRows).toEqual(["柏田 3.42m ↑ 氾濫危険水位 3.20m 超過"]);
  });

  it("omits the sub-row for rivers without station data and drops the level number when levelM is null", () => {
    const { container } = render(FloodCard, { item: floodItem([
      river("五ヶ瀬", "L3", null),
      river("耳", "L3", { name: "山陰", levelM: null, trend: null, thresholdLabel: "避難判断水位超過" }),
    ]) });
    const subRows = [...container.querySelectorAll(".station-row")].map((row) => row.textContent);
    expect(subRows).toEqual(["山陰 避難判断水位超過"]);
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(FloodCard, { item: floodItem([river("多摩")], true) });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
