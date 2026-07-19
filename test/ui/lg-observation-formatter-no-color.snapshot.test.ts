import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayLgObservationInfo } from "../../src/ui/lg-observation-formatter";
import { parseLgObservationTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth } from "../../src/ui/formatter";
import type { ParsedLgObservationInfo, LgObservationArea } from "../../src/types";
import { createMockWsDataMessage, FIXTURE_VXSE62_LGOBS } from "../helpers/mock-message";

interface SnapCase {
  label: string;
  render: () => void;
}

function parseBase(): ParsedLgObservationInfo {
  const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
    head: { type: "VXSE62", author: "気象庁", time: new Date().toISOString(), test: false },
  });
  return parseLgObservationTelegram(msg)!;
}

/** 多地域・多階級 synthetic (階級 1-4 × 5 震度、決定的) */
function lgSynthetic(): ParsedLgObservationInfo {
  const areas: LgObservationArea[] = Array.from({ length: 24 }, (_, i) => ({
    name: `合成観測地域${String(i).padStart(2, "0")}`,
    maxInt: ["1", "2", "3", "4", "5弱"][i % 5],
    maxLgInt: `${(i % 4) + 1}`,
  }));
  return { ...parseBase(), maxLgInt: "4", areas };
}

const CASES: SnapCase[] = [
  { label: "VXSE62-real", render: () => displayLgObservationInfo(parseBase()) },
  { label: "VXSE62-synthetic-multi", render: () => displayLgObservationInfo(lgSynthetic()) },
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
