<script lang="ts">
  import type { DisplayNumericSpecialValueSemanticV1 } from "../lib/protocol";

  let { semantics }: { semantics: Array<DisplayNumericSpecialValueSemanticV1 | undefined> } = $props();

  const ITEMS = [
    { badge: "≥", meaning: "以上（下限値）" },
    { badge: "↔", meaning: "範囲" },
    { badge: "?", meaning: "不明・定性値" },
    { badge: "∅", meaning: "空欄" },
  ] as const;
  const visible = $derived(ITEMS.filter((item) => semantics.some((semantic) => semantic?.badge === item.badge)));
</script>

{#if visible.length > 0}
  <div class="numeric-semantic-legend" aria-label="マグニチュードと深さの記号の凡例">
    {#each visible as item (item.badge)}
      <span><b>{item.badge}</b>{item.meaning}</span>
    {/each}
  </div>
{/if}

<style>
  .numeric-semantic-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35em 0.8em;
    color: var(--role-muted);
    font-size: var(--type-label-xs-fluid, 0.72rem);
  }
  span { white-space: nowrap; }
  b { margin-right: 0.2em; color: var(--fg); }
</style>
