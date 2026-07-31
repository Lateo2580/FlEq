import type {
  EarlyWeatherOutcome,
  PresentationEvent,
  PresentationAreaItem,
} from "../types";
import { presentationTelegramMeta } from "./presentation-meta";

/** EarlyWeatherOutcome → PresentationEvent */
export function fromEarlyWeatherOutcome(
  outcome: EarlyWeatherOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // 対象地域は TargetArea が中心 (1 件)。
  // phenomena の areas (細分等) も areaItems に積む。
  const areaItems: PresentationAreaItem[] = [];
  if (info.targetArea) {
    areaItems.push({
      name: info.targetArea.name,
      code: info.targetArea.code,
      kind: "対象地域",
    });
  }
  for (const p of info.phenomena) {
    for (const a of p.areas) {
      if (areaItems.some((ai) => ai.code === a.code)) continue;
      areaItems.push({ name: a.name, code: a.code, kind: p.type });
    }
  }
  const areaNames = areaItems.map((a) => a.name);

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
    isTest: presentationTelegramMeta(outcome.msg).isTest,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    // 早期天候情報は災害警報ではないため isWarning は常に false
    isWarning: false,

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,

    raw: info,
  };
}
