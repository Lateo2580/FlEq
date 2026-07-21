import chalk from "chalk";
import * as log from "../../logger";
import type { WsDataMessage } from "../../types";
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
import { shouldDisplay, renderTemplate } from "../filter-template/pipeline";
import type { FilterTemplatePipeline } from "../filter-template/pipeline";
import { PresentationDiffStore } from "../presentation/diff-store";
import type { ProcessOutcome, VolcanoBatchOutcome, PresentationEvent } from "../presentation/types";
import { VolcanoRouteHandler } from "./volcano-route-handler";
import type { DisplayCallbacks } from "./display-callbacks";
import type { DisplayIngestSink } from "../display/types";

// ── 電文分類 (Route) ──
//
// Route 型・分類関数 (classifyMessage)・head.type 集合・優先順位はすべて
// `route-catalog.ts` に集約した。ここでは既存 import 互換のため Route を再 export する。

export type { Route } from "./route-catalog";

// ── dispatch helpers ──

/** 通知のみ実行 (filter 非適用) */
function dispatchNotify(outcome: ProcessOutcome, notifier: Notifier): void {
  switch (outcome.domain) {
    case "eew":
      notifier.notifyEew(outcome.parsed, outcome.eewResult);
      break;
    case "earthquake":
      notifier.notifyEarthquake(outcome.parsed);
      break;
    case "seismicText":
      notifier.notifySeismicText(outcome.parsed);
      break;
    case "lgObservation":
      notifier.notifyLgObservation(outcome.parsed);
      break;
    case "tsunami":
      notifier.notifyTsunami(outcome.parsed);
      break;
    case "nankaiTrough":
      notifier.notifyNankaiTrough(outcome.parsed);
      break;
    case "weather": {
      const diff = outcome.presentation.weatherDiff;
      // 変化なし (再掲対象でなければ) は通知を抑制 (spec §4.3)
      if (diff?.isUnchanged && !diff.shouldRecap) {
        break;
      }
      // Codex 最終レビュー F-3: processWeather の unsafe 昇格 (soundLevel="warning") を
      // notifier 内の weatherSoundLevel 再計算で潰さないよう presentation.soundLevel を渡す
      notifier.notifyWeatherWarning(outcome.parsed, outcome.presentation.soundLevel);
      break;
    }
    case "tornado":
      // weather F-3 の横展開: notifier 内再計算との drift を防ぐ
      notifier.notifyTornadoAdvisory(outcome.parsed, outcome.presentation.soundLevel);
      break;
    case "briefing":
      // weather F-3 の横展開: notifier 内再計算との drift を防ぐ
      notifier.notifyWeatherBriefing(outcome.parsed, outcome.presentation.soundLevel);
      break;
    case "earlyWeather":
      notifier.notifyEarlyWeather(outcome.parsed);
      break;
    case "weatherWarningTimeseries":
      notifier.notifyWeatherWarningTimeseries(outcome.parsed);
      break;
    case "climateInfo":
      notifier.notifyClimateInfo(outcome.parsed);
      break;
    case "weatherExplanation":
      notifier.notifyWeatherExplanation(outcome.parsed);
      break;
    case "heatAlert":
      // 再計算 drift 予防: presentation.soundLevel を第 2 引数で渡す (weather F-3 の横展開)
      notifier.notifyHeatAlert(outcome.parsed, outcome.presentation.soundLevel);
      break;
    case "typhoonAnalysis":
      notifier.notifyTyphoonAnalysis(outcome.parsed, outcome.presentation.soundLevel);
      break;
    case "typhoonProbability": {
      if (outcome.presentation.suppressNotify) break;
      notifier.notifyTyphoonProbability(
        outcome.parsed,
        outcome.presentation.soundLevel,
      );
      break;
    }
    case "floodForecast": {
      // suppressNotify=true (VXKO 通常発表で station 内容変化なし) は通知を抑制
      if (outcome.presentation.suppressNotify) break;
      notifier.notifyFloodForecast(
        outcome.parsed,
        outcome.presentation.soundLevel,
      );
      break;
    }
    case "raw":
      // raw: 通知なし (フォールバック表示のみ)
      break;
    case "volcano":
      // 特殊ルート: 火山は VolcanoRouteHandler が通知を担当するため dispatchNotify には到達しない。
      // 網羅性のため明示的に no-op で受ける。
      break;
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

/** createMessageHandler のオプション */
export interface MessageHandlerOptions {
  pipeline?: FilterTemplatePipeline;
  display?: DisplayCallbacks;
  displaySink?: DisplayIngestSink;
  /** 分類済みの全電文を観測する汎用 tap (同期・軽量前提)。@see RoutedMessageTap */
  routeTaps?: readonly RoutedMessageTap[];
}

/** createMessageHandler の戻り値 */
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  vpws50State: Vpws50StateHolder;
  vpww56State: Vpww56StateHolder;
  vpwp50Cache: Vpwp50DetailCache;
  stats: TelegramStats;
  summaryTracker: SummaryWindowTracker;
  dailyQuakeCounter: DailyQuakeCounter;
  flushAndDisposeVolcanoBuffer: () => void;
}

/** 受信データのハンドリング */
export function createMessageHandler(options?: MessageHandlerOptions): MessageHandlerResult {
  const pipeline: FilterTemplatePipeline = options?.pipeline ?? { filter: null, template: null, focus: null };
  const display = options?.display;
  const displaySink = options?.displaySink;
  const routeTaps = options?.routeTaps;
  const eewLogger = new EewEventLogger();
  const notifier = new Notifier();
  const tsunamiState = new TsunamiStateHolder();
  const volcanoState = new VolcanoStateHolder();
  const vpws50State = new Vpws50StateHolder();
  const vpww56State = new Vpww56StateHolder();
  const vpwp50Cache = new Vpwp50DetailCache();
  const typhoonProbabilityState = new TyphoonProbabilityStateHolder();
  const floodForecastState = new FloodForecastStateHolder();
  const stats = new TelegramStats();
  const summaryTracker = new SummaryWindowTracker();
  const dailyQuakeCounter = new DailyQuakeCounter();
  const diffStore = new PresentationDiffStore();
  const eewTracker = new EewTracker({
    onCleanup: (eventId) => {
      eewLogger.closeEvent(eventId, "タイムアウト");
    },
  });

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
    const rawEvent: PresentationEvent = toPresentationEvent(outcome);
    const event = diffStore.apply(rawEvent);

    const displayed = shouldDisplay(event, pipeline);
    summaryTracker.record(event, displayed);   // ← ingest より先 (1 イベント遅れ防止)
    dailyQuakeCounter.record(event);
    try {
      displaySink?.ingest(event);
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

  const handler = (msg: WsDataMessage): void => {
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
    dispatchNotify(outcome, notifier);
    runDisplayPipeline(outcome, () => display?.displayOutcome(outcome));
  };

  return {
    handler,
    eewLogger,
    notifier,
    tsunamiState,
    volcanoState,
    vpws50State,
    vpww56State,
    vpwp50Cache,
    stats,
    summaryTracker,
    dailyQuakeCounter,
    flushAndDisposeVolcanoBuffer: () => volcanoHandler.flushAndDispose(),
  };
}
