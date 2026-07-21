<script lang="ts">
  import { onMount } from "svelte";
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { layoutFloodWideRows } from "../lib/standby-cards";

  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "flood" }> } = $props();
  let viewportHeightPx = $state(typeof window === "undefined" ? 720 : window.innerHeight);
  const layout = $derived(layoutFloodWideRows(item.data.rivers, viewportHeightPx));

  onMount(() => {
    const updateViewport = (): void => { viewportHeightPx = window.innerHeight; };
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  });
</script>

<section class:critical={item.severity === "critical"} class="standby-card flood-wide-card">
  <header>河川洪水情報</header>
  <div class="river-grid">
    {#each layout.visible as river (river.riverKey)}
      <div class:critical-river={river.levelRank >= 40} class="river-row">{river.riverName}　{river.kindName}（{river.level}）</div>
    {/each}
    {#if layout.omittedCount > 0}
      <div class="more-rivers">ほか {layout.omittedCount} 河川</div>
    {/if}
  </div>
</section>

<style>
  .standby-card { width: min(720px, 56vw); max-height: 30vh; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  header { padding: var(--space-2) var(--space-4); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-title-weight-emphasized); }
  .river-grid { display: grid; grid-template-columns: 1fr 1fr; }
  .river-row, .more-rivers { min-height: 40px; padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .river-row:nth-child(even) { border-left: 1px solid var(--hairline); }
  .more-rivers { grid-column: 1 / -1; color: var(--role-muted); text-align: center; }
  .critical { background: color-mix(in srgb, var(--role-weatherEmergency) 8%, var(--surface-standby)); }
  .critical header, .critical-river { color: var(--role-weatherEmergency); }
</style>
