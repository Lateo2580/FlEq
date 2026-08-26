import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, within } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushSync } from "svelte";
import QuakeMap from "../QuakeMap.svelte";
import QuakePanel from "../QuakePanel.svelte";
import QuakeMapScreen from "../QuakeMapScreen.svelte";
import type {
  DisplayIntensitySemanticV1,
  DisplayLargeQuakeInputV1,
  DisplayQuakeMapEventV1,
} from "../../lib/protocol";
import {
  prefetchQuakeMapAsset,
  resetQuakeMapLoaderForTest,
} from "../../lib/quake-map-loader";
import { PAGE_HOLD_MS } from "../../lib/page-cycler.svelte";
import { expectCurrentDot } from "./page-dots-test-utils";

function asset(over: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    projectionInsetsVersion: "jma-quake-projection-insets-v1",
    dataset: "AreaForecastLocalE",
    codeType: "code",
    viewBox: [0, 0, 1000, 800],
    pathsByCode: {
      "440": "M0,0L10,0L10,10Z",
      "441": "M10,0L20,0L20,10Z",
      "442": "M20,0L30,0L30,10Z",
    },
    insets: [{
      id: "okinawa",
      label: "沖縄・先島",
      frame: [40, 600, 360, 170],
      labelPosition: [52, 632],
    }],
    ...over,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function semantic(over: Partial<DisplayIntensitySemanticV1>): DisplayIntensitySemanticV1 {
  return {
    raw: "4",
    presence: "value",
    label: "4",
    condition: null,
    description: null,
    lowerBound: null,
    upperBound: null,
    rawLowerBound: null,
    rawUpperBound: null,
    badge: null,
    color: "normalRank",
    render: true,
    safetyLowerRank: 4,
    safetyUpperRank: 4,
    safetyRank: 4,
    colorRank: 4,
    ...over,
  };
}

function mapEvent(over: Partial<DisplayQuakeMapEventV1> = {}): DisplayQuakeMapEventV1 {
  return {
    eventKey: "earthquake:Q1",
    eventId: "Q1",
    sourceType: "VXSE53",
    revision: { reportTimeMs: 100, serial: "2" },
    reportDateTime: "2026-07-30T12:00:00+09:00",
    originTime: "2026-07-30T11:58:00+09:00",
    hypocenterName: "静岡県東部",
    depth: "10km",
    magnitude: "5.2",
    maxInt: "5弱",
    maxIntRank: 5,
    tsunamiWarning: false,
    intensityGroups: [{ intensity: "5弱", rank: 5, areas: ["静岡県東部"], omittedAreaCount: 0 }],
    localAreas: [{ code: "440", rank: 5 }],
    updatedAtMs: 100,
    ...over,
  };
}

function panelInput(over: Partial<DisplayLargeQuakeInputV1> = {}): DisplayLargeQuakeInputV1 {
  return {
    kind: "largeQuake",
    eventId: "Q1",
    originTime: "2026-07-30T11:58:00+09:00",
    hypocenterName: "静岡県東部",
    magnitude: "5.2",
    maxInt: "5弱",
    maxIntRank: 5,
    intensityGroups: [{ intensity: "5弱", rank: 5, areas: ["静岡県東部"], omittedAreaCount: 0 }],
    reportDateTime: "2026-07-30T12:00:00+09:00",
    depth: "10km",
    maxLgInt: null,
    tsunamiWarning: true,
    mapEventKey: "earthquake:Q1",
    mapSourceType: "VXSE53",
    mapRevision: { reportTimeMs: 100, serial: "2" },
    ...over,
  };
}

afterEach(() => {
  resetQuakeMapLoaderForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("QuakeMap", () => {
  it("取得中を表示し、成功後は全区域・rank class・未観測/未知・inset・出典・ariaを描画する", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn((_input: string | URL) => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = mapEvent({
      localAreas: [
        { code: "440", rank: 5 },
        { code: "441", rank: 99 },
        { code: "999", rank: 6 },
      ],
    });
    const { container } = render(QuakeMap, { event });
    expect(container.querySelector(".quake-map-loading")?.textContent).toContain("準備");

    resolveFetch(response(asset()));
    await waitFor(() => expect(container.querySelectorAll(".quake-region")).toHaveLength(3));
    expect(container.querySelector('[data-code="440"]')?.classList.contains("quake-map-rank-5")).toBe(true);
    expect(container.querySelector('[data-code="441"]')?.classList.contains("quake-map-unknown")).toBe(true);
    expect(container.querySelector('[data-code="442"]')?.classList.contains("quake-map-unobserved")).toBe(true);
    expect(container.querySelector(".quake-map")?.getAttribute("data-unmatched-count")).toBe("1");
    expect(container.querySelector(".inset-label")?.textContent).toBe("沖縄・先島");
    expect(container.querySelector("figcaption")?.textContent).toContain("出典: 気象庁");
    expect(container.querySelector("svg")?.getAttribute("aria-label"))
      .toBe("地震情報、最大震度5弱、全国の震度分布");
    const svg = within(container).getByRole("group", {
      name: "地震情報、最大震度5弱、全国の震度分布",
    });
    const exactPath = within(svg).getByRole("img", { name: "地域コード440、震度5弱" });
    expect(exactPath?.getAttribute("aria-hidden")).toBe("false");
    expect(exactPath?.querySelector("title")?.textContent).toBe("地域コード440、震度5弱");
    expect(exactPath?.parentElement?.closest('[role="img"]')).toBeNull();
    expect(container.querySelector(".legend-swatch.quake-map-rank-5")?.getAttribute("style"))
      .toContain("background: var(--int-5)");
    expect(container.querySelector(".legend-swatch.quake-map-unknown")?.getAttribute("style"))
      .toContain("background: var(--c-raspberry)");
    expect(container.querySelector(".legend-swatch.quake-map-neutral")?.getAttribute("style"))
      .toContain("background: var(--surface-highest)");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("999"));
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("area-information-city-quake");
  });

  it("地域名ではなく code 完全一致だけで rank を結合する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));
    const event = mapEvent({
      hypocenterName: "asset に存在しない地名",
      intensityGroups: [{
        intensity: "5弱",
        rank: 5,
        areas: ["境界 asset と無関係な地域名"],
        omittedAreaCount: 0,
      }],
      localAreas: [{ code: "441", rank: 7 }],
    });
    const { container } = render(QuakeMap, { event });
    await waitFor(() => expect(container.querySelector('[data-code="441"]')).toBeTruthy());
    expect(container.querySelector('[data-code="441"]')?.classList.contains("quake-map-rank-7")).toBe(true);
    expect(container.querySelector('[data-code="440"]')?.classList.contains("quake-map-unobserved")).toBe(true);
  });

  it("特殊値を色と SVG badge へ重畳し、凡例・tooltip・aria に意味を残す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(asset({
      pathsByCode: {
        "440": "M0,0L10,0L10,10Z",
        "441": "M10,0L20,0L20,10Z",
        "442": "M20,0L30,0L30,10Z",
        "443": "M30,0L40,0L40,10Z",
      },
    }))));
    const lower = semantic({
      raw: "5弱以上未入電", presence: "qualitative", label: "5弱以上（未入電）",
      condition: "5弱以上未入電", lowerBound: "5-", badge: "≥", color: "safetyRank",
      safetyLowerRank: 5, safetyUpperRank: null, safetyRank: 5, colorRank: 5,
    });
    const unknown = semantic({
      raw: "未入電", presence: "unknown", label: "不明（未入電）", condition: "未入電",
      badge: "?", color: "unknown", safetyLowerRank: null, safetyUpperRank: null,
      safetyRank: null, colorRank: null,
    });
    const empty = semantic({
      raw: "", presence: "empty", label: "空欄", badge: "∅", color: "neutral",
      safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const missing = semantic({
      raw: null, presence: "missing", label: null, badge: null, color: "notRendered",
      render: false, safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(QuakeMap, { event: mapEvent({
      localAreas: [
        { code: "440", rank: 5, intensitySemantic: lower },
        { code: "441", rank: -1, intensitySemantic: unknown },
        { code: "442", rank: -1, intensitySemantic: empty },
        { code: "443", rank: -1, intensitySemantic: missing },
      ],
    }) });

    await waitFor(() => expect(container.querySelectorAll(".quake-region")).toHaveLength(4));
    expect(container.querySelector('[data-code="440"]')?.classList.contains("quake-map-rank-5")).toBe(true);
    expect(container.querySelector('[data-badge-code="440"]')?.getAttribute("data-badge")).toBe("≥");
    expect(container.querySelector('[data-badge-code="440"] circle')?.getAttribute("r")).toBe("17");
    expect(container.querySelector('[data-badge-code="440"] text')?.getAttribute("font-size")).toBe("24");
    expect(container.querySelector('[data-code="441"]')?.classList.contains("quake-map-unknown")).toBe(true);
    expect(container.querySelector('[data-badge-code="441"]')?.textContent).toBe("?");
    expect(container.querySelector('[data-code="442"]')?.classList.contains("quake-map-neutral")).toBe(true);
    expect(container.querySelector('[data-badge-code="442"]')?.textContent).toBe("∅");
    expect(container.querySelector('[data-code="443"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-badge-code="443"]')).toBeNull();
    expect(container.querySelector('[data-code="440"] title')?.textContent).toContain("以上（下限値）");
    expect(container.querySelector('[data-code="441"] title')?.textContent)
      .toBe("地域コード441、震度不明（未入電）、記号 ?: 不明、理由: 未入電");
    expect(container.querySelector('[data-code="441"]')?.getAttribute("aria-label"))
      .toBe("地域コード441、震度不明（未入電）、記号 ?: 不明、理由: 未入電");
    expect(container.querySelector(".quake-map-legend")?.textContent).toContain("≥以上（下限値）");
    expect(container.querySelector(".quake-map-legend")?.textContent).toContain("↔範囲");
  });

  it("reduced-motion 下でも全区域を描画し、fill transition だけを無効化する", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList)));
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));

    const { container } = render(QuakeMap, { event: mapEvent() });
    await waitFor(() => expect(container.querySelectorAll(".quake-region")).toHaveLength(3));
    expect(container.querySelector(".quake-map-svg")).toBeTruthy();
    expect(container.querySelector('[data-code="440"]')?.classList.contains("quake-map-rank-5")).toBe(true);

    const source = readFileSync(join(__dirname, "..", "QuakeMap.svelte"), "utf8");
    expect(source).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.quake-region\s*\{\s*transition: none;/,
    );
  });

  it("続報の rank 更新で path node と d を維持し、class だけを更新する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));
    const { container, rerender } = render(QuakeMap, { event: mapEvent() });
    await waitFor(() => expect(container.querySelector('[data-code="440"]')).toBeTruthy());
    const path = container.querySelector('[data-code="440"]')!;
    const d = path.getAttribute("d");

    await rerender({ event: mapEvent({ localAreas: [{ code: "440", rank: 6 }] }) });
    await waitFor(() => expect(path.classList.contains("quake-map-rank-6")).toBe(true));
    expect(container.querySelector('[data-code="440"]')).toBe(path);
    expect(path.getAttribute("d")).toBe(d);
  });

  it("取得失敗・schema mismatch は例外を漏らさず非地図表示へ縮退する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 503)));
    const failed = render(QuakeMap, { event: mapEvent() });
    await waitFor(() => expect(failed.container.querySelector(".quake-map-fallback")).toBeTruthy());
    failed.unmount();

    resetQuakeMapLoaderForTest();
    vi.stubGlobal("fetch", vi.fn(async () => response(asset({ schemaVersion: 2 }))));
    const invalid = render(QuakeMap, { event: mapEvent() });
    await waitFor(() => expect(invalid.container.querySelector(".quake-map-fallback")).toBeTruthy());
  });
});

describe("QuakePanel map integration", () => {
  it("主パネルは地図と既存文字一覧を同時表示する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));
    const { container } = render(QuakePanel, { input: panelInput(), mapEvent: mapEvent() });
    await waitFor(() => expect(container.querySelector(".quake-map-svg")).toBeTruthy());
    expect(container.querySelector(".tile-groups .pref-name")?.textContent).toBe("静岡県");
    expect(container.querySelector(".tile-groups .city-name")?.textContent).toBe("東部");
    expect(container.querySelector(".hypocenter")?.textContent).toBe("静岡県東部");
    expect(container.querySelector(".tsunami-mark")?.textContent).toBe("津波");
  });

  it("地震カードへ最大値と地域別 qualifier/badge を貫通させる", () => {
    const lower = semantic({
      raw: "5弱以上未入電", presence: "qualitative", label: "5弱以上（未入電）",
      condition: "5弱以上未入電", lowerBound: "5-", badge: "≥", color: "safetyRank",
      safetyLowerRank: 5, safetyUpperRank: null, safetyRank: 5, colorRank: 5,
    });
    const empty = semantic({
      raw: "", presence: "empty", label: "空欄", badge: "∅", color: "neutral",
      safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(QuakePanel, { input: panelInput({
      maxInt: "", maxIntRank: 5, maxIntSemantic: lower,
      intensityGroups: [{ intensity: "空欄", rank: -1, intensitySemantic: empty, areas: ["静岡県東部"], omittedAreaCount: 0 }],
    }), mapEvent: null });
    expect(container.querySelector(".max-int")?.textContent).toContain("最大震度5弱以上（未入電）≥");
    const group = container.querySelector(".int-chip");
    expect(group?.textContent).toBe("空欄∅");
    expect(group?.classList.contains("special-empty")).toBe(true);
    expect(group?.getAttribute("title")).toContain("空欄");
  });

  it("QuakePanel でも semantic missing は旧 scalar 最大値・地域行を復活させない", () => {
    const missing = semantic({
      raw: null, presence: "missing", label: null, badge: null, color: "notRendered",
      render: false, safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(QuakePanel, { input: panelInput({
      maxInt: "7", maxIntRank: 9, maxIntSemantic: missing,
      intensityGroups: [
        { intensity: "4", rank: 4, areas: ["静岡県東部"], omittedAreaCount: 0 },
        { intensity: "7", rank: 9, intensitySemantic: missing, areas: ["地域欠落"], omittedAreaCount: 0 },
      ],
    }), mapEvent: null });
    expect(container.querySelector(".max-int")).toBeNull();
    expect(container.querySelector(".heading")?.classList.contains("critical")).toBe(false);
    expect(container.querySelectorAll(".tile-groups .group")).toHaveLength(1);
    expect(container.textContent).not.toContain("地域欠落");
    expect(container.textContent).not.toContain("最大震度7");
  });

  it("prefetch と表示時 fallback が連続失敗しても既存文字一覧を維持する", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("prefetch offline"))
      .mockRejectedValueOnce(new Error("display offline"));
    vi.stubGlobal("fetch", fetchMock);

    await prefetchQuakeMapAsset();
    const { container } = render(QuakePanel, { input: panelInput(), mapEvent: mapEvent() });
    await waitFor(() => expect(container.querySelector(".quake-map-fallback")).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".heading-text")?.textContent).toBe("地震情報");
    expect(container.querySelector(".hypocenter")?.textContent).toBe("静岡県東部");
    expect(container.querySelector(".tile-groups .pref-name")?.textContent).toBe("静岡県");
    expect(container.querySelector(".tile-groups .city-name")?.textContent).toBe("東部");
  });

  it("地図併設中も既存文字一覧のページングを継続する", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));
    const areas = Array.from({ length: 35 }, (_, index) => `高知県市町村${index}`);
    const { container } = render(QuakePanel, {
      input: panelInput({
        intensityGroups: [{ intensity: "5弱", rank: 5, areas, omittedAreaCount: 0 }],
      }),
      mapEvent: mapEvent(),
    });

    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(container.querySelector(".quake-map-svg")).toBeTruthy();
    expectCurrentDot(container.querySelector(".tile-page-detail"), 1, 3);

    vi.advanceTimersByTime(PAGE_HOLD_MS);
    flushSync();
    vi.advanceTimersByTime(1_000);
    flushSync();
    expectCurrentDot(container.querySelector(".tile-page-detail"), 2, 3);
    expect(container.querySelector(".quake-map-svg")).toBeTruthy();
  });

  it("compact=true では地図を描画・fetch せず、既存文字表示を維持する", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(QuakePanel, {
      input: panelInput(),
      mapEvent: mapEvent(),
      compact: true,
    });
    expect(container.querySelector(".quake-map")).toBeNull();
    expect(container.querySelector(".tile-groups .pref-name")?.textContent).toBe("静岡県");
    expect(container.querySelector(".tile-groups .city-name")?.textContent).toBe("東部");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mapEvent 欠落でも見出し・概要・文字一覧を従来どおり維持する", () => {
    const { container } = render(QuakePanel, { input: panelInput(), mapEvent: null });
    expect(container.querySelector(".quake-map")).toBeNull();
    expect(container.querySelector(".heading-text")?.textContent).toBe("地震情報");
    expect(container.querySelector(".max-int")?.textContent).toContain("最大震度5-");
    expect(container.querySelector(".tile-groups .pref-name")?.textContent).toBe("静岡県");
    expect(container.querySelector(".tile-groups .city-name")?.textContent).toBe("東部");
  });
});

describe("QuakeMapScreen", () => {
  it("非緊急全国図の「ごく浅い」を距離へ置換しない", () => {
    const { container } = render(QuakeMapScreen, {
      event: mapEvent({ depth: "ごく浅い" }),
    });
    const depthTerm = [...container.querySelectorAll("dt")].find((term) => term.textContent === "深さ");
    expect(depthTerm?.nextElementSibling?.textContent).toBe("ごく浅い");
    expect(container.textContent).not.toContain("~10km");
  });

  it("非緊急全国図の upper bound 付き「ごく浅い」に ? badge を付けない", () => {
    const { container } = render(QuakeMapScreen, {
      event: mapEvent({
        depth: "ごく浅い",
        depthSemantic: {
          raw: "-0",
          presence: "qualitative",
          label: "ごく浅い",
          condition: null,
          description: "ごく浅い",
          value: null,
          lowerBound: null,
          upperBound: 5,
          rawLowerBound: null,
          rawUpperBound: null,
          badge: null,
          color: "safetyRank",
          render: true,
        },
      }),
    });
    const depthTerm = [...container.querySelectorAll("dt")].find((term) => term.textContent === "深さ");
    const depth = depthTerm?.nextElementSibling;
    expect(depth?.textContent).toBe("ごく浅い");
    expect(depth?.querySelector(".semantic-badge")).toBeNull();
    expect(depth?.getAttribute("aria-label")).toBe("深さ: ごく浅い");
  });

  it("scalar-only magnitude:null の '-' 表示と ARIA を一致させる", () => {
    const { container } = render(QuakeMapScreen, {
      event: mapEvent({ magnitude: null }),
    });
    const magnitudeTerm = [...container.querySelectorAll("dt")].find((term) => term.textContent === "規模");
    expect(magnitudeTerm?.nextElementSibling?.textContent).toBe("-");
    expect(magnitudeTerm?.nextElementSibling?.getAttribute("aria-label")).toBe("マグニチュード: -");
  });

  it("全国図と文字一覧を並置し、緊急画面の header/hero/motion を使わない", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));
    const { container } = render(QuakeMapScreen, {
      event: mapEvent({ maxInt: "4", maxIntRank: 4 }),
      dim: true,
    });
    await waitFor(() => expect(container.querySelector(".quake-map-svg")).toBeTruthy());

    expect(container.querySelector(".content")).toBeTruthy();
    expect(container.querySelector(".map-pane")).toBeTruthy();
    expect(container.querySelector(".quake-map-screen")?.classList.contains("dim")).toBe(true);
    expect(container.querySelector(".list-pane .pref-name")?.textContent).toBe("静岡県");
    expect(container.querySelector(".list-pane .cities")?.textContent).toContain("東部");
    expect(container.querySelector(".heading")).toBeNull();
    expect(container.querySelector(".hero")).toBeNull();
    expect(container.querySelector("[data-motion-reveal]")).toBeNull();

    const source = readFileSync(join(__dirname, "..", "QuakeMapScreen.svelte"), "utf8");
    expect(source).not.toContain("StandbyScreen");
    expect(source).not.toContain("EmergencyScreen");
    expect(source).not.toContain("position: fixed");
  });

  it("asset 取得失敗でも概要と文字一覧を維持する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 503)));
    const { container } = render(QuakeMapScreen, {
      event: mapEvent({ maxInt: "4", maxIntRank: 4 }),
    });
    await waitFor(() => expect(container.querySelector(".quake-map-fallback")).toBeTruthy());
    expect(container.querySelector(".maximum")?.textContent).toContain("最大震度 4");
    expect(container.querySelector(".list-pane .pref-name")?.textContent).toBe("静岡県");
    expect(container.querySelector(".list-pane .cities")?.textContent).toContain("東部");
  });

  it("地図を併設したまま文字一覧を全ページ巡回する", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));
    const areas = Array.from({ length: 35 }, (_, index) => `高知県市町村${index}`);
    const { container } = render(QuakeMapScreen, {
      event: mapEvent({
        maxInt: "4",
        maxIntRank: 4,
        intensityGroups: [{ intensity: "4", rank: 4, areas, omittedAreaCount: 0 }],
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    expect(container.querySelector(".quake-map-svg")).toBeTruthy();
    expectCurrentDot(container.querySelector(".list-pane"), 1, 3);
    vi.advanceTimersByTime(PAGE_HOLD_MS);
    flushSync();
    vi.advanceTimersByTime(1_000);
    flushSync();
    expectCurrentDot(container.querySelector(".list-pane"), 2, 3);
    expect(container.querySelector(".quake-map-svg")).toBeTruthy();
  });

  it("reduced-motion 下も全国図と文字一覧を描画し、ページ fade を 0ms にする", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList)));
    vi.stubGlobal("fetch", vi.fn(async () => response(asset())));
    const areas = Array.from({ length: 35 }, (_, index) => `高知県市町村${index}`);
    const { container } = render(QuakeMapScreen, {
      event: mapEvent({
        maxInt: "4",
        maxIntRank: 4,
        intensityGroups: [{ intensity: "4", rank: 4, areas, omittedAreaCount: 0 }],
      }),
    });
    await waitFor(() => expect(container.querySelector(".quake-map-svg")).toBeTruthy());
    expect(container.querySelector(".list-pane")).toBeTruthy();

    const source = readFileSync(join(__dirname, "..", "QuakeMapScreen.svelte"), "utf8");
    expect(source).toContain("cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS");
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
