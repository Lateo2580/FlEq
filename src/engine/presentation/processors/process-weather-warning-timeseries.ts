import type { WsDataMessage } from "../../../types";
import type { WeatherWarningTimeseriesOutcome } from "../types";
import { parseWeatherWarningTimeseries } from "../../../dmdata/weather-warning-timeseries-parser";
import {
  weatherWarningTimeseriesFrameLevel,
  weatherWarningTimeseriesSoundLevel,
} from "../level-helpers";

/**
 * 気象警報・注意報時系列情報 (VPWP50) を処理し
 * WeatherWarningTimeseriesOutcome を返す。パース失敗時は null。
 */
export function processWeatherWarningTimeseries(
  msg: WsDataMessage,
): WeatherWarningTimeseriesOutcome | null {
  const info = parseWeatherWarningTimeseries(msg);
  if (!info) return null;

  return {
    domain: "weatherWarningTimeseries",
    msg,
    headType: msg.head.type,
    statsCategory: "weatherWarningTimeseries",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? info.eventId,
    },
    presentation: {
      frameLevel: weatherWarningTimeseriesFrameLevel(info),
      soundLevel: weatherWarningTimeseriesSoundLevel(info),
      notifyCategory: "weatherWarningTimeseries",
    },
  };
}
