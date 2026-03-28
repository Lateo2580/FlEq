import { describe, it, expect, vi } from "vitest";
import { processEarthquake } from "../../../../src/engine/presentation/processors/process-earthquake";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE51_CANCEL,
} from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

describe("processEarthquake", () => {
  it("正常な地震電文 → EarthquakeOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processEarthquake(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("earthquake");
    expect(outcome!.statsCategory).toBe("earthquake");
    expect(outcome!.stats.shouldRecord).toBe(true);
    expect(outcome!.headType).toBe("VXSE53");
    expect(outcome!.presentation.notifyCategory).toBe("earthquake");
  });

  it("VXSE53 の maxIntUpdate が設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processEarthquake(msg);

    if (outcome && outcome.parsed.intensity?.maxInt) {
      expect(outcome.stats.maxIntUpdate).toBeDefined();
      expect(outcome.stats.maxIntUpdate!.headType).toBe("VXSE53");
    }
  });

  it("取消報 → frameLevel cancel", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE51_CANCEL);
    const outcome = processEarthquake(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("cancel");
  });

  it("eventId が state に設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
      xmlReport: {
        control: {
          title: "テスト",
          dateTime: new Date().toISOString(),
          status: "通常",
          editorialOffice: "気象庁本庁",
          publishingOffice: "気象庁",
        },
        head: {
          title: "テスト",
          reportDateTime: new Date().toISOString(),
          targetDateTime: new Date().toISOString(),
          eventId: "20240101000000",
          serial: "1",
          infoType: "発表",
          infoKind: "テスト",
          infoKindVersion: "1.0_0",
          headline: null,
        },
      },
    });
    const outcome = processEarthquake(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.state).toBeDefined();
    expect(outcome!.state!.eventId).toBe("20240101000000");
    expect(outcome!.stats.eventId).toBe("20240101000000");
  });

  it("パース失敗 → null", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "bad",
      passing: [],
      head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid",
    };
    expect(processEarthquake(msg)).toBeNull();
  });
});
