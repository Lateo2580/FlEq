import type { ParsedTsunamiInfo, TsunamiForecastItem } from "../../../types";
import { normalizeTsunamiKind } from "../../../utils/tsunami-kind";
import type { PresentationTsunamiObservation } from "../types";

/**
 * 津波観測点 (沖合/沿岸) を、同一予報区の forecast[].kind (現在の警報種別) と対応付ける (Phase A #4)。
 * observations 単独では警報種別を持たないため、Area.Code で forecast を引いて補完する。
 * 対応が取れない場合は areaKind を null にする。
 * Area.Code が欠落した観測点は名称から推定せず、結合しない。
 * areaKind は normalizeTsunamiKind で canonical ラベルへ正規化する (接尾辞つき表記のまま hub の
 * state-store へ渡ると、フロントの完全一致フィルタが該当行を落とすため)。
 * from-tsunami.ts (通常配信) と runtime.ts (起動時 seed 復元) の両方から使う共通ロジック。
 */
export function buildTsunamiObservations(info: ParsedTsunamiInfo): PresentationTsunamiObservation[] {
  const forecastByAreaCode = new Map<string, TsunamiForecastItem>();
  for (const forecast of info.forecast ?? []) {
    if (forecast.areaCode == null || forecast.areaCode.trim() === "") continue;
    forecastByAreaCode.set(forecast.areaCode, forecast);
  }
  return (info.observations ?? []).map((o) => {
    const areaCode = o.areaCode;
    const matchedForecast = areaCode == null || areaCode.trim() === ""
      ? undefined
      : forecastByAreaCode.get(areaCode);
    const rawKind = matchedForecast?.kind ?? null;
    return {
      areaName: o.areaName,
      areaKind: rawKind != null ? normalizeTsunamiKind(rawKind) : null,
      ...(Object.hasOwn(o, "areaCode") ? { areaCode: o.areaCode ?? null } : {}),
      ...(matchedForecast != null ? { kindCode: matchedForecast.kindCode } : {}),
      ...(o.stationCode != null ? { stationCode: o.stationCode } : {}),
      stationName: o.name,
      arrivalTime: o.arrivalTime || null,
      initial: o.initial || null,
      maxHeightValue: o.maxHeightValue,
      condition: o.maxHeightCondition || null,
      ...(o.maxHeightValueCondition ? { heightCondition: o.maxHeightValueCondition } : {}),
    };
  });
}
