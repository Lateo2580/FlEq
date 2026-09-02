import type { WsDataMessage } from "../../../types";
import type { SuppressibleProcessResult, WeatherOutcome } from "../types";
import { parseWeatherWarning } from "../../../dmdata/weather-parser";
import { weatherFrameLevel, weatherSoundLevel } from "../level-helpers";
import type { ProcessDeps } from "./process-message";
import * as log from "../../../logger";
import { Vpws50StateHolder, type WeatherReportIdentity } from "../../messages/vpws50-state";
import { Vpww56StateHolder } from "../../messages/vpww56-state";
import { weatherRevisionFamilyPolicy } from "../../messages/revision-family-registry";
import { semanticPayloadFingerprint, TelegramRevisionGate } from "../../messages/telegram-revision-gate";
import { isVpws50StateHeadType } from "../../messages/weather-stream-key";
import { StandbyStateStore } from "../../display/standby-state-store";
import { weatherAlertsFromVpws50, weatherAlertsFromVpww56 } from "../../display/weather-alert-view";
import { sweepStandbyBeforeAdmission } from "../../display/standby-persistence-admission";

/** processWeather の戻り値。抑制とパース失敗を呼び出し側で区別する。 */
export type WeatherProcessResult = SuppressibleProcessResult<WeatherOutcome>;

type WeatherProcessDeps = Pick<
  ProcessDeps,
  "vpws50State" | "vpww56State" | "revisionGate" | "onRevisionDecision"
  | "onVpws50RevisionDecision" | "onVpww56RevisionDecision" | "persistenceAdmission"
>;

/** Run the complete gate/holder/standby mutation on scratch owners before publish. */
function processWeatherWithAdmission(
  msg: WsDataMessage,
  deps: WeatherProcessDeps,
): WeatherProcessResult {
  const coordinator = deps.persistenceAdmission!;
  const key = msg.head.type === "VPWW56" ? "weather:VPWW56" : "weather:VPWS50";
  const parsed = parseWeatherWarning(msg);
  if (parsed == null) return { kind: "parse-failed" };
  if (!sweepStandbyBeforeAdmission(coordinator, key, parsed.meta.receivedAtMs)) {
    return { kind: "suppressed" };
  }
  const touched = key === "weather:VPWW56"
    ? ["telegramRevisionGate", "standbyStateStore", "vpww56State"] as const
    : ["telegramRevisionGate", "standbyStateStore", "vpws50State"] as const;
  const callbacks: Array<() => void> = [];
  const transaction = coordinator.transact(key, touched, (draft) => {
    const gate = TelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
    const vpws50 = Vpws50StateHolder.fromSnapshot(draft.vpws50State);
    const vpww56 = Vpww56StateHolder.fromSnapshot(draft.vpww56State);
    const result = processWeather(msg, {
      vpws50State: vpws50,
      vpww56State: vpww56,
      revisionGate: gate,
      onRevisionDecision: deps.onRevisionDecision == null
        ? undefined
        : (decision) => callbacks.push(() => deps.onRevisionDecision!(decision)),
      onVpws50RevisionDecision: deps.onVpws50RevisionDecision == null
        ? undefined
        : (decision) => callbacks.push(() => deps.onVpws50RevisionDecision!(decision)),
      onVpww56RevisionDecision: deps.onVpww56RevisionDecision == null
        ? undefined
        : (decision) => callbacks.push(() => deps.onVpww56RevisionDecision!(decision)),
      persistenceAdmission: undefined,
    });
    draft.telegramRevisionGate = gate.cloneSnapshot();
    draft.vpws50State = vpws50.cloneSnapshot();
    draft.vpww56State = vpww56.cloneSnapshot();

    if (result.kind === "ok" && result.outcome.presentation.weatherStateMutationAccepted === true) {
      const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
      const info = result.outcome.parsed;
      const nowMs = info.meta.receivedAtMs;
      if (isVpws50StateHeadType(msg.head.type)) {
        const activeIdentity = info.meta.infoType.value === "取消"
          ? vpws50.getCurrentIdentity()
          : null;
        const reportDateTime = activeIdentity?.reportDateTime ?? info.reportDateTime;
        standby.applyWeatherAlerts(
          "vpws50",
          weatherAlertsFromVpws50(vpws50.getCurrentAreasForDisplay(), reportDateTime),
          reportDateTime,
          activeIdentity?.serial ?? msg.xmlReport?.head.serial ?? null,
          nowMs,
          info.meta.infoType.value === "訂正",
        );
      } else if (msg.head.type === "VPWW56") {
        const activeRevision = result.outcome.presentation.weatherStateRevision;
        const reportDateTime = activeRevision?.reportDateTime ?? info.reportDateTime;
        standby.applyWeatherAlerts(
          "vpww56",
          weatherAlertsFromVpww56(vpww56.getCurrentAreasForDisplay(), reportDateTime),
          reportDateTime,
          activeRevision?.serial ?? msg.xmlReport?.head.serial ?? null,
          nowMs,
          info.meta.infoType.value === "訂正",
        );
      }
      draft.standbyStateStore = standby.cloneSnapshot();
    }
    return { kind: "accepted", value: result, durableChanged: true };
  });
  if (transaction.kind !== "committed") {
    log.warn(`[standby-admission] key=${key} reason=${transaction.kind === "rejected" ? transaction.reason : "staleVersion"}`);
    return { kind: "suppressed" };
  }
  for (const callback of callbacks) callback();
  if (transaction.value.kind === "ok") {
    transaction.value.outcome.presentation.standbyStateProjectionCommitted = true;
  }
  return transaction.value;
}

/**
 * 気象警報・注意報電文 (VPWW55-61, VPWS50) を処理し WeatherOutcome を返す。
 * パース失敗は parse-failed、単調性ガードで棄却した報は suppressed を返す。
 *
 * VPWS50 と、その地域先行報 VPWW55/57-61 は、deps.vpws50State で同じ差分計算を行い
 * presentation.weatherDiff に乗せる。
 *   - 取消 (rollback): frameLevel/soundLevel = "cancel"
 *   - unsafe (layer_missing / abnormal_release_rate): frameLevel/soundLevel = "warning"
 *   - isUnchanged かつ !shouldRecap: frameLevel/soundLevel = "info" (静音化)
 *   - その他: 通常の severity ベース判定 (weatherFrameLevel / weatherSoundLevel)
 *
 * VPWW56 (土砂災害警戒情報) も共通 revision gate を通し、受理済み mutation だけを
 * deps.vpww56State に適用する
 * (正常報の frame/sound には影響しない)。
 */
export function processWeather(
  msg: WsDataMessage,
  deps?: WeatherProcessDeps,
): WeatherProcessResult {
  if (deps?.persistenceAdmission != null) return processWeatherWithAdmission(msg, deps);
  const info = parseWeatherWarning(msg);
  if (!info) return { kind: "parse-failed" };

  const identity: WeatherReportIdentity = {
    reportDateTime: info.reportDateTime,
    serial: msg.xmlReport?.head.serial ?? null,
  };

  let weatherDiff: WeatherOutcome["presentation"]["weatherDiff"] = undefined;
  let weatherChangeDiff: WeatherOutcome["presentation"]["weatherChangeDiff"] = undefined;
  let acceptedCorrection = false;
  let weatherStateMutationAccepted = false;
  let weatherStateRevision: WeatherOutcome["presentation"]["weatherStateRevision"] = null;
  // 色専用の集約 severity。frameLevel は静音化 (isUnchanged → info 降格) や unsafe 昇格で
  // 変動するが、テロップ色は「現在の全国集約の最大 severity」で安定させたいので、この降格・
  // 昇格の巻き添えを受けない値を別に保持して下流 (from-weather → summaryRole) へ運ぶ。
  const displaySeverity = weatherFrameLevel(info);
  let frameLevel = displaySeverity;
  let soundLevel = weatherSoundLevel(info);

  const policy = weatherRevisionFamilyPolicy(msg.head.type);
  const stateSubjectKey = policy?.extractStateSubjectKey(info.meta, info);
  const subject = typeof stateSubjectKey === "string" ? stateSubjectKey : null;
  if (
    policy != null
    && subject != null
    && deps?.revisionGate != null
    && (!isVpws50StateHeadType(msg.head.type) || deps.vpws50State != null)
    && (msg.head.type !== "VPWW56" || deps.vpww56State != null)
  ) {
    const messageId = msg.xmlReport?.head.eventId
                   ?? msg.xmlReport?.head.reportDateTime
                   ?? "";

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
      // 全国 base は singleton のため従来どおり保持する。部分報の保護根拠は holder の active 集合。
      retainForFamilyCapacity: msg.head.type === "VPWS50",
      activeFamilySubjects: isVpws50StateHeadType(msg.head.type)
        ? ["weather:vpws50", ...deps.vpws50State?.activePartialSubjects() ?? []]
        : undefined,
      allowMissingSerial: policy.allowMissingSerial,
      // transport metadata と受信時刻は semantic payload に含めない。
      payloadFingerprint: semanticPayloadFingerprint(semanticWeatherPayload),
    } as const;
    const evaluation = deps.revisionGate.evaluate(gateInput);
    if (!evaluation.accepted) {
      deps.onRevisionDecision?.(evaluation);
      if (isVpws50StateHeadType(msg.head.type)) deps.onVpws50RevisionDecision?.(evaluation);
      if (msg.head.type === "VPWW56") deps.onVpww56RevisionDecision?.(evaluation);
      return { kind: "suppressed" };
    }

    if (msg.head.type === "VPWS50" && deps.vpws50State != null && !cancellationTriggered) {
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
              weatherStateMutationAccepted: false,
              weatherStateRevision: null,
            },
          },
        };
      }
    }

    const decision = deps.revisionGate.decide(gateInput);
    deps.onRevisionDecision?.(decision);
    if (isVpws50StateHeadType(msg.head.type)) deps.onVpws50RevisionDecision?.(decision);
    if (!decision.accepted) {
      if (msg.head.type === "VPWW56") deps.onVpww56RevisionDecision?.(decision);
      return { kind: "suppressed" };
    }
    acceptedCorrection = decision.isCorrection;

    if (msg.head.type === "VPWS50" && deps.vpws50State != null) {
      if (decision.kind === "restorePrevious") {
        weatherDiff = deps.vpws50State.restorePrevious();
        frameLevel = "cancel";
        soundLevel = "cancel";
      } else {
        const update = deps.vpws50State.diffAndUpdateWithDisplay(info, messageId, identity, {
          replaceCurrentRevision: decision.kind === "replaceCorrection" && decision.relation === "equal",
        });
        weatherDiff = update.diff;
        weatherChangeDiff = update.displayDiff ?? undefined;

        if (weatherDiff.confidence === "unsafe") {
          frameLevel = "warning";
          soundLevel = "warning";
        } else if (weatherDiff.isUnchanged && !weatherDiff.shouldRecap) {
          frameLevel = "info";
          soundLevel = "info";
        }

        if (weatherDiff.isUnchanged && weatherDiff.confidence === "confirmed") {
          const warningAreas = info.warningAreaCount ?? 0;
          if (warningAreas > 0) {
            log.debug(`[vpws50] unchanged but ${warningAreas} warning areas exist (reportDateTime=${info.reportDateTime})`);
          }
        }
        weatherStateMutationAccepted = weatherDiff.confidence === "confirmed";
      }
      if (decision.kind === "restorePrevious") {
        weatherStateMutationAccepted = weatherDiff?.confidence === "confirmed";
      }
    } else if (isVpws50StateHeadType(msg.head.type) && deps.vpws50State != null) {
      const update = cancellationTriggered
        ? decision.kind === "restorePrevious"
          ? deps.vpws50State.restorePreviousPartial(subject)
          : deps.vpws50State.clearPartial(subject)
        : deps.vpws50State.mergePartialWithDisplay(info, messageId, identity, subject, {
          replaceCurrentRevision: decision.kind === "replaceCorrection" && decision.relation === "equal",
        });
      weatherDiff = update.diff;
      weatherChangeDiff = update.displayDiff ?? undefined;
      if (cancellationTriggered) {
        frameLevel = "cancel";
        soundLevel = "cancel";
      } else if (weatherDiff.isUnchanged && !weatherDiff.shouldRecap) {
        frameLevel = "info";
        soundLevel = "info";
      }
      weatherStateMutationAccepted = weatherDiff.confidence === "confirmed";
      // restorePrevious は取消済み gate subject より一つ前の accepted snapshot を表示する。
      // active subject 集合で直後に刈ると、その復元を自分で消してしまう。
      if (!cancellationTriggered) {
        deps.vpws50State.retainActivePartialSubjects(
          deps.revisionGate.activeRevisionFamilySubjects(policy.domain, policy.revisionFamily),
        );
      }
    } else if (msg.head.type === "VPWW56") {
      if (decision.kind === "clearCurrent") deps.vpww56State!.clearSubject(subject);
      else deps.vpww56State!.applyAccepted(info, subject);
      deps.vpww56State!.retainActiveSubjects(
        deps.revisionGate.activeRevisionFamilySubjects(policy.domain, policy.revisionFamily),
      );
      weatherStateMutationAccepted = true;
      weatherStateRevision = deps.revisionGate.latestActiveRevisionFamilyRevision(
        policy.domain,
        policy.revisionFamily,
      );
      deps.onVpww56RevisionDecision?.(decision);
    }
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
        weatherChangeDiff,
        displaySeverity,
        acceptedCorrection,
        weatherStateMutationAccepted,
        weatherStateRevision,
      },
    },
  };
}
