import type { JmaIntensity, SpecialValue } from "../../types";
import type {
  CancellationPolicy,
  CancellationTrigger,
} from "../messages/telegram-revision-gate";
import type { PresentationEvent } from "../presentation/types";
import type {
  DisplayEventDtoV1,
  DisplayLatestQuakeInputV1,
  DisplayLatestQuakeStateV1,
  DisplayRecentQuakeV1,
} from "./types";

export interface QuakeObservationMeta {
  /** この projection を生成した電文 type。旧 persistence からの移行時だけ null。 */
  sourceType: string | null;
  /** 現在の観測震度の出典。missing projection では null、保持時は VXSE51 を維持する。 */
  observationSourceType: string | null;
  infoType: string | null;
  resolvedTrigger: CancellationTrigger | null;
  cancellationPolicy: CancellationPolicy | null;
  /** 全体 MaxInt と Area/City の震度要素がすべて構造的 missing の場合だけ true。 */
  intensityStructureMissing: boolean;
  maxIntValue: SpecialValue<JmaIntensity>;
}

export const QUAKE_OBSERVATION_META: unique symbol = Symbol("quakeObservationMeta");
export const QUAKE_OBSERVATION_BRIDGE: unique symbol = Symbol("quakeObservationBridge");

export type QuakeObservationProjection<T extends object> = T & {
  [QUAKE_OBSERVATION_META]: QuakeObservationMeta;
};

export type RecentQuakeObservationProjection = QuakeObservationProjection<DisplayRecentQuakeV1>;
export type LatestQuakeObservationProjection = QuakeObservationProjection<DisplayLatestQuakeInputV1>;

export interface QuakeObservationBridge {
  recent: RecentQuakeObservationProjection | null;
  latest: LatestQuakeObservationProjection | null;
}

type DisplayEventWithQuakeObservationBridge = DisplayEventDtoV1 & {
  [QUAKE_OBSERVATION_BRIDGE]?: QuakeObservationBridge;
};

export function withQuakeObservationMeta<T extends object>(
  value: T,
  meta: QuakeObservationMeta,
): QuakeObservationProjection<T> {
  return { ...value, [QUAKE_OBSERVATION_META]: meta };
}

export function quakeObservationMetaOf(value: object): QuakeObservationMeta | null {
  return QUAKE_OBSERVATION_META in value
    ? (value as QuakeObservationProjection<object>)[QUAKE_OBSERVATION_META]
    : null;
}

export function hasResolvedQuakeCancellation(meta: QuakeObservationMeta): boolean {
  return meta.resolvedTrigger != null && meta.cancellationPolicy != null;
}

export interface QuakeObservationPreservationContext {
  previousObservationSourceType: string | null;
  previousMaxIntPresence: SpecialValue<JmaIntensity>["presence"];
  previousCancellationResolved: boolean;
  nextSourceType: string | null;
  nextMaxIntPresence: SpecialValue<JmaIntensity>["presence"];
  nextIntensityStructureMissing: boolean;
  nextCancellationResolved: boolean;
}

/** §7.4 の VXSE51 観測保持可否。EventID 一致は各 holder がこの helper の外側で確認する。 */
export function shouldPreserveVxse51Observation(
  context: QuakeObservationPreservationContext,
): boolean {
  return !context.nextCancellationResolved
    && !context.previousCancellationResolved
    && context.previousObservationSourceType === "VXSE51"
    && context.previousMaxIntPresence === "value"
    && (context.nextSourceType === "VXSE52" || context.nextSourceType === "VXSE61")
    && context.nextMaxIntPresence === "missing"
    && context.nextIntensityStructureMissing;
}

/** An explicit non-exact payload replaces the card, but cannot prove that a known safety latch decreased. */
export function shouldRetainKnownQuakeSafety(
  value: SpecialValue<JmaIntensity>,
): boolean {
  return value.presence === "unknown"
    || value.presence === "empty"
    || value.presence === "qualitative"
    || value.presence === "range" && value.upperBound == null;
}

export function isQuakeIntensityStructureMissing(
  event: PresentationEvent,
  maxIntValue: SpecialValue<JmaIntensity>,
): boolean {
  if (maxIntValue.presence !== "missing") return false;
  if (event.quakeIntensityValues != null) {
    return [
      ...event.quakeIntensityValues.localAreas,
      ...event.quakeIntensityValues.municipalities,
    ].every((item) => item.maxIntValue.presence === "missing");
  }
  return event.areaItems.every((item) =>
    item.maxIntValue?.presence === "missing"
    || item.maxIntValue == null && item.maxInt == null);
}

/** Symbol bridge は JSON/SSE に列挙されず、hub→state-store の process 内だけで生存する。 */
export function attachQuakeObservationBridge(
  dto: DisplayEventDtoV1,
  bridge: QuakeObservationBridge,
): void {
  Object.defineProperty(dto as DisplayEventWithQuakeObservationBridge, QUAKE_OBSERVATION_BRIDGE, {
    value: bridge,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function quakeObservationBridgeOf(dto: DisplayEventDtoV1): QuakeObservationBridge | null {
  return (dto as DisplayEventWithQuakeObservationBridge)[QUAKE_OBSERVATION_BRIDGE] ?? null;
}

interface QuakeObservationCandidate {
  eventId: string | null;
  maxInt: string | null;
}

function nonEmptyEventId(eventId: string | null): eventId is string {
  return eventId != null && eventId.trim() !== "";
}

function shouldPreserveObservation(
  previous: QuakeObservationCandidate | null | undefined,
  next: QuakeObservationCandidate,
): previous is QuakeObservationCandidate {
  if (previous == null) return false;
  const previousMeta = quakeObservationMetaOf(previous);
  const nextMeta = quakeObservationMetaOf(next);
  return previousMeta != null
    && nextMeta != null
    && nonEmptyEventId(previous.eventId)
    && previous.eventId === next.eventId
    && shouldPreserveVxse51Observation({
      previousObservationSourceType: previousMeta.observationSourceType,
      previousMaxIntPresence: previousMeta.maxIntValue.presence,
      previousCancellationResolved: hasResolvedQuakeCancellation(previousMeta),
      nextSourceType: nextMeta.sourceType,
      nextMaxIntPresence: nextMeta.maxIntValue.presence,
      nextIntensityStructureMissing: nextMeta.intensityStructureMissing,
      nextCancellationResolved: hasResolvedQuakeCancellation(nextMeta),
    });
}

function terminalCancelledRecentObservation(
  previous: DisplayRecentQuakeV1 | null | undefined,
  next: DisplayRecentQuakeV1,
): DisplayRecentQuakeV1 | null {
  if (
    previous == null
    || !nonEmptyEventId(previous.eventId)
    || previous.eventId !== next.eventId
  ) return null;
  const previousMeta = quakeObservationMetaOf(previous);
  const nextMeta = quakeObservationMetaOf(next);
  if (previousMeta == null || nextMeta == null || !hasResolvedQuakeCancellation(nextMeta)) return null;
  return withQuakeObservationMeta({
    ...previous,
    reportDateTime: next.reportDateTime,
  }, {
    ...nextMeta,
    sourceType: previousMeta.observationSourceType == null ? null : nextMeta.sourceType,
    observationSourceType: previousMeta.observationSourceType,
    intensityStructureMissing: false,
    maxIntValue: previousMeta.maxIntValue,
  });
}

function preservedMeta(
  previous: QuakeObservationCandidate,
  next: QuakeObservationCandidate,
): QuakeObservationMeta {
  const previousMeta = quakeObservationMetaOf(previous);
  const nextMeta = quakeObservationMetaOf(next);
  if (previousMeta == null || nextMeta == null) {
    throw new Error("quake observation metadata missing after preservation decision");
  }
  return {
    ...nextMeta,
    observationSourceType: previousMeta.observationSourceType,
    intensityStructureMissing: false,
    maxIntValue: previousMeta.maxIntValue,
  };
}

/**
 * VXSE51 の観測値を、同一 EventID の VXSE52/61 が構造的 missing の場合だけ保持する。
 * 震源諸元と報時刻は常に next を採用する。
 */
export function mergeLatestQuakeObservation(
  previous: DisplayLatestQuakeStateV1 | null,
  next: DisplayLatestQuakeInputV1,
): DisplayLatestQuakeInputV1 {
  if (!shouldPreserveObservation(previous, next)) return next;
  return withQuakeObservationMeta({
    ...next,
    maxInt: previous.maxInt,
    maxIntRank: previous.maxIntRank,
    maxIntSemantic: previous.maxIntSemantic,
    intensityGroups: previous.intensityGroups,
  }, preservedMeta(previous, next));
}

/** DailyQuakeCounter と store 内履歴で共有する、同一地震の震度保持マージ。 */
export function mergeRecentQuakeObservation(
  previous: DisplayRecentQuakeV1 | null | undefined,
  next: DisplayRecentQuakeV1,
): DisplayRecentQuakeV1 {
  const cancelled = terminalCancelledRecentObservation(previous, next);
  if (cancelled != null) return cancelled;
  if (!shouldPreserveObservation(previous, next)) return next;
  return withQuakeObservationMeta({
    ...next,
    maxInt: previous.maxInt,
    maxIntRank: previous.maxIntRank,
    maxIntSemantic: previous.maxIntSemantic,
    intensityGroups: previous.intensityGroups,
  }, preservedMeta(previous, next));
}
