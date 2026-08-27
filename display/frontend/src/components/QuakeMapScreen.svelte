<script lang="ts">
  import { onDestroy } from "svelte";
  import { fade } from "svelte/transition";
  import type { DisplayQuakeMapEventV1 } from "../lib/protocol";
  import { formatIntShort, formatMdHm } from "../lib/format";
  import { depthVisual, magnitudeVisual } from "../lib/magnitude";
  import { intensityVisual } from "../lib/quake-map-colors";
  import { groupByPrefecture } from "../lib/prefecture-group";
  import {
    PAGE_CITY_BUDGET,
    effectiveAreaCount,
    paginateAreas,
    shouldPageDetails,
  } from "../lib/instrument-layout";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { SPRING_EFFECTS_DEFAULT_MS, springEffectsOut } from "../lib/motion";
  import PageDots from "./PageDots.svelte";
  import QuakeMap from "./QuakeMap.svelte";
  import NumericSemanticLegend from "./NumericSemanticLegend.svelte";

  let {
    event,
    dim = false,
    reducedMotion = false,
  }: {
    event: DisplayQuakeMapEventV1;
    dim?: boolean;
    reducedMotion?: boolean;
  } = $props();

  const displayGroups = $derived(event.intensityGroups.filter((group) =>
    intensityVisual(group.intensitySemantic, formatIntShort(group.intensity), group.rank).render
  ));
  const totalEffective = $derived(
    displayGroups.reduce((sum, group) => sum + effectiveAreaCount(group), 0),
  );
  const paging = $derived(shouldPageDetails(totalEffective));
  const pages = $derived(paging ? paginateAreas(displayGroups, PAGE_CITY_BUDGET) : []);
  const resetKey = $derived(
    `${event.eventKey}:${event.sourceType}:${event.revision.reportTimeMs}:${event.revision.serial ?? ""}`,
  );
  const cycler = createPageCycler({
    pageCount: () => pages.length,
    resetKey: () => resetKey,
    reducedMotion: () => reducedMotion,
  });
  const currentPage = $derived(pages[cycler.index]);
  const pageFadeMs = $derived(cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS);
  const maxVisual = $derived(intensityVisual(event.maxIntSemantic, formatIntShort(event.maxInt), event.maxIntRank));
  const magnitude = $derived(magnitudeVisual(event.magnitudeSemantic, event.magnitude, "map"));
  const depth = $derived(depthVisual(event.depthSemantic, event.depth, "map"));

  function groupVisual(intensity: string, rank: number) {
    const group = displayGroups.find((item) => item.intensity === intensity && item.rank === rank);
    return intensityVisual(group?.intensitySemantic, formatIntShort(intensity), rank);
  }

  onDestroy(() => cycler.destroy());
</script>

<section class="quake-map-screen" class:dim aria-label={`${maxVisual.ariaLabel ?? "震度不明"}の地震情報`}>
  <header class="summary">
    <div class="summary-title">
      <span class="eyebrow">地震情報</span>
      {#if maxVisual.render}<span class="maximum" title={maxVisual.tooltip ?? undefined}>
        最大震度 {maxVisual.label ?? ""}
        {#if maxVisual.badge != null}<b class="semantic-badge">{maxVisual.badge}</b>{/if}
      </span>{/if}
    </div>
    <dl class="facts">
      <div><dt>発生</dt><dd>{formatMdHm(event.originTime ?? event.reportDateTime)}</dd></div>
      <div><dt>震源</dt><dd>{event.hypocenterName ?? "調査中"}</dd></div>
      {#if magnitude.render}<div><dt>{magnitude.numericValue != null ? "M" : "規模"}</dt><dd title={magnitude.tooltip ?? undefined} aria-label={event.magnitudeSemantic == null && event.magnitude == null ? "マグニチュード: -" : magnitude.ariaLabel}>{event.magnitudeSemantic == null && event.magnitude == null ? "-" : magnitude.numericValue != null ? magnitude.numericValue.toFixed(1) : magnitude.label}{#if magnitude.badge != null}<b class="semantic-badge">{magnitude.badge}</b>{/if}</dd></div>{/if}
      {#if depth.render}<div><dt>深さ</dt><dd title={depth.tooltip ?? undefined} aria-label={depth.ariaLabel}>{depth.label}{#if depth.badge != null}<b class="semantic-badge">{depth.badge}</b>{/if}</dd></div>{/if}
      {#if event.tsunamiWarning}<div class="tsunami"><dt>津波</dt><dd>津波情報あり</dd></div>{/if}
    </dl>
    <NumericSemanticLegend semantics={[event.magnitudeSemantic, event.depthSemantic]} />
  </header>

  <div class="content">
    <div class="map-pane">
      <QuakeMap {event} />
    </div>

    <section class="list-pane" aria-label="地域別の観測震度">
      <div class="list-header">
        <h2>地域別の観測震度</h2>
        {#if paging}
          <PageDots total={cycler.total} current={cycler.index} onJump={(index) => cycler.jumpTo(index)} />
        {/if}
      </div>

      {#if paging && currentPage != null}
        <div class="page-stage">
          {#key cycler.index}
            <div
              class="groups page"
              in:fade={{ duration: pageFadeMs, easing: springEffectsOut }}
              out:fade={{ duration: pageFadeMs, easing: springEffectsOut }}
            >
              {#each currentPage.sections as section (section.intensity)}
                {@const visual = groupVisual(section.intensity, section.rank)}
                <div class="group">
                  <span class="int-chip int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
                  <div class="pref-groups">
                    {#each section.prefGroups as prefGroup (prefGroup.pref ?? "その他")}
                      <div class="pref-group">
                        <span class="pref-name">
                          {prefGroup.pref ?? "その他"}{prefGroup.continuation ? "（続き）" : ""}
                        </span>
                        {#if prefGroup.cities.length > 0}
                          <span class="cities">{prefGroup.cities.join("、")}</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/key}
        </div>
      {:else}
        <div class="groups">
          {#each displayGroups as group (group.intensity)}
            {@const visual = intensityVisual(group.intensitySemantic, formatIntShort(group.intensity), group.rank)}
            <div class="group">
              <span class="int-chip int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
              <div class="pref-groups">
                {#each groupByPrefecture(group.areas) as prefGroup (prefGroup.pref ?? "その他")}
                  <div class="pref-group">
                    {#if prefGroup.pref != null}<span class="pref-name">{prefGroup.pref}</span>{/if}
                    {#if prefGroup.cities.length > 0}
                      <span class="cities">{prefGroup.cities.join("、")}</span>
                    {/if}
                  </div>
                {/each}
                {#if group.omittedAreaCount > 0}
                  <span class="omitted">ほか{group.omittedAreaCount}地域</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</section>

<style>
  .quake-map-screen {
    box-sizing: border-box;
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: var(--space-4);
    padding: var(--space-5);
    color: var(--fg);
    background: var(--bg);
  }
  .summary,
  .map-pane,
  .list-pane {
    background: var(--surface-panel);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-panel);
    box-shadow: var(--elevation-1);
    transition: opacity var(--spring-effects-default-dur) var(--spring-effects-default);
  }
  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    padding: var(--space-4) var(--space-5);
  }
  .summary-title {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
    white-space: nowrap;
  }
  .eyebrow {
    color: var(--role-warning);
    font-size: var(--type-label-l-size);
    font-weight: var(--type-label-weight);
  }
  .maximum {
    font-size: var(--type-headline-l-size);
    font-weight: var(--type-headline-weight-emphasized);
  }
  .facts {
    margin: 0;
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
  }
  .facts div {
    display: flex;
    gap: var(--space-2);
  }
  dt {
    color: var(--role-muted);
  }
  dd {
    margin: 0;
    font-weight: var(--type-body-weight-emphasized);
  }
  .tsunami dd {
    color: var(--role-tsunamiWarning);
  }
  .content {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.85fr);
    gap: var(--space-4);
  }
  .map-pane,
  .list-pane {
    min-height: 0;
    overflow: hidden;
  }
  .map-pane {
    padding: var(--space-3);
  }
  .list-pane {
    display: flex;
    flex-direction: column;
    padding: var(--space-4);
  }
  .list-header {
    display: flex;
    align-items: center;
    min-height: 32px;
    margin-bottom: var(--space-3);
  }
  h2 {
    margin: 0;
    font-size: var(--type-headline-s-size);
    font-weight: var(--type-headline-weight-emphasized);
  }
  .groups,
  .page-stage,
  .page {
    min-height: 0;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow: hidden;
  }
  .page-stage {
    position: relative;
    flex: 1;
  }
  .page {
    position: absolute;
    inset: 0;
  }
  .group {
    display: grid;
    grid-template-columns: minmax(48px, max-content) minmax(0, 1fr);
    gap: var(--space-3);
    align-items: start;
  }
  .int-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    border-radius: var(--radius-s);
    font-weight: var(--type-label-weight);
    background: var(--surface-panel-raised);
    max-width: 12em;
    overflow-wrap: anywhere;
  }
  .semantic-badge {
    margin-left: 0.25em;
    font-weight: var(--type-label-weight-emphasized);
  }
  .int-r1 { color: var(--int-1); }
  .int-r2 { color: var(--int-2); }
  .int-r3 { color: var(--int-3); }
  .int-r4 { color: var(--int-4); }
  .int-r5 { color: var(--int-5); }
  .int-r6 { color: var(--int-6); }
  .int-r7 { color: var(--int-7); }
  .int-r8 { color: var(--int-8-on); background: var(--int-8-bg); }
  .int-r9 { color: var(--int-9-on); background: var(--int-9-bg); }
  .int-chip.special-unknown { color: var(--c-raspberry); border: 1px dashed currentColor; }
  .int-chip.special-empty { color: var(--role-muted); border: 1px dotted currentColor; }
  .pref-groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    line-height: 1.55;
  }
  .pref-group {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-2);
  }
  .pref-name {
    color: var(--role-muted);
    font-weight: var(--type-body-weight-emphasized);
  }
  .cities,
  .omitted {
    overflow-wrap: anywhere;
  }
  .omitted {
    color: var(--role-muted);
  }
  .dim .summary,
  .dim .map-pane,
  .dim .list-pane {
    opacity: 0.7;
  }
  @media (prefers-reduced-motion: reduce) {
    .summary,
    .map-pane,
    .list-pane {
      transition-duration: 0ms;
    }
  }
</style>
