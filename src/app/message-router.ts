import { WsDataMessage } from "../types";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
} from "../dmdata/telegram-parser";
import {
  displayEarthquakeInfo,
  displayEewInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayRawHeader,
} from "../ui/formatter";
import { EewTracker } from "../features/eew-tracker";
import { EewEventLogger } from "../features/eew-logger";
import * as log from "../logger";

/** createMessageHandler の戻り値 */
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
}

/** 受信データのハンドリング */
export function createMessageHandler(): MessageHandlerResult {
  const eewLogger = new EewEventLogger();
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

    const classification = msg.classification;
    const headType = msg.head.type;

    // EEW区分
    if (
      classification === "eew.forecast" ||
      classification === "eew.warning"
    ) {
      const eewInfo = parseEewTelegram(msg);
      if (eewInfo) {
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

        displayEewInfo(eewInfo, {
          activeCount: result.activeCount,
          diff: result.diff,
        });
      } else {
        displayRawHeader(msg);
      }
      return;
    }

    // 地震・津波区分
    if (classification === "telegram.earthquake") {
      // VXSE56/VXSE60: テキスト系
      if (headType === "VXSE56" || headType === "VXSE60") {
        const textInfo = parseSeismicTextTelegram(msg);
        if (textInfo) {
          displaySeismicTextInfo(textInfo);
        } else {
          displayRawHeader(msg);
        }
        return;
      }

      // VXSE51/52/53/61 等: 地震情報系
      if (headType.startsWith("VXSE")) {
        const eqInfo = parseEarthquakeTelegram(msg);
        if (eqInfo) {
          displayEarthquakeInfo(eqInfo);
        } else {
          displayRawHeader(msg);
        }
        return;
      }

      // VTSE41/51/52: 津波系
      if (headType.startsWith("VTSE")) {
        const tsunamiInfo = parseTsunamiTelegram(msg);
        if (tsunamiInfo) {
          displayTsunamiInfo(tsunamiInfo);
        } else {
          displayRawHeader(msg);
        }
        return;
      }
    }

    // その他の電文
    displayRawHeader(msg);
  };

  return { handler, eewLogger };
}
