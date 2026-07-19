// 気象警報・注意報 (VPWW55-61) の displaySeverity → 表示 (tier prefix / 色 / chip / L 表記) 解決。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.2)
import chalk from "chalk";
import type { DisplaySeverity } from "../dmdata/weather-warning-level";
import { getRoleChalk, type RoleName } from "./theme";
import { centerPad, visualPadEnd } from "./formatter";

// ── tier prefix (○ △ ☆ ★ ★★ / △ ◆ ◆◆) ──

const TIER_PREFIX: Record<DisplaySeverity, string> = {
  officialL5:       "★★",
  officialL4:       "★",
  officialL3:       "☆",
  officialL2:       "△",
  officialL1:       "○",
  nonLevelSpecial:  "◆◆",
  nonLevelWarning:  "◆",
  nonLevelAdvisory: "△",
  release:          "▼",
  unknown:          "?",
};

export function getDisplaySeverityTierPrefix(severity: DisplaySeverity): string {
  return TIER_PREFIX[severity];
}

// ── 色 (chip = bg+白文字ロール / text = 前景色のみ) ──

// RoleName は theme.ts で keyof typeof DEFAULT_ROLES として自動派生されるため、
// T6 で 8 ロールを追加済みなら下記キーはすべて RoleName に含まれる (キャスト不要)。
const ROLE_NAME: Record<DisplaySeverity, RoleName> = {
  officialL5:       "weatherBannerOfficialL5",
  officialL4:       "weatherBannerOfficialL4",
  officialL3:       "weatherBannerOfficialL3",
  officialL2:       "weatherBannerOfficialL2",
  officialL1:       "weatherBannerOfficialL1",
  nonLevelSpecial:  "weatherBannerNonLevelSpecial",
  nonLevelWarning:  "weatherBannerNonLevelWarning",
  nonLevelAdvisory: "weatherBannerNonLevelAdvisory",
  release:          "weatherWarningCancelBanner",
  unknown:          "weatherBannerOfficialL1",
};

const TEXT_RGB: Record<DisplaySeverity, [number, number, number]> = {
  officialL5:       [160, 48, 160],
  officialL4:       [122, 30, 0],
  officialL3:       [213, 94, 0],
  officialL2:       [230, 159, 0],
  officialL1:       [132, 145, 158],
  nonLevelSpecial:  [122, 30, 0],
  nonLevelWarning:  [213, 94, 0],
  nonLevelAdvisory: [230, 159, 0],
  release:          [204, 121, 167],
  unknown:          [132, 145, 158],
};

export function getDisplaySeverityChip(severity: DisplaySeverity): (s: string) => string {
  // getRoleChalk は chalk.Chalk を返す。chalk.Chalk は (s: string) => string の
  // 呼び出しシグネチャを持つため、そのまま代入可能。
  return getRoleChalk(ROLE_NAME[severity]);
}

export function getDisplaySeverityText(severity: DisplaySeverity): (s: string) => string {
  const [r, g, b] = TEXT_RGB[severity];
  return chalk.rgb(r, g, b);
}

// ── 種別名の正規化 + L 表記 ──
// 純関数につき dmdata leaf (weather-warning-level.ts) に移設済み。engine 層の display 射影と
// 共有するため。既存の ui 側 import 互換のためここから re-export する。
export { normalizeKindName, formatLevelLabel } from "../dmdata/weather-warning-level";

// ── chip レンダリング (統一幅) ──

const CHIP_BG_SEVERITIES = new Set<DisplaySeverity>([
  "officialL5", "officialL4", "nonLevelSpecial", "release",
]);

export const STATUS_CHIP_WIDTH = 14;
export const DIVIDER_CHIP_WIDTH = 22;

/** 状態列 chip。L5/L4/nonLevelSpecial/release は bg-chip、それ以外は text 色。幅は統一して中央寄せ。 */
export function renderStatusChip(
  severity: DisplaySeverity,
  status: string,
  width: number = STATUS_CHIP_WIDTH,
): string {
  const padded = centerPad(status, width);
  if (CHIP_BG_SEVERITIES.has(severity)) {
    return getDisplaySeverityChip(severity)(padded);
  }
  return getDisplaySeverityText(severity)(padded);
}

/** divider 見出し chip。22 cells 統一幅。L5/L4/nonLevelSpecial は bg-chip、それ以外は text 色。 */
export function renderDividerChip(
  severity: DisplaySeverity,
  label: string,
  width: number = DIVIDER_CHIP_WIDTH,
): string {
  const padded = centerPad(label, width);
  if (CHIP_BG_SEVERITIES.has(severity)) {
    return getDisplaySeverityChip(severity)(padded);
  }
  return getDisplaySeverityText(severity)(padded);
}

// ── Phase C 共有部品: divider ラベル + 3 行バナー ──

/**
 * divider 見出しラベル (tier prefix 込み)。
 * VPWW Phase A 確定文言に三電文 (VPWW/VPWP50/VPWS50) 統一 (2026-06-12 目視ゲートでレビュー決定)。
 * 旧 VPWP50 形式 (★★ L5相当 等) は廃止。VPWW の dividerLabelForSeverity もここを参照する。
 */
export const DISPLAY_SEVERITY_DIVIDER_LABEL: Record<DisplaySeverity, string> = {
  officialL5:       "★★ 特別警報 (L5)",
  officialL4:       "★ 危険警報 (L4)",
  officialL3:       "☆ 警報 (L3)",
  officialL2:       "△ 注意報 (L2)",
  officialL1:       "○ 早期注意 (L1)",
  nonLevelSpecial:  "◆◆ 特別警報",
  nonLevelWarning:  "◆ 警報",
  nonLevelAdvisory: "△ 注意報",
  release:          "▼ 解除",
  unknown:          "? 未知",
};

/**
 * displaySeverity 色の 3 行バナー (EEW 同形の色面)。VPWP50 drawWeatherWarningBanner の共有化。
 * VPWS50 バナー導入 (Task 8) でも同じ色面を使えるようにする。
 */
export function drawSeverityBanner(
  severity: DisplaySeverity,
  bannerText: string,
  width: number,
): [string, string, string] {
  const style = getDisplaySeverityChip(severity);
  const padded = " " + bannerText;
  const blank = " ".repeat(width);
  return [style(blank), style(visualPadEnd(padded, width)), style(blank)];
}
