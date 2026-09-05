import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BriefingCriticalPersistenceInvariantError,
  StandbyPersistence,
  standbyPersistenceV2Path,
  validateBriefingCriticalForWrite,
  type PersistedBriefingCriticalEntryV1,
  type PersistedBriefingCriticalStateV1,
  type PersistedStandbyStateV1,
  type PersistedStandbyStateV2,
  type PersistedTelegramFoundationInputV2,
  type PersistedWeatherWarningForecastStateV1,
  type VolcanoManualBackupResult,
} from "../../../src/engine/display/standby-persistence";
import type { DisplayBriefingEntryV1 } from "../../../src/engine/display/protocol";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { weatherAlertsFromVpww56 } from "../../../src/engine/display/weather-alert-view";
import { FloodActiveReducer } from "../../../src/engine/display/flood-active-reducer";
import { VPWW56_SNAPSHOT_GENERATION, Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import type { PersistedVolcanoStateV2, VolcanoRepairStateV1 } from "../../../src/engine/messages/volcano-state";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { parseTsunamiTelegram } from "../../../src/dmdata/telegram-parser";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { parseWeatherWarningTimeseries } from "../../../src/dmdata/weather-warning-timeseries-parser";
import { classifySignificancyCode } from "../../../src/dmdata/weather-warning-timeseries-significancy";
import { resolveVpwp50Significancy } from "../../../src/dmdata/weather-warning-level";
import {
  reduceWeatherWarningForecast,
  vpwp50ForecastPeriodLabel,
  vpwp50ForecastStandbySeverity,
} from "../../../src/engine/display/weather-warning-forecast-active-reducer";
import { WEATHER_TIMESERIES_RETENTION_MS } from "../../../src/engine/messages/revision-family-registry";
import { fromFloodForecastOutcome } from "../../../src/engine/presentation/events/from-flood-forecast";
import { processFloodForecast } from "../../../src/engine/presentation/processors/process-flood-forecast";
import { processTsunami } from "../../../src/engine/presentation/processors/process-tsunami";
import { toWsDataMessageFromRestBody } from "../../../src/engine/startup/telegram-adapter";
import { processWeather } from "../../../src/engine/presentation/processors/process-weather";
import {
  vpwp50ForecastLabel,
  vpwp50StableKey,
} from "../../../src/engine/presentation/weather-severity-pyramid";
import * as log from "../../../src/logger";
import type { FloodForecastOutcome, PresentationEvent } from "../../../src/engine/presentation/types";
import type { SpecialValue, TelegramListResponse } from "../../../src/types";
import {
  legacyDisplayPlumeHeightSemantics,
  projectPlumeHeightSemantic,
} from "../../../src/engine/display/plume-height-semantic";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFVO56_FLASH_4,
  FIXTURE_VPWW56_DOSHA,
  FIXTURE_VPWP50_LOCAL_IDENTITY,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT,
  FIXTURE_VTSE52_OFFSHORE,
} from "../../helpers/mock-message";
import { makeProcessDeps } from "../../helpers/process-deps";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const roots: string[] = [];

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), "fleq-standby-"));
  roots.push(root);
  return join(root, "data", "runtime", "display-active-state-v1.json");
}

function jsonPointer(value: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((current, token) => {
    if (current == null || typeof current !== "object") return undefined;
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    return (current as Record<string, unknown>)[key];
  }, value);
}

function operationalArray(value: unknown[], pointer: string): unknown[] {
  const copied = [...value];
  if (pointer === "/briefingCritical/rawAliases") {
    copied.sort((left, right) => {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      return `${String(leftRecord.source)}\0${String(leftRecord.sourceEventId)}`
        .localeCompare(`${String(rightRecord.source)}\0${String(rightRecord.sourceEventId)}`);
    });
  }
  return copied;
}

function operationalArrayIdentity(value: unknown, pointer: string): string | null {
  if (pointer !== "/briefingCritical/rawAliases" || value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.source === "string" && typeof record.sourceEventId === "string"
    ? `${record.source}\0${record.sourceEventId}`
    : null;
}

function explicitPrimitiveReplacements(source: unknown, target: unknown, pointer = ""): string[] {
  if (source == null || target == null || typeof source !== "object" || typeof target !== "object") {
    return pointer !== "/version" && JSON.stringify(source) !== JSON.stringify(target) ? [pointer] : [];
  }
  if (Array.isArray(source) || Array.isArray(target)) {
    if (!Array.isArray(source) || !Array.isArray(target)) return [pointer];
    const left = operationalArray(source, pointer);
    const right = operationalArray(target, pointer);
    const leftIdentities = left.map((item) => operationalArrayIdentity(item, pointer));
    const rightIdentities = right.map((item) => operationalArrayIdentity(item, pointer));
    if (leftIdentities.every((identity) => identity != null)
      && rightIdentities.every((identity) => identity != null)) {
      const rightByIdentity = new Map(rightIdentities.map((identity, index) => [identity!, right[index]]));
      const identitySetChanged = JSON.stringify(leftIdentities) !== JSON.stringify(rightIdentities);
      return [
        ...(identitySetChanged ? [pointer] : []),
        ...left.flatMap((item, index) => {
          const matching = rightByIdentity.get(leftIdentities[index]!);
          return matching === undefined
            ? []
            : explicitPrimitiveReplacements(item, matching, `${pointer}/${index}`);
        }),
      ];
    }
    return [
      ...(left.length === right.length ? [] : [pointer]),
      ...left.slice(0, Math.min(left.length, right.length)).flatMap((item, index) =>
        explicitPrimitiveReplacements(item, right[index], `${pointer}/${index}`)),
    ];
  }
  const left = source as Record<string, unknown>;
  const right = target as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((key) => {
    const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (childPointer === "/version") return [];
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return [childPointer];
    return explicitPrimitiveReplacements(left[key], right[key], childPointer);
  });
}

function expiredEpochPointers(value: unknown, nowMs: number, pointer = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => expiredEpochPointers(item, nowMs, `${pointer}/${index}`));
  }
  if (value == null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (/^(?:expiresAtMs|forgetAtMs|targetDateEndMs)$/.test(key)
      && typeof item === "number" && item <= nowMs) return [childPointer];
    return expiredEpochPointers(item, nowMs, childPointer);
  });
}

function state(over: Partial<PersistedStandbyStateV1> = {}): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: new Date(T0).toISOString(),
    heat: [{
      key: "heat:2026-07-21",
      sourceEventIds: ["heat-1"],
      targetDate: "2026-07-21",
      targetDateEndMs: Date.parse("2026-07-22T00:00:00+09:00"),
      areas: [{ areaName: "東京都", isSpecial: false }],
      isSpecial: false,
      revision: { reportTimeMs: T0, serial: "1" },
    }],
    seen: [{
      key: "heat:2026-07-21",
      revision: { reportTimeMs: T0, serial: "1" },
      forgetAtMs: T0 + 24 * 60 * 60_000,
    }],
    typhoons: [],
    volcanoes: [],
    floods: undefined,
    weatherAlerts: [],
    tornado: [],
    longPeriod: [],
    quakeHost: null,
    nankaiTrough: null,
    ...over,
  };
}

const VPWP50_TEST_NOW_MS = Date.parse("2026-06-06T00:30:00.000Z");
const VPWP50_TEST_SUBJECT = "weatherTimeseries:VPWP50-LOCAL-IDENTITY:200000";
const VPWP50_TEST_SEMANTIC = `発表:${"1".repeat(64)}`;

function vpwp50PersistenceProjection(): PersistedWeatherWarningForecastStateV1 {
  const parsed = parseWeatherWarningTimeseries(
    createMockWsDataMessage(FIXTURE_VPWP50_LOCAL_IDENTITY),
  );
  if (parsed == null) throw new Error("VPWP50 local identity fixture did not parse");
  const runtime = reduceWeatherWarningForecast(
    parsed,
    VPWP50_TEST_SUBJECT,
    "fixture-message-id",
    { reportTimeMs: Date.parse(parsed.reportDateTime), serial: parsed.serial },
    VPWP50_TEST_SEMANTIC,
    VPWP50_TEST_NOW_MS,
  );
  if (runtime == null) throw new Error("VPWP50 local identity fixture did not reduce");
  const { restored: _restored, ...projection } = runtime;
  return projection;
}

function vpwp50PersistenceFoundation(
  projection: PersistedWeatherWarningForecastStateV1,
): PersistedTelegramFoundationInputV2 {
  const reportDateTime = new Date(projection.revision.reportTimeMs).toISOString();
  const serial = projection.revision.serial;
  return {
    vpws50: { authoritative: true, state: null, gateEntries: [] },
    vpww56: {
      generation: VPWW56_SNAPSHOT_GENERATION,
      authoritative: false,
      state: null,
      gateEntries: [],
    },
    tsunami: {
      active: null,
      keyedActive: [],
      legacyActive: null,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: [],
    },
    volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
    floodForecast: { authoritative: false, active: [], gateEntries: [] },
    standbyDomains: { gateEntries: [{
      domain: "weatherWarningTimeseries",
      revisionFamily: "VPWP50",
      stateSubjectKey: projection.subjectKey,
      comparison: {
        stateSubjectKey: projection.subjectKey,
        revision: {
          eventId: { raw: projection.subjectKey, value: projection.subjectKey, valid: true },
          type: { raw: "VPWP50", value: "VPWP50", valid: true },
          reportDateTime: { raw: reportDateTime, epochMs: projection.revision.reportTimeMs, valid: true },
          serial: serial == null
            ? { raw: null, numeric: null, valid: false }
            : { raw: serial, numeric: Number(serial), valid: true },
          infoType: { raw: "発表", value: "発表", valid: true },
        },
      },
      semanticKeys: [projection.appliedSemanticKey],
      cancelled: false,
      acceptedAtMs: VPWP50_TEST_NOW_MS,
      tombstoneRetentionMs: WEATHER_TIMESERIES_RETENTION_MS,
      legacyRevisionKey: projection.subjectKey,
      legacyRevisionKeyProvenance: null,
    }] },
  };
}

type Vpwp50DtoGroup = PersistedWeatherWarningForecastStateV1["groups"][number];
type Vpwp50DtoTarget = Vpwp50DtoGroup["targets"][number];

interface Vpwp50DtoContext {
  subjectKey: string;
  sourceEventId: string;
  revision: PersistedWeatherWarningForecastStateV1["revision"];
  appliedSemanticKey: string;
}

const VPWP50_DTO_HOUR_MS = 60 * 60_000;

function vpwp50DtoContext(tag: string): Vpwp50DtoContext {
  return {
    subjectKey: `weatherTimeseries:vpwp50-persisted-dto:${tag}`,
    sourceEventId: `vpwp50-persisted-dto-${tag}`,
    revision: { reportTimeMs: VPWP50_TEST_NOW_MS - VPWP50_DTO_HOUR_MS, serial: "1" },
    appliedSemanticKey: `発表:${"2".repeat(64)}`,
  };
}

function vpwp50DtoGroup(
  phenomenonName: string,
  significancyCode: string,
): Vpwp50DtoGroup {
  const significancy = classifySignificancyCode(phenomenonName, significancyCode);
  const forecastLabel = vpwp50ForecastLabel(phenomenonName, significancy);
  if (forecastLabel == null) throw new Error("VPWP50 DTO group has no forecast label");
  const displaySeverity = resolveVpwp50Significancy(significancy)?.displaySeverity ?? "unknown";
  return {
    key: vpwp50StableKey("group", [
      phenomenonName, significancyCode, forecastLabel, displaySeverity,
    ]),
    phenomenonName,
    significancyCode,
    forecastLabel,
    displaySeverity,
    severity: vpwp50ForecastStandbySeverity(displaySeverity),
    targets: [],
  };
}

function vpwp50DtoTarget(
  context: Vpwp50DtoContext,
  groupKey: string,
  options: {
    scope: "area" | "local";
    name: string;
    parentAreaName: string;
    areaCode: string | null;
    localCode: string | null;
    endsAtMs: number;
  },
): Vpwp50DtoTarget {
  const areaIdentityKey = options.areaCode == null
    ? `name:${options.parentAreaName}` : `code:${options.areaCode}`;
  const localIdentityKey = options.scope === "local"
    ? options.localCode == null ? `name:${options.name}` : `code:${options.localCode}`
    : null;
  const targetKey = options.scope === "area"
    ? vpwp50StableKey("target", [context.subjectKey, "area", areaIdentityKey])
    : vpwp50StableKey("target", [
      context.subjectKey, "local", areaIdentityKey, localIdentityKey,
    ]);
  const startsAt = new Date(options.endsAtMs - 3 * VPWP50_DTO_HOUR_MS).toISOString();
  const endsAt = new Date(options.endsAtMs).toISOString();
  const pagerAnchorOrdinal = 0;
  return {
    key: targetKey,
    scope: options.scope,
    name: options.name,
    parentAreaName: options.parentAreaName,
    areaCode: options.areaCode,
    localCode: options.localCode,
    periods: [{
      key: vpwp50StableKey("period", [
        groupKey, targetKey, 1, "3h", startsAt, endsAt,
      ]),
      tsNum: 1,
      series: "3h",
      startsAt,
      endsAt,
      label: vpwp50ForecastPeriodLabel(startsAt, endsAt),
      pagerAnchorKey: vpwp50StableKey("anchor", [
        context.subjectKey,
        context.revision.reportTimeMs,
        context.revision.serial,
        groupKey,
        targetKey,
        pagerAnchorOrdinal,
      ]),
      pagerAnchorOrdinal,
      pagerSlot: 0,
    }],
  };
}

function vpwp50DtoProjection(
  context: Vpwp50DtoContext,
  groups: Vpwp50DtoGroup[],
): PersistedWeatherWarningForecastStateV1 {
  const ends = groups.flatMap((group) => group.targets.flatMap((target) =>
    target.periods.map((period) => Date.parse(period.endsAt))));
  if (ends.length === 0) throw new Error("VPWP50 DTO projection requires a period");
  return {
    ...context,
    publishingOffice: "試験地方気象台",
    targetAreaName: "長野県",
    targetAreaCode: "200000",
    groups,
    expiresAtMs: Math.max(...ends),
  };
}

function vpwp50DtoFoundation(
  projections: readonly PersistedWeatherWarningForecastStateV1[],
): PersistedTelegramFoundationInputV2 {
  const first = projections[0];
  if (first == null) throw new Error("VPWP50 DTO foundation requires a projection");
  return {
    ...vpwp50PersistenceFoundation(first),
    standbyDomains: {
      gateEntries: projections.map((projection) =>
        vpwp50PersistenceFoundation(projection).standbyDomains!.gateEntries[0]!),
    },
  };
}

function reverseVpwp50DtoInput(
  projection: PersistedWeatherWarningForecastStateV1,
): PersistedWeatherWarningForecastStateV1 {
  return {
    ...structuredClone(projection),
    groups: [...projection.groups].reverse().map((group) => ({
      ...structuredClone(group),
      targets: [...group.targets].reverse().map((target) => ({
        ...structuredClone(target),
        periods: [...target.periods].reverse(),
      })),
    })),
  };
}

function vpwp50AreaConflictDto(
  context: Vpwp50DtoContext,
  conflictIsOuterWitness = false,
): PersistedWeatherWarningForecastStateV1 {
  const conflictEnd = VPWP50_TEST_NOW_MS
    + (conflictIsOuterWitness ? 8 : 4) * VPWP50_DTO_HOUR_MS;
  const retainedEnd = VPWP50_TEST_NOW_MS
    + (conflictIsOuterWitness ? 7 : 8) * VPWP50_DTO_HOUR_MS;
  const rain = vpwp50DtoGroup("雨", "21");
  const wind = vpwp50DtoGroup("風", "22");
  const snow = vpwp50DtoGroup("雪", "30");
  rain.targets = [
    vpwp50DtoTarget(context, rain.key, { scope: "area", name: "長野県北部", parentAreaName: "長野県北部", areaCode: "200010", localCode: null, endsAtMs: conflictEnd }),
    vpwp50DtoTarget(context, rain.key, { scope: "local", name: "北部内地域", parentAreaName: "長野県北部", areaCode: "200010", localCode: "009", endsAtMs: conflictEnd }),
    vpwp50DtoTarget(context, rain.key, { scope: "area", name: "正常地域", parentAreaName: "正常地域", areaCode: "200020", localCode: null, endsAtMs: retainedEnd }),
    vpwp50DtoTarget(context, rain.key, { scope: "area", name: "無コード北", parentAreaName: "無コード北", areaCode: null, localCode: null, endsAtMs: retainedEnd - VPWP50_DTO_HOUR_MS }),
  ];
  wind.targets = [
    vpwp50DtoTarget(context, wind.key, { scope: "area", name: "長野県南部", parentAreaName: "長野県南部", areaCode: "200010", localCode: null, endsAtMs: conflictEnd }),
    vpwp50DtoTarget(context, wind.key, { scope: "area", name: "正常地域", parentAreaName: "正常地域", areaCode: "200020", localCode: null, endsAtMs: retainedEnd }),
    vpwp50DtoTarget(context, wind.key, { scope: "area", name: "無コード南", parentAreaName: "無コード南", areaCode: null, localCode: null, endsAtMs: retainedEnd - VPWP50_DTO_HOUR_MS }),
  ];
  snow.targets = [
    vpwp50DtoTarget(context, snow.key, { scope: "area", name: "長野県北部", parentAreaName: "長野県北部", areaCode: "200010", localCode: null, endsAtMs: conflictEnd }),
  ];
  return vpwp50DtoProjection(context, [rain, wind, snow]);
}

function vpwp50LocalConflictDto(
  context: Vpwp50DtoContext,
  conflictIsOuterWitness = false,
): PersistedWeatherWarningForecastStateV1 {
  const conflictEnd = VPWP50_TEST_NOW_MS
    + (conflictIsOuterWitness ? 8 : 4) * VPWP50_DTO_HOUR_MS;
  const retainedEnd = VPWP50_TEST_NOW_MS
    + (conflictIsOuterWitness ? 7 : 8) * VPWP50_DTO_HOUR_MS;
  const rain = vpwp50DtoGroup("雨", "21");
  const wind = vpwp50DtoGroup("風", "22");
  const snow = vpwp50DtoGroup("雪", "30");
  rain.targets = [
    vpwp50DtoTarget(context, rain.key, { scope: "local", name: "松本地域", parentAreaName: "長野県中部", areaCode: "200010", localCode: "001", endsAtMs: conflictEnd }),
    vpwp50DtoTarget(context, rain.key, { scope: "area", name: "長野県中部", parentAreaName: "長野県中部", areaCode: "200010", localCode: null, endsAtMs: retainedEnd - VPWP50_DTO_HOUR_MS }),
    vpwp50DtoTarget(context, rain.key, { scope: "local", name: "安曇地域", parentAreaName: "長野県中部", areaCode: "200010", localCode: "002", endsAtMs: retainedEnd - VPWP50_DTO_HOUR_MS }),
    vpwp50DtoTarget(context, rain.key, { scope: "area", name: "正常別地域", parentAreaName: "正常別地域", areaCode: "200020", localCode: null, endsAtMs: retainedEnd }),
    vpwp50DtoTarget(context, rain.key, { scope: "local", name: "無コード地域A", parentAreaName: "長野県中部", areaCode: "200010", localCode: null, endsAtMs: retainedEnd - 2 * VPWP50_DTO_HOUR_MS }),
  ];
  wind.targets = [
    vpwp50DtoTarget(context, wind.key, { scope: "local", name: "大北地域", parentAreaName: "長野県中部", areaCode: "200010", localCode: "001", endsAtMs: conflictEnd }),
    vpwp50DtoTarget(context, wind.key, { scope: "area", name: "長野県中部", parentAreaName: "長野県中部", areaCode: "200010", localCode: null, endsAtMs: retainedEnd - VPWP50_DTO_HOUR_MS }),
    vpwp50DtoTarget(context, wind.key, { scope: "local", name: "無コード地域B", parentAreaName: "長野県中部", areaCode: "200010", localCode: null, endsAtMs: retainedEnd - 2 * VPWP50_DTO_HOUR_MS }),
  ];
  snow.targets = [
    vpwp50DtoTarget(context, snow.key, { scope: "local", name: "松本地域", parentAreaName: "長野県中部", areaCode: "200010", localCode: "001", endsAtMs: conflictEnd }),
  ];
  return vpwp50DtoProjection(context, [rain, wind, snow]);
}

function vpwp50HealthyDto(context: Vpwp50DtoContext): PersistedWeatherWarningForecastStateV1 {
  const rain = vpwp50DtoGroup("雨", "21");
  rain.targets = [vpwp50DtoTarget(context, rain.key, {
    scope: "area",
    name: "健全地域",
    parentAreaName: "健全地域",
    areaCode: "299999",
    localCode: null,
    endsAtMs: VPWP50_TEST_NOW_MS + 9 * VPWP50_DTO_HOUR_MS,
  })];
  return vpwp50DtoProjection(context, [rain]);
}

function vpwp50DtoPersistedState(
  projections: PersistedWeatherWarningForecastStateV1[],
): PersistedStandbyStateV1 {
  return state({
    savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
    heat: [{
      key: "heat:2026-06-06",
      sourceEventIds: ["vpwp50-dto-companion-heat"],
      targetDate: "2026-06-06",
      targetDateEndMs: Date.parse("2026-06-07T00:00:00+09:00"),
      areas: [{ areaName: "東京都", isSpecial: false }],
      isSpecial: false,
      revision: { reportTimeMs: VPWP50_TEST_NOW_MS - 2 * VPWP50_DTO_HOUR_MS, serial: "1" },
    }],
    seen: [{
      key: "heat:2026-06-06",
      revision: { reportTimeMs: VPWP50_TEST_NOW_MS - 2 * VPWP50_DTO_HOUR_MS, serial: "1" },
      forgetAtMs: VPWP50_TEST_NOW_MS + 24 * VPWP50_DTO_HOUR_MS,
    }],
    weatherWarningForecasts: projections,
  });
}

function overwriteVpwp50DtoV2(
  path: string,
  projections: PersistedWeatherWarningForecastStateV1[],
  reverseInput: boolean,
): void {
  const v2Path = standbyPersistenceV2Path(path);
  const raw = JSON.parse(readFileSync(v2Path, "utf8")) as {
    weatherWarningForecasts?: PersistedWeatherWarningForecastStateV1[];
    telegramFoundation: { standbyDomains: { gateEntries: unknown[] } };
  };
  raw.weatherWarningForecasts = reverseInput
    ? [...projections].reverse().map(reverseVpwp50DtoInput)
    : structuredClone(projections);
  if (reverseInput) raw.telegramFoundation.standbyDomains.gateEntries.reverse();
  writeFileSync(v2Path, JSON.stringify(raw), "utf8");
}

function rawBriefingDisplayKey(source: "vpbs50" | "vpoa50", sourceEventId: string): string {
  return `card:briefing:${JSON.stringify(["raw", source, sourceEventId])}`;
}

function briefingUnit(options: {
  source?: "vpbs50" | "vpoa50";
  sourceEventId?: string;
  semanticKey?: string | null;
  phenomenonKind?: "linearRainObserved" | "linearRainPredicted" | "recordRain" | "shortSnow" | null;
  editorialOffice?: string;
  frameLevel?: "critical" | "cancel";
  revision?: { reportTimeMs: number; serial: string } | null;
  generation?: number;
  updatedAtMs?: number;
  expiresAtMs?: number;
} = {}): PersistedBriefingCriticalEntryV1 {
  const source = options.source ?? "vpbs50";
  const sourceEventId = options.sourceEventId ?? "briefing-event-1";
  const editorialOffice = options.editorialOffice ?? "試験地方気象台";
  const phenomenonKind = options.phenomenonKind === undefined ? "recordRain" : options.phenomenonKind;
  const semanticKey = options.semanticKey === undefined
    ? `card:vpbs:semantic:${phenomenonKind}:${editorialOffice}`
    : options.semanticKey;
  const revision = options.revision === undefined ? { reportTimeMs: T0, serial: "3" } : options.revision;
  const updatedAtMs = options.updatedAtMs ?? T0;
  const expiresAtMs = options.expiresAtMs ?? T0 + 60 * 60_000;
  const entry: DisplayBriefingEntryV1 = {
    key: semanticKey ?? rawBriefingDisplayKey(source, sourceEventId),
    source,
    sourceEventId,
    editorialOffice,
    phenomenonKind,
    semanticKey,
    serial: revision?.serial ?? null,
    title: "記録的短時間大雨情報",
    headline: "試験地方で記録的な大雨",
    conditions: ["警戒"],
    targetAreas: [{ name: "試験地方", code: "999999" }],
    reportDateTime: revision == null ? "" : new Date(revision.reportTimeMs).toISOString(),
    publishingOffice: editorialOffice,
    infoType: options.frameLevel === "cancel" ? "取消" : "発表",
    frameLevel: options.frameLevel ?? "critical",
    severityEvidence: [{
      source: "test", condition: null, tag: "recordRain", displaySeverity: "officialL5",
      soundLevel: null, severity: null, phenomenonCode: null, kindCode: null, levelCode: null, status: null,
    }],
    summary: {
      mode: options.frameLevel === "cancel" ? "cancellation" : "structured",
      hasUnknownKind: false,
      items: [{
        kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0,
        facts: [{
          kind: "precipitation", locationName: "試験市", locationCode: "999999",
          description: "1時間雨量", value: 100, unit: "mm", at: new Date(T0).toISOString(),
          duration: "1時間", approximation: "exact",
        }],
      }],
    },
    qualifier: null,
    updatedAt: new Date(updatedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    generation: options.generation ?? 1,
  };
  return { entry, updatedAtMs, expiresAtMs };
}

function rawBriefingUnit(sourceEventId: string, source: "vpbs50" | "vpoa50" = "vpoa50"):
PersistedBriefingCriticalEntryV1 {
  return briefingUnit({
    source, sourceEventId, semanticKey: null, phenomenonKind: null, editorialOffice: "",
    revision: { reportTimeMs: T0, serial: "3" },
  });
}

function semanticBriefingSlice(): PersistedBriefingCriticalStateV1 {
  const unit = briefingUnit();
  return {
    generation: 1,
    entries: [unit],
    cancellations: [],
    watermarks: [{
      semanticKey: unit.entry.semanticKey!,
      revision: { reportTimeMs: T0, serial: "3" },
      expiresAtMs: T0 + 60 * 60_000,
    }],
  };
}

function rootHeat(key: string, targetDate: string): PersistedStandbyStateV1["heat"][number] {
  return {
    key,
    sourceEventIds: [`${key}-source`],
    targetDate,
    targetDateEndMs: Date.parse(`${targetDate}T23:59:59+09:00`),
    areas: [{ areaName: "東京都", isSpecial: false }],
    isSpecial: false,
    revision: { reportTimeMs: T0, serial: "1" },
  };
}

function rootTyphoon(key: string): PersistedStandbyStateV1["typhoons"][number] {
  return {
    key: `typhoon:${key}`,
    sourceEventId: `${key}-source`,
    typhoon: {
      typhoonKey: key,
      name: "Alpha",
      nameKana: null,
      remark: null,
      typhoonNumber: "2601",
      category: "TS",
      location: "ocean",
      pressureHpa: 990,
      maxWindMs: 25,
      maxGustMs: null,
      moveDirection: "N",
      moveSpeedKmh: 20,
      reportDateTime: new Date(T0).toISOString(),
    },
    revision: { reportTimeMs: T0, serial: "1" },
    expiresAtMs: T0 + 24 * 60 * 60_000,
  };
}

function rootVolcano(code: string): PersistedStandbyStateV1["volcanoes"][number] {
  return {
    code,
    name: `Volcano ${code}`,
    alertLevel: null,
    alertClass: null,
    warningKind: null,
    targetKinds: [],
    alertExpiresAtMs: null,
    latestEvent: null,
    latestEventId: null,
    eventExpiresAtMs: null,
    sourceEventIds: [`volcano-${code}`],
    alertRevision: null,
    eventRevision: null,
  };
}

function rootTornado(office: string): NonNullable<PersistedStandbyStateV1["tornado"]>[number] {
  return {
    publishingOffice: office,
    sourceEventId: `tornado-${office}`,
    areas: ["東京都"],
    isSighted: false,
    revision: { reportTimeMs: T0, serial: "1" },
    expiresAtMs: T0 + 60 * 60_000,
  };
}

function rootLongPeriod(eventId: string, hosted = false): NonNullable<PersistedStandbyStateV1["longPeriod"]>[number] {
  return {
    eventId,
    maxLgInt: "3",
    safetyRank: 3,
    revision: { reportTimeMs: T0, serial: "1" },
    hosted,
    expiresAtMs: T0 + 60 * 60_000,
  };
}

function rootSeen(key: string): PersistedStandbyStateV1["seen"][number] {
  return {
    key,
    revision: { reportTimeMs: T0, serial: "1" },
    forgetAtMs: T0 + 24 * 60 * 60_000,
  };
}

type TyphoonDeltaField = "pressure" | "maxWind";

function numericValue(value: number): SpecialValue<number> {
  return {
    raw: String(value),
    value,
    condition: null,
    description: null,
    presence: "value",
  };
}

function transitionSpecialValue(
  presence: "missing" | "empty" | "qualitative" | "range",
): SpecialValue<number> {
  switch (presence) {
    case "missing":
      return { raw: null, value: null, condition: null, description: null, presence };
    case "empty":
      return { raw: "", value: null, condition: null, description: null, presence };
    case "qualitative":
      return {
        raw: "ほとんど停滞",
        value: null,
        condition: "ほとんど停滞",
        description: null,
        presence,
      };
    case "range":
      return {
        raw: "25",
        value: null,
        condition: "以上",
        description: null,
        presence,
        lowerBound: 25,
        rawLowerBound: "25",
      };
  }
}

function typhoonTransitionEvent(
  serial: string,
  field: TyphoonDeltaField,
  target: SpecialValue<number>,
): PresentationEvent {
  const missing = transitionSpecialValue("missing");
  const pressureHpaValue = field === "pressure" ? target : missing;
  const maxWindMsValue = field === "maxWind" ? target : missing;
  const reportDateTime = new Date(T0 + (Number(serial) - 1) * 60_000).toISOString();
  return {
    id: `typhoon-${field}-${serial}`,
    domain: "typhoonAnalysis",
    eventId: "TC-transition",
    serial,
    reportDateTime,
    isCancellation: false,
    raw: {
      type: "VPTW60",
      infoType: "発表",
      eventId: "TC-transition",
      serial,
      name: { name: "Alpha", nameKana: "ALPHA", number: "2601", remark: null },
      frames: [{
        kind: "analysis",
        typhoonClass: { category: "TS" },
        center: {
          location: "ocean",
          pressureHpa: pressureHpaValue.presence === "value" ? pressureHpaValue.value : null,
          pressureHpaValue,
          moveDirection: "N",
          moveSpeedKmh: 20,
          moveSpeedKmhValue: numericValue(20),
        },
        wind: {
          maxWindMs: maxWindMsValue.presence === "value" ? maxWindMsValue.value : null,
          maxWindMsValue,
          maxGustMs: null,
          maxGustMsValue: missing,
        },
      }],
      lifecycle: "active",
    },
  } as unknown as PresentationEvent;
}

function expectNoTyphoonNumericTrend(store: StandbyStateStore): void {
  const typhoon = store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0];
  expect(typhoon).toMatchObject({
    pressureDeltaHpa: null,
    maxWindDeltaMs: null,
    intensityTrend: null,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operational fixture explicit replacement guard", () => {
  it.each([
    ["field removal", { nested: { keep: 1, removed: 2 } }, { nested: { keep: 1 } }, ["/nested/removed"]],
    ["field addition", { nested: { keep: 1 } }, { nested: { keep: 1, added: 2 } }, ["/nested/added"]],
    ["array shortening", { items: [1, 2] }, { items: [1] }, ["/items"]],
    ["array extension", { items: [1] }, { items: [1, 2] }, ["/items"]],
  ] as const)("%s は allowlist 外変更として検出する", (_name, source, target, expected) => {
    expect(explicitPrimitiveReplacements(source, target)).toEqual(expected);
  });
});

describe("VPWP50 persistence coupling and salvage", () => {
  it("dual-writes and reloads a coupled projection, gate, seen mirror, and restored card", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const path = tempPath();
    const projection = vpwp50PersistenceProjection();
    const foundation = vpwp50PersistenceFoundation(projection);
    const persistence = new StandbyPersistence(path, undefined, () => foundation);
    persistence.save(state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
      heat: [],
      seen: [],
      weatherWarningForecasts: [projection],
    }));

    const loaded = persistence.load();
    expect(loaded?.weatherWarningForecasts).toEqual([projection]);
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual(
      expect.arrayContaining([expect.objectContaining({
        stateSubjectKey: projection.subjectKey,
        cancelled: false,
        semanticKeys: [projection.appliedSemanticKey],
      })]),
    );
    const v1 = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const v2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as Record<string, unknown>;
    expect(v1.weatherWarningForecasts).toEqual([projection]);
    expect(v1.weatherWarningForecastGateMetadata).toEqual(expect.any(Array));
    expect(v1.seen).toEqual(expect.arrayContaining([expect.objectContaining({ key: projection.subjectKey })]));
    expect(v2.weatherWarningForecasts).toEqual([projection]);

    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, VPWP50_TEST_NOW_MS);
    const card = restored.snapshotItems().find((item) => item.kind === "weatherWarningForecast");
    expect(card).toMatchObject({ restored: true, key: "weatherWarningForecast:active" });
  });

  it("C-1 discards a missing-key projection and creates only a strict synthetic tombstone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const path = tempPath();
    const projection = vpwp50PersistenceProjection();
    const missingKey = { ...structuredClone(projection) } as Record<string, unknown>;
    Reflect.deleteProperty(missingKey, "appliedSemanticKey");
    (missingKey.revision as { serial: string | null }).serial = "01";
    const raw = state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
      heat: [],
      weatherWarningForecasts: [missingKey as unknown as PersistedWeatherWarningForecastStateV1],
      seen: [{
        key: projection.subjectKey,
        revision: { reportTimeMs: projection.revision.reportTimeMs, serial: "01" },
        forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
      }],
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherWarningForecasts).toBeUndefined();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: projection.subjectKey,
        cancelled: true,
        semanticKeys: [],
        acceptedAtMs: VPWP50_TEST_NOW_MS,
      }),
    ]);
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, VPWP50_TEST_NOW_MS);
    expect(restored.snapshotItems().some((item) => item.kind === "weatherWarningForecast")).toBe(false);
  });

  it("canonicalizes lossless v1 metadata offset and zero-padded serial across two reloads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const path = tempPath();
    const projection = vpwp50PersistenceProjection();
    const gate = structuredClone(vpwp50PersistenceFoundation(projection)
      .standbyDomains!.gateEntries[0]!);
    const localReport = new Date(projection.revision.reportTimeMs + 9 * 60 * 60_000)
      .toISOString().replace("Z", "+09:00");
    gate.comparison.revision.reportDateTime.raw = localReport;
    gate.comparison.revision.serial = { raw: "01", numeric: 1, valid: true };
    const raw = {
      ...state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [],
        weatherWarningForecasts: [projection],
        seen: [{
          key: projection.subjectKey,
          revision: { reportTimeMs: projection.revision.reportTimeMs, serial: "01" },
          forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
        }],
      }),
      weatherWarningForecastGateMetadata: [{
        stateSubjectKey: projection.subjectKey,
        comparison: gate.comparison,
        semanticKeys: gate.semanticKeys,
        cancelled: gate.cancelled,
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw), "utf8");

    const persistence = new StandbyPersistence(path);
    const migrated = persistence.load();
    const migratedGate = migrated?.telegramFoundation.standbyDomains.gateEntries[0];
    expect(migrated?.weatherWarningForecasts).toEqual([projection]);
    expect(migratedGate?.comparison.revision.reportDateTime.raw)
      .toBe(new Date(projection.revision.reportTimeMs).toISOString());
    expect(migratedGate?.comparison.revision.serial).toEqual({ raw: "1", numeric: 1, valid: true });

    persistence.save(migrated!);
    const v2Reload = new StandbyPersistence(path).load();
    expect(v2Reload?.telegramFoundation.standbyDomains.gateEntries[0])
      .toEqual(migratedGate);
    rmSync(standbyPersistenceV2Path(path));
    const v1Reload = new StandbyPersistence(path).load();
    expect(v1Reload?.telegramFoundation.standbyDomains.gateEntries[0])
      .toEqual(migratedGate);
    expect(v1Reload?.weatherWarningForecasts).toEqual([projection]);
  });

  it("rejects a v1 metadata ISO whose calendar fields normalize to another instant spelling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const path = tempPath();
    const projection = vpwp50PersistenceProjection();
    const gate = structuredClone(vpwp50PersistenceFoundation(projection)
      .standbyDomains!.gateEntries[0]!);
    const invalidCalendarIso = "2026-02-30T00:00:00+09:00";
    gate.comparison.revision.reportDateTime = {
      raw: invalidCalendarIso,
      epochMs: Date.parse(invalidCalendarIso),
      valid: true,
    };
    const raw = {
      ...state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [],
        seen: [],
        weatherWarningForecasts: [],
      }),
      weatherWarningForecastGateMetadata: [{
        stateSubjectKey: projection.subjectKey,
        comparison: gate.comparison,
        semanticKeys: gate.semanticKeys,
        cancelled: gate.cancelled,
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([]);
    expect(loaded?.weatherWarningForecasts).toBeUndefined();
  });

  it("does not let a malformed duplicate seen claim fall back into C-1", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = vpwp50PersistenceProjection();
    const missingKey = structuredClone(projection) as unknown as Record<string, unknown>;
    Reflect.deleteProperty(missingKey, "appliedSemanticKey");
    const validSeen = {
      key: projection.subjectKey,
      revision: projection.revision,
      forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
    };
    const malformedDuplicate = {
      key: ` ${projection.subjectKey} `,
      revision: null,
      forgetAtMs: validSeen.forgetAtMs,
    };

    for (const seen of [
      [validSeen, malformedDuplicate],
      [malformedDuplicate, validSeen],
    ]) {
      const path = tempPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [],
        weatherWarningForecasts: [missingKey as unknown as PersistedWeatherWarningForecastStateV1],
        seen: seen as PersistedStandbyStateV1["seen"],
      })), "utf8");
      const loaded = new StandbyPersistence(path).load();
      expect(loaded?.weatherWarningForecasts).toBeUndefined();
      expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([]);
    }
  });

  it("migrates projection-free seen-only state only when the metadata root is absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = vpwp50PersistenceProjection();
    const seen = [{
      key: projection.subjectKey,
      revision: { reportTimeMs: projection.revision.reportTimeMs, serial: "01" },
      forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
    }];
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
      heat: [],
      seen,
    })), "utf8");
    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherWarningForecasts).toBeUndefined();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: projection.subjectKey,
        cancelled: true,
        semanticKeys: [],
        comparison: expect.objectContaining({
          revision: expect.objectContaining({
            infoType: { raw: "取消", value: "取消", valid: true },
            serial: { raw: "1", numeric: 1, valid: true },
          }),
        }),
      }),
    ]);
  });

  it("does not treat an explicit empty metadata array as C-1 metadata absence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const path = tempPath();
    const projection = vpwp50PersistenceProjection();
    const missingKey = { ...structuredClone(projection) } as Record<string, unknown>;
    Reflect.deleteProperty(missingKey, "appliedSemanticKey");
    (missingKey.revision as { serial: string | null }).serial = "01";
    const raw = {
      ...state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [],
        weatherWarningForecasts: [missingKey as unknown as PersistedWeatherWarningForecastStateV1],
        seen: [{
          key: projection.subjectKey,
          revision: projection.revision,
          forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
        }],
      }),
      weatherWarningForecastGateMetadata: [],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw), "utf8");
    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherWarningForecasts).toBeUndefined();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([]);
  });

  it("keeps every present metadata root shape out of legacy and C-1 fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = vpwp50PersistenceProjection();
    const missingKey = structuredClone(projection) as unknown as Record<string, unknown>;
    Reflect.deleteProperty(missingKey, "appliedSemanticKey");
    const gate = structuredClone(vpwp50PersistenceFoundation(projection)
      .standbyDomains!.gateEntries[0]!);
    const metadata = {
      stateSubjectKey: projection.subjectKey,
      comparison: gate.comparison,
      semanticKeys: gate.semanticKeys,
      cancelled: gate.cancelled,
    };
    const unrelated = structuredClone(metadata);
    const unrelatedSubject = "weatherTimeseries:unrelated:000000";
    unrelated.stateSubjectKey = unrelatedSubject;
    unrelated.comparison.stateSubjectKey = unrelatedSubject;
    unrelated.comparison.revision.eventId = {
      raw: unrelatedSubject, value: unrelatedSubject, valid: true,
    };
    const roots: readonly [string, unknown][] = [
      ["nonmatching present-array", [unrelated]],
      ["malformed claimed present-array", [{ ...metadata, comparison: null }]],
      ["duplicate claimed present-array", [metadata, structuredClone(metadata)]],
      ["normalized duplicate claimed present-array", [
        metadata,
        { ...structuredClone(metadata), stateSubjectKey: ` ${projection.subjectKey} `, comparison: null },
      ]],
      ["explicit null", null],
      ["object", {}],
      ["scalar", "invalid"],
      ["boolean", false],
      ["number", 1],
    ];
    for (const [name, metadataRoot] of roots) {
      const path = tempPath();
      const raw: Record<string, unknown> = {
        ...state({
          savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
          heat: [],
          weatherWarningForecasts: [missingKey as unknown as PersistedWeatherWarningForecastStateV1],
          seen: [{
            key: projection.subjectKey,
            revision: projection.revision,
            forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
          }],
        }),
        weatherWarningForecastGateMetadata: metadataRoot,
      };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(raw), "utf8");
      const loaded = new StandbyPersistence(path).load();
      expect(loaded?.weatherWarningForecasts, name).toBeUndefined();
      expect(loaded?.telegramFoundation.standbyDomains.gateEntries, name).toEqual([]);
    }
  });

  it("salvages a malformed max-expiry child only while a deep-valid outer witness remains", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const path = tempPath();
    const projection = vpwp50PersistenceProjection();
    const foundation = vpwp50PersistenceFoundation(projection);
    new StandbyPersistence(path, undefined, () => foundation).save(state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
      heat: [],
      seen: [],
      weatherWarningForecasts: [projection],
    }));
    const original = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as {
      weatherWarningForecasts: PersistedWeatherWarningForecastStateV1[];
    } & Record<string, unknown>;
    const maxEndsAt = new Date(projection.expiresAtMs).toISOString();
    const maxPeriods = original.weatherWarningForecasts[0].groups.flatMap((group) =>
      group.targets.flatMap((target) => target.periods.filter((period) => period.endsAt === maxEndsAt)));
    expect(maxPeriods.length).toBeGreaterThan(1);
    maxPeriods[0]!.key = "malformed";
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(original), "utf8");
    const tiedWitness = new StandbyPersistence(path).load();
    expect(tiedWitness?.weatherWarningForecasts).toHaveLength(1);
    expect(tiedWitness?.weatherWarningForecasts?.[0]?.groups.flatMap((group) =>
      group.targets.flatMap((target) => target.periods)).length).toBe(
      projection.groups.flatMap((group) => group.targets.flatMap((target) => target.periods)).length - 1,
    );

    const withoutWitness = structuredClone(original);
    for (const group of withoutWitness.weatherWarningForecasts[0].groups) for (const target of group.targets) {
      for (const period of target.periods) if (period.endsAt === maxEndsAt) period.key = "malformed";
    }
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(withoutWitness), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const rejected = new StandbyPersistence(path).load();
    expect(rejected?.weatherWarningForecasts).toBeUndefined();
    expect(rejected?.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: projection.subjectKey, cancelled: false }),
    ]);
    const couplingDiagnostic = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("vpwp50SubjectExpiryCouplingRejected"));
    expect(couplingDiagnostic).toContain(`"subjectKey":"${projection.subjectKey}"`);
    expect(couplingDiagnostic).toContain(`"persistedExpiresAtMs":${projection.expiresAtMs}`);
    expect(couplingDiagnostic).toContain(`"excludedChildKinds":["period"]`);
    expect(couplingDiagnostic).toContain(`"excludedChildCount":${maxPeriods.length}`);
    expect(couplingDiagnostic).toContain(
      `"reasons":["removedExpiryWitness","outerDerivedMismatch"]`,
    );
    expect(couplingDiagnostic).toContain(`"canonicalRewriteRequired":true`);
  });

  it("reports simultaneous invalid-outer and unknown-child coupling reasons in canonical order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const path = tempPath();
    const projection = vpwp50PersistenceProjection();
    const foundation = vpwp50PersistenceFoundation(projection);
    new StandbyPersistence(path, undefined, () => foundation).save(state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
      heat: [],
      seen: [],
      weatherWarningForecasts: [projection],
    }));
    const raw = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as {
      weatherWarningForecasts: PersistedWeatherWarningForecastStateV1[];
    } & Record<string, unknown>;
    raw.weatherWarningForecasts[0]!.expiresAtMs = 8_640_000_000_000_001;
    raw.weatherWarningForecasts[0]!.groups[0]!.targets[0]!.periods[0]!.endsAt = "invalid";
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(raw), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherWarningForecasts).toBeUndefined();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: projection.subjectKey, cancelled: false }),
    ]);
    const diagnostic = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("vpwp50SubjectExpiryCouplingRejected"));
    expect(diagnostic).toContain(`"persistedExpiresAtMs":null`);
    expect(diagnostic).toContain(`"excludedUnknownEndsAtCount":1`);
    expect(diagnostic).toContain(`"excludedChildKinds":["period"]`);
    expect(diagnostic).toContain(`"excludedChildCount":1`);
    expect(diagnostic).toContain(
      `"reasons":["invalidOuterExpiry","removedExpiryWitness"]`,
    );
    expect(diagnostic).not.toContain("outerDerivedMismatch");
  });

  it("salvages persisted Area/Local identity conflicts across every group independent of DTO input order and rewrite", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const areaContext = vpwp50DtoContext("area-conflict");
    const localContext = vpwp50DtoContext("local-conflict");
    const healthyContext = vpwp50DtoContext("healthy-subject");
    const areaSeed = vpwp50HealthyDto(areaContext);
    const localSeed = vpwp50HealthyDto(localContext);
    const healthy = vpwp50HealthyDto(healthyContext);
    const seeds = [areaSeed, localSeed, healthy];
    const areaConflict = vpwp50AreaConflictDto(areaContext);
    const localConflict = vpwp50LocalConflictDto(localContext);
    const areaSnowKey = vpwp50DtoGroup("雪", "30").key;
    const localSnowKey = areaSnowKey;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const outcomes: Array<{
      forecasts: PersistedWeatherWarningForecastStateV1[] | undefined;
      gates: unknown[];
      diagnostics: string[];
      heat: PersistedStandbyStateV1["heat"];
    }> = [];

    for (const reverseInput of [false, true]) {
      const path = tempPath();
      const foundation = vpwp50DtoFoundation(seeds);
      const initial = new StandbyPersistence(path, undefined, () => foundation);
      expect(initial.save(vpwp50DtoPersistedState(seeds)).kind).toBe("written");
      overwriteVpwp50DtoV2(path, [areaConflict, localConflict, healthy], reverseInput);
      warn.mockClear();

      const persistence = new StandbyPersistence(path);
      const loaded = persistence.load(VPWP50_TEST_NOW_MS);
      if (loaded == null) throw new Error("VPWP50 DTO conflict fixture did not load");
      const area = loaded.weatherWarningForecasts?.find((entry) =>
        entry.subjectKey === areaContext.subjectKey);
      const local = loaded.weatherWarningForecasts?.find((entry) =>
        entry.subjectKey === localContext.subjectKey);
      const retainedHealthy = loaded.weatherWarningForecasts?.find((entry) =>
        entry.subjectKey === healthyContext.subjectKey);
      if (area == null || local == null) throw new Error("VPWP50 conflict subject was over-salvaged");

      const areaTargets = area.groups.flatMap((group) => group.targets);
      expect(areaTargets.some((target) => target.areaCode === "200010")).toBe(false);
      expect(areaTargets.filter((target) => target.areaCode === "200020")).toHaveLength(2);
      expect(areaTargets.filter((target) => target.areaCode == null).map((target) => target.name).sort())
        .toEqual(["無コード北", "無コード南"]);
      expect(area.groups.some((group) => group.key === areaSnowKey)).toBe(false);
      expect(area.expiresAtMs).toBe(VPWP50_TEST_NOW_MS + 8 * VPWP50_DTO_HOUR_MS);

      const localTargets = local.groups.flatMap((group) => group.targets);
      expect(localTargets.some((target) => target.localCode === "001")).toBe(false);
      expect(localTargets.filter((target) =>
        target.scope === "area" && target.areaCode === "200010")).toHaveLength(2);
      expect(localTargets.filter((target) => target.localCode === "002").map((target) => target.name))
        .toEqual(["安曇地域"]);
      expect(localTargets.filter((target) =>
        target.scope === "local" && target.localCode == null).map((target) => target.name).sort())
        .toEqual(["無コード地域A", "無コード地域B"]);
      expect(local.groups.some((group) => group.key === localSnowKey)).toBe(false);
      expect(local.expiresAtMs).toBe(VPWP50_TEST_NOW_MS + 8 * VPWP50_DTO_HOUR_MS);

      expect(retainedHealthy).toEqual(healthy);
      expect(loaded.heat).toEqual(vpwp50DtoPersistedState(seeds).heat);
      const vpwp50Gates = loaded.telegramFoundation.standbyDomains.gateEntries
        .filter((entry) => entry.revisionFamily === "VPWP50");
      expect(vpwp50Gates.map((entry) => entry.stateSubjectKey).sort()).toEqual(
        [areaContext.subjectKey, healthyContext.subjectKey, localContext.subjectKey].sort(),
      );
      expect(vpwp50Gates.every((entry) => !entry.cancelled)).toBe(true);

      const diagnostics = warn.mock.calls.map(([message]) => String(message))
        .filter((message) => message.includes("vpwp50PersistedAreaIdentityConflict")
          || message.includes("vpwp50PersistedLocalIdentityConflict"))
        .sort();
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.find((message) => message.includes(areaContext.subjectKey)))
        .toContain('identities=["code:200010"]');
      expect(diagnostics.find((message) => message.includes(localContext.subjectKey)))
        .toContain('identities=["code:200010\\u0000code:001"]');

      expect(persistence.hasPendingSalvageRepair()).toBe(true);
      expect(persistence.save(loaded).kind).toBe("written");
      warn.mockClear();
      const reloaded = new StandbyPersistence(path).load(VPWP50_TEST_NOW_MS);
      expect(reloaded?.weatherWarningForecasts).toEqual(loaded.weatherWarningForecasts);
      expect(reloaded?.heat).toEqual(loaded.heat);
      expect(warn.mock.calls.map(([message]) => String(message)).some((message) =>
        message.includes("vpwp50PersistedAreaIdentityConflict")
        || message.includes("vpwp50PersistedLocalIdentityConflict"))).toBe(false);

      outcomes.push({
        forecasts: loaded.weatherWarningForecasts,
        gates: vpwp50Gates,
        diagnostics,
        heat: loaded.heat,
      });
    }

    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it.each(["area", "local"] as const)(
    "rejects a %s identity conflict that owns the outer expiry witness and preserves its active gate across rewrite",
    (conflictKind) => {
      vi.useFakeTimers();
      vi.setSystemTime(VPWP50_TEST_NOW_MS);
      const conflictContext = vpwp50DtoContext(`expiry-${conflictKind}`);
      const healthyContext = vpwp50DtoContext(`expiry-${conflictKind}-healthy`);
      const seed = vpwp50HealthyDto(conflictContext);
      const healthy = vpwp50HealthyDto(healthyContext);
      const conflict = conflictKind === "area"
        ? vpwp50AreaConflictDto(conflictContext, true)
        : vpwp50LocalConflictDto(conflictContext, true);
      const seeds = [seed, healthy];
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const outcomes: Array<{
        forecasts: PersistedWeatherWarningForecastStateV1[] | undefined;
        gate: unknown;
        diagnostic: string | undefined;
        heat: PersistedStandbyStateV1["heat"];
      }> = [];

      for (const reverseInput of [false, true]) {
        const path = tempPath();
        const foundation = vpwp50DtoFoundation(seeds);
        expect(new StandbyPersistence(path, undefined, () => foundation)
          .save(vpwp50DtoPersistedState(seeds)).kind).toBe("written");
        overwriteVpwp50DtoV2(path, [conflict, healthy], reverseInput);
        warn.mockClear();

        const persistence = new StandbyPersistence(path);
        const loaded = persistence.load(VPWP50_TEST_NOW_MS);
        if (loaded == null) throw new Error("VPWP50 expiry witness fixture did not load");
        expect(loaded.weatherWarningForecasts?.some((entry) =>
          entry.subjectKey === conflictContext.subjectKey)).toBe(false);
        expect(loaded.weatherWarningForecasts?.find((entry) =>
          entry.subjectKey === healthyContext.subjectKey)).toEqual(healthy);
        expect(loaded.heat).toEqual(vpwp50DtoPersistedState(seeds).heat);
        const gate = loaded.telegramFoundation.standbyDomains.gateEntries.find((entry) =>
          entry.revisionFamily === "VPWP50"
          && entry.stateSubjectKey === conflictContext.subjectKey);
        expect(gate).toMatchObject({ cancelled: false, semanticKeys: [conflict.appliedSemanticKey] });
        const diagnostic = warn.mock.calls.map(([message]) => String(message)).find((message) =>
          message.includes("vpwp50SubjectExpiryCouplingRejected")
          && message.includes(conflictContext.subjectKey));
        expect(diagnostic).toContain(`"persistedExpiresAtMs":${VPWP50_TEST_NOW_MS + 8 * VPWP50_DTO_HOUR_MS}`);
        expect(diagnostic).toContain(`"retainedMaxEndsAtMs":${VPWP50_TEST_NOW_MS + 7 * VPWP50_DTO_HOUR_MS}`);
        expect(diagnostic).toContain('"excludedChildKinds":["target"]');
        expect(diagnostic).toContain('"reasons":["removedExpiryWitness","outerDerivedMismatch"]');
        expect(diagnostic).toContain('"canonicalRewriteRequired":true');

        expect(persistence.hasPendingSalvageRepair()).toBe(true);
        expect(persistence.save(loaded).kind).toBe("written");
        warn.mockClear();
        const reloaded = new StandbyPersistence(path).load(VPWP50_TEST_NOW_MS);
        expect(reloaded?.weatherWarningForecasts).toEqual(loaded.weatherWarningForecasts);
        expect(reloaded?.telegramFoundation.standbyDomains.gateEntries.find((entry) =>
          entry.revisionFamily === "VPWP50"
          && entry.stateSubjectKey === conflictContext.subjectKey)).toEqual(gate);
        expect(reloaded?.heat).toEqual(loaded.heat);
        expect(warn.mock.calls.map(([message]) => String(message)).some((message) =>
          message.includes("vpwp50PersistedAreaIdentityConflict")
          || message.includes("vpwp50PersistedLocalIdentityConflict"))).toBe(false);

        outcomes.push({ forecasts: loaded.weatherWarningForecasts, gate, diagnostic, heat: loaded.heat });
      }

      expect(outcomes[1]).toEqual(outcomes[0]);
    },
  );

  it("salvages an external 513-bundle file deterministically and makes the writer fail loud", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = vpwp50PersistenceProjection();
    const template = vpwp50PersistenceFoundation(projection)
      .standbyDomains!.gateEntries[0]!;
    const gates = Array.from({ length: 513 }, (_, index) => {
      const stateSubjectKey = `weatherTimeseries:capacity:${String(index).padStart(3, "0")}`;
      const gate = structuredClone(template);
      gate.stateSubjectKey = stateSubjectKey;
      gate.comparison.stateSubjectKey = stateSubjectKey;
      gate.comparison.revision.eventId = {
        raw: stateSubjectKey, value: stateSubjectKey, valid: true,
      };
      gate.acceptedAtMs = VPWP50_TEST_NOW_MS - index;
      gate.legacyRevisionKey = stateSubjectKey;
      return gate;
    });
    const expectedSubjects = gates.slice(0, 512).map((gate) => gate.stateSubjectKey).sort();

    for (const ordered of [gates, [...gates].reverse()]) {
      const path = tempPath();
      const baselineFoundation = vpwp50PersistenceFoundation(projection);
      baselineFoundation.standbyDomains!.gateEntries = [structuredClone(template)];
      new StandbyPersistence(path, undefined, () => baselineFoundation).save(state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(), heat: [], seen: [],
      }));
      const rawV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as {
        telegramFoundation: { standbyDomains: { gateEntries: typeof gates } };
      };
      rawV2.telegramFoundation.standbyDomains.gateEntries = structuredClone(ordered);
      writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(rawV2), "utf8");
      const loaded = new StandbyPersistence(path).load();
      const retained = loaded?.telegramFoundation.standbyDomains.gateEntries
        .filter((gate) => gate.revisionFamily === "VPWP50")
        .map((gate) => gate.stateSubjectKey)
        .sort();
      expect(retained).toEqual(expectedSubjects);
      expect(retained).not.toContain(gates[512]!.stateSubjectKey);
    }

    const path = tempPath();
    const baselineFoundation = vpwp50PersistenceFoundation(projection);
    baselineFoundation.standbyDomains!.gateEntries = [structuredClone(template)];
    const baselinePersistence = new StandbyPersistence(path, undefined, () => baselineFoundation);
    baselinePersistence.save(state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(), heat: [], seen: [],
    }));
    const beforeV1 = readFileSync(path, "utf8");
    const beforeV2 = readFileSync(standbyPersistenceV2Path(path), "utf8");
    const overflowingFoundation = vpwp50PersistenceFoundation(projection);
    overflowingFoundation.standbyDomains!.gateEntries = structuredClone(gates);
    const writer = new StandbyPersistence(path, undefined, () => overflowingFoundation);
    const result = writer.save(state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(), heat: [], seen: [],
    }));
    expect(result).toMatchObject({ kind: "failed", stage: "validation" });
    expect(result.kind === "failed" ? result.cause : null)
      .toEqual(expect.objectContaining({ message: "VPWP50 persistence subject capacity exceeded" }));
    expect(readFileSync(path, "utf8")).toBe(beforeV1);
    expect(readFileSync(standbyPersistenceV2Path(path), "utf8")).toBe(beforeV2);
  });

  it("applies every VPWP50 raw source hard limit before candidate salvage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = vpwp50PersistenceProjection();
    const gate = structuredClone(vpwp50PersistenceFoundation(projection)
      .standbyDomains!.gateEntries[0]!);
    const metadata = {
      stateSubjectKey: projection.subjectKey,
      comparison: gate.comparison,
      semanticKeys: gate.semanticKeys,
      cancelled: gate.cancelled,
    };
    const seen = {
      key: projection.subjectKey,
      revision: projection.revision,
      forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
    };
    const baseRaw = (): Record<string, unknown> => ({
      ...state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [],
        weatherWarningForecasts: [projection],
        seen: [seen],
      }),
      weatherWarningForecastGateMetadata: [metadata],
    });
    const loadV1 = (raw: Record<string, unknown>) => {
      const path = tempPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(raw), "utf8");
      return new StandbyPersistence(path).load();
    };
    const expectActive = (loaded: ReturnType<StandbyPersistence["load"]>) => {
      expect(loaded?.weatherWarningForecasts).toHaveLength(1);
      expect(loaded?.telegramFoundation.standbyDomains.gateEntries
        .filter((entry) => entry.revisionFamily === "VPWP50")).toHaveLength(1);
    };
    const expectRejected = (loaded: ReturnType<StandbyPersistence["load"]>) => {
      expect(loaded?.weatherWarningForecasts).toBeUndefined();
      expect(loaded?.telegramFoundation.standbyDomains.gateEntries
        .filter((entry) => entry.revisionFamily === "VPWP50")).toEqual([]);
    };

    for (const count of [1_024, 1_025]) {
      const projectionRaw = baseRaw();
      projectionRaw.weatherWarningForecasts = [
        projection,
        ...Array.from({ length: count - 1 }, () => null),
      ];
      (count === 1_024 ? expectActive : expectRejected)(loadV1(projectionRaw));

      const metadataRaw = baseRaw();
      metadataRaw.weatherWarningForecastGateMetadata = [
        metadata,
        ...Array.from({ length: count - 1 }, () => null),
      ];
      (count === 1_024 ? expectActive : expectRejected)(loadV1(metadataRaw));

      const seenRaw = baseRaw();
      seenRaw.seen = [
        seen,
        ...Array.from({ length: count - 1 }, (_, index) => ({
          key: `weatherTimeseries:padding:${index}`,
          revision: null,
          forgetAtMs: 0,
        })),
      ];
      (count === 1_024 ? expectActive : expectRejected)(loadV1(seenRaw));

      const path = tempPath();
      const foundation = vpwp50PersistenceFoundation(projection);
      new StandbyPersistence(path, undefined, () => foundation).save(state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [], seen: [], weatherWarningForecasts: [projection],
      }));
      const rawV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as {
        telegramFoundation: { standbyDomains: { gateEntries: unknown[] } };
      };
      rawV2.telegramFoundation.standbyDomains.gateEntries = [
        gate,
        ...Array.from({ length: count - 1 }, (_, index) => ({
          domain: "weatherWarningTimeseries",
          revisionFamily: "VPWP50",
          stateSubjectKey: `weatherTimeseries:padding:${index}`,
        })),
      ];
      writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(rawV2), "utf8");
      (count === 1_024 ? expectActive : expectRejected)(new StandbyPersistence(path).load());
    }
  });

  it("applies the distinct raw bundle 1024/1025 boundary after source preflight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = vpwp50PersistenceProjection();
    const gate = structuredClone(vpwp50PersistenceFoundation(projection)
      .standbyDomains!.gateEntries[0]!);
    const seen = {
      key: projection.subjectKey,
      revision: projection.revision,
      forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
    };

    for (const distinctProjectionSubjects of [1_023, 1_024]) {
      const malformedProjections = Array.from(
        { length: distinctProjectionSubjects },
        (_, index) => ({ subjectKey: `weatherTimeseries:bundle:${String(index).padStart(4, "0")}` }),
      );
      const expectedRetained = distinctProjectionSubjects + 1 === 1_024;

      const v1Path = tempPath();
      mkdirSync(dirname(v1Path), { recursive: true });
      writeFileSync(v1Path, JSON.stringify(state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [],
        weatherWarningForecasts: malformedProjections as unknown as PersistedWeatherWarningForecastStateV1[],
        seen: [seen],
      })), "utf8");
      const v1Loaded = new StandbyPersistence(v1Path).load();
      expect(v1Loaded?.telegramFoundation.standbyDomains.gateEntries
        .filter((entry) => entry.revisionFamily === "VPWP50"), `v1 union ${distinctProjectionSubjects + 1}`)
        .toHaveLength(expectedRetained ? 1 : 0);

      const v2Path = tempPath();
      const foundation = vpwp50PersistenceFoundation(projection);
      foundation.standbyDomains!.gateEntries = [gate];
      new StandbyPersistence(v2Path, undefined, () => foundation).save(state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(), heat: [], seen: [],
      }));
      const rawV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(v2Path), "utf8")) as {
        weatherWarningForecasts?: unknown[];
      };
      rawV2.weatherWarningForecasts = malformedProjections;
      writeFileSync(standbyPersistenceV2Path(v2Path), JSON.stringify(rawV2), "utf8");
      const v2Loaded = new StandbyPersistence(v2Path).load();
      expect(v2Loaded?.telegramFoundation.standbyDomains.gateEntries
        .filter((entry) => entry.revisionFamily === "VPWP50"), `v2 union ${distinctProjectionSubjects + 1}`)
        .toHaveLength(expectedRetained ? 1 : 0);
    }
  });

  it("preflights nested groups, targets, and periods at 1024/1025 before child validation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const original = vpwp50PersistenceProjection();
    const gate = vpwp50PersistenceFoundation(original).standbyDomains!.gateEntries[0]!;
    const isolated = structuredClone(original);
    isolated.groups = [isolated.groups[0]!];
    isolated.groups[0]!.targets = [isolated.groups[0]!.targets[0]!];
    isolated.groups[0]!.targets[0]!.periods = [isolated.groups[0]!.targets[0]!.periods[0]!];
    isolated.expiresAtMs = Date.parse(isolated.groups[0]!.targets[0]!.periods[0]!.endsAt);

    const loadCandidate = (candidate: Record<string, unknown>) => {
      const path = tempPath();
      const foundation = vpwp50PersistenceFoundation(original);
      new StandbyPersistence(path, undefined, () => foundation).save(state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [], seen: [], weatherWarningForecasts: [original],
      }));
      const rawV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as {
        weatherWarningForecasts: unknown[];
      };
      rawV2.weatherWarningForecasts = [candidate];
      writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(rawV2), "utf8");
      return new StandbyPersistence(path).load();
    };
    const assertOutcome = (
      loaded: ReturnType<StandbyPersistence["load"]>,
      retained: boolean,
      label: string,
    ) => {
      if (retained) expect(loaded?.weatherWarningForecasts, label).toHaveLength(1);
      else expect(loaded?.weatherWarningForecasts, label).toBeUndefined();
      expect(loaded?.telegramFoundation.standbyDomains.gateEntries, label).toEqual([
        expect.objectContaining({ stateSubjectKey: gate.stateSubjectKey }),
      ]);
    };

    for (const count of [1_024, 1_025]) {
      const groupsCandidate = structuredClone(original) as unknown as Record<string, unknown>;
      groupsCandidate.groups = [
        original.groups[0]!,
        ...Array.from({ length: count - 1 }, () => null),
      ];
      assertOutcome(loadCandidate(groupsCandidate), count === 1_024, `groups ${count}`);

      const targetsCandidate = structuredClone(isolated) as unknown as Record<string, unknown>;
      const targetsGroup = (targetsCandidate.groups as Record<string, unknown>[])[0]!;
      targetsGroup.targets = [
        isolated.groups[0]!.targets[0]!,
        ...Array.from({ length: count - 1 }, () => null),
      ];
      assertOutcome(loadCandidate(targetsCandidate), count === 1_024, `targets ${count}`);

      const periodsCandidate = structuredClone(isolated) as unknown as Record<string, unknown>;
      const periodsGroup = (periodsCandidate.groups as Record<string, unknown>[])[0]!;
      const periodsTarget = (periodsGroup.targets as Record<string, unknown>[])[0]!;
      const validPeriod = isolated.groups[0]!.targets[0]!.periods[0]!;
      periodsTarget.periods = [
        validPeriod,
        ...Array.from({ length: count - 1 }, () => ({
          ...validPeriod,
          key: "malformed",
        })),
      ];
      assertOutcome(loadCandidate(periodsCandidate), count === 1_024, `periods ${count}`);
    }
  });

  it("does not inspect nested projection containers until v1 or v2 gate coupling succeeds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = structuredClone(vpwp50PersistenceProjection()) as unknown as Record<string, unknown>;
    projection.groups = Array.from({ length: 1_025 }, () => null);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const v1Path = tempPath();
    mkdirSync(dirname(v1Path), { recursive: true });
    writeFileSync(v1Path, JSON.stringify({
      ...state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [],
        seen: [],
        weatherWarningForecasts: [
          projection as unknown as PersistedWeatherWarningForecastStateV1,
        ],
      }),
      weatherWarningForecastGateMetadata: [],
    }), "utf8");
    expect(new StandbyPersistence(v1Path).load()?.weatherWarningForecasts).toBeUndefined();
    expect(warn.mock.calls.flat().join("\n")).not.toContain("vpwp50ReaderNestedRawLimitExceeded");

    warn.mockClear();
    const v2Path = tempPath();
    new StandbyPersistence(v2Path).save(state({
      savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(), heat: [], seen: [],
    }));
    const rawV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(v2Path), "utf8")) as {
      weatherWarningForecasts?: unknown[];
    };
    rawV2.weatherWarningForecasts = [projection];
    writeFileSync(standbyPersistenceV2Path(v2Path), JSON.stringify(rawV2), "utf8");
    expect(new StandbyPersistence(v2Path).load()?.weatherWarningForecasts).toBeUndefined();
    expect(warn.mock.calls.flat().join("\n")).not.toContain("vpwp50ReaderNestedRawLimitExceeded");
  });

  it("preflights the full shared seen and standby-domain containers at 16384/16385", () => {
    vi.useFakeTimers();
    vi.setSystemTime(VPWP50_TEST_NOW_MS);
    const projection = vpwp50PersistenceProjection();
    const gate = structuredClone(vpwp50PersistenceFoundation(projection)
      .standbyDomains!.gateEntries[0]!);
    const metadata = {
      stateSubjectKey: projection.subjectKey,
      comparison: gate.comparison,
      semanticKeys: gate.semanticKeys,
      cancelled: gate.cancelled,
    };
    const seen = {
      key: projection.subjectKey,
      revision: projection.revision,
      forgetAtMs: VPWP50_TEST_NOW_MS + WEATHER_TIMESERIES_RETENTION_MS + 1,
    };
    for (const count of [16_384, 16_385]) {
      const v1Path = tempPath();
      mkdirSync(dirname(v1Path), { recursive: true });
      writeFileSync(v1Path, JSON.stringify({
        ...state({
          savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
          heat: [],
          weatherWarningForecasts: [projection],
          seen: [seen, ...Array.from({ length: count - 1 }, () => null)] as unknown as PersistedStandbyStateV1["seen"],
        }),
        weatherWarningForecastGateMetadata: [metadata],
      }), "utf8");
      const v1Loaded = new StandbyPersistence(v1Path).load();
      if (count === 16_384) {
        expect(v1Loaded?.weatherWarningForecasts, `v1 seen ${count}`).toHaveLength(1);
      } else {
        expect(v1Loaded?.weatherWarningForecasts, `v1 seen ${count}`).toBeUndefined();
      }

      const v2Path = tempPath();
      const foundation = vpwp50PersistenceFoundation(projection);
      new StandbyPersistence(v2Path, undefined, () => foundation).save(state({
        savedAt: new Date(VPWP50_TEST_NOW_MS).toISOString(),
        heat: [], seen: [], weatherWarningForecasts: [projection],
      }));
      const rawV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(v2Path), "utf8")) as {
        telegramFoundation: { standbyDomains: { gateEntries: unknown[] } };
      };
      rawV2.telegramFoundation.standbyDomains.gateEntries = [
        gate,
        ...Array.from({ length: count - 1 }, () => null),
      ];
      writeFileSync(standbyPersistenceV2Path(v2Path), JSON.stringify(rawV2), "utf8");
      const v2Loaded = new StandbyPersistence(v2Path).load();
      if (count === 16_384) {
        expect(v2Loaded?.weatherWarningForecasts, `v2 gates ${count}`).toHaveLength(1);
      } else {
        expect(v2Loaded?.weatherWarningForecasts, `v2 gates ${count}`).toBeUndefined();
      }
    }

    const path = tempPath();
    const baseline = new StandbyPersistence(path);
    baseline.save(state({ heat: [], seen: [] }));
    const beforeV1 = readFileSync(path, "utf8");
    const beforeV2 = readFileSync(standbyPersistenceV2Path(path), "utf8");
    const result = baseline.save(state({
      heat: [],
      seen: Array.from({ length: 16_385 }, (_, index) => ({
        key: `raw:${index}`,
        revision: { reportTimeMs: T0, serial: "1" },
        forgetAtMs: T0 + 1,
      })),
    }));
    expect(result).toMatchObject({ kind: "failed", stage: "validation" });
    expect(readFileSync(path, "utf8")).toBe(beforeV1);
    expect(readFileSync(standbyPersistenceV2Path(path), "utf8")).toBe(beforeV2);

    const oversizedFoundation = vpwp50PersistenceFoundation(projection);
    oversizedFoundation.standbyDomains!.gateEntries = Array.from(
      { length: 16_385 },
      () => structuredClone(gate),
    );
    const gateResult = new StandbyPersistence(
      path,
      undefined,
      () => oversizedFoundation,
    ).save(state({ heat: [], seen: [] }));
    expect(gateResult).toMatchObject({ kind: "failed", stage: "validation" });
    expect(readFileSync(path, "utf8")).toBe(beforeV1);
    expect(readFileSync(standbyPersistenceV2Path(path), "utf8")).toBe(beforeV2);
  });
});

describe("StandbyPersistence", () => {
  it("atomic save と load が往復する", () => {
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(state());
    expect(persistence.load()).toEqual(expect.objectContaining({
      ...state(),
      version: 2,
      telegramFoundation: {
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        vpww56: {
          generation: VPWW56_SNAPSHOT_GENERATION,
          authoritative: false,
          state: null,
          gateEntries: [],
        },
        tsunami: {
          active: null, keyedActive: [], legacyActive: null,
          observations: { VTSE51: [], VTSE52: [] }, gateEntries: [],
        },
        volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
        floodForecast: { authoritative: false, active: [], gateEntries: [] },
        standbyDomains: { gateEntries: [] },
      },
    }));
  });

  it("standalone v1 fallbackのtokenized standby domainを初回v2保存でも維持する", () => {
    const path = tempPath();
    const acceptedAtMs = T0 - 5 * 60_000;
    const dayMs = 24 * 60 * 60_000;
    const heat = {
      ...rootHeat("heat:2026-07-21:東京都", "2026-07-21"),
      appliedSemanticKey: `発表:${"a".repeat(64)}`,
    };
    const typhoon = {
      ...rootTyphoon("TC-A"),
      key: "TC-A",
      appliedSemanticKey: `訂正:${"b".repeat(64)}`,
    };
    const tornado = {
      ...rootTornado("試験地方気象台"),
      appliedSemanticKey: `発表:${"c".repeat(64)}`,
    };
    const longPeriod = {
      ...rootLongPeriod("lg-event"),
      appliedSemanticKey: `発表:${"d".repeat(64)}`,
    };
    const subjects = [
      [heat.key, heat.revision, 3 * dayMs],
      [`typhoon:${typhoon.key}`, typhoon.revision, 7 * dayMs],
      [`tornado:${tornado.publishingOffice}`, tornado.revision, 36 * 60 * 60_000],
      [`longPeriod:${longPeriod.eventId}`, longPeriod.revision, 36 * 60 * 60_000],
    ] as const;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      heat: [heat], typhoons: [typhoon], tornado: [tornado], longPeriod: [longPeriod],
      seen: subjects.map(([key, revision, retentionMs]) => ({
        key, revision, forgetAtMs: acceptedAtMs + retentionMs + 1,
      })),
    })), "utf8");

    const fallbackReader = new StandbyPersistence(path);
    const loaded = fallbackReader.load();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries.map((entry) =>
      entry.stateSubjectKey)).toEqual(subjects.map(([key]) => key));
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries[0]).toMatchObject({
      stateSubjectKey: heat.key,
      comparison: { revision: {
        reportDateTime: { epochMs: heat.revision.reportTimeMs },
        serial: { raw: heat.revision.serial },
      } },
      semanticKeys: [heat.appliedSemanticKey],
    });
    expect(fallbackReader.takeMigrationConflictCount()).toBe(0);

    const { telegramFoundation, version: _version, ...exported } = loaded!;
    new StandbyPersistence(path, undefined, () => telegramFoundation).save({
      ...exported,
      version: 1,
      briefingCritical: semanticBriefingSlice(),
    });
    const savedV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));
    expect(savedV2.telegramFoundation.standbyDomains.gateEntries.map(
      (entry: { stateSubjectKey: string }) => entry.stateSubjectKey,
    )).toEqual(subjects.map(([key]) => key));
    expect(savedV2.heat).toEqual(loaded?.heat);
    const reloaded = new StandbyPersistence(path).load();
    expect(reloaded?.heat).toEqual(loaded?.heat);
    expect(reloaded?.typhoons).toEqual(loaded?.typhoons);
    expect(reloaded?.tornado).toEqual(loaded?.tornado);
    expect(reloaded?.longPeriod).toEqual(loaded?.longPeriod);
    expect(reloaded?.briefingCritical).toEqual(validateBriefingCriticalForWrite(semanticBriefingSlice()));
  });

  it("version 不一致は全体を破棄し、構造不正な domain だけを空にする", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), version: 2 }), "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
    writeFileSync(path, JSON.stringify({ ...state(), heat: "invalid" }), "utf8");
    expect(new StandbyPersistence(path).load()).toEqual(expect.objectContaining({ heat: [], seen: state().seen }));
  });

  it("root 6 collection は不正 entry だけを除外し、valid の値と順序を保つ", () => {
    const path = tempPath();
    const heat = [rootHeat("heat-a", "2026-07-21"), { key: "broken" }, rootHeat("heat-b", "2026-07-22")];
    const typhoons = [rootTyphoon("TC-A"), { key: "broken" }, rootTyphoon("TC-B")];
    const volcanoes = [rootVolcano("V-A"), { code: "broken", alertLevel: "bad" }, rootVolcano("V-B")];
    const tornado = [rootTornado("office-a"), { publishingOffice: "broken", areas: "bad" }, rootTornado("office-b")];
    const longPeriod = [rootLongPeriod("lg-a"), { eventId: "broken", maxLgInt: "bad" }, rootLongPeriod("lg-b")];
    const seen = [rootSeen("heat:a"), { key: "broken", revision: "bad" }, rootSeen("tornado:b")];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(), heat, typhoons, volcanoes, tornado, longPeriod, seen,
    }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).not.toBeNull();
    expect(loaded?.heat.map((entry) => entry.key)).toEqual(["heat-a", "heat-b"]);
    expect(loaded?.typhoons.map((entry) => entry.typhoon.typhoonKey)).toEqual(["TC-A", "TC-B"]);
    // Metadata/seen のない旧 v1 volcano record は generation 1 の
    // gate/slice couplingを証明できないため、全件 fail-closed で除外する。
    expect(loaded?.volcanoes.map((entry) => entry.code)).toEqual([]);
    expect(loaded?.tornado?.map((entry) => entry.publishingOffice)).toEqual(["office-a", "office-b"]);
    expect(loaded?.longPeriod?.map((entry) => entry.eventId)).toEqual(["lg-a", "lg-b"]);
    expect(loaded?.seen.map((entry) => entry.key)).toEqual(["heat:a", "tornado:b"]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.heat unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.typhoons unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.volcanoes unit=code discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.tornado unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.longPeriod unit=entry discarded=1 retained=2 reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.seen unit=entry discarded=1 retained=2 reason=invalid-entry",
    ]);
    warn.mockRestore();
  });

  it.each([
    ["heat", "root.heat", "entry"],
    ["typhoons", "root.typhoons", "entry"],
    ["volcanoes", "root.volcanoes", "code"],
    ["tornado", "root.tornado", "entry"],
    ["longPeriod", "root.longPeriod", "entry"],
    ["seen", "root.seen", "entry"],
  ] as const)("root %s の all-invalid は空の present domain を返す", (field, domain, unit) => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), [field]: [{ broken: true }] }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>)[field]).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `[standby-persistence] salvage source=display-active-state-v1.json domain=${domain} unit=${unit} discarded=1 retained=0 reason=invalid-entry`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it.each([
    ["heat", "root.heat"],
    ["typhoons", "root.typhoons"],
    ["volcanoes", "root.volcanoes"],
    ["tornado", "root.tornado"],
    ["longPeriod", "root.longPeriod"],
    ["seen", "root.seen"],
  ] as const)("root %s の invalid-container はその domain だけを空にする", (field, domain) => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), [field]: "invalid-container" }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>)[field]).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      `[standby-persistence] discard source=display-active-state-v1.json domain=${domain} unit=domain reason=invalid-container`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("malformed root seen は他 domain の tombstone を巻き込まず、quakeHost 不正時は longPeriod hosted を false にする", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state({
        seen: [rootSeen("tornado:kept"), { key: "broken-seen", revision: "bad", forgetAtMs: T0 } as never],
        longPeriod: [rootLongPeriod("lg-kept", true)],
        quakeHost: { eventId: 42, maxIntRank: 4, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60_000 } as never,
        floods: {
          events: [],
          seen: [rootSeen("flood:cancelled")],
        },
      }),
    }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.seen).toEqual([rootSeen("tornado:kept")]);
    expect(loaded?.floods?.seen).toEqual([rootSeen("flood:cancelled")]);
    expect(loaded?.longPeriod).toEqual([rootLongPeriod("lg-kept", true)]);
    expect(loaded?.quakeHost).toBeNull();
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 1);
    expect(restored.exportActiveState().longPeriod).toEqual([
      expect.objectContaining({ eventId: "lg-kept", hosted: false }),
    ]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[standby-persistence] discard source=display-active-state-v1.json domain=root.quakeHost unit=domain reason=invalid-entry",
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.seen unit=entry discarded=1 retained=1 reason=invalid-entry",
    ]);
    warn.mockRestore();
  });

  it("壊れた JSON を破棄する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{broken", "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
  });

  it("salvage した raw bytes を canonical write より先に同一directoryへ退避する", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = Buffer.from(`${JSON.stringify({ ...state(), heat: [{ key: "broken" }] }, null, 2)}\n`, "utf8");
    writeFileSync(path, raw);
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    persistence.schedule(state());
    await persistence.__test_writePending();

    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(path), backups[0]!))).toEqual(raw);
    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 0,
      persistenceSalvageBackupRecovered: 0,
      pendingSources: 0,
    });
  });

  it("salvage warn は source/domain ごとに固定 token と bundle 数を一回だけ出す", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(new StandbyPersistence(path).load()?.heat).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.heat unit=entry discarded=1 retained=0 reason=invalid-entry",
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("backup 失敗中は rename せず、次回 write で退避成功後に最新 pending だけを保存する", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const originalOpenSync = fs.openSync;
    const openSync = vi.spyOn(fs, "openSync");
    openSync.mockImplementation((file, flags, ...args) => {
      if (typeof file === "string" && file.endsWith(".salvage-backup") && flags === "wx") {
        const error = new Error("backup blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalOpenSync(file, flags, ...args);
    });
    persistence.schedule(state({ savedAt: "old" }));
    await persistence.__test_writePending();
    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 1, persistenceSalvageBackupRecovered: 0, pendingSources: 1,
    });
    openSync.mockRestore();
    persistence.schedule(state({ savedAt: "latest" }));
    await persistence.__test_writePending();
    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 1, persistenceSalvageBackupRecovered: 1, pendingSources: 0,
    });
    expect(new StandbyPersistence(path).load()?.savedAt).toBe("latest");
  });

  it("backup 初回 failure は後続電文なしの timer だけで退避を再試行する", async () => {
    vi.useFakeTimers({ now: T0 });
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const original = Buffer.from(JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    writeFileSync(path, original);
    const persistence = new StandbyPersistence(path, 10_000);
    expect(persistence.load()?.heat).toEqual([]);
    const originalOpenSync = fs.openSync;
    let blocked = true;
    const openSync = vi.spyOn(fs, "openSync").mockImplementation((file, flags, ...args) => {
      if (blocked && typeof file === "string" && file.endsWith(".salvage-backup") && flags === "wx") {
        const error = new Error("backup blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalOpenSync(file, flags, ...args);
    });

    persistence.startSalvageBackupWorkflow();
    expect(persistence.salvageBackupDiagnostics().pendingSources).toBe(1);
    blocked = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(persistence.salvageBackupDiagnostics().pendingSources).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 1,
      persistenceSalvageBackupRecovered: 1,
      pendingSources: 0,
    });
    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(path), backups[0]!))).toEqual(original);
    expect(readFileSync(path)).toEqual(original);
    openSync.mockRestore();
    persistence.dispose();
  });

  it("salvage backup の同一 timestamp 衝突は wx suffix で回避する", async () => {
    vi.useFakeTimers({ now: T0 });
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = Buffer.from(`${JSON.stringify({ ...state(), heat: [{ key: "broken" }] })}\n`, "utf8");
    writeFileSync(path, raw);
    const timestamp = new Date(T0).toISOString().replace(/[:.]/g, "-");
    const collided = join(dirname(path), `${path.split("/").at(-1)}.${timestamp}.0.salvage-backup`);
    writeFileSync(collided, "collision", "utf8");

    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    persistence.schedule(state());
    await persistence.__test_writePending();

    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(backups).toEqual([
      `${path.split("/").at(-1)}.${timestamp}.0.salvage-backup`,
      `${path.split("/").at(-1)}.${timestamp}.1.salvage-backup`,
    ]);
    expect(readFileSync(join(dirname(path), `${path.split("/").at(-1)}.${timestamp}.1.salvage-backup`)))
      .toEqual(raw);
  });

  it.each([0, -1] as const)("salvage backup write の戻り値 %s 以下は block として扱う", async (written) => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const writeSync = vi.spyOn(fs, "writeSync").mockReturnValue(written);

    persistence.schedule(state({ savedAt: "blocked" }));
    await persistence.__test_writePending();

    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 1,
      persistenceSalvageBackupRecovered: 0,
      pendingSources: 1,
    });
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual([]);
    expect(new StandbyPersistence(path).load()?.savedAt).toBe(state().savedAt);
    writeSync.mockRestore();
  });

  it("salvage backup の file fsync 失敗はこの試行で作成した backup を残さない", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const fsyncSync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("fsync blocked");
    });

    persistence.schedule(state({ savedAt: "blocked" }));
    await persistence.__test_writePending();

    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual([]);
    fsyncSync.mockRestore();
  });

  it("salvage backup は file fsync → directory fsync の順に呼ぶ", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    const openSync = vi.spyOn(fs, "openSync");
    const fsyncSync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);

    persistence.schedule(state());
    await persistence.__test_writePending();

    const opens = openSync.mock.calls.map(([target]) => String(target));
    const backupIndex = opens.findIndex((target) => target.endsWith(".salvage-backup"));
    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(opens[backupIndex + 1]).toBe(dirname(path));
    expect(fsyncSync.mock.calls[0]?.[0]).toBe(openSync.mock.results[backupIndex]?.value);
    expect(fsyncSync.mock.calls[1]?.[0]).toBe(openSync.mock.results[backupIndex + 1]?.value);
    fsyncSync.mockRestore();
    openSync.mockRestore();
  });

  it("v2 採用側と v1 fallback 側の両方に異常があれば、両 source を個別に退避する", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const seedPersistence = new StandbyPersistence(path, 0);
    seedPersistence.save(state());
    const v2Path = standbyPersistenceV2Path(path);
    const v2Raw = {
      ...JSON.parse(readFileSync(v2Path, "utf8")) as Record<string, unknown>,
      heat: [{ key: "broken-v2" }],
    };
    const v1Raw = {
      ...JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
      typhoons: [{ key: "broken-v1" }],
    };
    const v2Bytes = Buffer.from(`${JSON.stringify(v2Raw)}\n`, "utf8");
    const v1Bytes = Buffer.from(`${JSON.stringify(v1Raw)}\n`, "utf8");
    writeFileSync(v2Path, v2Bytes);
    writeFileSync(path, v1Bytes);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const persistence = new StandbyPersistence(path, 0);

    expect(persistence.load()?.heat).toEqual([]);
    expect(persistence.salvageBackupDiagnostics().pendingSources).toBe(2);
    persistence.schedule(state());
    await persistence.__test_writePending();

    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^display-active-state-v2\.json\..+\.salvage-backup$/),
      expect.stringMatching(/^display-active-state-v1\.json\..+\.salvage-backup$/),
    ]));
    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(readFileSync(join(dirname(path), backups.find((name) => name.startsWith("display-active-state-v2.json."))!)))
      .toEqual(v2Bytes);
    expect(readFileSync(join(dirname(path), backups.find((name) => name.startsWith("display-active-state-v1.json."))!)))
      .toEqual(v1Bytes);
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      "[standby-persistence] salvage source=display-active-state-v2.json domain=root.heat unit=entry discarded=1 retained=0 reason=invalid-entry",
    );
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      "[standby-persistence] salvage source=display-active-state-v1.json domain=root.typhoons unit=entry discarded=1 retained=0 reason=invalid-entry",
    );
  });

  it("通常 load では salvage backup を作らない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 0);
    persistence.save(state());
    expect(persistence.load()).not.toBeNull();
    persistence.schedule(state());
    await persistence.__test_writePending();
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toEqual([]);
  });

  it("canonical rewrite 後の再起動では salvage warn と backup を重複させない", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), heat: [{ key: "broken" }] }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const first = new StandbyPersistence(path, 0);
    expect(first.load()?.heat).toEqual([]);
    first.schedule(state());
    await first.__test_writePending();
    const backupCount = readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup")).length;
    expect(backupCount).toBe(1);

    const second = new StandbyPersistence(path, 0);
    expect(second.load()).not.toBeNull();
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".salvage-backup"))).toHaveLength(backupCount);
    expect(warn.mock.calls.filter(([message]) =>
      message === "[standby-persistence] salvage source=display-active-state-v1.json domain=root.heat unit=entry discarded=1 retained=0 reason=invalid-entry",
    )).toHaveLength(1);
  });

  it("洪水 EventID state と seen revision を検証して永続化する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{ riverKey: "river-1", riverName: "多摩川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: new Date(T0).toISOString() }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify({
      ...persistence.load(), floods: { events: "invalid", seen: [] },
    }), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: undefined }));
  });

  it("一部の洪水 EventID が壊れていても、有効な EventID とカードを復元する", () => {
    const path = tempPath();
    const validEvent = {
      eventId: "flood-valid",
      revision: { reportTimeMs: T0, serial: "1" },
      expiresAtMs: T0 + 12 * 60 * 60_000,
      rivers: [{
        riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40,
        kindName: "氾濫危険情報", reportDateTime: new Date(T0).toISOString(),
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(),
      floods: {
        events: [validEvent, { eventId: "broken", rivers: "invalid" }],
        seen: [
          { key: "flood-valid", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "broken", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "cancelled-only", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
        ],
      },
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.floods?.events).toEqual([validEvent]);
    expect(loaded?.floods?.seen.map((entry) => entry.key)).toEqual(["flood-valid", "cancelled-only"]);
    const reducer = new FloodActiveReducer();
    reducer.restoreState(loaded!.floods!, T0 + 60_000);
    expect(reducer.apply({
      mode: "replace",
      eventId: "broken",
      reportDateTime: new Date(T0).toISOString(),
      serial: "1",
      rivers: [{
        riverKey: "river-2", riverName: "利根川", level: "L3", levelRank: 30,
        kindName: "氾濫警戒情報", reportDateTime: new Date(T0).toISOString(),
      }],
    }, T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()?.sourceEventIds).toContain("broken");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "flood"))
      .toEqual(expect.objectContaining({ restored: true }));
  });

  it("active event が全て壊れても、無関係な cancellation tombstone を保全して古い再送を拒否する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(),
      floods: {
        events: [{ eventId: "broken", rivers: "invalid" }],
        seen: [
          { key: "broken", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "cancelled-only", revision: { reportTimeMs: T0, serial: "2" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
        ],
      },
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.floods).toEqual({
      events: [],
      seen: [{
        key: "cancelled-only",
        revision: { reportTimeMs: T0, serial: "2" },
        forgetAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    const reducer = new FloodActiveReducer();
    reducer.restoreState(loaded!.floods!, T0 + 60_000);
    expect(reducer.apply({
      mode: "replace",
      eventId: "cancelled-only",
      reportDateTime: new Date(T0).toISOString(),
      serial: "1",
      rivers: [{
        riverKey: "river-old", riverName: "古い川", level: "L4", levelRank: 40,
        kindName: "氾濫危険情報", reportDateTime: new Date(T0).toISOString(),
      }],
    }, T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()).not.toBeNull();
  });

  it("代表観測所 station 込みで round-trip し、壊れた station は洪水 domain だけ破棄する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: { name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過" },
          }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    // station.name が数値 (不正) → 洪水 domain のみ破棄、他 domain は生存
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: { name: 42, levelM: 3.42, trend: "rising", thresholdLabel: null },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify({ ...persistence.load(), ...broken, version: 2 }), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: { events: [], seen: [] } }));
  });

  it("hydrograph 込みで round-trip し、壊れた hydrograph は洪水 domain だけ破棄する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過",
              hydrograph: {
                points: [
                  { dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "observed" },
                  { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: null, phase: "forecast" },
                  { dateTime: new Date(T0 + 7_200_000).toISOString(), valueM: 3.55, phase: "forecast" },
                ],
                dangerLevelM: 3.2,
              },
            },
          }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    // hydrograph.points[].phase が不正 → 洪水 domain のみ破棄、他 domain は生存
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: null,
              hydrograph: { points: [{ dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "bogus" }], dangerLevelM: null },
            },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify({ ...persistence.load(), ...broken, version: 2 }), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: { events: [], seen: [] } }));
  });

  it.each([
    // 先頭が forecast / 途中に observed が来る逆順 (描画側は先頭=現況固定のため実測と予測を逆表示する)
    ["phase 逆順 ([forecast, observed])", [
      { dateTime: new Date(T0).toISOString(), valueM: 3.55, phase: "forecast" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: 3.42, phase: "observed" },
    ]],
    // 2 点目以降に observed が混ざる
    ["2 点目 observed", [
      { dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "observed" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: 3.55, phase: "observed" },
    ]],
    // points 空
    ["空 points", []],
    // 有効値ゼロ (全 null)
    ["全 null 値", [
      { dateTime: new Date(T0).toISOString(), valueM: null, phase: "observed" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: null, phase: "forecast" },
    ]],
  ] as const)("壊れた hydrograph (%s) は洪水 domain を破棄する", (_label, points) => {
    const path = tempPath();
    const persisted = state({});
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: null,
              hydrograph: { points, dangerLevelM: null },
            },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(path, JSON.stringify(broken), "utf8");
    const persistence = new StandbyPersistence(path);
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: { events: [], seen: [] } }));
  });

  it("typhoon/volcano/tornado/longPeriod/nankai を深く検証し、壊れた domain だけを破棄して起動を続ける", () => {
    const path = tempPath();
    const malformed = {
      ...state(),
      typhoons: [{}],
      volcanoes: [{ code: "V-1" }],
      tornado: [{ sourceEventId: "t", publishingOffice: 42 }],
      longPeriod: [{ eventId: "q", hosted: "yes" }],
      nankaiTrough: { sourceEventId: "n", expiresAtMs: "later" },
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(malformed), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).toEqual(expect.objectContaining({
      heat: state().heat,
      typhoons: [],
      volcanoes: [],
      tornado: [],
      longPeriod: [],
      nankaiTrough: null,
    }));
    expect(() => new StandbyStateStore().restoreActiveState(loaded!, T0 + 1)).not.toThrow();
  });

  it("longPeriod safetyRank は明示 null と旧 field 欠落を区別し、label 矛盾を fail-closed にする", () => {
    const revision = { reportTimeMs: T0, serial: "1" };
    const expiresAtMs = T0 + 60_000;
    const invalidPath = tempPath();
    mkdirSync(dirname(invalidPath), { recursive: true });
    writeFileSync(invalidPath, JSON.stringify(state({
      longPeriod: [{ eventId: "Q1", maxLgInt: "4", safetyRank: null, revision, hosted: true, expiresAtMs }],
    })), "utf8");
    expect(new StandbyPersistence(invalidPath).load()?.longPeriod).toEqual([]);

    const legacyPath = tempPath();
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify(state({
      quakeHost: { eventId: "Q1", maxIntRank: 5, revision, expiresAtMs },
      longPeriod: [{ eventId: "Q1", maxLgInt: "4", revision, hosted: true, expiresAtMs }],
    })), "utf8");
    const loaded = new StandbyPersistence(legacyPath).load()!;
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 1);
    expect(restored.snapshotItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "longPeriod", severity: "critical" }),
    ]));
  });
});

describe("manual backup of current mirrors", () => {
  function backupNames(path: string, extension: string): string[] {
    return readdirSync(dirname(path)).filter((name) => name.endsWith(extension)).sort();
  }

  function expectBackedUp(
    result: VolcanoManualBackupResult,
  ): { source: "v2" | "v1"; path: string; reused: boolean }[] {
    if (result.kind !== "backedUp") throw new Error(`expected backedUp but got ${JSON.stringify(result)}`);
    return result.files;
  }

  function seedBothMirrors(): { path: string; v2Path: string } {
    const path = tempPath();
    const seed = new StandbyPersistence(path, 0);
    seed.save(state());
    const v2Path = standbyPersistenceV2Path(path);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(v2Path)).toBe(true);
    return { path, v2Path };
  }

  it("v2 と v1 の両方があれば v2 → v1 の順に 2 本退避する", () => {
    const { path, v2Path } = seedBothMirrors();

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    expect(files.map((file) => file.source)).toEqual(["v2", "v1"]);
    expect(files.map((file) => file.reused)).toEqual([false, false]);
    expect(backupNames(path, ".manual-backup")).toHaveLength(2);
    expect(readFileSync(files[0]!.path)).toEqual(readFileSync(v2Path));
    expect(readFileSync(files[1]!.path)).toEqual(readFileSync(path));
    expect(backupNames(path, ".salvage-backup")).toEqual([]);
  });

  it("v2 だけがあれば v2 の 1 本を退避する", () => {
    const { path, v2Path } = seedBothMirrors();
    rmSync(path);

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    expect(files.map((file) => file.source)).toEqual(["v2"]);
    expect(readFileSync(files[0]!.path)).toEqual(readFileSync(v2Path));
    expect(backupNames(path, ".manual-backup")).toHaveLength(1);
  });

  it("v1 だけがあれば v1 の 1 本を退避する", () => {
    const { path, v2Path } = seedBothMirrors();
    rmSync(v2Path);

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    expect(files.map((file) => file.source)).toEqual(["v1"]);
    expect(readFileSync(files[0]!.path)).toEqual(readFileSync(path));
    expect(backupNames(path, ".manual-backup")).toHaveLength(1);
  });

  it("mirror が 1 本も無ければ noMirrorPresent で fail-closed する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });

    const result = new StandbyPersistence(path, 0).backupCurrentMirrors("manual");

    expect(result).toEqual({
      kind: "failed",
      reason: "noMirrorPresent",
      detail: `${standbyPersistenceV2Path(path)}, ${path}`,
    });
    expect(backupNames(path, ".manual-backup")).toEqual([]);
  });

  it("同一内容での再実行は既存 backup を reused として返しファイルを増やさない", () => {
    const { path } = seedBothMirrors();
    const persistence = new StandbyPersistence(path, 0);
    const first = expectBackedUp(persistence.backupCurrentMirrors("manual"));
    const created = backupNames(path, ".manual-backup");

    const second = expectBackedUp(persistence.backupCurrentMirrors("manual"));

    expect(second.map((file) => file.reused)).toEqual([true, true]);
    expect(second.map((file) => file.path)).toEqual(first.map((file) => file.path));
    expect(backupNames(path, ".manual-backup")).toEqual(created);
  });

  it("同一 sha256 の .salvage-backup があっても .manual-backup は新規作成する", () => {
    const { path, v2Path } = seedBothMirrors();
    const stamp = new Date(T0).toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(dirname(path), `display-active-state-v1.json.${stamp}.0.salvage-backup`), readFileSync(path));
    writeFileSync(join(dirname(path), `display-active-state-v2.json.${stamp}.0.salvage-backup`), readFileSync(v2Path));
    expect(backupNames(path, ".salvage-backup")).toHaveLength(2);

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    expect(files.map((file) => file.reused)).toEqual([false, false]);
    expect(backupNames(path, ".manual-backup")).toHaveLength(2);
    expect(backupNames(path, ".salvage-backup")).toHaveLength(2);
  });

  it("同一 sha256 の .manual-backup があっても salvage backup は .salvage-backup を作る", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = Buffer.from(`${JSON.stringify({ ...state(), heat: [{ key: "broken" }] }, null, 2)}\n`, "utf8");
    writeFileSync(path, raw);
    const manual = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));
    expect(readFileSync(manual[0]!.path)).toEqual(raw);

    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    persistence.schedule(state());
    await persistence.__test_writePending();

    const salvage = backupNames(path, ".salvage-backup");
    expect(salvage).toHaveLength(1);
    expect(readFileSync(join(dirname(path), salvage[0]!))).toEqual(raw);
    expect(backupNames(path, ".manual-backup")).toHaveLength(1);
    expect(persistence.salvageBackupDiagnostics()).toEqual({
      persistenceSalvageBackupBlocked: 0,
      persistenceSalvageBackupRecovered: 0,
      pendingSources: 0,
    });
  });

  it("backup 書き込み不可なら writeFailed を返し例外を漏らさない", () => {
    const { path } = seedBothMirrors();
    const originalOpenSync = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, ...args) => {
      if (typeof file === "string" && file.endsWith(".manual-backup") && flags === "wx") {
        const error = new Error("backup blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalOpenSync(file, flags, ...args);
    });

    const result = new StandbyPersistence(path, 0).backupCurrentMirrors("manual");

    expect(result.kind).toBe("failed");
    expect(result).toMatchObject({ reason: "writeFailed", source: "v2" });
    expect(backupNames(path, ".manual-backup")).toEqual([]);
  });

  it("ENOENT 以外の read error は readFailed で即中止する", () => {
    const { path, v2Path } = seedBothMirrors();
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (file === v2Path) {
        const error = new Error("read blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return (originalReadFileSync as (...inner: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync);

    const result = new StandbyPersistence(path, 0).backupCurrentMirrors("manual");

    expect(result.kind).toBe("failed");
    expect(result).toMatchObject({ reason: "readFailed", source: "v2" });
    vi.restoreAllMocks();
    expect(backupNames(path, ".manual-backup")).toEqual([]);
  });

  it("manual backup も wx 作成 → file fsync → directory fsync の順で durable に書く", () => {
    const { path } = seedBothMirrors();
    const openSync = vi.spyOn(fs, "openSync");
    const fsyncSync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    const backupOpen = openSync.mock.calls.findIndex(([file, flags]) =>
      typeof file === "string" && file.endsWith(".manual-backup") && flags === "wx");
    expect(backupOpen).toBeGreaterThanOrEqual(0);
    expect(openSync.mock.calls[backupOpen]?.[0]).toBe(files[0]!.path);
    expect(openSync.mock.calls[backupOpen + 1]?.[0]).toBe(dirname(path));
    expect(fsyncSync.mock.calls[0]?.[0]).toBe(openSync.mock.results[backupOpen]?.value);
    expect(fsyncSync.mock.calls[1]?.[0]).toBe(openSync.mock.results[backupOpen + 1]?.value);
    const secondOpen = openSync.mock.calls.findIndex(([file, flags], index) =>
      index > backupOpen + 1 && typeof file === "string" && file.endsWith(".manual-backup") && flags === "wx");
    expect(secondOpen).toBeGreaterThan(backupOpen + 1);
    expect(openSync.mock.calls[secondOpen]?.[0]).toBe(files[1]!.path);
    expect(openSync.mock.calls[secondOpen + 1]?.[0]).toBe(dirname(path));
  });
});

describe("StandbyStateStore persistence", () => {
  function weatherAlert(source: "vpws50" | "vpww56", updatedAt = new Date(T0).toISOString()) {
    return {
      source,
      label: source === "vpws50" ? "気象警報" : "土砂災害警戒情報",
      role: "weatherWarning" as const,
      totalAreas: 1,
      items: [{
        kind: source === "vpws50" ? "L3 大雨警報" : "L4 土砂災害警戒情報",
        phenomenonKey: source === "vpws50" ? "rain" : "landslide",
        displaySeverity: source === "vpws50" ? "officialL3" : "officialL4",
        rank: "warning" as const,
        shownAreas: ["東京都"],
        shownAreaCodes: ["130000"],
        omittedAreaCount: 0,
      }],
      updatedAt,
    };
  }

  it("live の WindPart 欠落を診断なし missing として save→load→restore する", () => {
    const live = new StandbyStateStore();
    live.applyEvent({
      id: "typhoon-wind-missing",
      domain: "typhoonAnalysis",
      eventId: "TC-wind-missing",
      serial: "1",
      reportDateTime: new Date(T0).toISOString(),
      isCancellation: false,
      raw: {
        type: "VPTW60",
        infoType: "発表",
        eventId: "TC-wind-missing",
        serial: "1",
        name: { name: "Alpha", nameKana: "ALPHA", number: "2601", remark: null },
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TS" },
          center: {
            location: "ocean",
            pressureHpa: 990,
            pressureHpaValue: numericValue(990),
            moveDirection: "N",
            moveSpeedKmh: 20,
            moveSpeedKmhValue: numericValue(20),
          },
          wind: null,
        }],
        lifecycle: "active",
      },
    } as unknown as PresentationEvent, T0);

    const liveState = live.exportActiveState();
    expect(liveState.typhoons[0]).toMatchObject({
      maxWindMsValue: { raw: null, value: null, presence: "missing" },
      maxGustMsValue: { raw: null, value: null, presence: "missing" },
    });
    expect(liveState.typhoons[0]!.maxWindMsValue).not.toHaveProperty("diagnostics");
    expect(liveState.typhoons[0]!.maxGustMsValue).not.toHaveProperty("diagnostics");
    expect(live.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0])
      .toMatchObject({
        maxWindMsSemantic: { presence: "missing", label: null, badge: null, render: false },
        maxGustMsSemantic: { presence: "missing", label: null, badge: null, render: false },
      });

    const path = tempPath();
    const persistence = new StandbyPersistence(path);
    persistence.save(liveState);
    const loaded = persistence.load()!;
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 1);

    expect(restored.exportActiveState().typhoons[0]).toMatchObject({
      maxWindMsValue: { raw: null, value: null, presence: "missing" },
      maxGustMsValue: { raw: null, value: null, presence: "missing" },
    });
    expect(restored.exportActiveState().typhoons[0]!.maxWindMsValue).not.toHaveProperty("diagnostics");
    expect(restored.exportActiveState().typhoons[0]!.maxGustMsValue).not.toHaveProperty("diagnostics");
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0])
      .toMatchObject({
        maxWindMsSemantic: { presence: "missing", label: null, badge: null, render: false },
        maxGustMsSemantic: { presence: "missing", label: null, badge: null, render: false },
      });
  });

  it.each([
    ["pressure", "missing"],
    ["pressure", "empty"],
    ["pressure", "qualitative"],
    ["pressure", "range"],
    ["maxWind", "missing"],
    ["maxWind", "empty"],
    ["maxWind", "qualitative"],
    ["maxWind", "range"],
  ] as const)("%s の value→%s→value は live／restart とも差分・trend を出さない", (
    field,
    presence,
  ) => {
    const exact = numericValue(field === "pressure" ? 990 : 25);
    const special = transitionSpecialValue(presence);

    const live = new StandbyStateStore();
    live.applyEvent(typhoonTransitionEvent("1", field, exact), T0);
    live.applyEvent(typhoonTransitionEvent("2", field, special), T0 + 60_000);
    expectNoTyphoonNumericTrend(live);
    live.applyEvent(typhoonTransitionEvent("3", field, exact), T0 + 120_000);
    expectNoTyphoonNumericTrend(live);

    const beforeRestart = new StandbyStateStore();
    beforeRestart.applyEvent(typhoonTransitionEvent("1", field, exact), T0);
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(beforeRestart.exportActiveState());
    const restored = new StandbyStateStore();
    restored.restoreActiveState(persistence.load()!, T0 + 1);
    restored.applyEvent(typhoonTransitionEvent("2", field, special), T0 + 60_000);
    expectNoTyphoonNumericTrend(restored);
    restored.applyEvent(typhoonTransitionEvent("3", field, exact), T0 + 120_000);
    expectNoTyphoonNumericTrend(restored);
  });

  it("気象警報を実ファイルへ書き、新しい store でカード現況を復元する", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    const live = new StandbyStateStore();
    live.applyWeatherAlerts("vpws50", [alert], alert.updatedAt, "1", T0);
    new StandbyPersistence(path).save(live.exportActiveState());

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);

    expect(restarted.snapshotWeatherAlerts()).toEqual([alert]);
    const display = new DisplayStateStore(
      () => restarted.snapshotItems(),
      undefined,
      undefined,
      undefined,
      () => restarted.snapshotWeatherAlerts(),
    );
    expect(display.snapshot(1, T0 + 60_000).weatherAlerts).toEqual([alert]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([
      expect.objectContaining({ source: "vpws50", alerts: [alert] }),
    ]);
  });

  it("weatherAlerts の壊れた source だけを破棄し、正常な別 source を復元する", () => {
    const path = tempPath();
    const vpws50 = weatherAlert("vpws50");
    const persisted = state({
      weatherAlerts: [{
        source: "vpws50",
        alerts: [vpws50],
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...persisted,
      weatherAlerts: [
        { source: "vpww56", alerts: "broken", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 1 },
        ...persisted.weatherAlerts!,
      ],
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherAlerts).toEqual(persisted.weatherAlerts);
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([vpws50]);
  });

  it("weatherAlerts フィールドのない旧ファイルを空の現況として復元する", () => {
    const path = tempPath();
    const legacy = state();
    delete legacy.weatherAlerts;
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherAlerts).toEqual([]);
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
  });

  it("期限切れの weatherAlerts は新しい store へ復元しない", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    new StandbyPersistence(path).save(state({
      weatherAlerts: [{
        source: "vpws50",
        alerts: [alert],
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 60_000,
      }],
    }));

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([]);
  });

  it("解除で alerts が空になった現況は、再起動後もカードを復元しない", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    const live = new StandbyStateStore();
    live.applyWeatherAlerts("vpws50", [alert], alert.updatedAt, "1", T0);
    live.applyWeatherAlerts("vpws50", [], new Date(T0 + 60_000).toISOString(), "2", T0 + 60_000);
    new StandbyPersistence(path).save(live.exportActiveState());

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 120_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([]);
  });

  it("実 VXKO50 を store に適用して実ファイルへ書き、新しい store で河川カードを復元する", () => {
    const msg = createMockWsDataMessage("16_10_01_260312_VXKO50.xml");
    const parsed = parseFloodForecast(msg);
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    const outcome: FloodForecastOutcome = {
      domain: "floodForecast",
      msg,
      headType: msg.head.type,
      statsCategory: "floodForecast",
      parsed,
      diff: null,
      maxLevel: "unknown",
      maxRank: -1,
      stats: { shouldRecord: true, eventId: parsed.eventId },
      presentation: {
        frameLevel: "info",
        floodStateMutationAccepted: true,
        floodActiveEventIds: [parsed.eventId],
      },
    };
    const event = {
      ...fromFloodForecastOutcome(outcome),
      reportDateTime: new Date(T0).toISOString(),
    };
    const live = new StandbyStateStore();
    live.applyEvent(event, T0);
    expect(live.snapshotItems().find((item) => item.kind === "flood")).toBeDefined();

    const path = tempPath();
    new StandbyPersistence(path).save(live.exportActiveState());
    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);

    const flood = restarted.snapshotItems().find((item) => item.kind === "flood");
    expect(flood).toEqual(expect.objectContaining({
      restored: true,
      data: { rivers: expect.arrayContaining([
        expect.objectContaining({ riverName: "緑川", level: "L4" }),
      ]) },
    }));
  });

  it("未失効 state を restored=true で復元し export できる", () => {
    const store = new StandbyStateStore();
    store.restoreActiveState(state(), T0 + 60_000);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ kind: "heat", restored: true }));
    expect(store.exportActiveState()).toEqual(expect.objectContaining({
      version: 1,
      heat: [expect.objectContaining({ key: "heat:2026-07-21", revision: { reportTimeMs: T0, serial: "1" } })],
      seen: [expect.objectContaining({ key: "heat:2026-07-21" })],
    }));
  });

  it("絶対期限切れ state と tombstone を復元しない", () => {
    const expiredAt = T0 + 24 * 60 * 60_000;
    const store = new StandbyStateStore();
    store.restoreActiveState(state(), expiredAt);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.exportActiveState().seen).toEqual([]);
  });

  it("typhoon と level 3 + 噴火イベントの volcano state が実ファイル round-trip する", () => {
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "typhoon-1",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601",
          category: "TS", location: "ocean", pressureHpa: 990, pressureDeltaHpa: -5,
          maxWindMs: 25, maxGustMs: 35, maxWindDeltaMs: 3, intensityTrend: "developing",
          moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: 3,
        alertClass: { code: "23", name: "入山危険", severity: "warning", isActive: true },
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制", "避難準備"],
        alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: "山頂火口", eventDateTime: new Date(T0 - 60_000).toISOString(),
          plumeHeightM: 2500, plumeHeightUnknown: false, plumeDirection: "南東",
        },
        latestEventId: "eruption-event-1",
        eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"],
        alertRevision: { reportTimeMs: T0, serial: "1" },
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    });
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(persisted);
    const loaded = persistence.load();
    const migratedPlumeHeight = legacyDisplayPlumeHeightSemantics(2500, false);
    expect(loaded).toEqual(expect.objectContaining({
      ...persisted,
      typhoons: [expect.objectContaining({
        ...persisted.typhoons[0],
        pressureHpaValue: { raw: "990", value: 990, condition: null, description: null, presence: "value" },
        maxWindMsValue: { raw: "25", value: 25, condition: null, description: null, presence: "value" },
        maxGustMsValue: { raw: "35", value: 35, condition: null, description: null, presence: "value" },
        moveSpeedKmhValue: { raw: "20", value: 20, condition: null, description: null, presence: "value" },
      })],
      volcanoes: [expect.objectContaining({
        ...persisted.volcanoes[0],
        latestEvent: expect.objectContaining({
          plumeHeightM: 2500,
          plumeHeightUnknown: false,
          ...migratedPlumeHeight,
        }),
      })],
      version: 2,
      telegramFoundation: {
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        vpww56: {
          generation: VPWW56_SNAPSHOT_GENERATION,
          authoritative: false,
          state: null,
          gateEntries: [],
        },
        tsunami: {
          active: null, keyedActive: [], legacyActive: null,
          observations: { VTSE51: [], VTSE52: [] }, gateEntries: [],
        },
        volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
        floodForecast: { authoritative: false, active: [], gateEntries: [] },
        standbyDomains: { gateEntries: [] },
      },
    }));

    const store = new StandbyStateStore();
    store.restoreActiveState(loaded!, T0 + 60_000);
    expect(store.snapshotItems().map((item) => item.kind).sort()).toEqual(["heat", "typhoon", "volcano"]);
    expect(store.snapshotItems().every((item) => item.restored)).toBe(true);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: -5, maxWindMs: 25, maxGustMs: 35,
      maxWindDeltaMs: 3, intensityTrend: "developing",
    });
    expect(store.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      alertLevel: 3,
      alertClass: { code: "23", name: "入山危険", severity: "warning", isActive: true },
      warningKind: "噴火警報（火口周辺）",
      targetKinds: ["入山規制", "避難準備"],
      latestEvent: {
        label: "噴火", craterName: "山頂火口",
        eventDateTime: new Date(T0 - 60_000).toISOString(),
        plumeHeightM: 2500, plumeHeightUnknown: false, plumeDirection: "南東",
        ...migratedPlumeHeight,
      },
    });

    store.applyEvent({
      id: "typhoon-2",
      domain: "typhoonAnalysis",
      eventId: "TC-1",
      serial: "2",
      reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false,
      raw: {
        type: "VPTW60",
        infoType: "issue",
        eventId: "TC-1",
        serial: "2",
        name: { name: "Alpha", nameKana: null, number: "2601", remark: null },
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TS" },
          center: { location: "ocean", pressureHpa: 985, moveDirection: "N", moveSpeedKmh: 20 },
          wind: { maxWindMs: 30 },
        }],
      },
    } as never, T0 + 120_000);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: -5, maxWindDeltaMs: 5, intensityTrend: "developing",
    });
  });

  it("typhoon canonical 全 field と diagnostics を保存し、restore 後も semantic を再生成できる", () => {
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1",
        sourceEventId: "typhoon-special",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null,
          typhoonNumber: "2601", category: "TS", location: "ocean",
          pressureHpa: null, maxWindMs: 25, maxGustMs: null,
          moveDirection: "N", moveSpeedKmh: null,
          reportDateTime: new Date(T0).toISOString(),
        },
        pressureHpaValue: {
          raw: "解析不能", value: null, condition: "解析不能", description: null,
          presence: "unknown", diagnostics: ["unmappedSpecialValue"],
        },
        maxWindMsValue: {
          raw: "25", value: null, condition: "以上", description: null,
          presence: "range", lowerBound: 25,
          rawLowerBound: "25",
        },
        maxGustMsValue: {
          raw: "不明", value: null, condition: null, description: "観測不能",
          presence: "unknown", diagnostics: ["specialValueConflict"],
        },
        moveSpeedKmhValue: {
          raw: "", value: null, condition: "停滞気味", description: null,
          presence: "qualitative", diagnostics: ["unmappedSpecialValue"],
        },
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    const path = tempPath();
    new StandbyPersistence(path).save(persisted);
    const loaded = new StandbyPersistence(path).load()!;

    expect(loaded.typhoons[0]).toMatchObject({
      pressureHpaValue: persisted.typhoons[0]!.pressureHpaValue,
      maxWindMsValue: persisted.typhoons[0]!.maxWindMsValue,
      maxGustMsValue: persisted.typhoons[0]!.maxGustMsValue,
      moveSpeedKmhValue: persisted.typhoons[0]!.moveSpeedKmhValue,
    });
    expect(Object.hasOwn(loaded.typhoons[0]!.maxWindMsValue!, "rawUpperBound")).toBe(false);

    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 60_000);
    expect(restored.exportActiveState().typhoons[0]).toMatchObject({
      pressureHpaValue: persisted.typhoons[0]!.pressureHpaValue,
      maxWindMsValue: persisted.typhoons[0]!.maxWindMsValue,
      maxGustMsValue: persisted.typhoons[0]!.maxGustMsValue,
      moveSpeedKmhValue: persisted.typhoons[0]!.moveSpeedKmhValue,
    });
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureHpaSemantic: { presence: "unknown", label: "不明", rank: { kind: "unranked" } },
      maxWindMsSemantic: {
        presence: "range", label: "25m/s以上", badge: "≥",
        rank: { kind: "range", lowerBound: 25, upperBound: null },
      },
      maxGustMsSemantic: { presence: "unknown", label: "不明" },
      moveSpeedKmhSemantic: { presence: "qualitative", label: "停滞気味" },
    });
  });

  it.each(
    (["Pressure", "WindSpeed", "MovementSpeed"] as const).flatMap((domain) =>
      (["", " ", "　"] as const).map((raw) => [domain, raw] as const),
    ),
  )("typhoon %s の empty raw %j は save→load→restore 後も byte-for-byte で一致する", (
    domain,
    raw,
  ) => {
    const emptyValue: SpecialValue<number> = {
      raw,
      value: null,
      condition: null,
      description: null,
      presence: "empty",
    };
    const pressureHpaValue = domain === "Pressure" ? emptyValue : numericValue(990);
    const maxWindMsValue = domain === "WindSpeed" ? emptyValue : numericValue(25);
    const moveSpeedKmhValue = domain === "MovementSpeed" ? emptyValue : numericValue(20);
    const persisted = state({
      typhoons: [{
        key: `typhoon:empty-raw:${domain}`,
        sourceEventId: `typhoon-empty-raw-${domain}`,
        typhoon: {
          typhoonKey: `empty-raw:${domain}`,
          name: "Alpha",
          nameKana: null,
          remark: null,
          typhoonNumber: "2601",
          category: "TS",
          location: "ocean",
          pressureHpa: pressureHpaValue.presence === "value" ? pressureHpaValue.value : null,
          maxWindMs: maxWindMsValue.presence === "value" ? maxWindMsValue.value : null,
          maxGustMs: 35,
          moveDirection: "N",
          moveSpeedKmh: moveSpeedKmhValue.presence === "value" ? moveSpeedKmhValue.value : null,
          reportDateTime: new Date(T0).toISOString(),
        },
        pressureHpaValue,
        maxWindMsValue,
        maxGustMsValue: numericValue(35),
        moveSpeedKmhValue,
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    const path = tempPath();
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    const loaded = persistence.load();
    if (loaded == null) throw new Error("typhoon empty raw persistence load が null");
    const field = domain === "Pressure"
      ? "pressureHpaValue"
      : domain === "WindSpeed"
        ? "maxWindMsValue"
        : "moveSpeedKmhValue";
    expect(loaded.typhoons[0]?.[field]?.raw).toBe(raw);

    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 60_000);
    expect(restored.exportActiveState().typhoons[0]?.[field]?.raw).toBe(raw);
  });

  it("scalar-only typhoon snapshot を読込時だけ canonical 化し、null の曖昧さを診断へ残す", () => {
    const path = tempPath();
    const legacy = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "legacy-typhoon",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null,
          typhoonNumber: "2601", category: "TS", location: "ocean",
          pressureHpa: 990, maxWindMs: null,
          moveDirection: "N", moveSpeedKmh: 20,
          reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.typhoons[0]).toMatchObject({
      pressureHpaValue: { raw: "990", value: 990, presence: "value" },
      maxWindMsValue: {
        raw: null, value: null, presence: "unknown", diagnostics: ["legacyNullUnknown"],
      },
      maxGustMsValue: {
        raw: null, value: null, presence: "unknown", diagnostics: ["legacyNullUnknown"],
      },
      moveSpeedKmhValue: { raw: "20", value: 20, presence: "value" },
    });
  });

  it.each([
    [
      "lower-only",
      {
        raw: "25", value: null, condition: "以上", description: null,
        presence: "range", lowerBound: 25, rawLowerBound: "25",
      },
      {
        lowerBound: 25, upperBound: undefined,
        rawLowerBound: "25", rawUpperBound: undefined,
      },
    ],
    [
      "upper-only",
      {
        raw: "30", value: null, condition: "以下", description: null,
        presence: "range", upperBound: 30, rawUpperBound: "30",
      },
      {
        lowerBound: undefined, upperBound: 30,
        rawLowerBound: undefined, rawUpperBound: "30",
      },
    ],
  ] as const)("typhoon canonical の %s raw bound が save→load→restore で独立に往復する", (
    _label,
    maxWindMsValue,
    expected,
  ) => {
    const path = tempPath();
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "bounded-typhoon",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null,
          typhoonNumber: "2601", category: "TS", location: "ocean",
          pressureHpa: 990, maxWindMs: 25,
          moveDirection: "N", moveSpeedKmh: 20,
          reportDateTime: new Date(T0).toISOString(),
        },
        maxWindMsValue,
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    new StandbyPersistence(path).save(persisted);

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.typhoons).toHaveLength(1);
    expect(loaded.typhoons[0]!.maxWindMsValue).toMatchObject(maxWindMsValue);
    for (const [key, bound] of Object.entries(expected)) {
      expect(loaded.typhoons[0]!.maxWindMsValue?.[key as keyof typeof expected]).toBe(bound);
    }

    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 60_000);
    expect(restored.exportActiveState().typhoons[0]!.maxWindMsValue).toEqual(
      loaded.typhoons[0]!.maxWindMsValue,
    );
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]
      ?.maxWindMsSemantic).toMatchObject({
        lowerBound: expected.lowerBound ?? null,
        upperBound: expected.upperBound ?? null,
        rawLowerBound: expected.rawLowerBound ?? null,
        rawUpperBound: expected.rawUpperBound ?? null,
      });
  });

  it("volcano canonical 全 field・diagnostics・rank を実ファイル round-trip する", () => {
    const crater = projectPlumeHeightSemantic({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "",
        value: null,
        condition: "雲中",
        description: "火口上2000mから4000m",
        presence: "qualitative",
        lowerBound: 2000,
        rawLowerBound: "2000",
        rawUpperBound: "4000",
        diagnostics: ["specialValueConflict"],
      },
    })!;
    const seaLevel = projectPlumeHeightSemantic({
      reference: "aboveSeaLevel",
      unit: "FT",
      value: {
        raw: "観測できず",
        value: null,
        condition: null,
        description: null,
        presence: "unknown",
      },
    })!;
    const persisted = state({
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null,
        alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: "山頂火口", eventDateTime: new Date(T0).toISOString(),
          plumeHeightM: 2000, plumeHeightUnknown: false,
          plumeHeightAboveCraterSemantic: crater,
          plumeHeightAboveSeaLevelSemantic: seaLevel,
          plumeDirection: "南東",
        },
        latestEventId: "event-1",
        eventExpiresAtMs: T0 + 24 * 60 * 60_000,
        sourceEventIds: ["volcano-1"],
        alertRevision: null,
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    });
    const path = tempPath();
    new StandbyPersistence(path).save(persisted);

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes[0].latestEvent).toEqual(persisted.volcanoes[0].latestEvent);
    expect(loaded.volcanoes[0].latestEvent).toEqual(expect.objectContaining({
      plumeHeightAboveCraterSemantic: expect.objectContaining({
        presence: "qualitative",
        lowerBound: 2000,
        upperBound: null,
        badge: "≥",
      }),
    }));
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, T0 + 1);
    expect(restored.exportActiveState().volcanoes[0].latestEvent)
      .toEqual(persisted.volcanoes[0].latestEvent);
  });

  it.each([
    [
      "unknown",
      null,
      true,
      { presence: "unknown", condition: "不明", diagnostics: [] },
    ],
    [
      "legacy null",
      null,
      false,
      { presence: "missing", condition: null, diagnostics: ["legacyNullUnknown"] },
    ],
  ] as const)("旧 volcano scalar snapshot を %s へ読込 migration する", (
    _label,
    plumeHeightM,
    plumeHeightUnknown,
    expected,
  ) => {
    const path = tempPath();
    new StandbyPersistence(path).save(state({
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null, alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: null, eventDateTime: null,
          plumeHeightM, plumeHeightUnknown, plumeDirection: null,
        },
        eventExpiresAtMs: T0 + 24 * 60 * 60_000,
        sourceEventIds: ["volcano-1"],
        alertRevision: null,
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    }));
    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes[0].latestEvent).toEqual(expect.objectContaining({
      plumeHeightAboveCraterSemantic: expect.objectContaining(expected),
      plumeHeightAboveSeaLevelSemantic: expect.objectContaining({
        reference: "aboveSeaLevel", unit: "FT", presence: "missing",
      }),
    }));
  });

  it("片側 raw bound field の省略を受理し null へ正規化する", () => {
    const path = tempPath();
    const semantic = projectPlumeHeightSemantic({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "", value: null, condition: "雲中", description: null,
        presence: "qualitative", rawLowerBound: "2000",
        diagnostics: ["specialValueConflict"],
      },
    })!;
    const oneSided = structuredClone(semantic) as unknown as Record<string, unknown>;
    delete oneSided.rawUpperBound;
    const persisted = {
      ...state(),
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null, alertExpiresAtMs: null,
        latestEvent: {
          label: "噴火", craterName: null, eventDateTime: null,
          plumeHeightM: 3000, plumeHeightUnknown: false,
          plumeHeightAboveCraterSemantic: oneSided,
          plumeHeightAboveSeaLevelSemantic: legacyDisplayPlumeHeightSemantics(3000, false)
            .plumeHeightAboveSeaLevelSemantic,
          plumeDirection: null,
        },
        eventExpiresAtMs: T0 + 24 * 60 * 60_000,
        sourceEventIds: ["volcano-1"], alertRevision: null,
        eventRevision: { reportTimeMs: T0, serial: "1" },
        latestEventId: "event-V-1",
      }],
      seen: [{
        key: "volcano:event:event-V-1",
        revision: { reportTimeMs: T0, serial: "1" },
        forgetAtMs: T0 + 2 * 24 * 60 * 60_000 + 1,
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(persisted), "utf8");
    expect(new StandbyPersistence(path).load()?.volcanoes[0].latestEvent)
      .toEqual(expect.objectContaining({
        plumeHeightAboveCraterSemantic: expect.objectContaining({
          presence: "qualitative",
          rawLowerBound: "2000",
          rawUpperBound: null,
        }),
      }));
  });

  it("壊れた plume semantic だけを scalar へ縮退し別火山と tombstone を保全する", () => {
    const path = tempPath();
    const invalidSemantic = structuredClone(projectPlumeHeightSemantic({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "2500", value: 2500, condition: null, description: null, presence: "value",
      },
    })!) as unknown as Record<string, unknown>;
    invalidSemantic.rank = { kind: "invalid" };
    const volcano = (
      code: string,
      plumeHeightM: number,
      craterSemantic?: unknown,
    ) => ({
      code,
      name: `Mount ${code}`,
      alertLevel: null,
      alertExpiresAtMs: null,
      latestEvent: {
        label: "噴火",
        craterName: null,
        eventDateTime: new Date(T0).toISOString(),
        plumeHeightM,
        plumeHeightUnknown: false,
        ...(craterSemantic === undefined
          ? {}
          : {
              plumeHeightAboveCraterSemantic: craterSemantic,
              plumeHeightAboveSeaLevelSemantic:
                legacyDisplayPlumeHeightSemantics(plumeHeightM, false)
                  .plumeHeightAboveSeaLevelSemantic,
            }),
        plumeDirection: null,
      },
      latestEventId: `event-${code}`,
      eventExpiresAtMs: T0 + 24 * 60 * 60_000,
      sourceEventIds: [`volcano-${code}`],
      alertRevision: null,
      eventRevision: { reportTimeMs: T0, serial: "1" },
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      volcanoes: [volcano("V-1", 2500, invalidSemantic), volcano("V-2", 3000)] as never,
      seen: [
        ...["V-1", "V-2"].map((code) => ({
          key: `volcano:event:event-${code}`,
          revision: { reportTimeMs: T0, serial: "1" },
          forgetAtMs: T0 + 2 * 24 * 60 * 60_000 + 1,
        })),
        {
          key: "volcano:event:tombstone",
          revision: { reportTimeMs: T0, serial: "2" },
          forgetAtMs: T0 + 2 * 24 * 60 * 60_000,
        },
      ],
    })), "utf8");

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes.map((entry) => entry.code)).toEqual(["V-1", "V-2"]);
    expect(loaded.volcanoes[0].latestEvent).toEqual(expect.objectContaining({
      plumeHeightM: 2500,
      plumeHeightAboveCraterSemantic: expect.objectContaining({
        presence: "value",
        value: 2500,
        raw: "2500",
      }),
    }));
    expect(loaded.seen).toContainEqual(expect.objectContaining({
      key: "volcano:event:tombstone",
      revision: { reportTimeMs: T0, serial: "2" },
    }));
  });

  it("latestEventId のない旧形式 VFVO56 state を実ファイル復元し、単一候補なら空コード取消を適用する", () => {
    const issueMsg = createMockWsDataMessage(FIXTURE_VFVO56_FLASH_1);
    const cancelMsg = createMockWsDataMessage(FIXTURE_VFVO56_FLASH_4);
    const issueRaw = parseVolcanoTelegram(issueMsg)!;
    const cancelRaw = parseVolcanoTelegram(cancelMsg)!;
    const issueAt = Date.parse(issueRaw.reportDateTime);
    const cancelAt = Date.parse(cancelRaw.reportDateTime);
    const eventId = "20140927120000_312";
    const event = (id: string, raw: typeof issueRaw, msg: typeof issueMsg) => ({
      id,
      domain: "volcano",
      eventId,
      serial: msg.xmlReport?.head.serial ?? null,
      reportDateTime: raw.reportDateTime,
      infoType: raw.infoType,
      isCancellation: raw.infoType === "取消",
      raw,
    }) as never;

    const beforeRestart = new StandbyStateStore();
    beforeRestart.applyEvent(event("issue", issueRaw, issueMsg), issueAt);
    const path = tempPath();
    const active = beforeRestart.exportActiveState();
    const { latestEventId: _legacyMissing, ...legacyVolcano } = active.volcanoes[0];
    new StandbyPersistence(path).save({ ...active, volcanoes: [legacyVolcano] });
    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.volcanoes[0]).not.toHaveProperty("latestEventId");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, cancelAt);
    expect(restored.exportActiveState().volcanoes[0]?.latestEventId).toBeNull();

    restored.applyEvent(event("cancel", cancelRaw, cancelMsg), cancelAt);
    new StandbyPersistence(path).save(restored.exportActiveState());
    const afterRestart = new StandbyStateStore();
    afterRestart.restoreActiveState(new StandbyPersistence(path).load()!, cancelAt + 1);
    expect(afterRestart.snapshotItems()).toEqual([]);
    expect(afterRestart.exportActiveState().volcanoes).toEqual([]);
  });

  it("非表示の level 3 警報を実ファイル復元し、後着した噴火イベントへ併記する", () => {
    const beforeRestart = new StandbyStateStore();
    beforeRestart.applyEvent({
      id: "volcano-alert-1",
      domain: "volcano",
      serial: "1",
      reportDateTime: new Date(T0).toISOString(),
      isCancellation: false,
      raw: {
        kind: "alert", type: "VFVO50", infoType: "発表", action: "issue",
        volcanoCode: "V-1", volcanoName: "Mount Test",
        alertLevel: 3, alertLevelCode: "3", previousLevelCode: "2",
        warningKind: "噴火警報（火口周辺）",
        municipalities: [{ name: "テスト市", code: "0000000", kind: "入山規制" }],
      },
    } as never, T0);
    expect(beforeRestart.snapshotItems()).toEqual([]);

    const persistence = new StandbyPersistence(tempPath());
    persistence.save(beforeRestart.exportActiveState());
    const afterRestart = new StandbyStateStore();
    afterRestart.restoreActiveState(persistence.load()!, T0 + 30_000);
    expect(afterRestart.snapshotItems()).toEqual([]);

    afterRestart.applyEvent({
      id: "volcano-eruption-1",
      domain: "volcano",
      serial: "1",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
      isCancellation: false,
      raw: {
        kind: "eruption", type: "VFVO56", infoType: "発表",
        volcanoCode: "V-1", volcanoName: "Mount Test",
        phenomenonName: "噴火", isFlashReport: false,
      },
    } as never, T0 + 60_000);
    expect(afterRestart.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      alertLevel: 3,
      warningKind: "噴火警報（火口周辺）",
      targetKinds: ["入山規制"],
      latestEvent: expect.objectContaining({ label: "噴火" }),
    });
  });

  it("壊れた構造化噴火イベントは volcano domain ごと破棄する", () => {
    const path = tempPath();
    const malformed = {
      ...state(),
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: null, alertExpiresAtMs: T0,
        latestEvent: {
          label: "噴火", craterName: "山頂火口", eventDateTime: new Date(T0).toISOString(),
          plumeHeightM: 2500, plumeHeightUnknown: "yes", plumeDirection: "南東",
        },
        eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"],
        alertRevision: null, eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(malformed), "utf8");

    expect(new StandbyPersistence(path).load()).toEqual(expect.objectContaining({ volcanoes: [] }));
  });

  it("構造化イベント・警報意味 field のない旧 volcano 保存状態を互換復元する", () => {
    const path = tempPath();
    const legacy = state({
      volcanoes: [{
        code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null,
        latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"],
        alertRevision: { reportTimeMs: T0, serial: "1" },
        eventRevision: { reportTimeMs: T0, serial: "1" },
      }],
    });
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.volcanoes[0]).not.toHaveProperty("warningKind");
    expect(loaded?.volcanoes[0]).not.toHaveProperty("targetKinds");
    expect(loaded?.volcanoes[0]).not.toHaveProperty("alertClass");
    expect(loaded?.volcanoes[0]).not.toHaveProperty("latestEventId");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      warningKind: null,
      targetKinds: [],
      latestEvent: {
        label: "flash", craterName: null, eventDateTime: null,
        plumeHeightM: null, plumeHeightUnknown: false, plumeDirection: null,
      },
    });
  });

  it("差分 field のない旧 typhoon 永続化ファイルを読み、null 差分として復元する", () => {
    const path = tempPath();
    const legacy = state({
      typhoons: [{
        key: "typhoon:TC-1",
        sourceEventId: "typhoon-1",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601",
          category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25,
          moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.typhoons[0]?.typhoon).not.toHaveProperty("pressureDeltaHpa");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: null, maxGustMs: null, maxWindDeltaMs: null, intensityTrend: null,
    });
  });

  it("failed seed retains restored volcano state; empty success clears its alert but keeps the eruption and emits a change", () => {
    const persisted = state({
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], alertRevision: { reportTimeMs: T0, serial: "1" }, eventRevision: { reportTimeMs: T0, serial: "1" } }],
    });
    const store = new StandbyStateStore();
    const changed = vi.fn();
    store.restoreActiveState(persisted, T0 + 60_000);
    store.onChange(changed);

    expect(store.seedVolcanoAlerts([], "failed", T0 + 60_000)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ kind: "volcano", restored: true }));
    expect(store.seedVolcanoAlerts([], "success", T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(changed).toHaveBeenCalledTimes(1);
    const volcano = store.snapshotItems().find((item) => item.kind === "volcano");
    expect(volcano).toEqual(expect.objectContaining({
      restored: true,
      data: expect.objectContaining({ volcanoes: [expect.objectContaining({
        alertLevel: null,
        latestEvent: expect.objectContaining({ label: "flash" }),
      })] }),
    }));
  });

  it("keeps an aggregated heat card restored while any area still comes from persistence", () => {
    const persisted = state({
      heat: [
        ...state().heat,
        { ...state().heat[0], key: "heat:2026-07-21:長崎県", sourceEventIds: ["heat-2"], areas: [{ areaName: "長崎県", isSpecial: false }] },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "heat-live", domain: "heatAlert", eventId: null, serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "熱中症警戒アラート", publishingOffice: "環境省 気象庁", areaItems: [],
      raw: { type: "VPFT50", infoType: "発表", targetDateTime: new Date(T0).toISOString(), serial: "2", targetAreaName: "東京都" },
    } as never, T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "heat")?.restored).toBe(true);
  });

  it("keeps an aggregated tornado card restored while any office still comes from persistence", () => {
    const persisted = state({
      tornado: [
        { publishingOffice: "東京管区気象台", sourceEventId: "tornado-1", areas: ["東京都"], isSighted: false, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000 },
        { publishingOffice: "長崎地方気象台", sourceEventId: "tornado-2", areas: ["長崎県"], isSighted: false, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000 },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "tornado-live", domain: "tornado", eventId: null, serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "竜巻注意情報", publishingOffice: "東京管区気象台", areaItems: [{ name: "東京都" }],
      raw: { serial: "2", publishingOffice: "東京管区気象台", activeAreaCount: 1, hasSightingAreas: false, validDateTime: new Date(T0 + 60 * 60_000).toISOString() },
    } as never, T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.restored).toBe(true);
  });

  it("keeps an aggregated typhoon card restored while any typhoon still comes from persistence", () => {
    const base = {
      key: "typhoon:TC-1", sourceEventId: "typhoon-1",
      typhoon: { typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString() },
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 24 * 60 * 60_000,
    };
    const persisted = state({
      typhoons: [
        base,
        { ...base, key: "typhoon:TC-2", sourceEventId: "typhoon-2", typhoon: { ...base.typhoon, typhoonKey: "TC-2", typhoonNumber: "2602" } },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "typhoon-live", domain: "typhoonAnalysis", eventId: "TC-1", serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "台風解析・予報情報", publishingOffice: "気象庁", areaItems: [],
      raw: { type: "VPTW60", infoType: "発表", eventId: "TC-1", serial: "2", name: { name: "Alpha", nameKana: null, number: "2601", remark: null }, frames: [{ kind: "実況", label: "実況", validTime: new Date(T0 + 120_000).toISOString(), typhoonClass: { category: "TS", intensity: null, size: null }, center: { location: "ocean", coordinate: null, forecastCircleRadiusKm: null, moveDirection: "N", moveSpeedKmh: 20, pressureHpa: 985 }, wind: null }] },
    } as never, T0 + 120_000);

    const item = store.snapshotItems().find((i) => i.kind === "typhoon");
    expect(item?.restored).toBe(true);
  });

  it("keeps a restored volcano event marked when an authoritative alert seed arrives", () => {
    const persisted = state({
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], alertRevision: { reportTimeMs: T0, serial: "1" }, eventRevision: { reportTimeMs: T0, serial: "1" } }],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.seedVolcanoAlerts([{ volcanoCode: "V-1", volcanoName: "Mount Test", alertLevel: 4, reportDateTime: new Date(T0 + 120_000).toISOString() }], "success", T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "volcano")?.restored).toBe(true);
  });
});

describe("briefing critical persistence", () => {
  function loadExternalBriefing(
    briefingCritical: unknown,
  ): ReturnType<StandbyPersistence["load"]> {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      briefingCritical: briefingCritical as PersistedBriefingCriticalStateV1,
    })), "utf8");
    return new StandbyPersistence(path).load();
  }

  it("semantic/raw のtyped文字列衝突を共存させ、identity順にcanonicalizeする", () => {
    const semantic = briefingUnit();
    const raw = rawBriefingUnit(semantic.entry.semanticKey!, "vpbs50");
    const validated = validateBriefingCriticalForWrite({
      generation: 1,
      entries: [semantic, raw],
      cancellations: [],
      watermarks: [{
        semanticKey: semantic.entry.semanticKey!, revision: { reportTimeMs: T0, serial: "003" },
        expiresAtMs: T0 + 60 * 60_000,
      }],
    });

    expect(validated.entries.map((unit) => unit.entry.key)).toEqual([
      rawBriefingDisplayKey("vpbs50", semantic.entry.semanticKey!),
      semantic.entry.semanticKey,
    ]);
    expect(validated.watermarks[0]?.revision.serial).toBe("3");
  });

  it("rawAliases 欠落を空として受理し、明示emptyはwriterで省略する", () => {
    const missing = validateBriefingCriticalForWrite(semanticBriefingSlice());
    const explicit = validateBriefingCriticalForWrite({ ...semanticBriefingSlice(), rawAliases: [] });

    expect(missing.rawAliases).toBeUndefined();
    expect(explicit.rawAliases).toBeUndefined();
  });

  it("replacement watermarkをcanonical順でround tripし、欠落・明示emptyを省略する", () => {
    const path = tempPath();
    const replacements = [
      { editorialOffice: "官署B", areaCode: "002", revision: { reportTimeMs: T0 + 1, serial: "002" }, expiresAtMs: T0 + 60 * 60_000 },
      { editorialOffice: "官署A", areaCode: "001", revision: { reportTimeMs: T0, serial: "001" }, expiresAtMs: T0 + 60 * 60_000 },
    ];
    const slice = {
      ...semanticBriefingSlice(),
      linearRainForecastReplacementWatermarks: replacements,
    };
    const persistence = new StandbyPersistence(path);
    persistence.save(state({ briefingCritical: slice }));
    const v1 = JSON.parse(readFileSync(path, "utf8"));
    const v2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));

    expect(v1.briefingCritical).toEqual(v2.briefingCritical);
    expect(v1.briefingCritical.linearRainForecastReplacementWatermarks).toEqual([
      { ...replacements[1], revision: { reportTimeMs: T0, serial: "1" } },
      { ...replacements[0], revision: { reportTimeMs: T0 + 1, serial: "2" } },
    ]);
    expect(persistence.load()?.briefingCritical).toEqual(v1.briefingCritical);
    expect(validateBriefingCriticalForWrite(semanticBriefingSlice())
      .linearRainForecastReplacementWatermarks).toBeUndefined();
    expect(validateBriefingCriticalForWrite({
      ...semanticBriefingSlice(), linearRainForecastReplacementWatermarks: [],
    }).linearRainForecastReplacementWatermarks).toBeUndefined();
  });

  it("replacement watermarkのidentity・revision・expiry・512/513境界を検証する", () => {
    const replacements = Array.from({ length: 513 }, (_, index) => ({
      editorialOffice: `官署${index}`,
      areaCode: `code-${index}`,
      revision: { reportTimeMs: T0, serial: "1" },
      expiresAtMs: T0 + 60 * 60_000,
    }));
    expect(validateBriefingCriticalForWrite({
      ...semanticBriefingSlice(), linearRainForecastReplacementWatermarks: replacements.slice(0, 512),
    }).linearRainForecastReplacementWatermarks).toHaveLength(512);
    expect(() => validateBriefingCriticalForWrite({
      ...semanticBriefingSlice(), linearRainForecastReplacementWatermarks: replacements,
    })).toThrow("limit-exceeded");
    for (const mutate of [
      (item: Record<string, unknown>) => { item.editorialOffice = ""; },
      (item: Record<string, unknown>) => { item.areaCode = ""; },
      (item: Record<string, unknown>) => { item.revision = { reportTimeMs: T0, serial: "x" }; },
      (item: Record<string, unknown>) => { item.expiresAtMs = Number.NaN; },
    ]) {
      const replacement = structuredClone(replacements[0]!) as unknown as Record<string, unknown>;
      mutate(replacement);
      expect(() => validateBriefingCriticalForWrite({
        ...semanticBriefingSlice(),
        linearRainForecastReplacementWatermarks: [replacement] as never[],
      })).toThrow(BriefingCriticalPersistenceInvariantError);
    }
    expect(() => validateBriefingCriticalForWrite({
      ...semanticBriefingSlice(),
      linearRainForecastReplacementWatermarks: [replacements[0]!, { ...replacements[0]! }],
    })).toThrow(BriefingCriticalPersistenceInvariantError);
  });

  it("外部replacement watermarkのmalformed・duplicateをreader repairしcanonical rewriteする", () => {
    const valid = {
      editorialOffice: "官署B", areaCode: "002",
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    };
    const duplicate = {
      editorialOffice: "官署A", areaCode: "001",
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    };
    const loaded = loadExternalBriefing({
      ...semanticBriefingSlice(),
      linearRainForecastReplacementWatermarks: [
        valid,
        duplicate,
        { ...duplicate, revision: { reportTimeMs: T0 + 1, serial: "2" } },
        { ...valid, editorialOffice: "" },
      ],
    });
    expect(loaded?.briefingCritical?.linearRainForecastReplacementWatermarks).toEqual([valid]);
  });

  it("外部replacement watermarkの非canonical順をreader repairする", () => {
    const path = tempPath();
    const later = {
      editorialOffice: "官署B", areaCode: "002",
      revision: { reportTimeMs: T0 + 1, serial: "2" }, expiresAtMs: T0 + 60 * 60_000,
    };
    const earlier = {
      editorialOffice: "官署A", areaCode: "001",
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state({
      briefingCritical: {
        ...semanticBriefingSlice(),
        linearRainForecastReplacementWatermarks: [later, earlier],
      },
    })), "utf8");
    const persistence = new StandbyPersistence(path);

    expect(persistence.load()?.briefingCritical?.linearRainForecastReplacementWatermarks)
      .toEqual([earlier, later]);
    expect(persistence.hasPendingSalvageRepair()).toBe(true);
  });

  it("外部配列orderingと明示empty rawAliasesはcanonical rewriteを要求し、保存後に解消する", () => {
    const path = tempPath();
    const external = state({
      briefingCritical: {
        generation: 1,
        entries: [rawBriefingUnit("z-last"), rawBriefingUnit("a-first")],
        cancellations: [], watermarks: [], rawAliases: [],
      },
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(external), "utf8");
    const persistence = new StandbyPersistence(path);
    const loaded = persistence.load();

    expect(persistence.hasPendingSalvageRepair()).toBe(true);
    expect(loaded?.briefingCritical?.entries.map((unit) => unit.entry.sourceEventId))
      .toEqual(["a-first", "z-last"]);
    persistence.save(loaded!);
    expect(persistence.hasPendingSalvageRepair()).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).briefingCritical.rawAliases).toBeUndefined();
  });

  it("generation単独のempty sliceはv1/v2 writerが省略する", () => {
    const path = tempPath();
    new StandbyPersistence(path).save(state({
      briefingCritical: { generation: 99, entries: [], cancellations: [], watermarks: [], rawAliases: [] },
    }));

    expect(JSON.parse(readFileSync(path, "utf8")).briefingCritical).toBeUndefined();
    expect(JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")).briefingCritical).toBeUndefined();
  });

  it("alias-only sliceをv1/v2へ意味的同一にdual-writeし、v1 fallbackでも保持する", () => {
    const path = tempPath();
    const aliasOnly: PersistedBriefingCriticalStateV1 = {
      generation: 11,
      entries: [], cancellations: [], watermarks: [],
      rawAliases: [{
        source: "vpoa50", sourceEventId: "raw-alias-1", semanticKey: "card:vpbs:semantic:recordRain:試験地方気象台",
        revision: { reportTimeMs: T0, serial: "007" }, expiresAtMs: T0 + 60 * 60_000,
      }],
    };
    const persistence = new StandbyPersistence(path);
    persistence.save(state({ briefingCritical: aliasOnly }));
    const v1 = JSON.parse(readFileSync(path, "utf8"));
    const v2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));

    expect(v1.briefingCritical).toEqual(v2.briefingCritical);
    expect(v2.briefingCritical).toEqual({
      ...aliasOnly,
      rawAliases: [{ ...aliasOnly.rawAliases![0], revision: { reportTimeMs: T0, serial: "7" } }],
    });
    rmSync(standbyPersistenceV2Path(path));
    expect(new StandbyPersistence(path).load()?.briefingCritical).toEqual(v1.briefingCritical);
  });

  it("required/nullable/enum/nested payloadとauthoritative field矛盾をfail-loudにする", () => {
    const mutations: Array<(entry: Record<string, unknown>, unit: PersistedBriefingCriticalEntryV1) => void> = [
      (entry) => { delete entry.headline; },
      (entry) => { entry.source = "unknown"; },
      (entry) => { entry.summary = null; },
      (entry) => {
        const evidence = (entry.severityEvidence as Array<Record<string, unknown>>)[0]!;
        delete evidence.status;
      },
      (entry) => {
        const summary = entry.summary as { items: Array<{ facts: Array<Record<string, unknown>> }> };
        delete summary.items[0]!.facts[0]!.locationName;
      },
      (entry) => {
        const summary = entry.summary as { items: Array<{ facts: Array<Record<string, unknown>> }> };
        summary.items[0]!.facts[0]!.value = Number.POSITIVE_INFINITY;
      },
      (entry) => { entry.conditions = Array.from({ length: 2_049 }, () => "x"); },
      (entry) => {
        const summary = entry.summary as { items: unknown[] };
        summary.items = Array.from({ length: 5 }, () => summary.items[0]);
      },
      (entry) => { entry.generation = 2; },
      (entry) => { entry.updatedAt = new Date(T0 + 1).toISOString(); },
      (_entry, unit) => { unit.updatedAtMs = unit.expiresAtMs + 1; },
      (entry) => { entry.frameLevel = "warning"; },
    ];

    for (const mutate of mutations) {
      const slice = semanticBriefingSlice();
      const unit = slice.entries[0]!;
      const entry = unit.entry as unknown as Record<string, unknown>;
      mutate(entry, unit);
      expect(() => validateBriefingCriticalForWrite(slice)).toThrow(BriefingCriticalPersistenceInvariantError);
    }
  });

  it("malformed aliasは同identityのalias bundleだけを除外しsemantic/raw bundleを維持する", () => {
    const slice = semanticBriefingSlice();
    const raw = rawBriefingUnit("raw-survivor");
    const malformedSemantic = structuredClone(slice.entries[0]!) as PersistedBriefingCriticalEntryV1;
    malformedSemantic.entry.source = "vpoa50";
    const malformedRawAlias = {
      source: "vpoa50" as const,
      sourceEventId: "raw-survivor",
      semanticKey: "",
      revision: { reportTimeMs: T0, serial: "3" },
      expiresAtMs: T0 + 60 * 60_000,
    };
    const validAlias = {
      source: "vpoa50" as const, sourceEventId: "alias-A", semanticKey: slice.entries[0]!.entry.semanticKey!,
      revision: { reportTimeMs: T0, serial: "3" }, expiresAtMs: T0 + 60 * 60_000,
    };
    const validRawIdentityAlias = { ...validAlias, sourceEventId: "raw-survivor" };
    const loaded = loadExternalBriefing({
      ...slice,
      entries: [...slice.entries, malformedSemantic, raw],
      watermarks: [
        ...slice.watermarks,
        { ...slice.watermarks[0], revision: { reportTimeMs: "invalid", serial: "3" } },
      ],
      rawAliases: [
        validAlias,
        { ...validAlias, revision: { reportTimeMs: "invalid", serial: "3" } },
        { ...validAlias, sourceEventId: "alias-B" },
        validRawIdentityAlias,
        malformedRawAlias,
      ],
    });

    expect(loaded?.briefingCritical?.entries.map((unit) => unit.entry.sourceEventId))
      .toEqual(["raw-survivor", slice.entries[0]!.entry.sourceEventId]);
    expect(loaded?.briefingCritical?.watermarks).toHaveLength(1);
    expect(loaded?.briefingCritical?.rawAliases?.map((alias) => alias.sourceEventId))
      .toEqual(["alias-B"]);
  });

  it("duplicate aliasとraw entry+alias矛盾をtyped raw identity単位で入力順非依存にsalvageする", () => {
    const alias = {
      source: "vpoa50" as const, sourceEventId: "duplicate", semanticKey: "canonical",
      revision: { reportTimeMs: T0, serial: "3" }, expiresAtMs: T0 + 60 * 60_000,
    };
    const raw = rawBriefingUnit("entry-alias-conflict");
    const conflictingAlias = { ...alias, sourceEventId: "entry-alias-conflict" };
    const first = {
      generation: 1, entries: [raw], cancellations: [], watermarks: [],
      rawAliases: [alias, { ...alias }, conflictingAlias],
    };
    const second = { ...first, rawAliases: [...first.rawAliases].reverse() };

    const left = loadExternalBriefing(first)?.briefingCritical;
    const right = loadExternalBriefing(second)?.briefingCritical;
    expect(left).toEqual(right);
    expect(left).toEqual({ generation: 1, entries: [], cancellations: [], watermarks: [] });
  });

  it("entry 128/129、watermark 511/512/513、alias 511/512/513 を境界検証する", () => {
    const rawEntries = Array.from({ length: 129 }, (_, index) => rawBriefingUnit(`raw-${index}`));
    expect(validateBriefingCriticalForWrite({
      generation: 1, entries: rawEntries.slice(0, 128), cancellations: [], watermarks: [],
    }).entries).toHaveLength(128);
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries: rawEntries, cancellations: [], watermarks: [],
    })).toThrow("limit-exceeded");

    const watermarks = Array.from({ length: 513 }, (_, index) => ({
      semanticKey: `semantic-${index}`, revision: { reportTimeMs: T0, serial: "1" },
      expiresAtMs: T0 + 60 * 60_000,
    }));
    for (const count of [511, 512]) {
      expect(validateBriefingCriticalForWrite({
        generation: 1, entries: [], cancellations: [], watermarks: watermarks.slice(0, count),
      }).watermarks).toHaveLength(count);
    }
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries: [], cancellations: [], watermarks,
    })).toThrow("limit-exceeded");

    const aliases = Array.from({ length: 513 }, (_, index) => ({
      source: "vpoa50" as const, sourceEventId: `alias-${index}`, semanticKey: `semantic-${index}`,
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    }));
    for (const count of [511, 512]) {
      expect(validateBriefingCriticalForWrite({
        generation: 1, entries: [], cancellations: [], watermarks: [], rawAliases: aliases.slice(0, count),
      }).rawAliases).toHaveLength(count);
    }
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries: [], cancellations: [], watermarks: [], rawAliases: aliases,
    })).toThrow("limit-exceeded");
  });

  it("raw provenance+alias union 512を許し513を拒否する", () => {
    const entries = Array.from({ length: 128 }, (_, index) => rawBriefingUnit(`entry-${index}`));
    const aliases = Array.from({ length: 385 }, (_, index) => ({
      source: "vpoa50" as const, sourceEventId: `alias-${index}`, semanticKey: `semantic-${index}`,
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    }));
    expect(validateBriefingCriticalForWrite({
      generation: 1, entries, cancellations: [], watermarks: [], rawAliases: aliases.slice(0, 384),
    }).rawAliases).toHaveLength(384);
    expect(() => validateBriefingCriticalForWrite({
      generation: 1, entries, cancellations: [], watermarks: [], rawAliases: aliases,
    })).toThrow("limit-exceeded");
  });

  it("外部top-level容量超過はbriefing domainだけを除外し他domainを維持する", () => {
    const aliases = Array.from({ length: 513 }, (_, index) => ({
      source: "vpoa50", sourceEventId: `alias-${index}`, semanticKey: `semantic-${index}`,
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000,
    }));
    const loaded = loadExternalBriefing({
      generation: 1, entries: [], cancellations: [], watermarks: [], rawAliases: aliases,
    });

    expect(loaded?.briefingCritical).toBeUndefined();
    expect(loaded?.heat).toHaveLength(1);
  });

  it("writer invariant違反は既存の正常v1/v2 fileを置換しない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path);
    persistence.save(state({ savedAt: "valid", briefingCritical: semanticBriefingSlice() }));
    const beforeV1 = readFileSync(path, "utf8");
    const beforeV2 = readFileSync(standbyPersistenceV2Path(path), "utf8");
    const invalid = semanticBriefingSlice();
    invalid.entries[0]!.entry.key = "not-canonical";

    const result = persistence.save(state({ savedAt: "invalid", briefingCritical: invalid }));
    expect(result).toMatchObject({ kind: "failed", stage: "validation", pendingRetained: true });
    if (result.kind === "failed") {
      expect(result.cause).toBeInstanceOf(BriefingCriticalPersistenceInvariantError);
    }
    expect(readFileSync(path, "utf8")).toBe(beforeV1);
    expect(readFileSync(standbyPersistenceV2Path(path), "utf8")).toBe(beforeV2);
  });
});

describe("briefing operational persistence fixtures", () => {
  const fixtureRoot = join(process.cwd(), "test", "fixtures", "standby-persistence");
  const expectations = JSON.parse(readFileSync(join(fixtureRoot, "operational-expectations.json"), "utf8")) as {
    fixtures: Array<{
      path: string;
      fixedNowMs: string;
      retainedPointers: Array<{ source: string; migration: string; v2: string; v1: string; value: unknown }>;
      expiredPointers: string[];
      expiredReason?: string;
      explicitReplacementAllowlist: string[];
      optionalCompletionPointers: string[];
      savedV2ChangeAllowlist: string[];
      savedV1ChangeAllowlist: string[];
      reloadedV2ChangeAllowlist: string[];
      reloadedV1ChangeAllowlist: string[];
    }>;
  };

  it.each(expectations.fixtures)("$path は固定時計で load→restore→dual-write→reload して意味を保つ", (expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(expected.fixedNowMs);
    try {
      const source = JSON.parse(readFileSync(join(fixtureRoot, expected.path), "utf8")) as Record<string, unknown>;
      const path = tempPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(source.version === 1 ? path : standbyPersistenceV2Path(path), JSON.stringify(source), "utf8");
      for (const retained of expected.retainedPointers) {
        expect(jsonPointer(source, retained.source)).toEqual(retained.value);
      }
      if (expected.expiredPointers.length === 0) {
        expect(expected.expiredReason).toBeTruthy();
        expect(expiredEpochPointers(source, Date.now())).toEqual([]);
      }

      const nowMs = Date.now();
      const persistence = new StandbyPersistence(path);
      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      const structuralChanges = explicitPrimitiveReplacements(source, loaded);
      expect(structuralChanges.filter((pointer) => !expected.optionalCompletionPointers.includes(pointer)))
        .toEqual(expected.explicitReplacementAllowlist);
      expect(structuralChanges.filter((pointer) => expected.optionalCompletionPointers.includes(pointer)))
        .toEqual(expected.optionalCompletionPointers);
      const store = new StandbyStateStore();
      const restore = store.restoreActiveState(loaded!, nowMs);
      store.sweep(nowMs);
      const exported = store.exportActiveState();
      persistence.save(exported);

      const writtenV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));
      const writtenV1 = JSON.parse(readFileSync(path, "utf8"));
      expect(explicitPrimitiveReplacements(source, writtenV2)).toEqual(expected.savedV2ChangeAllowlist);
      expect(explicitPrimitiveReplacements(source, writtenV1)).toEqual(expected.savedV1ChangeAllowlist);
      const reloaded = persistence.load();
      expect(reloaded).not.toBeNull();
      expect(explicitPrimitiveReplacements(writtenV2, reloaded))
        .toEqual(expected.reloadedV2ChangeAllowlist);
      const reloadedStore = new StandbyStateStore();
      reloadedStore.restoreActiveState(reloaded!, nowMs);

      const fallbackPath = tempPath();
      mkdirSync(dirname(fallbackPath), { recursive: true });
      writeFileSync(fallbackPath, JSON.stringify(writtenV1), "utf8");
      const fallbackReloaded = new StandbyPersistence(fallbackPath).load();
      expect(fallbackReloaded).not.toBeNull();
      expect(explicitPrimitiveReplacements(writtenV1, fallbackReloaded))
        .toEqual(expected.reloadedV1ChangeAllowlist);
      const fallbackStore = new StandbyStateStore();
      fallbackStore.restoreActiveState(fallbackReloaded!, nowMs);
      for (const retained of expected.retainedPointers) {
        expect(jsonPointer(loaded, retained.migration)).toEqual(retained.value);
        expect(jsonPointer(writtenV2, retained.v2)).toEqual(retained.value);
        expect(jsonPointer(writtenV1, retained.v1)).toEqual(retained.value);
        expect(jsonPointer(reloadedStore.exportActiveState(), retained.v2)).toEqual(retained.value);
        expect(jsonPointer(fallbackStore.exportActiveState(), retained.v1)).toEqual(retained.value);
      }
      for (const pointer of expected.expiredPointers) {
        expect(jsonPointer(store.exportActiveState(), pointer)).toBeUndefined();
        expect(jsonPointer(writtenV2, pointer)).toBeUndefined();
        expect(jsonPointer(writtenV1, pointer)).toBeUndefined();
        expect(jsonPointer(reloadedStore.exportActiveState(), pointer)).toBeUndefined();
        expect(jsonPointer(fallbackStore.exportActiveState(), pointer)).toBeUndefined();
      }
      if (expected.path.includes("v1")) {
        expect(source.briefingCritical).toBeDefined();
        expect((source.briefingCritical as Record<string, unknown>).rawAliases).toBeUndefined();
        expect((source.briefingCritical as Record<string, unknown>)
          .linearRainForecastReplacementWatermarks).toBeUndefined();
        expect(writtenV2.briefingCritical.rawAliases).toBeUndefined();
        expect(writtenV1.briefingCritical.rawAliases).toBeUndefined();
        expect(writtenV2.briefingCritical.linearRainForecastReplacementWatermarks).toBeUndefined();
        expect(writtenV1.briefingCritical.linearRainForecastReplacementWatermarks).toBeUndefined();
      } else {
        expect(restore.briefingCriticalRewriteRequired).toBe(true);
      }
      expect(reloadedStore.exportActiveState().briefingCritical).toEqual(writtenV2.briefingCritical);
      expect(fallbackStore.exportActiveState().briefingCritical).toEqual(writtenV1.briefingCritical);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("operational-v2 active volcano migration fixture", () => {
  const fixturePath = join(
    process.cwd(),
    "test",
    "fixtures",
    "standby-persistence",
    "operational-v2-active-alert.json",
  );

  it("generic volcanoAlert gateをactual head typeへ推測せずlossless unknown baselineとしてv2/v1往復する", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T00:00:00.000Z");
    try {
      const path = tempPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(standbyPersistenceV2Path(path), readFileSync(fixturePath));
      const persistence = new StandbyPersistence(path);
      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      const volcano = loaded!.telegramFoundation.volcano;
      expect(volcano).toMatchObject({
        authoritative: false,
        ashfallSchemaGeneration: 1,
        repairState: {
          schemaGeneration: 1,
          vfvo50Repairable: true,
          ashfallRepairable: true,
          unrecoverableAlertOmissions: [expect.objectContaining({
            scope: "volcano",
            volcanoCode: "506",
            sourceFamily: "unknown",
            reason: "operationalV2ProvenanceLost",
          })],
          operationalV2AlertResolutions: [],
        },
        gateEntries: [expect.objectContaining({
          revisionFamily: "volcanoAlert",
          stateSubjectKey: "volcano:alert:506",
          volcanoProvenance: {
            kind: "alert",
            sourceFamily: "operationalV2Unknown",
          },
        })],
      });
      expect(volcano.state).toMatchObject({
        generation: 1,
        volcanoes: [expect.objectContaining({
          volcanoCode: "506",
          sourceEventIds: ["operational-v2-source-506"],
          alert: expect.objectContaining({
            sourceFamily: "operationalV2Unknown",
            revision: { reportTimeMs: 1788134400000, serial: "1" },
            appliedSemanticKey: "発表:4706bcc888f15853fcf08839c11e8a8f3f5b0e2755c1b16d9f218788d8146201",
          }),
        })],
      });

      expect(persistence.save(loaded!)).toMatchObject({ kind: "written" });
      const writtenV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8"));
      const writtenV1 = JSON.parse(readFileSync(path, "utf8"));
      expect(writtenV2.telegramFoundation.volcano.state.volcanoes[0].alert.sourceFamily)
        .toBe("operationalV2Unknown");
      expect(writtenV1.volcanoes[0]).toMatchObject({
        alertSourceFamily: "operationalV2Unknown",
        sourceEventIds: ["operational-v2-source-506"],
      });
      expect(writtenV1.volcanoAlertGateMetadata[0]).toMatchObject({
        sourceFamily: "operationalV2Unknown",
        semanticKeys: ["発表:4706bcc888f15853fcf08839c11e8a8f3f5b0e2755c1b16d9f218788d8146201"],
      });
      expect(writtenV1.volcanoRepairState.unrecoverableAlertOmissions[0])
        .toMatchObject({ reason: "operationalV2ProvenanceLost", volcanoCode: "506" });
      expect(new StandbyPersistence(path).load()?.telegramFoundation.volcano.state)
        .toMatchObject({
          generation: 1,
          volcanoes: [expect.objectContaining({
            alert: expect.objectContaining({ sourceFamily: "operationalV2Unknown" }),
          })],
        });

      const fallbackPath = tempPath();
      mkdirSync(dirname(fallbackPath), { recursive: true });
      writeFileSync(fallbackPath, JSON.stringify(writtenV1), "utf8");
      expect(new StandbyPersistence(fallbackPath).load()?.telegramFoundation.volcano.state)
        .toMatchObject({
          generation: 1,
          volcanoes: [expect.objectContaining({
            alert: expect.objectContaining({ sourceFamily: "operationalV2Unknown" }),
          })],
        });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pre-generation volcano migration serial canonicalization", () => {
  const fixturePath = join(
    process.cwd(),
    "test",
    "fixtures",
    "standby-persistence",
    "operational-v2-active-alert.json",
  );

  type PaddedFixtureOptions = { gateSerialRaw: string };

  function paddedSerialFixture(options: PaddedFixtureOptions): Record<string, unknown> {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    const rollbackSerial = "080";
    const volcanoes = fixture.volcanoes as { alertRevision: { serial: string } }[];
    volcanoes[0]!.alertRevision.serial = rollbackSerial;
    const foundation = fixture.telegramFoundation as {
      volcano: {
        active: { alertRevision: { serial: string } }[];
        gateEntries: {
          comparison: {
            revision: { serial: { raw: string; numeric: number; valid: boolean } };
          };
        }[];
      };
    };
    foundation.volcano.active[0]!.alertRevision.serial = rollbackSerial;
    foundation.volcano.gateEntries[0]!.comparison.revision.serial = {
      raw: options.gateSerialRaw,
      numeric: 80,
      valid: true,
    };
    return fixture;
  }

  function loadPadded(options: PaddedFixtureOptions): {
    quarantined: boolean;
    volcanoes: PersistedVolcanoStateV2["volcanoes"];
  } {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      standbyPersistenceV2Path(path),
      JSON.stringify(paddedSerialFixture(options)),
      "utf8",
    );
    const result = new StandbyPersistence(path)
      .loadWithResult(Date.parse("2026-09-01T00:00:00.000Z"));
    if (result.startup.kind === "fatal" || result.state == null) {
      throw new Error("expected a restored standby state");
    }
    const volcano = result.state.telegramFoundation.volcano;
    const state = volcano.state as PersistedVolcanoStateV2 | null;
    return { quarantined: result.volcanoDomainQuarantined, volcanoes: state?.volcanoes ?? [] };
  }

  it("zero-padded な旧 v2 alert serial を canonical 化して quarantine させない", () => {
    const { quarantined, volcanoes } = loadPadded({ gateSerialRaw: "080" });
    expect(quarantined).toBe(false);
    expect(volcanoes).toHaveLength(1);
    expect(volcanoes[0]?.alert).toMatchObject({
      volcanoCode: "506",
      revision: { reportTimeMs: 1788134400000, serial: "80" },
    });
  });

  it("rollback serial \"080\" と gate serial \"80\" を同一 revision として join する", () => {
    const { quarantined, volcanoes } = loadPadded({ gateSerialRaw: "80" });
    expect(quarantined).toBe(false);
    expect(volcanoes).toHaveLength(1);
    expect(volcanoes[0]?.alert).toMatchObject({
      revision: { reportTimeMs: 1788134400000, serial: "80" },
    });
  });

  type MissingFixtureOptions = {
    gateSerialRaw: string | null;
    rollbackSerial: string | null;
  };

  function missingSerialFixture(options: MissingFixtureOptions): Record<string, unknown> {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    const volcanoes = fixture.volcanoes as { alertRevision: { serial: string | null } }[];
    volcanoes[0]!.alertRevision.serial = options.rollbackSerial;
    const foundation = fixture.telegramFoundation as {
      volcano: {
        active: { alertRevision: { serial: string | null } }[];
        gateEntries: {
          comparison: {
            revision: {
              serial: { raw: string | null; numeric: number | null; valid: boolean };
            };
          };
        }[];
      };
    };
    foundation.volcano.active[0]!.alertRevision.serial = options.rollbackSerial;
    foundation.volcano.gateEntries[0]!.comparison.revision.serial = {
      raw: options.gateSerialRaw,
      numeric: null,
      valid: false,
    };
    return fixture;
  }

  function loadMissing(options: MissingFixtureOptions): {
    quarantined: boolean;
    volcanoes: PersistedVolcanoStateV2["volcanoes"];
  } {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      standbyPersistenceV2Path(path),
      JSON.stringify(missingSerialFixture(options)),
      "utf8",
    );
    const result = new StandbyPersistence(path)
      .loadWithResult(Date.parse("2026-09-01T00:00:00.000Z"));
    if (result.startup.kind === "fatal" || result.state == null) {
      throw new Error("expected a restored standby state");
    }
    const volcano = result.state.telegramFoundation.volcano;
    const state = volcano.state as PersistedVolcanoStateV2 | null;
    return { quarantined: result.volcanoDomainQuarantined, volcanoes: state?.volcanoes ?? [] };
  }

  it("gate 側の空文字 serial と rollback 側の null を missing 同士として join する", () => {
    const { quarantined, volcanoes } = loadMissing({
      gateSerialRaw: "",
      rollbackSerial: null,
    });
    expect(quarantined).toBe(false);
    expect(volcanoes).toHaveLength(1);
    expect(volcanoes[0]?.alert).toMatchObject({
      volcanoCode: "506",
      revision: { reportTimeMs: 1788134400000, serial: null },
    });
  });

  it("rollback 側の空文字 serial と gate 側の null を missing 同士として join する", () => {
    const { quarantined, volcanoes } = loadMissing({
      gateSerialRaw: null,
      rollbackSerial: "",
    });
    expect(quarantined).toBe(false);
    expect(volcanoes).toHaveLength(1);
    expect(volcanoes[0]?.alert).toMatchObject({
      volcanoCode: "506",
      revision: { reportTimeMs: 1788134400000, serial: null },
    });
  });

  it("空文字 serial 同士でも quarantine させず canonical な null へ寄せる", () => {
    const { quarantined, volcanoes } = loadMissing({
      gateSerialRaw: "",
      rollbackSerial: "",
    });
    expect(quarantined).toBe(false);
    expect(volcanoes).toHaveLength(1);
    expect(volcanoes[0]?.alert).toMatchObject({
      volcanoCode: "506",
      revision: { reportTimeMs: 1788134400000, serial: null },
    });
  });

  type GateOnlyFamily = "volcanoAlert" | "volcanoEruption" | "volcanoAshfall";

  const MISSING_SERIAL = { raw: "", numeric: null, valid: false };

  function gateOnlyFixture(family: GateOnlyFamily): Record<string, unknown> {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    const foundation = fixture.telegramFoundation as {
      volcano: { gateEntries: Record<string, unknown>[] };
    };
    const alertGate = foundation.volcano.gateEntries[0]! as unknown as {
      comparison: {
        revision: {
          eventId: { raw: string; value: string; valid: boolean };
          type: { raw: string; value: string; valid: boolean };
          serial: { raw: string | null; numeric: number | null; valid: boolean };
          infoType: { raw: string; value: string };
        };
        stateSubjectKey: string;
        variantRank?: number;
      };
      stateSubjectKey: string;
      revisionFamily: string;
      semanticKeys: string[];
      volcanoProvenance?: Record<string, unknown>;
      legacyRevisionKey?: string;
      legacyRevisionKeyProvenance?: string;
      tombstoneRetentionMs?: number;
    };
    if (family === "volcanoAlert") {
      // rollback は numeric serial のまま残し、gate だけを missing にして join を落とす。
      alertGate.comparison.revision.serial = { ...MISSING_SERIAL };
      return fixture;
    }
    const subject = family === "volcanoEruption"
      ? "volcano:eruption:506"
      : "volcano:ashfall:506";
    const extra = JSON.parse(JSON.stringify(alertGate)) as typeof alertGate;
    extra.revisionFamily = family;
    extra.stateSubjectKey = subject;
    extra.comparison.stateSubjectKey = subject;
    extra.comparison.revision.eventId = { raw: subject, value: subject, valid: true };
    extra.comparison.revision.type = { raw: family, value: family, valid: true };
    extra.comparison.revision.serial = { ...MISSING_SERIAL };
    extra.semanticKeys = [`発表:${family}-506`];
    delete extra.legacyRevisionKey;
    delete extra.legacyRevisionKeyProvenance;
    delete extra.tombstoneRetentionMs;
    if (family === "volcanoAshfall") {
      extra.comparison.variantRank = 0;
      extra.volcanoProvenance = {
        kind: "ashfall",
        actualEventId: "ashfall-event-506",
        sourceType: "VFVO54",
      };
    }
    foundation.volcano.gateEntries.push(extra as unknown as Record<string, unknown>);
    return fixture;
  }

  function loadGateOnly(family: GateOnlyFamily): {
    quarantined: boolean;
    serials: (string | null | undefined)[];
  } {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      standbyPersistenceV2Path(path),
      JSON.stringify(gateOnlyFixture(family)),
      "utf8",
    );
    const result = new StandbyPersistence(path)
      .loadWithResult(Date.parse("2026-09-01T00:00:00.000Z"));
    if (result.startup.kind === "fatal" || result.state == null) {
      throw new Error("expected a restored standby state");
    }
    const volcano = result.state.telegramFoundation.volcano;
    const subject = family === "volcanoAlert"
      ? "volcano:alert:506"
      : family === "volcanoEruption" ? "volcano:eruption:506" : "volcano:ashfall:506";
    return {
      quarantined: result.volcanoDomainQuarantined,
      serials: volcano.gateEntries
        .filter((entry) => entry.stateSubjectKey === subject)
        .map((entry) => entry.comparison.revision.serial.raw),
    };
  }

  it("join に失敗した alert gate の空文字 serial も canonical null へ寄せる", () => {
    const { quarantined, serials } = loadGateOnly("volcanoAlert");
    expect(quarantined).toBe(false);
    expect(serials).toEqual([null]);
  });

  it("join に失敗した eruption gate の空文字 serial も canonical null へ寄せる", () => {
    const { quarantined, serials } = loadGateOnly("volcanoEruption");
    expect(quarantined).toBe(false);
    expect(serials).toEqual([null]);
  });

  it("join に失敗した ashfall gate の空文字 serial も canonical null へ寄せる", () => {
    const { quarantined, serials } = loadGateOnly("volcanoAshfall");
    expect(quarantined).toBe(false);
    expect(serials).toEqual([null]);
  });
});

describe("pre-generation volcano migration の alertClass 由来 warningKind", () => {
  const fixturePath = join(
    process.cwd(),
    "test",
    "fixtures",
    "standby-persistence",
    "operational-v2-active-alert.json",
  );
  const REPORT_RAW = "2026-08-31T00:00:00.000Z";
  const REPORT_MS = 1788134400000;
  const RETAIN_CLASS = {
    code: "00",
    name: "活火山であることに留意",
    severity: "info" as const,
    isActive: true,
  };

  type AlertClassInput = {
    code: string;
    name: string;
    severity: "warning" | "info";
    isActive: boolean;
  };

  type VolcanoSpec = {
    code: string;
    name: string;
    alertLevel: number | null;
    alertClass: AlertClassInput | null;
    holderWarningKind: string;
    rollbackWarningKind: string | null;
    serial: string;
    /** null にすると gate の provenance が不明になり operationalV2ProvenanceLost が付く。 */
    gateSourceFamily?: "VFVO50" | null;
  };

  function buildFixture(specs: VolcanoSpec[]): Record<string, unknown> {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    const foundation = fixture.telegramFoundation as {
      volcano: {
        state: Record<string, unknown>;
        active: Record<string, unknown>[];
        gateEntries: Record<string, unknown>[];
      };
    };
    const baseGate = foundation.volcano.gateEntries[0]!;
    const rollbacks = specs.map((spec) => ({
      code: spec.code,
      name: spec.name,
      alertLevel: spec.alertLevel,
      alertClass: spec.alertClass,
      warningKind: spec.rollbackWarningKind,
      targetKinds: ["火口周辺警報"],
      alertExpiresAtMs: null,
      latestEvent: null,
      latestEventId: null,
      eventExpiresAtMs: null,
      sourceEventIds: [`operational-v2-source-${spec.code}`],
      alertRevision: { reportTimeMs: REPORT_MS, serial: spec.serial },
      eventRevision: null,
    }));
    const alerts = specs.map((spec) => ({
      volcanoCode: spec.code,
      volcanoName: spec.name,
      alertLevel: spec.alertLevel,
      alertLevelCode: null,
      action: "issue",
      reportDateTime: REPORT_RAW,
      alertClass: spec.alertClass,
      warningKind: spec.holderWarningKind,
      targetKinds: ["火口周辺警報"],
    }));
    const gates = specs.map((spec) => {
      const gate = JSON.parse(JSON.stringify(baseGate)) as {
        stateSubjectKey: string;
        semanticKeys: string[];
        legacyRevisionKey?: string;
        comparison: {
          stateSubjectKey: string;
          revision: {
            eventId: { raw: string; value: string; valid: boolean };
            serial: { raw: string; numeric: number; valid: boolean };
          };
        };
      };
      const subject = `volcano:alert:${spec.code}`;
      gate.stateSubjectKey = subject;
      gate.comparison.stateSubjectKey = subject;
      gate.comparison.revision.eventId = { raw: subject, value: subject, valid: true };
      gate.comparison.revision.serial = {
        raw: spec.serial,
        numeric: Number(spec.serial),
        valid: true,
      };
      gate.semanticKeys = [`発表:operational-v2-active-${spec.code}`];
      gate.legacyRevisionKey = subject;
      const family = spec.gateSourceFamily === undefined ? "VFVO50" : spec.gateSourceFamily;
      const record = gate as unknown as Record<string, unknown>;
      if (family == null) delete record.volcanoProvenance;
      else record.volcanoProvenance = { kind: "alert", sourceFamily: family };
      return record;
    });
    fixture.volcanoes = rollbacks;
    foundation.volcano.state = { alerts, eruptions: [] };
    foundation.volcano.active = rollbacks as unknown as Record<string, unknown>[];
    foundation.volcano.gateEntries = gates;
    return fixture;
  }

  function loadSpecs(specs: VolcanoSpec[]): {
    path: string;
    persistence: StandbyPersistence;
    quarantined: boolean;
    authoritative: boolean;
    repairState: VolcanoRepairStateV1;
    volcanoes: PersistedVolcanoStateV2["volcanoes"];
    state: Parameters<StandbyPersistence["save"]>[0];
  } {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(buildFixture(specs)), "utf8");
    const persistence = new StandbyPersistence(path);
    const result = persistence.loadWithResult(Date.parse("2026-09-01T00:00:00.000Z"));
    if (result.startup.kind === "fatal" || result.state == null) {
      throw new Error("expected a restored standby state");
    }
    const foundation = result.state.telegramFoundation.volcano;
    const state = foundation.state as PersistedVolcanoStateV2 | null;
    return {
      path,
      persistence,
      quarantined: result.volcanoDomainQuarantined,
      authoritative: foundation.authoritative,
      repairState: foundation.repairState!,
      volcanoes: state?.volcanoes ?? [],
      state: result.state,
    };
  }

  const omissionReasons = (repair: VolcanoRepairStateV1): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const omission of repair.unrecoverableAlertOmissions) {
      counts[omission.reason] = (counts[omission.reason] ?? 0) + 1;
    }
    return counts;
  };

  const RETAIN_SPEC: VolcanoSpec = {
    code: "101",
    name: "アトサヌプリ",
    alertLevel: null,
    alertClass: RETAIN_CLASS,
    holderWarningKind: "活火山であることに留意",
    rollbackWarningKind: null,
    serial: "8",
  };
  const LEVELED_SPEC: VolcanoSpec = {
    code: "506",
    name: "桜島",
    alertLevel: 3,
    alertClass: null,
    holderWarningKind: "噴火警報（火口周辺）",
    rollbackWarningKind: "噴火警報（火口周辺）",
    serial: "1",
  };

  it("レベルなし火山の holder 文字列 × rollback null を join して alert を復元する", () => {
    const loaded = loadSpecs([RETAIN_SPEC]);
    expect(loaded.quarantined).toBe(false);
    expect(loaded.authoritative).toBe(true);
    expect(loaded.volcanoes).toHaveLength(1);
    expect(loaded.volcanoes[0]?.alert).toMatchObject({
      volcanoCode: "101",
      alertLevel: null,
      warningKind: "活火山であることに留意",
      alertClass: RETAIN_CLASS,
      revision: { reportTimeMs: REPORT_MS, serial: "8" },
    });
    expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([]);
  });

  it("レベルなし 1 件とレベル持ち 1 件の混在で 2 件とも復元する", () => {
    const loaded = loadSpecs([RETAIN_SPEC, LEVELED_SPEC]);
    expect(loaded.quarantined).toBe(false);
    expect(loaded.volcanoes.map((composite) => composite.volcanoCode).sort())
      .toEqual(["101", "506"]);
    expect(loaded.volcanoes.every((composite) => composite.alert != null)).toBe(true);
    expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([]);
  });

  it("provenance 不明 gate では provenanceMissing が operationalV2ProvenanceLost へ置き換わる", () => {
    // 本修正の副作用境界。join が通っても gate に explicit な sourceFamily が無ければ
    // sourceFamily=operationalV2Unknown となり operationalV2ProvenanceLost が積まれる。
    // つまり omission の総数は変わらず reason だけが移る（alert 自体は復元される）。
    const loaded = loadSpecs([
      { ...RETAIN_SPEC, gateSourceFamily: null },
      { ...LEVELED_SPEC, gateSourceFamily: null },
    ]);
    expect(loaded.quarantined).toBe(false);
    expect(loaded.volcanoes.map((composite) => composite.volcanoCode).sort())
      .toEqual(["101", "506"]);
    expect(omissionReasons(loaded.repairState))
      .toEqual({ operationalV2ProvenanceLost: 2 });
  });

  it("holder.warningKind が alertClass.name と異なるなら従来どおり join に失敗する", () => {
    const loaded = loadSpecs([{
      ...RETAIN_SPEC,
      holderWarningKind: "噴火警報（火口周辺）",
      gateSourceFamily: null,
    }]);
    expect(loaded.quarantined).toBe(false);
    expect(loaded.volcanoes).toEqual([]);
    expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([
      expect.objectContaining({
        scope: "volcano",
        volcanoCode: "101",
        sourceFamily: "unknown",
        reason: "provenanceMissing",
      }),
    ]);
  });

  it("holder.alertClass が null なら rollback null を許容せず従来どおり落ちる", () => {
    const loaded = loadSpecs([{
      ...LEVELED_SPEC,
      rollbackWarningKind: null,
      gateSourceFamily: null,
    }]);
    expect(loaded.quarantined).toBe(false);
    expect(loaded.volcanoes).toEqual([]);
    expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([
      expect.objectContaining({
        scope: "volcano",
        volcanoCode: "506",
        sourceFamily: "unknown",
        reason: "provenanceMissing",
      }),
    ]);
  });

  it("保存 → 再読込の 2 巡目でも omission が再発しない (冪等)", () => {
    const first = loadSpecs([RETAIN_SPEC, LEVELED_SPEC]);
    expect(first.repairState.unrecoverableAlertOmissions).toEqual([]);
    expect(first.persistence.save(first.state)).toMatchObject({ kind: "written" });

    const second = new StandbyPersistence(first.path);
    const reloaded = second.loadWithResult(Date.parse("2026-09-01T01:00:00.000Z"));
    if (reloaded.startup.kind === "fatal" || reloaded.state == null) {
      throw new Error("expected a restored standby state");
    }
    const foundation = reloaded.state.telegramFoundation.volcano;
    const state = foundation.state as PersistedVolcanoStateV2 | null;
    expect(reloaded.volcanoDomainQuarantined).toBe(false);
    expect(foundation.repairState?.unrecoverableAlertOmissions).toEqual([]);
    expect((state?.volcanoes ?? []).map((composite) => composite.volcanoCode).sort())
      .toEqual(["101", "506"]);
  });
});


describe("v1 volcano migration serial canonicalization", () => {
  const fixturePath = join(
    process.cwd(),
    "test",
    "fixtures",
    "standby-persistence",
    "v1-volcano-serial.json",
  );
  const NOW_MS = Date.parse("2026-09-01T01:00:00.000Z");
  const REPORT_MS = Date.parse("2026-09-01T00:00:00.000Z");

  type SerialCell = { raw: string | null; numeric: number | null; valid: boolean };
  type Revision = { reportTimeMs: number; serial: string | null };
  type V1Fixture = {
    volcanoes: {
      code: string;
      alertRevision: Revision | null;
      eventRevision: Revision | null;
      ashfallProjection?: { revision: Revision };
    }[];
    seen: { key: string; revision: Revision }[];
    volcanoAlertGateMetadata: {
      stateSubjectKey: string;
      comparison: { revision: { serial: SerialCell } };
    }[];
    volcanoAshfallGateMetadata: {
      stateSubjectKey: string;
      comparison: { revision: { serial: SerialCell } };
    }[];
  };

  const cell = (raw: string | null): SerialCell => raw == null || raw === ""
    ? { raw, numeric: null, valid: false }
    : { raw, numeric: Number(raw), valid: true };

  const readFixture = (): V1Fixture =>
    JSON.parse(readFileSync(fixturePath, "utf8")) as V1Fixture;

  const volcanoOf = (fixture: V1Fixture, code: string) =>
    fixture.volcanoes.find((entry) => entry.code === code)!;
  const seenOf = (fixture: V1Fixture, key: string) =>
    fixture.seen.find((entry) => entry.key === key)!;
  const alertMetadataOf = (fixture: V1Fixture, code: string) =>
    fixture.volcanoAlertGateMetadata.find((entry) =>
      entry.stateSubjectKey === `volcano:alert:${code}`)!;

  function loadV1(mutate: (fixture: V1Fixture) => void): {
    quarantined: boolean;
    authoritative: boolean;
    volcanoes: PersistedVolcanoStateV2["volcanoes"];
    repairState: VolcanoRepairStateV1;
    gateSerials: Map<string, string | null>;
  } {
    const fixture = readFixture();
    mutate(fixture);
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(fixture), "utf8");
    const result = new StandbyPersistence(path).loadWithResult(NOW_MS);
    if (result.startup.kind === "fatal" || result.state == null) {
      throw new Error("expected a restored standby state");
    }
    const volcano = result.state.telegramFoundation.volcano;
    const state = volcano.state as PersistedVolcanoStateV2 | null;
    return {
      quarantined: result.volcanoDomainQuarantined,
      authoritative: volcano.authoritative,
      volcanoes: state?.volcanoes ?? [],
      repairState: volcano.repairState!,
      gateSerials: new Map(volcano.gateEntries.map((entry) =>
        [entry.stateSubjectKey, entry.comparison.revision.serial.raw])),
    };
  }

  const codesOf = (volcanoes: PersistedVolcanoStateV2["volcanoes"]): string[] =>
    volcanoes.map((composite) => composite.volcanoCode);

  it("canonical な v1 bundle は 4 火山すべてを migration できる (基準線)", () => {
    const loaded = loadV1(() => {});
    expect(loaded.quarantined).toBe(false);
    expect(loaded.authoritative).toBe(true);
    expect(codesOf(loaded.volcanoes)).toEqual(["506", "507", "508", "509"]);
    expect(loaded.volcanoes[0]?.alert?.revision).toEqual({
      reportTimeMs: REPORT_MS,
      serial: "80",
    });
    expect(loaded.volcanoes[2]?.eruption?.revision).toEqual({
      reportTimeMs: REPORT_MS,
      serial: "80",
    });
    expect(loaded.volcanoes[3]?.ashfall?.revision).toEqual({
      reportTimeMs: REPORT_MS,
      serial: "80",
    });
  });

  it("zero-padded serial の 1 火山が火山ドメイン全体を空にしない (全損回帰)", () => {
    const loaded = loadV1((fixture) => {
      volcanoOf(fixture, "506").alertRevision!.serial = "080";
      seenOf(fixture, "volcano:alert:506").revision.serial = "080";
      alertMetadataOf(fixture, "506").comparison.revision.serial = cell("080");
    });
    expect(loaded.quarantined).toBe(false);
    expect(loaded.authoritative).toBe(true);
    // 修正前はここで normalizeVolcanoFoundationForWrite が throw し、catch が
    // 火山ドメインを丸ごと空にしていた (composites 0 件 / authoritative false)。
    expect(codesOf(loaded.volcanoes)).toEqual(["506", "507", "508", "509"]);
    expect(loaded.volcanoes[0]?.alert?.revision).toEqual({
      reportTimeMs: REPORT_MS,
      serial: "80",
    });
    expect(loaded.gateSerials.get("volcano:alert:506")).toBe("80");
    expect(loaded.volcanoes[1]?.alert?.revision.serial).toBe("80");
  });

  it("record \"080\" × gate \"80\" を同一 revision として join する", () => {
    const loaded = loadV1((fixture) => {
      volcanoOf(fixture, "506").alertRevision!.serial = "080";
    });
    expect(loaded.quarantined).toBe(false);
    expect(codesOf(loaded.volcanoes)).toEqual(["506", "507", "508", "509"]);
    expect(loaded.volcanoes[0]?.alert?.revision.serial).toBe("80");
  });

  it("record \"80\" × gate \"080\" の逆向きでも join する", () => {
    const loaded = loadV1((fixture) => {
      seenOf(fixture, "volcano:alert:506").revision.serial = "080";
      alertMetadataOf(fixture, "506").comparison.revision.serial = cell("080");
    });
    expect(loaded.quarantined).toBe(false);
    expect(codesOf(loaded.volcanoes)).toEqual(["506", "507", "508", "509"]);
    expect(loaded.volcanoes[0]?.alert?.revision.serial).toBe("80");
    expect(loaded.gateSerials.get("volcano:alert:506")).toBe("80");
  });

  it("gate 側 null と record 側空文字を missing 同士として join し null で書き出す", () => {
    const loaded = loadV1((fixture) => {
      volcanoOf(fixture, "506").alertRevision!.serial = "";
      seenOf(fixture, "volcano:alert:506").revision.serial = "";
      alertMetadataOf(fixture, "506").comparison.revision.serial = cell(null);
    });
    expect(loaded.quarantined).toBe(false);
    expect(codesOf(loaded.volcanoes)).toEqual(["506", "507", "508", "509"]);
    expect(loaded.volcanoes[0]?.alert?.revision).toEqual({
      reportTimeMs: REPORT_MS,
      serial: null,
    });
    expect(loaded.gateSerials.get("volcano:alert:506")).toBeNull();
  });

  it("eruption の zero-padded serial も canonical 化して全損させない", () => {
    const loaded = loadV1((fixture) => {
      volcanoOf(fixture, "508").eventRevision!.serial = "080";
      seenOf(fixture, "volcano:event:20260901000000-508").revision.serial = "080";
    });
    expect(loaded.quarantined).toBe(false);
    expect(codesOf(loaded.volcanoes)).toEqual(["506", "507", "508", "509"]);
    expect(loaded.volcanoes[2]?.eruption?.revision).toEqual({
      reportTimeMs: REPORT_MS,
      serial: "80",
    });
    expect(loaded.gateSerials.get("volcano:eruption:508")).toBe("80");
  });

  it("ashfall gate の zero-padded serial を canonical 化して projection と join する", () => {
    const loaded = loadV1((fixture) => {
      seenOf(fixture, "volcano:ashfall:509").revision.serial = "080";
      fixture.volcanoAshfallGateMetadata[0]!.comparison.revision.serial = cell("080");
    });
    expect(loaded.quarantined).toBe(false);
    expect(codesOf(loaded.volcanoes)).toEqual(["506", "507", "508", "509"]);
    expect(loaded.volcanoes[3]?.ashfall?.revision).toEqual({
      reportTimeMs: REPORT_MS,
      serial: "80",
    });
    expect(loaded.gateSerials.get("volcano:ashfall:509")).toBe("80");
    expect(loaded.repairState.ashfallRepairable).toBe(false);
  });

  for (const [label, serial] of [
    ["空文字", ""],
    ["whitespace", " 8 "],
    ["非数値", "abc"],
  ] as const) {
    it(`invalid serial (${label}) は該当火山の omission に閉じ、他火山を残す`, () => {
      const loaded = loadV1((fixture) => {
        volcanoOf(fixture, "506").alertRevision!.serial = serial;
      });
      expect(loaded.quarantined).toBe(false);
      // 506 の alert だけが repair 対象へ落ち、他 3 火山と gate は残る。
      expect(codesOf(loaded.volcanoes)).toEqual(["507", "508", "509"]);
      expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([
        expect.objectContaining({
          scope: "volcano",
          volcanoCode: "506",
          lastKnownComparison: null,
        }),
      ]);
      expect(loaded.repairState.unrecoverableEruptionOmissions).toEqual([]);
      expect(loaded.gateSerials.get("volcano:alert:506")).toBe("80");
      expect(loaded.volcanoes[0]?.alert?.revision.serial).toBe("80");
    });
  }

  it("zero-padded gate が join に失敗しても omission は canonical serial で記録される", () => {
    const loaded = loadV1((fixture) => {
      volcanoOf(fixture, "506").alertRevision!.serial = "080";
      seenOf(fixture, "volcano:alert:506").revision.serial = "080";
      alertMetadataOf(fixture, "506").comparison.revision.serial = cell("081");
    });
    expect(loaded.quarantined).toBe(false);
    expect(codesOf(loaded.volcanoes)).toEqual(["507", "508", "509"]);
    expect(loaded.gateSerials.has("volcano:alert:506")).toBe(false);
    const serials = loaded.repairState.unrecoverableAlertOmissions
      .map((omission) => omission.lastKnownComparison?.revision.serial);
    expect(serials).toEqual([
      { raw: "80", numeric: 80, valid: true },
      { raw: "81", numeric: 81, valid: true },
    ]);
    expect(loaded.repairState.unrecoverableAlertOmissions.every((omission) =>
      omission.scope === "volcano" && omission.volcanoCode === "506")).toBe(true);
  });
});

describe("generation-1 volcano salvage serial canonicalization", () => {
  const basePath = join(
    process.cwd(),
    "test",
    "fixtures",
    "standby-persistence",
    "operational-v2-active-alert.json",
  );
  const REPORT_RAW = "2026-08-31T00:00:00.000Z";
  const REPORT_MS = 1788134400000;
  const ALERT_RETENTION_MS = 30 * 24 * 60 * 60_000;
  const ERUPTION_RETENTION_MS = 2 * 24 * 60 * 60_000;
  const digest = (label: string): string =>
    `発表:${createHash("sha256").update(label).digest("hex")}`;
  const ALERT_SEMANTIC = digest("salvage-alert-506");
  const ERUPTION_SEMANTIC = digest("salvage-eruption-506");
  const EVENT_ID = "20260831000000-506";

  const serialCell = (raw: string | null): Record<string, unknown> =>
    raw == null || raw === ""
      ? { raw, numeric: null, valid: false }
      : { raw, numeric: Number(raw), valid: true };

  const comparisonOf = (subject: string, family: string, serial: string | null) => ({
    stateSubjectKey: subject,
    revision: {
      eventId: { raw: subject, value: subject, valid: true },
      type: { raw: family, value: family, valid: true },
      reportDateTime: { raw: REPORT_RAW, epochMs: REPORT_MS, valid: true },
      serial: serialCell(serial),
      infoType: { raw: "発表", value: "発表", valid: true },
    },
  });

  const alertGate = (serial: string | null): Record<string, unknown> => ({
    domain: "volcano",
    revisionFamily: "volcanoAlert",
    stateSubjectKey: "volcano:alert:506",
    comparison: comparisonOf("volcano:alert:506", "volcanoAlert", serial),
    semanticKeys: [ALERT_SEMANTIC],
    cancelled: false,
    acceptedAtMs: REPORT_MS,
    tombstoneRetentionMs: ALERT_RETENTION_MS,
    legacyRevisionKey: "volcano:alert:506",
    legacyRevisionKeyProvenance: "codeFallback",
    volcanoProvenance: { kind: "alert", sourceFamily: "VFVO51" },
  });

  const eruptionGate = (serial: string | null): Record<string, unknown> => ({
    domain: "volcano",
    revisionFamily: "volcanoEruption",
    stateSubjectKey: "volcano:eruption:506",
    comparison: comparisonOf("volcano:eruption:506", "volcanoEruption", serial),
    semanticKeys: [ERUPTION_SEMANTIC],
    cancelled: false,
    acceptedAtMs: REPORT_MS,
    tombstoneRetentionMs: ERUPTION_RETENTION_MS,
    legacyRevisionKey: `volcano:event:${EVENT_ID}`,
    legacyRevisionKeyProvenance: "eventId",
  });

  const alertSlice = (serial: string | null): Record<string, unknown> => ({
    volcanoCode: "506",
    volcanoName: "桜島",
    alertLevel: 3,
    alertLevelCode: null,
    action: "continue",
    reportDateTime: REPORT_RAW,
    alertClass: null,
    warningKind: "噴火警報（火口周辺）",
    targetKinds: ["火口周辺警報"],
    sourceFamily: "VFVO51",
    revision: { reportTimeMs: REPORT_MS, serial },
    appliedSemanticKey: ALERT_SEMANTIC,
  });

  const eruptionSlice = (serial: string | null): Record<string, unknown> => ({
    volcanoName: "桜島",
    latestEvent: {
      label: "噴火",
      craterName: "南岳山頂火口",
      eventDateTime: REPORT_RAW,
      plumeHeightM: 1000,
      plumeHeightUnknown: false,
      plumeDirection: "東",
    },
    latestEventId: EVENT_ID,
    eventExpiresAtMs: REPORT_MS + 86_400_000,
    revision: { reportTimeMs: REPORT_MS, serial },
    appliedSemanticKey: ERUPTION_SEMANTIC,
  });

  function foundationVolcano(options: {
    alert?: Record<string, unknown> | null;
    eruption?: Record<string, unknown> | null;
    gates: Record<string, unknown>[];
  }): Record<string, unknown> {
    return {
      authoritative: true,
      ashfallSchemaGeneration: 1,
      repairState: {
        schemaGeneration: 1,
        vfvo50Repairable: false,
        ashfallRepairable: false,
        unrecoverableAlertOmissions: [],
        unrecoverableEruptionOmissions: [],
        operationalV2AlertResolutions: [],
      },
      state: {
        generation: 1,
        volcanoes: [{
          volcanoCode: "506",
          volcanoName: "桜島",
          sourceEventIds: ["operational-v2-source-506"],
          alert: options.alert ?? null,
          eruption: options.eruption ?? null,
          ashfall: null,
        }],
      },
      active: [],
      gateEntries: options.gates,
    };
  }

  function writeBundle(volcano: Record<string, unknown>): string {
    const fixture = JSON.parse(readFileSync(basePath, "utf8")) as Record<string, unknown>;
    (fixture.telegramFoundation as Record<string, unknown>).volcano = volcano;
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(standbyPersistenceV2Path(path), JSON.stringify(fixture), "utf8");
    return path;
  }

  function loadBundle(volcano: Record<string, unknown>): {
    path: string;
    persistence: StandbyPersistence;
    quarantined: boolean;
    repairState: VolcanoRepairStateV1;
    volcanoes: PersistedVolcanoStateV2["volcanoes"];
    state: Parameters<StandbyPersistence["save"]>[0];
  } {
    const path = writeBundle(volcano);
    const persistence = new StandbyPersistence(path);
    const result = persistence.loadWithResult(Date.parse("2026-08-31T01:00:00.000Z"));
    if (result.startup.kind === "fatal" || result.state == null) {
      throw new Error("expected a restored standby state");
    }
    const foundation = result.state.telegramFoundation.volcano;
    const state = foundation.state as PersistedVolcanoStateV2 | null;
    return {
      path,
      persistence,
      quarantined: result.volcanoDomainQuarantined,
      repairState: foundation.repairState!,
      volcanoes: state?.volcanoes ?? [],
      state: result.state,
    };
  }

  it("空文字 serial の alert gate でも salvage が例外なく完走し omission を canonical null で残す", () => {
    // slice を壊して sliceCorrupt にし、omission の comparison を gate から採らせる。
    const brokenAlert = { ...alertSlice("1"), appliedSemanticKey: "" };
    const loaded = loadBundle(foundationVolcano({
      alert: brokenAlert,
      gates: [alertGate("")],
    }));
    // 修正前は空文字 serial が lastKnownComparison に入って書き込み検証が throw し、
    // 救済のための salvage 自身が terminal quarantine へ落ちていた。
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([
      expect.objectContaining({
        scope: "volcano",
        volcanoCode: "506",
        sourceFamily: "VFVO51",
        reason: "sliceCorrupt",
      }),
    ]);
    expect(loaded.repairState.unrecoverableAlertOmissions[0]?.lastKnownComparison?.revision.serial)
      .toEqual({ raw: null, numeric: null, valid: false });
  });

  it("gate \"080\" × slice \"80\" を 1 候補に束ねて canonical \"80\" で記録する", () => {
    const loaded = loadBundle(foundationVolcano({
      alert: alertSlice("80"),
      gates: [alertGate("080")],
    }));
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableAlertOmissions[0]?.lastKnownComparison?.revision.serial)
      .toEqual({ raw: "80", numeric: 80, valid: true });
  });

  it("空文字 gate と null gate の同居は canonical 化後に同一視され comparison が残る (順序証明)", () => {
    // JSON.stringify の一意性鍵を canonical 化の前に作ると "" と null が別候補になり、
    // size !== 1 で lastKnownComparison が黙って null に落ちる。
    const brokenAlert = { ...alertSlice("1"), appliedSemanticKey: "" };
    const loaded = loadBundle(foundationVolcano({
      alert: brokenAlert,
      gates: [alertGate(""), alertGate(null)],
    }));
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableAlertOmissions[0]?.lastKnownComparison)
      .not.toBeNull();
    expect(loaded.repairState.unrecoverableAlertOmissions[0]?.lastKnownComparison?.revision.serial)
      .toEqual({ raw: null, numeric: null, valid: false });
  });

  it("eruption 側も gate \"080\" × slice \"80\" を canonical \"80\" で記録する", () => {
    const loaded = loadBundle(foundationVolcano({
      eruption: eruptionSlice("80"),
      gates: [eruptionGate("080")],
    }));
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableEruptionOmissions).toEqual([
      expect.objectContaining({ scope: "volcano", volcanoCode: "506" }),
    ]);
    expect(loaded.repairState.unrecoverableEruptionOmissions[0]?.lastKnownComparison
      ?.revision.serial).toEqual({ raw: "80", numeric: 80, valid: true });
  });

  // gate だけが残り slice が一切ない経路（末尾 gate ループ）。uniqueGateComparison も
  // eruption 側の byComparison も通らないので、canonical 化は omission の入口でしか
  // 効かせられない。
  const operationalV2AlertGate = (serial: string | null): Record<string, unknown> => ({
    ...alertGate(serial),
    volcanoProvenance: { kind: "alert", sourceFamily: "operationalV2Unknown" },
  });

  it("slice の無い operationalV2Unknown alert gate \"080\" も canonical \"80\" で記録する", () => {
    const loaded = loadBundle(foundationVolcano({
      gates: [operationalV2AlertGate("080")],
    }));
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([
      expect.objectContaining({
        scope: "volcano",
        volcanoCode: "506",
        sourceFamily: "unknown",
        reason: "provenanceMissing",
      }),
    ]);
    expect(loaded.repairState.unrecoverableAlertOmissions[0]?.lastKnownComparison?.revision.serial)
      .toEqual({ raw: "80", numeric: 80, valid: true });
  });

  it("slice の無い eruption gate \"080\" も canonical \"80\" で記録する", () => {
    const loaded = loadBundle(foundationVolcano({
      gates: [eruptionGate("080")],
    }));
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableEruptionOmissions).toEqual([
      expect.objectContaining({
        scope: "volcano",
        volcanoCode: "506",
        reason: "sliceCorrupt",
      }),
    ]);
    expect(loaded.repairState.unrecoverableEruptionOmissions[0]?.lastKnownComparison
      ?.revision.serial).toEqual({ raw: "80", numeric: 80, valid: true });
  });

  it("slice の無い alert gate の空文字 serial も canonical null に落ちる", () => {
    const loaded = loadBundle(foundationVolcano({
      gates: [operationalV2AlertGate("")],
    }));
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableAlertOmissions[0]?.lastKnownComparison?.revision.serial)
      .toEqual({ raw: null, numeric: null, valid: false });
  });

  it("invalid serial の gate は isGateEntry で落ち comparison 無しの gateCorrupt になる", () => {
    // " 8 " は parseTelegramSerial / normalizeVolcanoAshfallSerial の双方が拒む。
    // isGateEntry の時点で候補から外れるので、invalid serial が omission の
    // lastKnownComparison に到達する経路はそもそも存在しない（repairSafe の
    // null 降格は uniqueGateComparison 側の防波堤として残る）。
    const loaded = loadBundle(foundationVolcano({
      gates: [operationalV2AlertGate(" 8 ")],
    }));
    expect(loaded.quarantined).toBe(false);
    expect(loaded.repairState.unrecoverableAlertOmissions).toEqual([
      expect.objectContaining({
        scope: "volcano",
        volcanoCode: "506",
        reason: "gateCorrupt",
        lastKnownComparison: null,
      }),
    ]);
  });
  it("salvage → 書き出し → 再読込の 2 巡目で omission と pending 状態が安定する", () => {
    const first = loadBundle(foundationVolcano({
      alert: alertSlice("80"),
      gates: [alertGate("080")],
    }));
    expect(first.persistence.hasPendingSalvageRepair()).toBe(true);
    expect(first.persistence.save(first.state)).toMatchObject({ kind: "written" });

    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const second = new StandbyPersistence(first.path);
      const reloaded = second.loadWithResult(Date.parse("2026-08-31T02:00:00.000Z"));
      if (reloaded.startup.kind === "fatal" || reloaded.state == null) {
        throw new Error("expected a restored standby state");
      }
      expect(reloaded.volcanoDomainQuarantined).toBe(false);
      expect(reloaded.state.telegramFoundation.volcano.repairState)
        .toEqual(first.repairState);
      // 2 巡目は火山ドメインの salvage を再発火させない (canonical 形で書けている)。
      expect(warn.mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes("domain=foundation.volcano"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("release-only tsunami keyedActive load migration", () => {
  function realReleaseFixture() {
    const realList = JSON.parse(
      readFileSync("test/fixtures/rest/telegram-list-vtse41-real.json", "utf8"),
    ) as TelegramListResponse;
    const xml = readFileSync("test/fixtures/rest/telegram-body-vtse41-real.xml", "utf8");
    const realItem = realList.items[0];
    const acceptedAtMs = Date.parse(realItem.head.time);
    const message = toWsDataMessageFromRestBody(realItem, xml, acceptedAtMs);
    const release = parseTsunamiTelegram(message)!;
    const holder = new TsunamiStateHolder();
    const gate = new TelegramRevisionGate();
    expect(processTsunami(message, { tsunamiState: holder, revisionGate: gate }).kind).toBe("ok");
    expect(holder.getPersistedKeyedActive()).toEqual([]);
    return { release, gateEntries: gate.exportDurableEntries(), xml, acceptedAtMs };
  }

  function installLegacyReleaseRaw(keyedActive: unknown[]) {
    const path = tempPath();
    expect(new StandbyPersistence(path).save(state())).toMatchObject({ kind: "written" });
    const v2Path = standbyPersistenceV2Path(path);
    const v2 = JSON.parse(readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    const fixture = realReleaseFixture();
    const raw = {
      ...v2,
      telegramFoundation: {
        ...v2.telegramFoundation,
        tsunami: {
          ...v2.telegramFoundation.tsunami,
          active: keyedActive.length === 1 ? keyedActive[0] : null,
          keyedActive,
          legacyActive: null,
          observations: { VTSE51: [], VTSE52: [] },
          gateEntries: fixture.gateEntries,
        },
      },
    };
    const bytes = Buffer.from(JSON.stringify(raw), "utf8");
    writeFileSync(v2Path, bytes);
    return { path, v2Path, raw, bytes, ...fixture };
  }

  it("Pi fixture を一度だけ剪定し backup barrier 後に N+1 pair へ rewrite して stale を維持する", async () => {
    const fixture = realReleaseFixture();
    expect(fixture.release.meta.eventId.value).toBe("20260728162718");
    expect(fixture.release.meta.reportDateTime.raw).toBe("2026-07-28T18:10:00+09:00");
    expect(fixture.release.forecast).toHaveLength(1);
    expect(fixture.release.forecast![0]).toMatchObject({ areaCode: "712", kindCode: "60" });
    expect(fixture.release.warningComment).toBe("現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。");
    expect(fixture.acceptedAtMs).toBe(1785229800000);

    const installed = installLegacyReleaseRaw([fixture.release]);
    const rawV1Before = readFileSync(installed.path);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const persistence = new StandbyPersistence(installed.path, 0);
    const loaded = persistence.loadWithResult(installed.acceptedAtMs + 60_000);
    expect(loaded).toMatchObject({
      startup: { kind: "restored", selectedSource: "v2" },
      sourceStates: { v2: "salvageable", v1: "valid" },
      canonicalRewriteRequired: true,
    });
    expect(loaded.state?.telegramFoundation.tsunami).toMatchObject({
      active: null,
      keyedActive: [],
      legacyActive: null,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: [expect.objectContaining({
        stateSubjectKey: "tsunami:20260728162718",
        cancelled: false,
        acceptedAtMs: 1785229800000,
      })],
    });
    const pruningLine = "[standby-persistence] salvage source=display-active-state-v2.json domain=foundation.tsunami unit=eventId discarded=1 retained=0 reason=release-only-active";
    expect(warn.mock.calls.map(([line]) => line).filter((line) => line === pruningLine))
      .toEqual([pruningLine]);

    const originalOpenSync = fs.openSync;
    const openSync = vi.spyOn(fs, "openSync").mockImplementation((file, flags, ...args) => {
      if (typeof file === "string" && file.endsWith(".salvage-backup") && flags === "wx") {
        const error = new Error("backup blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalOpenSync(file, flags, ...args);
    });
    expect(persistence.save(loaded.state!)).toMatchObject({ kind: "failed", stage: "salvageBackup" });
    expect(readFileSync(installed.v2Path)).toEqual(installed.bytes);
    expect(readFileSync(installed.path)).toEqual(rawV1Before);
    openSync.mockRestore();
    await persistence.__test_writePending();

    const rewrittenV2Bytes = readFileSync(installed.v2Path);
    const rewrittenV2 = JSON.parse(rewrittenV2Bytes.toString("utf8")) as PersistedStandbyStateV2;
    const rewrittenV1 = JSON.parse(readFileSync(installed.path, "utf8")) as PersistedStandbyStateV1 & { logicalGeneration?: string };
    const initialGeneration = BigInt(String(installed.raw.logicalGeneration));
    expect(rewrittenV2.logicalGeneration).toBe((initialGeneration + 1n).toString());
    expect(rewrittenV1.logicalGeneration).toBe(rewrittenV2.logicalGeneration);
    expect(rewrittenV2.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(rewrittenV2.telegramFoundation.tsunami.gateEntries).toEqual(fixture.gateEntries);
    const backups = readdirSync(dirname(installed.path)).filter((name) => name.endsWith(".salvage-backup"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(installed.path), backups[0]!))).toEqual(installed.bytes);

    warn.mockClear();
    const reloadedPersistence = new StandbyPersistence(installed.path);
    const reloaded = reloadedPersistence.loadWithResult(installed.acceptedAtMs + 60_000);
    expect(reloaded).toMatchObject({
      sourceStates: { v2: "valid", v1: "valid" },
      canonicalRewriteRequired: false,
    });
    expect(reloaded.state?.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(reloaded.state?.telegramFoundation.tsunami.gateEntries).toEqual(fixture.gateEntries);
    expect(warn.mock.calls.map(([line]) => line).filter((line) => line === pruningLine)).toEqual([]);
    expect(reloadedPersistence.salvageBackupDiagnostics().pendingSources).toBe(0);

    const restoredHolder = new TsunamiStateHolder();
    restoredHolder.restorePersistedState(
      reloaded.state!.telegramFoundation.tsunami.active ?? null,
      reloaded.state!.telegramFoundation.tsunami.observations,
      reloaded.state!.telegramFoundation.tsunami.keyedActive,
      reloaded.state!.telegramFoundation.tsunami.legacyActive,
    );
    const restoredGate = new TelegramRevisionGate();
    restoredGate.restoreDurableEntries(reloaded.state!.telegramFoundation.tsunami.gateEntries);
    const gateBefore = JSON.stringify(restoredGate.exportDurableEntries());
    const warningXml = fixture.xml
      .replace("2026-07-28T18:10:00+09:00", "2026-07-28T18:00:00+09:00")
      .replace("<Kind><Name>津波注意報解除</Name><Code>60</Code></Kind>", "<Kind><Name>津波注意報</Name><Code>62</Code></Kind>");
    const delayedWarning = createMockWsDataMessageFromXml(warningXml, "VTSE41");
    const decisions: string[] = [];
    const persisted = vi.fn();
    expect(processTsunami(
      { ...delayedWarning, head: { ...delayedWarning.head, time: "2026-07-29T00:00:00.000Z" } },
      {
        tsunamiState: restoredHolder,
        revisionGate: restoredGate,
        onRevisionDecision: (decision) => decisions.push(decision.kind),
        onTsunamiRevisionDecision: persisted,
      },
    )).toEqual({ kind: "suppressed" });
    expect(decisions).toEqual(["stale"]);
    expect(persisted).not.toHaveBeenCalled();
    expect(restoredHolder.getPersistedKeyedActive()).toEqual([]);
    expect(JSON.stringify(restoredGate.exportDurableEntries())).toBe(gateBefore);
    expect(readFileSync(installed.v2Path)).toEqual(rewrittenV2Bytes);
    warn.mockRestore();
  });

  it("最新 release-only candidate を選んだ後に剪定し古い警報を復活させない", () => {
    const fixture = realReleaseFixture();
    const oldWarning = {
      ...structuredClone(fixture.release),
      meta: createTelegramMeta({
        messageId: "old-warning",
        eventId: "20260728162718",
        type: "VTSE41",
        reportDateTime: "2026-07-28T18:00:00+09:00",
        serial: null,
        infoType: "発表",
        receivedAtMs: fixture.acceptedAtMs - 600_000,
        status: "通常",
        isTest: false,
      }),
      reportDateTime: "2026-07-28T18:00:00+09:00",
      forecast: fixture.release.forecast!.map((item) => ({
        ...item,
        kindCode: "62",
        kindName: "津波注意報",
        kind: "津波注意報",
      })),
    };
    const installed = installLegacyReleaseRaw([oldWarning, fixture.release]);
    const loaded = new StandbyPersistence(installed.path).loadWithResult(installed.acceptedAtMs + 60_000);
    expect(loaded.state?.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(loaded.state?.telegramFoundation.tsunami.gateEntries).toEqual(fixture.gateEntries);
  });

  it("canonical writer は release-only keyed input を validation failure にする", () => {
    const fixture = realReleaseFixture();
    const path = tempPath();
    const persistence = new StandbyPersistence(path);
    const foundation: PersistedTelegramFoundationInputV2 = {
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      vpww56: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: [fixture.release],
        legacyActive: null,
        observations: { VTSE51: [], VTSE52: [] },
        gateEntries: fixture.gateEntries,
      },
      volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
      floodForecast: { authoritative: true, active: [], gateEntries: [] },
      standbyDomains: { gateEntries: [] },
    };
    expect(() => persistence.serializeProspectivePair(state(), foundation, {
      logicalGeneration: "1",
      savedAt: "2026-07-28T09:11:00.000Z",
    })).toThrow("invalid persisted tsunami writer state");
  });
});

describe("StandbyPersistence logical generation source selection", () => {
  function writtenPair(): {
    path: string;
    v2: Record<string, unknown>;
    v1: Record<string, unknown>;
  } {
    const path = tempPath();
    expect(new StandbyPersistence(path).save(state())).toMatchObject({ kind: "written" });
    return {
      path,
      v2: JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as Record<string, unknown>,
      v1: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    };
  }

  function richWrittenPair(): ReturnType<typeof writtenPair> {
    const path = tempPath();
    const revisionGate = new TelegramRevisionGate();
    const tsunamiState = new TsunamiStateHolder();
    const vpww56State = new Vpww56StateHolder();
    const floodForecastState = new FloodForecastStateHolder();
    const deps = makeProcessDeps({ revisionGate, tsunamiState, vpww56State, floodForecastState });

    for (const fixture of [
      FIXTURE_VTSE41_WARN,
      FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT,
      FIXTURE_VTSE52_OFFSHORE,
    ]) {
      expect(processTsunami(createMockWsDataMessage(fixture), deps).kind).toBe("ok");
    }
    expect(processWeather(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA), deps).kind).toBe("ok");

    const floodMessage = createMockWsDataMessage("16_10_01_260312_VXKO50.xml");
    const parsedFlood = parseFloodForecast(floodMessage);
    expect(parsedFlood).not.toBeNull();
    const floodResult = processFloodForecast(floodMessage, deps, Date.parse(parsedFlood!.reportDateTime));
    expect(floodResult.kind).toBe("ok");
    if (floodResult.kind !== "ok") throw new Error(`expected flood fixture, got ${floodResult.kind}`);
    const floodStore = new StandbyStateStore();
    floodStore.applyEvent({
      ...fromFloodForecastOutcome(floodResult.outcome),
      reportDateTime: floodResult.outcome.parsed.reportDateTime,
    }, Date.parse(floodResult.outcome.parsed.reportDateTime));
    const floodActive = floodStore.exportActiveState().floods?.events ?? [];
    const vpww56GateEntries = revisionGate.exportDurableEntries().filter((entry) =>
      entry.domain === "weather" && entry.revisionFamily === "VPWW56");
    const latestVpww56 = [...vpww56GateEntries].sort((left, right) => {
      const timeOrder = right.comparison.revision.reportDateTime.epochMs!
        - left.comparison.revision.reportDateTime.epochMs!;
      return timeOrder !== 0 ? timeOrder : right.acceptedAtMs - left.acceptedAtMs;
    })[0];
    const vpww56ReportTimeMs = latestVpww56?.comparison.revision.reportDateTime.epochMs;
    if (latestVpww56 == null || vpww56ReportTimeMs == null) {
      throw new Error("expected a valid VPWW56 revision");
    }
    const vpww56Serial = latestVpww56.comparison.revision.serial.raw;

    const foundation: PersistedTelegramFoundationInputV2 = {
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      vpww56: {
        generation: VPWW56_SNAPSHOT_GENERATION,
        authoritative: true,
        state: vpww56State.exportPersistedState(),
        gateEntries: vpww56GateEntries,
      },
      tsunami: {
        keyedActive: tsunamiState.getPersistedKeyedActive(),
        legacyActive: tsunamiState.getPersistedLegacyActive(),
        observations: tsunamiState.getObservationGroups(),
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          entry.domain === "tsunami" || entry.domain === "tsunamiObservation"),
      },
      volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: floodActive,
        gateEntries: revisionGate.exportDurableEntries().filter((entry) =>
          entry.domain === "floodForecast"),
      },
      standbyDomains: { gateEntries: [] },
    };
    expect(foundation.tsunami?.keyedActive).not.toHaveLength(0);
    expect(foundation.tsunami?.observations.VTSE51).not.toHaveLength(0);
    expect(foundation.tsunami?.observations.VTSE52).not.toHaveLength(0);
    expect(foundation.vpww56?.state?.streams).not.toHaveLength(0);
    expect(foundation.floodForecast?.active).not.toHaveLength(0);
    expect(foundation.floodForecast?.gateEntries).not.toHaveLength(0);

    expect(new StandbyPersistence(path, 0, () => foundation).save(state({
      floods: { events: structuredClone(floodActive), seen: [] },
      weatherAlerts: [{
        source: "vpww56",
        alerts: weatherAlertsFromVpww56(
          vpww56State.getCurrentAreasForDisplay(),
          new Date(vpww56ReportTimeMs).toISOString(),
        ),
        revision: { reportTimeMs: vpww56ReportTimeMs, serial: vpww56Serial },
        expiresAtMs: vpww56ReportTimeMs + 86_400_000,
      }],
    }))).toMatchObject({ kind: "written" });
    return {
      path,
      v2: JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")) as Record<string, unknown>,
      v1: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    };
  }

  function installPair(
    fixture: ReturnType<typeof writtenPair>,
    v2: Record<string, unknown>,
    v1: Record<string, unknown>,
  ): void {
    writeFileSync(standbyPersistenceV2Path(fixture.path), JSON.stringify(v2), "utf8");
    writeFileSync(fixture.path, JSON.stringify(v1), "utf8");
  }

  it("keeps every rich v2 foundation domain through an old v1-first partial commit and N+1 rewrite", () => {
    const fixture = richWrittenPair();
    const newerV1Heat = structuredClone(fixture.v1.heat) as Array<Record<string, unknown>>;
    newerV1Heat[0] = { ...newerV1Heat[0], sourceEventIds: ["v1-newer-root-content"] };
    const oldCanonicalV2: Record<string, unknown> = {
      ...fixture.v2,
      logicalGeneration: "8",
      savedAt: "2026-07-21T00:00:00.000Z",
    };
    const newerRollbackV1 = {
      ...fixture.v1,
      heat: newerV1Heat,
      logicalGeneration: "9",
      savedAt: "2026-07-21T01:00:00.000Z",
    };
    installPair(
      fixture,
      oldCanonicalV2,
      newerRollbackV1,
    );

    const persistence = new StandbyPersistence(fixture.path);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const expectedFoundation = oldCanonicalV2.telegramFoundation as PersistedStandbyStateV2["telegramFoundation"];
      const result = persistence.loadWithResult(T0);
      expect(result).toMatchObject({
        startup: { kind: "restored", selectedSource: "v2" },
        selectedLogicalGeneration: "8",
        canonicalRewriteRequired: true,
      });
      expect(persistence.takeMigrationConflictCount()).toBe(1);
      const conflict = "[standby-persistence] persistenceMigrationConflict: rollbackMirrorAheadOfCanonicalV2";
      expect(warn.mock.calls.map(([message]) => message).filter((message) => message === conflict))
        .toEqual([conflict]);
      expect(result.state).not.toBeNull();
      expect(result.state?.heat).toEqual(fixture.v2.heat);
      expect(result.state?.heat).not.toEqual(newerV1Heat);
      expect(result.state?.telegramFoundation.vpww56).toEqual(expectedFoundation.vpww56);
      expect(result.state?.telegramFoundation.tsunami.keyedActive).toEqual(expectedFoundation.tsunami.keyedActive);
      expect(result.state?.telegramFoundation.tsunami.observations.VTSE51)
        .toEqual(expectedFoundation.tsunami.observations.VTSE51);
      expect(result.state?.telegramFoundation.tsunami.observations.VTSE52)
        .toEqual(expectedFoundation.tsunami.observations.VTSE52);
      expect(result.state?.telegramFoundation.floodForecast).toEqual(expectedFoundation.floodForecast);
      expect(persistence.save(result.state!)).toMatchObject({ kind: "written" });
      const rewrittenV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(fixture.path), "utf8"));
      const rewrittenV1 = JSON.parse(readFileSync(fixture.path, "utf8"));
      expect(rewrittenV2).toMatchObject({ logicalGeneration: "10" });
      expect(rewrittenV1).toMatchObject({ logicalGeneration: "10" });
      expect(rewrittenV2.telegramFoundation.vpww56).toEqual(expectedFoundation.vpww56);
      expect(rewrittenV2.telegramFoundation.tsunami.keyedActive).toEqual(expectedFoundation.tsunami.keyedActive);
      expect(rewrittenV2.telegramFoundation.tsunami.observations).toEqual(expectedFoundation.tsunami.observations);
      expect(rewrittenV2.telegramFoundation.floodForecast).toEqual(expectedFoundation.floodForecast);
      expect(rewrittenV1.heat).toEqual(fixture.v1.heat);
      expect(rewrittenV1.heat).not.toEqual(newerV1Heat);
      const reloadPersistence = new StandbyPersistence(fixture.path);
      const reloaded = reloadPersistence.loadWithResult(T0);
      expect(reloaded).toMatchObject({
        startup: { kind: "restored", selectedSource: "v2" }, selectedLogicalGeneration: "10",
        canonicalRewriteRequired: false,
      });
      expect(reloadPersistence.takeMigrationConflictCount()).toBe(0);
      expect(reloaded.state?.telegramFoundation.vpww56).toEqual(result.state?.telegramFoundation.vpww56);
      expect(reloaded.state?.telegramFoundation.tsunami.keyedActive)
        .toEqual(result.state?.telegramFoundation.tsunami.keyedActive);
      expect(reloaded.state?.telegramFoundation.tsunami.observations)
        .toEqual(result.state?.telegramFoundation.tsunami.observations);
      expect(reloaded.state?.telegramFoundation.floodForecast)
        .toEqual(result.state?.telegramFoundation.floodForecast);
    } finally {
      warn.mockRestore();
    }
  });

  it("records one fixed rollback conflict when the ahead v1 mirror is salvageable", () => {
    const fixture = writtenPair();
    installPair(
      fixture,
      { ...fixture.v2, logicalGeneration: "8" },
      {
        ...fixture.v1,
        heat: [...fixture.v1.heat as unknown[], { key: "invalid-heat-entry" }],
        logicalGeneration: "9",
      },
    );

    const persistence = new StandbyPersistence(fixture.path);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect(persistence.loadWithResult(T0)).toMatchObject({
        startup: { kind: "restored", selectedSource: "v2" },
        sourceStates: { v2: "valid", v1: "salvageable" },
        selectedLogicalGeneration: "8",
        canonicalRewriteRequired: true,
      });
      expect(persistence.takeMigrationConflictCount()).toBe(1);
      const conflict = "[standby-persistence] persistenceMigrationConflict: rollbackMirrorAheadOfCanonicalV2";
      expect(warn.mock.calls.map(([message]) => message)
        .filter((message) => String(message).includes("persistenceMigrationConflict")))
        .toEqual([conflict]);
    } finally {
      warn.mockRestore();
    }
  });

  it("records the foundation envelope conflict independently for a valid v2-only fallback", () => {
    const fixture = richWrittenPair();
    writeFileSync(standbyPersistenceV2Path(fixture.path), JSON.stringify({
      ...fixture.v2,
      weatherAlerts: [],
    }), "utf8");
    rmSync(fixture.path);

    const persistence = new StandbyPersistence(fixture.path);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect(persistence.loadWithResult(T0)).toMatchObject({
        startup: { kind: "restored", selectedSource: "v2" },
        sourceStates: { v2: "valid", v1: "missing" },
        canonicalRewriteRequired: true,
      });
      expect(persistence.takeMigrationConflictCount()).toBe(2);
      expect(warn.mock.calls.map(([message]) => message)
        .filter((message) => String(message).includes("persistenceMigrationConflict")))
        .toEqual([
          "[standby-persistence] persistenceMigrationConflict: logical generation counterpart unavailable",
          "[standby-persistence] persistenceMigrationConflict: telegram foundation envelope fields differ",
        ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("chooses v2 on an equal coherent generation and requires no envelope rewrite", () => {
    const fixture = writtenPair();
    installPair(
      fixture,
      { ...fixture.v2, logicalGeneration: "9", savedAt: "2026-07-20T00:00:00.000Z" },
      { ...fixture.v1, logicalGeneration: "9", savedAt: "2026-07-21T00:00:00.000Z" },
    );

    const persistence = new StandbyPersistence(fixture.path);
    const result = persistence.loadWithResult(T0);
    expect(result).toMatchObject({
      startup: { kind: "restored", selectedSource: "v2" },
      selectedLogicalGeneration: "9",
      canonicalRewriteRequired: false,
    });
    expect(persistence.takeMigrationConflictCount()).toBe(0);
  });

  it("keeps v2 canonical without a conflict when the rollback mirror is one generation behind", () => {
    const fixture = writtenPair();
    installPair(
      fixture,
      { ...fixture.v2, logicalGeneration: "9" },
      { ...fixture.v1, logicalGeneration: "8" },
    );

    const persistence = new StandbyPersistence(fixture.path);
    expect(persistence.loadWithResult(T0)).toMatchObject({
      startup: { kind: "restored", selectedSource: "v2" },
      selectedLogicalGeneration: "9",
      canonicalRewriteRequired: true,
    });
    expect(persistence.takeMigrationConflictCount()).toBe(0);
  });

  it("selects v2 deterministically and rewrites when an equal generation differs", () => {
    const fixture = writtenPair();
    const v1Heat = structuredClone(fixture.v1.heat) as Array<Record<string, unknown>>;
    v1Heat[0] = { ...v1Heat[0], sourceEventIds: ["different-source"] };
    installPair(
      fixture,
      { ...fixture.v2, logicalGeneration: "9" },
      { ...fixture.v1, heat: v1Heat, logicalGeneration: "9" },
    );

    const persistence = new StandbyPersistence(fixture.path);
    const result = persistence.loadWithResult(T0);
    expect(result).toMatchObject({
      startup: { kind: "restored", selectedSource: "v2" },
      selectedLogicalGeneration: "9",
      canonicalRewriteRequired: true,
    });
    expect(persistence.takeMigrationConflictCount()).toBe(1);
  });

  it("allows only a strictly later markerless rollback snapshot to beat a generated source", () => {
    const fixture = writtenPair();
    const markerlessV1: Record<string, unknown> = {
      ...fixture.v1,
      savedAt: "2026-07-21T01:00:00.000Z",
    };
    delete markerlessV1.logicalGeneration;
    installPair(
      fixture,
      { ...fixture.v2, logicalGeneration: "7", savedAt: "2026-07-21T00:00:00.000Z" },
      markerlessV1,
    );

    expect(new StandbyPersistence(fixture.path).loadWithResult(T0)).toMatchObject({
      startup: { kind: "restored", selectedSource: "v1" },
      selectedLogicalGeneration: null,
      canonicalRewriteRequired: true,
    });

    markerlessV1.savedAt = "2026-07-21T00:00:00.000Z";
    installPair(
      fixture,
      { ...fixture.v2, logicalGeneration: "7", savedAt: markerlessV1.savedAt },
      markerlessV1,
    );
    expect(new StandbyPersistence(fixture.path).loadWithResult(T0)).toMatchObject({
      startup: { kind: "restored", selectedSource: "v2" },
      selectedLogicalGeneration: "7",
      canonicalRewriteRequired: true,
    });
  });

  it("uses savedAt only while both usable sources are markerless, with v2 winning ties", () => {
    const fixture = writtenPair();
    const v2: Record<string, unknown> = {
      ...fixture.v2,
      savedAt: "2026-07-21T00:00:00.000Z",
    };
    const v1: Record<string, unknown> = {
      ...fixture.v1,
      savedAt: "2026-07-21T01:00:00.000Z",
    };
    delete v2.logicalGeneration;
    delete v1.logicalGeneration;
    installPair(fixture, v2, v1);
    expect(new StandbyPersistence(fixture.path).loadWithResult(T0)).toMatchObject({
      startup: { kind: "restored", selectedSource: "v1" },
      canonicalRewriteRequired: true,
    });

    v1.savedAt = v2.savedAt;
    installPair(fixture, v2, v1);
    expect(new StandbyPersistence(fixture.path).loadWithResult(T0)).toMatchObject({
      startup: { kind: "restored", selectedSource: "v2" },
      canonicalRewriteRequired: true,
    });
  });

  it("classifies a present-invalid generation as invalid and never treats it as legacy", () => {
    const fixture = writtenPair();
    installPair(
      fixture,
      { ...fixture.v2, logicalGeneration: "01" },
      { ...fixture.v1, logicalGeneration: "4" },
    );

    expect(new StandbyPersistence(fixture.path).loadWithResult(T0)).toMatchObject({
      startup: { kind: "restored", selectedSource: "v1" },
      sourceStates: { v2: "invalid", v1: "valid" },
      selectedLogicalGeneration: "4",
      canonicalRewriteRequired: true,
      backupStates: { v2: "pendingBackup" },
    });
  });
});

describe("pinned v3.4.0 writer volcano migration fixture", () => {
  const fixtureRoot = join(process.cwd(), "test", "fixtures", "standby-persistence");
  const inputPath = join(fixtureRoot, "v3.4.0-writer-input.json");
  const outputPath = join(fixtureRoot, "v3.4.0-writer-output.json");
  const provenancePath = join(fixtureRoot, "v3.4.0-writer-provenance.json");
  const sha256 = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

  it("artifact provenance pins input/output bytes and the legacy writer drop surface", () => {
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      artifact: {
        packageVersion: string;
        baseOid: string;
        nodeVersion: string;
        fixedClock: string;
        assuranceBoundary: string;
      };
      input: { path: string; sha256: string };
      output: { path: string; sha256: string };
      droppedTopLevelProperties: string[];
    };
    expect(provenance).toMatchObject({
      artifact: {
        packageVersion: "3.4.0",
        baseOid: "3c19768e52fe9e9d325e8199555d540fd0de004d",
        nodeVersion: "22.23.2",
        fixedClock: "2021-05-14T03:41:00.000Z",
        assuranceBoundary: "The guarantee is limited to safe migration from the declared golden bytes; execution of the legacy writer is not reproduced.",
      },
      input: { path: "v3.4.0-writer-input.json" },
      output: { path: "v3.4.0-writer-output.json" },
      droppedTopLevelProperties: [
        "logicalGeneration",
        "volcanoAlertGateMetadata",
        "volcanoAshfallGateMetadata",
        "volcanoRepairState",
      ],
    });
    expect(sha256(inputPath)).toBe(provenance.input.sha256);
    expect(sha256(outputPath)).toBe(provenance.output.sha256);

    const input = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
    const output = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    for (const property of provenance.droppedTopLevelProperties) delete input[property];
    expect(output).toEqual(input);
  });

  it("metadataを落としたactive ashfallを復元せずreserved GTと保守的repairへ移す", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2021-05-14T03:52:00.000Z");
    try {
      const path = tempPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(outputPath));
      const persistence = new StandbyPersistence(path);
      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.volcanoes).toEqual([]);
      expect(loaded!.telegramFoundation.volcano.state).toEqual({
        generation: 1,
        volcanoes: [],
      });
      expect(loaded!.telegramFoundation.volcano.gateEntries).toEqual([
        expect.objectContaining({
          domain: "volcano",
          revisionFamily: "volcanoAshfall",
          stateSubjectKey: "volcano:ashfall:506",
          semanticKeys: [],
          cancelled: true,
          acceptedAtMs: 1620963600000,
          volcanoProvenance: {
            kind: "ashfall",
            actualEventId: null,
            sourceType: null,
          },
          comparison: expect.objectContaining({
            stateSubjectKey: "volcano:ashfall:506",
            variantRank: 1,
            revision: expect.objectContaining({
              infoType: { raw: "取消", value: "取消", valid: true },
            }),
          }),
        }),
      ]);
      expect(loaded!.telegramFoundation.volcano.repairState).toEqual({
        schemaGeneration: 1,
        vfvo50Repairable: true,
        ashfallRepairable: true,
        unrecoverableAlertOmissions: [{
          scope: "domain",
          volcanoCode: null,
          sourceFamily: "unknown",
          lastKnownComparison: null,
          reason: "provenanceMissing",
        }],
        unrecoverableEruptionOmissions: [],
        operationalV2AlertResolutions: [],
      });
      expect(persistence.hasPendingSalvageRepair()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("volcano acceptedAt future skew accepts +15m and rejects +15m+1 in v1 migration and generation-1", () => {
    const reportTimeMs = Date.parse("2021-05-14T03:40:00.000Z");
    const startupNowMs = reportTimeMs - 15 * 60_000;
    const retentionMs = 7 * 24 * 60 * 60_000;
    const legacySource = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
    const loadLegacy = (offsetMs: number) => {
      const path = tempPath();
      mkdirSync(dirname(path), { recursive: true });
      const source = structuredClone(legacySource) as {
        seen: Array<{ key: string; forgetAtMs: number }>;
      };
      source.seen[0]!.forgetAtMs = reportTimeMs + offsetMs + retentionMs + 1;
      writeFileSync(path, JSON.stringify(source), "utf8");
      return new StandbyPersistence(path).loadWithResult(startupNowMs);
    };

    const exactLegacy = loadLegacy(0);
    expect(exactLegacy.state?.telegramFoundation.volcano.gateEntries).toEqual([
      expect.objectContaining({
        revisionFamily: "volcanoAshfall",
        acceptedAtMs: reportTimeMs,
      }),
    ]);
    expect(loadLegacy(1).state?.telegramFoundation.volcano.gateEntries).toEqual([]);

    const generationPath = tempPath();
    expect(new StandbyPersistence(generationPath).save(exactLegacy.state!))
      .toMatchObject({ kind: "written" });
    rmSync(generationPath);
    const v2Path = standbyPersistenceV2Path(generationPath);
    const generationSource = JSON.parse(readFileSync(v2Path, "utf8")) as {
      telegramFoundation: { volcano: { gateEntries: Array<{ acceptedAtMs: number }> } };
      seen: Array<{ key: string; forgetAtMs: number }>;
    };
    const installGenerationOffset = (offsetMs: number) => {
      generationSource.telegramFoundation.volcano.gateEntries[0]!.acceptedAtMs =
        reportTimeMs + offsetMs;
      generationSource.seen.find((entry) => entry.key === "volcano:ashfall:506")!.forgetAtMs =
        reportTimeMs + offsetMs + retentionMs + 1;
      writeFileSync(v2Path, JSON.stringify(generationSource), "utf8");
      return new StandbyPersistence(generationPath).loadWithResult(startupNowMs);
    };
    expect(installGenerationOffset(0).state?.telegramFoundation.volcano.gateEntries)
      .toHaveLength(1);
    expect(installGenerationOffset(1).state?.telegramFoundation.volcano.gateEntries)
      .toEqual([]);
  });

  it("volcanoRepairStateをabsent／valid object／present-invalidでown-property分類する", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2021-05-14T03:52:00.000Z");
    try {
      const source = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
      const minimal = {
        ...source,
        volcanoes: [],
        seen: [],
        volcanoAlertGateMetadata: [],
        volcanoAshfallGateMetadata: [],
      };
      const emptyRepair = {
        schemaGeneration: 1,
        vfvo50Repairable: false,
        ashfallRepairable: false,
        unrecoverableAlertOmissions: [],
        unrecoverableEruptionOmissions: [],
        operationalV2AlertResolutions: [],
      };
      const loadRepair = (repair: unknown, present: boolean) => {
        const path = tempPath();
        mkdirSync(dirname(path), { recursive: true });
        const candidate = { ...minimal } as Record<string, unknown>;
        if (present) candidate.volcanoRepairState = repair;
        writeFileSync(path, JSON.stringify(candidate), "utf8");
        return new StandbyPersistence(path).load()!.telegramFoundation.volcano.repairState;
      };

      expect(loadRepair(undefined, false)).toEqual({
        ...emptyRepair,
        vfvo50Repairable: true,
        unrecoverableAlertOmissions: [expect.objectContaining({
          scope: "domain", sourceFamily: "unknown", reason: "provenanceMissing",
        })],
      });
      expect(loadRepair(emptyRepair, true)).toEqual(emptyRepair);
      expect(loadRepair(null, true)).toEqual({
        ...emptyRepair,
        vfvo50Repairable: true,
        ashfallRepairable: true,
        unrecoverableAlertOmissions: [expect.objectContaining({ scope: "domain" })],
        unrecoverableEruptionOmissions: [expect.objectContaining({ scope: "domain" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("StandbyPersistence の遅延保存", () => {
  it("schedule しただけでは書かない (同期 I/O を受信経路から外す)", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state());

    expect(existsSync(path)).toBe(false);
  });

  it("debounce 経過後に書かれ、内容は最後に schedule した状態になる", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10);

    persistence.schedule(state({ savedAt: "first" }));
    persistence.schedule(state({ savedAt: "second" }));
    persistence.schedule(state({ savedAt: "latest" }));

    await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 3000 });
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("latest");
  });

  it("flush は予約済みの状態を即座に書き切る (終了時の取りこぼし防止)", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state({ savedAt: "pending" }));
    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("pending");
  });

  it("stopTimer は debounce だけを止め、shutdown 用の pending を保持する", async () => {
    vi.useFakeTimers();
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state({ savedAt: "shutdown-pending" }));
    persistence.stopTimer();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(existsSync(path)).toBe(false);

    persistence.flush();
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("shutdown-pending");
  });

  it("flush 後は予約が消え、残ったタイマーが発火しても書き直さない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10);

    persistence.schedule(state());
    persistence.flush();
    rmSync(path);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(existsSync(path)).toBe(false);
  });

  it("予約がないときの flush は既存ファイルを壊さない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "kept" }));
    persistence.flush();

    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("kept");
  });
});

// 同期保存 (シャットダウン経路) と debounce の非同期書き込みが同じ tmp を奪い合い、
// 古い非同期書き込みが後から rename して最終状態を巻き戻す不具合の回帰テスト。
// 実時間には頼らず、__test_writePending() で予約分を任意のタイミングで走らせる
describe("StandbyPersistence の書き込み順序", () => {
  const tmpFiles = (path: string): string[] =>
    readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"));

  function renameFailureFixture(failingDestination: "v2" | "v1"): {
    path: string;
    v2Path: string;
    persistence: StandbyPersistence;
    newState: PersistedStandbyStateV1;
    oldV2: Record<string, unknown>;
    oldV1: Record<string, unknown>;
    expectedV2: Record<string, unknown>;
    expectedV1: Record<string, unknown>;
    primaryCause: Error;
    allowRename(): void;
    cleanupFailureCount(): number;
    renameDestinations(): string[];
    restoreSpies(): void;
  } {
    const oldState = state({ savedAt: "old" });
    oldState.heat[0] = { ...oldState.heat[0]!, sourceEventIds: ["old-content"] };
    const newState = state({ savedAt: "new" });
    newState.heat[0] = { ...newState.heat[0]!, sourceEventIds: ["new-content"] };

    const expectedPath = tempPath();
    const expectedPersistence = new StandbyPersistence(expectedPath, 10_000);
    expect(expectedPersistence.save(oldState)).toMatchObject({ kind: "written" });
    expect(expectedPersistence.save(newState)).toMatchObject({ kind: "written" });
    const expectedV2 = JSON.parse(readFileSync(standbyPersistenceV2Path(expectedPath), "utf8"));
    const expectedV1 = JSON.parse(readFileSync(expectedPath, "utf8"));

    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    expect(persistence.save(oldState)).toMatchObject({ kind: "written" });
    const v2Path = standbyPersistenceV2Path(path);
    const oldV2 = JSON.parse(readFileSync(v2Path, "utf8"));
    const oldV1 = JSON.parse(readFileSync(path, "utf8"));
    const originalRename = fs.renameSync;
    const originalRm = fs.rmSync;
    let fail = true;
    let cleanupFailures = 0;
    const primaryCause = new Error(`${failingDestination} rename blocked`);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      const target = failingDestination === "v2" ? v2Path : path;
      if (fail && destination === target) throw primaryCause;
      return originalRename(source, destination);
    });
    const cleanup = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      originalRm(target, options);
      if (fail && String(target).endsWith(".tmp")) {
        cleanupFailures += 1;
        throw new Error("cleanup blocked after removal");
      }
    });
    return {
      path,
      v2Path,
      persistence,
      newState,
      oldV2,
      oldV1,
      expectedV2,
      expectedV1,
      primaryCause,
      allowRename: () => { fail = false; },
      cleanupFailureCount: () => cleanupFailures,
      renameDestinations: () => rename.mock.calls.map(([, destination]) => String(destination)),
      restoreSpies: () => {
        cleanup.mockRestore();
        rename.mockRestore();
      },
    };
  }

  function diskSnapshot(filePath: string): Record<string, unknown> {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  }

  function expectRenameRetryCompleted(fixture: ReturnType<typeof renameFailureFixture>): void {
    expect(diskSnapshot(fixture.v2Path)).toEqual(fixture.expectedV2);
    expect(diskSnapshot(fixture.path)).toEqual(fixture.expectedV1);
    expect(diskSnapshot(fixture.v2Path)).toMatchObject({ logicalGeneration: "2" });
    expect(diskSnapshot(fixture.path)).toMatchObject({ logicalGeneration: "2" });
    expect(fixture.persistence.lastFailure()).toBeNull();
    expect(fixture.persistence.flushThrough(2)).toEqual({
      kind: "alreadyWritten", requiredSeq: 2, writtenSeq: 2,
    });
    expect(tmpFiles(fixture.path)).toEqual([]);
  }

  it("async debounce failure は typed lastFailure と pending を保持し、自動成功扱いにしない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const write = vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(new Error("disk-full"));
    persistence.schedule(state({ savedAt: "pending-after-failure" }));
    await persistence.__test_writePending();

    expect(persistence.isUnhealthy()).toBe(true);
    expect(persistence.lastFailure()).toMatchObject({
      kind: "failed",
      requestedSeq: 1,
      failedSeq: 1,
      stage: "writeV2Temp",
      pendingRetained: true,
      partialCommit: "none",
      cause: expect.objectContaining({ message: "disk-full" }),
    });
    expect(existsSync(path)).toBe(false);

    write.mockRestore();
    await persistence.__test_writePending();
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("pending-after-failure");
    expect(persistence.lastFailure()).toBeNull();
    expect(persistence.isUnhealthy()).toBe(false);
  });

  it("sync renameV2 failure は両 mirror を旧世代のまま保持し、同じ pending を v2→v1 で再試行する", () => {
    const fixture = renameFailureFixture("v2");
    try {
      const failure = fixture.persistence.save(fixture.newState);
      expect(failure).toMatchObject({
        kind: "failed", stage: "renameV2", partialCommit: "none", pendingRetained: true,
      });
      expect(failure.kind === "failed" ? failure.cause : null).toBe(fixture.primaryCause);
      expect(fixture.cleanupFailureCount()).toBeGreaterThan(0);
      expect(diskSnapshot(fixture.v2Path)).toEqual(fixture.oldV2);
      expect(diskSnapshot(fixture.path)).toEqual(fixture.oldV1);
      expect(tmpFiles(fixture.path)).toEqual([]);

      fixture.allowRename();
      fixture.persistence.flush();
      expectRenameRetryCompleted(fixture);
      expect(fixture.renameDestinations()
        .filter((destination) => destination === fixture.v2Path || destination === fixture.path))
        .toEqual([fixture.v2Path, fixture.v2Path, fixture.path]);
    } finally {
      fixture.restoreSpies();
    }
  });

  it("sync renameV1 failure は v2Only を保持し、同じ pending を v2→v1 で再試行する", () => {
    const fixture = renameFailureFixture("v1");
    try {
      const failure = fixture.persistence.save(fixture.newState);
      expect(failure).toMatchObject({
        kind: "failed", stage: "renameV1", partialCommit: "v2Only", pendingRetained: true,
      });
      expect(failure.kind === "failed" ? failure.cause : null).toBe(fixture.primaryCause);
      expect(fixture.cleanupFailureCount()).toBeGreaterThan(0);
      expect(diskSnapshot(fixture.v2Path)).toEqual(fixture.expectedV2);
      expect(diskSnapshot(fixture.path)).toEqual(fixture.oldV1);
      expect(tmpFiles(fixture.path)).toEqual([]);

      fixture.allowRename();
      fixture.persistence.flush();
      expectRenameRetryCompleted(fixture);
      expect(fixture.renameDestinations()
        .filter((destination) => destination === fixture.v2Path || destination === fixture.path))
        .toEqual([fixture.v2Path, fixture.path, fixture.v2Path, fixture.path]);
    } finally {
      fixture.restoreSpies();
    }
  });

  it("async renameV2 failure は両 mirror を旧世代のまま保持し、同じ pending を v2→v1 で再試行する", async () => {
    const fixture = renameFailureFixture("v2");
    try {
      fixture.persistence.schedule(fixture.newState);
      await fixture.persistence.__test_writePending();
      const failure = fixture.persistence.lastFailure();
      expect(failure).toMatchObject({
        kind: "failed", stage: "renameV2", partialCommit: "none", pendingRetained: true,
      });
      expect(failure?.cause).toBe(fixture.primaryCause);
      expect(fixture.cleanupFailureCount()).toBeGreaterThan(0);
      expect(diskSnapshot(fixture.v2Path)).toEqual(fixture.oldV2);
      expect(diskSnapshot(fixture.path)).toEqual(fixture.oldV1);
      expect(tmpFiles(fixture.path)).toEqual([]);

      fixture.allowRename();
      await fixture.persistence.__test_writePending();
      expectRenameRetryCompleted(fixture);
      expect(fixture.renameDestinations()
        .filter((destination) => destination === fixture.v2Path || destination === fixture.path))
        .toEqual([fixture.v2Path, fixture.v2Path, fixture.path]);
    } finally {
      fixture.restoreSpies();
    }
  });

  it("async renameV1 failure は v2Only を保持し、同じ pending を v2→v1 で再試行する", async () => {
    const fixture = renameFailureFixture("v1");
    try {
      fixture.persistence.schedule(fixture.newState);
      await fixture.persistence.__test_writePending();
      const failure = fixture.persistence.lastFailure();
      expect(failure).toMatchObject({
        kind: "failed", stage: "renameV1", partialCommit: "v2Only", pendingRetained: true,
      });
      expect(failure?.cause).toBe(fixture.primaryCause);
      expect(fixture.cleanupFailureCount()).toBeGreaterThan(0);
      expect(diskSnapshot(fixture.v2Path)).toEqual(fixture.expectedV2);
      expect(diskSnapshot(fixture.path)).toEqual(fixture.oldV1);
      expect(tmpFiles(fixture.path)).toEqual([]);

      fixture.allowRename();
      await fixture.persistence.__test_writePending();
      expectRenameRetryCompleted(fixture);
      expect(fixture.renameDestinations()
        .filter((destination) => destination === fixture.v2Path || destination === fixture.path))
        .toEqual([fixture.v2Path, fixture.path, fixture.v2Path, fixture.path]);
    } finally {
      fixture.restoreSpies();
    }
  });

  it("sync directory fsync failure は両 rename 後の unknown partial commit として返す", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const realFsync = fs.fsyncSync.bind(fs);
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("directory fsync failed");
      realFsync(fd);
    });
    try {
      expect(persistence.save(state({ savedAt: "renamed-but-not-fsynced" }))).toMatchObject({
        kind: "failed",
        stage: "directoryFsync",
        pendingRetained: true,
        partialCommit: "unknown",
        cause: expect.objectContaining({ message: "directory fsync failed" }),
      });
      expect(existsSync(path)).toBe(true);
      expect(existsSync(standbyPersistenceV2Path(path))).toBe(true);
    } finally {
      fsync.mockRestore();
    }
  });

  it("async directory fsync failure は typed failure と同一 snapshot retry を保持する", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const realFsync = fs.fsyncSync.bind(fs);
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("directory fsync failed");
      realFsync(fd);
    });
    persistence.schedule(state({ savedAt: "retry-same-snapshot" }));
    await persistence.__test_writePending();
    expect(persistence.lastFailure()).toMatchObject({
      kind: "failed",
      stage: "directoryFsync",
      pendingRetained: true,
      partialCommit: "unknown",
    });

    fsync.mockRestore();
    await persistence.__test_writePending();
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("retry-same-snapshot");
    expect(persistence.lastFailure()).toBeNull();
  });

  it("追い越された書き込みは rename しない (同期保存が後勝ちされない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");

    await persistence.__test_writePending();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  it("非同期書き込みの進行中に同期保存が割り込んでも旧内容で上書きしない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));

    // 書き込みを開始させ、完了を待たずに同期保存を割り込ませる
    const inFlight = persistence.__test_writePending();
    persistence.save(state({ savedAt: "new" }));
    await inFlight;

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  it("追い越された書き込みの後も次の保存が反映される (rename 済み seq が逆行しない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));
    await persistence.__test_writePending();

    persistence.save(state({ savedAt: "newest" }));

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("newest");
  });

  it("予約が同期保存より新しい場合は通常どおり書かれる", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.save(state({ savedAt: "old" }));
    persistence.schedule(state({ savedAt: "new" }));

    await persistence.__test_writePending();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
  });

  it("同期保存と非同期書き込みは別々の tmp を使う (奪い合いを構造的に消す)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const syncWrite = vi.spyOn(fs, "writeFileSync");
    const asyncWrite = vi.spyOn(fs.promises, "writeFile");
    try {
      persistence.schedule(state({ savedAt: "old" }));
      const inFlight = persistence.__test_writePending();
      persistence.save(state({ savedAt: "new" }));
      await inFlight;

      const syncTmp = syncWrite.mock.calls.map((call) => String(call[0]));
      const asyncTmp = asyncWrite.mock.calls.map((call) => String(call[0]));
      expect(syncTmp).toHaveLength(2);
      expect(asyncTmp).toHaveLength(2);
      expect(new Set([...syncTmp, ...asyncTmp]).size).toBe(4);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(tmpFiles(path)).toEqual([]);
    } finally {
      syncWrite.mockRestore();
      asyncWrite.mockRestore();
    }
  });

  it("同期保存より古い予約は flush で書き戻されない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));

    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  // seq の判定と rename の間に await があると、guard 通過後・rename 完了前に同期保存が
  // 割り込み、古い rename が後から旧内容で上書きする。非同期 rename を使わないことで担保する
  it("rename は同期で行う (seq 判定との間に await を挟まない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const rename = vi.spyOn(fs.promises, "rename");
    try {
      persistence.schedule(state({ savedAt: "written" }));
      await persistence.__test_writePending();

      expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("written");
      expect(rename).not.toHaveBeenCalled();
    } finally {
      rename.mockRestore();
    }
  });

  it("load 時に自分の残留 tmp だけを掃除する (無関係な .tmp は消さない)", () => {
    const path = tempPath();
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path}.3.tmp`, "{}", "utf8");
    writeFileSync(`${path}.8.tmp`, "{}", "utf8");
    writeFileSync(join(dir, "other.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "weather-promotion-v1.json.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "unrelated.txt"), "keep", "utf8");

    new StandbyPersistence(path).load();

    expect(existsSync(`${path}.3.tmp`)).toBe(false);
    expect(existsSync(`${path}.8.tmp`)).toBe(false);
    expect(existsSync(join(dir, "other.tmp"))).toBe(true);
    expect(existsSync(join(dir, "weather-promotion-v1.json.tmp"))).toBe(true);
    expect(existsSync(join(dir, "unrelated.txt"))).toBe(true);
  });
});

describe("backup generation pruning", () => {
  const V1_BASE = "display-active-state-v1.json";
  const V2_BASE = "display-active-state-v2.json";

  function nameOf(filePath: string): string {
    return filePath.slice(dirname(filePath).length + 1);
  }

  function generations(runtimeDir: string, base: string, extension: string): string[] {
    return readdirSync(runtimeDir)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith(extension))
      .sort();
  }

  function expectBackedUp(
    result: VolcanoManualBackupResult,
  ): { source: "v2" | "v1"; path: string; reused: boolean }[] {
    if (result.kind !== "backedUp") throw new Error(`expected backedUp but got ${JSON.stringify(result)}`);
    return result.files;
  }

  function seedBothMirrors(): { path: string; v2Path: string; dir: string } {
    const path = tempPath();
    const seed = new StandbyPersistence(path, 0);
    seed.save(state());
    const v2Path = standbyPersistenceV2Path(path);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(v2Path)).toBe(true);
    return { path, v2Path, dir: dirname(path) };
  }

  /** 内容を毎回変えて dedup 再利用を避け、新規 backup を 1 世代進める。 */
  function manualRound(path: string, v2Path: string, round: number): { v2: string; v1: string } {
    writeFileSync(v2Path, `{"round":${round},"mirror":"v2"}`, "utf8");
    writeFileSync(path, `{"round":${round},"mirror":"v1"}`, "utf8");
    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));
    expect(files.map((file) => file.reused)).toEqual([false, false]);
    return { v2: nameOf(files[0]!.path), v1: nameOf(files[1]!.path) };
  }

  async function salvageRound(path: string, round: number): Promise<void> {
    const raw = Buffer.from(
      `${JSON.stringify({ ...state(), heat: [{ key: `broken-${round}` }] }, null, 2)}\n`,
      "utf8",
    );
    // v2 mirror が生きていると load が v1 まで降りず salvage が起きない。
    rmSync(standbyPersistenceV2Path(path), { force: true });
    writeFileSync(path, raw);
    const persistence = new StandbyPersistence(path, 0);
    expect(persistence.load()?.heat).toEqual([]);
    persistence.schedule(state());
    await persistence.__test_writePending();
  }

  it("4 世代目の書き込みで最古が消え 3 件だけ残る", () => {
    const { path, v2Path, dir } = seedBothMirrors();

    const rounds = [0, 1, 2, 3].map((round) => manualRound(path, v2Path, round));

    const kept = generations(dir, V2_BASE, ".manual-backup");
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(rounds[0]!.v2);
    expect(kept.sort()).toEqual([rounds[1]!.v2, rounds[2]!.v2, rounds[3]!.v2].sort());
    expect(readFileSync(join(dir, rounds[3]!.v2), "utf8")).toBe(`{"round":3,"mirror":"v2"}`);
  });

  it("v1 と v2 は別々に 3 世代ずつ数える", () => {
    const { path, v2Path, dir } = seedBothMirrors();

    const rounds = [0, 1, 2, 3].map((round) => manualRound(path, v2Path, round));

    expect(generations(dir, V2_BASE, ".manual-backup")).toHaveLength(3);
    const v1Kept = generations(dir, V1_BASE, ".manual-backup");
    expect(v1Kept).toHaveLength(3);
    expect(v1Kept).not.toContain(rounds[0]!.v1);
    expect(v1Kept.sort()).toEqual([rounds[1]!.v1, rounds[2]!.v1, rounds[3]!.v1].sort());
  });

  it(".salvage-backup と .manual-backup は別々に 3 世代ずつ数える", async () => {
    const { path, v2Path, dir } = seedBothMirrors();
    [0, 1, 2].forEach((round) => manualRound(path, v2Path, round));
    expect(generations(dir, V1_BASE, ".manual-backup")).toHaveLength(3);

    for (const round of [0, 1, 2, 3]) await salvageRound(path, round);

    expect(generations(dir, V1_BASE, ".salvage-backup")).toHaveLength(3);
    expect(generations(dir, V1_BASE, ".manual-backup")).toHaveLength(3);
    expect(generations(dir, V2_BASE, ".manual-backup")).toHaveLength(3);
  });

  it("別 base・別 extension・backup 以外のファイルは剪定しない", () => {
    const { path, v2Path, dir } = seedBothMirrors();
    writeFileSync(join(dir, `${V2_BASE}.2026-09-01T00-00-00-000Z.pre-restore`), "pre-restore", "utf8");
    writeFileSync(join(dir, `${V2_BASE}.2026-09-01T00-00-01-000Z.0.other-backup`), "other", "utf8");
    writeFileSync(join(dir, "unrelated.txt"), "unrelated", "utf8");

    [0, 1, 2, 3].forEach((round) => manualRound(path, v2Path, round));

    expect(existsSync(join(dir, `${V2_BASE}.2026-09-01T00-00-00-000Z.pre-restore`))).toBe(true);
    expect(existsSync(join(dir, `${V2_BASE}.2026-09-01T00-00-01-000Z.0.other-backup`))).toBe(true);
    expect(existsSync(join(dir, "unrelated.txt"))).toBe(true);
    expect(generations(dir, V2_BASE, ".manual-backup")).toHaveLength(3);
  });

  it("`${base}.other.…` のような別 base 派生名は剪定対象にならない", () => {
    const { path, v2Path, dir } = seedBothMirrors();
    const derived = `${V2_BASE}.other.2026-09-01T00-00-00-000Z.0.manual-backup`;
    const deeper = `${V2_BASE}.other.nested.2026-09-01T00-00-01-000Z.1.manual-backup`;
    writeFileSync(join(dir, derived), "derived-base", "utf8");
    writeFileSync(join(dir, deeper), "deeper-base", "utf8");

    [0, 1, 2, 3].forEach((round) => manualRound(path, v2Path, round));

    expect(existsSync(join(dir, derived))).toBe(true);
    expect(existsSync(join(dir, deeper))).toBe(true);
    expect(
      readdirSync(dir).filter((name) => /^display-active-state-v2\.json\.[^.]+\.\d+\.manual-backup$/.test(name)),
    ).toHaveLength(3);
  });

  it("timestamp が固定幅でない手書き名は剪定対象にならない", () => {
    const { path, v2Path, dir } = seedBothMirrors();
    const shortStamp = `${V2_BASE}.2026-9-1T0-0-0-0Z.0.manual-backup`;
    const paddedIndex = `${V2_BASE}.2026-09-01T00-00-00-000Z.00.manual-backup`;
    const noIndex = `${V2_BASE}.2026-09-01T00-00-00-000Z.manual-backup`;
    for (const name of [shortStamp, paddedIndex, noIndex]) writeFileSync(join(dir, name), name, "utf8");

    [0, 1, 2, 3].forEach((round) => manualRound(path, v2Path, round));

    for (const name of [shortStamp, paddedIndex, noIndex]) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
    expect(generations(dir, V2_BASE, ".manual-backup")).toHaveLength(6);
  });

  it("同一 timestamp の collision index は数値順に新しく、新規 .11 自身は消えない", () => {
    const { path, v2Path, dir } = seedBothMirrors();
    const stampMs = Date.parse("2026-09-01T00:00:00.000Z");
    const stamp = new Date(stampMs).toISOString().replace(/[:.]/g, "-");
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      writeFileSync(join(dir, `${V2_BASE}.${stamp}.${index}.manual-backup`), `collision-${index}`, "utf8");
    }
    vi.useFakeTimers();
    vi.setSystemTime(stampMs);

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    const v2Name = nameOf(files[0]!.path);
    expect(v2Name).toBe(`${V2_BASE}.${stamp}.11.manual-backup`);
    expect(existsSync(files[0]!.path)).toBe(true);
    expect(readFileSync(files[0]!.path)).toEqual(readFileSync(v2Path));
    expect(generations(dir, V2_BASE, ".manual-backup").sort()).toEqual([
      `${V2_BASE}.${stamp}.10.manual-backup`,
      `${V2_BASE}.${stamp}.11.manual-backup`,
      `${V2_BASE}.${stamp}.9.manual-backup`,
    ].sort());
  });

  it("時計が戻って新規 backup が既存より古くても 3 世代契約を守る", () => {
    const { path, v2Path, dir } = seedBothMirrors();
    // 時刻補正前に書かれた「未来 timestamp」の backup が 3 世代ある状態を作る。
    const futureStamps = [
      "2030-01-01T00-00-00-000Z",
      "2030-01-02T00-00-00-000Z",
      "2030-01-03T00-00-00-000Z",
    ];
    for (const [index, stamp] of futureStamps.entries()) {
      writeFileSync(join(dir, `${V2_BASE}.${stamp}.0.manual-backup`), `future-v2-${index}`, "utf8");
      writeFileSync(join(dir, `${V1_BASE}.${stamp}.0.manual-backup`), `future-v1-${index}`, "utf8");
    }
    // 時計が過去へ戻ったあとに新規 backup を作る（並び順では最古になる）。
    const nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const nowStamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    writeFileSync(v2Path, `{"clock":"back","mirror":"v2"}`, "utf8");
    writeFileSync(path, `{"clock":"back","mirror":"v1"}`, "utf8");

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    expect(files.map((file) => file.reused)).toEqual([false, false]);
    const keptV2 = nameOf(files[0]!.path);
    expect(keptV2).toBe(`${V2_BASE}.${nowStamp}.0.manual-backup`);
    // 新規（keep）と未来側の新しい 2 件が残り、未来側の最古が消える。
    expect(generations(dir, V2_BASE, ".manual-backup").sort()).toEqual([
      keptV2,
      `${V2_BASE}.${futureStamps[1]!}.0.manual-backup`,
      `${V2_BASE}.${futureStamps[2]!}.0.manual-backup`,
    ].sort());
    expect(existsSync(join(dir, `${V2_BASE}.${futureStamps[0]!}.0.manual-backup`))).toBe(false);
    expect(readFileSync(files[0]!.path, "utf8")).toBe(`{"clock":"back","mirror":"v2"}`);
    expect(generations(dir, V1_BASE, ".manual-backup")).toHaveLength(3);
  });

  it("既存 backup を再利用したときは剪定しない", () => {
    const { path, v2Path, dir } = seedBothMirrors();
    const v1Bytes = readFileSync(path);
    const v2Bytes = readFileSync(v2Path);
    for (const index of [0, 1, 2, 3, 4]) {
      const stamp = `2026-09-0${index + 1}T00-00-00-000Z`;
      writeFileSync(join(dir, `${V1_BASE}.${stamp}.0.manual-backup`), index === 0 ? v1Bytes : Buffer.from(`v1-${index}`));
      writeFileSync(join(dir, `${V2_BASE}.${stamp}.0.manual-backup`), index === 0 ? v2Bytes : Buffer.from(`v2-${index}`));
    }

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    expect(files.map((file) => file.reused)).toEqual([true, true]);
    expect(generations(dir, V1_BASE, ".manual-backup")).toHaveLength(5);
    expect(generations(dir, V2_BASE, ".manual-backup")).toHaveLength(5);
  });

  it("unlink 失敗は warn して続行し、backup 本体の成功を壊さない", () => {
    const { path, v2Path, dir } = seedBothMirrors();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const originalUnlinkSync = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (typeof target === "string" && target.endsWith(".manual-backup")) {
        const error = new Error("unlink blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return (originalUnlinkSync as (...inner: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.unlinkSync);

    const rounds = [0, 1, 2, 3].map((round) => manualRound(path, v2Path, round));

    expect(generations(dir, V2_BASE, ".manual-backup")).toHaveLength(4);
    expect(readFileSync(join(dir, rounds[3]!.v2), "utf8")).toBe(`{"round":3,"mirror":"v2"}`);
    expect(warn.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\[standby-persistence\] backup prune failed file=display-active-state-v2\.json\..+\.manual-backup: unlink blocked$/),
    ]));
  });

  it("readdir 失敗は warn して続行し、backup 本体の成功を壊さない", () => {
    const { path } = seedBothMirrors();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const originalReaddirSync = fs.readdirSync;
    let backupWritten = false;
    vi.spyOn(fs, "readdirSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (backupWritten) {
        const error = new Error("readdir blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return (originalReaddirSync as (...inner: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.readdirSync);
    const originalOpenSync = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
      const fd = (originalOpenSync as (...inner: unknown[]) => number)(file, ...args);
      if (typeof file === "string" && file.endsWith(".manual-backup")) backupWritten = true;
      return fd;
    }) as typeof fs.openSync);

    const files = expectBackedUp(new StandbyPersistence(path, 0).backupCurrentMirrors("manual"));

    expect(files.map((file) => file.reused)).toEqual([false, false]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\[standby-persistence\] backup prune listing failed dir=.+ extension=manual-backup: readdir blocked$/),
    ]));
  });
});
