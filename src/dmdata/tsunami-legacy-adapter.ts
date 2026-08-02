import type {
  ParsedTsunamiInfo,
  SpecialValue,
  TsunamiForecastItem,
  TsunamiObservationStation,
} from "../types";
import { extractSpecialValue } from "./special-value";

/** V1 scalar だけを持つ旧入力。canonical DTO 自体は弱めない。 */
export type LegacyTsunamiForecastItemInput = Omit<
  TsunamiForecastItem,
  "areaCode" | "kindCode" | "kindName" | "maxHeight"
> & Partial<Pick<
  TsunamiForecastItem,
  "areaCode" | "kindCode" | "kindName" | "maxHeight"
>>;

/** V1 scalar だけを持つ旧観測入力。 */
export type LegacyTsunamiObservationInput = Omit<
  TsunamiObservationStation,
  "maxHeight"
> & Partial<Pick<TsunamiObservationStation, "maxHeight">>;

/** 旧 persistence／sample を canonical DTO へ上げる入力型。 */
export type LegacyParsedTsunamiInfoInput = Omit<
  ParsedTsunamiInfo,
  "forecast" | "observations"
> & {
  forecast?: LegacyTsunamiForecastItemInput[];
  observations?: LegacyTsunamiObservationInput[];
};

function missingTsunamiHeight(): SpecialValue<number> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
  };
}

/**
 * 旧 scalar は XML raw を失っているため完全復元はできない。
 * 数値・range・既知定性語だけを再構成し、空 scalar は missing として扱う。
 */
function legacyTsunamiHeight(
  description: string | null,
  condition: string | null,
): SpecialValue<number> {
  if ((description == null || description === "") && condition == null) {
    return missingTsunamiHeight();
  }
  const normalized = description?.normalize("NFKC") ?? "";
  const numericRaw = normalized.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/)?.[0];
  return extractSpecialValue("TsunamiHeight", {
    "#text": numericRaw ?? description ?? "",
    ...(condition == null ? {} : { "@_condition": condition }),
    ...(description == null ? {} : { "@_description": description }),
  });
}

export function canonicalizeLegacyTsunamiForecastItem(
  item: LegacyTsunamiForecastItemInput,
): TsunamiForecastItem {
  const kindName = item.kindName ?? item.kind;
  const maxHeight = item.maxHeight
    ?? legacyTsunamiHeight(item.maxHeightDescription, null);
  const maxHeightDescription = maxHeight.description == null
    ? item.maxHeight == null ? item.maxHeightDescription : ""
    : maxHeight.description.trim();
  return {
    ...item,
    areaCode: item.areaCode ?? null,
    kindCode: item.kindCode ?? null,
    kindName,
    maxHeight,
    kind: kindName,
    maxHeightDescription,
  };
}

export function canonicalizeLegacyTsunamiObservation(
  item: LegacyTsunamiObservationInput,
): TsunamiObservationStation {
  const condition = item.maxHeightValueCondition?.trim()
    || (item.maxHeightCondition.includes("観測中") ? "観測中" : null);
  const maxHeight = item.maxHeight
    ?? legacyTsunamiHeight(item.maxHeightValue, condition);
  return {
    ...item,
    maxHeight,
    maxHeightValue: maxHeight.description == null
      ? null
      : maxHeight.description.trim() || null,
  };
}

export function canonicalizeLegacyTsunamiInfo(
  info: LegacyParsedTsunamiInfoInput,
): ParsedTsunamiInfo {
  const { forecast, observations, ...rest } = info;
  return {
    ...rest,
    ...(forecast == null
      ? {}
      : { forecast: forecast.map(canonicalizeLegacyTsunamiForecastItem) }),
    ...(observations == null
      ? {}
      : { observations: observations.map(canonicalizeLegacyTsunamiObservation) }),
  };
}
