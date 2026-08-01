import type { LgObservationOutcome, PresentationEvent, PresentationAreaItem } from "../types";
import type { JmaIntensity, JmaLgIntensity, SpecialValue } from "../../../types";
import { presentationTelegramMeta } from "./presentation-meta";
import { intensityToRank } from "../../../utils/intensity";
import { magnitudeForPresentation } from "../../../utils/magnitude";
import {
  formatIntensitySpecialValue,
  formatLgIntensitySpecialValue,
} from "../level-helpers";

function missingSpecialValue<T>(): SpecialValue<T> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
  };
}

function legacyIntensityValue(value: string | undefined): SpecialValue<JmaIntensity> {
  if (value === undefined) return missingSpecialValue();
  const normalized = value.replace(/\s+/g, "");
  if (/^(?:0|1|2|3|4|5-|5\+|6-|6\+|7)$/.test(normalized)) {
    return {
      raw: value,
      value: normalized as JmaIntensity,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  return {
    raw: value,
    value: null,
    condition: null,
    description: null,
    presence: value.trim() === "" ? "empty" : "qualitative",
  };
}

function legacyLgIntensityValue(value: string | undefined): SpecialValue<JmaLgIntensity> {
  if (value === undefined) return missingSpecialValue();
  const normalized = value.replace(/\s+/g, "");
  if (/^(?:0|1|2|3|4)$/.test(normalized)) {
    return {
      raw: value,
      value: normalized as JmaLgIntensity,
      condition: null,
      description: null,
      presence: "value",
    };
  }
  return {
    raw: value,
    value: null,
    condition: null,
    description: null,
    presence: value.trim() === "" ? "empty" : "qualitative",
  };
}

function exactSpecialScalar<T extends string>(value: SpecialValue<T>): T | null {
  return value.presence === "value" ? value.value : null;
}

/** LgObservationOutcome → PresentationEvent */
export function fromLgObservationOutcome(outcome: LgObservationOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  const maxLgIntValue = info.maxLgIntValue ?? legacyLgIntensityValue(info.maxLgInt);
  const maxLgInt = exactSpecialScalar(maxLgIntValue);
  const maxLgIntRank = maxLgInt != null ? Number(maxLgInt) || null : null;

  const observations = info.areas ?? [];
  const observationNames = observations.map((o) => o.name);
  const areaItems: PresentationAreaItem[] = observations.map((o) => {
    const areaMaxIntValue = o.maxIntValue ?? legacyIntensityValue(o.maxInt);
    const areaMaxLgIntValue = o.maxLgIntValue ?? legacyLgIntensityValue(o.maxLgInt);
    const areaMaxInt = exactSpecialScalar(areaMaxIntValue);
    const areaMaxLgInt = exactSpecialScalar(areaMaxLgIntValue);
    return {
      name: o.name,
      maxIntValue: areaMaxIntValue,
      ...(areaMaxInt != null ? { maxInt: areaMaxInt } : {}),
      maxLgIntValue: areaMaxLgIntValue,
      ...(areaMaxLgInt != null ? { maxLgInt: areaMaxLgInt } : {}),
    };
  });

  const maxIntValue = info.maxIntValue ?? legacyIntensityValue(info.maxInt);
  const maxInt = exactSpecialScalar(maxIntValue);
  const maxIntRank = maxInt != null ? intensityToRank(maxInt) : null;

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

    maxIntValue,
    maxIntLabel: formatIntensitySpecialValue(maxIntValue, maxInt, "ticker"),
    maxInt,
    maxIntRank,
    maxLgIntValue,
    maxLgIntLabel: formatLgIntensitySpecialValue(maxLgIntValue, maxLgInt, "ticker"),
    maxLgInt,
    maxLgIntRank,

    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames,
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: observationNames.length,
    areaItems,

    raw: outcome.parsed,
  };
}
