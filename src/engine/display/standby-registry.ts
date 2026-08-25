import type { ActiveStandbyCardV1, StandbyKind } from "./protocol";

export interface CardPolicy {
  priority: number;
  /** null = fallback TTL なし (電文解除 or 種別独自の失効のみ) */
  fallbackTtlMs: number | null;
  /** 取消・失効後も旧報を拒否する watermark の保持期間 */
  tombstoneTtlMs: number;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** briefing card は ticker／revision family と別の非永続 state を持つ。 */
export const BRIEFING_CARD_TTL_MS = 120 * 60_000;
export const BRIEFING_CARD_CANCEL_TTL_MS = 10 * 60_000;
export const BRIEFING_CARD_MAX_ENTRIES = 128;
export const BRIEFING_CARD_PRIORITY = 450;
export const BRIEFING_CARD_KEY = "briefing:active";

export const STANDBY_CARD_REGISTRY = {
  tornado: { priority: 600, fallbackTtlMs: HOUR, tombstoneTtlMs: DAY + HOUR },
  flood: { priority: 500, fallbackTtlMs: 12 * HOUR, tombstoneTtlMs: DAY + 12 * HOUR },
  volcano: { priority: 400, fallbackTtlMs: DAY, tombstoneTtlMs: 2 * DAY },
  typhoon: { priority: 300, fallbackTtlMs: DAY, tombstoneTtlMs: 2 * DAY },
  heat: { priority: 200, fallbackTtlMs: null, tombstoneTtlMs: 2 * DAY },
  longPeriod: { priority: 100, fallbackTtlMs: 12 * HOUR, tombstoneTtlMs: DAY + 12 * HOUR },
  nankaiTrough: { priority: 100, fallbackTtlMs: 7 * DAY, tombstoneTtlMs: 14 * DAY },
} satisfies Record<Exclude<StandbyKind, "briefing">, CardPolicy>;

export function tombstoneTtlForKey(key: string): number {
  if (key.startsWith("volcano:alert:")) return 30 * DAY;
  if (key.startsWith("volcano:event:")) return STANDBY_CARD_REGISTRY.volcano.tombstoneTtlMs;
  if (key.startsWith("heat:")) return STANDBY_CARD_REGISTRY.heat.tombstoneTtlMs;
  if (key.startsWith("typhoon:")) return STANDBY_CARD_REGISTRY.typhoon.tombstoneTtlMs;
  if (key.startsWith("tornado:")) return STANDBY_CARD_REGISTRY.tornado.tombstoneTtlMs;
  if (key.startsWith("longPeriod:")) return STANDBY_CARD_REGISTRY.longPeriod.tombstoneTtlMs;
  if (key.startsWith("nankai:")) return STANDBY_CARD_REGISTRY.nankaiTrough.tombstoneTtlMs;
  return DAY;
}

export interface StandbyRevision {
  reportTimeMs: number;
  serial: string | null;
}

const FUTURE_TOLERANCE_MS = 15 * 60_000;

export function revisionOf(reportDateTime: string, serial: string | null, nowMs: number): StandbyRevision {
  const parsed = Date.parse(reportDateTime);
  const reportTimeMs = Number.isNaN(parsed) || parsed > nowMs + FUTURE_TOLERANCE_MS ? nowMs : parsed;
  return { reportTimeMs, serial };
}

export function compareRevision(a: StandbyRevision, b: StandbyRevision): number {
  if (a.reportTimeMs !== b.reportTimeMs) return a.reportTimeMs - b.reportTimeMs;
  if (a.serial == null || b.serial == null) return 0;
  const an = Number(a.serial);
  const bn = Number(b.serial);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0;
}

export function expiryFromReport(reportTimeMs: number, nowMs: number, ttlMs: number): number {
  void nowMs;
  return reportTimeMs + ttlMs;
}

export interface DisplayMutation {
  viewChanged: boolean;
  durableChanged: boolean;
  /** briefing card の容量 eviction を sink へ一段だけ伝える内部 metadata。 */
  cardEvictedKey?: string;
}

export const NO_MUTATION: DisplayMutation = { viewChanged: false, durableChanged: false };

export function mergeMutation(a: DisplayMutation, b: DisplayMutation): DisplayMutation {
  const cardEvictedKey = b.cardEvictedKey ?? a.cardEvictedKey;
  return {
    viewChanged: a.viewChanged || b.viewChanged,
    durableChanged: a.durableChanged || b.durableChanged,
    ...(cardEvictedKey == null ? {} : { cardEvictedKey }),
  };
}

export function sortStandbyItems(items: ActiveStandbyCardV1[]): ActiveStandbyCardV1[] {
  return [...items].sort((x, y) => {
    const priority = priorityForKind(y.kind) - priorityForKind(x.kind);
    if (priority !== 0) return priority;
    return Date.parse(y.updatedAt) - Date.parse(x.updatedAt);
  });
}

function priorityForKind(kind: StandbyKind): number {
  return kind === "briefing" ? BRIEFING_CARD_PRIORITY : STANDBY_CARD_REGISTRY[kind].priority;
}
