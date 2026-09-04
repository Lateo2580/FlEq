import type { ParsedTsunamiInfo, TelegramListItem, TelegramListResponse, TelegramMeta } from "../../types";
import { fetchTelegramBody, listTelegrams, type TelegramBodyResult, type TelegramListQuery } from "../../dmdata/rest-client";
import { parseTsunamiTelegram } from "../../dmdata/telegram-parser";
import { createTelegramMeta, FUTURE_REPORT_DATETIME_SKEW_MS, parseStrictReportDateTime } from "../../dmdata/telegram-meta";
import * as log from "../../logger";
import type { StandbyPersistenceAdmissionCoordinator } from "../display/standby-persistence-admission";
import { compareTsunamiRevisionIdentity, tsunamiActiveMatchesGate, tsunamiInfoTypePrecedence } from "../messages/tsunami-persistence-identity";
import { TelegramRevisionGate, type PersistedTelegramRevisionGateEntryV2, type TelegramRevisionDecision, type TelegramRevisionGateSnapshot } from "../messages/telegram-revision-gate";
import { TsunamiStateHolder, type TsunamiStateSnapshot } from "../messages/tsunami-state";
import { createTsunamiRevisionGateInput, processTsunami } from "../presentation/processors/process-tsunami";
import { strictRestReceivedTimeMs, toWsDataMessageFromRestBody } from "./telegram-adapter";
import { isTsunamiReleaseOnlyForecast } from "../../utils/tsunami-kind";

const DATE_LIMIT_MS = 8_640_000_000_000_000;
const STALE_EPOCH_REASON = "tsunamiRestoreStaleEpoch";

export type TsunamiRestoreBodyFailureReason = "forbidden" | "notFound" | "contentType" | "tooLarge" | "network";
export type TsunamiRestoreFailureReason =
  | "invalidRestoreClock" | "listUnavailable" | "listResponseInvalid"
  | "pageSizeExceeded" | "pageLimitExceeded" | "itemLimitExceeded"
  | "duplicateItemId" | "invalidCursorToken" | "cursorTokenLoop"
  | "listOrderInvalid" | "listItemInvalid" | "bodyUnavailable"
  | "bodyFetchLimitExceeded" | "bodyIdentityMismatch" | "parseFailed"
  | "replayTimeInvalid" | "unorderedReplayRevision" | "equalRevisionPayloadConflict"
  | "baselineGateMismatch" | "baselineOutsideRestoreWindow"
  | "coverageMissingPersistedEvent" | "coverageMissingGateOnlyBase"
  | "coverageMissingNewEventBase" | "headStabilityLimitExceeded"
  | "tsunamiReplayRejected" | "admissionRejected" | "staleVersion";
export type TsunamiRestoreFailure =
  | { reason: "bodyUnavailable"; bodyReason: TsunamiRestoreBodyFailureReason }
  | { reason: "admissionRejected"; admissionReason: string }
  | { reason: Exclude<TsunamiRestoreFailureReason, "bodyUnavailable" | "admissionRejected"> };
export type TsunamiRestoreAttemptResult =
  | { kind: "complete"; changed: boolean; active: ParsedTsunamiInfo | null }
  | { kind: "noData"; changed: false }
  | { kind: "abandoned"; changed: false }
  | ({ kind: "incomplete"; changed: false; retryable: boolean } & TsunamiRestoreFailure);

export const TSUNAMI_RESTORE_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const TSUNAMI_RESTORE_PAGE_LIMIT = 100;
export const TSUNAMI_RESTORE_MAX_PAGES_PER_SCAN = 128;
export const TSUNAMI_RESTORE_MAX_ITEMS_PER_SCAN = 256;
export const TSUNAMI_RESTORE_MAX_BODY_FETCHES_PER_ROUND = 256;
export const TSUNAMI_RESTORE_MAX_STABILITY_ROUNDS = 4;
export const TSUNAMI_RESTORE_MAX_BODY_FETCHES_PER_ATTEMPT = 1_024;

type PageLoader = (apiKey: string, query: TelegramListQuery) => Promise<TelegramListResponse>;
type BodyLoader = (apiKey: string, id: string, expectedUrl?: string) => Promise<TelegramBodyResult>;
export interface TsunamiRestoreAttemptOptions {
  now?: () => number;
  loadPage?: PageLoader;
  loadBody?: BodyLoader;
  isCurrent?: () => boolean;
  /** production ceiling を下げる deterministic budget-boundary test 専用 seam。 */
  testMaxBodyFetchesPerRound?: number;
}
interface Stats { pages: number; items: number; bodies: number; rounds: number; missingEventIds: string[] }
interface PreparedItem { item: TelegramListItem; id: string; url: string; receivedAtMs: number; meta: TelegramMeta; eventId: string }
interface StagedItem extends PreparedItem { parsed: ParsedTsunamiInfo; msg: ReturnType<typeof toWsDataMessageFromRestBody>; semanticIdentity: string }
interface CoveragePlan {
  selectedIds: Set<string>;
  isolatedAnchors: Map<string, PersistedTelegramRevisionGateEntryV2>;
  gateOnlyAnchors: Map<string, PersistedTelegramRevisionGateEntryV2>;
  gateOnlyHolderPostconditions: Map<string, boolean>;
  holderAnchors: Set<string>;
}
type ReconstructibleBaseKind = "activeSnapshot" | "wholeCancellation" | "releaseOnly";
class Failure { constructor(readonly failure: TsunamiRestoreFailure) {} }
class Abandoned {}

const identity = (value: unknown): string => JSON.stringify(value);
const codeUnitCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function tsunamiRestoreFailureIsRetryable(f: TsunamiRestoreFailure): boolean {
  if (["listUnavailable", "headStabilityLimitExceeded", "coverageMissingPersistedEvent", "staleVersion"].includes(f.reason)) return true;
  return f.reason === "bodyUnavailable" && ["network", "notFound", "contentType"].includes(f.bodyReason);
}
const incomplete = (f: TsunamiRestoreFailure): TsunamiRestoreAttemptResult => ({ kind: "incomplete", changed: false, retryable: tsunamiRestoreFailureIsRetryable(f), ...f });
function fail(reason: Exclude<TsunamiRestoreFailureReason, "bodyUnavailable" | "admissionRejected">): never { throw new Failure({ reason }); }
function ensureCurrent(options: TsunamiRestoreAttemptOptions): void { if (options.isCurrent?.() === false) throw new Abandoned(); }
function coverageStart(nowMs: number): number | null {
  const start = nowMs - TSUNAMI_RESTORE_LOOKBACK_MS;
  return Number.isSafeInteger(nowMs) && Math.abs(nowMs) <= DATE_LIMIT_MS
    && Number.isSafeInteger(start) && Math.abs(start) <= DATE_LIMIT_MS ? start : null;
}
const serialMissing = (meta: TelegramMeta): boolean => meta.serial.raw == null || meta.serial.raw === "";
const serialIdentity = (meta: TelegramMeta): readonly unknown[] => serialMissing(meta)
  ? ["missing"] : ["numeric", meta.serial.raw, meta.serial.numeric, meta.serial.valid];

function prepareListItem(item: TelegramListItem): PreparedItem {
  const id = typeof item?.id === "string" ? item.id : "";
  const url = typeof item?.url === "string" ? item.url : "";
  const receivedAtMs = typeof item?.head?.time === "string" ? strictRestReceivedTimeMs(item.head.time) : null;
  const head = item?.xmlReport?.head;
  if (id.trim() === "" || url.trim() === "" || item?.head?.type !== "VTSE41" || receivedAtMs == null || head == null) fail("listItemInvalid");
  const createdMeta = createTelegramMeta({
    messageId: id, eventId: head.eventId, type: item.head.type,
    reportDateTime: head.reportDateTime, serial: head.serial, infoType: head.infoType,
    receivedAtMs, status: item.xmlReport?.control?.status ?? null, isTest: item.head.test === true,
  });
  // List shape validation is syntactic/range-only. Cross-clock skew belongs to replayTimeInvalid.
  const meta: TelegramMeta = {
    ...createdMeta,
    reportDateTime: parseStrictReportDateTime(head.reportDateTime, DATE_LIMIT_MS),
  };
  const eventId = meta.eventId.value?.trim() ?? "";
  if (!meta.type.valid || !meta.eventId.valid || eventId === "" || !meta.reportDateTime.valid
    || meta.reportDateTime.epochMs == null || !meta.infoType.valid || meta.infoType.value == null
    || (!serialMissing(meta) && (!meta.serial.valid || meta.serial.numeric == null))) fail("listItemInvalid");
  return { item, id, url, receivedAtMs, meta, eventId };
}

async function fetchWindow(apiKey: string, startMs: number, loadPage: PageLoader, options: TsunamiRestoreAttemptOptions, stats: Stats): Promise<PreparedItem[]> {
  const relevant: PreparedItem[] = [];
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let cursorToken: string | undefined;
  let previousMs: number | null = null;
  for (let page = 1; page <= TSUNAMI_RESTORE_MAX_PAGES_PER_SCAN; page += 1) {
    ensureCurrent(options);
    let response: TelegramListResponse;
    try {
      response = await loadPage(apiKey, { type: "VTSE41", limit: TSUNAMI_RESTORE_PAGE_LIMIT, formatMode: "raw", xmlReport: true, ...(cursorToken == null ? {} : { cursorToken }) });
      stats.pages += 1;
    } catch {
      ensureCurrent(options);
      throw new Failure({ reason: "listUnavailable" });
    }
    ensureCurrent(options);
    if (response?.status === "error") throw new Failure({ reason: "listUnavailable" });
    if (response?.status !== "ok" || !Array.isArray(response.items)) fail("listResponseInvalid");
    if (response.items.length > TSUNAMI_RESTORE_PAGE_LIMIT) fail("pageSizeExceeded");
    for (const raw of response.items) {
      const item = prepareListItem(raw);
      if (previousMs != null && item.receivedAtMs > previousMs) fail("listOrderInvalid");
      previousMs = item.receivedAtMs;
      if (ids.has(item.id)) fail("duplicateItemId");
      ids.add(item.id);
      if (item.receivedAtMs >= startMs) {
        relevant.push(item); stats.items += 1;
        if (relevant.length > TSUNAMI_RESTORE_MAX_ITEMS_PER_SCAN) fail("itemLimitExceeded");
      }
    }
    const rawToken = (response as { nextToken?: unknown }).nextToken;
    if (rawToken != null && (typeof rawToken !== "string" || rawToken.trim() === "")) fail("invalidCursorToken");
    const next = typeof rawToken === "string" ? rawToken : undefined;
    if (next != null && tokens.has(next)) fail("cursorTokenLoop");
    const sentinel = response.items.some((item) => {
      const time = strictRestReceivedTimeMs(item.head.time);
      return time != null && time < startMs;
    });
    if (sentinel || next == null) return relevant;
    if (page === TSUNAMI_RESTORE_MAX_PAGES_PER_SCAN) fail("pageLimitExceeded");
    tokens.add(next); cursorToken = next;
  }
  fail("pageLimitExceeded");
}

function windowIdentity(items: readonly PreparedItem[]): string {
  return identity([...items].sort((a, b) => b.receivedAtMs - a.receivedAtMs || codeUnitCompare(a.id, b.id)).map((x) => [
    x.id, x.url, x.receivedAtMs, x.eventId, x.meta.reportDateTime.raw, x.meta.reportDateTime.epochMs,
    ...serialIdentity(x.meta), x.meta.infoType.raw, x.meta.infoType.value,
  ]));
}
function semanticIdentity(info: ParsedTsunamiInfo): string { const { meta: _m, isTest: _t, ...payload } = info; return identity(payload); }
function bodyMatches(item: PreparedItem, parsed: ParsedTsunamiInfo): boolean {
  const body = parsed.meta;
  const bodyReport = parseStrictReportDateTime(body.reportDateTime.raw, DATE_LIMIT_MS);
  return body.type.raw === item.meta.type.raw && body.type.value === "VTSE41"
    && body.eventId.valid && body.eventId.raw === item.meta.eventId.raw && body.eventId.value === item.meta.eventId.value
    && bodyReport.valid && bodyReport.raw === item.meta.reportDateTime.raw && bodyReport.epochMs === item.meta.reportDateTime.epochMs
    && identity(serialIdentity(body)) === identity(serialIdentity(item.meta))
    && body.infoType.valid && body.infoType.raw === item.meta.infoType.raw && body.infoType.value === item.meta.infoType.value;
}
function replayTimeValid(item: StagedItem, nowMs: number): boolean {
  const reportMs = parseStrictReportDateTime(item.parsed.meta.reportDateTime.raw, DATE_LIMIT_MS).epochMs;
  return Number.isSafeInteger(item.receivedAtMs) && Math.abs(item.receivedAtMs) <= DATE_LIMIT_MS
    && item.receivedAtMs <= nowMs + FUTURE_REPORT_DATETIME_SKEW_MS
    && reportMs != null && Number.isSafeInteger(reportMs) && Math.abs(reportMs) <= DATE_LIMIT_MS
    && reportMs <= item.receivedAtMs + FUTURE_REPORT_DATETIME_SKEW_MS;
}
async function stageBodies(apiKey: string, items: readonly PreparedItem[], nowMs: number, loadBody: BodyLoader, options: TsunamiRestoreAttemptOptions, stats: Stats, total: { value: number }): Promise<StagedItem[]> {
  const staged: StagedItem[] = [];
  let roundCount = 0;
  const configuredRoundLimit = options.testMaxBodyFetchesPerRound;
  const roundLimit = Number.isSafeInteger(configuredRoundLimit) && configuredRoundLimit! >= 0
    ? Math.min(configuredRoundLimit!, TSUNAMI_RESTORE_MAX_BODY_FETCHES_PER_ROUND)
    : TSUNAMI_RESTORE_MAX_BODY_FETCHES_PER_ROUND;
  for (const item of items) {
    ensureCurrent(options);
    if (roundCount >= roundLimit || total.value >= TSUNAMI_RESTORE_MAX_BODY_FETCHES_PER_ATTEMPT) fail("bodyFetchLimitExceeded");
    let body: TelegramBodyResult;
    try { body = await loadBody(apiKey, item.id, item.url); roundCount += 1; total.value += 1; stats.bodies += 1; }
    catch { ensureCurrent(options); throw new Failure({ reason: "bodyUnavailable", bodyReason: "network" }); }
    ensureCurrent(options);
    if (body.kind === "failed") throw new Failure({ reason: "bodyUnavailable", bodyReason: body.reason });
    const msg = toWsDataMessageFromRestBody(item.item, body.xml, item.receivedAtMs);
    let parsed: ParsedTsunamiInfo | null = null;
    try { parsed = parseTsunamiTelegram(msg); } catch { parsed = null; }
    if (parsed == null) fail("parseFailed");
    if (!bodyMatches(item, parsed)) fail("bodyIdentityMismatch");
    const prepared = { ...item, parsed, msg, semanticIdentity: semanticIdentity(parsed) };
    if (!replayTimeValid(prepared, nowMs)) fail("replayTimeInvalid");
    staged.push(prepared);
  }
  return staged;
}

function validateRevisions(items: readonly StagedItem[]): void {
  const groups = new Map<string, StagedItem[]>();
  for (const item of items) groups.set(item.eventId, [...(groups.get(item.eventId) ?? []), item]);
  for (const group of groups.values()) for (let a = 0; a < group.length; a += 1) for (let b = a + 1; b < group.length; b += 1) {
    const relation = compareTsunamiRevisionIdentity(group[a].parsed.meta, group[b].parsed.meta);
    if (relation === "unordered") fail("unorderedReplayRevision");
    if (relation === "equal" && group[a].parsed.meta.infoType.value === group[b].parsed.meta.infoType.value && group[a].semanticIdentity !== group[b].semanticIdentity) fail("equalRevisionPayloadConflict");
  }
}
function replayOrder(a: StagedItem, b: StagedItem): number {
  if (a.receivedAtMs !== b.receivedAtMs) return a.receivedAtMs - b.receivedAtMs;
  if (a.eventId !== b.eventId) return codeUnitCompare(a.id, b.id);
  const relation = compareTsunamiRevisionIdentity(a.parsed.meta, b.parsed.meta);
  if (relation === "newer") return 1;
  if (relation === "older") return -1;
  return tsunamiInfoTypePrecedence(a.parsed.meta.infoType.value) - tsunamiInfoTypePrecedence(b.parsed.meta.infoType.value) || codeUnitCompare(a.id, b.id);
}
function exactGate(item: StagedItem, entry: PersistedTelegramRevisionGateEntryV2): boolean {
  const revision = entry.comparison.revision;
  const revisionSerial = revision.serial.raw == null || revision.serial.raw === ""
    ? ["missing"]
    : ["numeric", revision.serial.raw, revision.serial.numeric];
  const itemSerial = item.parsed.meta.serial.raw == null || item.parsed.meta.serial.raw === ""
    ? ["missing"]
    : ["numeric", item.parsed.meta.serial.raw, item.parsed.meta.serial.numeric];
  return entry.domain === "tsunami" && entry.revisionFamily === "VTSE41" && entry.stateSubjectKey === `tsunami:${item.eventId}`
    && !entry.cancelled && entry.acceptedAtMs === item.receivedAtMs
    && revision.reportDateTime.raw === item.parsed.meta.reportDateTime.raw && revision.reportDateTime.epochMs === item.parsed.meta.reportDateTime.epochMs
    && identity(revisionSerial) === identity(itemSerial)
    && revision.infoType.raw === item.parsed.meta.infoType.raw && revision.infoType.value === item.parsed.meta.infoType.value;
}
const keyable = (info: ParsedTsunamiInfo): boolean => (info.meta.eventId.value?.trim() ?? "") !== "" && (info.forecast ?? []).every((x) => x.areaCode != null && x.areaCode.trim() !== "" && x.kindCode != null && x.kindCode.trim() !== "");
const hasKeyedForecastItem = (info: ParsedTsunamiInfo): boolean => {
  if ((info.meta.eventId.value?.trim() ?? "") === "") return false;
  return (info.forecast ?? []).some((x) => x.areaCode != null && x.areaCode.trim() !== ""
    && x.kindCode != null && x.kindCode.trim() !== "");
};
function base(info: ParsedTsunamiInfo): ReconstructibleBaseKind | null {
  const forecast = info.forecast ?? [];
  if (info.meta.infoType.value === "取消") {
    return forecast.length === 0 ? "wholeCancellation" : null;
  }
  if (
    (info.meta.infoType.value !== "発表" && info.meta.infoType.value !== "訂正")
    || forecast.length === 0
    || !keyable(info)
  ) return null;
  return isTsunamiReleaseOnlyForecast(forecast) ? "releaseOnly" : "activeSnapshot";
}

function traceHasPersistedEvent(eventId: string, items: readonly StagedItem[]): boolean {
  const state = new TsunamiStateHolder();
  for (const item of items) {
    if (item.parsed.meta.infoType.value === "取消") state.clearAccepted(item.parsed);
    else state.applyAccepted(item.parsed);
  }
  return state.hasPersistedEvent(eventId);
}

function projection(state: TsunamiStateSnapshot, gate: TelegramRevisionGateSnapshot): unknown {
  const transient = gate.transientStates.filter((x) => x.domain === "tsunami" && x.revisionFamily === "VTSE41");
  const keys = new Set(transient.map((x) => x.key));
  return {
    holder: { currentLevel: state.currentLevel, lastInfo: state.lastInfo, keyedForecasts: state.keyedForecasts, eventInfos: state.eventInfos, legacyRestoredInfo: state.legacyRestoredInfo },
    gate: { states: gate.states.filter((x) => x.key.startsWith("tsunami:VTSE41:")), transientStates: transient, transientSemanticKeys: gate.transientSemanticKeys.filter(([, stateKey]) => keys.has(stateKey)) },
  };
}
const gateEntries = (gate: TelegramRevisionGate): PersistedTelegramRevisionGateEntryV2[] => gate.exportDurableEntries().filter((x) => x.domain === "tsunami" && x.revisionFamily === "VTSE41" && x.stateSubjectKey !== "tsunami:current" && x.stateSubjectKey.startsWith("tsunami:"));

function planCoverage(items: readonly StagedItem[], state: TsunamiStateHolder, gate: TelegramRevisionGate, startMs: number, stats: Stats): CoveragePlan {
  const ordered = [...items].sort(replayOrder);
  const byEvent = new Map<string, StagedItem[]>();
  for (const item of ordered) byEvent.set(item.eventId, [...(byEvent.get(item.eventId) ?? []), item]);
  const active = new Map(state.getPersistedKeyedActive().flatMap((x) => {
    const id = x.meta.eventId.value?.trim(); return id ? [[id, x] as const] : [];
  }));
  const bySubject = new Map<string, PersistedTelegramRevisionGateEntryV2[]>();
  for (const entry of gateEntries(gate)) bySubject.set(entry.stateSubjectKey, [...(bySubject.get(entry.stateSubjectKey) ?? []), entry]);
  const targets = new Map<string, { active: ParsedTsunamiInfo | null; gate: PersistedTelegramRevisionGateEntryV2 }>();
  for (const [eventId, info] of active) {
    const entries = bySubject.get(`tsunami:${eventId}`) ?? [];
    if (entries.length !== 1 || entries[0].cancelled || !tsunamiActiveMatchesGate(info, entries[0])) fail("baselineGateMismatch");
    targets.set(eventId, { active: info, gate: entries[0] });
  }
  for (const [subject, entries] of bySubject) {
    const eventId = subject.slice(8);
    if (entries.length !== 1) fail("baselineGateMismatch");
    if (entries[0].cancelled) { if (active.has(eventId)) fail("baselineGateMismatch"); continue; }
    if (!targets.has(eventId)) targets.set(eventId, { active: null, gate: entries[0] });
  }
  const selectedIds = new Set<string>();
  const isolatedAnchors = new Map<string, PersistedTelegramRevisionGateEntryV2>();
  const gateOnlyAnchors = new Map<string, PersistedTelegramRevisionGateEntryV2>();
  const gateOnlyHolderPostconditions = new Map<string, boolean>();
  const holderAnchors = new Set<string>();
  for (const [eventId, target] of targets) {
    if (target.gate.acceptedAtMs < startMs) fail("baselineOutsideRestoreWindow");
    const eventItems = byEvent.get(eventId) ?? [];
    const anchor = eventItems.find((x) => exactGate(x, target.gate));
    if (anchor == null) { stats.missingEventIds.push(eventId); fail("coverageMissingPersistedEvent"); }
    if (target.active != null) {
      for (const item of eventItems) if (item.receivedAtMs >= target.gate.acceptedAtMs) selectedIds.add(item.id);
      holderAnchors.add(anchor.id);
    } else if (base(anchor.parsed) != null) {
      for (const item of eventItems) if (item.receivedAtMs >= anchor.receivedAtMs) selectedIds.add(item.id);
      gateOnlyAnchors.set(anchor.id, target.gate);
      gateOnlyHolderPostconditions.set(anchor.id, base(anchor.parsed) === "activeSnapshot");
    } else {
      const anchorIndex = eventItems.indexOf(anchor);
      let baseIndex = -1;
      for (let index = anchorIndex; index >= 0; index -= 1) if (base(eventItems[index].parsed) != null) { baseIndex = index; break; }
      if (baseIndex < 0) { stats.missingEventIds.push(eventId); fail("coverageMissingGateOnlyBase"); }
      for (let index = baseIndex; index < eventItems.length; index += 1) selectedIds.add(eventItems[index].id);
      isolatedAnchors.set(anchor.id, target.gate);
      gateOnlyAnchors.set(anchor.id, target.gate);
      gateOnlyHolderPostconditions.set(
        anchor.id,
        traceHasPersistedEvent(eventId, eventItems.slice(baseIndex, anchorIndex + 1)),
      );
    }
    selectedIds.add(anchor.id);
  }
  for (const [eventId, eventItems] of byEvent) if (!targets.has(eventId)) {
    if (base(eventItems[0].parsed) == null) { stats.missingEventIds.push(eventId); fail("coverageMissingNewEventBase"); }
    for (const item of eventItems) selectedIds.add(item.id);
  }
  return { selectedIds, isolatedAnchors, gateOnlyAnchors, gateOnlyHolderPostconditions, holderAnchors };
}

function snapshotEntry(snapshot: TelegramRevisionGateSnapshot, subject: string): PersistedTelegramRevisionGateEntryV2 | null {
  const x = snapshot.states.find((s) => s.key === `tsunami:VTSE41:${subject}`);
  if (x == null || !x.durable) return null;
  return { domain: "tsunami", revisionFamily: "VTSE41", stateSubjectKey: subject, comparison: structuredClone(x.comparison), semanticKeys: [...x.semanticKeys], cancelled: x.cancelled, acceptedAtMs: x.acceptedAtMs, tombstoneRetentionMs: x.tombstoneRetentionMs ?? null, ...(x.legacyRevisionKey == null ? {} : { legacyRevisionKey: x.legacyRevisionKey }), ...(x.legacyRevisionKeyProvenance == null ? {} : { legacyRevisionKeyProvenance: x.legacyRevisionKeyProvenance }) };
}
function withoutIsolated(snapshot: TelegramRevisionGateSnapshot, isolated: ReadonlyMap<string, PersistedTelegramRevisionGateEntryV2>): TelegramRevisionGateSnapshot {
  const keys = new Set([...isolated.values()].map((x) => `tsunami:VTSE41:${x.stateSubjectKey}`));
  return { ...structuredClone(snapshot), states: snapshot.states.filter((x) => !keys.has(x.key)) };
}
function putEntry(
  snapshot: TelegramRevisionGateSnapshot,
  baseline: PersistedTelegramRevisionGateEntryV2,
  original: TelegramRevisionGateSnapshot,
): TelegramRevisionGateSnapshot {
  const key = `${baseline.domain}:${baseline.revisionFamily}:${baseline.stateSubjectKey}`;
  const originalIndex = original.states.findIndex((entry) => entry.key === key);
  const originalState = original.states[originalIndex];
  const restored = originalState == null
    ? {
        key, comparison: structuredClone(baseline.comparison), semanticKeys: [...baseline.semanticKeys], cancelled: baseline.cancelled,
        acceptedAtMs: baseline.acceptedAtMs, durable: true, tombstoneRetentionMs: baseline.tombstoneRetentionMs ?? null,
        retainForFamilyCapacity: false, legacyRevisionKey: baseline.legacyRevisionKey ?? null,
        legacyRevisionKeyProvenance: baseline.legacyRevisionKeyProvenance ?? null,
      }
    : structuredClone(originalState);
  const states = snapshot.states.filter((entry) => entry.key !== key);
  const originalPositions = new Map(original.states.map((entry, index) => [entry.key, index] as const));
  const successorIndex = originalIndex < 0
    ? -1
    : states.findIndex((entry) => {
        const position = originalPositions.get(entry.key);
        return position != null && position > originalIndex;
      });
  states.splice(successorIndex < 0 ? states.length : successorIndex, 0, restored);
  return { ...snapshot, states };
}
type ReplayResult = { kind: "success"; state: TsunamiStateSnapshot; gate: TelegramRevisionGateSnapshot; changed: boolean }
  | { kind: "failure"; reason: "tsunamiReplayRejected" | "baselineGateMismatch" | "coverageMissingGateOnlyBase" };
function replayBatch(stateSnapshot: TsunamiStateSnapshot, gateSnapshot: TelegramRevisionGateSnapshot, items: readonly StagedItem[], coverage: CoveragePlan): ReplayResult {
  const before = identity(projection(stateSnapshot, gateSnapshot));
  const state = TsunamiStateHolder.fromSnapshot(stateSnapshot);
  let gate = TelegramRevisionGate.fromSnapshot(withoutIsolated(gateSnapshot, coverage.isolatedAnchors));
  const baselineProofGate = TelegramRevisionGate.fromSnapshot(gateSnapshot);
  for (const item of items.filter((x) => coverage.selectedIds.has(x.id)).sort(replayOrder)) {
    const gateOnlyBaseline = coverage.gateOnlyAnchors.get(item.id);
    const anchorInput = gateOnlyBaseline == null
      ? null
      : createTsunamiRevisionGateInput(item.parsed, state, item.msg.head.type);
    if (gateOnlyBaseline != null && (
      anchorInput == null
      || !baselineProofGate.matchesCurrentAcceptedPayload(anchorInput)
    )) return { kind: "failure", reason: "baselineGateMismatch" };
    let observed: TelegramRevisionDecision | undefined;
    const result = processTsunami(item.msg, { tsunamiState: state, revisionGate: gate, restoreStateOnDuplicate: true, onRevisionDecision: (x) => { observed = x; }, persistenceAdmission: undefined });
    const allowed = result.kind === "suppressed" && observed != null && ["duplicate", "semanticDuplicate", "stale"].includes(observed.kind);
    if (result.kind === "parse-failed" || result.kind === "suppressed" && !allowed || result.kind === "ok" && observed?.accepted !== true) return { kind: "failure", reason: "tsunamiReplayRejected" };
    if (
      coverage.holderAnchors.has(item.id)
      && result.kind === "suppressed"
      && (observed?.kind === "duplicate" || observed?.kind === "semanticDuplicate")
      && hasKeyedForecastItem(item.parsed)
    ) state.replayPersistedEventEnvelope(item.eventId);
    const baseline = coverage.isolatedAnchors.get(item.id);
    if (baseline != null) {
      const generated = snapshotEntry(gate.cloneSnapshot(), baseline.stateSubjectKey);
      if (generated == null || !exactGate(item, generated) || anchorInput == null
        || !gate.matchesCurrentAcceptedPayload(anchorInput)) return { kind: "failure", reason: "baselineGateMismatch" };
      gate = TelegramRevisionGate.fromSnapshot(putEntry(gate.cloneSnapshot(), baseline, gateSnapshot));
    }
    const expectedHolder = coverage.gateOnlyHolderPostconditions.get(item.id);
    if (gateOnlyBaseline != null && expectedHolder !== state.hasPersistedEvent(item.eventId)) {
      return { kind: "failure", reason: "coverageMissingGateOnlyBase" };
    }
  }
  for (const baseline of coverage.gateOnlyAnchors.values()) {
    if (snapshotEntry(gate.cloneSnapshot(), baseline.stateSubjectKey) == null) {
      return { kind: "failure", reason: "coverageMissingGateOnlyBase" };
    }
  }
  const stateAfter = state.cloneSnapshot(); const gateAfter = gate.cloneSnapshot();
  return { kind: "success", state: stateAfter, gate: gateAfter, changed: before !== identity(projection(stateAfter, gateAfter)) };
}
function warnFailure(f: TsunamiRestoreFailure, stats: Stats): void {
  const detail = f.reason === "bodyUnavailable" ? ` bodyReason=${f.bodyReason}` : f.reason === "admissionRejected" ? ` admissionReason=${f.admissionReason}` : "";
  log.warn(`[tsunami-restore] incomplete reason=${f.reason}${detail} pages=${stats.pages} items=${stats.items} bodies=${stats.bodies} rounds=${stats.rounds} missingEventIds=${stats.missingEventIds.join(",") || "-"}`);
}

export async function restoreTsunamiState(
  apiKey: string,
  tsunamiState: TsunamiStateHolder,
  revisionGate: TelegramRevisionGate,
  onAcceptedRevision?: () => void,
  persistenceAdmission?: StandbyPersistenceAdmissionCoordinator,
  options: TsunamiRestoreAttemptOptions = {},
): Promise<TsunamiRestoreAttemptResult> {
  const stats: Stats = { pages: 0, items: 0, bodies: 0, rounds: 0, missingEventIds: [] };
  const nowMs = (options.now ?? (() => Date.now()))();
  const startMs = coverageStart(nowMs);
  if (startMs == null) { const f = { reason: "invalidRestoreClock" } as const; warnFailure(f, stats); return incomplete(f); }
  const entryState = tsunamiState.cloneSnapshot(); const entryGate = revisionGate.cloneSnapshot();
  const epoch = identity(projection(entryState, entryGate));
  const baselineState = TsunamiStateHolder.fromSnapshot(entryState); const baselineGate = TelegramRevisionGate.fromSnapshot(entryGate);
  const loadPage = options.loadPage ?? ((key, query) => listTelegrams(key, query));
  const loadBody = options.loadBody ?? ((key, id, url) => fetchTelegramBody(key, id, url));
  const totalBodies = { value: 0 };
  try {
    ensureCurrent(options);
    let stable: StagedItem[] | null = null;
    for (let round = 1; round <= TSUNAMI_RESTORE_MAX_STABILITY_ROUNDS; round += 1) {
      stats.rounds = round;
      const before = await fetchWindow(apiKey, startMs, loadPage, options, stats);
      const staged = await stageBodies(apiKey, before, nowMs, loadBody, options, stats, totalBodies);
      const after = await fetchWindow(apiKey, startMs, loadPage, options, stats);
      if (windowIdentity(before) === windowIdentity(after)) { stable = staged; break; }
    }
    if (stable == null) fail("headStabilityLimitExceeded");
    validateRevisions(stable);
    const hasBaseline = baselineState.getPersistedKeyedActive().length > 0 || gateEntries(baselineGate).some((x) => !x.cancelled);
    if (stable.length === 0 && !hasBaseline) return { kind: "noData", changed: false };
    const coverage = planCoverage(stable, baselineState, baselineGate, startMs, stats);
    ensureCurrent(options);
    let replayed: ReplayResult;
    if (persistenceAdmission != null) {
      const transaction = persistenceAdmission.transact("tsunami:VTSE41", ["telegramRevisionGate", "tsunamiState"], (draft) => {
        if (identity(projection(draft.tsunamiState, draft.telegramRevisionGate)) !== epoch) return { kind: "rejected", reason: STALE_EPOCH_REASON };
        const batch = replayBatch(draft.tsunamiState, draft.telegramRevisionGate, stable!, coverage);
        if (batch.kind === "success" && batch.changed) { draft.tsunamiState = batch.state; draft.telegramRevisionGate = batch.gate; }
        return { kind: "accepted", value: batch, durableChanged: batch.kind === "success" && batch.changed };
      });
      ensureCurrent(options);
      if (transaction.kind === "staleVersion" || transaction.kind === "rejected" && transaction.reason === STALE_EPOCH_REASON) throw new Failure({ reason: "staleVersion" });
      if (transaction.kind === "rejected") throw new Failure({ reason: "admissionRejected", admissionReason: transaction.reason });
      replayed = transaction.value;
    } else {
      const latestState = tsunamiState.cloneSnapshot(); const latestGate = revisionGate.cloneSnapshot();
      if (identity(projection(latestState, latestGate)) !== epoch) throw new Failure({ reason: "staleVersion" });
      const stateVersion = tsunamiState.version(); const gateVersion = revisionGate.version();
      replayed = replayBatch(latestState, latestGate, stable, coverage);
      ensureCurrent(options);
      if (replayed.kind === "success" && replayed.changed) {
        if (tsunamiState.version() !== stateVersion || revisionGate.version() !== gateVersion) throw new Failure({ reason: "staleVersion" });
        ensureCurrent(options); revisionGate.replacePrevalidated(replayed.gate); tsunamiState.replacePrevalidated(replayed.state);
      }
    }
    if (replayed.kind === "failure") fail(replayed.reason);
    if (replayed.changed) onAcceptedRevision?.();
    return { kind: "complete", changed: replayed.changed, active: tsunamiState.getLastInfo() };
  } catch (error) {
    if (error instanceof Abandoned) return { kind: "abandoned", changed: false };
    const f = error instanceof Failure ? error.failure : { reason: "listUnavailable" } as const;
    warnFailure(f, stats); return incomplete(f);
  }
}
