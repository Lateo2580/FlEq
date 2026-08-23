import type {
  LegacyCounterpartOutcome,
  ProcessOutcome,
} from "../presentation/types";
import type {
  LegacyCounterpartSourceType,
  TelegramMeta,
} from "../../types";
import {
  LEGACY_CORRELATION_RETENTION_MS,
  PRODUCTION_LEGACY_COUNTERPART_REGISTRY,
  type LegacyCounterpartCorrelationKey,
  type LegacyCounterpartRegistry,
  type LegacyCounterpartRevisionRef,
  type LegacyCounterpartRule,
} from "./legacy-counterpart-registry";

export const LEGACY_CORRELATOR_SOURCE_CAPACITY = 512;
export const LEGACY_CORRELATOR_COUNTERPART_CAPACITY = 512;
export const LEGACY_CORRELATOR_TOMBSTONE_CAPACITY = 512;

export interface LegacyCounterpartClock {
  nowMs(): number;
}

export interface LegacyCounterpartTimerScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export type LegacyCounterpartAffectedSource =
  | { kind: "suppressSource"; outcome: LegacyCounterpartOutcome; sourceIdentity: string; counterpartOutcome: ProcessOutcome }
  | { kind: "releaseSource"; outcome: LegacyCounterpartOutcome; sourceIdentity: string; reason: "timeout" | "counterpartCancelled" | "correlatorCapacityExceeded" | "releasedUpdate"; displayLifecycleOnly?: boolean }
  | { kind: "ambiguousSource"; outcome: LegacyCounterpartOutcome; sourceIdentity: string; candidateCount: number; ambiguityReason?: "multipleCandidates" | "multipleSources" }
  | { kind: "reconcileLateCounterpart"; outcome: ProcessOutcome; sourceOutcome: LegacyCounterpartOutcome; sourceIdentity: string };

type LegacyCounterpartBatch = {
  /** 複数 source の各 disposition。top-level action は先頭要素の互換 projection。 */
  affectedSources?: readonly LegacyCounterpartAffectedSource[];
};

type LegacyCounterpartActionPayload =
  | { kind: "emitNow"; outcome: ProcessOutcome; reason: "counterpart"; sourceType: LegacyCounterpartSourceType }
  | { kind: "emitNow"; outcome: ProcessOutcome; reason: "unrelated" }
  | { kind: "holdSource"; outcome: LegacyCounterpartOutcome; sourceIdentity: string; deadlineMs: number }
  | ({ kind: "suppressSource"; outcome: LegacyCounterpartOutcome; sourceIdentity: string; counterpartOutcome: ProcessOutcome; triggerOutcome?: ProcessOutcome } & LegacyCounterpartBatch)
  | ({ kind: "releaseSource"; outcome: LegacyCounterpartOutcome; sourceIdentity: string; reason: "timeout" | "counterpartCancelled" | "correlatorCapacityExceeded" | "releasedUpdate"; triggerOutcome?: ProcessOutcome; candidateCount?: number; displayLifecycleOnly?: boolean } & LegacyCounterpartBatch)
  | ({ kind: "ambiguousSource"; outcome: LegacyCounterpartOutcome; sourceIdentity: string; candidateCount: number; ambiguityReason?: "multipleCandidates" | "multipleSources"; triggerOutcome?: ProcessOutcome } & LegacyCounterpartBatch)
  | ({ kind: "reconcileLateCounterpart"; outcome: ProcessOutcome; sourceOutcome: LegacyCounterpartOutcome; sourceIdentity: string } & LegacyCounterpartBatch);

export type LegacyCounterpartAction = LegacyCounterpartActionPayload & { decidedAtMs: number };

type LegacyCounterpartLifecycleEventPayload =
  | { kind: "legacySourceArrivedFirst"; sourceType: LegacyCounterpartSourceType; sourceIdentity: string }
  | { kind: "legacyCounterpartArrivedFirst"; sourceType: LegacyCounterpartSourceType; counterpartIdentity: string }
  | { kind: "legacyCorrelationExpired"; sourceType: LegacyCounterpartSourceType; sourceIdentity: string }
  | { kind: "legacyLateCounterpartExpired"; sourceType: LegacyCounterpartSourceType; sourceIdentity: string }
  | { kind: "legacyCorrectionMismatch"; sourceType: LegacyCounterpartSourceType; counterpartType: string }
  | { kind: "legacyCancellationMismatch"; sourceType: LegacyCounterpartSourceType; counterpartType: string }
  | { kind: "sourceCapacityExceeded"; sourceType: LegacyCounterpartSourceType; sourceIdentity: string }
  | { kind: "counterpartEvicted"; sourceType: LegacyCounterpartSourceType; counterpartIdentity: string }
  | { kind: "counterpartCapacityBypassed"; sourceType: LegacyCounterpartSourceType; counterpartIdentity: string };

export type LegacyCounterpartLifecycleEvent = LegacyCounterpartLifecycleEventPayload & { decidedAtMs: number };

export interface LegacyCounterpartCorrelatorOptions {
  registry?: LegacyCounterpartRegistry;
  clock?: LegacyCounterpartClock;
  timerScheduler?: LegacyCounterpartTimerScheduler;
  sourceCapacity?: number;
  counterpartCapacity?: number;
  tombstoneCapacity?: number;
  onAction?: (action: LegacyCounterpartAction) => void;
  onLifecycleEvent?: (event: LegacyCounterpartLifecycleEvent) => void;
}

export interface LegacyCounterpartCorrelatorFactoryContext {
  actionSink: (action: LegacyCounterpartAction) => void;
  lifecycleEventSink: (event: LegacyCounterpartLifecycleEvent) => void;
}

export type LegacyCounterpartCorrelatorFactory = (
  context: LegacyCounterpartCorrelatorFactoryContext,
) => LegacyCounterpartCorrelator;

type SourceStatus =
  | "pending"
  | "released-unmatched"
  | "ambiguous"
  | "matched-suppressed"
  | "late-reconciled";

interface RevisionIdentity {
  reportDateTimeMs: number;
  serial: number | null;
}

interface SourceRecord {
  id: string;
  stableId: number;
  generation: number;
  rule: LegacyCounterpartRule;
  outcome: LegacyCounterpartOutcome;
  meta: TelegramMeta;
  key: LegacyCounterpartCorrelationKey | null;
  revision: RevisionIdentity;
  receivedAtMs: number;
  holdbackDeadlineMs: number;
  expiryMs: number;
  status: SourceStatus;
  candidateIds: Set<string>;
  holdTimer: unknown | null;
  expiryTimer: unknown | null;
}

interface CounterpartRecord {
  id: string;
  stableId: number;
  generation: number;
  rule: LegacyCounterpartRule;
  outcome: ProcessOutcome;
  meta: TelegramMeta;
  key: LegacyCounterpartCorrelationKey | null;
  revision: RevisionIdentity;
  receivedAtMs: number;
  expiryMs: number;
  referencedBy: Set<string>;
  expiryTimer: unknown | null;
}

interface ExpiredSourceTombstone {
  id: string;
  stableId: number;
  generation: number;
  sourceType: LegacyCounterpartSourceType;
  rule: LegacyCounterpartRule;
  eventId: string | null;
  key: LegacyCounterpartCorrelationKey | null;
  revision: RevisionIdentity;
  infoType: TelegramMeta["infoType"];
  reportDateTimeMs: number;
  expiredAtMs: number;
  expiryMs: number;
  expiryTimer: unknown | null;
}

const SYSTEM_CLOCK: LegacyCounterpartClock = { nowMs: () => Date.now() };
const SYSTEM_TIMER: LegacyCounterpartTimerScheduler = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function eventIdOf(meta: TelegramMeta): string | null {
  return meta.eventId.valid ? nonBlank(meta.eventId.value) : null;
}

function normalizedEventId(
  rule: LegacyCounterpartRule,
  side: "source" | "counterpart",
  meta: TelegramMeta,
): string | null {
  const eventId = eventIdOf(meta);
  if (eventId == null) return null;
  try {
    const normalized = rule.normalizeEventId == null
      ? eventId
      : rule.normalizeEventId({
          side,
          headType: nonBlank(meta.type.value) ?? "",
          eventId,
          rawEventId: eventId,
        });
    return nonBlank(normalized);
  } catch {
    return null;
  }
}

function isEligibleForCorrelation(rule: LegacyCounterpartRule, meta: TelegramMeta): boolean {
  return rule.eligibleInfoTypes == null
    || (meta.infoType.value != null && rule.eligibleInfoTypes.includes(meta.infoType.value));
}

function serialOf(meta: TelegramMeta): number | null {
  return meta.serial.valid ? meta.serial.numeric : null;
}

function strictRevisionIdentity(meta: TelegramMeta): RevisionIdentity | null {
  const reportDateTimeMs = meta.reportDateTime.valid ? meta.reportDateTime.epochMs : null;
  return reportDateTimeMs == null ? null : { reportDateTimeMs, serial: serialOf(meta) };
}

function revisionMatches(actual: RevisionIdentity, target: LegacyCounterpartRevisionRef): boolean {
  return actual.reportDateTimeMs === target.reportDateTimeMs && actual.serial === target.serial;
}

function normalizedCodes(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))].sort();
}

function sameCodes(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizedCodes(left);
  const b = normalizedCodes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalKey(key: LegacyCounterpartCorrelationKey | null): string | null {
  if (key == null) return null;
  const office = nonBlank(key.officeCode);
  const areas = normalizedCodes(key.areaCodes);
  const phenomena = normalizedCodes(key.phenomenonCodes);
  const kinds = normalizedCodes(key.kindCodes);
  if (
    office == null
    || areas.length === 0
    || phenomena.length + kinds.length === 0
    || key.targetTimeMs == null
    || !Number.isFinite(key.targetTimeMs)
  ) return null;
  return JSON.stringify([office, areas, phenomena, kinds, key.targetTimeMs]);
}

function codeIdentityMatches(
  source: LegacyCounterpartCorrelationKey | null,
  counterpart: LegacyCounterpartCorrelationKey | null,
): boolean {
  if (source == null || counterpart == null) return false;
  const sourceOffice = nonBlank(source.officeCode);
  const counterpartOffice = nonBlank(counterpart.officeCode);
  if (sourceOffice == null || counterpartOffice == null || sourceOffice !== counterpartOffice) return false;
  const sourceAreas = normalizedCodes(source.areaCodes);
  const counterpartAreas = normalizedCodes(counterpart.areaCodes);
  const sourcePhenomena = normalizedCodes(source.phenomenonCodes);
  const counterpartPhenomena = normalizedCodes(counterpart.phenomenonCodes);
  const sourceKinds = normalizedCodes(source.kindCodes);
  const counterpartKinds = normalizedCodes(counterpart.kindCodes);
  if (sourceAreas.length === 0 || counterpartAreas.length === 0) return false;
  if (
    sourcePhenomena.length + sourceKinds.length === 0
    || counterpartPhenomena.length + counterpartKinds.length === 0
  ) return false;
  if (!sameCodes(sourceAreas, counterpartAreas)) return false;
  if (!sameCodes(sourcePhenomena, counterpartPhenomena)) return false;
  if (!sameCodes(sourceKinds, counterpartKinds)) return false;
  return source.targetTimeMs != null
    && counterpart.targetTimeMs != null
    && Number.isFinite(source.targetTimeMs)
    && Number.isFinite(counterpart.targetTimeMs)
    && source.targetTimeMs === counterpart.targetTimeMs;
}

function correlationIdentityAndTimeMatches(
  rule: LegacyCounterpartRule,
  sourceMeta: TelegramMeta,
  sourceKey: LegacyCounterpartCorrelationKey | null,
  counterpartMeta: TelegramMeta,
  counterpartKey: LegacyCounterpartCorrelationKey | null,
): boolean {
  const sourceTime = sourceMeta.reportDateTime.epochMs;
  const counterpartTime = counterpartMeta.reportDateTime.epochMs;
  if (sourceTime == null || counterpartTime == null) return false;
  const delta = sourceTime - counterpartTime;
  if (delta < -rule.windowBeforeMs || delta > rule.windowAfterMs) return false;
  const sourceEventId = eventIdOf(sourceMeta);
  const counterpartEventId = eventIdOf(counterpartMeta);
  if (sourceEventId != null && counterpartEventId != null) {
    const normalizedSourceEventId = normalizedEventId(rule, "source", sourceMeta);
    const normalizedCounterpartEventId = normalizedEventId(rule, "counterpart", counterpartMeta);
    return normalizedSourceEventId != null
      && normalizedCounterpartEventId != null
      && normalizedSourceEventId === normalizedCounterpartEventId;
  }
  return codeIdentityMatches(sourceKey, counterpartKey);
}

function correlationMatches(
  rule: LegacyCounterpartRule,
  sourceMeta: TelegramMeta,
  sourceKey: LegacyCounterpartCorrelationKey | null,
  counterpartMeta: TelegramMeta,
  counterpartKey: LegacyCounterpartCorrelationKey | null,
): boolean {
  if (!correlationIdentityAndTimeMatches(rule, sourceMeta, sourceKey, counterpartMeta, counterpartKey)) {
    return false;
  }
  if (sourceMeta.infoType.value !== "訂正" && sourceMeta.infoType.value !== "取消") return true;
  const targetRevision = sourceKey?.targetRevision;
  const counterpartRevision = strictRevisionIdentity(counterpartMeta);
  return targetRevision != null
    && counterpartRevision != null
    && revisionMatches(counterpartRevision, targetRevision);
}

function parsedOf(outcome: ProcessOutcome): unknown {
  return outcome.parsed;
}

function metaOf(outcome: ProcessOutcome): TelegramMeta | null {
  if (outcome.domain === "legacyCounterpart") return outcome.parsed.meta;
  return outcome.msg.meta ?? null;
}

function sourceIdentity(outcome: LegacyCounterpartOutcome): string {
  const eventId = eventIdOf(outcome.parsed.meta);
  if (eventId != null) return `${outcome.parsed.type}:event:${eventId}`;
  return `${outcome.parsed.type}:message:${outcome.parsed.meta.messageId}`;
}

function counterpartIdentity(
  outcome: ProcessOutcome,
  meta: TelegramMeta,
  key: LegacyCounterpartCorrelationKey | null,
): string {
  const eventId = eventIdOf(meta);
  if (eventId != null) return `${outcome.headType}:event:${eventId}`;
  const canonical = canonicalKey(key);
  return canonical == null
    ? `${outcome.headType}:message:${meta.messageId}`
    : `${outcome.headType}:code:${canonical}`;
}

export interface LegacyCounterpartCorrelatorSnapshot {
  sourceCount: number;
  counterpartCount: number;
  tombstoneCount: number;
  sourceStatuses: Readonly<Record<string, SourceStatus>>;
  counterpartIds: readonly string[];
  tombstoneIds: readonly string[];
}

export class LegacyCounterpartCorrelator {
  private readonly registry: LegacyCounterpartRegistry;
  private readonly clock: LegacyCounterpartClock;
  private readonly timer: LegacyCounterpartTimerScheduler;
  private readonly sourceCapacity: number;
  private readonly counterpartCapacity: number;
  private readonly tombstoneCapacity: number;
  private onAction?: (action: LegacyCounterpartAction) => void;
  private actionSinkBound = false;
  private onLifecycleEvent?: (event: LegacyCounterpartLifecycleEvent) => void;
  private lifecycleEventSinkBound = false;
  private readonly sources = new Map<string, SourceRecord>();
  private readonly counterparts = new Map<string, CounterpartRecord>();
  private readonly tombstones = new Map<string, ExpiredSourceTombstone>();
  private nextStableId = 1;
  private disposed = false;

  constructor(options: LegacyCounterpartCorrelatorOptions = {}) {
    this.registry = options.registry ?? PRODUCTION_LEGACY_COUNTERPART_REGISTRY;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.timer = options.timerScheduler ?? SYSTEM_TIMER;
    this.sourceCapacity = options.sourceCapacity ?? LEGACY_CORRELATOR_SOURCE_CAPACITY;
    this.counterpartCapacity = options.counterpartCapacity ?? LEGACY_CORRELATOR_COUNTERPART_CAPACITY;
    this.tombstoneCapacity = options.tombstoneCapacity ?? LEGACY_CORRELATOR_TOMBSTONE_CAPACITY;
    if (options.onAction != null) {
      this.onAction = options.onAction;
      this.actionSinkBound = true;
    }
    if (options.onLifecycleEvent != null) {
      this.onLifecycleEvent = options.onLifecycleEvent;
      this.lifecycleEventSinkBound = true;
    }
    if (this.sourceCapacity < 1 || this.counterpartCapacity < 1 || this.tombstoneCapacity < 1) {
      throw new Error("legacy counterpart cache capacities must be positive");
    }
  }

  /** router が ownership 確定時に timer action sink を一度だけ結線する。 */
  setActionSink(actionSink: (action: LegacyCounterpartAction) => void): void {
    if (this.actionSinkBound) throw new Error("legacy counterpart action sink is already bound");
    this.onAction = actionSink;
    this.actionSinkBound = true;
  }

  /** router が ownership 確定時に lifecycle metric sink を一度だけ結線する。 */
  setLifecycleEventSink(lifecycleEventSink: (event: LegacyCounterpartLifecycleEvent) => void): void {
    if (this.lifecycleEventSinkBound) throw new Error("legacy counterpart lifecycle event sink is already bound");
    this.onLifecycleEvent = lifecycleEventSink;
    this.lifecycleEventSinkBound = true;
  }

  private decide<T extends LegacyCounterpartActionPayload>(action: T): T & { decidedAtMs: number } {
    return { ...action, decidedAtMs: this.clock.nowMs() };
  }

  private emitLifecycle(event: LegacyCounterpartLifecycleEventPayload): void {
    this.onLifecycleEvent?.({ ...event, decidedAtMs: this.clock.nowMs() });
  }

  accept(outcome: ProcessOutcome): LegacyCounterpartAction | null {
    if (this.disposed) return null;
    const nowMs = this.clock.nowMs();
    this.prune(nowMs);
    if (outcome.domain === "legacyCounterpart") return this.acceptSource(outcome, nowMs);
    const rule = this.registry.ruleByCounterpartType.get(outcome.headType);
    if (rule == null) return this.decide({ kind: "emitNow", outcome, reason: "unrelated" });
    return this.acceptCounterpart(outcome, rule, nowMs);
  }

  snapshot(): LegacyCounterpartCorrelatorSnapshot {
    const sourceStatuses: Record<string, SourceStatus> = {};
    for (const [id, record] of this.sources) sourceStatuses[id] = record.status;
    return {
      sourceCount: this.sources.size,
      counterpartCount: this.counterparts.size,
      tombstoneCount: this.tombstones.size,
      sourceStatuses,
      counterpartIds: [...this.counterparts.keys()],
      tombstoneIds: [...this.tombstones.keys()],
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.sources.values()) {
      this.clearTimer(record.holdTimer);
      this.clearTimer(record.expiryTimer);
    }
    for (const record of this.counterparts.values()) this.clearTimer(record.expiryTimer);
    for (const record of this.tombstones.values()) this.clearTimer(record.expiryTimer);
    this.sources.clear();
    this.counterparts.clear();
    this.tombstones.clear();
  }

  private acceptSource(outcome: LegacyCounterpartOutcome, nowMs: number): LegacyCounterpartAction {
    const rule = this.registry.ruleBySourceType.get(outcome.parsed.type);
    if (rule == null) return this.decide({ kind: "emitNow", outcome, reason: "unrelated" });
    const meta = outcome.parsed.meta;
    if (!isEligibleForCorrelation(rule, meta)) {
      const id = sourceIdentity(outcome);
      const invalidated = this.invalidatePendingPublishedSource(id);
      return this.decide({
        kind: "releaseSource",
        outcome: invalidated?.outcome ?? outcome,
        sourceIdentity: id,
        reason: "releasedUpdate",
        candidateCount: 0,
        ...(invalidated == null
          ? {}
          : { displayLifecycleOnly: true, triggerOutcome: outcome }),
      });
    }
    const revision = strictRevisionIdentity(meta);
    if (revision == null) return this.decide({ kind: "releaseSource", outcome, sourceIdentity: sourceIdentity(outcome), reason: "correlatorCapacityExceeded", candidateCount: 0 });
    const key = rule.extractEventKey(meta, outcome.parsed);
    const id = sourceIdentity(outcome);
    const existing = this.sources.get(id);
    this.observeSourceRevisionMismatch(rule, meta, key);
    if (existing != null) {
      existing.outcome = outcome;
      existing.meta = meta;
      existing.key = key;
      existing.revision = revision;
      if (existing.status === "released-unmatched") {
        return this.decide({ kind: "releaseSource", outcome, sourceIdentity: id, reason: "releasedUpdate" });
      }
      return this.recomputeSource(existing, undefined, false)
        ?? this.decide({ kind: "holdSource", outcome, sourceIdentity: id, deadlineMs: existing.holdbackDeadlineMs });
    }

    this.removeTombstone(id);
    const candidates = this.candidatesFor(rule, meta, key);
    if (this.sources.size >= this.sourceCapacity) {
      if (candidates.length === 0) {
        this.emitLifecycle({ kind: "legacySourceArrivedFirst", sourceType: rule.sourceType, sourceIdentity: id });
      }
      this.emitLifecycle({ kind: "sourceCapacityExceeded", sourceType: rule.sourceType, sourceIdentity: id });
      return this.decide({ kind: "releaseSource", outcome, sourceIdentity: id, reason: "correlatorCapacityExceeded", candidateCount: candidates.length });
    }

    const record: SourceRecord = {
      id,
      stableId: this.nextStableId++,
      generation: 1,
      rule,
      outcome,
      meta,
      key,
      revision,
      receivedAtMs: nowMs,
      holdbackDeadlineMs: nowMs + rule.holdbackMs,
      expiryMs: nowMs + LEGACY_CORRELATION_RETENTION_MS,
      status: "pending",
      candidateIds: new Set(),
      holdTimer: null,
      expiryTimer: null,
    };
    this.sources.set(id, record);
    this.armSourceExpiry(record);
    if (candidates.length === 0) {
      this.emitLifecycle({ kind: "legacySourceArrivedFirst", sourceType: rule.sourceType, sourceIdentity: id });
      this.armHoldback(record);
      return this.decide({ kind: "holdSource", outcome, sourceIdentity: id, deadlineMs: record.holdbackDeadlineMs });
    }
    this.setCandidates(record, candidates);
    if (candidates.length === 1) {
      record.status = "matched-suppressed";
      this.bindCounterpartExpiryToSource(candidates[0], record);
      return this.decide({
        kind: "suppressSource",
        outcome,
        sourceIdentity: id,
        counterpartOutcome: candidates[0].outcome,
      });
    }
    for (const candidate of candidates) this.bindCounterpartExpiryToSource(candidate, record);
    record.status = "ambiguous";
    return this.decide({
      kind: "ambiguousSource",
      outcome,
      sourceIdentity: id,
      candidateCount: candidates.length,
      ambiguityReason: "multipleCandidates",
    });
  }

  private observeSourceRevisionMismatch(
    rule: LegacyCounterpartRule,
    meta: TelegramMeta,
    key: LegacyCounterpartCorrelationKey | null,
  ): void {
    const infoType = meta.infoType.value;
    if (infoType !== "訂正" && infoType !== "取消") return;
    const identityCandidates = [...this.counterparts.values()].filter((record) =>
      record.rule === rule
      && correlationIdentityAndTimeMatches(rule, meta, key, record.meta, record.key),
    );
    if (identityCandidates.length === 0) return;
    const targetRevision = key?.targetRevision;
    if (
      targetRevision != null
      && identityCandidates.some((record) => revisionMatches(record.revision, targetRevision))
    ) return;
    this.emitLifecycle({
      kind: infoType === "訂正" ? "legacyCorrectionMismatch" : "legacyCancellationMismatch",
      sourceType: rule.sourceType,
      counterpartType: identityCandidates[0].outcome.headType,
    });
  }

  private acceptCounterpart(
    outcome: ProcessOutcome,
    rule: LegacyCounterpartRule,
    nowMs: number,
  ): LegacyCounterpartAction {
    const meta = metaOf(outcome);
    const revision = meta == null ? null : strictRevisionIdentity(meta);
    if (meta == null || revision == null) return this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
    if (!isEligibleForCorrelation(rule, meta)) {
      return this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
    }
    const key = rule.extractEventKey(meta, parsedOf(outcome));
    const id = counterpartIdentity(outcome, meta, key);
    const existing = this.counterparts.get(id);
    const previouslyReferencedSourceIds = existing == null ? [] : [...existing.referencedBy];
    const infoType = meta.infoType.value;

    if (infoType === "取消") {
      if (existing == null || key?.targetRevision == null || !revisionMatches(existing.revision, key.targetRevision)) {
        this.emitLifecycle({ kind: "legacyCancellationMismatch", sourceType: rule.sourceType, counterpartType: outcome.headType });
        return this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
      }
      return this.removeCounterpart(existing, outcome, true)
        ?? this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
    }

    if (
      infoType === "訂正"
      && (
        existing == null
        || key?.targetRevision == null
        || !revisionMatches(existing.revision, key.targetRevision)
      )
    ) {
      this.emitLifecycle({ kind: "legacyCorrectionMismatch", sourceType: rule.sourceType, counterpartType: outcome.headType });
      return this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
    }

    let record = existing;
    if (record == null) {
      record = {
        id,
        stableId: this.nextStableId++,
        generation: 1,
        rule,
        outcome,
        meta,
        key,
        revision,
        receivedAtMs: nowMs,
        expiryMs: nowMs + LEGACY_CORRELATION_RETENTION_MS,
        referencedBy: new Set(),
        expiryTimer: null,
      };
    } else {
      record.outcome = outcome;
      record.meta = meta;
      record.key = key;
      record.revision = revision;
    }

    const directlyMatchingSources = [...this.sources.values()].filter((source) =>
      source.rule === rule && correlationMatches(rule, source.meta, source.key, meta, key),
    );
    const affectedSources = [...new Set([
      ...previouslyReferencedSourceIds,
      ...directlyMatchingSources.map((source) => source.id),
    ])]
      .map((sourceId) => this.sources.get(sourceId))
      .filter((source): source is SourceRecord => source != null);
    if (existing == null) {
      if (directlyMatchingSources.length === 0) {
        this.emitLifecycle({ kind: "legacyCounterpartArrivedFirst", sourceType: rule.sourceType, counterpartIdentity: id });
      }
      if (this.counterparts.size >= this.counterpartCapacity) {
        const victim = [...this.counterparts.values()]
          .filter((candidate) => candidate.referencedBy.size === 0)
          .sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.stableId - b.stableId)[0];
        if (victim != null) {
          this.emitLifecycle({ kind: "counterpartEvicted", sourceType: rule.sourceType, counterpartIdentity: victim.id });
          this.removeCounterpart(victim);
        } else {
          this.emitLifecycle({ kind: "counterpartCapacityBypassed", sourceType: rule.sourceType, counterpartIdentity: id });
          this.consumeMatchingTombstone(record);
          if (directlyMatchingSources.length > 1) {
            return this.transitionSourcesToAmbiguous(directlyMatchingSources, outcome, "multipleSources");
          }
          for (const source of directlyMatchingSources) {
            const action = this.recomputeSourceWithTransientCounterpart(source, record, outcome);
            if (action != null) return action;
          }
          return this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
        }
      }
      this.counterparts.set(id, record);
      this.armCounterpartExpiry(record);
    }

    this.consumeMatchingTombstone(record);

    if (affectedSources.length === 0) {
      return this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
    }

    if (directlyMatchingSources.length > 1) {
      const directlyMatchingIds = new Set(directlyMatchingSources.map((source) => source.id));
      const noLongerMatchingSources = affectedSources.filter((source) => !directlyMatchingIds.has(source.id));
      const noLongerMatchingAction = this.recomputeAffectedSources(noLongerMatchingSources, outcome, false);
      const ambiguousAction = this.transitionSourcesToAmbiguous(directlyMatchingSources, outcome, "multipleSources");
      if (noLongerMatchingAction == null) return ambiguousAction;
      if (noLongerMatchingAction.kind === "emitNow" || noLongerMatchingAction.kind === "holdSource") {
        return ambiguousAction;
      }
      return this.decide({
        ...noLongerMatchingAction,
        affectedSources: [
          ...this.affectedSourcesOf(noLongerMatchingAction),
          ...this.affectedSourcesOf(ambiguousAction),
        ],
      });
    }
    return this.recomputeAffectedSources(affectedSources, outcome, false)
      ?? this.decide({ kind: "emitNow", outcome, reason: "counterpart", sourceType: rule.sourceType });
  }

  private recomputeSourceWithTransientCounterpart(
    source: SourceRecord,
    counterpart: CounterpartRecord,
    triggerOutcome: ProcessOutcome,
  ): LegacyCounterpartAction | null {
    const retainedCandidates = this.candidatesFor(source.rule, source.meta, source.key);
    const candidateCount = retainedCandidates.length + 1;
    this.setCandidates(source, retainedCandidates);
    if (candidateCount > 1) {
      for (const candidate of retainedCandidates) this.bindCounterpartExpiryToSource(candidate, source);
      this.clearTimer(source.holdTimer);
      source.holdTimer = null;
      source.status = "ambiguous";
      return this.decide({
        kind: "ambiguousSource",
        outcome: source.outcome,
        sourceIdentity: source.id,
        candidateCount,
        ambiguityReason: "multipleCandidates",
        triggerOutcome,
      });
    }
    if (source.status === "released-unmatched") {
      source.status = "late-reconciled";
      return this.decide({
        kind: "reconcileLateCounterpart",
        outcome: triggerOutcome,
        sourceOutcome: source.outcome,
        sourceIdentity: source.id,
      });
    }
    this.clearTimer(source.holdTimer);
    source.holdTimer = null;
    source.status = "matched-suppressed";
    return this.decide({
      kind: "suppressSource",
      outcome: source.outcome,
      sourceIdentity: source.id,
      counterpartOutcome: counterpart.outcome,
      triggerOutcome,
    });
  }

  private transitionSourcesToAmbiguous(
    sources: readonly SourceRecord[],
    triggerOutcome: ProcessOutcome,
    ambiguityReason: "multipleCandidates" | "multipleSources",
  ): LegacyCounterpartAction {
    for (const source of sources) {
      const candidates = this.candidatesFor(source.rule, source.meta, source.key);
      this.setCandidates(source, candidates);
      for (const candidate of candidates) this.bindCounterpartExpiryToSource(candidate, source);
      this.clearTimer(source.holdTimer);
      source.holdTimer = null;
      source.status = "ambiguous";
    }
    const first = sources[0];
    return this.decide({
      kind: "ambiguousSource",
      outcome: first.outcome,
      sourceIdentity: first.id,
      candidateCount: Math.max(2, this.candidatesFor(first.rule, first.meta, first.key).length),
      ambiguityReason,
      triggerOutcome,
      affectedSources: sources.map((source) => ({
        kind: "ambiguousSource",
        outcome: source.outcome,
        sourceIdentity: source.id,
        candidateCount: Math.max(2, this.candidatesFor(source.rule, source.meta, source.key).length),
        ambiguityReason,
      })),
    });
  }

  private recomputeAffectedSources(
    sources: readonly SourceRecord[],
    triggerOutcome: ProcessOutcome | undefined,
    cancellation: boolean,
  ): LegacyCounterpartAction | null {
    const actions = sources
      .map((source) => this.recomputeSource(source, triggerOutcome, cancellation))
      .filter((action): action is LegacyCounterpartAction => action != null);
    if (actions.length === 0) return null;
    if (actions.length === 1) return actions[0];
    const first = actions[0];
    const affectedSources = actions
      .map((action) => this.affectedSourceOf(action))
      .filter((affected): affected is LegacyCounterpartAffectedSource => affected != null);
    if (first.kind === "emitNow" || first.kind === "holdSource") return first;
    return this.decide({ ...first, affectedSources });
  }

  private affectedSourceOf(action: LegacyCounterpartAction): LegacyCounterpartAffectedSource | null {
    switch (action.kind) {
      case "suppressSource":
        return {
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          counterpartOutcome: action.counterpartOutcome,
        };
      case "releaseSource":
        return {
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          reason: action.reason,
          ...(action.displayLifecycleOnly === true ? { displayLifecycleOnly: true } : {}),
        };
      case "ambiguousSource":
        return {
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          candidateCount: action.candidateCount,
          ...(action.ambiguityReason == null ? {} : { ambiguityReason: action.ambiguityReason }),
        };
      case "reconcileLateCounterpart":
        return {
          kind: action.kind,
          outcome: action.outcome,
          sourceOutcome: action.sourceOutcome,
          sourceIdentity: action.sourceIdentity,
        };
      case "emitNow":
      case "holdSource":
        return null;
    }
  }

  private affectedSourcesOf(action: LegacyCounterpartAction): readonly LegacyCounterpartAffectedSource[] {
    if (action.kind === "emitNow" || action.kind === "holdSource") return [];
    if (action.affectedSources != null) return action.affectedSources;
    const affected = this.affectedSourceOf(action);
    return affected == null ? [] : [affected];
  }

  private candidatesFor(
    rule: LegacyCounterpartRule,
    sourceMeta: TelegramMeta,
    sourceKey: LegacyCounterpartCorrelationKey | null,
  ): CounterpartRecord[] {
    return [...this.counterparts.values()].filter((record) =>
      record.rule === rule
      && correlationMatches(rule, sourceMeta, sourceKey, record.meta, record.key),
    );
  }

  /** 非対象訂正／取消が同 subject の pending 発表を静かに失効させる。 */
  private invalidatePendingPublishedSource(id: string): SourceRecord | null {
    const record = this.sources.get(id);
    if (record == null || record.status !== "pending" || record.meta.infoType.value !== "発表") {
      return null;
    }
    this.sources.delete(id);
    record.generation += 1;
    this.clearTimer(record.holdTimer);
    this.clearTimer(record.expiryTimer);
    record.holdTimer = null;
    record.expiryTimer = null;
    return record;
  }

  private recomputeSource(
    source: SourceRecord,
    triggerOutcome: ProcessOutcome | undefined,
    cancellation: boolean,
  ): LegacyCounterpartAction | null {
    const candidates = this.candidatesFor(source.rule, source.meta, source.key);
    this.setCandidates(source, candidates);
    if (candidates.length === 0) {
      if (source.status === "pending") return null;
      source.status = "released-unmatched";
      return this.decide({
        kind: "releaseSource",
        outcome: source.outcome,
        sourceIdentity: source.id,
        reason: cancellation ? "counterpartCancelled" : "releasedUpdate",
        ...(triggerOutcome == null ? {} : { triggerOutcome }),
      });
    }
    if (candidates.length > 1) {
      for (const candidate of candidates) this.bindCounterpartExpiryToSource(candidate, source);
      this.clearTimer(source.holdTimer);
      source.holdTimer = null;
      source.status = "ambiguous";
      return this.decide({
        kind: "ambiguousSource",
        outcome: source.outcome,
        sourceIdentity: source.id,
        candidateCount: candidates.length,
        ambiguityReason: "multipleCandidates",
        ...(triggerOutcome == null ? {} : { triggerOutcome }),
      });
    }

    const counterpart = candidates[0];
    this.bindCounterpartExpiryToSource(counterpart, source);
    if (source.status === "released-unmatched") {
      source.status = "late-reconciled";
      return this.decide({
        kind: "reconcileLateCounterpart",
        outcome: triggerOutcome ?? counterpart.outcome,
        sourceOutcome: source.outcome,
        sourceIdentity: source.id,
      });
    }
    this.clearTimer(source.holdTimer);
    source.holdTimer = null;
    source.status = "matched-suppressed";
    return this.decide({
      kind: "suppressSource",
      outcome: source.outcome,
      sourceIdentity: source.id,
      counterpartOutcome: counterpart.outcome,
      ...(triggerOutcome == null ? {} : { triggerOutcome }),
    });
  }

  private setCandidates(source: SourceRecord, candidates: readonly CounterpartRecord[]): void {
    const touchedCounterparts = new Set<CounterpartRecord>();
    for (const candidateId of source.candidateIds) {
      const candidate = this.counterparts.get(candidateId);
      if (candidate == null) continue;
      candidate.referencedBy.delete(source.id);
      touchedCounterparts.add(candidate);
    }
    source.candidateIds = new Set(candidates.map((candidate) => candidate.id));
    for (const candidate of candidates) {
      candidate.referencedBy.add(source.id);
      touchedCounterparts.add(candidate);
    }
    for (const counterpart of touchedCounterparts) this.refreshReferencedCounterpartExpiry(counterpart);
  }

  private bindCounterpartExpiryToSource(counterpart: CounterpartRecord, source: SourceRecord): void {
    counterpart.referencedBy.add(source.id);
    this.refreshReferencedCounterpartExpiry(counterpart);
  }

  private refreshReferencedCounterpartExpiry(counterpart: CounterpartRecord): void {
    const referencedExpiries = [...counterpart.referencedBy]
      .map((sourceId) => this.sources.get(sourceId)?.expiryMs)
      .filter((expiryMs): expiryMs is number => expiryMs != null);
    if (referencedExpiries.length === 0) return;
    const expiryMs = Math.max(...referencedExpiries);
    if (counterpart.expiryMs === expiryMs) return;
    this.clearTimer(counterpart.expiryTimer);
    counterpart.generation += 1;
    counterpart.expiryMs = expiryMs;
    this.armCounterpartExpiry(counterpart);
  }

  private armHoldback(record: SourceRecord): void {
    const generation = record.generation;
    const callback = (): void => {
      if (this.disposed) return;
      const current = this.sources.get(record.id);
      if (current !== record || current.generation !== generation || current.status !== "pending") return;
      const nowMs = this.clock.nowMs();
      if (nowMs <= current.holdbackDeadlineMs) {
        current.holdTimer = this.timer.set(current.holdbackDeadlineMs + 1 - nowMs, callback);
        return;
      }
      current.holdTimer = null;
      current.status = "released-unmatched";
      this.onAction?.(this.decide({
        kind: "releaseSource",
        outcome: current.outcome,
        sourceIdentity: current.id,
        reason: "timeout",
      }));
    };
    record.holdTimer = this.timer.set(Math.max(0, record.holdbackDeadlineMs - this.clock.nowMs()), callback);
  }

  private armSourceExpiry(record: SourceRecord): void {
    const generation = record.generation;
    const callback = (): void => {
      if (this.disposed) return;
      const current = this.sources.get(record.id);
      if (current !== record || current.generation !== generation) return;
      const nowMs = this.clock.nowMs();
      if (nowMs <= current.expiryMs) {
        current.expiryTimer = this.timer.set(current.expiryMs + 1 - nowMs, callback);
        return;
      }
      this.expireSource(current, nowMs);
    };
    record.expiryTimer = this.timer.set(Math.max(0, record.expiryMs - this.clock.nowMs()), callback);
  }

  private armCounterpartExpiry(record: CounterpartRecord): void {
    const generation = record.generation;
    const callback = (): void => {
      if (this.disposed) return;
      const current = this.counterparts.get(record.id);
      if (current !== record || current.generation !== generation) return;
      const nowMs = this.clock.nowMs();
      if (nowMs <= current.expiryMs) {
        current.expiryTimer = this.timer.set(current.expiryMs + 1 - nowMs, callback);
        return;
      }
      this.removeCounterpart(current);
    };
    record.expiryTimer = this.timer.set(Math.max(0, record.expiryMs - this.clock.nowMs()), callback);
  }

  private armTombstoneExpiry(record: ExpiredSourceTombstone): void {
    const generation = record.generation;
    const callback = (): void => {
      if (this.disposed) return;
      const current = this.tombstones.get(record.id);
      if (current !== record || current.generation !== generation) return;
      const nowMs = this.clock.nowMs();
      if (nowMs <= current.expiryMs) {
        current.expiryTimer = this.timer.set(current.expiryMs + 1 - nowMs, callback);
        return;
      }
      this.removeTombstone(current.id);
    };
    record.expiryTimer = this.timer.set(Math.max(0, record.expiryMs - this.clock.nowMs()), callback);
  }

  private prune(nowMs: number): void {
    for (const source of [...this.sources.values()]) {
      if (source.status === "pending" && nowMs > source.holdbackDeadlineMs) {
        this.clearTimer(source.holdTimer);
        source.holdTimer = null;
        source.status = "released-unmatched";
        this.onAction?.(this.decide({ kind: "releaseSource", outcome: source.outcome, sourceIdentity: source.id, reason: "timeout" }));
      }
      if (nowMs > source.expiryMs) this.expireSource(source, nowMs);
    }
    for (const counterpart of [...this.counterparts.values()]) {
      if (nowMs > counterpart.expiryMs) this.removeCounterpart(counterpart);
    }
    for (const tombstone of [...this.tombstones.values()]) {
      if (nowMs > tombstone.expiryMs) this.removeTombstone(tombstone.id);
    }
  }

  private expireSource(record: SourceRecord, nowMs: number): void {
    if (this.sources.get(record.id) !== record) return;
    this.sources.delete(record.id);
    this.clearTimer(record.holdTimer);
    this.clearTimer(record.expiryTimer);
    this.setCandidates(record, []);
    if (record.status !== "released-unmatched" && record.status !== "ambiguous") return;
    this.emitLifecycle({ kind: "legacyCorrelationExpired", sourceType: record.rule.sourceType, sourceIdentity: record.id });
    const tombstone: ExpiredSourceTombstone = {
      id: record.id,
      stableId: this.nextStableId++,
      generation: 1,
      sourceType: record.rule.sourceType,
      rule: record.rule,
      eventId: eventIdOf(record.meta),
      key: record.key,
      revision: record.revision,
      infoType: record.meta.infoType,
      reportDateTimeMs: record.revision.reportDateTimeMs,
      expiredAtMs: record.expiryMs,
      expiryMs: record.expiryMs + LEGACY_CORRELATION_RETENTION_MS,
      expiryTimer: null,
    };
    if (this.tombstones.size >= this.tombstoneCapacity) {
      const victim = [...this.tombstones.values()]
        .sort((a, b) => a.expiredAtMs - b.expiredAtMs || a.stableId - b.stableId)[0];
      if (victim != null) this.removeTombstone(victim.id);
    }
    this.tombstones.set(tombstone.id, tombstone);
    this.armTombstoneExpiry(tombstone);
    void nowMs;
  }

  private consumeMatchingTombstone(counterpart: CounterpartRecord): boolean {
    for (const tombstone of this.tombstones.values()) {
      if (tombstone.rule !== counterpart.rule) continue;
      const sourceMeta = {
        ...counterpart.meta,
        eventId: tombstone.eventId == null
          ? { raw: null, value: null, valid: false }
          : { raw: tombstone.eventId, value: tombstone.eventId, valid: true },
        reportDateTime: {
          raw: new Date(tombstone.reportDateTimeMs).toISOString(),
          epochMs: tombstone.reportDateTimeMs,
          valid: true,
        },
        serial: {
          raw: tombstone.revision.serial == null ? null : String(tombstone.revision.serial),
          numeric: tombstone.revision.serial,
          valid: tombstone.revision.serial != null,
        },
        infoType: tombstone.infoType,
      };
      if (!correlationMatches(tombstone.rule, sourceMeta, tombstone.key, counterpart.meta, counterpart.key)) continue;
      this.removeTombstone(tombstone.id);
      this.emitLifecycle({
        kind: "legacyLateCounterpartExpired",
        sourceType: tombstone.sourceType,
        sourceIdentity: tombstone.id,
      });
      return true;
    }
    return false;
  }

  private removeCounterpart(
    record: CounterpartRecord,
    triggerOutcome?: ProcessOutcome,
    cancellation = false,
  ): LegacyCounterpartAction | null {
    if (this.counterparts.get(record.id) !== record) return null;
    const affectedSourceIds = [...record.referencedBy];
    const nowMs = this.clock.nowMs();
    for (const sourceId of affectedSourceIds) {
      const source = this.sources.get(sourceId);
      if (source != null && nowMs > source.expiryMs) this.expireSource(source, nowMs);
    }
    const affectedSources = affectedSourceIds
      .map((sourceId) => this.sources.get(sourceId))
      .filter((source): source is SourceRecord => source != null);
    this.counterparts.delete(record.id);
    this.clearTimer(record.expiryTimer);
    for (const sourceId of record.referencedBy) this.sources.get(sourceId)?.candidateIds.delete(record.id);
    record.referencedBy.clear();
    const action = this.recomputeAffectedSources(affectedSources, triggerOutcome, cancellation);
    if (triggerOutcome == null && action != null) this.onAction?.(action);
    return action;
  }

  private removeTombstone(id: string): void {
    const tombstone = this.tombstones.get(id);
    if (tombstone == null) return;
    this.tombstones.delete(id);
    this.clearTimer(tombstone.expiryTimer);
  }

  private clearTimer(handle: unknown | null): void {
    if (handle != null) this.timer.clear(handle);
  }
}
