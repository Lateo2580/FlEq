import { ConnectionManager } from "../../dmdata/connection-manager";
import { closeSocket } from "../../dmdata/rest-client";
import { EewEventLogger } from "../eew/eew-logger";
import * as log from "../../logger";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";

const SOCKET_CLOSE_TIMEOUT_MS = 3000;

/** 構造的型ガード: getAllSocketIds メソッドを持つか */
function hasGetAllSocketIds(m: ConnectionManager): m is ConnectionManager & { getAllSocketIds(): number[] } {
  return "getAllSocketIds" in m && typeof (m as Record<string, unknown>)["getAllSocketIds"] === "function";
}

/** 単一ソケットを API 経由でクローズする (タイムアウト付き) */
async function closeSingleSocket(apiKey: string, socketId: number): Promise<void> {
  try {
    await Promise.race([
      closeSocket(apiKey, socketId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), SOCKET_CLOSE_TIMEOUT_MS)
      ),
    ]);
  } catch {
    log.debug(`シャットダウン時のソケットクローズに失敗: socketId=${socketId} (次回起動時にクリーンアップされます)`);
  }
}

/**
 * API 経由でソケットをクローズする。
 * MultiConnectionManager の場合は全ソケットを並列クローズする。
 * タイムアウトやネットワークエラーは無視して終了を続行する。
 */
async function closeSocketViaApi(apiKey: string, manager: ConnectionManager): Promise<void> {
  if (hasGetAllSocketIds(manager)) {
    const socketIds = manager.getAllSocketIds();
    if (socketIds.length === 0) return;
    await Promise.all(socketIds.map((id) => closeSingleSocket(apiKey, id)));
  } else {
    const socketId = manager.getStatus().socketId;
    if (socketId == null) return;
    await closeSingleSocket(apiKey, socketId);
  }
}

/** シャットダウンハンドラのコンテキスト */
export interface ShutdownContext {
  apiKey: string;
  manager: ConnectionManager;
  eewLogger: EewEventLogger;
  getReplHandler: () => ReplHandlerType | null;
  /** ターミナルタイトルをリセットする (CLI層からの注入) */
  resetTerminalTitle: () => void;
  /** VFVO53 バッファの flush + タイマー破棄 */
  flushAndDisposeVolcanoBuffer?: () => void;
  /** 定期要約タイマーの停止 */
  stopSummaryTimer?: () => void;
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
    ctx.stopSummaryTimer?.();
    ctx.flushAndDisposeVolcanoBuffer?.();
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
