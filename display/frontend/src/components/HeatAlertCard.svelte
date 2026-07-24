<script lang="ts">
  import type { ActiveStandbyCardV1 } from "../lib/protocol";
  import RestoredChip from "./RestoredChip.svelte";
  let { item }: { item: Extract<ActiveStandbyCardV1, { kind: "heat" }> } = $props();
  const special = $derived(item.severity === "critical" || item.data.areas.some((area) => area.isSpecial));
  // 見出し帯の折り返し回避: 日付は MM/DD (月日部分) に短縮する。データ形式 (targetDate) は変えない
  const shortDate = $derived(item.data.targetDate.slice(5).replaceAll("-", "/"));
  // 対象府県の縮約 (2026-07-24 実機: 全国的な高温日は 20 府県超で 160px を溢れた)。
  // WeatherAlertCard の地域 cap と同じ 6 件 + 「ほか n 件」(集約行の表記と統一)
  const AREA_MAX = 6;
  const shownAreas = $derived(item.data.areas.slice(0, AREA_MAX).map((area) => area.areaName));
  const omittedCount = $derived(Math.max(0, item.data.areas.length - AREA_MAX));
</script>

<section class:critical={special} class="standby-card heat-card">
  <header><span class="title">{special ? "熱中症特別警戒アラート" : "熱中症警戒アラート"}</span>{#if item.restored}<RestoredChip />{/if}<span class="date">{shortDate}</span></header>
  <div class="areas">
    {#each shownAreas as name, i (name)}<span class="area-name">{name}{i < shownAreas.length - 1 || omittedCount > 0 ? "・" : ""}</span>{/each}{#if omittedCount > 0}<span class="area-name">ほか{omittedCount}件</span>{/if}
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
  .areas { padding: var(--space-2) var(--space-4); font-size: max(14px, var(--type-label-l-fluid)); color: var(--role-muted); }
  /* 禁則: 府県名の途中で折り返さない (inline-block 単位で wrap)。区切りの・は前の名前に
     接着済み (markup 側) なので行頭に・が来ない */
  .area-name { display: inline-block; }
</style>
