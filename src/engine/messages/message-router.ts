import { WsDataMessage } from "../../types";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../../dmdata/telegram-parser";
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
import * as log from "../../logger";
import { TelegramStats, routeToCategory } from "./telegram-stats";

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

// ── ルート別処理 ──

/** EEW パス: パース → 重複判定 → ログ → 表示 → 通知 */
function handleEew(
  msg: WsDataMessage,
  eewTracker: EewTracker,
  eewLogger: EewEventLogger,
  notifier: Notifier,
  stats: TelegramStats,
): void {
  const eewInfo = parseEewTelegram(msg);
  if (!eewInfo) {
    displayRawHeader(msg);
    return;
  }

  const result = eewTracker.update(eewInfo);
  if (result.isDuplicate) {
    log.debug(
      `EEW 重複報スキップ: EventID=${eewInfo.eventId} 第${eewInfo.serial}報`
    );
    return;
  }

  // 統計記録 (非重複報のみ)
  stats.record({
    headType: msg.head.type,
    category: "eew",
    eventId: eewInfo.eventId,
  });

  // ログ記録 (非重複報のみ)
  eewLogger.logReport(eewInfo, result);

  // 取消報の場合はログを閉じる
  if (result.isCancelled && eewInfo.eventId) {
    eewLogger.closeEvent(eewInfo.eventId, "取消");
  }

  // 最終報の場合はログを閉じ、トラッカーのイベントを終了扱いにする
  if (eewInfo.nextAdvisory && eewInfo.eventId && !result.isCancelled) {
    eewLogger.closeEvent(eewInfo.eventId, "最終報");
    eewTracker.finalizeEvent(eewInfo.eventId);
  }

  displayEewInfo(eewInfo, {
    activeCount: result.activeCount,
    diff: result.diff,
    colorIndex: result.colorIndex,
  });
  notifier.notifyEew(eewInfo, result);
}

/** テキスト系 (VXSE56/VXSE60/VZSE40) パス */
function handleSeismicText(msg: WsDataMessage, notifier: Notifier): void {
  const textInfo = parseSeismicTextTelegram(msg);
  if (textInfo) {
    displaySeismicTextInfo(textInfo);
    notifier.notifySeismicText(textInfo);
  } else {
    displayRawHeader(msg);
  }
}

/** 長周期地震動観測情報 (VXSE62) パス */
function handleLgObservation(msg: WsDataMessage, notifier: Notifier): void {
  const lgInfo = parseLgObservationTelegram(msg);
  if (lgInfo) {
    displayLgObservationInfo(lgInfo);
    notifier.notifyLgObservation(lgInfo);
  } else {
    displayRawHeader(msg);
  }
}

/** 地震情報 (VXSE51/52/53/61 等) パス */
function handleEarthquake(msg: WsDataMessage, notifier: Notifier, stats: TelegramStats): void {
  const eqInfo = parseEarthquakeTelegram(msg);
  if (eqInfo) {
    const eventId = msg.xmlReport?.head.eventId;
    if (eventId && eqInfo.intensity?.maxInt) {
      stats.updateMaxInt(eventId, eqInfo.intensity.maxInt, msg.head.type);
    }
    displayEarthquakeInfo(eqInfo);
    notifier.notifyEarthquake(eqInfo);
  } else {
    displayRawHeader(msg);
  }
}

/** 津波情報 (VTSE41/51/52) パス */
function handleTsunami(
  msg: WsDataMessage,
  notifier: Notifier,
  tsunamiState: TsunamiStateHolder,
): void {
  const tsunamiInfo = parseTsunamiTelegram(msg);
  if (tsunamiInfo) {
    // VTSE41 (津波警報・注意報) の場合のみ状態を更新
    if (msg.head.type === "VTSE41") {
      tsunamiState.update(tsunamiInfo);
    }
    displayTsunamiInfo(tsunamiInfo);
    notifier.notifyTsunami(tsunamiInfo);
  } else {
    displayRawHeader(msg);
  }
}

/** 南海トラフ関連 (VYSE50/51/52/60) パス */
function handleNankaiTrough(msg: WsDataMessage, notifier: Notifier): void {
  const nankaiInfo = parseNankaiTroughTelegram(msg);
  if (nankaiInfo) {
    displayNankaiTroughInfo(nankaiInfo);
    notifier.notifyNankaiTrough(nankaiInfo);
  } else {
    displayRawHeader(msg);
  }
}

/** 火山情報パス (aggregator 経由) */
function handleVolcano(
  msg: WsDataMessage,
  vfvo53Aggregator: VolcanoVfvo53Aggregator,
): void {
  const volcanoInfo = parseVolcanoTelegram(msg);
  if (volcanoInfo) {
    vfvo53Aggregator.handle(volcanoInfo);
  } else {
    displayRawHeader(msg);
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

    // EEW 以外はここで統計記録 (EEW は handleEew 内で記録)
    if (route !== "eew") {
      stats.record({
        headType: msg.head.type,
        category: routeToCategory(route),
        eventId: msg.xmlReport?.head.eventId ?? null,
      });
    }

    switch (route) {
      case "eew":
        handleEew(msg, eewTracker, eewLogger, notifier, stats);
        break;
      case "seismicText":
        handleSeismicText(msg, notifier);
        break;
      case "lgObservation":
        handleLgObservation(msg, notifier);
        break;
      case "earthquake":
        handleEarthquake(msg, notifier, stats);
        break;
      case "tsunami":
        handleTsunami(msg, notifier, tsunamiState);
        break;
      case "nankaiTrough":
        handleNankaiTrough(msg, notifier);
        break;
      case "volcano":
        handleVolcano(msg, vfvo53Aggregator);
        break;
      case "raw":
        displayRawHeader(msg);
        break;
    }
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
