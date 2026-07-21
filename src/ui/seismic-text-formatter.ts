import chalk from "chalk";
import { ParsedSeismicTextInfo } from "../types";
import * as theme from "./theme";
import { seismicTextFrameLevel } from "../engine/presentation/level-helpers";
import { typeLabel } from "./telegram-type-label";
import {
  FrameLevel,
  HighlightRule,
  RenderBuffer,
  getFrameWidth,
  getInfoFullText,
  getTruncation,
  SEVERITY_LABELS,
  frameTop,
  frameLine,
  frameDivider,
  frameDividerLabeled,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  wrapFrameLines,
  highlightAndWrap,
  renderFooter,
  reflowTelegramLines,
} from "./formatter";
import { clampFrameContent, pushClampedFrameLine } from "./responsive-table-engine";

// ── ハイライトルール (旧 earthquake-formatter から移設、パターン変更なし — spec §2 Out of scope) ──

/** テキスト系ルール */
export const SEISMIC_TEXT_RULES: readonly HighlightRule[] = [
  { source: "活発", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "最大マグニチュード[０-９0-9Ｍ．.]+程度|マグニチュード[０-９0-9．.]+", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "最大震度[０-９0-9][弱強]?|震度[０-９0-9][弱強]?を観測", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "防災上の留意事項|見通し", flags: "", style: () => chalk.bold.white },
];

/** 電文種別に応じたテキスト系ルールを返す */
export function getSeismicTextRules(_type: string): readonly HighlightRule[] {
  return SEISMIC_TEXT_RULES;
}

// ── text-only 雛形 (Phase 4a spec §3。Phase 4b EEW / 将来の text 系電文の参照実装) ──

/**
 * 本文ブロック: labeled divider「本文」+ ハイライト + wrap + 設定駆動の行数トリム。
 * トリムは幅と独立の挙動 (breakpoint で情報を落とさない、spec §3)。
 * 省略時は残行数を明示する (旧表記は総行数のみで残数が読めなかったため変更)。
 */
export function pushTextBodyBlock(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  bodyText: string,
  rules: readonly HighlightRule[],
  maxLines: number,
): void {
  // 電文由来の固定幅 hard-wrap を解除してから blank filter (現状維持) — spec §8 R2-3。
  // maxLines は再結合後の論理行基準になる (物理行数より減る方向のみ)
  const bodyLines = reflowTelegramLines(
    bodyText.split(/\r?\n/).map((line) => line.trimEnd()),
  ).filter((line) => line.trim().length > 0);
  if (bodyLines.length === 0) return;

  buf.push(frameDividerLabeled(level, "本文", width));
  const showFull = getInfoFullText();
  const innerWidth = width - 4;
  const displayLines = showFull ? bodyLines : bodyLines.slice(0, maxLines);
  for (const line of displayLines) {
    for (const highlighted of highlightAndWrap(line, rules, innerWidth)) {
      buf.push(frameLine(level, highlighted, width));
    }
  }
  if (!showFull && bodyLines.length > maxLines) {
    const hidden = bodyLines.length - maxLines;
    pushClampedFrameLine(buf, level, width, chalk.gray(`… 他 ${hidden} 行（全 ${bodyLines.length} 行）`));
  }
}

// ── 本体 ──

/** 地震活動テキスト情報を整形して表示 (新デザイン言語。compact はサマリーライン経路の責務) */
export function displaySeismicTextInfo(info: ParsedSeismicTextInfo): void {
  const level = seismicTextFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();
  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTop(level, width));

  // テスト電文バッジ (現行踏襲)
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行 (clamp 経由)
  const titleContent = chalk.bold(label) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));

  // ヘッドライン (wrap、現行踏襲)
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineWrapped = wrapFrameLines(level, chalk.bold.white(info.headline), width);
    for (let i = 0; i < headlineWrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(headlineWrapped[i]);
      } else {
        buf.push(headlineWrapped[i]);
      }
    }
  }

  // 本文 (text-only 雛形)
  pushTextBodyBlock(buf, level, width, info.bodyText, getSeismicTextRules(info.type), getTruncation().seismicTextLines);

  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);
  buf.push(frameBottom(level, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width);
}
