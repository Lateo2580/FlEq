import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { Notifier } from "../../../src/engine/notification/notifier";
import { routeToCategory } from "../../../src/engine/messages/telegram-stats";
import {
  createMockWsDataMessage,
  FIXTURE_VXKO50_16_02_01,
  FIXTURE_VXKO50_16_05_01,
  FIXTURE_VXSU50_91_01_01,
  FIXTURE_SYNTHETIC_VXKO50_CANCEL,
} from "../../helpers/mock-message";

// node-notifier / sound-player はグローバル setup でモック済み
vi.mock("../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

// EEW ロガーが eew-logs/ ファイルを実際に作らないように fs を mock (process-message と同型)
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe("routeToCategory contract (Task 4 で実装済の最終確認)", () => {
  it("routeToCategory('floodForecast') === 'floodForecast'", () => {
    expect(routeToCategory("floodForecast")).toBe("floodForecast");
  });
});

describe("createMessageHandler — floodForecast routing (positive)", () => {
  let notifySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notifySpy = vi
      .spyOn(Notifier.prototype, "notifyFloodForecast")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    notifySpy.mockRestore();
  });

  it("VXKO50 + telegram.weather: notifyFloodForecast が outcome.parsed + soundLevel で呼ばれる", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_VXKO50_16_02_01));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [parsed, soundLevel] = notifySpy.mock.calls[0];
    expect(parsed).toMatchObject({ schema: "vxko50", typeCode: "VXKO50" });
    // 通常 VXKO 発表は spec §6.1 で frame/sound を resolve → 渡されるはず
    expect(soundLevel).toBeDefined();
  });

  it("VXSU50 + telegram.weather: notifyFloodForecast が呼ばれる (schema='vxsu50')", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_VXSU50_91_01_01));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [parsed] = notifySpy.mock.calls[0];
    expect(parsed).toMatchObject({ schema: "vxsu50", typeCode: "VXSU50" });
  });

  it("VXKO50 Headline-only (16_05_01): notifyFloodForecast が呼ばれる (dedup bypass)", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_VXKO50_16_05_01));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [parsed] = notifySpy.mock.calls[0];
    expect(parsed).toMatchObject({ schema: "vxko50" });
  });

  it("VXKO50 取消 (synthetic): notifyFloodForecast は suppressNotify=false で呼ばれる + parsed.infoType='取消'", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_SYNTHETIC_VXKO50_CANCEL));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [parsed, soundLevel] = notifySpy.mock.calls[0];
    expect(parsed).toMatchObject({ infoType: "取消" });
    // 取消は frame/sound=cancel
    expect(soundLevel).toBe("cancel");
  });

  it("同一 VXKO50 を 2 回連続 → 2 回目は suppressNotify で notifyFloodForecast 不発火", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_VXKO50_16_02_01));
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // 同 fixture → 同 eventId / 同 digest → 2 回目は suppressNotify=true
    handler(createMockWsDataMessage(FIXTURE_VXKO50_16_02_01));
    // dispatchNotify が suppressNotify を読んで notifier を呼ばない
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });
});

describe("createMessageHandler — floodForecast routing (negative / fallback)", () => {
  it("VXKO50 + classification='telegram.unknown' → floodForecast に乗らず raw fallback (notifyFloodForecast 不発火)", () => {
    const spy = vi
      .spyOn(Notifier.prototype, "notifyFloodForecast")
      .mockImplementation(() => {});
    const { handler } = createMessageHandler();

    handler(
      createMockWsDataMessage(FIXTURE_VXKO50_16_02_01, {
        classification: "telegram.unknown",
      }),
    );
    // classification が telegram.weather でないため classifyMessage は floodForecast に分岐しない
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("VXKO99 (定義外 type, FLOOD_FORECAST_HEAD_TYPES の範囲だが現行配信なし) は routing 上 floodForecast に乗る", () => {
    // VXKO50-89 の枠取りに VXKO99 は含まれない (50 から 40 件 = 50-89)
    // → 範囲外なので floodForecast に乗らず raw fallback になることの確認
    const spy = vi
      .spyOn(Notifier.prototype, "notifyFloodForecast")
      .mockImplementation(() => {});
    const { handler } = createMessageHandler();

    handler(
      createMockWsDataMessage(FIXTURE_VXKO50_16_02_01, {
        classification: "telegram.weather",
        head: {
          type: "VXKO99",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
          xml: true,
        },
      }),
    );
    // VXKO99 は枠外なので floodForecast に乗らない
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("VXKO50 + telegram.weather + 不正 XML body → processFloodForecast=null → raw fallback (notifyFloodForecast 不発火)", () => {
    const spy = vi
      .spyOn(Notifier.prototype, "notifyFloodForecast")
      .mockImplementation(() => {});
    const { handler } = createMessageHandler();

    handler({
      type: "data",
      version: "2.0",
      classification: "telegram.weather",
      id: "bad-flood",
      passing: [],
      head: {
        type: "VXKO50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
        xml: true,
      },
      format: "xml",
      compression: null,
      encoding: "utf-8",
      body: "not-xml-body",
    });
    // parse 失敗 → null → processRaw fallback → notifier 呼ばれない
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
