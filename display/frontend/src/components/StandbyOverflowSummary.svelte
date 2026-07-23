<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  let { items }: { items: ActiveStandbyCardV1[] } = $props();
  const labels: Record<string, string> = { volcano: "火山", typhoon: "台風", heat: "熱中症", flood: "洪水", tornado: "竜巻", longPeriod: "長周期", nankaiTrough: "南海トラフ" };
</script>
{#if items.length > 0}<div class="overflow">ほか{items.length}件: {items.map((item) => labels[item.kind] ?? "ほか").join("・")}</div>{/if}
<style>
  /* 高さは選抜側の予約 32px と完全一致させる (spec T4)。可変文字列の折返しで予約超過 →
     .corner-right の overflow:hidden が末尾を切る事故を封じるため 1 行固定 + ellipsis */
  .overflow {
    width: var(--standby-card-width, min(360px, 28vw));
    height: 32px;
    line-height: 32px;
    flex: 0 0 32px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--role-muted);
    font-size: max(12px, var(--type-label-xs-fluid));
    text-align: right;
  }
</style>
