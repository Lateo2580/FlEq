import chalk from "chalk";
import { ParsedHeatAlertInfo } from "../types";
import * as theme from "./theme";
import {
  getFrameWidth,
  SEVERITY_LABELS,
  clipToVisualWidth,
  frameTopColored,
  frameBottomColored,
  frameLineColored,
  frameDividerColored,
  createRenderBuffer,
  flushWithRecap,
  wrapFrameLinesColored,
  renderFooter,
} from "./formatter";
import {
  getDisplaySeverityText,
  getDisplaySeverityTierPrefix,
  drawSeverityBanner,
} from "./weather-warning-level-theme";
import { heatAlertFrameLevel } from "../engine/presentation/level-helpers";

/**
 * 熱中症警戒アラート (VPFT50) の full 表示。
 * compact 分岐は持たない (compact は summary/token-builders 側の責務)。
 *
 * 配色言語: 取消 = release 全面 / critical (題名昇格フェイルセーフ) = nonLevelSpecial 全面 /
 * 通常 (warning) = nonLevelWarning 全面。
 * VPFT50 は単一現象・単一府県の短い電文のため、weather 系の「本文罫線は白系」言語から
 * 意図的に離れ、フレーム全面を severity 色にする (2026-06-13 レビュー決定。上下分裂の解消)。
 * バナーは取消と critical のみ (特別警報級と取消のみの原則、Phase C 発火基準)。
 */
export function displayHeatAlertInfo(info: ParsedHeatAlertInfo): void {
  const level = heatAlertFrameLevel(info);
  const width = getFrameWidth();
  const buf = createRenderBuffer();
  buf.pushEmpty();
  const isCancel = info.infoType === "取消";

  const outerColor = isCancel
    ? getDisplaySeverityText("release")
    : level === "critical"
      ? getDisplaySeverityText("nonLevelSpecial")
      : getDisplaySeverityText("nonLevelWarning");
  // 本文・フッタ罫線も outerColor と同一 (全面 severity 色。冒頭の配色言語コメント参照)
  const bodyColor = outerColor;

  // バナーは取消と critical (題名昇格フェイルセーフ) のみ
  if (isCancel || level === "critical") {
    const bannerSev = isCancel ? ("release" as const) : ("nonLevelSpecial" as const);
    const tier = getDisplaySeverityTierPrefix(bannerSev);
    const label = isCancel ? "取消 熱中症警戒アラート" : info.title;
    const text = clipToVisualWidth(`${tier} ${label}`.trim(), width - 2);
    for (const l of drawSeverityBanner(bannerSev, text, width)) buf.push(l);
  }

  buf.push(frameTopColored(level, outerColor, width));

  // テスト電文バッジ
  if (info.isTest) {
    buf.push(
      frameLineColored(level, outerColor, theme.getRoleChalk("testBadge")(" テスト電文 "), width),
    );
  }

  // タイトル行 (controlTitle = 電文自身の名乗り「熱中症警戒アラート」)
  const titleContent =
    chalk.bold(info.controlTitle || "熱中症警戒アラート") +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLineColored(level, outerColor, titleContent, width));

  // 対象府県 + 電文タイトル (取消フレームでも対象府県が判るよう、取消分岐の前に出す。
  // briefing-formatter / climate-info-formatter と同じ前例)
  if (info.targetAreaName) {
    buf.push(
      frameLineColored(level, bodyColor, `  ${chalk.bold.white(info.targetAreaName)}`, width),
    );
  }
  if (info.title) {
    for (const wrapped of wrapFrameLinesColored(level, bodyColor, `  ${chalk.white(info.title)}`, width)) {
      buf.push(wrapped);
    }
  }

  if (isCancel) {
    buf.push(frameDividerColored(level, bodyColor, width));
    buf.push(frameLineColored(level, bodyColor, chalk.gray("この情報は取り消されました"), width));
  } else {
    // 本文 (Comment 平文)。段落をそのまま wrap 表示
    if (info.bodyText) {
      buf.push(frameDividerColored(level, bodyColor, width));
      for (const rawLine of info.bodyText.split("\n")) {
        const trimmed = rawLine.replace(/　/g, " ");
        for (const wrapped of wrapFrameLinesColored(level, bodyColor, `    ${chalk.white(trimmed)}`, width)) {
          buf.push(wrapped);
        }
      }
    }
  }

  // フッター
  renderFooter(
    level,
    info.type,
    info.reportDateTime,
    info.publishingOffice,
    width,
    buf,
    bodyColor,
  );

  buf.push(frameBottomColored(level, bodyColor, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width, bodyColor);
}
