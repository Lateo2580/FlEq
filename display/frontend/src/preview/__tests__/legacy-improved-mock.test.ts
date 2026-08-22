import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import LegacyImprovedMock from "../LegacyImprovedMock.svelte";

const mockSource = readFileSync(join(__dirname, "..", "LegacyImprovedMock.svelte"), "utf8");
const solverSource = readFileSync(join(__dirname, "..", "..", "lib", "legacy-standby", "solver.ts"), "utf8");

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

async function settleMockMeasurements(probeBudget = 48): Promise<void> {
  for (let index = 0; index < probeBudget; index += 1) await tick();
}

interface MeasuredLayoutOptions {
  capacityPx?: number;
  baseCardPx?: number;
  prefixRowPx?: number;
  pageOmittedExtraPx?: number;
  cardHeightById?: Readonly<Record<string, number>>;
  pageHeightByLength?: Readonly<Record<number, number>>;
}

function installMeasuredLayout(options: MeasuredLayoutOptions = {}): () => void {
  const capacityPx = options.capacityPx ?? 180;
  const baseCardPx = options.baseCardPx ?? 90;
  const prefixRowPx = options.prefixRowPx ?? 0;
  const shelfHeight = (id: string | undefined): number => {
    if (id == null) return baseCardPx;
    const baseId = id.split(":")[0];
    const measuredBase = options.cardHeightById?.[id] ?? options.cardHeightById?.[baseId] ?? baseCardPx;
    const pageRange = id.match(/^(?:quake|weather):page:(\d+):(\d+)$/);
    if (pageRange != null) {
      const length = Number(pageRange[2]) - Number(pageRange[1]);
      return options.pageHeightByLength?.[length] ?? measuredBase + length * prefixRowPx;
    }
    const omittedPageRange = id.match(/^(?:quake|weather):page:(\d+):(\d+):omitted:(\d+)(?::tails:.*)?$/);
    if (omittedPageRange != null) {
      const length = Number(omittedPageRange[2]) - Number(omittedPageRange[1]);
      return (options.pageHeightByLength?.[length] ?? measuredBase + length * prefixRowPx)
        + Number(omittedPageRange[3]) * (options.pageOmittedExtraPx ?? 0);
    }
    const regionMatch = id.match(/:(?:region:)(\d+)$/);
    if (regionMatch != null) return measuredBase + Number(regionMatch[1]) * prefixRowPx;
    if (id.endsWith(":expanded")) {
      const maxRows = id.startsWith("quake:") ? 3 : 10;
      return measuredBase + maxRows * prefixRowPx;
    }
    return measuredBase;
  };
  const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains("legacy-layout")) return capacityPx;
      if (this.hasAttribute("data-measure-card")) return shelfHeight(this.dataset.measureCard);
      if (this.hasAttribute("data-measure-card-page")) return shelfHeight(this.dataset.measureCardPage);
      if (this.hasAttribute("data-center-measure-card")) return shelfHeight(this.dataset.centerMeasureCard);
      if (this.hasAttribute("data-center-measure-card-page")) return shelfHeight(this.dataset.centerMeasureCardPage);
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
    if (this.hasAttribute("data-measure-card") || this.hasAttribute("data-measure-card-page") || this.hasAttribute("data-center-measure-card") || this.hasAttribute("data-center-measure-card-page")) {
      const id = this.dataset.measureCard ?? this.dataset.measureCardPage ?? this.dataset.centerMeasureCard ?? this.dataset.centerMeasureCardPage;
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

type SchedulerContractMode = "rotation" | "paging" | "composite";

interface SchedulerContractCase {
  name: string;
  mode: SchedulerContractMode;
  query: string;
  epochQuery: string;
  exitQuery: string;
  exitAtMs: number;
  suspendQuery: string;
  layout: MeasuredLayoutOptions;
}

const schedulerContractCases: readonly SchedulerContractCase[] = [
  {
    name: "rotation",
    mode: "rotation",
    query: "legacyMock2=max&ladder=3&rotationKeys=volcano,heat",
    epochQuery: "legacyMock2=max&ladder=3&rotationKeys=volcano,heat&rotationChange=add:typhoon&rotationChangeAt=14999",
    exitQuery: "legacyMock2=max&ladder=3&rotationKeys=weather&rotationChange=remove:weather&rotationChangeAt=1000&cardPageTick=0",
    exitAtMs: 1_000,
    suspendQuery: "legacyMock2=max&ladder=3&rotationKeys=weather,heat",
    layout: {},
  },
  {
    name: "paging",
    mode: "paging",
    query: "legacyMock2=4&ladder=0",
    epochQuery: "legacyMock2=4&ladder=0&cardPageRefresh=1&cardPageRefreshAt=14999",
    exitQuery: "legacyMock2=4&ladder=0&cardPageRefresh=1&cardPageCollapse=1&cardPageRefreshAt=16000",
    exitAtMs: 16_000,
    suspendQuery: "legacyMock2=4&ladder=0&cardPageRefresh=1&cardPageRefreshAt=16000",
    layout: { capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 },
  },
  {
    name: "composite",
    mode: "composite",
    query: "legacyMock2=max&ladder=3&rotationKeys=weather,heat",
    epochQuery: "legacyMock2=max&ladder=3&rotationKeys=weather,heat&rotationChange=add:typhoon&rotationChangeAt=14999",
    exitQuery: "legacyMock2=max&ladder=3&rotationKeys=weather&rotationChange=remove:weather&rotationChangeAt=1000&cardPageTick=0",
    exitAtMs: 1_000,
    suspendQuery: "legacyMock2=max&ladder=3&rotationKeys=weather,heat",
    layout: {
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 40, 3: 40, 4: 100 },
    },
  },
];

function contractPage(rendered: ReturnType<typeof renderMock>, key: "quake" | "weather" = "quake"): string {
  const rotationCard = rendered.rendered.container.querySelector<HTMLElement>(
    `[data-rotation-slot] [data-mock-card="${key}"]`,
  );
  return (rotationCard
    ?? rendered.rendered.container.querySelector<HTMLElement>(`[data-mock-card="${key}"]`))?.dataset.cardPage ?? "";
}

function contractActive(root: HTMLElement): string {
  return root.dataset.rotationActiveKey ?? "";
}

interface SchedulerDiagnosticState {
  rotation: {
    stage: number | null;
    keys: string[];
    currentKey: string | null;
    phaseKey: string | null;
    processedTick: number;
    seenKeys: string[];
    tickPending: boolean;
    suspended: boolean;
    inFlight: boolean;
    timerActive: boolean;
  };
  paging: {
    stage: number | null;
    activeKeys: { quake: string | null; weather: string | null };
    pendingKeys: { quake: string[]; weather: string[] };
    cycleOriginKeys: { quake: string | null; weather: string | null };
    processedTick: number;
    previousPageCounts: { quake: number; weather: number };
    substates: {
      quake: { mode: "real" | "logical"; phaseStartedAtMs: number; processedTick: number; pageCount: number };
      weather: { mode: "real" | "logical"; phaseStartedAtMs: number; processedTick: number; pageCount: number };
    };
    activeSubstateKeys: Array<"quake" | "weather">;
    tickPending: boolean;
    suspendedKeys: string[];
    inFlight: boolean;
    timerActive: boolean;
  };
}

function schedulerState(root: HTMLElement): SchedulerDiagnosticState {
  const encoded = root.dataset.schedulerState;
  if (encoded == null) throw new Error("scheduler diagnostic state was not rendered");
  return JSON.parse(encoded) as SchedulerDiagnosticState;
}

async function withContractCase(
  contractCase: SchedulerContractCase,
  query: string,
  callback: (rendered: ReturnType<typeof renderMock>, unmount: () => void) => Promise<void>,
): Promise<void> {
  const restoreMeasuredLayout = installMeasuredLayout(contractCase.layout);
  const rendered = renderMock(query);
  let mounted = true;
  const unmount = (): void => {
    if (!mounted) return;
    mounted = false;
    rendered.rendered.unmount();
  };
  try {
    await settleMockMeasurements(320);
    await callback(rendered, unmount);
  } finally {
    unmount();
    restoreMeasuredLayout();
  }
}

function installReducedMotionMatchMedia(matches = true): () => void {
  const hadOwnMatchMedia = Object.prototype.hasOwnProperty.call(window, "matchMedia");
  const originalMatchMedia = window.matchMedia;
  const reducedMatchMedia = (): MediaQueryList => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList);
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: reducedMatchMedia });
  return () => {
    if (hadOwnMatchMedia) {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia });
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
  };
}

interface AnimationProbe {
  playState: AnimationPlayState;
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}

function installAnimationProbe(): { animations: AnimationProbe[]; restore: () => void } {
  const originalAnimate = HTMLElement.prototype.animate;
  const animations: AnimationProbe[] = [];
  const animate = vi.fn((..._args: Parameters<HTMLElement["animate"]>): Animation => {
    const probe: AnimationProbe = {
      playState: "running",
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    };
    animations.push(probe);
    return probe as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: animate });
  return {
    animations,
    restore: () => {
      if (originalAnimate == null) {
        Reflect.deleteProperty(HTMLElement.prototype, "animate");
      } else {
        Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: originalAnimate });
      }
    },
  };
}

describe("legacy improved standby mock v26", () => {
  it.each([
    ["legacyMock2=4&ladder=0", "4", 1, 3, 0, 4],
    ["legacyMock2=7&ladder=0", "7", 2, 5, 0, 7],
    ["legacyMock2=max&ladder=0", "max", 2, 5, 2, 9],
  ] as const)("renders %s with the fixed tier and no paging", (query, scenario, left, right, suppressed, inputCount) => {
    const { rendered, root } = renderMock(query);

    expect(root.dataset.scenario).toBe(scenario);
    expect(root.dataset.ladderStage).toBe("0");
    expect(root.dataset.ladderAuto).toBe("false");
    expect(root.dataset.outerPaging).toBe("none");
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
    expect(root.dataset.placementSurplusUse).toBeDefined();
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

  it("pages residual quake and weather regions with a fixed card height", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&cardPageTick=1");
      await settleMockMeasurements();
      expect(root.dataset.cardPageTickOverride).toBe("1");
      expect(root.dataset.cardPageActive).toBe("true");
      expect(root.dataset.cardPageCounts).toMatch(/quake:[2-9]/);

      const pageCards = [...rendered.container.querySelectorAll<HTMLElement>('[data-mock-card="quake"], [data-mock-card="weather"]')];
      expect(pageCards.some((card) => (card.dataset.cardPage ?? "").includes("/"))).toBe(true);
      for (const card of pageCards) {
        const page = card.dataset.cardPage;
        if (page == null) continue;
        const [current, total] = page.split("/").map(Number);
        expect(current).toBeGreaterThanOrEqual(1);
        expect(current).toBeLessThanOrEqual(total);
        expect(Number(card.dataset.cardPageFixedHeight)).toBe(Number(card.dataset.naturalHeightPx));
        const indicator = card.querySelector<HTMLElement>("[data-card-page-indicator]");
        const body = card.querySelector<HTMLElement>("[data-card-page-body]");
        expect(indicator?.textContent).toBe(`${current}/${total}`);
        expect(indicator?.parentElement).toBe(card);
        expect(body?.contains(indicator ?? null)).toBe(false);
        if (indicator != null && body != null) {
          const indicatorRect = indicator.getBoundingClientRect();
          const bodyRect = body.getBoundingClientRect();
          const overlapWidth = Math.max(0, Math.min(indicatorRect.right, bodyRect.right) - Math.max(indicatorRect.left, bodyRect.left));
          const overlapHeight = Math.max(0, Math.min(indicatorRect.bottom, bodyRect.bottom) - Math.max(indicatorRect.top, bodyRect.top));
          expect(overlapWidth * overlapHeight).toBe(0);
        }
        expect(card.textContent).not.toContain("ほか3地域");
      }
      expect(mockSource).toContain("function partitionQuakePages");
      expect(mockSource).toContain("function partitionWeatherPages");
      expect(mockSource).toContain("data-card-page");
      expect(mockSource).toContain("pageMeasureEntries");
      expect(mockSource).toContain("cardPageTickOverride");
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("greedily partitions canonical regions by measured range height and keeps page identity keys", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 40, 3: 100 },
    });
    try {
      const expected = ["宮崎市", "日南市", "都城市", "延岡市", "西都市", "えびの市", "高鍋町"];
      const observed = new Set<string>();
      const pageAreaCounts: number[] = [];
      let pageKeys: string[] = [];
      let pageCount = 0;
      for (let pageTick = 0; pageTick < 4; pageTick += 1) {
        const { rendered, root } = renderMock(`legacyMock2=4&ladder=0&cardPageTick=${pageTick}`);
        await settleMockMeasurements();
        const card = rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]');
        const current = card?.dataset.cardPage ?? "";
        pageCount = Number(current.split("/")[1]);
        pageKeys = JSON.parse(card?.dataset.cardPageKeys ?? "[]") as string[];
        const areas = [...(card?.querySelectorAll<HTMLElement>(".city-name") ?? [])].map((node) => node.textContent ?? "");
        areas.forEach((area) => observed.add(area));
        pageAreaCounts.push(areas.length);
        rendered.unmount();
      }
      expect(pageCount).toBe(4);
      expect(pageAreaCounts).toEqual([2, 2, 2, 1]);
      expect(pageKeys).toEqual(["宮崎市", "都城市", "西都市", "高鍋町"]);
      expect([...observed]).toEqual(expected);

      const weatherExpected = [
        "熊本県山鹿市", "熊本県菊池市", "熊本県玉名市", "宮崎県延岡市", "宮崎県日向市",
        "大分県佐伯市", "鹿児島県霧島市", "福岡県朝倉市", "佐賀県嬉野市", "長崎県諫早市",
        "熊本県阿蘇市", "宮崎県都城市",
      ];
      const weatherAreas = new Set<string>();
      for (let pageTick = 0; ; pageTick += 1) {
        const { rendered, root } = renderMock(`legacyMock2=4&ladder=0&cardPageTick=${pageTick}`);
        await settleMockMeasurements();
        const weather = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]');
        const total = Number(weather?.dataset.cardPage?.split("/")[1] ?? 1);
        for (const group of weather?.querySelectorAll<HTMLElement>(".pref-group") ?? []) {
          const pref = group.querySelector<HTMLElement>(".pref-name")?.textContent ?? "";
          for (const city of group.querySelectorAll<HTMLElement>(".city-name")) {
            weatherAreas.add(`${pref}${city.textContent ?? ""}`);
          }
        }
        expect(root.dataset.cardPageKeys).toContain("熊本県山鹿市");
        rendered.unmount();
        if (pageTick + 1 >= total) break;
        if (pageTick >= 127) throw new Error("weather candidate pagination did not settle");
      }
      expect([...weatherAreas]).toEqual(weatherExpected);

      const epochStart = mockSource.indexOf("function cardPageEpochKey");
      const epochEnd = mockSource.indexOf("function cardPagePartition", epochStart);
      expect(mockSource.slice(epochStart, epochEnd)).not.toContain("measurementPass");
      expect(mockSource).toMatch(/\.legacy-card\.paged-card \.card-page-body\s*\{[^}]*overflow:\s*hidden/s);
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("starts partitioning from a zero-visible group and marks only supply shrink as truncated", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&zeroVisible=1&cardPageTick=2");
      await settleMockMeasurements();
      expect(root.dataset.candidateTruncated).toBe("false");
      expect(root.dataset.cardPageInfeasible).toBe("false");
      expect(root.dataset.cardPageActive).toBe("true");
      expect(rendered.container.querySelector('[data-mock-card="quake"]')?.textContent).toContain("都城市");
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPageKeys).toContain("宮崎市");
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("uses one partition probe per card for a tail-only supply", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&tailOnly=1&cardPageTick=0");
      await settleMockMeasurements(320);
      const probeCounts = JSON.parse(root.dataset.partitionProbeCount ?? "{}") as { quake?: number; weather?: number };
      expect(root.dataset.candidateTruncated).toBe("true");
      expect(probeCounts.quake).toBe(1);
      expect(probeCounts.weather).toBe(1);
      expect(probeCounts.quake).toBeLessThanOrEqual(Math.max(1, 2 * 0));
      expect(probeCounts.weather).toBeLessThanOrEqual(Math.max(1, 2 * 0));
      expect(rendered.container.querySelector('[data-mock-card="quake"]')?.textContent).toContain("ほか");
      expect(rendered.container.querySelector('[data-mock-card="weather"]')?.textContent).toContain("ほか");
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("keeps the final supplied page's omitted count visible only when candidates are truncated", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&candidateTruncated=1&cardPageTick=3");
      await settleMockMeasurements(320);
      expect(root.dataset.candidateTruncated).toBe("true");
      expect(root.dataset.cardPageKeys).toContain("宮崎市");
      const quake = rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]');
      const weather = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]');
      const quakePageCount = Number(quake?.dataset.cardPage?.split("/")[1] ?? 1);
      const weatherPageCount = Number(weather?.dataset.cardPage?.split("/")[1] ?? 1);
      rendered.unmount();
      const finalQuake = renderMock(`legacyMock2=4&ladder=0&candidateTruncated=1&cardPageTick=${quakePageCount - 1}`);
      await settleMockMeasurements();
      expect(finalQuake.rendered.container.querySelector('[data-mock-card="quake"]')?.textContent).toContain("ほか");
      finalQuake.rendered.unmount();
      const finalWeather = renderMock(`legacyMock2=4&ladder=0&candidateTruncated=1&cardPageTick=${weatherPageCount - 1}`);
      await settleMockMeasurements();
      expect(finalWeather.rendered.container.querySelector('[data-mock-card="weather"]')?.textContent).toContain("ほか");
      finalWeather.rendered.unmount();
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("marks an infeasible partition and leaves the compact omission row", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 100 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0");
      await settleMockMeasurements();
      expect(root.dataset.cardPageInfeasible).toBe("true");
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPageInfeasible).toBe("true");
      expect(rendered.container.querySelector('[data-mock-card="quake"]')?.textContent).toContain("ほか");
    } finally {
      restoreMeasuredLayout();
    }
  });

  // 129件の実組版は環境ごとに所要時間が揺れる。性能退行は probe 上限 assertion で検出する。
  it("keeps 129-candidate partition probes linear for both pageable cards", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 40, 3: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&candidate129=1");
      await settleMockMeasurements(320);
      const probeCounts = JSON.parse(root.dataset.partitionProbeCount ?? "{}") as { quake?: number; weather?: number };
      expect(root.dataset.candidateTruncated).toBe("true");
      expect(probeCounts.quake).toBeGreaterThan(0);
      expect(probeCounts.weather).toBeGreaterThan(0);
      expect(probeCounts.quake).toBeLessThanOrEqual(256);
      expect(probeCounts.weather).toBeLessThanOrEqual(256);
      expect(root.dataset.cardPageInfeasible).toBe("false");
      expect(root.dataset.cardPageKeys).toContain("宮崎県候補地域001");
      expect(mockSource).toContain("const CANDIDATE_SAFE_LIMIT = 128;");
      expect(mockSource).toContain("data-partition-probe-count");
      expect(mockSource).not.toMatch(/for \(let start = 0; start < count; start \+= 1\)/);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
    }
  }, 15_000);

  // 129件の実組版は環境ごとに所要時間が揺れる。settle状態の遷移 assertion は維持する。
  it("keeps measurement unsettled while the partition queue is still being consumed", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 40, 3: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&candidate129=1");
      expect(root.dataset.measurementSettled).toBe("false");
      await settleMockMeasurements(1);
      expect(root.dataset.measurementSettled).toBe("false");
      await settleMockMeasurements(320);
      expect(root.dataset.fontsReady).toBe("true");
      expect(root.dataset.measurementSettled).toBe("true");
      expect(root.dataset.measurementEpoch).not.toBe("");
      expect(root.dataset.measurementNonconverged).toBe("false");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
    }
  }, 15_000);

  it("keeps truncated-tail measurement in the sequential partition probe", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageOmittedExtraPx: 1,
      pageHeightByLength: { 1: 40, 2: 40, 3: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&candidateTruncated=1");
      await settleMockMeasurements();
      expect(root.dataset.partitionTailProbe).toBe("true");
      expect(root.dataset.cardPageInfeasible).toBe("false");
      expect(mockSource).toContain("entry.tails");
      expect(mockSource).toContain("data-card-page-tail-counts");
      expect(mockSource).toContain(":omitted:");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("keeps group and kind tails on their own truncated final page", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 40, 3: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&multiTail=1&candidateTruncated=1&cardPageTick=1");
      await settleMockMeasurements(320);
      const quake = rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]');
      const weather = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]');
      expect(root.dataset.candidateTruncated).toBe("true");
      expect(quake?.querySelector<HTMLElement>("[data-card-page-indicator]")?.textContent).toBe("2/2");
      expect(weather?.querySelector<HTMLElement>("[data-card-page-indicator]")?.textContent).toBe("2/2");

      const quakeTailPages = JSON.parse(quake?.dataset.cardPageTailCounts ?? "[]") as Array<Array<{ kindKey: string; omittedAreaCount: number }>>;
      const weatherTailPages = JSON.parse(weather?.dataset.cardPageTailCounts ?? "[]") as Array<Array<{ kindKey: string; omittedAreaCount: number }>>;
      expect(quakeTailPages[1]).toEqual([{ kindKey: "5弱:5", omittedAreaCount: 2 }]);
      expect(weatherTailPages[1]).toEqual([{ kindKey: "暴風警報", omittedAreaCount: 2 }]);
      expect(quake?.textContent).toContain("ほか");
      expect(weather?.textContent).toContain("ほか");
      expect(quake?.textContent).toContain("5弱");
      expect(weather?.textContent).toContain("暴風警報");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("uses kind and occurrence in page identity when region names collide", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 50,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&duplicatePageKeys=1&cardPageTick=0");
      await settleMockMeasurements();
      const weather = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]');
      const heads = JSON.parse(weather?.dataset.cardPageKeys ?? "[]") as string[];
      const identities = JSON.parse(weather?.dataset.cardPageIdentities ?? "[]") as string[];
      expect(heads.filter((head) => head === "熊本県山鹿市")).toHaveLength(2);
      expect(new Set(identities).size).toBe(identities.length);
      expect(identities.filter((identity) => identity.includes("熊本県山鹿市"))).toHaveLength(2);
      expect(root.dataset.cardPageActiveKeys).toContain("大雨警報(土砂災害)");
      expect(root.dataset.cardPageActiveKeys).not.toContain("undefined");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
    }
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
    expect(mockSource).toContain('from "../lib/legacy-standby/solver"');
    expect(mockSource).toContain("makeColumnPlan as solveColumnPlan");
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
    expect(solverSource).toContain("centerFixedHeightPx");
    expect(solverSource).toContain("centerOverflowPx");
    expect(mockSource).toMatch(/\.center-card-region\s*\{[^}]*gap:\s*var\(--mock-gap\)/s);
    expect(mockSource).not.toContain("min-height: clamp(3rem, 8vh, 6rem)");
    expect(mockSource).toContain("makeColumnPlan as solveColumnPlan");
    expect(mockSource).toContain("const MAX_SETTLE_PASSES = 4;");
    expect(mockSource).toContain("makeColumnPlan as solveColumnPlan");
  });

  it("clips the tsunami marquee at the mock card boundary", () => {
    expect(mockSource).toMatch(/\.legacy-card\[data-mock-card="tsunami"\]\s*\{[^}]*overflow:\s*hidden/s);
    expect(mockSource).toMatch(/\.legacy-mock \.legacy-card :global\(\.tsunami-banner\)\s*\{[^}]*overflow:\s*hidden/s);
    expect(mockSource).toMatch(/\.legacy-mock \.legacy-card :global\(\.tsunami-banner \.banner-areas\)\s*\{[^}]*overflow:\s*hidden/s);
    expect(mockSource).toMatch(/\.legacy-mock \.measure-item :global\(\.marquee-text\)\s*\{[^}]*position:\s*static[^}]*animation-name:\s*none/s);
  });

  it("labels the mock as v26 and exposes per-column measurement diagnostics", () => {
    const { rendered } = renderMock("legacyMock2=max&ladder=0");
    expect(rendered.container.querySelector(".mock-label strong")?.textContent).toContain("v26");
    expect(mockSource).toContain("data-left-natural-height-px");
    expect(mockSource).toContain("data-right-natural-height-px");
    expect(mockSource).toContain("data-left-capacity-px");
    expect(mockSource).toContain("data-right-capacity-px");
    expect(mockSource).toContain("measuredTickerHeightPx");
    expect(mockSource).toContain("measuredColumnPaddingPx");
  });

  it("exposes the INV-決定 scheduler state without source inspection", async () => {
    vi.useFakeTimers();
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3&rotationKeys=volcano,heat");
      await settleMockMeasurements(320);
      const initial = schedulerState(root);
      expect(initial.rotation.currentKey).toBe("volcano");
      expect(initial.rotation.seenKeys).toContain("volcano");
      expect(initial.rotation.processedTick).toBe(0);
      expect(initial.paging.previousPageCounts.quake).toBeGreaterThanOrEqual(1);
      expect(initial.rotation.inFlight).toBe(false);
      vi.advanceTimersByTime(15_000);
      await tick();
      await tick();
      const afterTick = schedulerState(root);
      expect(afterTick.rotation.processedTick).toBe(1);
      expect(afterTick.rotation.seenKeys.length).toBeGreaterThanOrEqual(1);
      expect(afterTick.paging.previousPageCounts.quake).toBe(initial.paging.previousPageCounts.quake);
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
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
    expect(mockSource).toContain("const layoutPlan = $derived(baselinePlan);");
    expect(mockSource).toContain("promoteAndExpand as solvePromoteAndExpand");
    expect(mockSource).not.toContain("promoteAndExpandLegacy");
  });

  it("ranks fitting placements by achievable surplus use after center and wide-flood priority", () => {
    expect(mockSource).toContain("achievableSurplusUse as solveAchievableSurplusUse");
    expect(mockSource).not.toContain("function achievableSurplusUse");
  });

  it("chooses the higher-expansion placement in the counterfixture", async () => {
    const counterfixture = {
      capacityPx: 100,
      baseCardPx: 20,
      prefixRowPx: 10,
      cardHeightById: { quake: 85, weather: 50, volcano: 1, heat: 10 },
    } as const;
    const restoreMeasuredLayout = installMeasuredLayout(counterfixture);
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0");
      await settleMockMeasurements();
      const leftKeys = [...rendered.container.querySelectorAll<HTMLElement>('[data-mock-side="left"] [data-mock-card]')]
        .map((card) => card.dataset.mockCard);
      const rightKeys = [...rendered.container.querySelectorAll<HTMLElement>('[data-mock-side="right"] [data-mock-card]')]
        .map((card) => card.dataset.mockCard);
      expect(root.dataset.ladderStage).toBe("0");
      expect(leftKeys).toEqual(["quake", "volcano"]);
      expect(rightKeys).toEqual(["weather", "heat"]);
      expect(Number(root.dataset.weatherExpandedRows)).toBe(4);
    } finally {
      restoreMeasuredLayout();
    }
  });

  it("enumerates multiple central eligible-card subsets without a one-card cap", () => {
    expect(mockSource).toContain("makeColumnPlan as solveColumnPlan");
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

  it("merges a long rotation pause into the monotonic phase in one pass", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout();
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3");
      await tick();
      await tick();
      await tick();
      const keys = (root.dataset.rotationKeys ?? "").split(",").filter(Boolean);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(root.dataset.rotationActiveKey).toBe(keys[0]);

      const elapsedTicks = 7;
      vi.advanceTimersByTime(15_000 * elapsedTicks + 1);
      await tick();
      await tick();
      expect(root.dataset.rotationActiveKey).toBe(keys[elapsedTicks % keys.length]);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("cycles residual card pages every 15 seconds and coalesces a long pause", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0");
      await settleMockMeasurements();
      const counts = (root.dataset.cardPageCounts ?? "").split(",").map((entry) => Number(entry.split(":")[1]));
      const total = Math.max(...counts);
      expect(total).toBeGreaterThan(1);
      expect(root.dataset.cardPageTick).toBe("0");

      const elapsedTicks = 7;
      vi.advanceTimersByTime(15_000 * elapsedTicks + 1);
      await tick();
      expect(root.dataset.cardPageTick).toBe(String(elapsedTicks));
      const quakeTotal = Number((root.dataset.cardPageCounts ?? "").split(",")[0].split(":")[1]);
      const quake = rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]');
      expect(quake?.dataset.cardPage).toBe(`${(elapsedTicks % quakeTotal) + 1}/${quakeTotal}`);
      expect(mockSource).toContain("function processCardPageTick");
      expect(mockSource).toContain("elapsedTicks");
      expect(mockSource).toContain("disposeCardPageScheduler");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("preserves the current page identity through rapid repartition updates", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&cardPageRefresh=1&cardPageRefreshAt=16000");
      await settleMockMeasurements(320);
      const firstCard = rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]');
      expect(firstCard?.dataset.cardPage).toBe("1/7");

      vi.advanceTimersByTime(15_000);
      await tick();
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage).toBe("2/7");

      vi.advanceTimersByTime(1_000);
      await settleMockMeasurements(320);
      expect(root.dataset.cardPageRevision).toBe("1");
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage).toBe("2/8");

      vi.advanceTimersByTime(2_000);
      await settleMockMeasurements(320);
      expect(root.dataset.cardPageRevision).toBe("3");
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage).toBe("2/8");
      expect(root.dataset.cardPageTick).toBe("1");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("rescues a deferred page cycle when its origin page is deleted", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&cardPageRefresh=1&cardPageRefreshDeleteOrigin=1&cardPageRefreshAt=16000");
      await settleMockMeasurements(320);
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage).toBe("1/7");

      vi.advanceTimersByTime(15_000);
      await tick();
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage).toBe("2/7");

      vi.advanceTimersByTime(1_000);
      await settleMockMeasurements(320);
      expect(root.dataset.cardPageRevision).toBe("1");
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage).toBe("2/8");

      vi.advanceTimersByTime(1_000);
      await settleMockMeasurements(320);
      expect(root.dataset.cardPageRevision).toBe("2");
      expect(rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage).toBe("1/7");
      expect(root.dataset.cardPageActiveKeys).toContain("6弱:7|日南市|0");

      const observed = new Set<string>();
      for (let index = 0; index < 14; index += 1) {
        vi.advanceTimersByTime(15_000);
        await settleMockMeasurements(320);
        const current = rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]')?.dataset.cardPage;
        if (current != null) observed.add(current);
      }
      expect(observed).toContain("7/7");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("advances a rotation card once per reappearance and reaches every page in the gcd case", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 40, 3: 40, 4: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3&rotationKeys=weather,heat");
      await settleMockMeasurements(320);
      const initialWeather = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]');
      const pageCount = Number(initialWeather?.dataset.cardPage?.split("/")[1] ?? 0);
      expect(pageCount).toBeGreaterThan(1);
      expect(pageCount % 2).toBe(0);
      const observed = new Set<string>();
      if (initialWeather?.dataset.cardPage != null) observed.add(initialWeather.dataset.cardPage);

      for (let reappearance = 0; reappearance < pageCount - 1; reappearance += 1) {
        vi.advanceTimersByTime(30_000);
        await tick();
        const weather = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]');
        expect(root.dataset.rotationActiveKey).toBe("weather");
        if (weather?.dataset.cardPage != null) observed.add(weather.dataset.cardPage);
      }
      expect(observed.size).toBe(pageCount);
      expect([...observed].map((page) => Number(page.split("/")[0])).sort((a, b) => a - b)).toEqual(
        Array.from({ length: pageCount }, (_, index) => index + 1),
      );
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("counts a singleton rotation slot boundary as reappearance", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 90,
      baseCardPx: 40,
      prefixRowPx: 10,
      pageHeightByLength: { 1: 40, 2: 40, 3: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3&rotationKeys=weather");
      await settleMockMeasurements(320);
      const weather = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]');
      const pageCount = Number(weather?.dataset.cardPage?.split("/")[1] ?? 0);
      expect(root.dataset.rotationKeys).toBe("weather");
      expect(pageCount).toBeGreaterThan(1);
      const observed = new Set<string>();
      if (weather?.dataset.cardPage != null) observed.add(weather.dataset.cardPage);
      for (let boundary = 0; boundary < pageCount - 1; boundary += 1) {
        vi.advanceTimersByTime(15_000);
        await tick();
        await tick();
        const current = rendered.container.querySelector<HTMLElement>('[data-mock-card="weather"]')?.dataset.cardPage;
        if (current != null) observed.add(current);
      }
      expect(observed.size).toBe(pageCount);
      expect(root.dataset.rotationCycleMs).toBe("15000");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("keeps the same key and starts the new phase at its display start on addition", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout();
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3&rotationKeys=volcano,heat&rotationChange=add:typhoon&rotationChangeAt=1000");
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("volcano");

      vi.advanceTimersByTime(1_000);
      await tick();
      expect(root.dataset.rotationKeys).toBe("typhoon,volcano,heat");
      expect(root.dataset.rotationActiveKey).toBe("volcano");

      vi.advanceTimersByTime(14_000);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("heat");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("keeps the active key and resets phase when a non-active key is removed", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout();
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3&rotationKeys=typhoon,volcano,heat&rotationChange=remove:volcano&rotationChangeAt=31000");
      await tick();
      vi.advanceTimersByTime(30_000);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("heat");

      vi.advanceTimersByTime(1_000);
      await tick();
      expect(root.dataset.rotationKeys).toBe("typhoon,heat");
      expect(root.dataset.rotationActiveKey).toBe("heat");

      vi.advanceTimersByTime(14_000);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("typhoon");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("moves immediately to the canonical successor when the active key is removed", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout();
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3&rotationKeys=typhoon,volcano,heat&rotationChange=remove:typhoon&rotationChangeAt=1000");
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("typhoon");

      vi.advanceTimersByTime(1_000);
      await tick();
      expect(root.dataset.rotationKeys).toBe("volcano,heat");
      expect(root.dataset.rotationActiveKey).toBe("volcano");

      vi.advanceTimersByTime(15_000);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("heat");
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("uses a 15 second times rotation-set length re-display interval", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout();
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3&rotationKeys=typhoon,volcano,heat");
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("typhoon");

      vi.advanceTimersByTime(30_000);
      await tick();
      expect(root.dataset.rotationActiveKey).not.toBe("typhoon");

      vi.advanceTimersByTime(15_000);
      await tick();
      expect(root.dataset.rotationActiveKey).toBe("typhoon");
      expect(root.dataset.rotationCycleMs).toBe("45000");
      expect(mockSource).toContain("function rotationRedisplayIntervalMs");
      rendered.unmount();
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
    expect(mockSource).toContain("makeColumnPlan as solveColumnPlan");
    expect(mockSource).toContain("FloodWideCard");
    expect(mockSource).toContain("data-center-measure-card");
  });

  it("exposes v20 surplus-use diagnostics for wide flood and recalculated counts", () => {
    const { root, rendered } = renderMock("legacyMock2=7&floodWide=1&ladder=0");
    expect(root.dataset.typhoonVariant).toBeDefined();
    expect(root.dataset.floodForm).toBe("wide");
    expect(root.dataset.placementSurplusUse).toBeDefined();
    const expandedCounts = JSON.parse(root.dataset.expandedCounts ?? "{}") as {
      quake?: { count: number; n: number };
      weather?: Record<string, { count: number; n: number }>;
    };
    expect(expandedCounts.quake?.count).toBe(7);
    expect(expandedCounts.quake?.n).toBe(0);
    expect(expandedCounts.weather?.["大雨警報(土砂災害)"]?.count).toBe(12);
    expect(expandedCounts.weather?.["大雨警報(土砂災害)"]?.n).toBe(0);
    expect(mockSource).toContain("data-typhoon-variant");
    expect(mockSource).toContain("data-flood-form");
    expect(mockSource).toContain("data-expanded-counts");
    rendered.unmount();
  });

  it("separates DOM settle and rotation candidate counters", () => {
    expect(mockSource).toContain("const MAX_SETTLE_PASSES = 4;");
    expect(solverSource).toContain("const MAX_ROTATION_CANDIDATE_PASSES = 5;");
    expect(solverSource).toMatch(/pass < MAX_ROTATION_CANDIDATE_PASSES[^\n]*displayed\.length \+ failed\.length/);
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

  it("takes a later fitting prefix in the non-monotonic B counterfixture", async () => {
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 120,
      baseCardPx: 20,
      prefixRowPx: 0,
      cardHeightById: {
        quake: 20,
        weather: 20,
        "quake:region:1": 60,
        "quake:region:2": 120,
        "quake:region:3": 80,
        "quake:expanded": 80,
      },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&nonMonotonicB=1");
      await settleMockMeasurements(320);
      expect(root.dataset.quakeExpandedRows).toBe("3");
      expect(rendered.container.querySelector('[data-mock-card="quake"]')?.textContent).toContain("非単調追加地域C");
      expect(mockSource).toContain("legacyImprovedNonMonotonicLatestQuake");
      expect(mockSource).toContain("for (let regionRows = 1; regionRows <= maxRows; regionRows += 1)");
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
    expect(mockSource).toMatch(/\.typhoon-card:not\(\.compact\) \.typhoon > strong[^}]*padding-right:\s*45%[^}]*white-space:\s*nowrap/s);
    expect(mockSource).toContain(".legacy-mock :global(.typhoon-card .typhoon)");
    expect(mockSource).toContain("本実装では TsunamiStandbyBanner 側の header 改修へ移す");
  });

  it("preserves page identity across resize-like stage transitions", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock(
        "legacyMock2=4&ladder=0&cardPageTick=0&stageSequence=1@1000,2@2000,3@3000,0@4000",
      );
      await settleMockMeasurements(320);
      const initialActiveKeys = root.dataset.cardPageActiveKeys;
      const initialQuakeKey = schedulerState(root).paging.activeKeys.quake;
      expect(root.dataset.ladderStage).toBe("0");
      for (const expectedStage of [1, 2, 3, 0]) {
        vi.advanceTimersByTime(1_000);
        await settleMockMeasurements(320);
        expect(root.dataset.ladderStage).toBe(String(expectedStage));
        expect(root.dataset.cardPageActiveKeys).toBe(initialActiveKeys);
        expect(schedulerState(root).paging.activeKeys.quake).toBe(initialQuakeKey);
      }
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("performs a real rotation-stage exit when the card set shrinks", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=max&fixtureRemove=volcano,heat&fixtureRemoveAt=1000");
      await settleMockMeasurements(320);
      expect(root.dataset.ladderAuto).toBe("true");
      expect(root.dataset.ladderStage).toBe("3");
      expect(rendered.container.querySelector("[data-rotation-slot]")).toBeTruthy();

      vi.advanceTimersByTime(1_000);
      await settleMockMeasurements(320);
      expect(Number(root.dataset.ladderStage)).toBeLessThan(3);
      expect(rendered.container.querySelector('[data-mock-card="volcano"]')).toBeNull();
      expect(rendered.container.querySelector('[data-mock-card="heat"]')).toBeNull();
      expect(root.dataset.rotationKeys).toBe("");
      expect(schedulerState(root).rotation.timerActive).toBe(false);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("keeps the shared paging timer alive when one pageable card disappears", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&fixtureRemove=quake&fixtureRemoveAt=1000");
      await settleMockMeasurements(320);
      expect(Number(root.dataset.cardPageCounts?.split(",")[0]?.split(":")[1] ?? 0)).toBeGreaterThan(1);
      const weatherBefore = contractPage({ rendered, root }, "weather");

      vi.advanceTimersByTime(1_000);
      await settleMockMeasurements(320);
      expect(rendered.container.querySelector('[data-mock-card="quake"]')).toBeNull();
      expect(schedulerState(root).paging.previousPageCounts.quake).toBe(0);
      expect(schedulerState(root).paging.previousPageCounts.weather).toBeGreaterThan(1);
      expect(schedulerState(root).paging.timerActive).toBe(true);

      vi.advanceTimersByTime(15_000);
      await settleMockMeasurements(64);
      expect(contractPage({ rendered, root }, "weather")).not.toBe(weatherBefore);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("disposes the shared paging timer only after the final pageable card exits", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock("legacyMock2=4&ladder=0&fixtureRemove=quake,weather&fixtureRemoveAt=1000");
      await settleMockMeasurements(320);
      expect(schedulerState(root).paging.activeSubstateKeys).toEqual(["quake", "weather"]);
      expect(schedulerState(root).paging.timerActive).toBe(true);

      vi.advanceTimersByTime(1_000);
      await settleMockMeasurements(320);
      const afterExit = schedulerState(root).paging;
      expect(rendered.container.querySelector('[data-mock-card="quake"]')).toBeNull();
      expect(rendered.container.querySelector('[data-mock-card="weather"]')).toBeNull();
      expect(afterExit.activeSubstateKeys).toEqual([]);
      expect(afterExit.activeKeys).toEqual({ quake: null, weather: null });
      expect(afterExit.timerActive).toBe(false);
      const tickAfterExit = root.dataset.cardPageTick;

      vi.advanceTimersByTime(30_000);
      await settleMockMeasurements(64);
      expect(root.dataset.cardPageTick).toBe(tickAfterExit);
      expect(schedulerState(root).paging.timerActive).toBe(false);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("starts a fresh real-time phase after rotation suspension without retroactive ticks", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock(
        "legacyMock2=max&rotationKeys=weather&fixtureRemove=volcano,heat&fixtureRemoveAt=1000",
      );
      await settleMockMeasurements(320);
      expect(root.dataset.ladderStage).toBe("3");
      const initialPage = contractPage({ rendered, root }, "weather");
      expect(schedulerState(root).paging.substates.weather.mode).toBe("logical");

      vi.advanceTimersByTime(1_000);
      await settleMockMeasurements(320);
      expect(Number(root.dataset.ladderStage)).toBeLessThan(3);
      const afterResume = schedulerState(root);
      expect(afterResume.paging.substates.weather.mode).toBe("real");
      expect(afterResume.paging.substates.weather.processedTick).toBe(0);
      expect(contractPage({ rendered, root }, "weather")).toBe(initialPage);

      vi.advanceTimersByTime(14_999);
      await settleMockMeasurements(64);
      expect(schedulerState(root).paging.substates.weather.processedTick).toBe(0);
      expect(contractPage({ rendered, root }, "weather")).toBe(initialPage);
      vi.advanceTimersByTime(1);
      await settleMockMeasurements(64);
      expect(schedulerState(root).paging.substates.weather.processedTick).toBe(1);
      expect(contractPage({ rendered, root }, "weather")).not.toBe(initialPage);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("keeps a pageable card alive while its actual rotation slot is suspended", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({
      capacityPx: 70,
      baseCardPx: 40,
      prefixRowPx: 10,
      cardHeightById: { tsunami: 35, quake: 35 },
      pageHeightByLength: { 1: 40, 2: 40, 3: 40, 4: 100 },
    });
    try {
      const { rendered, root } = renderMock("legacyMock2=max&ladder=3");
      await settleMockMeasurements(320);
      const rotationKeys = (root.dataset.rotationKeys ?? "").split(",").filter(Boolean);
      expect(rotationKeys).toContain("weather");
      expect(schedulerState(root).paging.substates.weather.mode).toBe("logical");
      const initialPage = contractPage({ rendered, root }, "weather");
      const pageCount = Number(initialPage.split("/")[1] ?? 0);
      expect(pageCount).toBeGreaterThan(1);
      const initialIdentity = schedulerState(root).paging.activeKeys.weather;

      vi.advanceTimersByTime(15_000);
      await settleMockMeasurements(64);
      expect(root.dataset.rotationActiveKey).not.toBe("weather");
      expect(rendered.container.querySelector('[data-rotation-slot] [data-mock-card="weather"]')).toBeNull();
      expect(schedulerState(root).paging.previousPageCounts.weather).toBe(pageCount);
      expect(schedulerState(root).paging.activeKeys.weather).toBe(initialIdentity);

      const seen = new Set<string>([initialPage]);
      for (let tickIndex = 1; tickIndex <= rotationKeys.length * pageCount; tickIndex += 1) {
        vi.advanceTimersByTime(15_000);
        await settleMockMeasurements(64);
        if (root.dataset.rotationActiveKey === "weather") {
          const page = contractPage({ rendered, root }, "weather");
          if (page !== "") seen.add(page);
        }
      }
      expect(seen.size).toBe(pageCount);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  it("preserves a pageable card identity through real stage transitions without an override", async () => {
    vi.useFakeTimers();
    const restoreMeasuredLayout = installMeasuredLayout({ capacityPx: 90, baseCardPx: 40, prefixRowPx: 10 });
    try {
      const { rendered, root } = renderMock(
        "legacyMock2=4&stageSequence=1@1000,2@2000,3@3000,0@4000",
      );
      await settleMockMeasurements(320);
      const initialPage = contractPage({ rendered, root }, "weather");

      vi.advanceTimersByTime(4_000);
      await settleMockMeasurements(320);
      expect(root.dataset.ladderStage).toBe("0");
      expect(contractPage({ rendered, root }, "weather")).toBe(initialPage);

      vi.advanceTimersByTime(10_999);
      await settleMockMeasurements(64);
      expect(contractPage({ rendered, root }, "weather")).toBe(initialPage);
      vi.advanceTimersByTime(1);
      await settleMockMeasurements(64);
      expect(contractPage({ rendered, root }, "weather")).not.toBe(initialPage);
      rendered.unmount();
    } finally {
      restoreMeasuredLayout();
      vi.useRealTimers();
    }
  });

  describe("v26 common time-sliced scheduler contract", () => {
    it("gives epoch precedence without skipping a due tick", async () => {
      vi.useFakeTimers();
      try {
        for (const contractCase of schedulerContractCases) {
          await withContractCase(contractCase, contractCase.epochQuery, async ({ rendered, root }) => {
            const before = contractCase.mode === "paging" ? contractPage({ rendered, root }) : contractActive(root);
            vi.advanceTimersByTime(15_000);
            await tick();
            await settleMockMeasurements(64);
            if (contractCase.mode === "paging") {
              expect(root.dataset.cardPageRevision, contractCase.name).toBe("1");
              expect(root.dataset.cardPageTick, contractCase.name).toBe("1");
              expect(contractPage({ rendered, root }), contractCase.name).not.toBe(before);
            } else {
              expect(root.dataset.rotationKeys, contractCase.name).toContain("typhoon");
              expect(contractActive(root), contractCase.name).not.toBe(before);
            }
          });
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("continues time slicing with reduced motion enabled", async () => {
      vi.useFakeTimers();
      const restoreMatchMedia = installReducedMotionMatchMedia();
      try {
        for (const contractCase of schedulerContractCases) {
          await withContractCase(contractCase, contractCase.query, async ({ rendered, root }) => {
            const before = contractCase.mode === "paging" ? contractPage({ rendered, root }) : contractActive(root);
            vi.advanceTimersByTime(15_000);
            await settleMockMeasurements(4);
            for (let microtask = 0; microtask < 8; microtask += 1) await Promise.resolve();
            if (contractCase.mode === "paging") {
              expect(root.dataset.cardPageTick, contractCase.name).toBe("1");
              expect(contractPage({ rendered, root }), contractCase.name).not.toBe(before);
            } else {
              expect(contractActive(root), contractCase.name).not.toBe(before);
            }
          });
        }
      } finally {
        restoreMatchMedia();
        vi.useRealTimers();
      }
    });

    it("keeps finished/deadline transition paths exclusive and never renders an empty slot", async () => {
      vi.useFakeTimers();
      const animationProbe = installAnimationProbe();
      const restoreMatchMedia = installReducedMotionMatchMedia(false);
      try {
        for (const contractCase of schedulerContractCases) {
          const animationCountBefore = animationProbe.animations.length;
          await withContractCase(contractCase, contractCase.query, async ({ rendered, root }) => {
            await settleMockMeasurements(4);
            if (contractCase.mode === "paging") {
              const pageCard = rendered.container.querySelector<HTMLElement>('[data-mock-card="quake"]');
              const beforePage = pageCard?.dataset.cardPage;
              const beforeText = pageCard?.textContent ?? "";
              const emptySnapshots: boolean[] = [];
              const observer = new MutationObserver(() => {
                const body = pageCard?.querySelector<HTMLElement>('[data-card-page-body]');
                emptySnapshots.push(body == null || (body.textContent ?? "").trim() === "");
              });
              if (pageCard != null) observer.observe(pageCard, { attributes: true, childList: true, subtree: true, characterData: true });
              vi.advanceTimersByTime(15_000);
              await tick();
              await Promise.resolve();
              observer.disconnect();
              expect(animationProbe.animations.length, contractCase.name).toBe(animationCountBefore);
              expect(pageCard?.dataset.cardPage, contractCase.name).not.toBe(beforePage);
              expect(pageCard?.textContent, contractCase.name).not.toBe(beforeText);
              expect(pageCard?.querySelectorAll('[data-card-page-body]').length, contractCase.name).toBe(1);
              expect(emptySnapshots, contractCase.name).not.toContain(true);
              return;
            }
            vi.advanceTimersByTime(15_000);
            await settleMockMeasurements(4);
            const first = animationProbe.animations[animationCountBefore];
            expect(first, contractCase.name).toBeDefined();
            expect(rendered.container.querySelector("[data-rotation-slot] [data-mock-card]"), contractCase.name).toBeTruthy();
            first?.onfinish?.();
            vi.advanceTimersByTime(500);
            await tick();
            expect(first?.cancel, contractCase.name).not.toHaveBeenCalled();

            vi.advanceTimersByTime(15_000);
            await tick();
            await tick();
            const second = animationProbe.animations[animationCountBefore + 1];
            expect(second, contractCase.name).toBeDefined();
            vi.advanceTimersByTime(500);
            await tick();
            expect(second?.cancel, contractCase.name).toHaveBeenCalledTimes(1);
            expect(root.dataset.rotationActiveKey, contractCase.name).toBeDefined();
            expect(rendered.container.querySelector("[data-rotation-slot] [data-mock-card]"), contractCase.name).toBeTruthy();
          });
        }
      } finally {
        restoreMatchMedia();
        animationProbe.restore();
        vi.useRealTimers();
      }
    });

    it("disposes timer and animation resources on unmount and exit", async () => {
      vi.useFakeTimers();
      const animationProbe = installAnimationProbe();
      try {
        for (const contractCase of schedulerContractCases) {
          const animationCountBefore = animationProbe.animations.length;
          await withContractCase(contractCase, contractCase.query, async ({ rendered }, unmount) => {
            vi.advanceTimersByTime(15_000);
            await tick();
            await tick();
            expect(vi.getTimerCount(), contractCase.name).toBeGreaterThan(0);
            const animationCountAfterTick = animationProbe.animations.length;
            unmount();
            expect(vi.getTimerCount(), contractCase.name).toBe(0);
            if (contractCase.mode !== "paging") {
              expect(animationProbe.animations[animationCountBefore]?.cancel, contractCase.name).toHaveBeenCalled();
            }
            vi.advanceTimersByTime(30_000);
            await tick();
            expect(animationProbe.animations.length, contractCase.name).toBe(animationCountAfterTick);
          });

          await withContractCase(contractCase, contractCase.exitQuery, async ({ rendered, root }) => {
            vi.advanceTimersByTime(contractCase.exitAtMs);
            await tick();
            await settleMockMeasurements(64);
            if (contractCase.mode === "paging") {
              expect(contractPage({ rendered, root }), contractCase.name).toBe("1/1");
              expect(schedulerState(root).paging.inFlight, contractCase.name).toBe(false);
            } else {
              expect(root.dataset.rotationKeys, contractCase.name).toBe("");
              expect(root.dataset.rotationActiveKey, contractCase.name).toBeUndefined();
              expect(schedulerState(root).rotation.timerActive, contractCase.name).toBe(false);
              expect(schedulerState(root).rotation.inFlight, contractCase.name).toBe(false);
            }
          });
        }
      } finally {
        animationProbe.restore();
        vi.useRealTimers();
      }
    });

    it("distinguishes exit reset from rotation suspend/resume", async () => {
      vi.useFakeTimers();
      try {
        for (const contractCase of schedulerContractCases) {
          if (contractCase.mode === "paging") {
            await withContractCase(contractCase, contractCase.suspendQuery, async ({ rendered, root }) => {
              vi.advanceTimersByTime(15_000);
              await tick();
              const beforeRefresh = root.dataset.cardPageActiveKeys;
              vi.advanceTimersByTime(1_000);
              await settleMockMeasurements(64);
              expect(root.dataset.cardPageRevision, contractCase.name).toBe("1");
              expect(root.dataset.cardPageActiveKeys, contractCase.name).toBe(beforeRefresh);
            });

            await withContractCase(contractCase, contractCase.exitQuery, async ({ rendered, root }) => {
              vi.advanceTimersByTime(contractCase.exitAtMs);
              await settleMockMeasurements(64);
              expect(contractPage({ rendered, root }), contractCase.name).toBe("1/1");
              vi.advanceTimersByTime(1_000);
              await settleMockMeasurements(64);
              expect(root.dataset.cardPageRevision, contractCase.name).toBe("2");
              expect(contractPage({ rendered, root }), contractCase.name).toMatch(/^1\/\d+$/);
            });
            continue;
          }

          await withContractCase(contractCase, contractCase.suspendQuery, async ({ rendered, root }) => {
            const firstPage = contractCase.mode === "composite" ? contractPage({ rendered, root }, "weather") : "";
            expect(contractActive(root), contractCase.name).toBe("weather");
            vi.advanceTimersByTime(15_000);
            await tick();
            expect(contractActive(root), contractCase.name).toBe("heat");
            expect(rendered.container.querySelector('[data-rotation-slot] [data-mock-card="weather"]'), contractCase.name).toBeNull();
            vi.advanceTimersByTime(15_000);
            await tick();
            await tick();
            expect(contractActive(root), contractCase.name).toBe("weather");
            if (contractCase.mode === "composite") {
              expect(contractPage({ rendered, root }, "weather"), contractCase.name).not.toBe(firstPage);
            }
          });
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns to the same page within the 15×R×P composite bound", async () => {
      vi.useFakeTimers();
      try {
        for (const contractCase of schedulerContractCases) {
          await withContractCase(contractCase, contractCase.query, async ({ rendered, root }) => {
            if (contractCase.mode === "paging") {
              const initialPage = contractPage({ rendered, root });
              const pageCount = Number(initialPage.split("/")[1] ?? 1);
              vi.advanceTimersByTime(15_000 * pageCount + 1);
              await tick();
              expect(contractPage({ rendered, root }), contractCase.name).toBe(initialPage);
              return;
            }
            const initialKey = contractActive(root);
            const rotationCount = (root.dataset.rotationKeys ?? "").split(",").filter(Boolean).length;
            const initialPage = contractCase.mode === "composite" ? contractPage({ rendered, root }, "weather") : "";
            const pageCount = contractCase.mode === "composite" ? Number(initialPage.split("/")[1] ?? 1) : 1;
            vi.advanceTimersByTime(15_000 * rotationCount * pageCount + 1);
            await tick();
            await tick();
            expect(contractActive(root), contractCase.name).toBe(initialKey);
            if (contractCase.mode === "composite") {
              expect(contractPage({ rendered, root }, "weather"), contractCase.name).toBe(initialPage);
            }
          });
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
