import type { EewOutcome, PresentationEvent, PresentationAreaItem } from "../types";
import { intensityToRank } from "../../../utils/intensity";

/** EewOutcome → PresentationEvent */
export function fromEewOutcome(outcome: EewOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // 予測地域から最大予測震度を算出
  const forecastAreas = info.forecastIntensity?.areas ?? [];
  let forecastMaxInt: string | null = null;
  let forecastMaxIntRank: number | null = null;

  for (const area of forecastAreas) {
    const rank = intensityToRank(area.intensity);
    if (forecastMaxIntRank == null || rank > forecastMaxIntRank) {
      forecastMaxIntRank = rank;
      forecastMaxInt = area.intensity;
    }
  }

  const areaNames = forecastAreas.map((a) => a.name);
  const areaItems: PresentationAreaItem[] = forecastAreas.map((a) => ({
    name: a.name,
    kind: "forecast",
    maxInt: a.intensity,
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
    isTest: outcome.msg.head.test,

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
    latitude: info.earthquake?.latitude ?? null,
    longitude: info.earthquake?.longitude ?? null,
    depth: info.earthquake?.depth ?? null,
    magnitude: info.earthquake?.magnitude ?? null,

    forecastMaxInt: forecastMaxInt,
    forecastMaxIntRank: forecastMaxIntRank,

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
