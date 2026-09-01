import type {
  ActiveStandbyCardV1,
  DisplayWeatherWarningForecastGroupV1,
  DisplayWeatherWarningForecastPeriodV1,
  StandbySeverity,
} from "./protocol";
import type { StandbyRevision } from "./standby-registry";
import type { WeatherWarningForecastState } from "./weather-warning-forecast-active-reducer";

export const WEATHER_WARNING_FORECAST_MAX_SUBJECTS = 512;
export const WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT = 128;
export const WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP = 128;
export const WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET = 128;
export const WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT = 128;
export const WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD = 128;
export const WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM = 4;
export const WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES = 64 * 1024;

export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_PROJECTION_ITEMS = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_METADATA_ITEMS = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_SEEN_ITEMS = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_V2_GATE_ITEMS = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_BUNDLES = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_GROUP_ITEMS_PER_SUBJECT = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_TARGET_ITEMS_PER_GROUP = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_TARGET_ITEMS_PER_SUBJECT = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_PERIOD_ITEMS_PER_TARGET = 1_024;
export const WEATHER_WARNING_FORECAST_READER_MAX_RAW_PERIOD_ITEMS_PER_SUBJECT = 1_024;

export const VPWP50_MAX_SOURCE_EVENT_ID_LENGTH = 256;
export const VPWP50_MAX_SUBJECT_KEY_LENGTH = 1_024;
export const VPWP50_MAX_PUBLISHING_OFFICE_LENGTH = 256;
export const VPWP50_MAX_AREA_NAME_LENGTH = 256;
export const VPWP50_MAX_AREA_CODE_LENGTH = 64;
export const VPWP50_MAX_LOCAL_NAME_LENGTH = 256;
export const VPWP50_MAX_LOCAL_CODE_LENGTH = 64;
export const VPWP50_MAX_PHENOMENON_NAME_LENGTH = 128;
export const VPWP50_MAX_SIGNIFICANCY_CODE_LENGTH = 32;
export const VPWP50_MAX_FORECAST_LABEL_LENGTH = 256;
export const VPWP50_MAX_TIME_REF_LENGTH = 64;
export const VPWP50_MAX_TIME_NAME_LENGTH = 128;
export const VPWP50_MAX_IDENTITY_KEY_LENGTH = 1_024;
export const VPWP50_DERIVED_KEY_LENGTH = 43;
export const VPWP50_REPORT_FUTURE_SKEW_MS = 15 * 60_000;
export const VPWP50_ACCEPTED_AT_FUTURE_SKEW_MS = 15 * 60_000;

export type Vpwp50ProjectionLimitReasonCode =
  | "groupsPerSubject" | "targetsPerGroup" | "periodsPerTarget"
  | "periodsPerAnchor" | "periodsPerSubject" | "periodsPerCard" | "cardJsonBytes";

export interface Vpwp50ProjectionLimitReason {
  code: Vpwp50ProjectionLimitReasonCode;
  actual: number;
  declaredLimit: number;
  effectiveLimit: number | null;
  violatingUnitCount: number;
  limitingHierarchies: readonly Vpwp50ProjectionLimitReasonCode[];
  samplePaths: readonly string[];
}

export interface Vpwp50ProjectionLimitDiagnostic {
  subjectKey: string;
  candidateRevision: StandbyRevision;
  existingProjectionDeleted: boolean;
  reasons: readonly Vpwp50ProjectionLimitReason[];
}

const REASON_ORDER: readonly Vpwp50ProjectionLimitReasonCode[] = [
  "groupsPerSubject", "targetsPerGroup", "periodsPerTarget", "periodsPerAnchor",
  "periodsPerSubject", "periodsPerCard", "cardJsonBytes",
];

const severityRank: Record<StandbySeverity, number> = { info: 0, normal: 1, warning: 2, critical: 3 };
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const escapePath = (value: string): string => value.replace(/~/g, "~0").replace(/\//g, "~1");

export function weatherWarningForecastPeriodCount(
  groups: readonly DisplayWeatherWarningForecastGroupV1[],
): number {
  return groups.reduce((sum, group) => sum + group.targets.reduce(
    (targetSum, target) => targetSum + target.periods.length, 0,
  ), 0);
}

export function weatherWarningForecastCardJsonBytes(
  item: Extract<ActiveStandbyCardV1, { kind: "weatherWarningForecast" }>,
): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

export function sortWeatherWarningForecastGroups(
  groups: readonly DisplayWeatherWarningForecastGroupV1[],
): DisplayWeatherWarningForecastGroupV1[] {
  return [...groups].sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity]
    || compareText(left.phenomenonName, right.phenomenonName)
    || compareVpwp50NumericAware(left.significancyCode, right.significancyCode)
    || compareText(left.forecastLabel, right.forecastLabel)
    || compareText(left.key, right.key));
}

export function compareVpwp50NumericAware(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const normalizedLeft = left.replace(/^0+(?=\d)/, "");
    const normalizedRight = right.replace(/^0+(?=\d)/, "");
    if (normalizedLeft.length !== normalizedRight.length) {
      return normalizedLeft.length < normalizedRight.length ? -1 : 1;
    }
    const numericOrder = compareText(normalizedLeft, normalizedRight);
    if (numericOrder !== 0) return numericOrder;
  }
  return compareText(left, right);
}

/** All subject projections are combined without reinterpreting labels. */
export function buildWeatherWarningForecastCard(
  statesInput: readonly WeatherWarningForecastState[],
): Extract<ActiveStandbyCardV1, { kind: "weatherWarningForecast" }> | null {
  const states = [...statesInput].sort((a, b) => compareText(a.subjectKey, b.subjectKey));
  if (states.length === 0) return null;
  const groupsByKey = new Map<string, DisplayWeatherWarningForecastGroupV1>();
  for (const state of states) {
    for (const group of state.groups) {
      const previous = groupsByKey.get(group.key);
      if (previous == null) {
        groupsByKey.set(group.key, structuredClone(group));
      } else if (
        previous.phenomenonName === group.phenomenonName
        && previous.significancyCode === group.significancyCode
        && previous.forecastLabel === group.forecastLabel
        && previous.displaySeverity === group.displaySeverity
        && previous.severity === group.severity
      ) {
        previous.targets.push(...structuredClone(group.targets));
      } else {
        throw new Error("VPWP50 group digest collision");
      }
    }
  }
  const groups = sortWeatherWarningForecastGroups([...groupsByKey.values()].map((group) => ({
    ...group,
    targets: [...group.targets].sort((left, right) =>
      compareText(left.scope, right.scope)
      || compareText(left.areaCode ?? "", right.areaCode ?? "")
      || compareText(left.localCode ?? "", right.localCode ?? "")
      || compareText(left.key, right.key)
      || compareText(left.name, right.name)),
  })));
  if (weatherWarningForecastPeriodCount(groups) === 0) return null;
  const severity: StandbySeverity = groups.reduce<StandbySeverity>(
    (best, group) => severityRank[group.severity] > severityRank[best] ? group.severity : best,
    "info",
  );
  const sources = [...new Set(states.map((state) => state.sourceEventId.trim()).filter(Boolean))].sort(compareText);
  return {
    kind: "weatherWarningForecast",
    surface: "corner-right",
    key: "weatherWarningForecast:active",
    sourceEventIds: sources,
    updatedAt: new Date(Math.max(...states.map((state) => state.revision.reportTimeMs))).toISOString(),
    expiresAt: new Date(Math.max(...states.map((state) => state.expiresAtMs))).toISOString(),
    restored: states.some((state) => state.restored),
    severity,
    data: { groups },
  };
}

interface CountUnit {
  path: string;
  actual: number;
  code: Vpwp50ProjectionLimitReasonCode;
  declaredLimit: number;
}

function countUnits(states: readonly WeatherWarningForecastState[]): CountUnit[] {
  const units: CountUnit[] = [];
  for (const state of states) {
    const subject = escapePath(state.subjectKey);
    units.push({ code: "groupsPerSubject", actual: state.groups.length, declaredLimit: WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT, path: `subjects/${subject}/groups` });
    units.push({ code: "periodsPerSubject", actual: weatherWarningForecastPeriodCount(state.groups), declaredLimit: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT, path: `subjects/${subject}/periods` });
    for (const group of state.groups) {
      const groupPath = `subjects/${subject}/groups/${escapePath(group.key)}`;
      units.push({ code: "targetsPerGroup", actual: group.targets.length, declaredLimit: WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP, path: `${groupPath}/targets` });
      for (const target of group.targets) {
        const targetPath = `${groupPath}/targets/${escapePath(target.key)}`;
        units.push({ code: "periodsPerTarget", actual: target.periods.length, declaredLimit: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET, path: `${targetPath}/periods` });
        const anchors = new Map<string, number>();
        for (const period of target.periods) anchors.set(period.pagerAnchorKey, (anchors.get(period.pagerAnchorKey) ?? 0) + 1);
        for (const [anchor, actual] of anchors) units.push({ code: "periodsPerAnchor", actual, declaredLimit: WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM, path: `${targetPath}/anchors/${escapePath(anchor)}/periods` });
      }
    }
  }
  const total = states.reduce((sum, state) => sum + weatherWarningForecastPeriodCount(state.groups), 0);
  units.push({ code: "periodsPerCard", actual: total, declaredLimit: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD, path: "card/weatherWarningForecast:active/periods" });
  return units;
}

function cardConstraintsPass(states: readonly WeatherWarningForecastState[]): boolean {
  const units = countUnits(states);
  if (units.some((unit) => unit.actual > unit.declaredLimit)) return false;
  const card = buildWeatherWarningForecastCard(states);
  return card == null || weatherWarningForecastCardJsonBytes(card) <= WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES;
}

function canonicalStateCopy(states: readonly WeatherWarningForecastState[]): WeatherWarningForecastState[] {
  return [...states].sort((a, b) => compareText(a.subjectKey, b.subjectKey)).map((state) => ({
    ...structuredClone(state),
    groups: sortWeatherWarningForecastGroups(state.groups).map((group) => ({
      ...structuredClone(group),
      targets: [...group.targets].sort((left, right) =>
        compareText(left.scope, right.scope)
        || compareText(left.areaCode ?? "", right.areaCode ?? "")
        || compareText(left.localCode ?? "", right.localCode ?? "")
        || compareText(left.key, right.key)
        || compareText(left.name, right.name)).map((target) => ({
          ...structuredClone(target),
          periods: [...target.periods].sort(periodCanonicalOrder).map((period) => ({ ...period })),
        })),
    })),
  }));
}

function limitReasonUnits(
  states: readonly WeatherWarningForecastState[],
  code: Vpwp50ProjectionLimitReasonCode,
): CountUnit[] {
  return countUnits(states).filter((unit) => unit.code === code && unit.actual > unit.declaredLimit)
    .sort((a, b) => compareText(a.path, b.path));
}

function truncateReasonUnits(
  statesInput: readonly WeatherWarningForecastState[],
  code: Exclude<Vpwp50ProjectionLimitReasonCode, "cardJsonBytes">,
  paths: ReadonlySet<string>,
  limit: number,
): WeatherWarningForecastState[] {
  const states = canonicalStateCopy(statesInput);
  for (const state of states) {
    const subjectPath = `subjects/${escapePath(state.subjectKey)}`;
    if (code === "groupsPerSubject" && paths.has(`${subjectPath}/groups`)) state.groups = state.groups.slice(0, limit);
    for (const group of state.groups) {
      const groupPath = `${subjectPath}/groups/${escapePath(group.key)}`;
      if (code === "targetsPerGroup" && paths.has(`${groupPath}/targets`)) group.targets = group.targets.slice(0, limit);
      for (const target of group.targets) {
        const targetPath = `${groupPath}/targets/${escapePath(target.key)}`;
        if (code === "periodsPerTarget" && paths.has(`${targetPath}/periods`)) target.periods = target.periods.slice(0, limit);
        if (code === "periodsPerAnchor") {
          const counts = new Map<string, number>();
          target.periods = target.periods.filter((period) => {
            const anchorPath = `${targetPath}/anchors/${escapePath(period.pagerAnchorKey)}/periods`;
            if (!paths.has(anchorPath)) return true;
            const seen = counts.get(period.pagerAnchorKey) ?? 0;
            counts.set(period.pagerAnchorKey, seen + 1);
            return seen < limit;
          });
        }
      }
      group.targets = group.targets.filter((target) => target.periods.length > 0);
    }
    if (code === "periodsPerSubject" && paths.has(`${subjectPath}/periods`)) {
      let remaining = limit;
      for (const group of state.groups) for (const target of group.targets) {
        target.periods = target.periods.slice(0, Math.max(0, remaining));
        remaining -= target.periods.length;
      }
    }
    state.groups = state.groups.map((group) => ({ ...group, targets: group.targets.filter((target) => target.periods.length > 0) })).filter((group) => group.targets.length > 0);
  }
  if (code === "periodsPerCard" && paths.has("card/weatherWarningForecast:active/periods")) {
    let remaining = limit;
    for (const state of states) for (const group of state.groups) for (const target of group.targets) {
      target.periods = target.periods.slice(0, Math.max(0, remaining));
      remaining -= target.periods.length;
    }
  }
  return states.map((state) => ({
    ...state,
    groups: state.groups.map((group) => ({ ...group, targets: group.targets.filter((target) => target.periods.length > 0) })).filter((group) => group.targets.length > 0),
  })).filter((state) => state.groups.length > 0);
}

export function weatherWarningForecastProjectionLimitReasons(
  states: readonly WeatherWarningForecastState[],
): Vpwp50ProjectionLimitReason[] {
  const originalUnits = countUnits(states);
  const violatedCodes = new Set(originalUnits.filter((unit) => unit.actual > unit.declaredLimit).map((unit) => unit.code));
  const card = buildWeatherWarningForecastCard(states);
  const cardBytes = card == null ? 0 : weatherWarningForecastCardJsonBytes(card);
  if (cardBytes > WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES) violatedCodes.add("cardJsonBytes");
  const result: Vpwp50ProjectionLimitReason[] = [];
  for (const code of REASON_ORDER) {
    if (!violatedCodes.has(code)) continue;
    if (code === "cardJsonBytes") {
      result.push({
        code, actual: cardBytes, declaredLimit: WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES,
        effectiveLimit: WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES, violatingUnitCount: 1,
        limitingHierarchies: ["cardJsonBytes"], samplePaths: ["card/weatherWarningForecast:active/jsonBytes"],
      });
      continue;
    }
    const units = limitReasonUnits(states, code);
    const paths = new Set(units.map((unit) => unit.path));
    const declaredLimit = units[0]!.declaredLimit;
    let effectiveLimit: number | null = null;
    for (let candidate = 0; candidate <= declaredLimit; candidate += 1) {
      if (cardConstraintsPass(truncateReasonUnits(states, code, paths, candidate))) effectiveLimit = candidate;
    }
    const zeroReasons = effectiveLimit == null
      ? new Set(weatherWarningForecastProjectionLimitReasonsShallow(truncateReasonUnits(states, code, paths, 0)))
      : null;
    const limitingHierarchies = REASON_ORDER.filter((reason) =>
      reason === code || (zeroReasons?.has(reason) ?? (violatedCodes.has(reason) && isAncestorReason(code, reason))));
    result.push({
      code,
      actual: Math.max(...units.map((unit) => unit.actual)),
      declaredLimit,
      effectiveLimit,
      violatingUnitCount: units.length,
      limitingHierarchies,
      samplePaths: units.map((unit) => unit.path).sort(compareText).slice(0, 8),
    });
  }
  return result;
}

function weatherWarningForecastProjectionLimitReasonsShallow(states: readonly WeatherWarningForecastState[]): Vpwp50ProjectionLimitReasonCode[] {
  const codes = new Set(countUnits(states).filter((unit) => unit.actual > unit.declaredLimit).map((unit) => unit.code));
  const card = buildWeatherWarningForecastCard(states);
  if (card != null && weatherWarningForecastCardJsonBytes(card) > WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES) codes.add("cardJsonBytes");
  return REASON_ORDER.filter((code) => codes.has(code));
}

function isAncestorReason(code: Vpwp50ProjectionLimitReasonCode, possible: Vpwp50ProjectionLimitReasonCode): boolean {
  const ancestors: Record<Vpwp50ProjectionLimitReasonCode, readonly Vpwp50ProjectionLimitReasonCode[]> = {
    groupsPerSubject: ["groupsPerSubject", "periodsPerSubject", "periodsPerCard", "cardJsonBytes"],
    targetsPerGroup: ["targetsPerGroup", "periodsPerSubject", "periodsPerCard", "cardJsonBytes"],
    periodsPerTarget: ["periodsPerTarget", "periodsPerSubject", "periodsPerCard", "cardJsonBytes"],
    periodsPerAnchor: ["periodsPerAnchor", "periodsPerTarget", "periodsPerSubject", "periodsPerCard", "cardJsonBytes"],
    periodsPerSubject: ["periodsPerSubject", "periodsPerCard", "cardJsonBytes"],
    periodsPerCard: ["periodsPerCard", "cardJsonBytes"], cardJsonBytes: ["cardJsonBytes"],
  };
  return ancestors[code].includes(possible);
}

export function assertWeatherWarningForecastWireInvariant(states: readonly WeatherWarningForecastState[]): void {
  const reasons = weatherWarningForecastProjectionLimitReasons(states);
  if (reasons.length > 0) throw new Error(`VPWP50 projection wire invariant failed: ${JSON.stringify(reasons)}`);
}

export function periodCanonicalOrder(left: DisplayWeatherWarningForecastPeriodV1, right: DisplayWeatherWarningForecastPeriodV1): number {
  return Date.parse(left.startsAt) - Date.parse(right.startsAt)
    || Date.parse(left.endsAt) - Date.parse(right.endsAt)
    || left.tsNum - right.tsNum || compareText(left.series, right.series) || compareText(left.key, right.key);
}
