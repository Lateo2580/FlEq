import { TIP_CATEGORIES } from "./waiting-tips";
import type { TipCategory, TipCategoryId, TipContent } from "./waiting-tips";

/** シャッフル後もカテゴリと定義内 index を保持する表示用 entry。 */
export interface ShuffledTip {
  readonly categoryId: TipCategoryId;
  readonly index: number;
  readonly content: TipContent;
}

/**
 * 待機中Tipのエポックデッキ生成シャッフラ。
 *
 * - カテゴリごとにシャッフルした後、同カテゴリ連続を避けつつ
 *   全Tipを1エポック分のデッキにインターリーブする。
 * - デッキを使い切ったら自動で再構築する。
 * - タイミング制御は持たず、`next()` で次のTipを返すだけの純粋な順序供給器。
 */
export class TipShuffler {
  private deck: ShuffledTip[] = [];
  private rng: () => number;
  private categories: readonly TipCategory[];

  constructor(
    rng: () => number = Math.random,
    categoryIds?: readonly TipCategoryId[],
  ) {
    this.rng = rng;
    this.categories =
      categoryIds == null
        ? TIP_CATEGORIES
        : TIP_CATEGORIES.filter((c) => categoryIds.includes(c.id));
    this.rebuildDeck();
  }

  /** 次のTipを返す。デッキが空なら自動再構築。 */
  next(): string {
    if (this.deck.length === 0) {
      this.rebuildDeck();
    }
    return textOf(this.deck.shift()!.content);
  }

  /** シャッフル済み1エポック分を一括で返す。呼ぶたびに新しいデッキを構築する。 */
  dealEpoch(): string[] {
    this.rebuildDeck();
    const epoch = this.deck;
    this.deck = [];
    return epoch.map((entry) => textOf(entry.content));
  }

  /** 表示 API 向けに、メタデータを落とさない 1 エポック分を返す。 */
  dealEpochEntries(): ShuffledTip[] {
    this.rebuildDeck();
    const epoch = this.deck;
    this.deck = [];
    return epoch;
  }

  private rebuildDeck(): void {
    // 1. カテゴリごとにシャッフル
    const buckets: { categoryIndex: number; tip: ShuffledTip }[] = [];
    for (let ci = 0; ci < this.categories.length; ci++) {
      const category = this.categories[ci]!;
      const shuffled = this.shuffle(category.tips.map((content, index) => ({
        categoryId: category.id,
        index,
        content,
      })));
      for (const tip of shuffled) {
        buckets.push({ categoryIndex: ci, tip });
      }
    }

    // 2. インターリーブ: 同カテゴリ連続を避けつつデッキ構築
    this.deck = this.interleave(buckets);
  }

  /** 同カテゴリ連続を避けつつ全アイテムをインターリーブする */
  private interleave(
    items: { categoryIndex: number; tip: ShuffledTip }[],
  ): ShuffledTip[] {
    // カテゴリごとのキューに分割
    const queues = new Map<number, ShuffledTip[]>();
    for (const item of items) {
      if (!queues.has(item.categoryIndex)) {
        queues.set(item.categoryIndex, []);
      }
      queues.get(item.categoryIndex)!.push(item.tip);
    }

    const result: ShuffledTip[] = [];
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

function textOf(content: TipContent): string {
  return typeof content === "string" ? content : content.text;
}
