import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyMock } from "../setup";

vi.mock("../../src/config", () => ({
  loadConfig: () => ({}),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

vi.mock("../../src/logger", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

import { Notifier, clearIconPathCache } from "../../src/engine/notification/notifier";
import { parseTyphoonProbability } from "../../src/dmdata/typhoon-probability-parser";
import { playSound } from "../../src/engine/notification/sound-player";
import {
  createMockWsDataMessage,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTA50_JANGMI_GONE,
} from "../helpers/mock-message";

describe("Notifier.notifyTyphoonProbability", () => {
  const playSoundMock = vi.mocked(playSound);

  beforeEach(() => {
    playSoundMock.mockClear();
    clearIconPathCache();
  });

  it("DAMREY 発表は本文に '最大 100%' / 台風名 / 'MM/DD HH時頃' を含む", () => {
    const notifier = new Notifier();
    notifier.toggleCategory("typhoonProbability"); // 既定 false → true (2026-07-19 気象系既定ミュート)
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;

    notifier.notifyTyphoonProbability(info, "normal");

    expect(notifyMock).toHaveBeenCalledOnce();
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toContain("最大 100%");
    expect(callArg.message).toContain("DAMREY");
    expect(callArg.message).toMatch(/\d{2}\/\d{2} \d{2}時頃/);
    expect(playSoundMock).toHaveBeenCalledWith("normal");
  });

  it("JANGMI 消滅(全0%)は本文 '暴風域に入る確率1%以上の地域なし'", () => {
    const notifier = new Notifier();
    notifier.toggleCategory("typhoonProbability"); // 既定 false → true
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE))!;

    notifier.notifyTyphoonProbability(info, "info");

    expect(notifyMock).toHaveBeenCalledOnce();
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toContain("暴風域に入る確率1%以上の地域なし");
    expect(callArg.message).toContain("JANGMI");
    expect(playSoundMock).toHaveBeenCalledWith("info");
  });

  it("settings.typhoonProbability=false は通知しない", () => {
    const notifier = new Notifier();
    // 既定 false のまま (2026-07-19 気象系既定ミュート)。critical 以外は貫通しない
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;

    notifier.notifyTyphoonProbability(info, "normal");

    expect(notifyMock).not.toHaveBeenCalled();
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it("取消は cancel 経路で固定本文", () => {
    const notifier = new Notifier();
    notifier.toggleCategory("typhoonProbability"); // 既定 false → true (取消は貫通しないため ON が前提)
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    const cancelInfo = { ...info, infoType: "取消" };

    notifier.notifyTyphoonProbability(cancelInfo, "cancel");

    expect(notifyMock).toHaveBeenCalledOnce();
    const callArg = notifyMock.mock.calls[0][0] as { title: string; message: string };
    expect(callArg.message).toBe("この台風情報は取り消されました");
    expect(playSoundMock).toHaveBeenCalledWith("cancel");
  });
});
