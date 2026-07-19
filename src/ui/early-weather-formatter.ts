import chalk from "chalk";
import {
  ParsedEarlyWeatherInfo,
  EarlyWeatherPhenomenon,
} from "../types";
import * as theme from "./theme";
import {
  FrameLevel,
  getFrameWidth,
  SEVERITY_LABELS,
  frameTopColored,
  frameLineColored,
  frameDividerColored,
  frameBottomColored,
  createRenderBuffer,
  flushWithRecap,
  wrapFrameLinesColored,
  renderFooter,
} from "./formatter";
import { getDisplaySeverityText } from "./weather-warning-level-theme";
import { earlyWeatherFrameLevel } from "../engine/presentation/level-helpers";

// 平常 = 白単色、取消 = release 単色 (確定配色言語)。VPAW51 は一律 normal (Phase D レビュー決定 3)
const WHITE_BORDER = chalk.rgb(232, 232, 232);

/** 主要現象の集約タグ (title から導出) */
function deriveTagLabels(info: ParsedEarlyWeatherInfo): string[] {
  // title 例: "高温と大雪に関する早期天候情報（東北地方）" → ["高温", "大雪"]
  const title = info.title || "";
  const match = title.match(/^(.+?)に関する早期天候情報/);
  if (match) {
    return match[1].split("と").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  // フォールバック: phenomena から type を取り出す
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const p of info.phenomena) {
    const cleaned = p.type.replace(/^かなりの/, "");
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      labels.push(cleaned);
    }
  }
  return labels;
}

/** trend に応じた色 */
function trendColor(p: EarlyWeatherPhenomenon): (s: string) => string {
  if (p.trend === "above") {
    // 高温/大雪/多雨 系 → 赤橙
    if (p.climateKind === "気温") return chalk.red.bold;
    return chalk.yellow.bold;
  }
  if (p.trend === "below") {
    // 低温/少雨 系 → 青
    return chalk.cyan.bold;
  }
  return chalk.white;
}

/** trend の補助記号 (Above=↑, Below=↓) */
function trendArrow(p: EarlyWeatherPhenomenon): string {
  if (p.trend === "above") return "↑";
  if (p.trend === "below") return "↓";
  return "";
}

/** 早期天候情報を表示 */
export function displayEarlyWeatherInfo(info: ParsedEarlyWeatherInfo): void {
  const level = earlyWeatherFrameLevel(info);
  const width = getFrameWidth();

  const borderColor = info.infoType === "取消"
    ? getDisplaySeverityText("release")
    : WHITE_BORDER;

  const buf = createRenderBuffer();
  buf.pushEmpty();
  buf.push(frameTopColored(level, borderColor, width));

  // テスト電文バッジ
  if (info.isTest) {
    buf.push(
      frameLineColored(level, borderColor, theme.getRoleChalk("testBadge")(" テスト電文 "), width),
    );
  }

  // タイトル行
  const titleContent =
    chalk.bold("早期天候情報") +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLineColored(level, borderColor, titleContent, width));

  if (info.title && info.title !== "早期天候情報") {
    buf.push(frameLineColored(level, borderColor, chalk.white(info.title), width));
  }

  // 取消は短く
  if (info.infoType === "取消") {
    buf.push(frameDividerColored(level, borderColor, width));
    buf.push(
      frameLineColored(level, borderColor, chalk.gray("早期天候情報は取り消されました"), width),
    );
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, borderColor);
    buf.push(frameBottomColored(level, borderColor, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width, borderColor);
    return;
  }

  // タグバナー (高温・大雪 など)
  const tags = deriveTagLabels(info);
  if (tags.length > 0) {
    buf.push(frameDividerColored(level, borderColor, width));
    const tagBanner = chalk.bold.yellow(` ${tags.join("・")} `);
    buf.push(frameLineColored(level, borderColor, tagBanner, width));
  }

  // 対象地域
  if (info.targetArea) {
    buf.push(frameDividerColored(level, borderColor, width));
    buf.push(frameLineColored(level, borderColor, chalk.gray("[対象地域]"), width));
    buf.push(frameLineColored(level, borderColor, `  ${chalk.white(info.targetArea.name)}`, width));
  }

  // 期間
  const periodLabel =
    info.phenomena.find((p) => p.periodLabel)?.periodLabel || null;
  if (periodLabel) {
    buf.push(frameDividerColored(level, borderColor, width));
    buf.push(frameLineColored(level, borderColor, chalk.gray("[対象期間]"), width));
    buf.push(frameLineColored(level, borderColor, `  ${chalk.white(periodLabel)}`, width));
  }

  // 現象 (本文以外の Item.Kind.Property)
  if (info.phenomena.length > 0) {
    buf.push(frameDividerColored(level, borderColor, width));
    buf.push(frameLineColored(level, borderColor, chalk.gray("[現象]"), width));
    for (const p of info.phenomena) {
      const arrow = trendArrow(p);
      const headerParts: string[] = [];
      headerParts.push(trendColor(p)(p.type));
      if (arrow) headerParts.push(trendColor(p)(arrow));
      if (p.probabilityPercent != null) {
        headerParts.push(chalk.gray(`確率 ${p.probabilityPercent}%`));
      }
      if (p.thresholdValue != null) {
        const unit = p.thresholdUnit ?? "";
        const sign = p.trend === "below" ? "−" : p.trend === "above" ? "+" : "";
        headerParts.push(chalk.gray(`閾値 ${sign}${p.thresholdValue}${unit}`));
      }
      for (const wrapped of wrapFrameLinesColored(level, borderColor, `  ${headerParts.join(" ")}`, width)) {
        buf.push(wrapped);
      }
      if (p.climateText) {
        for (const wrapped of wrapFrameLinesColored(
          level,
          borderColor,
          `    ${chalk.dim(p.climateText)}`,
          width,
        )) {
          buf.push(wrapped);
        }
      }
      // 地域 (TargetArea と異なる細分があれば表示)
      const areaNames = p.areas
        .filter((a) => info.targetArea == null || a.code !== info.targetArea.code)
        .map((a) => a.name);
      if (areaNames.length > 0) {
        for (const wrapped of wrapFrameLinesColored(
          level,
          borderColor,
          `    ${chalk.gray("対象: " + areaNames.join(", "))}`,
          width,
        )) {
          buf.push(wrapped);
        }
      }
    }
  }

  // 補足本文 (Property.Type=本文)
  if (info.bodyTexts.length > 0) {
    buf.push(frameDividerColored(level, borderColor, width));
    buf.push(frameLineColored(level, borderColor, chalk.gray("[本文]"), width));
    for (const bt of info.bodyTexts) {
      for (const rawLine of bt.text.split("\n")) {
        const trimmed = rawLine.replace(/　/g, " ");
        for (const wrapped of wrapFrameLinesColored(
          level,
          borderColor,
          `  ${chalk.white(trimmed)}`,
          width,
        )) {
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
    borderColor,
  );

  buf.push(frameBottomColored(level, borderColor, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width, borderColor);
}
