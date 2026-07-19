// LatestQuakeCard (待機カード) の震度別リストレイアウト判定用の純関数群 (第3波 Fix13/Fix17)。
// Fix11 (件数駆動の2列化) はユーザーの実機確認で「列分割による単語の泣き別れ + 狭い列での
// 可読性悪化」が判明したため撤回し、Fix13 (最大震度グループ固定 + 残りの自動縦スクロール) へ
// 移行した。Fix17 は南海トラフ想定 (震度7 単体で 10県153市町村) で固定領域自体が肥大化する
// ケースに対応し、固定領域を「県集約サマリ」に縮退させる判定を追加する。
// T6: 自動スクロール判定 (shouldAutoScroll/scrollOverflowPx) は「固定サマリ計器 + ページング」
// 転換 (T5) で不要化したため撤去した。県集約縮退判定 (shouldCompactTopGroup 系) は生存。
import { effectiveAreaCount } from "./instrument-layout";
import type { DisplayIntensityGroupV1 } from "./protocol";

// 固定領域に表示する最大震度グループの地域件数がこれを超えたら、市区町村の全文リストではなく
// 県ごとの件数だけの集約サマリへ縮退する (南海トラフ級)。通常/3.11 級シナリオの最大震度グループは
// 一桁〜十数件に収まるため誤発動しない (3.11 の 6強 グループは最大でも 19 件)
export const TOP_GROUP_COMPACT_AREA_THRESHOLD = 30;

/** 最大震度グループを「チップ + 県名と件数だけ」の集約サマリへ縮退させるべきか。
 *  判定は effectiveAreaCount (areas.length + omittedAreaCount) で行う (instrument-layout.ts) */
export function shouldCompactTopGroup(group: DisplayIntensityGroupV1 | null): boolean {
  return group != null && effectiveAreaCount(group) > TOP_GROUP_COMPACT_AREA_THRESHOLD;
}

/** 震度別リストを「最大震度グループ (常時固定表示)」と「それ以外 (自動スクロール対象)」に分割する。
 *  intensityGroups は groupIntensityAreas によって既に rank 降順でソートされている前提のため、
 *  先頭 (最初の要素) が常に最大震度になる */
export function splitTopGroup(groups: DisplayIntensityGroupV1[]): {
  top: DisplayIntensityGroupV1 | null;
  rest: DisplayIntensityGroupV1[];
} {
  if (groups.length === 0) return { top: null, rest: [] };
  const [top, ...rest] = groups;
  return { top, rest };
}
