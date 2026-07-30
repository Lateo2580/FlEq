import { FLOOD_LEVEL_RANK, maxFloodLevel } from "../../dmdata/flood-level";
import type { FloodCriteria, FloodHeadline, FloodLevel, FloodStation, ParsedFloodForecastInfo } from "../../types";
import type { PresentationEvent } from "../presentation/types";
import type { DisplayFloodHydrographV1, DisplayFloodRiverV1, DisplayFloodStationV1 } from "./protocol";

export type DisplayFloodUpdate =
  | { mode: "replace"; eventId: string; reportDateTime: string; serial: string | null; isCorrection?: boolean; rivers: DisplayFloodRiverV1[] }
  | { mode: "cancel"; eventId: string; reportDateTime: string; serial: string | null; isCorrection?: boolean }
  | { mode: "observeOnly"; eventId: string; reportDateTime: string; serial: string | null; isCorrection?: boolean };

const FLOOD_LEVEL_NAMES: Record<FloodLevel, string> = {
  L1: "水位上昇情報",
  L2: "氾濫注意情報",
  L3: "氾濫警戒情報",
  L4: "氾濫危険情報",
  L5: "氾濫発生情報",
  release: "解除",
  unknown: "洪水予報",
};

export function normalizeRiverName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, "");
}

export function floodRiverKey(station: FloodStation, publishingOffice: string): string {
  if (station.primaryRiverCode != null && station.primaryRiverCode !== "") return station.primaryRiverCode;
  if (station.primaryRiverName != null) {
    const normalized = normalizeRiverName(station.primaryRiverName);
    if (normalized !== "") return `name:${normalized}`;
  }
  return `station:${publishingOffice}:${station.stationCode}`;
}

function headlineMatchesStation(headline: FloodHeadline, station: FloodStation): boolean {
  if (headline.scope !== "河川" && headline.scope !== "発表区間") return false;
  return headline.areas.some((area) => {
    if (station.primaryRiverCode != null && station.primaryRiverCode !== "" && area.code === station.primaryRiverCode) {
      return true;
    }
    if (station.primaryRiverName == null) return false;
    return normalizeRiverName(area.name) === normalizeRiverName(station.primaryRiverName);
  });
}

function kindNameFor(station: FloodStation, raw: ParsedFloodForecastInfo, level: FloodLevel): string {
  const matching = raw.headlines.filter((headline) => headlineMatchesStation(headline, station));
  return matching.find((headline) => headline.kindCode === station.headlineKindCode)?.kindName
    ?? matching[0]?.kindName
    ?? FLOOD_LEVEL_NAMES[level];
}

function riverNameFor(station: FloodStation): string {
  const primary = normalizeRiverName(station.primaryRiverName ?? "");
  if (primary !== "") return primary;
  const secondary = normalizeRiverName(station.riverNames[0] ?? "");
  if (secondary !== "") return secondary;
  const stationName = normalizeRiverName(station.stationName);
  return stationName !== "" ? stationName : station.stationCode;
}

/** 観測水位が超過中の基準水位の名称 (JMA)。L2=氾濫注意 / L3=避難判断 / L4・L5=氾濫危険。
 *  L5 (氾濫発生) は L4 の氾濫危険水位を既に超えているため同名 + L4 基準値を使う。 */
const FLOOD_THRESHOLD_NAMES: Partial<Record<FloodLevel, string>> = {
  L2: "氾濫注意水位",
  L3: "避難判断水位",
  L4: "氾濫危険水位",
  L5: "氾濫危険水位",
};

function thresholdCriteriaValue(criteria: FloodCriteria, level: FloodLevel): number | null {
  switch (level) {
    case "L2": return criteria.L2;
    case "L3": return criteria.L3;
    case "L4":
    case "L5": return criteria.L4;
    default: return null;
  }
}

function stationThresholdLabel(station: FloodStation, level: FloodLevel): string | null {
  const name = FLOOD_THRESHOLD_NAMES[level];
  if (name == null) return null;
  const value = thresholdCriteriaValue(station.criteria, level);
  if (value == null || station.criteria.unit !== "m") return `${name}超過`;
  return `${name} ${value.toFixed(2)}m 超過`;
}

/** 現況 (series[0]) の水位を m で取る。単位が m 以外 / 欠測 (値 null / 時系列なし) は null。 */
function stationLevelM(station: FloodStation): number | null {
  if (station.measurementUnit !== "m") return null;
  const current = station.series[0];
  if (current == null || current.value == null) return null;
  return current.value;
}

/** 直近 2 点 (現況 series[0] と 1H 後 series[1]) の値差で傾向を判定。
 *  時系列が 1 点以下、または比較点が欠測なら null。 */
function stationTrend(station: FloodStation): DisplayFloodStationV1["trend"] {
  const series = station.series;
  if (series.length <= 1) return null;
  const earlier = series[0].value;
  const later = series[1].value;
  if (earlier == null || later == null) return null;
  const diff = later - earlier;
  if (diff >= 0.01) return "rising";
  if (diff <= -0.01) return "falling";
  return "steady";
}

/** 氾濫危険水位 (criteria.L4) を m で取る。単位が m 以外 / L4 欠測は null。
 *  thresholdLabel の基準値 (発表レベル対応) とは独立に、グラフの危険線専用に持つ。 */
function stationDangerLevelM(station: FloodStation): number | null {
  if (station.criteria.unit !== "m") return null;
  return station.criteria.L4;
}

/** 水位ミニグラフ用の時系列を組む。series 全点を points 化し (i===0 が現況、以降が予測)、
 *  単位が m 以外 / 空系列 / 有効値が 1 点も無い場合は null (描画しない)。
 *  L4 が欠測でも時系列自体は有用なので、dangerLevelM だけ null にして hydrograph は出す。 */
function stationHydrograph(station: FloodStation): DisplayFloodHydrographV1 | null {
  if (station.measurementUnit !== "m") return null;
  if (station.series.length === 0) return null;
  if (!station.series.some((point) => point.value != null)) return null;
  return {
    points: station.series.map((point, i) => ({
      dateTime: point.dateTime,
      valueM: point.value,
      phase: i === 0 ? "observed" : "forecast",
    })),
    dangerLevelM: stationDangerLevelM(station),
  };
}

/** 代表観測所の projection。thresholdLabel は現況の観測レベル (observedLevel) 基準で断定する。
 *  「今後 L4 到達見込み」(headline 由来) を現況の超過として表示しないため、現況が L3 未満
 *  (全観測所 L2 以下 = headline のみで警報級) の河川では thresholdLabel を null にする
 *  (「見込み」表現を出さず断定を避ける最小実装)。 */
function projectStation(station: FloodStation, observedLevel: FloodLevel): DisplayFloodStationV1 {
  const thresholdLabel = FLOOD_LEVEL_RANK[observedLevel] >= FLOOD_LEVEL_RANK.L3
    ? stationThresholdLabel(station, observedLevel)
    : null;
  return {
    name: station.stationName,
    levelM: stationLevelM(station),
    trend: stationTrend(station),
    thresholdLabel,
    hydrograph: stationHydrograph(station),
  };
}

/** 河川ごとの集約中間状態。河川全体の level (主行表示) は観測+headline の最大で保つ一方、
 *  代表観測所は現況の観測レベル (observedRank) が最大の局を選ぶ (両者を分離)。 */
interface RiverAccumulator {
  riverKey: string;
  riverName: string;
  riverLevel: FloodLevel;
  riverLevelRank: number;
  observedRank: number;
  station: FloodStation;
}

function projectRivers(raw: ParsedFloodForecastInfo, reportDateTime: string): DisplayFloodRiverV1[] {
  const byRiver = new Map<string, RiverAccumulator>();
  for (const station of raw.rawStations) {
    const riverLevel = maxFloodLevel([station.stationObservedLevel, station.headlineLevel]);
    const riverLevelRank = FLOOD_LEVEL_RANK[riverLevel];
    // 河川を表示対象に含めるかの閾値は従来どおり河川全体 level 基準 (headline 由来 L4 も残す)
    if (riverLevelRank < FLOOD_LEVEL_RANK.L3) continue;
    const observedRank = FLOOD_LEVEL_RANK[station.stationObservedLevel];
    const riverKey = floodRiverKey(station, raw.publishingOffice);
    const existing = byRiver.get(riverKey);
    if (existing == null) {
      byRiver.set(riverKey, { riverKey, riverName: riverNameFor(station), riverLevel, riverLevelRank, observedRank, station });
      continue;
    }
    // 河川全体 level = 各観測所の max(観測, headline) の最大
    if (riverLevelRank > existing.riverLevelRank) {
      existing.riverLevel = riverLevel;
      existing.riverLevelRank = riverLevelRank;
    }
    // 代表観測所 = 現況の観測レベルが最大の局 (同値は先頭を保持)
    if (observedRank > existing.observedRank) {
      existing.observedRank = observedRank;
      existing.station = station;
    }
  }
  return [...byRiver.values()].map((acc) => ({
    riverKey: acc.riverKey,
    riverName: acc.riverName,
    level: acc.riverLevel,
    levelRank: acc.riverLevelRank,
    kindName: kindNameFor(acc.station, raw, acc.riverLevel),
    reportDateTime,
    station: projectStation(acc.station, acc.station.stationObservedLevel),
  }));
}

export function projectFloodUpdate(event: PresentationEvent): DisplayFloodUpdate | null {
  if (event.domain !== "floodForecast" || event.raw == null || Array.isArray(event.raw)) return null;
  const raw = event.raw as ParsedFloodForecastInfo;
  if (raw.schema !== "vxko50" && raw.schema !== "vxsu50") return null;
  const eventId = event.eventId ?? raw.eventId;
  if (eventId === "") return null;
  const reportDateTime = event.reportDateTime;
  const serial = event.serial ?? String(raw.serial);
  const isCorrection = event.infoType === "訂正" || raw.infoType === "訂正";
  if (event.isCancellation || raw.infoType === "取消") {
    return {
      mode: "cancel",
      eventId,
      reportDateTime,
      serial,
      ...(isCorrection ? { isCorrection: true } : {}),
    };
  }
  if (raw.rawStations.length === 0) {
    return {
      mode: "observeOnly",
      eventId,
      reportDateTime,
      serial,
      ...(isCorrection ? { isCorrection: true } : {}),
    };
  }
  return {
    mode: "replace",
    eventId,
    reportDateTime,
    serial,
    ...(isCorrection ? { isCorrection: true } : {}),
    rivers: projectRivers(raw, reportDateTime),
  };
}
