import { describe, it, expect, afterEach } from "vitest";
import { displayEarlyWeatherInfo } from "../../src/ui/early-weather-formatter";
import { parseEarlyWeather } from "../../src/dmdata/early-weather-parser";
import { clearFrameWidth, setFrameWidth, visualWidth } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VPAW51_HIGH_TEMP,
} from "../helpers/mock-message";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function capture(fn: () => void): string {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => logs.push(String(m ?? ""));
  try { fn(); } finally { console.log = orig; }
  return logs.join("\n");
}

afterEach(() => { clearFrameWidth(); });

describe("displayEarlyWeatherInfo - Phase D colored frame", () => {
  it.each([60, 80, 120])("幅 %i で全描画行の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseEarlyWeather(createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP))!;
    const out = capture(() => displayEarlyWeatherInfo(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("取消: 取消文言が出る", () => {
    const info = parseEarlyWeather(createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP))!;
    info.infoType = "取消";
    const out = capture(() => displayEarlyWeatherInfo(info));
    expect(stripAnsi(out)).toContain("取り消されました");
  });
});
