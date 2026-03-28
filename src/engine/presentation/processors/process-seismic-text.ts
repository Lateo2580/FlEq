import type { WsDataMessage } from "../../../types";
import type { SeismicTextOutcome } from "../types";
import { parseSeismicTextTelegram } from "../../../dmdata/telegram-parser";
import { seismicTextFrameLevel, seismicTextSoundLevel } from "../level-helpers";

/**
 * テキスト系地震電文 (VXSE56/VXSE60/VZSE40) を処理し SeismicTextOutcome を返す。
 * パース失敗の場合は null を返す。
 */
export function processSeismicText(msg: WsDataMessage): SeismicTextOutcome | null {
  const textInfo = parseSeismicTextTelegram(msg);
  if (!textInfo) return null;

  return {
    domain: "seismicText",
    msg,
    headType: msg.head.type,
    statsCategory: "earthquake", // routeToCategory("seismicText") = "earthquake"
    parsed: textInfo,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: seismicTextFrameLevel(textInfo),
      soundLevel: seismicTextSoundLevel(textInfo),
      notifyCategory: "seismicText",
    },
  };
}
