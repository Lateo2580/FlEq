import type { NankaiTroughOutcome, PresentationEvent } from "../types";

/** NankaiTroughOutcome → PresentationEvent */
export function fromNankaiTroughOutcome(outcome: NankaiTroughOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

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

    infoSerialCode: info.infoSerial?.code ?? null,
    bodyText: info.bodyText,
    nextAdvisory: info.nextAdvisory ?? null,

    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],

    raw: outcome.parsed,
  };
}
