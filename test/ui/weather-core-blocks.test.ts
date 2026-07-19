import { describe, it, expect, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { WEATHER_CORE_BLOCKS } from "../../src/ui/weather-core-blocks";
import { VALID_BLOCK_IDS, DEFAULT_WEATHER_CORE_LAYOUT } from "../../src/ui/display-layout";
import { parseWeatherWarning } from "../../src/dmdata/weather-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import {
  pickStatusLayer, flattenEntries, weatherCoreFrameLevel,
} from "../../src/ui/weather-core-entry";
import {
  pickMode, groupBySeverity, renderResponsiveTable, dividerLabelForSeverity,
} from "../../src/ui/weather-core-table";
import { frameDividerLabeledColored } from "../../src/ui/formatter";
import { buildOverflowDetailBlock } from "../../src/ui/weather-core-detail";
import { getDisplaySeverityText, renderDividerChip } from "../../src/ui/weather-warning-level-theme";

describe("WEATHER_CORE_BLOCKS registry", () => {
  it("registry の id 一覧は VALID_BLOCK_IDS と一致する (順序含む)", () => {
    expect(WEATHER_CORE_BLOCKS.map((b) => b.id)).toEqual([...VALID_BLOCK_IDS]);
  });

  it("デフォルト body 順は registry の定義順と一致する", () => {
    expect(DEFAULT_WEATHER_CORE_LAYOUT.body).toEqual(WEATHER_CORE_BLOCKS.map((b) => b.id));
  });

  it("table と unknown は safetyCritical", () => {
    const map = new Map(WEATHER_CORE_BLOCKS.map((b) => [b.id, b.safetyCritical]));
    expect(map.get("table")).toBe(true);
    expect(map.get("unknown")).toBe(true);
    expect(map.get("comments")).toBe(false);
    expect(map.get("actionGuide")).toBe(false);
  });

  it("全ブロックが label と description を持つ", () => {
    for (const b of WEATHER_CORE_BLOCKS) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });
});

describe("buildTableBlock (characterization)", () => {
  const originalLevel = chalk.level;
  beforeEach(() => { chalk.level = 0; });
  afterEach(() => { chalk.level = originalLevel; });

  function buildCtx(width: number) {
    const info = parseWeatherWarning(createMockWsDataMessage("15_17_01_251222_VPWW55.xml"))!;
    const layer = pickStatusLayer(info);
    const entries = layer ? flattenEntries(layer) : [];
    return {
      info,
      entries,
      styleLevel: weatherCoreFrameLevel(info),
      width,
      mode: pickMode(width),
      whiteBorder: chalk.rgb(232, 232, 232),
      layout: { ...DEFAULT_WEATHER_CORE_LAYOUT, body: [...DEFAULT_WEATHER_CORE_LAYOUT.body] },
    };
  }

  // 現行 orchestrator (weather-core-formatter.ts:99-111) のインライン実装の複製。
  // buildTableBlock がこれと「完全一致」することを検証する (byte 一致 characterization)。
  // Codex plan review 指摘 #4: 部分一致では divider 色・severity 順・detail 連結位置の回帰がすり抜ける。
  function legacyTableLines(ctx: ReturnType<typeof buildCtx>): string[] {
    const out: string[] = [];
    const groups = groupBySeverity(ctx.entries);
    for (const g of groups) {
      const sectionColor = getDisplaySeverityText(g.severity);
      const chipLabel = renderDividerChip(g.severity, dividerLabelForSeverity(g.severity));
      out.push(frameDividerLabeledColored(ctx.styleLevel, sectionColor, chipLabel, ctx.width));
      for (const line of renderResponsiveTable(ctx.styleLevel, sectionColor, ctx.width, ctx.mode, g.entries)) {
        out.push(line);
      }
    }
    for (const line of buildOverflowDetailBlock(ctx.styleLevel, ctx.whiteBorder, ctx.width, ctx.mode, ctx.entries)) {
      out.push(line);
    }
    return out;
  }

  it.each([60, 80, 140])("幅 %i (NO_COLOR): buildTableBlock は現行インライン実装と完全一致", (w) => {
    const ctx = buildCtx(w);
    const table = WEATHER_CORE_BLOCKS.find((b) => b.id === "table")!;
    expect(table.build(ctx)).toEqual(legacyTableLines(ctx));
  });

  it("幅 80 (TrueColor): ANSI 込みでも現行インライン実装と完全一致", () => {
    chalk.level = 3;
    const ctx = buildCtx(80);
    const table = WEATHER_CORE_BLOCKS.find((b) => b.id === "table")!;
    expect(table.build(ctx)).toEqual(legacyTableLines(ctx));
  });

  it("standard 幅: table 本体 + こぼれ受けの行を返す", () => {
    const ctx = buildCtx(80);
    const table = WEATHER_CORE_BLOCKS.find((b) => b.id === "table")!;
    const lines = table.build(ctx);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("種別");   // テーブルヘッダ
  });

  it("tableOverflowDetail: false でこぼれ受け ([詳細]) が出ない", () => {
    const ctx = buildCtx(60); // ultra-narrow はこぼれが出やすい
    const table = WEATHER_CORE_BLOCKS.find((b) => b.id === "table")!;
    const withDetail = table.build(ctx).join("\n");
    const without = table
      .build({ ...ctx, layout: { ...ctx.layout, tableOverflowDetail: false } })
      .join("\n");
    expect(without).not.toContain("[詳細]");
    // withDetail に [詳細] が含まれるかは fixture と幅に依存するため、
    // 含まれる場合のみ差分を検証する
    if (withDetail.includes("[詳細]")) {
      expect(without.length).toBeLessThan(withDetail.length);
    }
  });
});
