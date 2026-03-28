import type { LgObservationOutcome, PresentationEvent, PresentationAreaItem } from "../types";
import { intensityToRank } from "../../../utils/intensity";

/** LgObservationOutcome → PresentationEvent */
export function fromLgObservationOutcome(outcome: LgObservationOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const maxLgInt = info.maxLgInt ?? null;
  const maxLgIntRank = maxLgInt != null ? Number(maxLgInt) || null : null;

  const observations = info.areas ?? [];
  const observationNames = observations.map((o) => o.name);
  const areaItems: PresentationAreaItem[] = observations.map((o) => ({
    name: o.name,
    maxInt: o.maxInt,
    maxLgInt: o.maxLgInt,
  }));

  const maxInt = info.maxInt ?? null;
  const maxIntRank = maxInt != null ? intensityToRank(maxInt) : null;

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
    maxLgInt,
    maxLgIntRank,

    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames,
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: observationNames.length,
    areaItems,

    raw: outcome.parsed,
  };
}
