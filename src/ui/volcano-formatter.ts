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
  createRenderBuffer,
  flushWithRecap,
  getFrameWidth,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  formatTimestamp,
  wrapFrameLines,
} from "./formatter";
import { getRoleChalk, RoleName } from "./theme";
import { VolcanoPresentation } from "../engine/notification/volcano-presentation";

// ── ヘルパー ──

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

// ── 共通ヘッダー ──

function renderVolcanoHeader(
  info: ParsedVolcanoInfo,
  level: FrameLevel,
  width: number,
  buf: RenderBuffer,
): void {
  buf.push(frameTop(level, width));

  // タイトル行
  const titleLine = info.isTest
    ? `${getRoleChalk("testBadge")(" TEST ")} ${info.title}`
    : info.title;
  buf.push(frameLine(level, ` ${titleLine}`, width));

  // 火山名・日時
  const volcanoLabel = info.volcanoName || "(不明)";
  const timeStr = formatTimestamp(info.reportDateTime);
  buf.push(frameLine(level, ` ${volcanoLabel}  ${chalk.gray(timeStr)}`, width));

  // ヘッドライン
  if (info.headline) {
    buf.push(frameDivider(level, width));
    pushWrapped(buf, level, ` ${info.headline}`, width);
  }
}

// ── 電文タイプ別レンダラ ──

function renderAlert(info: ParsedVolcanoAlertInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // レベル・アクション
  if (info.alertLevel != null) {
    const role = levelRole(info.alertLevel);
    const colorFn = getRoleChalk(role);
    const actionStr = actionLabel(info.action);
    buf.push(frameLine(level, ` ${colorFn(`Lv${info.alertLevel}`)} ${info.warningKind}  (${actionStr})`, width));
  } else if (info.isMarine) {
    buf.push(frameLine(level, ` ${info.warningKind}  (${actionLabel(info.action)})`, width));
  }

  // 前回レベル
  if (info.previousLevelCode && info.action === "raise") {
    const prevLevel = levelCodeToDisplay(info.previousLevelCode);
    buf.push(frameLine(level, ` ${chalk.gray(`前回: ${prevLevel}`)}`, width));
  }

  // 対象市町村
  if (info.municipalities.length > 0) {
    buf.push(frameDivider(level, width));
    const muniNames = info.municipalities.map((m) => m.name);
    const muniLine = muniNames.slice(0, 6).join(", ");
    const suffix = muniNames.length > 6 ? ` 他${muniNames.length - 6}件` : "";
    pushWrapped(buf, level, ` ${chalk.gray("対象:")} ${muniLine}${suffix}`, width);
  }

  // 本文 (VolcanoActivity)
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const text = info.bodyText.slice(0, 300);
    pushWrapped(buf, level, ` ${text}`, width);
  }

  buf.push(frameBottom(level, width));
}

function renderEruption(info: ParsedVolcanoEruptionInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // 噴火速報バナー
  if (info.isFlashReport) {
    const bannerFn = getRoleChalk("volcanoFlashBanner");
    buf.push(frameLine(level, ` ${bannerFn(" 噴火速報 ")}`, width));
  }

  // 現象
  const phenRole = phenomenonRole(info.phenomenonCode);
  const phenFn = getRoleChalk(phenRole);
  buf.push(frameLine(level, ` ${phenFn(info.phenomenonName)}`, width));

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
    const text = info.bodyText.slice(0, 300);
    pushWrapped(buf, level, ` ${text}`, width);
  }

  buf.push(frameBottom(level, width));
}

function renderAshfall(info: ParsedVolcanoAshfallInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);

  // 火口名
  if (info.craterName) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, ` ${chalk.gray("火口:")} ${info.craterName}`, width));
  }

  // 噴煙高度
  if (info.plumeHeight != null) {
    buf.push(frameLine(level, ` ${chalk.gray("噴煙:")} 火口上${info.plumeHeight}m`, width));
  }

  // 降灰予報データ
  if (info.ashForecasts.length > 0) {
    buf.push(frameDivider(level, width));
    const maxPeriods = info.type === "VFVO54" ? 1 : 3;
    const periods = info.ashForecasts.slice(0, maxPeriods);
    for (const period of periods) {
      if (period.endTime) {
        const endStr = formatTimestamp(period.endTime);
        buf.push(frameLine(level, ` ${chalk.gray(`～${endStr}`)}`, width));
      }
      // 降灰量の優先順にソート (75噴石 > 73多量 > 72やや多量 > 71少量)
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
    if (info.ashForecasts.length > maxPeriods) {
      buf.push(frameLine(level, ` ${chalk.gray(`(以降${info.ashForecasts.length - maxPeriods}時間帯省略)`)}`, width));
    }
  }

  // 本文
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const text = info.bodyText.slice(0, 200);
    pushWrapped(buf, level, ` ${text}`, width);
  }

  buf.push(frameBottom(level, width));
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

  // 臨時バッジ
  if (info.isExtraordinary) {
    const bannerFn = getRoleChalk("volcanoAlertBanner");
    buf.push(frameLine(level, ` ${bannerFn(" 臨時 ")}`, width));
  }

  // 本文
  if (info.bodyText) {
    buf.push(frameDivider(level, width));
    const text = info.bodyText.slice(0, 400);
    const wrapped = wrapFrameLines(level, ` ${text}`, width);
    const maxLines = 4;
    const lines = wrapped.slice(0, maxLines);
    for (const line of lines) {
      buf.push(line);
    }
    if (wrapped.length > maxLines) {
      buf.push(frameLine(level, ` ${chalk.gray(`(以下省略、全${wrapped.length}行)`)}`, width));
    }
  }

  // NextAdvisory
  if (info.nextAdvisory) {
    buf.push(frameDivider(level, width));
    const naFn = getRoleChalk("nextAdvisory");
    buf.push(frameLine(level, ` ${naFn(info.nextAdvisory)}`, width));
  }

  buf.push(frameBottom(level, width));
}

function renderPlume(info: ParsedVolcanoPlumeInfo, level: FrameLevel, width: number, buf: RenderBuffer): void {
  renderVolcanoHeader(info, level, width, buf);
  buf.push(frameDivider(level, width));

  // 現象
  if (info.phenomenonCode) {
    const phenRole = phenomenonRole(info.phenomenonCode);
    const phenFn = getRoleChalk(phenRole);
    const phenNames: Record<string, string> = {
      "51": "爆発", "52": "噴火", "56": "噴火多発", "62": "噴火したもよう",
    };
    const name = phenNames[info.phenomenonCode] ?? info.phenomenonCode;
    buf.push(frameLine(level, ` ${phenFn(name)}`, width));
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

  // 風向データ要約
  if (info.windProfile.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, ` ${chalk.gray("風向:")}`, width));
    const step = Math.max(1, Math.floor(info.windProfile.length / 3));
    for (let i = 0; i < info.windProfile.length; i += step) {
      const wp = info.windProfile[i];
      const degStr = wp.degree != null ? `${wp.degree}°` : "—";
      const spdStr = wp.speed != null ? `${wp.speed}kt` : "—";
      buf.push(frameLine(level, `   ${wp.altitude}  ${degStr}  ${spdStr}`, width));
      if (i / step >= 4) break;
    }
  }

  buf.push(frameBottom(level, width));
}

// ── 取消報 ──

function renderCancel(info: ParsedVolcanoInfo, width: number, buf: RenderBuffer): void {
  const level: FrameLevel = "cancel";
  buf.push(frameTop(level, width));
  buf.push(frameLine(level, ` [取消] ${info.title}`, width));
  buf.push(frameLine(level, ` ${info.volcanoName}  ${chalk.gray(formatTimestamp(info.reportDateTime))}`, width));
  buf.push(frameDivider(level, width));
  const cancelFn = getRoleChalk("cancelText");
  buf.push(frameLine(level, ` ${cancelFn("この情報は取り消されました")}`, width));
  buf.push(frameBottom(level, width));
}

// ── 公開 API ──

/** 火山電文の表示 */
export function displayVolcanoInfo(
  info: ParsedVolcanoInfo,
  presentation: VolcanoPresentation,
): void {
  const width = getFrameWidth();
  const level = presentation.frameLevel;
  const renderBuf = createRenderBuffer();

  if (info.infoType === "取消") {
    renderCancel(info, width, renderBuf);
    flushWithRecap(renderBuf, level, width);
    return;
  }

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

  flushWithRecap(renderBuf, level, width);
}
