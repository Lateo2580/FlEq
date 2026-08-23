import type {
  EarthquakeOutcome,
  PresentationEvent,
  PresentationAreaItem,
  PresentationQuakeIntensityItem,
} from "../types";
import type { JmaIntensity, JmaLgIntensity, SpecialValue } from "../../../types";
import { presentationTelegramMeta } from "./presentation-meta";
import { intensityToRank } from "../../../utils/intensity";
import { magnitudeForPresentation } from "../../../utils/magnitude";
import {
  formatIntensitySpecialValue,
  formatLgIntensitySpecialValue,
} from "../level-helpers";
import * as log from "../../../logger";

interface QuakeIntensitySourceItem {
  name: string;
  code: string | null;
  intensityValue?: SpecialValue<JmaIntensity>;
  intensity: string;
  lgIntensityValue?: SpecialValue<JmaLgIntensity>;
  lgIntensity?: string;
}

function missingSpecialValue<T>(): SpecialValue<T> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
  };
}

function legacyIntensityValue(
  scalar: string | undefined,
  carrierPresent: boolean,
): SpecialValue<JmaIntensity> {
  if (!carrierPresent) return missingSpecialValue();
  const raw = scalar ?? "";
  const normalized = raw.replace(/\s+/g, "");
  if (/^(?:0|1|2|3|4|5-|5\+|6-|6\+|7)$/.test(normalized)) {
    return {
      raw,
      value: normalized as JmaIntensity,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  return {
    raw,
    value: null,
    condition: null,
    description: null,
    presence: raw.trim() === "" ? "empty" : "qualitative",
  };
}

function legacyLgIntensityValue(
  scalar: string | undefined,
  carrierPresent: boolean,
): SpecialValue<JmaLgIntensity> {
  if (!carrierPresent) return missingSpecialValue();
  const raw = scalar ?? "";
  const normalized = raw.replace(/\s+/g, "");
  if (/^(?:0|1|2|3|4)$/.test(normalized)) {
    return {
      raw,
      value: normalized as JmaLgIntensity,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  return {
    raw,
    value: null,
    condition: null,
    description: null,
    presence: raw.trim() === "" ? "empty" : "qualitative",
  };
}

function exactSpecialScalar<T extends string>(value: SpecialValue<T>): T | null {
  return value.presence === "value" ? value.value : null;
}

function aggregateQuakeIntensity(
  items: QuakeIntensitySourceItem[],
  level: "Area" | "City",
): PresentationQuakeIntensityItem[] {
  const result: PresentationQuakeIntensityItem[] = [];
  const indexByCode = new Map<string, number>();
  for (const item of items) {
    if (item.code == null) continue;
    const maxIntValue = item.intensityValue ?? legacyIntensityValue(item.intensity, true);
    const maxInt = exactSpecialScalar(maxIntValue);
    if (maxInt == null) continue;
    const maxLgIntValue = item.lgIntensityValue
      ?? legacyLgIntensityValue(item.lgIntensity, item.lgIntensity != null);
    const maxLgInt = exactSpecialScalar(maxLgIntValue);
    const candidate: PresentationQuakeIntensityItem = {
      name: item.name,
      code: item.code,
      maxIntValue,
      maxInt,
      maxIntRank: intensityToRank(maxInt),
      ...(maxLgIntValue.presence === "missing" ? {} : { maxLgIntValue }),
      ...(maxLgInt != null ? { maxLgInt } : {}),
    };
    const existingIndex = indexByCode.get(item.code);
    if (existingIndex == null) {
      indexByCode.set(item.code, result.length);
      result.push(candidate);
      continue;
    }
    const existing = result[existingIndex];
    if (existing.maxInt.replace(/\s+/g, "") === maxInt.replace(/\s+/g, "")) {
      continue;
    }
    log.warn(
      `VXSE ${level}.Code 重複: code=${item.code} `
      + `intensity=${JSON.stringify(existing.maxInt)}/${JSON.stringify(maxInt)} `
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
 * text が無い・空文字・空白のみ、「津波」を含まない、または「心配はありません」を含む場合は false。
 * 「津波」への言及があり、かつ「心配はありません」を含まない場合だけ true とする。
 */
export function resolveEarthquakeTsunamiWarning(text: string | null | undefined): boolean {
  if (text == null || text.trim() === "") return false;
  return text.includes("津波") && !text.includes("心配はありません");
}

/** EarthquakeOutcome → PresentationEvent */
export function fromEarthquakeOutcome(outcome: EarthquakeOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const maxIntValue = info.intensity?.maxIntValue
    ?? legacyIntensityValue(info.intensity?.maxInt, info.intensity?.maxInt !== undefined);
  const maxInt = exactSpecialScalar(maxIntValue);
  const maxIntRank = maxInt != null ? intensityToRank(maxInt) : null;
  const maxLgIntValue = info.intensity?.maxLgIntValue
    ?? legacyLgIntensityValue(info.intensity?.maxLgInt, info.intensity?.maxLgInt !== undefined);
  const maxLgInt = exactSpecialScalar(maxLgIntValue);

  const areas = info.intensity?.areas ?? [];
  const municipalities = info.intensity?.municipalities ?? [];
  const areaNames = areas.map((a) => a.name);
  const municipalityNames = municipalities.map((municipality) => municipality.name);
  const areaItems: PresentationAreaItem[] = areas.map((a) => {
    const areaMaxIntValue = a.intensityValue ?? legacyIntensityValue(a.intensity, true);
    const areaMaxInt = exactSpecialScalar(areaMaxIntValue);
    const areaMaxLgIntValue = a.lgIntensityValue
      ?? legacyLgIntensityValue(a.lgIntensity, a.lgIntensity != null);
    const areaMaxLgInt = exactSpecialScalar(areaMaxLgIntValue);
    return {
      name: a.name,
      ...(a.code != null ? { code: a.code } : {}),
      maxIntValue: areaMaxIntValue,
      ...(areaMaxInt != null ? { maxInt: areaMaxInt } : {}),
      ...(areaMaxLgIntValue.presence === "missing" ? {} : { maxLgIntValue: areaMaxLgIntValue }),
      ...(areaMaxLgInt != null ? { maxLgInt: areaMaxLgInt } : {}),
    };
  });
  const quakeIntensityValues = info.intensity == null
    ? undefined
    : {
        localAreas: areas.map((area) => {
          const maxLgIntValue = area.lgIntensityValue
            ?? legacyLgIntensityValue(area.lgIntensity, area.lgIntensity != null);
          return {
            name: area.name,
            code: area.code,
            maxIntValue: area.intensityValue ?? legacyIntensityValue(area.intensity, true),
            ...(maxLgIntValue.presence === "missing" ? {} : { maxLgIntValue }),
          };
        }),
        municipalities: municipalities.map((municipality) => {
          const maxLgIntValue = municipality.lgIntensityValue
            ?? legacyLgIntensityValue(municipality.lgIntensity, municipality.lgIntensity != null);
          return {
            name: municipality.name,
            code: municipality.code,
            maxIntValue: municipality.intensityValue
              ?? legacyIntensityValue(municipality.intensity, true),
            ...(maxLgIntValue.presence === "missing" ? {} : { maxLgIntValue }),
          };
        }),
      };
  const quakeIntensity =
    info.infoType !== "取消"
    && info.intensity != null
    && (maxIntRank ?? -1) >= 3
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
    isTest: presentationTelegramMeta(outcome.msg).isTest,

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
    magnitude: magnitudeForPresentation(info.earthquake),
    ...(info.earthquake?.depthValue != null
      ? { depthValue: info.earthquake.depthValue }
      : {}),
    ...(info.earthquake?.magnitudeValue != null
      ? { magnitudeValue: info.earthquake.magnitudeValue }
      : {}),

    maxIntValue,
    maxIntLabel: formatIntensitySpecialValue(maxIntValue, maxInt, "ticker"),
    maxInt,
    maxIntRank,
    maxLgIntValue,
    maxLgIntLabel: formatLgIntensitySpecialValue(maxLgIntValue, maxLgInt, "ticker"),
    maxLgInt,
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
    ...(quakeIntensityValues != null ? { quakeIntensityValues } : {}),

    raw: outcome.parsed,
  };
}
