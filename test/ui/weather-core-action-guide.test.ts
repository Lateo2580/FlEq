import { describe, it, expect } from "vitest";
import { buildActionGuideBlock } from "../../src/ui/weather-core-action-guide";
import { stripAnsi } from "../../src/ui/formatter";
import type { WarningEntry } from "../../src/ui/weather-core-entry";
import type { DisplaySeverity } from "../../src/dmdata/weather-warning-level";

const white = (s: string) => s;

function we(displaySeverity: DisplaySeverity, areaName = "千葉県北西部"): WarningEntry {
  return {
    id: `${displaySeverity}|${areaName}`, kindCode: "03", kindName: "テスト警報",
    phenomenonFamily: "heavyRain", officialAlertLevel: null,
    displaySeverity, resolutionSource: "map", status: "発表", areaName,
  };
}

function lines(entries: WarningEntry[], width = 80): string[] {
  return buildActionGuideBlock("normal", white, width, entries).map(stripAnsi);
}

describe("buildActionGuideBlock", () => {
  it("階級ごとに重複排除し、ランク降順で 1 行ずつ出す", () => {
    const out = lines([we("officialL2"), we("officialL4"), we("officialL4"), we("nonLevelWarning")]);
    const body = out.filter((l) => l.includes("→"));
    expect(body.length).toBe(3); // L4 / 警報 / L2 (L4 重複は 1 行)
    expect(body[0]).toContain("L4 危険警報");
    expect(body[0]).toContain("危険な場所から全員避難");
    expect(body[1]).toContain("危険な場所に近づかない"); // nonLevelWarning
    expect(body[2]).toContain("L2 注意報");
    expect(body[2]).toContain("避難行動を確認");
  });

  it("先頭に [行動の目安] divider を出す", () => {
    expect(lines([we("officialL3")])[0]).toContain("[行動の目安]");
  });

  it("公式 L は記号 + L 表記 + 行動文", () => {
    const out = lines([we("officialL4")]).join("\n");
    expect(out).toContain("★ L4 危険警報");
    expect(out).toContain("危険な場所から全員避難");
  });

  it("非対応階級は L 無しの汎用文", () => {
    const out = lines([we("nonLevelSpecial")]).join("\n");
    expect(out).toContain("◆◆ 特別警報");
    expect(out).toContain("ただちに命を守る行動を");
    expect(out).not.toMatch(/L[1-5]/);
  });

  it("release / unknown のみ → 空 (divider も出さない)", () => {
    expect(buildActionGuideBlock("cancel", white, 80, [we("release"), we("unknown")])).toEqual([]);
  });

  it("空 entries → 空配列", () => {
    expect(buildActionGuideBlock("normal", white, 80, [])).toEqual([]);
  });
});
