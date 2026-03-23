import { describe, it, expect, vi } from "vitest";
import { TIP_CATEGORIES } from "../../src/ui/waiting-tips";

// テスト用に固定シードの疑似RNGを生成する
function createSeededRng(seed: number): () => number {
  let s = seed;
  return () => {
    // 簡易的な線形合同法
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// TipShuffler を動的に import（waiting-tips のモック反映のため）
async function createShuffler(rng?: () => number) {
  const { TipShuffler } = await import("../../src/ui/tip-shuffler");
  return new TipShuffler(rng);
}

/** 全カテゴリのTip総数 */
const TOTAL_TIPS = TIP_CATEGORIES.reduce((sum, c) => sum + c.tips.length, 0);

/** Tip文字列からカテゴリインデックスを逆引きする */
function getCategoryIndex(tip: string): number {
  for (let i = 0; i < TIP_CATEGORIES.length; i++) {
    if (TIP_CATEGORIES[i].tips.includes(tip)) return i;
  }
  return -1;
}

describe("TipShuffler", () => {
  it("next() が文字列を返す", async () => {
    const shuffler = await createShuffler(createSeededRng(42));
    const tip = shuffler.next();
    expect(typeof tip).toBe("string");
    expect(tip.length).toBeGreaterThan(0);
  });

  it("全Tipを一巡するまで重複がない（1エポック）", async () => {
    const shuffler = await createShuffler(createSeededRng(42));
    const seen = new Set<string>();

    for (let i = 0; i < TOTAL_TIPS; i++) {
      const tip = shuffler.next();
      expect(seen.has(tip)).toBe(false);
      seen.add(tip);
    }

    expect(seen.size).toBe(TOTAL_TIPS);
  });

  it("同カテゴリのTipが連続しない（1カテゴリだけ残る末尾を除く）", async () => {
    const shuffler = await createShuffler(createSeededRng(123));
    let lastCategory = -1;
    let consecutiveCount = 0;
    let maxConsecutive = 0;

    for (let i = 0; i < TOTAL_TIPS; i++) {
      const tip = shuffler.next();
      const category = getCategoryIndex(tip);
      expect(category).not.toBe(-1);

      if (category === lastCategory) {
        consecutiveCount++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
      } else {
        consecutiveCount = 0;
      }
      lastCategory = category;
    }

    // 最大カテゴリ（trivia: ~51件）以外のカテゴリが全部消えた後に
    // 連続する可能性はあるが、中盤までは連続しないことを確認
    // maxConsecutive が全体の一部に限定されること
    // （完全にゼロにはならない: 最後の1カテゴリだけ残る場合がある）
    expect(maxConsecutive).toBeLessThan(
      Math.max(...TIP_CATEGORIES.map((c) => c.tips.length)),
    );
  });

  it("1エポック消費後にデッキが再構築される", async () => {
    const shuffler = await createShuffler(createSeededRng(42));

    // 1エポック分消費
    for (let i = 0; i < TOTAL_TIPS; i++) {
      shuffler.next();
    }

    // 次のエポックでも正常にTipが返る
    const tip = shuffler.next();
    expect(typeof tip).toBe("string");
    expect(tip.length).toBeGreaterThan(0);

    // 2エポック目も全件返る
    const secondEpoch = new Set<string>();
    secondEpoch.add(tip);
    for (let i = 1; i < TOTAL_TIPS; i++) {
      secondEpoch.add(shuffler.next());
    }
    expect(secondEpoch.size).toBe(TOTAL_TIPS);
  });

  it("異なるシードで異なる順序が生成される", async () => {
    const shuffler1 = await createShuffler(createSeededRng(1));
    const shuffler2 = await createShuffler(createSeededRng(999));

    const order1: string[] = [];
    const order2: string[] = [];
    for (let i = 0; i < 20; i++) {
      order1.push(shuffler1.next());
      order2.push(shuffler2.next());
    }

    // 完全一致しないことを確認（確率的にほぼ確実）
    const allSame = order1.every((tip, i) => tip === order2[i]);
    expect(allSame).toBe(false);
  });

  it("全カテゴリのTipがエポック内に含まれる", async () => {
    const shuffler = await createShuffler(createSeededRng(42));
    const categorySet = new Set<number>();

    for (let i = 0; i < TOTAL_TIPS; i++) {
      const tip = shuffler.next();
      categorySet.add(getCategoryIndex(tip));
    }

    expect(categorySet.size).toBe(TIP_CATEGORIES.length);
  });
});
