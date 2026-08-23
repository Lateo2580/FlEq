import type { CardPageRuntime, PageAreaEntry, PagePartitionKey, PageRange, PageTail, PartitionResult } from "./types";

export type PartitionProbe = (key: PagePartitionKey, placement: "side" | "center", range: PageRange, tail: readonly PageTail[]) => number | null;

function omittedAreaCount(tails: readonly PageTail[]): number {
  return tails.reduce((total, tail) => total + tail.omittedAreaCount, 0);
}

function measureId(key: PagePartitionKey, range: PageRange): string {
  if (range.tails.length === 0) return `${key}:page:${range.start}:${range.end}`;
  const tailSignature = range.tails.map((tail) => `${encodeURIComponent(tail.kindKey)}=${tail.omittedAreaCount}`).join(",");
  return `${key}:page:${range.start}:${range.end}:omitted:${range.omittedAreaCount}:tails:${tailSignature}`;
}

export function sequentialPartitionRanges(key: PagePartitionKey, placement: "side" | "center", areaCount: number, fixedHeightPx: number, probe: PartitionProbe, tailEntriesForRange: (range: PageRange) => readonly PageTail[]): PartitionResult {
  const ranges: PageRange[] = [];
  const pending: PartitionResult["pending"] = [];
  const probedIds = new Set<string>();
  const rangeFor = (start: number, end: number): PageRange => {
    const bare = { start, end, tails: [], omittedAreaCount: 0 };
    const tails = [...tailEntriesForRange(bare)];
    return { start, end, tails, omittedAreaCount: omittedAreaCount(tails) };
  };
  const probeRange = (range: PageRange): number | null => { probedIds.add(measureId(key, range)); return probe(key, placement, range, range.tails); };
  if (areaCount === 0) {
    const range = rangeFor(0, 0);
    if (range.tails.length === 0) return { ranges, pending, infeasible: false, probeCount: 0 };
    const measured = probeRange(range);
    if (measured == null) return { ranges: [range], pending: [{ id: measureId(key, range), key, ...range }], infeasible: false, probeCount: probedIds.size };
    return measured <= fixedHeightPx || fixedHeightPx <= 0 ? { ranges: [range], pending, infeasible: false, probeCount: probedIds.size } : { ranges: [], pending, infeasible: true, probeCount: probedIds.size };
  }
  let start = 0;
  while (start < areaCount) {
    let acceptedEnd = start;
    for (let end = start + 1; end <= areaCount; end += 1) {
      const range = rangeFor(start, end);
      const measured = probeRange(range);
      if (measured == null) {
        const provisional = rangeFor(start, acceptedEnd > start ? acceptedEnd : end);
        pending.push({ id: measureId(key, range), key, ...range });
        ranges.push(provisional);
        return { ranges, pending, infeasible: false, probeCount: probedIds.size };
      }
      if (fixedHeightPx <= 0 || measured <= fixedHeightPx) {
        acceptedEnd = end;
        if (acceptedEnd === areaCount) { ranges.push(rangeFor(start, acceptedEnd)); return { ranges, pending, infeasible: false, probeCount: probedIds.size }; }
        continue;
      }
      if (acceptedEnd === start) return { ranges: [], pending: [], infeasible: true, probeCount: probedIds.size };
      ranges.push(rangeFor(start, acceptedEnd));
      start = acceptedEnd;
      break;
    }
  }
  return { ranges, pending, infeasible: false, probeCount: probedIds.size };
}

export function pageIdentity(entry: PageAreaEntry): string {
  const base = `${entry.kindKey}|${entry.area}|${entry.occurrenceIndex}`;
  return entry.areaCode == null || entry.areaCode === "" ? base : `${base}|code:${entry.areaCode}`;
}

function nextPageKeyAfterRemoval(previousKeys: readonly string[], previousKey: string | null, nextKeys: readonly string[]): string | null {
  if (nextKeys.length === 0) return null;
  if (previousKey == null) return nextKeys[0] ?? null;
  const index = previousKeys.indexOf(previousKey);
  if (index >= 0) for (let offset = 1; offset <= previousKeys.length; offset += 1) {
    const candidate = previousKeys[(index + offset) % previousKeys.length];
    if (nextKeys.includes(candidate)) return candidate;
  }
  return nextKeys[0] ?? null;
}

export function planCardPageRuntimeUpdate(runtime: CardPageRuntime, pageKeys: readonly string[], reset: boolean, suppressAddedKeys = false): CardPageRuntime {
  const nextKeys = [...pageKeys];
  const previousKeys = runtime.knownKeys;
  const previousKey = runtime.activeKey;
  let activeKey: string | null;
  if (nextKeys.length === 0) activeKey = null;
  else if (reset) activeKey = nextKeys[0] ?? null;
  else if (previousKey != null && nextKeys.includes(previousKey)) activeKey = previousKey;
  else activeKey = nextPageKeyAfterRemoval(previousKeys, previousKey, nextKeys);
  const added = reset || suppressAddedKeys ? [] : nextKeys.filter((key) => !previousKeys.includes(key));
  const pendingKeys = reset ? [] : [...runtime.pendingKeys.filter((key) => nextKeys.includes(key)), ...added].filter((key, index, all) => all.indexOf(key) === index && key !== activeKey);
  let cycleOriginKey = runtime.cycleOriginKey;
  if (cycleOriginKey != null && !nextKeys.includes(cycleOriginKey)) cycleOriginKey = nextPageKeyAfterRemoval(previousKeys, cycleOriginKey, nextKeys.filter((key) => !pendingKeys.includes(key))) ?? activeKey;
  return { activeKey, knownKeys: nextKeys, pendingKeys, cycleOriginKey: pendingKeys.length === 0 ? null : cycleOriginKey ?? previousKey ?? activeKey };
}
