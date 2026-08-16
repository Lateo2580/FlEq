<script lang="ts">
  import { onMount, tick } from "svelte";
  import Clock from "../components/Clock.svelte";
  import FloodCard from "../components/FloodCard.svelte";
  import FloodWideCard from "../components/FloodWideCard.svelte";
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
    standbyItemsFloodWide,
    statsStandbyCards,
    tsunamiBanner,
    weatherWarningOnlyStandbyCards,
  } from "./fixtures";

  type Scenario = "4" | "7" | "max";
  type LadderStage = 0 | 1 | 2 | 3;
  type CardKey = "tsunami" | "quake" | "weather" | "flood" | "typhoon" | "volcano" | "heat";
  type ExpandableCardKey = "quake" | "weather";
  type CardVariant = "compact" | "expanded" | "full";
  type TyphoonVariant = "compact" | "full";
  type FixedMeasureKey = "stats" | "recent-quakes";
  type StandbyItemOf<K extends ActiveStandbyCardV1["kind"]> = Extract<ActiveStandbyCardV1, { kind: K }>;

  interface VariantSelection {
    quake: CardVariant;
    weather: CardVariant;
    typhoon: TyphoonVariant;
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

  interface PlacementChoice {
    left: CardCandidate[];
    right: CardCandidate[];
    center: CardCandidate[];
    moved: Set<CardKey>;
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
    rotationKeys: CardKey[];
    rotationCurrentKey: CardKey | null;
    rotationSlotHeight: number;
    rotationFailureCount: number;
    layoutFailure: boolean;
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
  const rotationTickParam = params.get("rotationTick");
  const rotationTickOverride = rotationTickParam == null || !/^\d+$/.test(rotationTickParam)
    ? null
    : Number.parseInt(rotationTickParam, 10);
  const MAX_SETTLE_PASSES = 4;
  const MAX_ROTATION_CANDIDATE_PASSES = 5;
  const ROTATION_PERIOD_MS = 15_000;
  const ROTATION_TRANSITION_DEADLINE_MS = 500;
  let settleFloorStage = $state<LadderStage>(ladderOverride ?? 0);
  const now = new Date("2026-08-15T12:34:56+09:00");
  const wideFloodRequested = params.get("flood") === "wide" || params.get("floodWide") === "1";
  const baseActiveItems = scenario === "max" ? legacyImprovedMaxItems : standbyItemsShowcase;
  const wideFloodItem = findItem(standbyItemsFloodWide, "flood");
  const activeItems = wideFloodRequested && scenario !== "4" && wideFloodItem != null
    ? [...baseActiveItems.filter((item) => item.kind !== "flood"), wideFloodItem]
    : baseActiveItems;
  const unknownInputs = scenario === "max" ? legacyImprovedMaxUnknownItems : [];
  const tsunami = scenario === "4" ? null : tsunamiBanner;
  const flood = scenario === "4" ? null : findItem(activeItems, "flood");
  const floodIsWide = flood?.surface === "clock-top-wide";
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
    } else if (key === "typhoon") {
      measureEntries.push({ id: `${key}:compact`, key, variant: "compact" });
      measureEntries.push({ id: `${key}:full`, key, variant: "full" });
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
  let measuredBaseLayoutHeightPx = $state(0);
  let measuredLayoutHeightPx = $state(0);
  let measuredLayoutWidthPx = $state(0);
  let measuredCardWidthPx = $state(0);
  let measuredGapPx = $state(0);
  let measuredColumnPaddingPx = $state(0);
  let measuredTickerHeightPx = $state(0);
  let measuredRotationFailureHeightPx = $state(0);
  let measurementComplete = $state(false);
  let measurementReadCount = $state(0);
  let measurementPass = $state(0);
  let measurementSettled = $state(false);
  let measurementNonConverged = $state(false);
  let rotationFailureMeasureEl = $state<HTMLElement | null>(null);
  let rotationSlotEl = $state<HTMLElement | null>(null);
  let rotationActiveKey = $state<CardKey | null>(null);
  let rotationSchedulerStage: LadderStage | null = null;
  let rotationSchedulerKeys: CardKey[] = [];
  let rotationEnteredAtMs = 0;
  let rotationProcessedTick = 0;
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;
  let rotationTransition: Animation | null = null;
  let rotationTransitionDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let rotationTransitionToken = 0;
  let rotationEpochBusy = false;
  let rotationTickPending = false;
  let rotationSchedulerSuspended = false;
  let rotationSchedulerMounted = false;
  let measurementDisposed = false;
  let monotonicOriginPerformanceMs: number | null = null;
  let monotonicOriginDateMs: number | null = null;
  let monotonicLastMs = 0;

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
    // offsetHeight と scrollHeight の大きい方を採る。main 側の max-height/overflow が
    // 残っていても、自然高さを表示高だけで過小評価して切れを招かない。
    return Math.round(Math.max(
      node.offsetHeight,
      node.scrollHeight,
      child?.offsetHeight ?? 0,
      child?.scrollHeight ?? 0,
    ));
  }

  function monotonicNowMs(): number {
    const performanceNow = typeof performance !== "undefined" ? performance.now() : Number.NaN;
    const dateNow = Date.now();
    monotonicOriginPerformanceMs ??= Number.isFinite(performanceNow) ? performanceNow : 0;
    monotonicOriginDateMs ??= dateNow;
    const performanceDelta = Number.isFinite(performanceNow) ? performanceNow - monotonicOriginPerformanceMs : 0;
    const dateDelta = dateNow - monotonicOriginDateMs;
    // performance.now() は本番の単調時計、Date の差分は fake timer/バックグラウンド復帰の
    // 補助時計として使う。前回値を下回らないようにすることで wall-clock の逆行を吸収する。
    monotonicLastMs = Math.max(monotonicLastMs, performanceDelta, dateDelta);
    return monotonicLastMs;
  }

  function clearRotationTimer(): void {
    if (rotationTimer != null) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
  }

  function cancelRotationTransition(): void {
    rotationTransitionToken += 1;
    if (rotationTransitionDeadlineTimer != null) {
      clearTimeout(rotationTransitionDeadlineTimer);
      rotationTransitionDeadlineTimer = null;
    }
    const animation = rotationTransition;
    rotationTransition = null;
    animation?.cancel();
  }

  function reducedMotionRequested(): boolean {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function completeRotationTransition(token: number): void {
    if (token !== rotationTransitionToken) return;
    if (rotationTransitionDeadlineTimer != null) {
      clearTimeout(rotationTransitionDeadlineTimer);
      rotationTransitionDeadlineTimer = null;
    }
    rotationTransition = null;
    if (rotationTickPending && !rotationEpochBusy) {
      rotationTickPending = false;
      processRotationTick();
    }
  }

  function startRotationTransition(): void {
    if (rotationSlotEl == null || reducedMotionRequested() || typeof rotationSlotEl.animate !== "function") return;
    const token = ++rotationTransitionToken;
    const animation = rotationSlotEl.animate(
      [{ opacity: "0.72" }, { opacity: "1" }],
      { duration: ROTATION_TRANSITION_DEADLINE_MS / 2, easing: "ease-out" },
    );
    rotationTransition = animation;
    animation.onfinish = () => completeRotationTransition(token);
    animation.oncancel = () => completeRotationTransition(token);
    rotationTransitionDeadlineTimer = setTimeout(() => {
      if (token !== rotationTransitionToken) return;
      animation.cancel();
      completeRotationTransition(token);
    }, ROTATION_TRANSITION_DEADLINE_MS);
  }

  function applyRotationKey(key: CardKey | null, animate: boolean): void {
    if (key == null || key === rotationActiveKey) return;
    cancelRotationTransition();
    // 空フレームを作らず、新しいカードを同じ枠へ直接差し替える。
    rotationActiveKey = key;
    if (!animate || rotationTickOverride != null || rotationSchedulerStage !== 3) return;
    const token = rotationTransitionToken;
    void tick().then(() => {
      if (token !== rotationTransitionToken || rotationActiveKey !== key || rotationSchedulerStage !== 3) return;
      startRotationTransition();
    });
  }

  function nextRotationKeyAfterRemoval(
    previousKeys: readonly CardKey[],
    previousKey: CardKey | null,
    nextKeys: readonly CardKey[],
  ): CardKey | null {
    const canonicalNext = rotationKeysInCanonicalOrder(nextKeys);
    if (canonicalNext.length === 0) return null;
    if (previousKey == null) return canonicalNext[0];
    const canonicalPrevious = rotationKeysInCanonicalOrder(previousKeys);
    const previousIndex = canonicalPrevious.indexOf(previousKey);
    if (previousIndex >= 0) {
      for (let offset = 1; offset <= canonicalPrevious.length; offset += 1) {
        const candidate = canonicalPrevious[(previousIndex + offset) % canonicalPrevious.length];
        if (canonicalNext.includes(candidate)) return candidate;
      }
    }
    return canonicalNext[0];
  }

  function scheduleRotationTimer(nowMs = monotonicNowMs()): void {
    clearRotationTimer();
    if (rotationTickOverride != null || rotationSchedulerStage !== 3 || rotationSchedulerSuspended || rotationSchedulerKeys.length <= 1) return;
    const elapsedTicks = Math.max(0, Math.floor((nowMs - rotationEnteredAtMs) / ROTATION_PERIOD_MS));
    const nextDeadline = rotationEnteredAtMs + (elapsedTicks + 1) * ROTATION_PERIOD_MS;
    rotationTimer = setTimeout(() => {
      rotationTimer = null;
      if (rotationEpochBusy) {
        rotationTickPending = true;
        return;
      }
      processRotationTick();
    }, Math.max(0, nextDeadline - nowMs));
  }

  function processRotationTick(): void {
    if (!rotationSchedulerMounted || rotationSchedulerStage !== 3 || rotationSchedulerSuspended || rotationSchedulerKeys.length === 0) return;
    if (rotationEpochBusy) {
      rotationTickPending = true;
      return;
    }
    if (rotationTransition != null && rotationTransition.playState === "running") {
      rotationTickPending = true;
      return;
    }
    const nowMs = monotonicNowMs();
    const elapsedTicks = Math.max(0, Math.floor((nowMs - rotationEnteredAtMs) / ROTATION_PERIOD_MS));
    if (elapsedTicks <= rotationProcessedTick) {
      scheduleRotationTimer(nowMs);
      return;
    }
    rotationProcessedTick = elapsedTicks;
    const canonicalKeys = rotationKeysInCanonicalOrder(rotationSchedulerKeys);
    applyRotationKey(canonicalKeys[elapsedTicks % canonicalKeys.length] ?? null, true);
    scheduleRotationTimer(nowMs);
  }

  function syncRotationScheduler(stage: LadderStage, keys: readonly CardKey[]): void {
    if (!rotationSchedulerMounted || measurementDisposed) return;
    rotationEpochBusy = true;
    // epoch/stage 更新を tick より優先し、進行中の transition はここで cancel する。
    cancelRotationTransition();
    const canonicalKeys = rotationKeysInCanonicalOrder(keys);
    if (stage !== 3 || canonicalKeys.length === 0) {
      if (rotationSchedulerStage === 3 && !measurementSettled) {
        rotationSchedulerSuspended = true;
        clearRotationTimer();
        rotationEpochBusy = false;
        return;
      }
      clearRotationTimer();
      rotationSchedulerStage = null;
      rotationSchedulerKeys = [];
      rotationSchedulerSuspended = false;
      rotationActiveKey = null;
      rotationTickPending = false;
      rotationEpochBusy = false;
      return;
    }

    const resuming = rotationSchedulerSuspended;
    const previousKeys = rotationSchedulerKeys;
    const previousKey = rotationActiveKey;
    if (rotationSchedulerStage !== 3) {
      rotationSchedulerStage = 3;
      rotationSchedulerKeys = canonicalKeys;
      rotationSchedulerSuspended = false;
      rotationEnteredAtMs = monotonicNowMs();
      rotationProcessedTick = 0;
      const initialKey = rotationTickOverride == null
        ? canonicalKeys[0]
        : canonicalKeys[rotationTickOverride % canonicalKeys.length];
      applyRotationKey(initialKey ?? null, false);
    } else {
      rotationSchedulerKeys = canonicalKeys;
      rotationSchedulerSuspended = false;
      if (rotationTickOverride != null) {
        applyRotationKey(canonicalKeys[rotationTickOverride % canonicalKeys.length] ?? null, false);
      } else if (previousKey == null || !canonicalKeys.includes(previousKey)) {
        applyRotationKey(nextRotationKeyAfterRemoval(previousKeys, previousKey, canonicalKeys), false);
      }
    }
    if (resuming) rotationTickPending = true;
    rotationEpochBusy = false;
    if (rotationTickPending) {
      rotationTickPending = false;
      processRotationTick();
    } else {
      scheduleRotationTimer();
    }
  }

  function disposeRotationScheduler(): void {
    rotationSchedulerMounted = false;
    clearRotationTimer();
    cancelRotationTransition();
    rotationSchedulerStage = null;
    rotationSchedulerKeys = [];
    rotationActiveKey = null;
    rotationTickPending = false;
  }

  function cssPx(value: string | undefined): number {
    const parsed = parseFloat(value ?? "0");
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  function readMeasurements(): void {
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
    const baseLayoutHeight = Math.round(layoutRect?.height ?? layoutEl?.offsetHeight ?? 0);
    const layoutWidth = Math.round(layoutRect?.width ?? layoutEl?.offsetWidth ?? 0);
    const cardWidth = Math.round(layoutEl?.querySelector<HTMLElement>("[data-mock-side='left'] [data-mock-card]")?.getBoundingClientRect().width ?? 0);
    const sideStyle = sideEl == null ? null : getComputedStyle(sideEl);
    const computedGap = cssPx(sideStyle?.rowGap);
    const columnPadding = cssPx(sideStyle?.paddingTop) + cssPx(sideStyle?.paddingBottom);
    const tickerRect = tickerEl?.getBoundingClientRect();
    const tickerHeight = Math.round(tickerRect?.height ?? tickerEl?.offsetHeight ?? 0);
    // 初回は --mock-nankai-reserve=0px で読まれるため一時的に高くなるが、nankai の
    // 実測値を CSS へ戻した bounded settle pass で legacy-layout 自身を再読する。
    // layoutRect は ticker と南海帯を除外した実表示 track なので、ここで二重控除しない。
    const layoutHeight = Math.max(0, baseLayoutHeight);
    measuredHeights = nextHeights;
    measuredCenterHeights = nextCenterHeights;
    measuredFixedHeights = nextFixedHeights;
    measuredNankaiHeightPx = nankaiHeight;
    measuredClusterGapPx = clusterGap;
    measuredClusterFlowHeightPx = clusterFlowHeight;
    measuredBaseLayoutHeightPx = baseLayoutHeight;
    measuredLayoutHeightPx = layoutHeight;
    measuredLayoutWidthPx = layoutWidth;
    measuredCardWidthPx = cardWidth;
    measuredGapPx = computedGap;
    measuredColumnPaddingPx = columnPadding;
    measuredTickerHeightPx = tickerHeight;
    measuredRotationFailureHeightPx = measureNaturalHeight(rotationFailureMeasureEl ?? undefined);
    measurementReadCount = measureEntries.length * 2 + fixedMeasureKeys.length + (nankai == null ? 0 : 1) + 1;
    measurementPass += 1;
    measurementComplete = true;
  }

  function measurementSignature(): string {
    return [
      layoutPlan.stage,
      layoutPlan.variants.quake,
      layoutPlan.variants.weather,
      layoutPlan.variants.typhoon,
      layoutPlan.rotationKeys.join(","),
      measuredLayoutWidthPx,
      measuredLayoutHeightPx,
      measuredCardWidthPx,
      measuredGapPx,
      Object.entries(measuredHeights).sort(([left], [right]) => left.localeCompare(right)).map(([key, height]) => `${key}:${height}`).join(","),
      Object.entries(measuredCenterHeights).sort(([left], [right]) => left.localeCompare(right)).map(([key, height]) => `${key}:${height}`).join(","),
      Object.entries(measuredFixedHeights).sort(([left], [right]) => left.localeCompare(right)).map(([key, height]) => `${key}:${height}`).join(","),
      measuredNankaiHeightPx,
      measuredRotationFailureHeightPx,
    ].join("|");
  }

  async function settleMeasurements(): Promise<void> {
    let previousSignature = measurementSignature();
    for (let pass = 1; pass < MAX_SETTLE_PASSES; pass += 1) {
      if (measurementDisposed) return;
      await tick();
      if (measurementDisposed) return;
      if (ladderAuto && layoutPlan.stage > settleFloorStage) settleFloorStage = layoutPlan.stage;
      readMeasurements();
      await tick();
      const nextSignature = measurementSignature();
      if (nextSignature === previousSignature) {
        measurementSettled = true;
        return;
      }
      previousSignature = nextSignature;
    }
    measurementNonConverged = true;
    measurementSettled = true;
  }

  onMount(() => {
    measurementDisposed = false;
    readMeasurements();
    rotationSchedulerMounted = true;
    syncRotationScheduler(layoutPlan.stage, layoutPlan.rotationKeys);
    void settleMeasurements();
    return () => {
      measurementDisposed = true;
      disposeRotationScheduler();
    };
  });

  function measureId(key: CardKey, variant: CardVariant): string {
    return key === "quake" || key === "weather" || key === "typhoon" ? `${key}:${variant}` : key;
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
    // measuredLayoutHeightPx は南海帯予約を反映した最終 track 高。列 padding はカードの
    // natural 合計に含まれないため、最後に明示的に引く。ticker/edge は layout の inset に
    // 既に含まれており、二重控除しない。
    return Math.max(0, measuredLayoutHeightPx - measuredColumnPaddingPx);
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

  function sortedCards(cards: readonly CardCandidate[]): CardCandidate[] {
    return [...cards].sort((leftCard, rightCard) => leftCard.order - rightCard.order);
  }

  function overflowPx(height: number, capacity: number): number {
    return Number.isFinite(capacity) ? Math.max(0, height - capacity) : 0;
  }

  function rightNaturalHeight(cards: readonly CardCandidate[], rotationSlotHeight = 0, failureHeight = 0): number {
    let total = columnNaturalHeight(cards);
    if (rotationSlotHeight > 0) total += (cards.length > 0 ? columnGapPx() : 0) + rotationSlotHeight;
    if (failureHeight > 0) total += columnGapPx() + failureHeight;
    return total;
  }

  function placementTotalOverflow(
    choice: PlacementChoice,
    capacity: number,
    rotationSlotHeight = 0,
    failureHeight = 0,
  ): number {
    const sideOverflow = overflowPx(columnNaturalHeight(choice.left), capacity)
      + overflowPx(rightNaturalHeight(choice.right, rotationSlotHeight, failureHeight), capacity);
    const centerOverflow = choice.center.length === 0
      ? 0
      : overflowPx(centerNaturalHeight(choice.center), capacity);
    return sideOverflow + centerOverflow;
  }

  function comparePlacements(
    leftChoice: PlacementChoice,
    rightChoice: PlacementChoice,
    capacity: number,
    rotationSlotHeight = 0,
    failureHeight = 0,
  ): number {
    const leftOverflow = placementTotalOverflow(leftChoice, capacity, rotationSlotHeight, failureHeight);
    const rightOverflow = placementTotalOverflow(rightChoice, capacity, rotationSlotHeight, failureHeight);
    const leftFits = leftOverflow === 0;
    const rightFits = rightOverflow === 0;
    if (leftFits !== rightFits) return leftFits ? -1 : 1;

    if (leftFits) {
      // 時計を中央に残すことを最優先し、完全に収まる配置では中央移動枚数を最小化する。
      if (leftChoice.center.length !== rightChoice.center.length) {
        return leftChoice.center.length - rightChoice.center.length;
      }
      // wide surface は中央 36rem の恩恵を受ける優先候補。中央移動枚数が同じ場合だけ
      // tie-break に参加させ、通常の「時計を中央に残す」目的関数を崩さない。
      const leftWideFlood = floodIsWide && leftChoice.center.some((card) => card.key === "flood");
      const rightWideFlood = floodIsWide && rightChoice.center.some((card) => card.key === "flood");
      if (leftWideFlood !== rightWideFlood) return leftWideFlood ? -1 : 1;
      const leftMax = Math.max(columnNaturalHeight(leftChoice.left), rightNaturalHeight(leftChoice.right, rotationSlotHeight, failureHeight));
      const rightMax = Math.max(columnNaturalHeight(rightChoice.left), rightNaturalHeight(rightChoice.right, rotationSlotHeight, failureHeight));
      if (leftMax !== rightMax) return leftMax - rightMax;
    } else if (leftOverflow !== rightOverflow) {
      return leftOverflow - rightOverflow;
    }

    const leftSideBalance = Math.abs(columnNaturalHeight(leftChoice.left) - rightNaturalHeight(leftChoice.right, rotationSlotHeight, failureHeight));
    const rightSideBalance = Math.abs(columnNaturalHeight(rightChoice.left) - rightNaturalHeight(rightChoice.right, rotationSlotHeight, failureHeight));
    if (leftSideBalance !== rightSideBalance) return leftSideBalance - rightSideBalance;

    const leftCenterOverflow = leftChoice.center.length === 0 ? 0 : overflowPx(centerNaturalHeight(leftChoice.center), capacity);
    const rightCenterOverflow = rightChoice.center.length === 0 ? 0 : overflowPx(centerNaturalHeight(rightChoice.center), capacity);
    if (leftCenterOverflow !== rightCenterOverflow) return leftCenterOverflow - rightCenterOverflow;
    if (leftChoice.center.length !== rightChoice.center.length) return leftChoice.center.length - rightChoice.center.length;
    if (leftChoice.moved.size !== rightChoice.moved.size) return leftChoice.moved.size - rightChoice.moved.size;
    const placementTuple = (choice: PlacementChoice): string => [choice.left, choice.right, choice.center]
      .map((cards) => cards.map((card) => card.key).join(","))
      .join("|");
    const leftTuple = placementTuple(leftChoice);
    const rightTuple = placementTuple(rightChoice);
    return leftTuple < rightTuple ? -1 : leftTuple > rightTuple ? 1 : 0;
  }

  function enumeratePlacements(
    candidates: readonly CardCandidate[],
    forcedLeftKeys: ReadonlySet<CardKey>,
    allowCenter: boolean,
    requireCenter: boolean,
  ): PlacementChoice[] {
    const fixedLeft = candidates.filter((card) => leftKeys.has(card.key) || forcedLeftKeys.has(card.key));
    const movable = candidates.filter((card) => !leftKeys.has(card.key) && !forcedLeftKeys.has(card.key));
    const centerCandidates = allowCenter ? movable.filter((card) => centerEligibleKeys.has(card.key)) : [];
    const placements: PlacementChoice[] = [];
    const centerMaskCount = 1 << centerCandidates.length;

    for (let centerMask = 0; centerMask < centerMaskCount; centerMask += 1) {
      const center = centerCandidates.filter((_, index) => (centerMask & (1 << index)) !== 0);
      if (requireCenter && center.length === 0) continue;
      const centerKeys = new Set(center.map((card) => card.key));
      const sideMovable = movable.filter((card) => !centerKeys.has(card.key));
      const leftMaskCount = 1 << sideMovable.length;
      for (let leftMask = 0; leftMask < leftMaskCount; leftMask += 1) {
        const leftMovable = sideMovable.filter((_, index) => (leftMask & (1 << index)) !== 0);
        const left = sortedCards([...fixedLeft, ...leftMovable]);
        const leftKeysForMask = new Set(leftMovable.map((card) => card.key));
        const right = sortedCards(sideMovable.filter((card) => !leftKeysForMask.has(card.key)));
        placements.push({
          left,
          right,
          center: sortedCards(center),
          moved: new Set(left.filter((card) => !leftKeys.has(card.key)).map((card) => card.key)),
        });
      }
    }
    return placements;
  }

  function bestPlacement(
    placements: readonly PlacementChoice[],
    capacity: number,
    rotationSlotHeight = 0,
    failureHeight = 0,
  ): PlacementChoice | null {
    let best: PlacementChoice | null = null;
    for (const placement of placements) {
      if (best == null || comparePlacements(placement, best, capacity, rotationSlotHeight, failureHeight) < 0) best = placement;
    }
    return best;
  }

  function buildCandidates(variants: VariantSelection): CardCandidate[] {
    return cardKeys.map((key, order) => {
      const variant = key === "quake"
        ? variants.quake
        : key === "weather"
          ? variants.weather
          : key === "typhoon"
            ? variants.typhoon
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
  const centerEligibleKeys = new Set<CardKey>(["weather", "flood", "typhoon", "volcano"]);
  const rotationReverseOrder: CardKey[] = ["heat", "volcano", "typhoon", "flood", "weather"];

  function emptyPlacement(): PlacementChoice {
    return { left: [], right: [], center: [], moved: new Set<CardKey>() };
  }

  function placementFits(choice: PlacementChoice | null, capacity: number, rotationSlotHeight = 0, failureHeight = 0): boolean {
    return choice != null && placementTotalOverflow(choice, capacity, rotationSlotHeight, failureHeight) === 0;
  }

  function rotationKeysInCanonicalOrder(keys: readonly CardKey[]): CardKey[] {
    return [...keys].sort((leftKey, rightKey) => cardKeys.indexOf(leftKey) - cardKeys.indexOf(rightKey));
  }

  function compactRotationHeight(key: CardKey): number {
    return measuredHeight(key, "compact");
  }

  function rotationSlotHeight(keys: readonly CardKey[]): number {
    return Math.max(0, ...keys.map((key) => compactRotationHeight(key)));
  }

  function rotationCurrentKey(keys: readonly CardKey[]): CardKey | null {
    const canonicalKeys = rotationKeysInCanonicalOrder(keys);
    return canonicalKeys[0] ?? null;
  }

  interface RotationSolution {
    placement: PlacementChoice;
    rotationKeys: CardKey[];
    currentKey: CardKey | null;
    slotHeight: number;
    failureCount: number;
    layoutFailure: boolean;
  }

  function solveRotation(candidates: readonly CardCandidate[], capacity: number): RotationSolution {
    const available = rotationReverseOrder.filter((key) => candidates.some((card) => card.key === key));
    const displayedKeys: CardKey[] = [];
    const failedKeys: CardKey[] = [];

    function solveRemaining(): { placement: PlacementChoice | null; slotHeight: number; failureHeight: number } {
      const excluded = new Set([...displayedKeys, ...failedKeys]);
      const remaining = candidates.filter((card) => !excluded.has(card.key));
      const slotHeight = rotationSlotHeight(displayedKeys);
      const failureHeight = failedKeys.length > 0 ? measuredRotationFailureHeightPx : 0;
      const placement = bestPlacement(
        enumeratePlacements(remaining, new Set<CardKey>(), true, false),
        capacity,
        slotHeight,
        failureHeight,
      );
      return { placement, slotHeight, failureHeight };
    }

    for (let pass = 0; pass < MAX_ROTATION_CANDIDATE_PASSES && displayedKeys.length + failedKeys.length < available.length; pass += 1) {
      const nextKey = available.find((key) => !displayedKeys.includes(key) && !failedKeys.includes(key));
      if (nextKey == null) break;
      displayedKeys.push(nextKey);
      const solved = solveRemaining();
      if (placementFits(solved.placement, capacity, solved.slotHeight, solved.failureHeight)) {
        const canonicalKeys = rotationKeysInCanonicalOrder(displayedKeys);
        return {
          placement: solved.placement ?? emptyPlacement(),
          rotationKeys: canonicalKeys,
          currentKey: rotationCurrentKey(canonicalKeys),
          slotHeight: solved.slotHeight,
          failureCount: failedKeys.length,
          layoutFailure: false,
        };
      }
    }

    // 枠そのものが高すぎる場合は、輪番集合から最大 compact カードを外し、failure 行へ送る。
    while (displayedKeys.length > 0) {
      const solved = solveRemaining();
      if (placementFits(solved.placement, capacity, solved.slotHeight, solved.failureHeight)) {
        const canonicalKeys = rotationKeysInCanonicalOrder(displayedKeys);
        return {
          placement: solved.placement ?? emptyPlacement(),
          rotationKeys: canonicalKeys,
          currentKey: rotationCurrentKey(canonicalKeys),
          slotHeight: solved.slotHeight,
          failureCount: failedKeys.length,
          layoutFailure: false,
        };
      }
      const largestKey = displayedKeys
        .slice()
        .sort((leftKey, rightKey) => compactRotationHeight(rightKey) - compactRotationHeight(leftKey) || cardKeys.indexOf(rightKey) - cardKeys.indexOf(leftKey))[0];
      displayedKeys.splice(displayedKeys.indexOf(largestKey), 1);
      failedKeys.push(largestKey);
    }

    const solved = solveRemaining();
    const canonicalKeys = rotationKeysInCanonicalOrder(displayedKeys);
    return {
      placement: solved.placement ?? emptyPlacement(),
      rotationKeys: canonicalKeys,
      currentKey: rotationCurrentKey(canonicalKeys),
      slotHeight: solved.slotHeight,
      failureCount: failedKeys.length,
      layoutFailure: !placementFits(solved.placement, capacity, solved.slotHeight, solved.failureHeight),
    };
  }

  function makeColumnPlan(): ColumnPlan {
    const capacity = layoutCapacityPx();
    const emptyForced = new Set<CardKey>();
    const fullVariants: VariantSelection = { quake: "compact", weather: "compact", typhoon: "full" };
    const fullCandidates = buildCandidates(fullVariants);
    const fullSide = bestPlacement(enumeratePlacements(fullCandidates, emptyForced, false, false), capacity);
    let variants = fullVariants;
    let candidates = fullCandidates;
    let sidePlacement = fullSide;

    // A の入力は常に compact baseline。full 台風で左右が成立しなければ compact 台風で一度だけ再試行する。
    if (!placementFits(fullSide, capacity)) {
      variants = { ...fullVariants, typhoon: "compact" };
      candidates = buildCandidates(variants);
      sidePlacement = bestPlacement(enumeratePlacements(candidates, emptyForced, false, false), capacity);
    }

    const auto = ladderOverride == null;
    const floor = auto ? settleFloorStage : ladderOverride ?? 0;
    let selected = sidePlacement ?? emptyPlacement();
    let stage: LadderStage = 0;
    let rotationKeys: CardKey[] = [];
    let rotationCurrent: CardKey | null = null;
    let rotationHeight = 0;
    let rotationFailureCount = 0;
    let layoutFailure = false;
    const sideFits = placementFits(sidePlacement, capacity);

    if (floor === 0 && (sideFits || !auto)) {
      stage = 0;
    } else {
      const centerPlacement = bestPlacement(enumeratePlacements(candidates, emptyForced, true, true), capacity);
      const centerFits = placementFits(centerPlacement, capacity);
      if (floor <= 1 && (centerFits || !auto || floor === 1)) {
        selected = centerPlacement ?? selected;
        stage = 1;
        if (auto && !centerFits) stage = 2;
      } else if (floor <= 2) {
        selected = centerPlacement ?? selected;
        stage = 2;
        if (auto && !centerFits) {
          const rotation = solveRotation(candidates, capacity);
          selected = rotation.placement;
          rotationKeys = rotation.rotationKeys;
          rotationCurrent = rotation.currentKey;
          rotationHeight = rotation.slotHeight;
          rotationFailureCount = rotation.failureCount;
          layoutFailure = rotation.layoutFailure;
          stage = 3;
        }
      } else {
        const rotation = solveRotation(candidates, capacity);
        selected = rotation.placement;
        rotationKeys = rotation.rotationKeys;
        rotationCurrent = rotation.currentKey;
        rotationHeight = rotation.slotHeight;
        rotationFailureCount = rotation.failureCount;
        layoutFailure = rotation.layoutFailure;
        stage = 3;
      }
    }

    if (ladderOverride === 1) stage = 1;
    if (ladderOverride === 2) stage = 2;
    if (ladderOverride === 3) {
      const rotation = solveRotation(candidates, capacity);
      selected = rotation.placement;
      rotationKeys = rotation.rotationKeys;
      rotationCurrent = rotation.currentKey;
      rotationHeight = rotation.slotHeight;
      rotationFailureCount = rotation.failureCount;
      layoutFailure = rotation.layoutFailure;
      stage = 3;
    }

    const centerUnresolved = selected.center.length > 0 && centerNaturalHeight(selected.center) > centerCapacityPx();
    const sideUnresolved = columnNaturalHeight(selected.left) > capacity
      || rightNaturalHeight(selected.right, rotationHeight, rotationFailureCount > 0 ? measuredRotationFailureHeightPx : 0) > capacity;
    const unresolved = layoutFailure || sideUnresolved || centerUnresolved;
    return {
      left: selected.left,
      right: selected.right,
      center: selected.center,
      moved: selected.moved,
      unresolved,
      centerUnresolved,
      stage,
      variants,
      rotationKeys,
      rotationCurrentKey: rotationCurrent,
      rotationSlotHeight: rotationHeight,
      rotationFailureCount,
      layoutFailure,
    };
  }

  function replacePlanVariants(plan: ColumnPlan, variants: VariantSelection): ColumnPlan {
    const candidateMap = new Map(buildCandidates(variants).map((card) => [card.key, card]));
    const replace = (cards: readonly CardCandidate[]): CardCandidate[] => cards.map((card) => candidateMap.get(card.key) ?? card);
    return {
      ...plan,
      left: replace(plan.left),
      right: replace(plan.right),
      center: replace(plan.center),
      variants,
    };
  }

  function columnFor(plan: ColumnPlan, key: CardKey): CardCandidate[] | null {
    if (plan.left.some((card) => card.key === key)) return plan.left;
    if (plan.right.some((card) => card.key === key)) return plan.right;
    return plan.center.some((card) => card.key === key) ? plan.center : null;
  }

  function expandedFits(plan: ColumnPlan, variants: VariantSelection, key: ExpandableCardKey): boolean {
    if (plan.rotationKeys.includes(key)) return false;
    const trial = replacePlanVariants(plan, variants);
    const column = columnFor(trial, key);
    if (column == null) return false;
    if (column === trial.center) return centerNaturalHeight(trial.center) <= centerCapacityPx();
    const failureHeight = trial.rotationFailureCount > 0 ? measuredRotationFailureHeightPx : 0;
    return columnNaturalHeight(trial.left) <= layoutCapacityPx()
      && rightNaturalHeight(trial.right, trial.rotationSlotHeight, failureHeight) <= layoutCapacityPx();
  }

  const baselinePlan = $derived(makeColumnPlan());

  const layoutPlan = $derived.by(() => {
    // B は baseline の配置・stageを固定したまま、quake→weather の順に残余容量だけを判定する。
    let plan = baselinePlan;
    const expansionOrder: ExpandableCardKey[] = ["quake", "weather"];
    for (const key of expansionOrder) {
      const variants = { ...plan.variants, [key]: "expanded" as const };
      if (expandedFits(plan, variants, key)) plan = replacePlanVariants(plan, variants);
    }
    return plan;
  });

  // scheduler は layoutPlan の stage/key と測定 epoch だけを購読する。active key 自身は読まないため、
  // tick による差し替えで scheduler が自己再入しない。epoch 更新中は sync 側で transition を cancel
  // し、同じ stage 3 の再計測なら現在 key と起点時刻を維持する。
  $effect(() => {
    const stage = layoutPlan.stage;
    const keys = layoutPlan.rotationKeys;
    const epoch = measurementPass;
    const settled = measurementSettled;
    void epoch;
    void settled;
    if (!rotationSchedulerMounted) return;
    syncRotationScheduler(stage, keys);
  });

  const clusterGapStyle = $derived(
    measuredClusterGapPx > 0
      ? `${measuredClusterGapPx}px`
      : layoutPlan.stage >= 2
        ? "calc(var(--mock-gap) * 1.25)"
        : "calc(var(--mock-gap) * 1.75)",
  );
  const clusterFlowHeightStyle = $derived(measuredClusterFlowHeightPx > 0 ? `${measuredClusterFlowHeightPx}px` : "auto");
  const centerNaturalHeightPx = $derived(centerNaturalHeight(layoutPlan.center));

  function plannedCards(
    cards: readonly CardCandidate[],
    placement: "left" | "right" | "center",
  ): PlannedCard[] {
    return cards.map((card) => {
      const naturalHeight = placement === "center" ? card.centerNaturalHeight : card.naturalHeight;
      return {
        ...card,
        naturalHeight,
        allocatedHeight: naturalHeight,
        extraHeight: 0,
        clipped: false,
        overflowed: placement === "center",
        placement,
      };
    });
  }

  const leftCards = $derived(plannedCards(layoutPlan.left, "left"));
  const rightCards = $derived(plannedCards(layoutPlan.right, "right"));
  const centerCards = $derived(plannedCards(layoutPlan.center, "center"));
  const compactCandidates = $derived(buildCandidates({ quake: "compact", weather: "compact", typhoon: "compact" }));
  const rotationActiveKeyForRender = $derived.by(() => {
    if (layoutPlan.stage !== 3 || layoutPlan.rotationKeys.length === 0) return null;
    const canonicalKeys = rotationKeysInCanonicalOrder(layoutPlan.rotationKeys);
    if (rotationTickOverride != null) return canonicalKeys[rotationTickOverride % canonicalKeys.length] ?? null;
    return rotationActiveKey != null && canonicalKeys.includes(rotationActiveKey)
      ? rotationActiveKey
      : canonicalKeys[0] ?? null;
  });
  const rotationCurrentCard = $derived.by(() => {
    if (rotationActiveKeyForRender == null) return null;
    return compactCandidates.find((card) => card.key === rotationActiveKeyForRender) ?? null;
  });
  const rotationCurrentPlannedCard = $derived.by(() => rotationCurrentCard == null
    ? null
    : {
        ...rotationCurrentCard,
        allocatedHeight: rotationCurrentCard.naturalHeight,
        extraHeight: 0,
        clipped: false,
        overflowed: false,
        placement: "right" as const,
      });

  function isExpanded(entry: PlannedCard): boolean {
    return (entry.key === "quake" || entry.key === "weather") && entry.variant === "expanded";
  }
</script>

  {#snippet renderCard(key: CardKey, variant: CardVariant, placement: "side" | "center" = "side")}
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
    {#if placement === "center" && floodIsWide}
      <FloodWideCard item={flood} />
    {:else}
      <FloodCard item={flood} />
    {/if}
  {:else if key === "typhoon" && typhoon != null}
    <TyphoonCard item={typhoon} displayMode={variant === "compact" ? "compact" : "full"} />
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
    data-overflow-placement={entry.placement === "center" ? "center" : undefined}
    data-center-eligible={centerEligibleKeys.has(entry.key) ? "true" : "false"}
    data-region-expanded={isExpanded(entry) ? "true" : undefined}
    data-content-score={entry.score}
    data-natural-height-px={entry.naturalHeight}
    data-allocated-height-px={entry.allocatedHeight}
    data-height-extra-px={entry.extraHeight}
    data-card-clipped={entry.clipped ? "true" : undefined}
    data-flood-render-mode={entry.key === "flood" && entry.placement === "center" && floodIsWide ? "wide" : entry.key === "flood" ? "side" : undefined}
  >
    {@render renderCard(entry.key, entry.variant, entry.placement === "center" ? "center" : "side")}
  </article>
{/snippet}

<svelte:head><title>Legacy standby improved mock v15</title></svelte:head>

<main
  id="legacy-improved-mock"
  class="legacy-mock ladder-{layoutPlan.stage}"
  style={`--mock-nankai-reserve: ${measuredNankaiHeightPx}px; --mock-cluster-gap: ${clusterGapStyle}; --mock-cluster-flow-height: ${clusterFlowHeightStyle};`}
  data-legacy-improved-mock
  data-ladder-stage={layoutPlan.stage}
  data-ladder-auto={ladderAuto ? "true" : "false"}
  data-scenario={scenario}
  data-flood-wide-requested={wideFloodRequested && floodIsWide ? "true" : "false"}
  data-suppressed-unknown-count={unknownInputs.length}
  data-input-item-count={cardKeys.length + unknownInputs.length}
  data-measurement-mode={measurementComplete ? "sync-dom" : "pending"}
  data-measurement-pass={measurementPass}
  data-measurement-settled={measurementSettled ? "true" : "false"}
  data-measurement-nonconverged={measurementNonConverged ? "true" : "false"}
  data-measurement-read-count={measurementReadCount}
  data-layout-base-height-px={measuredBaseLayoutHeightPx}
  data-layout-height-px={measuredLayoutHeightPx}
  data-layout-capacity-px={layoutCapacityPx()}
  data-layout-width-px={measuredLayoutWidthPx}
  data-card-width-px={measuredCardWidthPx}
  data-nankai-height-px={measuredNankaiHeightPx}
  data-ticker-height-px={measuredTickerHeightPx}
  data-column-padding-px={measuredColumnPaddingPx}
  data-cluster-gap-px={measuredClusterGapPx}
  data-cluster-flow-height-px={measuredClusterFlowHeightPx}
  data-left-natural-height-px={columnNaturalHeight(layoutPlan.left)}
  data-right-natural-height-px={rightNaturalHeight(layoutPlan.right, layoutPlan.rotationSlotHeight, layoutPlan.rotationFailureCount > 0 ? measuredRotationFailureHeightPx : 0)}
  data-left-capacity-px={layoutCapacityPx()}
  data-right-capacity-px={layoutCapacityPx()}
  data-center-gap-px={columnGapPx()}
  data-center-natural-height-px={centerNaturalHeightPx}
  data-center-eligible-keys="weather,flood,typhoon,volcano"
  data-clock-mode={layoutPlan.stage === 0 ? "viewport-center" : "ticker-bottom-right"}
  data-center-fixed-height-px={centerFixedNaturalHeight()}
  data-center-capacity-px={centerCapacityPx()}
  data-center-unresolved={layoutPlan.centerUnresolved ? "true" : "false"}
  data-layout-unresolved={layoutPlan.unresolved ? "true" : "false"}
  data-layout-failure={layoutPlan.layoutFailure ? "true" : "false"}
  data-rotation-keys={layoutPlan.rotationKeys.join(",")}
  data-rotation-current-key={rotationActiveKeyForRender ?? undefined}
  data-rotation-active-key={rotationActiveKeyForRender ?? undefined}
  data-rotation-omitted-count={layoutPlan.rotationFailureCount}
  data-rotation-slot-height-px={layoutPlan.rotationSlotHeight}
  data-rotation-failure-count={layoutPlan.rotationFailureCount}
  data-paging="none"
>
  <div class="mock-label">
    <strong>従来フォーマット改良 v15</strong>
    <span>scenario={scenario} · ladder={ladderAuto ? "auto" : layoutPlan.stage} · 実 DOM 同期測定</span>
  </div>

  <div class="measure-shelf" aria-hidden="true" inert>
    {#each measureEntries as entry (entry.id)}
      <div class="measure-item" data-measure-card={entry.id} use:captureMeasure={entry.id}>
        {@render renderCard(entry.key, entry.variant)}
      </div>
    {/each}
  </div>
  <div class="rotation-failure-measure" bind:this={rotationFailureMeasureEl} aria-hidden="true">
    ほか {layoutPlan.rotationFailureCount} 件を表示できません
  </div>

  {#if layoutPlan.stage === 0}
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
        {@render renderCard(entry.key, entry.variant, "center")}
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

    {#if layoutPlan.stage === 0}
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
      {#if layoutPlan.stage === 3}
        <div class="rotation-slot" data-rotation-slot bind:this={rotationSlotEl} style={`height: ${layoutPlan.rotationSlotHeight}px;`}>
          {#if rotationCurrentPlannedCard != null}
            {@render renderSideCard(rotationCurrentPlannedCard)}
          {/if}
        </div>
        {#if layoutPlan.rotationFailureCount > 0}
          <div class="rotation-failure" data-rotation-failure>
            ほか {layoutPlan.rotationFailureCount} 件を表示できません
          </div>
        {/if}
      {/if}
    </div>
  </section>

  {#if nankai != null}
    <div class="nankai-ticker" data-nankai-ticker data-fixed-stack-item="nankai" bind:this={nankaiBandEl}>
      <NankaiBadge item={nankai} />
    </div>
  {/if}

  <footer class="ticker-reserve" aria-label="テロップ領域" bind:this={tickerEl}>
    <span>TELEGRAM</span><span>ページングなし・実 DOM 自然高さ優先</span>
    {#if layoutPlan.stage >= 1}
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

  .ladder-2,
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

  .rotation-failure-measure {
    position: absolute;
    top: 0;
    left: 0;
    width: var(--mock-card-width);
    box-sizing: border-box;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
    color: var(--role-muted);
    text-align: center;
    visibility: hidden;
    pointer-events: none;
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

  /* stage 1 以降は v5 spec の裁定どおり、左右列も中央受け皿も縦中央へ置く。 */
  .ladder-1 .side,
  .ladder-2 .side,
  .ladder-3 .side { justify-content: safe center; }

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
  .legacy-mock .legacy-card :global(.standby-card),
  .legacy-mock .legacy-card :global(.flood-wide-card) {
    width: 100%;
    max-width: 100%;
  }

  /* wide surface は中央 placement だけ FloodWideCard に変換する。測定棚も同じ中央幅で
     測り、側列・輪番枠では通常の FloodCard を使う。 */
  .legacy-mock .measure-item :global(.flood-wide-card) {
    width: 100%;
    max-width: 100%;
  }

  /* marquee の absolute 配置はカード外の positioned ancestor を基準に走るため、
     overflow clip では閉じ込められない (v11 実測)。モックは静止画評価なので
     in-flow 静止化で banner-areas 内に収める。実表示の走行は本実装側で扱う。 */
  .legacy-mock .legacy-card :global(.marquee-text) {
    position: static;
    white-space: nowrap;
    animation-name: none;
  }

  .legacy-mock .measure-item :global(.marquee-text) {
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

  .rotation-slot,
  .rotation-failure {
    flex: 0 0 auto;
    width: var(--mock-card-width);
    max-width: 100%;
    box-sizing: border-box;
    align-self: center;
  }

  .rotation-slot {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    overflow: visible;
  }

  .rotation-slot > .legacy-card { width: 100%; }

  .rotation-failure {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-standby);
    background: var(--surface-standby);
    color: var(--role-muted);
    text-align: center;
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

  .ladder-1 .ticker-reserve,
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
