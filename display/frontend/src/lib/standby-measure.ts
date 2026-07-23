import type { ActiveStandbyCardV1 } from "./protocol";

export interface CardMeasurement {
  version: string;
  height: number;
}

export type MeasureMap = ReadonlyMap<string, CardMeasurement>;

export function applyMeasurements(
  prev: MeasureMap,
  updates: Array<{ key: string; version: string; height: number }>,
): MeasureMap {
  const next = new Map<string, CardMeasurement>(prev);
  for (const update of updates) {
    // 非有限・0 以下は無視 (アンマウント途中の 0 高さ等で選抜を汚さない、plan Task 2)
    if (!Number.isFinite(update.height) || update.height <= 0) continue;
    const previous = next.get(update.key);
    if (previous?.version === update.version && Math.abs(previous.height - update.height) < 1) continue;
    next.set(update.key, { version: update.version, height: update.height });
  }
  return next;
}

export function allMeasured(
  measured: MeasureMap,
  items: ReadonlyArray<{ key: string; updatedAt: string }>,
): boolean {
  return items.every((item) => measured.get(item.key)?.version === item.updatedAt);
}

export function heightEstimator(
  measured: MeasureMap,
  items: ReadonlyArray<ActiveStandbyCardV1>,
  fallback: (item: ActiveStandbyCardV1) => number,
): (item: ActiveStandbyCardV1) => number {
  const measuredForAll = allMeasured(measured, items);
  return (item) => {
    if (!measuredForAll) return fallback(item);
    return measured.get(item.key)?.height ?? fallback(item);
  };
}

export function pruneMeasurements(
  measured: MeasureMap,
  items: ReadonlyArray<{ key: string }>,
): MeasureMap {
  const activeKeys = new Set(items.map((item) => item.key));
  let hasRemoved = false;
  for (const key of measured.keys()) {
    if (!activeKeys.has(key)) {
      hasRemoved = true;
      break;
    }
  }
  if (!hasRemoved) return measured;

  const pruned = new Map<string, CardMeasurement>();
  for (const [key, measurement] of measured) {
    if (activeKeys.has(key)) pruned.set(key, measurement);
  }
  return pruned;
}
