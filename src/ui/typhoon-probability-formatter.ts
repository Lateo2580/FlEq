import chalk from "chalk";
import type { ParsedTyphoonProbability } from "../types";
import * as theme from "./theme";
import {
  createRenderBuffer,
  flushWithRecap,
  frameTopColored,
  frameBottomColored,
  frameLineColored,
  frameDividerColored,
  frameDividerLabeledColored,
  getFrameWidth,
  SEVERITY_LABELS,
  renderFooter,
  visualWidth,
  stripAnsi,
} from "./formatter";
import { getDisplaySeverityText } from "./weather-warning-level-theme";
import {
  aggregateByPrefecture,
  pickThreshold,
  TARGET_ROWS,
} from "../engine/presentation/typhoon-probability-aggregate";
import { pushFrameTable, type FrameTableColumn } from "./frame-table-builder";

const WHITE_BORDER = chalk.rgb(232, 232, 232);

function jstHourLabel(iso: string): string {
  const m = iso.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2})/);
  if (m == null) return "";
  return `${m[1]}/${m[2]} ${m[3]}時頃`;
}

function peakLabel(peak: ParsedTyphoonProbability["regions"][number]["peak"]): string {
  switch (peak.kind) {
    case "value": {
      const s = jstHourLabel(peak.time);
      return peak.ties.length >= 3 ? s + "*" : s;
    }
    case "allZero":
      return "—";
    case "noData":
      return peak.reason === "missingTimeDefines" ? "(時系列なし)" : "(欠落)";
  }
}

function nameLabel(info: ParsedTyphoonProbability): string {
  if (info.name?.name) {
    return `${info.name.name} (${info.name.nameKana ?? ""})`;
  }
  return info.name?.remark ?? "";
}

const MAX_SAMPLE_CODES = 3; // 各 note 行の例示コード上限
const MAX_NOTE_LINES = 3; // 表示する note 行数の上限

function pushDiagnosticsNote(
  buf: ReturnType<typeof createRenderBuffer>,
  level: "normal" | "cancel",
  color: (s: string) => string,
  width: number,
  info: ParsedTyphoonProbability,
): void {
  const d = info.parserDiagnostics;
  const notes: string[] = [];
  if (d.duplicateCodes.length > 0) {
    const sample = d.duplicateCodes.slice(0, MAX_SAMPLE_CODES).join(", ");
    const suffix =
      d.duplicateCodes.length > MAX_SAMPLE_CODES
        ? ` (ほか ${d.duplicateCodes.length - MAX_SAMPLE_CODES} 件)`
        : "";
    notes.push(`[警告] 地域コード重複: ${sample}${suffix}`);
  }
  if (d.dailyAnomalies.length > 0) {
    const sample = d.dailyAnomalies
      .slice(0, MAX_SAMPLE_CODES)
      .map((a) => a.areaCode)
      .join(", ");
    const suffix =
      d.dailyAnomalies.length > MAX_SAMPLE_CODES
        ? ` (ほか ${d.dailyAnomalies.length - MAX_SAMPLE_CODES} 件)`
        : "";
    notes.push(`[警告] daily 単調性違反: ${sample}${suffix}`);
  }
  if (d.sectionCodeCountMismatch) {
    notes.push("[警告] 全6セクションの地域コード集合に不一致");
  }
  if (d.unknownAttributes.length > 0) {
    const sample = d.unknownAttributes.slice(0, MAX_SAMPLE_CODES).join(", ");
    const suffix =
      d.unknownAttributes.length > MAX_SAMPLE_CODES
        ? ` (ほか ${d.unknownAttributes.length - MAX_SAMPLE_CODES} 件)`
        : "";
    notes.push(`[情報] 想定外属性: ${sample}${suffix}`);
  }
  if (notes.length === 0) return;
  buf.push(frameDividerLabeledColored(level, color, "▸ 注記", width));
  // 警告を先に push しているので、4 件超過時は [情報] が落ちる (priority drop)
  for (const n of notes.slice(0, MAX_NOTE_LINES)) {
    buf.push(frameLineColored(level, color, `   ${n}`, width));
  }
}

function renderTrailer(
  info: ParsedTyphoonProbability,
  level: "normal" | "cancel",
  color: (s: string) => string,
  buf: ReturnType<typeof createRenderBuffer>,
  width: number,
): void {
  renderFooter(
    level,
    info.type,
    info.reportDateTime ?? "",
    info.publishingOffice ?? "",
    width,
    buf,
    color,
  );
  buf.push(frameBottomColored(level, color, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width, color);
}

export function displayTyphoonProbabilityInfo(info: ParsedTyphoonProbability): void {
  const width = getFrameWidth();
  const buf = createRenderBuffer();
  const isCancel = info.infoType === "取消";
  const level: "normal" | "cancel" = isCancel ? "cancel" : "normal";
  const color = isCancel ? getDisplaySeverityText("release") : WHITE_BORDER;

  buf.pushEmpty();
  buf.push(frameTopColored(level, color, width));
  if (info.isTest) {
    buf.push(frameLineColored(level, color, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }
  const label = nameLabel(info);
  const headline =
    chalk.bold("台風の暴風域に入る確率") +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`) +
    (label ? chalk.white(`  ${label}`) : "");
  buf.pushTitle(frameLineColored(level, color, headline, width));
  buf.push(frameDividerColored(level, color, width));

  if (isCancel) {
    buf.push(frameLineColored(level, color, "この台風情報は取り消されました", width));
    pushDiagnosticsNote(buf, level, color, width, info);
    renderTrailer(info, level, color, buf, width);
    return;
  }

  // 集約: 後続 sub-task で `aggregateByPrefecture` を呼ぶ。
  // 現時点では「いずれかの region の daily[4] > 0」かどうかで空状態判定する。
  const hasActive = info.regions.some((r) => (r.daily[4] ?? 0) > 0);
  if (!hasActive) {
    buf.push(frameLineColored(level, color, "暴風域に入る確率が1%以上の地域はありません", width));
    if (info.name != null) {
      buf.push(frameLineColored(level, color, `(120時間先まで予測対象 / ${nameLabel(info)})`, width));
    } else {
      buf.push(frameLineColored(level, color, "(120時間先まで予測対象)", width));
    }
    pushDiagnosticsNote(buf, level, color, width, info);
    renderTrailer(info, level, color, buf, width);
    return;
  }

  // ─── オーバービュー（4 列 + minWidth + redundancy 排除） ───
  const aggs = aggregateByPrefecture(info.regions);
  const active = aggs.filter((a) => a.maxDaily5 > 0);
  const threshold = pickThreshold(active, TARGET_ROWS);
  const baseVisible = active.filter((a) => a.maxDaily5 >= threshold);
  const isCompact = info.fallback === "compactOnly";
  const visible = isCompact ? baseVisible.slice(0, 10) : baseVisible;
  const hiddenCount = active.length - visible.length;

  buf.push(
    frameDividerLabeledColored(
      level,
      color,
      "▸ 暴風域に入る確率（府県別・5日内 / 確率順）",
      width,
    ),
  );
  if (isCompact) {
    buf.push(
      frameLineColored(
        level,
        color,
        chalk.bgGray.white(" [省略] ") + " 表示量制限のため要約",
        width,
      ),
    );
  }

  const FOUR_COL_DEF: FrameTableColumn[] = [
    { header: "府県", minWidth: 12 },
    { header: "最悪地域", minWidth: 10, emptyPlaceholder: "" },
    { header: "確率", minWidth: 5 },
    { header: "ピーク", minWidth: 10 },
  ];
  const THREE_COL_DEF: FrameTableColumn[] = [
    { header: "府県", minWidth: 12 },
    { header: "確率", minWidth: 5 },
    { header: "ピーク", minWidth: 10 },
  ];

  // 4 列 minTotal: 12 + 10 + 5 + 10 + 列間 3*3 = 46
  // 内側幅 = width - 4 - indent(6) = width - 10
  const FOUR_COL_NEED = 12 + 10 + 5 + 10 + 3 * 3;
  const innerForOverview = width - 4 - 6;
  const useFourCol = innerForOverview >= FOUR_COL_NEED;
  const columns = useFourCol ? FOUR_COL_DEF : THREE_COL_DEF;

  const rows: (string | null | undefined)[][] = visible.map((a) => {
    const isSameName = a.prefName === a.worstRegion.areaName;
    const prob = `${a.maxDaily5}%`;
    const probColored = a.maxDaily5 >= 50 ? chalk.bold.yellow(prob) : prob;
    if (useFourCol) {
      return [
        a.prefName,
        isSameName ? "" : a.worstRegion.areaName,
        probColored,
        peakLabel(a.worstPeak),
      ];
    }
    return [a.prefName, probColored, peakLabel(a.worstPeak)];
  });
  pushFrameTable(buf, level, width, columns, rows, color, 6);

  if (hiddenCount > 0) {
    const hidden = active.slice(visible.length);
    const minProb = hidden[hidden.length - 1].maxDaily5;
    const maxProb = hidden[0].maxDaily5;
    buf.push(
      frameLineColored(
        level,
        color,
        `   …ほか ${hiddenCount}府県 (${minProb}〜${maxProb}%)`,
        width,
      ),
    );
  }

  // 同率ピーク凡例
  const hasTies = visible.some(
    (a) => a.worstPeak.kind === "value" && a.worstPeak.ties.length >= 3,
  );
  if (hasTies) {
    buf.push(
      frameLineColored(level, color, "   * 同確率が複数時刻に存在", width),
    );
  }

  // ─── 二次細分内訳 ───
  if (!isCompact) {
    const high = visible.filter((a) => a.maxDaily5 >= 80);
    const detailTargets = high.length > 0 ? high : visible.slice(0, 3);
    if (detailTargets.length > 0) {
      buf.push(
        frameDividerLabeledColored(
          level,
          color,
          "▸ 高確率府県の内訳（二次細分・5日内%）",
          width,
        ),
      );
      for (const agg of detailTargets) {
        const allItems = agg.regions
          .filter((r) => (r.daily[4] ?? 0) > 0 && r.areaName !== agg.prefName)
          .map((r) => {
            const prob = `${r.daily[4]}%`;
            const probColored = (r.daily[4] ?? 0) >= 50 ? chalk.bold.yellow(prob) : prob;
            return `${r.areaName} ${probColored}`;
          });
        if (allItems.length === 0) continue;

        // 見出し行: ◇ 府県名
        buf.push(frameLineColored(level, color, `   ◇ ${chalk.bold.cyan(agg.prefName)}`, width));

        // 地域行: items を item 単位でパックして折り返す (ANSI 保持 + 地域名境界保護)
        const MAX_LINES = 3;
        const innerWidth = width - 4; // フレーム内の有効幅
        const ITEM_PREFIX = "      "; // 6 スペース (◇ 見出しより 1 段深い)
        const prefixWidth = visualWidth(ITEM_PREFIX);
        const SEPARATOR_COLORED = ` ${chalk.gray("|")} `;
        const SEPARATOR_WIDTH = 3; // " | " の視覚幅

        // items を 1 行に収まる分だけ詰めて折り返す。
        // 折り返し点では trailing ` |` を付けて「次行へ続く」意図を可視化する。
        // 最終行 (続きがない) は trailing `|` なし。
        // TRAILING_PIPE_WIDTH: 折り返し行末に付く " |" の視覚幅 (スペース + "|" = 2)
        const TRAILING_PIPE_WIDTH = 2;
        function packLines(items: string[]): string[] {
          const result: string[] = [];
          let current: string[] = [];
          let currentWidth = prefixWidth;
          for (const item of items) {
            const itemWidth = visualWidth(stripAnsi(item));
            const sepCost = current.length === 0 ? 0 : SEPARATOR_WIDTH;
            // trailing " |" の幅を予約して判定する。
            // これにより折り返し行が innerWidth を超えるのを防ぐ。
            if (currentWidth + sepCost + itemWidth + TRAILING_PIPE_WIDTH <= innerWidth) {
              current.push(item);
              currentWidth += sepCost + itemWidth;
            } else {
              // 確定: この行を出力し、trailing " |" を付与 (続行を示す)
              const joined = current.join(SEPARATOR_COLORED);
              result.push(ITEM_PREFIX + joined + ` ${chalk.gray("|")}`);
              current = [item];
              currentWidth = prefixWidth + itemWidth;
            }
          }
          // 最終行: trailing `|` なし
          if (current.length > 0) {
            result.push(ITEM_PREFIX + current.join(SEPARATOR_COLORED));
          }
          return result;
        }

        let visibleItems = allItems;
        let hiddenItemCount = 0;
        let packedLines: string[] = [];
        while (true) {
          const candidate =
            hiddenItemCount > 0
              ? [...visibleItems, `…ほか ${hiddenItemCount} 地域`]
              : visibleItems;
          packedLines = packLines(candidate);
          if (packedLines.length <= MAX_LINES || visibleItems.length <= 1) break;
          hiddenItemCount++;
          visibleItems = visibleItems.slice(0, visibleItems.length - 1);
        }
        for (const line of packedLines) {
          buf.push(frameLineColored(level, color, line, width));
        }
      }
    }
  }

  pushDiagnosticsNote(buf, level, color, width, info);
  renderTrailer(info, level, color, buf, width);
}
