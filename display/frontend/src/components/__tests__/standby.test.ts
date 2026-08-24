import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import StandbyScreen from "../StandbyScreen.svelte";
import App from "../../App.svelte";
import { baseSnapshot } from "../../lib/__tests__/fixtures";
import type { ActiveStandbyCardV1, DisplayActiveEewV1, DisplayLatestQuakeStateV1, DisplayRecentQuakeV1, DisplayTsunamiStateV1, DisplayTyphoonV1, DisplayWeatherAlertV1 } from "../../lib/protocol";
import { collectWeatherExpandedKinds } from "../../lib/weather-expanded-kinds";
import { SPRING_SPATIAL_DEFAULT_MS } from "../../lib/motion";
import { TIME_SLICE_PERIOD_MS } from "../../lib/legacy-standby/time-slice-scheduler.svelte";
import type { EpochCoordinatorControl } from "../../lib/legacy-standby/epoch-coordinator";

const now = new Date("2026-08-20T12:00:00+09:00");
const appStageOneMeasurement: Partial<Record<string, number>> = {
  layoutWidthPx: 1280, layoutHeightPx: 100,
  "quake:compact:right": 80, "quake:expanded:right": 80, "quake:full:right": 80,
  "quake:compact:center": 80, "quake:expanded:center": 80, "quake:full:center": 80,
  "weather:compact:right": 120, "weather:expanded:right": 120, "weather:full:right": 120,
  "weather:compact:center": 90, "weather:expanded:center": 90, "weather:full:center": 90,
};

type SnapshotListener = (event: MessageEvent<string>) => void;
class ClockTestEventSource {
  static instance: ClockTestEventSource | null = null;
  private readonly listeners = new Map<string, SnapshotListener[]>();
  constructor(_url: string | URL) { ClockTestEventSource.instance = this; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = listener as unknown as SnapshotListener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  emitSnapshot(snapshot: ReturnType<typeof baseSnapshot>): void {
    const event = new MessageEvent<string>("snapshot", { data: JSON.stringify({ type: "snapshot", snapshot }) });
    for (const listener of this.listeners.get("snapshot") ?? []) listener(event);
  }
  close(): void {}
}
const recent: DisplayRecentQuakeV1 = {
  eventId: "q-1", reportDateTime: "2026-08-20T12:00:00+09:00", originTime: "2026-08-20T11:58:00+09:00",
  hypocenterName: "日向灘", magnitude: "5.2", maxInt: "5弱", maxIntRank: 5, depth: "20km", tsunamiWarning: false,
};

function latestQuake(over: Partial<DisplayLatestQuakeStateV1> = {}): DisplayLatestQuakeStateV1 {
  return { eventId: "latest-1", headline: null, originTime: "2026-08-20T11:58:00+09:00", hypocenterName: "日向灘", depth: "20km", magnitude: "5.2", maxInt: "5弱", maxIntRank: 5, tsunamiWarning: false, intensityGroups: [], reportDateTime: "2026-08-20T12:00:00+09:00", updatedAtMs: 1, ...over };
}
function tsunami(over: Partial<DisplayTsunamiStateV1> = {}): DisplayTsunamiStateV1 {
  return { kind: "tsunami", level: "warning", levelLabel: "津波警報", coasts: [{ name: "宮崎県", kind: "津波警報", maxHeight: "3m", firstHeight: null }], warningComment: null, observations: [], reportDateTime: "2026-08-20T12:00:00+09:00", updatedAtMs: 1, ...over };
}
function weather(over: Partial<DisplayWeatherAlertV1> = {}): DisplayWeatherAlertV1 {
  return { source: "vpww56", label: "気象特別警報", role: "weatherEmergency", totalAreas: 1, items: [{ kind: "大雨特別警報", displaySeverity: "Emergency", rank: "emergency", shownAreas: ["宮崎市"], omittedAreaCount: 0 }], updatedAt: "2026-08-20T12:00:00+09:00", ...over };
}

function flood(surface: "corner-right" | "clock-top-wide" = "corner-right"): Extract<ActiveStandbyCardV1, { kind: "flood" }> {
  return {
    kind: "flood", surface, key: "flood:1", sourceEventIds: ["flood:1"], updatedAt: "2026-08-20T12:00:00+09:00",
    expiresAt: "2026-08-20T13:00:00+09:00", restored: false, severity: "critical",
    data: { rivers: [{ riverKey: "river", riverName: "一級河川", level: "L4", levelRank: 40, kindName: "氾濫危険情報", reportDateTime: "2026-08-20T12:00:00+09:00" }] },
  };
}
function typhoon(): Extract<ActiveStandbyCardV1, { kind: "typhoon" }> {
  const storm: DisplayTyphoonV1 = { typhoonKey: "TC-1", name: "Alpha", nameKana: "ALPHA", remark: null, typhoonNumber: "2605", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, maxGustMs: 35, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: "2026-08-20T12:00:00+09:00" };
  return { kind: "typhoon", surface: "corner-right", key: "typhoon:1", sourceEventIds: ["typhoon:1"], updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: null, restored: false, severity: "normal", data: { typhoons: [storm] } };
}
function volcano(): Extract<ActiveStandbyCardV1, { kind: "volcano" }> {
  return {
    kind: "volcano", surface: "corner-right", key: "volcano:1", sourceEventIds: ["volcano:1"],
    updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: null, restored: false, severity: "critical",
    data: { volcanoes: [{ code: "506", name: "桜島", alertLevel: 3, latestEvent: null }] },
  };
}
function heat(): Extract<ActiveStandbyCardV1, { kind: "heat" }> {
  return {
    kind: "heat", surface: "corner-right", key: "heat:1", sourceEventIds: ["heat:1"],
    updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: "2026-08-20T15:00:00+09:00", restored: false,
    severity: "warning", data: { targetDate: "2026-08-20", areas: [{ areaName: "宮崎県", isSpecial: false }] },
  };
}
function tornado(areas: string[]): Extract<ActiveStandbyCardV1, { kind: "tornado" }> {
  return {
    kind: "tornado", surface: "weather-rider", key: "tornado:1", sourceEventIds: ["tornado:1"],
    updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: "2026-08-20T13:00:00+09:00", restored: false,
    severity: "warning", data: { areas, isSighted: false },
  };
}

describe("StandbyScreen legacy-improved skeleton", () => {
  it("renders a tornado measurement entry in the shared weather shell", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    const dispatchStart = source.indexOf("{#snippet renderPrefixProbe(entry: PrefixMeasureEntry)}");
    const dispatchEnd = source.indexOf("{/snippet}", dispatchStart);
    const dispatch = source.slice(dispatchStart, dispatchEnd);
    expect(dispatch).toContain('{:else if entry.key === "tornado"}');
    expect(dispatch).toMatch(/entry\.key === "tornado"[\s\S]*WeatherAlertCard[\s\S]*measurementTornadoRange=\{entry\}/);
  });

  it("live weather shell registers tornado pages and renders only the active rider range", async () => {
    const overrides: Partial<Record<string, number>> = {
      layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10,
      "tornado:page-fit:0:2:placement:side:with:weather:0:0:rows:0:tails::identity::form:normal": 2,
      "tornado:page-fit:1:2:placement:side:with:weather:0:0:rows:0:tails::identity::form:normal": 0,
    };
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [tornado(["先頭地域", "後続地域"])] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: overrides,
    });
    for (let pass = 0; pass < 16; pass += 1) await tick();
    const card = container.querySelector<HTMLElement>(".legacy-layout .weather-card");
    expect(card?.dataset.tornadoPage).toBe("1/2");
    expect(card?.querySelector(".tornado-rider")?.textContent).toContain("先頭地域");
    expect(card?.querySelector(".tornado-rider")?.textContent).not.toContain("後続地域");
    expect(card?.closest<HTMLElement>(".legacy-card")?.dataset.cardPageFixedHeight).toBeTruthy();
  });

  it("tornado と weather prefix は selected / outer / rotation に同じ contract height を流す", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    expect(source).toMatch(/function tornadoPagingContractActive[\s\S]*tornadoItem != null[\s\S]*areas\.length > 0/);
    expect(source).toMatch(/selectedHeight[\s\S]*weather" && tornadoPagingOrProbing\(\)[\s\S]*weatherTornadoContractHeight/);
    expect(source).toMatch(/function measured[\s\S]*weather" && tornadoPagingOrProbing\(\)[\s\S]*weatherTornadoContractHeight/);
    expect(source).toMatch(/function pageFixedHeight[\s\S]*weather" && tornadoPagingOrProbing\(\)[\s\S]*weatherTornadoContractHeight/);
  });

  it("renders the fixed three-column grid, viewport clock landmark, and no outer paging", () => {
    const { container } = render(StandbyScreen, { snapshot: baseSnapshot(), now, dim: false, sseConnected: true });
    const root = container.querySelector(".standby");
    expect(root?.getAttribute("data-outer-paging")).toBe("none");
    expect(root?.querySelector(".legacy-layout")).toBeTruthy();
    expect(root?.querySelectorAll(".legacy-layout > .side")).toHaveLength(2);
    expect(root?.querySelector("[data-clock-landmark] .clock-wrap")).toBeTruthy();
  });

  it("keeps committed card surfaces through a same-priority content refresh", async () => {
    const testMeasurementOverride: Partial<Record<string, number>> = {
      layoutWidthPx: 1280, layoutHeightPx: 100, baselineGapPx: 10,
      "quake:compact:right": 60, "quake:expanded:right": 60, "quake:full:right": 60,
      "quake:compact:center": 60, "quake:expanded:center": 60, "quake:full:center": 60,
      "weather:compact:right": 20, "weather:expanded:right": 20, "weather:full:right": 20,
      "weather:compact:center": 20, "weather:expanded:center": 20, "weather:full:center": 20,
      "volcano:compact:right": 20, "volcano:expanded:right": 20, "volcano:full:right": 20,
      "volcano:compact:center": 20, "volcano:expanded:center": 20, "volcano:full:center": 20,
    };
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: [volcano()] }),
      now, dim: false, sseConnected: true, testMeasurementOverride,
    });
    const surfaces = () => [...view.container.querySelectorAll<HTMLElement>(".legacy-layout article[data-layout-motion-card]")]
      .map((card) => card.dataset.layoutMotionCard)
      .sort();
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const before = surfaces();

    await view.rerender({
      snapshot: baseSnapshot({ latestQuake: latestQuake({ updatedAtMs: 2 }), weatherAlerts: [weather({ updatedAt: "2026-08-20T12:01:00+09:00" })], standbyItems: [volcano()] }),
      now, dim: false, sseConnected: true, testMeasurementOverride,
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();

    expect(surfaces()).toEqual(before);
  });

  it("accepts cluster-calm only through the preview gate fixture prop", () => {
    const previewSource = readFileSync(join(__dirname, "..", "..", "preview", "PreviewApp.svelte"), "utf8");
    expect(previewSource).toContain('value === "cluster-calm"');
    expect(previewSource).toContain("legacyStandbyGate");
  });

  it("pins the overlap fixture to a real page-indicator/tornado-rider intersection", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    const runner = readFileSync(join(__dirname, "..", "..", "..", "..", "scripts", "capture-legacy-standby.mjs"), "utf8");
    expect(source).toMatch(/gate-overlap :global\(\.weather-card\.has-page-footer\.has-tornado \.tornado-rider\) \{ margin-top: 0; \}/);
    expect(runner).toContain('overlapDefault ? ["7"]');
    expect(runner).toContain('overlapDefault ? ["960x620"]');
  });

  it("guarantees readable side tracks at 960px and measures shelves against the same track widths", async () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    expect(source).toContain("--side-readable-width: 17.5rem");
    expect(source).toContain("--center-width: min(36rem, calc(100vw - var(--edge) * 2 - var(--gap) * 2 - var(--side-readable-width) * 2))");
    expect(source).toMatch(/\.measure-shelf, \.center-measure-shelf \{[^}]*calc\(\(100% - var\(--edge\) \* 2 - var\(--gap\) \* 2 - var\(--center-width\)\) \/ 2\)/);
    expect(source).toMatch(/\.measure-item :global\(\.standby-card\)[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;/);
    expect(source).toMatch(/\.measure-item :global\(\.flood-wide-card\)[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;/);

    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot(), now, dim: false, sseConnected: true,
      testMeasurementOverride: {
        layoutWidthPx: 912, layoutHeightPx: 572,
        leftTrackWidthPx: 280, centerTrackWidthPx: 333, rightTrackWidthPx: 280,
        sideMeasureShelfWidthPx: 280, centerMeasureShelfWidthPx: 333,
      },
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const root = container.querySelector<HTMLElement>(".standby")!;
    expect({
      left: root.dataset.leftTrackWidthPx,
      center: root.dataset.centerTrackWidthPx,
      right: root.dataset.rightTrackWidthPx,
      sideShelf: root.dataset.sideMeasureShelfWidthPx,
      centerShelf: root.dataset.centerMeasureShelfWidthPx,
    }).toEqual({ left: "280", center: "333", right: "280", sideShelf: "280", centerShelf: "333" });
  });

  it("keeps flood as one placement card and uses the side form outside the center", async () => {
    const { container, rerender } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [flood()] }), now, dim: false, sseConnected: true,
    });
    expect(container.querySelectorAll(".flood-slot")).toHaveLength(1);
    expect(container.querySelector(".flood-slot .flood-card")).toBeTruthy();
    expect(container.querySelector(".standby")?.getAttribute("data-flood-form")).toBe("card");
    await rerender({ snapshot: baseSnapshot({ standbyItems: [flood("clock-top-wide")] }), now, dim: false, sseConnected: true });
    await tick();
    // The solver may move a wide request to center, but it must never create a duplicate flood card.
    expect(container.querySelectorAll(".legacy-layout .flood-card, .legacy-layout .flood-wide-card")).toHaveLength(1);
    const visibleWide = container.querySelector(".legacy-layout .flood-wide-card") != null;
    expect(container.querySelector(".standby")?.getAttribute("data-flood-form")).toBe(visibleWide ? "wide" : "card");
  });

  it("exposes flood-only page sentinels without changing the quake page namespace", async () => {
    const item = flood();
    const rivers = Array.from({ length: 3 }, (_, index) => ({
      ...item.data.rivers[0]!, riverKey: `river:${index}`, riverName: `河川${index}`,
    }));
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [{ ...item, data: { rivers } }] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: {
        "flood:page-fit:0:1:placement:side:form:compact": 0,
        "flood:page-fit:0:2:placement:side:form:compact": 201,
        "flood:page-fit:1:2:placement:side:form:compact": 0,
        "flood:page-fit:1:3:placement:side:form:compact": 201,
        "flood:page-fit:2:3:placement:side:form:compact": 0,
      },
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const root = container.querySelector<HTMLElement>(".standby")!;
    expect(root.dataset.floodPage).toBe("1/3");
    expect(JSON.parse(root.dataset.floodPageKeys ?? "[]")).toEqual(["河川0", "河川1", "河川2"]);
    expect(JSON.parse(root.dataset.floodPageIdentities ?? "[]")).toEqual(["氾濫危険情報|河川0|0|code:river:0", "氾濫危険情報|河川1|0|code:river:1", "氾濫危険情報|河川2|0|code:river:2"]);
    expect(root.dataset.floodPageInfeasible).toBe("false");
    expect(root.dataset.cardPage).toBe("0/0");
    expect(container.querySelectorAll(".legacy-layout .flood-card [data-flood-entry-index]")).toHaveLength(1);
    expect(container.querySelector(".legacy-layout .flood-card [data-card-page-footer]")).toBeTruthy();
    const runner = readFileSync(join(__dirname, "..", "..", "..", "..", "scripts", "capture-legacy-standby.mjs"), "utf8");
    expect(root.dataset.floodPageFooter).toBeDefined();
    expect(root.dataset.floodPageVisibleCount).toBeDefined();
    for (const attribute of ["data-flood-page", "data-flood-page-keys", "data-flood-page-identities", "data-flood-page-infeasible", "data-flood-page-footer", "data-flood-page-visible-count"]) expect(runner).toContain(`"${attribute}"`);
    for (const attribute of ["data-tornado-page", "data-tornado-page-keys", "data-tornado-page-identities", "data-tornado-page-infeasible", "data-tornado-page-footer", "data-tornado-page-visible-count", "data-tornado-page-host", "data-tornado-page-mode", "data-tornado-page-pending-appearance"]) expect(runner).toContain(`"${attribute}"`);
    expect(runner).toContain("TORNADO_EXPECTATIONS");
  });

  it("rejects a shorter summary-only wide promotion and restores it when one detailed row fits", async () => {
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const base = flood("clock-top-wide");
    const item = (updatedAt: string) => ({
      ...base,
      updatedAt,
      data: {
        rivers: Array.from({ length: 4 }, (_, index) => ({
          ...base.data.rivers[0]!, riverKey: `river:${index}`, riverName: `河川${index}`,
        })),
      },
    });
      const measurements = () => ({
      layoutWidthPx: 1280, layoutHeightPx: 600,
      sideMeasureShelfWidthPx: 307, centerMeasureShelfWidthPx: 576,
      "flood:compact:right": 200, "flood:expanded:right": 40, "flood:full:right": 200,
        "flood:compact:center": 200, "flood:expanded:center": 200, "flood:full:center": 200,
        "flood:prefix:1:side": window.innerHeight <= 720 ? 217 : 0,
      });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    try {
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ standbyItems: [item("2026-08-20T12:00:00+09:00")] }),
        now, dim: false, sseConnected: true, testMeasurementOverride: measurements,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      expect(view.container.querySelector(".standby")?.getAttribute("data-flood-form")).toBe("card");
      expect(view.container.querySelector(".legacy-layout .flood-card")).toBeTruthy();

      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });
      await view.rerender({
        snapshot: baseSnapshot({ standbyItems: [item("2026-08-20T12:01:00+09:00")] }),
        now, dim: false, sseConnected: true, testMeasurementOverride: measurements,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      expect(view.container.querySelector(".standby")?.getAttribute("data-flood-form")).toBe("wide");
      expect(view.container.querySelector(".legacy-layout .flood-wide-card")).toBeTruthy();
      view.unmount();
    } finally {
      if (innerHeight == null) delete (window as { innerHeight?: number }).innerHeight;
      else Object.defineProperty(window, "innerHeight", innerHeight);
    }
  });

  it("demotes wide when a later one-river partition range is confirmed impossible", async () => {
    const base = flood("clock-top-wide");
    const rivers = ["a", "b"].map((riverKey) => ({ ...base.data.rivers[0]!, riverKey, riverName: riverKey }));
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [{ ...base, data: { rivers } }] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: {
        sideMeasureShelfWidthPx: 320, centerMeasureShelfWidthPx: 480,
        "flood:page-fit:0:1:placement:center:form:wide": 0, "flood:page-fit:0:2:placement:center:form:wide": 999,
        "flood:page-fit:1:2:placement:center:form:wide": 999,
        "flood:page-fit:0:1:placement:side:form:wide": 0, "flood:page-fit:0:2:placement:side:form:wide": 999,
        "flood:page-fit:1:2:placement:side:form:wide": 999,
        "flood:page-fit:0:1:placement:center:form:compact": 0, "flood:page-fit:0:2:placement:center:form:compact": 0,
        "flood:page-fit:0:1:placement:side:form:compact": 0, "flood:page-fit:0:2:placement:side:form:compact": 0,
      },
    });
    for (let pass = 0; pass < 12; pass += 1) await tick();
    expect(container.querySelector(".legacy-layout .flood-wide-card")).toBeNull();
    expect(container.querySelector(".legacy-layout .flood-card")).toBeTruthy();
  });

  it("does not count an initially full typhoon as placement surplus", async () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [typhoon()] }), now, dim: false, sseConnected: true,
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(container.querySelector(".standby")?.getAttribute("data-typhoon-variant")).toBe("full");
    expect(container.querySelector(".standby")?.getAttribute("data-placement-surplus-use")).toBe("0");
  });

  it("measures every candidate variant in both shelves, prunes removals, and keeps shelves out of visible counts", async () => {
    const first = flood();
    const { container, rerender } = render(StandbyScreen, { snapshot: baseSnapshot({ standbyItems: [first, typhoon()], weatherAlerts: [weather()] }), now, dim: false, sseConnected: true });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(container.querySelectorAll(".measure-shelf .measure-item")).toHaveLength(9);
    expect(container.querySelectorAll(".center-measure-shelf .measure-item")).toHaveLength(9);
    expect(container.querySelectorAll(".measure-shelf > .partition-preflight, .center-measure-shelf > .partition-preflight")).toHaveLength(2);
    expect(container.querySelectorAll(".legacy-layout .flood-card, .legacy-layout .flood-wide-card")).toHaveLength(1);
    const before = container.querySelector(".standby")?.getAttribute("data-measurement-epoch");
    await rerender({ snapshot: baseSnapshot({ standbyItems: [{ ...first, updatedAt: "2026-08-20T12:01:00+09:00" }] }), now, dim: false, sseConnected: true });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(container.querySelector(".standby")?.getAttribute("data-measurement-epoch")).not.toBe(before);
    await rerender({ snapshot: baseSnapshot({ standbyItems: [] }), now, dim: false, sseConnected: true });
    await tick();
    expect(container.querySelectorAll(".measure-shelf .measure-item, .center-measure-shelf .measure-item")).toHaveLength(0);
  });

  it("reports a bounded synchronous measurement epoch and the capacity diagnostics", async () => {
    const { container } = render(StandbyScreen, { snapshot: baseSnapshot(), now, dim: false, sseConnected: true });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const root = container.querySelector(".standby")!;
    expect(Number(root.getAttribute("data-measurement-pass"))).toBeLessThanOrEqual(4);
    expect(root.getAttribute("data-measurement-settled")).toBe("true");
    for (const name of ["data-left-capacity-px", "data-right-capacity-px", "data-center-capacity-px", "data-left-natural-height-px", "data-right-natural-height-px", "data-center-natural-height-px", "data-left-track-rect-width-px", "data-center-track-rect-width-px", "data-clock-children-horizontal-clipped", "data-page-indicator-rider-overlap-px", "data-flood-visibility-violation-keys", "data-flood-readable-overflow-keys"]) {
      expect(root.hasAttribute(name)).toBe(true);
    }
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    expect(source.indexOf("const geometry = readRenderedGeometry()"))
      .toBeLessThan(source.indexOf("measurementSettled = true", source.indexOf("function publishSettledGeometry")));
    expect(source).toMatch(/gate-overflow :global\(\.flood-wide-card\)[^}]*min-height:\s*1px !important;/s);
  });

  it("reports flood rows clipped by their card root even without row self-overflow", async () => {
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement): number { return this.classList.contains("flood-card") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement): number { return this.classList.contains("flood-card") ? 240 : 0; },
    });
    try {
      const { container } = render(StandbyScreen, {
        snapshot: baseSnapshot({ standbyItems: [flood()] }), now, dim: false, sseConnected: true,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      const root = container.querySelector(".standby")!;
      const riverRow = container.querySelector<HTMLElement>(".legacy-layout .flood-card .river-row")!;
      expect(riverRow.scrollHeight).toBe(riverRow.clientHeight);
      expect(root.getAttribute("data-flood-readable-overflow-keys")).toContain("flood:0:root");
    } finally {
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    }
  });

  it("validates normal/narrow flood entry counts and rejects a missing expected row", async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const originalClientRects = HTMLElement.prototype.getClientRects;
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    const visibleRect = new DOMRect(0, 0, 100, 20);
    const zeroHeightRect = new DOMRect(0, 0, 100, 0);
    const oneRect = { 0: visibleRect, length: 1, item: () => visibleRect } as unknown as DOMRectList;
    const zeroRect = { 0: zeroHeightRect, length: 1, item: () => zeroHeightRect } as unknown as DOMRectList;
    const noRects = { length: 0, item: () => null } as unknown as DOMRectList;
    let cardWidth = 360;
    let hideFirst = false;
    let hideCard = false;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.matches(".legacy-layout .flood-card")) return cardWidth;
        return clientWidth?.get?.call(this) ?? 0;
      },
    });
    const clientRects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement): DOMRectList {
      if (this.matches(".legacy-layout .flood-card")) return hideCard ? noRects : oneRect;
      if (this.matches(".legacy-layout .flood-card [data-flood-entry-index]")) {
        if (hideFirst && this.dataset.floodEntryIndex === "0") return zeroRect;
        return oneRect;
      }
      return originalClientRects.call(this);
    });
    const boundingRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      if (this.matches(".legacy-layout .flood-card")) return new DOMRect(0, 0, cardWidth, 200);
      if (this.matches(".legacy-layout .flood-card .river-row, .legacy-layout .flood-card .station-row")) {
        const entry = this.closest<HTMLElement>("[data-flood-entry-index]");
        if (hideFirst && entry?.dataset.floodEntryIndex === "0") {
          return new DOMRect(0, 220, 100, 20);
        }
        return new DOMRect(0, 50, 100, 20);
      }
      return originalBoundingRect.call(this);
    });
    try {
      const base = flood();
      const item = (updatedAt: string) => ({
        ...base,
        updatedAt,
        data: {
          rivers: Array.from({ length: 3 }, (_, index) => ({
            ...base.data.rivers[0]!, riverKey: `river:${index}`, riverName: `河川${index}`,
          })),
        },
      });
      const { container, rerender } = render(StandbyScreen, {
        snapshot: baseSnapshot({ standbyItems: [item("2026-08-20T12:00:00+09:00")] }), now, dim: false, sseConnected: true,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      let root = container.querySelector(".standby")!;
      expect(root.getAttribute("data-flood-visibility-violation-keys")).toBe("");
      expect(root.getAttribute("data-flood-readable-overflow-keys")).toBe("");

      cardWidth = 280;
      await rerender({
        snapshot: baseSnapshot({ standbyItems: [item("2026-08-20T12:01:00+09:00")] }), now, dim: false, sseConnected: true,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      root = container.querySelector(".standby")!;
      expect(root.getAttribute("data-flood-visibility-violation-keys")).toBe("");
      expect(container.querySelector(".standby")?.getAttribute("data-flood-readable-overflow-keys")).toBe("");

      hideFirst = true;
      await rerender({
        snapshot: baseSnapshot({ standbyItems: [item("2026-08-20T12:02:00+09:00")] }), now, dim: false, sseConnected: true,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      expect(container.querySelector(".standby")?.getAttribute("data-flood-visibility-violation-keys"))
        .toContain("flood:0:entry:0:missing");

      hideFirst = false;
      hideCard = true;
      await rerender({
        snapshot: baseSnapshot({ standbyItems: [item("2026-08-20T12:03:00+09:00")] }), now, dim: false, sseConnected: true,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      expect(container.querySelector(".standby")?.getAttribute("data-flood-visibility-violation-keys"))
        .toContain("flood:0:card:missing");

      // Reproduce the exact inactive-rotation ancestor contract around the
      // same missing-box card. Only that explicit wrapper may exempt it.
      const rotationWrapper = container.querySelector<HTMLElement>(".legacy-layout .flood-card")
        ?.closest<HTMLElement>(".legacy-card");
      expect(rotationWrapper).toBeTruthy();
      rotationWrapper?.classList.add("rotation-card");
      if (rotationWrapper != null) rotationWrapper.hidden = true;
      await rerender({
        snapshot: baseSnapshot({ standbyItems: [item("2026-08-20T12:04:00+09:00")] }), now, dim: false, sseConnected: true,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      expect(container.querySelector(".rotation-card[hidden] .flood-card")).toBeTruthy();
      expect(container.querySelector(".standby")?.getAttribute("data-flood-visibility-violation-keys")).toBe("");
    } finally {
      clientRects.mockRestore();
      boundingRect.mockRestore();
      if (clientWidth == null) delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      else Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    }
  });

  it("suppresses an unrecognised future DTO and exposes its count", () => {
    const future = { kind: "future-hazard", key: "future:1", updatedAt: "2026-08-20T12:00:00+09:00" } as unknown as ActiveStandbyCardV1;
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [future] }), now, dim: false, sseConnected: true,
    });
    const root = container.querySelector(".standby")!;
    expect(root.getAttribute("data-suppressed-unknown-count")).toBe("1");
    expect(root.textContent).not.toContain("future-hazard");
  });

  it("preserves the recent-quake replay replacement and auto-close API", async () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ recentQuakes: [recent] }), now, dim: false, sseConnected: true,
    });
    const row = container.querySelector<HTMLButtonElement>(".quakes-card button.row")!;
    row.click();
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();
  });

  it("notifies App only after the solved stage has settled", async () => {
    const onStageChange = vi.fn();
    render(StandbyScreen, { snapshot: baseSnapshot(), now, dim: false, sseConnected: true, onStageChange });
    expect(onStageChange).not.toHaveBeenCalled();
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(onStageChange).toHaveBeenCalledWith(0);
  });

  it("resets standby clock ownership on exit and ignores callbacks from an outgoing layer", () => {
    const source = readFileSync(join(__dirname, "..", "..", "App.svelte"), "utf8");
    expect(source).toMatch(/if \(mode !== "standby"\)[\s\S]*standbyStage = 0;[\s\S]*standbyRef\?\.closeQuakeCard\(\)/);
    expect(source).toContain('onStageChange={(stage) => { if (mode === "standby") standbyStage = stage; }}');
  });

  it("wires the scoped motion handoff", () => {
    const standbySource = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    const requestStart = standbySource.indexOf("function requestSettle");
    const requestEnd = standbySource.indexOf("$effect.pre", requestStart);
    const request = standbySource.slice(requestStart, requestEnd);
    expect(request.indexOf("preEpochCapture")).toBeLessThan(request.indexOf("coordinator.begin"));
    expect(request.indexOf("coordinator.begin")).toBeLessThan(request.indexOf("holdForEpoch"));
    const finalCommit = standbySource.indexOf("flushSync(() =>", standbySource.indexOf("async function settleMeasurements"));
    expect(finalCommit).toBeLessThan(standbySource.indexOf("coordinator.settle()", finalCommit));
    expect(standbySource.indexOf("coordinator.settle()", finalCommit)).toBeLessThan(standbySource.indexOf("runForEpoch", finalCommit));
    expect(standbySource).toContain("releaseAfterLayoutMotion");
    for (const surface of ["left", "right", "center", "rotation"]) {
      expect(standbySource).toContain(`surface: "${surface}"`);
    }
    expect(standbySource).toContain("class:clock-away={renderStage !== 0}");
  });

  it("keeps the ticker clock present through 0↔1 reversal, reduced motion, and disposal", async () => {
    vi.useFakeTimers();
    let reduce = false;
    vi.stubGlobal("EventSource", ClockTestEventSource);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return reduce; }, media: "(prefers-reduced-motion: reduce)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)));
    const view = render(App, { testStandbyStage: 0 });
    ClockTestEventSource.instance?.emitSnapshot(baseSnapshot());
    flushSync();
    expect(view.container.querySelector(".ticker-clock")).toBeNull();

    await view.rerender({ testStandbyStage: 1 });
    flushSync();
    expect(view.container.querySelector(".ticker-clock")).toBeTruthy();
    await view.rerender({ testStandbyStage: 0 });
    flushSync();
    // The outgoing ticker clock remains mounted while its removal timer runs.
    expect(view.container.querySelector(".ticker-clock")).toBeTruthy();
    await view.rerender({ testStandbyStage: 1 });
    flushSync();
    vi.advanceTimersByTime(SPRING_SPATIAL_DEFAULT_MS + 1);
    expect(view.container.querySelector(".ticker-clock")).toBeTruthy();

    await view.rerender({ testStandbyStage: 0 });
    flushSync();
    vi.advanceTimersByTime(SPRING_SPATIAL_DEFAULT_MS + 1);
    await tick();
    expect(view.container.querySelector(".ticker-clock")).toBeNull();
    view.unmount();

    reduce = true;
    const reduced = render(App, { testStandbyStage: 1 });
    ClockTestEventSource.instance?.emitSnapshot(baseSnapshot());
    flushSync();
    expect(reduced.container.querySelector(".ticker-clock")).toBeTruthy();
    await reduced.rerender({ testStandbyStage: 0 });
    flushSync();
    expect(reduced.container.querySelector(".ticker-clock")).toBeNull();
    reduced.unmount();
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("disposes a pending ticker-clock removal timer on unmount", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal("EventSource", ClockTestEventSource);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false, media: "(prefers-reduced-motion: reduce)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)));
    const view = render(App, { testStandbyStage: 1 });
    ClockTestEventSource.instance?.emitSnapshot(baseSnapshot());
    flushSync();
    await view.rerender({ testStandbyStage: 0 });
    flushSync();
    expect(view.container.querySelector(".ticker-clock")).toBeTruthy();
    let removalCallIndex = -1;
    for (let index = setTimeoutSpy.mock.calls.length - 1; index >= 0; index -= 1) {
      if (setTimeoutSpy.mock.calls[index]?.[1] === SPRING_SPATIAL_DEFAULT_MS) {
        removalCallIndex = index;
        break;
      }
    }
    expect(removalCallIndex).toBeGreaterThanOrEqual(0);
    const removalTimer = setTimeoutSpy.mock.results[removalCallIndex]?.value;

    view.unmount();
    expect(view.container.querySelector(".ticker-clock")).toBeNull();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(removalTimer);
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps one physical clock through a real stage-1 handoff and cancels its pending reveal rAF", async () => {
    vi.useFakeTimers();
    const reveal = { callback: null as FrameRequestCallback | null };
    const cancelReveal = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      reveal.callback = callback;
      return 41;
    }));
    vi.stubGlobal("cancelAnimationFrame", cancelReveal);
    vi.stubGlobal("EventSource", ClockTestEventSource);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false, media: "(prefers-reduced-motion: reduce)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)));
    const view = render(App, { testStandbyMeasurementOverride: appStageOneMeasurement });
    ClockTestEventSource.instance?.emitSnapshot(baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }));
    flushSync();
    expect(view.container.querySelector("[data-clock-landmark]")).toBeTruthy();
    expect(view.container.querySelector(".ticker-clock")).toBeNull();

    for (let pass = 0; pass < 10; pass += 1) await tick();
    // Stage 1 came from the real StandbyScreen solver. The outgoing central
    // clock remains in the DOM while the ticker clock waits for its rAF reveal.
    expect(view.container.querySelector(".clock-landmark.clock-away")).toBeTruthy();
    expect(view.container.querySelector(".ticker-clock")).toBeTruthy();
    expect(reveal.callback).not.toBeNull();

    view.unmount();
    expect(cancelReveal).toHaveBeenCalledWith(41);
    expect(view.container.querySelector(".clock-landmark, .ticker-clock")).toBeNull();
    reveal.callback?.(0);
    expect(view.container.querySelector(".clock-landmark, .ticker-clock")).toBeNull();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the emergency ticker clock on its direct, non-crossfade path", () => {
    vi.useFakeTimers();
    const requestReveal = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestReveal);
    vi.stubGlobal("EventSource", ClockTestEventSource);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false, media: "(prefers-reduced-motion: reduce)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)));
    const emergency: DisplayActiveEewV1 = {
      kind: "eew", eventId: "e1", serial: "1", isWarning: true, isFinal: false, isCancellation: false,
      hypocenterName: "駿河湾", forecastMaxInt: "5弱", forecastMaxIntRank: 5, magnitude: "5.0", colorIndex: null,
      reportDateTime: "2026-08-20T12:00:00+09:00", originTime: "2026-08-20T11:59:00+09:00",
      isAssumedHypocenter: false, depth: "10km", maxLgInt: null, regions: [], updatedAtMs: 1,
    };
    const view = render(App);
    ClockTestEventSource.instance?.emitSnapshot(baseSnapshot({ activeEews: [emergency], severityTier: "alert" }));
    flushSync();

    expect(view.container.querySelector("main")?.dataset.mode).toBe("emergency");
    expect(view.container.querySelector(".ticker-clock")).toBeTruthy();
    expect(view.container.querySelector(".ticker-frame")?.classList.contains("ticker-clock-visible")).toBe(true);
    expect(requestReveal).not.toHaveBeenCalled();
    view.unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe("StandbyScreen preserved standby behaviour", () => {
  let matchMediaOriginal: typeof window.matchMedia;
  beforeEach(() => {
    matchMediaOriginal = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); window.matchMedia = matchMediaOriginal; });
  const renderScreen = (over: Parameters<typeof baseSnapshot>[0] = {}) => render(StandbyScreen, { snapshot: baseSnapshot(over), now, dim: false, sseConnected: true });
  const recentRow = (container: HTMLElement): HTMLButtonElement => container.querySelector<HTMLButtonElement>(".legacy-layout .quakes-card button.row, [data-clock-landmark] .quakes-card button.row")!;

  it("keeps recent-quakes visibility, content, and the disconnected connection badge", () => {
    const empty = renderScreen({ recentQuakes: [] });
    expect(empty.container.querySelector(".quakes-card")).toBeFalsy();
    empty.unmount();
    const { container } = renderScreen({ recentQuakes: [recent], connection: { dmdata: "disconnected", lastReceivedAt: null, disconnectedSince: "t", reason: "timeout" } });
    expect(container.querySelector(".quakes-card")?.textContent).toContain("日向灘");
    expect(screen.getByText("切断されています")).toBeTruthy();
  });

  it("keeps the recent-quake compact intensity, depth, time, and tsunami markers", () => {
    const { container } = renderScreen({ recentQuakes: [{ ...recent, tsunamiWarning: true }] });
    expect(container.querySelector(".int-r5")?.textContent).toContain("5-");
    expect(container.querySelector(".depth")?.textContent).toContain("20km");
    expect(container.querySelector(".tsunami-mark")?.textContent).toBe("津波");
  });

  it("keeps dim on all visible card groups while retaining distinct tsunami severity styling", () => {
    const stats = { sparklineData: [1, 2], totalReceived: 10, todayQuakeCount: 1, todayMaxInt: "5弱", todayMaxIntRank: 5 };
    const { container } = render(StandbyScreen, { snapshot: baseSnapshot({ tsunami: tsunami(), latestQuake: latestQuake(), weatherAlerts: [weather()], recentQuakes: [recent], stats }), now, dim: true, sseConnected: true });
    const root = container.querySelector(".standby.dim")!;
    expect(root.querySelector(".tsunami-corner")).toBeTruthy();
    expect(root.querySelector(".quake-corner")).toBeTruthy();
    expect(root.querySelector(".weather-corner")).toBeTruthy();
    expect(root.querySelector(".instrument-row-wrap")).toBeTruthy();
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    const normalGroup = source.slice(source.indexOf(".standby.dim .quake-corner"), source.indexOf(".standby.dim .weather-corner"));
    const tsunamiGroup = source.slice(source.indexOf(".standby.dim .weather-corner"), source.indexOf("@media"));
    expect(normalGroup).toContain("opacity: .7");
    expect(normalGroup).not.toContain("tsunami-corner");
    expect(tsunamiGroup).toContain(".tsunami-corner");
    expect(tsunamiGroup).toContain("opacity: .7");
    const undimmed = render(StandbyScreen, { snapshot: baseSnapshot({ tsunami: tsunami(), latestQuake: latestQuake() }), now, dim: false, sseConnected: true });
    expect(undimmed.container.querySelector(".standby")?.classList.contains("dim")).toBe(false);
  });

  it("keeps tsunami/latest-quake fixed at the left-column head in tier order", async () => {
    const { container, rerender } = renderScreen({ tsunami: tsunami(), latestQuake: latestQuake() });
    const left = container.querySelector(".corner-left")!;
    expect(left.firstElementChild?.classList.contains("tsunami-corner")).toBe(true);
    await rerender({ snapshot: baseSnapshot({ tsunami: null, latestQuake: latestQuake() }), now, dim: false, sseConnected: true });
    expect(left.querySelector(".tsunami-corner")).toBeFalsy();
    expect(left.firstElementChild?.classList.contains("quake-corner")).toBe(true);
  });

  it("keeps weather severity heading promotion, precedence, and recovery on revision", async () => {
    const l4 = weather({ label: "土砂災害警戒情報", role: "weatherWarning", items: [{ kind: "L4 土砂災害危険警報", displaySeverity: "officialL4", rank: "warning", shownAreas: ["東京都"], omittedAreaCount: 0 }] });
    const l5 = weather({ source: "vpws50", items: [{ kind: "L5 大雨特別警報", displaySeverity: "officialL5", rank: "emergency", shownAreas: ["千葉県"], omittedAreaCount: 0 }] });
    const { container, rerender } = renderScreen({ weatherAlerts: [l4] });
    expect(container.querySelector(".weather-card .card-header")?.textContent).toContain("気象危険警報");
    await rerender({ snapshot: baseSnapshot({ weatherAlerts: [l4, l5] }), now, dim: false, sseConnected: true });
    expect(container.querySelector(".weather-card .card-header")?.textContent).toContain("気象特別警報");
    const l3 = weather({ label: "気象警報", role: "weatherWarning", items: [{ kind: "大雨警報", displaySeverity: "officialL3", rank: "warning", shownAreas: ["東京都"], omittedAreaCount: 0 }] });
    await rerender({ snapshot: baseSnapshot({ weatherAlerts: [l3] }), now, dim: false, sseConnected: true });
    expect(container.querySelector(".weather-card .card-header")?.textContent).toContain("気象警報");
  });

  it("keeps the latest-quake rider and card design-token contracts", () => {
    const longPeriod = { kind: "longPeriod", surface: "quake-rider", key: "lp:1", sourceEventIds: ["lp"], updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: null, restored: false, severity: "warning", data: { eventId: "latest-1", maxLgInt: "3" } } as Extract<ActiveStandbyCardV1, { kind: "longPeriod" }>;
    const { container } = renderScreen({ latestQuake: latestQuake(), standbyItems: [longPeriod] });
    expect(container.querySelector(".quake-corner .quake-card")?.textContent).toContain("長周期地震動");
    for (const name of ["RecentQuakes.svelte", "LatestQuakeCard.svelte"]) {
      const source = readFileSync(join(__dirname, "..", name), "utf8");
      expect(source).toContain("var(--radius-s)");
    }
    for (const name of ["LatestQuakeCard.svelte", "WeatherAlertCard.svelte", "TsunamiStandbyBanner.svelte"]) {
      const source = readFileSync(join(__dirname, "..", name), "utf8");
      expect(source).toContain("box-shadow: var(--elevation-2)");
    }
  });

  it("keeps replay replacement in the quake slot without duplicate latest cards", async () => {
    const { container } = renderScreen({ latestQuake: latestQuake({ hypocenterName: "石垣島近海" }), recentQuakes: [recent] });
    recentRow(container).click();
    await tick();
    expect(container.querySelectorAll(".corner-left .quake-corner")).toHaveLength(1);
    expect(container.querySelector(".corner-left .quake-replay-card")).toBeTruthy();
    expect(container.querySelector(".corner-left .quake-card")).toBeFalsy();
    recentRow(container).click();
    await tick();
    expect(container.querySelector(".corner-left .quake-card")).toBeTruthy();
  });

  it("keeps replay toggle, replacement, 20-second auto-close, and external close", async () => {
    const { container, component } = renderScreen({ latestQuake: latestQuake(), recentQuakes: [recent, { ...recent, eventId: "q-2", hypocenterName: "浦河沖" }] });
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".quakes-card button.row"));
    rows[0]!.click(); await tick();
    rows[1]!.click(); await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("浦河沖");
    vi.advanceTimersByTime(20_000); await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
    rows[0]!.click(); await tick();
    component.closeQuakeCard(); await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("follows a corrected selected quake and closes when it disappears or becomes ambiguous", async () => {
    const { container, rerender } = renderScreen({ recentQuakes: [recent] });
    recentRow(container).click(); await tick();
    await rerender({ snapshot: baseSnapshot({ recentQuakes: [{ ...recent, hypocenterName: "訂正後の震源" }] }), now, dim: false, sseConnected: true });
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("訂正後の震源");
    await rerender({ snapshot: baseSnapshot({ recentQuakes: [] }), now, dim: false, sseConnected: true });
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("closes an ambiguous selection and never bubbles a recent-quake click to the dim toggle", async () => {
    const { container, rerender } = renderScreen({ recentQuakes: [recent] });
    let bubbled = false;
    window.addEventListener("click", () => { bubbled = true; }, { once: true });
    recentRow(container).click(); await tick();
    expect(bubbled).toBe(false);
    await rerender({ snapshot: baseSnapshot({ recentQuakes: [recent, { ...recent, hypocenterName: "重複" }] }), now, dim: false, sseConnected: true });
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("keeps tsunami replay wiring and places the nankai band immediately above the ticker edge", () => {
    const onTsunamiReplay = vi.fn();
    const nankai = { kind: "nankaiTrough", surface: "clock-below", key: "nankai:1", sourceEventIds: ["n"], updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: null, restored: false, severity: "info", data: { statusCode: "normal", label: "南海トラフ" } } as Extract<ActiveStandbyCardV1, { kind: "nankaiTrough" }>;
    const { container } = render(StandbyScreen, { snapshot: baseSnapshot({ tsunami: tsunami(), standbyItems: [nankai] }), now, dim: false, sseConnected: true, onTsunamiReplay });
    const buttons = container.querySelectorAll<HTMLButtonElement>(".legacy-layout .tsunami-corner .count-chip");
    buttons[0]?.click();
    expect(onTsunamiReplay).toHaveBeenCalledWith("warning");
    expect(container.querySelector(".nankai-ticker.bottom-stack")).toBeTruthy();
  });

  it("reserves the Nankai band outside the side-column rectangle", async () => {
    const nankai = { kind: "nankaiTrough", surface: "clock-below", key: "nankai:reserve", sourceEventIds: ["n"], updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: null, restored: false, severity: "info", data: { statusCode: "normal", label: "南海トラフ" } } as Extract<ActiveStandbyCardV1, { kind: "nankaiTrough" }>;
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), standbyItems: [nankai, typhoon()] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 160, nankaiHeightPx: 48, baselineGapPx: 10 },
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const root = container.querySelector<HTMLElement>(".standby")!;
    expect(root.style.getPropertyValue("--nankai-reserve")).toBe("48px");
    // layoutHeightPx is now the rectangle above the band, so solver and the
    // visible side columns use the same bottom edge instead of double pricing.
    expect(root.getAttribute("data-left-capacity-px")).toBe("160");
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf-8");
    expect(source).toMatch(/\.legacy-layout\s*\{[^}]*inset:\s*var\(--edge\) var\(--edge\) calc\(var\(--edge\) \+ var\(--nankai-reserve\)\)/s);
  });

  it("uses the legacy mock's compact spacing tokens at ladder stage 2 and above", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf-8");
    expect(source).toMatch(/\.standby\.ladder-compressed\s*\{[^}]*--space-1:\s*2px;[^}]*--space-2:\s*4px;[^}]*--space-3:\s*6px;[^}]*--space-4:\s*8px;[^}]*--space-5:\s*10px;/s);
  });

  it("latches compressed geometry before remeasuring a stage-3 target", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf-8");
    expect(source).toMatch(/if \(plan\.stage >= 2\) floorStage = Math\.max\(floorStage, 2\) as LadderStage;[\s\S]*measurementGeometryStage = \(plan\.stage >= 2 \? Math\.max\(plan\.stage, 2\) : plan\.stage\) as LadderStage;/);
  });

  it("keeps separate tsunami chips and propagates the selected warning level", () => {
    const onTsunamiReplay = vi.fn();
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: tsunami({ coasts: [
        { name: "宮崎県", kind: "津波警報", maxHeight: "3m", firstHeight: null },
        { name: "鹿児島県", kind: "津波注意報", maxHeight: "1m", firstHeight: null },
      ] }) }), now, dim: false, sseConnected: true, onTsunamiReplay,
    });
    const chips = container.querySelectorAll<HTMLButtonElement>(".tsunami-corner .count-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain("警報");
    expect(chips[1]?.textContent).toContain("注意報");
    chips[1]?.click();
    expect(onTsunamiReplay).toHaveBeenCalledWith("advisory");
  });

  it("renders selected quake and weather expansion candidates in the cards", async () => {
    const quake = latestQuake({ intensityGroups: [{ intensity: "5弱", rank: 5, areas: ["宮崎市"], omittedAreaCount: 2, expandedAreas: ["宮崎市", "日南市", "串間市"] }] });
    const alert = weather({ items: [{ kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "officialL3", rank: "warning", shownAreas: ["宮崎市"], omittedAreaCount: 1 }] });
    const { container } = renderScreen({ latestQuake: quake, weatherAlerts: [alert], weatherExpandedKinds: [{ kindKey: "officialL3|heavy-rain", areas: ["宮崎市", "日南市"], totalAreaCount: 2, candidateTruncated: false }] });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const counts = JSON.parse(container.querySelector(".standby")?.getAttribute("data-expanded-counts") ?? "{}") as {
      quake?: { count: number; n: number };
      weather?: Record<string, { count: number; n: number }>;
    };
    expect(counts.quake).toEqual({ count: 3, n: 0 });
    expect(counts.weather?.["大雨警報"]).toEqual({ count: 2, n: 0 });
    expect(container.querySelector(".legacy-layout")?.textContent).toContain("日南市");
  });

  it("最高roleだけで alias fallback と候補配分を wire と同じ kindKey へ揃える", async () => {
    const alerts = [
      weather({
        source: "vpww56",
        role: "weatherEmergency",
        items: [{
          kind: "大雨警報", displaySeverity: "warning", rank: "warning",
          shownAreas: ["宮崎市"], omittedAreaCount: 1,
        }],
      }),
      weather({
        source: "vpws50",
        role: "weatherWarning",
        items: [{
          kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
          shownAreas: ["下位地域"], omittedAreaCount: 0,
        }],
      }),
    ];
    const wire = collectWeatherExpandedKinds(alerts);
    expect(wire).toEqual([{
      kindKey: "warning|大雨警報", areas: ["宮崎市"], totalAreaCount: 2, candidateTruncated: true,
    }]);
    const { container } = renderScreen({ weatherAlerts: alerts, weatherExpandedKinds: wire });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const card = container.querySelector<HTMLElement>(".legacy-layout .weather-card");
    expect(card?.querySelector("[data-kind-key]")?.getAttribute("data-kind-key")).toBe(wire[0]?.kindKey);
    expect(card?.textContent).toContain("宮崎市");
    expect(card?.textContent).not.toContain("下位地域");
    const counts = JSON.parse(container.querySelector(".standby")?.getAttribute("data-expanded-counts") ?? "{}") as {
      weather?: Record<string, { count: number; n: number }>;
    };
    expect(counts.weather?.["大雨警報"]).toEqual({ count: 1, n: 1 });
  });

  it("snapshot の展開候補を名称と Area.Code の対で card まで渡し、同名別県を保持する", async () => {
    const alerts = [
      weather({ source: "vpws50", role: "weatherWarning", items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: ["府中市"], shownAreaCodes: ["1320600"], omittedAreaCount: 0,
      }] }),
      weather({ source: "vpww56", role: "weatherWarning", items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: ["府中市"], shownAreaCodes: ["3420600"], omittedAreaCount: 0,
      }] }),
    ];
    const wire = collectWeatherExpandedKinds(alerts);
    expect(wire[0]).toMatchObject({
      areas: ["府中市", "府中市"], areaCodes: ["1320600", "3420600"],
    });

    const { container } = renderScreen({ weatherAlerts: alerts, weatherExpandedKinds: wire });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const card = container.querySelector(".legacy-layout .weather-card");
    expect(Array.from(card?.querySelectorAll(".pref-name") ?? []).map((el) => el.textContent))
      .toEqual(["東京都", "広島県"]);
    expect(Array.from(card?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent))
      .toEqual(["府中市", "府中市"]);
  });

  it("同一 kindKey の複数sourceでも wire 残置数を一度だけカードへ帰属する", async () => {
    const alerts = [
      weather({ source: "vpws50", role: "weatherWarning", items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: ["宮崎市"], omittedAreaCount: 0,
      }] }),
      weather({ source: "vpww56", role: "weatherWarning", items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: ["日南市"], omittedAreaCount: 0,
      }] }),
    ];
    const { container } = renderScreen({
      weatherAlerts: alerts,
      weatherExpandedKinds: [{
        kindKey: "warning|heavy-rain", areas: ["宮崎市", "日南市"], totalAreaCount: 5, candidateTruncated: true,
      }],
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const card = container.querySelector(".legacy-layout .weather-card");
    expect(card?.querySelectorAll("[data-kind-key]")).toHaveLength(1);
    expect(card?.querySelector(".omitted")?.textContent).toBe("ほか3地域");
  });

  it("下位roleの同一 kindKey は B の候補行数を消費しない", async () => {
    const alerts = [
      weather({ source: "vpww56", role: "weatherEmergency", items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: ["宮崎市"], omittedAreaCount: 0,
      }] }),
      weather({ source: "vpws50", role: "weatherWarning", items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: ["下位地域"], omittedAreaCount: 0,
      }] }),
    ];
    const { container } = renderScreen({
      weatherAlerts: alerts,
      weatherExpandedKinds: [{
        kindKey: "warning|heavy-rain", areas: ["宮崎市", "高位候補"], totalAreaCount: 2, candidateTruncated: false,
      }],
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[data-prefix-measure]"))
      .map((node) => node.dataset.prefixMeasure ?? "");
    expect(ids.some((id) => id.startsWith("weather:prefix:2:"))).toBe(false);
    expect(container.querySelector(".legacy-layout")?.textContent).toContain("高位候補");
    expect(container.querySelector(".legacy-layout")?.textContent).not.toContain("下位地域");
  });

  it("keeps compact and full measurement variants independent from B expansion", async () => {
    const quake = latestQuake({ intensityGroups: [{ intensity: "5弱", rank: 5, areas: ["宮崎市"], omittedAreaCount: 1, expandedAreas: ["宮崎市", "日南市"] }] });
    const { container } = renderScreen({ latestQuake: quake });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(container.querySelector('.measure-item[data-measure-variant="compact"]')?.textContent).not.toContain("日南市");
    expect(container.querySelector('.measure-item[data-measure-variant="full"]')?.textContent).not.toContain("日南市");
    expect(container.querySelector('.measure-item[data-measure-variant="expanded"]')?.textContent).toContain("日南市");
  });

  it("measures flood promotion with the wide shelf form", () => {
    const { container } = render(StandbyScreen, { snapshot: baseSnapshot({ standbyItems: [flood("clock-top-wide")] }), now, dim: false, sseConnected: true });
    expect(container.querySelector('.measure-item[data-measure-variant="compact"] .flood-card')).toBeTruthy();
    expect(container.querySelector('.measure-item[data-measure-variant="expanded"] .flood-wide-card')).toBeTruthy();
  });

  it("uses the same numeric wide contract for center selection, measurement, probe, and live shell", async () => {
    const testMeasurementOverride = {
      sideMeasureShelfWidthPx: 320, centerMeasureShelfWidthPx: 480,
      "flood:page-fit:0:1:placement:center:form:wide": 0,
      "flood:page-fit:0:1:placement:side:form:wide": 0,
      "flood:prefix:1:center": 0, "flood:prefix:1:side": 0,
    };
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [flood("clock-top-wide")] }), now, dim: false, sseConnected: true, testMeasurementOverride,
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const root = container.querySelector<HTMLElement>(".standby")!;
    const expected = Number(root.dataset.floodCenterProbeHeightPx);
    expect(root.dataset.floodCenterWideAllowed).toBe("true");
    expect(Number(root.dataset.floodCenterSelectedHeightPx)).toBe(expected);
    expect(Number(root.dataset.floodCenterMeasuredHeightPx)).toBe(expected);
    expect(Number(root.dataset.floodCenterOuterHeightPx)).toBe(expected);
    expect(Number(root.dataset.floodRotationSlotHeightPx)).toBe(200);
  });

  it("keeps a selected wide flood form through a pending probe and demotes only on confirmed failure", async () => {
    const previousResizeObserver = globalThis.ResizeObserver;
    class PendingResizeObserver { observe(): void {} disconnect(): void {} unobserve(): void {} }
    vi.stubGlobal("ResizeObserver", PendingResizeObserver);
    const wideFit = {
      sideMeasureShelfWidthPx: 320, centerMeasureShelfWidthPx: 480,
      "flood:page-fit:0:1:placement:center:form:wide": 0,
      "flood:page-fit:0:1:placement:side:form:wide": 0,
    };
    const widthsOnly = { sideMeasureShelfWidthPx: 320, centerMeasureShelfWidthPx: 480 };
    const zeroWidths = { sideMeasureShelfWidthPx: 0, centerMeasureShelfWidthPx: 0 };
    const wideFail = {
      ...widthsOnly,
      "flood:page-fit:0:1:placement:center:form:wide": 10_000,
      "flood:page-fit:0:1:placement:side:form:wide": 10_000,
    };
    try {
      const initial = flood("clock-top-wide");
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ standbyItems: [initial] }), now, dim: false, sseConnected: true, testMeasurementOverride: wideFit,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      expect(view.container.querySelector(".legacy-layout .flood-wide-card")).toBeTruthy();

      await view.rerender({
        snapshot: baseSnapshot({ standbyItems: [{ ...initial, data: { rivers: initial.data.rivers.map((river) => ({ ...river, station: { name: "更新", levelM: 2, trend: null, thresholdLabel: null } })) } }] }),
        now, dim: false, sseConnected: true, testMeasurementOverride: zeroWidths,
      });
      for (let pass = 0; pass < 4; pass += 1) await tick();
      expect(view.container.querySelector(".legacy-layout .flood-wide-card")).toBeTruthy();

      await view.rerender({
        snapshot: baseSnapshot({ standbyItems: [initial] }), now, dim: false, sseConnected: true, testMeasurementOverride: wideFail,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      expect(view.container.querySelector(".legacy-layout .flood-wide-card")).toBeNull();
      expect(view.container.querySelector(".legacy-layout .flood-card")).toBeTruthy();
      view.unmount();
    } finally {
      vi.unstubAllGlobals();
      if (previousResizeObserver != null) globalThis.ResizeObserver = previousResizeObserver;
    }
  });

  it("runs wide → compact → aggregate → clip through the live flood form state machine", async () => {
    const width = { sideMeasureShelfWidthPx: 320, centerMeasureShelfWidthPx: 480 };
    const forms = (wide: number, compact: number, aggregate: number) => ({
      ...width,
      "flood:page-fit:0:1:placement:center:form:wide": wide,
      "flood:page-fit:0:1:placement:side:form:wide": wide,
      "flood:page-fit:0:1:placement:center:form:compact": compact,
      "flood:page-fit:0:1:placement:side:form:compact": compact,
      "flood:page-fit:0:0:placement:center:form:compact": aggregate,
      "flood:page-fit:0:0:placement:side:form:compact": aggregate,
    });
    const initial = flood("clock-top-wide");
    const revised = (revision: number) => ({
      ...initial,
      updatedAt: `2026-08-20T12:0${revision}:00+09:00`,
      data: { rivers: initial.data.rivers.map((river) => ({ ...river, station: { name: `詳細${revision}`, levelM: revision, trend: null, thresholdLabel: null } })) },
    });
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [revised(0)] }), now, dim: false, sseConnected: true, testMeasurementOverride: forms(0, 0, 0),
    });
    const settle = async () => { for (let pass = 0; pass < 12; pass += 1) await tick(); };
    await settle();
    expect(view.container.querySelector(".legacy-layout .flood-wide-card")).toBeTruthy();

    await view.rerender({ snapshot: baseSnapshot({ standbyItems: [revised(1)] }), now, dim: false, sseConnected: true, testMeasurementOverride: forms(10_000, 0, 0) });
    await settle();
    let card = view.container.querySelector<HTMLElement>(".legacy-layout .flood-card");
    expect(card).toBeTruthy();
    expect(card?.dataset.cardPageInfeasible).toBe("false");
    expect(view.container.querySelector<HTMLElement>(".standby")?.dataset.floodPageInfeasible).toBe("false");

    await view.rerender({ snapshot: baseSnapshot({ standbyItems: [revised(2)] }), now, dim: false, sseConnected: true, testMeasurementOverride: forms(10_000, 10_000, 0) });
    await settle();
    card = view.container.querySelector<HTMLElement>(".legacy-layout .flood-card");
    expect(card?.dataset.cardPageInfeasible).toBe("aggregate");
    expect(card?.querySelector("[data-flood-aggregate]")).toBeTruthy();
    expect(view.container.querySelector<HTMLElement>(".standby")?.dataset.floodPageInfeasible).toBe("aggregate");

    await view.rerender({ snapshot: baseSnapshot({ standbyItems: [revised(3)] }), now, dim: false, sseConnected: true, testMeasurementOverride: forms(10_000, 10_000, 10_000) });
    await settle();
    expect(view.container.querySelector<HTMLElement>(".legacy-layout .flood-card")?.dataset.cardPageInfeasible).toBe("clip");
    expect(view.container.querySelector<HTMLElement>(".standby")?.dataset.floodPageInfeasible).toBe("clip");
    view.unmount();
  });

  it("reduces typhoon full to compact and retains it when weather increases", async () => {
    const testMeasurementOverride = {
      layoutWidthPx: 1280, layoutHeightPx: 100,
      "quake:compact:right": 60, "quake:expanded:right": 60, "quake:full:right": 60,
      "quake:compact:center": 60, "quake:expanded:center": 60, "quake:full:center": 60,
      "weather:compact:right": 60, "weather:expanded:right": 60, "weather:full:right": 60,
      "weather:compact:center": 60, "weather:expanded:center": 60, "weather:full:center": 60,
      "typhoon:compact:right": 20, "typhoon:expanded:right": 20, "typhoon:full:right": 90,
      "typhoon:compact:center": 20, "typhoon:expanded:center": 20, "typhoon:full:center": 90,
    };
    const { container, rerender } = render(StandbyScreen, { snapshot: baseSnapshot({ latestQuake: latestQuake(), standbyItems: [typhoon()] }), now, dim: false, sseConnected: true, testMeasurementOverride });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(container.querySelector(".legacy-layout .typhoon-card.compact")).toBeFalsy();
    await rerender({ snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: [typhoon()] }), now, dim: false, sseConnected: true, testMeasurementOverride });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(container.querySelector(".legacy-layout .typhoon-card.compact")).toBeTruthy();
    expect(container.querySelector(".legacy-layout .typhoon-card")).toBeTruthy();
  });
});

describe("StandbyScreen measured stage epoch", () => {
  const cardHeights = (weatherRight: number, weatherCenter: number, typhoonRight = 0, typhoonCenter = 0) => ({
    layoutWidthPx: 1280, layoutHeightPx: 100,
    "quake:compact:right": 80, "quake:expanded:right": 80, "quake:full:right": 80,
    "quake:compact:center": 80, "quake:expanded:center": 80, "quake:full:center": 80,
    "weather:compact:right": weatherRight, "weather:expanded:right": weatherRight, "weather:full:right": weatherRight,
    "weather:compact:center": weatherCenter, "weather:expanded:center": weatherCenter, "weather:full:center": weatherCenter,
    "typhoon:compact:right": typhoonRight, "typhoon:expanded:right": typhoonRight, "typhoon:full:right": typhoonRight,
    "typhoon:compact:center": typhoonCenter, "typhoon:expanded:center": typhoonCenter, "typhoon:full:center": typhoonCenter,
  });
  const cases = [
    { stage: 1, override: cardHeights(120, 90), items: [] as ActiveStandbyCardV1[] },
    { stage: 2, override: cardHeights(120, 45, 120, 45), items: [typhoon()] as ActiveStandbyCardV1[] },
    // No rotation reservation fits this measurement set, so it remains a
    // central stage-2 plan instead of exposing an empty rotation slot.
    { stage: 2, override: cardHeights(120, 55, 120, 55), items: [typhoon()] as ActiveStandbyCardV1[] },
  ] as const;
  const rotationStage = {
    ...cardHeights(40, 40, 40, 40), layoutHeightPx: 90, gapPx: 10, baselineGapPx: 10,
    rotationIndicatorHeightPx: 12,
    "flood:compact:right": 40, "flood:expanded:right": 40, "flood:full:right": 40,
    "flood:compact:center": 40, "flood:expanded:center": 40, "flood:full:center": 40,
    "volcano:compact:right": 40, "volcano:expanded:right": 40, "volcano:full:right": 40,
    "volcano:compact:center": 40, "volcano:expanded:center": 40, "volcano:full:center": 40,
    "heat:compact:right": 40, "heat:expanded:right": 40, "heat:full:right": 40,
    "heat:compact:center": 40, "heat:expanded:center": 40, "heat:full:center": 40,
  };
  const rotationItems = [flood(), typhoon(), volcano(), heat()];

  it.each(cases)("settles auto-selected measured stage $stage through the component epoch", async ({ stage, override, items }) => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: items }), now, dim: false, sseConnected: true,
      testMeasurementOverride: override,
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const root = container.querySelector(".standby")!;
    expect(root.getAttribute("data-measurement-settled")).toBe("true");
    expect(root.getAttribute("data-ladder-stage")).toBe(String(stage));
    if (stage < 3) expect(container.querySelector(".center-card-region")).toBeTruthy();
    else expect(container.querySelector(".rotation-slot")).toBeTruthy();
  });

  it("re-measures in compressed geometry before committing a stage-3 plan", async () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: rotationItems }), now, dim: false, sseConnected: true,
      testMeasurementOverride: rotationStage,
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const root = container.querySelector<HTMLElement>(".standby")!;
    expect(root.dataset.ladderStage).toBe("3");
    expect(root.dataset.measurementGeometryStage).toBe("3");
    expect(root.classList.contains("ladder-compressed")).toBe(true);
    // First reads occur in stage 0, then the same bounded pass reads once more
    // after the stage-3 compression variables are applied.
    expect(Number(root.dataset.measurementPass)).toBeGreaterThanOrEqual(3);
  });

  it("commits and releases a bounded nonconvergent final pass", async () => {
    const changingGeometry = (pass: number) => ({
      ...cardHeights(120, 90),
      layoutHeightPx: 100 + pass,
    });
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }),
      now, dim: false, sseConnected: true, testMeasurementOverride: changingGeometry,
    });
    for (let pass = 0; pass < 12; pass += 1) await tick();

    const root = view.container.querySelector<HTMLElement>(".standby")!;
    expect(root.dataset.measurementNonconverged).toBe("true");
    expect(root.dataset.measurementSettled).toBe("true");
    await tick();
    expect(JSON.parse(root.dataset.schedulerState ?? "{}")).toMatchObject({
      rotation: { epochHeld: false },
      paging: { epochHeld: false },
    });
    view.unmount();
  });

  it("terminally settles a pending-probe exhaustion and re-arms the next rotation tick", async () => {
    vi.useFakeTimers();
    try {
      const pendingProbe = vi.fn();
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: rotationItems }),
        now, dim: false, sseConnected: true,
        testMeasurementOverride: (pass) => ({ ...rotationStage, layoutHeightPx: 90 + pass }),
        testProbeAfterMeasurementPass: (epoch) => epoch.enqueueProbe("test:terminal-pending", pendingProbe),
      });
      for (let pass = 0; pass < 14; pass += 1) await tick();

      const root = view.container.querySelector<HTMLElement>(".standby")!;
      expect(root.dataset.measurementNonconverged).toBe("true");
      expect(root.dataset.measurementSettled).toBe("true");
      await tick();
      expect(JSON.parse(root.dataset.schedulerState ?? "{}")).toMatchObject({
        rotation: { epochHeld: false, timerActive: true },
        paging: { epochHeld: false },
      });
      const before = root.dataset.rotationActiveKey;
      vi.advanceTimersByTime(TIME_SLICE_PERIOD_MS);
      await tick();
      vi.advanceTimersByTime(0);
      await tick();
      expect(root.dataset.rotationActiveKey).not.toBe(before);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a queued successor replace a nonconvergent epoch before its terminal commit", async () => {
    let successorQueued = false;
    const onStageChange = vi.fn();
    const afterOldTerminalBoundary = vi.fn(() => {
      // This runs before the queued successor starts its own settle loop.
      expect(onStageChange).not.toHaveBeenCalled();
    });
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }),
      now, dim: false, sseConnected: true,
      testMeasurementOverride: (pass) => successorQueued
        ? { ...cardHeights(120, 90), layoutHeightPx: 250, baselineGapPx: 10 }
        : { ...cardHeights(120, 90), layoutHeightPx: 100 + pass },
      testBeforeTerminalCommit: (queueSuccessor) => {
        successorQueued = true;
        queueSuccessor();
      },
      testAfterTerminalBoundary: afterOldTerminalBoundary,
      onStageChange,
    });
    for (let pass = 0; pass < 24; pass += 1) await tick();

    const root = view.container.querySelector<HTMLElement>(".standby")!;
    // The old nonconvergent epoch had no final commit; the successor retained
    // the promoted stage through its normal hysteresis-constrained settle.
    expect(afterOldTerminalBoundary).toHaveBeenCalledOnce();
    expect(onStageChange).toHaveBeenCalledExactlyOnceWith(1);
    expect(root.dataset.ladderStage).toBe("1");
    expect(root.dataset.measurementNonconverged).toBe("false");
    expect(root.dataset.measurementSettled).toBe("true");
    view.unmount();
  });

  it("drains a final-flush same-epoch probe and releases both scheduler owners", async () => {
    vi.useFakeTimers();
    try {
      let injected = false;
      const onStageChange = vi.fn();
      const lateProbe = vi.fn();
      const finalCommitHook = vi.fn((epoch: EpochCoordinatorControl) => {
        if (injected) return;
        injected = true;
        epoch.enqueueProbe("test:late-final-flush", lateProbe);
      });
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }),
        now, dim: false, sseConnected: true,
        testMeasurementOverride: cardHeights(120, 90),
        testLateProbeDuringFinalCommit: finalCommitHook,
        onStageChange,
      });
      for (let pass = 0; pass < 12; pass += 1) await tick();

      const root = view.container.querySelector<HTMLElement>(".standby")!;
      expect(lateProbe).toHaveBeenCalledOnce();
      expect(root.dataset.measurementSettled).toBe("true");
      expect(root.dataset.measurementNonconverged).toBe("false");
      expect(Number(root.dataset.measurementPass)).toBeLessThanOrEqual(5);
      expect(onStageChange).toHaveBeenCalledExactlyOnceWith(1);
      vi.advanceTimersByTime(SPRING_SPATIAL_DEFAULT_MS + 1);
      await tick();
      expect(JSON.parse(root.dataset.schedulerState ?? "{}")).toMatchObject({
        rotation: { epochHeld: false },
        paging: { epochHeld: false },
      });
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders exactly the tick-override rotation key and exposes scheduler diagnostics", async () => {
    for (const rotationTick of [0, 1, 4]) {
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: rotationItems }),
        now, dim: false, sseConnected: true, testMeasurementOverride: rotationStage, rotationTick,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      const root = view.container.querySelector<HTMLElement>(".standby")!;
      const keys = (root.dataset.rotationKeys ?? "").split(",").filter(Boolean);
      expect({ stage: root.dataset.ladderStage, keys }).toEqual({ stage: "3", keys: expect.arrayContaining([expect.any(String), expect.any(String)]) });
      expect(root.dataset.rotationActiveKey).toBe(keys[rotationTick % keys.length]);
      expect(root.dataset.rotationPosition).toBe(`${rotationTick % keys.length + 1}/${keys.length}`);
      expect(root.dataset.rotationIndicatorHeightPx).toBe("12");
      expect(root.dataset.rotationSlotHeightPx).toBe("52");
      expect(root.dataset.rotationCompactMaxHeightPx).toBe("40");
      expect(root.hasAttribute("data-rotation-viewport-footer-overlap-px")).toBe(true);
      expect(view.container.querySelectorAll('.rotation-card:not([hidden])')).toHaveLength(1);
      expect(view.container.querySelector<HTMLElement>('.rotation-card:not([hidden])')?.dataset.rotationCard).toBe(root.dataset.rotationActiveKey);
      expect(view.container.querySelector<HTMLElement>('[data-rotation-indicator]')?.textContent).toBe(root.dataset.rotationPosition);
      expect(view.container.querySelector<HTMLElement>('.rotation-card-viewport')?.style.minHeight).toBe("40px");
      expect(JSON.parse(root.dataset.schedulerState ?? "{}")).toMatchObject({ rotation: { timerActive: false } });
      view.unmount();
    }
  });

  it("uses the effective rotation key for both its indicator and visible card", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    expect(source).toContain("const effectiveRotationKey");
    expect(source).toContain("data-rotation-active-key={effectiveRotationKey ?? undefined}");
    expect(source).toContain("hidden={key !== effectiveRotationKey}");
  });

  it("performs a real stage-3 exit and releases the rotation resources", async () => {
    vi.useFakeTimers();
    try {
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: rotationItems }),
        now, dim: false, sseConnected: true, testMeasurementOverride: rotationStage,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      const firstRoot = view.container.querySelector<HTMLElement>(".standby")!;
      const firstActive = firstRoot.dataset.rotationActiveKey;
      vi.advanceTimersByTime(15_000);
      await tick();
      vi.advanceTimersByTime(0);
      await tick();
      expect(firstRoot.dataset.rotationActiveKey).not.toBe(firstActive);

      await view.rerender({
        snapshot: baseSnapshot({ latestQuake: latestQuake({ updatedAtMs: 2 }) }),
        now, dim: false, sseConnected: true,
        testMeasurementOverride: { ...rotationStage, layoutHeightPx: 10_000 },
      });
      for (let pass = 0; pass < 16; pass += 1) await tick();
      const exited = view.container.querySelector<HTMLElement>(".standby")!;
      expect(exited.dataset.ladderStage).toBe("0");
      expect(exited.dataset.rotationKeys).toBe("");
      expect(exited.dataset.rotationActiveKey).toBeUndefined();
      expect(JSON.parse(exited.dataset.schedulerState ?? "{}")).toMatchObject({ rotation: { timerActive: false, inFlight: false } });
      expect(view.container.querySelector(".rotation-slot")).toBeNull();
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a due rotation tick held through final commit and releases it after layout fallback", async () => {
    vi.useFakeTimers();
    try {
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()], standbyItems: rotationItems }),
        now, dim: false, sseConnected: true, testMeasurementOverride: rotationStage,
      });
      for (let pass = 0; pass < 8; pass += 1) await tick();
      const before = view.container.querySelector<HTMLElement>(".standby")?.dataset.rotationActiveKey;
      vi.advanceTimersByTime(TIME_SLICE_PERIOD_MS - 1);

      await view.rerender({
        snapshot: baseSnapshot({
          latestQuake: latestQuake({ updatedAtMs: 2, hypocenterName: "更新後の震源" }),
          weatherAlerts: [weather()],
          standbyItems: rotationItems,
        }),
        now, dim: false, sseConnected: true, testMeasurementOverride: rotationStage,
      });
      for (let pass = 0; pass < 12; pass += 1) await tick();
      const held = view.container.querySelector<HTMLElement>(".standby")!;
      expect(JSON.parse(held.dataset.schedulerState ?? "{}").rotation).toMatchObject({ epochHeld: true, tickPending: true });
      vi.advanceTimersByTime(1);
      await tick();
      expect(held.dataset.rotationActiveKey).toBe(before);

      vi.advanceTimersByTime(SPRING_SPATIAL_DEFAULT_MS);
      await tick();
      expect(held.dataset.rotationActiveKey).not.toBe(before);
      expect(JSON.parse(held.dataset.schedulerState ?? "{}").rotation).toMatchObject({ epochHeld: false, tickPending: false });
      // test-setup の WAAPI stub が即時 finish 用に所有する 0ms callback を消化する。
      vi.advanceTimersByTime(0);
      await tick();
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps exactly one clock owner while an upgrade and a same-content epoch are unsettled", async () => {
    const callbacks: number[] = [];
    let tickerOwnsClock = false;
    const stageOne = { ...cardHeights(120, 90), baselineGapPx: 10 };
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: stageOne,
      onStageChange: (nextStage: number) => { callbacks.push(nextStage); tickerOwnsClock = nextStage >= 1; },
    });
    const assertExclusive = () => {
      const centerOwnsClock = view.container.querySelector("[data-clock-landmark]") != null;
      expect(Number(centerOwnsClock) + Number(tickerOwnsClock)).toBe(1);
    };
    assertExclusive();
    for (let pass = 0; pass < 8; pass += 1) { await tick(); assertExclusive(); }
    expect(callbacks).toEqual([1]);

    await view.rerender({
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: { ...stageOne, layoutHeightPx: 141 },
      onStageChange: (nextStage: number) => { callbacks.push(nextStage); tickerOwnsClock = nextStage >= 1; },
    });
    window.dispatchEvent(new Event("resize"));
    assertExclusive();
    for (let pass = 0; pass < 8; pass += 1) { await tick(); assertExclusive(); }
    expect(callbacks).toEqual([1]);
  });

  it("holds the committed grid during settling, then switches plan and clock ownership together", async () => {
    const calm = { ...cardHeights(120, 90), layoutHeightPx: 250, baselineGapPx: 10 };
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: calm,
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(view.container.querySelector(".standby")?.getAttribute("data-ladder-stage")).toBe("0");
    expect(view.container.querySelector(".legacy-layout .weather-card")).toBeTruthy();

    await view.rerender({
      snapshot: baseSnapshot({ latestQuake: latestQuake({ updatedAtMs: 2 }), weatherAlerts: [weather({ updatedAt: "2026-08-20T12:01:00+09:00" })] }),
      now, dim: false, sseConnected: true, testMeasurementOverride: { ...calm, layoutHeightPx: 100 },
    });
    await tick();
    const unsettled = view.container.querySelector(".standby");
    expect(unsettled?.getAttribute("data-measurement-settled")).toBe("false");
    expect(unsettled?.getAttribute("data-ladder-stage")).toBe("0");
    expect(view.container.querySelector("[data-clock-landmark]")).toBeTruthy();
    expect(view.container.querySelector(".legacy-layout .weather-card")).toBeTruthy();

    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(view.container.querySelector(".standby")?.getAttribute("data-ladder-stage")).toBe("1");
    expect(view.container.querySelector("[data-clock-landmark]")).toBeNull();
    expect(view.container.querySelector(".center-card-region .weather-card")).toBeTruthy();
  });

  it("demotes only for content change after the strict two-gap hysteresis margin", async () => {
    const initial = { ...cardHeights(120, 90), baselineGapPx: 10 };
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }), now, dim: false, sseConnected: true,
      testMeasurementOverride: initial,
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(view.container.querySelector(".standby")?.getAttribute("data-ladder-stage")).toBe("1");

    await view.rerender({ snapshot: baseSnapshot({ latestQuake: latestQuake(), weatherAlerts: [weather()] }), now, dim: false, sseConnected: false, testMeasurementOverride: { ...initial, layoutHeightPx: 141 } });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(view.container.querySelector(".standby")?.getAttribute("data-ladder-stage")).toBe("1");

    await view.rerender({ snapshot: baseSnapshot({ latestQuake: latestQuake() }), now, dim: false, sseConnected: false, testMeasurementOverride: { ...initial, layoutHeightPx: 141 } });
    for (let pass = 0; pass < 16; pass += 1) await tick();
    const finalRoot = view.container.querySelector(".standby");
    expect({
      ladder: finalRoot?.getAttribute("data-ladder-stage"),
      solver: finalRoot?.getAttribute("data-solver-stage"),
      settled: finalRoot?.getAttribute("data-measurement-settled"),
      nonconverged: finalRoot?.getAttribute("data-measurement-nonconverged"),
    }).toEqual({ ladder: "0", solver: "0", settled: "true", nonconverged: "false" });
  });


  it("opens a measurement epoch when only the connection badge visibility changes", async () => {
    const view = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuake() }), now, dim: false, sseConnected: true,
      testMeasurementOverride: cardHeights(120, 90),
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const before = view.container.querySelector(".standby")?.getAttribute("data-measurement-epoch");
    await view.rerender({ snapshot: baseSnapshot({ latestQuake: latestQuake() }), now, dim: false, sseConnected: false, testMeasurementOverride: cardHeights(120, 90) });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(view.container.querySelector(".standby")?.getAttribute("data-measurement-epoch")).not.toBe(before);
  });
});

describe("StandbyScreen prefix probes and fixed-center geometry", () => {
  it("weatherExpandedKinds の candidateTruncated をカードのページ表示へ渡す", async () => {
    const alert = weather({
      role: "weatherWarning",
      items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: ["宮崎市"], omittedAreaCount: 0,
      }],
    });
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({
        weatherAlerts: [alert],
        weatherExpandedKinds: [{
          kindKey: "warning|heavy-rain", areas: ["宮崎市"], totalAreaCount: 2, candidateTruncated: true,
        }],
      }),
      now, dim: false, sseConnected: true,
      testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10 },
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const card = container.querySelector<HTMLElement>(".legacy-layout .weather-card");
    expect(card?.dataset.cardPageTruncated).toBe("true");
    expect(card?.querySelector("[data-card-page-indicator]")?.textContent).toBe("1/1");
    const shell = card?.closest<HTMLElement>(".legacy-card");
    expect(shell?.classList.contains("paged-card")).toBe(true);
    expect(shell?.dataset.cardPageFixedHeight).toBeTruthy();
    expect(shell?.style.height).toBe(`${shell?.dataset.cardPageFixedHeight}px`);
  });

  it("weather 改ページの外殻矩形高はページ間で測定済み自然高に固定される", async () => {
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.classList.contains("paged-card")) {
        const height = Number.parseFloat(this.style.height);
        return { x: 0, y: 0, top: 0, right: 300, bottom: height, left: 0, width: 300, height, toJSON() {} } as DOMRect;
      }
      return originalRect.call(this);
    };
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const pageFitOverrides = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        [`weather:page-fit:${index}:${index + 1}:placement:side`, 0],
        ...(index < 8 ? [[`weather:page-fit:${index}:${index + 2}:placement:side`, 2]] : []),
      ]).flat(),
    );
    const testMeasurementOverride = {
      layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10,
      "weather:compact:right": 77, "weather:expanded:right": 88, "weather:full:right": 88,
      // Weather prefix end is rendered-area count (current + B additions),
      // so the 9-area final page must receive the same measured fixed height.
      ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`weather:prefix:${index + 1}:side`, 133])),
      ...pageFitOverrides,
    };
    async function pageShell(cardPageTick: number) {
      const view = render(StandbyScreen, {
        snapshot: baseSnapshot({ weatherAlerts: [weather({ items: [{
          kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
          shownAreas: ["地域1"], omittedAreaCount: 8,
        }] })], weatherExpandedKinds: [{
          kindKey: "warning|heavy-rain", areas: Array.from({ length: 9 }, (_, index) => `地域${index + 1}`), totalAreaCount: 9, candidateTruncated: false,
        }] }),
        now, dim: false, sseConnected: true, cardPageTick, testMeasurementOverride,
      });
      for (let pass = 0; pass < 24; pass += 1) await tick();
      const card = view.container.querySelector<HTMLElement>(".legacy-layout .weather-card")!;
      const shell = card.closest<HTMLElement>(".legacy-card")!;
      const expanded = JSON.parse(view.container.querySelector(".standby")?.getAttribute("data-expanded-counts") ?? "{}") as { weather?: Record<string, { count: number }> };
      const result = { page: card.dataset.cardPage, fixedHeight: shell.dataset.cardPageFixedHeight, rectHeight: shell.getBoundingClientRect().height, selectedCount: expanded.weather?.["大雨警報"]?.count };
      view.unmount();
      return result;
    }
    try {
      const first = await pageShell(0);
      const second = await pageShell(1);
      expect(first.page).toMatch(/^1\/[2-9]$/);
      expect(second.page).toBe(first.page?.replace(/^1\//, "2/"));
      expect(first.selectedCount).toBe(9);
      expect(first.fixedHeight).toBe("133");
      expect(second.fixedHeight).toBe("133");
      expect(second.rectHeight).toBe(first.rectHeight);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      vi.unstubAllGlobals();
    }
  });

  it("weather shelf の forced measurementRange は一候補だけを描画する", async () => {
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    try {
      const { container } = render(StandbyScreen, {
        snapshot: baseSnapshot({ weatherAlerts: [weather({ items: [{
          kind: "大雨警報", displaySeverity: "warning", rank: "warning",
          shownAreas: ["先頭地域", "後続地域"], omittedAreaCount: 0,
        }] })] }),
        now, dim: false, sseConnected: true,
        testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10 },
      });
      for (let pass = 0; pass < 16; pass += 1) await tick();
      const probe = Array.from(container.querySelectorAll<HTMLElement>("[data-prefix-measure]"))
        .find((node) => node.dataset.prefixMeasure?.startsWith("weather:page-fit:0:1"));
      expect(probe).toBeTruthy();
      expect(probe?.querySelector("[data-page-probe-body]")?.textContent).toContain("先頭地域");
      expect(probe?.querySelector("[data-page-probe-body]")?.textContent).not.toContain("後続地域");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fixed-height に収まらない page range は専用棚 body を実測して infeasible にする", async () => {
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-card]") ? 100 : this.matches("[data-page-probe-body]") ? 10 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-body]") ? 100 : this.matches("[data-page-probe-card]") ? 100 : 0; },
    });
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-body]") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-body]") ? 100 : 0; },
    });
    try {
      const quake = latestQuake({ intensityGroups: [{
        intensity: "5弱", rank: 5, areas: ["A"], omittedAreaCount: 1, expandedAreas: ["A", "B"],
      }] });
      const { container } = render(StandbyScreen, {
        snapshot: baseSnapshot({ latestQuake: quake }), now, dim: false, sseConnected: true,
        testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10 },
      });
      for (let pass = 0; pass < 16; pass += 1) await tick();
      const probe = container.querySelector<HTMLElement>("[data-page-probe='true']");
      expect(probe?.querySelector("[data-page-probe-body]")).toBeTruthy();
      expect(probe?.querySelector<HTMLElement>("[data-page-probe-body]")?.scrollHeight).toBeGreaterThan(
        probe?.querySelector<HTMLElement>("[data-page-probe-body]")?.clientHeight ?? 0,
      );
      const ids = Array.from(container.querySelectorAll<HTMLElement>("[data-prefix-measure]")).map((node) => node.dataset.prefixMeasure ?? "");
      expect(ids.some((id) => id.startsWith("quake:prefix:"))).toBe(true);
      expect(ids.some((id) => id.startsWith("quake:page-fit:"))).toBe(true);
      expect(container.querySelector<HTMLElement>(".legacy-layout .quake-card")?.dataset.cardPageInfeasible).toBe("true");
    } finally {
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      if (clientWidth == null) delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      else Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      if (scrollWidth == null) delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      else Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
      vi.unstubAllGlobals();
    }
  });

  it("weather の2列目以降の横あふれは page range を fit と誤判定しない", async () => {
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-card], [data-page-probe-readable]") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-card]") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-body]") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-body]") ? 200 : 0; },
    });
    try {
      const { container } = render(StandbyScreen, {
        snapshot: baseSnapshot({ weatherAlerts: [weather({ items: [{
          kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["A"], omittedAreaCount: 1,
        }] })] }),
        now, dim: false, sseConnected: true,
        testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10 },
      });
      for (let pass = 0; pass < 16; pass += 1) await tick();
      const probeBody = container.querySelector<HTMLElement>("[data-page-probe-body]");
      expect(probeBody?.scrollWidth).toBeGreaterThan(probeBody?.clientWidth ?? 0);
      expect(container.querySelector<HTMLElement>(".legacy-layout .weather-card")?.dataset.cardPageInfeasible).toBe("true");
    } finally {
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      if (clientWidth == null) delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      else Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      if (scrollWidth == null) delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      else Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
      vi.unstubAllGlobals();
    }
  });

  it("全無寸法の probe は layoutless fallback として fit にする", async () => {
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(): number { return 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(): number { return 0; },
    });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    try {
      const { container } = render(StandbyScreen, {
        snapshot: baseSnapshot({ weatherAlerts: [weather({ items: [{
          kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["A"], omittedAreaCount: 1,
        }] })] }),
        now, dim: false, sseConnected: true,
        testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10 },
      });
      for (let pass = 0; pass < 16; pass += 1) await tick();
      const card = container.querySelector<HTMLElement>(".legacy-layout .weather-card");
      // 方針転換: card root を含む全 probe が無寸法の jsdom 棚だけは
      // layoutless fallback として fit へ収束させる。
      expect(card?.dataset.cardPagePending).toBe("false");
      expect(card?.dataset.cardPageInfeasible).toBe("false");
    } finally {
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (clientWidth == null) delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      else Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      vi.unstubAllGlobals();
    }
  });

  it("本文だけの縦あふれも page range を fit と誤判定しない", async () => {
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return this.matches("[data-page-probe-card], [data-page-probe-body]") ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return this.matches("[data-page-probe-body]") ? 200 : this.matches("[data-page-probe-card]") ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-body]") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement): number { return this.matches("[data-page-probe-body]") ? 100 : 0; },
    });
    try {
      const { container } = render(StandbyScreen, {
        snapshot: baseSnapshot({ weatherAlerts: [weather({ items: [{
          kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["A"], omittedAreaCount: 1,
        }] })] }),
        now, dim: false, sseConnected: true,
        testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10 },
      });
      for (let pass = 0; pass < 16; pass += 1) await tick();
      const body = container.querySelector<HTMLElement>("[data-page-probe-body]");
      expect(body?.scrollHeight).toBeGreaterThan(body?.clientHeight ?? 0);
      expect(body?.scrollWidth).toBe(body?.clientWidth);
      expect(container.querySelector<HTMLElement>(".legacy-layout .weather-card")?.dataset.cardPageInfeasible).toBe("true");
    } finally {
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      if (clientWidth == null) delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      else Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      if (scrollWidth == null) delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      else Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
      vi.unstubAllGlobals();
    }
  });

  it("measures every B prefix and selects a later fit after a non-monotonic overflow", async () => {
    const quake = latestQuake({ intensityGroups: [{ intensity: "5弱", rank: 5, areas: ["A"], omittedAreaCount: 3, expandedAreas: ["A", "B", "C", "D"] }] });
    const testMeasurementOverride = {
      layoutWidthPx: 1280, layoutHeightPx: 120, baselineGapPx: 10,
      "quake:compact:right": 20, "quake:expanded:right": 80, "quake:full:right": 80,
      "quake:compact:center": 20, "quake:expanded:center": 80, "quake:full:center": 80,
      "quake:prefix:1:side": 60,
      "quake:prefix:2:side": 130,
      "quake:prefix:3:side": 80,
    };
    const { container } = render(StandbyScreen, { snapshot: baseSnapshot({ latestQuake: quake }), now, dim: false, sseConnected: true, testMeasurementOverride });
    for (let pass = 0; pass < 12; pass += 1) await tick();
    const root = container.querySelector(".standby")!;
    expect(root.getAttribute("data-measurement-settled")).toBe("true");
    expect(root.getAttribute("data-prefix-probe-count")).toBe("3");
    expect(container.querySelectorAll('[data-prefix-measure*="placement:side"]')).toHaveLength(3);
    const counts = JSON.parse(root.getAttribute("data-expanded-counts") ?? "{}") as { quake?: { count: number; n: number } };
    expect(counts.quake).toEqual({ count: 4, n: 0 });
    expect(container.querySelector(".legacy-layout")?.textContent).toContain("D");
  });

  // 129件の実組版は環境ごとに所要時間が揺れる。性能退行は下記の settle/pass 上限で検出する。
  it("normalizes 128 quake and weather prefixes to two side probe sets within the settle bound", async () => {
    const areas = Array.from({ length: 129 }, (_, index) => `地域${index + 1}`);
    const quake = latestQuake({ intensityGroups: [{ intensity: "5弱", rank: 5, areas: [areas[0]!], omittedAreaCount: 128, expandedAreas: areas }] });
    const alert = weather({ items: [{ kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "officialL3", rank: "warning", shownAreas: [areas[0]!], omittedAreaCount: 128 }] });
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: quake, weatherAlerts: [alert], weatherExpandedKinds: [{ kindKey: "officialL3|heavy-rain", areas, totalAreaCount: 129, candidateTruncated: false }] }),
      now, dim: false, sseConnected: true,
      testMeasurementOverride: { layoutWidthPx: 1280, layoutHeightPx: 10_000, baselineGapPx: 10 },
    });
    for (let pass = 0; pass < 16; pass += 1) await tick();
    const root = container.querySelector(".standby")!;
    expect(root.getAttribute("data-measurement-settled")).toBe("true");
    expect(root.getAttribute("data-measurement-nonconverged")).toBe("false");
    expect(root.getAttribute("data-prefix-probe-count")).toBe("256");
    expect(container.querySelectorAll('[data-prefix-measure*="placement:side"]')).toHaveLength(256);
    expect(container.querySelectorAll('[data-prefix-measure*="placement:left"], [data-prefix-measure*="placement:right"]')).toHaveLength(0);
  }, 15_000);

  it("uses the ticker-edge fallback for three equal calm intervals without shifting the clock for connection state", async () => {
    const stats = { sparklineData: [1], totalReceived: 1, todayQuakeCount: 1, todayMaxInt: null, todayMaxIntRank: null };
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ stats, recentQuakes: [recent], connection: { dmdata: "disconnected", lastReceivedAt: null, disconnectedSince: "t", reason: "timeout" } }),
      now, dim: false, sseConnected: true,
      testMeasurementOverride: { boundaryTopPx: 500, clockBottomPx: 200, statsHeightPx: 30, recentHeightPx: 60, connectionHeightPx: 24 },
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    const style = container.querySelector<HTMLElement>(".standby")?.getAttribute("style") ?? "";
    expect(style).toContain("--cluster-gap: 70px");
    expect(style).toContain("--cluster-flow-height: 160px");
    expect(container.querySelector(".clock-wrap > .clock-face > .clock")).toBeTruthy();
    expect(container.querySelector(".clock-wrap > .clock-connection")).toBeTruthy();
  });

  it("includes connection, stats, recent rows, and their gaps in fixed-center capacity", async () => {
    const stats = { sparklineData: [1], totalReceived: 1, todayQuakeCount: 1, todayMaxInt: null, todayMaxIntRank: null };
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ stats, recentQuakes: [recent], connection: { dmdata: "disconnected", lastReceivedAt: null, disconnectedSince: "t", reason: "timeout" } }),
      now, dim: false, sseConnected: true,
      testMeasurementOverride: { layoutHeightPx: 500, statsHeightPx: 20, recentHeightPx: 30, connectionHeightPx: 10, baselineGapPx: 10, gapPx: 10 },
    });
    for (let pass = 0; pass < 8; pass += 1) await tick();
    expect(container.querySelector(".standby")?.getAttribute("data-center-natural-height-px")).toBe("80");
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    expect(source).toMatch(/\.rotation-failure-measure[^}]*box-sizing: border-box[^}]*border: 1px solid/);
    expect(source).toMatch(/\.clock-below[^}]*gap: var\(--cluster-gap\)/);
  });
});

describe("StandbyScreen replay exclusivity with normal motion", () => {
  it("never renders latest and replay together while motion is enabled", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try {
      const { container } = render(StandbyScreen, { snapshot: baseSnapshot({ latestQuake: latestQuake(), recentQuakes: [recent] }), now, dim: false, sseConnected: true });
      const row = container.querySelector<HTMLButtonElement>(".quakes-card button.row")!;
      row.click();
      await tick();
      expect(container.querySelectorAll(".corner-left .quake-card, .corner-left .quake-replay-card")).toHaveLength(1);
      expect(container.querySelector(".corner-left .quake-replay-card")).toBeTruthy();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("StandbyScreen replay identity and timer lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const renderReplay = (recentQuakes: DisplayRecentQuakeV1[]) => render(StandbyScreen, { snapshot: baseSnapshot({ recentQuakes }), now, dim: false, sseConnected: true });
  const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>(".quakes-card button.row"));

  it("restarts the 20-second baseline when a different item is selected", async () => {
    const { container } = renderReplay([recent, { ...recent, eventId: "q-2", hypocenterName: "浦河沖" }]);
    rows(container)[0]?.click(); await tick();
    vi.advanceTimersByTime(15_000);
    rows(container)[1]?.click(); await tick();
    vi.advanceTimersByTime(5_000); await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("浦河沖");
    vi.advanceTimersByTime(15_000); await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("does not restart a replay timer for a correction of the selected event", async () => {
    const { container, rerender } = renderReplay([recent]);
    rows(container)[0]?.click(); await tick();
    vi.advanceTimersByTime(15_000);
    await rerender({ snapshot: baseSnapshot({ recentQuakes: [{ ...recent, hypocenterName: "訂正後" }] }), now, dim: false, sseConnected: true });
    vi.advanceTimersByTime(5_000); await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("disposes a pending replay timer on unmount", async () => {
    const view = renderReplay([recent]);
    rows(view.container)[0]?.click(); await tick();
    view.unmount();
    vi.advanceTimersByTime(20_000);
    expect(view.container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("follows an eventId-null selection by its fallback identity", async () => {
    const nullId = { ...recent, eventId: null };
    const { container, rerender } = renderReplay([nullId]);
    rows(container)[0]?.click(); await tick();
    await rerender({ snapshot: baseSnapshot({ recentQuakes: [{ ...nullId, depth: "30km" }] }), now, dim: false, sseConnected: true });
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("30km");
  });

  it("closes a fallback selection when a later report supplies eventId", async () => {
    const nullId = { ...recent, eventId: null };
    const { container, rerender } = renderReplay([nullId]);
    rows(container)[0]?.click(); await tick();
    await rerender({ snapshot: baseSnapshot({ recentQuakes: [{ ...nullId, eventId: "q-later" }] }), now, dim: false, sseConnected: true });
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });
});
