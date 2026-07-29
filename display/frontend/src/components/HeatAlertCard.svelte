<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import { relativeJstDayLabel } from "../lib/jst-day-key";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "heat" }> } = $props();
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

  const MIN_DURATION_S = 18;
  const CHARS_PER_SECOND = 3; // TsunamiStandbyBanner と同じ速度規範 (第3波 Fix15)

  let areasEl = $state<HTMLDivElement | null>(null);
  let textEl = $state<HTMLSpanElement | null>(null);
  let needsMarquee = $state(false);
  let shiftPx = $state(0);
  let durationS = $state(MIN_DURATION_S);
  let reducedMotion = $state(false);

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

  // prefers-reduced-motion: reduce ではマーキーを止め、2 行 clamp の静的表示にフォールバック
  $effect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion = mq.matches;
    const onChange = (e: MediaQueryListEvent): void => {
      reducedMotion = e.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });
</script>

<section class:critical={special} class="standby-card heat-card">
  <header><span class="title">{special ? "熱中症特別警戒アラート" : "熱中症警戒アラート"}</span>{#if item.restored}<RestoredChip />{/if}<span class="date">{targetDateLabel}</span></header>
  <div class="areas" bind:this={areasEl}>
    {#if reducedMotion}
      <span class="areas-static">{areaText}</span>
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
  /* 看板ヘッダ帯: 警戒=warning 橙帯 / 特別警戒=emergency 紫帯 */
  header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
    background: var(--header-weatherWarning-container);
    color: var(--header-weatherWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-weatherWarning);
  }
  .critical header {
    background: var(--header-weatherEmergency-container);
    color: var(--header-weatherEmergency-on);
    border-bottom-color: var(--header-band-weatherEmergency);
  }
  /* タイトルは折り返さない (見出し帯 1 行固定)。日付短縮と併せて最長ケースでも wrap しない */
  .title { white-space: nowrap; }
  /* 日付は見出し帯の右端に寄せる (header は flex 済み)。色は帯上の --header-*-on を継承 */
  .date { margin-left: auto; white-space: nowrap; font-size: max(12px, var(--type-label-s-fluid)); }
  /* 対象府県のカード内マーキー行 (1 行固定、TsunamiStandbyBanner .banner-areas と同型)。
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
  /* reduced-motion 静的フォールバック: 2 行 clamp + 省略記号 (TsunamiStandbyBanner と同じ規約) */
  .areas-static {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal;
  }
  @media (prefers-reduced-motion: reduce) {
    .areas {
      height: auto;
      max-height: 2.6em;
    }
  }
</style>
