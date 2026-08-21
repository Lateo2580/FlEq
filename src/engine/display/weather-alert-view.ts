/**
 * Vpws50CurrentAreasForDisplay (VPWS50 / VPWW56 の state holder が返す現況 view) を
 * 表示プロトコルの weatherAlerts へ変換する。
 *
 * runtime.ts から切り出してあるのは、monitor が display runtime の有無に関わらず
 * 昇格判定用の view を組む必要があるため。runtime.ts を import すると transport (HTTP)
 * まで巻き込むので、変換だけをこの軽量モジュールに置く。
 */

import type { DisplaySeverity, Vpws50CurrentAreasForDisplay } from "../../types";
import { kindCodeToPhenomenonKey } from "../../dmdata/weather-phenomenon-key";
import { formatLevelLabel } from "../../dmdata/weather-warning-level";
import type {
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherRank,
} from "./types";

/** displaySeverity → 気象カードの rank (意味ベース、frame level とは別軸)。
 * officialL5/nonLevelSpecial=emergency, officialL4/officialL3/nonLevelWarning=warning,
 * それ以外 (officialL2/nonLevelAdvisory/officialL1/unknown)=advisory */
function weatherRankOf(displaySeverity: DisplaySeverity): DisplayWeatherRank {
  if (displaySeverity === "officialL5" || displaySeverity === "nonLevelSpecial") return "emergency";
  if (
    displaySeverity === "officialL4" ||
    displaySeverity === "officialL3" ||
    displaySeverity === "nonLevelWarning"
  ) {
    return "warning";
  }
  return "advisory";
}

const WEATHER_RANK_BUCKETS: Array<{
  rank: DisplayWeatherRank;
  label: string;
  role: "weatherEmergency" | "weatherWarning" | "weatherAdvisory";
}> = [
  { rank: "emergency", label: "気象特別警報", role: "weatherEmergency" },
  { rank: "warning", label: "気象警報", role: "weatherWarning" },
  { rank: "advisory", label: "気象注意報", role: "weatherAdvisory" },
];

/**
 * Vpws50CurrentAreasForDisplay を表示プロトコルの weatherAlerts に変換する。
 * displaySeverity から意味ベースで rank (emergency/warning/advisory) を導出し、警報・特別警報の 2 バケツに分ける。
 * advisory rank は気象カードに載せない (注意報はティッカーのみに任せる)。空バケツは含めない。
 * updatedAt は呼び出し側が供給する (hub: dto.reportDateTime / seed 時: 起動時刻 ISO)。
 */
export function weatherAlertsFromVpws50(
  view: Vpws50CurrentAreasForDisplay | undefined,
  updatedAt: string,
): DisplayWeatherAlertV1[] {
  if (view == null) return [];
  const itemsByRank: Record<DisplayWeatherRank, DisplayWeatherAlertItemV1[]> = {
    emergency: [],
    warning: [],
    advisory: [],
  };
  const areasByRank: Record<DisplayWeatherRank, Set<string>> = {
    emergency: new Set(),
    warning: new Set(),
    advisory: new Set(),
  };
  for (const group of view.kinds) {
    if (group.displaySeverity === "release") continue;
    const rank = weatherRankOf(group.displaySeverity);
    if (rank === "advisory") continue;
    const item: DisplayWeatherAlertItemV1 = {
      kind: formatLevelLabel(group.officialAlertLevel, group.kindName),
      phenomenonKey: kindCodeToPhenomenonKey(group.kindCode),
      displaySeverity: group.displaySeverity,
      rank,
      shownAreas: group.areas.map((a) => a.areaName),
      shownAreaCodes: group.areas.map((a) => a.areaCode),
      omittedAreaCount: 0,
    };
    itemsByRank[rank].push(item);
    for (const a of group.areas) areasByRank[rank].add(a.areaCode);
  }
  const alerts: DisplayWeatherAlertV1[] = [];
  for (const bucket of WEATHER_RANK_BUCKETS) {
    const items = itemsByRank[bucket.rank];
    if (items.length === 0) continue;
    alerts.push({
      source: "vpws50",
      label: bucket.label,
      role: bucket.role,
      totalAreas: areasByRank[bucket.rank].size,
      items,
      updatedAt,
    });
  }
  return alerts;
}

/**
 * VPWW56 (土砂災害警戒情報) の現況を気象カード用に変換する。
 * rank は weatherAlertsFromVpws50 と同じ displaySeverity 由来 (weatherRankOf 共有)。
 * 現実の土砂災害警戒情報は警報級だが、displaySeverity が advisory 級に落ちるデータは
 * weatherAlertsFromVpws50 と同様に除外する (advisory を気象カードに載せない契約を守る)。
 */
export function weatherAlertsFromVpww56(
  view: Vpws50CurrentAreasForDisplay | undefined,
  updatedAt: string,
): DisplayWeatherAlertV1[] {
  if (view == null || view.kinds.length === 0) return [];
  const items: DisplayWeatherAlertItemV1[] = view.kinds
    .filter((g) => g.displaySeverity !== "release" && weatherRankOf(g.displaySeverity) !== "advisory")
    .map((g) => ({
      kind: formatLevelLabel(g.officialAlertLevel, g.kindName),
      phenomenonKey: kindCodeToPhenomenonKey(g.kindCode),
      displaySeverity: g.displaySeverity,
      rank: weatherRankOf(g.displaySeverity),
      shownAreas: g.areas.map((a) => a.areaName),
      shownAreaCodes: g.areas.map((a) => a.areaCode),
      omittedAreaCount: 0,
    }));
  if (items.length === 0) return [];
  const rankOrder: Record<DisplayWeatherRank, number> = { emergency: 3, warning: 2, advisory: 1 };
  const top = items.reduce(
    (best, it) => (rankOrder[it.rank] > rankOrder[best] ? it.rank : best),
    "advisory" as DisplayWeatherRank,
  );
  const role = top === "emergency" ? "weatherEmergency" : top === "warning" ? "weatherWarning" : "weatherAdvisory";
  return [{ source: "vpww56", label: "土砂災害警戒情報", role, totalAreas: view.totalAreas, items, updatedAt }];
}
