import { describe, it, expect } from "vitest";
import { classifyDiffLines } from "./diff-lines";

const ESC = "\x1b";

describe("classifyDiffLines", () => {
  it("同一 ANSI は全行 unchanged", () => {
    const a = `${ESC}[38;2;255;0;0mAAA${ESC}[0m\nBBB`;
    const rows = classifyDiffLines(a, a);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "unchanged")).toBe(true);
  });

  it("色だけ違う行は colorChanged (テキストは同一)", () => {
    const before = `${ESC}[38;2;255;0;0mAAA${ESC}[0m\nBBB`;
    const after = `${ESC}[38;2;0;255;0mAAA${ESC}[0m\nBBB`;
    const rows = classifyDiffLines(before, after);
    expect(rows[0].kind).toBe("colorChanged");
    expect(rows[1].kind).toBe("unchanged");
  });

  it("テキストが違う行は textChanged で変更セグメントを持つ", () => {
    const before = "AAA BBB\nsame";
    const after = "AAA CCC\nsame";
    const rows = classifyDiffLines(before, after);
    expect(rows[0].kind).toBe("textChanged");
    expect(rows[0].afterSegments!.some((s) => s.changed && s.text.includes("CCC"))).toBe(true);
    expect(rows[1].kind).toBe("unchanged");
  });

  it("行数が違う場合は不足側を空行で埋めて並べる", () => {
    const rows = classifyDiffLines("A\nB\nC", "A\nB");
    expect(rows).toHaveLength(3);
    expect(rows[2].kind).toBe("textChanged"); // C vs (空)
  });
});
