import { WsDataMessage } from "../../types";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../../dmdata/telegram-parser";
import {
  displayEarthquakeInfo,
  displayEewInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayNankaiTroughInfo,
  displayLgObservationInfo,
  displayRawHeader,
} from "../../ui/formatter";
import { EewTracker } from "../eew/eew-tracker";
import { EewEventLogger } from "../eew/eew-logger";
import { Notifier } from "../notification/notifier";
import { TsunamiStateHolder } from "./tsunami-state";
import * as log from "../../logger";

// ── 電文分類 (Route) ──

/** 電文の処理ルート */
type Route =
  | "eew"
  | "seismicText"
  | "lgObservation"
  | "earthquake"
  | "tsunami"
  | "nankaiTrough"
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
 *   7. その他 → raw
 */
function classifyMessage(classification: string, headType: string): Route {
  if (classification === "eew.forecast" || classification === "eew.warning") {
    return "eew";
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
function handleEarthquake(msg: WsDataMessage, notifier: Notifier): void {
  const eqInfo = parseEarthquakeTelegram(msg);
  if (eqInfo) {
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

// ── ファクトリ ──

/** createMessageHandler の戻り値 */
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
}

/** 受信データのハンドリング */
export function createMessageHandler(): MessageHandlerResult {
  const eewLogger = new EewEventLogger();
  const notifier = new Notifier();
  const tsunamiState = new TsunamiStateHolder();
  const eewTracker = new EewTracker({
    onCleanup: (eventId) => {
      eewLogger.closeEvent(eventId, "タイムアウト");
    },
  });

  const handler = (msg: WsDataMessage): void => {
    // XML電文でない場合はヘッダ情報のみ表示
    if (msg.format !== "xml" || !msg.head.xml) {
      displayRawHeader(msg);
      return;
    }

    const route = classifyMessage(msg.classification, msg.head.type);

    switch (route) {
      case "eew":
        handleEew(msg, eewTracker, eewLogger, notifier);
        break;
      case "seismicText":
        handleSeismicText(msg, notifier);
        break;
      case "lgObservation":
        handleLgObservation(msg, notifier);
        break;
      case "earthquake":
        handleEarthquake(msg, notifier);
        break;
      case "tsunami":
        handleTsunami(msg, notifier, tsunamiState);
        break;
      case "nankaiTrough":
        handleNankaiTrough(msg, notifier);
        break;
      case "raw":
        displayRawHeader(msg);
        break;
    }
  };

  return { handler, eewLogger, notifier, tsunamiState };
}
