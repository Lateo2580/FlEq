import type { WsDataMessage } from "../../../types";
import type { SuppressibleProcessResult, WeatherOutcome } from "../types";
import { parseWeatherWarning } from "../../../dmdata/weather-parser";
import { weatherFrameLevel, weatherSoundLevel } from "../level-helpers";
import type { ProcessDeps } from "./process-message";
import * as log from "../../../logger";
import type { WeatherReportIdentity } from "../../messages/vpws50-state";
import { VPWS50_REVISION_FAMILY_POLICY } from "../../messages/revision-family-registry";
import { semanticPayloadFingerprint } from "../../messages/telegram-revision-gate";

const VPWS50_TYPES = new Set(["VPWS50"]);

/** processWeather の戻り値。抑制とパース失敗を呼び出し側で区別する。 */
export type WeatherProcessResult = SuppressibleProcessResult<WeatherOutcome>;

/**
 * 気象警報・注意報電文 (VPWW55-61, VPWS50) を処理し WeatherOutcome を返す。
 * パース失敗は parse-failed、単調性ガードで棄却した報は suppressed を返す。
 *
 * VPWS50 のときのみ、deps.vpws50State で差分計算を行い presentation.weatherDiff に乗せる。
 *   - 取消 (rollback): frameLevel/soundLevel = "cancel"
 *   - unsafe (layer_missing / abnormal_release_rate): frameLevel/soundLevel = "warning"
 *   - isUnchanged かつ !shouldRecap: frameLevel/soundLevel = "info" (静音化)
 *   - その他: 通常の severity ベース判定 (weatherFrameLevel / weatherSoundLevel)
 *
 * VPWW56 (土砂災害警戒情報) も deps.vpww56State の単調性ガードを通す
 * (正常報の frame/sound には影響しない)。
 */
export function processWeather(
  msg: WsDataMessage,
  deps?: Pick<ProcessDeps, "vpws50State" | "vpww56State" | "revisionGate" | "onRevisionDecision" | "onVpws50RevisionDecision">,
): WeatherProcessResult {
  const info = parseWeatherWarning(msg);
  if (!info) return { kind: "parse-failed" };

  const identity: WeatherReportIdentity = {
    reportDateTime: info.reportDateTime,
    serial: msg.xmlReport?.head.serial ?? null,
  };

  let weatherDiff: WeatherOutcome["presentation"]["weatherDiff"] = undefined;
  let acceptedCorrection = false;
  // 色専用の集約 severity。frameLevel は静音化 (isUnchanged → info 降格) や unsafe 昇格で
  // 変動するが、テロップ色は「現在の全国集約の最大 severity」で安定させたいので、この降格・
  // 昇格の巻き添えを受けない値を別に保持して下流 (from-weather → summaryRole) へ運ぶ。
  const displaySeverity = weatherFrameLevel(info);
  let frameLevel = displaySeverity;
  let soundLevel = weatherSoundLevel(info);

  if (VPWS50_TYPES.has(msg.head.type) && deps?.vpws50State != null) {
    const messageId = msg.xmlReport?.head.eventId
                   ?? msg.xmlReport?.head.reportDateTime
                   ?? "";

    const policy = VPWS50_REVISION_FAMILY_POLICY;
    const stateSubjectKey = policy.extractStateSubjectKey(info.meta, info);
    const subject = typeof stateSubjectKey === "string" ? stateSubjectKey : null;
    const cancellationTargets = info.meta.infoType.value === "取消"
      ? policy.extractCancellationTarget(info.meta, info)
      : null;
    const cancellationTriggered = info.meta.infoType.value === "取消"
      || policy.terminalPredicate(info.meta, info)
      || policy.deactivationPredicate(info.meta, info);
    const { meta: _meta, isTest: _isTest, ...semanticWeatherPayload } = info;
    const gateInput = {
      domain: policy.domain,
      revisionFamily: policy.revisionFamily,
      stateSubjectKey: subject,
      meta: info.meta,
      comparator: policy.comparator,
      cancellationPolicy: policy.cancellationPolicy,
      terminal: policy.terminalPredicate(info.meta, info),
      deactivation: policy.deactivationPredicate(info.meta, info),
      cancellationTargetMatches: cancellationTargets == null || subject == null
        ? info.meta.infoType.value !== "取消"
        : cancellationTargets.includes(subject),
      durable: policy.durable,
      tombstoneRetentionMs: policy.tombstoneRetentionMs,
      maxSubjects: policy.maxSubjects,
      retainForFamilyCapacity: true,
      allowMissingSerial: policy.allowMissingSerial,
      // transport metadata と受信時刻は semantic payload に含めない。
      payloadFingerprint: semanticPayloadFingerprint(semanticWeatherPayload),
    } as const;
    const evaluation = deps.revisionGate.evaluate(gateInput);
    if (!evaluation.accepted) {
      deps.onRevisionDecision?.(evaluation);
      deps.onVpws50RevisionDecision?.(evaluation);
      return { kind: "suppressed" };
    }

    if (!cancellationTriggered) {
      const unsafe = deps.vpws50State.previewUnsafe(info);
      if (unsafe != null) {
        weatherDiff = unsafe;
        frameLevel = "warning";
        soundLevel = "warning";
        return {
          kind: "ok",
          outcome: {
            domain: "weather",
            msg,
            headType: msg.head.type,
            statsCategory: "weather",
            parsed: info,
            stats: { shouldRecord: true, eventId: msg.xmlReport?.head.eventId ?? null },
            presentation: {
              frameLevel,
              soundLevel,
              notifyCategory: "weather",
              weatherDiff,
              displaySeverity,
              acceptedCorrection: false,
            },
          },
        };
      }
    }

    const decision = deps.revisionGate.decide(gateInput);
    deps.onRevisionDecision?.(decision);
    deps.onVpws50RevisionDecision?.(decision);
    if (!decision.accepted) return { kind: "suppressed" };
    acceptedCorrection = decision.isCorrection;

    if (decision.kind === "restorePrevious") {
      weatherDiff = deps.vpws50State.restorePrevious();
      frameLevel = "cancel";
      soundLevel = "cancel";
    } else {
      const updateDiff = deps.vpws50State.diffAndUpdate(info, messageId, identity, {
        replaceCurrentRevision: decision.kind === "replaceCorrection" && decision.relation === "equal",
      });
      if (updateDiff == null) return { kind: "suppressed" };
      weatherDiff = updateDiff;

      if (weatherDiff.confidence === "unsafe") {
        frameLevel = "warning";
        soundLevel = "warning";
      } else if (weatherDiff.isUnchanged && !weatherDiff.shouldRecap) {
        frameLevel = "info";
        soundLevel = "info";
      }

      // R2-8 debug log: 警報以上で変化なし時に周辺情報変化を観測 (将来 P2-8 判断材料)
      if (weatherDiff.isUnchanged && weatherDiff.confidence === "confirmed") {
        const warningAreas = info.warningAreaCount ?? 0;
        if (warningAreas > 0) {
          log.debug(`[vpws50] unchanged but ${warningAreas} warning areas exist (reportDateTime=${info.reportDateTime})`);
        }
      }
    }
  }

  if (msg.head.type === "VPWW56" && deps?.vpww56State != null) {
    const updateResult = deps.vpww56State.update(info, identity);
    if (updateResult.kind === "suppressed") return { kind: "suppressed" };
  }

  return {
    kind: "ok",
    outcome: {
      domain: "weather",
      msg,
      headType: msg.head.type,
      statsCategory: "weather",
      parsed: info,
      stats: {
        shouldRecord: true,
        eventId: msg.xmlReport?.head.eventId ?? null,
      },
      presentation: {
        frameLevel,
        soundLevel,
        notifyCategory: "weather",
        weatherDiff,
        displaySeverity,
        acceptedCorrection,
      },
    },
  };
}
