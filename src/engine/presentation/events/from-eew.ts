import type { EewOutcome, PresentationEvent, PresentationAreaItem, PresentationEewRegion } from "../types";
import { presentationTelegramMeta } from "./presentation-meta";
import { magnitudeForPresentation } from "../../../utils/magnitude";
import {
  eewAreaHasArrived,
  eewAreaIsPlum,
  eewForecastAreaSpecialValue,
  getMaxForecastIntensityEvaluation,
} from "../../eew/eew-tracker";
import { formatLgIntensitySpecialValue } from "../level-helpers";

/** EewOutcome → PresentationEvent */
export function fromEewOutcome(outcome: EewOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const forecastAreas = info.forecastIntensity?.areas ?? [];
  const currentForecast = outcome.eewResult.currentForecastIntensity
    ?? getMaxForecastIntensityEvaluation(info.forecastIntensity);

  const areaNames = forecastAreas.map((a) => a.name);
  const areaItems: PresentationAreaItem[] = forecastAreas.map((a) => ({
    name: a.name,
    kind: "forecast",
    maxIntValue: eewForecastAreaSpecialValue(a),
    maxInt: a.intensity,
    ...(a.lgIntensityValue != null ? { maxLgIntValue: a.lgIntensityValue } : {}),
    ...(a.lgIntensity != null ? { maxLgInt: a.lgIntensity } : {}),
  }));
  const eewRegions: PresentationEewRegion[] = forecastAreas.map((a) => ({
    name: a.name,
    intensity: a.intensity,
    intensityTo: a.intensityTo ?? null,
    isPlum: eewAreaIsPlum(a),
    hasArrived: eewAreaHasArrived(a),
    arrivalTime: a.arrivalTime ?? null,
  }));

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? "不明",
    title: xmlReport?.head.title ?? outcome.headType,
    headline: xmlReport?.head.headline ?? null,
    reportDateTime: xmlReport?.head.reportDateTime ?? outcome.msg.head.time,
    publishingOffice: xmlReport?.control.publishingOffice ?? outcome.msg.head.author,
    isTest: presentationTelegramMeta(outcome.msg).isTest,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",

    eventId: info.eventId ?? xmlReport?.head.eventId ?? null,
    serial: info.serial ?? xmlReport?.head.serial ?? null,

    isWarning: info.isWarning,
    isFinal: info.nextAdvisory != null,
    isAssumedHypocenter: info.isAssumedHypocenter,

    hypocenterName: info.earthquake?.hypocenterName ?? null,
    originTime: info.earthquake?.originTime ?? null,
    latitude: info.earthquake?.latitude ?? null,
    longitude: info.earthquake?.longitude ?? null,
    depth: info.earthquake?.depth ?? null,
    magnitude: magnitudeForPresentation(info.earthquake),

    ...(info.forecastIntensity?.maxIntValue != null
      ? { maxIntValue: info.forecastIntensity.maxIntValue }
      : currentForecast?.specialValue != null
        ? { maxIntValue: currentForecast.specialValue }
        : {}),
    // label/SpecialValue は今回 snapshot、rank だけは unknown による安全状態降格を防ぐ。
    forecastMaxInt: currentForecast?.summaryLabel ?? null,
    forecastMaxIntRank: outcome.eewResult.effectiveForecastSafetyRank
      ?? currentForecast?.safetyRank
      ?? null,
    ...(outcome.eewResult.displayRestoreRevision != null
      ? { eewDisplayRestoreRevision: outcome.eewResult.displayRestoreRevision }
      : {}),
    ...(info.forecastIntensity?.maxLgIntValue != null
      ? { maxLgIntValue: info.forecastIntensity.maxLgIntValue }
      : {}),
    maxLgIntLabel: formatLgIntensitySpecialValue(
      info.forecastIntensity?.maxLgIntValue,
      info.forecastIntensity?.maxLgInt,
      "ticker",
    ),
    maxLgInt: info.forecastIntensity?.maxLgInt ?? null,

    nextAdvisory: info.nextAdvisory ?? null,

    areaNames,
    forecastAreaNames: areaNames,
    municipalityNames: [],
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: areaNames.length,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,
    eewRegions,

    stateSnapshot: {
      kind: "eew",
      activeCount: outcome.state.activeCount,
      colorIndex: outcome.state.colorIndex,
      isCancelled: outcome.state.isCancelled,
      diff: outcome.state.diff,
    },

    raw: outcome.parsed,
  };
}
