<script lang="ts">
  import { flushSync, onDestroy, onMount, tick, untrack } from "svelte";
  import type { ActiveStandbyCardV1, DisplayLatestQuakeStateV1, DisplayRecentQuakeV1, DisplayStateSnapshotV1, DisplayTsunamiLevel } from "../lib/protocol";
  import { recentQuakeId } from "../lib/format";
  import { resolveWeatherKindKeys } from "../lib/weather-expanded-kinds";
  import { makeColumnPlan, promoteAndExpand, type SolverContext } from "../lib/legacy-standby/solver";
  import { SPRING_SPATIAL_DEFAULT_MS } from "../lib/motion";
  import { createEpochCoordinator, type EpochCoordinator } from "../lib/legacy-standby/epoch-coordinator";
  import type { PartitionProbe } from "../lib/legacy-standby/page-partition";
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

  let { snapshot, now, dim, sseConnected, onTsunamiReplay, onStageChange, testMeasurementOverride, rotationTick, cardPageTick }: {
    snapshot: DisplayStateSnapshotV1;
    now: Date;
    dim: boolean;
    sseConnected: boolean;
    onTsunamiReplay?: (level: DisplayTsunamiLevel) => void;
    onStageChange?: (stage: LadderStage) => void;
    /** Test-only deterministic geometry injection; never supplied by App. */
    testMeasurementOverride?: Partial<Record<string, number>>;
    /** Capture/test-only deterministic scheduler positions. */
    rotationTick?: number;
    cardPageTick?: number;
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
  const cardPageCoordinator = createCardPageCoordinator({ epoch: coordinator, tickOverride: cardPageTickOverride });
  const rotationScheduler = createRotationScheduler({
    epoch: coordinator,
    tickOverride: rotationTickOverride,
    onAppearance: (key) => cardPageCoordinator.recordRotationAppearance(key),
  });
  const MAX_SETTLE_PASSES = 4;
  // Layout changes are deliberately non-animated in U3; keep the shared
  // motion token as the hand-off point for U6 rather than a local duration.
  const layoutMotionDuration = SPRING_SPATIAL_DEFAULT_MS;
  const KNOWN_KINDS = new Set<string>(["volcano", "typhoon", "heat", "flood", "tornado", "longPeriod", "nankaiTrough"]);
  const CARD_ORDER: readonly CardKey[] = ["tsunami", "quake", "weather", "flood", "typhoon", "volcano", "heat"];
  const MAX_PREFIX_ROWS = 128;
  const QUAKE_CARD_AUTO_CLOSE_MS = 20_000;
  type Placement = "left" | "right" | "center";
  type PrefixPlacement = "side" | "center";
  type MeasureId = `${CardKey}:${CardVariant}:${Placement}`;
  type PrefixCardKey = "quake" | "weather";
  interface PrefixTail { kindKey: string; omittedAreaCount: number }
  interface PrefixMeasureEntry {
    id: string;
    key: PrefixCardKey;
    placement: PrefixPlacement;
    start: number;
    end: number;
    tails: PrefixTail[];
    omittedAreaCount: number;
    purpose?: "prefix" | "page";
  }

  let selectedRecentQuake = $state<DisplayRecentQuakeV1 | null>(null);
  let selectedId = $state<string | null>(null);
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let closeGen = 0;
  let standbyEl = $state<HTMLElement | null>(null);
  let layoutEl = $state<HTMLElement | null>(null);
  let nankaiEl = $state<HTMLElement | null>(null);
  let failureMeasureEl = $state<HTMLElement | null>(null);
  let rotationSlotEl = $state<HTMLElement | null>(null);
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
  let nankaiHeightPx = $state(0);
  let statsHeightPx = $state(0);
  let recentHeightPx = $state(0);
  let connectionHeightPx = $state(0);
  let clusterGapPx = $state(0);
  let clusterFlowHeightPx = $state(0);
  let gapPx = $state(12);
  let baselineGapPx = $state(12);
  let measurementPass = $state(0);
  let measurementReadCount = $state(0);
  let measurementSettled = $state(false);
  let measurementNonConverged = $state(false);
  let epoch = $state(0);
  let epochKey = $state("0");
  let floorStage = $state<LadderStage>(0);
  let committedStage = $state<LadderStage>(0);
  let committedPlan = $state<ColumnPlan | null>(null);
  let committedSelection = $state<DisplaySelection | null>(null);
  let contentDemotionRequested = false;
  let settling = false;
  let settleRequested = false;
  let disposed = false;
  let lastInputKey = "";
  let lastContentKey = "";
  let fontsReady = typeof document === "undefined" || document.fonts == null;

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
    const groups = new Map<string, { currentAreas: string[]; areaSet: Set<string>; fallbackOmittedAreaCount: number }>();
    for (const alert of displayWeatherAlerts) {
      for (const item of alert.items) {
        const kindKey = weatherKindKey(item);
        const group = groups.get(kindKey) ?? { currentAreas: [], areaSet: new Set<string>(), fallbackOmittedAreaCount: 0 };
        for (const area of item.shownAreas) {
          if (group.areaSet.has(area)) continue;
          group.areaSet.add(area);
          group.currentAreas.push(area);
        }
        group.fallbackOmittedAreaCount += item.omittedAreaCount;
        if (!groups.has(kindKey)) groups.set(kindKey, group);
      }
    }
    return new Map([...groups].map(([kindKey, group]) => {
      const expanded = snapshot.weatherExpandedKinds?.find((candidate) => candidate.kindKey === kindKey);
      const areas = expanded?.areas ?? group.currentAreas;
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
    const selectedByKind = new Map<string, { areas: string[]; omittedAreaCount: number; candidateTruncated: boolean }>();
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
          return { ...item, shownAreas: [], omittedAreaCount: 0, candidateTruncated: false };
        }
        emittedKinds.add(kindKey);
        return {
          ...item,
          shownAreas: selected.areas,
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
  function prefixTailSignature(tails: readonly PrefixTail[]): string {
    return tails.map((tail) => `${encodeURIComponent(tail.kindKey)}=${tail.omittedAreaCount}`).join(",");
  }
  function prefixMeasureId(purpose: "prefix" | "page-fit", key: PrefixCardKey, placement: PrefixPlacement, start: number, end: number, tails: readonly PrefixTail[]): string {
    const omitted = tails.reduce((total, tail) => total + tail.omittedAreaCount, 0);
    const tailPart = tails.length === 0 ? "" : `:omitted:${omitted}:tails:${prefixTailSignature(tails)}`;
    return `${key}:${purpose}:${start}:${end}${tailPart}:placement:${placement}`;
  }
  function prefixHeight(key: PrefixCardKey, rows: number, placement: Placement): number | null {
    const tails = prefixTails(key, rows);
    // The left and right columns share one shelf and width.  Keep their B
    // cache entries identical too; only the center needs its own geometry.
    const measurePlacement: PrefixPlacement = placement === "center" ? "center" : "side";
    const id = prefixMeasureId("prefix", key, measurePlacement, 0, rows, tails);
    const cached = prefixMeasurements[id];
    if (cached != null) return cached;
    // The first render precedes the mount/input effect that opens epoch 1.
    // Defer registration so probes cannot manufacture a synthetic epoch 0
    // that consumes one of the four bounded settle passes.
    if (epoch === 0) return null;
    coordinator.enqueueProbe(id, () => {
      if (prefixMeasureEntries.some((entry) => entry.id === id)) return;
      prefixMeasureEntries = [...prefixMeasureEntries, { id, key, placement: measurePlacement, start: 0, end: rows, tails, omittedAreaCount: tails.reduce((total, tail) => total + tail.omittedAreaCount, 0), purpose: "prefix" }];
    });
    return null;
  }
  function pagePartitionProbe(key: PrefixCardKey, placement: PrefixPlacement): PartitionProbe {
    return (_cardKey, _probePlacement, range, tails) => {
      // jsdom has no layout engine. Returning a fitting measurement here keeps
      // its U3 settle contract deterministic; browsers enter the shelf path.
      if (typeof ResizeObserver === "undefined") return 0;
      const id = prefixMeasureId("page-fit", key, placement, range.start, range.end, tails);
      const cached = prefixMeasurements[id];
      if (cached != null) return cached;
      if (epoch === 0) return null;
      coordinator.enqueueProbe(id, () => {
        if (prefixMeasureEntries.some((entry) => entry.id === id)) return;
        prefixMeasureEntries = [...prefixMeasureEntries, {
          id, key, placement, start: range.start, end: range.end,
          tails: [...tails], omittedAreaCount: range.omittedAreaCount, purpose: "page",
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
  function measureId(key: CardKey, variant: CardVariant, placement: Placement): MeasureId { return `${key}:${variant}:${placement}`; }
  function measured(key: CardKey, variant: CardVariant, placement: Placement): number {
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
    const rows = card.key === "quake" ? renderSelection.quakeRows : card.key === "weather" ? renderSelection.weatherRows : 0;
    const measurementPlacement = placement === "center" ? "center" : "right";
    if (rows > 0 && (card.key === "quake" || card.key === "weather")) {
      const tails = prefixTails(card.key, rows);
      const prefixPlacement: PrefixPlacement = placement === "center" ? "center" : "side";
      const id = prefixMeasureId("prefix", card.key, prefixPlacement, 0, rows, tails);
      // B が採用するのは prefixHeight と同じ棚の実測値。描画側で probe を
      // 追加せず、未確定時だけ variant 棚へ安全に戻す。
      return prefixMeasurements[id] ?? measured(card.key, selectedVariant(card.key, renderSelection), measurementPlacement);
    }
    return measured(card.key, selectedVariant(card.key, renderSelection), measurementPlacement);
  }
  function pageFixedHeight(card: CardCandidate, placement: Placement): number | null {
    return pageFormattingActive(card.key) ? selectedCardHeight(card, placement) : null;
  }
  const fixedCenterItemCount = $derived((connectionVisible ? 1 : 0) + (snapshot.stats == null ? 0 : 1) + (snapshot.recentQuakes.length === 0 ? 0 : 1));
  const fixedCenterContentHeight = $derived(
    (connectionVisible ? connectionHeightPx : 0)
      + (snapshot.stats == null ? 0 : statsHeightPx)
      + (snapshot.recentQuakes.length === 0 ? 0 : recentHeightPx),
  );
  const fixedCenterHeight = $derived(fixedCenterContentHeight + Math.max(0, fixedCenterItemCount - 1) * gapPx);
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
      const height = rows > 0 && (card.key === "quake" || card.key === "weather")
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
  function centerHeight(choice: PlacementChoice, selection: DisplaySelection, measureGap = gapPx): number {
    const fixed = fixedCenterContentHeight + Math.max(0, fixedCenterItemCount - 1) * measureGap;
    const selected = selectedHeight(choice.center, "center", selection, measureGap);
    return (selected ?? Number.POSITIVE_INFINITY) + fixed + (choice.center.length > 0 && fixedCenterItemCount > 0 ? measureGap : 0);
  }
  function solverContext(plan: ColumnPlan | null = null, capacityLimit = capacity, measureGap = gapPx): SolverContext {
    const rotationReserve = plan == null ? 0
      : (plan.rotationSlotHeight > 0 ? (plan.right.length > 0 ? measureGap : 0) + plan.rotationSlotHeight : 0)
        + (plan.rotationFailureCount > 0 ? measureGap + (failureMeasureEl?.getBoundingClientRect().height ?? 28) : 0);
    return {
      measuredHeight: (key, variant) => measured(key, variant, "right"),
      measureSelection: (choice, selection) => {
        const leftHeight = selectedHeight(choice.left, "left", selection, measureGap);
        const rightHeight = selectedHeight(choice.right, "right", selection, measureGap);
        const selectedCenterHeight = choice.center.length === 0 ? 0 : centerHeight(choice, selection, measureGap);
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
      centerFixedHeightPx: fixedCenterContentHeight + Math.max(0, fixedCenterItemCount - 1) * measureGap,
      floodIsWide: floodItem?.surface === "clock-top-wide",
      candidateSupplyLimit: MAX_PREFIX_ROWS,
      rotationSlotHeight: (keys) => Math.max(0, ...keys.map((key) => measured(key, "compact", "right"))),
      failureRowHeight: failureMeasureEl?.getBoundingClientRect().height ?? 28,
      gapPx: measureGap,
    };
  }
  function compressedGap(): number {
    // Mirror the compressed rule from the independently measured baseline gap
    // before the compressed CSS class itself is drawn.
    return Math.min(10, Math.max(4, baselineGapPx * 0.6));
  }
  function automaticPlan(capacityLimit: number): ColumnPlan {
    const baseline = makeColumnPlan({ candidates: candidates(), ctx: solverContext(null, capacityLimit, baselineGapPx), floorStage: 0, requestedLadder: null });
    if (baseline.stage !== 3) return baseline;
    const compressedMeasureGap = compressedGap();
    const compressed = makeColumnPlan({
      candidates: candidates(),
      ctx: solverContext(null, capacityLimit, compressedMeasureGap),
      floorStage: 2,
      requestedLadder: null,
    });
    return compressed.stage === 2 && !compressed.unresolved ? compressed : baseline;
  }
  function solvePlan(solveFloor: LadderStage, capacityLimit = capacity): ColumnPlan {
    const automatic = automaticPlan(capacityLimit);
    if (automatic.stage >= solveFloor) return automatic;
    const retainedGap = solveFloor >= 2 ? compressedGap() : baselineGapPx;
    return makeColumnPlan({
      candidates: candidates(),
      ctx: solverContext(null, capacityLimit, retainedGap),
      floorStage: solveFloor,
      requestedLadder: solveFloor,
    });
  }
  const plan = $derived.by(() => solvePlan(floorStage));
  const selection = $derived.by(() => promoteAndExpand(plan, solverContext(plan)));
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
  const displayVariant = (card: CardCandidate): CardVariant => selectedVariant(card.key, renderSelection);
  const rotationActiveKey = $derived(rotationScheduler.currentKey());
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
    return (placement === "center" && floodItem.surface === "clock-top-wide") || renderSelection.floodWide ? "wide" : "card";
  });
  const renderSurplusUse = $derived.by(() => {
    const typhoonWasCompact = [...renderPlan.left, ...renderPlan.right, ...renderPlan.center]
      .find((card) => card.key === "typhoon")?.variant === "compact";
    const floodInSide = !renderPlan.center.some((card) => card.key === "flood");
    return renderSelection.quakeRows + renderSelection.weatherRows
      + Number(typhoonWasCompact && renderSelection.typhoon === "full")
      + Number(floodInSide && renderSelection.floodWide);
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
  });

  function readMeasurements(): void {
    const next: Record<string, number> = {};
    for (const [id, node] of measureNodes) next[id] = testMeasurementOverride?.[id] ?? Math.round(node.getBoundingClientRect().height);
    const nextPrefixes = { ...prefixMeasurements };
    for (const [id, node] of prefixMeasureNodes) {
      const entry = prefixMeasureEntries.find((candidate) => candidate.id === id);
      const genericOverride = entry == null ? undefined : testMeasurementOverride?.[`${entry.key}:prefix:${entry.end}:${entry.placement}`];
      if (entry?.purpose === "page") {
        const body = node.querySelector<HTMLElement>("[data-page-probe-body]");
        const card = node.querySelector<HTMLElement>("[data-page-probe-card]") ?? body;
        // 縦はページ番号・残置行・rider を含むカード全体、横は多段組の地域リストで判定する。
        // column-count の第3列以降は scrollHeight に現れないため、scrollWidth も必須。
        const cardFitsVertically = card == null || card.clientHeight === 0 || card.scrollHeight <= card.clientHeight + 1;
        const bodyFitsVertically = body == null || body.clientHeight === 0 || body.scrollHeight <= body.clientHeight + 1;
        const fitsHorizontally = body == null || body.clientWidth === 0 || body.scrollWidth <= body.clientWidth + 1;
        const fits = cardFitsVertically && bodyFitsVertically && fitsHorizontally;
        nextPrefixes[id] = testMeasurementOverride?.[id] ?? genericOverride ?? (fits ? 0 : 2);
      } else {
        nextPrefixes[id] = testMeasurementOverride?.[id] ?? genericOverride ?? Math.round(node.getBoundingClientRect().height);
      }
    }
    const rect = layoutEl?.getBoundingClientRect();
    const style = layoutEl == null ? null : getComputedStyle(layoutEl);
    measurements = next;
    prefixMeasurements = nextPrefixes;
    layoutWidthPx = testMeasurementOverride?.layoutWidthPx ?? Math.round(rect?.width ?? 0);
    layoutHeightPx = testMeasurementOverride?.layoutHeightPx ?? Math.round(rect?.height ?? 0);
    nankaiHeightPx = testMeasurementOverride?.nankaiHeightPx ?? Math.round(nankaiEl?.getBoundingClientRect().height ?? 0);
    statsHeightPx = testMeasurementOverride?.statsHeightPx ?? Math.round(statsMeasureEl?.getBoundingClientRect().height ?? 0);
    recentHeightPx = testMeasurementOverride?.recentHeightPx ?? Math.round(recentMeasureEl?.getBoundingClientRect().height ?? 0);
    connectionHeightPx = testMeasurementOverride?.connectionHeightPx ?? Math.round(connectionMeasureEl?.getBoundingClientRect().height ?? 0);
    const clockRect = clockFaceEl?.getBoundingClientRect();
    const nankaiRect = nankaiEl?.getBoundingClientRect();
    const standbyRect = standbyEl?.getBoundingClientRect();
    const boundaryTop = testMeasurementOverride?.boundaryTopPx ?? nankaiRect?.top ?? standbyRect?.bottom;
    const clockBottom = testMeasurementOverride?.clockBottomPx ?? clockRect?.bottom;
    const belowItemCount = (snapshot.stats == null ? 0 : 1) + (snapshot.recentQuakes.length === 0 ? 0 : 1);
    const belowContentHeight = (snapshot.stats == null ? 0 : statsHeightPx) + (snapshot.recentQuakes.length === 0 ? 0 : recentHeightPx);
    const freeLowerSpace = clockBottom == null || boundaryTop == null ? 0 : Math.max(0, Math.round(boundaryTop - clockBottom - belowContentHeight));
    clusterGapPx = belowItemCount > 0 && freeLowerSpace > 0 ? Math.floor(freeLowerSpace / (belowItemCount + 1)) : 0;
    clusterFlowHeightPx = belowItemCount > 0 ? belowContentHeight + Math.max(0, belowItemCount - 1) * clusterGapPx : 0;
    gapPx = testMeasurementOverride?.gapPx ?? Math.max(0, Number.parseFloat(style?.rowGap ?? "12") || 12);
    baselineGapPx = testMeasurementOverride?.baselineGapPx
      ?? (Math.max(0, Math.round(baselineGapMeasureEl?.getBoundingClientRect().width ?? 0)) || 12);
    measurementReadCount = measureNodes.size + prefixMeasureNodes.size + 8;
    measurementPass += 1;
  }
  function signature(): string {
    return [stage, capacity, nankaiHeightPx, gapPx, baselineGapPx, plan.rotationKeys.join(","), ...Object.entries(measurements).sort(([a], [b]) => a.localeCompare(b)).map(([id, h]) => `${id}:${h}`), ...Object.entries(prefixMeasurements).sort(([a], [b]) => a.localeCompare(b)).map(([id, h]) => `${id}:${h}`)].join("|");
  }
  async function settleMeasurements(): Promise<void> {
    if (disposed || settling || !fontsReady) return;
    settling = true;
    settleRequested = false;
    measurementSettled = false;
    measurementNonConverged = false;
    const activeEpoch = String(epoch);
    epochKey = activeEpoch;
    coordinator.begin(activeEpoch);
    let previous = "";
    let superseded = false;
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
      let probeSteps = 0;
      // B and the two U4 pageable cards may each consume their bounded probe
      // budget in the same epoch (128 × 2 candidates per card).
      const maxProbeSteps = MAX_PREFIX_ROWS * 4 + 1;
      do {
        await tick();
        if (disposed) break;
        readMeasurements();
        if (contentDemotionRequested) {
          const hysteresisCapacity = Math.max(0, capacity - baselineGapPx * 2 - 0.01);
          const lowerPlan = solvePlan(0, hysteresisCapacity);
          floorStage = lowerPlan.stage < committedStage ? lowerPlan.stage : committedStage;
        }
        coordinator.drainProbes();
        await tick();
        probeSteps += 1;
      } while (!disposed && coordinator.hasPendingProbes() && probeSteps < maxProbeSteps);
      if (disposed) break;
      if (plan.stage > floorStage) floorStage = plan.stage;
      const next = signature();
      if (next === previous && !coordinator.hasPendingProbes()) {
        if (coordinator.settle()) {
          measurementSettled = true;
          contentDemotionRequested = false;
          const nextPlan = snapshotPlan(plan);
          const nextSelection = { ...selection };
          const firstCommit = committedPlan == null;
          flushSync(() => {
            const stageChanged = committedStage !== nextPlan.stage;
            committedPlan = nextPlan;
            committedSelection = nextSelection;
            committedStage = nextPlan.stage;
            if (firstCommit || stageChanged) onStageChange?.(committedStage);
          });
          break;
        }
        if (coordinator.epochKey() !== activeEpoch) { superseded = true; break; }
      }
      previous = next;
    }
    if (!measurementSettled && !disposed && !superseded) measurementNonConverged = true;
    settling = false;
    if (settleRequested && !disposed) {
      settleRequested = false;
      void settleMeasurements();
    }
  }
  function requestSettle(): void {
    epoch += 1;
    epochKey = String(epoch);
    coordinator.begin(epochKey);
    measurementSettled = false;
    prefixMeasurements = {};
    prefixMeasureEntries = [];
    if (settling) {
      settleRequested = true;
      return;
    }
    void settleMeasurements();
  }
  $effect(() => {
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
    <WeatherAlertCard
      alerts={weatherWithSelection(measuring ? (variant === "expanded" ? candidates().find((candidate) => candidate.key === "weather")?.maxRegionRows ?? 0 : 0) : MAX_PREFIX_ROWS)}
      tornado={tornadoItem}
      pageCoordinator={measuring ? undefined : cardPageCoordinator}
      rotationMember={!measuring && renderPlan.rotationKeys.includes("weather")}
      pageScheduling={!measuring}
      partitionProbe={measuring ? undefined : pagePartitionProbe("weather", placement === "center" ? "center" : "side")}
      pagePlacement={placement === "center" ? "center" : "side"}
    />
  {:else if key === "flood" && floodItem != null}
    {#if (placement === "center" && floodItem.surface === "clock-top-wide") || (measuring ? variant === "expanded" : selected.floodWide)}<FloodWideCard item={floodItem} />{:else}<FloodCard item={floodItem} />{/if}
  {:else if key === "typhoon" && typhoonItem != null}<TyphoonCard item={typhoonItem} displayMode={variant === "full" ? "full" : "compact"} />
  {:else if key === "volcano" && volcanoItem != null}<VolcanoCard item={volcanoItem} />
  {:else if key === "heat" && heatItem != null}<HeatAlertCard item={heatItem} />
  {/if}
{/snippet}

{#snippet renderPrefixProbe(entry: PrefixMeasureEntry)}
  {#if entry.key === "quake" && snapshot.latestQuake != null}
    <LatestQuakeCard quake={quakeWithSelection(MAX_PREFIX_ROWS) ?? snapshot.latestQuake} longPeriod={longPeriodItem == null || longPeriodItem.data.eventId !== snapshot.latestQuake.eventId ? null : { ...longPeriodItem.data, restored: longPeriodItem.restored }} pageScheduling={false} measurementRange={entry} pagePlacement={entry.placement} />
  {:else if entry.key === "weather"}
    <WeatherAlertCard alerts={weatherWithSelection(MAX_PREFIX_ROWS)} tornado={tornadoItem} pageScheduling={false} measurementRange={entry} pagePlacement={entry.placement} />
  {/if}
{/snippet}

<div
  bind:this={standbyEl}
  class="standby" class:dim class:ladder-compressed={renderStage >= 2} style={`--nankai-reserve: ${nankaiHeightPx}px; --cluster-gap: ${clusterGapPx}px; --cluster-flow-height: ${clusterFlowHeightPx}px`}
  data-ladder-stage={renderStage}
  data-solver-stage={stage}
  data-layout-unresolved={renderPlan.unresolved ? "true" : "false"}
  data-measurement-settled={measurementSettled ? "true" : "false"}
  data-measurement-nonconverged={measurementNonConverged ? "true" : "false"}
  data-measurement-pass={measurementPass}
  data-measurement-read-count={measurementReadCount}
  data-layout-motion-duration={layoutMotionDuration}
  data-measurement-epoch={epochKey}
  data-suppressed-unknown-count={unknownInputs.length}
  data-left-natural-height-px={naturalColumnHeight(renderPlan.left)}
  data-right-natural-height-px={naturalColumnHeight(renderPlan.right) + (renderPlan.rotationSlotHeight > 0 ? gapPx + renderPlan.rotationSlotHeight : 0) + (renderPlan.rotationFailureCount > 0 ? gapPx + (failureMeasureEl?.getBoundingClientRect().height ?? 0) : 0)}
  data-center-natural-height-px={renderPlan.center.reduce((total, card) => total + card.centerNaturalHeight, fixedCenterContentHeight) + Math.max(0, renderPlan.center.length + fixedCenterItemCount - 1) * gapPx}
  data-left-capacity-px={capacity} data-right-capacity-px={capacity} data-center-capacity-px={capacity}
  data-layout-height-px={layoutHeightPx} data-layout-width-px={layoutWidthPx} data-nankai-height-px={nankaiHeightPx}
  data-rotation-keys={renderPlan.rotationKeys.join(",")} data-rotation-omitted-count={renderPlan.rotationFailureCount}
  data-rotation-active-key={rotationActiveKey ?? undefined}
  data-rotation-tick-override={rotationTickOverride}
  data-rotation-slot-height-px={renderPlan.rotationSlotHeight}
  data-card-page={cardPageCoordinator.cardDiagnostics("quake").page}
  data-card-page-keys={JSON.stringify(cardPageCoordinator.cardDiagnostics("quake").keys)}
  data-card-page-identities={JSON.stringify(cardPageCoordinator.cardDiagnostics("quake").identities)}
  data-card-page-tick-override={cardPageTickOverride}
  data-scheduler-state={JSON.stringify({ rotation: rotationScheduler.diagnostics(), paging: cardPageCoordinator.diagnostics() })}
  data-expanded-counts={expandedCounts}
  data-prefix-probe-count={prefixMeasureEntries.length}
  data-typhoon-variant={renderSelection.typhoon}
  data-flood-form={renderFloodForm}
  data-placement-left={renderPlan.left.map((card) => card.key).join(",")}
  data-placement-right={renderPlan.right.map((card) => card.key).join(",")}
  data-placement-center={renderPlan.center.map((card) => card.key).join(",")}
  data-placement-surplus-use={renderSurplusUse}
  data-outer-paging="none"
>
  <div class="measure-shelf" aria-hidden="true" inert>
    {#each CARD_ORDER as key}
      {#if candidatePresent(key)}
        {#each ["compact", "expanded", "full"] as variant}
          <div class="measure-item" data-measure-variant={variant} use:captureMeasure={measureId(key, variant as CardVariant, "right")}>{@render renderCard(key, variant as CardVariant, "right", true)}</div>
        {/each}
      {/if}
    {/each}
    {#each prefixMeasureEntries.filter((entry) => entry.placement === "side") as entry (entry.id)}
      <div class="measure-item prefix-measure-item" data-prefix-measure={entry.id} data-prefix-rows={entry.end} data-page-probe={entry.purpose === "page" ? "true" : undefined} use:capturePrefixMeasure={entry.id}>{@render renderPrefixProbe(entry)}</div>
    {/each}
  </div>
  <div class="center-measure-shelf" aria-hidden="true" inert>
    {#each CARD_ORDER as key}
      {#if candidatePresent(key)}
        {#each ["compact", "expanded", "full"] as variant}
          <div class="measure-item" data-measure-variant={variant} use:captureMeasure={measureId(key, variant as CardVariant, "center")}>{@render renderCard(key, variant as CardVariant, "center", true)}</div>
        {/each}
      {/if}
    {/each}
    {#each prefixMeasureEntries.filter((entry) => entry.placement === "center") as entry (entry.id)}
      <div class="measure-item prefix-measure-item" data-prefix-measure={entry.id} data-prefix-rows={entry.end} data-page-probe={entry.purpose === "page" ? "true" : undefined} use:capturePrefixMeasure={entry.id}>{@render renderPrefixProbe(entry)}</div>
    {/each}
    {#if snapshot.stats != null}<div class="center-stack-card" bind:this={statsMeasureEl}><InstrumentRow stats={snapshot.stats} /></div>{/if}
    {#if snapshot.recentQuakes.length > 0}<div class="center-stack-card" bind:this={recentMeasureEl}><RecentQuakes quakes={snapshot.recentQuakes} onSelect={selectRecentQuake} /></div>{/if}
  </div>
  <div class="baseline-gap-measure" bind:this={baselineGapMeasureEl} aria-hidden="true"></div>
  <div class="rotation-failure-measure" bind:this={failureMeasureEl} aria-hidden="true">ほか {renderPlan.rotationFailureCount} 件を表示できません</div>

  {#if renderStage === 0}
    <section class="clock-landmark" data-clock-landmark aria-label="画面中央時計と中央クラスタ">
      <div class="clock-wrap">{#if connectionVisible}<div class="clock-connection" bind:this={connectionMeasureEl}><ConnectionBadge connection={snapshot.connection} {sseConnected} /></div>{/if}<div class="clock-face" bind:this={clockFaceEl}><Clock {now} /></div>
        <div class="clock-below">{#if snapshot.stats != null}<div class="instrument-row-wrap"><InstrumentRow stats={snapshot.stats} /></div>{/if}{#if snapshot.recentQuakes.length > 0}<div class="quakes-card"><RecentQuakes quakes={snapshot.recentQuakes} onSelect={selectRecentQuake} /></div>{/if}</div>
      </div>
    </section>
  {/if}
  <section class="legacy-layout" bind:this={layoutEl} aria-label="従来待機画面 改良">
    <div class="side corner-left side-left" data-side="left">
      {#each renderPlan.left as card (card.key)}
        {@const fixedHeight = pageFixedHeight(card, "left")}
        <article class="legacy-card corner-item" class:paged-card={fixedHeight != null} class:tsunami-corner={card.key === "tsunami"} class:quake-corner={card.key === "quake"} style:height={fixedHeight == null ? undefined : `${fixedHeight}px`} data-card-page-fixed-height={fixedHeight ?? undefined}>{@render renderCard(card.key, displayVariant(card), "left", false, renderSelection)}</article>
      {/each}
    </div>
    {#if renderStage === 0}<div class="center-grid-spacer" aria-hidden="true"></div>{:else}
      <section class="center-card-region center-landmark" data-side="center">
        {#if connectionVisible}<div class="connection-stage-card" bind:this={connectionMeasureEl}><ConnectionBadge connection={snapshot.connection} {sseConnected} /></div>{/if}
        {#each renderPlan.center as card (card.key)}
          {@const fixedHeight = pageFixedHeight(card, "center")}
          <article class="legacy-card" class:paged-card={fixedHeight != null} style:height={fixedHeight == null ? undefined : `${fixedHeight}px`} data-card-page-fixed-height={fixedHeight ?? undefined}>{@render renderCard(card.key, displayVariant(card), "center", false, renderSelection)}</article>
        {/each}
        {#if snapshot.stats != null}<div class="center-stack-card instrument-row-wrap"><InstrumentRow stats={snapshot.stats} /></div>{/if}
        {#if snapshot.recentQuakes.length > 0}<div class="center-stack-card quakes-card"><RecentQuakes quakes={snapshot.recentQuakes} onSelect={selectRecentQuake} /></div>{/if}
      </section>
    {/if}
    <div class="side corner-right side-right" data-side="right">
      {#each renderPlan.right as card (card.key)}
        {@const fixedHeight = pageFixedHeight(card, "right")}
        <article class="legacy-card" class:paged-card={fixedHeight != null} class:weather-corner={card.key === "weather"} class:flood-slot={card.key === "flood"} style:height={fixedHeight == null ? undefined : `${fixedHeight}px`} data-card-page-fixed-height={fixedHeight ?? undefined}>{@render renderCard(card.key, displayVariant(card), "right", false, renderSelection)}</article>
      {/each}
      {#if renderStage === 3}
        <div class="rotation-slot" bind:this={rotationSlotEl} style:height={`${renderPlan.rotationSlotHeight}px`}>
          {#each renderPlan.rotationKeys as key (key)}
            <div class="rotation-card" hidden={key !== rotationActiveKey} data-rotation-card={key}>
              {@render renderCard(key, "compact", "right", false, renderSelection)}
            </div>
          {/each}
        </div>
        {#if renderPlan.rotationFailureCount > 0}<div class="rotation-failure">ほか {renderPlan.rotationFailureCount} 件を表示できません</div>{/if}
      {/if}
    </div>
  </section>
  {#if nankaiItem != null}<div class="nankai-ticker bottom-stack" bind:this={nankaiEl}><NankaiBadge item={nankaiItem} /></div>{/if}
</div>

<style>
  .standby { --base-edge: clamp(14px, 2.5vw, 48px); --base-gap: clamp(8px, 1vw, 18px); --compressed-edge: clamp(10px, 1.8vw, 32px); --compressed-gap: clamp(4px, .6vw, 10px); --edge: var(--base-edge); --gap: var(--base-gap); --center-width: min(36rem, 60vw); position: relative; width: 100%; height: 100%; overflow: hidden; color: var(--fg); background: var(--bg); transition: opacity var(--dur-standby-dim) ease; }
  .standby.ladder-compressed { --edge: var(--compressed-edge); --gap: var(--compressed-gap); }
  .measure-shelf, .center-measure-shelf { position: absolute; top: 0; display: flex; flex-direction: column; width: min(30rem, calc((100% - var(--edge) * 2 - var(--gap) * 2 - var(--center-width)) / 2)); visibility: hidden; pointer-events: none; z-index: -1; }
  .measure-shelf { right: 0; } .center-measure-shelf { left: 50%; width: var(--center-width); transform: translateX(-50%); }
  .measure-shelf :global(*), .center-measure-shelf :global(*) { animation: none !important; transition: none !important; }
  .measure-item { width: 100%; flex: 0 0 auto; }
  .baseline-gap-measure { position: absolute; width: var(--base-gap); height: 1px; visibility: hidden; pointer-events: none; }
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
  .clock-landmark { position: fixed; inset: 0; z-index: 2; pointer-events: none; }
  .clock-wrap { position: absolute; top: 50%; left: 50%; width: var(--center-width); container-type: inline-size; text-align: center; transform: translate(-50%, -50%); }
  .clock-connection { position: absolute; right: 0; bottom: calc(100% + var(--gap)); left: 0; }
  .clock-below { position: absolute; top: calc(100% + var(--cluster-gap)); left: 0; display: flex; flex-direction: column; justify-content: space-between; gap: var(--cluster-gap); width: 100%; height: var(--cluster-flow-height); }
  .instrument-row-wrap { display: flex; justify-content: center; } .quakes-card { box-sizing: border-box; padding: var(--space-2) var(--space-3); border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); }
  .nankai-ticker { position: absolute; z-index: 3; right: var(--edge); bottom: 0; left: var(--edge); } .nankai-ticker :global(.nankai-badge) { width: 100%; margin: 0; box-sizing: border-box; justify-content: center; }
  .rotation-slot { display: flex; overflow: hidden; } .rotation-card { width: 100%; } .rotation-card[hidden] { display: none; } .rotation-card > :global(*) { width: 100%; } .rotation-failure { padding: var(--space-2) var(--space-3); border: 1px solid var(--hairline); border-radius: var(--radius-standby); background: var(--surface-standby); color: var(--role-muted); text-align: center; }
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
  @media (prefers-reduced-motion: reduce) { .standby { transition: none; } }
</style>
