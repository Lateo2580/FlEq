import type { WsDataMessage } from "../../../types";
import type { EewOutcome } from "../types";
import { parseEewTelegram } from "../../../dmdata/telegram-parser";
import type { EewTracker } from "../../eew/eew-tracker";
import type { EewEventLogger } from "../../eew/eew-logger";
import { eewFrameLevel, eewSoundLevel } from "../level-helpers";
import * as log from "../../../logger";

/** processEew の戻り値 */
export type EewProcessResult =
  | { kind: "ok"; outcome: EewOutcome }
  | { kind: "duplicate" }
  | { kind: "parse-failed" };

/**
 * EEW 電文を処理し結果を返す。
 * - パース失敗: { kind: "parse-failed" }
 * - 重複報: { kind: "duplicate" }
 * - 正常: { kind: "ok", outcome }
 */
export function processEew(
  msg: WsDataMessage,
  eewTracker: EewTracker,
  eewLogger: EewEventLogger,
): EewProcessResult {
  const eewInfo = parseEewTelegram(msg);
  if (!eewInfo) return { kind: "parse-failed" };

  const result = eewTracker.update(eewInfo);
  if (result.isDuplicate) {
    log.debug(`EEW 重複報スキップ: EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    return { kind: "duplicate" };
  }

  // ログ記録
  eewLogger.logReport(eewInfo, result);
  if (result.isCancelled && eewInfo.eventId) {
    eewLogger.closeEvent(eewInfo.eventId, "取消");
  }
  if (eewInfo.nextAdvisory && eewInfo.eventId && !result.isCancelled) {
    eewLogger.closeEvent(eewInfo.eventId, "最終報");
    eewTracker.finalizeEvent(eewInfo.eventId);
  }

  return {
    kind: "ok",
    outcome: {
      domain: "eew",
      msg,
      headType: msg.head.type,
      statsCategory: "eew",
      parsed: eewInfo,
      state: {
        activeCount: result.activeCount,
        colorIndex: result.colorIndex,
        isCancelled: result.isCancelled,
        diff: result.diff,
      },
      eewResult: result,
      stats: {
        shouldRecord: true,
        eventId: eewInfo.eventId,
      },
      presentation: {
        frameLevel: eewFrameLevel(eewInfo),
        soundLevel: eewSoundLevel(eewInfo),
        notifyCategory: "eew",
      },
    },
  };
}
