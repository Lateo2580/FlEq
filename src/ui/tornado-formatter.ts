import chalk from "chalk";
import { ParsedTornadoAdvisory } from "../types";
import * as theme from "./theme";
import {
  FrameLevel,
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
import { tornadoFrameLevel } from "../engine/presentation/level-helpers";
import { selectPreferredTornadoLayer } from "../dmdata/tornado-parser";

// 本文・フッタ・取消外の白系罫線色 (normal 概念色 #e8e8e8)。briefing-formatter と同値。
const WHITE_BORDER = chalk.rgb(232, 232, 232);

/** 電文タイプの日本語名 */
function tornadoTypeLabel(type: string): string {
  switch (type) {
    case "VPHW50": return "竜巻注意情報";
    case "VPHW51": return "竜巻注意情報（目撃情報付き）";
    default: return "竜巻注意情報";
  }
}

/** 1 グループ内の最大表示地域数 */
const MAX_AREAS_PER_GROUP = 30;

/**
 * 有効期限を短い時刻表記に。
 * reportDateTime と同日なら "HH:MM"、日跨ぎなら "MM/DD HH:MM"。
 */
function formatValidUntil(
  validDateTime: string | null,
  reportDateTime: string,
): string | null {
  if (!validDateTime) return null;
  // ISO 8601 から YYYY-MM-DD と HH:MM を抽出
  const validMatch = validDateTime.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/,
  );
  if (!validMatch) return null;
  const [, , validMonth, validDay, validHour, validMinute] = validMatch;
  const reportMatch = reportDateTime.match(
    /^(\d{4})-(\d{2})-(\d{2})/,
  );
  // 同日判定 (YYYY-MM-DD 部分が一致するか)
  const sameDate =
    reportMatch != null &&
    reportMatch[1] === validMatch[1] &&
    reportMatch[2] === validMonth &&
    reportMatch[3] === validDay;
  if (sameDate) {
    return `${validHour}:${validMinute}`;
  }
  return `${validMonth}/${validDay} ${validHour}:${validMinute}`;
}

function renderTornadoAdvisory(info: ParsedTornadoAdvisory, showAllAreas: boolean): void {
  const level = tornadoFrameLevel(info);
  const label = tornadoTypeLabel(info.type);
  const width = getFrameWidth();

  const severity = info.displaySeverity;
  const isCancel = info.infoType === "取消";

  // 配色言語 (Phase A-C 踏襲):
  //  取消 = フレーム全体 release 単色
  //  本文あり = 外枠+タイトル罫線を displaySeverity 色、本文・フッタは白系
  //  平常・対象なし (severity == null) = 白単色
  const outerColor = isCancel
    ? getDisplaySeverityText("release")
    : severity != null
      ? getDisplaySeverityText(severity)
      : WHITE_BORDER;
  const bodyColor = isCancel ? getDisplaySeverityText("release") : WHITE_BORDER;

  const buf = createRenderBuffer();
  buf.pushEmpty();

  // severity バナー (3 行色面): 目撃あり (nonLevelSpecial) と取消のみ発火。
  // VPHW50 通常発表 (nonLevelWarning) では発火しない。
  if (isCancel) {
    const tier = getDisplaySeverityTierPrefix("release");
    const text = clipToVisualWidth(`${tier} 取消 竜巻注意情報`, width - 2);
    for (const l of drawSeverityBanner("release", text, width)) buf.push(l);
  } else if (info.hasSightingAreas || info.isSightingTelegram) {
    const tier = getDisplaySeverityTierPrefix("nonLevelSpecial");
    const sightingNames = info.hasSightingAreas
      ? info.sightingAreas.map((a) => a.name).join(", ")
      : "(地域不明)";
    // drawSeverityBanner は折返し不可 (visualPadEnd のみ) のため、ここで必ず clip する。
    const text = clipToVisualWidth(`${tier} 目撃情報あり ${sightingNames}`.trim(), width - 2);
    for (const l of drawSeverityBanner("nonLevelSpecial", text, width)) buf.push(l);
  }

  // 外枠 + タイトル (displaySeverity / 取消 = release / 平常 = 白)
  buf.push(frameTopColored(level, outerColor, width));

  // テスト電文バッジ
  if (info.isTest) {
    buf.push(
      frameLineColored(level, outerColor, theme.getRoleChalk("testBadge")(" テスト電文 "), width),
    );
  }

  // タイトル行
  const titleContent =
    chalk.bold(label) +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLineColored(level, outerColor, titleContent, width));

  // info.title が typeLabel と異なる場合のサブタイトル
  if (info.title && info.title !== label) {
    buf.push(frameLineColored(level, outerColor, chalk.white(info.title), width));
  }

  // 取消は短く (フレーム全体 release 単色、早期 return)
  if (isCancel) {
    buf.push(frameDividerColored(level, bodyColor, width));
    buf.push(
      frameLineColored(level, bodyColor, chalk.gray("竜巻注意情報は取り消されました"), width),
    );
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, bodyColor);
    buf.push(frameBottomColored(level, bodyColor, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width, bodyColor);
    return;
  }

  // 目撃地域一覧 (本文側): 目撃地域名は severity バナーへ移したが、バナーは折返し不可で
  // clip されるため、情報が失われないよう従来どおりの一覧を本文行としても残す。
  if (info.hasSightingAreas) {
    buf.push(frameDividerColored(level, bodyColor, width));
    const sightingNames = info.sightingAreas
      .map((a) => chalk.white(a.name))
      .join(", ");
    const line = `${chalk.gray("目撃情報あり:")} ${sightingNames}`;
    for (const wrapped of wrapFrameLinesColored(level, bodyColor, line, width)) {
      buf.push(wrapped);
    }
  }

  // ヘッドライン
  if (info.headline) {
    buf.push(frameDividerColored(level, bodyColor, width));
    const headlineWrapped = wrapFrameLinesColored(
      level,
      bodyColor,
      chalk.bold.white(info.headline),
      width,
    );
    for (let i = 0; i < headlineWrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(headlineWrapped[i]);
      } else {
        buf.push(headlineWrapped[i]);
      }
    }
  }

  // サマリー行: 発表地域数 + 有効期限
  const summaryParts: string[] = [];
  if (info.activeAreaCount > 0) {
    summaryParts.push(chalk.yellow.bold(`発表中 ${info.activeAreaCount}地域`));
  }
  const validUntil = formatValidUntil(info.validDateTime, info.reportDateTime);
  if (validUntil) {
    summaryParts.push(chalk.cyan(`有効期限 ${validUntil}`));
  }
  if (summaryParts.length > 0) {
    buf.push(frameDividerColored(level, bodyColor, width));
    buf.push(frameLineColored(level, bodyColor, summaryParts.join("  "), width));
  }

  // 階層別表示
  const finePreferred = selectPreferredTornadoLayer(info.layers);
  // detail はもちろん、カードの上限・省略数も同じ細粒度 layer を基準にする。
  // 上位 layer へ退避すると、detail で市町村等の全対象地域を復元できなくなる。
  const displayLayer = finePreferred;
  if (displayLayer && displayLayer.areas.length > 0) {
    buf.push(frameDividerColored(level, bodyColor, width));
    buf.push(
      frameLineColored(level, bodyColor, chalk.gray(`[${displayLayer.type}]`), width),
    );

    const visible = showAllAreas
      ? displayLayer.areas
      : displayLayer.areas.slice(0, MAX_AREAS_PER_GROUP);
    const omitted = displayLayer.areas.length - visible.length;
    const namesLine = visible.map((a) => chalk.white(a.name)).join(", ");

    for (const wrapped of wrapFrameLinesColored(level, bodyColor, `  ${namesLine}`, width)) {
      buf.push(wrapped);
    }
    if (omitted > 0) {
      buf.push(
        frameLineColored(
          level,
          bodyColor,
          chalk.gray(`  ... ほか ${omitted} 区域 (詳細: detail tornado)`),
          width,
        ),
      );
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

/** 竜巻注意情報を表示 */
export function displayTornadoAdvisory(info: ParsedTornadoAdvisory): void {
  renderTornadoAdvisory(info, false);
}

/** REPL detail 用に、対象地域を省略せず表示する。 */
export function displayTornadoAdvisoryDetail(info: ParsedTornadoAdvisory): void {
  renderTornadoAdvisory(info, true);
}
