import { describe, it, expect } from "vitest";
import { centerPad, clipToVisualWidth, visualWidth } from "../../src/ui/formatter";

describe("centerPad", () => {
  it("空文字 → 全パディング", () => {
    expect(visualWidth(centerPad("", 10))).toBe(10);
  });
  it("半角短文字 → 中央寄せ", () => {
    const r = centerPad("ab", 6);
    expect(r).toBe("  ab  ");
    expect(visualWidth(r)).toBe(6);
  });
  it("全角混じり → visualWidth で合わせる", () => {
    expect(visualWidth(centerPad("継続", 10))).toBe(10); // 継続 = 4 cells
  });
  it("奇数余り → 左に寄せる", () => {
    expect(centerPad("a", 4)).toBe(" a  "); // 余り 3 → 左 1, 右 2
  });
  it("内容が target を超える → そのまま返す (overflow)", () => {
    expect(centerPad("abcde", 3)).toBe("abcde");
  });
});

describe("clipToVisualWidth", () => {
  it("収まる → そのまま", () => {
    expect(clipToVisualWidth("abc", 10)).toBe("abc");
  });
  it("超過 → 末尾 … で maxWidth 以内", () => {
    const r = clipToVisualWidth("abcdefgh", 5);
    expect(visualWidth(r)).toBeLessThanOrEqual(5);
    expect(r.endsWith("…")).toBe(true);
  });
  it("全角混じり超過 → visualWidth で判定し … 付与", () => {
    const r = clipToVisualWidth("大雨洪水暴風警報", 6); // 全角 = 各 2 cells
    expect(visualWidth(r)).toBeLessThanOrEqual(6);
    expect(r.endsWith("…")).toBe(true);
  });
  it("maxWidth=0 以下 → 空文字", () => {
    expect(clipToVisualWidth("abc", 0)).toBe("");
  });
});
