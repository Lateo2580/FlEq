import type { TyphoonProbRegion, TyphoonProbPeak } from "../../types";

export interface PrefAggregate {
  prefName: string;
  prefCode: string;
  maxDaily5: number;
  worstRegion: TyphoonProbRegion;
  worstPeak: TyphoonProbPeak;
  regions: TyphoonProbRegion[];
}

export const TARGET_ROWS = 24;
export const CANDIDATE_THRESHOLDS = [1, 3, 5, 10, 20, 30, 50] as const;

export function aggregateByPrefecture(regions: TyphoonProbRegion[]): PrefAggregate[] {
  const map = new Map<string, PrefAggregate>();
  for (const r of regions) {
    const cur = map.get(r.prefCode);
    if (cur == null) {
      map.set(r.prefCode, {
        prefName: r.prefName,
        prefCode: r.prefCode,
        maxDaily5: r.daily[4] ?? 0,
        worstRegion: r,
        worstPeak: r.peak,
        regions: [r],
      });
    } else {
      cur.regions.push(r);
      const d4 = r.daily[4] ?? 0;
      if (d4 > cur.maxDaily5) {
        cur.maxDaily5 = d4;
        cur.worstRegion = r;
        cur.worstPeak = r.peak;
      }
    }
  }
  // 府県内の地域を daily[4] 降順
  for (const agg of map.values()) {
    agg.regions.sort((a, b) => (b.daily[4] ?? 0) - (a.daily[4] ?? 0));
  }
  // 府県を maxDaily5 降順
  return Array.from(map.values()).sort((a, b) => b.maxDaily5 - a.maxDaily5);
}

/**
 * 候補閾値から「visible.length <= targetRows を満たす最小閾値」を選ぶ。
 * すべての閾値で超過する場合は最大候補を返す（hidden が出る）。
 */
export function pickThreshold(
  activePrefs: PrefAggregate[],
  targetRows: number,
): number {
  for (const t of CANDIDATE_THRESHOLDS) {
    const visible = activePrefs.filter(p => p.maxDaily5 >= t).length;
    if (visible <= targetRows) return t;
  }
  return CANDIDATE_THRESHOLDS[CANDIDATE_THRESHOLDS.length - 1];
}
