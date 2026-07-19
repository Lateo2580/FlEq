<script lang="ts">
  import type { FixtureSummary } from "../lib/api";

  let { fixtures, selected, onselect }: {
    fixtures: FixtureSummary[];
    selected: string | null;
    onselect: (id: string) => void;
  } = $props();
</script>

<ul class="fixture-list">
  {#each fixtures as f (f.id)}
    <li>
      <button
        class:selected={f.id === selected}
        disabled={!f.supported}
        title={f.supported ? f.label : `${f.label} (Phase 1c で対応予定)`}
        onclick={() => onselect(f.id)}
      >
        {f.label}
      </button>
    </li>
  {/each}
</ul>

<style>
  .fixture-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  button {
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border: 1px solid #2a2e36;
    border-radius: 6px;
    background: var(--panel);
    color: var(--fg);
    cursor: pointer;
    font-size: 13px;
  }
  button:hover:not(:disabled) { border-color: #4a90d9; }
  button.selected { border-color: #4a90d9; background: #1d2b3a; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
