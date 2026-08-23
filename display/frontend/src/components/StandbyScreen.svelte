<script lang="ts">
  import { flushSync, onDestroy, onMount, tick, untrack } from "svelte";
  import type { ActiveStandbyCardV1, DisplayLatestQuakeStateV1, DisplayRecentQuakeV1, DisplayStateSnapshotV1, DisplayTsunamiLevel } from "../lib/protocol";
  import { recentQuakeId } from "../lib/format";
  import { resolveWeatherKindKeys, weatherAreaIdentity } from "../lib/weather-expanded-kinds";
  import { floodPartitionProbeSentinel } from "../lib/standby-cards";
  import { makeColumnPlan, promoteAndExpand, type SolverContext } from "../lib/legacy-standby/solver";
  import { SPRING_SPATIAL_DEFAULT_MS } from "../lib/motion";
  import { createEpochCoordinator, type EpochCoordinator, type EpochCoordinatorControl } from "../lib/legacy-standby/epoch-coordinator";
  import { nextCenterClusterHidden, type CenterClusterItem } from "../lib/legacy-standby/center-cluster";
  import { createLayoutMotionCoordinator, type LayoutMotionIdentity } from "../lib/legacy-standby/layout-motion.svelte";
  import { sequentialPartitionRanges, type PartitionProbe } from "../lib/legacy-standby/page-partition";
  import { createCardPageCoordinator, createRotationScheduler } from "../lib/legacy-standby/time-slice-scheduler.svelte";
  import type { CardCandidate, CardKey, CardVariant, ColumnPlan, DisplaySelection, LadderStage, PlacementChoice } from "../lib/legacy-standby/types";
  import Clock from "./Clock.svelte";
  import ConnectionBadge from "./ConnectionBadge.svelte";
  import FloodCard from "./FloodCard.svelte";
  import FloodWideCard from "./FloodWideCard.svelte";
  import HeatAlertCard from "./HeatAlertCard.svelte";
  import InstrumentRow from "./InstrumentRow.svelte";
  import LatestQuakeCard from "./LatestQuakeCard.svelte";
  import NankaiBadge from "./NankaiBadge.svelte";
  import QuakeReplayCard from "./QuakeReplayCard.svelte";
  import RecentQuakes from "./RecentQuakes.svelte";
  import TsunamiStandbyBanner from "./TsunamiStandbyBanner.svelte";
  import TyphoonCard from "./TyphoonCard.svelte";
  import VolcanoCard from "./VolcanoCard.svelte";
  import WeatherAlertCard from "./WeatherAlertCard.svelte";

  type TestMeasurementOverride = Partial<Record<string, number>> | ((pass: number) => Partial<Record<string, number>>);
  let { snapshot, now, dim, sseConnected, onTsunamiReplay, onStageChange, testMeasurementOverride, testLateProbeDuringFinalCommit, testProbeAfterMeasurementPass, testBeforeTerminalCommit, testAfterTerminalBoundary, rotationTick, cardPageTick, gateFixture }: {
    snapshot: DisplayStateSnapshotV1;
    now: Date;
    dim: boolean;
    sseConnected: boolean;
    onTsunamiReplay?: (level: DisplayTsunamiLevel) => void;
    onStageChange?: (stage: LadderStage) => void;
    /** Test-only deterministic geometry injection; never supplied by App. */
    testMeasurementOverride?: TestMeasurementOverride;
    /** Test-only hook for a synchronous probe registered by the final DOM flush. */
    testLateProbeDuringFinalCommit?: (epoch: EpochCoordinatorControl) => void;
    /** Test-only hook that leaves a probe pending at a bounded pass boundary. */
    testProbeAfterMeasurementPass?: (epoch: EpochCoordinatorControl, pass: number) => void;
    /** Test-only hook for queuing a successor before a terminal commit. */
    testBeforeTerminalCommit?: (queueSuccessor: () => void) => void;
    /** Test-only observation point after a terminal epoch boundary. */
    testAfterTerminalBoundary?: () => void;
    /** Capture/test-only deterministic scheduler positions. */
    rotationTick?: number;
    cardPageTick?: number;
    /** Preview gate only; production App never supplies this. */
    gateFixture?: "overflow" | "overlap" | "rotation" | "cluster" | "cluster-calm";
  } = $props();

  export type { EpochCoordinator } from "../lib/legacy-standby/epoch-coordinator";
  export function closeQuakeCard(): void { clearCloseTimer(); selectedRecentQuake = null; selectedId = null; }

  function schedulerTickOverride(propValue: number | undefined, queryName: "rotationTick" | "cardPageTick"): number | undefined {
    if (propValue != null) return propValue;
    if (typeof window === "undefined") return undefined;
    const raw = new URLSearchParams(window.location.search).get(queryName);
    return raw != null && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
  }

  const coordinator = createEpochCoordinator();
  const cardPageTickOverride = untrack(() => schedulerTickOverride(cardPageTick, "cardPageTick"));
  const rotationTickOverride = untrack(() => schedulerTickOverride(rotationTick, "rotationTick"));
  // The recent-quake clipping check is a gate-only visual assertion. Keep it
  // out of ordinary settle epochs, especially the 128-candidate probe tests.
  const gateCapture = untrack(() => typeof window !== "undefined"
    && new URLSearchParams(window.location.search).has("gateScenario"));
  const cardPageCoordinator = createCardPageCoordinator({ epoch: coordinator, tickOverride: cardPageTickOverride });
  const rotationScheduler = createRotationScheduler({
    epoch: coordinator,
    tickOverride: rotationTickOverride,
    onAppearance: (key) => cardPageCoordinator.recordRotationAppearance(key),
  });
  const MAX_SETTLE_PASSES = 4;
  // A final DOM commit may mount one same-epoch probe. It gets one bounded
  // confirmation pass; this is not a general retry budget.
  const MAX_POST_COMMIT_VERIFICATION_PASSES = 1;
  const layoutMotionDuration = SPRING_SPATIAL_DEFAULT_MS;
  const KNOWN_KINDS = new Set<string>(["volcano", "typhoon", "heat", "flood", "tornado", "longPeriod", "nankaiTrough"]);
  const CARD_ORDER: readonly CardKey[] = ["tsunami", "quake", "weather", "flood", "typhoon", "volcano", "heat"];
  const MAX_PREFIX_ROWS = 128;
  const QUAKE_CARD_AUTO_CLOSE_MS = 20_000;
  type Placement = "left" | "right" | "center";
  type PrefixPlacement = "side" | "center";
  type MeasureId = `${CardKey}:${CardVariant}:${Placement}`;
  type PrefixCardKey = "quake" | "weather" | "flood";
  type FloodProbeForm = "compact" | "wide";
  interface PrefixTail { kindKey: string; omittedAreaCount: number }
  interface PrefixMeasureEntry {
    id: string;
    key: PrefixCardKey;
    placement: PrefixPlacement;
    start: number;
    end: number;
    /** B additional rows; distinct from end, which is the rendered range. */
    selectionRows?: number;
    tails: PrefixTail[];
    omittedAreaCount: number;
    purpose?: "prefix" | "page";
    /** Flood's page-shell contract budget; absent for quake/weather's 1px sentinel. */
    fixedHeightPx?: number;
    floodForm?: FloodProbeForm;
    floodAggregateFallback?: boolean;
  }
  interface SettleTraceEntry {
    pass: number;
    step: number;
    stage: LadderStage;
    measurementGeometryStage: LadderStage;
    rotationKeys: string;
    weatherRows: number;
    weatherVariant: CardVariant;
    signature: string;
    pendingProbes: number;
  }

  let selectedRecentQuake = $state<DisplayRecentQuakeV1 | null>(null);
  let selectedId = $state<string | null>(null);
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let closeGen = 0;
  let standbyEl = $state<HTMLElement | null>(null);
  let layoutEl = $state<HTMLElement | null>(null);
  let nankaiEl = $state<HTMLElement | null>(null);
  let failureMeasureEl = $state<HTMLElement | null>(null);
  let rotationIndicatorMeasureEl = $state<HTMLElement | null>(null);
  let rotationSlotEl = $state<HTMLElement | null>(null);
  let sideMeasureShelfEl = $state<HTMLElement | null>(null);
  let centerMeasureShelfEl = $state<HTMLElement | null>(null);
  let leftTrackEl = $state<HTMLElement | null>(null);
  let centerTrackEl = $state<HTMLElement | null>(null);
  let rightTrackEl = $state<HTMLElement | null>(null);
  let statsMeasureEl = $state<HTMLElement | null>(null);
  let recentMeasureEl = $state<HTMLElement | null>(null);
  let connectionMeasureEl = $state<HTMLElement | null>(null);
  let baselineGapMeasureEl = $state<HTMLElement | null>(null);
  let clockFaceEl = $state<HTMLElement | null>(null);
  let measureNodes = new Map<MeasureId, HTMLElement>();
  let prefixMeasureNodes = new Map<string, HTMLElement>();
  let measurements = $state<Record<string, number>>({});
  let prefixMeasurements = $state<Record<string, number>>({});
  let prefixMeasureEntries = $state<PrefixMeasureEntry[]>([]);
  let layoutWidthPx = $state(0);
  let layoutHeightPx = $state(0);
  let leftTrackWidthPx = $state(0);
  let centerTrackWidthPx = $state(0);
  let rightTrackWidthPx = $state(0);
  let sideMeasureShelfWidthPx = $state(0);
  let centerMeasureShelfWidthPx = $state(0);
  let viewportHeightPx = $state(typeof window === "undefined" ? 720 : window.innerHeight);
  let nankaiHeightPx = $state(0);
  let rotationIndicatorHeightPx = $state(0);
  let statsHeightPx = $state(0);
  let recentHeightPx = $state(0);
  let connectionHeightPx = $state(0);
  let clusterGapPx = $state(0);
  let clusterFlowHeightPx = $state(0);
  let gapPx = $state(12);
  let baselineGapPx = $state(12);
  let measurementPass = $state(0);
  let measurementReadCount = $state(0);
  let measurementGeometryStage = $state<LadderStage>(0);
  let leftTrackRectWidthPx = $state(0);
  let centerTrackRectWidthPx = $state(0);
  let rightTrackRectWidthPx = $state(0);
  let sideMeasureShelfRectWidthPx = $state(0);
  let centerMeasureShelfRectWidthPx = $state(0);
  let clockHorizontallyClipped = $state(false);
  let clockChildrenHorizontallyClipped = $state(false);
  let clockCenterDeltaXPx = $state(0);
  let clockCenterDeltaYPx = $state(0);
  let clockSecondsWithinCluster = $state(true);
  let clockDateWithinCluster = $state(true);
  let recentHypocentersHorizontallyClipped = $state(false);
  let recentQuakesRectTopPx = $state(0);
  let recentQuakesRectBottomPx = $state(0);
  let nankaiRectTopPx = $state(0);
  let nankaiRectBottomPx = $state(0);
  let recentQuakesNankaiOverlapPx = $state(0);
  let rotationCardViewportRectHeightPx = $state(0);
  let rotationFooterRectHeightPx = $state(0);
  let rotationViewportFooterOverlapPx = $state(0);
  let cardOverflowCount = $state(0);
  let cardOverflowKeys = $state("");
  let pageViewportOverflowKeys = $state("");
  let geometryViolationCount = $state(0);
  let geometryViolationKeys = $state("");
  let rightTrackScrollHeightPx = $state(0);
  let rightTrackClientHeightPx = $state(0);
  let weatherLiveHeightPx = $state(0);
  let weatherProbeHeightPx = $state(0);
  let weatherProbeWidthPx = $state(0);
  let weatherLiveWidthPx = $state(0);
  let weatherProbeCardHeightPx = $state(0);
  let weatherProbeCardWidthPx = $state(0);
  let weatherLiveCardHeightPx = $state(0);
  let weatherLiveCardWidthPx = $state(0);
  let rightTrackChildExtents = $state("");
  let typhoonTitleMisalignmentPx = $state(0);
  let pageIndicatorBodyOverlapPx = $state(0);
  let pageIndicatorRiderOverlapPx = $state(0);
  let floodVisibilityViolationKeys = $state("");
  let floodReadableOverflowKeys = $state("");
  let floodPageInfeasible = $state("false");
  let floodPageFooter = $state("false");
  let floodVisibleCount = $state(0);
  let measurementSettled = $state(false);
  let measurementNonConverged = $state(false);
  let settleTrace = $state<SettleTraceEntry[]>([]);
  let epoch = $state(0);
  let epochKey = $state("0");
  let floorStage = $state<LadderStage>(0);
  let committedStage = $state<LadderStage>(0);
  let committedPlan = $state<ColumnPlan | null>(null);
  let committedSelection = $state<DisplaySelection | null>(null);
  // The solver may try a reduced centre cluster, but only this committed copy
  // is allowed to drive visible DOM. This keeps superseded settle epochs from
  // leaking a half-applied reduction.
  let solvingCenterClusterHidden = $state<CenterClusterItem[]>([]);
  let committedCenterClusterHidden = $state<CenterClusterItem[]>([]);
  let contentDemotionRequested = false;
  let settling = false;
  let settleRequested = false;
  let disposed = false;
  let lastInputKey = "";
  let lastContentKey = "";
  let fontsReady = typeof document === "undefined" || document.fonts == null;
  const layoutMotionCoordinator = createLayoutMotionCoordinator({
    root: () => standbyEl,
    durationMs: layoutMotionDuration,
  });

  function registerLayoutCard(node: HTMLElement, identity: LayoutMotionIdentity) {
    return layoutMotionCoordinator.register(node, identity);
  }

  function clearCloseTimer(): void {
    closeGen += 1;
    if (closeTimer != null) clearTimeout(closeTimer);
    closeTimer = null;
  }
  function selectRecentQuake(quake: DisplayRecentQuakeV1, id: string): void {
    if (selectedId === id) return closeQuakeCard();
    clearCloseTimer();
    selectedRecentQuake = quake;
    selectedId = id;
    const generation = closeGen;
    closeTimer = setTimeout(() => { if (generation === closeGen) closeQuakeCard(); }, QUAKE_CARD_AUTO_CLOSE_MS);
  }
  $effect(() => {
    rotationScheduler.setTransitionTarget(rotationSlotEl);
  });
  $effect(() => {
    const list = snapshot.recentQuakes;
    untrack(() => {
      if (selectedId == null) return;
      const matches = list.filter((quake) => recentQuakeId(quake) === selectedId);
      if (matches.length !== 1) closeQuakeCard();
      else selectedRecentQuake = matches[0]!;
    });
  });

  const standbyItems = $derived(snapshot.standbyItems ?? []);
  const unknownInputs = $derived(standbyItems.filter((item) => !KNOWN_KINDS.has(item.kind)));
  const knownItems = $derived(standbyItems.filter((item) => KNOWN_KINDS.has(item.kind)));
  const itemOf = <K extends ActiveStandbyCardV1["kind"]>(kind: K): Extract<ActiveStandbyCardV1, { kind: K }> | null =>
    (knownItems.find((item) => item.kind === kind) as Extract<ActiveStandbyCardV1, { kind: K }> | undefined) ?? null;
  const tornadoItem = $derived(itemOf("tornado"));
  const longPeriodItem = $derived(itemOf("longPeriod"));
  const floodItem = $derived(itemOf("flood"));
  const typhoonItem = $derived(itemOf("typhoon"));
  const volcanoItem = $derived(itemOf("volcano"));
  const heatItem = $derived(itemOf("heat"));
  const nankaiItem = $derived(itemOf("nankaiTrough"));
  const hasWeather = $derived(snapshot.weatherAlerts.length > 0 || tornadoItem != null);
  const hasQuake = $derived(snapshot.latestQuake != null || selectedRecentQuake != null);
  const connectionVisible = $derived(!sseConnected || snapshot.connection.dmdata === "disconnected");
  function weatherRoleRank(role: string): number {
    if (role === "weatherEmergency") return 3;
    if (role === "weatherWarning") return 2;
    return 1;
  }
  // weatherExpandedKinds / WeatherAlertCard と同じ表示単位。下位 role の alias が最高 role
  // の旧形式 fallback を汚染したり、候補配分を消費したりしないよう resolver 前に絞る。
  const highestWeatherRoleRank = $derived(Math.max(0, ...snapshot.weatherAlerts.map((alert) => weatherRoleRank(alert.role))));
  const displayWeatherAlerts = $derived(
    snapshot.weatherAlerts.filter((alert) => weatherRoleRank(alert.role) === highestWeatherRoleRank),
  );
  const weatherItemKindKeys = $derived.by(() => {
    const items = displayWeatherAlerts.flatMap((alert) => alert.items);
    const keys = resolveWeatherKindKeys(items);
    return new Map(items.map((item, index) => [item, keys[index]! ]));
  });
  function weatherKindKey(item: DisplayStateSnapshotV1["weatherAlerts"][number]["items"][number]): string {
    return weatherItemKindKeys.get(item) ?? resolveWeatherKindKeys([item])[0]!;
  }
  // source 横断の kind が同じ wire 集約値を個々の item へ複製すると、残置数をカード側で
  // 再合算してしまう。候補・残置は kindKey ごとに一度だけ選び、描画時は先頭 item を carrier にする。
  const weatherDisplayGroups = $derived.by(() => {
    type WeatherArea = { area: string; areaCode: string | null };
    const groups = new Map<string, { currentAreas: WeatherArea[]; areaSet: Set<string>; fallbackOmittedAreaCount: number }>();
    for (const alert of displayWeatherAlerts) {
      for (const item of alert.items) {
        const kindKey = weatherKindKey(item);
        const group = groups.get(kindKey) ?? { currentAreas: [], areaSet: new Set<string>(), fallbackOmittedAreaCount: 0 };
        for (const [areaIndex, area] of item.shownAreas.entries()) {
          const areaCode = item.shownAreaCodes?.[areaIndex] ?? null;
          const identity = weatherAreaIdentity(area, areaCode);
          if (group.areaSet.has(identity)) continue;
          group.areaSet.add(identity);
          group.currentAreas.push({ area, areaCode });
        }
        group.fallbackOmittedAreaCount += item.omittedAreaCount;
        if (!groups.has(kindKey)) groups.set(kindKey, group);
      }
    }
    return new Map([...groups].map(([kindKey, group]) => {
      const expanded = snapshot.weatherExpandedKinds?.find((candidate) => candidate.kindKey === kindKey);
      const areas = expanded == null
        ? group.currentAreas
        : expanded.areas.map((area, areaIndex) => ({ area, areaCode: expanded.areaCodes?.[areaIndex] ?? null }));
      return [kindKey, {
        currentAreas: group.currentAreas,
        areas,
        totalAreaCount: expanded?.totalAreaCount ?? group.currentAreas.length + group.fallbackOmittedAreaCount,
        candidateTruncated: expanded?.candidateTruncated === true,
      }];
    }));
  });

  function quakeWithSelection(rows: number): DisplayLatestQuakeStateV1 | null {
    const quake = snapshot.latestQuake;
    if (quake == null || rows <= 0) return quake;
    let remaining = rows;
    return {
      ...quake,
      intensityGroups: quake.intensityGroups.map((group) => {
        const source = group.expandedAreas ?? group.areas;
        const extra = Math.min(remaining, Math.max(0, source.length - group.areas.length));
        remaining -= extra;
        const areas = source.slice(0, group.areas.length + extra);
        const total = Math.max(group.areas.length + group.omittedAreaCount, source.length);
        return { ...group, areas, omittedAreaCount: Math.max(0, total - areas.length) };
      }),
    };
  }
  function weatherWithSelection(rows: number) {
    let remaining = rows;
    const selectedByKind = new Map<string, { areas: Array<{ area: string; areaCode: string | null }>; omittedAreaCount: number; candidateTruncated: boolean }>();
    for (const [kindKey, group] of weatherDisplayGroups) {
      const extra = Math.min(remaining, Math.max(0, group.areas.length - group.currentAreas.length));
      remaining -= extra;
      const areas = group.areas.slice(0, group.currentAreas.length + extra);
      selectedByKind.set(kindKey, {
        areas,
        omittedAreaCount: Math.max(0, group.totalAreaCount - areas.length),
        candidateTruncated: group.candidateTruncated,
      });
    }
    const emittedKinds = new Set<string>();
    return displayWeatherAlerts.map((alert) => ({
      ...alert,
      items: alert.items.map((item) => {
        const kindKey = weatherKindKey(item);
        const selected = selectedByKind.get(kindKey)!;
        if (emittedKinds.has(kindKey)) {
          return {
            ...item,
            shownAreas: [],
            ...(item.shownAreaCodes == null ? {} : { shownAreaCodes: [] }),
            omittedAreaCount: 0,
            candidateTruncated: false,
          };
        }
        emittedKinds.add(kindKey);
        return {
          ...item,
          shownAreas: selected.areas.map(({ area }) => area),
          ...(selected.areas.some(({ areaCode }) => areaCode != null)
            ? { shownAreaCodes: selected.areas.map(({ areaCode }) => areaCode ?? "") }
            : { shownAreaCodes: undefined }),
          omittedAreaCount: selected.omittedAreaCount,
          candidateTruncated: selected.candidateTruncated,
        };
      }),
    }));
  }
  function prefixTails(key: PrefixCardKey, rows: number): PrefixTail[] {
    if (key === "quake") {
      return (quakeWithSelection(rows)?.intensityGroups ?? []).flatMap((group, index) => group.omittedAreaCount > 0
        ? [{ kindKey: `${index}:${group.intensity}`, omittedAreaCount: group.omittedAreaCount }]
        : []);
    }
    return weatherWithSelection(rows).flatMap((alert) => alert.items.flatMap((item) => item.omittedAreaCount > 0
      ? [{ kindKey: weatherKindKey(item), omittedAreaCount: item.omittedAreaCount }]
      : []));
  }
  // Weather rows are B's *additional* areas; prefix ranges are rendered area
  // counts. A 3-row promotion over two current areas must probe [0,5), not
  // [0,3), or the shelf measures a different page from the live card.
  function prefixRenderedEnd(key: PrefixCardKey, rows: number): number {
    return key === "weather"
      ? weatherWithSelection(rows).reduce((total, alert) => total + alert.items.reduce((sum, item) => sum + item.shownAreas.length, 0), 0)
      : rows;
  }
  function prefixTailSignature(tails: readonly PrefixTail[]): string {
    return tails.map((tail) => `${encodeURIComponent(tail.kindKey)}=${tail.omittedAreaCount}`).join(",");
  }
  function prefixMeasureId(purpose: "prefix" | "page-fit", key: PrefixCardKey, placement: PrefixPlacement, start: number, end: number, tails: readonly PrefixTail[], floodForm?: FloodProbeForm): string {
    const omitted = tails.reduce((total, tail) => total + tail.omittedAreaCount, 0);
    const tailPart = tails.length === 0 ? "" : `:omitted:${omitted}:tails:${prefixTailSignature(tails)}`;
    return `${key}:${purpose}:${start}:${end}${tailPart}:placement:${placement}${floodForm == null ? "" : `:form:${floodForm}`}`;
  }
  function prefixHeight(key: PrefixCardKey, rows: number, placement: Placement): number | null {
    const tails = prefixTails(key, rows);
    // The left and right columns share one shelf and width.  Keep their B
    // cache entries identical too; only the center needs its own geometry.
    const measurePlacement: PrefixPlacement = placement === "center" ? "center" : "side";
    const id = prefixMeasureId("prefix", key, measurePlacement, 0, prefixRenderedEnd(key, rows), tails);
    const cached = prefixMeasurements[id];
    if (cached != null) return cached;
    // The first render precedes the mount/input effect that opens epoch 1.
    // Defer registration so probes cannot manufacture a synthetic epoch 0
    // that consumes one of the four bounded settle passes.
    if (epoch === 0) return null;
    coordinator.enqueueProbe(id, () => {
      if (prefixMeasureEntries.some((entry) => entry.id === id)) return;
      prefixMeasureEntries = [...prefixMeasureEntries, { id, key, placement: measurePlacement, start: 0, end: prefixRenderedEnd(key, rows), selectionRows: rows, tails, omittedAreaCount: tails.reduce((total, tail) => total + tail.omittedAreaCount, 0), purpose: "prefix" }];
    });
    return null;
  }
  function pagePartitionProbe(key: PrefixCardKey, placement: PrefixPlacement, fixedHeightPx = 1, floodForm?: FloodProbeForm): PartitionProbe {
    return (_cardKey, _probePlacement, range, tails) => {
      const override = typeof testMeasurementOverride === "function"
        ? testMeasurementOverride(measurementPass)
        : testMeasurementOverride;
      const id = prefixMeasureId("page-fit", key, placement, range.start, range.end, tails, floodForm);
      const genericOverride = override?.[`${key}:prefix:${range.end}:${placement}`];
      if (override?.[id] != null || genericOverride != null) return override?.[id] ?? genericOverride ?? null;
      // jsdom has no layout engine. Returning a fitting measurement here keeps
      // its U3 settle contract deterministic; browsers enter the shelf path.
      if (typeof ResizeObserver === "undefined") return 0;
      const cached = prefixMeasurements[id];
      if (cached != null) return cached;
      if (epoch === 0) return null;
      coordinator.enqueueProbe(id, () => {
        if (prefixMeasureEntries.some((entry) => entry.id === id)) return;
        prefixMeasureEntries = [...prefixMeasureEntries, {
          id, key, placement, start: range.start, end: range.end,
          tails: [...tails], omittedAreaCount: range.omittedAreaCount, purpose: "page", fixedHeightPx, floodForm,
          floodAggregateFallback: key === "flood" && range.start === 0 && range.end === 0,
        }];
      });
      return null;
    };
  }

  function defaultHeight(key: CardKey, variant: CardVariant): number {
    if (key === "tsunami") return 112;
    if (key === "quake") return variant === "expanded" ? 260 : 184;
    if (key === "weather") return variant === "expanded" ? 270 : 178;
    if (key === "typhoon") return variant === "full" ? 240 : 120;
    if (key === "heat") return 150;
    return 150;
  }
  function floodContractHeight(variant: CardVariant, placement: Placement): number {
    // Center always uses the actual physical form.  Side shelves retain the
    // expanded counterfactual for A/rotation solving; a compact rotation slot
    // therefore remains 200px even if the ordinary card is promoted wide.
    if (placement === "center") return floodItem?.surface === "clock-top-wide" && floodWideVisibleAllowed("center") ? floodWideFixedHeightPx : 200;
    return variant === "expanded" ? floodWideFixedHeightPx : 200;
  }
  function renderedFloodContractHeight(placement: Placement, selected: DisplaySelection): number {
    return renderFloodWide(placement, selectedVariant("flood", selected), false, selected) ? floodWideFixedHeightPx : 200;
  }
  function measureId(key: CardKey, variant: CardVariant, placement: Placement): MeasureId { return `${key}:${variant}:${placement}`; }
  function measured(key: CardKey, variant: CardVariant, placement: Placement): number {
    if (key === "flood") return floodContractHeight(variant, placement);
    return measurements[measureId(key, variant, placement)] ?? defaultHeight(key, variant);
  }
  function captureMeasure(node: HTMLElement, id: MeasureId) {
    measureNodes.set(id, node);
    let current = id;
    return { update(next: MeasureId) { measureNodes.delete(current); current = next; measureNodes.set(current, node); }, destroy() { measureNodes.delete(current); } };
  }
  function capturePrefixMeasure(node: HTMLElement, id: string) {
    prefixMeasureNodes.set(id, node);
    let current = id;
    return { update(next: string) { prefixMeasureNodes.delete(current); current = next; prefixMeasureNodes.set(current, node); }, destroy() { prefixMeasureNodes.delete(current); } };
  }
  function candidatePresent(key: CardKey): boolean {
    return key === "tsunami" ? snapshot.tsunami != null
      : key === "quake" ? hasQuake
      : key === "weather" ? hasWeather
      : key === "flood" ? floodItem != null
      : key === "typhoon" ? typhoonItem != null
      : key === "volcano" ? volcanoItem != null
      : heatItem != null;
  }
  function candidates(): CardCandidate[] {
    return CARD_ORDER.filter(candidatePresent).map((key, order) => ({
      key, order, score: CARD_ORDER.length - order,
      variant: key === "typhoon" ? "full" : "compact",
      naturalHeight: measured(key, key === "typhoon" ? "full" : "compact", "right"),
      centerNaturalHeight: measured(key, key === "typhoon" ? "full" : "compact", "center"),
      measurements: {
        compact: { naturalHeight: measured(key, "compact", "right"), centerNaturalHeight: measured(key, "compact", "center") },
        expanded: { naturalHeight: measured(key, "expanded", "right"), centerNaturalHeight: measured(key, "expanded", "center") },
        full: { naturalHeight: measured(key, "full", "right"), centerNaturalHeight: measured(key, "full", "center") },
      },
      maxRegionRows: key === "quake"
        ? Math.min(MAX_PREFIX_ROWS, snapshot.latestQuake?.intensityGroups.reduce((total, group) =>
          total + Math.max(0, (group.expandedAreas?.length ?? group.areas.length) - group.areas.length), 0) ?? 0)
        : key === "weather"
          ? Math.min(MAX_PREFIX_ROWS, [...weatherDisplayGroups.values()].reduce((total, group) =>
            total + Math.max(0, group.areas.length - group.currentAreas.length), 0))
          : 0,
    }));
  }
  function pageFormattingActive(key: CardKey): boolean {
    const page = key === "quake" || key === "weather" ? cardPageCoordinator.cardDiagnostics(key).page : "0/0";
    const pageCount = Number(page.split("/")[1] ?? 0);
    if (pageCount > 1) return true;
    if (key === "weather") {
      return [...weatherDisplayGroups.values()].some((group) =>
        group.candidateTruncated || group.totalAreaCount > group.areas.length);
    }
    return key === "quake" && (snapshot.latestQuake?.intensityGroups.some((group) =>
      group.omittedAreaCount > 0 || (group as { candidateTruncated?: boolean }).candidateTruncated === true) ?? false);
  }
  function selectedCardHeight(card: CardCandidate, placement: Placement): number {
    if (card.key === "flood") return renderedFloodContractHeight(placement, renderSelection);
    const rows = card.key === "quake" ? renderSelection.quakeRows : card.key === "weather" ? renderSelection.weatherRows : 0;
    const measurementPlacement = placement === "center" ? "center" : "right";
    if (rows > 0 && (card.key === "quake" || card.key === "weather")) {
      const tails = prefixTails(card.key, rows);
      const prefixPlacement: PrefixPlacement = placement === "center" ? "center" : "side";
      const id = prefixMeasureId("prefix", card.key, prefixPlacement, 0, prefixRenderedEnd(card.key, rows), tails);
      // B が採用するのは prefixHeight と同じ棚の実測値。描画側で probe を
      // 追加せず、未確定時だけ variant 棚へ安全に戻す。
      return prefixMeasurements[id] ?? measured(card.key, selectedVariant(card.key, renderSelection), measurementPlacement);
    }
    return measured(card.key, selectedVariant(card.key, renderSelection), measurementPlacement);
  }
  function pageFixedHeight(card: CardCandidate, placement: Placement): number | null {
    // Flood's page-shell budget is a declared contract, not a shelf result.
    // Keep the outer live shell identical to every solver path while probes
    // are still pending; a one-page result simply leaves the card's own
    // non-paged height-budget styling in control inside that shell.
    if (card.key === "flood") return renderedFloodContractHeight(placement, renderSelection);
    return pageFormattingActive(card.key) ? selectedCardHeight(card, placement) : null;
  }
  function centerFixed(hidden: readonly CenterClusterItem[], measureGap = gapPx) {
    // quiet のように connection / stats / recent-quakes が全て無い入力では
    // 固定クラスタは存在しないため height=0 が正しい。r-f fixture はその
    // 場合を避け、固定行を持つ scenario 4 でのみ縮退を実証する。
    const statsVisible = snapshot.stats != null && !hidden.includes("stats");
    const recentVisible = snapshot.recentQuakes.length > 0 && !hidden.includes("recent-quakes");
    const itemCount = (connectionVisible ? 1 : 0) + Number(statsVisible) + Number(recentVisible);
    const contentHeight = (connectionVisible ? connectionHeightPx : 0)
      + (statsVisible ? statsHeightPx : 0)
      + (recentVisible ? recentHeightPx : 0);
    return { statsVisible, recentVisible, itemCount, contentHeight, height: contentHeight + Math.max(0, itemCount - 1) * measureGap };
  }
  // jsdom and the initial pre-layout pass report a zero rect. Until the first
  // synchronous read has a real screen-area size, retain all cards rather
  // than manufacture a stage-3 overflow from that transient zero.
  // .legacy-layout itself ends above the Nankai band.  Price that reserved
  // rectangle once through its measured height; subtracting it here as well
  // would make solver capacity diverge from the visible side columns.
  const capacity = $derived(layoutHeightPx === 0 ? 10_000 : Math.max(0, layoutHeightPx));
  function selectedHeight(cards: readonly CardCandidate[], placement: Placement, selection: DisplaySelection, measureGap = gapPx): number | null {
    const measurementPlacement = placement === "center" ? "center" : "right";
    let total = Math.max(0, cards.length - 1) * measureGap;
    for (const card of cards) {
      const rows = card.key === "quake" ? selection.quakeRows : card.key === "weather" ? selection.weatherRows : 0;
      const height = card.key === "flood"
        ? renderedFloodContractHeight(placement, selection)
        : rows > 0 && (card.key === "quake" || card.key === "weather")
        ? prefixHeight(card.key, rows, placement)
        : measured(card.key, selectedVariant(card.key, selection), measurementPlacement);
      if (height == null) return null;
      total += height;
    }
    return total;
  }
  function naturalColumnHeight(cards: readonly CardCandidate[]): number {
    return cards.reduce((total, card) => total + card.naturalHeight, 0) + Math.max(0, cards.length - 1) * gapPx;
  }
  function floodWideProbeResult(placement: "side" | "center"): boolean | null {
    if (floodItem == null || floodItem.surface !== "clock-top-wide") return false;
    const override = typeof testMeasurementOverride === "function"
      ? testMeasurementOverride(measurementPass)
      : testMeasurementOverride;
    const widthPx = placement === "center"
      ? override?.centerMeasureShelfWidthPx ?? centerMeasureShelfWidthPx
      : override?.sideMeasureShelfWidthPx ?? sideMeasureShelfWidthPx;
    // Unknown geometry is not permission to promote. The measurement epoch
    // will re-evaluate once the shelf owns the same positive width as live.
    if (widthPx <= 0) return null;
    // This is deliberately a coordinator-free one-river shelf probe.  The
    // form selection must not depend on live registration/reset state.
    const fixedHeightPx = floodWideFixedHeightPx;
    const result = pagePartitionProbe("flood", placement, fixedHeightPx, "wide")(
      "flood", placement, { start: 0, end: 1, tails: [], omittedAreaCount: 0 }, [],
    );
    return result == null ? null : result <= fixedHeightPx;
  }
  /** Coordinator-free, initial-unknown-is-not-a-promotion eligibility guard. */
  function floodWideDetailAllowed(placement: "side" | "center"): boolean {
    return floodWideProbeResult(placement) === true;
  }
  function floodWidePartitionInfeasible(placement: "side" | "center"): boolean {
    if (floodItem == null || floodItem.surface !== "clock-top-wide") return false;
    const result = sequentialPartitionRanges(
      "flood", placement, floodItem.data.rivers.length, floodWideFixedHeightPx,
      pagePartitionProbe("flood", placement, floodWideFixedHeightPx, "wide"), () => [],
    );
    // Pending is not a demotion signal. A fully measured empty partition is
    // the wide-form failure which must hand control to compact first.
    return result.pending.length === 0 && result.infeasible && result.ranges.length === 0;
  }
  function centerHeight(choice: PlacementChoice, selection: DisplaySelection, hidden: readonly CenterClusterItem[], measureGap = gapPx): number {
    const fixedCenter = centerFixed(hidden, measureGap);
    const fixed = fixedCenter.height;
    const selected = selectedHeight(choice.center, "center", selection, measureGap);
    return (selected ?? Number.POSITIVE_INFINITY) + fixed + (choice.center.length > 0 && fixedCenter.itemCount > 0 ? measureGap : 0);
  }
  function solverContext(plan: ColumnPlan | null = null, capacityLimit = capacity, measureGap = gapPx, hidden: readonly CenterClusterItem[] = []): SolverContext {
    const fixedCenter = centerFixed(hidden, measureGap);
    const rotationReserve = plan == null ? 0
      : (plan.rotationSlotHeight > 0 ? (plan.right.length > 0 ? measureGap : 0) + plan.rotationSlotHeight : 0)
        + (plan.rotationFailureCount > 0 ? measureGap + (failureMeasureEl?.getBoundingClientRect().height ?? 28) : 0);
    return {
      measuredHeight: (key, variant) => measured(key, variant, "right"),
      measureSelection: (choice, selection) => {
        const leftHeight = selectedHeight(choice.left, "left", selection, measureGap);
        const rightHeight = selectedHeight(choice.right, "right", selection, measureGap);
        const selectedCenterHeight = choice.center.length === 0 ? 0 : centerHeight(choice, selection, hidden, measureGap);
        if (leftHeight == null || rightHeight == null || !Number.isFinite(selectedCenterHeight)) return null;
        return {
          leftOverflowPx: leftHeight - capacityLimit,
          // promoteAndExpand receives this context after stage 3 is fixed.  Its
          // surplus decision must retain the rotation slot and failure notice.
          rightOverflowPx: rightHeight + rotationReserve - capacityLimit,
          centerOverflowPx: selectedCenterHeight - capacityLimit,
        };
      },
      capacityPx: { left: capacityLimit, right: capacityLimit, center: capacityLimit },
      centerFixedHeightPx: fixedCenter.height,
      // A center placement is "wide" only when that surface retains detail;
      // otherwise comparison must not prefer it over the compact card.
      floodIsWide: floodWideVisibleAllowed("center"),
      floodWidePromotionAllowed: floodWideVisibleAllowed("side"),
      candidateSupplyLimit: MAX_PREFIX_ROWS,
      rotationSlotHeight: (keys) => keys.length === 0
        ? 0
        : Math.max(0, ...keys.map((key) => measured(key, "compact", "right"))) + rotationIndicatorHeightPx,
      failureRowHeight: failureMeasureEl?.getBoundingClientRect().height ?? 28,
      gapPx: measureGap,
    };
  }
  function compressedGap(): number {
    // Mirror the compressed rule from the independently measured baseline gap
    // before the compressed CSS class itself is drawn.
    return Math.min(10, Math.max(4, baselineGapPx * 0.6));
  }
  function automaticPlan(capacityLimit: number, hidden: readonly CenterClusterItem[] = []): ColumnPlan {
    const baseline = makeColumnPlan({ candidates: candidates(), ctx: solverContext(null, capacityLimit, baselineGapPx, hidden), floorStage: 0, requestedLadder: null });
    if (baseline.stage !== 3) return baseline;
    const compressedMeasureGap = compressedGap();
    const compressed = makeColumnPlan({
      candidates: candidates(),
      ctx: solverContext(null, capacityLimit, compressedMeasureGap, hidden),
      floorStage: 2,
      requestedLadder: null,
    });
    return compressed.stage === 2 && !compressed.unresolved ? compressed : baseline;
  }
  function solvePlan(solveFloor: LadderStage, capacityLimit = capacity, hidden: readonly CenterClusterItem[] = []): ColumnPlan {
    const automatic = automaticPlan(capacityLimit, hidden);
    if (automatic.stage >= solveFloor) return automatic;
    const retainedGap = solveFloor >= 2 ? compressedGap() : baselineGapPx;
    return makeColumnPlan({
      candidates: candidates(),
      ctx: solverContext(null, capacityLimit, retainedGap, hidden),
      floorStage: solveFloor,
      requestedLadder: solveFloor,
    });
  }
  const fixedCenter = $derived(centerFixed(committedCenterClusterHidden));
  const plan = $derived.by(() => solvePlan(floorStage, capacity, solvingCenterClusterHidden));
  const selection = $derived.by(() => promoteAndExpand(plan, solverContext(plan, capacity, gapPx, solvingCenterClusterHidden)));
  const stage = $derived(plan.stage);
  // A solver epoch may revise placement several times while measurements and
  // prefix probes converge.  The visible grid stays on this last complete
  // snapshot until the next result has settled, so center ownership and card
  // placement cannot be observed from different plans in one frame.
  const initialRenderPlan = $derived.by((): ColumnPlan => ({
    ...plan,
    stage: 0,
    // Before the first measurement result commits, retain the conventional
    // clock-centered layout and keep cards out of the unowned center column.
    right: [...plan.right, ...plan.center],
    center: [],
    rotationKeys: [],
    rotationCurrentKey: null,
    rotationSlotHeight: 0,
    rotationFailureCount: 0,
  }));
  const renderPlan = $derived(committedPlan ?? initialRenderPlan);
  const renderSelection = $derived(committedSelection ?? selection);
  const renderStage = $derived(committedPlan?.stage ?? initialRenderPlan.stage);
  function selectedVariant(key: CardKey, selected: DisplaySelection): CardVariant {
    if (key === "typhoon") return selected.typhoon;
    // The flood "expanded" shelf is the wide placement form.  It is a local
    // measurement variant, so B can price the post-promotion card directly.
    if (key === "flood" && selected.floodWide) return "expanded";
    if (key === "quake" && selected.quakeRows > 0) return "expanded";
    if (key === "weather" && selected.weatherRows > 0) return "expanded";
    return "compact";
  }
  let floodWideSticky = $state<{ key: string | null; side: boolean; center: boolean }>({ key: null, side: false, center: false });
  function floodWideVisibleAllowed(placement: "side" | "center"): boolean {
    const result = floodWideProbeResult(placement);
    if (result != null) return result;
    // Unknown may never cause an initial promotion, but a form already chosen
    // for this flood item must survive an epoch refresh until a confirmed fail.
    return floodWideSticky.key === floodItem?.key && floodWideSticky[placement];
  }
  function renderFloodWide(placement: Placement, variant: CardVariant, measuring: boolean, selected: DisplaySelection): boolean {
    if (floodItem == null || floodItem.surface !== "clock-top-wide") return false;
    // Keep the expanded shelf as the true wide counterfactual so the solver
    // can price it, even when the eligibility guard ultimately rejects it.
    if (measuring && variant === "expanded") return true;
    const surface = placement === "center" ? "center" : "side";
    const requested = placement === "center" || (!measuring && selected.floodWide);
    return requested && floodWideVisibleAllowed(surface) && !floodWidePartitionInfeasible(surface);
  }
  const displayVariant = (card: CardCandidate): CardVariant => selectedVariant(card.key, renderSelection);
  const rotationActiveKey = $derived(rotationScheduler.currentKey());
  const effectiveRotationKey = $derived.by(() => rotationActiveKey != null && renderPlan.rotationKeys.includes(rotationActiveKey)
    ? rotationActiveKey
    : renderPlan.rotationKeys[0] ?? null);
  const rotationPosition = $derived.by(() => {
    if (renderPlan.rotationKeys.length === 0) return "";
    const index = effectiveRotationKey == null ? 0 : renderPlan.rotationKeys.indexOf(effectiveRotationKey);
    return `${index + 1}/${renderPlan.rotationKeys.length}`;
  });
  const rotationCompactMaxHeightPx = $derived(renderPlan.rotationKeys.length === 0
    ? 0
    : Math.max(...renderPlan.rotationKeys.map((key) => measured(key, "compact", "right"))));
  const expandedCounts = $derived.by(() => {
    const quake = quakeWithSelection(renderSelection.quakeRows);
    const weatherByKind: Record<string, { count: number; n: number }> = {};
    for (const alert of weatherWithSelection(renderSelection.weatherRows)) {
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
        count: quake?.intensityGroups.reduce((total, group) => total + group.areas.length, 0) ?? 0,
        n: quake?.intensityGroups.reduce((total, group) => total + group.omittedAreaCount, 0) ?? 0,
      },
      weather: weatherByKind,
    });
  });
  const renderFloodForm = $derived.by(() => {
    if (floodItem == null) return "none";
    const placement = renderPlan.center.some((card) => card.key === "flood") ? "center" : "side";
    return renderFloodWide(placement === "center" ? "center" : "right", selectedVariant("flood", renderSelection), false, renderSelection) ? "wide" : "card";
  });
  const floodWideFixedHeightPx = $derived(viewportHeightPx * 0.3);
  $effect(() => {
    const key = floodItem?.key ?? null;
    if (key == null || floodItem?.surface !== "clock-top-wide") {
      if (floodWideSticky.key !== key || floodWideSticky.side || floodWideSticky.center) {
        floodWideSticky = { key, side: false, center: false };
      }
      return;
    }
    const side = floodWideProbeResult("side");
    const center = floodWideProbeResult("center");
    const next = {
      key,
      side: side == null ? floodWideSticky.key === key && floodWideSticky.side : side,
      center: center == null ? floodWideSticky.key === key && floodWideSticky.center : center,
    };
    if (next.key !== floodWideSticky.key || next.side !== floodWideSticky.side || next.center !== floodWideSticky.center) floodWideSticky = next;
  });
  // Selection retains a type-level default even when the candidate is absent.
  // The diagnostic describes rendered reality, not that solver default.
  const renderTyphoonVariant = $derived(typhoonItem == null ? "none" : renderSelection.typhoon);
  const renderSurplusUse = $derived.by(() => {
    const typhoonWasCompact = [...renderPlan.left, ...renderPlan.right, ...renderPlan.center]
      .find((card) => card.key === "typhoon")?.variant === "compact";
    const floodInSide = !renderPlan.center.some((card) => card.key === "flood");
    return renderSelection.quakeRows + renderSelection.weatherRows
      + Number(typhoonWasCompact && renderSelection.typhoon === "full")
      + Number(floodInSide && renderSelection.floodWide);
  });
  const renderWeatherSelectedHeight = $derived.by(() => {
    const card = [...renderPlan.left, ...renderPlan.right, ...renderPlan.center].find((candidate) => candidate.key === "weather");
    const placement: Placement = renderPlan.center.some((candidate) => candidate.key === "weather") ? "center"
      : renderPlan.left.some((candidate) => candidate.key === "weather") ? "left" : "right";
    // Compare the exact prefix probe used for this rendered surface. Do not
    // fall back through a side variant when the committed card is in center.
    if (card == null) return 0;
    if (renderSelection.weatherRows > 0) return prefixHeight("weather", renderSelection.weatherRows, placement) ?? 0;
    return measured("weather", selectedVariant("weather", renderSelection), placement === "center" ? "center" : "right");
  });
  const renderWeatherPrefixId = $derived.by(() => {
    if (renderSelection.weatherRows <= 0) return "";
    const placement: PrefixPlacement = renderPlan.center.some((card) => card.key === "weather") ? "center" : "side";
    const tails = prefixTails("weather", renderSelection.weatherRows);
    return prefixMeasureId("prefix", "weather", placement, 0, prefixRenderedEnd("weather", renderSelection.weatherRows), tails);
  });
  function snapshotPlan(source: ColumnPlan): ColumnPlan {
    return { ...source, left: [...source.left], right: [...source.right], center: [...source.center], moved: new Set(source.moved), rotationKeys: [...source.rotationKeys] };
  }

  $effect(() => {
    rotationScheduler.sync({
      stage: renderStage,
      keys: renderPlan.rotationKeys,
      suspended: renderStage === 3 && !measurementSettled,
    });
  });
  $effect(() => {
    // A placement remount or a non-active rotation slot is suspension. Only an
    // actual card disappearance/replay replacement exits the page substate.
    if (snapshot.latestQuake == null || selectedRecentQuake != null) cardPageCoordinator.unregister("quake");
    if (!hasWeather) cardPageCoordinator.unregister("weather");
    if (floodItem == null) cardPageCoordinator.unregister("flood");
  });

  function readMeasurements(): void {
    const measurementOverride = typeof testMeasurementOverride === "function"
      ? testMeasurementOverride(measurementPass)
      : testMeasurementOverride;
    const next: Record<string, number> = {};
    for (const [id, node] of measureNodes) next[id] = measurementOverride?.[id] ?? Math.round(node.getBoundingClientRect().height);
    const nextPrefixes = { ...prefixMeasurements };
    for (const [id, node] of prefixMeasureNodes) {
      const entry = prefixMeasureEntries.find((candidate) => candidate.id === id);
      const genericOverride = entry == null ? undefined : measurementOverride?.[`${entry.key}:prefix:${entry.end}:${entry.placement}`];
      if (entry?.purpose === "page") {
        const body = node.querySelector<HTMLElement>("[data-page-probe-body]");
        const card = node.querySelector<HTMLElement>("[data-page-probe-card]") ?? body;
        // 縦はページ番号・残置行・rider を含むカード全体、横は多段組の地域リストで判定する。
        // column-count の第3列以降は scrollHeight に現れないため、scrollWidth も必須。
        const cardFitsVertically = card == null || card.clientHeight === 0 || card.scrollHeight <= card.clientHeight + 1;
        const bodyFitsVertically = body == null || body.clientHeight === 0 || body.scrollHeight <= body.clientHeight + 1;
        const fitsHorizontally = body == null || body.clientWidth === 0 || body.scrollWidth <= body.clientWidth + 1;
        const fits = cardFitsVertically && bodyFitsVertically && fitsHorizontally;
        nextPrefixes[id] = measurementOverride?.[id] ?? genericOverride ?? (entry.key === "flood"
          ? floodPartitionProbeSentinel(fits, entry.fixedHeightPx ?? 0)
          : (fits ? 0 : 2));
      } else {
        nextPrefixes[id] = measurementOverride?.[id] ?? genericOverride ?? Math.round(node.getBoundingClientRect().height);
      }
    }
    const rect = layoutEl?.getBoundingClientRect();
    const style = layoutEl == null ? null : getComputedStyle(layoutEl);
    measurements = next;
    prefixMeasurements = nextPrefixes;
    layoutWidthPx = measurementOverride?.layoutWidthPx ?? Math.round(rect?.width ?? 0);
    layoutHeightPx = measurementOverride?.layoutHeightPx ?? Math.round(rect?.height ?? 0);
    leftTrackWidthPx = measurementOverride?.leftTrackWidthPx ?? Math.round(leftTrackEl?.getBoundingClientRect().width ?? 0);
    centerTrackWidthPx = measurementOverride?.centerTrackWidthPx ?? Math.round(centerTrackEl?.getBoundingClientRect().width ?? 0);
    rightTrackWidthPx = measurementOverride?.rightTrackWidthPx ?? Math.round(rightTrackEl?.getBoundingClientRect().width ?? 0);
    sideMeasureShelfWidthPx = measurementOverride?.sideMeasureShelfWidthPx ?? Math.round(sideMeasureShelfEl?.getBoundingClientRect().width ?? 0);
    centerMeasureShelfWidthPx = measurementOverride?.centerMeasureShelfWidthPx ?? Math.round(centerMeasureShelfEl?.getBoundingClientRect().width ?? 0);
    nankaiHeightPx = measurementOverride?.nankaiHeightPx ?? Math.round(nankaiEl?.getBoundingClientRect().height ?? 0);
    rotationIndicatorHeightPx = measurementOverride?.rotationIndicatorHeightPx ?? Math.round(rotationIndicatorMeasureEl?.getBoundingClientRect().height ?? 0);
    statsHeightPx = measurementOverride?.statsHeightPx ?? Math.round(statsMeasureEl?.getBoundingClientRect().height ?? 0);
    recentHeightPx = measurementOverride?.recentHeightPx ?? Math.round(recentMeasureEl?.getBoundingClientRect().height ?? 0);
    connectionHeightPx = measurementOverride?.connectionHeightPx ?? Math.round(connectionMeasureEl?.getBoundingClientRect().height ?? 0);
    // At stage 1+ this is the opacity-zero central handoff ghost; the visible
    // clock lives in the ticker outside the layout capacity and is not a card
    // collision target. Only stage 0's central clock has a meaningful rect.
    const clockRect = renderStage === 0 ? clockFaceEl?.getBoundingClientRect() : undefined;
    const nankaiRect = nankaiEl?.getBoundingClientRect();
    const standbyRect = standbyEl?.getBoundingClientRect();
    const boundaryTop = measurementOverride?.boundaryTopPx ?? nankaiRect?.top ?? standbyRect?.bottom;
    const clockBottom = measurementOverride?.clockBottomPx ?? clockRect?.bottom;
    const belowItemCount = (snapshot.stats == null ? 0 : 1) + (snapshot.recentQuakes.length === 0 ? 0 : 1);
    const belowContentHeight = (snapshot.stats == null ? 0 : statsHeightPx) + (snapshot.recentQuakes.length === 0 ? 0 : recentHeightPx);
    const freeLowerSpace = clockBottom == null || boundaryTop == null ? 0 : Math.max(0, Math.round(boundaryTop - clockBottom - belowContentHeight));
    clusterGapPx = belowItemCount > 0 && freeLowerSpace > 0 ? Math.floor(freeLowerSpace / (belowItemCount + 1)) : 0;
    clusterFlowHeightPx = belowItemCount > 0 ? belowContentHeight + Math.max(0, belowItemCount - 1) * clusterGapPx : 0;
    gapPx = measurementOverride?.gapPx ?? Math.max(0, Number.parseFloat(style?.rowGap ?? "12") || 12);
    baselineGapPx = measurementOverride?.baselineGapPx
      ?? (Math.max(0, Math.round(baselineGapMeasureEl?.getBoundingClientRect().width ?? 0)) || 12);
    measurementReadCount = measureNodes.size + prefixMeasureNodes.size + 14;
    measurementPass += 1;
  }
  function signature(): string {
    // Geometry 2 and 3 share the same compressed token surface. Only a
    // crossing of that boundary changes any measured DOM, so the later 2→3
    // plan-number synchronization must not consume a settle confirmation pass.
    const compressedGeometry = isCompressedGeometry(measurementGeometryStage) ? 1 : 0;
    return [stage, compressedGeometry, capacity, nankaiHeightPx, rotationIndicatorHeightPx, gapPx, baselineGapPx, plan.rotationKeys.join(","), ...Object.entries(measurements).sort(([a], [b]) => a.localeCompare(b)).map(([id, h]) => `${id}:${h}`), ...Object.entries(prefixMeasurements).sort(([a], [b]) => a.localeCompare(b)).map(([id, h]) => `${id}:${h}`)].join("|");
  }
  function isCompressedGeometry(stage: LadderStage): boolean { return stage >= 2; }
  function shortSignatureHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }
  function recordSettleTrace(pass: number, step: number): void {
    if (!gateCapture) return;
    const tracePlan = plan;
    const traceSelection = selection;
    settleTrace = [...settleTrace, {
      pass: pass + 1,
      step: step + 1,
      stage: tracePlan.stage,
      measurementGeometryStage,
      rotationKeys: tracePlan.rotationKeys.join(","),
      weatherRows: traceSelection.weatherRows,
      weatherVariant: selectedVariant("weather", traceSelection),
      signature: shortSignatureHash(signature()),
      pendingProbes: coordinator.pendingProbeCount(),
    }];
  }
  interface RenderedGeometry {
    leftTrackWidthPx: number;
    centerTrackWidthPx: number;
    rightTrackWidthPx: number;
    sideShelfWidthPx: number;
    centerShelfWidthPx: number;
    clockClipped: boolean;
    clockChildrenClipped: boolean;
    clockCenterDeltaXPx: number;
    clockCenterDeltaYPx: number;
    clockSecondsWithinCluster: boolean;
    clockDateWithinCluster: boolean;
    recentHypocentersClipped: boolean;
    recentQuakesTopPx: number;
    recentQuakesBottomPx: number;
    nankaiTopPx: number;
    nankaiBottomPx: number;
    recentQuakesNankaiOverlapPx: number;
    rotationViewportHeightPx: number;
    rotationFooterHeightPx: number;
    rotationOverlapPx: number;
    cardOverflowCount: number;
    cardOverflowKeys: string;
    pageViewportOverflowKeys: string;
    geometryViolationCount: number;
    geometryViolationKeys: string;
    rightTrackScrollHeightPx: number;
    rightTrackClientHeightPx: number;
    weatherLiveHeightPx: number;
    weatherProbeHeightPx: number;
    weatherProbeWidthPx: number;
    weatherLiveWidthPx: number;
    weatherProbeCardHeightPx: number;
    weatherProbeCardWidthPx: number;
    weatherLiveCardHeightPx: number;
    weatherLiveCardWidthPx: number;
    rightTrackChildExtents: string;
    typhoonTitleMisalignmentPx: number;
    pageIndicatorBodyOverlapPx: number;
    pageIndicatorRiderOverlapPx: number;
    floodVisibilityViolationKeys: string;
    floodReadableOverflowKeys: string;
    floodPageInfeasible: string;
    floodPageFooter: string;
    floodVisibleCount: number;
  }
  function readRenderedGeometry(): RenderedGeometry {
    const standbyRect = standbyEl?.getBoundingClientRect();
    const clockRect = clockFaceEl?.getBoundingClientRect();
    const clockEl = clockFaceEl;
    const clockChildren = clockEl == null ? [] : [...clockEl.querySelectorAll<HTMLElement>(".time, .time .sec, .date")];
    const containsHorizontally = (rect: DOMRect, bounds: DOMRect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    const clockClipped = clockRect != null && standbyRect != null
      && (!containsHorizontally(clockRect, standbyRect) || (clockEl != null && clockEl.scrollWidth > clockEl.clientWidth + 1));
    const clockChildrenClipped = standbyRect != null && clockChildren.some((child) => {
      const rect = child.getBoundingClientRect();
      return !containsHorizontally(rect, standbyRect) || child.scrollWidth > child.clientWidth + 1;
    });
    // §11.1 B: stage 0 is the visible central clock. Later stages retain an
    // opacity-zero handoff ghost and use the ticker-clock contract instead.
    const clockSeconds = clockEl?.querySelector<HTMLElement>(".time .sec") ?? null;
    const clockDate = clockEl?.querySelector<HTMLElement>(".date") ?? null;
    const rectContainedBy = (rect: DOMRect | null | undefined, bounds: DOMRect | null | undefined) => rect != null && bounds != null
      && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    // getBoundingClientRect() is viewport-relative. The standby box excludes
    // the ticker, while §3 centers the stage-0 clock in the whole screen, so
    // use the browser viewport rather than standbyRect as the reference box.
    const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
    const stageZeroClock = renderStage === 0 && clockRect != null && viewportWidth > 0 && viewportHeight > 0;
    const clockCenterDeltaXPx = stageZeroClock ? Math.abs((clockRect.left + clockRect.right - viewportWidth) / 2) : 0;
    const clockCenterDeltaYPx = stageZeroClock ? Math.abs((clockRect.top + clockRect.bottom - viewportHeight) / 2) : 0;
    const clockSecondsWithinCluster = renderStage !== 0 || rectContainedBy(clockSeconds?.getBoundingClientRect(), clockRect);
    const clockDateWithinCluster = renderStage !== 0 || rectContainedBy(clockDate?.getBoundingClientRect(), clockRect);
    const recentHypocentersClipped = gateCapture
      && [...(standbyEl?.querySelectorAll<HTMLElement>(".quakes-card .hypocenter") ?? [])]
        .some((hypocenter) => {
          const rowRect = hypocenter.closest<HTMLElement>(".row")?.getBoundingClientRect();
          const rect = hypocenter.getBoundingClientRect();
          return (rowRect != null && !containsHorizontally(rect, rowRect))
            || hypocenter.scrollWidth > hypocenter.clientWidth + 1;
        });
    const recentQuakesRect = (renderStage === 0
      ? standbyEl?.querySelector<HTMLElement>(".clock-landmark .quakes-card")
      : standbyEl?.querySelector<HTMLElement>(".center-card-region .quakes-card"))?.getBoundingClientRect();
    const nankaiRect = nankaiEl?.getBoundingClientRect();
    const recentQuakesNankaiOverlapPx = recentQuakesRect == null || nankaiRect == null
      ? 0
      : Math.max(0, Math.min(recentQuakesRect.bottom, nankaiRect.bottom) - Math.max(recentQuakesRect.top, nankaiRect.top));
    const rotationViewportRect = standbyEl?.querySelector<HTMLElement>(".rotation-card-viewport")?.getBoundingClientRect();
    // The measure shelf holds an aria-hidden copy of the footer earlier in
    // document order — select the live footer by its data attribute instead.
    const rotationFooterRect = standbyEl?.querySelector<HTMLElement>("[data-rotation-indicator]")?.getBoundingClientRect();
    const rotationOverlapPx = rotationViewportRect == null || rotationFooterRect == null
      ? 0
      : Math.max(0, Math.min(rotationViewportRect.bottom, rotationFooterRect.bottom) - Math.max(rotationViewportRect.top, rotationFooterRect.top));
    // Measurement shelves intentionally retain off-screen/hidden variants.
    // Geometry gates describe only paintable layout cards, never those copies.
    const paintable = (card: HTMLElement) => !card.closest(".measure-shelf, .center-measure-shelf")
      && !card.hidden && getComputedStyle(card).visibility !== "hidden"
      && getComputedStyle(card).display !== "none";
    const shells = [...(standbyEl?.querySelectorAll<HTMLElement>(".legacy-card") ?? [])].filter(paintable);
    // Fixed center members and the active rotation card do not use a
    // .legacy-card shell. They are nevertheless visible layout consumers and
    // must receive the same viewport/overlap/Nankai containment sweep.
    const fixedCenterCards = [...(standbyEl?.querySelectorAll<HTMLElement>(".center-stack-card[data-layout-motion-card], .connection-stage-card[data-layout-motion-card], .clock-connection[data-layout-motion-card]") ?? [])].filter(paintable);
    const activeRotationCards = [...(standbyEl?.querySelectorAll<HTMLElement>(".rotation-card:not([hidden])") ?? [])].filter(paintable);
    const sweepCards = [...shells, ...fixedCenterCards, ...activeRotationCards];
    // A paged shell deliberately clips the non-current pages to a fixed outer
    // height. Its actual viewport is the page body, so inspect that instead.
    const overflowingCards = [...shells, ...fixedCenterCards].filter((card) => !card.classList.contains("paged-card")
      && (card.scrollHeight > card.clientHeight + 1 || card.scrollWidth > card.clientWidth + 1));
    const pageViewportOverflow = shells.filter((card) => card.classList.contains("paged-card"))
      .filter((card) => [...card.querySelectorAll<HTMLElement>("[data-page-probe-body]")]
        .some((page) => page.scrollHeight > page.clientHeight + 1 || page.scrollWidth > page.clientWidth + 1));
    const cardOverflowKeys = overflowingCards.map((card) => card.dataset.layoutMotionCard ?? "unknown").join(",");
    const pageViewportOverflowKeys = pageViewportOverflow.map((card) => card.dataset.layoutMotionCard ?? "unknown").join(",");
    const cardOverflowCount = overflowingCards.length + pageViewportOverflow.length;
    const overlapArea = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const contained = (rect: DOMRect, bounds: DOMRect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    const cardRects = sweepCards.map((card) => card.getBoundingClientRect());
    const geometryViolationKeys: string[] = [];
    if (standbyRect != null) cardRects.forEach((rect, index) => { if (!contained(rect, standbyRect)) geometryViolationKeys.push(`viewport:${sweepCards[index].dataset.layoutMotionCard ?? index}`); });
    for (let index = 0; index < cardRects.length; index += 1) for (let other = index + 1; other < cardRects.length; other += 1) if (overlapArea(cardRects[index], cardRects[other]) > 1) geometryViolationKeys.push(`card-overlap:${sweepCards[index].dataset.layoutMotionCard ?? index}/${sweepCards[other].dataset.layoutMotionCard ?? other}`);
    // At stage 1+ the central clockFaceEl is the opacity-zero handoff ghost;
    // the visible clock lives in the ticker outside the layout capacity, so
    // only stage 0's central clock is a card-collision target.
    if (clockRect != null && renderStage === 0) cardRects.forEach((rect, index) => { if (overlapArea(rect, clockRect) > 1) geometryViolationKeys.push(`clock:${sweepCards[index].dataset.layoutMotionCard ?? index}`); });
    if (nankaiRect != null) cardRects.forEach((rect, index) => { if (overlapArea(rect, nankaiRect) > 1) geometryViolationKeys.push(`nankai:${sweepCards[index].dataset.layoutMotionCard ?? index}`); });
    if (rotationViewportRect != null) activeRotationCards.forEach((card) => {
      if (!contained(card.getBoundingClientRect(), rotationViewportRect)) geometryViolationKeys.push(`rotation-viewport:${card.dataset.layoutMotionCard ?? "unknown"}`);
    });
    [leftTrackEl, centerTrackEl, rightTrackEl].forEach((track, index) => { if (track != null && track.scrollHeight > track.clientHeight + 1) geometryViolationKeys.push(`column-scroll:${["left", "center", "right"][index]}`); });
    const geometryViolationCount = geometryViolationKeys.length;
    const typhoonTitleMisalignmentPx = Math.max(0, ...[...(standbyEl?.querySelectorAll<HTMLElement>(".typhoon-card") ?? [])].map((card) => {
      const name = card.querySelector<HTMLElement>(".typhoon-title-row strong, .compact-primary strong");
      const location = card.querySelector<HTMLElement>(".typhoon-title-row .location, .compact-primary .location");
      return name == null || location == null ? 0 : Math.abs((name.getBoundingClientRect().top + name.getBoundingClientRect().bottom) / 2 - (location.getBoundingClientRect().top + location.getBoundingClientRect().bottom) / 2);
    }));
    const pageIndicatorBodyOverlapPx = Math.max(0, ...[...(standbyEl?.querySelectorAll<HTMLElement>(".weather-card") ?? [])].map((card) => {
      const indicator = card.querySelector<HTMLElement>("[data-card-page-indicator]");
      const body = card.querySelector<HTMLElement>("[data-page-probe-body]");
      return indicator == null || body == null ? 0 : overlapArea(indicator.getBoundingClientRect(), body.getBoundingClientRect());
    }));
    const pageIndicatorRiderOverlapPx = Math.max(0, ...[...(standbyEl?.querySelectorAll<HTMLElement>(".weather-card") ?? [])].map((card) => {
      const indicator = card.querySelector<HTMLElement>("[data-card-page-indicator]");
      const rider = card.querySelector<HTMLElement>(".tornado-rider");
      return indicator == null || rider == null ? 0 : overlapArea(indicator.getBoundingClientRect(), rider.getBoundingClientRect());
    }));
    const floodCards = [...(standbyEl?.querySelectorAll<HTMLElement>(
      ".legacy-layout .flood-card, .legacy-layout .flood-wide-card",
    ) ?? [])];
    const hasRenderedBox = (element: HTMLElement): boolean => Array.from(element.getClientRects())
      .some((rect) => rect.width > 0 && rect.height > 0);
    const floodVisibilityViolationKeys = floodCards
      // Rotation keeps every candidate mounted and hides inactive wrappers.
      // Exempt exactly those inactive wrappers. A fixed or active compact card
      // that loses every box is a cascade failure and must stay observable.
      .filter((card) => card.classList.contains("flood-card")
        && card.closest(".rotation-card[hidden]") == null)
      .flatMap((card, cardIndex) => {
        const cardKey = `flood:${cardIndex}`;
        const entries = [...card.querySelectorAll<HTMLElement>("[data-flood-entry-index]")];
        const aggregates = [...card.querySelectorAll<HTMLElement>("[data-flood-aggregate]")];
        const infeasible = card.dataset.cardPageInfeasible != null && card.dataset.cardPageInfeasible !== "false";
        const range = /^(\d+):(\d+)$/.exec(card.dataset.floodPageRange ?? "");
        const expectedIndices = new Set<number>(infeasible || range == null
          ? []
          : Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1])) }, (_, offset) => Number(range[1]) + offset));
        const visibleIndices = new Set(entries
          .filter(hasRenderedBox)
          .flatMap((entry) => {
            const index = Number(entry.dataset.floodEntryIndex);
            return Number.isInteger(index) ? [index] : [];
          }));
        const expectedAggregateElement = infeasible
          ? aggregates.find((element) => element.dataset.floodAggregate === "infeasible") ?? null
          : null;
        return [
          ...(!hasRenderedBox(card) ? [`${cardKey}:card:missing`] : []),
          ...[...expectedIndices].filter((index) => !visibleIndices.has(index)).map((index) => `${cardKey}:entry:${index}:missing`),
          ...[...visibleIndices].filter((index) => !expectedIndices.has(index)).map((index) => `${cardKey}:entry:${index}:unexpected`),
          ...(infeasible && (expectedAggregateElement == null || !hasRenderedBox(expectedAggregateElement))
            ? [`${cardKey}:aggregate:infeasible:missing`]
            : []),
          ...aggregates.flatMap((aggregate) => {
            const variant = aggregate.dataset.floodAggregate ?? "unknown";
            return variant !== (infeasible ? "infeasible" : null) && hasRenderedBox(aggregate)
              ? [`${cardKey}:aggregate:${variant}:unexpected`]
              : [];
          }),
        ];
      })
      .join(",");
    const floodReadableOverflowKeys = floodCards
      .filter(paintable)
      .flatMap((card, cardIndex) => {
        const cardKey = `${card.classList.contains("flood-wide-card") ? "flood-wide" : "flood"}:${cardIndex}`;
        const cardRect = card.getBoundingClientRect();
        const readable = [...card.querySelectorAll<HTMLElement>(
          ".river-row, .station-row, .river-line, .cell-station, .cell-level",
        )].filter((element) => {
          const entry = element.closest<HTMLElement>("[data-flood-entry-index]");
          return paintable(element) && entry != null;
        });
        return [
          ...(card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1
            ? [`${cardKey}:root`]
            : []),
          ...readable.flatMap((element, index) => {
            const selfOverflow = element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
            const clippedByCard = !rectContainedBy(element.getBoundingClientRect(), cardRect);
            return selfOverflow || clippedByCard
              ? [`${cardKey}:${element.className.split(" ")[0] || "readable"}:${index}`]
              : [];
          }),
        ];
      })
      .join(",");
    const floodPageInfeasible = floodCards
      .filter(paintable)
      .map((card) => card.dataset.cardPageInfeasible ?? "false")
      .find((value) => value !== "false") ?? "false";
    const activeFloodCard = floodCards.find(paintable) ?? null;
    const floodPageFooter = activeFloodCard?.querySelector("[data-card-page-footer]") == null ? "false" : "true";
    const floodVisibleCount = activeFloodCard == null ? 0
      : [...activeFloodCard.querySelectorAll<HTMLElement>("[data-flood-entry-index]")].filter(hasRenderedBox).length;
    const weatherMeasurementPlacement: Placement = renderPlan.center.some((card) => card.key === "weather") ? "center" : "right";
    const weatherMeasurementVariant = selectedVariant("weather", renderSelection);
    // B selection reads a prefix shelf only after it has promoted rows. At
    // compact/full, it reads the ordinary variant shelf; use that same node
    // for the diagnostics rather than publishing a misleading zero probe.
    const activeWeatherProbe = renderWeatherPrefixId === ""
      ? measureNodes.get(measureId("weather", weatherMeasurementVariant, weatherMeasurementPlacement)) ?? null
      : [...(standbyEl?.querySelectorAll<HTMLElement>("[data-prefix-measure]") ?? [])]
        .find((entry) => entry.dataset.prefixMeasure === renderWeatherPrefixId) ?? null;
    const liveWeatherShell = standbyEl?.querySelector<HTMLElement>(".legacy-card .weather-card")?.closest<HTMLElement>(".legacy-card");
    // The shelf item itself is always the center/side track width. Measure the
    // WeatherAlertCard child too: unlike a live card it has no .legacy-card
    // ancestor, so a missing width bridge here would silently wrap at its own
    // 28vw maximum and poison the B-prefix cache.
    const weatherProbeCard = activeWeatherProbe?.querySelector<HTMLElement>(".weather-card");
    const liveWeatherCard = liveWeatherShell?.querySelector<HTMLElement>(".weather-card");
    return {
      leftTrackWidthPx: Math.round(leftTrackEl?.getBoundingClientRect().width ?? 0),
      centerTrackWidthPx: Math.round(centerTrackEl?.getBoundingClientRect().width ?? 0),
      rightTrackWidthPx: Math.round(rightTrackEl?.getBoundingClientRect().width ?? 0),
      sideShelfWidthPx: Math.round(sideMeasureShelfEl?.getBoundingClientRect().width ?? 0),
      centerShelfWidthPx: Math.round(centerMeasureShelfEl?.getBoundingClientRect().width ?? 0),
      clockClipped,
      clockChildrenClipped,
      clockCenterDeltaXPx: Math.round(clockCenterDeltaXPx * 100) / 100,
      clockCenterDeltaYPx: Math.round(clockCenterDeltaYPx * 100) / 100,
      clockSecondsWithinCluster,
      clockDateWithinCluster,
      recentHypocentersClipped,
      recentQuakesTopPx: Math.round(recentQuakesRect?.top ?? 0),
      recentQuakesBottomPx: Math.round(recentQuakesRect?.bottom ?? 0),
      nankaiTopPx: Math.round(nankaiRect?.top ?? 0),
      nankaiBottomPx: Math.round(nankaiRect?.bottom ?? 0),
      recentQuakesNankaiOverlapPx: Math.round(recentQuakesNankaiOverlapPx),
      rotationViewportHeightPx: Math.round(rotationViewportRect?.height ?? 0),
      rotationFooterHeightPx: Math.round(rotationFooterRect?.height ?? 0),
      rotationOverlapPx: Math.round(rotationOverlapPx),
      cardOverflowCount,
      cardOverflowKeys,
      pageViewportOverflowKeys,
      geometryViolationCount,
      geometryViolationKeys: geometryViolationKeys.join(","),
      rightTrackScrollHeightPx: rightTrackEl?.scrollHeight ?? 0,
      rightTrackClientHeightPx: rightTrackEl?.clientHeight ?? 0,
      weatherLiveHeightPx: Math.round(liveWeatherShell?.getBoundingClientRect().height ?? 0),
      weatherProbeHeightPx: Math.round(activeWeatherProbe?.getBoundingClientRect().height ?? 0),
      weatherProbeWidthPx: Math.round(activeWeatherProbe?.getBoundingClientRect().width ?? 0),
      weatherLiveWidthPx: Math.round(liveWeatherShell?.getBoundingClientRect().width ?? 0),
      weatherProbeCardHeightPx: Math.round(weatherProbeCard?.getBoundingClientRect().height ?? 0),
      weatherProbeCardWidthPx: Math.round(weatherProbeCard?.getBoundingClientRect().width ?? 0),
      weatherLiveCardHeightPx: Math.round(liveWeatherCard?.getBoundingClientRect().height ?? 0),
      weatherLiveCardWidthPx: Math.round(liveWeatherCard?.getBoundingClientRect().width ?? 0),
      // Per-child layout extents of the right track, for pinpointing which
      // element pushes scrollHeight past clientHeight in the gate.
      rightTrackChildExtents: rightTrackEl == null ? "" : [...rightTrackEl.children].map((child) => {
        const el = child as HTMLElement;
        return `${el.className.split(" ")[0] || el.tagName}:${el.offsetTop}+${el.offsetHeight}`;
      }).join(","),
      typhoonTitleMisalignmentPx: Math.round(typhoonTitleMisalignmentPx),
      pageIndicatorBodyOverlapPx: Math.round(pageIndicatorBodyOverlapPx),
      pageIndicatorRiderOverlapPx: Math.round(pageIndicatorRiderOverlapPx),
      floodVisibilityViolationKeys,
      floodReadableOverflowKeys,
      floodPageInfeasible,
      floodPageFooter,
      floodVisibleCount,
    };
  }
  function publishSettledGeometry(pendingStageChange: LadderStage | null): void {
    // This read is deliberately after the final plan flush. The subsequent
    // flush publishes every rect diagnostic and measurementSettled together.
    const geometry = readRenderedGeometry();
    flushSync(() => {
      leftTrackRectWidthPx = geometry.leftTrackWidthPx;
      centerTrackRectWidthPx = geometry.centerTrackWidthPx;
      rightTrackRectWidthPx = geometry.rightTrackWidthPx;
      sideMeasureShelfRectWidthPx = geometry.sideShelfWidthPx;
      centerMeasureShelfRectWidthPx = geometry.centerShelfWidthPx;
      clockHorizontallyClipped = geometry.clockClipped;
      clockChildrenHorizontallyClipped = geometry.clockChildrenClipped;
      clockCenterDeltaXPx = geometry.clockCenterDeltaXPx;
      clockCenterDeltaYPx = geometry.clockCenterDeltaYPx;
      clockSecondsWithinCluster = geometry.clockSecondsWithinCluster;
      clockDateWithinCluster = geometry.clockDateWithinCluster;
      recentHypocentersHorizontallyClipped = geometry.recentHypocentersClipped;
      recentQuakesRectTopPx = geometry.recentQuakesTopPx;
      recentQuakesRectBottomPx = geometry.recentQuakesBottomPx;
      nankaiRectTopPx = geometry.nankaiTopPx;
      nankaiRectBottomPx = geometry.nankaiBottomPx;
      recentQuakesNankaiOverlapPx = geometry.recentQuakesNankaiOverlapPx;
      rotationCardViewportRectHeightPx = geometry.rotationViewportHeightPx;
      rotationFooterRectHeightPx = geometry.rotationFooterHeightPx;
      rotationViewportFooterOverlapPx = geometry.rotationOverlapPx;
      cardOverflowCount = geometry.cardOverflowCount;
      cardOverflowKeys = geometry.cardOverflowKeys;
      pageViewportOverflowKeys = geometry.pageViewportOverflowKeys;
      geometryViolationCount = geometry.geometryViolationCount;
      geometryViolationKeys = geometry.geometryViolationKeys;
      rightTrackScrollHeightPx = geometry.rightTrackScrollHeightPx;
      rightTrackClientHeightPx = geometry.rightTrackClientHeightPx;
      weatherLiveHeightPx = geometry.weatherLiveHeightPx;
      weatherProbeHeightPx = geometry.weatherProbeHeightPx;
      weatherProbeWidthPx = geometry.weatherProbeWidthPx;
      weatherLiveWidthPx = geometry.weatherLiveWidthPx;
      weatherProbeCardHeightPx = geometry.weatherProbeCardHeightPx;
      weatherProbeCardWidthPx = geometry.weatherProbeCardWidthPx;
      weatherLiveCardHeightPx = geometry.weatherLiveCardHeightPx;
      weatherLiveCardWidthPx = geometry.weatherLiveCardWidthPx;
      rightTrackChildExtents = geometry.rightTrackChildExtents;
      typhoonTitleMisalignmentPx = geometry.typhoonTitleMisalignmentPx;
      pageIndicatorBodyOverlapPx = geometry.pageIndicatorBodyOverlapPx;
      pageIndicatorRiderOverlapPx = geometry.pageIndicatorRiderOverlapPx;
      floodVisibilityViolationKeys = geometry.floodVisibilityViolationKeys;
      floodReadableOverflowKeys = geometry.floodReadableOverflowKeys;
      floodPageInfeasible = geometry.floodPageInfeasible;
      floodPageFooter = geometry.floodPageFooter;
      floodVisibleCount = geometry.floodVisibleCount;
      measurementSettled = true;
      contentDemotionRequested = false;
      if (pendingStageChange != null) onStageChange?.(pendingStageChange);
    });
  }
  async function settleMeasurements(): Promise<void> {
    if (disposed || settling || !fontsReady) return;
    settling = true;
    settleRequested = false;
    measurementSettled = false;
    measurementNonConverged = false;
    settleTrace = [];
    const activeEpoch = String(epoch);
    epochKey = activeEpoch;
    coordinator.begin(activeEpoch);
    let previous = "";
    let superseded = false;
    let pendingStageChange: LadderStage | null = null;
    let postCommitVerificationPasses = 0;
    for (let pass = 0; pass < MAX_SETTLE_PASSES + postCommitVerificationPasses; pass += 1) {
      let probeSteps = 0;
      // B and the two U4 pageable cards may each consume their bounded probe
      // budget in the same epoch (128 × 2 candidates per card).
      const maxProbeSteps = MAX_PREFIX_ROWS * 4 + 1;
      do {
        await tick();
        if (disposed) break;
        readMeasurements();
        // The final plan can cross the stage-2 compression boundary after
        // measurements made in the preceding geometry. Re-read immediately in
        // the target geometry before this pass may settle; do not spend an
        // extra outer pass or extend the prefix-probe budget.
        if (isCompressedGeometry(measurementGeometryStage) !== isCompressedGeometry(plan.stage)) {
          // A target stage-3 plan must be remeasured in its compressed CSS,
          // but that remeasurement can make a lower (stage-1) plan look fit.
          // Latch the stage-2 floor before the synchronous read: otherwise the
          // same epoch flips geometry 0→3→1→3 and exhausts all settle passes.
          if (plan.stage >= 2) floorStage = Math.max(floorStage, 2) as LadderStage;
          measurementGeometryStage = (plan.stage >= 2 ? Math.max(plan.stage, 2) : plan.stage) as LadderStage;
          flushSync();
          await tick();
          if (disposed) break;
          readMeasurements();
        }
        if (contentDemotionRequested) {
          const hysteresisCapacity = Math.max(0, capacity - baselineGapPx * 2 - 0.01);
          const lowerPlan = solvePlan(0, hysteresisCapacity, solvingCenterClusterHidden);
          floorStage = lowerPlan.stage < committedStage ? lowerPlan.stage : committedStage;
        }
        coordinator.drainProbes();
        // Probe callbacks mount hidden shelf entries and can synchronously
        // register the next partition range. Flush those effects before the
        // pending check so the whole bounded probe chain stays in this pass.
        flushSync();
        recordSettleTrace(pass, probeSteps);
        probeSteps += 1;
      } while (!disposed && coordinator.hasPendingProbes() && probeSteps < maxProbeSteps);
      if (disposed) break;
      testProbeAfterMeasurementPass?.(coordinator, pass);
      const nextHidden = nextCenterClusterHidden({
        previous: solvingCenterClusterHidden,
        capacity,
        baseGap: baselineGapPx,
        unresolved: (hidden, capacityLimit) => {
          const candidate = solvePlan(floorStage, capacityLimit, hidden);
          // Fixed center overflow is independent of the card ladder: quiet
          // and stages 0–2 can have no center candidates while stats/recent
          // still need r-f reduction to stay above the Nankai reservation.
          return candidate.unresolved || centerFixed(hidden).height > capacityLimit;
        },
      });
      if (nextHidden.join(",") !== solvingCenterClusterHidden.join(",")) {
        solvingCenterClusterHidden = nextHidden;
        flushSync();
        previous = "";
        continue;
      }
      if (plan.stage > floorStage) floorStage = plan.stage;
      const next = signature();
      // The signature already carries the effective compressed/non-compressed
      // surface. Once it repeats with no pending shelf work, a raw stage 2↔3
      // synchronization cannot make the DOM more settled, so commit now.
      if (next === previous && !coordinator.hasPendingProbes()) {
        if (!coordinator.canSettle(activeEpoch)) {
          coordinator.settle();
          if (coordinator.epochKey() !== activeEpoch) { superseded = true; break; }
        } else {
          const nextPlan = snapshotPlan(plan);
          const nextSelection = { ...selection };
          const firstCommit = committedPlan == null;
          flushSync(() => {
            const stageChanged = committedStage !== nextPlan.stage;
            committedPlan = nextPlan;
            committedSelection = nextSelection;
            committedCenterClusterHidden = [...solvingCenterClusterHidden];
            committedStage = nextPlan.stage;
            measurementGeometryStage = nextPlan.stage;
            if (firstCommit || stageChanged || pendingStageChange != null) pendingStageChange = committedStage;
            testLateProbeDuringFinalCommit?.(coordinator);
          });
          if (!coordinator.settle()) {
            // A false settle is only a supersede if the epoch key changed. A
            // synchronous remount may have registered a same-epoch probe in
            // the final flush; drain and reconverge it within this bounded
            // settle loop instead of leaving both schedulers held.
            if (coordinator.epochKey() !== activeEpoch) {
              superseded = true;
              break;
            }
            // The final placement flush can mount a center/rotation page probe.
            // Materialize that same-epoch entry now. Give its resulting DOM
            // exactly one confirmation pass beyond the ordinary four-pass
            // bound; a second late probe cannot extend the epoch again.
            coordinator.drainProbes();
            flushSync();
            postCommitVerificationPasses = MAX_POST_COMMIT_VERIFICATION_PASSES;
            previous = "";
            continue;
          }
          publishSettledGeometry(pendingStageChange);
          pendingStageChange = null;
          layoutMotionCoordinator.runForEpoch(activeEpoch, () => {
            cardPageCoordinator.releaseAfterLayoutMotion();
            rotationScheduler.releaseAfterLayoutMotion();
          }, { skipMotion: firstCommit });
          break;
        }
      }
      previous = next;
    }
    if (!measurementSettled && !disposed && !superseded) {
      // The bounded loop must still terminate the epoch. Commit the last
      // measured plan with its diagnostic, then hand off or immediately
      // release the two schedulers instead of leaving them held forever.
      measurementNonConverged = true;
      testBeforeTerminalCommit?.(requestSettle);
      // Match the normal pre-commit boundary: a queued successor wins before
      // this epoch may mutate visible state or discard its probe ownership.
      if (!coordinator.canSettle(activeEpoch)) {
        coordinator.settle();
        if (coordinator.epochKey() !== activeEpoch) superseded = true;
      }
      if (!superseded) {
        const nextPlan = snapshotPlan(plan);
        const nextSelection = { ...selection };
        const firstCommit = committedPlan == null;
        flushSync(() => {
          const stageChanged = committedStage !== nextPlan.stage;
          committedPlan = nextPlan;
          committedSelection = nextSelection;
          committedCenterClusterHidden = [...solvingCenterClusterHidden];
          committedStage = nextPlan.stage;
          measurementGeometryStage = nextPlan.stage;
          if (firstCommit || stageChanged || pendingStageChange != null) pendingStageChange = committedStage;
        });
        // A probe still queued at pass exhaustion cannot keep the coordinator
        // busy, or the released schedulers cannot re-arm their next tick.
        coordinator.discardPendingProbes();
        const settled = coordinator.settle();
        if (!settled && coordinator.epochKey() !== activeEpoch) {
          superseded = true;
        } else {
          publishSettledGeometry(pendingStageChange);
          pendingStageChange = null;
          layoutMotionCoordinator.runForEpoch(activeEpoch, () => {
            cardPageCoordinator.releaseAfterLayoutMotion();
            rotationScheduler.releaseAfterLayoutMotion();
          }, { skipMotion: firstCommit || !settled });
        }
      }
      testAfterTerminalBoundary?.();
    }
    settling = false;
    if (settleRequested && !disposed) {
      settleRequested = false;
      void settleMeasurements();
    }
  }
  function requestSettle(): void {
    epoch += 1;
    epochKey = String(epoch);
    layoutMotionCoordinator.preEpochCapture(epochKey);
    coordinator.begin(epochKey);
    rotationScheduler.holdForEpoch();
    cardPageCoordinator.holdForEpoch();
    measurementSettled = false;
    measurementGeometryStage = committedPlan?.stage ?? 0;
    solvingCenterClusterHidden = [...committedCenterClusterHidden];
    prefixMeasurements = {};
    prefixMeasureEntries = [];
    if (settling) {
      settleRequested = true;
      return;
    }
    void settleMeasurements();
  }
  $effect.pre(() => {
    const contentKey = [snapshot.generatedAt, snapshot.seq, snapshot.latestQuake?.updatedAtMs ?? "", selectedId ?? "", snapshot.standbyItems?.map((item) => `${item.kind}:${item.updatedAt}`).join(",") ?? "", snapshot.weatherAlerts.map((alert) => alert.updatedAt).join(",")].join("|");
    const input = [contentKey, sseConnected].join("|");
    if (input !== lastInputKey) {
      lastInputKey = input;
      contentDemotionRequested = lastContentKey !== "" && contentKey !== lastContentKey;
      lastContentKey = contentKey;
      floorStage = committedStage;
      requestSettle();
    }
  });
  onMount(() => {
    const onViewportResize = () => {
      viewportHeightPx = window.innerHeight;
      // A geometry-only epoch may promote, but must retain its committed
      // stage.  Demotion is reserved for a content-changing epoch that clears
      // the strict two-gap hysteresis margin.
      contentDemotionRequested = false;
      floorStage = committedStage;
      requestSettle();
    };
    window.addEventListener("resize", onViewportResize);
    void document.fonts?.ready?.then(() => { fontsReady = true; requestSettle(); });
    // The reactive input effect normally opened epoch 1 before mount. Avoid
    // manufacturing a second identical epoch solely because nodes attached.
    if (epoch === 0) requestSettle();
    return () => window.removeEventListener("resize", onViewportResize);
  });
  onDestroy(() => {
    disposed = true;
    clearCloseTimer();
    layoutMotionCoordinator.dispose();
    rotationScheduler.dispose();
    cardPageCoordinator.dispose();
    coordinator.dispose();
  });

</script>

{#snippet renderCard(key: CardKey, variant: CardVariant = "compact", placement: Placement = "right", measuring = false, selected: DisplaySelection = selection)}
  {#if key === "tsunami" && snapshot.tsunami != null}
    <TsunamiStandbyBanner tsunami={snapshot.tsunami} onReplayLevel={onTsunamiReplay} />
  {:else if key === "quake" && selectedRecentQuake != null}
    <QuakeReplayCard quake={selectedRecentQuake} onClose={closeQuakeCard} />
  {:else if key === "quake" && snapshot.latestQuake != null}
    <LatestQuakeCard
      quake={quakeWithSelection(measuring ? (variant === "expanded" ? candidates().find((candidate) => candidate.key === "quake")?.maxRegionRows ?? 0 : 0) : selected.quakeRows) ?? snapshot.latestQuake}
      longPeriod={longPeriodItem == null || longPeriodItem.data.eventId !== snapshot.latestQuake.eventId ? null : { ...longPeriodItem.data, restored: longPeriodItem.restored }}
      pageCoordinator={measuring ? undefined : cardPageCoordinator}
      rotationMember={!measuring && renderPlan.rotationKeys.includes("quake")}
      pageScheduling={!measuring}
      partitionProbe={measuring ? undefined : pagePartitionProbe("quake", placement === "center" ? "center" : "side")}
      pagePlacement={placement === "center" ? "center" : "side"}
    />
  {:else if key === "weather"}
    <!-- A normal weather shelf entry needs the live 1/1 footer/rider surface,
         but must not start a private scheduler whose registration adds a
         post-measurement settle pass. -->
    <WeatherAlertCard
      alerts={weatherWithSelection(measuring
        ? (variant === "expanded" ? candidates().find((candidate) => candidate.key === "weather")?.maxRegionRows ?? 0 : 0)
        : selected.weatherRows)}
      tornado={tornadoItem}
      pageCoordinator={measuring ? undefined : cardPageCoordinator}
      rotationMember={!measuring && renderPlan.rotationKeys.includes("weather")}
      pageScheduling={!measuring}
      measurementPageFooter={measuring}
      partitionProbe={measuring ? undefined : pagePartitionProbe("weather", placement === "center" ? "center" : "side")}
      pagePlacement={placement === "center" ? "center" : "side"}
    />
  {:else if key === "flood" && floodItem != null}
    {@const wide = renderFloodWide(placement, variant, measuring, selected)}
    {#if wide}
      <FloodWideCard
        item={floodItem}
        pageCoordinator={measuring ? undefined : cardPageCoordinator}
        rotationMember={!measuring && renderPlan.rotationKeys.includes("flood")}
        pageScheduling={!measuring}
        partitionProbe={measuring ? undefined : pagePartitionProbe("flood", placement === "center" ? "center" : "side", floodWideFixedHeightPx, "wide")}
        pagePlacement={placement === "center" ? "center" : "side"}
        measurementFixedHeightPx={floodWideFixedHeightPx}
        pageForm="wide"
      />
    {:else}
      <FloodCard
        item={floodItem}
        pageCoordinator={measuring ? undefined : cardPageCoordinator}
        rotationMember={!measuring && renderPlan.rotationKeys.includes("flood")}
        pageScheduling={!measuring}
        partitionProbe={measuring ? undefined : pagePartitionProbe("flood", placement === "center" ? "center" : "side", 200, "compact")}
        pagePlacement={placement === "center" ? "center" : "side"}
        measurementFixedHeightPx={200}
        pageForm="compact"
      />
    {/if}
  {:else if key === "typhoon" && typhoonItem != null}<TyphoonCard item={typhoonItem} displayMode={variant === "full" ? "full" : "compact"} />
  {:else if key === "volcano" && volcanoItem != null}<VolcanoCard item={volcanoItem} />
  {:else if key === "heat" && heatItem != null}<HeatAlertCard item={heatItem} />
  {/if}
{/snippet}

{#snippet renderPrefixProbe(entry: PrefixMeasureEntry)}
  {#if entry.key === "quake" && snapshot.latestQuake != null}
    <LatestQuakeCard quake={quakeWithSelection(MAX_PREFIX_ROWS) ?? snapshot.latestQuake} longPeriod={longPeriodItem == null || longPeriodItem.data.eventId !== snapshot.latestQuake.eventId ? null : { ...longPeriodItem.data, restored: longPeriodItem.restored }} pageScheduling={false} measurementRange={entry} pagePlacement={entry.placement} />
  {:else if entry.key === "weather"}
    <!-- Keep the probe's omitted-tail rows identical to the live B prefix.
         Passing MAX_PREFIX_ROWS here erased the live "ほか n地域" rider and
         under-measured a grouped weather card by its omitted-row height. -->
    <WeatherAlertCard alerts={weatherWithSelection(entry.selectionRows ?? entry.end)} tornado={tornadoItem} pageScheduling={true} measurementRange={entry} pagePlacement={entry.placement} />
  {:else if entry.key === "flood" && floodItem != null}
    {#if entry.floodForm === "wide"}
      <FloodWideCard item={floodItem} measurementRange={entry} measurementPageFooter={!entry.floodAggregateFallback} measurementInfeasibleFallback={entry.floodAggregateFallback} pagePlacement={entry.placement} measurementFixedHeightPx={entry.fixedHeightPx ?? floodWideFixedHeightPx} pageForm="wide" />
    {:else}
      <FloodCard item={floodItem} measurementRange={entry} measurementPageFooter={!entry.floodAggregateFallback} measurementInfeasibleFallback={entry.floodAggregateFallback} pagePlacement={entry.placement} measurementFixedHeightPx={entry.fixedHeightPx ?? 200} pageForm="compact" />
    {/if}
  {/if}
{/snippet}

<div
  bind:this={standbyEl}
  class="standby" class:dim class:ladder-compressed={measurementGeometryStage >= 2} class:gate-overflow={gateFixture === "overflow"} class:gate-overlap={gateFixture === "overlap"} class:gate-rotation={gateFixture === "rotation"} class:gate-cluster={gateFixture === "cluster" || gateFixture === "cluster-calm"} style={`--nankai-reserve: ${nankaiHeightPx}px; --cluster-gap: ${clusterGapPx}px; --cluster-flow-height: ${clusterFlowHeightPx}px`}
  data-ladder-stage={renderStage}
  data-solver-stage={stage}
  data-layout-unresolved={renderPlan.unresolved ? "true" : "false"}
  data-measurement-settled={measurementSettled ? "true" : "false"}
  data-measurement-nonconverged={measurementNonConverged ? "true" : "false"}
  data-settle-trace={gateCapture ? JSON.stringify(settleTrace) : undefined}
  data-measurement-pass={measurementPass}
  data-measurement-read-count={measurementReadCount}
  data-layout-motion-duration={layoutMotionDuration}
  data-measurement-epoch={epochKey}
  data-suppressed-unknown-count={unknownInputs.length}
  data-left-natural-height-px={naturalColumnHeight(renderPlan.left)}
  data-right-natural-height-px={naturalColumnHeight(renderPlan.right) + (renderPlan.rotationSlotHeight > 0 ? gapPx + renderPlan.rotationSlotHeight : 0) + (renderPlan.rotationFailureCount > 0 ? gapPx + (failureMeasureEl?.getBoundingClientRect().height ?? 0) : 0)}
  data-center-natural-height-px={renderPlan.center.reduce((total, card) => total + card.centerNaturalHeight, fixedCenter.contentHeight) + Math.max(0, renderPlan.center.length + fixedCenter.itemCount - 1) * gapPx}
  data-left-capacity-px={capacity} data-right-capacity-px={capacity} data-center-capacity-px={capacity}
  data-layout-height-px={layoutHeightPx} data-layout-width-px={layoutWidthPx} data-nankai-height-px={nankaiHeightPx}
  data-left-track-width-px={leftTrackWidthPx} data-center-track-width-px={centerTrackWidthPx} data-right-track-width-px={rightTrackWidthPx}
  data-side-measure-shelf-width-px={sideMeasureShelfWidthPx} data-center-measure-shelf-width-px={centerMeasureShelfWidthPx}
  data-rotation-keys={renderPlan.rotationKeys.join(",")} data-rotation-omitted-count={renderPlan.rotationFailureCount}
  data-rotation-active-key={effectiveRotationKey ?? undefined}
  data-rotation-position={rotationPosition || undefined}
  data-rotation-tick-override={rotationTickOverride}
  data-rotation-slot-height-px={renderPlan.rotationSlotHeight}
  data-rotation-indicator-height-px={rotationIndicatorHeightPx}
  data-rotation-compact-max-height-px={rotationCompactMaxHeightPx}
  data-rotation-card-viewport-rect-height-px={rotationCardViewportRectHeightPx}
  data-rotation-footer-rect-height-px={rotationFooterRectHeightPx}
  data-rotation-viewport-footer-overlap-px={rotationViewportFooterOverlapPx}
  data-measurement-geometry-stage={measurementGeometryStage}
  data-left-track-rect-width-px={leftTrackRectWidthPx} data-center-track-rect-width-px={centerTrackRectWidthPx} data-right-track-rect-width-px={rightTrackRectWidthPx}
  data-side-measure-shelf-rect-width-px={sideMeasureShelfRectWidthPx} data-center-measure-shelf-rect-width-px={centerMeasureShelfRectWidthPx}
  data-clock-horizontal-clipped={clockHorizontallyClipped ? "true" : "false"}
  data-clock-children-horizontal-clipped={clockChildrenHorizontallyClipped ? "true" : "false"}
  data-clock-center-delta-x-px={clockCenterDeltaXPx}
  data-clock-center-delta-y-px={clockCenterDeltaYPx}
  data-clock-seconds-within-cluster={clockSecondsWithinCluster ? "true" : "false"}
  data-clock-date-within-cluster={clockDateWithinCluster ? "true" : "false"}
  data-recent-hypocenters-horizontal-clipped={recentHypocentersHorizontallyClipped ? "true" : "false"}
  data-weather-compact-side-height-px={hasWeather ? measured("weather", "compact", "right") : 0}
  data-weather-compact-center-height-px={hasWeather ? measured("weather", "compact", "center") : 0}
  data-center-cluster-hidden={committedCenterClusterHidden.join(",")}
  data-center-fixed-height-px={fixedCenter.height}
  data-recent-quakes-rect-top-px={recentQuakesRectTopPx} data-recent-quakes-rect-bottom-px={recentQuakesRectBottomPx}
  data-nankai-rect-top-px={nankaiRectTopPx} data-nankai-rect-bottom-px={nankaiRectBottomPx}
  data-recent-quakes-nankai-overlap-px={recentQuakesNankaiOverlapPx}
  data-card-overflow-count={cardOverflowCount}
  data-card-overflow-keys={cardOverflowKeys}
  data-page-viewport-overflow-keys={pageViewportOverflowKeys}
  data-geometry-violation-count={geometryViolationCount}
  data-geometry-violation-keys={geometryViolationKeys}
  data-right-track-scroll-height-px={rightTrackScrollHeightPx}
  data-right-track-client-height-px={rightTrackClientHeightPx}
  data-right-track-child-extents={rightTrackChildExtents}
  data-typhoon-title-misalignment-px={typhoonTitleMisalignmentPx}
  data-page-indicator-body-overlap-px={pageIndicatorBodyOverlapPx}
  data-page-indicator-rider-overlap-px={pageIndicatorRiderOverlapPx}
  data-flood-visibility-violation-keys={floodVisibilityViolationKeys}
  data-flood-readable-overflow-keys={floodReadableOverflowKeys}
  data-flood-page={cardPageCoordinator.cardDiagnostics("flood").page}
  data-flood-page-keys={JSON.stringify(cardPageCoordinator.cardDiagnostics("flood").keys)}
  data-flood-page-identities={JSON.stringify(cardPageCoordinator.cardDiagnostics("flood").identities)}
  data-flood-page-infeasible={floodPageInfeasible}
  data-flood-page-footer={floodPageFooter}
  data-flood-page-visible-count={floodVisibleCount}
  data-card-page={cardPageCoordinator.cardDiagnostics("quake").page}
  data-card-page-keys={JSON.stringify(cardPageCoordinator.cardDiagnostics("quake").keys)}
  data-card-page-identities={JSON.stringify(cardPageCoordinator.cardDiagnostics("quake").identities)}
  data-card-page-tick-override={cardPageTickOverride}
  data-scheduler-state={JSON.stringify({ rotation: rotationScheduler.diagnostics(), paging: cardPageCoordinator.diagnostics() })}
  data-expanded-counts={expandedCounts}
  data-prefix-probe-count={prefixMeasureEntries.length}
  data-typhoon-variant={renderTyphoonVariant}
  data-flood-form={renderFloodForm}
  data-flood-center-selected-height-px={floodItem == null ? undefined : renderedFloodContractHeight("center", renderSelection)}
  data-flood-center-measured-height-px={floodItem == null ? undefined : measured("flood", "compact", "center")}
  data-flood-center-probe-height-px={floodItem?.surface === "clock-top-wide" ? floodWideFixedHeightPx : 200}
  data-flood-center-outer-height-px={floodItem == null ? undefined : renderedFloodContractHeight("center", renderSelection)}
  data-flood-center-wide-allowed={floodWideVisibleAllowed("center") ? "true" : "false"}
  data-flood-rotation-slot-height-px={floodItem == null ? undefined : measured("flood", "compact", "right")}
  data-placement-left={renderPlan.left.map((card) => card.key).join(",")}
  data-placement-right={renderPlan.right.map((card) => card.key).join(",")}
  data-placement-center={renderPlan.center.map((card) => card.key).join(",")}
  data-placement-surplus-use={renderSurplusUse}
  data-weather-selected-height-px={renderWeatherSelectedHeight}
  data-weather-live-height-px={weatherLiveHeightPx}
  data-weather-probe-height-px={weatherProbeHeightPx}
  data-weather-probe-width-px={weatherProbeWidthPx}
  data-weather-live-width-px={weatherLiveWidthPx}
  data-weather-probe-card-height-px={weatherProbeCardHeightPx}
  data-weather-probe-card-width-px={weatherProbeCardWidthPx}
  data-weather-live-card-height-px={weatherLiveCardHeightPx}
  data-weather-live-card-width-px={weatherLiveCardWidthPx}
  data-weather-selected-prefix-id={renderWeatherPrefixId}
  data-outer-paging="none"
>
  <div class="measure-shelf" bind:this={sideMeasureShelfEl} aria-hidden="true" inert>
    {#each CARD_ORDER as key}
      {#if candidatePresent(key)}
        {#each ["compact", "expanded", "full"] as variant}
          <div class="measure-item" data-measure-variant={variant} use:captureMeasure={measureId(key, variant as CardVariant, "right")}>{@render renderCard(key, variant as CardVariant, "right", true)}</div>
        {/each}
      {/if}
    {/each}
    {#if hasWeather}
      <!-- Keep the rotation-slot (side geometry) page partition ready before
           stage 3 changes weather from a permanent card into a slot member. -->
      <div class="partition-preflight">
        <WeatherAlertCard alerts={weatherWithSelection(MAX_PREFIX_ROWS)} tornado={tornadoItem} pageScheduling={false} partitionProbe={pagePartitionProbe("weather", "side")} pagePlacement="side" />
      </div>
    {/if}
    {#if floodItem != null}
      <!-- Unit 2 preflights only the shelf. It neither registers a live pager
           nor changes solver/live flood rendering. -->
      <div class="flood-partition-preflight">
        <FloodCard item={floodItem} partitionProbe={pagePartitionProbe("flood", "side", 200, "compact")} pagePlacement="side" />
        {#if floodItem.surface === "clock-top-wide"}<FloodWideCard item={floodItem} partitionProbe={pagePartitionProbe("flood", "side", floodWideFixedHeightPx, "wide")} pagePlacement="side" measurementFixedHeightPx={floodWideFixedHeightPx} />{/if}
      </div>
    {/if}
    {#each prefixMeasureEntries.filter((entry) => entry.placement === "side") as entry (entry.id)}
      <div class="measure-item prefix-measure-item" data-prefix-measure={entry.id} data-prefix-rows={entry.end} data-page-probe={entry.purpose === "page" ? "true" : undefined} use:capturePrefixMeasure={entry.id}>{@render renderPrefixProbe(entry)}</div>
    {/each}
  </div>
  <div class="center-measure-shelf" bind:this={centerMeasureShelfEl} aria-hidden="true" inert>
    {#each CARD_ORDER as key}
      {#if candidatePresent(key)}
        {#each ["compact", "expanded", "full"] as variant}
          <div class="measure-item" data-measure-variant={variant} use:captureMeasure={measureId(key, variant as CardVariant, "center")}>{@render renderCard(key, variant as CardVariant, "center", true)}</div>
        {/each}
      {/if}
    {/each}
    {#if hasWeather}
      <!-- A stage-1/3 commit can move weather from a side into the center. Run
           its center-width page partition while the measurement shelf is
           already active, so the final placement flush has no new probe chain. -->
      <div class="partition-preflight">
        <WeatherAlertCard alerts={weatherWithSelection(MAX_PREFIX_ROWS)} tornado={tornadoItem} pageScheduling={false} partitionProbe={pagePartitionProbe("weather", "center")} pagePlacement="center" />
      </div>
    {/if}
    {#if floodItem != null}
      <div class="flood-partition-preflight">
        <FloodCard item={floodItem} partitionProbe={pagePartitionProbe("flood", "center", 200, "compact")} pagePlacement="center" />
        {#if floodItem.surface === "clock-top-wide"}<FloodWideCard item={floodItem} partitionProbe={pagePartitionProbe("flood", "center", floodWideFixedHeightPx, "wide")} pagePlacement="center" measurementFixedHeightPx={floodWideFixedHeightPx} />{/if}
      </div>
    {/if}
    {#each prefixMeasureEntries.filter((entry) => entry.placement === "center") as entry (entry.id)}
      <div class="measure-item prefix-measure-item" data-prefix-measure={entry.id} data-prefix-rows={entry.end} data-page-probe={entry.purpose === "page" ? "true" : undefined} use:capturePrefixMeasure={entry.id}>{@render renderPrefixProbe(entry)}</div>
    {/each}
    <!-- Keep shelf wrappers on the exact live surface too: r-f prices these
         rects directly, including their border/padding and fixture height. -->
    {#if snapshot.stats != null}<div class="center-stack-card instrument-row-wrap" bind:this={statsMeasureEl}><InstrumentRow stats={snapshot.stats} /></div>{/if}
    {#if snapshot.recentQuakes.length > 0}<div class="center-stack-card quakes-card" bind:this={recentMeasureEl}><RecentQuakes quakes={snapshot.recentQuakes} onSelect={selectRecentQuake} /></div>{/if}
  </div>
  <div class="baseline-gap-measure" bind:this={baselineGapMeasureEl} aria-hidden="true"></div>
  <div class="rotation-indicator-measure rotation-indicator-footer" bind:this={rotationIndicatorMeasureEl} aria-hidden="true"><span class="rotation-indicator">5/5</span></div>
  <div class="rotation-failure-measure" bind:this={failureMeasureEl} aria-hidden="true">ほか {renderPlan.rotationFailureCount} 件を表示できません</div>

  <section
    class="clock-landmark"
    class:clock-away={renderStage !== 0}
    data-clock-landmark={renderStage === 0 ? "true" : undefined}
    aria-label="画面中央時計と中央クラスタ"
    aria-hidden={renderStage === 0 ? undefined : "true"}
    inert={renderStage === 0 ? undefined : true}
  >
    <div class="clock-wrap">
      {#if renderStage === 0 && connectionVisible}<div class="clock-connection" data-layout-motion-card="connection:center" bind:this={connectionMeasureEl}><ConnectionBadge connection={snapshot.connection} {sseConnected} /></div>{/if}
      <div class="clock-face" bind:this={clockFaceEl}><Clock {now} /></div>
      {#if renderStage === 0}<div class="clock-below">{#if snapshot.stats != null}<div class="center-stack-card instrument-row-wrap" data-layout-motion-card="stats:center"><InstrumentRow stats={snapshot.stats} /></div>{/if}{#if snapshot.recentQuakes.length > 0}<div class="center-stack-card quakes-card" data-layout-motion-card="recent-quakes:center"><RecentQuakes quakes={snapshot.recentQuakes} onSelect={selectRecentQuake} /></div>{/if}</div>{/if}
    </div>
  </section>
  <section class="legacy-layout" bind:this={layoutEl} aria-label="従来待機画面 改良">
    <div class="side corner-left side-left" bind:this={leftTrackEl} data-side="left">
      {#each renderPlan.left as card (card.key)}
        {@const fixedHeight = pageFixedHeight(card, "left")}
        <article class="legacy-card corner-item" class:paged-card={fixedHeight != null} class:tsunami-corner={card.key === "tsunami"} class:quake-corner={card.key === "quake"} style:height={fixedHeight == null ? undefined : `${fixedHeight}px`} data-card-page-fixed-height={fixedHeight ?? undefined} data-layout-motion-card={`${card.key}:left`} use:registerLayoutCard={{ key: card.key, surface: "left" }}>{@render renderCard(card.key, displayVariant(card), "left", false, renderSelection)}</article>
      {/each}
    </div>
    {#if renderStage === 0}<div class="center-grid-spacer" bind:this={centerTrackEl} aria-hidden="true"></div>{:else}
      <section class="center-card-region center-landmark" bind:this={centerTrackEl} data-side="center">
        {#if connectionVisible}<div class="connection-stage-card" data-layout-motion-card="connection:center" bind:this={connectionMeasureEl}><ConnectionBadge connection={snapshot.connection} {sseConnected} /></div>{/if}
        {#each renderPlan.center as card (card.key)}
          {@const fixedHeight = pageFixedHeight(card, "center")}
          <article class="legacy-card" class:paged-card={fixedHeight != null} style:height={fixedHeight == null ? undefined : `${fixedHeight}px`} data-card-page-fixed-height={fixedHeight ?? undefined} data-layout-motion-card={`${card.key}:center`} use:registerLayoutCard={{ key: card.key, surface: "center" }}>{@render renderCard(card.key, displayVariant(card), "center", false, renderSelection)}</article>
        {/each}
        {#if fixedCenter.statsVisible}<div class="center-stack-card instrument-row-wrap" data-layout-motion-card="stats:center"><InstrumentRow stats={snapshot.stats!} /></div>{/if}
        {#if fixedCenter.recentVisible}<div class="center-stack-card quakes-card" data-layout-motion-card="recent-quakes:center"><RecentQuakes quakes={snapshot.recentQuakes} onSelect={selectRecentQuake} /></div>{/if}
      </section>
    {/if}
    <div class="side corner-right side-right" bind:this={rightTrackEl} data-side="right">
      {#each renderPlan.right as card (card.key)}
        {@const fixedHeight = pageFixedHeight(card, "right")}
        <article class="legacy-card" class:paged-card={fixedHeight != null} class:weather-corner={card.key === "weather"} class:flood-slot={card.key === "flood"} style:height={fixedHeight == null ? undefined : `${fixedHeight}px`} data-card-page-fixed-height={fixedHeight ?? undefined} data-layout-motion-card={`${card.key}:right`} use:registerLayoutCard={{ key: card.key, surface: "right" }}>{@render renderCard(card.key, displayVariant(card), "right", false, renderSelection)}</article>
      {/each}
      {#if renderStage === 3}
        <div class="rotation-slot" bind:this={rotationSlotEl} style:height={`${renderPlan.rotationSlotHeight}px`}>
          <div class="rotation-card-viewport" style:min-height={`${Math.max(0, renderPlan.rotationSlotHeight - rotationIndicatorHeightPx)}px`}>
            {#each renderPlan.rotationKeys as key (key)}
              <div class="rotation-card" hidden={key !== effectiveRotationKey} data-rotation-card={key} data-layout-motion-card={`${key}:rotation`} use:registerLayoutCard={{ key, surface: "rotation" }}>
                {@render renderCard(key, "compact", "right", false, renderSelection)}
              </div>
            {/each}
          </div>
          <div class="rotation-indicator-footer" data-rotation-indicator aria-label={`輪番 ${rotationPosition}`}><span class="rotation-indicator">{rotationPosition}</span></div>
        </div>
        {#if renderPlan.rotationFailureCount > 0}<div class="rotation-failure">ほか {renderPlan.rotationFailureCount} 件を表示できません</div>{/if}
      {/if}
    </div>
  </section>
  {#if nankaiItem != null}<div class="nankai-ticker bottom-stack" bind:this={nankaiEl}><NankaiBadge item={nankaiItem} /></div>{/if}
</div>

<style>
  /* The shared center width must resolve from one absolute basis. A percentage
     would resolve against the grid for tracks but against .standby for shelves,
     making the solver measure a different width from the visible cards. */
  .standby { --base-edge: clamp(14px, 2.5vw, 48px); --base-gap: clamp(8px, 1vw, 18px); --compressed-edge: clamp(10px, 1.8vw, 32px); --compressed-gap: clamp(4px, .6vw, 10px); --edge: var(--base-edge); --gap: var(--base-gap); --side-readable-width: 17.5rem; --center-width: min(36rem, calc(100vw - var(--edge) * 2 - var(--gap) * 2 - var(--side-readable-width) * 2)); position: relative; width: 100%; height: 100%; overflow: hidden; color: var(--fg); background: var(--bg); transition: opacity var(--dur-standby-dim) ease; }
  /* Match the compact-stage token set used by the legacy measurement mock.
     Without these overrides the actual weather card keeps 8/12/16px padding
     while the mock measures 4/6/8px, adding about 32px for a three-prefecture
     weather card and spuriously rotating it at 1280x720. */
  .standby.ladder-compressed {
    --edge: var(--compressed-edge);
    --gap: var(--compressed-gap);
    --space-1: 2px;
    --space-2: 4px;
    --space-3: 6px;
    --space-4: 8px;
    --space-5: 10px;
  }
  .measure-shelf, .center-measure-shelf { position: absolute; top: 0; display: flex; flex-direction: column; width: min(30rem, calc((100% - var(--edge) * 2 - var(--gap) * 2 - var(--center-width)) / 2)); visibility: hidden; pointer-events: none; z-index: -1; }
  .measure-shelf { right: 0; } .center-measure-shelf { left: 50%; width: var(--center-width); transform: translateX(-50%); }
  .measure-shelf :global(*), .center-measure-shelf :global(*) { animation: none !important; transition: none !important; }
  .measure-item { width: 100%; flex: 0 0 auto; }
  /* The live card gets this through .legacy-card. Shelf cards are direct
     children, so bridge the same surface contract for every variant. */
  .measure-item :global(.weather-card),
  .measure-item :global(.standby-card),
  .measure-item :global(.flood-wide-card) { width: 100%; max-width: 100%; }
  .partition-preflight, .flood-partition-preflight { width: 100%; flex: 0 0 auto; }
  .baseline-gap-measure { position: absolute; width: var(--base-gap); height: 1px; visibility: hidden; pointer-events: none; }
  .rotation-indicator-measure { position: absolute; width: min(30rem, calc((100% - var(--edge) * 2 - var(--gap) * 2 - var(--center-width)) / 2)); visibility: hidden; pointer-events: none; }
  .rotation-failure-measure { position: absolute; visibility: hidden; width: min(30rem, calc((100% - var(--edge) * 2 - var(--gap) * 2 - var(--center-width)) / 2)); box-sizing: border-box; padding: var(--space-2) var(--space-3); border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); color: var(--role-muted); text-align: center; pointer-events: none; }
  .legacy-layout { position: absolute; inset: var(--edge) var(--edge) calc(var(--edge) + var(--nankai-reserve)); display: grid; grid-template-columns: minmax(0, 1fr) var(--center-width) minmax(0, 1fr); gap: var(--gap); min-height: 0; }
  .side, .center-card-region { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; min-height: 0; overflow: visible; }
  .side-left, .side-right { align-items: center; }
  .standby[data-ladder-stage="1"] .side, .standby[data-ladder-stage="2"] .side, .standby[data-ladder-stage="3"] .side, .center-card-region { justify-content: safe center; box-sizing: border-box; }
  .legacy-card, .rotation-slot, .rotation-failure { flex: 0 0 auto; box-sizing: border-box; width: min(30rem, 100%); max-width: 100%; }
  .legacy-card.paged-card { position: relative; overflow: hidden; }
  .legacy-card :global(.tsunami-banner), .legacy-card :global(.quake-card), .legacy-card :global(.weather-card), .legacy-card :global(.standby-card), .legacy-card :global(.flood-wide-card) { width: 100%; max-width: 100%; }
  .center-card-region > .legacy-card, .center-stack-card { width: 100%; }
  .center-stack-card { box-sizing: border-box; padding: var(--space-2) var(--space-3); border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); }
  .clock-landmark { position: fixed; inset: 0; z-index: 2; pointer-events: none; opacity: 1; transition: opacity var(--spring-spatial-default-dur) var(--spring-spatial-default); }
  .clock-landmark.clock-away { opacity: 0; }
  .clock-wrap { position: absolute; top: 50%; left: 50%; width: var(--center-width); container-type: inline-size; text-align: center; transform: translate(-50%, -50%); }
  .clock-connection { position: absolute; right: 0; bottom: calc(100% + var(--gap)); left: 0; }
  .clock-below { position: absolute; top: calc(100% + var(--cluster-gap)); left: 0; display: flex; flex-direction: column; justify-content: space-between; gap: var(--cluster-gap); width: 100%; height: var(--cluster-flow-height); }
  .instrument-row-wrap { display: flex; justify-content: center; } .quakes-card { box-sizing: border-box; padding: var(--space-2) var(--space-3); border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); }
  .nankai-ticker { position: absolute; z-index: 3; right: var(--edge); bottom: 0; left: var(--edge); } .nankai-ticker :global(.nankai-badge) { width: 100%; margin: 0; box-sizing: border-box; justify-content: center; }
  /* A shared grid track gives the viewport and footer one exact boundary.
     Flex item pixel distribution can otherwise make their independently
     rounded rects overlap by a subpixel in tall rotation slots. */
  /* The active compact card may be taller than its viewport. It is clipped
     inside the reserved slot; contain its descendants so that internal paint
     overflow cannot inflate the right track's scrollHeight. */
  .rotation-slot { display: grid; grid-template-rows: minmax(0, 1fr) auto; overflow: hidden; contain: layout paint; }
  .rotation-card-viewport { min-height: 0; width: 100%; overflow: hidden; }
  .rotation-card { width: 100%; } .rotation-card[hidden] { display: none; } .rotation-card > :global(*) { width: 100%; }
  .rotation-indicator-footer { display: flex; flex: 0 0 auto; justify-content: flex-end; box-sizing: border-box; width: 100%; padding: 0 var(--space-4) var(--space-2); }
  .rotation-indicator { padding: 1px var(--space-2); border: 1px solid var(--hairline); border-radius: var(--radius-s); background: color-mix(in srgb, var(--surface-standby) 92%, transparent); color: var(--role-muted); font-size: var(--type-label-xs-size); font-variant-numeric: tabular-nums; }
  .rotation-failure { padding: var(--space-2) var(--space-3); border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); color: var(--role-muted); text-align: center; }
  /* E-gate only: break the rendered layout, never the diagnostic values. */
  .standby.gate-overflow .legacy-card { height: 1px !important; overflow: hidden; }
  .standby.gate-overflow :global(.weather-card [data-page-probe-body]) { height: 1px; overflow: hidden; }
  /* Pin the ancestor-clipping counterexample too: readable flood rows can
     have no self overflow while their max-height root hides the lower rows. */
  .standby.gate-overflow :global(.flood-card),
  .standby.gate-overflow :global(.flood-wide-card) { height: 1px !important; min-height: 1px !important; max-height: 1px !important; overflow: hidden; }
  /* E-gate counterexample: remove only the compensated badge gap. The page
     indicator then paints directly into the tornado rider, so the production
     rect-overlap diagnostic (not an injected value) must turn red. */
  .standby.gate-overlap :global(.weather-card.has-page-footer.has-tornado .tornado-rider) { margin-top: 0; }
  /* E-gate success fixture: scenario 4 の stage 0–2 fixed cluster を
     measured/live とも膨らませ、r-f が時計を消さず縮退することを実証する。 */
  .standby.gate-cluster :global(.center-measure-shelf .center-stack-card.quakes-card),
  .standby.gate-cluster .center-card-region .center-stack-card.quakes-card,
  .standby.gate-cluster .clock-landmark .center-stack-card.quakes-card { min-height: 1000px; }
  .standby.gate-rotation .rotation-indicator-footer { display: none; }
  .standby.dim { opacity: .35; }
  /* Normal information and warning-grade fixed tiers remain separate groups:
     their current floor is equal, but keeping the selectors separate prevents
     a future severity adjustment from accidentally dimming tsunami with the
     ordinary quake group. */
  .standby.dim .quake-corner,
  .standby.dim .instrument-row-wrap,
  .standby.dim .quakes-card,
  .standby.dim .nankai-ticker { opacity: .7; }
  .standby.dim .weather-corner,
  .standby.dim .tsunami-corner,
  .standby.dim .flood-slot { opacity: .7; }
  @media (prefers-reduced-motion: reduce) { .standby, .clock-landmark { transition: none; } }
</style>
