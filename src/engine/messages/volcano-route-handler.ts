/**
 * 火山電文のルーティング処理を一元管理するハンドラ。
 *
 * 火山は VFVO53 アグリゲータによるバッチ集約があるため、
 * 他ドメインの processMessage() → outcome → display の線形フローとは異なる。
 * このハンドラが火山の パース → 集約 → 通知 → 表示 を担当する。
 */

import type {
  WsDataMessage,
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoInfo,
  ParsedVolcanoTextInfo,
} from "../../types";
import * as log from "../../logger";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import { compareTelegramRevisions, telegramRevision } from "../../dmdata/telegram-meta";
import { VolcanoVfvo53Aggregator, type FlushOptions, type Vfvo53BatchItems } from "./volcano-vfvo53-aggregator";
import { VolcanoStateHolder } from "./volcano-state";
import { Notifier } from "../notification/notifier";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation } from "../presentation/volcano-presentation";
import { buildVolcanoOutcome } from "../presentation/processors/process-volcano";
import type { VolcanoBatchOutcome, ProcessOutcome } from "../presentation/types";
import type { DisplayCallbacks } from "./display-callbacks";
import {
  semanticPayloadFingerprint,
  telegramRevisionSemanticKey,
  type TelegramRevisionDecision,
  type TelegramRevisionGate,
  type TelegramRevisionGateInput,
} from "./telegram-revision-gate";
import {
  normalizeVolcanoAshfallEventId,
  projectVolcanoAshfall,
} from "./volcano-ashfall-projector";
import { VolcanoTransactionCoordinator } from "./volcano-transaction-coordinator";
import type { VolcanoRepairStateV1 } from "./volcano-state";
import {
  volcanoAlertSubjectKey,
  volcanoEruptionSubjectKey,
  volcanoRevisionFamilyPolicy,
  volcanoTextAlertStateEntries,
} from "./revision-family-registry";

// ── 型定義 ──

/** 表示パイプライン関数 (message-router から注入) */
export type DisplayPipelineFn = (
  outcome: ProcessOutcome | VolcanoBatchOutcome,
  displayFn: () => void,
) => boolean;

/** VolcanoRouteHandler の設定 */
export interface VolcanoRouteHandlerDeps {
  volcanoState: VolcanoStateHolder;
  notifier: Notifier;
  runDisplayPipeline: DisplayPipelineFn;
  display?: DisplayCallbacks;
  revisionGate?: TelegramRevisionGate;
  volcanoTransactionCoordinator?: VolcanoTransactionCoordinator;
  onRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onVolcanoRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onFoundationNotified?: (isCorrection: boolean) => void;
  onFoundationPresented?: () => void;
}

export type VolcanoRouteHandleResult =
  | { kind: "accepted"; parsed: ParsedVolcanoInfo }
  | { kind: "parseFailed" }
  | { kind: "policyMissing" }
  | { kind: "suppressed" };

interface VolcanoFoundationResult {
  suppressed: boolean;
  authoritative: boolean;
  /** Invalid VFVO54/55 identity/revision: preserve per-message surfaces only. */
  stateNeutralTransient?: boolean;
  acceptedCorrection: boolean;
  acceptedSubjects: string[];
  activeAlertSubjects: string[];
  activeEruptionSubjects: string[];
}

type VolcanoPreAggregateFoundationResult = VolcanoFoundationResult & {
  suppressed: false;
};

/** Phase 5C の volcano whole-payload fingerprint version。変更時は alias migration 必須。 */
export const VOLCANO_PLUME_HEIGHT_FINGERPRINT_VERSION = "volcano-plume-height-v1";

function legacyVolcanoFingerprintPayload(info: ParsedVolcanoInfo): object {
  const {
    meta: _meta,
    isTest: _isTest,
    plumeHeightAboveCraterValue: _plumeHeightAboveCraterValue,
    plumeHeightAboveSeaLevelValue: _plumeHeightAboveSeaLevelValue,
    ...payload
  } = info;
  return payload;
}

export function volcanoPayloadFingerprints(info: ParsedVolcanoInfo): Pick<
  TelegramRevisionGateInput,
  "payloadFingerprint" | "payloadFingerprintAliases"
> {
  const legacyPayload = legacyVolcanoFingerprintPayload(info);
  if (
    info.plumeHeightAboveCraterValue == null
    && info.plumeHeightAboveSeaLevelValue == null
  ) {
    return { payloadFingerprint: semanticPayloadFingerprint(legacyPayload) };
  }
  const { meta: _meta, isTest: _isTest, ...canonicalPayload } = info;
  return {
    payloadFingerprint: semanticPayloadFingerprint({
      fingerprintVersion: VOLCANO_PLUME_HEIGHT_FINGERPRINT_VERSION,
      payload: canonicalPayload,
    }),
    payloadFingerprintAliases: [semanticPayloadFingerprint(legacyPayload)],
  };
}

// ── 本体 ──

export class VolcanoRouteHandler {
  private volcanoState: VolcanoStateHolder;
  private readonly notifier: Notifier;
  private readonly runDisplayPipeline: DisplayPipelineFn;
  private readonly display?: DisplayCallbacks;
  private revisionGate?: TelegramRevisionGate;
  private readonly volcanoTransactionCoordinator?: VolcanoTransactionCoordinator;
  private readonly onRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  private readonly onVolcanoRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  private readonly onFoundationNotified?: (isCorrection: boolean) => void;
  private readonly onFoundationPresented?: () => void;
  private readonly aggregator: VolcanoVfvo53Aggregator;
  private lastImmediateAccepted: boolean | null = null;
  private bufferedRevisionNotifications: Array<{
    target: "all" | "volcano";
    decision: TelegramRevisionDecision;
  }> | null = null;
  private scratchRepairState: VolcanoRepairStateV1 | null = null;
  private readonly preAggregatedFoundation = new Map<string, VolcanoPreAggregateFoundationResult & {
    outcome: ReturnType<typeof buildVolcanoOutcome>;
  }>();

  constructor(deps: VolcanoRouteHandlerDeps) {
    this.volcanoState = deps.volcanoState;
    this.notifier = deps.notifier;
    this.runDisplayPipeline = deps.runDisplayPipeline;
    this.display = deps.display;
    this.revisionGate = deps.revisionGate;
    this.volcanoTransactionCoordinator = deps.volcanoTransactionCoordinator;
    this.onRevisionDecision = deps.onRevisionDecision;
    this.onVolcanoRevisionDecision = deps.onVolcanoRevisionDecision;
    this.onFoundationNotified = deps.onFoundationNotified;
    this.onFoundationPresented = deps.onFoundationPresented;

    this.aggregator = new VolcanoVfvo53Aggregator(
      (info, opts, msg) => this.emitSingle(info, opts, msg),
      (batch, opts) => this.emitBatch(batch, opts),
    );
  }

  /**
   * 火山電文を処理する。
   * parse failure / policy 欠落 / semantic suppression を区別して返す。
   */
  handle(msg: WsDataMessage): VolcanoRouteHandleResult {
    const volcanoInfo = parseVolcanoTelegram(msg);
    if (!volcanoInfo) return { kind: "parseFailed" };

    const policy = volcanoRevisionFamilyPolicy(msg.head.type);
    if (policy == null) return { kind: "policyMissing" };
    if (
      policy.revisionFamily === "volcanoAshfall"
      || policy.revisionFamily === "volcanoAshfallScheduled"
      || policy.revisionFamily === "volcanoTransient"
    ) {
      if (policy.revisionFamily === "volcanoAshfall" && volcanoInfo.kind === "ashfall") {
        // The scheduled batch must be visible before a live rapid/detailed
        // report enters durable admission. Expiry is its own completed
        // transaction and precedes the presentation protection snapshot, so a
        // later candidate rejection cannot resurrect an expired slice.
        this.aggregator.interruptPending();
        if (!this.sweepStatefulFoundation(policy.revisionFamily, volcanoInfo.meta.receivedAtMs)) {
          return { kind: "suppressed" };
        }
      }
      // Freeze presentation after the independent expiry commit but before the
      // incoming candidate mutation. Rapid/detailed reports enter durable
      // admission before the aggregator invokes emitSingle(), so rebuilding
      // there would observe the committed slice.
      const outcome = buildVolcanoOutcome(msg, volcanoInfo, this.volcanoState);
      const foundation = this.applyPreAggregateFoundation(volcanoInfo, msg, policy);
      if (foundation == null) return { kind: "suppressed" };
      this.preAggregatedFoundation.set(msg.id, { ...foundation, outcome });
      while (this.preAggregatedFoundation.size > 256) {
        const oldest = this.preAggregatedFoundation.keys().next().value as string | undefined;
        if (oldest == null) break;
        this.preAggregatedFoundation.delete(oldest);
      }
    }

    this.lastImmediateAccepted = null;
    this.aggregator.handle(volcanoInfo, msg);
    return this.lastImmediateAccepted === false
      ? { kind: "suppressed" }
      : { kind: "accepted", parsed: volcanoInfo };
  }

  /** 保留中の火山バッファを flush してリソースを破棄する */
  flushAndDispose(): void {
    this.aggregator.flushAndDispose();
  }

  // ── private: emit callbacks ──

  private emitSingle(
    info: ParsedVolcanoInfo,
    opts?: FlushOptions,
    msg?: WsDataMessage,
  ): void {
    const preAggregated = msg == null ? null : this.preAggregatedFoundation.get(msg.id) ?? null;
    if (msg != null) this.preAggregatedFoundation.delete(msg.id);
    if (preAggregated == null && msg != null) {
      const policy = volcanoRevisionFamilyPolicy(msg.head.type);
      if ((policy?.revisionFamily === "volcanoAlert"
        || policy?.revisionFamily === "volcanoEruption")
        && !this.sweepStatefulFoundation(policy.revisionFamily, info.meta.receivedAtMs)) {
        this.lastImmediateAccepted = false;
        return;
      }
    }
    const outcome = preAggregated?.outcome ?? (msg
      ? buildVolcanoOutcome(msg, info, this.volcanoState)
      : null);
    const presentation = outcome?.volcanoPresentation
      ?? resolveVolcanoPresentation(info, this.volcanoState);
    const foundation = preAggregated ?? (msg == null ? null : this.applyFoundation(info, msg));
    if (foundation?.suppressed === true) {
      this.lastImmediateAccepted = false;
      return;
    }
    // With a revision gate installed, a null foundation result means the
    // coordinated candidate was rejected (serialization, capacity, version,
    // or an atomic multi-subject failure).  Never fall through to the legacy
    // direct holder mutation after that rejection.
    if (foundation == null && msg != null && this.revisionGate != null) {
      this.lastImmediateAccepted = false;
      return;
    }
    this.lastImmediateAccepted = true;
    if (outcome != null && foundation != null) {
      outcome.presentation.volcanoStateMutationAccepted = foundation.authoritative;
      outcome.presentation.volcanoStandbyProjectionCommitted =
        foundation.authoritative && this.volcanoTransactionCoordinator != null;
      outcome.presentation.volcanoAcceptedSubjects = foundation.acceptedSubjects;
      outcome.presentation.volcanoActiveAlertSubjects = foundation.activeAlertSubjects;
      outcome.presentation.volcanoActiveEruptionSubjects = foundation.activeEruptionSubjects;
      outcome.presentation.acceptedCorrection = foundation.acceptedCorrection;
    } else if (foundation == null) {
      this.volcanoState.update(info);
    }

    // 通知は filter 非適用
    const notificationEligible = foundation == null
      || foundation.authoritative
      || foundation.stateNeutralTransient === true;
    if (opts?.notify !== false && notificationEligible) {
      this.notifier.notifyVolcano(info, presentation);
      if (foundation?.authoritative === true) {
        this.onFoundationNotified?.(foundation.acceptedCorrection);
      }
    }

    // PresentationEvent パイプライン
    if (outcome) {
      const presented = this.runDisplayPipeline(outcome, () =>
        this.display?.displayVolcano(info, presentation),
      );
      if (foundation?.authoritative === true && presented) this.onFoundationPresented?.();
    } else {
      // msg キャッシュがない場合はフォールバック表示
      this.display?.displayVolcano(info, presentation);
    }

  }

  private notifyRevisionDecision(
    target: "all" | "volcano",
    decision: TelegramRevisionDecision,
  ): void {
    if (this.bufferedRevisionNotifications != null) {
      this.bufferedRevisionNotifications.push({ target, decision: structuredClone(decision) });
      return;
    }
    if (target === "all") this.onRevisionDecision?.(decision);
    else this.onVolcanoRevisionDecision?.(decision);
  }

  private runVolcanoTransaction<T>(
    family: "volcanoAlert" | "volcanoEruption" | "volcanoAshfall",
    operation: () => T,
  ): T | null {
    const coordinator = this.volcanoTransactionCoordinator;
    if (coordinator == null || this.revisionGate == null) return operation();
    const realState = this.volcanoState;
    const realGate = this.revisionGate;
    const previousBuffer = this.bufferedRevisionNotifications;
    const previousRepair = this.scratchRepairState;
    const notifications: NonNullable<typeof this.bufferedRevisionNotifications> = [];
    const transaction = coordinator.transact(family, (scratch) => {
      this.volcanoState = scratch.holder;
      this.revisionGate = scratch.gate;
      this.scratchRepairState = scratch.repair;
      this.bufferedRevisionNotifications = notifications;
      try {
        const value = operation();
        return {
          kind: "accepted" as const,
          value,
          durableChanged: notifications.some(({ decision }) =>
            decision.accepted
            || decision.semanticKeyMigrated === true
            || decision.preAdmissionDurableChanged === true),
        };
      } finally {
        this.volcanoState = realState;
        this.revisionGate = realGate;
        this.scratchRepairState = previousRepair;
        this.bufferedRevisionNotifications = previousBuffer;
      }
    });
    if (transaction.kind !== "committed") return null;
    for (const notification of notifications) {
      this.notifyRevisionDecision(notification.target, notification.decision);
    }
    return transaction.value;
  }

  private sweepStatefulFoundation(
    family: "volcanoAlert" | "volcanoEruption" | "volcanoAshfall",
    expiryNowMs: number,
  ): boolean {
    if (this.volcanoTransactionCoordinator == null || this.revisionGate == null) return true;
    const sweep = this.volcanoTransactionCoordinator.sweepAll(expiryNowMs);
    if (sweep.kind === "committed") return true;
    log.warn(`[standby-admission] key=volcano:${family} sweep=${sweep.kind === "rejected" ? sweep.reason : "staleVersion"}`);
    return false;
  }

  /**
   * A terminal report may legitimately leave no composite (H0 -> gate-only,
   * or removal of its last slice).  If another slice keeps the composite
   * alive, however, the accepted transport ID must be present in the flat
   * cumulative set; a full 4,096-entry set therefore rejects the whole
   * transaction instead of committing only the tombstone.
   */
  private clearVolcanoSlice(
    slice: "alert" | "eruption" | "ashfall",
    volcanoCode: string,
    sourceEventId: string,
    volcanoName: string,
  ): boolean {
    const canonicalSourceId = sourceEventId.normalize("NFC").trim();
    if (canonicalSourceId === ""
      || canonicalSourceId.length > 256
      || /\p{Cc}/u.test(canonicalSourceId)) return false;
    if (slice === "alert") {
      this.volcanoState.clearAlert(volcanoCode, sourceEventId, volcanoName);
    } else if (slice === "eruption") {
      this.volcanoState.clearEruption(volcanoCode, sourceEventId, volcanoName);
    } else {
      this.volcanoState.clearAshfall(volcanoCode, sourceEventId, volcanoName);
    }
    let remaining = this.volcanoState.composite(volcanoCode);
    if (remaining == null) return true;
    if (remaining[slice] == null
      && remaining.sourceEventIds.includes(canonicalSourceId)) return true;

    // A saturated lineage need not retain the terminal ID when removal of the
    // target slice also removes the composite and its lineage as one unit.
    const hasOtherSlice = (slice !== "alert" && remaining.alert != null)
      || (slice !== "eruption" && remaining.eruption != null)
      || (slice !== "ashfall" && remaining.ashfall != null);
    if (hasOtherSlice || remaining[slice] == null) return false;
    if (slice === "alert") {
      this.volcanoState.clearAlert(volcanoCode);
    } else if (slice === "eruption") {
      this.volcanoState.clearEruption(volcanoCode);
    } else {
      this.volcanoState.clearAshfall(volcanoCode);
    }
    remaining = this.volcanoState.composite(volcanoCode);
    return remaining == null;
  }

  private resolveKnownLiveOmissions(
    info: ParsedVolcanoInfo,
    decision: TelegramRevisionDecision,
  ): void {
    if (!decision.accepted || this.scratchRepairState == null) return;
    const code = info.volcanoCode.normalize("NFC").trim();
    if (code === "") return;
    const family = info.kind === "eruption" ? "volcanoEruption" : "volcanoAlert";
    const subject = family === "volcanoEruption"
      ? volcanoEruptionSubjectKey(code)
      : volcanoAlertSubjectKey(code);
    if (subject == null) return;
    const rawRevision = telegramRevision(info.meta);
    const incomingComparison = {
      stateSubjectKey: subject,
      revision: {
        ...rawRevision,
        eventId: { raw: subject, value: subject, valid: true },
        type: { raw: family, value: family, valid: true },
      },
    };
    const supersedes = (lastKnown: import("../../types").TelegramRevisionComparisonInput | null): boolean =>
      lastKnown != null
      && compareTelegramRevisions(
        incomingComparison,
        lastKnown,
        "reportDateTimeThenSerial",
      ) === "newer";
    if (info.kind === "alert" || info.kind === "text" && info.type === "VFVO51") {
      const sourceFamily = info.type;
      this.scratchRepairState.unrecoverableAlertOmissions =
        this.scratchRepairState.unrecoverableAlertOmissions.filter((omission) =>
          omission.scope !== "volcano"
          || omission.volcanoCode !== code
          || omission.reason !== "operationalV2ProvenanceLost"
            && omission.sourceFamily !== sourceFamily
          || !supersedes(omission.lastKnownComparison));
    }
    if (info.kind === "eruption") {
      this.scratchRepairState.unrecoverableEruptionOmissions =
        this.scratchRepairState.unrecoverableEruptionOmissions.filter((omission) =>
          omission.scope !== "volcano"
          || omission.volcanoCode !== code
          || !supersedes(omission.lastKnownComparison));
    }
  }

  private applyFoundation(
    info: ParsedVolcanoInfo,
    msg: WsDataMessage,
  ): VolcanoFoundationResult | null {
    const policy = volcanoRevisionFamilyPolicy(msg.head.type);
    if (policy == null || (policy.revisionFamily !== "volcanoAlert"
      && policy.revisionFamily !== "volcanoEruption")) {
      return this.applyFoundationDirect(info, msg);
    }
    return this.runVolcanoTransaction(
      policy.revisionFamily,
      () => this.applyFoundationDirect(info, msg),
    );
  }

  private applyFoundationDirect(
    info: ParsedVolcanoInfo,
    msg: WsDataMessage,
  ): VolcanoFoundationResult | null {
    const policy = volcanoRevisionFamilyPolicy(msg.head.type);
    if (policy == null || this.revisionGate == null) return null;

    const candidates: Array<{
      parsed: ParsedVolcanoInfo;
      subject: string | null;
      apply: (
        decision: TelegramRevisionDecision,
        subject: string,
        appliedSemanticKey: string,
      ) => boolean;
    }> = [];
    if (info.kind === "text" && info.type === "VFVO51") {
      const bySubject = new Map<string, typeof candidates[number]>();
      for (const entry of volcanoTextAlertStateEntries(info)) {
        const subject = volcanoAlertSubjectKey(entry.volcanoCode);
        if (subject == null) continue;
        const parsed: ParsedVolcanoTextInfo = {
          ...info,
          volcanoCode: entry.volcanoCode,
          volcanoName: entry.volcanoName,
          alertLevel: entry.alertLevel,
          alertLevelCode: entry.alertLevelCode,
          alertClasses: entry.alertClass == null ? [] : [{
            volcanoCode: entry.volcanoCode,
            volcanoName: entry.volcanoName,
            alertClass: { ...entry.alertClass },
          }],
          alertStateEntries: [{
            ...entry,
            alertClass: entry.alertClass == null ? null : { ...entry.alertClass },
          }],
        };
        // 同一 subject は電文順の最後を正とし、gate・holder・stats を一度だけ動かす。
        bySubject.delete(subject);
        bySubject.set(subject, {
          parsed,
          subject,
          apply: (decision, subject, appliedSemanticKey) => {
            const applied = decision.kind === "clearCurrent"
              ? this.clearVolcanoSlice(
                  "alert", entry.volcanoCode, msg.id, entry.volcanoName,
                )
              : this.volcanoState.applyAcceptedTextAlert(entry, info.reportDateTime, {
              sourceEventId: msg.id,
              revision: {
                reportTimeMs: info.meta.reportDateTime.epochMs!,
                serial: info.meta.serial.valid ? info.meta.serial.raw : null,
              },
              appliedSemanticKey,
            });
            this.retainFoundationSubjects();
            return applied;
          },
        });
      }
      candidates.push(...bySubject.values());
      if (candidates.length === 0) {
        // 対象火山コードを一件も確定できない VFVO51 は fail-open 表示だけを許す。
        // foundation 非対象へ戻すと通知・durable projection が旧経路を貫通する。
        candidates.push({
          parsed: info,
          subject: null,
          apply: () => true,
        });
      }
    } else if (info.kind === "alert") {
      candidates.push({
        parsed: info,
        subject: volcanoAlertSubjectKey(info.volcanoCode),
        apply: (decision, _subject, appliedSemanticKey) => {
          const applied = decision.kind === "clearCurrent"
            ? this.clearVolcanoSlice(
                "alert", info.volcanoCode, msg.id, info.volcanoName,
              )
            : this.volcanoState.applyAcceptedAlert(info, {
            sourceEventId: msg.id,
            revision: {
              reportTimeMs: info.meta.reportDateTime.epochMs!,
              serial: info.meta.serial.valid ? info.meta.serial.raw : null,
            },
            appliedSemanticKey,
          });
          this.retainFoundationSubjects();
          return applied;
        },
      });
    } else if (info.kind === "eruption") {
      let resolvedCode = info.volcanoCode.trim();
      if (resolvedCode === "" && info.infoType === "取消" && info.meta.eventId.value != null) {
        const eventId = info.meta.eventId.value.trim();
        const gateSubject = eventId === ""
          ? null
          : this.revisionGate.stateSubjectForLegacyRevisionKey(
            policy.domain,
            policy.revisionFamily,
            `volcano:event:${eventId}`,
            info.meta.receivedAtMs,
          );
        resolvedCode = this.volcanoState.resolveEruptionCancellation(eventId)
          ?? gateSubject?.replace(/^volcano:eruption:/, "")
          ?? "";
      }
      const parsed = resolvedCode === info.volcanoCode ? info : { ...info, volcanoCode: resolvedCode };
      candidates.push({
        parsed,
        subject: volcanoEruptionSubjectKey(resolvedCode),
        apply: (decision, _subject, appliedSemanticKey) => {
          const applied = decision.kind === "clearCurrent"
            ? this.clearVolcanoSlice(
                "eruption", resolvedCode, msg.id, info.volcanoName,
              )
            : this.volcanoState.applyAcceptedEruption(parsed, info.meta.eventId.value, {
            sourceEventId: msg.id,
            revision: {
              reportTimeMs: info.meta.reportDateTime.epochMs!,
              serial: info.meta.serial.valid ? info.meta.serial.raw : null,
            },
            appliedSemanticKey,
          });
          this.retainFoundationSubjects();
          return applied;
        },
      });
    }
    if (candidates.length === 0) return null;

    const acceptedSubjects: string[] = [];
    let acceptedCorrection = false;
    let failOpen = false;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const payloadFingerprints = volcanoPayloadFingerprints(candidate.parsed);
      const cancellationTargets = candidate.parsed.meta.infoType.value === "取消"
        ? policy.extractCancellationTarget(candidate.parsed.meta, candidate.parsed)
        : null;
      const terminal = policy.terminalPredicate(candidate.parsed.meta, candidate.parsed);
      const deactivation = policy.deactivationPredicate(candidate.parsed.meta, candidate.parsed);
      const isCancellation = candidate.parsed.meta.infoType.value === "取消"
        || terminal
        || deactivation;
      const incomingEventId = candidate.parsed.meta.eventId.value?.trim() || null;
      const existingLegacyRevision = candidate.subject == null
        ? null
        : this.revisionGate.legacyRevisionIdentityForSubject(
          policy.domain,
          policy.revisionFamily,
          candidate.subject,
        );
      const holderLegacyRevision = candidate.subject == null
        || policy.revisionFamily !== "volcanoEruption"
        ? null
        : (() => {
          const eventId = this.volcanoState.eruptionEventId(
            candidate.subject.slice("volcano:eruption:".length),
          );
          return eventId == null ? null : {
            key: `volcano:event:${eventId}`,
            provenance: "eventId" as const,
          };
        })();
      const legacyRevision = candidate.subject == null
        ? null
        : policy.revisionFamily === "volcanoAlert"
          ? { key: candidate.subject, provenance: "codeFallback" as const }
          : incomingEventId != null
            ? { key: `volcano:event:${incomingEventId}`, provenance: "eventId" as const }
            : isCancellation && existingLegacyRevision?.provenance === "eventId"
              ? existingLegacyRevision
              : isCancellation && holderLegacyRevision != null
                ? holderLegacyRevision
                : isCancellation && existingLegacyRevision != null
                  ? {
                    key: existingLegacyRevision.key,
                    provenance: existingLegacyRevision.provenance ?? "codeFallback" as const,
                  }
                  : {
                    key: `volcano:event:${candidate.subject.slice("volcano:eruption:".length)}`,
                    provenance: "codeFallback" as const,
                  };
      const input: TelegramRevisionGateInput = {
        domain: policy.domain,
        revisionFamily: policy.revisionFamily,
        stateSubjectKey: candidate.subject,
        transientSubjectKey: candidate.subject == null ? `volcano:${msg.id}:${index}` : null,
        meta: candidate.parsed.meta,
        comparator: policy.comparator,
        cancellationPolicy: policy.cancellationPolicy,
        terminal,
        deactivation,
        cancellationTargetMatches: cancellationTargets == null || candidate.subject == null
          ? candidate.parsed.meta.infoType.value !== "取消"
          : cancellationTargets.includes(candidate.subject),
        durable: policy.durable,
        tombstoneRetentionMs: policy.tombstoneRetentionMs,
        maxSubjects: policy.maxSubjects,
        familyCapacityMode: policy.familyCapacityMode,
        allowMissingSerial: policy.allowMissingSerial,
        ...payloadFingerprints,
        legacyRevisionKey: legacyRevision?.key ?? null,
        legacyRevisionKeyProvenance: legacyRevision?.provenance ?? null,
        ...(policy.revisionFamily === "volcanoAlert"
          && (candidate.parsed.type === "VFVO50"
            || candidate.parsed.type === "VFVO51"
            || candidate.parsed.type === "VFSVii")
          ? {
              volcanoProvenance: {
                kind: "alert" as const,
                sourceFamily: candidate.parsed.type,
              },
            }
          : {}),
      };
      const decision = this.revisionGate.decide(input);
      this.notifyRevisionDecision("all", decision);
      if (!decision.accepted) {
        if (this.volcanoTransactionCoordinator != null && candidates.length > 1) {
          // A VFVO51 telegram is one atomic mutation.  A stale, duplicate,
          // invalid, or capacity-rejected subject must not leave sibling
          // subjects (or semantic-key migrations) committed from the same
          // transport message.
          throw new Error(`volcano multi-subject gate admission failed: ${decision.kind}`);
        }
        if (decision.semanticKeyMigrated) this.notifyRevisionDecision("volcano", decision);
        continue;
      }
      if (candidate.subject == null) {
        failOpen = true;
        continue;
      }
      if (!candidate.apply(decision, candidate.subject, telegramRevisionSemanticKey(input))) {
        throw new Error("volcano holder admission failed");
      }
      this.resolveKnownLiveOmissions(candidate.parsed, decision);
      acceptedSubjects.push(candidate.subject);
      acceptedCorrection ||= decision.isCorrection;
      this.notifyRevisionDecision("volcano", decision);
    }
    const authoritative = acceptedSubjects.length > 0;
    return {
      suppressed: !authoritative && !failOpen,
      authoritative,
      acceptedCorrection,
      acceptedSubjects,
      activeAlertSubjects: this.revisionGate.activeRevisionFamilySubjects("volcano", "volcanoAlert"),
      activeEruptionSubjects: this.revisionGate.activeRevisionFamilySubjects("volcano", "volcanoEruption"),
    };
  }

  private applyPreAggregateFoundation(
    info: ParsedVolcanoInfo,
    msg: WsDataMessage,
    policy: NonNullable<ReturnType<typeof volcanoRevisionFamilyPolicy>>,
  ): VolcanoPreAggregateFoundationResult | null {
    if (policy.revisionFamily !== "volcanoAshfall") {
      return this.applyPreAggregateFoundationDirect(info, msg, policy);
    }
    return this.runVolcanoTransaction(
      "volcanoAshfall",
      () => this.applyPreAggregateFoundationDirect(info, msg, policy),
    );
  }

  private applyPreAggregateFoundationDirect(
    info: ParsedVolcanoInfo,
    msg: WsDataMessage,
    policy: NonNullable<ReturnType<typeof volcanoRevisionFamilyPolicy>>,
  ): VolcanoPreAggregateFoundationResult | null {
    const stateNeutralTransient = (): VolcanoPreAggregateFoundationResult => ({
      suppressed: false,
      authoritative: false,
      stateNeutralTransient: true,
      acceptedCorrection: false,
      acceptedSubjects: [],
      activeAlertSubjects: this.revisionGate?.activeRevisionFamilySubjects(
        "volcano", "volcanoAlert",
      ) ?? [],
      activeEruptionSubjects: this.revisionGate?.activeRevisionFamilySubjects(
        "volcano", "volcanoEruption",
      ) ?? [],
    });
    if (this.revisionGate == null) return {
      suppressed: false,
      authoritative: true,
      acceptedCorrection: info.infoType === "訂正",
      acceptedSubjects: [],
      activeAlertSubjects: [],
      activeEruptionSubjects: [],
    };
    if (
      policy.revisionFamily === "volcanoAshfall"
      && info.kind === "ashfall"
      && info.infoType === "取消"
      && policy.extractStateSubjectKey(info.meta, info) == null
    ) {
      const rawCode = info.volcanoCode.normalize("NFC");
      // EventID reverse lookup is reserved for an actually blank code.  A
      // nonblank overlong/control-bearing identity must stay state-neutral and
      // must not be reinterpreted as an omitted code.
      if (/\p{Cc}/u.test(rawCode) || rawCode.trim() !== "") {
        return stateNeutralTransient();
      }
      const eventId = normalizeVolcanoAshfallEventId(info.meta.eventId.value);
      if (eventId == null) return stateNeutralTransient();
      const matches = this.revisionGate.cloneSnapshot().states.filter((entry) =>
        entry.key.startsWith("volcano:volcanoAshfall:")
        && entry.volcanoProvenance?.kind === "ashfall"
        && entry.volcanoProvenance.actualEventId === eventId)
        .map((entry) => entry.comparison.stateSubjectKey)
        .filter((value): value is string => value != null);
      const unique = [...new Set(matches)];
      if (unique.length !== 1 || !unique[0]!.startsWith("volcano:ashfall:")) {
        return stateNeutralTransient();
      }
      info = {
        ...info,
        volcanoCode: unique[0]!.slice("volcano:ashfall:".length),
      };
    }
    const extracted = policy.extractStateSubjectKey(info.meta, info);
    const subjects = extracted == null
      ? []
      : [...new Set(typeof extracted === "string" ? [extracted] : extracted)];
    const subject = subjects.length === 1 ? subjects[0] : null;
    const targets = policy.extractCancellationTarget(info.meta, info);
    const payloadFingerprints = volcanoPayloadFingerprints(info);
    const ashfallEventId = policy.revisionFamily === "volcanoAshfall"
      ? normalizeVolcanoAshfallEventId(info.meta.eventId.value)
      : null;
    const appliedSemanticKey = telegramRevisionSemanticKey({
      meta: info.meta,
      payloadFingerprint: payloadFingerprints.payloadFingerprint,
    });
    let ashfallProjection: ReturnType<typeof projectVolcanoAshfall> | null = null;
    // Invalid transport identity is deliberately transient: never create a durable watermark.
    if (policy.revisionFamily === "volcanoAshfall" && info.kind === "ashfall") {
      const current = subject == null
        ? null
        : this.volcanoState.ashfall(subject.slice("volcano:ashfall:".length));
      ashfallProjection = projectVolcanoAshfall(info, {
        classificationNowMs: info.meta.receivedAtMs,
        appliedSemanticKey,
        generation: 1,
      });
      if (ashfallProjection.kind === "transient") return stateNeutralTransient();
      if (ashfallProjection.kind === "active" && current != null) {
        const generation = current.generation + 1;
        if (!Number.isSafeInteger(generation)) return null;
        ashfallProjection = projectVolcanoAshfall(info, {
          classificationNowMs: info.meta.receivedAtMs,
          appliedSemanticKey,
          generation,
        });
        if (ashfallProjection.kind !== "active") return null;
      }
    }
    const decision = this.revisionGate.decide({
      domain: policy.domain,
      revisionFamily: policy.revisionFamily,
      stateSubjectKey: subject,
      transientSubjectKey: subject == null ? `volcano:${policy.revisionFamily}:${msg.id}` : null,
      meta: info.meta,
      comparator: policy.comparator,
      cancellationPolicy: policy.cancellationPolicy,
      terminal: policy.terminalPredicate(info.meta, info),
      deactivation: policy.deactivationPredicate(info.meta, info),
      cancellationTargetMatches: targets == null || subject == null
        ? info.meta.infoType.value !== "取消" || subject == null
        : targets.includes(subject),
      durable: policy.durable,
      tombstoneRetentionMs: policy.tombstoneRetentionMs,
      maxSubjects: policy.maxSubjects,
      familyCapacityMode: policy.familyCapacityMode,
      allowMissingSerial: policy.allowMissingSerial,
      ...(policy.revisionFamily === "volcanoAshfall" && info.kind === "ashfall"
        ? {
            variantRank: info.type === "VFVO54" ? 0 as const : 1 as const,
            volcanoProvenance: {
              kind: "ashfall" as const,
              actualEventId: ashfallEventId,
              sourceType: info.type === "VFVO54" ? "VFVO54" as const : "VFVO55" as const,
            },
          }
        : {}),
      ...payloadFingerprints,
      legacyRevisionKey: subject,
    });
    this.notifyRevisionDecision("all", decision);
    if (!decision.accepted) {
      if (decision.semanticKeyMigrated) this.notifyRevisionDecision("volcano", decision);
      return null;
    }
    if (policy.revisionFamily === "volcanoAshfall" && info.kind === "ashfall") {
      const projected = ashfallProjection!;
      if (projected.kind === "active") {
        if (!this.volcanoState.applyAcceptedAshfall(projected.projection)) {
          throw new Error("volcano ashfall holder admission failed");
        }
      }
      else if (subject != null && !this.clearVolcanoSlice(
        "ashfall",
        subject.slice("volcano:ashfall:".length),
        info.meta.messageId,
        info.volcanoName,
      )) {
        throw new Error("volcano ashfall holder admission failed");
      }
    }
    this.notifyRevisionDecision("volcano", decision);
    return {
      suppressed: false,
      authoritative: true,
      acceptedCorrection: decision.isCorrection,
      acceptedSubjects: subject == null ? [] : [subject],
      activeAlertSubjects: this.revisionGate.activeRevisionFamilySubjects("volcano", "volcanoAlert"),
      activeEruptionSubjects: this.revisionGate.activeRevisionFamilySubjects("volcano", "volcanoEruption"),
    };
  }

  private retainFoundationSubjects(): void {
    const alerts = this.revisionGate?.activeRevisionFamilySubjects("volcano", "volcanoAlert") ?? [];
    const eruptions = this.revisionGate?.activeRevisionFamilySubjects("volcano", "volcanoEruption") ?? [];
    this.volcanoState.retainActiveSubjects(alerts, eruptions);
  }

  private emitBatch(batch: Vfvo53BatchItems, opts: FlushOptions): void {
    const presentation = resolveVolcanoBatchPresentation(batch);
    const acceptedCorrection = (batch.sources ?? []).some((source) => {
      const messageId = source.msg?.id;
      if (messageId == null) return false;
      const foundation = this.preAggregatedFoundation.get(messageId);
      this.preAggregatedFoundation.delete(messageId);
      return foundation?.acceptedCorrection === true;
    });

    if (opts.notify) {
      this.notifier.notifyVolcanoBatch(batch, presentation, acceptedCorrection);
      this.onFoundationNotified?.(acceptedCorrection);
    }

    const rawSources = batch.sources ?? [];
    const complete = rawSources.filter(
      (source): source is { info: ParsedVolcanoAshfallInfo; msg: WsDataMessage } => source.msg != null,
    );
    const batchMsg = complete[0]?.msg;
    const sources = complete.length === rawSources.length ? complete : [];

    if (batchMsg && sources.length !== rawSources.length) {
      log.warn(`VFVO53 バッチ: source msg 欠落のため表示分割を縮退 (${complete.length}/${rawSources.length})`);
    }

    if (batchMsg) {
      const batchOutcome: VolcanoBatchOutcome = {
        domain: "volcano",
        msg: batchMsg,
        headType: batchMsg.head.type,
        statsCategory: "volcano",
        parsed: batch.items,
        sources,
        isBatch: true,
        volcanoPresentation: presentation,
        batchReportDateTime: batch.reportDateTime,
        batchIsTest: batch.isTest,
        stats: {
          shouldRecord: false,
        },
        presentation: {
          frameLevel: presentation.frameLevel,
          soundLevel: presentation.soundLevel,
          notifyCategory: "volcano",
          acceptedCorrection,
          foundationMutationAccepted: true,
        },
      };

      const presented = this.runDisplayPipeline(batchOutcome, () =>
        this.display?.displayVolcanoBatch(batch, presentation),
      );
      if (presented) this.onFoundationPresented?.();
    } else {
      this.display?.displayVolcanoBatch(batch, presentation);
    }

  }
}
