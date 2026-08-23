import type { ActiveStandbyCardV1, DisplayFloodRiverV1, DisplayFloodStationV1 } from "./protocol";
import type { PageAreaEntry } from "./legacy-standby/types";

export const FLOOD_TREND_ARROW: Record<NonNullable<DisplayFloodStationV1["trend"]>, string> = {
  rising: "↑",
  falling: "↓",
  steady: "→",
};

/**
 * Page identity follows the weather adapter's kind/name occurrence contract.
 * riverKey is the reducer's snapshot-stable key and distinguishes same-named
 * rivers without claiming a permanent external uniqueness guarantee.
 */
export function floodPageAreaEntries(rivers: readonly DisplayFloodRiverV1[]): PageAreaEntry[] {
  const occurrenceByArea = new Map<string, number>();
  return rivers.map((river) => {
    const kindKey = river.kindName;
    const area = river.riverName;
    const occurrenceKey = `${kindKey}\u0000${area}`;
    const occurrenceIndex = occurrenceByArea.get(occurrenceKey) ?? 0;
    occurrenceByArea.set(occurrenceKey, occurrenceIndex + 1);
    return { kindKey, area, areaCode: river.riverKey, occurrenceIndex };
  });
}

/** page-partition compares the returned number with the fixed page budget. */
export function floodPartitionProbeSentinel(fits: boolean, fixedHeightPx: number): number {
  return fits ? 0 : fixedHeightPx + 1;
}

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
