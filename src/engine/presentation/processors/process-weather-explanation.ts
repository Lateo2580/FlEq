import type { WsDataMessage } from "../../../types";
import type { WeatherExplanationOutcome } from "../types";
import { parseWeatherExplanation } from "../../../dmdata/weather-explanation-parser";
import {
  weatherExplanationFrameLevel,
  weatherExplanationSoundLevel,
} from "../level-helpers";

/** 気象解説情報 (VPCJ51/VPZJ51 共有) を処理し WeatherExplanationOutcome を返す。 */
export function processWeatherExplanation(
  msg: WsDataMessage,
): WeatherExplanationOutcome | null {
  const info = parseWeatherExplanation(msg);
  if (!info) return null;

  return {
    domain: "weatherExplanation",
    msg,
    headType: msg.head.type,
    statsCategory: "weatherExplanation",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? info.eventId,
    },
    presentation: {
      frameLevel: weatherExplanationFrameLevel(info),
      soundLevel: weatherExplanationSoundLevel(info),
      notifyCategory: "weatherExplanation",
    },
  };
}
