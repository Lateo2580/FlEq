<script lang="ts">
  import type { DisplayStatsV1 } from "../lib/protocol";
  let { stats }: { stats: DisplayStatsV1 | null } = $props();

  const W = 120;
  const H = 20;
  const GAP = 2;
  interface Bar { x: number; y: number; w: number; h: number }
  const bars = $derived(buildBars(stats?.sparklineData ?? []));
  function buildBars(data: number[]): Bar[] {
    if (data.length === 0) return [];
    const max = Math.max(1, ...data);
    const barW = Math.max(1, (W - GAP * (data.length - 1)) / data.length);
    return data.map((v, i) => {
      const h = Math.max(0, (v / max) * H);
      return { x: i * (barW + GAP), y: H - h, w: barW, h };
    });
  }
</script>

{#if stats != null}
  <div class="instrument-row">
    <svg class="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {#each bars as b, i (i)}<rect x={b.x} y={b.y} width={b.w} height={b.h} fill="var(--role-muted)" />{/each}
    </svg>
    <span class="stat">受信 <b>{stats.totalReceived}</b> 通</span>
    <span class="sep">·</span>
    <span class="stat">本日の地震 <b>{stats.todayQuakeCount}</b> 件</span>
  </div>
{/if}

<style>
  .instrument-row {
    display: flex; align-items: center; gap: var(--space-3);
    color: var(--role-muted);
    font-size: var(--type-body-s-fluid);
    font-variant-numeric: tabular-nums;
  }
  .sparkline { width: 120px; height: 20px; }
  .stat b { color: var(--fg); font-weight: var(--num-weight); }
  .sep { color: var(--fg-faint); }
</style>
