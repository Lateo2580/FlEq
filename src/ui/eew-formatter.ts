import chalk from "chalk";
import { ParsedEewInfo } from "../types";
import type { EewDiff } from "../engine/eew/eew-tracker";
import * as theme from "./theme";
import {
  FrameLevel,
  getFrameWidth,
  getDisplayMode,
  getMaxObservations,
  SEVERITY_LABELS,
  frameColor,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  visualPadEnd,
  wrapFrameLines,
  intensityColor,
  lgIntensityColor,
  intensityToNumeric,
  lgIntToNumeric,
  colorMagnitude,
  renderFooter,
  formatTimestamp,
  renderGroupedItemList,
  type GroupedListItem,
  type GroupedListGroup,
} from "./formatter";

// ── EEW 表示コンテキスト ──

/** EEW 表示時のコンテキスト情報 */
export interface EewDisplayContext {
  /** 現在アクティブなイベント数 */
  activeCount: number;
  /** 前回との差分情報 */
  diff?: EewDiff;
  /** バナー色分け用のカラーインデックス (0始まり) */
  colorIndex?: number;
}

// ── EEW バナーパレット ──

/**
 * EEW バナー色パレット (遅延生成: chalk.level が確定した後に呼ぶ)
 * chalk v4 では bgRgb() 呼び出し時点の level で ANSI コードが確定するため、
 * モジュールレベル定数ではなく関数で都度生成する。
 */
function getWarningBannerPalette(): chalk.Chalk[] {
  return [
    theme.getRoleChalk("eewWarningBanner"),
    theme.getRoleChalk("eewWarningBanner1"),
    theme.getRoleChalk("eewWarningBanner2"),
    theme.getRoleChalk("eewWarningBanner3"),
    theme.getRoleChalk("eewWarningBanner4"),
  ];
}

function getForecastBannerPalette(): chalk.Chalk[] {
  return [
    theme.getRoleChalk("eewForecastBanner"),
    theme.getRoleChalk("eewForecastBanner1"),
    theme.getRoleChalk("eewForecastBanner2"),
    theme.getRoleChalk("eewForecastBanner3"),
    theme.getRoleChalk("eewForecastBanner4"),
  ];
}

/** colorIndex からバナースタイルを取得 */
function getEewBannerStyle(isWarning: boolean, colorIndex: number): chalk.Chalk {
  const palette = isWarning ? getWarningBannerPalette() : getForecastBannerPalette();
  return palette[colorIndex % palette.length];
}

/** PLUM法バナーの装飾行スタイル (1行目・3行目用) */
function getPlumDecorStyle(isWarning: boolean): chalk.Chalk {
  return isWarning
    ? theme.getRoleChalk("plumDecorWarning")
    : theme.getRoleChalk("plumDecorForecast");
}

/** EEW のフレームレベルを決定 */
export function eewFrameLevel(info: ParsedEewInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.isWarning) return "critical";
  return "warning";
}

/** EEW情報を整形して表示 */
export function displayEewInfo(
  info: ParsedEewInfo,
  context?: EewDisplayContext
): void {
  const isCancelled = info.infoType === "取消";
  const level = eewFrameLevel(info);
  const diff = context?.diff;
  const width = getFrameWidth();

  // コンパクトモード: 1行サマリー
  if (getDisplayMode() === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    const typeTag = isCancelled ? "EEW取消" : info.isWarning ? "EEW警報" : "EEW予報";
    parts.push(typeTag);
    if (info.serial) parts.push(`#${info.serial}`);
    if (info.earthquake) parts.push(info.earthquake.hypocenterName);
    if (info.forecastIntensity?.areas.length) {
      const maxInt = info.forecastIntensity.areas.reduce((best, area) =>
        intensityToNumeric(area.intensity) > intensityToNumeric(best) ? area.intensity : best,
        info.forecastIntensity.areas[0].intensity
      );
      parts.push(`震度${maxInt}`);
    }
    if (info.earthquake?.magnitude && !info.isAssumedHypocenter) {
      parts.push(`M${info.earthquake.magnitude}`);
    }
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  const buf = createRenderBuffer();

  buf.pushEmpty();

  // バナー (警報/予報/取消のヘッダー)
  const bannerWidth = width;
  const serialTag = info.serial ? ` #${info.serial}` : "";
  const hypocenterTag = info.earthquake?.hypocenterName ? ` ${info.earthquake.hypocenterName}` : "";
  const colorIndex = context?.colorIndex ?? 0;

  if (isCancelled) {
    const bannerText = ` 緊急地震速報 取消${serialTag}${hypocenterTag}`;
    const cancelBanner = theme.getRoleChalk("eewCancelBanner");
    buf.push(cancelBanner(" ".repeat(bannerWidth)));
    buf.push(cancelBanner(visualPadEnd(bannerText, bannerWidth)));
    buf.push(cancelBanner(" ".repeat(bannerWidth)));
  } else {
    const bannerStyle = getEewBannerStyle(info.isWarning, colorIndex);
    const typeLbl = info.isWarning ? "警報" : "予報";
    const bannerText = ` 緊急地震速報（${typeLbl}）${serialTag}${hypocenterTag}`;
    const decorStyle = info.isAssumedHypocenter ? getPlumDecorStyle(info.isWarning) : bannerStyle;
    buf.push(decorStyle(" ".repeat(bannerWidth)));
    buf.push(bannerStyle(visualPadEnd(bannerText, bannerWidth)));
    buf.push(decorStyle(" ".repeat(bannerWidth)));
  }

  // フレーム開始 (テスト電文/PLUM法ラベルがある場合のみ先にframeTopを出す)
  const hasPreContent = info.isTest || info.maxIntChangeReason === 9;
  if (hasPreContent) {
    buf.push(frameTop(level, width));
  }

  // テスト電文
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // PLUM法ラベル (MaxIntChangeReason=9)
  if (info.maxIntChangeReason === 9) {
    buf.push(frameLine(level, theme.getRoleChalk("plumLabel")("PLUM法") + chalk.gray(" による予測震度変化"), width));
  }

  // カード1行目: infoType + 最重要項目
  const activeCount = context?.activeCount ?? 0;
  if (!isCancelled) {
    buf.push(hasPreContent ? frameDivider(level, width) : frameTop(level, width));
    const cardParts: string[] = [];

    // infoType (+ 同時発生注記)
    if (activeCount >= 2 && info.eventId) {
      cardParts.push(theme.getRoleChalk("concurrent")(`同時${activeCount}件発生中`) + chalk.gray(` ${info.infoType}`));
    } else {
      cardParts.push(chalk.gray(info.infoType));
    }

    if (info.forecastIntensity?.areas.length) {
      const areas = info.forecastIntensity.areas;
      const maxInt = areas.reduce((best, area) =>
        intensityToNumeric(area.intensity) > intensityToNumeric(best) ? area.intensity : best,
        areas[0].intensity
      );
      const ic = intensityColor(maxInt);
      let intLabel: string;
      if (diff?.previousMaxInt) {
        intLabel = chalk.white("最大予測震度 ") + chalk.gray(diff.previousMaxInt) + chalk.white(" → ") + ic.bold(maxInt);
      } else {
        intLabel = chalk.white("最大予測震度 ") + ic.bold(maxInt);
      }
      cardParts.push(intLabel);

      // 最大予測長周期地震動階級
      const maxLgInt = info.forecastIntensity.maxLgInt;
      if (maxLgInt && lgIntToNumeric(maxLgInt) >= 1) {
        const lc = lgIntensityColor(maxLgInt);
        cardParts.push(chalk.white("長周期階級 ") + lc.bold(maxLgInt));
      }
    }
    if (info.earthquake?.magnitude && !info.isAssumedHypocenter) {
      cardParts.push(colorMagnitude(info.earthquake.magnitude));
    }
    if (info.earthquake?.depth && !info.isAssumedHypocenter) {
      cardParts.push(chalk.white("深さ ") + chalk.white(info.earthquake.depth));
    }
    buf.pushCard(frameLine(level, cardParts.join(chalk.gray("  │  ")), width));
  } else {
    // 取消時はinfoTypeのみ
    if (!hasPreContent) {
      buf.push(frameTop(level, width));
    }
    if (activeCount >= 2 && info.eventId) {
      buf.push(frameLine(level,
        theme.getRoleChalk("concurrent")(`同時${activeCount}件発生中`) +
          chalk.gray(`  ${info.infoType}`),
        width
      ));
    } else {
      buf.push(frameLine(level,
        chalk.gray(info.infoType),
        width
      ));
    }
  }

  // ヘッドライン
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineWrapped = wrapFrameLines(level, chalk.bold.white(info.headline), width);
    for (let i = 0; i < headlineWrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(headlineWrapped[i]);
      } else {
        buf.push(headlineWrapped[i]);
      }
    }
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    buf.push(frameDivider(level, width));

    if (info.isAssumedHypocenter) {
      buf.push(frameLine(level, theme.getRoleChalk("plumLabel")("仮定震源要素") + chalk.gray(" (震源未確定・PLUM法による推定)"), width));
    }

    if (info.isAssumedHypocenter) {
      // 仮定震源要素: 震源・発生時刻・位置をグレーアウト
      buf.push(frameLine(level, chalk.gray("震源地: ") + chalk.gray(eq.hypocenterName), width));
      if (eq.originTime) {
        buf.push(frameLine(level, chalk.gray("発生: ") + chalk.gray(formatTimestamp(eq.originTime)), width));
      }
      if (eq.latitude && eq.longitude) {
        buf.push(frameLine(level, chalk.gray("位置: ") + chalk.gray(`${eq.latitude} ${eq.longitude}`), width));
      }
    } else {
      const hypoContent = diff?.hypocenterChange
        ? chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName) + theme.getRoleChalk("nextAdvisory")(" (変更)")
        : chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName);
      buf.push(frameLine(level, hypoContent, width));
      if (eq.originTime) {
        buf.push(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
      }
      if (eq.latitude && eq.longitude) {
        buf.push(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`), width));
      }
    }
    if (eq.magnitude && !info.isAssumedHypocenter) {
      let magLine: string;
      if (diff?.previousMagnitude) {
        magLine = chalk.white("規模: ") + chalk.gray(`M${diff.previousMagnitude}`) + chalk.white(" → ") + chalk.bold(colorMagnitude(eq.magnitude));
      } else {
        magLine = chalk.white("規模: ") + colorMagnitude(eq.magnitude);
      }
      buf.push(frameLine(level, magLine, width));
    }
    if (eq.depth && !info.isAssumedHypocenter) {
      let depthLine: string;
      if (diff?.previousDepth) {
        depthLine = chalk.white("深さ: ") + chalk.gray(diff.previousDepth) + chalk.white(" → ") + chalk.bold.white(eq.depth);
      } else {
        depthLine = chalk.white("深さ: ") + chalk.white(eq.depth);
      }
      buf.push(frameLine(level, depthLine, width));
    }
  }

  if (isCancelled) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, theme.getRoleChalk("cancelText")("この地震についての緊急地震速報は取り消されました。"), width));
    if (info.eventId) {
      buf.push(frameDivider(level, width));
      buf.push(frameLine(level, chalk.gray(`EventID: ${info.eventId}`), width));
    }
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);
    buf.push(frameBottom(level, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width);
    return;
  }

  // 予測震度一覧
  if (info.forecastIntensity && info.forecastIntensity.areas.length > 0) {
    buf.push(frameDivider(level, width));
    const maxObs = getMaxObservations();
    const allAreas = info.forecastIntensity.areas;
    const displayAreas = maxObs != null ? allAreas.slice(0, maxObs) : allAreas;
    const hiddenCount = allAreas.length - displayAreas.length;

    // 震度別にグループ化
    const byIntensity = new Map<string, GroupedListItem[]>();
    for (const area of displayAreas) {
      const key = area.intensity;
      if (!byIntensity.has(key)) byIntensity.set(key, []);
      const badges: string[] = [];
      if (area.isPlum) {
        badges.push(theme.getRoleChalk("plumLabel")(" [PLUM]"));
      }
      // [到達] は下部の専用セクションに集約するため、ここでは付与しない
      if (area.lgIntensity && lgIntToNumeric(area.lgIntensity) >= 1) {
        const lc = lgIntensityColor(area.lgIntensity);
        badges.push(lc(` [長周期${area.lgIntensity}]`));
      }
      byIntensity.get(key)!.push({
        primary: chalk.white(area.name),
        badges: badges.length > 0 ? badges : undefined,
      });
    }

    // 震度降順でソート
    const order = ["7", "6+", "6強", "6-", "6弱", "5+", "5強", "5-", "5弱", "4", "3", "2", "1"];
    const sortedEntries = [...byIntensity.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const groups: GroupedListGroup[] = sortedEntries.map(([int, items]) => ({
      prefix: intensityColor(int)(`震度${int}: `),
      items,
    }));

    renderGroupedItemList({ level, width, groups, buf });

    if (hiddenCount > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hiddenCount} 地点`), width));
    }
  }

  // 主要動到達と推測される地域
  if (info.forecastIntensity) {
    const arrivedAreas = info.forecastIntensity.areas.filter((a) => a.hasArrived);
    if (arrivedAreas.length > 0) {
      buf.push(frameDivider(level, width));
      buf.push(frameLine(level, theme.getRoleChalk("arrivedLabel")("既に主要動到達と推測:"), width));
      const names = arrivedAreas.map((a) => a.name).join("、");
      for (const line of wrapFrameLines(level, theme.getRoleChalk("arrivedLabel")(names), width)) {
        buf.push(line);
      }
    }
  }

  // 最終報
  if (info.nextAdvisory) {
    buf.push(frameDivider(level, width));
    for (const wl of wrapFrameLines(level, theme.getRoleChalk("nextAdvisory")(info.nextAdvisory), width)) {
      buf.push(wl);
    }
  }

  // EventID
  if (info.eventId) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.gray(`EventID: ${info.eventId}`), width));
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}

