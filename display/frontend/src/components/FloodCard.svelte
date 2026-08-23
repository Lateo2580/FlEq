<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { FLOOD_TREND_ARROW } from "../lib/standby-cards";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import NumberUnit from "./NumberUnit.svelte";
  import RestoredChip from "./RestoredChip.svelte";
  let { item, measurementRange, measurementPageFooter = false, partitionProbe, pagePlacement = "side", measurementFixedHeightPx = 200 }: {
    item: Extract<ActiveStandbyCardV1, { kind: "flood" }>;
    /** Shelf-only forced page composition; live pagination is wired separately. */
    measurementRange?: PageRange;
    /** Include the ordinary page-shell footer while measuring a forced range. */
    measurementPageFooter?: boolean;
    /** Used only by the shelf preflight to enqueue forced-range probes. */
    partitionProbe?: PartitionProbe;
    pagePlacement?: "side" | "center";
    measurementFixedHeightPx?: number;
  } = $props();

  // 見出し帯の段階カラーはカード内最高レベルで決める (JMA 配色: L3 氾濫警戒=赤 / L4 氾濫危険=紫 /
  // L5 氾濫発生=黒帯白枠白リボン黄文字の専用スタイル)。severity では段階が足りないため
  // rivers の最高 levelRank から導出する (L5=50 以上)
  const maxLevelRank = $derived(item.data.rivers.reduce((max, river) => Math.max(max, river.levelRank), 0));
  const band = $derived(maxLevelRank >= 50 ? "flooding" : maxLevelRank >= 40 ? "emergency" : "red");
  const visibleRivers = $derived(measurementRange == null
    ? item.data.rivers
    : item.data.rivers.slice(measurementRange.start, measurementRange.end));
  const measurementFooterLabel = $derived(measurementRange == null ? "" : `${measurementRange.start > 0 ? 2 : 1}/${measurementRange.end < item.data.rivers.length ? 2 : 1}`);
  const measurementPartition = $derived.by(() => partitionProbe == null
    ? { probeCount: 0 }
    : sequentialPartitionRanges("flood", pagePlacement, item.data.rivers.length, measurementFixedHeightPx, partitionProbe, () => []));
</script>

<section
  class="standby-card flood-card band-{band}"
  class:height-budgeted={measurementRange == null && item.data.rivers.length >= 3}
  class:many-rivers={measurementRange == null && item.data.rivers.length >= 3}
  class:measurement-range={measurementRange != null}
  data-page-probe-card={measurementRange != null ? "" : undefined}
  data-page-probe-body={measurementRange != null ? "" : undefined}
  data-partition-probe-count={measurementPartition.probeCount}
>
  <header>河川洪水情報{#if item.restored}<RestoredChip />{/if}</header>
  {#each visibleRivers as river, index (river.riverKey)}
  <div
    class="river-entry"
    data-flood-entry-index={measurementRange == null ? index : measurementRange.start + index}
    data-flood-aggregated-normal={index >= 2 ? "true" : undefined}
    data-flood-aggregated-narrow={index >= 1 ? "true" : undefined}
  >
    <div class:critical-river={river.levelRank >= 40} class="river-row">{river.riverName}　{river.kindName}（{river.level}）</div>
    {#if river.station != null}
      {@const station = river.station}
      <div class="station-row"><span class="station-name">{station.name}</span>{#if station.levelM != null}{" "}<span class="station-level"><NumberUnit value={station.levelM.toFixed(2)} unit="m" /></span>{#if station.trend != null}{" "}<span class="trend trend-{station.trend}">{FLOOD_TREND_ARROW[station.trend]}</span>{/if}{/if}{#if station.thresholdLabel != null}{" "}<span class="threshold">{station.thresholdLabel}</span>{/if}</div>
    {/if}
  </div>
  {/each}
  {#if measurementRange == null && item.data.rivers.length >= 3}
    <div class="more-rivers more-many" data-flood-aggregate="normal">ほか {item.data.rivers.length - 2} 河川</div>
  {/if}
  {#if measurementRange == null && item.data.rivers.length >= 2}
    <div class="more-rivers more-narrow" data-flood-aggregate="narrow">ほか {item.data.rivers.length - 1} 河川</div>
  {/if}
  {#if measurementRange != null && measurementPageFooter}<div class="card-page-footer" data-card-page-footer><span class="card-page-indicator" data-card-page-indicator>{measurementFooterLabel}</span></div>{/if}
</section>

<style>
  .standby-card { width: min(360px, 28vw); max-height: 200px; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; container-type: inline-size; }
  /* 3 河川以上は従来の max-height 解決値を予約し、集約によって自然高が下がっても
     ソルバへ渡すカード高を変えない。 */
  .height-budgeted { min-height: 200px; }
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
  .river-row { padding: var(--space-2) var(--space-4); border-top: 1px solid var(--hairline); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); white-space: nowrap; }
  .river-entry:first-of-type .river-row { border-top: none; }
  .critical-river { color: var(--role-weatherEmergency); }
  /* 副行 (層2): 主行より深いインデント・muted。critical 河川でも muted のまま (色は主行が担う) */
  .station-row {
    padding: 0 var(--space-4) var(--space-2) calc(var(--space-4) + var(--space-3));
    color: var(--role-muted);
    font-size: max(12px, var(--type-label-s-fluid));
    white-space: nowrap;
  }
  /* 非圧縮 token の最悪値は header 約46px、river 約36px、station 約26px。
     先頭2組 + 集約を200pxへ収めるため、集約行だけ縦 padding を space-1
     (約27px) にする。通常の space-2 では合計が約205pxになり再度クリップする。 */
  .more-rivers { display: none; padding: var(--space-1) var(--space-4); border-top: 1px solid var(--hairline); color: var(--role-muted); font-size: max(14px, var(--type-label-l-fluid)); text-align: center; white-space: nowrap; }
  /* 3 河川 + 観測所副行2本でも200pxを超えるため、通常幅から先頭2河川を
     残して集約する。wide surface の side/rotation 変換 (最大5河川) も同じ契約。 */
  .many-rivers [data-flood-aggregated-normal] { display: none; }
  .many-rivers .more-many { display: block; }
  .station-level { color: var(--fg); --number-unit-affix-size: 1em; }
  .trend-rising { color: var(--role-tsunamiWarning); }
  .trend-steady { color: var(--role-muted); }
  .trend-falling { color: var(--role-connectionOk); }
  .card-page-footer { display: flex; justify-content: flex-end; padding: var(--space-1) var(--space-4); border-top: 1px solid var(--hairline); }
  .card-page-indicator { padding: 1px var(--space-2); border: 1px solid var(--hairline); border-radius: var(--radius-s); color: var(--role-muted); font-size: var(--type-label-xs-size); line-height: 1; font-variant-numeric: tabular-nums; }

  /* 960px gate の side card (約 269px) だけ折返しを許可する。折返しで自然高が
     増える分、先頭 1 河川 + 集約行へ切り替えて 200px の可読領域を守る。 */
  @container (max-width: 320px) {
    [data-flood-aggregated-narrow] { display: none; }
    .many-rivers .more-many { display: none; }
    .more-narrow { display: block; }
    .river-row,
    .station-row {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
