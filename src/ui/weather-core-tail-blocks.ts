// VPWW55-61 末尾ブロック (! 未知 Code / [補足])。罫線は色注入 (白系)。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.6)
import {
  frameLineColored, frameDividerLabeledColored, wrapTextLines, type FrameLevel,
} from "./formatter";
import type { WarningEntry } from "./weather-core-entry";
import { renderDividerChip } from "./weather-warning-level-theme";

// 折返し: テキストを innerWidth (width-4) で wrapTextLines してから色注入版 frameLine で囲む
function pushWrapped(
  out: string[], styleLevel: FrameLevel, borderColor: (s: string) => string,
  width: number, line: string,
): void {
  for (const t of wrapTextLines(line, Math.max(1, width - 4))) {
    out.push(frameLineColored(styleLevel, borderColor, t, width));
  }
}

export function buildUnknownCodeBlock(
  styleLevel: FrameLevel,
  borderColor: (s: string) => string,   // 白系 (WHITE_BORDER)
  width: number,
  entries: WarningEntry[],
): string[] {
  const unknowns = entries.filter((e) => e.resolutionSource === "unknown");
  if (unknowns.length === 0) return [];
  const out: string[] = [];
  // divider ラベルだけ warning アクセント、罫線は borderColor (白系)
  const accent = renderDividerChip("nonLevelWarning", "! 未知 Code");
  out.push(frameDividerLabeledColored(styleLevel, borderColor, accent, width));
  for (const e of unknowns) {
    pushWrapped(out, styleLevel, borderColor, width,
      `  ?${e.kindCode} @${e.areaName}  (kindName="${e.kindName}", status=${e.status})`);
  }
  return out;
}

export function buildCommentsBlock(
  styleLevel: FrameLevel,
  borderColor: (s: string) => string,   // 白系
  width: number,
  comments: { type: string; text: string }[],
): string[] {
  if (comments.length === 0) return [];
  const out: string[] = [];
  out.push(frameDividerLabeledColored(styleLevel, borderColor, "[補足]", width));
  for (const c of comments) {
    const label = c.type ? `[${c.type}] ` : "";
    pushWrapped(out, styleLevel, borderColor, width, `  ${label}${c.text}`);
  }
  return out;
}
