<script lang="ts">
  import { toRollCells, rollDurationMs, hasValueChanged } from "../lib/rolling-number";
  import { SPRING_EFFECTS_SLOW_MS } from "../lib/motion";

  let { value }: { value: string } = $props();

  const cells = $derived(toRollCells(value));

  // prefers-reduced-motion を購読する (TickerLane / StandbyScreen と同じパターン)。
  // matchMedia 未実装環境 (一部テスト) では false 扱いで通常ロール。
  let reducedMotion = $state(
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
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

  const durMs = $derived(rollDurationMs(reducedMotion));
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  let emphasized = $state(false);
  let prevValue: string | null = null;
  $effect(() => {
    const changed = hasValueChanged(prevValue, value);
    prevValue = value;
    if (!changed || reducedMotion) return;
    // 桁の移動が終わる頃 (roll 時間後) に heavy へ跳ね、その後 base へ戻す。
    // .rolling の transition: font-weight が rise/decay を数百 ms でならす = 着地強調。
    const land = setTimeout(() => { emphasized = true; }, rollDurationMs(reducedMotion));
    const settle = setTimeout(() => { emphasized = false; }, rollDurationMs(reducedMotion) + SPRING_EFFECTS_SLOW_MS);
    return () => {
      clearTimeout(land);
      clearTimeout(settle);
    };
  });
</script>

<!-- aria-label + data-value で値を「1 つ」として公開する (Codex R1)。桁リールは 0-9 全桁の
     テキストを持つため、aria-hidden で AT と getByText から隠し、テスト/AT は data-value/aria-label で値を取る。 -->
<span class="rolling" class:emphasized style="--roll-dur: {durMs}ms" aria-label={value} data-value={value}>
  {#each cells as cell, i (i)}
    {#if cell.kind === "digit"}
      <span class="digit" data-testid="roll-digit" aria-hidden="true">
        <span class="reel" style="transform: translateY(-{cell.digit}em)">
          {#each digits as d (d)}<span>{d}</span>{/each}
        </span>
      </span>
    {:else}
      <span class="roll-text" aria-hidden="true">{cell.text}</span>
    {/if}
  {/each}
</span>

<style>
  /* インライン要素として親テキストに溶け込む。桁揃え規範は tabular-nums + 1ch 桁幅で保つ */
  .rolling {
    display: inline-flex;
    align-items: baseline;
    font-variant-numeric: tabular-nums;
    transition: font-weight var(--spring-effects-slow-dur) var(--spring-effects-slow);
  }
  .rolling.emphasized {
    font-weight: var(--type-weight-heavy);
  }
  .digit {
    display: inline-block;
    width: 1ch;
    height: 1em;
    overflow: hidden;
    line-height: 1;
    vertical-align: baseline;
  }
  .reel {
    display: flex;
    flex-direction: column;
    transition: transform var(--roll-dur, 0ms) var(--spring-effects-default);
  }
  .reel > span {
    height: 1em;
    line-height: 1;
    text-align: center;
  }
  .roll-text {
    white-space: pre;
  }
  /* reduced-motion では瞬時差し替え (translateY は即時、情報は消さない) */
  @media (prefers-reduced-motion: reduce) {
    .reel {
      transition: none;
    }
    .rolling {
      transition: none;
    }
  }
</style>
