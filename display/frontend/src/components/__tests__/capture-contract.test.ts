import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type ViewportMode = "legacy-control" | "calibrated";
interface CaptureDocumentState {
  fontsLoaded: boolean;
  standbyPresent: boolean;
  previewPresent: boolean;
  measurementSettled: boolean;
  previewMode: string | null;
  attentionVisible: boolean;
  emergencyPanelCount: number;
  emergencyGeometryValid: boolean;
  viewport: { innerWidth: number; innerHeight: number; devicePixelRatio: number };
  dom: string;
  stableDom: string;
  domSha256?: string;
}
interface CdpCall { method: string; params: Record<string, unknown>; sessionId?: string }
interface SessionSnapshot { document: CaptureDocumentState; [key: string]: unknown }
interface ProtocolResult {
  version: Record<string, string>;
  stable: SessionSnapshot[];
  preScreenshot: SessionSnapshot;
  postScreenshot: SessionSnapshot;
  screenshotData: string;
}

const scriptsDir = join(__dirname, "../../../../scripts");
const captureScriptPath = join(scriptsDir, "capture-legacy-standby.mjs");
const helperScriptPath = join(scriptsDir, "capture-browser-session.mjs");
const capture = await import(/* @vite-ignore */ pathToFileURL(captureScriptPath).href) as unknown as {
  parseCaptureArgs(argv: string[]): Record<string, unknown> & { viewportMode: ViewportMode; viewportModeExplicit: boolean; suite: string | null };
  viewportModeForSuite(options: Record<string, unknown>): ViewportMode;
  captureExpectationPolicy(fixture: string | null, scenario: string, viewport: string): string;
  tableMismatches(diagnostics: Record<string, string>, scenario: string, viewport: { label: string }, fixture: string | null): unknown[];
  assertCaptureRecordSchemaV2(record: Record<string, unknown>): void;
  assertCaptureReport(report: Record<string, unknown>, expectations?: Record<string, unknown>): unknown;
  assertDesignAlignmentSavedRecords(saved: Record<string, unknown>, baseline: Record<string, unknown>): unknown;
  standardReportExitCode(records: Array<{ expectationPolicy: string; mismatches: unknown[] }>): number;
  createStandardReportResult(options: { results: Array<Record<string, unknown>>; reportMode: boolean; outDir: string }): { report: Record<string, unknown>; exitCode: number };
  createAttentionComparatorRecord(options: Record<string, unknown>): Record<string, unknown>;
  captureStableProjection(snapshot: Record<string, unknown>): Record<string, unknown>;
  atomicSnapshotExpression(expressions: Record<string, string>): string;
  collectNormalSnapshot(options: { evaluate(expression: string): Promise<Record<string, unknown>> }): Promise<Record<string, unknown>>;
  collectDesignSnapshot(options: { evaluate(expression: string): Promise<Record<string, unknown>> }): Promise<Record<string, unknown>>;
  runDesignCaptureSession(options: Record<string, unknown>): Promise<unknown>;
  legacyExpectationDigest(): string;
  verifyLegacyExpectationDigest(expected: string): string;
  assertWeatherKindAreaRecord(record: Record<string, unknown>): Record<string, unknown>;
  assertForcedMeasurementPageOrdinals(cards: Array<Record<string, unknown>>, ranges: string[], rangeField?: string, indexField?: string, countField?: string, label?: string): boolean;
  assertWeatherKindAreaReport(report: Record<string, unknown>): Record<string, unknown>;
  assertWeatherKindAreaComparison(base: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown>;
  assertWeatherAfterLogicalOracle(rows: Array<Record<string, unknown>>, oracle: Record<string, unknown>): boolean;
  weatherLogicalRowsForPhase(values: string[], fixture: string, phase: string): Array<Record<string, unknown>>;
  weatherVisibleRotationTicks(stage: string, keys: string[]): number[];
  assertWeatherStageTickCoverage(cells: Array<Record<string, unknown>>, viewport: string): { stage: string; ticks: number[] };
  assertWeatherMatrixPressure(cells: Array<Record<string, unknown>>, fixture: string): number;
};
const helper = await import(/* @vite-ignore */ pathToFileURL(helperScriptPath).href) as unknown as {
  CAPTURE_TIMEOUT_MS: number;
  CAPTURE_PROCESS_STRATEGY: string;
  SCREENSHOT_PARAMS: Record<string, unknown>;
  DOCUMENT_CAPTURE_EXPRESSION: string;
  canonicalJsonStringify(value: unknown): string;
  browserMetadata(requestedBinary: string, version: Record<string, string>): Record<string, string>;
  captureRouteProfile(options: { requestedViewport: { width: number; height: number }; virtualTimeBudgetMs: 10_000 | null }): Record<string, unknown>;
  buildChromeLaunchArgs(options: { profileDir: string; url: string; requestedViewport: { width: number; height: number }; virtualTimeBudgetMs: 10_000 | null }): string[];
  virtualTimePolicyFor(value: 10_000 | null): Record<string, unknown> | null;
  attachCaptureTarget(options: Record<string, unknown>): Promise<{ sessionId: string; deviceMetricsOverride: Record<string, unknown> | null }>;
  createCdpPipe(child: FakeChild): {
    command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    waitForEvent(method: string, sessionId?: string): Promise<Record<string, unknown>>;
    close(error?: Error): void;
  };
  executeCaptureProtocol(options: Record<string, unknown>): Promise<ProtocolResult>;
  runCaptureBrowserSession(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  terminateChild(child: FakeChild, options?: { graceMs?: number; killWaitMs?: number }): Promise<string>;
  formatCdpTraceMessage(direction: string, message: Record<string, unknown>): string;
  deviceMetricsOverrideFor(mode: ViewportMode, viewport: { width: number; height: number }): Record<string, unknown> | null;
  readinessFor(state: CaptureDocumentState, kind: "standby" | "emergency"): Record<string, unknown>;
  isReadinessSatisfied(state: CaptureDocumentState, kind: "standby" | "emergency"): boolean;
  assertViewportContract(mode: ViewportMode, requested: { width: number; height: number }, measured: { innerWidth: number; innerHeight: number; devicePixelRatio: number }): void;
};

const rawVersion = { protocolVersion: "1.3", product: "Chrome/140", revision: "r1", userAgent: "Chrome", jsVersion: "14" };
const browser = { requestedBinary: "chrome", ...rawVersion };
const viewport = { label: "1280x720", width: 1280, height: 720 };
const dom = '<!DOCTYPE html>\n<html><body><main data-preview-mode="standby"><div data-measurement-settled="true"></div></main></body></html>';
const standbyDocument: CaptureDocumentState = {
  fontsLoaded: true, standbyPresent: true, previewPresent: true, measurementSettled: true,
  previewMode: "standby", attentionVisible: false, emergencyPanelCount: 0, emergencyGeometryValid: false,
  viewport: { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 }, dom, stableDom: dom,
};
const stableSnapshot: SessionSnapshot = {
  document: standbyDocument,
  diagnostics: { "data-measurement-settled": "true" },
  liveGeometry: { signatures: { fonts: [], payload: {}, candidates: [], capacity: {} } },
};

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdio: Array<PassThrough | null> = [null, null, null, new PassThrough(), new PassThrough()];
  killSignals: string[] = [];
  unrefCalled = false;

  constructor(private readonly exitOnSignal: string | null = "SIGTERM") { super(); }

  kill(signal: string) {
    this.killSignals.push(signal);
    if (signal === this.exitOnSignal) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
      });
    }
    return true;
  }

  unref() { this.unrefCalled = true; }
}

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    browser,
    viewport,
    geometry: { viewport: standbyDocument.viewport, readiness: helper.readinessFor(standbyDocument, "standby") },
    capture: { viewportMode: "legacy-control", sessionRole: "primary" },
    scenario: "quiet", fixture: null, rotationTick: 0, expectationPolicy: "normal-table", mismatches: [],
    ...overrides,
  };
}

function designRecord(overrides: Record<string, unknown> = {}) {
  return validRecord({ capture: { viewportMode: "calibrated", sessionRole: "primary" }, expectationPolicy: "fixture-assertions-only", ...overrides });
}

describe("capture contract schema v2", () => {
  it("pins schema fields and all Browser.getVersion metadata", () => {
    expect(() => capture.assertCaptureRecordSchemaV2(validRecord())).not.toThrow();
    const misplaced = validRecord({ viewport: standbyDocument.viewport, geometry: { readiness: helper.readinessFor(standbyDocument, "standby") } });
    expect(() => capture.assertCaptureRecordSchemaV2(misplaced)).toThrow(/requested viewport|measured viewport/);
    for (const field of ["protocolVersion", "product", "revision", "userAgent", "jsVersion"] as const) {
      const version: Record<string, string> = { ...browser };
      delete version[field];
      expect(() => helper.browserMetadata("chrome", version)).toThrow(new RegExp(field));
    }
    expect(helper.browserMetadata("chrome", rawVersion)).toEqual(browser);
    expect(() => capture.assertCaptureRecordSchemaV2(validRecord({ browser: { ...browser, requestedBinary: "" } }))).toThrow(/requestedBinary/);
  });

  it("asserts calibrated geometry and DPR while preserving legacy height observation", () => {
    expect(helper.deviceMetricsOverrideFor("legacy-control", viewport)).toBeNull();
    expect(helper.deviceMetricsOverrideFor("calibrated", viewport)).toEqual({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    expect(() => helper.assertViewportContract("calibrated", viewport, standbyDocument.viewport)).not.toThrow();
    expect(() => helper.assertViewportContract("calibrated", viewport, { ...standbyDocument.viewport, innerHeight: 577 })).toThrow(/calibrated viewport mismatch/);
    expect(() => helper.assertViewportContract("legacy-control", viewport, { ...standbyDocument.viewport, innerHeight: 577 })).not.toThrow();
    expect(() => helper.assertViewportContract("legacy-control", viewport, { ...standbyDocument.viewport, devicePixelRatio: 2 })).toThrow(/devicePixelRatio/);
  });

  it("separates standby and emergency readiness predicates", () => {
    expect(helper.isReadinessSatisfied(standbyDocument, "standby")).toBe(true);
    expect(helper.isReadinessSatisfied({ ...standbyDocument, measurementSettled: false }, "standby")).toBe(false);
    const emergency = {
      ...standbyDocument, standbyPresent: false, measurementSettled: false, previewMode: "emergency",
      attentionVisible: true, emergencyPanelCount: 2, emergencyGeometryValid: true,
    };
    expect(helper.isReadinessSatisfied(emergency, "emergency")).toBe(true);
    expect(helper.readinessFor(emergency, "emergency")).toMatchObject({ kind: "emergency", measurementSettled: null, stableSampleCount: 2 });
    expect(helper.isReadinessSatisfied({ ...emergency, emergencyGeometryValid: false }, "emergency")).toBe(false);
  });

  it("records attention comparator role and primary key", () => {
    const session = { browser, capture: { viewportMode: "legacy-control", sessionRole: "comparator" } };
    const comparator = capture.createAttentionComparatorRecord({
      primaryRecordKey: "legacy-standby-max-1280x720", primaryBrowser: browser, requestedViewport: viewport,
      viewportMode: "legacy-control", session, snapshot: { document: standbyDocument, liveGeometry: {} }, urlIdentity: "/preview.html?nav=0#standby-cards",
    });
    expect(comparator).toMatchObject({ primaryRecordKey: "legacy-standby-max-1280x720", capture: { sessionRole: "comparator" } });
    expect(() => capture.createAttentionComparatorRecord({
      primaryRecordKey: "x", primaryBrowser: browser, requestedViewport: viewport, viewportMode: "legacy-control",
      session: { ...session, capture: { viewportMode: "legacy-control", sessionRole: "primary" } }, snapshot: { document: standbyDocument, liveGeometry: {} }, urlIdentity: "/",
    })).toThrow(/sessionRole/);
  });
});

describe("capture browser route", () => {
  it("attaches to blank, pauses virtual time, navigates, then advances the legacy budget", async () => {
    expect(helper.captureRouteProfile({ requestedViewport: viewport, virtualTimeBudgetMs: 10_000 })).toMatchObject({ virtualTimeBudgetMs: 10_000, requestedWindowSize: { width: 1280, height: 720 } });
    expect(helper.captureRouteProfile({ requestedViewport: viewport, virtualTimeBudgetMs: null })).toMatchObject({ virtualTimeBudgetMs: null });
    const launchArgs = helper.buildChromeLaunchArgs({ profileDir: "/capture-profile", url: "https://capture.invalid/", requestedViewport: viewport, virtualTimeBudgetMs: 10_000 });
    expect(launchArgs.at(-1)).toBe("about:blank");
    expect(launchArgs).not.toContain("https://capture.invalid/");
    expect(launchArgs).not.toContain("--virtual-time-budget=10000");
    const calls: CdpCall[] = [];
    let expireBudget: () => void = () => {};
    const budgetExpired = new Promise<void>((resolveBudget) => { expireBudget = resolveBudget; });
    const cdp = { command: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      calls.push({ method, params, ...(sessionId == null ? {} : { sessionId }) });
      if (method === "Emulation.setVirtualTimePolicy" && params.budget === 10_000) expireBudget();
      return method === "Target.attachToTarget" ? { sessionId: "capture-session" } : {};
    }, waitForEvent: async (method: string, sessionId?: string) => {
      calls.push({ method: `wait:${method}`, params: {}, ...(sessionId == null ? {} : { sessionId }) });
      await budgetExpired;
      return {};
    } };
    await helper.attachCaptureTarget({ cdp, targetId: "page-target", url: "https://capture.invalid/", requestedViewport: viewport, viewportMode: "legacy-control", virtualTimeBudgetMs: 10_000 });
    expect(calls.map(({ method }) => method)).toEqual([
      "Target.attachToTarget", "Page.enable", "Runtime.enable", "Emulation.setVirtualTimePolicy", "Page.navigate",
      "wait:Emulation.virtualTimeBudgetExpired", "Emulation.setVirtualTimePolicy",
    ]);
    expect(calls[0].params).toEqual({ targetId: "page-target", flatten: true });
    expect(calls[3].params).toEqual({ policy: "pause" });
    expect(calls[4].params).toEqual({ url: "https://capture.invalid/" });
    expect(calls[6].params).toEqual(helper.virtualTimePolicyFor(10_000));
    expect(calls.slice(1).every(({ sessionId }) => sessionId === "capture-session")).toBe(true);
    expect(calls.some(({ method }) => method === "Target.setAutoAttach")).toBe(false);
    expect(helper.CAPTURE_PROCESS_STRATEGY).toBe("one-browser-per-capture");
  });

  it("consumes the budget-event rejection when setting the virtual-time policy fails", async () => {
    let rejectBudget: (reason: Error) => void = () => {};
    const budgetExpired = new Promise<void>((_resolveBudget, rejectBudgetPromise) => { rejectBudget = rejectBudgetPromise; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.prependListener("unhandledRejection", onUnhandled);
    try {
      const cdp = {
        command: async (method: string, params: Record<string, unknown> = {}) => {
          if (method === "Target.attachToTarget") return { sessionId: "capture-session" };
          if (method === "Emulation.setVirtualTimePolicy" && params.budget === 10_000) throw new Error("virtual-time policy rejected");
          return {};
        },
        waitForEvent: () => budgetExpired,
      };
      await expect(helper.attachCaptureTarget({
        cdp, targetId: "page-target", url: "https://capture.invalid/", requestedViewport: viewport,
        viewportMode: "legacy-control", virtualTimeBudgetMs: 10_000,
      })).rejects.toThrow(/virtual-time policy rejected/);
      rejectBudget(new Error("CDP closed after policy failure"));
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("issues Browser.getVersion and exact screenshot arguments on one flat session", async () => {
    const calls: CdpCall[] = [];
    let expireBudget: () => void = () => {};
    let markBudgetStarted: () => void = () => {};
    const budgetExpired = new Promise<void>((resolveBudget) => { expireBudget = resolveBudget; });
    const budgetStarted = new Promise<void>((resolveStarted) => { markBudgetStarted = resolveStarted; });
    const cdp = { command: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      calls.push({ method, params, ...(sessionId == null ? {} : { sessionId }) });
      if (method === "Target.getTargets") return { targetInfos: [{ type: "page", url: "about:blank", targetId: "page-target" }] };
      if (method === "Target.attachToTarget") return { sessionId: "capture-session" };
      if (method === "Browser.getVersion") return rawVersion;
      if (method === "Runtime.evaluate") return { result: { value: stableSnapshot } };
      if (method === "Page.captureScreenshot") return { data: "png-base64" };
      if (method === "Emulation.setVirtualTimePolicy" && params.budget === 10_000) markBudgetStarted();
      return {};
    }, waitForEvent: async (method: string, sessionId?: string) => {
      calls.push({ method: `wait:${method}`, params: {}, ...(sessionId == null ? {} : { sessionId }) });
      await budgetExpired;
      return {};
    } };
    const pendingResult = helper.executeCaptureProtocol({
      cdp, url: "https://capture.invalid/", requestedViewport: viewport, viewportMode: "legacy-control", readinessKind: "standby",
      virtualTimeBudgetMs: 10_000, label: "mock capture", initialDelayMs: 0, sampleDelayMs: 0, maxSamples: 2,
      waitFor: async () => undefined, stableProjection: (value: unknown) => value,
      collectSnapshot: async ({ evaluate }: { evaluate(expression: string): Promise<SessionSnapshot> }) => evaluate("snapshot()"),
    });
    await budgetStarted;
    expect(calls.some(({ method }) => method === "Runtime.evaluate" || method === "Page.captureScreenshot")).toBe(false);
    expireBudget();
    const result = await pendingResult;
    expect(result.version).toEqual(rawVersion);
    expect(result.screenshotData).toBe("png-base64");
    expect(calls.filter(({ method }) => method === "Browser.getVersion")).toEqual([{ method: "Browser.getVersion", params: {} }]);
    expect(calls.find(({ method }) => method === "Page.captureScreenshot")).toEqual({ method: "Page.captureScreenshot", params: helper.SCREENSHOT_PARAMS, sessionId: "capture-session" });
    expect(calls.filter(({ method }) => method === "Runtime.evaluate")).toHaveLength(3);
  });

  it("collects DOM, diagnostics, geometry, and signatures in one evaluation", async () => {
    let evaluations = 0;
    let expression = "";
    const snapshot = await capture.collectNormalSnapshot({ evaluate: async (value) => {
      evaluations += 1;
      expression = value;
      return { document: standbyDocument, liveGeometry: stableSnapshot.liveGeometry };
    } });
    expect(evaluations).toBe(1);
    expect(expression).toContain("document: await");
    expect(expression).toContain("liveGeometry: await");
    expect(snapshot).toMatchObject({
      document: { domSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      diagnostics: { "data-measurement-settled": "true" },
      liveGeometry: { signatures: { fonts: [], payload: {}, candidates: [], capacity: {} } },
    });
  });

  it("rejects a DOM-hash change across the screenshot even when geometry is unchanged", async () => {
    const calls: CdpCall[] = [];
    const cdp = { command: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      calls.push({ method, params, ...(sessionId == null ? {} : { sessionId }) });
      if (method === "Target.getTargets") return { targetInfos: [{ type: "page", url: "about:blank", targetId: "page-target" }] };
      if (method === "Target.attachToTarget") return { sessionId: "capture-session" };
      if (method === "Browser.getVersion") return rawVersion;
      if (method === "Page.captureScreenshot") return { data: "png-base64" };
      return {};
    } };
    const before = { ...stableSnapshot, document: { ...standbyDocument, domSha256: "a".repeat(64) } };
    const after = { ...stableSnapshot, document: { ...standbyDocument, domSha256: "b".repeat(64) } };
    const snapshots = [before, before, after];
    await expect(helper.executeCaptureProtocol({
      cdp, url: "https://capture.invalid/", requestedViewport: viewport, viewportMode: "legacy-control", readinessKind: "standby",
      virtualTimeBudgetMs: null, label: "DOM mutation", initialDelayMs: 0, sampleDelayMs: 0, maxSamples: 2,
      waitFor: async () => undefined, stableProjection: capture.captureStableProjection,
      collectSnapshot: async () => snapshots.shift(),
    })).rejects.toThrow(/DOM state changed while capturing screenshot/);
    expect(calls.filter(({ method }) => method === "Page.captureScreenshot")).toHaveLength(1);
  });

  it("serializes the doctype and stable DOM by executing the browser expression", async () => {
    const evaluateExpression = new Function(`return ${helper.DOCUMENT_CAPTURE_EXPRESSION}`) as () => Promise<CaptureDocumentState>;
    const documentState = await evaluateExpression();
    expect(documentState.dom).toMatch(/^<!DOCTYPE html>\n<html[\s\S]*<\/html>$/i);
    expect(documentState.stableDom).toMatch(/^<!DOCTYPE html>\n<html[\s\S]*<\/html>$/i);
  });

  it("rejects pending CDP commands on pipe EOF and child exit", async () => {
    const eventChild = new FakeChild(null);
    const eventCdp = helper.createCdpPipe(eventChild);
    const event = eventCdp.waitForEvent("Emulation.virtualTimeBudgetExpired", "capture-session");
    eventChild.stdio[4]?.write(`${JSON.stringify({ method: "Emulation.virtualTimeBudgetExpired", params: { virtualTimeElapsed: 10_000 }, sessionId: "capture-session" })}\0`);
    await expect(event).resolves.toEqual({ virtualTimeElapsed: 10_000 });

    const eofChild = new FakeChild(null);
    const eofCdp = helper.createCdpPipe(eofChild);
    const eofAssertion = expect(eofCdp.command("Runtime.evaluate")).rejects.toThrow(/pipe ended/);
    eofChild.stdio[4]?.end();
    await eofAssertion;

    const exitChild = new FakeChild(null);
    const exitCdp = helper.createCdpPipe(exitChild);
    const exitAssertion = expect(exitCdp.command("Page.captureScreenshot")).rejects.toThrow(/Chrome exited/);
    exitChild.emit("exit", 9, null);
    await exitAssertion;
  });

  it("waits for SIGTERM and escalates to a bounded SIGKILL", async () => {
    const graceful = new FakeChild("SIGTERM");
    await expect(helper.terminateChild(graceful, { graceMs: 1, killWaitMs: 1 })).resolves.toBe("sigterm");
    expect(graceful.killSignals).toEqual(["SIGTERM"]);
    const forced = new FakeChild("SIGKILL");
    await expect(helper.terminateChild(forced, { graceMs: 1, killWaitMs: 5 })).resolves.toBe("sigkill");
    expect(forced.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("enforces the 120 second capture deadline and kills a hung Chrome", async () => {
    expect(helper.CAPTURE_TIMEOUT_MS).toBe(120_000);
    const child = new FakeChild("SIGKILL");
    const run = helper.runCaptureBrowserSession({
      chrome: "chrome", profileDir: "/capture-profile", url: "https://capture.invalid/", requestedViewport: viewport,
      viewportMode: "legacy-control", readinessKind: "standby", virtualTimeBudgetMs: 10_000, sessionRole: "primary",
      collectSnapshot: async () => stableSnapshot, timeoutMs: 5, terminationKillWaitMs: 10,
      spawnBrowser: () => child, protocolRunner: () => new Promise(() => undefined),
    });
    await expect(run).rejects.toThrow(/timed out after 5ms/);
    expect(child.killSignals).toContain("SIGKILL");
  });

  it("records Browser metadata and reaps Chrome on the session wrapper", async () => {
    const child = new FakeChild("SIGTERM");
    let launchArgs: string[] = [];
    const protocolResult: ProtocolResult = { version: rawVersion, stable: [stableSnapshot, stableSnapshot], preScreenshot: stableSnapshot, postScreenshot: stableSnapshot, screenshotData: "png" };
    const session = await helper.runCaptureBrowserSession({
      chrome: "chrome", profileDir: "/capture-profile", url: "https://capture.invalid/", requestedViewport: viewport,
      viewportMode: "legacy-control", readinessKind: "standby", virtualTimeBudgetMs: 10_000, sessionRole: "primary",
      collectSnapshot: async () => stableSnapshot, timeoutMs: 100, terminationGraceMs: 5,
      spawnBrowser: (_chrome: string, args: string[]) => { launchArgs = args; return child; },
      protocolRunner: async () => protocolResult,
    });
    expect(session).toMatchObject({ browser, capture: { viewportMode: "legacy-control", virtualTimeBudgetMs: 10_000, sessionRole: "primary" } });
    expect(launchArgs.at(-1)).toBe("about:blank");
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("traces CDP ids, methods, sessions, and lifecycle while bounding payloads", () => {
    expect(helper.formatCdpTraceMessage("send", { id: 7, method: "Runtime.evaluate", sessionId: "capture-session", params: { expression: "x".repeat(1_000) } }))
      .toBe('[capture-cdp] send {"id":7,"method":"Runtime.evaluate","sessionId":"capture-session","params":{"expression":"<expression:1000>"}}');
    expect(helper.formatCdpTraceMessage("recv", { method: "Target.detachedFromTarget", params: { sessionId: "capture-session", targetId: "page-target" } }))
      .toContain('"Target.detachedFromTarget"');
    expect(readFileSync(helperScriptPath, "utf8")).toContain('process.env.CAPTURE_CDP_TRACE === "1"');
  });
});

describe("capture report acceptance", () => {
  it("rejects old-schema after and baseline records independently", () => {
    const after = { schemaVersion: 2, suite: "design-alignment", mode: "after", records: [designRecord()] };
    const baseline = { schemaVersion: 2, suite: "design-alignment", mode: "baseline", records: [designRecord()] };
    const oldRecord = designRecord({ schemaVersion: 1, viewport: standbyDocument.viewport, browser: undefined, geometry: { viewport: standbyDocument.viewport } });
    expect(() => capture.assertDesignAlignmentSavedRecords({ ...after, records: [oldRecord] }, baseline)).toThrow(/record 0.*schemaVersion/);
    expect(() => capture.assertDesignAlignmentSavedRecords(after, { ...baseline, records: [oldRecord] })).toThrow(/record 0.*schemaVersion/);
    expect(() => capture.assertDesignAlignmentSavedRecords({ ...after, schemaVersion: 1 }, baseline)).toThrow(/wrapper schemaVersion/);
    expect(() => capture.assertDesignAlignmentSavedRecords(after, { ...baseline, schemaVersion: 1 })).toThrow(/wrapper schemaVersion/);
  });

  it("rejects missing browser and readiness fields instead of backfilling old records", () => {
    const after = { schemaVersion: 2, suite: "design-alignment", mode: "after", records: [designRecord()] };
    const baseline = { schemaVersion: 2, suite: "design-alignment", mode: "baseline", records: [designRecord()] };
    expect(() => capture.assertDesignAlignmentSavedRecords({ ...after, records: [designRecord({ browser: undefined })] }, baseline)).toThrow(/browser\.requestedBinary/);
    expect(() => capture.assertDesignAlignmentSavedRecords(after, { ...baseline, records: [designRecord({ geometry: { viewport: standbyDocument.viewport } })] })).toThrow(/readiness/);
  });

  it("separates positive, table, and expected-failure fixture policy without normal fallback", () => {
    expect(capture.captureExpectationPolicy(null, "max", "1280x720")).toBe("normal-table");
    expect(capture.captureExpectationPolicy("tornado-pages", "7", "1280x720")).toBe("fixture-table");
    expect(capture.captureExpectationPolicy("attention-visibility-standby", "max", "1280x720")).toBe("fixture-assertions-only");
    expect(capture.captureExpectationPolicy("overflow", "quiet", "960x620")).toBe("expected-failure");
    expect(capture.tableMismatches({}, "max", { label: "1280x720" }, "attention-visibility-standby")).toEqual([]);
  });

  it("uses every rotation result for report exit while retaining tick-zero cells", () => {
    const results = [
      { rotationTick: 0, expectationPolicy: "normal-table", mismatches: [] },
      { rotationTick: 1, expectationPolicy: "normal-table", mismatches: [{ key: "stage" }] },
    ];
    const finalized = capture.createStandardReportResult({ results, reportMode: true, outDir: "/artifacts" });
    expect(finalized.report).toMatchObject({ schemaVersion: 2, suite: "normal", cells: [results[0]] });
    expect(finalized.exitCode).toBe(1);
    expect(capture.standardReportExitCode([{ expectationPolicy: "fixture-assertions-only", mismatches: [] }])).toBe(0);
    const report = { schemaVersion: 2, suite: "normal", cells: [validRecord({ mismatches: [{ key: "stage" }] })] };
    expect(() => capture.assertCaptureReport(report, { expectSuite: "normal", expectViewportMode: "legacy-control", expectCells: 1, expectMismatches: 1 })).not.toThrow();
    expect(() => capture.assertCaptureReport(report, { expectMismatches: 0 })).toThrow(/mismatch count/);
  });

  it("canonicalizes recursively and pins the unchanged base expectation digest", () => {
    expect(helper.canonicalJsonStringify({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 1, a: 2 }, 4] }))
      .toBe('{"a":{"x":3,"y":2},"list":[{"a":2,"b":1},4],"z":1}');
    expect(() => helper.canonicalJsonStringify({ invalid: undefined })).toThrow(/forbids undefined/);
    expect(() => helper.canonicalJsonStringify({ invalid: Number.NaN })).toThrow(/non-finite/);
    const digest = "e0967e7a6c7c1fecf2096cbf436bc7b93ee3439d410445932de486509853c6ce";
    expect(capture.legacyExpectationDigest()).toBe(digest);
    expect(capture.verifyLegacyExpectationDigest(digest)).toBe(digest);
    expect(() => capture.verifyLegacyExpectationDigest("0".repeat(64))).toThrow(/digest mismatch/);
  });

  it("defaults normal to legacy and passes resolved design mode into the real session route", async () => {
    const normal = capture.parseCaptureArgs([]);
    const design = capture.parseCaptureArgs(["--suite", "design-alignment"]);
    const explicitLegacy = capture.parseCaptureArgs(["--suite", "design-alignment", "--viewport-mode", "legacy-control"]);
    expect(normal.viewportMode).toBe("legacy-control");
    expect(capture.viewportModeForSuite(normal)).toBe("legacy-control");
    expect(capture.viewportModeForSuite(design)).toBe("calibrated");
    expect(capture.viewportModeForSuite(explicitLegacy)).toBe("legacy-control");

    const forwarded = await capture.runDesignCaptureSession({
      chrome: "chrome", profileDir: "/capture-profile", url: "https://capture.invalid/", viewport,
      viewportMode: "legacy-control", entry: { scenario: "legacy-standby-gate", viewport: viewport.label, rotationTick: 0, cardPageTick: 0, query: "gateScenario=max" },
      sessionRunner: async (options: Record<string, unknown>) => options,
    }) as Record<string, unknown>;
    expect(forwarded).toMatchObject({ viewportMode: "legacy-control", requestedViewport: viewport, virtualTimeBudgetMs: null, sessionRole: "primary" });
    expect(typeof forwarded.collectSnapshot).toBe("function");
    let evaluations = 0;
    const collectSnapshot = forwarded.collectSnapshot as (options: { evaluate(expression: string): Promise<Record<string, unknown>> }) => Promise<Record<string, unknown>>;
    const designSnapshot = await collectSnapshot({ evaluate: async () => {
      evaluations += 1;
      return { document: standbyDocument, designGeometry: { ready: true } };
    } });
    expect(evaluations).toBe(1);
    expect(designSnapshot).toMatchObject({ document: { domSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, designGeometry: { ready: true } });
  });

  it("fails closed on weather kind-area report fields, enums, oracle, and non-regression values", () => {
    const oracle = {
      kinds: [
        { kindKey: "officialL4|landslide", areas: [{ name: "秋田県秋田市", code: "0520100" }, { name: "秋田県能代市", code: "0520200" }] },
        { kindKey: "nonLevelWarning|flood", areas: [{ name: "富山県富山市", code: "1620100" }, { name: "富山県高岡市", code: "1620200" }] },
      ], totalAreas: 4,
    };
    const expectedRows = capture.weatherLogicalRowsForPhase([
      "officialL4|landslide|秋田県秋田市|0|code:0520100",
      "officialL4|landslide|秋田県能代市|1|code:0520200",
      "nonLevelWarning|flood|富山県富山市|0|code:1620100",
      "nonLevelWarning|flood|富山県高岡市|1|code:1620200",
    ], "weather-kind-area", "after");
    const legacyRows = capture.weatherLogicalRowsForPhase([
      "legacyL4|土砂災害|秋田県秋田市|0|code:0520100",
      "legacyL4|土砂災害|秋田県能代市|1|code:0520200",
      "legacyWarning|重複地域|別表示名|0|code:0520100",
      "legacyWarning|洪水|富山県富山市|0|code:1620100",
      "legacyWarning|洪水|富山県高岡市|1|code:1620200",
    ], "weather-kind-area", "base");
    expect(legacyRows).toHaveLength(4);
    const sharedCodeOracle = {
      kinds: [
        { kindKey: "kind-a", areas: [{ name: "地域A", code: "shared" }] },
        { kindKey: "kind-b", areas: [{ name: "地域B", code: "shared" }] },
      ],
      totalAreas: 2,
    };
    const sharedCodeRows = [
      { kindKey: "kind-a", name: "地域A", code: "shared", occurrenceIndex: 0 },
      { kindKey: "kind-b", name: "地域B", code: "shared", occurrenceIndex: 0 },
    ];
    expect(capture.assertWeatherAfterLogicalOracle(sharedCodeRows, sharedCodeOracle)).toBe(true);
    expect(() => capture.assertWeatherAfterLogicalOracle(sharedCodeRows.slice(0, 1), sharedCodeOracle)).toThrow(/kind set/);
    expect(() => capture.assertWeatherAfterLogicalOracle([
      { ...sharedCodeRows[0], kindKey: "kind-b" }, sharedCodeRows[1],
    ], sharedCodeOracle)).toThrow(/kind set/);
    const weatherRecord = {
      fixtureId: "weather-kind-area", fixtureProvenance: "synthetic", viewport, rotationTick: 0, cardPageTick: 0,
      phase: "base", allowedDeltaReason: "none", logicalOracle: oracle,
      selectedWeatherRows: legacyRows,
      selectedWeatherKindAssociation: { status: "unavailable", reason: "legacy-product-dom" },
      selectedWeatherProjection: { mode: "legacy-union", identity: "code-else-name", dedupe: "cross-kind-first", order: "legacy-display" },
      visibleWeatherRows: [] as Array<Record<string, unknown>>, visibleWeatherTails: [],
      omittedAreaCountByKind: { "legacy|landslide": 0, "legacy|flood": 0 },
      omittedAreaCountProjection: { mode: "legacy-order-to-oracle-kind", entries: [
        { canonicalKindKey: "officialL4|landslide", sourceKindKey: "legacy|landslide", omittedAreaCount: 0 },
        { canonicalKindKey: "nonLevelWarning|flood", sourceKindKey: "legacy|flood", omittedAreaCount: 0 },
      ] },
      visibleCards: ["weather"], rotation: { keys: [], active: "", stage: "0", compressed: false, typhoonVariant: null, placements: { left: [], right: ["weather"], center: [] } },
      rotationSurface: "unreachable",
      rotationSurfaceReason: { reason: "stage-before-rotation", reachedStage: "0", rotationMembers: [] },
      failureCount: 0, omittedCount: 0, overflow: { cards: [], pages: [], card: { x: 0, y: 0 }, body: { x: 0, y: 0 }, readable: [{ x: 0, y: 0 }] }, unresolved: "false",
      weatherFooterChrome: { mode: "absent", generation: "1", count: 0, observedFooterModes: [], partitionOutcome: "legacy-base", card: null, footer: null }, finalWeatherRanges: ["0:4"], finalTornadoRanges: [], finalWeatherRangesByPlacement: { side: ["0:4"], center: ["0:4"] }, finalTornadoRangesByPlacement: { side: [], center: [] }, finalCartesianCompositions: [], exploratoryTornadoCompositions: [],
      geometry: { weatherCards: [{ shelf: false, surface: "weather:right", range: "0:4" }] },
    };
    weatherRecord.visibleWeatherRows = weatherRecord.selectedWeatherRows;
    expect(() => capture.assertWeatherKindAreaRecord(weatherRecord)).not.toThrow();
    expect(() => capture.assertWeatherKindAreaRecord({ ...weatherRecord, phase: "candidate" })).toThrow(/invalid/);
    expect(() => capture.assertWeatherKindAreaRecord({ ...weatherRecord, logicalOracle: { ...oracle, totalAreas: 3 } })).toThrow(/logicalOracle/);
    expect(() => capture.assertWeatherKindAreaRecord({ ...weatherRecord, selectedWeatherRows: [] })).toThrow(/independent oracle/);
    expect(() => capture.assertWeatherKindAreaRecord({ ...weatherRecord, selectedWeatherRows: [] })).toThrow(/actual=\[\] expected=\["code:0520100"/);
    expect(() => capture.assertWeatherKindAreaRecord({ ...weatherRecord, selectedWeatherKindAssociation: { status: "complete", reason: null } })).toThrow(/limitation/);
    expect(() => capture.assertWeatherKindAreaRecord({ ...weatherRecord, rotationSurfaceReason: null })).toThrow(/rotation surface evidence/);
    const geometryCard = {
      logicalItems: ["logical"], layout: "multi", columnCount: "1", groups: [{ labelDocumentCount: 1, labelTargetWithinGroup: true, blockAxisIntersection: 12 }],
      groupOverlapArea: 0, bodyFooterOverlap: 0, footerRiderOverlap: 0, footerCount: 0, footerMode: "absent", placement: "side", range: "0:4", card: { width: 360, height: 200 },
    };
    const after = {
      ...weatherRecord, phase: "after", allowedDeltaReason: "none",
      selectedWeatherRows: expectedRows, visibleWeatherRows: expectedRows,
      selectedWeatherKindAssociation: { status: "complete", reason: null },
      selectedWeatherProjection: { mode: "kind-area", identity: "kind+code-else-name", dedupe: "within-kind", order: "kind-then-area" },
      omittedAreaCountByKind: { "officialL4|landslide": 0, "nonLevelWarning|flood": 0 },
      omittedAreaCountProjection: { mode: "kind-key", entries: [
        { canonicalKindKey: "officialL4|landslide", sourceKindKey: "officialL4|landslide", omittedAreaCount: 0 },
        { canonicalKindKey: "nonLevelWarning|flood", sourceKindKey: "nonLevelWarning|flood", omittedAreaCount: 0 },
      ] },
      weatherFooterChrome: { ...weatherRecord.weatherFooterChrome, observedFooterModes: ["absent"], partitionOutcome: "provisional-is-final" },
      geometry: { weatherCards: [
        { ...geometryCard, shelf: false, surface: "weather:right" },
        { ...geometryCard, shelf: true, surface: null, measurementKind: "normal", measurementFooter: "absent" },
        { ...geometryCard, shelf: true, surface: null, placement: "center", measurementKind: "normal", measurementFooter: "absent" },
        { ...geometryCard, shelf: true, surface: null, measurementKind: "weather-page", measurementFooter: "absent", measurementPageIndex: 1, measurementPageCount: 1, probeFit: "true" },
        { ...geometryCard, shelf: true, surface: null, placement: "center", measurementKind: "weather-page", measurementFooter: "absent", measurementPageIndex: 1, measurementPageCount: 1, probeFit: "true" },
      ] },
    };
    expect(() => capture.assertWeatherKindAreaRecord(after)).not.toThrow();
    expect(() => capture.assertWeatherKindAreaRecord({
      ...after, selectedWeatherRows: after.selectedWeatherRows.map((row, index) => index === 0 ? { ...row, kindKey: "nonLevelWarning|flood" } : row),
    })).toThrow(/kind set|kind-area association/);
    expect(() => capture.assertWeatherKindAreaRecord({
      ...after, omittedAreaCountProjection: { ...after.omittedAreaCountProjection, entries: [...after.omittedAreaCountProjection.entries].reverse() },
    })).toThrow(/omitted canonical kind set\/order/);
    const threePageRanges = ["0:2", "2:4", "4:6"];
    const exactWeatherOrdinals = threePageRanges.map((range, index) => ({ range, measurementPageIndex: index + 1, measurementPageCount: 3 }));
    expect(capture.assertForcedMeasurementPageOrdinals(exactWeatherOrdinals, threePageRanges)).toBe(true);
    expect(() => capture.assertForcedMeasurementPageOrdinals(
      exactWeatherOrdinals.map((card, index) => index === 1 ? {
        ...card, measurementPageIndex: 3, placement: "side", card: { width: 360 },
        measurementFooter: "present", layout: "multi", probeId: "weather:page-fit:2:4", footerGeneration: "2",
      } : card), threePageRanges,
    )).toThrow(/actual=3\/3 expected=2\/3 context=\{"placement":"side","width":360,"footerMode":"present","layoutMode":"multi","cacheKey":"weather:page-fit:2:4","generation":"2"\}/);
    const exactTornadoOrdinals = threePageRanges.map((tornadoRange, index) => ({ tornadoRange, tornadoPageIndex: index + 1, tornadoPageCount: 3 }));
    expect(capture.assertForcedMeasurementPageOrdinals(exactTornadoOrdinals, threePageRanges, "tornadoRange", "tornadoPageIndex", "tornadoPageCount", "tornado")).toBe(true);
    expect(() => capture.assertWeatherKindAreaRecord({ ...after, weatherFooterChrome: { ...after.weatherFooterChrome, observedFooterModes: [] } })).toThrow(/provisional generation/);
    const regressed = { ...after, selectedWeatherRows: expectedRows.slice(0, 3), visibleWeatherRows: expectedRows.slice(0, 3) };
    const fhd = { label: "1920x1080", width: 1920, height: 1080 };
    const baseReport = { schemaVersion: 2, suite: "weather-kind-area", records: [weatherRecord, { ...weatherRecord, viewport: fhd }] };
    const afterReport = { schemaVersion: 2, suite: "weather-kind-area", records: [after, { ...after, viewport: fhd }] };
    expect(capture.assertWeatherKindAreaReport(baseReport)).toMatchObject({ records: 2, outerCells: 2, reachableRotationSurfaceCells: 0, pressureCells: 0 });
    expect(capture.assertWeatherKindAreaComparison(baseReport, afterReport)).toMatchObject({ compared: 2 });
    expect(capture.assertWeatherMatrixPressure(baseReport.records, "weather-kind-area")).toBe(0);
    expect(capture.assertWeatherMatrixPressure([
      { rotation: { stage: "0" } }, { rotation: { stage: "1" } },
    ], "weather-kind-area-footer-boundary")).toBe(1);
    expect(() => capture.assertWeatherMatrixPressure([
      { rotation: { stage: "0" } },
    ], "weather-kind-area-footer-boundary")).toThrow(/stage >= 1/);
    expect(() => capture.assertWeatherKindAreaReport({ schemaVersion: 2, suite: "weather-kind-area", records: [] })).toThrow(/empty/);
    expect(() => capture.assertWeatherKindAreaComparison(baseReport, { ...afterReport, records: [regressed, { ...after, viewport: fhd }] })).toThrow(/independent oracle/);
    expect(() => capture.assertWeatherKindAreaComparison(baseReport, { ...afterReport, records: [after] })).toThrow(/viewport matrix/);
    expect(() => capture.assertWeatherKindAreaComparison(baseReport, { ...afterReport, records: afterReport.records.map((record) => ({
      ...record, phase: "base", selectedWeatherRows: legacyRows, visibleWeatherRows: legacyRows,
      selectedWeatherKindAssociation: { status: "unavailable", reason: "legacy-product-dom" },
      selectedWeatherProjection: { mode: "legacy-union", identity: "code-else-name", dedupe: "cross-kind-first", order: "legacy-display" },
      omittedAreaCountByKind: { "legacy|landslide": 0, "legacy|flood": 0 },
      omittedAreaCountProjection: weatherRecord.omittedAreaCountProjection,
    })) })).toThrow(/phase mismatch/);
    const omittedRegression = afterReport.records.map((record) => ({
      ...record,
      visibleWeatherTails: [{ kindKey: "officialL4|landslide", omittedAreaCount: 1 }],
      omittedAreaCountByKind: { ...record.omittedAreaCountByKind, "officialL4|landslide": 1 },
      omittedAreaCountProjection: { ...record.omittedAreaCountProjection, entries: record.omittedAreaCountProjection.entries.map((entry) =>
        entry.canonicalKindKey === "officialL4|landslide" ? { ...entry, omittedAreaCount: 1 } : entry) },
    }));
    expect(() => capture.assertWeatherKindAreaComparison(baseReport, { ...afterReport, records: omittedRegression })).toThrow(/omitted count regressed for officialL4\|landslide/);
    expect(capture.weatherVisibleRotationTicks("3", ["weather", "flood", "heat"])).toEqual([0]);
    expect(capture.weatherVisibleRotationTicks("3", ["flood", "heat"])).toEqual([0]);
    expect(capture.weatherVisibleRotationTicks("2", [])).toEqual([0]);
    expect(capture.assertWeatherStageTickCoverage([
      { rotationTick: 0, rotation: { stage: "2", keys: [], active: "" } },
    ], "1280x720")).toEqual({ stage: "2", ticks: [0] });
    expect(capture.assertWeatherStageTickCoverage([
      { rotationTick: 0, rotation: { stage: "3", keys: ["flood", "heat"], active: "flood" } },
    ], "1280x720")).toEqual({ stage: "3", ticks: [0] });
    expect(() => capture.assertWeatherStageTickCoverage([
      { rotationTick: 0, rotation: { stage: "2", keys: [], active: "" } },
      { rotationTick: 0, rotation: { stage: "1", keys: [], active: "" } },
    ], "1280x720")).toThrow(/changed across cells/);
  });
});
