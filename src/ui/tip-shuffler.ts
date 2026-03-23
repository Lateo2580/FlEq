import { TIP_CATEGORIES } from "./waiting-tips";

/**
 * 待機中Tipのエポックデッキ生成シャッフラ。
 *
 * - カテゴリごとにシャッフルした後、同カテゴリ連続を避けつつ
 *   全Tipを1エポック分のデッキにインターリーブする。
 * - デッキを使い切ったら自動で再構築する。
 * - タイミング制御は持たず、`next()` で次のTipを返すだけの純粋な順序供給器。
 */
export class TipShuffler {
  private deck: string[] = [];
  private rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
    this.rebuildDeck();
  }

  /** 次のTipを返す。デッキが空なら自動再構築。 */
  next(): string {
    if (this.deck.length === 0) {
      this.rebuildDeck();
    }
    return this.deck.shift()!;
  }

  private rebuildDeck(): void {
    // 1. カテゴリごとにシャッフル
    const buckets: { categoryIndex: number; tip: string }[] = [];
    for (let ci = 0; ci < TIP_CATEGORIES.length; ci++) {
      const shuffled = this.shuffle([...TIP_CATEGORIES[ci].tips]);
      for (const tip of shuffled) {
        buckets.push({ categoryIndex: ci, tip });
      }
    }

    // 2. インターリーブ: 同カテゴリ連続を避けつつデッキ構築
    this.deck = this.interleave(buckets);
  }

  /** 同カテゴリ連続を避けつつ全アイテムをインターリーブする */
  private interleave(
    items: { categoryIndex: number; tip: string }[],
  ): string[] {
    // カテゴリごとのキューに分割
    const queues = new Map<number, string[]>();
    for (const item of items) {
      if (!queues.has(item.categoryIndex)) {
        queues.set(item.categoryIndex, []);
      }
      queues.get(item.categoryIndex)!.push(item.tip);
    }

    const result: string[] = [];
    let lastCategory = -1;

    while (queues.size > 0) {
      // 直前カテゴリ以外で残りがあるカテゴリから選択
      const candidates = [...queues.keys()].filter((k) => k !== lastCategory);
      if (candidates.length === 0) {
        // 1カテゴリしか残っていない場合はそのまま流し込む
        const remaining = [...queues.keys()][0];
        result.push(...queues.get(remaining)!);
        queues.delete(remaining);
        break;
      }

      // ランダムに1カテゴリ選択
      const chosen = candidates[Math.floor(this.rng() * candidates.length)];
      const queue = queues.get(chosen)!;
      result.push(queue.shift()!);
      lastCategory = chosen;

      if (queue.length === 0) {
        queues.delete(chosen);
      }
    }

    return result;
  }

  /** Fisher-Yates シャッフル */
  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
