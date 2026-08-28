import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import BriefingCard from "../BriefingCard.svelte";
import StandbyScreen from "../StandbyScreen.svelte";
import { initialState, reduce } from "../../lib/store";
import type { ActiveStandbyCardV1, DisplayBriefingFactV1, DisplayEventDtoV1, DisplayStateSnapshotV1 } from "../../lib/protocol";
import { createCardPageCoordinator } from "../../lib/legacy-standby/time-slice-scheduler.svelte";
import { parseWeatherBriefing } from "../../../../../src/dmdata/briefing-parser";
import { StandbyStateStore } from "../../../../../src/engine/display/standby-state-store";
import { fromBriefingOutcome } from "../../../../../src/engine/presentation/events/from-briefing";
import { processBriefing } from "../../../../../src/engine/presentation/processors/process-briefing";
import { processLegacyCounterpart } from "../../../../../src/engine/presentation/processors/process-legacy-counterpart";
import { fromLegacyCounterpartOutcome } from "../../../../../src/engine/presentation/events/from-legacy-counterpart";
import { briefingPagingStandbyItems, briefingSinglePageStandbyItems } from "../../preview/fixtures";
import {
  createMockWsDataMessage,
  FIXTURE_VPBS50_HJPNA202608270258,
  FIXTURE_VPBS50_HJPNB202608270308,
  FIXTURE_VPBS50_YJPNA202608270448,
  FIXTURE_VPBS50_YJPNB202608270448,
} from "../../../../../test/helpers/mock-message";

function briefing(entries = 1): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  return {
    kind: "briefing", surface: "corner-right", key: "briefing:active", sourceEventIds: ["card:vpbs:1"],
    updatedAt: "2026-08-25T12:00:00+09:00", expiresAt: "2026-08-25T14:00:00+09:00", restored: false, severity: "warning",
    data: {
      generation: 3,
      entries: Array.from({ length: entries }, (_, index) => ({
        key: `card:vpbs:${index + 1}`, source: "vpbs50" as const, sourceEventId: `event-${index + 1}`,
        editorialOffice: "気象庁", phenomenonKind: "linearRainObserved" as const,
        semanticKey: `card:vpbs:semantic:linearRainObserved:気象庁`, serial: "1",
        title: `防災気象情報 ${index + 1}`, headline: "大雨に警戒してください", conditions: ["発表"],
        targetAreas: [{ name: "宮崎県", code: "450000" }], reportDateTime: "2026-08-25T12:00:00+09:00",
        publishingOffice: "気象庁", infoType: "発表", frameLevel: index === 0 ? "critical" as const : "warning" as const,
        severityEvidence: [], qualifier: null, updatedAt: "2026-08-25T12:00:00+09:00", expiresAt: "2026-08-25T14:00:00+09:00", generation: index + 1,
      })),
    },
  };
}

function recordRainItem(fact: DisplayBriefingFactV1): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  const item = briefing();
  const entry = item.data.entries[0]!;
  entry.phenomenonKind = "recordRain";
  entry.semanticKey = "card:vpbs:semantic:recordRain:気象庁";
  entry.summary = {
    mode: "structured", hasUnknownKind: false,
    items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [fact] }],
  };
  return item;
}

function snapshotWithBriefing(item: Extract<ActiveStandbyCardV1, { kind: "briefing" }> | null): DisplayStateSnapshotV1 {
  return {
    version: 1, generatedAt: "2026-08-25T12:00:00+09:00", seq: 1,
    activeEews: [], tsunami: null, largeQuakes: [], weatherAlerts: [], recentQuakes: [], latestQuake: null,
    stats: null, severityTier: "calm", connection: { dmdata: "connected", lastReceivedAt: null, disconnectedSince: null, reason: null },
    recentTicker: [], standbyItems: item == null ? [] : [item],
  };
}

function reconcileEvent(): DisplayEventDtoV1 {
  return {
    version: 1, seq: 2, id: "briefing-canonical", eventKey: "briefing:canonical", groupKey: null, domain: "weather", type: "VPBS50",
    infoType: "発表", reportDateTime: "2026-08-25T12:00:00+09:00", title: "t", headline: null,
    publishingOffice: "気象庁", isTest: false, frameLevel: "info", isCancellation: false,
    summary: { text: "t", role: "info" }, emergency: null, recentQuake: null, latestQuake: null, tickerDetail: null,
  };
}

function briefingFromFrontendFrame(
  frame: "snapshot" | "reconcile",
  item: Extract<ActiveStandbyCardV1, { kind: "briefing" }>,
): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  const state = frame === "snapshot"
    ? reduce(initialState(), { type: "snapshot", snapshot: snapshotWithBriefing(item) })
    : reduce(
        reduce(initialState(), { type: "snapshot", snapshot: snapshotWithBriefing(null) }),
        { type: "reconcile", event: reconcileEvent(), sourceEventKeys: ["briefing:source"], card: item } as unknown as Parameters<typeof reduce>[1],
      );
  const briefingItem = state.snapshot?.standbyItems?.find((candidate) => candidate.kind === "briefing");
  if (briefingItem == null || briefingItem.kind !== "briefing") throw new Error("briefing card was not reduced");
  return briefingItem;
}

function corpusBriefing(fixture: string): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  const message = createMockWsDataMessage(fixture);
  const parsed = parseWeatherBriefing(message);
  const outcome = processBriefing(message);
  if (parsed == null || outcome == null) throw new Error(`briefing corpus did not parse: ${fixture}`);
  const store = new StandbyStateStore();
  store.applyEvent(fromBriefingOutcome(outcome), Date.parse(parsed.reportDateTime) + 1);
  const item = store.snapshotBriefingCard();
  if (item == null) throw new Error(`briefing corpus did not reach wire: ${fixture}`);
  return item;
}

function legacyCorpusBriefing(fixture: string): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  const outcome = processLegacyCounterpart(createMockWsDataMessage(fixture));
  if (outcome == null) throw new Error(`legacy briefing corpus did not parse: ${fixture}`);
  const store = new StandbyStateStore();
  store.applyEvent(fromLegacyCounterpartOutcome(outcome), Date.parse(outcome.parsed.reportDateTime) + 1);
  const item = store.snapshotBriefingCard();
  if (item == null) throw new Error(`legacy briefing corpus did not reach wire: ${fixture}`);
  return item;
}

describe("BriefingCard", () => {
  it("engine frame level をそのまま描画し、raw XML ではなく card payload だけを表示する", () => {
    const { container } = render(BriefingCard, { item: briefing(), shellHeightPx: 260 });
    const entry = container.querySelector<HTMLElement>("[data-briefing-entry]");
    const header = container.querySelector<HTMLElement>("[data-briefing-card-header]");

    expect(entry?.dataset.frameLevel).toBe("critical");
    expect(header?.classList.contains("critical")).toBe(true);
    expect(header?.querySelector(".updated-stamp")?.textContent).toContain("更新");
    expect(entry?.textContent).toContain("防災気象情報 1");
    expect(entry?.textContent).toContain("対象: 宮崎県");
    expect(container.querySelector<HTMLElement>("[data-briefing-card]")?.style.height).toBe("260px");
    expect(container.querySelector("[data-briefing-card]")?.hasAttribute("data-briefing-partition-debug")).toBe(false);
  });

  it("entry block identity ごとに pager へ登録し、同じ page shell で描画する", () => {
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item: briefing(2), pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 260,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 6 ? 2 : 0,
    });

    expect(coordinator.cardDiagnostics("briefing")).toMatchObject({ page: "1/2", identities: ["card:vpbs:1:title:raw-title:0", "card:vpbs:2:headline:raw-headline:0"] });
    expect(container.querySelectorAll("[data-briefing-entry]")).toHaveLength(2);
    expect(container.querySelector("[data-card-page-footer]")).toBeTruthy();
    coordinator.dispose();
  });

  it("実測 candidate 高では shell に収まる最大 range を採用する", () => {
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item: briefing(2), pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 260,
      partitionProbe: (_key, _placement, range) => (range.end - range.start) * 50,
    });

    expect(coordinator.cardDiagnostics("briefing")).toMatchObject({ page: "1/2" });
    expect(container.querySelector<HTMLElement>("[data-briefing-card]")?.dataset.briefingPageRange).toBe("0:5");
    coordinator.dispose();
  });

  it("後続 atom の不適合で先行の最大 fit range を捨てず、残りだけを保全 page にする", () => {
    const item = briefingPagingStandbyItems[0];
    if (item == null || item.kind !== "briefing") throw new Error("briefing-pages fixture is missing");
    const coordinator = createCardPageCoordinator();
    const calls: string[] = [];
    const { container } = render(BriefingCard, {
      item, pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 253.88,
      partitionProbe: (_key, _placement, range) => {
        calls.push(`${range.start}:${range.end}`);
        return range.start === 0 && range.end <= 4 ? 0 : 2;
      },
    });

    expect(container.querySelector<HTMLElement>("[data-briefing-card]")?.dataset.briefingPageRange).toBe("0:4");
    expect(coordinator.cardDiagnostics("briefing").page).not.toBe("1/10");
    expect(calls).toContain("5:6");
    coordinator.dispose();
  });

  it("probe と live は同じ page atom を使い、entry 境界の chrome と必要な footer だけを描画する", () => {
    const full = render(BriefingCard, {
      item: briefing(), measurementRange: { start: 0, end: 5, tails: [], omittedAreaCount: 0 }, shellHeightPx: 260,
    });
    expect(full.container.querySelector("[data-page-probe-card] [data-briefing-page-atom]")).toBeTruthy();
    expect(full.container.querySelectorAll("[data-briefing-page-atom-entry]")).toHaveLength(1);
    expect(full.container.querySelector("[data-card-page-footer]")).toBeNull();

    const splitAcrossEntries = render(BriefingCard, {
      item: briefing(2), measurementRange: { start: 0, end: 6, tails: [], omittedAreaCount: 0 }, shellHeightPx: 260,
    });
    expect(splitAcrossEntries.container.querySelectorAll("[data-briefing-page-atom-entry]")).toHaveLength(2);
    expect(splitAcrossEntries.container.querySelectorAll("[data-briefing-entry-label]")).toHaveLength(2);
    expect(splitAcrossEntries.container.querySelector("[data-card-page-footer]")).toBeTruthy();
  });

  it("briefing-pages fixture の range 0:5 は一つ目の entry atom だけを描画する", () => {
    const item = briefingPagingStandbyItems[0];
    if (item == null || item.kind !== "briefing") throw new Error("briefing-pages fixture is missing");
    const { container } = render(BriefingCard, {
      item, measurementRange: { start: 0, end: 5, tails: [], omittedAreaCount: 0 }, shellHeightPx: 253.88,
    });
    expect([...container.querySelectorAll<HTMLElement>("[data-briefing-page-atom-entry]")]
      .map((entry) => entry.dataset.frameLevel)).toEqual(["critical"]);
    expect(container.querySelectorAll("[data-page-probe-readable]")).toHaveLength(1);
  });

  it("briefing-pages fixture の atom 4 は一つ目 entry の atomic fact だけである", () => {
    const item = briefingPagingStandbyItems[0];
    if (item == null || item.kind !== "briefing") throw new Error("briefing-pages fixture is missing");
    const { container } = render(BriefingCard, {
      item, measurementRange: { start: 4, end: 5, tails: [], omittedAreaCount: 0 }, shellHeightPx: 253.88,
    });
    expect(container.querySelector<HTMLElement>("[data-briefing-entry]")?.dataset.frameLevel).toBe("critical");
    expect([...container.querySelectorAll<HTMLElement>("[data-briefing-block]")].map((block) => block.dataset.briefingBlock))
      .toEqual(["card:vpbs:preview:fact:fact:0:precipitation:16202:0:0"]);
    expect(container.querySelector("[data-briefing-vpoa-headline]")).toBeNull();
  });

  it("briefing-single-page fixture は live pager 経路で footer なしの 1/1 を保つ", () => {
    const item = briefingSinglePageStandbyItems[0];
    if (item == null || item.kind !== "briefing") throw new Error("briefing-single-page fixture is missing");
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item, pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 253.88,
      partitionProbe: () => 0,
    });
    expect(coordinator.cardDiagnostics("briefing")).toMatchObject({ page: "1/1" });
    expect(container.querySelector("[data-card-page-footer]")).toBeNull();
    expect(container.querySelector("[data-briefing-prefecture-context], [data-briefing-target-regions]")).toBeNull();
    expect(container.querySelector("[data-briefing-precipitation-stat]")).toBeTruthy();
    expect(container.querySelectorAll("[data-briefing-block]")).toHaveLength(3);
    coordinator.dispose();
  });

  it("settled 1/1 の shelf probe は候補途中 range でも footer を描かない", () => {
    const item = briefingSinglePageStandbyItems[0];
    if (item == null || item.kind !== "briefing") throw new Error("briefing-single-page fixture is missing");
    const { container } = render(BriefingCard, {
      item, measurementRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 },
      measurementPageFooter: false, shellHeightPx: 253.88,
    });
    expect(container.querySelector("[data-card-page-footer]")).toBeNull();
  });

  it("live pager は range 0:6 から 0:5 へ縮むと二つ目の entry chrome を除去する", async () => {
    const item = briefingPagingStandbyItems[0];
    if (item == null || item.kind !== "briefing") throw new Error("briefing-pages fixture is missing");
    const coordinator = createCardPageCoordinator();
    const view = render(BriefingCard, {
      item, pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 253.88,
      partitionProbe: (_key, _placement, range) => range.end - range.start <= 6 ? 0 : 2,
    });
    expect([...view.container.querySelectorAll<HTMLElement>("[data-briefing-page-atom-entry]")]
      .map((entry) => entry.dataset.frameLevel)).toEqual(["critical", "warning"]);

    await view.rerender({
      item, pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 253.88,
      partitionProbe: (_key, _placement, range) => range.end - range.start <= 5 ? 0 : 2,
    });
    await tick();
    expect(view.container.querySelector<HTMLElement>("[data-briefing-card]")?.dataset.briefingPageRange).toBe("0:5");
    expect([...view.container.querySelectorAll<HTMLElement>("[data-briefing-page-atom-entry]")]
      .map((entry) => entry.dataset.frameLevel)).toEqual(["critical"]);
    coordinator.dispose();
  });

  it("off-layout probe は live surface と同じ明示幅を受け取る", () => {
    const { container } = render(BriefingCard, {
      item: briefing(), measurementRange: { start: 0, end: 5, tails: [], omittedAreaCount: 0 },
      measurementWidthPx: 384, shellHeightPx: 260,
    });
    const card = container.querySelector<HTMLElement>("[data-page-probe-card]");
    expect(card?.style.width).toBe("384px");
    expect(card?.style.height).toBe("");
    expect(card?.dataset.briefingProbeWidthPx).toBe("384");
  });

  it("全 atom が fit した live card も coordinator に 1/1 として登録する", () => {
    const coordinator = createCardPageCoordinator();
    render(BriefingCard, {
      item: briefing(2), pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 260,
      partitionProbe: () => 0,
    });
    expect(coordinator.cardDiagnostics("briefing")).toMatchObject({ page: "1/1" });
    coordinator.dispose();
  });

  it("probe footer は live pager と同じ coordinator 文言を描画する", async () => {
    const coordinator = createCardPageCoordinator();
    coordinator.register({
      key: "briefing", identities: ["first", "second"], labels: ["first", "second"],
      rotationMember: false, resetKey: "two-pages",
    });
    const { container } = render(BriefingCard, {
      item: briefing(), pageCoordinator: coordinator,
      measurementRange: { start: 0, end: 4, tails: [], omittedAreaCount: 0 }, shellHeightPx: 260,
    });
    expect(container.querySelector("[data-card-page-indicator]")?.textContent).toBe("1/2");
    coordinator.jumpTo("briefing", 1);
    await tick();
    expect(container.querySelector("[data-card-page-indicator]")?.textContent).toBe("2/2");
    coordinator.dispose();
  });

  it("mount 後の Standby measurement epoch で最初の page probe を開始する", async () => {
    const calls: string[] = [];
    const probe = (_key: string, _placement: "side" | "center", range: { start: number; end: number }) => {
      calls.push(`${range.start}:${range.end}`);
      return null;
    };
    const view = render(BriefingCard, {
      item: briefing(2), partitionProbe: probe, partitionEpoch: "0", shellHeightPx: 260,
    });

    expect(calls).toEqual(["0:1"]);
    await view.rerender({ item: briefing(2), partitionProbe: probe, partitionEpoch: "1", shellHeightPx: 260 });
    expect(calls).toEqual(["0:1", "0:1"]);
  });

  it("StandbyScreen の live card が probe 解決後の page range と coordinator 属性を描画する", async () => {
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const descriptors = Object.fromEntries(["clientHeight", "scrollHeight", "clientWidth", "scrollWidth"].map((name) => [
      name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
    ]));
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const probeHeight = (node: HTMLElement): number => {
      const card = node.matches("[data-page-probe-card]") ? node : node.closest<HTMLElement>("[data-page-probe-card]");
      const [start = 0, end = 0] = (card?.dataset.briefingPageRange ?? "0:0").split(":").map(Number);
      const count = end - start;
      // Reproduce the browser-only handoff: the initial candidate signature
      // is rejected, then the pager's settled footer signature must schedule
      // and consume a new probe epoch rather than retaining 1 atom/page.
      if (card?.closest<HTMLElement>("[data-page-probe-composition]")?.dataset.pageProbeComposition?.startsWith("briefing-footer:candidate")) return 254;
      return count <= 5 ? 230 : count === 6 ? 254 : 340;
    };
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 577 });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const originalGetComputedStyle = getComputedStyle;
    vi.stubGlobal("getComputedStyle", (node: Element): CSSStyleDeclaration => {
      const style = originalGetComputedStyle(node);
      if (!(node instanceof HTMLElement) || !node.matches("[data-page-probe-card]")) return style;
      return new Proxy(style, {
        get(target, property) {
          if (property === "boxSizing") return "border-box";
          if (property === "borderTopWidth" || property === "borderBottomWidth") return "1px";
          return Reflect.get(target, property, target);
        },
      }) as CSSStyleDeclaration;
    });
    Object.defineProperties(HTMLElement.prototype, {
      clientHeight: { configurable: true, get(this: HTMLElement): number {
        return this.matches("[data-page-probe-card]") ? probeHeight(this) : this.matches("[data-page-probe-readable]") ? 100 : 0;
      } },
      scrollHeight: { configurable: true, get(this: HTMLElement): number {
        if (this.matches("[data-page-probe-card]")) return probeHeight(this);
        if (this.matches("[data-page-probe-readable]")) return 100;
        if (this.matches("[data-briefing-card]") && this.closest(".legacy-layout") != null) {
          const [start = 0, end = 0] = (this.dataset.briefingPageRange ?? "0:0").split(":").map(Number);
          return end - start <= 5 ? 230 : 254;
        }
        return 0;
      } },
      clientWidth: { configurable: true, get(this: HTMLElement): number {
        return this.matches("[data-page-probe-card], [data-page-probe-readable]") ? 307 : 0;
      } },
      scrollWidth: { configurable: true, get(this: HTMLElement): number {
        return this.matches("[data-page-probe-card], [data-page-probe-readable]") ? 307 : 0;
      } },
    });
    try {
      const item = briefingPagingStandbyItems[0];
      if (item == null || item.kind !== "briefing") throw new Error("briefing-pages fixture is missing");
      const { container } = render(StandbyScreen, {
        snapshot: snapshotWithBriefing(item), now: new Date("2026-08-25T12:00:00+09:00"),
        dim: false, sseConnected: true, partitionDebug: true,
        testMeasurementOverride: {
          layoutWidthPx: 1280, layoutHeightPx: 1_000,
          leftTrackWidthPx: 307, centerTrackWidthPx: 576, rightTrackWidthPx: 307,
          sideMeasureShelfWidthPx: 307, centerMeasureShelfWidthPx: 576,
        },
      });
      const live = () => container.querySelector<HTMLElement>(".legacy-layout [data-briefing-card]");
      expect(live()?.dataset.cardPage).toBe("0/0");
      expect(live()?.dataset.cardPagePending).toBe("true");

      for (let pass = 0; pass < 80; pass += 1) await tick();

      expect(live()?.dataset.cardPage).toBe("1/3");
      expect(live()?.dataset.cardPagePending).toBe("false");
      expect(JSON.parse(live()?.dataset.cardPageIdentities ?? "[]")).toHaveLength(3);
      expect(live()?.dataset.briefingPageRange).toBe("0:5");
      expect(live()?.dataset.briefingShellHeightPx).toBe("253.88");
      expect(live()?.querySelectorAll("[data-briefing-block]")).toHaveLength(5);
      const partitionDebug = JSON.parse(live()?.dataset.briefingPartitionDebug ?? "{}") as {
        chromeSignature?: string;
        pendingProbeCount?: number;
        cache?: Array<{ id: string; fit: number }>;
        probeReads?: Array<{ range: string; measured: number | null; basis: string }>;
      };
      expect(partitionDebug.chromeSignature).toMatch(/^briefing-footer:present:epoch:/);
      expect(partitionDebug.chromeSignature).toContain(":width:307");
      expect(partitionDebug.pendingProbeCount).toBe(0);
      expect(partitionDebug.cache?.some((entry) => entry.id.includes("placement:side") && entry.fit === 0)).toBe(true);
      expect(partitionDebug.probeReads?.some((read) => read.range === "0:5" && read.measured === 0 && read.basis === "0")).toBe(true);
      const rejectedBoundary = Array.from(container.querySelectorAll<HTMLElement>("[data-prefix-measure]"))
        .find((probe) => probe.dataset.prefixMeasure?.startsWith("briefing:page-fit:0:6")
          && probe.dataset.pageProbeComposition?.startsWith("briefing-footer:present"));
      expect(rejectedBoundary?.dataset.pageProbeFit).toBe("false");
      expect(rejectedBoundary?.querySelector("[data-card-page-footer]")).toBeTruthy();
      expect(container.querySelector("[data-page-probe-composition^='briefing-footer:candidate']")).toBeNull();
      expect(container.querySelector<HTMLElement>("[data-page-probe-composition^='briefing-footer:present']")?.dataset.pageProbeFit).toBe("true");
    } finally {
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (descriptor == null) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
        else Object.defineProperty(HTMLElement.prototype, name, descriptor);
      }
      if (innerHeight == null) delete (window as unknown as Record<string, unknown>).innerHeight;
      else Object.defineProperty(window, "innerHeight", innerHeight);
      vi.unstubAllGlobals();
    }
  });

  it("単一の長文 entry を安定した行 block に分け、infeasible で丸ごと消さない", async () => {
    const item = briefing();
    item.data.entries[0]!.headline = "長文".repeat(160);
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item, pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 260,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
    });

    expect(coordinator.cardDiagnostics("briefing").page).not.toBe("0/0");
    expect(container.querySelectorAll("[data-briefing-block]").length).toBeGreaterThan(0);
    coordinator.jumpTo("briefing", 1);
    await tick();
    expect(container.querySelector("[data-briefing-card]")?.textContent).toContain("長文");
    coordinator.dispose();
  });

  it("単一 block 自体が不適合でも保全ページへ縮退し、empty range にしない", () => {
    const coordinator = createCardPageCoordinator();
    const { container } = render(BriefingCard, {
      item: briefing(), pageCoordinator: coordinator, pageScheduling: true, shellHeightPx: 1,
      partitionProbe: () => 2,
    });

    expect(coordinator.cardDiagnostics("briefing").page).not.toBe("0/0");
    expect(container.querySelector("[data-briefing-entry]")).toBeTruthy();
    expect(container.querySelectorAll("[data-briefing-block]").length).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it.each(["snapshot", "reconcile"] as const)("%s frame の不正 summary shape は raw headline fallback にする", (frame) => {
    const item = briefing();
    item.data.entries[0]!.title = "raw title";
    item.data.entries[0]!.headline = "raw headline";
    (item.data.entries[0] as unknown as { summary: unknown }).summary = {
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "linearRainObserved", lead: "発生", sourceOrdinal: 0, facts: [{ kind: "event", label: "発生", areaName: null, at: null }] }],
    };
    const { container } = render(BriefingCard, { item: briefingFromFrontendFrame(frame, item), shellHeightPx: 260 });
    expect(container.textContent).toContain("raw title");
    expect(container.textContent).toContain("raw headline");
  });

  it.each([
    ["critical", "critical"], ["warning", "warning"], ["info", "advisory"], ["cancel", "advisory"],
  ] as const)("%s frame を card header の severity token として描画する", (frameLevel, className) => {
    const item = briefing();
    item.data.entries[0]!.frameLevel = frameLevel;
    item.data.entries[0]!.source = frameLevel === "info" ? "vpoa50" : "vpbs50";
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.querySelector("[data-briefing-card-header]")?.classList.contains(className)).toBe(true);
    expect(container.textContent).toContain(frameLevel === "info" ? "記録的短時間大雨情報" : "気象速報");
  });

  it("複数 entry は最上位 severity の card header と本文区切りへ集約し、更新時刻を一度だけ表示する", () => {
    const item = briefing(2);
    item.data.entries[0]!.frameLevel = "warning";
    item.data.entries[0]!.updatedAt = "2026-08-25T12:00:00+09:00";
    item.data.entries[1]!.frameLevel = "critical";
    item.data.entries[1]!.updatedAt = "2026-08-25T13:30:00+09:00";
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const header = container.querySelector<HTMLElement>("[data-briefing-card-header]");
    const entries = container.querySelectorAll<HTMLElement>("[data-briefing-entry]");

    expect(header?.classList.contains("critical")).toBe(true);
    expect(header?.getAttribute("style")).toContain("var(--header-weatherEmergency-container)");
    expect(header?.querySelector(".updated-stamp")?.textContent).toContain("13:30");
    expect(container.querySelectorAll("[data-briefing-card-header]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-briefing-entry-label]")).toHaveLength(2);
    expect(entries[1]?.classList.contains("entry-divider")).toBe(true);
  });

  it("現象 lead・取消・VPOA50 の本文と未確認 qualifier を維持し、VPOA50 に stat grid を作らない", () => {
    const item = briefing(2);
    const observation = item.data.entries[0]!;
    observation.source = "vpoa50";
    observation.qualifier = "未確認";
    observation.headline = "１７時５０分に北塩原村付近で１時間に約１００ミリの雨を解析しました。";
    observation.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }] };
    const cancelled = item.data.entries[1]!;
    cancelled.summary = { mode: "cancellation", hasUnknownKind: false, items: [] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("記録的短時間大雨");
    expect(container.textContent).toContain("北塩原村付近");
    expect(container.querySelectorAll("[data-briefing-precipitation-stat]")).toHaveLength(0);
    expect(container.textContent).toContain("未確認");
    expect(container.textContent).toContain("気象防災速報を取消");
  });

  it.each([
    null,
    "old-wire",
    { mode: "unknown", items: [], hasUnknownKind: false },
    { mode: "structured", items: [], hasUnknownKind: false },
    { mode: "structured", items: [{ kind: "recordRain", lead: "雨", sourceOrdinal: 0, facts: [{}] }], hasUnknownKind: false },
    { mode: "structured", items: [{ kind: "recordRain", lead: "雨", sourceOrdinal: 0, facts: [
      { kind: "precipitation", locationName: "地点", locationCode: "1", description: "約１００ミリ", unit: "mm", at: null },
    ] }], hasUnknownKind: false },
    { mode: "structured", items: [{ kind: "recordRain", lead: "雨", sourceOrdinal: 0, facts: [
      { kind: "precipitation", locationName: "地点", locationCode: "1", description: "100ミリ", value: 100, unit: "mm", at: null, duration: 1 },
    ] }], hasUnknownKind: false },
    { mode: "structured", items: [{ kind: "recordRain", lead: "雨", sourceOrdinal: 0, facts: [
      { kind: "precipitation", locationName: "地点", locationCode: "1", description: "100ミリ", value: 100, unit: "mm", at: null, approximation: "roughly" },
    ] }], hasUnknownKind: false },
    { mode: "structured", items: [{ kind: "recordRain", lead: "雨", sourceOrdinal: 0, facts: [
      { kind: "precipitation", locationName: "地点", locationCode: "1", description: " ", value: 100, unit: "mm", at: null, duration: "1時間", approximation: "exact" },
    ] }], hasUnknownKind: false },
  ])("summary の不正 shape は raw headline fallback にする: %o", (summary) => {
    const item = briefing();
    item.data.entries[0]!.title = "raw title";
    item.data.entries[0]!.headline = "raw headline";
    (item.data.entries[0] as unknown as { summary: unknown }).summary = summary;
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("raw title");
    expect(container.textContent).toContain("raw headline");
  });

  it("長い lead と fact は分割せず、一つの pager semantic block として保つ", () => {
    const item = briefing();
    const lead = "３時間以内に線状降水帯発生のおそれ";
    const fact = "非常に長い地点名 約１００ミリ / 04:40";
    item.data.entries[0]!.summary = {
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "linearRainPredicted", lead, sourceOrdinal: 0, facts: [
        { kind: "precipitation", locationName: "非常に長い地点名", locationCode: "1", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-25T04:40:00+09:00" },
      ] }],
    };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const leadBlocks = [...container.querySelectorAll<HTMLElement>("[data-briefing-block]")].filter((block) => block.textContent === lead);
    const factBlocks = [...container.querySelectorAll<HTMLElement>("[data-briefing-block]")].filter((block) => block.textContent === fact);
    expect(leadBlocks).toHaveLength(1);
    expect(factBlocks).toHaveLength(1);
  });

  it("structured summary は lead・先頭3地域・fact を表示し raw title/headline を主面から外す", () => {
    const item = briefing();
    item.data.entries[0]!.title = "長い raw title";
    item.data.entries[0]!.headline = "長い raw headline";
    item.data.entries[0]!.targetAreas = [
      { name: "一", code: "1" }, { name: "二", code: "2" }, { name: "三", code: "3" }, { name: "四", code: "4" },
    ];
    item.data.entries[0]!.summary = {
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [
        { kind: "precipitation", locationName: "美幌町", locationCode: "001", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-25T13:10:00+09:00" },
      ] }],
    };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("記録的短時間大雨");
    expect(container.textContent).toContain("ほか1地域");
    expect(container.querySelector("[data-briefing-precipitation-stat]")?.textContent).toContain("美幌町");
    expect(container.textContent).not.toContain("長い raw title");
    expect(container.textContent).not.toContain("長い raw headline");
  });

  it("Phase 1 subject fields が欠落した旧 wire は raw headline fallback にする", () => {
    const item = briefing();
    const entry = item.data.entries[0]!;
    entry.title = "旧 wire title";
    entry.headline = "旧 wire headline";
    delete entry.editorialOffice;
    delete entry.phenomenonKind;
    delete entry.semanticKey;
    delete entry.serial;
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });

    expect(container.textContent).toContain("旧 wire title");
    expect(container.textContent).toContain("旧 wire headline");
  });

  it.each([
    [FIXTURE_VPBS50_HJPNA202608270258, "富山県"],
    [FIXTURE_VPBS50_HJPNB202608270308, "石川県"],
    [FIXTURE_VPBS50_YJPNA202608270448, "富山県"],
    [FIXTURE_VPBS50_YJPNB202608270448, "石川県"],
  ] as const)("corpus %s は実 XML→parser→wire 経由で県文脈を一度だけ、対象地域 DOM には名称だけを描画する", (fixture, prefecture) => {
    const item = corpusBriefing(fixture);
    const entry = item.data.entries[0]!;
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const renderedEntry = container.querySelector<HTMLElement>("[data-briefing-entry]");
    const contexts = renderedEntry?.querySelectorAll<HTMLElement>("[data-briefing-prefecture-context]") ?? [];
    const target = renderedEntry?.querySelector<HTMLElement>("[data-briefing-target-regions]");

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.textContent).toBe(prefecture);
    expect(contexts[0]?.classList.contains("pref-group")).toBe(true);
    expect(contexts[0]?.querySelector(".pref-name")?.textContent).toBe(prefecture);
    expect(target?.classList.contains("pref-group")).toBe(true);
    expect([...target?.querySelectorAll<HTMLElement>(".cities .city-name") ?? []].map((city) => city.textContent)).toEqual(
      entry.targetAreas.map((area, index) => `${index === 0 ? "対象: " : ""}${area.name}`),
    );
    for (const area of entry.targetAreas) expect(renderedEntry?.textContent).not.toContain(area.code);
  });

  it("Head.Title から県名を安全に抽出できない場合は対象地域名だけを描画する", () => {
    const item = briefing();
    const entry = item.data.entries[0]!;
    entry.title = "気象防災速報（対象県不明）";
    entry.targetAreas = [{ name: "西部", code: "160020" }, { name: "東部", code: "160010" }];
    entry.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "linearRainObserved", lead: "線状降水帯が発生", sourceOrdinal: 0, facts: [] }] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const renderedEntry = container.querySelector<HTMLElement>("[data-briefing-entry]");

    expect(renderedEntry?.querySelector("[data-briefing-prefecture-context]")).toBeNull();
    const target = renderedEntry?.querySelector<HTMLElement>("[data-briefing-target-regions]");
    expect(target?.classList.contains("pref-group")).toBe(true);
    expect([...target?.querySelectorAll<HTMLElement>(".cities .city-name") ?? []].map((city) => city.textContent)).toEqual(["対象: 西部", "東部"]);
    expect(renderedEntry?.textContent).not.toContain("160020");
    expect(renderedEntry?.textContent).not.toContain("160010");
  });

  it("mixed summary でも県文脈を一度だけ表示し、title の現象詳細は保持する", () => {
    const item = briefing();
    const entry = item.data.entries[0]!;
    entry.title = "富山県気象防災速報（未分類の現象）";
    entry.targetAreas = [{ name: "西部", code: "160020" }];
    entry.summary = { mode: "mixed", hasUnknownKind: true, items: [{ kind: "linearRainObserved", lead: "線状降水帯が発生", sourceOrdinal: 0, facts: [] }] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const renderedEntry = container.querySelector<HTMLElement>("[data-briefing-entry]");

    expect(renderedEntry?.textContent?.match(/富山県/g)).toHaveLength(1);
    expect(renderedEntry?.textContent).toContain("気象防災速報（未分類の現象）");
  });

  it("raw fallback と4地域以上の areaDetail でも areaCode を可視文字列に出さない", () => {
    const raw = briefing();
    raw.data.entries[0]!.targetAreas = [{ name: "西部", code: "160020" }, { name: "東部", code: "160010" }];
    const rawView = render(BriefingCard, { item: raw, shellHeightPx: 260 });
    expect([...rawView.container.querySelectorAll<HTMLElement>("[data-briefing-target-regions] .cities .city-name")].map((city) => city.textContent)).toEqual(["対象: 西部", "東部"]);
    expect(rawView.container.textContent).not.toContain("160020");
    expect(rawView.container.textContent).not.toContain("160010");

    const detailed = briefing();
    detailed.data.entries[0]!.targetAreas = [
      { name: "一", code: "01" }, { name: "二", code: "02" }, { name: "三", code: "03" }, { name: "四", code: "04" },
    ];
    detailed.data.entries[0]!.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }] };
    const detailView = render(BriefingCard, { item: detailed, shellHeightPx: 260 });
    const targets = [...detailView.container.querySelectorAll<HTMLElement>("[data-briefing-target-regions]")];
    expect(targets.map((target) => [...target.querySelectorAll<HTMLElement>(".cities .city-name")].map((city) => city.textContent))).toEqual([
      ["対象: 一", "二", "三"], ["対象: 一", "二", "三", "四"],
    ]);
    expect(targets.every((target) => target.classList.contains("pref-group") && target.querySelectorAll(".cities .city-name").length > 0)).toBe(true);
    for (const code of ["01", "02", "03", "04"]) expect(detailView.container.textContent).not.toContain(code);
  });

  it("長い4地域は WeatherAlertCard と同じ地域ごとの city-name として実レンダリングされる", () => {
    const item = briefing();
    item.data.entries[0]!.targetAreas = [
      { name: "非常に長い富山県西部の対象地域", code: "01" },
      { name: "非常に長い富山県東部の対象地域", code: "02" },
      { name: "非常に長い石川県加賀の対象地域", code: "03" },
      { name: "非常に長い石川県能登の対象地域", code: "04" },
    ];
    item.data.entries[0]!.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const targetGroups = [...container.querySelectorAll<HTMLElement>("[data-briefing-target-regions]")];
    const cities = [...targetGroups[1]?.querySelectorAll<HTMLElement>(".cities .city-name") ?? []];

    expect(targetGroups).toHaveLength(2);
    expect(cities.map((city) => city.textContent)).toEqual([
      "対象: 非常に長い富山県西部の対象地域", "非常に長い富山県東部の対象地域",
      "非常に長い石川県加賀の対象地域", "非常に長い石川県能登の対象地域",
    ]);
    expect(cities).toHaveLength(4);
  });

  it("VPBS50 美幌町 100mm 13:10 は地点ごとの atomic stat grid にする", () => {
    const item = corpusBriefing("82_01_02_250630_VPBS50.xml");
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const grids = container.querySelectorAll<HTMLElement>("[data-briefing-precipitation-stat]");
    expect(grids).toHaveLength(2);
    expect(grids[0]?.textContent).toContain("美幌町");
    expect(grids[0]?.textContent).toContain("約 100mm");
    expect(grids[0]?.textContent).toContain("13:10");
    expect(grids[0]?.textContent).toContain("1時間");
    expect(grids[1]?.textContent).toContain("美幌");
    expect(grids[1]?.textContent).toContain("93mm");
  });

  it("VPBS50 北塩原村 100mm 17:50 は DOM tile にする", () => {
    const { container } = render(BriefingCard, { item: corpusBriefing("phase6b_VPBS50_KJPDE202608201757_202608201757.xml"), shellHeightPx: 260 });
    const tile = container.querySelector<HTMLElement>("[data-briefing-precipitation-stat]");
    expect(tile?.querySelector("[data-briefing-precipitation-location]")?.textContent).toContain("北塩原村");
    expect(tile?.querySelector("[data-briefing-precipitation-amount]")?.textContent).toContain("100mm");
    expect(tile?.querySelector("[data-briefing-precipitation-time]")?.textContent).toContain("17:50");
  });

  it("VPBS50 は locationName 欠損でも残りの tile cells を描画する", () => {
    const { container } = render(BriefingCard, { item: recordRainItem({ kind: "precipitation", locationName: null, locationCode: null, description: "100ミリ", value: 100, unit: "mm", at: "2026-08-25T13:10:00+09:00", duration: "1時間", approximation: "exact" }), shellHeightPx: 260 });
    const tile = container.querySelector<HTMLElement>("[data-briefing-precipitation-stat]");
    expect(tile?.querySelector("[data-briefing-precipitation-location]")).toBeNull();
    expect(tile?.querySelector("[data-briefing-precipitation-time]")?.textContent).toContain("13:10");
  });

  it("VPBS50 は at 欠損でも残りの tile cells を描画する", () => {
    const { container } = render(BriefingCard, { item: recordRainItem({ kind: "precipitation", locationName: "地点", locationCode: null, description: "100ミリ", value: 100, unit: "mm", at: null, duration: "1時間", approximation: "exact" }), shellHeightPx: 260 });
    const tile = container.querySelector<HTMLElement>("[data-briefing-precipitation-stat]");
    expect(tile?.querySelector("[data-briefing-precipitation-time]")).toBeNull();
    expect(tile?.querySelector("[data-briefing-precipitation-duration]")?.textContent).toContain("1時間");
  });

  it("VPBS50 は duration 欠損でも残りの tile cells を描画する", () => {
    const { container } = render(BriefingCard, { item: recordRainItem({ kind: "precipitation", locationName: "地点", locationCode: null, description: "100ミリ", value: 100, unit: "mm", at: "2026-08-25T13:10:00+09:00", duration: null, approximation: "exact" }), shellHeightPx: 260 });
    const tile = container.querySelector<HTMLElement>("[data-briefing-precipitation-stat]");
    expect(tile?.querySelector("[data-briefing-precipitation-duration]")).toBeNull();
    expect(tile?.querySelector("[data-briefing-precipitation-time]")?.textContent).toContain("13:10");
  });

  it("VPBS50 は approximation unknown を無標識の tile として描画する", () => {
    const { container } = render(BriefingCard, { item: recordRainItem({ kind: "precipitation", locationName: "地点", locationCode: null, description: "100ミリ", value: 100, unit: "mm", at: "2026-08-25T13:10:00+09:00", duration: "1時間", approximation: "unknown" }), shellHeightPx: 260 });
    const amount = container.querySelector<HTMLElement>("[data-briefing-precipitation-amount]");
    expect(amount?.textContent).toContain("100mm");
    expect(amount?.textContent).not.toContain("約");
    expect(amount?.textContent).not.toContain("以上");
  });

  it("VPBS50 は value のみ null なら fact 全体を plain text に fail-open する", () => {
    const { container } = render(BriefingCard, { item: recordRainItem({ kind: "precipitation", locationName: "欠損地点", locationCode: null, description: "雨量不明", value: null, unit: "mm", at: "2026-08-25T13:10:00+09:00", duration: "1時間", approximation: "unknown" }), shellHeightPx: 260 });
    expect(container.querySelectorAll("[data-briefing-precipitation-stat]")).toHaveLength(0);
    expect(container.textContent).toContain("欠損地点 雨量不明 / 13:10");
  });

  it("VPBS50 は unit のみ null なら fact 全体を plain text に fail-open する", () => {
    const { container } = render(BriefingCard, { item: recordRainItem({ kind: "precipitation", locationName: "欠損地点", locationCode: null, description: "雨量不明", value: 100, unit: null, at: "2026-08-25T13:10:00+09:00", duration: "1時間", approximation: "unknown" }), shellHeightPx: 260 });
    expect(container.querySelectorAll("[data-briefing-precipitation-stat]")).toHaveLength(0);
    expect(container.textContent).toContain("欠損地点 雨量不明 / 13:10");
  });

  it("VPBS50 corpus の以上表記は数値 tile の後置修飾として保つ", () => {
    const { container } = render(BriefingCard, { item: corpusBriefing("phase6b_VPBS50_KJPTK202608221709_202608221717.xml"), shellHeightPx: 260 });
    const tile = container.querySelector<HTMLElement>("[data-briefing-precipitation-stat]");
    expect(tile?.textContent).toContain("120mm 以上");
  });

  it("線状降水帯 fact は地点・状態・時刻を一つの atomic 強調行に保つ", () => {
    const { container } = render(BriefingCard, { item: corpusBriefing(FIXTURE_VPBS50_HJPNA202608270258), shellHeightPx: 260 });
    const fact = container.querySelector<HTMLElement>("[data-briefing-event-fact]");
    expect(fact?.textContent).toContain("西部　発生　02:50");
    expect(fact?.querySelectorAll("strong")).toHaveLength(2);
  });

  it("VPOA50 headline は原文を保った token 強調だけを行い、stat grid を作らない", () => {
    const item = legacyCorpusBriefing("phase6b_VPOA50_JPDE202608201757_202608201757.xml");
    const entry = item.data.entries[0]!;
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const headline = [...container.querySelectorAll<HTMLElement>("[data-briefing-vpoa-headline]")].map((node) => node.textContent).join("");
    const tokens = [...container.querySelectorAll<HTMLElement>("[data-briefing-vpoa-token]")].map((node) => node.textContent);
    expect(headline).toBe(entry.headline);
    expect(container.querySelectorAll("[data-briefing-vpoa-headline]").length).toBeGreaterThan(0);
    expect(tokens).toEqual(expect.arrayContaining(["１７時５０分", "福島県北塩原村", "北塩原村付近", "１時間に約１００ミリ"]));
    expect(container.querySelectorAll("[data-briefing-precipitation-stat]")).toHaveLength(0);
  });

  it("VPOA50 KJPTK 1717 は 120mm以上を強調し、stat grid を作らない", () => {
    const item = legacyCorpusBriefing("phase6b_VPOA50_JPTK202608221709_202608221717.xml");
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    expect([...container.querySelectorAll<HTMLElement>("[data-briefing-vpoa-token]")].map((node) => node.textContent)).toEqual(expect.arrayContaining(["１時間に１２０ミリ以上"]));
    expect(container.querySelectorAll("[data-briefing-precipitation-stat]")).toHaveLength(0);
  });

  it("VPOA50 tokenizer は安全に認識できない箇所を plain text のまま保つ", () => {
    const item = briefing();
    const entry = item.data.entries[0]!;
    entry.source = "vpoa50";
    entry.headline = "1時間は時刻でない。<img src=x> 北区、板橋区で記録的短時間大雨。";
    entry.targetAreas = [];
    entry.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }] };
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const headline = [...container.querySelectorAll<HTMLElement>("[data-briefing-vpoa-headline]")].map((node) => node.textContent).join("");
    expect(headline).toBe(entry.headline);
    expect(container.querySelector("img")).toBeNull();
    const tokens = [...container.querySelectorAll<HTMLElement>("[data-briefing-vpoa-token]")].map((node) => node.textContent);
    expect(tokens).toEqual(expect.arrayContaining(["北区", "板橋区"]));
    expect(tokens).not.toContain("1時間");
  });

  it("VPOA50 tokenizer は offset 写像不能・候補なし・優先競合を plain fail-open する", () => {
    const item = briefing(3);
    const [unmapped, none, overlap] = item.data.entries;
    if (unmapped == null || none == null || overlap == null) throw new Error("three briefing entries are required");
    for (const entry of [unmapped, none, overlap]) {
      entry.source = "vpoa50";
      entry.summary = { mode: "structured", hasUnknownKind: false, items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }] };
    }
    unmapped.headline = "㍑の雨です。";
    unmapped.targetAreas = [{ name: "ット", code: "1" }];
    none.headline = "本文に認識対象はありません。";
    none.targetAreas = [];
    overlap.headline = "１時間に約１００ミリ。";
    overlap.targetAreas = [{ name: "約１００ミリ", code: "2" }];
    const { container } = render(BriefingCard, { item, shellHeightPx: 260 });
    const headlines = [...container.querySelectorAll<HTMLElement>("[data-briefing-vpoa-headline]")];
    expect(headlines.map((node) => node.textContent)).toEqual([unmapped.headline, none.headline, overlap.headline]);
    expect(headlines[0]?.querySelectorAll("[data-briefing-vpoa-token]")).toHaveLength(0);
    expect(headlines[1]?.querySelectorAll("[data-briefing-vpoa-token]")).toHaveLength(0);
    expect([...headlines[2]?.querySelectorAll<HTMLElement>("[data-briefing-vpoa-token]") ?? []].map((node) => node.textContent)).toEqual(["１時間に約１００ミリ"]);
  });
});
