<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { floodPageAreaEntries, FLOOD_TREND_ARROW } from "../lib/standby-cards";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { pageIdentity, sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  import RestoredChip from "./RestoredChip.svelte";
  let { item, pageCoordinator: suppliedPageCoordinator, rotationMember = false, pageScheduling = false, partitionProbe, pagePlacement = "side", measurementRange, measurementPageFooter = false, measurementInfeasibleFallback = false, measurementFixedHeightPx = 200, pageForm = "compact" }: {
    item: Extract<ActiveStandbyCardV1, { kind: "flood" }>;
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    measurementRange?: PageRange;
    /** Include the ordinary page-shell footer while measuring a forced range. */
    measurementPageFooter?: boolean;
    measurementInfeasibleFallback?: boolean;
    /** Used only by the shelf preflight to enqueue forced-range probes. */
    partitionProbe?: PartitionProbe;
    pagePlacement?: "side" | "center";
    measurementFixedHeightPx?: number;
    /** The selected physical form is part of page-reset identity. */
    pageForm?: "compact" | "wide";
  } = $props();
  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;

  // 見出し帯の段階カラーはカード内最高レベルで決める (JMA 配色: L3 氾濫警戒=赤 / L4 氾濫危険=紫 /
  // L5 氾濫発生=黒帯白枠白リボン黄文字の専用スタイル)。severity では段階が足りないため
  // rivers の最高 levelRank から導出する (L5=50 以上)
  const maxLevelRank = $derived(item.data.rivers.reduce((max, river) => Math.max(max, river.levelRank), 0));
  const band = $derived(maxLevelRank >= 50 ? "flooding" : maxLevelRank >= 40 ? "emergency" : "red");
  const headerStyle = $derived(band === "flooding"
    ? "--standby-header-container: #000; --standby-header-on: var(--c-yellow); --standby-header-band: #fff"
    : band === "emergency"
      ? "--standby-header-container: var(--header-weatherEmergency-container); --standby-header-on: var(--header-weatherEmergency-on); --standby-header-band: var(--header-band-weatherEmergency)"
      : "--standby-header-container: var(--header-tsunamiWarning-container); --standby-header-on: var(--header-tsunamiWarning-on); --standby-header-band: var(--header-band-tsunamiWarning)");
  const pageEntries = $derived(floodPageAreaEntries(item.data.rivers));
  const measurementPartition = $derived.by(() => partitionProbe == null
    ? { probeCount: 0 }
    : sequentialPartitionRanges("flood", pagePlacement, item.data.rivers.length, measurementFixedHeightPx, partitionProbe, () => []));
  const pagePartition = $derived.by(() => {
    if (measurementRange != null) return { ranges: [measurementRange], pending: [], infeasible: false, probeCount: 1 };
    if (partitionProbe != null) return sequentialPartitionRanges("flood", pagePlacement, pageEntries.length, measurementFixedHeightPx, partitionProbe, () => []);
    return { ranges: [{ start: 0, end: pageEntries.length, tails: [], omittedAreaCount: 0 }], pending: [], infeasible: false, probeCount: 0 };
  });
  const aggregateMeasurement = $derived(pagePartition.infeasible && partitionProbe != null
    ? partitionProbe("flood", pagePlacement, { start: 0, end: 0, tails: [], omittedAreaCount: 0 }, [])
    : null);
  const aggregateClipped = $derived(pagePartition.infeasible && aggregateMeasurement != null && aggregateMeasurement > measurementFixedHeightPx);
  const pageIdentities = $derived(pagePartition.ranges.map((range, index) => pageIdentity(pageEntries[range.start] ?? {
    kindKey: "flood", area: `page-${index + 1}`, occurrenceIndex: 0,
  })));
  const pageLabels = $derived(pagePartition.ranges.map((range, index) => pageEntries[range.start]?.area ?? `page-${index + 1}`));
  const resetKey = $derived(`${pageForm}:${item.data.rivers.map((river) => river.riverKey).join(",")}`);
  const pagerLogicalItems = $derived(pageEntries.map((entry) => pageIdentity(entry)));
  const pagerResetItems = $derived(item.data.rivers.map((river) => river.riverKey));
  $effect(() => {
    // A provisional range is visible so the card never blanks during a new
    // measurement epoch, but it is not a scheduler fact.  Keeping the last
    // confirmed registration intact avoids a transient many -> one -> many
    // reset while the same river sequence is remeasured.
    if (!pageScheduling || pagePartition.pending.length > 0) return;
    pageCoordinator.register({ key: "flood", identities: pageScheduling ? pageIdentities : [], labels: pageScheduling ? pageLabels : [], rotationMember, resetKey });
  });
  onDestroy(() => { if (ownsPageCoordinator) pageCoordinator.dispose(); });
  const currentPageIndex = $derived(pageCoordinator.activeIndex("flood"));
  const currentRange = $derived(measurementRange ?? pagePartition.ranges[currentPageIndex] ?? pagePartition.ranges[0] ?? null);
  const visibleRivers = $derived(currentRange == null ? [] : item.data.rivers.slice(currentRange.start, currentRange.end));
  const pageDiagnostics = $derived(pageCoordinator.cardDiagnostics("flood"));
  const paginationActive = $derived(pageScheduling && (pagePartition.ranges.length > 1 || pagePartition.pending.length > 0));
  const showPageIndicator = $derived(measurementRange != null
    ? measurementPageFooter
    : pageScheduling && pagePartition.ranges.length > 1);
  const pageIndicatorLabel = $derived(measurementRange != null
    ? `${measurementRange.start > 0 ? 2 : 1}/${measurementRange.end < item.data.rivers.length ? 2 : 1}`
    : pageDiagnostics.page);
</script>

<section
  class="standby-card flood-card band-{band}"
  class:height-budgeted={measurementRange == null && !paginationActive && !pagePartition.infeasible && pagePartition.ranges.length === 1}
  class:measurement-range={measurementRange != null}
  class:paged-flood={paginationActive}
  data-page-probe-card={measurementRange != null ? "" : undefined}
  data-page-probe-body={measurementRange != null ? "" : undefined}
  data-partition-probe-count={measurementPartition.probeCount}
  data-card-page={pageDiagnostics.page}
  data-card-page-keys={JSON.stringify(pageDiagnostics.keys)}
  data-card-page-identities={JSON.stringify(pageDiagnostics.identities)}
  data-card-page-active-identity={pageDiagnostics.activeKey ?? undefined}
  data-pager-namespace="card-page-coordinator"
  data-pager-key="flood"
  data-pager-logical-items={JSON.stringify(pagerLogicalItems)}
  data-pager-logical-fingerprints={JSON.stringify(pagerLogicalItems)}
  data-pager-reset-items={JSON.stringify(pagerResetItems)}
  data-pager-logical-source-count={pagerLogicalItems.length}
  data-flood-page-range={currentRange == null ? "" : `${currentRange.start}:${currentRange.end}`}
  data-card-page-infeasible={pagePartition.infeasible ? aggregateClipped ? "clip" : "aggregate" : "false"}
>
  <header class="standby-card-header" style={headerStyle}><span class="standby-card-header__title">河川洪水情報</span>{#if item.restored}<span class="standby-card-header__meta"><RestoredChip /></span>{/if}</header>
  {#each visibleRivers as river, index (river.riverKey)}
  <div
    class="river-entry"
    data-flood-entry-index={(currentRange?.start ?? 0) + index}
  >
    <div class:critical-river={river.levelRank >= 40} class="river-row">{river.riverName}　{river.kindName}（{river.level}）</div>
    {#if river.station != null}
      {@const station = river.station}
      <div class="station-row"><span class="station-name">{station.name}</span>{#if station.levelM != null}{" "}<span class="station-level"><NumberUnit value={station.levelM.toFixed(2)} unit="m" /></span>{#if station.trend != null}{" "}<span class="trend trend-{station.trend}">{FLOOD_TREND_ARROW[station.trend]}</span>{/if}{/if}{#if station.thresholdLabel != null}{" "}<span class="threshold">{station.thresholdLabel}</span>{/if}</div>
    {/if}
  </div>
  {/each}
  {#if pagePartition.infeasible || measurementInfeasibleFallback}<div class="more-rivers flood-infeasible" data-flood-aggregate="infeasible">ほか {item.data.rivers.length} 河川</div>{/if}
  {#if showPageIndicator}<div class="card-page-footer" data-card-page-footer><span class="card-page-indicator" data-card-page-indicator>{pageIndicatorLabel}</span></div>{/if}
</section>

<style>
  .standby-card { width: min(360px, 28vw); max-height: 200px; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; container-type: inline-size; }
  /* 3 河川以上は従来の max-height 解決値を予約し、集約によって自然高が下がっても
     ソルバへ渡すカード高を変えない。 */
  .height-budgeted { min-height: 200px; }
  /* L5 氾濫発生 = JMA「氾濫発生=黒」表現: 黒背景・白の細枠 (1px) で帯を囲み・下端リボン白・文字黄 */
  .band-flooding .standby-card-header {
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
  .more-rivers { padding: var(--space-1) var(--space-4); border-top: 1px solid var(--hairline); color: var(--role-muted); font-size: max(14px, var(--type-label-l-fluid)); text-align: center; white-space: nowrap; }
  .station-level { color: var(--fg); --number-unit-affix-size: 1em; }
  .trend-rising { color: var(--role-tsunamiWarning); }
  .trend-steady { color: var(--role-muted); }
  .trend-falling { color: var(--role-connectionOk); }
  /* 960px gate の side card (約 269px) だけ折返しを許可する。折返しで自然高が
     増える分、先頭 1 河川 + 集約行へ切り替えて 200px の可読領域を守る。 */
  @container (max-width: 320px) {
    .river-row,
    .station-row {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
