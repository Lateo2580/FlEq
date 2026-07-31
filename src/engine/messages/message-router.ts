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

// ── 電文分類 (Route) ──
//
// Route 型・分類関数 (classifyMessage)・head.type 集合・優先順位はすべて
// `route-catalog.ts` に集約した。ここでは既存 import 互換のため Route を再 export する。

export type { Route } from "./route-catalog";

// ── dispatch helpers ──

/** 通知のみ実行 (filter 非適用) */
function dispatchNotify(outcome: ProcessOutcome, notifier: Notifier): boolean {
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
      notifier.notifyNankaiTrough(outcome.parsed);
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
      // suppressNotify=true (VXKO 通常発表で station 内容変化なし) は通知を抑制
      if (outcome.presentation.suppressNotify) return false;
      notifier.notifyFloodForecast(
        outcome.parsed,
        outcome.presentation.soundLevel,
      );
      return true;
    }
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
function recordStats(outcome: ProcessOutcome, stats: TelegramStats): void {
  if (outcome.stats.shouldRecord) {
    stats.record({
      headType: outcome.headType,
      category: outcome.statsCategory,
      eventId: outcome.stats.eventId,
    });
  }
  if (outcome.stats.maxIntUpdate) {
    const u = outcome.stats.maxIntUpdate;
    stats.updateMaxInt(u.eventId, u.maxInt, u.headType);
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
  /** durable revision watermark の復元用。 */
  revisionGate?: TelegramRevisionGate;
  /** 最初の durable domain が v1 表示復元状態を脱したことを monitor へ伝える。 */
  onVpws50RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** VPWW56 stream/gate の commit 完了を persistence owner へ伝える。 */
  onVpww56RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** tsunami gate/item state の commit 完了を persistence owner へ伝える。 */
  onTsunamiRevisionDecision?: (decision: TelegramRevisionDecision) => void;
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
  vpwp50Cache: Vpwp50DetailCache;
  stats: TelegramStats;
  summaryTracker: SummaryWindowTracker;
  dailyQuakeCounter: DailyQuakeCounter;
  /** 起動直後と display on 時に明示 publish する stats snapshot。 */
  buildDisplayStats: (now?: number) => DisplayStatsV1;
  flushAndDisposeVolcanoBuffer: () => void;
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
  const volcanoState = new VolcanoStateHolder();
  const vpws50State = options?.vpws50State ?? new Vpws50StateHolder();
  const vpww56State = options?.vpww56State ?? new Vpww56StateHolder();
  const vpwp50Cache = new Vpwp50DetailCache();
  const typhoonProbabilityState = new TyphoonProbabilityStateHolder();
  const floodForecastState = new FloodForecastStateHolder();
  const stats = new TelegramStats();
  const summaryTracker = new SummaryWindowTracker();
  const dailyQuakeCounter = options?.dailyQuakeCounter ?? new DailyQuakeCounter();
  const diffStore = new PresentationDiffStore();
  const transportDedup = new TelegramTransportDeduplicator();
  const revisionGate = options?.revisionGate ?? new TelegramRevisionGate();
  const eewTracker = new EewTracker({
    onCleanup: (eventId) => {
      eewLogger.closeEvent(eventId, "タイムアウト");
    },
    onRevisionDecision: (decision) => {
      switch (decision.kind) {
        case "replaceCorrection":
          stats.recordFoundation("correctionReplaced");
          break;
        case "markCancelled":
          stats.recordFoundation("cancelApplied");
          break;
        case "duplicate":
        case "semanticDuplicate":
          stats.recordFoundation("semanticDuplicate");
          break;
        case "stale":
          stats.recordFoundation("stale");
          break;
        case "invalidMeta":
          stats.recordFoundation("invalidMeta");
          break;
        case "invalidRevision":
          stats.recordFoundation("invalidRevision");
          break;
        case "cancelTargetMismatch":
          stats.recordFoundation("cancelTargetMismatch");
          break;
        default:
          break;
      }
    },
  });

  const recordRevisionDecision = (decision: TelegramRevisionDecision): void => {
    switch (decision.kind) {
      case "replaceCorrection": stats.recordFoundation("correctionReplaced"); break;
      case "markCancelled":
      case "restorePrevious":
      case "clearCurrent": stats.recordFoundation("cancelApplied"); break;
      case "duplicate":
      case "semanticDuplicate": stats.recordFoundation("semanticDuplicate"); break;
      case "stale": stats.recordFoundation("stale"); break;
      case "invalidMeta": stats.recordFoundation("invalidMeta"); break;
      case "invalidRevision": stats.recordFoundation("invalidRevision"); break;
      case "cancelTargetMismatch": stats.recordFoundation("cancelTargetMismatch"); break;
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
    vpwp50Cache,
    typhoonProbabilityState,
    floodForecastState,
    revisionGate,
    onRevisionDecision: recordRevisionDecision,
    onVpws50RevisionDecision: options?.onVpws50RevisionDecision,
    onVpww56RevisionDecision: options?.onVpww56RevisionDecision,
    onTsunamiRevisionDecision: options?.onTsunamiRevisionDecision,
  };

  /**
   * 共通の表示パイプライン処理。
   * filter/diffStore/summaryTracker/focus/template/compact の6ステップを一元的に実行する。
   * @returns true なら表示済み。false ならフィルタで非表示。
   */
  function runDisplayPipeline(
    outcome: ProcessOutcome | VolcanoBatchOutcome,
    displayFn: () => void,
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
      displaySink?.publishStats?.(buildDisplayStats(summaryTracker, stats, dailyQuakeCounter));
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

  // 火山ルートハンドラ
  const volcanoHandler = new VolcanoRouteHandler({
    volcanoState,
    notifier,
    runDisplayPipeline,
    display,
  });

  const handler = (incoming: WsDataMessage): void => {
    const normalized = normalizeTelegramMessage(incoming);
    const msg = normalized.message;
    if (normalized.diagnostics.testMetadataMismatch) {
      stats.recordTestMetadataMismatch();
    }

    // XML電文でない場合はヘッダ情報のみ表示
    if (msg.format !== "xml" || !msg.head.xml) {
      display?.displayRawHeader(msg);
      return;
    }

    const route = classifyMessage(msg.classification, msg.head.type);

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

    const usesFoundationGate = route === "eew" || route === "tsunami"
      || route === "weather" && (msg.head.type === "VPWS50" || msg.head.type === "VPWW56");
    if (usesFoundationGate) {
      const meta = requireTelegramMeta(msg);
      stats.recordFoundation("received", meta.receivedAtMs);
      if (!transportDedup.accept(meta.messageId, meta.receivedAtMs)) {
        stats.recordFoundation("transportDuplicate", meta.receivedAtMs);
        return;
      }
      const dateReason = telegramDateDiagnosticReason(meta);
      if (dateReason != null) {
        const diagnostic = telegramDateDiagnostic(msg, meta, dateReason);
        stats.recordFoundation(
          dateReason === "futureSkewExceeded"
            ? "futureDateDiagnosed"
            : "invalidDateDiagnosed",
          meta.receivedAtMs,
        );
        log.warn(
          `[telegram-date] ${diagnostic.type} EventID=${diagnostic.eventId ?? "(none)"} ReportDateTime=${diagnostic.reportDateTimeRaw ?? "(missing)"} receivedAt=${diagnostic.receivedAtIso} futureSkewMs=${diagnostic.futureSkewMs ?? "(n/a)"} reason=${diagnostic.kind}`,
        );
        display?.displayTelegramDiagnostic?.(diagnostic);
        try {
          displaySink?.ingest(dateDiagnosticPresentationEvent(msg, diagnostic));
          displaySink?.publishStats?.(
            buildDisplayStats(summaryTracker, stats, dailyQuakeCounter),
          );
        } catch {
          // 診断表示の配送障害を受信本体へ波及させない。
        }
        return;
      }
    }

    // 特殊ルート ignore: 配信終了予定 + 既存表示と重複する電文は受信しても無視
    // (表示・通知・統計をすべてスキップ)。catalog では分類のみ担い、処理はここで早期 return。
    if (route === "ignore") {
      return;
    }

    // 特殊ルート volcano: VFVO53 バッチ集約を伴う独立ライフサイクルのため線形 processor 表に
    // 載せず、VolcanoRouteHandler に委譲する (catalog は分類のみ担う)。
    if (route === "volcano") {
      volcanoHandler.handle(msg);
      stats.record({
        headType: msg.head.type,
        category: routeToCategory(route),
        eventId: msg.xmlReport?.head.eventId ?? null,
      });
      return;
    }

    // 火山以外: processMessage → recordStats → dispatchNotify → runDisplayPipeline
    const outcome = processMsg(msg, route, processDeps);
    if (outcome == null) {
      return;
    }

    recordStats(outcome, stats);
    const notified = dispatchNotify(outcome, notifier);
    const acceptedCorrection = outcome.domain === "eew"
      ? outcome.eewResult.isCorrection === true
      : outcome.presentation.acceptedCorrection === true;
    if (acceptedCorrection) {
      stats.recordFoundation("correctionNotified");
    }
    const foundationTracked = outcome.domain === "eew"
      || outcome.domain === "tsunami"
      || outcome.domain === "weather" && (outcome.headType === "VPWS50" || outcome.headType === "VPWW56");
    if (foundationTracked && notified) {
      stats.recordFoundation("notified");
    }
    const presented = runDisplayPipeline(
      outcome,
      () => display?.displayOutcome(outcome),
    );
    if (foundationTracked && presented) {
      stats.recordFoundation("presented");
    }
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
    vpwp50Cache,
    stats,
    summaryTracker,
    dailyQuakeCounter,
    buildDisplayStats: (now?: number) => buildDisplayStats(summaryTracker, stats, dailyQuakeCounter, now),
    flushAndDisposeVolcanoBuffer: () => volcanoHandler.flushAndDispose(),
  };
}
