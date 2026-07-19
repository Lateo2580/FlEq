// VPWW55-61 の 3 段階 breakpoint テーブル描画 (列優先度 + 色注入罫線)。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.5)
import { frameLineColored, visualPadEnd, clipToVisualWidth, type FrameLevel } from "./formatter";
import type { WarningEntry, DisplayMode } from "./weather-core-entry";
import { renderStatusChip, getDisplaySeverityTierPrefix, formatLevelLabel, DISPLAY_SEVERITY_DIVIDER_LABEL } from "./weather-warning-level-theme";
import { formatTransitionStatus } from "./weather-core-status";
import { DISPLAY_SEVERITY_RANK, type DisplaySeverity } from "../dmdata/weather-warning-level";

// breakpoint は Phase A では module const (config 化は Phase B)。T31 の幅マトリクスで再調整。
const STANDARD_THRESHOLD = 65;
const WIDE_THRESHOLD = 105;

export function pickMode(width: number): DisplayMode {
  if (width < STANDARD_THRESHOLD) return "ultra-narrow";
  if (width < WIDE_THRESHOLD) return "standard";
  return "wide";
}

const COL_TIER = 4;
const COL_KIND = 20;   // "L4 土砂災害危険警報" (19 cells) まで収まる幅
const COL_AREA = 15;
const COL_STATUS = 14;
const COL_REMARKS = 32;

function getUltraNarrowAreaWidth(width: number): number {
  const innerWidth = Math.max(0, width - 4);
  const fixedWidth = COL_TIER + 1 + COL_KIND + 1;
  return Math.max(0, Math.min(COL_AREA, innerWidth - fixedWidth));
}

// 列幅に正確に収める (超過は … でクリップ、不足は空白パディング)。列ずれ防止。
function fitCol(s: string, width: number): string {
  return visualPadEnd(clipToVisualWidth(s, width), width);
}

function buildRow(e: WarningEntry, mode: DisplayMode, width: number): string {
  const areaWidth = mode === "ultra-narrow" ? getUltraNarrowAreaWidth(width) : COL_AREA;
  const prefix = visualPadEnd(getDisplaySeverityTierPrefix(e.displaySeverity), COL_TIER);
  const label = fitCol(formatLevelLabel(e.officialAlertLevel, e.kindName), COL_KIND);
  const area = fitCol(e.areaName, areaWidth);
  let row = `${prefix} ${label} ${area}`;
  if (mode === "standard" || mode === "wide") {
    row += ` ${renderStatusChip(e.displaySeverity, formatTransitionStatus(e))}`;
  }
  if (mode === "wide") {
    const remarks = (e.fullStatus ?? "") + (e.resolutionSource === "unknown" ? ` ?${e.kindCode}` : "");
    row += ` ${fitCol(remarks, COL_REMARKS)}`;
  }
  return row;
}

/**
 * セクション内の entry をテーブル描画する。styleLevel で罫線スタイル、
 * borderColor でセクション色を罫線に注入。
 */
export function renderResponsiveTable(
  styleLevel: FrameLevel,
  borderColor: (s: string) => string,
  width: number,
  mode: DisplayMode,
  entries: WarningEntry[],
): string[] {
  const lines: string[] = [];
  const areaWidth = mode === "ultra-narrow" ? getUltraNarrowAreaWidth(width) : COL_AREA;
  let header = `${visualPadEnd("級", COL_TIER)} ${visualPadEnd("種別", COL_KIND)} ${visualPadEnd("地域", areaWidth)}`;
  if (mode === "standard" || mode === "wide") header += ` ${visualPadEnd("状態", COL_STATUS)}`;
  if (mode === "wide") header += ` ${visualPadEnd("備考", COL_REMARKS)}`;
  lines.push(frameLineColored(styleLevel, borderColor, header, width));
  for (const e of entries) {
    lines.push(frameLineColored(styleLevel, borderColor, buildRow(e, mode, width), width));
  }
  return lines;
}

// ── severity 別グルーピング + divider ラベル ──

export interface SeverityGroup {
  severity: DisplaySeverity;
  entries: WarningEntry[];
}

export function groupBySeverity(entries: WarningEntry[]): SeverityGroup[] {
  const map = new Map<DisplaySeverity, WarningEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.displaySeverity) ?? [];
    arr.push(e);
    map.set(e.displaySeverity, arr);
  }
  return [...map.entries()]
    .map(([severity, arr]) => ({ severity, entries: arr }))
    .sort((a, b) => DISPLAY_SEVERITY_RANK[b.severity] - DISPLAY_SEVERITY_RANK[a.severity]);
}

// divider 文言は 2026-06-12 目視ゲートでレビュー決定により三電文 (VPWW/VPWP50/VPWS50) 統一。
// VPWW Phase A 確定文言が theme の DISPLAY_SEVERITY_DIVIDER_LABEL に昇格したため、
// ローカル表は削除して delegate する (VPWW の出力文言は不変)。
export function dividerLabelForSeverity(s: DisplaySeverity): string {
  return DISPLAY_SEVERITY_DIVIDER_LABEL[s];
}
