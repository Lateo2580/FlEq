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
  pushWrappedFrameLine,
  pushWrappedFrameTitle,
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
  purpose: "region" | "prose",
): void {
  if (pairs.length === 0) return;
  buf.push(frameDividerColored(level, color, width));
  pushWrappedFrameLine(
    buf,
    level,
    { width, purpose: "type", borderColor: color },
    chalk.gray(`[${label}]`),
  );
  for (const pair of pairs) {
    const line = `  ${safeText(pair.code)}  ${safeText(pair.name)}`;
    pushWrappedFrameLine(buf, level, { width, purpose, borderColor: color }, line);
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
    if (chalk.level === 0) {
      buf.push(frameLineColored(level, color, " テスト電文 ", width));
    } else {
      pushWrappedFrameLine(
        buf,
        level,
        { width, purpose: "type", borderColor: color },
        theme.getRoleChalk("testBadge")(" テスト電文 "),
      );
    }
  }
  pushWrappedFrameTitle(buf, level, { width, borderColor: color }, [
    { text: chalk.bold(title), priority: 0, omission: "never" },
    { text: chalk.gray(infoType), priority: 1, omission: "never" },
    { text: chalk.gray(SEVERITY_LABELS[level]), priority: 2, omission: "drop" },
  ]);
  if (safeText(info.title) !== title) {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "title", borderColor: color },
      chalk.white(safeText(info.title)),
    );
  }

  buf.push(frameDividerColored(level, color, width));
  const qualifier = QUALIFIER_BY_REASON[reason];
  pushWrappedFrameLine(
    buf,
    level,
    { width, purpose: "prose", borderColor: color },
    chalk.yellow.bold(`  ${qualifier}`),
  );
  if (info.headline != null && safeText(info.headline) !== "") {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "headline", borderColor: color },
      `  ${chalk.white(safeText(info.headline))}`,
    );
  }

  pushPairSection(info.areas, "対象地域", buf, level, color, width, "region");
  pushPairSection(info.phenomena, "現象", buf, level, color, width, "prose");
  pushPairSection(info.kinds, "種別", buf, level, color, width, "prose");

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
