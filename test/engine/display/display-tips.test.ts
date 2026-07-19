import { describe, expect, it } from "vitest";
import { buildTipsDeck, EXCLUDED_TIP_CATEGORY_IDS } from "../../../src/engine/display/display-tips.js";
import { TIP_CATEGORIES } from "../../../src/tips/waiting-tips.js";

function createSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("buildTipsDeck", () => {
  it("除外カテゴリ (コマンド操作系) の Tips を一切含まない", () => {
    const excludedTips = new Set(
      TIP_CATEGORIES.filter((c) => EXCLUDED_TIP_CATEGORY_IDS.includes(c.id)).flatMap((c) =>
        c.tips.map((t) => t.replace(/^Tip: /, "")),
      ),
    );
    const deck = buildTipsDeck(createSeededRng(42));
    for (const tip of deck) {
      expect(excludedTips.has(tip)).toBe(false);
    }
  });

  it("知識系カテゴリの全 Tips を過不足なく含む", () => {
    const expected = new Set(
      TIP_CATEGORIES.filter((c) => !EXCLUDED_TIP_CATEGORY_IDS.includes(c.id)).flatMap((c) =>
        c.tips.map((t) => t.replace(/^Tip: /, "")),
      ),
    );
    const deck = buildTipsDeck(createSeededRng(42));
    expect(deck.length).toBe(expected.size);
    for (const tip of deck) {
      expect(expected.has(tip)).toBe(true);
    }
  });

  it("全要素の文頭から Tip: prefix が除去されている", () => {
    const deck = buildTipsDeck(createSeededRng(1));
    expect(deck.length).toBeGreaterThan(0);
    for (const tip of deck) {
      expect(tip.startsWith("Tip: ")).toBe(false);
      expect(tip.length).toBeGreaterThan(0);
    }
  });

  it("rng が異なればデッキの順序が変わる (シャッフルされている)", () => {
    const a = buildTipsDeck(createSeededRng(1));
    const b = buildTipsDeck(createSeededRng(2));
    expect(a).not.toEqual(b);
    expect([...a].sort()).toEqual([...b].sort());
  });
});
