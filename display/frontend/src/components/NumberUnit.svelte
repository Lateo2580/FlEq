<script lang="ts">
  // 数値+添え字のタイポグラフィ: 主役数値の前後に添え字 (prefix: M/レベル、unit: m/hPa 等) を
  // 一段小さく (約 60%) ベースライン揃えで添える。tabular-nums / num-weight は数値側だけに効かせる。
  // 添え字が空ならその span は出さない。文字列の解析はしない (null 分岐・丸め・ラベル選択は呼び出し側の責務)。
  let { value, prefix = "", unit = "" }: { value: string; prefix?: string; unit?: string } = $props();
</script>
{#if prefix !== ""}<span class="nu-prefix">{prefix}</span>{/if}<span class="nu-value">{value}</span>{#if unit !== ""}<span class="nu-unit">{unit}</span>{/if}

<style>
  .nu-value { font-variant-numeric: tabular-nums; font-weight: var(--num-weight); }
  /* 添え字はベースライン揃えのまま数値の約 60%。桁揃え/太字は数値側の役目なので継がせない。
     0.6em だけだと小さい数値 (14px 級) で 8.4px まで沈み A11y 層2 の 12px 床を割るため max(12px, ...) で床を保証。
     狭小レイアウト (12-14px 文脈) は 0.6em 階層が床で潰れるため、--number-unit-affix-size: 1em で
     縮小なし (構造だけ共有) を選べる (spec §3.1/§3.4) */
  .nu-prefix,
  .nu-unit { font-size: max(12px, var(--number-unit-affix-size, 0.6em)); font-variant-numeric: normal; font-weight: normal; }
</style>
