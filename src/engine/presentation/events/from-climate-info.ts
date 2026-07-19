import type {
  ClimateInfoOutcome,
  PresentationEvent,
  PresentationAreaItem,
} from "../types";
import { joinBodyTexts } from "./join-body-sections";

/**
 * 「全国」予報区の Code (Body.TargetArea で出る最広域の値)。
 * [Codex R3 W2] climateInfo の TargetArea がこのコードのとき cluster region
 * として使うと、同月の異なる電文が `climate_info:<全国>:YYYY-MM` に潰れる。
 * そのため細分地域 (本文側の Areas) を優先する。
 */
const NATIONAL_AREA_CODE = "010000";

/** ClimateInfoOutcome → PresentationEvent */
export function fromClimateInfoOutcome(
  outcome: ClimateInfoOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // [Codex R3 W2] cluster region 解決のため、areaItems の先頭は
  // できるだけ「実質的に狭い対象地域」にしたい。TargetArea が「全国」の
  // ときは本文側細分 (例: 東日本/西日本) を先に積み、TargetArea は末尾に
  // 回す。それ以外 (例: 東日本のみが TargetArea) は TargetArea を先頭。
  const isNationalTarget = info.targetArea?.code === NATIONAL_AREA_CODE;
  const areaItems: PresentationAreaItem[] = [];
  if (info.targetArea && !isNationalTarget) {
    areaItems.push({
      name: info.targetArea.name,
      code: info.targetArea.code,
      kind: "対象地域",
    });
  }
  for (const bt of info.bodyTexts) {
    for (const a of bt.areas) {
      if (areaItems.some((ai) => ai.code === a.code)) continue;
      areaItems.push({
        name: a.name,
        code: a.code,
        kind: bt.textType ?? "本文",
      });
    }
  }
  // 全国 target は最後に追加 (cluster region 候補 = areaNames[0] にならないように)
  if (info.targetArea && isNationalTarget) {
    if (!areaItems.some((ai) => ai.code === info.targetArea!.code)) {
      areaItems.push({
        name: info.targetArea.name,
        code: info.targetArea.code,
        kind: "対象地域",
      });
    }
  }
  const areaNames = areaItems.map((a) => a.name);
  // [Codex R2 I1'] 同一観測点が期間別に複数回出る電文があり得るため、
  // stationCode (フォールバックで name) で重複排除する。
  // raw `info.stations` は表示・通知側に残し、PresentationEvent 用の
  // observation* フィールドのみ deduped を採用する。
  const observationSeen = new Set<string>();
  const observationNames: string[] = [];
  for (const s of info.stations) {
    const key = s.stationCode || s.stationName;
    if (!key || observationSeen.has(key)) continue;
    observationSeen.add(key);
    observationNames.push(s.stationName);
  }

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
    // 全般天候情報は災害警報ではないため isWarning は常に false
    isWarning: false,

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    bodyText: joinBodyTexts(info.bodyTexts),

    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames,
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: observationNames.length,
    areaItems,

    raw: info,
  };
}
