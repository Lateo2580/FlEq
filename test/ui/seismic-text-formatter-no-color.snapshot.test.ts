import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displaySeismicTextInfo } from "../../src/ui/seismic-text-formatter";
import { parseSeismicTextTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VZSE40_NOTICE,
} from "../helpers/mock-message";

interface SnapCase {
  label: string;
  render: () => void;
}

function renderFixture(fixture: string, type: string): void {
  const msg = createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
  displaySeismicTextInfo(parseSeismicTextTelegram(msg)!);
}

const CASES: SnapCase[] = [
  { label: "VXSE56-activity", render: () => renderFixture(FIXTURE_VXSE56_ACTIVITY_1, "VXSE56") },
  { label: "VZSE40-notice", render: () => renderFixture(FIXTURE_VZSE40_NOTICE, "VZSE40") },
];

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

  for (const c of CASES) {
    for (const [modeName, w] of Object.entries(MODES)) {
      it(`${c.label} @ ${modeName}=${w}`, () => {
        setFrameWidth(w);
        c.render();
        const out = logs.join("\n").replace(/[ \t]+$/gm, "");
        expect(out).toMatchSnapshot();
      });
    }
  }
});
