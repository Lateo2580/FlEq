import chalk from "chalk";
import type {
  ParsedWeatherWarningTimeseriesInfo,
  WeatherWarningTimeseriesNumber,
  SignificancyValue,
  TimeWindow,
} from "../types";
import {
  FrameLevel,
  getFrameWidth,
  getWeatherWarningDisplayOptions,
  SEVERITY_LABELS,
  frameDividerLabeledColored,
  frameDividerColored,
  frameTopColored,
  frameLineColored,
  frameBottomColored,
  createRenderBuffer,
  flushWithRecap,
  visualWidth,
  visualPadEnd,
  wrapFrameLines,
  wrapFrameLinesColored,
} from "./formatter";
import {
  normalizeKindName,
  KIND_NAME_MAP,
} from "../dmdata/weather-warning-timeseries-significancy";
import { renderFooter } from "./formatter";
import { weatherWarningTimeseriesFrameLevel } from "../engine/presentation/level-helpers";
import {
  DISPLAY_SEVERITY_RANK,
  resolveVpwp50Significancy,
  type DisplaySeverity,
} from "../dmdata/weather-warning-level";
import {
  getDisplaySeverityTierPrefix,
  getDisplaySeverityText,
  renderDividerChip,
  DISPLAY_SEVERITY_DIVIDER_LABEL,
  drawSeverityBanner,
} from "./weather-warning-level-theme";
import {
  flattenEntries,
  partitionBySeverity,
  formatPeakBySeries,
  type WeatherSeverityEntry,
} from "../engine/presentation/weather-severity-pyramid";

// 本文 (テーブル行/詳細/未知/raw fallback) と外枠 bottom の「白系」罫線色。
// VPWW (weather-core-formatter.ts) の WHITE_BORDER と同じ normal 概念色 #e8e8e8 —
// ヘッダ=displaySeverity 色 / 本文+下辺=白系 という VPWW のデザイン言語に揃える。
const WHITE_BORDER = chalk.rgb(232, 232, 232);

/** 視覚幅で切り詰める (色付け前の raw 文字列に適用) */
function clipToVisualWidth(s: string, max: number): string {
  if (visualWidth(s) <= max) return s;
  let out = "";
  // grapheme で安全に進めるため Array.from で分解
  for (const ch of Array.from(s)) {
    const next = out + ch;
    if (visualWidth(next) > max - 1) break;
    out = next;
  }
  return out + "…";
}

/** 系列番号 → 1 枠の時間長さ (parser 変更なしのため formatter 内ローカルマップ) */
const SLOT_HOURS_BY_SERIES: Record<1 | 2 | 3, number> = { 1: 3, 2: 24, 3: 24 };

/** 時刻枠を "(N枠/Mh)" 付きで返す。M = N * slotHours[tsNum] */
export function formatTimeWindowWithHours(w: TimeWindow, tsNum: 1 | 2 | 3): string {
  if (w.count <= 1) return w.startName;
  const slotHours = SLOT_HOURS_BY_SERIES[tsNum];
  const hours = w.count * slotHours;
  if (w.contiguous) {
    return `${w.startName}-${w.endName} (${w.count}枠/${hours}h)`;
  }
  return `${w.startName}ほか${w.count - 1}枠 (${w.count}枠/${hours}h)`;
}

/**
 * 基準到達期間を "開始時刻 〜 終了時刻 (継続時間)" 形式で返す。
 *
 * Date 経由しない: 入力 ISO 8601 の TZ で揺れる + 18:00 + 6h = 24:00 が 00:00 になる。
 *
 * Duration 対応:
 *   - PT(\d+)H — 時間単位
 *   - PT(\d+)M — 分単位
 *   - P1D     — 1 日 (24h 扱い)
 *   - PT0H    — 即時
 *   - 他      — フォールバック
 *
 * 日跨ぎ表記 (v3.1/v3.2):
 *   - endH===24 && endM===0 のみ → "24:00" ((翌) なし)
 *   - 24<endH<48 (or endH===24 && endM>0) → "HH:MM (翌)"
 *   - 48≤endH<72 → "HH:MM (+2)"
 *   - 72≤endH    → "HH:MM (+N)" (N = floor(endH/24))
 */
export function formatCriteriaPeriodRange(time: string, duration: string): string {
  // time から HH:MM 抽出 (Date 経由しない)
  const tm = time.match(/T(\d{2}):(\d{2})/);
  if (!tm) return `${time} ${duration}`; // フォールバック (異常入力)
  const startH = parseInt(tm[1], 10);
  const startM = parseInt(tm[2], 10);

  const pad = (n: number): string => String(n).padStart(2, "0");
  const startStr = `${pad(startH)}:${pad(startM)}`;

  // Duration 解析
  let durationHours = 0;
  let durationMinutes = 0;
  let durationLabel = "";

  if (duration === "PT0H") {
    return `${startStr} 即時 (0h)`;
  }
  if (duration === "P1D") {
    durationHours = 24;
    durationLabel = "24h";
  } else {
    const hm = duration.match(/^PT(\d+)H$/);
    const mm = duration.match(/^PT(\d+)M$/);
    if (hm) {
      durationHours = parseInt(hm[1], 10);
      durationLabel = `${durationHours}h`;
    } else if (mm) {
      durationMinutes = parseInt(mm[1], 10);
      durationLabel = `${durationMinutes}m`;
    } else {
      return `${startStr} ${duration}`; // フォールバック (未対応パターン)
    }
  }

  // 終了時刻 (分単位で計算)
  const totalMinutes = startH * 60 + startM + durationHours * 60 + durationMinutes;
  const endH = Math.floor(totalMinutes / 60);
  const endM = totalMinutes % 60;

  let endStr: string;
  // v3.1 修正: 24:00 ちょうど (endH===24 && endM===0) のみ "24:00" 表記
  // それ以外で endH>=24 は翌日表記
  if (endH === 24 && endM === 0) {
    endStr = `24:00`;
  } else if (endH >= 24) {
    const dayOffset = Math.floor(endH / 24);
    const displayH = endH - dayOffset * 24;
    const suffix = dayOffset === 1 ? "(翌)" : `(+${dayOffset})`;
    endStr = `${pad(displayH)}:${pad(endM)} ${suffix}`;
  } else {
    endStr = `${pad(endH)}:${pad(endM)}`;
  }

  return `${startStr} 〜 ${endStr} (${durationLabel})`;
}

// ── responsive table (v3.2) ──

/** v3.2: ターミナル幅に応じた列数モード (ultra-narrow / standard / wide) */
export type DisplayMode = "ultra-narrow" | "standard" | "wide";

/** 1 entry あたりの clip 報告: { 列ヘッダ名: true } 等。キーは e.id */
export type ClipReport = Map<string, Partial<Record<string, boolean>>>;

interface ColumnSpec {
  header: string;
  minWidth: number;
  maxWidth: number;
  cell: (e: WeatherSeverityEntry) => string;
  /**
   * Phase B (c): clip + pad 後のセル文字列に適用する着色 hook。
   * clip 前に着色すると ANSI が clipToVisualWidth で壊れるため、必ず整形後に適用する。
   * 未指定の列は無着色。
   */
  colorize?: (e: WeatherSeverityEntry, padded: string) => string;
}

/**
 * Phase B (b): VPWP50 の種別ラベル。公式系は L 後置注釈、非対応は従来名。
 * 例: officialL4 + 土砂災害危険度 → "土砂災害 (L4)" / grade warning + 大雨 → "大雨警報"。
 *
 * 公式系で「危険度」suffix を落とした base 名を使うのは、normalizeKindName の
 * severity 依存名 ("土砂災害警報") を流用すると「土砂災害警報 (L4)」(警報 ≠ L4) という
 * 誤読を生むため (spec 逸脱 4)。
 * L 前置 ("L4 土砂災害") は grade 系従来名との混在が読みにくいとの目視ゲート
 * フィードバック (2026-06-11) により後置注釈に変更。
 */
function vpwp50KindLabel(propertyType: string, entry: WeatherSeverityEntry): string {
  if (entry.officialAlertLevel != null) {
    const mapped = KIND_NAME_MAP[propertyType]?.base;
    const stem = mapped ?? propertyType.replace(/危険度$/, "");
    return `${stem} (L${entry.officialAlertLevel})`;
  }
  return normalizeKindName(propertyType, entry.severity);
}

/** 時刻枠列の表記: 各 window を formatTimeWindowWithHours で組み立て、" / " で連結 */
function formatTimeWindowsForCell(e: WeatherSeverityEntry): string {
  if (e.windows.length === 0) return "-";
  const parts = e.windows.map((w) => {
    if (!w.window) return `枠${w.timeRef}`;
    return formatTimeWindowWithHours(w.window, w.tsNum);
  });
  if (parts.length === 1) return parts[0];
  return parts.join(" / ");
}

/** ピーク列の表記: 既存 formatPeakBySeries を流用、null → "-" */
function formatPeakForCell(e: WeatherSeverityEntry): string {
  return formatPeakBySeries(e.windows, e.windows.length > 1) ?? "-";
}

/** 基準到達列: formatCriteriaPeriodRange で組み立て、" / " で連結 */
function formatCriteriaForCell(e: WeatherSeverityEntry): string {
  const items = e.windows.filter((w) => w.criteriaPeriod != null);
  if (items.length === 0) return "-";
  const parts = items.map((w) =>
    formatCriteriaPeriodRange(w.criteriaPeriod!.time, w.criteriaPeriod!.duration),
  );
  if (parts.length === 1) return parts[0];
  return parts.join(" / ");
}

/** 備考列: Local 標識 + 未知 Code 標識 */
function formatRemarksForCell(e: WeatherSeverityEntry): string {
  const parts: string[] = [];
  if (e.localAreaNames.length > 0) {
    const [head, ...rest] = e.localAreaNames;
    parts.push(rest.length > 0 ? `Local: ${head} ほか${rest.length}` : `Local: ${head}`);
  }
  if (e.unknownCodes.length > 0) {
    const distinct = Array.from(new Set(e.unknownCodes)).map((c) => `?${c}`);
    parts.push(`未知:${distinct.join(",")}`);
  }
  return parts.length === 0 ? "-" : parts.join(" / ");
}

function getColumnsForMode(mode: DisplayMode): ColumnSpec[] {
  // 級列は目視ゲート (2026-06-11) で一度削除 → 再判断で復活。divider 見出しと
  // 情報は重複するが、行単位で tier が読める冗長性を優先 (種別の L 後置注釈は維持)。
  const tier1: ColumnSpec[] = [
    {
      header: "級",
      minWidth: 4,
      maxWidth: 4,
      cell: (e) => getDisplaySeverityTierPrefix(e.displaySeverity),
      // Phase B (c): clip/pad 後に displaySeverity の前景色で着色
      colorize: (e, padded) => getDisplaySeverityText(e.displaySeverity)(padded),
    },
    {
      header: "種別",
      minWidth: 8,
      maxWidth: 16,
      cell: (e) => vpwp50KindLabel(e.propertyType, e),
    },
    { header: "地域", minWidth: 8, maxWidth: 18, cell: (e) => e.areaName },
  ];
  const tier2: ColumnSpec[] = [
    { header: "時刻枠", minWidth: 12, maxWidth: 30, cell: formatTimeWindowsForCell },
    { header: "ピーク", minWidth: 8, maxWidth: 18, cell: formatPeakForCell },
    { header: "基準到達", minWidth: 12, maxWidth: 28, cell: formatCriteriaForCell },
  ];
  const tier3: ColumnSpec[] = [
    { header: "備考", minWidth: 8, maxWidth: 36, cell: formatRemarksForCell },
  ];
  if (mode === "ultra-narrow") return tier1;
  if (mode === "standard") return [...tier1, ...tier2];
  return [...tier1, ...tier2, ...tier3];
}

/**
 * モード別に列を絞り、各セル本文を maxWidth で clip して描画する。
 * 既存 renderFrameTable と違い、セル本文 clip 込みで「絶対に width を超えない」保証。
 *
 * v3.2: 戻り値として ClipReport (どの entry のどの列が clip されたか) を返す。
 *   呼び出し側はこれを buildDetailBlock に渡し、clip された列の全文を detail に逃がす。
 */
export function renderResponsiveTable(
  buf: ReturnType<typeof createRenderBuffer>,
  frameLevel: FrameLevel,
  width: number,
  mode: DisplayMode,
  entries: WeatherSeverityEntry[],
  /** 行罫線色 (section の displaySeverity 色 — VPWW weather-core-blocks L47 と同形)。省略時は白系 */
  borderColor?: (s: string) => string,
): ClipReport {
  const rowBorder = borderColor ?? WHITE_BORDER;
  const cols = getColumnsForMode(mode);
  const innerWidth = width - 4;
  const sepWidth = (cols.length - 1) * 3;
  const contentWidth = Math.max(0, innerWidth - sepWidth);

  // 各列の minWidth から開始し、残り幅を maxWidth まで分配
  const widths = cols.map((c) => c.minWidth);
  let used = widths.reduce((a, b) => a + b, 0);
  let i = 0;
  let safety = 0; // 無限ループ防止
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

  // ヘッダ行も section 色 (目視ゲート最終決定 2026-06-11: 白固定だと divider 直下だけ浮く)
  const headerCells = cols.map((c, idx) => visualPadEnd(chalk.bold(c.header), widths[idx]));
  buf.push(frameLineColored(frameLevel, rowBorder, headerCells.join(colSep), width));

  // データ行 + clip 検知
  const report: ClipReport = new Map();
  for (const e of entries) {
    const entryClip: Partial<Record<string, boolean>> = {};
    const cells = cols.map((c, idx) => {
      const raw = c.cell(e);
      const clipped = clipToVisualWidth(raw, widths[idx]);
      if (raw !== clipped) {
        entryClip[c.header] = true;
      }
      const padded = visualPadEnd(clipped, widths[idx]);
      // Phase B (c): clip/pad 後に着色 (clip 前に着色すると ANSI が壊れる)
      return c.colorize ? c.colorize(e, padded) : padded;
    });
    if (Object.keys(entryClip).length > 0) {
      report.set(e.id, entryClip);
    }
    // データ行の罫線は section 色 (VPWW のテーブル行と同形)
    buf.push(frameLineColored(frameLevel, rowBorder, cells.join(colSep), width));
  }
  return report;
}

// ── detail block (v3.2) ──

type PriorityLine = { tier: 1 | 2 | 3 | 4; text: string };

/**
 * 1 entry の行数制限を優先度 + wrap 後行数で適用 (v3.2 / Phase 2-FIX)。
 *
 * 戦略:
 *   1. wrap 後の実描画行数を計算
 *   2. maxPerEntry に収まれば全行返す
 *   3. 超過時、低優先度 (P4 → P3) の順で削除を試行
 *      ※ P2 (Local / 未知 Code) は安全情報のため絶対に削らない
 *   4. それでも収まらない場合は、P2 を全保持しつつ P1 を wrap 後行数ベースで切り詰める
 */
function applyPerEntryGuard(
  body: PriorityLine[],
  frameLevel: FrameLevel,
  width: number,
  maxPerEntry: number,
): PriorityLine[] {
  const measure = (lines: PriorityLine[]): number =>
    lines.reduce(
      (sum, pl) => sum + wrapFrameLines(frameLevel, pl.text, width, 8).length,
      0,
    );

  if (measure(body) <= maxPerEntry) return body;

  // Step 1: P4 と P3 を段階的に削除 (P2 は保持)
  let work = [...body];
  for (const dropTier of [4, 3] as const) {
    work = work.filter((pl) => pl.tier !== dropTier);
    if (measure(work) <= maxPerEntry) return work;
  }

  // Step 2: P2 を絶対保持。P1 を wrap 後行数ベースで切り詰める
  const p2 = work.filter((pl) => pl.tier === 2);
  const p1 = work.filter((pl) => pl.tier === 1);
  const p2Lines = measure(p2);

  // P2 を全部入れた残り wrap 容量 (-1 は省略行用)
  const remaining = Math.max(0, maxPerEntry - p2Lines - 1);

  // P1 を 1 件ずつ追加して remaining を超えない範囲を採用
  const acceptedP1: PriorityLine[] = [];
  let usedLines = 0;
  for (const pl of p1) {
    const wrapLen = wrapFrameLines(frameLevel, pl.text, width, 8).length;
    if (usedLines + wrapLen > remaining) break;
    acceptedP1.push(pl);
    usedLines += wrapLen;
  }
  const omittedP1 = p1.length - acceptedP1.length;
  const omittedTotal = (body.length - work.length) + omittedP1;

  const result: PriorityLine[] = [...acceptedP1, ...p2];
  if (omittedTotal > 0) {
    result.push({
      tier: 1,
      text: `      ... ほか ${omittedTotal} 項目省略`,
    });
  }
  return result;
}

/**
 * 隠れた列 + clip された列 + Local + 未知 + Sentence を末尾の [詳細] ブロックに集約する (v3.2)。
 *
 * clipReport のキーは e.id (Phase 2-A の stable entry id)。
 * 各 entry の body は P1 (clip 全文) > P2 (Local + 未知) > P3 (Sentence) > P4 (通常 window) の優先度。
 * guard 判定は wrap 後の実描画行数で計算。
 */
export function buildDetailBlock(
  buf: ReturnType<typeof createRenderBuffer>,
  frameLevel: FrameLevel,
  width: number,
  mode: DisplayMode,
  entries: WeatherSeverityEntry[],
  clipReport: ClipReport,
  guards: { maxPerEntry?: number; maxTotal?: number } = {},
): void {
  const maxPerEntry = guards.maxPerEntry ?? 8;
  const maxTotal = guards.maxTotal ?? 60;

  type Detail = { headLine: string; bodyLines: PriorityLine[] };
  const details: Detail[] = [];

  for (const e of entries) {
    const clip = clipReport.get(e.id) ?? {};
    const body: PriorityLine[] = [];

    // window 走査 (P1 if clipped, P4 if mode=ultra-narrow default)
    e.windows.forEach((w, i) => {
      const idx = e.windows.length > 1 ? `[${i + 1}]` : "";
      // 時刻枠
      if (w.window) {
        const tw = `      時刻枠${idx}: ${formatTimeWindowWithHours(w.window, w.tsNum)}`;
        if (clip["時刻枠"]) body.push({ tier: 1, text: tw });
        else if (mode === "ultra-narrow") body.push({ tier: 4, text: tw });
      }
      // ピーク
      if (w.peak) {
        const pk = `      ピーク${idx}: ${w.peak.date}${w.peak.term}`;
        if (clip["ピーク"]) body.push({ tier: 1, text: pk });
        else if (mode === "ultra-narrow") body.push({ tier: 4, text: pk });
      }
      // 基準到達
      if (w.criteriaPeriod) {
        const cr = `      基準到達${idx}: ${formatCriteriaPeriodRange(w.criteriaPeriod.time, w.criteriaPeriod.duration)}`;
        if (clip["基準到達"]) body.push({ tier: 1, text: cr });
        else if (mode === "ultra-narrow") body.push({ tier: 4, text: cr });
      }
    });

    // Local (P2)
    // wide では備考列に出てるので clip 無ければ省略
    const localShouldShow = mode !== "wide" || clip["備考"];
    if (localShouldShow && e.localAreaNames.length > 0) {
      const [head, ...rest] = e.localAreaNames;
      const localStr =
        rest.length > 0 ? `Local: ${head} ほか${rest.length}` : `Local: ${head}`;
      body.push({ tier: 2, text: `      ${localStr}` });
    }

    // 未知 Code (P2)
    const unknownShouldShow = mode !== "wide" || clip["備考"];
    if (unknownShouldShow && e.unknownCodes.length > 0) {
      const distinct = Array.from(new Set(e.unknownCodes)).map((c) => `?${c}`);
      body.push({ tier: 2, text: `      未知: ${distinct.join(", ")}` });
    }

    // Sentence (P3) — 1 件目のみ。複数あれば "ほか N 文省略"
    const sentences = e.windows
      .map((w) => w.criteriaPeriod?.sentence)
      .filter((s): s is string => !!s);
    if (sentences.length > 0) {
      body.push({ tier: 3, text: `      Sentence: ${sentences[0]}` });
      if (sentences.length > 1) {
        body.push({
          tier: 3,
          text: `      Sentence: ほか ${sentences.length - 1} 文省略`,
        });
      }
    }

    if (body.length === 0) continue;

    const truncated = applyPerEntryGuard(body, frameLevel, width, maxPerEntry);

    const prefix = getDisplaySeverityTierPrefix(e.displaySeverity);
    const headLine = `  ${prefix} ${vpwp50KindLabel(e.propertyType, e)} @${e.areaName}`;
    details.push({ headLine, bodyLines: truncated });
  }

  if (details.length === 0) return;

  // 末尾系 divider: 罫線色は白系、スタイルは frame level 準拠 (VPWW が ctx.styleLevel を
  // 渡すのと同形 — critical/warning フレームでは二重線 ═ になる)
  buf.push(frameDividerLabeledColored(frameLevel, WHITE_BORDER, " [詳細] ", width));

  let lineCount = 0;
  let omittedEntries = 0;
  for (let di = 0; di < details.length; di++) {
    const d = details[di];
    // 本文罫線は白系 (VPWW 言語)。行数 measure (applyPerEntryGuard) は色非依存のため従来のまま
    const headerWrapped = wrapFrameLinesColored(frameLevel, WHITE_BORDER, d.headLine, width, 2);
    const bodyWrappedAll = d.bodyLines.flatMap((pl) =>
      wrapFrameLinesColored(frameLevel, WHITE_BORDER, pl.text, width, 8),
    );
    const wouldAdd = headerWrapped.length + bodyWrappedAll.length;
    if (lineCount + wouldAdd > maxTotal) {
      omittedEntries = details.length - di;
      break;
    }
    for (const wrapped of headerWrapped) {
      buf.push(wrapped);
      lineCount++;
    }
    for (const wrapped of bodyWrappedAll) {
      buf.push(wrapped);
      lineCount++;
    }
  }
  if (omittedEntries > 0) {
    buf.push(
      frameDividerLabeledColored(
        frameLevel, WHITE_BORDER, ` [詳細] (${omittedEntries} entry 省略) `, width,
      ),
    );
  }
}

// ── normal (responsive: 3 段 breakpoint + 詳細ブロック) ──

/** ターミナル幅から表示モードを決定する */
function decideDisplayMode(width: number): DisplayMode {
  const opts = getWeatherWarningDisplayOptions();
  if (width < opts.standardThreshold) return "ultra-narrow";
  if (width < opts.wideThreshold) return "standard";
  return "wide";
}

// ── Phase B (d): displaySeverity 別 divider セクション ──
// DISPLAY_SEVERITY_DIVIDER_LABEL は Phase C で共有化済み (→ weather-warning-level-theme.ts の export)。

/** ultra-narrow でチップ要約にまとめる advisory-tier の displaySeverity 群 */
const ADVISORY_TIER_DISPLAY_SEVERITIES: ReadonlySet<DisplaySeverity> = new Set<DisplaySeverity>([
  "officialL2",
  "nonLevelAdvisory",
  "officialL1",
]);

/**
 * entries を displaySeverity でグルーピングし、表示順 (RANK 降順 + unknown は
 * nonLevelWarning 直後) に並べて返す。unknown を RANK=30 の位置 (注意報級より下) に
 * 置かず警報級相当の位置に上げるのは、見落とし防止の意図 (現行 formatter の
 * orphaned unknown 押し込みを 2 系統でも維持。spec 逸脱 2 と整合)。
 */
function groupEntriesByDisplaySeverity(
  entries: WeatherSeverityEntry[],
): Array<{ displaySeverity: DisplaySeverity; entries: WeatherSeverityEntry[] }> {
  const map = new Map<DisplaySeverity, WeatherSeverityEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.displaySeverity) ?? [];
    arr.push(e);
    map.set(e.displaySeverity, arr);
  }
  const present = [...map.keys()];
  const hasUnknown = map.has("unknown");
  // unknown を除いて RANK 降順
  const ordered = present
    .filter((ds) => ds !== "unknown")
    .sort((a, b) => DISPLAY_SEVERITY_RANK[b] - DISPLAY_SEVERITY_RANK[a]);
  // unknown を nonLevelWarning の直後に挿入 (無ければ末尾)
  const result: DisplaySeverity[] = [];
  for (const ds of ordered) {
    result.push(ds);
    if (ds === "nonLevelWarning" && hasUnknown) result.push("unknown");
  }
  if (hasUnknown && !result.includes("unknown")) result.push("unknown");
  return result.map((ds) => ({ displaySeverity: ds, entries: map.get(ds)! }));
}

/** displaySeverity 別の colored divider を push する (weather-core-blocks.ts に揃える) */
function pushDisplaySeverityDivider(
  buf: ReturnType<typeof createRenderBuffer>,
  displaySeverity: DisplaySeverity,
  styleLevel: FrameLevel,
  width: number,
): void {
  const sectionColor = getDisplaySeverityText(displaySeverity);
  const chipLabel = renderDividerChip(
    displaySeverity,
    DISPLAY_SEVERITY_DIVIDER_LABEL[displaySeverity],
  );
  buf.push(frameDividerLabeledColored(styleLevel, sectionColor, chipLabel, width));
}

/** ultra-narrow モードで注意報を `[種別 件数]` のチップ列で要約する。
 *  Phase 2-FIX: normalizeKindName(advisory) → "...注意報" suffix 除去で自然語ラベル
 *  (例: propertyType="風" → normalizeKindName → "強風注意報" → "強風")
 */
function summarizeAdvisoryAsChips(entries: WeatherSeverityEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const fullName = normalizeKindName(e.propertyType, e.severity);
    const k = fullName.replace(/注意報$/, "");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return "  " + Array.from(counts.entries()).map(([p, n]) => `[${p} ${n}]`).join(" ");
}

/** 通常モード: ターミナル幅に応じて列構成を切り替える responsive 表示 */
function displayNormalResponsive(
  info: ParsedWeatherWarningTimeseriesInfo,
  level: FrameLevel,
): void {
  const width = getFrameWidth();
  const mode = decideDisplayMode(width);
  const buf = createRenderBuffer();

  // Phase B (e) + 目視ゲート最終決定 (2026-06-11): フレーム配色 —
  //   取消                       → フレーム全体 release 色 (二色割れさせない)
  //   compactOnly / maxDs null   → フレーム全体 白系 (本文が無い/要約のみのフレームは単色)
  //   本文あり (maxDs・非取消)    → 上辺+タイトル = maxDs 色 / section = section 色 /
  //                                 [詳細]以降 + footer + 下辺 = 白系 (VPWW 言語)
  const maxDs = info.maxDisplaySeverity;
  const isCancel = info.infoType === "取消";
  const isPlainFrame = !isCancel && (maxDs == null || info.fallback === "compactOnly");
  const headColor: (s: string) => string =
    isCancel ? getDisplaySeverityText("release")
    : isPlainFrame ? WHITE_BORDER
    : getDisplaySeverityText(maxDs!);
  // 末尾系 (footer divider/行罫線 + 下辺): 取消は release で統一、それ以外は白系
  const tailColor: (s: string) => string =
    isCancel ? getDisplaySeverityText("release") : WHITE_BORDER;
  const frameTopFn = (): string => frameTopColored(level, headColor, width);
  const frameLineFn = (content: string): string =>
    frameLineColored(level, headColor, content, width);
  const frameBottomFn = (): string => frameBottomColored(level, tailColor, width);

  // Phase B (f): バナー発火 = 取消、または maxDisplaySeverity が警報級相当以上
  const BANNER_DISPLAY_SEVERITIES: ReadonlySet<DisplaySeverity> = new Set<DisplaySeverity>([
    "officialL5",
    "officialL4",
    "officialL3",
    "nonLevelSpecial",
    "nonLevelWarning",
  ]);
  const shouldShowBanner =
    info.infoType === "取消" ||
    (maxDs != null && BANNER_DISPLAY_SEVERITIES.has(maxDs));

  if (shouldShowBanner) {
    buf.pushEmpty();
    const bannerText = buildWeatherWarningBannerText(info, { maxWidth: width - 2 });
    // Phase B (f): 取消は release severity、それ以外は maxDisplaySeverity で色決定
    const bannerSeverity: DisplaySeverity =
      info.infoType === "取消" ? "release" : maxDs!;
    const banner = drawWeatherWarningBanner(bannerSeverity, bannerText, width);
    buf.push(banner[0]);
    buf.push(banner[1]);
    buf.push(banner[2]);
  }

  // フレーム
  buf.push(frameTopFn());
  const headerParts: string[] = [];
  headerParts.push(SEVERITY_LABELS[level]);
  headerParts.push("気象警報・注意報時系列情報");
  if (info.targetArea) headerParts.push(info.targetArea.name);
  if (info.infoType === "取消") headerParts.push("(取消)");
  buf.push(frameLineFn(headerParts.join("  ")));

  if (isCancel) {
    // 取消フレームは全体 release 色 (footer 罫線も tailColor = release)
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, tailColor);
    buf.push(frameBottomFn());
    flushWithRecap(buf, level, width, tailColor);
    return;
  }

  if (info.fallback === "compactOnly") {
    renderCompactOnlyFallback(buf, info, level, width);
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, tailColor);
    buf.push(frameBottomFn());
    flushWithRecap(buf, level, width, tailColor);
    return;
  }

  const entries = flattenEntries(info);
  const part = partitionBySeverity(entries);

  // Phase 2-FIX #1: 未知 Code を該当 known entry の unknownCodes にマージ
  //   ソース2系統:
  //     (a) part.unknown — Property 全体が unknown の entry (severity="unknown")
  //     (b) info.unknownCodes — known Property 内の sibling unknown Significancy
  //   マッチング条件: 同じ (propertyType, areaName) を持つ known entry
  //   マッチしない (a) は unknown セクション (nonLevelWarning 直後) に独立表示
  //   マッチしない (b) は末尾の "! 未知 Code" ブロックでカバーされるため追加処理不要
  const orphanedUnknown: WeatherSeverityEntry[] = [];
  {
    const known = [...part.special, ...part.warning, ...part.advisory];
    const addCode = (entry: WeatherSeverityEntry, code: string): void => {
      if (!entry.unknownCodes.includes(code)) {
        entry.unknownCodes.push(code);
      }
    };

    // (a) part.unknown
    for (const ue of part.unknown) {
      const match = known.find(
        (e) => e.propertyType === ue.propertyType && e.areaName === ue.areaName,
      );
      if (match) {
        const codes =
          ue.unknownCodes.length > 0 ? ue.unknownCodes : [ue.code];
        for (const code of codes) addCode(match, code);
      } else {
        orphanedUnknown.push(ue);
      }
    }

    // (b) info.unknownCodes (sibling unknown in otherwise-known Property)
    for (const uc of info.unknownCodes) {
      const match = known.find(
        (e) => e.propertyType === uc.propertyType && e.areaName === uc.areaName,
      );
      if (match) addCode(match, uc.code);
    }
  }

  // Phase B (d): displaySeverity 別セクションに再編 (RANK 降順、unknown は警報級直後)。
  // orphaned unknown (displaySeverity="unknown") も表示母集団に含める。
  const displayEntries = [
    ...part.special,
    ...part.warning,
    ...part.advisory,
    ...orphanedUnknown,
  ];
  const groups = groupEntriesByDisplaySeverity(displayEntries);

  // 各 renderResponsiveTable 呼び出しから ClipReport を集める
  const clipReports: ClipReport[] = [];

  for (const g of groups) {
    // 罫線スタイル (二重/単線) は frame 全体の level に揃え、色のみ section ごと
    // (weather-core-blocks.ts と同じ方針)。
    pushDisplaySeverityDivider(buf, g.displaySeverity, level, width);
    if (mode === "ultra-narrow" && ADVISORY_TIER_DISPLAY_SEVERITIES.has(g.displaySeverity)) {
      // ultra-narrow の advisory-tier はチップ要約 (従来の summarizeAdvisoryAsChips 役割を維持)
      const chips = summarizeAdvisoryAsChips(g.entries);
      for (const wrapped of wrapFrameLinesColored(level, WHITE_BORDER, chips, width, 2)) {
        buf.push(wrapped);
      }
    } else {
      // 行罫線 = section の displaySeverity 色 (VPWW weather-core-blocks L47 と同形)
      clipReports.push(
        renderResponsiveTable(
          buf, level, width, mode, g.entries,
          getDisplaySeverityText(g.displaySeverity),
        ),
      );
    }
  }

  // 全 ClipReport を merge
  const mergedClip: ClipReport = new Map();
  for (const r of clipReports) {
    for (const [k, v] of r) mergedClip.set(k, v);
  }

  // [詳細] ブロック (隠れた列の逃がし)
  const opts = getWeatherWarningDisplayOptions();
  buildDetailBlock(
    buf, level, width, mode,
    displayEntries,
    mergedClip,
    {
      maxPerEntry: opts.detailMaxPerEntry,
      maxTotal: opts.detailMaxTotal,
    },
  );

  // 未知 Code ブロック — VPWW の buildUnknownCodeBlock と同じ:
  // 罫線は白系 + frame level スタイル、ラベルだけ warning アクセント
  if (info.unknownCodes.length > 0) {
    const unknownAccent = getDisplaySeverityText("nonLevelWarning")(" ! 未知 Code ");
    buf.push(frameDividerLabeledColored(level, WHITE_BORDER, unknownAccent, width));
    for (const u of info.unknownCodes) {
      const line = `  ${u.propertyType} @${u.areaName}  Code=?${u.code} timeRef=${u.timeRef} → frame warning 昇格`;
      for (const wrapped of wrapFrameLinesColored(level, WHITE_BORDER, line, width, 2)) {
        buf.push(wrapped);
      }
    }
  }

  if (info.fallback === "raw") {
    buf.push(frameDividerColored(level, WHITE_BORDER, width));
    buf.push(frameLineColored(level, WHITE_BORDER, "[巨大電文 raw fallback]", width));
  }

  // footer (VPWW と同じ: type / 発表時刻 / 発表官署、罫線は tailColor = 白系)
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, tailColor);
  buf.push(frameBottomFn());
  flushWithRecap(buf, level, width, tailColor);
}

function renderCompactOnlyFallback(
  buf: ReturnType<typeof createRenderBuffer>,
  info: ParsedWeatherWarningTimeseriesInfo,
  level: FrameLevel,
  width: number,
): void {
  // Phase 3: バナー本文 helper を流用して最大概況を 1 行にまとめる
  //   (旧 `最大: {label} (Code XX)` 形式は Code 番号付きで A2 と乖離していたため廃止)
  // 本文罫線は白系 (VPWW 言語)
  const summary = buildWeatherWarningBannerText(info, { maxWidth: width - 4 });
  buf.push(frameLineColored(level, WHITE_BORDER, summary, width));
  if (info.unknownCodes.length > 0) {
    const distinct = Array.from(new Set(info.unknownCodes.map((u) => u.code)));
    buf.push(
      frameLineColored(
        level,
        WHITE_BORDER,
        `未知 Code: ${distinct.map((c) => `?${c}`).join(", ")} (frame warning 昇格)`,
        width,
      ),
    );
  }
  buf.push(frameLineColored(level, WHITE_BORDER, `Area: ${info.areas.length}地域`, width));
  buf.push(frameDividerColored(level, WHITE_BORDER, width));
  buf.push(
    frameLineColored(level, WHITE_BORDER, "[巨大電文のため section 表示を省略しました (compact-only)]", width),
  );
}

// ── banner (Phase 1-F) ──

/** Property.Type から base 名 (危険度 suffix を落とした) を取る */
function bannerBaseName(kindType: string): string {
  return KIND_NAME_MAP[kindType]?.base ?? kindType.replace(/危険度$/, "");
}

/**
 * バナー本文を部品単位で組み立てる (M1 ハイブリッド、Phase B: displaySeverity ベース)。
 * opts.maxWidth が指定された場合、本文長が maxWidth を超えるなら以下の順に部品を削る:
 *   優先度 4 (注釈) → 3 (ピーク) → 2 (地域) → 1 (tier 記号 + 種別、絶対削らない)
 * 部品落とし後も足りない場合は最後の手段として clipToVisualWidth で末尾省略。
 *
 * 代表は info.maxDisplayRankSignificancy / info.maxDisplaySeverity。収集フィルタも
 * resolveVpwp50Significancy(value.info)?.displaySeverity === maxDs で揃える (Codex C2)。
 */
export function buildWeatherWarningBannerText(
  info: ParsedWeatherWarningTimeseriesInfo,
  opts: { maxWidth?: number } = {},
): string {
  const parent = info.targetArea?.name ?? "";

  if (info.infoType === "取消") {
    const text = `気象警報・注意報 取消 ${parent}`.trim();
    return opts.maxWidth != null ? clipToVisualWidth(text, opts.maxWidth) : text;
  }

  const max = info.maxDisplayRankSignificancy;
  const maxDs = info.maxDisplaySeverity;
  if (max == null || maxDs == null) {
    const text = `気象情報 ${parent}`.trim();
    return opts.maxWidth != null ? clipToVisualWidth(text, opts.maxWidth) : text;
  }

  const topSeverity = max.severity;
  const tierMark = getDisplaySeverityTierPrefix(maxDs);
  // 代表 displaySeverity の公式レベル (officialLN → N、それ以外は null)
  const officialMatch = maxDs.match(/^officialL(\d)$/);
  const officialLevel = officialMatch ? parseInt(officialMatch[1], 10) : null;

  // displaySeverity ベースで Significancy 群を収集
  type Entry = { kindType: string; areaName: string; peakLabel: string | null };
  const entries: Entry[] = [];
  for (const area of info.areas) {
    for (const tsNum of [1, 2, 3] as WeatherWarningTimeseriesNumber[]) {
      for (const kind of area.kinds[tsNum]) {
        const sv = kind.significancyWorst;
        if (sv == null) continue;
        const visit = (value: SignificancyValue | undefined, localAreaName?: string): void => {
          if (value == null) return;
          if (!value.info.known) return;
          // Phase B (g): displaySeverity 一致で収集
          if (resolveVpwp50Significancy(value.info)?.displaySeverity !== maxDs) return;
          const peakLabel = value.peak ? `${value.peak.date}${value.peak.term}` : null;
          entries.push({
            kindType: kind.type,
            areaName: localAreaName ? `${area.name}/${localAreaName}` : area.name,
            peakLabel,
          });
        };
        if (sv.base) visit(sv.base);
        if (sv.locals) for (const lv of sv.locals) visit(lv.value, lv.areaName);
      }
    }
  }

  if (entries.length === 0) {
    const text = `${tierMark} ${parent}`.trim();
    return opts.maxWidth != null ? clipToVisualWidth(text, opts.maxWidth) : text;
  }

  const distinctKinds = Array.from(new Set(entries.map((e) => e.kindType)));
  const distinctAreas = Array.from(new Set(entries.map((e) => e.areaName)));
  const area = distinctAreas.length === 1 ? distinctAreas[0] : parent;

  const primary = entries[0];
  const primaryBase = bannerBaseName(primary.kindType);

  // 種別ラベル (連結 or 件数化)。L 表記は後置注釈 (目視ゲート 2026-06-11)。
  // 収集フィルタが displaySeverity === maxDs なので、ここに来る種別は全て同一
  // displaySeverity = 同一公式レベル — 連結時も注釈は末尾 1 回で曖昧さがない。
  const N = distinctKinds.length;
  let kindsLabel: string;
  let annotation = "";  // 部品 4: (主要種別) 注釈
  const tierSuffix = topSeverity === "special" ? "特別警報" : "警報";
  const labelForKind = (kindType: string): string =>
    officialLevel != null
      ? `${bannerBaseName(kindType)} (L${officialLevel})`
      : normalizeKindName(kindType, topSeverity);

  if (N === 1) {
    kindsLabel = labelForKind(primary.kindType);
  } else if (N <= 3) {
    const bases = distinctKinds.map((k) => bannerBaseName(k));
    // L 注釈は末尾 1 回 (例: "土砂災害・高潮 (L4)")。
    // grade 系は従来どおり "大雨・洪水・暴風警報" (suffix は末尾 1 回)。
    kindsLabel =
      officialLevel != null
        ? `${bases.join("・")} (L${officialLevel})`
        : `${bases.join("・")}${tierSuffix}`;
    annotation = `(${primaryBase})`;
  } else {
    kindsLabel = `${labelForKind(primary.kindType)} ほか ${N - 1} 件`;
  }

  const peakStr = primary.peakLabel ? `ピーク ${primary.peakLabel}` : "";

  // 部品単位で組み立て、優先度順に落とす
  const parts1 = `${tierMark} ${kindsLabel}`;  // 部品 1 (必須)
  const parts2 = area;                          // 部品 2
  const parts3 = peakStr;                       // 部品 3
  const parts4 = annotation;                    // 部品 4

  const join = (p: string[]): string => p.filter((s) => s.length > 0).join("　");

  let text = join([parts1, parts2, parts3, parts4]);
  if (opts.maxWidth == null) return text;

  // 段階的に削る
  if (visualWidth(text) <= opts.maxWidth) return text;
  text = join([parts1, parts2, parts3]);  // 注釈を削る
  if (visualWidth(text) <= opts.maxWidth) return text;
  text = join([parts1, parts2]);  // ピークを削る
  if (visualWidth(text) <= opts.maxWidth) return text;
  text = join([parts1]);  // 地域を削る
  if (visualWidth(text) <= opts.maxWidth) return text;
  // それでも超えるなら末尾省略
  return clipToVisualWidth(text, opts.maxWidth);
}

/**
 * 気象警報・注意報バナーを描画する (EEW 同形の 3 行色面)。
 * 上下: 空白行、中央: 本文行。すべて色面 (displaySeverity chip ロール経由)。
 *
 * Phase B (f): 色は displaySeverity から drawSeverityBanner (theme) が chip 色を解決する
 * (VPWW drawBanner と同じ)。取消は severity="release"。旧 3 role 直引きは廃止。
 *
 * Phase C: 実体は drawSeverityBanner (weather-warning-level-theme) に共有化。
 * VPWS50 バナー (Task 8) も同じ色面を使う。export は互換維持のため残す。
 */
export function drawWeatherWarningBanner(
  severity: DisplaySeverity,
  bannerText: string,
  width: number,
): [string, string, string] {
  return drawSeverityBanner(severity, bannerText, width);
}

/**
 * 気象警報・注意報時系列情報 (VPWP50) を表示する。
 * compact / normal の 2 モードに対応。
 */
export function displayWeatherWarningTimeseriesInfo(
  info: ParsedWeatherWarningTimeseriesInfo,
): void {
  const level = weatherWarningTimeseriesFrameLevel(info);
  displayNormalResponsive(info, level);
}
