import chalk from "chalk";
import type { WsDataMessage, ParsedVolcanoInfo } from "../../types";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { displayRawHeader, getDisplayMode } from "../../ui/formatter";
import { renderSummaryLine } from "../../ui/summary";
import { displayEewInfo } from "../../ui/eew-formatter";
import {
  displayEarthquakeInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayNankaiTroughInfo,
  displayLgObservationInfo,
} from "../../ui/earthquake-formatter";
import { displayVolcanoInfo, displayVolcanoAshfallBatch } from "../../ui/volcano-formatter";
import { VolcanoVfvo53Aggregator, type FlushOptions, type Vfvo53BatchItems } from "./volcano-vfvo53-aggregator";
import { EewTracker } from "../eew/eew-tracker";
import { EewEventLogger } from "../eew/eew-logger";
import { Notifier } from "../notification/notifier";
import { TsunamiStateHolder } from "./tsunami-state";
import { VolcanoStateHolder } from "./volcano-state";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation } from "../notification/volcano-presentation";
import { TelegramStats, routeToCategory } from "./telegram-stats";
import { SummaryWindowTracker } from "./summary-tracker";
import { processMessage as processMsg, ProcessDeps } from "../presentation/processors/process-message";
import { buildVolcanoOutcome } from "../presentation/processors/process-volcano";
import { toPresentationEvent } from "../presentation/events/to-presentation-event";
import { shouldDisplay, renderTemplate } from "../filter-template/pipeline";
import type { FilterTemplatePipeline } from "../filter-template/pipeline";
import { PresentationDiffStore } from "../presentation/diff-store";
import type { ProcessOutcome, VolcanoBatchOutcome, PresentationEvent } from "../presentation/types";

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

// ── dispatch / stats helpers ──

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
    // raw, volcano: 通知なし
  }
}

/** 表示のみ実行 (filter 適用後) */
function dispatchDisplayOnly(outcome: ProcessOutcome): void {
  switch (outcome.domain) {
    case "eew":
      displayEewInfo(outcome.parsed, {
        activeCount: outcome.eewResult.activeCount,
        diff: outcome.eewResult.diff,
        colorIndex: outcome.eewResult.colorIndex,
      });
      break;
    case "earthquake":
      displayEarthquakeInfo(outcome.parsed);
      break;
    case "seismicText":
      displaySeismicTextInfo(outcome.parsed);
      break;
    case "lgObservation":
      displayLgObservationInfo(outcome.parsed);
      break;
    case "tsunami":
      displayTsunamiInfo(outcome.parsed);
      break;
    case "nankaiTrough":
      displayNankaiTroughInfo(outcome.parsed);
      break;
    case "raw":
      displayRawHeader(outcome.msg);
      break;
    // volcano: NOT handled here — volcano goes through aggregator
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

  // 火山電文の WsDataMessage キャッシュ (volcanoCode → msg)
  // aggregator の emitSingle/emitBatch コールバックでは WsDataMessage が渡されないため、
  // handler で受信時にキャッシュし、emit 時に復元して PresentationEvent パイプラインに通す。
  const volcanoMsgCache = new Map<string, WsDataMessage>();

  /**
   * 火山単発電文の PresentationEvent パイプライン処理。
   * filter/template/focus/diff/summary に通して表示を制御する。
   * 通知は filter 非適用なので先に実行する。
   */
  function emitVolcanoSingle(info: ParsedVolcanoInfo, opts?: FlushOptions): void {
    // buildVolcanoOutcome は volcanoState.update() の前に呼ぶ
    // (trackedBefore の算出に現在の state が必要)
    const cachedMsg = volcanoMsgCache.get(info.volcanoCode);
    const outcome = cachedMsg ? buildVolcanoOutcome(cachedMsg, info, volcanoState) : null;

    const presentation = resolveVolcanoPresentation(info, volcanoState);
    volcanoState.update(info);

    // 通知は filter 非適用
    if (opts?.notify !== false) {
      notifier.notifyVolcano(info, presentation);
    }

    // PresentationEvent パイプライン
    if (outcome) {
      const rawEvent: PresentationEvent = toPresentationEvent(outcome);
      const event = diffStore.apply(rawEvent);

      const displayed = shouldDisplay(event, pipeline);
      summaryTracker.record(event, displayed);

      if (!displayed) {
        volcanoMsgCache.delete(info.volcanoCode);
        return;
      }

      const isFocused = pipeline.focus == null || pipeline.focus(event);
      if (!isFocused) {
        console.log(chalk.dim(renderSummaryLine(event)));
        volcanoMsgCache.delete(info.volcanoCode);
        return;
      }

      const templateOutput = renderTemplate(event, pipeline);
      if (templateOutput != null) {
        console.log(templateOutput);
        volcanoMsgCache.delete(info.volcanoCode);
        return;
      }

      if (getDisplayMode() === "compact") {
        console.log(renderSummaryLine(event));
        volcanoMsgCache.delete(info.volcanoCode);
        return;
      }

      // 通常表示
      displayVolcanoInfo(info, presentation);
    } else {
      // msg キャッシュがない場合はフォールバック表示
      displayVolcanoInfo(info, presentation);
    }

    volcanoMsgCache.delete(info.volcanoCode);
  }

  /**
   * 火山バッチ電文の PresentationEvent パイプライン処理。
   */
  function emitVolcanoBatch(batch: Vfvo53BatchItems, opts: FlushOptions): void {
    const presentation = resolveVolcanoBatchPresentation(batch);

    // 通知は filter 非適用
    if (opts.notify) {
      notifier.notifyVolcanoBatch(batch, presentation);
    }

    // バッチの代表 msg を取得 (最初の item の volcanoCode でキャッシュを参照)
    const firstItem = batch.items[0];
    const cachedMsg = firstItem ? volcanoMsgCache.get(firstItem.volcanoCode) : undefined;

    if (cachedMsg) {
      const batchOutcome: VolcanoBatchOutcome = {
        domain: "volcano",
        msg: cachedMsg,
        headType: cachedMsg.head.type,
        statsCategory: "volcano",
        parsed: batch.items,
        isBatch: true,
        volcanoPresentation: presentation,
        batchReportDateTime: batch.reportDateTime,
        batchIsTest: batch.isTest,
        stats: {
          shouldRecord: false, // stats は handler レベルで既に記録済み
        },
        presentation: {
          frameLevel: presentation.frameLevel,
          soundLevel: presentation.soundLevel,
          notifyCategory: "volcano",
        },
      };

      const rawEvent: PresentationEvent = toPresentationEvent(batchOutcome);
      const event = diffStore.apply(rawEvent);

      const displayed = shouldDisplay(event, pipeline);
      summaryTracker.record(event, displayed);

      if (!displayed) {
        cleanupBatchCache(batch);
        return;
      }

      const isFocused = pipeline.focus == null || pipeline.focus(event);
      if (!isFocused) {
        console.log(chalk.dim(renderSummaryLine(event)));
        cleanupBatchCache(batch);
        return;
      }

      const templateOutput = renderTemplate(event, pipeline);
      if (templateOutput != null) {
        console.log(templateOutput);
        cleanupBatchCache(batch);
        return;
      }

      if (getDisplayMode() === "compact") {
        console.log(renderSummaryLine(event));
        cleanupBatchCache(batch);
        return;
      }

      // 通常表示
      displayVolcanoAshfallBatch(batch, presentation);
    } else {
      // msg キャッシュがない場合はフォールバック表示
      displayVolcanoAshfallBatch(batch, presentation);
    }

    cleanupBatchCache(batch);
  }

  function cleanupBatchCache(batch: Vfvo53BatchItems): void {
    for (const item of batch.items) {
      volcanoMsgCache.delete(item.volcanoCode);
    }
  }

  // VFVO53 バッチ集約器
  const vfvo53Aggregator = new VolcanoVfvo53Aggregator(emitVolcanoSingle, emitVolcanoBatch);

  const handler = (msg: WsDataMessage): void => {
    // XML電文でない場合はヘッダ情報のみ表示
    if (msg.format !== "xml" || !msg.head.xml) {
      displayRawHeader(msg);
      return;
    }

    const route = classifyMessage(msg.classification, msg.head.type);

    // 火山は VFVO53 aggregator 経由の特殊パス
    // emitSingle/emitBatch コールバック内で PresentationEvent パイプラインに通す。
    // volcanoMsgCache に msg をキャッシュし、emit 時に復元する。
    if (route === "volcano") {
      const volcanoInfo = parseVolcanoTelegram(msg);
      if (volcanoInfo) {
        volcanoMsgCache.set(volcanoInfo.volcanoCode, msg);
        vfvo53Aggregator.handle(volcanoInfo);
      } else {
        displayRawHeader(msg);
      }
      // 火山の統計記録 (aggregator 経由でも即座に記録)
      stats.record({
        headType: msg.head.type,
        category: routeToCategory(route),
        eventId: msg.xmlReport?.head.eventId ?? null,
      });
      return;
    }

    // 火山以外: processMessage → recordStats → dispatchDisplay
    const outcome = processMsg(msg, route, processDeps);
    if (outcome == null) {
      // EEW 重複 → 表示・統計記録なし
      return;
    }

    recordStats(outcome, stats);

    // 通知は filter 非適用
    dispatchNotify(outcome, notifier);

    // filter → diffStore → focus → template 適用
    const rawEvent: PresentationEvent = toPresentationEvent(outcome);
    const event = diffStore.apply(rawEvent);

    const displayed = shouldDisplay(event, pipeline);

    // 要約トラッカーに記録 (filter 通過有無も含む)
    summaryTracker.record(event, displayed);

    if (!displayed) {
      return; // 表示のみ抑制
    }

    // focus 判定: 非一致電文は dim compact 表示に落とす
    const isFocused = pipeline.focus == null || pipeline.focus(event);
    if (!isFocused) {
      const dimLine = chalk.dim(renderSummaryLine(event));
      console.log(dimLine);
      return;
    }

    const templateOutput = renderTemplate(event, pipeline);
    if (templateOutput != null) {
      console.log(templateOutput);
      return;
    }

    if (getDisplayMode() === "compact") {
      console.log(renderSummaryLine(event));
      return;
    }

    dispatchDisplayOnly(outcome);
  };

  return {
    handler,
    eewLogger,
    notifier,
    tsunamiState,
    volcanoState,
    stats,
    summaryTracker,
    flushAndDisposeVolcanoBuffer: () => vfvo53Aggregator.flushAndDispose(),
  };
}
