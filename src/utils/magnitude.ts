import type { ParsedEarthquakeHypocenter, SpecialValue } from "../types";

function normalizeDescription(description: string): string {
  return description
    .normalize("NFKC")
    .trim()
    .replace(/^M(\d+(?:\.\d+)?)(?=\S)/, "M$1 ");
}

export function isNumericMagnitude(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function formattedMagnitudeNumber(value: number): string {
  return value.toFixed(1);
}

export function isGiantMagnitudeText(value: string | null): boolean {
  const normalized = value?.normalize("NFKC").trim();
  return normalized === "M8を超える巨大地震" || normalized === "巨大地震";
}

function normalizedDepthDescription(description: string | null): string | null {
  if (description == null) return null;
  const normalized = description.normalize("NFKC").trim();
  const match = normalized.match(/深さ\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:km|キロメートル)?\s*(以上|超|以下|未満)\s*$/);
  if (match == null) return null;
  return `${match[1]}km${match[2]}`;
}

function firstQualitativeSource(value: SpecialValue<number>): string | null {
  return [value.raw, value.description, value.condition]
    .find((source) => source != null && source !== "") ?? null;
}

function isShallowDepthText(value: string | null): boolean {
  const normalized = value?.normalize("NFKC").trim();
  return normalized === "ごく浅い"
    || (normalized != null && /深さ\s*ごく浅い$/.test(normalized));
}

/** Magnitude の canonical 値を表示ラベルへ変換する。missing は null。 */
export function formatMagnitudeSpecialValue(value: SpecialValue<number>): string | null {
  switch (value.presence) {
    case "value":
      return value.value == null ? null : `M${formattedMagnitudeNumber(value.value)}`;
    case "range":
      if (value.lowerBound != null && value.upperBound != null) {
        return `M${formattedMagnitudeNumber(value.lowerBound)}～${formattedMagnitudeNumber(value.upperBound)}`;
      }
      if (value.lowerBound != null) {
        return `M${formattedMagnitudeNumber(value.lowerBound)}以上`;
      }
      if (value.upperBound != null) {
        return `M${formattedMagnitudeNumber(value.upperBound)}以下`;
      }
      return null;
    case "qualitative": {
      const source = [value.description, value.condition, value.raw]
        .find(isGiantMagnitudeText);
      return source == null
        ? firstQualitativeSource(value)
        : normalizeDescription(source);
    }
    case "unknown":
      return "M不明";
    case "missing":
      return null;
    case "empty":
      return "（空欄）";
  }
}

/** Depth の canonical 値を表示ラベルへ変換する。missing は null。 */
export function formatDepthSpecialValue(value: SpecialValue<number>): string | null {
  switch (value.presence) {
    case "value":
      return value.value == null ? null : `${value.value}km`;
    case "range":
      if (value.lowerBound != null && value.upperBound != null) {
        return `${value.lowerBound}～${value.upperBound}km`;
      }
      return normalizedDepthDescription(value.description)
        ?? (value.lowerBound != null
          ? `${value.lowerBound}km以上`
          : value.upperBound != null
            ? `${value.upperBound}km以下`
            : null);
    case "qualitative": {
      const sources = [value.raw, value.description, value.condition];
      const normalizedRaw = value.raw?.normalize("NFKC").trim() ?? "";
      const rawNumber = normalizedRaw === "" ? null : Number(normalizedRaw);
      return rawNumber === 0 || sources.some(isShallowDepthText)
        ? "ごく浅い"
        : firstQualitativeSource(value);
    }
    case "unknown":
      return "不明";
    case "missing":
      return null;
    case "empty":
      return "（空欄）";
  }
}

/** 旧 ParsedEarthquakeHypocenter.magnitude 用の互換 adapter。 */
export function magnitudeScalar(value: SpecialValue<number>): string {
  const raw = value.raw ?? "";
  const parsed = parseFloat(raw);
  return raw !== "" && !isNaN(parsed) ? parsed.toFixed(1) : "";
}

/** 旧 ParsedEarthquakeHypocenter.depth 用の互換 adapter。 */
export function depthScalar(value: SpecialValue<number>): string {
  const raw = value.raw ?? "";
  const parsed = Math.abs(parseFloat(raw));
  if (raw === "" || !Number.isFinite(parsed)) return "";
  const depthKm = parsed >= 1000 ? parsed / 1000 : parsed;
  return depthKm > 0 ? `${depthKm}km` : "ごく浅い";
}

/** raw 等を除いた SpecialValue の canonical equality。 */
export function specialValueCanonicalEquals<T>(
  left: SpecialValue<T> | undefined,
  right: SpecialValue<T> | undefined,
): boolean {
  if (left == null || right == null) return left === right;
  return left.presence === right.presence
    && left.value === right.value
    && (left.lowerBound ?? null) === (right.lowerBound ?? null)
    && (left.upperBound ?? null) === (right.upperBound ?? null);
}

export type SerializableMagnitudeRank =
  | { kind: "giant" }
  | { kind: "value"; value: number }
  | { kind: "range"; lowerBound: number | null; upperBound: number | null }
  | { kind: "unranked" };

/** JSON／wire／永続化境界で意味を失わない Magnitude rank。 */
export function magnitudeSerializableRank(
  value: SpecialValue<number>,
): SerializableMagnitudeRank {
  if (
    value.presence === "qualitative"
    && [value.condition, value.description, value.raw].some(isGiantMagnitudeText)
  ) return { kind: "giant" };
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
    if (lowerBound == null && upperBound == null) return { kind: "unranked" };
    return {
      kind: "range",
      lowerBound,
      upperBound,
    };
  }
  return { kind: "unranked" };
}

/**
 * 巨大は通常値・範囲より上位に置く in-process 比較専用 rank。
 * 巨大には Infinity を返すため、JSON／wire／永続化には
 * magnitudeSerializableRank() を使用する。
 */
export function magnitudeSortRank(value: SpecialValue<number>): number | null {
  const rank = magnitudeSerializableRank(value);
  switch (rank.kind) {
    case "giant":
      return Number.POSITIVE_INFINITY;
    case "value":
      return rank.value;
    case "range":
      return rank.upperBound ?? rank.lowerBound;
    case "unranked":
      return null;
  }
}

/** CLI・通知など、接頭辞を含むマグニチュード表示を返す。 */
export function formatMagnitudeLabel(
  earthquake: Pick<ParsedEarthquakeHypocenter, "magnitude" | "magnitudeInfo">,
): string {
  const description = earthquake.magnitudeInfo?.description?.trim();
  if (description) return normalizeDescription(description);
  if (isNumericMagnitude(earthquake.magnitude)) return `M${earthquake.magnitude}`;
  return "M不明";
}

/**
 * Presentation の既存 magnitude field 用。
 * 数値は従来どおり数値文字列、不明値は接頭辞込みの安全な表示文字列にする。
 */
export function magnitudeForPresentation(
  earthquake: Pick<ParsedEarthquakeHypocenter, "magnitude" | "magnitudeInfo"> | undefined,
): string | null {
  if (earthquake == null) return null;
  if (isNumericMagnitude(earthquake.magnitude)) return earthquake.magnitude;
  return formatMagnitudeLabel(earthquake);
}

/** Presentation magnitude が既に表示文字列なら維持し、数値だけ M を補う。 */
export function formatPresentationMagnitude(magnitude: string): string {
  if (magnitude.trim().toLowerCase() === "nan") return "M不明";
  return isNumericMagnitude(magnitude) ? `M${magnitude}` : magnitude;
}
