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

describe("legacy improved standby mock v3", () => {
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
    expect(rendered.container.querySelectorAll('[data-mock-side="left"] [data-mock-card]')).toHaveLength(left);
    expect(rendered.container.querySelectorAll('[data-mock-side="right"] [data-mock-card]')).toHaveLength(right);
    expect(rendered.container.querySelector('[data-mock-card="unknown"]')).toBeNull();
    expect(rendered.container.querySelector('[data-fixed-stack-item="nankai"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-fixed-stack-item="stats"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-fixed-stack-item="recent-quakes"]')).toBeTruthy();
  });

  it("renders the main card roots and keeps natural-height metadata", () => {
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
      expect(natural).toBeGreaterThan(0);
      expect(allocated).toBeGreaterThan(0);
      expect(allocated).toBeLessThanOrEqual(natural);
      expect(card.dataset.allocatedRatio).toBeUndefined();
      expect(card.classList.contains("overflow-card")).toBe(false);
      expect(card.dataset.overflowPlacement).toBeUndefined();
    }
  });

  it("marks omitted ladder as auto and spills from the right by arithmetic fit", () => {
    const { rendered, root } = renderMock("legacyMock2=max");

    expect(root.dataset.ladderAuto).toBe("true");
    const stage = Number(root.dataset.ladderStage);
    expect(stage).toBeGreaterThanOrEqual(1);
    expect(stage).toBeLessThanOrEqual(2);
    expect(rendered.container.querySelector('[data-overflow-placement="left-bottom"]')).toBeTruthy();
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
  });
});
