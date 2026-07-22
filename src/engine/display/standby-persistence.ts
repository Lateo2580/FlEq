import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type { DisplayFloodHydrographV1, DisplayFloodRiverV1, DisplayFloodStationV1, DisplayHeatAreaV1, DisplayTyphoonV1 } from "./protocol";
import type { PersistedFloodState } from "./flood-active-reducer";
import type { PersistedSeenEntry } from "./revision-guard";
import type { StandbyRevision } from "./standby-registry";

const PERSIST_SCHEMA_VERSION = 1;

export interface PersistedHeatStateV1 {
  key: string;
  sourceEventIds: string[];
  targetDate: string;
  targetDateEndMs: number;
  areas: DisplayHeatAreaV1[];
  isSpecial: boolean;
  revision: StandbyRevision;
}

export interface PersistedStandbyStateV1 {
  version: 1;
  savedAt: string;
  heat: PersistedHeatStateV1[];
  typhoons: PersistedTyphoonStateV1[];
  volcanoes: PersistedVolcanoStateV1[];
  floods?: PersistedFloodState;
  tornado?: PersistedTornadoStateV1[];
  longPeriod?: PersistedLongPeriodStateV1[];
  quakeHost?: PersistedQuakeHostStateV1 | null;
  nankaiTrough?: PersistedNankaiStateV1 | null;
  seen: PersistedSeenEntry[];
}

export interface PersistedTyphoonStateV1 { key: string; sourceEventId: string; typhoon: DisplayTyphoonV1; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedVolcanoStateV1 { code: string; name: string; alertLevel: number | null; alertExpiresAtMs: number | null; latestEvent: string | null; eventExpiresAtMs: number | null; sourceEventIds: string[]; alertRevision: StandbyRevision | null; eventRevision: StandbyRevision | null; }
export interface PersistedTornadoStateV1 { publishingOffice: string; sourceEventId: string; areas: string[]; isSighted: boolean; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedLongPeriodStateV1 { eventId: string; maxLgInt: string; revision: StandbyRevision; hosted: boolean; expiresAtMs: number; }
export interface PersistedQuakeHostStateV1 { eventId: string; maxIntRank: number; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedNankaiStateV1 { sourceEventId: string; statusCode: string; label: string; revision: StandbyRevision; expiresAtMs: number; }

export class StandbyPersistence {
  constructor(private readonly persistPath: string) {}

  load(): PersistedStandbyStateV1 | null {
    try {
      if (!fs.existsSync(this.persistPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
      const version = parsed != null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).version
        : undefined;
      if (version !== PERSIST_SCHEMA_VERSION) {
        log.debug(`[standby-persistence] schema 世代交代 (v${String(version)} → v${PERSIST_SCHEMA_VERSION}) — 旧データ破棄`);
        return null;
      }
      const sanitized = sanitizePersistedStandbyState(parsed);
      if (sanitized == null) {
        log.warn("[standby-persistence] top-level structure validation 失敗 — 破棄");
        return null;
      }
      return sanitized;
    } catch (err) {
      log.warn(`[standby-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  save(state: PersistedStandbyStateV1): void {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmpPath = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
      fs.renameSync(tmpPath, this.persistPath);
    } catch (err) {
      log.warn(`[standby-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is StandbyRevision {
  if (!isRecord(value)) return false;
  return typeof value.reportTimeMs === "number" && Number.isFinite(value.reportTimeMs)
    && (value.serial == null || typeof value.serial === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHeatAreaArray(value: unknown): value is DisplayHeatAreaV1[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.areaName === "string" && typeof item.isSpecial === "boolean",
  );
}

function isHeatState(value: unknown): value is PersistedHeatStateV1 {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isStringArray(value.sourceEventIds)
    && typeof value.targetDate === "string"
    && typeof value.targetDateEndMs === "number"
    && Number.isFinite(value.targetDateEndMs)
    && isHeatAreaArray(value.areas)
    && typeof value.isSpecial === "boolean"
    && isRevision(value.revision);
}

function isSeenEntry(value: unknown): value is PersistedSeenEntry {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isRevision(value.revision)
    && typeof value.forgetAtMs === "number"
    && Number.isFinite(value.forgetAtMs);
}

function isFloodTrend(value: unknown): value is DisplayFloodStationV1["trend"] {
  return value == null || value === "rising" || value === "falling" || value === "steady";
}

function isFloodHydrograph(value: unknown): value is DisplayFloodHydrographV1 {
  if (!isRecord(value)) return false;
  return Array.isArray(value.points)
    && value.points.every((point) => isRecord(point)
      && typeof point.dateTime === "string"
      && isNullableFiniteNumber(point.valueM)
      && (point.phase === "observed" || point.phase === "forecast"))
    && isNullableFiniteNumber(value.dangerLevelM);
}

function isFloodStation(value: unknown): value is DisplayFloodStationV1 {
  if (!isRecord(value)) return false;
  return typeof value.name === "string"
    && isNullableFiniteNumber(value.levelM)
    && isFloodTrend(value.trend)
    && isNullableString(value.thresholdLabel)
    && (!Object.hasOwn(value, "hydrograph") || value.hydrograph == null || isFloodHydrograph(value.hydrograph));
}

function isFloodRiver(value: unknown): value is DisplayFloodRiverV1 {
  if (!isRecord(value)) return false;
  return typeof value.riverKey === "string"
    && typeof value.riverName === "string"
    && typeof value.level === "string"
    && typeof value.levelRank === "number"
    && Number.isFinite(value.levelRank)
    && typeof value.kindName === "string"
    && typeof value.reportDateTime === "string"
    && (!Object.hasOwn(value, "station") || value.station == null || isFloodStation(value.station));
}

function isFloodState(value: unknown): value is PersistedFloodState {
  if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.seen)) return false;
  return value.events.every((event) => isRecord(event)
      && typeof event.eventId === "string"
      && isRevision(event.revision)
      && Array.isArray(event.rivers)
      && event.rivers.every(isFloodRiver)
      && typeof event.expiresAtMs === "number"
      && Number.isFinite(event.expiresAtMs))
    && value.seen.every(isSeenEntry);
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value == null || typeof value === "number" && Number.isFinite(value);
}

function hasNullableString(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableString(value[key]);
}

function hasNullableFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableFiniteNumber(value[key]);
}

function isTyphoon(value: unknown): value is DisplayTyphoonV1 {
  if (!isRecord(value)) return false;
  return typeof value.typhoonKey === "string"
    && hasNullableString(value, "name")
    && hasNullableString(value, "nameKana")
    && hasNullableString(value, "remark")
    && hasNullableString(value, "typhoonNumber")
    && hasNullableString(value, "category")
    && hasNullableString(value, "location")
    && hasNullableFiniteNumber(value, "pressureHpa")
    && hasNullableFiniteNumber(value, "maxWindMs")
    && hasNullableString(value, "moveDirection")
    && hasNullableFiniteNumber(value, "moveSpeedKmh")
    && typeof value.reportDateTime === "string";
}

function isTyphoonState(value: unknown): value is PersistedTyphoonStateV1 {
  return isRecord(value)
    && typeof value.key === "string"
    && typeof value.sourceEventId === "string"
    && isTyphoon(value.typhoon)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isVolcanoState(value: unknown): value is PersistedVolcanoStateV1 {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.name === "string"
    && hasNullableFiniteNumber(value, "alertLevel")
    && hasNullableFiniteNumber(value, "alertExpiresAtMs")
    && hasNullableString(value, "latestEvent")
    && hasNullableFiniteNumber(value, "eventExpiresAtMs")
    && isStringArray(value.sourceEventIds)
    && Object.hasOwn(value, "alertRevision") && (value.alertRevision == null || isRevision(value.alertRevision))
    && Object.hasOwn(value, "eventRevision") && (value.eventRevision == null || isRevision(value.eventRevision));
}

function isTornadoState(value: unknown): value is PersistedTornadoStateV1 {
  return isRecord(value)
    && typeof value.publishingOffice === "string"
    && typeof value.sourceEventId === "string"
    && isStringArray(value.areas)
    && typeof value.isSighted === "boolean"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isLongPeriodState(value: unknown): value is PersistedLongPeriodStateV1 {
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxLgInt === "string"
    && isRevision(value.revision)
    && typeof value.hosted === "boolean"
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isQuakeHostState(value: unknown): value is PersistedQuakeHostStateV1 {
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxIntRank === "number" && Number.isFinite(value.maxIntRank)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isNankaiState(value: unknown): value is PersistedNankaiStateV1 {
  return isRecord(value)
    && typeof value.sourceEventId === "string"
    && typeof value.statusCode === "string"
    && typeof value.label === "string"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function validDomainArray<T>(value: unknown, predicate: (entry: unknown) => entry is T, domain: string): T[] {
  if (value == null) return [];
  if (Array.isArray(value) && value.every(predicate)) return value;
  log.warn(`[standby-persistence] ${domain} structure validation 失敗 — domain 破棄`);
  return [];
}

function sanitizePersistedStandbyState(value: unknown): PersistedStandbyStateV1 | null {
  if (!isRecord(value) || value.version !== PERSIST_SCHEMA_VERSION || typeof value.savedAt !== "string") return null;
  const floods = value.floods == null ? undefined : isFloodState(value.floods) ? value.floods : undefined;
  if (value.floods != null && floods == null) log.warn("[standby-persistence] floods structure validation 失敗 — domain 破棄");
  const nankaiTrough = value.nankaiTrough == null || isNankaiState(value.nankaiTrough) ? value.nankaiTrough : null;
  if (value.nankaiTrough != null && nankaiTrough == null) log.warn("[standby-persistence] nankaiTrough structure validation 失敗 — domain 破棄");
  const quakeHost = value.quakeHost == null || isQuakeHostState(value.quakeHost) ? value.quakeHost : null;
  if (value.quakeHost != null && quakeHost == null) log.warn("[standby-persistence] quakeHost structure validation 失敗 — domain 破棄");
  return {
    version: 1,
    savedAt: value.savedAt,
    heat: validDomainArray(value.heat, isHeatState, "heat"),
    typhoons: validDomainArray(value.typhoons, isTyphoonState, "typhoons"),
    volcanoes: validDomainArray(value.volcanoes, isVolcanoState, "volcanoes"),
    floods,
    tornado: validDomainArray(value.tornado, isTornadoState, "tornado"),
    longPeriod: validDomainArray(value.longPeriod, isLongPeriodState, "longPeriod"),
    quakeHost,
    nankaiTrough,
    seen: validDomainArray(value.seen, isSeenEntry, "seen"),
  };
}
