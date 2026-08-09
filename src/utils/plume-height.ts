import type { PlumeHeightSemantic, SpecialValue } from "../types";
import { specialValueCanonicalEquals } from "./magnitude";

function isObstructionTerm(source: string | null): boolean {
  const normalized = source?.normalize("NFKC").trim();
  if (normalized == null) return false;
  return ["雲中", "観測できず", "不明", "不詳"].some((term) => {
    if (normalized === term) return true;
    if (!normalized.endsWith(term)) return false;
    return !/[非未不無]$/.test(normalized.slice(0, -term.length));
  });
}

function obstructionText(value: SpecialValue<number>): string | null {
  // 観測阻害を決めた condition は本文より優先する。本文特殊語は raw を残す。
  if (isObstructionTerm(value.condition)) return value.condition;
  if (isObstructionTerm(value.raw)) return value.raw;
  return null;
}

function qualitativeText(value: SpecialValue<number>): string | null {
  const obstruction = obstructionText(value);
  if (obstruction != null) return obstruction;
  return value.raw ?? value.description ?? value.condition;
}

/**
 * spec 既知特殊語による分類だけを semantic 表示へ切り替える。
 * missing・機械表現の unknown・未対応 qualitative・exact は旧 scalar 表示を維持する。
 */
export function plumeHeightUsesLegacyDisplay(height: PlumeHeightSemantic): boolean {
  const { value } = height;
  if (obstructionText(value) != null) return false;
  if (
    (value.presence === "range" || value.presence === "qualitative")
    && (value.lowerBound != null || value.upperBound != null)
  ) return false;
  return value.presence !== "empty";
}

/** 噴煙高度 canonical の共通表示。単位は原文の基準どおり変換しない。 */
export function formatPlumeHeightSpecialValue(
  height: PlumeHeightSemantic,
  surface: "detail" | "notification" | "ticker" | "card" = "detail",
): string | null {
  const { unit, value } = height;
  switch (value.presence) {
    case "value":
      return value.value == null ? null : `${value.value}${unit}`;
    case "range":
      if (value.lowerBound != null && value.upperBound != null) {
        return `${value.lowerBound}～${value.upperBound}${unit}`;
      }
      if (value.lowerBound != null) return `${value.lowerBound}${unit}以上`;
      return value.upperBound == null ? null : `${value.upperBound}${unit}以下`;
    case "qualitative":
      return qualitativeText(value) ?? "不明";
    case "unknown":
      // NaN は機械表現であり表示語ではない。既知の分類語がなければ不明へ畳む。
      return obstructionText(value) ?? "不明";
    case "missing":
      return null;
    case "empty":
      if (surface === "notification" || surface === "ticker") return null;
      return surface === "card" ? "空欄" : "（空欄）";
  }
}

/**
 * 噴煙高度の警報閾値評価。上限だけの range や unranked 状態を発火根拠にしない。
 * sort 用の代表値とは安全性の意味が異なるため plumeHeightSortRank() は使わない。
 */
export function plumeHeightReachesThreshold(
  height: PlumeHeightSemantic | undefined,
  threshold: number,
): boolean {
  if (height?.reference !== "aboveCrater" || height.unit !== "m") return false;
  const { value } = height;
  if (value.presence === "value") {
    return value.value != null
      && Number.isFinite(value.value)
      && value.value >= threshold;
  }
  if (value.presence !== "range" && value.presence !== "qualitative") return false;
  return value.lowerBound != null
    && Number.isFinite(value.lowerBound)
    && value.lowerBound >= threshold;
}

/** canonical を主判定にし、旧 parseInt scalar の発火実績を安全床として維持する。 */
export function plumeHeightReachesThresholdWithLegacyFloor(
  height: PlumeHeightSemantic | undefined,
  legacyHeight: number | null,
  threshold: number,
): boolean {
  return plumeHeightReachesThreshold(height, threshold)
    || legacyHeight != null && legacyHeight >= threshold;
}

/** raw/diagnostics を無視する canonical equality。基準と単位の一致も必須。 */
export function plumeHeightCanonicalEquals(
  left: PlumeHeightSemantic | undefined,
  right: PlumeHeightSemantic | undefined,
): boolean {
  if (left == null || right == null) return left === right;
  return left.reference === right.reference
    && left.unit === right.unit
    && specialValueCanonicalEquals(left.value, right.value);
}

export type SerializablePlumeHeightRank =
  | { kind: "value"; reference: PlumeHeightSemantic["reference"]; unit: PlumeHeightSemantic["unit"]; value: number }
  | { kind: "range"; reference: PlumeHeightSemantic["reference"]; unit: PlumeHeightSemantic["unit"]; lowerBound: number | null; upperBound: number | null }
  | { kind: "unranked"; reference: PlumeHeightSemantic["reference"]; unit: PlumeHeightSemantic["unit"] };

/** JSON-safe rank。range は旧 scalar 順序と同じく lower、なければ upper を代表にする。 */
export function plumeHeightSerializableRank(
  height: PlumeHeightSemantic,
): SerializablePlumeHeightRank {
  const { reference, unit, value } = height;
  if (value.presence === "value" && value.value != null && Number.isFinite(value.value)) {
    return { kind: "value", reference, unit, value: value.value };
  }
  if (value.presence === "range") {
    const lowerBound = value.lowerBound != null && Number.isFinite(value.lowerBound)
      ? value.lowerBound
      : null;
    const upperBound = value.upperBound != null && Number.isFinite(value.upperBound)
      ? value.upperBound
      : null;
    if (lowerBound != null || upperBound != null) {
      return { kind: "range", reference, unit, lowerBound, upperBound };
    }
  }
  return { kind: "unranked", reference, unit };
}

/** in-process 比較専用。Infinity を使わないためそのまま JSON-safe rank と対応する。 */
export function plumeHeightSortRank(height: PlumeHeightSemantic): number | null {
  const rank = plumeHeightSerializableRank(height);
  return rank.kind === "value"
    ? rank.value
    : rank.kind === "range"
      ? rank.lowerBound ?? rank.upperBound
      : null;
}

/** 基準または単位が異なる高さは比較しない。 */
export function comparePlumeHeight(
  left: PlumeHeightSemantic,
  right: PlumeHeightSemantic,
): number | null {
  if (left.reference !== right.reference || left.unit !== right.unit) return null;
  const leftRank = plumeHeightSortRank(left);
  const rightRank = plumeHeightSortRank(right);
  if (leftRank == null || rightRank == null) return null;
  return leftRank === rightRank ? 0 : leftRank < rightRank ? -1 : 1;
}

/** 旧 parser の `parseInt(..., 10)` と unknown 判定を bit 一致で再現する adapter。 */
export function plumeHeightLegacyAdapter(
  raw: string,
  condition: string | null,
): { plumeHeight: number | null; plumeHeightUnknown: boolean } {
  if (condition === "不明" || raw === "不明") {
    return { plumeHeight: null, plumeHeightUnknown: true };
  }
  const parsed = parseInt(raw, 10);
  return {
    plumeHeight: Number.isNaN(parsed) ? null : parsed,
    plumeHeightUnknown: false,
  };
}
