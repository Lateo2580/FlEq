/** frameLevel → 数値ランク (順序比較用) */
export const FRAME_LEVEL_RANK: Record<string, number> = {
  cancel: 0,
  info: 1,
  normal: 2,
  warning: 3,
  critical: 4,
};

/** 震度文字列 → 数値ランク (順序比較用) */
export const INTENSITY_RANK: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4,
  "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
  "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
};

/** 長周期地震動階級 → 数値ランク */
export const LG_INT_RANK: Record<string, number> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
};

/** 文字列からランク値を返す。未知の値は null */
export function toFrameLevelRank(value: string): number | null {
  return FRAME_LEVEL_RANK[value] ?? null;
}

export function toIntensityRank(value: string): number | null {
  return INTENSITY_RANK[value.replace(/\s+/g, "")] ?? null;
}

export function toLgIntRank(value: string): number | null {
  return LG_INT_RANK[value] ?? null;
}
