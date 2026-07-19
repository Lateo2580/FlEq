import type { WsDataMessage } from "../../../types";
import type { ProcessOutcome } from "../types";
import type { EewTracker } from "../../eew/eew-tracker";
import type { EewEventLogger } from "../../eew/eew-logger";
import type { TsunamiStateHolder } from "../../messages/tsunami-state";
import type { VolcanoStateHolder } from "../../messages/volcano-state";
import type { Vpws50StateHolder } from "../../messages/vpws50-state";
import type { Vpww56StateHolder } from "../../messages/vpww56-state";
import type { Vpwp50DetailCache } from "../../messages/vpwp50-detail-cache";
import type { TyphoonProbabilityStateHolder } from "../../messages/typhoon-probability-state";
import type { FloodForecastStateHolder } from "../../messages/flood-forecast-state";
import { routeToCategory } from "../../messages/telegram-stats";
import { processEew } from "./process-eew";
import { processEarthquake } from "./process-earthquake";
import { processSeismicText } from "./process-seismic-text";
import { processLgObservation } from "./process-lg-observation";
import { processTsunami } from "./process-tsunami";
import { processNankaiTrough } from "./process-nankai-trough";
import { processWeather } from "./process-weather";
import { processTornado } from "./process-tornado";
import { processBriefing } from "./process-briefing";
import { processEarlyWeather } from "./process-early-weather";
import { processWeatherWarningTimeseries } from "./process-weather-warning-timeseries";
import { processClimateInfo } from "./process-climate-info";
import { processWeatherExplanation } from "./process-weather-explanation";
import { processHeatAlert } from "./process-heat-alert";
import { processTyphoonAnalysis } from "./process-typhoon-analysis";
import { processTyphoonProbability } from "./process-typhoon-probability";
import { processFloodForecast } from "./process-flood-forecast";
import { processRaw } from "./process-raw";

/** processMessage に必要な依存群 */
export interface ProcessDeps {
  eewTracker: EewTracker;
  eewLogger: EewEventLogger;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  vpws50State: Vpws50StateHolder;
  vpww56State: Vpww56StateHolder;
  vpwp50Cache: Vpwp50DetailCache;
  typhoonProbabilityState: TyphoonProbabilityStateHolder;
  /** 指定河川洪水予報 (VXKO50-89 / VXSU50-59) の差分検出 state holder (Task 25b で dispatch を追加) */
  floodForecastState: FloodForecastStateHolder;
}

/**
 * ルートに応じた processXxx を呼び出し ProcessOutcome を返す。
 * パース失敗の場合は RawOutcome にフォールバックする（元カテゴリを statsCategory に保持）。
 *
 * EEW / tsunami / weather の suppressed は null を返す（表示・通知・統計なし）。
 * 火山の場合: VFVO53 aggregator との連携は呼び出し側の責務。
 */
export function processMessage(
  msg: WsDataMessage,
  route: string,
  deps: ProcessDeps,
): ProcessOutcome | null {
  const category = routeToCategory(route);

  switch (route) {
    case "eew": {
      const eewResult = processEew(msg, deps.eewTracker, deps.eewLogger);
      if (eewResult.kind === "ok") return eewResult.outcome;
      if (eewResult.kind === "duplicate" || eewResult.kind === "suppressed") return null; // 重複・抑制 → 表示・統計なし
      // parse-failed → raw 表示するが統計には含めない（旧 router と同じ動作）
      const raw = processRaw(msg, category);
      raw.stats.shouldRecord = false;
      return raw;
    }
    case "earthquake": {
      return processEarthquake(msg) ?? processRaw(msg, category);
    }
    case "seismicText": {
      return processSeismicText(msg) ?? processRaw(msg, category);
    }
    case "lgObservation": {
      return processLgObservation(msg) ?? processRaw(msg, category);
    }
    case "tsunami": {
      const tsunamiResult = processTsunami(msg, deps.tsunamiState);
      if (tsunamiResult.kind === "ok") return tsunamiResult.outcome;
      if (tsunamiResult.kind === "suppressed") return null; // 古い報・重複報 → 表示・通知・統計なし
      return processRaw(msg, category);
    }
    case "nankaiTrough": {
      return processNankaiTrough(msg) ?? processRaw(msg, category);
    }
    case "weather": {
      const weatherResult = processWeather(msg, deps);
      if (weatherResult.kind === "ok") return weatherResult.outcome;
      if (weatherResult.kind === "suppressed") return null; // 古い報・重複報・対象不一致取消 → 全出力なし
      return processRaw(msg, category);
    }
    case "tornado": {
      return processTornado(msg) ?? processRaw(msg, category);
    }
    case "briefing": {
      return processBriefing(msg) ?? processRaw(msg, category);
    }
    case "earlyWeather": {
      return processEarlyWeather(msg) ?? processRaw(msg, category);
    }
    case "weatherWarningTimeseries": {
      return processWeatherWarningTimeseries(msg, deps) ?? processRaw(msg, category);
    }
    case "climateInfo": {
      return processClimateInfo(msg) ?? processRaw(msg, category);
    }
    case "weatherExplanation": {
      return processWeatherExplanation(msg) ?? processRaw(msg, category);
    }
    case "heatAlert": {
      return processHeatAlert(msg) ?? processRaw(msg, category);
    }
    case "typhoonAnalysis": {
      return processTyphoonAnalysis(msg) ?? processRaw(msg, category);
    }
    case "typhoonProbability": {
      return processTyphoonProbability(msg, deps) ?? processRaw(msg, category);
    }
    case "floodForecast": {
      return processFloodForecast(msg, deps) ?? processRaw(msg, category);
    }
    // volcano: VolcanoRouteHandler が処理する (VFVO53 バッチ集約のため線形フローでは処理不可)
    default: {
      return processRaw(msg, category);
    }
  }
}
