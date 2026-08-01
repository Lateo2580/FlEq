import type { ParsedEewInfo, WsDataMessage } from "../../../types";
import type { EewOutcome } from "../types";
import { parseEewTelegram } from "../../../dmdata/telegram-parser";
import {
  getMaxForecastIntensityEvaluation,
  type EewTracker,
  type EewUpdateResult,
} from "../../eew/eew-tracker";
import type { EewEventLogger } from "../../eew/eew-logger";
import { eewFrameLevel, eewSoundLevel } from "../level-helpers";
import * as log from "../../../logger";

/** processEew の戻り値 */
export type EewProcessResult =
  | { kind: "ok"; outcome: EewOutcome }
  | { kind: "duplicate" }
  | { kind: "suppressed" }
  | { kind: "parse-failed" };

function eewOutcome(
  msg: WsDataMessage,
  eewInfo: ParsedEewInfo,
  result: EewUpdateResult,
  shouldRecord = true,
): EewOutcome {
  return {
    domain: "eew",
    msg,
    headType: eewInfo.type,
    statsCategory: "eew",
    parsed: eewInfo,
    state: {
      activeCount: result.activeCount,
      colorIndex: result.colorIndex,
      isCancelled: result.isCancelled,
      diff: result.diff,
    },
    eewResult: result,
    stats: {
      shouldRecord,
      eventId: eewInfo.eventId,
    },
    presentation: {
      frameLevel: eewFrameLevel(eewInfo),
      soundLevel: eewSoundLevel(eewInfo),
      notifyCategory: "eew",
    },
  };
}

/**
 * EEW 電文を処理し結果を返す。
 * - パース失敗: { kind: "parse-failed" }
 * - 重複報: { kind: "duplicate" }
 * - 正常: { kind: "ok", outcome }
 */
export function processEew(
  msg: WsDataMessage,
  eewTracker: EewTracker,
  eewLogger: EewEventLogger,
): EewProcessResult {
  const eewInfo = parseEewTelegram(msg);
  if (!eewInfo) return { kind: "parse-failed" };

  // VXSE44 は VXSE45 と重複するため常時抑制 (VXSE44 は配信終了予定)。
  // ここで EewTracker への登録もスキップしないと、後続 VXSE45 が
  // isNew=false になり「第1報通知（音含む）」が発火しないため、
  // update() を呼ばずに早期 return する。終端処理は eventId を使って
  // 直接実行する（既存イベントがなければ no-op）。
  if (msg.head.type === "VXSE44") {
    const revisionDecision = eewTracker.acceptSuppressed(eewInfo);
    if (!revisionDecision.accepted) {
      log.debug(
        `EEW revision gate 拒否 (VXSE44): EventID=${eewInfo.eventId} 第${eewInfo.serial}報 reason=${revisionDecision.kind}`,
      );
      return { kind: "duplicate" };
    }
    log.debug(`EEW 抑制 (VXSE44常時抑制): type=${eewInfo.type} EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    // 終端処理: tracker.update() を経由しないため、取消/最終報のいずれでも
    // finalizeEvent() を呼び、既存イベントを active カウントから外す
    const isTerminal = eewInfo.infoType === "取消" || eewInfo.nextAdvisory != null;
    const lifecycleReplacement = eewInfo.eventId
      ? eewTracker.replaceLifecycle(eewInfo, revisionDecision)
      : null;
    if (eewInfo.eventId) {
      if (eewInfo.infoType === "取消") {
        eewLogger.closeEvent(eewInfo.eventId, "取消");
        eewTracker.finalizeEvent(eewInfo.eventId);
      } else if (eewInfo.nextAdvisory) {
        eewLogger.closeEvent(eewInfo.eventId, "最終報");
        eewTracker.finalizeEvent(eewInfo.eventId);
      }
    }
    if (isTerminal) {
      const currentForecastIntensity = getMaxForecastIntensityEvaluation(eewInfo.forecastIntensity);
      const result: EewUpdateResult = {
        isNew: false,
        isDuplicate: false,
        isCorrection: revisionDecision.isCorrection,
        revisionDecision: revisionDecision.kind,
        isCancelled: eewInfo.infoType === "取消",
        isSuppressed: true,
        isUpgradeToWarning: false,
        activeCount: eewTracker.getActiveCount(),
        colorIndex: 0,
        ...(currentForecastIntensity != null ? { currentForecastIntensity } : {}),
        ...(currentForecastIntensity?.safetyRank != null
          ? { effectiveForecastSafetyRank: currentForecastIntensity.safetyRank }
          : {}),
      };
      // 通知・統計は抑止したまま、display lifecycle command だけを pipeline へ通す。
      return { kind: "ok", outcome: eewOutcome(msg, eewInfo, result, false) };
    }
    if (lifecycleReplacement?.reactivated && lifecycleReplacement.authoritativeInfo != null) {
      const authoritativeInfo = lifecycleReplacement.authoritativeInfo;
      const currentForecastIntensity = getMaxForecastIntensityEvaluation(
        authoritativeInfo.forecastIntensity,
      );
      const result: EewUpdateResult = {
        isNew: false,
        isDuplicate: false,
        isCorrection: revisionDecision.isCorrection,
        revisionDecision: revisionDecision.kind,
        isCancelled: false,
        // VXSE44 自体は通知・統計対象に戻さず、display 再投影だけを通す。
        isSuppressed: true,
        isUpgradeToWarning: false,
        activeCount: eewTracker.getActiveCount(),
        colorIndex: lifecycleReplacement.colorIndex,
        displayRestoreRevision: {
          sourceType: eewInfo.type,
          serial: eewInfo.serial ?? null,
          isCorrection: revisionDecision.isCorrection,
        },
        ...(currentForecastIntensity != null ? { currentForecastIntensity } : {}),
        ...(lifecycleReplacement.effectiveForecastSafetyRank != null
          ? { effectiveForecastSafetyRank: lifecycleReplacement.effectiveForecastSafetyRank }
          : {}),
      };
      return { kind: "ok", outcome: eewOutcome(msg, authoritativeInfo, result, false) };
    }
    return { kind: "suppressed" };
  }

  const result = eewTracker.update(eewInfo);
  if (result.isDuplicate) {
    log.debug(`EEW 重複報スキップ: EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    return { kind: "duplicate" };
  }

  if (result.isSuppressed) {
    log.debug(`EEW 抑制 (VXSE45優先): type=${eewInfo.type} EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    eewLogger.logReport(eewInfo, result);
    // 抑制されても終端処理は実行する
    if (result.isCancelled && eewInfo.eventId) {
      eewLogger.closeEvent(eewInfo.eventId, "取消");
    }
    if (eewInfo.nextAdvisory && eewInfo.eventId && !result.isCancelled) {
      eewLogger.closeEvent(eewInfo.eventId, "最終報");
      eewTracker.finalizeEvent(eewInfo.eventId);
    }
    return { kind: "suppressed" };
  }

  // ログ記録
  eewLogger.logReport(eewInfo, result);
  if (result.isCancelled && eewInfo.eventId) {
    eewLogger.closeEvent(eewInfo.eventId, "取消");
  }
  if (eewInfo.nextAdvisory && eewInfo.eventId && !result.isCancelled) {
    eewLogger.closeEvent(eewInfo.eventId, "最終報");
    eewTracker.finalizeEvent(eewInfo.eventId);
  }

  return { kind: "ok", outcome: eewOutcome(msg, eewInfo, result) };
}
