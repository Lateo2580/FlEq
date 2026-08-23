<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
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
  import type {
    ActiveStandbyCardV1,
    DisplayIntensityGroupV1,
    DisplayLatestQuakeStateV1,
    DisplayWeatherAlertItemV1,
    DisplayWeatherAlertV1,
  } from "../lib/protocol";
  import {
    latestQuakeStandbyCards,
    legacyImprovedExpandedLatestQuake,
    legacyImprovedNonMonotonicLatestQuake,
    legacyImprovedCandidate129LatestQuakeCompact,
    legacyImprovedCandidate129LatestQuakeExpanded,
    legacyImprovedCandidate129WeatherAlerts,
    legacyImprovedCandidate129WeatherAlertsCompact,
    legacyImprovedDuplicateWeatherAlerts,
    legacyImprovedDuplicateWeatherAlertsCompact,
    legacyImprovedMultiTailLatestQuakeCompact,
    legacyImprovedMultiTailLatestQuakeExpanded,
    legacyImprovedMultiTailWeatherAlerts,
    legacyImprovedMultiTailWeatherAlertsCompact,
    legacyImprovedTailOnlyLatestQuake,
    legacyImprovedTailOnlyWeatherAlerts,
    legacyImprovedZeroVisibleLatestQuake,
    legacyImprovedMaxItems,
    legacyImprovedMaxUnknownItems,
    legacyImprovedMaxWeatherAlerts,
    legacyImprovedMaxWeatherAlertsCompact,
    legacyImprovedWeatherAlertsExpanded,
    legacyImprovedWeatherAlertsCompact,
    legacyImprovedTornadoFullAreas,
    legacyImprovedTornadoFixtures,
    recentQuakesRich,
    standbyItemsShowcase,
    standbyItemsFloodWide,
    statsStandbyCards,
    tsunamiBanner,
  } from "./fixtures";
  import {
    achievableSurplusUse as solveAchievableSurplusUse,
    makeColumnPlan as solveColumnPlan,
    promoteAndExpand as solvePromoteAndExpand,
    type SolverContext,
  } from "../lib/legacy-standby/solver";
  import {
    pageIdentity as pageIdentityForEntry,
    planCardPageRuntimeUpdate,
    sequentialPartitionRanges as partitionRanges,
  } from "../lib/legacy-standby/page-partition";
  import type {
    CardCandidate,
    CardKey,
    CardPageRuntime,
    CardVariant,
    ColumnPlan,
    DisplaySelection,
    LadderStage,
    PageAreaEntry,
    PageMeasureEntry as LegacyPageMeasureEntry,
    PagePartitionKey,
    PageableKey,
    PageRange,
    PageTail,
    PlacementChoice,
    TyphoonVariant,
    VariantSelection,
  } from "../lib/legacy-standby/types";

  type Scenario = "4" | "7" | "max";
  type ExpandableCardKey = "quake" | "weather";
  type FixedMeasureKey = "stats" | "recent-quakes";
  type StandbyItemOf<K extends ActiveStandbyCardV1["kind"]> = Extract<ActiveStandbyCardV1, { kind: K }>;

  interface MeasureEntry {
    id: string;
    key: CardKey;
    variant: CardVariant;
    regionRows: number;
    floodWide: boolean;
  }

  interface PlannedCard extends CardCandidate {
    allocatedHeight: number;
    extraHeight: number;
    clipped: boolean;
    overflowed: boolean;
    placement: "left" | "right" | "center";
    regionRows: number;
    regionRemaining: number;
    floodWide: boolean;
  }

  interface WeatherPageItem {
    templateAlert: DisplayWeatherAlertV1;
    item: DisplayWeatherAlertItemV1;
    areas: string[];
  }

  type PageableCardKey = PageableKey;
  type MeasurablePageKey = Extract<PageableKey, "quake" | "weather">;
  const PAGEABLE_CARD_KEYS = ["quake", "weather", "flood", "tornado"] as const satisfies readonly PageableCardKey[];

  interface QuakePage {
    state: DisplayLatestQuakeStateV1;
    firstArea: string;
    identity: string;
    areaKeys: string[];
    tails: PageTail[];
  }

  interface WeatherPage {
    alerts: DisplayWeatherAlertV1[];
    firstArea: string;
    identity: string;
    areaKeys: string[];
    tails: PageTail[];
  }

  interface FloodPage {
    range: PageRange;
    firstArea: string;
    identity: string;
    areaKeys: string[];
    tails: PageTail[];
  }

  interface TornadoPage {
    range: PageRange;
    areas: string[];
    firstArea: string;
    identity: string;
    areaKeys: string[];
    tails: PageTail[];
  }

  interface CardPagePartition<T> {
    pages: T[];
    /** 表示用のページ先頭地域名。v20 の診断互換を維持する。 */
    keys: string[];
    /** kindKey・先頭地域・canonical occurrence を連結した安定 identity。 */
    identities: string[];
    usesCandidate: boolean;
    infeasible: boolean;
    candidateTruncated: boolean;
    probeCount: number;
  }

  const EMPTY_TORNADO_PAGE_PARTITION: CardPagePartition<TornadoPage> = {
    pages: [], keys: [], identities: [], usesCandidate: false,
    infeasible: false, candidateTruncated: false, probeCount: 0,
  };

  /** Partition probes exist only for the pageable quake/weather cards. */
  type PageMeasureEntry = LegacyPageMeasureEntry;

  interface CardPageSchedulerSubstate {
    mode: "real" | "logical";
    phaseStartedAtMs: number;
    processedTick: number;
    pageCount: number;
  }

  interface PagePartitionScan {
    ranges: PageRange[];
    pending: PageMeasureEntry[];
    infeasible: boolean;
    probeCount: number;
    usesCandidate: boolean;
    candidateTruncated: boolean;
    areaCount: number;
    fullAreaCount: number;
  }

  interface SuppliedQuakeGroups {
    groups: DisplayIntensityGroupV1[];
    tails: PageTail[];
    truncated: boolean;
    fullAreaKeys: string[];
  }

  interface SuppliedWeatherItems {
    items: WeatherPageItem[];
    tails: PageTail[];
    truncated: boolean;
    fullAreaKeys: string[];
  }

  type CandidateTruncatedIntensityGroup = DisplayIntensityGroupV1 & { candidateTruncated?: boolean };
  type CandidateTruncatedWeatherItem = DisplayWeatherAlertItemV1 & { candidateTruncated?: boolean };

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

  interface StageSequenceEntry {
    stage: LadderStage;
    atMs: number;
  }

  function parseStageSequence(value: string | null): StageSequenceEntry[] {
    if (value == null || value.trim() === "") return [];
    return value.split(",").flatMap((rawEntry): StageSequenceEntry[] => {
      const [rawStage, rawAtMs] = rawEntry.split("@");
      const stage = parseLadder(rawStage?.trim() ?? null);
      if (stage == null || rawAtMs == null || !/^\d+$/.test(rawAtMs.trim())) return [];
      return [{ stage, atMs: Number.parseInt(rawAtMs, 10) }];
    }).sort((left, right) => left.atMs - right.atMs);
  }

  function findItem<K extends ActiveStandbyCardV1["kind"]>(
    items: readonly ActiveStandbyCardV1[],
    kind: K,
  ): StandbyItemOf<K> | null {
    return items.find((item): item is StandbyItemOf<K> => item.kind === kind) ?? null;
  }

  const knownCardKeys: readonly CardKey[] = ["tsunami", "quake", "weather", "flood", "typhoon", "volcano", "heat"];
  // Solver の内部規則と同じ。テンプレートの診断属性にも使うため、ここに残す。
  const centerEligibleKeys = new Set<CardKey>(["weather", "flood", "typhoon", "volcano"]);

  function parseCardKey(value: string): CardKey | null {
    return knownCardKeys.includes(value as CardKey) ? value as CardKey : null;
  }

  function parseRotationKeys(value: string | null): CardKey[] | null {
    if (value == null || value.trim() === "") return null;
    const keys = value.split(",").map((rawKey) => parseCardKey(rawKey.trim())).filter((key): key is CardKey => key != null);
    return keys.length > 0 ? [...new Set(keys)] : null;
  }

  interface RotationTestChange {
    action: "add" | "remove";
    key: CardKey;
  }

  function parseRotationTestChange(value: string | null): RotationTestChange | null {
    if (value == null) return null;
    const [action, rawKey] = value.split(":");
    const key = rawKey == null ? null : parseCardKey(rawKey.trim());
    return (action === "add" || action === "remove") && key != null ? { action, key } : null;
  }

  const scenario = parseScenario(params.get("legacyMock2"));
  const ladderOverride = parseLadder(params.get("ladder"));
  const ladderAuto = ladderOverride == null;
  const rotationTickParam = params.get("rotationTick");
  const rotationTickOverride = rotationTickParam == null || !/^\d+$/.test(rotationTickParam)
    ? null
    : Number.parseInt(rotationTickParam, 10);
  const cardPageTickParam = params.get("cardPageTick");
  const cardPageTickOverride = cardPageTickParam == null || !/^\d+$/.test(cardPageTickParam)
    ? null
    : Number.parseInt(cardPageTickParam, 10);
  const cardPageCandidateTruncatedRequested = params.get("candidateTruncated") === "1";
  const candidate129Requested = params.get("candidate129") === "1";
  const duplicatePageKeyFixtureRequested = params.get("duplicatePageKeys") === "1";
  const multiTailFixtureRequested = params.get("multiTail") === "1";
  const tailOnlyFixtureRequested = params.get("tailOnly") === "1";
  const nonMonotonicBFixtureRequested = params.get("nonMonotonicB") === "1";
  const zeroVisibleQuakeRequested = params.get("zeroVisible") === "1";
  const cardPageRefreshRequested = params.get("cardPageRefresh") === "1";
  const cardPageCollapseRequested = params.get("cardPageCollapse") === "1";
  const cardPageRefreshDeleteOriginRequested = params.get("cardPageRefreshDeleteOrigin") === "1";
  const cardPageRefreshAtParam = params.get("cardPageRefreshAt");
  const cardPageRefreshAtMs = cardPageRefreshAtParam != null && /^\d+$/.test(cardPageRefreshAtParam)
    ? Number.parseInt(cardPageRefreshAtParam, 10)
    : 1_000;
  const fixtureRemovalKeys = parseRotationKeys(params.get("fixtureRemove")) ?? [];
  const fixtureRemovalAtParam = params.get("fixtureRemoveAt");
  const fixtureRemovalAtMs = fixtureRemovalAtParam != null && /^\d+$/.test(fixtureRemovalAtParam)
    ? Number.parseInt(fixtureRemovalAtParam, 10)
    : 1_000;
  const stageSequence = parseStageSequence(params.get("stageSequence"));
  // rotationKeys/rotationChange は fake timer テスト専用の集合変化 override。通常の mock は
  // solver が返す rotationKeys をそのまま使い、URL 未指定時にはこの経路へ入らない。
  const rotationTestKeysParam = parseRotationKeys(params.get("rotationKeys"));
  const rotationTestChange = parseRotationTestChange(params.get("rotationChange"));
  const rotationTestChangeAtParam = params.get("rotationChangeAt");
  const rotationTestChangeAtMs = rotationTestChangeAtParam != null && /^\d+$/.test(rotationTestChangeAtParam)
    ? Number.parseInt(rotationTestChangeAtParam, 10)
    : 1_000;
  let rotationTestKeys = $state<CardKey[] | null>(rotationTestKeysParam);
  let rotationTestChangeTimer: ReturnType<typeof setTimeout> | null = null;
  let stageFixtureOverride = $state<LadderStage | null>(null);
  let stageTransitionTimers: ReturnType<typeof setTimeout>[] = [];
  let cardPageFixtureRevision = $state(0);
  let cardPageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let fixtureRemovalTimer: ReturnType<typeof setTimeout> | null = null;
  let fixtureRemovedKeys = $state<CardKey[]>([]);
  const MAX_SETTLE_PASSES = 4;
  const ROTATION_PERIOD_MS = 15_000;
  const CANDIDATE_SAFE_LIMIT = 128;
  const CANDIDATE_TEST_LIMIT = 4;
  const ROTATION_TRANSITION_DEADLINE_MS = 500;

  function rotationRedisplayIntervalMs(setLength: number): number {
    return setLength > 0 ? ROTATION_PERIOD_MS * setLength : 0;
  }
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
  const tornadoFixture = params.get("tornadoFixture");
  const tornadoFullAreas = tornado == null
    ? []
    : tornadoFixture === "1" ? [...legacyImprovedTornadoFixtures.one]
      : tornadoFixture === "2" ? [...legacyImprovedTornadoFixtures.two]
        : tornadoFixture === "5" ? [...legacyImprovedTornadoFixtures.five]
          : tornadoFixture === "12" ? [...legacyImprovedTornadoFixtures.twelve]
            : [...legacyImprovedTornadoFullAreas, ...tornado.data.areas];
  const longPeriod = findItem(activeItems, "longPeriod");
  const nankai = findItem(activeItems, "nankaiTrough");
  const fixedRecentRows = recentQuakesRich.slice(0, scenario === "4" ? 3 : 5);
  const fixedMeasureKeys: FixedMeasureKey[] = ["stats", "recent-quakes"];
  const fullWeatherAlerts: DisplayWeatherAlertV1[] = candidate129Requested
    ? legacyImprovedCandidate129WeatherAlerts
    : duplicatePageKeyFixtureRequested
      ? legacyImprovedDuplicateWeatherAlerts
      : multiTailFixtureRequested
        ? legacyImprovedMultiTailWeatherAlerts
      : tailOnlyFixtureRequested
        ? legacyImprovedTailOnlyWeatherAlerts
      : scenario === "max"
        ? legacyImprovedMaxWeatherAlerts
        : legacyImprovedWeatherAlertsExpanded;
  const compactWeatherAlerts: DisplayWeatherAlertV1[] = candidate129Requested
    ? legacyImprovedCandidate129WeatherAlertsCompact
    : duplicatePageKeyFixtureRequested
      ? legacyImprovedDuplicateWeatherAlertsCompact
      : multiTailFixtureRequested
        ? legacyImprovedMultiTailWeatherAlertsCompact
      : tailOnlyFixtureRequested
        ? legacyImprovedTailOnlyWeatherAlerts
      : scenario === "max"
        ? legacyImprovedMaxWeatherAlertsCompact
        : legacyImprovedWeatherAlertsCompact;
  const compactQuakeState = candidate129Requested
    ? legacyImprovedCandidate129LatestQuakeCompact
    : multiTailFixtureRequested
      ? legacyImprovedMultiTailLatestQuakeCompact
    : tailOnlyFixtureRequested
      ? legacyImprovedTailOnlyLatestQuake
    : zeroVisibleQuakeRequested
      ? legacyImprovedZeroVisibleLatestQuake
      : latestQuakeStandbyCards;
  const expandedQuakeState = candidate129Requested
    ? legacyImprovedCandidate129LatestQuakeExpanded
    : multiTailFixtureRequested
      ? legacyImprovedMultiTailLatestQuakeExpanded
    : tailOnlyFixtureRequested
      ? legacyImprovedTailOnlyLatestQuake
    : nonMonotonicBFixtureRequested
      ? legacyImprovedNonMonotonicLatestQuake
    : legacyImprovedExpandedLatestQuake;

  const quakeExpansionMaxRows = Math.max(0, ...expandedQuakeState.intensityGroups.map((group, index) => {
    const compactGroup = compactQuakeState.intensityGroups[index];
    return compactGroup == null ? 0 : Math.max(0, group.areas.length - compactGroup.areas.length);
  }));
  const weatherExpansionMaxRows = Math.max(0, ...fullWeatherAlerts.map((alert, alertIndex) => {
    const compactAlert = compactWeatherAlerts[alertIndex];
    return alert.items.reduce((total, item, itemIndex) => {
      const compactItem = compactAlert?.items[itemIndex];
      return total + (compactItem == null ? 0 : Math.max(0, item.shownAreas.length - compactItem.shownAreas.length));
    }, 0);
  }));

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
      measureEntries.push({ id: `${key}:compact`, key, variant: "compact", regionRows: 0, floodWide: false });
      const maxRows = key === "quake" ? quakeExpansionMaxRows : weatherExpansionMaxRows;
      for (let regionRows = 1; regionRows <= maxRows; regionRows += 1) {
        measureEntries.push({
          id: regionRows === maxRows ? `${key}:expanded` : `${key}:region:${regionRows}`,
          key,
          variant: "expanded",
          regionRows,
          floodWide: false,
        });
      }
    } else if (key === "typhoon") {
      measureEntries.push({ id: `${key}:compact`, key, variant: "compact", regionRows: 0, floodWide: false });
      measureEntries.push({ id: `${key}:full`, key, variant: "full", regionRows: 0, floodWide: false });
    } else if (key === "flood" && floodIsWide) {
      measureEntries.push({ id: key, key, variant: "compact", regionRows: 0, floodWide: false });
      measureEntries.push({ id: `${key}:wide`, key, variant: "compact", regionRows: 0, floodWide: true });
    } else {
      measureEntries.push({ id: key, key, variant: "compact", regionRows: 0, floodWide: false });
    }
  }

  // 1 パス目の同期 layout read 用。測定棚は visibility:hidden だが display:none ではないため、
  // 実ブラウザの offsetHeight を取得できる。rAF/ResizeObserver の遅延には依存しない。
  const measureNodes = new Map<string, HTMLElement>();
  const centerMeasureNodes = new Map<FixedMeasureKey, HTMLElement>();
  const centerCardMeasureNodes = new Map<string, HTMLElement>();
  const pageMeasureNodes = new Map<string, HTMLElement>();
  const centerPageMeasureNodes = new Map<string, HTMLElement>();
  let layoutEl = $state<HTMLElement | null>(null);
  let sideEl = $state<HTMLElement | null>(null);
  let clockWrapEl = $state<HTMLElement | null>(null);
  let nankaiBandEl = $state<HTMLElement | null>(null);
  let tickerEl = $state<HTMLElement | null>(null);
  let measuredHeights = $state<Record<string, number>>({});
  let measuredCenterHeights = $state<Record<string, number>>({});
  let measuredPageHeights = $state<Record<string, number>>({});
  let measuredCenterPageHeights = $state<Record<string, number>>({});
  let pageMeasurementEpoch = "";
  let pageMeasurementCacheKey = $state("");
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
  let fontsReady = $state(false);
  let settledMeasurementEpoch = $state("");
  let measurementNonConverged = $state(false);
  let rotationFailureMeasureEl = $state<HTMLElement | null>(null);
  let rotationSlotEl = $state<HTMLElement | null>(null);
  let rotationActiveKey = $state<CardKey | null>(null);
  let rotationSchedulerStage: LadderStage | null = null;
  let rotationSchedulerKeys: CardKey[] = [];
  let rotationPhaseKey: CardKey | null = null;
  let rotationEnteredAtMs = 0;
  let rotationActiveStartedAtMs = 0;
  let rotationProcessedTick = 0;
  let rotationSeenKeys: Set<CardKey> = new Set();
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;
  let rotationTransition: Animation | null = null;
  let rotationTransitionDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let rotationTransitionToken = 0;
  let rotationEpochBusy = false;
  let rotationTickPending = false;
  let rotationSchedulerSuspended = $state(false);
  let rotationSchedulerMounted = false;
  let measurementDisposed = false;
  let monotonicOriginPerformanceMs: number | null = null;
  let monotonicOriginDateMs: number | null = null;
  let monotonicLastMs = 0;
  let cardPageTick = $state(0);
  let cardPageSchedulerTimer: ReturnType<typeof setTimeout> | null = null;
  let cardPageSchedulerMounted = false;
  let cardPageSchedulerEpoch = "";
  let cardPageStartedAtMs = 0;
  let cardPageProcessedTick = 0;
  let cardPageEpochBusy = false;
  let cardPageTickPending = false;
  let cardPageSchedulerStage: LadderStage | null = null;
  let cardPageSchedulerPageCounts: Record<PageableCardKey, number> = { quake: 0, weather: 0, flood: 0, tornado: 0 };
  let cardPageSchedulerSubstates = $state<Record<PageableCardKey, CardPageSchedulerSubstate>>({
    quake: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
    weather: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
    flood: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
    tornado: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
  });
  let schedulerDiagnosticRevision = $state(0);

  function touchSchedulerDiagnostics(): void {
    untrack(() => {
      schedulerDiagnosticRevision += 1;
    });
  }
  let cardPageRuntime = $state<Record<PageableCardKey, CardPageRuntime>>({
    quake: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
    weather: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
    flood: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
    tornado: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
  });

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

  function capturePageMeasure(node: HTMLElement, id: string): { destroy: () => void } {
    pageMeasureNodes.set(id, node);
    return {
      destroy: () => pageMeasureNodes.delete(id),
    };
  }

  function captureCenterPageMeasure(node: HTMLElement, id: string): { destroy: () => void } {
    centerPageMeasureNodes.set(id, node);
    return {
      destroy: () => centerPageMeasureNodes.delete(id),
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

  function clearCardPageTimer(): void {
    if (cardPageSchedulerTimer != null) {
      clearTimeout(cardPageSchedulerTimer);
      cardPageSchedulerTimer = null;
    }
  }

  function pagePartitionFor(key: PageableCardKey): CardPagePartition<QuakePage> | CardPagePartition<WeatherPage> | CardPagePartition<FloodPage> | CardPagePartition<TornadoPage> {
    return key === "quake" ? cardPagePartitions.quake
      : key === "weather" ? cardPagePartitions.weather
        : key === "flood" ? cardPagePartitions.flood
          : cardPagePartitions.tornado;
  }

  function pageCardIsVisible(key: PageableCardKey): boolean {
    // 輪番枠は通常列と別経路で描画されるが、改ページ instance にとっては exit ではない。
    // 非 active slot の間も substate を保持し、再登場 event でだけ logical tick を進める。
    if (key === "tornado") return tornado != null && pageCardIsVisible("weather");
    return cardPlacement(layoutPlan, key) != null || schedulerRotationKeys.includes(key);
  }

  function pageKeysFor(key: PageableCardKey): string[] {
    return pageCardIsVisible(key) ? pagePartitionFor(key).identities : [];
  }

  function selfAdvancingPageKeys(): PageableCardKey[] {
    return PAGEABLE_CARD_KEYS.filter((key) => {
      const partition = pagePartitionFor(key);
      return pageCardIsVisible(key) && partition.pages.length > 1
        && (key === "tornado" ? !schedulerRotationKeys.includes("weather") : !schedulerRotationKeys.includes(key));
    });
  }

  function pageSchedulerMode(key: PageableCardKey): "real" | "logical" {
    return key === "tornado"
      ? (schedulerRotationKeys.includes("weather") ? "logical" : "real")
      : schedulerRotationKeys.includes(key) ? "logical" : "real";
  }

  function updateCardPageRuntime(
    key: PageableCardKey,
    activeKey: string | null,
    knownKeys = pageKeysFor(key),
    pendingKeys: readonly string[] = cardPageRuntime[key].pendingKeys,
    cycleOriginKey: string | null = cardPageRuntime[key].cycleOriginKey,
  ): void {
    cardPageRuntime = {
      ...cardPageRuntime,
      [key]: { activeKey, knownKeys: [...knownKeys], pendingKeys: [...pendingKeys], cycleOriginKey },
    };
  }

  function reconcileCardPageRuntime(key: PageableCardKey, reset: boolean): void {
    const nextKeys = pageKeysFor(key);
    const previousRuntime = cardPageRuntime[key];
    const initialMeasurementGrowth = !reset && cardPageProcessedTick === 0 && cardPageTick === 0;
    const nextRuntime = planCardPageRuntimeUpdate(previousRuntime, nextKeys, reset, initialMeasurementGrowth);
    const activeKey = reset && cardPageTickOverride != null && nextKeys.length > 0
      ? nextKeys[cardPageTickOverride % nextKeys.length] ?? nextKeys[0] ?? null
      : nextRuntime.activeKey;
    updateCardPageRuntime(key, activeKey, nextRuntime.knownKeys, nextRuntime.pendingKeys, nextRuntime.cycleOriginKey);
  }

  function advanceCardPageFor(key: PageableCardKey, steps: number): void {
    if (cardPageTickOverride != null || steps <= 0) return;
    const keys = pageKeysFor(key);
    if (keys.length <= 1) return;
    let runtime = cardPageRuntime[key];
    let activeKey = runtime.activeKey;
    let pendingKeys = runtime.pendingKeys;
    let cycleOriginKey = runtime.cycleOriginKey;
    for (let step = 0; step < steps; step += 1) {
      const stableKeys = keys.filter((candidate) => !pendingKeys.includes(candidate));
      const eligibleKeys = stableKeys.length > 0 ? stableKeys : keys;
      const currentIndex = Math.max(0, eligibleKeys.indexOf(activeKey ?? ""));
      const nextStableKey = eligibleKeys[(currentIndex + 1) % eligibleKeys.length] ?? eligibleKeys[0] ?? null;
      if (pendingKeys.length > 0 && cycleOriginKey != null && nextStableKey === cycleOriginKey) {
        // 現在ページを起点に旧集合を一周した。追加ページを次周から解禁する。
        pendingKeys = [];
        cycleOriginKey = null;
        activeKey = nextStableKey;
      } else {
        if (pendingKeys.length > 0) {
          activeKey = nextStableKey;
        } else {
          const nextIndex = Math.max(0, keys.indexOf(activeKey ?? ""));
          activeKey = keys[(nextIndex + 1) % keys.length] ?? keys[0] ?? null;
        }
      }
    }
    updateCardPageRuntime(key, activeKey, keys, pendingKeys, cycleOriginKey);
  }

  function advanceCardPageOnRotation(key: CardKey | null): void {
    if (key !== "quake" && key !== "weather" && key !== "flood") return;
    advanceCardPageFor(key, 1);
    if (key === "weather") advanceCardPageFor("tornado", 1);
  }

  function recordRotationAppearance(key: CardKey | null): void {
    if (key == null) return;
    if (rotationSeenKeys.has(key)) advanceCardPageOnRotation(key);
    rotationSeenKeys.add(key);
  }

  function scheduleCardPageTimer(nowMs = monotonicNowMs(), pageable = true): void {
    clearCardPageTimer();
    const realKeys = selfAdvancingPageKeys();
    if (cardPageTickOverride != null || !pageable || !cardPageSchedulerMounted || realKeys.length === 0) return;
    const nextDeadline = Math.min(...realKeys.map((key) => {
      const substate = cardPageSchedulerSubstates[key];
      return substate.phaseStartedAtMs + (substate.processedTick + 1) * ROTATION_PERIOD_MS;
    }));
    cardPageSchedulerTimer = setTimeout(() => {
      cardPageSchedulerTimer = null;
      if (cardPageEpochBusy) {
        cardPageTickPending = true;
        return;
      }
      processCardPageTick(pageable);
    }, Math.max(0, nextDeadline - nowMs));
  }

  function processCardPageTick(pageable: boolean): void {
    if (!cardPageSchedulerMounted || !pageable || selfAdvancingPageKeys().length === 0) return;
    if (cardPageEpochBusy) {
      cardPageTickPending = true;
      return;
    }
    const nowMs = monotonicNowMs();
    let nextSubstates = { ...cardPageSchedulerSubstates };
    let advanced = false;
    for (const key of selfAdvancingPageKeys()) {
      const substate = nextSubstates[key];
      const elapsedTicks = Math.max(0, Math.floor((nowMs - substate.phaseStartedAtMs) / ROTATION_PERIOD_MS));
      if (elapsedTicks <= substate.processedTick) continue;
      advanceCardPageFor(key, elapsedTicks - substate.processedTick);
      nextSubstates = {
        ...nextSubstates,
        [key]: { ...substate, processedTick: elapsedTicks },
      };
      advanced = true;
    }
    cardPageSchedulerSubstates = nextSubstates;
    const processedTicks = Object.values(nextSubstates).map((substate) => substate.processedTick);
    cardPageProcessedTick = Math.max(0, ...processedTicks);
    cardPageTick = cardPageProcessedTick;
    if (advanced) touchSchedulerDiagnostics();
    scheduleCardPageTimer(nowMs, pageable);
  }

  function syncCardPageScheduler(epochKey: string, pageable: boolean): void {
    if (!cardPageSchedulerMounted || measurementDisposed) return;
    cardPageEpochBusy = true;
    clearCardPageTimer();
    const stage = layoutPlan.stage;
    const currentPageCounts: Record<PageableCardKey, number> = {
      quake: pageCardIsVisible("quake") ? cardPagePartitions.quake.pages.length : 0,
      weather: pageCardIsVisible("weather") ? cardPagePartitions.weather.pages.length : 0,
      flood: pageCardIsVisible("flood") ? cardPagePartitions.flood.pages.length : 0,
      tornado: pageCardIsVisible("tornado") ? cardPagePartitions.tornado.pages.length : 0,
    };
    const initialScheduler = cardPageSchedulerStage == null;
    const nowMs = monotonicNowMs();
    if (cardPageSchedulerEpoch !== epochKey) {
      cardPageSchedulerEpoch = epochKey;
    }
    let nextSubstates = { ...cardPageSchedulerSubstates };
    if (initialScheduler) {
      cardPageSchedulerStage = stage;
      cardPageStartedAtMs = nowMs;
      cardPageProcessedTick = 0;
      cardPageTick = cardPageTickOverride ?? 0;
      for (const key of PAGEABLE_CARD_KEYS) {
        reconcileCardPageRuntime(key, true);
        nextSubstates[key] = {
          mode: pageSchedulerMode(key),
          phaseStartedAtMs: nowMs,
          processedTick: 0,
          pageCount: currentPageCounts[key],
        };
      }
    } else {
      // stage 変更は改ページ instance の exit ではない。現在ページ・pending・位相を
      // 維持し、実際に 1 ページ化したカードだけを page boundary として reset する。
      cardPageSchedulerStage = stage;
      // 1ページ化は改ページインスタンスの exit。再び複数ページへ戻ったときは
      // stage が同じでも reset し、輪番 suspend/resume や通常の repartition とは分離する。
      for (const key of PAGEABLE_CARD_KEYS) {
        const previousCount = cardPageSchedulerPageCounts[key];
        const currentCount = currentPageCounts[key];
        const pageExitBoundary = previousCount > 1 && currentCount <= 1;
        const pageReentryBoundary = previousCount <= 1 && currentCount > 1;
        const previousSubstate = nextSubstates[key];
        const nextMode = pageSchedulerMode(key);
        const modeChanged = previousSubstate.mode !== nextMode;
        reconcileCardPageRuntime(key, pageExitBoundary || pageReentryBoundary);
        nextSubstates[key] = {
          mode: nextMode,
          phaseStartedAtMs: modeChanged || pageExitBoundary || pageReentryBoundary
            ? nowMs
            : previousSubstate.phaseStartedAtMs,
          processedTick: modeChanged || pageExitBoundary || pageReentryBoundary
            ? 0
            : previousSubstate.processedTick,
          pageCount: currentCount,
        };
      }
      if (cardPageTickOverride != null) cardPageTick = cardPageTickOverride;
    }
    cardPageSchedulerSubstates = nextSubstates;
    const activeSubstates = Object.values(nextSubstates).filter((substate) => substate.pageCount > 1);
    if (activeSubstates.length > 0) {
      cardPageStartedAtMs = Math.min(...activeSubstates.map((substate) => substate.phaseStartedAtMs));
      cardPageProcessedTick = Math.max(...activeSubstates.map((substate) => substate.processedTick));
    }
    cardPageSchedulerPageCounts = currentPageCounts;
    touchSchedulerDiagnostics();
    cardPageEpochBusy = false;
    if (cardPageTickPending) {
      cardPageTickPending = false;
      processCardPageTick(pageable);
    } else {
      scheduleCardPageTimer(monotonicNowMs(), pageable);
    }
  }

  function disposeCardPageScheduler(): void {
    cardPageSchedulerMounted = false;
    clearCardPageTimer();
    clearCardPageRefreshTimer();
    cardPageSchedulerEpoch = "";
    cardPageSchedulerStage = null;
    cardPageStartedAtMs = 0;
    cardPageProcessedTick = 0;
    cardPageTick = 0;
    cardPageEpochBusy = false;
    cardPageTickPending = false;
    cardPageSchedulerPageCounts = { quake: 0, weather: 0, flood: 0, tornado: 0 };
    cardPageSchedulerSubstates = {
      quake: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
      weather: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
      flood: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
      tornado: { mode: "real", phaseStartedAtMs: 0, processedTick: 0, pageCount: 0 },
    };
    cardPageRuntime = {
      quake: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
      weather: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
      flood: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
      tornado: { activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null },
    };
    touchSchedulerDiagnostics();
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
    touchSchedulerDiagnostics();
  }

  function reducedMotionRequested(): boolean {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function sameRotationKeys(leftKeys: readonly CardKey[], rightKeys: readonly CardKey[]): boolean {
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
  }

  function resetRotationPhase(key: CardKey, startedAtMs: number): void {
    rotationPhaseKey = key;
    rotationEnteredAtMs = startedAtMs;
    rotationActiveStartedAtMs = startedAtMs;
    rotationProcessedTick = 0;
  }

  function completeRotationTransition(token: number, completedAnimation: Animation): void {
    if (token !== rotationTransitionToken || rotationTransition !== completedAnimation) return;
    if (rotationTransitionDeadlineTimer != null) {
      clearTimeout(rotationTransitionDeadlineTimer);
      rotationTransitionDeadlineTimer = null;
    }
    rotationTransition = null;
    touchSchedulerDiagnostics();
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
    touchSchedulerDiagnostics();
    animation.onfinish = () => completeRotationTransition(token, animation);
    animation.oncancel = () => completeRotationTransition(token, animation);
    rotationTransitionDeadlineTimer = setTimeout(() => {
      if (token !== rotationTransitionToken) return;
      animation.cancel();
      completeRotationTransition(token, animation);
    }, ROTATION_TRANSITION_DEADLINE_MS);
  }

  function applyRotationKey(key: CardKey | null, animate: boolean): void {
    if (key == null || key === rotationActiveKey) return;
    cancelRotationTransition();
    // 空フレームを作らず、新しいカードを同じ枠へ直接差し替える。
    rotationActiveKey = key;
    touchSchedulerDiagnostics();
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
    if (rotationTickOverride != null || rotationSchedulerStage !== 3 || rotationSchedulerSuspended || rotationSchedulerKeys.length === 0) return;
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
    const canonicalKeys = rotationKeysInCanonicalOrder(rotationSchedulerKeys);
    const phaseIndex = rotationPhaseKey == null ? 0 : canonicalKeys.indexOf(rotationPhaseKey);
    const activeIndex = rotationActiveKey == null ? -1 : canonicalKeys.indexOf(rotationActiveKey);
    const originIndex = phaseIndex >= 0 ? phaseIndex : Math.max(0, activeIndex);
    let virtualActiveKey = rotationActiveKey;
    // elapsed tick 数が複数進んだ場合も、途中の再登場を捨てない。最終キーだけを
    // 描画へ反映し、ページ位相だけは各 tick の canonical 順を通過させる。
    for (let tickIndex = rotationProcessedTick + 1; tickIndex <= elapsedTicks; tickIndex += 1) {
      const steppedKey = canonicalKeys[(originIndex + tickIndex) % canonicalKeys.length] ?? null;
      if (steppedKey == null) continue;
      if (steppedKey === virtualActiveKey) {
        // 集合長 1 では key が変わらなくても slot boundary を再登場と数える。
        if (canonicalKeys.length === 1) recordRotationAppearance(steppedKey);
        continue;
      }
      recordRotationAppearance(steppedKey);
      virtualActiveKey = steppedKey;
    }
    rotationProcessedTick = elapsedTicks;
    const nextKey = canonicalKeys[(originIndex + elapsedTicks) % canonicalKeys.length] ?? null;
    applyRotationKey(nextKey, true);
    rotationActiveStartedAtMs = rotationEnteredAtMs + elapsedTicks * ROTATION_PERIOD_MS;
    touchSchedulerDiagnostics();
    scheduleRotationTimer(nowMs);
  }

  function syncRotationScheduler(stage: LadderStage, keys: readonly CardKey[]): void {
    if (!rotationSchedulerMounted || measurementDisposed) return;
    rotationEpochBusy = true;
    const canonicalKeys = rotationKeysInCanonicalOrder(keys);
    const previousStage = rotationSchedulerStage;
    const previousKeys = rotationSchedulerKeys;
    const stageChanged = previousStage !== stage;
    const collectionChanged = !sameRotationKeys(previousKeys, canonicalKeys);
    // measurementSettled の変化だけでは epoch は変わっていない。実際の stage/集合変更か
    // suspend 入口だけで transition を cancel し、settle の再実行で交代を潰さない。
    const enteringSuspend = (stage !== 3 || canonicalKeys.length === 0)
      && previousStage === 3
      && !measurementSettled;
    if (stageChanged || collectionChanged || enteringSuspend) cancelRotationTransition();
    if (stage !== 3 || canonicalKeys.length === 0) {
      if (rotationSchedulerStage === 3 && !measurementSettled) {
        rotationSchedulerSuspended = true;
        clearRotationTimer();
        touchSchedulerDiagnostics();
        rotationEpochBusy = false;
        return;
      }
      clearRotationTimer();
      rotationSchedulerStage = null;
      rotationSchedulerKeys = [];
      rotationSchedulerSuspended = false;
      rotationPhaseKey = null;
      rotationEnteredAtMs = 0;
      rotationActiveStartedAtMs = 0;
      rotationProcessedTick = 0;
      rotationSeenKeys = new Set();
      rotationActiveKey = null;
      rotationTickPending = false;
      touchSchedulerDiagnostics();
      rotationEpochBusy = false;
      return;
    }

    const resuming = rotationSchedulerSuspended;
    const previousKey = rotationActiveKey;
    if (rotationSchedulerStage !== 3) {
      rotationSchedulerStage = 3;
      rotationSchedulerKeys = canonicalKeys;
      rotationSchedulerSuspended = false;
      rotationEnteredAtMs = monotonicNowMs();
      const initialKey = rotationTickOverride == null
        ? canonicalKeys[0]
        : canonicalKeys[rotationTickOverride % canonicalKeys.length];
      if (initialKey != null) resetRotationPhase(initialKey, rotationEnteredAtMs);
      rotationSeenKeys = initialKey == null ? new Set() : new Set([initialKey]);
      applyRotationKey(initialKey ?? null, false);
    } else {
      rotationSchedulerKeys = canonicalKeys;
      rotationSchedulerSuspended = false;
      if (rotationTickOverride != null) {
        applyRotationKey(canonicalKeys[rotationTickOverride % canonicalKeys.length] ?? null, false);
      } else if (collectionChanged) {
        const nowMs = monotonicNowMs();
        if (previousKey != null && canonicalKeys.includes(previousKey)) {
          // 追加・非 active 削除: 現在 key の表示開始時刻を新しい位相の起点にする。
          // 次 tick は新集合での current key の canonical 後続から始まる。
          resetRotationPhase(previousKey, rotationActiveStartedAtMs);
        } else {
          // active 削除: 旧 canonical 後続へ即時交代し、その交代時刻を新しい位相の起点にする。
          const nextKey = nextRotationKeyAfterRemoval(previousKeys, previousKey, canonicalKeys);
          if (nextKey != null) {
            resetRotationPhase(nextKey, nowMs);
            recordRotationAppearance(nextKey);
            applyRotationKey(nextKey, false);
          }
        }
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
    touchSchedulerDiagnostics();
  }

  function disposeRotationScheduler(): void {
    rotationSchedulerMounted = false;
    clearRotationTimer();
    if (rotationTestChangeTimer != null) {
      clearTimeout(rotationTestChangeTimer);
      rotationTestChangeTimer = null;
    }
    cancelRotationTransition();
    rotationSchedulerStage = null;
    rotationSchedulerKeys = [];
    rotationPhaseKey = null;
    rotationEnteredAtMs = 0;
    rotationActiveStartedAtMs = 0;
    rotationProcessedTick = 0;
    rotationSeenKeys = new Set();
    rotationActiveKey = null;
    rotationTickPending = false;
    touchSchedulerDiagnostics();
  }

  function cssPx(value: string | undefined): number {
    const parsed = parseFloat(value ?? "0");
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  function readMeasurements(): void {
    const nextHeights: Record<string, number> = {};
    const nextCenterHeights: Record<string, number> = {};
    // sequential partition は前回 probe の値を次の probe でも再利用する。同一 epoch
    // 内で未表示になった probe を捨てると、先頭から再測定して計算量契約を破る。
    const nextPageHeights: Record<string, number> = { ...measuredPageHeights };
    const nextCenterPageHeights: Record<string, number> = { ...measuredCenterPageHeights };
    const nextFixedHeights: Record<string, number> = {};
    for (const entry of measureEntries) {
      nextHeights[entry.id] = measureNaturalHeight(measureNodes.get(entry.id));
      nextCenterHeights[entry.id] = measureNaturalHeight(centerCardMeasureNodes.get(entry.id));
    }
    for (const entry of pageMeasureEntries) {
      const pageNode = pageMeasureNodes.get(entry.id);
      const centerPageNode = centerPageMeasureNodes.get(entry.id);
      if (pageNode != null) nextPageHeights[entry.id] = measureNaturalHeight(pageNode);
      if (centerPageNode != null) nextCenterPageHeights[entry.id] = measureNaturalHeight(centerPageNode);
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
    measuredPageHeights = nextPageHeights;
    measuredCenterPageHeights = nextCenterPageHeights;
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
    measurementReadCount = measureEntries.length * 2 + pageMeasureEntries.length * 2 + fixedMeasureKeys.length + (nankai == null ? 0 : 1) + 1;
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
      Object.entries(measuredPageHeights).sort(([left], [right]) => left.localeCompare(right)).map(([key, height]) => `${key}:${height}`).join(","),
      Object.entries(measuredCenterPageHeights).sort(([left], [right]) => left.localeCompare(right)).map(([key, height]) => `${key}:${height}`).join(","),
      Object.entries(measuredFixedHeights).sort(([left], [right]) => left.localeCompare(right)).map(([key, height]) => `${key}:${height}`).join(","),
      measuredNankaiHeightPx,
      measuredRotationFailureHeightPx,
    ].join("|");
  }

  async function settleMeasurements(): Promise<void> {
    if (!fontsReady || measurementDisposed) {
      measurementSettled = false;
      return;
    }
    measurementSettled = false;
    let previousSignature = measurementSignature();
    for (let pass = 1; pass < MAX_SETTLE_PASSES; pass += 1) {
      if (measurementDisposed) return;
      // DOM settle pass は最大 4 のまま、各 pass 内では逐次 probe queue を空にする。
      // queue は先頭からの O(N) range だけを持つため、全区間列挙へ戻らずに実測を収束させる。
      let probeSteps = 0;
      const maxProbeSteps = CANDIDATE_SAFE_LIMIT * 2 + 1;
      do {
        await tick();
        if (measurementDisposed) return;
        if (ladderAuto && layoutPlan.stage > settleFloorStage) settleFloorStage = layoutPlan.stage;
        readMeasurements();
        await tick();
        probeSteps += 1;
      } while (pageMeasureEntries.length > 0 && probeSteps < maxProbeSteps);
      const nextSignature = measurementSignature();
      if (
        nextSignature === previousSignature
        && pageMeasureEntries.length === 0
        && fontsReady
        && pageMeasurementCacheKey !== ""
        && layoutPlan.stage === Number.parseInt(nextSignature.split("|")[0] ?? "-1", 10)
      ) {
        measurementSettled = true;
        settledMeasurementEpoch = pageMeasurementCacheKey;
        return;
      }
      previousSignature = nextSignature;
    }
    measurementNonConverged = true;
    measurementSettled = false;
  }

  let measurementSettleInFlight = false;

  function requestMeasurementSettle(): void {
    if (!fontsReady || measurementDisposed || measurementSettleInFlight) return;
    measurementSettleInFlight = true;
    void settleMeasurements().finally(() => {
      measurementSettleInFlight = false;
      if (!measurementSettled && fontsReady && !measurementDisposed && pageMeasureEntries.length > 0) {
        requestMeasurementSettle();
      }
    });
  }

  function startFontReadiness(): void {
    const fontReady = typeof document !== "undefined" ? document.fonts?.ready : undefined;
    if (fontReady == null) {
      fontsReady = true;
      requestMeasurementSettle();
      return;
    }
    void fontReady.then(() => {
      if (measurementDisposed) return;
      fontsReady = true;
      measurementSettled = false;
      requestMeasurementSettle();
    });
  }

  onMount(() => {
    measurementDisposed = false;
    readMeasurements();
    rotationSchedulerMounted = true;
    syncRotationScheduler(layoutPlan.stage, schedulerRotationKeys);
    cardPageSchedulerMounted = true;
    scheduleRotationTestMutation();
    scheduleStageSequence();
    scheduleFixtureRemoval();
    scheduleCardPageRefresh();
    startFontReadiness();
    return () => {
      measurementDisposed = true;
      stageTransitionTimers.forEach((timer) => clearTimeout(timer));
      stageTransitionTimers = [];
      clearFixtureRemovalTimer();
      disposeRotationScheduler();
      disposeCardPageScheduler();
    };
  });

  function maxRegionRows(key: ExpandableCardKey): number {
    return key === "quake" ? quakeExpansionMaxRows : weatherExpansionMaxRows;
  }

  function regionMeasureId(key: ExpandableCardKey, regionRows: number): string {
    if (regionRows <= 0) return `${key}:compact`;
    return regionRows >= maxRegionRows(key) ? `${key}:expanded` : `${key}:region:${regionRows}`;
  }

  function measureId(key: CardKey, variant: CardVariant, regionRows = 0, floodWide = false): string {
    if (key === "flood" && floodWide) return "flood:wide";
    if (key === "quake" || key === "weather") return regionMeasureId(key, regionRows);
    return key === "typhoon" ? `${key}:${variant}` : key;
  }

  function quakeForRegionRows(regionRows: number): DisplayLatestQuakeStateV1 {
    if (regionRows <= 0) return compactQuakeState;
    let remainingRows = Math.min(regionRows, quakeExpansionMaxRows);
    return {
      ...compactQuakeState,
      intensityGroups: compactQuakeState.intensityGroups.map((compactGroup) => {
        const expandedGroup = expandedQuakeState.intensityGroups.find((group) =>
          group.intensity === compactGroup.intensity && group.rank === compactGroup.rank
        ) ?? compactGroup;
        const totalAreas = Math.max(expandedGroup.areas.length, compactGroup.areas.length + compactGroup.omittedAreaCount);
        const availableRows = Math.max(0, expandedGroup.areas.length - compactGroup.areas.length);
        const addedRows = Math.min(remainingRows, availableRows);
        remainingRows -= addedRows;
        const visibleCount = compactGroup.areas.length + addedRows;
        return {
          ...compactGroup,
          areas: expandedGroup.areas.slice(0, visibleCount),
          omittedAreaCount: Math.max(0, totalAreas - visibleCount),
        };
      }),
    };
  }

  function weatherForRegionRows(regionRows: number): DisplayWeatherAlertV1[] {
    if (regionRows <= 0) return compactWeatherAlerts;
    let remainingRows = Math.min(regionRows, weatherExpansionMaxRows);
    return fullWeatherAlerts.map((alert, alertIndex) => {
      const compactAlert = compactWeatherAlerts[alertIndex];
      const items = alert.items.map((expandedItem, itemIndex) => {
        const compactItem = compactAlert?.items[itemIndex];
        if (compactItem == null) return expandedItem;
        const totalAreas = Math.max(
          expandedItem.shownAreas.length,
          compactItem.shownAreas.length + compactItem.omittedAreaCount,
        );
        const availableRows = Math.max(0, expandedItem.shownAreas.length - compactItem.shownAreas.length);
        const addedRows = Math.min(remainingRows, availableRows);
        remainingRows -= addedRows;
        const visibleCount = compactItem.shownAreas.length + addedRows;
        return {
          ...expandedItem,
          shownAreas: expandedItem.shownAreas.slice(0, visibleCount),
          omittedAreaCount: Math.max(0, totalAreas - visibleCount),
        };
      });
      return {
        ...alert,
        totalAreas: items.reduce((total, item) => total + item.shownAreas.length + item.omittedAreaCount, 0),
        items,
      };
    });
  }

  function fullQuakeGroups(): DisplayIntensityGroupV1[] {
    if (tailOnlyFixtureRequested) {
      return compactQuakeState.intensityGroups.map((group) => ({
        ...group,
        areas: [],
      }));
    }
    if (cardPageCollapseRequested && cardPageFixtureRevision === 1) {
      // 共通 contract test の exit=1 page 境界。revision 2 以降は通常候補へ戻し、
      // 再進入時に改ページ scheduler が reset されることを観測できるようにする。
      return compactQuakeState.intensityGroups.map((group) => ({
        ...group,
        areas: [...group.areas],
        omittedAreaCount: 0,
      }));
    }
    let groups = compactQuakeState.intensityGroups.map((compactGroup) => {
      const expandedGroup = expandedQuakeState.intensityGroups.find((group) =>
        group.intensity === compactGroup.intensity && group.rank === compactGroup.rank
      ) ?? compactGroup;
      return {
        ...compactGroup,
        areas: [...expandedGroup.areas],
        omittedAreaCount: 0,
      };
    });
    if (cardPageRefreshRequested && cardPageFixtureRevision > 0) {
      groups = groups.map((group) => group.intensity === "5強"
        ? { ...group, areas: [...group.areas, "高千穂町"] }
        : group);
    }
    if (cardPageRefreshDeleteOriginRequested && cardPageFixtureRevision >= 2) {
      const firstNonEmpty = groups.findIndex((group) => group.areas.length > 0);
      if (firstNonEmpty >= 0) {
        groups = groups.map((group, index) => index === firstNonEmpty
          ? { ...group, areas: group.areas.slice(1) }
          : group);
      }
    }
    return groups;
  }

  function quakeGroupKey(group: DisplayIntensityGroupV1): string {
    return `${group.intensity}:${group.rank}`;
  }

  function intensityGroupCandidateTruncated(group: DisplayIntensityGroupV1): boolean {
    return (group as CandidateTruncatedIntensityGroup).candidateTruncated === true;
  }

  function weatherCandidateTruncated(alerts: readonly DisplayWeatherAlertV1[]): boolean {
    return alerts.some((alert) => alert.items.some((item) =>
      (item as CandidateTruncatedWeatherItem).candidateTruncated === true
    ));
  }

  function candidateSupplyLimit(): number {
    return cardPageCandidateTruncatedRequested ? CANDIDATE_TEST_LIMIT : CANDIDATE_SAFE_LIMIT;
  }

  function suppliedQuakeGroups(): SuppliedQuakeGroups {
    const fullGroups = fullQuakeGroups();
    if (tailOnlyFixtureRequested) {
      return {
        groups: fullGroups.map((group) => ({ ...group, areas: [], omittedAreaCount: 0 })),
        tails: fullGroups
          .filter((group) => group.omittedAreaCount > 0)
          .map((group) => ({ kindKey: quakeGroupKey(group), omittedAreaCount: group.omittedAreaCount })),
        truncated: true,
        fullAreaKeys: [],
      };
    }
    const fullAreaKeys = fullGroups.flatMap((group) => group.areas);
    let remaining = candidateSupplyLimit();
    const groups = fullGroups.map((group) => {
      const suppliedCount = Math.min(group.areas.length, Math.max(0, remaining));
      const areas = group.areas.slice(0, suppliedCount);
      remaining -= areas.length;
      return { ...group, areas, omittedAreaCount: 0 };
    });
    const tails = fullGroups.flatMap((group, index) => {
      const omittedAreaCount = group.areas.length - (groups[index]?.areas.length ?? 0);
      return omittedAreaCount > 0
        ? [{ kindKey: quakeGroupKey(group), omittedAreaCount }]
        : [];
    });
    return {
      groups,
      tails,
      truncated: fullGroups.some(intensityGroupCandidateTruncated)
        || fullAreaKeys.length > groups.reduce((total, group) => total + group.areas.length, 0),
      fullAreaKeys,
    };
  }

  function pageTailCount(tails: readonly PageTail[], kindKey: string): number {
    return tails.find((tail) => tail.kindKey === kindKey)?.omittedAreaCount ?? 0;
  }

  function quakeTailEntriesForRange(
    groups: readonly DisplayIntensityGroupV1[],
    tails: readonly PageTail[],
    start: number,
    end: number,
    areaCount: number,
  ): PageTail[] {
    const result: PageTail[] = [];
    let offset = 0;
    for (const group of groups) {
      const groupStart = offset;
      const groupEnd = offset + group.areas.length;
      offset = groupEnd;
      const tail = tails.find((entry) => entry.kindKey === quakeGroupKey(group));
      if (tail == null) continue;
      const hasVisibleTail = groupEnd > start && groupEnd <= end;
      const zeroGroupInPage = groupStart === groupEnd && (
        (start <= groupStart && groupStart < end)
        || (areaCount === 0 && start === 0 && end === 0)
        || (groupStart === areaCount && end === areaCount && start < end)
      );
      if (hasVisibleTail || zeroGroupInPage) result.push(tail);
    }
    return result;
  }

  function weatherTailEntriesForRange(
    items: readonly WeatherPageItem[],
    tails: readonly PageTail[],
    start: number,
    end: number,
    areaCount: number,
  ): PageTail[] {
    const result: PageTail[] = [];
    let offset = 0;
    for (const entry of items) {
      const groupStart = offset;
      const groupEnd = offset + entry.areas.length;
      offset = groupEnd;
      const tail = tails.find((candidate) => candidate.kindKey === entry.item.kind);
      if (tail == null) continue;
      const hasVisibleTail = groupEnd > start && groupEnd <= end;
      const zeroGroupInPage = groupStart === groupEnd && (
        (start <= groupStart && groupStart < end)
        || (areaCount === 0 && start === 0 && end === 0)
        || (groupStart === areaCount && end === areaCount && start < end)
      );
      if (hasVisibleTail || zeroGroupInPage) result.push(tail);
    }
    return result;
  }

  function quakeGroupsForRange(
    groups: readonly DisplayIntensityGroupV1[],
    start: number,
    end: number,
    tails: readonly PageTail[] = [],
  ): DisplayIntensityGroupV1[] {
    let offset = 0;
    const selected = groups.map((group) => {
      const groupStart = offset;
      offset += group.areas.length;
      const areas = group.areas.slice(Math.max(0, start - groupStart), Math.max(0, end - groupStart));
      return {
        ...group,
        areas,
        omittedAreaCount: pageTailCount(tails, quakeGroupKey(group)),
      };
    }).filter((group) => group.areas.length > 0 || group.omittedAreaCount > 0);
    return selected;
  }

  function quakeAreaEntries(groups: readonly DisplayIntensityGroupV1[]): PageAreaEntry[] {
    const occurrenceByArea = new Map<string, number>();
    return groups.flatMap((group) => {
      const kindKey = quakeGroupKey(group);
      return group.areas.map((area) => {
        const occurrenceKey = `${kindKey}\u0000${area}`;
        const occurrenceIndex = occurrenceByArea.get(occurrenceKey) ?? 0;
        occurrenceByArea.set(occurrenceKey, occurrenceIndex + 1);
        return { kindKey, area, occurrenceIndex };
      });
    });
  }

  function quakePageFromRange(
    groups: readonly DisplayIntensityGroupV1[],
    start: number,
    end: number,
    tails: readonly PageTail[] = [],
  ): QuakePage {
    const pageEntries = quakeAreaEntries(groups).slice(start, end);
    const firstTail = tails[0];
    return {
      state: { ...compactQuakeState, intensityGroups: quakeGroupsForRange(groups, start, end, tails) },
      firstArea: pageEntries[0]?.area ?? firstTail?.kindKey ?? "",
      identity: pageEntries[0] == null
        ? firstTail == null ? "" : `${firstTail.kindKey}|<tail>|0`
        : pageIdentityForEntry(pageEntries[0]),
      areaKeys: pageEntries.map((entry) => entry.area),
      tails: [...tails],
    };
  }

  function quakeSelectedPage(regionRows: number): QuakePage {
    const selectedState = quakeForRegionRows(regionRows);
    const state = cardPageCollapseRequested && cardPageFixtureRevision === 1
      ? {
          ...selectedState,
          intensityGroups: selectedState.intensityGroups.map((group) => ({
            ...group,
            omittedAreaCount: 0,
          })),
        }
      : selectedState;
    const pageEntries = quakeAreaEntries(state.intensityGroups);
    return {
      state,
      firstArea: pageEntries[0]?.area ?? "",
      identity: pageEntries[0] == null ? "" : pageIdentityForEntry(pageEntries[0]),
      areaKeys: pageEntries.map((entry) => entry.area),
      tails: [],
    };
  }

  function weatherRankValue(rank: DisplayWeatherAlertV1["role"]): number {
    if (rank === "weatherEmergency") return 3;
    if (rank === "weatherWarning") return 2;
    return 1;
  }

  function mergeWeatherPageItems(alerts: readonly DisplayWeatherAlertV1[]): WeatherPageItem[] {
    const allItems = alerts.flatMap((alert) => alert.items.map((item) => ({ alert, item })));
    const topRank = Math.max(0, ...allItems.map(({ alert }) => weatherRankValue(alert.role)));
    const merged: WeatherPageItem[] = [];
    const indexByKind = new Map<string, number>();
    for (const { alert, item } of allItems) {
      if (weatherRankValue(alert.role) !== topRank) continue;
      const existingIndex = indexByKind.get(item.kind);
      if (existingIndex == null) {
        indexByKind.set(item.kind, merged.length);
        merged.push({
          templateAlert: alert,
          item: { ...item, shownAreas: [], omittedAreaCount: item.omittedAreaCount },
          areas: [],
        });
      }
      const target = merged[indexByKind.get(item.kind) ?? 0];
      for (const area of item.shownAreas) {
        if (!target.areas.includes(area)) target.areas.push(area);
      }
    }
    return merged;
  }

  function suppliedWeatherItems(): SuppliedWeatherItems {
    const fullItems = mergeWeatherPageItems(fullWeatherAlerts);
    if (tailOnlyFixtureRequested) {
      return {
        items: fullItems.map((entry) => ({
          ...entry,
          areas: [],
          item: { ...entry.item, shownAreas: [], omittedAreaCount: entry.item.omittedAreaCount },
        })),
        tails: fullItems
          .filter((entry) => entry.item.omittedAreaCount > 0)
          .map((entry) => ({ kindKey: entry.item.kind, omittedAreaCount: entry.item.omittedAreaCount })),
        truncated: true,
        fullAreaKeys: [],
      };
    }
    const fullAreaKeys = fullItems.flatMap((entry) => entry.areas);
    let remaining = candidateSupplyLimit();
    const items = fullItems.map((entry) => {
      const areas = entry.areas.slice(0, Math.max(0, remaining));
      remaining -= areas.length;
      return { ...entry, areas };
    });
    const tails = fullItems.flatMap((entry, index) => {
      const omittedAreaCount = entry.areas.length - (items[index]?.areas.length ?? 0);
      return omittedAreaCount > 0
        ? [{ kindKey: entry.item.kind, omittedAreaCount }]
        : [];
    });
    return {
      items,
      tails,
      truncated: weatherCandidateTruncated(fullWeatherAlerts)
        || fullAreaKeys.length > items.reduce((total, entry) => total + entry.areas.length, 0),
      fullAreaKeys,
    };
  }

  function weatherItemsForRange(
    items: readonly WeatherPageItem[],
    start: number,
    end: number,
    tails: readonly PageTail[] = [],
  ): WeatherPageItem[] {
    let offset = 0;
    const selected = items.map((entry) => {
      const itemStart = offset;
      offset += entry.areas.length;
      const areas = entry.areas.slice(Math.max(0, start - itemStart), Math.max(0, end - itemStart));
      const omittedAreaCount = pageTailCount(tails, entry.item.kind);
      return {
        ...entry,
        item: { ...entry.item, shownAreas: areas, omittedAreaCount },
        areas,
      };
    }).filter((entry) => entry.areas.length > 0 || entry.item.omittedAreaCount > 0);
    return selected;
  }

  function weatherAreaEntries(items: readonly WeatherPageItem[]): PageAreaEntry[] {
    const occurrenceByArea = new Map<string, number>();
    return items.flatMap((entry) => entry.areas.map((area) => {
      const kindKey = entry.item.kind;
      const occurrenceKey = `${kindKey}\u0000${area}`;
      const occurrenceIndex = occurrenceByArea.get(occurrenceKey) ?? 0;
      occurrenceByArea.set(occurrenceKey, occurrenceIndex + 1);
      return { kindKey, area, occurrenceIndex };
    }));
  }

  function weatherPageFromRange(
    items: readonly WeatherPageItem[],
    start: number,
    end: number,
    totalAreaCount: number,
    tails: readonly PageTail[] = [],
  ): WeatherPage {
    const selected = weatherItemsForRange(items, start, end, tails);
    const pageEntries = weatherAreaEntries(items).slice(start, end);
    const firstTail = tails[0];
    const templateAlert = selected[0]?.templateAlert ?? fullWeatherAlerts[0];
    const alerts = templateAlert == null || selected.length === 0
      ? []
      : [{
          ...templateAlert,
          totalAreas: totalAreaCount,
          items: selected.map((entry) => ({ ...entry.item, shownAreas: [...entry.areas] })),
        }];
    return {
      alerts,
      firstArea: pageEntries[0]?.area ?? firstTail?.kindKey ?? "",
      identity: pageEntries[0] == null
        ? firstTail == null ? "" : `${firstTail.kindKey}|<tail>|0`
        : pageIdentityForEntry(pageEntries[0]),
      areaKeys: pageEntries.map((entry) => entry.area),
      tails: [...tails],
    };
  }

  function weatherSelectedPage(regionRows: number): WeatherPage {
    const alerts = weatherForRegionRows(regionRows);
    const pageEntries = weatherAreaEntries(mergeWeatherPageItems(alerts));
    return {
      alerts,
      firstArea: pageEntries[0]?.area ?? "",
      identity: pageEntries[0] == null ? "" : pageIdentityForEntry(pageEntries[0]),
      areaKeys: pageEntries.map((entry) => entry.area),
      tails: [],
    };
  }

  function pageTailSignature(tails: readonly PageTail[]): string {
    return tails.map((tail) => `${encodeURIComponent(tail.kindKey)}=${tail.omittedAreaCount}`).join(",");
  }

  function pageMeasureId(key: PagePartitionKey, start: number, end: number, tails: readonly PageTail[] = []): string {
    if (tails.length === 0) return `${key}:page:${start}:${end}`;
    const omittedAreaCount = tails.reduce((total, tail) => total + tail.omittedAreaCount, 0);
    return `${key}:page:${start}:${end}:omitted:${omittedAreaCount}:tails:${pageTailSignature(tails)}`;
  }

  function pageRangeHeight(
    key: PagePartitionKey,
    start: number,
    end: number,
    placement: "side" | "center",
    tails: readonly PageTail[] = [],
  ): number | undefined {
    const id = pageMeasureId(key, start, end, tails);
    return placement === "center" ? measuredCenterPageHeights[id] : measuredPageHeights[id];
  }

  function scanPagePartition(key: MeasurablePageKey, regionRows: number): PagePartitionScan {
    const selected = key === "quake" ? quakeSelectedPage(regionRows) : weatherSelectedPage(regionRows);
    const suppliedQuake = key === "quake" ? suppliedQuakeGroups() : null;
    const suppliedWeather = key === "weather" ? suppliedWeatherItems() : null;
    const suppliedAreaCount = suppliedQuake == null
      ? suppliedWeather?.items.reduce((total, entry) => total + entry.areas.length, 0) ?? 0
      : suppliedQuake.groups.reduce((total, group) => total + group.areas.length, 0);
    const suppliedTruncated = suppliedQuake?.truncated ?? suppliedWeather?.truncated ?? false;
    const suppliedFullAreaCount = suppliedQuake?.fullAreaKeys.length ?? suppliedWeather?.fullAreaKeys.length ?? 0;
    const areaCount = suppliedAreaCount;
    const selectedOmitted = key === "quake"
      ? (selected as QuakePage).state.intensityGroups.reduce((total, group) => total + group.omittedAreaCount, 0)
      : weatherForRegionRows(regionRows).reduce((total, alert) => total + alert.items.reduce((subtotal, item) => subtotal + item.omittedAreaCount, 0), 0);
    const needsPages = areaCount > selected.areaKeys.length || selectedOmitted > 0 || suppliedTruncated;
    if (!needsPages) {
      return {
        ranges: [],
        pending: [],
        infeasible: false,
        probeCount: 0,
        usesCandidate: false,
        candidateTruncated: suppliedTruncated,
        areaCount,
        fullAreaCount: suppliedFullAreaCount,
      };
    }
    const placement = cardPlacement(layoutPlan, key) === "center" ? "center" : "side";
    const fixedHeight = measuredHeight(key, "expanded", placement, regionRows);
    const tailEntriesForRange = key === "quake"
      ? (start: number, end: number) => quakeTailEntriesForRange(
        suppliedQuake?.groups ?? [],
        suppliedQuake?.tails ?? [],
        start,
        end,
        areaCount,
      )
      : (start: number, end: number) => weatherTailEntriesForRange(
        suppliedWeather?.items ?? [],
        suppliedWeather?.tails ?? [],
        start,
        end,
        areaCount,
      );
    const scan = partitionRanges(
      key,
      placement,
      areaCount,
      fixedHeight,
      (probeKey, probePlacement, range) => pageRangeHeight(
        probeKey,
        range.start,
        range.end,
        probePlacement,
        range.tails,
      ) ?? null,
      (range) => tailEntriesForRange(range.start, range.end),
    );
    return {
      ...scan,
      pending: scan.pending,
      usesCandidate: true,
      candidateTruncated: suppliedTruncated,
      areaCount,
      fullAreaCount: suppliedFullAreaCount,
    };
  }

  function partitionQuakePages(regionRows: number): CardPagePartition<QuakePage> {
    const selected = quakeSelectedPage(regionRows);
    const scan = pageScans.quake;
    if (!scan.usesCandidate) {
      return { pages: [selected], keys: [], identities: [], usesCandidate: false, infeasible: false, candidateTruncated: scan.candidateTruncated, probeCount: scan.probeCount };
    }
    if (scan.infeasible) {
      return { pages: [selected], keys: [], identities: [], usesCandidate: false, infeasible: true, candidateTruncated: scan.candidateTruncated, probeCount: scan.probeCount };
    }
    const supplied = suppliedQuakeGroups();
    const pages = scan.ranges.map((range) => quakePageFromRange(
      supplied.groups,
      range.start,
      range.end,
      range.tails,
    ));
    return {
      pages,
      keys: pages.map((page) => page.firstArea),
      identities: pages.map((page) => page.identity),
      usesCandidate: true,
      infeasible: false,
      candidateTruncated: scan.candidateTruncated,
      probeCount: scan.probeCount,
    };
  }

  function partitionWeatherPages(regionRows: number): CardPagePartition<WeatherPage> {
    const selected = weatherSelectedPage(regionRows);
    const scan = pageScans.weather;
    if (!scan.usesCandidate) {
      return { pages: [selected], keys: [], identities: [], usesCandidate: false, infeasible: false, candidateTruncated: scan.candidateTruncated, probeCount: scan.probeCount };
    }
    if (scan.infeasible) {
      return { pages: [selected], keys: [], identities: [], usesCandidate: false, infeasible: true, candidateTruncated: scan.candidateTruncated, probeCount: scan.probeCount };
    }
    const supplied = suppliedWeatherItems();
    const pages = scan.ranges.map((range) => weatherPageFromRange(
      supplied.items,
      range.start,
      range.end,
      supplied.fullAreaKeys.length,
      range.tails,
    ));
    return {
      pages,
      keys: pages.map((page) => page.firstArea),
      identities: pages.map((page) => page.identity),
      usesCandidate: true,
      infeasible: false,
      candidateTruncated: scan.candidateTruncated,
      probeCount: scan.probeCount,
    };
  }

  // The preview owns its pager rather than importing the live coordinator.
  // Keep flood equally observable here with a deterministic two-river page;
  // live partitioning remains shelf-probe based in StandbyScreen.
  function partitionFloodPages(): CardPagePartition<FloodPage> {
    const rivers = flood?.data.rivers ?? [];
    const ranges: PageRange[] = [];
    for (let start = 0; start < rivers.length; start += 2) {
      ranges.push({ start, end: Math.min(rivers.length, start + 2), tails: [], omittedAreaCount: 0 });
    }
    if (ranges.length === 0) ranges.push({ start: 0, end: 0, tails: [], omittedAreaCount: 0 });
    const pages = ranges.map((range, index) => {
      const first = rivers[range.start];
      return {
        range,
        firstArea: first?.riverName ?? `page-${index + 1}`,
        identity: first == null ? `flood|page-${index + 1}|0` : `${first.kindName}|${first.riverName}|0|code:${first.riverKey}`,
        areaKeys: rivers.slice(range.start, range.end).map((river) => river.riverName),
        tails: [],
      };
    });
    return { pages, keys: pages.map((page) => page.firstArea), identities: pages.map((page) => page.identity), usesCandidate: ranges.length > 1, infeasible: false, candidateTruncated: false, probeCount: 0 };
  }

  // Preview は live coordinator を輸入しない独立 pager。rider も二件ずつに
  // 分割して、同名は occurrence を含む identity で保持する。
  function partitionTornadoPages(): CardPagePartition<TornadoPage> {
    const occurrenceByArea = new Map<string, number>();
    const entries = tornadoFullAreas.map((area) => {
      const occurrenceIndex = occurrenceByArea.get(area) ?? 0;
      occurrenceByArea.set(area, occurrenceIndex + 1);
      return { kindKey: "tornado", area, occurrenceIndex } satisfies PageAreaEntry;
    });
    if (entries.length === 0) return EMPTY_TORNADO_PAGE_PARTITION;
    const pages: TornadoPage[] = [];
    for (let start = 0; start < entries.length; start += 2) {
      const selected = entries.slice(start, Math.min(entries.length, start + 2));
      const first = selected[0];
      if (first == null) continue;
      pages.push({
        range: { start, end: start + selected.length, tails: [], omittedAreaCount: 0 },
        areas: selected.map((entry) => entry.area),
        firstArea: first.area,
        identity: pageIdentityForEntry(first),
        areaKeys: selected.map((entry) => entry.area),
        tails: [],
      });
    }
    return { pages, keys: pages.map((page) => page.firstArea), identities: pages.map((page) => page.identity), usesCandidate: pages.length > 1, infeasible: false, candidateTruncated: false, probeCount: pages.length };
  }

  function quakeProbeForRange(start: number, end: number, tails: readonly PageTail[] = []): DisplayLatestQuakeStateV1 {
    const supplied = suppliedQuakeGroups();
    return {
      ...compactQuakeState,
      intensityGroups: quakeGroupsForRange(supplied.groups, start, end, tails),
    };
  }

  function weatherProbeForRange(start: number, end: number, tails: readonly PageTail[] = []): DisplayWeatherAlertV1[] {
    const supplied = suppliedWeatherItems();
    const selected = weatherItemsForRange(supplied.items, start, end, tails);
    const templateAlert = selected[0]?.templateAlert ?? fullWeatherAlerts[0];
    if (templateAlert == null || selected.length === 0) return [];
    return [{
      ...templateAlert,
      totalAreas: selected.reduce((total, entry) => total + entry.areas.length + entry.item.omittedAreaCount, 0),
      items: selected.map((entry) => ({ ...entry.item, shownAreas: [...entry.areas], omittedAreaCount: entry.item.omittedAreaCount })),
    }];
  }

  function regionRemainingCount(key: CardKey, regionRows: number): number {
    if (key === "quake") return quakeForRegionRows(regionRows).intensityGroups.reduce((total, group) => total + group.omittedAreaCount, 0);
    if (key === "weather") return weatherForRegionRows(regionRows).reduce(
      (total, alert) => total + alert.items.reduce((subtotal, item) => subtotal + item.omittedAreaCount, 0),
      0,
    );
    return 0;
  }

  function measuredHeight(
    key: CardKey,
    variant: CardVariant,
    placement: "side" | "center" = "side",
    regionRows = 0,
    floodWide = false,
  ): number {
    const actualFloodWide = key === "flood" && floodIsWide && (floodWide || placement === "center");
    const id = measureId(key, variant, regionRows, actualFloodWide);
    return (placement === "center" ? measuredCenterHeights[id] : measuredHeights[id]) ?? 0;
  }

  function contentScore(key: CardKey): number {
    if (key === "tsunami") return (tsunami?.coasts.length ?? 0) + 3;
    if (key === "quake") return 6 + compactQuakeState.intensityGroups.length * 2 + (longPeriod == null ? 0 : 1);
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

  function centerCapacityPx(): number {
    return layoutCapacityPx();
  }

  // 描画済みではなく、テンプレートの natural-height 診断に表示する基準値。
  function columnNaturalHeight(cards: readonly CardCandidate[]): number {
    return cards.reduce((total, card) => total + card.naturalHeight, 0)
      + Math.max(0, cards.length - 1) * columnGapPx();
  }

  function rightNaturalHeight(
    cards: readonly CardCandidate[],
    rotationSlotHeight: number,
    failureHeight: number,
  ): number {
    let total = columnNaturalHeight(cards);
    if (rotationSlotHeight > 0) total += (cards.length > 0 ? columnGapPx() : 0) + rotationSlotHeight;
    if (failureHeight > 0) total += columnGapPx() + failureHeight;
    return total;
  }

  function placementSelectedCenterHeight(
    choice: PlacementChoice,
    selection: DisplaySelection,
  ): number {
    const cardHeight = selectedColumnHeight(choice.center, "center", selection);
    const fixedHeights = fixedMeasureKeys.map((key) => measuredFixedHeights[key] ?? 0);
    const totalCount = choice.center.length + fixedHeights.length;
    return cardHeight + fixedHeights.reduce((total, height) => total + height, 0)
      + Math.max(0, totalCount - 1) * columnGapPx();
  }

  function placementSelectedRightHeight(
    choice: PlacementChoice,
    selection: DisplaySelection,
    rotationSlotHeight: number,
    failureHeight: number,
  ): number {
    let total = selectedColumnHeight(choice.right, "right", selection);
    if (rotationSlotHeight > 0) total += (choice.right.length > 0 ? columnGapPx() : 0) + rotationSlotHeight;
    if (failureHeight > 0) total += columnGapPx() + failureHeight;
    return total;
  }

  function buildCandidates(variants: VariantSelection): CardCandidate[] {
    return cardKeys.filter((key) => !fixtureRemovedKeys.includes(key)).map((key) => {
      const order = cardKeys.indexOf(key);
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
        measurements: {
          compact: { naturalHeight: measuredHeight(key, "compact"), centerNaturalHeight: measuredHeight(key, "compact", "center") },
          expanded: { naturalHeight: measuredHeight(key, "expanded"), centerNaturalHeight: measuredHeight(key, "expanded", "center") },
          full: { naturalHeight: measuredHeight(key, "full"), centerNaturalHeight: measuredHeight(key, "full", "center") },
        },
        maxRegionRows: key === "quake" || key === "weather" ? maxRegionRows(key) : 0,
      };
    });
  }

  function rotationKeysInCanonicalOrder(keys: readonly CardKey[]): CardKey[] {
    return [...keys].sort((leftKey, rightKey) => cardKeys.indexOf(leftKey) - cardKeys.indexOf(rightKey));
  }

  function solverContext(plan: ColumnPlan | null = null): SolverContext {
    const capacity = layoutCapacityPx();
    return {
      measuredHeight: (key, variant) => measuredHeight(key, variant),
      measureSelection: (choice, selection) => ({
        leftOverflowPx: selectedColumnHeight(choice.left, "left", selection) - capacity,
        rightOverflowPx: placementSelectedRightHeight(
          choice,
          selection,
          plan?.rotationSlotHeight ?? 0,
          plan?.rotationFailureCount != null && plan.rotationFailureCount > 0 ? measuredRotationFailureHeightPx : 0,
        ) - capacity,
        centerOverflowPx: choice.center.length === 0 ? 0 : placementSelectedCenterHeight(choice, selection) - centerCapacityPx(),
      }),
      capacityPx: { left: capacity, right: capacity, center: centerCapacityPx() },
      centerFixedHeightPx: centerFixedNaturalHeight(),
      floodIsWide,
      // The preview has no live measurement shelf. Keep its fixture request
      // deterministic; live eligibility is exclusively the dedicated probe.
      floodWidePromotionAllowed: floodIsWide && flood != null,
      candidateSupplyLimit: candidateSupplyLimit(),
      rotationSlotHeight: (keys) => Math.max(0, ...keys.map((key) => measuredHeight(key, "compact"))),
      failureRowHeight: measuredRotationFailureHeightPx,
      gapPx: columnGapPx(),
    };
  }

  function makeColumnPlan(): ColumnPlan {
    const requestedLadder = stageFixtureOverride ?? ladderOverride;
    const fullVariants: VariantSelection = { quake: "compact", weather: "compact", typhoon: "full" };
    return solveColumnPlan({
      candidates: buildCandidates(fullVariants),
      ctx: solverContext(),
      floorStage: settleFloorStage,
      requestedLadder,
    });
  }

  const baselinePlan = $derived(makeColumnPlan());

  // A の配置・stage を確定した後だけに使う B。カードの所属列は一切再計算せず、
  // compact 昇格 → quake→weather の行 prefix 展開を残余容量へ順に当てる。
  const layoutPlan = $derived(baselinePlan);

  const schedulerRotationKeys = $derived.by(() => layoutPlan.stage === 3
    ? rotationKeysInCanonicalOrder(rotationTestKeys ?? layoutPlan.rotationKeys)
    : []);

  function scheduleRotationTestMutation(): void {
    if (rotationTestChange == null) return;
    rotationTestChangeTimer = setTimeout(() => {
      rotationTestChangeTimer = null;
      const currentKeys = rotationTestKeys ?? layoutPlan.rotationKeys;
      if (rotationTestChange.action === "add") {
        if (!currentKeys.includes(rotationTestChange.key)) rotationTestKeys = [...currentKeys, rotationTestChange.key];
      } else {
        rotationTestKeys = currentKeys.filter((key) => key !== rotationTestChange.key);
      }
    }, rotationTestChangeAtMs);
  }

  function scheduleStageSequence(): void {
    stageTransitionTimers.forEach((timer) => clearTimeout(timer));
    stageTransitionTimers = stageSequence.map((entry) => setTimeout(() => {
      if (measurementDisposed) return;
      stageFixtureOverride = entry.stage;
      measurementSettled = false;
      settledMeasurementEpoch = "";
      requestMeasurementSettle();
    }, entry.atMs));
  }

  function clearFixtureRemovalTimer(): void {
    if (fixtureRemovalTimer != null) {
      clearTimeout(fixtureRemovalTimer);
      fixtureRemovalTimer = null;
    }
  }

  function scheduleFixtureRemoval(): void {
    clearFixtureRemovalTimer();
    if (fixtureRemovalKeys.length === 0) return;
    fixtureRemovalTimer = setTimeout(() => {
      fixtureRemovalTimer = null;
      if (measurementDisposed) return;
      fixtureRemovedKeys = [...fixtureRemovalKeys];
      // 入力集合が実際に縮んだ epoch では、過去の stage floor を持ち越さず再解決する。
      // これが stage 3 の実 exit を発生させ、空の rotation set を作る近似を避ける。
      if (ladderAuto) settleFloorStage = 0;
      measurementSettled = false;
      settledMeasurementEpoch = "";
      requestMeasurementSettle();
    }, fixtureRemovalAtMs);
  }

  function clearCardPageRefreshTimer(): void {
    if (cardPageRefreshTimer != null) {
      clearTimeout(cardPageRefreshTimer);
      cardPageRefreshTimer = null;
    }
  }

  function scheduleCardPageRefresh(): void {
    if (!cardPageRefreshRequested) return;
    let revision = 0;
    const refresh = (): void => {
      cardPageRefreshTimer = null;
      revision += 1;
      measurementSettled = false;
      settledMeasurementEpoch = "";
      cardPageFixtureRevision = revision;
      requestMeasurementSettle();
      if (revision < 3 && !measurementDisposed) cardPageRefreshTimer = setTimeout(refresh, 1_000);
    };
    cardPageRefreshTimer = setTimeout(refresh, cardPageRefreshAtMs);
  }

  function cardPlacement(plan: ColumnPlan, key: CardKey): "left" | "right" | "center" | null {
    if (plan.left.some((card) => card.key === key)) return "left";
    if (plan.right.some((card) => card.key === key)) return "right";
    if (plan.center.some((card) => card.key === key)) return "center";
    return null;
  }

  function displayNaturalHeight(
    card: CardCandidate,
    placement: "left" | "right" | "center",
    selection: DisplaySelection,
  ): number {
    const regionRows = card.key === "quake"
      ? selection.quakeRows
      : card.key === "weather"
        ? selection.weatherRows
        : 0;
    const variant = card.key === "typhoon" ? selection.typhoon : card.variant;
    const floodWide = card.key === "flood" && selection.floodWide;
    return measuredHeight(card.key, variant, placement === "center" ? "center" : "side", regionRows, floodWide);
  }

  function selectedColumnHeight(
    cards: readonly CardCandidate[],
    placement: "left" | "right" | "center",
    selection: DisplaySelection,
  ): number {
    return cards.reduce((total, card) => total + displayNaturalHeight(card, placement, selection), 0)
      + Math.max(0, cards.length - 1) * columnGapPx();
  }

  function selectedCenterHeight(plan: ColumnPlan, selection: DisplaySelection): number {
    const cardHeight = selectedColumnHeight(plan.center, "center", selection);
    const fixedHeights = fixedMeasureKeys.map((key) => measuredFixedHeights[key] ?? 0);
    const totalCount = plan.center.length + fixedHeights.length;
    return cardHeight + fixedHeights.reduce((total, height) => total + height, 0)
      + Math.max(0, totalCount - 1) * columnGapPx();
  }

  function selectedRightHeight(plan: ColumnPlan, selection: DisplaySelection): number {
    let total = selectedColumnHeight(plan.right, "right", selection);
    if (plan.rotationSlotHeight > 0) total += (plan.right.length > 0 ? columnGapPx() : 0) + plan.rotationSlotHeight;
    if (plan.rotationFailureCount > 0) total += columnGapPx() + measuredRotationFailureHeightPx;
    return total;
  }

  function promoteAndExpand(plan: ColumnPlan): DisplaySelection {
    return solvePromoteAndExpand(plan, solverContext(plan));
  }

  const contentSelection = $derived.by(() => promoteAndExpand(layoutPlan));

  const pageScans = $derived.by(() => {
    // scanPagePartition は helper 経由で測定 cache を読むため、依存をここでも明示する。
    const pageCacheSize = Object.keys(measuredPageHeights).length + Object.keys(measuredCenterPageHeights).length;
    const scans = {
      quake: scanPagePartition("quake", contentSelection.quakeRows),
      weather: scanPagePartition("weather", contentSelection.weatherRows),
    };
    // cache のキー数は純粋な診断値ではなく reactive read を保持するために使う。
    if (pageCacheSize < 0) return scans;
    return scans;
  });

  const pageMeasureEntries = $derived.by(() => [
    ...pageScans.quake.pending,
    ...pageScans.weather.pending,
  ]);

  const cardPagePartitions = $derived.by(() => ({
    quake: partitionQuakePages(contentSelection.quakeRows),
    weather: partitionWeatherPages(contentSelection.weatherRows),
    flood: partitionFloodPages(),
    tornado: partitionTornadoPages(),
  }));
  const cardPageLists = $derived.by(() => ({
    quake: cardPagePartitions.quake.pages,
    weather: cardPagePartitions.weather.pages,
    flood: cardPagePartitions.flood.pages,
    tornado: cardPagePartitions.tornado.pages,
  }));
  const cardPageCounts = $derived.by(() => ({
    quake: cardPageLists.quake.length,
    weather: cardPageLists.weather.length,
    flood: cardPageLists.flood.length,
    tornado: cardPageLists.tornado.length,
  }));
  const cardPageIsActive = $derived(cardPageCounts.quake > 1 || cardPageCounts.weather > 1 || cardPageCounts.flood > 1 || cardPageCounts.tornado > 1);
  const cardPageInfeasible = $derived(cardPagePartitions.quake.infeasible || cardPagePartitions.weather.infeasible);
  const candidateTruncated = $derived(cardPagePartitions.quake.candidateTruncated || cardPagePartitions.weather.candidateTruncated);
  const partitionProbeCounts = $derived({
    quake: pageScans.quake.probeCount,
    weather: pageScans.weather.probeCount,
  });
  const partitionTailProbeMeasured = $derived(
    [...Object.keys(measuredPageHeights), ...Object.keys(measuredCenterPageHeights)]
      .some((id) => id.includes(":omitted:")),
  );
  const currentCardPageTick = $derived(cardPageTickOverride ?? cardPageTick);

  function cardPageEpochKey(): string {
    return [
      layoutPlan.stage,
      contentSelection.quakeRows,
      contentSelection.weatherRows,
      schedulerRotationKeys.join(","),
      cardPagePartitions.quake.keys.join(","),
      cardPagePartitions.weather.keys.join(","),
      cardPagePartitions.flood.keys.join(","),
      cardPagePartitions.tornado.keys.join(","),
      cardPagePartitions.quake.identities.join(","),
      cardPagePartitions.weather.identities.join(","),
      cardPagePartitions.flood.identities.join(","),
      cardPagePartitions.tornado.identities.join(","),
      cardPagePartitions.quake.usesCandidate,
      cardPagePartitions.weather.usesCandidate,
      cardPagePartitions.flood.usesCandidate,
      cardPagePartitions.tornado.usesCandidate,
    ].join("|");
  }

  function cardPagePartition(key: CardKey): CardPagePartition<QuakePage> | CardPagePartition<WeatherPage> | CardPagePartition<FloodPage> | null {
    if (key === "quake") return cardPagePartitions.quake;
    if (key === "weather") return cardPagePartitions.weather;
    if (key === "flood") return cardPagePartitions.flood;
    return null;
  }

  function cardPageCount(key: CardKey): number {
    const partition = cardPagePartition(key);
    if (partition != null) return partition.pages.length;
    return 1;
  }

  function cardPageUsesCandidate(key: CardKey): boolean {
    return cardPagePartition(key)?.usesCandidate ?? false;
  }

  function cardPageKeys(key: CardKey): string[] {
    return cardPagePartition(key)?.keys ?? [];
  }

  function cardPageIdentityKeys(key: CardKey): string[] {
    return cardPagePartition(key)?.identities ?? [];
  }

  function cardPageTailEntries(key: CardKey): PageTail[][] {
    return cardPagePartition(key)?.pages.map((page) => page.tails) ?? [];
  }

  function cardPageIndex(key: CardKey): number {
    const total = cardPageCount(key);
    if (total <= 1) return 0;
    if (cardPageTickOverride != null) return cardPageTickOverride % total;
    if (key !== "quake" && key !== "weather" && key !== "flood") return 0;
    const activeKey = cardPageRuntime[key].activeKey;
    const index = cardPageIdentityKeys(key).indexOf(activeKey ?? "");
    return index >= 0 ? index : 0;
  }

  function tornadoPageIndex(): number {
    const total = cardPageCounts.tornado;
    if (total <= 1) return 0;
    if (cardPageTickOverride != null) return cardPageTickOverride % total;
    const activeKey = cardPageRuntime.tornado.activeKey;
    const index = cardPagePartitions.tornado.identities.indexOf(activeKey ?? "");
    return index >= 0 ? index : 0;
  }

  function tornadoPageForRender(): TornadoPage | null {
    return cardPagePartitions.tornado.pages[tornadoPageIndex()] ?? cardPagePartitions.tornado.pages[0] ?? null;
  }

  function cardPageAttribute(key: CardKey): string | undefined {
    if (key !== "quake" && key !== "weather" && key !== "flood") return undefined;
    return `${cardPageIndex(key) + 1}/${cardPageCount(key)}`;
  }

  function quakePageForRender(regionRows: number, pageIndex: number): DisplayLatestQuakeStateV1 {
    return cardPagePartitions.quake.pages[pageIndex]?.state
      ?? cardPagePartitions.quake.pages[0]?.state
      ?? quakeForRegionRows(regionRows);
  }

  function weatherPageForRender(regionRows: number, pageIndex: number): DisplayWeatherAlertV1[] {
    return cardPagePartitions.weather.pages[pageIndex]?.alerts
      ?? cardPagePartitions.weather.pages[0]?.alerts
      ?? weatherForRegionRows(regionRows);
  }

  function floodPageForRender(pageIndex: number): PageRange {
    return cardPagePartitions.flood.pages[pageIndex]?.range
      ?? cardPagePartitions.flood.pages[0]?.range
      ?? { start: 0, end: flood?.data.rivers.length ?? 0, tails: [], omittedAreaCount: 0 };
  }

  // scheduler は layoutPlan の stage/key と測定完了だけを購読する。active key 自身は読まないため、
  // tick による差し替えで scheduler が自己再入しない。measurementPass はページ位相の epoch に
  // 使わず、同じ stage 3 の再計測でも現在 key と起点時刻を維持する。
  $effect(() => {
    const stage = layoutPlan.stage;
    const keys = schedulerRotationKeys;
    const settled = measurementSettled;
    void settled;
    if (!rotationSchedulerMounted) return;
    syncRotationScheduler(stage, keys);
  });

  $effect(() => {
    const epoch = cardPageEpochKey();
    const pageable = selfAdvancingPageKeys().length > 0;
    if (!cardPageSchedulerMounted) return;
    if (!measurementSettled || pageMeasureEntries.length > 0) return;
    untrack(() => syncCardPageScheduler(epoch, pageable));
  });

  $effect(() => {
    const epoch = `${cardPageFixtureRevision}|${pageMeasureEntries.map((entry) => entry.id).join(",")}`;
    const candidateEpoch = [
      cardPageFixtureRevision,
      measuredLayoutWidthPx,
      measuredLayoutHeightPx,
      layoutPlan.stage,
      cardPlacement(layoutPlan, "quake"),
      cardPlacement(layoutPlan, "weather"),
      suppliedQuakeGroups().fullAreaKeys.join(","),
      suppliedWeatherItems().fullAreaKeys.join(","),
    ].join("|");
    if (!measurementComplete || !cardPageSchedulerMounted) return;
    if (pageMeasurementCacheKey !== candidateEpoch) {
      pageMeasurementCacheKey = candidateEpoch;
      measuredPageHeights = {};
      measuredCenterPageHeights = {};
      pageMeasurementEpoch = "";
      settledMeasurementEpoch = "";
      measurementSettled = false;
      measurementNonConverged = false;
    }
    if (!fontsReady || pageMeasureEntries.length > 0 || settledMeasurementEpoch !== pageMeasurementCacheKey) {
      measurementSettled = false;
      requestMeasurementSettle();
    }
    if (pageMeasurementEpoch === epoch) return;
    pageMeasurementEpoch = epoch;
    // fixture 更新で測定棚の候補範囲が変わったときも、DOM 更新直後に一度だけ同期 read する。
    untrack(() => {
      readMeasurements();
    });
  });

  const clusterGapStyle = $derived(
    measuredClusterGapPx > 0
      ? `${measuredClusterGapPx}px`
      : layoutPlan.stage >= 2
        ? "calc(var(--mock-gap) * 1.25)"
        : "calc(var(--mock-gap) * 1.75)",
  );
  const clusterFlowHeightStyle = $derived(measuredClusterFlowHeightPx > 0 ? `${measuredClusterFlowHeightPx}px` : "auto");
  const centerNaturalHeightPx = $derived(selectedCenterHeight(layoutPlan, contentSelection));

  function plannedCards(
    cards: readonly CardCandidate[],
    placement: "left" | "right" | "center",
    selection: DisplaySelection,
  ): PlannedCard[] {
    return cards.map((card) => {
      const regionRows = card.key === "quake"
        ? selection.quakeRows
        : card.key === "weather"
          ? selection.weatherRows
          : 0;
      const floodWide = card.key === "flood" && selection.floodWide;
      const variant = card.key === "typhoon" ? selection.typhoon : card.variant;
      const naturalHeight = measuredHeight(card.key, variant, placement === "center" ? "center" : "side", regionRows, floodWide);
      return {
        ...card,
        variant,
        naturalHeight,
        allocatedHeight: naturalHeight,
        extraHeight: 0,
        clipped: false,
        overflowed: false,
        placement,
        regionRows,
        regionRemaining: regionRemainingCount(card.key, regionRows),
        floodWide,
      };
    });
  }

  const leftCards = $derived(plannedCards(layoutPlan.left, "left", contentSelection));
  const rightCards = $derived(plannedCards(layoutPlan.right, "right", contentSelection));
  const centerCards = $derived(plannedCards(layoutPlan.center, "center", contentSelection));
  const compactCandidates = $derived(buildCandidates({ quake: "compact", weather: "compact", typhoon: "compact" }));
  const rotationActiveKeyForRender = $derived.by(() => {
    if (layoutPlan.stage !== 3 || schedulerRotationKeys.length === 0) return null;
    const canonicalKeys = rotationKeysInCanonicalOrder(schedulerRotationKeys);
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
        regionRows: 0,
        regionRemaining: 0,
        floodWide: false,
      });

  function isExpanded(entry: PlannedCard): boolean {
    return (entry.key === "quake" || entry.key === "weather") && entry.regionRows > 0;
  }

  const floodForm = $derived.by(() => {
    if (flood == null) return "none";
    const placement = cardPlacement(layoutPlan, "flood");
    return floodIsWide && (placement === "center" || contentSelection.floodWide) ? "wide" : "card";
  });

  const expandedCounts = $derived.by(() => {
    const quake = quakeForRegionRows(contentSelection.quakeRows);
    const weatherByKind: Record<string, { count: number; n: number }> = {};
    for (const alert of weatherForRegionRows(contentSelection.weatherRows)) {
      for (const item of alert.items) {
        const previous = weatherByKind[item.kind] ?? { count: 0, n: 0 };
        weatherByKind[item.kind] = {
          count: previous.count + item.shownAreas.length,
          n: previous.n + item.omittedAreaCount,
        };
      }
    }
    return JSON.stringify({
      quake: {
        count: quake.intensityGroups.reduce((total, group) => total + group.areas.length, 0),
        n: quake.intensityGroups.reduce((total, group) => total + group.omittedAreaCount, 0),
      },
      weather: weatherByKind,
    });
  });

  const placementSurplusUse = $derived.by(() => solveAchievableSurplusUse(
    {
      left: layoutPlan.left,
      right: layoutPlan.right,
      center: layoutPlan.center,
      moved: layoutPlan.moved,
    },
    solverContext(layoutPlan),
  ));

  const schedulerState = $derived.by(() => {
    void schedulerDiagnosticRevision;
    return JSON.stringify({
      rotation: {
        stage: rotationSchedulerStage,
        keys: [...rotationSchedulerKeys],
        currentKey: rotationActiveKey,
        phaseKey: rotationPhaseKey,
        phaseStartedAtMs: rotationEnteredAtMs,
        processedTick: rotationProcessedTick,
        seenKeys: [...rotationSeenKeys],
        tickPending: rotationTickPending,
        suspended: rotationSchedulerSuspended,
        inFlight: rotationTransition != null || rotationEpochBusy,
        timerActive: rotationTimer != null || rotationTransitionDeadlineTimer != null,
      },
      paging: {
        stage: cardPageSchedulerStage,
        activeKeys: {
          quake: cardPageRuntime.quake.activeKey,
          weather: cardPageRuntime.weather.activeKey,
          flood: cardPageRuntime.flood.activeKey,
          tornado: cardPageRuntime.tornado.activeKey,
        },
        pendingKeys: {
          quake: [...cardPageRuntime.quake.pendingKeys],
          weather: [...cardPageRuntime.weather.pendingKeys],
          flood: [...cardPageRuntime.flood.pendingKeys],
          tornado: [...cardPageRuntime.tornado.pendingKeys],
        },
        cycleOriginKeys: {
          quake: cardPageRuntime.quake.cycleOriginKey,
          weather: cardPageRuntime.weather.cycleOriginKey,
          flood: cardPageRuntime.flood.cycleOriginKey,
          tornado: cardPageRuntime.tornado.cycleOriginKey,
        },
        processedTick: cardPageProcessedTick,
        previousPageCounts: { ...cardPageSchedulerPageCounts },
        substates: {
          quake: { ...cardPageSchedulerSubstates.quake },
          weather: { ...cardPageSchedulerSubstates.weather },
          flood: { ...cardPageSchedulerSubstates.flood },
          tornado: { ...cardPageSchedulerSubstates.tornado },
        },
        activeSubstateKeys: PAGEABLE_CARD_KEYS.filter(
          (key) => cardPageSchedulerSubstates[key].pageCount > 1,
        ),
        tickPending: cardPageTickPending,
        suspendedKeys: schedulerRotationKeys.filter((key) => key === "quake" || key === "weather" || key === "flood"),
        inFlight: cardPageEpochBusy,
        timerActive: cardPageSchedulerTimer != null,
      },
    });
  });
</script>

  {#snippet renderTornadoRider(page: TornadoPage | null, probe = false)}
    {#if tornado != null && page != null}
      <div class:sighted={tornado.data.isSighted} class="mock-tornado-rider" data-page-probe-readable={probe ? "true" : undefined} data-tornado-rider>
        ⚠ {tornado.data.isSighted ? "竜巻目撃情報" : "竜巻注意情報"}（{#each page.areas as area, index}{#if index > 0}、{/if}{area}{/each}）
        {#if cardPageCounts.tornado > 1}<span class="mock-tornado-page" data-tornado-page-marker>対象地域 {tornadoPageIndex() + 1}/{cardPageCounts.tornado}</span>{/if}
      </div>
    {/if}
  {/snippet}

  {#snippet renderPageProbe(entry: PageMeasureEntry)}
    {#if entry.key === "quake"}
      <LatestQuakeCard
        quake={quakeProbeForRange(entry.start, entry.end, entry.tails)}
        longPeriod={longPeriod == null ? null : { ...longPeriod.data, restored: longPeriod.restored }}
      />
    {:else if entry.key === "weather"}
      <div class="mock-weather-shell" data-weather-two-column="true">
        <WeatherAlertCard alerts={weatherProbeForRange(entry.start, entry.end, entry.tails)} tornado={null} />
        {@render renderTornadoRider(tornadoPageForRender(), true)}
      </div>
    {:else if entry.key === "tornado"}
      <div class="mock-weather-shell" data-weather-two-column="true" data-page-probe-card>
        <WeatherAlertCard alerts={weatherForRegionRows(contentSelection.weatherRows)} tornado={null} />
        {@render renderTornadoRider(tornadoPageForRender(), true)}
      </div>
    {/if}
  {/snippet}

  {#snippet renderCard(
    key: CardKey,
    variant: CardVariant,
    placement: "side" | "center" = "side",
    regionRows = 0,
    floodWide = false,
    pageIndex = 0,
    pageCount = 1,
    useCardPage = true,
  )}
  {#if key === "tsunami" && tsunami != null}
    <TsunamiStandbyBanner tsunami={tsunami} />
  {:else if key === "quake"}
    <div class="card-page-body" data-card-page-body>
      <LatestQuakeCard
        quake={useCardPage && cardPageUsesCandidate("quake") ? quakePageForRender(regionRows, pageIndex) : quakeForRegionRows(regionRows)}
        longPeriod={longPeriod == null ? null : { ...longPeriod.data, restored: longPeriod.restored }}
      />
    </div>
    {#if useCardPage && (pageCount > 1 || cardPagePartition("quake")?.candidateTruncated)}<span class="mock-card-page" data-card-page-indicator>{pageIndex + 1}/{pageCount}</span>{/if}
  {:else if key === "weather"}
    <div class="card-page-body" data-card-page-body>
      <div class="mock-weather-shell" data-weather-two-column="true">
        <WeatherAlertCard alerts={useCardPage && cardPageUsesCandidate("weather") ? weatherPageForRender(regionRows, pageIndex) : weatherForRegionRows(regionRows)} tornado={null} />
        {@render renderTornadoRider(tornadoPageForRender())}
      </div>
    </div>
    {#if useCardPage && (pageCount > 1 || cardPagePartition("weather")?.candidateTruncated)}<span class="mock-card-page" data-card-page-indicator>{pageIndex + 1}/{pageCount}</span>{/if}
  {:else if key === "flood" && flood != null}
    {#if floodIsWide && (placement === "center" || floodWide)}
      <FloodWideCard item={flood} measurementRange={useCardPage ? floodPageForRender(pageIndex) : undefined} />
    {:else}
      <FloodCard item={flood} measurementRange={useCardPage ? floodPageForRender(pageIndex) : undefined} />
    {/if}
    {#if useCardPage && pageCount > 1}<span class="mock-card-page" data-card-page-indicator>{pageIndex + 1}/{pageCount}</span>{/if}
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
    class:paged-card={cardPageUsesCandidate(entry.key)}
    style={cardPageUsesCandidate(entry.key) ? `height: ${entry.naturalHeight}px;` : undefined}
    data-mock-card={entry.key}
    data-overflow-placement={entry.placement === "center" ? "center" : undefined}
    data-center-eligible={centerEligibleKeys.has(entry.key) ? "true" : "false"}
    data-region-expanded={isExpanded(entry) ? "true" : undefined}
    data-region-expanded-rows={entry.regionRows}
    data-region-remaining-count={entry.regionRemaining}
    data-card-page={cardPageAttribute(entry.key)}
    data-card-page-tick={cardPageCount(entry.key) > 1 ? currentCardPageTick : undefined}
    data-card-page-fixed-height={cardPageUsesCandidate(entry.key) ? entry.naturalHeight : undefined}
    data-card-page-keys={cardPagePartition(entry.key) == null ? undefined : JSON.stringify(cardPageKeys(entry.key))}
    data-card-page-identities={cardPagePartition(entry.key) == null ? undefined : JSON.stringify(cardPageIdentityKeys(entry.key))}
    data-card-page-tail-counts={cardPagePartition(entry.key) == null ? undefined : JSON.stringify(cardPageTailEntries(entry.key))}
    data-card-page-infeasible={cardPagePartition(entry.key)?.infeasible ? "true" : undefined}
    data-content-score={entry.score}
    data-natural-height-px={entry.naturalHeight}
    data-allocated-height-px={entry.allocatedHeight}
    data-height-extra-px={entry.extraHeight}
    data-card-clipped={entry.clipped ? "true" : undefined}
    data-flood-render-mode={entry.key === "flood" && floodIsWide && (entry.placement === "center" || entry.floodWide) ? "wide" : entry.key === "flood" ? "side" : undefined}
    data-typhoon-display-mode={entry.key === "typhoon" ? entry.variant : undefined}
  >
    {@render renderCard(
      entry.key,
      entry.variant,
      entry.placement === "center" ? "center" : "side",
      entry.regionRows,
      entry.floodWide,
      cardPageIndex(entry.key),
      cardPageCount(entry.key),
    )}
  </article>
{/snippet}

<svelte:head><title>Legacy standby improved mock v26</title></svelte:head>

<main
  id="legacy-improved-mock"
  class="legacy-mock ladder-{layoutPlan.stage}"
  style={`--mock-nankai-reserve: ${measuredNankaiHeightPx}px; --mock-cluster-gap: ${clusterGapStyle}; --mock-cluster-flow-height: ${clusterFlowHeightStyle};`}
  data-legacy-improved-mock
  data-ladder-stage={layoutPlan.stage}
  data-ladder-auto={ladderAuto ? "true" : "false"}
  data-scenario={scenario}
  data-fixture-removed-keys={fixtureRemovedKeys.join(",")}
  data-flood-wide-requested={wideFloodRequested && floodIsWide ? "true" : "false"}
  data-suppressed-unknown-count={unknownInputs.length}
  data-input-item-count={cardKeys.length + unknownInputs.length}
  data-measurement-mode={measurementComplete ? "sync-dom" : "pending"}
  data-measurement-pass={measurementPass}
  data-measurement-settled={measurementSettled ? "true" : "false"}
  data-fonts-ready={fontsReady ? "true" : "false"}
  data-measurement-epoch={pageMeasurementCacheKey}
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
  data-displayed-left-natural-height-px={selectedColumnHeight(layoutPlan.left, "left", contentSelection)}
  data-displayed-right-natural-height-px={selectedRightHeight(layoutPlan, contentSelection)}
  data-displayed-center-natural-height-px={selectedCenterHeight(layoutPlan, contentSelection)}
  data-left-residual-height-px={Math.max(0, layoutCapacityPx() - selectedColumnHeight(layoutPlan.left, "left", contentSelection))}
  data-right-residual-height-px={Math.max(0, layoutCapacityPx() - selectedRightHeight(layoutPlan, contentSelection))}
  data-center-residual-height-px={Math.max(0, centerCapacityPx() - selectedCenterHeight(layoutPlan, contentSelection))}
  data-typhoon-display-mode={typhoon == null ? "none" : contentSelection.typhoon}
  data-flood-wide-promoted={contentSelection.floodWide ? "true" : "false"}
  data-quake-expanded-rows={contentSelection.quakeRows}
  data-weather-expanded-rows={contentSelection.weatherRows}
  data-typhoon-variant={typhoon == null ? "none" : contentSelection.typhoon}
  data-flood-form={floodForm}
  data-weather-compact-side-height-px={fullWeatherAlerts.length === 0 ? 0 : measuredHeight("weather", "compact")}
  data-weather-compact-center-height-px={fullWeatherAlerts.length === 0 ? 0 : measuredHeight("weather", "compact", "center")}
  data-expanded-counts={expandedCounts}
  data-placement-surplus-use={placementSurplusUse}
  data-card-page-tick={currentCardPageTick}
  data-card-page-tick-override={cardPageTickOverride ?? undefined}
  data-card-page-counts={`quake:${cardPageCounts.quake},weather:${cardPageCounts.weather},flood:${cardPageCounts.flood},tornado:${cardPageCounts.tornado}`}
  data-card-page-active={cardPageIsActive ? "true" : "false"}
  data-card-page-keys={JSON.stringify({ quake: cardPagePartitions.quake.keys, weather: cardPagePartitions.weather.keys, flood: cardPagePartitions.flood.keys, tornado: cardPagePartitions.tornado.keys })}
  data-card-page-identities={JSON.stringify({ quake: cardPagePartitions.quake.identities, weather: cardPagePartitions.weather.identities, flood: cardPagePartitions.flood.identities, tornado: cardPagePartitions.tornado.identities })}
  data-card-page-tail-counts={JSON.stringify({ quake: cardPageTailEntries("quake"), weather: cardPageTailEntries("weather"), flood: cardPageTailEntries("flood"), tornado: cardPagePartitions.tornado.pages.map((page) => page.tails) })}
  data-card-page-active-keys={JSON.stringify({ quake: cardPageRuntime.quake.activeKey, weather: cardPageRuntime.weather.activeKey, flood: cardPageRuntime.flood.activeKey, tornado: cardPageRuntime.tornado.activeKey })}
  data-partition-probe-count={JSON.stringify(partitionProbeCounts)}
  data-partition-tail-probe={partitionTailProbeMeasured ? "true" : "false"}
  data-card-page-infeasible={cardPageInfeasible ? "true" : "false"}
  data-card-page-revision={cardPageFixtureRevision}
  data-tornado-page={`${cardPageCounts.tornado === 0 ? 0 : tornadoPageIndex() + 1}/${cardPageCounts.tornado}`}
  data-tornado-page-keys={JSON.stringify(cardPagePartitions.tornado.keys)}
  data-tornado-page-identities={JSON.stringify(cardPagePartitions.tornado.identities)}
  data-tornado-page-infeasible={cardPagePartitions.tornado.infeasible ? "clip" : "false"}
  data-tornado-page-footer={cardPageCounts.tornado > 1 ? "true" : "false"}
  data-tornado-page-visible-count={tornadoPageForRender()?.areas.length ?? 0}
  data-tornado-page-host="weather"
  data-tornado-page-mode={pageSchedulerMode("tornado")}
  data-tornado-page-pending-appearance="false"
  data-candidate-truncated={candidateTruncated ? "true" : "false"}
  data-center-eligible-keys="weather,flood,typhoon,volcano"
  data-clock-mode={layoutPlan.stage === 0 ? "viewport-center" : "ticker-bottom-right"}
  data-center-fixed-height-px={centerFixedNaturalHeight()}
  data-center-capacity-px={centerCapacityPx()}
  data-center-unresolved={layoutPlan.centerUnresolved ? "true" : "false"}
  data-layout-unresolved={layoutPlan.unresolved ? "true" : "false"}
  data-layout-failure={layoutPlan.layoutFailure ? "true" : "false"}
  data-rotation-keys={schedulerRotationKeys.join(",")}
  data-rotation-current-key={rotationActiveKeyForRender ?? undefined}
  data-rotation-active-key={rotationActiveKeyForRender ?? undefined}
  data-rotation-omitted-count={layoutPlan.rotationFailureCount}
  data-rotation-cycle-ms={rotationRedisplayIntervalMs(schedulerRotationKeys.length)}
  data-rotation-slot-height-px={layoutPlan.rotationSlotHeight}
  data-rotation-failure-count={layoutPlan.rotationFailureCount}
  data-rotation-suspended={rotationSchedulerSuspended ? "true" : "false"}
  data-scheduler-state={schedulerState}
  data-outer-paging="none"
>
  <div class="mock-label">
    <strong>従来フォーマット改良 v26</strong>
    <span>scenario={scenario} · ladder={ladderAuto ? "auto" : layoutPlan.stage} · 実 DOM 同期測定</span>
  </div>

  <div class="measure-shelf" aria-hidden="true" inert>
    {#each measureEntries as entry (entry.id)}
      <div class="measure-item" data-measure-card={entry.id} use:captureMeasure={entry.id}>
        {@render renderCard(entry.key, entry.variant, "side", entry.regionRows, entry.floodWide, 0, 1, false)}
      </div>
    {/each}
    {#each pageMeasureEntries as entry (entry.id)}
      <div class="measure-item page-measure-item" data-measure-card-page={entry.id} use:capturePageMeasure={entry.id}>
        {@render renderPageProbe(entry)}
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
        {@render renderCard(entry.key, entry.variant, "center", entry.regionRows, entry.floodWide, 0, 1, false)}
      </div>
    {/each}
    {#each pageMeasureEntries as entry (entry.id)}
      <div class="measure-item center-measure-item page-measure-item" data-center-measure-card-page={entry.id} use:captureCenterPageMeasure={entry.id}>
        {@render renderPageProbe(entry)}
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
    <span>TELEGRAM</span><span>外側ページングなし・カード内改ページ</span>
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

  /* カード内改ページは外殻の高さを変えず、固定高内の本文だけを差し替える。 */
  .legacy-card.paged-card {
    position: relative;
    overflow: hidden;
  }

  .legacy-card.paged-card .card-page-body {
    position: relative;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .mock-card-page {
    position: absolute;
    z-index: 3;
    right: var(--space-3);
    bottom: var(--space-2);
    padding: 1px var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    background: color-mix(in srgb, var(--surface-standby) 92%, transparent);
    color: var(--role-muted);
    font-size: var(--type-label-xs-size);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
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

  /* wide surface は中央 placement では FloodWideCard、側列・輪番枠では基本 FloodCard。
     余裕利用フェーズで側列に昇格できる場合だけ FloodWideCard の side 測定値を使う。 */
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
    container-type: inline-size;
  }

  /* 狭幅プロトタイプ: 見出しは一行を守り、従属する更新スタンプだけを縮小/省略する。
     本実装では TsunamiStandbyBanner 側の header 改修へ移す。 */
  .legacy-mock .legacy-card :global(.tsunami-banner .banner-header) {
    min-width: 0;
    flex-wrap: nowrap;
  }

  .legacy-mock .legacy-card :global(.tsunami-banner .banner-title) {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .legacy-mock .legacy-card :global(.tsunami-banner .updated-stamp) {
    min-width: 0;
    max-width: 45%;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: clamp(10px, 2.6cqw, 14px);
  }

  @container (max-width: 240px) {
    .legacy-mock .legacy-card :global(.tsunami-banner .updated-stamp) { display: none; }
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

  /* TyphoonCard は無改造。mock 側で既存の location ノードをタイトル行の右端へ移し、
     compact/full の両形式で台風名と位置情報を同じ行に揃える。 */
  .legacy-mock :global(.typhoon-card .typhoon) {
    position: relative;
  }

  .legacy-mock :global(.typhoon-card .compact-primary) {
    padding-right: 45%;
  }

  .legacy-mock :global(.typhoon-card .compact-summary) {
    padding-right: 45%;
    overflow: visible;
  }

  .legacy-mock :global(.typhoon-card .compact-summary .compact-location) {
    position: absolute;
    top: var(--space-1);
    right: var(--space-4);
    width: 42%;
    max-width: 42%;
    margin: 0;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
  }

  .legacy-mock :global(.typhoon-card:not(.compact) .typhoon > .location) {
    position: absolute;
    top: var(--space-2);
    right: var(--space-4);
    width: 42%;
    max-width: 42%;
    margin: 0;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* full 形式も位置行を独立段にせず、タイトルと同じ一行の右端へ置くために
     タイトル側へ測定済みの空きを予約する。実コンポーネントは無改造のまま。 */
  .legacy-mock :global(.typhoon-card:not(.compact) .typhoon > strong) {
    display: block;
    min-width: 0;
    padding-right: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
