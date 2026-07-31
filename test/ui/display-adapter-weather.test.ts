import { describe, it, expect, vi, afterEach } from "vitest";
import * as core from "../../src/ui/weather-core-formatter";
import * as legacy from "../../src/ui/weather-formatter";
import { processWeather } from "../../src/engine/presentation/processors/process-weather";
import { Vpws50StateHolder } from "../../src/engine/messages/vpws50-state";
import { TelegramRevisionGate } from "../../src/engine/messages/telegram-revision-gate";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { createDisplayAdapter } from "../../src/ui/display-adapter";

describe("display-adapter weather 分岐 (Phase A T29)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("VPWW55 → displayWeatherWarningCore (新) が呼ばれる", () => {
    const coreSpy = vi.spyOn(core, "displayWeatherWarningCore").mockImplementation(() => {});
    const legacySpy = vi.spyOn(legacy, "displayWeatherWarning").mockImplementation(() => {});
    const result = processWeather(createMockWsDataMessage("15_17_01_251222_VPWW55.xml"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    createDisplayAdapter().displayOutcome(result.outcome);
    expect(coreSpy).toHaveBeenCalledTimes(1);
    expect(legacySpy).not.toHaveBeenCalled();
  });

  it("VPWS50 → 旧 displayWeatherWarning のまま", () => {
    const coreSpy = vi.spyOn(core, "displayWeatherWarningCore").mockImplementation(() => {});
    const legacySpy = vi.spyOn(legacy, "displayWeatherWarning").mockImplementation(() => {});
    const result = processWeather(
      createMockWsDataMessage("15_18_01_250630_VPWS50.xml"),
      {
        vpws50State: new Vpws50StateHolder(),
        revisionGate: new TelegramRevisionGate(),
      } as never,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    createDisplayAdapter().displayOutcome(result.outcome);
    expect(legacySpy).toHaveBeenCalledTimes(1);
    expect(coreSpy).not.toHaveBeenCalled();
  });
});
