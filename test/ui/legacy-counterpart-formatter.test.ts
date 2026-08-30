import chalk from "chalk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedLegacyCounterpartInfo } from "../../src/types";
import { displayLegacyCounterpartInfo } from "../../src/ui/legacy-counterpart-formatter";
import {
  clearFrameWidth,
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
  setFrameWidth,
  stripAnsi,
  visualWidth,
} from "../../src/ui/formatter";
import { testTelegramMeta } from "../helpers/telegram-meta";
import { expectCompleteWrappedValue } from "./width-contract-assertions";

function capture(fn: () => void): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg ?? "")).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

function syntheticInfo(): ParsedLegacyCounterpartInfo {
  return {
    type: "VPOA50",
    infoType: "発表",
    title: "旧形式防災情報",
    controlTitle: "旧形式防災情報",
    reportDateTime: "2026-08-27T12:00:00+09:00",
    headline: "旧形式の情報を確認してください。",
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    eventId: "legacy-test-event",
    serial: "1",
    areas: [{ code: "01", name: "対象地域" }],
    phenomena: [{ code: "P01", name: "現象" }],
    kinds: [{ code: "K01", name: "種別" }],
    severityEvidence: [],
    meta: testTelegramMeta(true),
    isTest: true,
  };
}

afterEach(() => {
  clearFrameWidth();
});

describe("displayLegacyCounterpartInfo - CLI width contract synthetic matrix", () => {
  it.each([40, 60, 80, 120, 200])("過長 title / region / headline / code-name を幅 %i に収め内容を保持する", (width) => {
    const originalLevel = chalk.level;
    try {
      for (const level of [0, 3] as const) {
        chalk.level = level;
        setFrameWidth(width);
        resetFrameLineClampFallbackCount();
        const info = syntheticInfo();
        info.controlTitle = `LEGACY_CONTROL_KEEP ${"長い制御名 ".repeat(16)}`;
        info.infoType = `LEGACY_TYPE_KEEP ${"追加種別情報 ".repeat(12)}`;
        info.title = `LEGACY_TITLE_KEEP ${"長い旧形式タイトル ".repeat(20)}`;
        info.headline = `LEGACY_HEADLINE_KEEP ${"長いヘッドライン本文を省略せず表示します。 ".repeat(36)}`;
        info.areas = [{
          code: `LEGACY_REGION_CODE_KEEP_${"01".repeat(8)}`,
          name: `AREA_KEEP ${"対象地域名 ".repeat(18)}`,
        }];
        info.phenomena = [{
          code: `LEGACY_PROSE_CODE_KEEP_${"P".repeat(20)}`,
          name: `P_KEEP ${"現象名 ".repeat(18)}`,
        }];
        info.kinds = [{
          code: `LEGACY_KIND_CODE_KEEP_${"K".repeat(20)}`,
          name: `KIND_KEEP ${"種別名 ".repeat(18)}`,
        }];

        const plain = stripAnsi(capture(() => displayLegacyCounterpartInfo(info, "counterpartRuleUnconfirmed")));
        for (const line of plain.split("\n")) {
          const lineWidth = visualWidth(line);
          expect(lineWidth, `color=${level} width=${width} line=${JSON.stringify(line.slice(0, 60))}`)
            .toBeLessThanOrEqual(width);
          if (/^[┌╔├╠│║└╚]/.test(line)) expect(lineWidth).toBe(width);
        }
        for (const marker of [
          "LEGACY_CONTROL_KEEP",
          "LEGACY_TYPE_KEEP",
          "LEGACY_TITLE_KEEP",
        ]) {
          expect(plain, `color=${level} width=${width} marker=${marker}`).toContain(marker);
        }
        expect(plain).not.toContain("対応電文未確認");
        for (const value of [
          info.headline, info.areas[0]?.code, info.areas[0]?.name,
          info.phenomena[0]?.code, info.phenomena[0]?.name,
          info.kinds[0]?.code, info.kinds[0]?.name,
        ]) {
          if (value != null) expectCompleteWrappedValue(plain, value, `color=${level} width=${width}`);
        }
        expect(getFrameLineClampFallbackCount(), `color=${level} width=${width}`).toBe(0);
      }
    } finally {
      chalk.level = originalLevel;
    }
  });
});
