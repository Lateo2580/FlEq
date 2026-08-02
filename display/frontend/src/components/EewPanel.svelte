<script lang="ts">
  import type { DisplayEewInputV1, DisplayEewRegionV1 } from "../lib/protocol";
  import { formatHms, formatIntShort } from "../lib/format";
  import {
    eewIntensityRangeLabel,
    eewIntensityRangeRank,
    eewRegionFontTier,
    eewRegionListColumnCount,
    paginateEewRegions,
  } from "../lib/eew-region-tiers";
  import { EEW_STATIC_LIST_MAX, rowCapacity } from "../lib/instrument-layout";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { measureBorderHeight, measureHeight } from "../lib/measure-height";
  import { formatMagnitudeLabel, isNumericMagnitude } from "../lib/magnitude";
  import { intensityVisual, type IntensityVisualV1 } from "../lib/quake-map-colors";
  import { onDestroy } from "svelte";
  import PageDots from "./PageDots.svelte";
  import RollingNumber from "./RollingNumber.svelte";

  // compact: main-stack の非 main スロットで regions を密度 tier に応じて縮小表示する
  let { input, compact = false, settling = false, emphasized = false }: { input: DisplayEewInputV1; compact?: boolean; settling?: boolean; emphasized?: boolean } = $props();

  const role = $derived(input.isWarning ? "eewWarning" : "eewForecast");
  const displayRegions = $derived(input.regions.filter((region) =>
    intensityVisual(region.intensitySemantic, eewIntensityRangeLabel(region), eewIntensityRangeRank(region)).render
  ));
  const tier = $derived(eewRegionFontTier(displayRegions.length, compact));
  const tierFontClass = $derived(`tier-font-${tier.fontSizePx}`);
  const regionListStyle = $derived(`font-size: ${tier.fontSizePx}px;`);

  interface IntensityBucket {
    key: string;
    intensity: string;
    rank: number;
    visual: IntensityVisualV1;
    regions: DisplayEewRegionV1[];
  }

  // regions を予測震度 (intensity 下限の完全一致) でバケツ化し、震度ランク降順に並べる
  // (静的小リストの震度別グルーピングで使う)
  function bucketByIntensity(regions: DisplayEewRegionV1[]): IntensityBucket[] {
    const order: string[] = [];
    const buckets = new Map<string, DisplayEewRegionV1[]>();
    for (const r of regions) {
      const visual = intensityVisual(r.intensitySemantic, eewIntensityRangeLabel(r), eewIntensityRangeRank(r));
      if (!visual.render) continue;
      const key = `${r.intensitySemantic?.presence ?? "legacy"}\u0000${visual.label ?? ""}\u0000${visual.badge ?? ""}\u0000${visual.colorRank ?? ""}\u0000${visual.tooltip ?? ""}`;
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(r);
    }
    return order
      .map((key) => {
        const bucketRegions = buckets.get(key)!;
        const visual = intensityVisual(
          bucketRegions[0].intensitySemantic,
          eewIntensityRangeLabel(bucketRegions[0]),
          eewIntensityRangeRank(bucketRegions[0]),
        );
        return {
          key,
          intensity: visual.label ?? "",
          rank: visual.colorRank ?? 0,
          visual,
          regions: bucketRegions,
        };
      })
      .sort((a, b) => b.rank - a.rank);
  }

  const buckets = $derived(bucketByIntensity(displayRegions));
  const topBucket = $derived<IntensityBucket | null>(buckets[0] ?? null);
  const regionMeasureSample = $derived(
    displayRegions.reduce((longest, region) => region.name.length > longest.length ? region.name : longest, "測"),
  );
  const hasPlum = $derived(input.regions.some((r) => r.isPlum));
  const maxVisual = $derived(intensityVisual(
    input.forecastMaxIntSemantic,
    input.forecastMaxInt != null ? formatIntShort(input.forecastMaxInt) : "不明",
    input.forecastMaxIntRank,
  ));
  let regionAreaHeight = $state(0);
  let regionLineHeight = $state(0);
  let pendingRegionAreaHeight: number | null = null;
  let pendingRegionLineHeight: number | null = null;
  const regionBudget = $derived(rowCapacity(regionAreaHeight, regionLineHeight, EEW_STATIC_LIST_MAX));
  const regionPages = $derived(paginateEewRegions(displayRegions, regionBudget));
  const showStaticList = $derived(displayRegions.length > 0 && displayRegions.length <= EEW_STATIC_LIST_MAX);
  const showRegionPages = $derived(displayRegions.length > EEW_STATIC_LIST_MAX && regionPages.length > 0);
  const regionResetKey = $derived(`${input.eventId ?? ""}:${input.serial ?? ""}:${displayRegions.length}`);
  const regionCycler = createPageCycler({ pageCount: () => regionPages.length, resetKey: () => regionResetKey });
  onDestroy(() => regionCycler.destroy());
  const currentRegionPage = $derived(regionPages[regionCycler.index] ?? regionPages[0] ?? null);
  function measureRegionArea(height: number): void {
    if (settling) pendingRegionAreaHeight = height;
    else regionAreaHeight = height;
  }
  function measureRegionLine(height: number): void {
    if (settling) pendingRegionLineHeight = height;
    else regionLineHeight = height;
  }
  $effect(() => {
    if (settling) return;
    if (pendingRegionAreaHeight != null) {
      regionAreaHeight = pendingRegionAreaHeight;
      pendingRegionAreaHeight = null;
    }
    if (pendingRegionLineHeight != null) {
      regionLineHeight = pendingRegionLineHeight;
      pendingRegionLineHeight = null;
    }
  });
  // T8⑥ (preview 目視レビュー): 列数は行数 (震度バケツ数、buckets.length = .region-row の件数)
  // 駆動の明示制御にする。旧 v4 の column-width 自動分割は少ない行数でも横幅次第で2列に
  // 割れてしまっていた (eew-region-tiers.ts の v5 コメント参照)
  const regionListColumnCount = $derived(eewRegionListColumnCount(buckets.length));
</script>

<div class="eew-panel role-{role}" class:compact class:emphasized>
  <div class="heading">
    <span class="heading-text">緊急地震速報 {input.isWarning ? "(警報)" : "(予報)"}</span><span class="serial">第{input.serial ?? "-"}報{input.isFinal ? "・最終" : ""}</span>
  </div>
  <div class="tiles">
    <div class="tile tile-main">
      {#if input.isAssumedHypocenter}
        <span class="assumed-chip">仮定震源</span>
      {/if}
      <div class="hypocenter">{input.hypocenterName ?? "震源推定中"}</div>
      {#if maxVisual.render}<div class="max-int" title={maxVisual.tooltip ?? undefined} aria-label={`推定最大${maxVisual.ariaLabel ?? "震度不明"}`}>
        {#if input.forecastMaxIntSemantic == null || input.forecastMaxIntSemantic.presence === "value"}
          推定最大震度 <RollingNumber value={maxVisual.label ?? ""} />
        {:else}
          推定最大震度 <span class="semantic-value">{maxVisual.label ?? ""}</span>
        {/if}
        {#if maxVisual.badge != null}<b class="semantic-badge">{maxVisual.badge}</b>{/if}
      </div>{/if}
    </div>
    <div class="tile-stats">
      <div class="tile stat-tile">
        <span class="stat-label">{isNumericMagnitude(input.magnitude) ? "M" : "規模"}</span>
        <span class="stat-value">
          {#if isNumericMagnitude(input.magnitude)}
            <RollingNumber value={input.magnitude ?? ""} />
          {:else}
            {formatMagnitudeLabel(input.magnitude)}
          {/if}
        </span>
      </div>
      {#if input.depth != null}
        <div class="tile stat-tile">
          <span class="stat-label">深さ</span>
          <span class="stat-value"><RollingNumber value={input.depth} /></span>
        </div>
      {/if}
      {#if input.maxLgInt != null && input.maxLgInt !== "0"}
        <div class="tile stat-tile">
          <span class="stat-label">長周期</span>
          <span class="stat-value lg"><RollingNumber value={input.maxLgInt} /></span>
        </div>
      {/if}
      <!-- T8④ (preview 目視指摘): 値は「reportDateTime (当該報の受信時刻)」であり
           「次の続報が来る時刻」ではないため、ラベル「続報」は実態と食い違っていた。レビュー指定は
           「最終更新時刻」だが、.stat-tile は flex:1 で M/深さ/長周期 と 4 分割を等分するため
           (コンテンツ量に応じた幅にはならない)、既存の兄弟ラベルが 1〜3 文字 (M/深さ/長周期) の
           中で 6 文字は幅が突出し折返しやすいと判断し、4 文字の「最終更新」に短縮した
           (compact モードは flex:0 0 auto の横並びチップなので長さの影響は小さいが、
           非 compact ヒーロー表示側の等分割を優先して判断) -->
      {#if input.originTime != null}
        <div class="tile stat-tile">
          <span class="stat-label">発生時刻</span>
          <span class="stat-value"><RollingNumber value={formatHms(input.originTime)} /></span>
        </div>
      {/if}
    </div>
    {#if hasPlum}
      <div class="tile agg-tile">
        <span class="agg-plum">PLUM含む</span>
      </div>
    {/if}
    {#if showStaticList}
      <div class="tile tile-regions">
        <!-- T8⑥: 列数は class:two-column で切り替える (inline style だと compact モードの
             CSS 上書き (.eew-panel.compact .region-list { columns: unset; }) より
             inline style の方が詳細度で必ず勝ってしまい、compact でも2列になりうるため) -->
        <div
          class="region-list {tierFontClass}"
          class:two-column={regionListColumnCount === 2}
          style={regionListStyle}
        >
          {#each buckets as b (b.key)}
            <div class="region-row">
              <span class="region-intensity int-r{b.rank}" class:special-unknown={b.visual.colorClass === "quake-map-unknown"} class:special-empty={b.visual.colorClass === "quake-map-neutral"} title={b.visual.tooltip ?? undefined} aria-label={b.visual.ariaLabel ?? undefined}>震度{b.intensity}{#if b.visual.badge != null}<b class="semantic-badge">{b.visual.badge}</b>{/if}</span>
              <span class="region-names">{b.regions.map((r) => r.name).join(" ")}</span>
            </div>
          {/each}
        </div>
      </div>
    {:else if showRegionPages && currentRegionPage != null}
      <div class="tile tile-regions region-pages">
        <div class="region-page-header"><span>予測地域</span><PageDots total={regionCycler.total} current={regionCycler.index} onJump={(i) => regionCycler.jumpTo(i)} /></div>
        <div class="region-page-body" use:measureHeight={measureRegionArea}>
          <div class="region-row region-line-ruler" aria-hidden="true" use:measureBorderHeight={measureRegionLine}>
            <span class="region-intensity">震度{topBucket?.intensity ?? "-"}</span>
            <span class="region-names">{regionMeasureSample}</span>
          </div>
          {#each currentRegionPage.sections as section (section.intensity)}
            {@const visual = intensityVisual(section.semantic, section.intensity, section.rank)}
            <div class="region-row"><span class="region-intensity int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>震度{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span><span class="region-names">{section.regions.map((r) => r.name).join(" ")}</span></div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .eew-panel {
    container-type: size;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 0;
    color: var(--fg);
    background: var(--surface-panel);
    border-radius: var(--radius-panel);
    box-shadow: var(--elevation-3);
    overflow: hidden;
  }
  .heading {
    box-sizing: border-box;
    min-height: calc(var(--panel-header-min-h) * var(--panel-scale, 1));
    display: flex;
    align-items: center;
    font-size: calc(var(--panel-header-font-size) * var(--panel-scale, 1));
    font-weight: var(--type-headline-weight-emphasized);
    padding: calc(var(--panel-header-padding-v) * var(--panel-scale, 1))
      calc(var(--panel-header-padding-h) * var(--panel-scale, 1));
    background: var(--header-eewForecast-container);
    color: var(--header-eewForecast-on);
    border-bottom: var(--header-band-width) solid var(--header-band-eewForecast);
  }
  .role-eewWarning .heading {
    background: var(--header-eewWarning-container);
    color: var(--header-eewWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-eewWarning);
  }
  .eew-panel.emphasized .heading {
    filter: brightness(0.82);
    font-weight: var(--type-title-weight-emphasized);
  }
  .serial {
    margin-left: var(--space-5);
    font-size: 0.7em;
    font-weight: var(--type-label-weight);
    opacity: 0.85;
    color: inherit;
    white-space: nowrap;
  }
  .assumed-chip {
    display: inline-block;
    color: var(--c-raspberry);
    border: 1px solid var(--c-raspberry);
    padding: 2px 10px;
    border-radius: var(--radius-s);
    font-size: var(--type-body-m-size);
    font-weight: var(--type-body-weight-emphasized);
    margin: 0 0 12px;
  }
  .tiles {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) calc(28px * var(--panel-scale, 1)) calc(24px * var(--panel-scale, 1));
  }
  .tile {
    background: var(--surface-panel-raised);
    border-radius: var(--radius-m);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-1);
  }
  .tile-main {
    padding: var(--space-5) var(--space-6);
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .hypocenter {
    font-size: calc(var(--type-display-l-size) * var(--panel-scale, 1));
    font-weight: var(--num-weight);
    transition: font-weight var(--dur-weight-swell) var(--spring-effects-slow);
  }
  .max-int {
    margin-top: var(--space-2);
    font-size: calc(var(--type-headline-m-size) * var(--panel-scale, 1));
    font-weight: var(--num-weight);
    transition: font-weight var(--dur-weight-swell) var(--spring-effects-slow);
  }
  .role-eewWarning .max-int {
    color: var(--role-eewWarning);
  }
  .role-eewForecast .max-int {
    color: var(--role-eewForecast);
  }
  .tile-stats {
    display: flex;
    flex-direction: row;
    gap: var(--space-3);
  }
  .stat-tile {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-4);
  }
  .stat-label {
    font-size: var(--type-label-m-size);
    color: var(--role-muted);
  }
  .stat-value {
    font-size: var(--type-headline-m-size);
    font-weight: var(--num-weight);
  }
  .stat-value.lg {
    color: var(--c-orange);
  }
  .agg-tile {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-5);
    padding: var(--space-3) var(--space-5);
    font-size: calc(var(--type-body-l-size) * var(--panel-scale, 1));
  }
  .agg-plum {
    color: var(--c-raspberry);
  }
  .tile-regions {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: var(--space-4) var(--space-5);
  }
  .region-pages { display: flex; flex-direction: column; gap: var(--space-2); }
  .region-page-header { display: flex; align-items: center; justify-content: space-between; color: var(--role-muted); font-size: var(--type-label-m-size); }
  .region-page-body { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .region-line-ruler {
    position: absolute;
    inset: 0 0 auto;
    visibility: hidden;
    pointer-events: none;
  }
  .region-list {
    width: 100%;
    line-height: 1.2;
    /* 震度別行 (震度ラベル + 地域名の静的併記)。静的リスト (EEW_STATIC_LIST_MAX=10 件以下)
       専用でスクロールしない (T4a)。
       T8⑥: 列数はパネル幅からの自動導出 (旧 column-width、v4) をやめ、行数 (震度バケツ数)
       駆動の明示制御に戻した (eew-region-tiers.ts の eewRegionListColumnCount、v5)。
       デフォルトは 1 列、.two-column クラスが付いたときだけ 2 列にする (下記) */
    column-count: 1;
    column-gap: var(--space-6);
    /* T8③: 2 カラム時の中央仕切りを目立たせる (preview 目視指摘、emergency-1 等)。
       --hairline は「面分離用の薄い境界線色、焼付き最小」が本来の用途 (theme.css コメント参照)
       で、列内テキストと同じコンテンツ領域の仕切りには弱すぎた。--role-muted (ラベル文字等で
       既に可読な濃さの既存トークン) に差し替える。新規直値色は使わない (1 列時は column-rule
       自体が描画されないため、この色は 2 列時にのみ意味を持つ) */
    column-rule: 1px solid var(--role-muted);
  }
  .region-list.two-column {
    column-count: 2;
  }
  .region-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    font-size: inherit;
    break-inside: avoid;
    padding-bottom: var(--space-1);
  }
  .region-intensity {
    flex: 0 0 auto;
    min-width: 5em;
    font-variant-numeric: tabular-nums;
    font-weight: var(--type-body-weight-emphasized);
  }
  .semantic-badge {
    margin-left: 0.25em;
    font-weight: var(--type-label-weight-emphasized);
  }
  .region-intensity.special-unknown { color: var(--c-raspberry); }
  .region-intensity.special-empty { color: var(--role-muted); }
  .region-names {
    overflow-wrap: anywhere;
  }
  /* compact (main-stack 非 main スロット): 幅が狭いため静的リストも単一列の縦積みにする。
     .eew-panel.compact .region-list (詳細度3) は .region-list.two-column (詳細度2) より
     詳細度が高いため、two-column が付いていてもここで確実に単列へ戻る */
  .eew-panel.compact .region-list {
    columns: unset;
    column-rule: none;
  }
  /* compact (main-stack 非 main スロット): ヒーロー部を凝縮しリスト領域にカード高を渡す
     (第3波 Fix20)。震央名は display-m(44px) → headline-m(32px) へ2段降格し、推定最大震度と
     近接2行にする。M/深さ/長周期の stat タイルは箱型をやめ、既存チップ文法 (radius-full +
     surface) のインライン小チップ列へ置き換える (.tile の border/box-shadow は打ち消す) */
  .eew-panel.compact .hypocenter {
    font-size: var(--type-headline-m-size);
    line-height: 1.15;
  }
  .eew-panel.compact .max-int {
    margin-top: 2px;
    font-size: var(--type-title-m-size);
  }
  .eew-panel.compact .tile-main {
    padding: var(--space-2) var(--space-3);
  }
  .eew-panel.compact .tile-stats {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .eew-panel.compact .stat-tile {
    flex: 0 0 auto;
    flex-direction: row;
    align-items: baseline;
    gap: var(--space-1);
    padding: 2px 10px;
    border: none;
    box-shadow: none;
    border-radius: var(--radius-full);
    background: var(--surface-panel);
  }
  .eew-panel.compact .stat-label {
    font-size: var(--type-label-xs-size);
  }
  .eew-panel.compact .stat-value {
    font-size: var(--type-body-m-size);
  }
  .eew-panel.compact .tiles {
    padding: var(--space-2) var(--space-3) var(--space-3);
    gap: var(--space-1);
  }
  .eew-panel.compact .agg-tile {
    padding: var(--space-1) var(--space-3);
    gap: var(--space-1) var(--space-3);
    font-size: var(--type-body-m-size);
  }

  /* bento: 十分な幅があれば 2 カラム (主タイル+統計) + 集約行全幅 + 地域リスト全幅 */
  @container (min-width: 860px) {
    .tiles {
      display: grid;
      grid-template-areas:
        "main stats"
        "agg agg"
        "regions regions";
      grid-template-columns: 2fr 1fr;
      grid-template-rows: auto auto 1fr;
    }
    .tile-main {
      grid-area: main;
    }
    .tile-stats {
      grid-area: stats;
      flex-direction: column;
    }
    .agg-tile {
      grid-area: agg;
    }
    .tile-regions {
      grid-area: regions;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hypocenter,
    .max-int {
      transition: none;
    }
  }
</style>
