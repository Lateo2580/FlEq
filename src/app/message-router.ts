import { WsDataMessage } from "../types";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
} from "../dmdata/telegram-parser";
import {
  displayEarthquakeInfo,
  displayEewInfo,
  displayRawHeader,
} from "../ui/formatter";
import { EewTracker } from "../features/eew-tracker";
import * as log from "../logger";

/** EEW イベントトラッカー */
const eewTracker = new EewTracker();

/** 受信データのハンドリング */
export function createMessageHandler(): (msg: WsDataMessage) => void {
  return (msg: WsDataMessage): void => {
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
        displayEewInfo(eewInfo, { activeCount: result.activeCount });
      } else {
        displayRawHeader(msg);
      }
      return;
    }

    // 地震・津波区分
    if (classification === "telegram.earthquake") {
      // 地震情報系 (VXSE51, VXSE52, VXSE53 等)
      if (headType.startsWith("VXSE")) {
        const eqInfo = parseEarthquakeTelegram(msg);
        if (eqInfo) {
          displayEarthquakeInfo(eqInfo);
        } else {
          displayRawHeader(msg);
        }
        return;
      }

      // 津波系 (VTSE41, VTSE51, VTSE52 等) - 現時点ではヘッダ表示+ヘッドライン
      if (headType.startsWith("VTSE")) {
        const eqInfo = parseEarthquakeTelegram(msg);
        if (eqInfo) {
          displayEarthquakeInfo(eqInfo);
        } else {
          displayRawHeader(msg);
        }
        return;
      }
    }

    // その他の電文
    displayRawHeader(msg);
  };
}
