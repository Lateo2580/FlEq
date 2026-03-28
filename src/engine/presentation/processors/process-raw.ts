import type { WsDataMessage } from "../../../types";
import type { RawOutcome } from "../types";
import type { StatsCategory } from "../../messages/telegram-stats";

/**
 * フォールバック: パース失敗等で認識できない電文の ProcessOutcome。
 * statsCategory は呼び出し元から渡され、元ルートのカテゴリを保持する。
 */
export function processRaw(msg: WsDataMessage, statsCategory: StatsCategory = "other"): RawOutcome {
  return {
    domain: "raw",
    msg,
    headType: msg.head.type,
    statsCategory,
    parsed: null,
    stats: {
      shouldRecord: true,
    },
    presentation: {
      frameLevel: "info",
    },
  };
}
