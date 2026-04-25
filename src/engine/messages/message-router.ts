import chalk from "chalk";
import type { WsDataMessage } from "../../types";
import { EewTracker } from "../eew/eew-tracker";
import { EewEventLogger } from "../eew/eew-logger";
import { Notifier } from "../notification/notifier";
import { TsunamiStateHolder } from "./tsunami-state";
import { VolcanoStateHolder } from "./volcano-state";
import { TelegramStats, routeToCategory } from "./telegram-stats";
import { SummaryWindowTracker } from "./summary-tracker";
import { processMessage as processMsg, ProcessDeps } from "../presentation/processors/process-message";
import { toPresentationEvent } from "../presentation/events/to-presentation-event";
import { shouldDisplay, renderTemplate } from "../filter-template/pipeline";
import type { FilterTemplatePipeline } from "../filter-template/pipeline";
import { PresentationDiffStore } from "../presentation/diff-store";
import type { ProcessOutcome, VolcanoBatchOutcome, PresentationEvent } from "../presentation/types";
import { VolcanoRouteHandler } from "./volcano-route-handler";
import type { DisplayCallbacks } from "./display-callbacks";

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
  | "raw";

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
 *   8. その他 → raw
 */
function classifyMessage(classification: string, headType: string): Route {
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

// ── ファクトリ ──

/** createMessageHandler のオプション */
export interface MessageHandlerOptions {
  pipeline?: FilterTemplatePipeline;
  display?: DisplayCallbacks;
}

/** createMessageHandler の戻り値 */
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  stats: TelegramStats;
  summaryTracker: SummaryWindowTracker;
  flushAndDisposeVolcanoBuffer: () => void;
}

/** 受信データのハンドリング */
export function createMessageHandler(options?: MessageHandlerOptions): MessageHandlerResult {
  const pipeline: FilterTemplatePipeline = options?.pipeline ?? { filter: null, template: null, focus: null };
  const display = options?.display;
  const eewLogger = new EewEventLogger();
  const notifier = new Notifier();
  const tsunamiState = new TsunamiStateHolder();
  const volcanoState = new VolcanoStateHolder();
  const stats = new TelegramStats();
  const summaryTracker = new SummaryWindowTracker();
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
    summaryTracker.record(event, displayed);

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
    stats,
    summaryTracker,
    flushAndDisposeVolcanoBuffer: () => volcanoHandler.flushAndDispose(),
  };
}
