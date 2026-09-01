import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import PageDots from "../PageDots.svelte";

// T8① (spec §3 改訂): 旧「N/M」数字を廃止したドットインジケータ。QuakePanel/LatestQuakeCard の
// 詳細ページ・TsunamiPanel の予報区/観測ページ (計4箇所) で共有する。ここでは共有コンポーネント
// 単体として: ドット数=total / 現在強調 / クリックで onJump が呼ばれる配線 / 全ドット均等間隔を
// 検証する (jumpTo 自体の単体テストは page-cycler.test.ts 側)。
// T8⑤: 種別/震度グループの境界に gap を入れる任意機能 (groupBoundaryIndices) は一度実装したが、
// preview 目視レビューで「間隔が不揃いに見える」と不評だったため撤去した。全ドット常に均等間隔
describe("PageDots", () => {
  it("total 分のドットを render し、current に対応する1つだけが .current になる", () => {
    const { container } = render(PageDots, { total: 5, current: 2, onJump: () => {} });
    const dots = container.querySelectorAll(".page-dot");
    expect(dots.length).toBe(5);
    const current = Array.from(dots).filter((d) => d.classList.contains("current"));
    expect(current.length).toBe(1);
    expect(Array.from(dots).indexOf(current[0])).toBe(2);
  });

  it("total<=1 のときは何も render しない (1枚だけのドットは意味が無い)", () => {
    const { container } = render(PageDots, { total: 1, current: 0, onJump: () => {} });
    expect(container.querySelector(".page-dots")).toBeNull();
    expect(container.querySelectorAll(".page-dot").length).toBe(0);
  });

  it("ドットをクリックすると onJump がそのドットの index で呼ばれる", async () => {
    const onJump = vi.fn();
    const { container } = render(PageDots, { total: 4, current: 0, onJump });
    const dots = container.querySelectorAll(".page-dot");
    await fireEvent.click(dots[2]);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("ドットは button 要素で aria-current/aria-label を持つ (kiosk・マウス運用でも無害、§8 錨改訂)", () => {
    const { container } = render(PageDots, { total: 3, current: 1, onJump: () => {} });
    const dots = container.querySelectorAll(".page-dot");
    expect(dots[1].tagName).toBe("BUTTON");
    expect(dots[1].getAttribute("aria-current")).toBe("true");
    expect(dots[0].getAttribute("aria-current")).toBeNull();
    expect(dots[1].getAttribute("aria-label")).toBe("2/3ページ");
  });

  // T8⑤: 全ドットが常に均等間隔になること (グループ境界による個別 margin が無いこと) を確認する
  it("全ドットが均等間隔で並ぶ (個別の margin-left を持つドットが無い)", () => {
    const { container } = render(PageDots, { total: 5, current: 0, onJump: () => {} });
    const dots = Array.from(container.querySelectorAll<HTMLElement>(".page-dot"));
    expect(dots.length).toBe(5);
    for (const dot of dots) {
      expect(dot.classList.contains("group-start")).toBe(false);
      expect(dot.style.marginLeft).toBe("");
    }
    const src = readFileSync(join(__dirname, "..", "PageDots.svelte"), "utf-8");
    expect(src).not.toContain("group-start");
    expect(src).not.toContain("groupBoundaryIndices");
  });

  it("opacity による減光は使わない (§8 規範。非強調ドットは color-mix で表現する)", () => {
    const src = readFileSync(join(__dirname, "..", "PageDots.svelte"), "utf-8");
    expect(src).not.toMatch(/opacity\s*:/); // CSS プロパティとしての opacity 宣言が無いこと (解説コメントの語自体は許容)
    expect(src).toContain("color-mix(in srgb, var(--fg)");
  });

  it("reduced-motion では ::after のドット拡縮 transition も停止する", () => {
    const src = readFileSync(join(__dirname, "..", "PageDots.svelte"), "utf-8");
    expect(src).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.page-dot::after\s*\{\s*transition: none;/);
  });

  it("pageCount=10 は active index 0/9 とも外形8pxで chrome 高を変えない", async () => {
    const rendered = render(PageDots, { total: 10, current: 0, onJump: () => {} });
    const outerSize = () => Array.from(rendered.container.querySelectorAll(".page-dot")).map((dot) => {
      const style = getComputedStyle(dot);
      return [style.flexBasis, style.width, style.height];
    });
    const firstActive = outerSize();
    await rendered.rerender({ total: 10, current: 9, onJump: () => {} });
    expect(outerSize()).toEqual(firstActive);

    const src = readFileSync(join(__dirname, "..", "PageDots.svelte"), "utf-8");
    expect(src).toContain("flex: 0 0 8px");
    expect(src).toMatch(/\.page-dots\s*\{[^}]*min-height: 24px;/);
    expect(src).toMatch(/\.page-dot\s*\{[^}]*width: 8px;[^}]*height: 8px;/);
    expect(src).toMatch(/\.page-dot::after\s*\{[^}]*width: 6px;[^}]*height: 6px;/);
    expect(src).toMatch(/\.page-dot\.current::after\s*\{[^}]*width: 8px;[^}]*height: 8px;/);
  });

  it.each([
    [0, [0, 1, 2, 3, 4, 9]],
    [3, [0, 1, 2, 3, 4, 9]],
    [4, [0, 3, 4, 5, 9]],
    [6, [0, 5, 6, 7, 8, 9]],
    [9, [0, 5, 6, 7, 8, 9]],
  ])("windowed total=10/current=%i は決定的な実 page index と ellipsis を最大7 tokenで描く", (
    current,
    expectedPages,
  ) => {
    const { container } = render(PageDots, {
      total: 10,
      current,
      onJump: () => {},
      windowed: true,
    });
    const buttons = Array.from(container.querySelectorAll(".page-dot"));
    expect(buttons.map((button) => Number(button.getAttribute("aria-label")?.split("/")[0]) - 1))
      .toEqual(expectedPages);
    expect(buttons.length + container.querySelectorAll(".page-ellipsis").length).toBe(7);
    for (const ellipsis of container.querySelectorAll(".page-ellipsis")) {
      expect(ellipsis.textContent).toBe("…");
      expect(ellipsis.getAttribute("aria-hidden")).toBe("true");
      expect(ellipsis.tagName).not.toBe("BUTTON");
    }
  });

  it("windowed total=10_000 でも全ページ比例の DOM を作らず、実 index へ jump する", async () => {
    const onJump = vi.fn();
    const { container } = render(PageDots, {
      total: 10_000,
      current: 5_000,
      onJump,
      windowed: true,
    });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".page-dot"));
    expect(buttons.length).toBe(5);
    expect(buttons.length + container.querySelectorAll(".page-ellipsis").length).toBe(7);
    const last = buttons.at(-1)!;
    expect(last.getAttribute("aria-label")).toBe("10000/10000ページ");
    await fireEvent.click(last);
    expect(onJump).toHaveBeenCalledWith(9_999);
  });

  it("windowed chrome は 80px×24px、nowrap で current 移動時にも外形を変えない", () => {
    const src = readFileSync(join(__dirname, "..", "PageDots.svelte"), "utf-8");
    expect(src).toMatch(/\.page-dots\.windowed\s*\{[^}]*inline-size: 80px;/);
    expect(src).toMatch(/\.page-dots\.windowed\s*\{[^}]*max-inline-size: 80px;/);
    expect(src).toMatch(/\.page-dots\.windowed\s*\{[^}]*block-size: 24px;/);
    expect(src).toMatch(/\.page-dots\.windowed\s*\{[^}]*flex-wrap: nowrap;/);
  });
});
