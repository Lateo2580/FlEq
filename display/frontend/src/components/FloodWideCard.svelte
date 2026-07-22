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

  // 水位値 (矢印は色分けのため別 span で描く)
  function levelValue(station: DisplayFloodStationV1): string {
    return station.levelM == null ? "" : `${station.levelM.toFixed(2)}m`;
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
            <!-- 左上: 観測所名 (値のみ、ラベルなし) -->
            <div class="cell cell-station">{station.name}</div>
            <!-- 右上: 超過中の基準水位 (thresholdLabel)。null は列ごと省略、1 行 + ellipsis -->
            {#if station.thresholdLabel != null}
              <div class="cell cell-threshold">{station.thresholdLabel}</div>
            {/if}
            <!-- 左下: 現在水位 + 傾向矢印。levelM 欠測はこのセル自体を省略 (プレースホルダは出さない) -->
            {#if station.levelM != null}
              <div class="cell cell-level">{levelValue(station)}{#if station.trend != null}<span class="trend trend-{station.trend}">{FLOOD_TREND_ARROW[station.trend]}</span>{/if}</div>
            {/if}
            <!-- 右下: 水位ミニグラフ (右列いっぱいに伸ばす) -->
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
  .river-cell { min-width: 0; min-height: 88px; padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); }
  /* 集約行はコンパクトに (min-height を継がない — カード下部の余剰スペース防止) */
  .more-rivers { min-width: 0; padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); }
  .river-cell:nth-child(even) { border-left: 1px solid var(--hairline); }
  .river-line { color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 主行の下: 左=観測所/水位、右=水位の情報/ミニグラフ の 2×2。列比 左:右 = 4:6。
     grid-column/row を明示配置し、thresholdLabel や levelM の省略で他セルがずれないようにする */
  .station-grid {
    display: grid;
    grid-template-columns: minmax(0, 4fr) minmax(0, 6fr);
    gap: 2px var(--space-3); /* 行間を詰めてグラフ領域にゆとりを渡す */
    margin-top: var(--space-1);
    align-items: center;
  }
  .cell-station { grid-column: 1; grid-row: 1; }
  /* 水位はセル内の主役数値: 一段大きく。矢印は小さめ + 傾向で色分け (上昇=赤=悪化 / 維持=muted / 下降=薄白=沈静) */
  .cell-level { grid-column: 1; grid-row: 2; font-size: max(17px, var(--type-title-s-fluid)); align-self: center; }
  .trend { font-size: 0.68em; margin-left: var(--space-1); vertical-align: 8%; }
  .trend-rising { color: var(--role-tsunamiWarning); }
  .trend-steady { color: var(--role-muted); }
  .trend-falling { color: var(--role-connectionOk); }
  .cell-threshold { grid-column: 2; grid-row: 1; }
  .cell-graph { grid-column: 2; grid-row: 2; }
  /* 値のみのセル (ラベルなし): fg・num weight・1 行 ellipsis */
  .cell {
    min-width: 0;
    font-size: max(14px, var(--type-body-l-fluid));
    font-weight: var(--num-weight);
    font-variant-numeric: tabular-nums;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 水位の情報: 文字数が長い (「氾濫危険水位 3.20m 超過」=13 文字) ため一段小さく (層2=12px 床)
     して 6fr 列に 1 行で収める。数値以外も含む説明文なので num weight は外す */
  .cell-threshold {
    font-size: max(12px, var(--type-label-s-fluid));
    font-weight: normal;
    align-self: center;
  }
  /* 水位ミニグラフ: 右列いっぱい + 高さ 36px (行間を詰めた分をグラフに渡す) */
  .flood-graph { width: 100%; height: 36px; }
  .more-rivers { grid-column: 1 / -1; color: var(--role-muted); text-align: center; font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; }
  .critical-river .river-line { color: var(--role-weatherEmergency); }
</style>
