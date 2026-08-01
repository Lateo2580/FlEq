import { performance } from "node:perf_hooks";
import { intensityToRank } from "../../utils/intensity";
import type { SpecialValuePresence } from "../../types";
import type { PresentationEvent } from "../presentation/types";
import { resolveIntensitySafetyRank } from "../presentation/level-helpers";
import { resolveQuakeIntensityProjection } from "./project-event";
import type { DisplayEventDtoV1 } from "./types";
import { RevisionGuard, type PersistedSeenEntry } from "./revision-guard";
import { compareRevision, revisionOf } from "./standby-registry";
import {
  hasResolvedQuakeCancellation,
  isQuakeIntensityStructureMissing,
  quakeObservationBridgeOf,
  quakeObservationMetaOf,
  shouldPreserveVxse51Observation,
  shouldRetainKnownQuakeSafety,
} from "./quake-observation-merge";

export const QUAKE_EXTREME_HOLD_MS = 12 * 60 * 60 * 1000;
const QUAKE_EXTREME_RANK = intensityToRank("7");

export interface QuakeExtremeRecordV1 {
  groupKey: string;
  originTime: string;
  reportDateTime?: string;
  hypocenterName?: string | null;
  magnitude?: string | null;
  depth?: string | null;
  /** この EventID を震度 7 と報じている電文種別。revision 系列と同じ粒度。 */
  sourceTypes: string[];
  /** 新規保存では常に保持。旧 v1 は単一 sourceTypes の場合だけ安全に推定する。 */
  observationSourceType?: string;
}

/** wire とは別の、monitor 所有の永続化用状態。 */
export interface QuakeExtremePersistedV1 {
  records: QuakeExtremeRecordV1[];
  /** 取消・下方修正後に古い続報を復活させない系列別 tombstone。 */
  seen?: PersistedSeenEntry[];
}

interface ActiveQuakeExtremeRecord extends Omit<QuakeExtremeRecordV1, "observationSourceType"> {
  expiresAtMonotonicMs: number;
  observationSourceType: string | null;
}

type QuakeExtremeInput = {
  domain: string;
  groupKey: string | null;
  cancellationResolved: boolean;
  maxIntRank: number | null;
  maxIntPresence: SpecialValuePresence;
  retainKnownSafety: boolean;
  intensityStructureMissing: boolean;
  originTime: string | null;
  hypocenterName: string | null;
  magnitude: string | null;
  depth: string | null;
  reportDateTime: string;
  serial: string | null;
  type: string;
  isCorrection: boolean;
};

export type QuakeExtremeDurability = "debounced" | "immediate";

export interface QuakeExtremeStoreDeps {
  /** 同一プロセス内の保持時計。省略時は performance.now。 */
  monotonicNow?: () => number;
}

/**
 * 震度 7 の背景保持だけを担う専用時計。
 * largeQuakes/latestQuake の表示 TTL とは独立し、originTime 基準で 12 時間だけ有効にする。
 */
export class QuakeExtremeStore {
  private records = new Map<string, ActiveQuakeExtremeRecord>();
  private readonly revisionGuard: RevisionGuard;
  private durableListeners = new Set<(durability: QuakeExtremeDurability) => void>();
  private readonly monotonicNow: () => number;

  constructor(deps: QuakeExtremeStoreDeps = {}) {
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now());
    this.revisionGuard = new RevisionGuard({ monotonicNow: this.monotonicNow });
  }

  onDurable(listener: (durability: QuakeExtremeDurability) => void): () => void {
    this.durableListeners.add(listener);
    return () => this.durableListeners.delete(listener);
  }

  applyPresentationEvent(event: PresentationEvent, nowMs: number): boolean {
    const adoptedIntensity = resolveQuakeIntensityProjection(event);
    const maxIntValue = adoptedIntensity.value;
    const legacyRank = adoptedIntensity.semantic.safetyRank == null
      ? event.maxIntRank ?? null
      : null;
    return this.apply({
      domain: event.domain,
      groupKey: event.domain === "earthquake" && event.eventId != null ? `quake:${event.eventId}` : null,
      cancellationResolved:
        event.foundationResolvedTrigger != null
        && event.foundationCancellationPolicy != null,
      maxIntRank: adoptedIntensity.semantic.safetyRank ?? legacyRank,
      maxIntPresence: legacyRank == null ? maxIntValue.presence : "value",
      retainKnownSafety: legacyRank == null && shouldRetainKnownQuakeSafety(maxIntValue),
      intensityStructureMissing: isQuakeIntensityStructureMissing(event, maxIntValue),
      originTime: event.originTime ?? null,
      hypocenterName: event.hypocenterName ?? null,
      magnitude: event.magnitude ?? null,
      depth: event.depth ?? null,
      reportDateTime: event.reportDateTime,
      serial: event.serial ?? null,
      type: event.type,
      isCorrection: event.infoType === "訂正",
    }, nowMs);
  }

  applyDto(dto: DisplayEventDtoV1, nowMs: number): boolean {
    const projection = quakeObservationBridgeOf(dto)?.latest ?? null;
    const meta = projection == null ? null : quakeObservationMetaOf(projection);
    const rank = resolveIntensitySafetyRank(meta?.maxIntValue, projection?.maxInt)
      ?? projection?.maxIntRank ?? dto.latestQuake?.maxIntSemantic?.safetyRank
      ?? dto.latestQuake?.maxIntRank ??
      (dto.emergency?.kind === "largeQuake" ? dto.emergency.maxIntRank : null);
    const quakeDetails = projection ?? dto.latestQuake;
    const largeQuake = dto.emergency?.kind === "largeQuake" ? dto.emergency : null;
    const originTime = quakeDetails != null ? quakeDetails.originTime : largeQuake?.originTime ?? null;
    return this.apply({
      domain: dto.domain,
      groupKey: dto.groupKey,
      cancellationResolved: meta != null && hasResolvedQuakeCancellation(meta),
      maxIntRank: rank,
      maxIntPresence: meta?.maxIntValue.presence ?? (rank == null ? "missing" : "value"),
      retainKnownSafety: meta == null ? false : shouldRetainKnownQuakeSafety(meta.maxIntValue),
      intensityStructureMissing: meta?.intensityStructureMissing ?? rank == null,
      originTime,
      hypocenterName: quakeDetails != null ? quakeDetails.hypocenterName : largeQuake?.hypocenterName ?? null,
      magnitude: quakeDetails != null ? quakeDetails.magnitude : largeQuake?.magnitude ?? null,
      depth: quakeDetails != null ? quakeDetails.depth : largeQuake?.depth ?? null,
      reportDateTime: dto.reportDateTime,
      serial: dto.serial ?? null,
      type: dto.type,
      isCorrection: dto.infoType === "訂正",
    }, nowMs);
  }

  hasActive(nowMs: number): boolean {
    void nowMs;
    const monotonicMs = this.monotonicNow();
    for (const record of this.records.values()) {
      if (monotonicMs < record.expiresAtMonotonicMs) return true;
    }
    return false;
  }

  sweep(nowMs: number): boolean {
    const monotonicMs = this.monotonicNow();
    let viewChanged = false;
    let durableChanged = this.revisionGuard.sweep(nowMs);
    for (const [key, record] of this.records) {
      if (record.expiresAtMonotonicMs <= monotonicMs) {
        this.records.delete(key);
        viewChanged = true;
        durableChanged = true;
      }
    }
    if (durableChanged) this.notifyDurable("debounced");
    return viewChanged;
  }

  export(): QuakeExtremePersistedV1 {
    return {
      records: [...this.records.values()].map(({
        groupKey,
        originTime,
        reportDateTime,
        hypocenterName,
        magnitude,
        depth,
        sourceTypes,
        observationSourceType,
      }) => ({
        groupKey,
        originTime,
        ...(reportDateTime === undefined ? {} : { reportDateTime }),
        ...(hypocenterName === undefined ? {} : { hypocenterName }),
        ...(magnitude === undefined ? {} : { magnitude }),
        ...(depth === undefined ? {} : { depth }),
        sourceTypes: [...sourceTypes],
        ...(observationSourceType == null ? {} : { observationSourceType }),
      })),
      seen: this.revisionGuard.export(),
    };
  }

  /** 起動時復元: 最新保存値のうち originTime から 12 時間以内のものだけを採る。 */
  restore(state: QuakeExtremePersistedV1, nowMs: number): void {
    this.records.clear();
    this.revisionGuard.restore(withGroupWatermarks(state.seen ?? []), nowMs);
    const monotonicMs = this.monotonicNow();
    for (const record of state.records) {
      const remainingMs = isValidRecord(record) ? remainingHoldMs(record.originTime, nowMs) : null;
      if (remainingMs != null) {
        const observationSourceType = record.observationSourceType
          ?? (record.sourceTypes.length === 1 ? record.sourceTypes[0]! : null);
        this.records.set(record.groupKey, {
          ...record,
          sourceTypes: [...record.sourceTypes],
          observationSourceType,
          expiresAtMonotonicMs: monotonicMs + remainingMs,
        });
      }
    }
  }

  private apply(input: QuakeExtremeInput, nowMs: number): boolean {
    if (input.domain !== "earthquake" || input.groupKey == null) return false;
    const revision = revisionOf(input.reportDateTime, input.serial, nowMs);
    const revisionKey = `${input.groupKey}:${input.type}`;
    if (input.cancellationResolved) {
      if (!this.revisionGuard.accept(
        input.groupKey,
        revision,
        nowMs,
        QUAKE_EXTREME_HOLD_MS,
        input.isCorrection,
      )) return false;
    } else {
      if (!this.revisionGuard.allows(input.groupKey, revision, input.isCorrection)) return false;
      if (!this.revisionGuard.allows(revisionKey, revision, input.isCorrection)) return false;
      this.revisionGuard.replace(input.groupKey, revision, nowMs, QUAKE_EXTREME_HOLD_MS);
      this.revisionGuard.replace(revisionKey, revision, nowMs, QUAKE_EXTREME_HOLD_MS);
    }

    const previous = this.records.get(input.groupKey);
    const preservesVxse51Observation = previous != null
      && shouldPreserveVxse51Observation({
        previousObservationSourceType: previous.observationSourceType,
        previousMaxIntPresence: "value",
        previousCancellationResolved: false,
        nextSourceType: input.type,
        nextMaxIntPresence: input.maxIntPresence,
        nextIntensityStructureMissing: input.intensityStructureMissing,
        nextCancellationResolved: input.cancellationResolved,
      });
    const explicitNonExact =
      input.maxIntPresence !== "value"
      && input.maxIntRank == null
      && !(input.maxIntPresence === "missing" && input.intensityStructureMissing);
    const invalidatingMissing =
      input.maxIntPresence === "missing"
      && input.intensityStructureMissing
      && previous != null
      && !preservesVxse51Observation;
    const invalidatesRecord =
      input.cancellationResolved
      || !input.retainKnownSafety && (
        explicitNonExact
        || invalidatingMissing
        || input.maxIntRank != null && input.maxIntRank < QUAKE_EXTREME_RANK
      );

    let changed = false;
    if (invalidatesRecord) {
      changed = this.records.delete(input.groupKey);
    } else if (preservesVxse51Observation && previous != null) {
      const originTime = input.originTime ?? previous.originTime;
      const remainingMs = remainingHoldMs(originTime, nowMs);
      if (remainingMs == null) {
        changed = this.records.delete(input.groupKey);
      } else {
        const sourceTypes = [...new Set([...previous.sourceTypes, input.type])];
        const expiresAtMonotonicMs = this.monotonicNow() + remainingMs;
        changed = previous.originTime !== originTime
          || previous.expiresAtMonotonicMs !== expiresAtMonotonicMs
          || !previous.sourceTypes.includes(input.type);
        this.records.set(input.groupKey, {
          ...previous,
          originTime,
          reportDateTime: input.reportDateTime,
          hypocenterName: input.hypocenterName,
          magnitude: input.magnitude,
          depth: input.depth,
          sourceTypes,
          expiresAtMonotonicMs,
        });
      }
    } else if (input.maxIntRank === QUAKE_EXTREME_RANK && input.originTime != null) {
      if (
        previous?.originTime !== input.originTime
        || !previous.sourceTypes.includes(input.type)
        || previous.observationSourceType !== input.type
      ) {
        const remainingMs = remainingHoldMs(input.originTime, nowMs);
        if (remainingMs == null) {
          changed = this.records.delete(input.groupKey);
        } else {
          const sameOrigin = previous?.originTime === input.originTime;
          const sourceTypes = sameOrigin
            ? [...new Set([...previous.sourceTypes, input.type])]
            : [input.type];
          this.records.set(input.groupKey, {
            groupKey: input.groupKey,
            originTime: input.originTime,
            reportDateTime: input.reportDateTime,
            hypocenterName: input.hypocenterName,
            magnitude: input.magnitude,
            depth: input.depth,
            sourceTypes,
            observationSourceType: input.type,
            expiresAtMonotonicMs: sameOrigin
              ? previous.expiresAtMonotonicMs
              : this.monotonicNow() + remainingMs,
          });
          changed = previous == null;
        }
      }
    }
    // 構造的 missing は VXSE51→VXSE52/61 の契約を証明できる場合だけ保持する。
    // view が変わらなくても revision tombstone は永続化する。
    const durability = invalidatesRecord
      ? "immediate"
      : "debounced";
    this.notifyDurable(durability);
    return changed;
  }

  private notifyDurable(durability: QuakeExtremeDurability): void {
    for (const listener of this.durableListeners) listener(durability);
  }
}

function remainingHoldMs(originTime: string, nowMs: number): number | null {
  const originTimeMs = Date.parse(originTime);
  if (!Number.isFinite(originTimeMs) || originTimeMs > nowMs) return null;
  const remainingMs = QUAKE_EXTREME_HOLD_MS - (nowMs - originTimeMs);
  return remainingMs > 0 ? remainingMs : null;
}

function isValidRecord(value: QuakeExtremeRecordV1): boolean {
  return typeof value.groupKey === "string" && value.groupKey !== "" &&
    typeof value.originTime === "string" && Number.isFinite(Date.parse(value.originTime)) &&
    (value.reportDateTime === undefined ||
      typeof value.reportDateTime === "string" && Number.isFinite(Date.parse(value.reportDateTime))) &&
    (value.hypocenterName === undefined || value.hypocenterName == null || typeof value.hypocenterName === "string") &&
    (value.magnitude === undefined || value.magnitude == null || typeof value.magnitude === "string") &&
    (value.depth === undefined || value.depth == null || typeof value.depth === "string") &&
    Array.isArray(value.sourceTypes) && value.sourceTypes.length > 0 &&
    value.sourceTypes.every((type) => typeof type === "string" && type !== "") &&
    (value.observationSourceType == null ||
      typeof value.observationSourceType === "string" && value.observationSourceType !== "" &&
        value.sourceTypes.includes(value.observationSourceType));
}

function withGroupWatermarks(entries: PersistedSeenEntry[]): PersistedSeenEntry[] {
  const migrated = new Map(entries.map((entry) => [entry.key, {
    ...entry,
    revision: { ...entry.revision },
  }]));
  for (const entry of entries) {
    const match = /^(quake:.+):VXSE\d+$/.exec(entry.key);
    const groupKey = match?.[1];
    if (groupKey == null) continue;
    const existing = migrated.get(groupKey);
    const revision = existing == null || compareRevision(entry.revision, existing.revision) > 0
      ? { ...entry.revision }
      : { ...existing.revision };
    migrated.set(groupKey, {
      key: groupKey,
      revision,
      forgetAtMs: Math.max(existing?.forgetAtMs ?? 0, entry.forgetAtMs),
    });
  }
  return [...migrated.values()];
}
