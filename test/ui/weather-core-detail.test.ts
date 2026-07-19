import { describe, it, expect } from "vitest";
import { buildOverflowDetailBlock } from "../../src/ui/weather-core-detail";
import { stripAnsi } from "../../src/ui/formatter";
import type { WarningEntry, DisplayMode } from "../../src/ui/weather-core-entry";

const white = (s: string) => s;

function entry(p: Partial<WarningEntry>): WarningEntry {
  return {
    id: "x", kindCode: "09", kindName: "レベル４土砂災害危険警報", phenomenonFamily: "landslide",
    officialAlertLevel: 4, displaySeverity: "officialL4", resolutionSource: "map",
    status: "発表", areaName: "宗谷北部",
    lastKindCode: "09", lastKindName: "レベル３土砂災害警報", fullStatus: "一部", ...p,
  };
}

function flat(mode: DisplayMode, width: number, entries: WarningEntry[]): string {
  return buildOverflowDetailBlock("warning", white, width, mode, entries).map(stripAnsi).join("\n");
}

describe("buildOverflowDetailBlock", () => {
  it("wide → 何も落ちないので空", () => {
    expect(buildOverflowDetailBlock("warning", white, 140, "wide", [entry({})])).toEqual([]);
  });

  it("standard → 一部 のみこぼし、全域は省略。種別+地域でラベル", () => {
    const out = flat("standard", 80, [
      entry({ areaName: "宗谷北部", fullStatus: "一部" }),
      entry({ areaName: "宗谷南部", fullStatus: "全域" }),
    ]);
    expect(out).toContain("[詳細]");
    expect(out).toContain("L4 土砂災害危険警報 宗谷北部 … 一部"); // 種別を添える (M2)
    expect(out).not.toContain("宗谷南部"); // 全域はこぼさない
    expect(out).not.toContain("▲");        // standard は状態列が出るので状態はこぼさない
  });

  it("standard で全 entry が全域 → ブロックごと空", () => {
    expect(buildOverflowDetailBlock("warning", white, 80, "standard", [entry({ fullStatus: "全域" })])).toEqual([]);
  });

  it("ultra-narrow → 種別+地域 … 状態(遷移)/一部 をこぼす", () => {
    const out = flat("ultra-narrow", 80, [entry({ areaName: "宗谷北部", fullStatus: "一部" })]);
    expect(out).toContain("L4 土砂災害危険警報 宗谷北部 … ▲ 警→危 / 一部");
  });

  it("ultra-narrow で全域 → 状態のみ (/ 全域 は付かない)", () => {
    const out = flat("ultra-narrow", 80, [entry({ areaName: "宗谷南部", status: "継続", fullStatus: "全域" })]);
    expect(out).toContain("L4 土砂災害危険警報 宗谷南部 … 継続");
    expect(out).not.toContain("全域");
  });

  it("ultra-narrow で fullStatus 未設定 → 状態のみ (一部 は付かない)", () => {
    const out = flat("ultra-narrow", 80, [entry({ areaName: "宗谷北部", status: "継続", fullStatus: undefined })]);
    expect(out).toContain("L4 土砂災害危険警報 宗谷北部 … 継続");
    expect(out).not.toContain("一部");
  });

  it("テーブルと同じ severity 降順で並ぶ (M3)", () => {
    const out = buildOverflowDetailBlock("warning", white, 80, "ultra-narrow", [
      entry({ areaName: "留萌中部", displaySeverity: "officialL2", officialAlertLevel: 2, kindName: "レベル２土砂災害注意報", status: "継続" }),
      entry({ areaName: "宗谷北部", displaySeverity: "officialL4", officialAlertLevel: 4, kindName: "レベル４土砂災害危険警報", status: "継続" }),
    ]).map(stripAnsi);
    const body = out.filter((l) => l.includes("…"));
    expect(body[0]).toContain("L4"); // rank 90 が先 (入力順は L2 が先でも並べ替わる)
    expect(body[1]).toContain("L2");
  });

  it("maxEntries 超過分は … ほか N 件省略 に畳む (M1)", () => {
    const many = Array.from({ length: 25 }, (_, i) => entry({ areaName: `地域${i}`, fullStatus: "一部" }));
    const out = flat("ultra-narrow", 100, many); // ultra-narrow は全 entry が状態をこぼす → 25 件
    expect(out).toContain("ほか 5 件省略"); // default 20 件 + 省略行
  });

  it("空 entries → 空配列", () => {
    expect(buildOverflowDetailBlock("warning", white, 58, "ultra-narrow", [])).toEqual([]);
  });
});
