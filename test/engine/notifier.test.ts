import { describe, expect, it, vi } from "vitest";
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

import { Notifier } from "../../src/engine/notification/notifier";
import type { ParsedEarthquakeInfo } from "../../src/types";

describe("Notifier", () => {
  it("uses the mocked notifier during tests", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info: ParsedEarthquakeInfo = {
      type: "VXSE",
      infoType: "発表",
      title: "震源・震度情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "東京都",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "4.0",
      },
      intensity: {
        maxInt: "3",
        areas: [{ name: "東京都", intensity: "3" }],
      },
      isTest: false,
    };

    notifier.notifyEarthquake(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
