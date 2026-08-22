<script lang="ts">
  import type { ActiveStandbyCardV1, DisplayWeatherAlertItemV1, DisplayWeatherAlertV1 } from "../lib/protocol";
  import { onDestroy, untrack } from "svelte";
  import { groupByPrefectureOrRegion } from "../lib/prefecture-group";
  import { resolveWeatherKindKeys, weatherAreaIdentity } from "../lib/weather-expanded-kinds";
  import { pageIdentity, sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";

  let { alerts, tornado = null, pageCoordinator: suppliedPageCoordinator, rotationMember = false, pageScheduling = false, partitionProbe, pagePlacement = "side", measurementRange, measurementPageFooter = false }: {
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
    /** This is a non-scheduled ordinary-variant shelf, not a live card. */
    measurementPageFooter?: boolean;
  } = $props();
  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;

  type CandidateTruncatedWeatherItem = DisplayWeatherAlertItemV1 & { candidateTruncated?: boolean };
  type WeatherCardItem = Omit<CandidateTruncatedWeatherItem, "shownAreaCodes"> & {
    kindKey: string;
    shownAreaCodes: Array<string | null>;
  };

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

  // wire の weatherExpandedKinds と同じく、最高 role の alert 群を表示単位にする。role 内の
  // rank は kindKey 正規化・source 横断統合の前に落とさない (spec §6 の表示単位契約)。
  const highestRoleRank = $derived(Math.max(0, ...alerts.map((alert) => rankOfRole(alert.role))));
  const rankFilteredItems = $derived.by(() => {
    const filtered = alerts
      .filter((alert) => rankOfRole(alert.role) === highestRoleRank)
      .flatMap((alert) => alert.items);
    const kindKeys = resolveWeatherKindKeys(filtered);
    return filtered.map((item, index) => ({ ...item, kindKey: kindKeys[index]! }));
  });

  // vpws50 / vpww56 は同一 kind の警報を別 source として同時配信することがあるため、
  // kind ごとに 1 グループへ統合する (跨 source 重複表示の解消)。areas は出現順を保った
  // まま union し、omittedAreaCount は合算する
  const items = $derived.by(() => {
    const merged: WeatherCardItem[] = [];
    const indexByKind = new Map<string, number>();
    for (const it of rankFilteredItems) {
      const existingIndex = indexByKind.get(it.kindKey);
      if (existingIndex == null) {
        indexByKind.set(it.kindKey, merged.length);
        merged.push({
          kind: it.kind,
          kindKey: it.kindKey,
          candidateTruncated: (it as CandidateTruncatedWeatherItem).candidateTruncated,
          displaySeverity: it.displaySeverity,
          rank: it.rank,
          shownAreas: [...it.shownAreas],
          shownAreaCodes: it.shownAreas.map((_, index) => it.shownAreaCodes?.[index] ?? null),
          omittedAreaCount: it.omittedAreaCount,
        });
        continue;
      }
      const target = merged[existingIndex];
      for (const [areaIndex, area] of it.shownAreas.entries()) {
        const areaCode = it.shownAreaCodes?.[areaIndex] ?? null;
        const identity = weatherAreaIdentity(area, areaCode);
        const existingAreaIndex = target.shownAreas.findIndex((existingArea, index) =>
          weatherAreaIdentity(existingArea, target.shownAreaCodes[index]) === identity);
        if (existingAreaIndex < 0) {
          target.shownAreas.push(area);
          target.shownAreaCodes.push(areaCode);
        } else if (target.shownAreaCodes[existingAreaIndex] == null && areaCode != null) {
          target.shownAreaCodes[existingAreaIndex] = areaCode;
        }
      }
      target.omittedAreaCount += it.omittedAreaCount;
      if ((it as CandidateTruncatedWeatherItem).candidateTruncated === true) target.candidateTruncated = true;
    }
    return merged;
  });

  const WEATHER_PAGE_AREA_CAPACITY = 8;
  const pageCandidates = $derived.by(() => items.flatMap((item) => [
    ...item.shownAreas.map((area, occurrenceIndex) => ({
      kindKey: item.kindKey,
      area,
      areaCode: item.shownAreaCodes[occurrenceIndex] ?? null,
      occurrenceIndex,
      tailOnly: false,
    })),
    ...(item.shownAreas.length === 0 && item.omittedAreaCount > 0
      ? [{ kindKey: item.kindKey, area: `tail-${item.kindKey}`, areaCode: null, occurrenceIndex: 0, tailOnly: true }]
      : []),
  ]));
  const lastAreaIndexByKind = $derived.by(() => {
    const indices = new Map<string, number>();
    for (const [index, entry] of pageCandidates.entries()) if (!entry.tailOnly) indices.set(entry.kindKey, index);
    return indices;
  });
  function tailsForRange(range: PageRange) {
    return items.flatMap((item) => {
      const last = lastAreaIndexByKind.get(item.kindKey);
      return item.omittedAreaCount > 0 && last != null && last >= range.start && last < range.end
        ? [{ kindKey: item.kindKey, omittedAreaCount: item.omittedAreaCount }]
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
    const areasByKind = new Map<string, Array<{ area: string; areaCode: string | null }>>();
    for (const entry of currentPage.entries) {
      if (entry.tailOnly) continue;
      const areas = areasByKind.get(entry.kindKey) ?? [];
      areas.push({ area: entry.area, areaCode: entry.areaCode });
      areasByKind.set(entry.kindKey, areas);
    }
    const tailKinds = new Set(currentPage.tails.map((tail) => tail.kindKey));
    for (const entry of currentPage.entries) if (entry.tailOnly) tailKinds.add(entry.kindKey);
    return items
      .map((item) => {
        const areas = areasByKind.get(item.kindKey) ?? [];
        const shownAreas = areas.map((entry) => entry.area);
        const shownAreaCodes = areas.map((entry) => entry.areaCode);
        const omittedAreaCount = tailKinds.has(item.kindKey) ? item.omittedAreaCount : 0;
        return { ...item, shownAreas, shownAreaCodes, omittedAreaCount };
      })
      .filter((item) => item.shownAreas.length > 0 || item.omittedAreaCount > 0);
  });
  const pageDiagnostics = $derived(pageCoordinator.cardDiagnostics("weather"));
  const pageTruncated = $derived(items.some((item) => item.omittedAreaCount > 0 || item.candidateTruncated === true));
  const measurementHasMultiplePages = $derived(
    measurementRange != null && (measurementRange.start > 0 || measurementRange.end < pageCandidates.length),
  );
  const measurementNeedsPageIndicator = $derived(measurementRange != null && (measurementHasMultiplePages || pageTruncated));
  // A normal variant shelf has no local scheduler.  It still needs the same
  // 1/1 footer as live only when live pagination/truncation would draw one;
  // never add that surface to an ordinary one-page, untruncated measurement.
  const measurementNeedsLiveFooter = $derived(
    measurementPageFooter && (pageCandidates.length > WEATHER_PAGE_AREA_CAPACITY || pageTruncated),
  );
  const showPageIndicator = $derived(
    measurementNeedsPageIndicator
      || measurementNeedsLiveFooter
      || (pageDiagnostics.page !== "0/0" && (weatherPages.length > 1 || pageTruncated)),
  );
  const pageIndicatorLabel = $derived(
    pageDiagnostics.page !== "0/0"
      ? pageDiagnostics.page
      : measurementRange != null || measurementNeedsLiveFooter
        ? `${(measurementRange?.start ?? 0) > 0 ? 2 : 1}/${measurementHasMultiplePages ? 2 : 1}`
        : "",
  );

  const displayItems = $derived.by(() => {
    return visibleItems.map((item) => ({
      item,
      groups: groupByPrefectureOrRegion(item.shownAreas, item.shownAreaCodes).map((group) => ({ group })),
    }));
  });

  // 都道府県 → 市区町村への階層整形は lib/prefecture-group.ts の groupByPrefecture を
  // LatestQuakeCard/QuakePanel と共有する (第3波 Fix7)。当カードのみ groupByPrefectureOrRegion
  // を使い、県名にマッチしない地域 (離島部等) も県名見出しと同格の独立見出しにする (backlog §1)
</script>

{#if alerts.length > 0 || tornado != null}
  <div
    class="weather-card" class:has-page-footer={showPageIndicator}
    data-card-page={pageDiagnostics.page}
    data-card-page-keys={JSON.stringify(pageDiagnostics.keys)}
    data-card-page-identities={JSON.stringify(pageDiagnostics.identities)}
    data-card-page-truncated={pageTruncated ? "true" : "false"}
    data-partition-probe-count={pagePartition.probeCount}
    data-card-page-infeasible={pagePartition.infeasible ? "true" : "false"}
    data-page-probe-card={measurementRange != null ? "" : undefined}
  >
    <div
      class="card-header"
      style="background: {headerContainerVar(topRole)}; color: {headerOnVar(topRole)}; border-bottom: var(--header-band-width) solid {headerBandVar(topRole)}"
    >{headerLabel(topRole, alerts)}<UpdatedStamp iso={latestUpdatedAt} /></div>
    {#if alerts.length > 0}<ul data-page-probe-body>
      {#each displayItems as entry (entry.item.kindKey)}
        <li class="rank-{entry.item.rank}" data-kind-key={entry.item.kindKey}>
          <span class="kind">{entry.item.kind}</span>
          {#each entry.groups as grouped (grouped.group.pref)}
            <div class="pref-group">
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
            <span class="omitted">ほか{entry.item.omittedAreaCount}地域</span>
          {/if}
        </li>
      {/each}
    </ul>{/if}
    {#if showPageIndicator}<div class="card-page-footer" data-card-page-footer><span class="card-page-indicator" data-card-page-indicator>{pageIndicatorLabel}</span></div>{/if}
    {#if tornado != null}<div class:sighted={tornado.data.isSighted} class="tornado-rider">⚠ {tornado.data.isSighted ? "竜巻目撃情報" : "竜巻注意情報"}（{tornado.data.areas.length > 0 ? tornado.data.areas.join("、") : "対象地域"}）{#if tornado.restored}<RestoredChip />{/if}</div>{/if}
  </div>
{/if}

<style>
  .weather-card {
    background: var(--surface-standby);
    border-radius: var(--radius-standby);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-2);
    overflow: hidden;
    position: relative;
    width: min(360px, 28vw);
    max-height: min(44vh, 280px);
    display: flex;
    flex-direction: column;
    color: var(--fg);
  }
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
    column-count: 2;
    column-gap: var(--space-3);
    column-fill: balance;
  }
  li {
    display: block;
    break-inside: auto;
    padding: 6px 0;
    font-size: max(14px, var(--type-label-l-fluid)); /* spec D1: 層1 (安全・常設 14px 以上) */
  }
  .tornado-rider { border-top: 1px solid var(--hairline); padding: var(--space-2) var(--space-4); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-body-weight-emphasized); }
  /* The zero-height page footer paints at this boundary. Keep long rider text
     out of the indicator's right-hand paint area. */
  .weather-card.has-page-footer .tornado-rider { padding-right: calc(var(--space-4) + 3.5rem); }
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
    break-inside: avoid;
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
  .card-page-footer {
    /* The legacy solver measures the weather shell without the page badge:
       the mock places it over the lower edge. Keep the actual badge just
       above the tornado rider in DOM/paint order too, without adding a row. */
    display: flex;
    flex: 0 0 0;
    justify-content: flex-end;
    box-sizing: border-box;
    height: 0;
    min-height: 0;
    padding: 0 var(--space-4);
    overflow: visible;
    pointer-events: none;
    position: relative;
    z-index: 1;
    transform: translateY(-100%);
  }
  .card-page-indicator {
    padding: 1px var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    background: color-mix(in srgb, var(--surface-standby) 92%, transparent);
    color: var(--role-muted);
    font-size: var(--type-label-xs-size);
    font-variant-numeric: tabular-nums;
  }
</style>
