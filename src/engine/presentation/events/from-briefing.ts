import type { BriefingOutcome, PresentationEvent, PresentationAreaItem } from "../types";

/** BriefingOutcome → PresentationEvent */
export function fromBriefingOutcome(outcome: BriefingOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // targetAreas (情報タグの対象地域) を areaNames に
  const areaNames = info.targetAreas.map((a) => a.name);
  const areaItems: PresentationAreaItem[] = info.targetAreas.map((a) => ({
    name: a.name,
    code: a.code,
    kind: info.briefingCondition || "気象防災速報",
  }));

  // observations 由来の地点名を observationNames に
  const observationNames = info.observations
    .map((o) => o.locationName)
    .filter((n): n is string => n != null && n !== "");

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? info.infoType,
    title: xmlReport?.head.title ?? info.title,
    headline: info.headline,
    reportDateTime: xmlReport?.head.reportDateTime ?? info.reportDateTime,
    publishingOffice: xmlReport?.control.publishingOffice ?? info.publishingOffice,
    isTest: outcome.msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    // frameLevel が warning/critical のものは isWarning=true に統一
    // (shortSnow が isWarning=false になって filter/template から漏れるのを防ぐ)
    isWarning:
      outcome.presentation.frameLevel === "warning" ||
      outcome.presentation.frameLevel === "critical",

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames,
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: observationNames.length,
    areaItems,

    raw: info,
  };
}
