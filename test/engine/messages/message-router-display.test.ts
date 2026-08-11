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
});
