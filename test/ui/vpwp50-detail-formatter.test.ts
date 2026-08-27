import chalk from "chalk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Vpwp50DetailSnapshot } from "../../src/types";
import { displayVpwp50Detail } from "../../src/ui/vpwp50-detail-formatter";
import {
  clearFrameWidth,
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
  setFrameWidth,
  stripAnsi,
  visualWidth,
} from "../../src/ui/formatter";

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

function syntheticDetail(): Vpwp50DetailSnapshot {
  return {
    savedAt: "2026-08-27T12:00:00+09:00",
    targetArea: "対象地域",
    infoType: "発表",
    frameLevel: "warning",
    entries: [{
      severity: "warning",
      kindLabel: "基準到達種別",
      areaName: "詳細地域",
      windows: [{
        series: "3h",
        timeRef: "t1",
        criteriaPeriod: {
          sentence: "基準到達期間",
          criteriaClass: "警戒レベル4相当",
          time: "2026-08-27T12:00:00+09:00",
          duration: "PT3H",
        },
      }],
    }],
    unknownCodes: [{
      areaName: "未知地域",
      propertyType: "未知種別",
      code: "99",
      timeRef: "t-unknown",
    }],
  };
}

afterEach(() => {
  clearFrameWidth();
});

describe("displayVpwp50Detail - CLI width contract synthetic matrix", () => {
  it.each([40, 60, 80, 120, 200])("過長 title / region / diagnostic / table を幅 %i に収め内容を保持する", (width) => {
    const originalLevel = chalk.level;
    try {
      for (const level of [0, 3] as const) {
        chalk.level = level;
        setFrameWidth(width);
        resetFrameLineClampFallbackCount();
        const data = syntheticDetail();
        data.targetArea = `DETAIL_AREA_KEEP ${"対象地域名 ".repeat(18)}`;
        data.infoType = `DETAIL_TYPE_KEEP ${"追加種別情報 ".repeat(12)}`;
        data.entries[0]!.kindLabel = `DETAIL_KIND_KEEP ${"種別名 ".repeat(16)}`;
        data.entries[0]!.areaName = `ENTRY ${"詳細地域 ".repeat(16)}`;
        data.entries[0]!.windows[0]!.criteriaPeriod!.sentence =
          `DETAIL_TABLE_KEEP ${"基準到達文 ".repeat(30)}`;
        data.unknownCodes = [{
          areaName: `DETAIL_UNKNOWN_AREA_KEEP ${"未知地域 ".repeat(16)}`,
          propertyType: `DETAIL_PROPERTY_KEEP ${"未知種別 ".repeat(16)}`,
          code: `DETAIL_CODE_KEEP_${"9".repeat(12)}`,
          timeRef: `REF_${"t".repeat(12)}`,
        }];

        const plain = stripAnsi(capture(() => displayVpwp50Detail(data)));
        for (const line of plain.split("\n")) {
          const lineWidth = visualWidth(line);
          expect(lineWidth, `color=${level} width=${width} line=${JSON.stringify(line.slice(0, 60))}`)
            .toBeLessThanOrEqual(width);
          if (/^[┌╔├╠│║└╚]/.test(line)) expect(lineWidth).toBe(width);
        }
        for (const marker of [
          "DETAIL_AREA_KEEP",
          "DETAIL_KIND_KEEP",
        ]) {
          expect(plain, `color=${level} width=${width} marker=${marker}`).toContain(marker);
        }
        expect(getFrameLineClampFallbackCount(), `color=${level} width=${width}`).toBe(0);
      }
    } finally {
      chalk.level = originalLevel;
    }
  });
});
