import chalk from "chalk";
import { AppConfig } from "../types";
import { WebSocketManager } from "../dmdata/ws-client";
import { ReplHandler } from "../ui/repl";
import { createMessageHandler } from "../app/message-router";
import * as log from "../logger";

export async function startMonitor(config: AppConfig): Promise<void> {
  let replHandler: ReplHandler | null = null;
  const handleData = createMessageHandler();

  const manager = new WebSocketManager(config, {
    onData: (msg) => {
      if (replHandler) replHandler.beforeDisplayMessage();
      try {
        handleData(msg);
      } finally {
        if (replHandler) replHandler.afterDisplayMessage();
      }
    },
    onConnected: () => {
      log.info(chalk.green("✓ リアルタイム受信中..."));
      if (replHandler) {
        replHandler.setConnected(true);
        replHandler.refreshPrompt();
      }
    },
    onDisconnected: (reason) => {
      log.warn(`切断されました: ${reason}`);
      if (replHandler) {
        replHandler.setConnected(false);
        replHandler.refreshPrompt();
      }
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
