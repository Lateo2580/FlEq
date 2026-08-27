import { describe, it, expect, vi } from "vitest";
import chalk from "chalk";
import { displayTyphoonAnalysisInfo } from "../../src/ui/typhoon-analysis-formatter";
import { parseTyphoonAnalysis } from "../../src/dmdata/typhoon-analysis-parser";
import { createMockWsDataMessage, FIXTURE_VPTW60_2020, FIXTURE_VPTW61, FIXTURE_VPTW60_CANCEL } from "../helpers/mock-message";
import {
  clearFrameWidth,
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
  setFrameWidth,
  visualWidth,
} from "../../src/ui/formatter";
import type { ParsedTyphoonAnalysis, SpecialValue } from "../../src/types";
import { expectCompleteWrappedValue } from "./width-contract-assertions";

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

  it.each([40, 60, 80, 120, 200])("過長 title / region / type を幅 %i に収め内容を保持する", (width) => {
    const originalLevel = chalk.level;
    try {
      for (const level of [0, 3] as const) {
        chalk.level = level;
        setFrameWidth(width);
        resetFrameLineClampFallbackCount();
        const info = structuredClone(parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2020))!);
        info.infoType = `TA_TYPE_KEEP ${"追加種別情報 ".repeat(12)}`;
        info.name = {
          name: `TA_NAME_KEEP ${"台風名 ".repeat(14)}`,
          nameKana: "テスト",
          number: "9901",
          remark: null,
        };
        const first = info.frames[0];
        if (first == null) throw new Error("typhoon analysis synthetic の実況 frame が不足している");
        first.typhoonClass = {
          ...first.typhoonClass,
          category: `TA_CLASS_KEEP ${"階級 ".repeat(12)}`,
        };
        first.center = {
          ...first.center,
          location: `TA_REGION_KEEP ${"中心位置 ".repeat(18)}`,
          moveDirection: `DIR ${"移動方向 ".repeat(12)}`,
        };

        const out = renderInfo(info).join("\n");
        const plain = stripAnsi(out);
        for (const line of plain.split("\n")) {
          const lineWidth = visualWidth(line);
          expect(lineWidth, `color=${level} width=${width} line=${JSON.stringify(line.slice(0, 60))}`)
            .toBeLessThanOrEqual(width);
          if (/^[┌╔├╠│║└╚]/.test(line)) expect(lineWidth).toBe(width);
        }
        for (const marker of [
          "TA_TYPE_KEEP",
          "TA_NAME_KEEP",
          "TA_CLASS_KEEP",
        ]) {
          expect(plain, `color=${level} width=${width} marker=${marker}`).toContain(marker);
        }
        for (const value of [first.center.location]) {
          if (value != null) expectCompleteWrappedValue(plain, value, `color=${level} width=${width}`);
        }
        const titleOrder = ["TA_TYPE_KEEP", "TA_NAME_KEEP"]
          .map((marker) => plain.indexOf(marker));
        expect(titleOrder, `color=${level} width=${width} title order`).toEqual([...titleOrder].sort((a, b) => a - b));
        expect(getFrameLineClampFallbackCount(), `color=${level} width=${width}`).toBe(0);
      }
    } finally {
      chalk.level = originalLevel;
      clearFrameWidth();
    }
  });
});
