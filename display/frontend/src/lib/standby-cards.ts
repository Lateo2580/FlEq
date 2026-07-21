import type { ActiveStandbyCardV1 } from "./protocol";

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
  const selectWithGaps = (availablePx: number): { visible: ActiveStandbyCardV1[]; overflow: ActiveStandbyCardV1[]; usedPx: number } => {
    let usedPx = 0;
    const visible: ActiveStandbyCardV1[] = [];
    const overflow: ActiveStandbyCardV1[] = [];
    for (const item of cornerRight) {
      const requiredPx = estimateHeightPx(item) + (visible.length > 0 ? gapPx : 0);
      if (usedPx + requiredPx <= availablePx) {
        visible.push(item);
        usedPx += requiredPx;
      } else {
        overflow.push(item);
      }
    }
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

export const VOLCANO_LEVEL_LABELS: Record<number, string> = {
  1: "活火山であることに留意", 2: "火口周辺規制", 3: "入山規制", 4: "高齢者等避難", 5: "避難",
};

const FLOOD_WIDE_HEADER_ESTIMATE_PX = 48;
const FLOOD_WIDE_ROW_ESTIMATE_PX = 40;
const FLOOD_WIDE_MIN_GRID_ROWS = 2;

export function layoutFloodWideRows(
  rivers: Extract<ActiveStandbyCardV1, { kind: "flood" }>["data"]["rivers"],
  viewportHeightPx: number,
): { visible: typeof rivers; omittedCount: number } {
  const maxHeightPx = Math.max(0, viewportHeightPx * 0.3);
  const gridRows = Math.max(
    FLOOD_WIDE_MIN_GRID_ROWS,
    Math.floor((maxHeightPx - FLOOD_WIDE_HEADER_ESTIMATE_PX) / FLOOD_WIDE_ROW_ESTIMATE_PX),
  );
  const cellCapacity = gridRows * 2;
  if (rivers.length <= cellCapacity) return { visible: rivers, omittedCount: 0 };
  // 集約行は 2 カラムを横断するため、最終グリッド行 (2 cell 分) を先に予約する。
  const visibleCount = Math.max(0, cellCapacity - 2);
  return { visible: rivers.slice(0, visibleCount), omittedCount: rivers.length - visibleCount };
}
