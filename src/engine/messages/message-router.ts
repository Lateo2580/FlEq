import chalk from "chalk";
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

/** 電文の処理ルート */
type Route =
  | "eew"
  | "seismicText"
  | "lgObservation"
  | "earthquake"
  | "tsunami"
  | "nankaiTrough"
  | "volcano"
  | "weather"
  | "tornado"
  | "briefing"
  | "earlyWeather"
  | "weatherWarningTimeseries"
  | "climateInfo"
  | "weatherExplanation"
  | "heatAlert"
  | "typhoonAnalysis"
  | "typhoonProbability"
  | "floodForecast"
  | "ignore"
  | "raw";

/** weather ルート対象の head.type */
const WEATHER_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPWW55", "VPWW56", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61",
  "VPWS50",
]);

/** tornado ルート対象の head.type */
const TORNADO_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPHW50", "VPHW51",
]);

/** briefing (気象防災速報) ルート対象の head.type */
const BRIEFING_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPBS50",
]);

/** earlyWeather (早期天候情報) ルート対象の head.type */
const EARLY_WEATHER_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPAW51",
]);

/** weatherWarningTimeseries (気象警報・注意報時系列情報) ルート対象の head.type */
const WEATHER_WARNING_TIMESERIES_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPWP50",
]);

/** climateInfo (全般/地方天候情報) ルート対象の head.type */
const CLIMATE_INFO_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPZI50",
  "VPCI50", // 地方天候情報 (構造は VPZI50 互換 + EventDatePart)
]);

/** weatherExplanation (気象解説情報) ルート対象の head.type */
const WEATHER_EXPLANATION_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPCJ51", // 地方気象解説情報
  "VPZJ51", // 全般気象解説情報
  "VPFJ51", // 府県気象解説情報
  "VMCJ53", // 全般気象解説情報（潮位）— 大潮・副振動等
  "VMCJ54", // 地方気象解説情報（潮位）
  "VMCJ55", // 府県気象解説情報（潮位）
]);

/** heatAlert (熱中症警戒アラート) ルート対象の head.type */
const HEAT_ALERT_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPFT50",
]);

/** typhoonAnalysis (台風解析・予報情報) ルート対象の head.type */
const TYPHOON_ANALYSIS_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPTW60", "VPTW61", "VPTW62",
]);

/** typhoonProbability (台風の暴風域に入る確率) ルート対象の head.type */
const TYPHOON_PROBABILITY_HEAD_TYPES: ReadonlySet<string> = new Set(["VPTA50"]);

/**
 * 指定河川洪水予報・水位周知河川 (VXKO50-89 / VXSU50-59) ルート対象の head.type。
 * VXKO は 50 から 89、VXSU は 50 から 59 まで枠取りされている (現行配信は 50 のみだが
 * 将来の派生 type も同 routing に乗せる)。
 */
const FLOOD_FORECAST_HEAD_TYPES: ReadonlySet<string> = new Set([
  ...Array.from({ length: 40 }, (_, i) => `VXKO${50 + i}`),
  ...Array.from({ length: 10 }, (_, i) => `VXSU${50 + i}`),
]);

/** 配信終了予定 + 既存表示と内容重複のため、受信しても無視する head.type */
const IGNORED_HEAD_TYPES: ReadonlySet<string> = new Set([
  "VPWW53", "VPWW54",            // 旧 気象警報・注意報 (VPWW55-61/VPWS50 と重複)
  "VPNO50",                      // 気象特別警報報知
  "VPOA50",                      // 記録的短時間大雨情報
  "VPZJ50", "VPCJ50", "VPFJ50",  // 旧 気象情報 (VPZJ51/VPCJ51/VPFJ51 と重複)
  "VMCJ50", "VMCJ51", "VMCJ52",  // 潮位情報
  "VXWW50",                      // 土砂災害警戒情報
]);

/**
 * classification と head.type から処理ルートを判定する。
 * ルーティング優先順位:
 *   1. eew.forecast / eew.warning → EEW
 *   2. telegram.earthquake + VXSE56/VXSE60/VZSE40 → テキスト系
 *   3. telegram.earthquake + VXSE62 → 長周期地震動観測
 *   4. telegram.earthquake + VXSE* → 地震情報
 *   5. telegram.earthquake + VTSE* → 津波情報
 *   6. telegram.earthquake + VYSE* → 南海トラフ
 *   7. telegram.volcano → 火山情報
 *   8. telegram.weather + VPWW55-61/VPWS50 → 気象警報・注意報
 *   9. telegram.weather + VPHW50/VPHW51 → 竜巻注意情報
 *   10. telegram.weather + VPBS50 → 気象防災速報
 *   11. telegram.weather + VPAW51 → 早期天候情報
 *   12. telegram.weather + VPWP50 → 気象警報・注意報時系列情報
 *   13. telegram.weather + VPZI50/VPCI50 → 天候情報 (全般/地方)
 *   14. telegram.weather + VPCJ51/VPZJ51/VPFJ51/VMCJ53-55 → 気象解説情報 (地方/全般/府県 + 潮位版)
 *   15. telegram.weather + VPFT50 → 熱中症警戒アラート
 *   16. telegram.weather + VPTW60/VPTW61/VPTW62 → 台風解析・予報情報
 *   17. telegram.weather + VPTA50 → 台風の暴風域に入る確率
 *   18. telegram.weather + VXKO50-89/VXSU50-59 → 指定河川洪水予報・水位周知河川
 *   19. その他 → raw
 */
function classifyMessage(classification: string, headType: string): Route {
  if (IGNORED_HEAD_TYPES.has(headType)) {
    return "ignore";
  }

  if (classification === "eew.forecast" || classification === "eew.warning") {
    return "eew";
  }

  if (classification === "telegram.volcano") {
    return "volcano";
  }

  if (classification === "telegram.earthquake") {
    if (headType === "VXSE56" || headType === "VXSE60" || headType === "VZSE40") {
      return "seismicText";
    }
    if (headType === "VXSE62") {
      return "lgObservation";
    }
    if (headType.startsWith("VXSE")) {
      return "earthquake";
    }
    if (headType.startsWith("VTSE")) {
      return "tsunami";
    }
    if (headType.startsWith("VYSE")) {
      return "nankaiTrough";
    }
  }

  if (classification === "telegram.weather" && WEATHER_HEAD_TYPES.has(headType)) {
    return "weather";
  }

  if (classification === "telegram.weather" && TORNADO_HEAD_TYPES.has(headType)) {
    return "tornado";
  }

  if (classification === "telegram.weather" && BRIEFING_HEAD_TYPES.has(headType)) {
    return "briefing";
  }

  if (classification === "telegram.weather" && EARLY_WEATHER_HEAD_TYPES.has(headType)) {
    return "earlyWeather";
  }

  if (
    classification === "telegram.weather" &&
    WEATHER_WARNING_TIMESERIES_HEAD_TYPES.has(headType)
  ) {
    return "weatherWarningTimeseries";
  }

  if (
    classification === "telegram.weather" &&
    CLIMATE_INFO_HEAD_TYPES.has(headType)
  ) {
    return "climateInfo";
  }

  if (
    classification === "telegram.weather" &&
    WEATHER_EXPLANATION_HEAD_TYPES.has(headType)
  ) {
    return "weatherExplanation";
  }

  if (
    classification === "telegram.weather" &&
    HEAT_ALERT_HEAD_TYPES.has(headType)
  ) {
    return "heatAlert";
  }

  if (
    classification === "telegram.weather" &&
    TYPHOON_ANALYSIS_HEAD_TYPES.has(headType)
  ) {
    return "typhoonAnalysis";
  }

  if (
    classification === "telegram.weather" &&
    TYPHOON_PROBABILITY_HEAD_TYPES.has(headType)
  ) {
    return "typhoonProbability";
  }

  if (
    classification === "telegram.weather" &&
    FLOOD_FORECAST_HEAD_TYPES.has(headType)
  ) {
    return "floodForecast";
  }

  return "raw";
}

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
    // raw: 通知なし
    // volcano: VolcanoRouteHandler が通知を担当
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

/** createMessageHandler のオプション */
export interface MessageHandlerOptions {
  pipeline?: FilterTemplatePipeline;
  display?: DisplayCallbacks;
  displaySink?: DisplayIngestSink;
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

    // 配信終了予定 + 既存表示と重複する電文は受信しても無視
    // (表示・通知・統計をすべてスキップ)
    if (route === "ignore") {
      return;
    }

    // 火山は VolcanoRouteHandler に委譲
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
