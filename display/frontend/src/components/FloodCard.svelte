<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "flood" }> } = $props();
</script>

<section class:critical={item.severity === "critical"} class="standby-card flood-card">
  <header>河川洪水情報{#if item.restored}<RestoredChip />{/if}</header>
  {#each item.data.rivers as river (river.riverKey)}
    <div class:critical-river={river.levelRank >= 40} class="river-row">{river.riverName}　{river.kindName}（{river.level}）</div>
  {/each}
</section>

<style>
  .standby-card { width: min(360px, 28vw); background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  header { padding: var(--space-2) var(--space-4); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-title-weight-emphasized); }
  .river-row { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; }
  .critical { background: color-mix(in srgb, var(--role-weatherEmergency) 8%, var(--surface-standby)); }
  .critical header, .critical-river { color: var(--role-weatherEmergency); }
</style>
