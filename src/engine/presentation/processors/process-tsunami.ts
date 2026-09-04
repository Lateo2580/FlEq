import type {
  ParsedTsunamiInfo,
  TsunamiObservationStation,
  WsDataMessage,
} from "../../../types";
import type {
  SuppressibleProcessResult,
  TsunamiOutcome,
} from "../types";
import { parseTsunamiTelegram } from "../../../dmdata/telegram-parser";
import {
  tsunamiRevisionFamilyPolicy,
} from "../../messages/revision-family-registry";
import {
  semanticPayloadFingerprint,
  TelegramRevisionGate,
  type TelegramRevisionGateInput,
} from "../../messages/telegram-revision-gate";
import type { ProcessDeps } from "./process-message";
import { tsunamiFrameLevel, tsunamiSoundLevel } from "../level-helpers";
import { TsunamiStateHolder } from "../../messages/tsunami-state";
import * as log from "../../../logger";
import { sweepStandbyBeforeAdmission } from "../../display/standby-persistence-admission";

/** processTsunami の戻り値。抑制とパース失敗を呼び出し側で区別する。 */
export type TsunamiProcessResult = SuppressibleProcessResult<TsunamiOutcome>;

type TsunamiProcessDeps = Pick<
  ProcessDeps,
  "tsunamiState" | "revisionGate" | "onRevisionDecision" | "onTsunamiRevisionDecision"
  | "persistenceAdmission"
> & {
  /** 起動時 REST が persisted watermark と重複した場合だけ holder を再構成する。 */
  restoreStateOnDuplicate?: boolean;
};

function processTsunamiWithAdmission(
  msg: WsDataMessage,
  deps: TsunamiProcessDeps,
): TsunamiProcessResult {
  const key = msg.head.type === "VTSE41"
    ? "tsunami:VTSE41"
    : msg.head.type === "VTSE51"
      ? "tsunamiObservation:VTSE51"
      : "tsunamiObservation:VTSE52";
  const parsed = parseTsunamiTelegram(msg);
  if (parsed == null) return { kind: "parse-failed" };
  if (!sweepStandbyBeforeAdmission(
    deps.persistenceAdmission!,
    key,
    parsed.meta.receivedAtMs,
  )) return { kind: "suppressed" };
  const callbacks: Array<() => void> = [];
  const transaction = deps.persistenceAdmission!.transact(
    key,
    ["telegramRevisionGate", "tsunamiState"],
    (draft) => {
      const gate = TelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
      const state = TsunamiStateHolder.fromSnapshot(draft.tsunamiState);
      const result = processTsunami(msg, {
        tsunamiState: state,
        revisionGate: gate,
        onRevisionDecision: deps.onRevisionDecision == null
          ? undefined
          : (decision) => callbacks.push(() => deps.onRevisionDecision!(decision)),
        onTsunamiRevisionDecision: deps.onTsunamiRevisionDecision == null
          ? undefined
          : (decision) => callbacks.push(() => deps.onTsunamiRevisionDecision!(decision)),
        restoreStateOnDuplicate: deps.restoreStateOnDuplicate,
        persistenceAdmission: undefined,
      });
      draft.telegramRevisionGate = gate.cloneSnapshot();
      draft.tsunamiState = state.cloneSnapshot();
      return { kind: "accepted", value: result, durableChanged: true };
    },
  );
  if (transaction.kind !== "committed") {
    log.warn(`[standby-admission] key=${key} reason=${transaction.kind === "rejected" ? transaction.reason : "staleVersion"}`);
    return { kind: "suppressed" };
  }
  for (const callback of callbacks) callback();
  return transaction.value;
}

function semanticTsunamiPayload(
  info: ParsedTsunamiInfo,
  policy: NonNullable<ReturnType<typeof tsunamiRevisionFamilyPolicy>>,
): object {
  const { meta: _meta, isTest: _isTest, observations, ...payload } = info;
  if (!policy.fragmentMerge) return { ...payload, observations };
  const observationFingerprints = policy.extractItems(info)
    .map((item) => ({
      subject: policy.itemSubjectKey(info.meta, item),
      fingerprint: policy.itemFingerprint(item),
    }))
    .sort((left, right) => {
      const subjectOrder = (left.subject ?? "").localeCompare(right.subject ?? "");
      return subjectOrder !== 0
        ? subjectOrder
        : left.fingerprint.localeCompare(right.fingerprint);
    });
  return { ...payload, observations: observationFingerprints };
}

function nonBlankCode(code: string | null): boolean {
  return code != null && code.trim() !== "";
}

function isKeylessVtse41Cancellation(info: ParsedTsunamiInfo): boolean {
  const forecast = info.forecast ?? [];
  return info.type === "VTSE41"
    && info.meta.infoType.value === "取消"
    && forecast.length > 0
    && !forecast.some((item) =>
      nonBlankCode(item.areaCode) && nonBlankCode(item.kindCode));
}

/**
 * VTSE41 startup restore と live ingress が同じ semantic payload identity を使うための
 * gate input builder。restore 側は baseline gate の current payload proof にも使う。
 */
export function createTsunamiRevisionGateInput(
  parsed: ParsedTsunamiInfo,
  tsunamiState: TsunamiStateHolder,
  headType: string = parsed.type,
): TelegramRevisionGateInput | null {
  const policy = tsunamiRevisionFamilyPolicy(headType);
  if (policy == null) return null;

  const extractedSubject = policy.extractStateSubjectKey(parsed.meta, parsed);
  const subject = typeof extractedSubject === "string" ? extractedSubject : null;
  const cancellationTargets = parsed.meta.infoType.value === "取消"
    ? policy.extractCancellationTarget(parsed.meta, parsed)
    : null;
  const keylessCancellation = isKeylessVtse41Cancellation(parsed);
  const stateNeutralCancellation = keylessCancellation
    || (
      parsed.type === "VTSE41"
      && parsed.meta.infoType.value === "取消"
      && tsunamiState.retainsEventAfterCancellation(parsed)
    );
  return {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
    stateSubjectKey: subject,
    meta: parsed.meta,
    comparator: policy.comparator,
    cancellationPolicy: policy.cancellationPolicy,
    terminal: policy.terminalPredicate(parsed.meta, parsed),
    deactivation: policy.deactivationPredicate(parsed.meta, parsed),
    cancellationTargetMatches: cancellationTargets == null || subject == null
      ? parsed.meta.infoType.value !== "取消"
      : cancellationTargets.includes(subject),
    stateNeutralCancellation,
    durable: policy.durable,
    tombstoneRetentionMs: policy.tombstoneRetentionMs,
    maxSubjects: policy.maxSubjects,
    // EventID の保護根拠は gate の残存印ではなく、holder の active forecast。
    retainForFamilyCapacity: headType !== "VTSE41",
    activeFamilySubjects: headType === "VTSE41"
      ? tsunamiState.activeEventIds().map((eventId) => `tsunami:${eventId}`)
      : undefined,
    allowMissingSerial: policy.allowMissingSerial,
    fragmentMerge: policy.fragmentMerge,
    payloadFingerprint: semanticPayloadFingerprint(semanticTsunamiPayload(parsed, policy)),
  };
}

/**
 * 津波電文を共通 revision gate の後で state/presentation へ反映する。
 * VTSE51/52 は whole-message gate の equal を item gate へ送り、観測点単位で補完する。
 */
export function processTsunami(
  msg: WsDataMessage,
  deps: TsunamiProcessDeps,
): TsunamiProcessResult {
  if (deps.persistenceAdmission != null) return processTsunamiWithAdmission(msg, deps);
  const parsed = parseTsunamiTelegram(msg);
  if (!parsed) return { kind: "parse-failed" };

  const policy = tsunamiRevisionFamilyPolicy(msg.head.type);
  if (policy == null) return { kind: "parse-failed" };
  const keylessCancellation = isKeylessVtse41Cancellation(parsed);
  const gateInput = createTsunamiRevisionGateInput(parsed, deps.tsunamiState, msg.head.type);
  if (gateInput == null) return { kind: "parse-failed" };

  const evaluation = deps.revisionGate.evaluate(gateInput);
  if (!evaluation.accepted) {
    deps.onRevisionDecision?.(evaluation);
    if (
      deps.restoreStateOnDuplicate === true
      && msg.head.type === "VTSE41"
      // 取消 payload は active snapshot ではない。non-cancel watermark と一致しても
      // startup holder の再構成に使わず、取消のまま suppressed に留める。
      && parsed.meta.infoType.value !== "取消"
      && (evaluation.kind === "duplicate" || evaluation.kind === "semanticDuplicate")
      && parsed.meta.eventId.valid
      && parsed.meta.eventId.value != null
      && parsed.meta.eventId.value.trim() !== ""
      && !deps.tsunamiState.hasPersistedEvent(parsed.meta.eventId.value)
      && deps.revisionGate.matchesCurrentAcceptedPayload(gateInput)
    ) {
      deps.tsunamiState.applyAccepted(parsed);
    }
    return { kind: "suppressed" };
  }

  let acceptedObservations = parsed.observations;
  let itemInputs: Array<{
    item: TsunamiObservationStation;
    input: TelegramRevisionGateInput | null;
  }> = [];
  if (policy.fragmentMerge) {
    itemInputs = policy.extractItems(parsed).map((item) => {
      const itemSubject = policy.itemSubjectKey(parsed.meta, item);
      return {
        item,
        input: itemSubject == null
          ? null
          : {
              domain: "tsunamiObservation",
              revisionFamily: policy.revisionFamily,
              stateSubjectKey: itemSubject,
              meta: parsed.meta,
              comparator: policy.comparator,
              cancellationPolicy: policy.cancellationPolicy,
              terminal: false,
              deactivation: false,
              cancellationTargetMatches: true,
              durable: policy.durable,
              tombstoneRetentionMs: policy.tombstoneRetentionMs,
              maxSubjects: policy.maxSubjects,
              retainForFamilyCapacity: false,
              allowMissingSerial: policy.allowMissingSerial,
              payloadFingerprint: `${policy.fingerprintVersion}:${policy.itemFingerprint(item)}`,
            },
      };
    });

    const hasCandidate = itemInputs.some(({ input }) =>
      input == null || deps.revisionGate.evaluate(input).accepted);
    if (evaluation.kind === "mergeFragment" && !hasCandidate) {
      deps.onRevisionDecision?.({
        kind: "semanticDuplicate",
        relation: "equal",
          accepted: false,
          isCorrection: false,
          isTerminal: false,
          resolvedTrigger: null,
      });
      return { kind: "suppressed" };
    }
  }

  // state-neutral 取消も semantic/watermark は commit し、cancelled だけ false に保つ。
  const decision = deps.revisionGate.decide(gateInput);
  deps.onRevisionDecision?.(decision);
  if (!decision.accepted) return { kind: "suppressed" };

  if (policy.fragmentMerge) {
    acceptedObservations = itemInputs.flatMap(({ item, input }) => {
      if (input == null) return [item];
      return deps.revisionGate.decide(input).accepted ? [item] : [];
    });
  }

  const tsunamiInfo = acceptedObservations === parsed.observations
    ? parsed
    : { ...parsed, observations: acceptedObservations };
  const levelBefore = deps.tsunamiState.getLevel();
  if (msg.head.type === "VTSE41") {
    if (tsunamiInfo.meta.infoType.value === "取消") {
      if (!keylessCancellation) deps.tsunamiState.clearAccepted(tsunamiInfo);
    } else deps.tsunamiState.applyAccepted(tsunamiInfo);
  } else if (msg.head.type === "VTSE51" || msg.head.type === "VTSE52") {
    if (decision.kind === "clearCurrent") {
      deps.tsunamiState.clearObservationFamily(msg.head.type);
      deps.revisionGate.clearRevisionFamilySubjectsExcept(
        "tsunamiObservation",
        msg.head.type,
        [`tsunami:observations:${msg.head.type}`],
      );
    } else {
      const evictedCodes = deps.tsunamiState.applyAcceptedObservations(
        msg.head.type,
        acceptedObservations ?? [],
      );
      for (const code of evictedCodes) {
        deps.revisionGate.clear("tsunamiObservation", msg.head.type, code);
      }
    }
  }
  // item gate の commit と holder mutation が完了してから永続化側へ通知する。
  deps.onTsunamiRevisionDecision?.(decision);
  const levelAfter = deps.tsunamiState.getLevel();
  const displaySnapshot = msg.head.type === "VTSE41"
    ? deps.tsunamiState.getPresentationInfo(tsunamiInfo)
      ?? (tsunamiInfo.infoType === "取消"
        ? { ...tsunamiInfo, forecast: [] }
        : tsunamiInfo)
    : tsunamiInfo;

  return {
    kind: "ok",
    outcome: {
      domain: "tsunami",
      msg,
      headType: msg.head.type,
      statsCategory: "tsunami",
      parsed: tsunamiInfo,
      displaySnapshot,
      state: {
        levelBefore,
        levelAfter,
        changed: levelBefore !== levelAfter,
        ...(msg.head.type === "VTSE41"
          ? {
              presentationObservationGroups: deps.tsunamiState.getObservationGroups(),
            }
          : {}),
      },
      stats: {
        shouldRecord: true,
        eventId: msg.xmlReport?.head.eventId ?? null,
      },
      presentation: {
        frameLevel: tsunamiFrameLevel(displaySnapshot),
        soundLevel: tsunamiSoundLevel(tsunamiInfo),
        notifyCategory: "tsunami",
        acceptedCorrection: decision.isCorrection,
      },
    },
  };
}
