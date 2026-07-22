<script lang="ts">
  // 数値+単位のタイポグラフィ: 数値は層1 級のまま、直後の単位を一段小さく (約 60%) して
  // ベースライン揃えで添える (「3.31m」「920hPa」)。tabular-nums / num-weight は数値側だけに
  // 効かせる (単位に桁揃え・数値太さは要らない)。単位が空なら unit span は無表示になる。
  let { value, unit }: { value: string; unit: string } = $props();
</script>
<span class="nu-value">{value}</span><span class="nu-unit">{unit}</span>

<style>
  .nu-value { font-variant-numeric: tabular-nums; font-weight: var(--num-weight); }
  /* 単位はベースライン揃えのまま数値の約 60%。桁揃え/太字は数値側の役目なので継がせない */
  .nu-unit { font-size: 0.6em; font-variant-numeric: normal; font-weight: normal; }
</style>
