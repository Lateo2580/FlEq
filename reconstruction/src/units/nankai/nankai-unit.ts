import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline,
  SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  NankaiCurrent, NankaiCurrentLine, NankaiCurrentStatus, NankaiInfoSerial, NankaiInformation, NankaiInformationView, NankaiInput,
  NankaiIntent, NankaiNotificationPayload, NankaiReportFamily, NankaiUnitCodec, NankaiUnitState, NankaiUnitStep, NankaiUnitView,
  PersistedNankaiUnit,
} from "../../../contracts/p3-nankai-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { BOUNDS, FAMILIES, INFO_RANK, LIMITS, parseNankai, validEventId, validSerial } from "../../domains/nankai/nankai";
import type { NankaiCandidate } from "../../domains/nankai/nankai";

// P3-UNIT-N-001（C8、I-U-N）: U-N の現況・情報系列・通知・容量・codec・射影。

const SCHEMA = "p3-nankai-unit-v1" as const;
const OPERATIONS = ["normal", "training", "test"] as const;
const LINES = ["nankai", "VYSE60"] as const;
// P3-C8-CAPACITY=A・P3-C8-RES-01・RET-01〜04。
const CURRENT_LIMIT = 6, INFORMATION_LIMIT = 64, GENERATION_LIMIT = 262_144;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 98_304;
// P3-C8-SEM-01〜05（元報の ReportDateTime からの絶対の長さ、P3-C8-RETENTION=A）。
const DAY_MS = 86_400_000;
const CURRENT_VALID_MS = 7 * DAY_MS, CURRENT_RETAIN_MS = 30 * DAY_MS, INFORMATION_RETAIN_MS = 7 * DAY_MS;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const STATUSES: Readonly<Record<NankaiCurrentLine, readonly string[]>> = {
  nankai: ["investigating", "megaquakeWarning", "megaquakeAdvisory"], VYSE60: ["subsequentAdvisory"] };

type ActiveCurrent = Extract<NankaiCurrent, Readonly<{ effective: "active" }>>;
type ActiveInformation = Extract<NankaiInformation, Readonly<{ effective: "active" }>>;
type Shown = NankaiCurrent | NankaiInformation;
type Level = NankaiNotificationPayload["level"];
type InternalStep = Omit<NankaiUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = NankaiUnitStep["decisions"][number];
type Change = readonly [before: Shown | null, after: Shown | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;

const isCurrent = (value: Shown): value is NankaiCurrent => "line" in value;
const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
const visible = (value: Shown | null): boolean => value?.effective === "active";

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
// 終端記録の合計（区切りの 1 byte を含む）。受理と decode で同じ式を使う（I-U-N.capacityReserve）。
const terminalCache = new WeakMap<readonly NankaiIntent[], number>();
function terminalBytes(intents: readonly NankaiIntent[]): number {
  let total = terminalCache.get(intents);
  if (total == null) {
    total = intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
    terminalCache.set(intents, total);
  }
  return total;
}
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-N", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T・U-Q と同じ予約）。4: 空の配列 2 つ。
function generationBytes(currents: readonly NankaiCurrent[], intents: readonly NankaiIntent[]): number {
  return emptyEnvelopeBytes + 62 - 4 + listBytes(currents) + listBytes(intents);
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

// ReportDateTime、同時刻で同じ EventID の両方に Serial があれば Serial、なお同じなら InfoType の優先。
function compare(candidate: NankaiCandidate, source: ReportRef, eventId: string): number {
  const time = candidate.reportDateTimeMs - reportMs(source);
  if (time !== 0) return Math.sign(time);
  const left = candidate.source.serialRaw, right = source.serialRaw;
  const serial = candidate.eventId === eventId && left !== "" && right !== "" ? Number(left) - Number(right) : 0;
  if (serial !== 0) return Math.sign(serial);
  return Math.sign(candidate.infoRank - (INFO_RANK.get(source.infoTypeRaw) ?? 0)) * 2;
}
const withoutSource = (value: Shown) => ({ ...value, source: null });

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

function informationOf(candidate: NankaiCandidate): NankaiInformation {
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
    const { text: _text, nextAdvisory: _next, ...heading } = value;
    found = heading;
    headingCache.set(value, found);
  }
  return found;
}
function informationFacts(value: NankaiInformation | null): Readonly<Record<string, JsonValue>> {
  if (value == null) return {};
  return value.effective === "active" ? headingOf(value) : { family: value.family, eventId: value.eventId, effective: value.effective };
}

// P3-C8-CAPACITY=A: 65 件目は (1) retainUntil を過ぎたもの (2) training/test (3) normal の最古（ReportDateTime 順）から 1 件退去する。
// ponytail: 64 件の一回の走査（上限は INFORMATION_LIMIT と復元の空で効く）。
function evictOne(information: readonly NankaiInformation[], now: number): NankaiInformation {
  const tier = (item: NankaiInformation) => item.retainUntil <= now ? 0 : item.operation !== "normal" ? 1 : 2;
  let worst = information[0];
  for (const item of information) {
    const order = tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
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
function payloadOf(candidate: NankaiCandidate): NankaiNotificationPayload {
  const prefix = PREFIX[candidate.operation], { title, headline, text } = candidate.facts;
  if (candidate.cancelled) return { domain: "earthquake-eew", level: "cancel", title: `${prefix}[取消] ${title}`, body: "この情報は取り消されました" };
  const body = headline ?? (text == null ? null : text.slice(0, 80)) ?? title;
  const correction = candidate.infoRank === 2;
  return { domain: "earthquake-eew", level: levelOf(candidate), title: prefix + (correction ? `[訂正] ${title}` : title),
    body: correction ? `訂正: ${body}` : body };
}
function intentsFor(candidate: NankaiCandidate, subject: string, transition: NankaiIntent["transition"], generation: number,
  now: number): NankaiIntent[] {
  // P3-C8-TRAINING=A: training/test は desktop だけ。
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  const payload = payloadOf(candidate);
  const source = { ...candidate.source, subject };
  return channels.map((channel) => ({ id: `U-N:${subject}:${generation}:${channel}`, unit: "U-N", subject, operation: candidate.operation,
    source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0,
    configRevision: SCHEMA, disposition: "pending" }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-N の intent は全部 other の群（P3-C8-NOTICE-GROUP=A）。
function a7Order(left: NankaiIntent, right: NankaiIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 終端記録の合計が 98,304 byte を超える分は、最古の終端記録から期限前に回収する（未知 id の更新は no-op なので通知は変わらない）。
// kept は今の配送の更新で終端にした記録で、回収しない（owner は更新した記録が残ることで照合する。Q-C8-IMPL-AMEND(1)）。
// kept だけで上限を超える分は、元の pending の byte の内側なので pending と終端記録の合計の上限に収まる。
function trimTerminal(intents: readonly NankaiIntent[], kept: ReadonlySet<string> = new Set()): readonly NankaiIntent[] {
  let terminal = terminalBytes(intents);
  if (terminal <= TERMINAL_BYTES) return intents;
  const gone = new Set<NankaiIntent>();
  for (const item of intents.filter((value) => value.disposition !== "pending" && !kept.has(value.id))
    .sort((left, right) => left.createdAt - right.createdAt)) {
    if (terminal <= TERMINAL_BYTES) break;
    gone.add(item);
    terminal -= bytes(item) + 1;
  }
  return intents.filter((item) => !gone.has(item));
}
// Q-NOTICE.capacity と P3-C8-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
function admit(current: readonly NankaiIntent[], fresh: readonly NankaiIntent[], cancelled: ReadonlySet<string>):
  Readonly<{ intents: readonly NankaiIntent[]; admitted: readonly NankaiIntent[]; dropped: number }> {
  const superseded = new Set<NankaiIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.disposition === "pending" && (cancelled.has(item.subject) || replaced.has(`${item.subject}\n${item.channel}`))) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
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
  const intents = trimTerminal([...current.map((item) => superseded.has(item) || out.has(item)
    ? { ...item, disposition: "superseded" as const } : item), ...admitted]);
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- outcome と view ----

function outcomeOf(value: Shown, changedFields: readonly string[] = []): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: isCurrent(value) ? currentFacts(value) : informationFacts(value), changedFields };
}
// view の subject は識別だけを持つ（見出しは currents・information にあり、二重に載せると snapshot の予算を食う。U-Q の先例）。
const outcomeCache = new WeakMap<Shown, SubjectOutcome>();
function shownOutcome(value: Shown): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = { ...outcomeOf(value), facts: { eventId: value.eventId, effective: value.effective,
      ...isCurrent(value) ? { line: value.line } : { family: value.family } } };
    outcomeCache.set(value, found);
  }
  return found;
}
function displaySubject(value: Shown): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-N" }>> {
  const current = isCurrent(value) ? value.effective === "active" ? value : null : value.effective === "active" ? headingOf(value) : null;
  return { unit: "U-N", operation: value.operation, subject: value.subject, office: null, current, subjects: [shownOutcome(value)] };
}

// ---- 採用（P3-C8-SUBJECTS=A。一入力の変更は一回の参照交換で確定する） ----

type Verdict<T> = Readonly<{ kind: "adopt"; next: T; order: number }> | Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale";
  conflict: boolean }>;
function judge<T extends Shown>(candidate: NankaiCandidate, existing: T | null, next: T): Verdict<T> {
  if (existing == null) return { kind: "adopt", next, order: 1 };
  const order = compare(candidate, existing.source, existing.eventId);
  if (order < 0) return { kind: "unchanged", reason: "stale", conflict: false };
  // expired は事実を捨てた記録なので、同じ revision の再受信は事実を比べずに duplicate（食い違いの WARN を出さない）。
  if (order === 0) return existing.effective === "expired" || isDeepStrictEqual(withoutSource(existing), withoutSource(next))
    ? { kind: "unchanged", reason: "duplicate", conflict: false } : { kind: "unchanged", reason: "stale", conflict: true };
  return { kind: "adopt", next, order };
}
function conflictDiagnostic(candidate: NankaiCandidate): DiagnosticDetails {
  return { level: "WARN", component: "nankai", reason: "nankaiRevisionConflict", inputId: candidate.source.inputId, unit: "U-N" };
}

function receiveCandidate(state: NankaiUnitState, candidate: NankaiCandidate, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const currentIndex = indexOf(state.currents, candidate.currentSubject);
  const current = currentIndex == null ? null : state.currents[currentIndex];
  const infoIndex = indexOf(state.information, candidate.subject);
  const info = infoIndex == null ? null : state.information[infoIndex];
  const decision = (subject: string, value: Verdict<Shown>, change: "semantic" | "revisionOnly"): Decision => value.kind === "unchanged"
    ? { subject, operation: candidate.operation, decision: "unchanged", reason: value.reason }
    : { subject, operation: candidate.operation, decision: "changed", reason: null, change,
      currentEstablished: { family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } };

  // 現況に効く報は、現況が採用したときだけ情報系列にも入る。現況が unchanged なら情報 subject も同じ reason（P3-C8-SUBJECTS=A）。
  // 除外の判定（affectsCurrent）は系統の watermark より先。現況に効く報でも、同じ報（headType・EventID）の情報 subject に新しい
  // 取消・訂正があれば現況へ当てない（取消が先着した古い元報で現況だけが戻らない、Q-C8-IMPL-AMEND(3)）。
  const affects = affectsCurrent(candidate, current);
  const infoVerdict = judge<NankaiInformation>(candidate, info, informationOf(candidate));
  const currentVerdict = !affects ? null : infoVerdict.kind === "unchanged" ? infoVerdict
    : judge<NankaiCurrent>(candidate, current, currentOf(candidate));
  if (currentVerdict?.kind === "unchanged") return { changes: [], step: { ...idle(state),
    decisions: [decision(candidate.currentSubject, currentVerdict, "revisionOnly"), decision(candidate.subject, currentVerdict, "revisionOnly")],
    diagnostics: currentVerdict.conflict ? [conflictDiagnostic(candidate)] : [] } };
  if (currentVerdict == null && infoVerdict.kind === "unchanged") return { changes: [], step: { ...idle(state),
    decisions: [decision(candidate.subject, infoVerdict, "revisionOnly")],
    diagnostics: infoVerdict.conflict ? [conflictDiagnostic(candidate)] : [] } };

  const nextCurrent = currentVerdict?.kind === "adopt" ? currentVerdict.next : null;
  const nextInfo = infoVerdict.kind === "adopt" ? infoVerdict.next : null;
  const currentFields = nextCurrent == null ? [] : visible(current) || visible(nextCurrent) ? changed(visible(current) ? current : null,
    nextCurrent, CURRENT_FIELDS) : [];
  const infoFields = nextInfo == null ? [] : visible(info) || visible(nextInfo) ? changed(visible(info) ? info : null,
    nextInfo, INFORMATION_FIELDS) : [];
  const currentSemantic = currentFields.length !== 0 || candidate.cancelled && visible(current);
  const infoSemantic = infoFields.length !== 0 || candidate.cancelled && visible(info);

  // Q-NOTICE.generationTable: 事実の変わった採用・訂正・取消の前に active だった対象の取消。期限で回収される報では作らない。
  const due = candidate.reportDateTimeMs + INFORMATION_RETAIN_MS <= now;
  // 復元の後は情報系列が空で、現況の source と同じ報の続報でも情報 subject が新規になる。そのときは復元した現況との差で決める
  // （Q-NOTICE.restart、Q-C8-IMPL-AMEND(4)）。
  const restoredSource = nextCurrent != null && info == null && visible(current) && current?.source.family === candidate.family
    && current.eventId === candidate.eventId;
  const notify = !due && (candidate.cancelled ? nextCurrent != null && visible(current) || nextInfo != null && visible(info)
    : candidate.infoRank === 2 || (restoredSource ? currentFields.length !== 0 : nextInfo != null && infoFields.length !== 0));
  const subject = nextCurrent != null ? candidate.currentSubject : candidate.subject;
  const before = nextCurrent != null ? current : info;
  // 訂正は ended になっても updated（Q-NOTICE.transition の訂正の規則が先）。
  const transition = candidate.cancelled ? "cancelled" as const : candidate.infoRank === 2 ? "updated" as const
    : nextCurrent?.effective === "ended" ? "released" as const : visible(before) ? "updated" as const : "activated" as const;
  const fresh = notify ? intentsFor(candidate, subject, transition, state.persistence.currentGeneration + 1, now) : [];
  const cancelledSubjects = new Set(candidate.cancelled ? [...nextCurrent == null ? [] : [candidate.currentSubject],
    ...nextInfo == null ? [] : [candidate.subject]] : []);
  const notices = admit(state.intents, fresh, cancelledSubjects);

  let information = nextInfo == null ? state.information : replaceAt(state.information, infoIndex, nextInfo);
  let evicted: NankaiInformation | null = null;
  if (information.length > INFORMATION_LIMIT) {
    evicted = evictOne(state.information, now);
    const gone = evicted;
    information = information.filter((item) => item !== gone);
  }
  const currents = nextCurrent == null ? state.currents : replaceAt(state.currents, currentIndex, nextCurrent);
  // 保存しない情報系列だけの変化では保存世代を進めない（I-U-N.persisted）。
  const persisted = currents !== state.currents || notices.intents !== state.intents;
  const adopted: NankaiUnitState = { ...state, currents, information, intents: notices.intents,
    persistence: persisted ? dirty(state.persistence, clock.monotonicMs) : state.persistence };
  // 到着の時点で期限を過ぎた報は採用して watermark を進め、同じ reduce で回収する（P3-C8-RETENTION=A）。
  const collected = deadlineAt(adopted) <= now ? collect(adopted, clock) : null;
  const next = collected?.state ?? adopted;
  const changes: Change[] = [];
  if (nextCurrent != null) changes.push([current, nextCurrent]);
  if (nextInfo != null) changes.push([info, nextInfo]);
  if (evicted != null) changes.push([evicted, null]);
  const diagnostics: DiagnosticDetails[] = [];
  if (evicted != null) diagnostics.push({ level: "INFO", component: "nankai", reason: "nankaiCapacityEvicted", unit: "U-N", count: 1 });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "nankai", reason: "notificationCapacityEvicted",
    unit: "U-N", count: notices.dropped });
  if (infoVerdict.kind === "unchanged" && infoVerdict.conflict) diagnostics.push(conflictDiagnostic(candidate));
  const decisions: Decision[] = [];
  if (currentVerdict != null) decisions.push(decision(candidate.currentSubject, currentVerdict, currentSemantic ? "semantic" : "revisionOnly"));
  decisions.push(decision(candidate.subject, infoVerdict, infoSemantic ? "semantic" : "revisionOnly"));
  const change = currentSemantic || infoSemantic || evicted != null ? "semantic" as const : "revisionOnly" as const;
  return {
    changes: [...changes, ...collected?.changes ?? []],
    step: { state: next, nextDeadline: nextDeadline(next), decisions, intents: notices.admitted,
      outcomes: [{ kind: "accepted", change, subjects: [...nextCurrent == null ? [] : [outcomeOf(nextCurrent, currentFields)],
        ...nextInfo == null ? [] : [outcomeOf(nextInfo, infoFields)]] }],
      diagnostics },
  };
}

// ---- 期限（I-U-N.deadlines。到来分だけを回収する） ----

// ponytail: 現況 6・情報 64 の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: NankaiUnitState, clock: ClockReading): Readonly<{ state: NankaiUnitState; changes: readonly Change[];
  expiredIntents: number }> {
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
  const expiredIntents = intents === state.intents ? 0
    : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  const persisted = currents !== state.currents || intents !== state.intents;
  return { state: { ...state, currents, information, intents,
    persistence: persisted ? dirty(state.persistence, clock.monotonicMs) : state.persistence }, changes, expiredIntents };
}

function deadlineStep(state: NankaiUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock);
  const subjects = applied.changes.flatMap(([before, after]) => after == null || !visible(before) ? [] : [outcomeOf(after, ["effective"])]);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "nankai",
    reason: "notificationExpired", unit: "U-N", count: applied.expiredIntents }];
  return { changes: applied.changes, step: { ...idle(applied.state),
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects }]
      : subjects.length === 0 ? [] : [{ kind: "deadlineApplied", subjects }],
    diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: NankaiUnitState, input: Extract<NankaiInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, NankaiIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changedIntents.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7 の先例）。配送で増えた終端記録も 98,304 byte に収める（decode と同じ境界）。
  const next = { ...state, intents: trimTerminal(state.intents.map((item) => changedIntents.get(item.id) ?? item), new Set(changedIntents.keys())),
    persistence: dirty(state.persistence, input.clock.monotonicMs) };
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
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。情報系列は空から始まる。
  const applied = collect({ ...decoded.state, persistence: state.persistence }, clock);
  const shown = applied.state.currents.filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-N"], coverage: shown.map((item) => item.subject), subjects: [] }],
    diagnostics: applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "nankai", reason: "notificationExpired",
      unit: "U-N", count: applied.expiredIntents }] } };
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
  contentRevision: String(state.contentRevision), admission: {}, subjects, currents, information: shownInformation.map(headingOf) };
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
  const row = record(value);
  const operation = operationOf(row?.operation), family = familyOf(row?.family);
  if (row == null || operation == null || family == null || !bounded(row.inputId, LIMITS.inputId) || !isText(row.subject)
    || !bounded(row.reportDateTimeRaw, LIMITS.reportDateTime) || !Number.isFinite(Date.parse(row.reportDateTimeRaw))
    || !isText(row.serialRaw) || !validSerial(row.serialRaw) || !isText(row.infoTypeRaw) || !INFO_RANK.has(row.infoTypeRaw)
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  if (subjectOperation(row.subject, family) !== operation) return null;
  return { inputId: row.inputId, origin: row.origin, operation, family, subject: row.subject,
    reportDateTimeRaw: row.reportDateTimeRaw, serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
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
  const base = { subject: row.subject, operation, eventId: row.eventId, source, retainUntil: row.retainUntil };
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
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（情報系列は復元で空になる、I-U-N.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-N" || !isText(row.subject) || source.subject !== row.subject
    || source.operation !== operation || payload.domain !== "earthquake-eew" || !isText(payload.title) || payload.title === ""
    || !isText(payload.body) || payload.body === "" || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt)
    || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0 || !isText(row.configRevision) || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-N", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "earthquake-eew", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition };
}
function persisted(value: unknown): PersistedNankaiUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord), intents = list(row.intents, intentRecord);
  if (currents == null || intents == null || currents.length > CURRENT_LIMIT
    || new Set(currents.map((entry) => entry.subject)).size !== currents.length
    || new Set(intents.map((entry) => entry.id)).size !== intents.length) return null;
  const pending = intents.filter((entry) => entry.disposition === "pending");
  // 終端記録は単独でなく pending との合計で見る（配送の更新で終端にした記録は回収しない、Q-C8-IMPL-AMEND(1)）。
  // 受理と同じ式（実 byte＋配送の更新の予約）で数える（Q-C8-IMPL-AMEND(7)(8)）。
  const pendingBytes = listBytes(pending) + pending.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  if (pending.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || pendingBytes + terminalBytes(intents) > PENDING_BYTES + TERMINAL_BYTES
    || generationBytes(currents, intents) > GENERATION_LIMIT) return null;
  return { schemaVersion: SCHEMA, currents, intents };
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const nankaiUnitCodec: NankaiUnitCodec = {
  schemaVersion: SCHEMA,
  // 情報系列・contentRevision・persistence は保存しない（I-U-N.persisted、spec:512 の N）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-nankai-unit-v1 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, information: [], persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-N.runtimeRows）。
const nankaiUnit = {
  unit: "U-N",
  reduce: reduceNankaiUnit,
  toView: toNankaiView,
  persistence: { kind: "durable", codec: nankaiUnitCodec },
  confirmationScopeLimit: 512,
  withoutNormal: (state) => ({ ...state, currents: state.currents.filter((item) => item.operation !== "normal"),
    information: state.information.filter((item) => item.operation !== "normal") }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => [...state.currents, ...state.information]
    .filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-N">;

export { nankaiUnit, nankaiUnitCodec, reduceNankaiUnit, toNankaiView };
