<script lang="ts">
  import type { DisplayIntensityGroupV1, DisplayLatestQuakeStateV1 } from "../lib/protocol";
  import { formatMdHm, formatIntShort, splitNumberUnit } from "../lib/format";
  import { depthVisual, magnitudeVisual } from "../lib/magnitude";
  import { groupByPrefecture } from "../lib/prefecture-group";
  import {
    DETAIL_SECTION_HEADER_WEIGHT,
    PAGE_CITY_BUDGET,
    cityBudgetFromArea,
    mergeDetailPageSections,
    paginateAreas,
    type DetailPage,
  } from "../lib/instrument-layout";
  import { pageIdentity, sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { createCardPageCoordinator, type CardPageCoordinator } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import { measureHeight } from "../lib/measure-height";
  import { onDestroy, untrack } from "svelte";
  import PageDots from "./PageDots.svelte";
  import RestoredChip from "./RestoredChip.svelte";
  import NumberUnit from "./NumberUnit.svelte";
  import { intensityVisual } from "../lib/quake-map-colors";
  import NumericSemanticLegend from "./NumericSemanticLegend.svelte";

  let { quake, longPeriod = null, pageCoordinator: suppliedPageCoordinator, rotationMember = false, pageScheduling = true, partitionProbe, pagePlacement = "side", measurementRange }: {
    quake: DisplayLatestQuakeStateV1;
    longPeriod?: { maxLgInt: string; restored: boolean } | null;
    /** StandbyScreen supplies the shared coordinator; isolated card renders own one. */
    pageCoordinator?: CardPageCoordinator;
    rotationMember?: boolean;
    pageScheduling?: boolean;
    /** U3 shelf-backed actual composition probe. Isolated card tests use the fallback only. */
    partitionProbe?: PartitionProbe;
    pagePlacement?: "side" | "center";
    /** A single shelf probe renders exactly this candidate range. */
    measurementRange?: PageRange;
  } = $props();
  const initialPageCoordinator = untrack(() => suppliedPageCoordinator);
  const pageCoordinator = initialPageCoordinator ?? createCardPageCoordinator();
  const ownsPageCoordinator = initialPageCoordinator == null;

  // 数値深さは「20km」の数値大・単位小で見せる。「ごく浅い」は数値ではないため通常テキスト。
  const magnitude = $derived(magnitudeVisual(quake.magnitudeSemantic, quake.magnitude));
  const depth = $derived(depthVisual(quake.depthSemantic, quake.depth));
  const depthParts = $derived(splitNumberUnit(depth.label));

  // 表示対象の震度グループ。複数ページになるかは固定件数閾値ではなく、下の partition 結果で決める。
  const displayGroups = $derived(quake.intensityGroups.filter((group) =>
    intensityVisual(group.intensitySemantic, group.intensity, group.rank).render
  ));
  const maxVisual = $derived(intensityVisual(quake.maxIntSemantic, formatIntShort(quake.maxInt), quake.maxIntRank));
  const maxSeverityRank = $derived(quake.maxIntSemantic == null ? quake.maxIntRank : quake.maxIntSemantic.safetyRank);

  function groupVisual(intensity: string, rank: number) {
    const group = displayGroups.find((item) => item.intensity === intensity && item.rank === rank);
    return intensityVisual(group?.intensitySemantic, intensity, rank);
  }

  // ページ本文領域の実測高さ・行高から市町村数バジェットを導出する (T5c、spec §2-c 「LatestQuakeCard
  // は content 駆動なので先にカードへ高さ予算を与える」)。カードは height:100% の grid セルに
  // 属さない (待機画面上を流れる content-driven カード) ため、他パネルのように flex:1 で
  // 「残り画面高さ」を自然に受け取れない。旧 `min-height: calc(6 * 1.6em)` (6行ぶんの見積もり)
  // を「予算」として固定 height に格上げし、そこから実測 → rowCapacity → cityBudgetFromArea の
  // パイプラインに通す (先に予算を与えてから実測、スコープ §2-c 確定文言のとおり)。予算そのものは
  // 画面高さ非依存の固定値だが、font-size (--type-label-s-fluid) は fluid token で viewport 幅に
  // 応じて変わるため、行高実測 → バジェット換算の部分は viewport 変化に追従する
  let pageBodyAreaHeight = $state(0);
  let pageBodyLineHeight = $state(0);
  const cityBudget = $derived(cityBudgetFromArea(pageBodyAreaHeight, pageBodyLineHeight, PAGE_CITY_BUDGET));

  // 県を分断しない最小 fragment を作り、U2 の逐次 greedy partition で固定予算へ詰める。
  // expandedAreas がある実カードでは compact の恒久省略をやめ、供給候補全体を対象にする。
  const pageSourceGroups = $derived(displayGroups.map((group) => {
    if (!pageScheduling || group.expandedAreas == null) return group;
    const total = Math.max(group.areas.length + group.omittedAreaCount, group.expandedAreas.length);
    return { ...group, areas: group.expandedAreas, omittedAreaCount: Math.max(0, total - group.expandedAreas.length) };
  }));
  // Make the candidate unit one region. The real StandbyScreen path supplies a
  // U3 epoch probe that measures this exact range in the shelf; no item-count
  // weight decides a production page boundary.
  function fragmentsInCanonicalGroupOrder(budget: number): DetailPage[] {
    return pageSourceGroups.flatMap((group): DetailPage[] => {
      if (group.areas.length === 0 && group.omittedAreaCount > 0) return [{
        intensity: group.intensity,
        rank: group.rank,
        prefGroups: [],
        sections: [{ intensity: group.intensity, rank: group.rank, prefGroups: [] }],
      }];
      // paginate one source group at a time so a tail-only group remains at
      // its canonical group boundary instead of being appended after all data.
      return paginateAreas([group], budget);
    });
  }
  const measuredPageFragments = $derived(fragmentsInCanonicalGroupOrder(DETAIL_SECTION_HEADER_WEIGHT + 1));
  // Isolated cards have no U3 shelf. Preserve their historical deterministic
  // fallback; all StandbyScreen production and shelf paths use one-region
  // candidates measured through partitionProbe.
  const pageFragments = $derived(partitionProbe != null || measurementRange != null
    ? measuredPageFragments
    : fragmentsInCanonicalGroupOrder(cityBudget));
  const fragmentTails = $derived.by(() => {
    const lastIndexByKind = new Map<string, number>();
    for (const [index, page] of pageFragments.entries()) {
      for (const section of page.sections) lastIndexByKind.set(`${section.rank}:${section.intensity}`, index);
    }
    return [...lastIndexByKind].flatMap(([kindKey, lastIndex]) => {
      const source = pageSourceGroups.find((group) => `${group.rank}:${group.intensity}` === kindKey);
      return (source?.omittedAreaCount ?? 0) > 0 ? [{ kindKey, lastIndex, omittedAreaCount: source!.omittedAreaCount }] : [];
    });
  });
  function tailsForRange(range: PageRange) {
    return fragmentTails
      .filter((tail) => tail.lastIndex >= range.start && tail.lastIndex < range.end)
      .map(({ kindKey, omittedAreaCount }) => ({ kindKey, omittedAreaCount }));
  }
  function standaloneFallbackHeight(range: PageRange): number {
    return pageFragments.slice(range.start, range.end).reduce((total, page) => total + page.sections.reduce(
      (sectionTotal, section) => sectionTotal + DETAIL_SECTION_HEADER_WEIGHT
        + section.prefGroups.reduce((prefTotal, group) => prefTotal + Math.max(1, group.cities.length), 0),
      0,
    ), 0);
  }
  const pagePartition = $derived.by(() => {
    if (measurementRange != null) return {
      ranges: [measurementRange], pending: [], infeasible: false, probeCount: 1,
    };
    if (partitionProbe != null) return sequentialPartitionRanges(
      "quake", pagePlacement, pageFragments.length, 1,
      partitionProbe,
      tailsForRange,
    );
    // Standalone card usage has no U3 shelf. Keep its deterministic fallback
    // for component tests; StandbyScreen never takes this branch.
    return sequentialPartitionRanges(
      "quake", pagePlacement, pageFragments.length, cityBudget,
      (_key, _placement, range) => standaloneFallbackHeight(range),
      tailsForRange,
    );
  });
  const pages = $derived(pagePartition.ranges.map((range): DetailPage => {
    const sections = pageFragments.slice(range.start, range.end).flatMap((page) => page.sections);
    const first = sections[0]!;
    return { sections, ...first };
  }));
  // A shelf probe must render the same fixed page body even though its local
  // partition contains exactly one forced range. Otherwise it would fall back
  // to the static all-candidates list and report a false fit.
  const paging = $derived(measurementRange != null || pages.length > 1);
  // Identity occurrence is canonical across every fragment, not re-counted at
  // each partition boundary. Repartitioning therefore cannot merge two equal
  // region names into one coordinator identity.
  const fragmentEntries = $derived.by(() => {
    const occurrences = new Map<string, number>();
    return pageFragments.map((fragment, index) => {
      let first: { kindKey: string; area: string; occurrenceIndex: number } | null = null;
      for (const section of fragment.sections) {
        const kindKey = `${section.rank}:${section.intensity}`;
        for (const prefGroup of section.prefGroups) {
          const areas = prefGroup.cities.length > 0 ? prefGroup.cities : [prefGroup.pref ?? "その他"];
          for (const area of areas) {
            const occurrenceKey = `${kindKey}\u0000${area}`;
            const occurrenceIndex = occurrences.get(occurrenceKey) ?? 0;
            occurrences.set(occurrenceKey, occurrenceIndex + 1);
            first ??= { kindKey, area, occurrenceIndex };
          }
        }
      }
      return first ?? {
        kindKey: `${fragment.rank}:${fragment.intensity}`,
        // Tail-only pages have no geographic first entry. Use the stable
        // kind-local sentinel rather than their mutable fragment position.
        area: "<tail>",
        occurrenceIndex: 0,
      };
    });
  });
  const pageEntries = $derived(pagePartition.ranges.map((range, index) =>
    fragmentEntries[range.start] ?? { kindKey: "quake", area: `page-${index + 1}`, occurrenceIndex: 0 },
  ));
  const pageIdentities = $derived(pageEntries.map(pageIdentity));
  const pageLabels = $derived(pageEntries.map((entry) => entry.area));

  // 別イベント (eventId 変化) か、同一イベントの続報で severityTier (地震は最大震度 rank) が
  // 「上昇」したときにページを先頭に戻す。下降・同値ではリセットしない (spec §3、Codex R
  // レビュー M2)
  const identityKey = $derived(quake.eventId ?? `${quake.hypocenterName ?? ""}:${quake.originTime ?? ""}`);
  let resetSeq = $state(0);
  let prevIdentityKey: string | null = null;
  let prevMaxIntRank = -1;
  $effect(() => {
    const key = identityKey;
    const rank = maxSeverityRank ?? -1;
    if (prevIdentityKey != null && (key !== prevIdentityKey || rank > prevMaxIntRank)) {
      resetSeq += 1;
    }
    prevIdentityKey = key;
    prevMaxIntRank = rank;
  });

  $effect(() => {
    pageCoordinator.register({
      key: "quake",
      identities: pageScheduling ? pageIdentities : [],
      labels: pageScheduling ? pageLabels : [],
      rotationMember,
      resetKey: resetSeq,
    });
  });
  onDestroy(() => {
    // A shared coordinator owns the substate across placement/stage remounts.
    // StandbyScreen performs the actual card-disappearance exit.
    if (ownsPageCoordinator) pageCoordinator.dispose();
  });

  // 範囲外 fallback は pages[0] へ置き、交代時に null の空フレームを経由させない。
  const currentPageIndex = $derived(pageCoordinator.activeIndex("quake"));
  const currentPage = $derived(pages[currentPageIndex] ?? pages[0] ?? null);
  // ページ分割結果は計測・ページIDの基準として不変に保ち、描画直前だけ同一ページ内の
  // 同震度断片を結合する。これで本来のページ境界をまたぐ continuation は維持される。
  const currentPageSections = $derived(mergeDetailPageSections(currentPage?.sections ?? []));
  const currentPageTails = $derived.by(() => {
    const tails = new Map<string, number>();
    for (const section of currentPage?.sections ?? []) {
      const kindKey = `${section.rank}:${section.intensity}`;
      const occursLater = pages.slice(currentPageIndex + 1).some((page) => page.sections
        .some((candidate) => `${candidate.rank}:${candidate.intensity}` === kindKey));
      if (occursLater) continue;
      const source = pageSourceGroups.find((group) => `${group.rank}:${group.intensity}` === kindKey);
      if ((source?.omittedAreaCount ?? 0) > 0) tails.set(kindKey, source!.omittedAreaCount);
    }
    return tails;
  });
  const pageDiagnostics = $derived(pageCoordinator.cardDiagnostics("quake"));
</script>

{#snippet groupItem(g: DisplayIntensityGroupV1)}
  {@const visual = intensityVisual(g.intensitySemantic, g.intensity, g.rank)}
  <li>
    <span class="g-int int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>震度{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
    <div class="g-pref-groups">
      <!-- T7 回帰修正: 静的リストは spec §2-b の例 (「震度6強 宮崎市 日南市」) どおり
           県プレフィックス無しの area (pref:null) はラベル無しで市名だけ出す。
           ページング側 (currentPage.prefGroups、下の分岐) は「その他」ラベルを維持する
           (原則3のラベル明示はページ側にだけ意味がある、レビュー指示) -->
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
      {#if g.omittedAreaCount > 0}<span class="g-omitted">ほか{g.omittedAreaCount}地域</span>{/if}
    </div>
  </li>
{/snippet}

<div
  class="quake-card"
  data-card-page={pageDiagnostics.page}
  data-card-page-keys={JSON.stringify(pageDiagnostics.keys)}
  data-card-page-identities={JSON.stringify(pageDiagnostics.identities)}
  data-partition-probe-count={pagePartition.probeCount}
  data-card-page-infeasible={pagePartition.infeasible ? "true" : "false"}
>
  <header class="standby-card-header" style="--standby-header-container: {(maxSeverityRank ?? 0) >= 7 ? 'var(--header-quakeCritical-container)' : 'var(--header-quakeWarning-container)'}; --standby-header-on: {(maxSeverityRank ?? 0) >= 7 ? 'var(--header-quakeCritical-on)' : 'var(--header-quakeWarning-on)'}; --standby-header-band: {(maxSeverityRank ?? 0) >= 7 ? 'var(--header-band-quakeCritical)' : 'var(--header-band-quakeWarning)'}"><span class="standby-card-header__title">地震情報</span></header>
  <div class="card-body">
    <div class="summary-row">
      {#if maxVisual.render}<span class="int-chip int-r{maxVisual.colorRank ?? 0}" class:special-unknown={maxVisual.colorClass === "quake-map-unknown"} class:special-empty={maxVisual.colorClass === "quake-map-neutral"} title={maxVisual.tooltip ?? undefined} aria-label={maxVisual.ariaLabel ?? undefined}>{maxVisual.label ?? ""}{#if maxVisual.badge != null}<b class="semantic-badge">{maxVisual.badge}</b>{/if}</span>{/if}
      <span class="hypocenter">{quake.hypocenterName ?? "不明"}</span>
      {#if quake.tsunamiWarning}<span class="tsunami-mark">津波</span>{/if}
    </div>
    <div class="meta">
      <div class="stat">
        <span class="stat-label">規模</span>
        <span class="magnitude stat-value" title={magnitude.tooltip ?? undefined} aria-label={quake.magnitudeSemantic == null && quake.magnitude == null ? "マグニチュード: 空欄" : magnitude.ariaLabel}>{#if quake.magnitudeSemantic == null && quake.magnitude == null}{:else if magnitude.numericValue != null}<NumberUnit prefix="M" value={magnitude.numericValue.toFixed(1)} />{:else}{magnitude.label}{/if}{#if magnitude.badge != null}<b class="semantic-badge">{magnitude.badge}</b>{/if}</span>
      </div>
      <div class="stat">
        <span class="stat-label">深さ</span>
        <span class="depth stat-value" title={depth.tooltip ?? undefined} aria-label={depth.ariaLabel}>{#if depth.numericValue != null}<NumberUnit value={depthParts.value} unit={depthParts.unit} />{:else}{depth.label}{/if}{#if depth.badge != null}<b class="semantic-badge">{depth.badge}</b>{/if}</span>
      </div>
      <div class="stat">
        <span class="stat-label">発生</span>
        <span class="time stat-value">{formatMdHm(quake.originTime ?? quake.reportDateTime)}</span>
      </div>
    </div>
    <NumericSemanticLegend semantics={[quake.magnitudeSemantic, quake.depthSemantic]} />
    {#if longPeriod != null}<div class="long-period-rider">長周期地震動階級 {longPeriod.maxLgInt}{#if longPeriod.restored}<RestoredChip />{/if}</div>{/if}
    {#if displayGroups.length > 0}
      {#if paging}
        {#if currentPage != null}
          <div class="page-detail">
            {#key currentPageIndex}
              <div class="page-fade">
                <div class="page-header">
                  <span class="page-title">観測震度 詳細</span>
                  <PageDots total={pages.length} current={currentPageIndex} onJump={(i) => pageCoordinator.jumpTo("quake", i)} />
                </div>
                <ul class="page-body" data-page-probe-body use:measureHeight={(h) => (pageBodyAreaHeight = h)}>
                  <li class="line-ruler" aria-hidden="true" use:measureHeight={(h) => (pageBodyLineHeight = h)}
                    >測</li
                  >
                  {#each currentPageSections as section, sectionIndex (`${section.rank}:${section.intensity}:${section.prefGroups[0]?.pref ?? ""}:${sectionIndex}`)}
                    {@const visual = groupVisual(section.intensity, section.rank)}
                    <li class="page-section">
                      <span class="g-int int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>震度{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
                      {#each section.prefGroups as pg (pg.pref ?? "その他")}
                        <div class="pref-group">
                          <span class="pref-name">{pg.pref ?? "その他"}{pg.continuation ? "（続き）" : ""}</span>
                          {#if pg.cities.length > 0}<span class="cities">{#each pg.cities as city (city)}<span class="city-name">{city}</span>{/each}</span>{/if}
                        </div>
                      {/each}
                      {#if (currentPageTails.get(`${section.rank}:${section.intensity}`) ?? 0) > 0}
                        <span class="g-omitted">ほか{currentPageTails.get(`${section.rank}:${section.intensity}`)}地域</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/key}
          </div>
        {/if}
      {:else}
        <ul class="groups">
          {#each pageSourceGroups as g (g.intensity)}
            {@render groupItem(g)}
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</div>

<style>
  .quake-card {
    background: var(--surface-standby);
    border-radius: var(--radius-standby);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-2);
    overflow: hidden;
    width: min(360px, 28vw);
    color: var(--fg);
  }
  /* 看板ヘッダをカード端まで届かせるため、全周 padding はヘッダ配下の本文側に移した
     (津波/気象カードと同じ構造。旧 .quake-card 直付け padding だとヘッダが内側に浮いてしまう) */
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
    font-variant-numeric: tabular-nums;
    background: var(--surface-panel-raised);
    overflow-wrap: anywhere;
  }
  .semantic-badge {
    margin-left: 0.25em;
    font-weight: var(--type-label-weight-emphasized);
  }
  .int-r0 {
    color: var(--role-muted);
  }
  .int-r1 {
    color: var(--int-1);
  }
  .int-r2 {
    color: var(--int-2);
  }
  .int-r3 {
    color: var(--int-3);
  }
  .int-r4 {
    color: var(--int-4);
  }
  .int-r5 {
    color: var(--int-5);
  }
  .int-r6 {
    color: var(--int-6);
  }
  .int-r7 {
    color: var(--int-7);
  }
  .int-r8 {
    background: var(--int-8-bg);
    color: #000;
  }
  .int-r9 {
    background: var(--int-9-bg);
    color: #fff;
  }
  .int-chip.special-unknown,
  .g-int.special-unknown { color: var(--role-cancel); border-color: currentColor; }
  .int-chip.special-empty,
  .g-int.special-empty { color: var(--role-muted); border-color: currentColor; }
  .hypocenter {
    font-weight: var(--type-title-weight-emphasized);
    font-size: var(--type-title-s-fluid);
  }
  .tsunami-mark {
    color: var(--role-tsunamiWarning);
    font-weight: var(--type-body-weight-emphasized);
  }
  .meta {
    display: flex;
    gap: var(--space-3);
    margin: var(--space-2) 0 6px;
  }
  .long-period-rider { margin: 0 0 var(--space-2); padding: var(--space-1) var(--space-2); border-left: 3px solid var(--role-weatherWarning); color: var(--role-weatherWarning); font-size: max(14px, var(--type-label-l-fluid)); font-weight: var(--type-body-weight-emphasized); }
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
    font-size: max(14px, var(--type-body-l-fluid));
    font-weight: var(--num-weight);
    font-variant-numeric: tabular-nums;
  }
  /* partition が1ページなら自走させず、従来の静的リストで全グループを並べる。 */
  .groups {
    margin: 4px 0 0;
    font-size: var(--type-label-s-fluid);
    list-style: none;
    padding: 0;
  }
  .groups li {
    display: flex;
    gap: 10px;
    padding: 3px 0;
    /* 複数県にまたがり複数行になっても震度チップが縦に伸びないよう行頭固定 (第3波 Fix6) */
    align-items: flex-start;
  }
  .g-int {
    flex-shrink: 0;
    font-weight: var(--type-body-weight-emphasized);
    white-space: normal;
    overflow-wrap: anywhere;
  }
  /* 都道府県 → 市区町村の階層。WeatherAlertCard の pref-group 文法と揃える (第3波 Fix7) */
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
  /* 市区町村名は個別 span (white-space:nowrap) にし、折返しは名前と名前の間だけで発生させる。
     区切りは文字 (旧「・」) ではなく gap で表現する (第3波 Fix14)。.cities 自体は display:contents
     で flex アイテムから外し、city-name span を .pref-group の直接の子として扱わせる。
     inline-flex のままだと "ブロック単位で次行へ wrap" してしまい、市町村が多い県だけ県名直後で
     改行される不統一が起きていた (review-T5a-2 FIX-B)。常にインラインで自然折返しさせる */
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
  /* 詳細ページング (spec §3): 各ページに見出し・件数・ページ番号を固定枠で常時表示する
     (原則3「任意の瞬間が単独で読める」)。Unit 4 では共有 coordinator が選んだページを
     keyed block で原子的に差し替える。旧ページを残さないため二重ページャや空白フレームを作らない。 */
  .page-detail {
    position: relative;
    margin: 4px 0 0;
    /* T5c: LatestQuakeCard は height:100% の grid セルに属さない content-driven カードのため、
       他パネルのように flex:1 で「残り画面高さ」を自然に受け取れない。ヘッダ1行 (概算) + gap +
       page-body の高さ予算 (6行分、review-T5a-2 FIX-1 由来) を合算した固定 height を与える。
       内部の page-body は flex:1 でヘッダの実高さを引いた残りを受け取る
       (ヘッダ実測ぶんを自動で吸収する) */
    height: calc(7 * 1.6em + 4px);
  }
  .page-fade {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .page-header {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.5em;
    font-size: var(--type-label-s-fluid);
  }
  .page-title {
    font-weight: var(--type-body-weight-emphasized);
    color: var(--role-muted);
  }
  .page-body {
    position: relative;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--type-label-s-fluid);
    overflow: hidden;
    /* .page-detail の height 予算から page-header の実高さを引いた残りを flex:1 で受け取る
       (T5c)。そこから measureHeight で実測 → rowCapacity → cityBudgetFromArea
       (lib/instrument-layout.ts) のパイプラインに通す (spec §2-c「先にカードへ高さ予算を
       与えてから実測」)。font-size が fluid token (--type-label-s-fluid) のため、行高実測の
       結果は viewport 幅に追従する */
    flex: 1;
    min-height: 0;
  }
  .line-ruler {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
  }
</style>
