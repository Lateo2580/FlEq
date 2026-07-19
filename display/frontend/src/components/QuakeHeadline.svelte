<script lang="ts">
  // 固定サマリ計器のヘッドライン2行 (最大震度規模行 + 拡大範囲行)。QuakePanel.svelte と
  // LatestQuakeCard.svelte でマークアップが完全に同型だったため T6 で共有化した
  // (spec §2-b、summary-instrument-paging spec)。
  // variant はフォントサイズ・拡大範囲行の font-weight など、2枚のカードで意図的に残っている
  // 現状のスタイル差を吸収する (T6: 視覚差は温存、report 参照)。
  import { formatIntShort } from "../lib/format";
  import type { QuakeHeadline } from "../lib/instrument-layout";

  let {
    headline,
    variant,
    compact = false,
  }: { headline: QuakeHeadline | null; variant: "panel" | "card"; compact?: boolean } = $props();
</script>

{#if headline != null}
  <div class="instruments variant-{variant}" class:compact>
    <div class="instrument-row instrument-top">
      <span class="int-chip int-r{headline.topRank}">{formatIntShort(headline.topIntensity)}</span>
      <!-- T7 回帰修正: areas が県プレフィックス無し (「宮崎市」等) だと topPrefectureCount が 0 に
           なり得る。「0県2市町村」は意味不明なので、0 のときは「N県」部分を省いて市町村数だけ出す -->
      <span class="instrument-value"
        >{#if headline.topPrefectureCount > 0}{headline.topPrefectureCount}県{/if}{headline.topCityCount}市町村</span
      >
    </div>
    {#if headline.expanded != null}
      <div class="instrument-row instrument-expanded">
        <span class="instrument-label">{headline.expanded.intensity}以上</span>
        <span class="instrument-value">{headline.expanded.prefectureCount}県に拡大</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .instruments {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .instrument-row {
    display: flex;
    align-items: baseline;
    gap: 0.6em;
    min-width: 0;
  }
  .instrument-label {
    flex-shrink: 0;
    color: var(--role-muted);
    font-weight: var(--type-body-weight-emphasized);
  }
  .instrument-value {
    font-variant-numeric: tabular-nums;
  }
  /* variant-panel: QuakePanel.svelte (緊急パネル、panel-scale に追従、拡大範囲行は title 級) */
  .instruments.variant-panel {
    font-size: calc(var(--type-label-s-fluid) * var(--panel-scale, 1));
  }
  .instruments.variant-panel .instrument-top .instrument-value {
    font-weight: var(--type-title-weight-emphasized);
  }
  .instruments.variant-panel.compact {
    font-size: var(--type-label-xs-size);
  }
  /* variant-card: LatestQuakeCard.svelte (待機カード、固定 fluid token、拡大範囲行は body 級) */
  .instruments.variant-card {
    margin: 4px 0 0;
    font-size: var(--type-label-s-fluid);
  }
  .instruments.variant-card .instrument-top .instrument-value {
    font-weight: var(--type-body-weight-emphasized);
  }
  /* int-chip: 元々 QuakePanel と LatestQuakeCard で幅/padding/weight/背景が異なっていたため
     (それぞれのカード全体で共通の .int-chip ルールを使っていた)、その現状差を variant ごとに温存する */
  .int-chip {
    flex-shrink: 0;
    text-align: center;
    border-radius: var(--radius-s);
    font-variant-numeric: tabular-nums;
  }
  .instruments.variant-panel .int-chip {
    width: 3.2em;
    padding: 2px 10px;
    font-weight: var(--type-title-weight-emphasized);
    background: var(--surface-panel);
  }
  .instruments.variant-card .int-chip {
    width: 2.6em;
    padding: 2px 6px;
    font-weight: var(--num-weight);
    background: var(--surface-panel-raised);
  }
  .int-r0 { color: var(--role-muted); }
  .int-r1 { color: var(--int-1); }
  .int-r2 { color: var(--int-2); }
  .int-r3 { color: var(--int-3); }
  .int-r4 { color: var(--int-4); }
  .int-r5 { color: var(--int-5); }
  .int-r6 { color: var(--int-6); }
  .int-r7 { color: var(--int-7); }
  .int-r8 {
    background: var(--int-8-bg);
    color: var(--int-8-on);
  }
  .int-r9 {
    background: var(--int-9-bg);
    color: var(--int-9-on);
  }
</style>
