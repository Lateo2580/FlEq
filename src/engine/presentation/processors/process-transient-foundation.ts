import type { TelegramMeta, WsDataMessage } from "../../../types";
import { requireTelegramMeta } from "../../../dmdata/telegram-ingress";
import type { ProcessOutcomeBase } from "../types";
import type { ProcessDeps } from "./process-message";
import type { RevisionFamilyPolicy } from "../../messages/revision-family-registry";
import {
  semanticPayloadFingerprint,
  type TelegramRevisionDecision,
  type TelegramRevisionGateInput,
} from "../../messages/telegram-revision-gate";

export interface TransientFoundationResult {
  kind: "accepted" | "suppressed";
  acceptedCorrection: boolean;
  decision: TelegramRevisionDecision;
}

/**
 * Durable projection を持たない family の共通 gate。
 * EventID 等から subject を確定できない報は受信時刻で擬似結合せず、messageId 単位の
 * transient subject と semantic fingerprint だけで再送を抑止する。
 */
export function processTransientFoundation<TParsed>(
  msg: WsDataMessage,
  parsed: TParsed,
  policy: RevisionFamilyPolicy<TParsed>,
  deps: Pick<ProcessDeps, "revisionGate" | "onRevisionDecision">,
  meta: TelegramMeta,
  semanticPayload: unknown,
): TransientFoundationResult {
  const extracted = policy.extractStateSubjectKey(meta, parsed);
  const subjects = extracted == null
    ? []
    : [...new Set(typeof extracted === "string" ? [extracted] : extracted)];
  const subject = subjects.length === 1 ? subjects[0] : null;
  const targets = policy.extractCancellationTarget(meta, parsed);
  const gateInput: TelegramRevisionGateInput = {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
    stateSubjectKey: subject,
    transientSubjectKey: subject == null
      ? `${policy.domain}:${policy.revisionFamily}:message:${meta.messageId}`
      : null,
    meta,
    comparator: policy.comparator,
    cancellationPolicy: policy.cancellationPolicy,
    terminal: policy.terminalPredicate(meta, parsed),
    deactivation: policy.deactivationPredicate(meta, parsed),
    cancellationTargetMatches: targets == null || subject == null
      ? meta.infoType.value !== "取消" || subject == null
      : targets.includes(subject),
    durable: policy.durable,
    tombstoneRetentionMs: policy.tombstoneRetentionMs,
    maxSubjects: policy.maxSubjects,
    allowMissingSerial: policy.allowMissingSerial,
    fragmentMerge: false,
    payloadFingerprint: semanticPayloadFingerprint(semanticPayload),
    legacyRevisionKey: subject,
  };
  const decision = deps.revisionGate.decide(gateInput);
  deps.onRevisionDecision?.(decision);
  return decision.accepted
    ? { kind: "accepted", acceptedCorrection: decision.isCorrection, decision }
    : { kind: "suppressed", acceptedCorrection: false, decision };
}

export function gateTransientOutcome<
  TParsed extends { meta: TelegramMeta },
  TOutcome extends ProcessOutcomeBase & { parsed: TParsed },
>(
  outcome: TOutcome,
  policy: RevisionFamilyPolicy<TParsed>,
  deps: Pick<ProcessDeps, "revisionGate" | "onRevisionDecision">,
): TOutcome | null {
  const { meta, ...payload } = outcome.parsed;
  const result = processTransientFoundation(
    outcome.msg,
    outcome.parsed,
    policy,
    deps,
    meta,
    payload,
  );
  if (result.kind === "suppressed") return null;
  outcome.presentation.foundationMutationAccepted = true;
  outcome.presentation.acceptedCorrection = result.acceptedCorrection;
  outcome.presentation.foundationResolvedTrigger = result.decision.resolvedTrigger;
  outcome.presentation.foundationCancellationPolicy = policy.cancellationPolicy;
  return outcome;
}

export function gateRawOutcome<TOutcome extends ProcessOutcomeBase & { parsed: null }>(
  outcome: TOutcome,
  policy: RevisionFamilyPolicy<unknown>,
  deps: Pick<ProcessDeps, "revisionGate" | "onRevisionDecision">,
): TOutcome | null {
  const meta = requireTelegramMeta(outcome.msg);
  const result = processTransientFoundation(
    outcome.msg,
    null,
    policy,
    deps,
    meta,
    { type: outcome.headType, body: outcome.msg.body },
  );
  if (result.kind === "suppressed") {
    if (result.decision.kind !== "invalidMeta" && result.decision.kind !== "invalidRevision") return null;
    // Router は invalid date を診断経路へ分離する。parser 失敗を直接呼ぶ legacy adapter では
    // raw 表示だけを fail-open し、watermark・通知は一切動かさない。
    outcome.presentation.foundationMutationAccepted = false;
    return outcome;
  }
  outcome.presentation.foundationMutationAccepted = true;
  outcome.presentation.acceptedCorrection = result.acceptedCorrection;
  outcome.presentation.foundationResolvedTrigger = result.decision.resolvedTrigger;
  outcome.presentation.foundationCancellationPolicy = policy.cancellationPolicy;
  return outcome;
}
