import type { WsDataMessage } from "../../../types";
import type { WeatherWarningTimeseriesOutcome } from "../types";
import type { ProcessDeps } from "./process-message";
import { parseWeatherWarningTimeseries } from "../../../dmdata/weather-warning-timeseries-parser";
import {
  weatherWarningTimeseriesFrameLevel,
  weatherWarningTimeseriesSoundLevel,
} from "../level-helpers";

/**
 * 気象警報・注意報時系列情報 (VPWP50) を処理し
 * WeatherWarningTimeseriesOutcome を返す。パース失敗時は null。
 *
 * router 経路では共通 revision gate 受理後に process-message が cache を更新する。
 * 直接利用で deps を渡した場合だけ、互換経路としてここで更新する。
 */
export function processWeatherWarningTimeseries(
  msg: WsDataMessage,
  deps?: Pick<ProcessDeps, "vpwp50Cache">,
): WeatherWarningTimeseriesOutcome | null {
  const info = parseWeatherWarningTimeseries(msg);
  if (!info) return null;
  deps?.vpwp50Cache.rememberLatest(info);

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
