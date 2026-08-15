import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import LegacyImprovedMock from "../LegacyImprovedMock.svelte";

const mockSource = readFileSync(join(__dirname, "..", "LegacyImprovedMock.svelte"), "utf8");

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

describe("legacy improved standby mock v7", () => {
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
    expect(root.dataset.clockMode).toBe("viewport-center");
    expect(rendered.container.querySelector("[data-clock-landmark]")).toBeTruthy();
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
    expect(stage).toBeLessThanOrEqual(3);
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
    expect(root.dataset.clockMode).toBe("ticker-bottom-right");
    expect(rendered.container.querySelector("[data-clock-landmark]")).toBeNull();
    expect(rendered.container.querySelector('[data-clock-placement="ticker-bottom-right"]')).toBeTruthy();
    expect(rendered.container.querySelector("[data-center-card-region]")).toBeTruthy();
    expect(rendered.container.querySelector('[data-fixed-stack-item="recent-quakes"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-mock-side="center"] [data-mock-card]')).toBeTruthy();
  });

  it("uses equal side tracks, a centered cluster track, and synchronized measurement widths", () => {
    expect(mockSource).toContain("--center-cluster-width: min(36rem, 60vw);");
    expect(mockSource).toContain("--mock-card-width: min(30rem, calc((100vw - var(--mock-edge) - var(--mock-edge) - var(--mock-gap) - var(--mock-gap) - var(--center-cluster-width)) / 2));");
    expect((mockSource.match(/--mock-card-width\s*:/g) ?? []).length).toBe(1);
    expect(mockSource).not.toContain("--standby-card-width");
    expect(mockSource).not.toContain("--center-min-width");
    expect(mockSource).not.toContain("!important");
    expect(mockSource).toMatch(/\.measure-shelf\s*\{[^}]*width:\s*var\(--mock-card-width\)/s);
    expect(mockSource).toMatch(/\.measure-item\s*\{[^}]*width:\s*100%/s);
    expect(mockSource).toMatch(/\.legacy-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--center-cluster-width\) minmax\(0, 1fr\)/s);
    expect(mockSource).toMatch(/\.legacy-card\s*\{[^}]*width:\s*var\(--mock-card-width\)/s);
    expect(mockSource).toMatch(/\.fixed-nankai,[\s\n]+\.fixed-stats,[\s\n]+\.fixed-recent,[\s\n]+\.center-stack-card\s*\{[^}]*width:\s*100%/s);
    expect(mockSource).toMatch(/\.clock-below\s*\{[^}]*gap:\s*var\(--mock-gap\)[^}]*width:\s*100%/s);
    expect(mockSource).toMatch(/\.side-left,[\s\n]+\.side-right\s*\{\s*align-items:\s*center;/s);
  });

  it("pins the clock to viewport center and places the cluster relative to the clock box", () => {
    expect(mockSource).toMatch(/\.clock-landmark\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
    expect(mockSource).toMatch(/\.clock-wrap\s*\{[^}]*top:\s*50%;[^}]*left:\s*50%;/s);
    expect(mockSource).toMatch(/\.clock-wrap\s*\{[^}]*transform:\s*translate\(-50%, -50%\)/s);
    expect(mockSource).toMatch(/\.clock-above\s*\{[^}]*bottom:\s*calc\(100% \+ var\(--mock-gap\)\)/s);
    expect(mockSource).toMatch(/\.clock-below\s*\{[^}]*top:\s*calc\(100% \+ var\(--mock-gap\)\)/s);
  });

  it("scales the large clock from its equal column without shrinking the font below the floor", () => {
    expect(mockSource).toMatch(/\.clock-wrap\s*\{[^}]*container-type:\s*inline-size/s);
    expect(mockSource).toMatch(/\.legacy-mock \.clock-wrap > :global\(\.clock > \.time\)\s*\{[^}]*font-size:\s*clamp\(64px, 13cqw, 130px\)/s);
    expect(mockSource).toMatch(/\.legacy-mock \.clock-wrap > :global\(\.clock > \.time \.sec\)\s*\{[^}]*font-size:\s*0\.35em/s);
    expect(mockSource).toMatch(/\.legacy-mock \.clock-wrap > :global\(\.clock > \.date\)\s*\{[^}]*font-size:\s*clamp\(14px, 3cqw, 22px\)/s);
    expect(mockSource).not.toContain("min-width: 40rem");
  });

  it("keeps the fixed recent-quake stack readable at the shared card width", () => {
    const { rendered } = renderMock("legacyMock2=7&ladder=0");
    const recent = rendered.container.querySelector<HTMLElement>('[data-fixed-stack-item="recent-quakes"]');

    expect(recent?.textContent).toContain("日向灘");
    expect(recent?.textContent).toContain("岐阜県美濃中西部");
    expect(mockSource).toMatch(/\.fixed-recent :global\(\.row\),[\s\n]+\.center-recent :global\(\.row\)\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(mockSource).toMatch(/\.fixed-recent :global\(\.hypocenter\),[\s\n]+\.center-recent :global\(\.hypocenter\)\s*\{[^}]*white-space:\s*normal/s);
    expect(mockSource).toMatch(/\.fixed-recent\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible/s);
  });

  it("exposes central receiver capacity and unresolved state for ladder escalation", () => {
    const { root } = renderMock("legacyMock2=max&ladder=2");

    expect(root.dataset.centerFixedHeightPx).toBeDefined();
    expect(root.dataset.centerCapacityPx).toBeDefined();
    expect(root.dataset.centerUnresolved).toBe("false");
    expect(mockSource).toMatch(/function centerNaturalHeight\(cards: readonly CardCandidate\[\]\)/);
    expect(mockSource).toMatch(/requestedStage === 2 && centerUnresolved \? 3 : requestedStage/);
  });
});
