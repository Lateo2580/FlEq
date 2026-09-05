<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { flip } from "svelte/animate";
  import { fade } from "svelte/transition";
  import type { ActiveStandbyCardV1, DisplayFloodStationV1 } from "../lib/protocol";
  import { floodPageAreaEntries, FLOOD_TREND_ARROW } from "../lib/standby-cards";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { pageIdentity, sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import { buildFloodHydrograph, type FloodHydrographGeometry } from "../lib/flood-hydrograph";
  import { SPRING_EFFECTS_DEFAULT_MS, SPRING_SPATIAL_DEFAULT_MS, EXIT_MS, springSpatialOut } from "../lib/motion";
  import { spatialScaleIn } from "../lib/transitions";
  import { measureBorderHeight } from "../lib/measure-height";
  import RestoredChip from "./RestoredChip.svelte";
  import NumberUnit from "./NumberUnit.svelte";

  // ミニグラフ座標を組む。単位不一致・空系列などで hydrograph が無い/描画不能なら null (SVG を出さない)。
  function stationGraph(station: DisplayFloodStationV1): FloodHydrographGeometry | null {
    return station.hydrograph == null ? null : buildFloodHydrograph(station.hydrograph);
  }

  let { item, pageCoordinator: suppliedPageCoordinator, rotationMember = false, pageScheduling = false, partitionProbe, pagePlacement = "side", measurementRange, measurementPageFooter = false, measurementInfeasibleFallback = false, measurementFixedHeightPx = 200, pageForm = "wide" }: {
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
    pageForm?: "compact" | "wide";
  } = $props();
  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;
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
    // Pending composition is deliberately rendered, but never registered as
    // a one-page scheduler state.  The old confirmed partition remains live
    // until this epoch has a confirmed replacement.
    if (!pageScheduling || pagePartition.pending.length > 0) return;
    pageCoordinator.register({ key: "flood", identities: pageScheduling ? pageIdentities : [], labels: pageScheduling ? pageLabels : [], rotationMember, resetKey });
  });
  onDestroy(() => { if (ownsPageCoordinator) pageCoordinator.dispose(); });
  const currentPageIndex = $derived(pageCoordinator.activeIndex("flood"));
  const currentRange = $derived(measurementRange ?? pagePartition.ranges[currentPageIndex] ?? pagePartition.ranges[0] ?? null);
  const rows = $derived((currentRange == null ? [] : item.data.rivers.slice(currentRange.start, currentRange.end))
    .map((river) => ({ key: `river:${river.riverKey}`, river })));
  const pageDiagnostics = $derived(pageCoordinator.cardDiagnostics("flood"));
  const paginationActive = $derived(pageScheduling && (pagePartition.ranges.length > 1 || pagePartition.pending.length > 0));
  const showPageIndicator = $derived(measurementRange != null
    ? measurementPageFooter
    : pageScheduling && pagePartition.ranges.length > 1);
  const pageIndicatorLabel = $derived(measurementRange != null
    ? `${measurementRange.start > 0 ? 2 : 1}/${measurementRange.end < item.data.rivers.length ? 2 : 1}`
    : pageDiagnostics.page);

  // 見出し帯の段階カラーはカード内最高レベルで決める (L3 氾濫警戒=赤 / L4 氾濫危険=紫 /
  // L5 氾濫発生=黒帯白枠白リボン黄文字、FloodCard と同型)
  const maxLevelRank = $derived(item.data.rivers.reduce((max, river) => Math.max(max, river.levelRank), 0));
  const band = $derived(maxLevelRank >= 50 ? "flooding" : maxLevelRank >= 40 ? "emergency" : "red");
  const headerStyle = $derived(band === "flooding"
    ? "--standby-header-container: #000; --standby-header-on: var(--c-yellow); --standby-header-band: #fff"
    : band === "emergency"
      ? "--standby-header-container: var(--header-weatherEmergency-container); --standby-header-on: var(--header-weatherEmergency-on); --standby-header-band: var(--header-band-weatherEmergency)"
      : "--standby-header-container: var(--header-tsunamiWarning-container); --standby-header-on: var(--header-tsunamiWarning-on); --standby-header-band: var(--header-band-tsunamiWarning)");

  // prefers-reduced-motion を購読する (StandbyScreen の既存パターンを踏襲)。matchMedia 未実装環境
  // (jsdom 等) ではスキップし通常 duration。reduced-motion では flip/in/out/高さ遷移すべて duration 0。
  let reducedMotion = $state(
    typeof window === "undefined" ? false : window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  $effect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion = mq.matches;
    const onChange = (e: MediaQueryListEvent): void => { reducedMotion = e.matches; };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });
  const flipDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_DEFAULT_MS);
  const enterDur = $derived(reducedMotion ? 0 : SPRING_SPATIAL_DEFAULT_MS);
  const exitDur = $derived(reducedMotion ? 0 : EXIT_MS); // 消失感を出さない短い fade

  // カード高さの「がくん」を消すため、河川グリッドの自然高を実測して外側ラッパの明示 height に
  // 反映し、CSS transition (height) で追う。内側は自然高のまま (grid の row 補間を起こさない) ／
  // ラッパだけが height を持つ一方向のフロー (自然高 → 実測 → ラッパ height)。measure が来る前や
  // ResizeObserver 未実装環境 (jsdom → 0) では height:auto に退避しクリップを避ける。
  let gridHeightPx = $state(0);
  // 高さ transition は easing と同じ effects 系 231ms。spatial 435ms の流用は fade 後も高さが動く二段階見えの一因だった。
  const gridDurMs = $derived(reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS);
  const gridWrapStyle = $derived(
    (paginationActive ? "" : gridHeightPx > 0 ? `height: ${gridHeightPx}px; ` : "") + `--flood-grid-dur: ${paginationActive ? 0 : gridDurMs}ms`,
  );
</script>

<section class="standby-card flood-wide-card band-{band}" class:paged-flood={paginationActive} data-page-probe-card={measurementRange != null ? "" : undefined} data-page-probe-body={measurementRange != null ? "" : undefined} data-partition-probe-count={measurementPartition.probeCount} data-card-page={pageDiagnostics.page} data-card-page-keys={JSON.stringify(pageDiagnostics.keys)} data-card-page-identities={JSON.stringify(pageDiagnostics.identities)} data-card-page-active-identity={pageDiagnostics.activeKey ?? undefined} data-pager-namespace="card-page-coordinator" data-pager-key="flood" data-pager-logical-items={JSON.stringify(pagerLogicalItems)} data-pager-logical-fingerprints={JSON.stringify(pagerLogicalItems)} data-pager-reset-items={JSON.stringify(pagerResetItems)} data-pager-logical-source-count={pagerLogicalItems.length} data-flood-page-range={currentRange == null ? "" : `${currentRange.start}:${currentRange.end}`} data-card-page-infeasible={pagePartition.infeasible ? aggregateClipped ? "clip" : "aggregate" : "false"}>
  <header class="standby-card-header" style={headerStyle}><span class="standby-card-header__title">河川洪水情報</span>{#if item.restored}<span class="standby-card-header__meta"><RestoredChip /></span>{/if}</header>
  <div class="river-grid-wrap" style={gridWrapStyle}>
  <div class="river-grid" use:measureBorderHeight={(height) => (gridHeightPx = height)}>
    {#each rows as row, index (row.key)}
      <div
        class:river-cell={true}
        class:critical-river={row.river.levelRank >= 40}
        data-flood-entry-index={(currentRange?.start ?? 0) + index}
        animate:flip={{ duration: flipDur, easing: springSpatialOut }}
        in:spatialScaleIn={{ duration: enterDur, start: 0.97 }}
        out:fade={{ duration: exitDur }}
      >
          <div class="river-line">{row.river.riverName}　{row.river.kindName}（{row.river.level}）</div>
          {#if row.river.station != null}
          {@const station = row.river.station}
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
              <div class="cell cell-level"><NumberUnit value={station.levelM.toFixed(2)} unit="m" />{#if station.trend != null}<span class="trend trend-{station.trend}">{FLOOD_TREND_ARROW[station.trend]}</span>{/if}</div>
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
  </div>
  </div>
  {#if pagePartition.infeasible || measurementInfeasibleFallback}<div class="more-rivers flood-infeasible" data-flood-aggregate="infeasible">ほか {item.data.rivers.length} 河川</div>{/if}
  {#if showPageIndicator}<div class="card-page-footer" data-card-page-footer><span class="card-page-indicator" data-card-page-indicator>{pageIndicatorLabel}</span></div>{/if}
</section>

<style>
  .standby-card { width: min(720px, 56vw); max-height: 30vh; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; container-type: inline-size; }
  /* L5 氾濫発生 = 黒背景・白細枠 (1px)・下端リボン白・文字黄 (FloodCard と同型) */
  .band-flooding .standby-card-header {
    border: 1px solid #fff;
    border-bottom: var(--header-band-width) solid #fff;
  }
  /* 河川セル増減でカード高さが「がくん」と変わらないよう、内側 grid の実測自然高を明示 height
     として受けて CSS transition で追う箱。overflow:hidden で縮小途中のはみ出しを切る。
     duration は JS が --flood-grid-dur で渡す (reduced-motion では 0ms)。easing は heightReveal と
     同じ effects 系 (臨界減衰・非オーバーシュート — spatial は周囲を揺らすため高さには使わない)。 */
  .river-grid-wrap { overflow: hidden; transition: height var(--flood-grid-dur, 0ms) var(--spring-effects-default); }
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
  /* 観測所名は水位の小見出し (ご主人提案 2026-07-22: 「高城」小 →「3.31m ↑」大の縦組み)。
     fg・太字は維持しつつ一段小さく、水位に密着させる */
  .cell-station { grid-column: 1; grid-row: 1; align-self: end; }
  /* 水位はセル内の主役数値: title-m 級まで拡大。矢印は小さめ + 傾向で色分け (上昇=赤=悪化 / 維持=muted / 下降=薄白=沈静)。
     font-size は後方の .cell 基本ルールに同詳細度で負けるため .cell を重ねて詳細度を上げる */
  .cell.cell-station { font-size: max(13px, var(--type-label-s-fluid)); }
  .cell-level { grid-column: 1; grid-row: 2; align-self: start; }
  .cell.cell-level { font-size: max(20px, var(--type-title-m-size)); }
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
  /* 720p の side/rotation track では wide card 自体が約 320px まで狭まる。
     外側の二河川並列は保ちつつ、各セル内だけを一列へ動的に組み替え、観測所名・
     水位・kind を省略せず読めるようにする。36rem center track (1920px gate) は
     この query の外なので、従来の 2x2 station grid と見え方を維持する。 */
  @container (max-width: 400px) {
    .river-cell { min-height: 0; }
    .river-line {
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
    }
    .station-grid {
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
    }
    .cell-station { grid-column: 1; grid-row: 1; }
    .cell-level { grid-column: 1; grid-row: 2; }
    .cell-threshold { grid-column: 1; grid-row: 3; }
    .cell-graph { grid-column: 1; grid-row: 4; }
    .cell {
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
    }
    .cell.cell-level { white-space: nowrap; }
  }
</style>
