import chalk from "chalk";
import { AppConfig } from "../../types";
import { WebSocketManager } from "../../dmdata/ws-client";
import { createMessageHandler } from "../messages/message-router";
import { resetTerminalTitle } from "../cli/cli-run";
import { formatTimestamp } from "../../ui/formatter";
import { withReplDisplay, updateReplConnectionState } from "./repl-coordinator";
import { createShutdownHandler, registerShutdownSignals } from "./shutdown";
import * as log from "../../logger";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";

export async function startMonitor(config: AppConfig): Promise<void> {
  const { handler: routeMessage, eewLogger, notifier, tsunamiState } = createMessageHandler();

  // EEW ログ設定を反映
  eewLogger.setEnabled(config.eewLog);
  eewLogger.setFields(config.eewLogFields);

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

  // グレースフルシャットダウン
  const shutdown = createShutdownHandler({
    apiKey: config.apiKey,
    manager,
    eewLogger,
    getReplHandler: () => replHandler,
    resetTerminalTitle,
  });

  // REPL ハンドラ (遅延ロード)
  const { ReplHandler } = await import("../../ui/repl");
  replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdown, [tsunamiState], [tsunamiState]);

  registerShutdownSignals(shutdown);

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
