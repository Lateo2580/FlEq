import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE51_SHINDO,
  readFixture,
} from "../../helpers/mock-message";
import { normalizeTelegramMessage } from "../../../src/dmdata/telegram-ingress";
import {
  LegacyCounterpartCorrelator,
  type LegacyCounterpartCorrelatorFactory,
} from "../../../src/engine/messages/legacy-counterpart-correlator";
import {
  createLegacyCounterpartRegistry,
  LEGACY_CORRELATION_WINDOW_AFTER_MS,
  LEGACY_CORRELATION_WINDOW_BEFORE_MS,
  LEGACY_SOURCE_HOLDBACK_MS,
} from "../../../src/engine/messages/legacy-counterpart-registry";
import * as log from "../../../src/logger";

// sound-player をモックしてテスト中に通知音が鳴るのを抑制
vi.mock("../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

function createMockDisplay(): DisplayCallbacks {
  return {
    displayOutcome: vi.fn(),
    displayRawHeader: vi.fn(),
    displayVolcano: vi.fn(),
    displayVolcanoBatch: vi.fn(),
    getDisplayMode: () => "normal",
    renderSummaryLine: () => "要約",
  };
}

function displayLegacyMessage(type: "VPOA50" | "SYNTH-CP", id: string, eventId: string) {
  const base = createMockWsDataMessageFromXml(readFixture(FIXTURE_VXSE51_SHINDO), type);
  if (base.xmlReport == null) throw new Error("fixture envelope is missing");
  const nowMs = Date.now();
  return normalizeTelegramMessage({
    ...base,
    id,
    classification: "classification.synthetic",
    head: { ...base.head, type, time: new Date(nowMs).toISOString() },
    xmlReport: {
      ...base.xmlReport,
      head: {
        ...base.xmlReport.head,
        title: type === "VPOA50" ? "旧形式情報" : "synthetic counterpart",
        reportDateTime: new Date(nowMs).toISOString(),
        eventId,
        serial: "1",
        infoType: "発表",
      },
    },
    meta: undefined,
  }, nowMs).message;
}

function displayLegacyCorrelatorFactory(): LegacyCounterpartCorrelatorFactory {
  const registry = createLegacyCounterpartRegistry([{
    sourceType: "VPOA50",
    status: "confirmed",
    counterpartTypes: ["SYNTH-CP"],
    extractEventKey: () => ({
      officeCode: "DISPLAY-OFFICE",
      areaCodes: ["DISPLAY-AREA"],
      phenomenonCodes: ["DISPLAY-PHENOM"],
      kindCodes: ["DISPLAY-KIND"],
      targetTimeMs: Date.parse("2026-08-11T00:00:00.000Z"),
    }),
    windowBeforeMs: LEGACY_CORRELATION_WINDOW_BEFORE_MS,
    windowAfterMs: LEGACY_CORRELATION_WINDOW_AFTER_MS,
    holdbackMs: LEGACY_SOURCE_HOLDBACK_MS,
  }]);
  return ({ actionSink, lifecycleEventSink }) =>
    new LegacyCounterpartCorrelator({ registry, onAction: actionSink, onLifecycleEvent: lifecycleEventSink });
}

describe("message-router displaySink 挿入", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("displaySink.ingest が電文 1 通につき 1 回呼ばれる", () => {
    const ingested: PresentationEvent[] = [];
    const sink: DisplayIngestSink = { ingest: (e) => ingested.push(e) };
    const display = createMockDisplay();
    const { handler } = createMessageHandler({ display, displaySink: sink });

    handler(createMockWsDataMessage(FIXTURE_VXSE53_ENCHI));

    expect(ingested).toHaveLength(1);
  });

  it("ingest に渡る event は raw を持つ PresentationEvent (summary 生成用)", () => {
    const ingested: PresentationEvent[] = [];
    const sink: DisplayIngestSink = { ingest: (e) => ingested.push(e) };
    const display = createMockDisplay();
    const { handler } = createMessageHandler({ display, displaySink: sink });

    handler(createMockWsDataMessage(FIXTURE_VXSE53_ENCHI));

    expect(ingested[0].domain).toBe("earthquake");
    expect(ingested[0].raw).not.toBeNull();
    expect(ingested[0].raw).toBeDefined();
  });

  it("ingest が throw しても handler は例外を投げず表示も走る (router 側の二重ガード)", () => {
    const sink: DisplayIngestSink = {
      ingest: () => {
        throw new Error("display down");
      },
    };
    const display = createMockDisplay();
    const { handler } = createMessageHandler({ display, displaySink: sink });

    expect(() => handler(createMockWsDataMessage(FIXTURE_VXSE53_ENCHI))).not.toThrow();
    expect(display.displayOutcome).toHaveBeenCalledTimes(1);
  });

  it("displaySink 未指定 (undefined) でも従来どおり動く", () => {
    const display = createMockDisplay();
    const { handler } = createMessageHandler({ display });

    expect(() => handler(createMockWsDataMessage(FIXTURE_VXSE53_ENCHI))).not.toThrow();
    expect(display.displayOutcome).toHaveBeenCalledTimes(1);
  });

  it("未対応電文の raw fallback ごとに type と受信時刻を 1 record 記録する", () => {
    const receivedAtMs = Date.parse("2026-08-20T12:34:56.789Z");
    vi.useFakeTimers();
    vi.setSystemTime(receivedAtMs);
    const base = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    if (base.meta == null) throw new Error("fixture metadata is missing");
    const unknown = {
      ...base,
      id: "unknown-telegram-1",
      classification: "telegram.unknown",
      head: { ...base.head, type: "VZZZ99", time: new Date(receivedAtMs).toISOString() },
      meta: { ...base.meta, messageId: "unknown-telegram-1", receivedAtMs },
    };
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const display = createMockDisplay();
    const { handler } = createMessageHandler({ display });

    handler(unknown);

    const records = infoSpy.mock.calls
      .map(([message]) => message)
      .filter((message): message is string =>
        typeof message === "string" && message.startsWith("[unknown-telegram]"));
    expect(records).toEqual([
      `[unknown-telegram] type=VZZZ99 receivedAt=${new Date(receivedAtMs).toISOString()}`,
    ]);
  });

  it("非 XML の未対応電文も raw fallback の受信記録を一回だけ残す", () => {
    const receivedAtMs = Date.parse("2026-08-20T12:34:56.789Z");
    vi.useFakeTimers();
    vi.setSystemTime(receivedAtMs);
    const base = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const unknown = normalizeTelegramMessage({
      ...base,
      id: "unknown-non-xml",
      classification: "telegram.unknown",
      format: "json" as const,
      head: { ...base.head, type: "VZZZ98", xml: false },
    }).message;
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const { handler } = createMessageHandler({ display: createMockDisplay() });

    handler(unknown);

    expect(infoSpy.mock.calls.filter(([message]) =>
      message === `[unknown-telegram] type=VZZZ98 receivedAt=${new Date(unknown.meta!.receivedAtMs).toISOString()}`,
    )).toHaveLength(1);
  });

  it("未対応 XML の日付診断 return も raw fallback の受信記録を一回だけ残す", () => {
    const receivedAtMs = Date.parse("2026-08-20T12:34:56.789Z");
    vi.useFakeTimers();
    vi.setSystemTime(receivedAtMs);
    const base = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    if (base.xmlReport == null) throw new Error("fixture envelope is missing");
    const unknown = normalizeTelegramMessage({
      ...base,
      id: "unknown-invalid-date",
      classification: "telegram.unknown",
      head: { ...base.head, type: "VZZZ97" },
      xmlReport: {
        ...base.xmlReport,
        head: {
          ...base.xmlReport.head,
          reportDateTime: "invalid",
        },
      },
    }).message;
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const { handler } = createMessageHandler({ display: createMockDisplay() });

    handler(unknown);

    expect(infoSpy.mock.calls.filter(([message]) =>
      message === `[unknown-telegram] type=VZZZ97 receivedAt=${new Date(unknown.meta!.receivedAtMs).toISOString()}`,
    )).toHaveLength(1);
  });

  it("legacy timeout callbackも同期経路と同じdisplay ingestを一回だけ通る", () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-08-11T00:00:00.000Z");
    vi.setSystemTime(nowMs);
    const base = createMockWsDataMessageFromXml(readFixture(FIXTURE_VXSE51_SHINDO), "VPOA50");
    if (base.xmlReport == null) throw new Error("fixture envelope is missing");
    const message = normalizeTelegramMessage({
      ...base,
      id: "legacy-display-timeout",
      classification: "unexpected",
      head: { ...base.head, type: "VPOA50", time: new Date(nowMs).toISOString() },
      xmlReport: {
        ...base.xmlReport,
        head: {
          ...base.xmlReport.head,
          title: "旧形式情報",
          reportDateTime: new Date(nowMs).toISOString(),
          eventId: "DISPLAY-TIMEOUT",
          serial: "1",
          infoType: "発表",
        },
      },
      meta: undefined,
    }).message;
    const ingested: PresentationEvent[] = [];
    const sink: DisplayIngestSink = { ingest: (event) => ingested.push(event) };
    const display = createMockDisplay();
    const { handler } = createMessageHandler({ display, displaySink: sink });

    handler(message);
    expect(ingested).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(ingested).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ingested).toHaveLength(1);
    expect(ingested[0].domain).toBe("legacyCounterpart");
  });

  it("optional reconcile capability があれば late counterpart を atomic に委譲する", () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-08-11T00:00:00.000Z");
    vi.setSystemTime(nowMs);
    const ingested: PresentationEvent[] = [];
    const reconciled = vi.fn((_event: PresentationEvent, _sourceEventKeys: readonly string[]) => ({ kind: "applied" as const }));
    const { handler } = createMessageHandler({
      display: createMockDisplay(),
      displaySink: {
        ingest: (event) => ({
          kind: "applied" as const,
          eventKeys: (ingested.push(event), [event.id]),
        }),
        reconcileLateCounterpart: reconciled,
      },
      legacyCounterpartCorrelatorFactory: displayLegacyCorrelatorFactory(),
    });

    handler(displayLegacyMessage("VPOA50", "display-cap-source", "DISPLAY-CAP"));
    vi.advanceTimersByTime(60_001);
    handler(displayLegacyMessage("SYNTH-CP", "display-cap-counterpart", "DISPLAY-CAP"));

    expect(reconciled).toHaveBeenCalledOnce();
    expect(reconciled.mock.calls[0]?.[1]).toEqual(["legacy:VPOA50:DISPLAY-CAP"]);
    expect(ingested).toHaveLength(1);
  });

  it("optional capability 不在時は late counterpart を通常 ingest へ一回だけ fail-open する", () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-08-11T00:00:00.000Z");
    vi.setSystemTime(nowMs);
    const ingested: PresentationEvent[] = [];
    const { handler } = createMessageHandler({
      display: createMockDisplay(),
      displaySink: {
        ingest: (event) => ({
          kind: "applied" as const,
          eventKeys: (ingested.push(event), [event.id]),
        }),
      },
      legacyCounterpartCorrelatorFactory: displayLegacyCorrelatorFactory(),
    });

    handler(displayLegacyMessage("VPOA50", "display-fallback-source", "DISPLAY-FALLBACK"));
    vi.advanceTimersByTime(60_001);
    handler(displayLegacyMessage("SYNTH-CP", "display-fallback-counterpart", "DISPLAY-FALLBACK"));

    expect(ingested.map((event) => event.id)).toEqual([
      "legacy:VPOA50:DISPLAY-FALLBACK",
      "display-fallback-counterpart",
    ]);
  });
});
