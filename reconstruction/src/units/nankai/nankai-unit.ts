import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, ReportRef, RuntimeDisplaySubject,
  RuntimeUnitDeadline, SubjectOutcome, UnreadableMark, WallBasis,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  NankaiCurrent, NankaiCurrentLine, NankaiCurrentStatus, NankaiInfoSerial, NankaiInformation, NankaiInformationView, NankaiInput,
  NankaiIntent, NankaiNotificationPayload, NankaiReportFamily, NankaiUnitCodec, NankaiUnitState, NankaiUnitStep, NankaiUnitView,
  NankaiUnreadableSite, PersistedNankaiUnit,
} from "../../../contracts/p3-nankai-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { nextMark, readReportRef, stepVersion } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { BOUNDS, FAMILIES, INFO_RANK, LIMITS, cut, parseNankai, validEventId, validSerial } from "../../domains/nankai/nankai";
import type { NankaiCandidate } from "../../domains/nankai/nankai";
import {
  applyIntentUpdate, cancelText, freshState, heard, markNotice, noticeId, noticeKind, noticed, raiseEvidence, readIntentState, readNoticeMark, recoveredPayload, restoreStarted,
  shown, updateEvidence, versionDigest,
} from "../notice-mark";
import { cachedMin } from "../expiry";
import { RAW_BUDGET, droppedIn, fitRawBudget, rawTotal, readUnreadableMark, stripRaw, unreadableMarkBytes } from "../unreadable";

// P3-UNIT-N-001（C8、I-U-N）: U-N の現況・情報系列・通知・容量・codec・射影。

const SCHEMA = "p3-nankai-unit-v8" as const;
const OPERATIONS = ["normal", "training", "test"] as const;
const LINES = ["nankai", "VYSE60"] as const;
// P3-C8-CAPACITY=A・P3-C8-RET-01〜04。世代の上限は P3-NS-RES-01（情報系列の全文を含む 2.5 MiB、設計メモ §4.6）。
const CURRENT_LIMIT = 6, INFORMATION_LIMIT = 64;
// P3-UM-RES-09: 器は現況と情報の印・原文の予算・カードの分だけ広げる。
const GENERATION_LIMIT = 2_621_440 + (CURRENT_LIMIT + INFORMATION_LIMIT) * unreadableMarkBytes("unreadable") + RAW_BUDGET + UNREADABLE_CARDS_MAX_BYTES;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C8-SEM-01・02・05 と P3-NS-SEM-01〜04（元報の ReportDateTime からの絶対の長さ、P3-C8-RETENTION=A）。
const DAY_MS = 86_400_000;
const CURRENT_VALID_MS = 7 * DAY_MS, CURRENT_RETAIN_MS = 30 * DAY_MS, WARNING_STEP_MS = 7 * DAY_MS, WARNING_VALID_MS = 14 * DAY_MS;
const INFORMATION_VALID_MS = 7 * DAY_MS, INFORMATION_RETAIN_MS = 30 * DAY_MS;
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
// 期限切れの保留の印のある記録は見えない記録として扱う（P3-EF-AC04。情報 subject も同じ、Q-NS-PRECHECK (0)(c)）。
const visible = (value: Shown | null): value is ActiveCurrent | ActiveInformation => value?.effective === "active" && value.expiryPending !== true;

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
  payload: { schemaVersion: SCHEMA, currents: [], intents: [], information: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7)・P3-UM-AC11 (10): envelope の inputBoundary・losses・カードの最大（器からは引かない）
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T・U-Q と同じ予約）。6: 空の配列 3 つ。
function generationBytes(currents: readonly NankaiCurrent[], intents: readonly NankaiIntent[], information: readonly NankaiInformation[]): number {
  return emptyEnvelopeBytes + 62 - 6 + listBytes(currents) + listBytes(intents) + listBytes(information);
}

// ---- 期限（I-U-N.deadlines） ----

// P3-NS-AC03 (5): warningUntil は巨大地震警戒の間だけ期限の候補にする（移った後は validUntil と retainUntil だけ）。
const stepsAt = (value: NankaiCurrent): number => value.effective === "active" && value.line === "nankai" && value.status === "megaquakeWarning"
  && value.warningUntil != null ? value.warningUntil : Infinity;
// P3-EF-AC11 (2)・P3-NS-AC04 (8): 根拠で当てない種類を比べないよう、表示の期限・回収の期限・保留の記録を式ごとの cache で別々に持つ
// （nextDeadline は全部の最小）。
const displayMin = cachedMin<NankaiCurrent>((item) => visible(item) ? Math.min(item.validUntil, stepsAt(item)) : Infinity);
const recallMin = cachedMin<NankaiCurrent>((item) => item.retainUntil);
const pendingMin = cachedMin<NankaiCurrent>((item) => item.effective === "active" && item.expiryPending === true ? item.validUntil : Infinity);
const informationDisplayMin = cachedMin<NankaiInformation>((item) => visible(item) ? item.validUntil : Infinity);
const informationRecallMin = cachedMin<NankaiInformation>((item) => item.retainUntil);
const informationPendingMin = cachedMin<NankaiInformation>((item) => item.effective === "active" && item.expiryPending === true ? item.validUntil : Infinity);
const intentMin = cachedMin<NankaiIntent>((item) => item.expiresAt);
function deadlineAt(state: NankaiUnitState): number {
  return Math.min(displayMin(state.currents), recallMin(state.currents), pendingMin(state.currents), informationDisplayMin(state.information),
    informationRecallMin(state.information), informationPendingMin(state.information), intentMin(state.intents));
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
// 通知の印（P3-NL-AC02）も中身の比べに入れない。P3-NS-AC03 (7): 版から導く期限（validUntil・warningUntil）は比べず、warningUntil を持つ
// 現況の status は巨大地震警戒と読む（時間で移った状態を報の中身の差にしない）。
// 読めない所の印（P3-UM-AC01）も比べない（原文の予算で原文を外した記録を同じ版の再送で食い違いにしない）。
const withoutSource = (value: Shown) => ({ ...value, source: null, unconfirmed: null, notice: null, expiryPending: null, validUntil: null,
  warningUntil: null, unreadable: null, ..."warningUntil" in value ? { status: "megaquakeWarning" } : {} });

// ---- 現況（I-U-N.currentSemantics） ----

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
    headline: candidate.facts.headline, truncated: candidate.facts.headingTruncated, validUntil: candidate.reportDateTimeMs + CURRENT_VALID_MS,
    ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
  if (candidate.line === "VYSE60") return { ...base, line: "VYSE60", status: "subsequentAdvisory", ...facts };
  // P3-NS-AC03 (1): 巨大地震警戒（120 の発表と 120 への訂正）は 7 日で巨大地震注意へ移り、14 日で expired。
  if (effect === "megaquakeWarning") return { ...base, line: "nankai", status: effect, ...facts,
    validUntil: candidate.reportDateTimeMs + WARNING_VALID_MS, warningUntil: candidate.reportDateTimeMs + WARNING_STEP_MS };
  // (3) と (4): 調査終了と、現況に効かない code への訂正は事実を捨てて ended（誤った status を残さない）。
  return effect === "investigating" || effect === "megaquakeAdvisory"
    ? { ...base, line: "nankai", status: effect, ...facts } : { ...base, line: "nankai", effective: "ended" };
}
function currentFacts(value: NankaiCurrent | null): Readonly<Record<string, JsonValue>> {
  if (value == null) return {};
  return value.effective === "active" ? { line: value.line, effective: value.effective, status: value.status, eventId: value.eventId,
    infoSerial: value.infoSerial, title: value.title, headline: value.headline } : { line: value.line, effective: value.effective, eventId: value.eventId };
}
const CURRENT_FIELDS = ["effective", "status", "infoSerial", "title", "headline"] as const;
const INFORMATION_FIELDS = ["effective", "infoKind", "infoSerial", "title", "headline", "text", "nextAdvisory"] as const;
function changed<T extends Shown>(before: T | null, after: T | null, fields: readonly string[]): string[] {
  const read = (value: T | null, field: string): unknown => value == null ? null : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  return fields.filter((field) => !isDeepStrictEqual(read(before, field), read(after, field)));
}

// 通知の判定に使う、今の時刻で期限を当てた後の見える形（統合担当の決定 2026-10-25）。表示の期限（validUntil）を過ぎた記録と保留の記録は
// 見えない。7 日目の巨大地震注意への移りは、回収と同じく awaiting では当てない。
function shownAt(value: Shown | null, now: number, basis: WallBasis): Shown | null {
  if (!visible(value) || value.validUntil <= now) return null;
  return basis !== "awaiting" && isCurrent(value) && value.line === "nankai" && stepsAt(value) <= now ? { ...value, status: "megaquakeAdvisory" } : value;
}

// ---- 情報系列（I-U-N.informationSemantics） ----

function informationOf(candidate: NankaiCandidate): NankaiInformation {
  const base = { subject: candidate.subject, family: candidate.family, eventId: candidate.eventId, operation: candidate.operation,
    source: candidate.source, retainUntil: candidate.reportDateTimeMs + INFORMATION_RETAIN_MS };
  if (candidate.cancelled) return { ...base, effective: "cancelled" };
  const { infoKind, infoSerial, title, headline, text, nextAdvisory, truncated } = candidate.facts;
  return { ...base, effective: "active", infoKind, infoSerial, title, headline, truncated, text, nextAdvisory,
    validUntil: candidate.reportDateTimeMs + INFORMATION_VALID_MS, ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
}
// view・snapshot には見出しだけを載せる（P3-C8-SNAPSHOT=A）。
const headingCache = new WeakMap<ActiveInformation, NankaiInformationView>();
function headingOf(value: ActiveInformation): NankaiInformationView {
  let found = headingCache.get(value);
  if (found == null) {
    const { text: _text, nextAdvisory: _next, ...heading } = value;
    found = shown(heading);
    headingCache.set(value, found);
  }
  return found;
}
function informationFacts(value: NankaiInformation | null): Readonly<Record<string, JsonValue>> {
  if (value == null) return {};
  return value.effective === "active" ? headingOf(value) : { family: value.family, eventId: value.eventId, effective: value.effective };
}

// P3-C8-CAPACITY=A・P3-OPCAP-N-AC01・P3-NS-AC06 (5)（統合担当の決定 D2）: 65 件目は (1) retainUntil を過ぎたもの (2) training/test
// (3) normal の expired の記憶 (4) normal の最古（ReportDateTime 順）から 1 件退去する。受ける報が training/test なら normal の記録（記憶を
// 含む）は (1)〜(4) とも候補にせず、候補が無ければ null（受けた記録自身を残さない）。
// ponytail: 64 件の一回の走査（上限は INFORMATION_LIMIT と復元の空で効く）。
// 第 1 段は受けた入力の根拠が verified のときだけ（P3-EF-AC03）。
function evictOne(information: readonly NankaiInformation[], now: number, incoming: Operation, verified: boolean): NankaiInformation | null {
  const tier = (item: NankaiInformation) => verified && item.retainUntil <= now ? 0 : item.operation !== "normal" ? 1
    : item.effective === "expired" ? 2 : 3;
  let worst: NankaiInformation | null = null;
  for (const item of information) {
    if (item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// P3-C8-NOTICE-LEVELS=B（作者裁定）: 報自身の InfoSerial/Code で決める。調査中（111〜113）は普通の音（H12、P3-NS-AC05）。例外は採った現況が今見える形で巨大地震注意のときの warning（P3-NN-AC01）。
const CODE_LEVEL: ReadonlyMap<string, Level> = new Map([["120", "critical"], ["130", "warning"], ["111", "normal"], ["112", "normal"],
  ["113", "normal"], ["210", "warning"], ["219", "warning"], ["190", "info"], ["200", "info"]]);
function levelOf(candidate: NankaiCandidate): Level {
  if (candidate.cancelled) return "cancel";
  const code = candidate.facts.infoSerial?.code;
  return code == null ? "warning" : CODE_LEVEL.get(code) ?? "warning";
}
// at は取り消した記録の ReportDateTime（P3-NL-AC10）。advisory は採った現況が今見える形で巨大地震注意のときで、報の code によらず巨大地震注意の段で
// 鳴らす（作者裁定 2026-10-25、P3-UNIT-N-NOTICE-001）。
function payloadOf(candidate: NankaiCandidate, at: string | null, advisory = false): NankaiNotificationPayload {
  const prefix = PREFIX[candidate.operation], { title, headline, text } = candidate.facts;
  if (candidate.cancelled) {
    const words = cancelText(title, at);
    return { domain: "earthquake-eew", level: "cancel", title: prefix + words.title, body: words.body };
  }
  // Text の先頭 80 単位はサロゲートの対を割らずに切る（P3-CODEC-AC04、F15）。
  const body = headline ?? (text == null ? null : cut(text, 80)) ?? title;
  const correction = candidate.infoRank === 2;
  return { domain: "earthquake-eew", level: advisory ? "warning" : levelOf(candidate), title: prefix + (correction ? `[訂正] ${title}` : title),
    body: correction ? `訂正: ${body}` : body };
}
// P3-NL-AC01: ID は世代番号を含まない。系列（現況か情報 subject）の印に同じ版の鍵と種類があれば作らない。
function intentsFor(candidate: NankaiCandidate, subject: string, transition: NankaiIntent["transition"], now: number,
  notice: Readonly<{ mark: NoticeMark | undefined; version: string }>, at: string | null = null, advisory = false): NankaiIntent[] {
  if (noticed(notice.mark, notice.version, noticeKind(transition))) return [];
  // P3-C8-TRAINING=A: training/test は desktop だけ。
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  const payload = payloadOf(candidate, at, advisory);
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
function admit(current: readonly NankaiIntent[], fresh: readonly NankaiIntent[], cancelled: ReadonlySet<string>, replacing: readonly NankaiIntent[] = fresh):
  Readonly<{ intents: readonly NankaiIntent[]; admitted: readonly NankaiIntent[]; dropped: number }> {
  const superseded = new Set<NankaiIntent>();
  const replaced = new Set(replacing.map((intent) => `${intent.subject}\n${intent.channel}`));
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
  const current = isCurrent(value) ? value.effective === "active" ? shown(value) : null : value.effective === "active" ? headingOf(value) : null;
  return { unit: "U-N", operation: value.operation, subject: value.subject, office: null, current, subjects: [shownOutcome(value)] };
}

// ---- 採用（P3-C8-SUBJECTS=A。一入力の変更は一回の参照交換で確定する） ----

// held は手元の版を残して系列に印を付ける報（mark はこの後の印、missing は比べる時刻を欠く報、P3-VM-AC03・AC04）。
type Verdict<T> = Readonly<{ kind: "adopt"; next: T; missing: boolean }>
  | Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale"; held: Readonly<{ mark: ReportRef | null; missing: boolean }> | null }>;
function judge<T extends Shown>(candidate: NankaiCandidate, existing: Shown | null, next: T): Verdict<T> {
  // expired（現況と情報の記憶、P3-NS-AC04 (4)）は事実を持たないので、同じ版の再受信は事実を比べずに duplicate（食い違いの WARN を出さない）。
  // ただし取消でない版への同じ時刻の取消は、expired でも勝つ（作者裁定 2026-10-21 昼）。
  const version = stepVersion(existing == null ? null : { version: existing.source, source: existing.source,
    cancelled: existing.effective === "cancelled" }, existing?.unconfirmed ?? null, next.source,
  () => existing != null && (existing.effective === "expired" ? !candidate.cancelled || existing.source.infoTypeRaw === next.source.infoTypeRaw
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
// 印を記録に当てる。現況と情報 subject の印は保存するので、保存世代を一度だけ進める（P3-VM-AC04・P3-NS-AC02）。
function holdState(state: NankaiUnitState, clock: ClockReading, marks: readonly (readonly [subject: string, mark: ReportRef | null])[]): NankaiUnitState {
  const marked = <T extends Shown>(values: readonly T[]): readonly T[] => marks.reduce((next, [subject, mark]) => {
    const at = indexOf(next, subject), found = next[at ?? -1];
    return found == null || mark == null || found.unconfirmed === mark ? next : replaceAt(next, at, { ...found, unconfirmed: mark });
  }, values);
  const currents = marked(state.currents), information = marked(state.information);
  return currents === state.currents && information === state.information ? state : { ...state, currents, information,
    persistence: dirty(state.persistence, clock.monotonicMs) };
}

function receiveCandidate(state: NankaiUnitState, candidate: NankaiCandidate, clock: ClockReading, basis: WallBasis): Result {
  const now = clock.wallTimeMs, recovering = candidate.source.origin === "recovery";
  const currentIndex = indexOf(state.currents, candidate.currentSubject);
  const current = currentIndex == null ? null : state.currents[currentIndex];
  const infoIndex = indexOf(state.information, candidate.subject);
  const info = infoIndex == null ? null : state.information[infoIndex];
  const decision = (subject: string, value: Verdict<Shown>, change: "semantic" | "revisionOnly"): Decision => value.kind === "unchanged"
    ? { subject, operation: candidate.operation, decision: "unchanged", reason: recovering && value.held != null ? "noChange" : value.reason }
    : { subject, operation: candidate.operation, decision: "changed", reason: null, change,
      currentEstablished: { family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } };

  // 現況に効く報は、現況が採用したときだけ情報系列にも入る。現況が unchanged なら情報 subject も同じ reason（P3-C8-SUBJECTS=A）。
  // 除外の判定（affectsCurrent）は系統の watermark より先。現況に効く報でも、同じ報（headType・EventID）の情報 subject に新しい
  // 取消・訂正があれば現況へ当てない（取消が先着した古い元報で現況だけが戻らない、Q-C8-IMPL-AMEND(3)）。
  const affects = affectsCurrent(candidate, current);
  const infoVerdict = judge(candidate, info, informationOf(candidate));
  const currentVerdict = !affects ? null : infoVerdict.kind === "unchanged" ? infoVerdict : judge(candidate, current, currentOf(candidate));
  // 印は手元の版を残した系列に付ける。現況に効く報を情報 subject で残したときは、現況の系列にも同じ報の印を付ける。
  if (currentVerdict?.kind === "unchanged") {
    const held = currentVerdict.held, onInfo = currentVerdict === infoVerdict;
    const currentMark = !onInfo ? held?.mark ?? null : held?.mark == null || current == null ? null
      : nextMark(current.unconfirmed ?? null, { ...candidate.source, subject: candidate.currentSubject });
    const marked = held == null || recovering ? state : holdState(state, clock, [...onInfo ? [[candidate.subject, held.mark] as const] : [],
      [candidate.currentSubject, currentMark] as const]);
    return { changes: [], step: { ...idle(marked),
      decisions: [decision(candidate.currentSubject, currentVerdict, "revisionOnly"), decision(candidate.subject, currentVerdict, "revisionOnly")],
      diagnostics: held == null || recovering ? [] : [heldDiagnostic(candidate, held.missing)] } };
  }
  if (currentVerdict == null && infoVerdict.kind === "unchanged") {
    const held = infoVerdict.held, marked = held == null || recovering ? state : holdState(state, clock, [[candidate.subject, held.mark]]);
    return { changes: [], step: { ...idle(marked), decisions: [decision(candidate.subject, infoVerdict, "revisionOnly")],
      diagnostics: held == null || recovering ? [] : [heldDiagnostic(candidate, held.missing)] } };
  }

  // P3-NL-AC02 (2)(4): 通知の印は系列の記録へ引き継ぐ（情報 subject は expired の記憶からも）。
  // 同じ報（EventID・ReportDateTime が同じ）の訂正でない版の更新は、手元ですでに移った段（巨大地震注意）を引き継ぐ。awaiting では新しく
  // 移さないが、移った段から警戒へ戻さない（K13 r5 のレビュー、統合担当の決定 2026-10-25）。
  const adoptedCurrent = currentVerdict?.kind !== "adopt" ? null : candidate.infoRank !== 2 && current?.effective === "active"
    && current.line === "nankai" && current.status === "megaquakeAdvisory" && current.warningUntil != null && current.eventId === candidate.eventId
    && current.source.family === candidate.family && currentVerdict.next.effective === "active" && currentVerdict.next.line === "nankai"
    && currentVerdict.next.warningUntil === current.warningUntil ? { ...currentVerdict.next, status: "megaquakeAdvisory" as const } : currentVerdict.next;
  const adoptedInfo = infoVerdict.kind === "adopt" ? infoVerdict.next : null;
  let nextCurrent = adoptedCurrent == null || current?.notice == null ? adoptedCurrent : { ...adoptedCurrent, notice: current.notice };
  let nextInfo = adoptedInfo == null || info?.notice == null ? adoptedInfo : { ...adoptedInfo, notice: info.notice };
  // 到着の時点で表示の期限を過ぎた報（情報 subject の 7 日、P3-NS-AC04 (3)）。
  const due = candidate.reportDateTimeMs + INFORMATION_VALID_MS <= now;
  // 通知の意味の変化は、手元の記録と候補を今の時刻で期限を当てた後の見える形にそろえて比べる（同じ reduce の回収で消える差と、期限を過ぎた報を
  // 理由にしない）。事実の無い候補（調査終了）は、報の表示の期限の内でだけ見えていた記録を消す変化として数える。
  const fieldsOf = (before: Shown | null, next: Shown | null, fields: readonly string[]): string[] => {
    if (next == null) return [];
    const after = shownAt(next, now, basis);
    return next.effective === "active" ? after == null ? [] : changed(shownAt(before, now, basis), after, fields)
      : due ? [] : changed(shownAt(before, now, basis), null, fields);
  };
  const currentFields = fieldsOf(current, nextCurrent, CURRENT_FIELDS), infoFields = fieldsOf(info, nextInfo, INFORMATION_FIELDS);
  // 訂正は、通知する系列の候補が今見える形を持つ（事実の無い候補は報の表示の期限の内）ときに作る。
  const notified = nextCurrent ?? nextInfo;
  const correctionShown = notified?.effective === "active" ? shownAt(notified, now, basis) != null : !due;
  // 音の段は、今の時刻で期限を当てた後に見える現況の status で決める（巨大地震注意なら warning。移った段を引き継いだ版の更新も含む。awaiting では新しく移さない、P3-NN-AC01）。
  const shownCurrent = nextCurrent == null ? null : shownAt(nextCurrent, now, basis), advisory = shownCurrent != null && "status" in shownCurrent && shownCurrent.status === "megaquakeAdvisory";
  // 到着の時点で表示の期限を過ぎた記録の無い情報 subject は配列へ入れない（足せば記憶として 30 日残る、P3-NS-AC04 (3)）。同じ reduce で回収される記録のために他の記録を退去しない
  // （P3-FINAL-AC01）。training/test の報で退去できる記録が無ければ、受けた情報 subject を残さない（自身の退去、P3-OPCAP-N-AC02）。
  // 通知の判定が自身の退去を見るので、置き場はその前に決める。
  const freshDue = due && infoIndex == null;
  let information = nextInfo == null || freshDue ? state.information : replaceAt(state.information, infoIndex, nextInfo);
  let evicted: NankaiInformation | null = null;
  let self = false;
  if (information.length > INFORMATION_LIMIT) {
    evicted = evictOne(state.information, now, candidate.operation, basis === "verified");
    const gone = evicted;
    if (gone == null) { self = true; information = state.information; } else information = information.filter((item) => item !== gone);
  }
  // 自身を退去した情報 subject には通知を作らない。現況を採用したなら現況の通知は今どおり（P3-OPCAP-N-AC02）。
  const notify = !(self && nextCurrent == null)
    // P3-NL-AC09 (1): 取消は、取り消す記録が元の報の表示の期限の内で見えているか、系列の印に通知の証拠があるとき（H19、決定 D1）。
    && (candidate.cancelled ? nextCurrent != null && (shownAt(current, now, basis) != null || heard(current?.notice))
      || nextInfo != null && (shownAt(info, now, basis) != null || heard(info?.notice))
      : candidate.infoRank === 2 ? correctionShown : currentFields.length !== 0 || infoFields.length !== 0);
  const subject = nextCurrent != null ? candidate.currentSubject : candidate.subject;
  const before = nextCurrent != null ? current : info;
  // 訂正は ended になっても updated（Q-NOTICE.transition の訂正の規則が先）。
  const transition = candidate.cancelled ? "cancelled" as const : candidate.infoRank === 2 ? "updated" as const
    : nextCurrent?.effective === "ended" ? "released" as const : visible(before) ? "updated" as const : "activated" as const;
  // 版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const version = versionDigest(candidate.source);
  const at = before == null ? null : before.source.reportDateTimeRaw;
  const fresh = notify ? intentsFor(candidate, subject, transition, now, { mark: before?.notice, version }, at, advisory) : [];
  const cancelledSubjects = new Set(candidate.cancelled ? [...nextCurrent == null ? [] : [candidate.currentSubject],
    ...nextInfo == null ? [] : [candidate.subject]] : []);
  const notices = admit(state.intents, recovering ? [] : fresh, cancelledSubjects, fresh); // 取り直しは intent を作らず、live の新しい intent が置き換える古い pending だけを外す（P3-REC-D-UNIT-ENTRANCE=A）
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
  // 情報系列の変化も全部保存世代を進める（P3-NS-AC01 (4)）。
  const persisted = currents !== state.currents || notices.intents !== state.intents || information !== state.information;
  let adopted: NankaiUnitState = { ...draft, persistence: persisted ? dirty(state.persistence, clock.monotonicMs) : state.persistence };
  // P3-UM-AC03 (3): 原文の合計（現況と情報の和）が予算を越えたら古い記録の原文から外す（印は残る）。外した記録の view も変わるので表示の変化に足す。
  const slices = adopted;
  const fit = fitRawBudget<Shown>(rawTotal(slices.currents, slices.information), RAW_BUDGET, () => [...slices.currents, ...slices.information],
    (item) => [reportMs(item.source), item.subject]);
  const stripped: Change[] = [];
  if (fit != null) {
    const ownCurrent = nextCurrent, ownInfo = nextInfo;
    const strip = <T extends Shown>(values: readonly T[], own: T | null, keep: (after: T) => void): readonly T[] => values.map((item) => {
      const after = stripRaw(item, fit);
      if (after === item) return item;
      if (item === own) keep(after);
      else stripped.push([item, after]);
      return after;
    });
    adopted = { ...adopted, currents: strip(adopted.currents, ownCurrent, (after) => { nextCurrent = after; }),
      information: strip(adopted.information, ownInfo, (after) => { nextInfo = after; }) };
  }
  const collected = collecting ? collect(adopted, clock, basis) : null;
  const next = collected?.state ?? adopted;
  const changes: Change[] = [];
  if (nextCurrent != null && !currentDue) changes.push([current, nextCurrent]);
  if (nextInfo != null && !freshDue && !self) changes.push([info, nextInfo]);
  if (evicted != null) changes.push([evicted, null]);
  changes.push(...stripped);
  // 結果は回収の後の記録で決める（D-OUTCOME=A・D-VANISHED=A、P3-FINAL-AC02）。最終の記録が無ければ accepted に載せず
  // currentEstablished も null。索引は回収のある reduce だけで引く（P3-FINAL-RES-01）。
  const settled = (before: Shown | null, proposed: Shown | null, added: boolean, values: readonly Shown[], fields: readonly string[]) => {
    if (proposed == null) return null;
    const last = !added ? null : collected == null ? proposed : values[indexOf(values, proposed.subject) ?? -1] ?? null;
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
  const dropped = droppedIn(fit, [...next.currents, ...next.information]);
  if (dropped !== 0) diagnostics.push({ level: "INFO", component: "nankai", reason: "unreadableDropped", unit: "U-N", count: dropped });
  if ([currentVerdict, infoVerdict].some((item) => item?.kind === "adopt" && item.missing))
    diagnostics.push(heldDiagnostic(candidate, true));
  const decisions: Decision[] = [];
  const final = (subject: string, value: Verdict<Shown>, settledValue: ReturnType<typeof settled>): Decision => {
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

// ---- 期限（I-U-N.deadlines・P3-NS-AC10 (1)。到来分だけを回収する） ----

// 時計の根拠ごとに（P3-EF-AC02・AC04、Q-NS-PRECHECK (0)(c)）、awaiting は何も当てない。unverified は表示の期限切れだけを当てる（巨大地震警戒の
// 巨大地震注意への移りと、validUntil の来た現況・情報に保留の印）。verified は validUntil の来た記録と保留の記録（時計によらず）の事実を捨て
// （現況は expired、情報は expired の記憶）、retainUntil の来た記録と intent を回収する。
// ponytail: 現況 6・情報 64 の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: NankaiUnitState, clock: ClockReading, basis: WallBasis): Readonly<{ state: NankaiUnitState;
  changes: readonly Change[]; expiredIntents: number }> {
  const now = clock.wallTimeMs, verified = basis === "verified";
  const none = { state, changes: [], expiredIntents: 0 };
  const shows = basis !== "awaiting" && displayMin(state.currents) <= now;
  const recalls = verified && (recallMin(state.currents) <= now || pendingMin(state.currents) !== Infinity);
  const informationShows = basis !== "awaiting" && informationDisplayMin(state.information) <= now;
  const informationRecalls = verified && (informationRecallMin(state.information) <= now || informationPendingMin(state.information) !== Infinity);
  const intentsDue = verified && intentMin(state.intents) <= now;
  if (!shows && !recalls && !informationShows && !informationRecalls && !intentsDue) return none;
  const changes: Change[] = [];
  const mappedCurrents = !shows && !recalls ? state.currents : state.currents.flatMap((item): NankaiCurrent[] => {
    if (verified && item.retainUntil <= now) { changes.push([item, null]); return []; }
    if (item.effective !== "active") return [item];
    if (item.expiryPending === true || item.validUntil <= now) {
      if (!verified) {
        if (item.expiryPending === true) return [item];
        const marked: NankaiCurrent = { ...item, expiryPending: true };
        changes.push([item, marked]);
        return [marked];
      }
      // (6): validUntil の到来で expired（事実を捨てる。通知しない、P3-C8-CURRENT-EXPIRY=A）。通知の印は残す（統合担当の決定 D1）。
      const kept = { subject: item.subject, operation: item.operation, eventId: item.eventId, source: item.source, retainUntil: item.retainUntil,
        ...item.notice == null ? {} : { notice: item.notice } };
      const after: NankaiCurrent = item.line === "VYSE60" ? { ...kept, line: "VYSE60", effective: "expired" }
        : { ...kept, line: "nankai", effective: "expired" };
      changes.push([item, after]);
      return [after];
    }
    // P3-NS-AC03 (2)(3): warningUntil の到来で巨大地震注意へ移る（事実・印・warningUntil は残す。通知しない、P3-NS-D-STEPDOWN-NOTICE=A）。
    if (item.line !== "nankai" || stepsAt(item) > now) return [item];
    const stepped: NankaiCurrent = { ...item, status: "megaquakeAdvisory" };
    changes.push([item, stepped]);
    return [stepped];
  });
  const currents = changes.length === 0 ? state.currents : mappedCurrents;
  const currentChanges = changes.length;
  const mappedInformation = !informationShows && !informationRecalls ? state.information
    : state.information.flatMap((item): NankaiInformation[] => {
      if (verified && item.retainUntil <= now) { changes.push([item, null]); return []; }
      if (item.effective !== "active" || item.expiryPending !== true && item.validUntil > now) return [item];
      if (!verified) {
        if (item.expiryPending === true) return [item];
        const marked: NankaiInformation = { ...item, expiryPending: true };
        changes.push([item, marked]);
        return [marked];
      }
      // P3-NS-AC04 (1): 表示の期限で expired の記憶（本文と未確認の印を捨て、source と通知の印を残す。通知しない）。
      const after: NankaiInformation = { subject: item.subject, family: item.family, eventId: item.eventId, operation: item.operation,
        source: item.source, retainUntil: item.retainUntil, effective: "expired", ...item.notice == null ? {} : { notice: item.notice } };
      changes.push([item, after]);
      return [after];
    });
  const information = changes.length === currentChanges ? state.information : mappedInformation;
  const intents = !intentsDue ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - intents.length;
  if (changes.length === 0 && intents === state.intents) return none;
  // P3-NS-AC01 (4): 期限の変化は現況・情報とも保存世代を進める。
  return { state: { ...state, currents, information, intents, persistence: dirty(state.persistence, clock.monotonicMs) }, changes, expiredIntents };
}

function deadlineStep(state: NankaiUnitState, clock: ClockReading, basis: WallBasis, shutdown: boolean): Result {
  const applied = collect(state, clock, basis);
  // P3-NS-AC03 (3): 巨大地震注意への移りは status の変化として出す（保留の印を付けた記録は outcome にしない）。
  const subjects = applied.changes.flatMap(([before, after]) => after == null || !visible(before) ? []
    : after.effective !== "active" ? [outcomeOf(after, ["effective"])] : visible(after) ? [outcomeOf(after, ["status"])] : []);
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

function restore(state: NankaiUnitState, persisted: PersistedNankaiUnit, clock: ClockReading, basis: WallBasis): Result {
  const decoded = nankaiUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "nankai",
    reason: "requiredStructureInvalid", unit: "U-N" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。情報系列は保存したとおりに戻る（P3-NS-AC01 (3)）。
  // P3-NL-AC08 (1): started のまま残った pending は通知したか不明として外し、系列の印の証拠を unknown にする。
  const restored = restoreStarted(decoded.state.intents);
  const base = { ...raiseNotices(decoded.state, new Map(restored.started.map((item) => [item.subject, "unknown" as const]))),
    intents: restored.intents, persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const applied = collect(base, clock, basis);
  // P3-NS-AC01 (3)・Q-NS-INTEGRATOR (6): 表示の変化と coverage に active の情報 subject も載せる（一覧が戻ることを知らせる）。
  const active: Shown[] = [...applied.state.currents.filter(visible), ...applied.state.information.filter(visible)];
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
  // P3-REC-AC12（C16 発注 4a）・P3-C8-N2: origin=recovery は候補の作成のときだけ owner から届く。意味を当てて intent を作らず
  // （P3-REC-D-UNIT-ENTRANCE=A。引上げの音は採用の step の recoveryNotices）、版が決まらなければ印を置かずに noChange で返す
  // （owner がその結果を held にする、P3-REC-AC05 の (a)）。
  const result: Result = receiveCandidate(state, candidate, input.clock, input.basis ?? "verified");
  // P3-NS-AC07: 受けた報の読めなかった所の WARN を添える。
  return parsed.diagnostics.length === 0 ? result
    : { ...result, step: { ...result.step, diagnostics: [...parsed.diagnostics, ...result.step.diagnostics] } };
}

function reduceCore(state: NankaiUnitState, input: NankaiInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock, input.basis ?? "verified");
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, input.basis ?? "verified", false);
    case "shutdown": return deadlineStep(state, input.clock, input.basis ?? "verified", true);
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
  const currents = state.currents.filter((item): item is ActiveCurrent => visible(item));
  const shownInformation = state.information.filter((item): item is ActiveInformation => visible(item));
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
const FACT_KEYS = ["status", "infoSerial", "title", "headline", "truncated", "validUntil", "expiryPending", "warningUntil", "unreadable"] as const;
// P3-UM-AC01 (2): 印の site の表（NankaiUnreadableSite）。欄が無ければ {}、形の外は null。
const UNREADABLE_SITES: ReadonlySet<string> = new Set(["serial", "infoName"] satisfies readonly NankaiUnreadableSite[]);
function unreadableOf(row: Fields): Readonly<{ unreadable?: UnreadableMark }> | null {
  if (!("unreadable" in row)) return {};
  const mark = readUnreadableMark(row.unreadable, UNREADABLE_SITES);
  return mark == null ? null : { unreadable: mark };
}
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
  const serial = infoSerial(row.infoSerial), unreadable = unreadableOf(row);
  // P3-NS-AC03 (6): 巨大地震警戒は warningUntil（+7 日）を必ず持ち validUntil は +14 日。巨大地震注意は移った後だけ持ち、ほかは持たない。
  const warned = line === "nankai" && (row.status === "megaquakeWarning" || row.status === "megaquakeAdvisory" && "warningUntil" in row);
  if (serial === "invalid" || unreadable == null || !bounded(row.title, BOUNDS.title) || !boundedOrNull(row.headline, BOUNDS.headline)
    || typeof row.truncated !== "boolean" || row.validUntil !== reportMs(source) + (warned ? WARNING_VALID_MS : CURRENT_VALID_MS)
    || (warned ? row.warningUntil !== reportMs(source) + WARNING_STEP_MS : "warningUntil" in row)
    || "expiryPending" in row && row.expiryPending !== true) return null;
  const facts = { effective: "active" as const, infoSerial: serial, title: row.title, headline: row.headline, truncated: row.truncated,
    validUntil: row.validUntil, ...row.expiryPending === true ? { expiryPending: true as const } : {}, ...unreadable };
  if (line === "VYSE60") return row.status === "subsequentAdvisory" ? { ...base, line, status: row.status, ...facts } : null;
  const status = STATUSES.nankai.find((item): item is NankaiCurrentStatus => item === row.status);
  return status == null ? null : { ...base, line, status, ...facts, ...warned ? { warningUntil: reportMs(source) + WARNING_STEP_MS } : {} };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): NankaiIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-N", operation, level), recovered = payload == null ? null : recoveredPayload(payload);
  // state に残る subject との一致は求めない（退去・回収で記録の消えた系列の pending も残る、I-U-N.decode）。H27 の 2 欄は対で読む（P3-REC-AC12）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || fields == null || recovered == null || !isText(row.id) || row.unit !== "U-N" || !isText(row.subject) || source.subject !== row.subject
    || source.operation !== operation || payload.domain !== "earthquake-eew" || !isText(payload.title) || payload.title === ""
    || !isText(payload.body) || payload.body === "" || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt)
    || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0 || !isText(row.configRevision) || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-N", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "earthquake-eew", level, title: payload.title, body: payload.body, ...recovered }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition: "pending", ...fields };
}
const INFORMATION_FACT_KEYS = ["infoKind", "infoSerial", "title", "headline", "truncated", "text", "nextAdvisory", "validUntil", "expiryPending",
  "unreadable"] as const;
// P3-NS-AC01 (2): 情報 subject の記録を項目ごとに確かめて組み立てる。印は同じ subject・operation の報（P3-NS-AC02）。
function informationRecord(value: unknown): NankaiInformation | null {
  const row = record(value);
  const operation = operationOf(row?.operation), family = familyOf(row?.family), source = reportRef(row?.source);
  if (row == null || operation == null || family == null || source == null || !isText(row.eventId) || !validEventId(row.eventId)
    || row.subject !== `${operation}/${family}/${row.eventId}` || source.subject !== row.subject
    || row.retainUntil !== reportMs(source) + INFORMATION_RETAIN_MS) return null;
  const mark = "unconfirmed" in row ? reportRef(row.unconfirmed) : undefined;
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (mark === null || notice === null || mark != null && (mark.subject !== row.subject || mark.operation !== operation)) return null;
  const base = { subject: row.subject, family, eventId: row.eventId, operation, source, retainUntil: row.retainUntil,
    ...mark == null ? {} : { unconfirmed: mark }, ...notice == null ? {} : { notice } };
  if (row.effective !== "active") {
    if (INFORMATION_FACT_KEYS.some((key) => key in row)) return null;
    return row.effective === "cancelled" || row.effective === "expired" ? { ...base, effective: row.effective } : null;
  }
  const serial = infoSerial(row.infoSerial), unreadable = unreadableOf(row);
  if (serial === "invalid" || unreadable == null || !boundedOrNull(row.infoKind, BOUNDS.infoKind) || !bounded(row.title, BOUNDS.title)
    || !boundedOrNull(row.headline, BOUNDS.headline) || !boundedOrNull(row.text, BOUNDS.text) || !boundedOrNull(row.nextAdvisory, BOUNDS.nextAdvisory)
    || typeof row.truncated !== "boolean" || row.validUntil !== reportMs(source) + INFORMATION_VALID_MS
    || "expiryPending" in row && row.expiryPending !== true) return null;
  return { ...base, effective: "active", infoKind: row.infoKind, infoSerial: serial, title: row.title, headline: row.headline,
    truncated: row.truncated, text: row.text, nextAdvisory: row.nextAdvisory, validUntil: row.validUntil,
    ...row.expiryPending === true ? { expiryPending: true as const } : {}, ...unreadable };
}
type Decoded = Readonly<{ currents: readonly NankaiCurrent[]; intents: readonly NankaiIntent[]; information: readonly NankaiInformation[] }>;
function persisted(value: unknown): Decoded | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord), intents = list(row.intents, intentRecord);
  // 鍵の無い保存物は invalid（旧い形は版で捨てる、P3-NS-AC08）。
  const information = list(row.information, informationRecord);
  if (currents == null || intents == null || information == null || currents.length > CURRENT_LIMIT || information.length > INFORMATION_LIMIT
    || new Set(currents.map((entry) => entry.subject)).size !== currents.length
    || new Set(information.map((entry) => entry.subject)).size !== information.length
    || new Set(intents.map((entry) => entry.id)).size !== intents.length) return null;
  // 受理と同じ式（実 byte＋配送の更新の予約）で数える（Q-C8-IMPL-AMEND(7)(8)）。保存する intent は pending だけ（P3-NL-AC05）。
  const pendingBytes = listBytes(intents) + intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  // P3-UM-AC16 (3)(c): 原文の合計（AC03 (1) の数え方）が予算の内。
  if (intents.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES
    || generationBytes(currents, intents, information) > GENERATION_LIMIT || rawTotal(currents, information) > RAW_BUDGET) return null;
  return { currents, intents, information };
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const nankaiUnitCodec: NankaiUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p3-nankai-unit-v1", "p3-nankai-unit-v2", "p3-nankai-unit-v3", "p3-nankai-unit-v4", "p3-nankai-unit-v5", "p3-nankai-unit-v6", "p3-nankai-unit-v7"], maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）・P3-NS-AC08: 前の版の保存は初期化する
  // contentRevision・persistence は保存しない（I-U-N.persisted）。情報系列は全文を保存する（P3-NS-AC01、H30）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents, information: state.information }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: `invalid ${SCHEMA} payload` }
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

// ---- 取り直しの採用の step（P3-RECOVERY-001 発注 4a、P3-REC-AC10・P3-REC-D-N2-RAISE=A） ----

// H27 の段: 南海トラフの線は調査中→巨大地震注意→巨大地震警戒、北海道三陸沖後発の線は後発地震注意か否か。code でなく、期限を当てた後に
// 見える現況の status で比べる（VYSE60 は InfoSerial を持たない報でも後発地震注意の現況を作る）。見えない現況と記録の無い線は 0。
const RAISE_RANK: Readonly<Record<NankaiCurrentStatus | "subsequentAdvisory", number>> = { investigating: 1, megaquakeAdvisory: 2, megaquakeWarning: 3, subsequentAdvisory: 1 };
const raiseRank = (value: Shown | null): number => value != null && "status" in value ? RAISE_RANK[value.status] : 0;

/**
 * 候補の部分集合の検査の後に、採用の step で作る H27 の intent（P3-REC-AC10）。open は取り直しを始めた時の state（P3-REC-D-RAISE-BASIS=A）、
 * candidate は採用する state。現況の段が open より上がり、いまも見える現況のうち段の最も高い 1 件に info を 1 回（取り直し 1 回で unit に 1 件）。
 * 通知済みの版（K8 の印）は選ぶ前に除く。無ければ candidate をそのまま返す。
 */
function recoveryNotices(open: NankaiUnitState, candidate: NankaiUnitState, clock: ClockReading, basis: WallBasis): NankaiUnitState {
  const now = clock.wallTimeMs, before = new Map(open.currents.map((item) => [item.subject, item]));
  let best: Readonly<{ current: ActiveCurrent; rank: number }> | null = null;
  for (const current of candidate.currents) {
    const rank = raiseRank(shownAt(current, now, basis));
    if (!visible(current) || rank <= raiseRank(shownAt(before.get(current.subject) ?? null, now, basis))) continue;
    if (noticed(current.notice, versionDigest(current.source), noticeKind("updated"))) continue;
    if (best == null || rank > best.rank) best = { current, rank };
  }
  if (best == null) return candidate;
  const { current } = best, { operation, source } = current, version = versionDigest(source);
  const at = new Date(reportMs(source) + 32_400_000).toISOString().slice(11, 16);
  const payload: NankaiNotificationPayload = { domain: "earthquake-eew", level: "info", title: `${PREFIX[operation]}${current.title}（${at} 発表）`,
    body: current.headline ?? current.title, reportDateTime: source.reportDateTimeRaw, recovered: true };
  const channels = operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  const fresh: NankaiIntent[] = channels.map((channel) => ({ id: noticeId("U-N", current.subject, "", source, "updated", channel), unit: "U-N",
    subject: current.subject, operation, source, transition: "updated", channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending", ...freshState("U-N", operation) }));
  const notices = admit(candidate.intents, fresh, new Set());
  if (notices.admitted.length === 0) return candidate;
  // P3-NL-AC02 (3): 引上げの版と種類を現況の系列の印に足す。
  const currents = candidate.currents.map((item) => item !== current ? item : { ...item, notice: markNotice(item.notice, version, noticeKind("updated")) });
  return { ...candidate, currents, intents: notices.intents };
}

export { nankaiUnit, nankaiUnitCodec, recoveryNotices, reduceNankaiUnit, toNankaiView };
