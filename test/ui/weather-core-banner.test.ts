import { describe, it, expect, beforeAll, afterAll } from "vitest";
import chalk from "chalk";
import { buildBannerText, drawBanner } from "../../src/ui/weather-core-banner";
import { visualWidth, stripAnsi } from "../../src/ui/formatter";

const ORIGINAL = chalk.level;
beforeAll(() => { chalk.level = 3; });
afterAll(() => { chalk.level = ORIGINAL; });

describe("buildBannerText (A2 部品優先度落とし)", () => {
  const base = {
    tierPrefix: "★",
    levelLabel: "L4 土砂災害警戒情報",
    areaName: "千葉県北西部",
    transitionSummary: "新規 1 / 昇格 2",
  };
  it("十分幅: 全部品", () => {
    const t = buildBannerText({ ...base, maxWidth: 100 });
    expect(t).toContain("★");
    expect(t).toContain("L4 土砂災害警戒情報");
    expect(t).toContain("千葉県北西部");
    expect(t).toContain("新規 1 / 昇格 2");
  });
  it("狭幅: 遷移サマリーが落ちる", () => {
    const t = buildBannerText({ ...base, maxWidth: 40 });
    expect(t).toContain("L4 土砂災害警戒情報");
    expect(t).toContain("千葉県北西部");
    expect(t).not.toContain("新規");
  });
  it("極狭: 地域も落ちる", () => {
    const t = buildBannerText({ ...base, maxWidth: 25 });
    expect(t).toContain("L4 土砂災害警戒情報");
    expect(t).not.toContain("千葉県北西部");
  });
  it("tier + 種別は最後まで残る", () => {
    expect(buildBannerText({ ...base, maxWidth: 10 })).toContain("★");
  });
  it("maxWidth を超えない", () => {
    expect(visualWidth(buildBannerText({ ...base, maxWidth: 30 }))).toBeLessThanOrEqual(30);
  });
});

describe("drawBanner", () => {
  it("3 行 (空白 / 本文 / 空白)", () => {
    expect(drawBanner("officialL5", "★★ L5 大雨特別警報", 80).length).toBe(3);
  });
  it("空白行の visualWidth が width", () => {
    const lines = drawBanner("officialL5", "★★ L5 大雨特別警報", 80);
    expect(visualWidth(stripAnsi(lines[0]))).toBe(80);
    expect(visualWidth(stripAnsi(lines[2]))).toBe(80);
  });
  it("本文行は ANSI 着色 (bg-chip)", () => {
    const lines = drawBanner("officialL5", "★★ L5 大雨特別警報", 80);
    expect(lines[1]).not.toBe(stripAnsi(lines[1]));
  });
});
