import {
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoAshfallInfo,
} from "../../types";
import { FrameLevel } from "../../ui/formatter";
import { SoundLevel } from "./sound-player";
import { VolcanoStateHolder } from "../messages/volcano-state";

/** 表示・通知判定の結果 */
export interface VolcanoPresentation {
  frameLevel: FrameLevel;
  soundLevel: SoundLevel;
  summary: string;
}

/** 火山電文の表示レベル・通知レベル・通知要約を判定する */
export function resolveVolcanoPresentation(
  info: ParsedVolcanoInfo,
  volcanoState: VolcanoStateHolder,
): VolcanoPresentation {
  // 全種別共通: 取消
  if (info.infoType === "取消") {
    return {
      frameLevel: "cancel",
      soundLevel: "cancel",
      summary: "この情報は取り消されました",
    };
  }

  switch (info.kind) {
    case "eruption":
      return resolveEruption(info);
    case "alert":
      return resolveAlert(info, volcanoState);
    case "ashfall":
      return resolveAshfall(info);
    case "text":
      return resolveText(info);
    case "plume":
      return resolvePlume(info);
  }
}

// ── 個別判定 ──

function resolveEruption(info: ParsedVolcanoEruptionInfo): VolcanoPresentation {
  const summary = buildEruptionSummary(info);

  // VFVO56: 噴火速報 → critical
  if (info.isFlashReport) {
    return { frameLevel: "critical", soundLevel: "critical", summary };
  }

  // VFVO52: 爆発(51) / 噴火多発(56) or 噴煙 ≥ 3000m → warning
  if (
    info.phenomenonCode === "51" ||
    info.phenomenonCode === "56" ||
    (info.plumeHeight != null && info.plumeHeight >= 3000)
  ) {
    return { frameLevel: "warning", soundLevel: "normal", summary };
  }

  // 噴火(52) / 噴火したもよう(62) 軽微
  return { frameLevel: "normal", soundLevel: "info", summary };
}

function resolveAlert(
  info: ParsedVolcanoAlertInfo,
  volcanoState: VolcanoStateHolder,
): VolcanoPresentation {
  const summary = buildAlertSummary(info);

  // 海上警報 (VFSVii)
  if (info.isMarine) {
    // Code 31 = 海上警報
    if (info.alertLevelCode === "31" || info.alertLevelCode === "36") {
      return { frameLevel: "warning", soundLevel: "warning", summary };
    }
    // Code 33 = 海上予報
    return { frameLevel: "normal", soundLevel: "normal", summary };
  }

  // 引下げ・解除
  if (info.action === "lower" || info.action === "release") {
    return { frameLevel: "normal", soundLevel: "normal", summary };
  }

  const level = info.alertLevel ?? 0;
  const isRenotification = volcanoState.isRenotification(info);

  // 引上げ
  if (info.action === "raise" || info.action === "issue") {
    if (level >= 4) {
      return { frameLevel: "critical", soundLevel: "critical", summary };
    }
    if (level >= 2) {
      return { frameLevel: "warning", soundLevel: "warning", summary };
    }
    return { frameLevel: "normal", soundLevel: "normal", summary };
  }

  // 継続
  if (level >= 4) {
    return {
      frameLevel: isRenotification ? "warning" : "critical",
      soundLevel: "normal",
      summary,
    };
  }
  if (level >= 2) {
    return {
      frameLevel: isRenotification ? "normal" : "warning",
      soundLevel: isRenotification ? "info" : "normal",
      summary,
    };
  }
  // レベル1継続
  return { frameLevel: "normal", soundLevel: "info", summary };
}

function resolveAshfall(info: ParsedVolcanoAshfallInfo): VolcanoPresentation {
  const summary = buildAshfallSummary(info);

  switch (info.type) {
    case "VFVO54": // 降灰速報
      return { frameLevel: "warning", soundLevel: "warning", summary };
    case "VFVO55": // 降灰詳細
      return { frameLevel: "normal", soundLevel: "normal", summary };
    case "VFVO53": // 降灰定時
      return { frameLevel: "info", soundLevel: "info", summary };
  }
}

function resolveText(info: ParsedVolcanoInfo): VolcanoPresentation {
  if (info.kind !== "text") {
    return { frameLevel: "info", soundLevel: "info", summary: info.title };
  }

  const summary = info.headline ?? info.title;

  // VFVO51 臨時
  if (info.isExtraordinary) {
    return { frameLevel: "warning", soundLevel: "normal", summary };
  }

  // 通常
  return { frameLevel: "info", soundLevel: "info", summary };
}

function resolvePlume(info: ParsedVolcanoInfo): VolcanoPresentation {
  const summary = `${info.volcanoName} 推定噴煙流向報`;
  return { frameLevel: "normal", soundLevel: "info", summary };
}

// ── 要約テキスト生成 ──

function buildAlertSummary(info: ParsedVolcanoAlertInfo): string {
  const parts: string[] = [info.volcanoName];
  if (info.alertLevel != null) {
    parts.push(`Lv${info.alertLevel}`);
  }
  parts.push(info.warningKind);
  return parts.join(" / ");
}

function buildEruptionSummary(info: ParsedVolcanoEruptionInfo): string {
  const parts: string[] = [info.volcanoName, info.phenomenonName];
  if (info.plumeHeight != null) {
    parts.push(`噴煙${info.plumeHeight}m`);
  } else if (info.plumeHeightUnknown) {
    parts.push("噴煙高度不明");
  }
  return parts.join(" / ");
}

function buildAshfallSummary(info: ParsedVolcanoAshfallInfo): string {
  const parts: string[] = [info.volcanoName];
  const subKindLabel = {
    scheduled: "定時",
    rapid: "速報",
    detailed: "詳細",
  }[info.subKind];
  parts.push(`降灰予報（${subKindLabel}）`);
  // 最初の時間帯の最も深刻なエリアを追加
  if (info.ashForecasts.length > 0 && info.ashForecasts[0].areas.length > 0) {
    const topArea = info.ashForecasts[0].areas[0];
    parts.push(topArea.ashName);
  }
  return parts.join(" / ");
}
