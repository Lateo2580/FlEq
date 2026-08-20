import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import StandbyScreen from "../StandbyScreen.svelte";
import { baseSnapshot } from "../../lib/__tests__/fixtures";
import type { ActiveStandbyCardV1, DisplayLatestQuakeStateV1, DisplayRecentQuakeV1, DisplayTsunamiStateV1, DisplayTyphoonV1, DisplayWeatherAlertV1 } from "../../lib/protocol";

const now = new Date("2026-08-20T12:00:00+09:00");
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

describe("StandbyScreen legacy-improved skeleton", () => {
  it("renders the fixed three-column grid, viewport clock landmark, and no outer paging", () => {
    const { container } = render(StandbyScreen, { snapshot: baseSnapshot(), now, dim: false, sseConnected: true });
    const root = container.querySelector(".standby");
    expect(root?.getAttribute("data-outer-paging")).toBe("none");
    expect(root?.querySelector(".legacy-layout")).toBeTruthy();
    expect(root?.querySelectorAll(".legacy-layout > .side")).toHaveLength(2);
    expect(root?.querySelector("[data-clock-landmark] .clock-wrap")).toBeTruthy();
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
    for (const name of ["data-left-capacity-px", "data-right-capacity-px", "data-center-capacity-px", "data-left-natural-height-px", "data-right-natural-height-px", "data-center-natural-height-px"]) {
      expect(root.hasAttribute(name)).toBe(true);
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
    { stage: 3, override: cardHeights(120, 55, 120, 55), items: [typhoon()] as ActiveStandbyCardV1[] },
  ] as const;

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
  });

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
