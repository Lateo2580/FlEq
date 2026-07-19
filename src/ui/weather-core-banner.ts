// VPWW55-61 バナー本文の組み立て (A2 部品優先度落とし) と 3 行 chip 描画。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.5)
import { visualWidth, visualPadEnd, clipToVisualWidth } from "./formatter";
import type { DisplaySeverity } from "../dmdata/weather-warning-level";
import { getDisplaySeverityChip } from "./weather-warning-level-theme";

export interface BannerTextOpts {
  tierPrefix: string;
  levelLabel: string;
  areaName: string;
  transitionSummary: string;
  maxWidth: number;
}

/**
 * バナー本文を部品優先度で組み立てる。幅が足りないとき後ろから落とす:
 * 3 遷移サマリー → 2 地域 → 1 (tier + 種別) は絶対残す。
 */
export function buildBannerText(opts: BannerTextOpts): string {
  const head = `${opts.tierPrefix} ${opts.levelLabel}`;
  const candidates = [
    [head, opts.areaName, opts.transitionSummary],
    [head, opts.areaName],
    [head],
  ];
  for (const parts of candidates) {
    const text = parts.filter(Boolean).join("　");
    if (visualWidth(text) <= opts.maxWidth) return text;
  }
  return clipToVisualWidth(head, opts.maxWidth);
}

/** 3 行構造 (空白上 / 本文 / 空白下) の chip バナーを返す。 */
export function drawBanner(
  severity: DisplaySeverity,
  body: string,
  width: number,
): string[] {
  const chip = getDisplaySeverityChip(severity);
  const blank = chip(" ".repeat(width));
  const content = chip(" " + visualPadEnd(body, Math.max(0, width - 1)));
  return [blank, content, blank];
}
