<script lang="ts">
  import type { DisplayQuakeMapEventV1 } from "../lib/protocol";
  import {
    loadQuakeMapAsset,
    type QuakeMapAssetV1,
  } from "../lib/quake-map-loader";
  import {
    intensityVisual,
    QUAKE_MAP_BADGE_FONT_USER_UNITS,
    QUAKE_MAP_BADGE_RADIUS_USER_UNITS,
    quakeMapPathCenter,
    quakeMapRankToken,
  } from "../lib/quake-map-colors";

  const ACCESSIBLE_INTENSITY: Readonly<Record<string, string>> = {
    "5-": "5弱",
    "5+": "5強",
    "6-": "6弱",
    "6+": "6強",
  };

  let { event }: { event: DisplayQuakeMapEventV1 } = $props();

  let asset = $state<QuakeMapAssetV1 | null>(null);
  let loadError = $state(false);

  $effect(() => {
    let active = true;
    void loadQuakeMapAsset()
      .then((loaded) => {
        if (active) asset = loaded;
      })
      .catch(() => {
        if (active) loadError = true;
      });
    return () => {
      active = false;
    };
  });

  const paths = $derived(asset == null ? [] : Object.entries(asset.pathsByCode));
  const areasByCode = $derived(new Map(event.localAreas.map((area) => [area.code, area])));
  const assetCodes = $derived(new Set(paths.map(([code]) => code)));
  const unmatchedCodes = $derived(
    asset == null
      ? []
      : event.localAreas
        .map(({ code }) => code)
        .filter((code) => !assetCodes.has(code)),
  );
  const viewBox = $derived(asset?.viewBox.join(" ") ?? "0 0 1000 800");
  const maxVisual = $derived(intensityVisual(
    event.maxIntSemantic,
    ACCESSIBLE_INTENSITY[event.maxInt] ?? event.maxInt,
    event.maxIntRank,
  ));
  const accessibleName = $derived(
    `地震情報、最大${maxVisual.ariaLabel ?? "震度不明"}、全国の震度分布`,
  );

  let warnedCodes = "";
  $effect(() => {
    if (unmatchedCodes.length === 0) return;
    const key = unmatchedCodes.join(",");
    if (key === warnedCodes) return;
    warnedCodes = key;
    console.warn(`[quake-map] 境界 asset に存在しない区域 code: ${key}`);
  });

  const legend = [
    { rank: 1, label: "1" },
    { rank: 2, label: "2" },
    { rank: 3, label: "3" },
    { rank: 4, label: "4" },
    { rank: 5, label: "5弱" },
    { rank: 6, label: "5強" },
    { rank: 7, label: "6弱" },
    { rank: 8, label: "6強" },
    { rank: 9, label: "7" },
  ] as const;
</script>

<figure class="quake-map" data-unmatched-count={unmatchedCodes.length}>
  {#if asset != null}
    <svg
      class="quake-map-svg"
      {viewBox}
      role="group"
      aria-label={accessibleName}
      preserveAspectRatio="xMidYMid meet"
      focusable="false"
    >
      <title>{accessibleName}</title>
      <g class="quake-regions">
        {#each paths as [code, d] (code)}
          {@const area = areasByCode.get(code)}
          {@const visual = intensityVisual(area?.intensitySemantic, null, area?.rank)}
          <path
            data-code={code}
            class={`quake-region ${visual.colorClass}`}
            {d}
            vector-effect="non-scaling-stroke"
            aria-hidden={!visual.render}
            role={visual.render ? "img" : undefined}
            aria-label={visual.render ? `地域コード${code}、${visual.ariaLabel}` : undefined}
          >
            {#if visual.render}<title>地域コード{code}、{visual.tooltip}</title>{/if}
          </path>
          {#if visual.render && visual.badge != null && quakeMapPathCenter(d) != null}
            {@const center = quakeMapPathCenter(d)!}
            <g
              class="map-badge"
              data-badge-code={code}
              data-badge={visual.badge}
              transform={`translate(${center.x} ${center.y})`}
              aria-hidden="true"
            >
              <circle r={QUAKE_MAP_BADGE_RADIUS_USER_UNITS} />
              <text font-size={QUAKE_MAP_BADGE_FONT_USER_UNITS} text-anchor="middle" dominant-baseline="central">{visual.badge}</text>
            </g>
          {/if}
        {/each}
      </g>
      <g class="quake-insets" aria-hidden="true">
        {#each asset.insets as inset (inset.id)}
          <rect
            class="inset-frame"
            x={inset.frame[0]}
            y={inset.frame[1]}
            width={inset.frame[2]}
            height={inset.frame[3]}
            vector-effect="non-scaling-stroke"
          />
          <text class="inset-label" x={inset.labelPosition[0]} y={inset.labelPosition[1]}>
            {inset.label}
          </text>
        {/each}
      </g>
    </svg>
    <div class="quake-map-legend" aria-label="震度凡例">
      {#each legend as item (item.rank)}
        <span class="legend-item">
          <span class={`legend-swatch quake-map-rank-${item.rank}`} style={`background: ${quakeMapRankToken(item.rank)}`} aria-hidden="true"></span>
          <span>{item.label}</span>
        </span>
      {/each}
      <span class="legend-item">
        <span class="legend-swatch quake-map-unobserved" style="background: var(--surface-highest)" aria-hidden="true"></span>
        <span>未観測</span>
      </span>
      <span class="legend-item">
        <span class="legend-swatch quake-map-unknown" style="background: var(--c-raspberry)" aria-hidden="true"></span>
        <span>不明</span>
      </span>
      <span class="legend-item">
        <span class="legend-swatch quake-map-neutral" style="background: var(--surface-highest)" aria-hidden="true"></span>
        <span>空欄</span>
      </span>
      <span class="legend-item badge-legend"><b>≥</b><span>以上（下限値）</span></span>
      <span class="legend-item badge-legend"><b>↔</b><span>範囲</span></span>
      <span class="legend-item badge-legend"><b>?</b><span>不明</span></span>
      <span class="legend-item badge-legend"><b>∅</b><span>空欄</span></span>
    </div>
    <figcaption>
      <span>出典: 気象庁「予報区等 GIS データ」を加工して作成</span>
      {#if unmatchedCodes.length > 0}
        <span class="map-diagnostic">地図未照合 {unmatchedCodes.length}地域</span>
      {/if}
    </figcaption>
  {:else if loadError}
    <div class="quake-map-fallback" role="status">地図を表示できません</div>
  {:else}
    <div class="quake-map-loading" role="status">地図を準備しています</div>
  {/if}
</figure>

<style>
  .quake-map {
    height: 100%;
    min-height: 0;
    margin: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto auto;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-panel-raised);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-m);
  }

  .quake-map-svg {
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--surface-lowest);
    border-radius: var(--radius-s);
  }

  .quake-region {
    stroke: var(--surface-lowest);
    stroke-width: 0.8;
    stroke-linejoin: round;
    transition: fill var(--spring-effects-default-dur) var(--spring-effects-default);
  }

  :global(.quake-map-unobserved) {
    fill: var(--surface-highest);
  }
  :global(.quake-map-unknown) {
    fill: var(--c-raspberry);
    stroke: var(--surface-lowest);
    stroke-width: 2;
    stroke-dasharray: 4 3;
  }
  :global(.quake-map-neutral) {
    fill: var(--surface-highest);
    stroke: var(--role-muted);
    stroke-width: 2;
    stroke-dasharray: 1 3;
  }
  :global(.quake-map-rank-1) { fill: var(--int-1); }
  :global(.quake-map-rank-2) { fill: var(--int-2); }
  :global(.quake-map-rank-3) { fill: var(--int-3); }
  :global(.quake-map-rank-4) { fill: var(--int-4); }
  :global(.quake-map-rank-5) { fill: var(--int-5); }
  :global(.quake-map-rank-6) { fill: var(--int-6); }
  :global(.quake-map-rank-7) { fill: var(--int-7); }
  :global(.quake-map-rank-8) { fill: var(--int-8-bg); }
  :global(.quake-map-rank-9) { fill: var(--int-9-bg); }

  .map-badge {
    pointer-events: none;
  }
  .map-badge circle {
    fill: var(--surface-lowest);
    stroke: var(--fg);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .map-badge text {
    fill: var(--fg);
    font-weight: var(--type-label-weight-emphasized);
    paint-order: stroke;
    stroke: var(--surface-lowest);
    stroke-width: 2px;
  }

  .inset-frame {
    fill: none;
    stroke: var(--role-muted);
    stroke-width: 1.5;
  }

  .inset-label {
    fill: var(--fg);
    font-size: 18px;
    font-weight: var(--type-label-weight-emphasized);
  }

  .quake-map-legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-1) var(--space-2);
    color: var(--role-muted);
    font-size: max(12px, var(--type-label-s-size));
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .badge-legend b {
    min-width: 1.2em;
    color: var(--fg);
    text-align: center;
  }

  .legend-swatch {
    width: 12px;
    height: 12px;
    border: 1px solid var(--surface-lowest);
    border-radius: 2px;
  }

  figcaption {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-2);
    color: var(--role-muted);
    font-size: max(12px, var(--type-label-s-size));
    line-height: 1.3;
  }

  .map-diagnostic {
    color: var(--role-muted);
  }

  .quake-map-loading,
  .quake-map-fallback {
    grid-row: 1 / -1;
    min-height: 180px;
    display: grid;
    place-items: center;
    color: var(--role-muted);
    font-size: var(--type-body-l-size);
    text-align: center;
  }

  .quake-map-fallback {
    border: 1px dashed var(--role-muted);
    border-radius: var(--radius-m);
  }

  @media (prefers-reduced-motion: reduce) {
    .quake-region {
      transition: none;
    }
  }
</style>
