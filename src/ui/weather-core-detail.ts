// VPWW55-61 [詳細] こぼれ受けブロック。テーブルがその幅で落とした列だけを 種別+地域 ラベルで回収する。
// spec: 設計メモ 2026-06-08-vpww-detail-block-redesign-design.md
import { frameLineColored, frameDividerLabeledColored, wrapTextLines, type FrameLevel } from "./formatter";
import type { WarningEntry, DisplayMode } from "./weather-core-entry";
import { groupBySeverity } from "./weather-core-table";
import { formatTransitionStatus } from "./weather-core-status";
import { formatLevelLabel } from "./weather-warning-level-theme";

export const OVERFLOW_MAX_ENTRIES = 20;

/** 1 entry がその幅でこぼす値 (状態の遷移表記 / 一部) を順に返す。何もなければ []。 */
function spilledParts(e: WarningEntry, mode: DisplayMode): string[] {
  const parts: string[] = [];
  // 状態列が落ちる幅 (ultra-narrow) → 状態 (遷移表記) をプレーンテキストで回収。
  // ※ 折返し時の ANSI 破損を避けるため色注入はしない (border 色のみ)。
  if (mode === "ultra-narrow") parts.push(formatTransitionStatus(e));
  // 備考列 (全域部分) が落ちる幅。fullStatus は {"全域","一部",undefined} (weather-parser.ts)。
  // 全域は既定値なので「一部」(注目すべき部分発表) のときだけ回収。
  if (mode !== "wide" && e.fullStatus === "一部") parts.push("一部");
  return parts;
}

/**
 * [詳細] こぼれ受けブロック (色注入)。テーブルがその幅で落とした列だけを `種別 地域 … 値` で回収する。
 * wide は何も落ちない → 空。並びはテーブルと同じ severity 降順。こぼす entry が maxEntries を超えたら
 * `… ほか N 件省略` に畳む。こぼす entry が 0 件なら divider ごと出さない ([] を返す)。
 */
export function buildOverflowDetailBlock(
  styleLevel: FrameLevel,
  borderColor: (s: string) => string,
  width: number,
  mode: DisplayMode,
  entries: WarningEntry[],
  maxEntries: number = OVERFLOW_MAX_ENTRIES,
): string[] {
  if (mode === "wide") return [];
  // テーブルと同じ severity 降順で並べ、行の対応を取りやすくする
  const ordered = groupBySeverity(entries).flatMap((g) => g.entries);

  const rows: string[] = [];
  let shown = 0;
  let omitted = 0;
  for (const e of ordered) {
    const parts = spilledParts(e, mode);
    if (parts.length === 0) continue;
    if (shown >= maxEntries) { omitted++; continue; }
    // 種別はテーブル種別列と同じ表記 (同一地域の複数 kind を区別)
    const kind = formatLevelLabel(e.officialAlertLevel, e.kindName);
    rows.push(`  ${kind} ${e.areaName} … ${parts.join(" / ")}`);
    shown++;
  }
  if (rows.length === 0) return [];
  if (omitted > 0) rows.push(`  … ほか ${omitted} 件省略`);

  const out: string[] = [];
  out.push(frameDividerLabeledColored(styleLevel, borderColor, "[詳細]", width));
  for (const row of rows) {
    for (const piece of wrapTextLines(row, Math.max(1, width - 4))) {
      out.push(frameLineColored(styleLevel, borderColor, piece, width));
    }
  }
  return out;
}
