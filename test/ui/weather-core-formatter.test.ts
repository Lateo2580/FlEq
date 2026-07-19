import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { displayWeatherWarningCore } from "../../src/ui/weather-core-formatter";
import { setFrameWidth } from "../../src/ui/formatter";
import type { ParsedWeatherWarning } from "../../src/types";

function makeInfo(overrides: Partial<ParsedWeatherWarning> = {}): ParsedWeatherWarning {
  return {
    type: "VPWW55", infoType: "発表", title: "千葉県大雨警報・注意報",
    reportDateTime: "2026-06-07T17:00:00+09:00", headline: null,
    publishingOffice: "気象庁", editorialOffice: "気象庁", controlTitle: "気象警報・注意報",
    layers: [
      { type: "市町村等", items: [
        { areaName: "千葉県北西部", areaCode: "120001",
          kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
          statuses: [{ kindCode: "03", status: "発表" }],
          fullStatus: "全域" },
      ]},
    ],
    comments: [], maxSeverity: "warning",
    warningAreaCount: 1, advisoryAreaCount: 0, isTest: false,
    ...overrides,
  } as ParsedWeatherWarning;
}

describe("displayWeatherWarningCore smoke", () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { logs.push(s); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("L3 大雨警報 → 種別/地域/フッタが出力される", () => {
    displayWeatherWarningCore(makeInfo());
    const all = logs.join("\n");
    expect(all).toContain("大雨警報");
    expect(all).toContain("千葉県北西部");
    expect(all).toContain("VPWW55");
    expect(all).toContain("高齢者等は避難"); // [行動の目安] L3
  });

  it("取消 → '取り消されました' が出る", () => {
    displayWeatherWarningCore(makeInfo({ infoType: "取消" }));
    expect(logs.join("\n")).toContain("取り消されました");
  });

  it("comments があれば [補足] ブロックが出る", () => {
    displayWeatherWarningCore(makeInfo({
      comments: [{ type: "主要事項", text: "低い土地の浸水に警戒して下さい。" }],
    }));
    const all = logs.join("\n");
    expect(all).toContain("[補足]");
    expect(all).toContain("浸水");
  });

  it("例外を投げない (全行が文字列)", () => {
    expect(() => displayWeatherWarningCore(makeInfo())).not.toThrow();
    expect(logs.length).toBeGreaterThan(3);
  });

  it("末尾ブロックは [詳細] → [補足] → [行動の目安] の順 (M4)", () => {
    setFrameWidth(60); // ultra-narrow: 状態列が落ちるので [詳細] が出る
    displayWeatherWarningCore(makeInfo({
      layers: [{ type: "市町村等", items: [
        { areaName: "千葉県北西部", areaCode: "120001",
          kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
          statuses: [{ kindCode: "03", status: "発表" }], fullStatus: "一部" },
      ]}],
      comments: [{ type: "主要事項", text: "低い土地の浸水に警戒して下さい。" }],
    }));
    const a = logs.join("\n");
    expect(a.indexOf("[詳細]")).toBeGreaterThanOrEqual(0);
    expect(a.indexOf("[詳細]")).toBeLessThan(a.indexOf("[補足]"));
    expect(a.indexOf("[補足]")).toBeLessThan(a.indexOf("[行動の目安]"));
  });

  it("wide では [詳細] を出さず [行動の目安] は出す (M4)", () => {
    setFrameWidth(140);
    displayWeatherWarningCore(makeInfo()); // 既定 fullStatus=全域・単一 L3
    const a = logs.join("\n");
    expect(a).not.toContain("[詳細]");
    expect(a).toContain("[行動の目安]");
  });
});
