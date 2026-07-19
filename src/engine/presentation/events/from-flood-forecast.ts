import type {
  FloodForecastOutcome,
  PresentationEvent,
} from "../types";
import type { PresentationAreaItem } from "../types";

/**
 * FloodForecastOutcome → PresentationEvent 本実装 (§17.1 field-by-field 規約)。
 *
 * 注意: aggregateByRiver は **呼ばない**。formatter 内呼出が正
 * (spec §4 / §7、plan v2 冒頭の重要注記)。ここでは station 軸でそのまま展開する。
 *
 * §17.1 規約のとおり:
 *   - `headline`  = `headlines.find(scope==="河川")?.headlineText`
 *                   → なければ `headlines[0]?.headlineText`
 *                   → なければ `headTitle`
 *   - `areaNames` = `rawStations.map(s => s.stationName)` (VXSU stub では空配列)
 *   - `areaItems` = `rawStations.map(s => ({name, code, flags: [headlineLevel, stationObservedLevel]}))`
 *   - `raw`       = `outcome.parsed` (source parsed result)
 *
 * frameLevel / soundLevel / notifyCategory は outcome.presentation から引く
 * (resolveFloodForecastLevels は processor で適用済み)。
 */
export function fromFloodForecastOutcome(
  outcome: FloodForecastOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // headline 代表決定 (§17.1 + VXSU の Phase 1 stub):
  //  - VXKO (vxko50): scope=河川 の headlineText、なければ headTitle
  //    (府県予報区等 等 河川以外 scope は採用しない — 河川名を含むはずだから)
  //  - VXSU (vxsu50): headlines[0]?.headlineText、なければ headTitle
  //    (発表区間 scope 等が来るため scope=河川 で絞らない)
  const headline = info.schema === "vxsu50"
    ? (info.headlines[0]?.headlineText ?? info.headTitle)
    : (info.headlines.find(h => h.scope === "河川")?.headlineText ?? info.headTitle);

  // 地域集約: station 軸でそのまま展開 (aggregateByRiver は formatter 内呼出)
  const areaNames = info.rawStations.map(s => s.stationName);
  const areaItems: PresentationAreaItem[] = info.rawStations.map(s => ({
    name: s.stationName,
    code: s.stationCode,
    flags: [s.headlineLevel, s.stationObservedLevel],
  }));

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? info.infoType,
    title: xmlReport?.head.title ?? info.headTitle,
    controlTitle: info.controlTitle,
    headline,
    reportDateTime: xmlReport?.head.reportDateTime ?? info.reportDateTime,
    publishingOffice:
      xmlReport?.control.publishingOffice ?? info.publishingOffice,
    isTest: outcome.msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    // frameLevel が warning/critical のものは isWarning=true に統一
    // (L3/L4/L5 洪水が field-registry の isWarning filter から漏れないよう、
    //  from-heat-alert / from-tornado / from-briefing と同型に揃える)
    isWarning:
      outcome.presentation.frameLevel === "warning" ||
      outcome.presentation.frameLevel === "critical",

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial != null ? String(info.serial) : null,

    bodyText: null,

    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,

    raw: info,
  };
}
