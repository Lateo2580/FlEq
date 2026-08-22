<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { FLOOD_TREND_ARROW } from "../lib/standby-cards";
  import NumberUnit from "./NumberUnit.svelte";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "flood" }> } = $props();

  // 見出し帯の段階カラーはカード内最高レベルで決める (JMA 配色: L3 氾濫警戒=赤 / L4 氾濫危険=紫 /
  // L5 氾濫発生=黒帯白枠白リボン黄文字の専用スタイル)。severity では段階が足りないため
  // rivers の最高 levelRank から導出する (L5=50 以上)
  const maxLevelRank = $derived(item.data.rivers.reduce((max, river) => Math.max(max, river.levelRank), 0));
  const band = $derived(maxLevelRank >= 50 ? "flooding" : maxLevelRank >= 40 ? "emergency" : "red");
</script>

<section class="standby-card flood-card band-{band}">
  <header>河川洪水情報{#if item.restored}<RestoredChip />{/if}</header>
  {#each item.data.rivers as river (river.riverKey)}
    <div class:critical-river={river.levelRank >= 40} class="river-row">{river.riverName}　{river.kindName}（{river.level}）</div>
    {#if river.station != null}
      {@const station = river.station}
      <div class="station-row"><span class="station-name">{station.name}</span>{#if station.levelM != null}{" "}<span class="station-level"><NumberUnit value={station.levelM.toFixed(2)} unit="m" /></span>{#if station.trend != null}{" "}<span class="trend trend-{station.trend}">{FLOOD_TREND_ARROW[station.trend]}</span>{/if}{/if}{#if station.thresholdLabel != null}{" "}<span class="threshold">{station.thresholdLabel}</span>{/if}</div>
    {/if}
  {/each}
</section>

<style>
  .standby-card { width: min(360px, 28vw); max-height: 200px; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  /* 看板ヘッダ帯 (既存カードの card-header と同型): band クラスで段階切替 (L3=赤 / L4=紫 / L5=氾濫発生黒帯) */
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
  .band-emergency header {
    background: var(--header-weatherEmergency-container);
    color: var(--header-weatherEmergency-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherEmergency);
  }
  /* L5 氾濫発生 = JMA「氾濫発生=黒」表現: 黒背景・白の細枠 (1px) で帯を囲み・下端リボン白・文字黄 */
  .band-flooding header {
    background: #000;
    color: var(--c-yellow);
    border: 1px solid #fff;
    border-bottom: var(--header-band-width) solid #fff;
  }
  .river-row { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); white-space: normal; overflow-wrap: anywhere; }
  .river-row:first-of-type { border-top: none; }
  .critical-river { color: var(--role-weatherEmergency); }
  /* 副行 (層2): 主行より深いインデント・muted。critical 河川でも muted のまま (色は主行が担う) */
  .station-row {
    padding: 0 var(--space-4) var(--space-2) calc(var(--space-4) + var(--space-3));
    color: var(--role-muted);
    font-size: max(12px, var(--type-label-s-fluid));
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .station-level { color: var(--fg); --number-unit-affix-size: 1em; }
  .trend-rising { color: var(--role-tsunamiWarning); }
  .trend-steady { color: var(--role-muted); }
  .trend-falling { color: var(--role-connectionOk); }
</style>
