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
import { VolcanoVfvo53Aggregator, type FlushOptions, type Vfvo53BatchItems } from "./volcano-vfvo53-aggregator";
import { VolcanoStateHolder } from "./volcano-state";
import { Notifier } from "../notification/notifier";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation } from "../presentation/volcano-presentation";
import { buildVolcanoOutcome } from "../presentation/processors/process-volcano";
import type { VolcanoBatchOutcome, ProcessOutcome } from "../presentation/types";
import type { DisplayCallbacks } from "./display-callbacks";
import {
  semanticPayloadFingerprint,
  type TelegramRevisionDecision,
  type TelegramRevisionGate,
  type TelegramRevisionGateInput,
} from "./telegram-revision-gate";
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

// ── 本体 ──

export class VolcanoRouteHandler {
  private readonly volcanoState: VolcanoStateHolder;
  private readonly notifier: Notifier;
  private readonly runDisplayPipeline: DisplayPipelineFn;
  private readonly display?: DisplayCallbacks;
  private readonly revisionGate?: TelegramRevisionGate;
  private readonly onRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  private readonly onVolcanoRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  private readonly onFoundationNotified?: (isCorrection: boolean) => void;
  private readonly onFoundationPresented?: () => void;
  private readonly aggregator: VolcanoVfvo53Aggregator;
  private lastImmediateAccepted: boolean | null = null;
  private readonly preAggregatedFoundation = new Map<string, {
    suppressed: false;
    authoritative: true;
    acceptedCorrection: boolean;
    acceptedSubjects: string[];
    activeAlertSubjects: string[];
    activeEruptionSubjects: string[];
  }>();

  constructor(deps: VolcanoRouteHandlerDeps) {
    this.volcanoState = deps.volcanoState;
    this.notifier = deps.notifier;
    this.runDisplayPipeline = deps.runDisplayPipeline;
    this.display = deps.display;
    this.revisionGate = deps.revisionGate;
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
      policy.revisionFamily === "volcanoAshfall" || policy.revisionFamily === "volcanoTransient"
    ) {
      const foundation = this.applyPreAggregateFoundation(volcanoInfo, msg, policy);
      if (foundation == null) return { kind: "suppressed" };
      this.preAggregatedFoundation.set(msg.id, foundation);
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
    const outcome = msg
      ? buildVolcanoOutcome(msg, info, this.volcanoState)
      : null;
    const presentation = outcome?.volcanoPresentation
      ?? resolveVolcanoPresentation(info, this.volcanoState);
    const preAggregated = msg == null ? null : this.preAggregatedFoundation.get(msg.id) ?? null;
    if (msg != null) this.preAggregatedFoundation.delete(msg.id);
    const foundation = preAggregated ?? (msg == null ? null : this.applyFoundation(info, msg));
    if (foundation?.suppressed === true) {
      this.lastImmediateAccepted = false;
      return;
    }
    this.lastImmediateAccepted = true;
    if (outcome != null && foundation != null) {
      outcome.presentation.volcanoStateMutationAccepted = foundation.authoritative;
      outcome.presentation.volcanoAcceptedSubjects = foundation.acceptedSubjects;
      outcome.presentation.volcanoActiveAlertSubjects = foundation.activeAlertSubjects;
      outcome.presentation.volcanoActiveEruptionSubjects = foundation.activeEruptionSubjects;
      outcome.presentation.acceptedCorrection = foundation.acceptedCorrection;
    } else if (foundation == null) {
      this.volcanoState.update(info);
    }

    // 通知は filter 非適用
    const notificationEligible = foundation == null || foundation.authoritative;
    if (opts?.notify !== false && notificationEligible) {
      this.notifier.notifyVolcano(info, presentation);
      if (foundation != null) this.onFoundationNotified?.(foundation.acceptedCorrection);
    }

    // PresentationEvent パイプライン
    if (outcome) {
      const presented = this.runDisplayPipeline(outcome, () =>
        this.display?.displayVolcano(info, presentation),
      );
      if (foundation != null && presented) this.onFoundationPresented?.();
    } else {
      // msg キャッシュがない場合はフォールバック表示
      this.display?.displayVolcano(info, presentation);
    }

  }

  private applyFoundation(
    info: ParsedVolcanoInfo,
    msg: WsDataMessage,
  ): {
    suppressed: boolean;
    authoritative: boolean;
    acceptedCorrection: boolean;
    acceptedSubjects: string[];
    activeAlertSubjects: string[];
    activeEruptionSubjects: string[];
  } | null {
    const policy = volcanoRevisionFamilyPolicy(msg.head.type);
    if (policy == null || this.revisionGate == null) return null;

    const candidates: Array<{
      parsed: ParsedVolcanoInfo;
      subject: string | null;
      apply: (decision: TelegramRevisionDecision, subject: string) => void;
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
          apply: (decision, subject) => {
            if (decision.kind === "clearCurrent") this.volcanoState.clearAlert(entry.volcanoCode);
            else this.volcanoState.applyAcceptedTextAlert(entry, info.reportDateTime);
            this.retainFoundationSubjects();
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
          apply: () => undefined,
        });
      }
    } else if (info.kind === "alert") {
      candidates.push({
        parsed: info,
        subject: volcanoAlertSubjectKey(info.volcanoCode),
        apply: (decision) => {
          if (decision.kind === "clearCurrent") this.volcanoState.clearAlert(info.volcanoCode);
          else this.volcanoState.applyAcceptedAlert(info);
          this.retainFoundationSubjects();
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
        apply: (decision) => {
          if (decision.kind === "clearCurrent") this.volcanoState.clearEruption(resolvedCode);
          else this.volcanoState.applyAcceptedEruption(info, info.meta.eventId.value);
          this.retainFoundationSubjects();
        },
      });
    }
    if (candidates.length === 0) return null;

    const acceptedSubjects: string[] = [];
    let acceptedCorrection = false;
    let failOpen = false;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const { meta: _meta, isTest: _isTest, ...payload } = candidate.parsed;
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
        allowMissingSerial: policy.allowMissingSerial,
        payloadFingerprint: semanticPayloadFingerprint(payload),
        legacyRevisionKey: legacyRevision?.key ?? null,
        legacyRevisionKeyProvenance: legacyRevision?.provenance ?? null,
      };
      const decision = this.revisionGate.decide(input);
      this.onRevisionDecision?.(decision);
      if (!decision.accepted) continue;
      if (candidate.subject == null) {
        failOpen = true;
        continue;
      }
      candidate.apply(decision, candidate.subject);
      acceptedSubjects.push(candidate.subject);
      acceptedCorrection ||= decision.isCorrection;
      this.onVolcanoRevisionDecision?.(decision);
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
  ): {
    suppressed: false;
    authoritative: true;
    acceptedCorrection: boolean;
    acceptedSubjects: string[];
    activeAlertSubjects: string[];
    activeEruptionSubjects: string[];
  } | null {
    if (this.revisionGate == null) return {
      suppressed: false,
      authoritative: true,
      acceptedCorrection: info.infoType === "訂正",
      acceptedSubjects: [],
      activeAlertSubjects: [],
      activeEruptionSubjects: [],
    };
    const extracted = policy.extractStateSubjectKey(info.meta, info);
    const subjects = extracted == null
      ? []
      : [...new Set(typeof extracted === "string" ? [extracted] : extracted)];
    const subject = subjects.length === 1 ? subjects[0] : null;
    const targets = policy.extractCancellationTarget(info.meta, info);
    const { meta: _meta, isTest: _isTest, ...payload } = info;
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
      allowMissingSerial: policy.allowMissingSerial,
      payloadFingerprint: semanticPayloadFingerprint(payload),
      legacyRevisionKey: subject,
    });
    this.onRevisionDecision?.(decision);
    if (!decision.accepted) return null;
    this.onVolcanoRevisionDecision?.(decision);
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
