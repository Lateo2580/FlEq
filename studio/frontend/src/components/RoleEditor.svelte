<script lang="ts">
  import type { ThemeStore } from "../lib/theme-store.svelte";
  import type { RoleStyleDef } from "../lib/api";

  let { store, onhover = () => {} }: { store: ThemeStore; onhover?: (name: string | null) => void } = $props();

  const categories = $derived(store.catalog?.categories ?? []);
  let activeTab = $state(0);

  type RoleObj = { fg?: string; bg?: string; bold?: boolean };
  type ColorField = "fg" | "bg";
  let drafts = $state<Record<string, Partial<Record<ColorField, string>>>>({});

  /** RoleStyleDef を object 形に正規化 (string 形は fg として扱う) */
  function normalize(def: RoleStyleDef | undefined): RoleObj {
    if (def == null) return {};
    return typeof def === "string" ? { fg: def } : { ...def };
  }

  /**
   * 表示・編集の基準値 = override があれば override、なければデフォルト定義。
   * resolveTheme は override を「全置換」で扱うため、部分編集はデフォルトから
   * seed した object に patch しないとデフォルトの fg/bg/bold が落ちる (plan レビュー反映)
   */
  function effectiveOf(name: string): RoleObj {
    const ov = store.edit.roles?.[name];
    return ov != null ? normalize(ov) : normalize(store.defaultRoleDef(name));
  }

  /** デフォルト定義の表示用文字列 (tooltip) */
  function defaultLabel(name: string): string {
    const d = store.defaultRoleDef(name);
    if (d == null) return "";
    return typeof d === "string" ? d : JSON.stringify(d);
  }

  function sameAsDefault(name: string, obj: RoleObj): boolean {
    return JSON.stringify(obj) === JSON.stringify(normalize(store.defaultRoleDef(name)));
  }

  /** fg/bg/bold の部分更新。空 or デフォルトと同値になったら override を削除 */
  function update(name: string, patch: RoleObj): void {
    const merged: RoleObj = { ...effectiveOf(name), ...patch };
    if (merged.fg === "" || merged.fg == null) delete merged.fg;
    if (merged.bg === "" || merged.bg == null) delete merged.bg;
    if (merged.bold !== true) delete merged.bold;
    if (Object.keys(merged).length === 0 || sameAsDefault(name, merged)) {
      store.resetRole(name);
    } else {
      store.setRole(name, merged as RoleStyleDef);
    }
  }

  function colorValue(name: string, field: ColorField): string {
    return drafts[name]?.[field] ?? effectiveOf(name)[field] ?? "";
  }

  function editColor(name: string, field: ColorField, value: string): void {
    drafts = { ...drafts, [name]: { ...drafts[name], [field]: value } };
    update(name, { [field]: value });
  }

  function commitColor(name: string, field: ColorField, value: string): void {
    update(name, { [field]: value });
    const next = { ...drafts[name] };
    delete next[field];
    drafts = { ...drafts, [name]: next };
  }

  function resetRole(name: string): void {
    const next = { ...drafts };
    delete next[name];
    drafts = next;
    store.resetRole(name);
  }

  function resetRoles(names: string[], label: string): void {
    if (!window.confirm(`${label} のロール変更をリセットしますか？`)) return;
    for (const name of names) resetRole(name);
    store.resetRoles(names);
  }
</script>

<div class="role-editor">
  <h2>ロール</h2>
  <div class="tabs" role="tablist">
    {#each categories as cat, i (cat.label)}
      <button role="tab" aria-selected={i === activeTab} class:active={i === activeTab}
        onclick={() => { activeTab = i; }}>{cat.label}</button>
    {/each}
  </div>
  <div class="bulk-actions">
    {#if categories[activeTab] != null}
      <button onclick={() => resetRoles(categories[activeTab].roles, categories[activeTab].label)}>このカテゴリをリセット</button>
    {/if}
    <button onclick={() => resetRoles(store.catalog?.roleNames ?? [], "すべて")}>すべてのロールをリセット</button>
  </div>
  {#if categories[activeTab] != null}
    <ul>
      {#each categories[activeTab].roles as name (name)}
        {@const eff = effectiveOf(name)}
        <li class:overridden={store.isRoleOverridden(name)} onmouseenter={() => onhover(name)} onmouseleave={() => onhover(null)}>
          <span class="role-name" title={defaultLabel(name)}>{name}</span>
          <input class="color-ref" aria-label={`${name}-fg`} placeholder="fg"
            value={colorValue(name, "fg")} oninput={(e) => editColor(name, "fg", e.currentTarget.value)} onblur={(e) => commitColor(name, "fg", e.currentTarget.value)} />
          <input class="color-ref" aria-label={`${name}-bg`} placeholder="bg"
            value={colorValue(name, "bg")} oninput={(e) => editColor(name, "bg", e.currentTarget.value)} onblur={(e) => commitColor(name, "bg", e.currentTarget.value)} />
          <label class="bold-label">
            <input type="checkbox" aria-label={`${name}-bold`}
              checked={eff.bold === true} onchange={(e) => update(name, { bold: e.currentTarget.checked })} />B
          </label>
          {#if store.isRoleOverridden(name)}
            <button class="reset" onclick={() => resetRole(name)}
              aria-label={`${name} をリセット`} title="デフォルトに戻す">↺</button>
          {:else}
            <span class="reset-spacer"></span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <p class="hint">fg/bg はパレット名 (例: vermillion) または #RRGGBB。空でデフォルト。不正値は保存/プレビュー時に警告として表示される</p>
</div>

<style>
  h2 { font-size: 13px; margin: 0 0 6px; color: #8a93a2; }
  .tabs { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: 6px; }
  .tabs button {
    border: 1px solid #2a2e36; border-radius: 4px 4px 0 0; background: none;
    color: #8a93a2; font-size: 11px; padding: 3px 8px; cursor: pointer;
  }
  .tabs button.active { background: var(--panel); color: var(--fg); border-bottom-color: var(--panel); }
  .bulk-actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
  .bulk-actions button { border: 1px solid #2a2e36; border-radius: 4px; background: none; color: #8a93a2; font-size: 11px; padding: 3px 6px; cursor: pointer; }
  .bulk-actions button:hover { color: var(--fg); border-color: #4a90d9; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto; }
  li { display: flex; align-items: center; gap: 4px; padding: 1px 4px; border-radius: 4px; }
  li.overridden { background: #1d2b3a; }
  /* 長いロール名 (weatherWarningSpecialBanner 等) を省略せず折り返して全文表示する (要望 2026-06-11) */
  .role-name { font-size: 11px; font-family: Consolas, monospace; flex: 1; min-width: 0; word-break: break-all; line-height: 1.25; }
  .color-ref { width: 84px; font-size: 11px; background: #101216; color: var(--fg); border: 1px solid #2a2e36; border-radius: 3px; padding: 2px 4px; }
  .bold-label { font-size: 11px; display: flex; align-items: center; gap: 2px; }
  .reset { border: none; background: none; color: #8a93a2; cursor: pointer; font-size: 13px; padding: 0 2px; }
  .reset:hover { color: var(--fg); }
  .reset-spacer { width: 17px; }
  .hint { font-size: 10px; color: #5a6372; margin: 6px 0 0; }
</style>
