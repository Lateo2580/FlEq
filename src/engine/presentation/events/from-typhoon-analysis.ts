import type {
  TyphoonAnalysisOutcome,
  PresentationEvent,
} from "../types";
import { typhoonAnalysisToText } from "./typhoon-to-text";

/** TyphoonAnalysisOutcome → PresentationEvent */
export function fromTyphoonAnalysisOutcome(
  outcome: TyphoonAnalysisOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? info.infoType,
    title: xmlReport?.head.title ?? info.title,
    controlTitle: info.controlTitle,
    headline: info.headline,
    reportDateTime: xmlReport?.head.reportDateTime ?? info.reportDateTime,
    publishingOffice:
      xmlReport?.control.publishingOffice ?? info.publishingOffice,
    isTest: outcome.msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    isWarning: false,

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    // 構造化 frames[] から決定的に長文化 (原文全文でなく構造化情報の長文、spec §2-2)
    bodyText: typhoonAnalysisToText(info),

    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],

    raw: info,
  };
}
