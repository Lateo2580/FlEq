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
  type TelegramRevisionGateInput,
} from "../../messages/telegram-revision-gate";
import type { ProcessDeps } from "./process-message";
import { tsunamiFrameLevel, tsunamiSoundLevel } from "../level-helpers";

/** processTsunami の戻り値。抑制とパース失敗を呼び出し側で区別する。 */
export type TsunamiProcessResult = SuppressibleProcessResult<TsunamiOutcome>;

type TsunamiProcessDeps = Pick<
  ProcessDeps,
  "tsunamiState" | "revisionGate" | "onRevisionDecision" | "onTsunamiRevisionDecision"
> & {
  /** 起動時 REST が persisted watermark と重複した場合だけ holder を再構成する。 */
  restoreStateOnDuplicate?: boolean;
};

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

/**
 * 津波電文を共通 revision gate の後で state/presentation へ反映する。
 * VTSE51/52 は whole-message gate の equal を item gate へ送り、観測点単位で補完する。
 */
export function processTsunami(
  msg: WsDataMessage,
  deps: TsunamiProcessDeps,
): TsunamiProcessResult {
  const parsed = parseTsunamiTelegram(msg);
  if (!parsed) return { kind: "parse-failed" };

  const policy = tsunamiRevisionFamilyPolicy(msg.head.type);
  if (policy == null) return { kind: "parse-failed" };

  const extractedSubject = policy.extractStateSubjectKey(parsed.meta, parsed);
  const subject = typeof extractedSubject === "string" ? extractedSubject : null;
  const cancellationTargets = parsed.meta.infoType.value === "取消"
    ? policy.extractCancellationTarget(parsed.meta, parsed)
    : null;
  const gateInput: TelegramRevisionGateInput = {
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
    durable: policy.durable,
    tombstoneRetentionMs: policy.tombstoneRetentionMs,
    maxSubjects: policy.maxSubjects,
    retainForFamilyCapacity: true,
    allowMissingSerial: policy.allowMissingSerial,
    fragmentMerge: policy.fragmentMerge,
    payloadFingerprint: semanticPayloadFingerprint(semanticTsunamiPayload(parsed, policy)),
  };

  const evaluation = deps.revisionGate.evaluate(gateInput);
  if (!evaluation.accepted) {
    deps.onRevisionDecision?.(evaluation);
    if (
      deps.restoreStateOnDuplicate === true
      && msg.head.type === "VTSE41"
      && (evaluation.kind === "duplicate" || evaluation.kind === "semanticDuplicate")
      && deps.tsunamiState.getLastInfo() == null
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
      });
      return { kind: "suppressed" };
    }
  }

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
    if (decision.kind === "clearCurrent") deps.tsunamiState.clearActive();
    else deps.tsunamiState.applyAccepted(tsunamiInfo);
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

  return {
    kind: "ok",
    outcome: {
      domain: "tsunami",
      msg,
      headType: msg.head.type,
      statsCategory: "tsunami",
      parsed: tsunamiInfo,
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
        frameLevel: tsunamiFrameLevel(tsunamiInfo),
        soundLevel: tsunamiSoundLevel(tsunamiInfo),
        notifyCategory: "tsunami",
        acceptedCorrection: decision.isCorrection,
      },
    },
  };
}
