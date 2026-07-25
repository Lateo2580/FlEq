import type { WeatherOutcome, PresentationEvent, PresentationAreaItem } from "../types";
import { selectPreferredWeatherLayer } from "../../../dmdata/weather-parser";

/** WeatherOutcome → PresentationEvent */
export function fromWeatherOutcome(outcome: WeatherOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // 最も粒度の細かい階層を集計の代表として使う
  const preferred = selectPreferredWeatherLayer(info.layers);

  const areaNames = preferred ? preferred.items.map((i) => i.areaName) : [];
  const areaItems: PresentationAreaItem[] = preferred
    ? preferred.items.map((i) => ({
        name: i.areaName,
        code: i.areaCode,
        // 同一 Area に複数 Kind がある場合は最高重大度の Kind 名を kind として表示用に採用
        kind: i.kinds.map((k) => k.name).join(" / "),
      }))
    : [];

  // 警報以上を持つ地域はサブセットとして municipalityNames、注意報のみは forecastAreaNames に格納
  // (PresentationEvent の既存フィールドを流用するため意味合いはやや異なるが、filter/template 用)
  const warningAreas: string[] = [];
  const advisoryAreas: string[] = [];
  if (preferred) {
    for (const item of preferred.items) {
      const hasWarning = item.kinds.some(
        (k) => k.severity === "specialWarning" || k.severity === "warning",
      );
      const hasAdvisory = item.kinds.some((k) => k.severity === "advisory");
      if (hasWarning) warningAreas.push(item.areaName);
      else if (hasAdvisory) advisoryAreas.push(item.areaName);
    }
  }

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
    isTest: outcome.msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,
    displaySeverity: outcome.presentation.displaySeverity ?? null,
    // weatherDiff を持たない経路 (VPWW55-61 / state holder 未注入) は confirmed 扱い
    weatherConfidence: outcome.presentation.weatherDiff?.confidence ?? "confirmed",

    isCancellation: info.infoType === "取消",
    isWarning:
      info.maxSeverity === "warning" || info.maxSeverity === "specialWarning",

    eventId: xmlReport?.head.eventId ?? null,
    serial: xmlReport?.head.serial ?? null,

    warningComment: info.comments.map((c) => c.text).join("\n") || null,

    areaNames,
    forecastAreaNames: advisoryAreas,
    municipalityNames: warningAreas,
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: advisoryAreas.length,
    municipalityCount: warningAreas.length,
    observationCount: 0,
    areaItems,

    raw: info,
  };
}
