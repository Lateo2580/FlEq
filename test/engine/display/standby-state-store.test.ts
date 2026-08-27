import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, expect, it, vi } from "vitest";
import { parseTyphoonAnalysis } from "../../../src/dmdata/typhoon-analysis-parser";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { deriveBriefingTag, parseWeatherBriefing } from "../../../src/dmdata/briefing-parser";
import * as log from "../../../src/logger";
import { RevisionGuard, StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import {
  BRIEFING_CARD_CANCEL_TTL_MS,
  BRIEFING_CARD_MAX_ENTRIES,
  BRIEFING_CARD_TTL_MS,
} from "../../../src/engine/display/standby-registry";
import { fromLegacyCounterpartOutcome } from "../../../src/engine/presentation/events/from-legacy-counterpart";
import { processLegacyCounterpart } from "../../../src/engine/presentation/processors/process-legacy-counterpart";
import { briefingFrameLevel } from "../../../src/engine/presentation/level-helpers";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type {
  JmaIntensity,
  JmaLgIntensity,
  ParsedFloodForecastInfo,
  ParsedHeatAlertInfo,
  ParsedLgObservationInfo,
  ParsedTyphoonAnalysis,
  ParsedVolcanoInfo,
  ParsedWeatherBriefing,
  SpecialValue,
} from "../../../src/types";
import {
  createMockWsDataMessageFromXml,
  createMockWsDataMessage,
  FIXTURE_VFVO51_EXTRA,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFVO56_FLASH_4,
  FIXTURE_VPTW60_2020,
  FIXTURE_VPTW61,
  FIXTURE_VXKO50_16_05_01,
  FIXTURE_VXKO50_16_14_01,
  FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709,
  FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709,
  FIXTURE_VPBS50_SYNTH_CANCEL,
  FIXTURE_VPBS50_SYNTH_MULTI,
  FIXTURE_VPBS50_SYNTH_UNKNOWN,
  FIXTURE_VPOA50_SYNTH_CANCEL,
  readFixture,
} from "../../helpers/mock-message";
import {
  BRIEFING_CARD_FIXTURE_MATRIX,
  PHASE6B_BRIEFING_CARD_FIXTURE_MATRIX,
} from "../../helpers/display-fixtures";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");

const BRIEFING_STATIC_SUMMARY_FACTS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  "82_01_01_260324_VPBS50.xml": [
    { kind: "event", label: "発生", areaName: "北西部", areaCode: "120010", at: "2023-09-08T10:10:00+09:00" },
    { kind: "event", label: "発生", areaName: "北東部", areaCode: "120020", at: "2023-09-08T10:10:00+09:00" },
    { kind: "event", label: "発生", areaName: "南部", areaCode: "120030", at: "2023-09-08T10:10:00+09:00" },
  ],
  "82_03_01_260324_VPBS50.xml": [{ kind: "event", label: "予想", areaName: "福岡地方", areaCode: "400010", at: "2023-07-10T01:50:00+09:00" }],
  "82_01_02_250630_VPBS50.xml": [
    { kind: "precipitation", locationName: "美幌町", locationCode: "0154300", description: "約１００ミリ", value: 100, unit: "mm", at: "2023-07-13T13:10:00+09:00" },
    { kind: "precipitation", locationName: "美幌", locationCode: "17631", description: "９３ミリ", value: 93, unit: "mm", at: "2023-07-13T13:10:00+09:00" },
  ],
  "82_01_03_241031_VPBS50.xml": [{ kind: "snowfall", locationName: "長浜市余呉町柳ケ瀬", locationCode: "60026", description: "３７センチ", value: 37, unit: "cm", at: "2024-01-24T06:00:00+09:00" }],
};

const PHASE6B_VPBS_SUMMARY_FACTS: Readonly<Record<string, readonly {
  locationName: string; locationCode: string; description: string; value: number; unit: string; at: string;
}[]>> = {
  "phase6b_VPBS50_KJPDE202608201757_202608201757.xml": [{ locationName: "北塩原村", locationCode: "0740200", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-20T17:50:00+09:00" }],
  "phase6b_VPBS50_KJPTC202608211633_202608211633.xml": [{ locationName: "さいたま市", locationCode: "1110000", description: "約１１０ミリ", value: 110, unit: "mm", at: "2026-08-21T16:20:00+09:00" }],
  "phase6b_VPBS50_KJPTC202608221709_202608221709.xml": [{ locationName: "戸田市", locationCode: "1122400", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-22T17:00:00+09:00" }],
  "phase6b_VPBS50_KJPTK202608221709_202608221709.xml": [
    { locationName: "北区", locationCode: "1311700", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-22T17:00:00+09:00" },
    { locationName: "板橋区", locationCode: "1311900", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-22T17:00:00+09:00" },
  ],
  "phase6b_VPBS50_KJPTK202608221709_202608221717.xml": [{ locationName: "板橋区", locationCode: "1311900", description: "１２０ミリ以上", value: 120, unit: "mm", at: "2026-08-22T17:00:00+09:00" }],
  "phase6b_VPBS50_KJPTK202608221709_202608221727.xml": [{ locationName: "豊島区", locationCode: "1311600", description: "約１００ミリ", value: 100, unit: "mm", at: "2026-08-22T17:20:00+09:00" }],
};

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

function briefingEvent(fixture: string): PresentationEvent {
  const info = parseWeatherBriefing(createMockWsDataMessage(fixture));
  if (info == null) throw new Error(`briefing fixture did not parse: ${fixture}`);
  const areaItems = info.targetAreas.map((area) => ({
    name: area.name,
    code: area.code,
    kind: info.briefingCondition || "気象防災速報",
  }));
  return heatEvent({
    id: info.meta.messageId,
    domain: "briefing",
    type: "VPBS50",
    infoType: info.infoType,
    title: info.title,
    controlTitle: info.controlTitle,
    headline: info.headline,
    reportDateTime: info.reportDateTime,
    publishingOffice: info.publishingOffice,
    isTest: info.isTest,
    frameLevel: briefingFrameLevel(info),
    isCancellation: info.infoType === "取消",
    eventId: info.eventId,
    serial: info.serial,
    areaNames: info.targetAreas.map((area) => area.name),
    areaCount: areaItems.length,
    areaItems,
    observationNames: info.observations
      .map((observation) => observation.locationName)
      .filter((name): name is string => name != null),
    observationCount: info.observations.length,
    raw: info,
  });
}

function minimalBriefingEvent(id: string, reportDateTime: string): PresentationEvent {
  return heatEvent({
    id,
    domain: "briefing",
    type: "VPBS50",
    infoType: "発表",
    title: "気象防災速報",
    reportDateTime,
    frameLevel: "info",
    isCancellation: false,
    eventId: id,
    raw: {
      eventId: id,
      meta: { messageId: `message:${id}` },
    } as unknown as PresentationEvent["raw"],
  });
}

function semanticBriefingEvent(
  eventId: string,
  reportDateTime: string,
  serial: string,
  condition: "線状降水帯発生" | "線状降水帯直前" | "記録的短時間大雨" | "短時間大雪" = "線状降水帯発生",
  editorialOffice = "試験地方気象台",
): PresentationEvent {
  const base = briefingEvent("82_01_01_260324_VPBS50.xml");
  const info = base.raw as ParsedWeatherBriefing;
  const tag = condition === "線状降水帯発生"
    ? "linearRainObserved"
    : condition === "線状降水帯直前"
      ? "linearRainPredicted"
      : condition === "記録的短時間大雨"
        ? "recordRain"
        : "shortSnow";
  const raw: ParsedWeatherBriefing = {
    ...info,
    eventId,
    reportDateTime,
    serial,
    editorialOffice,
    briefingCondition: condition,
    briefingConditions: [condition],
    briefingSeverityEvidence: info.briefingSeverityEvidence.map((evidence) => ({
      ...evidence, condition, tag,
    })),
  };
  return {
    ...base,
    id: `message:${eventId}`,
    eventId,
    serial,
    reportDateTime,
    editorialOffice,
    raw,
  };
}

function vpoaEvent(fixture: string): PresentationEvent {
  const outcome = processLegacyCounterpart(createMockWsDataMessage(fixture));
  if (outcome == null) throw new Error(`VPOA50 fixture did not parse: ${fixture}`);
  return fromLegacyCounterpartOutcome(outcome);
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

describe("StandbyStateStore: independent briefing card", () => {
  it.each([
    ["82_01_01_260324_VPBS50.xml", "linearRainObserved", "線状降水帯が発生", "event"],
    ["82_03_01_260324_VPBS50.xml", "linearRainPredicted", "３時間以内に線状降水帯発生のおそれ", "event"],
    ["82_01_02_250630_VPBS50.xml", "recordRain", "記録的短時間大雨", "precipitation"],
    ["82_01_03_241031_VPBS50.xml", "shortSnow", "短時間大雪", "snowfall"],
  ] as const)("known VPBS50 %s is projected as structured summary", (fixture, kind, lead, factKind) => {
    const event = briefingEvent(fixture);
    const store = new StandbyStateStore();
    store.applyEvent(event, Date.parse(event.reportDateTime) + 1);
    const summary = store.snapshotBriefingCard()!.data.entries[0]!.summary;

    expect(summary).toMatchObject({ mode: "structured", hasUnknownKind: false, items: [{ kind, lead }] });
    expect(summary?.items[0]?.facts[0]?.kind).toBe(factKind);
    expect(summary?.items[0]?.facts).toEqual(BRIEFING_STATIC_SUMMARY_FACTS[fixture]);
  });

  it("複数 known kind は severity 降順で畳み、unknown 混在は mixed にする", () => {
    const event = briefingEvent(FIXTURE_VPBS50_SYNTH_MULTI);
    const store = new StandbyStateStore();
    store.applyEvent(event, Date.parse(event.reportDateTime) + 1);
    expect(store.snapshotBriefingCard()!.data.entries[0]!.summary).toMatchObject({
      mode: "structured", items: [{ kind: "recordRain" }, { kind: "shortSnow" }],
    });

    const raw = event.raw as typeof event.raw & { briefingConditions: string[]; briefingSeverityEvidence: unknown[] };
    const mixed = { ...event, raw: {
      ...raw,
      briefingConditions: [...raw.briefingConditions, "未知種別"],
      briefingSeverityEvidence: [...raw.briefingSeverityEvidence, {
        condition: "未知種別", tag: "other", displaySeverity: null, soundLevel: null, source: "unknown",
      }],
    } };
    const mixedStore = new StandbyStateStore();
    mixedStore.applyEvent(mixed, Date.parse(event.reportDateTime) + 1);
    expect(mixedStore.snapshotBriefingCard()!.data.entries[0]!.summary).toMatchObject({
      mode: "mixed", hasUnknownKind: true,
    });
  });

  it("unknown・VPBS50取消・VPOA50 fail-open を推測せず summary mode に分ける", () => {
    const unknown = new StandbyStateStore();
    const unknownEvent = briefingEvent(FIXTURE_VPBS50_SYNTH_UNKNOWN);
    unknown.applyEvent(unknownEvent, Date.parse(unknownEvent.reportDateTime) + 1);
    expect(unknown.snapshotBriefingCard()!.data.entries[0]!.summary).toMatchObject({ mode: "rawHeadlineFallback", hasUnknownKind: true });

    const cancelled = new StandbyStateStore();
    const cancelEvent = briefingEvent(FIXTURE_VPBS50_SYNTH_CANCEL);
    expect(cancelled.applyEvent(cancelEvent, Date.parse(cancelEvent.reportDateTime) + 1))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(cancelled.snapshotBriefingCard()).toBeNull();

    const vpoa = vpoaEvent(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const vpoaStore = new StandbyStateStore();
    vpoaStore.applyEvent(vpoa, Date.parse(vpoa.reportDateTime) + 1);
    expect(vpoaStore.snapshotBriefingCard()!.data.entries[0]!.summary).toEqual({
      mode: "structured", hasUnknownKind: false,
      items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }],
    });

    const vpoaCancel = vpoaEvent(FIXTURE_VPOA50_SYNTH_CANCEL);
    const vpoaCancelStore = new StandbyStateStore();
    const vpoaCancelNow = Date.parse(vpoaCancel.reportDateTime) + 1;
    vpoaCancelStore.applyEvent(vpoaCancel, vpoaCancelNow);
    const vpoaCancelEntry = vpoaCancelStore.snapshotBriefingCard()!.data.entries[0]!;
    expect(vpoaCancelEntry.summary).toMatchObject({ mode: "rawHeadlineFallback" });
    expect(Date.parse(vpoaCancelEntry.expiresAt)).toBe(Date.parse(vpoaCancel.reportDateTime) + BRIEFING_CARD_TTL_MS);
  });

  it("headline を無関係な散文へ置換しても summary は変わらない", () => {
    const event = briefingEvent("82_01_02_250630_VPBS50.xml");
    const changed: PresentationEvent = {
      ...event,
      headline: "無関係な散文",
      raw: { ...(event.raw as object), headline: "無関係な散文" } as PresentationEvent["raw"],
    };
    const originalStore = new StandbyStateStore();
    const changedStore = new StandbyStateStore();
    const nowMs = Date.parse(event.reportDateTime) + 1;
    originalStore.applyEvent(event, nowMs);
    changedStore.applyEvent(changed, nowMs);
    expect(changedStore.snapshotBriefingCard()!.data.entries[0]!.summary).toEqual(originalStore.snapshotBriefingCard()!.data.entries[0]!.summary);
  });

  it("VPOA50 evidence の欠落・矛盾は structured にせず raw fallback にする", () => {
    const event = vpoaEvent(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const raw = event.raw as unknown as { severityEvidence: Array<Record<string, unknown>> };
    for (const severityEvidence of [raw.severityEvidence.slice(0, 1), [{ ...raw.severityEvidence[0], kindCode: "9" }]]) {
      const store = new StandbyStateStore();
      store.applyEvent({
        ...event,
        raw: { ...(event.raw as object), severityEvidence } as unknown as PresentationEvent["raw"],
      }, Date.parse(event.reportDateTime) + 1);
      expect(store.snapshotBriefingCard()!.data.entries[0]!).toMatchObject({
        title: event.title, headline: event.headline, summary: { mode: "rawHeadlineFallback" },
      });
    }
  });

  it("VPOA50 の Kind.Name 不一致は record-rain に昇格せず raw fallback にする", () => {
    const xml = readFixture(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709)
      .replace(/<Name>記録的短時間大雨情報<\/Name>/g, "<Name>別の情報</Name>");
    const outcome = processLegacyCounterpart(createMockWsDataMessageFromXml(xml, "VPOA50"));
    if (outcome == null) throw new Error("VPOA50 fixture did not parse");
    const event = fromLegacyCounterpartOutcome(outcome);
    const store = new StandbyStateStore();

    store.applyEvent(event, Date.parse(event.reportDateTime) + 1);

    expect(store.snapshotBriefingCard()!.data.entries[0]!).toMatchObject({
      title: event.title,
      headline: event.headline,
      summary: { mode: "rawHeadlineFallback" },
    });
  });

  it("Condition 空の VPBS50 は NFKC 後の括弧内 title を exact fallback に使う", () => {
    const event = briefingEvent("82_03_01_260324_VPBS50.xml");
    const raw = event.raw as typeof event.raw & { briefingConditions: string[]; briefingSeverityEvidence: unknown[] };
    const store = new StandbyStateStore();
    store.applyEvent({ ...event, raw: { ...raw, briefingConditions: [], briefingSeverityEvidence: [] } }, Date.parse(event.reportDateTime) + 1);
    expect(store.snapshotBriefingCard()!.data.entries[0]!.summary).toMatchObject({
      mode: "structured", items: [{ kind: "linearRainPredicted", lead: "３時間以内に線状降水帯発生のおそれ" }],
    });
  });

  it.each(BRIEFING_CARD_FIXTURE_MATRIX)("fixture $fixture is projected without ticker fields", (expected) => {
    const info = parseWeatherBriefing(createMockWsDataMessage(expected.fixture));
    if (info == null) throw new Error(`briefing fixture did not parse: ${expected.fixture}`);
    const reportTimeMs = Date.parse(expected.reportDateTime);
    const store = new StandbyStateStore();

    const mutation = store.applyEvent(briefingEvent(expected.fixture), reportTimeMs + 1);
    if (expected.fixture === "synthetic_VPBS50_cancel.xml") {
      expect(mutation).toEqual({ viewChanged: false, durableChanged: false });
      expect(store.snapshotBriefingCard()).toBeNull();
      return;
    }
    expect(mutation)
      .toEqual({ viewChanged: true, durableChanged: false });

    const card = store.snapshotBriefingCard();
    expect(card).not.toBeNull();
    const entry = card!.data.entries[0];
    expect(card!.data.entries).toHaveLength(1);
    expect(entry).toMatchObject({
      key: info.briefingSeverityEvidence.some((evidence) => evidence.tag !== "other")
        && info.editorialOffice !== ""
        ? expect.stringMatching(/^card:vpbs:semantic:/)
        : `card:vpbs:${info.eventId}`,
      source: "vpbs50",
      title: expected.title,
      headline: expected.headline,
      conditions: expected.conditions,
      targetAreas: expected.targetAreas,
      reportDateTime: expected.reportDateTime,
      publishingOffice: expected.publishingOffice,
      infoType: expected.infoType,
      qualifier: expected.qualifier,
    });
    expect(entry.frameLevel).toBe(briefingFrameLevel(info));
    expect(entry.severityEvidence).toMatchObject(expected.severityEvidence);
    expect(entry.severityEvidence).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tickerSentence: expect.anything() }),
    ]));
  });

  it.each(PHASE6B_BRIEFING_CARD_FIXTURE_MATRIX)("static phase6b fixture $fixture is a card entry", (expected) => {
    const event = expected.source === "vpbs50"
      ? briefingEvent(expected.fixture)
      : vpoaEvent(expected.fixture);
    const store = new StandbyStateStore();

    store.applyEvent(event, Date.parse(expected.reportDateTime) + 1);
    const entry = store.snapshotBriefingCard()!.data.entries[0];
    expect(entry).toMatchObject({
      key: expected.source === "vpbs50"
        ? expect.stringMatching(/^card:vpbs:semantic:/)
        : `card:vpoa:${expected.sourceEventId}`,
      source: expected.source,
      sourceEventId: expected.sourceEventId,
      title: expected.title,
      headline: expected.headline,
      conditions: expected.conditions,
      reportDateTime: expected.reportDateTime,
      publishingOffice: expected.publishingOffice,
      infoType: expected.infoType,
      frameLevel: expected.frameLevel,
      targetAreas: expected.targetAreas,
      qualifier: expected.qualifier,
    });
    expect(entry.severityEvidence).toMatchObject(expected.severityEvidence);
    expect(entry.targetAreas.every((area) => area.code !== "")).toBe(true);
    if (expected.source === "vpbs50") {
      const facts = PHASE6B_VPBS_SUMMARY_FACTS[expected.fixture];
      expect(facts).toBeDefined();
      expect(entry.summary).toEqual({
        mode: "structured", hasUnknownKind: false,
        items: [{
          kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0,
          facts: facts!.map((fact) => ({ kind: "precipitation", ...fact })),
        }],
      });
    } else {
      expect(entry.summary).toEqual({
        mode: "structured", hasUnknownKind: false,
        items: [{ kind: "recordRain", lead: "記録的短時間大雨", sourceOrdinal: 0, facts: [] }],
      });
    }
  });

  it("VPOA50 fail-open は card 専用 identity・qualifier・code付き地域を持つ", () => {
    const source = vpoaEvent(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const nowMs = Date.parse(source.reportDateTime) + 1;
    const store = new StandbyStateStore();

    expect(store.applyEvent(source, nowMs)).toEqual({ viewChanged: true, durableChanged: false });
    const entry = store.snapshotBriefingCard()!.data.entries[0];
    expect(entry).toMatchObject({
      key: `card:vpoa:${source.eventId}`,
      source: "vpoa50",
      sourceEventId: source.eventId,
      qualifier: "対応電文未確認",
      frameLevel: source.legacySeverity === "high" ? "critical" : "warning",
      targetAreas: source.areaItems.map((area) => ({ name: area.name, code: area.code })),
    });
  });

  it("EventID 欠落時は raw messageId 相当を card identity にする", () => {
    const nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const source = minimalBriefingEvent("non-raw-id", new Date(nowMs).toISOString());
    source.domain = "legacyCounterpart";
    source.type = "VPOA50";
    source.eventId = null;
    source.raw = { meta: { messageId: "raw-message-id" } } as unknown as PresentationEvent["raw"];
    const store = new StandbyStateStore();

    store.applyEvent(source, nowMs);
    const sourceKey = "card:vpoa:raw-message-id";
    expect(store.snapshotBriefingCard()!.data.entries[0].key).toBe(sourceKey);
  });

  it("raw EventID と raw messageId がともに欠落すれば card candidate を作らない", () => {
    const nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const source = minimalBriefingEvent("non-raw-id", new Date(nowMs).toISOString());
    source.eventId = "presentation-only-id";
    source.raw = null;
    const store = new StandbyStateStore();

    expect(store.applyBriefingCardEvent(source, nowMs)).toMatchObject({
      kind: "ignored", applied: false, reason: "notBriefing", generation: 0,
    });
    expect(store.snapshotBriefingCard()).toBeNull();
  });

  it("VPOA50 source は canonical VPBS50へ純粋置換され、再送しても generation が進まない", () => {
    const source = vpoaEvent(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const canonical = briefingEvent(FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709);
    const nowMs = Date.parse(source.reportDateTime) + 1;
    const store = new StandbyStateStore();
    const sourceKey = `card:vpoa:${source.eventId}`;

    store.applyEvent(source, nowMs);
    const applied = store.reconcileBriefingCard(sourceKey, canonical, nowMs);
    expect(applied.kind).toBe("applied");
    expect(store.briefingCardGeneration()).toBe(applied.generation);
    expect(store.snapshotBriefingCard()!.data.entries).toHaveLength(1);
    expect(store.snapshotBriefingCard()!.data.entries[0]).toMatchObject({
      source: "vpbs50",
      key: expect.stringMatching(/^card:vpbs:semantic:/),
    });

    const repeated = store.reconcileBriefingCard(sourceKey, canonical, nowMs);
    expect(repeated).toMatchObject({ kind: "ignored", reason: "sourceNotFound" });
    expect(repeated.generation).toBe(applied.generation);
    expect(store.snapshotBriefingCard()!.data.entries).toHaveLength(1);
  });

  it("reconcile min expiry が残る間は canonical を source の絶対expiryで失効させる", () => {
    const nowMs = Date.parse("2026-08-25T02:00:00.000Z");
    const source = minimalBriefingEvent("source-min", new Date(nowMs - BRIEFING_CARD_TTL_MS + 1_000).toISOString());
    source.domain = "legacyCounterpart";
    source.type = "VPOA50";
    const canonical = minimalBriefingEvent("canonical-min", new Date(nowMs - BRIEFING_CARD_TTL_MS + 2_000).toISOString());
    const store = new StandbyStateStore();

    store.applyEvent(source, nowMs);
    const result = store.reconcileBriefingCard("card:vpoa:source-min", canonical, nowMs);
    expect(result).toMatchObject({ kind: "applied", applied: true, canonicalInserted: true, evictedKey: null });
    if (result.kind !== "applied") throw new Error("reconcile must apply before its expiry");
    const expiresAtMs = nowMs + 1_000;
    expect(result.expiresAt).toBe(new Date(expiresAtMs).toISOString());
    expect(store.sweep(expiresAtMs - 1)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.sweep(expiresAtMs)).toEqual({ viewChanged: true, durableChanged: false });
    expect(store.sweep(expiresAtMs + 1)).toEqual({ viewChanged: false, durableChanged: false });
  });

  it("reconcile min expiry が到達済みなら source だけを一回除去する", () => {
    const nowMs = Date.parse("2026-08-25T02:00:00.000Z");
    const source = minimalBriefingEvent("source-expired", new Date(nowMs - BRIEFING_CARD_TTL_MS + 1_000).toISOString());
    source.domain = "legacyCounterpart";
    source.type = "VPOA50";
    const canonical = minimalBriefingEvent("canonical-expired", new Date(nowMs - BRIEFING_CARD_TTL_MS).toISOString());
    const store = new StandbyStateStore();

    store.applyEvent(source, nowMs);
    const result = store.reconcileBriefingCard("card:vpoa:source-expired", canonical, nowMs);
    expect(result).toMatchObject({
      kind: "applied", applied: true, canonicalInserted: false, expiresAt: null, generation: 2,
    });
    expect(store.snapshotBriefingCard()).toBeNull();
    expect(store.reconcileBriefingCard("card:vpoa:source-expired", canonical, nowMs))
      .toMatchObject({ kind: "ignored", applied: false, reason: "sourceNotFound", generation: 2 });
  });

  it("card 専用 mutation は durable listener を起動しない", () => {
    const nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const source = minimalBriefingEvent("source-durable", new Date(nowMs).toISOString());
    source.domain = "legacyCounterpart";
    source.type = "VPOA50";
    const canonical = minimalBriefingEvent("canonical-durable", new Date(nowMs).toISOString());
    const store = new StandbyStateStore();
    let durableCalls = 0;
    store.onDurable(() => { durableCalls += 1; });

    store.applyEvent(source, nowMs);
    store.reconcileBriefingCard("card:vpoa:source-durable", canonical, nowMs);
    store.sweep(nowMs + BRIEFING_CARD_TTL_MS);
    expect(durableCalls).toBe(0);
  });

  it("同一 raw identity の受理済み訂正は entry を置換し generation を進める", () => {
    const nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const issued = minimalBriefingEvent("corrected", new Date(nowMs).toISOString());
    const corrected: PresentationEvent = {
      ...issued,
      infoType: "訂正",
      title: "訂正済み気象防災速報",
      reportDateTime: new Date(nowMs + 1_000).toISOString(),
      serial: "2",
    };
    const store = new StandbyStateStore();

    expect(store.applyEvent(issued, nowMs)).toEqual({ viewChanged: true, durableChanged: false });
    expect(store.applyEvent(corrected, nowMs + 1_000)).toEqual({ viewChanged: true, durableChanged: false });
    expect(store.snapshotBriefingCard()!.data.entries[0]).toMatchObject({
      key: "card:vpbs:corrected", title: "訂正済み気象防災速報", infoType: "訂正", generation: 2,
    });
  });

  it("VPBS50 取消は同一 entry を cancel frame と独立10分TTLへ置換する", () => {
    const normal = briefingEvent("82_01_03_241031_VPBS50.xml");
    const cancelled = briefingEvent("synthetic_VPBS50_cancel.xml");
    const reportTimeMs = Date.parse(normal.reportDateTime);
    const store = new StandbyStateStore();

    store.applyEvent(normal, reportTimeMs + 1);
    store.applyEvent(cancelled, reportTimeMs + 2);
    const entry = store.snapshotBriefingCard()!.data.entries[0];
    expect(store.snapshotBriefingCard()!.data.entries).toHaveLength(1);
    expect(entry).toMatchObject({
      key: expect.stringMatching(/^card:vpbs:semantic:/),
      infoType: "取消",
      frameLevel: "cancel",
    });
    const expiresAtMs = Date.parse(entry.expiresAt);
    expect(expiresAtMs).toBe(reportTimeMs + BRIEFING_CARD_CANCEL_TTL_MS);
    expect(store.sweep(expiresAtMs - 1).viewChanged).toBe(false);
    expect(store.sweep(expiresAtMs).viewChanged).toBe(true);
    expect(store.sweep(expiresAtMs + 1)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotBriefingCard()).toBeNull();
  });

  it("10分TTLを越えた取消は旧通常 entry を除去し generation を一度だけ進める", () => {
    const normal = briefingEvent("82_01_03_241031_VPBS50.xml");
    const cancelled = briefingEvent("synthetic_VPBS50_cancel.xml");
    const reportTimeMs = Date.parse(normal.reportDateTime);
    const store = new StandbyStateStore();

    store.applyEvent(normal, reportTimeMs + 1);
    expect(store.briefingCardGeneration()).toBe(1);
    expect(store.applyEvent(cancelled, reportTimeMs + BRIEFING_CARD_CANCEL_TTL_MS))
      .toEqual({ viewChanged: true, durableChanged: false });
    expect(store.briefingCardGeneration()).toBe(2);
    expect(store.snapshotBriefingCard()).toBeNull();
  });

  it("ReportDateTime + card TTL を過ぎた遅着 entry は新規表示しない", () => {
    const nowMs = Date.parse("2026-08-25T02:00:00.000Z");
    const expiredAt = new Date(nowMs - 120 * 60_000).toISOString();
    const store = new StandbyStateStore();

    expect(store.applyEvent(minimalBriefingEvent("briefing-expired", expiredAt), nowMs))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotBriefingCard()).toBeNull();
  });

  it("card entry は128件の -1/exact/+1 境界で安定key eviction を返す", () => {
    const baseMs = Date.parse("2026-08-25T00:00:00.000Z");
    const store = new StandbyStateStore();
    for (let index = 0; index < BRIEFING_CARD_MAX_ENTRIES - 1; index += 1) {
      const id = `b-${String(index).padStart(3, "0")}`;
      expect(store.applyBriefingCardEvent(minimalBriefingEvent(id, new Date(baseMs).toISOString()), baseMs))
        .toMatchObject({ kind: "applied", evictedKey: null });
    }
    expect(store.briefingCardEntryCount()).toBe(BRIEFING_CARD_MAX_ENTRIES - 1);
    expect(store.applyBriefingCardEvent(minimalBriefingEvent("z-boundary", new Date(baseMs).toISOString()), baseMs))
      .toMatchObject({ kind: "applied", evictedKey: null });
    expect(store.briefingCardEntryCount()).toBe(BRIEFING_CARD_MAX_ENTRIES);

    expect(store.applyBriefingCardEvent(minimalBriefingEvent("a-overflow", new Date(baseMs).toISOString()), baseMs))
      .toMatchObject({ kind: "applied", evictedKey: "card:vpbs:b-000" });
    expect(store.briefingCardEntryCount()).toBe(BRIEFING_CARD_MAX_ENTRIES);
    const entries = store.snapshotBriefingCard()!.data.entries;
    expect(entries).toHaveLength(BRIEFING_CARD_MAX_ENTRIES);
    expect(entries.some((entry) => entry.key === "card:vpbs:b-000")).toBe(false);
    expect(entries.some((entry) => entry.key === "card:vpbs:a-overflow")).toBe(true);
  });

  it("prune 後の追加は eviction を報告せず128件を保つ", () => {
    const nowMs = Date.parse("2026-08-25T02:00:00.000Z");
    const store = new StandbyStateStore();
    store.applyEvent(minimalBriefingEvent("expired-first", new Date(nowMs - BRIEFING_CARD_TTL_MS).toISOString()), nowMs - BRIEFING_CARD_TTL_MS + 1);
    for (let index = 0; index < BRIEFING_CARD_MAX_ENTRIES - 1; index += 1) {
      store.applyEvent(minimalBriefingEvent(`fresh-${index}`, new Date(nowMs).toISOString()), nowMs);
    }

    expect(store.applyBriefingCardEvent(minimalBriefingEvent("fresh-new", new Date(nowMs).toISOString()), nowMs))
      .toMatchObject({ kind: "applied", evictedKey: null });
    expect(store.briefingCardEntryCount()).toBe(BRIEFING_CARD_MAX_ENTRIES);
    expect(store.snapshotBriefingCard()!.data.entries.some((entry) => entry.key === "card:vpbs:expired-first")).toBe(false);
  });

  it("briefing 追加後も既存 kind の snapshot byte shape を変えない", () => {
    const nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const store = new StandbyStateStore();
    store.applyEvent(heatEvent({}, { reportDateTime: new Date(nowMs).toISOString() }), nowMs);
    const before = JSON.stringify(store.snapshotItems().find((item) => item.kind === "heat"));

    store.applyEvent(minimalBriefingEvent("shape-briefing", new Date(nowMs).toISOString()), nowMs);
    expect(JSON.stringify(store.snapshotItems().find((item) => item.kind === "heat"))).toBe(before);
  });

  it("briefing card は persistence export/restore に入らず、process restart で空になる", () => {
    const nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const live = new StandbyStateStore();
    live.applyEvent(minimalBriefingEvent("briefing-restart", new Date(nowMs).toISOString()), nowMs);

    const restored = new StandbyStateStore();
    restored.restoreActiveState(live.exportActiveState(), nowMs);
    expect(restored.snapshotBriefingCard()).toBeNull();
  });

  it("VPBS50 は EventID exact を優先し、同一官署・kind の後報だけを semantic subject へ畳む", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const first = semanticBriefingEvent("first", "2026-08-25T00:00:00.000Z", "1");
    const followup = semanticBriefingEvent("followup", "2026-08-25T00:01:00.000Z", "2", "線状降水帯発生");
    const store = new StandbyStateStore();

    store.applyEvent(first, nowMs);
    store.applyEvent(followup, nowMs);
    const entry = store.snapshotBriefingCard()!.data.entries[0]!;
    expect(store.snapshotBriefingCard()!.data.entries).toHaveLength(1);
    expect(entry).toMatchObject({ sourceEventId: "followup", phenomenonKind: "linearRainObserved" });
    expect(entry.key).toBe("card:vpbs:semantic:linearRainObserved:試験地方気象台");
  });

  it("Condition 集合が増えても初回 subject を固定し、曖昧・空・官署空は exact fallback にする", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const first = semanticBriefingEvent("first", "2026-08-25T00:00:00.000Z", "1", "線状降水帯発生");
    const record = semanticBriefingEvent("record", "2026-08-25T00:00:30.000Z", "1", "記録的短時間大雨");
    const combined = semanticBriefingEvent("combined", "2026-08-25T00:01:00.000Z", "2", "線状降水帯発生");
    const raw = combined.raw as ParsedWeatherBriefing;
    combined.raw = {
      ...raw,
      briefingConditions: ["線状降水帯発生", "記録的短時間大雨"],
      briefingSeverityEvidence: [
        ...raw.briefingSeverityEvidence,
        { ...raw.briefingSeverityEvidence[0]!, condition: "記録的短時間大雨", tag: "recordRain" },
      ],
    };
    const store = new StandbyStateStore();

    store.applyEvent(first, nowMs);
    store.applyEvent(record, nowMs);
    store.applyEvent(combined, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries).toHaveLength(3);
    expect(store.snapshotBriefingCard()!.data.entries.find((entry) => entry.sourceEventId === "combined"))
      .toMatchObject({ key: "card:vpbs:combined", phenomenonKind: null, semanticKey: null });

    const empty = semanticBriefingEvent("empty", "2026-08-25T00:02:00.000Z", "3");
    empty.raw = { ...(empty.raw as ParsedWeatherBriefing), briefingConditions: [], briefingSeverityEvidence: [] };
    const officeEmpty = semanticBriefingEvent("office-empty", "2026-08-25T00:03:00.000Z", "4", "線状降水帯発生", "");
    store.applyEvent(empty, nowMs);
    store.applyEvent(officeEmpty, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries.map((entry) => entry.sourceEventId))
      .toEqual(expect.arrayContaining(["empty", "office-empty"]));
  });

  it("同 revision は payload 一致・相違とも no-op にし、older は semantic entry を置換しない", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const current = semanticBriefingEvent("current", "2026-08-25T00:02:00.000Z", "2");
    const same = semanticBriefingEvent("same", "2026-08-25T00:02:00.000Z", "2");
    const conflict = semanticBriefingEvent("conflict", "2026-08-25T00:02:00.000Z", "2");
    conflict.raw = { ...(conflict.raw as ParsedWeatherBriefing), title: "同revisionだが異なるpayload" };
    const older = semanticBriefingEvent("older", "2026-08-25T00:01:00.000Z", "9");
    const warn = vi.spyOn(log, "warn");
    const store = new StandbyStateStore();

    store.applyEvent(current, nowMs);
    expect(store.applyEvent(same, nowMs)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.applyEvent(conflict, nowMs)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.applyEvent(older, nowMs)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotBriefingCard()!.data.entries[0]!.sourceEventId).toBe("current");
    expect(warn).toHaveBeenCalledWith("[briefing-card] same revision payload conflict key=card:vpbs:semantic:linearRainObserved:試験地方気象台");
    warn.mockRestore();
  });

  it("VPBS50 取消は EventID exact を優先し、EventID 欠落時だけ一意 semantic fallback を許す", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const normal = semanticBriefingEvent("normal", "2026-08-25T00:00:00.000Z", "1");
    const cancel = semanticBriefingEvent("cancel", "2026-08-25T00:01:00.000Z", "2");
    const cancelRaw = cancel.raw as ParsedWeatherBriefing;
    cancel.eventId = null;
    cancel.infoType = "取消";
    cancel.isCancellation = true;
    cancel.raw = { ...cancelRaw, eventId: null, infoType: "取消" };
    const store = new StandbyStateStore();

    store.applyEvent(normal, nowMs);
    store.applyEvent(cancel, nowMs);
    const entry = store.snapshotBriefingCard()!.data.entries[0]!;
    expect(entry).toMatchObject({ sourceEventId: expect.stringContaining("fixture:"), infoType: "取消", frameLevel: "cancel" });
    expect(Date.parse(entry.expiresAt)).toBe(Date.parse(cancel.reportDateTime) + BRIEFING_CARD_CANCEL_TTL_MS);
  });

  it("VPBS50 取消の EventID exact は revision 欠落でも cancel frame に置換する", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const normal = semanticBriefingEvent("cancel-exact", "2026-08-25T00:00:00.000Z", "1");
    const cancel = semanticBriefingEvent("cancel-exact", "", "2");
    const cancelRaw = cancel.raw as ParsedWeatherBriefing;
    cancel.infoType = "取消";
    cancel.isCancellation = true;
    cancel.serial = null;
    cancel.raw = { ...cancelRaw, infoType: "取消", reportDateTime: "", serial: null };
    const store = new StandbyStateStore();

    store.applyEvent(normal, nowMs);
    store.applyEvent(cancel, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries).toEqual([
      expect.objectContaining({
        sourceEventId: "cancel-exact",
        key: "card:vpbs:semantic:linearRainObserved:試験地方気象台",
        infoType: "取消",
        frameLevel: "cancel",
      }),
    ]);
  });

  it("VPBS50 取消は同一 EventID の raw fallback が共存しても semantic subject を確実に取消す", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const normal = semanticBriefingEvent("cancel-many", "2026-08-25T00:00:00.000Z", "1");
    const unordered = semanticBriefingEvent("cancel-many", "2026-08-25T00:01:00.000Z", "2");
    unordered.serial = null;
    unordered.raw = { ...(unordered.raw as ParsedWeatherBriefing), serial: null };
    const cancel = semanticBriefingEvent("cancel-many", "", "3");
    cancel.serial = null;
    cancel.infoType = "取消";
    cancel.isCancellation = true;
    cancel.raw = { ...(cancel.raw as ParsedWeatherBriefing), infoType: "取消", reportDateTime: "", serial: null };
    const store = new StandbyStateStore();

    store.applyEvent(normal, nowMs);
    store.applyEvent(unordered, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries).toHaveLength(2);
    store.applyEvent(cancel, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries).toEqual([
      expect.objectContaining({
        sourceEventId: "cancel-many",
        key: "card:vpbs:semantic:linearRainObserved:試験地方気象台",
        frameLevel: "cancel",
      }),
    ]);
  });

  it("late reconcile は古い canonical で新しい VPBS50 も VPOA50 source も置換しない", () => {
    const source = vpoaEvent(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const canonical = briefingEvent(FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709);
    const newer = semanticBriefingEvent("newer", "2026-08-22T17:10:00+09:00", "2", "記録的短時間大雨", "気象庁本庁");
    const nowMs = Date.parse("2026-08-22T17:11:00+09:00");
    const warn = vi.spyOn(log, "warn");
    const store = new StandbyStateStore();

    store.applyEvent(newer, nowMs);
    store.applyEvent(source, nowMs);
    expect(store.reconcileBriefingCard(`card:vpoa:${source.eventId}`, canonical, nowMs))
      .toMatchObject({ kind: "ignored", reason: "canonicalNotNewer" });
    expect(store.snapshotBriefingCard()!.data.entries.map((entry) => entry.sourceEventId))
      .toEqual(expect.arrayContaining(["newer", source.eventId]));
    expect(warn).toHaveBeenCalledWith("[briefing-card] late reconcile canonical is not newer");
    warn.mockRestore();
  });

  it("late reconcile は unordered canonical で VPBS50 も VPOA50 source も変更しない", () => {
    const source = vpoaEvent(FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709);
    const nowMs = Date.parse(source.reportDateTime) + 1;
    const existing = semanticBriefingEvent("late-existing", "2026-08-22T17:10:00+09:00", "2");
    const unordered = semanticBriefingEvent("late-unordered", "2026-08-22T17:11:00+09:00", "3");
    unordered.serial = null;
    unordered.raw = { ...(unordered.raw as ParsedWeatherBriefing), serial: null };
    const warn = vi.spyOn(log, "warn");
    const store = new StandbyStateStore();

    store.applyEvent(existing, nowMs);
    store.applyEvent(source, nowMs);
    expect(store.reconcileBriefingCard(`card:vpoa:${source.eventId}`, unordered, nowMs))
      .toMatchObject({ kind: "ignored", reason: "canonicalNotNewer" });
    expect(store.snapshotBriefingCard()!.data.entries.map((entry) => entry.sourceEventId))
      .toEqual(expect.arrayContaining(["late-existing", source.eventId]));
    expect(warn).toHaveBeenCalledWith("[briefing-card] late reconcile canonical is unordered");
    warn.mockRestore();
  });

  it("exact EventID は競合する Condition 集合より先に既存 subject を解決する", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const issued = semanticBriefingEvent("exact", "2026-08-25T00:00:00.000Z", "1", "線状降水帯発生");
    const competing = semanticBriefingEvent("competing", "2026-08-25T00:00:10.000Z", "1", "記録的短時間大雨");
    const corrected = semanticBriefingEvent("exact", "2026-08-25T00:01:00.000Z", "2", "記録的短時間大雨");
    const store = new StandbyStateStore();

    store.applyEvent(issued, nowMs);
    store.applyEvent(competing, nowMs);
    store.applyEvent(corrected, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceEventId: "exact", phenomenonKind: "linearRainObserved", semanticKey: "card:vpbs:semantic:linearRainObserved:試験地方気象台" }),
      expect.objectContaining({ sourceEventId: "competing", phenomenonKind: "recordRain" }),
    ]));
  });

  it("一意 subject は Condition 追加後も初回 kind/key を保ち、raw fallback を候補に混ぜない", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const first = semanticBriefingEvent("first", "2026-08-25T00:00:00.000Z", "1");
    const added = semanticBriefingEvent("added", "2026-08-25T00:01:00.000Z", "2");
    const addedRaw = added.raw as ParsedWeatherBriefing;
    added.raw = { ...addedRaw, briefingConditions: ["線状降水帯発生", "記録的短時間大雨"], briefingSeverityEvidence: [
      ...addedRaw.briefingSeverityEvidence,
      { ...addedRaw.briefingSeverityEvidence[0]!, condition: "記録的短時間大雨", tag: "recordRain" },
    ] };
    const record = semanticBriefingEvent("record", "2026-08-25T00:01:20.000Z", "3", "記録的短時間大雨");
    const rawFallback = semanticBriefingEvent("raw", "2026-08-25T00:01:30.000Z", "3", "記録的短時間大雨");
    const rawFallbackRaw = rawFallback.raw as ParsedWeatherBriefing;
    rawFallback.raw = { ...rawFallbackRaw, briefingConditions: ["線状降水帯発生", "記録的短時間大雨"], briefingSeverityEvidence: [
      ...rawFallbackRaw.briefingSeverityEvidence,
      { ...rawFallbackRaw.briefingSeverityEvidence[0]!, condition: "線状降水帯発生", tag: "linearRainObserved" },
    ] };
    const followup = semanticBriefingEvent("followup", "2026-08-25T00:02:00.000Z", "4", "線状降水帯発生");
    const store = new StandbyStateStore();

    store.applyEvent(first, nowMs);
    store.applyEvent(added, nowMs);
    store.applyEvent(record, nowMs);
    store.applyEvent(rawFallback, nowMs);
    store.applyEvent(followup, nowMs);
    const entries = store.snapshotBriefingCard()!.data.entries;
    expect(entries.find((entry) => entry.sourceEventId === "followup"))
      .toMatchObject({ key: "card:vpbs:semantic:linearRainObserved:試験地方気象台", phenomenonKind: "linearRainObserved" });
    expect(entries.find((entry) => entry.sourceEventId === "raw"))
      .toMatchObject({ key: "card:vpbs:raw", editorialOffice: "試験地方気象台", semanticKey: null, phenomenonKind: null });
  });

  it("EventID 欠落取消の複数 semantic 候補は保護し、VPOA50取消とは混ざらない", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const linear = semanticBriefingEvent("linear", "2026-08-25T00:00:00.000Z", "1");
    const record = semanticBriefingEvent("record", "2026-08-25T00:00:10.000Z", "1", "記録的短時間大雨");
    const cancel = semanticBriefingEvent("cancel", "2026-08-25T00:01:00.000Z", "2");
    const cancelRaw = cancel.raw as ParsedWeatherBriefing;
    cancel.eventId = null;
    cancel.infoType = "取消";
    cancel.isCancellation = true;
    cancel.raw = { ...cancelRaw, eventId: null, infoType: "取消", briefingConditions: ["線状降水帯発生", "記録的短時間大雨"], briefingSeverityEvidence: [
      ...cancelRaw.briefingSeverityEvidence,
      { ...cancelRaw.briefingSeverityEvidence[0]!, condition: "記録的短時間大雨", tag: "recordRain" },
    ] };
    const vpoaCancel = vpoaEvent(FIXTURE_VPOA50_SYNTH_CANCEL);
    const warn = vi.spyOn(log, "warn");
    const store = new StandbyStateStore();

    store.applyEvent(linear, nowMs);
    store.applyEvent(record, nowMs);
    expect(store.applyEvent(cancel, nowMs)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotBriefingCard()!.data.entries).toHaveLength(2);
    store.applyEvent(vpoaCancel, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries.filter((entry) => entry.source === "vpbs50")).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("[briefing-card] cancellation semantic target is ambiguous");
    warn.mockRestore();
  });

  it("NFKC Condition と4種 K の順序を固定する", () => {
    expect(["線状降水帯　直前", "線状降水帯", "記録的短時間大雨", "短時間大雪"].map(deriveBriefingTag))
      .toEqual(["linearRainPredicted", "linearRainObserved", "recordRain", "shortSnow"]);
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const all = semanticBriefingEvent("all", "2026-08-25T00:00:00.000Z", "1");
    const raw = all.raw as ParsedWeatherBriefing;
    all.raw = { ...raw, briefingConditions: ["短時間大雪", "記録的短時間大雨", "線状降水帯直前", "線状降水帯発生"], briefingSeverityEvidence: [
      { ...raw.briefingSeverityEvidence[0]!, condition: "短時間大雪", tag: "shortSnow" },
      { ...raw.briefingSeverityEvidence[0]!, condition: "記録的短時間大雨", tag: "recordRain" },
      { ...raw.briefingSeverityEvidence[0]!, condition: "線状降水帯直前", tag: "linearRainPredicted" },
      { ...raw.briefingSeverityEvidence[0]!, condition: "線状降水帯発生", tag: "linearRainObserved" },
    ] };
    const store = new StandbyStateStore();
    store.applyEvent(all, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries[0]!.phenomenonKind).toBe("linearRainObserved");
  });

  it("unordered exact は semantic subject を上書きせず raw exact fallback にし、prune は ignored 経路でも通知する", () => {
    const nowMs = Date.parse("2026-08-25T00:10:00.000Z");
    const issued = semanticBriefingEvent("same", "2026-08-25T00:00:00.000Z", "1");
    const unordered = semanticBriefingEvent("same", "2026-08-25T00:01:00.000Z", "2");
    unordered.raw = { ...(unordered.raw as ParsedWeatherBriefing), serial: null };
    unordered.serial = null;
    const expired = semanticBriefingEvent("expired", "2026-08-24T21:59:00.000Z", "1");
    expired.raw = { ...(expired.raw as ParsedWeatherBriefing), editorialOffice: "" };
    const missingCancel = semanticBriefingEvent("missing", "2026-08-25T00:02:00.000Z", "2");
    missingCancel.infoType = "取消";
    missingCancel.isCancellation = true;
    missingCancel.raw = { ...(missingCancel.raw as ParsedWeatherBriefing), infoType: "取消" };
    const store = new StandbyStateStore();

    store.applyEvent(issued, nowMs);
    store.applyEvent(unordered, nowMs);
    expect(store.snapshotBriefingCard()!.data.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceEventId: "same", semanticKey: "card:vpbs:semantic:linearRainObserved:試験地方気象台" }),
      expect.objectContaining({ key: "card:vpbs:same", semanticKey: null }),
    ]));
    store.applyEvent(expired, Date.parse("2026-08-24T22:00:00.000Z"));
    expect(store.applyEvent(missingCancel, nowMs)).toEqual({ viewChanged: true, durableChanged: false });
  });

  it("cancel frame の TTL 後も semantic revision watermark は遅着旧報の復活を防ぐ", () => {
    const issuedAtMs = Date.parse("2026-08-25T00:00:00.000Z");
    const cancelAtMs = issuedAtMs + 60_000;
    const issued = semanticBriefingEvent("watermark-current", new Date(issuedAtMs).toISOString(), "2");
    const cancel = semanticBriefingEvent("watermark-current", new Date(cancelAtMs).toISOString(), "3");
    cancel.infoType = "取消";
    cancel.isCancellation = true;
    cancel.raw = { ...(cancel.raw as ParsedWeatherBriefing), infoType: "取消" };
    const lateOlder = semanticBriefingEvent("watermark-late", new Date(issuedAtMs).toISOString(), "1");
    const store = new StandbyStateStore();

    store.applyEvent(issued, issuedAtMs);
    store.applyEvent(cancel, cancelAtMs);
    expect(store.sweep(cancelAtMs + BRIEFING_CARD_CANCEL_TTL_MS)).toEqual({ viewChanged: true, durableChanged: false });
    expect(store.snapshotBriefingCard()).toBeNull();
    expect(store.applyEvent(lateOlder, cancelAtMs + BRIEFING_CARD_CANCEL_TTL_MS))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotBriefingCard()).toBeNull();
  });

  it("TTL 切れ取消の到着でも取消 revision watermark は中間 revision の遅着報を防ぐ", () => {
    const issuedAtMs = Date.parse("2026-08-25T00:00:00.000Z");
    const cancelReportAtMs = issuedAtMs + BRIEFING_CARD_CANCEL_TTL_MS;
    const cancelArrivalAtMs = cancelReportAtMs + BRIEFING_CARD_CANCEL_TTL_MS;
    const issued = semanticBriefingEvent("expired-cancel-current", new Date(issuedAtMs).toISOString(), "1");
    const cancel = semanticBriefingEvent("expired-cancel-current", new Date(cancelReportAtMs).toISOString(), "3");
    cancel.infoType = "取消";
    cancel.isCancellation = true;
    cancel.raw = { ...(cancel.raw as ParsedWeatherBriefing), infoType: "取消" };
    const intermediateLate = semanticBriefingEvent("expired-cancel-late", new Date(issuedAtMs + 5 * 60_000).toISOString(), "2");
    const store = new StandbyStateStore();

    store.applyEvent(issued, issuedAtMs);
    expect(store.applyEvent(cancel, cancelArrivalAtMs)).toEqual({ viewChanged: true, durableChanged: false });
    expect(store.snapshotBriefingCard()).toBeNull();
    expect(store.applyEvent(intermediateLate, cancelArrivalAtMs)).toEqual({ viewChanged: false, durableChanged: false });
    expect(store.snapshotBriefingCard()).toBeNull();
  });
});
