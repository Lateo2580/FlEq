import type {
  WeatherWarningTimeseriesOutcome,
  PresentationEvent,
  PresentationAreaItem,
} from "../types";

/** WeatherWarningTimeseriesOutcome → PresentationEvent */
export function fromWeatherWarningTimeseriesOutcome(
  outcome: WeatherWarningTimeseriesOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // 対象地域 (TargetArea) を先頭、各 Area を続けて積む
  const areaItems: PresentationAreaItem[] = [];
  if (info.targetArea) {
    areaItems.push({
      name: info.targetArea.name,
      code: info.targetArea.code,
      kind: "対象地域",
    });
  }
  for (const a of info.areas) {
    if (areaItems.some((ai) => ai.code === a.code)) continue;
    areaItems.push({ name: a.name, code: a.code, kind: "市町村" });
  }
  const areaNames = areaItems.map((a) => a.name);
  const municipalityNames = info.areas.map((a) => a.name);

  // 警報級以上なら isWarning=true (frame critical/warning)
  const isWarning =
    outcome.presentation.frameLevel === "critical" ||
    outcome.presentation.frameLevel === "warning";

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? info.infoType,
    title: xmlReport?.head.title ?? info.title,
    headline: info.headline,
    reportDateTime: xmlReport?.head.reportDateTime ?? info.reportDateTime,
    publishingOffice:
      xmlReport?.control.publishingOffice ?? info.publishingOffice,
    isTest: outcome.msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    isWarning,

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    areaNames,
    forecastAreaNames: [],
    municipalityNames,
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: municipalityNames.length,
    observationCount: 0,
    areaItems,

    raw: info,
  };
}
