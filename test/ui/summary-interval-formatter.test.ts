import { describe, it, expect } from "vitest";
import { buildSparkline, formatSummaryInterval } from "../../src/ui/summary-interval-formatter";
import type { SummaryWindowSnapshot } from "../../src/engine/messages/summary-tracker";

describe("buildSparkline", () => {
  it("全部0なら ▁ の繰り返し", () => {
    const result = buildSparkline([0, 0, 0, 0, 0]);
    expect(result).toBe("▁▁▁▁▁");
  });

  it("最大値のスロットが █ になる", () => {
    const result = buildSparkline([0, 0, 10, 0, 0]);
    expect(result).toHaveLength(5);
    expect(result[2]).toBe("█");
  });

  it("全部同じ値なら全て █", () => {
    const result = buildSparkline([5, 5, 5]);
    expect(result).toBe("███");
  });

  it("0 のスロットは ▁ になる", () => {
    const result = buildSparkline([0, 10]);
    expect(result[0]).toBe("▁");
    expect(result[1]).toBe("█");
  });

  it("データ長に対応した文字列長を返す", () => {
    const data = new Array(30).fill(0);
    data[15] = 5;
    const result = buildSparkline(data);
    expect(result).toHaveLength(30);
  });
});

describe("formatSummaryInterval", () => {
  const baseSnapshot: SummaryWindowSnapshot = {
    totalReceived: 15,
    totalMatched: 12,
    byDomain: { eew: 3, earthquake: 10, tsunami: 2 },
    maxIntSeen: "5弱",
    sparklineData: new Array(30).fill(0),
  };

  it("ドメイン別件数が出力に含まれる", () => {
    const output = formatSummaryInterval(baseSnapshot, 10, false);
    expect(output).toContain("EEW 3件");
    expect(output).toContain("地震 10件");
    expect(output).toContain("津波 2件");
  });

  it("間隔(分)がヘッダに含まれる", () => {
    const output = formatSummaryInterval(baseSnapshot, 10, false);
    expect(output).toContain("10分要約");
  });

  it("maxIntSeen が出力に含まれる", () => {
    const output = formatSummaryInterval(baseSnapshot, 10, false);
    expect(output).toContain("最大5弱");
  });

  it("sparkline=true のとき sparkline 行が出力される", () => {
    const output = formatSummaryInterval(baseSnapshot, 10, true);
    expect(output).toContain("受信");
    expect(output).toContain("30分");
  });

  it("sparkline=false のとき sparkline 行が出力されない", () => {
    const output = formatSummaryInterval(baseSnapshot, 10, false);
    // sparkline 行は "受信 ▁" のパターン
    expect(output).not.toContain("▁");
  });

  it("受信なしのスナップショットでも出力される", () => {
    const emptySnapshot: SummaryWindowSnapshot = {
      totalReceived: 0,
      totalMatched: 0,
      byDomain: {},
      maxIntSeen: null,
      sparklineData: new Array(30).fill(0),
    };
    const output = formatSummaryInterval(emptySnapshot, 10, true);
    expect(output).toContain("10分要約");
    expect(output).toContain("受信なし");
  });

  it("maxIntSeen が null なら最大震度が表示されない", () => {
    const snap: SummaryWindowSnapshot = {
      ...baseSnapshot,
      maxIntSeen: null,
    };
    const output = formatSummaryInterval(snap, 5, false);
    expect(output).not.toContain("最大");
  });
});
