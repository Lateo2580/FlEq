import type { TornadoOutcome, PresentationEvent, PresentationAreaItem } from "../types";
import { presentationTelegramMeta } from "./presentation-meta";
import { selectPreferredTornadoLayer } from "../../../dmdata/tornado-parser";
import { projectTornadoDisplay } from "./tornado-display";

/** TornadoOutcome → PresentationEvent */
export function fromTornadoOutcome(outcome: TornadoOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const preferred = selectPreferredTornadoLayer(info.layers);
  const areaNames = preferred ? preferred.areas.map((a) => a.name) : [];
  const tornadoDisplay = projectTornadoDisplay(outcome.msg, info.layers, preferred);

  // 目撃情報地域は地方単位 (例: "東京地方")、preferred は市町村単位なので階層が異なる。
  // 直接 areaItems に flag を立てることはせず、目撃情報の有無は raw.hasSightingAreas /
  // raw.sightingAreas を経由して downstream (notifier/formatter/summary) が参照する。
  const areaItems: PresentationAreaItem[] = preferred
    ? preferred.areas.map((a) => ({
        name: a.name,
        code: a.code,
        kind: "竜巻注意情報",
      }))
    : [];

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
    isTest: presentationTelegramMeta(outcome.msg).isTest,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    // frameLevel が warning/critical のものは isWarning=true に統一
    // (目撃電文で地域抽出に失敗したフェイルセーフ時に activeAreaCount=0 でも
    //  displaySeverity=nonLevelSpecial → critical へ昇格しているため、
    //  event 出口で安全側昇格が潰れるのを防ぐ)
    isWarning:
      outcome.presentation.frameLevel === "warning" ||
      outcome.presentation.frameLevel === "critical",

    eventId: xmlReport?.head.eventId ?? null,
    serial: info.serial,

    // 目撃情報地域は areaItems.flags で表現。municipalityNames は使わない
    // (実データでは「東京地方」のような非市町村単位の地域名のため意味的にミスマッチ)。
    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,
    tornadoDisplay,

    raw: info,
  };
}
