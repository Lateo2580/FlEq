import chalk from "chalk";
import { join } from "node:path";
import { AppConfig } from "../../types";
import { MultiConnectionManager } from "../../dmdata/multi-connection-manager";
import { createUnknownDeliveryCapabilities } from "../../dmdata/delivery-capabilities";
import { createMessageHandler } from "../messages/message-router";
import { restoreTsunamiState } from "../startup/tsunami-initializer";
import {
  repairVolcanoState,
  VolcanoRepairJournal,
  volcanoRepairTargets,
} from "../startup/volcano-initializer";
import { fetchTelegramBody, listTelegrams } from "../../dmdata/rest-client";
import type { WsSubscriptionAcknowledgement } from "../../dmdata/ws-client";
import { resetTerminalTitle } from "../../ui/terminal-title";
import { formatTimestamp } from "../../ui/formatter";
import { withReplDisplay, updateReplConnectionState } from "./repl-coordinator";
import { createShutdownHandler, registerShutdownSignals, runShutdownAndRecordExitCode } from "./shutdown";
import * as log from "../../logger";
import type { PipelineController } from "../filter-template/pipeline-controller";
import type {
  DisplayConnectionStateV1,
  DisplayIngestSink,
  DisplayLateCounterpartContext,
  VptaAdmissionCompletion,
  VptaPersistenceCompletionAck,
} from "../display/types";
import type { DisplayRuntime } from "../display/runtime";
import {
  StandbyPersistence,
  type StandbyPersistenceSaveResult,
  type VolcanoManualBackupResult,
} from "../display/standby-persistence";
import { StandbyStateStore } from "../display/standby-state-store";
import {
  StandbyPersistenceAdmissionCoordinator,
  serializeStandbyAdmissionPair,
  sweepStandbyBeforeAdmission,
} from "../display/standby-persistence-admission";
import {
  VolcanoTransactionCoordinator,
  type VolcanoRepairAdministration,
  type VolcanoRestRepairRequest,
  type VolcanoRestRepairResult,
} from "../messages/volcano-transaction-coordinator";
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
  emptyVolcanoRepairState,
  VolcanoStateHolder,
  type VolcanoRepairStateV1,
} from "../messages/volcano-state";
import { FloodForecastStateHolder } from "../messages/flood-forecast-state";
import {
  FLOOD_FORECAST_RETENTION_MS,
  WEATHER_TIMESERIES_RETENTION_MS,
} from "../messages/revision-family-registry";
import { sweepFloodForecastFoundation } from "../messages/flood-forecast-lifecycle";
import { TYPHOON_PROBABILITY_RETENTION_MS } from "../display/project-typhoon-probability";
import { TyphoonProbabilityStateHolder } from "../messages/typhoon-probability-state";

import { formatSummaryInterval } from "../../ui/summary-interval-formatter";
import { WINDOW_MINUTES, type SummaryWindowTracker } from "../messages/summary-tracker";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";

/**
 * 手動 REST repair の連打クールダウン。process 内のメモリだけで管理し永続化しない。
 * REST request を 1 本以上発行した試行だけがこの時計を進める。
 */
export const VOLCANO_REST_REPAIR_COOLDOWN_MS = 60_000;

/** 起動時 repair と手動 repair が共有する派生フラグの式（spec §5.6）。 */
export function volcanoFoundationAuthoritativeFrom(repair: VolcanoRepairStateV1): boolean {
  return !repair.vfvo50Repairable && repair.unrecoverableAlertOmissions.length === 0;
}

/**
 * 手動 REST repair の同期 commit 区間だけ、通常の durable 予約を畳むためのスコープ。
 *
 * commit phase（`repairVolcanoState` の `commitPolicy: "twoPhase"` 区間）は await を
 * 一つも含まない同期区間なので、`run()` の外へ抑止が漏れることはない。prove phase の
 * await 中に届く live ingress の予約は素通しであり、平常運転を止めない（spec §5.5 / §5.6）。
 */
export interface ManualRepairCommitScope {
  /** 同期 commit を包む。await を含む callback を渡してはならない。 */
  run<T>(commit: () => T): T;
  /**
   * 抑止中なら予約要求を latch して true を返す。durable callback は true の間だけ
   * 予約を見送り、finalizing の 1 回にまとめる。
   */
  deferReservation(): boolean;
  /** latch した予約要求を 1 回だけ取り出す（取り出しで latch は落ちる）。 */
  takeDeferredReservation(): boolean;
}

/** `ManualRepairCommitScope` の唯一の実装。composition root と試験の両方がこれを使う。 */
export function createManualRepairCommitScope(): ManualRepairCommitScope {
  let depth = 0;
  let deferred = false;
  return {
    run(commit) {
      depth += 1;
      try {
        return commit();
      } finally {
        // 同期区間なので、この finally は必ず同じ tick で走る。
        depth -= 1;
      }
    },
    deferReservation() {
      if (depth === 0) return false;
      deferred = true;
      return true;
    },
    takeDeferredReservation() {
      const pending = deferred;
      deferred = false;
      return pending;
    },
  };
}

export interface VolcanoRestRepairAdapterDeps {
  apiKey: string;
  coordinator: VolcanoTransactionCoordinator;
  /** composition root の shared `volcanoRepairJournal`。起動時 repair と排他するための唯一の真実源。 */
  getJournal: () => VolcanoRepairJournal | null;
  setJournal: (journal: VolcanoRepairJournal | null) => void;
  getAcknowledgement: () => WsSubscriptionAcknowledgement | null;
  backupCurrentMirrors: () => VolcanoManualBackupResult;
  applyRepairState: (repair: VolcanoRepairStateV1, authoritative: boolean) => void;
  scheduleStandbyPersistence: () => void;
  /**
   * commit phase の `coordinator.transact` を包み、その同期区間だけ通常の durable 予約を
   * 畳むスコープ。畳んだ要求は finalizing で 1 回だけ予約に変える（spec §5.6 / §14.2 #21）。
   */
  commitScope: ManualRepairCommitScope;
  now?: () => number;
  loadPage?: typeof listTelegrams;
  loadBody?: typeof fetchTelegramBody;
}

/**
 * 手動 REST repair の adapter。shared journal の install / 解除、in-flight、
 * クールダウン、manual backup、派生状態の再計算をここに閉じ込める。
 * `monitor.ts` の外へは出さない（composition root だけが生成する）。
 */
export function createVolcanoRestRepair(
  deps: VolcanoRestRepairAdapterDeps,
): (request: VolcanoRestRepairRequest) => Promise<VolcanoRestRepairResult> {
  const now = deps.now ?? (() => Date.now());
  const loadPage = deps.loadPage ?? listTelegrams;
  const loadBody = deps.loadBody ?? fetchTelegramBody;
  let inFlight = false;
  let cooldownUntilMs = 0;

  return async (request: VolcanoRestRepairRequest): Promise<VolcanoRestRepairResult> => {
    // busy 検査と in-flight 代入の間に await を挟まない（spec §5.1 手順 3）。
    if (deps.getJournal() != null || inFlight) return { kind: "busy" };
    const nowMs = now();
    const cooldownRemainingMs = cooldownUntilMs - nowMs;
    // クールダウンは manual backup より前。拒否時はファイルを 1 本も作らない。
    if (cooldownRemainingMs > 0) return { kind: "cooldown", remainingMs: cooldownRemainingMs };
    inFlight = true;
    let restIssued = false;
    // commit 成功で確定する予約要求。commit 区間で畳んだ要求と OR で 1 回にまとめる。
    let reservationPending = false;
    try {
      const acknowledgement = deps.getAcknowledgement();
      if (acknowledgement == null) return { kind: "notConnected" };
      let journal: VolcanoRepairJournal;
      try {
        journal = new VolcanoRepairJournal(acknowledgement, request.targets);
      } catch {
        return { kind: "notConnected" };
      }
      deps.setJournal(journal);
      // journal install 後・最初の REST 前。失敗なら REST を 1 本も出さず fail-closed。
      const backup = deps.backupCurrentMirrors();
      if (backup.kind === "failed") {
        log.warn(`[volcano-repair] manual rest repair backup failed reason=${backup.reason} detail=${backup.detail}`);
        return { kind: "backupFailed", reason: backup.reason, detail: backup.detail };
      }
      const runtimeVersionBefore = deps.coordinator.snapshot().runtimeVersion;
      // commit phase の transact だけを抑止スコープで包む。prove phase の await は
      // 素通しなので、その間に届く live ingress の予約は畳まれない（spec §5.5）。
      const commitScopedCoordinator = new Proxy(deps.coordinator, {
        get(target, property) {
          if (property !== "transact") return Reflect.get(target, property, target);
          const transact: VolcanoTransactionCoordinator["transact"] = (family, reduce) =>
            deps.commitScope.run(() => target.transact(family, reduce));
          return transact;
        },
      });
      const repair = await repairVolcanoState({
        apiKey: deps.apiKey,
        nowMs,
        coordinator: commitScopedCoordinator,
        journal,
        getAcknowledgement: deps.getAcknowledgement,
        targets: request.targets,
        dryRun: request.dryRun,
        commitPolicy: "twoPhase",
        loadPage: (apiKey, query) => {
          restIssued = true;
          return loadPage(apiKey, query);
        },
        loadBody: (apiKey, id, expectedUrl) => {
          restIssued = true;
          return loadBody(apiKey, id, expectedUrl);
        },
      });
      if (!request.dryRun && repair.targets.some((result) => result.kind === "committed")) {
        const repairState = deps.coordinator.snapshot().repair;
        deps.applyRepairState(repairState, volcanoFoundationAuthoritativeFrom(repairState));
        reservationPending = true;
      }
      const backupSummary = backup.files.length === 0
        ? "none"
        : backup.files.map((file: { source: string; reused: boolean }) =>
          `${file.source}:${file.reused ? "reused" : "new"}`).join(",");
      log.info(`[volcano-repair] manual rest repair mode=${request.dryRun ? "dryRun" : "commit"} targets=${request.targets.join(",")} reason=${request.reason.slice(0, 160)} backup=${backupSummary} result=${repair.targets.map((result) => `${result.target}:${result.kind}${result.reason == null ? "" : `(${result.reason})`}`).join(",")} runtimeVersion=${runtimeVersionBefore}->${deps.coordinator.snapshot().runtimeVersion}`);
      return {
        kind: "completed",
        dryRun: request.dryRun,
        backupFiles: backup.files,
        targets: repair.targets,
      };
    } finally {
      // in-flight を true にした後の全離脱経路がここを通る。
      deps.setJournal(null);
      inFlight = false;
      if (restIssued) cooldownUntilMs = now() + VOLCANO_REST_REPAIR_COOLDOWN_MS;
      // 畳んだ要求は成功・throw のどちらでも必ず取り出す（latch を跨がせない）。
      // 予約自体は commit が durable を動かしたときだけ 1 回行う（spec §14.2 #21 / #22）。
      const deferred = deps.commitScope.takeDeferredReservation();
      if (deferred || reservationPending) deps.scheduleStandbyPersistence();
    }
  };
}

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
  const typhoonProbabilityState = new TyphoonProbabilityStateHolder();
  let vpws50FoundationAuthoritative = true;
  // domain 全体を一報で authoritative 化しない。true は「現行 schema で初期化済み」の意味だけで、
  // 復元待ち／到着済みの authority は Vpww56StateHolder が subject 単位で持つ。
  let vpww56FoundationSchemaTrusted = true;
  let volcanoFoundationAuthoritative = true;
  let volcanoRepairState: VolcanoRepairStateV1 = emptyVolcanoRepairState();
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
        ashfallSchemaGeneration: 1,
        repairState: structuredClone(volcanoRepairState),
        state: volcanoState.exportPersistedState(),
        active: standbyStore.exportActiveState().volcanoes,
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          entry.domain === "volcano"
          && (entry.revisionFamily === "volcanoAlert"
            || entry.revisionFamily === "volcanoEruption"
            || entry.revisionFamily === "volcanoAshfall")),
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
          ["tornado", "heatAlert", "typhoonAnalysis", "typhoonProbability", "nankaiTrough", "lgObservation", "weatherWarningTimeseries"]
            .includes(entry.domain)),
      },
    }),
  );
  const persistenceAdmission = new StandbyPersistenceAdmissionCoordinator({
    owners: {
      telegramRevisionGate: revisionGate,
      standbyStateStore: standbyStore,
      vpws50State,
      vpww56State,
      tsunamiState,
      volcanoState,
      floodForecastState,
    },
    repairState: volcanoRepairState,
    serializePair: (domains, envelope) =>
      serializeStandbyAdmissionPair(standbyPersistence, domains, envelope),
    canReserveLogicalGeneration: () => standbyPersistence.canReserveLogicalGeneration(),
  });
  const volcanoTransactionCoordinator = new VolcanoTransactionCoordinator(persistenceAdmission);
  let standbyDirtyNotify: (() => void) | null = null;
  let standbyDirtySuppressed = false;
  let standbyDurableSuppressionDepth = 0;
  let vpwp50AdmissionPersistencePending = false;
  // restore/sweep/REST と、その await 中に届く live mutation を一つの
  // startup save reservation へ畳み込む。
  let startupPersistenceSchedulingSuppressed = true;
  let startupPersistenceDirty = false;
  // 手動 REST repair の同期 commit 区間だけ予約を畳む（起動時の畳み込みとは別軸）。
  const manualRepairCommitScope = createManualRepairCommitScope();
  const captureLatestStandbyPersistencePair = () => {
    const envelope = standbyPersistence.reserveSerializationEnvelope();
    return persistenceAdmission.captureSerializedPair(envelope);
  };
  const scheduleCapturedStandbyPersistence = () => {
    const pair = captureLatestStandbyPersistencePair();
    return standbyPersistence.scheduleSerializedPair(pair);
  };
  const saveCapturedStandbyPersistence = (): StandbyPersistenceSaveResult => {
    try {
      return standbyPersistence.saveSerializedPair(captureLatestStandbyPersistencePair());
    } catch (cause) {
      return {
        kind: "failed",
        requestedSeq: null,
        failedSeq: null,
        stage: "validation",
        pendingRetained: true,
        partialCommit: "none",
        cause,
      };
    }
  };
  const scheduleLatestStandbyPersistence = (): void => {
    if (startupPersistenceSchedulingSuppressed) startupPersistenceDirty = true;
    // 手動 repair の commit 区間中は adapter の finalizing が 1 回にまとめて予約する。
    else if (!manualRepairCommitScope.deferReservation()) {
      try {
        scheduleCapturedStandbyPersistence();
      } catch (error) {
        // Keep the dirty latch for shutdown even if an unexpected serializer
        // invariant prevents the debounce reservation.
        startupPersistenceDirty = true;
        throw error;
      }
    }
  };
  const withStandbyDurableNotificationsSuppressed = <T>(callback: () => T): T => {
    const ownsVpwp50Completion = standbyDurableSuppressionDepth === 0;
    if (ownsVpwp50Completion) vpwp50AdmissionPersistencePending = false;
    standbyDurableSuppressionDepth += 1;
    try {
      return callback();
    } finally {
      // VPWP50 gate expiry/admission and reducer mutation form one durable
      // transaction. Reserve its canonical state exactly once after the whole
      // router operation, including failure paths between gate commit and
      // display ingestion.
      const completesVpwp50Admission = ownsVpwp50Completion
        && vpwp50AdmissionPersistencePending;
      try {
        if (completesVpwp50Admission) {
          standbyStore.reconcileWeatherWarningForecastGateBindings(
            revisionGate.exportDurableEntries(),
          );
        }
      } finally {
        standbyDurableSuppressionDepth -= 1;
      }
      if (completesVpwp50Admission) {
        vpwp50AdmissionPersistencePending = false;
        scheduleLatestStandbyPersistence();
      }
    }
  };
  standbyStore.onChange(() => {
    if (!standbyDirtySuppressed) standbyDirtyNotify?.();
  });
  // 受信コールスタック上で同期 I/O を走らせない。実書き込みは debounce 後に非同期で行い、
  // 終了時は stopStandbySweep -> flush() で書き切る
  const startupNowMs = Date.now();
  let briefingCriticalRewriteRequired = false;
  let startupVptaGateChanged = false;
  let startupVptaProjectionChanged = false;
  let startupVpwp50GateChanged = false;
  let startupVpwp50ProjectionChanged = false;
  const persistedLoad = standbyPersistence.loadWithResult(startupNowMs);
  if (persistedLoad.startup.kind === "fatal") {
    throw new Error(
      `standby persistence startup aborted: v2=${persistedLoad.sourceStates.v2}, v1=${persistedLoad.sourceStates.v1}`,
    );
  }
  const persistedStandby = persistedLoad.state;
  // Build every owner off to the side.  No listener can observe a half-restored
  // foundation; the coordinator publishes this complete set exactly once.
  const startupStandby = new StandbyStateStore();
  const startupVpws50 = new Vpws50StateHolder();
  const startupVpww56 = new Vpww56StateHolder();
  const startupTsunami = new TsunamiStateHolder();
  const startupVolcano = new VolcanoStateHolder();
  const startupFlood = new FloodForecastStateHolder();
  const startupGate = new TelegramRevisionGate();
  if (persistedStandby != null) {
    const restoredAtMs = startupNowMs;
    // VPTA projection は durable gate と結合して初めて復元できる。gate restore / expiry を
    // probability slice より先に確定し、旧報の一時的な再表示を作らない。
    startupGate.restoreDurableEntries(
      persistedStandby.telegramFoundation.standbyDomains.gateEntries,
    );
    startupVpwp50GateChanged = startupGate.expireRevisionFamily(
      "weatherWarningTimeseries",
      "VPWP50",
      startupNowMs,
      WEATHER_TIMESERIES_RETENTION_MS,
    );
    startupVptaGateChanged = startupGate.expireRevisionFamily(
      "typhoonProbability", "VPTA50", startupNowMs, TYPHOON_PROBABILITY_RETENTION_MS,
    );
    briefingCriticalRewriteRequired = startupStandby
      .restoreActiveState(persistedStandby, restoredAtMs).briefingCriticalRewriteRequired;
    const persistedVpws50 = persistedStandby.telegramFoundation.vpws50;
    vpws50FoundationAuthoritative = persistedVpws50.authoritative;
    if (persistedVpws50.state != null) startupVpws50.restorePersistedState(persistedVpws50.state);
    startupGate.restoreDurableEntries(persistedVpws50.gateEntries);
    const persistedVpww56 = persistedStandby.telegramFoundation.vpww56;
    vpww56FoundationSchemaTrusted = persistedVpww56.authoritative;
    if (persistedVpww56.state != null) startupVpww56.restorePersistedState(persistedVpww56.state);
    startupGate.restoreDurableEntries(persistedVpww56.gateEntries);
    const persistedTsunami = persistedStandby.telegramFoundation.tsunami;
    startupTsunami.restorePersistedState(
      null,
      persistedTsunami.observations,
      persistedTsunami.keyedActive ?? [],
      persistedTsunami.keyedActive == null
        ? persistedTsunami.active ?? null
        : persistedTsunami.legacyActive ?? null,
    );
    startupGate.restoreDurableEntries(persistedTsunami.gateEntries);
    const persistedVolcano = persistedStandby.telegramFoundation.volcano;
    volcanoFoundationAuthoritative = persistedVolcano.authoritative;
    volcanoRepairState = structuredClone(
      persistedVolcano.repairState ?? persistedStandby.volcanoRepairState
        ?? emptyVolcanoRepairState(),
    );
    if (persistedVolcano.state != null) {
      startupVolcano.restorePersistedState(persistedVolcano.state, startupNowMs);
    }
    startupGate.restoreDurableEntries(persistedVolcano.gateEntries);
    if (persistedVolcano.authoritative) {
      startupStandby.restoreCanonicalVolcanoes(
        persistedVolcano.active,
        persistedVolcano.gateEntries,
        startupNowMs,
      );
    }
    const foundationVolcanoSubjects = new Set(
      persistedVolcano.gateEntries.map((entry) => entry.stateSubjectKey),
    );
    startupVolcano.seedLegacyEruptionIdentities(
      activeLegacyEruptionIdentitySeeds(
        persistedStandby.volcanoes,
        foundationVolcanoSubjects,
        restoredAtMs,
      ),
    );
    // The generation-1 holder is the sole volcano content owner even when its
    // repair envelope is degraded.  Never retain a rollback projection that
    // disagrees with it: rollback is an output mirror, not a restore input for
    // an already-normalized canonical foundation.
    startupStandby.replaceVolcanoDerived(startupVolcano.snapshot());
    const persistedFlood = persistedStandby.telegramFoundation.floodForecast;
    floodFoundationAuthoritative = persistedFlood.authoritative;
    startupGate.restoreDurableEntries(persistedFlood.gateEntries);
    startupGate.expireRevisionFamily(
      "floodForecast",
      "floodForecast",
      restoredAtMs,
      FLOOD_FORECAST_RETENTION_MS,
    );
    if (persistedFlood.authoritative) {
      startupStandby.restoreCanonicalFloods(
        persistedFlood.active,
        restoredAtMs,
        persistedFlood.legacyEventIds ?? [],
      );
    }
    startupVptaProjectionChanged = startupStandby.maintainTyphoonProbabilitySubjects(
      startupNowMs,
      startupGate.activeRevisionFamilySubjects("typhoonProbability", "VPTA50"),
    ).durableChanged;
    startupVpwp50ProjectionChanged = startupStandby.maintainWeatherWarningForecastSubjects(
      startupNowMs,
      startupGate.revisionFamilySubjectKeys("weatherWarningTimeseries", "VPWP50"),
    ).durableChanged;
    if (persistedVpws50.authoritative) {
      const identity = startupVpws50.getCurrentIdentity();
      startupStandby.restoreCanonicalVpws50Alerts(
        weatherAlertsFromVpws50(startupVpws50.getCurrentAreasForDisplay(), identity?.reportDateTime ?? ""),
        identity?.reportDateTime ?? null,
        identity?.serial ?? null,
      );
    }
    if (persistedVpww56.authoritative) {
      const activeRevision = startupGate.latestActiveRevisionFamilyRevision("weather", "VPWW56");
      const reportDateTime = activeRevision?.reportDateTime ?? null;
      startupStandby.restoreCanonicalVpww56Alerts(
        weatherAlertsFromVpww56(startupVpww56.getCurrentAreasForDisplay(), reportDateTime ?? ""),
        reportDateTime,
        activeRevision?.serial ?? null,
      );
    }
  }
  if (persistedStandby == null) {
    startupVptaGateChanged = startupGate.expireRevisionFamily(
      "typhoonProbability", "VPTA50", startupNowMs, TYPHOON_PROBABILITY_RETENTION_MS,
    );
    startupVpwp50GateChanged = startupGate.expireRevisionFamily(
      "weatherWarningTimeseries",
      "VPWP50",
      startupNowMs,
      WEATHER_TIMESERIES_RETENTION_MS,
    );
  }
  persistenceAdmission.restorePrevalidated({
    telegramRevisionGate: startupGate.cloneSnapshot(),
    standbyStateStore: startupStandby.cloneSnapshot(),
    vpws50State: startupVpws50.cloneSnapshot(),
    vpww56State: startupVpww56.cloneSnapshot(),
    tsunamiState: startupTsunami.cloneSnapshot(),
    volcanoHolderAndRepair: {
      runtimeVersion: startupVolcano.version(),
      holder: startupVolcano.snapshot(),
      repair: structuredClone(volcanoRepairState),
    },
    floodForecastState: startupFlood.cloneSnapshot(),
  });
  const startupSweep = persistenceAdmission.sweepAll(startupNowMs);
  if (startupSweep.kind !== "committed") {
    throw new Error(
      `standby startup sweep rejected: ${startupSweep.kind === "rejected" ? startupSweep.reason : "staleVersion"}`,
    );
  }
  volcanoRepairState = volcanoTransactionCoordinator.snapshot().repair;
  const startupSweepMutation = {
    durableChanged: startupSweep.value.durableChanged,
  };
  // salvage source は全 holder / gate の restore と起動時 sweep が完了してからだけ
  // canonical 化する。通常 load では pending repair が無く、追加 write は発生しない。
  startupPersistenceDirty ||= persistedLoad.canonicalRewriteRequired
    || persistedStandby != null && (
    briefingCriticalRewriteRequired
    || standbyPersistence.hasPendingSalvageRepair()
    || startupVptaGateChanged
    || startupVptaProjectionChanged
    || startupVpwp50GateChanged
    || startupVpwp50ProjectionChanged
    || startupSweepMutation.durableChanged
  );
  // 原文退避は save 予約や後続電文に依存させない。失敗時は persistence
  // 自身の 1/2/4/.../60 秒 timer が runtime startup と並行して再試行する。
  standbyPersistence.startSalvageBackupWorkflow();
  standbyStore.onDurable(() => {
    if (standbyDurableSuppressionDepth === 0) {
      scheduleLatestStandbyPersistence();
    }
  });
  persistenceAdmission.onDurable(() => {
    volcanoRepairState = volcanoTransactionCoordinator.snapshot().repair;
    scheduleLatestStandbyPersistence();
  });

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
    const allDomains = persistenceAdmission.sweepAll(nowMs);
    if (allDomains.kind !== "committed") {
      log.warn(`[standby-admission] sweep reason=${allDomains.kind === "rejected" ? allDomains.reason : "staleVersion"}`);
    }
    typhoonProbabilityState.sweep(nowMs);
    return {
      viewChanged: allDomains.kind === "committed" && allDomains.value.durableChanged,
      durableChanged: allDomains.kind === "committed" && allDomains.value.durableChanged,
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
    reconcileBriefingCardAdmission: (sourceKey, event, nowMs) => {
      if (!sweepStandbyBeforeAdmission(
        persistenceAdmission,
        "standby:briefingCritical",
        nowMs,
      )) throw new Error("preAdmissionSweepRejected");
      const transaction = persistenceAdmission.transact(
        "standby:briefingCritical",
        ["telegramRevisionGate", "standbyStateStore"],
        (draft) => {
          const scratch = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
          const result = scratch.reconcileBriefingCard(sourceKey, event, nowMs);
          draft.standbyStateStore = scratch.cloneSnapshot();
          return {
            kind: "accepted",
            value: result,
            durableChanged: result.kind === "applied",
          };
        },
      );
      if (transaction.kind !== "committed") {
        throw new Error(
          transaction.kind === "rejected" ? transaction.reason : "staleVersion",
        );
      }
      return transaction.value;
    },
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
    ingest: (e, internalCommand) => baseDisplaySink.ingest(e, internalCommand),
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
    activeTyphoonProbabilitySubjects: (nowMs) =>
      baseDisplaySink.activeTyphoonProbabilitySubjects?.(nowMs) ?? [],
    activeWeatherWarningForecastSubjects: (nowMs) =>
      baseDisplaySink.activeWeatherWarningForecastSubjects?.(nowMs) ?? [],
    maintainTyphoonProbabilitySubjects: (nowMs, subjects) =>
      baseDisplaySink.maintainTyphoonProbabilitySubjects?.(nowMs, subjects)
      ?? { viewChanged: false, durableChanged: false },
    maintainWeatherWarningForecastSubjects: (nowMs, subjects) =>
      baseDisplaySink.maintainWeatherWarningForecastSubjects?.(nowMs, subjects)
      ?? { viewChanged: false, durableChanged: false },
    reconcileTyphoonProbabilityCommand: (command) =>
      baseDisplaySink.reconcileTyphoonProbabilityCommand?.(command)
      ?? { viewChanged: false, durableChanged: false },
    reconcileTyphoonProbabilitySubject: (eventId) =>
      baseDisplaySink.reconcileTyphoonProbabilitySubject?.(eventId)
      ?? { viewChanged: false, durableChanged: false },
  };
  let displayRuntime: DisplayRuntime | null = null;
  // dmdata 接続状態 (onConnected/onDisconnected が更新)。display on 時の接続状態 seed に使う
  let disconnectedAt: number | null = null;
  let isFirstConnection = true;

  const pipeline = pipelineController?.getPipeline();
  let manager: MultiConnectionManager | null = null;
  const persistAcceptedTsunamiRevision = () => {
    scheduleLatestStandbyPersistence();
  };
  const persistVptaAdmissionCompletion = (
    completion: VptaAdmissionCompletion,
  ): VptaPersistenceCompletionAck => {
    const durableChanged = completion.changes.gateExpiry
      || completion.changes.projectionCleanup
      || completion.changes.incomingGate
      || completion.changes.projectionOrRetention;
    const shapeValid = durableChanged === completion.durableChanged
      && (completion.kind === "accepted"
        ? completion.durableChanged === true && completion.persistence === "deferred"
        : completion.kind === "suppressed"
          ? completion.durableChanged
            ? completion.persistence === "deferred"
            : completion.persistence === "none"
          : completion.durableChanged
            ? completion.persistence === "immediate"
            : completion.persistence === "none");
    if (!shapeValid) {
      return {
        kind: "failed", operation: "completionCallback", completionAlreadyEmitted: true,
        receipt: null, cause: new Error("invalid VPTA admission completion durability"),
      };
    }
    if (!completion.durableChanged) return { kind: "notRequired" };
    const asynchronousFailure = standbyPersistence.lastFailure();
    if (asynchronousFailure != null) {
      return {
        kind: "failed", operation: "schedule", completionAlreadyEmitted: true,
        receipt: null, cause: asynchronousFailure,
      };
    }

    let receipt;
    try {
      receipt = scheduleCapturedStandbyPersistence();
    } catch (cause) {
      return {
        kind: "failed", operation: "schedule", completionAlreadyEmitted: true,
        receipt: null, cause,
      };
    }
    if (completion.persistence === "deferred") return { kind: "scheduled", receipt };
    let result;
    try {
      result = standbyPersistence.flushThrough(receipt.seq);
    } catch (cause) {
      return {
        kind: "failed", operation: "flushThrough", completionAlreadyEmitted: true,
        receipt, cause,
      };
    }
    if (result.kind === "failed") {
      return {
        kind: "failed", operation: "flushThrough", completionAlreadyEmitted: true,
        receipt, cause: result.cause,
      };
    }
    return { kind: "flushed", receipt, result };
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
    typhoonProbabilityState,
    revisionGate,
    persistenceAdmission,
    volcanoTransactionCoordinator,
    onVpws50RevisionDecision: (decision) => {
      if (decision.accepted) vpws50FoundationAuthoritative = true;
    },
    onVpws50StateMutationAccepted: () => {
      vpws50FoundationAuthoritative = true;
    },
    onVpww56RevisionDecision: (decision) => {
      if (decision.accepted) vpww56FoundationSchemaTrusted = true;
    },
    onTsunamiRevisionDecision: () => {},
    onVolcanoRevisionDecision: (decision) => {
      if (!decision.accepted && !decision.semanticKeyMigrated) return;
      if (decision.accepted) volcanoFoundationAuthoritative = true;
    },
    onFloodRevisionDecision: (decision) => {
      if (!decision.accepted) return;
      floodFoundationAuthoritative = true;
    },
    onStandbyRevisionDecision: (decision, context) => {
      if (context?.domain === "weatherWarningTimeseries"
        && context.revisionFamily === "VPWP50") {
        if (!decision.accepted && decision.preAdmissionDurableChanged !== true) return;
        if (standbyDurableSuppressionDepth > 0) {
          vpwp50AdmissionPersistencePending = true;
        } else {
          scheduleLatestStandbyPersistence();
        }
        return;
      }
      if (decision.accepted || decision.preAdmissionDurableChanged === true) {
        // Pair-persisted standby families already scheduled through the global
        // admission callback.  Only VPWP50 still owns the legacy completion path.
      }
    },
    onVptaStandbyRevisionDecision: () => {
      // Observer only. VPTA persistence is owned exclusively by completion below.
    },
    onVptaAdmissionCompletion: persistVptaAdmissionCompletion,
    withStandbyDurableNotificationsSuppressed,
    flushStandbyThrough: (requiredSeq) => standbyPersistence.flushThrough(requiredSeq),
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
  let volcanoRepairJournal: VolcanoRepairJournal | null = null;

  manager = new MultiConnectionManager(config, {
    onPrimaryTransportData: (msg, transport) => {
      volcanoRepairJournal?.record(msg, transport);
    },
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
      volcanoRepairJournal?.failAll("subscriptionDisconnected");
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
      // export / validation が失敗しても debounce callback を shutdown 中に走らせない。
      // pending 自体は typed save が成功するまで durable fallback として保持する。
      standbyPersistence.stopTimer();
      // 予約済み state は export / validation / write のどこかが失敗した場合の durable
      // fallback なので、同期保存が両 mirror を commit するまでは破棄しない。
      const result = saveCapturedStandbyPersistence();
      if (result.kind === "written") standbyPersistence.dispose();
      return result;
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
  const shutdownFromRepl = async (): Promise<void> => {
    await runShutdownAndRecordExitCode(shutdown);
  };
  const volcanoRestRepair = createVolcanoRestRepair({
    apiKey: config.apiKey,
    coordinator: volcanoTransactionCoordinator,
    getJournal: () => volcanoRepairJournal,
    setJournal: (journal) => { volcanoRepairJournal = journal; },
    getAcknowledgement: () => manager?.getSubscriptionAcknowledgement() ?? null,
    backupCurrentMirrors: () => standbyPersistence.backupCurrentMirrors("manual"),
    applyRepairState: (repair, authoritative) => {
      volcanoRepairState = repair;
      volcanoFoundationAuthoritative = authoritative;
    },
    scheduleStandbyPersistence: () => { scheduleLatestStandbyPersistence(); },
    commitScope: manualRepairCommitScope,
  });
  const volcanoRepairAdministration: VolcanoRepairAdministration = {
    status: () => volcanoTransactionCoordinator.status(),
    resolveOperationalV2AlertOmission: (request) =>
      volcanoTransactionCoordinator.resolveOperationalV2AlertOmission(request),
    restRepair: volcanoRestRepair,
  };

  replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdownFromRepl, stats, [tsunamiState, volcanoState], [tsunamiState, volcanoState, tornadoDetailProvider, vpws50State, vpwp50Cache], pipelineController, summaryTracker, displayController, volcanoRepairAdministration);

  registerShutdownSignals(shutdown);

  // 定期要約タイマー
  summaryTimerControl = createSummaryTimerControl(config, summaryTracker, () => replHandler);
  replHandler.setSummaryTimerControl(summaryTimerControl);


  // REPL/display は normal ingress の side effect sink として先に準備する。
  replHandler.start();
  if (config.display) {
    await displayController.start();
  }

  // Primary normal ingress と server start acknowledgement が REST より先だ。
  try {
    await manager.connect();
    const targets = volcanoRepairTargets(volcanoTransactionCoordinator.snapshot().repair);
    if (targets.length > 0) {
      const acknowledgement = await manager.waitForSubscriptionAcknowledgement();
      volcanoRepairJournal = new VolcanoRepairJournal(acknowledgement, targets);
    }

    // Await 後に coordinator が最新 composition を capture するので、この間の
    // weather/briefing/flood/live tsunami mutation を上書きしない。
    await restoreTsunamiState(
      config.apiKey,
      tsunamiState,
      revisionGate,
      persistAcceptedTsunamiRevision,
      persistenceAdmission,
    );

    if (volcanoRepairJournal != null) {
      const repair = await repairVolcanoState({
        apiKey: config.apiKey,
        nowMs: startupNowMs,
        coordinator: volcanoTransactionCoordinator,
        journal: volcanoRepairJournal,
        getAcknowledgement: () => manager?.getSubscriptionAcknowledgement() ?? null,
      });
      for (const result of repair.targets) {
        if (result.kind === "failed") {
          log.warn(`火山 ${result.target} repair proof failed: ${result.reason ?? "unknown"}`);
        }
      }
      volcanoRepairJournal = null;
    }
    volcanoRepairState = volcanoTransactionCoordinator.snapshot().repair;
    volcanoFoundationAuthoritative = volcanoFoundationAuthoritativeFrom(volcanoRepairState);

    // restore/sweep/salvage/repair と repair await 中の live dirty を最大一予約へ合流する。
    startupPersistenceSchedulingSuppressed = false;
    if (startupPersistenceDirty) {
      startupPersistenceDirty = false;
      scheduleLatestStandbyPersistence();
    }

    // 副回線は primary repair 完了後にだけ開始する。
    if (config.backup) {
      try {
        await manager.startBackup();
      } catch (err) {
        log.warn(`副回線の起動に失敗しました: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    volcanoRepairJournal?.failAll("startupConnectionFailure");
    volcanoRepairJournal = null;
    startupPersistenceSchedulingSuppressed = false;
    if (startupPersistenceDirty) {
      startupPersistenceDirty = false;
      scheduleLatestStandbyPersistence();
    }
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
