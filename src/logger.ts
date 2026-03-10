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

export function debug(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.DEBUG) {
    console.log(chalk.gray(`  [DEBUG] ${msg}`), ...args);
  }
}

export function info(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.INFO) {
    console.log(chalk.white(`  ${msg}`), ...args);
  }
}

export function warn(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.WARN) {
    console.log(chalk.yellow(`  ${msg}`), ...args);
  }
}

export function error(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.ERROR) {
    console.log(chalk.red(`  ${msg}`), ...args);
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
