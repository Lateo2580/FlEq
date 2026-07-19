<script lang="ts">
  import type { ThemeStore } from "../lib/theme-store.svelte";

  let { store }: { store: ThemeStore } = $props();

  const names = $derived(store.catalog?.paletteNames ?? []);
</script>

<div class="palette-editor">
  <h2>パレット</h2>
  <ul>
    {#each names as name (name)}
      <li class:overridden={store.isPaletteOverridden(name)}>
        <label>
          <input
            type="color"
            aria-label={`palette-${name}`}
            value={store.effectivePaletteHex(name)}
            oninput={(e) => store.setPaletteColor(name, e.currentTarget.value)}
          />
          <span class="name">{name}</span>
          <code class="hex">{store.effectivePaletteHex(name)}</code>
        </label>
        {#if store.isPaletteOverridden(name)}
          <button class="reset" onclick={() => store.resetPaletteColor(name)}
            aria-label={`${name} をリセット`} title="デフォルトに戻す">↺</button>
        {/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  h2 { font-size: 13px; margin: 0 0 6px; color: #8a93a2; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px; }
  li.overridden { background: #1d2b3a; }
  label { display: flex; align-items: center; gap: 8px; flex: 1; cursor: pointer; }
  input[type="color"] { width: 28px; height: 22px; border: none; background: none; padding: 0; cursor: pointer; }
  .name { font-size: 12px; }
  .hex { font-size: 11px; color: #8a93a2; margin-left: auto; }
  .reset { border: none; background: none; color: #8a93a2; cursor: pointer; font-size: 14px; }
  .reset:hover { color: var(--fg); }
</style>
