import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifyMock } from "../../setup";
import { createMockWsDataMessage } from "../../helpers/mock-message";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { Notifier } from "../../../src/engine/notification/notifier";

// node-notifier / sound-player はグローバル setup でモック済み (test/setup.ts)
vi.mock("../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

interface NotifierInternals {
  settings: { floodForecast: boolean };
  send: (...args: unknown[]) => void;
}

function asInternals(n: Notifier): NotifierInternals {
  return n as unknown as NotifierInternals;
}

describe("notifyFloodForecast", () => {
  let notifier: Notifier;

  beforeEach(() => {
    notifier = new Notifier();
    asInternals(notifier).settings.floodForecast = true;
  });

  it("does not throw for Headline-only fixture (16_05_01)", () => {
    const msg = createMockWsDataMessage("16_05_01_210630_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBe(0);
    expect(() => notifier.notifyFloodForecast(info)).not.toThrow();
  });

  it("Headline-only: body に headlines[0].areas[0].name が含まれる + category=floodForecast", () => {
    const msg = createMockWsDataMessage("16_05_01_210630_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBe(0);

    const spy = vi
      .spyOn(asInternals(notifier), "send")
      .mockImplementation(() => {});
    notifier.notifyFloodForecast(info);

    expect(spy).toHaveBeenCalledTimes(1);
    // positional 4 引数 (title, body, category, soundLevel)
    const call = spy.mock.calls[0];
    const title = String(call[0]);
    const body = String(call[1]);
    const category = call[2];
    expect(category).toBe("floodForecast");

    // Headline-only fixture では headlines[0].areas[0].name が body 内 station 相当として現れる
    const expectedLabel = info.headlines[0]?.areas[0]?.name;
    expect(expectedLabel).toBeTruthy();
    expect(body).toContain(expectedLabel!);
    expect(title).toContain("洪水予報");
  });

  it("rawStations あり: body に stationName が含まれる (16_02_01)", () => {
    const msg = createMockWsDataMessage("16_02_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBeGreaterThan(0);

    const spy = vi
      .spyOn(asInternals(notifier), "send")
      .mockImplementation(() => {});
    notifier.notifyFloodForecast(info, "warning");

    expect(spy).toHaveBeenCalledTimes(1);
    const [, body, category, soundLevel] = spy.mock.calls[0];
    expect(category).toBe("floodForecast");
    expect(soundLevel).toBe("warning");
    expect(String(body)).toContain(info.rawStations[0].stationName);
  });

  it("settings.floodForecast=false なら通知しない (send 内の一元ゲートで抑止、critical 以外は貫通しない)", () => {
    asInternals(notifier).settings.floodForecast = false;
    const msg = createMockWsDataMessage("16_02_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;

    notifier.notifyFloodForecast(info);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("取消パス: soundLevel='cancel' / title に '取消' が含まれる", () => {
    const msg = createMockWsDataMessage("synthetic_VXKO50_cancel.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.infoType).toBe("取消");

    const spy = vi
      .spyOn(asInternals(notifier), "send")
      .mockImplementation(() => {});
    notifier.notifyFloodForecast(info, "warning");

    expect(spy).toHaveBeenCalledTimes(1);
    const [title, , category, soundLevel] = spy.mock.calls[0];
    expect(category).toBe("floodForecast");
    // 取消は override より優先で cancel
    expect(soundLevel).toBe("cancel");
    expect(String(title)).toContain("取消");
  });

  it("soundLevelOverride 未指定時のデフォルトは 'warning'", () => {
    const msg = createMockWsDataMessage("16_02_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    const spy = vi
      .spyOn(asInternals(notifier), "send")
      .mockImplementation(() => {});
    notifier.notifyFloodForecast(info);
    const [, , , soundLevel] = spy.mock.calls[0];
    expect(soundLevel).toBe("warning");
  });
});
