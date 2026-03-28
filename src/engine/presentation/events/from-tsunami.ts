import type { TsunamiOutcome, PresentationEvent, PresentationAreaItem } from "../types";

/** TsunamiOutcome → PresentationEvent */
export function fromTsunamiOutcome(outcome: TsunamiOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const forecastItems = info.forecast ?? [];
  const forecastAreaNames = forecastItems.map((f) => f.areaName);
  const tsunamiKinds = forecastItems.map((f) => f.kind);
  const areaItems: PresentationAreaItem[] = forecastItems.map((f) => ({
    name: f.areaName,
    kind: f.kind,
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

    warningComment: info.warningComment || null,

    tsunamiKinds,

    areaNames: [],
    forecastAreaNames,
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: forecastAreaNames.length,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,

    stateSnapshot: {
      kind: "tsunami",
      levelBefore: outcome.state.levelBefore,
      levelAfter: outcome.state.levelAfter,
      changed: outcome.state.changed,
    },

    raw: outcome.parsed,
  };
}
