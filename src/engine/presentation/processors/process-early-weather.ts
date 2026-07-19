import type { WsDataMessage } from "../../../types";
import type { EarlyWeatherOutcome } from "../types";
import { parseEarlyWeather } from "../../../dmdata/early-weather-parser";
import {
  earlyWeatherFrameLevel,
  earlyWeatherSoundLevel,
} from "../level-helpers";

/** 早期天候情報 (VPAW51) を処理し EarlyWeatherOutcome を返す。パース失敗時は null。 */
export function processEarlyWeather(
  msg: WsDataMessage,
): EarlyWeatherOutcome | null {
  const info = parseEarlyWeather(msg);
  if (!info) return null;

  return {
    domain: "earlyWeather",
    msg,
    headType: msg.head.type,
    statsCategory: "earlyWeather",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? info.eventId,
    },
    presentation: {
      frameLevel: earlyWeatherFrameLevel(info),
      soundLevel: earlyWeatherSoundLevel(info),
      notifyCategory: "earlyWeather",
    },
  };
}
