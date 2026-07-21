import type { ProcessOutcome, PresentationEvent } from "../types";
import { fromEewOutcome } from "./from-eew";
import { fromEarthquakeOutcome } from "./from-earthquake";
import { fromSeismicTextOutcome } from "./from-seismic-text";
import { fromLgObservationOutcome } from "./from-lg-observation";
import { fromTsunamiOutcome } from "./from-tsunami";
import { fromVolcanoOutcome } from "./from-volcano";
import { fromNankaiTroughOutcome } from "./from-nankai-trough";
import { fromWeatherOutcome } from "./from-weather";
import { fromTornadoOutcome } from "./from-tornado";
import { fromBriefingOutcome } from "./from-briefing";
import { fromEarlyWeatherOutcome } from "./from-early-weather";
import { fromWeatherWarningTimeseriesOutcome } from "./from-weather-warning-timeseries";
import { fromClimateInfoOutcome } from "./from-climate-info";
import { fromWeatherExplanationOutcome } from "./from-weather-explanation";
import { fromHeatAlertOutcome } from "./from-heat-alert";
import { fromTyphoonAnalysisOutcome } from "./from-typhoon-analysis";
import { fromTyphoonProbabilityOutcome } from "./from-typhoon-probability";
import { fromFloodForecastOutcome } from "./from-flood-forecast";
import { fromRawOutcome } from "./from-raw";
import { assertNever } from "../../../utils/assert-never";

/** ProcessOutcome → PresentationEvent に変換する */
export function toPresentationEvent(outcome: ProcessOutcome): PresentationEvent {
  switch (outcome.domain) {
    case "eew":
      return fromEewOutcome(outcome);
    case "earthquake":
      return fromEarthquakeOutcome(outcome);
    case "seismicText":
      return fromSeismicTextOutcome(outcome);
    case "lgObservation":
      return fromLgObservationOutcome(outcome);
    case "tsunami":
      return fromTsunamiOutcome(outcome);
    case "volcano":
      return fromVolcanoOutcome(outcome);
    case "nankaiTrough":
      return fromNankaiTroughOutcome(outcome);
    case "weather":
      return fromWeatherOutcome(outcome);
    case "tornado":
      return fromTornadoOutcome(outcome);
    case "briefing":
      return fromBriefingOutcome(outcome);
    case "earlyWeather":
      return fromEarlyWeatherOutcome(outcome);
    case "weatherWarningTimeseries":
      return fromWeatherWarningTimeseriesOutcome(outcome);
    case "climateInfo":
      return fromClimateInfoOutcome(outcome);
    case "weatherExplanation":
      return fromWeatherExplanationOutcome(outcome);
    case "heatAlert":
      return fromHeatAlertOutcome(outcome);
    case "typhoonAnalysis":
      return fromTyphoonAnalysisOutcome(outcome);
    case "typhoonProbability":
      return fromTyphoonProbabilityOutcome(outcome);
    case "floodForecast":
      return fromFloodForecastOutcome(outcome);
    case "raw":
      return fromRawOutcome(outcome);
    default:
      // PresentationDomain に新メンバーが増えて case を足し忘れるとコンパイルエラー。
      return assertNever(outcome);
  }
}
