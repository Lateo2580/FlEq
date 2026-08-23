<script lang="ts">
  import type { ActiveStandbyCardV1, DisplayWeatherAlertItemV1, DisplayWeatherAlertV1 } from "../lib/protocol";
  import { onDestroy, untrack } from "svelte";
  import { groupByPrefectureOrRegion } from "../lib/prefecture-group";
  import { resolveWeatherKindKeys, weatherAreaIdentity } from "../lib/weather-expanded-kinds";
  import { pageIdentity, sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import { tornadoPageAreaEntries, tornadoPageResetKey } from "../lib/standby-cards";
  import RestoredChip from "./RestoredChip.svelte";
  import UpdatedStamp from "./UpdatedStamp.svelte";

  let { alerts, tornado = null, pageCoordinator: suppliedPageCoordinator, rotationMember = false, pageScheduling = false, partitionProbe, tornadoPartitionProbe, pagePlacement = "side", measurementRange, measurementPageFooter = false, measurementTornadoRange, tornadoPageIndex, tornadoPageCount, tornadoPending = false, tornadoAggregatePending = false, tornadoAggregateProbe = false, tornadoInfeasible = null, forceTornadoPagingContract = false }: {
    alerts: DisplayWeatherAlertV1[];
    tornado?: Extract<ActiveStandbyCardV1, { kind: "tornado" }> | null;
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    /** U3 shelf-backed actual page composition probe. */
    partitionProbe?: PartitionProbe;
    /** The rider is independently partitioned but measured in the same shell. */
    tornadoPartitionProbe?: (tornadoRange: PageRange, weatherRange: PageRange) => number | null;
    pagePlacement?: "side" | "center";
    /** A single shelf probe renders exactly this candidate range. */
    measurementRange?: PageRange;
    /** This is a non-scheduled ordinary-variant shelf, not a live card. */
    measurementPageFooter?: boolean;
    /** A forced rider probe renders only this tornado-area range. */
    measurementTornadoRange?: PageRange;
    /** The published tornado pager coordinates; shelves may provide these directly. */
    tornadoPageIndex?: number;
    tornadoPageCount?: number;
    /** A provisional rider range is still readable, but not yet registered. */
    tornadoPending?: boolean;
    /** The aggregate fallback is on the shelf but its fit result is not confirmed. */
    tornadoAggregatePending?: boolean;
    /** Forced shelf form for the aggregate fallback before its fit is known. */
    tornadoAggregateProbe?: boolean;
    /** The rider-side result of the aggregate then clip infeasible defence. */
    tornadoInfeasible?: "aggregate" | "clip" | null;
    /** Live scheduling can be pending before a range is confirmed. */
    forceTornadoPagingContract?: boolean;
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
    range, entries: pageCandidates.slice(range.start, range.end), tails: range.tails,
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
  const tornadoDiagnostics = $derived(pageCoordinator.cardDiagnostics("tornado"));
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

  const tornadoAreas = $derived(tornado?.data.areas ?? []);
  let previousTornadoSighted = $state(false);
  let tornadoEscalationGeneration = $state(0);
  $effect(() => {
    const sighted = tornado?.data.isSighted === true;
    if (sighted && !previousTornadoSighted) tornadoEscalationGeneration += 1;
    previousTornadoSighted = sighted;
  });
  const tornadoPartition = $derived.by(() => {
    if (measurementTornadoRange != null) return { ranges: [measurementTornadoRange], pending: [], infeasible: false, probeCount: 1 };
    if (tornadoPartitionProbe != null) return sequentialPartitionRanges(
      "tornado", pagePlacement, tornadoAreas.length, 1, (_key, _placement, tornadoRange) => {
        // Weather infeasible is rendered as its complete live body. Probe the
        // same full candidate shell, not the old empty [0,0) placeholder.
        const weatherRanges = pagePartition.infeasible
          ? [{ start: 0, end: pageCandidates.length, tails: [], omittedAreaCount: 0 }]
          : weatherPages.length > 0
          ? weatherPages.map((page) => page.range)
          : [{ start: 0, end: 0, tails: [], omittedAreaCount: 0 }];
        const results = weatherRanges.map((weatherRange) => tornadoPartitionProbe(tornadoRange, weatherRange));
        return results.some((result) => result == null) ? null : Math.max(...results as number[]);
      }, () => [],
    );
    return { ranges: [{ start: 0, end: tornadoAreas.length, tails: [], omittedAreaCount: 0 }], pending: [], infeasible: false, probeCount: 0 };
  });
  const tornadoPages = $derived(tornadoPartition.ranges);
  // Publish tornado pages atomically.  A new probe generation may render a
  // provisional range, but cannot replace (or reset) the coordinator record
  // until every weather×tornado composition is confirmed.
  let confirmedTornadoPages = $state<PageRange[]>([]);
  let confirmedTornadoResetKey = $state("");
  let confirmedTornadoAreas = $state<string[]>([]);
  let confirmedTornadoEscalationGeneration = $state(0);
  $effect(() => {
    if (pagePartition.pending.length > 0 || tornadoPartition.pending.length > 0) return;
    if (tornadoPartition.infeasible && resolvedTornadoInfeasible == null) return;
    confirmedTornadoPages = tornadoPartition.infeasible
      ? [{ start: 0, end: 0, tails: [], omittedAreaCount: tornadoAreas.length }]
      : tornadoPages;
    confirmedTornadoResetKey = tornadoPageResetKey(tornadoAreas);
    confirmedTornadoAreas = [...tornadoAreas];
    confirmedTornadoEscalationGeneration = tornadoEscalationGeneration;
  });
  const tornadoAggregateMeasurement = $derived.by(() => {
    if (!tornadoPartition.infeasible || tornadoPartitionProbe == null) return null;
    const weatherRanges = pagePartition.infeasible
      ? [{ start: 0, end: pageCandidates.length, tails: [], omittedAreaCount: 0 }]
      : weatherPages.length > 0
      ? weatherPages.map((page) => page.range)
      : [{ start: 0, end: 0, tails: [], omittedAreaCount: 0 }];
    const aggregateRange = { start: 0, end: 0, tails: [], omittedAreaCount: tornadoAreas.length };
    const results = weatherRanges.map((weatherRange) => tornadoPartitionProbe(aggregateRange, weatherRange));
    return results.some((result) => result == null) ? null : Math.max(...(results as number[]));
  });
  const resolvedTornadoInfeasible = $derived(tornadoInfeasible ?? (tornadoPartition.infeasible
    ? tornadoAggregateMeasurement == null ? null : tornadoAggregateMeasurement <= 1 ? "aggregate" : "clip"
    : null));
  const resolvedTornadoAggregatePending = $derived(tornadoAggregatePending || (tornadoPartition.infeasible && tornadoAggregateMeasurement == null));
  const tornadoIdentities = $derived(confirmedTornadoPages.map((range, index) => pageIdentity(
    tornadoPageAreaEntries(confirmedTornadoAreas)[range.start] ?? { kindKey: "tornado", area: `page-${index + 1}`, occurrenceIndex: 0 },
  )));
  const tornadoLabels = $derived(confirmedTornadoPages.map((range, index) => confirmedTornadoAreas[range.start] ?? `page-${index + 1}`));
  $effect(() => {
    if (!pageScheduling || measurementRange != null || measurementTornadoRange != null) {
      if (ownsPageCoordinator) pageCoordinator.unregister("tornado");
      return;
    }
    if (tornado == null || confirmedTornadoAreas.length === 0 || confirmedTornadoPages.length === 0) return;
    pageCoordinator.register({
      key: "tornado",
      identities: tornadoIdentities,
      labels: tornadoLabels,
      rotationMember,
      appearanceHost: "weather",
      resetKey: confirmedTornadoResetKey,
      escalationGeneration: confirmedTornadoEscalationGeneration,
    });
  });
  const currentTornadoPageIndex = $derived(pageCoordinator.activeIndex("tornado"));
  // A forced shelf must never fall back to the complete rider while a probe is
  // pending.  Live wiring supplies the published range in U4; until then the
  // ordinary one-page card is the complete [0, N) range.
  const activeTornadoRange = $derived(measurementTornadoRange ?? (tornadoPending || pagePartition.pending.length > 0 || tornadoPartition.pending.length > 0 || resolvedTornadoAggregatePending
    ? { start: 0, end: Math.min(1, tornadoAreas.length), tails: [], omittedAreaCount: 0 }
    : confirmedTornadoPages[currentTornadoPageIndex] ?? confirmedTornadoPages[0] ?? { start: 0, end: tornadoAreas.length, tails: [], omittedAreaCount: 0 }));
  const visibleTornadoAreas = $derived((tornadoPending || pagePartition.pending.length > 0 || tornadoPartition.pending.length > 0 || resolvedTornadoAggregatePending ? tornadoAreas : confirmedTornadoAreas).slice(activeTornadoRange.start, activeTornadoRange.end));
  const inferredTornadoPage = $derived(activeTornadoRange.start > 0 ? 2 : 1);
  const inferredTornadoPageCount = $derived(
    activeTornadoRange.end < tornadoAreas.length ? inferredTornadoPage + 1 : inferredTornadoPage,
  );
  const resolvedTornadoPage = $derived(tornadoPageIndex ?? (measurementTornadoRange == null ? currentTornadoPageIndex + 1 : inferredTornadoPage));
  const resolvedTornadoPageCount = $derived(tornadoPageCount ?? (measurementTornadoRange == null ? confirmedTornadoPages.length : inferredTornadoPageCount));
  const showTornadoPageMarker = $derived(tornado != null && resolvedTornadoInfeasible == null && resolvedTornadoPageCount > 1);
  const tornadoPagingContract = $derived(
    tornado != null && (tornadoPending || tornadoPartition.pending.length > 0 || resolvedTornadoAggregatePending || resolvedTornadoInfeasible != null || resolvedTornadoPageCount > 1),
  );
  // The fixed shell is rider-specific. Weather's established pager remains
  // natural-height based even while it probes or repartitions; only tornado
  // paging/pending/infeasible may reserve the 44vh contract.
  const hasPagingContract = $derived(forceTornadoPagingContract || tornadoPagingContract);
  const tornadoRiderText = $derived(
    resolvedTornadoInfeasible === "aggregate" || tornadoAggregateProbe
      ? `竜巻注意情報（対象 ${tornadoAreas.length} 地域）`
      : resolvedTornadoInfeasible === "clip"
        ? `竜巻注意情報（対象 ${tornadoAreas.length} 地域…）`
        : `竜巻${tornado?.data.isSighted ? "目撃情報" : "注意情報"}（${visibleTornadoAreas.length > 0 ? visibleTornadoAreas.join("、") : "対象地域"}）`,
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
    class="weather-card" class:has-page-footer={showPageIndicator} class:has-tornado={tornado != null} class:paging-contract={hasPagingContract}
    data-card-page={pageDiagnostics.page}
    data-card-page-keys={JSON.stringify(pageDiagnostics.keys)}
    data-card-page-identities={JSON.stringify(pageDiagnostics.identities)}
    data-card-page-truncated={pageTruncated ? "true" : "false"}
    data-partition-probe-count={pagePartition.probeCount}
    data-card-page-infeasible={pagePartition.infeasible ? "true" : "false"}
    data-card-page-pending={pagePartition.pending.length > 0 ? "true" : "false"}
    data-page-probe-card={measurementRange != null || measurementTornadoRange != null ? "" : undefined}
    data-tornado-page-range={tornado == null ? undefined : `${activeTornadoRange.start}:${activeTornadoRange.end}`}
    data-tornado-page={tornado == null ? undefined : tornadoDiagnostics.page}
    data-tornado-page-pending={tornado == null ? undefined : String(tornadoPending)}
    data-tornado-page-infeasible={tornado == null ? undefined : resolvedTornadoInfeasible ?? "false"}
    data-tornado-page-fallback={tornado == null ? undefined : resolvedTornadoInfeasible ?? (resolvedTornadoAggregatePending ? "aggregate-pending" : "false")}
  >
    <div
      class="card-header"
      style="background: {headerContainerVar(topRole)}; color: {headerOnVar(topRole)}; border-bottom: var(--header-band-width) solid {headerBandVar(topRole)}"
    >{headerLabel(topRole, alerts)}<UpdatedStamp iso={latestUpdatedAt} /></div>
    {#if alerts.length > 0}<ul data-page-probe-body data-page-probe-readable>
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
    {#if tornado != null}<div class:sighted={tornado.data.isSighted} class:clip-rider={resolvedTornadoInfeasible === "clip"} class="tornado-rider" data-page-probe-readable><span data-tornado-rider-text>⚠ {#if resolvedTornadoInfeasible != null || tornadoAggregateProbe}{tornadoRiderText}{:else}竜巻{tornado.data.isSighted ? "目撃情報" : "注意情報"}（{#if visibleTornadoAreas.length > 0}{#each visibleTornadoAreas as area, index (area)}<span data-tornado-visible-area>{area}</span>{#if index < visibleTornadoAreas.length - 1}、{/if}{/each}{:else}対象地域{/if}）{/if}</span>{#if showTornadoPageMarker}<span class="tornado-page-marker" data-tornado-page-marker>対象地域 {resolvedTornadoPage}/{resolvedTornadoPageCount}</span>{/if}{#if tornado.restored}<RestoredChip />{/if}</div>{/if}
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
  /* Paging, provisional probes, and either infeasible fallback share the same
     outer shell budget.  This is intentionally a height, not a measurement
     derived from contents, so confirmation cannot make the card jump. */
  .weather-card.paging-contract {
    height: min(44vh, 280px);
  }
  .weather-card.has-page-footer {
    /* label-xs 12px at line-height:1 + 1px block padding + 1px border on each side. */
    --card-page-indicator-block-size: calc(var(--type-label-xs-size) + 4px);
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
  .tornado-rider.clip-rider [data-tornado-rider-text] { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tornado-page-marker { display: inline; margin-inline-start: 0.5em; white-space: nowrap; font-size: var(--type-label-xs-size); font-weight: var(--type-body-weight-regular); color: var(--role-muted); }
  /* The zero-height footer paints downward into a real gap immediately above
     the rider. Fund that gap from existing fixed vertical whitespace so the
     weather card's measured height stays identical: ul -10px + rider -6px +
     margin +16px = 0px. The arithmetic is resolution-independent even when
     standby swaps --space-* tokens at compressed ladder stages. */
  .weather-card.has-page-footer ul {
    padding-top: calc(var(--space-2) - 4px);
    padding-bottom: calc(var(--space-3) - 6px);
  }
  .weather-card.has-page-footer.has-tornado .tornado-rider {
    margin-top: var(--card-page-indicator-block-size);
    padding-top: calc(var(--space-2) - 3px);
    padding-bottom: calc(var(--space-2) - 3px);
  }
  /* A paged card without a tornado rider still needs the same post-body paint
     gap. Reclaim the remaining 6px from the header, then expose all 16px as
     card bottom padding; total measured height again stays unchanged. */
  .weather-card.has-page-footer:not(.has-tornado) {
    padding-bottom: var(--card-page-indicator-block-size);
  }
  .weather-card.has-page-footer:not(.has-tornado) .card-header {
    padding-top: calc(var(--space-2) - 3px);
    padding-bottom: calc(var(--space-2) - 3px);
  }
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
       its zero-height boundary starts the compensated pre-rider gap, so the
       badge paints downward without adding its own measured row. */
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
  }
  .card-page-indicator {
    box-sizing: border-box;
    block-size: var(--card-page-indicator-block-size);
    padding: 1px var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    background: color-mix(in srgb, var(--surface-standby) 92%, transparent);
    color: var(--role-muted);
    font-size: var(--type-label-xs-size);
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
</style>
