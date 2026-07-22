<script lang="ts">
  import { onMount } from "svelte";
  import type { ActiveStandbyCardV1, DisplayFloodStationV1 } from "../lib/protocol";
  import { FLOOD_TREND_ARROW, layoutFloodWideRows } from "../lib/standby-cards";
  import { buildFloodHydrograph, type FloodHydrographGeometry } from "../lib/flood-hydrograph";
  import RestoredChip from "./RestoredChip.svelte";

  // ミニグラフ座標を組む。単位不一致・空系列などで hydrograph が無い/描画不能なら null (SVG を出さない)。
  function stationGraph(station: DisplayFloodStationV1): FloodHydrographGeometry | null {
    return station.hydrograph == null ? null : buildFloodHydrograph(station.hydrograph);
  }

  // 「4.05m ↑」形式。trend 不明なら矢印を省く。
  function levelText(station: DisplayFloodStationV1): string {
    if (station.levelM == null) return "";
    const arrow = station.trend == null ? "" : ` ${FLOOD_TREND_ARROW[station.trend]}`;
    return `${station.levelM.toFixed(2)}m${arrow}`;
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
          {@const station = river.station}
          {@const graph = stationGraph(station)}
          <div class="station-grid">
            <!-- 左上: 観測所名 -->
            <div class="stat cell-station">
              <span class="stat-label">観測所</span>
              <span class="stat-value">{station.name}</span>
            </div>
            <!-- 右上: 超過中の基準水位 (thresholdLabel)。null は列ごと省略、値はグラフ列幅で折り返す -->
            {#if station.thresholdLabel != null}
              <div class="stat cell-threshold">
                <span class="stat-label">水位の情報</span>
                <span class="stat-value threshold-value">{station.thresholdLabel}</span>
              </div>
            {/if}
            <!-- 左下: 現在水位 + 傾向矢印。levelM 欠測はこの stat 自体を省略 -->
            {#if station.levelM != null}
              <div class="stat cell-level">
                <span class="stat-label">水位</span>
                <span class="stat-value">{levelText(station)}</span>
              </div>
            {/if}
            <!-- 右下: 水位ミニグラフ -->
            {#if graph != null}
              <svg class="flood-graph cell-graph" viewBox="0 0 132 28" preserveAspectRatio="none" role="img" aria-label={graph.summary}>
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
  .river-cell, .more-rivers { min-width: 0; min-height: 120px; padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); }
  .river-cell:nth-child(even) { border-left: 1px solid var(--hairline); }
  .river-line { color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 主行の下: 左=観測所/水位、右=水位の情報/ミニグラフ の 2×2。右列はグラフ幅 132px 基準。
     grid-column/row を明示配置し、thresholdLabel や levelM の省略で他セルがずれないようにする */
  .station-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 132px;
    gap: var(--space-1) var(--space-3);
    margin-top: var(--space-1);
    align-items: start;
  }
  .cell-station { grid-column: 1; grid-row: 1; }
  .cell-level { grid-column: 1; grid-row: 2; }
  .cell-threshold { grid-column: 2; grid-row: 1; }
  .cell-graph { grid-column: 2; grid-row: 2; }
  /* LatestQuakeCard / TyphoonCard の .stat パターン: muted xs ラベル + fg 値の縦組み */
  .stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .stat-label { font-size: var(--type-label-xs-size); color: var(--role-muted); }
  .stat-value {
    font-size: max(14px, var(--type-body-l-fluid));
    font-weight: var(--num-weight);
    font-variant-numeric: tabular-nums;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 水位の情報はグラフ列幅 (132px) の中で 2 行まで折り返す (値は 1 段小さめにして収める) */
  .threshold-value {
    font-size: max(12px, var(--type-label-s-fluid));
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  /* 水位ミニグラフ: 132×28 固定。実測=塗り丸/予測=白抜き丸/危険線=破線で三者を区別 */
  .flood-graph { width: 132px; height: 28px; align-self: center; }
  .more-rivers { grid-column: 1 / -1; color: var(--role-muted); text-align: center; font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; }
  .critical-river .river-line { color: var(--role-weatherEmergency); }
</style>
