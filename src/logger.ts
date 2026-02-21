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

function timestamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}.${ms}`;
}

export function debug(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.DEBUG) {
    console.log(chalk.gray(`[${timestamp()}] [DEBUG] ${msg}`), ...args);
  }
}

export function info(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.INFO) {
    console.log(chalk.white(`[${timestamp()}] [INFO]  ${msg}`), ...args);
  }
}

export function warn(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.WARN) {
    console.log(chalk.yellow(`[${timestamp()}] [WARN]  ${msg}`), ...args);
  }
}

export function error(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.ERROR) {
    console.log(chalk.red(`[${timestamp()}] [ERROR] ${msg}`), ...args);
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
