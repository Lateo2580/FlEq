// VPWW55-61 [行動の目安] ブロック。displaySeverity 階級ごとに取るべき行動を 1 行で添える。
// spec: 設計メモ 2026-06-08-vpww-detail-block-redesign-design.md
import {
  frameLineColored, frameDividerLabeledColored, wrapTextLines,
  visualWidth, visualPadEnd, type FrameLevel,
} from "./formatter";
import type { WarningEntry } from "./weather-core-entry";
import { getDisplaySeverityTierPrefix } from "./weather-warning-level-theme";
import { DISPLAY_SEVERITY_RANK, type DisplaySeverity } from "../dmdata/weather-warning-level";

// 階級ラベル (tier prefix を除く) + 取るべき行動。release/unknown は行動の目安を出さない。
const ACTION_GUIDE: Record<DisplaySeverity, { label: string; action: string } | null> = {
  officialL5:       { label: "L5 特別警報", action: "命を守る最善の行動を" },
  officialL4:       { label: "L4 危険警報", action: "危険な場所から全員避難" },
  officialL3:       { label: "L3 警報",     action: "高齢者等は避難" },
  officialL2:       { label: "L2 注意報",   action: "避難行動を確認" },
  officialL1:       { label: "L1 早期注意", action: "最新情報に注意" },
  nonLevelSpecial:  { label: "特別警報",     action: "ただちに命を守る行動を" },
  nonLevelWarning:  { label: "警報",         action: "危険な場所に近づかない" },
  nonLevelAdvisory: { label: "注意報",       action: "最新情報に注意し備える" },
  release:          null,
  unknown:          null,
};

/**
 * [行動の目安] ブロック (色注入)。表に出ている displaySeverity 階級ごとに 1 行・重複排除・
 * ランク降順。行動の目安を持つ階級が無ければ divider ごと出さない ([] を返す)。
 */
export function buildActionGuideBlock(
  styleLevel: FrameLevel,
  borderColor: (s: string) => string,
  width: number,
  entries: WarningEntry[],
): string[] {
  const seen = new Set<DisplaySeverity>();
  for (const e of entries) seen.add(e.displaySeverity);
  const severities = [...seen]
    .filter((s) => ACTION_GUIDE[s] != null)
    .sort((a, b) => DISPLAY_SEVERITY_RANK[b] - DISPLAY_SEVERITY_RANK[a]);
  if (severities.length === 0) return [];

  // ラベル部 (記号 + 階級) を算出し、→ 位置を揃えるため最大幅で右パディング
  const labels = severities.map((s) => `${getDisplaySeverityTierPrefix(s)} ${ACTION_GUIDE[s]!.label}`);
  const labelWidth = Math.max(...labels.map((l) => visualWidth(l)));

  const out: string[] = [];
  out.push(frameDividerLabeledColored(styleLevel, borderColor, "[行動の目安]", width));
  severities.forEach((s, i) => {
    const line = `  ${visualPadEnd(labels[i], labelWidth)} → ${ACTION_GUIDE[s]!.action}`;
    for (const piece of wrapTextLines(line, Math.max(1, width - 4))) {
      out.push(frameLineColored(styleLevel, borderColor, piece, width));
    }
  });
  return out;
}
