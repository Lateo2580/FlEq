import type {
  CardPageRuntime,
  PageAreaEntry,
  PagePartitionKey,
  PageRange,
  PageTail,
  PartitionResult,
  SplitOnlyPartitionRange,
  SplitOnlyPartitionSection,
  SplitOnlyPartitionSnapshot,
  SplitOnlyProbeRequest,
} from "./types";

export type PartitionProbe = (key: PagePartitionKey, placement: "side" | "center", range: PageRange, tail: readonly PageTail[]) => number | null;

function splitRange(start: number, end: number, status: SplitOnlyPartitionRange["status"]): SplitOnlyPartitionRange {
  return { start, end, tails: [], omittedAreaCount: 0, status };
}

function bareRange(start: number, end: number): PageRange {
  return { start, end, tails: [], omittedAreaCount: 0 };
}

/** A footer belongs to an atom only when that atom is one page of a split set.
 * Keeping this decision on the candidate range lets probe and live render the
 * same DOM without a separate reserved footer height. */
export function pageRangeNeedsFooter(range: Pick<PageRange, "start" | "end">, itemCount: number): boolean {
  return range.start > 0 || range.end < itemCount;
}

function quantize(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameProbeBox(left: { width: number; height: number }, right: { width: number; height: number }): boolean {
  return Math.abs(left.width - right.width) <= 1 && Math.abs(left.height - right.height) <= 1;
}

export function splitOnlyExactProbeId(input: {
  epoch: string;
  chromeSignature: string;
  sectionId: string;
  range: Pick<PageRange, "start" | "end">;
  probeBox: { width: number; height: number };
}): string {
  const box = `${quantize(input.probeBox.width)}x${quantize(input.probeBox.height)}`;
  return `${input.epoch}:chrome:${encodeURIComponent(input.chromeSignature)}:section:${encodeURIComponent(input.sectionId)}:range:${input.range.start}:${input.range.end}:box:${box}`;
}

/**
 * Pure state machine for the tsunami measurement shelf.  Boundaries only ever
 * increase within an epoch; this makes re-probing after chrome growth finite.
 */
export class SplitOnlyPartitionStateMachine {
  private snapshot: SplitOnlyPartitionSnapshot | null = null;
  private readonly opportunities = new Map<string, number>();
  private readonly resolvedProbes = new Map<string, boolean>();
  private requestedProbeIds = new Set<string>();
  private readonly seenCandidates = new Set<string>();
  private lastCandidate: string | null = null;

  reset(
    epoch: string,
    sections: readonly { id: string; itemCount: number }[],
    chromeSignature: string,
    probeBox: { width: number; height: number },
  ): SplitOnlyPartitionSnapshot {
    this.opportunities.clear();
    this.resolvedProbes.clear();
    this.requestedProbeIds.clear();
    this.seenCandidates.clear();
    this.lastCandidate = null;
    this.snapshot = {
      epoch,
      chromeSignature,
      probeBox: { width: quantize(probeBox.width), height: quantize(probeBox.height) },
      pendingProbes: [],
      pageCount: sections.filter(({ itemCount }) => itemCount > 0).length,
      logicalPasses: 0,
      stable: false,
      diagnostic: null,
      diagnosticProbeId: null,
      sections: sections.map(({ id, itemCount }) => ({
        id, itemCount,
        ranges: itemCount === 0 ? [] : [splitRange(0, itemCount, "pending")],
        pending: itemCount === 0 ? [] : [splitRange(0, itemCount, "pending")],
        infeasibleRanges: [],
      })),
    };
    return this.copySnapshot();
  }

  /** Record one actual sync/ResizeObserver delivery for the currently requested exact id. */
  recordProbeOpportunity(exactProbeId: string, fit: boolean | null): boolean {
    const state = this.snapshot;
    if (state == null || state.diagnostic != null || !this.requestedProbeIds.has(exactProbeId)
      || this.resolvedProbes.has(exactProbeId)) return false;
    const count = (this.opportunities.get(exactProbeId) ?? 0) + 1;
    this.opportunities.set(exactProbeId, count);
    if (fit != null) {
      this.resolvedProbes.set(exactProbeId, fit);
      return true;
    }
    if (count >= 3) {
      state.diagnostic = "partition-probe-unresolved";
      state.diagnosticProbeId = exactProbeId;
    }
    return true;
  }

  advance(input: {
    epoch: string;
    sections: readonly { id: string; itemCount: number }[];
    chromeSignature: string;
    probeBox: { width: number; height: number };
    /** Deterministic jsdom fallback only; browser delivery uses recordProbeOpportunity(). */
    fallbackProbe?: (sectionId: string, range: Pick<PageRange, "start" | "end">) => boolean;
  }): SplitOnlyPartitionSnapshot {
    const current = this.snapshot;
    if (current == null || current.epoch !== input.epoch
      || !sameProbeBox(current.probeBox, input.probeBox)
      || current.sections.length !== input.sections.length
      || current.sections.some((section, index) => section.id !== input.sections[index]?.id || section.itemCount !== input.sections[index]?.itemCount)) {
      this.reset(input.epoch, input.sections, input.chromeSignature, input.probeBox);
    }
    const state = this.snapshot!;
    if (state.diagnostic != null) return this.copySnapshot();
    if (state.chromeSignature !== input.chromeSignature) {
      state.chromeSignature = input.chromeSignature;
      state.stable = false;
      state.pendingProbes = [];
      this.requestedProbeIds.clear();
      for (const section of state.sections) {
        section.ranges = section.ranges.map((range) => range.status === "infeasible" ? range : { ...range, status: "pending" });
        section.pending = section.ranges.filter((range) => range.status === "pending");
      }
    }
    if (state.stable) return this.copySnapshot();

    const requested = new Map<string, SplitOnlyProbeRequest>();
    const tentativeSections: SplitOnlyPartitionSection[] = [];
    for (const section of state.sections) {
      const next: SplitOnlyPartitionRange[] = [];
      for (const range of section.ranges) {
        if (range.status !== "pending") { next.push(range); continue; }
        const parent = bareRange(range.start, range.end);
        const result = sequentialPartitionRanges(
          "tsunami",
          "center",
          range.end - range.start,
          1,
          (_key, _placement, localRange) => {
            const globalRange = bareRange(range.start + localRange.start, range.start + localRange.end);
            const id = splitOnlyExactProbeId({
              epoch: state.epoch,
              chromeSignature: state.chromeSignature,
              sectionId: section.id,
              range: globalRange,
              probeBox: state.probeBox,
            });
            const resolved = this.resolvedProbes.get(id);
            const fit = resolved ?? input.fallbackProbe?.(section.id, globalRange) ?? null;
            if (fit == null) {
              requested.set(id, {
                id,
                sectionId: section.id,
                range: globalRange,
                parentRange: parent,
                opportunities: this.opportunities.get(id) ?? 0,
              });
              return null;
            }
            return fit ? 0 : 2;
          },
          () => [],
        );
        if (result.pending.length > 0) {
          next.push(range);
        } else if (result.infeasible) {
          // sequentialPartitionRanges found that the first item itself does not fit.
          // Only that singleton becomes terminal; the remaining parent is kept pending.
          next.push(splitRange(range.start, range.start + 1, "infeasible"));
          if (range.start + 1 < range.end) next.push(splitRange(range.start + 1, range.end, "pending"));
        } else {
          next.push(...result.ranges.map((child) => splitRange(
            range.start + child.start,
            range.start + child.end,
            "ready",
          )));
        }
      }
      tentativeSections.push({
        ...section,
        ranges: next,
        pending: next.filter((range) => range.status === "pending"),
        infeasibleRanges: next.filter((range) => range.status === "infeasible"),
      });
    }

    state.pendingProbes = [...requested.values()];
    this.requestedProbeIds = new Set(requested.keys());
    if (requested.size > 0) return this.copySnapshot();

    state.sections = tentativeSections;
    state.pageCount = state.sections.reduce((total, section) => total + section.ranges.length, 0);
    state.logicalPasses += 1;
    const maximumPasses = input.sections.reduce((sum, section) => sum + section.itemCount, 0) - input.sections.length + 2;
    if (state.logicalPasses > Math.max(2, maximumPasses)) {
      state.diagnostic = "partition-nonconverged";
      return this.copySnapshot();
    }
    const candidate = this.candidateSignature(state);
    if (candidate === this.lastCandidate) {
      state.stable = true;
    } else if (this.seenCandidates.has(candidate)) {
      state.diagnostic = "partition-cycle";
    } else {
      this.seenCandidates.add(candidate);
      this.lastCandidate = candidate;
    }
    return this.copySnapshot();
  }

  private candidateSignature(state: SplitOnlyPartitionSnapshot): string {
    return JSON.stringify([
      state.chromeSignature,
      state.pageCount,
      state.probeBox,
      state.sections.map((section) => [section.id, section.ranges.map((range) => [range.start, range.end, range.status])]),
    ]);
  }

  private copySnapshot(): SplitOnlyPartitionSnapshot {
    const state = this.snapshot!;
    return {
      ...state,
      probeBox: { ...state.probeBox },
      sections: state.sections.map((section) => ({
        ...section,
        ranges: section.ranges.map((range) => ({ ...range, tails: [...range.tails] })),
        pending: section.pending.map((range) => ({ ...range, tails: [...range.tails] })),
        infeasibleRanges: section.infeasibleRanges.map((range) => ({ ...range, tails: [...range.tails] })),
      })),
      pendingProbes: state.pendingProbes.map((probe) => ({
        ...probe,
        range: { ...probe.range, tails: [...probe.range.tails] },
        parentRange: { ...probe.parentRange, tails: [...probe.parentRange.tails] },
        opportunities: this.opportunities.get(probe.id) ?? probe.opportunities,
      })),
    };
  }
}

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
