import { createHash } from "node:crypto";
import type {
  RevisionRelation,
  TelegramMeta,
  TelegramRevisionComparisonInput,
} from "../../types";
import {
  compareTelegramRevisions,
  telegramRevision,
  type TelegramRevisionComparator,
} from "../../dmdata/telegram-meta";
import * as log from "../../logger";

export type CancellationPolicy =
  | "restorePrevious"
  | "clearCurrent"
  | "markCancelled";

export type CancellationTrigger =
  | "explicitCancellation"
  | "terminal"
  | "deactivation";

export type TelegramRevisionDecisionKind =
  | "accept"
  | "acceptTransient"
  | "mergeFragment"
  | "replaceCorrection"
  | "markCancelled"
  | "restorePrevious"
  | "clearCurrent"
  | "duplicate"
  | "semanticDuplicate"
  | "stale"
  | "invalidMeta"
  | "invalidRevision"
  | "cancelTargetMismatch"
  | "capacityExceeded";

export interface TelegramRevisionDecision {
  kind: TelegramRevisionDecisionKind;
  relation: RevisionRelation | null;
  accepted: boolean;
  isCorrection: boolean;
  isTerminal: boolean;
  resolvedTrigger: CancellationTrigger | null;
  /** 旧 fingerprint alias 一致を新 primary key へ無通知移行した。 */
  semanticKeyMigrated?: boolean;
}

export interface TelegramRevisionGateInput {
  domain: string;
  revisionFamily: string;
  stateSubjectKey: string | null;
  transientSubjectKey?: string | null;
  meta: TelegramMeta;
  comparator: TelegramRevisionComparator;
  cancellationPolicy: CancellationPolicy;
  terminal: boolean;
  deactivation?: boolean;
  cancellationTargetMatches?: boolean;
  /** 明示取消を表示上は受理するが、state/tombstone mutation の trigger にしない。 */
  stateNeutralCancellation?: boolean;
  durable?: boolean;
  /** durable tombstone / non-durable runtime watermark の family 保持期間。 */
  tombstoneRetentionMs?: number | null;
  /** registry が保証する family 全体の subject 上限。全 policy で必須。 */
  maxSubjects?: number | null;
  /** family 上限 compaction で保持する canonical/whole subject。 */
  retainForFamilyCapacity?: boolean;
  allowMissingSerial?: boolean;
  /** equal な通常報を whole-message duplicate にせず item gate へ渡す allowlist family。 */
  fragmentMerge?: boolean;
  payloadFingerprint: string;
  /** fingerprint version 切替時の read-only alias。新規受理では primary だけを保存する。 */
  payloadFingerprintAliases?: readonly string[];
  /** rollback 用旧 revision guard へ射影する key。semantic comparison には使わない。 */
  legacyRevisionKey?: string | null;
  /** rollback key の由来。EventID 逆引きは eventId 由来だけに許可する。 */
  legacyRevisionKeyProvenance?: "eventId" | "codeFallback" | null;
}

interface AcceptedRevisionState {
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: Set<string>;
  cancelled: boolean;
  acceptedAtMs: number;
  durable: boolean;
  tombstoneRetentionMs: number | null;
  retainForFamilyCapacity: boolean;
  legacyRevisionKey: string | null;
  legacyRevisionKeyProvenance: "eventId" | "codeFallback" | null;
}

export interface PersistedTelegramRevisionGateEntryV2 {
  domain: string;
  revisionFamily: string;
  stateSubjectKey: string;
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: string[];
  cancelled: boolean;
  acceptedAtMs: number;
  tombstoneRetentionMs?: number | null;
  legacyRevisionKey?: string | null;
  legacyRevisionKeyProvenance?: "eventId" | "codeFallback" | null;
}

const REVISION_GATE_RETENTION_MS = 11 * 60_000;
const DEFAULT_DURABLE_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const TELEGRAM_REVISION_MAX_ENTRIES = 16_384;
export const TELEGRAM_REVISION_MAX_SEMANTIC_KEYS = 32;

function reject(
  kind: Exclude<
    TelegramRevisionDecisionKind,
    | "accept"
    | "acceptTransient"
    | "mergeFragment"
    | "replaceCorrection"
    | "markCancelled"
    | "restorePrevious"
    | "clearCurrent"
  >,
  relation: RevisionRelation | null,
): TelegramRevisionDecision {
  return {
    kind,
    relation,
    accepted: false,
    isCorrection: false,
    isTerminal: false,
    resolvedTrigger: null,
  };
}

function resolveCancellationTrigger(
  input: TelegramRevisionGateInput,
): CancellationTrigger | null {
  if (
    input.meta.infoType.value === "取消"
    && input.stateNeutralCancellation !== true
  ) return "explicitCancellation";
  if (input.terminal) return "terminal";
  if (input.deactivation === true) return "deactivation";
  return null;
}

function acceptedKind(
  input: TelegramRevisionGateInput,
  resolvedTrigger: CancellationTrigger | null,
):
  | "accept"
  | "replaceCorrection"
  | "markCancelled"
  | "restorePrevious"
  | "clearCurrent" {
  if (resolvedTrigger != null) {
    return input.cancellationPolicy;
  }
  if (input.meta.infoType.value === "訂正") return "replaceCorrection";
  return "accept";
}

function tombstoneRetentionMs(input: TelegramRevisionGateInput): number | null {
  const configured = input.tombstoneRetentionMs;
  if (configured === null) return null;
  return configured != null && Number.isFinite(configured) && configured > 0
    ? configured
    : input.durable === true
      ? DEFAULT_DURABLE_TOMBSTONE_RETENTION_MS
      : null;
}

function runtimeRetentionMs(state: AcceptedRevisionState): number {
  return state.tombstoneRetentionMs ?? REVISION_GATE_RETENTION_MS;
}

function rememberSemanticKey(state: AcceptedRevisionState, key: string): void {
  if (state.semanticKeys.has(key)) return;
  while (state.semanticKeys.size >= TELEGRAM_REVISION_MAX_SEMANTIC_KEYS) {
    const oldest = state.semanticKeys.values().next().value as string | undefined;
    if (oldest == null) break;
    state.semanticKeys.delete(oldest);
  }
  state.semanticKeys.add(key);
}

/** alias migration は bounded history の同じ slot を置換し、別 revision を退場させない。 */
function replaceSemanticKey(
  state: AcceptedRevisionState,
  previousKey: string,
  nextKey: string,
): boolean {
  if (previousKey === nextKey || state.semanticKeys.has(nextKey)) return false;
  const keys = [...state.semanticKeys];
  const index = keys.indexOf(previousKey);
  if (index < 0) return false;
  keys[index] = nextKey;
  state.semanticKeys = new Set(keys);
  return true;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactSemanticKey(key: string): string {
  const separator = key.indexOf(":");
  const prefix = separator < 0 ? "legacy" : key.slice(0, separator);
  const payload = separator < 0 ? key : key.slice(separator + 1);
  return /^(?:発表|訂正|取消)$/.test(prefix) && /^[0-9a-f]{64}$/.test(payload)
    ? key
    : `${prefix}:${digestText(payload)}`;
}

/** pre-digest v2 も固定長へ移行し、直近の bounded history だけを保持する。 */
export function compactPersistedSemanticKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let index = keys.length - 1; index >= 0; index--) {
    const compacted = compactSemanticKey(keys[index]);
    if (seen.has(compacted)) continue;
    seen.add(compacted);
    newestFirst.push(compacted);
    if (newestFirst.length >= TELEGRAM_REVISION_MAX_SEMANTIC_KEYS) break;
  }
  return newestFirst.reverse();
}

export function telegramRevisionSemanticKey(
  input: Pick<TelegramRevisionGateInput, "meta" | "payloadFingerprint">,
): string {
  return `${input.meta.infoType.value}:${input.payloadFingerprint}`;
}

function telegramRevisionSemanticKeys(input: TelegramRevisionGateInput): string[] {
  return [...new Set([
    input.payloadFingerprint,
    ...(input.payloadFingerprintAliases ?? []),
  ])].map((payloadFingerprint) => telegramRevisionSemanticKey({
    meta: input.meta,
    payloadFingerprint,
  }));
}

function serialIsMissing(input: TelegramRevisionComparisonInput): boolean {
  const raw = input.revision.serial.raw;
  return raw == null || raw === "";
}

function compareWithSerialPolicy(
  incoming: TelegramRevisionComparisonInput,
  current: TelegramRevisionComparisonInput,
  input: TelegramRevisionGateInput,
): RevisionRelation {
  const relation = compareTelegramRevisions(incoming, current, input.comparator);
  if (relation !== "unordered" || input.allowMissingSerial !== true) return relation;

  // VPWS50 は Serial 省略を許すが、valid=true の数値へ偽装しない。同一日時で
  // 両側とも省略された場合だけ domain policy として equal とし、片側省略は比較不能にする。
  const incomingDate = incoming.revision.reportDateTime;
  const currentDate = current.revision.reportDateTime;
  if (
    input.comparator !== "reportDateTimeThenSerial"
    || !incomingDate.valid
    || !currentDate.valid
    || incomingDate.epochMs == null
    || currentDate.epochMs == null
    || incomingDate.epochMs !== currentDate.epochMs
  ) return relation;
  return serialIsMissing(incoming) && serialIsMissing(current) ? "equal" : "unordered";
}

/**
 * domain/revisionFamily/subject 単位の意味 revision gate。
 * transport messageId は扱わず、同一 revision の通常報・訂正・取消だけを判定する。
 */
export class TelegramRevisionGate {
  private readonly states = new Map<string, AcceptedRevisionState>();
  private readonly warnedFamilyCapacity = new Map<string, number>();
  private readonly transientStates = new Map<
    string,
    {
      semanticKey: string;
      acceptedAtMs: number;
      domain: string;
      revisionFamily: string;
      retentionMs: number;
    }
  >();
  private readonly transientSemanticKeys = new Map<string, string>();

  constructor(
    private readonly onCapacityError: (message: string) => void = (message) => log.warn(message),
  ) {}

  /**
   * Revision decision を副作用なしで評価する。
   * parser 固有の安全性検査を通過するまで watermark を確定してはならない経路で使う。
   */
  evaluate(input: TelegramRevisionGateInput): TelegramRevisionDecision {
    return this.decideInternal(input, false);
  }

  /** Revision decision を確定し、watermark / tombstone を更新する。 */
  decide(input: TelegramRevisionGateInput): TelegramRevisionDecision {
    return this.decideInternal(input, true);
  }

  private decideInternal(
    input: TelegramRevisionGateInput,
    commit: boolean,
  ): TelegramRevisionDecision {
    if (commit) this.sweep(input.meta.receivedAtMs);
    const infoType = input.meta.infoType;
    if (!infoType.valid || infoType.value == null) {
      return reject("invalidMeta", null);
    }
    if (
      !input.meta.type.valid
      || input.meta.type.value == null
      || !input.meta.reportDateTime.valid
      || input.meta.reportDateTime.epochMs == null
      || (!input.meta.serial.valid && !(
        input.allowMissingSerial === true
        && (input.meta.serial.raw == null || input.meta.serial.raw === "")
      ))
    ) {
      return reject("invalidRevision", "unordered");
    }

    if (
      input.stateSubjectKey == null
      || input.stateSubjectKey === ""
    ) {
      if (
        input.transientSubjectKey == null
        || input.transientSubjectKey === ""
      ) {
        return reject("invalidMeta", null);
      }
      const transientSemanticKey = [
        input.domain,
        input.revisionFamily,
        input.meta.reportDateTime.raw,
        input.meta.serial.raw,
        input.meta.infoType.raw,
        input.payloadFingerprint,
      ].join(":");
      const transientStateKey = `${input.domain}:${input.revisionFamily}:${input.transientSubjectKey}`;
      const retentionMs = input.tombstoneRetentionMs != null
        && Number.isFinite(input.tombstoneRetentionMs)
        && input.tombstoneRetentionMs > 0
        ? input.tombstoneRetentionMs
        : REVISION_GATE_RETENTION_MS;
      const duplicateSubject = this.transientSemanticKeys.get(transientSemanticKey);
      const duplicateState = duplicateSubject == null
        ? null
        : this.transientStates.get(duplicateSubject) ?? null;
      if (
        duplicateState != null
        && input.meta.receivedAtMs - duplicateState.acceptedAtMs <= duplicateState.retentionMs
      ) {
        return reject("semanticDuplicate", "equal");
      }
      const transientState = this.transientStates.get(transientStateKey);
      if (
        transientState != null
        && input.meta.receivedAtMs - transientState.acceptedAtMs <= transientState.retentionMs
      ) {
        return reject("invalidMeta", null);
      }
      if (!this.canAcceptNewSubject(
        input.domain,
        input.revisionFamily,
        input.maxSubjects,
        input.meta.receivedAtMs,
      )) {
        if (commit) this.warnCapacityRejected(input.domain, input.revisionFamily, input.maxSubjects);
        return reject("capacityExceeded", null);
      }
      if (commit) {
        this.makeRoomForNewSubject(
          input.domain,
          input.revisionFamily,
          input.maxSubjects,
          input.meta.receivedAtMs,
        );
        this.transientStates.set(transientStateKey, {
          semanticKey: transientSemanticKey,
          acceptedAtMs: input.meta.receivedAtMs,
          domain: input.domain,
          revisionFamily: input.revisionFamily,
          retentionMs,
        });
        this.transientSemanticKeys.set(
          transientSemanticKey,
          transientStateKey,
        );
        this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects);
        this.sweep(input.meta.receivedAtMs);
      }
      return {
        kind: "acceptTransient",
        relation: null,
        accepted: true,
        isCorrection: infoType.value === "訂正",
        isTerminal: input.terminal,
        resolvedTrigger: resolveCancellationTrigger(input),
      };
    }

    const key = `${input.domain}:${input.revisionFamily}:${input.stateSubjectKey}`;
    const rawRevision = telegramRevision(input.meta);
    const incomingComparison: TelegramRevisionComparisonInput = {
      // comparator の identity 欄を registry identity へ束縛する。EventID を identity に
      // 含める family は subject extractor 側で組み込むため、EventID 欠落を一律拒否しない。
      revision: {
        ...rawRevision,
        serial: rawRevision.serial,
        eventId: { raw: input.stateSubjectKey, value: input.stateSubjectKey, valid: true },
        type: { raw: input.revisionFamily, value: input.revisionFamily, valid: true },
      },
      stateSubjectKey: input.stateSubjectKey,
    };
    const stored = this.states.get(key);
    const existing = stored != null
      && (stored.durable || input.meta.receivedAtMs - stored.acceptedAtMs <= runtimeRetentionMs(stored))
      ? stored
      : undefined;
    const nextSemanticKey = telegramRevisionSemanticKey(input);
    const candidateSemanticKeys = telegramRevisionSemanticKeys(input);

    const resolvedTrigger = resolveCancellationTrigger(input);
    const cancellationTriggered = resolvedTrigger != null;
    if (cancellationTriggered && input.cancellationTargetMatches === false) {
      return reject("cancelTargetMismatch", null);
    }

    if (existing == null) {
      if (cancellationTriggered && input.cancellationPolicy === "restorePrevious") {
        return reject("cancelTargetMismatch", null);
      }
      if (!this.canAcceptNewSubject(
        input.domain,
        input.revisionFamily,
        input.maxSubjects,
        input.meta.receivedAtMs,
      )) {
        if (commit) this.warnCapacityRejected(input.domain, input.revisionFamily, input.maxSubjects);
        return reject("capacityExceeded", null);
      }
      const kind = acceptedKind(input, resolvedTrigger);
      if (commit) {
        this.makeRoomForNewSubject(
          input.domain,
          input.revisionFamily,
          input.maxSubjects,
          input.meta.receivedAtMs,
        );
        this.states.set(key, {
          comparison: incomingComparison,
          semanticKeys: new Set([nextSemanticKey]),
          cancelled: cancellationTriggered,
          acceptedAtMs: input.meta.receivedAtMs,
          durable: input.durable === true,
          tombstoneRetentionMs: tombstoneRetentionMs(input),
          retainForFamilyCapacity: input.retainForFamilyCapacity === true,
          legacyRevisionKey: input.legacyRevisionKey ?? null,
          legacyRevisionKeyProvenance: input.legacyRevisionKeyProvenance ?? null,
        });
        this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects);
        this.sweep(input.meta.receivedAtMs);
      }
      return {
        kind,
        relation: "newer",
        accepted: true,
        isCorrection: infoType.value === "訂正",
        isTerminal: input.terminal,
        resolvedTrigger,
      };
    }

    const relation = compareWithSerialPolicy(incomingComparison, existing.comparison, input);
    if (relation === "older") return reject("stale", relation);
    if (relation === "unordered") return reject("invalidRevision", relation);
    if (
      cancellationTriggered
      && input.cancellationPolicy === "restorePrevious"
      && relation !== "equal"
    ) {
      return reject("cancelTargetMismatch", relation);
    }

    if (relation === "equal") {
      const rejectMatchedSemanticKey = (
        kind: Parameters<typeof reject>[0],
      ): TelegramRevisionDecision | null => {
        const matchedSemanticKey = candidateSemanticKeys.find((candidate) =>
          existing.semanticKeys.has(candidate));
        if (matchedSemanticKey == null) return null;
        const decision = reject(kind, relation);
        if (matchedSemanticKey !== nextSemanticKey && commit) {
          decision.semanticKeyMigrated = replaceSemanticKey(
            existing,
            matchedSemanticKey,
            nextSemanticKey,
          );
        }
        return decision;
      };
      // clearCurrent tombstones start a new lifecycle only at a newer revision.
      // Unlike EEW markCancelled, an equal-revision correction cannot reactivate them.
      if (
        input.cancellationPolicy === "clearCurrent"
        && existing.cancelled
        && !cancellationTriggered
      ) {
        return reject("stale", relation);
      }
      if (infoType.value === "発表") {
        if (input.fragmentMerge !== true) {
          return rejectMatchedSemanticKey("duplicate") ?? reject("duplicate", relation);
        }
        // clearCurrent 後の同一 revision fragment で取消済み系列を復活させない。
        if (existing.cancelled) return reject("stale", relation);
        if (commit) {
          rememberSemanticKey(existing, nextSemanticKey);
          existing.acceptedAtMs = input.meta.receivedAtMs;
          existing.durable ||= input.durable === true;
          existing.tombstoneRetentionMs = tombstoneRetentionMs(input);
          existing.retainForFamilyCapacity ||= input.retainForFamilyCapacity === true;
          if (input.legacyRevisionKey != null) {
            existing.legacyRevisionKey = input.legacyRevisionKey;
            existing.legacyRevisionKeyProvenance = input.legacyRevisionKeyProvenance ?? null;
          }
          this.touchState(key, existing);
          this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects);
          this.sweep(input.meta.receivedAtMs);
        }
        return {
          kind: "mergeFragment",
          relation,
          accepted: true,
          isCorrection: false,
          isTerminal: input.terminal,
          resolvedTrigger,
        };
      }
      // restorePrevious の tombstone は同一 revision の遅延訂正でも解除しない。
      // genuinely newer な続報だけが次の state を開始できる。
      if (
        input.cancellationPolicy === "restorePrevious"
        && existing.cancelled
        && !cancellationTriggered
      ) {
        return reject("stale", relation);
      }
      if (cancellationTriggered && existing.cancelled) {
        return rejectMatchedSemanticKey("semanticDuplicate")
          ?? reject("semanticDuplicate", relation);
      }
      const matchedSemanticDecision = rejectMatchedSemanticKey("semanticDuplicate");
      if (matchedSemanticDecision != null) return matchedSemanticDecision;
      const kind = acceptedKind(input, resolvedTrigger);
      if (commit) {
        rememberSemanticKey(existing, nextSemanticKey);
        // 同一 revision の訂正・取消でも、永続化する現況 identity は
        // 最後に受理した envelope と一致させる。
        existing.comparison = incomingComparison;
        existing.cancelled = cancellationTriggered;
        existing.acceptedAtMs = input.meta.receivedAtMs;
        existing.durable ||= input.durable === true;
        existing.tombstoneRetentionMs = tombstoneRetentionMs(input);
        existing.retainForFamilyCapacity ||= input.retainForFamilyCapacity === true;
        if (input.legacyRevisionKey != null) {
          existing.legacyRevisionKey = input.legacyRevisionKey;
          existing.legacyRevisionKeyProvenance = input.legacyRevisionKeyProvenance ?? null;
        }
        this.touchState(key, existing);
        this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects);
        this.sweep(input.meta.receivedAtMs);
      }
      return {
        kind,
        relation,
        accepted: true,
        isCorrection: infoType.value === "訂正",
        isTerminal: input.terminal,
        resolvedTrigger,
      };
    }

    const kind = acceptedKind(input, resolvedTrigger);
    if (commit) {
      // Map#set は既存 key の挿入順を変えないため、holder の delete→set と揃える。
      this.states.delete(key);
      this.states.set(key, {
        comparison: incomingComparison,
        semanticKeys: new Set([nextSemanticKey]),
        cancelled: cancellationTriggered,
        acceptedAtMs: input.meta.receivedAtMs,
        durable: input.durable === true,
        tombstoneRetentionMs: tombstoneRetentionMs(input),
        retainForFamilyCapacity: input.retainForFamilyCapacity === true,
        legacyRevisionKey: input.legacyRevisionKey ?? null,
        legacyRevisionKeyProvenance: input.legacyRevisionKeyProvenance ?? null,
      });
      this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects);
      this.sweep(input.meta.receivedAtMs);
    }
    return {
      kind,
      relation,
      accepted: true,
      isCorrection: infoType.value === "訂正",
      isTerminal: input.terminal,
      resolvedTrigger,
    };
  }

  /**
   * duplicate payload を永続 watermark の現況から holder へ再構成できるか確認する。
   * 過去に受理した semantic key ではなく、最後に受理した payload だけを許可する。
   */
  matchesCurrentAcceptedPayload(input: TelegramRevisionGateInput): boolean {
    if (input.stateSubjectKey == null || input.stateSubjectKey === "") return false;
    const key = `${input.domain}:${input.revisionFamily}:${input.stateSubjectKey}`;
    const existing = this.states.get(key);
    if (
      existing == null
      || existing.cancelled
      || (!existing.durable
        && input.meta.receivedAtMs - existing.acceptedAtMs > runtimeRetentionMs(existing))
    ) return false;
    const keys = [...existing.semanticKeys];
    return telegramRevisionSemanticKeys(input).includes(keys[keys.length - 1]);
  }

  private touchState(key: string, state: AcceptedRevisionState): void {
    this.states.delete(key);
    this.states.set(key, state);
  }

  private canAcceptNewSubject(
    domain: string,
    revisionFamily: string,
    maxSubjects: number | null | undefined,
    nowMs: number,
  ): boolean {
    if (maxSubjects == null) {
      return this.liveEntryCount(nowMs) < TELEGRAM_REVISION_MAX_ENTRIES;
    }
    this.validateFamilyLimit(domain, revisionFamily, maxSubjects);
    const regular = this.liveFamilyEntries(domain, revisionFamily, nowMs);
    const transient = this.liveTransientFamilyEntries(domain, revisionFamily, nowMs);
    if (regular.length + transient.length < maxSubjects) {
      return this.liveEntryCount(nowMs) < TELEGRAM_REVISION_MAX_ENTRIES;
    }
    return transient.length > 0 || regular.some(([, state]) => this.isFamilyEvictable(state));
  }

  private makeRoomForNewSubject(
    domain: string,
    revisionFamily: string,
    maxSubjects: number | null | undefined,
    nowMs: number,
  ): void {
    if (maxSubjects == null) return;
    this.validateFamilyLimit(domain, revisionFamily, maxSubjects);
    while (
      this.liveFamilyEntries(domain, revisionFamily, nowMs).length
      + this.liveTransientFamilyEntries(domain, revisionFamily, nowMs).length
      >= maxSubjects
    ) {
      const oldestTransient = this.liveTransientFamilyEntries(domain, revisionFamily, nowMs)
        .sort(([, left], [, right]) => left.acceptedAtMs - right.acceptedAtMs)[0];
      if (oldestTransient != null) {
        this.deleteTransientState(oldestTransient[0], oldestTransient[1]);
        continue;
      }
      const oldestEvictable = this.liveFamilyEntries(domain, revisionFamily, nowMs)
        .filter(([, state]) => this.isFamilyEvictable(state))
        .sort(([, left], [, right]) => left.acceptedAtMs - right.acceptedAtMs)[0];
      if (oldestEvictable == null) {
        throw new Error(
          `telegram revision family capacity admission invariant violated: ${domain}:${revisionFamily}`,
        );
      }
      this.states.delete(oldestEvictable[0]);
    }
  }

  private liveEntryCount(nowMs: number): number {
    const regular = [...this.states.values()].filter((state) => this.isStateLive(state, nowMs)).length;
    const transient = [...this.transientStates.values()].filter(
      (state) => nowMs - state.acceptedAtMs <= state.retentionMs,
    ).length;
    return regular + transient;
  }

  private liveFamilyEntries(
    domain: string,
    revisionFamily: string,
    nowMs: number,
  ): [string, AcceptedRevisionState][] {
    const prefix = `${domain}:${revisionFamily}:`;
    return [...this.states].filter(([key, state]) =>
      key.startsWith(prefix) && this.isStateLive(state, nowMs));
  }

  private liveTransientFamilyEntries(
    domain: string,
    revisionFamily: string,
    nowMs: number,
  ): [string, {
    semanticKey: string;
    acceptedAtMs: number;
    domain: string;
    revisionFamily: string;
    retentionMs: number;
  }][] {
    return [...this.transientStates].filter(([, state]) =>
      state.domain === domain
      && state.revisionFamily === revisionFamily
      && nowMs - state.acceptedAtMs <= state.retentionMs);
  }

  private isStateLive(state: AcceptedRevisionState, nowMs: number): boolean {
    if (!state.durable) return nowMs - state.acceptedAtMs <= runtimeRetentionMs(state);
    return !(
      state.cancelled
      && state.tombstoneRetentionMs != null
      && nowMs - state.acceptedAtMs > state.tombstoneRetentionMs
    );
  }

  private isFamilyEvictable(state: AcceptedRevisionState): boolean {
    return !(
      state.retainForFamilyCapacity
      || state.durable && state.cancelled && state.tombstoneRetentionMs === null
    );
  }

  private validateFamilyLimit(
    domain: string,
    revisionFamily: string,
    maxSubjects: number,
  ): void {
    if (
      !Number.isSafeInteger(maxSubjects)
      || maxSubjects <= 0
      || maxSubjects > TELEGRAM_REVISION_MAX_ENTRIES
    ) {
      throw new Error(`invalid family maxSubjects: ${domain}:${revisionFamily}:${maxSubjects}`);
    }
  }

  private warnCapacityRejected(
    domain: string,
    revisionFamily: string,
    maxSubjects: number | null | undefined,
  ): void {
    const warningKey = `${domain}:${revisionFamily}`;
    if (this.warnedFamilyCapacity.has(warningKey)) return;
    this.warnedFamilyCapacity.set(
      warningKey,
      maxSubjects ?? TELEGRAM_REVISION_MAX_ENTRIES,
    );
    this.onCapacityError(
      `[telegram-revision-gate] rejected new subject at hard family capacity: ${warningKey} (${maxSubjects ?? "global"})`,
    );
  }

  private familySize(domain: string, revisionFamily: string): number {
    const prefix = `${domain}:${revisionFamily}:`;
    const regular = [...this.states.keys()].filter((key) => key.startsWith(prefix)).length;
    const transient = [...this.transientStates.values()].filter((state) =>
      state.domain === domain && state.revisionFamily === revisionFamily).length;
    return regular + transient;
  }

  /** 容量警告を、当該 family に空きができたときだけ再武装する。 */
  private rearmCapacityWarning(domain: string, revisionFamily: string): void {
    const warningKey = `${domain}:${revisionFamily}`;
    const maxSubjects = this.warnedFamilyCapacity.get(warningKey);
    if (maxSubjects == null) return;
    if (this.familySize(domain, revisionFamily) < maxSubjects) {
      this.warnedFamilyCapacity.delete(warningKey);
    }
  }

  private rearmCapacityWarningForStateKey(stateKey: string): void {
    const domainSeparator = stateKey.indexOf(":");
    const familySeparator = stateKey.indexOf(":", domainSeparator + 1);
    if (domainSeparator < 0 || familySeparator < 0) return;
    this.rearmCapacityWarning(
      stateKey.slice(0, domainSeparator),
      stateKey.slice(domainSeparator + 1, familySeparator),
    );
  }

  private enforceFamilyLimit(
    domain: string,
    revisionFamily: string,
    maxSubjects: number | null | undefined,
  ): void {
    if (maxSubjects == null) return;
    this.validateFamilyLimit(domain, revisionFamily, maxSubjects);
    const prefix = `${domain}:${revisionFamily}:`;
    const familyEntries = () => [...this.states].filter(([key]) => key.startsWith(prefix));
    const transientFamilyEntries = () => [...this.transientStates].filter(
      ([, state]) => state.domain === domain && state.revisionFamily === revisionFamily,
    );
    const currentFamilySize = () => familyEntries().length + transientFamilyEntries().length;
    while (currentFamilySize() > maxSubjects) {
      const oldestTransient = transientFamilyEntries()
        .sort(([, a], [, b]) => a.acceptedAtMs - b.acceptedAtMs)[0];
      if (oldestTransient != null) {
        this.deleteTransientState(oldestTransient[0], oldestTransient[1]);
        continue;
      }
      const oldestEvictable = familyEntries()
        .filter(([, state]) => this.isFamilyEvictable(state))
        .sort(([, a], [, b]) => a.acceptedAtMs - b.acceptedAtMs)[0]?.[0];
      if (oldestEvictable == null) {
        throw new Error(
          `telegram revision family capacity invariant violated: ${domain}:${revisionFamily}`,
        );
      }
      this.states.delete(oldestEvictable);
    }
    this.rearmCapacityWarning(domain, revisionFamily);
  }

  private deleteTransientState(
    key: string,
    state: { semanticKey: string },
  ): void {
    this.transientStates.delete(key);
    if (this.transientSemanticKeys.get(state.semanticKey) === key) {
      this.transientSemanticKeys.delete(state.semanticKey);
    }
  }

  clear(): void;
  clear(domain: string, revisionFamily: string, stateSubjectKey: string): void;
  clear(
    domain?: string,
    revisionFamily?: string,
    stateSubjectKey?: string,
  ): void {
    if (domain == null && revisionFamily == null && stateSubjectKey == null) {
      this.clearAll();
      return;
    }
    if (domain == null || revisionFamily == null || stateSubjectKey == null) return;
    this.states.delete(`${domain}:${revisionFamily}:${stateSubjectKey}`);
    const transientKey = `${domain}:${revisionFamily}:${stateSubjectKey}`;
    const transientState = this.transientStates.get(transientKey);
    if (transientState != null) this.deleteTransientState(transientKey, transientState);
    this.rearmCapacityWarning(domain, revisionFamily);
  }

  clearRevisionFamilySubjectsExcept(
    domain: string,
    revisionFamily: string,
    retainedStateSubjectKeys: readonly string[],
  ): void {
    const prefix = `${domain}:${revisionFamily}:`;
    const retainedKeys = new Set(
      retainedStateSubjectKeys.map((stateSubjectKey) => `${prefix}${stateSubjectKey}`),
    );
    for (const key of this.states.keys()) {
      if (key.startsWith(prefix) && !retainedKeys.has(key)) this.states.delete(key);
    }
    for (const [key, state] of [...this.transientStates]) {
      if (key.startsWith(prefix) && !retainedKeys.has(key)) {
        this.deleteTransientState(key, state);
      }
    }
    this.rearmCapacityWarning(domain, revisionFamily);
  }

  clearFamily(domain: string, revisionFamily: string): void {
    this.clearRevisionFamilySubjectsExcept(domain, revisionFamily, []);
  }

  clearAll(): void {
    this.states.clear();
    this.transientStates.clear();
    this.transientSemanticKeys.clear();
    this.warnedFamilyCapacity.clear();
  }

  /** Finite-lifecycle domain の active watermark と tombstone を同じ期限で退場させる。 */
  expireRevisionFamily(
    domain: string,
    revisionFamily: string,
    nowMs: number,
    retentionMs: number,
  ): boolean {
    const prefix = `${domain}:${revisionFamily}:`;
    let changed = false;
    for (const [key, state] of this.states) {
      if (key.startsWith(prefix) && nowMs - state.acceptedAtMs > retentionMs) {
        this.states.delete(key);
        changed = true;
      }
    }
    for (const [subjectKey, state] of [...this.transientStates]) {
      if (
        state.domain === domain
        && state.revisionFamily === revisionFamily
        && nowMs - state.acceptedAtMs > retentionMs
      ) {
        this.deleteTransientState(subjectKey, state);
        changed = true;
      }
    }
    this.rearmCapacityWarning(domain, revisionFamily);
    return changed;
  }

  /** rollback key と由来を失わず更新する domain adapter 用参照。 */
  legacyRevisionIdentityForSubject(
    domain: string,
    revisionFamily: string,
    stateSubjectKey: string,
  ): {
    key: string;
    provenance: "eventId" | "codeFallback" | null;
  } | null {
    const state = this.states.get(`${domain}:${revisionFamily}:${stateSubjectKey}`);
    return state?.legacyRevisionKey == null ? null : {
      key: state.legacyRevisionKey,
      provenance: state.legacyRevisionKeyProvenance,
    };
  }

  /** EventID だけを持つ取消を、保持中の active/tombstone subject へ一意に逆引きする。 */
  stateSubjectForLegacyRevisionKey(
    domain: string,
    revisionFamily: string,
    legacyRevisionKey: string,
    nowMs: number,
  ): string | null {
    this.sweep(nowMs);
    const prefix = `${domain}:${revisionFamily}:`;
    const subjects = [...this.states]
      .filter(([key, state]) =>
        key.startsWith(prefix)
        && state.legacyRevisionKey === legacyRevisionKey
        && state.legacyRevisionKeyProvenance === "eventId")
      .map(([key]) => key.slice(prefix.length));
    return subjects.length === 1 ? subjects[0] : null;
  }

  /** holder の active set を family compaction 後の watermark と同期するための参照。 */
  activeRevisionFamilySubjects(domain: string, revisionFamily: string): string[] {
    const prefix = `${domain}:${revisionFamily}:`;
    return [...this.states]
      .filter(([key, state]) => key.startsWith(prefix) && !state.cancelled)
      .map(([key]) => key.slice(prefix.length));
  }

  /** active subject 群から union view 用の正規 revision（最新 ReportDateTime）を返す。 */
  latestActiveRevisionFamilyRevision(
    domain: string,
    revisionFamily: string,
  ): { reportDateTime: string; serial: string | null } | null {
    const prefix = `${domain}:${revisionFamily}:`;
    const latest = [...this.states]
      .filter(([key, state]) =>
        key.startsWith(prefix)
        && !state.cancelled
        && state.comparison.revision.reportDateTime.valid
        && state.comparison.revision.reportDateTime.epochMs != null
        && state.comparison.revision.reportDateTime.raw != null)
      .sort(([, left], [, right]) => {
        const timeOrder = right.comparison.revision.reportDateTime.epochMs!
          - left.comparison.revision.reportDateTime.epochMs!;
        return timeOrder !== 0 ? timeOrder : right.acceptedAtMs - left.acceptedAtMs;
      })[0]?.[1];
    if (latest == null) return null;
    return {
      reportDateTime: latest.comparison.revision.reportDateTime.raw!,
      serial: latest.comparison.revision.serial.raw,
    };
  }

  exportDurableEntries(): PersistedTelegramRevisionGateEntryV2[] {
    this.sweep(Date.now());
    const result: PersistedTelegramRevisionGateEntryV2[] = [];
    for (const [key, state] of this.states) {
      if (!state.durable) continue;
      const [domain, revisionFamily, ...subjectParts] = key.split(":");
      result.push({
        domain,
        revisionFamily,
        stateSubjectKey: subjectParts.join(":"),
        comparison: structuredClone(state.comparison),
        semanticKeys: [...state.semanticKeys],
        cancelled: state.cancelled,
        acceptedAtMs: state.acceptedAtMs,
        tombstoneRetentionMs: state.tombstoneRetentionMs,
        ...(state.legacyRevisionKey == null
          ? {}
          : { legacyRevisionKey: state.legacyRevisionKey }),
        ...(state.legacyRevisionKeyProvenance == null
          ? {}
          : { legacyRevisionKeyProvenance: state.legacyRevisionKeyProvenance }),
      });
    }
    return result;
  }

  restoreDurableEntries(entries: readonly PersistedTelegramRevisionGateEntryV2[]): void {
    for (const entry of entries) {
      const key = `${entry.domain}:${entry.revisionFamily}:${entry.stateSubjectKey}`;
      if (
        !this.states.has(key)
        && this.states.size + this.transientStates.size >= TELEGRAM_REVISION_MAX_ENTRIES
      ) {
        this.warnCapacityRejected("restore", "durable", TELEGRAM_REVISION_MAX_ENTRIES);
        continue;
      }
      this.states.set(key, {
        comparison: structuredClone(entry.comparison),
        semanticKeys: new Set(compactPersistedSemanticKeys(entry.semanticKeys)),
        cancelled: entry.cancelled,
        acceptedAtMs: entry.acceptedAtMs,
        durable: true,
        tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
          ? DEFAULT_DURABLE_TOMBSTONE_RETENTION_MS
          : entry.tombstoneRetentionMs,
        // VTSE41 の keyed state と VPWS50 の全国 base は family capacity の canonical 枠。
        // restart 後も live admission と同じ保護を復元し、部分報による eviction を防ぐ。
        retainForFamilyCapacity:
          (entry.domain === "tsunami" && entry.revisionFamily === "VTSE41")
          || (entry.domain === "weather"
            && entry.revisionFamily === "VPWS50"
            && entry.stateSubjectKey === "weather:vpws50"),
        legacyRevisionKey: entry.legacyRevisionKey ?? null,
        // pre-provenance v2 は EventID と code fallback を区別できないため逆引き対象外。
        legacyRevisionKeyProvenance: entry.legacyRevisionKeyProvenance ?? null,
      });
    }
    this.sweep(Date.now());
  }

  private sweep(nowMs: number): void {
    const affectedStateKeys = new Set<string>();
    for (const [key, state] of this.states) {
      const expiredTransient = !state.durable
        && nowMs - state.acceptedAtMs > runtimeRetentionMs(state);
      const expiredTombstone = state.durable
        && state.cancelled
        && state.tombstoneRetentionMs != null
        && nowMs - state.acceptedAtMs > state.tombstoneRetentionMs;
      if (expiredTransient || expiredTombstone) {
        this.states.delete(key);
        affectedStateKeys.add(key);
      }
    }
    for (const [subjectKey, state] of this.transientStates) {
      if (nowMs - state.acceptedAtMs > state.retentionMs) {
        this.deleteTransientState(subjectKey, state);
        affectedStateKeys.add(subjectKey);
      }
    }
    for (const stateKey of affectedStateKeys) {
      this.rearmCapacityWarningForStateKey(stateKey);
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value == null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function semanticPayloadFingerprint(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value)) ?? "undefined";
  return digestText(serialized);
}
