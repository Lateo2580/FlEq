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
  placementLeft: string[];
  placementRight: string[];
  placementCenter: string[];
  rotationKeys: string[];
  typhoonVariant: string;
  rotationOmittedCount: number;
  captureTickCount: number;
}

interface NumericComparison {
  base: number | null;
  after: number | null;
  delta: number | null;
}

interface DesignAlignmentComparison {
  manifestKey: string;
  scenario: string;
  viewport: { label: string; width: number; height: number };
  rotationTick: number | null;
  cardPageTick: number | null;
  stages: Record<string, NumericComparison>;
  compressed: { base: boolean | null; after: boolean | null; changed: boolean };
  rotationOmittedCount: NumericComparison;
  placement: { changed: boolean };
  rotation: { changed: boolean };
  typhoonVariant: { changed: boolean };
  visibleCards: { changed: boolean };
  cardHeights: { delta: Record<string, number | null> };
  forecastNaturalHeight: NumericComparison;
}

interface CaptureOptions {
  suite: string | null;
  assertFrom: string | null;
  writeBaseline: string | null;
  baselineReport: string | null;
}

const captureScriptPath = join(__dirname, "../../../../scripts/capture-legacy-standby.mjs");
const captureModuleUrl = pathToFileURL(captureScriptPath).href;
const capture = await import(/* @vite-ignore */ captureModuleUrl) as unknown as {
  DESIGN_ALIGNMENT_MANIFEST: ManifestEntry[];
  DESIGN_ALIGNMENT_COMPRESSED_PLANS: Record<"1280x720" | "960x620", CompressedPlan>;
  DESIGN_ALIGNMENT_MAX_PLAN: MaxPlan;
  DESIGN_ALIGNMENT_PAYLOAD_SIGNATURE: Record<string, unknown>;
  DESIGN_ALIGNMENT_REPORT_EXPRESSION: string;
  parseCaptureArgs(argv: string[]): CaptureOptions;
  normalizeDesignAlignmentUrl(value: string): string;
  assertDesignAlignmentManifestCoverage(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentBaselineStructure(records: Array<Record<string, unknown>>): void;
  assertDesignAlignmentBaselineIdentity(records: Array<Record<string, unknown>>, baseline: Array<Record<string, unknown>>): void;
  assertDesignAlignmentMaxFixture(records: Array<Record<string, unknown>>): void;
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
    page: "1/32", pageKeys: ["page"], pageIdentities: ["identity"], identity: "atom",
    card: box(0, 0, 300, 100), header: box(0, 0, 300, 20), atom: box(0, 20, 300, 60),
    footer: box(0, 80, 300, 20), periods: box(0, 20, 300, 60),
    headerPadding: { top: 0, right: 0, bottom: 0, left: 0 }, periodGap: 0,
    periodKeys: ["p0", "p1", "p2", "p3"], periodCount: 4, atomFooterOverlap: 0, naturalHeight: 100,
  };
}

function baselineBriefing() {
  return { page: "1/1", pageKeys: ["page"], pageIdentities: ["identity"], card: box(0, 0, 300, 100), grids: [] };
}

function baselineStructureRecords() {
  return capture.DESIGN_ALIGNMENT_MANIFEST.map((entry) => {
    const viewport = entry.viewport as "1280x720" | "960x620";
    const [width, height] = viewport.split("x").map(Number);
    const compressedPlan = entry.scenario === "standby-design-alignment-compressed" ? capture.DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport] : null;
    const maxPlan = entry.scenario === "legacy-standby-gate" ? capture.DESIGN_ALIGNMENT_MAX_PLAN : null;
    const plan = compressedPlan ?? maxPlan;
    const rotationKeys = plan?.rotationKeys ?? [];
    const activeIndex = entry.rotationTick == null || rotationKeys.length === 0 ? -1 : entry.rotationTick % rotationKeys.length;
    const activeKey = activeIndex < 0 ? "" : rotationKeys[activeIndex]!;
    const compressed = plan != null;
    const forecastNeeded = entry.scenario === "standby-vpwp50-forecast"
      || (entry.scenario === "standby-design-alignment-compressed" && viewport === "1280x720")
      || (entry.scenario === "standby-design-alignment-compressed" && viewport === "960x620" && entry.rotationTick === compressedPlan?.forecastCaptureTick && entry.cardPageTick === 0);
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
        ready: true, settled: true, rootFontSize: 16, viewport: { width, height },
        layout: {
          ladderStage: compressed ? 3 : 0, measurementGeometryStage: compressed ? 3 : 0, compressed,
          unresolved: "false", nonconverged: "false", placementLeft: [], placementRight: [], placementCenter: [],
          rotationKeys, rotationOmittedCount: 0, rotationActiveKey: activeKey,
          rotationPosition: activeIndex < 0 ? "" : `${activeIndex + 1}/${rotationKeys.length}`,
          typhoonVariant: compressed ? "compact" : "full", cardOverflowKeys: [] as string[], readableOverflowKeys: [] as string[],
          visibleCards: [] as Array<Record<string, unknown>>, sideMeasureShelfWidth: 300,
        },
        briefing: briefingNeeded ? baselineBriefing() : null,
        forecast: forecastNeeded ? baselineForecast() : null,
        typhoon: typhoonNeeded ? baselineTyphoon(entry.scenario, compressed ? "compact" : "full", tone) : null,
      },
    };
  });
}

function comparisonRecord({ scenario, viewport, tick, naturalHeight }: {
  scenario: string;
  viewport: "1280x720" | "960x620";
  tick: number | null;
  naturalHeight: number;
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
      forecast: { naturalHeight },
    },
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
      placementLeft: ["tsunami", "quake", "weatherWarningForecast"],
      placementRight: ["weather"],
      placementCenter: ["flood"],
      rotationKeys: ["typhoon", "volcano", "heat"],
      typhoonVariant: "compact",
      rotationOmittedCount: 0,
      captureTickCount: 6,
    });
    expect(capture.DESIGN_ALIGNMENT_MANIFEST.filter((entry) => entry.scenario === "legacy-standby-gate").map((entry) => entry.rotationTick))
      .toEqual([0, 1, 2, 3, 4, 5]);
    for (const viewport of ["1280x720", "960x620"] as const) {
      const plan = capture.DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
      const cells = capture.DESIGN_ALIGNMENT_MANIFEST.filter((entry) => entry.scenario === "standby-design-alignment-compressed" && entry.viewport === viewport);
      expect(cells.filter((entry) => entry.cardPageTick === 0).map((entry) => entry.rotationTick))
        .toEqual(plan.rotationKeys.map((_, tick) => tick));
      expect(cells.filter((entry) => entry.cardPageTick !== 0).map((entry) => [entry.rotationTick, entry.cardPageTick]))
        .toEqual([[plan.briefingCaptureTick, 1], [plan.briefingCaptureTick, 2]]);
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

  it("uses the true 720px max plan independently from the legacy gate table", () => {
    const plan = capture.DESIGN_ALIGNMENT_MAX_PLAN;
    const records = Array.from({ length: plan.captureTickCount }, (_, rotationTick) => {
      const activeIndex = rotationTick % plan.rotationKeys.length;
      return {
        manifestKey: `max-${rotationTick}`,
        scenario: "legacy-standby-gate",
        viewport: { label: plan.viewport },
        rotationTick,
        geometry: { layout: {
          ladderStage: plan.stage,
          measurementGeometryStage: plan.stage,
          compressed: plan.compressed,
          placementLeft: plan.placementLeft,
          placementRight: plan.placementRight,
          placementCenter: plan.placementCenter,
          rotationKeys: plan.rotationKeys,
          rotationOmittedCount: plan.rotationOmittedCount,
          typhoonVariant: plan.typhoonVariant,
          rotationActiveKey: plan.rotationKeys[activeIndex],
          rotationPosition: `${activeIndex + 1}/${plan.rotationKeys.length}`,
          visibleCards: [{ key: "weatherWarningForecast", surface: "left", component: box(0, 0, 300, 100) }],
          measurementWidths: { weatherWarningForecast: 300 },
        } },
      };
    });
    expect(() => capture.assertDesignAlignmentMaxFixture(records)).not.toThrow();
    const legacyHeightPlan = structuredClone(records);
    legacyHeightPlan[0]!.geometry.layout.rotationKeys = ["weather", "weatherWarningForecast", "flood", "typhoon", "volcano", "heat"];
    expect(() => capture.assertDesignAlignmentMaxFixture(legacyHeightPlan)).toThrow(/max rotation keys/);
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
      suite: "design-alignment", mode: "after", records: [{ id: "after" }], baseline,
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
    const wrongViewport = structuredClone(records);
    wrongViewport[0]!.geometry.viewport.width -= 1;
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
      { scenario: "standby-vpwp50-forecast", viewport: "1280x720", tick: null, baseHeight: 100, afterHeight: 112 },
      { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: 0, baseHeight: 80, afterHeight: 86 },
      { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: 1, baseHeight: 74, afterHeight: 80 },
    ] as const;
    const baseline = targets.map((target) => comparisonRecord({ ...target, naturalHeight: target.baseHeight }));
    const after = targets.map((target) => comparisonRecord({ ...target, naturalHeight: target.afterHeight }));
    const comparisons = capture.buildDesignAlignmentComparison(after, baseline);
    const maxComparison = structuredClone(comparisons[1]!);
    maxComparison.manifestKey = "legacy-standby-gate|1280x720|0|0|gateScenario=max";
    maxComparison.scenario = "legacy-standby-gate";
    comparisons.push(maxComparison);
    expect(() => capture.assertDesignAlignmentComparisonPolicy(comparisons)).not.toThrow();
    expect(comparisons[1]!.placement.changed).toBe(false);
    expect(comparisons[1]!.rotation.changed).toBe(false);
    expect(comparisons[1]!.stages.ladder).toEqual({ base: 3, after: 3, delta: 0 });
    expect(comparisons[1]!.cardHeights.delta.weatherWarningForecast).toBe(6);
    expect(comparisons[1]!.forecastNaturalHeight).toEqual({ base: 80, after: 86, delta: 6 });
    const wrongHeight = structuredClone(comparisons);
    wrongHeight[1]!.forecastNaturalHeight.delta = 4;
    expect(() => capture.assertDesignAlignmentComparisonPolicy(wrongHeight)).toThrow(/natural height delta/);
    const invariantMutations: Array<[string, (comparison: DesignAlignmentComparison) => void]> = [
      ["ladder stage", (comparison) => { comparison.stages.ladder!.after = 4; comparison.stages.ladder!.delta = 1; }],
      ["measurement stage", (comparison) => { comparison.stages.measurementGeometry!.after = 4; comparison.stages.measurementGeometry!.delta = 1; }],
      ["placement", (comparison) => { comparison.placement.changed = true; }],
      ["rotation", (comparison) => { comparison.rotation.changed = true; }],
      ["variant", (comparison) => { comparison.typhoonVariant.changed = true; }],
      ["visible cards", (comparison) => { comparison.visibleCards.changed = true; }],
      ["compressed", (comparison) => { comparison.compressed.after = false; comparison.compressed.changed = true; }],
      ["omitted", (comparison) => { comparison.rotationOmittedCount.after = 1; comparison.rotationOmittedCount.delta = 1; }],
    ];
    for (const target of [1, 2, 3]) {
      for (const [label, mutate] of invariantMutations) {
        const changed = structuredClone(comparisons);
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
