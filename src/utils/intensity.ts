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

/**
 * EEW 予測震度の悲観側 (To 基準) 値を返す (spec 4.5 の一気通貫算出点)。
 * - To 未設定 → From
 * - To が不明ランク ("over" 等の特殊値) → From に fallback (fail-safe。表示側で「◯程度以上」を別途表現)
 * - それ以外 → ランクの高い方
 * 算出箇所を formatter / tracker / summary / notifier / logger の呼び出し点で共用し、増殖を防ぐ。
 */
export function eewPessimisticIntensity(intensity: string, intensityTo?: string): string {
  if (intensityTo == null) return intensity;
  const toRank = intensityToRank(intensityTo);
  if (toRank === 0) return intensity;
  return toRank >= intensityToRank(intensity) ? intensityTo : intensity;
}
