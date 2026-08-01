import chalk from "chalk";
import { ParsedEarthquakeInfo, type JmaIntensity, type JmaLgIntensity, type SpecialValue } from "../types";
import * as theme from "./theme";
import { intensityToRank } from "../utils/intensity";
import { formatMagnitudeLabel, isNumericMagnitude } from "../utils/magnitude";
import {
  earthquakeFrameLevel,
  formatIntensitySpecialValue,
  formatLgIntensitySpecialValue,
} from "../engine/presentation/level-helpers";
import { typeLabel } from "./telegram-type-label";
import {
  wrapFrameLines,
  frameDividerLabeled,
  intensityColor,
  lgIntensityColor,
  lgIntToNumeric,
  getFrameWidth,
  SEVERITY_LABELS,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  formatTimestamp,
  colorMagnitude,
  renderFooter,
} from "./formatter";
import {
  ColumnSpec,
  ResponsiveDisplayMode,
  decideDisplayMode,
  renderResponsiveTable,
  clampFrameContent,
  pushClampedFrameLine,
} from "./responsive-table-engine";

// ── row 写像 (spec §4) ──
// バナー・外枠・タイトルの severity は earthquakeFrameLevel (level-helpers.ts:44) が唯一の入力。
// 行装飾は既存の intensityColor (震度階級→色) をそのまま使う。

export interface IntensityRow {
  intensity: string;      // "7" | "6強" | ... | "1"。未知値は raw のまま
  areaCount: number;      // 地域数
  areaNames: string;      // 全地域を `, ` 結合 (長周期バッジ含む)。wrap 列で全量表示 (spec §3.5)
  areas: { name: string; lgIntensity?: string }[];  // 生データ (行構築時の中間参照)
  colorIntensity?: string;
  specialValue?: boolean;
}

/** 長周期地震動階級バッジ付き地域名 (現行踏襲) */
function areaBadgeName(a: {
  name: string;
  lgIntensity?: string;
  lgIntensityValue?: SpecialValue<JmaLgIntensity>;
}): string {
  const label = formatLgIntensitySpecialValue(a.lgIntensityValue, a.lgIntensity);
  const hasDisplayValue = a.lgIntensityValue != null
    ? a.lgIntensityValue.presence !== "missing"
    : lgIntToNumeric(a.lgIntensity ?? "") >= 1;
  if (label != null && hasDisplayValue) {
    return `${a.name} [長周期${label}]`;
  }
  return a.name;
}

/**
 * フラット areas を震度階級で group-by し降順ソート。
 * 未知の震度文字列 (intensityToRank が 0) は先頭側 (見落とし防止、weather 系の未知 Code 昇格と同思想)。
 * 地域名は全件を `, ` 結合し wrap 列で全量表示する (spec §3.5、折りたたみ廃止)。
 */
export function buildIntensityRows(
  areas: {
    name: string;
    intensity: string;
    intensityValue?: SpecialValue<JmaIntensity>;
    lgIntensity?: string;
    lgIntensityValue?: SpecialValue<JmaLgIntensity>;
  }[],
): IntensityRow[] {
  const byIntensity = new Map<string, {
    areas: { name: string; lgIntensity?: string; lgIntensityValue?: SpecialValue<JmaLgIntensity> }[];
    colorIntensity: string;
    specialValue: boolean;
  }>();
  for (const area of areas) {
    // dmdata 電文には <MaxInt>4 </MaxInt> のように末尾空白が混入する個体がある
    // (実例: 32-35_01_03_240613_VXSE53.xml)。正規化しないと "4" と "4 " が
    // 別グループに割れ、かつ INTENSITY_ORDER.indexOf が -1 (未知) 扱いになり
    // 先頭 (震度7より上) に誤配置される。intensityToRank (utils/intensity.ts)
    // と同じ正規化をここでも適用する (formatter 側防御、parser は触らない)。
    const key = formatIntensitySpecialValue(area.intensityValue, area.intensity) ?? "—";
    const colorIntensity = area.intensityValue?.value
      ?? area.intensityValue?.upperBound
      ?? area.intensityValue?.lowerBound
      ?? area.intensity.replace(/\s+/g, "");
    if (!byIntensity.has(key)) {
      byIntensity.set(key, { areas: [], colorIntensity, specialValue: area.intensityValue != null });
    }
    byIntensity.get(key)!.areas.push({
      name: area.name,
      ...(area.lgIntensity != null ? { lgIntensity: area.lgIntensity } : {}),
      ...(area.lgIntensityValue != null ? { lgIntensityValue: area.lgIntensityValue } : {}),
    });
  }
  const entries = [...byIntensity.entries()].sort((a, b) => {
    const ai = intensityToRank(a[1].colorIntensity);
    const bi = intensityToRank(b[1].colorIntensity);
    if (ai === 0 && bi !== 0) return -1;
    if (bi === 0 && ai !== 0) return 1;
    return bi - ai;
  });
  return entries.map(([intensity, group]) => {
    const areaNames = group.areas.map(areaBadgeName).join(", ");
    return {
      intensity,
      areaCount: group.areas.length,
      areaNames,
      areas: group.areas,
      colorIntensity: group.colorIntensity,
      specialValue: group.specialValue,
    };
  });
}

// ── 列定義 (spec §5 Tier 割当) ──
// watch-point: ultra-narrow の minWidth 合計 6+20 + sep 3 = 29 <= 56 (幅 60 の innerWidth)

export function intensityColumns(mode: ResponsiveDisplayMode): ColumnSpec<IntensityRow>[] {
  const intCol: ColumnSpec<IntensityRow> = {
    header: "震度",
    minWidth: 6,
    maxWidth: 10,
    wrap: true,
    // 震度列が NO_COLOR の行内 prefix を兼ねる。未知値は ? 付き raw 表示
    cell: (r) => (r.specialValue === true || intensityToRank(r.intensity) > 0 ? `震度${r.intensity}` : `?${r.intensity}`),
    colorize: (r, padded) => intensityColor(r.colorIntensity ?? r.intensity).bold(padded),
  };
  const countCol: ColumnSpec<IntensityRow> = {
    header: "地域数",
    minWidth: 6,
    maxWidth: 8,
    cell: (r) => `${r.areaCount}`,
    colorize: (_r, padded) => chalk.gray(padded),
  };
  const namesCol: ColumnSpec<IntensityRow> = {
    header: "地域名",
    minWidth: 20,
    maxWidth: mode === "wide" ? 160 : 100,
    wrap: true,
    cell: (r) => r.areaNames,
    colorize: (_r, padded) => chalk.white(padded),
  };
  if (mode === "ultra-narrow") return [intCol, namesCol];
  return [intCol, countCol, namesCol];
}

// ── 津波短縮テキスト (旧 earthquake-formatter :83-90 から移設、ロジック同一) ──

/** 津波情報の短縮テキスト (カード行用) */
export function tsunamiShort(info: ParsedEarthquakeInfo): string {
  if (!info.tsunami) return "";
  const t = info.tsunami.text;
  if (t.includes("心配はありません") || t.includes("心配なし")) return theme.getRoleChalk("tsunamiNone")("津波なし");
  if (t.includes("注意")) return theme.getRoleChalk("tsunamiAdvisory")("津波注意");
  if (t.includes("警報")) return theme.getRoleChalk("tsunamiWarning")("津波警報");
  return chalk.white(t.length > 10 ? t.substring(0, 10) + "…" : t);
}

// ── 本体 ──

/** 地震情報を整形して表示 (新デザイン言語 v1。compact はサマリーライン経路の責務) */
export function displayEarthquakeInfo(info: ParsedEarthquakeInfo): void {
  const level = earthquakeFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();
  const mode = decideDisplayMode(width);
  const buf = createRenderBuffer();

  buf.pushEmpty();
  // フレーム前バナーは廃止 (spec §8 R2-2)。severity はフレーム色 + SEVERITY_LABELS で表現する
  buf.push(frameTop(level, width));

  // テスト電文バッジ (現行踏襲)
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行 (clamp 経由)
  const titleContent = chalk.bold(label) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));

  // ヘッドライン (折返し、現行踏襲)
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

  // カード行: 最大震度 / 長周期階級 / M / 深さ / 津波短縮 (clamp 経由)
  const cardParts: string[] = [];
  if (info.intensity) {
    const maxInt = formatIntensitySpecialValue(info.intensity.maxIntValue, info.intensity.maxInt);
    if (maxInt != null) {
      const colorValue = info.intensity.maxIntValue?.value
        ?? info.intensity.maxIntValue?.upperBound
        ?? info.intensity.maxIntValue?.lowerBound
        ?? info.intensity.maxInt;
      cardParts.push(chalk.white("最大震度 ") + intensityColor(colorValue).bold(maxInt));
    }
  }
  if (
    (info.intensity?.maxLgIntValue != null && info.intensity.maxLgIntValue.presence !== "missing")
    || (info.intensity?.maxLgInt && lgIntToNumeric(info.intensity.maxLgInt) >= 1)
  ) {
    const maxLgInt = formatLgIntensitySpecialValue(info.intensity?.maxLgIntValue, info.intensity?.maxLgInt);
    if (maxLgInt != null) {
      const colorValue = info.intensity?.maxLgIntValue?.value
        ?? info.intensity?.maxLgIntValue?.upperBound
        ?? info.intensity?.maxLgIntValue?.lowerBound
        ?? info.intensity?.maxLgInt
        ?? "";
      cardParts.push(chalk.white("長周期階級 ") + lgIntensityColor(colorValue).bold(maxLgInt));
    }
  }
  if (info.earthquake) {
    cardParts.push(
      isNumericMagnitude(info.earthquake.magnitude)
        ? colorMagnitude(info.earthquake.magnitude)
        : chalk.white(formatMagnitudeLabel(info.earthquake)),
    );
  }
  if (info.earthquake?.depth) {
    cardParts.push(chalk.white("深さ ") + chalk.white(info.earthquake.depth));
  }
  const tsunamiText = tsunamiShort(info);
  if (tsunamiText) {
    cardParts.push(tsunamiText);
  }
  if (cardParts.length > 0) {
    buf.push(frameDivider(level, width));
    buf.pushCard(frameLine(level, clampFrameContent(cardParts.join(chalk.gray("  │  ")), width), width));
  }

  // 震源詳細 (独立ブロック、clamp 経由) / VXSE51 調査中フォールバック (現行踏襲)
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
  } else if (info.type === "VXSE51") {
    buf.push(frameDivider(level, width));
    pushClampedFrameLine(buf, level, width, chalk.yellow("※ 震源についてはただいま調査中です"));
  }

  // 震度分布: 震度行テーブル (地域名は wrap 全表示)。末尾サマリは廃止 (spec §8 R2-2)
  if (info.intensity && info.intensity.areas.length > 0) {
    const rows = buildIntensityRows(info.intensity.areas);
    buf.push(frameDividerLabeled(level, "震度分布", width));
    // 地域名は wrap 列で全件表示 (spec §3.5)。折りたたみ・[詳細] 逃がしは廃止。
    renderResponsiveTable(buf, level, width, intensityColumns(mode), rows);
  }

  // 津波詳細テキスト (独立ブロック、現行踏襲)
  if (info.tsunami) {
    buf.push(frameDivider(level, width));
    for (const wl of wrapFrameLines(level, chalk.white(`${info.tsunami.text}`), width)) {
      buf.push(wl);
    }
  }

  // EventID (現行踏襲)
  if (info.eventId) {
    buf.push(frameDivider(level, width));
    pushClampedFrameLine(buf, level, width, chalk.gray(`EventID: ${info.eventId}`));
  }

  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);
  buf.push(frameBottom(level, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width);
}
