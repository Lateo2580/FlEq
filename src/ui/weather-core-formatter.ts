// VPWW55-61 気象警報・注意報の表示オーケストレーター (normal モード)。
// compact は message-router の renderSummaryLine が処理するため、ここは normal 専用。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.7 T27)
import chalk from "chalk";
import type { ParsedWeatherWarning } from "../types";
import {
  getFrameWidth, SEVERITY_LABELS,
  frameTopColored, frameBottomColored, frameLineColored,
  frameDividerColored,
  createRenderBuffer, flushWithRecap, renderFooter, pushWrappedFrameLine,
} from "./formatter";
import * as theme from "./theme";
import {
  weatherCoreFrameLevel, weatherCoreDisplaySeverity,
  pickStatusLayer, pickAreaSummaryLayer, flattenEntries, summarizeTransitions,
} from "./weather-core-entry";
import { pickMode } from "./weather-core-table";
import { countActiveAndRelease, isCancelPath, isReleaseOnlyPath } from "./weather-core-cancel";
import { buildBannerText, drawBanner } from "./weather-core-banner";
import {
  getDisplaySeverityTierPrefix, getDisplaySeverityText, formatLevelLabel,
} from "./weather-warning-level-theme";
import { getWeatherCoreLayout, type ResolvedWeatherCoreLayout } from "./display-layout";
import { WEATHER_CORE_BLOCKS, type WeatherCoreBlockContext } from "./weather-core-blocks";
import type { DisplaySeverity } from "../dmdata/weather-warning-level";

// 詳細/補足/未知/footer/外枠 bottom の「白系」罫線色 (normal 概念色 #e8e8e8)。
const WHITE_BORDER = chalk.rgb(232, 232, 232);

const BANNER_SEVERITIES: ReadonlySet<DisplaySeverity> = new Set<DisplaySeverity>([
  "officialL5", "officialL4", "officialL3", "nonLevelSpecial", "nonLevelWarning",
]);

function pushWrappedTitle(
  buf: ReturnType<typeof createRenderBuffer>,
  level: Parameters<typeof pushWrappedFrameLine>[1],
  width: number,
  content: Parameters<typeof pushWrappedFrameLine>[3],
  borderColor?: (s: string) => string,
): void {
  const titleBuf = createRenderBuffer();
  pushWrappedFrameLine(
    titleBuf,
    level,
    { width, purpose: "title", ...(borderColor == null ? {} : { borderColor }) },
    content,
  );
  const [first, ...rest] = titleBuf.getLines();
  if (first == null) return;
  buf.pushTitle(first);
  for (const line of rest) buf.pushTitle(line);
}

export function displayWeatherWarningCore(
  info: ParsedWeatherWarning,
  layoutOverride?: ResolvedWeatherCoreLayout,
): void {
  const layout = layoutOverride ?? getWeatherCoreLayout();
  const styleLevel = weatherCoreFrameLevel(info);   // 罫線スタイル (二重/単線) を決める外枠 level
  const topSeverity = weatherCoreDisplaySeverity(info);
  const outerColor = getDisplaySeverityText(topSeverity); // 外枠/タイトルの罫線色 (最大 severity)
  const width = getFrameWidth();
  const mode = pickMode(width);

  // entry / 遷移 / table は status 保有層 (市町村等) を単一ソースにする
  const statusLayer = pickStatusLayer(info);
  const entries = statusLayer ? flattenEntries(statusLayer) : [];
  const counts = countActiveAndRelease(entries);

  const buf = createRenderBuffer();
  buf.pushEmpty();

  // ── バナー (layout.banner で ON/OFF。並び替えはフレーム外描画のため不可) ──
  const showBanner = BANNER_SEVERITIES.has(topSeverity)
    || isCancelPath(info.infoType, counts) || isReleaseOnlyPath(info.infoType, counts);
  if (layout.banner && showBanner) {
    const repEntry = entries[0];
    const areaLayer = pickAreaSummaryLayer(info);
    const areaName = areaLayer?.items[0]?.areaName ?? repEntry?.areaName ?? "";
    const tier = getDisplaySeverityTierPrefix(topSeverity);
    const label = repEntry ? formatLevelLabel(repEntry.officialAlertLevel, repEntry.kindName) : "気象警報";
    const tr = summarizeTransitions(entries);
    const summary = [
      tr.added ? `新規 ${tr.added}` : null,
      tr.upgraded ? `昇格 ${tr.upgraded}` : null,
      tr.downgraded ? `降格 ${tr.downgraded}` : null,
      tr.released ? `解除 ${tr.released}` : null,
    ].filter((x): x is string => x != null).join(" / ");
    const body = buildBannerText({
      tierPrefix: tier, levelLabel: label,
      areaName, transitionSummary: summary, maxWidth: width - 2,
    });
    const bannerSev: DisplaySeverity =
      isCancelPath(info.infoType, counts) || isReleaseOnlyPath(info.infoType, counts)
        ? "release" : topSeverity;
    for (const l of drawBanner(bannerSev, body, width)) buf.push(l);
  }

  // ── 外枠 + タイトル (最大 severity 色) ──
  buf.push(frameTopColored(styleLevel, outerColor, width));
  if (info.isTest) {
    if (chalk.level === 0) {
      buf.push(frameLineColored(styleLevel, outerColor, " テスト電文 ", width));
    } else {
      pushWrappedFrameLine(
        buf,
        styleLevel,
        { width, purpose: "type", borderColor: outerColor },
        theme.getRoleChalk("testBadge")(" テスト電文 "),
      );
    }
  }
  // title が長い電文 (VPWW61 の全現象連結等) でも幅内に収める。
  pushWrappedTitle(buf, styleLevel, width, [
    { text: chalk.bold(info.title), priority: 0, omission: "never" },
    { text: chalk.gray(info.infoType), priority: 1, omission: "never" },
    { text: chalk.gray(SEVERITY_LABELS[styleLevel]), priority: 2, omission: "drop" },
  ], outerColor);

  // ── 取消パス (固定。早期 return、layout の影響を受けない) ──
  if (isCancelPath(info.infoType, counts)) {
    // 取消 = フレーム全体を release 色の単色に (本文のないフレームの配色言語、
    // 2026-06-11 レビュー決定。VPWP50 の取消パスと同形)
    const cancelColor = getDisplaySeverityText("release");
    buf.push(frameDividerColored(styleLevel, cancelColor, width));
    pushWrappedFrameLine(
      buf,
      styleLevel,
      { width, purpose: "diagnostic", borderColor: cancelColor },
      chalk.gray("この情報は取り消されました"),
    );
    renderFooter(styleLevel, info.type, info.reportDateTime, info.publishingOffice, width, buf, cancelColor);
    buf.push(frameBottomColored(styleLevel, cancelColor, width));
    buf.pushEmpty();
    flushWithRecap(buf, styleLevel, width, cancelColor);
    return;
  }

  // ── body: registry を layout.body の順に実行 (各ブロックは内容が空なら自前で抑制) ──
  const ctx: WeatherCoreBlockContext = {
    info, entries, styleLevel, width, mode, whiteBorder: WHITE_BORDER, layout,
  };
  for (const blockId of layout.body) {
    const block = WEATHER_CORE_BLOCKS.find((b) => b.id === blockId);
    if (block == null) continue;  // resolver 検証済みのため実質到達しない防御
    for (const line of block.build(ctx)) buf.push(line);
  }

  // ── フッタ (layout.footer で ON/OFF。罫線は本文と同じ白系 — 色割れ防止) ──
  if (layout.footer) {
    renderFooter(styleLevel, info.type, info.reportDateTime, info.publishingOffice, width, buf, WHITE_BORDER);
  }
  buf.push(frameBottomColored(styleLevel, WHITE_BORDER, width));
  buf.pushEmpty();
  flushWithRecap(buf, styleLevel, width, WHITE_BORDER);
}
