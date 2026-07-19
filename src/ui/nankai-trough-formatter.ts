import chalk from "chalk";
import { ParsedNankaiTroughInfo } from "../types";
import * as theme from "./theme";
import { nankaiTroughFrameLevel } from "../engine/presentation/level-helpers";
import { typeLabel } from "./earthquake-formatter";
import { pushTextBodyBlock } from "./seismic-text-formatter";
import {
  FrameLevel,
  HighlightRule,
  RenderBuffer,
  getFrameWidth,
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
  clipToVisualWidth,
  visualPadEnd,
  renderFooter,
} from "./formatter";
import { clampFrameContent } from "./responsive-table-engine";

// ── ハイライトルール (earthquake-formatter から移設、パターン変更なし — spec §2 Out of scope) ──

/** 南海トラフ共通ルール */
const NANKAI_COMMON_RULES: readonly HighlightRule[] = [
  { source: "巨大地震警戒", flags: "", style: () => theme.getRoleChalk("nankaiSerialCritical") },
  { source: "大規模地震", flags: "", style: () => theme.getRoleChalk("nankaiSerialCritical") },
  { source: "巨大地震注意|後発地震注意情報|後発地震への注意", flags: "", style: () => theme.getRoleChalk("nankaiSerialWarning") },
  { source: "調査中|調査を開始", flags: "", style: () => theme.getRoleChalk("nankaiSerialWarning") },
  { source: "モーメントマグニチュード[（Ｍｗ）０-９0-9．.クラス以上]*|マグニチュード[（Ｍ）０-９0-9．.クラス以上]*|Ｍｗ[０-９0-9]+", flags: "", style: () => chalk.bold.white },
  { source: "防災対応をとってください|今後の情報に注意してください|身の安全を守る行動", flags: "", style: () => theme.getRoleChalk("nextAdvisory") },
  { source: "相対的に高まっている", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "調査終了", flags: "", style: () => theme.getRoleChalk("textMuted") },
];

/** VYSE52 追加ルール */
const NANKAI_VYSE52_EXTRA_RULES: readonly HighlightRule[] = [
  { source: "特段の変化は観測されていません", flags: "", style: () => theme.getRoleChalk("textMuted") },
  { source: "短期的ゆっくりすべり|長期的ゆっくりすべり", flags: "", style: () => chalk.bold.white },
];

/** 電文種別に応じた南海トラフルールを返す */
export function getNankaiRules(type: string): readonly HighlightRule[] {
  if (type === "VYSE52") {
    return [...NANKAI_COMMON_RULES, ...NANKAI_VYSE52_EXTRA_RULES];
  }
  return NANKAI_COMMON_RULES;
}

// ── バナー (Phase 2/3 と同系の 3 行バナー。発火条件は nankaiTroughFrameLevel 連動のまま非変更) ──

/** バナー文言 (現行の ` ${info.title}` と同値) */
export function nankaiBannerLabel(info: ParsedNankaiTroughInfo): string {
  return info.title;
}

/** 地震 formatter と同型の 3 行バナー。critical / warning のみ、info・cancel はなし */
export function pushNankaiBanner(
  buf: RenderBuffer,
  level: FrameLevel,
  label: string,
  width: number,
): void {
  const bannerText = clipToVisualWidth(` ${label}`, width);
  if (level === "critical") {
    const style = theme.getRoleChalk("nankaiCriticalBanner");
    buf.push(style(" ".repeat(width)));
    buf.push(style(visualPadEnd(bannerText, width)));
    buf.push(style(" ".repeat(width)));
  } else if (level === "warning") {
    const style = theme.getRoleChalk("nankaiWarningBanner");
    buf.push(style(" ".repeat(width)));
    buf.push(style(visualPadEnd(bannerText, width)));
    buf.push(style(" ".repeat(width)));
  }
}

// ── 本体 ──

/** 南海トラフ関連情報を整形して表示 (新デザイン言語。compact はサマリーライン経路の責務) */
export function displayNankaiTroughInfo(info: ParsedNankaiTroughInfo): void {
  const level = nankaiTroughFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();
  const buf = createRenderBuffer();

  buf.pushEmpty();
  pushNankaiBanner(buf, level, nankaiBannerLabel(info), width);
  buf.push(frameTop(level, width));

  // テスト電文バッジ (現行踏襲)
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行 (clamp 経由)
  const titleContent = chalk.bold(label) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, clampFrameContent(titleContent, width), width));

  // 状態カード行 (infoSerial 欠損 = VYSE60 では省略 — spec §3)
  if (info.infoSerial) {
    buf.push(frameDivider(level, width));
    const serialColor = level === "critical"
      ? theme.getRoleChalk("nankaiSerialCritical")
      : theme.getRoleChalk("nankaiSerialWarning");
    buf.pushCard(frameLine(level, clampFrameContent(chalk.white("状態: ") + serialColor(info.infoSerial.name), width), width));
  }

  // ヘッドライン (spec §3 写像で追加 — 旧実装は南海トラフのみ headline 非表示だった)
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

  // 本文 (text-only 雛形を共用)
  pushTextBodyBlock(buf, level, width, info.bodyText, getNankaiRules(info.type), getTruncation().nankaiTroughLines);

  // 次回情報予告 (labeled divider — NO_COLOR 冗長性 ②)
  if (info.nextAdvisory) {
    buf.push(frameDividerLabeled(level, "次回発表", width));
    for (const line of wrapFrameLines(level, theme.getRoleChalk("nextAdvisory")(info.nextAdvisory), width)) {
      buf.push(line);
    }
  }

  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);
  buf.push(frameBottom(level, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width);
}
