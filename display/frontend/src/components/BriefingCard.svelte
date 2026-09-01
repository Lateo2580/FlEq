<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type {
    ActiveStandbyCardV1,
    DisplayBriefingFactV1,
    DisplayBriefingKindV1,
    DisplayBriefingSummaryV1,
  } from "../lib/protocol";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { pageRangeNeedsFooter, sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  import RestoredChip from "./RestoredChip.svelte";

  type BriefingPartitionDebugContext = {
    chromeSignature: string;
    pendingProbeCount: number;
    cache: Array<{ id: string; fit: number }>;
    successorEpochStarts: number;
    lastSuccessorEpoch: string | null;
  };

  let {
    item,
    pageCoordinator: suppliedPageCoordinator,
    rotationMember = false,
    pageScheduling = false,
    partitionProbe,
    partitionRevision = "",
    partitionEpoch = "0",
    measurementWidthPx,
    measurementPageFooter,
    partitionDebugContext,
    partitionDebugEnabled = false,
    pagePlacement = "side",
    measurementRange,
    shellHeightPx = 260,
  }: {
    item: Extract<ActiveStandbyCardV1, { kind: "briefing" }>;
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    partitionProbe?: PartitionProbe;
    /** Parent-owned probe cache revision; keeps the live pager subscribed to
     * measurements that are collected in StandbyScreen's shelf. */
    partitionRevision?: string;
    /** Parent-owned measurement pass. Its first non-zero value starts the
     * shelf probe chain after StandbyScreen has mounted. */
    partitionEpoch?: string;
    /** Exact live-surface width supplied to an off-layout measurement card. */
    measurementWidthPx?: number;
    /** Once the live pager has settled, its page-count chrome is also used by
     * shelf probes. Undefined keeps the candidate-range rule during solve. */
    measurementPageFooter?: boolean;
    /** Temporary browser-only partition telemetry supplied by StandbyScreen. */
    partitionDebugContext?: BriefingPartitionDebugContext;
    partitionDebugEnabled?: boolean;
    pagePlacement?: "side" | "center";
    measurementRange?: PageRange;
    /** The solver, probe, and live outer shell share this declared page height. */
    shellHeightPx?: number;
  } = $props();

  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;
  const entries = $derived(item.data.entries);
  type BriefingFrameLevel = (typeof entries)[number]["frameLevel"];
  function frameRank(frameLevel: BriefingFrameLevel): number {
    if (frameLevel === "critical") return 3;
    if (frameLevel === "warning") return 2;
    return 1;
  }
  const topFrameLevel = $derived(
    [...entries].sort((a, b) => frameRank(b.frameLevel) - frameRank(a.frameLevel))[0]?.frameLevel ?? "info",
  );
  function headerContainerVar(frameLevel: BriefingFrameLevel): string {
    if (frameLevel === "critical") return "var(--header-weatherEmergency-container)";
    if (frameLevel === "warning") return "var(--header-weatherWarning-container)";
    return "var(--header-weatherAdvisory-container)";
  }
  function headerOnVar(frameLevel: BriefingFrameLevel): string {
    if (frameLevel === "critical") return "var(--header-weatherEmergency-on)";
    if (frameLevel === "warning") return "var(--header-weatherWarning-on)";
    return "var(--header-weatherAdvisory-on)";
  }
  function headerBandVar(frameLevel: BriefingFrameLevel): string {
    if (frameLevel === "critical") return "var(--header-band-weatherEmergency)";
    if (frameLevel === "warning") return "var(--header-band-weatherWarning)";
    return "var(--header-band-weatherAdvisory)";
  }
  const headerLabel = $derived(entries.every((entry) => entry.source === "vpoa50")
    ? "記録的短時間大雨情報"
    : "気象防災速報");
  const instantOf = (iso: string): number => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  const latestUpdatedAt = $derived(
    entries.reduce<string | null>(
      (latest, entry) => latest == null || instantOf(entry.updatedAt) > instantOf(latest) ? entry.updatedAt : latest,
      null,
    ) ?? item.updatedAt,
  );
  type BriefingBlockKind = "title" | "headline" | "vpoaHeadline" | "condition" | "areaContext" | "area" | "areaOverflow" | "areaDetail" | "lead" | "fact" | "meta";
  interface BriefingBlock {
    identity: string;
    label: string;
    entry: (typeof entries)[number];
    kind: BriefingBlockKind;
    text: string;
    areaNames?: string[];
    fact?: DisplayBriefingFactV1;
    summaryKind?: DisplayBriefingKindV1;
    vpoaSegments?: HeadlineSegment[];
  }
  // A single wire entry may be taller than the declared shell. Page the
  // independently readable rows, never the outer entry, so a long bulletin is
  // still complete rather than becoming an infeasible empty candidate.
  function chunks(text: string, size = 16): string[] {
    if (text === "") return [];
    // Preserve explicit line boundaries first. A run of line breaks must not
    // turn one otherwise short chunk into a shell-height-sized visual block.
    return text.split(/(\n)/).flatMap((line) => line === "\n"
      ? [line]
      : Array.from({ length: Math.ceil(line.length / size) }, (_, index) => line.slice(index * size, (index + 1) * size)))
      .filter((part) => part !== "");
  }
  function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }
  function nullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
  }
  function validFact(value: unknown): value is DisplayBriefingFactV1 {
    if (!isRecord(value) || typeof value.kind !== "string") return false;
    if (value.kind === "event") {
      return (value.label === "発生" || value.label === "予想")
        && nullableString(value.areaName) && nullableString(value.areaCode) && nullableString(value.at);
    }
    if (value.kind !== "precipitation" && value.kind !== "snowfall") return false;
    if (!(nullableString(value.locationName) && nullableString(value.locationCode)
      && typeof value.description === "string" && value.description.trim() !== "" && (typeof value.value === "number" || value.value === null)
      && nullableString(value.unit) && nullableString(value.at)
    )) return false;
    if (value.kind !== "precipitation") return true;
    return (!("duration" in value) || nullableString(value.duration))
      && (!("approximation" in value) || value.approximation === "approx" || value.approximation === "atLeast" || value.approximation === "exact" || value.approximation === "unknown");
  }
  function validSummary(value: unknown): value is DisplayBriefingSummaryV1 {
    if (!isRecord(value) || typeof value.mode !== "string" || typeof value.hasUnknownKind !== "boolean" || !Array.isArray(value.items)) return false;
    if (!(["structured", "mixed", "rawHeadlineFallback", "cancellation"] as const).includes(value.mode as DisplayBriefingSummaryV1["mode"])) return false;
    if ((value.mode === "structured" || value.mode === "mixed") && value.items.length === 0) return false;
    return value.items.every((item) => isRecord(item)
      && ["linearRainObserved", "linearRainPredicted", "recordRain", "shortSnow"].includes(item.kind as string)
      && typeof item.lead === "string" && item.lead.trim() !== ""
      && typeof item.sourceOrdinal === "number" && Number.isSafeInteger(item.sourceOrdinal)
      && Array.isArray(item.facts) && item.facts.every(validFact));
  }
  /** Additive Phase 1 subject fields are the version marker for structured wire.
   * Snapshots from before the marker retain the safe raw-headline renderer. */
  function hasBriefingSubjectWire(entry: (typeof entries)[number]): boolean {
    return typeof entry.editorialOffice === "string"
      && "phenomenonKind" in entry
      && "semanticKey" in entry
      && "serial" in entry;
  }
  function displayTime(value: string | null): string {
    if (value == null) return "時刻不明";
    const matched = /T(\d{2}:\d{2})/.exec(value);
    return matched == null ? value : matched[1]!;
  }
  function factText(fact: DisplayBriefingFactV1): string {
    if (fact.kind === "event") return `${displayTime(fact.at)} ${fact.label}`;
    const location = fact.locationName ?? "地点不明";
    const amount = fact.description || (fact.value == null ? "値不明" : `${fact.value}${fact.unit ?? ""}`);
    return `${location} ${amount} / ${displayTime(fact.at)}`;
  }
  type NormalizedOffset = {
    normalizedStart: number;
    normalizedEnd: number;
    sourceStart: number;
    sourceEnd: number;
  };
  type HeadlineSegment = { text: string; token: boolean };
  type HeadlineToken = { start: number; end: number; priority: number };
  const timePattern = /(?<![0-9])(?:[0-1]?[0-9]|2[0-3])時(?:[0-5]?[0-9]分)?(?!間|[0-9])/gu;
  const rainfallPattern = /(?:[0-9]+時間に)?約?[0-9]+ミリ(?:以上)?/gu;
  function escapedPattern(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function normalizedOffsets(source: string): { normalized: string; offsets: NormalizedOffset[] } {
    const offsets: NormalizedOffset[] = [];
    let normalized = "";
    let sourceStart = 0;
    for (const character of source) {
      const normalizedCharacter = character.normalize("NFKC");
      offsets.push({ normalizedStart: normalized.length, normalizedEnd: normalized.length + normalizedCharacter.length, sourceStart, sourceEnd: sourceStart + character.length });
      normalized += normalizedCharacter;
      sourceStart += character.length;
    }
    return { normalized, offsets };
  }
  function sourceRange(offsets: NormalizedOffset[], start: number, end: number): { start: number; end: number } | null {
    const covered = offsets.filter((offset) => offset.normalizedStart < end && start < offset.normalizedEnd);
    if (covered.length === 0 || covered[0]?.normalizedStart !== start || covered.at(-1)?.normalizedEnd !== end) return null;
    for (let index = 1; index < covered.length; index += 1) {
      if (covered[index - 1]!.normalizedEnd !== covered[index]!.normalizedStart || covered[index - 1]!.sourceEnd !== covered[index]!.sourceStart) return null;
    }
    return { start: covered[0]!.sourceStart, end: covered.at(-1)!.sourceEnd };
  }
  function vpoaHeadlineSegments(headline: string, areaNames: string[]): HeadlineSegment[] {
    const { normalized, offsets } = normalizedOffsets(headline);
    const targetCandidates = new Set(areaNames.filter((name) => name.trim() !== ""));
    const candidates = new Set(targetCandidates);
    const placePattern = /([一-龠々ぁ-んァ-ヶー]+?(?:、[一-龠々ぁ-んァ-ヶー]+?)*)(?:付近)?で(?:記録的短時間大雨)?/gu;
    for (const match of normalized.matchAll(placePattern)) {
      const candidateList = match[1]?.split("、") ?? [];
      if (match[0].endsWith("で記録的短時間大雨") || match[0].endsWith("付近で")) {
        for (const candidate of candidateList) {
          if (/[都道府県市区町村]$/.test(candidate)) candidates.add(candidate);
        }
      }
    }
    const proposed: HeadlineToken[] = [];
    const addMatches = (pattern: RegExp, priority: number): void => {
      for (const match of normalized.matchAll(pattern)) {
        const range = sourceRange(offsets, match.index, match.index + match[0].length);
        if (range != null) proposed.push({ ...range, priority });
      }
    };
    addMatches(timePattern, 3);
    addMatches(rainfallPattern, 2);
    for (const candidate of candidates) addMatches(new RegExp(`${escapedPattern(candidate.normalize("NFKC"))}(?:付近)?`, "gu"), 1);
    proposed.sort((left, right) => right.priority - left.priority || left.start - right.start || right.end - left.end);
    const accepted: HeadlineToken[] = [];
    for (const token of proposed) {
      if (!accepted.some((existing) => token.start < existing.end && existing.start < token.end)) accepted.push(token);
    }
    accepted.sort((left, right) => left.start - right.start);
    if (accepted.length === 0) return [{ text: headline, token: false }];
    const segments: HeadlineSegment[] = [];
    let cursor = 0;
    for (const token of accepted) {
      if (cursor < token.start) segments.push({ text: headline.slice(cursor, token.start), token: false });
      segments.push({ text: headline.slice(token.start, token.end), token: true });
      cursor = token.end;
    }
    if (cursor < headline.length) segments.push({ text: headline.slice(cursor), token: false });
    return segments;
  }
  /**
   * A VPOA headline may cross a page, but an emphasized token may not. Split
   * only the plain-text runs into ordinary headline-sized atoms; each strong
   * token remains whole even when it exceeds that advisory chunk length.
   */
  function vpoaHeadlineAtoms(segments: HeadlineSegment[], size = 16): HeadlineSegment[][] {
    const atoms: HeadlineSegment[][] = [];
    let current: HeadlineSegment[] = [];
    let length = 0;
    const push = (segment: HeadlineSegment): void => {
      const segmentLength = Array.from(segment.text).length;
      if (current.length > 0 && length + segmentLength > size) {
        atoms.push(current);
        current = [];
        length = 0;
      }
      current.push(segment);
      length += segmentLength;
      if (length >= size) {
        atoms.push(current);
        current = [];
        length = 0;
      }
    };
    for (const segment of segments) {
      if (segment.token) push(segment);
      else for (const part of chunks(segment.text, size)) push({ text: part, token: false });
    }
    if (current.length > 0) atoms.push(current);
    return atoms.length === 0 ? [[{ text: "", token: false }]] : atoms;
  }
  // Display context is deliberately narrower than a generic title heuristic.
  // Head.Title is trusted only when it is the canonical prefectural briefing
  // title, so an unrelated title can never manufacture a prefecture label.
  const PREFECTURES = "北海道|東京都|京都府|大阪府|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県";
  const PREFECTURAL_BRIEFING_TITLE = new RegExp(`^(${PREFECTURES})気象防災速報(?:\\([^)]*\\))?$`);
  function prefectureContext(title: string): string | null {
    return PREFECTURAL_BRIEFING_TITLE.exec(title.normalize("NFKC").trim())?.[1] ?? null;
  }
  function titleWithoutPrefectureContext(title: string, context: string | null): string {
    return context != null && title.startsWith(context) ? title.slice(context.length).trimStart() : title;
  }
  function addTargetAreas(
    entry: (typeof entries)[number],
    add: (kind: BriefingBlockKind, text: string, suffix: string, atomic?: boolean, areaNames?: string[]) => void,
    kind: "area" | "areaDetail" = "area",
  ): void {
    const names = entry.targetAreas.map((area) => area.name).filter((name) => name.trim() !== "");
    if (names.length === 0) return;
    // Code remains in targetAreas for transport/identity/audit, never in a
    // rendered text node. One element is the target-region DOM contract.
    // WeatherAlertCard と同じく地域名の span 群は一つの折返し可能な表示単位にする。
    add(kind, names.join("、"), `${kind}:${entry.targetAreas.map((area) => area.code).join(",")}`, true, names);
  }
  function addFallbackBlocks(
    result: BriefingBlock[], entry: (typeof entries)[number], add: (kind: BriefingBlockKind, text: string, suffix: string, atomic?: boolean, areaNames?: string[]) => void,
  ): void {
    add("title", entry.title, "raw-title");
    add("headline", entry.headline == null || entry.headline.trim() === "" ? "本文なし" : entry.headline, "raw-headline");
    for (const [index, condition] of entry.conditions.entries()) add("condition", condition, `raw-condition:${index}`);
    addTargetAreas(entry, add);
    add("meta", `${entry.publishingOffice}　${displayTime(entry.reportDateTime)}発表`, "meta");
  }
  function entryBlocks(entry: (typeof entries)[number]): BriefingBlock[] {
    const result: BriefingBlock[] = [];
    const add = (kind: BriefingBlockKind, text: string, suffix: string, atomic = false, areaNames?: string[], fact?: DisplayBriefingFactV1, vpoaSegments?: HeadlineSegment[], summaryKind?: DisplayBriefingKindV1): void => {
      for (const [index, part] of (atomic ? [text] : chunks(text)).entries()) result.push({
        identity: `${entry.key}:${kind}:${suffix}:${index}`, label: `${entry.title} ${kind}`, entry, kind, text: part, areaNames, fact, vpoaSegments, summaryKind,
      });
    };
    const summary = hasBriefingSubjectWire(entry) && validSummary(entry.summary) ? entry.summary : null;
    if (summary == null || summary.mode === "rawHeadlineFallback") {
      addFallbackBlocks(result, entry, add);
      return result;
    }
    if (summary.mode === "cancellation") {
      add("lead", "気象防災速報を取消", "cancel-lead");
      add("title", entry.title, "cancel-title");
      if (entry.headline != null && entry.headline.trim() !== "") add("headline", entry.headline, "cancel-headline");
      add("meta", `${entry.publishingOffice}　${displayTime(entry.reportDateTime)}発表`, "meta");
      return result;
    }
    for (const item of summary.items) add("lead", item.lead, `lead:${item.sourceOrdinal}`, true);
    const context = prefectureContext(entry.title);
    if (context != null) add("areaContext", context, "prefecture-context");
    const primaryAreas = entry.targetAreas.slice(0, 3);
    if (primaryAreas.length > 0) add("area", primaryAreas.map((area) => area.name).join("、"), `area:${primaryAreas.map((area) => area.code).join(",")}`, true, primaryAreas.map((area) => area.name));
    if (entry.targetAreas.length > 3) add("areaOverflow", `ほか${entry.targetAreas.length - 3}地域`, "area-overflow");
    if (entry.source === "vpoa50") {
      const headline = entry.headline == null || entry.headline.trim() === "" ? "本文なし" : entry.headline;
      for (const [index, atom] of vpoaHeadlineAtoms(vpoaHeadlineSegments(headline, entry.targetAreas.map((area) => area.name))).entries()) {
        const text = atom.map((segment) => segment.text).join("");
        result.push({
          identity: `${entry.key}:vpoaHeadline:vpoa-headline:${index}`,
          label: `${entry.title} vpoaHeadline`, entry, kind: "vpoaHeadline", text, vpoaSegments: atom,
        });
      }
    }
    add("meta", `${entry.publishingOffice}　${displayTime(entry.reportDateTime)}発表`, "meta");
    for (const item of summary.items) {
      for (const [index, fact] of item.facts.entries()) add("fact", factText(fact), `fact:${item.sourceOrdinal}:${fact.kind}:${fact.kind === "event" ? fact.areaCode ?? index : fact.locationCode ?? index}:${index}`, true, undefined, fact, undefined, item.kind);
    }
    if (entry.targetAreas.length > 3) {
      addTargetAreas(entry, add, "areaDetail");
    }
    if (summary.mode === "mixed") {
      // Keep the title's phenomenon detail for mixed summaries, but do not
      // repeat the prefecture already rendered as the entry context.
      add("title", titleWithoutPrefectureContext(entry.title, context), "mixed-title");
      add("headline", entry.headline == null || entry.headline.trim() === "" ? "本文なし" : entry.headline, "mixed-headline");
    }
    return result;
  }
  const blocks = $derived(entries.flatMap(entryBlocks));
  // These are the page atoms. An atom begins with the entry chrome whenever a
  // page range enters an entry, then carries that entry's independently
  // readable block. The renderer below groups adjacent atoms only after a
  // range is chosen, so a candidate crossing an entry boundary naturally
  // includes the second entry chrome in its measured DOM.
  const pageAtoms = $derived(blocks);
  const pagePartition = $derived.by(() => {
    const probeReads: Array<{ range: string; measured: number | null; basis: string }> = [];
    // partitionProbe closes over StandbyScreen's measurement cache. Keep that
    // parent revision in this derived graph, or a live card can retain its
    // initial all-block range after the shelf has already rejected it.
    const revision = partitionRevision;
    // The first render occurs before StandbyScreen's requestSettle() pass.
    // Subscribe to that pass explicitly: a revision cannot change until this
    // derived callback has first enqueued a shelf candidate.
    const epoch = partitionEpoch;
    if (measurementRange != null) return { ranges: [measurementRange], pending: [], infeasible: false, probeCount: 1, epoch, revision, probeReads };
    if (partitionProbe != null) {
      // Browser shelves may return their natural candidate height while
      // jsdom and older callers retain the common 0/2 fit sentinel. Compare
      // real measurements with this card's declared shell budget; only the
      // explicit 2 sentinel means overflow. A 1px budget made every positive
      // natural height fail and selected the first atom of every page.
      const partition = sequentialPartitionRanges(
        "briefing",
        pagePlacement,
        pageAtoms.length,
        shellHeightPx,
        (key, placement, range, tails) => {
          const measured = partitionProbe(key, placement, range, tails);
          const basis = measured === 2 ? shellHeightPx + 1 : measured;
          probeReads.push({ range: `${range.start}:${range.end}`, measured, basis: basis == null ? "pending" : `${basis}` });
          return basis;
        },
        () => [],
      );
      // An atomic block can still exceed the physical shelf (for example a
      // narrow-font long token). Keep the already measured maximum prefixes.
      // Crucially, advance past an infeasible singleton and keep probing its
      // suffix: stopping at 4:5 used to leave 5:6+ unmeasured and converted
      // the whole remaining card into one-block pages.
      if (partition.infeasible) {
        const preservedRanges: PageRange[] = [];
        let start = 0;
        while (start < pageAtoms.length) {
          let acceptedEnd = start;
          for (let end = start + 1; end <= pageAtoms.length; end += 1) {
            const range = { start, end, tails: [], omittedAreaCount: 0 };
            const measured = partitionProbe("briefing", pagePlacement, range, []);
            if (measured == null || measured === 2) break;
            acceptedEnd = end;
          }
          if (acceptedEnd === start) {
            preservedRanges.push({ start, end: start + 1, tails: [], omittedAreaCount: 0 });
            start += 1;
            continue;
          }
          preservedRanges.push({ start, end: acceptedEnd, tails: [], omittedAreaCount: 0 });
          start = acceptedEnd;
        }
        return {
        ranges: preservedRanges,
        pending: [], infeasible: false, probeCount: partition.probeCount, epoch, revision, probeReads,
        };
      }
      return { ...partition, epoch, revision, probeReads };
    }
    return { ranges: [{ start: 0, end: pageAtoms.length, tails: [], omittedAreaCount: 0 }], pending: [], infeasible: false, probeCount: 0, epoch, revision, probeReads };
  });
  const partitionDebug = $derived(JSON.stringify({
    chromeSignature: partitionDebugContext?.chromeSignature ?? null,
    pendingProbeCount: partitionDebugContext?.pendingProbeCount ?? null,
    cache: partitionDebugContext?.cache ?? [],
    successorEpochStarts: partitionDebugContext?.successorEpochStarts ?? null,
    lastSuccessorEpoch: partitionDebugContext?.lastSuccessorEpoch ?? null,
    partitionEpoch: pagePartition.epoch,
    partitionRevision: pagePartition.revision,
    pageAtoms: pageAtoms.length,
    probeReads: pagePartition.probeReads,
    ranges: pagePartition.ranges.map((range) => `${range.start}:${range.end}`),
    pending: pagePartition.pending.map((pending) => pending.id),
    infeasible: pagePartition.infeasible,
  }));
  const pageIdentities = $derived(pagePartition.ranges.map((range, index) => blocks[range.start]?.identity ?? `briefing:page:${index + 1}`));
  const pageLabels = $derived(pagePartition.ranges.map((range, index) => blocks[range.start]?.label ?? `page-${index + 1}`));
  // Content revisions retain their entry key and therefore the current page;
  // a real source-to-canonical replacement is an identity change, not a text heuristic.
  const resetKey = $derived(blocks.map((block) => block.identity).join(","));
  $effect(() => {
    if (!pageScheduling || pagePartition.pending.length > 0) return;
    pageCoordinator.register({
      key: "briefing",
      identities: pageIdentities,
      labels: pageLabels,
      rotationMember,
      resetKey,
    });
  });
  onDestroy(() => { if (ownsPageCoordinator) pageCoordinator.dispose(); });

  const currentPageIndex = $derived(pageCoordinator.activeIndex("briefing"));
  const currentRange = $derived(measurementRange ?? pagePartition.ranges[currentPageIndex] ?? pagePartition.ranges[0] ?? null);
  const visibleBlocks = $derived(currentRange == null ? [] : pageAtoms.slice(currentRange.start, currentRange.end));
  const visibleGroups = $derived.by(() => {
    const groups: Array<{ entry: (typeof entries)[number]; blocks: BriefingBlock[] }> = [];
    for (const block of visibleBlocks) {
      const previous = groups[groups.length - 1];
      if (previous?.entry.key === block.entry.key) previous.blocks.push(block);
      else groups.push({ entry: block.entry, blocks: [block] });
    }
    return groups;
  });
  const diagnostics = $derived(pageCoordinator.cardDiagnostics("briefing"));
  const probeWidth = $derived(measurementRange != null && measurementWidthPx != null && measurementWidthPx > 0
    ? measurementWidthPx
    : null);
  // A full candidate has no page footer. A split candidate does. This is the
  // same boundary rule for the probe, live card, and pager; no fixed footer
  // reservation is guessed outside the rendered atom.
  const showPageIndicator = $derived(currentRange != null && (measurementRange != null && measurementPageFooter != null
    ? measurementPageFooter
    : pageRangeNeedsFooter(currentRange, pageAtoms.length)));
  // Probes share the live coordinator, so this label updates to exactly the
  // pager text of the matching final range rather than estimating "2 pages".
  const pageIndicatorLabel = $derived(diagnostics.page);
</script>

{#snippet briefingBlock(block: BriefingBlock)}
  {#if block.kind === "title"}<h2 data-briefing-block={block.identity}>{block.text}</h2>
  {:else if block.kind === "headline"}<p class="headline" data-briefing-block={block.identity}>{block.text}</p>
  {:else if block.kind === "vpoaHeadline"}<p class="headline" data-briefing-vpoa-headline data-briefing-block={block.identity}>{#each block.vpoaSegments ?? [{ text: block.text, token: false }] as segment}{#if segment.token}<strong class="vpoa-headline-segment" data-briefing-vpoa-token>{segment.text}</strong>{:else}<span class="vpoa-headline-segment">{segment.text}</span>{/if}{/each}</p>
  {:else if block.kind === "condition"}<p class="conditions" data-briefing-block={block.identity}>{block.text}</p>
  {:else if block.kind === "lead"}<h2 class="lead" data-briefing-block={block.identity}>{block.text}</h2>
  {:else if block.kind === "areaContext"}<div class="pref-group" data-briefing-prefecture-context data-briefing-block={block.identity}><span class="pref-name">{block.text}</span></div>
  {:else if block.kind === "area"}<div class="pref-group" data-briefing-target-regions data-briefing-block={block.identity}><span class="cities">{#each block.areaNames ?? [block.text] as area, index}<span class="city-name">{index === 0 ? "対象: " : ""}{area}</span>{/each}</span></div>
  {:else if block.kind === "areaOverflow"}<span class="omitted" data-briefing-block={block.identity}>{block.text}</span>
  {:else if block.kind === "areaDetail"}<div class="pref-group" data-briefing-target-regions data-briefing-block={block.identity}><span class="cities">{#each block.areaNames ?? [block.text] as area, index}<span class="city-name">{index === 0 ? "対象: " : ""}{area}</span>{/each}</span></div>
  {:else if block.kind === "fact" && block.fact?.kind === "event"}
    <p class="fact briefing-event-fact" data-briefing-event-fact data-briefing-block={block.identity}><strong>{block.fact.areaName ?? "地点不明"}</strong><span>　{block.fact.label}　</span><strong>{displayTime(block.fact.at)}</strong></p>
  {:else if block.kind === "fact" && block.fact?.kind === "precipitation" && (block.entry.source !== "vpbs50" || block.summaryKind !== "recordRain" || block.fact.value == null || block.fact.unit == null)}
    <p class="fact" data-briefing-block={block.identity}>{block.text}</p>
  {:else if block.kind === "fact" && block.fact?.kind === "precipitation"}
    <div class="briefing-fact-grid" data-briefing-precipitation-stat data-briefing-block={block.identity}>
      {#if block.fact.locationName != null}<div class="briefing-fact-stat" data-briefing-precipitation-location><span class="briefing-fact-label">地点</span><span class="briefing-fact-value">{block.fact.locationName}</span></div>{/if}
      <div class="briefing-fact-stat" data-briefing-precipitation-amount><span class="briefing-fact-label">雨量</span><span class="briefing-fact-value">{#if block.fact.approximation === "approx"}約{" "}{/if}<span class="briefing-fact-token"><NumberUnit value={String(block.fact.value)} unit={block.fact.unit ?? ""} /></span>{#if block.fact.approximation === "atLeast"}{" "}以上{/if}</span></div>
      {#if block.fact.at != null}<div class="briefing-fact-stat" data-briefing-precipitation-time><span class="briefing-fact-label">時刻</span><span class="briefing-fact-value">{displayTime(block.fact.at)}</span></div>{/if}
      {#if block.fact.duration != null}<div class="briefing-fact-stat" data-briefing-precipitation-duration><span class="briefing-fact-label">時間幅</span><span class="briefing-fact-value">{block.fact.duration}</span></div>{/if}
    </div>
  {:else if block.kind === "fact"}<p class="fact" data-briefing-block={block.identity}>{block.text}</p>
  {:else}<p class="meta" data-briefing-block={block.identity}>{block.text}</p>
  {/if}
{/snippet}

{#snippet pageAtom(groups: Array<{ entry: (typeof entries)[number]; blocks: BriefingBlock[] }>, hasFooter: boolean, footerLabel: string)}
  <div data-briefing-page-atom data-briefing-page-atom-range={currentRange == null ? "" : `${currentRange.start}:${currentRange.end}`}>
    {#each groups as group, groupIndex (group.blocks[0]?.identity)}
      {@const entry = group.entry}
      <article class="briefing-entry" class:entry-divider={groupIndex > 0} data-briefing-entry={entry.key} data-briefing-page-atom-entry data-frame-level={entry.frameLevel}>
        <div class="body" data-page-probe-body data-page-probe-readable>
          <div class="entry-label" data-briefing-entry-label>
          <span>{entry.source === "vpbs50" ? "気象速報" : "記録的短時間大雨情報"}</span>
          <span class="source">{entry.infoType}</span>
          </div>
          {#each group.blocks as block (block.identity)}
            {@render briefingBlock(block)}
          {/each}
        </div>
      </article>
    {/each}
    {#if hasFooter}<footer class="card-page-footer" data-card-page-footer><span class="card-page-indicator" data-card-page-indicator>{footerLabel}</span></footer>{/if}
  </div>
{/snippet}

<section
  class="briefing-card"
  class:has-page-footer={showPageIndicator}
  style={`${measurementRange == null ? `height: ${shellHeightPx}px;` : ""}${probeWidth == null ? "" : ` width: ${probeWidth}px; max-width: ${probeWidth}px;`}`}
  data-briefing-card
  data-briefing-top-frame={topFrameLevel}
  data-page-probe-card={measurementRange != null ? "" : undefined}
  data-card-page={diagnostics.page}
  data-card-page-pending={pagePartition.pending.length > 0 ? "true" : "false"}
  data-card-page-keys={JSON.stringify(diagnostics.keys)}
  data-card-page-identities={JSON.stringify(diagnostics.identities)}
  data-briefing-page-range={currentRange == null ? "" : `${currentRange.start}:${currentRange.end}`}
  data-briefing-generation={item.data.generation}
  data-briefing-shell-height-px={shellHeightPx}
  data-briefing-probe-width-px={probeWidth ?? undefined}
  data-briefing-partition-debug={partitionDebugEnabled ? partitionDebug : undefined}
>
  <header
    class="standby-card-header"
    class:critical={topFrameLevel === "critical"}
    class:warning={topFrameLevel === "warning"}
    class:advisory={topFrameLevel === "info" || topFrameLevel === "cancel"}
    data-briefing-card-header
    style="--standby-header-container: {headerContainerVar(topFrameLevel)}; --standby-header-on: {headerOnVar(topFrameLevel)}; --standby-header-band: {headerBandVar(topFrameLevel)}"
  ><span class="standby-card-header__title">{headerLabel}</span><span class="standby-card-header__meta">{#if item.restored}<RestoredChip />{/if}<UpdatedStamp iso={latestUpdatedAt} /></span></header>
  {@render pageAtom(visibleGroups, showPageIndicator, pageIndicatorLabel)}
</section>

<style>
  .briefing-card { position: relative; box-sizing: border-box; width: 100%; max-width: 100%; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); box-shadow: var(--elevation-2); color: var(--fg); }
  .briefing-entry { min-height: 0; }
  .briefing-entry.entry-divider { border-top: 1px solid var(--hairline); }
  .body { padding: var(--space-2) var(--space-4); }
  .entry-label { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--role-muted); font-size: var(--type-label-s-fluid); font-weight: var(--type-body-weight-emphasized); }
  .source { color: inherit; font-size: var(--type-label-s-fluid); font-weight: var(--type-body-weight-regular); }
  h2, p { margin: 0; }
  h2 { font-size: var(--type-label-l-fluid); line-height: 1.35; }
  .lead { color: var(--role-weatherWarning); }
  .headline { margin-top: var(--space-1); font-size: var(--type-body-s-fluid); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .vpoa-headline-segment { display: inline; }
  .conditions, .fact, .meta { margin-top: var(--space-1); color: var(--role-muted); font-size: var(--type-label-s-fluid); line-height: 1.35; }
  .fact { color: var(--role-text); }
  .briefing-event-fact { break-inside: avoid; }
  .briefing-fact-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
    gap: var(--space-1) var(--space-3);
    /* Keep the specified 9rem cell floor even in the narrow side card. The
       body has 4-space inline padding, which otherwise leaves just under two
       9rem columns and turns one atomic observation into four tall rows.
       Borrow that horizontal gutter for the grid only; the stat cells remain
       9rem-or-wider and the observation stays one indivisible page atom. */
    margin: var(--space-1) calc(-1 * var(--space-4)) 0;
    break-inside: avoid;
  }
  .briefing-fact-stat { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .briefing-fact-label { display: inline-block; align-self: flex-start; white-space: nowrap; color: var(--role-muted); font-size: var(--type-label-xs-size); }
  .briefing-fact-value { display: flex; flex-wrap: wrap; gap: 0 var(--space-1); min-width: 0; color: var(--fg); font-size: max(14px, var(--type-body-l-fluid)); font-weight: var(--num-weight); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .briefing-fact-token { display: inline-block; white-space: nowrap; }
  /* WeatherAlertCard と同じ地域階層トークン。Phase 2 の data 属性は外側の group に保つ。 */
  .pref-group { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5em; margin-top: var(--space-1); padding-left: 1em; break-inside: avoid; }
  .pref-name { flex-shrink: 0; font-weight: var(--type-body-weight-emphasized); font-size: max(14px, var(--type-body-s-fluid)); color: var(--fg); }
  .cities { display: inline-flex; flex-wrap: wrap; padding-left: 0.5em; gap: 0.5em; color: var(--role-muted); font-size: max(14px, var(--type-label-s-fluid)); }
  .city-name { white-space: nowrap; }
  .omitted { display: block; margin-top: var(--space-1); padding-left: 1em; color: var(--role-muted); font-size: var(--type-label-xs-size); }
  .briefing-card.has-page-footer { --card-page-indicator-block-size: calc(var(--type-label-xs-size) + 4px); padding-bottom: var(--card-page-indicator-block-size); }
  .briefing-card.has-page-footer .standby-card-header { padding-top: calc(var(--space-2) - 3px); padding-bottom: calc(var(--space-2) - 3px); }
  /* The card reserves this slot with has-page-footer padding. Keep the
     indicator inside it: a zero-height, visible-overflow footer inflates
     scrollHeight by its 16px content and falsely rejects probe ranges. */
  .card-page-footer { position: absolute; inset-inline: 0; bottom: 0; display: flex; align-items: center; justify-content: flex-end; box-sizing: border-box; height: var(--card-page-indicator-block-size); min-height: var(--card-page-indicator-block-size); padding: 0 var(--space-4); overflow: hidden; pointer-events: none; z-index: 1; }
  .card-page-indicator { box-sizing: border-box; block-size: var(--card-page-indicator-block-size); padding: 1px var(--space-2); border: 1px solid var(--hairline); border-radius: var(--radius-s); background: color-mix(in srgb, var(--surface-standby) 92%, transparent); color: var(--role-muted); font-size: var(--type-label-xs-size); line-height: 1; font-variant-numeric: tabular-nums; }
</style>
