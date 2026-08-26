import chalk from "chalk";
import { join } from "node:path";
import { AppConfig } from "../../types";
import { MultiConnectionManager } from "../../dmdata/multi-connection-manager";
import { createUnknownDeliveryCapabilities } from "../../dmdata/delivery-capabilities";
import { createMessageHandler } from "../messages/message-router";
import { restoreTsunamiState } from "../startup/tsunami-initializer";
import { restoreVolcanoState } from "../startup/volcano-initializer";
import { resetTerminalTitle } from "../../ui/terminal-title";
import { formatTimestamp } from "../../ui/formatter";
import { withReplDisplay, updateReplConnectionState } from "./repl-coordinator";
import { createShutdownHandler, registerShutdownSignals } from "./shutdown";
import * as log from "../../logger";
import type { PipelineController } from "../filter-template/pipeline-controller";
import type {
  DisplayConnectionStateV1,
  DisplayIngestSink,
  DisplayLateCounterpartContext,
} from "../display/types";
import type { DisplayRuntime } from "../display/runtime";
import { StandbyPersistence } from "../display/standby-persistence";
import { StandbyStateStore } from "../display/standby-state-store";
import { WeatherPromotionPersistence } from "../display/weather-promotion-persistence";
import { WeatherPromotionStore } from "../display/weather-promotion-store";
import { QuakeExtremePersistence } from "../display/quake-extreme-persistence";
import { QuakeExtremeStore } from "../display/quake-extreme-store";
import { QuakeDisplayPersistence } from "../display/quake-display-persistence";
import { QuakeDisplayStore } from "../display/quake-display-store";
import { DailyQuakeCounter } from "../messages/daily-quake-counter";
import { DailyQuakePersistence } from "../messages/daily-quake-persistence";
import { Vpws50StateHolder } from "../messages/vpws50-state";
import { TelegramRevisionGate } from "../messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../messages/tsunami-state";
import { weatherAlertsFromVpws50, weatherAlertsFromVpww56 } from "../display/weather-alert-view";
import { createDisplaySink } from "./display-sink";
import { Vpww56StateHolder } from "../messages/vpww56-state";
import {
  activeLegacyEruptionIdentitySeeds,
  VolcanoStateHolder,
} from "../messages/volcano-state";
import { FloodForecastStateHolder } from "../messages/flood-forecast-state";
import { FLOOD_FORECAST_RETENTION_MS } from "../messages/revision-family-registry";
import { sweepFloodForecastFoundation } from "../messages/flood-forecast-lifecycle";

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
  const vpws50State = new Vpws50StateHolder();
  const vpww56State = new Vpww56StateHolder();
  const tsunamiState = new TsunamiStateHolder();
  const volcanoState = new VolcanoStateHolder();
  const floodForecastState = new FloodForecastStateHolder();
  const revisionGate = new TelegramRevisionGate();
  let vpws50FoundationAuthoritative = true;
  // domain 全体を一報で authoritative 化しない。true は「現行 schema で初期化済み」の意味だけで、
  // 復元待ち／到着済みの authority は Vpww56StateHolder が subject 単位で持つ。
  let vpww56FoundationSchemaTrusted = true;
  let volcanoFoundationAuthoritative = true;
  let floodFoundationAuthoritative = true;
  const standbyPersistence = new StandbyPersistence(
    join(process.cwd(), "data", "runtime", "display-active-state-v1.json"),
    undefined,
    () => ({
      vpws50: {
        authoritative: vpws50FoundationAuthoritative,
        state: vpws50State.exportPersistedState(),
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          entry.domain === "weather" && entry.revisionFamily === "VPWS50"),
      },
      vpww56: {
        authoritative: vpww56FoundationSchemaTrusted
          || vpww56State.activeSubjectKeys().length > 0
          || vpww56State.pendingSubjectKeys().length > 0
          || revisionGate.exportDurableEntries().some((entry) =>
            entry.domain === "weather" && entry.revisionFamily === "VPWW56"),
        state: vpww56State.exportPersistedState(),
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          entry.domain === "weather" && entry.revisionFamily === "VPWW56"),
      },
      tsunami: {
        keyedActive: tsunamiState.getPersistedKeyedActive(),
        legacyActive: tsunamiState.getPersistedLegacyActive(),
        observations: tsunamiState.getObservationGroups(),
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          (entry.domain === "tsunami" && entry.revisionFamily === "VTSE41")
          || (entry.domain === "tsunamiObservation"
            && (entry.revisionFamily === "VTSE51" || entry.revisionFamily === "VTSE52"))),
      },
      volcano: {
        authoritative: volcanoFoundationAuthoritative,
        state: volcanoState.size() === 0 && volcanoState.exportPersistedState().eruptions.length === 0
          ? null
          : volcanoState.exportPersistedState(),
        active: standbyStore.exportActiveState().volcanoes,
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          entry.domain === "volcano"
          && (entry.revisionFamily === "volcanoAlert"
            || entry.revisionFamily === "volcanoEruption")),
      },
      floodForecast: {
        authoritative: floodFoundationAuthoritative,
        active: standbyStore.exportActiveState().floods?.events ?? [],
        legacyEventIds: standbyStore.floodLegacyEventIds(),
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          entry.domain === "floodForecast" && entry.revisionFamily === "floodForecast"),
      },
      standbyDomains: {
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          ["tornado", "heatAlert", "typhoonAnalysis", "nankaiTrough", "lgObservation"]
            .includes(entry.domain)),
      },
    }),
  );
  let standbyDirtyNotify: (() => void) | null = null;
  let standbyDirtySuppressed = false;
  standbyStore.onChange(() => {
    if (!standbyDirtySuppressed) standbyDirtyNotify?.();
  });
  // 受信コールスタック上で同期 I/O を走らせない。実書き込みは debounce 後に非同期で行い、
  // 終了時は stopStandbySweep -> flush() で書き切る
  standbyStore.onDurable(() => standbyPersistence.schedule(standbyStore.exportActiveState()));
  const persistedStandby = standbyPersistence.load();
  if (persistedStandby != null) {
    const restoredAtMs = Date.now();
    standbyStore.restoreActiveState(persistedStandby, restoredAtMs);
    const persistedVpws50 = persistedStandby.telegramFoundation.vpws50;
    vpws50FoundationAuthoritative = persistedVpws50.authoritative;
    if (persistedVpws50.state != null) vpws50State.restorePersistedState(persistedVpws50.state);
    revisionGate.restoreDurableEntries(persistedVpws50.gateEntries);
    const persistedVpww56 = persistedStandby.telegramFoundation.vpww56;
    vpww56FoundationSchemaTrusted = persistedVpww56.authoritative;
    if (persistedVpww56.state != null) vpww56State.restorePersistedState(persistedVpww56.state);
    revisionGate.restoreDurableEntries(persistedVpww56.gateEntries);
    const persistedTsunami = persistedStandby.telegramFoundation.tsunami;
    tsunamiState.restorePersistedState(
      null,
      persistedTsunami.observations,
      persistedTsunami.keyedActive ?? [],
      persistedTsunami.keyedActive == null
        ? persistedTsunami.active ?? null
        : persistedTsunami.legacyActive ?? null,
    );
    revisionGate.restoreDurableEntries(persistedTsunami.gateEntries);
    const persistedVolcano = persistedStandby.telegramFoundation.volcano;
    volcanoFoundationAuthoritative = persistedVolcano.authoritative;
    if (persistedVolcano.state != null) volcanoState.restorePersistedState(persistedVolcano.state);
    revisionGate.restoreDurableEntries(persistedVolcano.gateEntries);
    if (persistedVolcano.authoritative) {
      standbyStore.restoreCanonicalVolcanoes(
        persistedVolcano.active,
        persistedVolcano.gateEntries,
        Date.now(),
      );
    }
    const foundationVolcanoSubjects = new Set(
      persistedVolcano.gateEntries.map((entry) => entry.stateSubjectKey),
    );
    volcanoState.seedLegacyEruptionIdentities(
      activeLegacyEruptionIdentitySeeds(
        persistedStandby.volcanoes,
        foundationVolcanoSubjects,
        restoredAtMs,
      ),
    );
    const persistedFlood = persistedStandby.telegramFoundation.floodForecast;
    floodFoundationAuthoritative = persistedFlood.authoritative;
    revisionGate.restoreDurableEntries(persistedFlood.gateEntries);
    revisionGate.expireRevisionFamily(
      "floodForecast",
      "floodForecast",
      restoredAtMs,
      FLOOD_FORECAST_RETENTION_MS,
    );
    if (persistedFlood.authoritative) {
      standbyStore.restoreCanonicalFloods(
        persistedFlood.active,
        restoredAtMs,
        persistedFlood.legacyEventIds ?? [],
      );
    }
    revisionGate.restoreDurableEntries(persistedStandby.telegramFoundation.standbyDomains.gateEntries);
    if (persistedVpws50.authoritative) {
      const identity = vpws50State.getCurrentIdentity();
      standbyStore.restoreCanonicalVpws50Alerts(
        weatherAlertsFromVpws50(vpws50State.getCurrentAreasForDisplay(), identity?.reportDateTime ?? ""),
        identity?.reportDateTime ?? null,
        identity?.serial ?? null,
      );
    }
    if (persistedVpww56.authoritative) {
      const activeRevision = revisionGate.latestActiveRevisionFamilyRevision("weather", "VPWW56");
      const reportDateTime = activeRevision?.reportDateTime ?? null;
      standbyStore.restoreCanonicalVpww56Alerts(
        weatherAlertsFromVpww56(vpww56State.getCurrentAreasForDisplay(), reportDateTime ?? ""),
        reportDateTime,
        activeRevision?.serial ?? null,
      );
    }
  }
  standbyStore.sweep(Date.now());
  // salvage source は全 holder / gate の restore と起動時 sweep が完了してからだけ
  // canonical 化する。通常 load では pending repair が無く、追加 write は発生しない。
  if (persistedStandby != null && standbyPersistence.hasPendingSalvageRepair()) {
    standbyPersistence.schedule(standbyStore.exportActiveState());
  }

  // 気象警報の昇格 lifecycle も monitor 所有にする。display runtime は `display off` → `on` で
  // 作り直されるが、昇格の時計は電文を受理してからの壁時計経過なので途切れさせない。
  const weatherPromotionStore = new WeatherPromotionStore();
  const weatherPromotionPersistence = new WeatherPromotionPersistence(
    join(process.cwd(), "data", "runtime", "weather-promotion-v1.json"),
  );
  // 受信コールスタック・5 秒 sweep 上で同期 I/O を走らせない。実書き込みは debounce 後に非同期で行い、
  // 終了時は flushWeatherPromotion で書き切る。全 source が null (全解除) の状態も必ず書く
  weatherPromotionStore.onDurable(
    () => weatherPromotionPersistence.schedule(weatherPromotionStore.export(), Date.now()),
  );
  // 復元は load の try/catch の外なので、想定外の値が来ても起動を妨げないよう二重に守る
  try {
    const persistedPromotion = weatherPromotionPersistence.load(Date.now());
    if (persistedPromotion != null) weatherPromotionStore.restore(persistedPromotion, Date.now());
  } catch (err) {
    log.warn(`気象警報の昇格状態の復元に失敗しました: ${err instanceof Error ? err.message : err} (本体は継続します)`);
  }

  // 当日地震カウンタと待機画面の履歴は monitor が所有する。display off/on や再起動で失わせず、
  // 1 ファイルにまとめて原子的に保存するため、両方を DailyQuakeCounter に閉じる。
  const dailyQuakeCounter = new DailyQuakeCounter();
  const dailyQuakePersistence = new DailyQuakePersistence(
    join(process.cwd(), "data", "runtime", "daily-quake-v1.json"),
  );
  try {
    const persistedDailyQuake = dailyQuakePersistence.load(Date.now());
    if (persistedDailyQuake != null) dailyQuakeCounter.restore(persistedDailyQuake, Date.now());
  } catch (err) {
    log.warn(`当日地震状態の復元に失敗しました: ${err instanceof Error ? err.message : err} (本体は継続します)`);
  }
  dailyQuakeCounter.onChange((change) => {
    const nowMs = Date.now();
    if (change === "rollover") {
      dailyQuakePersistence.dispose();
      dailyQuakePersistence.save(dailyQuakeCounter.export(), nowMs);
    } else {
      dailyQuakePersistence.schedule(dailyQuakeCounter.export(), nowMs);
    }
  });

  // 地図の contribution／host 絶対期限／large-quake reference／revision は display runtime
  // ではなく monitor が所有する。display off 中も受理し、別ファイルの additive v1 へ保存する。
  const quakeDisplayStore = new QuakeDisplayStore();
  const quakeDisplayPersistence = new QuakeDisplayPersistence(
    join(process.cwd(), "data", "runtime", "quake-display-v1.json"),
  );
  quakeDisplayStore.onDurable(
    () => quakeDisplayPersistence.schedule(quakeDisplayStore.export(), Date.now()),
  );
  try {
    const persistedQuakeDisplay = quakeDisplayPersistence.load(Date.now());
    if (persistedQuakeDisplay != null) quakeDisplayStore.restore(persistedQuakeDisplay, Date.now());
  } catch (err) {
    log.warn(`地震地図状態の復元に失敗しました: ${err instanceof Error ? err.message : err} (本体は継続します)`);
  }

  // 震度 7 の背景保持は、表示用 largeQuake/latestQuake の TTL から独立した originTime 基準の 12 時間時計。
  // monitor 所有にして display off/on とプロセス再起動をまたいで維持する。
  const quakeExtremeStore = new QuakeExtremeStore();
  const quakeExtremePersistence = new QuakeExtremePersistence(
    join(process.cwd(), "data", "runtime", "quake-extreme-v1.json"),
  );
  quakeExtremeStore.onDurable(
    (durability) => {
      const state = quakeExtremeStore.export();
      const nowMs = Date.now();
      if (durability === "immediate") quakeExtremePersistence.saveImmediate(state, nowMs);
      else quakeExtremePersistence.schedule(state, nowMs);
    },
  );
  try {
    const persistedQuakeExtreme = quakeExtremePersistence.load(Date.now());
    if (persistedQuakeExtreme != null) quakeExtremeStore.restore(persistedQuakeExtreme, Date.now());
  } catch (err) {
    log.warn(`震度 7 背景保持の復元に失敗しました: ${err instanceof Error ? err.message : err} (本体は継続します)`);
  }

  let standbySweepTimer: NodeJS.Timeout | null = null;
  function sweepStandbyFoundation(nowMs: number) {
    const standbyMutation = standbyStore.sweep(nowMs);
    const floodMutation = sweepFloodForecastFoundation(
      revisionGate,
      floodForecastState,
      standbyStore,
      nowMs,
    );
    if (floodMutation.foundationChanged) {
      standbyPersistence.schedule(standbyStore.exportActiveState());
    }
    return {
      viewChanged: standbyMutation.viewChanged || floodMutation.viewChanged,
      durableChanged: standbyMutation.durableChanged || floodMutation.durableChanged
        || floodMutation.foundationChanged,
    };
  }

  function startStandbySweep(): void {
    if (standbySweepTimer != null) return;
    standbySweepTimer = setInterval(() => {
      const nowMs = Date.now();
      sweepStandbyFoundation(nowMs);
      quakeExtremeStore.sweep(nowMs);
    }, 60_000);
    standbySweepTimer.unref();
  }
  function stopStandbySweep(): void {
    if (standbySweepTimer != null) {
      clearInterval(standbySweepTimer);
      standbySweepTimer = null;
    }
  }
  startStandbySweep();

  // display runtime の有無とは独立して 0 時 JST を越えた空状態を保存する。
  // runtime 稼働中は standby sweep が hub へ移るため、ここを兼用すると日替わりが保存されない。
  let dailyQuakeSweepTimer: NodeJS.Timeout | null = setInterval(() => {
    const nowMs = Date.now();
    if (quakeDisplayStore.sweep(nowMs)) displayHubRef?.markExternalStateDirty?.();
    if (dailyQuakeCounter.sweep(nowMs)) {
      dailyQuakePersistence.dispose();
      dailyQuakePersistence.save(dailyQuakeCounter.export(), nowMs);
      displayHubRef?.markExternalStateDirty?.();
    }
  }, 60_000);
  dailyQuakeSweepTimer.unref();
  function stopDailyQuakeSweep(): void {
    if (dailyQuakeSweepTimer == null) return;
    clearInterval(dailyQuakeSweepTimer);
    dailyQuakeSweepTimer = null;
  }

  // 情報ディスプレイ: router には実体 hub ではなく遅延 sink を渡す。
  // 正しい seed は restoreTsunamiState 後にしか読めないため、runtime は restore 後に
  // 起動して向き先 (displayHubRef) を差し替える。dmdata 接続開始はさらに後なので取りこぼしは無い。
  let displayHubRef: DisplayIngestSink | null = null;
  const baseDisplaySink = createDisplaySink({
    standby: standbyStore,
    promotions: weatherPromotionStore,
    quakeExtreme: quakeExtremeStore,
    quakeDisplay: quakeDisplayStore,
    dailyQuakes: dailyQuakeCounter,
    weatherViews: {
      vpws50: () => vpws50State.getCurrentAreasForDisplay(),
      vpww56: () => vpww56State.getCurrentAreasForDisplay(),
    },
    vpws50Identity: () => vpws50State.getCurrentIdentity(),
    getHub: () => displayHubRef,
    withStandbyDirtySuppressed: <T>(callback: () => T): T => {
      standbyDirtySuppressed = true;
      try {
        return callback();
      } finally {
        standbyDirtySuppressed = false;
      }
    },
  });
  const displaySink: DisplayIngestSink = {
    ingest: (e) => baseDisplaySink.ingest(e),
    ingestTickerOnly: (e) => baseDisplaySink.ingestTickerOnly?.(e),
    reconcileLateCounterpart: (e, sourceEventKeys, context?: DisplayLateCounterpartContext) => {
      const result = context == null
        ? baseDisplaySink.reconcileLateCounterpart?.(e, sourceEventKeys)
        : baseDisplaySink.reconcileLateCounterpart?.(e, sourceEventKeys, context);
      return result ?? { kind: "unsupported", reason: "capabilityUnavailable" };
    },
    reconcileLateCounterpartCard: (e, context) =>
      baseDisplaySink.reconcileLateCounterpartCard?.(e, context)
      ?? {},
    publishStats: (s) => displayHubRef?.publishStats?.(s),
  };
  let displayRuntime: DisplayRuntime | null = null;
  // dmdata 接続状態 (onConnected/onDisconnected が更新)。display on 時の接続状態 seed に使う
  let disconnectedAt: number | null = null;
  let isFirstConnection = true;

  const pipeline = pipelineController?.getPipeline();
  let manager: MultiConnectionManager | null = null;
  const persistAcceptedTsunamiRevision = () => {
    standbyPersistence.schedule(standbyStore.exportActiveState());
  };
  const { handler: routeMessage, eewLogger, notifier, vpwp50Cache, tornadoDetailProvider, stats, summaryTracker, flushAndDisposeVolcanoBuffer, disposeLegacyCounterpartCorrelator, buildDisplayStats } = createMessageHandler({
    pipeline: pipeline ?? undefined,
    display,
    displaySink,
    dailyQuakeCounter,
    vpws50State,
    vpww56State,
    tsunamiState,
    volcanoState,
    floodForecastState,
    revisionGate,
    onVpws50RevisionDecision: (decision) => {
      if (decision.accepted) vpws50FoundationAuthoritative = true;
    },
    onVpww56RevisionDecision: (decision) => {
      if (!decision.accepted) return;
      standbyPersistence.schedule(standbyStore.exportActiveState());
    },
    onTsunamiRevisionDecision: persistAcceptedTsunamiRevision,
    onVolcanoRevisionDecision: (decision) => {
      if (!decision.accepted && !decision.semanticKeyMigrated) return;
      if (decision.accepted) volcanoFoundationAuthoritative = true;
      standbyPersistence.schedule(standbyStore.exportActiveState());
    },
    onFloodRevisionDecision: (decision) => {
      if (!decision.accepted) return;
      floodFoundationAuthoritative = true;
      standbyPersistence.schedule(standbyStore.exportActiveState());
    },
    onStandbyRevisionDecision: (decision) => {
      if (decision.accepted) standbyPersistence.schedule(standbyStore.exportActiveState());
    },
    getDeliveryCapabilities: () => manager?.getDeliveryCapabilities()
      ?? createUnknownDeliveryCapabilities(),
    getPersistenceSalvageDiagnostics: () => standbyPersistence.salvageBackupDiagnostics(),
  });
  for (let i = 0; i < standbyPersistence.takeMigrationConflictCount(); i++) {
    stats.recordFoundation("persistenceMigrationConflict");
  }

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
      tsunamiObservations: () => tsunamiState.getObservationGroups(),
      weather: () => vpws50State.getCurrentAreasForDisplay(),
      landslide: () => vpww56State.getCurrentAreasForDisplay(),
      standbyItems: () => standbyStore.snapshotItems(),
      weatherAlerts: () => standbyStore.snapshotWeatherAlerts(),
      weatherPromotions: () => weatherPromotionStore,
      quakeExtreme: () => quakeExtremeStore,
      quakeLifecycle: () => quakeDisplayStore.export(),
      recentQuakes: () => dailyQuakeCounter.getRecentQuakes(),
      stats: () => buildDisplayStats(),
      standbySweep: sweepStandbyFoundation,
      standbyTickerGroupKeys: () => standbyStore.activeTickerGroupKeys(),
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
    getInitialStats: () => buildDisplayStats(),
  });

  // EEW ログ設定を反映
  eewLogger.setEnabled(config.eewLog);
  eewLogger.setFields(config.eewLogFields);

  let replHandler: ReplHandlerType | null = null;
  let summaryTimerControl: SummaryTimerControl | null = null;

  manager = new MultiConnectionManager(config, {
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
    disposeLegacyCounterpartCorrelator,
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
    flushWeatherPromotion: () => {
      // 予約済み (debounce 待ち) より export() の方が常に新しいので、予約は捨てて現在状態を保存する
      weatherPromotionPersistence.dispose();
      weatherPromotionPersistence.save(weatherPromotionStore.export(), Date.now());
    },
    flushQuakeExtreme: () => {
      quakeExtremePersistence.dispose();
      quakeExtremePersistence.save(quakeExtremeStore.export(), Date.now());
    },
    flushQuakeDisplay: () => {
      quakeDisplayPersistence.dispose();
      quakeDisplayPersistence.save(quakeDisplayStore.export(), Date.now());
    },
    flushDailyQuake: () => {
      stopDailyQuakeSweep();
      dailyQuakePersistence.dispose();
      dailyQuakePersistence.save(dailyQuakeCounter.export(), Date.now());
    },
  });

  // REPL ハンドラ (遅延ロード)
  const { ReplHandler } = await import("../../ui/repl");
  replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdown, stats, [tsunamiState, volcanoState], [tsunamiState, volcanoState, tornadoDetailProvider, vpws50State, vpwp50Cache], pipelineController, summaryTracker, displayController);

  registerShutdownSignals(shutdown);

  // 定期要約タイマー
  summaryTimerControl = createSummaryTimerControl(config, summaryTracker, () => replHandler);
  replHandler.setSummaryTimerControl(summaryTimerControl);


  // REPL を先に起動 (接続中もコマンド入力可能にする)
  replHandler.start();

  // 起動時: 最新の津波・火山警報状態を復元 (WebSocket 接続前に実行)
  await restoreTsunamiState(
    config.apiKey,
    tsunamiState,
    revisionGate,
    persistAcceptedTsunamiRevision,
  );
  const volcanoWasAuthoritative = volcanoFoundationAuthoritative;
  let volcanoRestoreMutated = false;
  const volcanoRestoreResult = await restoreVolcanoState(
    config.apiKey,
    volcanoState,
    revisionGate,
    volcanoFoundationAuthoritative,
    () => { volcanoRestoreMutated = true; },
  );
  if (volcanoRestoreResult === "success" && (!volcanoWasAuthoritative || volcanoRestoreMutated)) {
    volcanoFoundationAuthoritative = true;
    standbyStore.seedVolcanoAlerts(volcanoState.getSeedEntries(), "success", Date.now());
    standbyPersistence.schedule(standbyStore.exportActiveState());
  }

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
