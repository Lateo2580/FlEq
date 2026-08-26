import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsDataMessage } from "../../../src/types";
import { normalizeTelegramMessage } from "../../../src/dmdata/telegram-ingress";
import { createDisplaySink } from "../../../src/engine/monitor/display-sink";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { WeatherPromotionStore } from "../../../src/engine/display/weather-promotion-store";
import { LARGE_QUAKE_HOLD_MIN } from "../../../src/engine/display/constants";
import type {
  DisplayServerMessageWithReconcile,
  DisplayTransport,
} from "../../../src/engine/display/types";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { DailyQuakePersistence } from "../../../src/engine/messages/daily-quake-persistence";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type {
  PresentationEvent,
  ProcessOutcome,
  VolcanoBatchOutcome,
} from "../../../src/engine/presentation/types";
import { quakeObservationMetaOf } from "../../../src/engine/display/quake-observation-merge";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_PHASE7_5_VXSE53_073149,
  FIXTURE_PHASE7_5_VXSE53_073528,
  readFixture,
} from "../../helpers/mock-message";
import { notifyMock } from "../../setup";
import { playSound } from "../../../src/engine/notification/sound-player";

const REAL_VXSE53_FIRST = FIXTURE_PHASE7_5_VXSE53_073149;
const REAL_VXSE53_SECOND = FIXTURE_PHASE7_5_VXSE53_073528;
const UNKNOWN_VALUE = "未入電";
const UNKNOWN_HOST_TTL_MS = 5 * 60_000;
const tempDirs: string[] = [];

/**
 * 単位7の synthetic は手組み電文ではない。
 * tracked 実 XML の要素・属性・階層を保ち、震度値本文だけを plain 未入電へ置換する。
 */
function allUnknownXmlFromRealFixture(xml: string): string {
  const withPlainUnknownCondition = xml.replaceAll("震度５弱以上未入電", UNKNOWN_VALUE);
  return withPlainUnknownCondition.replace(
    /<(MaxInt|Int)([^>]*)>[^<]*<\/\1>/g,
    (_match: string, tag: string, attributes: string) =>
      `<${tag}${attributes}>${UNKNOWN_VALUE}</${tag}>`,
  );
}

class CapturingTransport implements DisplayTransport {
  readonly messages: DisplayServerMessageWithReconcile[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  broadcast(message: DisplayServerMessageWithReconcile): { total: number; blockedSkipped: number } {
    this.messages.push(message);
    return { total: 1, blockedSkipped: 0 };
  }

  clientCount(): number {
    return 1;
  }
}

interface ProductionHarness {
  readonly daily: DailyQuakeCounter;
  readonly display: DisplayStateStore;
  readonly hub: InfoDisplayHub;
  readonly handler: ReturnType<typeof createMessageHandler>;
  readonly outcomes: ProcessOutcome[];
  readonly events: PresentationEvent[];
  readonly transport: CapturingTransport;
  setNow(nowMs: number): void;
}

function linearOutcome(candidate: ProcessOutcome | VolcanoBatchOutcome): ProcessOutcome {
  if (candidate.domain === "volcano" && "sources" in candidate) {
    throw new Error("earthquake fixture unexpectedly produced a volcano batch");
  }
  return candidate;
}

function productionHarness(initialNowMs: number): ProductionHarness {
  let nowMs = initialNowMs;
  vi.setSystemTime(initialNowMs);
  const daily = new DailyQuakeCounter(initialNowMs);
  const standby = new StandbyStateStore();
  const events: PresentationEvent[] = [];
  const outcomes: ProcessOutcome[] = [];
  const transport = new CapturingTransport();
  const display = new DisplayStateStore(
    () => standby.snapshotItems(),
    undefined,
    undefined,
    () => daily.getRecentQuakes(nowMs),
  );
  let hub: InfoDisplayHub | null = null;
  const sink = createDisplaySink({
    standby: {
      applyEvent: (event, eventNowMs) => {
        events.push(event);
        return standby.applyEvent(event, eventNowMs);
      },
    },
    promotions: new WeatherPromotionStore(),
    dailyQuakes: daily,
    weatherViews: {
      vpws50: () => undefined,
      vpww56: () => undefined,
    },
    getHub: () => hub,
    now: () => nowMs,
  });
  const handler = createMessageHandler({
    dailyQuakeCounter: daily,
    displaySink: sink,
    outcomeTaps: [(candidate) => outcomes.push(linearOutcome(candidate))],
  });
  handler.notifier.setAll(true);
  handler.notifier.setSoundEnabled(true);
  hub = new InfoDisplayHub(display, {
    summarize: (event) => event.title,
    weatherAlerts: () => [],
    now: () => nowMs,
  });
  hub.attachTransport(transport);

  return {
    daily,
    display,
    hub,
    handler,
    outcomes,
    events,
    transport,
    setNow: (nextNowMs) => {
      nowMs = nextNowMs;
      vi.setSystemTime(nextNowMs);
    },
  };
}

function receivedMessage(
  message: WsDataMessage,
  id: string,
  receivedAtMs: number,
): WsDataMessage {
  return normalizeTelegramMessage(
    { ...message, id, meta: undefined },
    receivedAtMs,
  ).message;
}

function deliverFixture(
  harness: ProductionHarness,
  fixture: string,
  id: string,
  receivedAtMs: number,
): void {
  harness.setNow(receivedAtMs);
  harness.handler.handler(receivedMessage(createMockWsDataMessage(fixture), id, receivedAtMs));
}

function deliverXml(
  harness: ProductionHarness,
  xml: string,
  type: string,
  id: string,
  receivedAtMs: number,
): void {
  harness.setNow(receivedAtMs);
  harness.handler.handler(
    receivedMessage(createMockWsDataMessageFromXml(xml, type), id, receivedAtMs),
  );
}

function reportDateTimeMs(fixture: string): number {
  const reportDateTime = createMockWsDataMessage(fixture).xmlReport?.head.reportDateTime;
  const result = reportDateTime == null ? Number.NaN : Date.parse(reportDateTime);
  if (!Number.isFinite(result)) throw new Error(`invalid fixture report time: ${fixture}`);
  return result;
}

function reportDateTimeMsFromXml(xml: string, type: string): number {
  const reportDateTime = createMockWsDataMessageFromXml(xml, type).xmlReport?.head.reportDateTime;
  const result = reportDateTime == null ? Number.NaN : Date.parse(reportDateTime);
  if (!Number.isFinite(result)) throw new Error(`invalid synthetic report time: ${type}`);
  return result;
}

function earthquakeOutcome(harness: ProductionHarness, index = 0): Extract<
  ProcessOutcome,
  { domain: "earthquake" }
> {
  const outcome = harness.outcomes[index];
  if (outcome == null || outcome.domain !== "earthquake") {
    throw new Error(`expected earthquake outcome at index ${index}`);
  }
  return outcome;
}

function presentationEvent(harness: ProductionHarness, index = 0): PresentationEvent {
  const event = harness.events[index];
  if (event == null) throw new Error(`missing presentation event at index ${index}`);
  return event;
}

function eventDto(harness: ProductionHarness): Extract<
  DisplayServerMessageWithReconcile,
  { type: "event" }
>["event"] {
  const message = [...harness.transport.messages]
    .reverse()
    .find((candidate): candidate is Extract<DisplayServerMessageWithReconcile, { type: "event" }> =>
      candidate.type === "event");
  if (message == null) throw new Error("missing display event frame");
  return message.event;
}

function notificationBodies(): string[] {
  return notifyMock.mock.calls.map((call) => {
    const value = call[0] as { message?: unknown } | undefined;
    return typeof value?.message === "string" ? value.message : "";
  });
}

function persistAndRestore(counter: DailyQuakeCounter, nowMs: number): DailyQuakeCounter {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), `.phase7_5-unit7-${process.pid}-`));
  tempDirs.push(tempDir);
  const persistence = new DailyQuakePersistence(path.join(tempDir, "daily-quake.json"), 0);
  persistence.save(counter.export(), nowMs + 1);
  const loaded = persistence.load(nowMs + 2);
  persistence.dispose();
  if (loaded == null) throw new Error("daily persistence did not load");
  const restored = new DailyQuakeCounter(nowMs + 2);
  if (!restored.restore(loaded, nowMs + 2)) throw new Error("daily persistence restore rejected");
  return restored;
}

function restartDisplaySnapshot(
  counter: DailyQuakeCounter,
  dto: ReturnType<typeof eventDto>,
  nowMs: number,
) {
  const display = new DisplayStateStore(
    undefined,
    undefined,
    undefined,
    () => counter.getRecentQuakes(nowMs),
  );
  display.applyEvent(dto, nowMs);
  return display.snapshot(1, nowMs);
}

function withoutUpdatedAt<T extends { updatedAtMs: number }>(value: T | null): Omit<T, "updatedAtMs"> | null {
  if (value == null) return null;
  const { updatedAtMs: _updatedAtMs, ...semantic } = value;
  return semantic;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  notifyMock.mockClear();
  vi.mocked(playSound).mockClear();
});

describe("§7.5 unit 7: earthquake production-shaped end-to-end gate", () => {
  it("実 VXSE53 は parser の Pref/Area/City/Station provenance を実経路の表示状態まで運ぶ", () => {
    const nowMs = reportDateTimeMs(REAL_VXSE53_FIRST);
    const harness = productionHarness(nowMs);
    deliverFixture(harness, REAL_VXSE53_FIRST, "phase7.5:real:qualitative", nowMs);

    const outcome = earthquakeOutcome(harness);
    const parsed = outcome.parsed;
    expect(parsed.intensity?.maxIntValue).toMatchObject({
      raw: "7",
      value: "7",
      presence: "value",
    });
    expect(parsed.intensity?.prefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "43",
        maxIntValue: expect.objectContaining({ raw: "7", value: "7", presence: "value" }),
      }),
    ]));
    expect(parsed.intensity?.areas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "741",
        intensityValue: expect.objectContaining({ raw: "7", value: "7", presence: "value" }),
      }),
    ]));
    expect(parsed.intensity?.municipalities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "嘉島町",
        code: "4344200",
        intensityValue: expect.objectContaining({
          raw: "",
          value: null,
          condition: "震度５弱以上未入電",
          presence: "qualitative",
          lowerBound: "5-",
        }),
      }),
    ]));
    expect(parsed.intensity?.stations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "4321336",
        intensityValue: expect.objectContaining({
          raw: "震度５弱以上未入電",
          value: null,
          presence: "qualitative",
          lowerBound: "5-",
        }),
      }),
    ]));

    const event = presentationEvent(harness);
    expect(event).toMatchObject({
      domain: "earthquake",
      type: "VXSE53",
      frameLevel: "critical",
      soundLevel: "warning",
      maxInt: "7",
      maxIntRank: 9,
    });
    expect(event.quakeIntensityValues?.municipalities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "4344200",
        maxIntValue: expect.objectContaining({ presence: "qualitative", lowerBound: "5-" }),
      }),
    ]));

    const dto = eventDto(harness);
    expect(dto).toMatchObject({
      frameLevel: "critical",
      recentQuake: { eventId: "20260728162718", maxInt: "7", maxIntRank: 9 },
      latestQuake: { eventId: "20260728162718", maxInt: "7", maxIntRank: 9 },
    });
    expect(dto.tickerSentence).toContain("最大震度7");
    const snapshot = harness.hub.buildSnapshot();
    expect(snapshot.mapLayers?.quake?.events[0]).toMatchObject({
      eventId: "20260728162718",
      maxInt: "7",
      maxIntRank: 9,
    });
    expect(snapshot.mapLayers?.quake?.events[0]?.localAreas.length).toBeGreaterThan(0);
    expect(snapshot.largeQuakes[0]).toMatchObject({
      eventId: "20260728162718",
      maxInt: "7",
      maxIntRank: 9,
    });
    expect(snapshot.latestQuake).toMatchObject({
      eventId: "20260728162718",
      maxInt: "7",
      maxIntRank: 9,
    });
    expect(snapshot.recentQuakes[0]).toMatchObject({
      eventId: "20260728162718",
      maxInt: "7",
      maxIntRank: 9,
    });
    expect(harness.daily.getSnapshot(nowMs)).toEqual({
      todayQuakeCount: 1,
      todayMaxInt: "7",
      todayMaxIntRank: 9,
    });
    const liveHistory = harness.daily.getRecentQuakes(nowMs);
    const liveHistoryRow = liveHistory[0];
    if (liveHistoryRow == null) throw new Error("live real-fixture history row missing");
    const restored = persistAndRestore(harness.daily, nowMs);
    expect(restored.getSnapshot(nowMs + 2)).toEqual(harness.daily.getSnapshot(nowMs));
    expect(restored.getRecentQuakes(nowMs + 2)).toEqual(liveHistory);
    const restoredHistoryRow = restored.getRecentQuakes(nowMs + 2)[0];
    if (restoredHistoryRow == null) throw new Error("restored real-fixture history row missing");
    expect(quakeObservationMetaOf(restoredHistoryRow)).toEqual(quakeObservationMetaOf(liveHistoryRow));
    const restartedSnapshot = restartDisplaySnapshot(restored, dto, nowMs + 2);
    expect(withoutUpdatedAt(restartedSnapshot.latestQuake)).toEqual(
      withoutUpdatedAt(snapshot.latestQuake),
    );
    expect(restartedSnapshot.recentQuakes).toEqual(snapshot.recentQuakes);
    expect(notificationBodies()[0]).toContain("最大震度7");
    expect(vi.mocked(playSound).mock.calls.map(([level]) => level)).toContain("warning");
  });

  it("synthetic all-unknown は実 XML shape の値置換だけで info/unknownHost/履歴を作る", () => {
    const xml = allUnknownXmlFromRealFixture(readFixture(REAL_VXSE53_SECOND));
    const nowMs = reportDateTimeMsFromXml(xml, "VXSE53");
    const harness = productionHarness(nowMs);
    deliverXml(harness, xml, "VXSE53", "phase7.5:synthetic:all-unknown", nowMs);

    const outcome = earthquakeOutcome(harness);
    expect(outcome.parsed.intensity?.maxIntValue).toMatchObject({
      raw: UNKNOWN_VALUE,
      value: null,
      presence: "unknown",
    });
    expect(outcome.parsed.intensity?.prefs?.[0]?.maxIntValue).toMatchObject({
      raw: UNKNOWN_VALUE,
      value: null,
      presence: "unknown",
    });
    expect(outcome.parsed.intensity?.areas[0]?.intensityValue).toMatchObject({
      raw: UNKNOWN_VALUE,
      value: null,
      presence: "unknown",
    });
    expect(outcome.parsed.intensity?.municipalities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "4344200",
        intensityValue: expect.objectContaining({ condition: UNKNOWN_VALUE, presence: "unknown" }),
      }),
    ]));
    expect(outcome.parsed.intensity?.stations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "4321336",
        intensityValue: expect.objectContaining({ raw: UNKNOWN_VALUE, presence: "unknown" }),
      }),
    ]));

    const event = presentationEvent(harness);
    expect(event).toMatchObject({
      domain: "earthquake",
      frameLevel: "info",
      soundLevel: "info",
      maxInt: null,
      maxIntRank: null,
      maxIntValue: { raw: UNKNOWN_VALUE, value: null, presence: "unknown" },
    });
    expect(event.maxIntLabel).toContain(UNKNOWN_VALUE);
    const dto = eventDto(harness);
    expect(dto.frameLevel).toBe("info");
    expect(dto.tickerSentence).toContain("最大震度不明（未入電）");
    expect(dto.recentQuake).toMatchObject({
      eventId: "20260728162718",
      maxInt: null,
      maxIntRank: null,
      maxIntSemantic: expect.objectContaining({
        presence: "unknown",
        label: "不明（未入電）",
        badge: "?",
        color: "unknown",
      }),
    });

    const snapshot = harness.hub.buildSnapshot();
    const map = snapshot.mapLayers?.quake;
    expect(map).toMatchObject({
      nonEmergencyHost: null,
      unknownHost: {
        eventKey: "earthquake:20260728162718",
        expiresAtMs: nowMs + UNKNOWN_HOST_TTL_MS,
      },
    });
    expect(map?.events[0]).toMatchObject({
      eventKey: "earthquake:20260728162718",
      maxIntRank: -1,
      maxIntSemantic: expect.objectContaining({
        presence: "unknown",
        label: "不明（未入電）",
        badge: "?",
        color: "unknown",
        colorRank: null,
      }),
    });
    expect(map?.events[0]?.localAreas.length).toBeGreaterThan(0);
    expect(map?.events[0]?.localAreas.map(({ rank }) => rank)).not.toContain(0);
    expect(snapshot.largeQuakes).toHaveLength(0);
    expect(snapshot.severityTier).toBe("calm");
    expect(snapshot.latestQuake).toMatchObject({
      maxInt: null,
      maxIntRank: null,
      maxIntSemantic: expect.objectContaining({ presence: "unknown", badge: "?" }),
    });
    expect(snapshot.recentQuakes[0]).toMatchObject({
      maxInt: null,
      maxIntRank: null,
      maxIntSemantic: expect.objectContaining({ presence: "unknown", badge: "?" }),
    });
    expect(harness.daily.getSnapshot(nowMs)).toEqual({
      todayQuakeCount: 0,
      todayMaxInt: null,
      todayMaxIntRank: null,
    });
    const liveHistory = harness.daily.getRecentQuakes(nowMs);
    const liveHistoryRow = liveHistory[0];
    if (liveHistoryRow == null) throw new Error("live unknown history row missing");
    const restored = persistAndRestore(harness.daily, nowMs);
    expect(restored.getSnapshot(nowMs + 2)).toEqual({
      todayQuakeCount: 0,
      todayMaxInt: null,
      todayMaxIntRank: null,
    });
    expect(restored.getRecentQuakes(nowMs + 2)).toEqual(liveHistory);
    const restoredRecent = restored.getRecentQuakes(nowMs + 2)[0];
    if (restoredRecent == null) throw new Error("restored unknown recent row missing");
    expect(restoredRecent.intensityGroups).toEqual(liveHistoryRow.intensityGroups);
    expect(quakeObservationMetaOf(restoredRecent)).toEqual(quakeObservationMetaOf(liveHistoryRow));
    const restartedSnapshot = restartDisplaySnapshot(restored, dto, nowMs + 2);
    expect(withoutUpdatedAt(restartedSnapshot.latestQuake)).toEqual(
      withoutUpdatedAt(snapshot.latestQuake),
    );
    expect(restartedSnapshot.recentQuakes).toEqual(snapshot.recentQuakes);
    expect(notificationBodies()).toHaveLength(1);
    expect(notificationBodies()[0]).toContain("最大震度は不明とみられます（未入電）");
    expect(vi.mocked(playSound).mock.calls.map(([level]) => level)).toContain("info");
  });

  it("既知 emergency→unknown 続報は通知 cadence を保ち、map contribution/large-quake を降格しない", () => {
    const firstNowMs = reportDateTimeMs(REAL_VXSE53_FIRST);
    const secondXml = allUnknownXmlFromRealFixture(readFixture(REAL_VXSE53_SECOND));
    const secondNowMs = reportDateTimeMsFromXml(secondXml, "VXSE53");
    const harness = productionHarness(firstNowMs);
    deliverFixture(harness, REAL_VXSE53_FIRST, "phase7.5:known:first", firstNowMs);
    const firstSnapshot = harness.hub.buildSnapshot();
    expect(firstSnapshot.mapLayers?.quake?.events[0]).toMatchObject({ maxInt: "7", maxIntRank: 9 });
    expect(firstSnapshot.largeQuakes[0]).toMatchObject({ maxInt: "7", maxIntRank: 9 });

    deliverXml(harness, secondXml, "VXSE53", "phase7.5:known:unknown-followup", secondNowMs);
    const secondOutcome = earthquakeOutcome(harness, 1);
    expect(secondOutcome.presentation).toMatchObject({ frameLevel: "info", soundLevel: "info" });
    expect(harness.outcomes).toHaveLength(2);
    expect(harness.events).toHaveLength(2);
    expect(harness.transport.messages.filter((message) => message.type === "event")).toHaveLength(2);
    expect(eventDto(harness)).toMatchObject({ frameLevel: "info" });
    expect(eventDto(harness).tickerSentence).toContain("未入電");

    const snapshot = harness.hub.buildSnapshot();
    const map = snapshot.mapLayers?.quake;
    expect(map?.unknownHost).toBeUndefined();
    expect(map?.events).toHaveLength(1);
    expect(map?.events[0]).toMatchObject({
      sourceType: "VXSE53",
      maxInt: "7",
      maxIntRank: 9,
      updatedAtMs: firstNowMs,
    });
    expect(map?.events[0]?.localAreas.map(({ rank }) => rank)).not.toContain(0);
    expect(snapshot.largeQuakes).toHaveLength(1);
    expect(snapshot.largeQuakes[0]).toMatchObject({
      eventId: "20260728162718",
      maxInt: "7",
      maxIntRank: 9,
      updatedAtMs: firstNowMs,
    });
    expect(snapshot.recentQuakes[0]).toMatchObject({
      eventId: "20260728162718",
      maxInt: null,
      maxIntRank: null,
      maxIntSemantic: expect.objectContaining({ presence: "unknown", badge: "?" }),
    });
    expect(snapshot.latestQuake).toMatchObject({
      eventId: "20260728162718",
      maxInt: null,
      maxIntRank: null,
      maxIntSemantic: expect.objectContaining({ presence: "unknown", badge: "?" }),
    });
    expect(harness.daily.getSnapshot(secondNowMs)).toEqual({
      todayQuakeCount: 1,
      todayMaxInt: "7",
      todayMaxIntRank: 9,
    });
    const liveHistory = harness.daily.getRecentQuakes(secondNowMs);
    const liveHistoryRow = liveHistory[0];
    if (liveHistoryRow == null) throw new Error("live emergency-to-unknown history row missing");
    expect(notificationBodies()).toHaveLength(2);
    expect(notificationBodies()[1]).toContain("未入電");
    expect(vi.mocked(playSound).mock.calls.map(([level]) => level)).toEqual(
      expect.arrayContaining(["warning", "info"]),
    );

    harness.setNow(firstNowMs + LARGE_QUAKE_HOLD_MIN * 60_000 + 1);
    expect(harness.display.sweep(firstNowMs + LARGE_QUAKE_HOLD_MIN * 60_000 + 1)).toBe(true);
    expect(harness.hub.buildSnapshot().largeQuakes).toHaveLength(0);

    const restored = persistAndRestore(harness.daily, secondNowMs);
    expect(restored.getSnapshot(secondNowMs + 2)).toEqual({
      todayQuakeCount: 1,
      todayMaxInt: "7",
      todayMaxIntRank: 9,
    });
    expect(restored.getRecentQuakes(secondNowMs + 2)).toEqual(liveHistory);
    const restoredRecent = restored.getRecentQuakes(secondNowMs + 2)[0];
    if (restoredRecent == null) throw new Error("restored emergency→unknown row missing");
    expect(restoredRecent.intensityGroups).toEqual(liveHistoryRow.intensityGroups);
    expect(quakeObservationMetaOf(restoredRecent)).toEqual(quakeObservationMetaOf(liveHistoryRow));
    const restartedSnapshot = restartDisplaySnapshot(restored, eventDto(harness), secondNowMs + 2);
    expect(withoutUpdatedAt(restartedSnapshot.latestQuake)).toEqual(
      withoutUpdatedAt(snapshot.latestQuake),
    );
    expect(restartedSnapshot.recentQuakes).toEqual(snapshot.recentQuakes);
  });
});
