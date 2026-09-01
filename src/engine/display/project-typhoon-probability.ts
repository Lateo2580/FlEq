import type {
  ParsedTyphoonProbability,
  TelegramMeta,
  TyphoonProbRegion,
} from "../../types";
import type { StandbyRevision } from "./standby-registry";

export const TYPHOON_PROBABILITY_MAX_SUBJECTS = 256;
export const TYPHOON_PROBABILITY_READER_MAX_RAW_ITEMS = 1024;
export const TYPHOON_PROBABILITY_READER_MAX_RAW_BUNDLES = 1024;
export const TYPHOON_PROBABILITY_MAX_TOP_PREFECTURES = 5;
export const TYPHOON_PROBABILITY_MAX_ACTIVE_PREFECTURES = 600;
export const TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH = 128;
export const TYPHOON_PROBABILITY_MAX_SOURCE_ID_LENGTH = 256;
export const TYPHOON_PROBABILITY_MAX_CODE_LENGTH = 32;
export const TYPHOON_PROBABILITY_MAX_NAME_LENGTH = 128;
export const TYPHOON_PROBABILITY_MAX_REMARK_LENGTH = 256;
export const TYPHOON_PROBABILITY_MAX_SEMANTIC_KEY_LENGTH = 1024;
export const TYPHOON_PROBABILITY_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const TYPHOON_PROBABILITY_ACCEPTED_AT_FUTURE_SKEW_MS = 15 * 60_000;
export const TYPHOON_PROBABILITY_REPORT_FUTURE_SKEW_MS = 15 * 60_000;

const HOUR_MS = 60 * 60_000;
const MAX_SLOT_MS = 24 * HOUR_MS;
const MAX_SPAN_MS = 120 * HOUR_MS;
const DATE_MIN_MS = -8_640_000_000_000_000;
const DATE_MAX_MS = 8_640_000_000_000_000;

export type CanonicalVptaInfoType = "発表" | "訂正" | "取消";

export type NormalizedVpta50Serial =
  | { kind: "missing" }
  | { kind: "numeric"; numeric: number; canonicalRaw: string }
  | { kind: "invalid" };

export type VptaProjectionFailureReason =
  | "compactOnly"
  | "invalidBaseTime"
  | "invalidTimeDefine"
  | "duplicateTimeId"
  | "nonContiguousTimeId"
  | "invalidDuration"
  | "slotGapOrOverlap"
  | "forecastSpanExceeded"
  | "invalidRegionCount"
  | "invalidRegionIdentity"
  | "duplicateAreaCode"
  | "prefectureIdentityConflict"
  | "invalidDaily"
  | "seriesLengthMismatch"
  | "invalidSeries"
  | "parserDuplicateDiagnostic"
  | "noActiveProbability";

export interface TyphoonProbabilitySlot {
  timeId: number;
  startsAtMs: number;
  endsAtMs: number;
}

export interface TyphoonProbabilityPrefectureState {
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
}

export interface TyphoonProbabilityWorstAreaState {
  areaCode: string;
  areaName: string;
  prefectureCode: string;
  prefectureName: string;
  fiveDayProbability: number;
  peakAtMs: number | null;
}

export interface TyphoonProbabilityState {
  eventId: string;
  sourceEventId: string;
  identity: {
    name: string | null;
    nameKana: string | null;
    remark: string | null;
    typhoonNumber: string | null;
  };
  baseTimeMs: number;
  maxFiveDayProbability: number;
  activePrefectureCount: number;
  topPrefectures: TyphoonProbabilityPrefectureState[];
  worstArea: TyphoonProbabilityWorstAreaState;
  revision: StandbyRevision;
  appliedSemanticKey: string;
  expiresAtMs: number;
  restored: boolean;
}

export type TyphoonProbabilityActiveCandidate = Omit<
  TyphoonProbabilityState,
  "revision" | "appliedSemanticKey" | "restored"
>;

export type TyphoonProbabilityCandidateResult =
  | { kind: "active"; candidate: TyphoonProbabilityActiveCandidate }
  | { kind: "deactivateAllZero" }
  | { kind: "cancel" }
  | { kind: "expired" }
  | { kind: "nonProjectable"; reason: VptaProjectionFailureReason };

export interface TyphoonProbabilityCandidateClassification {
  nowMs: number;
  canonicalInfoType: CanonicalVptaInfoType;
  result: TyphoonProbabilityCandidateResult;
}

export type FinalizedTyphoonProbabilityResult =
  | { kind: "active"; state: TyphoonProbabilityState }
  | Exclude<TyphoonProbabilityCandidateResult, { kind: "active" }>;

export interface FinalizedTyphoonProbabilityClassification {
  nowMs: number;
  canonicalInfoType: CanonicalVptaInfoType;
  result: FinalizedTyphoonProbabilityResult;
  acceptedRevision: StandbyRevision;
  appliedSemanticKey: string;
}

export type CanonicalVptaInfoTypeResult =
  | { kind: "canonical"; value: CanonicalVptaInfoType }
  | { kind: "invalid"; reason: "invalidRevision" | "infoTypeMismatch" };

function isCanonicalInfoType(value: unknown): value is CanonicalVptaInfoType {
  return value === "発表" || value === "訂正" || value === "取消";
}

/** Envelope meta と decoded XML の InfoType を一つの厳密値へ束縛する。 */
export function canonicalizeVptaInfoType(
  meta: TelegramMeta,
  decodedInfoType: string,
): CanonicalVptaInfoTypeResult {
  if (
    !meta.infoType.valid
    || !isCanonicalInfoType(meta.infoType.raw)
    || meta.infoType.value !== meta.infoType.raw
  ) return { kind: "invalid", reason: "invalidRevision" };
  if (decodedInfoType !== meta.infoType.raw) {
    return { kind: "invalid", reason: "infoTypeMismatch" };
  }
  return { kind: "canonical", value: meta.infoType.raw };
}

/** VPTA50 の live / migration / dual-write 共通 serial normalization。 */
export function normalizeVpta50Serial(raw: string | null): NormalizedVpta50Serial {
  if (raw == null || raw === "") return { kind: "missing" };
  if (!/^\d+$/u.test(raw)) return { kind: "invalid" };
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric)) return { kind: "invalid" };
  return { kind: "numeric", numeric, canonicalRaw: String(numeric) };
}

export function validateTyphoonProbabilityEventId(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  return value.length >= 1 && value.length <= TYPHOON_PROBABILITY_MAX_EVENT_ID_LENGTH
    ? value
    : null;
}

function validDateEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= DATE_MIN_MS && value <= DATE_MAX_MS;
}

export function validateVptaClassificationClock(value: number): boolean {
  return validDateEpoch(value);
}

function parseOffsetDateTime(value: string | null): number | null {
  if (value == null
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return validDateEpoch(parsed) ? parsed : null;
}

function parseFixedDurationMs(value: string): number | null {
  // Calendar units (years/months), weeks, signs and fractions are rejected.
  // Days are fixed-length here and remain bounded by the per-slot 24 hour cap.
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(value);
  if (match == null || value.endsWith("T")
    || match[1] == null && match[2] == null && match[3] == null && match[4] == null) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (![days, hours, minutes, seconds].every(Number.isSafeInteger)) return null;
  const duration = days * 24 * HOUR_MS + hours * HOUR_MS + minutes * 60_000 + seconds * 1000;
  return Number.isSafeInteger(duration) && duration > 0 && duration <= MAX_SLOT_MS
    ? duration
    : null;
}

type SlotResult =
  | { kind: "ok"; baseTimeMs: number; slots: TyphoonProbabilitySlot[]; expiresAtMs: number }
  | { kind: "failed"; reason: VptaProjectionFailureReason };

function buildSlots(parsed: ParsedTyphoonProbability): SlotResult {
  const baseTimeMs = parseOffsetDateTime(parsed.baseTime);
  if (baseTimeMs == null) return { kind: "failed", reason: "invalidBaseTime" };
  if (parsed.timeDefines.length < 1 || parsed.timeDefines.length > 60) {
    return { kind: "failed", reason: parsed.timeDefines.length > 60 ? "compactOnly" : "invalidTimeDefine" };
  }
  const slots: TyphoonProbabilitySlot[] = [];
  const ids = new Set<number>();
  for (const definition of parsed.timeDefines) {
    if (!Number.isSafeInteger(definition.timeId) || definition.timeId < 1) {
      return { kind: "failed", reason: "invalidTimeDefine" };
    }
    if (ids.has(definition.timeId)) return { kind: "failed", reason: "duplicateTimeId" };
    ids.add(definition.timeId);
    const startsAtMs = parseOffsetDateTime(definition.dateTime);
    if (startsAtMs == null) return { kind: "failed", reason: "invalidTimeDefine" };
    const durationMs = parseFixedDurationMs(definition.duration);
    if (durationMs == null) return { kind: "failed", reason: "invalidDuration" };
    const endsAtMs = startsAtMs + durationMs;
    if (!validDateEpoch(endsAtMs) || endsAtMs <= startsAtMs) {
      return { kind: "failed", reason: "invalidDuration" };
    }
    slots.push({ timeId: definition.timeId, startsAtMs, endsAtMs });
  }
  slots.sort((left, right) => left.timeId - right.timeId);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    if (slot.timeId !== index + 1) return { kind: "failed", reason: "nonContiguousTimeId" };
    if (index === 0 && slot.startsAtMs !== baseTimeMs) {
      return { kind: "failed", reason: "slotGapOrOverlap" };
    }
    if (index > 0 && slots[index - 1]!.endsAtMs !== slot.startsAtMs) {
      return { kind: "failed", reason: "slotGapOrOverlap" };
    }
  }
  const expiresAtMs = slots.at(-1)!.endsAtMs;
  if (expiresAtMs <= baseTimeMs || expiresAtMs - baseTimeMs > MAX_SPAN_MS) {
    return { kind: "failed", reason: "forecastSpanExceeded" };
  }
  return { kind: "ok", baseTimeMs, slots, expiresAtMs };
}

function boundedTrimmed(value: string, maxLength: number): string | null {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maxLength ? normalized : null;
}

function optionalBoundedTrimmed(value: string | null, maxLength: number): string | null | undefined {
  if (value == null) return null;
  const normalized = boundedTrimmed(value, maxLength);
  return normalized == null ? undefined : normalized;
}

function validProbability(value: number | null): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

function exactBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= 1
    && value.length <= maxLength;
}

function exactOptionalText(value: unknown, maxLength: number): value is string | null {
  return value === null || exactBoundedText(value, maxLength);
}

/**
 * Reducer / writer / reader が共有できる active compact projection invariant。
 * 入力を補正せず、canonical range と local coupling をそのまま検査する。
 */
export function isCanonicalTyphoonProbabilityState(
  state: TyphoonProbabilityState,
): boolean {
  if (validateTyphoonProbabilityEventId(state.eventId) !== state.eventId
    || !exactBoundedText(state.sourceEventId, TYPHOON_PROBABILITY_MAX_SOURCE_ID_LENGTH)
    || !exactOptionalText(state.identity.name, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
    || !exactOptionalText(state.identity.nameKana, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
    || !exactOptionalText(state.identity.remark, TYPHOON_PROBABILITY_MAX_REMARK_LENGTH)
    || !exactOptionalText(state.identity.typhoonNumber, TYPHOON_PROBABILITY_MAX_CODE_LENGTH)
    || !validDateEpoch(state.baseTimeMs)
    || !validDateEpoch(state.expiresAtMs)
    || state.expiresAtMs <= state.baseTimeMs
    || state.expiresAtMs - state.baseTimeMs > MAX_SPAN_MS
    || !Number.isSafeInteger(state.maxFiveDayProbability)
    || state.maxFiveDayProbability < 1
    || state.maxFiveDayProbability > 100
    || !Number.isSafeInteger(state.activePrefectureCount)
    || state.activePrefectureCount < 1
    || state.activePrefectureCount > TYPHOON_PROBABILITY_MAX_ACTIVE_PREFECTURES
    || state.topPrefectures.length !== Math.min(
      TYPHOON_PROBABILITY_MAX_TOP_PREFECTURES,
      state.activePrefectureCount,
    )
    || !exactBoundedText(state.appliedSemanticKey, TYPHOON_PROBABILITY_MAX_SEMANTIC_KEY_LENGTH)
    || !validDateEpoch(state.revision.reportTimeMs)
    || typeof state.restored !== "boolean") return false;

  if (state.revision.serial != null) {
    const serial = normalizeVpta50Serial(state.revision.serial);
    if (serial.kind !== "numeric" || serial.canonicalRaw !== state.revision.serial) return false;
  }
  const seenPrefectures = new Set<string>();
  for (let index = 0; index < state.topPrefectures.length; index += 1) {
    const prefecture = state.topPrefectures[index]!;
    if (!exactBoundedText(prefecture.prefectureCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH)
      || !exactBoundedText(prefecture.prefectureName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
      || !Number.isSafeInteger(prefecture.fiveDayProbability)
      || prefecture.fiveDayProbability < 1
      || prefecture.fiveDayProbability > 100
      || seenPrefectures.has(prefecture.prefectureCode)) return false;
    seenPrefectures.add(prefecture.prefectureCode);
    const previous = state.topPrefectures[index - 1];
    if (previous != null && comparePrefecture(previous, prefecture) >= 0) return false;
  }
  const worst = state.worstArea;
  if (!exactBoundedText(worst.areaCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH)
    || !exactBoundedText(worst.areaName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
    || !exactBoundedText(worst.prefectureCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH)
    || !exactBoundedText(worst.prefectureName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH)
    || !Number.isSafeInteger(worst.fiveDayProbability)
    || worst.fiveDayProbability < 1
    || worst.fiveDayProbability > 100
    || !(worst.peakAtMs == null
      || validDateEpoch(worst.peakAtMs)
      && worst.peakAtMs >= state.baseTimeMs
      && worst.peakAtMs < state.expiresAtMs)) return false;
  const matchingWorst = state.topPrefectures.filter((prefecture) =>
    prefecture.prefectureCode === worst.prefectureCode
    && prefecture.prefectureName === worst.prefectureName
    && prefecture.fiveDayProbability === worst.fiveDayProbability);
  return matchingWorst.length === 1
    && state.topPrefectures[0]?.fiveDayProbability === state.maxFiveDayProbability
    && worst.fiveDayProbability === state.maxFiveDayProbability;
}

interface ValidatedRegion {
  areaCode: string;
  areaName: string;
  prefectureCode: string;
  prefectureName: string;
  daily: readonly number[];
  series: readonly (number | null)[];
  seriesPeak: number;
  peakAtMs: number | null;
}

type RegionResult =
  | { kind: "ok"; regions: ValidatedRegion[] }
  | { kind: "failed"; reason: VptaProjectionFailureReason };

function validateRegions(
  rawRegions: readonly TyphoonProbRegion[],
  slots: readonly TyphoonProbabilitySlot[],
): RegionResult {
  if (rawRegions.length < 1 || rawRegions.length > TYPHOON_PROBABILITY_MAX_ACTIVE_PREFECTURES) {
    return { kind: "failed", reason: "invalidRegionCount" };
  }
  const areaCodes = new Set<string>();
  const prefectureNames = new Map<string, string>();
  const regions: ValidatedRegion[] = [];
  for (const raw of rawRegions) {
    const areaCode = boundedTrimmed(raw.areaCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH);
    const areaName = boundedTrimmed(raw.areaName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH);
    const prefectureCode = boundedTrimmed(raw.prefCode, TYPHOON_PROBABILITY_MAX_CODE_LENGTH);
    const prefectureName = boundedTrimmed(raw.prefName, TYPHOON_PROBABILITY_MAX_NAME_LENGTH);
    if (areaCode == null || areaName == null || prefectureCode == null || prefectureName == null) {
      return { kind: "failed", reason: "invalidRegionIdentity" };
    }
    if (areaCodes.has(areaCode)) return { kind: "failed", reason: "duplicateAreaCode" };
    areaCodes.add(areaCode);
    const knownName = prefectureNames.get(prefectureCode);
    if (knownName != null && knownName !== prefectureName) {
      return { kind: "failed", reason: "prefectureIdentityConflict" };
    }
    prefectureNames.set(prefectureCode, prefectureName);
    if (raw.daily.length !== 5 || !raw.daily.every(validProbability)) {
      return { kind: "failed", reason: "invalidDaily" };
    }
    if (raw.series40.length !== slots.length) {
      return { kind: "failed", reason: "seriesLengthMismatch" };
    }
    if (!raw.series40.every((value) => value == null || validProbability(value))) {
      return { kind: "failed", reason: "invalidSeries" };
    }
    let seriesPeak = 0;
    let peakAtMs: number | null = null;
    for (let index = 0; index < raw.series40.length; index += 1) {
      const value = raw.series40[index];
      if (value != null && value > seriesPeak) {
        seriesPeak = value;
        peakAtMs = slots[index]!.startsAtMs;
      }
    }
    regions.push({
      areaCode, areaName, prefectureCode, prefectureName,
      daily: raw.daily as number[], series: raw.series40,
      seriesPeak, peakAtMs,
    });
  }
  return { kind: "ok", regions };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrefecture(
  left: TyphoonProbabilityPrefectureState,
  right: TyphoonProbabilityPrefectureState,
): number {
  return right.fiveDayProbability - left.fiveDayProbability
    || compareText(left.prefectureCode, right.prefectureCode);
}

function compareWorst(left: ValidatedRegion, right: ValidatedRegion): number {
  return right.daily[4]! - left.daily[4]!
    || right.seriesPeak - left.seriesPeak
    || (left.peakAtMs ?? Number.MAX_SAFE_INTEGER) - (right.peakAtMs ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.prefectureCode, right.prefectureCode)
    || compareText(left.areaCode, right.areaCode);
}

/**
 * Card に必要な compact projection だけを構成する pure projector。
 * CLI / ticker 用の parsed grid は変更しない。
 */
export function projectTyphoonProbability(
  parsed: ParsedTyphoonProbability,
  canonicalInfoType: CanonicalVptaInfoType,
  classificationNowMs: number,
): TyphoonProbabilityCandidateClassification {
  const nowMs = classificationNowMs;
  if (canonicalInfoType === "取消") {
    return { nowMs, canonicalInfoType, result: { kind: "cancel" } };
  }
  if (parsed.fallback === "compactOnly" || parsed.timeDefines.length > 60) {
    return { nowMs, canonicalInfoType, result: { kind: "nonProjectable", reason: "compactOnly" } };
  }
  const slotsResult = buildSlots(parsed);
  if (slotsResult.kind === "failed") {
    return { nowMs, canonicalInfoType, result: { kind: "nonProjectable", reason: slotsResult.reason } };
  }
  const duplicateCodes = parsed.parserDiagnostics.duplicateCodes
    .map((value) => value.trim()).filter((value) => value !== "");
  if (duplicateCodes.length > 0) {
    return { nowMs, canonicalInfoType, result: { kind: "nonProjectable", reason: "parserDuplicateDiagnostic" } };
  }
  const regionResult = validateRegions(parsed.regions, slotsResult.slots);
  if (regionResult.kind === "failed") {
    return { nowMs, canonicalInfoType, result: { kind: "nonProjectable", reason: regionResult.reason } };
  }
  if (nowMs >= slotsResult.expiresAtMs) {
    return { nowMs, canonicalInfoType, result: { kind: "expired" } };
  }
  const allZero = regionResult.regions.every((region) =>
    region.daily.every((value) => value === 0)
    && region.series.every((value) => value === 0));
  if (allZero) return { nowMs, canonicalInfoType, result: { kind: "deactivateAllZero" } };

  const prefectures = new Map<string, TyphoonProbabilityPrefectureState>();
  for (const region of regionResult.regions) {
    const fiveDayProbability = region.daily[4]!;
    const previous = prefectures.get(region.prefectureCode);
    if (previous == null || fiveDayProbability > previous.fiveDayProbability) {
      prefectures.set(region.prefectureCode, {
        prefectureCode: region.prefectureCode,
        prefectureName: region.prefectureName,
        fiveDayProbability,
      });
    }
  }
  const ranked = [...prefectures.values()]
    .filter((prefecture) => prefecture.fiveDayProbability > 0)
    .sort(comparePrefecture);
  if (ranked.length === 0) {
    return { nowMs, canonicalInfoType, result: { kind: "nonProjectable", reason: "noActiveProbability" } };
  }
  const worst = [...regionResult.regions].sort(compareWorst)[0]!;
  const topPrefectures = ranked.slice(0, TYPHOON_PROBABILITY_MAX_TOP_PREFECTURES);
  if (!topPrefectures.some((item) => item.prefectureCode === worst.prefectureCode)) {
    const worstPrefecture = prefectures.get(worst.prefectureCode)!;
    if (topPrefectures.length === TYPHOON_PROBABILITY_MAX_TOP_PREFECTURES) topPrefectures.pop();
    topPrefectures.push(worstPrefecture);
    topPrefectures.sort(comparePrefecture);
  }
  const identity = {
    name: optionalBoundedTrimmed(parsed.name?.name ?? null, TYPHOON_PROBABILITY_MAX_NAME_LENGTH),
    nameKana: optionalBoundedTrimmed(parsed.name?.nameKana ?? null, TYPHOON_PROBABILITY_MAX_NAME_LENGTH),
    remark: optionalBoundedTrimmed(parsed.name?.remark ?? null, TYPHOON_PROBABILITY_MAX_REMARK_LENGTH),
    typhoonNumber: optionalBoundedTrimmed(parsed.name?.number ?? null, TYPHOON_PROBABILITY_MAX_CODE_LENGTH),
  };
  if (Object.values(identity).some((value) => value === undefined)) {
    return { nowMs, canonicalInfoType, result: { kind: "nonProjectable", reason: "invalidRegionIdentity" } };
  }
  const eventId = validateTyphoonProbabilityEventId(parsed.eventId);
  const sourceEventId = boundedTrimmed(parsed.meta.messageId, TYPHOON_PROBABILITY_MAX_SOURCE_ID_LENGTH);
  if (eventId == null || sourceEventId == null) {
    return { nowMs, canonicalInfoType, result: { kind: "nonProjectable", reason: "invalidRegionIdentity" } };
  }
  const maxFiveDayProbability = ranked[0]!.fiveDayProbability;
  return {
    nowMs,
    canonicalInfoType,
    result: {
      kind: "active",
      candidate: {
        eventId,
        sourceEventId,
        identity: identity as TyphoonProbabilityActiveCandidate["identity"],
        baseTimeMs: slotsResult.baseTimeMs,
        maxFiveDayProbability,
        activePrefectureCount: ranked.length,
        topPrefectures: topPrefectures.map((item) => ({ ...item })),
        worstArea: {
          areaCode: worst.areaCode,
          areaName: worst.areaName,
          prefectureCode: worst.prefectureCode,
          prefectureName: worst.prefectureName,
          fiveDayProbability: worst.daily[4]!,
          peakAtMs: worst.peakAtMs,
        },
        expiresAtMs: slotsResult.expiresAtMs,
      },
    },
  };
}

export function finalizeTyphoonProbabilityClassification(
  classification: TyphoonProbabilityCandidateClassification,
  acceptedRevision: StandbyRevision,
  appliedSemanticKey: string,
): FinalizedTyphoonProbabilityClassification {
  const result: FinalizedTyphoonProbabilityResult = classification.result.kind === "active"
    ? {
        kind: "active",
        state: {
          ...classification.result.candidate,
          identity: { ...classification.result.candidate.identity },
          topPrefectures: classification.result.candidate.topPrefectures.map((item) => ({ ...item })),
          worstArea: { ...classification.result.candidate.worstArea },
          revision: { ...acceptedRevision },
          appliedSemanticKey,
          restored: false,
        },
      }
    : { ...classification.result };
  return {
    nowMs: classification.nowMs,
    canonicalInfoType: classification.canonicalInfoType,
    result,
    acceptedRevision: { ...acceptedRevision },
    appliedSemanticKey,
  };
}
