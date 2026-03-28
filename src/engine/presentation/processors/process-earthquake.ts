import type { WsDataMessage } from "../../../types";
import type { EarthquakeOutcome } from "../types";
import { parseEarthquakeTelegram } from "../../../dmdata/telegram-parser";
import { earthquakeFrameLevel, earthquakeSoundLevel } from "../level-helpers";

/**
 * 地震電文 (VXSE51/52/53/61) を処理し EarthquakeOutcome を返す。
 * パース失敗の場合は null を返す。
 */
export function processEarthquake(msg: WsDataMessage): EarthquakeOutcome | null {
  const eqInfo = parseEarthquakeTelegram(msg);
  if (!eqInfo) return null;

  const eventId = msg.xmlReport?.head.eventId ?? null;
  const maxIntUpdate =
    eventId && eqInfo.intensity?.maxInt
      ? { eventId, maxInt: eqInfo.intensity.maxInt, headType: msg.head.type }
      : undefined;

  return {
    domain: "earthquake",
    msg,
    headType: msg.head.type,
    statsCategory: "earthquake",
    parsed: eqInfo,
    state: eventId ? { eventId, representativeMaxInt: eqInfo.intensity?.maxInt } : undefined,
    stats: {
      shouldRecord: true,
      eventId,
      maxIntUpdate,
    },
    presentation: {
      frameLevel: earthquakeFrameLevel(eqInfo),
      soundLevel: earthquakeSoundLevel(eqInfo),
      notifyCategory: "earthquake",
    },
  };
}
