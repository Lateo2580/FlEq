// 履歴クリックの詳細カード (QuakeReplayCard) 用に、各地の震度グループを compact に間引く純関数
// (2026-07-14 各地の震度表示)。corner スロットのコンパクトカードに収めるため、ページング
// (LatestQuakeCard の paginateAreas/PageCycler) は持ち込まず、rank 降順で上位から地域名の総数を
// 予算内に切り詰め、あふれた分は「ほか N 地域」型の一括省略にまとめる。サーバ側 cap で既に切られた
// 分 (omittedAreaCount) も省略数に加算する。
import type { DisplayIntensityGroupV1 } from "./protocol";

// カードに出す地域名 (市区町村・地方名) の総数上限。これを超える分は「ほか N 地域」に畳む。
// 大規模地震でもカード高さが corner スロットで暴れないよう固定上限を課す。
export const QUAKE_REPLAY_AREA_BUDGET = 8;

export interface CompactIntensityGroup {
  intensity: string;
  rank: number;
  areas: string[];
}

export interface CompactIntensityResult {
  groups: CompactIntensityGroup[];
  /** 予算超過で出せなかった地域名 + サーバ cap の omittedAreaCount の合計 (「ほか N 地域」用) */
  omittedAreaCount: number;
}

/**
 * intensityGroups を rank 降順で上位から areaBudget 件まで表示し、残りを omittedAreaCount に畳む。
 * 予算が尽きた以降のグループは丸ごと省略数へ。空入力・全省略時は groups=[] を返す (呼び出し側で
 * 震度セクションごと非表示にする = 無い情報を偽装しない)。
 */
export function compactIntensityGroups(
  groups: DisplayIntensityGroupV1[],
  areaBudget = QUAKE_REPLAY_AREA_BUDGET,
): CompactIntensityResult {
  const sorted = [...groups].sort((a, b) => b.rank - a.rank);
  const out: CompactIntensityGroup[] = [];
  let budget = areaBudget;
  let omitted = 0;
  for (const g of sorted) {
    omitted += g.omittedAreaCount; // サーバ cap で既に切られた分は必ず加算
    const take = budget > 0 ? Math.min(g.areas.length, budget) : 0;
    if (take > 0) {
      out.push({ intensity: g.intensity, rank: g.rank, areas: g.areas.slice(0, take) });
      budget -= take;
    }
    omitted += g.areas.length - take; // 予算超過で入らなかった地域名
  }
  return { groups: out, omittedAreaCount: omitted };
}
