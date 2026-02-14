#!/usr/bin/env node

import { Command } from "commander";
// dotenvのログ出力を抑制
process.env.DOTENV_CONFIG_QUIET = "true";
import dotenv from "dotenv";
dotenv.config();import chalk from "chalk";
import {
  AppConfig,
  Classification,
  ConfigFile,
  DEFAULT_CONFIG,
  WsDataMessage,
} from "./types";
import {
  loadConfig,
  setConfigValue,
  unsetConfigValue,
  printConfig,
  printConfigKeys,
  getConfigPath,
} from "./config/manager";
import { listContracts } from "./api/client";
import { WebSocketManager } from "./websocket/manager";
import { ReplHandler } from "./repl/handler";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  decodeBody,
} from "./parser/telegram";
import {
  displayEarthquakeInfo,
  displayEewInfo,
  displayRawHeader,
} from "./display/formatter";
import * as log from "./utils/logger";
import { LogLevel } from "./utils/logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: VERSION } = require("../package.json") as { version: string };

// ── CLI定義 ──

const program = new Command();

program
  .name("dmdata-monitor")
  .description(
    "Project DM-D.S.S (dmdata.jp) の地震・津波・EEW情報をリアルタイム受信・表示するCLIツール"
  )
  .version(VERSION)
  .option(
    "-k, --api-key <key>",
    "dmdata.jp APIキー (環境変数 DMDATA_API_KEY でも指定可)"
  )
  .option(
    "-c, --classifications <items>",
    "受信区分 (カンマ区切り: telegram.earthquake,eew.forecast,eew.warning)"
  )
  .option(
    "--test <mode>",
    'テスト電文: "no" | "including" | "only"'
  )
  .option("--keep-existing", "既存のWebSocket接続を維持する")
  .option("--debug", "デバッグログを表示", false)
  .action(main);

// ── config サブコマンド ──

const configCmd = program
  .command("config")
  .description("Configファイルの設定を管理する");

configCmd
  .command("show")
  .description("現在の設定を表示する")
  .action(() => {
    printConfig();
  });

configCmd
  .command("set <key> <value>")
  .description("設定値をセットする")
  .action((key: string, value: string) => {
    setConfigValue(key, value);
    log.info(`設定しました: ${key}`);
  });

configCmd
  .command("unset <key>")
  .description("設定値を削除する")
  .action((key: string) => {
    unsetConfigValue(key);
    log.info(`削除しました: ${key}`);
  });

configCmd
  .command("path")
  .description("Configファイルのパスを表示する")
  .action(() => {
    console.log(getConfigPath());
  });

configCmd
  .command("keys")
  .description("設定可能なキー一覧を表示する")
  .action(() => {
    printConfigKeys();
  });

program.parse();

// ── メイン処理 ──

async function main(opts: {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  debug: boolean;
}): Promise<void> {
  // ログレベル設定
  if (opts.debug) {
    log.setLogLevel(LogLevel.DEBUG);
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
  const validClassifications: Classification[] = [
    "telegram.earthquake",
    "eew.forecast",
    "eew.warning",
  ];

  let classifications: Classification[];
  if (opts.classifications != null) {
    classifications = opts.classifications
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as Classification[];
  } else if (fileConfig.classifications != null) {
    classifications = fileConfig.classifications;
  } else {
    classifications = DEFAULT_CONFIG.classifications;
  }

  for (const c of classifications) {
    if (!validClassifications.includes(c)) {
      log.error(`無効な区分: ${c}`);
      log.error(`有効な値: ${validClassifications.join(", ")}`);
      process.exit(1);
    }
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
      opts.keepExisting ?? fileConfig.keepExistingConnections ?? DEFAULT_CONFIG.keepExistingConnections,
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

  // 起動バナー
  printBanner(config);

  // WebSocket接続
  let replHandler: ReplHandler | null = null;

  const manager = new WebSocketManager(config, {
    onData: (msg) => {
      handleData(msg);
      if (replHandler) replHandler.refreshPrompt();
    },
    onConnected: () => {
      log.info(chalk.green("✓ リアルタイム受信中..."));
      if (replHandler) replHandler.refreshPrompt();
    },
    onDisconnected: (reason) => {
      log.warn(`切断されました: ${reason}`);
      if (replHandler) replHandler.refreshPrompt();
    },
  });

  // REPL ハンドラ
  replHandler = new ReplHandler(config, manager);

  // グレースフルシャットダウン
  const shutdown = () => {
    log.info("シャットダウン中...");
    if (replHandler) replHandler.stop();
    manager.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await manager.connect();
  replHandler.start();
}

/** 起動バナー表示 */
function printBanner(config: AppConfig): void {
  console.log();
  console.log(chalk.cyan.bold(`${config.appName} v${VERSION} — Project DM-D.S.S リアルタイム地震・津波情報モニター`));
  console.log();
  log.info(`受信区分: ${config.classifications.join(", ")}`);
  log.info(`テストモード: ${config.testMode}`);
  log.info(`接続を開始します...`);
  console.log();
}

/** 受信データのハンドリング */
function handleData(msg: WsDataMessage): void {
  // XML電文でない場合はヘッダ情報のみ表示
  if (msg.format !== "xml" || !msg.head.xml) {
    displayRawHeader(msg);
    return;
  }

  const classification = msg.classification;
  const headType = msg.head.type;

  // EEW区分
  if (
    classification === "eew.forecast" ||
    classification === "eew.warning"
  ) {
    const eewInfo = parseEewTelegram(msg);
    if (eewInfo) {
      displayEewInfo(eewInfo);
    } else {
      displayRawHeader(msg);
    }
    return;
  }

  // 地震・津波区分
  if (classification === "telegram.earthquake") {
    // 地震情報系 (VXSE51, VXSE52, VXSE53 等)
    if (headType.startsWith("VXSE")) {
      const eqInfo = parseEarthquakeTelegram(msg);
      if (eqInfo) {
        displayEarthquakeInfo(eqInfo);
      } else {
        displayRawHeader(msg);
      }
      return;
    }

    // 津波系 (VTSE41, VTSE51, VTSE52 等) - 現時点ではヘッダ表示+ヘッドライン
    if (headType.startsWith("VTSE")) {
      const eqInfo = parseEarthquakeTelegram(msg);
      if (eqInfo) {
        displayEarthquakeInfo(eqInfo);
      } else {
        displayRawHeader(msg);
      }
      return;
    }
  }

  // その他の電文
  displayRawHeader(msg);
}
