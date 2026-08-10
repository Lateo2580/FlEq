import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, expect, it, vi } from "vitest";
import { parseTyphoonAnalysis } from "../../../src/dmdata/typhoon-analysis-parser";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import * as log from "../../../src/logger";
import { RevisionGuard, StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type {
  JmaIntensity,
  JmaLgIntensity,
  ParsedFloodForecastInfo,
  ParsedHeatAlertInfo,
  ParsedLgObservationInfo,
  ParsedTyphoonAnalysis,
  ParsedVolcanoInfo,
  SpecialValue,
} from "../../../src/types";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO51_EXTRA,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFVO56_FLASH_4,
  FIXTURE_VPTW60_2020,
  FIXTURE_VPTW61,
  FIXTURE_VXKO50_16_05_01,
  FIXTURE_VXKO50_16_14_01,
} from "../../helpers/mock-message";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");

function heatRaw(over: Partial<ParsedHeatAlertInfo> = {}): ParsedHeatAlertInfo {
  return {
    meta: testTelegramMeta(false),
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

function quakeHostEvent(
  eventId: string,
  maxIntRank: number | null,
  timeMs: number,
  over: Partial<PresentationEvent> = {},
): PresentationEvent {
  return heatEvent({
    id: `quake-${eventId}-${timeMs}`,
    domain: "earthquake",
    eventId,
    maxIntRank,
    reportDateTime: new Date(timeMs).toISOString(),
    raw: null,
    ...over,
  });
}

function longPeriodEvent(
  eventId: string,
  timeMs: number,
  over: { maxLgInt?: string | null; maxLgIntValue?: SpecialValue<JmaLgIntensity> } = {},
): PresentationEvent {
  const reportDateTime = new Date(timeMs).toISOString();
  const maxLgInt = over.maxLgInt === undefined ? "3" : over.maxLgInt;
  const raw: ParsedLgObservationInfo = {
    meta: testTelegramMeta(false),
    type: "VXSE62",
    infoType: "発表",
    title: "長周期地震動に関する観測情報",
    reportDateTime,
    headline: null,
    publishingOffice: "気象庁",
    ...(maxLgInt == null ? {} : { maxLgInt }),
    ...(over.maxLgIntValue == null ? {} : { maxLgIntValue: over.maxLgIntValue }),
    areas: [],
    isTest: false,
  };
  return heatEvent({
    id: `long-period-${eventId}-${timeMs}`,
    domain: "lgObservation",
    type: raw.type,
    eventId,
    reportDateTime,
    maxLgInt,
    ...(over.maxLgIntValue == null ? {} : { maxLgIntValue: over.maxLgIntValue }),
    raw,
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

  it("訂正だけは同一 revision の置換を許可し、通常の重複は拒否する", () => {
    const guard = new RevisionGuard();
    const revision = { reportTimeMs: T0, serial: "1" };
    expect(guard.accept("typhoon:TC-1", revision, T0)).toBe(true);
    expect(guard.accept("typhoon:TC-1", revision, T0 + 1)).toBe(false);
    expect(guard.accept("typhoon:TC-1", revision, T0 + 2, undefined, true)).toBe(true);
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

  it("5弱以上未入電を safety rank 5 の host として保持し、弱い別地震へ明け渡さない", () => {
    const qualitative: SpecialValue<JmaIntensity> = {
      raw: "5弱以上未入電", value: null, condition: "5弱以上未入電",
      description: null, presence: "qualitative", lowerBound: "5-",
    };
    const store = new StandbyStateStore();
    expect(store.applyEvent(quakeHostEvent("Q1", null, T0, {
      maxInt: null,
      maxIntValue: qualitative,
    }), T0).durableChanged).toBe(true);
    expect(store.applyEvent(longPeriodEvent("Q1", T0 + 1), T0 + 1).viewChanged).toBe(true);
    expect(store.applyEvent(quakeHostEvent("Q2", 2, T0 + 60_000), T0 + 60_000))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(store.exportActiveState().quakeHost).toMatchObject({ eventId: "Q1", maxIntRank: 5 });
  });

  it("overall missingでも採用した地域震度7をstandby hostとTTLへ使う", () => {
    const missing: SpecialValue<JmaIntensity> = {
      raw: null, value: null, condition: null, description: null, presence: "missing",
    };
    const local: SpecialValue<JmaIntensity> = {
      raw: "7", value: "7", condition: null, description: null, presence: "value",
    };
    const store = new StandbyStateStore();
    expect(store.applyEvent(quakeHostEvent("Q-local-7", null, T0, {
      maxInt: null,
      maxIntValue: missing,
      areaItems: [{ name: "地域A", code: "440", maxInt: "7", maxIntValue: local }],
      quakeIntensityValues: {
        localAreas: [{ name: "地域A", code: "440", maxIntValue: local }],
        municipalities: [],
      },
    }), T0)).toEqual({ viewChanged: false, durableChanged: true });
    expect(store.exportActiveState().quakeHost).toMatchObject({
      eventId: "Q-local-7",
      maxIntRank: 9,
      expiresAtMs: T0 + 30 * 60_000,
    });
  });

  it("explicit unknown does not fall back to a stale legacy rank for standby host", () => {
    const store = new StandbyStateStore();
    expect(store.applyEvent(quakeHostEvent("Q-unknown", 9, T0, {
      maxInt: null,
      maxIntValue: {
        raw: "未入電",
        value: null,
        condition: "未入電",
        description: null,
        presence: "unknown",
      },
    }), T0)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.exportActiveState().quakeHost).toBeNull();
  });

  it("earthquake cancellation clears its standby host and hosted long-period rider", () => {
    const store = new StandbyStateStore();
    store.applyEvent(quakeHostEvent("Q-cancel", 5, T0), T0);
    store.applyEvent(longPeriodEvent("Q-cancel", T0 + 1), T0 + 1);
    expect(store.snapshotItems()).toHaveLength(1);

    const cancelledAt = T0 + 60_000;
    expect(store.applyEvent(quakeHostEvent("Q-cancel", null, cancelledAt, {
      isCancellation: true,
      infoType: "取消",
      foundationMutationAccepted: true,
    }), cancelledAt)).toEqual({ viewChanged: true, durableChanged: true });
    expect(store.exportActiveState().quakeHost).toBeNull();
    expect(store.exportActiveState().longPeriod).toEqual([]);
    expect(store.snapshotItems()).toEqual([]);
  });

  it("foundation-rejected earthquake cancellation cannot clear standby state", () => {
    const store = new StandbyStateStore();
    store.applyEvent(quakeHostEvent("Q-rejected-cancel", 5, T0), T0);
    store.applyEvent(longPeriodEvent("Q-rejected-cancel", T0 + 1), T0 + 1);

    const cancelledAt = T0 + 60_000;
    expect(store.applyEvent(quakeHostEvent("Q-rejected-cancel", null, cancelledAt, {
      isCancellation: true,
      infoType: "取消",
      foundationMutationAccepted: false,
    }), cancelledAt)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.exportActiveState().quakeHost).toMatchObject({
      eventId: "Q-rejected-cancel",
      maxIntRank: 5,
    });
    expect(store.exportActiveState().longPeriod).toEqual([
      expect.objectContaining({ eventId: "Q-rejected-cancel", hosted: true }),
    ]);
    expect(store.snapshotItems()).toHaveLength(1);
  });

  it.each([
    ["range", {
      raw: "", value: null, condition: null, description: "階級2から4",
      presence: "range", lowerBound: "2", upperBound: "4",
    }, "2〜4"],
    ["qualitative", {
      raw: "", value: null, condition: null, description: null,
      presence: "qualitative", lowerBound: "4",
    }, "4以上"],
  ] as const)("長周期 %s 続報で rider の label・safety severity・永続状態を更新する", (
    _case,
    maxLgIntValue,
    label,
  ) => {
    const store = new StandbyStateStore();
    store.applyEvent(quakeHostEvent("Q1", 5, T0), T0);
    store.applyEvent(longPeriodEvent("Q1", T0 + 1), T0 + 1);
    store.applyEvent(longPeriodEvent("Q1", T0 + 2, {
      maxLgInt: null,
      maxLgIntValue: maxLgIntValue as SpecialValue<JmaLgIntensity>,
    }), T0 + 2);
    expect(store.snapshotItems()).toEqual([
      expect.objectContaining({
        kind: "longPeriod",
        severity: "critical",
        data: { eventId: "Q1", maxLgInt: label },
      }),
    ]);
    expect(store.exportActiveState().longPeriod?.[0]).toMatchObject({
      maxLgInt: label,
      safetyRank: 4,
    });

    const restored = new StandbyStateStore();
    restored.restoreActiveState(store.exportActiveState(), T0 + 3);
    expect(restored.snapshotItems()).toEqual([
      expect.objectContaining({
        kind: "longPeriod",
        severity: "critical",
        data: { eventId: "Q1", maxLgInt: label },
      }),
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
    lifecycle: "active",
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

function typhoonNumeric(
  over: Partial<SpecialValue<number>> = {},
): SpecialValue<number> {
  return {
    raw: "0",
    value: 0,
    condition: null,
    description: null,
    presence: "value",
    ...over,
  };
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

function parsedVolcanoEvent(
  fixture: string,
  over: Record<string, unknown> = {},
): PresentationEvent {
  const msg = createMockWsDataMessage(fixture);
  const raw = parseVolcanoTelegram(msg);
  if (raw == null) throw new Error(`${fixture} did not parse`);
  return {
    id: fixture,
    domain: "volcano",
    eventId: msg.xmlReport?.head?.eventId ?? null,
    serial: msg.xmlReport?.head?.serial ?? null,
    reportDateTime: raw.reportDateTime,
    infoType: raw.infoType,
    isCancellation: raw.infoType === "取消",
    raw,
    ...over,
  } as unknown as PresentationEvent;
}

describe("StandbyStateStore: typhoon", () => {
  function currentTyphoon(store: StandbyStateStore, key = "TC-1") {
    const item = store.snapshotItems().find((candidate) => candidate.kind === "typhoon");
    return item?.data.typhoons.find((typhoon) => typhoon.typhoonKey === key);
  }

  it("4 数値 canonical を label・badge・JSON-safe rank 付き protocol semantic へ一度だけ射影する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent({}, {
      frames: [{
        kind: "analysis",
        typhoonClass: { category: "TS" },
        center: {
          location: "ocean",
          pressureHpa: 990,
          pressureHpaValue: typhoonNumeric({ raw: "９９０", value: 990 }),
          moveDirection: "N",
          moveSpeedKmh: null,
          moveSpeedKmhValue: typhoonNumeric({
            raw: "",
            value: null,
            condition: "ほとんど停滞",
            description: null,
            presence: "qualitative",
          }),
        },
        wind: {
          maxWindMs: 25,
          maxWindMsValue: typhoonNumeric({
            raw: "25",
            value: null,
            condition: "以上",
            presence: "range",
            lowerBound: 25,
            rawLowerBound: "25",
            rawUpperBound: null,
          }),
          maxGustMs: null,
          maxGustMsValue: typhoonNumeric({
            raw: "不明",
            value: null,
            presence: "unknown",
            diagnostics: ["unmappedSpecialValue"],
          }),
        },
      }],
    }), T0);

    expect(currentTyphoon(store)).toMatchObject({
      pressureHpaSemantic: {
        raw: "９９０", label: "990hPa", presence: "value",
        lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
        badge: null, rank: { kind: "value", value: 990 },
      },
      maxWindMsSemantic: {
        label: "25m/s以上", presence: "range", badge: "≥",
        lowerBound: 25, upperBound: null, rawLowerBound: "25", rawUpperBound: null,
        rank: { kind: "range", lowerBound: 25, upperBound: null },
      },
      maxGustMsSemantic: {
        label: "不明", presence: "unknown", badge: "?", rank: { kind: "unranked" },
      },
      moveSpeedKmhSemantic: {
        label: "ほとんど停滞", presence: "qualitative", badge: "?",
        rank: { kind: "unranked" },
      },
    });
  });

  it("差分と trend は両端 value だけで算出し、exact 同値は 0/steady、gust は根拠にしない", () => {
    const frame = (
      pressureHpa: number,
      pressureHpaValue: SpecialValue<number>,
      maxWindMsValue: SpecialValue<number>,
      maxGustMsValue: SpecialValue<number>,
    ) => ({
      frames: [{
        kind: "analysis",
        typhoonClass: { category: "TS" },
        center: {
          location: "ocean", pressureHpa, pressureHpaValue,
          moveDirection: "N", moveSpeedKmh: 20,
          moveSpeedKmhValue: typhoonNumeric({ raw: "20", value: 20 }),
        },
        wind: {
          maxWindMs: maxWindMsValue.presence === "value" ? maxWindMsValue.value : 25,
          maxWindMsValue,
          maxGustMs: 80,
          maxGustMsValue,
        },
      }],
    });
    const exactWind = typhoonNumeric({ raw: "25", value: 25 });
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent({}, frame(
      990,
      typhoonNumeric({ raw: "990", value: 990 }),
      exactWind,
      typhoonNumeric({ raw: "30", value: 30 }),
    )), T0);

    store.applyEvent(typhoonEvent(
      { id: "typhoon-unknown", serial: "2", reportDateTime: new Date(T0 + 60_000).toISOString() },
      {
        serial: "2",
        ...frame(
          980,
          typhoonNumeric({ raw: "解析不能", value: null, presence: "unknown" }),
          exactWind,
          typhoonNumeric({ raw: "80", value: 80 }),
        ),
      },
    ), T0 + 60_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: null,
      maxWindDeltaMs: 0,
      intensityTrend: null,
    });

    store.applyEvent(typhoonEvent(
      { id: "typhoon-value", serial: "3", reportDateTime: new Date(T0 + 120_000).toISOString() },
      {
        serial: "3",
        ...frame(
          970,
          typhoonNumeric({ raw: "970", value: 970 }),
          exactWind,
          typhoonNumeric({ raw: "不明", value: null, presence: "unknown" }),
        ),
      },
    ), T0 + 120_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: null,
      maxWindDeltaMs: 0,
      intensityTrend: null,
    });

    store.applyEvent(typhoonEvent(
      { id: "typhoon-steady-raw-variant", serial: "4", reportDateTime: new Date(T0 + 180_000).toISOString() },
      {
        serial: "4",
        ...frame(
          970,
          typhoonNumeric({ raw: "９７０", value: 970 }),
          typhoonNumeric({ raw: "２５", value: 25 }),
          typhoonNumeric({ raw: "100", value: 100 }),
        ),
      },
    ), T0 + 180_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: 0,
      maxWindDeltaMs: 0,
      intensityTrend: "steady",
    });

    store.applyEvent(typhoonEvent(
      { id: "typhoon-conflicting-trend", serial: "5", reportDateTime: new Date(T0 + 240_000).toISOString() },
      {
        serial: "5",
        ...frame(
          965,
          typhoonNumeric({ raw: "965", value: 965 }),
          typhoonNumeric({ raw: "20", value: 20 }),
          typhoonNumeric({ raw: "90", value: 90 }),
        ),
      },
    ), T0 + 240_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: -5,
      maxWindDeltaMs: -5,
      intensityTrend: "developing",
    });
  });

  it("同一時刻・同一 serial の VPTW60 訂正は置換し、非訂正の重複は拒否する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent({ infoType: "発表" }), T0);
    expect(currentTyphoon(store)?.pressureHpa).toBe(990);

    const corrected = store.applyEvent(typhoonEvent(
      { id: "typhoon-correction", infoType: "訂正" },
      {
        infoType: "訂正",
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TY" },
          center: { location: "ocean", pressureHpa: 970, moveDirection: "N", moveSpeedKmh: 20 },
          wind: { maxWindMs: 35 },
        }],
      },
    ), T0 + 1);
    expect(corrected).toEqual({ viewChanged: true, durableChanged: true });
    expect(currentTyphoon(store)?.pressureHpa).toBe(970);

    const duplicate = store.applyEvent(typhoonEvent(
      { id: "typhoon-duplicate", infoType: "発表" },
      {
        infoType: "発表",
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TY" },
          center: { location: "ocean", pressureHpa: 950, moveDirection: "N", moveSpeedKmh: 20 },
          wind: { maxWindMs: 45 },
        }],
      },
    ), T0 + 2);
    expect(duplicate).toEqual({ viewChanged: false, durableChanged: false });
    expect(currentTyphoon(store)?.pressureHpa).toBe(970);
  });

  it("projects parser intensity and size classes into the display card protocol", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent({}, {
      frames: [{ kind: "analysis", typhoonClass: { category: "TS", intensity: "非常に強い", size: "超大型" }, center: { location: "ocean", pressureHpa: 990, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 25 } }],
    }), T0);
    const item = store.snapshotItems().find((candidate) => candidate.kind === "typhoon");
    expect(item?.data.typhoons[0]).toMatchObject({ intensityClass: "非常に強い", sizeClass: "超大型" });
  });

  it("台風の最大階級を standby severity へ連動し、advisory 相当と階級なしは normal を保つ", () => {
    const severityFor = (intensity?: string, size?: string) => {
      const store = new StandbyStateStore();
      store.applyEvent(typhoonEvent({}, {
        frames: [{
          kind: "analysis",
          typhoonClass: { category: "TS", ...(intensity == null ? {} : { intensity }), ...(size == null ? {} : { size }) },
          center: { location: "ocean", pressureHpa: 990, moveDirection: "N", moveSpeedKmh: 20 },
          wind: { maxWindMs: 25 },
        }],
      }), T0);
      return store.snapshotItems().find((candidate) => candidate.kind === "typhoon")?.severity;
    };

    expect(severityFor()).toBe("normal");
    expect(severityFor("強い")).toBe("normal");
    expect(severityFor(undefined, "大型")).toBe("normal");
    expect(severityFor("非常に強い")).toBe("warning");
    expect(severityFor(undefined, "超大型")).toBe("warning");
    expect(severityFor("猛烈な")).toBe("critical");
  });

  it("複数台風は最大の階級を standby severity に採用する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent({}, {
      frames: [{ kind: "analysis", typhoonClass: { category: "TS", intensity: "非常に強い" }, center: { location: "ocean", pressureHpa: 990, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 25 } }],
    }), T0);
    store.applyEvent(typhoonEvent(
      { id: "typhoon-2" },
      {
        eventId: "TC-2",
        name: { name: "Beta", nameKana: "BETA", number: "2602", remark: null },
        frames: [{ kind: "analysis", typhoonClass: { category: "TS", intensity: "猛烈な" }, center: { location: "ocean", pressureHpa: 950, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 45 } }],
      },
    ), T0);

    expect(store.snapshotItems().find((candidate) => candidate.kind === "typhoon")?.severity).toBe("critical");
  });

  it("VPTW60 fixture の GustSpeed を最大瞬間風速として display protocol へ射影する", () => {
    const raw = parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2020));
    expect(raw?.frames[0]?.wind?.maxGustMs).toBe(23);

    const store = new StandbyStateStore();
    store.applyEvent(
      typhoonEvent({}, raw as unknown as Record<string, unknown>),
      T0,
    );

    expect(currentTyphoon(store, raw!.eventId!)).toMatchObject({ maxWindMs: 15, maxGustMs: 23 });
  });

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
      expect.objectContaining({
        typhoonKey: "TC-1", pressureHpa: 975, category: "TY",
        pressureDeltaHpa: -15, maxWindDeltaMs: 10, intensityTrend: "developing",
      }),
      expect.objectContaining({
        typhoonKey: "TC-2", name: "Beta",
        pressureDeltaHpa: null, maxWindDeltaMs: null, intensityTrend: null,
      }),
    ]);
  });

  it("初報は差分なしで、更新ごとに発達・衰弱・横ばいを算出する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent(), T0);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: null, maxWindDeltaMs: null, intensityTrend: null,
    });

    store.applyEvent(typhoonEvent(
      { id: "typhoon-developing", serial: "2", reportDateTime: new Date(T0 + 60_000).toISOString() },
      {
        serial: "2",
        frames: [{ kind: "analysis", typhoonClass: { category: "TY" }, center: { location: "ocean", pressureHpa: 975, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 35 } }],
      },
    ), T0 + 60_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: -15, maxWindDeltaMs: 10, intensityTrend: "developing",
    });

    store.applyEvent(typhoonEvent(
      { id: "typhoon-weakening", serial: "3", reportDateTime: new Date(T0 + 120_000).toISOString() },
      {
        serial: "3",
        frames: [{ kind: "analysis", typhoonClass: { category: "TS" }, center: { location: "ocean", pressureHpa: 980, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 30 } }],
      },
    ), T0 + 120_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: 5, maxWindDeltaMs: -5, intensityTrend: "weakening",
    });

    store.applyEvent(typhoonEvent(
      { id: "typhoon-steady", serial: "4", reportDateTime: new Date(T0 + 180_000).toISOString() },
      {
        serial: "4",
        frames: [{ kind: "analysis", typhoonClass: { category: "TS" }, center: { location: "ocean", pressureHpa: 980, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 30 } }],
      },
    ), T0 + 180_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: 0, maxWindDeltaMs: 0, intensityTrend: "steady",
    });
  });

  it("どちらかの比較値が欠損なら該当差分と総合 trend を null にする", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent({}, {
      frames: [{ kind: "analysis", typhoonClass: { category: "TS" }, center: { location: "ocean", pressureHpa: 990, moveDirection: "N", moveSpeedKmh: 20 }, wind: null }],
    }), T0);
    store.applyEvent(typhoonEvent(
      { id: "typhoon-wind-appears", serial: "2", reportDateTime: new Date(T0 + 60_000).toISOString() },
      {
        serial: "2",
        frames: [{ kind: "analysis", typhoonClass: { category: "TS" }, center: { location: "ocean", pressureHpa: 985, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 25 } }],
      },
    ), T0 + 60_000);
    expect(currentTyphoon(store)).toMatchObject({
      pressureDeltaHpa: -5, maxWindDeltaMs: null, intensityTrend: null,
    });
  });

  it("取消後・期限切れ後の再登場は前回値なしとして扱う", () => {
    const cancelled = new StandbyStateStore();
    cancelled.applyEvent(typhoonEvent(), T0);
    cancelled.applyEvent(typhoonEvent(
      { id: "typhoon-cancel", isCancellation: true, serial: "2", reportDateTime: new Date(T0 + 60_000).toISOString() },
      { serial: "2", infoType: "cancel" },
    ), T0 + 60_000);
    cancelled.applyEvent(typhoonEvent(
      { id: "typhoon-reappears", serial: "3", reportDateTime: new Date(T0 + 120_000).toISOString() },
      {
        serial: "3",
        frames: [{ kind: "analysis", typhoonClass: { category: "TY" }, center: { location: "ocean", pressureHpa: 970, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 40 } }],
      },
    ), T0 + 120_000);
    expect(currentTyphoon(cancelled)).toMatchObject({
      pressureDeltaHpa: null, maxWindDeltaMs: null, intensityTrend: null,
    });

    const expired = new StandbyStateStore();
    expired.applyEvent(typhoonEvent(), T0);
    expired.sweep(T0 + 24 * 60 * 60_000);
    expired.applyEvent(typhoonEvent(
      { id: "typhoon-after-expiry", serial: "2", reportDateTime: new Date(T0 + 25 * 60 * 60_000).toISOString() },
      { serial: "2" },
    ), T0 + 25 * 60 * 60_000);
    expect(currentTyphoon(expired)).toMatchObject({
      pressureDeltaHpa: null, maxWindDeltaMs: null, intensityTrend: null,
    });
  });

  it("複数台風の差分履歴を typhoonKey ごとに独立して保持する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent(), T0);
    store.applyEvent(typhoonEvent(
      { id: "typhoon-2", eventId: "TC-2", serial: "1" },
      {
        eventId: "TC-2",
        name: { name: "Beta", nameKana: null, number: "2602", remark: null },
        frames: [{ kind: "analysis", typhoonClass: { category: "TS" }, center: { location: "sea", pressureHpa: 1000, moveDirection: "W", moveSpeedKmh: 15 }, wind: { maxWindMs: 20 } }],
      },
    ), T0);
    store.applyEvent(typhoonEvent(
      { id: "typhoon-1-next", serial: "2", reportDateTime: new Date(T0 + 60_000).toISOString() },
      {
        serial: "2",
        frames: [{ kind: "analysis", typhoonClass: { category: "TY" }, center: { location: "ocean", pressureHpa: 980, moveDirection: "N", moveSpeedKmh: 20 }, wind: { maxWindMs: 30 } }],
      },
    ), T0 + 60_000);

    expect(currentTyphoon(store, "TC-1")).toMatchObject({
      pressureDeltaHpa: -10, maxWindDeltaMs: 5, intensityTrend: "developing",
    });
    expect(currentTyphoon(store, "TC-2")).toMatchObject({
      pressureDeltaHpa: null, maxWindDeltaMs: null, intensityTrend: null,
    });
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

  it("発生予想終了を tombstone として削除し、遅延旧報で復活させない", () => {
    const ended = parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW61))!;
    const reportMs = Date.parse(ended.reportDateTime);
    const store = new StandbyStateStore();
    store.applyEvent(typhoonEvent({
      id: "forming",
      eventId: ended.eventId,
      serial: "0",
      reportDateTime: new Date(reportMs - 60_000).toISOString(),
    }, { ...ended, serial: "0", lifecycle: "forming" }), reportMs - 60_000);
    expect(store.snapshotItems()).toHaveLength(1);

    store.applyEvent(typhoonEvent({
      id: "formation-ended",
      eventId: ended.eventId,
      serial: ended.serial,
      reportDateTime: ended.reportDateTime,
    }, ended as unknown as Record<string, unknown>), reportMs);
    expect(store.snapshotItems()).toEqual([]);

    expect(store.applyEvent(typhoonEvent({
      id: "stale-forming",
      eventId: ended.eventId,
      serial: "0",
      reportDateTime: new Date(reportMs - 60_000).toISOString(),
    }, { ...ended, serial: "0", lifecycle: "forming" }), reportMs + 1)).toEqual({
      viewChanged: false,
      durableChanged: false,
    });
  });
});

describe("StandbyStateStore: volcano", () => {
  it("空コードの VFVO56 取消を EventID で噴火へ結び、復元後もカードを復活させない", () => {
    const issue = parsedVolcanoEvent(FIXTURE_VFVO56_FLASH_1, { eventId: "20140927120000_312" });
    const cancel = parsedVolcanoEvent(FIXTURE_VFVO56_FLASH_4, { eventId: "20140927120000_312" });
    expect(issue.eventId).toBe("20140927120000_312");
    expect(cancel.eventId).toBe(issue.eventId);
    const issueMs = Date.parse(issue.reportDateTime);
    const cancelMs = Date.parse(cancel.reportDateTime);
    const beforeRestart = new StandbyStateStore();
    beforeRestart.applyEvent(issue, issueMs);
    expect(beforeRestart.snapshotItems()).toHaveLength(1);
    expect(beforeRestart.exportActiveState().volcanoes[0]?.latestEventId).toBe(issue.eventId);

    const restored = new StandbyStateStore();
    restored.restoreActiveState(beforeRestart.exportActiveState(), cancelMs);
    restored.applyEvent(cancel, cancelMs);
    expect(restored.snapshotItems()).toEqual([]);

    const afterRestart = new StandbyStateStore();
    afterRestart.restoreActiveState(restored.exportActiveState(), cancelMs + 1);
    expect(afterRestart.snapshotItems()).toEqual([]);
  });

  it("旧形式の噴火イベント候補が複数なら空コード取消を適用せず警告する", () => {
    const seeded = new StandbyStateStore();
    seeded.applyEvent(volcanoEvent({ eventId: "eruption-a" }, {
      kind: "eruption", type: "VFVO56", volcanoCode: "V-1", volcanoName: "Mount One",
      isFlashReport: true, phenomenonName: "噴火",
    }), T0);
    seeded.applyEvent(volcanoEvent({
      id: "volcano-2",
      eventId: "eruption-b",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
    }, {
      kind: "eruption", type: "VFVO56", volcanoCode: "V-2", volcanoName: "Mount Two",
      isFlashReport: true, phenomenonName: "噴火",
    }), T0 + 60_000);
    const active = seeded.exportActiveState();
    const legacy = {
      ...active,
      volcanoes: active.volcanoes.map(({ latestEventId: _missing, ...state }) => state),
    };
    const restored = new StandbyStateStore();
    restored.restoreActiveState(legacy, T0 + 120_000);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    restored.applyEvent(volcanoEvent({
      id: "empty-code-cancel",
      eventId: "eruption-cancel",
      serial: "2",
      reportDateTime: new Date(T0 + 180_000).toISOString(),
      isCancellation: true,
    }, {
      kind: "eruption", type: "VFVO56", infoType: "取消",
      volcanoCode: "", volcanoName: "", isFlashReport: true, phenomenonName: "噴火速報",
    }), T0 + 180_000);

    expect(restored.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes)
      .toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("旧形式の噴火 state が複数"));
    warn.mockRestore();
  });

  it("VFVO51 の非数値警報を火山ごとに保持し、warning 区分だけをカード化する", () => {
    const event = parsedVolcanoEvent(FIXTURE_VFVO51_EXTRA);
    const store = new StandbyStateStore();
    store.applyEvent(event, Date.parse(event.reportDateTime));
    const volcanoes = store.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes ?? [];
    expect(volcanoes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "326", alertClass: expect.objectContaining({ code: "23", severity: "warning" }) }),
      expect.objectContaining({ code: "329", alertClass: expect.objectContaining({ code: "22", severity: "warning" }) }),
      expect.objectContaining({ code: "331", alertClass: expect.objectContaining({ code: "36", severity: "warning" }) }),
    ]));
    expect(volcanoes.some((volcano) => volcano.alertClass?.code === "21")).toBe(false);
    expect(store.exportActiveState().volcanoes.some((volcano) => volcano.alertClass?.code === "21")).toBe(true);
  });

  it("projects unique target kinds in telegram order while eruption-only information leaves them absent", () => {
    const alertStore = new StandbyStateStore();
    alertStore.applyEvent(volcanoEvent({}, {
      warningKind: "噴火警報（火口周辺）",
      municipalities: [
        { name: "テスト市", code: "0000000", kind: "入山規制" },
        { name: "テスト町", code: "0000001", kind: "避難準備" },
        { name: "テスト村", code: "0000002", kind: "入山規制" },
        { name: "テスト区", code: "0000003", kind: "避難" },
      ],
    }), T0);
    expect(alertStore.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      warningKind: "噴火警報（火口周辺）",
      targetKinds: ["入山規制", "避難準備", "避難"],
    });

    const eruptionStore = new StandbyStateStore();
    eruptionStore.applyEvent(volcanoEvent({}, {
      kind: "eruption", type: "VFVO56", isFlashReport: true, phenomenonName: "噴火",
      craterName: "山頂火口", eventDateTime: "2026-07-21T04:58:00+09:00",
      plumeHeight: 2500, plumeHeightUnknown: false, plumeDirection: "南東",
    }), T0);
    expect(eruptionStore.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      warningKind: null,
      targetKinds: [],
      latestEvent: {
        label: "噴火速報",
        craterName: "山頂火口",
        eventDateTime: "2026-07-21T04:58:00+09:00",
        plumeHeightM: 2500,
        plumeHeightUnknown: false,
        plumeDirection: "南東",
      },
    });
  });

  it("レベル3以下も保持するが単独ではカード化せず、噴火イベント時に併記する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent({}, {
      alertLevel: 3, alertLevelCode: "3", previousLevelCode: "2",
      warningKind: "噴火警報（火口周辺）",
      municipalities: [
        { name: "テスト市", code: "0000000", kind: "入山規制" },
        { name: "テスト町", code: "0000001", kind: "火口周辺規制" },
      ],
    }), T0);
    expect(store.snapshotItems()).toEqual([]);

    const eruptionAt = T0 + 60_000;
    store.applyEvent(volcanoEvent({
      id: "eruption",
      serial: "1",
      reportDateTime: new Date(eruptionAt).toISOString(),
    }, {
      kind: "eruption", type: "VFVO56", isFlashReport: false, phenomenonName: "噴火",
    }), eruptionAt);
    expect(store.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      alertLevel: 3,
      warningKind: "噴火警報（火口周辺）",
      targetKinds: ["入山規制", "火口周辺規制"],
      latestEvent: expect.objectContaining({ label: "噴火" }),
    });
  });

  it("警報未受信の噴火はレベルなしで表示し、解除 action で保持レベルを消す", () => {
    const eventOnly = new StandbyStateStore();
    eventOnly.applyEvent(volcanoEvent({}, {
      kind: "eruption", type: "VFVO56", isFlashReport: false, phenomenonName: "噴火",
    }), T0);
    expect(eventOnly.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      alertLevel: null,
      warningKind: null,
      targetKinds: [],
    });

    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent({}, {
      alertLevel: 3, alertLevelCode: "3", previousLevelCode: "2",
      warningKind: "噴火警報（火口周辺）",
      municipalities: [{ name: "テスト市", code: "0000000", kind: "入山規制" }],
    }), T0);
    store.applyEvent(volcanoEvent({
      id: "eruption",
      serial: "1",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
    }, {
      kind: "eruption", type: "VFVO56", isFlashReport: false, phenomenonName: "噴火",
    }), T0 + 60_000);
    store.applyEvent(volcanoEvent({
      id: "release",
      serial: "2",
      reportDateTime: new Date(T0 + 120_000).toISOString(),
    }, {
      alertLevel: null, alertLevelCode: null, previousLevelCode: "3",
      action: "release", warningKind: "噴火予報",
    }), T0 + 120_000);
    expect(store.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes[0]).toMatchObject({
      alertLevel: null,
      warningKind: null,
      targetKinds: [],
      latestEvent: expect.objectContaining({ label: "噴火" }),
    });
  });

  it("レベル引下げは投影 state を新レベルへ更新する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent(), T0);
    expect(store.snapshotItems()).toEqual([expect.objectContaining({ kind: "volcano", expiresAt: null })]);
    expect(store.sweep(T0 + 48 * 60 * 60_000).viewChanged).toBe(false);

    const loweredAt = T0 + 48 * 60 * 60_000;
    store.applyEvent(volcanoEvent({
      id: "volcano-lower",
      serial: "2",
      reportDateTime: new Date(loweredAt).toISOString(),
    }, {
      alertLevel: 2, alertLevelCode: "2", previousLevelCode: "4", action: "lower",
    }), loweredAt);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.exportActiveState().volcanoes[0]).toMatchObject({ alertLevel: 2, alertExpiresAtMs: null });
  });

  it("複数火山の低レベル警報と噴火イベントを code ごとに独立保持する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent({}, {
      volcanoCode: "V-1", volcanoName: "Mount One",
      alertLevel: 3, alertLevelCode: "3", previousLevelCode: "2",
    }), T0);
    store.applyEvent(volcanoEvent({ id: "alert-v2" }, {
      volcanoCode: "V-2", volcanoName: "Mount Two",
      alertLevel: 2, alertLevelCode: "2", previousLevelCode: "1",
    }), T0);
    expect(store.snapshotItems()).toEqual([]);

    store.applyEvent(volcanoEvent({
      id: "eruption-v1",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
    }, {
      kind: "eruption", type: "VFVO56",
      volcanoCode: "V-1", volcanoName: "Mount One",
      isFlashReport: false, phenomenonName: "噴火",
    }), T0 + 60_000);
    store.applyEvent(volcanoEvent({
      id: "eruption-v2",
      reportDateTime: new Date(T0 + 120_000).toISOString(),
    }, {
      kind: "eruption", type: "VFVO52",
      volcanoCode: "V-2", volcanoName: "Mount Two",
      isFlashReport: true, phenomenonName: "噴火",
    }), T0 + 120_000);

    const volcanoes = store.snapshotItems().find((item) => item.kind === "volcano")?.data.volcanoes;
    expect(volcanoes).toEqual([
      expect.objectContaining({
        code: "V-1", alertLevel: 3,
        latestEvent: expect.objectContaining({ label: "噴火" }),
      }),
      expect.objectContaining({
        code: "V-2", alertLevel: 2,
        latestEvent: expect.objectContaining({ label: "噴火速報" }),
      }),
    ]);
  });

  it("cancel action は警報 projection を削除する", () => {
    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent({}, {
      action: "issue",
      alertLevel: 4, alertLevelCode: "4", previousLevelCode: "3",
    }), T0);
    expect(store.snapshotItems()).toHaveLength(1);

    const cancelledAt = T0 + 60_000;
    store.applyEvent(volcanoEvent({
      id: "cancel",
      serial: "2",
      reportDateTime: new Date(cancelledAt).toISOString(),
    }, {
      action: "cancel",
      alertLevel: null, alertLevelCode: null, previousLevelCode: "4",
    }), cancelledAt);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.exportActiveState().volcanoes).toEqual([]);
  });

  it("keeps a flash eruption for 24 hours and keeps a steady level 2 hidden", () => {
    const store = new StandbyStateStore();
    store.applyEvent(volcanoEvent({ serial: "1" }, { alertLevel: 2, alertLevelCode: "2", previousLevelCode: "2" }), T0);
    expect(store.snapshotItems()).toEqual([]);

    const eruptionAt = T0 + 60_000;
    store.applyEvent(volcanoEvent({ id: "flash", serial: "2", reportDateTime: new Date(eruptionAt).toISOString() }, {
      kind: "eruption", type: "VFVO52", isFlashReport: true, phenomenonName: "flash",
      craterName: null, eventDateTime: new Date(eruptionAt - 30_000).toISOString(),
      plumeHeight: null, plumeHeightUnknown: true, plumeDirection: null,
    }), eruptionAt);
    expect(store.snapshotItems()).toEqual([expect.objectContaining({ kind: "volcano", expiresAt: new Date(eruptionAt + 24 * 60 * 60_000).toISOString() })]);
    const eruptionCard = store.snapshotItems().find((item) => item.kind === "volcano");
    expect(eruptionCard?.data.volcanoes[0]?.latestEvent).toMatchObject({
      label: "噴火速報",
      eventDateTime: new Date(eruptionAt - 30_000).toISOString(),
      plumeHeightM: null,
      plumeHeightUnknown: true,
    });
    store.sweep(eruptionAt + 24 * 60 * 60_000);
    expect(store.snapshotItems()).toEqual([]);
    expect(store.exportActiveState().volcanoes[0]).toMatchObject({ alertLevel: 2, alertExpiresAtMs: null });
  });
});

describe("StandbyStateStore: flood", () => {
  it("実在 Headline-only 発表をカード化し、Headline-only 解除で削除する", () => {
    const issued = parseFloodForecast(createMockWsDataMessage(FIXTURE_VXKO50_16_05_01))!;
    const releaseFixture = parseFloodForecast(createMockWsDataMessage(FIXTURE_VXKO50_16_14_01))!;
    const issueEvent = heatEvent({
      id: "headline-only-issue",
      domain: "floodForecast",
      eventId: issued.eventId,
      serial: String(issued.serial),
      reportDateTime: issued.reportDateTime,
      infoType: issued.infoType,
      floodStateMutationAccepted: true,
      floodActiveEventIds: [issued.eventId],
      raw: issued,
    });
    const release = {
      ...releaseFixture,
      eventId: issued.eventId,
      serial: issued.serial + 1,
      rawStations: [],
    };
    const releaseEvent = heatEvent({
      id: "headline-only-release",
      domain: "floodForecast",
      eventId: release.eventId,
      serial: String(release.serial),
      reportDateTime: release.reportDateTime,
      infoType: release.infoType,
      floodStateMutationAccepted: true,
      floodActiveEventIds: [],
      raw: release,
    });
    const store = new StandbyStateStore();
    store.applyEvent(issueEvent, Date.parse(issued.reportDateTime));
    expect(store.snapshotItems().find((item) => item.kind === "flood")).toMatchObject({
      data: {
        rivers: expect.arrayContaining([
          expect.objectContaining({ riverKey: "1234567890", level: "L3", station: null }),
          expect.objectContaining({ riverKey: "9876543210", level: "L3", station: null }),
        ]),
      },
    });
    store.applyEvent(releaseEvent, Date.parse(release.reportDateTime));
    expect(store.snapshotItems().find((item) => item.kind === "flood")).toBeUndefined();
  });

  it("delegates flood events to FloodActiveReducer and exposes the aggregate card", () => {
    const raw: ParsedFloodForecastInfo = {
      meta: testTelegramMeta(false),
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
      floodStateMutationAccepted: true, floodActiveEventIds: [raw.eventId],
    });
    const store = new StandbyStateStore();

    expect(store.applyEvent(presentation, T0)).toEqual({ viewChanged: true, durableChanged: true });
    expect(store.snapshotItems()).toEqual([expect.objectContaining({
      kind: "flood", key: "flood:active", surface: "corner-right",
      data: { rivers: [expect.objectContaining({ riverKey: "river-1", riverName: "多摩川", level: "L3" })] },
    })]);
  });
});
