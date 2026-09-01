import type { TelegramMeta, WsDataMessage } from "../../../types";
import type { ProcessOutcomeBase } from "../types";
import type { ProcessDeps } from "./process-message";
import type { RevisionFamilyPolicy } from "../../messages/revision-family-registry";
import * as log from "../../../logger";
import {
  semanticPayloadFingerprint,
  telegramRevisionSemanticKey,
  type TelegramRevisionDecision,
  type TelegramRevisionGateInput,
} from "../../messages/telegram-revision-gate";

export interface StandbyFoundationResult {
  kind: "accepted" | "transient" | "suppressed";
  decision: TelegramRevisionDecision | null;
  subject: string | null;
  activeSubjects: string[];
  semanticKey: string | null;
  preAdmissionDurableChanged: boolean;
}

/** Single-subject standby families share exactly the same revision decision path. */
export function processStandbyFoundation<TParsed>(
  msg: WsDataMessage,
  parsed: TParsed & { meta: TelegramMeta },
  policy: RevisionFamilyPolicy<TParsed>,
  deps: Pick<ProcessDeps,
    "revisionGate" | "onRevisionDecision" | "onStandbyRevisionDecision"
    | "activeWeatherWarningForecastSubjects" | "maintainWeatherWarningForecastSubjects">,
): StandbyFoundationResult {
  const extracted = policy.extractStateSubjectKey(parsed.meta, parsed);
  const subjects = extracted == null
    ? []
    : [...new Set(typeof extracted === "string" ? [extracted] : extracted)];
  if (subjects.length !== 1) {
    return {
      kind: "transient", decision: null, subject: null, activeSubjects: [],
      semanticKey: null, preAdmissionDurableChanged: false,
    };
  }
  const subject = subjects[0];
  let preAdmissionDurableChanged = false;
  let expiredStateSubjectKeys: readonly string[] = [];
  let activeFamilySubjects: readonly string[] | undefined;
  let familySubjectCount: number | null = null;
  if (policy.activeRetentionMs != null) {
    const expiry = deps.revisionGate.expireRevisionFamilyDetailed(
      policy.domain,
      policy.revisionFamily,
      parsed.meta.receivedAtMs,
      policy.activeRetentionMs,
    );
    expiredStateSubjectKeys = expiry.expiredStateSubjectKeys;
    const gateSubjects = deps.revisionGate.revisionFamilySubjectKeys(
      policy.domain,
      policy.revisionFamily,
    );
    familySubjectCount = gateSubjects.length;
    const projectionMutation = deps.maintainWeatherWarningForecastSubjects?.(
      parsed.meta.receivedAtMs,
      gateSubjects,
    );
    preAdmissionDurableChanged = expiry.changed
      || projectionMutation?.durableChanged === true;
    activeFamilySubjects = deps.activeWeatherWarningForecastSubjects?.(
      parsed.meta.receivedAtMs,
    );
  }
  const targets = policy.extractCancellationTarget(parsed.meta, parsed);
  const historyKey = policy.extractRevisionHistoryKey?.(parsed.meta, parsed) ?? null;
  const historyTargetMatches = policy.extractRevisionHistoryKey == null
    || parsed.meta.infoType.value !== "取消"
    || historyKey != null && deps.revisionGate.stateSubjectForLegacyRevisionKey(
      policy.domain,
      policy.revisionFamily,
      historyKey,
      parsed.meta.receivedAtMs,
    ) === subject;
  const { meta: _transportMeta, ...semanticPayload } = parsed;
  const gateInput: TelegramRevisionGateInput = {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
    stateSubjectKey: subject,
    meta: parsed.meta,
    comparator: policy.comparator,
    cancellationPolicy: policy.cancellationPolicy,
    terminal: policy.terminalPredicate(parsed.meta, parsed),
    deactivation: policy.deactivationPredicate(parsed.meta, parsed),
    cancellationTargetMatches: (targets == null || targets.includes(subject)) && historyTargetMatches,
    durable: policy.durable,
    tombstoneRetentionMs: policy.tombstoneRetentionMs,
    maxSubjects: policy.maxSubjects,
    familyCapacityMode: policy.familyCapacityMode,
    activeFamilySubjects,
    allowMissingSerial: policy.allowMissingSerial,
    fragmentMerge: false,
    payloadFingerprint: semanticPayloadFingerprint(semanticPayload),
    legacyRevisionKey: historyKey ?? subject,
    legacyRevisionKeyProvenance: historyKey == null ? null : "eventId",
  };
  const gateDecision = deps.revisionGate.decide(gateInput);
  const decision: TelegramRevisionDecision = preAdmissionDurableChanged
    ? {
        ...gateDecision,
        preAdmissionDurableChanged: true,
        expiredStateSubjectKeys,
      }
    : gateDecision;
  deps.onRevisionDecision?.(decision);
  deps.onStandbyRevisionDecision?.(decision, {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
  });
  if (!decision.accepted) {
    if (policy.revisionFamily === "VPWP50" && decision.kind === "capacityExceeded") {
      log.warn(`[VPWP50] vpwp50SubjectCapacityExceeded subject=${subject.slice(0, 128)} actual=${familySubjectCount ?? policy.maxSubjects} limit=${policy.maxSubjects} revision=${JSON.stringify({ reportDateTime: parsed.meta.reportDateTime.raw, serial: parsed.meta.serial.raw })}`);
    }
    return {
      kind: "suppressed", decision, subject, activeSubjects: [], semanticKey: null,
      preAdmissionDurableChanged,
    };
  }
  return {
    kind: "accepted",
    decision,
    subject,
    activeSubjects: deps.revisionGate.activeRevisionFamilySubjects(policy.domain, policy.revisionFamily),
    semanticKey: telegramRevisionSemanticKey(gateInput),
    preAdmissionDurableChanged,
  };
}

export function standbyFoundationPresentation(
  result: StandbyFoundationResult,
): Pick<ProcessOutcomeBase["presentation"],
  "acceptedCorrection" | "standbyStateMutationAccepted" | "standbyStateSubject"
  | "standbyActiveSubjects" | "standbyAppliedSemanticKey"> {
  return {
    acceptedCorrection: result.decision?.isCorrection === true,
    standbyStateMutationAccepted: result.kind === "accepted",
    standbyStateSubject: result.subject,
    standbyActiveSubjects: result.activeSubjects,
    standbyAppliedSemanticKey: result.semanticKey,
  };
}
