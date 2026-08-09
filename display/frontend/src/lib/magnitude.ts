import type {
  DisplayDepthSemanticV1,
  DisplayMagnitudeRankV1,
  DisplayMagnitudeSemanticV1,
  DisplayNumericSpecialValueSemanticV1,
} from "./protocol";

export function isNumericMagnitude(value: string | null | undefined): boolean {
  return value != null && value.trim() !== "" && Number.isFinite(Number(value));
}

export function formatMagnitudeLabel(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "M不明";
  if (value.trim().toLowerCase() === "nan") return "M不明";
  return isNumericMagnitude(value) ? `M${value}` : value;
}

export interface NumericSpecialValueVisual {
  render: boolean;
  label: string;
  badge: string | null;
  tooltip: string | null;
  ariaLabel: string;
  numericValue: number | null;
}

const BADGE_MEANING: Record<string, string> = {
  "≥": "以上、下限値",
  "↔": "範囲",
  "?": "不明または定性値",
  "∅": "空欄",
};

export function numericSpecialValueVisual(
  semantic: DisplayNumericSpecialValueSemanticV1 | undefined,
  legacyLabel: string | null | undefined,
  subject: "マグニチュード" | "深さ",
  surface: "card" | "map" = "card",
): NumericSpecialValueVisual {
  if (semantic == null) {
    const label = subject === "マグニチュード"
      ? formatMagnitudeLabel(legacyLabel)
      : legacyLabel == null || legacyLabel === "" ? "—" : legacyLabel;
    const depthNumber = subject === "深さ" && legacyLabel != null
      ? /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))km$/.exec(legacyLabel.trim())
      : null;
    return {
      render: true,
      label,
      badge: null,
      tooltip: null,
      ariaLabel: `${subject}: ${label}`,
      numericValue: isNumericMagnitude(legacyLabel)
        ? Number(legacyLabel)
        : depthNumber == null ? null : Number(depthNumber[1]),
    };
  }
  const missing = semantic.presence === "missing";
  const label = missing
    ? "—"
    : semantic.presence === "empty"
      ? "空欄"
      : semantic.label?.trim() || (semantic.presence === "unknown" ? "不明" : "不明");
  const badgeMeaning = semantic.badge == null ? null : BADGE_MEANING[semantic.badge] ?? semantic.badge;
  const details = [
    badgeMeaning,
    semantic.condition?.trim() ? `条件: ${semantic.condition.trim()}` : null,
    semantic.description?.trim() && semantic.description.trim() !== label
      ? `説明: ${semantic.description.trim()}`
      : null,
  ].filter((part): part is string => part != null);
  const meaning = details.length === 0 ? `${subject}: ${label}` : `${subject}: ${label}（${details.join("、")}）`;
  return {
    render: surface === "card" || !missing,
    label,
    badge: missing ? null : semantic.badge,
    tooltip: meaning,
    ariaLabel: meaning,
    numericValue: semantic.presence === "value" ? semantic.value : null,
  };
}

export function magnitudeVisual(
  semantic: DisplayMagnitudeSemanticV1 | undefined,
  legacy: string | null | undefined,
  surface: "card" | "map" = "card",
): NumericSpecialValueVisual {
  return numericSpecialValueVisual(semantic, legacy, "マグニチュード", surface);
}

export function depthVisual(
  semantic: DisplayDepthSemanticV1 | undefined,
  legacy: string | null | undefined,
  surface: "card" | "map" = "card",
): NumericSpecialValueVisual {
  return numericSpecialValueVisual(semantic, legacy, "深さ", surface);
}

/** wire rank の比較値。semantic がある場合は raw scalar を再解析しない。 */
export function comparableMagnitudeRank(rank: DisplayMagnitudeRankV1): number {
  switch (rank.kind) {
    case "giant": return Number.POSITIVE_INFINITY;
    case "value": return rank.value;
    // 旧 scalar の parseFloat は range の先頭（下限）を比較値にしていた。
    // Phase 5A で許可された順位変更は giant の最上位化だけなので、その順序を維持する。
    case "range": return rank.lowerBound ?? rank.upperBound ?? Number.NEGATIVE_INFINITY;
    case "unranked": return Number.NEGATIVE_INFINITY;
  }
}
