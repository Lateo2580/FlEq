import type {
  DisplayPlumeHeightRankV1,
  DisplayPlumeHeightSemanticV1,
} from "./protocol";

export interface PlumeHeightVisual {
  render: boolean;
  label: string;
  badge: string | null;
  tooltip: string | null;
  ariaLabel: string | null;
  numericValue: number | null;
  unit: string;
}

const BADGE_MEANING: Record<string, string> = {
  "≥": "以上、下限値",
  "↔": "範囲",
  "?": "不明または定性値",
  "∅": "空欄",
};

function matchesKnownObstruction(source: string | null): boolean {
  const normalized = source?.normalize("NFKC").trim();
  if (normalized == null) return false;
  return ["雲中", "観測できず", "不明", "不詳"].some((term) => {
    if (normalized === term) return true;
    if (!normalized.endsWith(term)) return false;
    return !/[非未不無]$/.test(normalized.slice(0, -term.length));
  });
}

function usesLegacyDisplay(semantic: DisplayPlumeHeightSemanticV1): boolean {
  if (
    matchesKnownObstruction(semantic.condition)
    || matchesKnownObstruction(semantic.raw)
  ) return false;
  if (
    (semantic.presence === "range" || semantic.presence === "qualitative")
    && (semantic.lowerBound != null || semantic.upperBound != null)
  ) return false;
  return semantic.presence !== "empty";
}

/** wire semantic を再解析せず VolcanoCard 用の表示へ変換する。 */
export function plumeHeightVisual(
  semantic: DisplayPlumeHeightSemanticV1 | undefined,
  legacyHeightM: number | null,
  legacyUnknown: boolean,
): PlumeHeightVisual {
  if (semantic == null) {
    const label = legacyHeightM == null ? "不明" : `${legacyHeightM}m`;
    return {
      render: legacyHeightM != null || legacyUnknown,
      label,
      badge: null,
      tooltip: null,
      ariaLabel: null,
      numericValue: legacyHeightM,
      unit: "m",
    };
  }
  if (usesLegacyDisplay(semantic)) {
    const label = legacyHeightM == null
      ? semantic.presence === "missing" ? "—" : semantic.label ?? "不明"
      : `${legacyHeightM}m`;
    return {
      render: legacyHeightM != null,
      label,
      badge: null,
      tooltip: null,
      ariaLabel: null,
      numericValue: legacyHeightM,
      unit: semantic.unit,
    };
  }
  const label = semantic.presence === "missing"
    ? "—"
    : semantic.presence === "empty"
      ? "空欄"
      : semantic.label ?? "不明";
  const details = [
    semantic.badge == null ? null : BADGE_MEANING[semantic.badge] ?? semantic.badge,
    semantic.condition == null || semantic.condition === "" ? null : `条件: ${semantic.condition}`,
    semantic.description == null || semantic.description === "" || semantic.description === label
      ? null
      : `説明: ${semantic.description}`,
  ].filter((part): part is string => part != null);
  const meaning = details.length === 0
    ? `噴煙高度: ${label}`
    : `噴煙高度: ${label}（${details.join("、")}）`;
  return {
    render: semantic.render,
    label,
    badge: semantic.badge,
    tooltip: meaning,
    ariaLabel: meaning,
    numericValue: null,
    unit: semantic.unit,
  };
}

/** engine の plumeHeightSortRank() と同じ wire rank 比較値。 */
export function comparablePlumeHeightRank(rank: DisplayPlumeHeightRankV1): number | null {
  switch (rank.kind) {
    case "value": return rank.value;
    case "range": return rank.lowerBound ?? rank.upperBound;
    case "unranked": return null;
  }
}
