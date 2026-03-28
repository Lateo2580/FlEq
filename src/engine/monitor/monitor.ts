import chalk from "chalk";
import { AppConfig } from "../../types";
import { MultiConnectionManager } from "../../dmdata/multi-connection-manager";
import { createMessageHandler } from "../messages/message-router";
import { restoreTsunamiState } from "../startup/tsunami-initializer";
import { restoreVolcanoState } from "../startup/volcano-initializer";
import { resetTerminalTitle } from "../cli/cli-run";
import { formatTimestamp } from "../../ui/formatter";
import { withReplDisplay, updateReplConnectionState } from "./repl-coordinator";
import { createShutdownHandler, registerShutdownSignals } from "./shutdown";
import * as log from "../../logger";
import type { FilterTemplatePipeline } from "../filter-template/pipeline";

import { formatSummaryInterval } from "../../ui/summary-interval-formatter";
import type { SummaryWindowTracker } from "../messages/summary-tracker";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";

export async function startMonitor(config: AppConfig, pipeline?: FilterTemplatePipeline): Promise<void> {
  const { handler: routeMessage, eewLogger, notifier, tsunamiState, volcanoState, stats, summaryTracker, flushAndDisposeVolcanoBuffer } = createMessageHandler({ pipeline: pipeline ?? undefined });

  // EEW ログ設定を反映
  eewLogger.setEnabled(config.eewLog);
  eewLogger.setFields(config.eewLogFields);

  let disconnectedAt: number | null = null;
  let isFirstConnection = true;
  let replHandler: ReplHandlerType | null = null;

  const manager = new MultiConnectionManager(config, {
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
    flushAndDisposeVolcanoBuffer,
  });

  // REPL ハンドラ (遅延ロード)
  const { ReplHandler } = await import("../../ui/repl");
  replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdown, stats, [tsunamiState, volcanoState], [tsunamiState, volcanoState], pipeline ?? undefined, summaryTracker);

  registerShutdownSignals(shutdown);

  // 定期要約タイマー
  setupSummaryInterval(config, summaryTracker, () => replHandler);


  // REPL を先に起動 (接続中もコマンド入力可能にする)
  replHandler.start();

  // 起動時: 最新の津波・火山警報状態を復元 (WebSocket 接続前に実行)
  await restoreTsunamiState(config.apiKey, tsunamiState);
  await restoreVolcanoState(config.apiKey, volcanoState);

  // バックグラウンドで接続開始
  try {
    await manager.connect();
    // 副回線の自動起動
    if (config.backup) {
      try {
        await manager.startBackup();
      } catch (err) {
        log.warn(`副回線の起動に失敗しました: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    log.error(`接続に失敗しました: ${err instanceof Error ? err.message : err}`);
    log.info("retry コマンドで再接続を試みることができます。");
  }
}

/** 定期要約タイマーのセットアップ。summaryInterval が null なら何もしない。 */
function setupSummaryInterval(
  config: AppConfig,
  tracker: SummaryWindowTracker,
  getReplHandler: () => ReplHandlerType | null,
): void {
  if (config.summaryInterval == null) return;

  const intervalMs = config.summaryInterval * 60_000;
  const timer = setInterval(() => {
    const snapshot = tracker.getSnapshot();
    const output = formatSummaryInterval(snapshot, config.summaryInterval!, true);
    withReplDisplay(getReplHandler(), () => {
      console.log(output);
    });
  }, intervalMs);

  // プロセス終了時にタイマーが残らないようにする
  timer.unref();
}
