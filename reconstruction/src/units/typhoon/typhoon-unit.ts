import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline, SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  PersistedTyphoonUnit, TyphoonAnalysisRecord, TyphoonFrame, TyphoonFrameKind, TyphoonInput, TyphoonIntent, TyphoonName, TyphoonNotificationPayload,
  TyphoonPoint, TyphoonPrefecture, TyphoonProbabilityArea, TyphoonProbabilityRecord, TyphoonUnitCodec, TyphoonUnitState, TyphoonUnitStep, TyphoonUnitView,
  TyphoonWindArea, TyphoonWindAxis,
} from "../../../contracts/p3-typhoon-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { ANALYSIS_TYPES, BOUNDS, LIMITS, PROBABILITY_TYPES, RETAIN, VISIBLE, parseTyphoon, validCode6, validEventId } from "../../domains/typhoon/typhoon";
import type { AnalysisCandidate, ProbabilityCandidate, TyphoonCandidate } from "../../domains/typhoon/typhoon";
import { cut, infoRankOf, validInputId, validName, validReportDateTime, validSerial } from "../../domains/flood/flood";

// P3-UNIT-Y-001（C14、I-U-Y）: 二つの slice（analysis・probability）の current・版・遅着・退去・通知・容量・codec・射影。
// 二つの slice は件数の上限と退去を別々に持つ（無いと訓練の確率の多発が解析の記録を退去する、I-U-Y.slices）。

const SCHEMA = "p3-typhoon-unit-v1" as const;
// P3-C14-RES-01・RET-04。
const GENERATION_LIMIT = 8_388_608;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 98_304;
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
// view に載るのは active だけ（I-U-Y.view）。
function visible<T extends Rec>(value: T | null): value is Extract<T, Readonly<{ effective: "active" }>> {
  return value?.effective === "active";
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
// 終端記録の合計（区切りの 1 byte を含む）。受理と decode で同じ式を使う（Q-NOTICE.capacity）。
const terminalBytes = (intents: readonly TyphoonIntent[]): number =>
  intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-Y", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, analysis: [], probability: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;
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
function evictOne<T extends Rec>(values: readonly T[], now: number, incoming: Operation): T | null {
  const tier = (item: Rec) => item.retainUntil <= now ? 0 : !visible(item) ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: T | null = null;
  for (const item of values) {
    if (item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（Q-ENUM.revisionOrder）: (ReportDateTime, InfoType, Serial)。Serial の欠落は最小 ----

const serialNumber = (raw: string): number => raw === "" ? -1 : Number(raw);
function compare(candidate: TyphoonCandidate, source: ReportRef): number {
  const time = Math.sign(candidate.reportDateTimeMs - reportMs(source));
  if (time !== 0) return time;
  const info = Math.sign(candidate.infoRank - (infoRankOf(source.infoTypeRaw) ?? 0));
  return info || Math.sign(serialNumber(candidate.source.serialRaw) - serialNumber(source.serialRaw));
}

// 公開事実（重複の判定と見える記録の変化）。
const FACTS = ["effective", "endCause", "title", "name", "frames", "truncated", "activeUntil", "baseTime", "slotCount", "maxFiveDay", "prefectures", "areas"] as const;
function changed(before: Rec | null, value: Rec | null): string[] {
  const read = (record: Rec | null, field: string): unknown => record == null ? null : Object.getOwnPropertyDescriptor(record, field)?.value ?? null;
  return FACTS.filter((field) => !isDeepStrictEqual(read(before, field), read(value, field)));
}

// ---- 記録の組み立て（retainUntil・activeUntil は元報の ReportDateTime からの等式。decode も同じ関数で確かめる） ----

type Base = Readonly<{ subject: string; operation: Operation; source: ReportRef }>;
const baseOf = (value: Base): Base => ({ subject: value.subject, operation: value.operation, source: value.source });
const retainOf = (base: Base) => reportMs(base.source) + RETAIN;
const visibleOf = (base: Base) => reportMs(base.source) + VISIBLE;

const cancelledRecord = (base: Base): Analysis & Probability => ({ ...base, retainUntil: retainOf(base), effective: "cancelled" });
const endedRecord = (base: Base, endCause: "terminal" | "expired"): Analysis & Probability => ({ ...base, retainUntil: retainOf(base), effective: "ended", endCause });
const zeroRecord = (base: Base): Probability => ({ ...base, retainUntil: retainOf(base), effective: "zero" });
const analysisActive = (base: Base, fact: Readonly<{ baseTime: number; title: string; name: TyphoonName; frames: readonly TyphoonFrame[]; truncated: boolean }>): Analysis =>
  ({ ...base, retainUntil: retainOf(base), effective: "active", activeUntil: visibleOf(base), baseTime: fact.baseTime, title: fact.title, name: fact.name,
    frames: fact.frames, truncated: fact.truncated });
const probabilityActive = (base: Base, fact: Readonly<{ baseTime: number; slotCount: number; title: string; name: TyphoonName; maxFiveDay: number;
  prefectures: readonly TyphoonPrefecture[]; areas: readonly TyphoonProbabilityArea[]; truncated: boolean }>): Probability =>
  ({ ...base, retainUntil: retainOf(base), effective: "active", activeUntil: visibleOf(base), baseTime: fact.baseTime, slotCount: fact.slotCount, title: fact.title,
    name: fact.name, maxFiveDay: fact.maxFiveDay, prefectures: fact.prefectures, areas: fact.areas, truncated: fact.truncated });

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// 名前の札。台風番号があれば「台風第N号（名前）」、無ければ「熱帯低気圧（EventID）」（旧築の notifyTyphoonAnalysis と同じ向き）。
function labelOf(name: TyphoonName, eventId: string): string {
  return name.number == null ? `熱帯低気圧（${eventId}）` : `台風第${Number(name.number.slice(-2))}号${name.name == null ? "" : `（${name.name}）`}`;
}
type Mark = "plain" | "correction" | "cancel";
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title。接頭辞は切る範囲の外に置き、本体だけを上限から引いた長さで切る（K5 の F15 の型）。
function payloadOf(operation: Operation, level: Level, title: string, body: string, mark: Mark): TyphoonNotificationPayload {
  const titleHead = PREFIX[operation] + (mark === "correction" ? "[訂正] " : mark === "cancel" ? "[取消] " : "");
  const bodyHead = mark === "correction" ? "訂正: " : "";
  const text = mark === "cancel" ? "この情報は取り消されました" : bodyHead + cut(body === "" ? title : body, NOTICE_BOUNDS.body - bodyHead.length);
  return { domain: "weather", level, title: titleHead + cut(title, NOTICE_BOUNDS.title - titleHead.length), body: text };
}
function intentsFor(source: Readonly<{ subject: string; operation: Operation; source: ReportRef }>, transition: TyphoonIntent["transition"],
  payload: TyphoonNotificationPayload, generation: number, now: number): TyphoonIntent[] {
  // P3-C14-TRAINING=A: training/test は desktop だけ。
  const channels = source.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: `U-Y:${source.subject}:${generation}:${channel}`, unit: "U-Y", subject: source.subject,
    operation: source.operation, source: source.source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-Y の intent は全部 other の群（P3-C14-NOTICE-GROUP）。
function a7Order(left: TyphoonIntent, right: TyphoonIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 終端記録の合計が 98,304 byte を超える分は、最古の終端記録から期限前に回収する。kept は今の配送の更新で終端にした記録で、回収しない
// （owner は更新した記録が残ることで照合する）。
function trimTerminal(intents: readonly TyphoonIntent[], kept: ReadonlySet<string> = new Set()): readonly TyphoonIntent[] {
  let terminal = terminalBytes(intents);
  if (terminal <= TERMINAL_BYTES) return intents;
  const gone = new Set<TyphoonIntent>();
  for (const item of intents.filter((value) => value.disposition !== "pending" && !kept.has(value.id))
    .sort((left, right) => left.createdAt - right.createdAt)) {
    if (terminal <= TERMINAL_BYTES) break;
    gone.add(item);
    terminal -= bytes(item) + 1;
  }
  return intents.filter((item) => !gone.has(item));
}
// Q-NOTICE.capacity と P3-C14-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、withdrawn の subject（取消・遅着・終わりの撤回）は全 pending を置き換える。
function admit(current: readonly TyphoonIntent[], fresh: readonly TyphoonIntent[], withdrawn: ReadonlySet<string>):
  Readonly<{ intents: readonly TyphoonIntent[]; admitted: readonly TyphoonIntent[]; dropped: number }> {
  const superseded = new Set<TyphoonIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.disposition === "pending" && (withdrawn.has(item.subject) || replaced.has(`${item.subject}\n${item.channel}`))) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
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
  // 新しい intent が容量で外れただけなら、既存の intent も終端記録も変わらないので元の配列を返す。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  const intents = trimTerminal([...current.map((item) => superseded.has(item) || out.has(item)
    ? { ...item, disposition: "superseded" as const } : item), ...admitted]);
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
  return { unit: "U-Y", operation: value.operation, subject: value.subject, office: null, current: visible(value) ? value : null, subjects: [shownOutcome(value)] };
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
    if (candidate.cancelled) return was ? { level: "cancel", mark: "cancel", transition: "cancelled", body: "" } : null;
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
    if (candidate.cancelled) return was ? { level: "cancel", mark: "cancel", transition: "cancelled", body: "" } : null;
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

const unchangedStep = (state: State, subject: string, operation: Operation, reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result =>
  ({ changes: [], step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason }], diagnostics } });

function receiveWith<T extends Rec, C extends TyphoonCandidate>(lane: Lane<T, C>, state: State, candidate: C, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const { subject, operation } = candidate;
  const values = lane.read(state);
  const at = indexOf(values).get(subject);
  const existing = at == null ? null : values[at];
  const built = lane.build(candidate, now, state);
  const next = built.record;
  if (existing != null) {
    const order = compare(candidate, existing.source);
    // 取消以前の版は stale で、取消した subject を戻さない。同じ版は、見える記録なら事実が同じで duplicate・違えば先着を保つ。
    // 見えない記録（記憶）は事実を持たないので、記憶の種類が食い違うときだけ stale＋診断、同じなら duplicate（復活させない）。
    if (order < 0) return unchangedStep(state, subject, operation, "stale");
    // 重複の判定は遅着の判定より先なので、時計にも解析の終わりにも依らない記録の形と比べる。
    if (order === 0) return !(visible(existing) ? changed(existing, lane.build(candidate, -Infinity, null).record).length !== 0 : lane.conflicts(existing, candidate))
      ? unchangedStep(state, subject, operation, "duplicate")
      : unchangedStep(state, subject, operation, "stale", [{ level: "WARN", component: "typhoon", reason: "typhoonRevisionConflict", inputId: candidate.source.inputId, unit: "U-Y" }]);
  }
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
    evicted = evictOne(values, now, operation);
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
  const fresh = notice == null ? [] : intentsFor(candidate, notice.transition, payloadOf(operation, notice.level, candidate.title, notice.body, notice.mark),
    state.persistence.currentGeneration + 1, now);
  const notices = admit(state.intents, fresh, withdrawn);
  const result: State = { ...written, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };

  // change は最終の表示の変化で決める（I-U-Y.currentSemantics(5)）。accepted は最終の状態に残る subject（今回の記録）。
  const shownChange = was !== now_ || was && changed(existing, next).length !== 0;
  const kind = evicted != null || shownChange ? "semantic" as const : "revisionOnly" as const;
  decisions.push({ subject, operation, decision: "changed", reason: null, change: kind,
    currentEstablished: { family: candidate.headType, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } });
  if (endedProbability != null) decisions.push({ subject: endedProbability.subject, operation, decision: "changed", reason: null, change: "semantic", currentEstablished: null });
  const diagnostics: DiagnosticDetails[] = [];
  if (evicted != null) diagnostics.push(evictedDiagnostic);
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "typhoon", reason: "notificationCapacityEvicted", unit: "U-Y", count: notices.dropped });
  const replaced: Change = existing == null ? [null, next] : [existing, next];
  return {
    changes: [...evicted == null ? [] : [[evicted, null] satisfies Change], replaced, ...changes],
    step: { state: result, nextDeadline: nextDeadline(result), decisions, intents: notices.admitted,
      outcomes: [{ kind: "accepted", change: endedProbability == null ? kind : "semantic", subjects: [outcomeOf(next, changed(existing, next)),
        ...endedProbability == null ? [] : [outcomeOf(endedProbability, ["effective"])]] }], diagnostics },
  };
}

function receive(state: State, input: Extract<TyphoonInput, { kind: "receive" }>): Result {
  const parsed = parseTyphoon(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C14-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  return candidate.slice === "analysis" ? receiveWith(analysisLane, state, candidate, input.clock) : receiveWith(probabilityLane, state, candidate, input.clock);
}

// ---- 期限（I-U-Y.deadlines。到来分だけを移行・回収する。到来の処理は無音） ----

// retainUntil の到来で記録を除き、見える期限の到来で active を ended にする。
// ponytail: 全 subject の同時の期限だけが一括の回収になる（上限は件数の上限 64 で、保持と decode の両方で効く）。
function sweep<T extends Rec>(values: readonly T[], now: number, expire: (item: T) => T): Readonly<{ values: readonly T[]; changes: readonly Change[] }> {
  if (recordMin(values) > now) return { values, changes: [] };
  const changes: Change[] = [];
  const next = values.flatMap((item) => {
    // 見える期限と retainUntil が同時に来た active も、先に ended に移して見えなくなる変化（decision・outcome）を残してから除く。
    if (item.effective === "active" && deadlineOf(item) <= now) {
      const moved = expire(item);
      changes.push([item, moved]);
      if (moved.retainUntil > now) return [moved];
      changes.push([moved, null]);
      return [];
    }
    if (item.retainUntil <= now) { changes.push([item, null]); return []; }
    return [item];
  });
  return { values: next, changes };
}

function collect(state: State, clock: ClockReading, withIntents: boolean): Readonly<{ state: State; changes: readonly Change[]; expiredIntents: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0 };
  const analysis = sweep(state.analysis, now, analysisLane.expire), probability = sweep(state.probability, now, probabilityLane.expire);
  const intents = !withIntents || intentMin(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = intents === state.intents ? 0 : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  const persisted = analysis.changes.length !== 0 || probability.changes.length !== 0 || intents !== state.intents;
  const moved: State = { ...state, analysis: analysis.values, probability: probability.values, intents };
  return { state: persisted ? { ...moved, persistence: dirty(state.persistence, clock.monotonicMs) } : moved,
    changes: [...analysis.changes, ...probability.changes], expiredIntents };
}

function deadlineStep(state: State, clock: ClockReading): Result {
  const applied = collect(state, clock, true);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "typhoon", reason: "notificationExpired",
    unit: "U-Y", count: applied.expiredIntents }];
  // 見えなくなる移行だけが changed/semantic（O08:4・O08:29）。除去は無音。
  const ended = applied.changes.flatMap(([before, after]) => visible(before) && after != null && !visible(after) ? [after] : []);
  return { changes: applied.changes, step: { ...idle(applied.state),
    decisions: ended.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "semantic" as const, currentEstablished: null })),
    outcomes: ended.length === 0 ? [] : [{ kind: "deadlineApplied", subjects: ended.map((item) => outcomeOf(item, ["effective"])) }], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: State, input: Extract<TyphoonInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, TyphoonIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changedIntents.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える。更新で終端にした記録は期限前の回収から外す。
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

// Q-NOTICE.restart・I-U-Y.restore: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。先に retainUntil を過ぎた記録を除き、
// 残る active のうち見える期限を過ぎたものを無音で ended にする。どちらかが起きれば保存世代を進める。
// intent の期限切れの回収は復元の後の最初の期限処理で行う。
function restore(state: State, persisted: PersistedTyphoonUnit, clock: ClockReading): Result {
  const decoded = typhoonUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "typhoon",
    reason: "requiredStructureInvalid", unit: "U-Y" }] } };
  const applied = collect({ ...decoded.state, contentRevision: state.contentRevision, persistence: state.persistence }, clock, false);
  const shown = [...applied.state.analysis, ...applied.state.probability].filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-Y"], coverage: shown.map((item) => item.subject), subjects: [] }] } };
}

function reduceCore(state: State, input: TyphoonInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock);
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
  contentRevision: String(state.contentRevision), admission: {}, subjects, analysis, probability };
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
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || row.subject !== subject || parts.operation !== operation || !isText(row.family)
    || !isText(row.inputId) || !validInputId(row.inputId) || !isText(row.reportDateTimeRaw) || !validReportDateTime(row.reportDateTimeRaw)
    || !isText(row.serialRaw) || row.serialRaw !== "" && !validSerial(row.serialRaw) || !isText(row.infoTypeRaw) || infoRankOf(row.infoTypeRaw) == null
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  const family = (parts.slice === "analysis" ? ANALYSIS_TYPES : PROBABILITY_TYPES).find((item) => item === row.family);
  return family == null ? null : { inputId: row.inputId, origin: row.origin, operation, family, subject, reportDateTimeRaw: row.reportDateTimeRaw,
    serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
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
const FACT_KEYS = ["activeUntil", "baseTime", "title", "name", "frames", "truncated", "slotCount", "maxFiveDay", "prefectures", "areas", "endCause"] as const;
const BRANCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  "analysis/active": ["activeUntil", "baseTime", "title", "name", "frames", "truncated"],
  "probability/active": ["activeUntil", "baseTime", "slotCount", "title", "name", "maxFiveDay", "prefectures", "areas", "truncated"],
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
  return { row, parts, base: { subject: row.subject, operation: parts.operation, source } };
}
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
    const frames = list(row.frames, frameRecord, LIMITS.frames), name = nameRecord(row.name);
    // 実況の時刻がちょうど 1 個。activeUntil は ReportDateTime ＋ 12 時間（P3-C14-EXPIRY=A）。
    if (frames != null && name != null && frames.filter((frame) => frame.kind === "analysis").length === 1 && instant(row.baseTime) && boundedName(row.title, BOUNDS.title)
      && typeof row.truncated === "boolean" && row.activeUntil === visibleOf(base))
      built = analysisActive(base, { baseTime: row.baseTime, title: row.title, name, frames, truncated: row.truncated });
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
    const name = nameRecord(row.name);
    if (slotCount != null && areas != null && areas.length !== 0 && prefectures != null && name != null && instant(row.baseTime) && boundedName(row.title, BOUNDS.title)
      && typeof row.truncated === "boolean" && row.activeUntil === visibleOf(base) && ascending(areas.map((area) => area.code))
      && ascending(prefectures.map((item) => item.code)) && row.maxFiveDay === Math.max(...areas.map((area) => area.daily[4])) && whole(row.maxFiveDay, 100)
      && row.maxFiveDay >= 1 && isDeepStrictEqual(prefectures.map((item) => item.code), [...new Set(areas.map((area) => area.prefectureCode))].sort()))
      built = probabilityActive(base, { baseTime: row.baseTime, slotCount, title: row.title, name, maxFiveDay: row.maxFiveDay, prefectures, areas, truncated: row.truncated });
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
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-Y.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || payload.domain !== "weather" || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-Y" || !isText(row.subject) || source.operation !== operation
    || !bounded(payload.title, NOTICE_BOUNDS.title) || payload.title === "" || !bounded(payload.body, NOTICE_BOUNDS.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-Y", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision, disposition };
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
  const pending = intents.filter((entry) => entry.disposition === "pending");
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。終端記録は pending との合計で見る（Q-NOTICE.capacity）。
  const pendingBytes = listBytes(pending) + pending.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedTyphoonUnit = { schemaVersion: SCHEMA, analysis, probability, intents };
  if (pending.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || pendingBytes + terminalBytes(intents) > PENDING_BYTES + TERMINAL_BYTES
    || generationBytes(result) > GENERATION_LIMIT) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const typhoonUnitCodec: TyphoonUnitCodec = {
  schemaVersion: SCHEMA,
  // contentRevision・persistence は保存しない（I-U-Y.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, analysis: state.analysis, probability: state.probability, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-typhoon-unit-v1 payload" }
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
  withoutNormal: (state) => ({ ...state, analysis: state.analysis.filter((item) => item.operation !== "normal"),
    probability: state.probability.filter((item) => item.operation !== "normal") }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => [...state.analysis, ...state.probability].filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-Y">;

export { generationBytes, reduceTyphoonUnit, toTyphoonView, typhoonUnit, typhoonUnitCodec };
