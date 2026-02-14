import chalk from "chalk";
import { ParsedEarthquakeInfo, ParsedEewInfo, WsDataMessage } from "../types";
import type { EewDiff } from "../features/eew-tracker";
import * as log from "../logger";

// ── フレーム描画ユーティリティ ──

/** フレームの優先度レベル */
type FrameLevel = "critical" | "warning" | "normal" | "info" | "cancel";

/** フレーム文字セット */
const FRAMES: Record<FrameLevel, {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string; divL: string; divR: string;
  color: chalk.Chalk;
}> = {
  critical: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", divL: "╠", divR: "╣", color: chalk.red },
  warning:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", divL: "╠", divR: "╣", color: chalk.yellow },
  normal:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", divL: "├", divR: "┤", color: chalk.cyan },
  info:     { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", divL: "├", divR: "┤", color: chalk.gray },
  cancel:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", divL: "├", divR: "┤", color: chalk.green },
};

const FRAME_WIDTH = 60;

function frameTop(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = FRAMES[level];
  return f.color(f.tl + f.h.repeat(width - 2) + f.tr);
}

function frameLine(level: FrameLevel, content: string, width: number = FRAME_WIDTH): string {
  const f = FRAMES[level];
  // ANSI エスケープを除去して可視幅を計算
  const visibleLen = stripAnsi(content).length;
  const pad = Math.max(0, width - 4 - visibleLen);
  return f.color(f.v) + " " + content + " ".repeat(pad) + " " + f.color(f.v);
}

function frameDivider(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = FRAMES[level];
  return f.color(f.divL + f.h.repeat(width - 2) + f.divR);
}

function frameBottom(level: FrameLevel, width: number = FRAME_WIDTH): string {
  const f = FRAMES[level];
  return f.color(f.bl + f.h.repeat(width - 2) + f.br);
}

/** ANSI エスケープシーケンスを除去 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 文字列の視覚的な幅を計算（全角文字を2として数える） */
function visualWidth(str: string): number {
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
function visualPadEnd(str: string, targetWidth: number): string {
  const currentWidth = visualWidth(str);
  const padSize = Math.max(0, targetWidth - currentWidth);
  return str + " ".repeat(padSize);
}

// ── 時刻フォーマット ──

/** 相対時刻文字列を返す ("3秒前", "2分前" etc.) */
export function formatRelativeTime(isoStr: string): string {
  const ts = new Date(isoStr).getTime();
  if (isNaN(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "未来";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}時間前`;
  return `${Math.floor(diff / 86400_000)}日前`;
}

/** 絶対+相対時刻を併記 ("YYYY-MM-DD HH:MM:SS (N秒前)") */
export function formatTimestamp(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss} (${formatRelativeTime(isoStr)})`;
}

/** 区切り線 (後方互換用、新コードではフレーム関数を使用) */
function separator(char = "─", len = 60): string {
  return chalk.gray(char.repeat(len));
}

/** 震度に応じた色を返す */
export function intensityColor(intensity: string): chalk.Chalk {
  const norm = intensity.replace(/\s+/g, "");
  switch (norm) {
    case "1":
      return chalk.gray;
    case "2":
      return chalk.blue;
    case "3":
      return chalk.green;
    case "4":
      return chalk.yellow;
    case "5-":
    case "5弱":
      return chalk.rgb(255, 165, 0); // orange
    case "5+":
    case "5強":
      return chalk.rgb(255, 100, 0);
    case "6-":
    case "6弱":
      return chalk.redBright;
    case "6+":
    case "6強":
      return chalk.red;
    case "7":
      return chalk.bgRed.white;
    default:
      return chalk.white;
  }
}

/** 電文タイプの日本語名 */
function typeLabel(type: string): string {
  const map: Record<string, string> = {
    VXSE51: "震度速報",
    VXSE52: "震源に関する情報",
    VXSE53: "震源・震度に関する情報",
    VXSE56: "地震の活動状況等に関する情報",
    VXSE60: "地震の活動状況等に関する情報",
    VXSE61: "地震回数に関する情報",
    VTSE41: "津波警報・注意報・予報",
    VTSE51: "津波情報",
    VTSE52: "沖合の津波情報",
    VXSE43: "緊急地震速報（警報）",
    VXSE44: "緊急地震速報（予報）",
    VXSE45: "緊急地震速報（地震動予報）",
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

/** マグニチュードに色を付ける */
function colorMagnitude(magStr: string): string {
  const mag = parseFloat(magStr);
  const magColor =
    mag >= 7.0
      ? chalk.bgRed.white.bold
      : mag >= 5.0
        ? chalk.red.bold
        : mag >= 3.0
          ? chalk.yellow
          : chalk.white;
  return magColor(`M${magStr}`);
}

/** 津波情報の短縮テキスト */
function tsunamiShort(info: ParsedEarthquakeInfo): string {
  if (!info.tsunami) return "";
  const t = info.tsunami.text;
  if (t.includes("心配はありません") || t.includes("心配なし")) return chalk.green("津波なし");
  if (t.includes("注意")) return chalk.yellow("津波注意");
  if (t.includes("警報")) return chalk.red("津波警報");
  return chalk.white(t.length > 10 ? t.substring(0, 10) + "…" : t);
}

/** 地震情報を整形して表示 */
export function displayEarthquakeInfo(info: ParsedEarthquakeInfo): void {
  const level = earthquakeFrameLevel(info);
  const label = typeLabel(info.type);

  console.log();
  console.log(frameTop(level));

  // テスト電文
  if (info.isTest) {
    console.log(frameLine(level, chalk.bgMagenta.white.bold(" テスト電文 ")));
  }

  // タイトル行
  const titleContent = chalk.bold(`${label}`) + chalk.gray(` [${info.type}]`) + chalk.gray(`  ${info.infoType}`);
  console.log(frameLine(level, titleContent));

  // カード1行目: 最重要3項目
  console.log(frameDivider(level));
  const cardParts: string[] = [];
  if (info.intensity) {
    const ic = intensityColor(info.intensity.maxInt);
    cardParts.push(chalk.white("最大震度 ") + ic.bold(info.intensity.maxInt));
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
    console.log(frameLine(level, cardParts.join(chalk.gray("  │  "))));
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(frameDivider(level));
    console.log(frameLine(level, chalk.white("震源地: ") + chalk.bold.yellow(eq.hypocenterName)));
    if (eq.originTime) {
      console.log(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime))));
    }
    if (eq.latitude && eq.longitude) {
      console.log(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`)));
    }
  }

  // 発表時刻
  console.log(frameLine(level, chalk.gray("発表: ") + chalk.gray(formatTimestamp(info.reportDateTime) + "  " + info.publishingOffice)));

  // ヘッドライン
  if (info.headline) {
    console.log(frameDivider(level));
    console.log(frameLine(level, chalk.bold.white(info.headline)));
  }

  // 震度一覧
  if (info.intensity && info.intensity.areas.length > 0) {
    console.log(frameDivider(level));

    const byIntensity = new Map<string, string[]>();
    for (const area of info.intensity.areas) {
      const key = area.intensity;
      if (!byIntensity.has(key)) byIntensity.set(key, []);
      byIntensity.get(key)!.push(area.name);
    }

    const order = ["7", "6+", "6強", "6-", "6弱", "5+", "5強", "5-", "5弱", "4", "3", "2", "1"];
    const sorted = [...byIntensity.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const [int, names] of sorted) {
      const color = intensityColor(int);
      console.log(frameLine(level, color(`震度${int}: `) + chalk.white(names.join(", "))));
    }
  }

  // 津波 (詳細)
  if (info.tsunami) {
    console.log(frameDivider(level));
    console.log(frameLine(level, chalk.white(`${info.tsunami.text}`)));
  }

  console.log(frameBottom(level));
  console.log();
}

/** EEW 表示時のコンテキスト情報 */
export interface EewDisplayContext {
  /** 現在アクティブなイベント数 */
  activeCount: number;
  /** 前回との差分情報 */
  diff?: EewDiff;
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

  console.log();

  // バナー (警報/予報/取消のヘッダー)
  const bannerWidth = FRAME_WIDTH;
  const serialTag = info.serial ? ` #${info.serial}` : "";

  if (isCancelled) {
    const bannerText = ` 緊急地震速報 取消${serialTag}`;
    console.log(chalk.bgGreen.black.bold(" ".repeat(bannerWidth)));
    console.log(chalk.bgGreen.black.bold(visualPadEnd(bannerText, bannerWidth)));
    console.log(chalk.bgGreen.black.bold(" ".repeat(bannerWidth)));
  } else if (info.isWarning) {
    const bannerText = ` 緊急地震速報（警報）${serialTag}`;
    console.log(chalk.bgRed.white.bold(" ".repeat(bannerWidth)));
    console.log(chalk.bgRed.white.bold(visualPadEnd(bannerText, bannerWidth)));
    console.log(chalk.bgRed.white.bold(" ".repeat(bannerWidth)));
  } else {
    const bannerText = ` 緊急地震速報（予報）${serialTag}`;
    console.log(chalk.bgYellow.black.bold(" ".repeat(bannerWidth)));
    console.log(chalk.bgYellow.black.bold(visualPadEnd(bannerText, bannerWidth)));
    console.log(chalk.bgYellow.black.bold(" ".repeat(bannerWidth)));
  }

  // フレーム開始
  console.log(frameTop(level));

  // テスト電文
  if (info.isTest) {
    console.log(frameLine(level, chalk.bgMagenta.white.bold(" テスト電文 ")));
  }

  // 複数イベント同時発生の注記
  const activeCount = context?.activeCount ?? 0;
  if (activeCount >= 2 && info.eventId) {
    console.log(frameLine(level,
      chalk.yellow(`同時${activeCount}件発生中`) +
        chalk.gray(`  ${info.infoType}`)
    ));
  } else {
    console.log(frameLine(level,
      chalk.gray(info.infoType)
    ));
  }

  // カード1行目: 最重要項目
  if (!isCancelled) {
    console.log(frameDivider(level));
    const cardParts: string[] = [];
    if (info.forecastIntensity?.areas.length) {
      const topInt = info.forecastIntensity.areas[0].intensity;
      const ic = intensityColor(topInt);
      let intLabel = chalk.white("最大予測震度 ") + ic.bold(topInt);
      if (diff?.maxIntChange) {
        intLabel += chalk.cyan(` (${diff.maxIntChange})`);
      }
      cardParts.push(intLabel);
    }
    if (info.earthquake?.magnitude) {
      cardParts.push(colorMagnitude(info.earthquake.magnitude));
    }
    if (info.earthquake?.depth) {
      cardParts.push(chalk.white("深さ ") + chalk.white(info.earthquake.depth));
    }
    console.log(frameLine(level, cardParts.join(chalk.gray("  │  "))));
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(frameDivider(level));
    const hypoContent = diff?.hypocenterChange
      ? chalk.white("震源地: ") + chalk.bold.yellow(eq.hypocenterName) + chalk.cyan(" (変更)")
      : chalk.white("震源地: ") + chalk.bold.yellow(eq.hypocenterName);
    console.log(frameLine(level, hypoContent));

    if (eq.originTime) {
      console.log(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime))));
    }
    if (eq.magnitude) {
      let magLine = chalk.white("規模: ") + colorMagnitude(eq.magnitude);
      if (diff?.magnitudeChange) {
        const arrow = diff.magnitudeChange.startsWith("+") ? "↑" : "↓";
        magLine += chalk.cyan(` ${arrow}${diff.magnitudeChange}`);
      }
      console.log(frameLine(level, magLine));
    }
    if (eq.depth) {
      let depthLine = chalk.white("深さ: ") + chalk.white(eq.depth);
      if (diff?.depthChange) {
        const arrow = diff.depthChange.startsWith("+") ? "↓" : "↑";
        depthLine += chalk.cyan(` ${arrow}${diff.depthChange}`);
      }
      console.log(frameLine(level, depthLine));
    }
  }

  // 発表時刻
  console.log(frameLine(level, chalk.gray("発表: ") + chalk.gray(formatTimestamp(info.reportDateTime) + "  " + info.publishingOffice)));

  if (info.headline) {
    console.log(frameDivider(level));
    console.log(frameLine(level, chalk.bold.white(info.headline)));
  }

  if (isCancelled) {
    console.log(frameDivider(level));
    console.log(frameLine(level, chalk.green("この地震についての緊急地震速報は取り消されました。")));
    if (info.eventId) {
      console.log(frameDivider(level));
      console.log(frameLine(level, chalk.gray(`EventID: ${info.eventId}`)));
    }
    console.log(frameBottom(level));
    console.log();
    return;
  }

  // 予測震度一覧
  if (info.forecastIntensity && info.forecastIntensity.areas.length > 0) {
    console.log(frameDivider(level));
    for (const area of info.forecastIntensity.areas) {
      const color = intensityColor(area.intensity);
      console.log(frameLine(level, color(`震度${area.intensity}: `) + chalk.white(area.name)));
    }
  }

  // EventID (最終行)
  if (info.eventId) {
    console.log(frameDivider(level));
    console.log(frameLine(level, chalk.gray(`EventID: ${info.eventId}`)));
  }

  console.log(frameBottom(level));
  console.log();
}

/** xmlReport の情報だけで簡易表示（パース失敗時のフォールバック） */
export function displayRawHeader(msg: WsDataMessage): void {
  console.log();
  console.log(separator());
  console.log(
    chalk.cyan(`電文受信: `) +
      chalk.white(msg.xmlReport?.control?.title || msg.head.type) +
      chalk.gray(` [${msg.head.type}]`)
  );
  if (msg.xmlReport) {
    const r = msg.xmlReport;
    console.log(chalk.gray(`   ${r.head.title}`));
    console.log(chalk.gray(`   ${r.head.reportDateTime}  ${r.control.publishingOffice}`));
    if (r.head.headline) {
      console.log(chalk.white(`   ${r.head.headline}`));
    }
  }
  console.log(separator());
}
