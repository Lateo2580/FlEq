/** 震度文字列と数値ランクの対応表 */
const INTENSITY_RANK: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4,
  "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
  "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
};

/** 震度文字列をソート・比較用の数値に変換する (不明な値は 0) */
export function intensityToRank(intensity: string): number {
  return INTENSITY_RANK[intensity.replace(/\s+/g, "")] ?? 0;
}
