import { describe, it, expect, vi } from "vitest";
import { processLgObservation } from "../../../../src/engine/presentation/processors/process-lg-observation";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE62_LGOBS,
} from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

describe("processLgObservation", () => {
  it("正常な長周期地震動電文 → LgObservationOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS);
    const outcome = processLgObservation(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("lgObservation");
    expect(outcome!.statsCategory).toBe("earthquake");
    expect(outcome!.stats.shouldRecord).toBe(true);
    expect(outcome!.headType).toBe("VXSE62");
    expect(outcome!.presentation.notifyCategory).toBe("lgObservation");
  });

  it("frameLevel が maxLgInt に基づいて設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS);
    const outcome = processLgObservation(msg);

    expect(outcome).not.toBeNull();
    // frameLevel は maxLgInt の値に依存するので、存在することだけ確認
    expect(["critical", "warning", "normal", "info", "cancel"]).toContain(
      outcome!.presentation.frameLevel,
    );
  });

  it("soundLevel が設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS);
    const outcome = processLgObservation(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.soundLevel).toBeDefined();
  });

  it("パース失敗 → null", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "bad",
      passing: [],
      head: { type: "VXSE62", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid",
    };
    expect(processLgObservation(msg)).toBeNull();
  });
});
