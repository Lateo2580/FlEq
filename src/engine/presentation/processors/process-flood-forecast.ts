import type { WsDataMessage } from "../../../types";
import type {
  FloodForecastOutcome,
  SuppressibleProcessResult,
} from "../types";
import type { ProcessDeps } from "./process-message";
import { parseFloodForecast } from "../../../dmdata/flood-forecast-parser";
import { resolveFloodForecastLevels } from "../level-helpers";
import {
  buildStationDigests,
  type FloodForecastDiff,
} from "../../messages/flood-forecast-state";
import {
  FLOOD_FORECAST_RETENTION_MS,
  floodForecastHasUnderstoodStations,
  floodForecastRevisionFamilyPolicy,
} from "../../messages/revision-family-registry";
import {
  semanticPayloadFingerprint,
  TelegramRevisionGate,
  telegramRevisionSemanticKey,
  type TelegramRevisionGateInput,
} from "../../messages/telegram-revision-gate";
import { FloodForecastStateHolder } from "../../messages/flood-forecast-state";
import { StandbyStateStore } from "../../display/standby-state-store";
import { toPresentationEvent } from "../events/to-presentation-event";
import * as log from "../../../logger";
import { sweepStandbyBeforeAdmission } from "../../display/standby-persistence-admission";

export type FloodForecastProcessResult = SuppressibleProcessResult<FloodForecastOutcome>;

type FloodForecastProcessDeps = Pick<
  ProcessDeps,
  "floodForecastState" | "revisionGate" | "onRevisionDecision"
  | "onFloodRevisionDecision" | "persistenceAdmission"
>;

function processFloodForecastWithAdmission(
  msg: WsDataMessage,
  deps: FloodForecastProcessDeps,
  nowMs: number,
): FloodForecastProcessResult {
  if (parseFloodForecast(msg) == null) return { kind: "parse-failed" };
  if (!sweepStandbyBeforeAdmission(
    deps.persistenceAdmission!,
    "floodForecast:floodForecast",
    nowMs,
  )) return { kind: "suppressed" };
  const callbacks: Array<() => void> = [];
  const transaction = deps.persistenceAdmission!.transact(
    "floodForecast:floodForecast",
    ["telegramRevisionGate", "standbyStateStore", "floodForecastState"],
    (draft) => {
      const gate = TelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
      const flood = FloodForecastStateHolder.fromSnapshot(draft.floodForecastState);
      const result = processFloodForecast(msg, {
        floodForecastState: flood,
        revisionGate: gate,
        onRevisionDecision: deps.onRevisionDecision == null
          ? undefined
          : (decision) => callbacks.push(() => deps.onRevisionDecision!(decision)),
        onFloodRevisionDecision: deps.onFloodRevisionDecision == null
          ? undefined
          : (decision) => callbacks.push(() => deps.onFloodRevisionDecision!(decision)),
        persistenceAdmission: undefined,
      }, nowMs);
      draft.telegramRevisionGate = gate.cloneSnapshot();
      draft.floodForecastState = flood.cloneSnapshot();
      if (result.kind === "ok" && result.outcome.presentation.floodStateMutationAccepted === true) {
        const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
        standby.applyEvent(toPresentationEvent(result.outcome), nowMs);
        draft.standbyStateStore = standby.cloneSnapshot();
      }
      return { kind: "accepted", value: result, durableChanged: true };
    },
  );
  if (transaction.kind !== "committed") {
    log.warn(`[standby-admission] key=floodForecast:floodForecast reason=${transaction.kind === "rejected" ? transaction.reason : "staleVersion"}`);
    return { kind: "suppressed" };
  }
  for (const callback of callbacks) callback();
  if (transaction.value.kind === "ok") {
    transaction.value.outcome.presentation.standbyStateProjectionCommitted = true;
  }
  return transaction.value;
}

/**
 * Flood forecast processing after the common semantic revision gate.
 * VXSU reports intentionally skip station digest state, while all schemas share
 * the EventID lifecycle watermark and cancellation tombstone.
 */
export function processFloodForecast(
  msg: WsDataMessage,
  deps: FloodForecastProcessDeps,
  nowMs: number = Date.now(),
): FloodForecastProcessResult {
  if (deps.persistenceAdmission != null) {
    return processFloodForecastWithAdmission(msg, deps, nowMs);
  }
  const info = parseFloodForecast(msg);
  if (info == null) return { kind: "parse-failed" };

  const policy = floodForecastRevisionFamilyPolicy(msg.head.type);
  if (policy == null) return { kind: "parse-failed" };
  deps.revisionGate.expireRevisionFamily(
    policy.domain,
    policy.revisionFamily,
    nowMs,
    FLOOD_FORECAST_RETENTION_MS,
  );

  const extractedSubject = policy.extractStateSubjectKey(info.meta, info);
  const subject = typeof extractedSubject === "string" ? extractedSubject : null;
  const cancellationTargets = info.meta.infoType.value === "取消"
    ? policy.extractCancellationTarget(info.meta, info)
    : null;
  const { meta: _meta, isTest: _isTest, ...semanticPayload } = info;
  const payloadFingerprint = semanticPayloadFingerprint(semanticPayload);
  const gateInput: TelegramRevisionGateInput = {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
    stateSubjectKey: subject,
    transientSubjectKey: subject == null ? `flood:${msg.id}` : null,
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
    retainForFamilyCapacity: false,
    allowMissingSerial: policy.allowMissingSerial,
    payloadFingerprint,
    legacyRevisionKey: subject == null ? null : info.eventId,
    legacyRevisionKeyProvenance: subject == null ? null : "eventId",
  };
  const evaluation = deps.revisionGate.evaluate(gateInput);
  if (!evaluation.accepted) {
    deps.onRevisionDecision?.(evaluation);
    return { kind: "suppressed" };
  }
  const decision = deps.revisionGate.decide(gateInput);
  deps.onRevisionDecision?.(decision);
  if (!decision.accepted) return { kind: "suppressed" };

  const { frameLevel, soundLevel, maxLevel, maxRank } =
    resolveFloodForecastLevels(info);
  let suppressNotify = false;
  let diff: FloodForecastDiff | null = null;

  if (subject == null) {
    // Incomplete identity is display/ticker-only and never authoritative.
    suppressNotify = true;
  } else if (decision.kind === "clearCurrent") {
    deps.floodForecastState.rollback(info.eventId);
  } else if (
    info.schema === "vxko50"
    && info.infoType !== "訂正"
    && info.rawStations.length > 0
    && floodForecastHasUnderstoodStations(info)
  ) {
    diff = deps.floodForecastState.diffAndUpdate(
      info.eventId,
      buildStationDigests(info),
      info.reportDateTime,
      nowMs,
    );
    suppressNotify = !diff.hasChange;
  } else if (info.schema === "vxko50") {
    // Correction and headline-only reports bypass station digest dedup.
    deps.floodForecastState.touch(info.eventId, nowMs);
  }

  const activeSubjects = deps.revisionGate.activeRevisionFamilySubjects(
    policy.domain,
    policy.revisionFamily,
  );
  const activeEventIds = activeSubjects.flatMap((key) =>
    key.startsWith("flood:event:") ? [key.slice("flood:event:".length)] : []);
  deps.floodForecastState.retainActiveEventIds(activeEventIds);
  if (subject != null) deps.onFloodRevisionDecision?.(decision);

  return {
    kind: "ok",
    outcome: {
      domain: "floodForecast",
      msg,
      headType: msg.head.type,
      statsCategory: "floodForecast",
      parsed: info,
      diff,
      maxLevel,
      maxRank,
      stats: { shouldRecord: true, eventId: info.eventId },
      presentation: {
        frameLevel,
        soundLevel,
        notifyCategory: "floodForecast",
        suppressNotify,
        acceptedCorrection: decision.isCorrection,
        floodStateMutationAccepted: subject != null,
        floodActiveEventIds: activeEventIds,
        floodAppliedSemanticKey: telegramRevisionSemanticKey(gateInput),
      },
    },
  };
}
