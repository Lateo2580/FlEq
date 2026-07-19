import { describe, it, expect, beforeAll, afterAll } from "vitest";
import chalk from "chalk";
import {
  getDisplaySeverityTierPrefix,
  getDisplaySeverityChip,
  getDisplaySeverityText,
  formatLevelLabel,
  normalizeKindName,
  renderStatusChip,
  renderDividerChip,
} from "../../src/ui/weather-warning-level-theme";
import { stripAnsi, visualWidth } from "../../src/ui/formatter";

// vitest は非 TTY のため chalk.level=0 になり ANSI が乗らない。
// 色付与 (chip) の検証のため強制的に色を有効化する。
const ORIGINAL_CHALK_LEVEL = chalk.level;
beforeAll(() => { chalk.level = 3; });
afterAll(() => { chalk.level = ORIGINAL_CHALK_LEVEL; });

describe("getDisplaySeverityTierPrefix", () => {
  it("officialL5 → ★★", () => { expect(getDisplaySeverityTierPrefix("officialL5")).toBe("★★"); });
  it("officialL4 → ★",  () => { expect(getDisplaySeverityTierPrefix("officialL4")).toBe("★"); });
  it("officialL3 → ☆",  () => { expect(getDisplaySeverityTierPrefix("officialL3")).toBe("☆"); });
  it("officialL2 → △",  () => { expect(getDisplaySeverityTierPrefix("officialL2")).toBe("△"); });
  it("officialL1 → ○",  () => { expect(getDisplaySeverityTierPrefix("officialL1")).toBe("○"); });
  it("nonLevelSpecial → ◆◆", () => { expect(getDisplaySeverityTierPrefix("nonLevelSpecial")).toBe("◆◆"); });
  it("nonLevelWarning → ◆",  () => { expect(getDisplaySeverityTierPrefix("nonLevelWarning")).toBe("◆"); });
  it("nonLevelAdvisory → △", () => { expect(getDisplaySeverityTierPrefix("nonLevelAdvisory")).toBe("△"); });
  it("release → ▼", () => { expect(getDisplaySeverityTierPrefix("release")).toBe("▼"); });
  it("unknown → ?", () => { expect(getDisplaySeverityTierPrefix("unknown")).toBe("?"); });
});

describe("getDisplaySeverityChip / Text", () => {
  it("chip は ANSI を含む (色付き出力)", () => {
    const out = getDisplaySeverityChip("officialL5")("test");
    expect(out).not.toBe("test");
    expect(stripAnsi(out)).toBe("test");
  });
  it("text は ANSI を含むが stripAnsi で元に戻る", () => {
    const out = getDisplaySeverityText("officialL3")("test");
    expect(stripAnsi(out)).toBe("test");
  });
});

describe("normalizeKindName (レベル語除去)", () => {
  it("'レベル３大雨警報' → '大雨警報'", () => {
    expect(normalizeKindName("レベル３大雨警報")).toBe("大雨警報");
  });
  it("'レベル４土砂災害危険警報' → '土砂災害危険警報'", () => {
    expect(normalizeKindName("レベル４土砂災害危険警報")).toBe("土砂災害危険警報");
  });
  it("半角数字 'レベル2大雨注意報' も除去", () => {
    expect(normalizeKindName("レベル2大雨注意報")).toBe("大雨注意報");
  });
  it("レベル語なし (暴風警報) は no-op", () => {
    expect(normalizeKindName("暴風警報")).toBe("暴風警報");
  });
});

describe("formatLevelLabel", () => {
  it("公式 L4 + レベル語内包名 → 'L4 土砂災害危険警報' (二重化しない)", () => {
    expect(formatLevelLabel(4, "レベル４土砂災害危険警報")).toBe("L4 土砂災害危険警報");
  });
  it("公式 L3 大雨 → 'L3 大雨警報'", () => {
    expect(formatLevelLabel(3, "レベル３大雨警報")).toBe("L3 大雨警報");
  });
  it("公式 L2 → 'L2 大雨注意報'", () => {
    expect(formatLevelLabel(2, "レベル２大雨注意報")).toBe("L2 大雨注意報");
  });
  it("非対応 (level=null) → 種別のみ (L 表記なし)", () => {
    expect(formatLevelLabel(null, "暴風特別警報")).toBe("暴風特別警報");
    expect(formatLevelLabel(null, "雷注意報")).toBe("雷注意報");
  });
});

describe("renderStatusChip (14 cells 統一幅)", () => {
  it("L5/L4/nonLevelSpecial/release は bg-chip (ANSI 含む)、幅 14", () => {
    const c5 = renderStatusChip("officialL5", "発表 ▲新規");
    expect(c5).not.toBe(stripAnsi(c5));
    expect(visualWidth(stripAnsi(c5))).toBe(14);
  });
  it("L3/L2/L1/nonLevelWarning/nonLevelAdvisory も幅 14 に揃う", () => {
    expect(visualWidth(stripAnsi(renderStatusChip("officialL3", "継続")))).toBe(14);
    expect(visualWidth(stripAnsi(renderStatusChip("officialL4", "発表 ▲新規")))).toBe(14);
    expect(visualWidth(stripAnsi(renderStatusChip("release", "▼解除")))).toBe(14);
    expect(visualWidth(stripAnsi(renderStatusChip("nonLevelAdvisory", "継続")))).toBe(14);
  });
  it("内容は中央寄せ (trim で元に戻る)", () => {
    expect(stripAnsi(renderStatusChip("officialL3", "継続")).trim()).toBe("継続");
  });
});

describe("renderDividerChip (22 cells 統一幅)", () => {
  it("L5/L4/nonLevelSpecial は bg 付き、幅 22", () => {
    expect(visualWidth(stripAnsi(renderDividerChip("officialL5", "★★ 特別警報 (L5)")))).toBe(22);
    expect(visualWidth(stripAnsi(renderDividerChip("officialL4", "★ 危険警報 (L4)")))).toBe(22);
    expect(visualWidth(stripAnsi(renderDividerChip("nonLevelSpecial", "◆◆ 特別警報")))).toBe(22);
  });
  it("L3 は text 色、幅 22", () => {
    expect(visualWidth(stripAnsi(renderDividerChip("officialL3", "☆ 警報 (L3)")))).toBe(22);
  });
});

import {
  drawSeverityBanner,
  DISPLAY_SEVERITY_DIVIDER_LABEL,
} from "../../src/ui/weather-warning-level-theme";

describe("共有バナー/divider ラベル (Phase C)", () => {
  it("drawSeverityBanner は 3 行の色面を返す", () => {
    const [top, mid, bottom] = drawSeverityBanner("officialL4", "★ 土砂災害(L4) 千葉県北西部", 80);
    expect(stripAnsi(top)).toBe(" ".repeat(80));
    expect(stripAnsi(mid)).toContain("土砂災害");
    expect(visualWidth(stripAnsi(mid))).toBe(80);
    expect(stripAnsi(bottom)).toBe(" ".repeat(80));
  });

  it("DIVIDER_LABEL は VPWW 形式 (種別名 + L 注釈) で三電文統一 (2026-06-12 レビュー決定)", () => {
    // 旧 VPWP50 形式 (★★ L5相当 等) は廃止。VPWW Phase A 確定文言に片寄せ。
    expect(DISPLAY_SEVERITY_DIVIDER_LABEL).toEqual({
      officialL5:       "★★ 特別警報 (L5)",
      officialL4:       "★ 危険警報 (L4)",
      officialL3:       "☆ 警報 (L3)",
      officialL2:       "△ 注意報 (L2)",
      officialL1:       "○ 早期注意 (L1)",
      nonLevelSpecial:  "◆◆ 特別警報",
      nonLevelWarning:  "◆ 警報",
      nonLevelAdvisory: "△ 注意報",
      release:          "▼ 解除",
      unknown:          "? 未知",
    });
  });
});
