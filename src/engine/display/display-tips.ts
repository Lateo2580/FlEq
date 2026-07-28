// ディスプレイのテロップ待機中に流す Tips のデッキ生成 (spec: 2026-07-12-ticker-tips-design.md §2-3)。
// CLI 操作の文脈がないディスプレイでは REPL コマンド系カテゴリを除外し、知識系のみを配る。
import { TipShuffler } from "../../tips/tip-shuffler";
import type { EmergencyHazard, TipCategoryId, TipContext } from "../../tips/waiting-tips";
import { TIP_CATEGORIES } from "../../tips/waiting-tips";

export type { EmergencyHazard, TipContext } from "../../tips/waiting-tips";

/** ブラウザへ渡す最小 deck entry。出典・確認日・失効日はサーバ側定義にのみ保持する。 */
export interface DisplayTipDeckItem {
  readonly id: string;
  readonly text: string;
  readonly hazards: readonly EmergencyHazard[];
}

/** ディスプレイに流さないカテゴリ (除外リスト方式 — 新設の知識系カテゴリは自動で対象になる) */
export const EXCLUDED_TIP_CATEGORY_IDS: readonly TipCategoryId[] = [
  "commands-basic",
  "commands-advanced",
  "tool-internals",
];

function displayCategoryIds(context: TipContext): TipCategoryId[] {
  return TIP_CATEGORIES
    .filter((category) => !EXCLUDED_TIP_CATEGORY_IDS.includes(category.id))
    .filter((category) => (category.contexts ?? ["standby"]).includes(context))
    .map((category) => category.id);
}

const TIP_PREFIX = "Tip: ";

/**
 * 知識系 Tips のシャッフル済み 1 エポック分を返す。
 * ディスプレイではチップ (「ヒント」ラベル) で種別を示すため、文頭の "Tip: " prefix は冗長として除去する。
 * リクエストごとに新しいデッキを生成し、サーバに永続状態は持たない。
 */
export function buildTipsDeck(
  context: TipContext = "standby",
  rng: () => number = Math.random,
  nowMs: number = Date.now(),
): DisplayTipDeckItem[] {
  return new TipShuffler(rng, displayCategoryIds(context))
    .dealEpochEntries()
    .flatMap((entry): DisplayTipDeckItem[] => {
      const content = entry.content;
      if (typeof content === "string") {
        return [{
          id: `${entry.categoryId}:${entry.index}`,
          text: content.startsWith(TIP_PREFIX) ? content.slice(TIP_PREFIX.length) : content,
          hazards: [],
        }];
      }
      // 失効済みの文面を緊急画面へ出さない。失効日は ISO 文字列としてサーバ側で管理する。
      if (Date.parse(content.expiresAt) <= nowMs) return [];
      return [{
        id: content.id,
        text: content.text.startsWith(TIP_PREFIX) ? content.text.slice(TIP_PREFIX.length) : content.text,
        hazards: content.hazards,
      }];
    });
}
