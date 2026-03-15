import chalk from "chalk";
import {
  ParsedEarthquakeInfo,
  ParsedEewInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
  DisplayMode,
  WsDataMessage,
} from "../types";
import type { EewDiff } from "../engine/eew-tracker";
import * as log from "../logger";
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

// ── フレーム描画ユーティリティ ──

/** フレームの優先度レベル */
type FrameLevel = "critical" | "warning" | "normal" | "info" | "cancel";

/** フレーム文字セット (罫線のみ) */
interface FrameChars {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string; divL: string; divR: string;
}

const FRAME_CHARS: Record<FrameLevel, FrameChars> = {
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
function frameColor(level: FrameLevel): chalk.Chalk {
  return theme.getRoleChalk(FRAME_ROLE_MAP[level]);
}

/** FRAMES 互換のアクセサ — 罫線文字 + 色 */
function getFrame(level: FrameLevel): FrameChars & { color: chalk.Chalk } {
  return { ...FRAME_CHARS[level], color: frameColor(level) };
}

/** フレームレベルのテキストラベル (アクセシビリティ: 色が見えない環境向け) */
const SEVERITY_LABELS: Record<FrameLevel, string> = {
  critical: "[緊急]",
  warning:  "[警告]",
  normal:   "[情報]",
  info:     "[通知]",
  cancel:   "[取消]",
};

const FRAME_WIDTH = 60;

/** テーブル幅がこの値以上のとき、津波情報をカラム区切りテーブルで表示 */
const WIDE_TABLE_THRESHOLD = 80;

/** キャッシュ済みの tableWidth を返す。未設定ならターミナル幅に追従 (fallback: 60) */
function getFrameWidth(): number {
  if (cachedFrameWidth != null) return cachedFrameWidth;
  const cols = process.stdout.columns;
  if (cols == null || cols < 40) return FRAME_WIDTH;
  return Math.min(cols, 200);
}

function frameTop(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  return f.color(f.tl + f.h.repeat(width - 2) + f.tr);
}

function frameLine(level: FrameLevel, content: string, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  // ANSI エスケープを除去して可視幅を計算
  const visibleLen = visualWidth(content);
  const pad = Math.max(0, width - 4 - visibleLen);
  return f.color(f.v) + " " + content + " ".repeat(pad) + " " + f.color(f.v);
}

function frameDivider(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  return f.color(f.divL + f.h.repeat(width - 2) + f.divR);
}

function frameBottom(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = getFrame(level);
  return f.color(f.bl + f.h.repeat(width - 2) + f.br);
}

/** ANSI / VT エスケープシーケンスを除去 (表示幅計算用 & インジェクション防止) */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** 外部由来の文字列から制御文字・ANSIエスケープを除去して安全にする */
function sanitizeForTerminal(str: string): string {
  // ANSIエスケープ除去後、残った制御文字(改行・タブ以外)を除去
  // eslint-disable-next-line no-control-regex
  return stripAnsi(str).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** 文字列の視覚的な幅を計算（全角文字を2として数える） */
export function visualWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK統合漢字、ひらがな、カタカナ、全角記号、全角括弧等
    if (
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
    ) {
      width += 2;
    } else {
      width += 1;
    }
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
function renderFrameTable(
  level: FrameLevel,
  headers: string[],
  rows: string[][],
  width: number,
): void {
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
  console.log(frameLine(level, headerLine, width));

  // セパレータ行
  const sepParts = colWidths.map((w) => "─".repeat(w));
  console.log(frameLine(level, chalk.gray(sepParts.join("─┼─")), width));

  // データ行
  for (const row of rows) {
    const cells = row.map((cell, i) => visualPadEnd(cell ?? "", colWidths[i]));
    console.log(frameLine(level, cells.join(colSep), width));
  }
}

/**
 * コンテンツがフレーム幅を超える場合に折り返して複数の frameLine を生成する。
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
    let charWidth = 1;
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3041 && cp <= 0x33BF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FA1F)
    ) {
      charWidth = 2;
    }

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

/** 長周期地震動階級の数値変換 (フレームレベル判定用) */
function lgIntToNumeric(lgInt: string): number {
  const map: Record<string, number> = { "0": 0, "1": 1, "2": 2, "3": 3, "4": 4 };
  return map[lgInt] ?? -1;
}

/** 電文タイプの日本語名 */
function typeLabel(type: string): string {
  const map: Record<string, string> = {
    VXSE51: "震度速報",
    VXSE52: "震源に関する情報",
    VXSE53: "震源・震度に関する情報",
    VXSE56: "地震の活動状況等に関する情報",
    VXSE60: "地震回数に関する情報",
    VXSE61: "顕著な地震の震源要素更新のお知らせ",
    VTSE41: "津波警報・注意報・予報",
    VTSE51: "津波情報",
    VTSE52: "沖合の津波情報",
    VXSE43: "緊急地震速報（警報）",
    VXSE44: "緊急地震速報（予報）",
    VXSE45: "緊急地震速報（地震動予報）",
    VXSE62: "長周期地震動に関する観測情報",
    VZSE40: "地震・津波に関するお知らせ",
    VYSE50: "南海トラフ地震臨時情報",
    VYSE51: "南海トラフ地震関連解説情報（臨時）",
    VYSE52: "南海トラフ地震関連解説情報（定例）",
    VYSE60: "北海道・三陸沖後発地震注意情報",
  };
  return map[type] || type;
}

/** 震度文字列から数値優先度を返す (フレームレベル判定用) */
function intensityToNumeric(maxInt: string): number {
  const norm = maxInt.replace(/\s+/g, "");
  const map: Record<string, number> = {
    "1": 1, "2": 2, "3": 3, "4": 4,
    "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
    "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
  };
  return map[norm] ?? 0;
}

/** 地震情報のフレームレベルを決定 */
function earthquakeFrameLevel(info: ParsedEarthquakeInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.intensity) {
    const num = intensityToNumeric(info.intensity.maxInt);
    if (num >= 7) return "critical";  // 6弱以上
    if (num >= 4) return "warning";   // 4以上
  }
  return "normal";
}

/** マグニチュードに色を付ける (CUD対応) */
function colorMagnitude(magStr: string): string {
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

/** 津波情報の短縮テキスト */
function tsunamiShort(info: ParsedEarthquakeInfo): string {
  if (!info.tsunami) return "";
  const t = info.tsunami.text;
  if (t.includes("心配はありません") || t.includes("心配なし")) return theme.getRoleChalk("tsunamiNone")("津波なし");
  if (t.includes("注意")) return theme.getRoleChalk("tsunamiAdvisory")("津波注意");
  if (t.includes("警報")) return theme.getRoleChalk("tsunamiWarning")("津波警報");
  return chalk.white(t.length > 10 ? t.substring(0, 10) + "…" : t);
}

/** 共通フッター: type / reportDateTime / publishingOffice をテーブル最下段に表示 */
function renderFooter(
  level: FrameLevel,
  type: string,
  reportDateTime: string,
  publishingOffice: string,
  width: number
): void {
  console.log(frameDivider(level, width));
  console.log(frameLine(level,
    chalk.gray(`${type}  ${formatTimestamp(reportDateTime)}  ${publishingOffice}`),
    width
  ));
}

/** 地震情報を整形して表示 */
export function displayEarthquakeInfo(info: ParsedEarthquakeInfo): void {
  const level = earthquakeFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード: 1行サマリー
  if (cachedDisplayMode === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.earthquake) {
      parts.push(info.earthquake.hypocenterName);
      parts.push(`M${info.earthquake.magnitude}`);
    }
    if (info.intensity) parts.push(`震度${info.intensity.maxInt}`);
    const ts = tsunamiShort(info);
    if (ts) parts.push(stripAnsi(ts));
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  console.log();
  console.log(frameTop(level, width));

  // テスト電文
  if (info.isTest) {
    console.log(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行 (severity ラベル付き)
  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  console.log(frameLine(level, titleContent, width));

  // ヘッドライン
  if (info.headline) {
    console.log(frameDivider(level, width));
    for (const line of wrapFrameLines(level, chalk.bold.white(info.headline), width)) {
      console.log(line);
    }
  }

  // カード1行目: 最重要項目
  console.log(frameDivider(level, width));
  const cardParts: string[] = [];
  if (info.intensity) {
    const ic = intensityColor(info.intensity.maxInt);
    cardParts.push(chalk.white("最大震度 ") + ic.bold(info.intensity.maxInt));
  }
  if (info.intensity?.maxLgInt && lgIntToNumeric(info.intensity.maxLgInt) >= 1) {
    const lc = lgIntensityColor(info.intensity.maxLgInt);
    cardParts.push(chalk.white("長周期階級 ") + lc.bold(info.intensity.maxLgInt));
  }
  if (info.earthquake?.magnitude) {
    cardParts.push(colorMagnitude(info.earthquake.magnitude));
  }
  if (info.earthquake?.depth) {
    cardParts.push(chalk.white("深さ ") + chalk.white(info.earthquake.depth));
  }
  const tsunamiText = tsunamiShort(info);
  if (tsunamiText) {
    cardParts.push(tsunamiText);
  }
  if (cardParts.length > 0) {
    console.log(frameLine(level, cardParts.join(chalk.gray("  │  ")), width));
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName), width));
    if (eq.originTime) {
      console.log(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
    }
    if (eq.latitude && eq.longitude) {
      console.log(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`), width));
    }
  }

  // 震度一覧
  if (info.intensity && info.intensity.areas.length > 0) {
    console.log(frameDivider(level, width));

    // 震度×地域名 → エリアデータの Map を事前構築 (O(n) ルックアップ用)
    const areaDataMap = new Map<string, typeof info.intensity.areas[0]>();
    const byIntensity = new Map<string, string[]>();
    for (const area of info.intensity.areas) {
      const key = area.intensity;
      if (!byIntensity.has(key)) byIntensity.set(key, []);
      byIntensity.get(key)!.push(area.name);
      areaDataMap.set(`${key}:${area.name}`, area);
    }

    const order = ["7", "6+", "6強", "6-", "6弱", "5+", "5強", "5-", "5弱", "4", "3", "2", "1"];
    const sorted = [...byIntensity.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const [int, names] of sorted) {
      const color = intensityColor(int);
      // 長周期地震動階級付きの地域名を生成
      const areaTexts = names.map((name) => {
        const areaData = areaDataMap.get(`${int}:${name}`);
        if (areaData?.lgIntensity && lgIntToNumeric(areaData.lgIntensity) >= 1) {
          const lc = lgIntensityColor(areaData.lgIntensity);
          return chalk.white(name) + lc(` [長周期${areaData.lgIntensity}]`);
        }
        return chalk.white(name);
      });
      const prefix = color(`震度${int}: `);
      const indentWidth = visualWidth(stripAnsi(prefix));
      const content = prefix + areaTexts.join(chalk.white(", "));
      for (const line of wrapFrameLines(level, content, width, indentWidth)) {
        console.log(line);
      }
    }
  }

  // 津波 (詳細)
  if (info.tsunami) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.white(`${info.tsunami.text}`), width));
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width);

  console.log(frameBottom(level, width));
  console.log();
}

/** EEW 表示時のコンテキスト情報 */
export interface EewDisplayContext {
  /** 現在アクティブなイベント数 */
  activeCount: number;
  /** 前回との差分情報 */
  diff?: EewDiff;
  /** バナー色分け用のカラーインデックス (0始まり) */
  colorIndex?: number;
}

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
function eewFrameLevel(info: ParsedEewInfo): FrameLevel {
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
  if (cachedDisplayMode === "compact") {
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

  console.log();

  // バナー (警報/予報/取消のヘッダー)
  const bannerWidth = width;
  const serialTag = info.serial ? ` #${info.serial}` : "";
  const hypocenterTag = info.earthquake?.hypocenterName ? ` ${info.earthquake.hypocenterName}` : "";
  const colorIndex = context?.colorIndex ?? 0;

  if (isCancelled) {
    const bannerText = ` 緊急地震速報 取消${serialTag}${hypocenterTag}`;
    const cancelBanner = theme.getRoleChalk("eewCancelBanner");
    console.log(cancelBanner(" ".repeat(bannerWidth)));
    console.log(cancelBanner(visualPadEnd(bannerText, bannerWidth)));
    console.log(cancelBanner(" ".repeat(bannerWidth)));
  } else {
    const bannerStyle = getEewBannerStyle(info.isWarning, colorIndex);
    const typeLabel = info.isWarning ? "警報" : "予報";
    const bannerText = ` 緊急地震速報（${typeLabel}）${serialTag}${hypocenterTag}`;
    const decorStyle = info.isAssumedHypocenter ? getPlumDecorStyle(info.isWarning) : bannerStyle;
    console.log(decorStyle(" ".repeat(bannerWidth)));
    console.log(bannerStyle(visualPadEnd(bannerText, bannerWidth)));
    console.log(decorStyle(" ".repeat(bannerWidth)));
  }

  // フレーム開始 (テスト電文/PLUM法ラベルがある場合のみ先にframeTopを出す)
  const hasPreContent = info.isTest || info.maxIntChangeReason === 9;
  if (hasPreContent) {
    console.log(frameTop(level, width));
  }

  // テスト電文
  if (info.isTest) {
    console.log(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // PLUM法ラベル (MaxIntChangeReason=9)
  if (info.maxIntChangeReason === 9) {
    console.log(frameLine(level, theme.getRoleChalk("plumLabel")("PLUM法") + chalk.gray(" による予測震度変化"), width));
  }

  // カード1行目: infoType + 最重要項目
  const activeCount = context?.activeCount ?? 0;
  if (!isCancelled) {
    console.log(hasPreContent ? frameDivider(level, width) : frameTop(level, width));
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
    console.log(frameLine(level, cardParts.join(chalk.gray("  │  ")), width));
  } else {
    // 取消時はinfoTypeのみ
    if (!hasPreContent) {
      console.log(frameTop(level, width));
    }
    if (activeCount >= 2 && info.eventId) {
      console.log(frameLine(level,
        theme.getRoleChalk("concurrent")(`同時${activeCount}件発生中`) +
          chalk.gray(`  ${info.infoType}`),
        width
      ));
    } else {
      console.log(frameLine(level,
        chalk.gray(info.infoType),
        width
      ));
    }
  }

  // ヘッドライン
  if (info.headline) {
    console.log(frameDivider(level, width));
    for (const line of wrapFrameLines(level, chalk.bold.white(info.headline), width)) {
      console.log(line);
    }
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(frameDivider(level, width));

    if (info.isAssumedHypocenter) {
      console.log(frameLine(level, theme.getRoleChalk("plumLabel")("仮定震源要素") + chalk.gray(" (震源未確定・PLUM法による推定)"), width));
    }

    const hypoContent = diff?.hypocenterChange
      ? chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName) + theme.getRoleChalk("nextAdvisory")(" (変更)")
      : chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName);
    console.log(frameLine(level, hypoContent, width));

    if (eq.originTime) {
      console.log(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
    }
    if (eq.magnitude && !info.isAssumedHypocenter) {
      let magLine: string;
      if (diff?.previousMagnitude) {
        magLine = chalk.white("規模: ") + chalk.gray(`M${diff.previousMagnitude}`) + chalk.white(" → ") + chalk.bold(colorMagnitude(eq.magnitude));
      } else {
        magLine = chalk.white("規模: ") + colorMagnitude(eq.magnitude);
      }
      console.log(frameLine(level, magLine, width));
    }
    if (eq.depth && !info.isAssumedHypocenter) {
      let depthLine: string;
      if (diff?.previousDepth) {
        depthLine = chalk.white("深さ: ") + chalk.gray(diff.previousDepth) + chalk.white(" → ") + chalk.bold.white(eq.depth);
      } else {
        depthLine = chalk.white("深さ: ") + chalk.white(eq.depth);
      }
      console.log(frameLine(level, depthLine, width));
    }
  }

  if (isCancelled) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, theme.getRoleChalk("cancelText")("この地震についての緊急地震速報は取り消されました。"), width));
    if (info.eventId) {
      console.log(frameDivider(level, width));
      console.log(frameLine(level, chalk.gray(`EventID: ${info.eventId}`), width));
    }
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width);
    console.log(frameBottom(level, width));
    console.log();
    return;
  }

  // 予測震度一覧
  if (info.forecastIntensity && info.forecastIntensity.areas.length > 0) {
    console.log(frameDivider(level, width));
    for (const area of info.forecastIntensity.areas) {
      const color = intensityColor(area.intensity);
      let areaText = chalk.white(area.name);
      if (area.isPlum) {
        areaText += theme.getRoleChalk("plumLabel")(" [PLUM]");
      }
      if (area.hasArrived) {
        areaText += theme.getRoleChalk("arrivedLabel")(" [到達]");
      }
      if (area.lgIntensity && lgIntToNumeric(area.lgIntensity) >= 1) {
        const lc = lgIntensityColor(area.lgIntensity);
        areaText += lc(` [長周期${area.lgIntensity}]`);
      }
      console.log(frameLine(level, color(`震度${area.intensity}: `) + areaText, width));
    }
  }

  // 主要動到達と推測される地域
  if (info.forecastIntensity) {
    const arrivedAreas = info.forecastIntensity.areas.filter((a) => a.hasArrived);
    if (arrivedAreas.length > 0) {
      console.log(frameDivider(level, width));
      console.log(frameLine(level, theme.getRoleChalk("arrivedLabel")("既に主要動到達と推測:"), width));
      const names = arrivedAreas.map((a) => a.name).join("、");
      for (const line of wrapFrameLines(level, theme.getRoleChalk("arrivedLabel")(names), width)) {
        console.log(line);
      }
    }
  }

  // 最終報
  if (info.nextAdvisory) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, theme.getRoleChalk("nextAdvisory")(info.nextAdvisory), width));
  }

  // EventID
  if (info.eventId) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.gray(`EventID: ${info.eventId}`), width));
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width);

  console.log(frameBottom(level, width));
  console.log();
}

/** 津波情報のフレームレベルを決定 */
function tsunamiFrameLevel(info: ParsedTsunamiInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const kinds = (info.forecast || []).map((f) => f.kind);
  if (kinds.some((kind) => kind.includes("大津波警報"))) return "critical";
  if (kinds.some((kind) => kind.includes("津波警報"))) return "warning";
  return "normal";
}

/** 津波種別の表示順 */
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

/** 津波情報を整形して表示 */
export function displayTsunamiInfo(info: ParsedTsunamiInfo): void {
  const level = tsunamiFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード
  if (cachedDisplayMode === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.forecast && info.forecast.length > 0) {
      const kinds = [...new Set(info.forecast.map((f) => f.kind))];
      parts.push(kinds.join("・"));
      const areas = info.forecast.slice(0, 3).map((f) => f.areaName);
      parts.push(areas.join(", "));
    }
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  console.log();
  console.log(frameTop(level, width));

  if (info.isTest) {
    console.log(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  console.log(frameLine(level, titleContent, width));

  if (info.headline) {
    console.log(frameDivider(level, width));
    for (const line of wrapFrameLines(level, chalk.bold.white(info.headline), width)) {
      console.log(line);
    }
  }

  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName), width));
    if (eq.originTime) {
      console.log(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
    }
    if (eq.latitude && eq.longitude) {
      console.log(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`), width));
    }
    if (eq.magnitude) {
      console.log(frameLine(level, chalk.white("規模: ") + colorMagnitude(eq.magnitude), width));
    }
  }

  if (info.forecast && info.forecast.length > 0) {
    console.log(frameDivider(level, width));
    const sorted = [...info.forecast].sort(
      (a, b) => tsunamiKindRank(a.kind) - tsunamiKindRank(b.kind)
    );

    if (width >= WIDE_TABLE_THRESHOLD) {
      // ワイドテーブル: カラム区切り表示
      const headers = ["区分", "地域名", "波高", "到達予想"];
      const rows = sorted.map((item) => {
        let kindText = chalk.white(item.kind);
        if (item.kind.includes("大津波警報")) {
          kindText = theme.getRoleChalk("tsunamiMajor")(item.kind);
        } else if (item.kind.includes("津波警報")) {
          kindText = theme.getRoleChalk("tsunamiWarning")(item.kind);
        } else if (item.kind.includes("津波注意報")) {
          kindText = theme.getRoleChalk("tsunamiAdvisory")(item.kind);
        }
        return [
          kindText,
          chalk.white(item.areaName),
          item.maxHeightDescription ? chalk.white(item.maxHeightDescription) : chalk.gray("―"),
          item.firstHeight ? chalk.white(prettyTimeOrText(item.firstHeight)) : chalk.gray("―"),
        ];
      });
      renderFrameTable(level, headers, rows, width);
    } else {
      // 通常表示: 1行ずつ
      for (const item of sorted) {
        let kindText = chalk.white(item.kind);
        if (item.kind.includes("大津波警報")) {
          kindText = theme.getRoleChalk("tsunamiMajor")(item.kind);
        } else if (item.kind.includes("津波警報")) {
          kindText = theme.getRoleChalk("tsunamiWarning")(item.kind);
        } else if (item.kind.includes("津波注意報")) {
          kindText = theme.getRoleChalk("tsunamiAdvisory")(item.kind);
        }

        const extra: string[] = [];
        if (item.maxHeightDescription) extra.push(item.maxHeightDescription);
        if (item.firstHeight) extra.push(prettyTimeOrText(item.firstHeight));
        const extraText = extra.length > 0 ? chalk.gray(` (${extra.join(" / ")})`) : "";
        console.log(frameLine(level, kindText + chalk.white(` ${item.areaName}`) + extraText, width));
      }
    }
  }

  if (info.observations && info.observations.length > 0) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.bold.white("沖合観測"), width));

    if (width >= WIDE_TABLE_THRESHOLD) {
      // ワイドテーブル: カラム区切り表示
      const headers = ["観測点", "センサー", "初動", "最大波高", "到達時刻"];
      const rows = info.observations.map((station) => [
        chalk.white(station.name),
        station.sensor ? chalk.white(station.sensor) : chalk.gray("―"),
        station.initial ? chalk.white(station.initial) : chalk.gray("―"),
        station.maxHeightCondition ? chalk.white(station.maxHeightCondition) : chalk.gray("―"),
        station.arrivalTime ? chalk.white(prettyTimeOrText(station.arrivalTime)) : chalk.gray("―"),
      ]);
      renderFrameTable(level, headers, rows, width);
    } else {
      // 通常表示: 1行ずつ
      for (const station of info.observations) {
        const parts = [
          station.name,
          station.sensor,
          station.initial,
          station.maxHeightCondition,
        ].filter((v) => Boolean(v));
        const arrival = station.arrivalTime ? ` ${prettyTimeOrText(station.arrivalTime)}` : "";
        console.log(frameLine(level, chalk.white(parts.join(" / ") + arrival), width));
      }
    }
  }

  if (info.estimations && info.estimations.length > 0) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.bold.white("沿岸推定"), width));

    if (width >= WIDE_TABLE_THRESHOLD) {
      // ワイドテーブル: カラム区切り表示
      const headers = ["地域名", "波高", "到達予想"];
      const rows = info.estimations.map((estimation) => [
        chalk.white(estimation.areaName),
        estimation.maxHeightDescription ? chalk.white(estimation.maxHeightDescription) : chalk.gray("―"),
        estimation.firstHeight ? chalk.white(prettyTimeOrText(estimation.firstHeight)) : chalk.gray("―"),
      ]);
      renderFrameTable(level, headers, rows, width);
    } else {
      // 通常表示: 1行ずつ
      for (const estimation of info.estimations) {
        const extra: string[] = [];
        if (estimation.maxHeightDescription) extra.push(estimation.maxHeightDescription);
        if (estimation.firstHeight) extra.push(prettyTimeOrText(estimation.firstHeight));
        console.log(
          frameLine(
            level,
            chalk.white(`${estimation.areaName}${extra.length ? ` (${extra.join(" / ")})` : ""}`),
            width
          )
        );
      }
    }
  }

  if (info.warningComment) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, theme.getRoleChalk("warningComment")(info.warningComment), width));
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width);

  console.log(frameBottom(level, width));
  console.log();
}

/** 地震活動テキスト情報を整形して表示 */
export function displaySeismicTextInfo(info: ParsedSeismicTextInfo): void {
  const level: FrameLevel = info.infoType === "取消" ? "cancel" : "info";
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード
  if (cachedDisplayMode === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.headline) parts.push(info.headline.slice(0, 40));
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  console.log();
  console.log(frameTop(level, width));

  if (info.isTest) {
    console.log(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  console.log(frameLine(level, titleContent, width));

  if (info.headline) {
    console.log(frameDivider(level, width));
    for (const line of wrapFrameLines(level, chalk.bold.white(info.headline), width)) {
      console.log(line);
    }
  }

  const bodyLines = info.bodyText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (bodyLines.length > 0) {
    console.log(frameDivider(level, width));
    const showFull = cachedInfoFullText;
    const maxLines = 15;
    const innerWidth = width - 4;
    const displayLines = showFull ? bodyLines : bodyLines.slice(0, maxLines);
    for (const line of displayLines) {
      for (const wrapped of wrapTextLines(line, innerWidth)) {
        console.log(frameLine(level, chalk.white(wrapped), width));
      }
    }
    if (!showFull && bodyLines.length > maxLines) {
      console.log(frameLine(level, chalk.gray(`... (全${bodyLines.length}行)`), width));
    }
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width);

  console.log(frameBottom(level, width));
  console.log();
}

/** 南海トラフ関連情報のフレームレベルを決定 */
function nankaiTroughFrameLevel(info: ParsedNankaiTroughInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (!info.infoSerial) {
    // VYSE60 (InfoSerial なし) → warning
    return "warning";
  }
  const code = info.infoSerial.code;
  if (code === "120") return "critical";    // 巨大地震警戒
  if (code === "130") return "warning";     // 巨大地震注意
  if (code === "111" || code === "112" || code === "113") return "warning"; // 調査中
  if (code === "210" || code === "219") return "warning"; // 臨時解説
  if (code === "190" || code === "200") return "info";    // 調査終了 / 定例解説
  return "warning";
}

/** 南海トラフ関連情報を整形して表示 */
export function displayNankaiTroughInfo(info: ParsedNankaiTroughInfo): void {
  const level = nankaiTroughFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード
  if (cachedDisplayMode === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.infoSerial) parts.push(info.infoSerial.name);
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  console.log();

  // critical/warning 時はバナー表示
  if (level === "critical") {
    const bannerText = ` ${info.title}`;
    const critBanner = theme.getRoleChalk("nankaiCriticalBanner");
    console.log(critBanner(" ".repeat(width)));
    console.log(critBanner(visualPadEnd(bannerText, width)));
    console.log(critBanner(" ".repeat(width)));
  } else if (level === "warning") {
    const bannerText = ` ${info.title}`;
    const warnBanner = theme.getRoleChalk("nankaiWarningBanner");
    console.log(warnBanner(" ".repeat(width)));
    console.log(warnBanner(visualPadEnd(bannerText, width)));
    console.log(warnBanner(" ".repeat(width)));
  }

  console.log(frameTop(level, width));

  // テスト電文
  if (info.isTest) {
    console.log(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行
  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  console.log(frameLine(level, titleContent, width));

  // InfoSerial (状態名)
  if (info.infoSerial) {
    console.log(frameDivider(level, width));
    const serialColor = level === "critical" ? theme.getRoleChalk("nankaiSerialCritical") : theme.getRoleChalk("nankaiSerialWarning");
    console.log(frameLine(level, chalk.white("状態: ") + serialColor(info.infoSerial.name), width));
  }

  // 本文
  const bodyLines = info.bodyText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (bodyLines.length > 0) {
    console.log(frameDivider(level, width));
    const showFull = cachedInfoFullText;
    const maxLines = 20;
    const innerWidth = width - 4;
    const displayLines = showFull ? bodyLines : bodyLines.slice(0, maxLines);
    for (const line of displayLines) {
      for (const wrapped of wrapTextLines(line, innerWidth)) {
        console.log(frameLine(level, chalk.white(wrapped), width));
      }
    }
    if (!showFull && bodyLines.length > maxLines) {
      console.log(frameLine(level, chalk.gray(`... (全${bodyLines.length}行)`), width));
    }
  }

  // 次回情報予告
  if (info.nextAdvisory) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, theme.getRoleChalk("nextAdvisory")(info.nextAdvisory), width));
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width);

  console.log(frameBottom(level, width));
  console.log();
}

/** 長周期地震動観測情報のフレームレベルを決定 */
function lgObservationFrameLevel(info: ParsedLgObservationInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.maxLgInt) {
    const num = lgIntToNumeric(info.maxLgInt);
    if (num >= 4) return "critical";
    if (num >= 3) return "warning";
    if (num >= 2) return "normal";
  }
  return "info";
}

/** 長周期地震動観測情報を整形して表示 */
export function displayLgObservationInfo(info: ParsedLgObservationInfo): void {
  const level = lgObservationFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード
  if (cachedDisplayMode === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.earthquake) parts.push(info.earthquake.hypocenterName);
    if (info.maxLgInt) parts.push(`長周期${info.maxLgInt}`);
    if (info.maxInt) parts.push(`震度${info.maxInt}`);
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  console.log();
  console.log(frameTop(level, width));

  // テスト電文
  if (info.isTest) {
    console.log(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行
  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  console.log(frameLine(level, titleContent, width));

  // ヘッドライン
  if (info.headline) {
    console.log(frameDivider(level, width));
    for (const line of wrapFrameLines(level, chalk.bold.white(info.headline), width)) {
      console.log(line);
    }
  }

  // カード: 長周期階級 / 震度 / M / 深さ
  console.log(frameDivider(level, width));
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
    console.log(frameLine(level, cardParts.join(chalk.gray("  │  ")), width));
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(frameDivider(level, width));
    console.log(frameLine(level, chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName), width));
    if (eq.originTime) {
      console.log(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
    }
    if (eq.latitude && eq.longitude) {
      console.log(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`), width));
    }
  }

  // 地域リスト (LgInt 降順)
  if (info.areas.length > 0) {
    console.log(frameDivider(level, width));
    const sorted = [...info.areas].sort((a, b) =>
      lgIntToNumeric(b.maxLgInt) - lgIntToNumeric(a.maxLgInt)
    );
    for (const area of sorted) {
      const lc = lgIntensityColor(area.maxLgInt);
      const ic = intensityColor(area.maxInt);
      console.log(frameLine(level,
        lc(`長周期${area.maxLgInt}: `) +
        chalk.white(area.name) +
        ic(` (震度${area.maxInt})`),
        width
      ));
    }
  }

  // コメント
  if (info.comment) {
    console.log(frameDivider(level, width));
    const commentLines = info.comment.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of commentLines) {
      console.log(frameLine(level, chalk.gray(line.trimEnd()), width));
    }
  }

  // 詳細URI
  if (info.detailUri) {
    console.log(frameDivider(level, width));
    console.log(frameLine(level, theme.getRoleChalk("detailUri")(info.detailUri), width));
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width);

  console.log(frameBottom(level, width));
  console.log();
}

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
