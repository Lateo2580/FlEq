import type {
  IntensitySafetyRank,
  JmaIntensity,
  JmaLgIntensity,
  LgIntensityRank,
  LgIntensitySafetyRank,
  SpecialValue,
  SpecialValueDisplaySemantic,
} from "../types";

/** 震度文字列と数値ランクの対応表。rank 0 は exact 震度0にも使う legacy scalar 値。 */
const INTENSITY_RANK: Record<string, number> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
  "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
  "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
};

const JMA_INTENSITY_RANK: Record<JmaIntensity, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5-": 5,
  "5+": 6,
  "6-": 7,
  "6+": 8,
  "7": 9,
};

const JMA_LG_INTENSITY_RANK: Record<JmaLgIntensity, LgIntensityRank> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
};

/** 震度文字列をソート・比較用の数値に変換する (不明な値は 0) */
export function intensityToRank(intensity: string): number {
  return INTENSITY_RANK[intensity.replace(/\s+/g, "")] ?? 0;
}

function intensityRank(value: JmaIntensity | null | undefined): number | null {
  return value == null ? null : JMA_INTENSITY_RANK[value] ?? null;
}

function lgIntensityRank(value: JmaLgIntensity | null | undefined): LgIntensityRank | null {
  return value == null ? null : JMA_LG_INTENSITY_RANK[value] ?? null;
}

/**
 * SpecialValue 震度を安全側 rank へ評価する。
 * missing／empty／unknown／bounds のない qualitative は数値化せず unknown を返す。
 */
export function evaluateIntensitySafetyRank(
  intensity: SpecialValue<JmaIntensity>,
): IntensitySafetyRank {
  if (intensity.presence === "value") {
    const rank = intensityRank(intensity.value);
    return rank == null ? { kind: "unknown" } : { kind: "known", lower: rank, upper: rank };
  }
  if (intensity.presence !== "range" && intensity.presence !== "qualitative") {
    return { kind: "unknown" };
  }
  const lower = intensityRank(intensity.lowerBound);
  const upper = intensityRank(intensity.upperBound);
  if (lower == null && upper == null) return { kind: "unknown" };
  const effectiveLower = lower ?? JMA_INTENSITY_RANK["0"];
  if (upper != null && effectiveLower > upper) return { kind: "unknown" };
  return { kind: "known", lower: effectiveLower, upper };
}

/** 長周期地震動階級を震度とは別の 0〜4 safety rank へ評価する。 */
export function evaluateLgIntensitySafetyRank(
  intensity: SpecialValue<JmaLgIntensity>,
): LgIntensitySafetyRank {
  if (intensity.presence === "value") {
    const rank = lgIntensityRank(intensity.value);
    return rank == null ? { kind: "unknown" } : { kind: "known", lower: rank, upper: rank };
  }
  if (intensity.presence !== "range" && intensity.presence !== "qualitative") {
    return { kind: "unknown" };
  }
  const lower = lgIntensityRank(intensity.lowerBound);
  const upper = lgIntensityRank(intensity.upperBound);
  if (lower == null && upper == null) return { kind: "unknown" };
  const effectiveLower: LgIntensityRank = lower ?? 0;
  if (upper != null && effectiveLower > upper) return { kind: "unknown" };
  return { kind: "known", lower: effectiveLower, upper };
}

/** spec §3.8 の色・記号バッジ規約を SpecialValue の構造だけから導出する。 */
export function specialValueDisplaySemantic<T>(
  specialValue: SpecialValue<T>,
): SpecialValueDisplaySemantic {
  switch (specialValue.presence) {
    case "value":
      return specialValue.value == null
        ? { kind: "unknown", color: "unknown", badge: "?", render: true }
        : { kind: "exact", color: "normalRank", badge: null, render: true };
    case "missing":
      return { kind: "missing", color: "notRendered", badge: null, render: false };
    case "empty":
      return { kind: "empty", color: "neutral", badge: "∅", render: true };
    case "unknown":
      return { kind: "unknown", color: "unknown", badge: "?", render: true };
    case "qualitative":
      return specialValue.lowerBound != null
        ? { kind: "lowerBound", color: "safetyRank", badge: "≥", render: true }
        : { kind: "unknown", color: "unknown", badge: "?", render: true };
    case "range": {
      const hasLower = specialValue.lowerBound != null;
      const hasUpper = specialValue.upperBound != null;
      if (hasLower && !hasUpper) {
        return { kind: "lowerBound", color: "safetyRank", badge: "≥", render: true };
      }
      if (hasLower || hasUpper) {
        return { kind: "range", color: "safetyUpperRank", badge: "↔", render: true };
      }
      return { kind: "unknown", color: "unknown", badge: "?", render: true };
    }
  }
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
