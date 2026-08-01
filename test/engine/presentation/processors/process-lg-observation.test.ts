import { describe, it, expect, vi } from "vitest";
import { processLgObservation } from "../../../../src/engine/presentation/processors/process-lg-observation";
import { fromLgObservationOutcome } from "../../../../src/engine/presentation/events/from-lg-observation";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VXSE62_LGOBS,
  readFixture,
} from "../../../helpers/mock-message";
import type { JmaLgIntensity, SpecialValue } from "../../../../src/types";

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

  it("exact 長周期階級3を共通 helper で critical 音へ投影する", () => {
    const outcome = processLgObservation(createMockWsDataMessage(FIXTURE_VXSE62_LGOBS));
    expect(outcome).not.toBeNull();
    expect(outcome!.parsed.maxLgIntValue).toMatchObject({ presence: "value", value: "3" });
    expect(outcome!.presentation.soundLevel).toBe("critical");
  });

  it("取消報は frameLevel・soundLevel ともに cancel へ投影する", () => {
    const xml = readFixture(FIXTURE_VXSE62_LGOBS).replace(
      /<InfoType>[^<]*<\/InfoType>/,
      "<InfoType>取消</InfoType>",
    );
    const outcome = processLgObservation(createMockWsDataMessageFromXml(xml, "VXSE62"));

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("cancel");
    expect(outcome!.presentation.soundLevel).toBe("cancel");
  });

  it("Intensity/LgInt の SpecialValue を presentation event と areaItems へ保持する", () => {
    const outcome = processLgObservation(createMockWsDataMessage(FIXTURE_VXSE62_LGOBS));
    expect(outcome).not.toBeNull();
    const event = fromLgObservationOutcome(outcome!);
    expect(event.maxIntValue).toEqual(outcome!.parsed.maxIntValue);
    expect(event.maxLgIntValue).toEqual(outcome!.parsed.maxLgIntValue);
    expect(event.areaItems[0]?.maxIntValue).toEqual(outcome!.parsed.areas[0]?.maxIntValue);
    expect(event.areaItems[0]?.maxLgIntValue).toEqual(outcome!.parsed.areas[0]?.maxLgIntValue);
  });

  it("非 exact 長周期階級の表示 label を presentation event へ貫通させる", () => {
    const outcome = processLgObservation(createMockWsDataMessage(FIXTURE_VXSE62_LGOBS));
    expect(outcome).not.toBeNull();
    const maxLgIntValue: SpecialValue<JmaLgIntensity> = {
      raw: "未入電",
      value: null,
      condition: "未入電",
      description: null,
      presence: "unknown",
    };
    const event = fromLgObservationOutcome({
      ...outcome!,
      parsed: { ...outcome!.parsed, maxLgInt: "", maxLgIntValue },
    });
    expect(event.maxLgInt).toBeNull();
    expect(event.maxLgIntLabel).toBe("不明");
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
