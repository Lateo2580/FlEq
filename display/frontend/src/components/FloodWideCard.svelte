<script lang="ts">
  import { onMount } from "svelte";
  import type { ActiveStandbyCardV1, DisplayFloodStationV1 } from "../lib/protocol";
  import { formatFloodStationLine, layoutFloodWideRows } from "../lib/standby-cards";
  import { buildFloodHydrograph, type FloodHydrographGeometry } from "../lib/flood-hydrograph";
  import RestoredChip from "./RestoredChip.svelte";

  function stationLine(station: DisplayFloodStationV1): string {
    return formatFloodStationLine(station);
  }

  // 副行右端の水位ミニグラフ。単位不一致・空系列などで hydrograph が無い/描画不能なら null (SVG を出さない)。
  function stationGraph(station: DisplayFloodStationV1): FloodHydrographGeometry | null {
    return station.hydrograph == null ? null : buildFloodHydrograph(station.hydrograph);
  }

  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "flood" }> } = $props();
  let viewportHeightPx = $state(typeof window === "undefined" ? 720 : window.innerHeight);
  const layout = $derived(layoutFloodWideRows(item.data.rivers, viewportHeightPx));

  // 見出し帯の段階カラーはカード内最高レベルで決める (L3 氾濫警戒=赤 / L4 氾濫危険=紫 /
  // L5 氾濫発生=黒帯白枠白リボン黄文字、FloodCard と同型)
  const maxLevelRank = $derived(item.data.rivers.reduce((max, river) => Math.max(max, river.levelRank), 0));
  const band = $derived(maxLevelRank >= 50 ? "flooding" : maxLevelRank >= 40 ? "emergency" : "red");

  onMount(() => {
    const updateViewport = (): void => { viewportHeightPx = window.innerHeight; };
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  });
</script>

<section class="standby-card flood-wide-card band-{band}">
  <header>河川洪水情報{#if item.restored}<RestoredChip />{/if}</header>
  <div class="river-grid">
    {#each layout.visible as river (river.riverKey)}
      <div class:critical-river={river.levelRank >= 40} class="river-cell">
        <div class="river-line">{river.riverName}　{river.kindName}（{river.level}）</div>
        {#if river.station != null}
          {@const graph = stationGraph(river.station)}
          <div class="station-row">
            <span class="station-line">{stationLine(river.station)}</span>
            {#if graph != null}
              <svg class="flood-graph" viewBox="0 0 132 28" preserveAspectRatio="none" role="img" aria-label={graph.summary}>
                {#if graph.dangerY != null}
                  <line x1="0" x2="132" y1={graph.dangerY} y2={graph.dangerY} stroke="var(--role-weatherEmergency)" stroke-width="2" stroke-dasharray="2 2" />
                {/if}
                {#each graph.forecastSegments as segment, i (i)}
                  <polyline points={segment} fill="none" stroke="var(--role-muted)" stroke-width="2" stroke-dasharray="5 3" />
                {/each}
                {#if graph.observed != null}
                  <circle cx={graph.observed.x} cy={graph.observed.y} r="3" fill="var(--fg)" />
                {/if}
                {#each graph.forecastDots as dot, i (i)}
                  <circle cx={dot.x} cy={dot.y} r="2.5" fill="var(--surface-standby)" stroke="var(--role-muted)" stroke-width="2" />
                {/each}
              </svg>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    {#if layout.omittedCount > 0}
      <div class="more-rivers">ほか {layout.omittedCount} 河川</div>
    {/if}
  </div>
</section>

<style>
  .standby-card { width: min(720px, 56vw); max-height: 30vh; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  /* 看板ヘッダ帯 (FloodCard と同型): band クラスで段階切替 (L3=赤 / L4=紫 / L5=氾濫発生黒帯) */
  header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
  }
  .band-red header {
    background: var(--header-tsunamiWarning-container);
    color: var(--header-tsunamiWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-tsunamiWarning);
  }
  /* L5 氾濫発生 = 黒背景・白細枠 (1px)・下端リボン白・文字黄 (FloodCard と同型) */
  .band-flooding header {
    background: #000;
    color: var(--c-yellow);
    border: 1px solid #fff;
    border-bottom: var(--header-band-width) solid #fff;
  }
  .band-emergency header {
    background: var(--header-weatherEmergency-container);
    color: var(--header-weatherEmergency-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherEmergency);
  }
  .river-grid { display: grid; grid-template-columns: 1fr 1fr; }
  /* min-width: 0 — grid item の暗黙 min-width:auto を殺し、station-line の ellipsis と
     flood-graph の右端固定を右カラムでも効かせる (grid のはみ出し防止) */
  .river-cell, .more-rivers { min-width: 0; min-height: 56px; padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); }
  .river-cell:nth-child(even) { border-left: 1px solid var(--hairline); }
  .river-line { color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 副行 (層2): テキスト + 右端ミニグラフを flex で並べる */
  .station-row { display: flex; align-items: center; gap: var(--space-2); }
  /* テキストは伸縮側 (min-width:0 で ellipsis を効かせ、グラフを圧迫しない)。
     critical 河川でも muted のまま (色は主行の .critical-river が担う) */
  .station-line {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--role-muted);
    font-size: max(12px, var(--type-label-s-fluid));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 水位ミニグラフ: 132×28 固定・伸縮しない。実測=塗り丸/予測=白抜き丸/危険線=破線で三者を区別 */
  .flood-graph { flex: 0 0 auto; width: 132px; height: 28px; }
  .more-rivers { grid-column: 1 / -1; color: var(--role-muted); text-align: center; font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; }
  .critical-river .river-line { color: var(--role-weatherEmergency); }
</style>
