import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActiveStandbyCardV1 } from "../../lib/protocol";
import {
  briefingDesignAlignmentStandbyItems,
  designAlignmentCompressedPayloadSignature,
  designAlignmentCompressedLatestQuake,
  designAlignmentCompressedStandbyItems,
  designAlignmentCompressedWeatherExpandedKinds,
  designAlignmentRiderReserveCounts,
  legacyImprovedExpandedLatestQuake,
  legacyImprovedMaxWeatherAlertsCompact,
  legacyImprovedWeatherWarningForecast,
  vpta50ProbabilityMutedStandbyItems,
  vpta50ProbabilityNormalStandbyItems,
} from "../../preview/fixtures";

interface ManifestEntry {
  scenario: string;
  viewport: string;
  rotationTick: number | null;
  cardPageTick: number | null;
  query: string | null;
  pagerCaptureKeys: PagerKey[];
}

interface CompressedPlan {
  stage: number;
  placementLeft: string[];
  placementRight: string[];
  placementCenter: string[];
  rotationKeys: string[];
  typhoonVariant: string;
  briefingCaptureTick: number;
  forecastCaptureTick: number;
  typhoonCaptureTick: number;
}

interface MaxPlan {
  viewport: string;
  stage: number;
  compressed: boolean;
  captureTickCount: number;
}

interface WeatherAutoProbePlan {
  viewport: string;
  compressed: boolean;
  forcedRange: { start: number; end: number; tails: unknown[]; omittedAreaCount: number };
  page: string;
  pageCount: number;
  pageIdentities: string[];
  activeIdentity: string;
  pageKey: string;
  naturalHeightDelta: number;
}

type PagerKey = "weather" | "tornado" | "weatherWarningForecast" | "briefing" | "flood" | "volcano";
const PAGER_KEYS = ["weather", "tornado", "weatherWarningForecast", "briefing", "flood", "volcano"] as const satisfies readonly PagerKey[];

interface PagerOracle {
  namespace: string;
  key: PagerKey;
  logicalItems: unknown[];
  logicalFingerprints: unknown[];
  resetItems: unknown[];
  sourceCount: number;
  kindKeys: string[] | null;
}

interface NumericComparison {
  base: number | null;
  after: number | null;
  delta: number | null;
}

interface PlacementSnapshot {
  left: string[];
  right: string[];
  center: string[];
}

interface RotationSnapshot {
  keys: string[];
  omittedCount: number | null;
  activeKey: string | null;
  position: string | null;
}

interface DesignAlignmentComparison {
  manifestKey: string;
  scenario: string;
  viewport: { label: string; width: number; height: number };
  rotationTick: number | null;
  cardPageTick: number | null;
  query: string | null;
  stages: Record<string, NumericComparison>;
  compressed: { base: boolean | null; after: boolean | null; changed: boolean };
  rotationOmittedCount: NumericComparison;
  placement: { base: PlacementSnapshot; after: PlacementSnapshot; changed: boolean };
  rotation: { base: RotationSnapshot; after: RotationSnapshot; changed: boolean };
  typhoonVariant: { changed: boolean };
  visibleCards: { changed: boolean };
  cardHeights: { delta: Record<string, number | null> };
  forecastNaturalHeight: NumericComparison;
  forecastGeometry: Record<"header" | "atom" | "periods" | "footer", NumericComparison>;
}

interface CaptureOptions {
  suite: string | null;
  assertFrom: string | null;
  writeBaseline: string | null;
  baselineReport: string | null;
  viewportMode: "legacy-control" | "calibrated";
  viewportModeExplicit: boolean;
}

const captureScriptPath = join(__dirname, "../../../../scripts/capture-legacy-standby.mjs");
const captureModuleUrl = pathToFileURL(captureScriptPath).href;
const capture = await import(/* @vite-ignore */ captureModuleUrl) as unknown as {
  DESIGN_ALIGNMENT_MANIFEST: ManifestEntry[];
  DESIGN_ALIGNMENT_COMPRESSED_PLANS: Record<"1280x720" | "960x620", CompressedPlan>;
  DESIGN_ALIGNMENT_MAX_PLANS: Record<"fhdMax" | "hdMax", MaxPlan>;
  DESIGN_ALIGNMENT_MAX_PLAN: MaxPlan;
  DESIGN_ALIGNMENT_PAYLOAD_SIGNATURE: Record<string, unknown>;
  DESIGN_ALIGNMENT_PAGER_ORACLES: Record<PagerKey, PagerOracle>;
  DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES: Record<"weatherAutoFooterNormal" | "weatherAutoFooterCompressed", WeatherAutoProbePlan>;
  DESIGN_ALIGNMENT_REPORT_EXPRESSION: string;
  parseCaptureArgs(argv: string[]): CaptureOptions;
  normalizeDesignAlignmentUrl(value: string): string;
  assertDesignAlignmentManifestCoverage(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentBaselineStructure(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentBaselineIdentity(records: Array<Record<string, unknown>>, baseline: Array<Record<string, unknown>>): void;
  assertDesignAlignmentMaxFixture(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentPageFooters(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentBriefingFlex(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentWeatherGrid(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentWeatherFixedShell(records: Array<Record<string, unknown>>, baseline: Record<string, unknown>): void;
  assertDesignAlignmentWeatherAutoBaselineProbe(record: Record<string, unknown>, expectation: WeatherAutoProbePlan, label?: string): void;
  assertDesignAlignmentWeatherAutoProbe(record: Record<string, unknown>, expectation: WeatherAutoProbePlan, label?: string): void;
  assertDesignAlignmentWeatherAutoMatrix(records: Array<Record<string, unknown>>, baseline: Record<string, unknown>): void;
  assertDesignAlignmentNaturalHeightDeltaMatrix(records: Array<Record<string, unknown>>, baseline: Record<string, unknown>): void;
  assertDesignAlignmentForecastLabels(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentPagerContracts(records: Array<Record<string, unknown>>, baseline: Record<string, unknown>): void;
  assertForecastContinuationGeometry(geometry: Record<string, unknown>, diagnostics: Record<string, string>): void;
  assertDesignAlignmentCompressedStage(layout: Record<string, unknown>, plan: CompressedPlan, label: string): void;
  assertDesignAlignmentLiveMeasurementWidths(record: Record<string, unknown>): void;
  buildDesignAlignmentComparison(records: Array<Record<string, unknown>>, baseline: Array<Record<string, unknown>>): DesignAlignmentComparison[];
  assertDesignAlignmentComparisonPolicy(comparisons: DesignAlignmentComparison[]): void;
  resolveDesignAlignmentCaptureMode(options: { writeBaseline?: string | null; baselineReport?: string | null }): "baseline" | "after";
  resolveDesignAlignmentExecutionMode(options: CaptureOptions): "capture" | "assert-from";
  createDesignAlignmentRecordsArtifact(options: { mode: "baseline" | "after"; records: Array<Record<string, unknown>>; baseline: Record<string, unknown> | null }): Record<string, unknown>;
  requiresDesignAlignmentWidthMatch(card: { key: string; surface: string }): boolean;
  isDesignAlignmentScreenshotArtifact(name: string): boolean;
  isDesignAlignmentSingleVisualLine(node: Record<string, unknown>, fragments?: Array<Record<string, unknown>>): boolean;
  assertDesignAlignmentManifest(records: Array<Record<string, unknown>>, options: { mode: "baseline" | "after"; baseline?: Record<string, unknown> | null }): DesignAlignmentComparison[] | null;
  assertDesignAlignmentBriefingGrid(grid: Record<string, unknown>, expectation: Record<string, number>, label?: string): void;
  assertDesignAlignmentTyphoonProbability(typhoon: Record<string, unknown>, expectation: Record<string, string | number | null>, label?: string): void;
};

function itemOf<K extends ActiveStandbyCardV1["kind"]>(kind: K): Extract<ActiveStandbyCardV1, { kind: K }> {
  const item = designAlignmentCompressedStandbyItems.find((candidate) => candidate.kind === kind);
  if (item == null) throw new Error(`fixture item missing: ${kind}`);
  return item as Extract<ActiveStandbyCardV1, { kind: K }>;
}

function box(left: number, top: number, width: number, height: number) {
  return {
    rect: { x: left, y: top, left, right: left + width, top, bottom: top + height, width, height },
    clientWidth: width, scrollWidth: width, clientHeight: height, scrollHeight: height,
    overflowX: 0, overflowY: 0, borderTop: 0, borderRight: 0, borderBottom: 0, borderLeft: 0,
  };
}

function textBox(left: number, top: number, width: number, text: string, fontSize = 19, fontVariantNumeric = "tabular-nums") {
  return {
    ...box(left, top, width, 16), text, compactText: text.replace(/\s+/g, ""), lineCount: 1,
    fontSize, fontWeight: "700", fontVariantNumeric,
  };
}

function stat(role: string, left: number, top: number, value: string, numberUnit = false) {
  return {
    role,
    stat: box(left, top, 130.6, 42),
    gap: 4,
    label: role,
    value: textBox(left, top + 18, 100, value),
    numberUnit: numberUnit ? {
      wrapper: textBox(left + 12, top + 18, 52, "100mm"),
      value: textBox(left + 12, top + 18, 30, "100"),
      unit: textBox(left + 42, top + 18, 22, "mm", 12, "normal"),
    } : null,
  };
}

function validGrid() {
  return {
    location: "さいたま市",
    amount: "約100mm",
    approximation: "approx",
    body: box(1, 0, 305.2, 100),
    bodyPadding: { top: 8, right: 16, bottom: 8, left: 16 },
    grid: box(17, 0, 273.2, 88),
    gridTemplateColumns: "130.6px 130.6px",
    rowGap: 4,
    columnGap: 12,
    margin: { top: 4, right: 0, bottom: 0, left: 0 },
    stats: [
      stat("location", 17, 0, "さいたま市"),
      stat("amount", 159.6, 0, "約 100mm", true),
      stat("time", 17, 46, "14:20"),
      stat("duration", 159.6, 46, "1時間"),
    ],
  };
}

function probabilityRole(role: string, label: string, value: number) {
  return {
    role, label, value, unit: "%", legacyNode: textBox(0, 0, 80, `${label}${value}%`),
    probabilityNumber: textBox(0, 0, 36, `${value}%`),
    nuValue: textBox(0, 0, 24, String(value), 19),
    nuUnit: textBox(24, 0, 12, "%", 12, "normal"),
  };
}

function legacyProbabilityRole(role: string, label: string, value: number) {
  return {
    role, label, value, unit: "%", legacyNode: textBox(0, 0, 80, `${label}${value}%`),
    probabilityNumber: null, nuValue: null, nuUnit: null,
  };
}

function baselineTyphoon(scenario: string, mode: "full" | "compact", tone: "muted" | "normal" | null) {
  const prefectureCount = mode === "full" ? 5 : 3;
  const properties = tone === "normal" ? { container: "warning", on: "on-warning", band: "warning-band" } : { container: "", on: "", band: "" };
  return {
    scenario, displayMode: mode, card: box(0, 0, 300, 200), resolvedNumWeight: "700",
    header: {
      node: box(0, 0, 300, 34),
      className: tone === "muted" ? "standby-card-header standby-card-header--muted" : "standby-card-header",
      style: "", customProperties: properties, background: tone === "normal" ? "rgb(1, 2, 3)" : "rgba(0, 0, 0, 0)",
      color: "rgb(120, 120, 120)", bandWidth: tone === "normal" ? 4 : 0, roleMuted: "rgb(120, 120, 120)",
    },
    roles: [
      legacyProbabilityRole("maximum", "maximum", 80),
      ...Array.from({ length: prefectureCount }, (_, index) => legacyProbabilityRole("prefecture", `prefecture-${index}`, 80 - index * 10)),
      legacyProbabilityRole("worst", "worst", 80),
    ],
  };
}

function baselineForecast() {
  return {
    page: "1/32", pageKeys: ["page"], pageIdentities: ["identity"], activeIdentity: "identity", identity: "atom",
    card: box(0, 0, 300, 100), header: box(0, 0, 300, 20), atom: box(0, 20, 300, 60),
    footer: box(0, 80, 300, 20), periods: box(0, 20, 300, 60),
    headerPadding: { top: 0, right: 0, bottom: 0, left: 0 }, periodGap: 0,
    periodKeys: ["p0", "p1", "p2", "p3"], periodCount: 4, atomFooterOverlap: 0, naturalHeight: 100,
    footerCount: 1, continuationVisibleCount: 0,
    visibleTarget: "北海道 稚内市", targetTitle: "稚内市（0121400）",
    atomAccessibleName: "稚内市（0121400）", cardAccessibleName: "稚内市（0121400）",
  };
}

function baselineBriefing() {
  return {
    page: "1/1", pageKeys: ["page"], pageIdentities: ["identity"], activeIdentity: "identity", range: "0:1",
    card: box(0, 0, 300, 100), cardDisplay: "flex", cardFlexDirection: "column",
    pageAtom: { node: box(0, 20, 300, 80), display: "flex", flexGrow: 1, flexShrink: 1, flexBasis: "auto", minHeight: 0 },
    grids: [],
  };
}

function baselineWeatherAuto(scenario: "weatherAutoFooterNormal" | "weatherAutoFooterCompressed") {
  const plan = capture.DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES[scenario];
  const card = box(0, 0, 300, 120);
  return {
    target: scenario, compressed: plan.compressed, forcedRange: plan.forcedRange,
    page: plan.page, pageCount: plan.pageCount, pageIdentities: plan.pageIdentities,
    activeIdentity: plan.activeIdentity, pageKey: plan.pageKey, tornadoCount: 0,
    host: null, shelf: false, painted: true, card,
    gridTemplateRows: "34px 60px 25px 0px", gridTemplateAreas: '"header" "body" "footer" "rider"', gridRowCount: 4,
    explicitHeight: false, pagingContract: false, maxHeight: 280, maxHeightGap: 160, nonClamped: true,
    footerCount: 1, riderCount: 0, childOrder: ["header", "body", "footer"],
    header: { node: box(0, 0, 300, 34), gridArea: "header" },
    body: { node: box(0, 34, 300, 60), gridArea: "body" },
    footer: { node: box(0, 94, 300, 25), gridArea: "footer" }, rider: null,
  };
}

function legacyBaselineWeatherAuto(scenario: "weatherAutoFooterNormal" | "weatherAutoFooterCompressed") {
  const probe = baselineWeatherAuto(scenario);
  const naturalHeight = scenario === "weatherAutoFooterNormal" ? 92.4375 : 73.4375;
  return {
    ...probe,
    activeIdentity: null,
    pageKey: null,
    card: box(0, 0, 358.390625, naturalHeight),
    gridTemplateRows: "none",
    gridTemplateAreas: "none",
    gridRowCount: 1,
    maxHeightGap: 280 - naturalHeight,
    innerOccupiedHeight: scenario === "weatherAutoFooterNormal" ? 36.84375 : 25.84375,
    innerContentHeight: scenario === "weatherAutoFooterNormal" ? 90 : 71,
    childOrder: ["other", "body", "other"],
    header: null,
    body: { node: box(0, 0, 356.390625, scenario === "weatherAutoFooterNormal" ? 36.84375 : 25.84375), gridArea: "auto" },
    footer: null,
  };
}

function baselineStructureRecords() {
  return capture.DESIGN_ALIGNMENT_MANIFEST.map((entry) => {
    const viewport = entry.viewport;
    const compressedViewport = viewport as "1280x720" | "960x620";
    const [width, height] = viewport.split("x").map(Number);
    const compressedPlan = entry.scenario === "standby-design-alignment-compressed" ? capture.DESIGN_ALIGNMENT_COMPRESSED_PLANS[compressedViewport] : null;
    const maxPlan = entry.scenario === "legacy-standby-gate"
      ? capture.DESIGN_ALIGNMENT_MAX_PLANS[entry.viewport === "1920x1080" ? "fhdMax" : "hdMax"]
      : null;
    const plan = compressedPlan ?? maxPlan;
    const rotationKeys = compressedPlan?.rotationKeys ?? [];
    const activeIndex = entry.rotationTick == null || rotationKeys.length === 0 ? -1 : entry.rotationTick % rotationKeys.length;
    const activeKey = activeIndex < 0 ? "" : rotationKeys[activeIndex]!;
    const compressed = entry.scenario === "standby-design-alignment-compressed" || (plan != null && "compressed" in plan && plan.compressed === true);
    const weatherAutoScenario = entry.scenario === "weatherAutoFooterNormal" || entry.scenario === "weatherAutoFooterCompressed"
      ? entry.scenario : null;
    const forecastNeeded = entry.scenario === "standby-vpwp50-forecast"
      || (entry.scenario === "standby-design-alignment-compressed" && viewport === "1280x720")
      || (entry.scenario === "standby-design-alignment-compressed" && viewport === "960x620" && entry.rotationTick === compressedPlan?.forecastCaptureTick);
    const briefingNeeded = entry.scenario === "standby-briefing-design-alignment" || activeKey === "briefing";
    const typhoonNeeded = entry.scenario.startsWith("standby-vpta50-") || activeKey === "typhoon";
    const tone = entry.scenario === "standby-vpta50-probability-normal" ? "normal"
      : entry.scenario === "standby-vpta50-probability-muted" ? "muted" : null;
    return {
      ...entry,
      manifestKey: [entry.scenario, viewport, entry.rotationTick ?? "-", entry.cardPageTick ?? "-", entry.query ?? ""].join("|"),
      viewport: { label: viewport, width, height },
      urlIdentity: `/preview.html?nav=0#${entry.scenario}`,
      geometry: {
        ready: true, settled: true, rootFontSize: 16, viewport: { innerWidth: width, innerHeight: height, devicePixelRatio: 1 },
        tokens: { roleMuted: "rgb(120, 120, 120)" },
        layout: {
          ladderStage: plan?.stage ?? 0, measurementGeometryStage: plan?.stage ?? 0, compressed,
          unresolved: "false", nonconverged: "false", placementLeft: [], placementRight: [], placementCenter: [],
          rotationKeys, rotationOmittedCount: 0, rotationActiveKey: activeKey,
          rotationPosition: activeIndex < 0 ? "" : `${activeIndex + 1}/${rotationKeys.length}`,
          typhoonVariant: compressedPlan?.typhoonVariant ?? "baseline-observed", cardOverflowKeys: [] as string[], readableOverflowKeys: [] as string[],
          visibleCards: [] as Array<Record<string, unknown>>, sideMeasureShelfWidth: 300,
        },
        briefing: briefingNeeded ? baselineBriefing() : null,
        forecast: forecastNeeded ? baselineForecast() : null,
        typhoon: typhoonNeeded ? baselineTyphoon(entry.scenario, compressed ? "compact" : "full", tone) : null,
        weatherAuto: weatherAutoScenario == null ? null : legacyBaselineWeatherAuto(weatherAutoScenario),
        pageFooters: [], naturalHeightProbes: [], pagerContracts: [], weatherCards: [],
      },
    };
  });
}

function comparisonRecord({ scenario, viewport, tick, naturalHeight, headerHeight, atomHeight, periodsHeight, footerHeight }: {
  scenario: string;
  viewport: "1280x720" | "960x620";
  tick: number | null;
  naturalHeight: number;
  headerHeight: number;
  atomHeight: number;
  periodsHeight: number;
  footerHeight: number;
}) {
  const compressed = scenario === "standby-design-alignment-compressed";
  const plan = compressed ? capture.DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport] : null;
  const [width, height] = viewport.split("x").map(Number);
  const active = plan == null || tick == null ? "" : plan.rotationKeys[tick]!;
  const surface = compressed && viewport === "1280x720" ? "left" : "rotation";
  return {
    manifestKey: `${scenario}|${viewport}|${tick ?? "-"}|0|`,
    scenario,
    viewport: { label: viewport, width, height },
    rotationTick: tick,
    cardPageTick: 0,
    query: null,
    urlIdentity: `/preview.html?nav=0${tick == null ? "" : `&rotationTick=${tick}`}#${scenario}`,
    geometry: {
      layout: {
        ladderStage: compressed ? 3 : 0,
        measurementGeometryStage: compressed ? 3 : 0,
        compressed,
        placementLeft: plan?.placementLeft ?? [],
        placementRight: plan?.placementRight ?? [],
        placementCenter: plan?.placementCenter ?? [],
        rotationKeys: plan?.rotationKeys ?? [],
        rotationOmittedCount: 0,
        rotationActiveKey: active,
        rotationPosition: plan == null || tick == null ? "" : `${tick + 1}/${plan.rotationKeys.length}`,
        typhoonVariant: plan?.typhoonVariant ?? "full",
        visibleCards: [{ key: "weatherWarningForecast", surface, host: box(0, 0, 300, naturalHeight), component: box(0, 0, 300, naturalHeight) }],
      },
      forecast: {
        naturalHeight,
        header: box(0, 0, 300, headerHeight), atom: box(0, headerHeight, 300, atomHeight),
        periods: box(0, headerHeight, 300, periodsHeight), footer: box(0, headerHeight + atomHeight, 300, footerHeight),
      },
    },
  };
}

function maxComparisonRecords() {
  const observations = {
    fhdMax: {
      placementLeft: ["tsunami", "quake", "typhoon", "volcano"],
      placementRight: ["weather", "weatherWarningForecast", "flood", "heat"],
      placementCenter: [] as string[], rotationKeys: [] as string[], typhoonVariant: "compact",
    },
    hdMax: {
      placementLeft: ["tsunami", "quake", "weatherWarningForecast"],
      placementRight: ["weather"], placementCenter: ["flood"],
      rotationKeys: ["typhoon", "volcano", "heat"], typhoonVariant: "compact",
    },
  };
  return (["fhdMax", "hdMax"] as const).flatMap((planKey) => {
    const plan = capture.DESIGN_ALIGNMENT_MAX_PLANS[planKey];
    const observation = observations[planKey];
    const [width, height] = plan.viewport.split("x").map(Number);
    return Array.from({ length: plan.captureTickCount }, (_, rotationTick) => {
      const activeIndex = observation.rotationKeys.length === 0 ? -1 : rotationTick % observation.rotationKeys.length;
      const activeKey = activeIndex < 0 ? "" : observation.rotationKeys[activeIndex]!;
      const visibleCards = [
        ...observation.placementLeft.map((key) => ({ key, surface: "left" })),
        ...observation.placementCenter.map((key) => ({ key, surface: "center" })),
        ...observation.placementRight.map((key) => ({ key, surface: "right" })),
        ...(activeKey === "" ? [] : [{ key: activeKey, surface: "rotation" }]),
      ].map((card, index) => ({ ...card, host: box(0, index * 10, 300, 100), component: box(0, index * 10, 300, 100) }));
      const query = `gateScenario=max&maxPlan=${planKey}`;
      return {
        manifestKey: `legacy-standby-gate|${plan.viewport}|${rotationTick}|0|${query}`,
        scenario: "legacy-standby-gate",
        viewport: { label: plan.viewport, width, height },
        rotationTick, cardPageTick: 0, query,
        urlIdentity: `/preview.html?nav=0&${query}#legacy-standby-gate`,
        geometry: { layout: {
          ladderStage: plan.stage, measurementGeometryStage: plan.stage, compressed: plan.compressed,
          placementLeft: observation.placementLeft, placementRight: observation.placementRight,
          placementCenter: observation.placementCenter, rotationKeys: observation.rotationKeys,
          rotationOmittedCount: 0,
          rotationActiveKey: activeKey,
          rotationPosition: activeIndex < 0 ? "" : `${activeIndex + 1}/${observation.rotationKeys.length}`,
          typhoonVariant: observation.typhoonVariant, visibleCards,
          measurementWidths: Object.fromEntries(visibleCards.map((card) => [card.key, 300])),
        } },
      };
    });
  });
}

function autoProbeRecord(scenario: "weatherAutoFooterNormal" | "weatherAutoFooterCompressed", height: number, legacyBaseline = false) {
  const [width, viewportHeight] = capture.DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES[scenario].viewport.split("x").map(Number);
  const weatherAuto = legacyBaseline ? legacyBaselineWeatherAuto(scenario) : baselineWeatherAuto(scenario);
  weatherAuto.card = box(0, 0, 300, height);
  weatherAuto.maxHeightGap = weatherAuto.maxHeight - height;
  const manifestKey = `${scenario}|1280x720|-|0|`;
  return {
    manifestKey, scenario, viewport: { label: "1280x720", width, height: viewportHeight },
    rotationTick: null, cardPageTick: 0, query: null, urlIdentity: `/preview.html?nav=0#${scenario}`,
    geometry: { weatherAuto },
  };
}

function naturalProbe(cardKind: string, height: number, composition: string | null = null) {
  const prefix = cardKind === "briefing" ? "briefing" : cardKind.startsWith("flood") ? "flood" : "volcano";
  return {
    probeId: `${prefix}:page-fit:0:1:placement:side${composition == null ? "" : `:with:${composition}`}`,
    composition, fit: "true", cardKind, range: "0:1", card: box(0, 0, 300, height),
    naturalHeight: height, footerCount: 1, explicitHeight: false, maxHeight: 280,
  };
}

function naturalHeightMatrixRecords(after: boolean) {
  const delta = (value: number) => after ? value : 0;
  return [
    {
      manifestKey: "legacy-standby-gate|1920x1080|0|0|gateScenario=max&maxPlan=fhdMax",
      scenario: "legacy-standby-gate", viewport: { label: "1920x1080" }, rotationTick: 0, cardPageTick: 0,
      geometry: { naturalHeightProbes: [naturalProbe("flood", 100), naturalProbe("volcano", 100 + delta(9))] },
    },
    {
      manifestKey: "standby-design-alignment-compressed|1280x720|0|0|",
      scenario: "standby-design-alignment-compressed", viewport: { label: "1280x720" }, rotationTick: 0, cardPageTick: 0,
      geometry: { naturalHeightProbes: [
        naturalProbe("flood", 90), naturalProbe("volcano", 90 + delta(5)),
        naturalProbe("briefing", 120 + delta(11), "briefing-footer:present:epoch:1"),
      ] },
    },
    {
      manifestKey: "standby-briefing-design-alignment|1280x720|-|0|",
      scenario: "standby-briefing-design-alignment", viewport: { label: "1280x720" }, rotationTick: null, cardPageTick: 0,
      geometry: { naturalHeightProbes: [naturalProbe("briefing", 140 + delta(15), "briefing-footer:present:epoch:1")] },
    },
  ];
}

function pagerContract(key: PagerKey) {
  const oracle = structuredClone(capture.DESIGN_ALIGNMENT_PAGER_ORACLES[key]);
  return {
    captureKey: key, ...oracle,
    missingSchedulerState: false,
    duplicateCount: 0, missingCount: 0, nullCount: 0,
    diagnostics: { page: "1/1", pageCount: 1, pageKeys: ["page"], pageIdentities: ["identity"], activeIdentity: "identity", rangeDerivedPageKey: "identity", resetKey: "reset", pageRange: "0:1" },
  };
}

function allPagerRecord(contracts: ReturnType<typeof pagerContract>[]) {
  return {
    manifestKey: "standby-design-alignment-compressed|1280x720|0|0|",
    scenario: "standby-design-alignment-compressed",
    viewport: { label: "1280x720" },
    rotationTick: 0,
    cardPageTick: 0,
    query: null,
    geometry: { pagerContracts: contracts },
  };
}

function legacyNullPagerContract(captureKey: PagerKey) {
  return {
    captureKey,
    namespace: null, key: null, logicalItems: null, logicalFingerprints: null, resetItems: null,
    sourceCount: null, duplicateCount: 0, nullCount: null, missingCount: null, kindKeys: null,
    diagnostics: {
      page: "1/2", pageCount: 2,
      pageKeys: ["富山県気象防災速報（記録的短時間大雨） lead", "富山県気象防災速報（記録的短時間大雨） fact"],
      pageIdentities: ["card:vpbs:design-alignment:lead:lead:0:0", "card:vpbs:design-alignment:fact:fact:0:precipitation:01543:1:0"],
      activeIdentity: "card:vpbs:design-alignment:lead:lead:0:0",
      rangeDerivedPageKey: "card:vpbs:design-alignment:lead:lead:0:0",
      resetKey: "card:vpbs:design-alignment:lead:lead:0:0,card:vpbs:design-alignment:areaContext:prefecture-context:0,card:vpbs:design-alignment:area:area:160020,160010:0,card:vpbs:design-alignment:meta:meta:0,card:vpbs:design-alignment:fact:fact:0:precipitation:11100:0:0,card:vpbs:design-alignment:fact:fact:0:precipitation:01543:1:0",
      pageRange: "0:5",
    },
  };
}

function weatherGridRecord(viewport: string) {
  return {
    manifestKey: `weather-grid-${viewport}`, viewport: { label: viewport },
    geometry: { weatherCards: [{
      host: "weather:right", shelf: false, painted: true, card: box(0, 0, 300, 180),
      gridTemplateRows: "34px 60px 25px 61px", gridTemplateAreas: '"header" "body" "footer" "rider"', gridRowCount: 4,
      explicitHeight: true, pagingContract: true, maxHeight: 280, maxHeightGap: 100, nonClamped: true,
      innerOccupiedHeight: 180, innerContentHeight: 180,
      footerCount: 1, riderCount: 1, childOrder: ["header", "body", "footer", "rider"],
      header: { node: box(0, 0, 300, 34), gridArea: "header" }, body: { node: box(0, 34, 300, 60), gridArea: "body" },
      footer: { node: box(0, 94, 300, 25), gridArea: "footer" }, rider: { node: box(0, 119, 300, 61), gridArea: "rider" },
    }] },
  };
}

function forecastLabelRecord(scenario: string, viewport: "1280x720" | "960x620", tick: number | null, page: 0 | 16) {
  const local = page === 16;
  return {
    scenario, viewport: { label: viewport }, rotationTick: tick, cardPageTick: page,
    geometry: { forecast: {
      visibleTarget: local ? "北海道 稚内市 稚内海岸" : "北海道 稚内市",
      targetTitle: local ? "稚内市（0121400） / 稚内海岸（L001）" : "稚内市（0121400）",
      atomAccessibleName: local ? "稚内市（0121400） / 稚内海岸（L001）" : "稚内市（0121400）",
      cardAccessibleName: local ? "稚内市（0121400） / 稚内海岸（L001）" : "稚内市（0121400）",
      continuationVisibleCount: 0, footerCount: 1, page: `${page + 1}/32`,
    } },
  };
}

describe("design-alignment capture contract", () => {
  it("pins every page/rotation manifest cell and ignores only URL origin", () => {
    expect(() => new Function(`return ${capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION}`)).not.toThrow();
    const records = capture.DESIGN_ALIGNMENT_MANIFEST.map((entry) => ({ ...entry, viewport: { label: entry.viewport } }));
    expect(() => capture.assertDesignAlignmentManifestCoverage(records)).not.toThrow();
    expect(() => capture.assertDesignAlignmentManifestCoverage(records.slice(1))).toThrow(/manifest keys/);
    expect(capture.DESIGN_ALIGNMENT_COMPRESSED_PLANS).toEqual({
      "1280x720": {
        stage: 3,
        placementLeft: ["tsunami", "quake", "weatherWarningForecast"],
        placementRight: ["briefing"],
        placementCenter: ["weather"],
        rotationKeys: ["flood", "typhoon", "volcano", "heat"],
        typhoonVariant: "compact",
        briefingCaptureTick: 0,
        forecastCaptureTick: 0,
        typhoonCaptureTick: 1,
      },
      "960x620": {
        stage: 3,
        placementLeft: ["tsunami", "quake"],
        placementRight: [],
        placementCenter: [],
        rotationKeys: ["weather", "weatherWarningForecast", "briefing", "flood", "typhoon", "volcano", "heat"],
        typhoonVariant: "compact",
        briefingCaptureTick: 2,
        forecastCaptureTick: 1,
        typhoonCaptureTick: 4,
      },
    });
    expect(capture.DESIGN_ALIGNMENT_MAX_PLAN).toEqual({
      viewport: "1280x720",
      stage: 3,
      compressed: true,
      captureTickCount: 3,
    });
    expect(capture.DESIGN_ALIGNMENT_MAX_PLANS.fhdMax).toEqual({
      viewport: "1920x1080",
      stage: 0,
      compressed: false,
      captureTickCount: 1,
    });
    expect(capture.DESIGN_ALIGNMENT_MANIFEST.filter((entry) => entry.scenario === "legacy-standby-gate").map((entry) => [entry.viewport, entry.rotationTick, entry.query]))
      .toEqual([["1920x1080", 0, "gateScenario=max&maxPlan=fhdMax"], ["1280x720", 0, "gateScenario=max&maxPlan=hdMax"], ["1280x720", 1, "gateScenario=max&maxPlan=hdMax"], ["1280x720", 2, "gateScenario=max&maxPlan=hdMax"]]);
    expect(capture.DESIGN_ALIGNMENT_MANIFEST.filter((entry) => entry.scenario === "standby-vpwp50-forecast").map((entry) => entry.cardPageTick)).toEqual([0, 16]);
    expect(capture.DESIGN_ALIGNMENT_MANIFEST.filter((entry) => Object.hasOwn(capture.DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES, entry.scenario)).map((entry) => entry.scenario))
      .toEqual(["weatherAutoFooterNormal", "weatherAutoFooterCompressed"]);
    expect(capture.DESIGN_ALIGNMENT_MANIFEST.find((entry) => entry.scenario === "standby-briefing-design-alignment")?.pagerCaptureKeys).toEqual(["briefing"]);
    expect(capture.DESIGN_ALIGNMENT_MANIFEST.find((entry) => entry.scenario === "standby-vpwp50-forecast")?.pagerCaptureKeys).toEqual(["weatherWarningForecast"]);
    expect(capture.DESIGN_ALIGNMENT_MANIFEST.find((entry) => entry.scenario === "standby-design-alignment-compressed")?.pagerCaptureKeys).toEqual(PAGER_KEYS);
    for (const viewport of ["1280x720", "960x620"] as const) {
      const plan = capture.DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
      const cells = capture.DESIGN_ALIGNMENT_MANIFEST.filter((entry) => entry.scenario === "standby-design-alignment-compressed" && entry.viewport === viewport);
      expect(cells.filter((entry) => entry.cardPageTick === 0).map((entry) => entry.rotationTick))
        .toEqual(plan.rotationKeys.map((_, tick) => tick));
      expect(cells.filter((entry) => entry.cardPageTick !== 0).map((entry) => [entry.rotationTick, entry.cardPageTick]))
        .toEqual([[plan.briefingCaptureTick, 1], [plan.briefingCaptureTick, 2], [plan.forecastCaptureTick, 16]]);
    }
    expect(capture.normalizeDesignAlignmentUrl("http://127.0.0.1:5101/preview.html?nav=0#standby-cards"))
      .toBe(capture.normalizeDesignAlignmentUrl("http://127.0.0.1:5199/preview.html?nav=0#standby-cards"));
    expect(capture.normalizeDesignAlignmentUrl("http://127.0.0.1:5101/preview.html?nav=1#standby-cards"))
      .not.toBe(capture.normalizeDesignAlignmentUrl("http://127.0.0.1:5199/preview.html?nav=0#standby-cards"));
  });

  it("compares baseline identity without binding the ephemeral origin", () => {
    const after = [{ manifestKey: "a", scenario: "s", rotationTick: 0, cardPageTick: 0, query: null, urlIdentity: "/preview.html?nav=0#s", viewport: { label: "1280x720", width: 1280, height: 720 } }];
    const before = structuredClone(after);
    expect(() => capture.assertDesignAlignmentBaselineIdentity(after, before)).not.toThrow();
    before[0]!.urlIdentity = "/preview.html?nav=1#s";
    expect(() => capture.assertDesignAlignmentBaselineIdentity(after, before)).toThrow(/urlIdentity/);
  });

  it("pins only stage, compressed state, and tick coverage for max plans", () => {
    const records = maxComparisonRecords();
    expect(() => capture.assertDesignAlignmentMaxFixture(records)).not.toThrow();
    const differentBaselinePlacement = structuredClone(records);
    differentBaselinePlacement[0]!.geometry.layout.placementLeft = ["baseline-defined"];
    expect(() => capture.assertDesignAlignmentMaxFixture(differentBaselinePlacement)).not.toThrow();
    const wrongStage = structuredClone(records);
    wrongStage[0]!.geometry.layout.ladderStage = 1;
    expect(() => capture.assertDesignAlignmentMaxFixture(wrongStage)).toThrow(/max stage\/compressed/);
    const missingHdTick = records.filter((record) => !(record.query.includes("maxPlan=hdMax") && record.rotationTick === 2));
    expect(() => capture.assertDesignAlignmentMaxFixture(missingHdTick)).toThrow(/hdMax max rotation tick coverage/);
  });

  it("applies footer geometry gates only to paintable visible cards", () => {
    const records = ["1920x1080", "1280x720", "960x620"].map((viewport) => {
      const liveCard = box(10, 10, 300, 100);
      const liveFooter = {
        cardKind: "volcano", card: liveCard, footer: box(10, 84, 300, 25),
        indicator: box(250, 89, 44, 16), body: box(10, 10, 300, 74), rider: null,
        footerCount: 1, indicatorCount: 1, indicatorText: "1/2", siblingOrder: ["body", "card-page-footer", ""],
        footerIndex: 2, riderIndex: -1, childCount: 3, footerIsLast: true, riderIsLast: false, painted: true,
        probeId: null, range: "0:1", shelf: false,
        position: "static", paddingTop: 4, paddingRight: 16, paddingBottom: 4, paddingLeft: 16,
        borderTop: 1, background: "rgba(0, 0, 0, 0)", indicatorFontSize: 12,
        indicatorColor: "rgb(120, 120, 120)", indicatorLineHeight: 12, indicatorBackground: "rgba(0, 0, 0, 0)",
        bodyFooterOverlap: 0, footerRiderOverlap: 0, indicatorBodyOverlap: 0, indicatorRiderOverlap: 0,
        footerBottomInset: 0, indicatorBottomPaddingDelta: 0,
        riderBottomInset: null, riderRadiusTopLeft: null, riderRadiusTopRight: null,
        riderRadiusBottomLeft: null, riderRadiusBottomRight: null, riderBackground: null,
      };
      const hiddenMeasurementFooter = { ...structuredClone(liveFooter), card: box(900, 900, 300, 280), footerBottomInset: -15 };
      return {
        manifestKey: `footer-${viewport}`, viewport: { label: viewport },
        geometry: {
          layout: { compressed: false, visibleCards: [{ key: "volcano", host: liveCard, component: liveCard }] },
          tokens: { roleMuted: "rgb(120, 120, 120)" },
          pageFooters: [hiddenMeasurementFooter, liveFooter],
        },
      };
    });
    const riderCard = box(400, 10, 300, 180);
    const riderFooter = {
      cardKind: "weather", card: riderCard, footer: box(400, 104, 300, 25),
      indicator: box(640, 109, 44, 16), body: box(400, 44, 300, 60), rider: box(400, 129, 300, 61),
      footerCount: 1, indicatorCount: 1, indicatorText: "1/2", siblingOrder: ["body", "card-page-footer", "tornado-rider"],
      footerIndex: 2, riderIndex: 3, childCount: 4, footerIsLast: false, riderIsLast: true,
      probeId: null, range: "0:1", shelf: false, painted: true,
      position: "static", paddingTop: 4, paddingRight: 16, paddingBottom: 4, paddingLeft: 16,
      borderTop: 1, background: "rgba(0, 0, 0, 0)", indicatorFontSize: 12,
      indicatorColor: "rgb(120, 120, 120)", indicatorLineHeight: 12, indicatorBackground: "rgba(0, 0, 0, 0)",
      bodyFooterOverlap: 0, footerRiderOverlap: 0, indicatorBodyOverlap: 0, indicatorRiderOverlap: 0,
      footerBottomInset: 61, indicatorBottomPaddingDelta: 0, riderBottomInset: 0,
      riderRadiusTopLeft: 0, riderRadiusTopRight: 0, riderRadiusBottomLeft: 15, riderRadiusBottomRight: 15,
      riderBackground: "rgb(20, 20, 20)",
    };
    const riderRecord = {
      manifestKey: "footer-rider-1920x1080", viewport: { label: "1920x1080" },
      geometry: {
        layout: { compressed: false, visibleCards: [{ key: "weather", host: riderCard, component: riderCard }] },
        tokens: { roleMuted: "rgb(120, 120, 120)" }, pageFooters: [riderFooter],
      },
    };
    expect(() => capture.assertDesignAlignmentPageFooters([...records, riderRecord])).not.toThrow();
    const brokenLiveFooter = structuredClone(records);
    brokenLiveFooter[0]!.geometry.pageFooters[1]!.footerBottomInset = -2;
    expect(() => capture.assertDesignAlignmentPageFooters(brokenLiveFooter)).toThrow(/footer card inset/);
    const missingField = structuredClone(records);
    delete (missingField[0]!.geometry.pageFooters[1] as Record<string, unknown>).paddingRight;
    expect(() => capture.assertDesignAlignmentPageFooters(missingField)).toThrow(/paddingRight report missing/);
    const brokenRider = structuredClone(riderRecord);
    brokenRider.geometry.pageFooters[0]!.riderRadiusBottomRight = 0;
    expect(() => capture.assertDesignAlignmentPageFooters([...records, brokenRider])).toThrow(/bottom-right radius/);
  });

  it("pins non-clamped Weather auto-height probes and their +25/+21 deltas", () => {
    const baselineRecords = (["weatherAutoFooterNormal", "weatherAutoFooterCompressed"] as const)
      .map((scenario) => autoProbeRecord(scenario, 100, true));
    const afterRecords = (["weatherAutoFooterNormal", "weatherAutoFooterCompressed"] as const)
      .map((scenario) => autoProbeRecord(scenario, 100 + capture.DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES[scenario].naturalHeightDelta));
    const baseline = { records: baselineRecords };
    expect(() => capture.assertDesignAlignmentWeatherAutoMatrix(afterRecords, baseline)).not.toThrow();
    for (const baselineRecord of baselineRecords) {
      const plan = capture.DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES[baselineRecord.scenario];
      expect(() => capture.assertDesignAlignmentWeatherAutoBaselineProbe(baselineRecord, plan)).not.toThrow();
      expect(() => capture.assertDesignAlignmentWeatherAutoProbe(baselineRecord, plan)).toThrow(/active identity\/page key/);
    }
    const changedBaselineIdentity = structuredClone(baselineRecords);
    changedBaselineIdentity[0]!.geometry.weatherAuto.pageIdentities = ["changed"];
    expect(() => capture.assertDesignAlignmentWeatherAutoMatrix(afterRecords, { records: changedBaselineIdentity })).toThrow(/data-card-page-identities/);
    const missingBaselineGeometry = structuredClone(baselineRecords);
    (missingBaselineGeometry[0]!.geometry.weatherAuto as Record<string, unknown>).card = null;
    expect(() => capture.assertDesignAlignmentWeatherAutoMatrix(afterRecords, { records: missingBaselineGeometry })).toThrow(/card: missing box/);
    const clamped = structuredClone(afterRecords);
    clamped[0]!.geometry.weatherAuto.nonClamped = false;
    expect(() => capture.assertDesignAlignmentWeatherAutoMatrix(clamped, baseline)).toThrow(/clamped/);
    const wrongIdentity = structuredClone(afterRecords);
    wrongIdentity[0]!.geometry.weatherAuto.pageIdentities = ["changed"];
    expect(() => capture.assertDesignAlignmentWeatherAutoMatrix(wrongIdentity, baseline)).toThrow(/data-card-page-identities/);
    const wrongDelta = structuredClone(afterRecords);
    wrongDelta[1]!.geometry.weatherAuto.card.rect.height += 3;
    expect(() => capture.assertDesignAlignmentWeatherAutoMatrix(wrongDelta, baseline)).toThrow(/natural height delta/);
  });

  it("enforces Flood/Volcano/Briefing forced-probe delta matrix", () => {
    const baselineRecords = naturalHeightMatrixRecords(false);
    const afterRecords = naturalHeightMatrixRecords(true);
    expect(() => capture.assertDesignAlignmentNaturalHeightDeltaMatrix(afterRecords, { records: baselineRecords })).not.toThrow();
    const wrongVolcano = structuredClone(afterRecords);
    wrongVolcano[1]!.geometry.naturalHeightProbes[1]!.naturalHeight += 3;
    expect(() => capture.assertDesignAlignmentNaturalHeightDeltaMatrix(wrongVolcano, { records: baselineRecords })).toThrow(/Volcano compressed natural height delta/);
  });

  it("enforces Briefing flex ownership and Weather four-row/rider coverage", () => {
    const briefing = baselineBriefing();
    expect(() => capture.assertDesignAlignmentBriefingFlex([{ manifestKey: "briefing", geometry: { briefing } }])).not.toThrow();
    const brokenBriefing = structuredClone(briefing);
    brokenBriefing.pageAtom.flexGrow = 0;
    expect(() => capture.assertDesignAlignmentBriefingFlex([{ manifestKey: "briefing", geometry: { briefing: brokenBriefing } }])).toThrow(/residual height/);
    const weatherRecords = ["1920x1080", "1280x720", "960x620"].map(weatherGridRecord);
    expect(() => capture.assertDesignAlignmentWeatherGrid(weatherRecords)).not.toThrow();
    const brokenWeather = structuredClone(weatherRecords);
    brokenWeather[2]!.geometry.weatherCards[0]!.gridRowCount = 3;
    expect(() => capture.assertDesignAlignmentWeatherGrid(brokenWeather)).toThrow(/four-row grid/);
  });

  it("keeps each fixed Weather footer+rider shell at the baseline size and inside its content box", () => {
    const baselineRecords = ["1920x1080", "1280x720", "960x620"].map(weatherGridRecord);
    const afterRecords = structuredClone(baselineRecords);
    expect(() => capture.assertDesignAlignmentWeatherFixedShell(afterRecords, { records: baselineRecords })).not.toThrow();
    const changedOuter = structuredClone(afterRecords);
    changedOuter[0]!.geometry.weatherCards[0]!.card.rect.height += 3;
    expect(() => capture.assertDesignAlignmentWeatherFixedShell(changedOuter, { records: baselineRecords })).toThrow(/height delta/);
    const overflowingRows = structuredClone(afterRecords);
    overflowingRows[1]!.geometry.weatherCards[0]!.innerOccupiedHeight += 2;
    expect(() => capture.assertDesignAlignmentWeatherFixedShell(overflowingRows, { records: baselineRecords })).toThrow(/rows exceed/);
  });

  it("keeps VPWP50 area/local visible labels separate from title and ARIA", () => {
    const records = [
      ...([0, 16] as const).map((page) => forecastLabelRecord("standby-vpwp50-forecast", "1280x720", null, page)),
      ...(["1280x720", "960x620"] as const).flatMap((viewport) => ([0, 16] as const).map((page) =>
        forecastLabelRecord("standby-design-alignment-compressed", viewport, capture.DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport].forecastCaptureTick, page))),
    ];
    expect(() => capture.assertDesignAlignmentForecastLabels(records)).not.toThrow();
    const exposedCode = structuredClone(records);
    exposedCode[0]!.geometry.forecast.visibleTarget += " 0121400";
    expect(() => capture.assertDesignAlignmentForecastLabels(exposedCode)).toThrow(/visible\/title\/ARIA|footer\/continuation/);
  });

  it("compares every pager invariant and rejects reordered or missing logical items", () => {
    expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).toContain("schedulerState?.paging?.cards?.[definition.key]");
    expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).not.toContain("schedulerState?.cards?.[definition.key]");
    expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).toContain("captureKey: definition.key");
    expect(capture.DESIGN_ALIGNMENT_REPORT_EXPRESSION).toContain("missingSchedulerState: true");
    const contracts = PAGER_KEYS.map(pagerContract);
    const baselineRecord = allPagerRecord(structuredClone(contracts));
    const afterRecord = allPagerRecord(structuredClone(contracts));
    expect(() => capture.assertDesignAlignmentPagerContracts([afterRecord], { records: [baselineRecord] })).not.toThrow();
    const reordered = structuredClone(afterRecord);
    reordered.geometry.pagerContracts[2]!.logicalItems.reverse();
    reordered.geometry.pagerContracts[2]!.logicalFingerprints.reverse();
    expect(() => capture.assertDesignAlignmentPagerContracts([reordered], { records: [baselineRecord] })).toThrow(/fixture pager oracle/);
    const missingSentinel = structuredClone(afterRecord);
    missingSentinel.geometry.pagerContracts[0]!.logicalItems.pop();
    missingSentinel.geometry.pagerContracts[0]!.logicalFingerprints.pop();
    missingSentinel.geometry.pagerContracts[0]!.missingCount = 1;
    expect(() => capture.assertDesignAlignmentPagerContracts([missingSentinel], { records: [baselineRecord] })).toThrow(/duplicate\/missing/);
    const changedCompleteBaseline = structuredClone(baselineRecord);
    changedCompleteBaseline.geometry.pagerContracts[4]!.resetItems[0] = "changed";
    expect(() => capture.assertDesignAlignmentPagerContracts([afterRecord], { records: [changedCompleteBaseline] })).toThrow(/baseline pager invariant/);
  });

  it("uses fixture oracles with a legacy-null baseline and keeps after fail-closed", () => {
    const contracts = PAGER_KEYS.map(pagerContract);
    const afterRecord = allPagerRecord(contracts);
    const baselineRecord = allPagerRecord(PAGER_KEYS.map(legacyNullPagerContract) as unknown as ReturnType<typeof pagerContract>[]);
    expect(() => capture.assertDesignAlignmentPagerContracts([afterRecord], { records: [baselineRecord] })).not.toThrow();

    const deletedContract = structuredClone(afterRecord);
    deletedContract.geometry.pagerContracts = deletedContract.geometry.pagerContracts.filter((contract) => contract.captureKey !== "weatherWarningForecast");
    expect(() => capture.assertDesignAlignmentPagerContracts([deletedContract], { records: [baselineRecord] })).toThrow(/pager captureKey set/);

    const missingSchedulerState = structuredClone(afterRecord);
    missingSchedulerState.geometry.pagerContracts[2]!.missingSchedulerState = true;
    expect(() => capture.assertDesignAlignmentPagerContracts([missingSchedulerState], { records: [baselineRecord] })).toThrow(/scheduler state missing/);

    const deletedForecast = structuredClone(afterRecord);
    deletedForecast.geometry.pagerContracts[2]!.logicalItems.pop();
    deletedForecast.geometry.pagerContracts[2]!.logicalFingerprints.pop();
    deletedForecast.geometry.pagerContracts[2]!.sourceCount -= 1;
    expect(() => capture.assertDesignAlignmentPagerContracts([deletedForecast], { records: [baselineRecord] })).toThrow(/fixture pager oracle/);

    const reorderedForecast = structuredClone(afterRecord);
    reorderedForecast.geometry.pagerContracts[2]!.logicalItems.reverse();
    reorderedForecast.geometry.pagerContracts[2]!.logicalFingerprints.reverse();
    expect(() => capture.assertDesignAlignmentPagerContracts([reorderedForecast], { records: [baselineRecord] })).toThrow(/fixture pager oracle/);

    const deletedWeatherArea = structuredClone(afterRecord);
    deletedWeatherArea.geometry.pagerContracts[0]!.logicalItems.shift();
    deletedWeatherArea.geometry.pagerContracts[0]!.logicalFingerprints.shift();
    deletedWeatherArea.geometry.pagerContracts[0]!.resetItems.shift();
    deletedWeatherArea.geometry.pagerContracts[0]!.sourceCount -= 1;
    expect(() => capture.assertDesignAlignmentPagerContracts([deletedWeatherArea], { records: [baselineRecord] })).toThrow(/fixture pager oracle/);

    const deletedWeatherSentinel = structuredClone(afterRecord);
    deletedWeatherSentinel.geometry.pagerContracts[0]!.logicalItems.pop();
    deletedWeatherSentinel.geometry.pagerContracts[0]!.logicalFingerprints.pop();
    deletedWeatherSentinel.geometry.pagerContracts[0]!.resetItems.pop();
    deletedWeatherSentinel.geometry.pagerContracts[0]!.sourceCount -= 1;
    expect(() => capture.assertDesignAlignmentPagerContracts([deletedWeatherSentinel], { records: [baselineRecord] })).toThrow(/sentinels|fixture pager oracle/);

    const missingAfterNamespace = structuredClone(afterRecord);
    missingAfterNamespace.geometry.pagerContracts[3]!.namespace = null as unknown as string;
    expect(() => capture.assertDesignAlignmentPagerContracts([missingAfterNamespace], { records: [baselineRecord] })).toThrow(/namespace\/key/);
  });

  it("updates the conventional forecast capture to common footer and zero visible continuation", () => {
    const geometry = { forecastCards: [{
      shelf: false, page: "3/32", card: box(0, 0, 300, 120), header: box(0, 0, 300, 20),
      atom: box(0, 20, 300, 75), footer: box(0, 95, 300, 25), footerCount: 1, footerText: "3/32",
      atomFooterOverlap: 0, periodCount: 4, continuation: "", continuationVisibleCount: 0,
    }] };
    const diagnostics = {
      "data-rotation-active-key": "weatherWarningForecast",
      "data-weather-warning-forecast-page": "3/32",
      "data-weather-warning-forecast-page-mode": "logical",
    };
    expect(() => capture.assertForecastContinuationGeometry(geometry, diagnostics)).not.toThrow();
    const stale = structuredClone(geometry);
    stale.forecastCards[0]!.continuation = "続き 3/32";
    stale.forecastCards[0]!.continuationVisibleCount = 1;
    expect(() => capture.assertForecastContinuationGeometry(stale, diagnostics)).toThrow(/continuation contract/);
  });

  it("fails after mode immediately when a required report field is absent", () => {
    const records = baselineStructureRecords();
    const baseline = { suite: "design-alignment", mode: "baseline", records: structuredClone(records) };
    const after = structuredClone(records);
    delete (after[0]!.geometry as Record<string, unknown>).pageFooters;
    expect(() => capture.assertDesignAlignmentManifest(after, { mode: "after", baseline })).toThrow(/pageFooters report field missing/);
  });

  it("matches forecast widths independently of surface and rejects a greater-than-1px drift", () => {
    expect(capture.requiresDesignAlignmentWidthMatch({ key: "tsunami", surface: "left" })).toBe(false);
    expect(capture.requiresDesignAlignmentWidthMatch({ key: "weatherWarningForecast", surface: "left" })).toBe(true);
    expect(capture.requiresDesignAlignmentWidthMatch({ key: "weather", surface: "center" })).toBe(false);
    expect(capture.requiresDesignAlignmentWidthMatch({ key: "briefing", surface: "left" })).toBe(true);
    expect(capture.requiresDesignAlignmentWidthMatch({ key: "briefing", surface: "right" })).toBe(true);
    expect(capture.requiresDesignAlignmentWidthMatch({ key: "typhoon", surface: "rotation" })).toBe(true);
    const record = {
      manifestKey: "forecast-width",
      geometry: { layout: {
        visibleCards: [{ key: "weatherWarningForecast", surface: "left", component: box(0, 0, 321.296875, 100) }],
        measurementWidths: { weatherWarningForecast: 321.265625 },
      } },
    };
    expect(() => capture.assertDesignAlignmentLiveMeasurementWidths(record)).not.toThrow();
    const drifted = structuredClone(record);
    drifted.geometry.layout.visibleCards[0]!.component.rect.width += 2;
    expect(() => capture.assertDesignAlignmentLiveMeasurementWidths(drifted)).toThrow(/live\/measurement width/);
  });

  it("persists replayable records before assertions and routes assert-from without capture", () => {
    const options = capture.parseCaptureArgs([
      "--suite", "design-alignment", "--assert-from", "after-records.json", "--baseline-report", "baseline.json",
    ]);
    expect(options).toMatchObject({ suite: "design-alignment", assertFrom: "after-records.json", baselineReport: "baseline.json" });
    expect(capture.resolveDesignAlignmentExecutionMode(options)).toBe("assert-from");
    expect(() => capture.resolveDesignAlignmentExecutionMode({ ...options, baselineReport: null })).toThrow(/requires --baseline-report/);
    const baseline = { suite: "design-alignment", mode: "baseline", records: [{ id: "base" }] };
    expect(capture.createDesignAlignmentRecordsArtifact({ mode: "after", records: [{ id: "after" }], baseline })).toEqual({
      schemaVersion: 2, suite: "design-alignment", mode: "after", records: [{ id: "after" }], baseline,
    });
    const source = readFileSync(captureScriptPath, "utf8");
    expect(source.indexOf("if (resolveDesignAlignmentExecutionMode(options) === \"assert-from\")"))
      .toBeLessThan(source.indexOf("const chrome = process.env.CHROME_BIN"));
    expect(source).toMatch(/await writeFile\(recordsArtifactPath,[\s\S]*?const baseAfterComparison = assertDesignAlignmentManifest/);
  });

  it("removes only stale design-alignment PNGs before a capture suite", () => {
    expect(capture.isDesignAlignmentScreenshotArtifact("design-alignment-standby-r2-p1.png")).toBe(true);
    expect(capture.isDesignAlignmentScreenshotArtifact("design-alignment-records.json")).toBe(false);
    expect(capture.isDesignAlignmentScreenshotArtifact("legacy-standby-max.png")).toBe(false);
    const source = readFileSync(captureScriptPath, "utf8");
    expect(source.indexOf("await cleanDesignAlignmentScreenshots(outDir)"))
      .toBeLessThan(source.indexOf("const records = []"));
  });

  it("requires complete, contained baseline reports without applying the after placement plan", () => {
    expect(capture.resolveDesignAlignmentCaptureMode({ writeBaseline: "baseline.json" })).toBe("baseline");
    expect(capture.resolveDesignAlignmentCaptureMode({ baselineReport: "baseline.json" })).toBe("after");
    expect(() => capture.resolveDesignAlignmentCaptureMode({ writeBaseline: "a", baselineReport: "b" })).toThrow(/either/);
    const records = baselineStructureRecords();
    expect(capture.assertDesignAlignmentManifest(records, { mode: "baseline" })).toBeNull();
    const wrongFhdStage = structuredClone(records);
    const fhd = wrongFhdStage.find((record) => record.scenario === "legacy-standby-gate" && record.viewport.label === "1920x1080");
    if (fhd == null) throw new Error("fhd max structural record missing");
    fhd.geometry.layout.ladderStage = 1;
    expect(() => capture.assertDesignAlignmentManifest(wrongFhdStage, { mode: "baseline" })).toThrow(/max stage\/compressed contract/);
    for (const field of ["ladderStage", "measurementGeometryStage"] as const) {
      for (const stage of [2, 4]) {
        const broken = structuredClone(records);
        const compressed = broken.find((record) => record.scenario === "standby-design-alignment-compressed");
        if (compressed == null) throw new Error("compressed structural record missing");
        compressed.geometry.layout[field] = stage;
        expect(() => capture.assertDesignAlignmentManifest(broken, { mode: "baseline" })).toThrow(/stage contract/);
      }
    }
    const notReady = structuredClone(records);
    notReady[0]!.geometry.ready = false;
    expect(() => capture.assertDesignAlignmentManifest(notReady, { mode: "baseline" })).toThrow(/font\/layout not ready/);
    const missingGeometry = structuredClone(records);
    missingGeometry[0]!.geometry = null as never;
    expect(() => capture.assertDesignAlignmentManifest(missingGeometry, { mode: "baseline" })).toThrow(/font\/layout not ready/);
    const wrongViewport = structuredClone(records);
    wrongViewport[0]!.geometry.viewport.innerWidth -= 1;
    expect(() => capture.assertDesignAlignmentManifest(wrongViewport, { mode: "baseline" })).toThrow(/viewport mismatch/);
    const missingField = structuredClone(records);
    missingField[0]!.geometry.layout.visibleCards = null as never;
    expect(() => capture.assertDesignAlignmentManifest(missingField, { mode: "baseline" })).toThrow(/visibleCards.*missing/);
    const overflowing = structuredClone(records);
    overflowing[0]!.geometry.layout.cardOverflowKeys.push("briefing");
    expect(() => capture.assertDesignAlignmentManifest(overflowing, { mode: "baseline" })).toThrow(/generic containment/);
    const missingForecast = structuredClone(records);
    const forecastCell = missingForecast.find((record) => record.scenario === "standby-design-alignment-compressed" && record.viewport.label === "1280x720");
    if (forecastCell == null) throw new Error("forecast baseline record missing");
    forecastCell.geometry.forecast = null;
    expect(() => capture.assertDesignAlignmentManifest(missingForecast, { mode: "baseline" })).toThrow(/side forecast/);
    const missingLegacyTyphoon = structuredClone(records);
    const typhoonCell = missingLegacyTyphoon.find((record) => record.scenario === "standby-vpta50-probability-muted");
    if (typhoonCell?.geometry.typhoon == null) throw new Error("Typhoon baseline record missing");
    typhoonCell.geometry.typhoon.roles[0]!.legacyNode = null as never;
    expect(() => capture.assertDesignAlignmentManifest(missingLegacyTyphoon, { mode: "baseline" })).toThrow(/legacy probability node/);
  });

  it("compares the measured viewport plans and forecast heights at their actual capture ticks", () => {
    const targets = [
      { scenario: "standby-vpwp50-forecast", viewport: "1280x720", tick: null, baseHeight: 100, afterHeight: 109, headerHeight: 20, periodsHeight: 40, baseAtomHeight: 60, afterAtomHeight: 60, baseFooterHeight: 16, afterFooterHeight: 25 },
      { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: 0, baseHeight: 80, afterHeight: 85, headerHeight: 18, periodsHeight: 36, baseAtomHeight: 50, afterAtomHeight: 50, baseFooterHeight: 16, afterFooterHeight: 21 },
      { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: 1, baseHeight: 74, afterHeight: 79, headerHeight: 16, periodsHeight: 32, baseAtomHeight: 45, afterAtomHeight: 45, baseFooterHeight: 16, afterFooterHeight: 21 },
    ] as const;
    const baseline = [
      ...targets.map((target) => comparisonRecord({ ...target, naturalHeight: target.baseHeight, atomHeight: target.baseAtomHeight, footerHeight: target.baseFooterHeight })),
      ...maxComparisonRecords(),
    ];
    const after = [
      ...targets.map((target) => comparisonRecord({ ...target, naturalHeight: target.afterHeight, atomHeight: target.afterAtomHeight, footerHeight: target.afterFooterHeight })),
      ...maxComparisonRecords(),
    ];
    const comparisons = capture.buildDesignAlignmentComparison(after, baseline);
    expect(() => capture.assertDesignAlignmentComparisonPolicy(comparisons)).not.toThrow();
    const fhdComparison = comparisons.find((comparison) => comparison.query?.includes("maxPlan=fhdMax"));
    const hdComparisons = comparisons.filter((comparison) => comparison.query?.includes("maxPlan=hdMax"));
    expect(fhdComparison?.compressed).toEqual({ base: false, after: false, changed: false });
    expect(hdComparisons).toHaveLength(3);
    expect(hdComparisons.every((comparison) => comparison.compressed.base === true && comparison.compressed.after === true)).toBe(true);
    expect(comparisons[1]!.placement.changed).toBe(false);
    expect(comparisons[1]!.rotation.changed).toBe(false);
    expect(comparisons[1]!.stages.ladder).toEqual({ base: 3, after: 3, delta: 0 });
    expect(comparisons[1]!.cardHeights.delta.weatherWarningForecast).toBe(5);
    expect(comparisons[1]!.forecastNaturalHeight).toEqual({ base: 80, after: 85, delta: 5 });
    const wrongHeight = structuredClone(comparisons);
    wrongHeight[1]!.forecastNaturalHeight.delta = 3;
    expect(() => capture.assertDesignAlignmentComparisonPolicy(wrongHeight)).toThrow(/natural height delta/);
    const reassignedMaxAfter = structuredClone(after);
    const reassignedFhd = reassignedMaxAfter.find((record) => record.query?.includes("maxPlan=fhdMax"));
    if (reassignedFhd == null) throw new Error("fhd max comparison record missing");
    const reassignedKey = reassignedFhd.geometry.layout.placementLeft.pop();
    if (reassignedKey == null) throw new Error("fhd max placement member missing");
    reassignedFhd.geometry.layout.placementRight.push(reassignedKey);
    const reassignedVisible = reassignedFhd.geometry.layout.visibleCards.find((card) => card.key === reassignedKey);
    if (reassignedVisible == null) throw new Error("fhd max visible member missing");
    reassignedVisible.surface = "right";
    const reassignedComparisons = capture.buildDesignAlignmentComparison(reassignedMaxAfter, baseline);
    const reassignedFhdComparison = reassignedComparisons.find((comparison) => comparison.query?.includes("maxPlan=fhdMax"));
    expect(reassignedFhdComparison?.placement.changed).toBe(true);
    expect(reassignedFhdComparison?.visibleCards.changed).toBe(true);
    expect(() => capture.assertDesignAlignmentComparisonPolicy(reassignedComparisons)).not.toThrow();
    const changedMaxAfter = structuredClone(after);
    const changedFhd = changedMaxAfter.find((record) => record.query?.includes("maxPlan=fhdMax"));
    if (changedFhd == null) throw new Error("fhd max comparison record missing");
    changedFhd.geometry.layout.placementRight.push("after-only");
    const changedMaxComparisons = capture.buildDesignAlignmentComparison(changedMaxAfter, baseline);
    expect(() => capture.assertDesignAlignmentComparisonPolicy(changedMaxComparisons)).toThrow(/visible placement set/);
    const invariantMutations: Array<[string, (comparison: DesignAlignmentComparison) => void, boolean]> = [
      ["ladder stage", (comparison) => { comparison.stages.ladder!.after = 4; comparison.stages.ladder!.delta = 1; }, true],
      ["measurement stage", (comparison) => { comparison.stages.measurementGeometry!.after = 4; comparison.stages.measurementGeometry!.delta = 1; }, true],
      ["placement", (comparison) => { comparison.placement.changed = true; }, false],
      ["rotation", (comparison) => { comparison.rotation.changed = true; }, true],
      ["variant", (comparison) => { comparison.typhoonVariant.changed = true; }, true],
      ["visible cards", (comparison) => { comparison.visibleCards.changed = true; }, false],
      ["compressed", (comparison) => { comparison.compressed.after = !comparison.compressed.after; comparison.compressed.changed = true; }, true],
      ["omitted", (comparison) => { comparison.rotationOmittedCount.after = 1; comparison.rotationOmittedCount.delta = 1; }, true],
    ];
    const invariantTargets = comparisons
      .map((comparison, index) => ({ comparison, index }))
      .filter(({ comparison }) => comparison.scenario === "standby-design-alignment-compressed" || comparison.scenario === "legacy-standby-gate")
      .map(({ index }) => index);
    for (const target of invariantTargets) {
      for (const [label, mutate, appliesToFhd] of invariantMutations) {
        const changed = structuredClone(comparisons);
        if (!appliesToFhd && changed[target]!.query?.includes("maxPlan=fhdMax")) continue;
        mutate(changed[target]!);
        expect(() => capture.assertDesignAlignmentComparisonPolicy(changed), `${changed[target]!.scenario}/${label}`).toThrow(/base\/after/);
      }
    }
  });

  it("rejects a 3+1 grid and a missing NumberUnit fragment", () => {
    const expectation = { padding: 16, rowGap: 4, columnGap: 12, statWidth: 130.6, statGap: 4 };
    const grid = validGrid();
    expect(() => capture.assertDesignAlignmentBriefingGrid(grid, expectation)).not.toThrow();
    const mixedTypography = structuredClone(grid);
    const mixedAmount = mixedTypography.stats[1]!;
    if (mixedAmount.numberUnit == null) throw new Error("amount NumberUnit fixture missing");
    mixedAmount.value.lineCount = 2;
    mixedAmount.numberUnit.wrapper.lineCount = 2;
    expect(() => capture.assertDesignAlignmentBriefingGrid(mixedTypography, expectation)).not.toThrow();
    mixedAmount.value.rect.height = 40;
    expect(() => capture.assertDesignAlignmentBriefingGrid(mixedTypography, expectation)).toThrow(/location\/amount wrapped/);
    const brokenRow = structuredClone(grid);
    brokenRow.stats[2]!.stat.rect.top = 0;
    expect(() => capture.assertDesignAlignmentBriefingGrid(brokenRow, expectation)).toThrow(/second row|2x2/);
    const brokenUnit = structuredClone(grid);
    brokenUnit.stats[1]!.numberUnit!.unit = null as never;
    expect(() => capture.assertDesignAlignmentBriefingGrid(brokenUnit, expectation)).toThrow(/NumberUnit unit/);
  });

  it("requires the full probability role hierarchy and resolved numeric weight", () => {
    const typhoon = {
      displayMode: "full",
      card: box(0, 0, 300, 200),
      resolvedNumWeight: "700",
      header: {
        node: box(0, 0, 300, 34), className: "standby-card-header standby-card-header--muted", style: "",
        customProperties: { container: "", on: "", band: "" },
        background: "rgba(0, 0, 0, 0)", color: "rgb(120, 120, 120)", bandWidth: 0, roleMuted: "rgb(120, 120, 120)",
      },
      roles: [
        probabilityRole("maximum", "maximum", 80),
        ...["東京都", "神奈川県", "千葉県", "埼玉県", "茨城県"].map((label, index) => probabilityRole("prefecture", label, 80 - index * 10)),
        probabilityRole("worst", "東京地方", 80),
      ],
    };
    const expectation = { mode: "full", valueFontSize: 19, prefectureCount: 5, header: "muted" };
    expect(() => capture.assertDesignAlignmentTyphoonProbability(typhoon, expectation)).not.toThrow();
    const mixedTypography = structuredClone(typhoon);
    for (const role of mixedTypography.roles) role.probabilityNumber.lineCount = 2;
    expect(() => capture.assertDesignAlignmentTyphoonProbability(mixedTypography, expectation)).not.toThrow();
    const broken = structuredClone(typhoon);
    broken.roles[0]!.nuValue.fontWeight = "400";
    expect(() => capture.assertDesignAlignmentTyphoonProbability(broken, expectation)).toThrow(/num-weight/);
  });

  it("keeps the compressed fixture payload, candidates, riders, and VPTW-only header input exact", () => {
    const previewSource = readFileSync(join(__dirname, "../../preview/PreviewApp.svelte"), "utf8");
    expect(previewSource).toMatch(/const designAlignmentCompressedSnapshot = standbySnapshot\(\{[\s\S]*?tsunami: tsunamiBanner,[\s\S]*?latestQuake: designAlignmentCompressedLatestQuake,[\s\S]*?weatherAlerts: legacyImprovedMaxWeatherAlertsCompact,[\s\S]*?weatherExpandedKinds: designAlignmentCompressedWeatherExpandedKinds,[\s\S]*?standbyItems: designAlignmentCompressedStandbyItems,/);
    expect(designAlignmentCompressedPayloadSignature).toEqual(capture.DESIGN_ALIGNMENT_PAYLOAD_SIGNATURE);
    const candidateKinds = ["flood", "volcano", "typhoon", "heat", "briefing", "weatherWarningForecast"] as const;
    for (const kind of candidateKinds) expect(designAlignmentCompressedStandbyItems.filter((item) => item.kind === kind)).toHaveLength(1);
    expect(Object.fromEntries(["tornado", "longPeriod", "nankaiTrough"].map((kind) => [kind, designAlignmentCompressedStandbyItems.filter((item) => item.kind === kind).length])))
      .toEqual(designAlignmentRiderReserveCounts);

    const forecastPeriods = legacyImprovedWeatherWarningForecast.data.groups.flatMap((group) => group.targets.flatMap((target) => target.periods));
    expect(forecastPeriods).toHaveLength(128);
    expect(legacyImprovedWeatherWarningForecast.data.groups.flatMap((group) => group.targets).reduce((count, target) => count + Math.ceil(target.periods.length / 4), 0)).toBe(32);
    const briefing = briefingDesignAlignmentStandbyItems[0]!;
    if (briefing.kind !== "briefing") throw new Error("briefing fixture kind mismatch");
    const facts = briefing.data.entries[0]!.summary?.items.flatMap((summary) => summary.facts ?? []).filter((fact) => fact.kind === "precipitation") ?? [];
    expect(facts.map((fact) => [fact.locationName, fact.approximation, fact.value, fact.unit])).toEqual([
      ["さいたま市", "approx", 100, "mm"], ["美幌町", "atLeast", 120, "mm"],
    ]);
    expect(itemOf("flood").data.rivers).toHaveLength(3);
    expect(itemOf("volcano").data.volcanoes).toHaveLength(5);
    expect(itemOf("heat").data.areas).toHaveLength(30);
    const maxTyphoons = itemOf("typhoon").data.typhoons;
    expect(maxTyphoons).toHaveLength(2);
    expect(maxTyphoons[0]!.probability?.activePrefectureCount).toBe(8);
    expect(legacyImprovedMaxWeatherAlertsCompact[0]!.items[0]!.shownAreas).toHaveLength(3);
    expect(legacyImprovedMaxWeatherAlertsCompact[0]!.items[0]!.omittedAreaCount).toBe(21);
    expect(designAlignmentCompressedWeatherExpandedKinds[0]!.areas).toHaveLength(24);
    expect(designAlignmentCompressedLatestQuake.intensityGroups.map((group) => group.expandedAreas))
      .toEqual(legacyImprovedExpandedLatestQuake.intensityGroups.map((group) => group.areas));
    const normalProbability = vpta50ProbabilityNormalStandbyItems[0]!;
    const mutedProbability = vpta50ProbabilityMutedStandbyItems[0]!;
    if (normalProbability.kind !== "typhoon" || mutedProbability.kind !== "typhoon") throw new Error("VPTA fixture kind mismatch");
    expect(normalProbability.data.typhoons[0]!.intensityClass).toBe("非常に強い");
    expect(normalProbability.data.typhoons[0]!.probability).toEqual(mutedProbability.data.typhoons[0]!.probability);
  });
});
