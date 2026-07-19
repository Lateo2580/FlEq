import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayTsunamiInfo } from "../../src/ui/tsunami-formatter";
import { parseTsunamiTelegram } from "../../src/dmdata/telegram-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { setFrameWidth } from "../../src/ui/formatter";

// 警報 (VTSE41) / 観測 (VTSE51) / 沖合 (VTSE52) / 取消 の代表 4 ケース
const FIXTURES = [
  "32-39_11_02_250206_VTSE41.xml",
  "32-39_11_03_250206_VTSE51.xml",
  "61_11_01_250206_VTSE52.xml",
  "38-39_03_01_210805_VTSE41.xml",
];
// 3 段 breakpoint の代表幅: ultra-narrow / standard / wide
const MODES: Record<string, number> = { "ultra-narrow": 60, standard: 140, wide: 180 };

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
    setFrameWidth(60);
    vi.restoreAllMocks();
  });

  for (const fx of FIXTURES) {
    const info = parseTsunamiTelegram(createMockWsDataMessage(fx))!;
    for (const [modeName, w] of Object.entries(MODES)) {
      it(`${fx} @ ${modeName}=${w}`, () => {
        setFrameWidth(w);
        displayTsunamiInfo(info);
        const out = logs.join("\n").replace(/[ \t]+$/gm, "");
        expect(out).toMatchSnapshot();
      });
    }
  }
});
