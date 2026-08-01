import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
  type PersistedStandbyStateV1,
} from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { SWEEP_INTERVAL_MS } from "../../../src/engine/display/constants";
import {
  FLOOD_FORECAST_MAX_SUBJECTS,
  FLOOD_FORECAST_RETENTION_MS,
  FLOOD_FORECAST_REVISION_FAMILY_POLICY,
} from "../../../src/engine/messages/revision-family-registry";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { sweepFloodForecastFoundation } from "../../../src/engine/messages/flood-forecast-lifecycle";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { Notifier } from "../../../src/engine/notification/notifier";
import { processFloodForecast } from "../../../src/engine/presentation/processors/process-flood-forecast";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { makeProcessDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VXKO50_16_02_01,
  FIXTURE_VXKO50_16_05_01,
  FIXTURE_VXSU50_91_01_01,
  readFixture,
} from "../../helpers/mock-message";

const T1 = "2026-07-30T10:00:00+09:00";
const T2 = "2026-07-30T11:00:00+09:00";
const T3 = "2026-07-30T12:00:00+09:00";
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-flood-foundation-"));
  dirs.push(dir);
  return path.join(dir, "display-active-state-v1.json");
}

function message(reportDateTime: string, serial: string, infoType = "発表", eventId = "flood-1") {
  const xml = readFixture(FIXTURE_VXKO50_16_02_01)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${reportDateTime}</ReportDateTime>`)
    .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, `<Serial>${serial}</Serial>`)
    .replace(/<InfoType>[^<]*<\/InfoType>/, `<InfoType>${infoType}</InfoType>`)
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
  return createMockWsDataMessageFromXml(xml, "VXKO50");
}

function observeOnlyMessage(reportDateTime: string, serial: string, eventId: string) {
  const xml = readFixture(FIXTURE_VXKO50_16_05_01)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${reportDateTime}</ReportDateTime>`)
    .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, `<Serial>${serial}</Serial>`)
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
    .replaceAll("<Code>30</Code>", "<Code>99</Code>");
  return createMockWsDataMessageFromXml(
    xml,
    "VXKO50",
  );
}

function unknownStationMessage(reportDateTime: string, serial: string, eventId: string) {
  const xml = readFixture(FIXTURE_VXKO50_16_02_01)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${reportDateTime}</ReportDateTime>`)
    .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, `<Serial>${serial}</Serial>`)
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
    .replaceAll("<Code>30</Code>", "<Code>99</Code>")
    .replace(
      /(<jmx_eb:WaterLevel type="レベル"[^>]*>)[^<]*(<\/jmx_eb:WaterLevel>)/gu,
      "$1" + "9" + "$2",
    );
  return createMockWsDataMessageFromXml(xml, "VXKO50");
}

function legacyState(store: StandbyStateStore): PersistedStandbyStateV1 {
  return { ...store.exportActiveState(), version: 1 };
}

function removeFloodGateSerial(file: string): void {
  const v2Path = standbyPersistenceV2Path(file);
  const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
    telegramFoundation: {
      floodForecast: {
        gateEntries: Array<{
          comparison: { revision: { serial: { raw: string | null; numeric: number | null; valid: boolean } } };
        }>;
      };
    };
  };
  const serial = raw.telegramFoundation.floodForecast.gateEntries[0]?.comparison.revision.serial;
  expect(serial).toBeDefined();
  if (serial == null) return;
  serial.raw = null;
  serial.numeric = null;
  serial.valid = false;
  fs.writeFileSync(v2Path, `${JSON.stringify(raw)}\n`, "utf8");
}

describe("Phase 3B flood common registry", () => {
  it("uses an EventID subject, finite 36-hour retention, and a bounded family", () => {
    const result = processFloodForecast(message(T1, "1"), makeProcessDeps());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(FLOOD_FORECAST_REVISION_FAMILY_POLICY).toMatchObject({
      cancellationPolicy: "clearCurrent",
      durable: true,
      tombstoneRetentionMs: FLOOD_FORECAST_RETENTION_MS,
      maxSubjects: FLOOD_FORECAST_MAX_SUBJECTS,
    });
    expect(FLOOD_FORECAST_REVISION_FAMILY_POLICY.extractStateSubjectKey(
      message(T1, "1").meta!,
      result.outcome.parsed,
    )).toBe("flood:event:flood-1");
  });

  it("real VXKO passes the gate; cancel rejects delayed reports but accepts a newer lifecycle", () => {
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const deps = makeProcessDeps({ revisionGate: gate, floodForecastState: holder });
    const first = processFloodForecast(message(T1, "1"), deps, Date.parse(T1));
    expect(first.kind).toBe("ok");
    expect(holder.activeEventIds()).toEqual(["flood-1"]);

    const cancel = processFloodForecast(message(T2, "2", "取消"), deps, Date.parse(T2));
    expect(cancel.kind).toBe("ok");
    expect(holder.activeEventIds()).toEqual([]);
    expect(processFloodForecast(message(T1, "1"), deps, Date.parse(T2) + 1).kind)
      .toBe("suppressed");
    expect(processFloodForecast(message(T3, "3"), deps, Date.parse(T3)).kind).toBe("ok");
    expect(holder.activeEventIds()).toEqual(["flood-1"]);
  });

  it("does not reactivate a cancelled flood subject with an equal-revision correction", () => {
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const deps = makeProcessDeps({ revisionGate: gate, floodForecastState: holder });
    expect(processFloodForecast(message(T1, "1"), deps, Date.parse(T1)).kind).toBe("ok");
    expect(processFloodForecast(message(T2, "2", "取消"), deps, Date.parse(T2)).kind).toBe("ok");
    expect(processFloodForecast(message(T2, "2", "訂正"), deps, Date.parse(T2) + 1).kind)
      .toBe("suppressed");
    expect(holder.activeEventIds()).toEqual([]);
    expect(gate.exportDurableEntries()[0]?.cancelled).toBe(true);
  });

  it("keeps all-unknown station reports observe-only instead of creating a tombstone", () => {
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({ revisionGate: gate, floodForecastState: holder });
    const first = processFloodForecast(message(T1, "1", "発表", "unknown-level"), deps, Date.parse(T1));
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(first.outcome), Date.parse(T1));

    const unknown = processFloodForecast(
      unknownStationMessage(T2, "2", "unknown-level"),
      deps,
      Date.parse(T2),
    );
    expect(unknown.kind).toBe("ok");
    if (unknown.kind !== "ok") return;
    expect(unknown.outcome.parsed.rawStations.length).toBeGreaterThan(0);
    expect(unknown.outcome.parsed.rawStations.every((station) =>
      station.stationObservedLevel === "unknown" && station.headlineLevel === "unknown"))
      .toBe(true);
    expect(store.applyEvent(toPresentationEvent(unknown.outcome), Date.parse(T2)))
      .toEqual({ viewChanged: false, durableChanged: true });
    expect(holder.activeEventIds()).toEqual(["unknown-level"]);
    expect(gate.exportDurableEntries()[0]?.cancelled).toBe(false);
    expect(store.snapshotItems().some((item) => item.kind === "flood")).toBe(true);
  });

  it("real VXSU creates a durable lifecycle watermark but never station digest state", () => {
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const result = processFloodForecast(
      createMockWsDataMessageFromXml(readFixture(FIXTURE_VXSU50_91_01_01), "VXSU50"),
      makeProcessDeps({ revisionGate: gate, floodForecastState: holder }),
    );
    expect(result.kind).toBe("ok");
    expect(holder.activeEventIds()).toEqual([]);
    expect(gate.exportDurableEntries()).toEqual([
      expect.objectContaining({ domain: "floodForecast", revisionFamily: "floodForecast" }),
    ]);
  });

  it("keeps unrelated legacy EventIDs until each is canonicalized or expires", () => {
    const seedStore = new StandbyStateStore();
    const seedDeps = makeProcessDeps();
    for (const eventId of ["legacy-a", "legacy-b"]) {
      const seeded = processFloodForecast(message(T1, "1", "発表", eventId), seedDeps, Date.parse(T1));
      expect(seeded.kind).toBe("ok");
      if (seeded.kind === "ok") seedStore.applyEvent(toPresentationEvent(seeded.outcome), Date.parse(T1));
    }
    const file = tempPath();
    fs.writeFileSync(file, `${JSON.stringify(legacyState(seedStore))}\n`, "utf8");
    const migrated = new StandbyPersistence(file, 0).load()!;
    expect(migrated.telegramFoundation.floodForecast.authoritative).toBe(false);

    const store = new StandbyStateStore();
    store.restoreActiveState(migrated, Date.parse(T1) + 1);
    expect(store.floodLegacyEventIds().sort()).toEqual(["legacy-a", "legacy-b"]);
    const gate = new TelegramRevisionGate();
    const accepted = processFloodForecast(
      message(T2, "2", "発表", "legacy-a"),
      makeProcessDeps({ revisionGate: gate }),
      Date.parse(T2),
    );
    expect(accepted.kind).toBe("ok");
    if (accepted.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(accepted.outcome), Date.parse(T2));
    expect(store.snapshotItems().find((item) => item.kind === "flood")?.sourceEventIds.sort())
      .toEqual(["legacy-a", "legacy-b"]);
    expect(store.floodLegacyEventIds()).toEqual(["legacy-b"]);

    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: store.exportActiveState().floods?.events ?? [],
        legacyEventIds: store.floodLegacyEventIds(),
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(store));
    const loaded = persistence.load()!;
    expect(persistence.takeMigrationConflictCount()).toBe(0);
    expect(loaded.telegramFoundation.floodForecast.legacyEventIds).toEqual(["legacy-b"]);
    const restarted = new StandbyStateStore();
    restarted.restoreCanonicalFloods(
      loaded.telegramFoundation.floodForecast.active,
      Date.parse(T2),
      loaded.telegramFoundation.floodForecast.legacyEventIds,
    );
    expect(restarted.snapshotItems().find((item) => item.kind === "flood")?.sourceEventIds.sort())
      .toEqual(["legacy-a", "legacy-b"]);
    restarted.sweep(Date.parse(T1) + 12 * 60 * 60_000);
    expect(restarted.floodLegacyEventIds()).toEqual([]);
    expect(restarted.snapshotItems().find((item) => item.kind === "flood")?.sourceEventIds)
      .toEqual(["legacy-a"]);
  });

  it("treats top-level events from pre-flood v2 as independent legacy projections", () => {
    const seedStore = new StandbyStateStore();
    const seedDeps = makeProcessDeps();
    for (const eventId of ["old-v2-a", "old-v2-b"]) {
      const seeded = processFloodForecast(message(T1, "1", "発表", eventId), seedDeps, Date.parse(T1));
      expect(seeded.kind).toBe("ok");
      if (seeded.kind === "ok") seedStore.applyEvent(toPresentationEvent(seeded.outcome), Date.parse(T1));
    }
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0);
    persistence.save(legacyState(seedStore));
    const v2Path = standbyPersistenceV2Path(file);
    const oldV2 = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: Record<string, unknown>;
    };
    delete oldV2.telegramFoundation.floodForecast;
    fs.writeFileSync(v2Path, `${JSON.stringify(oldV2)}\n`, "utf8");

    const migrated = persistence.load()!;
    const store = new StandbyStateStore();
    store.restoreActiveState(migrated, Date.parse(T1) + 1);
    const accepted = processFloodForecast(
      message(T2, "2", "発表", "old-v2-a"),
      makeProcessDeps(),
      Date.parse(T2),
    );
    expect(accepted.kind).toBe("ok");
    if (accepted.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(accepted.outcome), Date.parse(T2));
    expect(store.snapshotItems().find((item) => item.kind === "flood")?.sourceEventIds.sort())
      .toEqual(["old-v2-a", "old-v2-b"]);
    expect(store.floodLegacyEventIds()).toEqual(["old-v2-b"]);
  });

  it("caps 513 live legacy v1 projections by revision after excluding expiry", () => {
    const seedStore = new StandbyStateStore();
    const seeded = processFloodForecast(message(T1, "1", "発表", "template"), makeProcessDeps(), Date.parse(T1));
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") return;
    seedStore.applyEvent(toPresentationEvent(seeded.outcome), Date.parse(T1));
    const template = seedStore.exportActiveState().floods?.events[0];
    expect(template).toBeDefined();
    if (template == null) return;
    const { appliedRevision: _appliedRevision, ...legacyTemplate } = template;
    const events = Array.from({ length: 513 }, (_, index) => ({
      ...structuredClone(legacyTemplate),
      eventId: `legacy-${String(index).padStart(3, "0")}`,
      revision: {
        reportTimeMs: legacyTemplate.revision.reportTimeMs + index,
        serial: String(index + 1),
      },
      expiresAtMs: legacyTemplate.expiresAtMs + index,
    }));
    events[0] = {
      ...events[0]!,
      revision: {
        reportTimeMs: legacyTemplate.revision.reportTimeMs + 10_000,
        serial: "10000",
      },
    };
    events.push({
      ...structuredClone(events[0]!),
      eventId: "legacy-expired",
      revision: {
        reportTimeMs: legacyTemplate.revision.reportTimeMs + 20_000,
        serial: "20000",
      },
      expiresAtMs: Date.parse(T1),
    });
    const file = tempPath();
    fs.writeFileSync(file, `${JSON.stringify({
      ...legacyState(seedStore),
      floods: { events, seen: [] },
    })}\n`, "utf8");

    const loaded = new StandbyPersistence(file, 0).load()!;
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, Date.parse(T1) + 1);
    expect(restored.floodLegacyEventIds()).toHaveLength(FLOOD_FORECAST_MAX_SUBJECTS);
    const restoredIds = restored.snapshotItems()
      .find((item) => item.kind === "flood")?.sourceEventIds ?? [];
    expect(restoredIds).not.toContain("legacy-expired");
    expect(restoredIds).not.toContain("legacy-001");
    expect(restoredIds).toContain("legacy-000");
    expect(restoredIds).toContain("legacy-512");
  });

  it("rejects a normal T2 gate paired with a projection only applied through T1", () => {
    const gate = new TelegramRevisionGate();
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({ revisionGate: gate });
    const first = processFloodForecast(message(T1, "1", "発表", "normal-lag"), deps, Date.parse(T1));
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(first.outcome), Date.parse(T1));

    expect(processFloodForecast(
      message(T2, "2", "発表", "normal-lag"),
      deps,
      Date.parse(T2),
    ).kind).toBe("ok");
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: store.exportActiveState().floods?.events ?? [],
        legacyEventIds: [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(store));

    expect(persistence.load()!.telegramFoundation.floodForecast.active).toEqual([]);
  });

  it("requires the accepted correction semantic key before persisting an equal-revision projection", () => {
    const gate = new TelegramRevisionGate();
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({ revisionGate: gate });
    const first = processFloodForecast(message(T1, "1", "発表", "semantic-lag"), deps, Date.parse(T1));
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(first.outcome), Date.parse(T1));

    const correction = processFloodForecast(
      message(T1, "1", "訂正", "semantic-lag"),
      deps,
      Date.parse(T1) + 1,
    );
    expect(correction.kind).toBe("ok");
    if (correction.kind !== "ok") return;

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: store.exportActiveState().floods?.events ?? [],
        legacyEventIds: [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(store));
    expect(persistence.load()!.telegramFoundation.floodForecast.active).toEqual([]);

    expect(store.applyEvent(toPresentationEvent(correction.outcome), Date.parse(T1) + 1))
      .toEqual({ viewChanged: false, durableChanged: true });
    persistence.save(legacyState(store));
    const restored = persistence.load()!.telegramFoundation.floodForecast.active;
    expect(restored).toHaveLength(1);
    expect(restored[0]?.appliedSemanticKey).toMatch(/^訂正:/u);
  });

  it("salvages a separate tombstone when a tokenless old-v2 active projection cannot prove correction coupling", () => {
    const gate = new TelegramRevisionGate();
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({ revisionGate: gate });
    for (const eventId of ["uncertain-active", "cancelled-other"]) {
      const accepted = processFloodForecast(
        message(T1, "1", "発表", eventId),
        deps,
        Date.parse(T1),
      );
      expect(accepted.kind).toBe("ok");
      if (accepted.kind === "ok") {
        store.applyEvent(toPresentationEvent(accepted.outcome), Date.parse(T1));
      }
    }
    const cancellation = processFloodForecast(
      message(T2, "2", "取消", "cancelled-other"),
      deps,
      Date.parse(T2),
    );
    expect(cancellation.kind).toBe("ok");
    if (cancellation.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(cancellation.outcome), Date.parse(T2));

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: store.exportActiveState().floods?.events ?? [],
        legacyEventIds: [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(store));

    const v2Path = standbyPersistenceV2Path(file);
    const oldV2 = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: {
        floodForecast: {
          active: Array<{ eventId: string; appliedSemanticKey?: string }>;
          gateEntries: Array<{
            stateSubjectKey: string;
            semanticKeys: string[];
            cancelled: boolean;
            comparison: {
              revision: {
                infoType: { raw: string | null; value: string | null; valid: boolean };
              };
            };
          }>;
        };
      };
    };
    const uncertainProjection = oldV2.telegramFoundation.floodForecast.active
      .find((event) => event.eventId === "uncertain-active");
    const uncertainGate = oldV2.telegramFoundation.floodForecast.gateEntries
      .find((entry) => entry.stateSubjectKey === "flood:event:uncertain-active");
    expect(uncertainProjection).toBeDefined();
    expect(uncertainGate).toBeDefined();
    if (uncertainProjection == null || uncertainGate == null) return;
    delete uncertainProjection.appliedSemanticKey;
    uncertainGate.semanticKeys.push(`訂正:${"a".repeat(64)}`);
    uncertainGate.comparison.revision.infoType = { raw: "訂正", value: "訂正", valid: true };
    fs.writeFileSync(v2Path, `${JSON.stringify(oldV2)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.floodForecast;
    expect(loaded.authoritative).toBe(true);
    expect(loaded.active).toEqual([]);
    expect(loaded.gateEntries).toHaveLength(2);
    expect(loaded.gateEntries.find((entry) =>
      entry.stateSubjectKey === "flood:event:cancelled-other")?.cancelled).toBe(true);

    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(loaded.gateEntries);
    expect(processFloodForecast(
      message(T1, "1", "発表", "cancelled-other"),
      makeProcessDeps({ revisionGate: restartedGate }),
      Date.parse(T2) + 1,
    ).kind).toBe("suppressed");
  });

  it("rejects missing applied serial and content newer than the applied gate revision", () => {
    const gate = new TelegramRevisionGate();
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({ revisionGate: gate });
    const first = processFloodForecast(message(T1, "1", "発表", "strict-revision"), deps, Date.parse(T1));
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(first.outcome), Date.parse(T1));
    expect(processFloodForecast(
      message(T2, "2", "発表", "strict-revision"),
      deps,
      Date.parse(T2),
    ).kind).toBe("ok");
    const template = store.exportActiveState().floods?.events[0];
    expect(template).toBeDefined();
    if (template == null) return;
    const gateEntries = gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast");
    const appliedSemanticKey = gateEntries[0]?.semanticKeys.at(-1);
    expect(appliedSemanticKey).toBeDefined();
    const saveActive = (active: Array<typeof template>) => {
      const file = tempPath();
      const persistence = new StandbyPersistence(file, 0, () => ({
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        floodForecast: {
          authoritative: true,
          active: active.map((event) => ({ ...event, appliedSemanticKey })),
          legacyEventIds: [],
          gateEntries,
        },
      }));
      persistence.save(legacyState(store));
      return persistence.load()!.telegramFoundation.floodForecast.active;
    };

    expect(saveActive([{
      ...structuredClone(template),
      appliedRevision: { reportTimeMs: Date.parse(T2), serial: null },
    }])).toEqual([]);
    expect(saveActive([{
      ...structuredClone(template),
      appliedRevision: { reportTimeMs: Date.parse(T2), serial: "02" },
    }])).toHaveLength(1);
    expect(saveActive([{
      ...structuredClone(template),
      revision: { reportTimeMs: Date.parse(T3), serial: "3" },
      appliedRevision: { reportTimeMs: Date.parse(T2), serial: "2" },
    }])).toEqual([]);
  });

  it("round-trips a lagging projection after an accepted observeOnly report", () => {
    const gate = new TelegramRevisionGate();
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({ revisionGate: gate });
    const first = processFloodForecast(message(T1, "1", "発表", "observed"), deps, Date.parse(T1));
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(first.outcome), Date.parse(T1));

    const observation = processFloodForecast(
      observeOnlyMessage(T2, "2", "observed"),
      deps,
      Date.parse(T2),
    );
    expect(observation.kind).toBe("ok");
    if (observation.kind !== "ok") return;
    expect(observation.outcome.parsed.rawStations).toEqual([]);
    expect(store.applyEvent(toPresentationEvent(observation.outcome), Date.parse(T2)))
      .toEqual({ viewChanged: false, durableChanged: true });

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: store.exportActiveState().floods?.events ?? [],
        legacyEventIds: [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(store));
    const loaded = persistence.load()!;
    expect(persistence.takeMigrationConflictCount()).toBe(0);
    expect(loaded.telegramFoundation.floodForecast.active[0]?.revision.reportTimeMs)
      .toBe(Date.parse(T1));
    expect(loaded.telegramFoundation.floodForecast.active[0]?.appliedRevision?.reportTimeMs)
      .toBe(Date.parse(T2));
    const restarted = new StandbyStateStore();
    restarted.restoreCanonicalFloods(
      loaded.telegramFoundation.floodForecast.active,
      Date.parse(T2),
      loaded.telegramFoundation.floodForecast.legacyEventIds,
    );
    expect(restarted.snapshotItems().some((item) => item.kind === "flood")).toBe(true);
  });

  it("display-on hub sweep expires the flood gate and holder after 36 hours", () => {
    vi.useFakeTimers();
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const standby = new StandbyStateStore();
    const incoming = message(T1, "1", "発表", "expiring");
    const acceptedAtMs = incoming.meta!.receivedAtMs;
    const accepted = processFloodForecast(
      incoming,
      makeProcessDeps({ revisionGate: gate, floodForecastState: holder }),
      acceptedAtMs,
    );
    expect(accepted.kind).toBe("ok");
    if (accepted.kind !== "ok") return;
    standby.applyEvent(toPresentationEvent(accepted.outcome), Date.parse(T1));

    let nowMs = acceptedAtMs;
    const hub = new InfoDisplayHub(new DisplayStateStore(() => standby.snapshotItems()), {
      summarize: () => "summary",
      weatherAlerts: () => [],
      now: () => nowMs,
      standbySweep: (sweepAt) => {
        const storeMutation = standby.sweep(sweepAt);
        const foundationMutation = sweepFloodForecastFoundation(gate, holder, standby, sweepAt);
        return {
          viewChanged: storeMutation.viewChanged || foundationMutation.viewChanged,
          durableChanged: storeMutation.durableChanged || foundationMutation.durableChanged,
        };
      },
    });
    hub.startTimers();
    nowMs = acceptedAtMs + FLOOD_FORECAST_RETENTION_MS + 1;
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(gate.activeRevisionFamilySubjects("floodForecast", "floodForecast")).toEqual([]);
    expect(holder.activeEventIds()).toEqual([]);
    hub.stop();
  });

  it("missing EventID is display-only and cannot mutate standby projection", () => {
    const result = processFloodForecast(message(T1, "1", "発表", ""), makeProcessDeps());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.presentation).toMatchObject({
      floodStateMutationAccepted: false,
      suppressNotify: true,
    });
    const store = new StandbyStateStore();
    expect(store.applyEvent(toPresentationEvent(result.outcome), Date.parse(T1)))
      .toEqual({ viewChanged: false, durableChanged: false });
  });

  it("round-trips active projection and tombstone, and dual-writes genuine v1 seen", () => {
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const store = new StandbyStateStore();
    const deps = makeProcessDeps({ revisionGate: gate, floodForecastState: holder });
    const accepted = processFloodForecast(message(T1, "1"), deps, Date.parse(T1));
    expect(accepted.kind).toBe("ok");
    if (accepted.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(accepted.outcome), Date.parse(T1));

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: store.exportActiveState().floods?.events ?? [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(store));
    const v1 = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedStandbyStateV1;
    expect(v1.version).toBe(1);
    expect(v1.floods?.seen).toEqual([expect.objectContaining({ key: "flood-1" })]);
    expect(JSON.parse(fs.readFileSync(standbyPersistenceV2Path(file), "utf8")))
      .toMatchObject({ telegramFoundation: { floodForecast: { authoritative: true } } });

    const loaded = persistence.load()!;
    const restoredGate = new TelegramRevisionGate();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.floodForecast.gateEntries);
    const restoredStore = new StandbyStateStore();
    restoredStore.restoreCanonicalFloods(loaded.telegramFoundation.floodForecast.active, Date.parse(T1));
    expect(restoredStore.snapshotItems().some((item) => item.kind === "flood")).toBe(true);

    const restoredDeps = makeProcessDeps({ revisionGate: restoredGate });
    expect(processFloodForecast(message(T2, "2", "取消"), restoredDeps, Date.parse(T2)).kind).toBe("ok");
    const emptyStore = new StandbyStateStore();
    const cancelledPersistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: [],
        gateEntries: restoredGate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    cancelledPersistence.save(legacyState(emptyStore));
    const cancelled = cancelledPersistence.load()!;
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(cancelled.telegramFoundation.floodForecast.gateEntries);
    expect(processFloodForecast(message(T1, "1"), makeProcessDeps({ revisionGate: restartedGate }), Date.parse(T2) + 1).kind)
      .toBe("suppressed");
  });

  it("rejects a tombstone-only flood gate entry with a missing serial", () => {
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ revisionGate: gate });
    expect(processFloodForecast(message(T1, "1"), deps, Date.parse(T1)).kind).toBe("ok");
    expect(processFloodForecast(message(T2, "2", "取消"), deps, Date.parse(T2)).kind).toBe("ok");
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: [],
        legacyEventIds: [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(new StandbyStateStore()));
    removeFloodGateSerial(file);

    expect(persistence.load()!.telegramFoundation.floodForecast).toEqual({
      authoritative: false,
      active: [],
      gateEntries: [],
    });
  });

  it("rejects a non-cancelled gate-only flood entry with a missing serial", () => {
    const gate = new TelegramRevisionGate();
    expect(processFloodForecast(
      message(T1, "1", "発表", "gate-only"),
      makeProcessDeps({ revisionGate: gate }),
      Date.parse(T1),
    ).kind).toBe("ok");
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: [],
        legacyEventIds: [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(new StandbyStateStore()));
    removeFloodGateSerial(file);

    expect(persistence.load()!.telegramFoundation.floodForecast).toEqual({
      authoritative: false,
      active: [],
      gateEntries: [],
    });
  });

  it("salvages a broken flood foundation without discarding VPWS50", () => {
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: { authoritative: true, active: [], gateEntries: [] },
    }));
    const emptyStore = new StandbyStateStore();
    persistence.save(legacyState(emptyStore));
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: Record<string, unknown>;
    };
    raw.telegramFoundation.floodForecast = {
      authoritative: true,
      active: "broken",
      gateEntries: [],
    };
    fs.writeFileSync(v2Path, `${JSON.stringify(raw)}\n`, "utf8");
    const loaded = persistence.load()!;
    expect(loaded.telegramFoundation.floodForecast).toEqual({
      authoritative: false,
      active: [],
      gateEntries: [],
    });
    expect(loaded.telegramFoundation.vpws50).toEqual({
      authoritative: true,
      state: null,
      gateEntries: [],
    });
  });

  it("loads pre-flood v2 as non-authoritative for backward compatibility", () => {
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0);
    persistence.save(legacyState(new StandbyStateStore()));
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: Record<string, unknown>;
    };
    delete raw.telegramFoundation.floodForecast;
    fs.writeFileSync(v2Path, `${JSON.stringify(raw)}\n`, "utf8");
    expect(persistence.load()!.telegramFoundation.floodForecast).toEqual({
      authoritative: false,
      active: [],
      gateEntries: [],
    });
  });

  it("records a migration conflict when only the foundation gate is newer than matching legacy copies", () => {
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const store = new StandbyStateStore();
    const accepted = processFloodForecast(
      message(T2, "2"),
      makeProcessDeps({ revisionGate: gate, floodForecastState: holder }),
      Date.parse(T2),
    );
    expect(accepted.kind).toBe("ok");
    if (accepted.kind !== "ok") return;
    store.applyEvent(toPresentationEvent(accepted.outcome), Date.parse(T2));

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      floodForecast: {
        authoritative: true,
        active: store.exportActiveState().floods?.events ?? [],
        gateEntries: gate.exportDurableEntries().filter((entry) => entry.domain === "floodForecast"),
      },
    }));
    persistence.save(legacyState(store));

    for (const target of [standbyPersistenceV2Path(file), file]) {
      const raw = JSON.parse(fs.readFileSync(target, "utf8")) as {
        floods: { seen: Array<{ reportTimeMs: number; serial: string | null }> };
      };
      raw.floods.seen[0]!.reportTimeMs = Date.parse(T1);
      raw.floods.seen[0]!.serial = "1";
      fs.writeFileSync(target, `${JSON.stringify(raw)}\n`, "utf8");
    }

    expect(persistence.load()).not.toBeNull();
    expect(persistence.takeMigrationConflictCount()).toBe(1);
  });

  it("router separates transport and semantic duplicates before notification", () => {
    const notify = vi.spyOn(Notifier.prototype, "notifyFloodForecast").mockImplementation(() => {});
    const { handler, stats } = createMessageHandler();
    const first = message(T1, "1");
    handler(first);
    handler(first);
    handler({ ...first, id: "different-transport", meta: undefined });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(stats.getSnapshot().foundation).toMatchObject({
      received: 3,
      transportDuplicate: 1,
      semanticDuplicate: 1,
      notified: 1,
    });
  });

  it("router diagnoses invalid ReportDateTime without state or notification", () => {
    const notify = vi.spyOn(Notifier.prototype, "notifyFloodForecast").mockImplementation(() => {});
    const displayTelegramDiagnostic = vi.fn();
    const { handler, floodForecastState, stats } = createMessageHandler({
      display: {
        displayOutcome: vi.fn(), displayRawHeader: vi.fn(), displayTelegramDiagnostic,
        displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn(), getDisplayMode: () => "normal",
        renderSummaryLine: () => "summary",
      },
    });
    handler(message("invalid", "1"));
    expect(displayTelegramDiagnostic).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(floodForecastState.activeEventIds()).toEqual([]);
    expect(stats.getSnapshot().foundation.invalidDateDiagnosed).toBe(1);
  });

  it("accepts one same-revision correction and suppresses its retransmission", () => {
    const notify = vi.spyOn(Notifier.prototype, "notifyFloodForecast").mockImplementation(() => {});
    const { handler, stats } = createMessageHandler();
    handler(message(T1, "1"));
    const correction = message(T1, "1", "訂正");
    handler(correction);
    handler({ ...correction, id: "correction-retry", meta: undefined });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(stats.getSnapshot().foundation).toMatchObject({
      correctionReplaced: 1,
      correctionNotified: 1,
      semanticDuplicate: 1,
    });
  });

  it("enforces the 512 EventID bound with the same oldest-event eviction in gate and holder", () => {
    const gate = new TelegramRevisionGate();
    const holder = new FloodForecastStateHolder();
    const deps = makeProcessDeps({ revisionGate: gate, floodForecastState: holder });
    for (let index = 0; index <= FLOOD_FORECAST_MAX_SUBJECTS; index++) {
      expect(processFloodForecast(message(T1, "1", "発表", `flood-${index}`), deps, Date.parse(T1) + index).kind)
        .toBe("ok");
    }
    const subjects = gate.activeRevisionFamilySubjects("floodForecast", "floodForecast");
    expect(subjects).toHaveLength(FLOOD_FORECAST_MAX_SUBJECTS);
    expect(holder.activeEventIds()).toHaveLength(FLOOD_FORECAST_MAX_SUBJECTS);
    expect(subjects).not.toContain("flood:event:flood-0");
    expect(holder.activeEventIds()).not.toContain("flood-0");
  }, 30_000);
});
