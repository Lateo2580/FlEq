import type {
  VolcanoOutcome,
  VolcanoBatchOutcome,
  PresentationEvent,
} from "../types";

/** VolcanoOutcome | VolcanoBatchOutcome → PresentationEvent */
export function fromVolcanoOutcome(outcome: VolcanoOutcome | VolcanoBatchOutcome): PresentationEvent {
  if ("isBatch" in outcome && outcome.isBatch) {
    return fromVolcanoBatchOutcome(outcome);
  }
  return fromSingleVolcanoOutcome(outcome as VolcanoOutcome);
}

function fromSingleVolcanoOutcome(outcome: VolcanoOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const alertLevel = info.kind === "alert" ? info.alertLevel : null;

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
    isRenotification: outcome.state.isRenotification,

    eventId: xmlReport?.head.eventId ?? null,
    serial: xmlReport?.head.serial ?? null,

    volcanoCode: info.volcanoCode,
    volcanoName: info.volcanoName,
    alertLevel,

    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],

    stateSnapshot: {
      kind: "volcano",
      isRenotification: outcome.state.isRenotification,
    },

    raw: outcome.parsed,
  };
}

function fromVolcanoBatchOutcome(outcome: VolcanoBatchOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const firstItem = outcome.parsed[0];
  const volcanoName = firstItem?.volcanoName ?? null;
  const volcanoCode = firstItem?.volcanoCode ?? null;

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,
    subType: "ashfallBatch",

    infoType: xmlReport?.head.infoType ?? "不明",
    title: xmlReport?.head.title ?? outcome.headType,
    headline: xmlReport?.head.headline ?? null,
    reportDateTime: outcome.batchReportDateTime,
    publishingOffice: xmlReport?.control.publishingOffice ?? outcome.msg.head.author,
    isTest: outcome.batchIsTest,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: false,

    eventId: xmlReport?.head.eventId ?? null,
    serial: xmlReport?.head.serial ?? null,

    volcanoCode,
    volcanoName,

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
