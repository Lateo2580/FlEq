import chalk from "chalk";
import type {
  LegacyCounterpartCodeNamePair,
  LegacyCounterpartReason,
  ParsedLegacyCounterpartInfo,
} from "../types";
import { normalizeLegacyCounterpartDisplayText as safeText } from "../engine/presentation/legacy-counterpart-display-text";
import * as theme from "./theme";
import {
  type FrameLevel,
  SEVERITY_LABELS,
  getFrameWidth,
  frameTopColored,
  frameLineColored,
  frameDividerColored,
  frameBottomColored,
  createRenderBuffer,
  flushWithRecap,
  renderFooter,
  wrapFrameLinesColored,
} from "./formatter";

const WHITE_BORDER = chalk.rgb(232, 232, 232);
const QUALIFIER_BY_REASON: Record<LegacyCounterpartReason, string> = {
  counterpartRuleUnconfirmed: "対応電文未確認",
};

function pushPairSection(
  pairs: LegacyCounterpartCodeNamePair[],
  label: string,
  buf: ReturnType<typeof createRenderBuffer>,
  level: FrameLevel,
  color: (s: string) => string,
  width: number,
): void {
  if (pairs.length === 0) return;
  buf.push(frameDividerColored(level, color, width));
  buf.push(frameLineColored(level, color, chalk.gray(`[${label}]`), width));
  for (const pair of pairs) {
    const line = `  ${safeText(pair.code)}  ${safeText(pair.name)}`;
    for (const wrapped of wrapFrameLinesColored(level, color, line, width)) {
      buf.push(wrapped);
    }
  }
}

/** VPOA50／VPNO50／VXWW50 の header-only fail-open CLI formatter。 */
export function displayLegacyCounterpartInfo(
  info: ParsedLegacyCounterpartInfo,
  reason: LegacyCounterpartReason,
): void {
  const level: FrameLevel = "info";
  const width = getFrameWidth();
  const color = WHITE_BORDER;
  const buf = createRenderBuffer();
  const title = safeText(info.controlTitle || "旧形式防災情報");
  const infoType = safeText(info.infoType);

  buf.pushEmpty();
  buf.push(frameTopColored(level, color, width));
  if (info.isTest) {
    buf.push(frameLineColored(level, color, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }
  buf.pushTitle(
    frameLineColored(
      level,
      color,
      chalk.bold(title) + chalk.gray(`  ${infoType}  ${SEVERITY_LABELS[level]}`),
      width,
    ),
  );
  if (safeText(info.title) !== title) {
    buf.push(frameLineColored(level, color, chalk.white(safeText(info.title)), width));
  }

  buf.push(frameDividerColored(level, color, width));
  const qualifier = QUALIFIER_BY_REASON[reason];
  buf.push(frameLineColored(level, color, chalk.yellow.bold(`  ${qualifier}`), width));
  if (info.headline != null && safeText(info.headline) !== "") {
    for (const wrapped of wrapFrameLinesColored(
      level,
      color,
      `  ${chalk.white(safeText(info.headline))}`,
      width,
    )) {
      buf.push(wrapped);
    }
  }

  pushPairSection(info.areas, "対象地域", buf, level, color, width);
  pushPairSection(info.phenomena, "現象", buf, level, color, width);
  pushPairSection(info.kinds, "種別", buf, level, color, width);

  renderFooter(
    level,
    safeText(info.type),
    safeText(info.reportDateTime),
    safeText(info.publishingOffice),
    width,
    buf,
    color,
  );
  buf.push(frameBottomColored(level, color, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width, color);
}
