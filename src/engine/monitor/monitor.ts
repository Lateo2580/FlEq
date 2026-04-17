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
import type { PipelineController } from "../filter-template/pipeline-controller";

import { formatSummaryInterval } from "../../ui/summary-interval-formatter";
import { WINDOW_MINUTES, type SummaryWindowTracker } from "../messages/summary-tracker";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";

/** REPL から定期要約タイマーを制御するためのインターフェース */
export interface SummaryTimerControl {
  start(intervalMinutes: number): void;
  stop(): void;
  isRunning(): boolean;
  showNow(): void;
}

export async function startMonitor(config: AppConfig, pipelineController?: PipelineController): Promise<void> {
  // display adapter は遅延ロードで ui 依存を monitor 側に限定する
  const { createDisplayAdapter } = await import("../../ui/display-adapter");
  const display = createDisplayAdapter();

  const pipeline = pipelineController?.getPipeline();
  const { handler: routeMessage, eewLogger, notifier, tsunamiState, volcanoState, stats, summaryTracker, flushAndDisposeVolcanoBuffer, eventFileWriter } = createMessageHandler({ pipeline: pipeline ?? undefined, display });

  // EEW ログ設定を反映
  eewLogger.setEnabled(config.eewLog);
  eewLogger.setFields(config.eewLogFields);
  eventFileWriter.setEnabled(config.eventLog);
  eventFileWriter.setIncludeRaw(config.eventLogRaw);

  let disconnectedAt: number | null = null;
  let isFirstConnection = true;
  let replHandler: ReplHandlerType | null = null;
  let summaryTimerControl: SummaryTimerControl | null = null;

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
        log.info(chalk.gray("commands (短縮: cmds) でコマンド一覧を表示"));
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
    stopSummaryTimer: () => summaryTimerControl?.stop(),
    eventFileWriter,
  });

  // REPL ハンドラ (遅延ロード)
  const { ReplHandler } = await import("../../ui/repl");
  replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdown, stats, [tsunamiState, volcanoState], [tsunamiState, volcanoState], pipelineController, summaryTracker);

  registerShutdownSignals(shutdown);

  // 定期要約タイマー
  summaryTimerControl = createSummaryTimerControl(config, summaryTracker, () => replHandler);
  replHandler.setSummaryTimerControl(summaryTimerControl);


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

/** 定期要約タイマーの制御オブジェクトを生成する。初期値が設定済みなら自動起動する。 */
function createSummaryTimerControl(
  config: AppConfig,
  tracker: SummaryWindowTracker,
  getReplHandler: () => ReplHandlerType | null,
): SummaryTimerControl {
  let timer: NodeJS.Timeout | null = null;

  function showOutput(intervalMinutes: number): void {
    const snapshot = tracker.getSnapshot();
    const output = formatSummaryInterval(snapshot, intervalMinutes, true);
    withReplDisplay(getReplHandler(), () => {
      console.log(output);
    });
  }

  const control: SummaryTimerControl = {
    start(intervalMinutes: number): void {
      // 既存タイマーを停止してから再起動
      control.stop();
      const intervalMs = intervalMinutes * 60_000;
      timer = setInterval(() => showOutput(intervalMinutes), intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
    isRunning(): boolean {
      return timer != null;
    },
    showNow(): void {
      showOutput(WINDOW_MINUTES);
    },
  };

  // 初期値が設定されていれば自動起動
  if (config.summaryInterval != null) {
    control.start(config.summaryInterval);
  }

  return control;
}
