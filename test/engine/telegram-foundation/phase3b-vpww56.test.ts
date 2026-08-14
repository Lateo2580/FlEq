import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
  type PersistedStandbyStateV1,
} from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import { weatherAlertsFromVpww56 } from "../../../src/engine/display/weather-alert-view";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { createDisplaySink } from "../../../src/engine/monitor/display-sink";
import { VPWW56_REVISION_FAMILY_POLICY } from "../../../src/engine/messages/revision-family-registry";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import {
  VPWW56_SNAPSHOT_GENERATION,
  Vpww56StateHolder,
} from "../../../src/engine/messages/vpww56-state";
import { processWeather } from "../../../src/engine/presentation/processors/process-weather";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import type { WsDataMessage } from "../../../src/types";
import { makeProcessDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPWW56_DOSHA,
  readFixture,
} from "../../helpers/mock-message";
import { notifyMock } from "../../setup";

const T1 = "2026-07-30T10:00:00+09:00";
const T2 = "2026-07-30T10:30:00+09:00";
const T3 = "2026-07-30T11:00:00+09:00";
const T_OLD = "2026-07-28T11:00:00+09:00";
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-vpww56-foundation-"));
  tempDirs.push(dir);
  return path.join(dir, "display-active-state-v1.json");
}

function legacyState(): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: "2026-07-30T12:00:00+09:00",
    heat: [], typhoons: [], volcanoes: [], floods: { events: [], seen: [] },
    weatherAlerts: [], tornado: [], longPeriod: [], quakeHost: null, nankaiTrough: null, seen: [],
  };
}

function withHead(xml: string, infoType: string, serial: string, reportDateTime: string): string {
  return xml
    .replace(/<InfoType>[^<]*<\/InfoType>/, `<InfoType>${infoType}</InfoType>`)
    .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, `<Serial>${serial}</Serial>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${reportDateTime}</ReportDateTime>`);
}

function message(
  office: string,
  reportDateTime: string,
  serial: string,
  infoType = "発表",
  id = `${office}:${reportDateTime}:${serial}:${infoType}`,
): WsDataMessage {
  const xml = withHead(
    readFixture(FIXTURE_VPWW56_DOSHA).replace(
      /<PublishingOffice>[^<]*<\/PublishingOffice>/,
      `<PublishingOffice>${office}</PublishingOffice>`,
    ),
    infoType,
    serial,
    reportDateTime,
  );
  const base = createMockWsDataMessageFromXml(xml, "VPWW56", { publishingOffice: office });
  return {
    ...base,
    head: { ...base.head, author: office },
    id,
    meta: undefined,
  };
}

function foundationProvider(holder: Vpww56StateHolder, gate: TelegramRevisionGate) {
  return () => ({
    vpws50: { authoritative: true, state: null, gateEntries: [] },
    vpww56: {
      authoritative: true,
      state: holder.exportPersistedState(),
      gateEntries: gate.exportDurableEntries().filter((entry) =>
        entry.domain === "weather" && entry.revisionFamily === "VPWW56"),
    },
  });
}

function legacyWithView(holder: Vpww56StateHolder, updatedAt: string, serial: string): PersistedStandbyStateV1 {
  const state = legacyState();
  state.weatherAlerts = [{
    source: "vpww56",
    alerts: weatherAlertsFromVpww56(holder.getCurrentAreasForDisplay(), updatedAt),
    revision: { reportTimeMs: Date.parse(updatedAt), serial },
    expiresAtMs: Date.parse(updatedAt) + 86_400_000,
  }];
  return state;
}

function display(): DisplayCallbacks {
  return {
    displayOutcome: vi.fn(), displayRawHeader: vi.fn(), displayTelegramDiagnostic: vi.fn(),
    displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn(), getDisplayMode: () => "normal",
    renderSummaryLine: () => "summary",
  };
}

describe("Phase 3B VPWW56 common registry", () => {
  beforeEach(() => {
    notifyMock.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("subject/cancellation target は type×官署で一致し、可変 family を有限保持する", () => {
    const parsed = processWeather(message("稚内地方気象台", T1, "1"));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    const policy = VPWW56_REVISION_FAMILY_POLICY;
    expect(policy.extractStateSubjectKey(parsed.outcome.parsed.meta, parsed.outcome.parsed))
      .toBe("weather:VPWW56:稚内地方気象台");
    expect(policy.extractCancellationTarget(parsed.outcome.parsed.meta, parsed.outcome.parsed))
      .toEqual(["weather:VPWW56:稚内地方気象台"]);
    expect(policy).toMatchObject({
      cancellationPolicy: "clearCurrent",
      durable: true,
      maxSubjects: 128,
      tombstoneRetentionMs: 6 * 60 * 60 * 1000,
    });
  });

  it("二官署の active state と watermark を実ファイル round-trip する", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    expect(processWeather(message("稚内地方気象台", T1, "1"), deps).kind).toBe("ok");
    expect(processWeather(message("旭川地方気象台", T2, "2"), deps).kind).toBe("ok");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    const legacy = legacyWithView(holder, T2, "2");
    persistence.save(legacy);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect(JSON.parse(fs.readFileSync(standbyPersistenceV2Path(file), "utf8")))
      .toMatchObject({ version: 2, telegramFoundation: { vpww56: { authoritative: true } } });

    const loaded = persistence.load()!;
    expect(persistence.takeMigrationConflictCount()).toBe(0);
    const restoredHolder = new Vpww56StateHolder();
    const restoredGate = new TelegramRevisionGate();
    restoredHolder.restorePersistedState(loaded.telegramFoundation.vpww56.state!);
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpww56.gateEntries);
    expect(restoredHolder.activeSubjectKeys().sort()).toEqual([
      "weather:VPWW56:旭川地方気象台",
      "weather:VPWW56:稚内地方気象台",
    ]);
    expect(restoredGate.exportDurableEntries().filter((entry) => entry.revisionFamily === "VPWW56"))
      .toHaveLength(2);
    expect(loaded.telegramFoundation.vpww56.generation).toBe(VPWW56_SNAPSHOT_GENERATION);
    expect(loaded.telegramFoundation.vpww56.state?.generation).toBe(VPWW56_SNAPSHOT_GENERATION);
  });

  it("旧世代の VPWW56 active view は官署単位の復元待ちへ移し watermark を保つ", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    expect(processWeather(message("稚内地方気象台", T1, "1"), makeProcessDeps({ vpww56State: holder, revisionGate: gate })).kind)
      .toBe("ok");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyWithView(holder, T1, "1"));
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: {
        vpww56: {
          state: Record<string, unknown> & { streams: Array<{ generation?: number }> };
          gateEntries: unknown[];
        };
      };
    };
    delete raw.telegramFoundation.vpww56.state.generation;
    for (const stream of raw.telegramFoundation.vpww56.state.streams) delete stream.generation;
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");

    expect(new StandbyPersistence(file, 0).load()!.telegramFoundation.vpww56).toEqual({
      generation: VPWW56_SNAPSHOT_GENERATION,
      authoritative: true,
      state: {
        generation: VPWW56_SNAPSHOT_GENERATION,
        streams: [],
        pendingSubjects: ["weather:VPWW56:稚内地方気象台"],
      },
      gateEntries: [expect.objectContaining({
        stateSubjectKey: "weather:VPWW56:稚内地方気象台",
        cancelled: false,
      })],
    });
  });

  it("二官署の旧世代復元待ちで取消が先着しても、別官署を authoritative 扱いせず待機を保つ", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    expect(processWeather(message("稚内地方気象台", T1, "1"), deps).kind).toBe("ok");
    expect(processWeather(message("旭川地方気象台", T1, "1"), deps).kind).toBe("ok");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyWithView(holder, T1, "1"));
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: {
        vpww56: {
          generation?: number;
          state: { streams: Array<{ generation?: number }> };
        };
      };
    };
    delete raw.telegramFoundation.vpww56.generation;
    for (const stream of raw.telegramFoundation.vpww56.state.streams) delete stream.generation;
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");

    const migrated = new StandbyPersistence(file, 0).load()!.telegramFoundation.vpww56;
    expect(migrated.state?.streams).toEqual([]);
    expect(migrated.state?.pendingSubjects?.sort()).toEqual([
      "weather:VPWW56:旭川地方気象台",
      "weather:VPWW56:稚内地方気象台",
    ]);
    expect(migrated.gateEntries).toHaveLength(2);

    const restartedHolder = new Vpww56StateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedHolder.restorePersistedState(migrated.state!);
    restartedGate.restoreDurableEntries(migrated.gateEntries);
    const restarted = makeProcessDeps({ vpww56State: restartedHolder, revisionGate: restartedGate });

    const cancellation = processWeather(
      message("稚内地方気象台", T2, "2", "取消", "cancel-first"),
      restarted,
    );
    expect(cancellation.kind).toBe("ok");
    expect(restartedHolder.getCurrentAreasForDisplay()).toBeUndefined();
    expect(restartedHolder.pendingSubjectKeys()).toEqual(["weather:VPWW56:旭川地方気象台"]);

    const afterCancelFile = tempPath();
    const afterCancelPersistence = new StandbyPersistence(
      afterCancelFile,
      0,
      foundationProvider(restartedHolder, restartedGate),
    );
    afterCancelPersistence.save(legacyState());
    const afterCancel = afterCancelPersistence.load()!.telegramFoundation.vpww56;
    expect(afterCancel.state?.pendingSubjects).toEqual(["weather:VPWW56:旭川地方気象台"]);
    const secondHolder = new Vpww56StateHolder();
    const secondGate = new TelegramRevisionGate();
    secondHolder.restorePersistedState(afterCancel.state!);
    secondGate.restoreDurableEntries(afterCancel.gateEntries);

    const otherOffice = processWeather(
      message("旭川地方気象台", T2, "2", "発表", "other-office-next"),
      makeProcessDeps({ vpww56State: secondHolder, revisionGate: secondGate }),
    );
    expect(otherOffice.kind).toBe("ok");
    expect(secondHolder.pendingSubjectKeys()).toEqual([]);
    expect(secondHolder.activeSubjectKeys()).toEqual(["weather:VPWW56:旭川地方気象台"]);
    expect(secondHolder.getCurrentAreasForDisplay()).toBeDefined();
  });

  it("一官署だけ旧世代なら、その官署の取消先着でも新世代の別官署 view を削除しない", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    expect(processWeather(message("稚内地方気象台", T1, "1"), deps).kind).toBe("ok");
    expect(processWeather(message("旭川地方気象台", T1, "1"), deps).kind).toBe("ok");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyWithView(holder, T1, "1"));
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: {
        vpww56: { state: { streams: Array<{ generation?: number; subjectKey: string }> } };
      };
    };
    const oldOffice = raw.telegramFoundation.vpww56.state.streams.find((stream) =>
      stream.subjectKey === "weather:VPWW56:稚内地方気象台")!;
    delete oldOffice.generation;
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");

    const migrated = new StandbyPersistence(file, 0).load()!.telegramFoundation.vpww56;
    expect(migrated.state?.streams.map((stream) => stream.subjectKey)).toEqual([
      "weather:VPWW56:旭川地方気象台",
    ]);
    expect(migrated.state?.pendingSubjects).toEqual(["weather:VPWW56:稚内地方気象台"]);

    const restartedHolder = new Vpww56StateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedHolder.restorePersistedState(migrated.state!);
    restartedGate.restoreDurableEntries(migrated.gateEntries);
    const before = restartedHolder.getCurrentAreasForDisplay();
    expect(before).toBeDefined();

    const cancellation = processWeather(
      message("稚内地方気象台", T2, "2", "取消", "old-office-cancel-first"),
      makeProcessDeps({ vpww56State: restartedHolder, revisionGate: restartedGate }),
    );
    expect(cancellation.kind).toBe("ok");
    expect(restartedHolder.pendingSubjectKeys()).toEqual([]);
    expect(restartedHolder.activeSubjectKeys()).toEqual(["weather:VPWW56:旭川地方気象台"]);
    expect(restartedHolder.getCurrentAreasForDisplay()).toEqual(before);
    if (cancellation.kind !== "ok") return;

    const standby = new StandbyStateStore();
    const sink = createDisplaySink({
      standby,
      promotions: new WeatherPromotionStore(),
      weatherViews: {
        vpws50: () => undefined,
        vpww56: () => restartedHolder.getCurrentAreasForDisplay(),
      },
      getHub: () => null,
      now: () => Date.parse(T2),
    });
    sink.ingest(toPresentationEvent(cancellation.outcome));
    expect(standby.snapshotWeatherAlerts()).toEqual(weatherAlertsFromVpww56(before, T1));
  });

  it("旧世代の cancellation-only VPWW56 foundation は tombstone ごと破棄する", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    expect(processWeather(message("稚内地方気象台", T1, "1"), deps).kind).toBe("ok");
    expect(processWeather(message("稚内地方気象台", T2, "2", "取消"), deps).kind).toBe("ok");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyState());
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: {
        vpww56: {
          generation?: number;
          state: unknown;
          gateEntries: unknown[];
        };
      };
    };
    expect(raw.telegramFoundation.vpww56.generation).toBe(VPWW56_SNAPSHOT_GENERATION);
    expect(raw.telegramFoundation.vpww56.state).toBeNull();
    expect(raw.telegramFoundation.vpww56.gateEntries).toHaveLength(1);
    delete raw.telegramFoundation.vpww56.generation;
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");

    expect(new StandbyPersistence(file, 0).load()!.telegramFoundation.vpww56).toEqual({
      generation: VPWW56_SNAPSHOT_GENERATION,
      authoritative: false,
      state: null,
      gateEntries: [],
    });
  });

  it("同一 payload でも v2 gate と legacy revision が異なれば migration conflict を記録する", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    expect(processWeather(message("稚内地方気象台", T2, "2"), deps).kind).toBe("ok");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyWithView(holder, T2, "2"));
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      weatherAlerts: Array<{ source: string; revision: { reportTimeMs: number; serial: string | null } }>;
    };
    const legacy = raw.weatherAlerts.find((entry) => entry.source === "vpww56")!;
    legacy.revision = { reportTimeMs: Date.parse(T1), serial: "1" };
    fs.writeFileSync(v2Path, `${JSON.stringify(raw)}\n`, "utf8");

    // standalone v1 も同じ T1 に揃え、v1/v2 legacy field 間の比較ではなく
    // foundation gate=T2 と legacy=T1 の比較だけが conflict を成立させる。
    const standalone = JSON.parse(fs.readFileSync(file, "utf8")) as {
      weatherAlerts: Array<{ source: string; revision: { reportTimeMs: number; serial: string | null } }>;
    };
    const standaloneLegacy = standalone.weatherAlerts.find((entry) => entry.source === "vpww56")!;
    standaloneLegacy.revision = { reportTimeMs: Date.parse(T1), serial: "1" };
    fs.writeFileSync(file, `${JSON.stringify(standalone)}\n`, "utf8");

    expect(persistence.load()).not.toBeNull();
    expect(persistence.takeMigrationConflictCount()).toBe(1);
  });

  it("別官署の時刻が古くても source 全体の旧 guard で office union を拒まない", () => {
    const store = new StandbyStateStore();
    const first = {
      source: "vpww56" as const,
      label: "土砂災害警戒情報",
      role: "weatherEmergency" as const,
      totalAreas: 1,
      items: [],
      updatedAt: T2,
    };
    store.applyWeatherAlerts("vpww56", [first], T2, "2", Date.parse(T2));
    const union = { ...first, totalAreas: 2, updatedAt: T1 };
    const mutation = store.applyWeatherAlerts("vpww56", [union], T1, "1", Date.parse(T2));
    expect(mutation.durableChanged).toBe(true);
    expect(store.snapshotWeatherAlerts()).toEqual([union]);
  });

  it("官署欠落の fail-open は後段まで通っても復元済み durable state/promotion を変えない", () => {
    const legacyHolder = new Vpww56StateHolder();
    const legacyResult = processWeather(message("稚内地方気象台", T1, "1"));
    expect(legacyResult.kind).toBe("ok");
    if (legacyResult.kind !== "ok") return;
    legacyHolder.update(legacyResult.outcome.parsed);
    const legacyView = legacyHolder.getCurrentAreasForDisplay();
    const legacyAlerts = weatherAlertsFromVpww56(legacyView, T1);
    const standby = new StandbyStateStore();
    standby.restoreCanonicalVpww56Alerts(legacyAlerts, T1, "1");
    const promotions = new WeatherPromotionStore();
    promotions.apply("vpww56", legacyView, Date.parse(T1));
    const promotionBefore = promotions.get("vpww56");
    const hubIngest = vi.fn();
    const sink = createDisplaySink({
      standby,
      promotions,
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => ({ ingest: hubIngest }),
      now: () => Date.parse(T2),
    });
    const result = processWeather(
      message("", T2, "2", "発表", "missing-office"),
      makeProcessDeps({ vpww56State: new Vpww56StateHolder(), revisionGate: new TelegramRevisionGate() }),
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.presentation.weatherStateMutationAccepted).toBe(false);

    sink.ingest(toPresentationEvent(result.outcome));

    expect(standby.snapshotWeatherAlerts()).toEqual(legacyAlerts);
    expect(promotions.get("vpww56")).toEqual(promotionBefore);
    expect(hubIngest).toHaveBeenCalledTimes(1);
  });

  it("古い別官署報を受理しても active subject の最新時刻で union expiry を維持する", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    const standby = new StandbyStateStore();
    const sink = createDisplaySink({
      standby,
      promotions: new WeatherPromotionStore(),
      weatherViews: { vpws50: () => undefined, vpww56: () => holder.getCurrentAreasForDisplay() },
      getHub: () => null,
      now: () => Date.parse(T3),
    });
    const newest = processWeather(message("稚内地方気象台", T3, "9"), deps);
    expect(newest.kind).toBe("ok");
    if (newest.kind !== "ok") return;
    sink.ingest(toPresentationEvent(newest.outcome));
    const olderOffice = processWeather(message("旭川地方気象台", T_OLD, "1"), deps);
    expect(olderOffice.kind).toBe("ok");
    if (olderOffice.kind !== "ok") return;
    expect(olderOffice.outcome.presentation.weatherStateRevision).toEqual({
      reportDateTime: T3,
      serial: "9",
    });
    sink.ingest(toPresentationEvent(olderOffice.outcome));

    expect(standby.exportActiveState().weatherAlerts).toEqual([
      expect.objectContaining({
        source: "vpww56",
        revision: { reportTimeMs: Date.parse(T3), serial: "9" },
        expiresAtMs: Date.parse(T3) + 24 * 60 * 60_000,
      }),
    ]);
    standby.sweep(Date.parse(T3) + 60_000);
    expect(standby.snapshotWeatherAlerts()).not.toEqual([]);
  });

  it("取消 tombstone を restart 後も保ち、遅延旧報を復活させない", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    expect(processWeather(message("稚内地方気象台", T1, "1"), deps).kind).toBe("ok");
    expect(processWeather(message("稚内地方気象台", T2, "2", "取消"), deps).kind).toBe("ok");
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyState());
    const loaded = persistence.load()!;
    const restartedHolder = new Vpww56StateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(loaded.telegramFoundation.vpww56.gateEntries);
    const restarted = makeProcessDeps({ vpww56State: restartedHolder, revisionGate: restartedGate });
    expect(processWeather(message("稚内地方気象台", T1, "1", "発表", "late-old"), restarted))
      .toEqual({ kind: "suppressed" });
    expect(restartedHolder.getCurrentAreasForDisplay()).toBeUndefined();
    expect(processWeather(message("稚内地方気象台", T3, "3", "発表", "new-lifecycle"), restarted).kind)
      .toBe("ok");
  });

  it("同一 revision 訂正後の active と comparison を実ファイル往復する", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    expect(processWeather(message("稚内地方気象台", T1, "1"), deps).kind).toBe("ok");
    const correctedXml = withHead(readFixture(FIXTURE_VPWW56_DOSHA)
      .replaceAll("レベル４土砂災害危険警報", "レベル３土砂災害警戒警報")
      .replace(/<Code>49<\/Code>/, "<Code>09</Code>"), "訂正", "1", T1);
    const correction = {
      ...createMockWsDataMessageFromXml(correctedXml, "VPWW56", { publishingOffice: "稚内地方気象台" }),
      id: "vpww56-correction",
      meta: undefined,
    } satisfies WsDataMessage;
    expect(processWeather(correction, deps).kind).toBe("ok");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyWithView(holder, T1, "1"));
    const loaded = persistence.load()!.telegramFoundation.vpww56;
    expect(loaded.state?.streams[0].view.kinds.find((kind) => kind.kindCode === "09")).toBeDefined();
    expect(loaded.gateEntries[0].comparison.revision.infoType.value).toBe("訂正");
  });

  it("旧 v2 の tombstoneRetentionMs 欠落を VPWW56 policy で補完する", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    const deps = makeProcessDeps({ vpww56State: holder, revisionGate: gate });
    processWeather(message("稚内地方気象台", T1, "1"), deps);
    processWeather(message("稚内地方気象台", T2, "2", "取消"), deps);
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyState());
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: { vpww56: { gateEntries: Array<Record<string, unknown>> } };
    };
    delete raw.telegramFoundation.vpww56.gateEntries[0].tombstoneRetentionMs;
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");
    expect(new StandbyPersistence(file, 0).load()!.telegramFoundation.vpww56.gateEntries[0].tombstoneRetentionMs)
      .toBe(6 * 60 * 60 * 1000);
  });

  it("VPWW56 foundation の破損だけを salvage し、他 foundation を巻き込まない", () => {
    const holder = new Vpww56StateHolder();
    const gate = new TelegramRevisionGate();
    processWeather(message("稚内地方気象台", T1, "1"),
      makeProcessDeps({ vpww56State: holder, revisionGate: gate }));
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, foundationProvider(holder, gate));
    persistence.save(legacyWithView(holder, T1, "1"));
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: Record<string, unknown>;
    };
    raw.telegramFoundation.vpww56 = { authoritative: true, state: { streams: "broken" }, gateEntries: [] };
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");
    const loaded = new StandbyPersistence(file, 0).load()!;
    expect(loaded.telegramFoundation.vpww56).toEqual({
      generation: VPWW56_SNAPSHOT_GENERATION,
      authoritative: false,
      state: null,
      gateEntries: [],
    });
    expect(loaded.telegramFoundation.vpws50).toEqual({ authoritative: true, state: null, gateEntries: [] });
    expect(loaded.telegramFoundation.tsunami).toEqual({
      active: null, keyedActive: [], legacyActive: null,
      observations: { VTSE51: [], VTSE52: [] }, gateEntries: [],
    });
  });

  it("旧 v1 の官署不明 union は旧粒度を固着させず、表示も watermark も復元しない", () => {
    const file = tempPath();
    const legacy = legacyState();
    legacy.weatherAlerts = [{
      source: "vpww56",
      alerts: [{
        source: "vpww56", label: "土砂災害警戒情報", role: "weatherEmergency",
        totalAreas: 1, items: [], updatedAt: T1,
      }],
      revision: { reportTimeMs: Date.parse(T1), serial: "1" },
      expiresAtMs: Date.parse(T1) + 86_400_000,
    }];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(legacy), "utf8");
    const loaded = new StandbyPersistence(file, 0).load()!;
    expect(loaded.weatherAlerts).toEqual([]);
    expect(loaded.telegramFoundation.vpww56).toEqual({
      generation: VPWW56_SNAPSHOT_GENERATION,
      authoritative: false, state: null, gateEntries: [],
    });
  });

  it("vpww56 field のない旧 v2 を空 foundation として互換復元する", () => {
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0);
    persistence.save(legacyState());
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as {
      telegramFoundation: Record<string, unknown>;
    };
    delete raw.telegramFoundation.vpww56;
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");
    expect(new StandbyPersistence(file, 0).load()!.telegramFoundation.vpww56).toEqual({
      generation: VPWW56_SNAPSHOT_GENERATION,
      authoritative: false, state: null, gateEntries: [],
    });
  });

  it("同一 revision 訂正を router で一回だけ通知し、訂正を明示する", () => {
    const events: PresentationEvent[] = [];
    const sink: DisplayIngestSink = { ingest: (event) => events.push(event) };
    const { handler, notifier, stats } = createMessageHandler({ display: display(), displaySink: sink });
    const notifyWeather = vi.spyOn(notifier, "notifyWeatherWarning");
    handler(message("稚内地方気象台", T1, "1", "発表", "normal"));
    notifyWeather.mockClear();
    handler(message("稚内地方気象台", T1, "1", "訂正", "correction-1"));
    handler(message("稚内地方気象台", T1, "1", "訂正", "correction-2"));
    expect(events.filter((event) => event.infoType === "訂正")).toHaveLength(1);
    expect(notifyWeather).toHaveBeenCalledTimes(1);
    expect(notifyWeather.mock.calls[0][0].infoType).toBe("訂正");
    expect(stats.getSnapshot().foundation).toMatchObject({
      correctionReplaced: 1,
      correctionNotified: 1,
      semanticDuplicate: 1,
      notified: 2,
      presented: 2,
    });
  });

  it("router transport dedup は同一 messageId の異なる VPWW56 payload を一回処理する", () => {
    const events: PresentationEvent[] = [];
    const { handler, notifier, stats } = createMessageHandler({
      display: display(),
      displaySink: { ingest: (event) => events.push(event) },
    });
    const notifyWeather = vi.spyOn(notifier, "notifyWeatherWarning");
    handler(message("稚内地方気象台", T1, "1", "発表", "same-transport-id"));
    handler(message("稚内地方気象台", T1, "1", "訂正", "same-transport-id"));

    expect(events).toHaveLength(1);
    expect(events[0].infoType).toBe("発表");
    expect(notifyWeather).toHaveBeenCalledTimes(1);
    expect(stats.getSnapshot().foundation).toMatchObject({
      received: 2,
      transportDuplicate: 1,
      correctionNotified: 0,
    });
  });

  it("router は官署欠落 VPWW56 を ticker へ流すが通知と notified 統計を抑止する", () => {
    const events: PresentationEvent[] = [];
    const { handler, notifier, stats } = createMessageHandler({
      display: display(),
      displaySink: { ingest: (event) => events.push(event) },
    });
    const notifyWeather = vi.spyOn(notifier, "notifyWeatherWarning");

    handler(message("", T1, "1", "発表", "missing-office"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "VPWW56",
      weatherStateMutationAccepted: false,
    });
    expect(notifyWeather).not.toHaveBeenCalled();
    expect(stats.getSnapshot().foundation).toMatchObject({
      received: 1,
      notified: 0,
      presented: 1,
    });
  });

  it("router は VPWW56 の invalid/future ReportDateTime を診断だけへ分離する", () => {
    const diagnostics = vi.fn();
    const ingested: PresentationEvent[] = [];
    const callbacks = { ...display(), displayTelegramDiagnostic: diagnostics };
    const { handler, notifier, stats } = createMessageHandler({
      display: callbacks,
      displaySink: { ingest: (event) => ingested.push(event) },
    });
    const notifyWeather = vi.spyOn(notifier, "notifyWeatherWarning");
    handler(message("稚内地方気象台", "not-a-date", "1", "発表", "invalid-date"));
    const future = new Date(Date.now() + 16 * 60_000).toISOString();
    handler(message("稚内地方気象台", future, "2", "発表", "future-date"));

    expect(diagnostics).toHaveBeenCalledTimes(2);
    expect(ingested.map((event) => event.diagnosticKind)).toEqual([
      "invalidReportDateTime",
      "futureSkewExceeded",
    ]);
    expect(notifyWeather).not.toHaveBeenCalled();
    expect(stats.getSnapshot().foundation).toMatchObject({
      received: 2,
      invalidDateDiagnosed: 1,
      futureDateDiagnosed: 1,
      notified: 0,
    });
  });

  it("revision subject と ticker groupKey は官署空白を同じ helper で正規化する", () => {
    const result = processWeather(message("稚内地方気象台", T1, "1"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const parsed = { ...result.outcome.parsed, publishingOffice: "  稚内地方気象台  " };
    const subject = VPWW56_REVISION_FAMILY_POLICY.extractStateSubjectKey(parsed.meta, parsed);
    const event = {
      ...toPresentationEvent(result.outcome),
      publishingOffice: "  稚内地方気象台  ",
    };
    expect(projectDisplayEvent(event, "要約").groupKey).toBe(subject);
    expect(subject).toBe("weather:VPWW56:稚内地方気象台");
  });

  it("envelope 官署が空でも parser 確定官署を PresentationEvent と ticker groupKey に使う", () => {
    const xml = withHead(readFixture(FIXTURE_VPWW56_DOSHA), "発表", "1", T1);
    const base = createMockWsDataMessageFromXml(xml, "VPWW56", { publishingOffice: "" });
    const msg = { ...base, head: { ...base.head, author: "" }, id: "empty-envelope-office", meta: undefined };
    const deps = makeProcessDeps();
    const result = processWeather(msg, deps);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const subject = VPWW56_REVISION_FAMILY_POLICY.extractStateSubjectKey(
      result.outcome.parsed.meta,
      result.outcome.parsed,
    );
    const event = toPresentationEvent(result.outcome);
    expect(result.outcome.parsed.publishingOffice).not.toBe("");
    expect(event.publishingOffice).toBe(result.outcome.parsed.publishingOffice);
    expect(projectDisplayEvent(event, "要約").groupKey).toBe(subject);
  });

  it("通常報と取消を foundation notified/presented に一回ずつ記録する", () => {
    const { handler, stats } = createMessageHandler({
      display: display(),
      displaySink: { ingest: vi.fn() },
    });
    handler(message("稚内地方気象台", T1, "1", "発表", "metrics-normal"));
    handler(message("稚内地方気象台", T2, "2", "取消", "metrics-cancel"));
    expect(stats.getSnapshot().foundation).toMatchObject({
      cancelApplied: 1,
      notified: 2,
      presented: 2,
    });
  });
});
