import chalk from "chalk";
import { ParsedLgObservationInfo, LgObservationArea } from "../types";
import * as theme from "./theme";
import { lgObservationFrameLevel } from "../engine/presentation/level-helpers";
import { typeLabel } from "./telegram-type-label";
import {
  FrameLevel,
  RenderBuffer,
  getFrameWidth,
  SEVERITY_LABELS,
  frameTop,
  frameLine,
  frameDivider,
  frameDividerLabeled,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  wrapFrameLines,
  formatTimestamp,
  intensityColor,
  lgIntensityColor,
  lgIntToNumeric,
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

// ── row 写像 (spec §3。階級は列にせず divider が保持 — Phase 3 period divider と同じ判断) ──

export interface LgAreaRow {
  areaName: string;
  maxLgInt: string;   // 長周期地震動階級 (divider・ソート用。表示順のため lgIntToNumeric)
  maxInt: string;     // 最大震度 (colorize)
}

/** 階級降順 → 名前順 (sort invariant の実体、spec §5) */
export function buildLgAreaRows(areas: LgObservationArea[]): LgAreaRow[] {
  return [...areas]
    .sort((a, b) =>
      (lgIntToNumeric(b.maxLgInt) - lgIntToNumeric(a.maxLgInt)) ||
      a.name.localeCompare(b.name, "ja"),
    )
    .map((a) => ({ areaName: a.name, maxLgInt: a.maxLgInt, maxInt: a.maxInt }));
}

// ── 列定義 (spec §3 Tier: 全 mode 2 列、wide は地域名 maxWidth 拡大) ──
// watch-point: ultra-narrow minWidth 20+8 + sep 3 = 31 <= 56 (幅 60 の innerWidth)

export function lgAreaColumns(mode: ResponsiveDisplayMode): ColumnSpec<LgAreaRow>[] {
  const areaCol: ColumnSpec<LgAreaRow> = {
    header: "地域名",
    minWidth: 20,
    maxWidth: mode === "wide" ? 160 : 100,
    cell: (r) => r.areaName,
    colorize: (_r, padded) => chalk.white(padded),
  };
  const intCol: ColumnSpec<LgAreaRow> = {
    header: "最大震度",
    minWidth: 8,
    maxWidth: 10,
    // 震度ラベルが NO_COLOR の行内表現を兼ねる (冗長性 ①)
    cell: (r) => `震度${r.maxInt}`,
    colorize: (r, padded) => intensityColor(r.maxInt)(padded),
  };
  return [areaCol, intCol];
}

/** 末尾件数サマリ (NO_COLOR 3 重冗長性 ③: 階級降順の階級別地域数) */
export function buildLgSummaryLine(areas: LgObservationArea[]): string {
  const byLgInt = new Map<string, number>();
  for (const a of areas) {
    byLgInt.set(a.maxLgInt, (byLgInt.get(a.maxLgInt) ?? 0) + 1);
  }
  const entries = [...byLgInt.entries()].sort(
    (a, b) => lgIntToNumeric(b[0]) - lgIntToNumeric(a[0]),
  );
  return entries
    .map(([lgInt, count]) => lgIntensityColor(lgInt)(`長周期${lgInt} ${count} 地域`))
    .join(chalk.gray(" ・ "));
}

// ── 本体 ──

/** 長周期地震動観測情報を整形して表示 (新デザイン言語。compact はサマリーライン経路の責務) */
export function displayLgObservationInfo(info: ParsedLgObservationInfo): void {
  const level = lgObservationFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();
  const mode = decideDisplayMode(width);
  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTop(level, width));

  // テスト電文バッジ (現行踏襲)
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行 (clamp 経由)
  const titleContent = chalk.bold(label) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));

  // ヘッドライン (wrap、現行踏襲)
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

  // カード行: 長周期階級 / 震度 / M / 深さ (欠損時は行ごと省略 — spec §2 特記事項。clamp 経由)
  const cardParts: string[] = [];
  if (info.maxLgInt) {
    const lc = lgIntensityColor(info.maxLgInt);
    cardParts.push(chalk.white("長周期階級 ") + lc.bold(info.maxLgInt));
  }
  if (info.maxInt) {
    const ic = intensityColor(info.maxInt);
    cardParts.push(chalk.white("最大震度 ") + ic.bold(info.maxInt));
  }
  if (info.earthquake?.magnitude) {
    cardParts.push(colorMagnitude(info.earthquake.magnitude));
  }
  if (info.earthquake?.depth) {
    cardParts.push(chalk.white("深さ ") + chalk.white(info.earthquake.depth));
  }
  if (cardParts.length > 0) {
    buf.push(frameDivider(level, width));
    buf.pushCard(frameLine(level, clampFrameContent(cardParts.join(chalk.gray("  │  ")), width), width));
  }

  // 震源詳細 (clamp 経由、欠損時は省略)
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
  }

  // 地域テーブル: 階級ごとに label 付き divider + 2 列テーブル (全 mode 共通、spec §3)。
  // 旧実装は共通ヘルパーによる折りたたみ表示だったが、新設計は名前必須 invariant
  // (省略カウント廃止) のため全件 row 化し、clip 分は LG 専用 detail で復元する
  if (info.areas.length > 0) {
    buf.push(frameDividerLabeled(level, "観測地域", width));
    const rows = buildLgAreaRows(info.areas);
    // 階級ごとの連続グループ (rows は階級降順ソート済み)
    const groups: { lgInt: string; rows: LgAreaRow[] }[] = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (last != null && last.lgInt === row.maxLgInt) {
        last.rows.push(row);
      } else {
        groups.push({ lgInt: row.maxLgInt, rows: [row] });
      }
    }
    for (const group of groups) {
      buf.push(frameDividerLabeled(level, `長周期${group.lgInt}`, width));
      // [詳細] 回収は廃止 (spec §2.4/§3.6): 地域名列は 1 エンティティ 1 値で読める。
      renderResponsiveTable(buf, level, width, lgAreaColumns(mode), group.rows);
    }
    buf.push(frameDividerLabeled(level, "サマリ", width));
    pushClampedFrameLine(buf, level, width, ` ${buildLgSummaryLine(info.areas)}`);
  }

  // コメント (wrap、現行踏襲)
  if (info.comment) {
    buf.push(frameDivider(level, width));
    const commentLines = info.comment.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of commentLines) {
      for (const wl of wrapFrameLines(level, chalk.gray(line.trimEnd()), width)) {
        buf.push(wl);
      }
    }
  }

  // 詳細URI (wrap、現行踏襲)
  if (info.detailUri) {
    buf.push(frameDivider(level, width));
    for (const wl of wrapFrameLines(level, theme.getRoleChalk("detailUri")(info.detailUri), width)) {
      buf.push(wl);
    }
  }

  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);
  buf.push(frameBottom(level, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width);
}
