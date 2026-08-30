import type { TelegramMeta, WsDataMessage } from "../../../types";
import type { ProcessOutcomeBase } from "../types";
import type { ProcessDeps } from "./process-message";
import type { RevisionFamilyPolicy } from "../../messages/revision-family-registry";
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
}

/** Single-subject standby families share exactly the same revision decision path. */
export function processStandbyFoundation<TParsed>(
  msg: WsDataMessage,
  parsed: TParsed & { meta: TelegramMeta },
  policy: RevisionFamilyPolicy<TParsed>,
  deps: Pick<ProcessDeps, "revisionGate" | "onRevisionDecision" | "onStandbyRevisionDecision">,
): StandbyFoundationResult {
  const extracted = policy.extractStateSubjectKey(parsed.meta, parsed);
  const subjects = extracted == null
    ? []
    : [...new Set(typeof extracted === "string" ? [extracted] : extracted)];
  if (subjects.length !== 1) {
    return { kind: "transient", decision: null, subject: null, activeSubjects: [], semanticKey: null };
  }
  const subject = subjects[0];
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
    allowMissingSerial: policy.allowMissingSerial,
    fragmentMerge: false,
    payloadFingerprint: semanticPayloadFingerprint(semanticPayload),
    legacyRevisionKey: historyKey ?? subject,
    legacyRevisionKeyProvenance: historyKey == null ? null : "eventId",
  };
  const decision = deps.revisionGate.decide(gateInput);
  deps.onRevisionDecision?.(decision);
  deps.onStandbyRevisionDecision?.(decision);
  if (!decision.accepted) {
    return { kind: "suppressed", decision, subject, activeSubjects: [], semanticKey: null };
  }
  return {
    kind: "accepted",
    decision,
    subject,
    activeSubjects: deps.revisionGate.activeRevisionFamilySubjects(policy.domain, policy.revisionFamily),
    semanticKey: telegramRevisionSemanticKey(gateInput),
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
