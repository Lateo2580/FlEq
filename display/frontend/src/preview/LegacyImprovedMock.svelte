<script lang="ts">
  import { onMount } from "svelte";
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
    legacyImprovedExpandedLatestQuake,
    legacyImprovedMaxItems,
    legacyImprovedMaxUnknownItems,
    legacyImprovedMaxWeatherAlerts,
    legacyImprovedMaxWeatherAlertsCompact,
    legacyImprovedWeatherAlertsCompact,
    legacyImprovedTornadoFullAreas,
    recentQuakesRich,
    standbyItemsShowcase,
    statsStandbyCards,
    tsunamiBanner,
    weatherWarningOnlyStandbyCards,
  } from "./fixtures";

  type Scenario = "4" | "7" | "max";
  type LadderStage = 0 | 1 | 2 | 3;
  type CardKey = "tsunami" | "quake" | "weather" | "flood" | "typhoon" | "volcano" | "heat";
  type ExpandableCardKey = "quake" | "weather";
  type CardVariant = "compact" | "expanded";
  type FixedMeasureKey = "stats" | "recent-quakes";
  type StandbyItemOf<K extends ActiveStandbyCardV1["kind"]> = Extract<ActiveStandbyCardV1, { kind: K }>;

  interface VariantSelection {
    quake: CardVariant;
    weather: CardVariant;
  }

  interface MeasureEntry {
    id: string;
    key: CardKey;
    variant: CardVariant;
  }

  interface CardCandidate {
    key: CardKey;
    order: number;
    score: number;
    variant: CardVariant;
    naturalHeight: number;
    centerNaturalHeight: number;
  }

  interface PlannedCard extends CardCandidate {
    allocatedHeight: number;
    extraHeight: number;
    clipped: boolean;
    overflowed: boolean;
    placement: "left" | "right" | "center";
  }

  interface ColumnPlan {
    left: CardCandidate[];
    right: CardCandidate[];
    center: CardCandidate[];
    moved: Set<CardKey>;
    unresolved: boolean;
    centerUnresolved: boolean;
    stage: LadderStage;
    variants: VariantSelection;
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

  const scenario = parseScenario(params.get("legacyMock2"));
  const ladderOverride = parseLadder(params.get("ladder"));
  const ladderAuto = ladderOverride == null;
  const now = new Date("2026-08-15T12:34:56+09:00");
  const activeItems = scenario === "max" ? legacyImprovedMaxItems : standbyItemsShowcase;
  const unknownInputs = scenario === "max" ? legacyImprovedMaxUnknownItems : [];
  const tsunami = scenario === "4" ? null : tsunamiBanner;
  const flood = scenario === "4" ? null : findItem(activeItems, "flood");
  const typhoon = scenario === "4" ? null : findItem(activeItems, "typhoon");
  const volcano = findItem(activeItems, "volcano");
  const heat = findItem(activeItems, "heat");
  const tornado = findItem(activeItems, "tornado");
  const tornadoFullAreas = tornado == null
    ? []
    : [...new Set([...legacyImprovedTornadoFullAreas, ...tornado.data.areas])];
  const longPeriod = findItem(activeItems, "longPeriod");
  const nankai = findItem(activeItems, "nankaiTrough");
  const fixedRecentRows = recentQuakesRich.slice(0, scenario === "4" ? 3 : 5);
  const fixedMeasureKeys: FixedMeasureKey[] = ["stats", "recent-quakes"];
  const fullWeatherAlerts: DisplayWeatherAlertV1[] = scenario === "max"
    ? legacyImprovedMaxWeatherAlerts
    : weatherWarningOnlyStandbyCards;
  const compactWeatherAlerts: DisplayWeatherAlertV1[] = scenario === "max"
    ? legacyImprovedMaxWeatherAlertsCompact
    : legacyImprovedWeatherAlertsCompact;

  const cardKeys: CardKey[] = [];
  if (tsunami != null) cardKeys.push("tsunami");
  cardKeys.push("quake", "weather");
  if (flood != null) cardKeys.push("flood");
  if (typhoon != null) cardKeys.push("typhoon");
  if (volcano != null) cardKeys.push("volcano");
  if (heat != null) cardKeys.push("heat");

  const measureEntries: MeasureEntry[] = [];
  for (const key of cardKeys) {
    if (key === "quake" || key === "weather") {
      measureEntries.push({ id: `${key}:compact`, key, variant: "compact" });
      measureEntries.push({ id: `${key}:expanded`, key, variant: "expanded" });
    } else {
      measureEntries.push({ id: key, key, variant: "compact" });
    }
  }

  // 1 パス目の同期 layout read 用。測定棚は visibility:hidden だが display:none ではないため、
  // 実ブラウザの offsetHeight を取得できる。rAF/ResizeObserver の遅延には依存しない。
  const measureNodes = new Map<string, HTMLElement>();
  const centerMeasureNodes = new Map<FixedMeasureKey, HTMLElement>();
  const centerCardMeasureNodes = new Map<string, HTMLElement>();
  let layoutEl = $state<HTMLElement | null>(null);
  let sideEl = $state<HTMLElement | null>(null);
  let clockWrapEl = $state<HTMLElement | null>(null);
  let nankaiBandEl = $state<HTMLElement | null>(null);
  let tickerEl = $state<HTMLElement | null>(null);
  let measuredHeights = $state<Record<string, number>>({});
  let measuredCenterHeights = $state<Record<string, number>>({});
  let measuredFixedHeights = $state<Record<string, number>>({});
  let measuredNankaiHeightPx = $state(0);
  let measuredClusterGapPx = $state(0);
  let measuredClusterFlowHeightPx = $state(0);
  let measuredLayoutHeightPx = $state(0);
  let measuredLayoutWidthPx = $state(0);
  let measuredCardWidthPx = $state(0);
  let measuredGapPx = $state(0);
  let measurementComplete = $state(false);
  let measurementReadCount = $state(0);

  function captureMeasure(node: HTMLElement, id: string): { destroy: () => void } {
    measureNodes.set(id, node);
    return {
      destroy: () => measureNodes.delete(id),
    };
  }

  function captureCenterMeasure(node: HTMLElement, key: FixedMeasureKey): { destroy: () => void } {
    centerMeasureNodes.set(key, node);
    return {
      destroy: () => centerMeasureNodes.delete(key),
    };
  }

  function captureCenterCardMeasure(node: HTMLElement, id: string): { destroy: () => void } {
    centerCardMeasureNodes.set(id, node);
    return {
      destroy: () => centerCardMeasureNodes.delete(id),
    };
  }

  function measureNaturalHeight(node: HTMLElement | undefined): number {
    if (node == null) return 0;
    const child = node.firstElementChild as HTMLElement | null;
    // offsetHeight はカードの実表示高 (main 側 max-height を含む) を優先する。jsdom の 0 だけ
    // scrollHeight へフォールバックし、テストでも測定経路自体は成立させる。
    const offsetHeight = Math.max(node.offsetHeight, child?.offsetHeight ?? 0);
    if (offsetHeight > 0) return Math.round(offsetHeight);
    return Math.round(Math.max(node.scrollHeight, child?.scrollHeight ?? 0));
  }

  onMount(() => {
    const nextHeights: Record<string, number> = {};
    const nextCenterHeights: Record<string, number> = {};
    const nextFixedHeights: Record<string, number> = {};
    for (const entry of measureEntries) {
      nextHeights[entry.id] = measureNaturalHeight(measureNodes.get(entry.id));
      nextCenterHeights[entry.id] = measureNaturalHeight(centerCardMeasureNodes.get(entry.id));
    }
    for (const key of fixedMeasureKeys) {
      nextFixedHeights[key] = measureNaturalHeight(centerMeasureNodes.get(key));
    }
    const nankaiHeight = measureNaturalHeight(nankaiBandEl ?? undefined);
    const clockRect = (clockWrapEl?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    const boundaryRect = (nankaiBandEl ?? tickerEl)?.getBoundingClientRect();
    const lowerSpace = clockRect == null || boundaryRect == null
      ? 0
      : Math.round(boundaryRect.top - clockRect.bottom
        - (nextFixedHeights.stats ?? 0)
        - (nextFixedHeights["recent-quakes"] ?? 0));
    const clusterGap = lowerSpace > 0 ? Math.floor(lowerSpace / 3) : 0;
    const clusterFlowHeight = clusterGap > 0 ? lowerSpace - clusterGap * 2 : 0;
    const layoutRect = layoutEl?.getBoundingClientRect();
    const layoutHeight = Math.round(layoutRect?.height ?? layoutEl?.offsetHeight ?? 0);
    const layoutWidth = Math.round(layoutRect?.width ?? layoutEl?.offsetWidth ?? 0);
    const cardWidth = Math.round(layoutEl?.querySelector<HTMLElement>("[data-mock-side='left'] [data-mock-card]")?.getBoundingClientRect().width ?? 0);
    const computedGap = sideEl == null ? 0 : parseFloat(getComputedStyle(sideEl).rowGap);
    measuredHeights = nextHeights;
    measuredCenterHeights = nextCenterHeights;
    measuredFixedHeights = nextFixedHeights;
    measuredNankaiHeightPx = nankaiHeight;
    measuredClusterGapPx = clusterGap;
    measuredClusterFlowHeightPx = clusterFlowHeight;
    measuredLayoutHeightPx = layoutHeight;
    measuredLayoutWidthPx = layoutWidth;
    measuredCardWidthPx = cardWidth;
    measuredGapPx = Number.isFinite(computedGap) ? computedGap : 0;
    measurementReadCount = measureEntries.length * 2 + fixedMeasureKeys.length + (nankai == null ? 0 : 1);
    measurementComplete = true;
  });

  function measureId(key: CardKey, variant: CardVariant): string {
    return key === "quake" || key === "weather" ? `${key}:${variant}` : key;
  }

  function measuredHeight(key: CardKey, variant: CardVariant, placement: "side" | "center" = "side"): number {
    const id = measureId(key, variant);
    return (placement === "center" ? measuredCenterHeights[id] : measuredHeights[id]) ?? 0;
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

  function layoutCapacityPx(): number {
    // 0 は jsdom の「矩形なし」を意味する。ブラウザでは必ず実測値を使い、テストだけ無限予算で
    // カードを消さずに自然 DOM を残す。
    if (measuredLayoutHeightPx <= 0) return Number.POSITIVE_INFINITY;
    // 南海帯は ticker 直上で画面下端を専有する。初回 layout の実測高からその実測高を引き、
    // 左右列・中央受け皿の共通容量を同じ空間に揃える。
    return Math.max(0, measuredLayoutHeightPx - measuredNankaiHeightPx);
  }

  function columnGapPx(): number {
    return measuredGapPx;
  }

  function centerFixedNaturalHeight(): number {
    const heights = fixedMeasureKeys.map((key) => measuredFixedHeights[key] ?? 0);
    return heights.reduce((total, height) => total + height, 0)
      + Math.max(0, heights.length - 1) * columnGapPx();
  }

  function centerNaturalHeight(cards: readonly CardCandidate[]): number {
    const fixedHeights = fixedMeasureKeys.map((key) => measuredFixedHeights[key] ?? 0);
    const totalCount = cards.length + fixedHeights.length;
    return cards.reduce((total, card) => total + card.centerNaturalHeight, 0)
      + fixedHeights.reduce((total, height) => total + height, 0)
      + Math.max(0, totalCount - 1) * columnGapPx();
  }

  function centerCapacityPx(): number {
    return layoutCapacityPx();
  }

  function columnNaturalHeight(cards: readonly CardCandidate[]): number {
    return cards.reduce((total, card) => total + card.naturalHeight, 0)
      + Math.max(0, cards.length - 1) * columnGapPx();
  }

  function buildCandidates(variants: VariantSelection): CardCandidate[] {
    return cardKeys.map((key, order) => {
      const variant = key === "quake"
        ? variants.quake
        : key === "weather"
          ? variants.weather
          : "compact";
      return {
        key,
        order,
        score: contentScore(key),
        variant,
        naturalHeight: measuredHeight(key, variant),
        centerNaturalHeight: measuredHeight(key, variant, "center"),
      };
    });
  }

  const leftKeys = new Set<CardKey>(["tsunami", "quake"]);
  const rightKeys = new Set<CardKey>(["weather", "flood", "typhoon", "volcano", "heat"]);
  const centerEligibleKeys = new Set<CardKey>(["weather", "flood", "typhoon", "volcano"]);
  const forcedOverflowKeys = new Set<CardKey>(["volcano", "heat"]);

  function moveIneligibleToLeft(
    right: CardCandidate[],
    left: CardCandidate[],
    capacity: number,
    moved: Set<CardKey>,
  ): void {
    while (columnNaturalHeight(right) > capacity) {
      const toLeft = right
        .filter((card) => !centerEligibleKeys.has(card.key))
        .sort((leftCard, rightCard) => rightCard.naturalHeight - leftCard.naturalHeight || leftCard.order - rightCard.order)
        .find((card) => columnNaturalHeight([...left, card]) <= capacity);
      if (toLeft == null) break;
      right.splice(right.indexOf(toLeft), 1);
      left.push(toLeft);
      moved.add(toLeft.key);
    }
  }

  function moveEligibleToCenter(cards: CardCandidate[], center: CardCandidate[], capacity: number): void {
    const movedCards: CardCandidate[] = [];
    while (columnNaturalHeight(cards) > capacity) {
      const toCenter = cards
        .filter((card) => centerEligibleKeys.has(card.key))
        .sort((leftCard, rightCard) => rightCard.naturalHeight - leftCard.naturalHeight || leftCard.order - rightCard.order)
        .find((card) => centerNaturalHeight([...center, card]) <= capacity);
      if (toCenter == null) break;
      cards.splice(cards.indexOf(toCenter), 1);
      movedCards.push(toCenter);
      center.push(toCenter);
    }
    movedCards.sort((leftCard, rightCard) => leftCard.order - rightCard.order);
    center.sort((leftCard, rightCard) => leftCard.order - rightCard.order);
  }

  function makeColumnPlan(candidates: readonly CardCandidate[], override: LadderStage | null): Omit<ColumnPlan, "variants"> {
    let left = candidates.filter((card) => leftKeys.has(card.key));
    let right = candidates.filter((card) => rightKeys.has(card.key));
    const center: CardCandidate[] = [];
    const moved = new Set<CardKey>();
    const capacity = layoutCapacityPx();

    if (override != null && override >= 1) {
      for (const key of forcedOverflowKeys) {
        const card = right.find((candidate) => candidate.key === key);
        if (card == null) continue;
        right = right.filter((candidate) => candidate.key !== key);
        left = [...left, card];
        moved.add(key);
      }
    }

    const rightNeedsCenter = override == null || (override != null && override >= 2);
    if (rightNeedsCenter) {
      // 右列の超過は、まず左に収まる非資格カードを退避し、残りを中央資格カードで受ける。
      // どちらも実測容量に収まらない場合だけ unresolved として圧縮段へ送る。
      moveIneligibleToLeft(right, left, capacity, moved);
      moveEligibleToCenter(right, center, capacity);
    }

    // 明示 ladder=2/3 は目視ゲート用の「中央受け皿」も必ず見せる。実測で左右の超過が
    // 無い jsdom でも、資格を持つ右列の続き (なければ左列の続き) を中央へ移して構造を確認できる。
    if (override != null && override >= 2 && center.length === 0) {
      const rightContinuation = [...right].reverse().find((card) => centerEligibleKeys.has(card.key));
      if (rightContinuation != null) {
        right = right.filter((card) => card.key !== rightContinuation.key);
        center.push(rightContinuation);
      }
    }

    const centerUnresolved = centerNaturalHeight(center) > centerCapacityPx();
    const sideUnresolved = columnNaturalHeight(left) > capacity || columnNaturalHeight(right) > capacity;
    const requestedStage: LadderStage = override
      ?? (center.length > 0 ? (centerUnresolved || sideUnresolved ? 3 : 2) : sideUnresolved ? 3 : moved.size > 0 ? 1 : 0);
    const stage: LadderStage = requestedStage === 2 && (centerUnresolved || sideUnresolved) ? 3 : requestedStage;
    return {
      left,
      right,
      center,
      moved,
      unresolved: sideUnresolved || centerUnresolved,
      centerUnresolved,
      stage,
    };
  }

  function columnFor(plan: Omit<ColumnPlan, "variants">, key: CardKey): CardCandidate[] | null {
    if (plan.left.some((card) => card.key === key)) return plan.left;
    if (plan.right.some((card) => card.key === key)) return plan.right;
    return plan.center.some((card) => card.key === key) ? plan.center : null;
  }

  function chooseVariants(): VariantSelection {
    const selected: VariantSelection = { quake: "compact", weather: "compact" };
    if (!measurementComplete) return selected;
    const expandable: ExpandableCardKey[] = ["quake", "weather"];
    for (const key of expandable) {
      const trial: VariantSelection = { ...selected, [key]: "expanded" };
      const trialPlan = makeColumnPlan(buildCandidates(trial), ladderOverride);
      const column = columnFor(trialPlan, key);
      // 展開版が中央へ追い出される、または所属列の実測自然高を超える場合は集約版を使う。
      if (column != null && column !== trialPlan.center && columnNaturalHeight(column) <= layoutCapacityPx()) {
        selected[key] = "expanded";
      }
    }
    return selected;
  }

  const layoutPlan = $derived.by(() => {
    const variants = chooseVariants();
    return { ...makeColumnPlan(buildCandidates(variants), ladderOverride), variants };
  });

  const clusterGapStyle = $derived(
    measuredClusterGapPx > 0
      ? `${measuredClusterGapPx}px`
      : layoutPlan.stage >= 3
        ? "calc(var(--mock-gap) * 1.25)"
        : "calc(var(--mock-gap) * 1.75)",
  );
  const clusterFlowHeightStyle = $derived(measuredClusterFlowHeightPx > 0 ? `${measuredClusterFlowHeightPx}px` : "auto");
  const centerNaturalHeightPx = $derived(centerNaturalHeight(layoutPlan.center));

  function plannedCards(
    cards: readonly CardCandidate[],
    placement: "left" | "right" | "center",
    moved: ReadonlySet<CardKey>,
  ): PlannedCard[] {
    return cards.map((card) => {
      const naturalHeight = placement === "center" ? card.centerNaturalHeight : card.naturalHeight;
      return {
        ...card,
        naturalHeight,
        allocatedHeight: naturalHeight,
        extraHeight: 0,
        clipped: false,
        overflowed: placement === "center" || moved.has(card.key),
        placement,
      };
    });
  }

  const leftCards = $derived(plannedCards(layoutPlan.left, "left", layoutPlan.moved));
  const rightCards = $derived(plannedCards(layoutPlan.right, "right", layoutPlan.moved));
  const centerCards = $derived(plannedCards(layoutPlan.center, "center", layoutPlan.moved));

  function isExpanded(entry: PlannedCard): boolean {
    return (entry.key === "quake" || entry.key === "weather") && entry.variant === "expanded";
  }
</script>

{#snippet renderCard(key: CardKey, variant: CardVariant)}
  {#if key === "tsunami" && tsunami != null}
    <TsunamiStandbyBanner tsunami={tsunami} />
  {:else if key === "quake"}
    <LatestQuakeCard
      quake={variant === "expanded" ? legacyImprovedExpandedLatestQuake : latestQuakeStandbyCards}
      longPeriod={longPeriod == null ? null : { ...longPeriod.data, restored: longPeriod.restored }}
    />
  {:else if key === "weather"}
    <div class="mock-weather-shell" data-weather-two-column="true">
      <WeatherAlertCard alerts={variant === "expanded" ? fullWeatherAlerts : compactWeatherAlerts} tornado={null} />
      {#if tornado != null}
        <div class:sighted={tornado.data.isSighted} class="mock-tornado-rider" data-tornado-full>
          ⚠ {tornado.data.isSighted ? "竜巻目撃情報" : "竜巻注意情報"}（{#each tornadoFullAreas as area, index}{#if index > 0}、{/if}{area}{/each}）
        </div>
      {/if}
    </div>
  {:else if key === "flood" && flood != null}
    <FloodCard item={flood} />
  {:else if key === "typhoon" && typhoon != null}
    <TyphoonCard item={typhoon} displayMode="full" />
  {:else if key === "volcano" && volcano != null}
    <VolcanoCard item={volcano} />
  {:else if key === "heat" && heat != null}
    <HeatAlertCard item={heat} />
  {/if}
{/snippet}

{#snippet renderSideCard(entry: PlannedCard)}
  <article
    class="legacy-card"
    data-mock-card={entry.key}
    data-overflow-placement={entry.placement === "center" ? "center" : entry.overflowed ? "left-bottom" : undefined}
    data-center-eligible={centerEligibleKeys.has(entry.key) ? "true" : "false"}
    data-region-expanded={isExpanded(entry) ? "true" : undefined}
    data-content-score={entry.score}
    data-natural-height-px={entry.naturalHeight}
    data-allocated-height-px={entry.allocatedHeight}
    data-height-extra-px={entry.extraHeight}
    data-card-clipped={entry.clipped ? "true" : undefined}
  >
    {@render renderCard(entry.key, entry.variant)}
  </article>
{/snippet}

<svelte:head><title>Legacy standby improved mock v10</title></svelte:head>

<main
  id="legacy-improved-mock"
  class="legacy-mock ladder-{layoutPlan.stage}"
  style={`--mock-nankai-reserve: ${measuredNankaiHeightPx}px; --mock-cluster-gap: ${clusterGapStyle}; --mock-cluster-flow-height: ${clusterFlowHeightStyle};`}
  data-legacy-improved-mock
  data-ladder-stage={layoutPlan.stage}
  data-ladder-auto={ladderAuto ? "true" : "false"}
  data-scenario={scenario}
  data-suppressed-unknown-count={unknownInputs.length}
  data-input-item-count={cardKeys.length + unknownInputs.length}
  data-measurement-mode={measurementComplete ? "sync-dom" : "pending"}
  data-measurement-pass={measurementComplete ? "2" : "1"}
  data-measurement-read-count={measurementReadCount}
  data-layout-height-px={measuredLayoutHeightPx}
  data-layout-capacity-px={layoutCapacityPx()}
  data-layout-width-px={measuredLayoutWidthPx}
  data-card-width-px={measuredCardWidthPx}
  data-nankai-height-px={measuredNankaiHeightPx}
  data-cluster-gap-px={measuredClusterGapPx}
  data-cluster-flow-height-px={measuredClusterFlowHeightPx}
  data-center-gap-px={columnGapPx()}
  data-center-natural-height-px={centerNaturalHeightPx}
  data-center-eligible-keys="weather,flood,typhoon,volcano"
  data-clock-mode={layoutPlan.stage < 2 ? "viewport-center" : "ticker-bottom-right"}
  data-center-fixed-height-px={centerFixedNaturalHeight()}
  data-center-capacity-px={centerCapacityPx()}
  data-center-unresolved={layoutPlan.centerUnresolved ? "true" : "false"}
  data-layout-unresolved={layoutPlan.unresolved ? "true" : "false"}
  data-paging="none"
>
  <div class="mock-label">
    <strong>従来フォーマット改良 v10</strong>
    <span>scenario={scenario} · ladder={ladderAuto ? "auto" : layoutPlan.stage} · 実測 2 パス</span>
  </div>

  <div class="measure-shelf" aria-hidden="true" inert>
    {#each measureEntries as entry (entry.id)}
      <div class="measure-item" data-measure-card={entry.id} use:captureMeasure={entry.id}>
        {@render renderCard(entry.key, entry.variant)}
      </div>
    {/each}
  </div>

  {#if layoutPlan.stage < 2}
    <section class="clock-landmark" data-clock-landmark aria-label="画面中央時計と中央クラスタ">
      <div class="clock-wrap" bind:this={clockWrapEl}>
        <Clock {now} />
        <div class="clock-below" data-clock-below-stack>
          <div class="fixed-stats" data-fixed-stack-item="stats"><InstrumentRow stats={statsStandbyCards} /></div>
          <div class="fixed-recent" data-fixed-stack-item="recent-quakes" data-fixed-recent-row-count={fixedRecentRows.length}>
            <RecentQuakes quakes={fixedRecentRows} />
          </div>
        </div>
      </div>
    </section>
  {/if}

  <div class="center-measure-shelf" aria-hidden="true" inert>
    {#each measureEntries as entry (entry.id)}
      <div class="measure-item center-measure-item" data-center-measure-card={entry.id} use:captureCenterCardMeasure={entry.id}>
        {@render renderCard(entry.key, entry.variant)}
      </div>
    {/each}
    <div class="center-stack-card center-measure-item" data-center-measure="stats" use:captureCenterMeasure={"stats"}>
      <InstrumentRow stats={statsStandbyCards} />
    </div>
    <div class="center-stack-card center-recent center-measure-item" data-center-measure="recent-quakes" use:captureCenterMeasure={"recent-quakes"}>
      <RecentQuakes quakes={fixedRecentRows} />
    </div>
  </div>

  <section
    class="legacy-layout"
    bind:this={layoutEl}
    aria-label={`従来待機画面 改良案 scenario=${scenario} ladder=${layoutPlan.stage}`}
  >
    <div class="side side-left" data-mock-side="left" bind:this={sideEl}>
      {#each leftCards as entry (entry.key)}
        {@render renderSideCard(entry)}
      {/each}
    </div>

    {#if layoutPlan.stage < 2}
      <div class="center-grid-spacer" aria-hidden="true"></div>
    {:else}
      <section class="center-landmark center-card-region" data-center-card-region data-mock-side="center" aria-label="中央カード領域">
        {#each centerCards as entry (entry.key)}
          {@render renderSideCard(entry)}
        {/each}
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

  {#if nankai != null}
    <div class="nankai-ticker" data-nankai-ticker data-fixed-stack-item="nankai" bind:this={nankaiBandEl}>
      <NankaiBadge item={nankai} />
    </div>
  {/if}

  <footer class="ticker-reserve" aria-label="テロップ領域" bind:this={tickerEl}>
    <span>TELEGRAM</span><span>ページングなし・実 DOM 自然高さ優先</span>
    {#if layoutPlan.stage >= 2}
      <div class="ticker-clock" data-clock-placement="ticker-bottom-right"><Clock {now} size="small" /></div>
    {/if}
  </footer>
</main>

<style>
  .legacy-mock {
    --mock-edge: clamp(14px, 2.5vw, 48px);
    --mock-gap: clamp(8px, 1vw, 18px);
    --mock-cluster-gap: calc(var(--mock-gap) * 1.75);
    --mock-cluster-flow-height: auto;
    --mock-ticker-h: clamp(52px, 6vh, 68px);
    --mock-nankai-reserve: 0px;
    --center-cluster-width: min(36rem, 60vw);
    /* 左右の等幅 track に収めるカード幅。中央クラスタの余地を先に確保し、
       余った左右幅で同じ値を算出する。測定棚もこの値を使う。 */
    --mock-card-width: min(30rem, calc((100vw - var(--mock-edge) - var(--mock-edge) - var(--mock-gap) - var(--mock-gap) - var(--center-cluster-width)) / 2));
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
    --mock-cluster-gap: calc(var(--mock-gap) * 1.25);
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

  .measure-shelf {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    width: var(--mock-card-width);
    visibility: hidden;
    pointer-events: none;
  }

  .measure-item {
    flex: 0 0 auto;
    width: 100%;
  }

  .legacy-mock .measure-item :global(.tsunami-banner),
  .legacy-mock .measure-item :global(.quake-card),
  .legacy-mock .measure-item :global(.weather-card),
  .legacy-mock .measure-item :global(.standby-card) {
    width: 100%;
  }

  .center-measure-shelf {
    position: absolute;
    top: 0;
    left: 50%;
    display: flex;
    flex-direction: column;
    gap: var(--mock-gap);
    width: var(--center-cluster-width);
    visibility: hidden;
    pointer-events: none;
    transform: translateX(-50%);
  }

  .center-measure-item {
    flex: 0 0 auto;
    width: 100%;
  }

  .legacy-layout {
    position: absolute;
    inset: var(--mock-edge) var(--mock-edge) calc(var(--mock-ticker-h) + var(--mock-edge) + var(--mock-nankai-reserve));
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--center-cluster-width) minmax(0, 1fr);
    gap: var(--mock-gap);
    min-height: 0;
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: var(--mock-gap);
    min-width: 0;
    min-height: 0;
    overflow: auto;
    scrollbar-width: thin;
  }

  .side-left,
  .side-right { align-items: center; }

  .legacy-card {
    flex: 0 0 auto;
    width: var(--mock-card-width);
    max-width: 100%;
    min-height: 0;
    overflow: visible;
  }

  .legacy-card[data-mock-card="tsunami"] {
    overflow: hidden;
  }

  .legacy-mock .legacy-card :global(.tsunami-banner),
  .legacy-mock .legacy-card :global(.quake-card),
  .legacy-mock .legacy-card :global(.weather-card),
  .legacy-mock .legacy-card :global(.standby-card) {
    width: 100%;
  }

  /* marquee の absolute 配置はカード外の positioned ancestor を基準に走るため、
     overflow clip では閉じ込められない (v11 実測)。モックは静止画評価なので
     in-flow 静止化で banner-areas 内に収める。実表示の走行は本実装側で扱う。 */
  .legacy-mock .legacy-card :global(.marquee-text) {
    position: static;
    white-space: nowrap;
    animation-name: none;
  }

  /* TsunamiStandbyBanner の走行文字を、モック側でもカード外へ出さない。component は無改造のまま、
     バナー本体と marquee の containing block の両方をカード幅で clip する。 */
  .legacy-mock .legacy-card :global(.tsunami-banner) {
    max-width: 100%;
    overflow: hidden;
  }

  .legacy-mock .legacy-card :global(.tsunami-banner .banner-areas) {
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
  }

  /* WeatherAlertCard の本体は無改造のまま、モックだけ外殻と展開行を足す。県名と地域の
     対応を崩さないよう、列は pref-group 単位で分割を止める。 */
  .mock-weather-shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    box-shadow: var(--elevation-2);
    background: var(--surface-standby);
    color: var(--fg);
  }

  .legacy-mock .mock-weather-shell :global(.weather-card) {
    width: 100%;
    max-height: none;
    height: auto;
    overflow: visible;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .legacy-mock .mock-weather-shell :global(.weather-card.clipped) {
    height: auto;
  }

  .legacy-mock .mock-weather-shell :global(.weather-card > ul) {
    column-count: 2;
    column-gap: var(--mock-gap);
    column-fill: balance;
  }

  .legacy-mock .mock-weather-shell :global(.weather-card > ul > li) {
    display: block;
    break-inside: auto;
  }

  .legacy-mock .mock-weather-shell :global(.weather-card > ul .pref-group) {
    break-inside: avoid;
  }

  .mock-tornado-rider {
    flex: 0 0 auto;
    border-top: 1px solid var(--hairline);
    padding: var(--space-2) var(--space-4);
    color: var(--role-weatherWarning);
    font-size: max(14px, var(--type-label-l-fluid));
    font-weight: var(--type-body-weight-emphasized);
  }

  .mock-tornado-rider.sighted {
    color: var(--role-weatherEmergency);
    background: color-mix(in srgb, var(--role-weatherEmergency) 10%, var(--surface-standby));
  }

  .center-landmark {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 0;
    padding-block: clamp(24px, 6vh, 72px);
    overflow: visible;
  }

  .clock-landmark {
    position: absolute;
    inset: 0;
    z-index: 10;
    overflow: visible;
    pointer-events: none;
  }

  .clock-wrap {
    position: absolute;
    top: 50%;
    left: 50%;
    width: var(--center-cluster-width);
    min-width: 0;
    container-type: inline-size;
    overflow: visible;
    transform: translate(-50%, -50%);
  }

  /* Clock 直下だけに当てる: RecentQuakes の .time/.date を巻き込まない */
  .legacy-mock .clock-wrap > :global(.clock > .time) {
    width: 100%;
    white-space: nowrap;
    font-size: clamp(72px, 16cqw, 160px);
  }

  .legacy-mock .clock-wrap > :global(.clock > .time .sec) {
    font-size: 0.35em;
  }

  .legacy-mock .clock-wrap > :global(.clock > .date) {
    font-size: clamp(16px, 3.7cqw, 26px);
    margin-top: clamp(4px, 1.5cqw, 10px);
  }

  .ticker-clock :global(.time) { white-space: nowrap; }

  .clock-below {
    position: absolute;
    top: calc(100% + var(--mock-cluster-gap));
    left: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--mock-cluster-gap);
    height: var(--mock-cluster-flow-height);
    width: 100%;
  }

  .center-grid-spacer {
    min-width: 0;
    min-height: 0;
  }

  /* 時計クラスタは viewport 中央の時計を基準に上下へ沿わせる。中央固定情報は side
     カードとは別規格の 36rem 級幅を保ち、最近地震の一行を優先する。 */
  .fixed-stats,
  .fixed-recent,
  .center-stack-card {
    width: 100%;
    box-sizing: border-box;
  }

  /* 南海帯は時計クラスタから切り離し、ticker の上辺へ直接接地させる。実測した高さを
     --mock-nankai-reserve に戻して legacy-layout の下端から同じ分だけ退避する。 */
  .nankai-ticker {
    position: absolute;
    z-index: 12;
    right: var(--mock-edge);
    bottom: var(--mock-ticker-h);
    left: var(--mock-edge);
  }

  .nankai-ticker :global(.nankai-badge) {
    display: flex;
    width: 100%;
    margin: 0;
    box-sizing: border-box;
    justify-content: center;
  }

  .fixed-stats {
    min-height: clamp(28px, 3.4vh, 40px);
    display: grid;
    place-items: center;
  }

  .fixed-stats :global(.instrument-row) { justify-content: center; }

  .fixed-recent {
    max-height: none;
    overflow: visible;
    padding: clamp(6px, 0.8vh, 10px) clamp(10px, 1vw, 16px);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
  }

  .fixed-recent :global(.hypocenter),
  .center-recent :global(.hypocenter) {
    min-width: 0;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .fixed-recent :global(.row),
  .center-recent :global(.row) {
    flex-wrap: wrap;
    row-gap: var(--space-1);
  }

  .fixed-recent :global(.stats),
  .center-recent :global(.stats) {
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: 100%;
  }

  .center-card-region {
    align-items: stretch;
    justify-content: safe center;
    gap: var(--mock-gap);
    padding-block: 0;
    overflow: auto;
  }

  .center-card-region > .legacy-card {
    align-self: center;
    width: var(--center-cluster-width);
    max-width: 100%;
  }

  .center-card-region > .center-stack-card {
    align-self: center;
  }

  .center-stack-card {
    flex: 0 0 auto;
    min-width: 0;
    min-height: 0;
    overflow: visible;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
  }

  .center-stack-card :global(.instrument-row) { justify-content: center; }
  .center-recent { max-height: none; overflow: visible; }

  .ticker-reserve {
    position: absolute;
    inset: auto 0 0;
    height: var(--mock-ticker-h);
    display: flex;
    align-items: center;
    gap: var(--mock-gap);
    box-sizing: border-box;
    padding-inline: var(--mock-edge);
    border-top: 1px solid var(--hairline);
    background: var(--surface-high);
    color: var(--role-muted);
    font-size: clamp(12px, 0.9vw, 15px);
  }

  .ticker-reserve span:first-child {
    color: var(--fg);
    font-family: var(--font-num);
    letter-spacing: 0.14em;
  }

  .ladder-2 .ticker-reserve,
  .ladder-3 .ticker-reserve { padding-right: clamp(12rem, 16vw, 20rem); }

  .ticker-clock {
    position: absolute;
    right: var(--mock-edge);
    top: 50%;
    transform: translateY(-50%);
    text-align: right;
    white-space: nowrap;
  }

  .ticker-clock :global(.clock) { text-align: right; }
  .ticker-clock :global(.date) { margin-top: 2px; }
</style>
