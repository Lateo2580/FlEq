<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { VOLCANO_LEVEL_LABELS } from "../lib/standby-cards";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "volcano" }> } = $props();
</script>

<section class:critical={item.severity === "critical"} class="standby-card volcano-card">
  <header>火山情報{#if item.restored}<RestoredChip />{/if}</header>
  {#each item.data.volcanoes as volcano (volcano.code)}
    <div class="volcano"><span>{volcano.name}</span>{#if volcano.alertLevel != null}<span>レベル{volcano.alertLevel}（{VOLCANO_LEVEL_LABELS[volcano.alertLevel]}）</span>{/if}{#if volcano.latestEvent != null}<strong>{volcano.latestEvent}</strong>{/if}</div>
  {/each}
</section>

<style>
  .standby-card { width: min(360px, 28vw); background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  header { padding: var(--space-2) var(--space-4); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-title-weight-emphasized); }
  .critical header, .critical strong { color: var(--role-weatherEmergency); } .critical { background: color-mix(in srgb, var(--role-weatherEmergency) 8%, var(--surface-standby)); }
  .volcano { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); font-size: max(14px, var(--type-label-l-fluid)); } .volcano span + span::before { content: "　"; } strong { display: block; color: var(--role-weatherWarning); }
</style>
