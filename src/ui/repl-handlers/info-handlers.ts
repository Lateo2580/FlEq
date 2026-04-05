import chalk from "chalk";
import { DEFAULT_CONFIG, TruncationLimits, NotifyCategory } from "../../types";
import { listEarthquakes, listContracts, listSockets } from "../../dmdata/rest-client";
import { printConfig } from "../../config";
import { NOTIFY_CATEGORY_LABELS } from "../../engine/notification/notifier";
import {
  intensityColor,
  lgIntensityColor,
  visualPadEnd,
  visualWidth,
  getDisplayMode,
  getTruncation,
} from "../formatter";
import * as themeModule from "../theme";
import { displayStatistics } from "../statistics-formatter";
import type { ReplContext, CommandCategory } from "./types";
import { CATEGORY_LABELS } from "./types";

// ── ヘルパー (モジュール内のみ) ──

/** ISO 文字列を "MM-DD HH:mm:ss" に整形 (テーブル用短縮形) */
function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 文字列を視覚幅で指定幅に切り詰める */
function truncate(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visualWidth(str) <= maxWidth) return str;

  const ellipsis = "\u2026";
  const ellipsisWidth = visualWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsis;

  const targetWidth = maxWidth - ellipsisWidth;
  let result = "";
  let width = 0;

  for (const ch of str) {
    const chWidth = visualWidth(ch);
    if (width + chWidth > targetWidth) break;
    result += ch;
    width += chWidth;
  }

  return result + ellipsis;
}

/** GdEarthquakeItem から深さ文字列を生成 */
function formatDepth(item: import("../../types").GdEarthquakeItem): string {
  if (item.hypocenter?.depth?.value != null) {
    const val = item.hypocenter.depth.value;
    const unit = item.hypocenter.depth.unit || "km";
    return `${val}${unit}`;
  }
  return "---";
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

/** 震度キーから対応するロール名を返す */
function getIntensityRole(key: string): themeModule.RoleName | null {
  const map: Record<string, themeModule.RoleName> = {
    "1": "intensity1", "2": "intensity2", "3": "intensity3", "4": "intensity4",
    "5弱": "intensity5Lower", "5強": "intensity5Upper",
    "6弱": "intensity6Lower", "6強": "intensity6Upper", "7": "intensity7",
  };
  return map[key] ?? null;
}

/** 長周期階級キーから対応するロール名を返す */
function getLgIntRole(key: string): themeModule.RoleName | null {
  const map: Record<string, themeModule.RoleName> = {
    "0": "lgInt0", "1": "lgInt1", "2": "lgInt2", "3": "lgInt3", "4": "lgInt4",
  };
  return map[key] ?? null;
}

/**
 * fg/bg 分離表示用のセルを生成する。
 */
function renderFgBgItem(
  label: string,
  fg: readonly [number, number, number],
  bg: readonly [number, number, number],
  style: chalk.Chalk,
): { cell: string; visualLen: number } {
  const fgBlock = chalk.rgb(fg[0], fg[1], fg[2])("██");
  const bgBlock = chalk.bgRgb(bg[0], bg[1], bg[2])("  ");
  return { cell: `${fgBlock} ${bgBlock} ${style(label)}`, visualLen: visualWidth(label) + 6 };
}

/**
 * 色付きアイテムをターミナル幅に応じたマルチカラムで出力する。
 */
function printColorGrid<T>(
  termWidth: number,
  items: T[],
  renderFn: (item: T) => { cell: string; visualLen: number },
): void {
  const rendered = items.map(renderFn);
  const maxVisual = Math.max(...rendered.map((r) => r.visualLen));
  const colWidth = maxVisual + 3;
  const indent = 2;
  const cols = Math.max(1, Math.floor((termWidth - indent) / colWidth));

  let line = "";
  let col = 0;
  for (const r of rendered) {
    const pad = colWidth - r.visualLen;
    line += r.cell + " ".repeat(Math.max(0, pad));
    col++;
    if (col >= cols) {
      console.log(`${" ".repeat(indent)}${line}`);
      line = "";
      col = 0;
    }
  }
  if (line.length > 0) {
    console.log(`${" ".repeat(indent)}${line}`);
  }
}

/** コマンドのエイリアス (逆引き用) */
export const COMMAND_ALIASES: Record<string, string> = {
  cmds: "commands",
  hist: "history",
  cols: "colors",
  det: "detail",
  stat: "status",
  conf: "config",
  cont: "contract",
  sock: "socket",
  noti: "notify",
  ewlg: "eewlog",
  tw: "tablewidth",
  itxt: "infotext",
  tint: "tipinterval",
  snd: "sound",
  thm: "theme",
  bkup: "backup",
  lim: "limit",
  cls: "clear",
};

/** 通知カテゴリ名のエイリアス (短縮形 → 正式名) */
export const CATEGORY_ALIASES: Record<string, NotifyCategory> = {
  eq: "earthquake",
  tsu: "tsunami",
  st: "seismicText",
  nt: "nankaiTrough",
  lgob: "lgObservation",
};

/** 設定変更可能なコマンドの現在値と設定可能な値を返す */
export function getCurrentSettingValues(ctx: ReplContext): Record<string, { current: string; options?: string }> {
  const { config, notifier, eewLogger, statusLine } = ctx;

  const notifySettings = notifier.getSettings();
  const onCount = Object.values(notifySettings).filter(Boolean).length;
  const totalCount = Object.keys(notifySettings).length;
  const muteInfo = notifier.isMuted() ? `, ミュート中` : "";

  return {
    night: {
      current: themeModule.isNightMode() ? "ON" : "OFF",
      options: "on / off",
    },
    sound: {
      current: notifier.getSoundEnabled() ? "ON" : "OFF",
      options: "on / off",
    },
    tablewidth: {
      current: config.tableWidth == null
        ? `auto (${process.stdout.columns ?? 60})`
        : `${config.tableWidth} (固定)`,
      options: "40〜200 / auto",
    },
    infotext: {
      current: config.infoFullText ? "full" : "short",
      options: "full / short",
    },
    tipinterval: {
      current: config.waitTipIntervalMin === 0
        ? "無効"
        : `${config.waitTipIntervalMin}分`,
      options: "0〜1440 (0で無効)",
    },
    mode: {
      current: getDisplayMode(),
      options: "normal / compact",
    },
    clock: {
      current: (() => {
        const m = statusLine.getClockMode();
        return m === "clock" ? "現在時刻" : m === "uptime" ? "稼働時間" : "経過時間";
      })(),
      options: "elapsed / now / uptime",
    },
    notify: {
      current: `${onCount}/${totalCount} ON${muteInfo}`,
      options: "eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation",
    },
    mute: {
      current: notifier.isMuted()
        ? `残り ${formatDuration(notifier.muteRemaining())}`
        : "OFF",
      options: "<duration> (例: 30m, 1h, 90s) / off",
    },
    eewlog: {
      current: eewLogger.isEnabled()
        ? (() => {
          const fields = eewLogger.getFields();
          const onCount = Object.values(fields).filter(Boolean).length;
          return `ON (${onCount}/${Object.keys(fields).length}項目)`;
        })()
        : "OFF",
      options: "on / off / fields",
    },
    limit: {
      current: (() => {
        const t = config.truncation;
        const d = DEFAULT_CONFIG.truncation;
        const changed = (Object.keys(d) as (keyof TruncationLimits)[])
          .filter((k) => t[k] !== d[k]).length;
        return changed > 0 ? `${changed}項目変更済` : "デフォルト";
      })(),
      options: "limit で詳細表示",
    },
  };
}

// ── コマンドハンドラ ──

export function handleDetail(ctx: ReplContext, args: string): void {
  const sub = args.trim().toLowerCase();

  if (sub === "" || sub === "tsunami") {
    const provider = ctx.detailProviders.find((p) => p.category === "tsunami");
    if (provider == null || !provider.hasDetail()) {
      console.log(chalk.gray("  現在、継続中の津波情報はありません。"));
    } else {
      provider.showDetail();
    }
    return;
  }

  console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`) + chalk.gray(" (利用可能: tsunami)"));
}

/** カテゴリ名を解決する (日本語ラベルにも対応) */
function resolveCategory(input: string): CommandCategory | null {
  const lower = input.toLowerCase();
  const categories = Object.keys(CATEGORY_LABELS) as CommandCategory[];
  const exact = categories.find((c) => c === lower);
  if (exact != null) return exact;
  for (const cat of categories) {
    if (CATEGORY_LABELS[cat] === input) return cat;
  }
  return null;
}

export function handleCommands(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  let filterCategory: CommandCategory | null = null;
  let searchQuery: string | null = null;

  if (trimmed.length > 0) {
    filterCategory = resolveCategory(trimmed);
    if (filterCategory == null) {
      searchQuery = trimmed.toLowerCase();
    }
  }

  // 検索モード
  if (searchQuery != null) {
    const query = searchQuery;
    const matches = Object.entries(ctx.commands)
      .filter(([name]) => name !== "?" && name !== "exit" && name !== "cmds")
      .filter(([name, entry]) =>
        name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query)
      )
      .sort(([a], [b]) => a.localeCompare(b));

    if (matches.length === 0) {
      console.log(chalk.yellow(`  "${trimmed}" に一致するコマンドはありません`));
      return;
    }

    console.log();
    console.log(chalk.cyan.bold(`  検索結果: "${trimmed}"`));
    console.log(chalk.gray(`  help <command> で各コマンドの詳細を表示`));
    console.log();
    for (const [name, entry] of matches) {
      const sub = entry.subcommands != null ? chalk.cyan(" +") : "";
      const alias = Object.entries(COMMAND_ALIASES).find(([, v]) => v === name)?.[0];
      const aliasSuffix = alias != null ? chalk.gray(` (${alias})`) : "";
      console.log(
        chalk.white(`    ${name.padEnd(14)}`) + chalk.gray(entry.description) + sub + aliasSuffix
      );
    }
    console.log();
    return;
  }

  // 一覧モード
  const currentValues = getCurrentSettingValues(ctx);
  const displayed = new Set<string>();
  const categoryOrder: CommandCategory[] = ["info", "status", "settings", "operation"];
  const categories = filterCategory != null ? [filterCategory] : categoryOrder;

  console.log();
  console.log(chalk.cyan.bold("  利用可能なコマンド:"));
  console.log(chalk.gray(`  help <command> で各コマンドの詳細を表示`));

  for (const category of categories) {
    console.log();
    console.log(chalk.cyan(`  [${CATEGORY_LABELS[category]}]`));

    const commandNames = Object.keys(ctx.commands)
      .filter((name) => name !== "exit" && name !== "?" && name !== "cmds" && ctx.commands[name].category === category)
      .sort();
    for (const name of commandNames) {
      if (displayed.has(name)) continue;
      displayed.add(name);
      const entry = ctx.commands[name];
      const sub = entry.subcommands != null ? chalk.cyan(" +") : "";
      const setting = currentValues[name];
      const valueSuffix = setting != null
        ? chalk.gray(" [") + chalk.yellow(setting.current) + chalk.gray("]")
        : "";
      const alias = Object.entries(COMMAND_ALIASES).find(([, v]) => v === name)?.[0];
      const aliasSuffix = alias != null ? chalk.gray(` (${alias})`) : "";
      console.log(
        chalk.white(`    ${name.padEnd(14)}`) + chalk.gray(entry.description) + sub + aliasSuffix + valueSuffix
      );
    }
  }

  console.log();
  console.log(chalk.gray("  カテゴリ絞り込み: commands <category> / 検索: commands <query>"));
  console.log();
}

export function handleHelp(ctx: ReplContext, args: string): void {
  const trimmed = args.trim();

  if (trimmed.length > 0) {
    const parts = trimmed.split(/\s+/);
    const entry = resolveCommand(ctx, parts[0]);
    if (entry == null) {
      console.log(chalk.yellow(`  不明なコマンド: ${parts[0]}`));
      return;
    }

    if (parts.length > 1 && entry.subcommands) {
      const subInput = parts[1].toLowerCase();
      const subKey = Object.keys(entry.subcommands).find((k) => k.toLowerCase() === subInput);
      const sub = subKey != null ? entry.subcommands[subKey] : undefined;
      if (sub == null) {
        console.log(chalk.yellow(`  不明なサブコマンド: ${parts[0]} ${parts[1]}`));
        return;
      }
      console.log();
      console.log(chalk.cyan.bold(`  ${parts[0]} ${subKey}`) + chalk.gray(` — ${sub.description}`));
      if (sub.detail) {
        console.log();
        for (const line of sub.detail.split("\n")) {
          console.log(chalk.white(`  ${line}`));
        }
      }
      console.log();
      return;
    }

    console.log();
    console.log(chalk.cyan.bold(`  ${parts[0]}`) + chalk.gray(` — ${entry.description}`));
    if (entry.detail) {
      console.log();
      for (const line of entry.detail.split("\n")) {
        console.log(chalk.white(`  ${line}`));
      }
    }
    if (entry.subcommands) {
      console.log();
      const subNames = Object.keys(entry.subcommands).sort();
      for (let i = 0; i < subNames.length; i++) {
        const subName = subNames[i];
        const sub = entry.subcommands[subName];
        const prefix = i < subNames.length - 1 ? "├─" : "└─";
        console.log(
          chalk.gray(`      ${prefix} `) + chalk.white(subName.padEnd(10)) + chalk.gray(sub.description)
        );
      }
    }
    console.log();
    return;
  }

  // help — 引数なしはガイド表示
  console.log();
  console.log(chalk.cyan.bold("  help <command>") + chalk.gray(" — コマンドの詳細を表示"));
  console.log(chalk.cyan.bold("  commands") + chalk.gray("       — コマンド一覧を表示"));
  console.log();
  console.log(chalk.gray("  例: help notify, help test table, commands settings"));
  console.log();
}

export function handleStats(ctx: ReplContext): void {
  displayStatistics(ctx.stats.getSnapshot());
}

export async function handleHistory(ctx: ReplContext, args: string): Promise<void> {
  const MAX_HISTORY = 100;
  const raw = args.length > 0 ? parseInt(args, 10) : 10;
  if (isNaN(raw) || raw <= 0) {
    console.log(chalk.yellow("  件数は正の整数で指定してください"));
    return;
  }
  const limit = Math.min(raw, MAX_HISTORY);

  console.log(chalk.gray("  地震履歴を取得中..."));

  const res = await listEarthquakes(ctx.config.apiKey, limit);

  if (res.items.length === 0) {
    console.log(chalk.gray("  該当する地震情報はありません"));
    return;
  }

  const COL = { time: 18, hypo: 16, mag: 6, depth: 8, int: 8 };

  const hLine = (l: string, m: string, r: string, h: string) =>
    chalk.gray(
      `  ${l}${h.repeat(COL.time + 2)}${m}${h.repeat(COL.hypo + 2)}${m}${h.repeat(COL.mag + 2)}${m}${h.repeat(COL.depth + 2)}${m}${h.repeat(COL.int + 2)}${r}`
    );

  console.log();
  console.log(hLine("┌", "┬", "┐", "─"));
  console.log(chalk.gray("  │ ") +
    chalk.cyan(visualPadEnd("発生時刻", COL.time)) + chalk.gray(" │ ") +
    chalk.cyan(visualPadEnd("震源地", COL.hypo)) + chalk.gray(" │ ") +
    chalk.cyan(visualPadEnd("規模", COL.mag)) + chalk.gray(" │ ") +
    chalk.cyan(visualPadEnd("深さ", COL.depth)) + chalk.gray(" │ ") +
    chalk.cyan(visualPadEnd("最大震度", COL.int)) + chalk.gray(" │")
  );
  console.log(hLine("├", "┼", "┤", "─"));

  const items = [...res.items].reverse();
  for (const item of items) {
    const time = formatShortTime(item.originTime || item.arrivalTime);
    const hypo = truncate(item.hypocenter?.name || "不明", COL.hypo);
    const mag =
      item.magnitude?.value != null ? `M${item.magnitude.value}` : "M---";
    const depth = formatDepth(item);
    const maxInt = item.maxInt != null ? item.maxInt : "---";

    const intColor = item.maxInt != null ? intensityColor(item.maxInt) : chalk.gray;

    console.log(chalk.gray("  │ ") +
      chalk.white(visualPadEnd(time, COL.time)) + chalk.gray(" │ ") +
      chalk.white(visualPadEnd(hypo, COL.hypo)) + chalk.gray(" │ ") +
      chalk.yellow(visualPadEnd(mag, COL.mag)) + chalk.gray(" │ ") +
      chalk.white(visualPadEnd(depth, COL.depth)) + chalk.gray(" │ ") +
      intColor(visualPadEnd(maxInt, COL.int)) + chalk.gray(" │")
    );
  }

  console.log(hLine("└", "┴", "┘", "─"));
  console.log();
}

export function handleStatus(ctx: ReplContext): void {
  const status = ctx.wsManager.getStatus();
  console.log();
  console.log(chalk.cyan.bold("  WebSocket 接続状態:"));
  console.log(
    chalk.white("  状態: ") +
      (status.connected
        ? chalk.green.bold("接続中")
        : chalk.red.bold("切断"))
  );
  if (status.socketId != null) {
    console.log(
      chalk.white("  SocketID: ") + chalk.white(String(status.socketId))
    );
  }
  if (status.reconnectAttempt > 0) {
    console.log(
      chalk.white("  再接続試行: ") +
        chalk.yellow(`#${status.reconnectAttempt}`)
    );
  }
  if (hasBackupSupport(ctx.wsManager)) {
    if (ctx.wsManager.isBackupRunning()) {
      const backupStatus = ctx.wsManager.getBackupStatus();
      console.log(
        chalk.white("  副回線: ") +
          (backupStatus?.connected
            ? chalk.green.bold("接続中")
            : chalk.yellow("再接続中"))
      );
      if (backupStatus?.socketId != null) {
        console.log(
          chalk.white("  副回線 SocketID: ") + chalk.white(String(backupStatus.socketId))
        );
      }
    } else {
      console.log(chalk.white("  副回線: ") + chalk.gray("未起動"));
    }
  }
  console.log();
}

export function handleConfig(): void {
  printConfig();
}

export async function handleContract(ctx: ReplContext): Promise<void> {
  console.log(chalk.gray("  契約情報を取得中..."));
  const classifications = await listContracts(ctx.config.apiKey);

  console.log();
  console.log(chalk.cyan.bold("  契約済み区分:"));
  if (classifications.length === 0) {
    console.log(chalk.gray("  (なし)"));
  } else {
    for (const c of classifications) {
      console.log(chalk.white(`  - ${c}`));
    }
  }
  console.log();
}

export async function handleSocket(ctx: ReplContext): Promise<void> {
  console.log(chalk.gray("  ソケット情報を取得中..."));
  const res = await listSockets(ctx.config.apiKey);

  console.log();
  console.log(chalk.cyan.bold("  接続中のソケット:"));
  if (res.items.length === 0) {
    console.log(chalk.gray("  (なし)"));
  } else {
    for (const s of res.items) {
      console.log(
        chalk.white(`  id=${s.id}`) +
          chalk.gray(` status=${s.status}`) +
          chalk.gray(` app=${s.appName || "---"}`) +
          chalk.gray(` start=${s.start}`)
      );
    }
  }
  console.log();
}

export function handleColors(): void {
  const termWidth = process.stdout.columns || 80;
  const palette = themeModule.getPalette();

  const PALETTE_USAGE: Record<string, string> = {
    gray: "低優先度・補助テキスト",
    sky: "通常・長周期階級1",
    blue: "震度3",
    blueGreen: "震度4・津波なし",
    yellow: "震度5弱・M3+",
    orange: "警告レベル",
    vermillion: "危険レベル",
    raspberry: "取消・キャンセル",
    darkRed: "最高警戒 (背景用)",
  };

  console.log();
  console.log(chalk.cyan.bold("  CUD カラーパレット:"));
  if (themeModule.isCustomized()) {
    console.log(chalk.gray("  (カスタムテーマ適用中)"));
  }
  console.log();
  for (const name of themeModule.getPaletteNames()) {
    const rgb = palette[name];
    const swatch = chalk.rgb(rgb[0], rgb[1], rgb[2])("██");
    const rgbStr = `(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    console.log(
      `  ${swatch} ` +
      chalk.white(name.padEnd(12)) +
      chalk.gray(rgbStr.padEnd(16)) +
      chalk.gray(PALETTE_USAGE[name] ?? "")
    );
  }

  console.log();
  console.log(chalk.cyan.bold("  震度カラー:"));
  console.log();
  const intensityKeys = ["1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"];
  const intensities = intensityKeys.map((key) => {
    const label = `震度${key}`;
    const style = intensityColor(key);
    const role = getIntensityRole(key);
    const resolved = role ? themeModule.getRole(role) : null;
    return { label, key, style, resolved };
  });
  printColorGrid(termWidth, intensities, (item) => {
    if (item.resolved?.bg && item.resolved?.fg) {
      return renderFgBgItem(
        item.label,
        item.resolved.fg,
        item.resolved.bg,
        item.style,
      );
    }
    return { cell: `${item.style("██")} ${item.style(item.label)}`, visualLen: visualWidth(item.label) + 3 };
  });

  console.log();
  console.log(chalk.cyan.bold("  長周期地震動階級カラー:"));
  console.log();
  const lgIntKeys = ["0", "1", "2", "3", "4"];
  const lgInts = lgIntKeys.map((key) => {
    const label = `階級${key}`;
    const style = lgIntensityColor(key);
    const role = getLgIntRole(key);
    const resolved = role ? themeModule.getRole(role) : null;
    return { label, key, style, resolved };
  });
  printColorGrid(termWidth, lgInts, (item) => {
    if (item.resolved?.bg && item.resolved?.fg) {
      return renderFgBgItem(
        item.label,
        item.resolved.fg,
        item.resolved.bg,
        item.style,
      );
    }
    return { cell: `${item.style("██")} ${item.style(item.label)}`, visualLen: visualWidth(item.label) + 3 };
  });

  console.log();
  console.log(chalk.cyan.bold("  フレームレベル:"));
  console.log();
  const frameRoles: Array<{ name: string; role: themeModule.RoleName; label: string }> = [
    { name: "critical", role: "frameCritical", label: "[緊急] 二重線" },
    { name: "warning",  role: "frameWarning",  label: "[警告] 二重線" },
    { name: "normal",   role: "frameNormal",   label: "[情報] 通常" },
    { name: "info",     role: "frameInfo",      label: "[通知] 通常" },
    { name: "cancel",   role: "frameCancel",    label: "[取消] 通常" },
  ];
  printColorGrid(termWidth, frameRoles, (lv) => {
    const style = themeModule.getRoleChalk(lv.role);
    const text = `${lv.name} ${lv.label}`;
    return { cell: `${style("██")} ${style(text)}`, visualLen: visualWidth(text) + 3 };
  });
  console.log();
}

// ── resolveCommand (help から使う) ──

import type { CommandEntry } from "./types";
import { ConnectionManager } from "../../dmdata/connection-manager";
import { WsManagerStatus } from "../../dmdata/ws-client";
import type { StartBackupResult } from "../../dmdata/multi-connection-manager";

/** 構造的型ガード: backup 機能を持つ ConnectionManager か */
export function hasBackupSupport(m: ConnectionManager): m is ConnectionManager & {
  startBackup(): Promise<StartBackupResult>;
  stopBackup(): void;
  isBackupRunning(): boolean;
  getBackupStatus(): WsManagerStatus | null;
} {
  return (
    "startBackup" in m &&
    "stopBackup" in m &&
    "isBackupRunning" in m &&
    "getBackupStatus" in m
  );
}

/** コマンド名を解決する (case-insensitive + エイリアス) */
export function resolveCommand(ctx: ReplContext, input: string): CommandEntry | undefined {
  const lower = input.toLowerCase();
  for (const [name, entry] of Object.entries(ctx.commands)) {
    if (name.toLowerCase() === lower) return entry;
  }
  const canonical = COMMAND_ALIASES[lower];
  if (canonical != null) return ctx.commands[canonical];
  return undefined;
}
