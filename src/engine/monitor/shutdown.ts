import { WebSocketManager } from "../../dmdata/ws-client";
import { closeSocket } from "../../dmdata/rest-client";
import { EewEventLogger } from "../eew/eew-logger";
import * as log from "../../logger";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";

const SOCKET_CLOSE_TIMEOUT_MS = 3000;

/**
 * API 経由でソケットをクローズする。
 * タイムアウトやネットワークエラーは無視して終了を続行する。
 */
async function closeSocketViaApi(apiKey: string, manager: WebSocketManager): Promise<void> {
  const socketId = manager.getStatus().socketId;
  if (socketId == null) return;
  try {
    await Promise.race([
      closeSocket(apiKey, socketId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), SOCKET_CLOSE_TIMEOUT_MS)
      ),
    ]);
  } catch {
    // タイムアウトやネットワークエラーは無視して終了を続行
    log.debug("シャットダウン時のソケットクローズに失敗 (次回起動時にクリーンアップされます)");
  }
}

/** シャットダウンハンドラのコンテキスト */
export interface ShutdownContext {
  apiKey: string;
  manager: WebSocketManager;
  eewLogger: EewEventLogger;
  getReplHandler: () => ReplHandlerType | null;
  /** ターミナルタイトルをリセットする (CLI層からの注入) */
  resetTerminalTitle: () => void;
}

/**
 * グレースフルシャットダウンハンドラを生成する。
 * 返された関数は複数回呼ばれても冪等 (二重シャットダウン防止)。
 */
export function createShutdownHandler(ctx: ShutdownContext): () => Promise<void> {
  let shuttingDown = false;

  return async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("シャットダウン中...");
    ctx.eewLogger.closeAll();
    try {
      await ctx.eewLogger.flush();
    } catch {
      // flush 失敗は無視
    }
    const repl = ctx.getReplHandler();
    if (repl) repl.stop();
    const socketClosePromise = closeSocketViaApi(ctx.apiKey, ctx.manager);
    ctx.manager.close();
    await socketClosePromise;
    ctx.resetTerminalTitle();
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.exit(0);
  };
}

/** シャットダウンシグナルを登録する */
export function registerShutdownSignals(shutdown: () => Promise<void>): void {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") {
    process.on("SIGHUP", shutdown);
  }
}
