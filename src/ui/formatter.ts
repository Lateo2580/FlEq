import chalk from "chalk";
import {
  DisplayMode,
  TruncationLimits,
  DEFAULT_CONFIG,
  WsDataMessage,
  type FrameLevel,
} from "../types";
import * as theme from "./theme";
import type { RoleName } from "./theme";

// ── フレーム幅キャッシュ ──

/** 現在のフレーム幅 (setFrameWidth で更新、getFrameWidth で参照) */
let cachedFrameWidth: number | null = null;

/** フレーム幅を外部から設定する (config 変更時に呼ぶ) */
export function setFrameWidth(width: number): void {
  cachedFrameWidth = width;
}

/** フレーム幅を自動モード (ターミナル幅追従) に戻す */
export function clearFrameWidth(): void {
  cachedFrameWidth = null;
}

/** infoFullText キャッシュ */
let cachedInfoFullText = false;

/** infoFullText を外部から設定する */
export function setInfoFullText(value: boolean): void {
  cachedInfoFullText = value;
}

/** infoFullText の現在値を返す */
export function getInfoFullText(): boolean {
  return cachedInfoFullText;
}

// ── 表示モードキャッシュ ──

/** 現在の表示モード */
let cachedDisplayMode: DisplayMode = "normal";

/** 表示モードを外部から設定する */
export function setDisplayMode(mode: DisplayMode): void {
  cachedDisplayMode = mode;
}

/** 表示モードの現在値を返す */
export function getDisplayMode(): DisplayMode {
  return cachedDisplayMode;
}

// ── 観測点折りたたみキャッシュ ──

/** 現在の観測点最大表示件数 */
let cachedMaxObservations: number | null = null;

/** 観測点最大表示件数を外部から設定する */
export function setMaxObservations(value: number | null): void {
  cachedMaxObservations = value;
}

/** 観測点最大表示件数の現在値を返す */
export function getMaxObservations(): number | null {
  return cachedMaxObservations;
}

// ── 省略上限キャッシュ ──

/** 現在の省略上限設定 */
let cachedTruncation: TruncationLimits = { ...DEFAULT_CONFIG.truncation };

/** 省略上限設定を外部から設定する */
export function setTruncation(value: TruncationLimits): void {
  cachedTruncation = value;
}

/** 省略上限設定の現在値を返す */
export function getTruncation(): TruncationLimits {
  return cachedTruncation;
}

// ── レンダーバッファ ──

/** recap 用のマーキング付き行 */
interface MarkedLine {
  text: string;
  kind: "normal" | "title" | "card" | "headline";
}

/** バッファリングインターフェース */
export interface RenderBuffer {
  push(line: string): void;
  pushEmpty(): void;
  pushTitle(line: string): void;
  pushCard(line: string): void;
  pushHeadline(line: string): void;
  readonly lineCount: number;
  readonly lines: readonly MarkedLine[];
  readonly titleLine: string | null;
  readonly cardLine: string | null;
  readonly headlineLines: readonly string[];
}

export function createRenderBuffer(): RenderBuffer {
  const _lines: MarkedLine[] = [];
  let _titleLine: string | null = null;
  let _cardLine: string | null = null;
  const _headlineLines: string[] = [];

  return {
    push(line: string) {
      _lines.push({ text: line, kind: "normal" });
    },
    pushEmpty() {
      _lines.push({ text: "", kind: "normal" });
    },
    pushTitle(line: string) {
      _lines.push({ text: line, kind: "title" });
      if (_titleLine == null) _titleLine = line;
    },
    pushCard(line: string) {
      _lines.push({ text: line, kind: "card" });
      if (_cardLine == null) _cardLine = line;
    },
    pushHeadline(line: string) {
      _lines.push({ text: line, kind: "headline" });
      _headlineLines.push(line);
    },
    get lineCount() { return _lines.length; },
    get lines() { return _lines; },
    get titleLine() { return _titleLine; },
    get cardLine() { return _cardLine; },
    get headlineLines() { return _headlineLines; },
  };
}

/** recap 予約行数 (フレーム下部 + 空行 + プロンプト行) */
const RECAP_RESERVE_ROWS = 3;

/**
 * バッファの内容を出力し、ターミナル高さを超える場合はフレーム下部直前に
 * サマリー (recap) を再掲する。
 */
export function flushWithRecap(buf: RenderBuffer, level: FrameLevel, width: number): void {
  const isTTY = process.stdout.isTTY;
  const rows = process.stdout.rows;

  // recap 判定: TTY かつ行数がターミナル高さを超える場合
  const needRecap = isTTY === true && typeof rows === "number" && rows > 0
    && buf.lineCount > rows - RECAP_RESERVE_ROWS;

  if (!needRecap) {
    // そのまま出力
    for (const line of buf.lines) {
      if (line.text === "") {
        console.log();
      } else {
        console.log(line.text);
      }
    }
    return;
  }

  // recap あり: 末尾2行 (frameBottom + 空行) の直前に挿入
  const allLines = [...buf.lines];

  // 末尾の空行と frameBottom を分離
  const tail: MarkedLine[] = [];
  while (allLines.length > 0) {
    const last = allLines[allLines.length - 1];
    if (last.text === "" || last.kind === "normal") {
      tail.unshift(allLines.pop()!);
      if (tail.length >= 2) break;
    } else {
      break;
    }
  }

  // 本体出力
  for (const line of allLines) {
    if (line.text === "") {
      console.log();
    } else {
      console.log(line.text);
    }
  }

  // recap セクション — 要約データがある場合のみ表示
  const hasRecapData = buf.titleLine != null || buf.cardLine != null || buf.headlineLines.length > 0;
  if (hasRecapData) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.gray("▼ サマリー"), width));
    if (buf.titleLine != null) {
      console.log(buf.titleLine);
    }
    if (buf.cardLine != null) {
      console.log(buf.cardLine);
    }
    // headline は1行目のみ
    if (buf.headlineLines.length > 0) {
      console.log(buf.headlineLines[0]);
    }
  }

  // tail 出力 (frameBottom + 空行)
  for (const line of tail) {
    if (line.text === "") {
      console.log();
    } else {
      console.log(line.text);
    }
  }
}

// ── フレーム描画ユーティリティ ──

// FrameLevel は src/types.ts で定義。後方互換のため re-export する。
export type { FrameLevel } from "../types";

/** フレーム文字セット (罫線のみ) */
interface FrameChars {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string; divL: string; divR: string;
}

export const FRAME_CHARS: Record<FrameLevel, FrameChars> = {
  critical: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", divL: "╠", divR: "╣" },
  warning:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", divL: "╠", divR: "╣" },
  normal:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", divL: "├", divR: "┤" },
  info:     { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", divL: "├", divR: "┤" },
  cancel:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", divL: "├", divR: "┤" },
};

/** フレームレベル → ロール名マッピング */
const FRAME_ROLE_MAP: Record<FrameLevel, RoleName> = {
  critical: "frameCritical",
  warning: "frameWarning",
  normal: "frameNormal",
  info: "frameInfo",
  cancel: "frameCancel",
};

/** フレームレベルに対応する色を返す (呼び出し時点の chalk.level を反映) */
export function frameColor(level: FrameLevel): chalk.Chalk {
  return theme.getRoleChalk(FRAME_ROLE_MAP[level]);
}

/** FRAMES 互換のアクセサ — 罫線文字 + 色 */
function getFrame(level: FrameLevel): FrameChars & { color: chalk.Chalk } {
  return { ...FRAME_CHARS[level], color: frameColor(level) };
}

/** フレームレベルのテキストラベル (アクセシビリティ: 色が見えない環境向け) */
export const SEVERITY_LABELS: Record<FrameLevel, string> = {
  critical: "[緊急]",
  warning:  "[警告]",
  normal:   "[情報]",
  info:     "[通知]",
  cancel:   "[取消]",
};

const FRAME_WIDTH = 60;

/** キャッシュ済みの tableWidth を返す。未設定ならターミナル幅に追従 (fallback: 60) */
export function getFrameWidth(): number {
  if (cachedFrameWidth != null) return cachedFrameWidth;
  const cols = process.stdout.columns;
  if (cols == null || cols < 40) return FRAME_WIDTH;
  return Math.min(cols, 200);
}

export function frameTop(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  return f.color(f.tl + f.h.repeat(width - 2) + f.tr);
}

export function frameLine(level: FrameLevel, content: string, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  // 生改行が混入すると罫線が崩れるため、空白に置換して防御
  const safeContent = (content.includes("\n") || content.includes("\r"))
    ? content.replace(/\r?\n/g, " ")
    : content;
  // ANSI エスケープを除去して可視幅を計算
  const visibleLen = visualWidth(safeContent);
  const pad = Math.max(0, width - 4 - visibleLen);
  return f.color(f.v) + " " + safeContent + " ".repeat(pad) + " " + f.color(f.v);
}

export function frameDivider(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  return f.color(f.divL + f.h.repeat(width - 2) + f.divR);
}

export function frameBottom(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  return f.color(f.bl + f.h.repeat(width - 2) + f.br);
}

/** ANSI / VT エスケープシーケンスを除去 (表示幅計算用 & インジェクション防止) */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** 外部由来の文字列から制御文字・ANSIエスケープを除去して安全にする */
function sanitizeForTerminal(str: string): string {
  // ANSIエスケープ除去後、残った制御文字(改行・タブ以外)を除去
  // eslint-disable-next-line no-control-regex
  return stripAnsi(str).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** コードポイントが CJK 等の全角文字かどうかを判定する */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK部首・記号
    (cp >= 0x3041 && cp <= 0x33BF) ||   // ひらがな・カタカナ・CJK互換
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK統合漢字拡張A
    (cp >= 0x4E00 && cp <= 0xA4CF) ||   // CJK統合漢字 + Yi
    (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK互換漢字
    (cp >= 0xFE30 && cp <= 0xFE4F) ||   // CJK互換形
    (cp >= 0xFF01 && cp <= 0xFF60) ||   // 全角ASCII・半角カタカナ
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // 全角記号
    (cp >= 0x20000 && cp <= 0x2FA1F)    // CJK統合漢字拡張B-F
  );
}

/** 文字列の視覚的な幅を計算（全角文字を2として数える） */
export function visualWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isWideChar(cp) ? 2 : 1;
  }
  return width;
}

/** 視覚幅を考慮してスペースでパディング（padEnd の全角対応版） */
export function visualPadEnd(str: string, targetWidth: number): string {
  const currentWidth = visualWidth(str);
  const padSize = Math.max(0, targetWidth - currentWidth);
  return str + " ".repeat(padSize);
}

/**
 * フレーム内にカラム区切りテーブルを描画する。
 * headers: ヘッダー文字列の配列 (スタイル適用前)
 * rows: 各行のセル配列 (chalk でスタイル適用済み)
 * 最後のカラムは残り幅を使い切る可変幅。
 */
export function renderFrameTable(
  level: FrameLevel,
  headers: string[],
  rows: string[][],
  width: number,
  buf?: RenderBuffer,
): void {
  const out = buf ? (line: string) => buf.push(line) : (line: string) => console.log(line);
  const innerWidth = width - 4;
  const numCols = headers.length;
  // 各カラムの最大視覚幅を計算
  const colWidths = headers.map((h, i) => {
    let maxW = visualWidth(h);
    for (const row of rows) {
      if (row[i] != null) {
        maxW = Math.max(maxW, visualWidth(row[i]));
      }
    }
    return maxW;
  });

  // セパレータ幅 " │ " = 3 文字 × (カラム数 - 1)
  const separatorWidth = (numCols - 1) * 3;
  const totalContent = colWidths.reduce((a, b) => a + b, 0) + separatorWidth;

  // 合計がフレーム内幅を超える場合、最後のカラムを縮小
  if (totalContent > innerWidth) {
    const shrink = totalContent - innerWidth;
    colWidths[numCols - 1] = Math.max(4, colWidths[numCols - 1] - shrink);
  }

  const colSep = chalk.gray(" │ ");
  const headerLine = headers
    .map((h, i) => visualPadEnd(chalk.bold(h), colWidths[i]))
    .join(colSep);
  out(frameLine(level, headerLine, width));

  // セパレータ行
  const sepParts = colWidths.map((w) => "─".repeat(w));
  out(frameLine(level, chalk.gray(sepParts.join("─┼─")), width));

  // データ行
  for (const row of rows) {
    const cells = row.map((cell, i) => visualPadEnd(cell ?? "", colWidths[i]));
    out(frameLine(level, cells.join(colSep), width));
  }
}

/**
 * コンテンツがフレーム幅を超える場合に折り返して複数の frameLine を生成する。
 * 改行文字で段落分割した上で、各段落を区切り文字ベースで折り返す。
 * カンマ+スペース / 日本語句読点(、。) / パイプ区切りを基準に折り返す。
 * 分割できない場合は文字単位でハード折り返しする。
 * 2行目以降は indent 分のスペースでインデントする。
 */
export function wrapFrameLines(
  level: FrameLevel,
  content: string,
  width: number,
  indent: number = 0
): string[] {
  // 改行で段落分割し、各段落を個別に折り返す
  const paragraphs = content.replace(/\r\n?/g, "\n").split("\n");
  if (paragraphs.length > 1) {
    const out: string[] = [];
    for (const p of paragraphs) {
      if (p === "" || p.trim() === "") {
        out.push(frameLine(level, "", width));
        continue;
      }
      out.push(...wrapSingleLine(level, p, width, indent));
    }
    return out;
  }

  return wrapSingleLine(level, content, width, indent);
}

/** 単一行（改行なし）の折り返し処理 */
function wrapSingleLine(
  level: FrameLevel,
  content: string,
  width: number,
  indent: number = 0
): string[] {
  const innerWidth = width - 4; // フレーム内の有効幅 (左右の罫線+スペース)
  if (visualWidth(content) <= innerWidth) {
    return [frameLine(level, content, width)];
  }

  // 複数の区切りパターンで分割を試行
  const delimiters = [", ", "、", "  │  "];
  let parts: string[] | null = null;
  let joinStr = "";

  for (const delim of delimiters) {
    const split = content.split(delim);
    if (split.length > 1) {
      parts = split;
      joinStr = delim;
      break;
    }
  }

  if (parts != null && parts.length > 1) {
    const lines: string[] = [];
    const indentStr = " ".repeat(indent);
    let currentLine = parts[0];

    for (let i = 1; i < parts.length; i++) {
      const candidate = currentLine + joinStr + parts[i];
      if (visualWidth(candidate) <= innerWidth) {
        currentLine = candidate;
      } else {
        // 末尾にカンマ区切りの場合はカンマを付与
        const suffix = joinStr === ", " ? "," : "";
        lines.push(frameLine(level, currentLine + suffix, width));
        currentLine = indentStr + parts[i];
      }
    }
    lines.push(frameLine(level, currentLine, width));
    return lines;
  }

  // 分割できない場合は文字単位でハード折り返し
  const wrapped = wrapTextLines(stripAnsi(content), innerWidth);
  if (wrapped.length <= 1) {
    return [frameLine(level, content, width)];
  }
  return wrapped.map((line) => frameLine(level, line, width));
}

/**
 * テキストを文字単位で折り返す。CJK文字は幅2として計算。
 * フレーム装飾は含まず、折り返し後の各行を文字列配列で返す。
 */
export function wrapTextLines(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  if (visualWidth(text) <= maxWidth) return [text];

  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const charWidth = isWideChar(cp) ? 2 : 1;

    if (currentWidth + charWidth > maxWidth) {
      lines.push(currentLine);
      currentLine = ch;
      currentWidth = charWidth;
    } else {
      currentLine += ch;
      currentWidth += charWidth;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

// ── グループ化項目リスト ──

export interface GroupedListItem {
  /** 地域名等のメインテキスト (chalk styled OK) */
  primary: string;
  /** " [PLUM]", " [長周期3]" 等のバッジ (chalk styled OK, 先頭スペースは呼び出し側が付与) */
  badges?: string[];
}

export interface GroupedListGroup {
  /** "震度5弱: " 等のプレフィックス (chalk styled OK) */
  prefix: string;
  /** グループ内の項目一覧 */
  items: GroupedListItem[];
}

/**
 * 震度別・階級別にグループ化された項目リストを描画する。
 * 各グループは `prefix + item, item, ...` 形式で、2行目以降は prefix 幅分のハンギングインデント。
 * badges は primary の直後に連結される（先頭スペースは呼び出し側で付与済み想定）。
 */
export function renderGroupedItemList(options: {
  level: FrameLevel;
  width: number;
  groups: GroupedListGroup[];
  buf?: Pick<RenderBuffer, "push">;
  itemSeparator?: string;
}): void {
  const { level, width, groups, itemSeparator = ", " } = options;
  const out = options.buf
    ? (line: string) => options.buf!.push(line)
    : (line: string) => console.log(line);

  for (const group of groups) {
    if (group.items.length === 0) continue;

    const prefix = group.prefix;
    const indentWidth = visualWidth(stripAnsi(prefix));

    // 各項目を "primary + badges" 形式の文字列に組み立て
    const itemTexts = group.items.map((item) => {
      let text = item.primary;
      if (item.badges != null && item.badges.length > 0) {
        text += item.badges.join("");
      }
      return text;
    });

    const content = prefix + itemTexts.join(itemSeparator);
    for (const line of wrapFrameLines(level, content, width, indentWidth)) {
      out(line);
    }
  }
}

/**
 * 単純な名前リストを描画する。
 * `label + name, name, ...` 形式。2行目以降は label 幅分のハンギングインデント。
 * label 指定時は ` label ` の形式（先頭・末尾にスペース）で gray 表示される。
 */
export function renderSimpleNameList(options: {
  level: FrameLevel;
  width: number;
  items: string[];
  label?: string;
  buf?: Pick<RenderBuffer, "push">;
  separator?: string;
}): void {
  const { level, width, items, label, separator = ", " } = options;
  if (items.length === 0) return;

  const out = options.buf
    ? (line: string) => options.buf!.push(line)
    : (line: string) => console.log(line);

  const prefix = label ? ` ${chalk.gray(label)} ` : "";
  const indentWidth = label ? visualWidth(stripAnsi(prefix)) : 0;
  const content = prefix + items.join(separator);
  for (const line of wrapFrameLines(level, content, width, indentWidth)) {
    out(line);
  }
}

// ── 本文キーワード強調 ──

/** 本文キーワード強調ルール */
export interface HighlightRule {
  /** マッチパターン（source + flags で保持し、都度 new RegExp する） */
  source: string;
  flags: string;
  /** 適用する chalk スタイル（テーマ再読込対応のため遅延評価） */
  style: () => chalk.Chalk;
}

/** マッチ済み区間 */
export interface HighlightSpan {
  start: number;
  end: number;
  style: chalk.Chalk;
}

/** 元の行からマッチspanを収集する */
export function collectHighlightSpans(line: string, rules: readonly HighlightRule[]): HighlightSpan[] {
  const spans: HighlightSpan[] = [];

  for (const rule of rules) {
    const flags = rule.flags.includes("g") ? rule.flags : rule.flags + "g";
    const regex = new RegExp(rule.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      // 文字列インデックスをchar配列インデックスに変換
      const startCharIdx = Array.from(line.slice(0, match.index)).length;
      const matchChars = Array.from(match[0]).length;
      const endCharIdx = startCharIdx + matchChars;

      // 既存spanと重複しない場合のみ追加（同一開始位置では長いマッチ優先）
      const overlapping = spans.find(s => startCharIdx < s.end && endCharIdx > s.start);
      if (!overlapping) {
        spans.push({ start: startCharIdx, end: endCharIdx, style: rule.style() });
      } else if (overlapping.start === startCharIdx && matchChars > (overlapping.end - overlapping.start)) {
        // 同一開始位置で長い方が勝つ
        overlapping.end = endCharIdx;
        overlapping.style = rule.style();
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** span付きの行を折り返し、各折り返し行にANSIを適用する */
export function highlightAndWrap(
  line: string, rules: readonly HighlightRule[], maxWidth: number
): string[] {
  const spans = collectHighlightSpans(line, rules);

  // spanがなければ従来通り（素通し）
  if (spans.length === 0) {
    return wrapTextLines(line, maxWidth);
  }

  // 平文で折り返し
  const wrappedLines = wrapTextLines(line, maxWidth);

  // 各折り返し行に対して、charオフセットを追跡しながらspanを適用
  let charOffset = 0;
  return wrappedLines.map((wrapped) => {
    const chars = Array.from(wrapped);
    const lineEnd = charOffset + chars.length;

    // この行にかかるspanを取得
    const relevantSpans = spans.filter(s => s.start < lineEnd && s.end > charOffset);

    if (relevantSpans.length === 0) {
      charOffset = lineEnd;
      return wrapped;
    }

    // spanに応じて部分ごとに色付け
    let result = "";
    let pos = charOffset;
    for (const span of relevantSpans) {
      const spanStart = Math.max(span.start, charOffset);
      const spanEnd = Math.min(span.end, lineEnd);
      if (pos < spanStart) {
        result += chars.slice(pos - charOffset, spanStart - charOffset).join("");
      }
      result += span.style(chars.slice(spanStart - charOffset, spanEnd - charOffset).join(""));
      pos = spanEnd;
    }
    if (pos < lineEnd) {
      result += chars.slice(pos - charOffset).join("");
    }

    charOffset = lineEnd;
    return result;
  });
}

// ── 時刻フォーマット ──

/** 絶対時刻を整形 ("YYYY-MM-DD HH:MM:SS") */
export function formatTimestamp(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}

/** 経過時間を "HH:MM:SS" 形式に整形 */
export function formatElapsedTime(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSec = Math.floor(safeMs / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** 区切り線 (後方互換用、新コードではフレーム関数を使用) */
function separator(char = "─", len = 60): string {
  return chalk.gray(char.repeat(len));
}

/** 震度に応じた色を返す (CUD対応) */
export function intensityColor(intensity: string): chalk.Chalk {
  const norm = intensity.replace(/\s+/g, "");
  switch (norm) {
    case "1":
      return theme.getRoleChalk("intensity1");
    case "2":
      return theme.getRoleChalk("intensity2");
    case "3":
      return theme.getRoleChalk("intensity3");
    case "4":
      return theme.getRoleChalk("intensity4");
    case "5-":
    case "5弱":
      return theme.getRoleChalk("intensity5Lower");
    case "5+":
    case "5強":
      return theme.getRoleChalk("intensity5Upper");
    case "6-":
    case "6弱":
      return theme.getRoleChalk("intensity6Lower");
    case "6+":
    case "6強":
      return theme.getRoleChalk("intensity6Upper");
    case "7":
      return theme.getRoleChalk("intensity7");
    default:
      return chalk.white;
  }
}

/** 長周期地震動階級に応じた色を返す (CUD対応) */
export function lgIntensityColor(lgInt: string): chalk.Chalk {
  switch (lgInt) {
    case "0":
      return theme.getRoleChalk("lgInt0");
    case "1":
      return theme.getRoleChalk("lgInt1");
    case "2":
      return theme.getRoleChalk("lgInt2");
    case "3":
      return theme.getRoleChalk("lgInt3");
    case "4":
      return theme.getRoleChalk("lgInt4");
    default:
      return chalk.white;
  }
}

// ── 共通ヘルパー (配信区分別フォーマッタから使用) ──

/** 長周期地震動階級の数値変換 (フレームレベル判定用) */
export function lgIntToNumeric(lgInt: string): number {
  const map: Record<string, number> = { "0": 0, "1": 1, "2": 2, "3": 3, "4": 4 };
  return map[lgInt] ?? -1;
}

/** 震度文字列から数値優先度を返す (フレームレベル判定用) */
export function intensityToNumeric(maxInt: string): number {
  const norm = maxInt.replace(/\s+/g, "");
  const map: Record<string, number> = {
    "1": 1, "2": 2, "3": 3, "4": 4,
    "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
    "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
  };
  return map[norm] ?? 0;
}

/** マグニチュードに色を付ける (CUD対応) */
export function colorMagnitude(magStr: string): string {
  const mag = parseFloat(magStr);
  const magColor =
    mag >= 7.0
      ? theme.getRoleChalk("magnitudeMax")
      : mag >= 5.0
        ? theme.getRoleChalk("magnitudeHigh")
        : mag >= 3.0
          ? theme.getRoleChalk("magnitudeLow")
          : chalk.white;
  return magColor(`M${magStr}`);
}

/** 共通フッター: type / reportDateTime / publishingOffice をテーブル最下段に表示 */
export function renderFooter(
  level: FrameLevel,
  type: string,
  reportDateTime: string,
  publishingOffice: string,
  width: number,
  buf?: RenderBuffer
): void {
  const out = buf ? (line: string) => buf.push(line) : (line: string) => console.log(line);
  out(frameDivider(level, width));
  out(frameLine(level,
    chalk.gray(`${type}  ${formatTimestamp(reportDateTime)}  ${publishingOffice}`),
    width
  ));
}

// ── フォールバック表示 ──

/** xmlReport の情報だけで簡易表示（パース失敗時のフォールバック） */
export function displayRawHeader(msg: WsDataMessage): void {
  console.log();
  console.log(separator());
  console.log(
    theme.getRoleChalk("rawHeaderLabel")(`電文受信: `) +
      chalk.white(sanitizeForTerminal(msg.xmlReport?.control?.title || msg.head.type)) +
      chalk.gray(` [${sanitizeForTerminal(msg.head.type)}]`)
  );
  if (msg.xmlReport) {
    const r = msg.xmlReport;
    console.log(chalk.gray(`   ${sanitizeForTerminal(r.head.title)}`));
    console.log(chalk.gray(`   ${sanitizeForTerminal(r.head.reportDateTime)}  ${sanitizeForTerminal(r.control.publishingOffice)}`));
    if (r.head.headline) {
      console.log(chalk.white(`   ${sanitizeForTerminal(r.head.headline)}`));
    }
  }
  console.log(separator());
}
