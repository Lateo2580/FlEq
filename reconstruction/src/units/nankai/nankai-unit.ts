import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, ReportRef, RuntimeDisplaySubject,
  RuntimeUnitDeadline, SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  NankaiCurrent, NankaiCurrentLine, NankaiCurrentStatus, NankaiEvidence, NankaiInfoSerial, NankaiInformation, NankaiInformationView, NankaiInput,
  NankaiIntent, NankaiNotificationPayload, NankaiReportFamily, NankaiUnitCodec, NankaiUnitState, NankaiUnitStep, NankaiUnitView,
  PersistedNankaiUnit,
} from "../../../contracts/p3-nankai-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { controlDateTimeOf, nextMark, readReportRef, stepVersion } from "../../contracts-revision/version"; import type { VersionRef } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { BOUNDS, FAMILIES, INFO_RANK, LIMITS, cut, parseNankai, validEventId, validSerial } from "../../domains/nankai/nankai";
import type { NankaiCandidate } from "../../domains/nankai/nankai";
import {
  applyIntentUpdate, cancelText, freshState, heard, markNotice, noticeId, noticeKind, noticed, raiseEvidence, readIntentState, readNoticeMark, restoreStarted,
  shown, updateEvidence, versionDigest,
} from "../notice-mark";

// P3-UNIT-N-001（C8、I-U-N）: U-N の現況・情報系列・通知・容量・codec・射影。

const SCHEMA = "p3-nankai-unit-v4" as const;
const OPERATIONS = ["normal", "training", "test"] as const;
const LINES = ["nankai", "VYSE60"] as const;
// P3-C8-CAPACITY=A・P3-C8-RES-01・RET-01〜04。世代の上限は P3-AUTH-D-N-BUDGET=A（K2、当初 256 KiB）。
const CURRENT_LIMIT = 6, INFORMATION_LIMIT = 64, GENERATION_LIMIT = 294_912;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C8-SEM-01〜05（元報の ReportDateTime からの絶対の長さ、P3-C8-RETENTION=A）。
const DAY_MS = 86_400_000;
const CURRENT_VALID_MS = 7 * DAY_MS, CURRENT_RETAIN_MS = 30 * DAY_MS, INFORMATION_RETAIN_MS = 7 * DAY_MS;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const STATUSES: Readonly<Record<NankaiCurrentLine, readonly string[]>> = {
  nankai: ["investigating", "megaquakeWarning", "megaquakeAdvisory"], VYSE60: ["subsequentAdvisory"] };

type ActiveCurrent = Extract<NankaiCurrent, Readonly<{ effective: "active" }>>;
type ActiveInformation = Extract<NankaiInformation, Readonly<{ effective: "active" }>>;
type EvidenceInformation = Extract<NankaiInformation, Readonly<{ effective: "evidence" }>>;
type FactInformation = Exclude<NankaiInformation, EvidenceInformation>;
type Shown = NankaiCurrent | NankaiInformation;
type Fact = NankaiCurrent | FactInformation;
type Level = NankaiNotificationPayload["level"];
type InternalStep = Omit<NankaiUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = NankaiUnitStep["decisions"][number];
type Change = readonly [before: Shown | null, after: Shown | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;

const isCurrent = (value: Shown): value is NankaiCurrent => "line" in value;
const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// 版は事実を持つ記録なら source、証拠だけの記録なら証拠（P3-AUTH-AC01(3)）。U-N の種類は Control/DateTime だけで比べる（P3-VM-D-TABLE=A）
// ので、証拠の ReportDateTime は比べに使わず渡さない（保存の値を時刻の文字列に戻すと範囲外で例外になる）。
const versionOf = (value: Shown): VersionRef => value.effective === "evidence" ? { family: value.family, reportDateTimeRaw: "",
  controlDateTimeRaw: value.evidence.controlDateTimeRaw, serialRaw: value.evidence.serialRaw } : value.source;
const msOf = (value: Shown): number => value.effective === "evidence" ? value.evidence.reportDateTimeMs : reportMs(value.source);
const visible = (value: Shown | null): value is ActiveCurrent | ActiveInformation => value?.effective === "active";

// ---- byte の加算（I-U-N.computation。受信 1 回で state 全体を直列化しない） ----

const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
const commas = (length: number) => Math.max(length - 1, 0);
const sumCache = new WeakMap<readonly object[], number>();
function listBytes(values: readonly object[]): number {
  let total = sumCache.get(values);
  if (total == null) { total = 2 + commas(values.length) + values.reduce((sum, item) => sum + bytes(item), 0); sumCache.set(values, total); }
  return total;
}
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-N", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [], evidence: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7): envelope の inputBoundary と losses の最大
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T・U-Q と同じ予約）。6: 空の配列 3 つ。
function generationBytes(currents: readonly NankaiCurrent[], intents: readonly NankaiIntent[], evidence: readonly NankaiEvidence[]): number {
  return emptyEnvelopeBytes + 62 - 6 + listBytes(currents) + listBytes(intents) + listBytes(evidence);
}

// ---- 期限（I-U-N.deadlines） ----

const deadlineCache = new WeakMap<readonly object[], number>();
function minOf<T extends object>(values: readonly T[], at: (value: T) => number): number {
  let min = deadlineCache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); deadlineCache.set(values, min); }
  return min;
}
const currentDeadline = (value: NankaiCurrent) => value.effective === "active" ? Math.min(value.validUntil, value.retainUntil) : value.retainUntil;
function deadlineAt(state: NankaiUnitState): number {
  return Math.min(minOf(state.currents, currentDeadline), minOf(state.information, (item) => item.retainUntil),
    minOf(state.intents, (item) => item.expiresAt));
}
function nextDeadline(state: NankaiUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: NankaiUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

// ---- 索引（配列に結び付けた Map。受信ごとに配列を探し直さない、I-U-N.computation） ----

const indexCache = new WeakMap<readonly Shown[], ReadonlyMap<string, number>>();
function indexOf(values: readonly Shown[], subject: string): number | undefined {
  let index = indexCache.get(values);
  if (index == null) { index = new Map(values.map((item, at) => [item.subject, at])); indexCache.set(values, index); }
  return index.get(subject);
}
function replaceAt<T>(values: readonly T[], index: number | undefined, value: T): readonly T[] {
  return index == null ? [...values, value] : values.map((item, at) => at === index ? value : item);
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// P3-VM-AC03: 系統と情報 subject ごとに compareVersion で比べる（報番号・InfoType の順位は使わない）。同じ版の中身には InfoType を含める。
// 通知の印（P3-NL-AC02）も中身の比べに入れない。
const withoutSource = (value: Shown) => ({ ...value, source: null, unconfirmed: null, notice: null });

// ---- 現況（I-U-N.currentSemantics） ----

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["investigating", "megaquakeWarning", "megaquakeAdvisory", "subsequentAdvisory"]);
// 報が系統の現況に効くか。除外（(2)(3)(4)、解説・定例・表に無い code）は系統の watermark と比べない（P3-C8-SUBJECTS=A）。
function affectsCurrent(candidate: NankaiCandidate, current: NankaiCurrent | null): boolean {
  const sameReport = current != null && current.source.family === candidate.family && current.eventId === candidate.eventId;
  // (4)(5): 訂正と取消は現況の source と同じ headType・EventID のときだけ効く。
  if (candidate.cancelled || candidate.infoRank === 2) return sameReport;
  if (candidate.effect == null) return false;
  if (candidate.effect === "end") return current?.effective === "active" && current.status === "investigating";
  // (2): 調査中は active の巨大地震警戒・巨大地震注意を置き換えない。
  if (candidate.effect === "investigating") return !(current?.effective === "active" && current.status !== "investigating");
  return true;
}
function currentOf(candidate: NankaiCandidate): NankaiCurrent {
  const base = { subject: candidate.currentSubject, operation: candidate.operation, eventId: candidate.eventId,
    source: { ...candidate.source, subject: candidate.currentSubject }, retainUntil: candidate.reportDateTimeMs + CURRENT_RETAIN_MS };
  const { effect } = candidate;
  if (candidate.cancelled) return candidate.line === "VYSE60" ? { ...base, line: "VYSE60", effective: "cancelled" }
    : { ...base, line: "nankai", effective: "cancelled" };
  const facts = { effective: "active" as const, infoSerial: candidate.facts.infoSerial, title: candidate.facts.title,
    headline: candidate.facts.headline, truncated: candidate.facts.headingTruncated, validUntil: candidate.reportDateTimeMs + CURRENT_VALID_MS };
  if (candidate.line === "VYSE60") return { ...base, line: "VYSE60", status: "subsequentAdvisory", ...facts };
  // (3) と (4): 調査終了と、現況に効かない code への訂正は事実を捨てて ended（誤った status を残さない）。
  return effect === "investigating" || effect === "megaquakeWarning" || effect === "megaquakeAdvisory"
    ? { ...base, line: "nankai", status: effect, ...facts } : { ...base, line: "nankai", effective: "ended" };
}
function currentFacts(value: NankaiCurrent | null): Readonly<Record<string, JsonValue>> {
  if (value == null) return {};
  return value.effective === "active" ? { line: value.line, effective: value.effective, status: value.status, eventId: value.eventId,
    infoSerial: value.infoSerial, title: value.title, headline: value.headline } : { line: value.line, effective: value.effective, eventId: value.eventId };
}
const CURRENT_FIELDS = ["effective", "status", "infoSerial", "title", "headline"] as const;
const INFORMATION_FIELDS = ["effective", "infoKind", "infoSerial", "title", "headline", "text", "nextAdvisory"] as const;
function changed<T extends Shown>(before: T | null, after: T, fields: readonly string[]): string[] {
  const read = (value: T | null, field: string): unknown => value == null ? null : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  return fields.filter((field) => !isDeepStrictEqual(read(before, field), read(after, field)));
}

// ---- 情報系列（I-U-N.informationSemantics） ----

function informationOf(candidate: NankaiCandidate): FactInformation {
  const base = { subject: candidate.subject, family: candidate.family, eventId: candidate.eventId, operation: candidate.operation,
    source: candidate.source, retainUntil: candidate.reportDateTimeMs + INFORMATION_RETAIN_MS };
  if (candidate.cancelled) return { ...base, effective: "cancelled" };
  const { infoKind, infoSerial, title, headline, text, nextAdvisory, truncated } = candidate.facts;
  return { ...base, effective: "active", infoKind, infoSerial, title, headline, truncated, text, nextAdvisory };
}
// view・snapshot には見出しだけを載せる（P3-C8-SNAPSHOT=A）。
const headingCache = new WeakMap<ActiveInformation, NankaiInformationView>();
function headingOf(value: ActiveInformation): NankaiInformationView {
  let found = headingCache.get(value);
  if (found == null) {
    const { text: _text, nextAdvisory: _next, notice: _notice, ...heading } = value;
    found = heading;
    headingCache.set(value, found);
  }
  return found;
}
function informationFacts(value: FactInformation | null): Readonly<Record<string, JsonValue>> {
  if (value == null) return {};
  return value.effective === "active" ? headingOf(value) : { family: value.family, eventId: value.eventId, effective: value.effective };
}

// P3-C8-CAPACITY=A と P3-OPCAP-N-AC01: 65 件目は (1) retainUntil を過ぎたもの (2) training/test (3) normal の最古（ReportDateTime 順）から
// 1 件退去する。受ける報が training/test なら normal の記録（証拠だけの記録を含む）は (1)〜(3) とも候補にせず、候補が無ければ null
// （受けた記録自身を残さない）。
// ponytail: 64 件の一回の走査（上限は INFORMATION_LIMIT と復元の空で効く）。
function evictOne(information: readonly NankaiInformation[], now: number, incoming: Operation): NankaiInformation | null {
  const tier = (item: NankaiInformation) => item.retainUntil <= now ? 0 : item.operation !== "normal" ? 1 : 2;
  let worst: NankaiInformation | null = null;
  for (const item of information) {
    if (item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || msOf(item) - msOf(worst)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// P3-C8-NOTICE-LEVELS=B（作者裁定）: 報自身の InfoSerial/Code で決める（旧築 level-helpers.ts の nankaiTroughFrameLevel と同じ表）。
const CODE_LEVEL: ReadonlyMap<string, Level> = new Map([["120", "critical"], ["130", "warning"], ["111", "warning"], ["112", "warning"],
  ["113", "warning"], ["210", "warning"], ["219", "warning"], ["190", "info"], ["200", "info"]]);
function levelOf(candidate: NankaiCandidate): Level {
  if (candidate.cancelled) return "cancel";
  const code = candidate.facts.infoSerial?.code;
  return code == null ? "warning" : CODE_LEVEL.get(code) ?? "warning";
}
// at は取り消した記録の ReportDateTime（P3-NL-AC10）。
function payloadOf(candidate: NankaiCandidate, at: string | null): NankaiNotificationPayload {
  const prefix = PREFIX[candidate.operation], { title, headline, text } = candidate.facts;
  if (candidate.cancelled) {
    const words = cancelText(title, at);
    return { domain: "earthquake-eew", level: "cancel", title: prefix + words.title, body: words.body };
  }
  // Text の先頭 80 単位はサロゲートの対を割らずに切る（P3-CODEC-AC04、F15）。
  const body = headline ?? (text == null ? null : cut(text, 80)) ?? title;
  const correction = candidate.infoRank === 2;
  return { domain: "earthquake-eew", level: levelOf(candidate), title: prefix + (correction ? `[訂正] ${title}` : title),
    body: correction ? `訂正: ${body}` : body };
}
// P3-NL-AC01: ID は世代番号を含まない。系列（現況か情報 subject）の印に同じ版の鍵と種類があれば作らない。
function intentsFor(candidate: NankaiCandidate, subject: string, transition: NankaiIntent["transition"], now: number,
  notice: Readonly<{ mark: NoticeMark | undefined; version: string }>, at: string | null = null): NankaiIntent[] {
  if (noticed(notice.mark, notice.version, noticeKind(transition))) return [];
  // P3-C8-TRAINING=A: training/test は desktop だけ。
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  const payload = payloadOf(candidate, at);
  const source = { ...candidate.source, subject };
  return channels.map((channel) => ({ id: noticeId("U-N", subject, "", source, transition, channel), unit: "U-N", subject,
    operation: candidate.operation, source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel], nextAttemptAt: now,
    attempts: 0, configRevision: SCHEMA, disposition: "pending", ...freshState("U-N", candidate.operation) }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-N の intent は全部 other の群（P3-C8-NOTICE-GROUP=A）。
function a7Order(left: NankaiIntent, right: NankaiIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// Q-NOTICE.capacity と P3-C8-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
function admit(current: readonly NankaiIntent[], fresh: readonly NankaiIntent[], cancelled: ReadonlySet<string>):
  Readonly<{ intents: readonly NankaiIntent[]; admitted: readonly NankaiIntent[]; dropped: number }> {
  const superseded = new Set<NankaiIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (cancelled.has(item.subject) || replaced.has(`${item.subject}\n${item.channel}`)) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => !superseded.has(item)), ...fresh];
  const out = new Set<NankaiIntent>();
  // 同じ群の中で A7 の選択順の後ろのものから外す。新しい intent が外れることもある（channel ごとに全採用か未採用）。
  let count = pool.length, size = listBytes(pool) + pool.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  if (count > PENDING_ITEMS || size > PENDING_BYTES)
    for (const item of [...pool].sort(a7Order).reverse()) {
      if (count <= PENDING_ITEMS && size <= PENDING_BYTES) break;
      out.add(item);
      count--;
      size -= bytes(item) + 1 + deliveryGrowth(item);
    }
  const admitted = fresh.filter((item) => !out.has(item));
  // P3-NL-AC05 (1)(2): 置換・退去した intent は外す（結果は系列の印に残り、終端記録の予算と回収は無い）。
  const intents = [...current.filter((item) => !superseded.has(item) && !out.has(item)), ...admitted];
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- outcome と view ----

function outcomeOf(value: Fact, changedFields: readonly string[] = []): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: isCurrent(value) ? currentFacts(value) : informationFacts(value), changedFields };
}
// view の subject は識別だけを持つ（見出しは currents・information にあり、二重に載せると snapshot の予算を食う。U-Q の先例）。
const outcomeCache = new WeakMap<Shown, SubjectOutcome>();
function shownOutcome(value: Fact): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = { ...outcomeOf(value), facts: { eventId: value.eventId, effective: value.effective,
      ...isCurrent(value) ? { line: value.line } : { family: value.family } } };
    outcomeCache.set(value, found);
  }
  return found;
}
function displaySubject(value: Fact): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-N" }>> {
  const current = isCurrent(value) ? value.effective === "active" ? shown(value) : null : value.effective === "active" ? headingOf(value) : null;
  return { unit: "U-N", operation: value.operation, subject: value.subject, office: null, current, subjects: [shownOutcome(value)] };
}

// ---- 採用（P3-C8-SUBJECTS=A。一入力の変更は一回の参照交換で確定する） ----

// held は手元の版を残して系列に印を付ける報（mark はこの後の印、missing は比べる時刻を欠く報、P3-VM-AC03・AC04）。
type Verdict<T> = Readonly<{ kind: "adopt"; next: T; missing: boolean }>
  | Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale"; held: Readonly<{ mark: ReportRef | null; missing: boolean }> | null }>;
function judge<T extends Fact>(candidate: NankaiCandidate, existing: Shown | null, next: T): Verdict<T> {
  // expired と証拠だけの記録は事実を持たないので、同じ版の再受信は事実を比べずに duplicate（食い違いの WARN を出さない）。ただし取消でない
  // 版への同じ時刻の取消は、expired でも勝つ（作者裁定 2026-10-21 昼）。証拠は InfoType だけを比べる。
  const version = stepVersion(existing == null ? null : { version: versionOf(existing), source: existing.effective === "evidence" ? null
    : existing.source, cancelled: existing.effective === "evidence" ? existing.evidence.infoTypeRaw === "取消" : existing.effective === "cancelled" },
  existing == null || existing.effective === "evidence" ? null : existing.unconfirmed ?? null, next.source,
  () => existing != null && (existing.effective === "evidence" ? existing.evidence.infoTypeRaw === next.source.infoTypeRaw
    : existing.effective === "expired" ? !candidate.cancelled || existing.source.infoTypeRaw === next.source.infoTypeRaw
      : existing.source.infoTypeRaw === next.source.infoTypeRaw && isDeepStrictEqual(withoutSource(existing), withoutSource(next))),
  candidate.cancelled);
  if (version.kind === "older" || version.kind === "duplicate")
    return { kind: "unchanged", reason: version.kind === "older" ? "stale" : "duplicate", held: null };
  if (version.kind === "held") return { kind: "unchanged", reason: "stale", held: version };
  return { kind: "adopt", next: version.mark == null ? next : { ...next, unconfirmed: version.mark }, missing: version.missing };
}
function heldDiagnostic(candidate: NankaiCandidate, missing: boolean): DiagnosticDetails {
  return { level: "WARN", component: "nankai", reason: missing ? "requiredStructureMissing" : "nankaiRevisionConflict",
    inputId: candidate.source.inputId, unit: "U-N" };
}
// 印を記録に当てる。現況の印は保存するので保存世代を進め、情報の印は保存しない（P3-VM-AC04、types.ts の注記）。
function holdState(state: NankaiUnitState, clock: ClockReading, subject: string, mark: ReportRef | null): NankaiUnitState {
  const marked = <T extends Shown>(values: readonly T[]): readonly T[] => {
    const at = indexOf(values, subject), found = values[at ?? -1];
    return found == null || mark == null || found.effective === "evidence" || found.unconfirmed === mark ? values
      : replaceAt(values, at, { ...found, unconfirmed: mark });
  };
  const currents = marked(state.currents), information = marked(state.information);
  return currents === state.currents && information === state.information ? state : { ...state, currents, information,
    persistence: currents === state.currents ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
}

function receiveCandidate(state: NankaiUnitState, candidate: NankaiCandidate, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const currentIndex = indexOf(state.currents, candidate.currentSubject);
  const current = currentIndex == null ? null : state.currents[currentIndex];
  const infoIndex = indexOf(state.information, candidate.subject);
  const info = infoIndex == null ? null : state.information[infoIndex];
  const decision = (subject: string, value: Verdict<Fact>, change: "semantic" | "revisionOnly"): Decision => value.kind === "unchanged"
    ? { subject, operation: candidate.operation, decision: "unchanged", reason: value.reason }
    : { subject, operation: candidate.operation, decision: "changed", reason: null, change,
      currentEstablished: { family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } };

  // 現況に効く報は、現況が採用したときだけ情報系列にも入る。現況が unchanged なら情報 subject も同じ reason（P3-C8-SUBJECTS=A）。
  // 除外の判定（affectsCurrent）は系統の watermark より先。現況に効く報でも、同じ報（headType・EventID）の情報 subject に新しい
  // 取消・訂正があれば現況へ当てない（取消が先着した古い元報で現況だけが戻らない、Q-C8-IMPL-AMEND(3)）。
  const affects = affectsCurrent(candidate, current);
  const infoVerdict = judge(candidate, info, informationOf(candidate));
  // 情報 subject が証拠だけ（再起動の後）で duplicate なら中身を比べていないので、現況は現況の版で判定する（P3-VM-AC03）。
  const unknownInfo = infoVerdict.kind === "unchanged" && infoVerdict.reason === "duplicate" && info?.effective === "evidence";
  const currentVerdict = !affects ? null : infoVerdict.kind === "unchanged" && !unknownInfo ? infoVerdict
    : judge(candidate, current, currentOf(candidate));
  // 印は手元の版を残した系列に付ける。現況に効く報を情報 subject で残したときは、現況の系列にも同じ報の印を付ける（情報の印は保存しない）。
  if (currentVerdict?.kind === "unchanged") {
    const held = currentVerdict.held, onInfo = currentVerdict === infoVerdict;
    const currentMark = !onInfo ? held?.mark ?? null : held?.mark == null || current == null ? null
      : nextMark(current.unconfirmed ?? null, { ...candidate.source, subject: candidate.currentSubject });
    const marked = held == null ? state : holdState(onInfo ? holdState(state, clock, candidate.subject, held.mark) : state, clock,
      candidate.currentSubject, currentMark);
    return { changes: [], step: { ...idle(marked),
      decisions: [decision(candidate.currentSubject, currentVerdict, "revisionOnly"), decision(candidate.subject, currentVerdict, "revisionOnly")],
      diagnostics: held == null ? [] : [heldDiagnostic(candidate, held.missing)] } };
  }
  if (currentVerdict == null && infoVerdict.kind === "unchanged") {
    const held = infoVerdict.held, marked = held == null ? state : holdState(state, clock, candidate.subject, held.mark);
    return { changes: [], step: { ...idle(marked), decisions: [decision(candidate.subject, infoVerdict, "revisionOnly")],
      diagnostics: held == null ? [] : [heldDiagnostic(candidate, held.missing)] } };
  }

  // P3-NL-AC02 (2)(4): 通知の印は系列の記録へ引き継ぐ（情報 subject は証拠だけの記録からも）。
  const adoptedCurrent = currentVerdict?.kind === "adopt" ? currentVerdict.next : null;
  const adoptedInfo = infoVerdict.kind === "adopt" ? infoVerdict.next : null;
  let nextCurrent = adoptedCurrent == null || current?.notice == null ? adoptedCurrent : { ...adoptedCurrent, notice: current.notice };
  let nextInfo = adoptedInfo == null || info?.notice == null ? adoptedInfo : { ...adoptedInfo, notice: info.notice };
  const currentFields = nextCurrent == null ? [] : visible(current) || visible(nextCurrent) ? changed(visible(current) ? current : null,
    nextCurrent, CURRENT_FIELDS) : [];
  const infoFields = nextInfo == null ? [] : visible(info) || visible(nextInfo) ? changed(visible(info) ? info : null,
    nextInfo, INFORMATION_FIELDS) : [];
  const currentSemantic = currentFields.length !== 0 || candidate.cancelled && visible(current);
  const infoSemantic = infoFields.length !== 0 || candidate.cancelled && visible(info);

  // Q-NOTICE.generationTable: 事実の変わった採用・訂正・取消の前に active だった対象の取消。期限で回収される報では作らない。
  const due = candidate.reportDateTimeMs + INFORMATION_RETAIN_MS <= now;
  // 到着の時点で期限を過ぎた記録の無い情報 subject は配列へ入れない。同じ reduce で回収される記録のために他の記録を退去しない
  // （P3-FINAL-AC01）。training/test の報で退去できる記録が無ければ、受けた情報 subject を残さない（自身の退去、P3-OPCAP-N-AC02）。
  // 通知の判定が自身の退去を見るので、置き場はその前に決める。
  const freshDue = due && infoIndex == null;
  let information = nextInfo == null || freshDue ? state.information : replaceAt(state.information, infoIndex, nextInfo);
  let evicted: NankaiInformation | null = null;
  let self = false;
  if (information.length > INFORMATION_LIMIT) {
    evicted = evictOne(state.information, now, candidate.operation);
    const gone = evicted;
    if (gone == null) { self = true; information = state.information; } else information = information.filter((item) => item !== gone);
  }
  // 復元の後は情報 subject が無いか証拠だけで、現況の source と同じ報の続報は復元した現況との差で決める
  // （Q-NOTICE.restart、Q-C8-IMPL-AMEND(4)、P3-AUTH-AC01(4)）。
  const restoredSource = nextCurrent != null && (info == null || info.effective === "evidence") && visible(current)
    && current?.source.family === candidate.family && current.eventId === candidate.eventId;
  // 自身を退去した情報 subject には通知を作らない。現況を採用したなら現況の通知は今どおり（P3-OPCAP-N-AC02）。
  const notify = !due && !(self && nextCurrent == null)
    // P3-NL-AC09 (1): 取消は active だったか、系列の印に通知の証拠があるとき（H19）。
    && (candidate.cancelled ? nextCurrent != null && (visible(current) || heard(current?.notice)) || nextInfo != null && (visible(info) || heard(info?.notice))
      : candidate.infoRank === 2 || (restoredSource ? currentFields.length !== 0 : nextInfo != null && infoFields.length !== 0));
  const subject = nextCurrent != null ? candidate.currentSubject : candidate.subject;
  const before = nextCurrent != null ? current : info;
  // 訂正は ended になっても updated（Q-NOTICE.transition の訂正の規則が先）。
  const transition = candidate.cancelled ? "cancelled" as const : candidate.infoRank === 2 ? "updated" as const
    : nextCurrent?.effective === "ended" ? "released" as const : visible(before) ? "updated" as const : "activated" as const;
  // 版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const version = versionDigest(candidate.source);
  const at = before == null ? null : "evidence" in before ? new Date(before.evidence.reportDateTimeMs).toISOString() : before.source.reportDateTimeRaw;
  const fresh = notify ? intentsFor(candidate, subject, transition, now, { mark: before?.notice, version }, at) : [];
  const cancelledSubjects = new Set(candidate.cancelled ? [...nextCurrent == null ? [] : [candidate.currentSubject],
    ...nextInfo == null ? [] : [candidate.subject]] : []);
  const notices = admit(state.intents, fresh, cancelledSubjects);
  // P3-NL-AC02 (3): admit を通った版と種類を、通知した系列（現況か情報 subject）の印に足す。
  if (notices.admitted.length !== 0) {
    const kind = noticeKind(transition);
    if (nextCurrent != null) nextCurrent = { ...nextCurrent, notice: markNotice(nextCurrent.notice, version, kind) };
    else if (nextInfo != null) {
      const original = nextInfo, marked = { ...original, notice: markNotice(original.notice, version, kind) };
      information = information.map((item) => item === original ? marked : item);
      nextInfo = marked;
    }
  }

  // 記録の無い現況も、到着の時点で保持の期限を過ぎていれば入れない（情報 subject と同じ、P3-FINAL-AC01(1)(5)）。
  const currentDue = nextCurrent != null && currentIndex == null && nextCurrent.retainUntil <= now;
  const currents = nextCurrent == null || currentDue ? state.currents : replaceAt(state.currents, currentIndex, nextCurrent);
  const draft: NankaiUnitState = { ...state, currents, information, intents: notices.intents };
  // 到着の時点で期限を過ぎた報は、記録のある subject なら採用して watermark を進め、同じ reduce で回収する（P3-C8-RETENTION=A）。
  const collecting = deadlineAt(draft) <= now;
  // 情報系列の変化は証拠が変わるので保存世代を進める。回収する reduce では回収の後の証拠で比べる（P3-AUTH-AC01(5)・P3-X-C3）。
  const persisted = currents !== state.currents || notices.intents !== state.intents || !collecting && information !== state.information;
  const adopted: NankaiUnitState = { ...draft, persistence: persisted ? dirty(state.persistence, clock.monotonicMs) : state.persistence };
  const collected = collecting ? collect(adopted, clock, state.information) : null;
  const next = collected?.state ?? adopted;
  const changes: Change[] = [];
  if (nextCurrent != null && !currentDue) changes.push([current, nextCurrent]);
  if (nextInfo != null && !freshDue && !self) changes.push([info, nextInfo]);
  if (evicted != null) changes.push([evicted, null]);
  // 結果は回収の後の記録で決める（D-OUTCOME=A・D-VANISHED=A、P3-FINAL-AC02）。最終の記録が無いか証拠だけなら accepted に載せず
  // currentEstablished も null。索引は回収のある reduce だけで引く（P3-FINAL-RES-01）。
  const settled = (before: Shown | null, proposed: Fact | null, added: boolean, values: readonly Shown[], fields: readonly string[]) => {
    if (proposed == null) return null;
    const found = !added ? null : collected == null ? proposed : values[indexOf(values, proposed.subject) ?? -1] ?? null;
    const last = found == null || found.effective === "evidence" ? null : found;
    const diff = last == null ? visible(before) ? ["effective"] : []
      : visible(before) || visible(last) ? changed<Shown>(visible(before) ? before : null, last, fields) : [];
    return { last, diff, semantic: diff.length !== 0 || candidate.cancelled && visible(before) };
  };
  const finalCurrent = settled(current, nextCurrent, !currentDue, next.currents, CURRENT_FIELDS);
  const finalInfo = settled(info, nextInfo, !freshDue && !self, next.information, INFORMATION_FIELDS);
  const diagnostics: DiagnosticDetails[] = [];
  if (evicted != null || self) diagnostics.push({ level: "INFO", component: "nankai", reason: "nankaiCapacityEvicted", unit: "U-N", count: 1 });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "nankai", reason: "notificationCapacityEvicted",
    unit: "U-N", count: notices.dropped });
  if ([currentVerdict, infoVerdict].some((item) => item?.kind === "adopt" && item.missing))
    diagnostics.push(heldDiagnostic(candidate, true));
  const decisions: Decision[] = [];
  const final = (subject: string, value: Verdict<Fact>, settledValue: ReturnType<typeof settled>): Decision => {
    const made = decision(subject, value, settledValue?.semantic ? "semantic" : "revisionOnly");
    return made.decision === "changed" && settledValue != null && settledValue.last == null ? { ...made, currentEstablished: null } : made;
  };
  if (currentVerdict != null) decisions.push(final(candidate.currentSubject, currentVerdict, finalCurrent));
  decisions.push(final(candidate.subject, infoVerdict, finalInfo));
  const change = finalCurrent?.semantic || finalInfo?.semantic || evicted != null ? "semantic" as const : "revisionOnly" as const;
  return {
    changes: [...changes, ...collected?.changes ?? []],
    step: { state: next, nextDeadline: nextDeadline(next), decisions, intents: notices.admitted,
      outcomes: [{ kind: "accepted", change, subjects: [finalCurrent, finalInfo].flatMap((item) => item?.last == null ? []
        : [outcomeOf(item.last, item.diff)]) }],
      diagnostics },
  };
}

// ---- 期限（I-U-N.deadlines。到来分だけを回収する） ----

// 記録は不変で、変化は差し替えなので、同じ記録の並びなら証拠の射影も同じ（64 件の参照の比較）。
const sameItems = (left: readonly object[], right: readonly object[]) => left === right
  || left.length === right.length && left.every((item, at) => item === right[at]);
// base は情報系列の変化を比べる前の並び（受信と同じ reduce の回収では受信の前の並び）。
// ponytail: 現況 6・情報 64 の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: NankaiUnitState, clock: ClockReading, base = state.information): Readonly<{ state: NankaiUnitState;
  changes: readonly Change[]; expiredIntents: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0 };
  const changes: Change[] = [];
  const currents = minOf(state.currents, currentDeadline) > now ? state.currents : state.currents.flatMap((item): NankaiCurrent[] => {
    if (item.retainUntil <= now) { changes.push([item, null]); return []; }
    if (item.effective !== "active" || item.validUntil > now) return [item];
    // (6): validUntil の到来で expired（事実を捨てる。通知しない、P3-C8-CURRENT-EXPIRY=A）。
    const base = { subject: item.subject, operation: item.operation, eventId: item.eventId, source: item.source, retainUntil: item.retainUntil };
    const after: NankaiCurrent = item.line === "VYSE60" ? { ...base, line: "VYSE60", effective: "expired" }
      : { ...base, line: "nankai", effective: "expired" };
    changes.push([item, after]);
    return [after];
  });
  const information = minOf(state.information, (item) => item.retainUntil) > now ? state.information
    : state.information.filter((item) => {
      if (item.retainUntil > now) return true;
      changes.push([item, null]);
      return false;
    });
  const intents = minOf(state.intents, (item) => item.expiresAt) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - intents.length;
  const persisted = currents !== state.currents || intents !== state.intents || !sameItems(information, base);
  return { state: { ...state, currents, information, intents,
    persistence: persisted ? dirty(state.persistence, clock.monotonicMs) : state.persistence }, changes, expiredIntents };
}

function deadlineStep(state: NankaiUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock);
  const subjects = applied.changes.flatMap(([before, after]) => after == null || !visible(before) || after.effective === "evidence" ? []
    : [outcomeOf(after, ["effective"])]);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "nankai",
    reason: "notificationExpired", unit: "U-N", count: applied.expiredIntents }];
  return { changes: applied.changes, step: { ...idle(applied.state),
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects }]
      : subjects.length === 0 ? [] : [{ kind: "deadlineApplied", subjects }],
    diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

// P3-NL-AC02 (3)・AC08 (1): intent の系列（現況か情報 subject）の印の証拠を上げる（下げない）。
function raiseNotices(state: NankaiUnitState, raised: ReadonlyMap<string, NoticeEvidence>): NankaiUnitState {
  const raise = <T extends Shown>(values: readonly T[]): readonly T[] => {
    let next = values;
    for (const [subject, evidence] of raised) {
      const at = indexOf(next, subject), found = next[at ?? -1];
      const notice = found?.notice == null ? undefined : raiseEvidence(found.notice, evidence);
      if (found != null && notice !== found.notice) next = replaceAt(next, at, { ...found, notice });
    }
    return next;
  };
  const currents = raise(state.currents), information = raise(state.information);
  return currents === state.currents && information === state.information ? state : { ...state, currents, information };
}

function intentUpdate(state: NankaiUnitState, input: Extract<NankaiInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, NankaiIntent>();
  const raised = new Map<string, NoticeEvidence>();
  for (const update of updates) {
    const current = originals.get(update.id);
    const updated = current == null ? null : applyIntentUpdate(current, update);
    if (updated == null) continue;
    changedIntents.set(updated.id, updated);
    const evidence = updateEvidence(updated);
    if (evidence != null) raised.set(updated.subject, evidence);
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7 の先例）。pending でなくなった intent は外す（P3-NL-AC05 (1)）。
  const next = { ...raiseNotices(state, raised), intents: state.intents.flatMap((item) => {
    const updated = changedIntents.get(item.id);
    return updated == null ? [item] : updated.disposition === "pending" ? [updated] : [];
  }), persistence: dirty(state.persistence, input.clock.monotonicMs) };
  const adopted = [...changedIntents.values()];
  return { changes: [], step: { ...idle(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "deliveryOnly" as const, currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted" as const, change: "deliveryOnly" as const, subjects: [{ subject: item.subject,
      operation: item.operation, informationType: item.source.infoTypeRaw, transition: item.disposition, severity: null,
      source: item.source, facts: { intentId: item.id, channel: item.channel }, changedFields: ["intents"] }] })) } };
}

function restore(state: NankaiUnitState, persisted: PersistedNankaiUnit, clock: ClockReading): Result {
  const decoded = nankaiUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "nankai",
    reason: "requiredStructureInvalid", unit: "U-N" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。情報系列は証拠だけの記録から始まる。
  // P3-NL-AC08 (1): started のまま残った pending は通知したか不明として外し、系列の印の証拠を unknown にする。
  const restored = restoreStarted(decoded.state.intents);
  const base = { ...raiseNotices(decoded.state, new Map(restored.started.map((item) => [item.subject, "unknown" as const]))),
    intents: restored.intents, persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const applied = collect(base, clock);
  const active = applied.state.currents.filter(visible);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "nankai",
    reason: "notificationExpired", unit: "U-N", count: applied.expiredIntents }];
  if (restored.started.length !== 0) diagnostics.push({ level: "INFO", component: "nankai", reason: "notificationOutcomeUnknown",
    unit: "U-N", count: restored.started.length });
  return { changes: active.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-N"], coverage: active.map((item) => item.subject), subjects: [] }], diagnostics } };
}

function receive(state: NankaiUnitState, input: Extract<NankaiInput, { kind: "receive" }>): Result {
  const parsed = parseNankai(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C8-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  return receiveCandidate(state, candidate, input.clock);
}

function reduceCore(state: NankaiUnitState, input: NankaiInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, false);
    case "shutdown": return deadlineStep(state, input.clock, true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`nankai input ${String(missing)} is not handled`); }
  }
}

function reduceNankaiUnit(state: NankaiUnitState, input: NankaiInput): NankaiUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: Shown | null; after: Shown | null }>();
  for (const [before, after] of changes) {
    const key = (after ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: NankaiUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-N", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-N content revision exhausted");
  // P3-C8-N2: U-N は確認 scope を作らない。
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toNankaiView(state: NankaiUnitState): NankaiUnitView {
  const currents = state.currents.filter((item): item is ActiveCurrent => item.effective === "active");
  const shownInformation = state.information.filter((item): item is ActiveInformation => item.effective === "active");
  const subjects = [...currents, ...shownInformation].map(shownOutcome);
  return { unit: "U-N", semanticRevision: subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`).sort().join("|"),
  contentRevision: String(state.contentRevision), subjects, currents: currents.map((item) => shown(item)),
  information: shownInformation.map(headingOf) };
}

// ---- codec（I-U-N.persisted・I-U-N.decode、唯一の NankaiUnitCodec） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const bounded = (value: unknown, limit: number): value is string => isText(value) && value.length <= limit;
const boundedOrNull = (value: unknown, limit: number): value is string | null => value === null || bounded(value, limit);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}
const familyOf = (value: unknown): NankaiReportFamily | null => FAMILIES.find((item) => item === value) ?? null;
const lineOf = (value: unknown): NankaiCurrentLine | null => LINES.find((item) => item === value) ?? null;
// subject は現況（`${operation}/${line}/current`）か情報（`${operation}/${family}/${eventId}`、Q-ENUM.identity の EventID）。
function subjectOperation(subject: string, family: NankaiReportFamily): Operation | null {
  const [operation, middle, last, ...rest] = subject.split("/");
  const op = operationOf(operation);
  if (op == null || rest.length !== 0 || last == null) return null;
  return lineOf(middle) != null && last === "current" || middle === family && validEventId(last) ? op : null;
}
function reportRef(value: unknown): ReportRef | null {
  const ref = readReportRef(value, LIMITS.controlDateTime), family = familyOf(ref?.family);
  return ref == null || family == null || !bounded(ref.reportDateTimeRaw, LIMITS.reportDateTime)
    || !Number.isFinite(Date.parse(ref.reportDateTimeRaw)) || !validSerial(ref.serialRaw) || !INFO_RANK.has(ref.infoTypeRaw)
    || subjectOperation(ref.subject, family) !== ref.operation ? null : ref;
}
function infoSerial(value: unknown): NankaiInfoSerial | null | "invalid" {
  if (value === null) return null;
  const row = record(value);
  return row == null || !bounded(row.code, BOUNDS.code) || !boundedOrNull(row.name, BOUNDS.name) ? "invalid" : { code: row.code, name: row.name };
}
const FACT_KEYS = ["status", "infoSerial", "title", "headline", "truncated", "validUntil"] as const;
function currentRecord(value: unknown): NankaiCurrent | null {
  const row = record(value);
  const operation = operationOf(row?.operation), line = lineOf(row?.line), source = reportRef(row?.source);
  if (row == null || operation == null || line == null || source == null || !isText(row.eventId) || !validEventId(row.eventId)
    || row.subject !== `${operation}/${line}/current` || source.subject !== row.subject || (source.family === "VYSE60") !== (line === "VYSE60")
    || row.retainUntil !== reportMs(source) + CURRENT_RETAIN_MS) return null;
  // P3-VM-AC04: 印は同じ系統（subject・operation）の報（取消の後の時刻の無い報の印も残る）。
  const mark = "unconfirmed" in row ? reportRef(row.unconfirmed) : undefined;
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (mark === null || notice === null || mark != null && (mark.subject !== row.subject
    || mark.operation !== operation)) return null;
  const base = { subject: row.subject, operation, eventId: row.eventId, source, retainUntil: row.retainUntil, ...mark == null ? {} : { unconfirmed: mark },
    ...notice == null ? {} : { notice } };
  if (row.effective !== "active") {
    // active 以外は事実を持たない（types.ts の判別共用体）。ended は南海トラフの系統だけ。
    if (FACT_KEYS.some((key) => key in row)) return null;
    if (line === "VYSE60") return row.effective === "cancelled" || row.effective === "expired" ? { ...base, line, effective: row.effective } : null;
    return row.effective === "ended" || row.effective === "cancelled" || row.effective === "expired" ? { ...base, line, effective: row.effective } : null;
  }
  const serial = infoSerial(row.infoSerial);
  if (serial === "invalid" || !bounded(row.title, BOUNDS.title) || !boundedOrNull(row.headline, BOUNDS.headline)
    || typeof row.truncated !== "boolean" || row.validUntil !== reportMs(source) + CURRENT_VALID_MS) return null;
  const facts = { effective: "active" as const, infoSerial: serial, title: row.title, headline: row.headline, truncated: row.truncated,
    validUntil: row.validUntil };
  if (line === "VYSE60") return row.status === "subsequentAdvisory" ? { ...base, line, status: row.status, ...facts } : null;
  const status = STATUSES.nankai.find((item): item is NankaiCurrentStatus => item === row.status);
  return status == null ? null : { ...base, line, status, ...facts };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): NankaiIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-N", operation, level);
  // state に残る subject との一致は求めない（情報の事実は復元されない、I-U-N.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || fields == null || !isText(row.id) || row.unit !== "U-N" || !isText(row.subject) || source.subject !== row.subject
    || source.operation !== operation || payload.domain !== "earthquake-eew" || !isText(payload.title) || payload.title === ""
    || !isText(payload.body) || payload.body === "" || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt)
    || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0 || !isText(row.configRevision) || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-N", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "earthquake-eew", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition: "pending", ...fields };
}
// 証拠を証拠だけの情報 subject として戻す（P3-AUTH-AC01(2)）。印は記録へ戻す（P3-NL-AC02 (2)）。
function evidenceRecord(value: unknown): EvidenceInformation | null {
  const row = record(value);
  if (row == null || !isText(row.subject) || typeof row.reportDateTimeMs !== "number" || !Number.isSafeInteger(row.reportDateTimeMs)
    || !isText(row.serialRaw) || !validSerial(row.serialRaw) || !isText(row.infoTypeRaw) || !INFO_RANK.has(row.infoTypeRaw)
    || !isText(row.controlDateTimeRaw) || controlDateTimeOf(row.controlDateTimeRaw, LIMITS.controlDateTime) !== row.controlDateTimeRaw) return null;
  const [, middle, eventId] = row.subject.split("/");
  const family = familyOf(middle), operation = family == null ? null : subjectOperation(row.subject, family);
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (family == null || operation == null || eventId == null || notice === null) return null;
  const evidence = { subject: row.subject, reportDateTimeMs: row.reportDateTimeMs, serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw,
    controlDateTimeRaw: row.controlDateTimeRaw };
  return { subject: row.subject, family, eventId, operation, retainUntil: row.reportDateTimeMs + INFORMATION_RETAIN_MS, effective: "evidence",
    evidence, ...notice == null ? {} : { notice } };
}
// encode の証拠の射影は記録ごとに一度だけ作る（P3-AUTH-RES-03）。印は記録の notice を写す（P3-NL-AC02 (2)）。
const evidenceCache = new WeakMap<NankaiInformation, NankaiEvidence>();
function evidenceOf(value: NankaiInformation): NankaiEvidence {
  if (value.effective === "evidence" && value.notice == null) return value.evidence;
  let found = evidenceCache.get(value);
  if (found == null) {
    const notice = value.notice == null ? {} : { notice: value.notice };
    found = value.effective === "evidence" ? { ...value.evidence, ...notice } : { subject: value.subject, reportDateTimeMs: reportMs(value.source),
      serialRaw: value.source.serialRaw, infoTypeRaw: value.source.infoTypeRaw, controlDateTimeRaw: value.source.controlDateTimeRaw, ...notice };
    evidenceCache.set(value, found);
  }
  return found;
}
type Decoded = Readonly<{ currents: readonly NankaiCurrent[]; intents: readonly NankaiIntent[]; information: readonly EvidenceInformation[] }>;
function persisted(value: unknown): Decoded | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord), intents = list(row.intents, intentRecord);
  // 鍵の無い保存物は invalid（移行 A1 の旧保存は版で捨てる、P3-VM-AC08）。
  const information = list(row.evidence, evidenceRecord);
  if (currents == null || intents == null || information == null || currents.length > CURRENT_LIMIT || information.length > INFORMATION_LIMIT
    || new Set(currents.map((entry) => entry.subject)).size !== currents.length
    || new Set(information.map((entry) => entry.subject)).size !== information.length
    || new Set(intents.map((entry) => entry.id)).size !== intents.length) return null;
  // 受理と同じ式（実 byte＋配送の更新の予約）で数える（Q-C8-IMPL-AMEND(7)(8)）。保存する intent は pending だけ（P3-NL-AC05）。
  const pendingBytes = listBytes(intents) + intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  if (intents.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES
    || generationBytes(currents, intents, information.map(evidenceOf)) > GENERATION_LIMIT) return null;
  return { currents, intents, information };
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const nankaiUnitCodec: NankaiUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p3-nankai-unit-v1", "p3-nankai-unit-v2", "p3-nankai-unit-v3"], maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  // 情報の事実・contentRevision・persistence は保存しない（I-U-N.persisted、spec:512 の N）。証拠は保存する（P3-AUTH-AC01）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents, evidence: state.information.map(evidenceOf) }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-nankai-unit-v4 payload" }
      : { kind: "restored", state: { schemaVersion: SCHEMA, ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-N.runtimeRows）。
const nankaiUnit = {
  unit: "U-N",
  reduce: reduceNankaiUnit,
  toView: toNankaiView,
  persistence: { kind: "durable", codec: nankaiUnitCodec },
  confirmationScopeLimit: 512,
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-N">;

export { nankaiUnit, nankaiUnitCodec, reduceNankaiUnit, toNankaiView };
