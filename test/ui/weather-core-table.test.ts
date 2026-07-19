import { describe, it, expect } from "vitest";
import { pickMode, renderResponsiveTable, groupBySeverity, dividerLabelForSeverity } from "../../src/ui/weather-core-table";
import { stripAnsi, visualWidth } from "../../src/ui/formatter";
import type { WarningEntry } from "../../src/ui/weather-core-entry";

const id = (s: string) => s;

function entry(p: Partial<WarningEntry>): WarningEntry {
  return {
    id: "x", kindCode: "03", kindName: "レベル３大雨警報", phenomenonFamily: "heavyRain",
    officialAlertLevel: 3, displaySeverity: "officialL3", resolutionSource: "map",
    status: "発表", areaName: "千葉県北西部", ...p,
  };
}

describe("pickMode", () => {
  it("< 65 → ultra-narrow", () => { expect(pickMode(64)).toBe("ultra-narrow"); });
  it("65..104 → standard", () => {
    expect(pickMode(65)).toBe("standard");
    expect(pickMode(104)).toBe("standard");
  });
  it(">= 105 → wide", () => {
    expect(pickMode(105)).toBe("wide");
    expect(pickMode(200)).toBe("wide");
  });
});

describe("renderResponsiveTable", () => {
  const entries = [entry({})];
  it("wide: 5 列 (種別/地域/状態/備考)", () => {
    const lines = renderResponsiveTable("warning", id, 120, "wide", entries);
    const header = lines.find((l) => stripAnsi(l).includes("種別"))!;
    expect(stripAnsi(header)).toContain("地域");
    expect(stripAnsi(header)).toContain("状態");
    expect(stripAnsi(header)).toContain("備考");
  });
  it("standard: 4 列 (備考なし)", () => {
    const header = renderResponsiveTable("warning", id, 80, "standard", entries)
      .find((l) => stripAnsi(l).includes("種別"))!;
    expect(stripAnsi(header)).toContain("状態");
    expect(stripAnsi(header)).not.toContain("備考");
  });
  it("ultra-narrow: 3 列 (状態なし)", () => {
    const header = renderResponsiveTable("warning", id, 60, "ultra-narrow", entries)
      .find((l) => stripAnsi(l).includes("種別"))!;
    expect(stripAnsi(header)).not.toContain("状態");
  });
  it("各行が width 内", () => {
    for (const l of renderResponsiveTable("warning", id, 80, "standard", entries)) {
      expect(visualWidth(stripAnsi(l))).toBeLessThanOrEqual(80);
    }
  });
});

describe("ultra-narrow width bounds", () => {
  it("keeps every line within widths 40 through 54", () => {
    const longEntry = entry({
      kindName: "土砂災害危険警報",
      areaName: "非常に長い地域名テスト用",
    });
    for (let width = 40; width <= 54; width++) {
      for (const line of renderResponsiveTable("warning", id, width, "ultra-narrow", [longEntry])) {
        expect(visualWidth(stripAnsi(line))).toBe(width);
      }
    }
  });
});

describe("groupBySeverity", () => {
  it("rank 降順でグルーピング", () => {
    const e = [
      entry({ displaySeverity: "officialL2" }),
      entry({ displaySeverity: "officialL5" }),
      entry({ displaySeverity: "officialL3" }),
    ];
    const groups = groupBySeverity(e);
    expect(groups.map((g) => g.severity)).toEqual(["officialL5", "officialL3", "officialL2"]);
  });
});

describe("dividerLabelForSeverity", () => {
  it("officialL5 → '★★ 特別警報 (L5)'", () => {
    expect(dividerLabelForSeverity("officialL5")).toBe("★★ 特別警報 (L5)");
  });
  it("nonLevelSpecial → '◆◆ 特別警報'", () => {
    expect(dividerLabelForSeverity("nonLevelSpecial")).toBe("◆◆ 特別警報");
  });
});
