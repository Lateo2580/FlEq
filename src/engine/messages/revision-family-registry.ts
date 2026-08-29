import type {
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedSeismicTextInfo,
  ParsedWeatherBriefing,
  ParsedEarlyWeatherInfo,
  ParsedClimateInfo,
  ParsedWeatherExplanation,
  ParsedFloodForecastInfo,
  ParsedHeatAlertInfo,
  ParsedLgObservationInfo,
  ParsedNankaiTroughInfo,
  ParsedTornadoAdvisory,
  ParsedTsunamiInfo,
  ParsedTyphoonAnalysis,
  ParsedTyphoonProbability,
  ParsedVolcanoInfo,
  ParsedVolcanoTextInfo,
  ParsedWeatherWarning,
  ParsedWeatherWarningTimeseriesInfo,
  ParsedLegacyCounterpartInfo,
  TelegramMeta,
  TsunamiObservationStation,
  VolcanoAlertStateEntry,
} from "../../types";
import type { TelegramRevisionComparator } from "../../dmdata/telegram-meta";
import {
  semanticPayloadFingerprint,
  TELEGRAM_REVISION_MAX_ENTRIES,
  type CancellationPolicy,
} from "./telegram-revision-gate";
import { TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY } from "./tsunami-state";
import {
  VPWW56_MAX_SUBJECTS,
  VPWW56_TOMBSTONE_RETENTION_MS,
  vpww56HasActiveAreas,
  vpww56StateSubjectKey,
} from "./vpww56-state";
import { FLOOD_LEVEL_RANK, floodKindCodeToLevel, maxFloodLevel } from "../../dmdata/flood-level";
import { jstDayKey } from "../../utils/jst-day-key";
import { nankaiBadgeAction } from "../display/nankai-status";
import { normalizeTornadoPublishingOffice, tornadoTickerGroupKey } from "../display/tornado-group-key";
import type { Route } from "./route-catalog";
import { weatherOfficeStreamKey } from "./weather-stream-key";

interface RevisionFamilyPolicyBase<TParsed> {
  domain: string;
  revisionFamily: string;
  headTypes: readonly string[];
  comparator: TelegramRevisionComparator;
  extractStateSubjectKey: (
    meta: TelegramMeta,
    parsed: TParsed,
  ) => string | readonly string[] | null;
  extractCancellationTarget: (
    meta: TelegramMeta,
    parsed: TParsed,
  ) => readonly string[] | null;
  cancellationPolicy: CancellationPolicy;
  terminalPredicate: (meta: TelegramMeta, parsed: TParsed) => boolean;
  deactivationPredicate: (meta: TelegramMeta, parsed: TParsed) => boolean;
  /** durable active watermark を永続化する。tombstone は下記の domain 規則で compact する。 */
  durable: boolean;
  /** durable tombstone の domain 固有保持期間。null は固定 subject のため期限なし。 */
  tombstoneRetentionMs: number | null;
  /** family が保持し得る subject 数。durable な無期限 tombstone では有限値を必須とする。 */
  maxSubjects: number | null;
  /** serial が構造上省略される family のみ明示して許可する。 */
  allowMissingSerial?: boolean;
}

export const FRAGMENT_MERGE_ALLOWLIST_KEYS = [
  "tsunamiObservation:VTSE51",
  "tsunamiObservation:VTSE52",
] as const;

export type FragmentMergeAllowlistKey = typeof FRAGMENT_MERGE_ALLOWLIST_KEYS[number];

export type RevisionFamilyPolicy<TParsed, TItem = never> = RevisionFamilyPolicyBase<TParsed> & (
  | {
      fragmentMerge: false;
      extractItems?: never;
      itemSubjectKey?: never;
      itemFingerprint?: never;
      fingerprintVersion?: never;
      fragmentEvidence?: never;
      fragmentAllowlistKey?: never;
    }
  | {
      fragmentMerge: true;
      fragmentAllowlistKey: FragmentMergeAllowlistKey;
      extractItems: (parsed: TParsed) => readonly TItem[];
      itemSubjectKey: (meta: TelegramMeta, item: TItem) => string | null;
      itemFingerprint: (item: TItem) => string;
      fingerprintVersion: string;
      fragmentEvidence: {
        corpusFixtures: readonly string[];
        regressionTests: readonly string[];
        rationale: string;
      };
    }
);

function eewPolicy(headType: "VXSE43" | "VXSE44" | "VXSE45"):
  RevisionFamilyPolicy<ParsedEewInfo> {
  return {
    domain: "eew",
    revisionFamily: headType,
    headTypes: [headType],
    comparator: "serialOnly",
    extractStateSubjectKey: (meta) =>
      meta.eventId.valid ? meta.eventId.value : null,
    extractCancellationTarget: (meta) =>
      meta.eventId.valid && meta.eventId.value != null
        ? [meta.eventId.value]
        : null,
    cancellationPolicy: "markCancelled",
    terminalPredicate: (_meta, parsed) => parsed.nextAdvisory != null,
    deactivationPredicate: (meta, parsed) =>
      meta.infoType.value === "取消" || parsed.nextAdvisory != null,
    durable: false,
    tombstoneRetentionMs: null,
    maxSubjects: 512,
    fragmentMerge: false,
  };
}

const VPWS50_SUBJECT = "weather:vpws50";
const VPWW55_MAX_SUBJECTS = 128;
const NANKAI_CURRENT_SUBJECT = "nankai:current";
const STANDBY_DOMAIN_RETENTION_MS = 36 * 60 * 60_000;
const HEAT_RETENTION_MS = 3 * 24 * 60 * 60_000;
const NANKAI_RETENTION_MS = 30 * 24 * 60 * 60_000;
const TRANSIENT_DAY_MS = 24 * 60 * 60_000;

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function eventSubject(meta: TelegramMeta, prefix: string, includeType = true): string | null {
  const eventId = meta.eventId.valid ? nonBlank(meta.eventId.value) : null;
  const headType = meta.type.valid ? nonBlank(meta.type.value) : null;
  if (eventId == null || includeType && headType == null) return null;
  return includeType ? `${prefix}:${headType}:${eventId}` : `${prefix}:${eventId}`;
}

export function tsunamiStateSubjectKey(meta: TelegramMeta): string | null {
  return eventSubject(meta, "tsunami", false);
}

function transientEventPolicy<TParsed>(options: {
  domain: string;
  revisionFamily: string;
  headTypes: readonly string[];
  prefix: string;
  retentionMs: number;
  maxSubjects: number;
  includeType?: boolean;
}): RevisionFamilyPolicy<TParsed> {
  const subject = (meta: TelegramMeta): string | null =>
    eventSubject(meta, options.prefix, options.includeType !== false);
  return {
    domain: options.domain,
    revisionFamily: options.revisionFamily,
    headTypes: options.headTypes,
    comparator: "reportDateTimeThenSerial",
    extractStateSubjectKey: (meta) => subject(meta),
    extractCancellationTarget: (meta) => {
      const target = subject(meta);
      return target == null ? null : [target];
    },
    cancellationPolicy: "markCancelled",
    terminalPredicate: () => false,
    deactivationPredicate: () => false,
    durable: false,
    tombstoneRetentionMs: options.retentionMs,
    maxSubjects: options.maxSubjects,
    allowMissingSerial: true,
    fragmentMerge: false,
  };
}

export const EARTHQUAKE_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedEarthquakeInfo>({
  domain: "earthquake",
  revisionFamily: "earthquake",
  headTypes: ["VXSE51", "VXSE52", "VXSE53", "VXSE61"],
  prefix: "earthquake",
  includeType: false,
  retentionMs: TRANSIENT_DAY_MS,
  maxSubjects: 512,
});

export const SEISMIC_TEXT_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedSeismicTextInfo>({
  domain: "seismicText",
  revisionFamily: "seismicText",
  headTypes: ["VXSE56", "VXSE60", "VZSE40"],
  prefix: "seismicText",
  retentionMs: 36 * 60 * 60_000,
  maxSubjects: 256,
});

export const BRIEFING_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedWeatherBriefing>({
  domain: "briefing",
  revisionFamily: "briefing",
  headTypes: ["VPBS50"],
  prefix: "briefing",
  retentionMs: 36 * 60 * 60_000,
  maxSubjects: 128,
});

export const EARLY_WEATHER_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedEarlyWeatherInfo>({
  domain: "earlyWeather",
  revisionFamily: "earlyWeather",
  headTypes: ["VPAW51"],
  prefix: "earlyWeather",
  retentionMs: 7 * TRANSIENT_DAY_MS,
  maxSubjects: 128,
});

export const CLIMATE_INFO_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedClimateInfo>({
  domain: "climateInfo",
  revisionFamily: "climateInfo",
  headTypes: ["VPZI50", "VPCI50"],
  prefix: "climateInfo",
  retentionMs: 30 * TRANSIENT_DAY_MS,
  maxSubjects: 128,
});

export const WEATHER_EXPLANATION_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedWeatherExplanation>({
  domain: "weatherExplanation",
  revisionFamily: "weatherExplanation",
  headTypes: ["VPCJ51", "VPZJ51", "VPFJ51", "VMCJ53", "VMCJ54", "VMCJ55"],
  prefix: "weatherExplanation",
  retentionMs: 36 * 60 * 60_000,
  maxSubjects: 256,
});

export const TRANSIENT_WEATHER_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedWeatherWarning>({
  domain: "weather",
  revisionFamily: "VPWW57-61",
  headTypes: ["VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61"],
  prefix: "weatherTransient",
  retentionMs: 36 * 60 * 60_000,
  maxSubjects: 128,
});

export const RAW_REVISION_FAMILY_POLICY = transientEventPolicy<unknown>({
  domain: "raw",
  revisionFamily: "raw",
  headTypes: ["*"],
  prefix: "raw",
  retentionMs: 11 * 60_000,
  maxSubjects: 512,
});

/** legacy counterpart の revision watermark 用保持期間。相関 cache の retention と共有しない。 */
export const LEGACY_COUNTERPART_REVISION_RETENTION_MS = 11 * 60_000;

/** VPOA50／VPNO50／VXWW50 専用の非永続 revision family。 */
export const LEGACY_COUNTERPART_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedLegacyCounterpartInfo> = {
  domain: "legacyCounterpart",
  revisionFamily: "legacyCounterpart",
  headTypes: ["VPOA50", "VPNO50", "VXWW50"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (meta) => eventSubject(meta, "legacyCounterpart"),
  extractCancellationTarget: (meta) => {
    const subject = eventSubject(meta, "legacyCounterpart");
    return subject == null ? null : [subject];
  },
  cancellationPolicy: "markCancelled",
  terminalPredicate: () => false,
  deactivationPredicate: () => false,
  durable: false,
  tombstoneRetentionMs: LEGACY_COUNTERPART_REVISION_RETENTION_MS,
  maxSubjects: 512,
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const VOLCANO_ASHFALL_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedVolcanoInfo> = {
  domain: "volcano",
  revisionFamily: "volcanoAshfall",
  headTypes: ["VFVO53", "VFVO54", "VFVO55"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (meta, parsed) => {
    const code = nonBlank(parsed.volcanoCode);
    const type = meta.type.valid ? nonBlank(meta.type.value) : null;
    return code == null || type == null ? null : `volcano:ashfall:${type}:${code}`;
  },
  extractCancellationTarget: (meta, parsed) => {
    const code = nonBlank(parsed.volcanoCode);
    const type = meta.type.valid ? nonBlank(meta.type.value) : null;
    return code == null || type == null ? null : [`volcano:ashfall:${type}:${code}`];
  },
  cancellationPolicy: "markCancelled",
  terminalPredicate: () => false,
  deactivationPredicate: () => false,
  durable: false,
  tombstoneRetentionMs: 36 * 60 * 60_000,
  maxSubjects: 128,
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const VOLCANO_TRANSIENT_REVISION_FAMILY_POLICY = transientEventPolicy<ParsedVolcanoInfo>({
  domain: "volcano",
  revisionFamily: "volcanoTransient",
  headTypes: ["VZVO40", "VFVO60"],
  prefix: "volcanoTransient",
  retentionMs: 36 * 60 * 60_000,
  maxSubjects: 128,
});

export function tornadoStateSubjectKey(parsed: ParsedTornadoAdvisory): string {
  return tornadoTickerGroupKey(normalizeTornadoPublishingOffice(parsed.publishingOffice));
}

export function heatAlertStateSubjectKey(parsed: ParsedHeatAlertInfo): string | null {
  const area = nonBlank(parsed.targetAreaName);
  const targetMs = Date.parse(parsed.targetDateTime ?? parsed.reportDateTime);
  if (area == null || !Number.isFinite(targetMs)) return null;
  return `heat:${jstDayKey(targetMs)}:${area}`;
}

export function typhoonAnalysisStateSubjectKey(parsed: ParsedTyphoonAnalysis): string | null {
  const key = nonBlank(parsed.eventId);
  return key == null ? null : `typhoon:${key}`;
}

export function typhoonProbabilityStateSubjectKey(parsed: ParsedTyphoonProbability): string | null {
  const eventId = nonBlank(parsed.eventId);
  return eventId == null ? null : `typhoonProbability:${eventId}`;
}

export function weatherTimeseriesStateSubjectKey(
  parsed: ParsedWeatherWarningTimeseriesInfo,
): string | null {
  const office = nonBlank(parsed.publishingOffice);
  const areaCode = nonBlank(parsed.targetArea?.code);
  const areaName = nonBlank(parsed.targetArea?.name);
  const area = areaCode == null ? (areaName == null ? "scope:all" : `name:${areaName}`) : `code:${areaCode}`;
  return office == null ? null : `weatherTimeseries:${office}:${area}`;
}

export function longPeriodStateSubjectKey(meta: TelegramMeta): string | null {
  const eventId = meta.eventId.valid ? nonBlank(meta.eventId.value) : null;
  return eventId == null ? null : `longPeriod:${eventId}`;
}

export const TORNADO_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedTornadoAdvisory> = {
  domain: "tornado", revisionFamily: "tornado", headTypes: ["VPHW50", "VPHW51"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => tornadoStateSubjectKey(parsed),
  extractCancellationTarget: (_meta, parsed) => [tornadoStateSubjectKey(parsed)],
  cancellationPolicy: "clearCurrent", terminalPredicate: () => false,
  deactivationPredicate: (_meta, parsed) => parsed.activeAreaCount === 0,
  durable: true, tombstoneRetentionMs: STANDBY_DOMAIN_RETENTION_MS, maxSubjects: 128,
  allowMissingSerial: true, fragmentMerge: false,
};

export const HEAT_ALERT_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedHeatAlertInfo> = {
  domain: "heatAlert", revisionFamily: "VPFT50", headTypes: ["VPFT50"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => heatAlertStateSubjectKey(parsed),
  extractCancellationTarget: (_meta, parsed) => {
    const key = heatAlertStateSubjectKey(parsed); return key == null ? null : [key];
  },
  cancellationPolicy: "clearCurrent", terminalPredicate: () => false, deactivationPredicate: () => false,
  durable: true, tombstoneRetentionMs: HEAT_RETENTION_MS, maxSubjects: 256,
  allowMissingSerial: true, fragmentMerge: false,
};

export const TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedTyphoonAnalysis> = {
  domain: "typhoonAnalysis", revisionFamily: "typhoonAnalysis", headTypes: ["VPTW60", "VPTW61", "VPTW62"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => typhoonAnalysisStateSubjectKey(parsed),
  extractCancellationTarget: (_meta, parsed) => {
    const key = typhoonAnalysisStateSubjectKey(parsed); return key == null ? null : [key];
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: (_meta, parsed) => parsed.lifecycle === "transitionedToLow" || parsed.lifecycle === "formationCancelled",
  deactivationPredicate: () => false,
  durable: true, tombstoneRetentionMs: 7 * 24 * 60 * 60_000, maxSubjects: 64,
  allowMissingSerial: true, fragmentMerge: false,
};

export const TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedTyphoonProbability> = {
  domain: "typhoonProbability", revisionFamily: "VPTA50", headTypes: ["VPTA50"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => typhoonProbabilityStateSubjectKey(parsed),
  extractCancellationTarget: (_meta, parsed) => {
    const key = typhoonProbabilityStateSubjectKey(parsed); return key == null ? null : [key];
  },
  cancellationPolicy: "clearCurrent", terminalPredicate: () => false, deactivationPredicate: () => false,
  durable: false, tombstoneRetentionMs: 7 * 24 * 60 * 60_000, maxSubjects: 256,
  allowMissingSerial: true, fragmentMerge: false,
};

export const NANKAI_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedNankaiTroughInfo> = {
  domain: "nankaiTrough", revisionFamily: "nankaiTrough", headTypes: ["VYSE50", "VYSE51", "VYSE52", "VYSE60"],
  comparator: "reportDateTimeThenSerial", extractStateSubjectKey: () => NANKAI_CURRENT_SUBJECT,
  extractCancellationTarget: () => [NANKAI_CURRENT_SUBJECT], cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  deactivationPredicate: (_meta, parsed) => nankaiBadgeAction(parsed.infoSerial?.code ?? null).action === "deactivate",
  durable: true, tombstoneRetentionMs: NANKAI_RETENTION_MS, maxSubjects: 1,
  allowMissingSerial: true, fragmentMerge: false,
};

export const NANKAI_INFORMATION_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedNankaiTroughInfo> = {
  domain: "nankaiTrough", revisionFamily: "nankaiInformation", headTypes: ["VYSE50", "VYSE51", "VYSE52", "VYSE60"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (meta) => {
    const type = meta.type.valid ? nonBlank(meta.type.value) : null;
    const eventId = meta.eventId.valid ? nonBlank(meta.eventId.value) : null;
    return type == null || eventId == null ? null : `nankai:information:${type}:${eventId}`;
  },
  extractCancellationTarget: (meta) => {
    const type = meta.type.valid ? nonBlank(meta.type.value) : null;
    const eventId = meta.eventId.valid ? nonBlank(meta.eventId.value) : null;
    return type == null || eventId == null ? null : [`nankai:information:${type}:${eventId}`];
  },
  cancellationPolicy: "clearCurrent", terminalPredicate: () => false, deactivationPredicate: () => false,
  durable: false, tombstoneRetentionMs: NANKAI_RETENTION_MS, maxSubjects: 256,
  allowMissingSerial: true, fragmentMerge: false,
};

export const WEATHER_TIMESERIES_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedWeatherWarningTimeseriesInfo> = {
  domain: "weatherWarningTimeseries", revisionFamily: "VPWP50", headTypes: ["VPWP50"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => weatherTimeseriesStateSubjectKey(parsed),
  extractCancellationTarget: (_meta, parsed) => {
    const key = weatherTimeseriesStateSubjectKey(parsed); return key == null ? null : [key];
  },
  cancellationPolicy: "clearCurrent", terminalPredicate: () => false, deactivationPredicate: () => false,
  durable: false, tombstoneRetentionMs: STANDBY_DOMAIN_RETENTION_MS, maxSubjects: 512,
  allowMissingSerial: true, fragmentMerge: false,
};

export const LG_OBSERVATION_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedLgObservationInfo> = {
  domain: "lgObservation", revisionFamily: "VXSE62", headTypes: ["VXSE62"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (meta) => longPeriodStateSubjectKey(meta),
  extractCancellationTarget: (meta) => {
    const key = longPeriodStateSubjectKey(meta); return key == null ? null : [key];
  },
  cancellationPolicy: "markCancelled", terminalPredicate: () => false, deactivationPredicate: () => false,
  durable: true, tombstoneRetentionMs: STANDBY_DOMAIN_RETENTION_MS, maxSubjects: 256,
  allowMissingSerial: true, fragmentMerge: false,
};
export const FLOOD_FORECAST_MAX_SUBJECTS = 512;
export const FLOOD_FORECAST_RETENTION_MS = 36 * 60 * 60_000;
export const FLOOD_FORECAST_HEAD_TYPES = [
  ...Array.from({ length: 40 }, (_, index) => `VXKO${50 + index}`),
  ...Array.from({ length: 10 }, (_, index) => `VXSU${50 + index}`),
] as const;

export function floodForecastSubjectKey(eventId: string): string | null {
  const normalized = eventId.trim();
  return normalized === "" ? null : `flood:event:${normalized}`;
}

export function floodForecastHasActiveState(parsed: ParsedFloodForecastInfo): boolean {
  if (parsed.rawStations.length > 0) {
    return parsed.rawStations.some((station) =>
      FLOOD_LEVEL_RANK[maxFloodLevel([
        station.stationObservedLevel,
        station.headlineLevel,
      ])] >= FLOOD_LEVEL_RANK.L3);
  }
  return parsed.headlines.some((headline) =>
    (headline.scope === "河川" || headline.scope === "発表区間")
    && headline.areas.length > 0
    && FLOOD_LEVEL_RANK[floodKindCodeToLevel(headline.kindCode)] >= FLOOD_LEVEL_RANK.L3);
}

/** station 本文が明示的な level/release を持つか。全件 unknown は解除根拠にしない。 */
export function floodForecastHasUnderstoodStations(parsed: ParsedFloodForecastInfo): boolean {
  return parsed.rawStations.some((station) =>
    station.stationObservedLevel !== "unknown"
    || station.headlineLevel !== "unknown");
}

function floodForecastDeactivatesState(parsed: ParsedFloodForecastInfo): boolean {
  if (parsed.rawStations.length > 0) {
    return floodForecastHasUnderstoodStations(parsed) && !floodForecastHasActiveState(parsed);
  }
  const understood = parsed.headlines.some((headline) =>
    (headline.scope === "河川" || headline.scope === "発表区間")
    && headline.areas.length > 0
    && floodKindCodeToLevel(headline.kindCode) !== "unknown");
  return understood && !floodForecastHasActiveState(parsed);
}

export const FLOOD_FORECAST_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedFloodForecastInfo> = {
  domain: "floodForecast",
  revisionFamily: "floodForecast",
  headTypes: FLOOD_FORECAST_HEAD_TYPES,
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => floodForecastSubjectKey(parsed.eventId),
  extractCancellationTarget: (_meta, parsed) => {
    const subject = floodForecastSubjectKey(parsed.eventId);
    return subject == null ? null : [subject];
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  deactivationPredicate: (_meta, parsed) => floodForecastDeactivatesState(parsed),
  durable: true,
  tombstoneRetentionMs: FLOOD_FORECAST_RETENTION_MS,
  maxSubjects: FLOOD_FORECAST_MAX_SUBJECTS,
  fragmentMerge: false,
};
export const VOLCANO_MAX_SUBJECTS = 512;
export const VOLCANO_ALERT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS = 2 * 24 * 60 * 60_000;

export function volcanoAlertSubjectKey(volcanoCode: string): string | null {
  const code = volcanoCode.trim();
  return code === "" ? null : `volcano:alert:${code}`;
}

export function volcanoEruptionSubjectKey(volcanoCode: string): string | null {
  const code = volcanoCode.trim();
  return code === "" ? null : `volcano:eruption:${code}`;
}

function volcanoAlertSubjects(parsed: ParsedVolcanoInfo): string | readonly string[] | null {
  if (parsed.kind === "alert") return volcanoAlertSubjectKey(parsed.volcanoCode);
  if (parsed.kind !== "text" || parsed.type !== "VFVO51") return null;
  const subjects = volcanoTextAlertStateEntries(parsed).flatMap((entry) => {
    const subject = volcanoAlertSubjectKey(entry.volcanoCode);
    return subject == null ? [] : [subject];
  });
  return [...new Set(subjects)];
}

/** Phase 3B 導入前 DTO も受けつつ、VFVO51 の数値／非数値 state 候補を統一する。 */
export function volcanoTextAlertStateEntries(
  parsed: ParsedVolcanoTextInfo,
): VolcanoAlertStateEntry[] {
  if (parsed.alertStateEntries != null) {
    return parsed.alertStateEntries.map((entry) => ({
      ...entry,
      alertClass: entry.alertClass == null ? null : { ...entry.alertClass },
    }));
  }
  if (parsed.alertClasses.length > 0) {
    return parsed.alertClasses.map((entry) => ({
      volcanoCode: entry.volcanoCode,
      volcanoName: entry.volcanoName,
      alertLevel: null,
      alertLevelCode: entry.alertClass.code,
      action: entry.alertClass.isActive ? "continue" : "release",
      warningKind: entry.alertClass.name,
      alertClass: { ...entry.alertClass },
    }));
  }
  const subject = volcanoAlertSubjectKey(parsed.volcanoCode);
  if (subject == null || parsed.alertLevelCode == null) return [];
  return [{
    volcanoCode: parsed.volcanoCode,
    volcanoName: parsed.volcanoName,
    alertLevel: parsed.alertLevel,
    alertLevelCode: parsed.alertLevelCode,
    action: parsed.infoType === "取消" ? "cancel" : "continue",
    warningKind: "",
    alertClass: null,
  }];
}

function volcanoAlertIsInactive(parsed: ParsedVolcanoInfo): boolean {
  if (parsed.kind === "alert") {
    return parsed.action === "release"
      || parsed.action === "cancel"
      || parsed.alertLevel === 1 && (parsed.action === "continue" || parsed.action === "lower");
  }
  return parsed.kind === "text"
    && parsed.type === "VFVO51"
    && volcanoTextAlertStateEntries(parsed).length === 1
    && (() => {
      const entry = volcanoTextAlertStateEntries(parsed)[0];
      return entry.action === "release"
        || entry.action === "cancel"
        || entry.alertLevel === 1 && (entry.action === "continue" || entry.action === "lower")
        || entry.alertClass?.isActive === false;
    })();
}

export const VOLCANO_ALERT_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedVolcanoInfo> = {
  domain: "volcano",
  revisionFamily: "volcanoAlert",
  headTypes: ["VFVO50", "VFVO51", "VFSVii"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => volcanoAlertSubjects(parsed),
  extractCancellationTarget: (_meta, parsed) => {
    const extracted = volcanoAlertSubjects(parsed);
    return extracted == null ? null : typeof extracted === "string" ? [extracted] : extracted;
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  deactivationPredicate: (_meta, parsed) => volcanoAlertIsInactive(parsed),
  durable: true,
  tombstoneRetentionMs: VOLCANO_ALERT_TOMBSTONE_RETENTION_MS,
  maxSubjects: VOLCANO_MAX_SUBJECTS,
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const VOLCANO_ERUPTION_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedVolcanoInfo> = {
  domain: "volcano",
  revisionFamily: "volcanoEruption",
  headTypes: ["VFVO52", "VFVO56"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => parsed.kind === "eruption"
    ? volcanoEruptionSubjectKey(parsed.volcanoCode)
    : null,
  extractCancellationTarget: (_meta, parsed) => {
    if (parsed.kind !== "eruption") return null;
    const subject = volcanoEruptionSubjectKey(parsed.volcanoCode);
    return subject == null ? null : [subject];
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  deactivationPredicate: () => false,
  durable: true,
  tombstoneRetentionMs: VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS,
  maxSubjects: VOLCANO_MAX_SUBJECTS,
  allowMissingSerial: true,
  fragmentMerge: false,
};

function tsunamiObservationItemSubjectKey(item: TsunamiObservationStation): string | null {
  const code = item.stationCode?.trim();
  return code ? code : null;
}

function tsunamiObservationItemFingerprint(item: TsunamiObservationStation): string {
  return semanticPayloadFingerprint({
    areaCode: item.areaCode ?? null,
    areaName: item.areaName,
    name: item.name,
    sensor: item.sensor,
    arrivalTime: item.arrivalTime,
    initial: item.initial,
    maxHeightCondition: item.maxHeightCondition,
    maxHeightValue: item.maxHeightValue,
    maxHeightValueCondition: item.maxHeightValueCondition ?? "",
  });
}

function tsunamiObservationPolicy(
  headType: "VTSE51" | "VTSE52",
): Extract<
  RevisionFamilyPolicy<ParsedTsunamiInfo, TsunamiObservationStation>,
  { fragmentMerge: true }
> {
  return {
    domain: "tsunamiObservation",
    revisionFamily: headType,
    headTypes: [headType],
    comparator: "reportDateTimeThenSerial",
    extractStateSubjectKey: () => `tsunami:observations:${headType}`,
    extractCancellationTarget: () => [`tsunami:observations:${headType}`],
    cancellationPolicy: "clearCurrent",
    terminalPredicate: () => false,
    deactivationPredicate: () => false,
    // 観測系列は警報継続中に 11 分を超えて更新される。runtime 内 watermark は期限切れさせない。
    durable: true,
    tombstoneRetentionMs: null,
    // family watermark 1 件 + station item watermark の上限。
    maxSubjects: TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY + 1,
    fragmentMerge: true,
    fragmentAllowlistKey: `tsunamiObservation:${headType}`,
    extractItems: (parsed) => parsed.observations ?? [],
    // code 欠落 item は common item gate では保持せず fail-open 表示へ送る。
    // DisplayStateStore の legacy name fallback は旧 snapshot/key 昇格互換として維持する。
    itemSubjectKey: (_meta, item) => tsunamiObservationItemSubjectKey(item),
    itemFingerprint: tsunamiObservationItemFingerprint,
    fingerprintVersion: "tsunami-observation-v2",
    fragmentEvidence: {
      corpusFixtures: [
        headType === "VTSE51"
          ? "32-39_11_10_250206_VTSE51.xml"
          : "61_11_01_250206_VTSE52.xml",
      ],
      regressionTests: [
        "test/engine/telegram-foundation/phase3b-tsunami.test.ts",
        "test/engine/display/state-store.test.ts",
      ],
      rationale: "station code の実在 fixture と、同一 revision 分割・順序反転 regression に限定する",
    },
  };
}

function vpws50StateSubjectKey(meta: TelegramMeta, parsed: ParsedWeatherWarning): string | null {
  if (!meta.type.valid) return null;
  if (meta.type.value === "VPWS50") return VPWS50_SUBJECT;
  if (meta.type.value === "VPWW55") {
    return weatherOfficeStreamKey(meta.type.value, parsed.publishingOffice);
  }
  return null;
}

export const VPWS50_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedWeatherWarning> = {
  domain: "weather",
  revisionFamily: "VPWS50",
  // VPWW55 は同じ警報現況を先行して伝える地域報。全国集約 VPWS50 と同じ current
  // state に入れ、ReportDateTime/Serial の単調性を family 横断で守る。
  headTypes: ["VPWS50", "VPWW55"],
  comparator: "reportDateTimeThenSerial",
  // VPWS50 は全国 base、VPWW55 は官署別部分 stream。EventID は state 粒度ではない。
  extractStateSubjectKey: vpws50StateSubjectKey,
  extractCancellationTarget: (meta, parsed) => {
    const subject = vpws50StateSubjectKey(meta, parsed);
    return subject == null ? null : [subject];
  },
  cancellationPolicy: "restorePrevious",
  terminalPredicate: () => false,
  deactivationPredicate: () => false,
  durable: true,
  // 全国 base 1件と官署別部分報を有限上限で保持する。
  tombstoneRetentionMs: null,
  maxSubjects: 1 + VPWW55_MAX_SUBJECTS,
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const VPWW56_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedWeatherWarning> = {
  domain: "weather",
  revisionFamily: "VPWW56",
  headTypes: ["VPWW56"],
  comparator: "reportDateTimeThenSerial",
  // state holder / ticker と同じ官署×type stream。EventID は state 粒度に含めない。
  extractStateSubjectKey: (meta, parsed) =>
    meta.type.valid && meta.type.value === "VPWW56"
      ? vpww56StateSubjectKey(meta.type.value, parsed.publishingOffice)
      : null,
  extractCancellationTarget: (meta, parsed) => {
    const subject = meta.type.valid && meta.type.value === "VPWW56"
      ? vpww56StateSubjectKey(meta.type.value, parsed.publishingOffice)
      : null;
    return subject == null ? null : [subject];
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  // 解除 Kind のみの通常続報も、その官署 stream の clear として扱う。
  deactivationPredicate: (_meta, parsed) => !vpww56HasActiveAreas(parsed),
  durable: true,
  // 旧 holder の dormant watermark と同じ 6 時間。可変 subject の無期限化はしない。
  tombstoneRetentionMs: VPWW56_TOMBSTONE_RETENTION_MS,
  maxSubjects: VPWW56_MAX_SUBJECTS,
  // VPWW56 の実 fixture は Serial 空を許す。
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const TSUNAMI_REVISION_FAMILY_POLICIES = {
  VTSE41: {
    domain: "tsunami",
    revisionFamily: "VTSE41",
    headTypes: ["VTSE41"],
    comparator: "reportDateTimeThenSerial",
    // revision gate は EventID 単位。holder はその下で Area.Code + Kind.Code を分離する。
    extractStateSubjectKey: (meta) => tsunamiStateSubjectKey(meta),
    extractCancellationTarget: (meta) => {
      const subject = tsunamiStateSubjectKey(meta);
      return subject == null ? null : [subject];
    },
    cancellationPolicy: "clearCurrent",
    terminalPredicate: () => false,
    // 無警報 item は EventID 内の keyed state を更新する。別 EventID の active state は解除しない。
    deactivationPredicate: () => false,
    durable: true,
    tombstoneRetentionMs: null,
    maxSubjects: 512,
    // VTSE41 は正常電文・取消とも Serial 空の実 fixture が存在する。
    allowMissingSerial: true,
    fragmentMerge: false,
  } satisfies RevisionFamilyPolicy<ParsedTsunamiInfo>,
  VTSE51: tsunamiObservationPolicy("VTSE51"),
  VTSE52: tsunamiObservationPolicy("VTSE52"),
} as const;

const FRAGMENT_MERGE_ALLOWLIST = new Set<string>(FRAGMENT_MERGE_ALLOWLIST_KEYS);

export interface RevisionFamilyPolicyValidationShape {
  domain: string;
  revisionFamily: string;
  fragmentMerge: boolean;
  durable?: boolean;
  tombstoneRetentionMs?: number | null;
  maxSubjects?: number | null;
  fragmentAllowlistKey?: FragmentMergeAllowlistKey;
  extractItems?: unknown;
  itemSubjectKey?: unknown;
  itemFingerprint?: unknown;
  fingerprintVersion?: string;
  fragmentEvidence?: {
    corpusFixtures: readonly string[];
    regressionTests: readonly string[];
    rationale: string;
  };
}

export function validateRevisionFamilyPolicy(
  policy: RevisionFamilyPolicyValidationShape,
): void {
  const key = `${policy.domain}:${policy.revisionFamily}`;
  if (
    policy.durable === true
    && policy.tombstoneRetentionMs === null
    && policy.maxSubjects == null
  ) {
    throw new Error(`indefinite durable family requires bounded maxSubjects: ${key}`);
  }
  if (
    policy.maxSubjects == null
    || !Number.isSafeInteger(policy.maxSubjects)
    || policy.maxSubjects <= 0
    || policy.maxSubjects > TELEGRAM_REVISION_MAX_ENTRIES
  ) {
    throw new Error(`revision family maxSubjects is invalid: ${key}`);
  }
  if (!policy.fragmentMerge) return;
  if (policy.fragmentAllowlistKey !== key || !FRAGMENT_MERGE_ALLOWLIST.has(key)) {
    throw new Error(`fragmentMerge family is not allowlisted: ${key}`);
  }
  if (
    typeof policy.extractItems !== "function"
    || typeof policy.itemSubjectKey !== "function"
    || typeof policy.itemFingerprint !== "function"
    || policy.fingerprintVersion == null
    || policy.fingerprintVersion.trim() === ""
    || policy.fragmentEvidence == null
    || policy.fragmentEvidence.corpusFixtures.length === 0
    || policy.fragmentEvidence.regressionTests.length === 0
    || policy.fragmentEvidence.rationale.trim() === ""
  ) {
    throw new Error(`fragmentMerge evidence is incomplete: ${key}`);
  }
}

export function validateRevisionFamilyPolicies(
  policies: readonly RevisionFamilyPolicyValidationShape[],
): void {
  let indefiniteDurableSubjectBudget = 0;
  let totalSubjectBudget = 0;
  for (const policy of policies) {
    validateRevisionFamilyPolicy(policy);
    totalSubjectBudget += policy.maxSubjects ?? 0;
    if (policy.durable === true && policy.tombstoneRetentionMs === null) {
      indefiniteDurableSubjectBudget += policy.maxSubjects ?? 0;
    }
  }
  if (indefiniteDurableSubjectBudget > TELEGRAM_REVISION_MAX_ENTRIES) {
    throw new Error(
      `indefinite durable family maxSubjects total exceeds gate capacity: ${indefiniteDurableSubjectBudget}/${TELEGRAM_REVISION_MAX_ENTRIES}`,
    );
  }
  if (totalSubjectBudget > TELEGRAM_REVISION_MAX_ENTRIES) {
    throw new Error(
      `revision family maxSubjects total exceeds gate capacity: ${totalSubjectBudget}/${TELEGRAM_REVISION_MAX_ENTRIES}`,
    );
  }
}

export const EEW_REVISION_FAMILY_POLICIES = {
  VXSE43: eewPolicy("VXSE43"),
  VXSE44: eewPolicy("VXSE44"),
  VXSE45: eewPolicy("VXSE45"),
} as const;

export const ALL_REVISION_FAMILY_POLICIES = [
  ...Object.values(EEW_REVISION_FAMILY_POLICIES),
  VPWS50_REVISION_FAMILY_POLICY,
  VPWW56_REVISION_FAMILY_POLICY,
  ...Object.values(TSUNAMI_REVISION_FAMILY_POLICIES),
  VOLCANO_ALERT_REVISION_FAMILY_POLICY,
  VOLCANO_ERUPTION_REVISION_FAMILY_POLICY,
  VOLCANO_ASHFALL_REVISION_FAMILY_POLICY,
  VOLCANO_TRANSIENT_REVISION_FAMILY_POLICY,
  FLOOD_FORECAST_REVISION_FAMILY_POLICY,
  TORNADO_REVISION_FAMILY_POLICY,
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
  TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  NANKAI_INFORMATION_REVISION_FAMILY_POLICY,
  WEATHER_TIMESERIES_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
  EARTHQUAKE_REVISION_FAMILY_POLICY,
  SEISMIC_TEXT_REVISION_FAMILY_POLICY,
  BRIEFING_REVISION_FAMILY_POLICY,
  EARLY_WEATHER_REVISION_FAMILY_POLICY,
  CLIMATE_INFO_REVISION_FAMILY_POLICY,
  WEATHER_EXPLANATION_REVISION_FAMILY_POLICY,
  TRANSIENT_WEATHER_REVISION_FAMILY_POLICY,
  LEGACY_COUNTERPART_REVISION_FAMILY_POLICY,
  RAW_REVISION_FAMILY_POLICY,
] as const;

validateRevisionFamilyPolicies(ALL_REVISION_FAMILY_POLICIES);

/**
 * Broad route matcher で到達した head.type が、その route 固有の明示 policy を持つかを検証する。
 * raw の `*` は未知型の fallback 専用であり、他 route の網羅根拠には数えない。
 */
export function routeHasExplicitRevisionFamilyPolicy(route: Route, headType: string): boolean {
  switch (route) {
    case "raw": return true;
    case "ignore": return false;
    case "eew": return eewRevisionFamilyPolicy(headType) != null;
    case "tsunami": return tsunamiRevisionFamilyPolicy(headType) != null;
    case "volcano": return volcanoRevisionFamilyPolicy(headType) != null;
    case "weather": return weatherRevisionFamilyPolicy(headType) != null;
    case "floodForecast": return floodForecastRevisionFamilyPolicy(headType) != null;
    default:
      return ALL_REVISION_FAMILY_POLICIES.some(
        (policy) => policy.domain === route && policy.headTypes.includes(headType),
      );
  }
}

export function eewRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedEewInfo> | null {
  return Object.hasOwn(EEW_REVISION_FAMILY_POLICIES, headType)
    ? EEW_REVISION_FAMILY_POLICIES[
        headType as keyof typeof EEW_REVISION_FAMILY_POLICIES
      ]
    : null;
}

export function tsunamiRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedTsunamiInfo, TsunamiObservationStation> | null {
  return Object.hasOwn(TSUNAMI_REVISION_FAMILY_POLICIES, headType)
    ? TSUNAMI_REVISION_FAMILY_POLICIES[
        headType as keyof typeof TSUNAMI_REVISION_FAMILY_POLICIES
      ]
    : null;
}

export function weatherRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedWeatherWarning> | null {
  if (VPWS50_REVISION_FAMILY_POLICY.headTypes.includes(headType)) return VPWS50_REVISION_FAMILY_POLICY;
  if (headType === "VPWW56") return VPWW56_REVISION_FAMILY_POLICY;
  if (TRANSIENT_WEATHER_REVISION_FAMILY_POLICY.headTypes.includes(headType)) {
    return TRANSIENT_WEATHER_REVISION_FAMILY_POLICY;
  }
  return null;
}

export function volcanoRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedVolcanoInfo> | null {
  if (VOLCANO_ALERT_REVISION_FAMILY_POLICY.headTypes.includes(headType)) {
    return VOLCANO_ALERT_REVISION_FAMILY_POLICY;
  }
  if (VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.headTypes.includes(headType)) {
    return VOLCANO_ERUPTION_REVISION_FAMILY_POLICY;
  }
  if (VOLCANO_ASHFALL_REVISION_FAMILY_POLICY.headTypes.includes(headType)) {
    return VOLCANO_ASHFALL_REVISION_FAMILY_POLICY;
  }
  if (VOLCANO_TRANSIENT_REVISION_FAMILY_POLICY.headTypes.includes(headType)) {
    return VOLCANO_TRANSIENT_REVISION_FAMILY_POLICY;
  }
  return null;
}

export function floodForecastRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedFloodForecastInfo> | null {
  return FLOOD_FORECAST_HEAD_TYPES.includes(headType)
    ? FLOOD_FORECAST_REVISION_FAMILY_POLICY
    : null;
}
