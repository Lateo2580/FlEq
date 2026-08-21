<script lang="ts">
  import type { ActiveStandbyCardV1, DisplayWeatherAlertItemV1, DisplayWeatherAlertV1, DisplayWeatherRank } from "../lib/protocol";
  import { onDestroy, tick, untrack } from "svelte";
  import { groupByPrefectureOrRegion } from "../lib/prefecture-group";
  import { pageIdentity, sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";

  let { alerts, tornado = null, pageCoordinator: suppliedPageCoordinator, rotationMember = false, pageScheduling = false, partitionProbe, pagePlacement = "side", measurementRange }: {
    alerts: DisplayWeatherAlertV1[];
    tornado?: Extract<ActiveStandbyCardV1, { kind: "tornado" }> | null;
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    /** U3 shelf-backed actual page composition probe. */
    partitionProbe?: PartitionProbe;
    pagePlacement?: "side" | "center";
    /** A single shelf probe renders exactly this candidate range. */
    measurementRange?: PageRange;
  } = $props();
  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;

  const RANK_ORDER: Record<DisplayWeatherRank, number> = { emergency: 3, warning: 2, advisory: 1 };

  function rankOfRole(role: string): number {
    if (role === "weatherEmergency") return 3;
    if (role === "weatherWarning") return 2;
    return 1;
  }

  const topRole = $derived(
    [...alerts].sort((a, b) => rankOfRole(b.role) - rankOfRole(a.role))[0]?.role ?? "weatherWarning",
  );

  // 最終更新時刻 (ご主人要望 2026-07-26)。VPWS50 / VPWW56 は独立に届くので、カードが束ねている
  // alert のうち最も新しい updatedAt を採る (このカードは複数 source をまとめて 1 枚で見せるため、
  // 「このカードの中身がいつの情報か」の答えは最新の受理時刻になる)。空配列は null
  // **文字列比較にしない**: ISO 文字列はオフセット表記が違うと辞書順と時系列順が一致しない。
  // 起動 seed は `toISOString()` の `Z`、live 更新は電文の reportDateTime (`+09:00`) をそのまま
  // 運ぶので、実際に混在しうる ("2026-07-08T00:05:00.000Z" は "2026-07-08T09:00:00+09:00" より
  // 5 分新しいが、辞書順では後者が勝つ)。時刻として解釈してから比べる
  const instantOf = (iso: string): number => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  const latestUpdatedAt = $derived(
    alerts.reduce<string | null>(
      (latest, a) => (latest == null || instantOf(a.updatedAt) > instantOf(latest) ? a.updatedAt : latest),
      null,
    ),
  );

  function headerLabel(role: string, alertsForHeader: DisplayWeatherAlertV1[]): string {
    if (role === "weatherEmergency") return "気象特別警報";
    if (role === "weatherWarning") {
      return alertsForHeader.some((alert) =>
        alert.items.some((item) => item.displaySeverity === "officialL4")
      )
        ? "気象危険警報"
        : "気象警報";
    }
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

  // Unit 4 owns state and content switching here; U5 will replace this interim
  // single-column page composition with the two-column weather composition.
  const WEATHER_PAGE_AREA_CAPACITY = 8;
  const pageCandidates = $derived.by(() => items.flatMap((item) => [
    ...item.shownAreas.map((area, occurrenceIndex) => ({ kindKey: item.kind, area, occurrenceIndex, tailOnly: false })),
    ...(item.shownAreas.length === 0 && item.omittedAreaCount > 0
      ? [{ kindKey: item.kind, area: `tail-${item.kind}`, occurrenceIndex: 0, tailOnly: true }]
      : []),
  ]));
  const lastAreaIndexByKind = $derived.by(() => {
    const indices = new Map<string, number>();
    for (const [index, entry] of pageCandidates.entries()) if (!entry.tailOnly) indices.set(entry.kindKey, index);
    return indices;
  });
  function tailsForRange(range: PageRange) {
    return items.flatMap((item) => {
      const last = lastAreaIndexByKind.get(item.kind);
      return item.omittedAreaCount > 0 && last != null && last >= range.start && last < range.end
        ? [{ kindKey: item.kind, omittedAreaCount: item.omittedAreaCount }]
        : [];
    });
  }
  const pagePartition = $derived.by(() => {
    if (measurementRange != null) return { ranges: [measurementRange], pending: [], infeasible: false, probeCount: 1 };
    if (partitionProbe != null) return sequentialPartitionRanges(
      "weather", pagePlacement, pageCandidates.length, 1, partitionProbe, tailsForRange,
    );
    return sequentialPartitionRanges(
      "weather", pagePlacement, pageCandidates.length, WEATHER_PAGE_AREA_CAPACITY,
      (_key, _placement, range) => range.end - range.start,
      tailsForRange,
    );
  });
  const weatherPages = $derived(pagePartition.ranges.map((range) => ({
    entries: pageCandidates.slice(range.start, range.end), tails: range.tails,
  })));
  const pageIdentities = $derived(weatherPages.map((page, index) => pageIdentity(page.entries[0] ?? {
    kindKey: "weather", area: `page-${index + 1}`, occurrenceIndex: 0,
  })));
  const pageLabels = $derived(weatherPages.map((page, index) => page.entries[0]?.area ?? `page-${index + 1}`));
  $effect(() => {
    pageCoordinator.register({
      key: "weather",
      identities: pageScheduling ? pageIdentities : [],
      labels: pageScheduling ? pageLabels : [],
      rotationMember,
    });
  });
  onDestroy(() => {
    if (ownsPageCoordinator) pageCoordinator.dispose();
  });
  const currentPageIndex = $derived(pageCoordinator.activeIndex("weather"));
  const currentPage = $derived(weatherPages[currentPageIndex] ?? weatherPages[0] ?? { entries: [], tails: [] });
  const visibleItems = $derived.by(() => {
    // A shelf probe is a forced [start, end) composition even when that
    // local range makes one page. Never fall back to the static all-items
    // branch, or U3 would falsely measure every later candidate as fitting.
    if ((!pageScheduling && measurementRange == null) || (weatherPages.length <= 1 && measurementRange == null)) return items;
    const areasByKind = new Map<string, string[]>();
    for (const entry of currentPage.entries) {
      if (entry.tailOnly) continue;
      const areas = areasByKind.get(entry.kindKey) ?? [];
      areas.push(entry.area);
      areasByKind.set(entry.kindKey, areas);
    }
    const tailKinds = new Set(currentPage.tails.map((tail) => tail.kindKey));
    for (const entry of currentPage.entries) if (entry.tailOnly) tailKinds.add(entry.kindKey);
    return items
      .map((item) => {
        const shownAreas = areasByKind.get(item.kind) ?? [];
        const omittedAreaCount = tailKinds.has(item.kind) ? item.omittedAreaCount : 0;
        return { ...item, shownAreas, omittedAreaCount };
      })
      .filter((item) => item.shownAreas.length > 0 || item.omittedAreaCount > 0);
  });
  const pageDiagnostics = $derived(pageCoordinator.cardDiagnostics("weather"));

  const displayItems = $derived.by(() => {
    let rowIndex = 0;
    return visibleItems.map((item) => {
      const kindRowIndex = rowIndex++;
      const groups = groupByPrefectureOrRegion(item.shownAreas).map((group) => ({
        group,
        rowIndex: rowIndex++,
      }));
      const omittedRowIndex = item.omittedAreaCount > 0 ? rowIndex++ : null;
      return { item, kindRowIndex, groups, omittedRowIndex };
    });
  });
  let visibleRowLimit = $state<number | null>(null);
  const clippedCount = $derived.by(() => {
    if (visibleRowLimit == null) return 0;
    const limit = visibleRowLimit;
    let count = 0;
    for (const entry of displayItems) {
      if (entry.kindRowIndex >= limit) {
        count += 1;
        continue;
      }
      count += entry.groups.filter(({ rowIndex }) => rowIndex >= limit).length;
      if (entry.omittedRowIndex != null && entry.omittedRowIndex >= limit) {
        count += entry.item.omittedAreaCount;
      }
    }
    return count;
  });
  // 行数が同じでも警報名・地域名・市区町村名の長さで折返し高は変わる。表示文字列そのものを
  // key に含め、同構造の内容差し替えでも action.update から再計測する。
  const clipMeasureKey = $derived(JSON.stringify(displayItems.map((entry) => ({
    kind: entry.item.kind,
    rank: entry.item.rank,
    groups: entry.groups.map(({ group }) => ({ pref: group.pref, cities: group.cities })),
    omittedAreaCount: entry.item.omittedAreaCount,
  }))));

  // max-height 内に実際に収まる行だけを残す。地域名の折返しも DOM の実高で判定し、
  // 切られる末尾は件数つきの 1 行へ置換する。jsdom の全矩形 0 は「未計測」として全表示する。
  function clipWeatherRows(node: HTMLUListElement, measureKey: string) {
    if (measureKey === "") return { update: () => {}, destroy: () => {} };
    let generation = 0;
    let destroyed = false;
    let suppressObserver = true;
    let releaseObserverTimer: ReturnType<typeof setTimeout> | null = null;
    const observed = new Set<Element>();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (!suppressObserver) void measure();
    });
    const syncObservedRows = () => {
      const targets = new Set<Element>([
        node,
        ...node.querySelectorAll<HTMLElement>("[data-weather-row], [data-clip-summary]"),
      ]);
      for (const target of observed) {
        if (!targets.has(target)) {
          observer?.unobserve(target);
          observed.delete(target);
        }
      }
      for (const target of targets) {
        if (!observed.has(target)) {
          observer?.observe(target);
          observed.add(target);
        }
      }
    };
    const measure = async () => {
      const current = ++generation;
      suppressObserver = true;
      if (releaseObserverTimer != null) clearTimeout(releaseObserverTimer);
      visibleRowLimit = null;
      await tick();
      if (destroyed || current !== generation) return;
      syncObservedRows();
      const listRect = node.getBoundingClientRect();
      const rows = [...node.querySelectorAll<HTMLElement>("[data-weather-row]")];
      const lastBottom = rows.at(-1)?.getBoundingClientRect().bottom ?? listRect.top;
      if (listRect.height > 0 && lastBottom > listRect.bottom) {
        const summaryRect = node.querySelector<HTMLElement>("[data-clip-summary]")?.getBoundingClientRect();
        // 省略行の top が、その padding・font metrics・bottom inset をすべて含む正確な境界になる。
        const contentBottom = summaryRect != null && summaryRect.height > 0
          ? summaryRect.top
          : listRect.bottom;
        let limit = 0;
        for (const row of rows) {
          const rowIndex = Number(row.dataset.weatherRow);
          if (row.getBoundingClientRect().bottom > contentBottom) break;
          limit = rowIndex + 1;
        }
        visibleRowLimit = Math.max(1, limit);
      }
      await tick();
      if (destroyed || current !== generation) return;
      syncObservedRows();
      // 自身の full↔clip 切替で届く ResizeObserver 通知は捨て、次フレーム以降の
      // viewport・行折返し・font metrics 変化だけを再計測トリガーにする。
      releaseObserverTimer = setTimeout(() => { suppressObserver = false; }, 0);
    };
    observer?.observe(node);
    observed.add(node);
    void measure();
    const fonts = typeof document === "undefined" ? null : document.fonts;
    const onFontsLoaded = () => { if (!destroyed) void measure(); };
    void fonts?.ready.then(onFontsLoaded);
    fonts?.addEventListener("loadingdone", onFontsLoaded);
    return {
      update(nextKey: string) {
        if (nextKey !== measureKey) {
          measureKey = nextKey;
          void measure();
        }
      },
      destroy() {
        destroyed = true;
        generation += 1;
        if (releaseObserverTimer != null) clearTimeout(releaseObserverTimer);
        fonts?.removeEventListener("loadingdone", onFontsLoaded);
        observer?.disconnect();
        observed.clear();
      },
    };
  }

  // 都道府県 → 市区町村への階層整形は lib/prefecture-group.ts の groupByPrefecture を
  // LatestQuakeCard/QuakePanel と共有する (第3波 Fix7)。当カードのみ groupByPrefectureOrRegion
  // を使い、県名にマッチしない地域 (離島部等) も県名見出しと同格の独立見出しにする (backlog §1)
</script>

{#if alerts.length > 0 || tornado != null}
  <div
    class="weather-card"
    class:clipped={clippedCount > 0}
    data-card-page={pageDiagnostics.page}
    data-card-page-keys={JSON.stringify(pageDiagnostics.keys)}
    data-card-page-identities={JSON.stringify(pageDiagnostics.identities)}
  >
    <div
      class="card-header"
      style="background: {headerContainerVar(topRole)}; color: {headerOnVar(topRole)}; border-bottom: var(--header-band-width) solid {headerBandVar(topRole)}"
    >{headerLabel(topRole, alerts)}<UpdatedStamp iso={latestUpdatedAt} /></div>
    {#if alerts.length > 0}<ul data-page-probe-body={measurementRange != null ? "" : undefined} use:clipWeatherRows={pageScheduling || measurementRange != null ? "" : clipMeasureKey}>
      {#each displayItems as entry (entry.item.kind + entry.item.rank)}
        <li class="rank-{entry.item.rank}" class:clip-hidden={visibleRowLimit != null && entry.kindRowIndex >= visibleRowLimit}>
          <span class="kind" data-weather-row={entry.kindRowIndex}>{entry.item.kind}</span>
          {#each entry.groups as grouped (grouped.group.pref)}
            <div class="pref-group" data-weather-row={grouped.rowIndex} class:clip-hidden={visibleRowLimit != null && grouped.rowIndex >= visibleRowLimit}>
              <!-- 県名前方一致しない地域 (例: 沖縄本島地方・宗谷地方) も groupByPrefectureOrRegion
                   により県名見出しと同格の独立見出しとして展開されるため、pref は常に non-null
                   (実機フィードバックバックログ §1) -->
              <span class="pref-name">{grouped.group.pref}</span>
              {#if grouped.group.cities.length > 0}
                <span class="cities">
                  {#each grouped.group.cities as city (city)}<span class="city-name">{city}</span>{/each}
                </span>
              {/if}
            </div>
          {/each}
          {#if entry.item.omittedAreaCount > 0}
            <span class="omitted" data-weather-row={entry.omittedRowIndex} class:clip-hidden={visibleRowLimit != null && entry.omittedRowIndex != null && entry.omittedRowIndex >= visibleRowLimit}>ほか{entry.item.omittedAreaCount}地域</span>
          {/if}
        </li>
      {/each}
      <li
        class="clip-summary"
        class:clip-summary-hidden={clippedCount === 0}
        data-clip-summary
        aria-hidden={clippedCount === 0 ? "true" : undefined}
      >ほか{clippedCount}項目/地域</li>
    </ul>{/if}
    {#if tornado != null}<div class:sighted={tornado.data.isSighted} class="tornado-rider">⚠ {tornado.data.isSighted ? "竜巻目撃情報" : "竜巻注意情報"}（{tornado.data.areas[0] ?? "対象地域"}{tornado.data.areas.length > 1 ? " ほか" : ""}）{#if tornado.restored}<RestoredChip />{/if}</div>{/if}
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
    max-height: min(44vh, 280px);
    display: flex;
    flex-direction: column;
    color: var(--fg);
  }
  .weather-card.clipped { height: min(44vh, 280px); }
  .card-header {
    /* 最終更新時刻を右端へ寄せるため flex 行にする (他カードの header と同じ文法) */
    display: flex;
    align-items: center;
    font-size: var(--type-title-s-fluid);
    font-weight: var(--type-title-weight-emphasized);
    padding: var(--space-2) var(--space-4);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: var(--space-2) var(--space-4) var(--space-3);
    overflow: hidden;
    position: relative;
  }
  li {
    display: flex;
    flex-direction: column;
    padding: 6px 0;
    font-size: max(14px, var(--type-label-l-fluid)); /* spec D1: 層1 (安全・常設 14px 以上) */
  }
  .tornado-rider { border-top: 1px solid var(--hairline); padding: var(--space-2) var(--space-4); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-body-weight-emphasized); }
  .tornado-rider.sighted { color: var(--role-weatherEmergency); background: color-mix(in srgb, var(--role-weatherEmergency) 10%, var(--surface-standby)); }
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
  .clip-hidden { display: none; }
  .clip-summary {
    position: absolute;
    right: var(--space-4);
    bottom: var(--space-2);
    left: var(--space-4);
    padding: 2px 0;
    color: var(--role-muted);
    background: var(--surface-standby);
    font-size: var(--type-label-xs-size);
    font-weight: var(--type-body-weight-emphasized);
  }
  .clip-summary-hidden { visibility: hidden; }
</style>
