import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import LegacyImprovedMock from "../LegacyImprovedMock.svelte";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

function renderMock(query: string) {
  window.history.replaceState({}, "", `/?${query}`);
  const rendered = render(LegacyImprovedMock);
  const root = rendered.container.querySelector<HTMLElement>("[data-legacy-improved-mock]");
  if (root == null) throw new Error("legacy improved mock root was not rendered");
  return { rendered, root };
}

describe("legacy improved standby mock v4", () => {
  it.each([
    ["legacyMock2=4&ladder=0", "4", 1, 3, 0, 4],
    ["legacyMock2=7&ladder=0", "7", 2, 5, 0, 7],
    ["legacyMock2=max&ladder=0", "max", 2, 5, 2, 9],
  ] as const)("renders %s with the fixed tier and no paging", (query, scenario, left, right, suppressed, inputCount) => {
    const { rendered, root } = renderMock(query);

    expect(root.dataset.scenario).toBe(scenario);
    expect(root.dataset.ladderStage).toBe("0");
    expect(root.dataset.ladderAuto).toBe("false");
    expect(root.dataset.paging).toBe("none");
    expect(root.dataset.suppressedUnknownCount).toBe(String(suppressed));
    expect(root.dataset.inputItemCount).toBe(String(inputCount));
    expect(root.dataset.measurementMode).toBe("sync-dom");
    expect(root.dataset.measurementPass).toBe("2");
    expect(Number(root.dataset.measurementReadCount)).toBeGreaterThan(0);
    expect(rendered.container.querySelectorAll('[data-mock-side="left"] [data-mock-card]')).toHaveLength(left);
    expect(rendered.container.querySelectorAll('[data-mock-side="right"] [data-mock-card]')).toHaveLength(right);
    expect(rendered.container.querySelector('[data-mock-card="unknown"]')).toBeNull();
    expect(rendered.container.querySelector('[data-fixed-stack-item="nankai"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-fixed-stack-item="stats"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-fixed-stack-item="recent-quakes"]')).toBeTruthy();
  });

  it("renders main card roots and keeps measured-height metadata without ratio allocation", () => {
    const { rendered } = renderMock("legacyMock2=7&ladder=0");

    for (const selector of [
      ".tsunami-banner",
      ".quake-card",
      ".weather-card",
      ".flood-card",
      ".typhoon-card",
      ".volcano-card",
      ".heat-card",
    ]) {
      expect(rendered.container.querySelector(selector), selector).toBeTruthy();
    }

    const cards = [...rendered.container.querySelectorAll<HTMLElement>("[data-mock-card]")];
    expect(cards.length).toBe(7);
    for (const card of cards) {
      const natural = Number(card.dataset.naturalHeightPx);
      const allocated = Number(card.dataset.allocatedHeightPx);
      expect(Number.isFinite(natural)).toBe(true);
      expect(Number.isFinite(allocated)).toBe(true);
      expect(allocated).toBeLessThanOrEqual(natural);
      expect(card.dataset.allocatedRatio).toBeUndefined();
      expect(card.classList.contains("overflow-card")).toBe(false);
      expect(card.dataset.overflowPlacement).toBeUndefined();
    }
  });

  it("marks omitted ladder as auto and leaves a measured placement plan", () => {
    const { rendered, root } = renderMock("legacyMock2=max");

    expect(root.dataset.ladderAuto).toBe("true");
    const stage = Number(root.dataset.ladderStage);
    expect(stage).toBeGreaterThanOrEqual(0);
    expect(stage).toBeLessThanOrEqual(2);
    expect(root.dataset.layoutUnresolved).toBe("false");
    expect(rendered.container.querySelectorAll("[data-mock-card]").length).toBe(7);
  });

  it("exposes expansion metadata for earthquake and weather fixtures when measured space permits", () => {
    const { rendered } = renderMock("legacyMock2=4&ladder=0");

    for (const key of ["quake", "weather"]) {
      const card = rendered.container.querySelector<HTMLElement>(`[data-mock-card="${key}"]`);
      expect(card).toBeTruthy();
      expect(card?.dataset.regionExpanded).toBe("true");
    }
    expect(rendered.container.querySelector('[data-mock-card="quake"]')?.textContent).not.toContain("ほか3地域");
  });

  it("spills volcano and heat to the left column at forced ladder 1 without a ribbon", () => {
    const { rendered, root } = renderMock("legacyMock2=7&ladder=1");
    expect(root.dataset.ladderStage).toBe("1");
    expect(root.dataset.ladderAuto).toBe("false");

    const leftKeys = [...rendered.container.querySelectorAll<HTMLElement>('[data-mock-side="left"] [data-mock-card]')]
      .map((card) => card.dataset.mockCard);
    expect(leftKeys).toContain("volcano");
    expect(leftKeys).toContain("heat");
    for (const key of ["volcano", "heat"]) {
      const card = rendered.container.querySelector<HTMLElement>(`[data-mock-card="${key}"]`);
      expect(card?.dataset.overflowPlacement).toBe("left-bottom");
      expect(card?.classList.contains("overflow-card")).toBe(false);
    }
    const rightKeys = [...rendered.container.querySelectorAll<HTMLElement>('[data-mock-side="right"] [data-mock-card]')]
      .map((card) => card.dataset.mockCard);
    expect(rightKeys).not.toContain("volcano");
    expect(rightKeys).not.toContain("heat");
  });

  it.each(["2", "3"] as const)("moves the clock to the ticker area at ladder %s", (stage) => {
    const { rendered, root } = renderMock(`legacyMock2=max&ladder=${stage}`);
    expect(root.dataset.ladderStage).toBe(stage);
    expect(rendered.container.querySelector('[data-clock-placement="ticker-bottom-right"]')).toBeTruthy();
    expect(rendered.container.querySelector("[data-center-card-region]")).toBeTruthy();
    expect(rendered.container.querySelector('[data-fixed-stack-item="recent-quakes"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-mock-side="center"] [data-mock-card]')).toBeTruthy();
  });
});
