import type {
  EarthquakeOutcome,
  PresentationEvent,
  PresentationAreaItem,
  PresentationQuakeIntensityItem,
} from "../types";
import { intensityToRank } from "../../../utils/intensity";
import * as log from "../../../logger";

interface QuakeIntensitySourceItem {
  name: string;
  code: string | null;
  intensity: string;
  lgIntensity?: string;
}

function aggregateQuakeIntensity(
  items: QuakeIntensitySourceItem[],
  level: "Area" | "City",
): PresentationQuakeIntensityItem[] {
  const result: PresentationQuakeIntensityItem[] = [];
  const indexByCode = new Map<string, number>();
  for (const item of items) {
    if (item.code == null) continue;
    const candidate: PresentationQuakeIntensityItem = {
      name: item.name,
      code: item.code,
      maxInt: item.intensity,
      maxIntRank: intensityToRank(item.intensity),
      ...(item.lgIntensity != null ? { maxLgInt: item.lgIntensity } : {}),
    };
    const existingIndex = indexByCode.get(item.code);
    if (existingIndex == null) {
      indexByCode.set(item.code, result.length);
      result.push(candidate);
      continue;
    }
    const existing = result[existingIndex];
    if (existing.maxInt.replace(/\s+/g, "") === item.intensity.replace(/\s+/g, "")) {
      continue;
    }
    log.warn(
      `VXSE ${level}.Code 重複: code=${item.code} `
      + `intensity=${JSON.stringify(existing.maxInt)}/${JSON.stringify(item.intensity)} `
      + `— 最大震度rankを採用`,
    );
    if (candidate.maxIntRank > existing.maxIntRank) {
      result[existingIndex] = candidate;
    }
  }
  return result;
}

/**
 * 地震情報の津波コメント文字列から「津波」表示フラグを判定する (Phase A #2)。
 * text が無い・空文字・空白のみ、または「心配はありません」を含む場合は false。
 * それ以外 (津波警報・注意報等への言及) は true とみなす安全側判定。
 */
export function resolveEarthquakeTsunamiWarning(text: string | null | undefined): boolean {
  if (text == null || text.trim() === "") return false;
  return !text.includes("心配はありません");
}

/** EarthquakeOutcome → PresentationEvent */
export function fromEarthquakeOutcome(outcome: EarthquakeOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const maxInt = info.intensity?.maxInt ?? null;
  const maxIntRank = maxInt != null ? intensityToRank(maxInt) : null;

  const areas = info.intensity?.areas ?? [];
  const municipalities = info.intensity?.municipalities ?? [];
  const areaNames = areas.map((a) => a.name);
  const municipalityNames = municipalities.map((municipality) => municipality.name);
  const areaItems: PresentationAreaItem[] = areas.map((a) => ({
    name: a.name,
    ...(a.code != null ? { code: a.code } : {}),
    maxInt: a.intensity,
    ...(a.lgIntensity != null ? { maxLgInt: a.lgIntensity } : {}),
  }));
  const quakeIntensity =
    info.infoType !== "取消"
    && info.intensity != null
    && intensityToRank(info.intensity.maxInt) >= 3
    ? {
        localAreas: aggregateQuakeIntensity(areas, "Area"),
        municipalities: aggregateQuakeIntensity(municipalities, "City"),
      }
    : undefined;

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

    originTime: info.earthquake?.originTime ?? null,
    hypocenterName: info.earthquake?.hypocenterName ?? null,
    latitude: info.earthquake?.latitude ?? null,
    longitude: info.earthquake?.longitude ?? null,
    depth: info.earthquake?.depth ?? null,
    magnitude: info.earthquake?.magnitude ?? null,

    maxInt,
    maxIntRank,
    maxLgInt: info.intensity?.maxLgInt ?? null,
    tsunamiWarning: resolveEarthquakeTsunamiWarning(info.tsunami?.text),

    areaNames,
    forecastAreaNames: [],
    municipalityNames,
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: municipalityNames.length,
    observationCount: 0,
    areaItems,
    ...(quakeIntensity != null ? { quakeIntensity } : {}),

    raw: outcome.parsed,
  };
}
