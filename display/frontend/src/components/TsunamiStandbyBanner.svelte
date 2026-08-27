<script lang="ts">
  import type { DisplayTsunamiLevel, DisplayTsunamiStateV1 } from "../lib/protocol";
  import {
    groupCoastsByLevel,
    highestTsunamiLevel,
    shortLevelLabel,
    summarizeTsunamiLevels,
  } from "../lib/tsunami-banner";
  import {
    buildMarqueeSegments,
    clampSegmentIndex,
    isChipEmphasized,
    isMultiSegment,
    joinMarqueeSegments,
    nextSegmentIndex,
  } from "../lib/tsunami-marquee-sequence";
  import { onDestroy } from "svelte";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { observeResize } from "../lib/measure-height";
  import { tsunamiAnchor, tsunamiAnchorCandidates, tsunamiStaticPages } from "../lib/standby-marquee-pages";
  import UpdatedStamp from "./UpdatedStamp.svelte";

  // onReplayLevel: チップクリックでその種別のテロップ再生を要求する (2026-07-14)。省略時は非対話。
  let { tsunami, onReplayLevel, staticMarquee = false, reducedMotion = false }: {
    tsunami: DisplayTsunamiStateV1;
    onReplayLevel?: (level: DisplayTsunamiLevel) => void;
    staticMarquee?: boolean;
    reducedMotion?: boolean;
  } = $props();

  function staticMarqueeFromUrl(): boolean {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("marquee") === "static";
  }
  const staticMarqueeEnabled = $derived(staticMarquee || staticMarqueeFromUrl());

  // クリックは必ず stopPropagation する: App.svelte の window click 減光トグルへ伝播させない。
  function handleChipClick(event: MouseEvent, level: DisplayTsunamiLevel): void {
    event.stopPropagation();
    onReplayLevel?.(level);
  }

  const summaries = $derived(summarizeTsunamiLevels(tsunami.coasts));
  const highest = $derived(highestTsunamiLevel(summaries, tsunami.level));
  const hasMultipleLevels = $derived(summaries.length > 1);
  // レベルごとに見出し【大津波警報】を付けてグループ化し、どの地域がどの区分か判別できるようにする
  const segments = $derived(buildMarqueeSegments(groupCoastsByLevel(tsunami.coasts)));
  const multiSegment = $derived(isMultiSegment(segments));
  // reduced-motion の静的フォールバック用: 全種別を連結した文字列 (第3波 Fix12 でもアニメーション
  // なしのときは従来どおり全部を一度に見せる。個別セグメントだけだと未巡回の種別が一切見えなくなる)
  const fullText = $derived(joinMarqueeSegments(segments));
  const anchorText = $derived(tsunamiAnchor(tsunami.coasts, tsunami.level));
  const anchorCandidates = $derived(tsunamiAnchorCandidates(tsunami.coasts, tsunami.level));
  const staticPages = $derived(tsunamiStaticPages(tsunami.coasts));
  const staticScan = $derived(reducedMotion || staticMarqueeEnabled);

  const MIN_DURATION_S = 18;
  // 「ゆっくり」流す: 下部テロップ (TickerLane、全角 5 文字/秒) より明確に遅く、全角 3 文字/秒相当に
  // する (第3波 Fix15: ユーザー指示で 2 文字/秒 → 3 文字/秒 (1.5倍速) へ意図的に変更した速度規範)
  const CHARS_PER_SECOND = 3;
  const SEGMENT_GAP_MS = 1500; // 種別の切り替わりが分かるよう、走行終了→次種別開始の間に置く間隔

  let currentIndex = $state(0);
  let displayGen = $state(0);
  let areasEl = $state<HTMLDivElement | null>(null);
  let textEl = $state<HTMLSpanElement | null>(null);
  let shiftPx = $state(0);
  let durationS = $state(MIN_DURATION_S);
  let anchorEl = $state<HTMLSpanElement | null>(null);
  let anchorLabel = $state("");
  const staticPager = createPageCycler({
    pageCount: () => staticPages.length,
    resetKey: () => `${tsunami.eventId ?? tsunami.unkeyedSequence ?? "none"}:${fullText}`,
    reducedMotion: () => reducedMotion,
  });
  onDestroy(() => staticPager.destroy());

  // 種別 (segments) の増減で currentIndex が範囲外になったら先頭に戻す
  $effect(() => {
    const clamped = clampSegmentIndex(currentIndex, segments.length);
    if (clamped !== currentIndex) currentIndex = clamped;
  });

  const currentSegment = $derived(segments[currentIndex] ?? null);
  const marqueeText = $derived(currentSegment?.text ?? "");

  function advance(): void {
    displayGen += 1;
    currentIndex = nextSegmentIndex(currentIndex, segments.length);
  }

  // 単一種別 (multiSegment=false) は現行と同じ常時強調・単一ループのまま (animation-iteration-count:
  // infinite) で、切替の間隔は不要。複数種別を巡回するときだけ 1 周ごとに止めて SEGMENT_GAP_MS
  // 空けてから次の種別へ進む (第3波 Fix12: どの種別が流れているか判別できるようにする)
  function onSegmentEnd(): void {
    if (!multiSegment) return;
    setTimeout(advance, SEGMENT_GAP_MS);
  }

  // 走行距離・duration はセグメントが切り替わる (= marqueeText/レイアウトが変わる) たびに実測して
  // 再計算する。「left:100% (コンテナ基準の開始位置) + 実測 px の shift」パターン (第3波 Fix10) を
  // セグメント単位に適用する。速度規範 (全角 3 文字/秒、第3波 Fix15) は fontSizePx 実測で維持する
  $effect(() => {
    void marqueeText;
    void displayGen;
    if (areasEl == null || textEl == null) return;
    const fontSizePx = parseFloat(getComputedStyle(textEl).fontSize) || 16;
    const textWidthPx = textEl.getBoundingClientRect().width;
    const areaWidthPx = areasEl.clientWidth;
    const distancePx = textWidthPx + areaWidthPx;
    shiftPx = -distancePx;
    durationS = Math.max(MIN_DURATION_S, distancePx / (CHARS_PER_SECOND * fontSizePx));
  });

  function fitAnchor(): void {
    if (anchorEl == null) return;
    const available = anchorEl.clientWidth;
    if (available <= 0) return;
    for (const [index, candidate] of anchorCandidates.entries()) {
      const probe = anchorEl.querySelector<HTMLElement>(`[data-anchor-probe="${index}"]`);
      if (probe != null && probe.scrollWidth <= available) {
        anchorLabel = candidate;
        return;
      }
    }
    anchorLabel = anchorCandidates.at(-1) ?? anchorText;
  }
  $effect(() => {
    void anchorText;
    void anchorEl;
    anchorLabel = anchorText;
    fitAnchor();
  });

  function highestLabel(level: DisplayTsunamiLevel): string {
    if (level === "majorWarning") return "大津波警報";
    if (level === "warning") return "津波警報";
    return "津波注意報";
  }

  function headerContainerVar(level: DisplayTsunamiLevel): string {
    if (level === "majorWarning") return "var(--header-tsunamiMajor-container)";
    if (level === "warning") return "var(--header-tsunamiWarning-container)";
    return "var(--header-tsunamiAdvisory-container)";
  }
  function headerOnVar(level: DisplayTsunamiLevel): string {
    if (level === "majorWarning") return "var(--header-tsunamiMajor-on)";
    if (level === "warning") return "var(--header-tsunamiWarning-on)";
    return "var(--header-tsunamiAdvisory-on)";
  }
  function headerBandVar(level: DisplayTsunamiLevel): string {
    if (level === "majorWarning") return "var(--header-band-tsunamiMajor)";
    if (level === "warning") return "var(--header-band-tsunamiWarning)";
    return "var(--header-band-tsunamiAdvisory)";
  }
  // count-chip は小面積で色相=意味を担うため solid の帯色面 + 面用文字色を維持する
  function chipBgVar(level: DisplayTsunamiLevel): string {
    if (level === "majorWarning") return "var(--c-tsunami-purple-bar)";
    if (level === "warning") return "var(--c-jma-red-bar)";
    return "var(--c-yellow)";
  }
  function chipFgVar(level: DisplayTsunamiLevel): string {
    return level === "advisory" ? "#000" : "#fff";
  }

  // 流れている種別に同期したチップ強調/減光の style を算出する (第3波 Fix12 で導入、Fix16 で
  // opacity 乗算方式から色ブレンド方式へ変更)。
  // 監査 (Fix16): opacity ベースの減光 (旧実装は chip 要素の opacity を 0.45 に下げていた) は、
  // 祖先の .standby.dim (寝室仕様の減光、親0.35×子0.7=実効約0.245) と乗算し、非対象チップの実効
  // アルファが 0.245×0.45≈0.11 まで落ちてほぼ視認不能になることを実測で確認した (#standby-dim +
  // 複数種別 tsunami で検証)。M3E は状態表現を「透明度の重ね掛け」ではなく on-container/container
  // のトーンペアや state-layer (背景色のブレンド) で表す方が正道のため、opacity は使わず
  // 背景色を surface へ color-mix でブレンドするトーン変化に置き換える (JMA の意味色そのものは
  // 錨のため変えず、有効時はそのまま solid で出す)
  function chipStyle(level: DisplayTsunamiLevel, dim: boolean): string {
    if (!dim) return `background: ${chipBgVar(level)}; color: ${chipFgVar(level)};`;
    return `background: color-mix(in srgb, ${chipBgVar(level)} 35%, var(--surface-standby)); color: var(--role-muted);`;
  }

</script>

<div class="tsunami-banner">
  <div
    class="banner-header"
    style="background: {headerContainerVar(highest)}; color: {headerOnVar(highest)}; border-bottom: var(--header-band-width) solid {headerBandVar(highest)}"
  >
    <span class="banner-title">{highestLabel(highest)}{#if hasMultipleLevels}<span class="etc">等</span>{/if} 発令中</span><UpdatedStamp iso={tsunami.reportDateTime} />
  </div>
  {#if summaries.length > 0}
    <div class="banner-counts">
      {#each summaries as s (s.level)}
        <button
          type="button"
          class="count-chip"
          style={chipStyle(
            s.level,
            reducedMotion ? false : !isChipEmphasized(s.level, currentSegment?.level ?? null, multiSegment),
          )}
          onclick={(e) => handleChipClick(e, s.level)}
          >{shortLevelLabel(s.level)} {s.count}</button
        >
      {/each}
    </div>
  {/if}
  {#if segments.length > 0}
    <div class="banner-areas">
      <span class="static-anchor" bind:this={anchorEl} use:observeResize={fitAnchor} data-static-anchor><span data-anchor-label>{anchorLabel || anchorText}</span>
        {#each anchorCandidates as candidate, index}
          <span class="anchor-probe" aria-hidden="true" data-anchor-probe={index}>{candidate}</span>
        {/each}
      </span>
      <div class="scan-viewport" bind:this={areasEl} data-scan-viewport>
        {#if !staticScan}
          {#key displayGen}
            <span
              class="marquee-text"
              bind:this={textEl}
              style="animation-duration: {durationS}s; animation-iteration-count: {multiSegment ? 1 : 'infinite'}; --marquee-shift: {shiftPx}px;"
              onanimationend={onSegmentEnd}
            >{marqueeText}</span>
          {/key}
        {:else}
          <span class="marquee-text-static" data-static-page data-marquee-static={staticMarqueeEnabled ? "true" : undefined}>{staticPages[staticPager.index] ?? "表示領域不足"}</span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .tsunami-banner {
    background: var(--surface-standby);
    border-radius: var(--radius-standby);
    box-shadow: var(--elevation-2);
    overflow: hidden;
    width: min(360px, 28vw);
    container-type: inline-size;
    color: var(--fg);
  }
  .banner-header {
    /* 最終更新時刻を右端へ寄せるため flex 行にする (カード header と同じ文法) */
    display: flex;
    align-items: center;
    min-width: 0;
    flex-wrap: nowrap;
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
    padding: 8px 16px;
  }
  .banner-title {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .banner-header :global(.updated-stamp) {
    min-width: 0;
    max-width: 45%;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: clamp(10px, 2.6cqw, 14px);
  }
  .etc {
    /* 最終レビュー Finding 2 (spec D1): 親 .banner-header は --type-title-s-fluid
       (clamp(14px, 1.7vw, 20px))。0.7em 単体だと 960px 幅で約 11.42px まで落ち、層2
       (低プロミネンス補足) の 12px 床を割っていた。max(12px, 0.7em) で床を保証しつつ
       親フォントに追従する比率も残す */
    font-size: max(12px, 0.7em);
  }
  .banner-counts {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    padding: 8px 16px 4px;
  }
  .count-chip {
    font-size: max(14px, var(--type-label-l-fluid)); /* spec D1: 層1 (安全・常設 14px 以上) */
    font-weight: var(--type-label-weight-emphasized);
    padding: 2px 8px;
    min-height: 24px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-full);
    white-space: nowrap;
    /* button 化 (2026-07-14 チップクリック再生)。既定装飾を消し、種別色は style 属性 (chipStyle) が担う */
    border: 0;
    font-family: inherit;
    line-height: inherit;
    cursor: pointer;
    /* 強調/減光は opacity ではなく background/color のトーン変化で表現する (第3波 Fix16、
       祖先 .standby.dim との opacity 乗算事故を避けるため。詳細はスクリプト側 chipStyle のコメント) */
    transition: background-color var(--spring-effects-default-dur) var(--spring-effects-default),
      color var(--spring-effects-default-dur) var(--spring-effects-default);
  }
  .count-chip:focus-visible {
    outline: 2px solid var(--role-muted);
    outline-offset: 2px;
  }
  .banner-areas {
    display: flex;
    align-items: baseline;
    gap: 8px;
    height: 1.5em;
    margin: 2px 0 10px;
    padding: 0 16px;
    font-size: max(14px, var(--type-label-s-fluid)); /* spec D1: 層1 (安全・常設 14px 以上) */
    color: var(--role-muted);
  }
  .static-anchor { position: relative; flex: 0 0 min(16em, calc(100% - 8em)); min-width: 0; white-space: nowrap; }
  /* left/top 0 でアンカー先頭にピン留めし、max-width + overflow で probe の
     border box をアンカー幅に留める (HeatAlertCard と同型)。left 未指定だと
     static position から始まり containment 診断が overflow を報告する。
     計測は scrollWidth (コンテンツ自然幅) を読むので clamp の影響を受けない */
  .anchor-probe { position: absolute; left: 0; top: 0; visibility: hidden; white-space: nowrap; pointer-events: none; max-width: 100%; overflow: hidden; }
  .scan-viewport { position: relative; flex: 1 0 7em; min-width: 7em; height: 1.5em; overflow: hidden; }
  .marquee-text {
    position: absolute;
    top: 0;
    /* コンテナ (.banner-areas) 基準で右端ちょうどから開始する (position の left は containing
       block 基準に解決されるため、transform の % 指定と違いテキスト自身の幅に依存しない)。
       これにより最初の文字がほぼ即座に見え始める (Fix10)。走行終端は JS 実測 px の
       --marquee-shift (テキスト幅+コンテナ幅) で与える */
    left: 100%;
    white-space: nowrap;
    animation-name: tsunami-banner-marquee;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
  @keyframes tsunami-banner-marquee {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(var(--marquee-shift, -200vw));
    }
  }
  /* reduce 時も scan は全件へ到達する静止ページであり、line clamp にはしない。 */
  .marquee-text-static {
    display: block;
    white-space: nowrap;
  }
  @container (max-width: 240px) {
    .banner-header :global(.updated-stamp) { display: none; }
  }
</style>
