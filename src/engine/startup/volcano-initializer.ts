import { createHash } from "node:crypto";
import { listTelegrams, type TelegramListQuery } from "../../dmdata/rest-client";
import { parseVolcanoTelegram } from "../../dmdata/volcano-parser";
import {
  VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE,
  VolcanoStateHolder,
  type VolcanoRepairStateV1,
  type VolcanoRepairTarget,
} from "../messages/volcano-state";
import { strictRestReceivedTimeMs, toWsDataMessage } from "./telegram-adapter";
import { FUTURE_REPORT_DATETIME_SKEW_MS } from "../../dmdata/telegram-meta";
import * as log from "../../logger";
import {
  VOLCANO_ALERT_TOMBSTONE_RETENTION_MS,
  volcanoAshfallSubjectKey,
  volcanoRevisionFamilyPolicy,
} from "../messages/revision-family-registry";
import {
  semanticPayloadFingerprint,
  telegramRevisionSemanticKey,
  TelegramRevisionGate,
  type TelegramRevisionGateInput,
} from "../messages/telegram-revision-gate";
import type {
  ParsedVolcanoAlertInfo,
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoInfo,
  TelegramListItem,
  TelegramListResponse,
  WsDataMessage,
} from "../../types";
import type {
  WsSubscriptionAcknowledgement,
  WsTransportIdentity,
} from "../../dmdata/ws-client";
import {
  normalizeVolcanoAshfallEventId,
  projectVolcanoAshfall,
} from "../messages/volcano-ashfall-projector";
import {
  VolcanoTransactionCoordinator,
  type VolcanoScratchRuntime,
} from "../messages/volcano-transaction-coordinator";
import { volcanoPayloadFingerprints } from "../messages/volcano-route-handler";

/** 起動時復元で取得する VFVO50 履歴窓 (dmdata REST /v2/telegram の limit 上限) */
const VOLCANO_RESTORE_WINDOW = 100;

export const VOLCANO_REPAIR_JOURNAL_MAX_ITEMS = 512;
export const VOLCANO_REPAIR_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
export const VOLCANO_REPAIR_PAGE_LIMIT = 100;
export const VOLCANO_REPAIR_MAX_PAGES = 128;
export const VOLCANO_REPAIR_MAX_ITEMS_PER_TYPE = 12_800;
export const VOLCANO_REPAIR_MAX_HEAD_SAMPLES = 4;
export const VOLCANO_ASHFALL_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type VolcanoRepairHeadType = "VFVO50" | "VFVO54" | "VFVO55";

export interface NormalizedVolcanoInput {
  headType: VolcanoRepairHeadType;
  sourceEventId: string;
  bodyFingerprint: string;
  parsed: ParsedVolcanoAlertInfo | ParsedVolcanoAshfallInfo;
}

export interface VolcanoRepairJournalItem {
  itemId: string;
  receivedTimeMs: number;
  sequence: number;
  encodedByteLength: number;
  normalizedInput: NormalizedVolcanoInput;
}

export type VolcanoRepairProofState =
  | { kind: "active" }
  | { kind: "failed"; reason: string };

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCodeUnit(left, right))
    .map(([key, child]) => [key, canonicalize(child)]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validTransportId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}

function normalizeSourceTransportId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC");
  if (/\p{Cc}/u.test(normalized)) return null;
  const trimmed = normalized.trim();
  return trimmed === "" || trimmed.length > 256 ? null : trimmed;
}

function isTrulyBlankVolcanoCode(value: string): boolean {
  const normalized = value.normalize("NFC");
  return !/\p{Cc}/u.test(normalized) && normalized.trim() === "";
}

function journalRecordBytes(
  item: Omit<VolcanoRepairJournalItem, "encodedByteLength">,
): { bytes: number; record: VolcanoRepairJournalItem } {
  let encodedByteLength = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const record = { ...item, encodedByteLength };
    const next = Buffer.byteLength(canonicalJson(record), "utf8");
    if (next === encodedByteLength) return { bytes: next, record };
    encodedByteLength = next;
  }
  const record = { ...item, encodedByteLength };
  return { bytes: Buffer.byteLength(canonicalJson(record), "utf8"), record };
}

function repairTargetForHeadType(type: string): VolcanoRepairTarget | null {
  if (type === "VFVO50") return "vfvo50";
  if (type === "VFVO54" || type === "VFVO55") return "ashfall";
  return null;
}

function isNormalizedRepairParsed(
  parsed: ParsedVolcanoInfo | null,
  headType: VolcanoRepairHeadType,
): parsed is ParsedVolcanoAlertInfo | ParsedVolcanoAshfallInfo {
  return headType === "VFVO50"
    ? parsed?.kind === "alert" && parsed.type === "VFVO50"
    : parsed?.kind === "ashfall" && parsed.type === headType;
}

/**
 * The journal observes normal ingress; it never delays or re-emits it.  A
 * proof failure is target-local and only prevents the later REST commit.
 */
export class VolcanoRepairJournal {
  private sequence = 0;
  private readonly items: Record<VolcanoRepairTarget, VolcanoRepairJournalItem[]> = {
    vfvo50: [],
    ashfall: [],
  };
  private readonly bytes: Record<VolcanoRepairTarget, number> = { vfvo50: 0, ashfall: 0 };
  private readonly proof: Record<VolcanoRepairTarget, VolcanoRepairProofState> = {
    vfvo50: { kind: "active" },
    ashfall: { kind: "active" },
  };
  private readonly firstById: Record<VolcanoRepairTarget, Map<string, VolcanoRepairJournalItem>> = {
    vfvo50: new Map(),
    ashfall: new Map(),
  };

  constructor(
    private readonly acknowledgement: WsSubscriptionAcknowledgement,
    private readonly targets: readonly VolcanoRepairTarget[],
  ) {
    if (!Number.isSafeInteger(acknowledgement.subscriptionGeneration)
      || acknowledgement.subscriptionGeneration < 1
      || !Number.isSafeInteger(acknowledgement.socketId)
      || acknowledgement.socketId < 0
      || !validTransportId(acknowledgement.transportId)
      || !Number.isSafeInteger(acknowledgement.acknowledgedAtMs)
      || Math.abs(acknowledgement.acknowledgedAtMs) > 8_640_000_000_000_000
      || !Array.isArray(acknowledgement.classifications)
      || !acknowledgement.classifications.includes("telegram.volcano")
      || acknowledgement.classifications.some((value) => !validTransportId(value))
      || targets.length === 0
      || new Set(targets).size !== targets.length
      || targets.some((target) => target !== "vfvo50" && target !== "ashfall")) {
      throw new Error("invalid volcano repair subscription acknowledgement");
    }
  }

  targetTypes(): VolcanoRepairHeadType[] {
    return this.targets.flatMap((target) => target === "vfvo50"
      ? ["VFVO50" as const]
      : ["VFVO54" as const, "VFVO55" as const]);
  }

  state(target: VolcanoRepairTarget): VolcanoRepairProofState {
    return structuredClone(this.proof[target]);
  }

  fail(target: VolcanoRepairTarget, reason: string): void {
    if (!this.targets.includes(target) || this.proof[target].kind === "failed") return;
    this.proof[target] = { kind: "failed", reason: reason.slice(0, 160) };
  }

  failAll(reason: string): void {
    for (const target of this.targets) this.fail(target, reason);
  }

  validateAcknowledgement(current: WsSubscriptionAcknowledgement | null): boolean {
    const valid = current != null
      && current.subscriptionGeneration === this.acknowledgement.subscriptionGeneration
      && current.transportId === this.acknowledgement.transportId
      && current.socketId === this.acknowledgement.socketId;
    if (!valid) this.failAll("subscriptionGenerationChanged");
    return valid;
  }

  record(msg: WsDataMessage, transport?: WsTransportIdentity):
    | { kind: "ignored" | "recorded" | "duplicate" }
    | { kind: "proofFailed"; target: VolcanoRepairTarget; reason: string } {
    const target = repairTargetForHeadType(msg.head.type);
    if (target == null || !this.targets.includes(target)) return { kind: "ignored" };
    if (this.proof[target].kind === "failed") {
      return { kind: "proofFailed", target, reason: this.proof[target].reason };
    }
    if (transport == null
      || transport.subscriptionGeneration !== this.acknowledgement.subscriptionGeneration
      || transport.transportId !== this.acknowledgement.transportId
      || transport.socketId !== this.acknowledgement.socketId
      || !Number.isSafeInteger(transport.receivedAtMs)
      || Math.abs(transport.receivedAtMs) > 8_640_000_000_000_000
      || msg.meta?.receivedAtMs !== transport.receivedAtMs) {
      this.fail(target, "subscriptionGenerationChanged");
      return { kind: "proofFailed", target, reason: "subscriptionGenerationChanged" };
    }
    const headType = msg.head.type as VolcanoRepairHeadType;
    const receivedTimeMs = strictRestReceivedTimeMs(msg.head.time);
    const itemId = normalizeSourceTransportId(msg.id);
    if (itemId == null || receivedTimeMs == null || msg.body == null) {
      this.fail(target, "targetTransportInvalid");
      return { kind: "proofFailed", target, reason: "targetTransportInvalid" };
    }
    const bodyFingerprint = sha256(msg.body);
    const existing = this.firstById[target].get(itemId);
    if (existing != null) {
      if (existing.receivedTimeMs !== receivedTimeMs
        || existing.normalizedInput.headType !== headType
        || existing.normalizedInput.bodyFingerprint !== bodyFingerprint) {
        this.fail(target, "transportInconsistency");
        return { kind: "proofFailed", target, reason: "transportInconsistency" };
      }
      return { kind: "duplicate" };
    }
    const parsed = parseVolcanoTelegram(msg);
    if (!isNormalizedRepairParsed(parsed, headType)) {
      this.fail(target, "targetParseFailure");
      return { kind: "proofFailed", target, reason: "targetParseFailure" };
    }
    const normalizedInput: NormalizedVolcanoInput = {
      headType,
      sourceEventId: itemId,
      bodyFingerprint,
      parsed: structuredClone(parsed),
    };
    const candidate = journalRecordBytes({
      itemId,
      receivedTimeMs,
      sequence: this.sequence + 1,
      normalizedInput,
    }).record;
    const prospectiveCount = this.items[target].length + 1;
    const prospectiveBytes = this.bytes[target] + candidate.encodedByteLength;
    if (prospectiveCount > VOLCANO_REPAIR_JOURNAL_MAX_ITEMS
      || prospectiveBytes > VOLCANO_REPAIR_JOURNAL_MAX_BYTES) {
      this.fail(target, prospectiveCount > VOLCANO_REPAIR_JOURNAL_MAX_ITEMS
        ? "journalItemLimitExceeded"
        : "journalByteLimitExceeded");
      return {
        kind: "proofFailed",
        target,
        reason: prospectiveCount > VOLCANO_REPAIR_JOURNAL_MAX_ITEMS
          ? "journalItemLimitExceeded"
          : "journalByteLimitExceeded",
      };
    }
    this.sequence += 1;
    this.items[target].push(candidate);
    this.firstById[target].set(candidate.itemId, candidate);
    this.bytes[target] = prospectiveBytes;
    return { kind: "recorded" };
  }

  snapshot(target: VolcanoRepairTarget): VolcanoRepairJournalItem[] {
    return structuredClone(this.items[target]);
  }
}

interface PreparedRepairItem {
  itemId: string;
  receivedTimeMs: number;
  headType: VolcanoRepairHeadType;
  bodyFingerprint: string;
  normalizedInput: NormalizedVolcanoInput;
}

interface HeadSample {
  fingerprint: string;
  items: PreparedRepairItem[];
}

export interface VolcanoHistoricalPaginationUnion {
  headType: VolcanoRepairHeadType;
  coverageStartMs: number;
  pages: number;
  items: PreparedRepairItem[];
}

export interface VolcanoTypeRepairProof {
  headType: VolcanoRepairHeadType;
  historical: VolcanoHistoricalPaginationUnion;
  headSamples: number;
}

type TelegramPageLoader = (
  apiKey: string,
  query: TelegramListQuery,
) => Promise<TelegramListResponse>;

function checkedCoverageStart(startupNowMs: number, retentionMs: number): number | null {
  if (!Number.isSafeInteger(startupNowMs)
    || !Number.isSafeInteger(retentionMs)
    || retentionMs < 0) return null;
  const result = startupNowMs - retentionMs;
  return Number.isSafeInteger(result) && Math.abs(result) <= 8_640_000_000_000_000
    ? result
    : null;
}

function prepareRepairItem(
  item: TelegramListItem,
  expectedType: VolcanoRepairHeadType,
): PreparedRepairItem | null {
  const itemId = normalizeSourceTransportId(item.id);
  if (itemId == null
    || item.head.type !== expectedType
    || item.body == null) return null;
  const receivedTimeMs = strictRestReceivedTimeMs(item.head.time);
  if (receivedTimeMs == null) return null;
  let parsed: ParsedVolcanoInfo | null;
  try {
    parsed = parseVolcanoTelegram(toWsDataMessage(item, item.body, receivedTimeMs));
  } catch {
    return null;
  }
  if (!isNormalizedRepairParsed(parsed, expectedType)
    || !parsed.meta.reportDateTime.valid
    || !parsed.meta.infoType.valid
    || !parsed.meta.type.valid) return null;
  const policy = volcanoRevisionFamilyPolicy(expectedType);
  const subject = policy?.extractStateSubjectKey(parsed.meta, parsed);
  const ashfallCancellationWithoutCode = (expectedType === "VFVO54" || expectedType === "VFVO55")
    && parsed.kind === "ashfall"
    && parsed.meta.infoType.value === "取消"
    && isTrulyBlankVolcanoCode(parsed.volcanoCode);
  if (policy == null
    || (typeof subject !== "string" && !ashfallCancellationWithoutCode)
    || (expectedType === "VFVO54" || expectedType === "VFVO55")
      && (parsed.meta.eventId.value == null
        || !ashfallCancellationWithoutCode && volcanoAshfallSubjectKey(parsed.volcanoCode) == null)) {
    return null;
  }
  const bodyFingerprint = sha256(item.body);
  return {
    itemId,
    receivedTimeMs,
    headType: expectedType,
    bodyFingerprint,
    normalizedInput: {
      headType: expectedType,
      sourceEventId: itemId,
      bodyFingerprint,
      parsed: structuredClone(parsed),
    },
  };
}

function responseItems(response: TelegramListResponse): TelegramListItem[] | null {
  return response != null && response.status === "ok" && Array.isArray(response.items)
    ? response.items
    : null;
}

function assertNewestFirst(
  items: readonly PreparedRepairItem[],
  previousOldestMs: number | null,
): number | null {
  let previous = previousOldestMs;
  for (const item of items) {
    if (previous != null && item.receivedTimeMs > previous) return null;
    previous = item.receivedTimeMs;
  }
  return previous;
}

function crossSetConsistent(
  left: Pick<PreparedRepairItem, "itemId" | "receivedTimeMs" | "headType" | "bodyFingerprint">,
  right: Pick<PreparedRepairItem, "itemId" | "receivedTimeMs" | "headType" | "bodyFingerprint">,
): boolean {
  return left.itemId !== right.itemId || (
    left.receivedTimeMs === right.receivedTimeMs
    && left.headType === right.headType
    && left.bodyFingerprint === right.bodyFingerprint
  );
}

async function fetchHeadSample(
  apiKey: string,
  headType: VolcanoRepairHeadType,
  coverageStartMs: number,
  loadPage: TelegramPageLoader,
): Promise<HeadSample> {
  const response = await loadPage(apiKey, {
    type: headType,
    limit: VOLCANO_REPAIR_PAGE_LIMIT,
    formatMode: "raw",
  });
  const rawItems = responseItems(response);
  if (rawItems == null) throw new Error("headResponseMissingBody");
  if (rawItems.length > VOLCANO_REPAIR_PAGE_LIMIT) throw new Error("headPageLimitExceeded");
  const items = rawItems.map((item) => prepareRepairItem(item, headType));
  if (items.some((item) => item == null)) throw new Error("headItemInvalid");
  const prepared = items as PreparedRepairItem[];
  if (assertNewestFirst(prepared, null) == null && prepared.length > 1) {
    throw new Error("headNewestFirstViolation");
  }
  const ids = new Set<string>();
  for (const item of prepared) {
    if (ids.has(item.itemId)) throw new Error("headDuplicateItemId");
    ids.add(item.itemId);
  }
  const relevant = prepared.filter((item) => item.receivedTimeMs >= coverageStartMs);
  const canonical = [...relevant]
    .sort((left, right) => compareCodeUnit(left.itemId, right.itemId))
    .map((item) => [item.itemId, item.receivedTimeMs]);
  return { fingerprint: sha256(canonicalJson(canonical)), items: relevant };
}

export async function fetchVolcanoHistoricalPaginationUnion(options: {
  apiKey: string;
  headType: VolcanoRepairHeadType;
  startupNowMs: number;
  retentionMs: number;
  loadPage?: TelegramPageLoader;
  validateTransport?: () => boolean;
}): Promise<VolcanoHistoricalPaginationUnion> {
  const coverageStartMs = checkedCoverageStart(options.startupNowMs, options.retentionMs);
  if (coverageStartMs == null) throw new Error("coverageStartInvalid");
  const loadPage = options.loadPage ?? ((apiKey, query) => listTelegrams(apiKey, query));
  const seenTokens = new Set<string>();
  const seenIds = new Set<string>();
  const relevant: PreparedRepairItem[] = [];
  let cursorToken: string | undefined;
  let previousOldestMs: number | null = null;
  for (let page = 1; page <= VOLCANO_REPAIR_MAX_PAGES; page += 1) {
    if (options.validateTransport?.() === false) throw new Error("subscriptionGenerationChanged");
    const response = await loadPage(options.apiKey, {
      type: options.headType,
      limit: VOLCANO_REPAIR_PAGE_LIMIT,
      formatMode: "raw",
      ...(cursorToken == null ? {} : { cursorToken }),
    });
    if (options.validateTransport?.() === false) throw new Error("subscriptionGenerationChanged");
    const rawItems = responseItems(response);
    if (rawItems == null) throw new Error("historicalResponseMissingBody");
    if (rawItems.length > VOLCANO_REPAIR_PAGE_LIMIT) {
      throw new Error("historicalPageSizeExceeded");
    }
    const prepared = rawItems.map((item) => prepareRepairItem(item, options.headType));
    if (prepared.some((item) => item == null)) throw new Error("historicalItemInvalid");
    const pageItems = prepared as PreparedRepairItem[];
    const nextOldest = assertNewestFirst(pageItems, previousOldestMs);
    if (nextOldest == null && (pageItems.length > 0 || previousOldestMs != null)) {
      throw new Error("historicalNewestFirstViolation");
    }
    if (pageItems.length > 0) previousOldestMs = nextOldest;
    for (const item of pageItems) {
      if (seenIds.has(item.itemId)) throw new Error("historicalDuplicateItemId");
      seenIds.add(item.itemId);
      if (item.receivedTimeMs >= coverageStartMs) {
        relevant.push(item);
        if (relevant.length > VOLCANO_REPAIR_MAX_ITEMS_PER_TYPE) {
          throw new Error("historicalItemLimitExceeded");
        }
      }
    }
    const olderSentinel = pageItems.some((item) => item.receivedTimeMs < coverageStartMs);
    const rawNextToken = (response as { nextToken?: unknown }).nextToken;
    if (rawNextToken != null && typeof rawNextToken !== "string") {
      throw new Error("historicalNextTokenInvalid");
    }
    const nextToken = typeof rawNextToken === "string" ? rawNextToken : undefined;
    if (olderSentinel || nextToken == null) {
      return {
        headType: options.headType,
        coverageStartMs,
        pages: page,
        items: relevant,
      };
    }
    if (nextToken.trim() === "" || seenTokens.has(nextToken)) {
      throw new Error("historicalNextTokenLoop");
    }
    if (page === VOLCANO_REPAIR_MAX_PAGES) throw new Error("historicalPageLimitExceeded");
    seenTokens.add(nextToken);
    cursorToken = nextToken;
  }
  throw new Error("historicalPageLimitExceeded");
}

export async function proveVolcanoTypeCoverage(options: {
  apiKey: string;
  headType: VolcanoRepairHeadType;
  startupNowMs: number;
  retentionMs: number;
  journal: VolcanoRepairJournal;
  getAcknowledgement: () => WsSubscriptionAcknowledgement | null;
  loadPage?: TelegramPageLoader;
}): Promise<VolcanoTypeRepairProof> {
  const loadPage = options.loadPage ?? ((apiKey, query) => listTelegrams(apiKey, query));
  const coverageStartMs = checkedCoverageStart(options.startupNowMs, options.retentionMs);
  if (coverageStartMs == null) throw new Error("coverageStartInvalid");
  const validateTransport = (): boolean =>
    options.journal.validateAcknowledgement(options.getAcknowledgement());
  if (!validateTransport()) throw new Error("subscriptionGenerationChanged");
  const first = await fetchHeadSample(
    options.apiKey,
    options.headType,
    coverageStartMs,
    loadPage,
  );
  if (!validateTransport()) throw new Error("subscriptionGenerationChanged");
  const historical = await fetchVolcanoHistoricalPaginationUnion({
    apiKey: options.apiKey,
    headType: options.headType,
    startupNowMs: options.startupNowMs,
    retentionMs: options.retentionMs,
    loadPage,
    validateTransport,
  });
  const journalTarget = repairTargetForHeadType(options.headType)!;
  let journalItems = options.journal.snapshot(journalTarget)
    .filter((item) => item.normalizedInput.headType === options.headType);
  let journalById = new Map(journalItems.map((item) => [item.itemId, item]));
  const firstIds = new Set(first.items.map((item) => item.itemId));
  const consistency = new Map<string, PreparedRepairItem>();
  const addConsistency = (item: PreparedRepairItem): void => {
    const previous = consistency.get(item.itemId);
    if (previous != null && !crossSetConsistent(previous, item)) {
      throw new Error("transportInconsistency");
    }
    consistency.set(item.itemId, item);
  };
  for (const item of [...first.items, ...historical.items]) addConsistency(item);
  for (const item of journalItems) {
    addConsistency({
      itemId: item.itemId,
      receivedTimeMs: item.receivedTimeMs,
      headType: item.normalizedInput.headType,
      bodyFingerprint: item.normalizedInput.bodyFingerprint,
      normalizedInput: item.normalizedInput,
    });
  }
  const historicalIds = new Set(historical.items.map((item) => item.itemId));
  for (const item of first.items) {
    if (!historicalIds.has(item.itemId) && !journalById.has(item.itemId)) {
      throw new Error("lowerCoverageHeadGap");
    }
  }

  let previous = first;
  for (let ordinal = 2; ordinal <= VOLCANO_REPAIR_MAX_HEAD_SAMPLES; ordinal += 1) {
    if (!validateTransport()) throw new Error("subscriptionGenerationChanged");
    const sample = await fetchHeadSample(
      options.apiKey,
      options.headType,
      coverageStartMs,
      loadPage,
    );
    if (!validateTransport()) throw new Error("subscriptionGenerationChanged");
    // WS ingress continues while every REST request awaits. Refresh the proof
    // set after the await so a newly observed head item can be justified by
    // the journal entry that arrived during that same request.
    journalItems = options.journal.snapshot(journalTarget)
      .filter((item) => item.normalizedInput.headType === options.headType);
    journalById = new Map(journalItems.map((item) => [item.itemId, item]));
    for (const item of journalItems) addConsistency(preparedJournalItem(item));
    for (const item of sample.items) {
      addConsistency(item);
      if (!firstIds.has(item.itemId) && !journalById.has(item.itemId)) {
        throw new Error("upperCoverageJournalGap");
      }
    }
    if (sample.fingerprint === previous.fingerprint) {
      const proof = options.journal.state(journalTarget);
      if (proof.kind === "failed") throw new Error(proof.reason);
      return { headType: options.headType, historical, headSamples: ordinal };
    }
    previous = sample;
  }
  throw new Error("headStabilityLimitExceeded");
}

function repairReplayTimesValid(
  input: NormalizedVolcanoInput,
  expiryNowMs: number,
): boolean {
  const acceptedAtMs = input.parsed.meta.receivedAtMs;
  const reportTimeMs = input.parsed.meta.reportDateTime.epochMs;
  return Number.isSafeInteger(expiryNowMs)
    && Math.abs(expiryNowMs) <= 8_640_000_000_000_000
    && Number.isSafeInteger(acceptedAtMs)
    && Math.abs(acceptedAtMs) <= 8_640_000_000_000_000
    && reportTimeMs != null
    && Number.isSafeInteger(reportTimeMs)
    && acceptedAtMs <= expiryNowMs + FUTURE_REPORT_DATETIME_SKEW_MS
    && reportTimeMs <= acceptedAtMs + FUTURE_REPORT_DATETIME_SKEW_MS;
}

function alertGateInput(info: ParsedVolcanoAlertInfo): TelegramRevisionGateInput | null {
  const policy = volcanoRevisionFamilyPolicy("VFVO50");
  const subject = policy?.extractStateSubjectKey(info.meta, info);
  if (policy == null || typeof subject !== "string") return null;
  const { meta: _meta, isTest: _isTest, ...payload } = info;
  const targets = info.meta.infoType.value === "取消"
    ? policy.extractCancellationTarget(info.meta, info)
    : null;
  return {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
    stateSubjectKey: subject,
    meta: info.meta,
    comparator: policy.comparator,
    cancellationPolicy: policy.cancellationPolicy,
    terminal: policy.terminalPredicate(info.meta, info),
    deactivation: policy.deactivationPredicate(info.meta, info),
    cancellationTargetMatches: targets == null
      ? info.meta.infoType.value !== "取消"
      : targets.includes(subject),
    durable: policy.durable,
    tombstoneRetentionMs: policy.tombstoneRetentionMs,
    maxSubjects: policy.maxSubjects,
    familyCapacityMode: policy.familyCapacityMode,
    allowMissingSerial: policy.allowMissingSerial,
    payloadFingerprint: semanticPayloadFingerprint(payload),
    legacyRevisionKey: subject,
    legacyRevisionKeyProvenance: "codeFallback",
    volcanoProvenance: { kind: "alert", sourceFamily: "VFVO50" },
  };
}

/**
 * VFVO50 repair is deliberately narrower than normal ingress.  Historical
 * coverage may restore a missing slice only when the current safe gate already
 * proves the exact VFVO50 subject, revision, and semantic payload.  It must not
 * advance the gate clock, TTL, semantic history, or acceptedAt.
 */
function reconstructVfvo50MissingSlice(
  scratch: VolcanoScratchRuntime,
  input: NormalizedVolcanoInput,
): "notMatched" | "reconstructed" | "failed" {
  if (input.headType !== "VFVO50" || input.parsed.kind !== "alert") return "failed";
  const info = input.parsed;
  const gateInput = alertGateInput(info);
  if (gateInput == null || gateInput.stateSubjectKey == null) return "failed";
  const code = gateInput.stateSubjectKey.slice("volcano:alert:".length);
  if (scratch.holder.composite(code)?.alert != null) return "notMatched";
  const currentGate = scratch.gate.exportDurableEntries().find((entry) =>
    entry.domain === "volcano"
    && entry.revisionFamily === "volcanoAlert"
    && entry.stateSubjectKey === gateInput.stateSubjectKey);
  if (currentGate?.cancelled !== false
    || currentGate.volcanoProvenance?.kind !== "alert"
    || currentGate.volcanoProvenance.sourceFamily !== "VFVO50"
    || !scratch.gate.matchesCurrentAcceptedPayload(gateInput)) return "notMatched";
  return scratch.holder.applyAcceptedAlert(info, {
    sourceEventId: input.sourceEventId,
    revision: {
      reportTimeMs: info.meta.reportDateTime.epochMs!,
      serial: info.meta.serial.valid ? info.meta.serial.raw : null,
    },
    appliedSemanticKey: telegramRevisionSemanticKey(gateInput),
  }) ? "reconstructed" : "failed";
}

/**
 * A terminal REST replay may leave no composite at all.  When another slice
 * keeps the composite alive, however, the accepted transport ID is part of
 * the flat cumulative identity set.  Treat failure to append it (including a
 * saturated 4,096-entry set) as a transaction failure so the gate tombstone
 * cannot commit on its own.
 */
function clearRepairVolcanoSlice(
  holder: VolcanoStateHolder,
  slice: "alert" | "ashfall",
  volcanoCode: string,
  sourceEventId: string,
  volcanoName: string,
): boolean {
  const canonicalSourceId = normalizeSourceTransportId(sourceEventId);
  if (canonicalSourceId == null) return false;
  if (slice === "alert") {
    holder.clearAlert(volcanoCode, sourceEventId, volcanoName);
  } else {
    holder.clearAshfall(volcanoCode, sourceEventId, volcanoName);
  }
  let remaining = holder.composite(volcanoCode);
  if (remaining == null) return true;
  if (remaining[slice] == null
    && remaining.sourceEventIds.includes(canonicalSourceId)) return true;

  const hasOtherSlice = slice === "alert"
    ? remaining.eruption != null || remaining.ashfall != null
    : remaining.alert != null || remaining.eruption != null;
  if (hasOtherSlice || remaining[slice] == null) return false;
  if (slice === "alert") holder.clearAlert(volcanoCode);
  else holder.clearAshfall(volcanoCode);
  remaining = holder.composite(volcanoCode);
  return remaining == null;
}

function applyVfvo50RepairInput(
  scratch: VolcanoScratchRuntime,
  input: NormalizedVolcanoInput,
): boolean {
  if (input.headType !== "VFVO50" || input.parsed.kind !== "alert") return false;
  const info = input.parsed;
  const gateInput = alertGateInput(info);
  if (gateInput == null || gateInput.stateSubjectKey == null) return false;
  const decision = scratch.gate.decide(gateInput);
  if (!decision.accepted) {
    return decision.kind === "duplicate"
      || decision.kind === "semanticDuplicate"
      || decision.kind === "stale";
  }
  const code = gateInput.stateSubjectKey.slice("volcano:alert:".length);
  if (decision.kind === "clearCurrent") {
    return clearRepairVolcanoSlice(
      scratch.holder,
      "alert",
      code,
      input.sourceEventId,
      info.volcanoName,
    );
  }
  return scratch.holder.applyAcceptedAlert(info, {
    sourceEventId: input.sourceEventId,
    revision: {
      reportTimeMs: info.meta.reportDateTime.epochMs!,
      serial: info.meta.serial.valid ? info.meta.serial.raw : null,
    },
    appliedSemanticKey: telegramRevisionSemanticKey(gateInput),
  });
}

function applyAshfallRepairInput(
  scratch: VolcanoScratchRuntime,
  input: NormalizedVolcanoInput,
  classificationNowMs: number,
): boolean {
  if ((input.headType !== "VFVO54" && input.headType !== "VFVO55")
    || input.parsed.kind !== "ashfall") return false;
  let info = input.parsed;
  const policy = volcanoRevisionFamilyPolicy(input.headType);
  if (policy == null) return false;
  let subject = policy.extractStateSubjectKey(info.meta, info);
  if (typeof subject !== "string" && info.meta.infoType.value === "取消"
    && isTrulyBlankVolcanoCode(info.volcanoCode)) {
    const eventId = normalizeVolcanoAshfallEventId(info.meta.eventId.value);
    const matches = eventId == null ? [] : scratch.gate.cloneSnapshot().states
      .filter((entry) => entry.key.startsWith("volcano:volcanoAshfall:")
        && entry.volcanoProvenance?.kind === "ashfall"
        && entry.volcanoProvenance.actualEventId === eventId)
      .map((entry) => entry.comparison.stateSubjectKey)
      .filter((candidate): candidate is string =>
        candidate != null && candidate.startsWith("volcano:ashfall:"));
    const unique = [...new Set(matches)];
    if (unique.length !== 1) return false;
    subject = unique[0]!;
    info = {
      ...info,
      volcanoCode: subject.slice("volcano:ashfall:".length),
    };
  }
  if (typeof subject !== "string") return false;
  const actualEventId = normalizeVolcanoAshfallEventId(info.meta.eventId.value);
  if (actualEventId == null) return false;
  const payloadFingerprints = volcanoPayloadFingerprints(info);
  const appliedSemanticKey = telegramRevisionSemanticKey({
    meta: info.meta,
    payloadFingerprint: payloadFingerprints.payloadFingerprint,
  });
  const current = scratch.holder.ashfall(info.volcanoCode);
  const nextGeneration = (current?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(nextGeneration)) return false;
  const projection = projectVolcanoAshfall(info, {
    classificationNowMs,
    appliedSemanticKey,
    generation: nextGeneration,
  });
  if (projection.kind === "transient") return false;
  const targets = policy.extractCancellationTarget(info.meta, info);
  const gateInput: TelegramRevisionGateInput = {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
    stateSubjectKey: subject,
    meta: info.meta,
    comparator: policy.comparator,
    cancellationPolicy: policy.cancellationPolicy,
    terminal: policy.terminalPredicate(info.meta, info),
    deactivation: policy.deactivationPredicate(info.meta, info),
    cancellationTargetMatches: targets == null
      ? info.meta.infoType.value !== "取消"
      : targets.includes(subject),
    durable: policy.durable,
    tombstoneRetentionMs: policy.tombstoneRetentionMs,
    maxSubjects: policy.maxSubjects,
    familyCapacityMode: policy.familyCapacityMode,
    allowMissingSerial: policy.allowMissingSerial,
    variantRank: info.type === "VFVO54" ? 0 : 1,
    volcanoProvenance: {
      kind: "ashfall",
      actualEventId,
      sourceType: input.headType,
    },
    ...payloadFingerprints,
    legacyRevisionKey: subject,
  };
  const decision = scratch.gate.decide(gateInput);
  if (!decision.accepted) {
    return decision.kind === "duplicate"
      || decision.kind === "semanticDuplicate"
      || decision.kind === "stale";
  }
  if (projection.kind === "active") return scratch.holder.applyAcceptedAshfall(projection.projection);
  return clearRepairVolcanoSlice(
    scratch.holder,
    "ashfall",
    info.volcanoCode,
    input.sourceEventId,
    info.volcanoName,
  );
}

function orderHistoricalBeforeDedupe(
  items: readonly PreparedRepairItem[],
  journal: readonly VolcanoRepairJournalItem[],
): PreparedRepairItem[] {
  const journalById = new Map(journal.map((item) => [item.itemId, item]));
  const byTime = new Map<number, PreparedRepairItem[]>();
  for (const item of items) {
    const group = byTime.get(item.receivedTimeMs) ?? [];
    group.push(item);
    byTime.set(item.receivedTimeMs, group);
  }
  const ordered: PreparedRepairItem[] = [];
  for (const receivedTimeMs of [...byTime.keys()].sort((left, right) => left - right)) {
    const group = byTime.get(receivedTimeMs)!;
    if (group.length > 1) {
      if (!group.every((item) => journalById.has(item.itemId))) {
        throw new Error("sameTimeGroupOrderingUnproven");
      }
      group.sort((left, right) =>
        journalById.get(left.itemId)!.sequence - journalById.get(right.itemId)!.sequence);
    }
    ordered.push(...group);
  }
  return ordered;
}

function preparedJournalItem(item: VolcanoRepairJournalItem): PreparedRepairItem {
  return {
    itemId: item.itemId,
    receivedTimeMs: item.receivedTimeMs,
    headType: item.normalizedInput.headType,
    bodyFingerprint: item.normalizedInput.bodyFingerprint,
    normalizedInput: item.normalizedInput,
  };
}

function mergeBaselineSourceIds(
  holder: VolcanoStateHolder,
  baseline: ReadonlyMap<string, readonly string[]>,
): boolean {
  const snapshot = holder.snapshot();
  for (const composite of snapshot.composites) {
    const previous = baseline.get(composite.volcanoCode) ?? [];
    const merged = [...new Set([...previous, ...composite.sourceEventIds])].sort(compareCodeUnit);
    if (merged.length > VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE) return false;
    composite.sourceEventIds = merged;
  }
  holder.replacePrevalidated(snapshot);
  return true;
}

function coupleVolcanoGateAndHolder(
  scratch: VolcanoScratchRuntime,
  startupNowMs: number,
): void {
  scratch.holder.retainActiveSubjects(
    scratch.gate.activeRevisionFamilySubjects("volcano", "volcanoAlert"),
    scratch.gate.activeRevisionFamilySubjects("volcano", "volcanoEruption"),
    scratch.gate.activeRevisionFamilySubjects("volcano", "volcanoAshfall"),
  );
  scratch.holder.sweep(startupNowMs);
}

function commitVfvo50Proof(
  coordinator: VolcanoTransactionCoordinator,
  proof: VolcanoTypeRepairProof,
  journal: VolcanoRepairJournal,
  startupNowMs: number,
): { kind: "committed" } | { kind: "failed"; reason: string } {
  const journalItems = journal.snapshot("vfvo50");
  let historical: PreparedRepairItem[];
  try {
    historical = orderHistoricalBeforeDedupe(proof.historical.items, journalItems);
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const liveJournalById = new Map(journalItems.map((item) => [
    item.itemId,
    preparedJournalItem(item),
  ]));
  // An ID observed by normal ingress already owns its local receipt clock.
  // Keep the REST union position (and its before-dedupe ordering proof), but
  // replay the journal-normalized input so rebuilding cannot reinterpret that
  // live mutation with the older startup classification clock.
  historical = historical.map((item) => liveJournalById.get(item.itemId) ?? item);
  const historicalIds = new Set(historical.map((item) => item.itemId));
  const journalTail = journalItems
    .filter((item) => !historicalIds.has(item.itemId))
    .sort((left, right) => left.sequence - right.sequence)
    .map(preparedJournalItem);
  const transaction = coordinator.transact("volcanoAlert", (scratch) => {
    const omissionsBefore = canonicalJson(scratch.repair.unrecoverableAlertOmissions);
    const baselineSourceIds = new Map(scratch.holder.snapshot().composites
      .map((composite) => [composite.volcanoCode, [...composite.sourceEventIds]] as const));
    const gateEntries = scratch.gate.exportDurableEntries().filter((entry) =>
      entry.domain === "volcano" && entry.revisionFamily === "volcanoAlert");
    const repairOnlySubjects = new Set(gateEntries
      .filter((entry) => entry.cancelled === false
        && entry.volcanoProvenance?.kind === "alert"
        && entry.volcanoProvenance.sourceFamily === "VFVO50"
        && entry.stateSubjectKey.startsWith("volcano:alert:")
        && scratch.holder.composite(
          entry.stateSubjectKey.slice("volcano:alert:".length),
        )?.alert == null)
      .map((entry) => entry.stateSubjectKey));
    const protectedSubjects = new Set(gateEntries
      .filter((entry) => entry.volcanoProvenance?.kind !== "alert"
        || entry.volcanoProvenance.sourceFamily !== "VFVO50")
      .map((entry) => entry.stateSubjectKey));
    for (const composite of scratch.holder.snapshot().composites) {
      if (composite.alert != null && composite.alert.sourceFamily !== "VFVO50") {
        protectedSubjects.add(`volcano:alert:${composite.volcanoCode}`);
      }
    }
    const unresolvedRepairOnly = new Set(repairOnlySubjects);
    for (const item of [...historical, ...journalTail]) {
      const expiryNowMs = liveJournalById.has(item.itemId)
        ? item.normalizedInput.parsed.meta.receivedAtMs
        : startupNowMs;
      if (!repairReplayTimesValid(item.normalizedInput, expiryNowMs)) {
        return { kind: "rejected" as const, reason: "vfvo50ReplayClockInvalid" };
      }
      const gateInput = item.normalizedInput.parsed.kind === "alert"
        ? alertGateInput(item.normalizedInput.parsed)
        : null;
      const subject = gateInput?.stateSubjectKey;
      if (subject == null) {
        return { kind: "rejected" as const, reason: "vfvo50ReplayRejected" };
      }
      if (protectedSubjects.has(subject)) continue;
      if (unresolvedRepairOnly.has(subject)) {
        const reconstruction = reconstructVfvo50MissingSlice(scratch, item.normalizedInput);
        if (reconstruction === "failed") {
          return { kind: "rejected" as const, reason: "vfvo50ReplayRejected" };
        }
        if (reconstruction === "reconstructed") unresolvedRepairOnly.delete(subject);
        continue;
      }
      if (!applyVfvo50RepairInput(scratch, item.normalizedInput)) {
        return { kind: "rejected" as const, reason: "vfvo50ReplayRejected" };
      }
    }
    if (unresolvedRepairOnly.size > 0) {
      return { kind: "rejected" as const, reason: "vfvo50RepairOnlyCoverageMissing" };
    }
    scratch.holder.retainActiveSubjects(
      scratch.gate.activeRevisionFamilySubjects("volcano", "volcanoAlert"),
      scratch.gate.activeRevisionFamilySubjects("volcano", "volcanoEruption"),
      scratch.gate.activeRevisionFamilySubjects("volcano", "volcanoAshfall"),
    );
    if (!mergeBaselineSourceIds(scratch.holder, baselineSourceIds)) {
      return { kind: "rejected" as const, reason: "vfvo50SourceCapacityExceeded" };
    }
    if (canonicalJson(scratch.repair.unrecoverableAlertOmissions) !== omissionsBefore) {
      return { kind: "rejected" as const, reason: "vfvo50OmissionMutation" };
    }
    scratch.repair.vfvo50Repairable = false;
    return { kind: "accepted" as const, value: undefined, durableChanged: true };
  });
  return transaction.kind === "committed"
    ? { kind: "committed" }
    : { kind: "failed", reason: transaction.kind === "rejected" ? transaction.reason : "staleVersion" };
}

function commitAshfallProof(
  coordinator: VolcanoTransactionCoordinator,
  proofs: readonly [VolcanoTypeRepairProof, VolcanoTypeRepairProof],
  journal: VolcanoRepairJournal,
  startupNowMs: number,
): { kind: "committed" } | { kind: "failed"; reason: string } {
  const union: PreparedRepairItem[] = [];
  const byId = new Map<string, PreparedRepairItem>();
  for (const item of proofs.flatMap((proof) => proof.historical.items)) {
    const previous = byId.get(item.itemId);
    if (previous != null) {
      if (!crossSetConsistent(previous, item)) return { kind: "failed", reason: "transportInconsistency" };
      // A consistent overlap between independently proven sets is one
      // transport item, not a duplicate within either pagination union.
      continue;
    }
    byId.set(item.itemId, item);
    union.push(item);
  }
  const journalItems = journal.snapshot("ashfall");
  let historical: PreparedRepairItem[];
  try {
    historical = orderHistoricalBeforeDedupe(union, journalItems);
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const liveJournalById = new Map(journalItems.map((item) => [
    item.itemId,
    preparedJournalItem(item),
  ]));
  historical = historical.map((item) => liveJournalById.get(item.itemId) ?? item);
  const historicalIds = new Set(historical.map((item) => item.itemId));
  const journalTail = journalItems
    .filter((item) => !historicalIds.has(item.itemId))
    .sort((left, right) => left.sequence - right.sequence)
    .map(preparedJournalItem);
  const transaction = coordinator.transact("volcanoAshfall", (scratch) => {
    const baseline = new Map(scratch.holder.snapshot().composites
      .map((composite) => [composite.volcanoCode, [...composite.sourceEventIds]] as const));
    for (const composite of scratch.holder.snapshot().composites) {
      if (composite.ashfall != null) scratch.holder.clearAshfall(composite.volcanoCode);
    }
    const gateSnapshot = scratch.gate.cloneSnapshot();
    gateSnapshot.states = gateSnapshot.states.filter((entry) =>
      !entry.key.startsWith("volcano:volcanoAshfall:"));
    scratch.gate.replacePrevalidated(gateSnapshot);
    for (const item of [...historical, ...journalTail]) {
      const classificationNowMs = liveJournalById.has(item.itemId)
        ? item.normalizedInput.parsed.meta.receivedAtMs
        : startupNowMs;
      if (!repairReplayTimesValid(item.normalizedInput, classificationNowMs)) {
        return { kind: "rejected" as const, reason: "ashfallReplayClockInvalid" };
      }
      if (!applyAshfallRepairInput(scratch, item.normalizedInput, classificationNowMs)) {
        return { kind: "rejected" as const, reason: "ashfallReplayRejected" };
      }
    }
    scratch.gate.expireRevisionFamily(
      "volcano",
      "volcanoAshfall",
      startupNowMs,
      VOLCANO_ASHFALL_RETENTION_MS,
    );
    coupleVolcanoGateAndHolder(scratch, startupNowMs);
    if (!mergeBaselineSourceIds(scratch.holder, baseline)) {
      return { kind: "rejected" as const, reason: "ashfallSourceCapacityExceeded" };
    }
    scratch.repair.ashfallRepairable = false;
    return { kind: "accepted" as const, value: undefined, durableChanged: true };
  });
  return transaction.kind === "committed"
    ? { kind: "committed" }
    : { kind: "failed", reason: transaction.kind === "rejected" ? transaction.reason : "staleVersion" };
}

export interface VolcanoRepairTargetResult {
  target: VolcanoRepairTarget;
  kind: "committed" | "failed";
  reason?: string;
}

export interface VolcanoStartupRepairResult {
  targets: VolcanoRepairTargetResult[];
}

export function volcanoRepairTargets(repair: VolcanoRepairStateV1): VolcanoRepairTarget[] {
  return [
    ...(repair.vfvo50Repairable ? ["vfvo50" as const] : []),
    ...(repair.ashfallRepairable ? ["ashfall" as const] : []),
  ];
}

/**
 * Runs target-local REST proofs.  Every await happens before the synchronous
 * rebase transaction; normal WebSocket ingress continues through the journal.
 */
export async function repairVolcanoState(options: {
  apiKey: string;
  startupNowMs: number;
  coordinator: VolcanoTransactionCoordinator;
  journal: VolcanoRepairJournal;
  getAcknowledgement: () => WsSubscriptionAcknowledgement | null;
  loadPage?: TelegramPageLoader;
}): Promise<VolcanoStartupRepairResult> {
  const targets = volcanoRepairTargets(options.coordinator.snapshot().repair);
  const results: VolcanoRepairTargetResult[] = [];
  if (targets.includes("vfvo50")) {
    try {
      const proof = await proveVolcanoTypeCoverage({
        ...options,
        headType: "VFVO50",
        retentionMs: VOLCANO_ALERT_TOMBSTONE_RETENTION_MS,
      });
      const committed = commitVfvo50Proof(
        options.coordinator,
        proof,
        options.journal,
        options.startupNowMs,
      );
      results.push({ target: "vfvo50", ...committed });
    } catch (error) {
      results.push({
        target: "vfvo50",
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (targets.includes("ashfall")) {
    try {
      const vfvo54 = await proveVolcanoTypeCoverage({
        ...options,
        headType: "VFVO54",
        retentionMs: VOLCANO_ASHFALL_RETENTION_MS,
      });
      const vfvo55 = await proveVolcanoTypeCoverage({
        ...options,
        headType: "VFVO55",
        retentionMs: VOLCANO_ASHFALL_RETENTION_MS,
      });
      const committed = commitAshfallProof(
        options.coordinator,
        [vfvo54, vfvo55],
        options.journal,
        options.startupNowMs,
      );
      results.push({ target: "ashfall", ...committed });
    } catch (error) {
      results.push({
        target: "ashfall",
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { targets: results };
}

/**
 * 起動時に直近の VFVO50 電文履歴を取得し、古い順に replay して火山警報状態を復元する。
 * 解除・取消・レベル1 復帰の削除は VolcanoStateHolder.update() の既存分岐に任せる。
 * エラー時は警告ログのみ出力し、アプリの起動を妨げない。
 */
export async function restoreVolcanoState(
  apiKey: string,
  volcanoState: VolcanoStateHolder,
  revisionGate?: TelegramRevisionGate,
  foundationAuthoritative = false,
  onMutation?: () => void,
): Promise<"success" | "failed"> {
  try {
    const res = await listTelegrams(apiKey, "VFVO50", VOLCANO_RESTORE_WINDOW);

    if (res.items.length === 0) {
      log.debug("VFVO50 電文なし: 火山状態の復元をスキップ");
      return "success";
    }

    // 古い順に replay することで、窓内の解除・取消が後から正しく適用される
    const items = [...res.items].sort(
      (a, b) => Date.parse(a.head.time) - Date.parse(b.head.time)
    );

    let replayed = 0;
    for (const item of items) {
      if (!item.body) {
        log.debug(`VFVO50 電文に body なし: skip (id=${item.id})`);
        continue;
      }
      const info = parseVolcanoTelegram(toWsDataMessage(item, item.body));
      if (info == null) {
        log.debug(`VFVO50 電文のパースに失敗: skip (id=${item.id})`);
        continue;
      }
      if (info.kind !== "alert") continue;
      const policy = volcanoRevisionFamilyPolicy(info.type);
      const extracted = policy?.extractStateSubjectKey(info.meta, info);
      const subject = typeof extracted === "string" ? extracted : null;
      if (policy == null || revisionGate == null || subject == null) {
        if (!foundationAuthoritative) volcanoState.update(info);
        replayed++;
        continue;
      }
      const { meta: _meta, isTest: _isTest, ...payload } = info;
      const targets = info.meta.infoType.value === "取消"
        ? policy.extractCancellationTarget(info.meta, info)
        : null;
      const input: TelegramRevisionGateInput = {
        domain: policy.domain,
        revisionFamily: policy.revisionFamily,
        stateSubjectKey: subject,
        meta: info.meta,
        comparator: policy.comparator,
        cancellationPolicy: policy.cancellationPolicy,
        terminal: policy.terminalPredicate(info.meta, info),
        deactivation: policy.deactivationPredicate(info.meta, info),
        cancellationTargetMatches: targets == null
          ? info.meta.infoType.value !== "取消"
          : targets.includes(subject),
        durable: policy.durable,
        tombstoneRetentionMs: policy.tombstoneRetentionMs,
        maxSubjects: policy.maxSubjects,
        allowMissingSerial: policy.allowMissingSerial,
        payloadFingerprint: semanticPayloadFingerprint(payload),
        volcanoProvenance: { kind: "alert", sourceFamily: "VFVO50" },
      };
      const evaluation = revisionGate.evaluate(input);
      if (!evaluation.accepted) {
        if (
          foundationAuthoritative
          && (evaluation.kind === "duplicate" || evaluation.kind === "semanticDuplicate")
          && volcanoState.getEntry(info.volcanoCode) == null
          && revisionGate.matchesCurrentAcceptedPayload(input)
        ) {
          volcanoState.applyAcceptedAlert(info);
        }
        replayed++;
        continue;
      }
      const decision = revisionGate.decide(input);
      if (!decision.accepted) continue;
      if (decision.kind === "clearCurrent") {
        volcanoState.clearAlert(info.volcanoCode, undefined, info.volcanoName);
      }
      else volcanoState.applyAcceptedAlert(info);
      onMutation?.();
      replayed++;
    }

    if (volcanoState.size() > 0) {
      log.info(
        `火山警報状態を復元しました (${volcanoState.size()} 火山 / ${replayed} 電文を replay)`
      );
    } else {
      log.debug(`VFVO50 replay 完了: 継続中の警報なし (${replayed} 電文)`);
    }
  } catch (err) {
    log.warn(
      `火山状態の復元に失敗しました: ${err instanceof Error ? err.message : err}`
    );
    return "failed";
  }
  return "success";
}
