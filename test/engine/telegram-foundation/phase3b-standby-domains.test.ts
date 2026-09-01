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
  createVptaRouterOwnerToken,
  withVptaRouterOwnerToken,
} from "../../../src/engine/display/types";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
} from "../../../src/engine/display/standby-persistence";
import type { PersistedTelegramRevisionGateEntryV2 } from "../../../src/engine/messages/telegram-revision-gate";
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
  FIXTURE_VYSE50_CANCEL,
  FIXTURE_VYSE51_ADVISORY,
  FIXTURE_VPWP50_LOCAL_IDENTITY,
  readFixture,
} from "../../helpers/mock-message";
import * as log from "../../../src/logger";

const tempDirs: string[] = [];

function withReceivedAtMs(message: WsDataMessage, receivedAtMs: number): WsDataMessage {
  if (message.meta == null) throw new Error("fixture message must have TelegramMeta");
  return { ...message, meta: { ...message.meta, receivedAtMs } };
}

function processFoundationMessage(
  message: WsDataMessage,
  route: Parameters<typeof processMessage>[1],
  deps: Parameters<typeof processMessage>[2],
) {
  if (route !== "typhoonProbability") return processMessage(message, route, deps);
  const ownerToken = createVptaRouterOwnerToken();
  return withVptaRouterOwnerToken(ownerToken, () => processMessage(message, route, deps));
}

function tornadoGate(): PersistedTelegramRevisionGateEntryV2 {
  const deps = makeProcessDeps();
  const outcome = processMessage(
    createMockWsDataMessageFromXml(readFixture(FIXTURE_VPHW50_TOKYO), "VPHW50"),
    "tornado",
    deps,
  );
  if (outcome == null) throw new Error("tornado fixture was not accepted");
  const gate = deps.revisionGate.exportDurableEntries().find((entry) => entry.domain === "tornado");
  if (gate == null) throw new Error("tornado gate was not created");
  return gate;
}

function remapTornadoGate(
  entry: PersistedTelegramRevisionGateEntryV2,
  office: string,
): PersistedTelegramRevisionGateEntryV2 {
  const subject = `tornado:${office}`;
  return {
    ...structuredClone(entry),
    stateSubjectKey: subject,
    comparison: {
      ...structuredClone(entry.comparison),
      stateSubjectKey: subject,
      revision: {
        ...structuredClone(entry.comparison.revision),
        eventId: { raw: subject, value: subject, valid: true },
      },
    },
    legacyRevisionKey: subject,
    legacyRevisionKeyProvenance: "eventId",
  };
}

function saveStandbyFoundation(
  file: string,
  gateEntries: readonly PersistedTelegramRevisionGateEntryV2[],
): void {
  const persistence = new StandbyPersistence(file, 0, () => ({
    vpws50: { authoritative: true, state: null, gateEntries: [] },
    standbyDomains: { gateEntries: [...gateEntries] },
  }));
  persistence.save(new StandbyStateStore().exportActiveState());
}

function seenForStandbyGates(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): Array<{
  key: string;
  revision: { reportTimeMs: number; serial: string | null };
  forgetAtMs: number;
}> {
  return entries.flatMap((entry) => {
    const reportTimeMs = entry.comparison.revision.reportDateTime.epochMs;
    const retentionMs = entry.tombstoneRetentionMs ?? TORNADO_REVISION_FAMILY_POLICY.tombstoneRetentionMs;
    if (reportTimeMs == null || retentionMs == null) return [];
    return [{
      key: entry.legacyRevisionKey?.trim() || entry.stateSubjectKey,
      revision: { reportTimeMs, serial: entry.comparison.revision.serial.raw },
      forgetAtMs: entry.acceptedAtMs + retentionMs + 1,
    }];
  });
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
    expect(TYPHOON_PROBABILITY_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: true, maxSubjects: 256 });
    expect(NANKAI_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: true, maxSubjects: 1 });
    expect(NANKAI_INFORMATION_REVISION_FAMILY_POLICY).toMatchObject({ cancellationPolicy: "clearCurrent", durable: false, maxSubjects: 256 });
    expect(WEATHER_TIMESERIES_REVISION_FAMILY_POLICY).toMatchObject({
      cancellationPolicy: "clearCurrent",
      durable: true,
      maxSubjects: 512,
      activeRetentionMs: 7 * 24 * 60 * 60_000,
      familyCapacityMode: "rejectNewSubject",
    });
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
    const first = processFoundationMessage(createMockWsDataMessageFromXml(xml, type), route, deps);
    const semanticReplay = processFoundationMessage(
      createMockWsDataMessageFromXml(`${xml}\n`, type),
      route,
      deps,
    );
    if (route === "typhoonProbability") {
      // VPTA admission context belongs to the router-private sidecar, not ProcessOutcome.
      expect(first?.presentation.standbyStateMutationAccepted).toBeUndefined();
      expect(first?.presentation.standbyStateSubject).toBeUndefined();
      expect(first?.presentation.standbyActiveSubjects).toBeUndefined();
      expect(first?.presentation.standbyAppliedSemanticKey).toBeUndefined();
    } else {
      expect(first?.presentation.standbyStateMutationAccepted).toBe(true);
      expect(first?.presentation.standbyStateSubject).toEqual(ownsProjection ? expect.any(String) : null);
    }
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

  it("本文なし南海トラフ取消は EventID 一致時だけ current gate と badge を解除する", () => {
    const alertXml = readFixture(FIXTURE_VYSE50_ALERT);
    const cancelXml = readFixture(FIXTURE_VYSE50_CANCEL);
    const alertEventId = alertXml.match(/<EventID>([^<]+)<\/EventID>/)?.[1];
    expect(alertEventId).toBeDefined();
    if (alertEventId == null) return;
    const matchingCancel = cancelXml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${alertEventId}</EventID>`);
    const deps = makeProcessDeps();
    const store = new StandbyStateStore();
    const active = processMessage(createMockWsDataMessageFromXml(alertXml, "VYSE50"), "nankaiTrough", deps);
    expect(active).not.toBeNull();
    if (active == null) return;
    store.applyEvent(toPresentationEvent(active), Date.now());
    expect(store.snapshotItems().map((item) => item.kind)).toContain("nankaiTrough");

    const unrelated = processMessage(createMockWsDataMessageFromXml(cancelXml, "VYSE50"), "nankaiTrough", deps);
    expect(unrelated).toBeNull();
    expect(store.snapshotItems().map((item) => item.kind)).toContain("nankaiTrough");

    const matching = processMessage(createMockWsDataMessageFromXml(matchingCancel, "VYSE50"), "nankaiTrough", deps);
    expect(matching).not.toBeNull();
    if (matching == null) return;
    store.applyEvent(toPresentationEvent(matching), Date.now());
    expect(store.snapshotItems().map((item) => item.kind)).not.toContain("nankaiTrough");
  });

  it.each(["pre-provenance gate", "gate missing"] as const)(
    "旧保存状態 (%s) を復元後、本文なし取消で badge を解除する",
    (legacyMode) => {
      const alertXml = readFixture(FIXTURE_VYSE50_ALERT);
      const activeEventId = alertXml.match(/<EventID>([^<]+)<\/EventID>/)?.[1];
      const activeReportDateTime = alertXml.match(/<ReportDateTime>([^<]+)<\/ReportDateTime>/)?.[1];
      expect(activeEventId).toBeDefined();
      expect(activeReportDateTime).toBeDefined();
      if (activeEventId == null || activeReportDateTime == null) return;
      const activeReportTimeMs = Date.parse(activeReportDateTime);
      const nowMs = activeReportTimeMs + 5 * 60_000;
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);
      const activeDeps = makeProcessDeps();
      const active = processMessage(
        createMockWsDataMessageFromXml(alertXml, "VYSE50"),
        "nankaiTrough",
        activeDeps,
      );
      expect(active).not.toBeNull();
      if (active == null) return;
      const activeStore = new StandbyStateStore();
      activeStore.applyEvent(toPresentationEvent(active), nowMs);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleq-nankai-${legacyMode.replaceAll(" ", "-")}-`));
      tempDirs.push(dir);
      const file = path.join(dir, "display-active-state-v1.json");
      const persistence = new StandbyPersistence(file, 0, () => ({
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        vpww56: { authoritative: false, state: null, gateEntries: [] },
        tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
        volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
        floodForecast: { authoritative: false, active: [], gateEntries: [] },
        standbyDomains: {
          gateEntries: activeDeps.revisionGate.exportDurableEntries()
            .filter((entry) => entry.domain === "nankaiTrough"),
        },
      }));
      persistence.save(activeStore.exportActiveState());
      const v2Path = standbyPersistenceV2Path(file);
      const saved = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
        nankaiTrough: { appliedSemanticKey?: string } | null;
        telegramFoundation: { standbyDomains: { gateEntries: PersistedTelegramRevisionGateEntryV2[] } };
      };
      if (legacyMode === "pre-provenance gate") {
        const gate = saved.telegramFoundation.standbyDomains.gateEntries[0];
        expect(gate).toBeDefined();
        if (gate == null) return;
        gate.legacyRevisionKey = "nankai:current";
        delete gate.legacyRevisionKeyProvenance;
        fs.writeFileSync(v2Path, `${JSON.stringify(saved)}\n`, "utf8");
      } else {
        const legacy = JSON.parse(fs.readFileSync(file, "utf8")) as {
          nankaiTrough: { appliedSemanticKey?: string } | null;
        };
        if (legacy.nankaiTrough != null) delete legacy.nankaiTrough.appliedSemanticKey;
        fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, "utf8");
        fs.rmSync(v2Path);
      }

      const loaded = new StandbyPersistence(file).load();
      expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([
        expect.objectContaining({
          legacyRevisionKey: activeEventId,
          legacyRevisionKeyProvenance: "eventId",
        }),
      ]);
      if (loaded == null) return;
      const restartedDeps = makeProcessDeps();
      restartedDeps.revisionGate.restoreDurableEntries(
        loaded.telegramFoundation.standbyDomains.gateEntries,
      );
      const restartedStore = new StandbyStateStore();
      restartedStore.restoreActiveState(loaded, nowMs);
      expect(restartedStore.snapshotItems().map((item) => item.kind)).toContain("nankaiTrough");

      const cancelXml = readFixture(FIXTURE_VYSE50_CANCEL)
        .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${activeEventId}</EventID>`)
        .replace(
          /<ReportDateTime>[^<]*<\/ReportDateTime>/,
          `<ReportDateTime>${new Date(activeReportTimeMs + 60_000).toISOString()}</ReportDateTime>`,
        );
      const cancellation = processMessage(
        createMockWsDataMessageFromXml(cancelXml, "VYSE50"),
        "nankaiTrough",
        restartedDeps,
      );
      expect(cancellation).not.toBeNull();
      if (cancellation == null) return;
      restartedStore.applyEvent(toPresentationEvent(cancellation), nowMs);
      expect(restartedStore.snapshotItems().map((item) => item.kind)).not.toContain("nankaiTrough");
    },
  );

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
    [FIXTURE_VPWP50_NAGANO, "VPWP50", "weatherWarningTimeseries", 7 * 24 * 60 * 60_000],
  ] as const)("keeps %s watermarks for the declared retention TTL", (fixture, type, route, retentionMs) => {
    const message = createMockWsDataMessageFromXml(readFixture(fixture), type);
    const receivedAtMs = message.meta?.receivedAtMs;
    expect(receivedAtMs).toEqual(expect.any(Number));
    if (receivedAtMs == null) return;
    const deps = makeProcessDeps();
    expect(processFoundationMessage(withReceivedAtMs(message, receivedAtMs), route, deps)).not.toBeNull();
    expect(processFoundationMessage(
      withReceivedAtMs(message, receivedAtMs + 12 * 60_000),
      route,
      deps,
    )).toBeNull();
    expect(processFoundationMessage(
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

  it("runs a real VPWP50 through admission, projection, dual persistence, correction, and cancellation", () => {
    const nowMs = Date.parse("2026-06-06T00:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({
      activeWeatherWarningForecastSubjects: (atMs) =>
        store.activeWeatherWarningForecastSubjects(atMs),
      maintainWeatherWarningForecastSubjects: (atMs, subjects) =>
        store.maintainWeatherWarningForecastSubjects(atMs, subjects),
    });
    const xml = readFixture(FIXTURE_VPWP50_LOCAL_IDENTITY);
    const issue = processMessage(
      withReceivedAtMs(createMockWsDataMessageFromXml(xml, "VPWP50"), nowMs),
      "weatherWarningTimeseries",
      deps,
    );
    expect(issue?.domain).toBe("weatherWarningTimeseries");
    expect(issue?.presentation).toMatchObject({
      standbyStateMutationAccepted: true,
      standbyStateSubject: "weatherTimeseries:長野地方気象台:code:200000",
    });
    if (issue == null) return;
    expect(store.applyEvent(toPresentationEvent(issue), nowMs)).toEqual({
      viewChanged: true,
      durableChanged: true,
    });
    expect(store.snapshotItems()).toEqual([
      expect.objectContaining({
        kind: "weatherWarningForecast",
        key: "weatherWarningForecast:active",
        restored: false,
      }),
    ]);

    const correctionXml = xml.replace(
      /<InfoType>[^<]*<\/InfoType>/,
      "<InfoType>訂正</InfoType>",
    );
    const correction = processMessage(
      withReceivedAtMs(createMockWsDataMessageFromXml(correctionXml, "VPWP50"), nowMs + 1),
      "weatherWarningTimeseries",
      deps,
    );
    expect(correction?.presentation.acceptedCorrection).toBe(true);
    if (correction == null) return;
    expect(store.applyEvent(toPresentationEvent(correction), nowMs + 1).durableChanged).toBe(true);
    expect(processMessage(
      withReceivedAtMs(createMockWsDataMessageFromXml(`${correctionXml}\n`, "VPWP50"), nowMs + 2),
      "weatherWarningTimeseries",
      deps,
    )).toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-vpwp50-foundation-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(file, undefined, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      vpww56: { authoritative: false, state: null, gateEntries: [] },
      tsunami: { active: null, observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
      volcano: { authoritative: false, state: null, active: [], gateEntries: [] },
      floodForecast: { authoritative: false, active: [], gateEntries: [] },
      standbyDomains: {
        gateEntries: deps.revisionGate.exportDurableEntries()
          .filter((entry) => entry.domain === "weatherWarningTimeseries"),
      },
    }));
    persistence.schedule(store.exportActiveState());
    persistence.flush();
    const v1 = JSON.parse(fs.readFileSync(file, "utf8")) as {
      weatherWarningForecasts?: unknown[];
      weatherWarningForecastGateMetadata?: unknown[];
      seen: Array<{ key: string }>;
    };
    expect(v1.weatherWarningForecasts).toHaveLength(1);
    expect(v1.weatherWarningForecastGateMetadata).toHaveLength(1);
    expect(v1.seen).toContainEqual(expect.objectContaining({
      key: "weatherTimeseries:長野地方気象台:code:200000",
    }));
    const loaded = new StandbyPersistence(file).load();
    expect(loaded?.weatherWarningForecasts).toHaveLength(1);
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toHaveLength(1);
    if (loaded == null) return;
    const restartedStore = new StandbyStateStore();
    restartedStore.restoreActiveState(loaded, nowMs + 10);
    expect(restartedStore.snapshotItems()).toEqual([
      expect.objectContaining({ kind: "weatherWarningForecast", restored: true }),
    ]);
    const restartedDeps = makeProcessDeps({
      activeWeatherWarningForecastSubjects: (atMs) =>
        restartedStore.activeWeatherWarningForecastSubjects(atMs),
      maintainWeatherWarningForecastSubjects: (atMs, subjects) =>
        restartedStore.maintainWeatherWarningForecastSubjects(atMs, subjects),
    });
    restartedDeps.revisionGate.restoreDurableEntries(
      loaded.telegramFoundation.standbyDomains.gateEntries,
    );

    const cancellationXml = xml
      .replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>取消</InfoType>")
      .replace(/<Serial>[^<]*<\/Serial>/, "<Serial>02</Serial>")
      .replace(
        /<ReportDateTime>[^<]*<\/ReportDateTime>/,
        "<ReportDateTime>2026-06-06T08:56:00+09:00</ReportDateTime>",
      );
    const cancellation = processMessage(
      withReceivedAtMs(createMockWsDataMessageFromXml(cancellationXml, "VPWP50"), nowMs + 20),
      "weatherWarningTimeseries",
      restartedDeps,
    );
    expect(cancellation?.presentation.standbyStateMutationAccepted).toBe(true);
    if (cancellation == null) return;
    expect(restartedStore.applyEvent(toPresentationEvent(cancellation), nowMs + 20))
      .toEqual({ viewChanged: true, durableChanged: true });
    expect(restartedStore.snapshotItems()).toEqual([]);
    expect(processMessage(
      withReceivedAtMs(createMockWsDataMessageFromXml(xml, "VPWP50"), nowMs + 21),
      "weatherWarningTimeseries",
      restartedDeps,
    )).toBeNull();
  });

  it("standbyDomains は malformed subject だけを落とし、正常 gate と warn token を保つ", () => {
    const seed = remapTornadoGate(tornadoGate(), "office-a");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-standby-domains-malformed-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    saveStandbyFoundation(file, [seed]);
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: { standbyDomains: { gateEntries: unknown[] } };
    };
    raw.telegramFoundation.standbyDomains.gateEntries.push({ stateSubjectKey: "tornado:broken" });
    fs.writeFileSync(v2Path, `${JSON.stringify(raw)}\n`, "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(file).load();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tornado:office-a" }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[standby-persistence] salvage source=display-active-state-v2.json domain=foundation.standbyDomains unit=subject discarded=1 retained=1 reason=invalid-entry",
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("standbyDomains の重複 subject は競合 bundle だけを落とし、別 subject を保つ", () => {
    const seed = tornadoGate();
    const first = remapTornadoGate(seed, "office-a");
    const second = remapTornadoGate(seed, "office-b");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-standby-domains-duplicate-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    saveStandbyFoundation(file, [first, second]);
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: { standbyDomains: { gateEntries: PersistedTelegramRevisionGateEntryV2[] } };
    };
    raw.telegramFoundation.standbyDomains.gateEntries.push(structuredClone(first));
    fs.writeFileSync(v2Path, `${JSON.stringify(raw)}\n`, "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(file).load();
    expect(loaded?.telegramFoundation.standbyDomains.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tornado:office-b" }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[standby-persistence] salvage source=display-active-state-v2.json domain=foundation.standbyDomains unit=subject discarded=2 retained=1 reason=duplicate-subject",
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("standbyDomains は family policy の上限超過を末尾保持し limit-exceeded を記録する", () => {
    const seed = tornadoGate();
    const initial = Array.from({ length: TORNADO_REVISION_FAMILY_POLICY.maxSubjects! }, (_, index) =>
      remapTornadoGate(seed, `office-${String(index).padStart(3, "0")}`));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-standby-domains-limit-"));
    tempDirs.push(dir);
    const file = path.join(dir, "display-active-state-v1.json");
    saveStandbyFoundation(file, initial);
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      version: 2;
      seen: Array<{ key: string; revision: { reportTimeMs: number; serial: string | null }; forgetAtMs: number }>;
      telegramFoundation: { standbyDomains: { gateEntries: PersistedTelegramRevisionGateEntryV2[] } };
    };
    const extra = remapTornadoGate(seed, "office-128");
    raw.telegramFoundation.standbyDomains.gateEntries.push(extra);
    const retained = raw.telegramFoundation.standbyDomains.gateEntries.slice(-TORNADO_REVISION_FAMILY_POLICY.maxSubjects!);
    raw.seen = seenForStandbyGates(retained);
    fs.writeFileSync(v2Path, `${JSON.stringify(raw)}\n`, "utf8");
    const legacy = structuredClone(raw) as unknown as Record<string, unknown>;
    delete legacy.telegramFoundation;
    legacy.version = 1;
    fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const loaded = new StandbyPersistence(file).load();
    const gates = loaded?.telegramFoundation.standbyDomains.gateEntries ?? [];
    expect(gates).toHaveLength(TORNADO_REVISION_FAMILY_POLICY.maxSubjects!);
    expect(gates[0]?.stateSubjectKey).toBe("tornado:office-001");
    expect(gates.at(-1)?.stateSubjectKey).toBe("tornado:office-128");
    expect(warn).toHaveBeenCalledWith(
      "[standby-persistence] salvage source=display-active-state-v2.json domain=foundation.standbyDomains unit=subject discarded=1 retained=128 reason=limit-exceeded",
    );
    expect(warn).toHaveBeenCalledTimes(1);
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
