import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushSync } from "svelte";
import QuakeMap from "../QuakeMap.svelte";
import QuakePanel from "../QuakePanel.svelte";
import type {
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
