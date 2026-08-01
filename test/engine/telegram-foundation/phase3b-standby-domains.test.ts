import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
  NANKAI_INFORMATION_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  TORNADO_REVISION_FAMILY_POLICY,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
  TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY,
  WEATHER_TIMESERIES_REVISION_FAMILY_POLICY,
} from "../../../src/engine/messages/revision-family-registry";
import { processMessage } from "../../../src/engine/presentation/processors/process-message";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
} from "../../../src/engine/display/standby-persistence";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import { Notifier } from "../../../src/engine/notification/notifier";
import type { WsDataMessage } from "../../../src/types";
import { makeProcessDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPHW50_TOKYO,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTW60_2020,
  FIXTURE_VPWP50_NAGANO,
  FIXTURE_VXSE62_LGOBS,
  FIXTURE_VYSE50_ALERT,
  FIXTURE_VYSE51_ADVISORY,
  readFixture,
} from "../../helpers/mock-message";

const tempDirs: string[] = [];

function withReceivedAtMs(message: WsDataMessage, receivedAtMs: number): WsDataMessage {
  if (message.meta == null) throw new Error("fixture message must have TelegramMeta");
  return { ...message, meta: { ...message.meta, receivedAtMs } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Phase 3B standby domain registry", () => {
  it("declares state-granular policies and bounded subject counts", () => {
    expect(TORNADO_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: true, maxSubjects: 128 });
    expect(HEAT_ALERT_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: true, maxSubjects: 256 });
    expect(TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: true, maxSubjects: 64 });
    expect(TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: false, maxSubjects: 256 });
    expect(NANKAI_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: true, maxSubjects: 1 });
    expect(NANKAI_INFORMATION_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: false, maxSubjects: 256 });
    expect(WEATHER_TIMESERIES_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: false, maxSubjects: 512 });
    expect(LG_OBSERVATION_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "markCancelled", durable: true, maxSubjects: 256 });
  });

  it("classifies transitioned/cancelled typhoon lifecycle as terminal trigger B", () => {
    const outcome = processMessage(
      createMockWsDataMessageFromXml(readFixture(FIXTURE_VPTW60_2020), "VPTW60"),
      "typhoonAnalysis",
      makeProcessDeps(),
    );
    expect(outcome?.domain).toBe("typhoonAnalysis");
    if (outcome == null || outcome.domain !== "typhoonAnalysis") return;
    for (const lifecycle of ["transitionedToLow", "formationCancelled"] as const) {
      const parsed = { ...outcome.parsed, lifecycle };
      expect(TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY.terminalPredicate(parsed.meta, parsed)).toBe(true);
      expect(TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY.deactivationPredicate(parsed.meta, parsed)).toBe(false);
    }
  });

  it.each([
    [FIXTURE_VPHW50_TOKYO, "VPHW50", "tornado", true],
    [FIXTURE_VPFT50_SAITAMA, "VPFT50", "heatAlert", true],
    [FIXTURE_VPTW60_2020, "VPTW60", "typhoonAnalysis", true],
    [FIXTURE_VPTA50_DAMREY, "VPTA50", "typhoonProbability", true],
    [FIXTURE_VYSE50_ALERT, "VYSE50", "nankaiTrough", true],
    [FIXTURE_VYSE51_ADVISORY, "VYSE51", "nankaiTrough", false],
    [FIXTURE_VPWP50_NAGANO, "VPWP50", "weatherWarningTimeseries", true],
    [FIXTURE_VXSE62_LGOBS, "VXSE62", "lgObservation", true],
  ] as const)("gates a real %s fixture before presentation", (fixture, type, route, ownsProjection) => {
    const xml = readFixture(fixture);
    const deps = makeProcessDeps();
    const first = processMessage(createMockWsDataMessageFromXml(xml, type), route, deps);
    const semanticReplay = processMessage(
      createMockWsDataMessageFromXml(`${xml}\n`, type),
      route,
      deps,
    );
    expect(first?.presentation.standbyStateMutationAccepted).toBe(true);
    expect(first?.presentation.standbyStateSubject).toEqual(ownsProjection ? expect.any(String) : null);
    expect(semanticReplay).toBeNull();
  });

  it("accepts one same-revision tornado correction and suppresses its replay", () => {
    const xml = readFixture(FIXTURE_VPHW50_TOKYO);
    const correction = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
    const deps = makeProcessDeps();
    expect(processMessage(createMockWsDataMessageFromXml(xml, "VPHW50"), "tornado", deps)).not.toBeNull();
    const accepted = processMessage(createMockWsDataMessageFromXml(correction, "VPHW50"), "tornado", deps);
    const replay = processMessage(createMockWsDataMessageFromXml(`${correction}\n`, "VPHW50"), "tornado", deps);
    expect(accepted?.presentation.acceptedCorrection).toBe(true);
    expect(replay).toBeNull();
  });

  it("does not let a heat family update prune an active tornado family card", () => {
    const deps = makeProcessDeps();
    const tornado = processMessage(
      createMockWsDataMessageFromXml(readFixture(FIXTURE_VPHW50_TOKYO), "VPHW50"),
      "tornado",
      deps,
    );
    const heat = processMessage(
      createMockWsDataMessageFromXml(readFixture(FIXTURE_VPFT50_SAITAMA), "VPFT50"),
      "heatAlert",
      deps,
    );
    expect(tornado).not.toBeNull();
    expect(heat).not.toBeNull();
    if (tornado == null || heat == null) return;
    const store = new StandbyStateStore();
    store.applyEvent(toPresentationEvent(tornado), Date.now());
    expect(store.snapshotItems().map((item) => item.kind)).toContain("tornado");
    store.applyEvent(toPresentationEvent(heat), Date.now());
    expect(store.snapshotItems().map((item) => item.kind)).toEqual(
      expect.arrayContaining(["tornado", "heat"]),
    );
  });

  it.each([
    [FIXTURE_VPTA50_DAMREY, "VPTA50", "typhoonProbability", 7 * 24 * 60 * 60_000],
    [FIXTURE_VYSE51_ADVISORY, "VYSE51", "nankaiTrough", 30 * 24 * 60 * 60_000],
    [FIXTURE_VPWP50_NAGANO, "VPWP50", "weatherWarningTimeseries", 36 * 60 * 60_000],
  ] as const)("keeps non-durable %s watermarks for the declared runtime TTL", (fixture, type, route, retentionMs) => {
    const message = createMockWsDataMessageFromXml(readFixture(fixture), type);
    const receivedAtMs = message.meta?.receivedAtMs;
    expect(receivedAtMs).toEqual(expect.any(Number));
    if (receivedAtMs == null) return;
    const deps = makeProcessDeps();
    expect(processMessage(withReceivedAtMs(message, receivedAtMs), route, deps)).not.toBeNull();
    expect(processMessage(
      withReceivedAtMs(message, receivedAtMs + 12 * 60_000),
      route,
      deps,
    )).toBeNull();
    expect(processMessage(
      withReceivedAtMs(message, receivedAtMs + retentionMs + 1),
      route,
      deps,
    )).not.toBeNull();
  });

  it("does not let a same-revision heat correction reopen a clearCurrent tombstone", () => {
    const xml = readFixture(FIXTURE_VPFT50_SAITAMA);
    const cancel = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>取消</InfoType>");
    const correction = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
    const deps = makeProcessDeps();
    expect(processMessage(createMockWsDataMessageFromXml(xml, "VPFT50"), "heatAlert", deps)).not.toBeNull();
    expect(processMessage(createMockWsDataMessageFromXml(cancel, "VPFT50"), "heatAlert", deps)).not.toBeNull();
    expect(processMessage(createMockWsDataMessageFromXml(correction, "VPFT50"), "heatAlert", deps)).toBeNull();
  });

  it("keeps markCancelled semantics for a same-family VXSE62 correction", () => {
    const xml = readFixture(FIXTURE_VXSE62_LGOBS);
    const cancel = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>取消</InfoType>");
    const correction = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
    const deps = makeProcessDeps();
    expect(processMessage(createMockWsDataMessageFromXml(xml, "VXSE62"), "lgObservation", deps)).not.toBeNull();
    expect(processMessage(createMockWsDataMessageFromXml(cancel, "VXSE62"), "lgObservation", deps)).not.toBeNull();
    expect(processMessage(createMockWsDataMessageFromXml(correction, "VXSE62"), "lgObservation", deps)?.presentation.acceptedCorrection).toBe(true);
  });

  it("keeps an EventID-less typhoon report display-only and leaves standby state unchanged", () => {
    const xml = readFixture(FIXTURE_VPTW60_2020)
      .replace(/<EventID>[^<]*<\/EventID>/, "<EventID />");
    const deps = makeProcessDeps();
    const outcome = processMessage(createMockWsDataMessageFromXml(xml, "VPTW60"), "typhoonAnalysis", deps);
    expect(outcome?.presentation.standbyStateMutationAccepted).toBe(false);
    if (outcome == null) return;
    const store = new StandbyStateStore();
    expect(store.applyEvent(toPresentationEvent(outcome), Date.now())).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()).toEqual([]);
  });

  it("round-trips a gated tornado projection and dual-writes its v1 watermark", () => {
    const xml = readFixture(FIXTURE_VPHW50_TOKYO);
    const deps = makeProcessDeps();
    const outcome = processMessage(createMockWsDataMessageFromXml(xml, "VPHW50"), "tornado", deps);
    expect(outcome).not.toBeNull();
    if (outcome == null || outcome.domain !== "tornado") return;
    const store = new StandbyStateStore();
    store.applyEvent(toPresentationEvent(outcome), Date.parse(outcome.parsed.reportDateTime));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-standby-foundation-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(file, undefined, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      vpww56: { authoritative: false, state: null, gateEntries: [] },
      tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
      volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
      floodForecast: { authoritative: false, active: [], gateEntries: [] },
      standbyDomains: {
        gateEntries: deps.revisionGate.exportDurableEntries().filter((entry) => entry.domain === "tornado"),
      },
    }));
    persistence.schedule(store.exportActiveState());
    persistence.flush();
    const restored = new StandbyPersistence(file).load();
    expect(restored?.tornado).toHaveLength(1);
    expect(restored?.telegramFoundation.standbyDomains.gateEntries).toHaveLength(1);
    const legacy = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; seen: Array<{ key: string }> };
    expect(legacy.version).toBe(1);
    expect(legacy.seen).toContainEqual(expect.objectContaining({ key: "tornado:気象庁予報部" }));
  });

  it.each([
    [FIXTURE_VPFT50_SAITAMA, "VPFT50", "heatAlert", "heatAlert", "heat"],
    [FIXTURE_VPTW60_2020, "VPTW60", "typhoonAnalysis", "typhoonAnalysis", "typhoons"],
    [FIXTURE_VYSE50_ALERT, "VYSE50", "nankaiTrough", "nankaiTrough", "nankaiTrough"],
    [FIXTURE_VXSE62_LGOBS, "VXSE62", "lgObservation", "lgObservation", "longPeriod"],
  ] as const)("round-trips active and cancellation state for durable %s", (
    fixture,
    type,
    route,
    gateDomain,
    projectionField,
  ) => {
    const xml = readFixture(fixture);
    const reportDateTime = /<ReportDateTime>([^<]+)<\/ReportDateTime>/.exec(xml)?.[1];
    const reportTimeMs = Date.parse(reportDateTime ?? "");
    expect(Number.isFinite(reportTimeMs)).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(reportTimeMs + 5 * 60_000);

    const activeDeps = makeProcessDeps();
    const activeOutcome = processMessage(createMockWsDataMessageFromXml(xml, type), route, activeDeps);
    expect(activeOutcome).not.toBeNull();
    if (activeOutcome == null) return;
    const activeStore = new StandbyStateStore();
    activeStore.applyEvent(toPresentationEvent(activeOutcome), reportTimeMs + 5 * 60_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleq-${gateDomain}-foundation-`));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    const persist = (store: StandbyStateStore, deps: ReturnType<typeof makeProcessDeps>) => {
      const persistence = new StandbyPersistence(file, undefined, () => ({
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        vpww56: { authoritative: false, state: null, gateEntries: [] },
        tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
        volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
        floodForecast: { authoritative: false, active: [], gateEntries: [] },
        standbyDomains: {
          gateEntries: deps.revisionGate.exportDurableEntries().filter((entry) => entry.domain === gateDomain),
        },
      }));
      persistence.schedule(store.exportActiveState());
      persistence.flush();
      return new StandbyPersistence(file).load();
    };

    const activeLoaded = persist(activeStore, activeDeps);
    expect(activeLoaded).not.toBeNull();
    if (activeLoaded == null) return;
    const projection = projectionField === "nankaiTrough"
      ? activeLoaded.nankaiTrough
      : activeLoaded[projectionField]?.[0];
    expect(projection?.appliedSemanticKey).toEqual(expect.any(String));
    const activeGate = activeLoaded.telegramFoundation.standbyDomains.gateEntries
      .filter((entry) => entry.domain === gateDomain);
    expect(activeGate).toHaveLength(1);
    expect(activeGate[0].cancelled).toBe(false);

    const restartedDeps = makeProcessDeps();
    restartedDeps.revisionGate.restoreDurableEntries(activeGate);
    const restartedStore = new StandbyStateStore();
    restartedStore.restoreActiveState(activeLoaded, reportTimeMs + 5 * 60_000);
    const cancellationTime = new Date(reportTimeMs + 60_000).toISOString();
    const cancellationXml = xml
      .replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>取消</InfoType>")
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${cancellationTime}</ReportDateTime>`);
    const cancellation = processMessage(
      createMockWsDataMessageFromXml(`${cancellationXml}\n`, type),
      route,
      restartedDeps,
    );
    expect(cancellation).not.toBeNull();
    if (cancellation == null) return;
    restartedStore.applyEvent(toPresentationEvent(cancellation), reportTimeMs + 5 * 60_000);

    const cancelledLoaded = persist(restartedStore, restartedDeps);
    expect(cancelledLoaded).not.toBeNull();
    if (cancelledLoaded == null) return;
    const cancelledGate = cancelledLoaded.telegramFoundation.standbyDomains.gateEntries
      .filter((entry) => entry.domain === gateDomain);
    expect(cancelledGate).toHaveLength(1);
    expect(cancelledGate[0].cancelled).toBe(true);

    const afterRestart = makeProcessDeps();
    afterRestart.revisionGate.restoreDurableEntries(cancelledGate);
    expect(processMessage(
      withReceivedAtMs(createMockWsDataMessageFromXml(`${xml}\n\n`, type), reportTimeMs + 6 * 60_000),
      route,
      afterRestart,
    )).toBeNull();
  });

  it("does not persist a tornado projection that has not applied the latest correction semantic", () => {
    const xml = readFixture(FIXTURE_VPHW50_TOKYO);
    const correction = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
    const deps = makeProcessDeps();
    const first = processMessage(createMockWsDataMessageFromXml(xml, "VPHW50"), "tornado", deps);
    expect(first).not.toBeNull();
    if (first == null || first.domain !== "tornado") return;
    const store = new StandbyStateStore();
    store.applyEvent(toPresentationEvent(first), Date.parse(first.parsed.reportDateTime));
    expect(processMessage(createMockWsDataMessageFromXml(correction, "VPHW50"), "tornado", deps)).not.toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-standby-foundation-stale-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(file, undefined, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      vpww56: { authoritative: false, state: null, gateEntries: [] },
      tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
      volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
      floodForecast: { authoritative: false, active: [], gateEntries: [] },
      standbyDomains: {
        gateEntries: deps.revisionGate.exportDurableEntries().filter((entry) => entry.domain === "tornado"),
      },
    }));
    persistence.schedule(store.exportActiveState());
    persistence.flush();
    expect(new StandbyPersistence(file).load()?.tornado).toEqual([]);
  });

  it("drops a tokenized projection when its corresponding standby gate is missing", () => {
    const xml = readFixture(FIXTURE_VPHW50_TOKYO);
    const deps = makeProcessDeps();
    const outcome = processMessage(createMockWsDataMessageFromXml(xml, "VPHW50"), "tornado", deps);
    expect(outcome).not.toBeNull();
    if (outcome == null || outcome.domain !== "tornado") return;
    const store = new StandbyStateStore();
    store.applyEvent(toPresentationEvent(outcome), Date.parse(outcome.parsed.reportDateTime));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-standby-foundation-orphan-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(file, undefined, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      vpww56: { authoritative: false, state: null, gateEntries: [] },
      tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
      volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
      floodForecast: { authoritative: false, active: [], gateEntries: [] },
      standbyDomains: {
        gateEntries: deps.revisionGate.exportDurableEntries().filter((entry) => entry.domain === "tornado"),
      },
    }));
    persistence.schedule(store.exportActiveState());
    persistence.flush();
    const canonicalPath = standbyPersistenceV2Path(file);
    const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8")) as {
      telegramFoundation: { standbyDomains: { gateEntries: unknown[] } };
    };
    canonical.telegramFoundation.standbyDomains.gateEntries = [];
    fs.writeFileSync(canonicalPath, JSON.stringify(canonical), "utf8");
    expect(new StandbyPersistence(file).load()?.tornado).toEqual([]);
  });

  it("does not trust a tokenless legacy projection when an active gate exists", () => {
    const deps = makeProcessDeps();
    const outcome = processMessage(
      createMockWsDataMessageFromXml(readFixture(FIXTURE_VPHW50_TOKYO), "VPHW50"),
      "tornado",
      deps,
    );
    expect(outcome).not.toBeNull();
    if (outcome == null || outcome.domain !== "tornado") return;
    const store = new StandbyStateStore();
    store.applyEvent(toPresentationEvent(outcome), Date.parse(outcome.parsed.reportDateTime));
    const active = store.exportActiveState();
    expect(active.tornado?.[0]?.appliedSemanticKey).toEqual(expect.any(String));
    const tokenless = {
      ...active,
      tornado: active.tornado?.map(({ appliedSemanticKey: _ignored, ...state }) => state),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-standby-foundation-tokenless-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(file, undefined, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      vpww56: { authoritative: false, state: null, gateEntries: [] },
      tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
      volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
      floodForecast: { authoritative: false, active: [], gateEntries: [] },
      standbyDomains: {
        gateEntries: deps.revisionGate.exportDurableEntries().filter((entry) => entry.domain === "tornado"),
      },
    }));
    persistence.schedule(tokenless);
    persistence.flush();

    expect(new StandbyPersistence(file).load()?.tornado).toEqual([]);
  });

  it("applies router transport dedup and ReportDateTime diagnostics to tornado", () => {
    const notify = vi.spyOn(Notifier.prototype, "notifyTornadoAdvisory").mockImplementation(() => {});
    const diagnostic = vi.fn();
    const display: DisplayCallbacks = {
      displayOutcome: vi.fn(),
      displayRawHeader: vi.fn(),
      displayTelegramDiagnostic: diagnostic,
      displayVolcano: vi.fn(),
      displayVolcanoBatch: vi.fn(),
      getDisplayMode: () => "normal",
      renderSummaryLine: () => "summary",
    };
    const { handler } = createMessageHandler({
      display,
    });
    const xml = readFixture(FIXTURE_VPHW50_TOKYO);
    const message = createMockWsDataMessageFromXml(xml, "VPHW50");
    handler(message);
    handler(message);
    expect(notify).toHaveBeenCalledTimes(1);
    const invalid = xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>invalid</ReportDateTime>");
    handler(createMockWsDataMessageFromXml(invalid, "VPHW50"));
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("routes one accepted tornado correction to the notifier and suppresses its replay", () => {
    const notify = vi.spyOn(Notifier.prototype, "notifyTornadoAdvisory").mockImplementation(() => {});
    const display: DisplayCallbacks = {
      displayOutcome: vi.fn(),
      displayRawHeader: vi.fn(),
      displayTelegramDiagnostic: vi.fn(),
      displayVolcano: vi.fn(),
      displayVolcanoBatch: vi.fn(),
      getDisplayMode: () => "normal",
      renderSummaryLine: () => "summary",
    };
    const { handler } = createMessageHandler({ display });
    const xml = readFixture(FIXTURE_VPHW50_TOKYO);
    const correction = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
    handler(createMockWsDataMessageFromXml(xml, "VPHW50"));
    notify.mockClear();
    handler(createMockWsDataMessageFromXml(`${correction}\n`, "VPHW50"));
    handler(createMockWsDataMessageFromXml(`${correction}\n\n`, "VPHW50"));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ infoType: "訂正" }), expect.any(String));
  });

  it("passes the Code120 critical sound level through the router", () => {
    const notify = vi.spyOn(Notifier.prototype, "notifyNankaiTrough").mockImplementation(() => {});
    const display: DisplayCallbacks = {
      displayOutcome: vi.fn(),
      displayRawHeader: vi.fn(),
      displayTelegramDiagnostic: vi.fn(),
      displayVolcano: vi.fn(),
      displayVolcanoBatch: vi.fn(),
      getDisplayMode: () => "normal",
      renderSummaryLine: () => "summary",
    };
    const { handler } = createMessageHandler({ display });
    handler(createMockWsDataMessageFromXml(readFixture(FIXTURE_VYSE50_ALERT), "VYSE50"));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ infoSerial: expect.objectContaining({ code: "120" }) }),
      "critical",
    );
  });
});
