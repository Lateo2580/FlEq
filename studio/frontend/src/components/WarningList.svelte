<script lang="ts">
  let { warnings }: { warnings: string[] } = $props();
</script>

{#if warnings.length > 0}
  <div class="warning-list">
    <h2>警告</h2>
    <ul>
      {#each warnings as w, i (i)}
        <li>{w}</li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .warning-list { background: #2a2310; border: 1px solid #6b5d1f; border-radius: 6px; padding: 6px 10px; margin-top: 8px; }
  h2 { font-size: 12px; color: #f5f543; margin: 0 0 4px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { font-size: 11px; color: #d6cf8a; }
</style>
