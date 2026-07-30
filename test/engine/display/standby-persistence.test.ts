import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StandbyPersistence, type PersistedStandbyStateV1 } from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { FloodActiveReducer } from "../../../src/engine/display/flood-active-reducer";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { fromFloodForecastOutcome } from "../../../src/engine/presentation/events/from-flood-forecast";
import type { FloodForecastOutcome } from "../../../src/engine/presentation/types";
import { createMockWsDataMessage } from "../../helpers/mock-message";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const roots: string[] = [];

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), "fleq-standby-"));
  roots.push(root);
  return join(root, "data", "runtime", "display-active-state-v1.json");
}

function state(over: Partial<PersistedStandbyStateV1> = {}): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: new Date(T0).toISOString(),
    heat: [{
      key: "heat:2026-07-21",
      sourceEventIds: ["heat-1"],
      targetDate: "2026-07-21",
      targetDateEndMs: Date.parse("2026-07-22T00:00:00+09:00"),
      areas: [{ areaName: "東京都", isSpecial: false }],
      isSpecial: false,
      revision: { reportTimeMs: T0, serial: "1" },
    }],
    seen: [{
      key: "heat:2026-07-21",
      revision: { reportTimeMs: T0, serial: "1" },
      forgetAtMs: T0 + 24 * 60 * 60_000,
    }],
    typhoons: [],
    volcanoes: [],
    floods: undefined,
    weatherAlerts: [],
    tornado: [],
    longPeriod: [],
    quakeHost: null,
    nankaiTrough: null,
    ...over,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("StandbyPersistence", () => {
  it("atomic save と load が往復する", () => {
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(state());
    expect(persistence.load()).toEqual(state());
  });

  it("version 不一致は全体を破棄し、構造不正な domain だけを空にする", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state(), version: 2 }), "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
    writeFileSync(path, JSON.stringify({ ...state(), heat: "invalid" }), "utf8");
    expect(new StandbyPersistence(path).load()).toEqual(expect.objectContaining({ heat: [], seen: state().seen }));
  });

  it("壊れた JSON を破棄する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{broken", "utf8");
    expect(new StandbyPersistence(path).load()).toBeNull();
  });

  it("洪水 EventID state と seen revision を検証して永続化する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{ riverKey: "river-1", riverName: "多摩川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: new Date(T0).toISOString() }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...persisted, floods: { events: "invalid", seen: [] } }), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: undefined }));
  });

  it("一部の洪水 EventID が壊れていても、有効な EventID とカードを復元する", () => {
    const path = tempPath();
    const validEvent = {
      eventId: "flood-valid",
      revision: { reportTimeMs: T0, serial: "1" },
      expiresAtMs: T0 + 12 * 60 * 60_000,
      rivers: [{
        riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40,
        kindName: "氾濫危険情報", reportDateTime: new Date(T0).toISOString(),
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(),
      floods: {
        events: [validEvent, { eventId: "broken", rivers: "invalid" }],
        seen: [
          { key: "flood-valid", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "broken", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "cancelled-only", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
        ],
      },
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.floods?.events).toEqual([validEvent]);
    expect(loaded?.floods?.seen.map((entry) => entry.key)).toEqual(["flood-valid", "cancelled-only"]);
    const reducer = new FloodActiveReducer();
    reducer.restoreState(loaded!.floods!, T0 + 60_000);
    expect(reducer.apply({
      mode: "replace",
      eventId: "broken",
      reportDateTime: new Date(T0).toISOString(),
      serial: "1",
      rivers: [{
        riverKey: "river-2", riverName: "利根川", level: "L3", levelRank: 30,
        kindName: "氾濫警戒情報", reportDateTime: new Date(T0).toISOString(),
      }],
    }, T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()?.sourceEventIds).toContain("broken");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "flood"))
      .toEqual(expect.objectContaining({ restored: true }));
  });

  it("active event が全て壊れても、無関係な cancellation tombstone を保全して古い再送を拒否する", () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...state(),
      floods: {
        events: [{ eventId: "broken", rivers: "invalid" }],
        seen: [
          { key: "broken", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
          { key: "cancelled-only", revision: { reportTimeMs: T0, serial: "2" }, forgetAtMs: T0 + 24 * 60 * 60_000 },
        ],
      },
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.floods).toEqual({
      events: [],
      seen: [{
        key: "cancelled-only",
        revision: { reportTimeMs: T0, serial: "2" },
        forgetAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    const reducer = new FloodActiveReducer();
    reducer.restoreState(loaded!.floods!, T0 + 60_000);
    expect(reducer.apply({
      mode: "replace",
      eventId: "cancelled-only",
      reportDateTime: new Date(T0).toISOString(),
      serial: "1",
      rivers: [{
        riverKey: "river-old", riverName: "古い川", level: "L4", levelRank: 40,
        kindName: "氾濫危険情報", reportDateTime: new Date(T0).toISOString(),
      }],
    }, T0 + 60_000)).toEqual({ viewChanged: false, durableChanged: false });
    expect(reducer.snapshotCard()).toBeNull();
  });

  it("代表観測所 station 込みで round-trip し、壊れた station は洪水 domain だけ破棄する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: { name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過" },
          }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    // station.name が数値 (不正) → 洪水 domain のみ破棄、他 domain は生存
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: { name: 42, levelM: 3.42, trend: "rising", thresholdLabel: null },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(path, JSON.stringify(broken), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: undefined }));
  });

  it("hydrograph 込みで round-trip し、壊れた hydrograph は洪水 domain だけ破棄する", () => {
    const path = tempPath();
    const persisted = state({
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過",
              hydrograph: {
                points: [
                  { dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "observed" },
                  { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: null, phase: "forecast" },
                  { dateTime: new Date(T0 + 7_200_000).toISOString(), valueM: 3.55, phase: "forecast" },
                ],
                dangerLevelM: 3.2,
              },
            },
          }],
        }],
        seen: [{ key: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, forgetAtMs: T0 + 24 * 60 * 60_000 }],
      },
    });
    const persistence = new StandbyPersistence(path);
    persistence.save(persisted);
    expect(persistence.load()?.floods).toEqual(persisted.floods);

    // hydrograph.points[].phase が不正 → 洪水 domain のみ破棄、他 domain は生存
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: null,
              hydrograph: { points: [{ dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "bogus" }], dangerLevelM: null },
            },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(path, JSON.stringify(broken), "utf8");
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: undefined }));
  });

  it.each([
    // 先頭が forecast / 途中に observed が来る逆順 (描画側は先頭=現況固定のため実測と予測を逆表示する)
    ["phase 逆順 ([forecast, observed])", [
      { dateTime: new Date(T0).toISOString(), valueM: 3.55, phase: "forecast" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: 3.42, phase: "observed" },
    ]],
    // 2 点目以降に observed が混ざる
    ["2 点目 observed", [
      { dateTime: new Date(T0).toISOString(), valueM: 3.42, phase: "observed" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: 3.55, phase: "observed" },
    ]],
    // points 空
    ["空 points", []],
    // 有効値ゼロ (全 null)
    ["全 null 値", [
      { dateTime: new Date(T0).toISOString(), valueM: null, phase: "observed" },
      { dateTime: new Date(T0 + 3_600_000).toISOString(), valueM: null, phase: "forecast" },
    ]],
  ] as const)("壊れた hydrograph (%s) は洪水 domain を破棄する", (_label, points) => {
    const path = tempPath();
    const persisted = state({});
    mkdirSync(dirname(path), { recursive: true });
    const broken = {
      ...persisted,
      floods: {
        events: [{
          eventId: "flood-1", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 12 * 60 * 60_000,
          rivers: [{
            riverKey: "river-1", riverName: "多摩川", level: "L4", levelRank: 40, kindName: "氾濫危険情報",
            reportDateTime: new Date(T0).toISOString(),
            station: {
              name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: null,
              hydrograph: { points, dangerLevelM: null },
            },
          }],
        }],
        seen: [],
      },
    };
    writeFileSync(path, JSON.stringify(broken), "utf8");
    const persistence = new StandbyPersistence(path);
    expect(persistence.load()).toEqual(expect.objectContaining({ heat: persisted.heat, floods: undefined }));
  });

  it("typhoon/volcano/tornado/longPeriod/nankai を深く検証し、壊れた domain だけを破棄して起動を続ける", () => {
    const path = tempPath();
    const malformed = {
      ...state(),
      typhoons: [{}],
      volcanoes: [{ code: "V-1" }],
      tornado: [{ sourceEventId: "t", publishingOffice: 42 }],
      longPeriod: [{ eventId: "q", hosted: "yes" }],
      nankaiTrough: { sourceEventId: "n", expiresAtMs: "later" },
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(malformed), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded).toEqual(expect.objectContaining({
      heat: state().heat,
      typhoons: [],
      volcanoes: [],
      tornado: [],
      longPeriod: [],
      nankaiTrough: null,
    }));
    expect(() => new StandbyStateStore().restoreActiveState(loaded!, T0 + 1)).not.toThrow();
  });
});

describe("StandbyStateStore persistence", () => {
  function weatherAlert(source: "vpws50" | "vpww56", updatedAt = new Date(T0).toISOString()) {
    return {
      source,
      label: source === "vpws50" ? "気象警報" : "土砂災害警戒情報",
      role: "weatherWarning" as const,
      totalAreas: 1,
      items: [{
        kind: source === "vpws50" ? "L3 大雨警報" : "L4 土砂災害警戒情報",
        phenomenonKey: source === "vpws50" ? "rain" : "landslide",
        displaySeverity: source === "vpws50" ? "officialL3" : "officialL4",
        rank: "warning" as const,
        shownAreas: ["東京都"],
        omittedAreaCount: 0,
      }],
      updatedAt,
    };
  }

  it("気象警報を実ファイルへ書き、新しい store でカード現況を復元する", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    const live = new StandbyStateStore();
    live.applyWeatherAlerts("vpws50", [alert], alert.updatedAt, "1", T0);
    new StandbyPersistence(path).save(live.exportActiveState());

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);

    expect(restarted.snapshotWeatherAlerts()).toEqual([alert]);
    const display = new DisplayStateStore(
      () => restarted.snapshotItems(),
      undefined,
      undefined,
      undefined,
      () => restarted.snapshotWeatherAlerts(),
    );
    expect(display.snapshot(1, T0 + 60_000).weatherAlerts).toEqual([alert]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([
      expect.objectContaining({ source: "vpws50", alerts: [alert] }),
    ]);
  });

  it("weatherAlerts の壊れた source だけを破棄し、正常な別 source を復元する", () => {
    const path = tempPath();
    const vpww56 = weatherAlert("vpww56");
    const persisted = state({
      weatherAlerts: [{
        source: "vpww56",
        alerts: [vpww56],
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      ...persisted,
      weatherAlerts: [
        { source: "vpws50", alerts: "broken", revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 1 },
        ...persisted.weatherAlerts!,
      ],
    }), "utf8");

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherAlerts).toEqual(persisted.weatherAlerts);
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([vpww56]);
  });

  it("weatherAlerts フィールドのない旧ファイルを空の現況として復元する", () => {
    const path = tempPath();
    const legacy = state();
    delete legacy.weatherAlerts;
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.weatherAlerts).toEqual([]);
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
  });

  it("期限切れの weatherAlerts は新しい store へ復元しない", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    new StandbyPersistence(path).save(state({
      weatherAlerts: [{
        source: "vpws50",
        alerts: [alert],
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 60_000,
      }],
    }));

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([]);
  });

  it("解除で alerts が空になった現況は、再起動後もカードを復元しない", () => {
    const path = tempPath();
    const alert = weatherAlert("vpws50");
    const live = new StandbyStateStore();
    live.applyWeatherAlerts("vpws50", [alert], alert.updatedAt, "1", T0);
    live.applyWeatherAlerts("vpws50", [], new Date(T0 + 60_000).toISOString(), "2", T0 + 60_000);
    new StandbyPersistence(path).save(live.exportActiveState());

    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 120_000);
    expect(restarted.snapshotWeatherAlerts()).toEqual([]);
    expect(restarted.exportActiveState().weatherAlerts).toEqual([]);
  });

  it("実 VXKO50 を store に適用して実ファイルへ書き、新しい store で河川カードを復元する", () => {
    const msg = createMockWsDataMessage("16_10_01_260312_VXKO50.xml");
    const parsed = parseFloodForecast(msg);
    expect(parsed).not.toBeNull();
    if (parsed == null) return;
    const outcome: FloodForecastOutcome = {
      domain: "floodForecast",
      msg,
      headType: msg.head.type,
      statsCategory: "floodForecast",
      parsed,
      diff: null,
      maxLevel: "unknown",
      maxRank: -1,
      stats: { shouldRecord: true, eventId: parsed.eventId },
      presentation: { frameLevel: "info" },
    };
    const event = {
      ...fromFloodForecastOutcome(outcome),
      reportDateTime: new Date(T0).toISOString(),
    };
    const live = new StandbyStateStore();
    live.applyEvent(event, T0);
    expect(live.snapshotItems().find((item) => item.kind === "flood")).toBeDefined();

    const path = tempPath();
    new StandbyPersistence(path).save(live.exportActiveState());
    const loaded = new StandbyPersistence(path).load();
    const restarted = new StandbyStateStore();
    restarted.restoreActiveState(loaded!, T0 + 60_000);

    const flood = restarted.snapshotItems().find((item) => item.kind === "flood");
    expect(flood).toEqual(expect.objectContaining({
      restored: true,
      data: { rivers: expect.arrayContaining([
        expect.objectContaining({ riverName: "緑川", level: "L4" }),
      ]) },
    }));
  });

  it("未失効 state を restored=true で復元し export できる", () => {
    const store = new StandbyStateStore();
    store.restoreActiveState(state(), T0 + 60_000);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ kind: "heat", restored: true }));
    expect(store.exportActiveState()).toEqual(expect.objectContaining({
      version: 1,
      heat: [expect.objectContaining({ key: "heat:2026-07-21", revision: { reportTimeMs: T0, serial: "1" } })],
      seen: [expect.objectContaining({ key: "heat:2026-07-21" })],
    }));
  });

  it("絶対期限切れ state と tombstone を復元しない", () => {
    const expiredAt = T0 + 24 * 60 * 60_000;
    const store = new StandbyStateStore();
    store.restoreActiveState(state(), expiredAt);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.exportActiveState().seen).toEqual([]);
  });

  it("typhoon and volcano states survive an atomic persistence round trip", () => {
    const persisted = state({
      typhoons: [{
        key: "typhoon:TC-1", sourceEventId: "typhoon-1",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601",
          category: "TS", location: "ocean", pressureHpa: 990, pressureDeltaHpa: -5,
          maxWindMs: 25, maxWindDeltaMs: 3, intensityTrend: "developing",
          moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], alertRevision: { reportTimeMs: T0, serial: "1" }, eventRevision: { reportTimeMs: T0, serial: "1" } }],
    });
    const persistence = new StandbyPersistence(tempPath());
    persistence.save(persisted);
    const loaded = persistence.load();
    expect(loaded).toEqual(persisted);

    const store = new StandbyStateStore();
    store.restoreActiveState(loaded!, T0 + 60_000);
    expect(store.snapshotItems().map((item) => item.kind).sort()).toEqual(["heat", "typhoon", "volcano"]);
    expect(store.snapshotItems().every((item) => item.restored)).toBe(true);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: -5, maxWindDeltaMs: 3, intensityTrend: "developing",
    });

    store.applyEvent({
      id: "typhoon-2",
      domain: "typhoonAnalysis",
      eventId: "TC-1",
      serial: "2",
      reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false,
      raw: {
        type: "VPTW60",
        infoType: "issue",
        eventId: "TC-1",
        serial: "2",
        name: { name: "Alpha", nameKana: null, number: "2601", remark: null },
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TS" },
          center: { location: "ocean", pressureHpa: 985, moveDirection: "N", moveSpeedKmh: 20 },
          wind: { maxWindMs: 30 },
        }],
      },
    } as never, T0 + 120_000);
    expect(store.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: -5, maxWindDeltaMs: 5, intensityTrend: "developing",
    });
  });

  it("差分 field のない旧 typhoon 永続化ファイルを読み、null 差分として復元する", () => {
    const path = tempPath();
    const legacy = state({
      typhoons: [{
        key: "typhoon:TC-1",
        sourceEventId: "typhoon-1",
        typhoon: {
          typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601",
          category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25,
          moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString(),
        },
        revision: { reportTimeMs: T0, serial: "1" },
        expiresAtMs: T0 + 24 * 60 * 60_000,
      }],
    });
    new StandbyPersistence(path).save(legacy);

    const loaded = new StandbyPersistence(path).load();
    expect(loaded?.typhoons[0]?.typhoon).not.toHaveProperty("pressureDeltaHpa");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded!, T0 + 60_000);
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0]).toMatchObject({
      pressureDeltaHpa: null, maxWindDeltaMs: null, intensityTrend: null,
    });
  });

  it("failed seed retains restored volcano state; empty success clears its alert but keeps the eruption and emits a change", () => {
    const persisted = state({
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], alertRevision: { reportTimeMs: T0, serial: "1" }, eventRevision: { reportTimeMs: T0, serial: "1" } }],
    });
    const store = new StandbyStateStore();
    const changed = vi.fn();
    store.restoreActiveState(persisted, T0 + 60_000);
    store.onChange(changed);

    expect(store.seedVolcanoAlerts([], "failed", T0 + 60_000)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ kind: "volcano", restored: true }));
    expect(store.seedVolcanoAlerts([], "success", T0 + 60_000)).toEqual({ viewChanged: true, durableChanged: true });
    expect(changed).toHaveBeenCalledTimes(1);
    const volcano = store.snapshotItems().find((item) => item.kind === "volcano");
    expect(volcano).toEqual(expect.objectContaining({ restored: true, data: { volcanoes: [expect.objectContaining({ alertLevel: null, latestEvent: "flash" })] } }));
  });

  it("keeps an aggregated heat card restored while any area still comes from persistence", () => {
    const persisted = state({
      heat: [
        ...state().heat,
        { ...state().heat[0], key: "heat:2026-07-21:長崎県", sourceEventIds: ["heat-2"], areas: [{ areaName: "長崎県", isSpecial: false }] },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "heat-live", domain: "heatAlert", eventId: null, serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "熱中症警戒アラート", publishingOffice: "環境省 気象庁", areaItems: [],
      raw: { type: "VPFT50", infoType: "発表", targetDateTime: new Date(T0).toISOString(), serial: "2", targetAreaName: "東京都" },
    } as never, T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "heat")?.restored).toBe(true);
  });

  it("keeps an aggregated tornado card restored while any office still comes from persistence", () => {
    const persisted = state({
      tornado: [
        { publishingOffice: "東京管区気象台", sourceEventId: "tornado-1", areas: ["東京都"], isSighted: false, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000 },
        { publishingOffice: "長崎地方気象台", sourceEventId: "tornado-2", areas: ["長崎県"], isSighted: false, revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 60 * 60_000 },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "tornado-live", domain: "tornado", eventId: null, serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "竜巻注意情報", publishingOffice: "東京管区気象台", areaItems: [{ name: "東京都" }],
      raw: { serial: "2", publishingOffice: "東京管区気象台", activeAreaCount: 1, hasSightingAreas: false, validDateTime: new Date(T0 + 60 * 60_000).toISOString() },
    } as never, T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.restored).toBe(true);
  });

  it("keeps an aggregated typhoon card restored while any typhoon still comes from persistence", () => {
    const base = {
      key: "typhoon:TC-1", sourceEventId: "typhoon-1",
      typhoon: { typhoonKey: "TC-1", name: "Alpha", nameKana: null, remark: null, typhoonNumber: "2601", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: new Date(T0).toISOString() },
      revision: { reportTimeMs: T0, serial: "1" }, expiresAtMs: T0 + 24 * 60 * 60_000,
    };
    const persisted = state({
      typhoons: [
        base,
        { ...base, key: "typhoon:TC-2", sourceEventId: "typhoon-2", typhoon: { ...base.typhoon, typhoonKey: "TC-2", typhoonNumber: "2602" } },
      ],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.applyEvent({
      id: "typhoon-live", domain: "typhoonAnalysis", eventId: "TC-1", serial: "2", reportDateTime: new Date(T0 + 120_000).toISOString(),
      isCancellation: false, title: "台風解析・予報情報", publishingOffice: "気象庁", areaItems: [],
      raw: { type: "VPTW60", infoType: "発表", eventId: "TC-1", serial: "2", name: { name: "Alpha", nameKana: null, number: "2601", remark: null }, frames: [{ kind: "実況", label: "実況", validTime: new Date(T0 + 120_000).toISOString(), typhoonClass: { category: "TS", intensity: null, size: null }, center: { location: "ocean", coordinate: null, forecastCircleRadiusKm: null, moveDirection: "N", moveSpeedKmh: 20, pressureHpa: 985 }, wind: null }] },
    } as never, T0 + 120_000);

    const item = store.snapshotItems().find((i) => i.kind === "typhoon");
    expect(item?.restored).toBe(true);
  });

  it("keeps a restored volcano event marked when an authoritative alert seed arrives", () => {
    const persisted = state({
      volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, alertExpiresAtMs: null, latestEvent: "flash", eventExpiresAtMs: T0 + 24 * 60 * 60_000, sourceEventIds: ["volcano-1"], alertRevision: { reportTimeMs: T0, serial: "1" }, eventRevision: { reportTimeMs: T0, serial: "1" } }],
    });
    const store = new StandbyStateStore();
    store.restoreActiveState(persisted, T0 + 60_000);

    store.seedVolcanoAlerts([{ volcanoCode: "V-1", volcanoName: "Mount Test", alertLevel: 4, reportDateTime: new Date(T0 + 120_000).toISOString() }], "success", T0 + 120_000);

    expect(store.snapshotItems().find((item) => item.kind === "volcano")?.restored).toBe(true);
  });
});

describe("StandbyPersistence の遅延保存", () => {
  it("schedule しただけでは書かない (同期 I/O を受信経路から外す)", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state());

    expect(existsSync(path)).toBe(false);
  });

  it("debounce 経過後に書かれ、内容は最後に schedule した状態になる", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10);

    persistence.schedule(state({ savedAt: "first" }));
    persistence.schedule(state({ savedAt: "second" }));
    persistence.schedule(state({ savedAt: "latest" }));

    await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 3000 });
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("latest");
  });

  it("flush は予約済みの状態を即座に書き切る (終了時の取りこぼし防止)", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);

    persistence.schedule(state({ savedAt: "pending" }));
    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("pending");
  });

  it("flush 後は予約が消え、残ったタイマーが発火しても書き直さない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10);

    persistence.schedule(state());
    persistence.flush();
    rmSync(path);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(existsSync(path)).toBe(false);
  });

  it("予約がないときの flush は既存ファイルを壊さない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "kept" }));
    persistence.flush();

    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("kept");
  });
});

// 同期保存 (シャットダウン経路) と debounce の非同期書き込みが同じ tmp を奪い合い、
// 古い非同期書き込みが後から rename して最終状態を巻き戻す不具合の回帰テスト。
// 実時間には頼らず、__test_writePending() で予約分を任意のタイミングで走らせる
describe("StandbyPersistence の書き込み順序", () => {
  const tmpFiles = (path: string): string[] =>
    readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"));

  it("追い越された書き込みは rename しない (同期保存が後勝ちされない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));
    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");

    await persistence.__test_writePending();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  it("非同期書き込みの進行中に同期保存が割り込んでも旧内容で上書きしない", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));

    // 書き込みを開始させ、完了を待たずに同期保存を割り込ませる
    const inFlight = persistence.__test_writePending();
    persistence.save(state({ savedAt: "new" }));
    await inFlight;

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  it("追い越された書き込みの後も次の保存が反映される (rename 済み seq が逆行しない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));
    await persistence.__test_writePending();

    persistence.save(state({ savedAt: "newest" }));

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("newest");
  });

  it("予約が同期保存より新しい場合は通常どおり書かれる", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.save(state({ savedAt: "old" }));
    persistence.schedule(state({ savedAt: "new" }));

    await persistence.__test_writePending();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
  });

  it("同期保存と非同期書き込みは別々の tmp を使う (奪い合いを構造的に消す)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const syncWrite = vi.spyOn(fs, "writeFileSync");
    const asyncWrite = vi.spyOn(fs.promises, "writeFile");
    try {
      persistence.schedule(state({ savedAt: "old" }));
      persistence.save(state({ savedAt: "new" }));
      await persistence.__test_writePending();

      const syncTmp = syncWrite.mock.calls.map((call) => String(call[0]));
      const asyncTmp = asyncWrite.mock.calls.map((call) => String(call[0]));
      expect(syncTmp).toHaveLength(1);
      expect(asyncTmp).toHaveLength(1);
      expect(asyncTmp[0]).not.toBe(syncTmp[0]);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(tmpFiles(path)).toEqual([]);
    } finally {
      syncWrite.mockRestore();
      asyncWrite.mockRestore();
    }
  });

  it("同期保存より古い予約は flush で書き戻されない", () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    persistence.schedule(state({ savedAt: "old" }));
    persistence.save(state({ savedAt: "new" }));

    persistence.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("new");
    expect(tmpFiles(path)).toEqual([]);
  });

  // seq の判定と rename の間に await があると、guard 通過後・rename 完了前に同期保存が
  // 割り込み、古い rename が後から旧内容で上書きする。非同期 rename を使わないことで担保する
  it("rename は同期で行う (seq 判定との間に await を挟まない)", async () => {
    const path = tempPath();
    const persistence = new StandbyPersistence(path, 10_000);
    const rename = vi.spyOn(fs.promises, "rename");
    try {
      persistence.schedule(state({ savedAt: "written" }));
      await persistence.__test_writePending();

      expect(JSON.parse(readFileSync(path, "utf8")).savedAt).toBe("written");
      expect(rename).not.toHaveBeenCalled();
    } finally {
      rename.mockRestore();
    }
  });

  it("load 時に自分の残留 tmp だけを掃除する (無関係な .tmp は消さない)", () => {
    const path = tempPath();
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path}.3.tmp`, "{}", "utf8");
    writeFileSync(`${path}.8.tmp`, "{}", "utf8");
    writeFileSync(join(dir, "other.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "weather-promotion-v1.json.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "unrelated.txt"), "keep", "utf8");

    new StandbyPersistence(path).load();

    expect(existsSync(`${path}.3.tmp`)).toBe(false);
    expect(existsSync(`${path}.8.tmp`)).toBe(false);
    expect(existsSync(join(dir, "other.tmp"))).toBe(true);
    expect(existsSync(join(dir, "weather-promotion-v1.json.tmp"))).toBe(true);
    expect(existsSync(join(dir, "unrelated.txt"))).toBe(true);
  });
});
