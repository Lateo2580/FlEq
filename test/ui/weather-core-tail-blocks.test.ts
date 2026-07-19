import { describe, it, expect } from "vitest";
import { buildUnknownCodeBlock, buildCommentsBlock } from "../../src/ui/weather-core-tail-blocks";
import { stripAnsi } from "../../src/ui/formatter";
import type { WarningEntry } from "../../src/ui/weather-core-entry";

const white = (s: string) => s;

function entry(p: Partial<WarningEntry>): WarningEntry {
  return {
    id: "x", kindCode: "87", kindName: "謎", phenomenonFamily: "other",
    officialAlertLevel: null, displaySeverity: "unknown", resolutionSource: "unknown",
    status: "発表", areaName: "千葉県北東部", ...p,
  };
}

describe("buildUnknownCodeBlock", () => {
  it("unknown entry あり → '! 未知 Code' divider + 行", () => {
    const flat = buildUnknownCodeBlock("warning", white, 80, [entry({})]).map(stripAnsi).join("\n");
    expect(flat).toContain("! 未知 Code");
    expect(flat).toContain("?87");
    expect(flat).toContain("千葉県北東部");
  });
  it("unknown 以外は無視", () => {
    const e = entry({ resolutionSource: "map", displaySeverity: "officialL3" });
    expect(buildUnknownCodeBlock("warning", white, 80, [e])).toEqual([]);
  });
  it("unknown なし → 空配列", () => {
    expect(buildUnknownCodeBlock("warning", white, 80, [])).toEqual([]);
  });
});

describe("buildCommentsBlock", () => {
  it("comments あり → [補足] divider + 各 comment", () => {
    const flat = buildCommentsBlock("warning", white, 80, [
      { type: "主要事項", text: "東部、西部では低い土地の浸水に警戒" },
    ]).map(stripAnsi).join("\n");
    expect(flat).toContain("[補足]");
    expect(flat).toContain("主要事項");
    expect(flat).toContain("浸水");
  });
  it("comments なし → 空配列", () => {
    expect(buildCommentsBlock("warning", white, 80, [])).toEqual([]);
  });
});
