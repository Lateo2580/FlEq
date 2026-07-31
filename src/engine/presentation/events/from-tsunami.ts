import type { TsunamiOutcome, PresentationEvent, PresentationAreaItem } from "../types";
import { presentationTelegramMeta } from "./presentation-meta";
import { buildTsunamiObservations } from "./tsunami-observations";

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
    maxHeightDescription: f.maxHeightDescription || undefined,
    firstHeight: f.firstHeight || undefined,
  }));
  const presentationGroups = outcome.state.presentationObservationGroups == null
    ? null
    : {
        VTSE51: buildTsunamiObservations({
          ...info,
          observations: outcome.state.presentationObservationGroups.VTSE51,
        }),
        VTSE52: buildTsunamiObservations({
          ...info,
          observations: outcome.state.presentationObservationGroups.VTSE52,
        }),
      };

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
    isTest: presentationTelegramMeta(outcome.msg).isTest,

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
    tsunamiObservations: presentationGroups == null
      ? buildTsunamiObservations(info)
      : [...presentationGroups.VTSE51, ...presentationGroups.VTSE52],
    ...(presentationGroups == null ? {} : { tsunamiObservationGroups: presentationGroups }),

    stateSnapshot: {
      kind: "tsunami",
      levelBefore: outcome.state.levelBefore,
      levelAfter: outcome.state.levelAfter,
      changed: outcome.state.changed,
    },

    raw: outcome.parsed,
  };
}
