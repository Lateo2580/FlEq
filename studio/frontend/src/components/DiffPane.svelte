<script lang="ts">
  import { classifyDiffLines, type DiffRow } from "../lib/diff-lines";
  import { ansiToHtml } from "../lib/ansi-to-html";

  let { before, after }: { before: string; after: string } = $props();

  const rows = $derived(classifyDiffLines(before, after));

  function lineClass(row: DiffRow): string {
    if (row.kind === "colorChanged") return "diff-line changed-color";
    if (row.kind === "textChanged") return "diff-line changed-text";
    return "diff-line";
  }
</script>

<div class="diff-pane">
  <div class="diff-col diff-col-before">
    <h3>before (保存済み)</h3>
    <pre class="terminal">{#each rows as row, i (i)}<span class={lineClass(row)}>{@html ansiToHtml(row.beforeAnsi) || "&nbsp;"}</span>{/each}</pre>
  </div>
  <div class="diff-col diff-col-after">
    <h3>after (編集中)</h3>
    <pre class="terminal">{#each rows as row, i (i)}<span class={lineClass(row)}>{#if row.kind === "textChanged" && row.afterSegments != null}{#each row.afterSegments as seg, j (j)}{#if seg.changed}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}{:else}{@html ansiToHtml(row.afterAnsi) || "&nbsp;"}{/if}</span>{/each}</pre>
  </div>
</div>

<style>
  /* 上下分割 (要望 2026-06-11 — 横幅の広い等幅出力は左右だと折返し/横スクロールが辛い) */
  .diff-pane { display: grid; grid-template-rows: 1fr 1fr; gap: 8px; height: 100%; }
  .diff-col { overflow: auto; background: #000; border-radius: 8px; min-height: 0; }
  h3 { font-size: 11px; color: #8a93a2; margin: 6px 10px 2px; font-weight: normal; }
  .terminal { margin: 0; padding: 6px 12px; }
  .diff-line { display: block; min-height: 1.2em; border-left: 3px solid transparent; padding-left: 4px; margin-left: -7px; white-space: pre; }
  .diff-line.changed-color { border-left-color: #f5f543; }
  .diff-line.changed-text { border-left-color: #f5f543; background: #2a2310; }
  mark { background: #6b5d1f; color: #fff; border-radius: 2px; }
</style>
