<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  let { items }: { items: ActiveStandbyCardV1[] } = $props();
  const labels: Record<string, string> = { volcano: "火山", typhoon: "台風", heat: "熱中症", flood: "洪水", tornado: "竜巻", longPeriod: "長周期", nankaiTrough: "南海トラフ" };
</script>
{#if items.length > 0}<div class="overflow">ほか{items.length}件: {items.map((item) => labels[item.kind] ?? "ほか").join("・")}</div>{/if}
<style>.overflow { width: min(360px, 28vw); color: var(--role-muted); font-size: max(12px, var(--type-label-xs-fluid)); text-align: right; }</style>
