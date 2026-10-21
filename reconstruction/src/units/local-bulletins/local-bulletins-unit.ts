import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline, SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  HeatCurrent, LocalBulletinsInput, LocalBulletinsIntent, LocalBulletinsNotificationPayload, LocalBulletinsUnitCodec, LocalBulletinsUnitState,
  LocalBulletinsUnitStep, LocalBulletinsUnitView, PersistedLocalBulletinsUnit, PersistedTransientCurrent, TornadoArea, TornadoAreaLayer, TornadoCurrent,
  TransientArea, TransientCurrent, TransientFamily,
} from "../../../contracts/p3-local-bulletins-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { readReportRef } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import {
  BOUNDS, FAMILY_OF, HEAT_LIMIT, JST, HEAT_RETAIN, HEAT_TARGET_WINDOW, LAYER_SET, LIMITS, TORNADO_DEFAULT_VALID, TORNADO_LIMIT, TORNADO_RETAIN,
  TRANSIENT_LIMIT, TRANSIENT_RETAIN, TRANSIENT_TYPES, VISIBLE_TRANSIENT, dateEnd, parseLocalBulletins, validEventId, validKeyTitle,
  validOffice, validSeries,
} from "../../domains/local-bulletins/local-bulletins";
import type { HeatCandidate, LocalBulletinsCandidate, TornadoCandidate, TransientCandidate, TransientHeadType } from "../../domains/local-bulletins/local-bulletins";
import { validCode, validHeadline } from "../../domains/briefing/briefing";
import { cut, infoRankOf, validName, validReportDateTime, validSerial } from "../../domains/flood/flood";

// P3-UNIT-M-001（C13、I-U-M）: 三つの slice（tornado・heat・transient）の current・版・遅着・退去・通知・容量・codec・射影。
// 三つの slice は件数の上限と退去を別々に持つ（無いと解説の多発が竜巻の記録を退去する、I-U-M.slices）。

const SCHEMA = "p3-local-bulletins-unit-v3" as const;
// P3-C13-BOUNDS=A・P3-C13-RES-01・RET-05。
const GENERATION_LIMIT = 4_194_304;
const TRANSIENT_TOTAL = Object.values(TRANSIENT_LIMIT).reduce((sum, value) => sum + value, 0);
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 98_304;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;

type Rec = TornadoCurrent | HeatCurrent | TransientCurrent;
type Visible = Extract<TornadoCurrent, { effective: "active" }> | Extract<HeatCurrent, { effective: "active" }> | Extract<TransientCurrent, { effective: "active" }>;
type Level = LocalBulletinsNotificationPayload["level"];
type Domain = LocalBulletinsNotificationPayload["domain"];
type InternalStep = Omit<LocalBulletinsUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = LocalBulletinsUnitStep["decisions"][number];
// 前が無ければ後は必ずある（どちらも無い変化は作らない）。
type Change = readonly [before: Rec, after: Rec | null] | readonly [before: null, after: Rec];
const target = (value: Change): Rec => value[0] == null ? value[1] : value[1] ?? value[0];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;
type State = LocalBulletinsUnitState;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// view に載るのは active だけ（I-U-M.view）。
function visible<T extends Rec>(value: T | null): value is Extract<T, Readonly<{ effective: "active" }>> {
  return value?.effective === "active";
}
const hhmm = (ms: number) => new Date(ms + JST).toISOString().slice(11, 16);

// ---- byte の加算（I-U-M.computation。受信 1 回で state 全体を直列化しない） ----

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
const terminalBytes = (intents: readonly LocalBulletinsIntent[]): number =>
  intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-M", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, tornado: [], heat: [], transient: [], intents: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES; // P3-VM-AC06: envelope の inputBoundary の最大
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-R ほかと同じ予約）。8: 空の配列 4 つ。
function generationBytes(value: PersistedLocalBulletinsUnit): number {
  return emptyEnvelopeBytes + 62 - 8 + listBytes(value.tornado) + listBytes(value.heat) + listBytes(value.transient) + listBytes(value.intents);
}

// ---- 期限（I-U-M.deadlines: 見える期限・retainUntil・intent の expiresAt の最小） ----

// 配列ごとの最小の期限。記録の配列と intent の配列は別の cache にする（同じ配列に別の取り出し方を使うと値が食い違うため）。
function cachedMin<T extends object>(cache: WeakMap<readonly T[], number>, values: readonly T[], at: (value: T) => number): number {
  let min = cache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); cache.set(values, min); }
  return min;
}
const recordMinCache = new WeakMap<readonly Rec[], number>(), intentMinCache = new WeakMap<readonly LocalBulletinsIntent[], number>();
const recordMin = (values: readonly Rec[]) => cachedMin(recordMinCache, values, deadlineOf);
const intentMin = (values: readonly LocalBulletinsIntent[]) => cachedMin(intentMinCache, values, (item) => item.expiresAt);
function deadlineOf(item: Rec): number {
  if (item.effective !== "active") return item.retainUntil;
  return "visibleUntil" in item ? item.visibleUntil : item.activeUntil;
}
const deadlineAt = (state: State): number => Math.min(recordMin(state.tornado), recordMin(state.heat), recordMin(state.transient),
  intentMin(state.intents));
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

// ---- 索引（配列に結び付けた Map、I-U-M.computation）: subject の位置と、件数を数える枠（transient は family、ほかは空文字）ごとの件数 ----

const bucketOf = (item: Rec): string => "family" in item ? item.family : "";
type Index = Readonly<{ subjects: ReadonlyMap<string, number>; buckets: ReadonlyMap<string, number> }>;
const indexCache = new WeakMap<readonly Rec[], Index>();
function indexOf(values: readonly Rec[]): Index {
  let index = indexCache.get(values);
  if (index == null) {
    const subjects = new Map<string, number>(), buckets = new Map<string, number>();
    values.forEach((item, at) => { subjects.set(item.subject, at); buckets.set(bucketOf(item), (buckets.get(bucketOf(item)) ?? 0) + 1); });
    index = { subjects, buckets };
    indexCache.set(values, index);
  }
  return index;
}

// P3-C13-CAPACITY=A と P3-C13-EVICT-OPERATION: 上限を超える報は (1) retainUntil を過ぎた記録 (2) 記憶（見えない記録） (3) training/test の見える記録
// (4) normal の見える記録、それぞれ ReportDateTime の古い順（同じなら subject の辞書順）で同じ枠の中から退去する。受ける報が training/test なら
// normal の記録は候補にせず、候補が無ければ null（受けた記録自身を退去する）。
// ponytail: 満杯の枠の素朴な線形の走査（上限は件数の上限で、保持と decode の両方で効く。台帳 47 の例外）。
function evictOne<T extends Rec>(values: readonly T[], bucket: string, now: number, incoming: Operation): T | null {
  const tier = (item: Rec) => item.retainUntil <= now ? 0 : !visible(item) ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: T | null = null;
  for (const item of values) {
    if (bucketOf(item) !== bucket || item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（Q-ENUM.revisionOrder）: (ReportDateTime, InfoType, Serial, headType の順位)。順位は竜巻だけ（VPHW50＜VPHW51） ----

const serialNumber = (raw: string): number => raw === "" ? -1 : Number(raw);
const headRank = (family: string): number => family === "VPHW51" ? 1 : 0;
function compare(candidate: LocalBulletinsCandidate, source: ReportRef): Readonly<{ order: number; pair: boolean }> {
  const time = Math.sign(candidate.reportDateTimeMs - reportMs(source));
  if (time !== 0) return { order: time, pair: false };
  const info = Math.sign(candidate.infoRank - (infoRankOf(source.infoTypeRaw) ?? 0));
  const serial = Math.sign(serialNumber(candidate.source.serialRaw) - serialNumber(source.serialRaw));
  const head = candidate.slice === "tornado" ? Math.sign(headRank(candidate.headType) - headRank(source.family)) : 0;
  // 同じ版の竜巻の対の後着（50→51）は新しい版として採るが、通知の生成と撤回からは外す（P3-C13-TORNADO-PAIR=A）。
  return { order: info || serial || head, pair: info === 0 && serial === 0 && head > 0 };
}

// 公開事実（Q-NOTICE.generationTable: title・headline・sighted・areas・activeUntil／targetDate・areaName／tags。重複の判定と見える記録の変化）。editorialOffice は入れない。
const FACTS = ["effective", "title", "headline", "sighted", "areas", "activeUntil", "targetDate", "areaName", "tags"] as const;
function changed(before: Rec | null, value: Rec | null): string[] {
  const read = (record: Rec | null, field: string): unknown => record == null ? null : Object.getOwnPropertyDescriptor(record, field)?.value ?? null;
  return FACTS.filter((field) => !isDeepStrictEqual(read(before, field), read(value, field)));
}

// ---- 記録の組み立て（retainUntil は元報の ReportDateTime からの等式。decode も同じ関数で確かめる） ----

type Base = Readonly<{ subject: string; operation: Operation; source: ReportRef }>;
type Text = Readonly<{ title: string; headline: string; editorialOffice: string; truncated: boolean }>;
const baseOf = (value: Base): Base => ({ subject: value.subject, operation: value.operation, source: value.source });
const textOf = (value: Text): Text => ({ title: value.title, headline: value.headline, editorialOffice: value.editorialOffice, truncated: value.truncated });
const retain = (base: Base, ms: number) => reportMs(base.source) + ms;

const tornadoMemory = (base: Base, effective: "ended" | "cancelled"): TornadoCurrent => ({ ...base, retainUntil: retain(base, TORNADO_RETAIN), effective });
const tornadoActive = (base: Base, text: Text, activeUntil: number, sighted: boolean, areas: readonly TornadoArea[]): TornadoCurrent =>
  ({ ...base, retainUntil: retain(base, TORNADO_RETAIN), effective: "active", activeUntil, ...text, sighted, areas });
const heatMemory = (base: Base, effective: "ended" | "cancelled"): HeatCurrent => ({ ...base, retainUntil: retain(base, HEAT_RETAIN), effective });
const heatActive = (base: Base, text: Text, activeUntil: number, targetDate: string, areaName: string | null): HeatCurrent =>
  ({ ...base, retainUntil: retain(base, HEAT_RETAIN), effective: "active", activeUntil, targetDate, ...text, areaName });
const transientMemory = (base: Base, family: TransientFamily, effective: "evidence" | "cancelled"): PersistedTransientCurrent =>
  ({ ...base, family, retainUntil: retain(base, TRANSIENT_RETAIN[family]), effective });
const transientActive = (base: Base, family: TransientFamily, text: Text, areas: readonly TransientArea[], tags: readonly string[]): TransientCurrent =>
  ({ ...base, family, retainUntil: retain(base, TRANSIENT_RETAIN[family]), effective: "active", visibleUntil: retain(base, VISIBLE_TRANSIENT), ...text, areas, tags });

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title。接頭辞は切る範囲の外に置き、本体だけを上限から引いた長さで切る（K5 の F15 の型）。
function payloadOf(domain: Domain, operation: Operation, level: Level, title: string, body: string, mark: "plain" | "correction" | "cancel" | "release"):
  LocalBulletinsNotificationPayload {
  const titleHead = PREFIX[operation] + (mark === "correction" ? "[訂正] " : mark === "cancel" ? "[取消] " : "");
  const bodyHead = mark === "correction" ? "訂正: " : "";
  const text = mark === "cancel" ? "この情報は取り消されました" : mark === "release" ? "竜巻注意情報は解除されました"
    : bodyHead + cut(body === "" ? title : body, NOTICE_BOUNDS.body - bodyHead.length);
  return { domain, level, title: titleHead + cut(title, NOTICE_BOUNDS.title - titleHead.length), body: text };
}
const dateText = (targetDate: string) => `${Number(targetDate.slice(5, 7))}月${Number(targetDate.slice(8, 10))}日`;
function intentsFor(source: Readonly<{ subject: string; operation: Operation; source: ReportRef }>, transition: LocalBulletinsIntent["transition"],
  payload: LocalBulletinsNotificationPayload, generation: number, now: number): LocalBulletinsIntent[] {
  // P3-C13-TRAINING=A: training/test は desktop だけ。
  const channels = source.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: `U-M:${source.subject}:${generation}:${channel}`, unit: "U-M", subject: source.subject,
    operation: source.operation, source: source.source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-M の intent は全部 other の群（P3-C13-NOTICE-GROUP=A）。
function a7Order(left: LocalBulletinsIntent, right: LocalBulletinsIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 終端記録の合計が 98,304 byte を超える分は、最古の終端記録から期限前に回収する。kept は今の配送の更新で終端にした記録で、回収しない
// （owner は更新した記録が残ることで照合する）。
function trimTerminal(intents: readonly LocalBulletinsIntent[], kept: ReadonlySet<string> = new Set()): readonly LocalBulletinsIntent[] {
  let terminal = terminalBytes(intents);
  if (terminal <= TERMINAL_BYTES) return intents;
  const gone = new Set<LocalBulletinsIntent>();
  for (const item of intents.filter((value) => value.disposition !== "pending" && !kept.has(value.id))
    .sort((left, right) => left.createdAt - right.createdAt)) {
    if (terminal <= TERMINAL_BYTES) break;
    gone.add(item);
    terminal -= bytes(item) + 1;
  }
  return intents.filter((item) => !gone.has(item));
}
// Q-NOTICE.capacity と P3-C13-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、withdrawn の subject（取消・遅着の撤回）は全 pending を置き換える。
function admit(current: readonly LocalBulletinsIntent[], fresh: readonly LocalBulletinsIntent[], withdrawn: ReadonlySet<string>):
  Readonly<{ intents: readonly LocalBulletinsIntent[]; admitted: readonly LocalBulletinsIntent[]; dropped: number }> {
  const superseded = new Set<LocalBulletinsIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.disposition === "pending" && (withdrawn.has(item.subject) || replaced.has(`${item.subject}\n${item.channel}`))) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
  const out = new Set<LocalBulletinsIntent>();
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
  if (value.effective !== "active") return { effective: value.effective };
  if ("sighted" in value) return { effective: value.effective, title: value.title, headline: value.headline, editorialOffice: value.editorialOffice,
    sighted: value.sighted, areas: value.areas, activeUntil: value.activeUntil, truncated: value.truncated };
  if ("targetDate" in value) return { effective: value.effective, title: value.title, headline: value.headline, editorialOffice: value.editorialOffice,
    targetDate: value.targetDate, areaName: value.areaName, activeUntil: value.activeUntil, truncated: value.truncated };
  return { effective: value.effective, title: value.title, headline: value.headline, editorialOffice: value.editorialOffice, areas: value.areas,
    tags: value.tags, truncated: value.truncated };
}
function outcomeOf(value: Rec, changedFields: readonly string[]): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: factsOf(value), changedFields };
}
// view の subject は識別だけを持つ（事実は slice にあり、二重に載せると snapshot の予算を食う。U-L・U-R・U-B の先例）。
const outcomeCache = new WeakMap<Rec, SubjectOutcome>();
function shownOutcome(value: Rec): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) { found = { ...outcomeOf(value, []), facts: { effective: value.effective } }; outcomeCache.set(value, found); }
  return found;
}
function displaySubject(value: Rec): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-M" }>> {
  return { unit: "U-M", operation: value.operation, subject: value.subject, office: null, current: visible(value) ? value : null, subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C13-PARAMETERS.adoptionOutcome の順。一入力の変更は一回の参照交換で確定する、I-U-M.subjects） ----

type Built<T extends Rec> = Readonly<{ record: T; late: boolean }>;
// 候補の型ごとの slice の読み書き・記録・通知の組み立て。記録が candidate の見える期限を過ぎていれば late（記憶としてだけ採る、lateRule (2)）。
type Lane<T extends Rec, C extends LocalBulletinsCandidate> = Readonly<{
  read: (state: State) => readonly T[];
  write: (state: State, values: readonly T[]) => State;
  limit: (candidate: C) => number;
  bucket: (candidate: C) => string;
  build: (candidate: C, now: number) => Built<T>;
  expire: (item: T) => T;
  // 見えなくなる移行が保存の射影を変えるか（transient は変えない、P3-C13-TRANSIENT-EVIDENCE=A）。
  expireIsPersisted: boolean;
  style: (candidate: C) => Readonly<{ domain: Domain; level: Level }>;
  body: (candidate: C, record: Visible) => string;
}>;

const tornadoLane: Lane<TornadoCurrent, TornadoCandidate> = {
  read: (state) => state.tornado,
  write: (state, values) => ({ ...state, tornado: values }),
  limit: () => TORNADO_LIMIT,
  bucket: () => "",
  build(candidate, now) {
    const base = { subject: candidate.subject, operation: candidate.operation, source: candidate.source };
    if (candidate.cancelled) return { record: tornadoMemory(base, "cancelled"), late: false };
    if (candidate.release) return { record: tornadoMemory(base, "ended"), late: false };
    const limit = retain(base, TORNADO_RETAIN);
    // P3-C13-TORNADO-EXPIRY=A: ValidDateTime（無ければ +1 時間）を +36 時間に切り詰める。
    const activeUntil = Math.min(candidate.validMs ?? candidate.reportDateTimeMs + TORNADO_DEFAULT_VALID, limit);
    if (activeUntil <= now) return { record: tornadoMemory(base, "ended"), late: true };
    return { record: tornadoActive(base, textOf(candidate), activeUntil, candidate.sighted, candidate.areas), late: false };
  },
  expire: (item) => tornadoMemory(baseOf(item), "ended"),
  expireIsPersisted: true,
  style: () => ({ domain: "weather", level: "warning" }),
  body(candidate, record) {
    const parts = [...record.effective === "active" && "sighted" in record && record.sighted ? ["目撃情報あり"] : [],
      ...candidate.noticeAreas > 0 ? [`発表中 ${candidate.noticeAreas}地域`] : [], ...candidate.validMs != null ? [`有効期限 ${hhmm(candidate.validMs)}`] : []];
    return parts.join(" / ");
  },
};
const heatLane: Lane<HeatCurrent, HeatCandidate> = {
  read: (state) => state.heat,
  write: (state, values) => ({ ...state, heat: values }),
  limit: () => HEAT_LIMIT,
  bucket: () => "",
  build(candidate, now) {
    const base = { subject: candidate.subject, operation: candidate.operation, source: candidate.source };
    if (candidate.cancelled) return { record: heatMemory(base, "cancelled"), late: false };
    if (candidate.activeUntil <= now) return { record: heatMemory(base, "ended"), late: true };
    return { record: heatActive(base, textOf(candidate), candidate.activeUntil, candidate.targetDate, candidate.areaName), late: false };
  },
  expire: (item) => heatMemory(baseOf(item), "ended"),
  expireIsPersisted: true,
  style: () => ({ domain: "weather", level: "warning" }),
  body: (_candidate, record) => "targetDate" in record ? [record.areaName, dateText(record.targetDate)].filter((part) => part != null).join(" ") : "",
};
const transientLane: Lane<TransientCurrent, TransientCandidate> = {
  read: (state) => state.transient,
  write: (state, values) => ({ ...state, transient: values }),
  limit: (candidate) => TRANSIENT_LIMIT[candidate.family],
  bucket: (candidate) => candidate.family,
  build(candidate, now) {
    const base = { subject: candidate.subject, operation: candidate.operation, source: candidate.source };
    if (candidate.cancelled) return { record: transientMemory(base, candidate.family, "cancelled"), late: false };
    if (candidate.reportDateTimeMs + VISIBLE_TRANSIENT <= now) return { record: transientMemory(base, candidate.family, "evidence"), late: true };
    return { record: transientActive(base, candidate.family, textOf(candidate), candidate.areas, candidate.tags), late: false };
  },
  expire: (item) => transientMemory(baseOf(item), item.family, "evidence"),
  expireIsPersisted: false,
  style: (candidate) => candidate.family === "seismicText" ? { domain: "earthquake-eew", level: "info" } : { domain: "weather", level: "normal" },
  body: (_candidate, record) => record.headline.split(/\r?\n/)[0].trim(),
};

function receiveWith<T extends Rec, C extends LocalBulletinsCandidate>(lane: Lane<T, C>, state: State, candidate: C, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const { subject, operation } = candidate;
  const values = lane.read(state);
  const index = indexOf(values);
  const at = index.subjects.get(subject);
  const existing = at == null ? null : values[at];
  const built = lane.build(candidate, now);
  const next = built.record;
  const unchanged = (reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason }], diagnostics } });
  let pairLate = false;
  if (existing != null) {
    const { order, pair } = compare(candidate, existing.source);
    // 取消以前の版は stale で、取消した subject を戻さない。同じ版は、見える記録なら事実が同じで duplicate・違えば先着を保つ。
    // 見えない記録（記憶・証拠）は事実を持たないので、同じ版は duplicate（復活させない）。
    if (order < 0) return unchanged("stale");
    // 重複の判定は遅着の判定より先なので、時計に依らない記録（見える期限の前の形）と比べる。
    if (order === 0) return !visible(existing) || changed(existing, lane.build(candidate, -Infinity).record).length === 0 ? unchanged("duplicate")
      : unchanged("stale", [{ level: "WARN", component: "localBulletins", reason: "localBulletinsRevisionConflict", inputId: candidate.source.inputId, unit: "U-M" }]);
    pairLate = pair;
  }
  // P3-C13-RETENTION.lateRule（版の比較の後）: (1) 記憶の期限を過ぎた報は state を変えない。(3) 見える期限を過ぎた報で、subject に記録が無く
  // 枠が満杯なら記録を作らず、退去も起こさない。(2) 見える期限を過ぎた報は記憶としてだけ採り、前の見える記録を終わらせて pending を撤回する。
  if (next.retainUntil <= now) return unchanged("stale");
  const bucket = lane.bucket(candidate);
  const full = at == null && (index.buckets.get(bucket) ?? 0) >= lane.limit(candidate);
  if (built.late && full) return unchanged("stale");
  const withdrawn = new Set<string>();
  if (candidate.cancelled && !pairLate || built.late && visible(existing) && !pairLate) withdrawn.add(subject);

  let evicted: T | null = null;
  const evictedDiagnostic: DiagnosticDetails = { level: "INFO", component: "localBulletins", reason: "localBulletinsCapacityEvicted", unit: "U-M", count: 1 };
  let kept = values;
  if (full) {
    evicted = evictOne(values, bucket, now, operation);
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

  // Q-NOTICE.generationTable（自分の subject だけ、一 channel 1 件）。訂正は事実が同じでも作る。同じ版の竜巻の対の後着では作らない。
  const was = visible(existing), now_ = visible(next);
  const correction = candidate.infoRank === 2;
  const release = candidate.slice === "tornado" && candidate.release && !candidate.cancelled;
  const style = lane.style(candidate);
  let payload: LocalBulletinsNotificationPayload | null = null;
  if (!pairLate) {
    if (candidate.cancelled) { if (was) payload = payloadOf(style.domain, operation, "cancel", candidate.title, "", "cancel"); }
    else if (release) { if (was) payload = payloadOf(style.domain, operation, "info", candidate.title, "", "release"); }
    else if (visible(next) && (correction || !was || changed(existing, next).length !== 0))
      payload = payloadOf(style.domain, operation, style.level, next.title, lane.body(candidate, next), correction ? "correction" : "plain");
  }
  const transition = candidate.cancelled ? "cancelled" as const : release ? "released" as const : correction || was ? "updated" as const : "activated" as const;
  const fresh = payload == null ? [] : intentsFor(candidate, transition, payload, state.persistence.currentGeneration + 1, now);
  const notices = admit(state.intents, fresh, withdrawn);
  const result: State = { ...lane.write(state, slice), intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };

  // change は最終の表示の変化で決める（I-U-M.currentSemantics(5)）。accepted は最終の状態に残る subject（今回の記録）。
  const shownChange = was !== now_ || was && changed(existing, next).length !== 0;
  const kind = evicted != null || shownChange ? "semantic" as const : "revisionOnly" as const;
  const decision: Decision = { subject, operation, decision: "changed", reason: null, change: kind,
    currentEstablished: { family: candidate.headType, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } };
  const diagnostics: DiagnosticDetails[] = [];
  if (evicted != null) diagnostics.push(evictedDiagnostic);
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "localBulletins", reason: "notificationCapacityEvicted", unit: "U-M", count: notices.dropped });
  const replaced: Change = existing == null ? [null, next] : [existing, next];
  return {
    changes: [...evicted == null ? [] : [[evicted, null] satisfies Change], replaced],
    step: { state: result, nextDeadline: nextDeadline(result), decisions: [decision], intents: notices.admitted,
      outcomes: [{ kind: "accepted", change: kind, subjects: [outcomeOf(next, changed(existing, next))] }], diagnostics },
  };
}

function receive(state: State, input: Extract<LocalBulletinsInput, { kind: "receive" }>): Result {
  const parsed = parseLocalBulletins(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C13-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  switch (candidate.slice) {
    case "tornado": return receiveWith(tornadoLane, state, candidate, input.clock);
    case "heat": return receiveWith(heatLane, state, candidate, input.clock);
    case "transient": return receiveWith(transientLane, state, candidate, input.clock);
    default: { const missing: never = candidate; throw new Error(`local bulletins candidate ${String(missing)} is not handled`); }
  }
}

// ---- 期限（I-U-M.deadlines。到来分だけを移行・回収する。到来の処理は無音） ----

// retainUntil の到来で記録を除き、見える期限の到来で active を ended・evidence にする。
// ponytail: 全 subject の同時の期限だけが一括の回収になる（上限は件数の上限で、保持と decode の両方で効く）。
function sweep<T extends Rec>(values: readonly T[], now: number, expire: (item: T) => T, expireIsPersisted: boolean):
  Readonly<{ values: readonly T[]; changes: readonly Change[]; persisted: boolean }> {
  if (recordMin(values) > now) return { values, changes: [], persisted: false };
  const changes: Change[] = [];
  let persisted = false;
  const next = values.flatMap((item) => {
    // 見える期限と retainUntil が同時に来た active も、先に ended・evidence に移して見えなくなる変化（decision・outcome）を残してから除く。
    if (item.effective === "active" && deadlineOf(item) <= now) {
      const moved = expire(item);
      changes.push([item, moved]);
      persisted ||= expireIsPersisted;
      if (moved.retainUntil > now) return [moved];
      changes.push([moved, null]);
      persisted = true;
      return [];
    }
    if (item.retainUntil <= now) { changes.push([item, null]); persisted = true; return []; }
    return [item];
  });
  return { values: next, changes, persisted };
}

function collect(state: State, clock: ClockReading, withIntents: boolean): Readonly<{ state: State; changes: readonly Change[]; expiredIntents: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0 };
  const tornado = sweep(state.tornado, now, tornadoLane.expire, tornadoLane.expireIsPersisted), heat = sweep(state.heat, now, heatLane.expire, heatLane.expireIsPersisted);
  const transient = sweep(state.transient, now, transientLane.expire, transientLane.expireIsPersisted);
  const intents = !withIntents || intentMin(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = intents === state.intents ? 0 : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  const persisted = tornado.persisted || heat.persisted || transient.persisted || intents !== state.intents;
  const moved: State = { ...state, tornado: tornado.values, heat: heat.values, transient: transient.values, intents };
  return { state: persisted ? { ...moved, persistence: dirty(state.persistence, clock.monotonicMs) } : moved,
    changes: [...tornado.changes, ...heat.changes, ...transient.changes], expiredIntents };
}

function deadlineStep(state: State, clock: ClockReading): Result {
  const applied = collect(state, clock, true);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "localBulletins", reason: "notificationExpired",
    unit: "U-M", count: applied.expiredIntents }];
  // 見えなくなる移行だけが changed/semantic（O08:4・O08:29）。除去は無音。
  const ended = applied.changes.flatMap(([before, after]) => visible(before) && after != null && !visible(after) ? [after] : []);
  return { changes: applied.changes, step: { ...idle(applied.state),
    decisions: ended.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "semantic" as const, currentEstablished: null })),
    outcomes: ended.length === 0 ? [] : [{ kind: "deadlineApplied", subjects: ended.map((item) => outcomeOf(item, ["effective"])) }], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: State, input: Extract<LocalBulletinsInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, LocalBulletinsIntent>();
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

// Q-NOTICE.restart・I-U-M.restore: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。先に retainUntil を過ぎた記録を除き、
// 残る竜巻・熱中症の active のうち見える期限を過ぎたものを無音で ended にする。どちらかが起きれば保存世代を進める。
// intent の期限切れの回収は復元の後の最初の期限処理で行う。
function restore(state: State, persisted: PersistedLocalBulletinsUnit, clock: ClockReading): Result {
  const decoded = localBulletinsUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "localBulletins",
    reason: "requiredStructureInvalid", unit: "U-M" }] } };
  const applied = collect({ ...decoded.state, contentRevision: state.contentRevision, persistence: state.persistence }, clock, false);
  const shown = [...applied.state.tornado, ...applied.state.heat, ...applied.state.transient].filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-M"], coverage: shown.map((item) => item.subject), subjects: [] }] } };
}

function reduceCore(state: State, input: LocalBulletinsInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock);
    // 閉じる batch・相関待ちを持たないので、終了入力は同じ state を返す（types.ts の LocalBulletinsInput）。
    case "shutdown": return { changes: [], step: { ...idle(state), outcomes: [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] } };
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`local bulletins input ${String(missing)} is not handled`); }
  }
}

function reduceLocalBulletinsUnit(state: State, input: LocalBulletinsInput): LocalBulletinsUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: Rec | null; after: Rec | null; operation: Operation }>();
  for (const pair of changes) {
    const [before, value] = pair;
    const { subject: key, operation } = target(pair);
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after: value, operation });
  }
  const displayChanges: LocalBulletinsUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after: value, operation }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(value) ? value : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-M", operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-M content revision exhausted");
  // P3-C13-N2: U-M は確認 scope を作らない。
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toLocalBulletinsView(state: State): LocalBulletinsUnitView {
  const tornado = state.tornado.filter(visible), heat = state.heat.filter(visible), transient = state.transient.filter(visible);
  const subjects = [...tornado, ...heat, ...transient].map(shownOutcome);
  return { unit: "U-M", semanticRevision: subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`).sort().join("|"),
  contentRevision: String(state.contentRevision), subjects, tornado, heat, transient };
}

// ---- codec（I-U-M.persisted・I-U-M.decode、唯一の LocalBulletinsUnitCodec。受理と同じ上限を確かめる） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const bounded = (value: unknown, limit: number): value is string => isText(value) && value.length <= limit;
const boundedName = (value: unknown, limit: number): value is string => bounded(value, limit) && validName(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null, limit = Infinity): T[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}
// I-U-M.subjects の形（Q-ENUM.identity の文字と長さ）。
type SubjectParts = Readonly<{ operation: Operation }> & (
  | Readonly<{ slice: "tornado"; office: string; title: string }>
  | Readonly<{ slice: "heat" }>
  | Readonly<{ slice: "transient"; headType: TransientHeadType; family: TransientFamily }>
);
function subjectParts(subject: string): SubjectParts | null {
  const head = /^(normal|training|test)\/([A-Za-z0-9]+)\/([\s\S]*)$/.exec(subject);
  const operation = operationOf(head?.[1]);
  if (head == null || operation == null) return null;
  const rest = head[3];
  if (head[2] === "tornado") {
    const split = rest.indexOf("/");
    const office = rest.slice(0, split), title = rest.slice(split + 1);
    return split < 0 || !validOffice(office) || !validKeyTitle(title) ? null : { operation, slice: "tornado", office, title };
  }
  if (head[2] === "VPFT50") return validEventId(rest) ? { operation, slice: "heat" } : null;
  const headType = TRANSIENT_TYPES.find((item) => item === head[2]);
  if (headType == null) return null;
  const family = FAMILY_OF[headType];
  if (headType === "VPAW51") {
    const split = rest.indexOf("/");
    return split < 0 || !validCode(rest.slice(0, split)) || !validKeyTitle(rest.slice(split + 1)) ? null : { operation, slice: "transient", headType, family };
  }
  return validSeries(rest) ? { operation, slice: "transient", headType, family } : null;
}
function reportRef(value: unknown, subject: string, parts: SubjectParts): ReportRef | null {
  const ref = readReportRef(value);
  if (ref == null || ref.subject !== subject || parts.operation !== ref.operation
    || !validReportDateTime(ref.reportDateTimeRaw) || ref.serialRaw !== "" && !validSerial(ref.serialRaw) || infoRankOf(ref.infoTypeRaw) == null) return null;
  const family = parts.slice === "tornado" ? ref.family === "VPHW50" || ref.family === "VPHW51" ? ref.family : null
    : parts.slice === "heat" ? ref.family === "VPFT50" ? ref.family : null : ref.family === subject.split("/")[1] ? ref.family : null;
  return family == null ? null : ref;
}
function textRecord(row: Fields): Text | null {
  return typeof row.truncated !== "boolean" || !boundedName(row.title, BOUNDS.title) || !bounded(row.headline, BOUNDS.headline)
    || !validHeadline(row.headline) || !boundedName(row.editorialOffice, BOUNDS.office) ? null
    : { title: row.title, headline: row.headline, editorialOffice: row.editorialOffice, truncated: row.truncated };
}
function tornadoAreaRecord(value: unknown): TornadoArea | null {
  const row = record(value);
  const layer: TornadoAreaLayer | undefined = LAYER_SET.find((item) => item === row?.layer);
  return row == null || layer == null || !isText(row.code) || !validCode(row.code) || !boundedName(row.name, BOUNDS.name) ? null
    : { layer, code: row.code, name: row.name };
}
// 枝ごとに持ってよい事実の field（types.ts の判別共用体）。ほかの枝の field を持つ保存物は拒む。
const FACT_KEYS = ["activeUntil", "targetDate", "title", "headline", "editorialOffice", "truncated", "sighted", "areas", "areaName", "visibleUntil", "tags"] as const;
const BRANCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  "tornado/active": ["activeUntil", "title", "headline", "editorialOffice", "truncated", "sighted", "areas"],
  "heat/active": ["activeUntil", "targetDate", "title", "headline", "editorialOffice", "truncated", "areaName"],
};
function tornadoRecord(row: Fields, base: Base, parts: Extract<SubjectParts, { slice: "tornado" }>): TornadoCurrent | null {
  if (row.effective === "ended" || row.effective === "cancelled") return tornadoMemory(base, row.effective);
  const text = textRecord(row);
  const areas = list(row.areas, tornadoAreaRecord, LIMITS.tornadoAreas);
  const start = reportMs(base.source);
  // activeUntil は ReportDateTime ＜ activeUntil ≦ retainUntil（ValidDateTime は保存しないので範囲、P3-C13-TORNADO-EXPIRY.common）。
  if (row.effective !== "active" || text == null || areas == null || typeof row.sighted !== "boolean" || !finite(row.activeUntil)
    || row.activeUntil <= start || row.activeUntil > start + TORNADO_RETAIN || text.title !== parts.title || text.editorialOffice !== parts.office) return null;
  return tornadoActive(base, text, row.activeUntil, row.sighted, areas);
}
function heatRecord(row: Fields, base: Base): HeatCurrent | null {
  if (row.effective === "ended" || row.effective === "cancelled") return heatMemory(base, row.effective);
  const text = textRecord(row);
  const start = reportMs(base.source);
  const end = isText(row.targetDate) ? dateEnd(row.targetDate) : null;
  const areaName = row.areaName === null ? null : boundedName(row.areaName, BOUNDS.name) ? row.areaName : undefined;
  // activeUntil は対象日の終わりと等しく、ReportDateTime ＜ activeUntil ≦ ReportDateTime ＋ 48 時間（P3-C13-HEAT-EXPIRY=A）。
  if (row.effective !== "active" || text == null || !isText(row.targetDate) || end == null || areaName === undefined || row.activeUntil !== end
    || end <= start || end > start + HEAT_TARGET_WINDOW) return null;
  return heatActive(base, text, end, row.targetDate, areaName);
}
function transientRecord(row: Fields, base: Base, family: TransientFamily): PersistedTransientCurrent | null {
  return row.effective === "evidence" || row.effective === "cancelled" ? transientMemory(base, family, row.effective) : null;
}
// slice の記録。retainUntil は source の ReportDateTime と slice（family）の等式（decode も受理と同じ関数で組み立てる）。
type Head = Readonly<{ row: Fields; parts: SubjectParts; base: Base }>;
function headOf(value: unknown): Head | null {
  const row = record(value);
  const parts = isText(row?.subject) ? subjectParts(row.subject) : null;
  if (row == null || parts == null || !isText(row.subject) || parts.operation !== operationOf(row.operation)) return null;
  const source = reportRef(row.source, row.subject, parts);
  if (source == null) return null;
  const allowed = BRANCH_KEYS[`${parts.slice}/${String(row.effective)}`] ?? [];
  if (FACT_KEYS.some((key) => key in row && !allowed.includes(key))) return null;
  return { row, parts, base: { subject: row.subject, operation: parts.operation, source } };
}
function tornadoCurrent(value: unknown): TornadoCurrent | null {
  const head = headOf(value);
  const built = head != null && head.parts.slice === "tornado" ? tornadoRecord(head.row, head.base, head.parts) : null;
  return built != null && head?.row.retainUntil === built.retainUntil ? built : null;
}
function heatCurrent(value: unknown): HeatCurrent | null {
  const head = headOf(value);
  const built = head != null && head.parts.slice === "heat" ? heatRecord(head.row, head.base) : null;
  return built != null && head?.row.retainUntil === built.retainUntil ? built : null;
}
function transientCurrent(value: unknown): PersistedTransientCurrent | null {
  const head = headOf(value);
  const built = head != null && head.parts.slice === "transient" && head.row.family === head.parts.family
    ? transientRecord(head.row, head.base, head.parts.family) : null;
  return built != null && head?.row.retainUntil === built.retainUntil ? built : null;
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): LocalBulletinsIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const parts = isText(row?.subject) ? subjectParts(row.subject) : null;
  const source = isText(row?.subject) && parts != null ? reportRef(row.source, row.subject, parts) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const domain = payload?.domain === "weather" || payload?.domain === "earthquake-eew" ? payload.domain : null;
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-M.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || domain == null || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-M" || !isText(row.subject) || source.operation !== operation
    || !bounded(payload.title, NOTICE_BOUNDS.title) || payload.title === "" || !bounded(payload.body, NOTICE_BOUNDS.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-M", subject: row.subject, operation, source, transition, channel,
    payload: { domain, level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision, disposition };
}
function persisted(value: unknown): PersistedLocalBulletinsUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const tornado = list(row.tornado, tornadoCurrent, TORNADO_LIMIT), heat = list(row.heat, heatCurrent, HEAT_LIMIT);
  const transient = list(row.transient, transientCurrent, TRANSIENT_TOTAL), intents = list(row.intents, intentRecord);
  if (tornado == null || heat == null || transient == null || intents == null) return null;
  // 件数: family ごとの上限と、slice 内の subject の重複なし。
  const families = new Map<TransientFamily, number>();
  for (const item of transient) families.set(item.family, (families.get(item.family) ?? 0) + 1);
  if ([...families].some(([family, total]) => total > TRANSIENT_LIMIT[family])) return null;
  for (const rows of [tornado, heat, transient])
    if (new Set(rows.map((item) => item.subject)).size !== rows.length) return null;
  if (new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  const pending = intents.filter((entry) => entry.disposition === "pending");
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。終端記録は pending との合計で見る（Q-NOTICE.capacity）。
  const pendingBytes = listBytes(pending) + pending.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedLocalBulletinsUnit = { schemaVersion: SCHEMA, tornado, heat, transient, intents };
  if (pending.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || pendingBytes + terminalBytes(intents) > PENDING_BYTES + TERMINAL_BYTES
    || generationBytes(result) > GENERATION_LIMIT) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
// 保存するのは受理の証拠だけ。transient の active は evidence として書く（P3-C13-TRANSIENT-EVIDENCE=A）。
const evidenceCache = new WeakMap<TransientCurrent, PersistedTransientCurrent>();
const isEvidence = (item: TransientCurrent): item is PersistedTransientCurrent => item.effective !== "active";
function evidenceOf(item: TransientCurrent): PersistedTransientCurrent {
  if (isEvidence(item)) return item;
  let found = evidenceCache.get(item);
  if (found == null) { found = transientMemory(baseOf(item), item.family, "evidence"); evidenceCache.set(item, found); }
  return found;
}
const localBulletinsUnitCodec: LocalBulletinsUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p3-local-bulletins-unit-v1", "p3-local-bulletins-unit-v2"], maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  // contentRevision・persistence は保存しない（I-U-M.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, tornado: state.tornado, heat: state.heat, transient: state.transient.map(evidenceOf), intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-local-bulletins-unit-v3 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-M.runtimeRows）。
const localBulletinsUnit = {
  unit: "U-M",
  reduce: reduceLocalBulletinsUnit,
  toView: toLocalBulletinsView,
  persistence: { kind: "durable", codec: localBulletinsUnitCodec },
  confirmationScopeLimit: TORNADO_LIMIT + HEAT_LIMIT + TRANSIENT_TOTAL,
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-M">;

export { generationBytes, localBulletinsUnit, localBulletinsUnitCodec, reduceLocalBulletinsUnit, toLocalBulletinsView };
