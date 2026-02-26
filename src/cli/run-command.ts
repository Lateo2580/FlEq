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
import { startMonitor } from "../app/start-monitor";
import * as log from "../logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: VERSION } = require("../../package.json") as {
  version: string;
};

export async function runMonitor(opts: {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  debug: boolean;
}): Promise<void> {
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
    log.error(
      "APIキーが指定されていません。--api-key オプション、環境変数 DMDATA_API_KEY、または config set apiKey で設定してください。"
    );
    process.exit(1);
  }

  // 分類区分の解析 (CLI > Configファイル > デフォルト)
  let classifications: Classification[];
  if (opts.classifications != null) {
    classifications = opts.classifications
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Classification =>
        VALID_CLASSIFICATIONS.includes(s as Classification)
      );
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
    log.error(`無効なテストモード: ${testMode}`);
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
      opts.keepExisting ??
      fileConfig.keepExistingConnections ??
      DEFAULT_CONFIG.keepExistingConnections,
    tableWidth: fileConfig.tableWidth ?? DEFAULT_CONFIG.tableWidth,
    notify: { ...DEFAULT_CONFIG.notify, ...fileConfig.notify },
  };

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

  printBanner(config);
  await startMonitor(config);
}

/** 起動バナー表示 */
function printBanner(config: AppConfig): void {
  console.log();
  console.log(
    chalk.cyan.bold(
      `${config.appName} v${VERSION} — Project DM-D.S.S リアルタイム地震・津波情報モニター`
    )
  );
  console.log();
  log.info(`受信区分: ${config.classifications.join(", ")}`);
  log.info(`テストモード: ${config.testMode}`);
  log.info("接続を開始します...");
  console.log();
}
