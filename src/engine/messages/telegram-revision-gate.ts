import { createHash } from "node:crypto";
import type {
  RevisionRelation,
  TelegramMeta,
  TelegramRevisionComparisonInput,
} from "../../types";
import {
  compareTelegramRevisions,
  normalizeVolcanoAshfallSerial,
  telegramRevision,
  type TelegramRevisionComparator,
} from "../../dmdata/telegram-meta";
import * as log from "../../logger";
import type { StandbyRevision } from "../display/standby-registry";
import {
  TYPHOON_PROBABILITY_MAX_SUBJECTS,
  validateTyphoonProbabilityEventId,
} from "../display/project-typhoon-probability";

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
  /** incoming admission の前に finite-lifecycle family を失効させた。 */
  preAdmissionDurableChanged?: boolean;
  /** pre-admission expiry で失効した canonical state subject。 */
  expiredStateSubjectKeys?: readonly string[];
}

/** Policy lifecycle: active watermark と cancellation tombstone は別の保持期間を持つ。 */
export interface RevisionFamilyLifecycleRetention {
  tombstoneRetentionMs: number | null;
  activeRetentionMs?: number;
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
  familyCapacityMode?: "evictInactive" | "rejectNewSubject";
  /** family 上限 compaction で保持する canonical/whole subject。 */
  retainForFamilyCapacity?: boolean;
  /**
   * family capacity から退場させてはならない、holder が現在表示している subject。
   * 指定時は gate 内だけの retain 印を根拠にせず、この集合だけを保護する。
   */
  activeFamilySubjects?: readonly string[];
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
  /** VFVO54/55 の同時 revision ordering。ほかの family は渡してはならない。 */
  variantRank?: 0 | 1;
  volcanoProvenance?: PersistedVolcanoGateProvenanceV1;
}

export type PersistedVolcanoGateProvenanceV1 =
  | {
      kind: "alert";
      sourceFamily: "VFVO50" | "VFVO51" | "VFSVii" | "operationalV2Unknown" | "unknown";
      operationalV2ResolutionId?: string;
    }
  | {
      kind: "ashfall";
      actualEventId: string | null;
      sourceType: "VFVO54" | "VFVO55" | null;
    };

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
  volcanoProvenance?: PersistedVolcanoGateProvenanceV1;
}

export interface TelegramRevisionGateSnapshot {
  version: number;
  states: Array<{
    key: string;
    comparison: TelegramRevisionComparisonInput;
    semanticKeys: string[];
    cancelled: boolean;
    acceptedAtMs: number;
    durable: boolean;
    tombstoneRetentionMs: number | null;
    retainForFamilyCapacity: boolean;
    legacyRevisionKey: string | null;
    legacyRevisionKeyProvenance: "eventId" | "codeFallback" | null;
    volcanoProvenance?: PersistedVolcanoGateProvenanceV1;
  }>;
  transientStates: Array<{
    key: string;
    semanticKey: string;
    acceptedAtMs: number;
    domain: string;
    revisionFamily: string;
    retentionMs: number;
  }>;
  transientSemanticKeys: Array<[string, string]>;
  warnedFamilyCapacity: Array<[string, number]>;
}

export interface AcceptedTyphoonProbabilityBinding {
  revision: StandbyRevision;
  appliedSemanticKey: string;
}

export interface VptaAcceptedCommit {
  stateSubjectKey: string;
  revisionFamily: "VPTA50";
  decision: TelegramRevisionDecision & { accepted: true };
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: readonly string[];
  cancelled: boolean;
  acceptedAtMs: number;
  tombstoneRetentionMs: 604_800_000;
  binding: AcceptedTyphoonProbabilityBinding;
}

export type VptaGateResult =
  | { kind: "accepted"; commit: VptaAcceptedCommit }
  | {
      kind: "suppressed";
      decision: TelegramRevisionDecision & { accepted: false };
      durableChanged: boolean;
    };

export type VptaCapacityClass = "P+G" | "GT" | "GA";

export interface VptaCapacityBundle {
  stateSubjectKey: string;
  acceptedAtMs: number;
  class: VptaCapacityClass;
  incoming?: boolean;
}

export type VptaCapacitySelection =
  | { kind: "selected"; retained: readonly VptaCapacityBundle[]; discarded: readonly VptaCapacityBundle[] }
  | { kind: "protectedOverflow" };

/** Opaque, single-use plan issued immediately before the atomic gate evaluation. */
export interface VptaCapacityPlan {
  readonly stateSubjectKey: string;
  readonly candidateKind: "active" | "deactivateAllZero" | "cancel" | "expired" | "nonProjectable";
  readonly maxSubjects: number;
  readonly selection: VptaCapacitySelection;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Live gate と persistence reader が共有する deterministic capacity selector。 */
export function selectVptaCapacityBundles(
  bundles: readonly VptaCapacityBundle[],
  maxSubjects = 256,
): VptaCapacitySelection {
  if (!Number.isSafeInteger(maxSubjects) || maxSubjects <= 0) {
    throw new Error("invalid VPTA capacity");
  }
  const protectedBundles = bundles.filter((bundle) => bundle.class !== "GA");
  if (protectedBundles.length > maxSubjects) return { kind: "protectedOverflow" };
  const ga = bundles.filter((bundle) => bundle.class === "GA")
    .sort((left, right) => left.acceptedAtMs - right.acceptedAtMs
      || compareCodeUnit(left.stateSubjectKey, right.stateSubjectKey));
  const discardCount = Math.max(0, bundles.length - maxSubjects);
  const discardedSet = new Set(ga.slice(0, discardCount));
  return {
    kind: "selected",
    retained: bundles.filter((bundle) => !discardedSet.has(bundle)),
    discarded: bundles.filter((bundle) => discardedSet.has(bundle)),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value == null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
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
  volcanoProvenance?: PersistedVolcanoGateProvenanceV1;
}

export interface RevisionFamilyExpiryResult {
  changed: boolean;
  expiredStateSubjectKeys: string[];
}

const REVISION_GATE_RETENTION_MS = 11 * 60_000;
const DEFAULT_DURABLE_TOMBSTONE_RETENTION_MS = 604_800_000 as const;
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

/**
 * VPTA50 の semantic key は admission で既に bounded canonical value へ確定している。
 * Persistence restore では hash や sort で別の key に救済せず、duplicate の newest
 * occurrence だけを残して受理順を維持する。
 */
export function normalizeVptaPersistedSemanticKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index]!;
    if (seen.has(key)) continue;
    seen.add(key);
    newestFirst.push(key);
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
    (input.comparator !== "reportDateTimeThenSerial"
      && input.comparator !== "reportDateTimeThenSerialThenVariant")
    || !incomingDate.valid
    || !currentDate.valid
    || incomingDate.epochMs == null
    || currentDate.epochMs == null
    || incomingDate.epochMs !== currentDate.epochMs
  ) return relation;
  if (!(serialIsMissing(incoming) && serialIsMissing(current))) return "unordered";
  if (input.comparator !== "reportDateTimeThenSerialThenVariant") return "equal";
  if (incoming.variantRank == null && current.variantRank == null) return "equal";
  if (incoming.variantRank == null || current.variantRank == null) return "unordered";
  return incoming.variantRank === current.variantRank
    ? "equal"
    : incoming.variantRank > current.variantRank ? "newer" : "older";
}

/**
 * domain/revisionFamily/subject 単位の意味 revision gate。
 * transport messageId は扱わず、同一 revision の通常報・訂正・取消だけを判定する。
 */
export class TelegramRevisionGate {
  private readonly states = new Map<string, AcceptedRevisionState>();
  private readonly warnedFamilyCapacity = new Map<string, number>();
  private readonly vptaCapacityPlanReceipts = new WeakMap<
    VptaCapacityPlan,
    {
      input: TelegramRevisionGateInput;
      candidateKind: VptaCapacityPlan["candidateKind"];
      stateSignature: string;
    }
  >();
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
  private ownerVersion = 0;

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
    const before = this.mutationFingerprint();
    const decision = this.decideInternal(input, true);
    if (this.mutationFingerprint() !== before) this.ownerVersion += 1;
    return decision;
  }

  private buildTyphoonProbabilityCapacityData(
    input: TelegramRevisionGateInput,
    candidateKind: VptaCapacityPlan["candidateKind"],
  ): {
    subject: string;
    maxSubjects: number;
    bundles: VptaCapacityBundle[];
    selection: VptaCapacitySelection;
    stateSignature: string;
  } {
    const subjectPrefix = "typhoonProbability:";
    const subject = input.stateSubjectKey;
    const eventId = subject?.startsWith(subjectPrefix) === true
      ? subject.slice(subjectPrefix.length)
      : "";
    if (input.domain !== "typhoonProbability"
      || input.revisionFamily !== "VPTA50"
      || subject == null
      || validateTyphoonProbabilityEventId(eventId) !== eventId) {
      throw new Error("invalid VPTA capacity input");
    }
    const maxSubjects = input.maxSubjects ?? TYPHOON_PROBABILITY_MAX_SUBJECTS;
    if (maxSubjects !== TYPHOON_PROBABILITY_MAX_SUBJECTS) {
      throw new Error("invalid VPTA capacity input");
    }
    const cancelled = candidateKind === "cancel" || candidateKind === "deactivateAllZero";
    const incomingClass: VptaCapacityClass = candidateKind === "active"
      ? "P+G"
      : cancelled ? "GT" : "GA";
    const prefix = `${input.domain}:${input.revisionFamily}:`;
    const activeSubjects = new Set(input.activeFamilySubjects ?? []);
    const bundles: VptaCapacityBundle[] = [...this.states]
      .filter(([stateKey]) => stateKey.startsWith(prefix) && stateKey !== `${prefix}${subject}`)
      .map(([stateKey, state]) => {
        const stateSubjectKey = stateKey.slice(prefix.length);
        return {
          stateSubjectKey,
          acceptedAtMs: state.acceptedAtMs,
          class: state.cancelled ? "GT" : activeSubjects.has(stateSubjectKey) ? "P+G" : "GA",
        };
      });
    bundles.push({
      stateSubjectKey: subject,
      acceptedAtMs: input.meta.receivedAtMs,
      class: incomingClass,
      incoming: true,
    });
    const selection = selectVptaCapacityBundles(bundles, maxSubjects);
    const stateSignature = JSON.stringify([...bundles]
      .sort((left, right) => compareCodeUnit(left.stateSubjectKey, right.stateSubjectKey))
      .map((bundle) => [
        bundle.stateSubjectKey,
        bundle.acceptedAtMs,
        bundle.class,
        bundle.incoming === true,
      ]));
    return { subject, maxSubjects, bundles, selection, stateSignature };
  }

  /** §5.3 step 11: mutation-free capacity planning with a single-use gate receipt. */
  planTyphoonProbabilityCapacity(
    input: TelegramRevisionGateInput,
    candidateKind: VptaCapacityPlan["candidateKind"],
  ): VptaCapacityPlan {
    const data = this.buildTyphoonProbabilityCapacityData(input, candidateKind);
    const plan = deepFreeze<VptaCapacityPlan>({
      stateSubjectKey: data.subject,
      candidateKind,
      maxSubjects: data.maxSubjects,
      selection: data.selection,
    });
    this.vptaCapacityPlanReceipts.set(plan, {
      input,
      candidateKind,
      stateSignature: data.stateSignature,
    });
    return plan;
  }

  /**
   * VPTA50 専用の single-commit operation。commit record を完全に構成して
   * freeze できた場合だけ canonical map を置換する。
   */
  decideTyphoonProbability(
    input: TelegramRevisionGateInput,
    candidateKind: VptaCapacityPlan["candidateKind"],
    suppliedCapacityPlan?: VptaCapacityPlan,
  ): VptaGateResult {
    const subjectPrefix = "typhoonProbability:";
    const subject = input.stateSubjectKey;
    const eventId = subject?.startsWith(subjectPrefix) === true
      ? subject.slice(subjectPrefix.length)
      : "";
    if (
      input.domain !== "typhoonProbability"
      || input.revisionFamily !== "VPTA50"
      || subject == null
      || validateTyphoonProbabilityEventId(eventId) !== eventId
      || input.durable !== true
      || input.tombstoneRetentionMs !== DEFAULT_DURABLE_TOMBSTONE_RETENTION_MS
    ) {
      return {
        kind: "suppressed",
        decision: reject("invalidMeta", null) as TelegramRevisionDecision & { accepted: false },
        durableChanged: false,
      };
    }
    const decision = this.evaluate(input);
    if (!decision.accepted) {
      return {
        kind: "suppressed",
        decision: decision as TelegramRevisionDecision & { accepted: false },
        durableChanged: false,
      };
    }
    const key = `${input.domain}:${input.revisionFamily}:${subject}`;
    const current = this.states.get(key);
    const rawRevision = telegramRevision(input.meta);
    const comparison: TelegramRevisionComparisonInput = {
      revision: {
        ...rawRevision,
        eventId: { raw: eventId, value: eventId, valid: true },
        type: { raw: "VPTA50", value: "VPTA50", valid: true },
      },
      stateSubjectKey: subject,
    };
    const semanticKey = telegramRevisionSemanticKey(input);
    const semanticKeys = decision.relation === "equal" && current != null
      ? normalizeVptaPersistedSemanticKeys([...current.semanticKeys, semanticKey])
      : [semanticKey];
    if (semanticKeys.length === 0 || semanticKeys.at(-1) !== semanticKey) {
      throw new Error("VPTA semantic-key commit invariant failed");
    }
    const cancelled = candidateKind === "cancel" || candidateKind === "deactivateAllZero";
    const prefix = `${input.domain}:${input.revisionFamily}:`;
    const capacityPlan = suppliedCapacityPlan
      ?? this.planTyphoonProbabilityCapacity(input, candidateKind);
    const receipt = this.vptaCapacityPlanReceipts.get(capacityPlan);
    const currentCapacityData = this.buildTyphoonProbabilityCapacityData(input, candidateKind);
    if (receipt == null
      || receipt.input !== input
      || receipt.candidateKind !== candidateKind
      || receipt.stateSignature !== currentCapacityData.stateSignature
      || capacityPlan.stateSubjectKey !== subject
      || capacityPlan.candidateKind !== candidateKind
      || capacityPlan.maxSubjects !== currentCapacityData.maxSubjects) {
      throw new Error("stale or foreign VPTA capacity plan");
    }
    this.vptaCapacityPlanReceipts.delete(capacityPlan);
    const capacity = capacityPlan.selection;
    if (capacity.kind === "protectedOverflow"
      || capacity.discarded.some((bundle) => bundle.incoming === true)) {
      return {
        kind: "suppressed",
        decision: reject("capacityExceeded", null) as TelegramRevisionDecision & { accepted: false },
        durableChanged: false,
      };
    }
    const acceptedDecision = deepFreeze(structuredClone(decision)) as TelegramRevisionDecision & { accepted: true };
    const frozenComparison = deepFreeze(structuredClone(comparison));
    const frozenSemanticKeys = deepFreeze([...semanticKeys]);
    const reportTimeMs = frozenComparison.revision.reportDateTime.epochMs;
    if (reportTimeMs == null || !Number.isSafeInteger(reportTimeMs)) {
      throw new Error("VPTA report-time commit invariant failed");
    }
    const binding = deepFreeze<AcceptedTyphoonProbabilityBinding>({
      revision: {
        reportTimeMs,
        serial: frozenComparison.revision.serial.valid
          ? frozenComparison.revision.serial.raw
          : null,
      },
      appliedSemanticKey: frozenSemanticKeys.at(-1)!,
    });
    const canonicalState = deepFreeze<AcceptedRevisionState>({
      comparison: frozenComparison,
      semanticKeys: new Set(frozenSemanticKeys),
      cancelled,
      acceptedAtMs: input.meta.receivedAtMs,
      durable: true,
      tombstoneRetentionMs: DEFAULT_DURABLE_TOMBSTONE_RETENTION_MS,
      retainForFamilyCapacity: false,
      legacyRevisionKey: input.legacyRevisionKey ?? eventId,
      legacyRevisionKeyProvenance: input.legacyRevisionKeyProvenance ?? "eventId",
    });
    const commit = deepFreeze<VptaAcceptedCommit>({
      stateSubjectKey: subject,
      revisionFamily: "VPTA50",
      decision: acceptedDecision,
      comparison: canonicalState.comparison,
      semanticKeys: frozenSemanticKeys,
      cancelled: canonicalState.cancelled,
      acceptedAtMs: canonicalState.acceptedAtMs,
      tombstoneRetentionMs: canonicalState.tombstoneRetentionMs as 604_800_000,
      binding,
    });

    // No mutation precedes this point. From here the capacity plan and incoming
    // canonical entry are applied synchronously as one operation.
    for (const victim of capacity.discarded) {
      this.states.delete(`${prefix}${victim.stateSubjectKey}`);
    }
    this.states.delete(key);
    this.states.set(key, canonicalState);
    this.rearmCapacityWarning(input.domain, input.revisionFamily);
    this.ownerVersion += 1;
    return { kind: "accepted", commit };
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
    const provenanceValid = this.validateVolcanoLiveInput(input);
    if (!provenanceValid) return reject("invalidMeta", null);
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
        input.activeFamilySubjects,
        input.familyCapacityMode,
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
          input.activeFamilySubjects,
          input.familyCapacityMode,
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
        this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects, input.activeFamilySubjects);
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
    const ashfallSerial = input.domain === "volcano" && input.revisionFamily === "volcanoAshfall"
      ? normalizeVolcanoAshfallSerial(rawRevision.serial.raw)
      : null;
    const comparisonSerial = ashfallSerial?.kind === "numeric"
      ? { raw: ashfallSerial.canonicalRaw, numeric: ashfallSerial.numeric, valid: true }
      : ashfallSerial?.kind === "missing"
        ? { raw: null, numeric: null, valid: false }
        : rawRevision.serial;
    const vptaEventId = input.domain === "typhoonProbability"
      && input.revisionFamily === "VPTA50"
      && input.stateSubjectKey.startsWith("typhoonProbability:")
      ? input.stateSubjectKey.slice("typhoonProbability:".length)
      : null;
    const incomingComparison: TelegramRevisionComparisonInput = {
      // comparator の identity 欄を registry identity へ束縛する。EventID を identity に
      // 含める family は subject extractor 側で組み込むため、EventID 欠落を一律拒否しない。
      revision: {
        ...rawRevision,
        serial: comparisonSerial,
        eventId: {
          raw: vptaEventId ?? input.stateSubjectKey,
          value: vptaEventId ?? input.stateSubjectKey,
          valid: true,
        },
        type: { raw: input.revisionFamily, value: input.revisionFamily, valid: true },
      },
      stateSubjectKey: input.stateSubjectKey,
      ...(input.variantRank == null ? {} : { variantRank: input.variantRank }),
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
        input.activeFamilySubjects,
        input.familyCapacityMode,
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
          input.activeFamilySubjects,
          input.familyCapacityMode,
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
          ...(input.volcanoProvenance == null
            ? {}
            : { volcanoProvenance: structuredClone(input.volcanoProvenance) }),
        });
        this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects, input.activeFamilySubjects);
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
      input.domain === "volcano"
      && input.revisionFamily === "volcanoAshfall"
      && existing.volcanoProvenance?.kind === "ashfall"
      && input.volcanoProvenance?.kind === "ashfall"
      && existing.volcanoProvenance.actualEventId !== input.volcanoProvenance.actualEventId
      && (cancellationTriggered || relation !== "newer")
    ) return reject("cancelTargetMismatch", relation);
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
          this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects, input.activeFamilySubjects);
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
        const duplicate = rejectMatchedSemanticKey("semanticDuplicate");
        if (duplicate != null) return duplicate;
        if (!(input.domain === "volcano" && input.revisionFamily === "volcanoAshfall")) {
          return reject("semanticDuplicate", relation);
        }
        if (existing.semanticKeys.size >= TELEGRAM_REVISION_MAX_SEMANTIC_KEYS) {
          return reject("capacityExceeded", relation);
        }
      }
      const matchedSemanticDecision = rejectMatchedSemanticKey("semanticDuplicate");
      if (matchedSemanticDecision != null) return matchedSemanticDecision;
      if (
        input.domain === "volcano"
        && input.revisionFamily === "volcanoAshfall"
        && existing.semanticKeys.size >= TELEGRAM_REVISION_MAX_SEMANTIC_KEYS
      ) return reject("capacityExceeded", relation);
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
        if (input.volcanoProvenance != null) {
          existing.volcanoProvenance = structuredClone(input.volcanoProvenance);
        }
        this.touchState(key, existing);
        this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects, input.activeFamilySubjects);
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
        ...(input.volcanoProvenance == null
          ? {}
          : { volcanoProvenance: structuredClone(input.volcanoProvenance) }),
      });
      this.enforceFamilyLimit(input.domain, input.revisionFamily, input.maxSubjects, input.activeFamilySubjects);
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

  private validateVolcanoLiveInput(input: TelegramRevisionGateInput): boolean {
    const isAlert = input.domain === "volcano" && input.revisionFamily === "volcanoAlert";
    const isAshfall = input.domain === "volcano" && input.revisionFamily === "volcanoAshfall";
    if (!isAlert && !isAshfall) {
      return input.variantRank == null && input.volcanoProvenance == null;
    }
    if (isAlert) {
      const provenance = input.volcanoProvenance;
      return input.variantRank == null
        && provenance?.kind === "alert"
        && (provenance.sourceFamily === "VFVO50"
          || provenance.sourceFamily === "VFVO51"
          || provenance.sourceFamily === "VFSVii")
        && input.meta.type.value === provenance.sourceFamily
        && provenance.operationalV2ResolutionId == null;
    }
    const provenance = input.volcanoProvenance;
    const normalizedEventId = input.meta.eventId.value?.normalize("NFC") ?? "";
    const eventId = /\p{Cc}/u.test(normalizedEventId) ? null : normalizedEventId.trim();
    return (input.variantRank === 0 || input.variantRank === 1)
      && provenance?.kind === "ashfall"
      && eventId !== ""
      && eventId != null
      && eventId.length <= 128
      && provenance.actualEventId === eventId
      && input.meta.type.value === provenance.sourceType
      && ((provenance.sourceType === "VFVO54" && input.variantRank === 0)
        || (provenance.sourceType === "VFVO55" && input.variantRank === 1));
  }

  private mutationFingerprint(): string {
    return JSON.stringify({
      states: [...this.states].map(([key, state]) => [
        key,
        state.comparison,
        [...state.semanticKeys],
        state.cancelled,
        state.acceptedAtMs,
        state.durable,
        state.tombstoneRetentionMs,
        state.retainForFamilyCapacity,
        state.legacyRevisionKey,
        state.legacyRevisionKeyProvenance,
        state.volcanoProvenance ?? null,
      ]),
      transientStates: [...this.transientStates],
      transientSemanticKeys: [...this.transientSemanticKeys],
    });
  }

  version(): number {
    return this.ownerVersion;
  }

  cloneSnapshot(): TelegramRevisionGateSnapshot {
    return structuredClone({
      version: this.ownerVersion,
      states: [...this.states].map(([key, state]) => ({
        key,
        comparison: structuredClone(state.comparison),
        semanticKeys: [...state.semanticKeys],
        cancelled: state.cancelled,
        acceptedAtMs: state.acceptedAtMs,
        durable: state.durable,
        tombstoneRetentionMs: state.tombstoneRetentionMs,
        retainForFamilyCapacity: state.retainForFamilyCapacity,
        legacyRevisionKey: state.legacyRevisionKey,
        legacyRevisionKeyProvenance: state.legacyRevisionKeyProvenance,
        ...(state.volcanoProvenance == null
          ? {}
          : { volcanoProvenance: structuredClone(state.volcanoProvenance) }),
      })),
      transientStates: [...this.transientStates].map(([key, state]) => ({ key, ...state })),
      transientSemanticKeys: [...this.transientSemanticKeys],
      warnedFamilyCapacity: [...this.warnedFamilyCapacity],
    });
  }

  /** Construct a listener-free scratch gate for a coordinator candidate. */
  static fromSnapshot(snapshot: TelegramRevisionGateSnapshot): TelegramRevisionGate {
    const gate = new TelegramRevisionGate(() => undefined);
    gate.loadSnapshot(snapshot, false);
    return gate;
  }

  replacePrevalidated(snapshot: TelegramRevisionGateSnapshot): void {
    this.loadSnapshot(snapshot, true);
  }

  private loadSnapshot(snapshot: TelegramRevisionGateSnapshot, commit: boolean): void {
    this.states.clear();
    this.transientStates.clear();
    this.transientSemanticKeys.clear();
    this.warnedFamilyCapacity.clear();
    for (const entry of snapshot.states) {
      this.states.set(entry.key, {
        comparison: structuredClone(entry.comparison),
        semanticKeys: new Set(entry.semanticKeys),
        cancelled: entry.cancelled,
        acceptedAtMs: entry.acceptedAtMs,
        durable: entry.durable,
        tombstoneRetentionMs: entry.tombstoneRetentionMs,
        retainForFamilyCapacity: entry.retainForFamilyCapacity,
        legacyRevisionKey: entry.legacyRevisionKey,
        legacyRevisionKeyProvenance: entry.legacyRevisionKeyProvenance,
        ...(entry.volcanoProvenance == null
          ? {}
          : { volcanoProvenance: structuredClone(entry.volcanoProvenance) }),
      });
    }
    for (const entry of snapshot.transientStates) {
      const { key, ...state } = entry;
      this.transientStates.set(key, structuredClone(state));
    }
    for (const [key, value] of snapshot.transientSemanticKeys) {
      this.transientSemanticKeys.set(key, value);
    }
    for (const [key, value] of snapshot.warnedFamilyCapacity) {
      this.warnedFamilyCapacity.set(key, value);
    }
    this.ownerVersion = commit ? this.ownerVersion + 1 : snapshot.version;
  }

  volcanoBinding(
    revisionFamily: "volcanoAlert" | "volcanoAshfall",
    stateSubjectKey: string,
  ): {
    comparison: TelegramRevisionComparisonInput;
    semanticKeys: string[];
    cancelled: boolean;
    acceptedAtMs: number;
    volcanoProvenance: PersistedVolcanoGateProvenanceV1 | null;
  } | null {
    const state = this.states.get(`volcano:${revisionFamily}:${stateSubjectKey}`);
    return state == null ? null : {
      comparison: structuredClone(state.comparison),
      semanticKeys: [...state.semanticKeys],
      cancelled: state.cancelled,
      acceptedAtMs: state.acceptedAtMs,
      volcanoProvenance: state.volcanoProvenance == null
        ? null
        : structuredClone(state.volcanoProvenance),
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
    activeFamilySubjects?: readonly string[],
    familyCapacityMode: "evictInactive" | "rejectNewSubject" = "evictInactive",
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
    if (familyCapacityMode === "rejectNewSubject") return false;
    return transient.length > 0 || regular.some(([key, state]) =>
      this.isFamilyEvictable(key, state, activeFamilySubjects));
  }

  private makeRoomForNewSubject(
    domain: string,
    revisionFamily: string,
    maxSubjects: number | null | undefined,
    nowMs: number,
    activeFamilySubjects?: readonly string[],
    familyCapacityMode: "evictInactive" | "rejectNewSubject" = "evictInactive",
  ): void {
    if (maxSubjects == null) return;
    this.validateFamilyLimit(domain, revisionFamily, maxSubjects);
    if (familyCapacityMode === "rejectNewSubject") {
      if (this.liveFamilyEntries(domain, revisionFamily, nowMs).length
        + this.liveTransientFamilyEntries(domain, revisionFamily, nowMs).length >= maxSubjects) {
        throw new Error(`telegram revision rejectNewSubject admission invariant violated: ${domain}:${revisionFamily}`);
      }
      return;
    }
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
        .filter(([key, state]) => this.isFamilyEvictable(key, state, activeFamilySubjects))
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

  private isFamilyEvictable(
    key: string,
    state: AcceptedRevisionState,
    activeFamilySubjects?: readonly string[],
  ): boolean {
    // live tombstone は遅延旧報を止める watermark。期限切れは decide 冒頭の
    // sweep() / liveFamilyEntries() で除かれるため、ここへ来る間は容量退場させない。
    if (state.cancelled) return false;
    if (activeFamilySubjects != null) {
      const domainSeparator = key.indexOf(":");
      const familySeparator = key.indexOf(":", domainSeparator + 1);
      const subject = familySeparator < 0 ? key : key.slice(familySeparator + 1);
      return !activeFamilySubjects.includes(subject);
    }
    return !(
      state.retainForFamilyCapacity
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
    activeFamilySubjects?: readonly string[],
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
        .filter(([key, state]) => this.isFamilyEvictable(key, state, activeFamilySubjects))
        .sort(([, left], [, right]) => left.acceptedAtMs - right.acceptedAtMs)[0]?.[0];
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
    const regularChanged = this.states.delete(`${domain}:${revisionFamily}:${stateSubjectKey}`);
    const transientKey = `${domain}:${revisionFamily}:${stateSubjectKey}`;
    const transientState = this.transientStates.get(transientKey);
    if (transientState != null) this.deleteTransientState(transientKey, transientState);
    if (regularChanged || transientState != null) this.ownerVersion += 1;
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
    let changed = false;
    for (const key of this.states.keys()) {
      if (key.startsWith(prefix) && !retainedKeys.has(key)) changed = this.states.delete(key) || changed;
    }
    for (const [key, state] of [...this.transientStates]) {
      if (key.startsWith(prefix) && !retainedKeys.has(key)) {
        this.deleteTransientState(key, state);
        changed = true;
      }
    }
    this.rearmCapacityWarning(domain, revisionFamily);
    if (changed) this.ownerVersion += 1;
  }

  clearFamily(domain: string, revisionFamily: string): void {
    this.clearRevisionFamilySubjectsExcept(domain, revisionFamily, []);
  }

  clearAll(): void {
    const changed = this.states.size > 0 || this.transientStates.size > 0
      || this.transientSemanticKeys.size > 0 || this.warnedFamilyCapacity.size > 0;
    this.states.clear();
    this.transientStates.clear();
    this.transientSemanticKeys.clear();
    this.warnedFamilyCapacity.clear();
    if (changed) this.ownerVersion += 1;
  }

  /** Finite-lifecycle domain の active watermark と tombstone を同じ期限で退場させる。 */
  expireRevisionFamily(
    domain: string,
    revisionFamily: string,
    nowMs: number,
    retentionMs: number,
  ): boolean {
    return this.expireRevisionFamilyDetailed(domain, revisionFamily, nowMs, retentionMs).changed;
  }

  expireRevisionFamilyDetailed(
    domain: string,
    revisionFamily: string,
    nowMs: number,
    retentionMs: number,
  ): RevisionFamilyExpiryResult {
    const prefix = `${domain}:${revisionFamily}:`;
    const expiredStateSubjectKeys: string[] = [];
    for (const [key, state] of this.states) {
      if (key.startsWith(prefix) && nowMs - state.acceptedAtMs > retentionMs) {
        this.states.delete(key);
        expiredStateSubjectKeys.push(key.slice(prefix.length));
      }
    }
    for (const [subjectKey, state] of [...this.transientStates]) {
      if (
        state.domain === domain
        && state.revisionFamily === revisionFamily
        && nowMs - state.acceptedAtMs > retentionMs
      ) {
        this.deleteTransientState(subjectKey, state);
        expiredStateSubjectKeys.push(subjectKey.startsWith(prefix) ? subjectKey.slice(prefix.length) : subjectKey);
      }
    }
    this.rearmCapacityWarning(domain, revisionFamily);
    const unique = [...new Set(expiredStateSubjectKeys)].sort(compareCodeUnit);
    if (unique.length > 0) this.ownerVersion += 1;
    return { changed: unique.length > 0, expiredStateSubjectKeys: unique };
  }

  /**
   * Policy-owned lifecycle compaction.  Active watermark を tombstone TTL で
   * 補完してはならない。Transient dedupe state は entry 固有 TTL のみで回収する。
   */
  expireRevisionFamilyByLifecycle(
    domain: string,
    revisionFamily: string,
    nowMs: number,
    retention: RevisionFamilyLifecycleRetention,
  ): RevisionFamilyExpiryResult {
    const prefix = `${domain}:${revisionFamily}:`;
    const expiredStateSubjectKeys: string[] = [];
    for (const [key, state] of this.states) {
      if (!key.startsWith(prefix)) continue;
      const retentionMs = state.cancelled
        ? retention.tombstoneRetentionMs
        : retention.activeRetentionMs;
      if (retentionMs != null && nowMs - state.acceptedAtMs > retentionMs) {
        this.states.delete(key);
        expiredStateSubjectKeys.push(key.slice(prefix.length));
      }
    }
    for (const [subjectKey, state] of [...this.transientStates]) {
      if (
        state.domain === domain
        && state.revisionFamily === revisionFamily
        && nowMs - state.acceptedAtMs > state.retentionMs
      ) {
        this.deleteTransientState(subjectKey, state);
        expiredStateSubjectKeys.push(subjectKey.startsWith(prefix)
          ? subjectKey.slice(prefix.length)
          : subjectKey);
      }
    }
    this.rearmCapacityWarning(domain, revisionFamily);
    const unique = [...new Set(expiredStateSubjectKeys)].sort(compareCodeUnit);
    if (unique.length > 0) this.ownerVersion += 1;
    return { changed: unique.length > 0, expiredStateSubjectKeys: unique };
  }

  /** Mutation-free family subject snapshot used by rejectNewSubject preflight. */
  revisionFamilySubjectKeys(domain: string, revisionFamily: string): string[] {
    const prefix = `${domain}:${revisionFamily}:`;
    return [...new Set([
      ...[...this.states.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
      ...[...this.transientStates].filter(([, state]) => state.domain === domain && state.revisionFamily === revisionFamily)
        .map(([key]) => key.startsWith(prefix) ? key.slice(prefix.length) : key),
    ])].sort(compareCodeUnit);
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
        ...(state.volcanoProvenance == null
          ? {}
          : { volcanoProvenance: structuredClone(state.volcanoProvenance) }),
      });
    }
    return result;
  }

  restoreDurableEntries(entries: readonly PersistedTelegramRevisionGateEntryV2[]): void {
    let changed = false;
    for (const entry of entries) {
      const key = `${entry.domain}:${entry.revisionFamily}:${entry.stateSubjectKey}`;
      if (
        !this.states.has(key)
        && this.states.size + this.transientStates.size >= TELEGRAM_REVISION_MAX_ENTRIES
      ) {
        this.warnCapacityRejected("restore", "durable", TELEGRAM_REVISION_MAX_ENTRIES);
        continue;
      }
      if (entry.domain === "volcano" && entry.revisionFamily === "volcanoAshfall"
        && entry.semanticKeys.length > TELEGRAM_REVISION_MAX_SEMANTIC_KEYS) {
        throw new Error("volcano ashfall semantic key capacity exceeded");
      }
      this.states.set(key, {
        comparison: structuredClone(entry.comparison),
        semanticKeys: new Set(
          entry.domain === "typhoonProbability" && entry.revisionFamily === "VPTA50"
            ? normalizeVptaPersistedSemanticKeys(entry.semanticKeys)
            : compactPersistedSemanticKeys(entry.semanticKeys),
        ),
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
        ...(entry.volcanoProvenance == null
          ? {}
          : { volcanoProvenance: structuredClone(entry.volcanoProvenance) }),
      });
      changed = true;
    }
    if (changed) this.ownerVersion += 1;
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
