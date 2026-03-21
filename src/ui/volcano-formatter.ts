import chalk from "chalk";
import {
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoTextInfo,
  ParsedVolcanoPlumeInfo,
} from "../types";
import {
  FrameLevel,
  RenderBuffer,
  HighlightRule,
  SEVERITY_LABELS,
  createRenderBuffer,
  flushWithRecap,
  getFrameWidth,
  getDisplayMode,
  getInfoFullText,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  frameColor,
  formatTimestamp,
  wrapFrameLines,
  visualPadEnd,
  renderFooter,
  renderFrameTable,
  highlightAndWrap,
} from "./formatter";
import { getRoleChalk, RoleName } from "./theme";
import { VolcanoPresentation } from "../engine/notification/volcano-presentation";

// ── ヘルパー ──

/** 電文タイプの日本語名 */
export function volcanoTypeLabel(type: string): string {
  const map: Record<string, string> = {
    VFVO50: "噴火警報・予報",
    VFVO51: "火山の状況に関する解説情報",
    VFVO52: "噴火に関する火山観測報",
    VFVO53: "降灰予報（定時）",
    VFVO54: "降灰予報（速報）",
    VFVO55: "降灰予報（詳細）",
    VFVO56: "噴火速報",
    VFVO60: "推定噴煙流向報",
    VZVO40: "火山に関するお知らせ",
  };
  // VFSVii は先頭4文字 "VFSV" でマッチ
  if (type.startsWith("VFSV")) return "火山現象に関する海上警報";
  return map[type] || type;
}

/** 噴火警戒レベルに対応するテーマロール */
function levelRole(level: number | null): RoleName {
  switch (level) {
    case 1: return "volcanoLevel1";
    case 2: return "volcanoLevel2";
    case 3: return "volcanoLevel3";
    case 4: return "volcanoLevel4";
    case 5: return "volcanoLevel5";
    default: return "textMuted";
  }
}

/** 現象コードに対応するテーマロール */
function phenomenonRole(code: string): RoleName {
  switch (code) {
    case "51": return "volcanoPhenomenonExplosion";    // 爆発
    case "52": return "volcanoPhenomenonEruption";     // 噴火
    case "56": return "volcanoPhenomenonFrequent";     // 噴火多発
    case "62": return "volcanoPhenomenonPossible";     // 噴火したもよう
    default: return "textMuted";
  }
}

/** 降灰コードに対応するテーマロール */
function ashfallRole(code: string): RoleName {
  switch (code) {
    case "75": return "volcanoAshfallBallistic";   // 小さな噴石
    case "73": return "volcanoAshfallHeavy";       // 多量
    case "72": return "volcanoAshfallModerate";    // やや多量
    case "71": return "volcanoAshfallLight";       // 少量
    case "70": return "volcanoAshfallLight";       // 降灰
    default: return "textMuted";
  }
}

/** アクションの日本語ラベル */
function actionLabel(action: string): string {
  const map: Record<string, string> = {
    raise: "引上げ",
    lower: "引下げ",
    release: "解除",
    continue: "継続",
    issue: "発表",
    cancel: "取消",
  };
  return map[action] ?? action;
}

/** レベルコード表示変換 */
function levelCodeToDisplay(code: string): string {
  const map: Record<string, string> = {
    "11": "Lv1", "12": "Lv2", "13": "Lv3", "14": "Lv4", "15": "Lv5",
    "21": "活火山であることに留意",
    "22": "火口周辺危険",
    "23": "入山危険",
    "31": "海上警報",
    "33": "海上予報",
    "35": "活火山であることに留意（海底火山）",
    "36": "周辺海域警戒",
  };
  return map[code] ?? code;
}

/** wrapFrameLines の結果を RenderBuffer に push */
function pushWrapped(buf: RenderBuffer, level: FrameLevel, content: string, width: number): void {
  const lines = wrapFrameLines(level, content, width);
  for (const line of lines) {
    buf.push(line);
  }
}

// ── 火山本文ハイライト ──

/** 火山本文キーワード強調ルール */
const VOLCANO_HIGHLIGHT_RULES: HighlightRule[] = [
  // 警戒・危険語
  { source: "噴火警報|噴火予報|噴火速報|海上警報|海上予報", flags: "", style: () => chalk.bold.white },
  { source: "噴火警戒レベル[1-5１-５]?|レベル[1-5１-５]|Lv[1-5]", flags: "", style: () => chalk.bold.white },
  { source: "避難|警戒|規制|立入禁止|危険|注意", flags: "", style: () => getRoleChalk("warningComment") },
  // 現象語
  { source: "噴火|爆発|噴煙|降灰|噴石|大きな噴石|小さな噴石|火砕流|溶岩流|火山泥流|火山ガス", flags: "", style: () => getRoleChalk("warningComment") },
  // 観測語
  { source: "火山性微動|山体膨張|傾斜変動|空振|火映|鳴動", flags: "", style: () => chalk.white },
  // レベル変更語
  { source: "引き上げ|引き下げ|引上げ|引下げ|継続|解除|発表", flags: "", style: () => chalk.white },
  // 海域関連
  { source: "海底火山|周辺海域警戒|周辺海域", flags: "", style: () => chalk.white },
];

/**
 * 火山本文をハイライト付きで表示する共通ヘルパー。
 * 改行で段落分割 → 各行にハイライト+折り返し → frameLine で出力。
 */
function pushHighlightedBody(
  buf: RenderBuffer,
  level: FrameLevel,
  bodyText: string,
  width: number,
  maxLines: number,
): void {
  const innerWidth = width - 4;
  const bodyLines = bodyText
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const outputLines: string[] = [];
  for (const line of bodyLines) {
    if (line.trim().length === 0) {
      outputLines.push("");
      continue;
    }
    const highlighted = highlightAndWrap(` ${line}`, VOLCANO_HIGHLIGHT_RULES, innerWidth);
    outputLines.push(...highlighted);
  }

  const displayLines = outputLines.slice(0, maxLines);
  for (const line of displayLines) {
    buf.push(frameLine(level, line, width));
  }
  if (outputLines.length > maxLines) {
    buf.push(frameLine(level, ` ${chalk.gray(`(以下省略、全${outputLines.length}行)`)}`, width));
  }
}

/** バナー表示仕様 */
interface VolcanoBannerSpec {
  role: RoleName;
  text: string;
}

/** 電文・レベルに基づくバナー表示判定 */
function getVolcanoBannerSpec(
  info: ParsedVolcanoInfo,
  level: FrameLevel,
): VolcanoBannerSpec | null {
  if (info.kind === "alert" && level === "critical") {
    return { role: "volcanoAlertBanner", text: volcanoTypeLabel(info.type) };
  }
  if (info.kind === "eruption" && info.isFlashReport && level === "critical") {
    return { role: "volcanoFlashBanner", text: "噴火速報" };
  }
  if (info.kind === "ashfall" && level === "warning" && info.type === "VFVO54") {
    return { role: "volcanoAlertBanner", text: volcanoTypeLabel(info.type) };
  }
  return null;
}

/** フレーム外全幅バナー描画 */
function pushFullWidthBanner(
  buf: RenderBuffer,
  style: ReturnType<typeof getRoleChalk>,
  text: string,
  width: number,
): void {
  buf.push(style(" ".repeat(width)));
  buf.push(style(visualPadEnd(` ${text}`, width)));
  buf.push(style(" ".repeat(width)));
}

// ── 共通ヘッダー ──

function renderVolcanoHeader(
  info: ParsedVolcanoInfo,
  level: FrameLevel,
  width: number,
  buf: RenderBuffer,
): void {
  buf.push(frameTop(level, width));

  // タイトル行 — pushTitle で recap 対応
  const titleContent = info.isTest
    ? ` ${getRoleChalk("testBadge")(" TEST ")} ${info.title}  ${chalk.gray(SEVERITY_LABELS[level])}`
    : ` ${info.title}  ${chalk.gray(SEVERITY_LABELS[level])}`;
  buf.pushTitle(frameLine(level, titleContent, width));

  // 火山名・日時
  const volcanoLabel = info.volcanoName || "(不明)";
  const timeStr = formatTimestamp(info.reportDateTime);
  buf.push(frameLine(level, ` ${volcanoLabel}  ${chalk.gray(timeStr)}`, width));

  // ヘッドライン — pushHeadline で recap 対応（最初の行のみ）
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const wrapped = wrapFrameLines(level, ` ${info.headline}`, width);
    for (let i = 0; i < wrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(wrapped[i]);
      } else {
        buf.push(wrapped[i]);
      }
    }
  }
}

// ── 電文タイプ別レンダラ ──

function renderAlert(info: ParsedVolcanoAlertInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // カード行 (recap 用 1行サマリー)
  if (info.alertLevel != null) {
    const role = levelRole(info.alertLevel);
    const colorFn = getRoleChalk(role);
    const actionStr = actionLabel(info.action);
    // 引上げ/引下げ時: 矢印形式で前回→現在を1行表示
    if (info.previousLevelCode && (info.action === "raise" || info.action === "lower")) {
      const prevDisplay = levelCodeToDisplay(info.previousLevelCode);
      buf.pushCard(frameLine(level, ` ${chalk.gray(prevDisplay)} → ${colorFn(`Lv${info.alertLevel}`)} ${chalk.white(info.warningKind)}  (${actionStr})`, width));
    } else {
      buf.pushCard(frameLine(level, ` ${colorFn(`Lv${info.alertLevel}`)} ${chalk.white(info.warningKind)}  (${actionStr})`, width));
    }
  } else if (info.isMarine) {
    // 海上警報: warningKind + marineWarningKind + action で情報を強化
    const cardParts: string[] = [];
    if (info.warningKind) cardParts.push(chalk.bold.white(info.warningKind));
    if (info.marineWarningKind) cardParts.push(chalk.white(info.marineWarningKind));
    cardParts.push(`(${actionLabel(info.action)})`);
    buf.pushCard(frameLine(level, ` ${cardParts.join("  ")}`, width));
  }

  // 対象市町村
  if (info.municipalities.length > 0) {
    buf.push(frameDivider(level, width));
    const muniNames = info.municipalities.map((m) => m.name);
    const muniLine = muniNames.slice(0, 6).join(", ");
    const suffix = muniNames.length > 6 ? ` 他${muniNames.length - 6}件` : "";
    pushWrapped(buf, level, ` ${chalk.gray("対象:")} ${muniLine}${suffix}`, width);
  }

  // 対象海上予報区
  if (info.marineAreas.length > 0) {
    buf.push(frameDivider(level, width));
    const areaNames = info.marineAreas.map((a) => a.name);
    pushWrapped(buf, level, ` ${chalk.gray("対象海域:")} ${areaNames.join(", ")}`, width);
  }

  // 本文 (VolcanoActivity) / 防災事項 (VolcanoPrevention)
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const fullText = getInfoFullText();
    const bodyLines = info.bodyText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const maxLines = fullText ? bodyLines.length * 2 : 10;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }
  if (info.isMarine && info.preventionText) {
    buf.push(frameDivider(level, width));
    pushHighlightedBody(buf, level, info.preventionText, width, 8);
  }
}

function renderEruption(info: ParsedVolcanoEruptionInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // 現象 — pushCard で recap 用サマリー
  const phenRole = phenomenonRole(info.phenomenonCode);
  const phenFn = getRoleChalk(phenRole);
  const cardContent = info.craterName
    ? ` ${phenFn(info.phenomenonName)}  ${chalk.gray(info.craterName)}`
    : ` ${phenFn(info.phenomenonName)}`;
  buf.pushCard(frameLine(level, cardContent, width));

  // 火口名
  if (info.craterName) {
    buf.push(frameLine(level, ` ${chalk.gray("火口:")} ${info.craterName}`, width));
  }

  // 噴煙高度・流向
  if (info.plumeHeight != null) {
    buf.push(frameLine(level, ` ${chalk.gray("噴煙:")} 火口上${info.plumeHeight}m`, width));
  } else if (info.plumeHeightUnknown) {
    buf.push(frameLine(level, ` ${chalk.gray("噴煙:")} 高度不明`, width));
  }
  if (info.plumeDirection) {
    buf.push(frameLine(level, ` ${chalk.gray("流向:")} ${info.plumeDirection}`, width));
  }

  // 本文
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const fullText = getInfoFullText();
    const maxLines = fullText ? 999 : 8;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }
}

function renderAshfall(info: ParsedVolcanoAshfallInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);

  // カード行 (recap 用 1行サマリー) — 全降灰Kindを表示
  {
    const totalAreas = info.ashForecasts.reduce((sum, p) => sum + p.areas.length, 0);
    // ashCode ごとに一意化し、重い順に全Kindを並べる
    const allAreas = info.ashForecasts.flatMap((p) => p.areas);
    const ashKinds = Array.from(
      new Map(
        [...allAreas]
          .sort((a, b) => (parseInt(b.ashCode, 10) || 0) - (parseInt(a.ashCode, 10) || 0))
          .map((a) => [a.ashCode, a])
      ).values()
    );
    const cardParts = ashKinds.map((a) => getRoleChalk(ashfallRole(a.ashCode))(a.ashName));
    cardParts.push(`${totalAreas}地域`);
    buf.push(frameDivider(level, width));
    buf.pushCard(frameLine(level, ` ${cardParts.join("  ")}`, width));
  }

  // 火口名
  if (info.craterName) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, ` ${chalk.gray("火口:")} ${info.craterName}`, width));
  }

  // 噴煙高度
  if (info.plumeHeight != null) {
    buf.push(frameLine(level, ` ${chalk.gray("噴煙:")} 火口上${info.plumeHeight}m`, width));
  }

  // 本文 (VolcanoActivity) — 降灰テーブルより先に表示
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const fullText = getInfoFullText();
    const maxLines = fullText ? 999
      : info.type === "VFVO55" ? 16
      : info.type === "VFVO54" ? 8
      : 10;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }

  // 降灰予報データ
  if (info.ashForecasts.length > 0) {
    buf.push(frameDivider(level, width));
    const maxPeriods = info.type === "VFVO54" ? 1 : 3;
    const periods = info.ashForecasts.slice(0, maxPeriods);

    // 幅80以上: renderFrameTable で表組み
    if (width >= 80) {
      const headers = ["時間帯", "地域", "降灰量"];
      const rows: string[][] = [];
      for (const period of periods) {
        const endStr = period.endTime ? formatTimestamp(period.endTime) : "";
        const sortedAreas = [...period.areas].sort((a, b) => {
          const codeA = parseInt(a.ashCode, 10) || 0;
          const codeB = parseInt(b.ashCode, 10) || 0;
          return codeB - codeA;
        });
        const maxAreas = info.type === "VFVO54" ? 5 : 3;
        const displayed = sortedAreas.slice(0, maxAreas);
        for (let i = 0; i < displayed.length; i++) {
          const area = displayed[i];
          rows.push([
            i === 0 ? `～${endStr}` : "",
            area.name,
            area.ashName,
          ]);
        }
        if (sortedAreas.length > maxAreas) {
          rows.push(["", chalk.gray(`他${sortedAreas.length - maxAreas}件`), ""]);
        }
      }
      renderFrameTable(level, headers, rows, width, buf);
    } else {
      // 狭幅: 時間帯ごとに frameDivider で区切り
      for (let pi = 0; pi < periods.length; pi++) {
        const period = periods[pi];
        if (pi > 0) buf.push(frameDivider(level, width));
        if (period.endTime) {
          const endStr = formatTimestamp(period.endTime);
          buf.push(frameLine(level, ` ${chalk.gray(`～${endStr}`)}`, width));
        }
        const sortedAreas = [...period.areas].sort((a, b) => {
          const codeA = parseInt(a.ashCode, 10) || 0;
          const codeB = parseInt(b.ashCode, 10) || 0;
          return codeB - codeA;
        });
        const maxAreas = info.type === "VFVO54" ? 5 : 3;
        const displayed = sortedAreas.slice(0, maxAreas);
        for (const area of displayed) {
          const ashRole = ashfallRole(area.ashCode);
          const ashFn = getRoleChalk(ashRole);
          buf.push(frameLine(level, `   ${ashFn(area.ashName)} ${area.name}`, width));
        }
        if (sortedAreas.length > maxAreas) {
          buf.push(frameLine(level, `   ${chalk.gray(`他${sortedAreas.length - maxAreas}件`)}`, width));
        }
      }
    }

    if (info.ashForecasts.length > maxPeriods) {
      buf.push(frameLine(level, ` ${chalk.gray(`(以降${info.ashForecasts.length - maxPeriods}時間帯省略)`)}`, width));
    }
  }
}

function renderText(info: ParsedVolcanoTextInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);

  // レベル (VFVO51)
  if (info.alertLevel != null) {
    buf.push(frameDivider(level, width));
    const role = levelRole(info.alertLevel);
    const colorFn = getRoleChalk(role);
    buf.push(frameLine(level, ` ${colorFn(`Lv${info.alertLevel}`)}`, width));
  }

  // 臨時バッジ（インライン表示）
  if (info.isExtraordinary) {
    const bannerFn = getRoleChalk("volcanoAlertBanner");
    buf.push(frameLine(level, ` ${bannerFn(" 臨時 ")}`, width));
  }

  // 本文 — getInfoFullText() で全文表示、デフォルトは8行まで
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const fullText = getInfoFullText();
    const maxLines = fullText ? 999 : 8;
    pushHighlightedBody(buf, level, info.bodyText, width, maxLines);
  }

  // NextAdvisory
  if (info.nextAdvisory) {
    buf.push(frameDivider(level, width));
    const naFn = getRoleChalk("nextAdvisory");
    buf.push(frameLine(level, ` ${naFn(info.nextAdvisory)}`, width));
  }
}

function renderPlume(info: ParsedVolcanoPlumeInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // 現象 — pushCard で recap 用サマリー
  if (info.phenomenonCode) {
    const phenRole = phenomenonRole(info.phenomenonCode);
    const phenFn = getRoleChalk(phenRole);
    const phenNames: Record<string, string> = {
      "51": "爆発", "52": "噴火", "56": "噴火多発", "62": "噴火したもよう",
    };
    const name = phenNames[info.phenomenonCode] ?? info.phenomenonCode;
    const cardParts = [phenFn(name)];
    if (info.plumeHeight != null) cardParts.push(`${info.plumeHeight}m`);
    if (info.plumeDirection) cardParts.push(info.plumeDirection);
    buf.pushCard(frameLine(level, ` ${cardParts.join("  ")}`, width));
  }

  // 火口名
  if (info.craterName) {
    buf.push(frameLine(level, ` ${chalk.gray("火口:")} ${info.craterName}`, width));
  }

  // 噴煙高度・流向
  if (info.plumeHeight != null) {
    buf.push(frameLine(level, ` ${chalk.gray("噴煙:")} 火口上${info.plumeHeight}m`, width));
  }
  if (info.plumeDirection) {
    buf.push(frameLine(level, ` ${chalk.gray("流向:")} ${info.plumeDirection}`, width));
  }

  // 風向データ — renderFrameTable で表組み
  if (info.windProfile.length > 0) {
    buf.push(frameDivider(level, width));
    const headers = ["高度", "風向(°)", "風速"];
    // 代表高度を間引き (最大5行)
    const step = Math.max(1, Math.floor(info.windProfile.length / 5));
    const sampled = info.windProfile.filter((_, i) => i % step === 0).slice(0, 5);
    const rows = sampled.map((wp) => [
      wp.altitude,
      wp.degree != null ? `${wp.degree}°` : "—",
      wp.speed != null ? `${wp.speed}kt` : "—",
    ]);
    renderFrameTable(level, headers, rows, width, buf);
  }
}

// ── 取消報 ──

function renderCancel(info: ParsedVolcanoInfo, width: number, buf: RenderBuffer): void {
  const level: FrameLevel = "cancel";
  buf.push(frameTop(level, width));
  buf.pushTitle(frameLine(level, ` ${SEVERITY_LABELS[level]} ${info.title}`, width));
  buf.push(frameLine(level, ` ${info.volcanoName}  ${chalk.gray(formatTimestamp(info.reportDateTime))}`, width));
  buf.push(frameDivider(level, width));
  const cancelFn = getRoleChalk("cancelText");
  buf.push(frameLine(level, ` ${cancelFn("この情報は取り消されました")}`, width));
}

// ── 公開 API ──

/** 火山電文の表示 */
export function displayVolcanoInfo(
  info: ParsedVolcanoInfo,
  presentation: VolcanoPresentation,
): void {
  const width = getFrameWidth();
  const level = presentation.frameLevel;

  // コンパクトモード: 1行サマリー
  if (getDisplayMode() === "compact") {
    const parts: string[] = [SEVERITY_LABELS[level], volcanoTypeLabel(info.type), info.volcanoName];
    switch (info.kind) {
      case "alert":
        if (info.alertLevel != null) parts.push(`Lv${info.alertLevel} ${actionLabel(info.action)}`);
        break;
      case "eruption":
        parts.push(info.phenomenonName);
        break;
      case "ashfall":
        parts.push(`${info.ashForecasts.flatMap((p) => p.areas).length}地域`);
        break;
      case "text":
        if (info.headline) parts.push(info.headline.slice(0, 30));
        break;
      case "plume":
        if (info.plumeHeight != null) parts.push(`${info.plumeHeight}m`);
        if (info.plumeDirection) parts.push(info.plumeDirection);
        break;
    }
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  const renderBuf = createRenderBuffer();

  // 前方空行
  renderBuf.pushEmpty();

  // フレーム外バナー（EEW/津波方式に統一）
  const banner = getVolcanoBannerSpec(info, level);
  if (banner != null) {
    pushFullWidthBanner(renderBuf, getRoleChalk(banner.role), banner.text, width);
  }

  if (info.infoType === "取消") {
    renderCancel(info, width, renderBuf);
  } else {
    switch (info.kind) {
      case "alert":
        renderAlert(info, level, width, renderBuf);
        break;
      case "eruption":
        renderEruption(info, level, width, renderBuf);
        break;
      case "ashfall":
        renderAshfall(info, level, width, renderBuf);
        break;
      case "text":
        renderText(info, level, width, renderBuf);
        break;
      case "plume":
        renderPlume(info, level, width, renderBuf);
        break;
    }
  }

  // 共通フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, renderBuf);
  renderBuf.push(frameBottom(level, width));
  renderBuf.pushEmpty();

  flushWithRecap(renderBuf, level, width);
}
