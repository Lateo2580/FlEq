import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayWeatherWarningCore } from "../../src/ui/weather-core-formatter";
import { parseWeatherWarning } from "../../src/dmdata/weather-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { setFrameWidth } from "../../src/ui/formatter";

const FIXTURES = [
  "15_17_01_251222_VPWW55.xml",
  "15_16_01_241031_VPWW56.xml",
  "15_16_07_250825_VPWW61.xml",
];
const MODES: Record<string, number> = { "ultra-narrow": 60, standard: 80, wide: 140 };

describe("NO_COLOR golden snapshot (chalk.level=0)", () => {
  let logs: string[] = [];
  const originalLevel = chalk.level;
  beforeEach(() => {
    logs = [];
    chalk.level = 0;
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => {
    chalk.level = originalLevel;
    vi.restoreAllMocks();
  });

  for (const fx of FIXTURES) {
    // fixture は 1 回だけ parse して全モードで再利用 (parse は重いため)
    const info = parseWeatherWarning(createMockWsDataMessage(fx))!;
    for (const [modeName, w] of Object.entries(MODES)) {
      it(`${fx} @ ${modeName}=${w}`, () => {
        setFrameWidth(w);
        displayWeatherWarningCore(info);
        const out = logs.join("\n").replace(/[ \t]+$/gm, "");
        expect(out).toMatchSnapshot();
      });
    }
  }

  it("VPWW61 幅60のrecapは2行目 title の発表・情報も再掲する", () => {
    const originalIsTTY = process.stdout.isTTY;
    const originalRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 5, writable: true, configurable: true });
    try {
      const info = parseWeatherWarning(createMockWsDataMessage("15_16_07_250825_VPWW61.xml"))!;
      setFrameWidth(60);
      displayWeatherWarningCore(info);
      const summaryIndex = logs.findIndex((line) => line.includes("▼ サマリー"));
      expect(summaryIndex).toBeGreaterThan(-1);
      expect(logs.slice(summaryIndex + 1).join("\n")).toContain("発表  [情報]");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, writable: true, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: originalRows, writable: true, configurable: true });
    }
  });
});
