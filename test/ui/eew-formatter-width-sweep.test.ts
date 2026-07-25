import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayEewInfo } from "../../src/ui/eew-formatter";
import type { EewDiff } from "../../src/engine/eew/eew-tracker";
import { parseEewTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth, setMaxObservations, stripAnsi, visualWidth } from "../../src/ui/formatter";
import type { ParsedEewInfo } from "../../src/types";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE43_WARNING_S2,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_S26,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE45_PLUM,
  FIXTURE_VXSE45_MIXED,
  FIXTURE_VXSE45_FINAL,
} from "../helpers/mock-message";

function msgOf(fixture: string, type: string) {
  return createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
}
function parsed(fixture: string, type: string): ParsedEewInfo {
  return parseEewTelegram(msgOf(fixture, type))!;
}
/** 全国級 synthetic (範囲・PLUM・到達・長周期・到達予測を混在、決定的) */
function eewSynthetic(count: number): ParsedEewInfo {
  const base = parsed(FIXTURE_VXSE45_S1, "VXSE45");
  const areas: NonNullable<ParsedEewInfo["forecastIntensity"]>["areas"] = Array.from({ length: count }, (_, i) => ({
    name: `合成予報区域${String(i).padStart(3, "0")}`,
    intensity: ["3", "4", "5-", "5+", "6-"][i % 5],
    ...(i % 4 === 0 ? { intensityTo: ["4", "5-", "5+", "6-", "6+"][i % 5] } : {}),
    ...(i % 3 === 0 ? { lgIntensity: `${(i % 4) + 1}` } : {}),
    ...(i % 5 === 0 ? { isPlum: true } : {}),
    ...(i % 2 === 0 ? { hasArrived: true } : { arrivalTime: "2026-07-05T12:00:00+09:00" }),
  }));
  return { ...base, forecastIntensity: { areas } };
}

const DIFF: EewDiff = { previousMaxInt: "4", previousMagnitude: "6.4", previousDepth: "30km", hypocenterChange: true };

const CASES: { label: string; render: () => void }[] = [
  { label: "VXSE43-警報", render: () => displayEewInfo(parsed(FIXTURE_VXSE43_WARNING_S1, "VXSE43"), { activeCount: 1, colorIndex: 0 }) },
  { label: "VXSE43-第2報-diff", render: () => displayEewInfo(parsed(FIXTURE_VXSE43_WARNING_S2, "VXSE43"), { activeCount: 1, colorIndex: 0, diff: DIFF }) },
  { label: "VXSE45-予報", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_S1, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "VXSE45-多地域26報", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_S26, "VXSE45"), { activeCount: 2, colorIndex: 1 }) },
  { label: "VXSE45-PLUM", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_PLUM, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "VXSE45-混在", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_MIXED, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "VXSE45-最終報", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_FINAL, "VXSE45"), { activeCount: 1, colorIndex: 0 }) },
  { label: "VXSE45-取消", render: () => displayEewInfo(parsed(FIXTURE_VXSE45_CANCEL, "VXSE45"), { activeCount: 0, colorIndex: 0 }) },
  // synthetic-220区域-hardcap: maxObs 打ち切りは含まない（hard cap は clip 由来 detail 経由）
  { label: "synthetic-220区域-hardcap", render: () => displayEewInfo(eewSynthetic(220)) },
];

describe("EEW 幅 sweep: 幅 40-200 全域の frame 幅保証 (acceptance 2)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let lines: string[] = [];
  beforeEach(() => {
    chalk.level = 3;
    setMaxObservations(null);
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((s?: unknown) => {
      lines.push(String(s ?? ""));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
    setMaxObservations(null);
  });

  for (const c of CASES) {
    it(`${c.label}: 幅 40-200 で全出力行 visualWidth <= width`, () => {
      for (let w = 40; w <= 200; w++) {
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

  it("synthetic-220区域-fold: 表示上限超過は震度別集約行になり、幅 40-200 で溢れない", () => {
    // 旧実装は隠れ地域を 1 件 1 DetailItem に展開していたため、fold するほど総行数が
    // 増える逆転が起きていた。集約行は震度の種類数までしか伸びないので、折返しても
    // 数行に収まる。幅全域で罫線が溢れないことを併せて固定する。
    setMaxObservations(10);
    for (let w = 40; w <= 200; w++) {
      setFrameWidth(w);
      lines = [];
      displayEewInfo(eewSynthetic(220));
      const plain = lines.map((l) => stripAnsi(l));
      for (const line of plain) {
        expect(visualWidth(line), `width=${w} line="${line.slice(0, 40)}"`).toBeLessThanOrEqual(w);
      }
      expect(plain.some((l) => l.includes("… 他 210 地域"))).toBe(true);
      expect(plain.some((l) => l.includes("表示上限で省略"))).toBe(false);
    }
  });
});
