<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "heat" }> } = $props();
  const special = $derived(item.severity === "critical" || item.data.areas.some((area) => area.isSpecial));
</script>

<section class:critical={special} class="standby-card heat-card">
  <header>{special ? "熱中症特別警戒アラート" : "熱中症警戒アラート"}{#if item.restored}<RestoredChip />{/if}</header>
  <div class="date">{item.data.targetDate}</div>
  <div class="areas">{item.data.areas.map((area) => area.areaName).join("・")}</div>
</section>

<style>
  .standby-card { width: min(360px, 28vw); background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  header { padding: var(--space-2) var(--space-4); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-title-weight-emphasized); color: var(--role-weatherWarning); }
  .critical header { color: var(--role-weatherEmergency); background: color-mix(in srgb, var(--role-weatherEmergency) 16%, var(--surface-standby)); }
  .date, .areas { padding: 0 var(--space-4) var(--space-2); font-size: max(14px, var(--type-label-l-fluid)); }
  .areas { color: var(--role-muted); }
</style>
