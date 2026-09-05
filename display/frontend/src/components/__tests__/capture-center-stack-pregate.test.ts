import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const captureScriptPath = join(__dirname, "../../../../scripts/capture-legacy-standby.mjs");
const capture = await import(/* @vite-ignore */ pathToFileURL(captureScriptPath).href) as unknown as {
  CENTER_STACK_PREGATE_MANIFEST: Array<{ recordKey: string; scenario: string; viewport: string; repetition: number }>;
  deriveCenterStackPregateMetrics(record: unknown): {
    tickerOccupiedRect: Record<string, number>;
    tickerOccupiedTop: number;
    recentTickerOverlapAreaPx: number;
    budget: {
      boundaryTopPx: number;
      lower: { capacityPx: number; requiredPx: number; deficitPx: number; liveOverflowPx: number };
      upper: { capacityPx: number; requiredPx: number; deficitPx: number };
    };
  };
  assertCenterStackPregateReport(report: unknown): { branch: "N" | "R" };
  assertCaptureReport(report: unknown, expectations?: Record<string, unknown>): { branch: "N" | "R" };
};

const scratch = mkdtempSync(join(tmpdir(), "fleq-center-stack-pregate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function box(left: number, top: number, width: number, height: number) {
  return {
    x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
    clientWidth: width, clientHeight: height, scrollWidth: width, scrollHeight: height,
  };
}

function pregateRecord(entry: { recordKey: string; scenario: string; viewport: string; repetition: number }) {
  const [width, height] = entry.viewport.split("x").map(Number) as [number, number];
  const tickerTop = height - 80;
  const clockBottom = tickerTop - 140;
  const recentWidth = Math.min(576, width - 40);
  const recentLeft = (width - recentWidth) / 2;
  const recent = box(recentLeft, clockBottom, recentWidth, 100);
  const draft = {
    schemaVersion: 2,
    recordKey: entry.recordKey,
    repetition: entry.repetition,
    scenario: entry.scenario,
    fixture: null,
    urlIdentity: "/preview.html?nav=0#standby-briefing",
    viewport: { label: entry.viewport, width, height },
    browser: {
      requestedBinary: "chrome", protocolVersion: "1.3", product: "Chrome/140",
      revision: "r1", userAgent: "Chrome", jsVersion: "14",
    },
    capture: { viewportMode: "calibrated", sessionRole: "primary" },
    captureEvidence: {
      stableSampleCount: 2,
      stableSampleHashes: ["stable", "stable"],
      stableSamplesMatch: true,
      preScreenshotHash: "screen",
      postScreenshotHash: "screen",
      screenshotStateMatch: true,
    },
    geometry: {
      viewport: { innerWidth: width, innerHeight: height, clientWidth: width, clientHeight: height, devicePixelRatio: 1 },
      readiness: { kind: "standby", fontsLoaded: true, measurementSettled: true, stableSampleCount: 2 },
      screenArea: box(0, 0, width, tickerTop),
      standby: box(0, 0, width, tickerTop),
      ticker: {
        frame: box(0, tickerTop, width, 80),
        root: box(0, tickerTop, width, 80),
        rows: [box(0, tickerTop, width, 40), box(0, tickerTop + 40, width, 40)],
        rowUnion: box(0, tickerTop, width, 80),
        occupiedTop: tickerTop,
        occupiedRect: box(0, tickerTop, width, 80),
        recentOverlapAreaPx: 0,
      },
      centerStack: {
        clock: box((width - 400) / 2, clockBottom - 120, 400, 120),
        shelf: { recent: { ...recent }, stats: null, connection: null },
        live: { recent: { ...recent }, stats: null, connection: null },
        activeLiveSelector: '.clock-landmark [data-layout-motion-card="recent-quakes:center"]',
        activeLiveCount: 1,
        quakes: {
          shelfIdentities: ["q1", "q2", "q3", "q4", "q5"],
          liveIdentities: ["q1", "q2", "q3", "q4", "q5"],
          shelfCount: 5,
          liveCount: 5,
          orderMatches: true,
        },
        surface: {
          shelf: {
            compressed: false,
            tokens: {
              "--edge": "clamp(14px, 2.5vw, 48px)", "--gap": "clamp(8px, 1vw, 18px)",
              "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "20px",
              "--center-width": "min(36rem, 100vw)",
            },
          },
          live: {
            compressed: false,
            tokens: {
              "--edge": "clamp(14px, 2.5vw, 48px)", "--gap": "clamp(8px, 1vw, 18px)",
              "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "20px",
              "--center-width": "min(36rem, 100vw)",
            },
          },
        },
        centerWidth: {
          shelf: { token: "min(36rem, 100vw)", resolvedPx: recentWidth },
          live: { token: "min(36rem, 100vw)", resolvedPx: recentWidth },
        },
        nankai: null,
        diagnostics: {
          "data-ladder-stage": "0",
          "data-layout-unresolved": "false",
          "data-measurement-settled": "true",
          "data-measurement-nonconverged": "false",
          "data-measurement-epoch": "1",
          "data-measurement-pass": "2",
          "data-geometry-violation-count": "0",
          "data-center-cluster-hidden": "",
          "data-placement-left": "briefing",
          "data-placement-right": "",
          "data-placement-center": "",
          "data-rotation-keys": "",
          "data-rotation-active-key": null,
          "data-rotation-position": null,
        },
        plan: {
          stage: "0",
          placement: { left: "briefing", right: "", center: "" },
          rotation: { keys: "", activeKey: null, position: null },
          hidden: "",
        },
        budget: {
          boundaryTopPx: tickerTop,
          lower: { capacityPx: 140, requiredPx: 100, deficitPx: 0, liveOverflowPx: 0 },
          upper: { capacityPx: clockBottom - 120, requiredPx: 0, deficitPx: 0 },
        },
      },
      fonts: { status: "loaded", signature: [{ family: "Noto Sans JP", style: "normal", weight: "400", stretch: "normal", status: "loaded" }] },
      payload: { hash: "#standby-briefing", search: "?nav=0", previewMode: "standby", tier: "normal", backgroundTone: "calm" },
    },
    expectationPolicy: "fixture-assertions-only",
    mismatches: [],
  };
  const derived = capture.deriveCenterStackPregateMetrics(draft);
  draft.geometry.ticker.occupiedTop = derived.tickerOccupiedTop;
  draft.geometry.ticker.occupiedRect = { ...draft.geometry.ticker.occupiedRect, ...derived.tickerOccupiedRect };
  draft.geometry.ticker.recentOverlapAreaPx = derived.recentTickerOverlapAreaPx;
  draft.geometry.centerStack.budget = derived.budget;
  return draft;
}

function refreshDerived(record: ReturnType<typeof pregateRecord>): void {
  const derived = capture.deriveCenterStackPregateMetrics(record);
  record.geometry.ticker.occupiedTop = derived.tickerOccupiedTop;
  record.geometry.ticker.occupiedRect = { ...record.geometry.ticker.occupiedRect, ...derived.tickerOccupiedRect };
  record.geometry.ticker.recentOverlapAreaPx = derived.recentTickerOverlapAreaPx;
  record.geometry.centerStack.budget = derived.budget;
}

function validReport() {
  return {
    schemaVersion: 2,
    suite: "center-stack-pregate",
    records: capture.CENTER_STACK_PREGATE_MANIFEST.map(pregateRecord),
  };
}

function assertCliStatus(report: ReturnType<typeof validReport>): number | null {
  const filename = join(scratch, `report-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(filename, `${JSON.stringify(report)}\n`);
  return spawnSync(process.execPath, [
    captureScriptPath,
    "--assert-capture-report", filename,
    "--expect-suite", "center-stack-pregate",
  ], { encoding: "utf8" }).status;
}

describe("center-stack pre-gate capture contract", () => {
  it("pins the six fixed records and every §5.1 field at its stable path", () => {
    const report = validReport();
    expect(capture.CENTER_STACK_PREGATE_MANIFEST.map((entry) => [entry.viewport, entry.repetition])).toEqual([
      ["1920x1080", 1], ["1920x1080", 2], ["1280x720", 1],
      ["1280x720", 2], ["960x620", 1], ["960x620", 2],
    ]);
    const record = report.records[0];
    expect(record).toMatchObject({
      captureEvidence: { stableSampleCount: 2, stableSamplesMatch: true, screenshotStateMatch: true },
      geometry: {
        viewport: { innerWidth: 1920, innerHeight: 1080, clientWidth: 1920, clientHeight: 1080, devicePixelRatio: 1 },
        screenArea: { bottom: 1000 }, standby: { bottom: 1000 },
        ticker: { frame: {}, root: {}, rows: [{}, {}], rowUnion: {}, occupiedTop: 1000, recentOverlapAreaPx: 0 },
        centerStack: {
          clock: {}, shelf: { recent: {} }, live: { recent: {} }, activeLiveCount: 1,
          quakes: {
            shelfIdentities: ["q1", "q2", "q3", "q4", "q5"], liveIdentities: ["q1", "q2", "q3", "q4", "q5"],
            shelfCount: 5, liveCount: 5, orderMatches: true,
          },
          surface: { shelf: { compressed: false, tokens: {} }, live: { compressed: false, tokens: {} } },
          centerWidth: { shelf: {}, live: {} },
          plan: {
            stage: "0", placement: { left: "briefing", right: "", center: "" },
            rotation: { keys: "", activeKey: null, position: null }, hidden: "",
          },
          budget: { lower: { capacityPx: 140, requiredPx: 100, deficitPx: 0, liveOverflowPx: 0 }, upper: { capacityPx: 740, requiredPx: 0, deficitPx: 0 } },
        },
        fonts: { status: "loaded", signature: expect.any(Array) }, payload: { hash: "#standby-briefing" },
      },
    });
    expect(capture.assertCaptureReport(report, { expectSuite: "center-stack-pregate", expectViewportMode: "calibrated", expectCells: 6, expectMismatches: 0 }).branch).toBe("N");
    expect(assertCliStatus(report)).toBe(0);
  });

  it("makes --assert-capture-report fail for each §5.1 condition class", () => {
    const cases: Array<(report: ReturnType<typeof validReport>) => void> = [
      (report) => { report.records[0].geometry.viewport.clientWidth -= 2; },
      (report) => { report.records[0].captureEvidence.stableSampleCount = 1; },
      (report) => { report.records[0].geometry.ticker.root.scrollHeight += 2; },
      (report) => { report.records[0].geometry.centerStack.quakes.liveIdentities.pop(); },
      (report) => { Reflect.deleteProperty(report.records[0].geometry.centerStack.budget.lower, "capacityPx"); },
      (report) => { Object.assign(report.records[0].geometry.centerStack, { surface: {} }); },
    ];
    for (const invalidate of cases) {
      const report = validReport();
      invalidate(report);
      expect(() => capture.assertCenterStackPregateReport(report)).toThrow();
      expect(assertCliStatus(report)).not.toBe(0);
    }
  });

  it("rejects a null geometry diagnostic through the CLI", () => {
    const report = validReport();
    Object.assign(report.records[0].geometry.centerStack.diagnostics, { "data-geometry-violation-count": null });
    expect(() => capture.assertCenterStackPregateReport(report)).toThrow(/data-geometry-violation-count missing/);
    expect(assertCliStatus(report)).not.toBe(0);
  });

  it("rejects an empty or non-canonical stage through the CLI", () => {
    for (const stage of ["", "00"]) {
      const report = validReport();
      Object.assign(report.records[0].geometry.centerStack.diagnostics, { "data-ladder-stage": stage });
      Object.assign(report.records[0].geometry.centerStack.plan, { stage });
      expect(() => capture.assertCenterStackPregateReport(report)).toThrow(/data-ladder-stage/);
      expect(assertCliStatus(report)).not.toBe(0);
    }
  });

  it("binds every manifest cell to the standby briefing target", () => {
    const report = validReport();
    for (const record of report.records) record.geometry.payload.hash = "#standby-cards";
    expect(() => capture.assertCenterStackPregateReport(report)).toThrow(/target payload/);
    expect(assertCliStatus(report)).not.toBe(0);
  });

  it("classifies N/R from raw rects and rejects a stored-budget oracle", () => {
    const report = validReport();
    for (const record of report.records.filter((entry) => entry.viewport.label === "1280x720")) {
      const recent = record.geometry.centerStack.live.recent;
      recent.top = 500;
      recent.y = 500;
      recent.height = 150;
      recent.bottom = 650;
      recent.clientHeight = 150;
      recent.scrollHeight = 150;
      record.geometry.centerStack.shelf.recent = { ...recent };
      Object.assign(record.geometry.centerStack.diagnostics, { "data-stage-zero-lower-deficit-px": "0" });
      refreshDerived(record);
    }
    expect(capture.assertCenterStackPregateReport(report).branch).toBe("R");
    expect(report.records.find((entry) => entry.viewport.label === "1280x720")!.geometry.centerStack.budget.lower.deficitPx).toBe(10);
    report.records.find((entry) => entry.viewport.label === "1280x720")!.geometry.centerStack.budget.lower.deficitPx = 0;
    expect(() => capture.assertCenterStackPregateReport(report)).toThrow(/lower deficitPx/);
  });

  it("rejects greater-than-1px drift between the two repetitions", () => {
    const report = validReport();
    const second = report.records.find((entry) => entry.viewport.label === "960x620" && entry.repetition === 2)!;
    second.geometry.centerStack.live.recent.top += 2;
    second.geometry.centerStack.live.recent.bottom += 2;
    refreshDerived(second);
    expect(() => capture.assertCenterStackPregateReport(report)).toThrow(/repetitions/);
  });
});
