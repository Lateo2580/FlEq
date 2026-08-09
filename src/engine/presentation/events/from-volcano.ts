import type {
  VolcanoOutcome,
  VolcanoBatchOutcome,
  PresentationEvent,
} from "../types";
import { presentationTelegramMeta } from "./presentation-meta";
import { joinVolcanoBatch, joinVolcanoAshfallBatch } from "./join-body-sections";
import { volcanoAshfallToText } from "./volcano-to-text";

/** VolcanoOutcome | VolcanoBatchOutcome → PresentationEvent */
export function fromVolcanoOutcome(outcome: VolcanoOutcome | VolcanoBatchOutcome): PresentationEvent {
  if ("isBatch" in outcome && outcome.isBatch) {
    return fromVolcanoBatchOutcome(outcome);
  }
  return fromSingleVolcanoOutcome(outcome as VolcanoOutcome);
}

/** VFVO53 バッチを display テロップ用に火山ごとの単発相当イベントへ展開する (spec T3)。
 *  CLI 用のバッチイベント (fromVolcanoBatchOutcome) は従来どおり 1 件のまま、display 経路だけが使う。 */
export function expandVolcanoBatchForDisplay(outcome: VolcanoBatchOutcome): PresentationEvent[] {
  return outcome.sources.map(({ info, msg }) => {
    const xmlReport = msg.xmlReport;
    return {
      id: msg.id,
      classification: msg.classification,
      domain: "volcano",
      type: outcome.headType,
      infoType: xmlReport?.head.infoType ?? "不明",
      title: xmlReport?.head.title ?? outcome.headType,
      headline: info.headline ?? xmlReport?.head.headline ?? null,
      reportDateTime: xmlReport?.head.reportDateTime ?? msg.head.time,
      publishingOffice: xmlReport?.control.publishingOffice ?? msg.head.author,
      isTest: presentationTelegramMeta(msg).isTest,
      frameLevel: outcome.presentation.frameLevel,
      soundLevel: outcome.presentation.soundLevel,
      notifyCategory: outcome.presentation.notifyCategory,
      isCancellation: false,
      eventId: xmlReport?.head.eventId ?? null,
      serial: xmlReport?.head.serial ?? null,
      volcanoCode: info.volcanoCode,
      volcanoName: info.volcanoName,
      alertLevel: null,
      bodyText: volcanoAshfallToText(info) ?? info.bodyText,
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
  });
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
    headline: info.headline ?? xmlReport?.head.headline ?? null,
    reportDateTime: info.reportDateTime,
    publishingOffice: xmlReport?.control.publishingOffice ?? outcome.msg.head.author,
    isTest: presentationTelegramMeta(outcome.msg).isTest,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,
    volcanoStateMutationAccepted: outcome.presentation.volcanoStateMutationAccepted,
    volcanoAcceptedSubjects: outcome.presentation.volcanoAcceptedSubjects == null
      ? undefined
      : [...outcome.presentation.volcanoAcceptedSubjects],
    volcanoActiveAlertSubjects: outcome.presentation.volcanoActiveAlertSubjects == null
      ? undefined
      : [...outcome.presentation.volcanoActiveAlertSubjects],
    volcanoActiveEruptionSubjects: outcome.presentation.volcanoActiveEruptionSubjects == null
      ? undefined
      : [...outcome.presentation.volcanoActiveEruptionSubjects],

    isCancellation: info.infoType === "取消",
    isRenotification: outcome.state.isRenotification,

    eventId: info.meta.eventId.value,
    serial: info.meta.serial.raw,

    volcanoCode: info.volcanoCode,
    volcanoName: info.volcanoName,
    alertLevel,
    ...(info.plumeHeightAboveCraterValue == null
      ? {}
      : { plumeHeightAboveCraterValue: info.plumeHeightAboveCraterValue }),
    ...(info.plumeHeightAboveSeaLevelValue == null
      ? {}
      : { plumeHeightAboveSeaLevelValue: info.plumeHeightAboveSeaLevelValue }),

    bodyText: info.kind === "ashfall" ? (volcanoAshfallToText(info) ?? info.bodyText) : info.bodyText,

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
    headline: firstItem?.headline ?? xmlReport?.head.headline ?? null,
    reportDateTime: outcome.batchReportDateTime,
    publishingOffice: xmlReport?.control.publishingOffice ?? outcome.msg.head.author,
    isTest: presentationTelegramMeta(outcome.msg).isTest,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: false,

    eventId: xmlReport?.head.eventId ?? null,
    serial: xmlReport?.head.serial ?? null,

    volcanoCode,
    volcanoName,

    bodyText: joinVolcanoAshfallBatch(outcome.parsed),

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
