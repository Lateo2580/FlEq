import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayEewInfo } from "../../src/ui/eew-formatter";
import type { EewDiff } from "../../src/engine/eew/eew-tracker";
import { parseEewTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth, setMaxObservations } from "../../src/ui/formatter";
import type { ParsedEewInfo } from "../../src/types";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE43_WARNING_S2,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE45_PLUM,
  FIXTURE_VXSE45_MIXED,
  FIXTURE_VXSE45_FINAL,
} from "../helpers/mock-message";

function parsed(fixture: string, type: string): ParsedEewInfo {
  const msg = createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
  return parseEewTelegram(msg)!;
}

const DIFF: EewDiff = { previousMaxInt: "4", previousMagnitude: "6.4", previousDepth: "30km", hypocenterChange: true };

// 代表 7 ケース (spec 4.7-7): 警報 / 予報 / PLUM / 混在 / 最終報 / 取消 / diff 付き第 2 報
const CASES: { label: string; render: () => void }[] = [
  { label: "警報-VXSE43", render: () => displayEewInfo(parsed(FIXTURE_VXSE43_WARNING_S1, "VXSE43"), { activeCount: 1, colorIndex: 0 }) },
  { label: "予報-VXSE45", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_S1, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "PLUM-VXSE45", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_PLUM, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "混在-VXSE45", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_MIXED, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "最終報-VXSE45", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_FINAL, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "取消-VXSE45", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_CANCEL, "VXSE45"), { activeCount: 0, colorIndex: 0 }) },
  { label: "diff付き第2報-VXSE43", render: () => displayEewInfo(parsed(FIXTURE_VXSE43_WARNING_S2, "VXSE43"), { activeCount: 1, colorIndex: 0, diff: DIFF }) },
];

const MODES: Record<string, number> = { "ultra-narrow": 60, standard: 140, wide: 180 };

describe("EEW NO_COLOR golden snapshot (chalk.level=0)", () => {
  let logs: string[] = [];
  const originalLevel = chalk.level;
  beforeEach(() => {
    logs = [];
    chalk.level = 0;
    setMaxObservations(null);
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => {
    chalk.level = originalLevel;
    setFrameWidth(60);
    setMaxObservations(null);
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
