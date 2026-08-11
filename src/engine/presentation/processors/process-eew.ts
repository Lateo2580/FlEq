import type { ParsedEewInfo, WsDataMessage } from "../../../types";
import type { EewOutcome } from "../types";
import { parseEewTelegram } from "../../../dmdata/telegram-parser";
import {
  getMaxForecastIntensityEvaluation,
  type EewTracker,
  type EewUpdateResult,
} from "../../eew/eew-tracker";
import type { EewEventLogger } from "../../eew/eew-logger";
import type { DeliveryCapabilities } from "../../../dmdata/delivery-capabilities";
import { eewFrameLevel, eewSoundLevel } from "../level-helpers";
import * as log from "../../../logger";

/** processEew の戻り値 */
export type EewProcessResult =
  | { kind: "ok"; outcome: EewOutcome }
  | { kind: "duplicate" }
  | { kind: "suppressed" }
  | { kind: "parse-failed" };

export type Vxse44SuppressionReason = "observed-vxse45" | "capability";

export interface ProcessEewOptions {
  getDeliveryCapabilities?: () => DeliveryCapabilities;
  onVxse44Suppressed?: (reason: Vxse44SuppressionReason) => void;
}

function eewOutcome(
  msg: WsDataMessage,
  eewInfo: ParsedEewInfo,
  result: EewUpdateResult,
  options?: {
    shouldRecord?: boolean;
    displayLifecycleOnly?: boolean;
  },
): EewOutcome {
  return {
    domain: "eew",
    ...(options?.displayLifecycleOnly === true ? { displayLifecycleOnly: true as const } : {}),
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
      shouldRecord: options?.shouldRecord ?? true,
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
  options?: ProcessEewOptions,
): EewProcessResult {
  const eewInfo = parseEewTelegram(msg);
  if (!eewInfo) return { kind: "parse-failed" };
  const eventId = eewInfo.meta.eventId.valid
    ? eewInfo.meta.eventId.value
    : null;

  // 実受信 VXSE45 の相関を最優先し、それがない場合だけ capability を読む。
  const suppressedByObservedVxse45 = msg.head.type === "VXSE44"
    && eewTracker.hasSeen45(eewInfo);
  const suppressedByCapability = msg.head.type === "VXSE44"
    && !suppressedByObservedVxse45
    && (() => {
      const capability = options?.getDeliveryCapabilities?.();
      return capability?.connected === true
        && capability.guaranteedHeadTypes.has("VXSE45");
    })();

  if (suppressedByObservedVxse45 || suppressedByCapability) {
    const revisionDecision = eewTracker.acceptSuppressed(eewInfo);
    if (!revisionDecision.accepted) {
      log.debug(
        `EEW revision gate 拒否 (VXSE44): EventID=${eewInfo.eventId} 第${eewInfo.serial}報 reason=${revisionDecision.kind}`,
      );
      return { kind: "duplicate" };
    }
    const suppressionReason: Vxse44SuppressionReason = suppressedByObservedVxse45
      ? "observed-vxse45"
      : "capability";
    options?.onVxse44Suppressed?.(suppressionReason);
    log.debug(`EEW 抑制 (${suppressionReason}): type=${eewInfo.type} EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    // 終端処理: tracker.update() を経由しないため、取消/最終報のいずれでも
    // finalizeEvent() を呼び、既存イベントを active カウントから外す
    const isTerminal = eewInfo.infoType === "取消" || eewInfo.nextAdvisory != null;
    const lifecycleReplacement = eventId != null
      ? eewTracker.replaceLifecycle(eewInfo, revisionDecision)
      : null;
    if (eventId != null) {
      if (eewInfo.infoType === "取消") {
        eewLogger.closeEvent(eventId, "取消");
        eewTracker.finalizeEvent(eventId);
      } else if (eewInfo.nextAdvisory) {
        eewLogger.closeEvent(eventId, "最終報");
        eewTracker.finalizeEvent(eventId);
      }
    }
    if (isTerminal) {
      const currentForecastIntensity = getMaxForecastIntensityEvaluation(eewInfo.forecastIntensity);
      const result: EewUpdateResult = {
        isNew: false,
        firstReportSignal: false,
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
      return {
        kind: "ok",
        outcome: eewOutcome(msg, eewInfo, result, {
          shouldRecord: false,
          displayLifecycleOnly: true,
        }),
      };
    }
    if (lifecycleReplacement?.reactivated && lifecycleReplacement.authoritativeSnapshot != null) {
      const { info: authoritativeInfo, message: authoritativeMessage } =
        lifecycleReplacement.authoritativeSnapshot;
      const currentForecastIntensity = getMaxForecastIntensityEvaluation(
        authoritativeInfo.forecastIntensity,
      );
      const result: EewUpdateResult = {
        isNew: false,
        firstReportSignal: false,
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
      return {
        kind: "ok",
        outcome: eewOutcome(authoritativeMessage, authoritativeInfo, result, {
          shouldRecord: false,
          displayLifecycleOnly: true,
        }),
      };
    }
    return { kind: "suppressed" };
  }

  const result = eewTracker.update(eewInfo, msg);
  if (result.isDuplicate) {
    log.debug(`EEW 重複報スキップ: EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    return { kind: "duplicate" };
  }

  if (result.isSuppressed) {
    log.debug(`EEW 抑制 (VXSE45優先): type=${eewInfo.type} EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    eewLogger.logReport(eewInfo, result);
    // 抑制されても終端処理は実行する
    if (result.isCancelled && eventId != null) {
      eewLogger.closeEvent(eventId, "取消");
    }
    if (eewInfo.nextAdvisory && eventId != null && !result.isCancelled) {
      eewLogger.closeEvent(eventId, "最終報");
      eewTracker.finalizeEvent(eventId);
    }
    if (
      msg.head.type === "VXSE44"
      && (result.isCancelled || eewInfo.nextAdvisory != null)
    ) {
      return {
        kind: "ok",
        outcome: eewOutcome(msg, eewInfo, result, {
          shouldRecord: false,
          displayLifecycleOnly: true,
        }),
      };
    }
    return { kind: "suppressed" };
  }

  // ログ記録
  eewLogger.logReport(eewInfo, result);
  if (result.isCancelled && eventId != null) {
    eewLogger.closeEvent(eventId, "取消");
  }
  if (eewInfo.nextAdvisory && eventId != null && !result.isCancelled) {
    eewLogger.closeEvent(eventId, "最終報");
    eewTracker.finalizeEvent(eventId);
  }

  return { kind: "ok", outcome: eewOutcome(msg, eewInfo, result) };
}
