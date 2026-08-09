<script lang="ts">
  import type { DisplayRecentQuakeV1 } from "../lib/protocol";
  import { formatMdHm, formatIntShort } from "../lib/format";
  import { depthVisual, magnitudeVisual } from "../lib/magnitude";
  import { groupByPrefecture } from "../lib/prefecture-group";
  import { compactIntensityGroups, type CompactIntensityGroup } from "../lib/compact-intensity";
  import { intensityVisual } from "../lib/quake-map-colors";

  // 待機画面の地震履歴クリックで再表示する専用コンパクトカード (2026-07-14)。QuakePanel は緊急画面用で
  // 過剰なため再利用しない。履歴 DTO (DisplayRecentQuakeV1) に実在する値だけを出し、無い情報は偽装しない。
  // デザイン言語・各地の震度の表示文法 (震度チップ int-r / 県グループ化 / ほか N 地域) は LatestQuakeCard と
  // 揃える。ページングは持ち込まず compactIntensityGroups で rank 降順・地域数上限に間引く。
  // カード自体がボタンで、どこをクリックしても閉じる。クリックは stopPropagation して window 減光トグルへ
  // 伝播させない (RecentQuakes の行ボタンと同じ規約)。
  let { quake, onClose }: { quake: DisplayRecentQuakeV1; onClose?: () => void } = $props();

  // intensityGroups は protocol 上 optional (古い snapshot 対応)。欠落は空配列として扱う。
  const compact = $derived(compactIntensityGroups(quake.intensityGroups ?? []));
  const maxVisual = $derived(intensityVisual(quake.maxIntSemantic, formatIntShort(quake.maxInt), quake.maxIntRank));
  const maxSeverityRank = $derived(quake.maxIntSemantic == null ? quake.maxIntRank : quake.maxIntSemantic.safetyRank);
  const magnitude = $derived(magnitudeVisual(quake.magnitudeSemantic, quake.magnitude));
  const depth = $derived(depthVisual(quake.depthSemantic, quake.depth));

  function handleClick(event: MouseEvent): void {
    event.stopPropagation();
    onClose?.();
  }

  function replayGroupKey(group: CompactIntensityGroup, index: number): string {
    const visual = intensityVisual(group.intensitySemantic, group.intensity, group.rank);
    return `${group.intensitySemantic?.presence ?? "legacy"}:${visual.label ?? ""}:${visual.badge ?? ""}:${visual.colorRank ?? ""}:${index}`;
  }
</script>

<button class="quake-replay-card" type="button" onclick={handleClick}>
  <div class="banner-header" class:critical={(maxSeverityRank ?? 0) >= 7}>地震情報</div>
  <div class="card-body">
    <div class="summary-row">
      {#if maxVisual.render}<span class="int-chip int-r{maxVisual.colorRank ?? 0}" class:special-unknown={maxVisual.colorClass === "quake-map-unknown"} class:special-empty={maxVisual.colorClass === "quake-map-neutral"} title={maxVisual.tooltip ?? undefined} aria-label={maxVisual.ariaLabel ?? undefined}>{maxVisual.label ?? ""}{#if maxVisual.badge != null}<b class="semantic-badge">{maxVisual.badge}</b>{/if}</span>{/if}
      <span class="hypocenter">{quake.hypocenterName ?? "不明"}</span>
      {#if quake.tsunamiWarning}<span class="tsunami-mark">津波</span>{/if}
    </div>
    <div class="meta">
      <div class="stat">
        <span class="stat-label">規模</span>
        <span class="stat-value" title={magnitude.tooltip ?? undefined} aria-label={quake.magnitudeSemantic == null && quake.magnitude == null ? "マグニチュード: -" : magnitude.ariaLabel}>{quake.magnitudeSemantic == null && quake.magnitude == null ? "-" : magnitude.label}{#if magnitude.badge != null}<b class="semantic-badge">{magnitude.badge}</b>{/if}</span>
      </div>
      <div class="stat">
        <span class="stat-label">深さ</span>
        <span class="stat-value" title={depth.tooltip ?? undefined} aria-label={depth.ariaLabel}>{depth.label}{#if depth.badge != null}<b class="semantic-badge">{depth.badge}</b>{/if}</span>
      </div>
      <div class="stat">
        <span class="stat-label">発生</span>
        <span class="stat-value">{formatMdHm(quake.originTime ?? quake.reportDateTime)}</span>
      </div>
    </div>
    {#if compact.groups.length > 0}
      <!-- 各地の震度 (LatestQuakeCard の静的リストと同じ文法。rank 降順・地域数上限で間引き済み) -->
      <ul class="groups">
        {#each compact.groups as g, index (replayGroupKey(g, index))}
          {@const visual = intensityVisual(g.intensitySemantic, g.intensity, g.rank)}
          <li>
            <span class="g-int int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>震度{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
            <div class="g-pref-groups">
              {#each groupByPrefecture(g.areas) as pg (pg.pref ?? "その他")}
                <div class="pref-group">
                  {#if pg.pref != null}<span class="pref-name">{pg.pref}</span>{/if}
                  {#if pg.cities.length > 0}
                    <span class="cities">
                      {#each pg.cities as city (city)}<span class="city-name">{city}</span>{/each}
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          </li>
        {/each}
      </ul>
      {#if compact.omittedAreaCount > 0}
        <div class="g-omitted">ほか{compact.omittedAreaCount}地域</div>
      {/if}
    {/if}
  </div>
</button>

<style>
  /* LatestQuakeCard と同じデザイン言語・寸法 (surface-standby / radius-standby / elevation-2 / 看板ヘッダ /
     幅 min(360px,28vw))。corner-left の LatestQuakeCard スロットに置き換えで出すため寸法を揃える。
     カード全体がボタンなので button 既定装飾を消す。 */
  .quake-replay-card {
    display: block;
    width: min(360px, 28vw);
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
    box-shadow: var(--elevation-2);
    color: var(--fg);
    text-align: left;
    font: inherit;
    cursor: pointer;
    overflow: hidden;
  }
  .quake-replay-card:focus-visible {
    outline: 2px solid var(--role-muted);
    outline-offset: 2px;
  }
  .banner-header {
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
    padding: 8px 16px;
    background: var(--header-quakeWarning-container);
    color: var(--header-quakeWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeWarning);
  }
  .banner-header.critical {
    background: var(--header-quakeCritical-container);
    color: var(--header-quakeCritical-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeCritical);
  }
  .card-body {
    padding: var(--space-3) var(--space-4);
  }
  .summary-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .int-chip {
    min-width: 2.6em;
    max-width: 12em;
    text-align: center;
    padding: 2px 6px;
    border-radius: var(--radius-s);
    font-weight: var(--num-weight);
    background: var(--surface-panel-raised);
    overflow-wrap: anywhere;
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
    color: #000;
  }
  .int-r9 {
    background: var(--int-9-bg);
    color: #fff;
  }
  .semantic-badge { margin-left: 0.25em; font-weight: var(--type-label-weight-emphasized); }
  .int-chip.special-unknown,
  .g-int.special-unknown { color: var(--c-raspberry); border: 1px dashed currentColor; }
  .int-chip.special-empty,
  .g-int.special-empty { color: var(--role-muted); border: 1px dotted currentColor; }
  .hypocenter {
    font-weight: var(--type-title-weight-emphasized);
    font-size: var(--type-title-s-fluid);
  }
  .tsunami-mark {
    color: var(--c-jma-red);
    font-weight: var(--type-body-weight-emphasized);
  }
  .meta {
    display: flex;
    gap: var(--space-4);
    margin: var(--space-2) 0 0;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stat-label {
    font-size: var(--type-label-xs-size);
    color: var(--role-muted);
  }
  .stat-value {
    font-size: var(--type-body-l-fluid);
    font-weight: var(--num-weight);
    font-variant-numeric: tabular-nums;
  }
  /* 各地の震度リスト。LatestQuakeCard の静的リスト (.groups) と同じ文法・トークンで揃える。
     int-r{rank} は上の int-chip と共有 (震度チップの意味色)。 */
  .groups {
    margin: var(--space-2) 0 0;
    font-size: var(--type-label-s-fluid);
    list-style: none;
    padding: 0;
  }
  .groups li {
    display: flex;
    gap: 10px;
    padding: 3px 0;
    align-items: flex-start;
  }
  .g-int {
    flex-shrink: 0;
    font-weight: var(--type-body-weight-emphasized);
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .g-pref-groups {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pref-group {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4em;
  }
  .pref-name {
    flex-shrink: 0;
    font-weight: var(--type-body-weight-emphasized);
    color: var(--fg);
  }
  .cities {
    display: contents;
    color: var(--role-muted);
  }
  .city-name {
    white-space: nowrap;
  }
  .g-omitted {
    display: block;
    margin-top: 2px;
    color: var(--role-muted);
    font-size: var(--type-label-xs-size);
  }
</style>
