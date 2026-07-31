import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from "vitest";
import { TEST_TABLES } from "../../src/ui/test-samples";
import { setDisplayMode } from "../../src/ui/formatter";

// loadFixture は private なので TEST_TABLES 経由で間接的に検証する
// typhoonProbability バリアントが type=VPTA50 の電文を処理することを確認する

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let logs: string[];
let logSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a ?? "")).join(" "));
  });
});
afterEach(() => {
  logSpy.mockRestore();
  setDisplayMode("normal");
});

describe("TEST_TABLES — typhoonProbability (loadFixture VPTA50 type 推定)", () => {
  it("DAMREY バリアントを実行するとフッターに VPTA50 が含まれ VXSE53 が含まれない", () => {
    const entry = TEST_TABLES["typhoonProbability"];
    expect(entry).toBeDefined();
    const damreyVariant = entry.variants.find((v) => v.label.includes("DAMREY"));
    expect(damreyVariant).toBeDefined();

    damreyVariant!.run();
    const joined = stripAnsi(logs.join(""));

    // フッターに VPTA50 が出る (type 推定が正しく VPTA50 になっている)
    expect(joined).toContain("VPTA50");
    // VXSE53 へのフォールバックが起きていない
    expect(joined).not.toContain("VXSE53");
  });

  it("typhoonProbability エントリには 4 バリアントが存在する", () => {
    const entry = TEST_TABLES["typhoonProbability"];
    expect(entry).toBeDefined();
    expect(entry.variants.length).toBe(4);
  });
});

describe("TEST_TABLES — fixture envelope", () => {
  it("洪水 fixture の実 XML にある発表官署を表示へ渡す", () => {
    TEST_TABLES["floodForecast"].variants[0].run();
    const joined = stripAnsi(logs.join("\n"));

    expect(joined).toContain("○○河川事務所");
    expect(joined).toContain("○○地方気象台");
    expect(joined).toContain("△△地方気象台");
  });
});

describe("TEST_TABLES compact summary 経路", () => {
  it.each([
    "weather",
    "tornado",
    "briefing",
    "earlyWeather",
    "climateInfo",
  ] as const)("%s は formatter ではなく 1 行 summary を表示する", (type) => {
    setDisplayMode("compact");
    TEST_TABLES[type].variants[0].run();

    expect(logs).toHaveLength(1);
    const line = stripAnsi(logs[0]);
    expect(line).not.toContain("╔");
    expect(line).not.toContain("╚");
  });
});
