/**
 * engine 層の DisplayCallbacks を実装する UI アダプター。
 * 全ての display 関数をここに集約し、engine → ui の逆方向依存を断つ。
 */

import type { DisplayCallbacks } from "../engine/messages/display-callbacks";
import type { ProcessOutcome } from "../engine/presentation/types";
import type { WsDataMessage, ParsedVolcanoInfo } from "../types";
import type { VolcanoPresentation } from "../engine/presentation/volcano-presentation";
import type { Vfvo53BatchItems } from "../engine/messages/volcano-vfvo53-aggregator";
import {
  displayRawHeader,
  displayTelegramDiagnostic,
  getDisplayMode,
} from "./formatter";
import { renderSummaryLine } from "./summary";
import { displayEewInfo } from "./eew-formatter";
import { displaySeismicTextInfo } from "./seismic-text-formatter";
import { displayNankaiTroughInfo } from "./nankai-trough-formatter";
import { displayLgObservationInfo } from "./lg-observation-formatter";
import { displayEarthquakeInfo } from "./earthquake-info-formatter";
import { displayTsunamiInfo } from "./tsunami-formatter";
import { displayVolcanoInfo, displayVolcanoAshfallBatch } from "./volcano-formatter";
import { displayWeatherWarning } from "./weather-formatter";
import { displayWeatherWarningCore } from "./weather-core-formatter";
import { displayTornadoAdvisory } from "./tornado-formatter";
import { displayWeatherBriefing } from "./briefing-formatter";
import { displayEarlyWeatherInfo } from "./early-weather-formatter";
import { displayWeatherWarningTimeseriesInfo } from "./weather-warning-timeseries-formatter";
import { displayClimateInfo } from "./climate-info-formatter";
import { displayWeatherExplanation } from "./weather-explanation-formatter";
import { displayHeatAlertInfo } from "./heat-alert-formatter";
import { displayTyphoonAnalysisInfo } from "./typhoon-analysis-formatter";
import { displayTyphoonProbabilityInfo } from "./typhoon-probability-formatter";
import { displayFloodForecastInfo } from "./flood-forecast-formatter";
import { assertNever } from "../utils/assert-never";

/** DisplayCallbacks の実装を生成する */
const VPWW_CORE_TYPES = new Set(["VPWW55", "VPWW56", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61"]);

export function createDisplayAdapter(): DisplayCallbacks {
  return {
    displayOutcome(outcome: ProcessOutcome): void {
      switch (outcome.domain) {
        case "eew":
          displayEewInfo(outcome.parsed, {
            activeCount: outcome.eewResult.activeCount,
            diff: outcome.eewResult.diff,
            colorIndex: outcome.eewResult.colorIndex,
          });
          break;
        case "earthquake":
          displayEarthquakeInfo(outcome.parsed);
          break;
        case "seismicText":
          displaySeismicTextInfo(outcome.parsed);
          break;
        case "lgObservation":
          displayLgObservationInfo(outcome.parsed);
          break;
        case "tsunami":
          displayTsunamiInfo(outcome.parsed);
          break;
        case "nankaiTrough":
          displayNankaiTroughInfo(outcome.parsed);
          break;
        case "weather":
          // VPWW55-61 は新 formatter (警戒レベル相当デザイン)、VPWS50 等は旧 formatter。
          if (VPWW_CORE_TYPES.has(outcome.parsed.type)) {
            displayWeatherWarningCore(outcome.parsed);
          } else {
            displayWeatherWarning(outcome.parsed, outcome.presentation.weatherDiff);
          }
          break;
        case "tornado":
          displayTornadoAdvisory(outcome.parsed);
          break;
        case "briefing":
          displayWeatherBriefing(outcome.parsed);
          break;
        case "earlyWeather":
          displayEarlyWeatherInfo(outcome.parsed);
          break;
        case "weatherWarningTimeseries":
          displayWeatherWarningTimeseriesInfo(outcome.parsed);
          break;
        case "climateInfo":
          displayClimateInfo(outcome.parsed);
          break;
        case "weatherExplanation":
          displayWeatherExplanation(outcome.parsed);
          break;
        case "heatAlert":
          displayHeatAlertInfo(outcome.parsed);
          break;
        case "typhoonAnalysis":
          displayTyphoonAnalysisInfo(outcome.parsed);
          break;
        case "typhoonProbability":
          displayTyphoonProbabilityInfo(outcome.parsed);
          break;
        case "floodForecast":
          displayFloodForecastInfo(outcome.parsed);
          break;
        case "raw":
          displayRawHeader(outcome.msg);
          break;
        case "volcano":
          // 特殊ルート: 火山は VolcanoRouteHandler 経由で displayVolcano/displayVolcanoBatch を
          // 直接呼ぶため、displayOutcome には到達しない。網羅性のため明示的に no-op で受ける。
          break;
        default:
          // PresentationDomain に新メンバーが増えて case を足し忘れるとコンパイルエラー。
          assertNever(outcome);
      }
    },

    displayRawHeader(msg: WsDataMessage): void {
      displayRawHeader(msg);
    },

    displayTelegramDiagnostic,

    displayVolcano(info: ParsedVolcanoInfo, presentation: VolcanoPresentation): void {
      displayVolcanoInfo(info, presentation);
    },

    displayVolcanoBatch(batch: Vfvo53BatchItems, presentation: VolcanoPresentation): void {
      displayVolcanoAshfallBatch(batch, presentation);
    },

    getDisplayMode(): string {
      return getDisplayMode();
    },

    renderSummaryLine,
  };
}
