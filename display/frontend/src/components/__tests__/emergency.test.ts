import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import EmergencyScreen from "../EmergencyScreen.svelte";
import WeatherEmergencyPanel from "../WeatherEmergencyPanel.svelte";
import { PAGE_HOLD_MS } from "../../lib/page-cycler.svelte";
import { expectCurrentDot } from "./page-dots-test-utils";
import type { EmergencyPanelModel } from "../../lib/derive";
import type {
  DisplayEewInputV1,
  DisplayWeatherChangeItemV1,
  DisplayWeatherChangeV1,
  DisplayLargeQuakeInputV1,
  DisplayTsunamiInputV1,
} from "../../lib/protocol";
import type { WeatherEmergencyInputV1, WeatherPanelItemV1 } from "../../lib/weather-panel";

// T5c: ページ切替は {#key} + transition:fade (重ねクロスフェード、231ms) になった。
// fake timers 環境では element.animate() スタブ (test-setup.ts) の完了が setTimeout 経由なので、
// ページ送りのタイマーを進めた直後だけでなく、フェード時間ぶんも追加で進めてから DOM を読む
function settleFade(): void {
  vi.advanceTimersByTime(1000);
  flushSync();
}

interface WeatherGeometryOptions {
  panelWidth?: number;
  panelHeight?: number;
  reserveHeight?: number;
  changeCandidateHeight?: (candidate: number) => number;
  frameWidth?: number;
  frameHeight?: number;
  bodyWidth?: number;
  bodyHeight?: number;
  areaWidth?: number;
  fontSize?: number;
  measureFragments?: boolean;
  measureChangeCandidates?: boolean;
  notifyInitialResize?: boolean;
  rowHeight?: (row: Element) => number;
}

/** WeatherEmergencyPanel の partition 非依存 frame / 基準 body / 断片棚を制御する。 */
function installWeatherGeometry(options: WeatherGeometryOptions = {}) {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRect = Element.prototype.getBoundingClientRect;
  const originalComputedStyle = window.getComputedStyle;
  let panelWidth = options.panelWidth ?? 1_000;
  let panelHeight = options.panelHeight ?? 800;
  const reserveHeight = options.reserveHeight ?? 500;
  const frameWidth = options.frameWidth ?? 800;
  const frameHeight = options.frameHeight ?? 260;
  const bodyWidth = options.bodyWidth ?? 600;
  let bodyHeight = options.bodyHeight ?? 120;
  const areaWidth = options.areaWidth ?? 480;
  const fontSize = options.fontSize ?? 20;
  let measureFragments = options.measureFragments ?? true;
  let measureChangeCandidates = options.measureChangeCandidates ?? true;
  const observed: Array<{
    target: Element;
    observer: GeometryResizeObserver;
  }> = [];

  const rectOf = (element: Element): DOMRect => {
    let width = 0;
    let height = 0;
    if (element.classList.contains("weather-panel")) {
      width = panelWidth;
      height = panelHeight;
    } else if (element.classList.contains("change-reserve-shell")) {
      width = panelWidth;
      height = reserveHeight;
    } else if (element.classList.contains("change-candidate")) {
      const candidate = Number((element as HTMLElement).dataset.changeCandidate ?? 0);
      width = panelWidth;
      height = measureChangeCandidates
        ? (options.changeCandidateHeight?.(candidate) ?? 80 + candidate * 20)
        : 0;
    } else if (element.classList.contains("tile-where")) {
      width = frameWidth;
      height = frameHeight;
    } else if (element.classList.contains("where-body")) {
      width = bodyWidth;
      height = bodyHeight;
    } else if (
      element.classList.contains("areas")
      && element.closest(".measurement-area-probe") != null
    ) {
      width = areaWidth;
      height = 30;
    } else if (element.classList.contains("syncing")) {
      width = bodyWidth;
      height = Math.max(1, Math.floor(bodyHeight * 0.55));
    } else if (element.classList.contains("where-row")) {
      width = bodyWidth;
      const isMeasuredFragment = element.closest(".measurement-fragments") != null;
      height = isMeasuredFragment && !measureFragments
        ? 0
        : (options.rowHeight?.(element) ?? 30);
    }
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return rectOf(this);
  };
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    if (element.classList.contains("areas")) {
      return {
        fontSize: `${fontSize}px`,
        getPropertyValue: () => "",
      } as unknown as CSSStyleDeclaration;
    }
    return originalComputedStyle.call(window, element, pseudo);
  }) as typeof window.getComputedStyle;

  class GeometryResizeObserver {
    private active = true;
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      if (target.classList.contains("where-body")) {
        Object.defineProperties(target, {
          clientWidth: { configurable: true, value: bodyWidth },
          clientHeight: { configurable: true, value: bodyHeight },
        });
      }
      observed.push({ target, observer: this });
      // 実ブラウザ同様、observe() の呼出しスタックを抜けてから callback を届ける。
      if (options.notifyInitialResize !== false) queueMicrotask(() => this.notify(target));
    }
    unobserve(): void {}
    disconnect(): void {
      this.active = false;
    }
    notify(target: Element): void {
      if (!this.active) return;
      if (target.classList.contains("where-body")) {
        Object.defineProperties(target, {
          clientWidth: { configurable: true, value: bodyWidth },
          clientHeight: { configurable: true, value: bodyHeight },
        });
      }
      const rect = rectOf(target);
      this.callback([{
        target,
        contentRect: rect,
        borderBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
  }
  globalThis.ResizeObserver = GeometryResizeObserver as unknown as typeof ResizeObserver;

  return {
    setPanelSize(width: number, height: number): void {
      panelWidth = width;
      panelHeight = height;
    },
    setBodyHeight(height: number): void {
      bodyHeight = height;
    },
    setMeasureFragments(value: boolean): void {
      measureFragments = value;
    },
    setMeasureChangeCandidates(value: boolean): void {
      measureChangeCandidates = value;
    },
    fireAll(): void {
      for (const { target, observer } of [...observed]) observer.notify(target);
    },
    restore(): void {
      Element.prototype.getBoundingClientRect = originalRect;
      window.getComputedStyle = originalComputedStyle;
      globalThis.ResizeObserver = originalResizeObserver;
    },
  };
}

async function settleWeatherLayout(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    flushSync();
    await tick();
  }
}

function eewInput(over: Partial<DisplayEewInputV1> = {}): DisplayEewInputV1 {
  return {
    kind: "eew",
    eventId: "E1",
    serial: "3",
    isWarning: true,
    isFinal: false,
    isCancellation: false,
    hypocenterName: "浦河沖",
    forecastMaxInt: "5強",
    forecastMaxIntRank: 5,
    magnitude: "6.1",
    colorIndex: null,
    reportDateTime: "2026-07-07T10:00:00+09:00",
    originTime: null,
    isAssumedHypocenter: false,
    depth: "30km",
    maxLgInt: null,
    regions: [],
    ...over,
  };
}

function tsunamiInput(over: Partial<DisplayTsunamiInputV1> = {}): DisplayTsunamiInputV1 {
  return {
    kind: "tsunami",
    eventId: over.eventId ?? "T1",
    level: "warning",
    levelLabel: "津波警報",
    coasts: [
      { name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null },
      { name: "宮城県", kind: "warning", maxHeight: null, firstHeight: null },
    ],
    warningComment: null,
    observations: [],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    ...over,
  };
}

function quakeInput(over: Partial<DisplayLargeQuakeInputV1> = {}): DisplayLargeQuakeInputV1 {
  return {
    kind: "largeQuake",
    eventId: "Q1",
    originTime: "2026-07-07T09:58:00+09:00",
    hypocenterName: "浦河沖",
    magnitude: "6.1",
    maxInt: "5強",
    maxIntRank: 9,
    intensityGroups: [
      { intensity: "5強", rank: 9, areas: ["浦河町", "様似町"], omittedAreaCount: 0 },
      { intensity: "4", rank: 7, areas: ["帯広市"], omittedAreaCount: 0 },
    ],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    depth: "30km",
    maxLgInt: null,
    tsunamiWarning: false,
    ...over,
  };
}

function panel(key: string, input: EmergencyPanelModel["input"]): EmergencyPanelModel {
  return { key, input };
}

function weatherItem(
  over: Partial<WeatherPanelItemV1> & { kind: string; key: string },
): WeatherPanelItemV1 {
  return {
    source: "vpws50",
    level: 5,
    shownAreas: ["東京都", "千葉県"],
    omittedAreaCount: 0,
    addedAreas: [],
    ...over,
  };
}

function weatherInput(over: Partial<WeatherEmergencyInputV1> = {}): WeatherEmergencyInputV1 {
  return {
    kind: "weather",
    level: 5,
    generation: "vpws50:1",
    items: [weatherItem({ key: "vpws50:0:L5 大雨特別警報", kind: "L5 大雨特別警報" })],
    truncated: false,
    restored: false,
    trigger: null,
    updatedAt: "2026-07-25T10:00:00+09:00",
    activationKey: "a1",
    firstPageRowKey: null,
    ...over,
  };
}

function changeItem(kind: DisplayWeatherChangeItemV1["kind"], areaName: string, index: number): DisplayWeatherChangeItemV1 {
  return {
    areaCode: `${kind}-${index}`,
    areaName,
    phenomenonKey: `ph-${kind}-${index}`,
    kind,
    before: kind === "added" ? null : {
      kindShortName: "大雨注意報", kindCode: "10", displaySeverity: "officialL2", officialAlertLevel: 2,
    },
    after: kind === "released" ? null : {
      kindShortName: "大雨警報", kindCode: "03", displaySeverity: "officialL3", officialAlertLevel: 3,
    },
  };
}

function weatherChange(over: Partial<DisplayWeatherChangeV1> = {}): DisplayWeatherChangeV1 {
  return {
    source: "vpws50",
    changeKey: "boot:1",
    reportDateTime: "2026-08-13T20:00:00+09:00",
    issuedAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    changes: [
      changeItem("upgraded", "悪化地域", 0),
      changeItem("added", "追加地域", 0),
      changeItem("kindChanged", "種別変更地域", 0),
      changeItem("downgraded", "緩和地域", 0),
      changeItem("released", "解除地域", 0),
    ],
    omitted: {},
    ...over,
  };
}

describe("EmergencyScreen", () => {
  it("地震パネルの「ごく浅い」を距離へ置換しない", () => {
    const { container } = render(EmergencyScreen, {
      panels: [panel("quake:Q1", quakeInput({ depth: "ごく浅い" }))],
    });
    const depthLabel = [...container.querySelectorAll(".stat-label")]
      .find((label) => label.textContent === "深さ");
    expect(depthLabel?.nextElementSibling?.textContent).toBe("ごく浅い");
    expect(container.textContent).not.toContain("~10km");
  });

  it("4 カード同時では左主役と右 3 段の DOM スロットを順に持つ", () => {
    const { container } = render(EmergencyScreen, {
      panels: [
        panel("tsunami:current", tsunamiInput()),
        panel("eew:E1", eewInput()),
        panel("quake:Q1", quakeInput()),
        panel("weather:current", weatherInput()),
      ],
    });
    const slots = [...container.querySelectorAll<HTMLElement>(".panel-slot")];
    expect(slots.map((slot) => slot.dataset.testid))
      .toEqual(["tsunami:current", "eew:E1", "quake:Q1", "weather:current"]);
    expect(slots[0].classList.contains("is-main")).toBe(true);
    expect(slots.slice(1).map((slot) => slot.getAttribute("style")))
      .toEqual(["grid-column: 3; grid-row: 1;", "grid-column: 3; grid-row: 3;", "grid-column: 3; grid-row: 5;"]);
    expect(slots[2].textContent).toContain("09:58 発生");
  });

  it("④ EewPanel が 震央/推定最大震度/M/続報番号 を render する", () => {
    const { container } = render(EmergencyScreen, { panels: [panel("eew:1", eewInput())] });
    expect(screen.getByText("浦河沖")).toBeTruthy();
    // v3 で震度表記が「5強」→「5+」に統一された (formatIntShort)
    // 推定最大震度: プレフィックスは静止テキスト、値は RollingNumber (data-value) で取る
    expect(container.querySelector(".max-int")?.textContent).toContain("推定最大震度");
    expect(container.querySelector('.max-int [data-value="5+"]')).toBeTruthy();
    // Phase B タイル化で M はラベル (「M」) と値 (「6.1」) が別要素の stat タイルに分かれた
    expect(screen.getByText("M", { selector: ".stat-label" })).toBeTruthy();
    expect(container.querySelector('.stat-value [data-value="6.1"]')).toBeTruthy();
    expect(container.querySelector('.stat-tile [data-value="6.1"]')).toBeTruthy();
    expect(screen.getByText(/第3報/)).toBeTruthy();
  });

  it("⑤ 続報 (同 key の input 差し替え) で再マウントされず内容が更新される", async () => {
    const { rerender } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput({ serial: "1" }))],
    });
    const before = screen.getByTestId("eew:1");
    await rerender({ panels: [panel("eew:1", eewInput({ serial: "2" }))] });
    const after = screen.getByTestId("eew:1");
    expect(after).toBe(before);
    expect(screen.getByText(/第2報/)).toBeTruthy();
  });

  it("⑥ TsunamiPanel が levelLabel と沿岸名を render、level 別 class が付く", () => {
    const { container } = render(EmergencyScreen, {
      panels: [
        panel(
          "tsunami:current",
          tsunamiInput({ level: "majorWarning", levelLabel: "大津波警報" }),
        ),
      ],
    });
    expect(screen.getByText("大津波警報")).toBeTruthy();
    expect(screen.getByText("岩手県")).toBeTruthy();
    expect(container.querySelector(".tsunami-majorWarning")).toBeTruthy();
  });

  it("⑦ QuakePanel が震度別リストを大きい順に render する", () => {
    render(EmergencyScreen, { panels: [panel("quake:1", quakeInput())] });
    const strong = screen.getByText(/浦河町/);
    const weak = screen.getByText(/帯広市/);
    // DOM 順序: compareDocumentPosition の PRECEDING/FOLLOWING で判定
    // strong (5強=表示上は5+) が weak (4) より前に出現する
    // eslint-disable-next-line no-bitwise
    const position = strong.compareDocumentPosition(weak);
    expect((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  // ── Spec C Phase 2: 気象警報の主役パネル ──

  describe("WeatherEmergencyPanel", () => {
    it("weather kind が QuakePanel に落ちず WeatherEmergencyPanel で描画される (フォールスルー撲滅)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      expect(container.querySelector(".weather-panel")).toBeTruthy();
      expect(container.querySelector(".quake-panel")).toBeFalsy();
      expect(container.querySelector(".eew-panel")).toBeFalsy();
      expect(container.querySelector(".tsunami-panel")).toBeFalsy();
    });

    it("「何が / どこ / どうする」の 3 固定領域を描く (L5)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      const p = container.querySelector(".weather-panel")!;
      expect(p.querySelector(".heading")?.textContent).toContain("大雨特別警報");
      // 何が
      expect(p.querySelector(".tile-what .level-label")?.textContent).toBe("警戒レベル5相当");
      expect(p.querySelector(".tile-what .alert-name")?.textContent).toBe("大雨特別警報");
      // どこ
      const row = p.querySelector(".tile-where .where-row")!;
      expect(row.querySelector(".kind")?.textContent).toBe("大雨特別警報");
      expect(Array.from(row.querySelectorAll(".area-name")).map((el) => el.textContent)).toEqual([
        "東京都",
      ]);
      // 未測定中は地域を1件ずつ安全側の provisional page にする。
      expect(p.querySelector(".tile-where")?.getAttribute("data-layout-state")).toBe("pending");
      expect(p.querySelector(".tile-where")?.getAttribute("data-pager-reference-total")).toBe("2");
      // どうする (主役スロットは独立した行動レール。compact のみヒーロー行へ束ねる)
      expect(p.querySelector(".tile-action .action-main")?.textContent).toBe("命の危険 直ちに安全確保");
      expect(p.querySelector(".tile-action .action-note")?.textContent).toContain(
        "自治体が発令する避難指示とは別の防災気象情報です",
      );
    });

    it("L4 のみの昇格では見出し・行動文が L4 の語彙になる", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              level: 4,
              items: [weatherItem({ key: "k1", kind: "L4 洪水警報", level: 4 })],
            }),
          ),
        ],
      });
      const p = container.querySelector(".weather-panel")!;
      expect(p.querySelector(".heading")?.textContent).toContain("洪水警報");
      expect(p.querySelector(".level-label")?.textContent).toBe("警戒レベル4相当");
      expect(p.querySelector(".action-main")?.textContent).toBe("危険な場所にいる人は全員避難");
      expect(p.classList.contains("role-weatherWarning")).toBe(true);
    });

    it("今回の変更を現況と別 surface に表示し、normal は最大4件で悪化・解除を代表表示する", async () => {
      // 2026-08-27 観測に基づく幅利用と、本仕様の測定式上限へ置換。
      const geometry = installWeatherGeometry();
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange() }),
      });
      try {
        await settleWeatherLayout();
        const changeSurface = rendered.container.querySelector(":scope > .weather-panel > .weather-change-slot .weather-change")!;
        expect(changeSurface).toBeTruthy();
        expect(changeSurface.querySelector(".change-heading")?.textContent).toBe("今回の変更");
        expect(changeSurface.querySelector(".change-meta")?.textContent).toBe("VPWS50 · 5件");
        expect(changeSurface.querySelectorAll(".change-chip")).toHaveLength(5);
        expect(changeSurface.querySelector("button, a[href], input, select, textarea, [tabindex]")).toBeFalsy();
        expect(changeSurface.querySelector(".page-dots")).toBeFalsy();
        expect(Array.from(changeSurface.querySelectorAll(".change-group")).map((group) => group.getAttribute("data-change-kind")))
          .toEqual(["upgraded", "added", "kindChanged", "downgraded", "released"]);
        expect(changeSurface.textContent).toContain("悪化地域");
        expect(changeSurface.textContent).toContain("解除地域");
        expect(changeSurface.querySelector(".change-summary")?.textContent).toContain("緩和 1件");
        expect(rendered.container.querySelector(".tile-where")?.textContent).not.toContain("解除地域");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("compact は最大2件でも upgraded と released を残し、同一ラベル kindChanged は描かない", async () => {
      const codeOnly = changeItem("kindChanged", "同一ラベル", 1);
      codeOnly.before = { ...codeOnly.before!, kindShortName: "大雨" };
      codeOnly.after = { ...codeOnly.after!, kindShortName: "大雨" };
      const geometry = installWeatherGeometry();
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          change: weatherChange({ changes: [
            changeItem("upgraded", "悪化", 0),
            changeItem("added", "追加", 0),
            codeOnly,
            changeItem("released", "解除", 0),
          ] }),
        }),
        compact: true,
      });
      try {
        await settleWeatherLayout();
        const surface = rendered.container.querySelector(":scope > .weather-panel > .weather-change-slot .weather-change")!;
        expect(surface.querySelectorAll(".change-chip")).toHaveLength(3);
        expect(surface.textContent).toContain("悪化");
        expect(surface.textContent).toContain("解除");
        expect(surface.textContent).not.toContain("同一ラベル");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it.each([
      ["normal", false, 11],
      ["compact", true, 4],
    ] as const)("13件 synthetic を %s の実測上限で縮約し、予約二区分と tail を保つ", async (
      _label,
      compact,
      expectedChips,
    ) => {
      const changes = [
        ...Array.from({ length: 4 }, (_, index) => changeItem("upgraded", `悪化${index}`, index)),
        ...Array.from({ length: 3 }, (_, index) => changeItem("added", `追加${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("kindChanged", `種別変更${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("downgraded", `緩和${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("released", `解除${index}`, index)),
      ];
      const geometry = installWeatherGeometry();
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange({ changes }) }),
        compact,
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        const live = panel.querySelector(":scope > .weather-change-slot .weather-change")!;
        expect(live.querySelectorAll(".change-chip")).toHaveLength(expectedChips);
        expect(live.querySelector('[data-change-kind="upgraded"] .change-chip')).toBeTruthy();
        expect(live.querySelector('[data-change-kind="released"] .change-chip')).toBeTruthy();
        expect(live.querySelector(".change-omitted-tail")?.textContent).toBe(`ほか ${13 - expectedChips} 件`);
        expect(panel.dataset.changeLayoutUnresolved).toBe("false");
        expect(panel.dataset.changeMeasurementNonconverged).toBe("false");
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
        expect(Number(panel.dataset.changeBudget)).toBe(
          Number(panel.dataset.changePanelContentHeight) - Number(panel.dataset.changeReserveHeight),
        );
        expect(Number(panel.dataset.changeBudgetQuantized)).toBe(
          Math.round(Number(panel.dataset.changeBudget) * window.devicePixelRatio) / window.devicePixelRatio,
        );
        for (const field of [
          "changeKey", "changeActivationKey", "changeReserveFingerprint", "changeLogicalFingerprint",
          "changeFontEpoch", "changeSettlingEpoch", "changeMeasurementKey",
        ]) expect(panel.dataset[field]).not.toBeUndefined();
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("ResizeObserver の初回通知なしでも候補の自然高を採寸して一度だけ fit を publish する", async () => {
      const changes = [
        ...Array.from({ length: 4 }, (_, index) => changeItem("upgraded", `悪化${index}`, index)),
        ...Array.from({ length: 3 }, (_, index) => changeItem("added", `追加${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("kindChanged", `種別変更${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("downgraded", `緩和${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("released", `解除${index}`, index)),
      ];
      const geometry = installWeatherGeometry({ notifyInitialResize: false });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange({ changes }) }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        const measurements = JSON.parse(panel.dataset.changeCandidateMeasurements ?? "[]") as Array<{
          n: number;
          height: number | null;
          fit: boolean | null;
        }>;
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
        expect(panel.dataset.changeLayoutUnresolved).toBe("false");
        expect(Number(panel.dataset.changeSelected)).toBe(11);
        expect(measurements).toHaveLength(13);
        expect(measurements[0]).toEqual({ n: 0, height: 80, fit: true });
        expect(measurements[11]).toEqual({ n: 11, height: 300, fit: true });
        expect(measurements[12]).toEqual({ n: 12, height: 320, fit: false });
        const source = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
        expect(source).toMatch(/\.change-candidate\s*\{[^}]*align-self:\s*start/s);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("Bq の切上がりで raw budget を超える候補を選ばず対象地域の最小一ページを守る", async () => {
      const changes = [
        ...Array.from({ length: 4 }, (_, index) => changeItem("upgraded", `悪化${index}`, index)),
        ...Array.from({ length: 3 }, (_, index) => changeItem("added", `追加${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("kindChanged", `種別変更${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("downgraded", `緩和${index}`, index)),
        ...Array.from({ length: 2 }, (_, index) => changeItem("released", `解除${index}`, index)),
      ];
      const geometry = installWeatherGeometry({
        panelHeight: 976,
        reserveHeight: 496.125,
        changeCandidateHeight: (candidate) => 340 + candidate * 20,
      });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange({ changes }) }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        const measurements = JSON.parse(panel.dataset.changeCandidateMeasurements ?? "[]") as Array<{
          n: number;
          height: number | null;
          fit: boolean | null;
        }>;
        const identity = JSON.parse(panel.dataset.changeMeasurementKey ?? "null") as [string, { budget: number }];
        expect(Number(panel.dataset.changeBudget)).toBe(479.875);
        expect(Number(panel.dataset.changeBudgetQuantized)).toBe(480);
        expect(identity[1].budget).toBe(479.875);
        expect(Number(panel.dataset.changeSelected)).toBe(6);
        expect(measurements[6]).toEqual({ n: 6, height: 460, fit: true });
        expect(measurements[7]).toEqual({ n: 7, height: 480, fit: false });
        expect(panel.dataset.changeLayoutUnresolved).toBe("false");
        expect(panel.querySelector(".tile-where")?.getAttribute("data-layout-state")).toBe("ready");
        const reserveDots = panel.querySelectorAll(".change-reserve-shell .page-dot");
        const referenceDots = panel.querySelectorAll(".measurement-reference .page-dot");
        expect(reserveDots.length).toBeGreaterThan(0);
        expect(reserveDots).toHaveLength(referenceDots.length);
        expect(Number(panel.dataset.changeTargetAvailableHeight)).toBe(120);
        expect(Number(panel.dataset.changeTargetFrameHeight)).toBe(260);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("初回未測定は summary-only とし、0件候補も budget 外なら unresolved を明示する", async () => {
      const initial = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange() }),
        reducedMotionInput: true,
      });
      const initialPanel = initial.container.querySelector<HTMLElement>(".weather-panel")!;
      expect(initialPanel.dataset.changeLayoutUnresolved).toBe("false");
      expect(Number(initialPanel.dataset.changeMeasurementPass)).toBe(0);
      expect(initial.container.querySelector(":scope > .weather-panel > .weather-change-slot .change-chip")).toBeFalsy();
      expect(initial.container.querySelector(":scope > .weather-panel > .weather-change-slot .change-omitted-tail")?.textContent)
        .toBe("ほか 5 件");
      initial.unmount();

      const geometry = installWeatherGeometry({ panelHeight: 540, reserveHeight: 500 });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange() }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        expect(panel.dataset.changeLayoutUnresolved).toBe("true");
        expect(panel.querySelector(":scope > .weather-change-slot .change-chip")).toBeFalsy();
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("activationKey 更新後も panel observer は新 token で geometry と fit identity を更新する", async () => {
      const geometry = installWeatherGeometry();
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ activationKey: "a1", change: weatherChange({ changeKey: "boot:1" }) }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        const beforeKey = panel.dataset.changeMeasurementKey;
        expect(Number(panel.dataset.changePanelWidth)).toBe(1_000);
        geometry.setPanelSize(720, 700);
        await rendered.rerender({
          input: weatherInput({ activationKey: "a2", change: weatherChange({ changeKey: "boot:2" }) }),
          compact: false,
          layoutSettling: false,
          reducedMotionInput: true,
        });
        geometry.fireAll();
        await settleWeatherLayout();
        expect(Number(panel.dataset.changePanelWidth)).toBe(720);
        expect(panel.dataset.changeMeasurementKey).not.toBe(beforeKey);
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("identity reset・pending・同値 ResizeObserver は outer fit pass を余分に数えない", async () => {
      const geometry = installWeatherGeometry();
      const firstInput = weatherInput({ activationKey: "a1", change: weatherChange({ changeKey: "boot:1" }) });
      const secondInput = weatherInput({ activationKey: "a2", change: weatherChange({ changeKey: "boot:2" }) });
      const rendered = render(WeatherEmergencyPanel, { input: firstInput, reducedMotionInput: true });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
        geometry.fireAll();
        await settleWeatherLayout();
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
        await rendered.rerender({ input: secondInput, compact: false, layoutSettling: true, reducedMotionInput: true });
        flushSync();
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(0);
        expect(Number(panel.dataset.changeSelected)).toBe(0);
        await rendered.rerender({ input: secondInput, compact: false, layoutSettling: false, reducedMotionInput: true });
        geometry.fireAll();
        await settleWeatherLayout();
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("5回以上の partition split は outer fit pass に数えず ready へ収束する", async () => {
      const geometry = installWeatherGeometry({
        areaWidth: 1_200,
        bodyHeight: 45,
        rowHeight: (row) => 20 + row.querySelectorAll(".area-name").length * 25,
      });
      const areas = Array.from({ length: 8 }, (_, index) => `福井県地域${index}`);
      const areaCodes = Array.from({ length: 8 }, (_, index) => `1820${String(index).padStart(3, "0")}`);
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({ key: "many-splits", kind: "L5 大雨特別警報", shownAreas: areas, shownAreaCodes: areaCodes })],
          change: weatherChange(),
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        expect(Number(panel.dataset.changePartitionRefinements)).toBeGreaterThanOrEqual(5);
        expect(Number(panel.dataset.changeOuterFitPublishes)).toBe(1);
        expect(panel.querySelector(".tile-where")?.getAttribute("data-layout-state")).toBe("ready");
        expect(panel.dataset.changeMeasurementNonconverged).toBe("false");
        const ranges = JSON.parse(panel.dataset.changePageRanges ?? "[]") as string[][];
        const identities = JSON.parse(panel.dataset.changeLogicalAreaIdentities ?? "[]") as string[];
        expect(ranges).toHaveLength(Number(panel.dataset.changePageCount));
        expect(identities).toHaveLength(8);
        expect(new Set(identities).size).toBe(8);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("change 高さ後の where 再分割は論理 identity を保ち range 由来 key を再生成する", async () => {
      const geometry = installWeatherGeometry({
        areaWidth: 1_200,
        bodyHeight: 120,
        rowHeight: (row) => 20 + row.querySelectorAll(".area-name").length * 25,
      });
      const shownAreas = ["福井県福井市", "敦賀市", "大野市", "勝山市"];
      const shownAreaCodes = ["1820100", "1820200", "1820500", "1820600"];
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({
            key: "repartition",
            kind: "L4 大雨警報",
            level: 4,
            shownAreas,
            shownAreaCodes,
            addedAreas: ["勝山市"],
            addedAreaCodes: ["1820600"],
          })],
          firstPageRowKey: "repartition",
          change: weatherChange(),
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        const beforeRanges = JSON.parse(panel.dataset.changePageRanges ?? "[]") as string[][];
        const beforeIdentities = JSON.parse(panel.dataset.changeLogicalAreaIdentities ?? "[]") as string[];
        const beforePartition = panel.dataset.changePartitionSignature;
        const beforeResetKey = panel.dataset.changeCyclerResetKey;
        expect(beforeRanges).toHaveLength(1);

        geometry.setBodyHeight(70);
        geometry.fireAll();
        await settleWeatherLayout();
        await settleWeatherLayout();

        const afterRanges = JSON.parse(panel.dataset.changePageRanges ?? "[]") as string[][];
        const afterIdentities = JSON.parse(panel.dataset.changeLogicalAreaIdentities ?? "[]") as string[];
        expect(afterRanges).toHaveLength(2);
        expect(afterIdentities).toEqual(beforeIdentities);
        expect(new Set(afterIdentities).size).toBe(shownAreas.length);
        expect(afterRanges).not.toEqual(beforeRanges);
        expect(panel.dataset.changePartitionSignature).not.toBe(beforePartition);
        expect(panel.dataset.changeCyclerResetKey).not.toBe(beforeResetKey);
        expect(panel.dataset.changePartitionSignature)
          .toBe(JSON.stringify(["weather-area-partition-v1", afterRanges]));
        expect(panel.dataset.changeCyclerResetKey)
          .toBe(JSON.stringify(["weather-area-cycle-v2", panel.dataset.changePartitionSignature]));
        const activeIndex = Number(panel.dataset.changeActiveIndex);
        expect(activeIndex).toBeGreaterThanOrEqual(0);
        expect(activeIndex).toBeLessThan(afterRanges.length);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("change fit の最終 partition 後に新 activation の追加地域 page を一度だけ選ぶ", async () => {
      const geometry = installWeatherGeometry({
        areaWidth: 1_200,
        bodyHeight: 120,
        measureChangeCandidates: false,
        rowHeight: () => 30,
      });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          level: 4,
          items: [weatherItem({
            key: "density-target",
            kind: "L4 大雨警報",
            level: 4,
            shownAreas: ["秋田県秋田市", "富山県富山市", "鹿児島県奄美市"],
            shownAreaCodes: ["0520100", "1620100", "4622200"],
            addedAreas: ["富山県富山市"],
            addedAreaCodes: ["1620100"],
          })],
          firstPageRowKey: "density-target",
          change: weatherChange(),
        }),
        compact: true,
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(0);
        expect(Number(panel.dataset.changePageCount)).toBe(1);

        // 実 Chrome と同じ順序: target は暫定高で一度 ready、その後 change fit publish により
        // where が三分割される。activation は後者の安定 partition まで消費してはならない。
        geometry.setBodyHeight(35);
        geometry.setMeasureChangeCandidates(true);
        geometry.fireAll();
        await settleWeatherLayout();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await settleWeatherLayout();

        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
        expect(panel.dataset.changeMeasurementSettled).toBe("true");
        expect(Number(panel.dataset.changePageCount)).toBe(3);
        expect(Number(panel.dataset.changeActiveIndex)).toBe(1);
        expect(panel.querySelector(".tile-where .area-name.added")?.textContent).toBe("富山市");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("5回目の異なる outer fit publish だけを nonconverged にする", async () => {
      let fittingLimit = 4;
      const geometry = installWeatherGeometry({
        changeCandidateHeight: (candidate) => candidate <= fittingLimit ? 100 : 500,
      });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange() }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const panel = rendered.container.querySelector<HTMLElement>(".weather-panel")!;
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(1);
        for (const next of [3, 2, 1]) {
          fittingLimit = next;
          geometry.fireAll();
          await settleWeatherLayout();
        }
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(4);
        expect(panel.dataset.changeMeasurementNonconverged).toBe("false");
        fittingLimit = 0;
        geometry.fireAll();
        await settleWeatherLayout();
        expect(Number(panel.dataset.changeMeasurementPass)).toBe(4);
        expect(panel.dataset.changeMeasurementNonconverged).toBe("true");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("change-density capture readiness は base の legacy DOM と after の新属性を分離する", async () => {
      const capturePath = join(__dirname, "..", "..", "..", "..", "scripts", "capture-legacy-standby.mjs");
      const capture = await import(/* @vite-ignore */ pathToFileURL(capturePath).href) as unknown as {
        changeDensityReadinessState(snapshot: Record<string, unknown>, phase: "base" | "after"): {
          ready: boolean;
          targetLayoutReady: boolean;
          acceptedLayoutOutcome: "ready" | "reasoned-infeasible" | "no-change-target-infeasible" | null;
          waitedConditions: Array<{ name: string; expected: unknown; actual: unknown; satisfied: boolean }>;
          infeasibleAcceptance: {
            policy: string;
            ruling: string;
            applicable: boolean;
            complete: boolean;
            status: string;
            reasonCodes: string[];
            checks: Record<string, boolean>;
          };
          feasibility: {
            minimumCombinedDeficit: number | null;
            targetAvailableHeight: number | null;
            minimumTargetFragmentHeight: number | null;
            terminalNoFit: boolean;
          };
        };
        changeDensityMeasurementReport(panel: Record<string, unknown>, phase: "base" | "after"): {
          availability: { source: string; unavailable: Array<{ field: string; reason: string }> };
          targetPagination: Record<string, unknown>;
        };
        isOrderedContiguousSlice(candidate: unknown[], full: unknown[]): boolean;
        formatChangeDensityReadinessTimeout(label: string, observation: Record<string, unknown>): string;
        assertChangeDensityHeaderCascade(
          record: Record<string, unknown>,
          panel: Record<string, unknown>,
        ): Record<string, unknown>;
        assertAfterDensityInfeasibleContract(
          record: Record<string, unknown>,
          panel: Record<string, unknown>,
        ): Record<string, unknown>;
        assertAfterDensityNullTransportContract(
          record: Record<string, unknown>,
          panel: Record<string, unknown>,
        ): Record<string, unknown>;
        compareChangeDensityOverflow(
          label: string,
          beforeOverflow: Record<string, unknown> | null,
          afterOverflow: Record<string, unknown>,
        ): {
          mode: "non-regression" | "record-only";
          reason: string | null;
          baseAvailable: boolean;
          afterAvailable: boolean;
          regressed: boolean | null;
        };
        compareChangeDensityBorderBox(
          label: string,
          beforeBox: Record<string, unknown> | null,
          afterBox: Record<string, unknown>,
        ): {
          mode: "non-regression" | "record-only";
          baseAvailable: boolean;
          afterAvailable: boolean;
          identityMatches: boolean | null;
          identityDifferences: Array<{ field: string; before: unknown; after: unknown }>;
          scrollExtentDelta: { width: number; height: number } | null;
          improved: boolean | null;
          regressed: boolean | null;
        };
      };
      const legacyPanel = {
        liveChange: { height: 120 },
        legacyRows: [{ text: "legacy" }],
        targetArea: { layoutState: "infeasible" },
        diagnostics: {},
      };
      const baseSnapshot = {
        document: { fontsLoaded: true, previewPresent: true, previewMode: "emergency", attentionVisible: false, emergencyPanelCount: 0, emergencyGeometryValid: false },
        liveGeometry: {
          weatherEmergencyPanels: [legacyPanel],
          changeDensityTransport: { mode: "full", source: "preview-input-dto", wireNull: false, wireChangeCount: 13, wireOmittedCount: 0 },
        },
      };
      const base = capture.changeDensityReadinessState(baseSnapshot, "base");
      expect(base.ready).toBe(true);
      expect(base.waitedConditions.map(({ name }) => name)).toContain("legacy.targetLayoutState");
      expect(base.waitedConditions.map(({ name }) => name).some((name) => name.startsWith("after.data-change-"))).toBe(false);
      const pendingSnapshot = {
        ...baseSnapshot,
        liveGeometry: {
          ...baseSnapshot.liveGeometry,
          weatherEmergencyPanels: [{ ...legacyPanel, targetArea: { layoutState: "pending" } }],
        },
      };
      expect(capture.changeDensityReadinessState(pendingSnapshot, "base").ready).toBe(false);

      const afterMissing = capture.changeDensityReadinessState(baseSnapshot, "after");
      expect(afterMissing.ready).toBe(false);
      expect(afterMissing.waitedConditions.find(({ name }) => name === "after.data-change-measurement-settled")?.actual).toBeNull();
      const afterSnapshot = {
        ...baseSnapshot,
        liveGeometry: {
          ...baseSnapshot.liveGeometry,
          weatherEmergencyPanels: [{
            ...legacyPanel,
            targetArea: { layoutState: "ready" },
            diagnostics: {
              "data-change-measurement-settled": "true",
              "data-change-layout-unresolved": "false",
              "data-change-measurement-nonconverged": "false",
            },
          }],
        },
      };
      expect(capture.changeDensityReadinessState(afterSnapshot, "after").ready).toBe(true);
      const zeroOverflow = {
        horizontal: 0,
        vertical: 0,
        viewport: { left: 0, top: 0, right: 0, bottom: 0 },
      };
      const observedShelfOverflow = {
        ...zeroOverflow,
        vertical: 33,
      };
      const noFitSnapshot = {
        ...afterSnapshot,
        liveGeometry: {
          ...afterSnapshot.liveGeometry,
          weatherEmergencyPanels: [{
            ...legacyPanel,
            compact: false,
            uiChipCount: 0,
            uiOmittedCount: 13,
            groups: [],
            chips: [],
            metaText: "VPWS50 · 13件",
            summaryText: "悪化 4件・追加 3件・種別変更 2件・緩和 2件・解除 2件",
            documentOverflow: zeroOverflow,
            panelOverflow: zeroOverflow,
            liveOverflow: zeroOverflow,
            liveSlot: { width: 100, height: 186 },
            candidates: [{ n: 0, height: 186, fit: false, slot: { width: 100, height: 186 } }],
            reserve: {
              shell: { width: 100, height: 500.625 },
              heading: { width: 100, height: 100 },
              hero: { width: 60, height: 50 },
              alertNames: { width: 60, height: 30 },
              tiles: { width: 100, height: 400.625 },
              where: { width: 100, height: 120 },
              whereHead: { width: 90, height: 20 },
              whereBody: { width: 90, height: 86 },
              pageDots: { width: 40, height: 12 },
              action: { width: 40, height: 60 },
              minimumFragment: { key: "minimum", height: 86, areaCount: 1, fit: false },
            },
            targetArea: {
              layoutState: "infeasible",
              referenceTotal: 3,
              overflow: zeroOverflow,
              fitFormula: "fragment border-box height <= algorithm available where-body height",
              minimumOnePageFragments: [{ key: "minimum", height: 86, areaCount: 1, fit: false }],
            },
            diagnostics: {
              "data-change-measurement-settled": "false",
              "data-change-layout-unresolved": "true",
              "data-change-measurement-nonconverged": "false",
              "data-change-measurement-pass": "1",
              "data-change-selected": "0",
              "data-change-panel-content-height": "616",
              "data-change-reserve-height": "500.625",
              "data-change-budget": "115.375",
              "data-change-target-available-height": "16",
            },
          }],
        },
      };
      const noFitOutsideRuling = capture.changeDensityReadinessState(noFitSnapshot, "after");
      expect(noFitOutsideRuling.ready).toBe(false);
      expect(noFitOutsideRuling.infeasibleAcceptance.status).toBe("not-applicable");
      const noFit720Snapshot = {
        ...noFitSnapshot,
        document: {
          ...noFitSnapshot.document,
          viewport: { innerWidth: 1280, innerHeight: 720 },
        },
      };
      const noFit = capture.changeDensityReadinessState(noFit720Snapshot, "after");
      expect(noFit.ready).toBe(true);
      expect(noFit.targetLayoutReady).toBe(false);
      expect(noFit.acceptedLayoutOutcome).toBe("reasoned-infeasible");
      expect(noFit.infeasibleAcceptance).toMatchObject({
        policy: "vpws50-change-density-1280x720-reasoned-infeasible-v1",
        ruling: "2026-09-06-owner-ruling-A",
        applicable: true,
        complete: true,
        status: "accepted",
        reasonCodes: [
          "summary-candidate-exceeds-budget",
          "target-minimum-fragment-exceeds-available-height",
          "existing-weather-reserve-geometry-limit",
        ],
      });
      expect(Object.values(noFit.infeasibleAcceptance.checks).every(Boolean)).toBe(true);
      expect(noFit.infeasibleAcceptance).toMatchObject({
        overflow: {
          policy: "record-all; compare-document-and-panel-to-base-when-available",
          document: zeroOverflow,
          panel: zeroOverflow,
          change: zeroOverflow,
          target: zeroOverflow,
        },
        checks: { overflowRecorded: true, liveOverflowZero: true },
      });
      const noFitPanel = noFit720Snapshot.liveGeometry.weatherEmergencyPanels[0];
      expect(capture.assertAfterDensityInfeasibleContract({
        phase: "after",
        viewport: { label: "1280x720", width: 1280, height: 720 },
        transportMode: "full",
        uiChipCount: 0,
        uiOmittedCount: 13,
        infeasibleAcceptance: noFit.infeasibleAcceptance,
        changeDensityReadiness: noFit,
        geometry: {
          viewport: { innerWidth: 1280, innerHeight: 720 },
          weatherEmergencyPanels: [noFitPanel],
        },
      }, noFitPanel)).toMatchObject({ complete: true, status: "accepted" });
      for (const [mode, wireChangeCount, wireOmittedCount] of [
        ["full", 13, 0],
        ["degraded-12", 12, 1],
        ["degraded-4", 4, 9],
        ["degraded-2", 2, 11],
      ] as const) {
        const state = capture.changeDensityReadinessState({
          ...noFit720Snapshot,
          liveGeometry: {
            ...noFit720Snapshot.liveGeometry,
            changeDensityTransport: {
              mode,
              source: "preview-input-dto",
              wireNull: false,
              wireChangeCount,
              wireOmittedCount,
            },
          },
        }, "after");
        expect(state).toMatchObject({
          ready: true,
          acceptedLayoutOutcome: "reasoned-infeasible",
          infeasibleAcceptance: {
            applicable: true,
            complete: true,
            status: "accepted",
            checks: { changeSurfacePresent: true },
          },
        });
      }
      const nullPanel = {
        ...noFitPanel,
        liveChange: null,
        liveSlot: null,
        liveOverflow: null,
        candidates: [],
        uiChipCount: 0,
        uiOmittedCount: 0,
        metaText: "",
        summaryText: "",
        reserve: { shell: null },
        diagnostics: {
          "data-change-measurement-settled": "true",
          "data-change-layout-unresolved": "false",
          "data-change-measurement-nonconverged": "false",
          "data-change-measurement-pass": "0",
          "data-change-selected": "0",
        },
      };
      const nullSnapshot = {
        ...noFit720Snapshot,
        liveGeometry: {
          ...noFit720Snapshot.liveGeometry,
          weatherEmergencyPanels: [nullPanel],
          changeDensityTransport: {
            mode: "null",
            source: "preview-input-dto",
            wireNull: true,
            wireChangeCount: 0,
            wireOmittedCount: 0,
          },
        },
      };
      const nullState = capture.changeDensityReadinessState(nullSnapshot, "after");
      expect(nullState).toMatchObject({
        ready: true,
        targetLayoutReady: false,
        acceptedLayoutOutcome: "no-change-target-infeasible",
        infeasibleAcceptance: {
          applicable: false,
          complete: false,
          status: "not-applicable",
          checks: { changeSurfacePresent: false },
        },
      });
      expect(nullState.waitedConditions.map(({ name }) => name)).toContain("after.null.changeSurfaceAbsent");
      expect(nullState.waitedConditions.map(({ name }) => name).some((name) => name === "after.1280x720.infeasibleReasonComplete")).toBe(false);
      expect(capture.assertAfterDensityNullTransportContract({
        phase: "after",
        viewport: { label: "1280x720", width: 1280, height: 720 },
        transportMode: "null",
        wireNull: true,
        wireChangeCount: 0,
        wireOmittedCount: 0,
        uiChipCount: 0,
        uiOmittedCount: 0,
        infeasibleAcceptance: nullState.infeasibleAcceptance,
        changeDensityReadiness: nullState,
      }, nullPanel)).toMatchObject({
        outcome: "no-change-target-infeasible",
        targetLayoutState: "infeasible",
      });
      const missingNonNullChange = capture.changeDensityReadinessState({
        ...nullSnapshot,
        liveGeometry: {
          ...nullSnapshot.liveGeometry,
          changeDensityTransport: {
            mode: "degraded-2",
            source: "preview-input-dto",
            wireNull: false,
            wireChangeCount: 2,
            wireOmittedCount: 11,
          },
        },
      }, "after");
      expect(missingNonNullChange.ready).toBe(false);
      expect(missingNonNullChange.acceptedLayoutOutcome).toBeNull();
      expect(capture.compareChangeDensityOverflow("panel", {
        ...zeroOverflow,
        vertical: 40,
      }, observedShelfOverflow)).toMatchObject({
        mode: "non-regression",
        baseAvailable: true,
        afterAvailable: true,
        regressed: false,
      });
      expect(capture.compareChangeDensityOverflow("panel", null, observedShelfOverflow)).toMatchObject({
        mode: "record-only",
        reason: "base-overflow-unavailable",
        baseAvailable: false,
        afterAvailable: true,
        regressed: null,
      });
      expect(capture.compareChangeDensityOverflow("panel", zeroOverflow, observedShelfOverflow)).toMatchObject({
        mode: "non-regression",
        regressed: true,
      });
      const basePanelBox = {
        clientWidth: 724,
        clientHeight: 482,
        scrollWidth: 724,
        scrollHeight: 515,
        chain: ["panel-slot", "preview-screen"],
        cls: "weather-panel compact",
      };
      const improvedPanelBox = { ...basePanelBox, scrollHeight: 482 };
      expect(capture.compareChangeDensityBorderBox("panel", basePanelBox, improvedPanelBox)).toMatchObject({
        mode: "non-regression",
        baseAvailable: true,
        afterAvailable: true,
        identityMatches: true,
        identityDifferences: [],
        scrollExtentDelta: { width: 0, height: -33 },
        improved: true,
        regressed: false,
      });
      expect(capture.compareChangeDensityBorderBox("panel", basePanelBox, {
        ...improvedPanelBox,
        scrollHeight: 516,
      })).toMatchObject({ identityMatches: true, improved: false, regressed: true });
      expect(capture.compareChangeDensityBorderBox("panel", basePanelBox, {
        ...improvedPanelBox,
        clientHeight: 481,
      })).toMatchObject({
        identityMatches: false,
        identityDifferences: [{ field: "clientHeight", before: 482, after: 481 }],
        regressed: false,
      });
      const incomplete720Snapshot = {
        ...noFit720Snapshot,
        liveGeometry: {
          ...noFit720Snapshot.liveGeometry,
          weatherEmergencyPanels: [{
            ...noFitPanel,
            reserve: { ...noFitPanel.reserve, action: null },
          }],
        },
      };
      const incomplete720 = capture.changeDensityReadinessState(incomplete720Snapshot, "after");
      expect(incomplete720.ready).toBe(false);
      expect(incomplete720.infeasibleAcceptance).toMatchObject({
        applicable: true,
        complete: false,
        status: "incomplete",
      });
      expect(incomplete720.infeasibleAcceptance.checks.reserveBreakdownComplete).toBe(false);
      const mixedNoFitPanel = {
        ...noFitPanel,
        compact: true,
        liveSlot: { width: 100, height: 120 },
        candidates: [{ n: 0, height: 120, fit: false, slot: { width: 100, height: 120 } }],
        reserve: {
          ...noFitPanel.reserve,
          shell: { width: 100, height: 316.7 },
          tiles: { width: 100, height: 216.7 },
          action: null,
          minimumFragment: { key: "minimum", height: 58.78, areaCount: 1, fit: false },
        },
        targetArea: {
          ...noFitPanel.targetArea,
          minimumOnePageFragments: [{ key: "minimum", height: 58.78, areaCount: 1, fit: false }],
        },
        diagnostics: {
          ...noFitPanel.diagnostics,
          "data-change-panel-content-height": "302",
          "data-change-reserve-height": "316.7",
          "data-change-budget": "-14.7",
          "data-change-target-available-height": "22",
        },
      };
      const mixedNoFit = capture.changeDensityReadinessState({
        ...noFit720Snapshot,
        liveGeometry: {
          ...noFit720Snapshot.liveGeometry,
          weatherEmergencyPanels: [mixedNoFitPanel],
        },
      }, "after");
      expect(mixedNoFit).toMatchObject({
        ready: true,
        targetLayoutReady: false,
        acceptedLayoutOutcome: "reasoned-infeasible",
        infeasibleAcceptance: { applicable: true, complete: true, status: "accepted" },
      });
      expect(noFit.feasibility).toMatchObject({
        minimumCombinedDeficit: 70.625,
        targetAvailableHeight: 16,
        minimumTargetFragmentHeight: 86,
        terminalNoFit: true,
      });
      const timeout = capture.formatChangeDensityReadinessTimeout("cell", {
        phase: "after",
        waitedConditions: afterMissing.waitedConditions,
        consecutiveStableSamples: 1,
        panelChangeAttributes: {
          "data-change-measurement-key": "identity-1",
          "data-change-measurement-pass": "0",
          "data-change-candidate-measurements": '[{"n":0,"height":320,"fit":false}]',
        },
        measurement: {
          identity: "identity-1",
          pass: 0,
          candidateMeasurements: [{ n: 0, height: 320, fit: false }],
        },
        reserveOccupancy: { shell: { height: 500.625 } },
        feasibility: noFit.feasibility,
      });
      expect(timeout).toContain("waitedConditions=");
      expect(timeout).toContain("finalObserved=");
      expect(timeout).toContain("panelChangeAttributes=");
      expect(timeout).toContain("reserveOccupancy=");
      expect(timeout).toContain("feasibility=");
      expect(timeout).toContain('"terminalNoFit":true');
      expect(timeout).toContain('"identity":"identity-1"');
      expect(timeout).toContain('"candidateMeasurements":[{"n":0,"height":320,"fit":false}]');
      expect(timeout).toContain('"after.data-change-measurement-settled":{"actual":null,"satisfied":false}');

      const semanticHeader = {
        background: "rgb(58, 38, 0)",
        color: "rgb(255, 214, 138)",
        band: "rgb(230, 159, 0)",
      };
      const semanticStyle = {
        rect: { width: 100, height: 20 },
        "background-color": semanticHeader.background,
        color: semanticHeader.color,
        "border-bottom-color": semanticHeader.band,
      };
      const level5Style = {
        rect: { width: 100, height: 40 },
        "background-color": "rgb(255, 255, 255)",
        color: "rgb(0, 0, 0)",
        "border-bottom-color": "rgb(0, 0, 0)",
      };
      expect(capture.assertChangeDensityHeaderCascade(
        { fixture: "vpws50-change-density-normal" },
        {
          level: 4,
          semanticHeader,
          parentHeader: semanticStyle,
          header: semanticStyle,
          levelCascadeProbe: {
            parent: level5Style,
            local: semanticStyle,
            localHasHeadingClass: false,
          },
        },
      )).toMatchObject({
        fixtureLevel: 4,
        current: {
          parent: { "background-color": semanticHeader.background },
          local: { "border-bottom-color": semanticHeader.band },
        },
        forcedLevel5: {
          parent: { "background-color": "rgb(255, 255, 255)" },
          local: { "background-color": semanticHeader.background },
          localHasHeadingClass: false,
        },
      });

      const baseMeasurement = capture.changeDensityMeasurementReport({
        compact: false,
        devicePixelRatio: 1,
        liveChange: { height: 266.703125 },
        diagnostics: {},
        targetArea: {
          layoutState: "infeasible",
          legacyDomPageCount: null,
          legacyDomActiveIndex: null,
          visibleAreaNameOrder: ["秋田市", "富山市"],
          logicalAreaNameOrder: ["秋田市", "富山市"],
          visibleFragmentKeys: [],
        },
      }, "base");
      expect(baseMeasurement.availability.source).toBe("kind-area-after-legacy-dom");
      expect(baseMeasurement.availability.unavailable.map(({ field }) => field)).toEqual(expect.arrayContaining([
        "measurement.identity", "measurement.budget", "measurement.convergence",
        "targetPagination.pageRanges", "targetPagination.partitionSignature", "targetPagination.cyclerResetKey",
        "targetPagination.completeLogicalAreaIdentityOrder",
        "targetPagination.pageCount", "targetPagination.activeIndex",
      ]));
      expect(baseMeasurement.targetPagination).toMatchObject({
        pageCount: null,
        pageRanges: null,
        partitionSignature: null,
        cyclerResetKey: null,
        activeIndex: null,
        logicalAreaIdentities: ["code:0520100:0", "code:1620100:1"],
        logicalAreaIdentitySource: "legacy-visible-page-area-name-slice+fixture-identity-oracle",
        logicalAreaIdentityCoverage: "ordered-contiguous-slice",
      });
      expect(capture.isOrderedContiguousSlice(
        baseMeasurement.targetPagination.logicalAreaIdentities as unknown[],
        ["code:0520100:0", "code:1620100:1", "code:4622200:2"],
      )).toBe(true);
      expect(capture.isOrderedContiguousSlice(["秋田市", "奄美市"], ["秋田市", "富山市", "奄美市"])).toBe(false);
      const afterMeasurementWithoutContract = capture.changeDensityMeasurementReport({
        compact: false,
        devicePixelRatio: 1,
        liveChange: { height: 200 },
        diagnostics: {},
        targetArea: {
          layoutState: "ready",
          projectedPageRanges: [["legacy-projection-must-not-be-used"]],
          projectedPartitionSignature: "legacy-projection-must-not-be-used",
          projectedCyclerResetKey: "legacy-projection-must-not-be-used",
          projectedActiveIndex: 0,
          logicalAreaNameOrder: ["秋田市", "富山市", "奄美市"],
          visibleFragmentKeys: ["legacy-projection-must-not-be-used"],
        },
      }, "after");
      expect(afterMeasurementWithoutContract.availability.unavailable).toEqual([]);
      expect(afterMeasurementWithoutContract.targetPagination).toMatchObject({
        pageCount: null, pageRanges: null, partitionSignature: null, cyclerResetKey: null, activeIndex: null,
      });
    });

    it("1280x720 は reasoned-infeasible の状態組を許すが live overflow 0 は緩和しない", async () => {
      const capturePath = join(__dirname, "..", "..", "..", "..", "scripts", "capture-legacy-standby.mjs");
      const capture = await import(/* @vite-ignore */ pathToFileURL(capturePath).href) as unknown as {
        changeDensityInfeasibleAcceptance(
          panel: Record<string, unknown>,
          viewport: Record<string, unknown>,
          phase: "after",
        ): {
          complete: boolean;
          status: string;
          state: { unresolved: string | null };
          checks: { liveOverflowZero: boolean };
        };
        formatChangeDensityReadinessTimeout(label: string, observation: Record<string, unknown>): string;
      };
      const zeroOverflow = {
        horizontal: 0,
        vertical: 0,
        viewport: { left: 0, top: 0, right: 0, bottom: 0 },
      };
      const box = { width: 100, height: 20 };
      const panel = {
        compact: false,
        liveChange: { width: 100, height: 186 },
        liveSlot: { width: 100, height: 186 },
        liveOverflow: zeroOverflow,
        documentOverflow: zeroOverflow,
        panelOverflow: zeroOverflow,
        candidates: [{ n: 0, height: 186, fit: false, slot: { width: 100, height: 186 } }],
        reserve: {
          shell: { width: 100, height: 500.625 },
          heading: box,
          hero: box,
          alertNames: box,
          tiles: box,
          where: box,
          whereHead: box,
          whereBody: box,
          pageDots: box,
          action: box,
          minimumFragment: { key: "minimum", height: 86, areaCount: 1, fit: false },
        },
        targetArea: {
          layoutState: "infeasible",
          referenceTotal: 3,
          overflow: zeroOverflow,
          fitFormula: "fragment border-box height <= algorithm available where-body height",
          minimumOnePageFragments: [{ key: "minimum", height: 86, areaCount: 1, fit: false }],
        },
        diagnostics: {
          "data-change-panel-content-height": "616",
          "data-change-reserve-height": "500.625",
          "data-change-budget": "115.375",
          "data-change-measurement-pass": "1",
          "data-change-selected": "0",
          "data-change-layout-unresolved": "true",
          "data-change-measurement-settled": "false",
          "data-change-measurement-nonconverged": "false",
          "data-change-target-available-height": "16",
        },
      };
      const viewport = { innerWidth: 1280, innerHeight: 720 };
      const accepted = capture.changeDensityInfeasibleAcceptance(panel, viewport, "after");
      expect(accepted).toMatchObject({
        complete: true,
        status: "accepted",
        state: { unresolved: "true" },
        checks: { liveOverflowZero: true },
      });

      const rejected = capture.changeDensityInfeasibleAcceptance({
        ...panel,
        panelOverflow: { ...zeroOverflow, vertical: 1 },
      }, viewport, "after");
      expect(rejected).toMatchObject({
        complete: false,
        status: "incomplete",
        state: { unresolved: "true" },
        checks: { liveOverflowZero: false },
      });
      expect(capture.formatChangeDensityReadinessTimeout("720p-cell", {
        phase: "after",
        waitedConditions: [],
        infeasibleAcceptance: rejected,
      })).toContain("owner ruling A permits the documented reasoned-infeasible state tuple (layoutState=infeasible, settled=false, unresolved=true, complete reasons); zero live overflow remains mandatory");
    });

    it("change-density assert-from は design-alignment report ID と環境 identity の入力を保持する", async () => {
      const capturePath = join(__dirname, "..", "..", "..", "..", "scripts", "capture-legacy-standby.mjs");
      const capture = await import(/* @vite-ignore */ pathToFileURL(capturePath).href) as unknown as {
        parseCaptureArgs(argv: string[]): {
          designBaselineReport: string | null;
          designAfterReport: string | null;
        } | null;
        createDesignAlignmentReportEvidence(input: {
          mode: "baseline" | "after";
          records: Array<Record<string, unknown>>;
        }): { reportId: string; environmentIdentity: Record<string, unknown> };
        createChangeDensityDesignAlignmentReportEvidence(input: {
          mode: "baseline" | "after";
          records: Array<Record<string, unknown>>;
        }): { reportId: string; environmentIdentity: Record<string, unknown> };
        assertDesignAlignmentReportEvidence(
          report: Record<string, unknown>,
          expectedMode: "baseline" | "after",
        ): { reportId: string; environmentIdentity: Record<string, unknown> };
        assertChangeDensityDesignAlignmentReportEvidence(
          report: Record<string, unknown>,
          expectedMode: "baseline" | "after",
        ): { reportId: string; environmentIdentity: Record<string, unknown> };
        assertChangeDensityDesignAlignmentComparison(
          records: Array<Record<string, unknown>>,
          baselineRecords: Array<Record<string, unknown>>,
        ): Array<Record<string, unknown>>;
        resolveDesignAlignmentExecutionMode(options: Record<string, unknown>): "capture" | "assert-from";
      };
      const parsed = capture.parseCaptureArgs([
        "--fixture", "vpws50-change-density-normal",
        "--assert-from", "density-after.json",
        "--baseline-report", "density-base.json",
        "--design-baseline-report", "design-base.json",
        "--design-after-report", "design-after.json",
      ]);
      expect(parsed).toMatchObject({
        designBaselineReport: "design-base.json",
        designAfterReport: "design-after.json",
      });
      const captureSource = readFileSync(capturePath, "utf-8");
      const densityGateSource = captureSource.slice(
        captureSource.indexOf("export function assertChangeDensityDesignAlignmentGate"),
        captureSource.indexOf("function assertNarrowGeometry"),
      );
      expect(densityGateSource).toContain("assertChangeDensityDesignAlignmentSavedRecords");
      expect(densityGateSource).not.toContain("assertDesignAlignmentSavedRecords(designAfterReport");
      expect(capture.resolveDesignAlignmentExecutionMode({
        suite: "change-density-design-alignment",
        assertFrom: "design-after.json",
        writeBaseline: null,
        baselineReport: "design-base.json",
      })).toBe("assert-from");

      const record = {
        manifestKey: "synthetic-design-cell",
        browser: { product: "Chrome/1", revision: "revision-1" },
        geometry: {
          viewport: { devicePixelRatio: 1 },
          fontSignature: {
            status: "loaded",
            rootFamily: "sans-serif",
            recentQuakesFamily: null,
            recentQuakesStatsFamily: null,
          },
          recentQuakes: null,
        },
      };
      const evidence = capture.createDesignAlignmentReportEvidence({ mode: "baseline", records: [record] });
      expect(evidence.reportId).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.environmentIdentity).toMatchObject({ cellCount: 1, devicePixelRatio: 1 });
      expect(capture.assertDesignAlignmentReportEvidence({
        schemaVersion: 2,
        suite: "design-alignment",
        mode: "baseline",
        records: [record],
        ...evidence,
      }, "baseline")).toEqual(evidence);
      expect(() => capture.assertDesignAlignmentReportEvidence({
        schemaVersion: 2,
        suite: "design-alignment",
        mode: "baseline",
        records: [record],
        ...evidence,
        reportId: "tampered",
      }, "baseline")).toThrow(/reportId/);

      const densityEvidence = capture.createChangeDensityDesignAlignmentReportEvidence({ mode: "baseline", records: [record] });
      expect(capture.assertChangeDensityDesignAlignmentReportEvidence({
        schemaVersion: 2,
        suite: "change-density-design-alignment",
        mode: "baseline",
        records: [record],
        ...densityEvidence,
      }, "baseline")).toEqual(densityEvidence);

      const layout = {
        ladderStage: 3,
        measurementGeometryStage: 3,
        compressed: true,
        placementLeft: ["tsunami", "quake"],
        placementRight: [],
        placementCenter: [],
        rotationKeys: ["weather", "flood"],
        rotationOmittedCount: 0,
        rotationActiveKey: "weather",
        rotationPosition: "1/2",
        typhoonVariant: "compact",
        cardOverflowKeys: [] as string[],
        readableOverflowKeys: [] as string[],
        unresolved: "false",
        nonconverged: "false",
        visibleCards: [
          { key: "tsunami", surface: "left" },
          { key: "quake", surface: "left" },
          { key: "weather", surface: "rotation" },
        ],
      };
      const baselineCell = {
        manifestKey: "density-design-cell",
        scenario: "standby-design-alignment-compressed",
        rotationTick: 0,
        cardPageTick: 0,
        query: "",
        urlIdentity: "/preview.html?nav=0&captureTicker=frozen#standby-design-alignment-compressed",
        viewport: { label: "1280x720", width: 1280, height: 720 },
        mismatches: [],
        geometry: { settled: true, layout, forecast: { footer: { rect: { height: 20 } } } },
      };
      const afterCell = structuredClone(baselineCell);
      expect(capture.assertChangeDensityDesignAlignmentComparison([afterCell], [baselineCell]))
        .toEqual([expect.objectContaining({ manifestKey: "density-design-cell", status: "equal" })]);
      const changedVisibleOrder = structuredClone(afterCell);
      changedVisibleOrder.geometry.layout.visibleCards.reverse();
      expect(() => capture.assertChangeDensityDesignAlignmentComparison([changedVisibleOrder], [baselineCell]))
        .toThrow(/visibleCards/);
      const changedOverflow = structuredClone(afterCell);
      changedOverflow.geometry.layout.cardOverflowKeys = ["weather"];
      expect(() => capture.assertChangeDensityDesignAlignmentComparison([changedOverflow], [baselineCell]))
        .toThrow(/overflow/);
    });

    it("design-alignment 採取は DOM を変更せず pre/post 差分を selector と属性値で診断する", async () => {
      const capturePath = join(__dirname, "..", "..", "..", "..", "scripts", "capture-legacy-standby.mjs");
      const capture = await import(/* @vite-ignore */ pathToFileURL(capturePath).href) as unknown as {
        DESIGN_ALIGNMENT_REPORT_EXPRESSION: string;
        designAlignmentUrl(baseUrl: string, entry: Record<string, unknown>): string;
        assertDesignCaptureTickerFreeze(record: Record<string, unknown>): Record<string, unknown>;
        sameCssColor(left: unknown, right: unknown): boolean;
        diffDesignDomHtml(before: string, after: string): Array<Record<string, unknown>>;
        diffDesignDomTrace(before: unknown[], after: unknown[]): Array<Record<string, unknown>>;
        runDesignCaptureSession(options: Record<string, unknown>): Promise<unknown>;
      };
      expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).not.toContain("createElement");
      expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).not.toContain(".append(");
      expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).toContain("captureTickerFrozen");
      expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).toContain("getComputedStyle(document.documentElement).getPropertyValue('--role-muted')");
      expect(capture.sameCssColor("#b4c2cf", "rgb(180, 194, 207)")).toBe(true);
      expect(capture.sameCssColor("#b4c2cf", "rgb(180 194 207 / 100%)")).toBe(true);
      expect(capture.sameCssColor("#b4c2cf", "rgb(181, 194, 207)")).toBe(false);
      const designUrl = new URL(capture.designAlignmentUrl("https://capture.invalid/preview.html", {
        scenario: "standby-design-alignment-compressed", viewport: "1280x720",
        rotationTick: 0, cardPageTick: 1, query: null,
      }));
      expect(designUrl.searchParams.get("captureTicker")).toBe("frozen");
      const previewSource = readFileSync(join(__dirname, "..", "..", "preview", "PreviewApp.svelte"), "utf-8");
      expect(previewSource).toContain('data-capture-ticker-frozen={captureTickerFrozen ? "true" : undefined}');
      expect(previewSource.match(/data-capture-ticker-frozen=\{captureTickerFrozen \? "true" : undefined\}/g)).toHaveLength(2);
      expect(previewSource).toMatch(/data-capture-ticker-frozen="true"[^}]*\.ticker-line[\s\S]*animation: none !important/);
      const captureSource = readFileSync(capturePath, "utf-8");
      const requiredReportSource = captureSource.slice(
        captureSource.indexOf("function assertRequiredReport"),
        captureSource.indexOf("export function assertDesignAlignmentCompressedStage"),
      );
      expect(requiredReportSource).toContain("assertDesignCaptureTickerFreeze(record)");
      const frozenRecord = {
        schemaVersion: 2,
        manifestKey: "standby-design-alignment-compressed|1280x720|0|1|",
        scenario: "standby-design-alignment-compressed",
        urlIdentity: "/preview.html?nav=0&captureTicker=frozen#standby-design-alignment-compressed",
        geometry: {
          captureTickerFrozen: true,
          tickerLineAnimations: [
            { index: 0, animationName: "none" },
            { index: 1, animationName: "none" },
          ],
        },
      };
      expect(capture.assertDesignCaptureTickerFreeze(frozenRecord)).toEqual({
        urlParameter: "frozen", attribute: true, animationNames: ["none", "none"],
      });
      expect(() => capture.assertDesignCaptureTickerFreeze({
        ...frozenRecord,
        urlIdentity: "/preview.html?nav=0#standby-design-alignment-compressed",
      })).toThrow(/captureTicker=frozen/);
      expect(() => capture.assertDesignCaptureTickerFreeze({
        ...frozenRecord,
        geometry: { ...frozenRecord.geometry, captureTickerFrozen: false },
      })).toThrow(/data-capture-ticker-frozen/);
      expect(() => capture.assertDesignCaptureTickerFreeze({
        ...frozenRecord,
        geometry: { ...frozenRecord.geometry, tickerLineAnimations: [{ index: 0, animationName: "ticker-scroll" }] },
      })).toThrow(/animationName expected none/);
      expect(capture.diffDesignDomTrace(
        [{ selector: "html:nth-of-type(1) > body:nth-of-type(1)", attributes: { "data-stage": "2" }, text: "前" }],
        [{ selector: "html:nth-of-type(1) > body:nth-of-type(1)", attributes: { "data-stage": "3" }, text: "後" }],
      )).toEqual([
        {
          selector: "html:nth-of-type(1) > body:nth-of-type(1)",
          attributeName: "data-stage", beforeValue: "2", afterValue: "3",
        },
        {
          selector: "html:nth-of-type(1) > body:nth-of-type(1)",
          attributeName: "#text", beforeValue: "前", afterValue: "後",
        },
      ]);
      expect(capture.diffDesignDomHtml(
        '<html data-stage="2"><body>前</body></html>',
        '<html data-stage="3"><body>後</body></html>',
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({ selector: "html:nth-of-type(1)", attributeName: "data-stage", beforeValue: "2", afterValue: "3" }),
        expect.objectContaining({ attributeName: "#text", beforeValue: "前", afterValue: "後" }),
      ]));

      const documents = ["before", "after"].map((state) => ({
        document: {
          dom: `<html data-preview-mode="emergency" data-stage="${state}"></html>`,
          stableDom: `<html data-preview-mode="emergency" data-stage="${state}"></html>`,
        },
        designGeometry: { ready: true },
      }));
      await expect(capture.runDesignCaptureSession({
        chrome: "chrome", profileDir: "/capture-profile", url: "https://capture.invalid/",
        viewport: { label: "1280x720", width: 1280, height: 720 }, viewportMode: "calibrated",
        entry: { scenario: "standby-design-alignment-compressed", viewport: "1280x720", rotationTick: 0, cardPageTick: 1, query: "" },
        sessionRunner: async (options: Record<string, unknown>) => {
          const collectSnapshot = options.collectSnapshot as (input: {
            evaluate(expression: string): Promise<Record<string, unknown>>;
          }) => Promise<Record<string, unknown>>;
          for (const rawSnapshot of documents) await collectSnapshot({ evaluate: async () => rawSnapshot });
          throw new Error("design-alignment cell: DOM state changed while capturing screenshot");
        },
      })).rejects.toThrow(/domDiff=.*"selector":"html:nth-of-type\(1\)".*"attributeName":"data-stage".*"beforeValue":"before".*"afterValue":"after"/);
    });

    it("変更 item が code-only だけなら surface 全体を隠す", () => {
      const codeOnly = changeItem("kindChanged", "同一ラベル", 0);
      codeOnly.before = { ...codeOnly.before!, kindShortName: "大雨" };
      codeOnly.after = { ...codeOnly.after!, kindShortName: "大雨" };
      const { container } = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange({ changes: [codeOnly] }) }),
      });
      expect(container.querySelector(".weather-change")).toBeFalsy();
    });

    it.each([
      ["added", "追加地域 — 追加: L4 大雨警報"],
      ["released", "解除地域 — 解除: L4 大雨警報"],
      ["upgraded", "悪化地域 — 種別: L4 大雨警報 → L5 大雨特別警報"],
      ["downgraded", "緩和地域 — 種別: L5 大雨特別警報 → L4 大雨警報"],
      ["kindChanged", "変更地域 — 種別: L4 洪水警報 → L4 大雨警報"],
    ] as const)("%s の前後文言を DOM に固定する", async (kind, expected) => {
      const entry = changeItem(kind, expected.slice(0, 4), 0);
      if (kind === "added") {
        entry.after = { kindShortName: "大雨警報", kindCode: "03", displaySeverity: "officialL4", officialAlertLevel: 4 };
      } else if (kind === "released") {
        entry.before = { kindShortName: "大雨警報", kindCode: "03", displaySeverity: "officialL4", officialAlertLevel: 4 };
      } else if (kind === "upgraded") {
        entry.before = { kindShortName: "大雨警報", kindCode: "03", displaySeverity: "officialL4", officialAlertLevel: 4 };
        entry.after = { kindShortName: "大雨特別警報", kindCode: "33", displaySeverity: "officialL5", officialAlertLevel: 5 };
      } else if (kind === "downgraded") {
        entry.before = { kindShortName: "大雨特別警報", kindCode: "33", displaySeverity: "officialL5", officialAlertLevel: 5 };
        entry.after = { kindShortName: "大雨警報", kindCode: "03", displaySeverity: "officialL4", officialAlertLevel: 4 };
      } else {
        entry.before = { kindShortName: "洪水警報", kindCode: "04", displaySeverity: "officialL4", officialAlertLevel: 4 };
        entry.after = { kindShortName: "大雨警報", kindCode: "03", displaySeverity: "officialL4", officialAlertLevel: 4 };
      }
      const geometry = installWeatherGeometry();
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ change: weatherChange({ changes: [entry] }) }),
      });
      try {
        await settleWeatherLayout();
        expect(rendered.container.querySelector(":scope > .weather-panel > .weather-change-slot .change-chip")?.textContent)
          .toBe(expected.replace(" — 追加: ", "　").replace(" — 解除: ", "　").replace(" — 種別: ", "　"));
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("reduced-motion でも changeKey 差し替え後の変更内容を省略しない", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })) as unknown as typeof window.matchMedia;
      const geometry = installWeatherGeometry();
      try {
        const { container, rerender } = render(WeatherEmergencyPanel, {
          input: weatherInput({ change: weatherChange({ changeKey: "boot:1" }) }),
        });
        flushSync();
        await rerender({
          input: weatherInput({ change: weatherChange({ changeKey: "boot:2" }) }),
        });
        await settleWeatherLayout();
        flushSync();
        expect(container.querySelector(":scope > .weather-panel > .weather-change-slot .weather-change")?.textContent)
          .toContain("悪化地域");
      } finally {
        geometry.restore();
        window.matchMedia = originalMatchMedia;
      }
    });

    it.each([
      [
        "単一種別",
        [weatherItem({ key: "rain", kind: "L5 大雨特別警報" })],
        "大雨特別警報",
      ],
      [
        "同レベル2種",
        [
          weatherItem({ key: "rain", kind: "L5 大雨特別警報" }),
          weatherItem({ key: "landslide", kind: "L5 土砂災害特別警報" }),
        ],
        "土砂災害・大雨特別警報",
      ],
      [
        "同レベル3種以上",
        [
          weatherItem({ key: "storm", kind: "暴風特別警報" }),
          weatherItem({ key: "rain", kind: "L5 大雨特別警報" }),
          weatherItem({ key: "landslide", kind: "L5 土砂災害特別警報" }),
        ],
        "土砂災害ほか特別警報",
      ],
      [
        "種別不明",
        [weatherItem({ key: "unknown", kind: "種別情報なし" })],
        "気象特別警報",
      ],
      [
        "既知・不明混在",
        [
          weatherItem({ key: "rain", kind: "L5 大雨特別警報" }),
          weatherItem({ key: "unknown", kind: "種別情報なし" }),
        ],
        "気象特別警報",
      ],
    ] as const)("ヘッダーに最大レベルの具体種別を出す: %s", (_label, items, expected) => {
      const { container } = render(WeatherEmergencyPanel, {
        input: weatherInput({ items: [...items] }),
      });
      expect(container.querySelector(".heading-text")?.textContent).toBe(expected);
    });

    it("L5 主 + L4 併存では L4 が副セクションへ回り、主セクションには混ざらない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "k5", kind: "L5 大雨特別警報", level: 5 }),
                weatherItem({ key: "k4", kind: "L4 洪水警報", level: 4, source: "vpww56" }),
              ],
            }),
          ),
        ],
      });
      const p = container.querySelector(".weather-panel")!;
      const mainKinds = Array.from(p.querySelectorAll(".tile-where .kind")).map((el) => el.textContent);
      expect(mainKinds).toEqual(["大雨特別警報"]);
      const sub = p.querySelector(".tile-sub")!;
      expect(sub.querySelector(".sub-level")?.textContent).toBe("警戒レベル4相当");
      expect(sub.querySelector(".sub-action")?.textContent).toBe("危険な場所にいる人は全員避難");
      expect(Array.from(sub.querySelectorAll(".kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
      ]);
    });

    it("同じ kind が両 source にあっても行を統合せず、地域数も合算しない (非合算契約)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "a", kind: "L5 大雨特別警報", source: "vpws50", shownAreas: ["東京都"], omittedAreaCount: 2 }),
                weatherItem({ key: "b", kind: "L5 大雨特別警報", source: "vpww56", shownAreas: ["千葉県"], omittedAreaCount: 3 }),
              ],
              truncated: true,
            }),
          ),
        ],
      });
      const rows = container.querySelectorAll(".tile-where .where-row");
      expect(rows.length).toBe(1);
      expect(rows[0]?.querySelector(".omitted")?.textContent).toBe("ほか2地域");
      expect(container.querySelector(".tile-where")?.getAttribute("data-pager-reference-total")).toBe("2");
      // 「何が」の警報名だけは重複を畳む (地域は畳まない)
      expect(container.querySelectorAll(".tile-what .alert-name").length).toBe(1);
    });

    // ユーザー決定 2026-07-26: 省略の告知は行末の「ほか N 地域」「ほか N 種別」に一本化する。
    // 領域下端の固定文「表示は一部です」は主語が無く「ページの一部」と誤読されるうえ、
    // 行末表記が同じことを件数付きで言っているので廃止した
    it("省略があっても領域下端に固定文を出さない (告知は行末の件数に一本化)", () => {
      const areas = Array.from({ length: 20 }, (_, i) => `地域${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              truncated: true,
              items: [weatherItem({ key: "k", kind: "L5 大雨特別警報", shownAreas: areas, omittedAreaCount: 3 })],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-where .partial")).toBeFalsy();
      // provisional でも省略は論理行の最終断片だけへ置く。
      const pagerButtons = container.querySelectorAll<HTMLButtonElement>(".tile-where .page-dot");
      pagerButtons[pagerButtons.length - 1]?.click();
      flushSync();
      expect(container.querySelector(".tile-where .omitted")?.textContent).toBe("ほか11地域");
    });

    // Codex R3 Important: source 違いの同一種別を 2 種別と数えると、実際には何も隠していないのに
    // 「ほか 1 種別」が出る
    it("副セクションの上限は distinct な種別で数える (同一種別が両 source から来ても 1 種別)", () => {
      const subs = [
        weatherItem({ key: "s0", kind: "L4 洪水警報", level: 4, source: "vpws50" }),
        weatherItem({ key: "s1", kind: "L4 洪水警報", level: 4, source: "vpww56" }),
        weatherItem({ key: "s2", kind: "L4 高潮警報", level: 4, source: "vpws50" }),
        weatherItem({ key: "s3", kind: "L4 土砂災害警戒情報", level: 4, source: "vpws50" }),
      ];
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({ items: [weatherItem({ key: "m", kind: "L5 大雨特別警報" }), ...subs] }),
          ),
        ],
      });
      const sub = container.querySelector(".tile-sub")!;
      // 副セクションは地域を持たない種別の要約。洪水警報は source 2 件でも 1 種別に畳む
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
        "高潮警報",
        "土砂災害警戒情報",
      ]);
      expect(sub.querySelector(".sub-omitted")).toBeFalsy();
    });

    // Codex R5 Important: 昇格状態の権威は engine。中身が組めていない窓でも主役表示は畳まない
    it("中身 0 件でもパネルを描き、「同期中」を明示する (フロント独自の降格をしない)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ items: [] }))],
      });
      expect(container.querySelector(".weather-panel")).toBeTruthy();
      expect(container.querySelector(".tile-what .level-label")?.textContent).toBe("警戒レベル5相当");
      expect(container.querySelector(".tile-where .syncing")?.textContent).toBe("対象地域を同期中です");
      // 行動文は engine のレベルから出るので、中身待ちでも「どうする」は出る
      expect(container.querySelector(".action-main")?.textContent).toBe("命の危険 直ちに安全確保");
    });

    it("ready DOM は県見出し・市区町村・raw・共通省略末尾を分離し、追加印を地域だけへ付ける", async () => {
      const geometry = installWeatherGeometry({ areaWidth: 1_200, bodyHeight: 200 });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({
            key: "grouped",
            kind: "L5 大雨特別警報",
            shownAreas: ["福井県福井市", "敦賀市", "宗谷地方", "府中市", "府中市"],
            shownAreaCodes: ["1820100", "1820200", "011000", "1320600", "3420600"],
            addedAreas: ["府中市"],
            addedAreaCodes: ["3420600"],
            omittedAreaCount: 2,
          })],
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(Array.from(where.querySelectorAll(".prefecture-name")).map((node) => node.textContent))
          .toEqual(["福井県", "東京都", "広島県"]);
        expect(Array.from(where.querySelectorAll(".area-name")).map((node) => node.textContent))
          .toEqual(["福井市", "敦賀市", "宗谷地方", "府中市", "府中市"]);
        expect(where.querySelector('[data-group-kind="raw"] .prefecture-name')).toBeFalsy();
        expect(where.querySelectorAll(".omitted")).toHaveLength(1);
        expect(where.querySelector(".omitted")?.textContent).toBe("ほか2地域");
        const fuchu = Array.from(where.querySelectorAll(".area-name"))
          .filter((node) => node.textContent === "府中市");
        expect(fuchu.map((node) => node.classList.contains("added"))).toEqual([false, true]);
        expect(Array.from(where.querySelectorAll(".prefecture-name"))
          .some((node) => node.classList.contains("added"))).toBe(false);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("過高な県 fragment を最大 fitting prefix へ再分割し、継続県見出しと最終省略だけを描く", async () => {
      const geometry = installWeatherGeometry({
        areaWidth: 1_200,
        bodyHeight: 70,
        rowHeight: (row) => 20 + row.querySelectorAll(".area-name").length * 25,
      });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({
            key: "split",
            kind: "L5 大雨特別警報",
            shownAreas: ["福井市", "敦賀市", "大野市", "勝山市"],
            shownAreaCodes: ["1820100", "1820200", "1820500", "1820600"],
            omittedAreaCount: 3,
          })],
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.getAttribute("data-pager-reference-total")).toBe("4");
        expect(where.querySelector(".page-dots")?.getAttribute("aria-label")).toContain("全2ページ");
        expect(Array.from(where.querySelectorAll(".area-name")).map((node) => node.textContent))
          .toEqual(["福井市", "敦賀市"]);
        expect(where.querySelectorAll(".prefecture-name")).toHaveLength(1);
        expect(where.querySelector(".omitted")).toBeFalsy();

        where.querySelectorAll<HTMLButtonElement>(".page-dot")[1]?.click();
        await settleWeatherLayout();
        expect(Array.from(where.querySelectorAll(".area-name")).map((node) => node.textContent))
          .toEqual(["大野市", "勝山市"]);
        expect(where.querySelectorAll(".prefecture-name")).toHaveLength(1);
        expect(where.querySelector(".where-row")?.getAttribute("data-continued")).toBe("true");
        expect(where.querySelector(".omitted")?.textContent).toBe("ほか3地域");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("同じ generation でも名称訂正は新 base epoch となり、旧 split を捨てて再結合する", async () => {
      const geometry = installWeatherGeometry({
        areaWidth: 1_200,
        bodyHeight: 70,
        rowHeight: (row) => row.textContent?.includes("短")
          ? 50
          : 20 + row.querySelectorAll(".area-name").length * 25,
      });
      const codes = ["1820100", "1820200", "1820500", "1820600"];
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({
            key: "corrected",
            kind: "L5 大雨特別警報",
            shownAreas: ["非常に長い地域一", "非常に長い地域二", "非常に長い地域三", "非常に長い地域四"],
            shownAreaCodes: codes,
          })],
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.querySelector(".page-dots")?.getAttribute("aria-label")).toContain("全2ページ");

        await rendered.rerender({
          input: weatherInput({
            items: [weatherItem({
              key: "corrected",
              kind: "L5 大雨特別警報",
              shownAreas: ["短一", "短二", "短三", "短四"],
              shownAreaCodes: codes,
            })],
          }),
          reducedMotionInput: true,
        });
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.querySelector(".page-dots")).toBeFalsy();
        expect(Array.from(where.querySelectorAll(".area-name")).map((node) => node.textContent))
          .toEqual(["短一", "短二", "短三", "短四"]);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("単一地域さえ収まらない場合は infeasible 1ページだけを公開し、部分表示しない", async () => {
      const geometry = installWeatherGeometry({ bodyHeight: 70, rowHeight: () => 80 });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({
            key: "too-tall",
            kind: "L5 大雨特別警報",
            shownAreas: ["極端に長い地域名称"],
            shownAreaCodes: ["1820100"],
            omittedAreaCount: 4,
          })],
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("infeasible");
        expect(where.querySelector('[role="status"]')?.textContent)
          .toContain("対象地域の一覧を表示できません");
        expect(where.querySelector(".area-name")).toBeFalsy();
        expect(where.querySelector(".prefecture-name")).toBeFalsy();
        expect(where.querySelector(".omitted")).toBeFalsy();
        expect(where.querySelector(".page-dots")).toBeFalsy();
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("omission-only は警報種別と共通の『ほかN地域』だけを同じ測定経路で描く", async () => {
      const geometry = installWeatherGeometry({ bodyHeight: 70 });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({
            key: "only-omitted",
            kind: "L5 大雨特別警報",
            shownAreas: [],
            omittedAreaCount: 9,
          })],
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.querySelector(".where-row")?.getAttribute("data-fragment-type"))
          .toBe("omission-only");
        expect(where.querySelector(".kind")?.textContent).toBe("大雨特別警報");
        expect(where.querySelector(".omitted")?.textContent).toBe("ほか9地域");
        expect(where.querySelector(".area-group")).toBeFalsy();
        expect(where.querySelector(".area-name")).toBeFalsy();
        expect(where.querySelector(".prefecture-name")).toBeFalsy();
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("pending では activation を消費せず、測定完了で初めて追加地域の final page へ jump する", async () => {
      const geometry = installWeatherGeometry({ bodyHeight: 35, measureFragments: false });
      const items = [
        weatherItem({ key: "plain", kind: "L5 大雨特別警報", shownAreas: ["福井市"], shownAreaCodes: ["1820100"] }),
        weatherItem({
          key: "target",
          kind: "L5 暴風特別警報",
          shownAreas: ["敦賀市"],
          shownAreaCodes: ["1820200"],
          addedAreas: ["敦賀市"],
          addedAreaCodes: ["1820200"],
        }),
      ];
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ items, firstPageRowKey: "target" }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("pending");
        expect(where.querySelector(".page-dot.current")?.getAttribute("aria-label")).toBe("1/2ページ");

        geometry.setMeasureFragments(true);
        geometry.fireAll();
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.querySelector(".page-dot.current")?.getAttribute("aria-label")).toBe("2/2ページ");
        expect(where.querySelector(".area-name.added")?.textContent).toBe("敦賀市");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("消費済み activation は infeasible を経て同じ final へ戻っても再 jump しない", async () => {
      const geometry = installWeatherGeometry({
        bodyHeight: 35,
        rowHeight: (row) => row.textContent?.includes("OVER") ? 80 : 30,
      });
      const readyItems = [
        weatherItem({ key: "plain", kind: "L5 大雨特別警報", shownAreas: ["福井市"] }),
        weatherItem({ key: "target", kind: "L5 暴風特別警報", shownAreas: ["敦賀市"], addedAreas: ["敦賀市"] }),
      ];
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ items: readyItems, firstPageRowKey: "target" }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.querySelector(".page-dot.current")?.getAttribute("aria-label")).toBe("2/2ページ");

        await rendered.rerender({
          input: weatherInput({
            items: [weatherItem({ key: "over", kind: "L5 OVER特別警報", shownAreas: ["OVER"] })],
            firstPageRowKey: "target",
          }),
          reducedMotionInput: true,
        });
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("infeasible");

        await rendered.rerender({
          input: weatherInput({ items: readyItems, firstPageRowKey: "target" }),
          reducedMotionInput: true,
        });
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.querySelector(".page-dot.current")?.getAttribute("aria-label")).toBe("1/2ページ");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("未消費 activation は syncing から ready へ回復した時に一度だけ追加地域へ jump する", async () => {
      const geometry = installWeatherGeometry({ bodyHeight: 35 });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ items: [], firstPageRowKey: "target" }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("syncing");
        expect(where.querySelector(".page-dots")).toBeFalsy();

        const items = [
          weatherItem({ key: "plain", kind: "L5 大雨特別警報", shownAreas: ["福井市"] }),
          weatherItem({
            key: "target",
            kind: "L5 暴風特別警報",
            shownAreas: ["敦賀市"],
            addedAreas: ["敦賀市"],
          }),
        ];
        await rendered.rerender({
          input: weatherInput({ items, firstPageRowKey: "target" }),
          reducedMotionInput: true,
        });
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.querySelector(".page-dot.current")?.getAttribute("aria-label")).toBe("2/2ページ");
        expect(where.querySelector(".area-name.added")?.textContent).toBe("敦賀市");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("未消費 activation は infeasible から ready へ回復した時にも一度だけ追加地域へ jump する", async () => {
      const geometry = installWeatherGeometry({
        bodyHeight: 35,
        rowHeight: (row) => row.textContent?.includes("BLOCKED") ? 80 : 30,
      });
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({ key: "blocked", kind: "L5 BLOCKED特別警報", shownAreas: ["BLOCKED"] })],
          firstPageRowKey: "target",
        }),
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        expect(where.getAttribute("data-layout-state")).toBe("infeasible");

        const items = [
          weatherItem({ key: "plain", kind: "L5 大雨特別警報", shownAreas: ["福井市"] }),
          weatherItem({
            key: "target",
            kind: "L5 暴風特別警報",
            shownAreas: ["敦賀市"],
            addedAreas: ["敦賀市"],
          }),
        ];
        await rendered.rerender({
          input: weatherInput({ items, firstPageRowKey: "target" }),
          reducedMotionInput: true,
        });
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(where.querySelector(".page-dot.current")?.getAttribute("aria-label")).toBe("2/2ページ");
        expect(where.querySelector(".area-name.added")?.textContent).toBe("敦賀市");
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it.each([
      ["1920×1080 normal", false, 900, 300, 700, 120, 560],
      ["1920×1080 compact", true, 520, 230, 420, 90, 280],
      ["1280×720 normal", false, 640, 210, 500, 90, 360],
      ["1280×720 compact", true, 420, 180, 300, 70, 240],
    ] as const)("%s の全 final page と syncing / infeasible が基準 body 内に収まり frame 寸法を変えない", async (
      _label,
      compact,
      frameWidth,
      frameHeight,
      bodyWidth,
      bodyHeight,
      areaWidth,
    ) => {
      const geometry = installWeatherGeometry({
        frameWidth,
        frameHeight,
        bodyWidth,
        bodyHeight,
        areaWidth,
        rowHeight: (row) => row.textContent?.includes("OVERFLOW")
          ? bodyHeight + 10
          : Math.max(1, Math.floor(bodyHeight * 0.55)),
      });
      const fukuiAreas = Array.from({ length: 8 }, (_, index) => `福井市${index}`);
      const readyInput = weatherInput({
        items: [
          weatherItem({
            key: "pref",
            kind: "L5 大雨特別警報",
            shownAreas: fukuiAreas,
            shownAreaCodes: fukuiAreas.map((_, index) => `1820${String(100 + index)}`),
          }),
          weatherItem({
            key: "same-name-prefectures",
            kind: "L5 土砂災害特別警報",
            shownAreas: ["府中市", "府中市"],
            shownAreaCodes: ["1320600", "3420600"],
          }),
          weatherItem({
            key: "raw",
            kind: "L5 暴風特別警報",
            shownAreas: ["宗谷地方", "奄美地方"],
            shownAreaCodes: ["011000", "460040"],
          }),
          weatherItem({
            key: "omission-only",
            kind: "L5 高潮特別警報",
            shownAreas: [],
            omittedAreaCount: 4,
          }),
          ...["北海道", "青森県", "岩手県", "宮城県"].map((name, index) => weatherItem({
            key: `extra-${index}`,
            kind: `L5 追加検証特別警報${index}`,
            shownAreas: [`${name}地域`],
            shownAreaCodes: [`0${index + 1}20000`],
          })),
        ],
      });
      const rendered = render(WeatherEmergencyPanel, {
        input: readyInput,
        compact,
        reducedMotionInput: true,
      });
      try {
        await settleWeatherLayout();
        const where = rendered.container.querySelector(".tile-where")!;
        const frame = where.getBoundingClientRect();
        expect([frame.width, frame.height]).toEqual([frameWidth, frameHeight]);
        expect(where.getAttribute("data-layout-state")).toBe("ready");
        expect(Number(where.getAttribute("data-pager-reference-total"))).toBeGreaterThan(7);
        const pageLabel = where.querySelector(".page-dots")?.getAttribute("aria-label") ?? "";
        const total = Number(pageLabel.match(/全(\d+)ページ/)?.[1] ?? 1);
        expect(total).toBeGreaterThan(7);
        const seenPrefectures = new Set<string>();
        const seenGroupKinds = new Set<string>();
        let sawContinued = false;
        let sawOmissionOnly = false;
        for (let pageIndex = 0; pageIndex < total; pageIndex += 1) {
          if (total > 1) {
            const target = Array.from(where.querySelectorAll<HTMLButtonElement>(".page-dot"))
              .find((button) => button.getAttribute("aria-label") === `${pageIndex + 1}/${total}ページ`);
            expect(target).toBeTruthy();
            target?.click();
            await settleWeatherLayout();
          }
          expect(where.querySelectorAll(".page-dots .page-dot, .page-dots .page-ellipsis").length)
            .toBeLessThanOrEqual(7);
          for (const name of where.querySelectorAll(".page-fade .prefecture-name")) {
            if (name.textContent != null) seenPrefectures.add(name.textContent);
          }
          for (const row of where.querySelectorAll<HTMLElement>(".page-fade .where-row")) {
            const groupKind = row.dataset.groupKind;
            if (groupKind != null) seenGroupKinds.add(groupKind);
            sawContinued ||= row.dataset.continued === "true";
            sawOmissionOnly ||= row.dataset.fragmentType === "omission-only";
          }
          const used = Array.from(where.querySelectorAll(".page-fade .where-row"))
            .reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
          expect(used).toBeLessThanOrEqual(bodyHeight);
        }
        expect(seenPrefectures).toEqual(new Set(["福井県", "東京都", "広島県", "北海道", "青森県", "岩手県", "宮城県"]));
        expect(seenGroupKinds).toEqual(new Set(["prefecture", "raw"]));
        expect(sawContinued).toBe(true);
        expect(sawOmissionOnly).toBe(true);

        await rendered.rerender({
          input: weatherInput({ items: [] }),
          compact,
          reducedMotionInput: true,
        });
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("syncing");
        expect(where.querySelector(".syncing")?.textContent).toBe("対象地域を同期中です");
        expect(where.querySelector(".syncing")!.getBoundingClientRect().height)
          .toBeLessThanOrEqual(bodyHeight);
        expect([where.getBoundingClientRect().width, where.getBoundingClientRect().height])
          .toEqual([frameWidth, frameHeight]);

        await rendered.rerender({
          input: weatherInput({
            items: [weatherItem({ key: "overflow", kind: "L5 OVERFLOW特別警報", shownAreas: ["OVERFLOW"] })],
          }),
          compact,
          reducedMotionInput: true,
        });
        await settleWeatherLayout();
        expect(where.getAttribute("data-layout-state")).toBe("infeasible");
        expect(where.querySelector(".infeasible-message")?.textContent)
          .toBe("対象地域の一覧を表示できません");
        expect(where.querySelector(".infeasible-row")!.getBoundingClientRect().height)
          .toBeLessThanOrEqual(bodyHeight);
        expect([where.getBoundingClientRect().width, where.getBoundingClientRect().height])
          .toEqual([frameWidth, frameHeight]);
      } finally {
        rendered.unmount();
        geometry.restore();
      }
    });

    it("pending の同内容再評価は保持時間を再開始せず、10秒で通常巡回する", async () => {
      vi.useFakeTimers();
      const items = [
        weatherItem({ key: "a", kind: "L5 大雨特別警報", shownAreas: ["A"] }),
        weatherItem({ key: "b", kind: "L5 暴風特別警報", shownAreas: ["B"] }),
      ];
      const rendered = render(WeatherEmergencyPanel, {
        input: weatherInput({ items }),
        reducedMotionInput: true,
      });
      try {
        flushSync();
        vi.advanceTimersByTime(PAGE_HOLD_MS - 1);
        await rendered.rerender({
          input: weatherInput({ items: items.map((item) => ({ ...item })) }),
          reducedMotionInput: true,
        });
        flushSync();
        expect(rendered.container.querySelector(".tile-where .page-dot.current")?.getAttribute("aria-label"))
          .toBe("1/2ページ");
        vi.advanceTimersByTime(1);
        flushSync();
        expect(rendered.container.querySelector(".tile-where .page-dot.current")?.getAttribute("aria-label"))
          .toBe("2/2ページ");
      } finally {
        rendered.unmount();
        vi.useRealTimers();
      }
    });

    it("同一 generation の input object 差し替えだけでは provisional partition を reset しない", async () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}`, shownAreas: [`地域${i}`] }),
      );
      const { container, rerender } = render(WeatherEmergencyPanel, {
        input: weatherInput({ items }),
        compact: false,
        layoutSettling: false,
      });
      flushSync();
      container.querySelectorAll<HTMLButtonElement>(".tile-where .page-dot")[2]?.click();
      flushSync();
      expect(container.querySelector(".tile-where .page-dot.current")?.getAttribute("aria-label"))
        .toBe("3/5ページ");

      await rerender({
        input: weatherInput({ items: items.map((item) => ({ ...item })) }),
        compact: false,
        layoutSettling: false,
      });
      flushSync();
      expect(container.querySelector(".tile-where .page-dot.current")?.getAttribute("aria-label"))
        .toBe("3/5ページ");
    });

    // ユーザー指摘 2026-07-26: 電文由来の `L5 大雨特別警報` と `暴風特別警報` (レベル非対応) が
    // 混在して読みづらい。主レベルは見出しで一度示すので、パネル内では接頭辞を落として揃える
    it("警報名の L 接頭辞を落として揃える (レベル非対応の種別と混在させない)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "a", kind: "L5 大雨特別警報" }),
                weatherItem({ key: "b", kind: "暴風特別警報" }),
                weatherItem({ key: "c", kind: "L4 洪水警報", level: 4 }),
              ],
            }),
          ),
        ],
      });
      expect(
        Array.from(container.querySelectorAll(".tile-what .alert-name")).map((el) => el.textContent),
      ).toEqual(["大雨特別警報", "暴風特別警報"]);
      expect(
        Array.from(container.querySelectorAll(".tile-where .kind")).map((el) => el.textContent),
      ).toEqual(["大雨特別警報"]);
      expect(container.querySelector(".tile-where")?.getAttribute("data-pager-reference-total")).toBe("4");
      expect(container.querySelector(".tile-sub .kind")?.textContent).toBe("洪水警報");
      // 見出しの「警戒レベル5相当」がレベルを担うので、行から L が消えても情報は失われない
      expect(container.querySelector(".tile-what .level-label")?.textContent).toBe("警戒レベル5相当");
    });

    // ユーザー指摘 2026-07-26: 区分と地域が font-weight だけで分かれていて視認性が悪い。
    // 遠見・夜間減光ではウェイト差が最初に消えるので、列 + 罫線 + role 色で分ける
    it("「どこ」の行は 2 列グリッドで、地域側に罫線・区分に role 色を持つ", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/\.where-row\s*\{[^}]*display: grid;[^}]*grid-template-columns:/);
      expect(src).toMatch(/\.areas\s*\{[^}]*border-inline-start: 1px solid var\(--hairline\);/);
      expect(src).toMatch(/\.kind\s*\{[^}]*color: var\(--role-weatherWarning\);/);
      expect(src).toMatch(/\.role-weatherEmergency \.where-row \.kind\s*\{[^}]*color: var\(--role-weatherEmergency\);/);
    });

    // ユーザー指摘 2026-07-26: 同格タイルの多用でメリハリが無い。面を持つのは詳細一覧だけにする
    it("面 (surface/影) を持つのは詳細一覧タイルだけで、他 3 領域は面を持たない", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(
        /\.tile-what,\s*\.tile-action,\s*\.tile-sub\s*\{[^}]*background: none;[^}]*box-shadow: none;/,
      );
      // どうする = role 色の縦レール、副節 = 髪の毛罫のみ
      expect(src).toMatch(/\.tile-action\s*\{[^}]*border-inline-start: var\(--header-band-width\) solid var\(--role-weatherWarning\)/);
      expect(src).toMatch(/\.tile-sub\s*\{[^}]*border-top: 1px solid var\(--hairline\)/);
    });

    it("ページャは詳細一覧の見出し行にあり、省略の告知とは場所を分ける", () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ items }))],
      });
      expect(container.querySelector(".where-head .section-label")?.textContent).toBe("対象地域・区分");
      expect(container.querySelector(".where-head .page-dots")).toBeTruthy();
    });

    it("live where-body の resize を base epoch geometry へ逆流させず、基準棚だけを測る", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toContain("use:measureReferenceBody");
      expect(src).not.toContain("use:observeWhereArea");
      expect(src).not.toContain("bind:this={whereBodyEl}");
    });

    // ── spec 追補 (2026-07-26/27): 新規/更新バッジ・追加地域ハイライト・再点灯 ──

    it("新規発表・更新発表を見出し直後に出し、右端には source の更新時刻を出す", () => {
      const cases: Array<[("new" | "update" | null), string | null]> = [
        ["new", "新規発表"],
        ["update", "更新発表"],
        [null, null],
      ];
      for (const [trigger, label] of cases) {
        const { container, unmount } = render(EmergencyScreen, {
          panels: [panel("weather:current", weatherInput({ trigger }))],
        });
        expect(container.querySelector(".heading-title .trigger-badge")?.textContent ?? null).toBe(label);
        expect(container.querySelector(".heading > .updated-stamp")?.textContent).toBe("更新 7/25 10:00");
        const headingTitle = container.querySelector(".heading-title");
        expect(headingTitle?.firstElementChild?.classList.contains("heading-text")).toBe(true);
        expect(headingTitle?.lastElementChild?.classList.contains(
          label == null ? "heading-text" : "trigger-badge",
        )).toBe(true);
        unmount();
      }
    });

    it("追加された地域だけに下線ハイライトが付く", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({
                  key: "k",
                  kind: "L5 大雨特別警報",
                  shownAreas: ["東京都", "千葉県"],
                  addedAreas: ["千葉県"],
                }),
              ],
            }),
          ),
        ],
      });
      let areas = Array.from(container.querySelectorAll(".tile-where .area-name"));
      expect(areas.map((el) => [el.textContent, el.classList.contains("added")]))
        .toEqual([["東京都", false]]);
      container.querySelectorAll<HTMLButtonElement>(".tile-where .page-dot")[1]?.click();
      flushSync();
      areas = Array.from(container.querySelectorAll(".tile-where .area-name"));
      expect(areas.map((el) => [el.textContent, el.classList.contains("added")]))
        .toContainEqual(["千葉県", true]);
    });

    it("同名地域でも Area.Code が一致する追加地域だけを下線にする", () => {
      const { container } = render(WeatherEmergencyPanel, {
        input: weatherInput({
          items: [weatherItem({
            key: "k", kind: "L5 大雨特別警報",
            shownAreas: ["府中市", "府中市"],
            shownAreaCodes: ["1320600", "3420600"],
            addedAreas: ["府中市"],
            addedAreaCodes: ["3420600"],
          })],
        }),
      });
      container.querySelectorAll<HTMLButtonElement>(".tile-where .page-dot")[1]?.click();
      flushSync();
      const areas = Array.from(container.querySelectorAll(".tile-where .area-name"));
      expect(areas.map((el) => [el.textContent, el.classList.contains("added")]))
        .toContainEqual(["府中市", true]);
    });

    // ご主人決定 2026-07-27: 「L5 継続中に L4 の地域が増えた」で更新点灯するのに、下位レベルが
    // 種別名 + 件数へ畳まれているとどこが増えたのか一度も読めない。追加が起きた下位行だけを
    // 例外として地域名つきでページ送り列に出す
    it("追加を含む下位レベルの行だけ、地域名つきでページ送り列に出る", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "m", kind: "L5 大雨特別警報", shownAreas: ["東京都"] }),
                weatherItem({
                  key: "s-added",
                  kind: "L4 洪水警報",
                  level: 4,
                  shownAreas: ["千葉県", "茨城県"],
                  addedAreas: ["茨城県"],
                }),
                // 追加を含まない下位行は従来どおり要約のまま (地域名を出さない)
                weatherItem({ key: "s-plain", kind: "L4 高潮警報", level: 4, shownAreas: ["静岡県"] }),
              ],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-where")?.getAttribute("data-pager-reference-total")).toBe("3");
      container.querySelectorAll<HTMLButtonElement>(".tile-where .page-dot")[2]?.click();
      flushSync();
      const rows = Array.from(container.querySelectorAll(".tile-where .where-row"));
      const subRow = rows.find((row) => row.querySelector(".kind")?.textContent === "L4洪水警報")!;
      // 下位レベルの行はレベル印を持ち、主レベルの意味色を借りない
      expect(subRow.classList.contains("sub-level-row")).toBe(true);
      expect(subRow.querySelector(".row-level")?.textContent).toBe("L4");
      // 追加された地域だけに下線が付く
      const areas = Array.from(subRow.querySelectorAll(".area-name"));
      expect(areas.map((el) => [el.textContent, el.classList.contains("added")]))
        .toEqual([["茨城県", true]]);
      // 副セクションの要約は下位レベルの全種別を持ったまま (巡回で別ページでも種別は読める)
      const sub = container.querySelector(".tile-sub")!;
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
        "高潮警報",
      ]);
    });

    it("ハイライトは文字色を触らず、下線と色以外の手掛かりを併用する (critical overlay 耐性)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      const rule = src.match(/\.area-name\.added\s*\{[^}]*\}/)?.[0] ?? "";
      expect(rule).toContain("text-decoration");
      expect(rule).not.toMatch(/(^|[^-])color:/); // 文字色は触らない
      expect(src).toMatch(/\.area-name\.added::before\s*\{[^}]*content:/); // 色に依存しない手掛かり
    });

    // spec 追補 C1: パネル key は固定なので、これが無いと内容更新で画面が動かない
    it("activationKey が変わると中身が差し替わる (再点灯演出の契機)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toContain("{#key input.activationKey}");
      // 外側 key に混ぜない (レイアウト補間と実測状態を壊さない)
      const derive = readFileSync(join(__dirname, "..", "..", "lib", "derive.ts"), "utf-8");
      expect(derive).toContain('key: "weather:current"');
      expect(derive).not.toMatch(/key: `weather:current[^`]*\$\{/);
    });

    it("activation 初期 jump は component-local guard を null 初期化し、ready effect 内で jump 成功後に消費する", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toContain("let consumedActivationKey: string | null = null");
      expect(src).toContain("cycler.jumpTo(targetIndex, { immediate: false })");
      const jumpAt = src.lastIndexOf("cycler.jumpTo(targetIndex, { immediate: false })");
      const consumeAt = src.lastIndexOf("consumedActivationKey = activationKey");
      expect(jumpAt).toBeGreaterThan(0);
      expect(consumeAt).toBeGreaterThan(jumpAt);
      expect(src.slice(src.lastIndexOf("$effect(() =>", jumpAt), consumeAt)).toContain("untrack(() =>");
    });

    it("EmergencyScreen は気象パネルにもレイアウト整定フラグを渡す", () => {
      const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
      expect(src).toMatch(/<WeatherEmergencyPanel[^>]*layoutSettling=\{settling\}/);
    });

    it("layoutSettling 中と callback 不足時は pending / provisional を維持する", async () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}`, shownAreas: [`地域${i}`] }),
      );
      const { container, rerender } = render(WeatherEmergencyPanel, {
        input: weatherInput({ items }),
        compact: false,
        layoutSettling: true,
      });
      flushSync();
      expect(container.querySelector(".tile-where")?.getAttribute("data-layout-state")).toBe("pending");
      expect(container.querySelector(".measurement-fragments")).toBeFalsy();

      await rerender({ input: weatherInput({ items }), compact: false, layoutSettling: false });
      flushSync();
      expect(container.querySelector(".tile-where")?.getAttribute("data-layout-state")).toBe("pending");
      expect(container.querySelector(".tile-where")?.getAttribute("data-pager-reference-total")).toBe("5");
    });

    // ユーザー決定 2026-07-26: 区分一覧は上限を掛けず折り返して全種別を載せる。
    // 上限 + 「ほか N 種別」だと、最上級レベルに何が出ているかが件数へ丸められる
    it("区分一覧は種別数によらず全種別を載せる (件数に丸めない)", () => {
      const items = Array.from({ length: 7 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ items }))],
      });
      const what = container.querySelector(".tile-what")!;
      expect(what.querySelectorAll(".alert-name").length).toBe(7);
      expect(what.querySelector(".name-omitted")).toBeFalsy();
    });

    // ユーザー決定 2026-07-26: 副セクションは主役スロットでも compact でも「地域を持たない要約」。
    // 地域行を並べると折返しで高さが青天井になり、ページ送りの無い固定領域では黙って切られる
    it("副セクションは地域行を持たず、種別名だけを並べる (主役スロットでも同じ)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "m", kind: "L5 大雨特別警報" }),
                weatherItem({ key: "s0", kind: "L4 洪水警報", level: 4, shownAreas: ["千葉県", "茨城県"] }),
              ],
            }),
          ),
        ],
      });
      const sub = container.querySelector(".tile-sub")!;
      expect(sub.querySelectorAll(".where-row").length).toBe(0);
      expect(sub.querySelectorAll(".area-name").length).toBe(0);
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
      ]);
      expect(sub.querySelector(".sub-omitted")).toBeFalsy();
    });

    // ユーザー決定 2026-07-26: 区分は compact でも全種別を載せる (最上級の中身を件数へ丸めない)。
    // 補助行だけは主役スロット限定にして、狭い枠では主情報へ高さを回す
    it("compact でも区分一覧は全種別を載せ、補助行だけを省く", () => {
      const items = Array.from({ length: 4 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [panel("eew:1", eewInput()), panel("weather:current", weatherInput({ items }))],
      });
      const p = container.querySelector(".weather-panel.compact")!;
      expect(p.querySelectorAll(".tile-what .alert-name").length).toBe(4);
      expect(p.querySelector(".tile-what .name-omitted")).toBeFalsy();
      expect(p.querySelector(".action-note")).toBeFalsy();
      // compact だけはレベルと行動文を 1 行に束ねて縦を節約する
      expect(p.querySelector(".hero.merged")).toBeTruthy();
      expect(p.querySelector(".hero .level-label")?.textContent).toBe("警戒レベル5相当");
      expect(p.querySelector(".hero .action-main")?.textContent).toBe("命の危険 直ちに安全確保");
    });

    it("主役スロットではレベルと行動文を束ねず、行動レールに補助行も出す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      // ヒーロー行はレベルのみ (行動文を束ねない)
      expect(container.querySelector(".hero .action-main")).toBeFalsy();
      expect(container.querySelector(".hero.merged")).toBeFalsy();
      expect(container.querySelector(".tile-action .action-note")?.textContent).toContain("自治体が発令する");
    });

    // Codex 最終レビュー: critical tier では TierOverlay の全画面フィルム (最大 α=0.34) が
    // 文字にも背景にも掛かり、合成後は意味色が AA を割る (weatherEmergency 3.21〜3.66:1)。
    // 主要な文字を --fg へ退避する。この退避を外すと監査表の該当ペアが FAIL として現れる
    // (許容リスト critical-overlay-weather-role-not-used-as-text の前提でもある)
    it("critical tier では主要な文字を --fg へ退避する (overlay 合成後の AA 割れ回避)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      const rule = src.match(
        /:global\(main\[data-tier="critical"\]\)[\s\S]*?\{\s*color: var\(--fg\);\s*\}/,
      )?.[0];
      expect(rule, "critical tier の退避規則が無い").toBeTruthy();
      for (const sel of [".level-label", ".action-main", ".where-row .kind", ".sub-kinds .kind", ".sub-level"]) {
        expect(rule).toContain(sel);
      }
      // 意味色は看板ヘッダ帯と行動レール (非テキスト) に残す
      expect(src).toMatch(/\.role-weatherEmergency \.heading\s*\{[^}]*background: var\(--header-weatherEmergency-container\)/);
      expect(src).toMatch(/\.role-weatherEmergency \.tile-action\s*\{[^}]*border-inline-start-color: var\(--role-weatherEmergency\)/);
    });

    it("L5 ヘッダーだけ白背景・黒字に反転し、L4 以下は既存配色を維持する", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/\.level-5 \.heading\s*\{[^}]*background: #fff;[^}]*color: #000;/);
      expect(src).toMatch(/\.heading\s*\{[^}]*background: var\(--header-weatherWarning-container\);[^}]*color: var\(--header-weatherWarning-on\);/);

      const l5 = render(WeatherEmergencyPanel, { input: weatherInput({ level: 5 }) }).container;
      expect(l5.querySelector(".weather-panel")?.classList.contains("level-5")).toBe(true);
      const l4 = render(WeatherEmergencyPanel, {
        input: weatherInput({
          level: 4,
          items: [weatherItem({ key: "flood", kind: "L4 洪水警報", level: 4 })],
        }),
      }).container;
      expect(l4.querySelector(".weather-panel")?.classList.contains("level-4")).toBe(true);
      expect(l4.querySelector(".weather-panel")?.classList.contains("level-5")).toBe(false);
    });

    // ユーザー指摘 2026-07-26: 行動文 (最長 14 文字) が行動レールの幅で折り返すと視線が切れる。
    // パネルの container query 単位で上限を掛け、読める範囲まで自動で縮める
    it("行動文は折り返さず、コンテナ幅に対する可変サイズになる", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/\.action-main\s*\{[^}]*white-space: nowrap;/);
      expect(src).toMatch(/\.action-main\s*\{[^}]*font-size: min\([^)]*\)[^;]*cqw\)/);
      // bento (行動レールが 1fr 列に入る) では上限をその幅で採り直す
      expect(src).toMatch(/@container \(min-width: 860px\)[\s\S]*\.action-main\s*\{[^}]*cqw/);
      // container query 単位が効くよう、パネルは container-type: inline-size を持つ
      expect(src).toMatch(/\.weather-panel\s*\{[^}]*container-type: inline-size;/);
    });

    // ユーザー指摘 2026-07-26: 「相当」は「警戒レベル5」に従属する語なので一段小さく出す
    it("「警戒レベルN」と「相当」を別要素にして従属を型サイズで示す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      const label = container.querySelector(".tile-what .level-label")!;
      expect(label.textContent).toBe("警戒レベル5相当");
      expect(label.querySelector(".level-suffix")?.textContent).toBe("相当");
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/\.level-suffix\s*\{[^}]*font-size: 0\.\d+em;/);
    });

    it("compact でも控え由来なら同期中チップは残す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel("eew:1", eewInput()),
          panel("weather:current", weatherInput({ restored: true })),
        ],
      });
      expect(container.querySelector(".weather-panel.compact .tile-what .restored-chip")).toBeTruthy();
    });

    it("compact でも同じ要約になる (幅で挙動が割れない)", () => {
      const subs = [
        weatherItem({ key: "s0", kind: "L4 洪水警報", level: 4, source: "vpws50" }),
        weatherItem({ key: "s1", kind: "L4 洪水警報", level: 4, source: "vpww56" }),
        weatherItem({ key: "s2", kind: "L4 高潮警報", level: 4 }),
      ];
      const { container } = render(EmergencyScreen, {
        panels: [
          panel("eew:1", eewInput()),
          panel(
            "weather:current",
            weatherInput({ items: [weatherItem({ key: "m", kind: "L5 大雨特別警報" }), ...subs] }),
          ),
        ],
      });
      const sub = container.querySelector(".weather-panel.compact .tile-sub")!;
      expect(sub.querySelectorAll(".where-row").length).toBe(0);
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
        "高潮警報",
      ]);
      expect(sub.querySelector(".sub-omitted")).toBeFalsy();
    });

    it("控え (restoredItems) 由来のときは同期中チップを出す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ restored: true }))],
      });
      expect(container.querySelector(".tile-what .restored-chip")).toBeTruthy();
    });

    it("副役スロットでは compact 表示になる", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("eew:1", eewInput()), panel("weather:current", weatherInput())],
      });
      expect(container.querySelector(".weather-panel.compact")).toBeTruthy();
      expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
    });

    it("pending の全 singleton page が10秒周期の巡回で到達できる", () => {
      vi.useFakeTimers();
      try {
        const items = Array.from({ length: 5 }, (_, i) =>
          weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}`, shownAreas: [`地域${i}`] }),
        );
        const { container } = render(EmergencyScreen, {
          panels: [panel("weather:current", weatherInput({ items }))],
        });
        flushSync();
        const kindsOf = (): (string | null)[] =>
          Array.from(container.querySelectorAll(".tile-where .kind")).map((el) => el.textContent);
        expect(kindsOf()).toEqual(["特別警報0"]);
        expectCurrentDot(container.querySelector(".tile-where"), 1, 5);

        vi.advanceTimersByTime(PAGE_HOLD_MS);
        settleFade();
        expect(kindsOf()).toEqual(["特別警報1"]);
        expectCurrentDot(container.querySelector(".tile-where"), 2, 5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("全 refinement fragment と候補 prefix を同型の非表示測定棚へ描く", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toContain("class=\"measurement-shelf\"");
      expect(src).toContain("aria-hidden=\"true\"");
      expect(src).toContain("inert");
      expect(src).toContain("use:measureFragment");
      expect(src).toMatch(/\.measurement-shelf\s*\{[^}]*position: absolute;[^}]*visibility: hidden;[^}]*pointer-events: none;/);
      expect(src).toMatch(/\.measurement-shelf\s*\{[^}]*inline-size: 0;[^}]*block-size: 0;[^}]*contain: size layout;[^}]*overflow: clip;/);
    });

    it("1 ページに収まるときはページャを出さない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({
          items: [weatherItem({ key: "one", kind: "L5 大雨特別警報", shownAreas: ["東京都"] })],
        }))],
      });
      expect(container.querySelector(".tile-where .page-dots")).toBeFalsy();
    });

    it("1 行の地域名が上限を超えたら「ほか N 地域」へ合算する (engine 縮退ぶんと合流)", () => {
      const areas = Array.from({ length: 20 }, (_, i) => `地域${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [weatherItem({ key: "k", kind: "L5 大雨特別警報", shownAreas: areas, omittedAreaCount: 3 })],
            }),
          ),
        ],
      });
      // cap は従来どおり12件。その後、pending は1件ずつ12ページへ展開し、省略は最終ページだけ。
      expect(container.querySelector(".tile-where")?.getAttribute("data-pager-reference-total")).toBe("12");
      expect(container.querySelectorAll(".tile-where .area-name").length).toBe(1);
      const pagerButtons = container.querySelectorAll<HTMLButtonElement>(".tile-where .page-dot");
      pagerButtons[pagerButtons.length - 1]?.click();
      flushSync();
      expect(container.querySelector(".tile-where .omitted")?.textContent).toBe("ほか11地域");
    });

    it("副セクションの種別が上限を超えたら「ほか N 種別」で明示する (黙って消さない)", () => {
      const subs = Array.from({ length: 5 }, (_, i) =>
        weatherItem({ key: `s${i}`, kind: `L4 警報${i}`, level: 4 }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({ items: [weatherItem({ key: "m", kind: "L5 大雨特別警報" }), ...subs] }),
          ),
        ],
      });
      const sub = container.querySelector(".tile-sub")!;
      expect(sub.querySelectorAll(".sub-kinds .kind").length).toBe(3);
      expect(sub.querySelector(".sub-omitted")?.textContent).toBe("ほか2種別");
    });

    it("page-cycler を onDestroy で破棄する (QuakePanel/TsunamiPanel と同じ配線)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/import \{[^}]*\bonDestroy\b[^}]*\} from "svelte"/);
      expect(src).toContain("onDestroy(() => cycler.destroy())");
      expect(src).toContain("../lib/page-cycler.svelte");
    });

    it("主見出しは他パネルと同じ --panel-header-* トークンで高さを揃える", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toContain("--panel-header-min-h");
      expect(src).toContain("--panel-header-padding-v");
      expect(src).toContain("--panel-header-padding-h");
      // 色 role は既存の weatherEmergency / weatherWarning を再利用 (新規 role トークンを作らない)
      expect(src).toMatch(/var\(--header-weather(Emergency|Warning)-container\)/);
      expect(src).toMatch(/var\(--header-band-width\)\s+solid\s+var\(--header-band-weather\w+\)/);
      expect(src).not.toContain("var(--bar-");
    });
  });

  it("⑧ 緊急画面はヘッダ帯の小時計を持たない (第3波でテロップへ移設)", () => {
    const { container } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput())],
    });
    expect(container.querySelector(".clock-corner")).toBeFalsy();
  });

  it("⑨ QuakePanel の地域別震度が待機画面と同じ int-chip 形式で render される", () => {
    const { container } = render(EmergencyScreen, { panels: [panel("quake:1", quakeInput())] });
    expect(container.querySelector(".int-chip.int-r9")).toBeTruthy();
  });

  // compact 切替の遅延 (spec §3): 新規キーは即時、既存キーが主役⇔副役を移るときだけ quick 遷移
  // 完了後に compact を反映する。142ms 内の逆転操作 (割込み → 即取り消し) で古い timer が誤適用
  // されないことを固定する。jsdom は matchMedia 未実装 = reducedMotion false = 遅延が有効。
  it("compact 遅延: 142ms 内の主役⇔副役 逆転操作で古い timer が誤適用されない (spec §3)", async () => {
    vi.useFakeTimers();
    try {
      const quake = panel("quake:1", quakeInput());
      const eew = panel("eew:1", eewInput());
      // 初期: quake 主役 (compact なし) / eew 副役 (compact)
      const { container, rerender } = render(EmergencyScreen, { panels: [quake, eew] });
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();

      // priority 割込みで役割逆転。compact は遷移完了 (142ms) 後に反映されるため、この時点では据え置き
      await rerender({ panels: [eew, quake] });
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();

      // 142ms 未満で元へ戻す (逆転操作) → 保留中の timer は取り消される
      vi.advanceTimersByTime(50);
      await rerender({ panels: [quake, eew] });
      flushSync();

      // 以降いくら時間を進めても古い timer は誤適用されず、元の割り当てのまま
      vi.advanceTimersByTime(500);
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R2: deriveEmergencyPanels() は毎レンダ新配列を返すため、同一目標のまま頻繁に再レンダされると
  // 旧実装は役割変更 timer を毎回張り直して永久に発火しなかった。目標が変わらない再レンダでは timer を
  // 継続させ、142ms 経過で確実に反映されることを固定する。
  it("compact 遅延: 目標が変わらない頻繁な再レンダでも timer が永久リセットされず反映される (Codex R2)", async () => {
    vi.useFakeTimers();
    try {
      const quake = panel("quake:1", quakeInput());
      const eew = panel("eew:1", eewInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [quake, eew] });
      flushSync();
      // 役割逆転: eew 主役 / quake 副役 → quake の compact target が false→true になる (この時点で timer 起動)
      await rerender({ panels: [eew, quake] });
      flushSync();
      // 目標を変えずに 30ms ごとの再レンダを 6 回 (毎レンダ新配列を模す)。142ms を跨ぐが timer は継続すべき
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(30);
        await rerender({ panels: [eew, quake] });
        flushSync();
      }
      vi.advanceTimersByTime(50);
      flushSync();
      // 累計 >142ms: timer が発火し役割変更が反映される (quake 副役=compact / eew 主役=非compact)
      expect(container.querySelector(".quake-panel.compact")).toBeTruthy();
      expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R1: settling は「新しい遷移が始まるたびに fallback timer を張り直す」方式。割込み遷移
  // (142ms 内の再遷移) で先に終わる列の遷移完了が settling を早期解除しないこと (data-settling で観測)。
  it("settling: 割込み遷移で fallback を張り直し、遷移収束まで data-settling を保つ (Codex R1)", async () => {
    vi.useFakeTimers();
    try {
      const p1 = panel("quake:1", quakeInput());
      const p2 = panel("eew:1", eewInput());
      const p3 = panel("tsunami:1", tsunamiInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [p1] });
      flushSync();
      const settling = (): string | null => container.querySelector(".panels")?.getAttribute("data-settling") ?? null;
      // 初期マウントは整定しない
      expect(settling()).toBe("false");

      // 1→2: settling 開始 (fallback fires t=222)
      await rerender({ panels: [p1, p2] });
      flushSync();
      expect(settling()).toBe("true");

      // t=100 で 2→3 に再遷移 → fallback 張り直し (新 fallback fires t=322)
      vi.advanceTimersByTime(100);
      await rerender({ panels: [p1, p2, p3] });
      flushSync();

      // t=250: 旧 fallback (222) の時刻を越えても張り直しにより settling 継続
      vi.advanceTimersByTime(150);
      flushSync();
      expect(settling()).toBe("true");

      // t=450 > 322: 最後の fallback 窓を越えたら解除
      vi.advanceTimersByTime(200);
      flushSync();
      expect(settling()).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R4: TsunamiPanel の compact 配線。副役スロット (index!==0) で compact 表示になる。
  it("TsunamiPanel は副役スロットで compact 表示になり、主役は compact でない (Codex R4)", () => {
    const { container } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput()), panel("tsunami:1", tsunamiInput())],
    });
    expect(container.querySelector(".tsunami-panel.compact")).toBeTruthy();
    expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
  });

  // Codex R6: 遷移中に OS で reduced-motion がオンになると CSS transition は即停止するが、grid sig が
  // 不変だと fallback timer だけが残り settling 解除が最大 222ms 遅延していた。reduced-motion は同期反映
  // 経路として、進行中の fallback を取り消して settling を即時解除する。jsdom は matchMedia 未実装のため
  // 制御可能な matchMedia モックを差し込んで change を発火させる (他テストへ漏らさないよう finally で復元)。
  it("settling: 遷移中に reduced-motion がオンになると fallback を待たず即時解除する (Codex R6)", async () => {
    const origMatchMedia = window.matchMedia;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    let rmMatches = false;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return rmMatches;
      },
      media: query,
      onchange: null,
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      dispatchEvent: () => true,
    })) as unknown as typeof window.matchMedia;
    vi.useFakeTimers();
    try {
      const p1 = panel("quake:1", quakeInput());
      const p2 = panel("eew:1", eewInput());
      const p3 = panel("tsunami:1", tsunamiInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [p1, p2], reducedMotion: false });
      flushSync();
      const settling = (): string | null => container.querySelector(".panels")?.getAttribute("data-settling") ?? null;

      // 2→3: settling 開始 (fallback fires t=222)
      await rerender({ panels: [p1, p2, p3] });
      flushSync();
      expect(settling()).toBe("true");

      // App から reduced-motion が注入されると、grid sig 不変でも fallback を待たず即時解除する。
      vi.advanceTimersByTime(50);
      await rerender({ panels: [p1, p2, p3], reducedMotion: true });
      flushSync();
      expect(settling()).toBe("false");
    } finally {
      vi.useRealTimers();
      if (origMatchMedia === undefined) {
        delete (window as unknown as { matchMedia?: unknown }).matchMedia;
      } else {
        window.matchMedia = origMatchMedia;
      }
    }
  });

  it("⑪ QuakePanel は看板ヘッダ (固定ラベル) + 本文に震源概要を表示する統一文法へ再構成されている", () => {
    const { container } = render(EmergencyScreen, {
      panels: [
        panel(
          "quake:1",
          quakeInput({
            hypocenterName: "浦河沖",
            magnitude: "6.1",
            depth: "30km",
            maxLgInt: "3",
            tsunamiWarning: true,
            originTime: "2026-07-07T09:58:00+09:00",
          }),
        ),
      ],
    });
    // ヘッダは種別名の看板のみ (震源名等の概要を含まない)
    const heading = container.querySelector(".quake-panel .heading");
    expect(heading?.textContent).toContain("地震情報");
    expect(heading?.textContent).not.toContain("浦河沖");
    // 概要情報 (震源名・最大震度・M・深さ・長周期・津波・発生時刻) は本文 (.tiles) 側で値単位に render される
    const tiles = container.querySelector(".quake-panel .tiles");
    expect(tiles?.querySelector(".hypocenter")?.textContent).toContain("浦河沖");
    expect(tiles?.querySelector(".max-int")?.textContent).toContain("最大震度");
    expect(tiles?.querySelector(".stat-value")?.textContent).toContain("6.1");
    expect(
      Array.from(tiles?.querySelectorAll(".stat-value") ?? []).some((el) => el.textContent?.includes("30km")),
    ).toBe(true);
    expect(
      Array.from(tiles?.querySelectorAll(".stat-value") ?? []).some((el) => el.textContent?.includes("3")),
    ).toBe(true);
    expect(tiles?.querySelector(".chip.tsunami-mark")).toBeTruthy();
    expect(tiles?.querySelector(".chip.origin-time")?.textContent).toContain("発生");
  });

  it("⑩ EewPanel/TsunamiPanel/QuakePanel の主見出しが共通トークン (--panel-header-*) で高さを揃えている (第4波)", () => {
    // jsdom はレイアウト計算をしないため実測 height は信頼できない (このプロジェクトの既存規約)。
    // ソース上で3パネルとも同じ --panel-header-min-h / --panel-header-padding-* を参照していることを
    // 検査し、TsunamiPanel だけ headline-l (40px) を使って高さがずれていた回帰を防ぐ
    const eewSource = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunamiSource = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quakeSource = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const source of [eewSource, tsunamiSource, quakeSource]) {
      expect(source).toContain("--panel-header-min-h");
      expect(source).toContain("--panel-header-padding-v");
      expect(source).toContain("--panel-header-padding-h");
    }
    expect(tsunamiSource).not.toContain("--type-headline-l-size");
  });

  it("パネルの角丸は shape scale トークン参照で、tile/chip の直値角丸を持たない (B1 contrasting shapes)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunami = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const src of [eew, tsunami, quake]) {
      expect(src).toContain("var(--radius-m)");
      // 内側タイル/チップの px 直値角丸が残っていないこと
      expect(src).not.toMatch(/border-radius:\s*1[026]px/);
    }
    expect(eew).toContain("var(--radius-s)"); // assumed-chip
    expect(quake).toContain("var(--radius-s)"); // int-chip
  });

  it("パネルヘッダは container/on-container + 下端 CUD 帯で、旧 --bar-* solid を使わない (B2a)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunami = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const src of [eew, tsunami, quake]) {
      expect(src).toMatch(/var\(--header-\w+-container\)/);
      expect(src).toMatch(/var\(--header-band-width\)\s+solid\s+var\(--header-band-\w+\)/);
      expect(src).not.toContain("var(--bar-");
    }
  });

  it("緊急パネルは elevation-3、内側タイルは elevation-1 の box-shadow を持つ (B2b、selector 単位で検証: Codex R10)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    // 宣言をセレクタブロックに紐付けて検査する (コメント・別ブロックでの誤マッチを避ける)
    expect(eew).toMatch(/\.eew-panel\s*\{[^}]*box-shadow:\s*var\(--elevation-3\)/);
    expect(eew).toMatch(/\.tile\s*\{[^}]*box-shadow:\s*var\(--elevation-1\)/);
  });

  // B3 hero moment: 旧・hero-in の opacity 0 スタート入場 (frame-1 可視を破る 3 経路の一つ) は
  // モーション振り付け spec (2026-07-10) で撤去した。主役スロットの「最大面積」は入場アニメでは
  // なく main-stack の grid-row span 構造 (grid-column:1 / grid-row:1 / -1) が担う。入場は
  // revealScaleIn (初期は演出なし=frame-1 可視、後発は transform+opacity) へ転換した
  it("緊急画面の主役スロットは main-stack で grid-row span の最大面積を持つ (B3 hero moment、opacity 0 入場は撤去)", () => {
    const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
    // 主役スロットは grid-column:1 / grid-row:1 / -1 で列全体を占める
    expect(src).toMatch(/\.layout-main-stack \.panel-slot\.is-main \{[^}]*grid-row: 1 \/ -1;/);
    // opacity 0 スタートの hero-in / panel-in keyframe は撤去済み
    expect(src).not.toContain("@keyframes hero-in");
    expect(src).not.toContain("@keyframes panel-in");
    // 入場は外枠 revealScaleIn を撤去し、枚数増減のグリッド track 補間 (grid-template の CSS transition) が担う
    expect(src).not.toContain("revealScaleIn");
    expect(src).toContain("grid-template-columns");
    expect(src).toContain("var(--spring-spatial-quick)");
  });

  it("tier ウェイトスウェル: EewPanel hero が font-weight transition を持ち、color/surface は瞬時のまま (wght #2)", () => {
    const src = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(src).toMatch(/transition:\s*font-weight var\(--dur-weight-swell\)/);
    // 色や surface を tier で transition していない (weight のみ)
    expect(src).not.toMatch(/transition:[^;]*background/);
  });

  it("緊急画面の gap/padding が space トークンを使う (B4)", () => {
    const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
    expect(src).toContain("var(--space-3)");
  });

  it("QuakePanel の市区町村名は white-space:nowrap の city-name span で、名前の途中で改行しない (第3波 Fix14)", () => {
    const src = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    expect(src).toMatch(/\.city-name\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?\}/);
    expect(src).not.toContain('pg.cities.join("・")');
  });

  // T5a (詳細ページング配線) でスクロール機構を撤去し、静的リスト + ページャに置き換えた
  it("QuakePanel/LatestQuakeCard はスクロール機構 (vertical-ping-pong-scroll) を参照しない (T5a)", () => {
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    const latest = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    for (const src of [quake, latest]) {
      expect(src).not.toContain("vertical-ping-pong-scroll");
      expect(src).not.toMatch(/translateY\(-?100%\)/);
      // 各コンポーネント側に phase 状態機械の再実装 (setTimeout チェーン) が残っていないこと
      expect(src).not.toMatch(/type ScrollPhase/);
    }
  });

  it("QuakePanel は既存 page-cycler を維持し、LatestQuakeCard だけが待機画面の共有 scheduler へ一元化される", () => {
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    const latest = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    expect(quake).toContain("../lib/page-cycler.svelte");
    expect(quake).toContain("createPageCycler");
    expect(latest).toContain("../lib/legacy-standby/time-slice-scheduler.svelte");
    expect(latest).toContain("createCardPageCoordinator");
    expect(latest).not.toContain("createPageCycler");
  });

  it("EewPanel はスクロール機構 (vertical-ping-pong-scroll) を参照しない (T4a 全廃)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(eew).not.toContain("vertical-ping-pong-scroll");
  });

  // 詳細ページング (T5a: spec §3/§4)
  describe("QuakePanel: 詳細ページング", () => {
    it("D1-A+D2-A は Quake の保持満了で未表示数を一つだけ減らす", () => {
      vi.useFakeTimers();
      try {
        const areas = Array.from({ length: 60 }, (_, i) => `高知県市町村${i}`);
        const { container } = render(EmergencyScreen, {
          panels: [panel("quake:attention", quakeInput({ intensityGroups: [{ intensity: "6強", rank: 8, areas, omittedAreaCount: 0 }] }))],
        });
        expect(container.querySelector("[data-page-attention]")?.textContent).toBe("1/4・未表示4");
        vi.advanceTimersByTime(PAGE_HOLD_MS);
        settleFade();
        expect(container.querySelector("[data-page-attention]")?.textContent).toBe("2/4・未表示3");
      } finally {
        vi.useRealTimers();
      }
    });
    it("本文 budget 20 満杯でも最初の section 見出しを含めて 2 ページに割る", () => {
      const areas = Array.from({ length: 20 }, (_, i) => `高知県市町村${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 11 }],
            }),
          ),
        ],
      });

      expectCurrentDot(container.querySelector(".tile-page-detail"), 1, 2);
    });

    it("D1-A では少数地域も実測 partition の単一 page へ置き、位置表示を省略する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6強", rank: 8, areas: ["高知県高知市"], omittedAreaCount: 0 },
                { intensity: "6弱", rank: 7, areas: ["愛知県名古屋市"], omittedAreaCount: 0 },
              ],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeFalsy();
      expect(container.querySelector(".tile-page-detail")).toBeTruthy();
      expect(container.querySelector(".page-attention")?.textContent).toBe("未表示1");
    });

    it("area が空でも縮退した ほか N 地域 を page に残し、件数訂正で再び未表示にする", async () => {
      vi.useFakeTimers();
      try {
        const { container, rerender } = render(EmergencyScreen, {
          panels: [panel("quake:omitted-only", quakeInput({
            intensityGroups: [{ intensity: "6強", rank: 8, areas: [], omittedAreaCount: 9 }],
          }))],
        });
        expect(container.querySelector(".omitted-areas")?.textContent).toBe("ほか 9 地域");
        expect(container.querySelector("[data-page-attention]")?.textContent).toBe("未表示1");

        vi.advanceTimersByTime(PAGE_HOLD_MS);
        settleFade();
        expect(container.querySelector("[data-page-attention]")).toBeNull();

        await rerender({
          panels: [panel("quake:omitted-only", quakeInput({
            intensityGroups: [{ intensity: "6強", rank: 8, areas: [], omittedAreaCount: 10 }],
          }))],
        });
        flushSync();
        expect(container.querySelector(".omitted-areas")?.textContent).toBe("ほか 10 地域");
        expect(container.querySelector("[data-page-attention]")?.textContent).toBe("未表示1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("実測 probe は極端に長い市町村名を同じ page へ過積載しない", async () => {
      const originalResizeObserver = globalThis.ResizeObserver;
      const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
      class ProbeResizeObserver {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element): void {
          this.callback([{ contentRect: { width: 320, height: 100 }, target } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect(): void {}
        unobserve(): void {}
      }
      vi.stubGlobal("ResizeObserver", ProbeResizeObserver);
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() { return this.classList.contains("partition-probe-body") ? 100 : 0; },
      });
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() {
          if (!this.classList.contains("partition-probe-body")) return 0;
          return this.querySelectorAll(".city-name").length * 70;
        },
      });
      let unmount: (() => void) | undefined;
      try {
        const long = "極端に長い市町村名".repeat(18);
        const rendered = render(EmergencyScreen, {
          panels: [panel("quake:probe", quakeInput({
            intensityGroups: [{
              intensity: "6強",
              rank: 8,
              areas: [`高知県${long}甲`, `高知県${long}乙`],
              omittedAreaCount: 0,
            }],
          }))],
        });
        unmount = rendered.unmount;
        await vi.waitFor(() => expectCurrentDot(rendered.container.querySelector(".tile-page-detail"), 1, 2));
        expect(rendered.container.querySelectorAll(".page-fade:not(.partition-probe-page) .city-name")).toHaveLength(1);
        expect(rendered.container.querySelector("[data-partition-probe-shelf]")?.getAttribute("aria-hidden")).toBe("true");
      } finally {
        unmount?.();
        if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
        else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
        if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
        else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      }
    });

    it("D1-A の単一 page でも県プレフィックス無しの area は明示ラベル付きで render する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "6強", rank: 8, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const group = container.querySelector(".tile-page-detail .page-section");
      expect(group?.querySelector(".pref-name")?.textContent).toBe("その他");
      expect(
        Array.from(group?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent),
      ).toEqual(["宮崎市", "日南市"]);
    });

    // 詳細ページング側は「その他」ラベルを維持する (レビュー指示: 原則3のラベル明示はページ側に
    // だけ意味がある)。31件超で shouldPageDetails が発火し、県プレフィックス無しの area は
    // .tile-page-detail 側の pg.pref ?? "その他" 分岐に流れることを確認する
    it("詳細ページングでは県プレフィックス無しの area が「その他」ラベル付きで render される (静的リストとは異なり維持)", () => {
      const areas = Array.from({ length: 35 }, (_, i) => `市町村${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({ intensityGroups: [{ intensity: "6強", rank: 8, areas, omittedAreaCount: 0 }] }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeFalsy();
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".pref-name")?.textContent).toBe("その他");
    });

    it("10県153市町村 (南海トラフ級) は各県がバジェット(20)の半分を超え県ごとに1ページ、計10ページに割れる", () => {
      const prefectures = [
        "高知県", "徳島県", "愛媛県", "香川県", "静岡県",
        "愛知県", "三重県", "和歌山県", "宮崎県", "大分県",
      ];
      const perPref = Math.floor(153 / prefectures.length);
      const areas: string[] = [];
      prefectures.forEach((pref, idx) => {
        const count = idx === prefectures.length - 1 ? 153 - perPref * (prefectures.length - 1) : perPref;
        for (let i = 0; i < count; i++) areas.push(`${pref}市町村${i}`);
      });
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeFalsy();
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".page-title")?.textContent).toBe("観測震度 詳細");
      expect(page?.querySelector(".page-count")).toBeFalsy();
      expect(container.querySelector(".instruments")).toBeFalsy();
      expectCurrentDot(page, 1, 11);
    });

    it("1県がバジェット超なら続きラベルを付けてページをまたぐ (大県分断)", () => {
      const areas = Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".pref-name")?.textContent).toBe("高知県");
      expectCurrentDot(page, 1, 2);
    });

    // Codex R レビュー M2: severityTier (地震は最大震度 rank) が同一イベントの続報中に
    // 「上昇」したときもページを先頭に戻す。下降・同値ではリセットしない (spec §3)
    it("同一イベントで maxIntRank が上昇したらページが先頭に戻る。下降・同値では維持する", async () => {
      vi.useFakeTimers();
      try {
        const areas = Array.from({ length: 60 }, (_, i) => `高知県市町村${i}`);
        const { container, rerender } = render(EmergencyScreen, {
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 7,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        expectCurrentDot(container, 1, 4);

        vi.advanceTimersByTime(PAGE_HOLD_MS * 2);
        settleFade();
        expectCurrentDot(container, 3, 4);

        // 下降 (rank 7→5、同一 eventId): リセットしない
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 5,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 3, 4);

        // 同値 (rank 5→5): リセットしない
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 5,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 3, 4);

        // 上昇 (rank 5→9、同一 eventId): 先頭ページに戻る
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 9,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 1, 4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Codex R レビュー M1: createPageCycler は $effect.root で独立 root を持つため、消費側が
  // destroy() を呼ばないと unmount (main-stack のモード切替・panel 差替え) で timer /
  // matchMedia listener がリークする。page-cycler.svelte.ts 側には「destroy 後はタイマーが
  // 発火しない」の単体テストが既にあるため、消費側はソースの配線だけを検査する
  describe("QuakePanel/TsunamiPanel: page-cycler の onDestroy 配線 (Codex R M1)", () => {
    it("QuakePanel は onDestroy で cycler.destroy() を呼ぶ", () => {
      const src = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(src).toContain('import { onDestroy } from "svelte"');
      expect(src).toContain("onDestroy(() => cycler.destroy())");
    });

    it("TsunamiPanel は単一 pageCycler を onDestroy で破棄する", () => {
      const src = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
      expect(src).toContain('import { onDestroy } from "svelte"');
      expect(src).toContain("onDestroy(() => pageCycler.destroy())");
    });
  });

  it("emergency gate は成功時も tsunami probe/live geometry を出力し、chrome 不一致と probe body containment を失敗にする", () => {
    const source = readFileSync(join(__dirname, "..", "..", "..", "..", "scripts", "capture-legacy-standby.mjs"), "utf-8");
    expect(source).toContain("data-partition-probe-geometry");
    expect(source).toContain("probe/live chrome mismatch");
    expect(source).toContain("probe/live body width mismatch");
    expect(source).toContain("probeBody containment failed");
    expect(source).not.toContain("probeChrome containment failed");
    expect(source).toContain("geometry: attentionGeometry");
  });

  // T5c: ページ行容量の画面高さ駆動化 + 切替フェード (spec §2-c)。jsdom は ResizeObserver 未実装
  // かつ layout 未解決のため実測 px の挙動 (T7 preview 実測対象) はソース文字列で配線を検査する
  describe("QuakePanel T5c 配線 (画面高さ駆動 + フェード)", () => {
    it("ページ本文は sequentialPartitionRanges と隠し実測棚で候補 range の自然高を判定する", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toContain("sequentialPartitionRanges(");
      expect(source).toContain("data-partition-probe-shelf");
      expect(source).toContain("contentHeight: node.scrollHeight");
      expect(source).toContain("availableHeight: node.clientHeight");
      expect(source).toContain("quakeProbeFingerprint");
      expect(source).toContain("probeWidth");
      expect(source).toContain("probeHeight");
      expect(source).toContain(":h${Math.round(probeHeight * 100) / 100}");
      expect(source).toContain("use:observeProbeBox");
      expect(source).not.toContain("cityBudgetFromArea(");
    });

    it("ページ切替は {#key cycler.index} + transition:fade の重ねクロスフェードで、時間/easing は既存の spring-effects-default を流用する (新規定数なし)", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toContain("{#key cycler.index}");
      expect(source).toContain('import { fade } from "svelte/transition"');
      // モーション振り付け spec で revealScaleIn/heightReveal 用に SPRING_SPATIAL_DEFAULT_MS も
      // motion から取り込むため、import 行の固定はやめ必要シンボルの取り込みを個別に確認する
      expect(source).toMatch(/import \{[^}]*\bSPRING_EFFECTS_DEFAULT_MS\b[^}]*\bspringEffectsOut\b[^}]*\} from "\.\.\/lib\/motion"/);
      expect(source).toMatch(
        /transition:fade=\{\{\s*duration: cycler\.reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,\s*\}\}/,
      );
    });

    it("旧ページと新ページが重なるよう、.tile-page-detail は position:relative、.page-fade は position:absolute で重ねる", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toMatch(/\.tile-page-detail\s*\{[^}]*position: relative;/);
      expect(source).toMatch(/\.page-fade\s*\{[^}]*position: absolute;[^}]*inset: 0;/);
    });

    // T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘)。position:absolute な
    // .page-fade の containing block は最も近い positioned 祖先 (.tile-page-detail) の
    // padding box になり、祖先自身の padding 宣言は絶対配置の子には効かないため、
    // .tile-page-detail の padding (var(--space-4) var(--space-5)) が実質無視されていた。
    // .page-fade 自体に同じトークンで padding を持たせて復元する。pageBodyAreaHeight は
    // .page-body を直接 measureHeight する構造なので、この padding 変更は次回実測で自動的に
    // 反映される (TsunamiPanel の coastRowCapacity のような明示補正定数は不要)
    it(".page-fade には .tile-page-detail と同じ既存 spacing トークンで内側 padding を持たせる (新規直値・opacity 減光は使わない)", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toMatch(/\.page-fade\s*\{[^}]*padding: var\(--space-4\) var\(--space-5\);/);
      expect(source).not.toMatch(/\.page-fade\s*\{[^}]*\d+px/);
      expect(source).not.toMatch(/\.page-fade\s*\{[^}]*opacity/);
    });
  });
});
