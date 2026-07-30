import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import EewPanel from "../EewPanel.svelte";
import type { DisplayEewInputV1, DisplayEewRegionV1 } from "../../lib/protocol";
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

describe("EewPanel 固定サマリ計器 (T4a)", () => {
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

  it("整定中の実測値を保留し、解除後は fallback 10 から実測容量へ更新する", async () => {
    const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    class EewResizeObserver {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe(element: Element): void {
        const height = element.classList.contains("region-page-body")
          ? 100
          : element.classList.contains("region-line-ruler")
            ? 20
            : 0;
        this.callback([{ contentRect: { height }, borderBoxSize: [{ blockSize: height }], target: element }]);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = EewResizeObserver;

    try {
      const regions = Array.from({ length: 11 }, (_, i) => region(`地域${i}`, { intensity: "7" }));
      const { container, rerender } = render(EewPanel, { input: eewInput({ regions }), settling: true });
      flushSync();
      expectCurrentDot(container.querySelector(".region-pages"), 1, 2);

      await rerender({ input: eewInput({ regions }), settling: false });
      flushSync();
      expectCurrentDot(container.querySelector(".region-pages"), 1, 3);
    } finally {
      if (originalResizeObserver === undefined) {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      } else {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
      }
    }
  });

  it("長い地域名で代表行が折り返す場合は、その実行高を使って安全側にページを割る", () => {
    const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const longName = "非常に長い地域名".repeat(8);
    class WrappingResizeObserver {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe(element: Element): void {
        const height = element.classList.contains("region-page-body")
          ? 100
          : element.classList.contains("region-line-ruler") && element.textContent?.includes(longName)
            ? 40
            : 20;
        this.callback([{ contentRect: { height }, borderBoxSize: [{ blockSize: height }], target: element }]);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = WrappingResizeObserver;

    try {
      const regions = [
        region(longName, { intensity: "7" }),
        ...Array.from({ length: 10 }, (_, i) => region(`地域${i}`, { intensity: "7" })),
      ];
      const { container } = render(EewPanel, { input: eewInput({ regions }) });
      flushSync();

      expect(container.querySelector(".region-line-ruler")?.classList.contains("region-row")).toBe(true);
      // 100px / 折返し行 40px = 2 地域/頁。1行 20px と誤認すると 3 頁になる。
      expectCurrentDot(container.querySelector(".region-pages"), 1, 6);
    } finally {
      if (originalResizeObserver === undefined) {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      } else {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
      }
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
