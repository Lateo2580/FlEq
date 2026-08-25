<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";

  let {
    item,
    pageCoordinator: suppliedPageCoordinator,
    rotationMember = false,
    pageScheduling = false,
    partitionProbe,
    pagePlacement = "side",
    measurementRange,
    measurementPageFooter = false,
    shellHeightPx = 260,
  }: {
    item: Extract<ActiveStandbyCardV1, { kind: "briefing" }>;
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    partitionProbe?: PartitionProbe;
    pagePlacement?: "side" | "center";
    measurementRange?: PageRange;
    measurementPageFooter?: boolean;
    /** The solver, probe, and live outer shell share this declared page height. */
    shellHeightPx?: number;
  } = $props();

  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;
  const entries = $derived(item.data.entries);
  type BriefingBlockKind = "title" | "headline" | "condition" | "area" | "qualifier" | "meta";
  interface BriefingBlock {
    identity: string;
    label: string;
    entry: (typeof entries)[number];
    kind: BriefingBlockKind;
    text: string;
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
  function entryBlocks(entry: (typeof entries)[number]): BriefingBlock[] {
    const result: BriefingBlock[] = [];
    const add = (kind: BriefingBlockKind, text: string, suffix: string): void => {
      for (const [index, part] of chunks(text).entries()) result.push({
        identity: `${entry.key}:${kind}:${suffix}:${index}`, label: `${entry.title} ${kind}`, entry, kind, text: part,
      });
    };
    add("title", entry.title, "title");
    if (entry.headline != null) add("headline", entry.headline, "headline");
    for (const [index, condition] of entry.conditions.entries()) add("condition", condition, String(index));
    for (const [index, area] of entry.targetAreas.entries()) add("area", area.name, `${area.code}:${index}`);
    if (entry.qualifier != null) add("qualifier", entry.qualifier, "qualifier");
    add("meta", `${entry.publishingOffice}　${entry.reportDateTime}`, "meta");
    return result;
  }
  const blocks = $derived(entries.flatMap(entryBlocks));
  const pagePartition = $derived.by(() => {
    if (measurementRange != null) return { ranges: [measurementRange], pending: [], infeasible: false, probeCount: 1 };
    if (partitionProbe != null) {
      const partition = sequentialPartitionRanges("briefing", pagePlacement, blocks.length, shellHeightPx, partitionProbe, () => []);
      // An atomic block can still exceed the physical shelf (for example a
      // narrow-font long token). Never convert that into an empty card: retain
      // every block on a stable one-block page until a future measurement can
      // accept a denser partition.
      if (partition.infeasible) return {
        ranges: blocks.map((_, index) => ({ start: index, end: index + 1, tails: [], omittedAreaCount: 0 })),
        pending: [], infeasible: false, probeCount: partition.probeCount,
      };
      return partition;
    }
    return { ranges: [{ start: 0, end: blocks.length, tails: [], omittedAreaCount: 0 }], pending: [], infeasible: false, probeCount: 0 };
  });
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
  const visibleBlocks = $derived(currentRange == null ? [] : blocks.slice(currentRange.start, currentRange.end));
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
  const showPageIndicator = $derived(measurementRange != null
    ? measurementPageFooter
    : pageScheduling && pagePartition.ranges.length > 1);
  const pageIndicatorLabel = $derived(measurementRange != null
    ? `${measurementRange.start > 0 ? 2 : 1}/${measurementRange.end < blocks.length ? 2 : 1}`
    : diagnostics.page);
</script>

<section
  class="briefing-card"
  style:height={`${shellHeightPx}px`}
  data-briefing-card
  data-page-probe-card={measurementRange != null ? "" : undefined}
  data-card-page={diagnostics.page}
  data-card-page-keys={JSON.stringify(diagnostics.keys)}
  data-card-page-identities={JSON.stringify(diagnostics.identities)}
  data-briefing-page-range={currentRange == null ? "" : `${currentRange.start}:${currentRange.end}`}
  data-briefing-generation={item.data.generation}
>
  {#each visibleGroups as group (group.blocks[0]?.identity)}
    {@const entry = group.entry}
    <article class="briefing-entry" data-briefing-entry={entry.key} data-frame-level={entry.frameLevel}>
      <header class:critical={entry.frameLevel === "critical"} class:warning={entry.frameLevel === "warning"} class:info={entry.frameLevel === "info"} class:cancel={entry.frameLevel === "cancel"}>
        <span>{entry.source === "vpbs50" ? "気象速報" : "記録的短時間大雨情報"}</span>
        <span class="source">{entry.infoType}</span>
      </header>
      <div class="body" data-page-probe-body data-page-probe-readable>
        {#each group.blocks as block (block.identity)}
          {#if block.kind === "title"}<h2 data-briefing-block={block.identity}>{block.text}</h2>
          {:else if block.kind === "headline"}<p class="headline" data-briefing-block={block.identity}>{block.text}</p>
          {:else if block.kind === "condition"}<p class="conditions" data-briefing-block={block.identity}>{block.text}</p>
          {:else if block.kind === "area"}<p class="areas" data-briefing-block={block.identity}>対象: {block.text}</p>
          {:else if block.kind === "qualifier"}<p class="qualifier" data-briefing-block={block.identity}>{block.text}</p>
          {:else}<p class="meta" data-briefing-block={block.identity}>{block.text}</p>
          {/if}
        {/each}
      </div>
    </article>
  {/each}
  {#if showPageIndicator}<footer class="card-page-footer" data-card-page-footer><span class="card-page-indicator">{pageIndicatorLabel}</span></footer>{/if}
</section>

<style>
  .briefing-card { box-sizing: border-box; width: 100%; max-width: 100%; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); box-shadow: var(--elevation-2); }
  .briefing-entry { min-height: 0; }
  header { display: flex; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-bottom: var(--header-band-width) solid var(--header-band-weatherWarning); background: var(--header-weatherWarning-container); color: var(--header-weatherWarning-on); font-size: var(--type-title-s-fluid); font-weight: var(--type-title-weight-emphasized); }
  header.critical { border-bottom-color: var(--header-band-weatherEmergency); background: var(--header-weatherEmergency-container); color: var(--header-weatherEmergency-on); }
  header.info { border-bottom-color: var(--role-info); background: var(--surface-standby); color: var(--role-info); }
  header.cancel { border-bottom-color: var(--hairline); background: var(--surface-standby); color: var(--role-muted); }
  .source { color: inherit; font-size: var(--type-label-s-fluid); font-weight: var(--type-body-weight-regular); }
  .body { padding: var(--space-2) var(--space-4); }
  h2, p { margin: 0; }
  h2 { font-size: var(--type-label-l-fluid); line-height: 1.35; }
  .headline { margin-top: var(--space-1); font-size: var(--type-body-s-fluid); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .conditions, .areas, .qualifier, .meta { margin-top: var(--space-1); color: var(--role-muted); font-size: var(--type-label-s-fluid); line-height: 1.35; }
  .qualifier { color: var(--role-weatherWarning); }
  .card-page-footer { display: flex; justify-content: flex-end; padding: var(--space-1) var(--space-4); border-top: 1px solid var(--hairline); }
  .card-page-indicator { padding: 1px var(--space-2); border: 1px solid var(--hairline); border-radius: var(--radius-s); color: var(--role-muted); font-size: var(--type-label-xs-size); line-height: 1; font-variant-numeric: tabular-nums; }
</style>
