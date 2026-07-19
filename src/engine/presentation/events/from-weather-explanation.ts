import type {
  WeatherExplanationOutcome,
  PresentationEvent,
  PresentationAreaItem,
} from "../types";
import { joinSections } from "./join-body-sections";

/**
 * 「全国」予報区の Code。
 * VPZJ51 の targetAreas にこのコードが含まれるとき、
 * 他の細分地域が存在する場合は末尾に回す (全国降格)。
 * from-climate-info.ts の NATIONAL_AREA_CODE と同じ値を踏襲。
 */
const NATIONAL_AREA_CODE = "010000";

/**
 * WeatherExplanationOutcome → PresentationEvent
 *
 * VPCJ51/VPZJ51 の TargetArea は Headline.Information.Item.Areas
 * から取得する (parser 側で `targetAreas` に集約済)。
 *
 * 全国降格: targetAreas に「全国」(code=010000) と細分地域が混在するとき、
 * cluster region 候補 (areaNames[0]) が全国にならないよう全国を末尾に回す。
 * 全国単独のときはそのまま先頭に置く。
 */
export function fromWeatherExplanationOutcome(
  outcome: WeatherExplanationOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // 全国降格: 全国以外を先に積み、全国は末尾に追加
  const nationals: PresentationAreaItem[] = [];
  const others: PresentationAreaItem[] = [];
  for (const a of info.targetAreas) {
    if (others.some((ai) => ai.code === a.code)) continue;
    if (nationals.some((ai) => ai.code === a.code)) continue;
    if (a.code === NATIONAL_AREA_CODE) {
      nationals.push({ name: a.name, code: a.code, kind: "対象地域" });
    } else {
      others.push({ name: a.name, code: a.code, kind: "対象地域" });
    }
  }
  // 細分地域が存在する場合は全国を末尾へ (全国降格)、なければ全国のまま
  const areaItems: PresentationAreaItem[] =
    others.length > 0 ? [...others, ...nationals] : nationals;

  const areaNames = areaItems.map((a) => a.name);

  // observation.series.stations から地点名一覧を生成 (VPCJ51/VPZJ51 は空配列)
  const observationNames: string[] = [];
  for (const s of info.observation?.series ?? []) {
    for (const st of s.stations) {
      if (st.stationName && !observationNames.includes(st.stationName)) {
        observationNames.push(st.stationName);
      }
    }
  }
  // 潮位観測点 (VMCJ53-55 の tidal)。既存 observation.series 由来と合わせて重複排除
  for (const entry of [
    ...(info.tidal?.observations ?? []),
    ...(info.tidal?.forecasts ?? []),
  ]) {
    if (entry.stationName && !observationNames.includes(entry.stationName)) {
      observationNames.push(entry.stationName);
    }
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
    // 地方気象解説情報/全般気象解説情報は災害警報ではないため isWarning は常に false
    isWarning: false,

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    bodyText: joinSections(info.sections),

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
