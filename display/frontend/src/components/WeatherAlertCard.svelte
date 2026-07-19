<script lang="ts">
  import type { DisplayWeatherAlertItemV1, DisplayWeatherAlertV1, DisplayWeatherRank } from "../lib/protocol";
  import { groupByPrefectureOrRegion } from "../lib/prefecture-group";

  let { alerts }: { alerts: DisplayWeatherAlertV1[] } = $props();

  const RANK_ORDER: Record<DisplayWeatherRank, number> = { emergency: 3, warning: 2, advisory: 1 };

  function rankOfRole(role: string): number {
    if (role === "weatherEmergency") return 3;
    if (role === "weatherWarning") return 2;
    return 1;
  }

  const topRole = $derived(
    [...alerts].sort((a, b) => rankOfRole(b.role) - rankOfRole(a.role))[0]?.role ?? "weatherWarning",
  );

  function headerLabel(role: string): string {
    if (role === "weatherEmergency") return "気象特別警報";
    if (role === "weatherWarning") return "気象警報";
    return "気象注意報";
  }

  function headerContainerVar(role: string): string {
    if (role === "weatherEmergency") return "var(--header-weatherEmergency-container)";
    if (role === "weatherWarning") return "var(--header-weatherWarning-container)";
    return "var(--header-weatherAdvisory-container)";
  }
  function headerOnVar(role: string): string {
    if (role === "weatherEmergency") return "var(--header-weatherEmergency-on)";
    if (role === "weatherWarning") return "var(--header-weatherWarning-on)";
    return "var(--header-weatherAdvisory-on)";
  }
  function headerBandVar(role: string): string {
    if (role === "weatherEmergency") return "var(--header-band-weatherEmergency)";
    if (role === "weatherWarning") return "var(--header-band-weatherWarning)";
    return "var(--header-band-weatherAdvisory)";
  }

  // 見出しが示す最高ランクのバケツの items だけを表示する (下位ランクはテロップが
  // 伝えるため、常設カードで重複表示すると冗長)
  const allItems = $derived(alerts.flatMap((a) => a.items.map((it) => ({ ...it, _source: a.source }))));
  const topRank = $derived(Math.max(0, ...allItems.map((it) => RANK_ORDER[it.rank])));
  const rankFilteredItems = $derived(allItems.filter((it) => RANK_ORDER[it.rank] === topRank));

  // vpws50 / vpww56 は同一 kind の警報を別 source として同時配信することがあるため、
  // kind ごとに 1 グループへ統合する (跨 source 重複表示の解消)。areas は出現順を保った
  // まま union し、omittedAreaCount は合算する
  const items = $derived.by(() => {
    const merged: DisplayWeatherAlertItemV1[] = [];
    const indexByKind = new Map<string, number>();
    for (const it of rankFilteredItems) {
      const existingIndex = indexByKind.get(it.kind);
      if (existingIndex == null) {
        indexByKind.set(it.kind, merged.length);
        merged.push({
          kind: it.kind,
          displaySeverity: it.displaySeverity,
          rank: it.rank,
          shownAreas: [...it.shownAreas],
          omittedAreaCount: it.omittedAreaCount,
        });
        continue;
      }
      const target = merged[existingIndex];
      for (const area of it.shownAreas) {
        if (!target.shownAreas.includes(area)) target.shownAreas.push(area);
      }
      target.omittedAreaCount += it.omittedAreaCount;
    }
    return merged;
  });

  // 都道府県 → 市区町村への階層整形は lib/prefecture-group.ts の groupByPrefecture を
  // LatestQuakeCard/QuakePanel と共有する (第3波 Fix7)。当カードのみ groupByPrefectureOrRegion
  // を使い、県名にマッチしない地域 (離島部等) も県名見出しと同格の独立見出しにする (backlog §1)
</script>

{#if alerts.length > 0}
  <div class="weather-card">
    <div
      class="card-header"
      style="background: {headerContainerVar(topRole)}; color: {headerOnVar(topRole)}; border-bottom: var(--header-band-width) solid {headerBandVar(topRole)}"
    >{headerLabel(topRole)}</div>
    <ul>
      {#each items as it (it.kind + it.rank)}
        <li class="rank-{it.rank}">
          <span class="kind">{it.kind}</span>
          {#each groupByPrefectureOrRegion(it.shownAreas) as g (g.pref)}
            <div class="pref-group">
              <!-- 県名前方一致しない地域 (例: 沖縄本島地方・宗谷地方) も groupByPrefectureOrRegion
                   により県名見出しと同格の独立見出しとして展開されるため、pref は常に non-null
                   (実機フィードバックバックログ §1) -->
              <span class="pref-name">{g.pref}</span>
              {#if g.cities.length > 0}
                <span class="cities">
                  {#each g.cities as city (city)}<span class="city-name">{city}</span>{/each}
                </span>
              {/if}
            </div>
          {/each}
          {#if it.omittedAreaCount > 0}
            <span class="omitted">ほか{it.omittedAreaCount}地域</span>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .weather-card {
    background: var(--surface-standby);
    border-radius: var(--radius-standby);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-2);
    overflow: hidden;
    width: min(360px, 28vw);
    color: var(--fg);
  }
  .card-header {
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
    padding: var(--space-2) var(--space-4);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: var(--space-2) var(--space-4) var(--space-3);
  }
  li {
    display: flex;
    flex-direction: column;
    padding: 6px 0;
    font-size: max(14px, var(--type-label-l-fluid)); /* spec D1: 層1 (安全・常設 14px 以上) */
  }
  .kind {
    font-weight: var(--type-body-weight-emphasized);
    white-space: nowrap;
  }
  .rank-emergency .kind {
    color: var(--role-weatherEmergency);
  }
  .rank-warning .kind {
    color: var(--role-weatherWarning);
  }
  .rank-advisory .kind {
    color: var(--role-weatherAdvisory);
  }
  /* 都道府県 → 市区町村 の階層。都道府県見出しは中間サイズ、市区町村はインデントで並べる */
  .pref-group {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5em;
    margin-top: var(--space-1);
    padding-left: 1em;
  }
  .pref-name {
    flex-shrink: 0;
    font-weight: var(--type-body-weight-emphasized);
    font-size: max(14px, var(--type-body-s-fluid)); /* spec D1: 県名は警報対象地域 = 層1 (安全・常設 14px 以上) */
    color: var(--fg);
  }
  /* 市区町村名は個別 span (white-space:nowrap) にし、折返しは名前と名前の間だけで発生させる。
     区切りは文字ではなく gap で表現する (第3波 Fix14) */
  .cities {
    display: inline-flex;
    flex-wrap: wrap;
    padding-left: 0.5em;
    gap: 0.5em;
    color: var(--role-muted);
    font-size: max(14px, var(--type-label-s-fluid)); /* spec D1: 層1 (安全・常設 14px 以上) */
  }
  .city-name {
    white-space: nowrap;
  }
  .omitted {
    display: block;
    margin-top: var(--space-1);
    padding-left: 1em;
    color: var(--role-muted);
    font-size: var(--type-label-xs-size);
  }
</style>
