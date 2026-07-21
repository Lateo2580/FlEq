import { FLOOD_LEVEL_RANK, maxFloodLevel } from "../../dmdata/flood-level";
import type { FloodHeadline, FloodLevel, FloodStation, ParsedFloodForecastInfo } from "../../types";
import type { PresentationEvent } from "../presentation/types";
import type { DisplayFloodRiverV1 } from "./protocol";

export type DisplayFloodUpdate =
  | { mode: "replace"; eventId: string; reportDateTime: string; serial: string | null; rivers: DisplayFloodRiverV1[] }
  | { mode: "cancel"; eventId: string; reportDateTime: string; serial: string | null }
  | { mode: "observeOnly"; eventId: string; reportDateTime: string; serial: string | null };

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

function projectRivers(raw: ParsedFloodForecastInfo, reportDateTime: string): DisplayFloodRiverV1[] {
  const byRiver = new Map<string, DisplayFloodRiverV1>();
  for (const station of raw.rawStations) {
    const level = maxFloodLevel([station.stationObservedLevel, station.headlineLevel]);
    const levelRank = FLOOD_LEVEL_RANK[level];
    if (levelRank < FLOOD_LEVEL_RANK.L3) continue;
    const riverKey = floodRiverKey(station, raw.publishingOffice);
    const candidate: DisplayFloodRiverV1 = {
      riverKey,
      riverName: riverNameFor(station),
      level,
      levelRank,
      kindName: kindNameFor(station, raw, level),
      reportDateTime,
    };
    const existing = byRiver.get(riverKey);
    if (existing == null || candidate.levelRank > existing.levelRank) byRiver.set(riverKey, candidate);
  }
  return [...byRiver.values()];
}

export function projectFloodUpdate(event: PresentationEvent): DisplayFloodUpdate | null {
  if (event.domain !== "floodForecast" || event.raw == null || Array.isArray(event.raw)) return null;
  const raw = event.raw as ParsedFloodForecastInfo;
  if (raw.schema !== "vxko50" && raw.schema !== "vxsu50") return null;
  const eventId = event.eventId ?? raw.eventId;
  if (eventId === "") return null;
  const reportDateTime = event.reportDateTime;
  const serial = event.serial ?? String(raw.serial);
  if (event.isCancellation || raw.infoType === "取消") {
    return { mode: "cancel", eventId, reportDateTime, serial };
  }
  if (raw.rawStations.length === 0) {
    return { mode: "observeOnly", eventId, reportDateTime, serial };
  }
  return {
    mode: "replace",
    eventId,
    reportDateTime,
    serial,
    rivers: projectRivers(raw, reportDateTime),
  };
}
