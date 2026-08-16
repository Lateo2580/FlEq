import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function installMeasuredLayout(options: { capacityPx?: number; baseCardPx?: number; prefixRowPx?: number } = {}): () => void {
  const capacityPx = options.capacityPx ?? 180;
  const baseCardPx = options.baseCardPx ?? 90;
  const prefixRowPx = options.prefixRowPx ?? 0;
  const shelfHeight = (id: string | undefined): number => {
    if (id == null) return baseCardPx;
    const regionMatch = id.match(/:(?:region:)(\d+)$/);
    if (regionMatch != null) return baseCardPx + Number(regionMatch[1]) * prefixRowPx;
    if (id.endsWith(":expanded")) {
      const maxRows = id.startsWith("quake:") ? 3 : 10;
      return baseCardPx + maxRows * prefixRowPx;
    }
    return baseCardPx;
  };
  const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains("legacy-layout")) return capacityPx;
      if (this.hasAttribute("data-measure-card")) return shelfHeight(this.dataset.measureCard);
      if (this.hasAttribute("data-center-measure-card")) return shelfHeight(this.dataset.centerMeasureCard);
      if (this.matches("[data-mock-card]")) return baseCardPx;
      if (this.classList.contains("center-stack-card")) return 20;
      if (this.classList.contains("rotation-failure-measure")) return 24;
      if (this.hasAttribute("data-nankai-ticker")) return 20;
      return offsetHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this.classList.contains("legacy-layout")) {
      return { x: 0, y: 0, width: 960, height: capacityPx, top: 0, right: 960, bottom: capacityPx, left: 0, toJSON: () => ({}) } as DOMRect;
    }
    if (this.hasAttribute("data-measure-card") || this.hasAttribute("data-center-measure-card")) {
      const id = this.dataset.measureCard ?? this.dataset.centerMeasureCard;
      const height = shelfHeight(id);
      return { x: 0, y: 0, width: 300, height, top: 0, right: 300, bottom: height, left: 0, toJSON: () => ({}) } as DOMRect;
    }
    if (this.matches("[data-mock-card]")) {
      return { x: 0, y: 0, width: 300, height: baseCardPx, top: 0, right: 300, bottom: baseCardPx, left: 0, toJSON: () => ({}) } as DOMRect;
    }
    if (this.classList.contains("ticker-reserve")) {
      return { x: 0, y: capacityPx, width: 960, height: 52, top: capacityPx, right: 960, bottom: capacityPx + 52, left: 0, toJSON: () => ({}) } as DOMRect;
    }
    return originalRect.call(this);
  };
  return () => {
    if (offsetHeightDescriptor == null) {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
    }
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  };
}

describe("legacy improved standby mock v16", () => {
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
    expect(Number(root.dataset.measurementPass)).toBeGreaterThan(0);
    expect(root.dataset.measurementSettled).toBeDefined();
    expect(root.dataset.measurementNonconverged).toBeDefined();
    expect(root.dataset.layoutBaseHeightPx).toBeDefined();
    expect(root.dataset.tickerHeightPx).toBeDefined();
    expect(root.dataset.columnPaddingPx).toBeDefined();
    expect(root.dataset.leftNaturalHeightPx).toBeDefined();
    expect(root.dataset.rightNaturalHeightPx).toBeDefined();
    expect(root.dataset.leftCapacityPx).toBeDefined();
    expect(root.dataset.rightCapacityPx).toBeDefined();
    expect(root.dataset.nankaiHeightPx).toBeDefined();
    expect(root.dataset.clusterGapPx).toBeDefined();
    expect(root.dataset.clusterFlowHeightPx).toBeDefined();
    expect(root.dataset.layoutCapacityPx).toBeDefined();
    expect(root.dataset.centerGapPx).toBeDefined();
    expect(root.dataset.centerNaturalHeightPx).toBeDefined();
    expect(root.dataset.centerEligibleKeys).toBe("weather,flood,typhoon,volcano");
    expect(root.dataset.clockMode).toBe("viewport-center");
    expect(rendered.container.querySelector("[data-clock-landmark]")).toBeTruthy();
    expect(Number(root.dataset.measurementReadCount)).toBeGreaterThan(0);
    expect(rendered.container.querySelectorAll('[data-mock-side="left"] [data-mock-card]')).toHaveLength(left);
    expect(rendered.container.querySelectorAll('[data-mock-side="right"] [data-mock-card]')).toHaveLength(right);
    expect(rendered.container.querySelector('[data-mock-card="unknown"]')).toBeNull();
    expect(rendered.container.querySelector('[data-fixed-stack-item="nankai"]')).toBeTruthy();
    expect(rendered.container.querySelector("[data-nankai-ticker]")).toBeTruthy();
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
    expect(rendered.container.querySelector('[data-mock-card="weather"] [data-weather-two-column]')).toBeTruthy();
    const tornado = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"] [data-tornado-full]');
    expect(tornado?.textContent).toContain("宮崎県南部平野部");
    expect(tornado?.textContent).toContain("宮崎県北部平野部");
    expect(tornado?.textContent).not.toContain("ほか");
    expect(mockSource).toContain("tornado={null}");
    expect(mockSource).toMatch(/\.mock-weather-shell :global\(\.weather-card > ul\)\s*\{[^}]*column-count:\s*2/s);
    expect(mockSource).toMatch(/\.mock-weather-shell :global\(\.weather-card > ul \.pref-group\)\s*\{[^}]*break-inside:\s*avoid/s);
  });

  it("uses the new stage 1 clock retreat without reviving the old forced left spill", () => {
    const { rendered, root } = renderMock("legacyMock2=7&ladder=1");
    expect(root.dataset.ladderStage).toBe("1");
    expect(root.dataset.ladderAuto).toBe("false");
    expect(root.dataset.clockMode).toBe("ticker-bottom-right");
    expect(rendered.container.querySelector("[data-clock-landmark]")).toBeNull();
    expect(rendered.container.querySelector('[data-clock-placement="ticker-bottom-right"]')).toBeTruthy();
    expect(rendered.container.querySelector("[data-center-card-region]")).toBeTruthy();
    const leftCards = rendered.container.querySelectorAll('[data-mock-side="left"] [data-mock-card]');
    for (const card of leftCards) {
      expect(card.getAttribute("data-overflow-placement")).not.toBe("left-bottom");
    }
  });

  it("exposes the center eligibility rule and keeps non-eligible hazards out of the receiver", () => {
    const { rendered, root } = renderMock("legacyMock2=7&ladder=2");

    for (const key of ["weather", "flood", "typhoon", "volcano"] as const) {
      expect(rendered.container.querySelector<HTMLElement>(`[data-mock-card="${key}"]`)?.dataset.centerEligible).toBe("true");
    }
    for (const key of ["tsunami", "quake", "heat"] as const) {
      expect(rendered.container.querySelector<HTMLElement>(`[data-mock-card="${key}"]`)?.dataset.centerEligible).toBe("false");
    }
    const centerKeys = [...rendered.container.querySelectorAll<HTMLElement>('[data-mock-side="center"] [data-mock-card]')]
      .map((card) => card.dataset.mockCard);
    expect(centerKeys).not.toContain("heat");
    for (const key of centerKeys) {
      expect(rendered.container.querySelector<HTMLElement>(`[data-mock-card="${key}"]`)?.dataset.centerEligible).toBe("true");
    }
    expect(root.dataset.centerEligibleKeys).toBe("weather,flood,typhoon,volcano");
    expect(mockSource).toContain("const centerEligibleKeys = new Set<CardKey>([\"weather\", \"flood\", \"typhoon\", \"volcano\"]);");
    expect(mockSource).toContain("function enumeratePlacements");
    expect(mockSource).toContain("function bestPlacement");
    expect(mockSource).toContain("function comparePlacements");
    expect(mockSource).toContain("時計を中央に残すことを最優先");
  });

  it.each(["2", "3"] as const)("moves the clock to the ticker area at ladder %s", (stage) => {
    const { rendered, root } = renderMock(`legacyMock2=max&ladder=${stage}`);
    expect(root.dataset.ladderStage).toBe(stage);
    expect(root.dataset.clockMode).toBe("ticker-bottom-right");
    expect(rendered.container.querySelector("[data-clock-landmark]")).toBeNull();
    expect(rendered.container.querySelector('[data-clock-placement="ticker-bottom-right"]')).toBeTruthy();
    expect(rendered.container.querySelector("[data-center-card-region]")).toBeTruthy();
    expect(rendered.container.querySelector('[data-fixed-stack-item="recent-quakes"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-mock-side="center"]')).toBeTruthy();
    if (stage === "3") {
      expect(rendered.container.querySelector("[data-rotation-slot]")).toBeTruthy();
      expect(root.dataset.rotationKeys).toBeDefined();
      expect(root.dataset.rotationCurrentKey).toBeDefined();
    }
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
    expect(mockSource).toMatch(/\.fixed-stats,[\s\n]+\.fixed-recent,[\s\n]+\.center-stack-card\s*\{[^}]*width:\s*100%/s);
    expect(mockSource).toMatch(/\.center-card-region > \.legacy-card\s*\{[^}]*width:\s*var\(--center-cluster-width\)/s);
    expect(mockSource).toMatch(/\.center-measure-shelf\s*\{[^}]*width:\s*var\(--center-cluster-width\)/s);
    expect(mockSource).toContain("data-center-measure-card");
    expect(mockSource).toContain("measuredCenterHeights");
    expect(mockSource).toMatch(/\.clock-below\s*\{[^}]*gap:\s*var\(--mock-cluster-gap\)[^}]*width:\s*100%/s);
    expect(mockSource).toMatch(/\.clock-below\s*\{[^}]*justify-content:\s*space-between;[^}]*height:\s*var\(--mock-cluster-flow-height\)/s);
    expect(mockSource).toContain("const clusterGap = lowerSpace > 0 ? Math.floor(lowerSpace / 3) : 0;");
    expect(mockSource).toMatch(/\.side-left,[\s\n]+\.side-right\s*\{\s*align-items:\s*center;/s);
    expect(mockSource).toMatch(/\.ladder-1 \.side,[\s\n]+\.ladder-2 \.side,[\s\n]+\.ladder-3 \.side \{ justify-content: safe center; \}/s);
    expect(mockSource).toContain("--mock-cluster-gap: calc(var(--mock-gap) * 1.75);");
    expect(mockSource).toMatch(/\.center-card-region\s*\{[^}]*justify-content:\s*safe center/s);
  });

  it("pins the clock to viewport center and places the cluster relative to the clock box", () => {
    expect(mockSource).toMatch(/\.clock-landmark\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
    expect(mockSource).toMatch(/\.clock-wrap\s*\{[^}]*top:\s*50%;[^}]*left:\s*50%;/s);
    expect(mockSource).toMatch(/\.clock-wrap\s*\{[^}]*transform:\s*translate\(-50%, -50%\)/s);
    expect(mockSource).toMatch(/\.clock-below\s*\{[^}]*top:\s*calc\(100% \+ var\(--mock-cluster-gap\)\)/s);
    expect(mockSource).toMatch(/\.nankai-ticker\s*\{[^}]*right:\s*var\(--mock-edge\)[^}]*bottom:\s*var\(--mock-ticker-h\)[^}]*left:\s*var\(--mock-edge\)/s);
    expect(mockSource).toMatch(/\.nankai-ticker :global\(\.nankai-badge\)\s*\{[^}]*margin:\s*0/s);
    expect(mockSource).toMatch(/inset: var\(--mock-edge\) var\(--mock-edge\) calc\(var\(--mock-ticker-h\) \+ var\(--mock-edge\) \+ var\(--mock-nankai-reserve\)\)/s);
    expect(mockSource).toContain("const layoutHeight = Math.max(0, baseLayoutHeight);");
    expect(mockSource).toMatch(/measuredLayoutHeightPx - measuredColumnPaddingPx/);
  });

  it("scales the large clock from its equal column without shrinking the font below the floor", () => {
    expect(mockSource).toMatch(/\.clock-wrap\s*\{[^}]*container-type:\s*inline-size/s);
    expect(mockSource).toMatch(/\.legacy-mock \.clock-wrap > :global\(\.clock > \.time\)\s*\{[^}]*font-size:\s*clamp\(72px, 16cqw, 160px\)/s);
    expect(mockSource).toMatch(/\.legacy-mock \.clock-wrap > :global\(\.clock > \.time \.sec\)\s*\{[^}]*font-size:\s*0\.35em/s);
    expect(mockSource).toMatch(/\.legacy-mock \.clock-wrap > :global\(\.clock > \.date\)\s*\{[^}]*font-size:\s*clamp\(16px, 3\.7cqw, 26px\)/s);
    expect(mockSource).not.toContain(".legacy-mock .clock-wrap :global(.time)");
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
    const { rendered, root } = renderMock("legacyMock2=max&ladder=2");

    expect(root.dataset.centerFixedHeightPx).toBeDefined();
    expect(root.dataset.centerCapacityPx).toBeDefined();
    expect(root.dataset.centerNaturalHeightPx).toBeDefined();
    expect(rendered.container.querySelector("[data-nankai-ticker]")).toBeTruthy();
    expect(rendered.container.querySelector('[data-clock-landmark] [data-fixed-stack-item="nankai"]')).toBeNull();
    expect(root.dataset.centerUnresolved).toBe("false");
    expect(mockSource).toMatch(/function centerNaturalHeight\(cards: readonly CardCandidate\[\]\)/);
    expect(mockSource).toMatch(/\.center-card-region\s*\{[^}]*gap:\s*var\(--mock-gap\)/s);
    expect(mockSource).not.toContain("min-height: clamp(3rem, 8vh, 6rem)");
    expect(mockSource).toContain("const unresolved = layoutFailure || sideUnresolved || centerUnresolved;");
    expect(mockSource).toContain("const MAX_SETTLE_PASSES = 4;");
    expect(mockSource).toContain("function solveRotation");
  });

  it("clips the tsunami marquee at the mock card boundary", () => {
    expect(mockSource).toMatch(/\.legacy-card\[data-mock-card="tsunami"\]\s*\{[^}]*overflow:\s*hidden/s);
    expect(mockSource).toMatch(/\.legacy-mock \.legacy-card :global\(\.tsunami-banner\)\s*\{[^}]*overflow:\s*hidden/s);
    expect(mockSource).toMatch(/\.legacy-mock \.legacy-card :global\(\.tsunami-banner \.banner-areas\)\s*\{[^}]*overflow:\s*hidden/s);
    expect(mockSource).toMatch(/\.legacy-mock \.measure-item :global\(\.marquee-text\)\s*\{[^}]*position:\s*static[^}]*animation-name:\s*none/s);
  });

  it("labels the mock as v16 and exposes per-column measurement diagnostics", () => {
    const { rendered } = renderMock("legacyMock2=max&ladder=0");
    expect(rendered.container.querySelector(".mock-label strong")?.textContent).toContain("v16");
    expect(mockSource).toContain("data-left-natural-height-px");
    expect(mockSource).toContain("data-right-natural-height-px");
    expect(mockSource).toContain("data-left-capacity-px");
    expect(mockSource).toContain("data-right-capacity-px");
    expect(mockSource).toContain("measuredTickerHeightPx");
    expect(mockSource).toContain("measuredColumnPaddingPx");
  });

  it("measures typhoon full and compact variants in both shelves", () => {
    const { rendered } = renderMock("legacyMock2=max&ladder=0");

    expect(rendered.container.querySelector('[data-measure-card="typhoon:compact"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-measure-card="typhoon:full"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-center-measure-card="typhoon:compact"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-center-measure-card="typhoon:full"]')).toBeTruthy();
    expect(mockSource).toContain('displayMode={variant === "compact" ? "compact" : "full"}');
  });

  it("keeps A compact-baseline placement fixed while B expands quake then weather", () => {
    expect(mockSource).toContain('const fullVariants: VariantSelection = { quake: "compact", weather: "compact", typhoon: "full" };');
    expect(mockSource).toContain("const layoutPlan = $derived(baselinePlan);");
    expect(mockSource).toContain("function promoteAndExpand(plan: ColumnPlan): DisplaySelection");
    expect(mockSource).toContain('for (const key of ["quake", "weather"] as const)');
    expect(mockSource).toContain("if (!selectionFits(plan, promoted)) break;");
    expect(mockSource).not.toContain("expandedFits(plan");
  });

  it("exposes deterministic rotation metadata and the bounded settle coordinator", () => {
    const first = renderMock("legacyMock2=max&ladder=3&rotationTick=1");
    const second = renderMock("legacyMock2=max&ladder=3&rotationTick=1");

    expect(first.root.dataset.ladderStage).toBe("3");
    expect(first.root.dataset.rotationKeys).toBeDefined();
    expect(first.root.dataset.rotationCurrentKey).toBe(second.root.dataset.rotationCurrentKey);
    expect(first.root.dataset.measurementSettled).toBeDefined();
    expect(first.root.dataset.measurementNonconverged).toBeDefined();
    expect(first.root.dataset.rotationSlotHeightPx).toBeDefined();
    expect(first.root.dataset.rotationFailureCount).toBeDefined();
    expect(first.rendered.container.querySelector("[data-rotation-slot]")).toBeTruthy();
    expect(mockSource).toContain("rotationTickParam");
    expect(mockSource).toContain("data-rotation-keys");
    expect(mockSource).toContain("data-measurement-settled");
  });

  it("runs the real-time rotation scheduler in canonical order every 15 seconds", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout();
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3");
      await tick();
      const keys = (root.dataset.rotationKeys ?? "").split(",").filter(Boolean);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(root.dataset.rotationActiveKey).toBe(keys[0]);

      vi.advanceTimersByTime(14_999);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe(keys[0]);

      vi.advanceTimersByTime(1);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe(keys[1]);

      const observed = [keys[0], root.dataset.rotationActiveKey ?? ""];
      for (let index = 2; index < keys.length; index += 1) {
        vi.advanceTimersByTime(15_000);
        await tick();
        observed.push(root.dataset.rotationActiveKey ?? "");
      }
      expect(observed).toEqual(keys);
      vi.advanceTimersByTime(15_000);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe(keys[0]);
      expect(root.dataset.rotationOmittedCount).toBeDefined();
      rendered.unmount();
      expect(mockSource).toContain("ROTATION_PERIOD_MS = 15_000");
      expect(mockSource).toContain("rotationTickOverride");
      expect(mockSource).toContain("nextRotationKeyAfterRemoval");
      expect(mockSource).toContain("disposeRotationScheduler");
      expect(mockSource).toContain("rotationTickPending");
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("keeps wide flood placement conversion measurable for central and side promotion", () => {
    const { rendered, root } = renderMock("legacyMock2=7&flood=wide&ladder=1");

    expect(root.dataset.floodWideRequested).toBe("true");
    expect(rendered.container.querySelector('[data-measure-card="flood"] .flood-card')).toBeTruthy();
    expect(rendered.container.querySelector('[data-center-measure-card="flood"] .flood-wide-card')).toBeTruthy();
    const visibleFlood = rendered.container.querySelector<HTMLElement>('[data-mock-card="flood"]');
    if (visibleFlood?.dataset.floodRenderMode === "wide") {
      expect(visibleFlood.querySelector(".flood-wide-card")).toBeTruthy();
    } else if (visibleFlood != null) {
      expect(visibleFlood.querySelector(".flood-card")).toBeTruthy();
    }
    expect(mockSource).toContain("standbyItemsFloodWide");
    expect(mockSource).toContain("floodIsWide && (placement === \"center\" || floodWide)");
    expect(mockSource).toContain("wide surface は中央 36rem の恩恵を受ける優先候補");
    expect(mockSource).toContain("FloodWideCard");
    expect(mockSource).toContain("data-center-measure-card");
  });

  it("separates DOM settle and rotation candidate counters", () => {
    expect(mockSource).toContain("const MAX_SETTLE_PASSES = 4;");
    expect(mockSource).toContain("const MAX_ROTATION_CANDIDATE_PASSES = 5;");
    expect(mockSource).toMatch(/pass < MAX_ROTATION_CANDIDATE_PASSES[^\n]*displayedKeys\.length \+ failedKeys\.length < available\.length/s);
    expect(mockSource).not.toMatch(/pass < MAX_SETTLE_PASSES[^\n]*displayedKeys\.length/s);
  });

  it.each([
    ["zero", 80],
    ["partial", 90],
    ["all", 200],
  ] as const)("uses row-prefix expansion boundary %s without changing A placement", async (label, capacityPx) => {
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0");
      await tick();
      expect(root.dataset.ladderStage).toBe("0");
      const quakeRows = Number(root.dataset.quakeExpandedRows);
      const weatherRows = Number(root.dataset.weatherExpandedRows);
      expect((rendered.container.querySelector('[data-mock-card="quake"]') as HTMLElement | null)?.dataset.regionExpandedRows).toBe(String(quakeRows));
      expect((rendered.container.querySelector('[data-mock-card="weather"]') as HTMLElement | null)?.dataset.regionExpandedRows).toBe(String(weatherRows));
      if (label === "zero") {
        expect(quakeRows).toBe(0);
        expect(weatherRows).toBe(0);
      } else if (label === "all") {
        expect(quakeRows).toBe(3);
        expect(weatherRows).toBe(10);
      } else {
        expect([quakeRows, weatherRows].some((rows) => rows > 0)).toBe(true);
        expect(quakeRows < 3 || weatherRows < 10).toBe(true);
      }
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("keeps narrow tsunami headings on one line and right-aligns typhoon locations in both modes", () => {
    expect(mockSource).toMatch(/\.tsunami-banner \.banner-title[^}]*white-space:\s*nowrap/s);
    expect(mockSource).toMatch(/\.tsunami-banner \.updated-stamp[^}]*font-size:\s*clamp\(10px, 2\.6cqw, 14px\)/s);
    expect(mockSource).toContain("@container (max-width: 240px)");
    expect(mockSource).toMatch(/\.typhoon-card \.compact-summary \.compact-location[^}]*position:\s*absolute[^}]*text-align:\s*right/s);
    expect(mockSource).toMatch(/\.typhoon-card:not\(\.compact\) \.typhoon > \.location[^}]*position:\s*absolute[^}]*text-align:\s*right/s);
    expect(mockSource).toContain("本実装では TsunamiStandbyBanner 側の header 改修へ移す");
  });
});
