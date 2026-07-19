import type { ParsedTsunamiInfo } from "../../../types";
import { normalizeTsunamiKind } from "../../../utils/tsunami-kind";
import type { PresentationTsunamiObservation } from "../types";

/**
 * 津波観測点 (沖合/沿岸) を、同一予報区の forecast[].kind (現在の警報種別) と対応付ける (Phase A #4)。
 * observations 単独では警報種別を持たないため、areaName で forecast を引いて補完する。
 * 対応が取れない場合は areaKind を null にする。
 * areaKind は normalizeTsunamiKind で canonical ラベルへ正規化する (接尾辞つき表記のまま hub の
 * state-store へ渡ると、フロントの完全一致フィルタが該当行を落とすため)。
 * from-tsunami.ts (通常配信) と runtime.ts (起動時 seed 復元) の両方から使う共通ロジック。
 */
export function buildTsunamiObservations(info: ParsedTsunamiInfo): PresentationTsunamiObservation[] {
  const forecastKindByArea = new Map((info.forecast ?? []).map((f) => [f.areaName, f.kind]));
  return (info.observations ?? []).map((o) => {
    const rawKind = o.areaName != null ? forecastKindByArea.get(o.areaName) ?? null : null;
    return {
      areaName: o.areaName,
      areaKind: rawKind != null ? normalizeTsunamiKind(rawKind) : null,
      stationName: o.name,
      arrivalTime: o.arrivalTime || null,
      initial: o.initial || null,
      maxHeightValue: o.maxHeightValue,
      condition: o.maxHeightCondition || null,
    };
  });
}
