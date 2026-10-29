import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline,
  SubjectOutcome, UnreadableMark, WallBasis,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  PersistedTyphoonUnit, TyphoonAnalysisRecord, TyphoonFrame, TyphoonFrameKind, TyphoonInput, TyphoonIntent, TyphoonName, TyphoonNotificationPayload,
  TyphoonPoint, TyphoonPrefecture, TyphoonProbabilityArea, TyphoonProbabilityRecord, TyphoonUnitCodec, TyphoonUnitState, TyphoonUnitStep, TyphoonUnitView,
  TyphoonUnreadableSite, TyphoonWindArea, TyphoonWindAxis,
} from "../../../contracts/p3-typhoon-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, TYPHOON_CARDS_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { readReportRef, stepVersion } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { ANALYSIS_TYPES, BOUNDS, LIMITS, PROBABILITY_TYPES, RETAIN, VISIBLE, parseTyphoon, validCode6, validEventId } from "../../domains/typhoon/typhoon";
import type { AnalysisCandidate, ProbabilityCandidate, TyphoonCandidate } from "../../domains/typhoon/typhoon";
import { cut, infoRankOf, validName, validReportDateTime, validSerial } from "../../domains/flood/flood";
import {
  applyIntentUpdate, cancelText, freshState, heard, markNotice, noticeId, noticeKind, noticed, raiseEvidence, readIntentState, readNoticeMark, restoreStarted,
  shown, updateEvidence, versionDigest,
} from "../notice-mark";
import { RAW_BUDGET, droppedIn, fitRawBudget, rawTotal, readUnreadableMark, stripRaw, unreadableMarkBytes } from "../unreadable";

// P3-UNIT-Y-001（C14、I-U-Y）: 二つの slice（analysis・probability）の current・版・遅着・退去・通知・容量・codec・射影。
// 二つの slice は件数の上限と退去を別々に持つ（無いと訓練の確率の多発が解析の記録を退去する、I-U-Y.slices）。

const SCHEMA = "p3-typhoon-unit-v7" as const;
// P3-C14-RES-01・RET-04。P3-UM-RES-09: 器は記録の上限（解析 64＋確率 64）×印 1 件＋原文の予算＋カード（地域の一覧つき）の分だけ広げる。
const GENERATION_LIMIT = 8_388_608 + 2 * LIMITS.subjects * unreadableMarkBytes("unreadable") + RAW_BUDGET + TYPHOON_CARDS_MAX_BYTES;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;

type Analysis = TyphoonAnalysisRecord;
type Probability = TyphoonProbabilityRecord;
type Rec = Analysis | Probability;
type Level = TyphoonNotificationPayload["level"];
type InternalStep = Omit<TyphoonUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = TyphoonUnitStep["decisions"][number];
// 前が無ければ後は必ずある（どちらも無い変化は作らない）。
type Change = readonly [before: Rec, after: Rec | null] | readonly [before: null, after: Rec];
const target = (value: Change): Rec => value[0] == null ? value[1] : value[1] ?? value[0];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;
type State = TyphoonUnitState;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// view に載るのは active だけ（I-U-Y.view）。期限切れの保留の印のある記録は見えない（P3-EF-AC02 (2)）。
function visible<T extends Rec>(value: T | null): value is Extract<T, Readonly<{ effective: "active" }>> {
  return value?.effective === "active" && value.expiryPending !== true;
}

// ---- byte の加算（I-U-Y.computation。受信 1 回で state 全体を直列化しない） ----

const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
const commas = (length: number) => Math.max(length - 1, 0);
const listBytes = (values: readonly object[]): number => 2 + commas(values.length) + values.reduce((sum, item) => sum + bytes(item), 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-Y", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, analysis: [], probability: [], intents: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + TYPHOON_CARDS_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7)・P3-UM-AC11 (10): envelope の inputBoundary・losses・カードの最大（器からは引かない）
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-R ほかと同じ予約）。6: 空の配列 3 つ。
function generationBytes(value: PersistedTyphoonUnit): number {
  return emptyEnvelopeBytes + 62 - 6 + listBytes(value.analysis) + listBytes(value.probability) + listBytes(value.intents);
}

// ---- 期限（I-U-Y.deadlines: 見える期限・retainUntil・intent の expiresAt の最小） ----

// 配列ごとの最小の期限。記録の配列と intent の配列は別の cache にする（同じ配列に別の取り出し方を使うと値が食い違うため）。
function cachedMin<T extends object>(cache: WeakMap<readonly T[], number>, values: readonly T[], at: (value: T) => number): number {
  let min = cache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); cache.set(values, min); }
  return min;
}
const recordMinCache = new WeakMap<readonly Rec[], number>(), intentMinCache = new WeakMap<readonly TyphoonIntent[], number>();
const recordMin = (values: readonly Rec[]) => cachedMin(recordMinCache, values, deadlineOf);
const intentMin = (values: readonly TyphoonIntent[]) => cachedMin(intentMinCache, values, (item) => item.expiresAt);
const deadlineOf = (item: Rec): number => item.effective === "active" ? item.activeUntil : item.retainUntil;
// P3-EF-AC11 (2): 根拠で当てない種類を比べないよう、表示の期限・回収の期限・保留の記録を別々に持つ（nextDeadline は recordMin）。
const displayCache = new WeakMap<readonly Rec[], number>(), recallCache = new WeakMap<readonly Rec[], number>(), pendingCache = new WeakMap<readonly Rec[], number>();
const displayMin = (values: readonly Rec[]) => cachedMin(displayCache, values, (item) => visible(item) ? item.activeUntil : Infinity);
const recallMin = (values: readonly Rec[]) => cachedMin(recallCache, values, (item) => item.effective === "active" ? Infinity : item.retainUntil);
const pendingMin = (values: readonly Rec[]) => cachedMin(pendingCache, values, (item) => item.effective === "active" && item.expiryPending === true
  ? item.activeUntil : Infinity);
const deadlineAt = (state: State): number => Math.min(recordMin(state.analysis), recordMin(state.probability), intentMin(state.intents));
function nextDeadline(state: State): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1, dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: State): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

// ---- 索引（配列に結び付けた Map、I-U-Y.computation）: subject の位置。TERMINAL の確率・解析の引き当ても同じ索引で O(1) ----

const indexCache = new WeakMap<readonly Rec[], ReadonlyMap<string, number>>();
function indexOf(values: readonly Rec[]): ReadonlyMap<string, number> {
  let index = indexCache.get(values);
  if (index == null) {
    const subjects = new Map<string, number>();
    values.forEach((item, at) => subjects.set(item.subject, at));
    index = subjects;
    indexCache.set(values, index);
  }
  return index;
}
const find = <T extends Rec>(values: readonly T[], subject: string): T | null => {
  const at = indexOf(values).get(subject);
  return at == null ? null : values[at];
};

// P3-C14-CAPACITY=A と P3-C14-EVICT-OPERATION: 上限を超える報は (1) retainUntil を過ぎた記録 (2) 記憶（見えない記録） (3) training/test の見える記録
// (4) normal の見える記録、それぞれ ReportDateTime の古い順（同じなら subject の辞書順）で同じ slice の中から退去する。受ける報が training/test なら
// normal の記録は候補にせず、候補が無ければ null（受けた記録自身を退去する）。
// ponytail: 満杯の slice の素朴な線形の走査（上限 64 は保持と decode の両方で効く。台帳 47 の例外）。
// 第 1 段は受けた入力の根拠が verified のときだけ（P3-EF-AC03）。
function evictOne<T extends Rec>(values: readonly T[], now: number, incoming: Operation, verified: boolean): T | null {
  const tier = (item: Rec) => verified && item.retainUntil <= now ? 0 : !visible(item) ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: T | null = null;
  for (const item of values) {
    if (item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（P3-VM-AC03: subject ごとに compareVersion で比べ、報番号・InfoType の順位は使わない） ----

// 公開事実（重複の判定と見える記録の変化）。
const FACTS = ["effective", "endCause", "title", "name", "frames", "truncated", "activeUntil", "baseTime", "slotCount", "maxFiveDay", "prefectures", "areas"] as const;
function changed(before: Rec | null, value: Rec | null): string[] {
  const read = (record: Rec | null, field: string): unknown => record == null ? null : Object.getOwnPropertyDescriptor(record, field)?.value ?? null;
  return FACTS.filter((field) => !isDeepStrictEqual(read(before, field), read(value, field)));
}

// ---- 記録の組み立て（retainUntil・activeUntil は元報の ReportDateTime からの等式。decode も同じ関数で確かめる） ----

type Base = Readonly<{ subject: string; operation: Operation; source: ReportRef; unconfirmed?: ReportRef; notice?: NoticeMark }>;
// 未確認の印は記録が state から消えるまで持つ（見える期限で記憶になっても、解析の終わりで確率が終わっても残す、P3-VM-AC04）。通知の印も同じ（P3-NL-AC02 (4)）。
const baseOf = (value: Base): Base => ({ subject: value.subject, operation: value.operation, source: value.source,
  ...value.unconfirmed == null ? {} : { unconfirmed: value.unconfirmed }, ...value.notice == null ? {} : { notice: value.notice } });
const retainOf = (base: Base) => reportMs(base.source) + RETAIN;
const visibleOf = (base: Base) => reportMs(base.source) + VISIBLE;

const cancelledRecord = (base: Base): Analysis & Probability => ({ ...base, retainUntil: retainOf(base), effective: "cancelled" });
const endedRecord = (base: Base, endCause: "terminal" | "expired"): Analysis & Probability => ({ ...base, retainUntil: retainOf(base), effective: "ended", endCause });
const zeroRecord = (base: Base): Probability => ({ ...base, retainUntil: retainOf(base), effective: "zero" });
// unreadable は読めなかった所の印（P3-UM-AC01、候補の null は無し）。
type Marked = Readonly<{ unreadable?: UnreadableMark | null }>;
const markOf = (fact: Marked) => fact.unreadable == null ? {} : { unreadable: fact.unreadable };
const analysisActive = (base: Base, fact: Readonly<{ baseTime: number; title: string; name: TyphoonName; frames: readonly TyphoonFrame[]; truncated: boolean }> & Marked): Analysis =>
  ({ ...base, retainUntil: retainOf(base), effective: "active", activeUntil: visibleOf(base), baseTime: fact.baseTime, title: fact.title, name: fact.name,
    frames: fact.frames, truncated: fact.truncated, ...markOf(fact) });
const probabilityActive = (base: Base, fact: Readonly<{ baseTime: number; slotCount: number; title: string; name: TyphoonName; maxFiveDay: number;
  prefectures: readonly TyphoonPrefecture[]; areas: readonly TyphoonProbabilityArea[]; truncated: boolean }> & Marked): Probability =>
  ({ ...base, retainUntil: retainOf(base), effective: "active", activeUntil: visibleOf(base), baseTime: fact.baseTime, slotCount: fact.slotCount, title: fact.title,
    name: fact.name, maxFiveDay: fact.maxFiveDay, prefectures: fact.prefectures, areas: fact.areas, truncated: fact.truncated, ...markOf(fact) });

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// 名前の札。台風番号があれば「台風第N号（名前）」、無ければ「熱帯低気圧（EventID）」（旧築の notifyTyphoonAnalysis と同じ向き）。
function labelOf(name: TyphoonName, eventId: string): string {
  return name.number == null ? `熱帯低気圧（${eventId}）` : `台風第${Number(name.number.slice(-2))}号${name.name == null ? "" : `（${name.name}）`}`;
}
type Mark = "plain" | "correction" | "cancel";
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title。接頭辞は切る範囲の外に置き、本体だけを上限から引いた長さで切る（K5 の F15 の型）。
// 取消は取り消した記録の ReportDateTime（cancelledAt）を書く（P3-NL-AC10）。
function payloadOf(operation: Operation, level: Level, title: string, body: string, mark: Mark, cancelledAt: string | null = null): TyphoonNotificationPayload {
  if (mark === "cancel") {
    const words = cancelText(title, cancelledAt);
    return { domain: "weather", level, title: PREFIX[operation] + cut(words.title, NOTICE_BOUNDS.title - PREFIX[operation].length),
      body: cut(words.body, NOTICE_BOUNDS.body) };
  }
  const titleHead = PREFIX[operation] + (mark === "correction" ? "[訂正] " : "");
  const bodyHead = mark === "correction" ? "訂正: " : "";
  const text = bodyHead + cut(body === "" ? title : body, NOTICE_BOUNDS.body - bodyHead.length);
  return { domain: "weather", level, title: titleHead + cut(title, NOTICE_BOUNDS.title - titleHead.length), body: text };
}
// P3-NL-AC01: ID は世代番号を含まない。系列の印に同じ版の鍵と種類があれば作らない。
function intentsFor(source: Readonly<{ subject: string; operation: Operation; source: ReportRef }>, transition: TyphoonIntent["transition"],
  payload: TyphoonNotificationPayload, now: number, mark: NoticeMark | undefined, version: string): TyphoonIntent[] {
  if (noticed(mark, version, noticeKind(transition))) return [];
  // P3-C14-TRAINING=A: training/test は desktop だけ。
  const channels = source.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: noticeId("U-Y", source.subject, "", source.source, transition, channel), unit: "U-Y",
    subject: source.subject, operation: source.operation, source: source.source, transition, channel, payload, createdAt: now,
    expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending",
    ...freshState("U-Y", source.operation) }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-Y の intent は全部 other の群（P3-C14-NOTICE-GROUP）。
function a7Order(left: TyphoonIntent, right: TyphoonIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// Q-NOTICE.capacity と P3-C14-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、withdrawn の subject（取消・遅着・終わりの撤回）は全 pending を置き換える。
function admit(current: readonly TyphoonIntent[], fresh: readonly TyphoonIntent[], withdrawn: ReadonlySet<string>, replacing: readonly TyphoonIntent[] = fresh):
  Readonly<{ intents: readonly TyphoonIntent[]; admitted: readonly TyphoonIntent[]; dropped: number }> {
  const superseded = new Set<TyphoonIntent>();
  const replaced = new Set(replacing.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (withdrawn.has(item.subject) || replaced.has(`${item.subject}\n${item.channel}`)) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => !superseded.has(item)), ...fresh];
  const out = new Set<TyphoonIntent>();
  // 同じ群の中で A7 の選択順の後ろのものから外す。予約は配送の更新で伸びうる byte（P3-INTENT-UPDATE-RESERVE-001、式は写さない）。
  let count = pool.length, size = listBytes(pool) + pool.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  if (count > PENDING_ITEMS || size > PENDING_BYTES)
    for (const item of [...pool].sort(a7Order).reverse()) {
      if (count <= PENDING_ITEMS && size <= PENDING_BYTES) break;
      out.add(item);
      count--;
      size -= bytes(item) + 1 + deliveryGrowth(item);
    }
  const admitted = fresh.filter((item) => !out.has(item));
  // 新しい intent が容量で外れただけなら、既存の intent は変わらないので元の配列を返す。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  // P3-NL-AC05 (1)(2): 置換・退去した intent は外す（結果は系列の印に残り、終端記録の予算と回収は無い）。
  const intents = [...current.filter((item) => !superseded.has(item) && !out.has(item)), ...admitted];
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- outcome と view ----

function factsOf(value: Rec): Readonly<Record<string, JsonValue>> {
  if (value.effective === "ended") return { effective: value.effective, endCause: value.endCause };
  if (value.effective !== "active") return { effective: value.effective };
  if ("frames" in value) return { effective: value.effective, title: value.title, name: value.name, baseTime: value.baseTime, activeUntil: value.activeUntil,
    frames: value.frames, truncated: value.truncated };
  return { effective: value.effective, title: value.title, name: value.name, baseTime: value.baseTime, activeUntil: value.activeUntil, slotCount: value.slotCount,
    maxFiveDay: value.maxFiveDay, prefectures: value.prefectures, areas: value.areas, truncated: value.truncated };
}
function outcomeOf(value: Rec, changedFields: readonly string[]): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: factsOf(value), changedFields };
}
// view の subject は識別だけを持つ（事実は slice にあり、二重に載せると snapshot の予算を食う。U-L・U-R・U-B・U-M の先例）。
const outcomeCache = new WeakMap<Rec, SubjectOutcome>();
function shownOutcome(value: Rec): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) { found = { ...outcomeOf(value, []), facts: { effective: value.effective } }; outcomeCache.set(value, found); }
  return found;
}
function displaySubject(value: Rec): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-Y" }>> {
  return { unit: "U-Y", operation: value.operation, subject: value.subject, office: null, current: visible(value) ? shown(value) : null, subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C14-PARAMETERS.adoptionOutcome の順。一入力の変更は一回の参照交換で確定する、I-U-Y.subjects） ----

type Built<T extends Rec> = Readonly<{ record: T; late: boolean }>;
// 通知の機会（Q-NOTICE.generationTable）。transition は intent の遷移、mark は題・本文の前置き。
type Notice = Readonly<{ level: Level; mark: Mark; transition: TyphoonIntent["transition"]; body: string }>;
// 候補の型ごとの slice の読み書き・記録・通知の組み立て。見える期限を過ぎた報や台風の終わりの間の確率の報は late（記憶としてだけ採る、lateRule (2)）。
type Lane<T extends Rec, C extends TyphoonCandidate> = Readonly<{
  read: (state: State) => readonly T[];
  write: (state: State, values: readonly T[]) => State;
  // state が null のとき（重複の判定）は時計にも解析にも依らない形で組む。
  build: (candidate: C, now: number, state: State | null) => Built<T>;
  expire: (item: T) => T;
  notice: (candidate: C, existing: T | null, next: T, was: boolean) => Notice | null;
  // 見えない記録（記憶）に同じ版の報が来たとき、記憶の種類と食い違うか（事実を持たないので種類だけで比べる）。
  conflicts: (existing: T, candidate: C) => boolean;
}>;

const analysisSubject = (operation: Operation, eventId: string) => `${operation}/typhoonAnalysis/${eventId}`;
const probabilitySubject = (operation: Operation, eventId: string) => `${operation}/typhoonProbability/${eventId}`;

const summary = (frame: TyphoonFrame | undefined) => [frame?.category, frame?.intensity, frame?.size].map((part) => part ?? null);
const analysisLane: Lane<Analysis, AnalysisCandidate> = {
  read: (state) => state.analysis,
  write: (state, values) => ({ ...state, analysis: values }),
  build(candidate, now) {
    const base = { subject: candidate.subject, operation: candidate.operation, source: candidate.source };
    if (candidate.cancelled) return { record: cancelledRecord(base), late: false };
    const late = visibleOf(base) <= now;
    if (candidate.terminal) return { record: endedRecord(base, "terminal"), late };
    if (late) return { record: endedRecord(base, "expired"), late: true };
    return { record: analysisActive(base, candidate), late: false };
  },
  expire: (item) => endedRecord(baseOf(item), "expired"),
  // 終わりの記憶（terminal）と期限の記憶（expired）は、同じ版の報が台風の終わりかどうかで決まる。
  conflicts: (existing, candidate) => existing.effective === "ended" && (existing.endCause === "terminal") !== candidate.terminal,
  notice(candidate, existing, next, was) {
    // P3-NL-AC09 (1): 取消は active だったか、系列の印に通知の証拠があるとき（H19）。
    if (candidate.cancelled) return was || heard(existing?.notice) ? { level: "cancel", mark: "cancel", transition: "cancelled", body: "" } : null;
    const label = labelOf(candidate.name, candidate.eventId);
    if (next.effective === "ended") return was && candidate.terminal ? { level: "info", mark: "plain", transition: "released",
      body: [label, candidate.name.remark].filter((part) => part != null).join(" ") } : null;
    if (next.effective !== "active") return null;
    const correction = candidate.infoRank === 2;
    const now = next.frames.find((frame) => frame.kind === "analysis");
    const before = existing?.effective === "active" ? existing.frames.find((frame) => frame.kind === "analysis") : undefined;
    // 見える記録の実況の階級（category・intensity・size）の変化だけ。位置・予報だけの続報では作らない（P3-C14-NOTICE-LEVELS=A）。
    if (was && !correction && isDeepStrictEqual(summary(before), summary(now))) return null;
    return { level: "normal", mark: correction ? "correction" : "plain", transition: was ? "updated" : "activated",
      body: [label, ...[now?.category, now?.intensity, now?.size, now?.location].filter((part) => part != null)].join(" ") };
  },
};
const probabilityLane: Lane<Probability, ProbabilityCandidate> = {
  read: (state) => state.probability,
  write: (state, values) => ({ ...state, probability: values }),
  build(candidate, now, state) {
    const base = { subject: candidate.subject, operation: candidate.operation, source: candidate.source };
    if (candidate.cancelled) return { record: cancelledRecord(base), late: false };
    // P3-C14-TERMINAL=A: 同じ operation・TC番号の解析が terminal で ended の間は記憶としてだけ採る（P3-C14-TERMINAL-LATE）。
    const analysis = state == null ? null : find(state.analysis, analysisSubject(candidate.operation, candidate.eventId));
    if (analysis?.effective === "ended" && analysis.endCause === "terminal") return { record: endedRecord(base, "terminal"), late: true };
    const late = visibleOf(base) <= now;
    if (candidate.zero) return { record: zeroRecord(base), late };
    if (late) return { record: endedRecord(base, "expired"), late: true };
    return { record: probabilityActive(base, candidate), late: false };
  },
  expire: (item) => endedRecord(baseOf(item), "expired"),
  // zero の記憶に同じ版の全ゼロでない報が来たら食い違い（ended は事実の元が分からないので種類で比べない）。
  conflicts: (existing, candidate) => existing.effective === "zero" && !candidate.zero,
  notice(candidate, existing, next, was) {
    // P3-NL-AC09 (1): 取消は active だったか、系列の印に通知の証拠があるとき（H19）。
    if (candidate.cancelled) return was || heard(existing?.notice) ? { level: "cancel", mark: "cancel", transition: "cancelled", body: "" } : null;
    const label = labelOf(candidate.name, candidate.eventId);
    if (next.effective === "zero") return was ? { level: "info", mark: "plain", transition: "released", body: `${label} 暴風域に入る確率1%以上の地域なし` } : null;
    if (next.effective !== "active") return null;
    const correction = candidate.infoRank === 2;
    if (was && !correction && existing?.effective === "active" && existing.maxFiveDay === next.maxFiveDay) return null;
    const worst = next.areas.find((area) => area.daily[4] === next.maxFiveDay);
    const prefecture = next.prefectures.find((item) => item.code === worst?.prefectureCode);
    return { level: "normal", mark: correction ? "correction" : "plain", transition: was ? "updated" : "activated",
      body: `${label} 最大 ${next.maxFiveDay}%（${prefecture?.name ?? ""}/${worst?.name ?? ""}）` };
  },
};

const unchangedStep = (state: State, subject: string, operation: Operation, reason: "duplicate" | "stale" | "noChange", diagnostics: readonly DiagnosticDetails[] = []): Result =>
  ({ changes: [], step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason }], diagnostics } });

function receiveWith<T extends Rec, C extends TyphoonCandidate>(lane: Lane<T, C>, state: State, candidate: C, clock: ClockReading, basis: WallBasis): Result {
  const now = clock.wallTimeMs, recovering = candidate.source.origin === "recovery";
  const { subject, operation } = candidate;
  const values = lane.read(state);
  const at = indexOf(values).get(subject);
  const existing = at == null ? null : values[at];
  const built = lane.build(candidate, now, state);
  const warn = (missing: boolean): DiagnosticDetails => ({ level: "WARN", component: "typhoon", inputId: candidate.source.inputId, unit: "U-Y",
    reason: missing ? "requiredStructureMissing" : "typhoonRevisionConflict" });
  // 取消以前の版は stale で、取消した subject を戻さない。同じ版は、見える記録なら InfoType と事実が同じで duplicate・違えば先着を保って印を付ける
  // （P3-VM-AC04）。正規化した InfoType の一致は見える記録と見えない記録に共通の条件（U-M と同じ、D-SAME-REPORT）。見えない記録（記憶）は事実を
  // 持たないので、記憶の種類が同じなら duplicate（復活させない）。重複の判定は遅着の判定より先なので、時計にも解析の終わりにも依らない記録の形と
  // 比べる。印は保存の byte に入るが、上界が予算の内側なので fit を要さない（P3-VM-AC08）。
  const version = stepVersion(existing == null ? null : { version: existing.source, source: existing.source, cancelled: existing.effective === "cancelled" },
    existing?.unconfirmed ?? null, candidate.source, () => existing != null && existing.source.infoTypeRaw.trim() === candidate.source.infoTypeRaw.trim()
      && (visible(existing) ? changed(existing, lane.build(candidate, -Infinity, null).record).length === 0 : !lane.conflicts(existing, candidate)), candidate.cancelled);
  if (version.kind !== "adopt") {
    if (version.kind !== "held") return unchangedStep(state, subject, operation, version.kind === "duplicate" ? "duplicate" : "stale");
    // P3-REC-AC12（C16 発注 4b-1）: 取り直しの版の決まらない本文は印も WARN も置かずに noChange（owner が held と読む、P3-REC-AC05 の (a)）。
    if (recovering) return unchangedStep(state, subject, operation, "noChange");
    const marked = existing == null || version.mark == null || existing.unconfirmed === version.mark ? state : { ...lane.write(state,
      values.map((item, position) => position === at ? { ...item, unconfirmed: version.mark } : item)), persistence: dirty(state.persistence, clock.monotonicMs) };
    return unchangedStep(marked, subject, operation, "stale", [warn(version.missing)]);
  }
  const unmarked = version.mark == null ? built.record : { ...built.record, unconfirmed: version.mark };
  // P3-NL-AC02 (2)(4): 通知の印は記録へ引き継ぐ。
  let next: T = existing?.notice == null ? unmarked : { ...unmarked, notice: existing.notice };
  // P3-C14-RETENTION.lateRule（版の比較の後）: (1) 記憶の期限を過ぎた報は state を変えない。(3) 記憶としてだけ採る報で、subject に記録が無く
  // slice が満杯なら記録を作らず、退去も起こさない。(2) 記憶としてだけ採る報は、前の見える記録を終わらせて pending を撤回する。
  if (next.retainUntil <= now) return unchangedStep(state, subject, operation, "stale");
  const full = at == null && values.length >= LIMITS.subjects;
  if (built.late && full) return unchangedStep(state, subject, operation, "stale");
  const withdrawn = new Set<string>();
  if (candidate.cancelled || built.late && visible(existing)) withdrawn.add(subject);

  let evicted: T | null = null;
  const evictedDiagnostic: DiagnosticDetails = { level: "INFO", component: "typhoon", reason: "typhoonCapacityEvicted", unit: "U-Y", count: 1 };
  let kept = values;
  if (full) {
    evicted = evictOne(values, now, operation, basis === "verified");
    // training/test の報で退去できる記録が無ければ、受けた記録自身を退去する（slice の参照を変えない、通知しない）。採用した取消は
    // その subject の pending を置き換え、intents が変わったときだけ保存世代を進める。
    if (evicted == null) {
      const notices = admit(state.intents, [], withdrawn);
      const result = notices.intents === state.intents ? state : { ...state, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };
      return { changes: [], step: { ...idle(result), decisions: [{ subject, operation, decision: "changed", reason: null, change: "revisionOnly", currentEstablished: null }],
        outcomes: [{ kind: "accepted", change: "revisionOnly", subjects: [] }], diagnostics: [evictedDiagnostic] } };
    }
    const gone = evicted;
    kept = values.filter((item) => item !== gone);
  }
  const slice: readonly T[] = existing == null ? [...kept, next] : values.map((item, position) => position === at ? next : item);
  let written = lane.write(state, slice);

  // P3-C14-TERMINAL=A: 解析の終わりの報は、同じ operation・TC番号の確率の見える記録を無音で終わらせる（件数は変えない、退去ではない）。
  const changes: Change[] = [];
  const decisions: Decision[] = [];
  let endedProbability: Probability | null = null;
  if (candidate.slice === "analysis" && next.effective === "ended" && next.endCause === "terminal") {
    const other = find(state.probability, probabilitySubject(operation, candidate.eventId));
    if (other?.effective === "active") {
      const replacement: Probability = endedRecord(baseOf(other), "terminal");
      endedProbability = replacement;
      written = { ...written, probability: state.probability.map((item) => item === other ? replacement : item) };
      withdrawn.add(other.subject);
      changes.push([other, replacement]);
    }
  }

  // Q-NOTICE.generationTable（自分の subject だけ、一 channel 1 件）。訂正は事実が同じでも作る。記憶としてだけ採る報では作らない。
  const was = visible(existing), now_ = visible(next);
  const notice = built.late ? null : lane.notice(candidate, existing, next, was);
  // 版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const digest = notice == null ? "" : versionDigest(candidate.source);
  const fresh = notice == null ? [] : intentsFor(candidate, notice.transition, payloadOf(operation, notice.level, candidate.title, notice.body, notice.mark,
    existing?.source.reportDateTimeRaw ?? null), now, existing?.notice, digest);
  // 取り直しは intent を作らず、live の新しい intent が置き換える古い pending だけを外す（P3-REC-D-UNIT-ENTRANCE=A）。
  const notices = admit(state.intents, recovering ? [] : fresh, withdrawn, fresh);
  // P3-NL-AC02 (3): admit を通った版と種類を系列の印に足す（全 channel が断られた版は入れない）。
  if (notice != null && notices.admitted.length !== 0) {
    const plain = next;
    next = { ...plain, notice: markNotice(plain.notice, digest, noticeKind(notice.transition)) };
    written = lane.write(written, lane.read(written).map((item) => item === plain ? next : item));
  }
  let result: State = { ...written, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) };
  // P3-UM-AC03 (3): 原文の合計（二つの slice の和）が予算を越えたら古い記録の原文から外す（印は残る）。外した記録の view も変わるので表示の変化に足す。
  const slices = result;
  const fit = fitRawBudget<Rec>(rawTotal(slices.analysis, slices.probability), RAW_BUDGET, () => [...slices.analysis, ...slices.probability],
    (item) => [reportMs(item.source), item.subject]);
  const stripped: Change[] = [];
  if (fit != null) {
    const own: Rec = next;
    const strip = <R extends Rec>(values: readonly R[]): readonly R[] => values.map((item) => {
      const after = stripRaw(item, fit);
      if (after !== item && item.subject !== own.subject) stripped.push([item, after]);
      return after;
    });
    result = { ...result, analysis: strip(result.analysis), probability: strip(result.probability) };
    const values = lane.read(result);
    next = values.find((item) => item.subject === subject) ?? next;
  }

  // change は最終の表示の変化で決める（I-U-Y.currentSemantics(5)）。accepted は最終の状態に残る subject（今回の記録）。
  const shownChange = was !== now_ || was && changed(existing, next).length !== 0;
  const kind = evicted != null || shownChange ? "semantic" as const : "revisionOnly" as const;
  decisions.push({ subject, operation, decision: "changed", reason: null, change: kind,
    currentEstablished: { family: candidate.headType, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } });
  if (endedProbability != null) decisions.push({ subject: endedProbability.subject, operation, decision: "changed", reason: null, change: "semantic", currentEstablished: null });
  const diagnostics: DiagnosticDetails[] = version.missing ? [warn(true)] : [];
  if (evicted != null) diagnostics.push(evictedDiagnostic);
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "typhoon", reason: "notificationCapacityEvicted", unit: "U-Y", count: notices.dropped });
  const dropped = droppedIn(fit, [...result.analysis, ...result.probability]);
  if (dropped !== 0) diagnostics.push({ level: "INFO", component: "typhoon", reason: "unreadableDropped", unit: "U-Y", count: dropped });
  const replaced: Change = existing == null ? [null, next] : [existing, next];
  return {
    changes: [...evicted == null ? [] : [[evicted, null] satisfies Change], replaced, ...changes, ...stripped],
    step: { state: result, nextDeadline: nextDeadline(result), decisions, intents: notices.admitted,
      outcomes: [{ kind: "accepted", change: endedProbability == null ? kind : "semantic", subjects: [outcomeOf(next, changed(existing, next)),
        ...endedProbability == null ? [] : [outcomeOf(endedProbability, ["effective"])]] }], diagnostics },
  };
}

function receive(state: State, input: Extract<TyphoonInput, { kind: "receive" }>): Result {
  const parsed = parseTyphoon(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason, ...parsed.areas == null ? {} : { areas: parsed.areas } }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // P3-REC-AC12（C16 発注 4b-1）・P3-C14-N2: origin=recovery は候補の作成のときだけ owner から届く。意味を当てて intent を作らない（H27 は無し、
  // P3-REC-D-N2-RAISE-4B=A）。
  const basis = input.basis ?? "verified";
  return candidate.slice === "analysis" ? receiveWith(analysisLane, state, candidate, input.clock, basis)
    : receiveWith(probabilityLane, state, candidate, input.clock, basis);
}

// ---- 期限（I-U-Y.deadlines。到来分だけを移行・回収する。到来の処理は無音） ----

// 時計の根拠ごとに（P3-EF-AC02）、unverified は見える期限の来た active に保留の印を付けるだけ。verified は見える期限の来た active と保留の記録
// （時計によらず）を ended にし、retainUntil の到来で記録を除く。awaiting は呼ばない（collect が同じ参照を返す）。
// ponytail: 全 subject の同時の期限だけが一括の回収になる（上限は件数の上限 64 で、保持と decode の両方で効く）。
function sweep<T extends Rec>(values: readonly T[], now: number, verified: boolean, expire: (item: T) => T):
  Readonly<{ values: readonly T[]; changes: readonly Change[] }> {
  if (displayMin(values) > now && !(verified && (recallMin(values) <= now || pendingMin(values) !== Infinity))) return { values, changes: [] };
  const changes: Change[] = [];
  const next = values.flatMap((item) => {
    if (item.effective === "active" && (item.expiryPending === true || deadlineOf(item) <= now)) {
      if (!verified) {
        if (item.expiryPending === true) return [item];
        const marked: T = { ...item, expiryPending: true };
        changes.push([item, marked]);
        return [marked];
      }
      // 見える期限と retainUntil が同時に来た active も、先に ended に移して見えなくなる変化（decision・outcome）を残してから除く。
      const moved = expire(item);
      changes.push([item, moved]);
      if (moved.retainUntil > now) return [moved];
      changes.push([moved, null]);
      return [];
    }
    if (verified && item.retainUntil <= now) { changes.push([item, null]); return []; }
    return [item];
  });
  return { values: next, changes };
}

function collect(state: State, clock: ClockReading, basis: WallBasis, withIntents: boolean): Readonly<{ state: State; changes: readonly Change[];
  expiredIntents: number }> {
  const now = clock.wallTimeMs, verified = basis === "verified";
  if (basis === "awaiting" || deadlineAt(state) > now && !(verified && (pendingMin(state.analysis) !== Infinity || pendingMin(state.probability) !== Infinity)))
    return { state, changes: [], expiredIntents: 0 };
  const analysis = sweep(state.analysis, now, verified, analysisLane.expire), probability = sweep(state.probability, now, verified, probabilityLane.expire);
  const intents = !withIntents || !verified || intentMin(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - intents.length;
  const persisted = analysis.changes.length !== 0 || probability.changes.length !== 0 || intents !== state.intents;
  if (!persisted) return { state, changes: [], expiredIntents: 0 };
  return { state: { ...state, analysis: analysis.values, probability: probability.values, intents, persistence: dirty(state.persistence, clock.monotonicMs) },
    changes: [...analysis.changes, ...probability.changes], expiredIntents };
}

function deadlineStep(state: State, clock: ClockReading, basis: WallBasis): Result {
  const applied = collect(state, clock, basis, true);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "typhoon", reason: "notificationExpired",
    unit: "U-Y", count: applied.expiredIntents }];
  // 見えなくなる移行だけが changed/semantic（O08:4・O08:29）。除去は無音。保留の印を付けた移行は記録の事実が残るので outcome に載せない。
  const ended = applied.changes.flatMap(([before, after]) => visible(before) && after != null && after.effective !== "active" ? [after] : []);
  return { changes: applied.changes, step: { ...idle(applied.state),
    decisions: ended.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "semantic" as const, currentEstablished: null })),
    outcomes: ended.length === 0 ? [] : [{ kind: "deadlineApplied", subjects: ended.map((item) => outcomeOf(item, ["effective"])) }], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

// P3-NL-AC02 (3)・AC08 (1): intent の系列（解析か確率）の印の証拠を上げる（下げない）。
function raiseNotices(state: State, raised: ReadonlyMap<string, NoticeEvidence>): State {
  if (raised.size === 0) return state;
  const raise = <T extends Rec>(values: readonly T[]): readonly T[] => {
    let touched = false;
    const next = values.map((item) => {
      const evidence = raised.get(item.subject);
      const notice = evidence == null || item.notice == null ? item.notice : raiseEvidence(item.notice, evidence);
      if (notice === item.notice) return item;
      touched = true;
      return { ...item, notice };
    });
    return touched ? next : values;
  };
  const analysis = raise(state.analysis), probability = raise(state.probability);
  return analysis === state.analysis && probability === state.probability ? state : { ...state, analysis, probability };
}

function intentUpdate(state: State, input: Extract<TyphoonInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, TyphoonIntent>();
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
  // 所有配列は一括で索引化して一度だけ置き換える。pending でなくなった intent は外す（P3-NL-AC05 (1)）。
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

// Q-NOTICE.restart・I-U-Y.restore: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。先に retainUntil を過ぎた記録を除き、
// 残る active のうち見える期限を過ぎたものを無音で ended にする。どちらかが起きれば保存世代を進める。
// intent の期限切れの回収は復元の後の最初の期限処理で行う。
function restore(state: State, persisted: PersistedTyphoonUnit, clock: ClockReading, basis: WallBasis): Result {
  const decoded = typhoonUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "typhoon",
    reason: "requiredStructureInvalid", unit: "U-Y" }] } };
  // P3-NL-AC08 (1): started のまま残った pending は通知したか不明として外し、系列の印の証拠を unknown にする。
  const restored = restoreStarted(decoded.state.intents);
  const base = { ...raiseNotices(decoded.state, new Map(restored.started.map((item) => [item.subject, "unknown" as const]))),
    intents: restored.intents, contentRevision: state.contentRevision,
    persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const applied = collect(base, clock, basis, false);
  const active = [...applied.state.analysis, ...applied.state.probability].filter(visible);
  return { changes: active.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-Y"], coverage: active.map((item) => item.subject), subjects: [] }],
    diagnostics: restored.started.length === 0 ? [] : [{ level: "INFO", component: "typhoon", reason: "notificationOutcomeUnknown",
      unit: "U-Y", count: restored.started.length }] } };
}

function reduceCore(state: State, input: TyphoonInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock, input.basis ?? "verified");
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, input.basis ?? "verified");
    // 閉じる batch・相関待ちを持たないので、終了入力は同じ state を返す（types.ts の TyphoonInput）。
    case "shutdown": return { changes: [], step: { ...idle(state), outcomes: [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] } };
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`typhoon input ${String(missing)} is not handled`); }
  }
}

function reduceTyphoonUnit(state: State, input: TyphoonInput): TyphoonUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: Rec | null; after: Rec | null; operation: Operation }>();
  for (const pair of changes) {
    const [before, value] = pair;
    const { subject: key, operation } = target(pair);
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after: value, operation });
  }
  const displayChanges: TyphoonUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after: value, operation }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(value) ? value : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-Y", operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-Y content revision exhausted");
  // P3-C14-N2: U-Y は確認 scope を作らない。
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toTyphoonView(state: State): TyphoonUnitView {
  const analysis = state.analysis.filter(visible), probability = state.probability.filter(visible);
  const subjects = [...analysis, ...probability].map(shownOutcome);
  return { unit: "U-Y", semanticRevision: subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`).sort().join("|"),
  contentRevision: String(state.contentRevision), subjects, analysis: analysis.map((item) => shown(item)),
  probability: probability.map((item) => shown(item)) };
}

// ---- codec（I-U-Y.persisted・I-U-Y.decode、唯一の TyphoonUnitCodec。受理と同じ上限を確かめる） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const bounded = (value: unknown, limit: number): value is string => isText(value) && value.length <= limit;
const boundedName = (value: unknown, limit: number): value is string => bounded(value, limit) && validName(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// 記録の時刻（validTime・baseTime）は Date.parse が作る整数（|t| ≤ 8.64e15）だけ。任意の double を通すと世代が静的上界を超える（I-U-Y.capacityReserve）。
// intent の時刻は owner の小数の時計が入るので finite（byte は pending の予約と終端記録の上限で数える、I-U-Y.decode）。
const instant = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(Number(value)) <= 8.64e15;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
// 0〜max の整数。
const whole = (value: unknown, max: number): value is number => count(value) && Number(value) <= max;
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null, limit = Infinity): T[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}
// null か検査を通した値。外れは undefined。
function maybe<T>(value: unknown, parse: (entry: unknown) => T | undefined): T | null | undefined {
  return value === null ? null : parse(value);
}
const textOf = (limit: number) => (value: unknown): string | undefined => boundedName(value, limit) ? value : undefined;
const wholeOf = (max: number) => (value: unknown): number | undefined => whole(value, max) ? value : undefined;

type SubjectParts = Readonly<{ operation: Operation; slice: "analysis" | "probability" }>;
// I-U-Y.subjects の形（Q-ENUM.identity の文字と長さ）。
function subjectParts(subject: string): SubjectParts | null {
  const head = /^(normal|training|test)\/(typhoonAnalysis|typhoonProbability)\/([\s\S]*)$/.exec(subject);
  const operation = operationOf(head?.[1]);
  return head == null || operation == null || !validEventId(head[3]) ? null : { operation, slice: head[2] === "typhoonAnalysis" ? "analysis" : "probability" };
}
function reportRef(value: unknown, subject: string, parts: SubjectParts): ReportRef | null {
  const ref = readReportRef(value);
  if (ref == null || ref.subject !== subject || parts.operation !== ref.operation
    || !validReportDateTime(ref.reportDateTimeRaw) || ref.serialRaw !== "" && !validSerial(ref.serialRaw) || infoRankOf(ref.infoTypeRaw) == null) return null;
  const family = (parts.slice === "analysis" ? ANALYSIS_TYPES : PROBABILITY_TYPES).find((item) => item === ref.family);
  return family == null ? null : ref;
}

// 呼称（number は台風番号の数字 4 桁か null）。
function nameRecord(value: unknown): TyphoonName | null {
  const row = record(value);
  if (row == null) return null;
  const name = maybe(row.name, textOf(BOUNDS.name)), nameKana = maybe(row.nameKana, textOf(BOUNDS.nameKana)), remark = maybe(row.remark, textOf(BOUNDS.remark));
  const number = maybe(row.number, (entry) => isText(entry) && /^\d{4}$/.test(entry) ? entry : undefined);
  return name === undefined || nameKana === undefined || remark === undefined || number === undefined ? null : { name, nameKana, number, remark };
}
// 緯度経度は小数 1 桁で範囲の内側（R50）。
const tenth = (value: unknown, limit: number): value is number => finite(value) && Math.abs(value) <= limit && Math.round(value * 10) / 10 === value;
function pointRecord(value: unknown): TyphoonPoint | undefined {
  const row = record(value);
  return row != null && tenth(row.latitude, 90) && tenth(row.longitude, 180) ? { latitude: row.latitude, longitude: row.longitude } : undefined;
}
function axisRecord(value: unknown): TyphoonWindAxis | null {
  const row = record(value);
  const direction = maybe(row?.direction, textOf(BOUNDS.direction)), radiusKm = maybe(row?.radiusKm, wholeOf(9999));
  return row == null || direction === undefined || radiusKm === undefined ? null : { direction, radiusKm };
}
function windAreaRecord(value: unknown): TyphoonWindArea | undefined {
  const row = record(value);
  const thresholdMs = maybe(row?.thresholdMs, wholeOf(999)), axes = list(row?.axes, axisRecord, LIMITS.axes);
  return row == null || thresholdMs === undefined || axes == null ? undefined : { thresholdMs, axes };
}
const FRAME_KINDS: readonly TyphoonFrameKind[] = ["analysis", "estimate", "forecast", "extendedForecast"];
function frameRecord(value: unknown): TyphoonFrame | null {
  const row = record(value);
  const kind = FRAME_KINDS.find((item) => item === row?.kind);
  if (row == null || kind == null || !whole(row.hours, 120) || !instant(row.validTime)) return null;
  // hours は時刻の種類と合う（実況 0・推定 1・予報と延長予報 3〜120）。予報円の半径は予報・延長予報だけ。
  const forecast = kind === "forecast" || kind === "extendedForecast";
  if (kind === "analysis" ? row.hours !== 0 : kind === "estimate" ? row.hours !== 1 : row.hours < 3) return null;
  const category = maybe(row.category, textOf(BOUNDS.category)), intensity = maybe(row.intensity, textOf(BOUNDS.intensity)), size = maybe(row.size, textOf(BOUNDS.size));
  const center = maybe(row.center, pointRecord), circleRadiusKm = maybe(row.circleRadiusKm, wholeOf(9999)), location = maybe(row.location, textOf(BOUNDS.location));
  const moveDirection = maybe(row.moveDirection, textOf(BOUNDS.direction)), moveSpeedKmh = maybe(row.moveSpeedKmh, wholeOf(999));
  const moveCondition = maybe(row.moveCondition, textOf(BOUNDS.condition)), pressureHpa = maybe(row.pressureHpa, wholeOf(9999));
  const maxWindMs = maybe(row.maxWindMs, wholeOf(999)), maxGustMs = maybe(row.maxGustMs, wholeOf(999));
  const storm = maybe(row.storm, windAreaRecord), gale = maybe(row.gale, windAreaRecord), stormWarning = maybe(row.stormWarning, windAreaRecord);
  if (category === undefined || intensity === undefined || size === undefined || center === undefined || circleRadiusKm === undefined || location === undefined
    || moveDirection === undefined || moveSpeedKmh === undefined || moveCondition === undefined || pressureHpa === undefined || maxWindMs === undefined
    || maxGustMs === undefined || storm === undefined || gale === undefined || stormWarning === undefined || !forecast && circleRadiusKm != null) return null;
  return { kind, hours: row.hours, validTime: row.validTime, category, intensity, size, center, circleRadiusKm, location, moveDirection, moveSpeedKmh,
    moveCondition, pressureHpa, maxWindMs, maxGustMs, storm, gale, stormWarning };
}
function areaRecord(slots: number): (value: unknown) => TyphoonProbabilityArea | null {
  return (value) => {
    const row = record(value);
    const daily = list(row?.daily, (entry) => whole(entry, 100) ? entry : null, 5);
    const peakSlot = row?.peakSlot === null ? null : whole(row?.peakSlot, slots - 1) ? row?.peakSlot : undefined;
    if (row == null || daily == null || daily.length !== 5 || !isText(row.code) || !validCode6(row.code) || !boundedName(row.name, BOUNDS.areaName)
      || !isText(row.prefectureCode) || !validCode6(row.prefectureCode) || !whole(row.peak, 100) || peakSlot === undefined) return null;
    // 3 時間ごとの確率が全部 0 なら peak 0・peakSlot null。持つのは 1 以上の値のある地域だけ。
    if ((row.peak === 0) !== (peakSlot === null) || row.peak === 0 && daily.every((entry) => entry === 0)) return null;
    return { code: row.code, name: row.name, prefectureCode: row.prefectureCode, daily, peak: row.peak, peakSlot };
  };
}
const ascending = (codes: readonly string[]): boolean => codes.every((code, index) => index === 0 || codes[index - 1] < code);

// 枝ごとに持ってよい事実の field（types.ts の判別共用体）。ほかの枝の field を持つ保存物は拒む。
const FACT_KEYS = ["activeUntil", "baseTime", "title", "name", "frames", "truncated", "slotCount", "maxFiveDay", "prefectures", "areas", "endCause",
  "expiryPending", "unreadable"] as const;
const BRANCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  "analysis/active": ["activeUntil", "baseTime", "title", "name", "frames", "truncated", "expiryPending", "unreadable"],
  "probability/active": ["activeUntil", "baseTime", "slotCount", "title", "name", "maxFiveDay", "prefectures", "areas", "truncated", "expiryPending", "unreadable"],
  "analysis/ended": ["endCause"], "probability/ended": ["endCause"],
};
type Head = Readonly<{ row: Fields; parts: SubjectParts; base: Base }>;
function headOf(value: unknown, slice: "analysis" | "probability"): Head | null {
  const row = record(value);
  const parts = isText(row?.subject) ? subjectParts(row.subject) : null;
  if (row == null || parts == null || parts.slice !== slice || !isText(row.subject) || parts.operation !== operationOf(row.operation)) return null;
  const source = reportRef(row.source, row.subject, parts);
  if (source == null) return null;
  const allowed = BRANCH_KEYS[`${slice}/${String(row.effective)}`] ?? [];
  if (FACT_KEYS.some((key) => key in row && !allowed.includes(key))) return null;
  // P3-VM-AC04: 印は同じ subject・operation の報（取消の後の時刻の無い報の印も残る）。
  const mark = "unconfirmed" in row ? reportRef(row.unconfirmed, row.subject, parts) : undefined;
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  // P3-EF-AC05 (1): 保留の印の値は true だけ（置ける枝は BRANCH_KEYS が active に限る）。
  return mark === null || notice === null || "expiryPending" in row && row.expiryPending !== true ? null : { row, parts, base: { subject: row.subject, operation: parts.operation, source,
    ...mark == null ? {} : { unconfirmed: mark }, ...notice == null ? {} : { notice } } };
}
// P3-UM-AC01 (2): 印の site の表（TyphoonUnreadableSite）。欄が無ければ undefined、形の外は null。
const UNREADABLE_SITES: ReadonlySet<string> = new Set(["axis", "frame", "section", "slot", "area"] satisfies readonly TyphoonUnreadableSite[]);
const unreadableOf = (row: Fields): UnreadableMark | null | undefined => "unreadable" in row ? readUnreadableMark(row.unreadable, UNREADABLE_SITES) : undefined;
// 記憶（cancelled・ended）の枝。active でないときだけ呼ぶ。
function memoryRecord(row: Fields, base: Base): (Analysis & Probability) | null {
  if (row.effective === "cancelled") return cancelledRecord(base);
  return row.effective === "ended" && (row.endCause === "terminal" || row.endCause === "expired") ? endedRecord(base, row.endCause) : null;
}
function analysisRecord(value: unknown): Analysis | null {
  const head = headOf(value, "analysis");
  if (head == null) return null;
  const { row, base } = head;
  let built: Analysis | null = null;
  if (row.effective === "active") {
    const frames = list(row.frames, frameRecord, LIMITS.frames), name = nameRecord(row.name), unreadable = unreadableOf(row);
    // 実況の時刻がちょうど 1 個。activeUntil は ReportDateTime ＋ 12 時間（P3-C14-EXPIRY=A）。
    if (frames != null && name != null && unreadable !== null && frames.filter((frame) => frame.kind === "analysis").length === 1 && instant(row.baseTime)
      && boundedName(row.title, BOUNDS.title) && typeof row.truncated === "boolean" && row.activeUntil === visibleOf(base))
      built = { ...analysisActive(base, { baseTime: row.baseTime, title: row.title, name, frames, truncated: row.truncated, unreadable }),
        ...row.expiryPending === true ? { expiryPending: true } : {} };
  } else built = memoryRecord(row, base);
  return built != null && row.retainUntil === built.retainUntil ? built : null;
}
function probabilityRecord(value: unknown): Probability | null {
  const head = headOf(value, "probability");
  if (head == null) return null;
  const { row, base } = head;
  let built: Probability | null = null;
  if (row.effective === "active") {
    const slotCount = whole(row.slotCount, LIMITS.slots) && row.slotCount >= 1 ? row.slotCount : null;
    const areas = slotCount == null ? null : list(row.areas, areaRecord(slotCount), LIMITS.areas);
    const prefectures = list(row.prefectures, (entry): TyphoonPrefecture | null => {
      const item = record(entry);
      return item != null && isText(item.code) && validCode6(item.code) && boundedName(item.name, BOUNDS.areaName) ? { code: item.code, name: item.name } : null;
    }, LIMITS.prefectures);
    const name = nameRecord(row.name), unreadable = unreadableOf(row);
    if (slotCount != null && areas != null && areas.length !== 0 && prefectures != null && name != null && unreadable !== null && instant(row.baseTime)
      && boundedName(row.title, BOUNDS.title)
      && typeof row.truncated === "boolean" && row.activeUntil === visibleOf(base) && ascending(areas.map((area) => area.code))
      && ascending(prefectures.map((item) => item.code)) && row.maxFiveDay === Math.max(...areas.map((area) => area.daily[4])) && whole(row.maxFiveDay, 100)
      && row.maxFiveDay >= 1 && isDeepStrictEqual(prefectures.map((item) => item.code), [...new Set(areas.map((area) => area.prefectureCode))].sort()))
      built = { ...probabilityActive(base, { baseTime: row.baseTime, slotCount, title: row.title, name, maxFiveDay: row.maxFiveDay, prefectures, areas,
        truncated: row.truncated, unreadable }), ...row.expiryPending === true ? { expiryPending: true } : {} };
  } else built = row.effective === "zero" ? zeroRecord(base) : memoryRecord(row, base);
  return built != null && row.retainUntil === built.retainUntil ? built : null;
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "cancel"];
function intentRecord(value: unknown): TyphoonIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const parts = isText(row?.subject) ? subjectParts(row.subject) : null;
  const source = isText(row?.subject) && parts != null ? reportRef(row.source, row.subject, parts) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-Y", operation, level);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-Y.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || payload.domain !== "weather" || channel == null || transition == null
    || fields == null || !isText(row.id) || row.unit !== "U-Y" || !isText(row.subject) || source.operation !== operation
    || !bounded(payload.title, NOTICE_BOUNDS.title) || payload.title === "" || !bounded(payload.body, NOTICE_BOUNDS.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-Y", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition: "pending", ...fields };
}
function persisted(value: unknown): PersistedTyphoonUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const analysis = list(row.analysis, analysisRecord, LIMITS.subjects), probability = list(row.probability, probabilityRecord, LIMITS.subjects);
  const intents = list(row.intents, intentRecord);
  if (analysis == null || probability == null || intents == null) return null;
  // slice 内の subject の重複なし。
  for (const rows of [analysis, probability])
    if (new Set(rows.map((item) => item.subject)).size !== rows.length) return null;
  if (new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。保存する intent は pending だけ（P3-NL-AC05）。
  const pendingBytes = listBytes(intents) + intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedTyphoonUnit = { schemaVersion: SCHEMA, analysis, probability, intents };
  // P3-UM-AC16 (3)(c): 原文の合計（AC03 (1) の数え方）が予算の内。
  if (intents.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || generationBytes(result) > GENERATION_LIMIT
    || rawTotal(analysis, probability) > RAW_BUDGET) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const typhoonUnitCodec: TyphoonUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p3-typhoon-unit-v1", "p3-typhoon-unit-v2", "p3-typhoon-unit-v3", "p3-typhoon-unit-v4", "p3-typhoon-unit-v5", "p3-typhoon-unit-v6"], maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  // contentRevision・persistence は保存しない（I-U-Y.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, analysis: state.analysis, probability: state.probability, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: `invalid ${SCHEMA} payload` }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-Y.runtimeRows）。
const typhoonUnit = {
  unit: "U-Y",
  reduce: reduceTyphoonUnit,
  toView: toTyphoonView,
  persistence: { kind: "durable", codec: typhoonUnitCodec },
  confirmationScopeLimit: LIMITS.subjects * 2,
  reclaimDeadlineBeforeReceive: true,
  recoveryChanges,
} satisfies UnitModule<"U-Y">;

// P3-REC-AC07（投影の直し、Q-REC-PRECHECK-7 の N2）: 取り直しの採用の step の正味の表示の変化（採用の直前の live → 最終の state）。
// 両状態の記録を鍵の Map で突き合わせ、reduce の merged の loop と同じ述語・displaySubject・鍵で作る。同じ参照の記録は省く（O(N前＋N後)）。
function recoveryChanges(before: State, after: State): TyphoonUnitStep["displayChanges"] {
  const old = new Map<string, Rec>();
  for (const item of before.analysis) old.set(item.subject, item); for (const item of before.probability) old.set(item.subject, item);
  const changes: TyphoonUnitStep["displayChanges"][number][] = [];
  const add = (was: Rec | null, now: Rec | null) => {
    const shownBefore = visible(was) ? was : null, shownAfter = visible(now) ? now : null;
    if (shownBefore === shownAfter) return;
    const value = (now ?? was)!;
    changes.push({ unit: "U-Y", operation: value.operation, subject: value.subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  };
  for (const item of [...after.analysis, ...after.probability]) { add(old.get(item.subject) ?? null, item); old.delete(item.subject); }
  for (const item of old.values()) add(item, null);
  return changes;
}

export { generationBytes, recoveryChanges, reduceTyphoonUnit, toTyphoonView, typhoonUnit, typhoonUnitCodec };
