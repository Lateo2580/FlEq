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
 * パース成功直後に deps.vpwp50Cache.rememberLatest(info) を呼び、最新電文を
 * cache する。表示抑制 (filter / compact) や取消電文でも cache は更新される。
 */
export function processWeatherWarningTimeseries(
  msg: WsDataMessage,
  deps?: ProcessDeps,
): WeatherWarningTimeseriesOutcome | null {
  const info = parseWeatherWarningTimeseries(msg);
  if (!info) return null;

  // parse できた info を最新として記憶 (display/filter とは独立に detail を提供)
  if (deps?.vpwp50Cache != null) {
    deps.vpwp50Cache.rememberLatest(info);
  }

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
