import type { WsDataMessage } from "../../../types";
import type { LgObservationOutcome } from "../types";
import { parseLgObservationTelegram } from "../../../dmdata/telegram-parser";
import { lgObservationFrameLevel, lgObservationSoundLevel } from "../level-helpers";

/**
 * 長周期地震動観測情報 (VXSE62) を処理し LgObservationOutcome を返す。
 * パース失敗の場合は null を返す。
 */
export function processLgObservation(msg: WsDataMessage): LgObservationOutcome | null {
  const lgInfo = parseLgObservationTelegram(msg);
  if (!lgInfo) return null;

  return {
    domain: "lgObservation",
    msg,
    headType: msg.head.type,
    statsCategory: "earthquake", // routeToCategory("lgObservation") = "earthquake"
    parsed: lgInfo,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: lgObservationFrameLevel(lgInfo),
      soundLevel: lgObservationSoundLevel(lgInfo),
      notifyCategory: "lgObservation",
    },
  };
}
