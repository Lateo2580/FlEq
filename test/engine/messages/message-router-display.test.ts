import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import type { DisplayIngestSink } from "../../../src/engine/display/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
} from "../../helpers/mock-message";

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
});
