import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displaySeismicTextInfo } from "../../src/ui/seismic-text-formatter";
import { displayNankaiTroughInfo } from "../../src/ui/nankai-trough-formatter";
import { displayLgObservationInfo } from "../../src/ui/lg-observation-formatter";
import {
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../../src/dmdata/telegram-parser";
import { setFrameWidth, stripAnsi, visualWidth } from "../../src/ui/formatter";
import type { ParsedLgObservationInfo, LgObservationArea } from "../../src/types";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VXSE60_1,
  FIXTURE_VZSE40_NOTICE,
  FIXTURE_VYSE50_ALERT,
  FIXTURE_VYSE50_CLOSED,
  FIXTURE_VYSE50_CANCEL,
  FIXTURE_VYSE51_ADVISORY,
  FIXTURE_VYSE52_REGULAR,
  FIXTURE_VYSE60_AFTERSHOCK,
  FIXTURE_VXSE62_LGOBS,
} from "../helpers/mock-message";

interface SweepCase {
  label: string;
  render: () => void;
}

function msgOf(fixture: string, type: string) {
  return createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
}

function lgSynthetic(count: number): ParsedLgObservationInfo {
  const base = parseLgObservationTelegram(msgOf(FIXTURE_VXSE62_LGOBS, "VXSE62"))!;
  const areas: LgObservationArea[] = Array.from({ length: count }, (_, i) => ({
    name: `合成観測地域${String(i).padStart(2, "0")}`,
    maxInt: ["1", "2", "3", "4", "5弱"][i % 5],
    maxLgInt: `${(i % 4) + 1}`,
  }));
  return { ...base, maxLgInt: "4", areas };
}

const CASES: SweepCase[] = [
  { label: "VXSE56", render: () => displaySeismicTextInfo(parseSeismicTextTelegram(msgOf(FIXTURE_VXSE56_ACTIVITY_1, "VXSE56"))!) },
  { label: "VXSE60", render: () => displaySeismicTextInfo(parseSeismicTextTelegram(msgOf(FIXTURE_VXSE60_1, "VXSE60"))!) },
  { label: "VZSE40", render: () => displaySeismicTextInfo(parseSeismicTextTelegram(msgOf(FIXTURE_VZSE40_NOTICE, "VZSE40"))!) },
  { label: "VYSE50-alert-120", render: () => displayNankaiTroughInfo(parseNankaiTroughTelegram(msgOf(FIXTURE_VYSE50_ALERT, "VYSE50"))!) },
  { label: "VYSE50-closed-190", render: () => displayNankaiTroughInfo(parseNankaiTroughTelegram(msgOf(FIXTURE_VYSE50_CLOSED, "VYSE50"))!) },
  { label: "VYSE50-cancel", render: () => displayNankaiTroughInfo(parseNankaiTroughTelegram(msgOf(FIXTURE_VYSE50_CANCEL, "VYSE50"))!) },
  { label: "VYSE51-210", render: () => displayNankaiTroughInfo(parseNankaiTroughTelegram(msgOf(FIXTURE_VYSE51_ADVISORY, "VYSE51"))!) },
  { label: "VYSE52-200", render: () => displayNankaiTroughInfo(parseNankaiTroughTelegram(msgOf(FIXTURE_VYSE52_REGULAR, "VYSE52"))!) },
  { label: "VYSE60", render: () => displayNankaiTroughInfo(parseNankaiTroughTelegram(msgOf(FIXTURE_VYSE60_AFTERSHOCK, "VYSE60"))!) },
  { label: "VXSE62", render: () => displayLgObservationInfo(parseLgObservationTelegram(msgOf(FIXTURE_VXSE62_LGOBS, "VXSE62"))!) },
  { label: "VXSE62-synthetic-60area", render: () => displayLgObservationInfo(lgSynthetic(60)) },
];

describe("幅 sweep: 3 系統 幅 60-200 全域の幅保証 (acceptance 3)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let lines: string[] = [];

  beforeEach(() => {
    chalk.level = 3;
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((s?: unknown) => {
      lines.push(String(s ?? ""));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
  });

  for (const c of CASES) {
    it(`${c.label}: 幅 60-200 で全出力行 visualWidth <= width`, () => {
      for (let w = 60; w <= 200; w++) {
        setFrameWidth(w);
        lines = [];
        c.render();
        for (const line of lines) {
          const vw = visualWidth(stripAnsi(line));
          expect(vw, `${c.label} width=${w} line="${stripAnsi(line).slice(0, 40)}"`).toBeLessThanOrEqual(w);
        }
      }
    });
  }
});
