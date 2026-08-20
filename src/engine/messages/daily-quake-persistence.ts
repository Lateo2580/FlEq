import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import { intensityToRank } from "../../utils/intensity";
import type { JmaIntensity, SpecialValue, SpecialValueDiagnostic } from "../../types";
import type {
  DisplayIntensityGroupV1,
  DisplayIntensitySemanticV1,
  DisplayRecentQuakeV1,
} from "../display/types";
import {
  isProjectedIntensitySemantic,
  projectIntensitySemantic,
} from "../display/intensity-groups";
import {
  hasResolvedQuakeCancellation,
  quakeObservationMetaOf,
  withQuakeObservationMeta,
  type QuakeObservationMeta,
} from "../display/quake-observation-merge";
import {
  depthValueFromDisplaySemantic,
  depthSemanticFromLegacyScalar,
  magnitudeSemanticFromLegacyScalar,
  normalizeNumericSpecialValueForPersistence,
  parsePersistedDepthSpecialValue,
  parsePersistedNumericSpecialValue,
  parsePersistedDepthSemantic,
  parsePersistedMagnitudeSemantic,
} from "../magnitude-depth-persistence";
import { isShallowDepthSpecialValue } from "../../utils/magnitude";
import {
  projectDepthSemantic,
  projectMagnitudeSemantic,
} from "../display/magnitude-depth-semantic";
import type { DailyQuakePersistedV1 } from "./daily-quake-counter";

const PERSIST_SCHEMA_VERSION = 2;
const LEGACY_PERSIST_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 3000;

interface PersistedDailyQuakeV2 {
  version: typeof PERSIST_SCHEMA_VERSION;
  savedAt: string;
  state: unknown;
}

/** 当日地震カウンタと履歴を一つの原子的 JSON として保存する。 */
export class DailyQuakePersistence {
  private pending: DailyQuakePersistedV1 | null = null;
  private pendingNowMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath: string, private readonly debounceMs = SAVE_DEBOUNCE_MS) {}

  load(nowMs: number): DailyQuakePersistedV1 | null {
    try {
      if (!fs.existsSync(this.persistPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
      if (!isRecord(parsed)) return this.invalid("top-level structure validation 失敗");
      if (parsed.version !== PERSIST_SCHEMA_VERSION && parsed.version !== LEGACY_PERSIST_SCHEMA_VERSION) {
        return this.invalid(`unknown version: ${String(parsed.version)}`);
      }
      if (typeof parsed.savedAt !== "string") return this.invalid("savedAt が不正");
      const savedAtMs = Date.parse(parsed.savedAt);
      if (!Number.isFinite(savedAtMs) || savedAtMs > nowMs) return this.invalid("savedAt が不正または未来");
      const state = parseState(parsed.state, nowMs, parsed.version);
      if (state == null) return this.invalid("state structure validation 失敗");
      return state;
    } catch (err) {
      log.warn(`[daily-quake-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  schedule(state: DailyQuakePersistedV1, nowMs: number): void {
    this.pending = state;
    this.pendingNowMs = nowMs;
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pending;
      const pendingNowMs = this.pendingNowMs;
      this.pending = null;
      this.pendingNowMs = null;
      if (pending != null && pendingNowMs != null) this.save(pending, pendingNowMs);
    }, this.debounceMs);
    this.timer.unref();
  }

  save(state: DailyQuakePersistedV1, nowMs: number): void {
    const data: PersistedDailyQuakeV2 = {
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      state: serializeState(state),
    };
    const tmpPath = `${this.persistPath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
      fs.renameSync(tmpPath, this.persistPath);
    } catch (err) {
      log.warn(`[daily-quake-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.pendingNowMs = null;
  }

  private invalid(reason: string): null {
    log.warn(`[daily-quake-persistence] ${reason} — 破棄`);
    return null;
  }
}

function serializeState(state: DailyQuakePersistedV1): unknown {
  return {
    ...state,
    recentQuakes: state.recentQuakes.map((quake) => ({
      ...quake,
      magnitudeSemantic: quake.magnitudeSemantic
        ?? magnitudeSemanticFromLegacyScalar(quake.magnitude),
      depthSemantic: quake.depthSemantic
        ?? depthSemanticFromLegacyScalar(quake.depth),
      intensityGroups: quake.intensityGroups?.map((group) => ({
        ...group,
        ...(group.intensitySemantic == null
          ? {}
          : { intensitySemantic: { ...group.intensitySemantic } }),
        areas: [...group.areas],
        ...(group.expandedAreas == null ? {} : { expandedAreas: [...group.expandedAreas] }),
      })),
      observation: serializeObservationMeta(
        quakeObservationMetaOf(quake) ?? legacyObservationMeta(quake),
      ),
    })),
  };
}

function serializeObservationMeta(meta: QuakeObservationMeta): QuakeObservationMeta {
  return {
    ...meta,
    ...(meta.magnitudeValue == null
      ? {}
      : { magnitudeValue: normalizeNumericSpecialValueForPersistence(meta.magnitudeValue) }),
    ...(meta.depthValue == null
      ? {}
      : { depthValue: normalizeNumericSpecialValueForPersistence(meta.depthValue) }),
  };
}

function parseState(
  value: unknown,
  nowMs: number,
  version: typeof PERSIST_SCHEMA_VERSION | typeof LEGACY_PERSIST_SCHEMA_VERSION,
): DailyQuakePersistedV1 | null {
  if (!isRecord(value) || typeof value.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.dayKey) ||
      !isNonNegativeSafeInteger(value.count) || (value.maxInt != null && typeof value.maxInt !== "string") ||
      !isNonNegativeSafeInteger(value.maxIntRank) || !Array.isArray(value.countedEventIds) ||
      !value.countedEventIds.every((id): id is string => typeof id === "string" && id !== "") ||
      !Array.isArray(value.recentQuakes)) return null;
  const countedEventIds = [...new Set(value.countedEventIds)];
  // count は EventID なしの地震も含み得るため Set サイズ以上なら正しい。一方、Set の方が大きい
  // 状態を復元すると、その EventID の続報が dedupe されて count が永久に追いつかない。
  if (countedEventIds.length !== value.countedEventIds.length || value.count < countedEventIds.length) return null;
  // Counter が生成できる組合せだけを受理する。maxInt は rank > 0 の更新時にだけセットされる。
  if (value.maxInt == null) {
    if (value.maxIntRank !== 0) return null;
  } else {
    const rank = intensityToRank(value.maxInt);
    if (value.count === 0 || rank <= 0 || value.maxIntRank !== rank) return null;
  }
  // recent entry は EventID 単位で salvage し、一件の破損で同日 counter 全体を捨てない。
  const recentQuakes = value.recentQuakes
    .map((quake) => parseRecentQuake(quake, nowMs, version))
    .filter((quake): quake is DisplayRecentQuakeV1 => quake != null);
  return {
    dayKey: value.dayKey,
    count: value.count,
    maxInt: value.maxInt ?? null,
    maxIntRank: value.maxIntRank,
    countedEventIds,
    recentQuakes,
  };
}

function parseRecentQuake(
  value: unknown,
  nowMs: number,
  version: typeof PERSIST_SCHEMA_VERSION | typeof LEGACY_PERSIST_SCHEMA_VERSION,
): DisplayRecentQuakeV1 | null {
  if (!isRecord(value) || !isNullableString(value.eventId) || typeof value.reportDateTime !== "string" ||
      !isNullableString(value.originTime) || !isNullableString(value.hypocenterName) ||
      !isNullableString(value.magnitude) || !isNullableString(value.maxInt) ||
      !isNullableSafeInteger(value.maxIntRank) || !isNullableString(value.depth) ||
      typeof value.tsunamiWarning !== "boolean") return null;
  const times = [value.reportDateTime, value.originTime].filter((time): time is string => time != null);
  if (!times.every((time) => Number.isFinite(Date.parse(time)) && Date.parse(time) <= nowMs)) return null;
  const intensityGroups = value.intensityGroups == null ? undefined : parseIntensityGroups(value.intensityGroups);
  if (value.intensityGroups != null && intensityGroups == null) return null;
  const hasMaxIntSemantic = Object.hasOwn(value, "maxIntSemantic");
  const persistedMaxIntSemantic = !hasMaxIntSemantic
    ? undefined
    : value.maxIntSemantic == null
      ? null
      : parseIntensitySemantic(value.maxIntSemantic);
  if (hasMaxIntSemantic && persistedMaxIntSemantic == null) return null;
  const hasMagnitudeSemantic = Object.hasOwn(value, "magnitudeSemantic");
  const persistedMagnitudeSemantic = hasMagnitudeSemantic
    ? parsePersistedMagnitudeSemantic(value.magnitudeSemantic)
    : magnitudeSemanticFromLegacyScalar(value.magnitude as string | null);
  const hasDepthSemantic = Object.hasOwn(value, "depthSemantic");
  const persistedDepthSemantic = hasDepthSemantic
    ? parsePersistedDepthSemantic(value.depthSemantic)
    : depthSemanticFromLegacyScalar(value.depth as string | null);
  let quake: DisplayRecentQuakeV1 = {
    eventId: value.eventId as string | null,
    reportDateTime: value.reportDateTime,
    originTime: value.originTime as string | null,
    hypocenterName: value.hypocenterName as string | null,
    magnitude: value.magnitude as string | null,
    maxInt: value.maxInt as string | null,
    maxIntRank: value.maxIntRank as number | null,
    depth: value.depth as string | null,
    tsunamiWarning: value.tsunamiWarning,
    intensityGroups: intensityGroups ?? undefined,
  };
  const observation = version === PERSIST_SCHEMA_VERSION
    ? parseObservationMeta(value.observation)
    : legacyObservationMeta(quake);
  if (
    version === LEGACY_PERSIST_SCHEMA_VERSION
    && observation != null
    && observation.maxIntValue.presence !== "value"
  ) {
    quake = { ...quake, maxInt: null, maxIntRank: null };
  }
  if (observation == null || !observationMatchesScalar(quake, observation)) return null;
  const magnitudeValue = observation.magnitudeValue;
  const restoredDepthValue = persistedDepthSemantic == null
    ? undefined
    : depthValueFromDisplaySemantic(persistedDepthSemantic) ?? undefined;
  const depthValue = observation.depthValue
    ?? (restoredDepthValue != null && isShallowDepthSpecialValue(restoredDepthValue)
      ? restoredDepthValue
      : undefined);
  const migratedObservation: QuakeObservationMeta = {
    ...observation,
    ...(magnitudeValue == null ? {} : { magnitudeValue }),
    ...(depthValue == null ? {} : { depthValue }),
  };
  const magnitudeSemantic = magnitudeValue == null
    ? persistedMagnitudeSemantic
    : projectMagnitudeSemantic(magnitudeValue);
  const depthSemantic = depthValue == null
    ? persistedDepthSemantic
    : projectDepthSemantic(depthValue);
  if (magnitudeSemantic == null || depthSemantic == null) return null;
  quake = { ...quake, magnitudeSemantic, depthSemantic };
  const projectedSemantic = projectIntensitySemantic(observation.maxIntValue, quake.maxInt);
  if (projectedSemantic == null) return null;
  const expectedMaxIntSemantic = projectedSemantic.presence === "value"
    ? undefined
    : projectedSemantic;
  if (
    persistedMaxIntSemantic != null
    && (expectedMaxIntSemantic == null
      || !sameIntensitySemantic(persistedMaxIntSemantic, expectedMaxIntSemantic))
  ) return null;
  if (expectedMaxIntSemantic != null) quake = { ...quake, maxIntSemantic: expectedMaxIntSemantic };
  return withQuakeObservationMeta(quake, migratedObservation);
}

const CANONICAL_INTENSITIES = new Set<JmaIntensity>([
  "0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7",
]);

function canonicalIntensity(value: string): JmaIntensity | null {
  const normalized = value.replace(/\s+/g, "");
  const canonical = ({
    "5弱": "5-", "5強": "5+", "6弱": "6-", "6強": "6+",
  } as const)[normalized as "5弱" | "5強" | "6弱" | "6強"] ?? normalized;
  return CANONICAL_INTENSITIES.has(canonical as JmaIntensity)
    ? canonical as JmaIntensity
    : null;
}

function legacyObservationMeta(quake: DisplayRecentQuakeV1): QuakeObservationMeta {
  const canonical = quake.maxInt == null ? null : canonicalIntensity(quake.maxInt);
  const maxIntValue: SpecialValue<JmaIntensity> = quake.maxInt == null
    ? {
        raw: null,
        value: null,
        condition: null,
        description: null,
        presence: "unknown",
        diagnostics: ["legacyNullUnknown"],
      }
    : canonical != null
      ? {
          raw: quake.maxInt,
          value: canonical,
          condition: null,
          description: null,
          presence: "value",
        }
      : {
          raw: quake.maxInt,
          value: null,
          condition: null,
          description: null,
          presence: quake.maxInt.trim() === "" ? "empty" : "unknown",
        };
  return {
    sourceType: null,
    observationSourceType: null,
    infoType: null,
    resolvedTrigger: null,
    cancellationPolicy: null,
    intensityStructureMissing: false,
    maxIntValue,
  };
}

function parseObservationMeta(value: unknown): QuakeObservationMeta | null {
  if (
    !isRecord(value)
    || !Object.hasOwn(value, "sourceType")
    || !Object.hasOwn(value, "observationSourceType")
    || !Object.hasOwn(value, "infoType")
    || !Object.hasOwn(value, "resolvedTrigger")
    || !Object.hasOwn(value, "cancellationPolicy")
    || !Object.hasOwn(value, "intensityStructureMissing")
    || !Object.hasOwn(value, "maxIntValue")
    || !isNullableNonEmptyString(value.sourceType)
    || !isNullableNonEmptyString(value.observationSourceType)
    || !isNullableString(value.infoType)
    || !isNullableCancellationTrigger(value.resolvedTrigger)
    || !isNullableCancellationPolicy(value.cancellationPolicy)
    || typeof value.intensityStructureMissing !== "boolean"
    || value.resolvedTrigger != null && value.cancellationPolicy == null
  ) return null;
  const maxIntValue = parseIntensitySpecialValue(value.maxIntValue);
  if (maxIntValue == null) return null;
  const hasMagnitudeValue = Object.hasOwn(value, "magnitudeValue");
  const magnitudeValue = hasMagnitudeValue
    ? parsePersistedNumericSpecialValue(value.magnitudeValue)
    : undefined;
  const hasDepthValue = Object.hasOwn(value, "depthValue");
  const depthValue = hasDepthValue
    ? parsePersistedDepthSpecialValue(value.depthValue)
    : undefined;
  if ((hasMagnitudeValue && magnitudeValue == null) || (hasDepthValue && depthValue == null)) {
    return null;
  }
  return {
    sourceType: value.sourceType,
    observationSourceType: value.observationSourceType,
    infoType: value.infoType as string | null,
    resolvedTrigger: value.resolvedTrigger,
    cancellationPolicy: value.cancellationPolicy,
    intensityStructureMissing: value.intensityStructureMissing,
    maxIntValue,
    ...(magnitudeValue == null ? {} : { magnitudeValue }),
    ...(depthValue == null ? {} : { depthValue }),
  };
}

function parseIntensitySpecialValue(value: unknown): SpecialValue<JmaIntensity> | null {
  if (
    !isRecord(value)
    || !Object.hasOwn(value, "raw")
    || !Object.hasOwn(value, "value")
    || !Object.hasOwn(value, "condition")
    || !Object.hasOwn(value, "description")
    || !Object.hasOwn(value, "presence")
    || !isNullableString(value.raw)
    || !isNullableIntensity(value.value)
    || !isNullableString(value.condition)
    || !isNullableString(value.description)
    || !["value", "missing", "empty", "unknown", "qualitative", "range"].includes(
      typeof value.presence === "string" ? value.presence : "",
    )
  ) return null;
  if (Object.hasOwn(value, "lowerBound") && !isNullableIntensity(value.lowerBound)) return null;
  if (Object.hasOwn(value, "upperBound") && !isNullableIntensity(value.upperBound)) return null;
  if (Object.hasOwn(value, "rawLowerBound") && !isNullableString(value.rawLowerBound)) return null;
  if (Object.hasOwn(value, "rawUpperBound") && !isNullableString(value.rawUpperBound)) return null;
  const diagnostics = value.diagnostics == null ? undefined : parseDiagnostics(value.diagnostics);
  if (value.diagnostics != null && diagnostics == null) return null;
  const parsed: SpecialValue<JmaIntensity> = {
    raw: value.raw as string | null,
    value: value.value as JmaIntensity | null,
    condition: value.condition as string | null,
    description: value.description as string | null,
    presence: value.presence as SpecialValue<JmaIntensity>["presence"],
    ...(Object.hasOwn(value, "lowerBound")
      ? { lowerBound: value.lowerBound as JmaIntensity | null }
      : {}),
    ...(Object.hasOwn(value, "upperBound")
      ? { upperBound: value.upperBound as JmaIntensity | null }
      : {}),
    ...(Object.hasOwn(value, "rawLowerBound")
      ? { rawLowerBound: value.rawLowerBound as string | null }
      : {}),
    ...(Object.hasOwn(value, "rawUpperBound")
      ? { rawUpperBound: value.rawUpperBound as string | null }
      : {}),
    ...(diagnostics == null ? {} : { diagnostics }),
  };
  return isValidIntensitySpecialValue(parsed) ? parsed : null;
}

function parseDiagnostics(value: unknown): SpecialValueDiagnostic[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is SpecialValueDiagnostic =>
    item === "unmappedSpecialValue"
    || item === "specialValueConflict"
    || item === "legacyNullUnknown")) return null;
  return [...value];
}

function isValidIntensitySpecialValue(value: SpecialValue<JmaIntensity>): boolean {
  const hasLower = Object.hasOwn(value, "lowerBound");
  const hasUpper = Object.hasOwn(value, "upperBound");
  const hasCanonicalBounds = hasLower || hasUpper;
  const hasRawLower = Object.hasOwn(value, "rawLowerBound");
  const hasRawUpper = Object.hasOwn(value, "rawUpperBound");
  if (hasRawLower !== hasRawUpper) return false;
  if (value.presence === "value" ? value.value == null : value.value != null) return false;
  if (value.presence === "missing") {
    return value.raw == null
      && value.condition == null
      && value.description == null
      && !hasCanonicalBounds
      && !hasRawLower;
  }
  if (value.presence === "value") return value.raw != null && !hasCanonicalBounds;
  if (value.presence === "empty") {
    return value.raw != null && value.raw.trim() === "" && !hasCanonicalBounds && !hasRawLower;
  }
  if (value.presence === "range") {
    return value.raw != null
      && (hasLower && value.lowerBound != null || hasUpper && value.upperBound != null);
  }
  if (value.presence === "qualitative") return value.raw != null;
  const legacyNull = value.diagnostics?.includes("legacyNullUnknown") === true;
  return (value.raw != null || legacyNull) && !hasCanonicalBounds;
}

function observationMatchesScalar(
  quake: DisplayRecentQuakeV1,
  observation: QuakeObservationMeta,
): boolean {
  const specialValue = observation.maxIntValue;
  if (specialValue.presence === "value") {
    const exactValue = specialValue.value;
    if (
      exactValue == null
      || quake.maxInt == null
      || quake.maxIntRank == null
      || canonicalIntensity(quake.maxInt) !== exactValue
      || intensityToRank(exactValue) !== quake.maxIntRank
    ) return false;
  } else if (quake.maxInt != null || quake.maxIntRank != null) {
    return false;
  }
  if (!isValidObservationProvenance(observation)) return false;
  if (observation.intensityStructureMissing) {
    return specialValue.presence === "missing"
      && observation.sourceType != null
      && observation.observationSourceType === observation.sourceType;
  }
  if (observation.sourceType == null) {
    // v1 migration の provenance 不明値。判別不能な missing は生成しない。
    return observation.observationSourceType == null && specialValue.presence !== "missing";
  }
  return true;
}

function isValidObservationProvenance(observation: QuakeObservationMeta): boolean {
  const current = observation.sourceType;
  const observed = observation.observationSourceType;
  if (current == null || observed == null) return current == null && observed == null;
  if (hasResolvedQuakeCancellation(observation)) {
    return !observation.intensityStructureMissing
      && observation.maxIntValue.presence !== "missing";
  }
  if (current === observed) return true;
  return (current === "VXSE52" || current === "VXSE61")
    && observed === "VXSE51"
    && !observation.intensityStructureMissing
    && observation.maxIntValue.presence === "value";
}

function isNullableCancellationTrigger(value: unknown): value is QuakeObservationMeta["resolvedTrigger"] {
  return value == null
    || value === "explicitCancellation"
    || value === "terminal"
    || value === "deactivation";
}

function isNullableCancellationPolicy(value: unknown): value is QuakeObservationMeta["cancellationPolicy"] {
  return value == null
    || value === "restorePrevious"
    || value === "clearCurrent"
    || value === "markCancelled";
}

function isNullableIntensity(value: unknown): value is JmaIntensity | null {
  return value == null || (typeof value === "string" && CANONICAL_INTENSITIES.has(value as JmaIntensity));
}

function parseIntensityGroups(value: unknown): DisplayIntensityGroupV1[] | null {
  if (!Array.isArray(value)) return null;
  const result: DisplayIntensityGroupV1[] = [];
  for (const group of value) {
    if (!isRecord(group) || typeof group.intensity !== "string" || !isDisplayIntensityRank(group.rank) ||
        !Array.isArray(group.areas) || !group.areas.every((area): area is string => typeof area === "string") ||
        !isNonNegativeSafeInteger(group.omittedAreaCount)) return null;
    const hasIntensitySemantic = Object.hasOwn(group, "intensitySemantic");
    const intensitySemantic = !hasIntensitySemantic
      ? undefined
      : group.intensitySemantic == null
        ? null
        : parseIntensitySemantic(group.intensitySemantic);
    if (hasIntensitySemantic && intensitySemantic == null) return null;
    const hasExpandedAreas = Object.hasOwn(group, "expandedAreas");
    const expandedAreas = !hasExpandedAreas
      ? undefined
      : Array.isArray(group.expandedAreas)
        && group.expandedAreas.every((area): area is string => typeof area === "string")
        ? [...group.expandedAreas]
        : null;
    if (hasExpandedAreas && expandedAreas == null) return null;
    const hasCandidateTruncated = Object.hasOwn(group, "candidateTruncated");
    const candidateTruncated = !hasCandidateTruncated
      ? undefined
      : typeof group.candidateTruncated === "boolean"
        ? group.candidateTruncated
        : null;
    if (hasCandidateTruncated && candidateTruncated == null) return null;
    if (
      intensitySemantic == null
        ? group.rank < 0
        : !intensitySemantic.render
          || intensitySemantic.presence === "missing"
          || intensitySemantic.label !== group.intensity
          || group.rank !== (intensitySemantic.colorRank ?? -1)
    ) return null;
    result.push({
      intensity: group.intensity,
      rank: group.rank,
      ...(intensitySemantic == null ? {} : { intensitySemantic }),
      areas: [...group.areas],
      omittedAreaCount: group.omittedAreaCount,
      ...(expandedAreas == null ? {} : { expandedAreas }),
      ...(candidateTruncated == null ? {} : { candidateTruncated }),
    });
  }
  return result;
}

const SPECIAL_VALUE_PRESENCES = new Set([
  "value", "missing", "empty", "unknown", "qualitative", "range",
]);
const INTENSITY_BADGES = new Set([null, "≥", "↔", "?", "∅"]);
const INTENSITY_COLORS = new Set([
  "normalRank", "safetyRank", "safetyUpperRank", "unknown", "neutral", "notRendered",
]);

function parseIntensitySemantic(value: unknown): DisplayIntensitySemanticV1 | null {
  if (!isRecord(value)) return null;
  const required = [
    "raw", "presence", "label", "condition", "description", "lowerBound", "upperBound",
    "rawLowerBound", "rawUpperBound", "badge", "color", "render", "safetyLowerRank",
    "safetyUpperRank", "safetyRank", "colorRank",
  ];
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (
    !isNullableString(value.raw)
    || typeof value.presence !== "string" || !SPECIAL_VALUE_PRESENCES.has(value.presence)
    || !isNullableString(value.label)
    || !isNullableString(value.condition)
    || !isNullableString(value.description)
    || !isNullableString(value.lowerBound)
    || !isNullableString(value.upperBound)
    || !isNullableString(value.rawLowerBound)
    || !isNullableString(value.rawUpperBound)
    || !INTENSITY_BADGES.has(value.badge as string | null)
    || typeof value.color !== "string" || !INTENSITY_COLORS.has(value.color)
    || typeof value.render !== "boolean"
    || !isNullableIntensityRank(value.safetyLowerRank)
    || !isNullableIntensityRank(value.safetyUpperRank)
    || !isNullableIntensityRank(value.safetyRank)
    || !isNullableIntensityRank(value.colorRank)
  ) return null;
  const parsed: DisplayIntensitySemanticV1 = {
    raw: value.raw as string | null,
    presence: value.presence as DisplayIntensitySemanticV1["presence"],
    label: value.label as string | null,
    condition: value.condition as string | null,
    description: value.description as string | null,
    lowerBound: value.lowerBound as string | null,
    upperBound: value.upperBound as string | null,
    rawLowerBound: value.rawLowerBound as string | null,
    rawUpperBound: value.rawUpperBound as string | null,
    badge: value.badge as DisplayIntensitySemanticV1["badge"],
    color: value.color as DisplayIntensitySemanticV1["color"],
    render: value.render,
    safetyLowerRank: value.safetyLowerRank as number | null,
    safetyUpperRank: value.safetyUpperRank as number | null,
    safetyRank: value.safetyRank as number | null,
    colorRank: value.colorRank as number | null,
  };
  return isProjectedIntensitySemantic(parsed) ? parsed : null;
}

function sameIntensitySemantic(
  left: DisplayIntensitySemanticV1,
  right: DisplayIntensitySemanticV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isDisplayIntensityRank(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && value <= 9;
}

function isNullableIntensityRank(value: unknown): value is number | null {
  return value == null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 9;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value == null || isNonNegativeSafeInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value == null || (typeof value === "string" && value.trim() !== "");
}
