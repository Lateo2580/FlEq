import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import EewPanel from "../EewPanel.svelte";
import type {
  DisplayEewInputV1,
  DisplayEewRegionV1,
  DisplayIntensitySemanticV1,
  DisplayLgIntensitySemanticV1,
} from "../../lib/protocol";
import { expectCurrentDot } from "./page-dots-test-utils";

function region(name: string, over: Partial<DisplayEewRegionV1> = {}): DisplayEewRegionV1 {
  return { name, intensity: "4", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: null, ...over };
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

function semantic(over: Partial<DisplayIntensitySemanticV1>): DisplayIntensitySemanticV1 {
  return {
    raw: "4", presence: "value", label: "4", condition: null, description: null,
    lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    badge: null, color: "normalRank", render: true, safetyLowerRank: 4,
    safetyUpperRank: 4, safetyRank: 4, colorRank: 4, ...over,
  };
}

function lgSemantic(over: Partial<DisplayLgIntensitySemanticV1>): DisplayLgIntensitySemanticV1 {
  return {
    raw: "2", presence: "value", label: "2", condition: null, description: null,
    lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    badge: null, color: "normalRank", render: true, safetyLowerRank: 2,
    safetyUpperRank: 2, safetyRank: 2, colorRank: 2, ...over,
  };
}

describe("EewPanel 固定サマリ計器 (T4a)", () => {
  it("ごく浅い震源を非数値テキストとしてそのまま描画する", () => {
    const { container } = render(EewPanel, { input: eewInput({ depth: "ごく浅い" }) });
    expect(container.querySelector('.stat-value [data-value="ごく浅い"]')?.textContent).toBe("ごく浅い");
    expect(container.textContent).not.toContain("~10km");
  });

  it("originTime があるときだけ発生時刻を表示する", () => {
    const { container } = render(EewPanel, { input: eewInput({ originTime: "2026-07-07T09:17:18+09:00" }) });
    expect(screen.getByText("発生時刻")).toBeTruthy();
    expect(container.querySelector('.stat-value [data-value="09:17:18"]')).toBeTruthy();
  });

  it("長周期が明示値 0 のときは長周期タイルを表示しない", () => {
    const { container } = render(EewPanel, { input: eewInput({ maxLgInt: "0" }) });
    expect(container.querySelector(".stat-label")?.textContent).not.toBe("長周期");
    expect(screen.queryByText("長周期")).toBeNull();
  });

  it("長周期が 1 以上のときは長周期タイルを表示する", () => {
    const { container } = render(EewPanel, { input: eewInput({ maxLgInt: "1" }) });
    expect(screen.getByText("長周期")).toBeTruthy();
    expect(container.querySelector('.stat-value [data-value="1"]')).toBeTruthy();
  });

  it("長周期の overall／地域 range・unknown semantic を label・badge・色付きで表示する", () => {
    const overall = lgSemantic({
      raw: "", presence: "range", label: "2〜3", condition: "予測幅",
      description: "最大長周期階級幅", lowerBound: "2", upperBound: "3",
      rawLowerBound: "２", rawUpperBound: "３", badge: "↔", color: "safetyUpperRank",
      safetyLowerRank: 2, safetyUpperRank: 3, safetyRank: 3, colorRank: 3,
    });
    const regional = lgSemantic({
      raw: "", presence: "range", label: "1〜2", condition: null,
      description: "地域長周期階級幅", lowerBound: "1", upperBound: "2",
      rawLowerBound: "１", rawUpperBound: "２", badge: "↔", color: "safetyUpperRank",
      safetyLowerRank: 1, safetyUpperRank: 2, safetyRank: 2, colorRank: 2,
    });
    const unknown = lgSemantic({
      raw: "", presence: "unknown", label: "不明（未入電）", condition: "未入電",
      description: "長周期階級未入電", badge: "?", color: "unknown",
      safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(EewPanel, { input: eewInput({
      maxLgInt: "2",
      maxLgIntSemantic: overall,
      regions: [
        region("幅地域", { lgIntensity: "1〜2", lgIntensitySemantic: regional }),
        region("未入電地域", { lgIntensity: "不明（未入電）", lgIntensitySemantic: unknown }),
      ],
    }) });

    const overallChip = container.querySelector(".stat-value.lg");
    expect(overallChip?.textContent?.replace(/\s+/g, "")).toBe("2〜3↔");
    expect(overallChip?.getAttribute("title")).toContain("最大長周期階級幅");
    const regionalChips = [...container.querySelectorAll(".region-lg")];
    expect(regionalChips.map((chip) => chip.textContent)).toEqual(["長周期1〜2↔", "長周期不明（未入電）?"]);
    expect(regionalChips[0].classList.contains("lg-r2")).toBe(true);
    expect(regionalChips[1].classList.contains("special-unknown")).toBe(true);
    expect(regionalChips[1].getAttribute("aria-label")).toContain("長周期階級未入電");
  });

  it("震度別の地域数は出さず、震度チップと地域名リストは維持する", () => {
    const regions = [
      region("高知県", { intensity: "7" }),
      region("徳島県", { intensity: "7" }),
      region("愛媛県", { intensity: "6強" }),
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelector(".agg-tile")).toBeFalsy();
    expect(container.textContent).not.toContain("2県");
    expect(screen.getByText("高知県 徳島県")).toBeTruthy();
    expect(container.querySelector(".region-intensity")?.textContent).toContain("震度7");
  });

  it("予測震度範囲を表示し、上限側 rank で色 bucket を分類する", () => {
    const { container } = render(EewPanel, {
      input: eewInput({
        regions: [
          region("宮城県", { intensity: "3", intensityTo: "4" }),
          region("福島県", { intensity: "5弱", intensityTo: "over" }),
        ],
      }),
    });
    const labels = [...container.querySelectorAll(".region-intensity")];
    expect(labels.map((label) => label.textContent)).toEqual(["震度5弱程度以上", "震度3〜4"]);
    expect(labels[0].classList.contains("int-r5")).toBe(true);
    expect(labels[1].classList.contains("int-r4")).toBe(true);
  });

  it("地域別 semantic の qualifier と badge を表示し、旧 scalar より semantic を優先する", () => {
    const lower = semantic({
      raw: "5弱以上未入電", presence: "qualitative", label: "5弱以上未入電",
      condition: "5弱以上未入電", lowerBound: "5-", badge: "≥", color: "safetyRank",
      safetyLowerRank: 5, safetyUpperRank: null, safetyRank: 5, colorRank: 5,
    });
    const range = semantic({
      raw: null, presence: "range", label: "3〜5弱", lowerBound: "3", upperBound: "5-",
      rawLowerBound: "3", rawUpperBound: "5-", badge: "↔", color: "safetyUpperRank",
      safetyLowerRank: 3, safetyUpperRank: 5, safetyRank: 5, colorRank: 5,
    });
    const unknown = semantic({
      raw: "未入電", presence: "unknown", label: "不明", condition: "未入電",
      badge: "?", color: "unknown", safetyLowerRank: null, safetyUpperRank: null,
      safetyRank: null, colorRank: null,
    });
    const missing = semantic({
      raw: null, presence: "missing", label: null, badge: null, color: "notRendered",
      render: false, safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(EewPanel, { input: eewInput({ regions: [
      region("宮城県", { intensity: "", intensityTo: null, intensitySemantic: lower }),
      region("福島県", { intensity: "3", intensityTo: "5弱", intensitySemantic: range }),
      region("茨城県", { intensity: "", intensityTo: null, intensitySemantic: unknown }),
      region("地域欠落", { intensity: "7", intensityTo: null, intensitySemantic: missing }),
    ] }) });
    const labels = [...container.querySelectorAll(".region-intensity")];
    expect(labels.map((label) => label.textContent)).toEqual([
      "震度5弱以上未入電≥", "震度3〜5弱↔", "震度不明?",
    ]);
    expect(labels[0].classList.contains("int-r5")).toBe(true);
    expect(labels[1].classList.contains("int-r5")).toBe(true);
    expect(labels[2].classList.contains("special-unknown")).toBe(true);
    expect(labels[0].getAttribute("title")).toContain("以上（下限値）");
    expect(labels[2].getAttribute("aria-label")).toContain("理由: 未入電");
    expect(container.textContent).not.toContain("地域欠落");
    expect(container.textContent).not.toContain("震度7");
  });

  it("全体最大予測震度の qualifier と badge を表示する", () => {
    const lower = semantic({
      raw: "5弱以上未入電", presence: "qualitative", label: "5弱以上未入電",
      condition: "5弱以上未入電", lowerBound: "5-", badge: "≥", color: "safetyRank",
      safetyLowerRank: 5, safetyUpperRank: null, safetyRank: 5, colorRank: 5,
    });
    const { container } = render(EewPanel, { input: eewInput({
      forecastMaxInt: "", forecastMaxIntRank: 5, forecastMaxIntSemantic: lower,
    }) });
    expect(container.querySelector(".max-int")?.textContent?.replace(/\s+/g, " ")).toContain("最大予測震度 5弱以上未入電 ≥");
    expect(container.querySelector(".max-int")?.getAttribute("aria-label")).toContain("以上（下限値）");
  });

  it("同じ label/badge でも Condition/Description が異なる地域を別 bucket で保持する", () => {
    const first = semantic({
      raw: "未入電", presence: "unknown", label: "不明", condition: "未入電",
      description: "観測網A", badge: "?", color: "unknown", safetyLowerRank: null,
      safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const second = semantic({
      raw: "未入電", presence: "unknown", label: "不明", condition: "未入電",
      description: "観測網B", badge: "?", color: "unknown", safetyLowerRank: null,
      safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(EewPanel, { input: eewInput({ regions: [
      region("地域A", { intensity: "", intensitySemantic: first }),
      region("地域B", { intensity: "", intensitySemantic: second }),
    ] }) });
    const rows = [...container.querySelectorAll(".region-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".region-intensity")?.getAttribute("title")).toContain("説明: 観測網A");
    expect(rows[1].querySelector(".region-intensity")?.getAttribute("title")).toContain("説明: 観測網B");
    expect(rows[0].querySelector(".region-names")?.textContent).toBe("地域A");
    expect(rows[1].querySelector(".region-names")?.textContent).toBe("地域B");
  });

  it("不明・巨大地震の magnitude 表示は M を重ねず description を維持する", () => {
    const { container } = render(EewPanel, {
      input: eewInput({ magnitude: "M8 を超える巨大地震" }),
    });
    expect(container.textContent).toContain("M8 を超える巨大地震");
    expect(container.textContent).not.toContain("MM8");
    expect(container.textContent).not.toContain("NaN");
  });

  it("PLUM を含む region があれば件数なしの標識を出す。なければ空区画を残さない", () => {
    const withPlum = [region("宮崎県", { isPlum: true }), region("大分県", { isPlum: false })];
    const { container: withContainer } = render(EewPanel, { input: eewInput({ regions: withPlum }) });
    expect(withContainer.querySelector(".agg-plum")?.textContent).toBe("PLUM含む");

    const withoutPlum = [region("宮崎県"), region("大分県")];
    const { container: withoutContainer } = render(EewPanel, { input: eewInput({ regions: withoutPlum }) });
    expect(withoutContainer.querySelector(".agg-tile")).toBeFalsy();
  });

  it("regions が空なら集約行自体を出さない", () => {
    const { container } = render(EewPanel, { input: eewInput({ regions: [] }) });
    expect(container.querySelector(".agg-tile")).toBeFalsy();
  });

  it("N<=10 (境界): 静的な震度別リストを render する。到達列・行内 PLUM は出さない", () => {
    const regions = [
      region("地域1", { intensity: "6弱", isPlum: true, hasArrived: true }),
      region("地域2", { intensity: "6弱" }),
      ...Array.from({ length: 8 }, (_, i) => region(`地域${i + 3}`)),
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelectorAll(".region-row").length).toBe(2); // 震度6弱グループ + 震度4グループ の2行
    expect(screen.getByText("地域1 地域2")).toBeTruthy(); // 静的併記
    expect(container.querySelector(".region-arrival")).toBeFalsy();
    expect(container.querySelector(".plum")).toBeFalsy();
  });

  // T8⑥ (preview 目視レビュー): 列数は行数 (震度バケツ数) 駆動にする。emergency-1 相当の
  // 4 バケツ程度では 2 列に割る必要が薄いと判断され、5 バケツ以上でだけ 2 列にする
  // (eew-region-tiers.ts の EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS=5、閾値自体の単体テストは
  // eew-region-tiers.test.ts 側)
  it("震度バケツが4個 (閾値未満) なら .region-list は単列のまま (.two-column が付かない)", () => {
    const regions = ["7", "6強", "6弱", "5強"].map((intensity) => region(`地域-${intensity}`, { intensity }));
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelectorAll(".region-row").length).toBe(4);
    expect(container.querySelector(".region-list")?.classList.contains("two-column")).toBe(false);
  });

  it("震度バケツが5個以上 (閾値以上) なら .region-list に .two-column が付く", () => {
    const regions = ["7", "6強", "6弱", "5強", "5弱"].map((intensity) => region(`地域-${intensity}`, { intensity }));
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelectorAll(".region-row").length).toBe(5);
    expect(container.querySelector(".region-list")?.classList.contains("two-column")).toBe(true);
  });

  it("バケツ数が5個以上でも compact モードでは class:two-column は付くが、CSS の詳細度で単列に戻る (jsdom はカスケード計算しないためソース文字列で確認)", () => {
    const regions = ["7", "6強", "6弱", "5強", "5弱"].map((intensity) => region(`地域-${intensity}`, { intensity }));
    const { container } = render(EewPanel, { input: eewInput({ regions }), compact: true });
    expect(container.querySelector(".region-list")?.classList.contains("two-column")).toBe(true);
    const source = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    // .eew-panel.compact .region-list (詳細度3) が .region-list.two-column (詳細度2) より
    // 詳細度が高く、two-column が付いていても columns: unset で確実に単列へ戻ることをコメントで
    // 明示している箇所を確認する (実際のカスケード計算は jsdom の範囲外)
    expect(source).toMatch(/\.eew-panel\.compact \.region-list \{\s*columns: unset;/);
  });

  // T8③ (preview 目視指摘、emergency-1 等): 2 カラム時の中央仕切りが --hairline
  // (面分離用の薄い境界線、焼付き最小が本来の用途) では弱すぎたため、既存の可読トークン
  // --role-muted に差し替えた。新規直値色は使わない (jsdom は multi-column layout を
  // レンダリングしないため、ソース文字列で検証する)
  it("静的リストの2カラム中央仕切り (column-rule) は --hairline ではなく既存の可読トークン --role-muted を使う", () => {
    const source = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(source).toMatch(/\.region-list\s*\{[^}]*column-rule: 1px solid var\(--role-muted\);/);
    expect(source).not.toMatch(/\.region-list\s*\{[^}]*column-rule: 1px solid var\(--hairline\);/);
  });

  it("N=11 を超える地域は強度セクションを保ったページ表示へ移る", () => {
    const regions = [...Array.from({ length: 10 }, (_, i) => region(`地域${i}`, { intensity: "7" })), region("地域11", { intensity: "6強" })];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelector(".region-pages")).toBeTruthy();
    expect(container.querySelector(".region-page-header")?.textContent).toContain("予測地域");
    expect(container.querySelector(".region-row")?.textContent).toContain("震度7");
    expect(container.querySelector(".pref-flat-list")).toBeFalsy();
  });

  // 測定棚の実測を jsdom で再現する。本文 100px、1 行 20px に地名 4 つ、束ごとに行を改める。
  // measurable=false の間は測れない (測り直し中) 状態にする
  async function withProbeLayout(run: (layout: { measurable: boolean }) => Promise<void>): Promise<void> {
    const layout = { measurable: true };
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const inShelf = (element: HTMLElement): boolean =>
      element.classList.contains("region-page-body") && element.closest("[data-partition-probe-shelf]") != null;
    class ProbeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback([{ contentRect: { width: 320, height: 100 }, target } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", ProbeResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) { return inShelf(this) ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (!layout.measurable || !inShelf(this)) return 0;
        return [...this.querySelectorAll(".region-row")]
          .reduce((sum, row) => sum + Math.ceil(row.querySelectorAll(".region-name").length / 4) * 20, 0);
      },
    });
    try {
      await run(layout);
    } finally {
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      vi.unstubAllGlobals();
    }
  }
  async function drainProbes(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      flushSync();
      await Promise.resolve();
    }
  }
  // 束 1 つ = 7 地域。強度と長周期階級の組で束を分ける
  function tieredRegions(tierCount: number, extra = 0, prefix = "地域"): DisplayEewRegionV1[] {
    const tiers = ["7", "6強", "6弱", "5強", "5弱"].flatMap((intensity) => ["3", "2", "1"].map((lg) => ({ intensity, lg })));
    return tiers.slice(0, tierCount).flatMap(({ intensity, lg }, t) =>
      Array.from({ length: t === 0 ? 7 + extra : 7 }, (_, i) => region(`${prefix}${t}-${i}`, { intensity, lgIntensity: lg })));
  }
  const liveHeader = (container: HTMLElement) => container.querySelector(".region-pages > .region-page-header");

  it("予測地域 105・束 15 は実測で束をまとめて 6 ページに割り、k/P と未表示数を出す (10/16 千島の 19 ページ)", async () => {
    await withProbeLayout(async () => {
      const { container } = render(EewPanel, { input: eewInput({ regions: tieredRegions(15) }) });
      await drainProbes();
      // 1 ページ 5 行 = 束 2 つ半。1 束 1 ページの旧割付なら 15 ページ以上になる
      expectCurrentDot(liveHeader(container), 1, 6);
      expect(container.querySelector("[data-page-attention]")?.textContent).toBe("1/6・未表示6");
      expect(container.querySelectorAll(".region-pages > .region-page-body .region-row")).toHaveLength(3);
    });
  });

  it("整定中は測定棚の実測を反映せず、解除後に反映する", async () => {
    await withProbeLayout(async () => {
      const { container, rerender } = render(EewPanel, { input: eewInput({ regions: tieredRegions(5) }), settling: true });
      await drainProbes();
      // 実測が無い間は 1 地域ずつの仮ページ (PageDots は 1 ページでは描かない)
      expect(container.querySelectorAll(".region-pages > .region-page-body .region-name")).toHaveLength(1);

      await rerender({ input: eewInput({ regions: tieredRegions(5) }), settling: false });
      await drainProbes();
      expectCurrentDot(liveHeader(container), 1, 2);
    });
  });

  it("同じ地震でも最大予測震度が上がった続報では 1 ページ目へ戻る", async () => {
    vi.useFakeTimers();
    try {
      await withProbeLayout(async () => {
        const { container, rerender } = render(EewPanel, { input: eewInput({ serial: "3", forecastMaxIntRank: 5, regions: tieredRegions(5) }) });
        await drainProbes();
        vi.advanceTimersByTime(10_000);
        await drainProbes();
        expectCurrentDot(liveHeader(container), 2, 2);

        await rerender({ input: eewInput({ serial: "4", forecastMaxIntRank: 6, regions: tieredRegions(5) }) });
        await drainProbes();
        expectCurrentDot(liveHeader(container), 1, 2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("別の地震の測り直し中は、前の地震の確定ページを使わず新しい地域を出す", async () => {
    await withProbeLayout(async (layout) => {
      const { container, rerender } = render(EewPanel, { input: eewInput({ regions: tieredRegions(5) }) });
      await drainProbes();
      expectCurrentDot(liveHeader(container), 1, 2);

      layout.measurable = false;
      await rerender({ input: eewInput({ eventId: "E2", regions: tieredRegions(5, 0, "新地域") }) });
      await drainProbes();
      const names = [...container.querySelectorAll(".region-pages > .region-page-body .region-name")].map((node) => node.textContent);
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((name) => name?.startsWith("新地域"))).toBe(true);
    });
  });

  it("同じ地震の続報では今のページを保ち、別の地震で 1 ページ目へ戻る", async () => {
    vi.useFakeTimers();
    try {
      await withProbeLayout(async (layout) => {
        const { container, rerender } = render(EewPanel, { input: eewInput({ serial: "3", regions: tieredRegions(5) }) });
        await drainProbes();
        vi.advanceTimersByTime(10_000);
        await drainProbes();
        expectCurrentDot(liveHeader(container), 2, 2);

        await rerender({ input: eewInput({ serial: "4", regions: tieredRegions(5) }) });
        await drainProbes();
        expectCurrentDot(liveHeader(container), 2, 2);

        // 地域が変わった続報: 測り直しが終わるまで直前の確定ページを出し続ける
        layout.measurable = false;
        await rerender({ input: eewInput({ serial: "5", regions: tieredRegions(5, 1) }) });
        await drainProbes();
        expectCurrentDot(liveHeader(container), 2, 2);

        layout.measurable = true;
        await rerender({ input: eewInput({ eventId: "E2", serial: "1", regions: tieredRegions(5) }) });
        await drainProbes();
        expectCurrentDot(liveHeader(container), 1, 2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pager 移行前の都道府県フラットリスト経路を残さない", () => {
    const source = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(source).not.toContain("eewPrefListFontTier");
    expect(source).not.toContain("prefectureFlatList");
    expect(source).not.toContain("pref-flat");
  });

  it("到達時刻情報 (arrivalLabel/region-arrival) を全廃している", () => {
    const regions = Array.from({ length: 5 }, (_, i) => region(`地域${i + 1}`, { hasArrived: true }));
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelector(".region-arrival")).toBeFalsy();
    expect(screen.queryByText("到達")).toBeFalsy();
  });
});
