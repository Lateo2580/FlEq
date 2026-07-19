// VPWW55-61 表示の body ブロック registry。並び順 / ON-OFF は display-layout.json で制御する。
// ブロックの追加・改名はここ 1 箇所で完結し、Studio は API 経由で自動追従する。
// spec: 設計メモ 2026-06-10-display-studio-phase2-block-layout-design.md
import type { ParsedWeatherWarning, FrameLevel } from "../types";
import type { WarningEntry, DisplayMode } from "./weather-core-entry";
import type { ResolvedWeatherCoreLayout, WeatherBlockId } from "./display-layout";
import { frameDividerLabeledColored } from "./formatter";
import {
  groupBySeverity, renderResponsiveTable, dividerLabelForSeverity,
} from "./weather-core-table";
import { buildOverflowDetailBlock } from "./weather-core-detail";
import { buildUnknownCodeBlock, buildCommentsBlock } from "./weather-core-tail-blocks";
import { buildActionGuideBlock } from "./weather-core-action-guide";
import { getDisplaySeverityText, renderDividerChip } from "./weather-warning-level-theme";

/** ブロック builder が受け取る描画コンテキスト */
export interface WeatherCoreBlockContext {
  info: ParsedWeatherWarning;
  entries: WarningEntry[];
  styleLevel: FrameLevel;
  width: number;
  mode: DisplayMode;
  whiteBorder: (s: string) => string;  // 白系罫線色 (unknown 以降と、こぼれ受けが使う)
  layout: ResolvedWeatherCoreLayout;   // table ブロックが tableOverflowDetail を参照
}

export interface WeatherCoreBlock {
  id: WeatherBlockId;
  label: string;            // Studio 表示名
  description: string;      // Studio ツールチップ
  safetyCritical: boolean;  // true: 無効化に明示フラグが必要 (display-layout の validate と対応)
  build: (ctx: WeatherCoreBlockContext) => string[];
}

/**
 * 警報テーブル本体 (severity 別セクション) + こぼれ受け詳細。
 * detail は「テーブルがその幅で落とした列の回収」であり独立ブロックにすると
 * 文脈が壊れるため、table の一部として常に直後に出す (Codex R1/R2)。
 */
function buildTableBlock(ctx: WeatherCoreBlockContext): string[] {
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
  if (ctx.layout.tableOverflowDetail) {
    for (const line of buildOverflowDetailBlock(ctx.styleLevel, ctx.whiteBorder, ctx.width, ctx.mode, ctx.entries)) {
      out.push(line);
    }
  }
  return out;
}

export const WEATHER_CORE_BLOCKS: readonly WeatherCoreBlock[] = [
  {
    id: "table",
    label: "警報テーブル",
    description: "severity 別の警報・注意報一覧 + こぼれ受け詳細",
    safetyCritical: true,
    build: buildTableBlock,
  },
  {
    id: "unknown",
    label: "未知コード",
    description: "未対応の警報コード (安全網)",
    safetyCritical: true,
    build: (ctx) => buildUnknownCodeBlock(ctx.styleLevel, ctx.whiteBorder, ctx.width, ctx.entries),
  },
  {
    id: "comments",
    label: "補足",
    description: "気象庁コメント",
    safetyCritical: false,
    build: (ctx) => buildCommentsBlock(ctx.styleLevel, ctx.whiteBorder, ctx.width, ctx.info.comments),
  },
  {
    id: "actionGuide",
    label: "行動の目安",
    description: "警戒レベル別の行動指針",
    safetyCritical: false,
    build: (ctx) => buildActionGuideBlock(ctx.styleLevel, ctx.whiteBorder, ctx.width, ctx.entries),
  },
];

/** id からブロック定義を引く */
export function findWeatherCoreBlock(id: WeatherBlockId): WeatherCoreBlock | undefined {
  return WEATHER_CORE_BLOCKS.find((b) => b.id === id);
}
