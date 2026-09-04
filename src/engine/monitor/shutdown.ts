import { ConnectionManager } from "../../dmdata/connection-manager";
import { closeSocket } from "../../dmdata/rest-client";
import { EewEventLogger } from "../eew/eew-logger";
import * as log from "../../logger";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";
import type {
  StandbyPersistenceSaveResult,
  StandbyPersistenceWriteFailureStage,
} from "../display/standby-persistence";

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
  /** Phase 6B legacy counterpart の cache／timer破棄 */
  disposeLegacyCounterpartCorrelator?: () => void;
  /** 定期要約タイマーの停止 */
  stopSummaryTimer?: () => void;
  /** 情報ディスプレイ runtime の停止 (SSE クライアント切断 + HTTP サーバ close) */
  stopDisplayRuntime?: () => Promise<void>;
  /** monitor 所有 standby sweep の停止 + active-state 最終保存 */
  stopStandbySweep?: () => StandbyPersistenceSaveResult | void;
  /** in-flight を generation latch で無効化し、津波 REST retry を同期停止する */
  stopTsunamiRestoreRetry?: () => void;
  /** VPWP50 詳細 cache の予約済み保存を書き切る */
  flushDetailCaches?: () => void;
  /** 気象警報 昇格 lifecycle の最終保存 */
  flushWeatherPromotion?: () => void;
  /** 震度 7 専用保持時計の最終保存 */
  flushQuakeExtreme?: () => void;
  /** 地震地図 lifecycle の最終保存 */
  flushQuakeDisplay?: () => void;
  /** 当日地震カウンタ・履歴の最終保存 */
  flushDailyQuake?: () => void;
}

export type ShutdownResult =
  | { kind: "completed"; exitCode: 0 }
  | {
      kind: "failed";
      exitCode: 1;
      failures: readonly (
        | { operation: "standbyPersistence"; stage: StandbyPersistenceWriteFailureStage | "exportActiveState" }
        | { operation: "shutdown"; stage: "unexpected" }
      )[];
    };

/**
 * グレースフルシャットダウンハンドラを生成する。
 * 返された関数は複数回呼ばれても冪等 (二重シャットダウン防止)。
 */
export function createShutdownHandler(ctx: ShutdownContext): () => Promise<ShutdownResult> {
  let shutdownPromise: Promise<ShutdownResult> | null = null;

  return () => {
    if (shutdownPromise != null) return shutdownPromise;
    shutdownPromise = (async (): Promise<ShutdownResult> => {
    const failures: Array<
      | { operation: "standbyPersistence"; stage: StandbyPersistenceWriteFailureStage | "exportActiveState" }
      | { operation: "shutdown"; stage: "unexpected" }
    > = [];
    const safely = (operation: () => void): void => {
      try { operation(); } catch { failures.push({ operation: "shutdown", stage: "unexpected" }); }
    };
    // 最初の await と最終 persistence 保存の双方より前に mutation source を止める。
    safely(() => ctx.stopTsunamiRestoreRetry?.());
    log.info("シャットダウン中...");
    safely(() => ctx.stopSummaryTimer?.());
    safely(() => ctx.flushAndDisposeVolcanoBuffer?.());
    safely(() => ctx.disposeLegacyCounterpartCorrelator?.());
    safely(() => ctx.eewLogger.closeAll());
    try {
      await ctx.eewLogger.flush();
    } catch {
      failures.push({ operation: "shutdown", stage: "unexpected" });
    }
    if (ctx.stopDisplayRuntime) {
      try {
        await ctx.stopDisplayRuntime();
      } catch {
        failures.push({ operation: "shutdown", stage: "unexpected" });
      }
    }
    // controller.stop() は display off sweep を再開するため、その後で確実に停止・最終保存する。
    try {
      const persistenceResult = ctx.stopStandbySweep?.();
      if (persistenceResult?.kind === "failed") {
        failures.push({ operation: "standbyPersistence", stage: persistenceResult.stage });
      }
    } catch {
      failures.push({ operation: "standbyPersistence", stage: "exportActiveState" });
    }
    safely(() => ctx.flushDetailCaches?.());
    safely(() => ctx.flushWeatherPromotion?.());
    safely(() => ctx.flushQuakeExtreme?.());
    safely(() => ctx.flushQuakeDisplay?.());
    safely(() => ctx.flushDailyQuake?.());
    let repl: ReplHandlerType | null = null;
    try {
      repl = ctx.getReplHandler();
    } catch {
      failures.push({ operation: "shutdown", stage: "unexpected" });
    }
    safely(() => repl?.stop());
    const socketClosePromise = closeSocketViaApi(ctx.apiKey, ctx.manager);
    safely(() => ctx.manager.close());
    try {
      await socketClosePromise;
    } catch {
      failures.push({ operation: "shutdown", stage: "unexpected" });
    }
    safely(ctx.resetTerminalTitle);
    safely(() => { if (process.stdout.isTTY) process.stdout.write("\n"); });
    return failures.length === 0
      ? { kind: "completed", exitCode: 0 }
      : { kind: "failed", exitCode: 1, failures };
    })();
    return shutdownPromise;
  };
}

export async function runShutdownAndRecordExitCode(
  shutdown: () => Promise<ShutdownResult>,
): Promise<ShutdownResult> {
  let result: ShutdownResult;
  try {
    result = await shutdown();
  } catch {
    result = {
      kind: "failed", exitCode: 1,
      failures: [{ operation: "shutdown", stage: "unexpected" }],
    };
  }
  process.exitCode = result.exitCode;
  return result;
}

/** シャットダウンシグナルを登録する */
export function registerShutdownSignals(shutdown: () => Promise<ShutdownResult>): void {
  let signalShutdown: Promise<void> | null = null;
  const signalHandler = (): void => {
    if (signalShutdown != null) return;
    signalShutdown = runShutdownAndRecordExitCode(shutdown).then((result) => {
      process.exit(result.exitCode);
    });
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  if (process.platform !== "win32") {
    process.on("SIGHUP", signalHandler);
  }
}
