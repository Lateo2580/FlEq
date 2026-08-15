<script lang="ts">
  import Clock from "../components/Clock.svelte";
  import FloodCard from "../components/FloodCard.svelte";
  import HeatAlertCard from "../components/HeatAlertCard.svelte";
  import InstrumentRow from "../components/InstrumentRow.svelte";
  import LatestQuakeCard from "../components/LatestQuakeCard.svelte";
  import NankaiBadge from "../components/NankaiBadge.svelte";
  import RecentQuakes from "../components/RecentQuakes.svelte";
  import TsunamiStandbyBanner from "../components/TsunamiStandbyBanner.svelte";
  import TyphoonCard from "../components/TyphoonCard.svelte";
  import VolcanoCard from "../components/VolcanoCard.svelte";
  import WeatherAlertCard from "../components/WeatherAlertCard.svelte";
  import type { ActiveStandbyCardV1, DisplayWeatherAlertV1 } from "../lib/protocol";
  import {
    latestQuakeStandbyCards,
    legacyImprovedMaxItems,
    legacyImprovedMaxUnknownItems,
    legacyImprovedMaxWeatherAlerts,
    legacyImprovedMaxWeatherAlertsCompact,
    legacyImprovedWeatherAlertsCompact,
    recentQuakesRich,
    standbyItemsShowcase,
    statsStandbyCards,
    tsunamiBanner,
    weatherWarningOnlyStandbyCards,
  } from "./fixtures";

  type Scenario = "4" | "7" | "max";
  type LadderStage = 0 | 1 | 2 | 3;
  type CardKey = "tsunami" | "quake" | "weather" | "flood" | "typhoon" | "volcano" | "heat";
  type StandbyItemOf<K extends ActiveStandbyCardV1["kind"]> = Extract<ActiveStandbyCardV1, { kind: K }>;

  interface CardCandidate {
    key: CardKey;
    order: number;
    score: number;
    naturalHeight: number;
    minHeight: number;
  }

  interface PlannedCard extends CardCandidate {
    allocatedHeight: number;
    extraHeight: number;
    clipped: boolean;
    overflowed: boolean;
  }

  interface ColumnPlan {
    left: CardCandidate[];
    right: CardCandidate[];
    moved: Set<CardKey>;
    unresolved: boolean;
    stage: LadderStage;
  }

  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

  function parseScenario(value: string | null): Scenario {
    return value === "7" || value === "max" ? value : "4";
  }

  function parseLadder(value: string | null): LadderStage | null {
    if (value === "0") return 0;
    if (value === "1") return 1;
    if (value === "2") return 2;
    if (value === "3") return 3;
    return null;
  }

  function findItem<K extends ActiveStandbyCardV1["kind"]>(
    items: readonly ActiveStandbyCardV1[],
    kind: K,
  ): StandbyItemOf<K> | null {
    return items.find((item): item is StandbyItemOf<K> => item.kind === kind) ?? null;
  }

  function clampInteger(value: number, minimum: number, maximum: number): number {
    return Math.round(Math.max(minimum, Math.min(maximum, value)));
  }

  const scenario = parseScenario(params.get("legacyMock2"));
  const ladderOverride = parseLadder(params.get("ladder"));
  const ladderAuto = ladderOverride == null;
  const now = new Date("2026-08-15T12:34:56+09:00");
  const viewportWidthPx = typeof window === "undefined" ? 1920 : Math.max(320, window.innerWidth || 1920);
  const viewportHeightPx = typeof window === "undefined" ? 1080 : Math.max(620, window.innerHeight || 1080);
  const edgePx = clampInteger(viewportWidthPx * 0.025, 14, 48);
  const tickerHeightPx = clampInteger(viewportHeightPx * 0.06, 52, 68);
  const layoutHeightPx = Math.max(320, viewportHeightPx - edgePx * 2 - tickerHeightPx);
  const regularGapPx = clampInteger(viewportWidthPx * 0.01, 8, 18);
  const compressedGapPx = clampInteger(regularGapPx * 0.6, 4, 10);
  const activeItems = scenario === "max" ? legacyImprovedMaxItems : standbyItemsShowcase;
  const unknownInputs = scenario === "max" ? legacyImprovedMaxUnknownItems : [];
  const tsunami = scenario === "4" ? null : tsunamiBanner;
  const flood = scenario === "4" ? null : findItem(activeItems, "flood");
  const typhoon = scenario === "4" ? null : findItem(activeItems, "typhoon");
  const volcano = findItem(activeItems, "volcano");
  const heat = findItem(activeItems, "heat");
  const tornado = findItem(activeItems, "tornado");
  const longPeriod = findItem(activeItems, "longPeriod");
  const nankai = findItem(activeItems, "nankaiTrough");
  const fixedRecentRows = recentQuakesRich.slice(0, scenario === "4" ? 3 : 5);
  const fullWeatherAlerts: DisplayWeatherAlertV1[] = scenario === "max"
    ? legacyImprovedMaxWeatherAlerts
    : weatherWarningOnlyStandbyCards;
  const compactWeatherAlerts: DisplayWeatherAlertV1[] = scenario === "max"
    ? legacyImprovedMaxWeatherAlertsCompact
    : legacyImprovedWeatherAlertsCompact;

  // main の各カードの padding/max-height と実際の fixture の行数を写した、目視モック用の
  // 自然高さ近似。DOM の矩形を測る仕組みではないため、配置判定以外の用途には使わない。
  function weatherNaturalHeight(alerts: readonly DisplayWeatherAlertV1[]): number {
    const rows = alerts.reduce((total, alert) => total + alert.items.reduce(
      (subtotal, item) => subtotal + 1 + item.shownAreas.length,
      0,
    ), 0);
    const raw = 48 + rows * 36 + (tornado == null ? 0 : 34);
    return Math.min(Math.min(280, viewportHeightPx * 0.44), raw);
  }

  function naturalHeight(key: CardKey, weatherAlerts = fullWeatherAlerts): number {
    if (key === "tsunami") {
      const levels = new Set(tsunami?.coasts.map((coast) => coast.kind) ?? []);
      return 48 + levels.size * 28 + 42;
    }
    if (key === "quake") {
      return 48 + 28 + 76 + (longPeriod == null ? 0 : 30) + latestQuakeStandbyCards.intensityGroups.length * 48;
    }
    if (key === "weather") return Math.round(weatherNaturalHeight(weatherAlerts));
    if (key === "flood") {
      const riverCount = flood?.data.rivers.length ?? 0;
      const stationCount = flood?.data.rivers.filter((river) => river.station != null).length ?? 0;
      return Math.min(200, 48 + riverCount * 38 + stationCount * 28);
    }
    if (key === "typhoon") return 48 + (typhoon?.data.typhoons.length ?? 0) * 124;
    if (key === "volcano") {
      const volcanoes = volcano?.data.volcanoes ?? [];
      const eventCount = volcanoes.filter((item) => item.latestEvent != null).length;
      const meaningCount = volcanoes.filter((item) => item.warningKind != null || (item.targetKinds?.length ?? 0) > 0).length;
      return 48 + volcanoes.length * 48 + eventCount * 76 + meaningCount * 18;
    }
    return heat == null ? 0 : 82;
  }

  function contentScore(key: CardKey): number {
    if (key === "tsunami") return (tsunami?.coasts.length ?? 0) + 3;
    if (key === "quake") return 6 + latestQuakeStandbyCards.intensityGroups.length * 2 + (longPeriod == null ? 0 : 1);
    if (key === "weather") return 3 + fullWeatherAlerts.reduce((total, alert) => total + alert.items.reduce((subtotal, item) => subtotal + item.shownAreas.length + 1, 0), 0);
    if (key === "flood") return 2 + (flood?.data.rivers.length ?? 0) * 2;
    if (key === "typhoon") return 2 + (typhoon?.data.typhoons.length ?? 0) * 4;
    if (key === "volcano") return 2 + (volcano?.data.volcanoes.length ?? 0) * 2;
    return 2 + (heat?.data.areas.length ?? 0);
  }

  function minimumHeight(key: CardKey, natural: number): number {
    const minimum = key === "quake" ? 148 : key === "weather" ? 88 : 76;
    return Math.min(natural, minimum);
  }

  function candidate(key: CardKey, order: number, weatherAlerts = fullWeatherAlerts): CardCandidate {
    const height = naturalHeight(key, weatherAlerts);
    return { key, order, score: contentScore(key), naturalHeight: height, minHeight: minimumHeight(key, height) };
  }

  const allCandidates: CardCandidate[] = [
    ...(tsunami == null ? [] : [candidate("tsunami", 0)]),
    candidate("quake", 1),
    candidate("weather", 2),
    ...(flood == null ? [] : [candidate("flood", 3)]),
    ...(typhoon == null ? [] : [candidate("typhoon", 4)]),
    ...(volcano == null ? [] : [candidate("volcano", 5)]),
    ...(heat == null ? [] : [candidate("heat", 6)]),
  ];
  const leftKeys = new Set<CardKey>(["tsunami", "quake"]);
  const rightKeys = new Set<CardKey>(["weather", "flood", "typhoon", "volcano", "heat"]);
  const forcedOverflowKeys = new Set<CardKey>(["volcano", "heat"]);

  function gapFor(stage: LadderStage): number {
    return stage === 3 ? compressedGapPx : regularGapPx;
  }

  function naturalColumnHeight(cards: readonly CardCandidate[], gapPx: number): number {
    return cards.reduce((total, card) => total + card.naturalHeight, 0)
      + Math.max(0, cards.length - 1) * gapPx;
  }

  function makeColumnPlan(candidates: readonly CardCandidate[], override: LadderStage | null): ColumnPlan {
    const gapPx = gapFor(override === 3 ? 3 : 0);
    const moved = new Set<CardKey>();
    if (override != null && override >= 1) {
      for (const card of candidates) {
        if (forcedOverflowKeys.has(card.key)) moved.add(card.key);
      }
    } else if (override == null) {
      const moveOrder = candidates
        .filter((card) => rightKeys.has(card.key) && card.key !== "weather")
        .sort((left, right) => left.score - right.score || right.order - left.order);
      for (const card of moveOrder) {
        const right = candidates.filter((item) => rightKeys.has(item.key) && !moved.has(item.key));
        if (naturalColumnHeight(right, gapPx) <= layoutHeightPx) break;
        const left = candidates.filter((item) => leftKeys.has(item.key) || moved.has(item.key));
        const nextLeft = [...left, card];
        if (naturalColumnHeight(nextLeft, gapPx) <= layoutHeightPx) moved.add(card.key);
      }
    }

    const left = candidates.filter((card) => leftKeys.has(card.key) || moved.has(card.key));
    const right = candidates.filter((card) => rightKeys.has(card.key) && !moved.has(card.key));
    const unresolved = naturalColumnHeight(left, gapPx) > layoutHeightPx
      || naturalColumnHeight(right, gapPx) > layoutHeightPx;
    const stage: LadderStage = override
      ?? (unresolved ? 2 : moved.size > 0 ? 1 : 0);
    return { left, right, moved, unresolved, stage };
  }

  function allocateNaturalHeight(cards: readonly CardCandidate[], stage: LadderStage): PlannedCard[] {
    if (cards.length === 0) return [];
    const gapPx = gapFor(stage);
    const budget = Math.max(0, layoutHeightPx - Math.max(0, cards.length - 1) * gapPx);
    const naturalTotal = cards.reduce((total, card) => total + card.naturalHeight, 0);
    if (naturalTotal <= budget) {
      return cards.map((card) => ({
        ...card,
        allocatedHeight: card.naturalHeight,
        extraHeight: 0,
        clipped: false,
        overflowed: false,
      }));
    }

    const allocated = new Map<CardKey, number>(cards.map((card) => [card.key, card.minHeight]));
    let remaining = Math.max(0, budget - cards.reduce((total, card) => total + card.minHeight, 0));
    const priority = [...cards].sort((left, right) => right.score - left.score || left.order - right.order);
    for (const card of priority) {
      const room = Math.max(0, card.naturalHeight - card.minHeight);
      const extra = Math.min(room, remaining);
      allocated.set(card.key, card.minHeight + extra);
      remaining -= extra;
      if (remaining <= 0) break;
    }
    return cards.map((card) => {
      const allocatedHeight = allocated.get(card.key) ?? card.minHeight;
      return {
        ...card,
        allocatedHeight,
        extraHeight: Math.max(0, allocatedHeight - card.minHeight),
        clipped: allocatedHeight < card.naturalHeight,
        overflowed: false,
      };
    });
  }

  const fullPlan = makeColumnPlan(allCandidates, ladderOverride);
  const fullLeft = allocateNaturalHeight(fullPlan.left, fullPlan.stage);
  const fullRight = allocateNaturalHeight(fullPlan.right, fullPlan.stage);
  const fullWeather = [...fullLeft, ...fullRight].find((card) => card.key === "weather");
  const weatherExpanded = fullWeather != null && !fullWeather.clipped;
  const selectedWeatherAlerts = weatherExpanded ? fullWeatherAlerts : compactWeatherAlerts;
  const selectedCandidates = weatherExpanded
    ? allCandidates
    : allCandidates.map((card) => card.key === "weather"
      ? candidate("weather", card.order, compactWeatherAlerts)
      : card);
  const selectedPlan = weatherExpanded ? fullPlan : makeColumnPlan(selectedCandidates, ladderOverride);
  const selectedLeft = allocateNaturalHeight(selectedPlan.left, selectedPlan.stage);
  const selectedRight = allocateNaturalHeight(selectedPlan.right, selectedPlan.stage);
  const leftCards = selectedLeft.map((card) => ({ ...card, overflowed: selectedPlan.moved.has(card.key) }));
  const rightCards = selectedRight.map((card) => ({ ...card, overflowed: false }));
  const ladderStage = selectedPlan.stage;

</script>

{#snippet renderCard(entry: PlannedCard)}
  {#if entry.key === "tsunami" && tsunami != null}
    <TsunamiStandbyBanner tsunami={tsunami} />
  {:else if entry.key === "quake"}
    <LatestQuakeCard quake={latestQuakeStandbyCards} longPeriod={longPeriod == null ? null : { ...longPeriod.data, restored: longPeriod.restored }} />
  {:else if entry.key === "weather"}
    <WeatherAlertCard alerts={selectedWeatherAlerts} {tornado} />
  {:else if entry.key === "flood" && flood != null}
    <FloodCard item={flood} />
  {:else if entry.key === "typhoon" && typhoon != null}
    <TyphoonCard item={typhoon} displayMode="full" />
  {:else if entry.key === "volcano" && volcano != null}
    <VolcanoCard item={volcano} />
  {:else if entry.key === "heat" && heat != null}
    <HeatAlertCard item={heat} />
  {/if}
{/snippet}

{#snippet renderSideCard(entry: PlannedCard)}
  <article
    class="legacy-card"
    data-mock-card={entry.key}
    data-overflow-placement={entry.overflowed ? "left-bottom" : undefined}
    data-region-expanded={entry.key === "weather" && weatherExpanded ? "true" : undefined}
    data-content-score={entry.score}
    data-natural-height-px={entry.naturalHeight}
    data-allocated-height-px={entry.allocatedHeight}
    data-height-extra-px={entry.extraHeight}
    data-card-clipped={entry.clipped ? "true" : undefined}
    style={`--allocated-height-px: ${entry.allocatedHeight}px;`}
  >
    {@render renderCard(entry)}
  </article>
{/snippet}

<svelte:head><title>Legacy standby improved mock v3</title></svelte:head>

<main
  id="legacy-improved-mock"
  class="legacy-mock ladder-{ladderStage}"
  data-legacy-improved-mock
  data-ladder-stage={ladderStage}
  data-ladder-auto={ladderAuto ? "true" : "false"}
  data-scenario={scenario}
  data-suppressed-unknown-count={unknownInputs.length}
  data-input-item-count={allCandidates.length + unknownInputs.length}
  data-paging="none"
>
  <div class="mock-label">
    <strong>従来フォーマット改良 v3</strong>
    <span>scenario={scenario} · ladder={ladderAuto ? "auto" : ladderStage} · 自然高さ優先</span>
  </div>

  <section class="legacy-layout" aria-label={`従来待機画面 改良案 scenario=${scenario} ladder=${ladderStage}`}>
    <div class="side side-left" data-mock-side="left">
      {#each leftCards as entry (entry.key)}
        {@render renderSideCard(entry)}
      {/each}
    </div>

    {#if ladderStage < 2}
      <section class="center-landmark" aria-label="中央時計と固定情報">
        <div class="clock-wrap"><Clock {now} /></div>
        <div class="clock-below" data-clock-below-stack>
          {#if nankai != null}
            <div class="fixed-nankai" data-fixed-stack-item="nankai"><NankaiBadge item={nankai} /></div>
          {/if}
          <div class="fixed-stats" data-fixed-stack-item="stats"><InstrumentRow stats={statsStandbyCards} /></div>
          <div class="fixed-recent" data-fixed-stack-item="recent-quakes" data-fixed-recent-row-count={fixedRecentRows.length}>
            <RecentQuakes quakes={fixedRecentRows} />
          </div>
        </div>
      </section>
    {:else}
      <section class="center-landmark center-card-region" data-center-card-region aria-label="中央カード領域">
        {#if nankai != null}
          <div class="center-stack-card" data-fixed-stack-item="nankai"><NankaiBadge item={nankai} /></div>
        {/if}
        <div class="center-stack-card" data-fixed-stack-item="stats"><InstrumentRow stats={statsStandbyCards} /></div>
        <div class="center-stack-card center-recent" data-fixed-stack-item="recent-quakes" data-fixed-recent-row-count={fixedRecentRows.length}>
          <RecentQuakes quakes={fixedRecentRows} />
        </div>
      </section>
    {/if}

    <div class="side side-right" data-mock-side="right">
      {#each rightCards as entry (entry.key)}
        {@render renderSideCard(entry)}
      {/each}
    </div>
  </section>

  <footer class="ticker-reserve" aria-label="テロップ領域">
    <span>TELEGRAM</span><span>ページングなし・自然高さ優先</span>
    {#if ladderStage >= 2}
      <div class="ticker-clock" data-clock-placement="ticker-bottom-right"><Clock {now} size="small" /></div>
    {/if}
  </footer>
</main>

<style>
  .legacy-mock {
    --mock-edge: clamp(14px, 2.5vw, 48px);
    --mock-gap: clamp(8px, 1vw, 18px);
    --mock-ticker-h: clamp(52px, 6vh, 68px);
    box-sizing: border-box;
    position: relative;
    width: 100vw;
    height: 100svh;
    min-height: 620px;
    overflow: hidden;
    color: var(--fg);
    background: var(--background-tone-calm);
  }

  .ladder-3 {
    --mock-edge: clamp(10px, 1.8vw, 32px);
    --mock-gap: clamp(4px, 0.6vw, 10px);
    --mock-ticker-h: clamp(48px, 5vh, 60px);
    --space-1: 2px;
    --space-2: 4px;
    --space-3: 6px;
    --space-4: 8px;
    --space-5: 10px;
  }

  .mock-label {
    position: absolute;
    z-index: 20;
    top: clamp(6px, 1vh, 12px);
    left: 50%;
    display: flex;
    gap: 0.8em;
    align-items: baseline;
    padding: 5px 12px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    transform: translateX(-50%);
    white-space: nowrap;
    font-size: clamp(12px, 0.85vw, 14px);
  }

  .mock-label span { color: var(--role-muted); }

  .legacy-layout {
    position: absolute;
    inset: var(--mock-edge) var(--mock-edge) calc(var(--mock-ticker-h) + var(--mock-edge));
    display: grid;
    grid-template-columns: minmax(0, 31fr) minmax(22rem, 38fr) minmax(0, 31fr);
    gap: var(--mock-gap);
    min-height: 0;
  }

  .ladder-2 .legacy-layout,
  .ladder-3 .legacy-layout {
    grid-template-columns: minmax(0, 36fr) minmax(18rem, 28fr) minmax(0, 36fr);
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: var(--mock-gap);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .side-left { align-items: flex-start; }
  .side-right { align-items: flex-end; }

  .legacy-card {
    flex: 0 0 auto;
    width: min(360px, 28vw);
    max-width: 100%;
    height: var(--allocated-height-px);
    min-height: 0;
    overflow: hidden;
  }

  .legacy-card :global(.tsunami-banner),
  .legacy-card :global(.quake-card),
  .legacy-card :global(.weather-card),
  .legacy-card :global(.standby-card) { max-width: 100%; }

  .center-landmark {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 0;
    padding-block: clamp(24px, 6vh, 72px);
    overflow: hidden;
  }

  .clock-wrap { width: 100%; container-type: inline-size; }
  .clock-below {
    display: flex;
    flex-direction: column;
    gap: clamp(5px, 0.7vh, 9px);
    width: min(100%, 36rem);
    margin-top: clamp(12px, 2vh, 24px);
  }

  .fixed-nankai :global(.nankai-badge) { width: 100%; margin: 0; box-sizing: border-box; justify-content: center; }
  .fixed-stats { min-height: clamp(28px, 3.4vh, 40px); display: grid; place-items: center; }
  .fixed-stats :global(.instrument-row) { justify-content: center; }
  .fixed-recent {
    box-sizing: border-box;
    max-height: min(19vh, 170px);
    overflow: hidden;
    padding: clamp(6px, 0.8vh, 10px) clamp(10px, 1vw, 16px);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
  }

  .center-card-region {
    align-items: stretch;
    justify-content: flex-start;
    gap: var(--mock-gap);
    padding: var(--mock-gap);
  }

  .center-stack-card {
    flex: 0 0 auto;
    min-width: 0;
    min-height: clamp(3rem, 8vh, 6rem);
    overflow: hidden;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
  }

  .center-stack-card :global(.nankai-badge) { width: 100%; margin: 0; box-sizing: border-box; justify-content: center; }
  .center-stack-card :global(.instrument-row) { justify-content: center; }
  .center-recent { max-height: 44%; overflow: hidden; }

  .ticker-reserve {
    position: absolute;
    inset: auto 0 0;
    height: var(--mock-ticker-h);
    display: flex;
    align-items: center;
    gap: clamp(16px, 2vw, 36px);
    box-sizing: border-box;
    padding-inline: var(--mock-edge);
    border-top: 1px solid var(--hairline);
    background: var(--surface-high);
    color: var(--role-muted);
    font-size: clamp(12px, 0.9vw, 15px);
  }

  .ticker-reserve span:first-child { color: var(--fg); font-family: var(--font-num); letter-spacing: 0.14em; }
  .ladder-2 .ticker-reserve,
  .ladder-3 .ticker-reserve { padding-right: clamp(12rem, 16vw, 20rem); }
  .ticker-clock {
    position: absolute;
    right: var(--mock-edge);
    top: 50%;
    transform: translateY(-50%);
    text-align: right;
  }
  .ticker-clock :global(.clock) { text-align: right; }
  .ticker-clock :global(.date) { margin-top: 2px; }

  @media (max-aspect-ratio: 8 / 5) {
    .legacy-layout { grid-template-columns: minmax(0, 32fr) minmax(20rem, 36fr) minmax(0, 32fr); }
    .ladder-2 .legacy-layout,
    .ladder-3 .legacy-layout { grid-template-columns: minmax(0, 37fr) minmax(17rem, 26fr) minmax(0, 37fr); }
  }
</style>
