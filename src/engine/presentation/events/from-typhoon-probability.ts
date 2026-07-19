import type {
  TyphoonProbabilityOutcome,
  PresentationEvent,
} from "../types";
import { aggregateByPrefecture } from "../typhoon-probability-aggregate";
import { typhoonProbabilityToText } from "./typhoon-to-text";

/** TyphoonProbabilityOutcome → PresentationEvent */
export function fromTyphoonProbabilityOutcome(
  outcome: TyphoonProbabilityOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // 府県ごとに集計して最大 daily[4] 降順で並べる
  const prefAggregates = aggregateByPrefecture(info.regions);
  const activePrefs = prefAggregates.filter(p => p.maxDaily5 > 0);

  const areaNames = activePrefs.map(p => p.prefName);
  const areaCount = activePrefs.length;
  const areaItems = activePrefs.map(p => ({
    name: p.prefName,
    code: p.prefCode,
    flags: [`${p.maxDaily5}%`],
  }));

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? info.infoType,
    title: xmlReport?.head.title ?? info.title,
    controlTitle: info.controlTitle,
    headline: null,
    reportDateTime: xmlReport?.head.reportDateTime ?? (info.reportDateTime ?? ""),
    publishingOffice:
      xmlReport?.control.publishingOffice ?? (info.publishingOffice ?? ""),
    isTest: outcome.msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    isWarning: false,

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    typhoonProbabilityMaxDaily5: outcome.presentation.typhoonProbabilityMaxDaily5,

    // active 府県の確率・ピーク時刻から決定的に長文化 (spec §2-2)
    bodyText: typhoonProbabilityToText(info),

    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,

    raw: info,
  };
}
