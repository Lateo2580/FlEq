import { testTelegramMeta } from "../../helpers/telegram-meta";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDisplayController } from "../../../src/engine/display/controller";
import { SWEEP_INTERVAL_MS } from "../../../src/engine/display/constants";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { StandbyPersistence } from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import type { DisplayRuntime } from "../../../src/engine/display/runtime";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { createShutdownHandler } from "../../../src/engine/monitor/shutdown";
import * as shutdownModule from "../../../src/engine/monitor/shutdown";
import { DEFAULT_CONFIG, type ParsedHeatAlertInfo, type ParsedTornadoAdvisory } from "../../../src/types";

const mockStartDisplayRuntime = vi.fn();
const mockSetActiveDisplayRuntime = vi.fn();

vi.mock("../../../src/engine/display/runtime", () => ({
  startDisplayRuntime: (...args: unknown[]) => mockStartDisplayRuntime(...args),
  setActiveDisplayRuntime: (...args: unknown[]) => mockSetActiveDisplayRuntime(...args),
}));

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const tempRoots: string[] = [];

function heatEvent(): PresentationEvent {
  const raw: ParsedHeatAlertInfo = {
    meta: testTelegramMeta(false),
    type: "VPFT50", infoType: "発表", title: "東京都熱中症警戒アラート", controlTitle: "熱中症警戒アラート",
    reportDateTime: "2026-07-21T05:00:00+09:00", targetDateTime: "2026-07-21T05:00:00+09:00",
    headline: null, publishingOffice: "環境省 気象庁", editorialOffice: "環境省 気象庁", eventId: null,
    serial: "1", targetAreaName: "東京都", notice: null, bodyText: null, isTest: false,
  };
  return {
    id: "heat-1", classification: "meteorological", domain: "heatAlert", type: "VPFT50", infoType: "発表",
    title: raw.title, controlTitle: raw.controlTitle, headline: null, reportDateTime: raw.reportDateTime,
    publishingOffice: raw.publishingOffice, isTest: false, frameLevel: "warning", isCancellation: false, serial: "1",
    areaNames: ["東京都"], forecastAreaNames: [], municipalityNames: [], observationNames: [], areaCount: 1,
    forecastAreaCount: 0, municipalityCount: 0, observationCount: 0, areaItems: [], raw,
  };
}

function tornadoEvent(
  validDateTime: string,
  publishingOffice: string = "東京管区気象台",
  reportTimeMs: number = T0,
  serial: string = "1",
  areas: string[] = ["千代田区", "港区"],
): PresentationEvent {
  const raw: ParsedTornadoAdvisory = {
    meta: testTelegramMeta(false),
    type: "VPHW50", infoType: "発表", title: "東京都竜巻注意情報", controlTitle: "竜巻注意情報",
    reportDateTime: new Date(reportTimeMs).toISOString(), validDateTime, headline: "東京都に竜巻注意情報",
    publishingOffice, editorialOffice: "気象庁", serial,
    layers: [], sightingAreas: [], isSightingTelegram: false, hasSightingAreas: false,
    activeAreaCount: areas.length, displaySeverity: "nonLevelWarning", soundLevel: "warning", isTest: false,
  };
  return {
    id: `tornado-${serial}`, classification: "meteorological", domain: "tornado", type: "VPHW50",
    infoType: "発表", title: raw.title, controlTitle: raw.controlTitle, headline: raw.headline,
    reportDateTime: raw.reportDateTime, publishingOffice, isTest: false,
    frameLevel: "warning", isCancellation: false, serial: raw.serial,
    areaNames: areas, forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: areas.length, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: areas.map((name, index) => ({ name, code: `1310${index}`, kind: "竜巻注意情報" })),
    raw,
  };
}

beforeEach(() => {
  mockStartDisplayRuntime.mockReset();
  mockSetActiveDisplayRuntime.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standby monitor wiring", () => {
  it("display off 中の ingest が、後で構築した snapshot の standbyItems に現れる", () => {
    const standby = new StandbyStateStore();
    standby.applyEvent(heatEvent(), T0);
    const display = new DisplayStateStore(() => standby.snapshotItems());
    expect(display.snapshot(0, T0).standbyItems).toEqual([expect.objectContaining({ kind: "heat" })]);
  });

  it("durableChanged は永続化 save に一本化できる", () => {
    const root = mkdtempSync(join(tmpdir(), "fleq-standby-wiring-"));
    tempRoots.push(root);
    const path = join(root, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(path);
    const standby = new StandbyStateStore();
    standby.onDurable(() => persistence.save(standby.exportActiveState()));
    standby.applyEvent(heatEvent(), T0);
    expect(persistence.load()?.heat).toHaveLength(1);
  });

  it("hub 稼働中は既存 sweep タイマーが standbySweep を駆動する", () => {
    vi.useFakeTimers();
    const standbySweep = vi.fn(() => ({ viewChanged: false, durableChanged: false }));
    const hub = new InfoDisplayHub(new DisplayStateStore(), {
      summarize: () => "summary", weatherAlerts: () => [], now: () => T0, standbySweep,
    });
    hub.startTimers();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(standbySweep).toHaveBeenCalledWith(T0);
    hub.stop();
  });

  it("空官署の竜巻 ticker は既定官署キーで保持・続報置換され、期限切れで消える", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const expiresAt = T0 + 3 * SWEEP_INTERVAL_MS;
    const standby = new StandbyStateStore();
    const event = tornadoEvent(new Date(expiresAt).toISOString(), "");
    standby.applyEvent(event, nowMs);
    const hub = new InfoDisplayHub(new DisplayStateStore(() => standby.snapshotItems()), {
      summarize: () => "竜巻注意情報",
      weatherAlerts: () => [],
      now: () => nowMs,
      standbySweep: (sweepAt) => standby.sweep(sweepAt),
      standbyTickerGroupKeys: () => standby.activeTickerGroupKeys(),
    });
    hub.ingest(event);
    expect(hub.buildSnapshot().recentTicker.map((dto) => dto.groupKey)).toEqual([
      "tornado:不明官署",
    ]);
    expect(standby.activeTickerGroupKeys()).toEqual(new Set(["tornado:不明官署"]));

    hub.startTimers();
    nowMs = T0 + SWEEP_INTERVAL_MS;
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(hub.buildSnapshot().recentTicker).toHaveLength(1);

    const followup = tornadoEvent(
      new Date(expiresAt).toISOString(),
      "",
      nowMs,
      "2",
      ["千代田区", "港区", "新宿区"],
    );
    standby.applyEvent(followup, nowMs);
    hub.ingest(followup);
    const revisions = hub.buildSnapshot().recentTicker;
    expect(revisions.map((dto) => dto.groupKey)).toEqual([
      "tornado:不明官署",
      "tornado:不明官署",
    ]);
    expect(revisions[0]?.tickerDetail).toContain("新宿区");

    nowMs = expiresAt;
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(standby.snapshotItems().some((item) => item.kind === "tornado")).toBe(false);
    expect(hub.buildSnapshot().recentTicker).toEqual([]);
    hub.stop();
  });

  it("controller は start 中に off sweep を止め、stop/失敗/kill switch で再開する", async () => {
    let runtime: DisplayRuntime | null = null;
    const setStandbyDirty = vi.fn();
    const rt = {
      hub: { markExternalStateDirty: vi.fn(), publishConnection: vi.fn() },
      transport: { port: () => 7788, clientCount: () => 0 },
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as DisplayRuntime;
    mockStartDisplayRuntime.mockResolvedValue(rt);
    const controller = createDisplayController({
      config: { ...DEFAULT_CONFIG, apiKey: "test", displayPort: 0 },
      display: {
        displayOutcome: vi.fn(), displayRawHeader: vi.fn(), displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn(),
        getDisplayMode: () => "normal", renderSummaryLine: () => "summary",
      },
      seeds: { tsunami: () => null, weather: () => undefined, landslide: () => undefined },
      getRuntime: () => runtime,
      setRuntime: (value) => { runtime = value; },
      setHubRef: vi.fn(),
      setStandbyDirty,
    });

    await controller.start();
    expect(setStandbyDirty).toHaveBeenCalledWith(expect.any(Function));
    const onStopped = mockStartDisplayRuntime.mock.calls[0][3] as () => void;
    onStopped();
    expect(setStandbyDirty).toHaveBeenLastCalledWith(null);

    runtime = rt;
    await controller.stop();
    expect(setStandbyDirty).toHaveBeenLastCalledWith(null);
  });

  it("shutdown は standby sweep を止めて最終 flush する", async () => {
    const order: string[] = [];
    const stopStandbySweep = vi.fn(() => { order.push("standby"); });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const shutdown = createShutdownHandler({
      apiKey: "test",
      manager: { getStatus: () => ({ socketId: null }), close: vi.fn() } as never,
      eewLogger: { closeAll: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) } as never,
      getReplHandler: () => null,
      resetTerminalTitle: vi.fn(),
      stopDisplayRuntime: vi.fn(async () => { order.push("display"); }),
      stopStandbySweep,
    });
    await shutdown();
    expect(stopStandbySweep).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["display", "standby"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("startMonitor の実 restore→sweep 経路は salvage rewrite を一度だけ予約する", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleq-standby-monitor-rewrite-"));
    tempRoots.push(root);
    const runtimeDir = join(root, "data", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const persisted = new StandbyStateStore().exportActiveState();
    persisted.heat = [{ key: "broken-heat" }] as never;
    writeFileSync(
      join(runtimeDir, "display-active-state-v1.json"),
      `${JSON.stringify(persisted)}\n`,
      "utf8",
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const schedule = vi.spyOn(StandbyPersistence.prototype, "schedule")
      .mockImplementation(() => undefined);
    const registerShutdownSignals = vi.spyOn(shutdownModule, "registerShutdownSignals")
      .mockImplementation(() => undefined);
    const connect = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../../src/dmdata/multi-connection-manager", () => {
      class FakeMultiConnectionManager {
        connect = connect;
        close = vi.fn();
        startBackup = vi.fn().mockResolvedValue("started");
        getStatus = vi.fn(() => ({ connected: false, socketId: null }));
        getDeliveryCapabilities = vi.fn(() => ({
          connected: false,
          effectiveClassifications: [],
          guaranteedHeadTypes: new Set<string>(),
          source: "unknown" as const,
        }));
      }
      return { MultiConnectionManager: FakeMultiConnectionManager };
    });
    vi.doMock("../../../src/engine/startup/tsunami-initializer", () => ({
      restoreTsunamiState: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("../../../src/engine/startup/volcano-initializer", () => ({
      restoreVolcanoState: vi.fn().mockResolvedValue("failed"),
    }));
    vi.doMock("../../../src/engine/notification/notifier", () => ({
      Notifier: class FakeNotifier {},
    }));
    vi.doMock("../../../src/ui/display-adapter", () => ({
      createDisplayAdapter: () => ({
        displayOutcome: vi.fn(),
        displayRawHeader: vi.fn(),
        displayTelegramDiagnostic: vi.fn(),
        displayVolcano: vi.fn(),
        displayVolcanoBatch: vi.fn(),
        getDisplayMode: () => "normal",
        renderSummaryLine: () => "summary",
      }),
    }));
    vi.doMock("../../../src/ui/repl", () => ({
      ReplHandler: class FakeReplHandler {
        setSummaryTimerControl = vi.fn();
        start = vi.fn();
        stop = vi.fn();
      },
    }));

    const { startMonitor } = await import("../../../src/engine/monitor/monitor");
    await startMonitor({ ...DEFAULT_CONFIG, apiKey: "test" });

    expect(cwd).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(registerShutdownSignals).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
