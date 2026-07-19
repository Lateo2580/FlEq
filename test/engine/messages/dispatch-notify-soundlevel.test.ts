import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node-notifier / sound-player はグローバル setup でモック済み (test/setup.ts)。
// このテストは router (dispatchNotify) が tornado/briefing 通知に
// outcome.presentation.soundLevel を第 2 引数で渡すか (渡し忘れ検出) を検証する。

vi.mock("../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { Notifier } from "../../../src/engine/notification/notifier";
import {
  createMockWsDataMessage,
  FIXTURE_VPHW51_SIGHTING,
  FIXTURE_VPBS50_LINEAR_OBSERVED,
  FIXTURE_VPFT50_SAITAMA,
} from "../../helpers/mock-message";

describe("dispatchNotify: tornado/briefing/heatAlert に presentation.soundLevel を渡す (drift 解消)", () => {
  let tornadoSpy: ReturnType<typeof vi.spyOn>;
  let briefingSpy: ReturnType<typeof vi.spyOn>;
  let heatAlertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // notifier 副作用 (実際の send) を抑止しつつ呼び出し引数を捕捉。
    // createMessageHandler が内部で new Notifier() するため prototype を spy する。
    tornadoSpy = vi
      .spyOn(Notifier.prototype, "notifyTornadoAdvisory")
      .mockImplementation(() => {});
    briefingSpy = vi
      .spyOn(Notifier.prototype, "notifyWeatherBriefing")
      .mockImplementation(() => {});
    heatAlertSpy = vi
      .spyOn(Notifier.prototype, "notifyHeatAlert")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    tornadoSpy.mockRestore();
    briefingSpy.mockRestore();
    heatAlertSpy.mockRestore();
  });

  it("VPHW51 (目撃情報付き): notifyTornadoAdvisory が (parsed, 'warning') で呼ばれる", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING));

    expect(tornadoSpy).toHaveBeenCalledTimes(1);
    const [parsed, soundLevel] = tornadoSpy.mock.calls[0];
    // 第 2 引数 = outcome.presentation.soundLevel (Phase D で目撃でも warning)。
    // 渡し忘れ (undefined) ならここで落ちる。
    expect(soundLevel).toBe("warning");
    expect(parsed).toMatchObject({ type: "VPHW51" });
  });

  it("VPBS50 (線状降水帯発生): notifyWeatherBriefing が (parsed, 'warning') で呼ばれる", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED));

    expect(briefingSpy).toHaveBeenCalledTimes(1);
    const [parsed, soundLevel] = briefingSpy.mock.calls[0];
    // 第 2 引数 = outcome.presentation.soundLevel (線状降水帯発生は表示 critical / 音 warning)。
    expect(soundLevel).toBe("warning");
    expect(parsed).toMatchObject({ type: "VPBS50" });
  });

  it("VPFT50 (熱中症警戒アラート): notifyHeatAlert が (parsed, 'warning') で呼ばれる", () => {
    const { handler } = createMessageHandler();
    handler(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA));

    expect(heatAlertSpy).toHaveBeenCalledTimes(1);
    const [parsed, soundLevel] = heatAlertSpy.mock.calls[0];
    // 第 2 引数 = outcome.presentation.soundLevel (weather F-3 の横展開)。
    // 渡し忘れ (undefined) ならここで落ちる。
    expect(soundLevel).toBe("warning");
    expect(parsed).toMatchObject({ type: "VPFT50" });
  });
});
