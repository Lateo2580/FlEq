import { describe, it, expect, vi } from "vitest";
import { displayTyphoonAnalysisInfo } from "../../src/ui/typhoon-analysis-formatter";
import { parseTyphoonAnalysis } from "../../src/dmdata/typhoon-analysis-parser";
import { createMockWsDataMessage, FIXTURE_VPTW60_2020, FIXTURE_VPTW61, FIXTURE_VPTW60_CANCEL } from "../helpers/mock-message";
import { visualWidth, setFrameWidth, clearFrameWidth } from "../../src/ui/formatter";
import type { ParsedTyphoonAnalysis, SpecialValue } from "../../src/types";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function renderInfo(info: ParsedTyphoonAnalysis): string[] {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((l) => { logs.push(String(l)); });
  try { displayTyphoonAnalysisInfo(info); } finally { spy.mockRestore(); }
  return logs.join("\n").split("\n");
}

function render(fixture: string): string[] {
  return renderInfo(parseTyphoonAnalysis(createMockWsDataMessage(fixture))!);
}

function renderFirstMovement(
  value: SpecialValue<number>,
  scalar: number | null = null,
  direction: string | null = "北",
): string {
  const info = structuredClone(parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2020))!);
  info.frames[0]!.center.moveDirection = direction;
  info.frames[0]!.center.moveSpeedKmh = scalar;
  info.frames[0]!.center.moveSpeedKmhValue = value;
  return renderInfo(info).map(stripAnsi).join("\n");
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
  it.each([
    ["ほとんど停滞", {
      raw: "", value: null, condition: "ほとんど停滞", description: null,
      presence: "qualitative",
    }],
    ["ゆっくり", {
      raw: "", value: null, condition: "ほとんど停滞", description: "ゆっくり",
      presence: "qualitative",
    }],
    ["ゆっくり", {
      raw: "ゆっくり", value: null, condition: null, description: null,
      presence: "qualitative",
    }],
    ["移動速度２０ｋｍ／ｈではほとんど停滞", {
      raw: "", value: null, condition: null,
      description: "移動速度２０ｋｍ／ｈではほとんど停滞",
      presence: "qualitative",
    }],
  ] as const)("移動速度 qualitative %s は方向と原文を表示する", (label, value) => {
    const text = renderFirstMovement(value, 20);
    expect(text.replace(/[\s│]/gu, "")).toContain(`移動北${label.replace(/\s+/gu, "")}`);
    expect(text).not.toContain("移動 北 ―km/h");
    expect(text).not.toContain("移動 北 20km/h");
  });
  it("unmapped qualitative は従来の欠損表示へ戻す", () => {
    const text = renderFirstMovement({
      raw: "", value: null, condition: "停滞気味", description: null,
      presence: "qualitative", diagnostics: ["unmappedSpecialValue"],
    });
    expect(text).toContain("移動 北 ―km/h");
    expect(text).not.toContain("停滞気味");
  });
  it("方向欠落でも既知 qualitative は表示する", () => {
    expect(renderFirstMovement({
      raw: "ゆっくり", value: null, condition: null, description: null,
      presence: "qualitative",
    }, null, null)).toContain("移動 ゆっくり");
  });
  it("unknown／empty は定性語を追加せず、valid scalar 付き unmapped は旧数値へ戻す", () => {
    for (const value of [
      { raw: "NaN", value: null, condition: "不明", description: null, presence: "unknown" },
      { raw: "", value: null, condition: null, description: null, presence: "empty" },
    ] as const) {
      const text = renderFirstMovement(value);
      expect(text).toContain("移動 北 ―km/h");
      expect(text).not.toMatch(/不明|空欄/u);
    }
    const unmapped = renderFirstMovement({
      raw: "7.25", value: null, condition: "停滞気味", description: null,
      presence: "qualitative", diagnostics: ["unmappedSpecialValue"],
    }, 7.25);
    expect(unmapped).toContain("移動 北 7.25km/h");
    expect(unmapped).not.toContain("停滞気味");
  });
  it("exact と missing の表示は従来どおり", () => {
    expect(renderFirstMovement({
      raw: "20", value: 20, condition: null, description: null, presence: "value",
    }, 20)).toContain("移動 北 20km/h");
    expect(renderFirstMovement({
      raw: null, value: null, condition: null, description: null, presence: "missing",
    })).toContain("移動 北 ―km/h");
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
