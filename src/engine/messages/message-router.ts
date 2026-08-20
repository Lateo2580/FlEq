import chalk from "chalk";
import * as log from "../../logger";
import type { WsDataMessage } from "../../types";
import {
  normalizeTelegramMessage,
  requireTelegramMeta,
} from "../../dmdata/telegram-ingress";
import { telegramDateDiagnosticReason } from "../../dmdata/telegram-meta";
import { EewTracker } from "../eew/eew-tracker";
import { EewEventLogger } from "../eew/eew-logger";
import { Notifier } from "../notification/notifier";
import { TsunamiStateHolder } from "./tsunami-state";
import { VolcanoStateHolder } from "./volcano-state";
import { Vpws50StateHolder } from "./vpws50-state";
import { Vpww56StateHolder } from "./vpww56-state";
import { Vpwp50DetailCache } from "./vpwp50-detail-cache";
import { TyphoonProbabilityStateHolder } from "./typhoon-probability-state";
import { FloodForecastStateHolder } from "./flood-forecast-state";
import { TelegramStats, routeToCategory } from "./telegram-stats";
import { classifyMessage } from "./route-catalog";
import type { Route } from "./route-catalog";
import { assertNever } from "../../utils/assert-never";
import { SummaryWindowTracker } from "./summary-tracker";
import { DailyQuakeCounter } from "./daily-quake-counter";
import type { DisplayStatsV1 } from "../display/types";
import { processMessage as processMsg, ProcessDeps } from "../presentation/processors/process-message";
import { toPresentationEvent } from "../presentation/events/to-presentation-event";
import { expandVolcanoBatchForDisplay } from "../presentation/events/from-volcano";
import { shouldDisplay, renderTemplate } from "../filter-template/pipeline";
import type { FilterTemplatePipeline } from "../filter-template/pipeline";
import { PresentationDiffStore } from "../presentation/diff-store";
import type { ProcessOutcome, VolcanoBatchOutcome, PresentationEvent } from "../presentation/types";
import { VolcanoRouteHandler } from "./volcano-route-handler";
import type { DisplayCallbacks } from "./display-callbacks";
import type { DisplayIngestSink } from "../display/types";
import { TelegramTransportDeduplicator } from "./telegram-transport-dedup";
import {
  dateDiagnosticPresentationEvent,
  telegramDateDiagnostic,
} from "./telegram-diagnostic";
import { TelegramRevisionGate, type TelegramRevisionDecision } from "./telegram-revision-gate";
import { routeHasExplicitRevisionFamilyPolicy } from "./revision-family-registry";
import {
  createUnknownDeliveryCapabilities,
  type DeliveryCapabilities,
} from "../../dmdata/delivery-capabilities";
import {
  LegacyCounterpartCorrelator,
  type LegacyCounterpartAction,
  type LegacyCounterpartAffectedSource,
  type LegacyCounterpartCorrelatorFactory,
  type LegacyCounterpartLifecycleEvent,
} from "./legacy-counterpart-correlator";

// ── 電文分類 (Route) ──
//
// Route 型・分類関数 (classifyMessage)・head.type 集合・優先順位はすべて
// `route-catalog.ts` に集約した。ここでは既存 import 互換のため Route を再 export する。

export type { Route } from "./route-catalog";

// ── dispatch helpers ──

/** 通知のみ実行 (filter 非適用) */
function dispatchNotify(outcome: ProcessOutcome, notifier: Notifier): boolean {
  if (outcome.presentation.foundationMutationAccepted === false) return false;
  if (
    ["tornado", "heatAlert", "typhoonAnalysis", "typhoonProbability", "nankaiTrough",
      "weatherWarningTimeseries", "lgObservation"].includes(outcome.domain)
    && outcome.presentation.standbyStateMutationAccepted === false
  ) return false;
  switch (outcome.domain) {
    case "eew":
      notifier.notifyEew(outcome.parsed, outcome.eewResult);
      return true;
    case "earthquake":
      notifier.notifyEarthquake(outcome.parsed);
      return true;
    case "seismicText":
      notifier.notifySeismicText(outcome.parsed);
      return true;
    case "lgObservation":
      notifier.notifyLgObservation(outcome.parsed);
      return true;
    case "tsunami":
      notifier.notifyTsunami(outcome.parsed);
      return true;
    case "nankaiTrough":
      notifier.notifyNankaiTrough(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "weather": {
      // 官署欠落などで authoritative subject を確定できなかった VPWW56 は
      // ticker 表示だけへ流し、OS 通知・通知音・notified 統計には数えない。
      if (
        outcome.headType === "VPWW56"
        && outcome.presentation.weatherStateMutationAccepted !== true
      ) return false;
      const diff = outcome.presentation.weatherDiff;
      // 変化なし (再掲対象でなければ) は通知を抑制 (spec §4.3)
      const acceptedVpws50Correction = outcome.headType === "VPWS50"
        && outcome.parsed.infoType === "訂正";
      if (diff?.isUnchanged && !diff.shouldRecap && !acceptedVpws50Correction) {
        return false;
      }
      // Codex 最終レビュー F-3: processWeather の unsafe 昇格 (soundLevel="warning") を
      // notifier 内の weatherSoundLevel 再計算で潰さないよう presentation.soundLevel を渡す
      notifier.notifyWeatherWarning(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    }
    case "tornado":
      // weather F-3 の横展開: notifier 内再計算との drift を防ぐ
      notifier.notifyTornadoAdvisory(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "briefing":
      // weather F-3 の横展開: notifier 内再計算との drift を防ぐ
      notifier.notifyWeatherBriefing(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "earlyWeather":
      notifier.notifyEarlyWeather(outcome.parsed);
      return true;
    case "weatherWarningTimeseries":
      notifier.notifyWeatherWarningTimeseries(outcome.parsed);
      return true;
    case "climateInfo":
      notifier.notifyClimateInfo(outcome.parsed);
      return true;
    case "weatherExplanation":
      notifier.notifyWeatherExplanation(outcome.parsed);
      return true;
    case "heatAlert":
      // 再計算 drift 予防: presentation.soundLevel を第 2 引数で渡す (weather F-3 の横展開)
      notifier.notifyHeatAlert(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "typhoonAnalysis":
      notifier.notifyTyphoonAnalysis(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "typhoonProbability": {
      if (outcome.presentation.suppressNotify) return false;
      notifier.notifyTyphoonProbability(
        outcome.parsed,
        outcome.presentation.soundLevel,
      );
      return true;
    }
    case "floodForecast": {
      if (outcome.presentation.floodStateMutationAccepted !== true) return false;
      // suppressNotify=true (VXKO 通常発表で station 内容変化なし) は通知を抑制
      if (outcome.presentation.suppressNotify) return false;
      notifier.notifyFloodForecast(
        outcome.parsed,
        outcome.presentation.soundLevel,
      );
      return true;
    }
    case "legacyCounterpart":
      return notifier.notifyLegacyCounterpart(
        outcome.parsed,
        outcome.severity === "high",
      );
    case "raw":
      // raw: 通知なし (フォールバック表示のみ)
      return false;
    case "volcano":
      // 特殊ルート: 火山は VolcanoRouteHandler が通知を担当するため dispatchNotify には到達しない。
      // 網羅性のため明示的に no-op で受ける。
      return false;
    default:
      // PresentationDomain に新メンバーが増えて case を足し忘れるとコンパイルエラー。
      assertNever(outcome);
  }
}

/** outcome.stats に基づいて統計を記録する */
function recordStats(outcome: ProcessOutcome, stats: TelegramStats, nowMs?: number): void {
  if (outcome.stats.shouldRecord) {
    stats.record({
      headType: outcome.headType,
      category: outcome.statsCategory,
      eventId: outcome.stats.eventId,
    }, nowMs);
  }
  if (outcome.stats.maxIntUpdate) {
    const u = outcome.stats.maxIntUpdate;
    stats.updateMaxInt(u.eventId, u.maxInt, u.headType, nowMs);
  }
}

/** 情報ディスプレイ向け DisplayStatsV1 を組み立てる (毎回 fresh object を返す) */
function buildDisplayStats(
  summary: SummaryWindowTracker,
  stats: TelegramStats,
  daily: DailyQuakeCounter,
  now?: number,
): DisplayStatsV1 {
  const s = summary.getSnapshot(now);
  const d = daily.getSnapshot(now);
  return {
    sparklineData: s.sparklineData,
    totalReceived: stats.totalCount(now),
    todayQuakeCount: d.todayQuakeCount,
    todayMaxInt: d.todayMaxInt,
    todayMaxIntRank: d.todayMaxIntRank,
  };
}

// ── ファクトリ ──

/**
 * 分類済みの全電文を観測できる汎用購読点。
 *
 * `classifyMessage()` 直後 (ignore 早期 return・火山分岐・各種 suppression より前) に
 * 同期呼び出しされる。ignore / raw / 後段 suppressed / 火山を含む「XML かつ分類済みの
 * 全電文」が渡る。
 *
 * 契約: 重い処理をここに置かない (キュー投入や軽量な記録までに留める)。tap 内の例外は
 * 呼び出し側で握り潰され本体処理には波及しないが、その分の失敗は listener 側の責務。
 */
export type RoutedMessageTap = (event: {
  route: Route;
  message: WsDataMessage;
}) => void;

/** tap の throw/reject 値を安全に文字列化する (null や非 Error でも二次例外を出さない) */
function describeTapError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** raw fallback は画面から抑止するが、未対応電文の受信事実は 1 件ずつ観測可能にする。 */
function logUnknownRawFallback(msg: WsDataMessage): void {
  const receivedAtMs = msg.meta?.receivedAtMs;
  const receivedAt = receivedAtMs != null && Number.isFinite(receivedAtMs)
    ? new Date(receivedAtMs)
    : new Date();
  log.info(
    `[unknown-telegram] type=${msg.head.type} receivedAt=${receivedAt.toISOString()}`,
  );
}

/**
 * 処理済み outcome を観測できる汎用購読点。
 *
 * `runDisplayPipeline()` の入口 (shouldDisplay 判定・diff 適用より前) で同期呼び出しされる。
 * 線形ルートの ProcessOutcome に加えて火山単発・火山バッチ (VolcanoBatchOutcome) も渡る。
 * suppressed で null に落ちた電文は通らない (処理済み outcome が存在するもののみ)。
 *
 * 契約: 重い処理をここに置かない (キュー投入や軽量な記録までに留める)。tap 内の例外は
 * 呼び出し側で握り潰され本体処理には波及しないが、その分の失敗は listener 側の責務。
 */
export type ProcessedOutcomeTap = (
  outcome: ProcessOutcome | VolcanoBatchOutcome,
) => void;

/** createMessageHandler のオプション */
export interface MessageHandlerOptions {
  pipeline?: FilterTemplatePipeline;
  display?: DisplayCallbacks;
  displaySink?: DisplayIngestSink;
  /** 分類済みの全電文を観測する汎用 tap (同期・軽量前提)。@see RoutedMessageTap */
  routeTaps?: readonly RoutedMessageTap[];
  /** 処理済み outcome を観測する汎用 tap (同期・軽量前提)。@see ProcessedOutcomeTap */
  outcomeTaps?: readonly ProcessedOutcomeTap[];
  /** monitor 所有の日次地震状態。未指定時は従来どおり handler 専用の instance を作る。 */
  dailyQuakeCounter?: DailyQuakeCounter;
  /** monitor が永続状態を復元するときに同一 instance を注入する。 */
  vpws50State?: Vpws50StateHolder;
  vpww56State?: Vpww56StateHolder;
  tsunamiState?: TsunamiStateHolder;
  volcanoState?: VolcanoStateHolder;
  floodForecastState?: FloodForecastStateHolder;
  /** durable revision watermark の復元用。 */
  revisionGate?: TelegramRevisionGate;
  /** 最初の durable domain が v1 表示復元状態を脱したことを monitor へ伝える。 */
  onVpws50RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** VPWW56 stream/gate の commit 完了を persistence owner へ伝える。 */
  onVpww56RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** tsunami gate/item state の commit 完了を persistence owner へ伝える。 */
  onTsunamiRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** volcano gate/holder の commit 完了を persistence owner へ伝える。 */
  onVolcanoRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onFloodRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** tornado/heat/typhoon/nankai/VPWP/VXSE62 common gate commit. */
  onStandbyRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** message 処理時点の process-wide capability を読む遅延 getter。 */
  getDeliveryCapabilities?: () => DeliveryCapabilities;
  /** Phase 6B integration test 用。未指定時は production correlator を handler が所有する。 */
  legacyCounterpartCorrelatorFactory?: LegacyCounterpartCorrelatorFactory;
}

/** createMessageHandler の戻り値 */
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  eewTracker: EewTracker;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  vpws50State: Vpws50StateHolder;
  vpww56State: Vpww56StateHolder;
  floodForecastState: FloodForecastStateHolder;
  vpwp50Cache: Vpwp50DetailCache;
  stats: TelegramStats;
  summaryTracker: SummaryWindowTracker;
  dailyQuakeCounter: DailyQuakeCounter;
  /** 起動直後と display on 時に明示 publish する stats snapshot。 */
  buildDisplayStats: (now?: number) => DisplayStatsV1;
  flushAndDisposeVolcanoBuffer: () => void;
  /** handler 所有の legacy correlator／timerを冪等に破棄する唯一の口。 */
  disposeLegacyCounterpartCorrelator: () => void;
}

/** 受信データのハンドリング */
export function createMessageHandler(options?: MessageHandlerOptions): MessageHandlerResult {
  const pipeline: FilterTemplatePipeline = options?.pipeline ?? { filter: null, template: null, focus: null };
  const display = options?.display;
  const displaySink = options?.displaySink;
  const routeTaps = options?.routeTaps;
  const outcomeTaps = options?.outcomeTaps;
  const eewLogger = new EewEventLogger();
  const notifier = new Notifier();
  const tsunamiState = options?.tsunamiState ?? new TsunamiStateHolder();
  const volcanoState = options?.volcanoState ?? new VolcanoStateHolder();
  const vpws50State = options?.vpws50State ?? new Vpws50StateHolder();
  const vpww56State = options?.vpww56State ?? new Vpww56StateHolder();
  const vpwp50Cache = new Vpwp50DetailCache();
  const typhoonProbabilityState = new TyphoonProbabilityStateHolder();
  const floodForecastState = options?.floodForecastState ?? new FloodForecastStateHolder();
  const stats = new TelegramStats();
  const summaryTracker = new SummaryWindowTracker();
  const dailyQuakeCounter = options?.dailyQuakeCounter ?? new DailyQuakeCounter();
  const diffStore = new PresentationDiffStore();
  const transportDedup = new TelegramTransportDeduplicator();
  const revisionGate = options?.revisionGate ?? new TelegramRevisionGate();
  let lastStatsNowMs = Number.NEGATIVE_INFINITY;
  const statsNowMs = (rawNowMs: number): number => {
    lastStatsNowMs = Math.max(lastStatsNowMs, rawNowMs);
    return lastStatsNowMs;
  };
  let activeMessageStatsNowMs: number | null = null;
  const callbackStatsNowMs = (): number => statsNowMs(activeMessageStatsNowMs ?? Date.now());
  const withMessageStatsTime = <T>(nowMs: number, callback: () => T): T => {
    activeMessageStatsNowMs = nowMs;
    try {
      return callback();
    } finally {
      activeMessageStatsNowMs = null;
    }
  };
  const eewTracker = new EewTracker({
    onCleanup: (eventId) => {
      eewLogger.closeEvent(eventId, "タイムアウト");
    },
    onRevisionDecision: (decision) => {
      switch (decision.kind) {
        case "replaceCorrection":
          stats.recordFoundation("correctionReplaced", callbackStatsNowMs());
          break;
        case "markCancelled":
          stats.recordFoundation("cancelApplied", callbackStatsNowMs());
          break;
        case "duplicate":
        case "semanticDuplicate":
          stats.recordFoundation("semanticDuplicate", callbackStatsNowMs());
          break;
        case "stale":
          stats.recordFoundation("stale", callbackStatsNowMs());
          break;
        case "invalidMeta":
          stats.recordFoundation("invalidMeta", callbackStatsNowMs());
          break;
        case "invalidRevision":
          stats.recordFoundation("invalidRevision", callbackStatsNowMs());
          break;
        case "cancelTargetMismatch":
          stats.recordFoundation("cancelTargetMismatch", callbackStatsNowMs());
          break;
        default:
          break;
      }
    },
  });

  const recordRevisionDecision = (decision: TelegramRevisionDecision): void => {
    switch (decision.kind) {
      case "replaceCorrection": stats.recordFoundation("correctionReplaced", callbackStatsNowMs()); break;
      case "markCancelled":
      case "restorePrevious":
      case "clearCurrent": stats.recordFoundation("cancelApplied", callbackStatsNowMs()); break;
      case "duplicate":
      case "semanticDuplicate": stats.recordFoundation("semanticDuplicate", callbackStatsNowMs()); break;
      case "stale": stats.recordFoundation("stale", callbackStatsNowMs()); break;
      case "invalidMeta": stats.recordFoundation("invalidMeta", callbackStatsNowMs()); break;
      case "invalidRevision": stats.recordFoundation("invalidRevision", callbackStatsNowMs()); break;
      case "cancelTargetMismatch": stats.recordFoundation("cancelTargetMismatch", callbackStatsNowMs()); break;
      default: break;
    }
  };

  const processDeps: ProcessDeps = {
    eewTracker,
    eewLogger,
    tsunamiState,
    volcanoState,
    vpws50State,
    vpww56State,
    floodForecastState,
    vpwp50Cache,
    typhoonProbabilityState,
    revisionGate,
    onRevisionDecision: recordRevisionDecision,
    onVpws50RevisionDecision: options?.onVpws50RevisionDecision,
    onVpww56RevisionDecision: options?.onVpww56RevisionDecision,
    onTsunamiRevisionDecision: options?.onTsunamiRevisionDecision,
    onFloodRevisionDecision: options?.onFloodRevisionDecision,
    onStandbyRevisionDecision: options?.onStandbyRevisionDecision,
    getDeliveryCapabilities: options?.getDeliveryCapabilities
      ?? (() => createUnknownDeliveryCapabilities()),
    onVxse44Suppressed: (reason) => {
      stats.recordFoundationForHeadType(
        "VXSE44",
        reason === "observed-vxse45"
          ? "vxse44SuppressedByObservedVxse45"
          : "vxse44SuppressedByCapability",
        callbackStatsNowMs(),
      );
    },
  };

  /**
   * 共通の表示パイプライン処理。
   * filter/diffStore/summaryTracker/focus/template/compact の6ステップを一元的に実行する。
   * @returns true なら表示済み。false ならフィルタで非表示。
   */
  function runDisplayPipeline(
    outcome: ProcessOutcome | VolcanoBatchOutcome,
    displayFn: () => void,
    statsAtMs?: number,
  ): boolean {
    // 処理済み outcome の汎用 tap (filter 非適用: shouldDisplay の判定より前)。
    // 線形ルート・火山単発・火山バッチの全 outcome がここを通る。例外は本体へ波及させない。
    if (outcomeTaps) {
      for (const tap of outcomeTaps) {
        try {
          const result = tap(outcome) as unknown;
          if (result instanceof Promise) {
            result.catch((e: unknown) => {
              log.warn(`[outcome-tap] async tap の reject: ${describeTapError(e)}`);
            });
          }
        } catch (e) {
          log.warn(`[outcome-tap] tap 実行で例外: ${describeTapError(e)}`);
        }
      }
    }

    const rawEvent: PresentationEvent = toPresentationEvent(outcome);
    const event = diffStore.apply(rawEvent);

    const displayed = shouldDisplay(event, pipeline);
    summaryTracker.record(event, displayed);   // ← ingest より先 (1 イベント遅れ防止)
    dailyQuakeCounter.record(event);
    try {
      const isVolcanoBatch =
        outcome.domain === "volcano" && "isBatch" in outcome && outcome.isBatch === true;
      if (isVolcanoBatch && outcome.sources.length > 0) {
        for (const volcanoEvent of expandVolcanoBatchForDisplay(outcome)) {
          displaySink?.ingest(volcanoEvent);
        }
      } else {
        displaySink?.ingest(event);
      }
      displaySink?.publishStats?.(buildDisplayStats(summaryTracker, stats, dailyQuakeCounter, statsAtMs));
    } catch {
      // 表示系の障害を本体に波及させない
    }

    if (!displayed) {
      return false;
    }

    const isFocused = pipeline.focus == null || pipeline.focus(event);
    if (!isFocused && display) {
      console.log(chalk.dim(display.renderSummaryLine(event)));
      return true;
    }

    const templateOutput = renderTemplate(event, pipeline);
    if (templateOutput != null) {
      console.log(templateOutput);
      return true;
    }

    if (display && display.getDisplayMode() === "compact") {
      console.log(display.renderSummaryLine(event));
      return true;
    }

    displayFn();
    return true;
  }

  function emitAcceptedOutcome(
    outcome: ProcessOutcome,
    actionNowMs: number,
    allowNotification = true,
  ): { notified: boolean; presented: boolean } {
    const notified = allowNotification && dispatchNotify(outcome, notifier);
    const acceptedCorrection = outcome.domain === "eew"
      ? outcome.eewResult.isCorrection === true
      : outcome.presentation.acceptedCorrection === true;
    if (acceptedCorrection && notified) {
      stats.recordFoundation("correctionNotified", actionNowMs);
    }
    if (notified) stats.recordFoundation("notified", actionNowMs);
    const presented = runDisplayPipeline(
      outcome,
      () => display?.displayOutcome(outcome),
      actionNowMs,
    );
    if (presented) stats.recordFoundation("presented", actionNowMs);
    return { notified, presented };
  }

  function sourceDispositions(action: LegacyCounterpartAction): readonly LegacyCounterpartAffectedSource[] {
    if (action.kind === "emitNow" || action.kind === "holdSource") return [];
    if (action.affectedSources != null) return action.affectedSources;
    switch (action.kind) {
      case "suppressSource":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          counterpartOutcome: action.counterpartOutcome,
        }];
      case "releaseSource":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          reason: action.reason,
        }];
      case "ambiguousSource":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          candidateCount: action.candidateCount,
          ...(action.ambiguityReason == null ? {} : { ambiguityReason: action.ambiguityReason }),
        }];
      case "reconcileLateCounterpart":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceOutcome: action.sourceOutcome,
          sourceIdentity: action.sourceIdentity,
        }];
    }
  }

  function recordLegacyNotificationDisposition(
    outcome: Extract<ProcessOutcome, { domain: "legacyCounterpart" }>,
    notified: boolean,
    actionNowMs: number,
  ): void {
    if (outcome.severity === "high") {
      if (notified) {
        stats.recordFoundationForHeadType(
          outcome.parsed.type,
          "legacyUnmatchedHighSeverityNotified",
          actionNowMs,
        );
      }
      return;
    }
    stats.recordFoundationForHeadType(
      outcome.parsed.type,
      outcome.severity === "nonHigh"
        ? "legacyUnmatchedNonHighNotificationSuppressed"
        : "legacySeverityUnknownNotificationSuppressed",
      actionNowMs,
    );
  }

  function handleLegacyCounterpartAction(action: LegacyCounterpartAction): void {
    const actionNowMs = statsNowMs(action.decidedAtMs);
    if (action.kind === "emitNow") {
      emitAcceptedOutcome(action.outcome, actionNowMs);
      return;
    }
    if (action.kind === "holdSource") return;

    const triggerOutcome = "triggerOutcome" in action ? action.triggerOutcome : undefined;
    if (triggerOutcome != null) {
      emitAcceptedOutcome(triggerOutcome, actionNowMs);
    }

    for (const disposition of sourceDispositions(action)) {
      switch (disposition.kind) {
        case "suppressSource":
          stats.recordFoundationForHeadType(
            disposition.outcome.parsed.type,
            "legacyMatchedSuppressed",
            actionNowMs,
          );
          break;
        case "releaseSource": {
          const evaluateNotification = disposition.reason !== "counterpartCancelled";
          const emitted = emitAcceptedOutcome(
            disposition.outcome,
            actionNowMs,
            evaluateNotification,
          );
          if (emitted.presented) {
            stats.recordFoundationForHeadType(
              disposition.outcome.parsed.type,
              "legacyUnmatchedDisplayed",
              actionNowMs,
            );
          }
          if (evaluateNotification) {
            recordLegacyNotificationDisposition(
              disposition.outcome,
              emitted.notified,
              actionNowMs,
            );
          }
          break;
        }
        case "ambiguousSource": {
          const emitted = emitAcceptedOutcome(disposition.outcome, actionNowMs, false);
          if (emitted.presented) {
            stats.recordFoundationForHeadType(
              disposition.outcome.parsed.type,
              "legacyAmbiguousDisplayed",
              actionNowMs,
            );
          }
          break;
        }
        case "reconcileLateCounterpart":
          // 骨組みでは typed action と canonical outcome の通常 emit まで。
          // active surface の原子的 reconcile 成功 metric は 6B 後半で有効化する。
          if (disposition.outcome !== triggerOutcome) {
            emitAcceptedOutcome(disposition.outcome, actionNowMs);
          }
          break;
      }
    }
  }

  function handleLegacyCounterpartLifecycleEvent(event: LegacyCounterpartLifecycleEvent): void {
    const eventNowMs = statsNowMs(event.decidedAtMs);
    switch (event.kind) {
      case "legacySourceArrivedFirst":
        stats.recordFoundationForHeadType(event.sourceType, "legacySourceArrivedFirst", eventNowMs);
        break;
      case "legacyCounterpartArrivedFirst":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCounterpartArrivedFirst", eventNowMs);
        break;
      case "legacyCorrelationExpired":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCorrelationExpired", eventNowMs);
        break;
      case "legacyLateCounterpartExpired":
        stats.recordFoundationForHeadType(event.sourceType, "legacyLateCounterpartExpired", eventNowMs);
        break;
      case "legacyCorrectionMismatch":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCorrectionMismatch", eventNowMs);
        break;
      case "legacyCancellationMismatch":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCancellationMismatch", eventNowMs);
        break;
      case "sourceCapacityExceeded":
        log.warn(`[legacy-counterpart] source capacity exceeded: ${event.sourceIdentity}`);
        break;
      case "counterpartEvicted":
        log.warn(`[legacy-counterpart] counterpart evicted: ${event.counterpartIdentity}`);
        break;
      case "counterpartCapacityBypassed":
        log.warn(`[legacy-counterpart] counterpart capacity bypassed: ${event.counterpartIdentity}`);
        break;
    }
  }

  const legacyCounterpartCorrelatorContext = {
    actionSink: handleLegacyCounterpartAction,
    lifecycleEventSink: handleLegacyCounterpartLifecycleEvent,
  };
  const legacyCounterpartCorrelator = options?.legacyCounterpartCorrelatorFactory == null
    ? new LegacyCounterpartCorrelator({
      onAction: legacyCounterpartCorrelatorContext.actionSink,
      onLifecycleEvent: legacyCounterpartCorrelatorContext.lifecycleEventSink,
    })
    : options.legacyCounterpartCorrelatorFactory(legacyCounterpartCorrelatorContext);

  // 火山ルートハンドラ
  const volcanoHandler = new VolcanoRouteHandler({
    volcanoState,
    notifier,
    runDisplayPipeline,
    display,
    revisionGate,
    onRevisionDecision: recordRevisionDecision,
    onVolcanoRevisionDecision: options?.onVolcanoRevisionDecision,
    onFoundationNotified: (isCorrection) => {
      const nowMs = statsNowMs(Date.now());
      stats.recordFoundation("notified", nowMs);
      if (isCorrection) stats.recordFoundation("correctionNotified", nowMs);
    },
    onFoundationPresented: () => stats.recordFoundation("presented", statsNowMs(Date.now())),
  });

  const handler = (incoming: WsDataMessage): void => {
    const normalized = normalizeTelegramMessage(incoming);
    const msg = normalized.message;
    if (normalized.diagnostics.testMetadataMismatch) {
      stats.recordTestMetadataMismatch(statsNowMs(msg.meta?.receivedAtMs ?? Date.now()));
    }

    const route = classifyMessage(msg.classification, msg.head.type);
    let rawFallbackLogged = false;
    const logUnknownRawFallbackOnce = (): void => {
      if (rawFallbackLogged) return;
      logUnknownRawFallback(msg);
      rawFallbackLogged = true;
    };
    // policy 未定義の route は後段で raw fallback になる。早期 return でも同じ受信記録を残す。
    const fallsBackToRaw = route === "raw"
      || route !== "ignore" && !routeHasExplicitRevisionFamilyPolicy(route, msg.head.type);

    // XML電文でない場合はヘッダ情報のみ表示
    if (msg.format !== "xml" || !msg.head.xml) {
      if (fallsBackToRaw) logUnknownRawFallbackOnce();
      display?.displayRawHeader(msg);
      return;
    }

    // 分類済みの全電文を汎用 tap に通知 (ignore / raw / suppressed / 火山も含む)。
    // tap の例外は本体処理へ波及させない (Error 以外の throw 値でもログ側で二次例外を起こさない)。
    if (routeTaps) {
      for (const tap of routeTaps) {
        try {
          const result = tap({ route, message: msg }) as unknown;
          // 契約上 tap は同期だが、誤って async 関数が渡されたときも
          // reject を未処理のまま漏らさない
          if (result instanceof Promise) {
            result.catch((e: unknown) => {
              log.warn(`[route-tap] async tap の reject: ${describeTapError(e)}`);
            });
          }
        } catch (e) {
          log.warn(`[route-tap] tap 実行で例外: ${describeTapError(e)}`);
        }
      }
    }

    // Phase 3B 完了後は ignore 以外の全 XML route が明示 policy を持つ。
    // parser 失敗も raw family へ落ちるため、transport dedup と日時診断は parse 前に共通適用する。
    const usesFoundationGate = route !== "ignore";
    if (usesFoundationGate) {
      const meta = requireTelegramMeta(msg);
      const admissionNowMs = statsNowMs(meta.receivedAtMs);
      stats.recordFoundation("received", admissionNowMs);
      if (!transportDedup.accept(meta.messageId, meta.receivedAtMs)) {
        stats.recordFoundation("transportDuplicate", admissionNowMs);
        return;
      }
      // Envelope 自体を取得できない malformed XML は既存の raw fallback へ残す。
      // ReportDateTime を読めた電文だけを日時診断へ分離する。
      const dateReason = msg.xmlReport == null ? null : telegramDateDiagnosticReason(meta);
      if (dateReason != null) {
        if (fallsBackToRaw) logUnknownRawFallbackOnce();
        const diagnostic = telegramDateDiagnostic(msg, meta, dateReason);
        stats.recordFoundation(
          dateReason === "futureSkewExceeded"
            ? "futureDateDiagnosed"
            : "invalidDateDiagnosed",
          admissionNowMs,
        );
        log.warn(
          `[telegram-date] ${diagnostic.type} EventID=${diagnostic.eventId ?? "(none)"} ReportDateTime=${diagnostic.reportDateTimeRaw ?? "(missing)"} receivedAt=${diagnostic.receivedAtIso} futureSkewMs=${diagnostic.futureSkewMs ?? "(n/a)"} reason=${diagnostic.kind}`,
        );
        display?.displayTelegramDiagnostic?.(diagnostic);
        try {
          displaySink?.ingest(dateDiagnosticPresentationEvent(msg, diagnostic));
          displaySink?.publishStats?.(
            buildDisplayStats(summaryTracker, stats, dailyQuakeCounter, admissionNowMs),
          );
        } catch {
          // 診断表示の配送障害を受信本体へ波及させない。
        }
        return;
      }
    }

    let processingRoute = route;
    if (route !== "ignore" && !routeHasExplicitRevisionFamilyPolicy(route, msg.head.type)) {
      log.warn(
        `[telegram-foundation] explicit revision policy missing: route=${route} type=${msg.head.type}; raw fallback`,
      );
      processingRoute = "raw";
    }

    if (processingRoute === "raw") {
      logUnknownRawFallbackOnce();
    }

    // 特殊ルート ignore: 配信終了予定 + 既存表示と重複する電文は受信しても無視
    // (表示・通知・統計をすべてスキップ)。catalog では分類のみ担い、処理はここで早期 return。
    if (route === "ignore") {
      return;
    }

    // 特殊ルート volcano: VFVO53 バッチ集約を伴う独立ライフサイクルのため線形 processor 表に
    // 載せず、VolcanoRouteHandler に委譲する (catalog は分類のみ担う)。
    let outcome: ProcessOutcome | null;
    const messageStatsNowMs = msg.meta?.receivedAtMs ?? Date.now();
    if (processingRoute === "volcano") {
      const result = withMessageStatsTime(messageStatsNowMs, () => volcanoHandler.handle(msg));
      if (result.kind === "accepted") {
        stats.record({
          headType: msg.head.type,
          category: routeToCategory(processingRoute),
          eventId: msg.xmlReport?.head.eventId ?? null,
        }, statsNowMs(msg.meta?.receivedAtMs ?? Date.now()));
        return;
      }
      if (result.kind === "suppressed") return;
      outcome = withMessageStatsTime(messageStatsNowMs, () => processMsg(msg, "raw", processDeps));
    } else {
      // 火山以外: processMessage → recordStats → dispatchNotify → runDisplayPipeline
      outcome = withMessageStatsTime(
        messageStatsNowMs,
        () => processMsg(msg, processingRoute, processDeps),
      );
    }

    if (outcome == null) {
      return;
    }

    if (outcome.domain === "raw" && !rawFallbackLogged) {
      logUnknownRawFallbackOnce();
    }

    if (outcome.domain === "eew" && outcome.displayLifecycleOnly === true) {
      try {
        displaySink?.ingest(toPresentationEvent(outcome));
      } catch {
        // display lifecycle command の配送障害を受信本体へ波及させない。
      }
      return;
    }

    const outcomeAdmissionNowMs = statsNowMs(outcome.msg.meta?.receivedAtMs ?? Date.now());
    recordStats(outcome, stats, outcomeAdmissionNowMs);
    const action = legacyCounterpartCorrelator.accept(outcome);
    if (action != null) handleLegacyCounterpartAction(action);
  };

  return {
    handler,
    eewLogger,
    eewTracker,
    notifier,
    tsunamiState,
    volcanoState,
    vpws50State,
    vpww56State,
    floodForecastState,
    vpwp50Cache,
    stats,
    summaryTracker,
    dailyQuakeCounter,
    buildDisplayStats: (now?: number) => buildDisplayStats(
      summaryTracker,
      stats,
      dailyQuakeCounter,
      statsNowMs(now ?? Date.now()),
    ),
    flushAndDisposeVolcanoBuffer: () => volcanoHandler.flushAndDispose(),
    disposeLegacyCounterpartCorrelator: () => legacyCounterpartCorrelator.dispose(),
  };
}
