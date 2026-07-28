import { describe, expect, it, vi } from "vitest";
import { RevisionGuard, StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { ParsedFloodForecastInfo, ParsedHeatAlertInfo, ParsedTyphoonAnalysis, ParsedVolcanoInfo } from "../../../src/types";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");

function heatRaw(over: Partial<ParsedHeatAlertInfo> = {}): ParsedHeatAlertInfo {
  return {
    type: "VPFT50",
    infoType: "発表",
    title: "東京都熱中症警戒アラート",
    controlTitle: "熱中症警戒アラート",
    reportDateTime: "2026-07-21T05:00:00+09:00",
    targetDateTime: "2026-07-21T05:00:00+09:00",
    headline: null,
    publishingOffice: "環境省 気象庁",
    editorialOffice: "環境省 気象庁",
    eventId: null,
    serial: "1",
    targetAreaName: "東京都",
    notice: null,
    bodyText: null,
    isTest: false,
    ...over,
  };
}

function heatEvent(over: Partial<PresentationEvent> = {}, rawOver: Partial<ParsedHeatAlertInfo> = {}): PresentationEvent {
  const raw = heatRaw(rawOver);
  return {
    id: "heat-1",
    classification: "meteorological",
    domain: "heatAlert",
    type: raw.type,
    infoType: raw.infoType,
    title: raw.title,
    controlTitle: raw.controlTitle,
    headline: raw.headline,
    reportDateTime: raw.reportDateTime,
    publishingOffice: raw.publishingOffice,
    isTest: raw.isTest,
    frameLevel: "warning",
    isCancellation: raw.infoType === "取消",
    eventId: raw.eventId,
    serial: raw.serial,
    areaNames: raw.targetAreaName == null ? [] : [raw.targetAreaName],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: raw.targetAreaName == null ? 0 : 1,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw,
    ...over,
  };
}

function quakeHostEvent(eventId: string, maxIntRank: number, timeMs: number): PresentationEvent {
  return heatEvent({
    id: `quake-${eventId}-${timeMs}`,
    domain: "earthquake",
    eventId,
    maxIntRank,
    reportDateTime: new Date(timeMs).toISOString(),
    raw: null,
  });
}

function longPeriodEvent(eventId: string, timeMs: number): PresentationEvent {
  return heatEvent({
    id: `long-period-${eventId}-${timeMs}`,
    domain: "lgObservation",
    eventId,
    reportDateTime: new Date(timeMs).toISOString(),
    raw: { maxLgInt: "3" },
  });
}

describe("RevisionGuard", () => {
  it("新しい revision だけを受理し、tombstone を期限まで保持する", () => {
    const guard = new RevisionGuard();
    expect(guard.accept("heat:2026-07-21", { reportTimeMs: T0, serial: "1" }, T0)).toBe(true);
    expect(guard.accept("heat:2026-07-21", { reportTimeMs: T0, serial: "1" }, T0 + 1)).toBe(false);
    expect(guard.accept("heat:2026-07-21", { reportTimeMs: T0 - 1, serial: "9" }, T0 + 1)).toBe(false);
    expect(guard.sweep(T0 + 24 * 60 * 60_000 - 1)).toBe(false);
    expect(guard.sweep(T0 + 24 * 60 * 60_000)).toBe(true);
  });
});

describe("StandbyStateStore: earthquake host", () => {
  it("TTL 中の強い quakeHost と rider を弱い別地震で置換しない", () => {
    const store = new StandbyStateStore();
    expect(store.applyEvent(quakeHostEvent("Q1", 5, T0), T0).durableChanged).toBe(true);
    expect(store.applyEvent(longPeriodEvent("Q1", T0 + 1), T0 + 1).viewChanged).toBe(true);

    expect(store.applyEvent(quakeHostEvent("Q2", 2, T0 + 60_000), T0 + 60_000))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(store.exportActiveState().quakeHost).toMatchObject({ eventId: "Q1", maxIntRank: 5 });
    expect(store.snapshotItems()).toEqual([
      expect.objectContaining({ kind: "longPeriod", data: { eventId: "Q1", maxLgInt: "3" } }),
    ]);
  });
});

describe("StandbyStateStore: heat", () => {
  it("VPFT50 受信でカードが立ち、対象日24:00 JSTで失効する", () => {
    const store = new StandbyStateStore();
    const mutation = store.applyEvent(heatEvent(), T0);
    expect(mutation).toEqual({ viewChanged: true, durableChanged: true });
    expect(store.snapshotItems()).toEqual([
      expect.objectContaining({
        kind: "heat",
        key: "heat:2026-07-21",
        expiresAt: "2026-07-21T15:00:00.000Z",
        restored: false,
        severity: "warning",
        data: { targetDate: "2026-07-21", areas: [{ areaName: "東京都", isSpecial: false }] },
      }),
    ]);
    expect(store.sweep(T0 + 60 * 60_000).viewChanged).toBe(false);
    expect(store.sweep(Date.parse("2026-07-22T00:00:00+09:00"))).toEqual({ viewChanged: true, durableChanged: true });
    expect(store.snapshotItems()).toEqual([]);
  });

  it("重複・古い報を破棄し TTL を延長しない", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heatEvent(), T0);
    expect(store.applyEvent(heatEvent({}, { serial: "1" }), T0 + 1)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.applyEvent(heatEvent({}, { reportDateTime: "2026-07-21T04:00:00+09:00", serial: "9" }), T0 + 1))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotItems()[0].expiresAt).toBe("2026-07-21T15:00:00.000Z");
  });

  it("取消で消灯し、取消より古い発表を再送しても復活しない", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heatEvent(), T0);
    const cancelTime = T0 + 60_000;
    expect(store.applyEvent(heatEvent({ isCancellation: true }, {
      infoType: "取消", reportDateTime: new Date(cancelTime).toISOString(), serial: "2",
    }), cancelTime).viewChanged).toBe(true);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.applyEvent(heatEvent({}, { serial: "1" }), cancelTime + 1).viewChanged).toBe(false);
    expect(store.snapshotItems()).toEqual([]);
  });

  it("特別警戒タイトルは critical になり、targetDateTime 欠落時は報受信日のJST日末を使う", () => {
    const store = new StandbyStateStore();
    store.applyEvent(heatEvent({ title: "熱中症特別警戒アラート" }, { targetDateTime: null }), T0);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ severity: "critical", expiresAt: "2026-07-21T15:00:00.000Z" }));
  });

  it("view/durable の listener は対応する変更時だけ呼ばれる", () => {
    const store = new StandbyStateStore();
    const onChange = vi.fn();
    const onDurable = vi.fn();
    store.onChange(onChange);
    store.onDurable(onDurable);
    store.applyEvent(heatEvent(), T0);
    store.applyEvent(heatEvent(), T0 + 1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onDurable).toHaveBeenCalledTimes(1);
  });
});

function typhoonRaw(over: Record<string, unknown> = {}): ParsedTyphoonAnalysis {
  return {
    type: "VPTW60",
    infoType: "issue",
    eventId: "TC-1",
    serial: "1",
    name: { name: "Alpha", nameKana: "ALPHA", number: "2601", remark: null },
    frames: [{
      kind: "analysis",
      typhoonClass: { category: "TS" },
      center: { location: "ocean", pressureHpa: 990, moveDirection: "N", moveSpeedKmh: 20 },
      wind: { maxWindMs: 25 },
    }],
    ...over,
  } as unknown as ParsedTyphoonAnalysis;
}

function typhoonEvent(over: Record<string, unknown> = {}, rawOver: Record<string, unknown> = {}): PresentationEvent {
  const raw = typhoonRaw(rawOver);
  return {
    id: "typhoon-1",
    domain: "typhoonAnalysis",
    eventId: raw.eventId,
    serial: raw.serial,
    reportDateTime: "2026-07-21T05:00:00+09:00",
    isCancellation: false,
    raw,
    ...over,
  } as unknown as PresentationEvent;
}

function volcanoRaw(over: Record<string, unknown> = {}): ParsedVolcanoInfo {
  return {
    kind: "alert",
    type: "VFVO50",
    infoType: "issue",
    volcanoCode: "V-1",
    volcanoName: "Mount Test",
    alertLevel: 4,
    alertLevelCode: "4",
    previousLevelCode: "3",
    ...over,
  } as unknown as ParsedVolcanoInfo;
}

function volcanoEvent(over: Record<string, unknown> = {}, rawOver: Record<string, unknown> = {}): PresentationEvent {
  const raw = volcanoRaw(rawOver);
  return {
    id: "volcano-1",
    domain: "volcano",
    serial: "1",
    reportDateTime: "2026-07-21T05:00:00+09:00",
    isCancellation: false,
    raw,
    ...over,
  } as unknown as PresentationEvent;
}

describe("StandbyStateStore: typhoon", () => {
  it("receives, replaces, and aggregates typhoons by TC key", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent(), T0);
    store.applyEvent(typhoonEvent({ id: "typhoon-1-revision", serial: "2", reportDateTime: new Date(T0 + 60_000).toISOString() }, {
      serial: "2",
      frames: [{ kind: "analysis", typhoonClass: { category: "TY" }, center: { location: "near land", pressureHpa: 975, moveDirection: "NE", moveSpeedKmh: 30 }, wind: { maxWindMs: 35 } }],
    }), T0 + 60_000);
    store.applyEvent(typhoonEvent({ id: "typhoon-2", eventId: "TC-2", serial: "1" }, { eventId: "TC-2", name: { name: "Beta", nameKana: null, number: "2602", remark: null } }), T0 + 60_000);

    const item = store.snapshotItems().find((candidate) => candidate.kind === "typhoon");
    expect(item?.data.typhoons).toEqual([
      expect.objectContaining({ typhoonKey: "TC-1", pressureHpa: 975, category: "TY" }),
      expect.objectContaining({ typhoonKey: "TC-2", name: "Beta" }),
    ]);
  });

  it("does not extend TTL for a stale resend, expires after 24 hours, and keeps cancellation tombstones", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent(), T0);
    store.applyEvent(typhoonEvent({ id: "typhoon-stale", reportDateTime: new Date(T0 - 60_000).toISOString(), serial: "9" }, { serial: "9" }), T0 + 60_000);
    expect(store.snapshotItems()[0]).toEqual(expect.objectContaining({ expiresAt: new Date(T0 + 24 * 60 * 60_000).toISOString() }));
    expect(store.sweep(T0 + 24 * 60 * 60_000)).toEqual({ viewChanged: true, durableChanged: true });

    store.applyEvent(typhoonEvent({ id: "typhoon-new", reportDateTime: new Date(T0 + 25 * 60 * 60_000).toISOString(), serial: "10" }, { serial: "10" }), T0 + 25 * 60 * 60_000);
    store.applyEvent(typhoonEvent({ id: "typhoon-cancel", isCancellation: true, reportDateTime: new Date(T0 + 25 * 60 * 60_000 + 60_000).toISOString(), serial: "11" }, { serial: "11", infoType: "cancel" }), T0 + 25 * 60 * 60_000 + 60_000);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.applyEvent(typhoonEvent({ id: "typhoon-old", serial: "10" }, { serial: "10" }), T0 + 25 * 60 * 60_000 + 60_001)).toEqual({ viewChanged: false, durableChanged: false });
  });
});

describe("StandbyStateStore: volcano", () => {
  it("keeps level 4 until lowered, while a level increase has a 24-hour lifetime", () => {
    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent(), T0);
    expect(store.snapshotItems()).toEqual([expect.objectContaining({ kind: "volcano", expiresAt: null })]);
    expect(store.sweep(T0 + 48 * 60 * 60_000).viewChanged).toBe(false);

    store.applyEvent(volcanoEvent({ id: "volcano-lower", serial: "2", reportDateTime: new Date(T0 + 48 * 60 * 60_000).toISOString() }, {
      alertLevel: 2, alertLevelCode: "2", previousLevelCode: "4",
    }), T0 + 48 * 60 * 60_000);
    expect(store.snapshotItems()).toEqual([]);

    const raisedAt = T0 + 49 * 60 * 60_000;
    store.applyEvent(volcanoEvent({ id: "volcano-raise", serial: "3", reportDateTime: new Date(raisedAt).toISOString() }, {
      alertLevel: 3, alertLevelCode: "3", previousLevelCode: "2",
    }), raisedAt);
    expect(store.snapshotItems()).toEqual([expect.objectContaining({ kind: "volcano", expiresAt: new Date(raisedAt + 24 * 60 * 60_000).toISOString() })]);
    store.sweep(raisedAt + 24 * 60 * 60_000);
    expect(store.snapshotItems()).toEqual([]);
  });

  it("keeps a flash eruption for 24 hours, ignores steady level 2, and rejects an old level 4 after lowering", () => {
    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent({ serial: "1" }, { alertLevel: 2, alertLevelCode: "2", previousLevelCode: "2" }), T0);
    expect(store.snapshotItems()).toEqual([]);

    const eruptionAt = T0 + 60_000;
    store.applyEvent(volcanoEvent({ id: "flash", serial: "2", reportDateTime: new Date(eruptionAt).toISOString() }, {
      kind: "eruption", type: "VFVO52", isFlashReport: true, phenomenonName: "flash",
    }), eruptionAt);
    expect(store.snapshotItems()).toEqual([expect.objectContaining({ kind: "volcano", expiresAt: new Date(eruptionAt + 24 * 60 * 60_000).toISOString() })]);
    store.sweep(eruptionAt + 24 * 60 * 60_000);
    expect(store.snapshotItems()).toEqual([]);

    const loweredAt = eruptionAt + 25 * 60 * 60_000;
    store.applyEvent(volcanoEvent({ id: "level-four", serial: "3", reportDateTime: new Date(loweredAt).toISOString() }, { alertLevel: 4, alertLevelCode: "4", previousLevelCode: "2" }), loweredAt);
    store.applyEvent(volcanoEvent({ id: "lowered", serial: "4", reportDateTime: new Date(loweredAt + 60_000).toISOString() }, { alertLevel: 2, alertLevelCode: "2", previousLevelCode: "4" }), loweredAt + 60_000);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.applyEvent(volcanoEvent({ id: "old-level-four", serial: "3" }, { alertLevel: 4, alertLevelCode: "4", previousLevelCode: "2" }), loweredAt + 60_001)).toEqual({ viewChanged: false, durableChanged: false });
  });
});

describe("StandbyStateStore: flood", () => {
  it("delegates flood events to FloodActiveReducer and exposes the aggregate card", () => {
    const raw: ParsedFloodForecastInfo = {
      schema: "vxko50", typeCode: "VXKO50", infoKind: "指定河川洪水予報", infoType: "発表",
      serial: 1, eventId: "flood-event", controlTitle: "指定河川洪水予報", headTitle: "多摩川氾濫警戒情報",
      reportDateTime: new Date(T0).toISOString(), targetDateTime: null, isTest: false, notice: null,
      headlines: [{ scope: "河川", rawScopeLabel: "河川", kindName: "氾濫警戒情報", kindCode: "30", headlineText: "多摩川氾濫警戒情報", condition: "", areas: [{ name: "多摩川", code: "river-1" }] }],
      rawStations: [{
        stationName: "観測所", stationCode: "station-1", riverNames: ["多摩川"], primaryRiverCode: "river-1", primaryRiverName: "多摩川",
        prefName: null, cityName: null, cityCode: null, location: null, measurement: "water_level", measurementUnit: "m", rawUnit: "m", series: [],
        criteria: { L1: null, L2: null, L3: null, L4: null, L4Plan: null, unit: "m", rawUnit: "m" },
        stationObservedLevel: "L3", headlineKindCode: "30", headlineLevel: "L3", mainItemCode: "1", mainTextHash: "hash",
      }],
      inundationAreas: [], rainfallSummaries: [], floodAssumptions: [], publishingOffice: "気象庁", editorialOffice: "気象庁",
    };
    const presentation = heatEvent({
      id: "flood-message", domain: "floodForecast", type: "VXKO50", infoType: "発表", title: raw.headTitle,
      reportDateTime: raw.reportDateTime, eventId: raw.eventId, serial: "1", raw,
    });
    const store = new StandbyStateStore();

    expect(store.applyEvent(presentation, T0)).toEqual({ viewChanged: true, durableChanged: true });
    expect(store.snapshotItems()).toEqual([expect.objectContaining({
      kind: "flood", key: "flood:active", surface: "corner-right",
      data: { rivers: [expect.objectContaining({ riverKey: "river-1", riverName: "多摩川", level: "L3" })] },
    })]);
  });
});
