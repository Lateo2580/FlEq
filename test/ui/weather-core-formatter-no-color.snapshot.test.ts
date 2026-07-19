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
});
