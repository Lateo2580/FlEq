import chalk from "chalk";
import { ParsedTsunamiInfo, TsunamiForecastItem, TsunamiObservationStation, TsunamiEstimationItem } from "../types";
import * as theme from "./theme";
import { tsunamiFrameLevel } from "../engine/presentation/level-helpers";
import { formatHypocenterMagnitude, isNumericMagnitude } from "../utils/magnitude";
import {
  FrameLevel,
  RenderBuffer,
  getFrameWidth,
  getMaxObservations,
  SEVERITY_LABELS,
  frameTop,
  frameLine,
  frameDivider,
  frameDividerLabeled,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  clipToVisualWidth,
  visualPadEnd,
  wrapFrameLines,
  formatTimestamp,
  colorMagnitude,
  renderFooter,
  reflowTelegramLines,
} from "./formatter";
import { typeLabel } from "./telegram-type-label";
import {
  ColumnSpec,
  ResponsiveDisplayMode,
  decideDisplayMode,
  clampFrameContent,
  pushClampedFrameLine,
  renderResponsiveTable,
  DetailItem,
  collectDetailForTable,
  pushDetailBlock,
} from "./responsive-table-engine";

// ── 表示用 severity 写像 (spec §4) ──
// バナー・外枠・タイトルの severity は tsunamiFrameLevel (level-helpers.ts) が唯一の入力。
// TsunamiSeverity は行装飾・ソート・件数サマリ専用に限定する。

export type TsunamiSeverity = "major" | "warning" | "advisory" | "forecast";

export interface TsunamiSeverityResult {
  severity: TsunamiSeverity;
  known: boolean;
}

/**
 * kind 文字列 → 表示用 severity。解除 (Kind Code 60) は最優先で判定する:
 * 後ろに置くと「津波注意報解除」が "津波注意報" に当たり解除分岐が到達不能になるため。
 * 未知 kind は raw 表示 + 最低 warning 昇格 (forecast への silent downgrade は採らない)。
 */
export function tsunamiSeverityOf(kind: string): TsunamiSeverityResult {
  if (kind.includes("解除")) return { severity: "forecast", known: true };
  if (kind.includes("大津波警報")) return { severity: "major", known: true };
  if (kind.includes("津波警報")) return { severity: "warning", known: true };
  if (kind.includes("津波注意報")) return { severity: "advisory", known: true };
  if (kind.includes("津波予報") || kind.includes("津波なし")) return { severity: "forecast", known: true };
  return { severity: "warning", known: false };
}

/** 行装飾用の色ロール解決 (severity 写像専用。バナー・枠には使わない) */
export function tsunamiSeverityChalk(severity: TsunamiSeverity): (s: string) => string {
  switch (severity) {
    case "major":
      return theme.getRoleChalk("tsunamiMajor");
    case "warning":
      return theme.getRoleChalk("tsunamiWarning");
    case "advisory":
      return theme.getRoleChalk("tsunamiAdvisory");
    case "forecast":
      return chalk.white;
  }
}

// ── 津波専用 helper (旧 earthquake-formatter から移設) ──

/** 津波電文のバナーラベルを forecast の kind から決定する */
export function tsunamiBannerLabel(info: ParsedTsunamiInfo): string {
  if (info.infoType === "取消" || !info.forecast || info.forecast.length === 0) {
    return typeLabel(info.type);
  }
  const kinds = info.forecast.map((f) => f.kind);
  const hasMajor = kinds.some((k) => k.includes("大津波警報"));
  const hasWarning = kinds.some((k) => k.includes("津波警報") && !k.includes("大津波警報"));
  const hasAdvisory = kinds.some((k) => k.includes("津波注意報"));
  const hasForecast = kinds.some((k) => k.includes("津波予報"));
  const parts: string[] = [];
  if (hasMajor) parts.push("大津波警報");
  if (hasWarning) parts.push("津波警報");
  if (hasAdvisory) parts.push("津波注意報");
  if (hasForecast) parts.push("津波予報");
  return parts.length > 0 ? parts.join("・") : typeLabel(info.type);
}

/** 津波種別の表示順 (現行維持) */
function tsunamiKindRank(kind: string): number {
  if (kind.includes("大津波警報")) return 0;
  if (kind.includes("津波警報")) return 1;
  if (kind.includes("津波注意報")) return 2;
  if (kind.includes("津波予報")) return 3;
  return 99;
}

/** 時刻文字列なら整形し、そうでなければそのまま返す */
function prettyTimeOrText(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return value;
  }
  return formatTimestamp(value);
}

// ── row 型と row 生成 (spec §4: テーブルごとの row 型) ──

export interface TsunamiForecastRow {
  severity: TsunamiSeverity;
  known: boolean;
  kind: string;
  areaName: string;
  maxHeightDescription: string;
  firstHeight: string;
}

export interface TsunamiTideStationRow {
  severity: TsunamiSeverity;
  areaName: string;
  stationName: string;
  arrivalTime: string;
  highTide: string;
}

export function buildTsunamiForecastRows(items: TsunamiForecastItem[]): TsunamiForecastRow[] {
  return [...items]
    .sort((a, b) => tsunamiKindRank(a.kind) - tsunamiKindRank(b.kind))
    .map((item) => {
      const { severity, known } = tsunamiSeverityOf(item.kind);
      return {
        severity,
        known,
        kind: item.kind,
        areaName: item.areaName,
        maxHeightDescription: item.maxHeightDescription,
        firstHeight: item.firstHeight,
      };
    });
}

export function buildTsunamiTideStationRows(items: TsunamiForecastItem[]): TsunamiTideStationRow[] {
  const sorted = [...items].sort((a, b) => tsunamiKindRank(a.kind) - tsunamiKindRank(b.kind));
  const rows: TsunamiTideStationRow[] = [];
  for (const item of sorted) {
    if (item.stations == null) continue;
    const { severity } = tsunamiSeverityOf(item.kind);
    for (const st of item.stations) {
      rows.push({
        severity,
        areaName: item.areaName,
        stationName: st.name,
        arrivalTime: st.arrivalTime,
        highTide: st.highTideDateTime,
      });
    }
  }
  return rows;
}

// ── 列定義 (spec §5 Tier 割当) ──

function forecastColumns(mode: ResponsiveDisplayMode): ColumnSpec<TsunamiForecastRow>[] {
  const kindCol: ColumnSpec<TsunamiForecastRow> = {
    header: "区分",
    minWidth: 8,
    maxWidth: 18,
    mergeRepeated: true,
    cell: (r) => (r.known ? r.kind : `?${r.kind}`),
    colorize: (r, padded) => tsunamiSeverityChalk(r.severity)(padded),
  };
  const areaCol: ColumnSpec<TsunamiForecastRow> = {
    header: "地域名", minWidth: 8, maxWidth: 20, cell: (r) => r.areaName,
    colorize: (_r, padded) => chalk.white(padded),
  };
  const heightCol: ColumnSpec<TsunamiForecastRow> = {
    header: "波高", minWidth: 6, maxWidth: 16,
    cell: (r) => r.maxHeightDescription || "―",
    colorize: (r, padded) => (r.maxHeightDescription ? chalk.white(padded) : chalk.gray(padded)),
  };
  const arrivalCol: ColumnSpec<TsunamiForecastRow> = {
    header: "到達予想", minWidth: 12, maxWidth: 30,
    cell: (r) => (r.firstHeight ? prettyTimeOrText(r.firstHeight) : "―"),
    colorize: (r, padded) => (r.firstHeight ? chalk.white(padded) : chalk.gray(padded)),
  };
  if (mode === "ultra-narrow") return [kindCol, areaCol, heightCol];
  return [kindCol, areaCol, heightCol, arrivalCol];
}

function tideStationColumns(mode: ResponsiveDisplayMode): ColumnSpec<TsunamiTideStationRow>[] {
  // 列順は 地域名 先頭 + mergeRepeated で同一地域の連続行を間引く (spec §3.3)。
  // rows は kind ランク順ソート済み (buildTsunamiTideStationRows) で地域が連続してまとまる。
  const areaCol: ColumnSpec<TsunamiTideStationRow> = {
    header: "地域名", minWidth: 8, maxWidth: 18, mergeRepeated: true, cell: (r) => r.areaName,
    colorize: (r, padded) => tsunamiSeverityChalk(r.severity)(padded),
  };
  const stationCol: ColumnSpec<TsunamiTideStationRow> = {
    header: "観測点", minWidth: 8, maxWidth: 18, cell: (r) => r.stationName,
    colorize: (_r, padded) => chalk.white(padded),
  };
  const arrivalCol: ColumnSpec<TsunamiTideStationRow> = {
    header: "到達予想", minWidth: 12, maxWidth: 30,
    cell: (r) => (r.arrivalTime ? prettyTimeOrText(r.arrivalTime) : "―"),
    colorize: (r, padded) => (r.arrivalTime ? chalk.white(padded) : chalk.gray(padded)),
  };
  const highTideCol: ColumnSpec<TsunamiTideStationRow> = {
    header: "満潮時刻", minWidth: 12, maxWidth: 30,
    cell: (r) => (r.highTide ? prettyTimeOrText(r.highTide) : "―"),
    colorize: (r, padded) => (r.highTide ? chalk.white(padded) : chalk.gray(padded)),
  };
  // ultra-narrow は満潮時刻を落とす (hidden-only [詳細] で回収)。
  if (mode === "ultra-narrow") return [areaCol, stationCol, arrivalCol];
  return [areaCol, stationCol, arrivalCol, highTideCol];
}

function formatObservedMaxHeight(row: TsunamiObservationStation): string {
  const value = row.maxHeightValue ?? "";
  const conditions = [row.maxHeightCondition, row.maxHeightValueCondition ?? ""]
    .map((condition) => condition.trim())
    .filter((condition, index, all) => condition !== "" && all.indexOf(condition) === index);
  if (value !== "") {
    return conditions.length > 0 ? `${value}（${conditions.join("・")}）` : value;
  }
  return conditions.join("・") || "―";
}

function observationColumns(mode: ResponsiveDisplayMode): ColumnSpec<TsunamiObservationStation>[] {
  const nameCol: ColumnSpec<TsunamiObservationStation> = {
    header: "観測点", minWidth: 8, maxWidth: 20, cell: (r) => r.name,
    colorize: (_r, padded) => chalk.white(padded),
  };
  const maxCol: ColumnSpec<TsunamiObservationStation> = {
    header: "最大波高", minWidth: 8, maxWidth: 24,
    cell: formatObservedMaxHeight,
    colorize: (r, padded) => (
      r.maxHeightValue || r.maxHeightCondition || r.maxHeightValueCondition
        ? chalk.white(padded)
        : chalk.gray(padded)
    ),
  };
  const initialCol: ColumnSpec<TsunamiObservationStation> = {
    header: "初動", minWidth: 6, maxWidth: 16,
    cell: (r) => r.initial || "―",
    colorize: (r, padded) => (r.initial ? chalk.white(padded) : chalk.gray(padded)),
  };
  const arrivalCol: ColumnSpec<TsunamiObservationStation> = {
    header: "到達時刻", minWidth: 12, maxWidth: 30,
    cell: (r) => (r.arrivalTime ? prettyTimeOrText(r.arrivalTime) : "―"),
    colorize: (r, padded) => (r.arrivalTime ? chalk.white(padded) : chalk.gray(padded)),
  };
  const sensorCol: ColumnSpec<TsunamiObservationStation> = {
    header: "センサー", minWidth: 8, maxWidth: 18,
    cell: (r) => r.sensor || "―",
    colorize: (r, padded) => (r.sensor ? chalk.white(padded) : chalk.gray(padded)),
  };
  if (mode === "ultra-narrow") return [nameCol, maxCol];
  // standard もセンサー列を表示 (spec §8 R2-1。wide と同一列順)
  return [nameCol, sensorCol, initialCol, maxCol, arrivalCol];
}

function estimationColumns(mode: ResponsiveDisplayMode): ColumnSpec<TsunamiEstimationItem>[] {
  const areaCol: ColumnSpec<TsunamiEstimationItem> = {
    header: "地域名", minWidth: 8, maxWidth: 20, cell: (r) => r.areaName,
    colorize: (_r, padded) => chalk.white(padded),
  };
  const heightCol: ColumnSpec<TsunamiEstimationItem> = {
    header: "波高", minWidth: 6, maxWidth: 16,
    cell: (r) => r.maxHeightDescription || "―",
    colorize: (r, padded) => (r.maxHeightDescription ? chalk.white(padded) : chalk.gray(padded)),
  };
  const arrivalCol: ColumnSpec<TsunamiEstimationItem> = {
    header: "到達予想", minWidth: 12, maxWidth: 30,
    cell: (r) => (r.firstHeight ? prettyTimeOrText(r.firstHeight) : "―"),
    colorize: (r, padded) => (r.firstHeight ? chalk.white(padded) : chalk.gray(padded)),
  };
  if (mode === "ultra-narrow") return [areaCol, heightCol];
  return [areaCol, heightCol, arrivalCol];
}

// ── バナー (weather 系 3 行構成 + maxWidth clip の踏襲。FrameLevel が唯一の入力) ──

function pushTsunamiBanner(buf: RenderBuffer, level: FrameLevel, label: string, width: number): void {
  const bannerText = clipToVisualWidth(` ${label}`, width);
  if (level === "critical") {
    const decorStyle = theme.getRoleChalk("tsunamiMajorBannerDecor");
    const majorStyle = theme.getRoleChalk("tsunamiMajorBanner");
    buf.push(decorStyle(" ".repeat(width)));
    buf.push(majorStyle(visualPadEnd(bannerText, width)));
    buf.push(decorStyle(" ".repeat(width)));
  } else if (level === "warning") {
    const warnStyle = theme.getRoleChalk("tsunamiWarningBanner");
    buf.push(warnStyle(" ".repeat(width)));
    buf.push(warnStyle(visualPadEnd(bannerText, width)));
    buf.push(warnStyle(" ".repeat(width)));
  } else if (level === "normal") {
    const advStyle = theme.getRoleChalk("tsunamiAdvisoryBanner");
    buf.push(advStyle(" ".repeat(width)));
    buf.push(advStyle(visualPadEnd(bannerText, width)));
    buf.push(advStyle(" ".repeat(width)));
  }
  // cancel / info はバナーなし (現行踏襲)
}

// ── 件数サマリ (NO_COLOR 3 重冗長性の 3 点目) ──

const SUMMARY_LABEL: Record<TsunamiSeverity, string> = {
  major: "大津波警報",
  warning: "津波警報",
  advisory: "津波注意報",
  forecast: "津波予報",
};

function buildSeveritySummary(rows: TsunamiForecastRow[]): string {
  const counts = new Map<TsunamiSeverity, number>();
  for (const r of rows) {
    counts.set(r.severity, (counts.get(r.severity) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const sev of ["major", "warning", "advisory", "forecast"] as const) {
    const n = counts.get(sev);
    if (n == null) continue;
    parts.push(tsunamiSeverityChalk(sev)(`${SUMMARY_LABEL[sev]} ${n} 区`));
  }
  return parts.join(chalk.gray(" ・ "));
}

// ── 本体 ──

/** 津波情報を整形して表示 (新デザイン言語 v1。compact はサマリーライン経路の責務) */
export function displayTsunamiInfo(info: ParsedTsunamiInfo): void {
  const level = tsunamiFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();
  const mode = decideDisplayMode(width);
  const buf = createRenderBuffer();
  const details: DetailItem[] = [];
  const maxObs = getMaxObservations();

  buf.pushEmpty();
  pushTsunamiBanner(buf, level, tsunamiBannerLabel(info), width);
  buf.push(frameTop(level, width));

  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  const titleContent = chalk.bold(label) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));

  // headline (現行踏襲: 折返し)
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineLines = reflowTelegramLines(
      info.headline.split(/\r?\n/).map((l) => l.trimEnd()),
    ).filter((l) => l.trim().length > 0);
    let firstHeadline = true;
    for (const hl of headlineLines) {
      for (const wrapped of wrapFrameLines(level, chalk.bold.white(hl), width)) {
        if (firstHeadline) {
          buf.pushHeadline(wrapped);
          firstHeadline = false;
        } else {
          buf.push(wrapped);
        }
      }
    }
  }

  // 震源情報 (現行踏襲: 独立ブロック)
  if (info.earthquake) {
    const eq = info.earthquake;
    buf.push(frameDivider(level, width));
    pushClampedFrameLine(buf, level, width, chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName));
    if (eq.originTime) {
      pushClampedFrameLine(buf, level, width, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)));
    }
    if (eq.latitude && eq.longitude) {
      pushClampedFrameLine(buf, level, width, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`));
    }
    pushClampedFrameLine(
      buf,
      level,
      width,
      chalk.white("規模: ") + (
        eq.magnitudeValue?.presence === "value" && eq.magnitudeValue.value != null
          ? colorMagnitude(eq.magnitudeValue.value.toFixed(1))
          : eq.magnitudeValue == null && isNumericMagnitude(eq.magnitude)
          ? colorMagnitude(eq.magnitude)
          : chalk.white(formatHypocenterMagnitude(eq))
      ),
    );
  }

  // ── forecast (予報区) ──
  let forecastRows: TsunamiForecastRow[] = [];
  if (info.forecast && info.forecast.length > 0) {
    forecastRows = buildTsunamiForecastRows(info.forecast);
    const shown = maxObs != null ? forecastRows.slice(0, maxObs) : forecastRows;
    const hidden = forecastRows.length - shown.length;
    buf.push(frameDividerLabeled(level, "予報区", width));
    renderResponsiveTable(buf, level, width, forecastColumns(mode), shown);
    collectDetailForTable(shown, (r) => `【予報区】${r.areaName}`, [
      { header: "区分", value: (r) => (r.known ? r.kind : `?${r.kind}`), hidden: false },
      { header: "地域名", value: (r) => r.areaName, hidden: false },
      { header: "波高", value: (r) => r.maxHeightDescription, hidden: false },
      { header: "到達予想", value: (r) => (r.firstHeight ? prettyTimeOrText(r.firstHeight) : ""), hidden: mode === "ultra-narrow" },
    ], details);
    if (hidden > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hidden} 地点 (詳細参照)`), width));
      details.push({
        head: `【予報区】表示上限で ${hidden} 件省略`,
        body: forecastRows.slice(shown.length).flatMap((r) => [
          `    ${r.known ? r.kind : `?${r.kind}`} ${r.areaName}`,
          `    波高: ${r.maxHeightDescription || "―"}`,
          `    到達予想: ${r.firstHeight ? prettyTimeOrText(r.firstHeight) : "―"}`,
        ]),
      });
    }
  }

  // ── tide-stations (満潮・到達予想。stations を持つ Item が 1 つでもあるときだけ) ──
  const tideRows = info.forecast ? buildTsunamiTideStationRows(info.forecast) : [];
  if (tideRows.length > 0) {
    const shown = maxObs != null ? tideRows.slice(0, maxObs) : tideRows;
    const hidden = tideRows.length - shown.length;
    buf.push(frameDividerLabeled(level, "満潮・到達予想", width));
    renderResponsiveTable(buf, level, width, tideStationColumns(mode), shown);
    collectDetailForTable(shown, (r) => `【満潮・到達予想】${r.stationName}`, [
      { header: "観測点", value: (r) => r.stationName, hidden: false },
      { header: "到達予想", value: (r) => (r.arrivalTime ? prettyTimeOrText(r.arrivalTime) : ""), hidden: false },
      { header: "満潮時刻", value: (r) => (r.highTide ? prettyTimeOrText(r.highTide) : ""), hidden: mode === "ultra-narrow" },
      { header: "地域名", value: (r) => r.areaName, hidden: false },
    ], details);
    if (hidden > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hidden} 観測点 (詳細参照)`), width));
      details.push({
        head: `【満潮・到達予想】表示上限で ${hidden} 件省略`,
        body: tideRows.slice(shown.length).flatMap((r) => [
          `    ${r.stationName} (${r.areaName})`,
          `    到達予想: ${r.arrivalTime ? prettyTimeOrText(r.arrivalTime) : "―"}`,
          `    満潮時刻: ${r.highTide ? prettyTimeOrText(r.highTide) : "―"}`,
        ]),
      });
    }
  }

  // ── observations (沖合観測) ──
  if (info.observations && info.observations.length > 0) {
    const shown = maxObs != null ? info.observations.slice(0, maxObs) : info.observations;
    const hidden = info.observations.length - shown.length;
    buf.push(frameDividerLabeled(level, "沖合観測", width));
    renderResponsiveTable(buf, level, width, observationColumns(mode), shown);
    collectDetailForTable(shown, (r) => `【沖合観測】${r.name}`, [
      { header: "観測点", value: (r) => r.name, hidden: false },
      { header: "センサー", value: (r) => r.sensor, hidden: mode === "ultra-narrow" },
      { header: "初動", value: (r) => r.initial, hidden: mode === "ultra-narrow" },
      { header: "最大波高", value: formatObservedMaxHeight, hidden: mode === "ultra-narrow" },
      { header: "到達時刻", value: (r) => (r.arrivalTime ? prettyTimeOrText(r.arrivalTime) : ""), hidden: mode === "ultra-narrow" },
    ], details);
    if (hidden > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hidden} 地点 (詳細参照)`), width));
      details.push({
        head: `【沖合観測】表示上限で ${hidden} 件省略`,
        body: info.observations.slice(shown.length).flatMap((r) => [
          `    ${r.name}`,
          `    最大波高: ${formatObservedMaxHeight(r)}`,
          `    到達時刻: ${r.arrivalTime ? prettyTimeOrText(r.arrivalTime) : "―"}`,
        ]),
      });
    }
  }

  // ── estimations (沿岸推定) ──
  if (info.estimations && info.estimations.length > 0) {
    const shown = maxObs != null ? info.estimations.slice(0, maxObs) : info.estimations;
    const hidden = info.estimations.length - shown.length;
    buf.push(frameDividerLabeled(level, "沿岸推定", width));
    renderResponsiveTable(buf, level, width, estimationColumns(mode), shown);
    collectDetailForTable(shown, (r) => `【沿岸推定】${r.areaName}`, [
      { header: "地域名", value: (r) => r.areaName, hidden: false },
      { header: "波高", value: (r) => r.maxHeightDescription, hidden: false },
      { header: "到達予想", value: (r) => (r.firstHeight ? prettyTimeOrText(r.firstHeight) : ""), hidden: mode === "ultra-narrow" },
    ], details);
    if (hidden > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hidden} 地点 (詳細参照)`), width));
      details.push({
        head: `【沿岸推定】表示上限で ${hidden} 件省略`,
        body: info.estimations.slice(shown.length).flatMap((r) => [
          `    ${r.areaName}`,
          `    波高: ${r.maxHeightDescription || "―"}`,
          `    到達予想: ${r.firstHeight ? prettyTimeOrText(r.firstHeight) : "―"}`,
        ]),
      });
    }
  }

  // 詳細ブロック
  pushDetailBlock(buf, level, width, details);

  // severity 件数サマリ (forecast があるときだけ)
  if (forecastRows.length > 0) {
    buf.push(frameDividerLabeled(level, "サマリ", width));
    pushClampedFrameLine(buf, level, width, buildSeveritySummary(forecastRows));
  }

  // warningComment (現行踏襲: 常時表示、detail に埋めない)
  if (info.warningComment) {
    buf.push(frameDivider(level, width));
    const warnStyle = theme.getRoleChalk("warningComment");
    const commentLines = reflowTelegramLines(
      info.warningComment.split(/\r?\n/).map((l) => l.trimEnd()),
    ).filter((l) => l.trim().length > 0);
    for (const line of commentLines) {
      for (const wrapped of wrapFrameLines(level, warnStyle(line), width)) {
        buf.push(wrapped);
      }
    }
  }

  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);
  buf.push(frameBottom(level, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width);
}
