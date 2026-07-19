import { FLOOD_KIND_CODE_TO_LEVEL } from "../types";
import type { FloodHeadline, FloodStation } from "../types";
import { dig, str } from "./telegram-parser";
import { listOf, nodeText } from "./timeseries-common";
import {
  computeMainItemCodeAndHash,
  parseCriteriaFromPart,
  resolveHeadlineKindForStation,
} from "./flood-shared";

/**
 * VXSU (水位周知河川に関する情報) 用の station 抽出 stub。
 *
 * VXSU は MeteorologicalInfos[type=水位・流量情報] を持たず、time series を
 * 直接配信しない。Phase 1 では HydrometricStationPart から station の基本
 * メタ (名前 / Code / Criteria / ChargeSection) のみを抽出し、`series: []`
 * と `stationObservedLevel: "unknown"` で stub 化する。Phase 2 で
 * PrecipitationBasedIndex 時系列との関連付けを検討する余地は残す。
 *
 * headlineKindCode / mainItemCode / mainTextHash は VXKO50 と同じ resolver
 * を使って解決する。
 */
export function parseVxsuStubStations(
  body: unknown,
  headlines: FloodHeadline[],
): FloodStation[] {
  if (body == null) return [];
  const result: FloodStation[] = [];
  const addition = dig(body, "AdditionalInfo", "FloodForecastAddition");
  const stationParts = listOf(dig(addition, "HydrometricStationPart"));
  for (const part of stationParts) {
    if (part == null) continue;
    const areaNode = listOf(dig(part, "Area"))[0];
    const stationCode = str(dig(areaNode, "Code"));
    const stationName = str(dig(areaNode, "Name"));
    const location = str(dig(areaNode, "Location"));
    const chargeSections = listOf(dig(part, "ChargeSection"));
    const riverNames: string[] = [];
    for (const cs of chargeSections) {
      const text = nodeText(cs) || str(cs);
      const firstLine = text.split("\n")[0].trim();
      if (firstLine !== "") riverNames.push(firstLine);
    }
    const primaryRiverName = riverNames[0] ?? null;
    const primaryRiverCode = null; // VXSU は <Stations> 不在のため null

    const criteria = parseCriteriaFromPart(dig(part, "Criteria"));
    const headlineKindCode = resolveHeadlineKindForStation(headlines, null);
    const headlineLevel = FLOOD_KIND_CODE_TO_LEVEL[headlineKindCode];
    const { mainItemCode, mainTextHash } = computeMainItemCodeAndHash(
      body,
      stationCode,
      stationName,
    );

    result.push({
      stationName,
      stationCode,
      riverNames,
      primaryRiverCode,
      primaryRiverName,
      prefName: null,
      cityName: null,
      cityCode: null,
      location: location !== "" ? location : null,
      measurement: "water_level",
      measurementUnit: "m",
      rawUnit: "m",
      series: [],
      criteria,
      stationObservedLevel: "unknown",
      headlineKindCode,
      headlineLevel,
      mainItemCode,
      mainTextHash,
    });
  }
  return result;
}
