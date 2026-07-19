<script lang="ts">
  import type { RenderOptions } from "../lib/api";

  let { options, onchange }: {
    options: RenderOptions;
    onchange: (next: RenderOptions) => void;
  } = $props();

  const WIDTH_PRESETS = [60, 80, 100, 120, 140];

  function clampWidth(value: number): number {
    if (!Number.isFinite(value)) return 100;
    return Math.min(300, Math.max(40, Math.round(value)));
  }
</script>

<div class="display-options">
  <h2>表示オプション</h2>
  <div class="row">
    <label>
      幅
      <select aria-label="幅" value={String(options.width)}
        onchange={(e) => onchange({ ...options, width: Number(e.currentTarget.value) })}>
        {#each WIDTH_PRESETS as w (w)}
          <option value={String(w)}>{w}</option>
        {/each}
        {#if !WIDTH_PRESETS.includes(options.width)}
          <option value={String(options.width)}>{options.width}</option>
        {/if}
      </select>
    </label>
    <label>
      カスタム幅
      <input type="number" aria-label="カスタム幅" min="40" max="300" value={options.width}
        onchange={(e) => onchange({ ...options, width: clampWidth(Number(e.currentTarget.value)) })} />
    </label>
  </div>
  <div class="row">
    <label><input type="checkbox" aria-label="compact" checked={options.compact}
      onchange={(e) => onchange({ ...options, compact: e.currentTarget.checked })} /> compact</label>
    <label><input type="checkbox" aria-label="NO_COLOR" checked={options.noColor}
      onchange={(e) => onchange({ ...options, noColor: e.currentTarget.checked })} /> NO_COLOR</label>
    <label><input type="checkbox" aria-label="Night" checked={options.nightMode}
      onchange={(e) => onchange({ ...options, nightMode: e.currentTarget.checked })} /> Night</label>
  </div>
</div>

<style>
  h2 { font-size: 13px; margin: 0 0 6px; color: #8a93a2; }
  .display-options { margin-bottom: 10px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  label { font-size: 12px; display: flex; align-items: center; gap: 4px; }
  select, input[type="number"] {
    background: #101216; color: var(--fg); border: 1px solid #2a2e36;
    border-radius: 3px; font-size: 12px; padding: 2px 4px;
  }
  input[type="number"] { width: 64px; }
</style>
