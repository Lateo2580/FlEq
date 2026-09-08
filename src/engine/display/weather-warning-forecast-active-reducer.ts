import type { ParsedWeatherWarningTimeseriesInfo } from "../../types";
import type { StandbyRevision } from "./standby-registry";
import type {
  DisplayWeatherWarningForecastGroupV1,
  DisplayWeatherWarningForecastPeriodV1,
  DisplayWeatherWarningForecastTargetV1,
} from "./protocol";
import {
  projectForecastOccurrences,
  vpwp50StableKey,
  type ForecastOccurrenceEntry,
} from "../presentation/weather-severity-pyramid";
import {
  VPWP50_MAX_AREA_CODE_LENGTH,
  VPWP50_MAX_AREA_NAME_LENGTH,
  VPWP50_MAX_FORECAST_LABEL_LENGTH,
  VPWP50_MAX_IDENTITY_KEY_LENGTH,
  VPWP50_MAX_LOCAL_CODE_LENGTH,
  VPWP50_MAX_LOCAL_NAME_LENGTH,
  VPWP50_MAX_PHENOMENON_NAME_LENGTH,
  VPWP50_MAX_PUBLISHING_OFFICE_LENGTH,
  VPWP50_MAX_SIGNIFICANCY_CODE_LENGTH,
  VPWP50_MAX_SOURCE_EVENT_ID_LENGTH,
  VPWP50_MAX_SUBJECT_KEY_LENGTH,
  VPWP50_MAX_TIME_NAME_LENGTH,
  VPWP50_MAX_TIME_REF_LENGTH,
  WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT,
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT,
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET,
  WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP,
  compareVpwp50NumericAware,
  escapePath,
  periodCanonicalOrder,
  sortWeatherWarningForecastGroups,
  type Vpwp50ProjectionLimitReasonCode,
} from "./weather-warning-forecast-wire";

export interface WeatherWarningForecastState {
  subjectKey: string;
  sourceEventId: string;
  publishingOffice: string;
  targetAreaName: string | null;
  targetAreaCode: string | null;
  groups: DisplayWeatherWarningForecastGroupV1[];
  revision: StandbyRevision;
  appliedSemanticKey: string;
  expiresAtMs: number;
  restored: boolean;
}

/** Hierarchies the reducer itself can detect before it gives up on a candidate. */
export type Vpwp50ForecastRejectHierarchy = Extract<
  Vpwp50ProjectionLimitReasonCode,
  "groupsPerSubject" | "targetsPerGroup" | "periodsPerTarget" | "periodsPerSubject"
>;

/**
 * Why a candidate projection was refused.  Each code names one independent
 * check so an operator can tell "the telegram is odd" from "our own key
 * generation is odd" without re-reading the source XML.
 */
export type Vpwp50ForecastRejectReason =
  | { code: "invalidRevisionSerial" }
  | { code: "invalidNowMs" }
  | { code: "invalidReportTime" }
  | { code: "invalidSubjectKey" }
  | { code: "invalidSubjectPrefix" }
  | { code: "invalidSourceEventId" }
  | { code: "invalidPublishingOffice" }
  | { code: "invalidTargetArea" }
  | { code: "invalidSemanticKey" }
  | { code: "invalidOccurrence"; projectedOccurrenceIndex: number }
  | { code: "identityCollision"; scope: "group" | "target" | "occurrence" }
  | {
      code: "capacityExceeded";
      hierarchy: Vpwp50ForecastRejectHierarchy;
      actual: number;
      declaredLimit: number;
      samplePath: string;
    }
  // The reducer never returns this one.  It belongs to the same union so the
  // store can build it from a caught exception without casting.
  | { code: "reducerThrew"; detail: string };

export type Vpwp50ForecastProjectionResult =
  | { kind: "active"; state: WeatherWarningForecastState }
  | {
      kind: "empty";
      reason: "noActivePeriods";
      occurrences: number;
      resolvedSlots: number;
      expiredSlots: number;
    }
  | { kind: "rejected"; reason: Vpwp50ForecastRejectReason };

function rejected(reason: Vpwp50ForecastRejectReason): Vpwp50ForecastProjectionResult {
  return { kind: "rejected", reason };
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function vpwp50ForecastStandbySeverity(value: ForecastOccurrenceEntry["displaySeverity"]): "critical" | "warning" | "normal" {
  if (value === "officialL5" || value === "officialL4" || value === "nonLevelSpecial") return "critical";
  if (value === "officialL3" || value === "nonLevelWarning" || value === "unknown") return "warning";
  return "normal";
}

export function vpwp50ForecastPeriodLabel(startsAt: string, endsAt: string): string {
  const parts = (value: string): { year: number; month: number; day: number; hour: string; minute: string } => {
    const date = new Date(Date.parse(value) + 9 * 60 * 60_000);
    return {
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hour: String(date.getUTCHours()).padStart(2, "0"),
      minute: String(date.getUTCMinutes()).padStart(2, "0"),
    };
  };
  const start = parts(startsAt);
  const end = parts(endsAt);
  const short = (value: ReturnType<typeof parts>) => `${value.month}月${value.day}日 ${value.hour}:${value.minute}`;
  if (start.year === end.year && start.month === end.month && start.day === end.day) return `${short(start)}–${end.hour}:${end.minute}`;
  if (start.year === end.year) return `${short(start)}–${short(end)}`;
  return `${start.year}年${short(start)}–${end.year}年${short(end)}`;
}

interface MergedPeriod {
  startsAt: string; endsAt: string; tsNum: 1 | 2 | 3; series: "3h" | "24h" | "day";
}

interface RuntimeForecastOccurrence extends ForecastOccurrenceEntry {
  occurrenceKey: string;
}

function mergePeriods(entries: RuntimeForecastOccurrence[]): MergedPeriod[] {
  const unique = new Map<string, RuntimeForecastOccurrence>();
  for (const entry of entries) {
    const token = `${entry.occurrenceKey}\u0000${entry.slot!.startsAt}\u0000${entry.slot!.endsAt}`;
    if (!unique.has(token)) unique.set(token, entry);
  }
  const sorted = [...unique.values()].sort((a, b) => Date.parse(a.slot!.startsAt) - Date.parse(b.slot!.startsAt)
    || Date.parse(a.slot!.endsAt) - Date.parse(b.slot!.endsAt)
    || compareVpwp50NumericAware(a.timeRef, b.timeRef)
    || compareText(a.occurrenceKey, b.occurrenceKey));
  const result: MergedPeriod[] = [];
  for (const entry of sorted) {
    const slot = entry.slot!;
    const previous = result.at(-1);
    if (previous != null && Date.parse(slot.startsAt) <= Date.parse(previous.endsAt)) {
      if (Date.parse(slot.endsAt) > Date.parse(previous.endsAt)) previous.endsAt = slot.endsAt;
      continue;
    }
    result.push({ startsAt: slot.startsAt, endsAt: slot.endsAt, tsNum: slot.tsNum, series: slot.series });
  }
  return result;
}

export function normalizeVpwp50RevisionSerial(serial: string | null): string | null | undefined {
  if (serial == null || serial === "") return null;
  if (!/^\d+$/.test(serial)) return undefined;
  const numeric = Number(serial);
  return Number.isSafeInteger(numeric) ? String(numeric) : undefined;
}

function validBounded(value: string, limit: number, nonblank = true): boolean {
  return value.length <= limit && (!nonblank || value.trim() !== "");
}

function canonicalName(value: string, limit: number, nonblank = true): boolean {
  const canonical = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  return value === canonical && value.length <= limit && (!nonblank || value !== "");
}

function canonicalToken(value: string, limit: number): boolean {
  return value !== "" && value === value.trim() && value.length <= limit;
}

function canonicalIso(value: string): boolean {
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch)) return false;
  try {
    return new Date(epoch).toISOString() === value;
  } catch {
    return false;
  }
}

function validOccurrence(entry: ForecastOccurrenceEntry): boolean {
  if (entry.slot == null) return true;
  const areaKey = entry.area.code == null ? `name:${entry.area.name}` : `code:${entry.area.code}`;
  const localKey = entry.local == null
    ? null
    : entry.local.code == null ? `name:${entry.local.name}` : `code:${entry.local.code}`;
  return canonicalName(entry.phenomenonName, VPWP50_MAX_PHENOMENON_NAME_LENGTH)
    && canonicalToken(entry.significancy.code, VPWP50_MAX_SIGNIFICANCY_CODE_LENGTH)
    && canonicalName(entry.forecastLabel, VPWP50_MAX_FORECAST_LABEL_LENGTH)
    && canonicalToken(entry.timeRef, VPWP50_MAX_TIME_REF_LENGTH)
    && canonicalName(entry.slot.name, VPWP50_MAX_TIME_NAME_LENGTH, false)
    && entry.slot.timeRef === entry.timeRef
    && entry.slot.tsNum === entry.tsNum
    && entry.slot.series === (entry.tsNum === 1 ? "3h" : entry.tsNum === 2 ? "24h" : "day")
    && canonicalIso(entry.slot.startsAt)
    && canonicalIso(entry.slot.endsAt)
    && Date.parse(entry.slot.endsAt) > Date.parse(entry.slot.startsAt)
    && canonicalName(entry.area.name, VPWP50_MAX_AREA_NAME_LENGTH)
    && (entry.area.code == null || canonicalToken(entry.area.code, VPWP50_MAX_AREA_CODE_LENGTH))
    && entry.area.key === areaKey && validBounded(entry.area.key, VPWP50_MAX_IDENTITY_KEY_LENGTH)
    && (entry.local == null || canonicalName(entry.local.name, VPWP50_MAX_LOCAL_NAME_LENGTH)
      && (entry.local.code == null || canonicalToken(entry.local.code, VPWP50_MAX_LOCAL_CODE_LENGTH))
      && entry.local.key === localKey
      && validBounded(entry.local.key, VPWP50_MAX_IDENTITY_KEY_LENGTH));
}

/** Builds one complete replacement projection; callers must fail closed rather than truncate it. */
export function reduceWeatherWarningForecast(
  parsed: ParsedWeatherWarningTimeseriesInfo,
  subjectKey: string,
  sourceEventId: string,
  revision: StandbyRevision,
  appliedSemanticKey: string,
  nowMs: number,
): Vpwp50ForecastProjectionResult {
  const normalizedSerial = normalizeVpwp50RevisionSerial(revision.serial);
  const normalizedSubject = subjectKey.trim();
  const normalizedSource = sourceEventId.trim();
  const publishingOffice = parsed.publishingOffice.normalize("NFC").trim().replace(/\s+/gu, " ");
  const targetAreaName = parsed.targetArea?.name == null
    ? null
    : parsed.targetArea.name.normalize("NFC").trim().replace(/\s+/gu, " ");
  const targetAreaCode = parsed.targetArea?.code.trim() || null;
  // The eleven header disjuncts stay in their original order and keep their
  // original predicates; only the reporting granularity changes.
  if (normalizedSerial === undefined) return rejected({ code: "invalidRevisionSerial" });
  if (!Number.isSafeInteger(nowMs)) return rejected({ code: "invalidNowMs" });
  if (!Number.isSafeInteger(revision.reportTimeMs)) return rejected({ code: "invalidReportTime" });
  // Not absorbed by the safe-integer check above: 9e15 is a safe integer but
  // exceeds the ECMAScript time value range, so getTime() yields NaN.
  if (!Number.isFinite(new Date(revision.reportTimeMs).getTime())) return rejected({ code: "invalidReportTime" });
  if (!canonicalToken(normalizedSubject, VPWP50_MAX_SUBJECT_KEY_LENGTH)) return rejected({ code: "invalidSubjectKey" });
  if (!normalizedSubject.startsWith("weatherTimeseries:")) return rejected({ code: "invalidSubjectPrefix" });
  if (!canonicalToken(normalizedSource, VPWP50_MAX_SOURCE_EVENT_ID_LENGTH)) return rejected({ code: "invalidSourceEventId" });
  if (!canonicalName(publishingOffice, VPWP50_MAX_PUBLISHING_OFFICE_LENGTH)) return rejected({ code: "invalidPublishingOffice" });
  if (targetAreaName != null && !canonicalName(targetAreaName, VPWP50_MAX_AREA_NAME_LENGTH)) return rejected({ code: "invalidTargetArea" });
  if (targetAreaCode != null && !canonicalToken(targetAreaCode, VPWP50_MAX_AREA_CODE_LENGTH)) return rejected({ code: "invalidTargetArea" });
  if (!/^(?:発表|訂正):[0-9a-f]{64}$/.test(appliedSemanticKey)) return rejected({ code: "invalidSemanticKey" });
  // Sample paths are built only on a reject, so the accepted path pays for no
  // escaping and no string joins.
  const subjectPath = (): string => `subjects/${escapePath(normalizedSubject)}`;
  const groupPathOf = (groupKey: string): string => `${subjectPath()}/groups/${escapePath(groupKey)}`;
  const allProjected = projectForecastOccurrences(parsed);
  const projected = allProjected.filter((entry) => entry.slot != null && Date.parse(entry.slot.endsAt) > nowMs);
  // The index is into `projected` (slot-resolved and unexpired), not into the
  // source telegram's occurrence order.
  const invalidIndex = projected.findIndex((entry) => !validOccurrence(entry));
  if (invalidIndex !== -1) {
    return rejected({ code: "invalidOccurrence", projectedOccurrenceIndex: invalidIndex });
  }
  const groups = new Map<string, RuntimeForecastOccurrence[]>();
  const groupTuples = new Map<string, string>();
  const targetTuples = new Map<string, string>();
  const occurrenceTuples = new Map<string, string>();
  for (const entry of projected) {
    const groupTuple = [entry.phenomenonName, entry.significancy.code, entry.forecastLabel, entry.displaySeverity] as const;
    const key = vpwp50StableKey("group", groupTuple);
    const scope = entry.local == null ? "area" : "local";
    const targetKey = entry.local == null
      ? vpwp50StableKey("target", [normalizedSubject, scope, entry.area.key])
      : vpwp50StableKey("target", [normalizedSubject, scope, entry.area.key, entry.local.key]);
    const targetTuple = entry.local == null
      ? [normalizedSubject, scope, entry.area.key]
      : [normalizedSubject, scope, entry.area.key, entry.local.key];
    const occurrenceTuple = [
      normalizedSubject, targetKey, entry.phenomenonName, entry.significancy.code,
      entry.forecastLabel, entry.displaySeverity, entry.tsNum, entry.slot!.series,
      entry.timeRef, entry.slot!.startsAt, entry.slot!.endsAt,
    ] as const;
    const occurrenceKey = vpwp50StableKey("occurrence", occurrenceTuple);
    const encodedGroup = JSON.stringify(groupTuple);
    const encodedTarget = JSON.stringify(targetTuple);
    const encodedOccurrence = JSON.stringify(occurrenceTuple);
    if (groupTuples.has(key) && groupTuples.get(key) !== encodedGroup) {
      return rejected({ code: "identityCollision", scope: "group" });
    }
    if (targetTuples.has(targetKey) && targetTuples.get(targetKey) !== encodedTarget) {
      return rejected({ code: "identityCollision", scope: "target" });
    }
    if (occurrenceTuples.has(occurrenceKey) && occurrenceTuples.get(occurrenceKey) !== encodedOccurrence) {
      return rejected({ code: "identityCollision", scope: "occurrence" });
    }
    groupTuples.set(key, encodedGroup);
    targetTuples.set(targetKey, encodedTarget);
    occurrenceTuples.set(occurrenceKey, encodedOccurrence);
    const values = groups.get(key) ?? [];
    values.push({ ...entry, occurrenceKey }); groups.set(key, values);
  }
  // `actual` here counts the aggregation map, i.e. before empty targets and
  // groups would be dropped, whereas the card-side countUnits() counts what
  // survived.  Today the two always agree: mergePeriods() returns at least one
  // period for any non-empty input, so every target reaches projectedTargets
  // and every group reaches output.  Should a later period filter make empty
  // targets possible, this reducer-side `actual` would read higher than the
  // card-side one for the same candidate.
  if (groups.size > WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT) {
    return rejected({
      code: "capacityExceeded",
      hierarchy: "groupsPerSubject",
      actual: groups.size,
      declaredLimit: WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT,
      samplePath: `${subjectPath()}/groups`,
    });
  }
  const output: DisplayWeatherWarningForecastGroupV1[] = [];
  for (const [key, entries] of groups) {
    const first = entries[0];
    const targets = new Map<string, RuntimeForecastOccurrence[]>();
    for (const entry of entries) {
      const scope = entry.local == null ? "area" : "local";
      const targetKey = entry.local == null
        ? vpwp50StableKey("target", [normalizedSubject, scope, entry.area.key])
        : vpwp50StableKey("target", [normalizedSubject, scope, entry.area.key, entry.local.key]);
      const values = targets.get(targetKey) ?? [];
      values.push(entry); targets.set(targetKey, values);
    }
    if (targets.size > WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP) {
      return rejected({
        code: "capacityExceeded",
        hierarchy: "targetsPerGroup",
        actual: targets.size,
        declaredLimit: WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP,
        samplePath: `${groupPathOf(key)}/targets`,
      });
    }
    const projectedTargets: DisplayWeatherWarningForecastTargetV1[] = [];
    for (const [targetKey, targetEntries] of targets) {
      const targetFirst = targetEntries[0];
      const partitions = new Map<string, RuntimeForecastOccurrence[]>();
      for (const entry of targetEntries) {
        const part = [entry.tsNum, entry.slot!.series, entry.significancy.code, entry.forecastLabel, entry.displaySeverity].join("\u0000");
        const values = partitions.get(part) ?? []; values.push(entry); partitions.set(part, values);
      }
      const periods: DisplayWeatherWarningForecastPeriodV1[] = [];
      for (const values of partitions.values()) for (const merged of mergePeriods(values)) {
        periods.push({
          key: vpwp50StableKey("period", [key, targetKey, merged.tsNum, merged.series, merged.startsAt, merged.endsAt]),
          tsNum: merged.tsNum, series: merged.series, startsAt: merged.startsAt, endsAt: merged.endsAt,
          label: vpwp50ForecastPeriodLabel(merged.startsAt, merged.endsAt), pagerAnchorKey: "", pagerAnchorOrdinal: 0, pagerSlot: 0,
        });
      }
      periods.sort(periodCanonicalOrder);
      if (periods.length > WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET) {
        return rejected({
          code: "capacityExceeded",
          hierarchy: "periodsPerTarget",
          actual: periods.length,
          declaredLimit: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET,
          samplePath: `${groupPathOf(key)}/targets/${escapePath(targetKey)}/periods`,
        });
      }
      for (const [ordinal, period] of periods.entries()) {
        period.pagerAnchorOrdinal = Math.floor(ordinal / 4);
        period.pagerSlot = (ordinal % 4) as 0 | 1 | 2 | 3;
        period.pagerAnchorKey = vpwp50StableKey("anchor", [normalizedSubject, revision.reportTimeMs, normalizedSerial, key, targetKey, period.pagerAnchorOrdinal]);
      }
      if (periods.length > 0) projectedTargets.push({
        key: targetKey, scope: targetFirst.local == null ? "area" : "local",
        name: targetFirst.local?.name ?? targetFirst.area.name,
        parentAreaName: targetFirst.area.name, areaCode: targetFirst.area.code,
        localCode: targetFirst.local?.code ?? null, periods,
      });
    }
    projectedTargets.sort((a, b) => compareText(a.scope, b.scope)
      || compareText(a.areaCode ?? "", b.areaCode ?? "")
      || compareText(a.localCode ?? "", b.localCode ?? "")
      || compareText(a.key, b.key)
      || compareText(a.name, b.name));
    if (projectedTargets.length > 0) output.push({ key, phenomenonName: first.phenomenonName, significancyCode: first.significancy.code, forecastLabel: first.forecastLabel, displaySeverity: first.displaySeverity, severity: vpwp50ForecastStandbySeverity(first.displaySeverity), targets: projectedTargets });
  }
  const canonicalOutput = sortWeatherWarningForecastGroups(output);
  const all = canonicalOutput.flatMap((group) => group.targets.flatMap((target) => target.periods));
  if (all.length === 0) {
    // The extra O(n) scan runs only once the candidate is already known to be
    // empty, so neither the accepted path nor any reject path pays for it.
    const resolvedSlots = allProjected.filter((entry) => entry.slot != null).length;
    return {
      kind: "empty",
      reason: "noActivePeriods",
      occurrences: allProjected.length,
      resolvedSlots,
      expiredSlots: resolvedSlots - projected.length,
    };
  }
  if (all.length > WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT) {
    return rejected({
      code: "capacityExceeded",
      hierarchy: "periodsPerSubject",
      actual: all.length,
      declaredLimit: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT,
      samplePath: `${subjectPath()}/periods`,
    });
  }
  return {
    kind: "active",
    state: { subjectKey: normalizedSubject, sourceEventId: normalizedSource, publishingOffice, targetAreaName, targetAreaCode, groups: canonicalOutput, revision: { ...revision, serial: normalizedSerial }, appliedSemanticKey, expiresAtMs: Math.max(...all.map((period) => Date.parse(period.endsAt))), restored: false },
  };
}
