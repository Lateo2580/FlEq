<script lang="ts">
  import { untrack } from "svelte";
  import {
    fetchFixtures, renderFixture, renderDiff, renderRoleHighlight, getTheme, saveTheme, fetchDisplayReference,
    type FixtureSummary, type RenderOptions, type DisplayReferenceSection, type DiffResult,
  } from "./lib/api";
  import { classifyDiffLines } from "./lib/diff-lines";
  import { themeStore } from "./lib/theme-store.svelte";
  import { debounce } from "./lib/debounce";
  import FixturePicker from "./components/FixturePicker.svelte";
  import PreviewPane from "./components/PreviewPane.svelte";
  import PaletteEditor from "./components/PaletteEditor.svelte";
  import RoleEditor from "./components/RoleEditor.svelte";
  import WarningList from "./components/WarningList.svelte";
  import DisplayOptions from "./components/DisplayOptions.svelte";
  import DisplayReferencePane from "./components/DisplayReferencePane.svelte";
  import DiffPane from "./components/DiffPane.svelte";

  let options = $state<RenderOptions>({ compact: false, width: 100, noColor: false, nightMode: false });
  let referenceSections = $state<DisplayReferenceSection[]>([]);

  let fixtures = $state<FixtureSummary[]>([]);
  let selected = $state<string | null>(null);
  let ansi = $state("");
  let error = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let renderWarnings = $state<string[]>([]);
  let diffMode = $state(false);
  let diffResult = $state<DiffResult | null>(null);
  let saveState = $state<"idle" | "saving" | "saved" | "error">("idle");
  let saveMessage = $state("");
  let hoveredRole = $state<string | null>(null);
  let highlightedLines = $state<boolean[]>([]);

  $effect(() => {
    fetchFixtures()
      .then((list) => { fixtures = list; })
      .catch((e: unknown) => { loadError = e instanceof Error ? e.message : String(e); });
    getTheme()
      .then((catalog) => { themeStore.init(catalog); })
      .catch((e: unknown) => { loadError = e instanceof Error ? e.message : String(e); });
  });

  // 並走 render の世代カウンタ。素早い fixture/option/theme 切替で
  // 古い応答が後勝ちで state を上書きしないよう、最新世代だけ commit する
  let renderGen = 0;

  async function doRender(): Promise<void> {
    if (selected == null) return;
    const gen = ++renderGen;
    loading = true;
    try {
      if (diffMode) {
        const result = await renderDiff(selected, options, themeStore.edit);
        if (gen !== renderGen) return;
        diffResult = result;
        renderWarnings = result.warnings;
      } else {
        const result = await renderFixture(selected, options, themeStore.edit);
        if (gen !== renderGen) return;
        ansi = result.ansi;
        renderWarnings = result.warnings;
      }
      error = null;
    } catch (e) {
      if (gen !== renderGen) return;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === renderGen) loading = false;
    }
  }

  function toggleDiff(): void {
    diffMode = !diffMode;
    void doRender();
  }

  const debouncedRender = debounce(() => { void doRender(); }, 200);

  let highlightGen = 0;
  async function doHighlight(): Promise<void> {
    if (selected == null || hoveredRole == null || diffMode) return;
    const gen = ++highlightGen;
    try {
      const result = await renderRoleHighlight(selected, options, themeStore.edit, hoveredRole);
      if (gen !== highlightGen) return;
      highlightedLines = classifyDiffLines(result.before, result.after).map((row) => row.kind !== "unchanged");
    } catch {
      if (gen === highlightGen) highlightedLines = [];
    }
  }
  const debouncedHighlight = debounce(() => { void doHighlight(); }, 200);

  function setHoveredRole(name: string | null): void {
    hoveredRole = name;
    highlightedLines = [];
    ++highlightGen;
    debouncedHighlight.cancel();
    if (name != null && selected != null && !diffMode) debouncedHighlight();
  }

  // テーマ編集の変更を 200ms debounce で再 render (spec §4.6/§5.1)。
  // レビュー反映: 依存は edit のみ (selected を track すると select 時に
  // doRender と debounce の二重 render になる)。初回実行はスキップし、
  // teardown で保留タイマを破棄する (unmount 後の doRender を防ぐ)
  let editInitialized = false;
  $effect(() => {
    JSON.stringify(themeStore.edit); // deep 依存の購読 (これだけを track する)
    if (!editInitialized) {
      editInitialized = true;
      return () => debouncedRender.cancel();
    }
    if (untrack(() => selected) != null) debouncedRender();
    return () => debouncedRender.cancel();
  });

  function changeOptions(next: RenderOptions): void {
    options = next;
    void doRender();
  }

  async function select(id: string): Promise<void> {
    selected = id;
    const type = fixtures.find((f) => f.id === id)?.type;
    if (type != null) {
      fetchDisplayReference(type)
        .then((s) => { referenceSections = s; })
        .catch(() => { referenceSections = []; }); // 参照表示は best-effort
    }
    await doRender();
  }

  async function save(): Promise<void> {
    saveState = "saving";
    try {
      const result = await saveTheme(themeStore.edit);
      themeStore.markSaved();
      saveState = "saved";
      saveMessage = result.warnings.length > 0
        ? `保存しました (警告 ${result.warnings.length} 件)。FlEq 起動中なら REPL で theme reload を実行してね`
        : "保存しました。FlEq 起動中なら REPL で theme reload を実行してね";
      renderWarnings = result.warnings;
      if (diffMode) void doRender();
    } catch (e) {
      saveState = "error";
      saveMessage = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<main>
  <aside>
    <h1>FlEq Display Studio</h1>
    <p class="phase">Phase 1 complete — theme studio</p>
    {#if loadError != null}
      <p class="load-error">読込に失敗: {loadError}</p>
    {/if}
    <FixturePicker {fixtures} {selected} onselect={select} />
    <DisplayReferencePane sections={referenceSections} />
  </aside>
  <section class="editor">
    <div class="save-row">
      <button class="save" onclick={save} disabled={!themeStore.dirty || saveState === "saving"}>
        {saveState === "saving" ? "保存中…" : "Save"}
      </button>
      <button class="diff-toggle" class:active={diffMode} onclick={toggleDiff}>diff</button>
      {#if saveState === "saved" || saveState === "error"}
        <span class="save-msg" class:save-error={saveState === "error"}>{saveMessage}</span>
      {/if}
    </div>
    <DisplayOptions {options} onchange={changeOptions} />
    <PaletteEditor store={themeStore} />
    <RoleEditor store={themeStore} onhover={setHoveredRole} />
    <WarningList warnings={renderWarnings} />
  </section>
  <section class="preview">
    {#if loading}
      <p class="loading">rendering…</p>
    {/if}
    {#if diffMode && diffResult != null && error == null}
      <DiffPane before={diffResult.before} after={diffResult.after} />
    {:else}
      <PreviewPane {ansi} {error} {highlightedLines} />
    {/if}
  </section>
</main>

<style>
  main {
    display: grid;
    grid-template-columns: 260px 360px 1fr;
    gap: 12px;
    height: 100vh;
    padding: 12px;
  }
  aside, .editor {
    overflow-y: auto;
    background: var(--panel);
    border-radius: 8px;
    padding: 12px;
  }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .phase { color: #8a93a2; font-size: 12px; margin: 0 0 12px; }
  .preview { overflow: auto; border-radius: 8px; background: #000; }
  .loading { color: #8a93a2; font-size: 12px; margin: 4px 8px; position: absolute; }
  .load-error { color: #ff6b6b; font-size: 12px; }
  .save-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .save {
    padding: 6px 18px; border-radius: 6px; border: 1px solid #2f6f4f;
    background: #1d3a2b; color: var(--fg); cursor: pointer; font-size: 13px;
  }
  .save:disabled { opacity: 0.4; cursor: not-allowed; }
  .save-msg { font-size: 11px; color: #7fd6a4; }
  .save-msg.save-error { color: #ff6b6b; }
  .diff-toggle { padding: 6px 12px; border-radius: 6px; border: 1px solid #2a2e36; background: none; color: var(--fg); cursor: pointer; font-size: 13px; }
  .diff-toggle.active { border-color: #f5f543; color: #f5f543; }
</style>
