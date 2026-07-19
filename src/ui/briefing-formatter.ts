import chalk from "chalk";
import { ParsedWeatherBriefing, WeatherBriefingTag } from "../types";
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
import { briefingFrameLevel } from "../engine/presentation/level-helpers";

// 本文・フッタ・取消外の白系罫線色 (normal 概念色 #e8e8e8)。weather-core-formatter と同値。
const WHITE_BORDER = chalk.rgb(232, 232, 232);

/** briefingTag の日本語ラベル */
const TAG_LABEL: Record<WeatherBriefingTag, string> = {
  linearRainObserved: "線状降水帯発生",
  linearRainPredicted: "線状降水帯予想",
  recordRain: "記録的短時間大雨",
  shortSnow: "短時間大雪",
  other: "気象防災速報",
};

/** タグに応じた色付け (compact / nonLevelWarning 以下のタグバナー用、従来踏襲) */
function tagColor(tag: WeatherBriefingTag): (s: string) => string {
  switch (tag) {
    case "linearRainObserved":
    case "recordRain":
      return chalk.bgRed.white.bold;
    case "linearRainPredicted":
    case "shortSnow":
      return chalk.yellow.bold;
    default:
      return chalk.white;
  }
}

/** 気象防災速報を表示 */
export function displayWeatherBriefing(info: ParsedWeatherBriefing): void {
  const level = briefingFrameLevel(info);
  const width = getFrameWidth();

  const severity = info.maxDisplaySeverity;
  const isCancel = info.infoType === "取消";

  // 配色言語 (Phase A-C 踏襲):
  //  取消 = フレーム全体 release 単色
  //  本文あり = 外枠+タイトル罫線を maxDisplaySeverity 色、本文・フッタは白系
  //  平常・対象なし (severity == null) = 白単色
  const outerColor = isCancel
    ? getDisplaySeverityText("release")
    : severity != null
      ? getDisplaySeverityText(severity)
      : WHITE_BORDER;
  const bodyColor = isCancel ? getDisplaySeverityText("release") : WHITE_BORDER;

  const buf = createRenderBuffer();
  buf.pushEmpty();

  // severity バナー (3 行色面): 特別警報級 (nonLevelSpecial) と取消のみ発火 (Phase C 発火基準)。
  if (isCancel || severity === "nonLevelSpecial") {
    const bannerSev = isCancel ? ("release" as const) : ("nonLevelSpecial" as const);
    const tier = getDisplaySeverityTierPrefix(bannerSev);
    const label = isCancel ? "取消 気象防災速報" : TAG_LABEL[info.briefingTag];
    // 地域名はバナーに出さない (2026-06-12 レビュー決定)。地域は本文 [対象地域] と
    // タイトル行 (都道府県入り) に任せる。clip はラベルだけでも幅 60 未満端末の保険。
    const text = clipToVisualWidth(`${tier} ${label}`.trim(), width - 2);
    for (const l of drawSeverityBanner(bannerSev, text, width)) buf.push(l);
  }

  // 外枠 + タイトル (maxDisplaySeverity / 取消 = release / 平常 = 白)
  buf.push(frameTopColored(level, outerColor, width));

  // テスト電文バッジ
  if (info.isTest) {
    buf.push(
      frameLineColored(level, outerColor, theme.getRoleChalk("testBadge")(" テスト電文 "), width),
    );
  }

  // タイトル行
  const titleContent =
    chalk.bold("気象防災速報") +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLineColored(level, outerColor, titleContent, width));

  if (info.title && info.title !== "気象防災速報") {
    buf.push(frameLineColored(level, outerColor, chalk.white(info.title), width));
  }

  // 取消は短く (フレーム全体 release 単色、早期 return)
  if (isCancel) {
    buf.push(frameDividerColored(level, bodyColor, width));
    buf.push(
      frameLineColored(level, bodyColor, chalk.gray("気象防災速報は取り消されました"), width),
    );
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, bodyColor);
    buf.push(frameBottomColored(level, bodyColor, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width, bodyColor);
    return;
  }

  // 情報タグ バナー (nonLevelWarning 以下: 従来位置・文言のタグバナー行を維持。
  // nonLevelSpecial は上の severity バナーに置換済みのためここでは描かない)。
  if (severity !== "nonLevelSpecial") {
    buf.push(frameDividerColored(level, bodyColor, width));
    const tagBanner = tagColor(info.briefingTag)(` ${TAG_LABEL[info.briefingTag]} `);
    buf.push(frameLineColored(level, bodyColor, tagBanner, width));
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

  // 対象地域
  if (info.targetAreas.length > 0) {
    buf.push(frameDividerColored(level, bodyColor, width));
    buf.push(frameLineColored(level, bodyColor, chalk.gray("[対象地域]"), width));
    const namesLine = info.targetAreas
      .map((a) => chalk.white(a.name))
      .join(", ");
    for (const wrapped of wrapFrameLinesColored(level, bodyColor, `  ${namesLine}`, width)) {
      buf.push(wrapped);
    }
  }

  // 観測実況
  if (info.observations.length > 0) {
    buf.push(frameDividerColored(level, bodyColor, width));
    buf.push(frameLineColored(level, bodyColor, chalk.gray("[観測実況・予測]"), width));
    for (const obs of info.observations) {
      const locParts: string[] = [];
      if (obs.locationName) locParts.push(obs.locationName);
      if (obs.observationType) locParts.push(`(${obs.observationType})`);
      const locLine = locParts.length > 0 ? locParts.join(" ") + ": " : "";
      // value 単独でも表示できるよう、value/unit を独立したパーツに
      const valuePart = obs.value != null
        ? (obs.unit ? `${obs.value}${obs.unit}` : `${obs.value}`)
        : "";
      // 主表示: description があればそれ、なければ value、それも無ければ observationType
      const main = obs.description || valuePart || obs.observationType || "";
      // description と value が両方ある場合は value をカッコ付きで補足
      const supplement = obs.description && valuePart && !obs.description.includes(valuePart)
        ? ` (${valuePart})`
        : "";
      const timeLine = obs.time
        ? chalk.gray(`  ${obs.time.slice(11, 16)}`)
        : "";
      const line = `  ${chalk.white(locLine)}${chalk.white(main)}${supplement}${timeLine}`;
      for (const wrapped of wrapFrameLinesColored(level, bodyColor, line, width)) {
        buf.push(wrapped);
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
