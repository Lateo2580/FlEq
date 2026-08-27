import { describe, it, expect, afterEach } from "vitest";
import chalk from "chalk";
import { displayEarlyWeatherInfo } from "../../src/ui/early-weather-formatter";
import { parseEarlyWeather } from "../../src/dmdata/early-weather-parser";
import {
  clearFrameWidth,
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
  setFrameWidth,
  visualWidth,
} from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VPAW51_HIGH_TEMP,
} from "../helpers/mock-message";
import { expectCompleteWrappedValue } from "./width-contract-assertions";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function capture(fn: () => void): string {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => logs.push(String(m ?? ""));
  try { fn(); } finally { console.log = orig; }
  return logs.join("\n");
}

afterEach(() => { clearFrameWidth(); });

describe("displayEarlyWeatherInfo - Phase D colored frame", () => {
  it.each([60, 80, 120])("幅 %i で全描画行の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseEarlyWeather(createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP))!;
    const out = capture(() => displayEarlyWeatherInfo(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("取消: 取消文言が出る", () => {
    const info = parseEarlyWeather(createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP))!;
    info.infoType = "取消";
    const out = capture(() => displayEarlyWeatherInfo(info));
    expect(stripAnsi(out)).toContain("取り消されました");
  });

  it.each([40, 60, 80, 120, 200])("過長 title / region / type / prose / period を幅 %i に収め内容を保持する", (width) => {
    const originalLevel = chalk.level;
    try {
      for (const level of [0, 3] as const) {
        chalk.level = level;
        setFrameWidth(width);
        resetFrameLineClampFallbackCount();
        const base = parseEarlyWeather(createMockWsDataMessage(FIXTURE_VPAW51_HIGH_TEMP));
        if (base == null) throw new Error("early weather synthetic の基礎 fixture が不足している");
        const info = structuredClone(base);
        info.infoType = `EARLY_TYPE_KEEP ${"追加種別情報 ".repeat(12)}`;
        info.title = `EARLY_TITLE_KEEP ${"長い現象タイトル ".repeat(20)}`;
        info.targetArea = {
          code: "990001",
          name: `EARLY_REGION_KEEP ${"対象地域名 ".repeat(18)}`,
        };
        info.phenomena = [{
          type: `EARLY_PHENOMENON_TYPE_KEEP ${"現象種別 ".repeat(10)}`,
          climateKind: "気温",
          climateText: `EARLY_PROSE_KEEP ${"長い現象本文を省略せず表示します。 ".repeat(36)}`,
          trend: "above",
          probabilityPercent: 50,
          thresholdValue: 2.5,
          thresholdUnit: "℃",
          areas: [{ code: "990002", name: `EARLY_AREA_KEEP ${"細分地域 ".repeat(12)}` }],
          periodLabel: `EARLY_PERIOD_KEEP ${"対象期間 ".repeat(18)}`,
          periodDuration: "P5D",
          periodStartTime: "2026-08-27T00:00:00+09:00",
        }];
        info.bodyTexts = [{
          text: `EARLY_BODY_KEEP ${"補足本文も省略せず表示します。 ".repeat(36)}`,
          areas: [{ code: "990003", name: `EARLY_BODY_REGION_KEEP ${"本文地域 ".repeat(12)}` }],
        }];

        const out = capture(() => displayEarlyWeatherInfo(info));
        const plain = stripAnsi(out);
        for (const line of plain.split("\n")) {
          const lineWidth = visualWidth(line);
          expect(lineWidth, `color=${level} width=${width} line=${JSON.stringify(line.slice(0, 60))}`)
            .toBeLessThanOrEqual(width);
          if (/^[┌╔├╠│║└╚]/.test(line)) expect(lineWidth).toBe(width);
        }
        for (const marker of [
          "EARLY_TYPE_KEEP",
          "EARLY_TITLE_KEEP",
          "EARLY_PHENOMENON_TYPE_KEEP",
        ]) {
          expect(plain, `color=${level} width=${width} marker=${marker}`).toContain(marker);
        }
        for (const value of [
          info.targetArea.name, info.phenomena[0]?.climateText,
          info.phenomena[0]?.areas[0]?.name,
          info.bodyTexts[0]?.text,
        ]) {
          if (value != null) expectCompleteWrappedValue(plain, value, `color=${level} width=${width}`);
        }
        expect(getFrameLineClampFallbackCount(), `color=${level} width=${width}`).toBe(0);
      }
    } finally {
      chalk.level = originalLevel;
      clearFrameWidth();
    }
  });
});
