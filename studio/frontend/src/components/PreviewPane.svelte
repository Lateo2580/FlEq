<script lang="ts">
  import { ansiToHtml } from "../lib/ansi-to-html";

  let { ansi, error, highlightedLines = [] }: { ansi: string; error: string | null; highlightedLines?: boolean[] } = $props();

  const lines = $derived(ansi.replace(/\n$/, "").split("\n"));
</script>

{#if error != null}
  <pre class="terminal terminal-error">[render error] {error}</pre>
{:else}
  <!-- ansiToHtml は入力を HTML エスケープ済み → {@html} 安全 -->
  <pre class="terminal">{#each lines as line, i (i)}<span class="preview-line" class:role-highlight={highlightedLines[i] === true}>{@html ansiToHtml(line) || "&nbsp;"}</span>{/each}</pre>
{/if}

<style>
  .preview-line { display: block; min-height: 1.2em; }
  .preview-line.role-highlight { background: #2a2310; box-shadow: inset 3px 0 #f5f543; }
</style>
