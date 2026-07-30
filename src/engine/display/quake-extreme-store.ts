import { performance } from "node:perf_hooks";
import { intensityToRank } from "../../utils/intensity";
import type { PresentationEvent } from "../presentation/types";
import type { DisplayEventDtoV1 } from "./types";
import { RevisionGuard, type PersistedSeenEntry } from "./revision-guard";
import { revisionOf } from "./standby-registry";

export const QUAKE_EXTREME_HOLD_MS = 12 * 60 * 60 * 1000;
const QUAKE_EXTREME_RANK = intensityToRank("7");

export interface QuakeExtremeRecordV1 {
  groupKey: string;
  originTime: string;
  /** この EventID を震度 7 と報じている電文種別。revision 系列と同じ粒度。 */
  sourceTypes: string[];
}

/** wire とは別の、monitor 所有の永続化用状態。 */
export interface QuakeExtremePersistedV1 {
  records: QuakeExtremeRecordV1[];
  /** 取消・下方修正後に古い続報を復活させない系列別 tombstone。 */
  seen?: PersistedSeenEntry[];
}

interface ActiveQuakeExtremeRecord extends QuakeExtremeRecordV1 {
  expiresAtMonotonicMs: number;
}

type QuakeExtremeInput = {
  domain: string;
  groupKey: string | null;
  isCancellation: boolean;
  maxIntRank: number | null;
  originTime: string | null;
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
    return this.apply({
      domain: event.domain,
      groupKey: event.domain === "earthquake" && event.eventId != null ? `quake:${event.eventId}` : null,
      isCancellation: event.isCancellation,
      maxIntRank: event.maxIntRank ?? null,
      originTime: event.originTime ?? null,
      reportDateTime: event.reportDateTime,
      serial: event.serial ?? null,
      type: event.type,
      isCorrection: event.infoType === "訂正",
    }, nowMs);
  }

  applyDto(dto: DisplayEventDtoV1, nowMs: number): boolean {
    const rank = dto.latestQuake?.maxIntRank ??
      (dto.emergency?.kind === "largeQuake" ? dto.emergency.maxIntRank : null);
    const originTime = dto.latestQuake?.originTime ??
      (dto.emergency?.kind === "largeQuake" ? dto.emergency.originTime : null);
    return this.apply({
      domain: dto.domain,
      groupKey: dto.groupKey,
      isCancellation: dto.isCancellation,
      maxIntRank: rank,
      originTime,
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
      records: [...this.records.values()].map(({ groupKey, originTime, sourceTypes }) => ({
        groupKey,
        originTime,
        sourceTypes: [...sourceTypes],
      })),
      seen: this.revisionGuard.export(),
    };
  }

  /** 起動時復元: 最新保存値のうち originTime から 12 時間以内のものだけを採る。 */
  restore(state: QuakeExtremePersistedV1, nowMs: number): void {
    this.records.clear();
    this.revisionGuard.restore(state.seen ?? [], nowMs);
    const monotonicMs = this.monotonicNow();
    for (const record of state.records) {
      const remainingMs = isValidRecord(record) ? remainingHoldMs(record.originTime, nowMs) : null;
      if (remainingMs != null) {
        this.records.set(record.groupKey, {
          ...record,
          sourceTypes: [...record.sourceTypes],
          expiresAtMonotonicMs: monotonicMs + remainingMs,
        });
      }
    }
  }

  private apply(input: QuakeExtremeInput, nowMs: number): boolean {
    if (input.domain !== "earthquake" || input.groupKey == null) return false;
    const revision = revisionOf(input.reportDateTime, input.serial, nowMs);
    const revisionKey = `${input.groupKey}:${input.type}`;
    if (!this.revisionGuard.accept(
      revisionKey,
      revision,
      nowMs,
      QUAKE_EXTREME_HOLD_MS,
      input.isCorrection,
    )) return false;

    let changed = false;
    if (input.isCancellation) {
      changed = this.removeSource(input.groupKey, input.type);
    } else if (input.maxIntRank != null && input.maxIntRank < QUAKE_EXTREME_RANK) {
      // 続報の最大震度が下がった時点で保持を解除する。
      changed = this.removeSource(input.groupKey, input.type);
    } else if (input.maxIntRank === QUAKE_EXTREME_RANK && input.originTime != null) {
      const previous = this.records.get(input.groupKey);
      if (previous?.originTime !== input.originTime || !previous.sourceTypes.includes(input.type)) {
        const remainingMs = remainingHoldMs(input.originTime, nowMs);
        if (remainingMs == null) {
          changed = this.removeSource(input.groupKey, input.type);
        } else {
          const sameOrigin = previous?.originTime === input.originTime;
          const sourceTypes = sameOrigin
            ? [...new Set([...previous.sourceTypes, input.type])]
            : [input.type];
          this.records.set(input.groupKey, {
            groupKey: input.groupKey,
            originTime: input.originTime,
            sourceTypes,
            expiresAtMonotonicMs: sameOrigin
              ? previous.expiresAtMonotonicMs
              : this.monotonicNow() + remainingMs,
          });
          changed = previous == null;
        }
      }
    }
    // 続報の最大震度が下がった時点で保持を解除する。rank 欠落は根拠不十分なので既存値を保つ。
    // view が変わらなくても revision tombstone は永続化する。
    const durability = input.isCancellation || input.maxIntRank != null && input.maxIntRank < QUAKE_EXTREME_RANK
      ? "immediate"
      : "debounced";
    this.notifyDurable(durability);
    return changed;
  }

  private removeSource(groupKey: string, sourceType: string): boolean {
    const previous = this.records.get(groupKey);
    if (previous == null || !previous.sourceTypes.includes(sourceType)) return false;
    const sourceTypes = previous.sourceTypes.filter((type) => type !== sourceType);
    if (sourceTypes.length === 0) return this.records.delete(groupKey);
    this.records.set(groupKey, { ...previous, sourceTypes });
    return false;
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
    Array.isArray(value.sourceTypes) && value.sourceTypes.length > 0 &&
    value.sourceTypes.every((type) => typeof type === "string" && type !== "");
}
