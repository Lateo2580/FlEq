import chalk from "chalk";
import { EewAccuracy, ParsedEewInfo } from "../types";
import type { EewDiff } from "../engine/eew/eew-tracker";
import * as theme from "./theme";
import {
  FrameLevel,
  RenderBuffer,
  getFrameWidth,
  getMaxObservations,
  frameTop,
  frameLine,
  frameDivider,
  frameDividerLabeled,
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
  visualWidth,
  stripAnsi,
} from "./formatter";
import {
  ColumnSpec,
  ResponsiveDisplayMode,
  DetailItem,
  decideDisplayMode,
  renderResponsiveTable,
  clampFrameContent,
  pushClampedFrameLine,
} from "./responsive-table-engine";
import { eewPessimisticIntensity } from "../utils/intensity";

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

// ── 震源精度 rank → 表示ラベル (JMA 地震火山関連 XML 電文解説資料の Accuracy 定義。
//    パーサは数値を渡すだけ — 表示語彙は視覚レイヤーの責務 (spec 4.2)。Task 0 確定表に準拠。
//    震央/深さは rank7・8 で海域/内陸・観測網内/外が入れ替わるため別テーブル。
//    rank0「不明」は JMA コード表に存在しない (未設定は属性欠落 = null で表現) ──

const EEW_EPICENTER_RANK_LABELS: Record<number, string> = {
  1: "P波/S波レベル越え・IPF法(1点)・仮定震源要素",
  2: "IPF法(2点)",
  3: "IPF法(3点/4点)",
  4: "IPF法(5点以上)",
  5: "防災科研システム(4点以下)",
  6: "防災科研システム(5点以上)",
  7: "EPOS(海域・観測網内)",
  8: "EPOS(内陸・観測網外)",
};

const EEW_DEPTH_RANK_LABELS: Record<number, string> = {
  1: "P波/S波レベル越え・IPF法(1点)・仮定震源要素",
  2: "IPF法(2点)",
  3: "IPF法(3点/4点)",
  4: "IPF法(5点以上)",
  5: "防災科研システム(4点以下)",
  6: "防災科研システム(5点以上)",
  7: "EPOS(海域・観測網外)",
  8: "EPOS(内陸・観測網内)",
};

const EEW_MAGNITUDE_RANK_LABELS: Record<number, string> = {
  2: "防災科研システム",
  3: "全点P相",
  4: "P相/全相混在",
  5: "全点全相",
  6: "EPOS",
  8: "P波/S波レベル越え・仮定震源要素(M不定)",
};

/** rank → ラベル。未知 rank は「不明(N)」で fail-open (silent 欠落させない) */
export function eewAccuracyLabel(table: Record<number, string>, rank: number | null): string | null {
  if (rank == null) return null;
  return table[rank] ?? `不明(${rank})`;
}

/** 精度行 1 行分のテキスト (全要素 null なら null = 行省略) */
export function buildEewAccuracyLine(acc: EewAccuracy): string | null {
  const parts: string[] = [];
  const epi = eewAccuracyLabel(EEW_EPICENTER_RANK_LABELS, acc.epicenterRank);
  if (epi != null) parts.push(`震央 ${epi}`);
  const depth = eewAccuracyLabel(EEW_DEPTH_RANK_LABELS, acc.depthRank);
  if (depth != null) parts.push(`深さ ${depth}`);
  const mag = eewAccuracyLabel(EEW_MAGNITUDE_RANK_LABELS, acc.magnitudeRank);
  if (mag != null) {
    const count = acc.magnitudeCalcCount != null ? `(${acc.magnitudeCalcCount}点)` : "";
    parts.push(`M ${mag}${count}`);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

// ── 予測震度テーブル (spec 4.3) ──

export interface EewForecastRow {
  name: string;
  intensity: string;      // From (raw)
  intensityTo?: string;   // To (From≠To のときのみ)
  /** To 基準 (悲観側) の並び・divider 用キー */
  sortKey: string;
  lgIntensity?: string;
  isPlum?: boolean;
  hasArrived?: boolean;
  arrivalTime?: string;
}

const INTENSITY_DISPLAY: Record<string, string> = { "5-": "5弱", "5+": "5強", "6-": "6弱", "6+": "6強" };

/** XML 生値 ("5-") を人間可読 ("5弱") に。既に可読形・数値はそのまま */
export function formatEewIntensityLabel(value: string): string {
  return INTENSITY_DISPLAY[value] ?? value;
}

/** 範囲表記: From≠To は「4〜5弱」、To="over" は「4程度以上」(Task 0 確認の fail-safe) */
export function formatEewIntensityRange(row: { intensity: string; intensityTo?: string }): string {
  if (row.intensityTo == null) return formatEewIntensityLabel(row.intensity);
  if (row.intensityTo === "over") return `${formatEewIntensityLabel(row.intensity)}程度以上`;
  return `${formatEewIntensityLabel(row.intensity)}〜${formatEewIntensityLabel(row.intensityTo)}`;
}

/** ISO 時刻から HH:MM:SS を TZ 変換なしで抜き出す (電文は +09:00 固定) */
function formatArrivalClock(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : iso;
}

/** 状態列 badge (併記可・優先順): 到達済 / HH:MM:SS 到達予測 / PLUM (spec 4.3) */
export function eewStatusBadges(row: EewForecastRow): string[] {
  const badges: string[] = [];
  if (row.hasArrived) {
    badges.push("到達済");
  } else if (row.arrivalTime) {
    badges.push(`${formatArrivalClock(row.arrivalTime)} 到達予測`);
  }
  if (row.isPlum) badges.push("PLUM");
  return badges;
}

/** To 基準降順 → 名前順 (決定的ソート) */
export function buildEewForecastRows(
  areas: NonNullable<ParsedEewInfo["forecastIntensity"]>["areas"]
): EewForecastRow[] {
  return areas
    .map((a) => ({
      name: a.name,
      intensity: a.intensity,
      ...(a.intensityTo != null ? { intensityTo: a.intensityTo } : {}),
      sortKey: eewPessimisticIntensity(a.intensity, a.intensityTo),
      ...(a.lgIntensity != null ? { lgIntensity: a.lgIntensity } : {}),
      ...(a.isPlum ? { isPlum: a.isPlum } : {}),
      ...(a.hasArrived ? { hasArrived: a.hasArrived } : {}),
      ...(a.arrivalTime != null ? { arrivalTime: a.arrivalTime } : {}),
    }))
    .sort((a, b) =>
      (intensityToNumeric(b.sortKey) - intensityToNumeric(a.sortKey)) ||
      a.name.localeCompare(b.name, "ja"),
    );
}

/**
 * モード別列セット (engine は列を自動では落とさない — formatter 側で明示切替、spec 4.3)。
 * watch-point: renderResponsiveTable は minWidth を縮めず行全体 clamp に fallback するため、
 * ultra-narrow の minWidth 合計 + separator は幅 40 の内幅 36 以下に収めること
 * (震度 6 + 地域 14 + 状態 10 = 30、sep 3×2 = 6 → 計 36。unit test で固定)。
 */
export function eewForecastColumns(mode: ResponsiveDisplayMode, hasLg: boolean): ColumnSpec<EewForecastRow>[] {
  const narrow = mode === "ultra-narrow";
  const intCol: ColumnSpec<EewForecastRow> = {
    header: "震度",
    minWidth: narrow ? 6 : 10,
    maxWidth: 14,
    cell: (r) => formatEewIntensityRange(r),
    colorize: (r, padded) => intensityColor(r.sortKey)(padded),
  };
  const areaCol: ColumnSpec<EewForecastRow> = {
    header: "地域",
    minWidth: narrow ? 14 : 12,
    maxWidth: mode === "wide" ? 60 : 40,
    cell: (r) => r.name,
    colorize: (_r, padded) => chalk.white(padded),
  };
  const lgCol: ColumnSpec<EewForecastRow> = {
    header: "長周期",
    minWidth: 6,
    maxWidth: 8,
    cell: (r) => (r.lgIntensity != null && lgIntToNumeric(r.lgIntensity) >= 1 ? `階級${r.lgIntensity}` : "―"),
    colorize: (r, padded) =>
      r.lgIntensity != null && lgIntToNumeric(r.lgIntensity) >= 1
        ? lgIntensityColor(r.lgIntensity)(padded)
        : chalk.gray(padded),
  };
  const statusCol: ColumnSpec<EewForecastRow> = {
    header: "状態",
    minWidth: narrow ? 10 : 12,
    maxWidth: 26,
    cell: (r) => {
      const badges = eewStatusBadges(r);
      return badges.length > 0 ? badges.join(" ") : "―";
    },
    colorize: (r, padded) => {
      if (r.hasArrived) return theme.getRoleChalk("arrivedLabel")(padded);
      return eewStatusBadges(r).length > 0 ? chalk.white(padded) : chalk.gray(padded);
    },
  };
  if (narrow) return [intCol, areaCol, statusCol];
  return hasLg ? [intCol, areaCol, lgCol, statusCol] : [intCol, areaCol, statusCol];
}

// ── EEW 専用 詳細ブロック (generic DETAIL_MAX_TOTAL=60 は 90 地域級に不足 — spec 4.3。
//    Phase 4a LG_DETAIL_HARD_CAP=160 と同型の fail-closed) ──

/** 実測最大 fixture 43 地域 (77_01_26) / 全国 EEW 予報細分区域 ~190 (Task 0 実測で確定) */
export const EEW_DETAIL_HARD_CAP = 200;

export interface EewDetailCapResult {
  items: DetailItem[];
  omitted: number;
}

export function applyEewDetailCap(items: DetailItem[]): EewDetailCapResult {
  if (items.length <= EEW_DETAIL_HARD_CAP) return { items, omitted: 0 };
  return {
    items: items.slice(0, EEW_DETAIL_HARD_CAP),
    omitted: items.length - EEW_DETAIL_HARD_CAP,
  };
}

export function pushEewDetailBlock(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  items: DetailItem[],
): void {
  if (items.length === 0) return;
  const capped = applyEewDetailCap(items);
  buf.push(frameDividerLabeled(level, "[詳細]", width));
  for (const d of capped.items) {
    for (const l of wrapFrameLines(level, chalk.white(d.head), width, 2)) buf.push(l);
    for (const line of d.body) {
      for (const l of wrapFrameLines(level, chalk.gray(line), width, 6)) buf.push(l);
    }
  }
  if (capped.omitted > 0) {
    // fail-closed: 落ちる情報には必ず可視の打ち切り表示 (spec 4.3)
    buf.push(frameDividerLabeled(level, `[詳細] (… 他 ${capped.omitted} 地域省略)`, width));
  }
}

/**
 * 速報カード行を組む。幅不足時は priority の大きい部品から落とす
 * (生存優先度: 最大予測震度 > M > 深さ > 長周期 — spec 4.1。priority 0 は不落)。
 */
export function buildEewCardLine(parts: { text: string; priority: number }[], width: number): string {
  const sep = chalk.gray("  │  ");
  const active = [...parts];
  const joined = (): string => active.map((p) => p.text).join(sep);
  while (active.length > 1 && visualWidth(stripAnsi(joined())) > width - 4) {
    let dropIdx = -1;
    let dropPriority = 0;
    for (let i = 0; i < active.length; i++) {
      if (active[i].priority > dropPriority) {
        dropPriority = active[i].priority;
        dropIdx = i;
      }
    }
    if (dropIdx === -1) break; // 残りは全て不落部品 → 最終 clamp に委ねる
    active.splice(dropIdx, 1);
  }
  return joined();
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
  const mode = decideDisplayMode(width);

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
    const cardParts: { text: string; priority: number }[] = [];

    // infoType (+ 同時発生注記)
    if (activeCount >= 2 && info.eventId) {
      cardParts.push({ text: theme.getRoleChalk("concurrent")(`同時${activeCount}件発生中`) + chalk.gray(` ${info.infoType}`), priority: 0 });
    } else {
      cardParts.push({ text: chalk.gray(info.infoType), priority: 0 });
    }

    if (info.forecastIntensity?.areas.length) {
      const areas = info.forecastIntensity.areas;
      let maxInt = eewPessimisticIntensity(areas[0].intensity, areas[0].intensityTo);
      for (const area of areas) {
        const candidate = eewPessimisticIntensity(area.intensity, area.intensityTo);
        if (intensityToNumeric(candidate) > intensityToNumeric(maxInt)) maxInt = candidate;
      }
      const ic = intensityColor(maxInt);
      const maxLabel = formatEewIntensityLabel(maxInt);
      const intLabel = diff?.previousMaxInt
        ? chalk.white("最大予測震度 ") + chalk.gray(formatEewIntensityLabel(diff.previousMaxInt)) + chalk.white(" → ") + ic.bold(maxLabel)
        : chalk.white("最大予測震度 ") + ic.bold(maxLabel);
      cardParts.push({ text: intLabel, priority: 0 });

      // 最大予測長周期地震動階級
      const maxLgInt = info.forecastIntensity.maxLgInt;
      if (maxLgInt && lgIntToNumeric(maxLgInt) >= 1) {
        cardParts.push({ text: chalk.white("長周期階級 ") + lgIntensityColor(maxLgInt).bold(maxLgInt), priority: 3 });
      }
    }
    if (info.earthquake?.magnitude && !info.isAssumedHypocenter) {
      cardParts.push({ text: colorMagnitude(info.earthquake.magnitude), priority: 1 });
    }
    if (info.earthquake?.depth && !info.isAssumedHypocenter) {
      cardParts.push({ text: chalk.white("深さ ") + chalk.white(info.earthquake.depth), priority: 2 });
    }
    buf.pushCard(frameLine(level, clampFrameContent(buildEewCardLine(cardParts, width), width), width));
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

  // ヘッドライン (取消時は Body/Text の取消文と重複するため非表示 — spec 4.1)
  if (info.headline && !isCancelled) {
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
      pushClampedFrameLine(buf, level, width, theme.getRoleChalk("plumLabel")("仮定震源要素") + chalk.gray(" (震源未確定・PLUM法による推定)"));
    }

    const landOrSeaSuffix = info.landOrSea ? chalk.gray(`（${info.landOrSea}）`) : "";

    if (info.isAssumedHypocenter) {
      // 仮定震源要素: 震源・発生時刻・位置をグレーアウト
      pushClampedFrameLine(buf, level, width, chalk.gray("震源地: ") + chalk.gray(eq.hypocenterName) + landOrSeaSuffix);
      if (info.arrivalTime) {
        pushClampedFrameLine(buf, level, width, chalk.white("検知: ") + chalk.white(formatTimestamp(info.arrivalTime)));
      }
      if (eq.originTime) {
        pushClampedFrameLine(buf, level, width, chalk.gray("発生: ") + chalk.gray(formatTimestamp(eq.originTime)) + chalk.gray(" (仮定)"));
      }
      if (eq.latitude && eq.longitude) {
        pushClampedFrameLine(buf, level, width, chalk.gray("位置: ") + chalk.gray(`${eq.latitude} ${eq.longitude}`));
      }
    } else {
      const hypoContent = diff?.hypocenterChange
        ? chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName) + theme.getRoleChalk("nextAdvisory")(" (変更)") + landOrSeaSuffix
        : chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName) + landOrSeaSuffix;
      pushClampedFrameLine(buf, level, width, hypoContent);
      if (eq.originTime) {
        pushClampedFrameLine(buf, level, width, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)));
      }
      if (info.arrivalTime) {
        pushClampedFrameLine(buf, level, width, chalk.gray("検知: ") + chalk.gray(formatTimestamp(info.arrivalTime)));
      }
      if (eq.latitude && eq.longitude) {
        pushClampedFrameLine(buf, level, width, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`));
      }
    }
    if (eq.magnitude && !info.isAssumedHypocenter) {
      let magLine: string;
      if (diff?.previousMagnitude) {
        magLine = chalk.white("規模: ") + chalk.gray(`M${diff.previousMagnitude}`) + chalk.white(" → ") + chalk.bold(colorMagnitude(eq.magnitude));
      } else {
        magLine = chalk.white("規模: ") + colorMagnitude(eq.magnitude);
      }
      pushClampedFrameLine(buf, level, width, magLine);
    }
    if (eq.depth && !info.isAssumedHypocenter) {
      let depthLine: string;
      if (diff?.previousDepth) {
        depthLine = chalk.white("深さ: ") + chalk.gray(diff.previousDepth) + chalk.white(" → ") + chalk.bold.white(eq.depth);
      } else {
        depthLine = chalk.white("深さ: ") + chalk.white(eq.depth);
      }
      pushClampedFrameLine(buf, level, width, depthLine);
    }
    if (info.accuracy) {
      const accLine = buildEewAccuracyLine(info.accuracy);
      if (accLine != null) {
        pushClampedFrameLine(buf, level, width, chalk.gray("精度: ") + chalk.gray(accLine));
      }
    }
  }

  if (isCancelled) {
    buf.push(frameDivider(level, width));
    // cancelText (Body/Text 由来) 優先、無ければ固定文 fallback (spec 4.1)。長文は折返し
    const cancelMessage = info.cancelText ?? "この地震についての緊急地震速報は取り消されました。";
    for (const wl of wrapFrameLines(level, theme.getRoleChalk("cancelText")(cancelMessage), width)) {
      buf.push(wl);
    }
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

  // 予測震度テーブル (To 基準降順 + 一枚テーブル (階級 divider なし) + 状態列 badge。
  // 旧「主要動到達推測地域」独立セクションは状態列に吸収 — spec 4.3)
  if (info.forecastIntensity && info.forecastIntensity.areas.length > 0) {
    const maxObs = getMaxObservations();
    const allRows = buildEewForecastRows(info.forecastIntensity.areas);
    const shown = maxObs != null ? allRows.slice(0, maxObs) : allRows;
    const hiddenCount = allRows.length - shown.length;
    const hasLg = shown.some((r) => r.lgIntensity != null && lgIntToNumeric(r.lgIntensity) >= 1);
    const details: DetailItem[] = [];

    // 予測震度テーブルを一枚に統合 (spec §3.4)。階級ごとの divider・ヘッダ繰り返し・
    // 階級境の細線 divider は入れない (震度列が各行にあるので読める — レビュー指定)。
    // ultra-narrow の長周期列は [詳細] にも逃がさず省略する (spec §8 R2-4 —
    // 高さ削減優先、裁定の意図的な情報削減)。details は表示上限超過分専用。
    buf.push(frameDividerLabeled(level, "予測震度", width));
    renderResponsiveTable(buf, level, width, eewForecastColumns(mode, hasLg), shown);

    if (hiddenCount > 0) {
      buf.push(frameLine(level, chalk.gray(`… 他 ${hiddenCount} 地域 (詳細参照)`), width));
      // hidden 行も 1 地域 1 DetailItem (hard cap が entry 数に正しく効く +
      // 長周期・状態を含む全列を復元可能にする — fail-closed の実体)
      for (const r of allRows.slice(shown.length)) {
        const body: string[] = [
          `    震度: ${formatEewIntensityRange(r)}`,
          `    地域: ${r.name}`,
        ];
        if (r.lgIntensity != null && lgIntToNumeric(r.lgIntensity) >= 1) {
          body.push(`    長周期: 階級${r.lgIntensity}`);
        }
        const badges = eewStatusBadges(r);
        if (badges.length > 0) {
          body.push(`    状態: ${badges.join(" ")}`);
        }
        details.push({ head: `【震度${formatEewIntensityRange(r)}】${r.name} (表示上限で省略)`, body });
      }
    }
    pushEewDetailBlock(buf, level, width, details);
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

