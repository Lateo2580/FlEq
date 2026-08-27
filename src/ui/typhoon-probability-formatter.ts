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
  pushWrappedFrameLine,
  pushWrappedFrameTitle,
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
    notes.push(`[警告] 地域コード重複: ${d.duplicateCodes.join(", ")}`);
  }
  if (d.dailyAnomalies.length > 0) {
    const codes = d.dailyAnomalies.map((a) => a.areaCode).join(", ");
    notes.push(`[警告] daily 単調性違反: ${codes}`);
  }
  if (d.sectionCodeCountMismatch) {
    notes.push("[警告] 全6セクションの地域コード集合に不一致");
  }
  if (d.unknownAttributes.length > 0) {
    notes.push(`[情報] 想定外属性: ${d.unknownAttributes.join(", ")}`);
  }
  if (notes.length === 0) return;
  buf.push(frameDividerLabeledColored(level, color, "▸ 注記", width));
  for (const n of notes) {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "diagnostic", borderColor: color },
      `   ${n}`,
    );
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
    if (chalk.level === 0) {
      buf.push(frameLineColored(level, color, " テスト電文 ", width));
    } else {
      pushWrappedFrameLine(
        buf,
        level,
        { width, purpose: "type", borderColor: color },
        theme.getRoleChalk("testBadge")(" テスト電文 "),
      );
    }
  }
  const label = nameLabel(info);
  const titleBasePart = {
    text: chalk.bold("台風の暴風域に入る確率"), priority: 0 as const, omission: "never" as const,
  };
  const titleInfoPart = {
    text: chalk.gray(info.infoType), priority: 1 as const, omission: "never" as const,
  };
  const titleSeverityPart = {
    text: chalk.gray(SEVERITY_LABELS[level]), priority: 2 as const, omission: "drop" as const,
  };
  const titleNamePart = label === "" ? null : {
    text: chalk.white(label), priority: 1 as const, omission: "never" as const,
  };
  const titleParts = titleNamePart == null
    ? [titleBasePart, titleInfoPart, titleSeverityPart]
    : [titleBasePart, titleInfoPart, titleSeverityPart, titleNamePart];
  pushWrappedFrameTitle(buf, level, { width, borderColor: color }, titleParts);
  buf.push(frameDividerColored(level, color, width));

  if (isCancel) {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "diagnostic", borderColor: color },
      "この台風情報は取り消されました",
    );
    pushDiagnosticsNote(buf, level, color, width, info);
    renderTrailer(info, level, color, buf, width);
    return;
  }

  // 集約: 後続 sub-task で `aggregateByPrefecture` を呼ぶ。
  // 現時点では「いずれかの region の daily[4] > 0」かどうかで空状態判定する。
  const hasActive = info.regions.some((r) => (r.daily[4] ?? 0) > 0);
  if (!hasActive) {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "prose", borderColor: color },
      "暴風域に入る確率が1%以上の地域はありません",
    );
    if (info.name != null) {
      pushWrappedFrameLine(
        buf,
        level,
        { width, purpose: "prose", borderColor: color },
        `(120時間先まで予測対象 / ${nameLabel(info)})`,
      );
    } else {
      pushWrappedFrameLine(
        buf,
        level,
        { width, purpose: "prose", borderColor: color },
        "(120時間先まで予測対象)",
      );
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
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "prose", borderColor: color },
      chalk.bgGray.white(" [省略] ") + " 表示量制限のため要約",
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
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "region", borderColor: color },
      `   …ほか ${hiddenCount}府県 (${minProb}〜${maxProb}%)`,
    );
  }

  // 同率ピーク凡例
  const hasTies = visible.some(
    (a) => a.worstPeak.kind === "value" && a.worstPeak.ties.length >= 3,
  );
  if (hasTies) {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "prose", borderColor: color },
      "   * 同確率が複数時刻に存在",
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
        pushWrappedFrameLine(
          buf,
          level,
          { width, purpose: "region", borderColor: color },
          `   ◇ ${chalk.bold.cyan(agg.prefName)}`,
        );

        // 地域行: items を item 単位でパックして折り返す (ANSI 保持 + 地域名境界保護)
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

        const packedLines = packLines(allItems);
        for (const line of packedLines) {
          pushWrappedFrameLine(
            buf,
            level,
            { width, purpose: "region", borderColor: color },
            line,
          );
        }
      }
    }
  }

  pushDiagnosticsNote(buf, level, color, width, info);
  renderTrailer(info, level, color, buf, width);
}
