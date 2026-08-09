import type { SpecialValue } from "../types";

/** JSON／wire／永続化で有限数だけを運ぶ数値 SpecialValue の rank。 */
export type SerializableNumericSpecialValueRank =
  | { kind: "value"; value: number }
  | { kind: "range"; lowerBound: number | null; upperBound: number | null }
  | { kind: "unranked" };

/** 数値 SpecialValue の表示対象単位。呼び出し側が domain の単位を固定する。 */
export type NumericSpecialValueUnit = "hPa" | "m/s" | "km/h";

function qualitativeSource(value: SpecialValue<number>): string | null {
  return [value.description, value.condition, value.raw]
    .find((source) => source != null && source !== "") ?? null;
}

/** 数値を丸めず、raw も変更せずに台風単位系の表示へ整形する。 */
export function formatNumericSpecialValue(
  value: SpecialValue<number>,
  unit: NumericSpecialValueUnit,
): string | null {
  switch (value.presence) {
    case "value":
      return value.value == null ? null : `${value.value}${unit}`;
    case "range":
      if (value.lowerBound != null && value.upperBound != null) {
        return `${value.lowerBound}～${value.upperBound}${unit}`;
      }
      if (value.lowerBound != null) return `${value.lowerBound}${unit}以上`;
      if (value.upperBound != null) return `${value.upperBound}${unit}以下`;
      return null;
    case "qualitative":
      return qualitativeSource(value);
    case "unknown":
      return "不明";
    case "missing":
      return null;
    case "empty":
      return "（空欄）";
  }
}

/** 数値 SpecialValue を JSON-safe な比較 rank へ写像する。 */
export function numericSpecialValueSerializableRank(
  value: SpecialValue<number>,
): SerializableNumericSpecialValueRank {
  if (value.presence === "value" && value.value != null && Number.isFinite(value.value)) {
    return { kind: "value", value: value.value };
  }
  if (value.presence === "range") {
    const lowerBound = value.lowerBound != null && Number.isFinite(value.lowerBound)
      ? value.lowerBound
      : null;
    const upperBound = value.upperBound != null && Number.isFinite(value.upperBound)
      ? value.upperBound
      : null;
    if (lowerBound != null || upperBound != null) {
      return { kind: "range", lowerBound, upperBound };
    }
  }
  return { kind: "unranked" };
}

/** serializable rank の比較値。range は旧 scalar 順序と同じ下限優先。 */
export function comparableNumericSpecialValueRank(
  rank: SerializableNumericSpecialValueRank,
): number | null {
  switch (rank.kind) {
    case "value":
      return rank.value;
    case "range":
      return rank.lowerBound ?? rank.upperBound;
    case "unranked":
      return null;
  }
}

/** in-process 専用の比較値。wire には serializable rank を渡す。 */
export function numericSpecialValueSortRank(value: SpecialValue<number>): number | null {
  return comparableNumericSpecialValueRank(numericSpecialValueSerializableRank(value));
}
