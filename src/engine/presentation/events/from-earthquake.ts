import type { EarthquakeOutcome, PresentationEvent, PresentationAreaItem } from "../types";
import { intensityToRank } from "../../../utils/intensity";

/** EarthquakeOutcome → PresentationEvent */
export function fromEarthquakeOutcome(outcome: EarthquakeOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const maxInt = info.intensity?.maxInt ?? null;
  const maxIntRank = maxInt != null ? intensityToRank(maxInt) : null;

  const areas = info.intensity?.areas ?? [];
  const areaNames = areas.map((a) => a.name);
  const areaItems: PresentationAreaItem[] = areas.map((a) => ({
    name: a.name,
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

    eventId: xmlReport?.head.eventId ?? null,
    serial: xmlReport?.head.serial ?? null,

    originTime: info.earthquake?.originTime ?? null,
    hypocenterName: info.earthquake?.hypocenterName ?? null,
    latitude: info.earthquake?.latitude ?? null,
    longitude: info.earthquake?.longitude ?? null,
    depth: info.earthquake?.depth ?? null,
    magnitude: info.earthquake?.magnitude ?? null,

    maxInt,
    maxIntRank,

    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,

    raw: outcome.parsed,
  };
}
