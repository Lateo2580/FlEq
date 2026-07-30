import { describe, expect, it } from "vitest";
import {
  buildTipsDeck,
  EXCLUDED_TIP_CATEGORY_IDS,
  QUAKE_MAP_TIP_CATEGORY_IDS,
} from "../../../src/engine/display/display-tips.js";
import { TIP_CATEGORIES } from "../../../src/tips/waiting-tips.js";

function textOf(tip: (typeof TIP_CATEGORIES)[number]["tips"][number]): string {
  const text = typeof tip === "string" ? tip : tip.text;
  return text.replace(/^Tip: /, "");
}

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
        c.tips.map(textOf),
      ),
    );
    const deck = buildTipsDeck("standby", createSeededRng(42));
    for (const tip of deck) {
      expect(excludedTips.has(tip.text)).toBe(false);
    }
  });

  it("知識系カテゴリの全 Tips を過不足なく含む", () => {
    const expected = new Set(
      TIP_CATEGORIES.filter((c) => !EXCLUDED_TIP_CATEGORY_IDS.includes(c.id)).flatMap((c) =>
        c.tips.map(textOf),
      ),
    );
    const deck = buildTipsDeck("standby", createSeededRng(42));
    expect(deck.length).toBe(expected.size);
    for (const tip of deck) {
      expect(expected.has(tip.text)).toBe(true);
    }
  });

  it("全要素の文頭から Tip: prefix が除去されている", () => {
    const deck = buildTipsDeck("standby", createSeededRng(1));
    expect(deck.length).toBeGreaterThan(0);
    for (const tip of deck) {
      expect(tip.text.startsWith("Tip: ")).toBe(false);
      expect(tip.text.length).toBeGreaterThan(0);
    }
  });

  it("rng が異なればデッキの順序が変わる (シャッフルされている)", () => {
    const a = buildTipsDeck("standby", createSeededRng(1));
    const b = buildTipsDeck("standby", createSeededRng(2));
    expect(a).not.toEqual(b);
    expect(a.map((tip) => tip.id).sort()).toEqual(b.map((tip) => tip.id).sort());
  });

  it("emergency deck は emergency-guidance の承認済み 10 件を重複なく全件含む", () => {
    const category = TIP_CATEGORIES.find((entry) => entry.id === "emergency-guidance");
    expect(category).toBeDefined();
    expect(category?.tips).toHaveLength(10);
    const expected = category!.tips.map((tip) => {
      expect(typeof tip).not.toBe("string");
      if (typeof tip === "string") throw new Error("emergency-guidance は metadata entry で定義する");
      expect(tip.reviewedAt).toBe("2026-07-29");
      expect(tip.expiresAt).toBe("2027-07-29");
      return {
        id: tip.id,
        text: tip.text.replace(/^Tip: /, ""),
        hazards: tip.hazards,
      };
    });
    const metadata = category!.tips.filter((tip) => typeof tip !== "string");
    expect(metadata.map((tip) => tip.source)).toEqual([
      "https://www.ntt-east.co.jp/saigai/voice171/",
      null,
      null,
      null,
      "https://www.city.higashiosaka.lg.jp/0000023450.html",
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(metadata.slice(0, 9).every((tip) =>
      tip.hazards.length === 4
      && ["eew", "tsunami", "earthquake", "weather"].every((hazard) =>
        tip.hazards.includes(hazard as (typeof tip.hazards)[number]),
      ),
    )).toBe(true);

    const deck = buildTipsDeck("emergency", createSeededRng(1));
    expect(deck).toHaveLength(10);
    expect(new Set(deck.map((tip) => tip.id)).size).toBe(10);
    expect([...deck].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...expected].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(deck.every((tip) => !tip.text.startsWith("Tip: "))).toBe(true);
    expect(deck.find((tip) => tip.id === "emergency-guidance-10")?.hazards).toEqual(["tsunami"]);
  });

  it("quakeMap deck は地震・津波・防災カテゴリだけを過不足なく含む", () => {
    const expected = new Set(
      TIP_CATEGORIES
        .filter((category) => QUAKE_MAP_TIP_CATEGORY_IDS.includes(category.id))
        .flatMap((category) => category.tips.map(textOf)),
    );
    const deck = buildTipsDeck("quakeMap", createSeededRng(42));
    expect(deck.length).toBe(expected.size);
    expect(deck.length).toBeGreaterThan(0);
    for (const tip of deck) {
      expect(expected.has(tip.text)).toBe(true);
    }
  });
});
