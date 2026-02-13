#!/usr/bin/env node

import { Command } from "commander";
// dotenvのログ出力を抑制
process.env.DOTENV_CONFIG_QUIET = "true";
import dotenv from "dotenv";
dotenv.config();import chalk from "chalk";
import {
  AppConfig,
  Classification,
  DEFAULT_CONFIG,
  WsDataMessage,
} from "./types";
import { WebSocketManager } from "./websocket/manager";
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

// .env ファイルの読み込み（DOTENV_CONFIG_QUIETは上で設定済み）

const VERSION = "0.1.0";

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
    "受信区分 (カンマ区切り: telegram.earthquake,eew.forecast,eew.warning)",
    "telegram.earthquake"
  )
  .option(
    "--test <mode>",
    'テスト電文: "no" | "including" | "only"',
    "no"
  )
  .option("--keep-existing", "既存のWebSocket接続を維持する", false)
  .option("--debug", "デバッグログを表示", false)
  .action(main);

program.parse();

// ── メイン処理 ──

async function main(opts: {
  apiKey?: string;
  classifications: string;
  test: string;
  keepExisting: boolean;
  debug: boolean;
}): Promise<void> {
  // ログレベル設定
  if (opts.debug) {
    log.setLogLevel(LogLevel.DEBUG);
  }

  // APIキー
  const apiKey = opts.apiKey || process.env.DMDATA_API_KEY;
  if (!apiKey) {
    log.error(
      "APIキーが指定されていません。--api-key オプションまたは環境変数 DMDATA_API_KEY を設定してください。"
    );
    process.exit(1);
  }

  // 分類区分の解析
  const classifications = opts.classifications
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Classification[];

  const validClassifications: Classification[] = [
    "telegram.earthquake",
    "eew.forecast",
    "eew.warning",
  ];
  for (const c of classifications) {
    if (!validClassifications.includes(c)) {
      log.error(`無効な区分: ${c}`);
      log.error(`有効な値: ${validClassifications.join(", ")}`);
      process.exit(1);
    }
  }

  // テストモード
  const testMode = opts.test as "no" | "including" | "only";
  if (!["no", "including", "only"].includes(testMode)) {
    log.error(`無効なテストモード: ${testMode}`);
    process.exit(1);
  }

  const config: AppConfig = {
    apiKey,
    classifications,
    testMode,
    appName: DEFAULT_CONFIG.appName,
    maxReconnectDelaySec: DEFAULT_CONFIG.maxReconnectDelaySec,
    keepExistingConnections: opts.keepExisting,
  };

  // 起動バナー
  printBanner(config);

  // WebSocket接続
  const manager = new WebSocketManager(config, {
    onData: handleData,
    onConnected: () => {
      log.info(chalk.green("✓ リアルタイム受信中..."));
    },
    onDisconnected: (reason) => {
      log.warn(`切断されました: ${reason}`);
    },
  });

  // グレースフルシャットダウン
  const shutdown = () => {
    log.info("シャットダウン中...");
    manager.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await manager.connect();
}

/** 起動バナー表示 */
function printBanner(config: AppConfig): void {
  console.log();
  console.log(
    chalk.cyan.bold(
      "╔══════════════════════════════════════════════════════════╗"
    )
  );
  console.log(
    chalk.cyan.bold(
      `║  dmdata-monitor v${VERSION}                                 ║`
    )
  );
  console.log(
    chalk.cyan.bold(
      "║  Project DM-D.S.S リアルタイム地震・津波情報モニター   ║"
    )
  );
  console.log(
    chalk.cyan.bold(
      "╚══════════════════════════════════════════════════════════╝"
    )
  );
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
