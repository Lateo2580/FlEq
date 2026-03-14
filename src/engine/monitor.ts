import chalk from "chalk";
import { AppConfig } from "../types";
import { WebSocketManager } from "../dmdata/ws-client";
import { closeSocket } from "../dmdata/rest-client";
import { createMessageHandler } from "./message-router";
import { resetTerminalTitle } from "./cli-run";
import { formatTimestamp } from "../ui/formatter";
import * as log from "../logger";

import type { ReplHandler as ReplHandlerType } from "../ui/repl";

const SOCKET_CLOSE_TIMEOUT_MS = 3000;

function withReplDisplay(repl: ReplHandlerType | null, action: () => void): void {
  repl?.beforeDisplayMessage();
  try {
    action();
  } catch (err) {
    log.error(`電文処理エラー: ${err instanceof Error ? err.message : err}`);
  } finally {
    repl?.afterDisplayMessage();
  }
}

function updateReplConnectionState(repl: ReplHandlerType | null, connected: boolean): void {
  if (!repl) return;
  repl.setConnected(connected);
  repl.refreshPrompt();
}

export async function startMonitor(config: AppConfig): Promise<void> {
  const { handler: routeMessage, eewLogger, notifier } = createMessageHandler();

  let disconnectedAt: number | null = null;
  let isFirstConnection = true;
  let replHandler: ReplHandlerType | null = null;

  const manager = new WebSocketManager(config, {
    onData: (msg) => {
      withReplDisplay(replHandler, () => routeMessage(msg));
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
      updateReplConnectionState(replHandler, true);
    },
    onDisconnected: (reason) => {
      disconnectedAt = Date.now();
      log.warn(`切断されました: ${reason}`);
      updateReplConnectionState(replHandler, false);
    },
  });

  const closeSocketViaApi = async (): Promise<void> => {
    const socketId = manager.getStatus().socketId;
    if (socketId == null) return;
    try {
      await Promise.race([
        closeSocket(config.apiKey, socketId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), SOCKET_CLOSE_TIMEOUT_MS)
        ),
      ]);
    } catch {
      // タイムアウトやネットワークエラーは無視して終了を続行
      log.debug("シャットダウン時のソケットクローズに失敗 (次回起動時にクリーンアップされます)");
    }
  };

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
    const socketClosePromise = closeSocketViaApi();
    manager.close();
    await socketClosePromise;
    resetTerminalTitle();
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
