import chalk from "chalk";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** ログ行のプレフィックスビルダー (REPL から動的に差し替え可能) */
let prefixBuilder: (() => string) | null = null;

/** ログ出力前後のフック (REPL プロンプト行クリア・再描画用) */
let logHooks: { beforeLog: () => void; afterLog: () => void } | null = null;

/** プレフィックスビルダーを設定する */
export function setLogPrefixBuilder(builder: (() => string) | null): void {
  prefixBuilder = builder;
}

/** ログ出力前後のフックを設定する */
export function setLogHooks(hooks: { beforeLog: () => void; afterLog: () => void } | null): void {
  logHooks = hooks;
}

/** 現在のプレフィックスを取得する */
function getPrefix(): string {
  if (prefixBuilder) return prefixBuilder();
  // デフォルト: 未接続状態のプレフィックス
  return chalk.gray("FlEq [○ --:--:--]> ");
}

export function debug(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.DEBUG) {
    if (logHooks) logHooks.beforeLog();
    console.log(getPrefix() + chalk.gray(`[DEBUG] ${msg}`), ...args);
    if (logHooks) logHooks.afterLog();
  }
}

export function info(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.INFO) {
    if (logHooks) logHooks.beforeLog();
    console.log(getPrefix() + chalk.white(msg), ...args);
    if (logHooks) logHooks.afterLog();
  }
}

export function warn(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.WARN) {
    if (logHooks) logHooks.beforeLog();
    console.log(getPrefix() + chalk.yellow(msg), ...args);
    if (logHooks) logHooks.afterLog();
  }
}

export function error(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.ERROR) {
    if (logHooks) logHooks.beforeLog();
    console.log(getPrefix() + chalk.red(msg), ...args);
    if (logHooks) logHooks.afterLog();
  }
}

/** 重要な地震情報向け：赤背景白文字 */
export function alert(msg: string): void {
  console.log(chalk.bgRed.white.bold(` ${msg} `));
}

/** EEW警報向け：黄背景黒文字 */
export function eewWarning(msg: string): void {
  console.log(chalk.bgYellow.black.bold(` ⚠ ${msg} `));
}

/** EEW予報向け */
export function eewForecast(msg: string): void {
  console.log(chalk.bgCyan.black(` ${msg} `));
}
