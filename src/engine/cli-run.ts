import chalk from "chalk";
import {
  AppConfig,
  Classification,
  ConfigFile,
  DEFAULT_CONFIG,
} from "../types";
import {
  loadConfig,
  getConfigPath,
  VALID_CLASSIFICATIONS,
} from "../config";
import { listContracts } from "../dmdata/rest-client";
import { startMonitor } from "./monitor";
import { setFrameWidth, setInfoFullText, setDisplayMode } from "../ui/formatter";
import * as updateChecker from "./update-checker";
import * as log from "../logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: VERSION } = require("../../package.json") as {
  version: string;
};

/** runMonitor に渡す CLI オプション */
export interface RunMonitorOptions {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  closeOthers?: boolean;
  mode?: string;
  debug: boolean;
}

export async function runMonitor(opts: RunMonitorOptions): Promise<void> {
  // ログレベル設定
  if (opts.debug) {
    log.setLogLevel(log.LogLevel.DEBUG);
  }

  // Configファイル読み込み
  const fileConfig: ConfigFile = loadConfig();
  log.debug(`Config: ${getConfigPath()}`);

  // APIキー (CLI > 環境変数 > Configファイル)
  const apiKey = opts.apiKey || process.env.DMDATA_API_KEY || fileConfig.apiKey;
  if (!apiKey) {
    log.error("APIキーが指定されていません。");
    console.log();
    console.log(chalk.white("  以下のいずれかの方法で設定してください:"));
    console.log(chalk.gray("    1. ") + chalk.white("fleq init") + chalk.gray("           — インタラクティブセットアップ"));
    console.log(chalk.gray("    2. ") + chalk.white("fleq config set apiKey <key>") + chalk.gray(" — 直接設定"));
    console.log(chalk.gray("    3. ") + chalk.white("fleq --api-key <key>") + chalk.gray("         — CLI引数で指定"));
    console.log(chalk.gray("    4. ") + chalk.white("DMDATA_API_KEY=<key>") + chalk.gray("         — 環境変数で指定"));
    console.log();
    process.exit(1);
  }

  // 分類区分の解析 (CLI > Configファイル > デフォルト)
  let classifications: Classification[];
  if (opts.classifications != null) {
    const allTokens = opts.classifications.split(",").map((s) => s.trim());
    const valid: Classification[] = [];
    const invalid: string[] = [];
    for (const token of allTokens) {
      if (VALID_CLASSIFICATIONS.includes(token as Classification)) {
        valid.push(token as Classification);
      } else if (token.length > 0) {
        invalid.push(token);
      }
    }
    if (invalid.length > 0) {
      log.warn(`無効な区分を無視しました: ${invalid.join(", ")}`);
      log.warn(`有効な値: ${VALID_CLASSIFICATIONS.join(", ")}`);
    }
    classifications = valid;
  } else if (fileConfig.classifications != null) {
    classifications = fileConfig.classifications;
  } else {
    classifications = DEFAULT_CONFIG.classifications;
  }

  if (classifications.length === 0) {
    log.error(`有効な区分が指定されていません。`);
    log.error(`有効な値: ${VALID_CLASSIFICATIONS.join(", ")}`);
    process.exit(1);
  }

  // テストモード (CLI > Configファイル > デフォルト)
  const testMode: "no" | "including" | "only" =
    opts.test != null
      ? (opts.test as "no" | "including" | "only")
      : fileConfig.testMode ?? DEFAULT_CONFIG.testMode;

  if (!["no", "including", "only"].includes(testMode)) {
    log.error(`無効なテストモード: ${testMode} (有効な値: no, including, only)`);
    process.exit(1);
  }

  // 表示モード (CLI > Configファイル > デフォルト)
  const displayModeRaw = opts.mode ?? fileConfig.displayMode ?? DEFAULT_CONFIG.displayMode;
  if (displayModeRaw !== "normal" && displayModeRaw !== "compact") {
    log.error(`無効な表示モード: ${displayModeRaw} (有効な値: normal, compact)`);
    process.exit(1);
  }

  const config: AppConfig = {
    apiKey,
    classifications,
    testMode,
    appName: fileConfig.appName ?? DEFAULT_CONFIG.appName,
    maxReconnectDelaySec:
      fileConfig.maxReconnectDelaySec ?? DEFAULT_CONFIG.maxReconnectDelaySec,
    keepExistingConnections:
      opts.closeOthers === true
        ? false
        : (
            opts.keepExisting ??
            fileConfig.keepExistingConnections ??
            DEFAULT_CONFIG.keepExistingConnections
          ),
    tableWidth: fileConfig.tableWidth ?? null,
    infoFullText: fileConfig.infoFullText ?? DEFAULT_CONFIG.infoFullText,
    displayMode: displayModeRaw,
    promptClock: fileConfig.promptClock ?? DEFAULT_CONFIG.promptClock,
    waitTipIntervalMin: fileConfig.waitTipIntervalMin ?? DEFAULT_CONFIG.waitTipIntervalMin,
    notify: { ...DEFAULT_CONFIG.notify, ...fileConfig.notify },
    sound: fileConfig.sound ?? DEFAULT_CONFIG.sound,
  };

  // Banner title (契約チェック前に表示)
  console.log();
  console.log(
    chalk.cyan.bold.inverse(
      `${config.appName} v${VERSION} — Project DM-D.S.S リアルタイム地震・津波情報モニター`
    )
  );
  console.log();

  // 契約状況チェック
  try {
    const contractedClassifications = await listContracts(apiKey);
    const skipped = classifications.filter(
      (c) => !contractedClassifications.includes(c)
    );
    const active = classifications.filter((c) =>
      contractedClassifications.includes(c)
    );

    for (const s of skipped) {
      log.warn(`${s} は未契約のためスキップします`);
    }

    if (active.length === 0) {
      log.error(
        "有効な契約区分がありません。dmdata.jp で区分を契約してください。"
      );
      process.exit(1);
    }

    config.classifications = active as Classification[];
  } catch (err) {
    log.warn(
      `契約状況の確認に失敗しました: ${err instanceof Error ? err.message : err}`
    );
    log.warn("指定された区分のまま接続を試みます");
  }

  // formatter キャッシュ初期化
  if (config.tableWidth != null) {
    setFrameWidth(config.tableWidth);
  }
  setInfoFullText(config.infoFullText ?? false);
  setDisplayMode(config.displayMode);

  printBanner(config);
  updateChecker.checkForUpdates("fleq", VERSION);
  await startMonitor(config);
}

/** 起動バナー表示 */
function printBanner(config: AppConfig): void {
  log.info(`受信区分: ${config.classifications.join(", ")}`);
  log.info(`テストモード: ${config.testMode}`);
  if (config.displayMode !== "normal") {
    log.info(`表示モード: ${config.displayMode}`);
  }
  log.info("接続を開始します...");
  console.log();
}
