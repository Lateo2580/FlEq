import chalk from "chalk";
import { join } from "node:path";
import { AppConfig } from "../../types";
import { MultiConnectionManager } from "../../dmdata/multi-connection-manager";
import { createMessageHandler } from "../messages/message-router";
import { restoreTsunamiState } from "../startup/tsunami-initializer";
import { restoreVolcanoState } from "../startup/volcano-initializer";
import { resetTerminalTitle } from "../../ui/terminal-title";
import { formatTimestamp } from "../../ui/formatter";
import { withReplDisplay, updateReplConnectionState } from "./repl-coordinator";
import { createShutdownHandler, registerShutdownSignals } from "./shutdown";
import * as log from "../../logger";
import type { PipelineController } from "../filter-template/pipeline-controller";
import type { DisplayConnectionStateV1, DisplayIngestSink } from "../display/types";
import type { DisplayRuntime } from "../display/runtime";
import { StandbyPersistence } from "../display/standby-persistence";
import { StandbyStateStore } from "../display/standby-state-store";

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
  const { createDisplayController } = await import("../display/controller");

  // standby active-state は display runtime ではなく monitor 本体が所有する。
  const standbyStore = new StandbyStateStore();
  const standbyPersistence = new StandbyPersistence(
    join(process.cwd(), "data", "runtime", "display-active-state-v1.json"),
  );
  let standbyDirtyNotify: (() => void) | null = null;
  standbyStore.onChange(() => standbyDirtyNotify?.());
  // 受信コールスタック上で同期 I/O を走らせない。実書き込みは debounce 後に非同期で行い、
  // 終了時は stopStandbySweep -> flush() で書き切る
  standbyStore.onDurable(() => standbyPersistence.schedule(standbyStore.exportActiveState()));
  const persistedStandby = standbyPersistence.load();
  if (persistedStandby != null) standbyStore.restoreActiveState(persistedStandby, Date.now());
  standbyStore.sweep(Date.now());

  let standbySweepTimer: NodeJS.Timeout | null = null;
  function startStandbySweep(): void {
    if (standbySweepTimer != null) return;
    standbySweepTimer = setInterval(() => standbyStore.sweep(Date.now()), 60_000);
    standbySweepTimer.unref();
  }
  function stopStandbySweep(): void {
    if (standbySweepTimer != null) {
      clearInterval(standbySweepTimer);
      standbySweepTimer = null;
    }
  }
  startStandbySweep();

  // 情報ディスプレイ: router には実体 hub ではなく遅延 sink を渡す。
  // 正しい seed は restoreTsunamiState 後にしか読めないため、runtime は restore 後に
  // 起動して向き先 (displayHubRef) を差し替える。dmdata 接続開始はさらに後なので取りこぼしは無い。
  let displayHubRef: DisplayIngestSink | null = null;
  const displaySink: DisplayIngestSink = {
    ingest: (e) => {
      standbyStore.applyEvent(e, Date.now());
      displayHubRef?.ingest(e);
    },
    publishStats: (s) => displayHubRef?.publishStats?.(s),
  };
  let displayRuntime: DisplayRuntime | null = null;
  // dmdata 接続状態 (onConnected/onDisconnected が更新)。display on 時の接続状態 seed に使う
  let disconnectedAt: number | null = null;
  let isFirstConnection = true;

  const pipeline = pipelineController?.getPipeline();
  const { handler: routeMessage, eewLogger, notifier, tsunamiState, volcanoState, vpws50State, vpww56State, vpwp50Cache, stats, summaryTracker, flushAndDisposeVolcanoBuffer } = createMessageHandler({ pipeline: pipeline ?? undefined, display, displaySink });

  /** 現在の dmdata 接続状態 (display on 時の起動直後 seed 用) */
  function getConnectionState(): DisplayConnectionStateV1["dmdata"] {
    if (disconnectedAt != null) return "disconnected";
    if (isFirstConnection) return "connecting";
    return "connected";
  }

  // 情報ディスプレイの起動/停止/状態を束ねるコントローラ。
  // displayRuntime/displayHubRef (上記の可変変数) を単一の真実源として共有する
  const displayController = createDisplayController({
    config,
    display,
    seeds: {
      tsunami: () => tsunamiState.getLastInfo(),
      weather: () => vpws50State.getCurrentAreasForDisplay(),
      landslide: () => vpww56State.getCurrentAreasForDisplay(),
      standbyItems: () => standbyStore.snapshotItems(),
      standbySweep: (nowMs) => standbyStore.sweep(nowMs),
    },
    getRuntime: () => displayRuntime,
    setRuntime: (rt) => { displayRuntime = rt; },
    setHubRef: (hub) => { displayHubRef = hub; },
    setStandbyDirty: (fn) => {
      standbyDirtyNotify = fn;
      if (fn == null) startStandbySweep();
      else stopStandbySweep();
    },
    getConnectionState,
  });

  // EEW ログ設定を反映
  eewLogger.setEnabled(config.eewLog);
  eewLogger.setFields(config.eewLogFields);

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
      displayRuntime?.hub.publishConnection({ dmdata: "connected" });
    },
    onDisconnected: (reason) => {
      disconnectedAt = Date.now();
      log.warn(`切断されました: ${reason}`);
      updateReplConnectionState(replHandler, false);
      displayRuntime?.hub.publishConnection({ dmdata: "disconnected", reason });
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
    stopDisplayRuntime: async () => {
      await displayController.stop();
    },
    stopStandbySweep: () => {
      stopStandbySweep();
      // 予約済み (debounce 待ち) より exportActiveState() の方が常に新しいので、
      // 予約は捨てて現在状態を同期保存する
      standbyPersistence.dispose();
      standbyPersistence.save(standbyStore.exportActiveState());
    },
    flushDetailCaches: () => vpwp50Cache.flush(),
  });

  // REPL ハンドラ (遅延ロード)
  const { ReplHandler } = await import("../../ui/repl");
  replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdown, stats, [tsunamiState, volcanoState], [tsunamiState, volcanoState, vpws50State, vpwp50Cache], pipelineController, summaryTracker, displayController);

  registerShutdownSignals(shutdown);

  // 定期要約タイマー
  summaryTimerControl = createSummaryTimerControl(config, summaryTracker, () => replHandler);
  replHandler.setSummaryTimerControl(summaryTimerControl);


  // REPL を先に起動 (接続中もコマンド入力可能にする)
  replHandler.start();

  // 起動時: 最新の津波・火山警報状態を復元 (WebSocket 接続前に実行)
  await restoreTsunamiState(config.apiKey, tsunamiState);
  const volcanoRestoreResult = await restoreVolcanoState(config.apiKey, volcanoState);
  standbyStore.seedVolcanoAlerts(volcanoState.getSeedEntries(), volcanoRestoreResult, Date.now());

  // 情報ディスプレイ runtime の起動 (restore 後・dmdata 接続開始前)
  if (config.display) {
    await displayController.start();
  }

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
