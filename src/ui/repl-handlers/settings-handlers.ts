import chalk from "chalk";
import { DisplayMode, PromptClock, EewLogField, TruncationLimits, DEFAULT_CONFIG } from "../../types";
import { VALID_EEW_LOG_FIELDS, VALID_TRUNCATION_KEYS } from "../../config";
import { NOTIFY_CATEGORY_LABELS } from "../../engine/notification/notifier";
import {
  setFrameWidth,
  clearFrameWidth,
  setInfoFullText,
  setDisplayMode,
  getDisplayMode,
  setMaxObservations,
  getMaxObservations,
  setTruncation,
  getTruncation,
} from "../formatter";
import * as themeModule from "../theme";
import { compileFilter, FilterSyntaxError, FilterTypeError, FilterFieldError } from "../../engine/filter";
import { WINDOW_MINUTES } from "../../engine/messages/summary-tracker";
import { formatSummaryInterval } from "../summary-interval-formatter";
import type { ReplContext } from "./types";
import { CATEGORY_ALIASES } from "./info-handlers";

/** EEW ログ記録項目の表示ラベル */
const EEW_LOG_FIELD_LABELS: Record<EewLogField, string> = {
  hypocenter: "震源情報",
  originTime: "発生時刻",
  coordinates: "緯度・経度",
  magnitude: "M値・深さ",
  forecastIntensity: "最大予測震度",
  maxLgInt: "最大予測長周期階級",
  forecastAreas: "予測震度地域リスト",
  lgIntensity: "地域別長周期階級",
  isPlum: "PLUM法フラグ",
  hasArrived: "主要動到達フラグ",
  diff: "差分情報",
  maxIntChangeReason: "震度変化理由",
};

/** EEW ログ記録項目のグループ定義 */
const EEW_LOG_FIELD_GROUPS: { label: string; fields: EewLogField[] }[] = [
  { label: "震源", fields: ["hypocenter", "originTime", "coordinates"] },
  { label: "規模", fields: ["magnitude"] },
  { label: "変化", fields: ["diff", "maxIntChangeReason"] },
  { label: "予測概要", fields: ["forecastIntensity", "maxLgInt"] },
  { label: "予測地域", fields: ["forecastAreas", "lgIntensity", "isPlum", "hasArrived"] },
];

/** 省略上限キーの日本語ラベル */
const TRUNCATION_LABELS: Record<keyof TruncationLimits, string> = {
  seismicTextLines: "地震テキスト本文",
  nankaiTroughLines: "南海トラフ本文",
  volcanoAlertLines: "火山警報本文",
  volcanoEruptionLines: "火山観測報本文",
  volcanoTextLines: "火山解説情報本文",
  volcanoAshfallQuickLines: "降灰速報(VFVO54)本文",
  volcanoAshfallDetailLines: "降灰詳細(VFVO55)本文",
  volcanoAshfallRegularLines: "降灰定時(VFVO53)本文",
  volcanoPreventionLines: "火山警報 防災事項",
  ashfallAreasQuick: "降灰速報(VFVO54) 地域数",
  ashfallAreasOther: "降灰予報 地域数",
  ashfallPeriodsQuick: "降灰速報(VFVO54) 時間帯数",
  ashfallPeriodsOther: "降灰予報 時間帯数",
  plumeWindSampleRows: "噴煙流向報 風向データ行数",
  tsunamiCompactForecastAreas: "津波compact 予報地域数",
};

/** 時間文字列をミリ秒に変換 (例: "30m" → 1800000, "1h" → 3600000, "90s" → 90000) */
function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    default: return null;
  }
}

/** ミリ秒を人間可読な時間文字列に変換 */
function formatDuration(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}分${sec}秒` : `${min}分`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hour}時間${remMin}分` : `${hour}時間`;
}

/** フィルタのエラー表示 */
function printFilterError(err: unknown): void {
  if (err instanceof FilterSyntaxError) {
    console.log(chalk.red(`  ${err.format()}`));
  } else if (err instanceof FilterFieldError) {
    console.log(chalk.red(`  ${err.format()}`));
  } else if (err instanceof FilterTypeError) {
    console.log(chalk.red(`  ${err.message}`));
  } else {
    console.log(chalk.red(`  エラー: ${err instanceof Error ? err.message : err}`));
  }
}

/** カテゴリ名を解決する (case-insensitive + エイリアス) */
function resolveNotifyCategory(input: string): import("../../types").NotifyCategory | null {
  const lower = input.toLowerCase();
  for (const cat of Object.keys(NOTIFY_CATEGORY_LABELS)) {
    if (cat.toLowerCase() === lower) return cat as import("../../types").NotifyCategory;
  }
  return CATEGORY_ALIASES[lower] ?? null;
}

// ── コマンドハンドラ ──

export function handleNotify(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const settings = ctx.notifier.getSettings();
    console.log();
    console.log(chalk.cyan.bold("  通知設定:"));
    if (ctx.notifier.isMuted()) {
      const remaining = ctx.notifier.muteRemaining();
      console.log(chalk.yellow(`  (ミュート中: 残り ${formatDuration(remaining)})`));
    }
    console.log();
    for (const [cat, label] of Object.entries(NOTIFY_CATEGORY_LABELS)) {
      const enabled = settings[cat as import("../../types").NotifyCategory];
      const status = enabled
        ? chalk.green("ON")
        : chalk.red("OFF");
      const alias = Object.entries(CATEGORY_ALIASES)
        .find(([, v]) => v === cat)?.[0];
      const aliasPart = alias != null ? chalk.gray(` (${alias})`) : "";
      console.log(
        chalk.white(`  ${cat.padEnd(14)}`) +
          chalk.gray(`${label}  `) +
          status +
          aliasPart
      );
    }
    console.log();
    console.log(
      chalk.gray("  使い方: notify <category> [on|off] / notify all:on / notify all:off")
    );
    console.log();
    return;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "all:on" || lower === "aon") {
    ctx.notifier.setAll(true);
    console.log(chalk.green("  全通知を有効にしました"));
    return;
  }
  if (lower === "all:off" || lower === "aoff") {
    ctx.notifier.setAll(false);
    console.log(chalk.yellow("  全通知を無効にしました"));
    return;
  }

  const parts = trimmed.split(/\s+/);
  const cat = resolveNotifyCategory(parts[0]);
  const action = parts[1]?.toLowerCase();

  if (cat == null) {
    console.log(
      chalk.yellow(`  不明なカテゴリ: ${parts[0]}`) +
        chalk.gray(` (有効: ${Object.keys(NOTIFY_CATEGORY_LABELS).join(", ")})`)
    );
    return;
  }

  let newState: boolean;
  if (action === "on") {
    const settings = ctx.notifier.getSettings();
    if (settings[cat]) {
      console.log(`  ${NOTIFY_CATEGORY_LABELS[cat]} (${cat}): 既に ${chalk.green("ON")} です`);
      return;
    }
    newState = ctx.notifier.toggleCategory(cat);
  } else if (action === "off") {
    const settings = ctx.notifier.getSettings();
    if (!settings[cat]) {
      console.log(`  ${NOTIFY_CATEGORY_LABELS[cat]} (${cat}): 既に ${chalk.red("OFF")} です`);
      return;
    }
    newState = ctx.notifier.toggleCategory(cat);
  } else {
    newState = ctx.notifier.toggleCategory(cat);
  }

  const label = NOTIFY_CATEGORY_LABELS[cat];
  const status = newState ? chalk.green("ON") : chalk.red("OFF");
  console.log(`  ${label} (${cat}): ${status}`);
}

export function handleTableWidth(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    if (ctx.config.tableWidth == null) {
      const cols = process.stdout.columns ?? 60;
      console.log(`  現在のテーブル幅: auto (ターミナル幅: ${cols})`);
    } else {
      console.log(`  現在のテーブル幅: ${ctx.config.tableWidth} (固定)`);
    }
    console.log(chalk.gray("  使い方: tablewidth <40〜200> / tablewidth auto"));
    return;
  }

  if (trimmed.toLowerCase() === "auto") {
    ctx.config.tableWidth = null;
    clearFrameWidth();
    ctx.updateConfig((c) => { delete c.tableWidth; });
    const cols = process.stdout.columns ?? 60;
    console.log(`  テーブル幅を auto に変更しました。(現在のターミナル幅: ${cols})`);
    return;
  }

  const width = Number(trimmed);
  if (isNaN(width) || !Number.isInteger(width) || width < 40 || width > 200) {
    console.log(chalk.yellow("  tableWidth は 40〜200 の整数、または auto を指定してください。"));
    return;
  }

  ctx.config.tableWidth = width;
  setFrameWidth(width);
  ctx.updateConfig((c) => { c.tableWidth = width; });
  console.log(`  テーブル幅を ${width} に変更しました。`);
}

export function handleInfoText(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const current = ctx.config.infoFullText ? "full (全文表示)" : "short (省略表示)";
    console.log(`  お知らせ電文表示: ${current}`);
    console.log(chalk.gray("  使い方: infotext full / infotext short"));
    return;
  }

  const infoLower = trimmed.toLowerCase();
  if (infoLower === "full") {
    ctx.config.infoFullText = true;
    setInfoFullText(true);
    ctx.updateConfig((c) => { c.infoFullText = true; });
    console.log("  お知らせ電文を全文表示に変更しました。");
  } else if (infoLower === "short") {
    ctx.config.infoFullText = false;
    setInfoFullText(false);
    ctx.updateConfig((c) => { c.infoFullText = false; });
    console.log("  お知らせ電文を省略表示に変更しました。");
  } else {
    console.log(chalk.yellow("  full または short を指定してください。"));
  }
}

export function handleMode(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const current = getDisplayMode();
    console.log(`  表示モード: ${current}`);
    console.log(chalk.gray("  使い方: mode normal / mode compact"));
    return;
  }

  const modeLower = trimmed.toLowerCase();
  if (modeLower !== "normal" && modeLower !== "compact") {
    console.log(chalk.yellow(`  無効なモード: ${trimmed}`) + chalk.gray(" (normal / compact)"));
    return;
  }

  const mode = modeLower as DisplayMode;
  ctx.config.displayMode = mode;
  setDisplayMode(mode);
  ctx.updateConfig((c) => { c.displayMode = mode; });
  console.log(`  表示モードを ${mode} に変更しました。`);
}

export function handleFilter(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();
  const ctrl = ctx.pipelineController;

  if (trimmed.length === 0) {
    if (ctrl?.getPipeline().filter == null) {
      console.log(`  フィルタ: ${chalk.gray("無効")}`);
    } else {
      console.log(`  フィルタ: ${chalk.green("有効")}`);
      console.log(`  式: ${ctrl.getFilterExpr() ?? "(CLI起動時に設定)"}`);
      if (ctx.filterUpdatedAt != null) {
        const ts = ctx.filterUpdatedAt.toLocaleString("ja-JP");
        console.log(`  最終更新: ${ts}`);
      }
    }
    console.log(chalk.gray("  使い方: filter set <expr> / filter clear / filter test <expr>"));
    return;
  }

  const [sub, ...rest] = trimmed.split(/\s+/);
  const subLower = sub.toLowerCase();

  if (subLower === "clear") {
    ctrl?.clearFilter();
    ctx.filterExpr = null;
    ctx.filterUpdatedAt = null;
    console.log("  フィルタを解除しました。");
    return;
  }

  if (subLower === "test") {
    const expr = rest.join(" ").trim();
    if (expr.length === 0) {
      console.log(chalk.yellow("  式を指定してください。") + chalk.gray(" 例: filter test domain = \"eew\""));
      return;
    }
    try {
      compileFilter(expr);
      console.log(chalk.green("  構文OK") + chalk.gray(` — ${expr}`));
    } catch (err) {
      printFilterError(err);
    }
    return;
  }

  if (subLower === "set") {
    const expr = rest.join(" ").trim();
    if (expr.length === 0) {
      console.log(chalk.yellow("  式を指定してください。") + chalk.gray(" 例: filter set domain = \"eew\""));
      return;
    }
    if (ctrl == null) {
      console.log(chalk.yellow("  フィルタパイプラインが利用できません。"));
      return;
    }
    try {
      ctrl.setFilter(expr);
      ctx.filterExpr = expr;
      ctx.filterUpdatedAt = new Date();
      console.log(chalk.green("  フィルタを適用しました。") + chalk.gray(` — ${expr}`));
    } catch (err) {
      printFilterError(err);
    }
    return;
  }

  console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`) + chalk.gray(" (set / clear / test)"));
}

export function handleFocus(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();
  const ctrl = ctx.pipelineController;

  if (trimmed.length === 0) {
    if (ctrl?.getPipeline().focus == null) {
      console.log(`  フォーカス: ${chalk.gray("無効")}`);
    } else {
      console.log(`  フォーカス: ${chalk.green("有効")}`);
      console.log(`  式: ${ctrl.getFocusExpr() ?? "(CLI起動時に設定)"}`);
      if (ctx.focusUpdatedAt != null) {
        const ts = ctx.focusUpdatedAt.toLocaleString("ja-JP");
        console.log(`  最終更新: ${ts}`);
      }
    }
    console.log(chalk.gray("  使い方: focus <expr> / focus off"));
    return;
  }

  if (trimmed.toLowerCase() === "off") {
    ctrl?.clearFocus();
    ctx.focusExpr = null;
    ctx.focusUpdatedAt = null;
    console.log("  フォーカスを解除しました。");
    return;
  }

  if (ctrl == null) {
    console.log(chalk.yellow("  フォーカスパイプラインが利用できません。"));
    return;
  }
  try {
    ctrl.setFocus(trimmed);
    ctx.focusExpr = trimmed;
    ctx.focusUpdatedAt = new Date();
    console.log(chalk.green("  フォーカスを適用しました。") + chalk.gray(` — ${trimmed}`));
  } catch (err) {
    printFilterError(err);
  }
}

export function handleClock(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const current = ctx.statusLine.getClockMode();
    const next: PromptClock = current === "elapsed" ? "clock" : "elapsed";
    ctx.statusLine.setClockMode(next);
    ctx.config.promptClock = next;
    ctx.updateConfig((c) => { c.promptClock = next; });
    const label = next === "clock" ? "現在時刻" : "経過時間";
    console.log(`  プロンプト時計を ${label} に切り替えました。`);
    return;
  }

  const clockLower = trimmed.toLowerCase();
  if (clockLower === "elapsed") {
    ctx.statusLine.setClockMode("elapsed");
    ctx.config.promptClock = "elapsed";
    ctx.updateConfig((c) => { c.promptClock = "elapsed"; });
    console.log("  プロンプト時計を 経過時間 に変更しました。");
  } else if (clockLower === "now") {
    ctx.statusLine.setClockMode("clock");
    ctx.config.promptClock = "clock";
    ctx.updateConfig((c) => { c.promptClock = "clock"; });
    console.log("  プロンプト時計を 現在時刻 に変更しました。");
  } else {
    console.log(chalk.yellow("  elapsed または now を指定してください。"));
  }
}

export function handleTipInterval(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    console.log(`  待機中ヒント間隔: ${ctx.config.waitTipIntervalMin}分`);
    console.log(chalk.gray("  使い方: tipinterval <0〜1440> (0で無効)"));
    return;
  }

  const min = Number(trimmed);
  if (isNaN(min) || !Number.isInteger(min) || min < 0 || min > 1440) {
    console.log(chalk.yellow("  tipinterval は 0〜1440 の整数を指定してください。"));
    return;
  }

  ctx.config.waitTipIntervalMin = min;
  ctx.tipIntervalMs = min * 60 * 1000;
  ctx.resetTipSchedule();
  ctx.updateConfig((c) => { c.waitTipIntervalMin = min; });
  if (min === 0) {
    console.log("  待機中ヒントを無効化しました。");
    return;
  }
  console.log(`  待機中ヒント間隔を ${min}分 に変更しました。`);
}

export function handleNight(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const current = themeModule.isNightMode();
    const status = current ? chalk.green("ON") : chalk.red("OFF");
    console.log(`  ナイトモード: ${status}`);
    console.log(chalk.gray("  使い方: night on / night off"));
    return;
  }

  const sub = trimmed.toLowerCase();
  if (sub === "on") {
    themeModule.setNightMode(true);
    ctx.config.nightMode = true;
    console.log(`  ナイトモードを ${chalk.green("ON")} にしました。`);
  } else if (sub === "off") {
    themeModule.setNightMode(false);
    ctx.config.nightMode = false;
    console.log(`  ナイトモードを ${chalk.red("OFF")} にしました。`);
  } else {
    console.log(chalk.yellow("  on または off を指定してください。"));
  }
}

export function handleSummary(ctx: ReplContext, args: string): void {
  if (ctx.summaryTracker == null) {
    console.log(chalk.yellow("  要約トラッカーが利用できません。"));
    return;
  }

  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? "";

  if (trimmed.length === 0) {
    if (ctx.summaryIntervalMin != null) {
      console.log(`  定期要約: ${chalk.green("ON")} (${ctx.summaryIntervalMin}分間隔)`);
    } else {
      console.log(`  定期要約: ${chalk.red("OFF")}`);
    }
    console.log(chalk.gray("  使い方: summary on [N] / summary off / summary now"));
    return;
  }

  if (sub === "now") {
    if (ctx.summaryTimerControl != null) {
      ctx.summaryTimerControl.showNow();
    } else {
      const snapshot = ctx.summaryTracker.getSnapshot();
      const output = formatSummaryInterval(snapshot, WINDOW_MINUTES, true);
      console.log(output);
    }
    return;
  }

  if (sub === "on") {
    const minuteStr = parts[1];
    let minutes = 10;
    if (minuteStr != null) {
      const parsed = parseInt(minuteStr, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        minutes = parsed;
      }
    }
    ctx.summaryIntervalMin = minutes;
    ctx.config.summaryInterval = minutes;
    ctx.summaryTimerControl?.start(minutes);
    console.log(`  定期要約を ${chalk.green("ON")} にしました (${minutes}分間隔)。`);
    return;
  }

  if (sub === "off") {
    ctx.summaryIntervalMin = null;
    ctx.config.summaryInterval = null;
    ctx.summaryTimerControl?.stop();
    console.log(`  定期要約を ${chalk.red("OFF")} にしました。`);
    return;
  }

  console.log(chalk.yellow("  使い方: summary on [N] / summary off / summary now"));
}

export function handleSound(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const current = ctx.notifier.getSoundEnabled();
    const status = current ? chalk.green("ON") : chalk.red("OFF");
    console.log(`  通知音: ${status}`);
    console.log(chalk.gray("  使い方: sound on / sound off"));
    return;
  }

  const soundLower = trimmed.toLowerCase();
  if (soundLower === "on") {
    ctx.notifier.setSoundEnabled(true);
    console.log(`  通知音を ${chalk.green("ON")} にしました。`);
  } else if (soundLower === "off") {
    ctx.notifier.setSoundEnabled(false);
    console.log(`  通知音を ${chalk.red("OFF")} にしました。`);
  } else {
    console.log(chalk.yellow("  on または off を指定してください。"));
  }
}

export function handleFold(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const current = getMaxObservations();
    if (current == null) {
      console.log("  観測点表示: 全件表示");
    } else {
      console.log(`  観測点表示: 上位 ${current} 件に制限`);
    }
    console.log(chalk.gray("  使い方: fold <N> / fold off"));
    return;
  }

  if (trimmed.toLowerCase() === "off") {
    setMaxObservations(null);
    ctx.config.maxObservations = null;
    ctx.updateConfig((c) => { delete c.maxObservations; });
    console.log("  観測点表示を全件表示に戻しました。");
    return;
  }

  const n = Number(trimmed);
  if (isNaN(n) || !Number.isInteger(n) || n < 1 || n > 999) {
    console.log(chalk.yellow("  1〜999 の整数、または off を指定してください。"));
    return;
  }

  setMaxObservations(n);
  ctx.config.maxObservations = n;
  ctx.updateConfig((c) => { c.maxObservations = n; });
  console.log(`  観測点表示を上位 ${n} 件に制限しました。`);
}

export function handleLimit(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const current = getTruncation();
    const defaults = DEFAULT_CONFIG.truncation;
    console.log("  省略表示の上限設定:");
    console.log();

    const linesKeys: (keyof TruncationLimits)[] = [
      "seismicTextLines", "nankaiTroughLines",
      "volcanoAlertLines", "volcanoEruptionLines", "volcanoTextLines",
      "volcanoAshfallQuickLines", "volcanoAshfallDetailLines", "volcanoAshfallRegularLines",
      "volcanoPreventionLines",
    ];
    const countKeys: (keyof TruncationLimits)[] = [
      "ashfallAreasQuick", "ashfallAreasOther",
      "ashfallPeriodsQuick", "ashfallPeriodsOther",
      "plumeWindSampleRows", "tsunamiCompactForecastAreas",
    ];

    const printGroup = (label: string, keys: (keyof TruncationLimits)[]): void => {
      console.log(chalk.gray(`  [${label}]`));
      for (const key of keys) {
        const val = current[key];
        const def = defaults[key];
        const changed = val !== def;
        const valStr = changed ? chalk.yellow(String(val)) : String(val);
        const desc = TRUNCATION_LABELS[key];
        console.log(`  ${key.padEnd(30)} ${valStr.padStart(changed ? 14 : 4)}  ${chalk.gray(`(default: ${def})`)}  ${chalk.gray(desc)}`);
      }
    };

    printGroup("本文行数", linesKeys);
    console.log();
    printGroup("件数", countKeys);
    console.log();
    console.log(chalk.gray("  使い方: limit <key> <N> / limit <key> default / limit reset"));
    console.log(chalk.gray("  ※ infotext full 時は本文行数制限は無効になります"));
    return;
  }

  if (trimmed.toLowerCase() === "reset") {
    const defaults = { ...DEFAULT_CONFIG.truncation };
    setTruncation(defaults);
    ctx.config.truncation = defaults;
    ctx.updateConfig((c) => { delete c.truncation; });
    console.log("  省略上限設定を全てデフォルトに戻しました。");
    return;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    console.log(chalk.yellow("  使い方: limit <key> <N> / limit <key> default / limit reset"));
    return;
  }

  const [keyStr, valueStr] = parts;
  if (!VALID_TRUNCATION_KEYS.includes(keyStr as keyof TruncationLimits)) {
    console.log(chalk.yellow(`  不明なキー: ${keyStr}`));
    console.log(chalk.gray("  有効なキー: limit で一覧表示"));
    return;
  }
  const tKey = keyStr as keyof TruncationLimits;

  if (valueStr.toLowerCase() === "default") {
    const defaults = DEFAULT_CONFIG.truncation;
    const newTrunc = { ...getTruncation(), [tKey]: defaults[tKey] };
    setTruncation(newTrunc);
    ctx.config.truncation = newTrunc;
    ctx.updateConfig((c) => {
      if (c.truncation != null) {
        delete c.truncation[tKey];
        if (Object.keys(c.truncation).length === 0) {
          delete c.truncation;
        }
      }
    });
    console.log(`  ${tKey} をデフォルト (${defaults[tKey]}) に戻しました。`);
    return;
  }

  const num = Number(valueStr);
  if (isNaN(num) || !Number.isInteger(num) || num < 1 || num > 999) {
    console.log(chalk.yellow("  1〜999 の整数、または default を指定してください。"));
    return;
  }

  const newTrunc = { ...getTruncation(), [tKey]: num };
  setTruncation(newTrunc);
  ctx.config.truncation = newTrunc;
  ctx.updateConfig((c) => {
    if (c.truncation == null) c.truncation = {};
    c.truncation[tKey] = num;
  });
  console.log(`  ${tKey} を ${num} に変更しました。`);
}

export function handleMute(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    if (ctx.notifier.isMuted()) {
      const remaining = ctx.notifier.muteRemaining();
      console.log(`  ミュート中: 残り ${formatDuration(remaining)}`);
    } else {
      console.log("  ミュートなし");
    }
    console.log(chalk.gray("  使い方: mute <duration> (例: 30m, 1h, 90s) / mute off"));
    return;
  }

  if (trimmed.toLowerCase() === "off") {
    ctx.notifier.unmute();
    console.log("  ミュートを解除しました。");
    return;
  }

  const ms = parseDuration(trimmed);
  if (ms == null || ms <= 0) {
    console.log(chalk.yellow("  無効な時間指定です。例: 30m, 1h, 90s"));
    return;
  }

  ctx.notifier.mute(ms);
  console.log(`  通知を ${formatDuration(ms)} ミュートしました。`);
}

export function handleEewLog(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const enabled = ctx.eewLogger.isEnabled();
    const status = enabled ? chalk.green("ON") : chalk.red("OFF");
    console.log();
    console.log(chalk.cyan.bold("  EEW ログ記録:") + ` ${status}`);
    if (enabled) {
      console.log();
      const fields = ctx.eewLogger.getFields();
      for (const group of EEW_LOG_FIELD_GROUPS) {
        console.log(chalk.cyan(`  [${group.label}]`));
        for (const field of group.fields) {
          const fieldEnabled = fields[field];
          const fieldStatus = fieldEnabled ? chalk.green("ON") : chalk.red("OFF");
          console.log(
            chalk.white(`    ${field.padEnd(22)}`) +
              chalk.gray(`${EEW_LOG_FIELD_LABELS[field]}  `) +
              fieldStatus
          );
        }
      }
    }
    console.log();
    console.log(
      chalk.gray("  使い方: eewlog on/off / eewlog fields / eewlog fields <field> [on|off]")
    );
    console.log();
    return;
  }

  const eewlogLower = trimmed.toLowerCase();
  if (eewlogLower === "on") {
    ctx.eewLogger.setEnabled(true);
    ctx.config.eewLog = true;
    ctx.updateConfig((c) => { c.eewLog = true; });
    console.log(`  EEW ログ記録を ${chalk.green("ON")} にしました。`);
    return;
  }
  if (eewlogLower === "off") {
    ctx.eewLogger.setEnabled(false);
    ctx.config.eewLog = false;
    ctx.updateConfig((c) => { c.eewLog = false; });
    console.log(`  EEW ログ記録を ${chalk.red("OFF")} にしました。`);
    return;
  }

  if (eewlogLower === "fields" || eewlogLower === "fld") {
    const fields = ctx.eewLogger.getFields();
    console.log();
    console.log(chalk.cyan.bold("  EEW ログ記録項目:"));
    console.log();
    for (const group of EEW_LOG_FIELD_GROUPS) {
      console.log(chalk.cyan(`  [${group.label}]`));
      for (const field of group.fields) {
        const fieldEnabled = fields[field];
        const fieldStatus = fieldEnabled ? chalk.green("ON") : chalk.red("OFF");
        console.log(
          chalk.white(`    ${field.padEnd(22)}`) +
            chalk.gray(`${EEW_LOG_FIELD_LABELS[field]}  `) +
            fieldStatus
        );
      }
    }
    console.log();
    return;
  }

  if (eewlogLower.startsWith("fields ") || eewlogLower.startsWith("fld ")) {
    const fieldsPrefixLen = eewlogLower.startsWith("fld ") ? 4 : 7;
    const parts = trimmed.slice(fieldsPrefixLen).trim().split(/\s+/);
    const fieldName = parts[0] as EewLogField;
    const action = parts[1]?.toLowerCase();

    if (!VALID_EEW_LOG_FIELDS.includes(fieldName)) {
      console.log(
        chalk.yellow(`  不明な項目: ${parts[0]}`) +
          chalk.gray(` (有効: ${VALID_EEW_LOG_FIELDS.join(", ")})`)
      );
      return;
    }

    let newState: boolean;
    const fields = ctx.eewLogger.getFields();
    if (action === "on") {
      if (fields[fieldName]) {
        console.log(`  ${EEW_LOG_FIELD_LABELS[fieldName]} (${fieldName}): 既に ${chalk.green("ON")} です`);
        return;
      }
      newState = ctx.eewLogger.toggleField(fieldName);
    } else if (action === "off") {
      if (!fields[fieldName]) {
        console.log(`  ${EEW_LOG_FIELD_LABELS[fieldName]} (${fieldName}): 既に ${chalk.red("OFF")} です`);
        return;
      }
      newState = ctx.eewLogger.toggleField(fieldName);
    } else {
      newState = ctx.eewLogger.toggleField(fieldName);
    }

    const label = EEW_LOG_FIELD_LABELS[fieldName];
    const status = newState ? chalk.green("ON") : chalk.red("OFF");
    console.log(`  ${label} (${fieldName}): ${status}`);

    ctx.updateConfig((c) => { c.eewLogFields = ctx.eewLogger.getFields(); });
    return;
  }

  console.log(chalk.yellow("  使い方: eewlog on/off / eewlog fields / eewlog fields <field> [on|off]"));
}

export function handleTheme(ctx: ReplContext, args: string): void {
  const sub = args.trim().toLowerCase();

  if (sub === "" || sub === "info") {
    const palette = themeModule.getPalette();
    console.log();
    console.log(chalk.cyan.bold("  カラーテーマ:"));
    console.log();
    const swatches = themeModule.getPaletteNames().map((name) => {
      const rgb = palette[name];
      return chalk.rgb(rgb[0], rgb[1], rgb[2])("██");
    });
    console.log(`  ${swatches.join(" ")}`);
    console.log();
    console.log(chalk.white(`  theme.json: `) + chalk.gray(themeModule.getThemePath()));
    console.log(chalk.white(`  カスタマイズ: `) + (themeModule.isCustomized() ? chalk.green("あり") : chalk.gray("なし (デフォルト)")));
    console.log();
    console.log(chalk.gray("  サブコマンド: theme path / show / reset / reload / validate"));
    console.log();
    return;
  }

  if (sub === "path") {
    console.log(`  ${themeModule.getThemePath()}`);
    return;
  }

  if (sub === "show") {
    handleThemeShow();
    return;
  }

  if (sub === "reset") {
    handleThemeReset(ctx);
    return;
  }

  if (sub === "reload") {
    const warnings = themeModule.reloadTheme();
    if (warnings.length === 0) {
      console.log(chalk.green("  テーマを再読込しました"));
    } else {
      console.log(chalk.yellow("  テーマを再読込しました (警告あり):"));
      for (const w of warnings) {
        console.log(chalk.yellow(`    ${w}`));
      }
    }
    return;
  }

  if (sub === "validate") {
    const { valid, warnings } = themeModule.validateThemeFile();
    if (valid && warnings.length === 0) {
      console.log(chalk.green("  theme.json に問題はありません"));
    } else if (valid) {
      console.log(chalk.yellow("  theme.json の検証結果:"));
      for (const w of warnings) {
        console.log(chalk.yellow(`    ${w}`));
      }
    } else {
      console.log(chalk.red("  theme.json に問題があります:"));
      for (const w of warnings) {
        console.log(chalk.red(`    ${w}`));
      }
    }
    return;
  }

  console.log(chalk.yellow(`  不明なサブコマンド: ${args.trim()}`));
  console.log(chalk.gray("  使い方: theme / theme path / theme show / theme reset / theme reload / theme validate"));
}

function handleThemeShow(): void {
  const palette = themeModule.getPalette();

  console.log();
  console.log(chalk.cyan.bold("  パレット:"));
  console.log();
  for (const name of themeModule.getPaletteNames()) {
    const rgb = palette[name];
    const swatch = chalk.rgb(rgb[0], rgb[1], rgb[2])("██");
    const hex = themeModule.rgbToHex(rgb);
    console.log(`  ${swatch} ${chalk.white(name.padEnd(12))} ${chalk.gray(hex)}`);
  }

  console.log();
  console.log(chalk.cyan.bold("  ロール:"));
  console.log();
  const roleNames = themeModule.getRoleNames();
  const maxNameLen = Math.max(...roleNames.map((n) => n.length));
  for (const name of roleNames) {
    const style = themeModule.getRoleChalk(name);
    const resolved = themeModule.getRole(name);
    const parts: string[] = [];
    if (resolved.fg) parts.push(`fg: ${themeModule.rgbToHex(resolved.fg)}`);
    if (resolved.bg) parts.push(`bg: ${themeModule.rgbToHex(resolved.bg)}`);
    if (resolved.bold) parts.push("bold");
    const preview = style("Sample");
    console.log(
      `  ${chalk.white(name.padEnd(maxNameLen + 1))} ${preview}  ${chalk.gray(parts.join(", "))}`
    );
  }
  console.log();
}

function handleThemeReset(ctx: ReplContext): void {
  if (!ctx.rl) return;
  const rl = ctx.rl;
  rl.question(
    chalk.yellow("  デフォルトの theme.json を書き出しますか？ (y/N) "),
    (answer: string) => {
      if (answer.trim().toLowerCase() === "y") {
        try {
          const warnings = themeModule.resetTheme();
          console.log(chalk.green(`  theme.json を書き出しました: ${themeModule.getThemePath()}`));
          if (warnings.length > 0) {
            for (const w of warnings) {
              console.log(chalk.yellow(`    ${w}`));
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "不明なエラー";
          console.log(chalk.red(`  theme.json の書き出しに失敗しました: ${msg}`));
        }
      } else {
        console.log(chalk.gray("  キャンセルしました"));
      }
      rl.setPrompt(ctx.buildPromptString());
      rl.prompt();
    }
  );
}
