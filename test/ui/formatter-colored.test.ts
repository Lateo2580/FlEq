import { describe, it, expect } from "vitest";
import chalk from "chalk";
import {
  frameTopColored, frameBottomColored, frameLineColored, frameDividerColored,
  frameDividerLabeledColored, stripAnsi, visualWidth, wrapFrameLines,
  getFrameLineClampFallbackCount, resetFrameLineClampFallbackCount,
} from "../../src/ui/formatter";

const id = (s: string) => s;            // 色なし (素通し) で幾何検証
const tag = (s: string) => `<${s}>`;    // 注入色のダミー

describe("色注入版 frame primitive — 幅と罫線スタイル", () => {
  it("過長本文は最終省略し、右枠を指定幅の末尾へ戻す", () => {
    resetFrameLineClampFallbackCount();
    const out = frameLineColored("critical", id, "あ".repeat(100), 40);
    expect(visualWidth(stripAnsi(out))).toBe(40);
    expect(stripAnsi(out).endsWith("║")).toBe(true);
    expect(stripAnsi(out)).toContain("…");
    expect(getFrameLineClampFallbackCount()).toBe(1);
  });
  it("frameLineColored: 全体 visualWidth = width、styleLevel=critical で ║", () => {
    const out = frameLineColored("critical", id, "本文", 40);
    expect(visualWidth(stripAnsi(out))).toBe(40);
    expect(stripAnsi(out).startsWith("║")).toBe(true);
    expect(stripAnsi(out).endsWith("║")).toBe(true);
  });
  it("frameLineColored: styleLevel=info で │", () => {
    expect(stripAnsi(frameLineColored("info", id, "本文", 40)).startsWith("│")).toBe(true);
  });
  it("frameLineColored: borderColor は罫線に適用、内容は素通し", () => {
    const out = frameLineColored("critical", tag, "本文", 40);
    expect(out).toContain("<║>");
    expect(out).toContain("本文");
  });
  it("frameTopColored / frameBottomColored: width 一致、角文字", () => {
    expect(visualWidth(stripAnsi(frameTopColored("critical", id, 40)))).toBe(40);
    expect(stripAnsi(frameTopColored("critical", id, 40)).startsWith("╔")).toBe(true);
    expect(stripAnsi(frameBottomColored("critical", id, 40)).startsWith("╚")).toBe(true);
  });
  it("frameDividerColored: width 一致、╠ ═ ╣", () => {
    const out = frameDividerColored("critical", id, 40);
    expect(visualWidth(stripAnsi(out))).toBe(40);
    expect(stripAnsi(out).startsWith("╠")).toBe(true);
    expect(stripAnsi(out).endsWith("╣")).toBe(true);
  });
});

describe("frameDividerLabeledColored", () => {
  it("装飾済ラベル + 罫線、全体 visualWidth = width", () => {
    const out = frameDividerLabeledColored("critical", id, "★ 危険警報 (L4)", 80);
    expect(visualWidth(stripAnsi(out))).toBe(80);
    expect(stripAnsi(out)).toContain("危険警報");
    expect(stripAnsi(out).startsWith("╠")).toBe(true);
    expect(stripAnsi(out).endsWith("╣")).toBe(true);
  });
  it("borderColor は罫線のみ、ラベルは二重着色しない", () => {
    const out = frameDividerLabeledColored("critical", tag, "ラベル", 40);
    expect(out).toContain("<╠>");
    expect(out).toContain("ラベル");
  });
});

describe("frameDividerLabeledColored clipping", () => {
  it("clips long ANSI labels at boundary widths without losing color", () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      const label = chalk.red("非常に長い危険警報ラベル");
      for (const width of [8, 12, 20]) {
        const out = frameDividerLabeledColored("critical", id, label, width);
        expect(visualWidth(stripAnsi(out))).toBe(width);
        expect(stripAnsi(out).startsWith("╠")).toBe(true);
        expect(stripAnsi(out).endsWith("╣")).toBe(true);
        expect(out).toMatch(/\x1B\[[\d;]*m/);
        expect(out).toContain("\x1b[0m╣");
      }
    } finally {
      chalk.level = prevLevel;
    }
  });
});

describe("wrapFrameLines ' / ' delimiter (Phase C)", () => {
  it("' / ' 区切りの長い行は区切り位置で折り返され ANSI が保持される", () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      const token = chalk.red("◆暴風");
      const areas = Array.from({ length: 20 }, (_, i) => `予報区${i}`).join(" / ");
      const lines = wrapFrameLines("normal", `  ${token} / ${areas}`, 60);
      // 複数行に折り返されること
      expect(lines.length).toBeGreaterThan(1);
      // hard-wrap fallback に落ちていない傍証: 1 行目にトークン文字列が残る
      expect(stripAnsi(lines[0])).toContain("◆暴風");
      // ESC シーケンスが存在すること (chalk 内部構造に依存しない直接アサート)
      expect(/\x1B\[[\d;]*m/.test(lines[0])).toBe(true);
      // 罫線色の ESC だけでも上は true になり得るため、トークン直前に ESC が
      // 付いていること (= トークン自体が着色されたまま) も確認する。
      // hard-wrap fallback は内容を stripAnsi するためこのパターンは消える
      expect(/\x1B\[[\d;]*m◆暴風/.test(lines[0])).toBe(true);
    } finally {
      chalk.level = prevLevel;
    }
  });
});
