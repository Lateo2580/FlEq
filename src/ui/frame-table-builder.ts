import chalk from "chalk";
import {
  renderFrameTable,
  wouldFrameTableOverflow,
  frameLine,
  frameLineColored,
  wrapFrameLines,
  wrapFrameLinesColored,
  visualWidth,
  type RenderBuffer,
  type FrameLevel,
} from "./formatter";

export interface FrameTableColumn {
  header: string;
  emptyPlaceholder?: string;
  minWidth?: number;
}

/**
 * borderColor (省略可): 罫線色の注入。指定時は colored プリミティブで描き、
 * 呼び出し元フレームの罫線色 (例: weather 系の WHITE_BORDER) と揃えて色割れを防ぐ。
 * **省略時の挙動は従来と完全に同一** (frameLine / wrapFrameLines の level 色)。
 *
 * indent (省略可、既定 0): テーブル全行の本文先頭に前置するスペース数。
 * セクション見出し (`▸`、2 スペース) 配下の本文 (4 スペース) と桁を揃え、
 * テーブルが見出しより左に飛び出すのを防ぐ。有効幅も indent 分減らす。
 * **省略時 (indent=0) の挙動は従来と完全に同一** (VPWP50 等の既存呼び出しに影響なし)。
 */
export function pushFrameTable(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  columns: FrameTableColumn[],
  rows: (string | null | undefined)[][],
  borderColor?: (s: string) => string,
  indent: number = 0,
): void {
  const placeholders = columns.map((c) => chalk.gray(c.emptyPlaceholder ?? "─"));
  const headers = columns.map((c) => c.header);
  const minTotal = columns.reduce(
    (sum, c) => sum + Math.max(c.minWidth ?? 4, visualWidth(c.header)),
    0,
  ) + (columns.length - 1) * 3;
  const innerWidth = width - 4 - indent;

  const normalized = rows.map((row) =>
    columns.map((_, i) => {
      const cell = row[i];
      return cell == null || cell === "" ? placeholders[i] : cell;
    }),
  );

  if (minTotal > innerWidth) {
    pushRowFallback(buf, level, width, columns, normalized, borderColor, indent);
    return;
  }

  // D2 の primitive clamp 後の出力幅ではなく、table 本文の実幅で判定する。
  // ここで fallback を選べなければ、セル本文が最終 clamp により失われてしまう。
  if (wouldFrameTableOverflow(headers, normalized, width, indent)) {
    pushRowFallback(buf, level, width, columns, normalized, borderColor, indent);
    return;
  }

  renderFrameTable(level, headers, normalized, width, buf, borderColor, indent);
}

function pushRowFallback(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  columns: FrameTableColumn[],
  normalized: string[][],
  borderColor?: (s: string) => string,
  indent: number = 0,
): void {
  // 従来の固定 2 スペース前置を indent に置き換える (二重付与しない)。
  // indent=0 では従来どおり 2 スペース、折返しインデントも pad+2 で相対関係を維持する。
  const pad = " ".repeat(Math.max(indent, 2));
  for (const row of normalized) {
    for (let i = 0; i < columns.length; i++) {
      const content = `${pad}${columns[i].header}: ${row[i]}`;
      const wrappedLines = borderColor
        ? wrapFrameLinesColored(level, borderColor, content, width, pad.length + 2)
        : wrapFrameLines(level, content, width, pad.length + 2);
      for (const wrapped of wrappedLines) {
        buf.push(wrapped);
      }
    }
    buf.push(
      borderColor
        ? frameLineColored(level, borderColor, "", width)
        : frameLine(level, "", width),
    );
  }
}
