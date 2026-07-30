<script lang="ts">
  import { onDestroy } from "svelte";
  import { fade } from "svelte/transition";
  import type { DisplayQuakeMapEventV1 } from "../lib/protocol";
  import { formatIntShort, formatMdHm } from "../lib/format";
  import { formatMagnitudeLabel, isNumericMagnitude } from "../lib/magnitude";
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

  let {
    event,
    dim = false,
  }: {
    event: DisplayQuakeMapEventV1;
    dim?: boolean;
  } = $props();

  const totalEffective = $derived(
    event.intensityGroups.reduce((sum, group) => sum + effectiveAreaCount(group), 0),
  );
  const paging = $derived(shouldPageDetails(totalEffective));
  const pages = $derived(paging ? paginateAreas(event.intensityGroups, PAGE_CITY_BUDGET) : []);
  const resetKey = $derived(
    `${event.eventKey}:${event.sourceType}:${event.revision.reportTimeMs}:${event.revision.serial ?? ""}`,
  );
  const cycler = createPageCycler({
    pageCount: () => pages.length,
    resetKey: () => resetKey,
  });
  const currentPage = $derived(pages[cycler.index]);
  const pageFadeMs = $derived(cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS);

  onDestroy(() => cycler.destroy());
</script>

<section class="quake-map-screen" class:dim aria-label="震度3から4の地震情報">
  <header class="summary">
    <div class="summary-title">
      <span class="eyebrow">地震情報</span>
      <span class="maximum">最大震度 {formatIntShort(event.maxInt)}</span>
    </div>
    <dl class="facts">
      <div><dt>発生</dt><dd>{formatMdHm(event.originTime ?? event.reportDateTime)}</dd></div>
      <div><dt>震源</dt><dd>{event.hypocenterName ?? "調査中"}</dd></div>
      <div><dt>{isNumericMagnitude(event.magnitude) ? "M" : "規模"}</dt><dd>{event.magnitude != null ? (isNumericMagnitude(event.magnitude) ? event.magnitude : formatMagnitudeLabel(event.magnitude)) : "-"}</dd></div>
      <div><dt>深さ</dt><dd>{event.depth ?? "-"}</dd></div>
      {#if event.tsunamiWarning}<div class="tsunami"><dt>津波</dt><dd>津波情報あり</dd></div>{/if}
    </dl>
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
                <div class="group">
                  <span class="int-chip int-r{section.rank}">{formatIntShort(section.intensity)}</span>
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
          {#each event.intensityGroups as group (group.intensity)}
            <div class="group">
              <span class="int-chip int-r{group.rank}">{formatIntShort(group.intensity)}</span>
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
    grid-template-columns: 48px minmax(0, 1fr);
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
