import type { WsDataMessage } from "../../../types";
import type { NankaiTroughOutcome } from "../types";
import { parseNankaiTroughTelegram } from "../../../dmdata/telegram-parser";
import { nankaiTroughFrameLevel, nankaiTroughSoundLevel } from "../level-helpers";

/**
 * 南海トラフ電文 (VYSE50/51/52/60) を処理し NankaiTroughOutcome を返す。
 * パース失敗の場合は null を返す。
 */
export function processNankaiTrough(msg: WsDataMessage): NankaiTroughOutcome | null {
  const nankaiInfo = parseNankaiTroughTelegram(msg);
  if (!nankaiInfo) return null;

  return {
    domain: "nankaiTrough",
    msg,
    headType: msg.head.type,
    statsCategory: "nankaiTrough",
    parsed: nankaiInfo,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: nankaiTroughFrameLevel(nankaiInfo),
      soundLevel: nankaiTroughSoundLevel(nankaiInfo),
      notifyCategory: "nankaiTrough",
    },
  };
}
