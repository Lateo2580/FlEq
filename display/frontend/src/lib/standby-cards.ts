import type { ActiveStandbyCardV1, DisplayFloodRiverV1, DisplayFloodStationV1 } from "./protocol";

export const FLOOD_TREND_ARROW: Record<NonNullable<DisplayFloodStationV1["trend"]>, string> = {
  rising: "↑",
  falling: "↓",
  steady: "→",
};

export interface StandbyPartitions {
  cornerRight: ActiveStandbyCardV1[];
  clockTopWide: ActiveStandbyCardV1[];
  weatherRider: ActiveStandbyCardV1[];
  quakeRider: ActiveStandbyCardV1[];
  clockBelow: ActiveStandbyCardV1[];
  unknown: ActiveStandbyCardV1[];
}

export function partitionStandbyItems(items: ActiveStandbyCardV1[]): StandbyPartitions {
  const result: StandbyPartitions = { cornerRight: [], clockTopWide: [], weatherRider: [], quakeRider: [], clockBelow: [], unknown: [] };
  for (const item of items) {
    const kind = (item as { kind?: string }).kind;
    if (kind !== "heat" && kind !== "typhoon" && kind !== "volcano" && kind !== "flood"
      && kind !== "tornado" && kind !== "longPeriod" && kind !== "nankaiTrough") {
      result.unknown.push(item);
      continue;
    }
    switch ((item as { surface?: string }).surface) {
      case "corner-right": result.cornerRight.push(item); break;
      case "clock-top-wide": result.clockTopWide.push(item); break;
      case "weather-rider": result.weatherRider.push(item); break;
      case "quake-rider": result.quakeRider.push(item); break;
      case "clock-below": result.clockBelow.push(item); break;
      default: result.unknown.push(item);
    }
  }
  return result;
}

export function rightStackBudgetPx(
  containerHeightPx: number,
  weatherHeightPx: number,
  floodCornerOffsetPx: number,
  gapPx: number,
): number {
  const verticalInsetPx = 48;
  const weatherGapPx = weatherHeightPx > 0 ? gapPx : 0;
  return Math.max(0, containerHeightPx - verticalInsetPx - floodCornerOffsetPx - weatherHeightPx - weatherGapPx);
}

export function selectRightStack(
  cornerRight: ActiveStandbyCardV1[],
  budgetPx: number,
  estimateHeightPx: (item: ActiveStandbyCardV1) => number,
): { visible: ActiveStandbyCardV1[]; overflow: ActiveStandbyCardV1[] } {
  let used = 0;
  const visible: ActiveStandbyCardV1[] = [];
  const overflow: ActiveStandbyCardV1[] = [];
  for (const item of cornerRight) {
    const height = estimateHeightPx(item);
    if (used + height <= budgetPx) {
      visible.push(item);
      used += height;
    } else {
      overflow.push(item);
    }
  }
  return { visible, overflow };
}

export function selectRightStackWithSummary(
  cornerRight: ActiveStandbyCardV1[],
  budgetPx: number,
  estimateHeightPx: (item: ActiveStandbyCardV1) => number,
  summaryHeightPx: number,
  forceSummary: boolean,
  gapPx: number,
): { visible: ActiveStandbyCardV1[]; overflow: ActiveStandbyCardV1[]; usedPx: number; summaryReservedPx: number } {
  const severityRank: Record<ActiveStandbyCardV1["severity"], number> = {
    info: 1,
    normal: 1,
    warning: 2,
    critical: 3,
  };
  const order = cornerRight
    .map((item, index) => ({ item, index }))
    .sort((left, right) => severityRank[right.item.severity] - severityRank[left.item.severity] || left.index - right.index);

  const selectWithGaps = (availablePx: number): { visible: ActiveStandbyCardV1[]; overflow: ActiveStandbyCardV1[]; usedPx: number } => {
    let usedPx = 0;
    const picked = new Set<number>();
    for (const { item, index } of order) {
      const requiredPx = estimateHeightPx(item) + (picked.size > 0 ? gapPx : 0);
      if (usedPx + requiredPx <= availablePx) {
        picked.add(index);
        usedPx += requiredPx;
      }
    }
    const visible = cornerRight.filter((_, index) => picked.has(index));
    const overflow = cornerRight.filter((_, index) => !picked.has(index));
    return { visible, overflow, usedPx };
  };
  const first = selectWithGaps(budgetPx);
  const needsSummary = forceSummary || first.overflow.length > 0;
  const summaryReservedPx = needsSummary ? summaryHeightPx + gapPx : 0;
  const selected = needsSummary
    ? selectWithGaps(Math.max(0, budgetPx - summaryReservedPx))
    : first;
  return { ...selected, summaryReservedPx };
}

export type RightStackDisplayMode = "full" | "compact";

/**
 * 右上スタックを full → 台風のみ compact → overflow の順で選ぶ。
 * compact は「full では現在の残予算に入らない」場合だけ試し、他 domain の表示は縮約しない。
 */
export function selectRightStackWithTyphoonCompact(
  cornerRight: ActiveStandbyCardV1[],
  budgetPx: number,
  estimateHeightPx: (item: ActiveStandbyCardV1, mode: RightStackDisplayMode) => number,
  summaryHeightPx: number,
  forceSummary: boolean,
  gapPx: number,
): {
  visible: ActiveStandbyCardV1[];
  overflow: ActiveStandbyCardV1[];
  displayModes: ReadonlyMap<string, RightStackDisplayMode>;
  usedPx: number;
  summaryReservedPx: number;
} {
  const severityRank: Record<ActiveStandbyCardV1["severity"], number> = {
    info: 1,
    normal: 1,
    warning: 2,
    critical: 3,
  };
  const order = cornerRight
    .map((item, index) => ({ item, index }))
    .sort((left, right) => severityRank[right.item.severity] - severityRank[left.item.severity] || left.index - right.index);

  const selectWithGaps = (availablePx: number) => {
    let usedPx = 0;
    const picked = new Map<number, RightStackDisplayMode>();
    for (const { item, index } of order) {
      const gap = picked.size > 0 ? gapPx : 0;
      const fullRequired = estimateHeightPx(item, "full") + gap;
      if (usedPx + fullRequired <= availablePx) {
        picked.set(index, "full");
        usedPx += fullRequired;
        continue;
      }
      if (item.kind === "typhoon") {
        const compactRequired = estimateHeightPx(item, "compact") + gap;
        if (usedPx + compactRequired <= availablePx) {
          picked.set(index, "compact");
          usedPx += compactRequired;
        }
      }
    }
    const visible = cornerRight.filter((_, index) => picked.has(index));
    const overflow = cornerRight.filter((_, index) => !picked.has(index));
    const displayModes = new Map(visible.map((item) => {
      const index = cornerRight.indexOf(item);
      return [item.key, picked.get(index) ?? "full"] as const;
    }));
    return { visible, overflow, displayModes, usedPx };
  };

  const first = selectWithGaps(budgetPx);
  const needsSummary = forceSummary || first.overflow.length > 0;
  const summaryReservedPx = needsSummary ? summaryHeightPx + gapPx : 0;
  const selected = needsSummary
    ? selectWithGaps(Math.max(0, budgetPx - summaryReservedPx))
    : first;
  return { ...selected, summaryReservedPx };
}

export const VOLCANO_LEVEL_LABELS: Record<number, string> = {
  1: "活火山であることに留意", 2: "火口周辺規制", 3: "入山規制", 4: "高齢者等避難", 5: "避難",
};

const FLOOD_WIDE_HEADER_ESTIMATE_PX = 48;
// 主行 + 2×2 グリッド (観測所/水位/水位の情報/ミニグラフ、値のみ) のセル実高目安。
const FLOOD_WIDE_ROW_ESTIMATE_PX = 88;
// 400px 以下では river-line が折り返し、station grid も観測所・水位・基準・グラフの
// 4 段になる。121px 程度の実内容幅で、主行2行(34px) + station 4段(約105px) +
// padding/gap/border を合算した保守値。通常幅の 88px を流用すると表示数を過大評価する。
const FLOOD_WIDE_NARROW_ROW_ESTIMATE_PX = 160;
// 集約行「ほか N 河川」の実高目安。1 行テキスト + padding/border。preview 実測 36.4px (2026-07-23)
// に余裕を乗せた値。実測と乖離したら上げる方向で調整する (過小見積りが再クリップの主リスク)。
const FLOOD_WIDE_MORE_ROW_ESTIMATE_PX = 40;

/** 洪水ワイドの表示行。key は union 内で名前空間を分け、外部由来 riverKey と衝突しない。 */
export type FloodWideRow =
  | { kind: "river"; key: `river:${string}`; river: DisplayFloodRiverV1 }
  | { kind: "more"; key: "meta:more"; omittedCount: number };

export function layoutFloodWideRows(
  rivers: DisplayFloodRiverV1[],
  viewportHeightPx: number,
  containerWidthPx = Number.POSITIVE_INFINITY,
): FloodWideRow[] {
  const availablePx = Math.max(0, viewportHeightPx * 0.3 - FLOOD_WIDE_HEADER_ESTIMATE_PX);
  const rowEstimatePx = containerWidthPx <= 400
    ? FLOOD_WIDE_NARROW_ROW_ESTIMATE_PX
    : FLOOD_WIDE_ROW_ESTIMATE_PX;
  const riverRow = (river: DisplayFloodRiverV1): FloodWideRow =>
    ({ kind: "river", key: `river:${river.riverKey}`, river });
  // 全河川が収まるなら集約なし (最低 1 行は保証。旧実装の「最低 2 行強制」は 720p 溢れの直接原因)
  const fullRows = Math.max(1, Math.floor(availablePx / rowEstimatePx));
  if (rivers.length <= fullRows * 2) return rivers.map(riverRow);
  // 収まらない場合は集約行の実高を先に差し引いてから河川行数を決める (集約行を「2 セル分」と
  // みなす旧予約は過大で、720p の表示可能セルを不当に削っていた)
  const rowsWithMore = Math.max(0, Math.floor((availablePx - FLOOD_WIDE_MORE_ROW_ESTIMATE_PX) / rowEstimatePx));
  const visibleCount = Math.min(rivers.length, rowsWithMore * 2);
  return [
    ...rivers.slice(0, visibleCount).map(riverRow),
    { kind: "more", key: "meta:more", omittedCount: rivers.length - visibleCount },
  ];
}

/** A wide placement is useful only when it can retain at least one supplied
 * river. Callers fall back to FloodCard when the wide budget would collapse
 * to the aggregate row alone. */
export function floodWideRowsIncludeDetail(
  rivers: DisplayFloodRiverV1[],
  viewportHeightPx: number,
  containerWidthPx: number,
): boolean {
  const availablePx = Math.max(0, viewportHeightPx * 0.3 - FLOOD_WIDE_HEADER_ESTIMATE_PX);
  const rowEstimatePx = containerWidthPx <= 400
    ? FLOOD_WIDE_NARROW_ROW_ESTIMATE_PX
    : FLOOD_WIDE_ROW_ESTIMATE_PX;
  // layoutFloodWideRows guarantees one logical row for non-empty input; that
  // fallback is not physical proof that the row fits under max-height:30vh.
  if (availablePx < rowEstimatePx) return false;
  return layoutFloodWideRows(rivers, viewportHeightPx, containerWidthPx)
    .some((row) => row.kind === "river");
}
