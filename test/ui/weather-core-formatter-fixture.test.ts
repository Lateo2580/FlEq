import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { displayWeatherWarningCore } from "../../src/ui/weather-core-formatter";
import { parseWeatherWarning } from "../../src/dmdata/weather-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { stripAnsi, setFrameWidth } from "../../src/ui/formatter";

const FIXTURES = [
  "15_17_01_251222_VPWW55.xml",
  "15_16_01_241031_VPWW56.xml",
  "15_16_02_251222_VPWW57.xml",
  "15_16_04_251222_VPWW58.xml",
  "15_16_05_241226_VPWW59.xml",
  "15_16_06_241226_VPWW60.xml",
  "15_16_07_250825_VPWW61.xml",
];

describe("VPWW55-61 全 fixture × displayWeatherWarningCore", () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    setFrameWidth(120);
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => vi.restoreAllMocks());

  for (const name of FIXTURES) {
    it(`${name}: 例外なく出力できる`, () => {
      const info = parseWeatherWarning(createMockWsDataMessage(name));
      expect(info).not.toBeNull();
      displayWeatherWarningCore(info!);
      const out = logs.map(stripAnsi).join("\n");
      const telegram = name.match(/VPWW\d+/)![0];
      expect(out).toContain(telegram);
      expect(out.length).toBeGreaterThan(50);
    });
  }
});
