import type {
  AshArea,
  AshForecastPeriod,
  ParsedVolcanoAshfallInfo,
  VolcanoAshfallGroupV1,
  VolcanoAshfallProjectionV1,
  VolcanoAshfallTopAreaV1,
} from "../../types";
import {
  normalizeVolcanoAshfallSerial,
  parseStrictReportDateTime,
} from "../../dmdata/telegram-meta";
import { volcanoAshfallSubjectKey } from "./revision-family-registry";

export const VOLCANO_ASHFALL_MAX_EVENT_ID_LENGTH = 128;
export const VOLCANO_MAX_SOURCE_ID_LENGTH = 256;
export const VOLCANO_ASHFALL_MAX_PERIODS = 24;
export const VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD = 256;
export const VOLCANO_ASHFALL_MAX_TOTAL_AREA_OCCURRENCES = 2048;
export const VOLCANO_ASHFALL_MAX_PERIOD_DURATION_MS = 48 * 60 * 60_000;
export const VOLCANO_ASHFALL_MAX_FORECAST_SPAN_MS = 48 * 60 * 60_000;
export const VOLCANO_ASHFALL_MAX_START_BEFORE_REPORT_MS = 6 * 60 * 60_000;
export const VOLCANO_ASHFALL_MAX_TOP_AREAS_PER_GROUP = 3;
export const VOLCANO_ASHFALL_MAX_GROUPS = 8;

export type VolcanoAshfallProjectionDiagnostic =
  | "invalidType" | "invalidIdentity" | "invalidPeriod" | "invalidArea"
  | "invalidGroup" | "tooManyPeriods" | "tooManyAreas" | "invalidNumeric"
  | "invalidRevision" | "invalidProjection";

export type VolcanoAshfallIdentityDiagnostic = "invalidIdentity" | "invalidRevision";

export type VolcanoAshfallProjectionResult =
  | { kind: "active"; projection: VolcanoAshfallProjectionV1 }
  | { kind: "expired"; forecastEndsAtMs: number }
  | { kind: "nonProjectable"; reason: VolcanoAshfallProjectionDiagnostic }
  | { kind: "cancellation" }
  | { kind: "transient"; reason: VolcanoAshfallIdentityDiagnostic };

interface NormalizedArea {
  identityKey: string;
  code: string | null;
  name: string;
  ashCode: string;
  ashName: string;
  groupOrder: number;
  hazardClass: VolcanoAshfallGroupV1["hazardClass"];
  endMs: number;
  thickness: number | null;
  plumeDirection: string | null;
  distanceKm: number | null;
}

interface NormalizedPeriod {
  startMs: number;
  endMs: number;
  areas: NormalizedArea[];
  fingerprint: string;
  originalIndex: number;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedText(
  value: unknown,
  maximum: number,
  options: { collapseWhitespace?: boolean; allowEmpty?: boolean } = {},
): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.normalize("NFC");
  // Do not let whitespace canonicalization hide transport control characters.
  // XML formatting spaces are accepted, but Cc input (including tab/newline)
  // is rejected before trim/collapse.
  if (/\p{Cc}/u.test(normalized)) return null;
  normalized = normalized.trim();
  if (options.collapseWhitespace === true) normalized = normalized.replace(/\s+/gu, " ");
  return ((!options.allowEmpty && normalized === "")
    || normalized.length > maximum)
    ? null
    : normalized;
}

function boundedIdentityText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const nfc = value.normalize("NFC");
  if (/\p{Cc}/u.test(nfc)) return null;
  const normalized = nfc.trim();
  return normalized === ""
    || normalized.length > maximum
    ? null
    : normalized;
}

export function normalizeVolcanoAshfallEventId(value: unknown): string | null {
  return boundedIdentityText(value, VOLCANO_ASHFALL_MAX_EVENT_ID_LENGTH);
}

function strictIsoEpoch(value: string): number | null {
  // Keep period parsing on the exact same calendar/zone parser used by live,
  // REST, and persistence revision metadata.  Supplying Date's maximum epoch
  // disables only the report-future comparison; lexical/calendar checks stay
  // strict (so e.g. 2026-02-30 and timezone-less values remain invalid).
  return parseStrictReportDateTime(value, 8_640_000_000_000_000).epochMs;
}

function groupDefinition(code: string, name: string):
  | { hazardClass: VolcanoAshfallGroupV1["hazardClass"]; order: number; canonicalName: string }
  | null {
  const known: Record<string, { hazardClass: "ash" | "ballistic"; order: number; canonicalName: string }> = {
    "75": { hazardClass: "ballistic", order: 0, canonicalName: "小さな噴石の落下" },
    "73": { hazardClass: "ash", order: 1, canonicalName: "多量の降灰" },
    "72": { hazardClass: "ash", order: 2, canonicalName: "やや多量の降灰" },
    "71": { hazardClass: "ash", order: 3, canonicalName: "少量の降灰" },
    "70": { hazardClass: "ash", order: 4, canonicalName: "降灰" },
  };
  const found = known[code];
  if (found != null) return found.canonicalName === name ? found : null;
  const unknownCode = normalizedText(code, 8);
  const unknownName = normalizedText(name, 64);
  return unknownCode == null || unknownName == null
    ? null
    : { hazardClass: "unknown", order: 5, canonicalName: unknownName };
}

function normalizeArea(area: AshArea, endMs: number): NormalizedArea | null {
  if (typeof area.code !== "string") return null;
  const normalizedRawCode = area.code.normalize("NFC");
  if (/\p{Cc}/u.test(normalizedRawCode)) return null;
  const rawCode = normalizedRawCode.trim();
  const code = rawCode === "" ? null : normalizedText(area.code, 32);
  const name = normalizedText(area.name, 128, { collapseWhitespace: true, allowEmpty: code != null });
  if ((rawCode !== "" && code == null) || (code == null && name == null) || name == null) return null;
  const ashCode = normalizedText(area.ashCode, 8);
  const ashName = normalizedText(area.ashName, 64);
  if (ashCode == null || ashName == null) return null;
  const identityKey = code == null ? `area:name:${name}` : `area:code:${code}`;
  const definition = groupDefinition(ashCode, ashName);
  if (definition == null) return null;
  if (![area.thickness, area.distanceKm].every((value) => value == null || Number.isFinite(value))) return null;
  return {
    identityKey,
    code,
    name: name ?? "",
    ashCode,
    ashName: definition.canonicalName,
    groupOrder: definition.order,
    hazardClass: definition.hazardClass,
    endMs,
    thickness: area.thickness,
    plumeDirection: area.plumeDirection,
    distanceKm: area.distanceKm,
  };
}

function normalizePeriods(info: ParsedVolcanoAshfallInfo, reportMs: number):
  | { periods: NormalizedPeriod[]; startsAtMs: number; endsAtMs: number }
  | { reason: VolcanoAshfallProjectionDiagnostic } {
  if (info.ashForecasts.length === 0 || info.ashForecasts.length > VOLCANO_ASHFALL_MAX_PERIODS) {
    return { reason: info.ashForecasts.length > VOLCANO_ASHFALL_MAX_PERIODS ? "tooManyPeriods" : "invalidPeriod" };
  }
  let occurrences = 0;
  const periods: NormalizedPeriod[] = [];
  const canonicalNamesByCode = new Map<string, string>();
  const unknownNamesByCode = new Map<string, string>();
  for (let originalIndex = 0; originalIndex < info.ashForecasts.length; originalIndex++) {
    const period = info.ashForecasts[originalIndex]!;
    const startMs = strictIsoEpoch(period.startTime);
    const endMs = strictIsoEpoch(period.endTime);
    if (startMs == null || endMs == null || startMs >= endMs
      || endMs - startMs > VOLCANO_ASHFALL_MAX_PERIOD_DURATION_MS
      || startMs < reportMs - VOLCANO_ASHFALL_MAX_START_BEFORE_REPORT_MS
      || endMs > reportMs + VOLCANO_ASHFALL_MAX_FORECAST_SPAN_MS) return { reason: "invalidPeriod" };
    if (period.areas.length === 0 || period.areas.length > VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD) return { reason: "invalidArea" };
    occurrences += period.areas.length;
    if (occurrences > VOLCANO_ASHFALL_MAX_TOTAL_AREA_OCCURRENCES) return { reason: "tooManyAreas" };
    const areas = period.areas.map((area) => normalizeArea(area, endMs));
    if (areas.some((area) => area == null)) return { reason: "invalidArea" };
    const actualAreas = areas as NormalizedArea[];
    for (const area of actualAreas) {
      if (area.code != null) {
        const previousName = canonicalNamesByCode.get(area.code);
        if (previousName != null && previousName !== area.name) return { reason: "invalidArea" };
        canonicalNamesByCode.set(area.code, area.name);
      }
      if (area.hazardClass === "unknown") {
        const previousName = unknownNamesByCode.get(area.ashCode);
        if (previousName != null && previousName !== area.ashName) return { reason: "invalidGroup" };
        unknownNamesByCode.set(area.ashCode, area.ashName);
      }
    }
    const canonicalAreas = [...actualAreas].sort((left, right) =>
      compareCodeUnit(left.identityKey, right.identityKey)
      || compareCodeUnit(left.ashCode, right.ashCode)
      || compareCodeUnit(left.ashName, right.ashName)
      || left.endMs - right.endMs);
    periods.push({
      startMs,
      endMs,
      areas: actualAreas,
      fingerprint: JSON.stringify([startMs, endMs, canonicalAreas.map((area) => [
        area.identityKey, area.code, area.name, area.ashCode, area.ashName,
        // These fields are not persisted, but they are part of the source
        // period payload.  Only a genuinely complete duplicate is collapsed.
        area.thickness, area.plumeDirection, area.distanceKm,
      ])]),
      originalIndex,
    });
  }
  const startsAtMs = Math.min(...periods.map((period) => period.startMs));
  const endsAtMs = Math.max(...periods.map((period) => period.endMs));
  if (endsAtMs - startsAtMs > VOLCANO_ASHFALL_MAX_FORECAST_SPAN_MS) return { reason: "invalidPeriod" };
  // Fully duplicate periods are noise; equal timing with different payload remains meaningful.
  const unique = new Map<string, NormalizedPeriod>();
  for (const period of periods) if (!unique.has(period.fingerprint)) unique.set(period.fingerprint, period);
  return {
    periods: [...unique.values()].sort((a, b) =>
      a.endMs - b.endMs || a.startMs - b.startMs || a.originalIndex - b.originalIndex),
    startsAtMs,
    endsAtMs,
  };
}

/** Creates the bounded, deterministic VFVO54/55 representation. It has no side effects. */
export function projectVolcanoAshfall(
  info: ParsedVolcanoAshfallInfo,
  options: {
    classificationNowMs: number;
    appliedSemanticKey: string;
    generation: number;
  },
): VolcanoAshfallProjectionResult {
  if (info.type !== "VFVO54" && info.type !== "VFVO55") return { kind: "nonProjectable", reason: "invalidType" };
  const subject = volcanoAshfallSubjectKey(info.volcanoCode);
  // The normalized parser value is the sole EventID authority.  Raw text is
  // retained only for diagnostics and must not be reinterpreted here.
  const eventId = normalizeVolcanoAshfallEventId(info.meta.eventId.value);
  const sourceEventId = boundedIdentityText(info.meta.messageId, VOLCANO_MAX_SOURCE_ID_LENGTH);
  const reportMs = info.meta.reportDateTime.epochMs;
  if (subject == null || eventId == null || sourceEventId == null || reportMs == null) {
    return { kind: "transient", reason: "invalidIdentity" };
  }
  const serial = normalizeVolcanoAshfallSerial(info.meta.serial.raw);
  if (serial.kind === "invalid") return { kind: "transient", reason: "invalidRevision" };
  if (
    !Number.isSafeInteger(reportMs)
    || Math.abs(reportMs) > 8_640_000_000_000_000
    || !Number.isSafeInteger(options.generation)
    || options.generation < 1
    || normalizedText(options.appliedSemanticKey, 128) == null
    || !Number.isSafeInteger(options.classificationNowMs)
    || Math.abs(options.classificationNowMs) > 8_640_000_000_000_000
  ) return { kind: "transient", reason: "invalidRevision" };
  if (info.infoType === "取消") return { kind: "cancellation" };
  const volcanoName = normalizedText(info.volcanoName, 128, { collapseWhitespace: true });
  if (volcanoName == null) return { kind: "transient", reason: "invalidIdentity" };
  const periods = normalizePeriods(info, reportMs);
  if ("reason" in periods) return { kind: "nonProjectable", reason: periods.reason };
  if (options.classificationNowMs >= periods.endsAtMs) return { kind: "expired", forecastEndsAtMs: periods.endsAtMs };

  const groups = new Map<string, {
    definition: NonNullable<ReturnType<typeof groupDefinition>>;
    ashCode: string;
    areas: Map<string, NormalizedArea>;
  }>();
  for (const period of periods.periods) for (const area of period.areas) {
    const definition = groupDefinition(area.ashCode, area.ashName);
    if (definition == null) return { kind: "nonProjectable", reason: "invalidGroup" };
    const key = `${definition.hazardClass}:${area.ashCode}`;
    const group = groups.get(key) ?? { definition, ashCode: area.ashCode, areas: new Map<string, NormalizedArea>() };
    groups.set(key, group);
    const current = group.areas.get(area.identityKey);
    if (current == null || area.endMs < current.endMs) group.areas.set(area.identityKey, area);
  }
  // For known ash classifications an area appears only at its worst level.
  // Compute winners first so Map iteration order cannot affect the result.
  const worstKnownAsh = new Map<string, number>();
  for (const group of groups.values()) {
    if (group.definition.hazardClass !== "ash") continue;
    for (const identity of group.areas.keys()) {
      const current = worstKnownAsh.get(identity);
      if (current == null || group.definition.order < current) {
        worstKnownAsh.set(identity, group.definition.order);
      }
    }
  }
  for (const group of groups.values()) {
    if (group.definition.hazardClass !== "ash") continue;
    for (const identity of [...group.areas.keys()]) {
      if (worstKnownAsh.get(identity) !== group.definition.order) group.areas.delete(identity);
    }
  }
  const ordered = [...groups.entries()]
    .filter(([, group]) => group.areas.size > 0)
    .sort(([, left], [, right]) => left.definition.order - right.definition.order
      || compareCodeUnit(left.ashCode, right.ashCode));
  const kept = ordered.slice(0, VOLCANO_ASHFALL_MAX_GROUPS);
  const projectionGroups: VolcanoAshfallGroupV1[] = kept.map(([, group]) => {
    const areas = [...group.areas.values()].sort((a, b) =>
      a.endMs - b.endMs || compareCodeUnit(a.identityKey, b.identityKey));
    const topAreas: VolcanoAshfallTopAreaV1[] = areas.slice(0, VOLCANO_ASHFALL_MAX_TOP_AREAS_PER_GROUP).map((area) => ({
      identityKey: area.identityKey, code: area.code, name: area.name, firstForecastEndAtMs: area.endMs,
    }));
    return {
      hazardClass: group.definition.hazardClass,
      ashCode: group.ashCode,
      ashName: group.definition.canonicalName,
      areaCount: areas.length,
      topAreas,
      omittedAreaCount: areas.length - topAreas.length,
    };
  });
  if (projectionGroups.length === 0) return { kind: "nonProjectable", reason: "invalidGroup" };
  return {
    kind: "active",
    projection: {
      stateSubjectKey: subject,
      volcanoCode: subject.slice("volcano:ashfall:".length),
      volcanoName,
      eventId,
      sourceType: info.type,
      sourceEventId,
      forecastStartsAtMs: periods.startsAtMs,
      forecastEndsAtMs: periods.endsAtMs,
      groups: projectionGroups,
      omittedGroupCount: ordered.length - projectionGroups.length,
      revision: {
        reportTimeMs: reportMs,
        serial: serial.kind === "missing" ? null : serial.canonicalRaw,
      },
      appliedSemanticKey: options.appliedSemanticKey,
      generation: options.generation,
    },
  };
}

/** Deep validation shared by persistence and transaction preflight. */
export function validateVolcanoAshfallProjection(
  value: VolcanoAshfallProjectionV1,
): VolcanoAshfallProjectionDiagnostic | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return "invalidProjection";
  const raw = value as unknown as Record<string, unknown>;
  if (
    typeof raw.stateSubjectKey !== "string"
    || typeof raw.volcanoCode !== "string"
    || typeof raw.volcanoName !== "string"
    || typeof raw.eventId !== "string"
    || typeof raw.sourceType !== "string"
    || typeof raw.sourceEventId !== "string"
    || typeof raw.forecastStartsAtMs !== "number"
    || typeof raw.forecastEndsAtMs !== "number"
    || typeof raw.appliedSemanticKey !== "string"
    || typeof raw.generation !== "number"
    || typeof raw.omittedGroupCount !== "number"
    || !Array.isArray(raw.groups)
    || raw.revision == null
    || typeof raw.revision !== "object"
    || Array.isArray(raw.revision)
  ) return "invalidProjection";
  const rawRevision = raw.revision as Record<string, unknown>;
  if (typeof rawRevision.reportTimeMs !== "number"
    || !Object.hasOwn(rawRevision, "serial")
    || !(rawRevision.serial === null || typeof rawRevision.serial === "string")) {
    return "invalidRevision";
  }
  const code = normalizedText(value.volcanoCode, 32);
  const name = normalizedText(value.volcanoName, 128, { collapseWhitespace: true });
  const eventId = boundedIdentityText(value.eventId, VOLCANO_ASHFALL_MAX_EVENT_ID_LENGTH);
  const sourceId = boundedIdentityText(value.sourceEventId, VOLCANO_MAX_SOURCE_ID_LENGTH);
  const semanticKey = normalizedText(value.appliedSemanticKey, 128);
  if (
    code == null || code !== value.volcanoCode
    || name == null || name !== value.volcanoName
    || eventId == null || eventId !== value.eventId
    || sourceId == null || sourceId !== value.sourceEventId
    || semanticKey == null || semanticKey !== value.appliedSemanticKey
    || value.stateSubjectKey !== `volcano:ashfall:${code}`
    || (value.sourceType !== "VFVO54" && value.sourceType !== "VFVO55")
  ) return "invalidIdentity";
  const serial = normalizeVolcanoAshfallSerial(value.revision.serial);
  if (
    !Number.isSafeInteger(value.revision.reportTimeMs)
    || !Number.isSafeInteger(value.forecastStartsAtMs)
    || !Number.isSafeInteger(value.forecastEndsAtMs)
    || Math.abs(value.revision.reportTimeMs) > 8_640_000_000_000_000
    || Math.abs(value.forecastStartsAtMs) > 8_640_000_000_000_000
    || Math.abs(value.forecastEndsAtMs) > 8_640_000_000_000_000
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || serial.kind === "invalid"
    || serial.kind === "missing" && value.revision.serial !== null
    || serial.kind === "numeric" && serial.canonicalRaw !== value.revision.serial
    || value.forecastStartsAtMs >= value.forecastEndsAtMs
    || value.forecastEndsAtMs - value.forecastStartsAtMs > VOLCANO_ASHFALL_MAX_FORECAST_SPAN_MS
    || value.forecastStartsAtMs < value.revision.reportTimeMs - VOLCANO_ASHFALL_MAX_START_BEFORE_REPORT_MS
    || value.forecastEndsAtMs > value.revision.reportTimeMs + VOLCANO_ASHFALL_MAX_FORECAST_SPAN_MS
  ) return "invalidRevision";
  if (
    !Number.isSafeInteger(value.omittedGroupCount)
    || value.omittedGroupCount < 0
    || value.groups.length < 1
    || value.groups.length > VOLCANO_ASHFALL_MAX_GROUPS
  ) return "invalidGroup";
  const keys = new Set<string>();
  let lowerBound = value.omittedGroupCount;
  let previousOrder = -1;
  let previousUnknownCode = "";
  const knownAshIdentities = new Set<string>();
  const canonicalAreaNamesByCode = new Map<string, string>();
  for (const group of value.groups) {
    if (group == null || typeof group !== "object" || Array.isArray(group)) return "invalidGroup";
    const rawGroup = group as unknown as Record<string, unknown>;
    if (
      typeof rawGroup.hazardClass !== "string"
      || typeof rawGroup.ashCode !== "string"
      || typeof rawGroup.ashName !== "string"
      || typeof rawGroup.areaCount !== "number"
      || typeof rawGroup.omittedAreaCount !== "number"
      || !Array.isArray(rawGroup.topAreas)
    ) return "invalidGroup";
    const definition = groupDefinition(group.ashCode, group.ashName);
    if (definition == null
      || definition.hazardClass !== group.hazardClass
      || normalizedText(group.ashCode, 8) !== group.ashCode
      || normalizedText(group.ashName, 64) !== group.ashName
      || definition.canonicalName !== group.ashName) return "invalidGroup";
    const key = `${group.hazardClass}:${group.ashCode}`;
    if (keys.has(key)) return "invalidGroup";
    keys.add(key);
    if (definition.order < previousOrder) return "invalidGroup";
    if (definition.order === 5 && previousOrder === 5
      && compareCodeUnit(previousUnknownCode, group.ashCode) >= 0) return "invalidGroup";
    previousOrder = definition.order;
    if (definition.order === 5) previousUnknownCode = group.ashCode;
    if (
      !Number.isSafeInteger(group.areaCount) || group.areaCount < 1
      || !Number.isSafeInteger(group.omittedAreaCount) || group.omittedAreaCount < 0
      || group.topAreas.length !== Math.min(VOLCANO_ASHFALL_MAX_TOP_AREAS_PER_GROUP, group.areaCount)
      || group.areaCount !== group.topAreas.length + group.omittedAreaCount
    ) return "invalidArea";
    lowerBound += group.areaCount;
    const areaKeys = new Set<string>();
    let previousArea: VolcanoAshfallTopAreaV1 | null = null;
    for (const area of group.topAreas) {
      if (area == null || typeof area !== "object" || Array.isArray(area)) return "invalidArea";
      const rawArea = area as unknown as Record<string, unknown>;
      if (
        typeof rawArea.identityKey !== "string"
        || !(rawArea.code == null || typeof rawArea.code === "string")
        || typeof rawArea.name !== "string"
        || typeof rawArea.firstForecastEndAtMs !== "number"
      ) return "invalidArea";
      const areaCode = area.code == null ? null : normalizedText(area.code, 32);
      const areaName = normalizedText(area.name, 128, {
        collapseWhitespace: true,
        allowEmpty: areaCode != null,
      });
      const identity = areaCode == null
        ? areaName == null ? null : `area:name:${areaName}`
        : `area:code:${areaCode}`;
      if (
        identity == null || identity !== area.identityKey
        || areaCode !== area.code
        || areaName !== area.name
        || area.identityKey.length > 192
        || areaKeys.has(area.identityKey)
        || !Number.isSafeInteger(area.firstForecastEndAtMs)
        || area.firstForecastEndAtMs <= value.forecastStartsAtMs
        || area.firstForecastEndAtMs > value.forecastEndsAtMs
      ) return "invalidArea";
      if (previousArea != null && (
        previousArea.firstForecastEndAtMs > area.firstForecastEndAtMs
        || previousArea.firstForecastEndAtMs === area.firstForecastEndAtMs
          && compareCodeUnit(previousArea.identityKey, area.identityKey) >= 0
      )) return "invalidArea";
      if (areaCode != null) {
        const previousName = canonicalAreaNamesByCode.get(areaCode);
        if (previousName != null && previousName !== areaName) return "invalidArea";
        canonicalAreaNamesByCode.set(areaCode, areaName ?? "");
      }
      if (group.hazardClass === "ash") {
        if (knownAshIdentities.has(area.identityKey)) return "invalidArea";
        knownAshIdentities.add(area.identityKey);
      }
      areaKeys.add(area.identityKey);
      previousArea = area;
    }
  }
  return lowerBound <= VOLCANO_ASHFALL_MAX_TOTAL_AREA_OCCURRENCES
    ? null
    : "tooManyAreas";
}
