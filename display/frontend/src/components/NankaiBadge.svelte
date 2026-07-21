<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "nankaiTrough" }> } = $props();
</script>

<div class:critical={item.severity === "critical"} class="nankai-badge">
  南海トラフ臨時情報（{item.data.label}）発表中{#if item.restored}<RestoredChip />{/if}
</div>

<style>
  .nankai-badge { margin-top: var(--space-2); padding: var(--space-1) var(--space-3); border: 1px solid var(--role-weatherWarning); border-radius: var(--radius-s); color: var(--role-weatherWarning); background: color-mix(in srgb, var(--role-weatherWarning) 12%, var(--surface-standby)); font-size: max(14px, var(--type-label-l-fluid)); }
  .critical { color: var(--role-weatherEmergency); border-color: var(--role-weatherEmergency); background: color-mix(in srgb, var(--role-weatherEmergency) 16%, var(--surface-standby)); }
</style>
