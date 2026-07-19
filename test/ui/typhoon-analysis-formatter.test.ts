import { describe, it, expect, vi } from "vitest";
import { displayTyphoonAnalysisInfo } from "../../src/ui/typhoon-analysis-formatter";
import { parseTyphoonAnalysis } from "../../src/dmdata/typhoon-analysis-parser";
import { createMockWsDataMessage, FIXTURE_VPTW60_2020, FIXTURE_VPTW61, FIXTURE_VPTW60_CANCEL } from "../helpers/mock-message";
import { visualWidth, setFrameWidth, clearFrameWidth } from "../../src/ui/formatter";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function render(fixture: string): string[] {
  const info = parseTyphoonAnalysis(createMockWsDataMessage(fixture))!;
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((l) => { logs.push(String(l)); });
  try { displayTyphoonAnalysisInfo(info); } finally { spy.mockRestore(); }
  return logs.join("\n").split("\n");
}

describe("displayTyphoonAnalysisInfo", () => {
  it("2020形式: 実況ブロック+5日予報テーブル (NO_COLOR snapshot)", () => {
    const lines = render(FIXTURE_VPTW60_2020);
    expect(lines.map(stripAnsi).join("\n")).toMatchSnapshot();
  });
  it("VPTW61: 実況のみ (予報テーブルなしで自然終了)", () => {
    const lines = render(FIXTURE_VPTW61);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("実況");
    expect(text).not.toContain("５日予報");
  });
  it("取消: 取消メッセージが表示され予報テーブルなし", () => {
    const lines = render(FIXTURE_VPTW60_CANCEL);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("取り消されました");
    expect(text).not.toContain("５日予報");
    expect(text).not.toContain("実況");
  });
  it("幅60/80/120 で全行が幅内、幅80+ で予報表が row fallback に落ちない", () => {
    for (const w of [60, 80, 120]) {
      setFrameWidth(w);
      try {
        const lines = render(FIXTURE_VPTW60_2020).map(stripAnsi);
        for (const l of lines) expect(visualWidth(l)).toBeLessThanOrEqual(w);
        if (w >= 80) expect(lines.some((l) => /^\s*時刻:\s/.test(l))).toBe(false);
      } finally {
        clearFrameWidth();
      }
    }
  });
});
