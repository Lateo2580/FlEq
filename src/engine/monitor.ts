import chalk from "chalk";
import { AppConfig } from "../types";
import { WebSocketManager } from "../dmdata/ws-client";
import { createMessageHandler } from "./message-router";
import { formatTimestamp } from "../ui/formatter";
import * as log from "../logger";

import type { ReplHandler as ReplHandlerType } from "../ui/repl";

export async function startMonitor(config: AppConfig): Promise<void> {
  const { handler: handleData, eewLogger, notifier } = createMessageHandler();

  /** 切断時刻 (再接続時のギャップ表示用) */
  let disconnectedAt: number | null = null;
  /** 初回接続フラグ (help メッセージ表示用) */
  let isFirstConnection = true;

  /** REPL ハンドラ (遅延ロード後に設定) */
  let replHandler: ReplHandlerType | null = null;

  const manager = new WebSocketManager(config, {
    onData: (msg) => {
      if (replHandler) replHandler.beforeDisplayMessage();
      try {
        handleData(msg);
      } catch (err) {
        log.error(
          `電文処理エラー: ${err instanceof Error ? err.message : err}`
        );
      } finally {
        if (replHandler) replHandler.afterDisplayMessage();
      }
    },
    onConnected: () => {
      // 再接続時: 切断期間の通知
      if (disconnectedAt != null) {
        const gapStart = formatTimestamp(new Date(disconnectedAt).toISOString());
        const gapEnd = formatTimestamp(new Date().toISOString());
        log.warn(`${gapStart} 〜 ${gapEnd} の間、電文を受信できていない可能性があります`);
        disconnectedAt = null;
      }
      log.info(chalk.green("リアルタイム受信中..."));
      if (isFirstConnection) {
        log.info(chalk.gray("help でコマンド一覧を表示"));
        isFirstConnection = false;
      }
      if (replHandler) {
        replHandler.setConnected(true);
        replHandler.refreshPrompt();
      }
    },
    onDisconnected: (reason) => {
      disconnectedAt = Date.now();
      log.warn(`切断されました: ${reason}`);
      if (replHandler) {
        replHandler.setConnected(false);
        replHandler.refreshPrompt();
      }
    },
  });

  // グレースフルシャットダウン
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("シャットダウン中...");
    eewLogger.closeAll();
    try {
      await eewLogger.flush();
    } catch {
      // flush 失敗は無視
    }
    if (replHandler) replHandler.stop();
    manager.close();
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.exit(0);
  };

  // REPL ハンドラ (遅延ロード)
  const { ReplHandler } = await import("../ui/repl");
  replHandler = new ReplHandler(config, manager, notifier, shutdown);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") {
    process.on("SIGHUP", shutdown);
  }

  // REPL を先に起動 (接続中もコマンド入力可能にする)
  replHandler.start();

  // バックグラウンドで接続開始
  try {
    await manager.connect();
  } catch (err) {
    log.error(`接続に失敗しました: ${err instanceof Error ? err.message : err}`);
    log.info("retry コマンドで再接続を試みることができます。");
  }
}
