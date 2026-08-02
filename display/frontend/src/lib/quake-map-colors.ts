import type {
  DisplayIntensityBadgeV1,
  DisplayIntensitySemanticV1,
} from "./protocol";

export type QuakeMapRankClass =
  | "quake-map-unobserved"
  | "quake-map-unknown"
  | "quake-map-neutral"
  | `quake-map-rank-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

const RANK_CLASSES = [
  "quake-map-rank-1",
  "quake-map-rank-2",
  "quake-map-rank-3",
  "quake-map-rank-4",
  "quake-map-rank-5",
  "quake-map-rank-6",
  "quake-map-rank-7",
  "quake-map-rank-8",
  "quake-map-rank-9",
] as const;

/** null/undefined は未観測、範囲外の値は受信済みだが未知震度として区別する。 */
export function quakeMapRankClass(rank: number | null | undefined): QuakeMapRankClass {
  if (rank == null) return "quake-map-unobserved";
  if (!Number.isInteger(rank) || rank < 1 || rank > 9) return "quake-map-unknown";
  return RANK_CLASSES[rank - 1]!;
}

/** §6.4 の既存震度 token 対応。 */
export function quakeMapRankToken(rank: number): string | null {
  if (!Number.isInteger(rank) || rank < 1 || rank > 9) return null;
  if (rank === 8) return "var(--int-8-bg)";
  if (rank === 9) return "var(--int-9-bg)";
  return `var(--int-${rank})`;
}

export interface IntensityVisualV1 {
  render: boolean;
  label: string | null;
  badge: DisplayIntensityBadgeV1;
  colorRank: number | null;
  colorClass: QuakeMapRankClass;
  tooltip: string | null;
  ariaLabel: string | null;
}

export interface QuakeMapPoint {
  x: number;
  y: number;
}

/** 1080p main-stack の地図実幅は viewBox 幅の 0.6 倍以上。24 user unit で 14.4px を確保する。 */
export const QUAKE_MAP_BADGE_MIN_1080P_SCALE = 0.6;
export const QUAKE_MAP_BADGE_FONT_USER_UNITS = 24;
export const QUAKE_MAP_BADGE_RADIUS_USER_UNITS = 17;

const BADGE_MEANING: Readonly<Record<Exclude<DisplayIntensityBadgeV1, null>, string>> = {
  "≥": "以上（下限値）",
  "↔": "範囲",
  "?": "不明",
  "∅": "空欄",
};

const LEGACY_INTENSITY_BY_RANK: Readonly<Record<number, string>> = {
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5弱",
  6: "5強",
  7: "6弱",
  8: "6強",
  9: "7",
};

export function intensityBadgeMeaning(badge: DisplayIntensityBadgeV1): string | null {
  return badge == null ? null : BADGE_MEANING[badge];
}

function readableIntensity(value: string | null | undefined): string | null {
  return value ?? null;
}

function semanticColorClass(semantic: DisplayIntensitySemanticV1): QuakeMapRankClass {
  if (!semantic.render || semantic.presence === "missing" || semantic.color === "notRendered") {
    return "quake-map-unobserved";
  }
  if (semantic.color === "unknown") return "quake-map-unknown";
  if (semantic.color === "neutral") return "quake-map-neutral";
  return quakeMapRankClass(semantic.colorRank);
}

/** semantic がある場合は、その null も権威として扱う。legacy 値は旧 wire だけの fallback。 */
export function intensityVisual(
  semantic: DisplayIntensitySemanticV1 | undefined,
  legacyLabel: string | null | undefined,
  legacyRank: number | null | undefined,
  subject = "震度",
): IntensityVisualV1 {
  if (semantic == null) {
    const label = readableIntensity(legacyLabel)
      ?? (legacyRank == null ? null : LEGACY_INTENSITY_BY_RANK[legacyRank] ?? "不明");
    return {
      render: legacyRank != null || label != null,
      label,
      badge: null,
      colorRank: legacyRank ?? null,
      colorClass: quakeMapRankClass(legacyRank),
      tooltip: label == null ? null : `${subject}${label}`,
      ariaLabel: label == null ? null : `${subject}${label}`,
    };
  }

  if (!semantic.render || semantic.presence === "missing") {
    return {
      render: false,
      label: null,
      badge: null,
      colorRank: null,
      colorClass: "quake-map-unobserved",
      tooltip: null,
      ariaLabel: null,
    };
  }

  const label = semantic.label ?? (
    semantic.presence === "empty" ? "空欄" : semantic.presence === "unknown" ? "不明" : null
  );
  const meaning = intensityBadgeMeaning(semantic.badge);
  const badgeDescription = semantic.badge == null || meaning == null
    ? null
    : `記号 ${semantic.badge}: ${meaning}`;
  const qualifiers = [...new Set([semantic.condition, semantic.description])]
    .filter((qualifier): qualifier is string => qualifier != null && qualifier !== label);
  const qualifierParts = qualifiers.length <= 1
    ? qualifiers.map((qualifier) => `理由: ${qualifier}`)
    : qualifiers.map((qualifier, index) => `${index === 0 ? "条件" : "説明"}: ${qualifier}`);
  const parts = [
    label == null ? subject : `${subject}${readableIntensity(label)}`,
    badgeDescription,
    ...qualifierParts,
  ].filter((part): part is string => part != null);
  const description = parts.join("、");
  return {
    render: true,
    label: readableIntensity(label),
    badge: semantic.badge,
    colorRank: semantic.colorRank,
    colorClass: semanticColorClass(semantic),
    tooltip: description,
    ariaLabel: description,
  };
}

function quakeMapPathPolygons(path: string): QuakeMapPoint[][] {
  const polygons: QuakeMapPoint[][] = [];
  let current: QuakeMapPoint[] = [];
  for (const match of path.matchAll(/([ML])(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
    if (match[1] === "M" && current.length > 0) {
      polygons.push(current);
      current = [];
    }
    current.push({ x: Number(match[2]), y: Number(match[3]) });
  }
  if (current.length > 0) polygons.push(current);
  return polygons.filter((polygon) => polygon.length >= 3);
}

function cross(a: QuakeMapPoint, b: QuakeMapPoint, point: QuakeMapPoint): number {
  return (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y);
}

function onSegment(a: QuakeMapPoint, b: QuakeMapPoint, point: QuakeMapPoint): boolean {
  const epsilon = 1e-7;
  return Math.abs(cross(a, b, point)) <= epsilon
    && point.x >= Math.min(a.x, b.x) - epsilon
    && point.x <= Math.max(a.x, b.x) + epsilon
    && point.y >= Math.min(a.y, b.y) - epsilon
    && point.y <= Math.max(a.y, b.y) + epsilon;
}

/** SVG 既定の nonzero fill rule と同じ winding 判定。境界上も内部として扱う。 */
export function quakeMapPathContainsPoint(path: string, point: QuakeMapPoint): boolean {
  let winding = 0;
  for (const polygon of quakeMapPathPolygons(path)) {
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index]!;
      const b = polygon[(index + 1) % polygon.length]!;
      if (onSegment(a, b, point)) return true;
      if (a.y <= point.y) {
        if (b.y > point.y && cross(a, b, point) > 0) winding += 1;
      } else if (b.y <= point.y && cross(a, b, point) < 0) {
        winding -= 1;
      }
    }
  }
  return winding !== 0;
}

interface ScanlineIntersection {
  x: number;
  delta: number;
}

function widestFilledSpan(polygons: QuakeMapPoint[][], y: number): { point: QuakeMapPoint; width: number } | null {
  const intersections: ScanlineIntersection[] = [];
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index]!;
      const b = polygon[(index + 1) % polygon.length]!;
      if (a.y <= y && b.y > y) {
        intersections.push({ x: a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y), delta: 1 });
      } else if (b.y <= y && a.y > y) {
        intersections.push({ x: b.x + ((y - b.y) * (a.x - b.x)) / (a.y - b.y), delta: -1 });
      }
    }
  }
  intersections.sort((a, b) => a.x - b.x);
  let winding = 0;
  let best: { point: QuakeMapPoint; width: number } | null = null;
  for (let index = 0; index < intersections.length;) {
    const x = intersections[index]!.x;
    let delta = 0;
    while (index < intersections.length && Math.abs(intersections[index]!.x - x) < 1e-7) {
      delta += intersections[index]!.delta;
      index += 1;
    }
    winding += delta;
    const nextX = intersections[index]?.x;
    if (winding !== 0 && nextX != null && nextX > x) {
      const candidate = { point: { x: (x + nextX) / 2, y }, width: nextX - x };
      if (best == null || candidate.width > best.width) best = candidate;
    }
  }
  return best;
}

/**
 * 各 sub-path の高さを scanline sampling し、nonzero fill 内の最長 chord 中点を選ぶ。
 * bbox 中心と違い、返した点は必ず当該地域 path の内部にある。
 */
export function quakeMapPathCenter(path: string): QuakeMapPoint | null {
  const polygons = quakeMapPathPolygons(path);
  if (polygons.length === 0) return null;
  const candidateYs = new Set<number>();
  for (const polygon of polygons) {
    const ys = polygon.map(({ y }) => y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (maxY <= minY) continue;
    for (let step = 0; step < 64; step += 1) {
      candidateYs.add(minY + ((step + 0.5) / 64) * (maxY - minY));
    }
  }
  let best: { point: QuakeMapPoint; width: number } | null = null;
  for (const y of candidateYs) {
    const candidate = widestFilledSpan(polygons, y);
    if (candidate != null && (best == null || candidate.width > best.width)) best = candidate;
  }
  return best?.point ?? null;
}
