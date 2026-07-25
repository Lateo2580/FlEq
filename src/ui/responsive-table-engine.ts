import chalk from "chalk";
import {
  FrameLevel,
  RenderBuffer,
  frameLine,
  frameDividerLabeled,
  clipToVisualWidth,
  visualPadEnd,
  visualWidth,
  stripAnsi,
  wrapFrameLines,
  wrapTextLines,
} from "./formatter";

// ── responsive-table-engine ──
// 津波実装 (Phase 1) から抽出したドメイン非依存の汎用機構 (spec §3)。
// 2 例目 = 地震で昇格条件が成立したため tsunami-formatter から移設。
// weather 系 (weather-core / VPWP50) は非互換点が多いため本 engine には寄せない。

// ── 3 段 breakpoint (weather 系と同値 120/160、型共有はせず値の一貫性をテストで担保) ──

export type ResponsiveDisplayMode = "ultra-narrow" | "standard" | "wide";

const STANDARD_THRESHOLD = 120;
const WIDE_THRESHOLD = 160;

export function decideDisplayMode(width: number): ResponsiveDisplayMode {
  if (width < STANDARD_THRESHOLD) return "ultra-narrow";
  if (width < WIDE_THRESHOLD) return "standard";
  return "wide";
}

// ── generic 列定義 + 自前 clip テーブル (幅保証) ──
// pushFrameTable は ClipReport を返さないため使わない。

export interface ColumnSpec<Row> {
  header: string;
  minWidth: number;
  maxWidth: number;
  cell: (row: Row) => string;
  /** clip + pad 後のセルに適用する着色 hook (clip 前に着色すると ANSI が壊れる) */
  colorize?: (row: Row, padded: string) => string;
  /** true の列は clip せず wrapTextLines で複数物理行に折り返す。全文表示のため ClipReport 非対象 (spec §2.1) */
  wrap?: boolean;
  /** true の列は直前 Row と同じ raw 値なら空白セルで描画する (rowspan 風間引き, spec §2.2)。
   * 並びがソート済みであることが前提 (formatter 側責務)。ClipReport には影響しない。 */
  mergeRepeated?: boolean;
}

/** 行 index → { 列ヘッダ名: true }。raw !== clipped のセルを記録する */
export type ResponsiveClipReport = Map<number, Partial<Record<string, boolean>>>;

/**
 * frameLine は overflow を clip しないため、渡す直前に最終 clamp する防御層。
 * ANSI 付き文字列を直接 clip すると色コードが壊れるので、幅超過を検知した行だけ
 * stripAnsi した生テキストへ fallback して clip する (visualWidth 保証を最優先)。
 */
export function clampFrameContent(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 4);
  return visualWidth(content) <= innerWidth
    ? content
    : clipToVisualWidth(stripAnsi(content), innerWidth);
}

export function pushClampedFrameLine(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  content: string,
): void {
  buf.push(frameLine(level, clampFrameContent(content, width), width));
}

/**
 * 列を minWidth から開始し残り幅を maxWidth まで分配、セル本文を clip して描画する。
 * 戻り値の ClipReport は clip 発生の検知信号 (今後も有用) であり、[詳細] 復元には使わない —
 * [詳細] は collectDetailForTable の hidden-only 回収 (幅で完全に隠れた列のみ) が担う (spec §2.4)。
 */
export function renderResponsiveTable<Row>(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  cols: ColumnSpec<Row>[],
  rows: Row[],
  opts: { omitHeader?: boolean } = {},
): ResponsiveClipReport {
  const innerWidth = width - 4;
  const sepWidth = (cols.length - 1) * 3;
  const contentWidth = Math.max(0, innerWidth - sepWidth);

  const widths = cols.map((c) => c.minWidth);
  let used = widths.reduce((a, b) => a + b, 0);
  let i = 0;
  let safety = 0;
  while (used < contentWidth && safety < 10000) {
    safety++;
    if (widths[i] < cols[i].maxWidth) {
      widths[i]++;
      used++;
    }
    i = (i + 1) % cols.length;
    if (widths.every((w, idx) => w === cols[idx].maxWidth)) break;
  }

  const colSep = chalk.gray(" │ ");
  if (opts.omitHeader !== true) {
    const headerCells = cols.map((c, idx) =>
      visualPadEnd(chalk.bold(clipToVisualWidth(c.header, widths[idx])), widths[idx]),
    );
    pushClampedFrameLine(buf, level, width, headerCells.join(colSep));
  }

  const report: ResponsiveClipReport = new Map();
  const prevRaw: (string | null)[] = cols.map(() => null);
  rows.forEach((row, rowIndex) => {
    const rowClip: Partial<Record<string, boolean>> = {};

    // 列ごとに物理行を先に算出する。wrap 列は wrapTextLines で複数行、
    // 非 wrap 列は従来どおり clip した 1 行。wrap 列は ClipReport に載せない。
    const perColLines: string[][] = cols.map((c, idx) => {
      const raw = c.cell(row);
      // rowspan 風間引き: 直前 Row と同値なら空白セル (clip/wrap 判定はスキップ)
      if (c.mergeRepeated && prevRaw[idx] != null && prevRaw[idx] === raw) {
        prevRaw[idx] = raw;
        return [""];
      }
      prevRaw[idx] = raw;
      if (c.wrap) {
        // 継続行 (2 物理行目以降) 先頭の半角スペース 1 個を除去する (カンマ折りの残り,
        // spec §9 R3-1)。wrapTextLines v2 は lossless (highlightAndWrap の span offset
        // 前提) のためスペースを保持したまま返す。除去は colorize が pad 済みセル全体に
        // 効き offset 追跡と無縁な engine 経路でだけ行う (Codex blocker #1 の分担)
        return wrapTextLines(raw, widths[idx]).map((l, li) =>
          li > 0 && l.startsWith(" ") ? l.slice(1) : l,
        );
      }
      const clipped = clipToVisualWidth(raw, widths[idx]);
      if (raw !== clipped) {
        rowClip[c.header] = true;
      }
      return [clipped];
    });

    if (Object.keys(rowClip).length > 0) {
      report.set(rowIndex, rowClip);
    }

    const physicalRows = Math.max(1, ...perColLines.map((lines) => lines.length));
    for (let pr = 0; pr < physicalRows; pr++) {
      const cells = cols.map((c, idx) => {
        const lines = perColLines[idx];
        // 継続行に該当行が無い列 (非 wrap / 行数不足) は空白 pad
        const text = pr < lines.length ? lines[pr] : "";
        const padded = visualPadEnd(text, widths[idx]);
        return c.colorize ? c.colorize(row, padded) : padded;
      });
      pushClampedFrameLine(buf, level, width, cells.join(colSep));
    }
  });
  return report;
}

// ── 詳細ブロック (clip 全文 + 隠し列 + 折りたたみ残件。行数ガード付き) ──

export interface DetailItem {
  head: string;
  body: string[];
}

export const DETAIL_MAX_PER_ENTRY = 8;
export const DETAIL_MAX_TOTAL = 60;

/** 各列の hidden 判定をして detail 行を収集する (hidden-only, spec §2.4)。
 * clip された列は「その幅では clip だが読める」ため回収しない。幅で完全に隠れた列のみ復元する。 */
export function collectDetailForTable<Row>(
  rows: Row[],
  head: (row: Row) => string,
  columns: { header: string; value: (row: Row) => string; hidden: boolean }[],
  details: DetailItem[],
): void {
  const hiddenColumns = columns.filter((col) => col.hidden);
  if (hiddenColumns.length === 0) return;
  rows.forEach((row) => {
    const body: string[] = [];
    for (const col of hiddenColumns) {
      const v = col.value(row);
      if (!v) continue;
      body.push(`    ${col.header}: ${v}`);
    }
    if (body.length > 0) {
      details.push({ head: head(row), body });
    }
  });
}

export function pushDetailBlock(buf: RenderBuffer, level: FrameLevel, width: number, details: DetailItem[]): void {
  if (details.length === 0) return;
  buf.push(frameDividerLabeled(level, "[詳細]", width));
  let lineCount = 0;
  for (let di = 0; di < details.length; di++) {
    const d = details[di];
    let body = d.body;
    if (body.length > DETAIL_MAX_PER_ENTRY) {
      const omitted = body.length - (DETAIL_MAX_PER_ENTRY - 1);
      body = [...body.slice(0, DETAIL_MAX_PER_ENTRY - 1), `    ... ほか ${omitted} 項目省略`];
    }
    const headWrapped = wrapFrameLines(level, chalk.white(d.head), width, 2);
    const bodyWrapped = body.flatMap((line) => wrapFrameLines(level, chalk.gray(line), width, 6));
    if (lineCount + headWrapped.length + bodyWrapped.length > DETAIL_MAX_TOTAL) {
      buf.push(frameDividerLabeled(level, `[詳細] (${details.length - di} entry 省略)`, width));
      return;
    }
    for (const l of headWrapped) { buf.push(l); lineCount++; }
    for (const l of bodyWrapped) { buf.push(l); lineCount++; }
  }
}
