import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { displayWeatherWarningCore } from "../../src/ui/weather-core-formatter";
import { parseWeatherWarning } from "../../src/dmdata/weather-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { stripAnsi, visualWidth, setFrameWidth } from "../../src/ui/formatter";

const WIDTHS = [55, 60, 64, 65, 80, 100, 104, 105, 119, 159, 200];
const FIXTURES = [
  "15_17_01_251222_VPWW55.xml",
  "15_16_01_241031_VPWW56.xml",
  "15_16_07_250825_VPWW61.xml",
];

describe("VPWW55-61 幅マトリクス境界 (全行 visualWidth <= width)", () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => vi.restoreAllMocks());

  for (const fx of FIXTURES) {
    // fixture は describe ごとに 1 回だけ parse して全幅で再利用 (parse は重いため)
    const info = parseWeatherWarning(createMockWsDataMessage(fx))!;
    for (const w of WIDTHS) {
      it(`${fx} @ width=${w}`, () => {
        setFrameWidth(w);
        displayWeatherWarningCore(info);
        for (const line of logs) {
          const vw = visualWidth(stripAnsi(line));
          expect(vw, `over@${w}: "${stripAnsi(line)}" (vw=${vw})`).toBeLessThanOrEqual(w);
        }
      });
    }
  }
});
