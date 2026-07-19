<script lang="ts">
  import type { DisplayReferenceSection } from "../lib/api";

  let { sections }: { sections: DisplayReferenceSection[] } = $props();
</script>

{#if sections.length > 0}
  <div class="reference-pane">
    <h2>display-reference</h2>
    {#each sections as s (s.heading)}
      <details>
        <summary>{s.heading}</summary>
        <pre class="reference-md">{s.markdown}</pre>
      </details>
    {/each}
  </div>
{/if}

<style>
  .reference-pane { margin-top: 8px; }
  h2 { font-size: 13px; margin: 0 0 6px; color: #8a93a2; }
  summary { font-size: 12px; cursor: pointer; color: #9fb7d4; padding: 2px 0; }
  .reference-md {
    font-family: Consolas, Menlo, monospace; font-size: 11px; line-height: 1.4;
    background: #101216; border: 1px solid #2a2e36; border-radius: 4px;
    padding: 8px; max-height: 30vh; overflow: auto; white-space: pre-wrap;
  }
</style>
