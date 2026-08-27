<script lang="ts">
  import type { DisplayLargeQuakeInputV1, DisplayQuakeMapEventV1 } from "../lib/protocol";
  import { formatHm, formatMdHm, formatIntShort } from "../lib/format";
  import { depthVisual, magnitudeVisual } from "../lib/magnitude";
  import {
    PAGE_CITY_BUDGET,
    paginateAreas,
    type DetailPage,
    type DetailPageSection,
  } from "../lib/instrument-layout";
  import { groupByPrefecture } from "../lib/prefecture-group";
  import {
    sequentialPartitionRanges,
    type PartitionProbe,
  } from "../lib/legacy-standby/page-partition";
  import type { PageRange } from "../lib/legacy-standby/types";
  import { createPageCycler } from "../lib/page-cycler.svelte";
  import { SPRING_EFFECTS_DEFAULT_MS, SPRING_SPATIAL_DEFAULT_MS, springEffectsOut } from "../lib/motion";
  import { revealScaleIn, heightReveal } from "../lib/transitions";
  import { fade } from "svelte/transition";
  import { onDestroy } from "svelte";
  import { untrack } from "svelte";
  import PageDots from "./PageDots.svelte";
  import QuakeMap from "./QuakeMap.svelte";
  import { intensityVisual } from "../lib/quake-map-colors";
  import NumericSemanticLegend from "./NumericSemanticLegend.svelte";
  import {
    PageAttentionState,
    itemContentFingerprint,
    pageContentFingerprint,
  } from "../lib/page-attention";

  // compact: main-stack の非 main スロット (EewPanel と同じ縮小パターンを適用し、
  // emergency-3 等で tile-main + tile-stats + 震度別グループが縦に収まりきらず
  // 見切れる問題を解消する)
  // layoutSettling: 緊急画面のレイアウト遷移中 (グリッド track 補間中) は EmergencyScreen から
  // true が渡る。遷移中は本文領域の実測が過渡値になり再ページングが暴れるため、測定反映を保留する (spec §4)。
  let {
    input,
    mapEvent = null,
    compact = false,
    layoutSettling = false,
    reducedMotion = false,
  }: {
    input: DisplayLargeQuakeInputV1;
    mapEvent?: DisplayQuakeMapEventV1 | null;
    compact?: boolean;
    layoutSettling?: boolean;
    reducedMotion?: boolean;
  } = $props();

  const magnitude = $derived(magnitudeVisual(input.magnitudeSemantic, input.magnitude));
  const depth = $derived(depthVisual(input.depthSemantic, input.depth));

  const hasChips = $derived(input.tsunamiWarning || input.originTime != null);
  const originTimeLabel = $derived(input.originTime == null ? "-" : compact ? formatHm(input.originTime) : formatMdHm(input.originTime));

  // 生成時キー snapshot (spec §0-d / §2-c 最終改稿 1): 初期に存在する個別要素を素の const で
  // 捕まえる。行全体の bool ではなく要素ごとのキーで持つ (初期に origin チップだけ在り後から
  // tsunami チップが増えるケースを識別するため)。初期から在る要素は revealScaleIn の reveal=false
  // で演出なし・frame-1 可視、初期 snapshot に無い後発要素だけ reveal=true にする。
  // svelte-ignore state_referenced_locally -- 意図的に生成時の値を捕まえる非リアクティブ snapshot (spec §0-d)
  const initialHasLgInt = input.maxLgInt != null;
  // svelte-ignore state_referenced_locally -- 同上 (個別チップキーの生成時 snapshot、最終改稿 1)
  const initialElementKeys = new Set<string>([
    ...(input.tsunamiWarning ? ["chip:tsunami"] : []),
    ...(input.originTime != null ? ["chip:origin"] : []),
  ]);
  // chip-row の heightReveal は「初期に行が無く、最初のチップが後発した場合」だけ (行が既にあって
  // 2 つ目のチップが増えるケースは行の高さが変わらないので個別チップの scale のみ、spec §2-c)
  const chipRowInitiallyAbsent =
    !initialElementKeys.has("chip:tsunami") && !initialElementKeys.has("chip:origin");

  // 全グループ合計の実効件数。静的リスト ⇔ 詳細ページングの切替判定に使う (spec §4 決定表)
  const displayGroups = $derived(input.intensityGroups.filter((group) =>
    intensityVisual(group.intensitySemantic, formatIntShort(group.intensity), group.rank).render
  ));
  // D1-A: 件数閾値ではなく、実測本文高から得た partition だけを表示単位にする。
  // 1 枚なら位置表示を省略し、複数枚なら同じ pager で全地域へ到達させる。

  interface QuakeAreaEntry {
    groupIndex: number;
    areaIndex: number;
    area: string;
    omittedOnly: boolean;
    identity: string;
    fingerprint: string;
  }
  interface ProbeMeasurement {
    contentHeight: number;
    availableHeight: number;
  }

  const quakeAreaEntries = $derived.by((): QuakeAreaEntry[] => displayGroups.flatMap((group, groupIndex) => {
    const areas = group.areas.map((area, areaIndex) => ({
      groupIndex,
      areaIndex,
      area,
      omittedOnly: false,
      identity: `${group.intensity}|${group.rank}|${area}|${areaIndex}`,
      fingerprint: itemContentFingerprint({
        intensity: group.intensity,
        rank: group.rank,
        intensitySemantic: intensityFingerprint(group.intensitySemantic),
        area,
      }),
    }));
    // 表示対象が「ほか N 地域」だけになった group も、本文/attention の 1 entry として残す。
    // 空配列のままでは partition が空になり、縮退情報そのものが消えてしまう。
    if (areas.length > 0 || group.omittedAreaCount <= 0) return areas;
    return [{
      groupIndex,
      areaIndex: 0,
      area: "",
      omittedOnly: true,
      identity: `${group.intensity}|${group.rank}|omitted`,
      fingerprint: itemContentFingerprint({
        intensity: group.intensity,
        rank: group.rank,
        intensitySemantic: intensityFingerprint(group.intensitySemantic),
        omittedAreaCount: group.omittedAreaCount,
      }),
    }];
  }));

  function detailPageForRange(range: PageRange): DetailPage | null {
    const selected = quakeAreaEntries.slice(range.start, range.end);
    if (selected.length === 0) return null;
    const sections: DetailPageSection[] = [];
    for (let cursor = 0; cursor < selected.length;) {
      const groupIndex = selected[cursor]!.groupIndex;
      const group = displayGroups[groupIndex]!;
      let end = cursor + 1;
      while (end < selected.length && selected[end]!.groupIndex === groupIndex) end += 1;
      const entries = selected.slice(cursor, end);
      if (entries[0]!.omittedOnly) {
        sections.push({ intensity: group.intensity, rank: group.rank, prefGroups: [] });
        cursor = end;
        continue;
      }
      const priorPrefectures = new Set(
        groupByPrefecture(group.areas.slice(0, entries[0]!.areaIndex)).map((pref) => pref.pref),
      );
      sections.push({
        intensity: group.intensity,
        rank: group.rank,
        prefGroups: groupByPrefecture(entries.map((entry) => entry.area)).map((pref) => ({
          ...pref,
          continuation: priorPrefectures.has(pref.pref),
        })),
      });
      cursor = end;
    }
    const first = sections[0]!;
    return { sections, ...first };
  }

  const omittedOnlyPages = $derived.by((): DetailPage[] => displayGroups.flatMap((group) => {
    if (group.areas.length > 0 || group.omittedAreaCount <= 0) return [];
    const section = { intensity: group.intensity, rank: group.rank, prefGroups: [] };
    return [{ sections: [section], ...section }];
  }));

  // 実ブラウザでは候補 range を隠し棚へ同じ幅・同じ固定本文高で強制描画し、自然高と
  // 利用可能高を比較する。jsdom には layout engine が無いため、そこだけは従来の純関数を
  // fallback として残す（本番 partition では使われない）。
  let probeWidth = $state(0);
  let probeHeight = $state(0);
  let probeMeasurements = $state<Record<string, ProbeMeasurement>>({});
  let pendingProbeBox: { width: number; height: number } | null = null;
  const pendingProbeMeasurements = new Map<string, ProbeMeasurement>();
  // spec §4 の再測定契機 document.fonts.ready を probe cache にも伝える。fallback
  // フォントで測った partition は本フォント適用後に数 px 太り、コンテナ寸法が
  // 変わらないため世代を混ぜないと再測定されない（macOS gate 実測 268 vs 264）
  let fontsGeneration = $state(0);
  void (typeof document === "undefined" ? null : document.fonts?.ready?.then(() => { fontsGeneration = 1; }));
  const quakeProbeFingerprint = $derived(pageContentFingerprint(
    { compact },
    quakeAreaEntries.map(({ identity, fingerprint }) => ({ identity, fingerprint })),
  ));
  const quakeProbeGeneration = $derived(`${quakeProbeFingerprint}:f${fontsGeneration}:w${Math.round(probeWidth * 100) / 100}:h${Math.round(probeHeight * 100) / 100}`);
  function quakeProbeId(range: Pick<PageRange, "start" | "end">): string {
    return `${quakeProbeGeneration}:${range.start}:${range.end}`;
  }
  const quakePartitionProbe: PartitionProbe = (_key, _placement, range) => {
    const measured = probeMeasurements[quakeProbeId(range)];
    if (measured == null) return null;
    return measured.contentHeight <= measured.availableHeight + 1 ? 0 : 2;
  };
  const quakePartition = $derived(sequentialPartitionRanges(
    "quake",
    compact ? "side" : "center",
    quakeAreaEntries.length,
    1,
    quakePartitionProbe,
    () => [],
  ));
  const pages = $derived.by(() => {
    if (typeof ResizeObserver === "undefined") {
      return [
        ...paginateAreas(displayGroups, PAGE_CITY_BUDGET, { allowCrossIntensity: true }),
        ...omittedOnlyPages,
      ];
    }
    return quakePartition.ranges.flatMap((range) => {
      const page = detailPageForRange(range);
      return page == null ? [] : [page];
    });
  });
  const pageRanges = $derived(typeof ResizeObserver === "undefined" ? [] : quakePartition.ranges);
  const quakePartitionPending = $derived(quakePartition.pending.length > 0);
  const quakeProbePages = $derived((typeof ResizeObserver === "undefined" ? [] : quakePartition.pending).flatMap((range) => {
    const page = detailPageForRange(range);
    return page == null ? [] : [{ id: quakeProbeId(range), range, page }];
  }));
  const paging = $derived(pages.length > 1);

  function commitProbeMeasurement(id: string, measurement: ProbeMeasurement): void {
    if (layoutSettling) {
      pendingProbeMeasurements.set(id, measurement);
      return;
    }
    const previous = probeMeasurements[id];
    if (previous?.contentHeight === measurement.contentHeight
      && previous.availableHeight === measurement.availableHeight) return;
    probeMeasurements = { ...probeMeasurements, [id]: measurement };
  }
  function measurePartitionProbe(node: HTMLElement, id: string) {
    let currentId = id;
    const measure = (): void => {
      const measurement = {
        contentHeight: node.scrollHeight,
        availableHeight: node.clientHeight,
      };
      if (measurement.contentHeight > 0 && measurement.availableHeight > 0) {
        commitProbeMeasurement(currentId, measurement);
      }
    };
    if (typeof ResizeObserver === "undefined") return { update(next: string) { currentId = next; } };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    queueMicrotask(measure);
    return {
      update(next: string) { currentId = next; measure(); },
      destroy() { observer.disconnect(); },
    };
  }
  function observeProbeBox(node: HTMLElement) {
    if (typeof ResizeObserver === "undefined") return {};
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.getBoundingClientRect().width;
      const height = entries[0]?.contentRect.height ?? node.getBoundingClientRect().height;
      if (!(width > 0) || !(height > 0)) return;
      if (layoutSettling) pendingProbeBox = { width, height };
      else {
        probeWidth = width;
        probeHeight = height;
      }
    });
    observer.observe(node);
    return { destroy() { observer.disconnect(); } };
  }
  $effect(() => {
    if (layoutSettling) return;
    if (pendingProbeBox != null) {
      probeWidth = pendingProbeBox.width;
      probeHeight = pendingProbeBox.height;
      pendingProbeBox = null;
    }
    if (pendingProbeMeasurements.size > 0) {
      probeMeasurements = { ...probeMeasurements, ...Object.fromEntries(pendingProbeMeasurements) };
      pendingProbeMeasurements.clear();
    }
  });

  // 別イベント (eventId 変化) か、同一イベントの続報で severityTier (地震は最大震度 rank) が
  // 「上昇」したときにページを先頭に戻す。下降・同値ではリセットしない (spec §3、Codex R
  // レビュー M2)。$derived ではなく変化検知の $effect + $state カウンタで単調増加させる
  // (resetKey に同一値の再代入を渡してもリセットされない page-cycler の契約に合わせる)
  const identityKey = $derived(input.eventId ?? `${input.hypocenterName ?? ""}:${input.originTime ?? ""}`);
  let resetSeq = $state(0);
  let prevIdentityKey: string | null = null;
  let prevMaxIntRank = -1;
  $effect(() => {
    const key = identityKey;
    const rank = input.maxIntRank;
    if (prevIdentityKey != null && (key !== prevIdentityKey || rank > prevMaxIntRank)) {
      resetSeq += 1;
    }
    prevIdentityKey = key;
    prevMaxIntRank = rank;
  });

  const attention = new PageAttentionState();
  function intensityFingerprint(intensity: DisplayLargeQuakeInputV1["intensityGroups"][number]["intensitySemantic"] | undefined) {
    return {
      raw: intensity?.raw ?? null, presence: intensity?.presence ?? null, label: intensity?.label ?? null,
      condition: intensity?.condition ?? null, description: intensity?.description ?? null,
      lowerBound: intensity?.lowerBound ?? null, upperBound: intensity?.upperBound ?? null,
      rawLowerBound: intensity?.rawLowerBound ?? null, rawUpperBound: intensity?.rawUpperBound ?? null,
      badge: intensity?.badge ?? null, color: intensity?.color ?? null, render: intensity?.render ?? null,
      safetyLowerRank: intensity?.safetyLowerRank ?? null, safetyUpperRank: intensity?.safetyUpperRank ?? null,
      safetyRank: intensity?.safetyRank ?? null, colorRank: intensity?.colorRank ?? null,
    };
  }
  const attentionPages = $derived(pages.map((page, index) => {
    const entries = page.sections.flatMap((section) => {
      const cities = section.prefGroups.flatMap((pref) => pref.cities.map((city, cityIndex) => ({
        identity: `${section.intensity}|${section.rank}|${pref.pref ?? "その他"}|${city}|${cityIndex}`,
        fingerprint: itemContentFingerprint({
          intensity: section.intensity, rank: section.rank,
          intensitySemantic: intensityFingerprint(displayGroups.find((group) => group.intensity === section.intensity && group.rank === section.rank)?.intensitySemantic),
          prefecture: pref.pref, city,
        }),
      })));
      const omitted = omittedAreaCount(section.intensity, section.rank);
      if (omitted > 0 && isLastSectionOnSequence(index, section.intensity, section.rank)) {
        cities.push({
          identity: `${section.intensity}|${section.rank}|omitted`,
          fingerprint: itemContentFingerprint({
            intensity: section.intensity,
            rank: section.rank,
            omittedAreaCount: omitted,
          }),
        });
      }
      return cities;
    });
    const first = entries[0]?.identity ?? `empty:${index}`;
    const last = entries.at(-1)?.identity ?? `empty:${index}`;
    return {
      identity: `emergency-quake-regions:${first}:${last}`,
      fingerprint: pageContentFingerprint({ title: "観測震度 詳細", range: index }, entries),
    };
  }));
  $effect(() => {
    const generation = {
      episodeKey: `quake:${identityKey}`,
      severityRank: input.maxIntRank ?? 0,
      pages: attentionPages,
      preserveStablePages: true,
      partitionPending: quakePartitionPending,
    };
    untrack(() => attention.sync(generation));
  });
  const cycler = createPageCycler({
    pageCount: () => pages.length,
    resetKey: () => resetSeq,
    reducedMotion: () => reducedMotion,
    pageIdentity: () => attentionPages[cycler.index]?.identity ?? null,
    pageFingerprint: () => attentionPages[cycler.index]?.fingerprint ?? "",
    onHoldComplete: (_index, identity, fingerprint) => {
      const active = attentionPages[cycler.index];
      if (identity != null && active?.identity === identity && active.fingerprint === fingerprint) {
        attention.markHoldComplete(identity);
      }
    },
  });
  const attentionView = $derived(attention.viewModel(cycler.index));
  // unmount (main-stack のモード切替・panel 差替え) で $effect.root のタイマー/matchMedia
  // リスナーがリークしないよう、コンポーネント破棄時に必ず destroy() する (Codex R レビュー M1)
  onDestroy(() => cycler.destroy());

  // paging=true なら pages.length>0 が保証される (shouldPageDetails は intensityGroups が
  // 空でない前提でしか true にならない) ため、範囲外 fallback は pages[0] へ (null 経由の
  // 1 フレーム空表示を避ける)
  const currentPage = $derived(pages[cycler.index] ?? pages[0] ?? null);
  const showMap = $derived(!compact && mapEvent != null);
  const maxVisual = $derived(intensityVisual(input.maxIntSemantic, formatIntShort(input.maxInt), input.maxIntRank));
  const maxSeverityRank = $derived(input.maxIntSemantic == null ? input.maxIntRank : input.maxIntSemantic.safetyRank);

  function groupVisual(intensity: string, rank: number) {
    const group = displayGroups.find((item) => item.intensity === intensity && item.rank === rank);
    return intensityVisual(group?.intensitySemantic, formatIntShort(intensity), rank);
  }
  function omittedAreaCount(intensity: string, rank: number): number {
    return displayGroups.find((group) => group.intensity === intensity && group.rank === rank)?.omittedAreaCount ?? 0;
  }
  function isLastSectionOnSequence(pageIndex: number, intensity: string, rank: number): boolean {
    return !(pages.slice(pageIndex + 1).some((page) =>
      page.sections.some((section) => section.intensity === intensity && section.rank === rank)
    ));
  }
  function isLastSectionInRange(range: PageRange, intensity: string, rank: number): boolean {
    return !quakeAreaEntries.slice(range.end).some((entry) => {
      const group = displayGroups[entry.groupIndex];
      return group?.intensity === intensity && group.rank === rank;
    });
  }
</script>

{#snippet detailPageBody(page: DetailPage, pageIndex: number, measurementRange: PageRange | null = null)}
  {#each page.sections as section (`${section.intensity}:${section.rank}`)}
    {@const visual = groupVisual(section.intensity, section.rank)}
    <div class="page-section">
      <span class="int-chip int-r{visual.colorRank ?? 0}" class:special-unknown={visual.colorClass === "quake-map-unknown"} class:special-empty={visual.colorClass === "quake-map-neutral"} title={visual.tooltip ?? undefined} aria-label={visual.ariaLabel ?? undefined}>{visual.label ?? ""}{#if visual.badge != null}<b class="semantic-badge">{visual.badge}</b>{/if}</span>
      {#each section.prefGroups as pg (`${pg.pref ?? "その他"}:${pg.continuation}`)}
        <div class="pref-group">
          <span class="pref-name">{pg.pref ?? "その他"}{pg.continuation ? "（続き）" : ""}</span>
          {#if pg.cities.length > 0}<span class="cities">{#each pg.cities as city, cityIndex (`${city}:${cityIndex}`)}<span class="city-name">{city}</span>{/each}</span>{/if}
        </div>
      {/each}
      {#if (measurementRange == null
        ? isLastSectionOnSequence(pageIndex, section.intensity, section.rank)
        : isLastSectionInRange(measurementRange, section.intensity, section.rank))
        && omittedAreaCount(section.intensity, section.rank) > 0}
        <span class="omitted-areas">ほか {omittedAreaCount(section.intensity, section.rank)} 地域</span>
      {/if}
    </div>
  {/each}
{/snippet}

<div
  class="quake-panel role-quakeMajor"
  class:compact
  data-quake-page={attentionView.page ?? "1/1"}
  data-quake-page-unseen={attentionView.unseenCount}
  data-quake-page-infeasible={quakePartition.infeasible ? "true" : "false"}
>
  <div class="heading" class:critical={(maxSeverityRank ?? 0) >= 7}>
    <span class="heading-text">地震情報</span>
  </div>
  <div class="tiles">
    <div class="tile tile-main">
      <div class="hypocenter">{input.hypocenterName ?? "震源調査中"}</div>
      {#if maxVisual.render}<div class="max-int" title={maxVisual.tooltip ?? undefined} aria-label={`最大${maxVisual.ariaLabel ?? "震度不明"}`}>最大震度{maxVisual.label ?? ""}{#if maxVisual.badge != null}<b class="semantic-badge">{maxVisual.badge}</b>{/if}</div>{/if}
      <NumericSemanticLegend semantics={[input.magnitudeSemantic, input.depthSemantic]} />
      {#if hasChips}
        <div
          class="reveal-wrap chip-reveal-wrap"
          data-motion-reveal="height"
          in:heightReveal={{
            reveal: chipRowInitiallyAbsent && !cycler.reducedMotion,
            duration: SPRING_EFFECTS_DEFAULT_MS,
          }}
        >
          <div class="chip-row">
            {#if input.tsunamiWarning}
              <span
                class="chip tsunami-mark"
                data-motion-reveal="scale"
                in:revealScaleIn={{
                  reveal: !initialElementKeys.has("chip:tsunami") && !cycler.reducedMotion,
                  duration: SPRING_SPATIAL_DEFAULT_MS,
                }}>津波</span
              >
            {/if}
            {#if input.originTime != null}
              <span
                class="chip origin-time"
                data-motion-reveal="scale"
                in:revealScaleIn={{
                  reveal: !initialElementKeys.has("chip:origin") && !cycler.reducedMotion,
                  duration: SPRING_SPATIAL_DEFAULT_MS,
                }}>{originTimeLabel} 発生</span
              >
            {/if}
          </div>
        </div>
      {/if}
    </div>
    <div class="tile-stats">
      <div class="tile stat-tile">
        <span class="stat-label">{magnitude.numericValue != null ? "M" : "規模"}</span>
        <span class="stat-value" title={magnitude.tooltip ?? undefined} aria-label={magnitude.ariaLabel}>{magnitude.numericValue != null ? magnitude.numericValue.toFixed(1) : magnitude.label}{#if magnitude.badge != null}<b class="semantic-badge">{magnitude.badge}</b>{/if}</span>
      </div>
      {#if input.depthSemantic != null ? depth.render : input.depth != null}
        <div class="tile stat-tile">
          <span class="stat-label">深さ</span>
          <span class="stat-value" title={depth.tooltip ?? undefined} aria-label={depth.ariaLabel}>{depth.label}{#if depth.badge != null}<b class="semantic-badge">{depth.badge}</b>{/if}</span>
        </div>
      {/if}
      {#if input.maxLgInt != null}
        <!-- 長周期は続報で後から現れる後発要素 (spec §2-c)。ただし横並び flex 行では M・深さ
             タイルが既に行高を確保しており、heightReveal は周囲を押し下げず「長周期だけ上から開く」
             不自然な動きになる (レビュー指摘 Medium 3)。行の高さは兄弟が固定するので scale のみへ縮退し、
             タイル自身に revealScaleIn を付ける (縦方向挿入のチップ行・津波行は heightReveal を維持)。 -->
        <div
          class="tile stat-tile"
          data-motion-reveal="scale"
          in:revealScaleIn={{
            reveal: !initialHasLgInt && !cycler.reducedMotion,
            duration: SPRING_SPATIAL_DEFAULT_MS,
          }}
        >
          <span class="stat-label">長周期</span>
          <span class="stat-value lg">{input.maxLgInt}</span>
        </div>
      {/if}
    </div>
    <div class="quake-detail" class:with-map={showMap}>
      {#if showMap && mapEvent != null}
        <div class="map-slot">
          <QuakeMap event={mapEvent} />
        </div>
      {/if}
      <div class="detail-text">
        {#if currentPage != null}
            <div class="tile tile-page-detail" use:observeProbeBox>
              {#key cycler.index}
                <div
                  class="page-fade"
                  transition:fade={{
                    duration: cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
                    easing: springEffectsOut,
                  }}
                >
                  <div class="page-header">
                    <span class="page-title">観測震度 詳細</span>
                    {#if paging}<PageDots total={cycler.total} current={cycler.index} onJump={(i) => cycler.jumpTo(i)} />{/if}
                    {#if attentionView.text !== ""}<span class="page-attention" data-page-attention={attentionView.text}>{attentionView.text}</span>{/if}
                  </div>
                  <div class="page-body">
                    {@render detailPageBody(currentPage, cycler.index, pageRanges[cycler.index] ?? null)}
                  </div>
                </div>
              {/key}
              <div class="partition-probe-shelf" aria-hidden="true" inert data-partition-probe-shelf>
                {#each quakeProbePages as probe (probe.id)}
                  <div class="page-fade partition-probe-page">
                    <div class="page-header">
                      <span class="page-title">観測震度 詳細</span>
                      {#if pages.length > 1}<span class="partition-probe-dots">{#each pages as _, index (index)}<i class:current={index === 0}></i>{/each}</span>{/if}
                      <span class="page-attention">{pages.length > 1 ? `1/${pages.length}・未表示${pages.length}` : "未表示1"}</span>
                    </div>
                    <div
                      class="page-body partition-probe-body"
                      data-partition-probe-range={`${probe.range.start}:${probe.range.end}`}
                      use:measurePartitionProbe={probe.id}
                    >
                      {@render detailPageBody(probe.page, 0, probe.range)}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
        {:else if quakePartition.infeasible}
          <div class="tile tile-page-detail partition-infeasible">
            <div class="page-header"><span class="page-title">観測震度 詳細</span></div>
            <div class="partition-infeasible-message">表示領域不足・{quakeAreaEntries.length}地域</div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .quake-panel {
    container-type: inline-size;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 0;
    color: var(--fg);
    background: var(--surface-panel);
    border-radius: var(--radius-panel);
    box-shadow: var(--elevation-3);
    overflow: hidden;
  }
  .heading {
    box-sizing: border-box;
    min-height: calc(var(--panel-header-min-h) * var(--panel-scale, 1));
    display: flex;
    align-items: center;
    font-size: calc(var(--panel-header-font-size) * var(--panel-scale, 1));
    font-weight: var(--type-headline-weight-emphasized);
    padding: calc(var(--panel-header-padding-v) * var(--panel-scale, 1))
      calc(var(--panel-header-padding-h) * var(--panel-scale, 1));
    background: var(--header-quakeWarning-container);
    color: var(--header-quakeWarning-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeWarning);
  }
  .heading.critical {
    background: var(--header-quakeCritical-container);
    color: var(--header-quakeCritical-on);
    border-bottom: var(--header-band-width) solid var(--header-band-quakeCritical);
  }
  .tiles {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) calc(28px * var(--panel-scale, 1)) calc(24px * var(--panel-scale, 1));
  }
  .tile {
    background: var(--surface-panel-raised);
    border-radius: var(--radius-m);
    border: 1px solid var(--hairline);
    box-shadow: var(--elevation-1);
  }
  .tile-main {
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .hypocenter {
    /* 地震情報は「確定情報の記録」で EEW ヒーロー (display-l) ほどの緊急性は不要。一段落とす */
    font-size: calc(var(--type-headline-l-size) * var(--panel-scale, 1));
    font-weight: var(--num-weight);
    transition: font-weight var(--dur-weight-swell) var(--spring-effects-slow);
  }
  .max-int {
    margin-top: var(--space-2);
    font-size: calc(var(--type-headline-s-size) * var(--panel-scale, 1));
    font-weight: var(--num-weight);
    color: var(--role-quakeMajor);
    transition: font-weight var(--dur-weight-swell) var(--spring-effects-slow);
  }
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
    font-size: calc(var(--type-title-s-size) * var(--panel-scale, 1));
  }
  .chip {
    background: var(--surface-panel);
    border-radius: var(--radius-m);
    padding: 4px var(--space-3);
  }
  .tsunami-mark {
    color: var(--c-jma-red);
    font-weight: var(--type-title-weight-emphasized);
  }
  .origin-time {
    color: var(--role-muted);
  }
  /* 後発チップ行の高さ reveal wrapper (spec §2-c Medium 2): padding/border/margin 0。
     heightReveal は scrollHeight を CSS height に代入するため wrapper 側に padding/border/margin が
     あると height:0 で閉じ切らない (内側 padding は body 側)。overflow はアニメ中だけ heightReveal
     が出すので恒久 hidden は付けない (レビュー指摘 Medium 4、chip の shadow/overshoot 切断を避ける)。 */
  .reveal-wrap {
    padding: 0;
    border: 0;
    margin: 0;
  }
  .tile-stats {
    display: flex;
    flex-direction: row;
    gap: var(--space-3);
  }
  .stat-tile {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-4);
  }
  .stat-label {
    font-size: var(--type-label-m-size);
    color: var(--role-muted);
  }
  .stat-value {
    font-size: var(--type-headline-m-size);
    font-weight: var(--num-weight);
  }
  .stat-value.lg {
    color: var(--c-orange);
  }
  .quake-detail {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .quake-detail.with-map {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.85fr);
    gap: var(--space-3);
  }
  .map-slot,
  .detail-text {
    min-width: 0;
    min-height: 0;
  }
  .detail-text {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  /* 詳細ページング (spec §3): 各ページに見出し・ページ位置を固定枠で常時表示する
     (原則3「任意の瞬間が単独で読める」)。ページ切替は旧ページ・新ページを重ねたクロスフェード
     (T5c、spec §3 再々改訂「チカチカする短いディップは撤回、重ねる」)。{#key cycler.index} で
     再マウントされる .page-fade は position:absolute で親 (.tile-page-detail、position:relative +
     flex:1 で実測される固定高さ) に重ねて配置する。outro (旧ページ) と intro (新ページ) が
     同時に走ることで空白を経由しない。減光ではなく入替表現なので opacity 禁じ手 (§8) には
     該当しない。フェード完了後は outro 側が DOM から破棄され単層 opacity:1 に戻る (Svelte 標準) */
  .tile-page-detail {
    position: relative;
    flex: 1;
    min-height: 0;
    padding: var(--space-4) var(--space-5);
  }
  /* T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘、TsunamiPanel と同型)。
     position:absolute な .page-fade (inset:0) の containing block は「最も近い positioned
     祖先の padding box」(CSS 仕様上、border box ではなく padding box) になるため、.tile-page-detail
     自身の padding (position:relative の祖先と padding の宿主が同一要素) が実質無かったことに
     なっていた。同じ padding を .page-fade にも明示的に持たせて復元する。ここは pageBodyAreaHeight
     (.page-body を直接 measureHeight する、T5c) が capacity を出しているため、この padding は
     次回の ResizeObserver 実測で自動的に反映される (outer tile 近似を使う TsunamiPanel の
     coastRowCapacity のような明示補正定数は不要 — 直接測定なので自己整合する) */
  .page-fade {
    position: absolute;
    inset: 0;
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .page-header {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: calc(var(--type-label-m-size) * var(--panel-scale, 1));
  }
  .page-title {
    font-weight: var(--type-body-weight-emphasized);
    color: var(--role-muted);
  }
  .page-attention {
    color: var(--role-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .page-body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: calc(var(--type-title-l-size) * var(--panel-scale, 1));
  }
  /* sequentialPartitionRanges が要求した候補だけを、live と同じ固定本文幅・高さで強制描画する。
     absolute + visibility:hidden で通常レイアウトと視覚から外し、aria-hidden/inert は markup 側で持つ。 */
  .partition-probe-shelf,
  .partition-probe-page {
    position: absolute;
    inset: 0;
  }
  .partition-probe-shelf {
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
  }
  .partition-probe-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
  }
  .partition-probe-dots {
    display: flex;
    align-items: center;
    align-self: center;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: auto;
  }
  .partition-probe-dots i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .partition-probe-dots i.current {
    width: 8px;
    height: 8px;
  }
  .partition-infeasible-message {
    color: var(--role-muted);
    font-size: calc(var(--type-title-l-size) * var(--panel-scale, 1));
  }
  .group {
    display: flex;
    gap: 14px;
    font-size: calc(var(--type-title-l-size) * var(--panel-scale, 1));
    /* 複数県にまたがり複数行になっても震度チップが縦に伸びないよう行頭固定 (第3波 Fix6) */
    align-items: flex-start;
  }
  /* 都道府県 → 市区町村の階層。WeatherAlertCard/LatestQuakeCard の pref-group 文法と揃える (第3波 Fix7) */
  .group-pref-groups {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pref-group {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4em;
  }
  .pref-name {
    flex-shrink: 0;
    font-weight: var(--type-title-weight-emphasized);
    color: var(--fg);
  }
  /* 市区町村名は個別 span (white-space:nowrap) にし、折返しは名前と名前の間だけで発生させる。
     区切りは文字 (旧「・」) ではなく gap で表現する (第3波 Fix14)。.cities 自体は display:contents
     で flex アイテムから外し、city-name span を .pref-group の直接の子として扱わせる。
     inline-flex のままだと "ブロック単位で次行へ wrap" してしまい、市町村が多い県だけ県名直後で
     改行される不統一が起きていた (review-T5a-2 FIX-B)。常にインラインで自然折返しさせる */
  .cities {
    display: contents;
    color: var(--fg);
  }
  .city-name {
    white-space: nowrap;
  }
  .group-omitted {
    display: block;
    margin-top: 2px;
    color: var(--role-muted);
    font-size: 0.7em;
  }
  /* 待機画面 (RecentQuakes/LatestQuakeCard) と同じ int-chip 形式に統一する */
  .int-chip {
    flex-shrink: 0;
    min-width: 3.2em;
    max-width: 12em;
    text-align: center;
    padding: 2px 10px;
    border-radius: var(--radius-s);
    font-weight: var(--type-title-weight-emphasized);
    font-variant-numeric: tabular-nums;
    background: var(--surface-panel);
    overflow-wrap: anywhere;
  }
  .semantic-badge { margin-left: 0.25em; font-weight: var(--type-label-weight-emphasized); }
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
  .int-chip.special-unknown { color: var(--c-raspberry); border: 1px dashed currentColor; }
  .int-chip.special-empty { color: var(--role-muted); border: 1px dotted currentColor; }
  /* compact (main-stack 非 main スロット): ヒーロー部をさらに凝縮しリスト領域にカード高を
     渡す (第3波 Fix20)。震央名は headline-m(32px) → title-l(26px) へもう一段降格し、推定
     最大震度と近接2行にする。M/深さ/長周期の stat タイルは箱型をやめ、既存チップ文法
     (radius-full + surface) のインライン小チップ列へ置き換える */
  .quake-panel.compact .hypocenter {
    font-size: var(--type-title-l-size);
  }
  .quake-panel.compact .max-int {
    margin-top: 2px;
    font-size: var(--type-title-m-size);
  }
  .quake-panel.compact .chip-row {
    margin-top: 2px;
    gap: var(--space-1);
    font-size: var(--type-label-xs-size);
  }
  .quake-panel.compact .chip {
    padding: 1px var(--space-2);
  }
  .quake-panel.compact .tile-main {
    padding: var(--space-1) var(--space-2);
  }
  .quake-panel.compact .tile-stats {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .quake-panel.compact .stat-tile {
    flex: 0 0 auto;
    flex-direction: row;
    align-items: baseline;
    gap: var(--space-1);
    padding: 1px 8px;
    border: none;
    box-shadow: none;
    border-radius: var(--radius-full);
    background: var(--surface-panel);
  }
  .quake-panel.compact .stat-value {
    font-size: var(--type-body-m-size);
  }
  .quake-panel.compact .origin-time {
    font-size: var(--type-body-m-size);
  }
  .quake-panel.compact .stat-label {
    font-size: var(--type-label-xs-size);
  }
  .quake-panel.compact .tiles {
    padding: var(--space-2) var(--space-3) var(--space-3);
    gap: var(--space-1);
  }
  .quake-panel.compact .tile-groups {
    padding: var(--space-1) var(--space-2);
    overflow: hidden;
  }
  .quake-panel.compact .groups {
    gap: var(--space-1);
  }
  .quake-panel.compact .group {
    font-size: var(--type-label-l-size);
    gap: var(--space-2);
  }
  .quake-panel.compact .tile-page-detail {
    padding: var(--space-1) var(--space-2);
    gap: var(--space-1);
  }
  /* 実効 padding は inset:0 の .page-fade 側が持つ (containing block = padding box のため祖先
     padding は absolute 子に効かない)。compact の縮小 padding も .page-fade へ追従させる */
  .quake-panel.compact .page-fade {
    padding: var(--space-1) var(--space-2);
  }
  .quake-panel.compact .partition-probe-page {
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
  }
  .quake-panel.compact .page-header {
    font-size: var(--type-label-xs-size);
  }
  .quake-panel.compact .page-body {
    font-size: var(--type-label-l-size);
    gap: var(--space-1);
  }

  /* bento: 十分な幅があれば震度別グループを 2 カラムに流し込む */
  @container (min-width: 860px) {
    .groups {
      display: block;
      columns: 2;
      column-gap: var(--space-6);
    }
    .group {
      break-inside: avoid;
      margin-bottom: var(--space-3);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hypocenter,
    .max-int {
      transition: none;
    }
  }
</style>
