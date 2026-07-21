import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type { DisplayFloodRiverV1, DisplayHeatAreaV1, DisplayTyphoonV1 } from "./protocol";
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
  tornado?: PersistedTornadoStateV1 | null;
  longPeriod?: PersistedLongPeriodStateV1[];
  nankaiTrough?: PersistedNankaiStateV1 | null;
  seen: PersistedSeenEntry[];
}

export interface PersistedTyphoonStateV1 { key: string; sourceEventId: string; typhoon: DisplayTyphoonV1; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedVolcanoStateV1 { code: string; name: string; alertLevel: number | null; alertExpiresAtMs: number | null; latestEvent: string | null; eventExpiresAtMs: number | null; sourceEventIds: string[]; revision: StandbyRevision; }
export interface PersistedTornadoStateV1 { sourceEventId: string; areas: string[]; isSighted: boolean; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedLongPeriodStateV1 { eventId: string; maxLgInt: string; revision: StandbyRevision; hosted: boolean; expiresAtMs: number; }
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
      if (!isPersistedStandbyState(parsed)) {
        log.warn("[standby-persistence] structure validation 失敗 — 破棄");
        return null;
      }
      return parsed;
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

function isFloodRiver(value: unknown): value is DisplayFloodRiverV1 {
  if (!isRecord(value)) return false;
  return typeof value.riverKey === "string"
    && typeof value.riverName === "string"
    && typeof value.level === "string"
    && typeof value.levelRank === "number"
    && Number.isFinite(value.levelRank)
    && typeof value.kindName === "string"
    && typeof value.reportDateTime === "string";
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

function isPersistedStandbyState(value: unknown): value is PersistedStandbyStateV1 {
  if (!isRecord(value)) return false;
  return value.version === PERSIST_SCHEMA_VERSION
    && typeof value.savedAt === "string"
    && Array.isArray(value.heat)
    && value.heat.every(isHeatState)
    && (value.typhoons == null || Array.isArray(value.typhoons))
    && (value.volcanoes == null || Array.isArray(value.volcanoes))
    && (value.floods == null || isFloodState(value.floods))
    && (value.tornado == null || isRecord(value.tornado))
    && (value.longPeriod == null || Array.isArray(value.longPeriod))
    && (value.nankaiTrough == null || isRecord(value.nankaiTrough))
    && Array.isArray(value.seen)
    && value.seen.every(isSeenEntry);
}
