import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayNankaiTroughInfo } from "../../src/ui/nankai-trough-formatter";
import { parseNankaiTroughTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VYSE50_ALERT,
  FIXTURE_VYSE52_REGULAR,
  FIXTURE_VYSE60_AFTERSHOCK,
} from "../helpers/mock-message";

interface SnapCase {
  label: string;
  render: () => void;
}

function renderFixture(fixture: string, type: string): void {
  const msg = createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
  displayNankaiTroughInfo(parseNankaiTroughTelegram(msg)!);
}

const CASES: SnapCase[] = [
  // critical: code 120 巨大地震警戒 (Task 0 (b) で所在確定: 74_01_04_200512_VYSE50.xml)
  { label: "VYSE50-critical-120", render: () => renderFixture(FIXTURE_VYSE50_ALERT, "VYSE50") },
  // warning: VYSE60 後発地震注意 (infoSerial なし — VYSE60 は warning であって info ではない, spec Codex R1)
  { label: "VYSE60-warning-aftershock", render: () => renderFixture(FIXTURE_VYSE60_AFTERSHOCK, "VYSE60") },
  // info: code 200 定例解説 (バナーなし)
  { label: "VYSE52-info-200", render: () => renderFixture(FIXTURE_VYSE52_REGULAR, "VYSE52") },
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
