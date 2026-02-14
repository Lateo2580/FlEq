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
