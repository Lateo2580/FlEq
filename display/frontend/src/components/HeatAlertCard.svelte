<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { relativeJstDayLabel } from "../lib/jst-day-key";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { heatAnchor, staticNamePages } from "../lib/standby-marquee-pages";
  import { observeResize } from "../lib/measure-height";
  import RestoredChip from "./RestoredChip.svelte";
  let { item, staticMarquee = false, reducedMotion = false }: { item: Extract<ActiveStandbyCardV1, { kind: "heat" }>; staticMarquee?: boolean; reducedMotion?: boolean } = $props();
  function staticMarqueeFromUrl(): boolean {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("marquee") === "static";
  }
  const staticMarqueeEnabled = $derived(staticMarquee || staticMarqueeFromUrl());
  const special = $derived(item.severity === "critical" || item.data.areas.some((area) => area.isSpecial));
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      nowMs = Date.now();
    }, 60_000);
    return () => clearInterval(id);
  });
  // 見出し帯の折り返し回避: 日付は MM/DD (月日部分) に短縮する。データ形式 (targetDate) は変えない
  const shortDate = $derived(item.data.targetDate.slice(5).replaceAll("-", "/"));
  const targetDateLabel = $derived(relativeJstDayLabel(item.data.targetDate, nowMs) ?? shortDate);
  // 対象府県は全数を 1 行で流す (2026-07-25 実機報告: 全国的な高温日は 40 府県級で、
  // 「先頭 6 件 + ほか n 件」縮約では省略側が多数になり本末転倒だった)。
  // TsunamiStandbyBanner のカード内マーキーと同じ速度規範 (全角 3 文字/秒・最低 18 秒)。
  // 収まるときはマーキーせず静的表示 (少数府県で無意味に流さない)
  const areaText = $derived(item.data.areas.map((area) => area.areaName).join("・"));
  const areaNames = $derived(item.data.areas.map((area) => area.areaName));
  const staticPages = $derived(staticNamePages(areaNames));
  const staticScan = $derived(reducedMotion || staticMarqueeEnabled);

  const MIN_DURATION_S = 18;
  const CHARS_PER_SECOND = 3; // TsunamiStandbyBanner と同じ速度規範 (第3波 Fix15)

  let areasEl = $state<HTMLDivElement | null>(null);
  let textEl = $state<HTMLSpanElement | null>(null);
  let needsMarquee = $state(false);
  let shiftPx = $state(0);
  let durationS = $state(MIN_DURATION_S);
  let anchorEl = $state<HTMLDivElement | null>(null);
  let cardEl = $state<HTMLElement | null>(null);
  let anchorCount = $state(1);
  let anchorInfeasible = $state(false);
  let anchorMeasureEpoch = 0;
  const anchorText = $derived(anchorInfeasible ? `表示領域不足（対象${areaNames.length}府県）` : heatAnchor(areaNames, anchorCount));
  const staticPager = createPageCycler({
    pageCount: () => staticPages.length,
    resetKey: () => `${item.key}:${item.updatedAt}:${areaText}`,
    reducedMotion: () => reducedMotion,
  });
  onDestroy(() => staticPager.destroy());

  function requestAnchorMeasure(): void {
    anchorMeasureEpoch += 1;
    void settleAnchorCount(anchorMeasureEpoch);
  }
  async function settleAnchorCount(epoch: number): Promise<void> {
    if (anchorEl == null || cardEl == null || areaNames.length === 0) return;
    const available = anchorEl.clientWidth;
    if (available <= 0) return;
    for (const count of [3, 2, 1]) {
      const probe = anchorEl.querySelector<HTMLElement>(`[data-anchor-probe="${count}"]`);
      if (probe == null || probe.scrollWidth > available) continue;
      anchorCount = Math.min(count, areaNames.length);
      anchorInfeasible = false;
      await tick();
      if (epoch !== anchorMeasureEpoch) return;
      if (cardEl.scrollHeight <= cardEl.clientHeight + 1) return;
    }
    anchorCount = 1;
    anchorInfeasible = true;
  }
  $effect(() => {
    void areaText;
    void anchorEl;
    void cardEl;
    anchorCount = 1;
    anchorInfeasible = false;
    requestAnchorMeasure();
  });

  // 走行距離・duration は areaText/レイアウト変化のたびに実測して再計算する
  // (「left:100% + 実測 px shift」パターン、TsunamiStandbyBanner と同型)
  $effect(() => {
    void areaText;
    if (areasEl == null || textEl == null) return;
    const fontSizePx = parseFloat(getComputedStyle(textEl).fontSize) || 16;
    const textWidthPx = textEl.getBoundingClientRect().width;
    const areaWidthPx = areasEl.clientWidth;
    const overflow = textWidthPx > areaWidthPx;
    needsMarquee = overflow;
    if (overflow) {
      const distancePx = textWidthPx + areaWidthPx;
      shiftPx = -distancePx;
      durationS = Math.max(MIN_DURATION_S, distancePx / (CHARS_PER_SECOND * fontSizePx));
    }
  });

</script>

<section bind:this={cardEl} class:critical={special} class="standby-card heat-card" data-live-border-box data-anchor-infeasible={anchorInfeasible ? "true" : undefined}>
  <header class="standby-card-header" style="--standby-header-container: {special ? 'var(--header-weatherEmergency-container)' : 'var(--header-weatherWarning-container)'}; --standby-header-on: {special ? 'var(--header-weatherEmergency-on)' : 'var(--header-weatherWarning-on)'}; --standby-header-band: {special ? 'var(--header-band-weatherEmergency)' : 'var(--header-band-weatherWarning)'}"><span class="standby-card-header__title">{special ? "熱中症特別警戒アラート" : "熱中症警戒アラート"}</span><span class="standby-card-header__meta">{#if item.restored}<RestoredChip />{/if}<span class="date">{targetDateLabel}</span></span></header>
  <div class="static-anchor" bind:this={anchorEl} use:observeResize={requestAnchorMeasure} data-static-anchor>
    <span>{anchorText}</span>
    {#each [1, 2, 3] as count}
      <span class="anchor-probe" data-anchor-probe={count}>{heatAnchor(areaNames, count)}</span>
    {/each}
  </div>
  <div class="areas" bind:this={areasEl}>
    {#if staticScan}
      <span class="areas-static" data-static-page data-marquee-static={staticMarqueeEnabled ? "true" : undefined}>{staticPages[staticPager.index] ?? "表示領域不足"}</span>
    {:else}
      <span
        class="marquee-text"
        class:running={needsMarquee}
        bind:this={textEl}
        style="animation-duration: {durationS}s; --marquee-shift: {shiftPx}px;"
      >{areaText}</span>
    {/if}
  </div>
</section>

<style>
  .standby-card { width: var(--standby-card-width, min(360px, 28vw)); max-height: 160px; background: var(--surface-standby); border: 1px solid var(--hairline); border-radius: var(--radius-standby); box-shadow: var(--elevation-2); overflow: hidden; }
  /* 日付は見出し帯の右端に寄せる (header は flex 済み)。色は帯上の --header-*-on を継承 */
  .date { white-space: nowrap; font-size: max(12px, var(--type-label-s-fluid)); }
  .static-anchor {
    position: relative;
    min-width: 0;
    margin: var(--space-2) var(--space-4) 0;
    font-size: max(14px, var(--type-label-l-fluid));
    color: var(--fg);
    line-height: 1.5;
    white-space: nowrap;
  }
  /* left/top 0 でアンカー先頭にピン留めし、max-width + overflow で probe の
     border box をアンカー幅に留める。left 未指定だと static position (可視スパンの
     直後) から始まり、狭トラックでカードの scroll containment 診断が overflow を
     報告する。計測は scrollWidth (コンテンツ自然幅) を読むので clamp の影響を受けない */
  .anchor-probe { position: absolute; left: 0; top: 0; visibility: hidden; white-space: nowrap; pointer-events: none; max-width: 100%; overflow: hidden; }
  /* 対象府県のカード内マーキー行 (1 行固定、静的アンカーの補助レーン)。
     高さ 1.5em 固定なので府県数によらずカード高が一定 = 右スタックの実測選抜にも優しい */
  .areas {
    position: relative;
    height: 1.5em;
    overflow: hidden;
    margin: var(--space-2) var(--space-4);
    font-size: max(14px, var(--type-label-l-fluid));
    color: var(--role-muted);
  }
  .marquee-text {
    position: absolute;
    top: 0;
    left: 0;
    white-space: nowrap;
  }
  /* 収まらないときだけ走らせる。開始位置はコンテナ右端 (left:100%)、終端は実測 px の
     --marquee-shift (テキスト幅 + コンテナ幅)。単一リストなので巡回は infinite */
  .marquee-text.running {
    left: 100%;
    /* duration は inline style (animation-duration: {durationS}s) が shorthand より優先される */
    animation: heat-card-marquee linear infinite;
  }
  @keyframes heat-card-marquee {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(var(--marquee-shift, -200vw));
    }
  }
  /* reduce 時も全件へ到達する静止ページであり、line clamp にはしない。 */
  .areas-static {
    display: block;
    white-space: nowrap;
  }
</style>
