import { describe, it, expect, vi } from "vitest";
import { processSeismicText } from "../../../../src/engine/presentation/processors/process-seismic-text";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VXSE60_CANCEL,
} from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

describe("processSeismicText", () => {
  it("正常なテキスト系電文 → SeismicTextOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1);
    const outcome = processSeismicText(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("seismicText");
    expect(outcome!.statsCategory).toBe("earthquake");
    expect(outcome!.stats.shouldRecord).toBe(true);
    expect(outcome!.headType).toBe("VXSE56");
    expect(outcome!.presentation.notifyCategory).toBe("seismicText");
  });

  it("frameLevel は info (通常)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1);
    const outcome = processSeismicText(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("info");
  });

  it("soundLevel は info", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1);
    const outcome = processSeismicText(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.soundLevel).toBe("info");
  });

  it("取消報 → frameLevel cancel", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE60_CANCEL);
    const outcome = processSeismicText(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("cancel");
  });

  it("パース失敗 → null", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "bad",
      passing: [],
      head: { type: "VXSE56", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid",
    };
    expect(processSeismicText(msg)).toBeNull();
  });
});
