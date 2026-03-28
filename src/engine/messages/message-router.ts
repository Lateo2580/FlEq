import { WsDataMessage } from "../../types";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { displayRawHeader } from "../../ui/formatter";
import { displayEewInfo } from "../../ui/eew-formatter";
import {
  displayEarthquakeInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayNankaiTroughInfo,
  displayLgObservationInfo,
} from "../../ui/earthquake-formatter";
import { displayVolcanoInfo, displayVolcanoAshfallBatch } from "../../ui/volcano-formatter";
import { VolcanoVfvo53Aggregator } from "./volcano-vfvo53-aggregator";
import { EewTracker } from "../eew/eew-tracker";
import { EewEventLogger } from "../eew/eew-logger";
import { Notifier } from "../notification/notifier";
import { TsunamiStateHolder } from "./tsunami-state";
import { VolcanoStateHolder } from "./volcano-state";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation } from "../notification/volcano-presentation";
import { TelegramStats, routeToCategory } from "./telegram-stats";
import { processMessage as processMsg, ProcessDeps } from "../presentation/processors/process-message";
import { toPresentationEvent } from "../presentation/events/to-presentation-event";
import type { ProcessOutcome, PresentationEvent } from "../presentation/types";

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

/** ProcessOutcome に基づいて表示・通知を実行する */
function dispatchDisplay(outcome: ProcessOutcome, notifier: Notifier): void {
  switch (outcome.domain) {
    case "eew": {
      displayEewInfo(outcome.parsed, {
        activeCount: outcome.eewResult.activeCount,
        diff: outcome.eewResult.diff,
        colorIndex: outcome.eewResult.colorIndex,
      });
      notifier.notifyEew(outcome.parsed, outcome.eewResult);
      break;
    }
    case "earthquake": {
      displayEarthquakeInfo(outcome.parsed);
      notifier.notifyEarthquake(outcome.parsed);
      break;
    }
    case "seismicText": {
      displaySeismicTextInfo(outcome.parsed);
      notifier.notifySeismicText(outcome.parsed);
      break;
    }
    case "lgObservation": {
      displayLgObservationInfo(outcome.parsed);
      notifier.notifyLgObservation(outcome.parsed);
      break;
    }
    case "tsunami": {
      displayTsunamiInfo(outcome.parsed);
      notifier.notifyTsunami(outcome.parsed);
      break;
    }
    case "nankaiTrough": {
      displayNankaiTroughInfo(outcome.parsed);
      notifier.notifyNankaiTrough(outcome.parsed);
      break;
    }
    case "raw": {
      displayRawHeader(outcome.msg);
      break;
    }
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

/** createMessageHandler の戻り値 */
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  stats: TelegramStats;
  flushAndDisposeVolcanoBuffer: () => void;
}

/** 受信データのハンドリング */
export function createMessageHandler(): MessageHandlerResult {
  const eewLogger = new EewEventLogger();
  const notifier = new Notifier();
  const tsunamiState = new TsunamiStateHolder();
  const volcanoState = new VolcanoStateHolder();
  const stats = new TelegramStats();
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

  // VFVO53 バッチ集約器
  const vfvo53Aggregator = new VolcanoVfvo53Aggregator(
    // emitSingle: 従来の単発処理パイプライン (opts?.notify === false なら通知スキップ)
    (info, opts) => {
      const presentation = resolveVolcanoPresentation(info, volcanoState);
      displayVolcanoInfo(info, presentation);
      volcanoState.update(info);
      if (opts?.notify !== false) {
        notifier.notifyVolcano(info, presentation);
      }
    },
    // emitBatch: バッチ専用処理
    (batch, opts) => {
      const presentation = resolveVolcanoBatchPresentation(batch);
      displayVolcanoAshfallBatch(batch, presentation);
      if (opts.notify) {
        notifier.notifyVolcanoBatch(batch, presentation);
      }
    },
  );

  const handler = (msg: WsDataMessage): void => {
    // XML電文でない場合はヘッダ情報のみ表示
    if (msg.format !== "xml" || !msg.head.xml) {
      displayRawHeader(msg);
      return;
    }

    const route = classifyMessage(msg.classification, msg.head.type);

    // 火山は VFVO53 aggregator 経由の特殊パス (PresentationEvent パイプライン未統合)
    // TODO: Phase 2 で aggregator emit 内に VolcanoOutcome → toPresentationEvent 変換を追加し
    //       --filter / --template / --compact で火山電文も扱えるようにする
    if (route === "volcano") {
      const volcanoInfo = parseVolcanoTelegram(msg);
      if (volcanoInfo) {
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

    // Phase 2 以降で --filter / --template が PresentationEvent を消費する
    const _event: PresentationEvent = toPresentationEvent(outcome);
    void _event;

    dispatchDisplay(outcome, notifier);
  };

  return {
    handler,
    eewLogger,
    notifier,
    tsunamiState,
    volcanoState,
    stats,
    flushAndDisposeVolcanoBuffer: () => vfvo53Aggregator.flushAndDispose(),
  };
}
