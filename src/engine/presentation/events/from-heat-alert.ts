import type {
  HeatAlertOutcome,
  PresentationEvent,
  PresentationAreaItem,
} from "../types";
import { presentationTelegramMeta } from "./presentation-meta";
// extractLeadSentence は parser (heat-alert-parser.ts) に残す判断:
// presentation 層 (本ファイルの表示 headline 合成) と notification 層
// (notifier の通知 body 合成) の両方から使う共通ロジックのため、
// 両者より下層の parser 段が最小公倍数の置き場になる。
import { extractLeadSentence } from "../../../dmdata/heat-alert-parser";

/** HeatAlertOutcome → PresentationEvent */
export function fromHeatAlertOutcome(
  outcome: HeatAlertOutcome,
): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  const info = outcome.parsed;

  // 対象府県 (Title 由来)。regionFromEvent が areaNames 系しか見ないため、
  // ここに流さないと探索クラスタの region が unknown に落ちる (Codex R1 P0)
  // code は不明のため省略 (PresentationAreaItem.code は optional。空文字は入れない)
  const areaItems: PresentationAreaItem[] = info.targetAreaName
    ? [{ name: info.targetAreaName, kind: "対象府県" }]
    : [];
  const areaNames = areaItems.map((a) => a.name);

  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? info.infoType,
    title: xmlReport?.head.title ?? info.title,
    controlTitle: info.controlTitle,
    // PresentationEvent 用の表示 headline: 実 XML の Headline.Text は空のため
    // Comment 本文の先頭文を合成する (parser 側 headline は実 XML どおり null 保持)
    headline: info.headline ?? extractLeadSentence(info.bodyText),
    reportDateTime: xmlReport?.head.reportDateTime ?? info.reportDateTime,
    publishingOffice:
      xmlReport?.control.publishingOffice ?? info.publishingOffice,
    isTest: presentationTelegramMeta(outcome.msg).isTest,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,

    isCancellation: info.infoType === "取消",
    // 安全側昇格 (題名昇格 critical) が event 出口で潰れないよう frameLevel 基準
    isWarning:
      outcome.presentation.frameLevel === "warning" ||
      outcome.presentation.frameLevel === "critical",

    eventId: xmlReport?.head.eventId ?? info.eventId,
    serial: info.serial,

    bodyText: info.bodyText,

    areaNames,
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: areaNames.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,

    raw: info,
  };
}
