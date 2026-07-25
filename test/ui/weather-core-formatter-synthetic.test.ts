// 実 fixture に出現しない特別警報級 Code (L5 / nonLevelSpecial) の描画経路を
// in-memory ParsedWeatherWarning で検証する (合成 XML は壊れやすいため避ける)。
// Code 解決自体は test/dmdata/weather-warning-level.test.ts で網羅済み。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { displayWeatherWarningCore } from "../../src/ui/weather-core-formatter";
import { setFrameWidth, stripAnsi } from "../../src/ui/formatter";
import type { ParsedWeatherWarning } from "../../src/types";

function makeInfo(kinds: { code: string; name: string }[]): ParsedWeatherWarning {
  return {
    type: "VPWW55", infoType: "発表", title: "千葉県気象警報・注意報",
    reportDateTime: "2026-06-08T03:00:00+09:00", headline: null,
    publishingOffice: "気象庁", editorialOffice: "気象庁", controlTitle: "気象警報・注意報",
    layers: [{ type: "市町村等", items: [
      { areaName: "千葉県北西部", areaCode: "120010",
        kinds: kinds.map((k) => ({ name: k.name, code: k.code, severity: "warning" as const })),
        statuses: kinds.map((k) => ({ kindCode: k.code, status: "発表" })),
        fullStatus: "全域" },
    ]}],
    comments: [], maxSeverity: "specialWarning",
    maxDisplaySeverity: null, maxSoundLevel: null,
    warningAreaCount: 1, advisoryAreaCount: 0, isTest: false,
  };
}

describe("特別警報級 (L5 / nonLevelSpecial) 描画経路", () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    setFrameWidth(120);
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => vi.restoreAllMocks());

  it("L5 大雨特別警報 (Code 33) → ★★ L5 + [緊急] + 行動の目安", () => {
    displayWeatherWarningCore(makeInfo([{ code: "33", name: "大雨特別警報" }]));
    const out = logs.map(stripAnsi).join("\n");
    expect(out).toContain("★★");
    expect(out).toContain("L5 大雨特別警報");
    expect(out).toContain("[緊急]");
    expect(out).toContain("命を守る最善の行動を"); // [行動の目安] L5
  });

  it("nonLevelSpecial 暴風特別警報 (Code 35) → ◆◆ + L 表記なし + 行動の目安", () => {
    displayWeatherWarningCore(makeInfo([{ code: "35", name: "暴風特別警報" }]));
    const out = logs.map(stripAnsi).join("\n");
    expect(out).toContain("◆◆");
    expect(out).toContain("暴風特別警報");
    expect(out).not.toMatch(/L[1-5] 暴風特別警報/); // 非対応は L 表記しない
    expect(out).toContain("ただちに命を守る行動を"); // [行動の目安] nonLevelSpecial
  });

  it("L4 大雨危険警報 (Code 43) → ★ L4 (土砂と別 family の大雨 L4)", () => {
    displayWeatherWarningCore(makeInfo([{ code: "43", name: "レベル４大雨危険警報" }]));
    const out = logs.map(stripAnsi).join("\n");
    expect(out).toContain("L4 大雨危険警報");
    expect(out).toContain("危険な場所から全員避難"); // [行動の目安] L4
  });

  it("L5 と nonLevelSpecial 混在 → 代表は L5 (公式優先)", () => {
    displayWeatherWarningCore(makeInfo([
      { code: "33", name: "大雨特別警報" },
      { code: "35", name: "暴風特別警報" },
    ]));
    const out = logs.map(stripAnsi).join("\n");
    // バナー本文 (frame top 前) の代表が L5
    const bannerLine = logs.map(stripAnsi).find((l) => l.includes("★★"));
    expect(bannerLine).toBeDefined();
    expect(out).toContain("★★ 特別警報 (L5)");   // L5 section divider
    expect(out).toContain("◆◆ 特別警報");          // nonLevelSpecial section divider
  });
});
