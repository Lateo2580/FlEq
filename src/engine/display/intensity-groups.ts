import type { JmaIntensity, JmaLgIntensity, SpecialValue } from "../../types";
import {
  evaluateIntensitySafetyRank,
  evaluateLgIntensitySafetyRank,
  specialValueDisplaySemantic,
} from "../../utils/intensity";
import {
  formatIntensitySpecialValue,
  formatLgIntensitySpecialValue,
} from "../presentation/level-helpers";
import type { PresentationAreaItem } from "../presentation/types";
import type {
  DisplayIntensityMapValueV1,
  DisplayIntensitySemanticV1,
  DisplayLgIntensitySemanticV1,
} from "./protocol";

export interface IntensityAreaGroup {
  intensity: string;
  rank: number;
  intensitySemantic?: DisplayIntensitySemanticV1;
  areas: string[];
  omittedAreaCount: number;
  expandedAreas?: string[];
  candidateTruncated?: boolean;
}

const QUAKE_EXPANDED_AREA_LIMIT = 128;

const CANONICAL_INTENSITY = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5-": "5-", "5弱": "5-", "5+": "5+", "5強": "5+",
  "6-": "6-", "6弱": "6-", "6+": "6+", "6強": "6+", "7": "7",
} as const satisfies Record<string, JmaIntensity>;

function canonicalIntensity(value: string | null): JmaIntensity | null {
  if (value == null) return null;
  const normalized = value.replace(/\s+/g, "");
  return CANONICAL_INTENSITY[normalized as keyof typeof CANONICAL_INTENSITY] ?? null;
}

function scalarIntensityValue(scalar: string): SpecialValue<JmaIntensity> {
  const normalized = scalar.replace(/\s+/g, "");
  const canonical = CANONICAL_INTENSITY[normalized as keyof typeof CANONICAL_INTENSITY];
  if (canonical != null) {
    return {
      raw: scalar,
      value: canonical,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  return {
    raw: scalar,
    value: null,
    condition: null,
    description: null,
    presence: scalar.trim() === "" ? "empty" : "unknown",
  };
}

function scalarLgIntensityValue(scalar: string): SpecialValue<JmaLgIntensity> {
  const normalized = scalar.normalize("NFKC").trim();
  const value = /^[0-4]$/.test(normalized) ? normalized as JmaLgIntensity : null;
  return {
    raw: scalar,
    value,
    condition: null,
    description: null,
    presence: value != null ? "value" : normalized === "" ? "empty" : "unknown",
  };
}

/** SpecialValue を frontend が再解析せず使える V1 additive semantic へ射影する。 */
export function projectIntensitySemantic(
  value: SpecialValue<JmaIntensity> | undefined,
  scalar?: string | null,
): DisplayIntensitySemanticV1 | undefined {
  const source = value ?? (scalar == null ? undefined : scalarIntensityValue(scalar));
  if (source == null) return undefined;
  const display = specialValueDisplaySemantic(source);
  const safety = evaluateIntensitySafetyRank(source);
  const safetyLowerRank = safety.kind === "known" ? safety.lower : null;
  const safetyUpperRank = safety.kind === "known" ? safety.upper : null;
  const safetyRank = safety.kind !== "known"
    ? null
    : source.presence === "range"
      ? safety.upper ?? safety.lower
      : safety.lower;
  const colorRank = display.color === "safetyUpperRank"
    ? safetyUpperRank ?? safetyLowerRank
    : display.color === "normalRank" || display.color === "safetyRank"
      ? safetyLowerRank
      : null;
  return {
    raw: source.raw,
    presence: source.presence,
    label: formatIntensitySpecialValue(source, scalar),
    condition: source.condition,
    description: source.description,
    lowerBound: source.lowerBound ?? null,
    upperBound: source.upperBound ?? null,
    rawLowerBound: source.rawLowerBound ?? null,
    rawUpperBound: source.rawUpperBound ?? null,
    badge: display.badge,
    color: display.color,
    render: display.render,
    safetyLowerRank,
    safetyUpperRank,
    safetyRank,
    colorRank,
  };
}

/** earthquake のカード・地図・履歴では未入電 qualifier を engine 側で一体表示する。 */
export function projectEarthquakeIntensitySemantic(
  value: SpecialValue<JmaIntensity> | undefined,
  scalar?: string | null,
): DisplayIntensitySemanticV1 | undefined {
  const semantic = projectIntensitySemantic(value, scalar);
  if (
    semantic?.presence === "qualitative"
    && semantic.lowerBound === "5-"
    && [semantic.raw, semantic.condition, semantic.description]
      .some((part) => part?.includes("未入電") === true)
  ) return { ...semantic, label: "5弱以上（未入電）" };
  return semantic;
}

/** EEW 長周期階級を震度とは独立した 0〜4 safety rank の V1 semantic へ投影する。 */
export function projectLgIntensitySemantic(
  value: SpecialValue<JmaLgIntensity> | undefined,
  scalar?: string | null,
): DisplayLgIntensitySemanticV1 | undefined {
  const source = value ?? (scalar == null ? undefined : scalarLgIntensityValue(scalar));
  if (source == null) return undefined;
  const display = specialValueDisplaySemantic(source);
  const safety = evaluateLgIntensitySafetyRank(source);
  const safetyLowerRank = safety.kind === "known" ? safety.lower : null;
  const safetyUpperRank = safety.kind === "known" ? safety.upper : null;
  const safetyRank = safety.kind !== "known"
    ? null
    : source.presence === "range"
      ? safety.upper ?? safety.lower
      : safety.lower;
  const colorRank = display.color === "safetyUpperRank"
    ? safetyUpperRank ?? safetyLowerRank
    : display.color === "normalRank" || display.color === "safetyRank"
      ? safetyLowerRank
      : null;
  return {
    raw: source.raw,
    presence: source.presence,
    label: formatLgIntensitySpecialValue(source, scalar),
    condition: source.condition,
    description: source.description,
    lowerBound: source.lowerBound ?? null,
    upperBound: source.upperBound ?? null,
    rawLowerBound: source.rawLowerBound ?? null,
    rawUpperBound: source.rawUpperBound ?? null,
    badge: display.badge,
    color: display.color,
    render: display.render,
    safetyLowerRank,
    safetyUpperRank,
    safetyRank,
    colorRank,
  };
}

/** Persistence readers use the projector itself as the semantic consistency oracle. */
export function isProjectedIntensitySemantic(
  semantic: DisplayIntensitySemanticV1,
): boolean {
  const value = semantic.presence === "value"
    ? canonicalIntensity(semantic.label)
    : null;
  if (semantic.presence === "value" && (value == null || semantic.raw == null)) return false;
  if (semantic.presence === "missing" && (
    semantic.raw != null
    || semantic.condition != null
    || semantic.description != null
    || semantic.lowerBound != null
    || semantic.upperBound != null
    || semantic.rawLowerBound != null
    || semantic.rawUpperBound != null
  )) return false;
  if (semantic.presence === "empty" && (
    semantic.raw == null
    || semantic.raw.trim() !== ""
    || semantic.lowerBound != null
    || semantic.upperBound != null
    || semantic.rawLowerBound != null
    || semantic.rawUpperBound != null
  )) return false;
  if (semantic.presence === "range" && (
    semantic.raw == null
    || semantic.lowerBound == null && semantic.upperBound == null
  )) return false;
  if (semantic.presence === "qualitative" && semantic.raw == null) return false;
  if (
    semantic.presence !== "range"
    && semantic.presence !== "qualitative"
    && (semantic.lowerBound != null || semantic.upperBound != null)
  ) return false;
  if (
    semantic.lowerBound != null && canonicalIntensity(semantic.lowerBound) == null
    || semantic.upperBound != null && canonicalIntensity(semantic.upperBound) == null
  ) return false;

  const source: SpecialValue<JmaIntensity> = {
    raw: semantic.raw,
    value,
    condition: semantic.condition,
    description: semantic.description,
    presence: semantic.presence,
    ...(semantic.lowerBound == null ? {} : { lowerBound: canonicalIntensity(semantic.lowerBound)! }),
    ...(semantic.upperBound == null ? {} : { upperBound: canonicalIntensity(semantic.upperBound)! }),
    ...(semantic.rawLowerBound == null && semantic.rawUpperBound == null
      ? {}
      : {
          rawLowerBound: semantic.rawLowerBound,
          rawUpperBound: semantic.rawUpperBound,
        }),
  };
  const expected = [
    projectIntensitySemantic(source, semantic.presence === "value" ? semantic.label : undefined),
    projectEarthquakeIntensitySemantic(source, semantic.presence === "value" ? semantic.label : undefined),
  ];
  return expected.some((candidate) => candidate != null && (
    [
      "raw", "presence", "label", "condition", "description", "lowerBound", "upperBound",
      "rawLowerBound", "rawUpperBound", "badge", "color", "render", "safetyLowerRank",
      "safetyUpperRank", "safetyRank", "colorRank",
    ] as const
  ).every((key) => Object.is(candidate[key], semantic[key])));
}

/** missing を除外し、特殊値の qualifier と色・badge semantic を保ったまま地域をまとめる。 */
export function groupIntensityAreas(items: PresentationAreaItem[]): IntensityAreaGroup[] {
  const groups = new Map<string, IntensityAreaGroup>();
  for (const item of items) {
    if (item.maxIntValue == null) {
      if (item.maxInt == null || item.maxInt.trim() === "") continue;
      const semantic = projectEarthquakeIntensitySemantic(undefined, item.maxInt);
      if (semantic == null || semantic.label == null) continue;
      const intensity = semantic.label;
      const rank = semantic.colorRank ?? -1;
      const key = intensity;
      const existing = groups.get(key);
      if (existing != null) {
        existing.areas.push(item.name);
        if (rank > existing.rank || existing.intensitySemantic == null && semantic.presence !== "value") {
          existing.rank = rank;
          if (semantic.presence === "value") delete existing.intensitySemantic;
          else existing.intensitySemantic = semantic;
        }
      } else groups.set(key, {
        intensity,
        rank,
        ...(semantic.presence === "value" ? {} : { intensitySemantic: semantic }),
        areas: [item.name],
        omittedAreaCount: 0,
      });
      continue;
    }
    const semantic = projectEarthquakeIntensitySemantic(item.maxIntValue, item.maxInt);
    if (semantic == null || !semantic.render || semantic.label == null) continue;
    // frontend V1 は group.intensity を keyed-each の key にするため、表示 label ごとに一意化する。
    // raw/description が異なる同義値は同じ group に束ね、代表 semantic は safety rank 最大を採る。
    const key = semantic.label;
    const existing = groups.get(key);
    if (existing != null) {
      existing.areas.push(item.name);
      const rank = semantic.colorRank ?? -1;
      if (rank > existing.rank || existing.intensitySemantic == null && semantic.presence !== "value") {
        existing.rank = rank;
        if (semantic.presence === "value") delete existing.intensitySemantic;
        else existing.intensitySemantic = semantic;
      }
      continue;
    }
    groups.set(key, {
      intensity: semantic.label,
      rank: semantic.colorRank ?? -1,
      ...(semantic.presence === "value" ? {} : { intensitySemantic: semantic }),
      areas: [item.name],
      omittedAreaCount: 0,
    });
  }
  const sorted = [...groups.values()].sort((a, b) =>
    b.rank - a.rank || a.intensity.localeCompare(b.intensity, "ja"));
  const candidates = sorted.map((group) => {
    const allCurrentAreas = [...new Set(group.areas)];
    return {
      group,
      currentAreas: allCurrentAreas,
      totalAreaCount: allCurrentAreas.length + group.omittedAreaCount,
    };
  });
  const currentAreaTotal = candidates.reduce((total, candidate) =>
    total + candidate.currentAreas.length, 0);
  // 二段配分: 通常は全 group の現行表示分を予約してから追加候補へ残余を回す。
  // 現行表示だけで上限を超える不変条件外入力は、発表順で現行表示を優先して安全弁を適用する。
  let remainingCurrent = QUAKE_EXPANDED_AREA_LIMIT;
  const reservedCurrentAreas = candidates.map(({ currentAreas }) => {
    if (currentAreaTotal <= QUAKE_EXPANDED_AREA_LIMIT) return currentAreas;
    const areas = currentAreas.slice(0, remainingCurrent);
    remainingCurrent -= areas.length;
    return areas;
  });
  let remaining = Math.max(
    0,
    QUAKE_EXPANDED_AREA_LIMIT - reservedCurrentAreas.reduce((total, areas) => total + areas.length, 0),
  );
  return candidates.map(({ group, totalAreaCount }, index) => {
    const currentAreas = reservedCurrentAreas[index]!;
    const additionalAreas: string[] = [];
    const additions = additionalAreas.slice(0, remaining);
    remaining -= additions.length;
    const expandedAreas = [...currentAreas, ...additions];
    return {
      ...group,
      expandedAreas,
      candidateTruncated: expandedAreas.length < totalAreaCount,
    };
  });
}

/** code keyed map values。missing と code 欠落は非描画、重複 code は高い color rank を採用する。 */
export function projectIntensityMapValues(
  items: Array<{
    code?: string | null;
    maxIntValue?: SpecialValue<JmaIntensity>;
    maxInt?: string;
  }>,
): DisplayIntensityMapValueV1[] {
  const byCode = new Map<string, DisplayIntensityMapValueV1>();
  for (const item of items) {
    if (item.code == null || item.code.trim() === "") continue;
    const semantic = projectEarthquakeIntensitySemantic(item.maxIntValue, item.maxInt);
    if (semantic == null || !semantic.render) continue;
    const candidate: DisplayIntensityMapValueV1 = {
      code: item.code,
      rank: semantic.colorRank ?? -1,
      ...(semantic.presence === "value" ? {} : { intensitySemantic: semantic }),
    };
    const existing = byCode.get(item.code);
    if (existing == null || candidate.rank > existing.rank) byCode.set(item.code, candidate);
  }
  return [...byCode.values()];
}
