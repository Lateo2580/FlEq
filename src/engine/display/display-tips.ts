// ディスプレイのテロップ待機中に流す Tips のデッキ生成 (spec: 2026-07-12-ticker-tips-design.md §2-3)。
// CLI 操作の文脈がないディスプレイでは REPL コマンド系カテゴリを除外し、知識系のみを配る。
import { TipShuffler } from "../../tips/tip-shuffler";
import type { TipCategoryId } from "../../tips/waiting-tips";
import { TIP_CATEGORIES } from "../../tips/waiting-tips";

/** ディスプレイに流さないカテゴリ (除外リスト方式 — 新設の知識系カテゴリは自動で対象になる) */
export const EXCLUDED_TIP_CATEGORY_IDS: readonly TipCategoryId[] = [
  "commands-basic",
  "commands-advanced",
  "tool-internals",
];

const DISPLAY_TIP_CATEGORY_IDS: readonly TipCategoryId[] = TIP_CATEGORIES.map((c) => c.id).filter(
  (id) => !EXCLUDED_TIP_CATEGORY_IDS.includes(id),
);

const TIP_PREFIX = "Tip: ";

/**
 * 知識系 Tips のシャッフル済み 1 エポック分を返す。
 * ディスプレイではチップ (「ヒント」ラベル) で種別を示すため、文頭の "Tip: " prefix は冗長として除去する。
 * リクエストごとに新しいデッキを生成し、サーバに永続状態は持たない。
 */
export function buildTipsDeck(rng: () => number = Math.random): string[] {
  return new TipShuffler(rng, DISPLAY_TIP_CATEGORY_IDS)
    .dealEpoch()
    .map((tip) => (tip.startsWith(TIP_PREFIX) ? tip.slice(TIP_PREFIX.length) : tip));
}
