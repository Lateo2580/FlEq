import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import DiffPane from "./DiffPane.svelte";

const ESC = "\x1b";

describe("DiffPane", () => {
  it("before/after を左右に表示し、色変化行に changed-color クラスが付く", () => {
    const { container } = render(DiffPane, {
      before: `${ESC}[38;2;255;0;0mAAA${ESC}[0m\nsame`,
      after: `${ESC}[38;2;0;255;0mAAA${ESC}[0m\nsame`,
    });
    const cols = container.querySelectorAll(".diff-col");
    expect(cols).toHaveLength(2);
    expect(container.querySelectorAll(".diff-line.changed-color").length).toBe(2); // 左右 1 行ずつ
    expect(container.querySelectorAll(".diff-line.changed-text").length).toBe(0);
  });

  it("文字列変化行は changed-text + <mark> が after 側に出る", () => {
    const { container } = render(DiffPane, { before: "AAA BBB", after: "AAA CCC" });
    expect(container.querySelectorAll(".diff-line.changed-text").length).toBe(2);
    const marks = container.querySelectorAll(".diff-col-after mark");
    expect(marks.length).toBeGreaterThan(0);
    expect([...marks].some((m) => m.textContent!.includes("CCC"))).toBe(true);
  });

  it("同一内容は変更クラスなし", () => {
    const { container } = render(DiffPane, { before: "X\nY", after: "X\nY" });
    expect(container.querySelectorAll(".changed-color, .changed-text").length).toBe(0);
  });
});
