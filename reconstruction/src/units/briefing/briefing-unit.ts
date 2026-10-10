import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline, SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  BriefingArea, BriefingCurrent, BriefingInput, BriefingIntent, BriefingItem, BriefingKind, BriefingNotificationPayload, BriefingObservation,
  BriefingUnitCodec, BriefingUnitState, BriefingUnitStep, BriefingUnitView, PersistedBriefingUnit,
} from "../../../contracts/p3-briefing-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { BOUNDS, LIMITS, kindOf, parseBriefing, validCode, validHeadline, validSeries, validUnit } from "../../domains/briefing/briefing";
import type { BriefingCandidate } from "../../domains/briefing/briefing";
import { cut, infoRankOf, validInputId, validName, validReportDateTime, validSerial, validTime, validValue } from "../../domains/flood/flood";

// P3-UNIT-B-001（C12、I-U-B）: U-B の系列の current・予測の置換・alias・通知・容量・codec・射影。

const SCHEMA = "p3-briefing-unit-v1" as const;
// P3-C12-BOUNDS=A・P3-C12-RES-01・RET-01〜04。
const CURRENT_LIMIT = 256, GENERATION_LIMIT = 2_097_152;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 98_304;
// P3-C12-TTL=B（SEM-01・02、元報の ReportDateTime から）と相関の窓（SEM-03、受理の時計から）。
const SHORT_MS = 7_200_000, LONG_MS = 10_800_000, HOLD_MS = 60_000;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;
const UNCONFIRMED = "（対応電文未確認）";

type Visible = BriefingUnitView["currents"][number];
type Level = BriefingNotificationPayload["level"];
type InternalStep = Omit<BriefingUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = BriefingUnitStep["decisions"][number];
type Change = readonly [before: BriefingCurrent | null, after: BriefingCurrent | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;
type Base = Readonly<{ subject: string; operation: Operation; series: string; source: ReportRef }>;
type Text = Readonly<{ title: string; headline: string; editorialOffice: string; truncated: boolean }>;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// view に載るのは VPBS50 の active と VPOA50 の released だけ（I-U-B.view）。
const visible = (value: BriefingCurrent | null): value is Visible => value?.effective === "active" || value?.effective === "released";
const predicted = (item: BriefingItem) => item.kind === "linearRainPredicted";

// ---- 記録の組み立て（retainUntil は P3-C12-TTL=B の等式。decode も同じ関数で確かめる） ----

const baseOf = (value: Base): Base => ({ subject: value.subject, operation: value.operation, series: value.series, source: value.source });
const textOf = (value: Text): Text => ({ title: value.title, headline: value.headline, editorialOffice: value.editorialOffice,
  truncated: value.truncated });
const after = (base: Base, ms: number) => reportMs(base.source) + ms;
function activeOf(base: Base, text: Text, items: readonly BriefingItem[], observations: readonly BriefingObservation[]): BriefingCurrent {
  const longer = items.length !== 0 && items.every(predicted);
  return { ...base, headType: "VPBS50", retainUntil: after(base, longer ? LONG_MS : SHORT_MS), effective: "active", ...text, items, observations };
}
function memoryOf(base: Base, headType: "VPBS50" | "VPOA50", effective: "replaced" | "cancelled"): BriefingCurrent {
  return headType === "VPOA50" ? { ...base, headType, retainUntil: after(base, LONG_MS), effective: "cancelled" }
    : { ...base, headType, retainUntil: after(base, LONG_MS), effective };
}
function recordRainOf(base: Base, text: Text, areas: readonly BriefingArea[], effective: "released" | "aliased"): BriefingCurrent {
  return { ...base, headType: "VPOA50", retainUntil: after(base, effective === "aliased" ? LONG_MS : SHORT_MS), effective, ...text, areas };
}
function heldOf(base: Base, text: Text, areas: readonly BriefingArea[], holdUntil: number): BriefingCurrent {
  return { ...base, headType: "VPOA50", retainUntil: after(base, SHORT_MS), effective: "held", holdUntil, ...text, areas };
}

// ---- byte の加算（I-U-B.computation。受信 1 回で state 全体を直列化しない） ----

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
const terminalBytes = (intents: readonly BriefingIntent[]): number =>
  intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-B", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-R ほかと同じ予約）。4: 空の配列 2 つ。
function generationBytes(value: PersistedBriefingUnit): number {
  return emptyEnvelopeBytes + 62 - 4 + listBytes(value.currents) + listBytes(value.intents);
}

// ---- 期限（I-U-B.deadlines: retainUntil・held の holdUntil・intent の expiresAt の最小） ----

const deadlineCache = new WeakMap<readonly object[], number>();
function minOf<T extends object>(values: readonly T[], at: (value: T) => number): number {
  let min = deadlineCache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); deadlineCache.set(values, min); }
  return min;
}
const recordDeadline = (item: BriefingCurrent) => item.effective === "held" ? Math.min(item.retainUntil, item.holdUntil) : item.retainUntil;
const deadlineAt = (state: BriefingUnitState): number =>
  Math.min(minOf(state.currents, recordDeadline), minOf(state.intents, (item) => item.expiresAt));
function nextDeadline(state: BriefingUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: BriefingUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

// ---- 索引（配列に結び付けた Map、I-U-B.computation） ----

// subject の位置と、区域の code（`${operation}|${code}`）ごとの「その区域の発生を持つ active の記録の数」と「その区域の予測を持つ記録の位置」。
type Index = Readonly<{ subjects: ReadonlyMap<string, number>; observed: ReadonlyMap<string, number>; predicted: ReadonlyMap<string, readonly number[]> }>;
const indexCache = new WeakMap<readonly BriefingCurrent[], Index>();
const codesOf = (items: readonly BriefingItem[], kind: BriefingKind) =>
  new Set(items.filter((item) => item.kind === kind).flatMap((item) => item.areas.map((area) => area.code)));
function indexOf(values: readonly BriefingCurrent[]): Index {
  let index = indexCache.get(values);
  if (index == null) {
    const subjects = new Map<string, number>(), observed = new Map<string, number>(), predictedAt = new Map<string, number[]>();
    values.forEach((item, at) => {
      subjects.set(item.subject, at);
      if (item.effective !== "active") return;
      for (const code of codesOf(item.items, "linearRainObserved")) observed.set(`${item.operation}|${code}`, (observed.get(`${item.operation}|${code}`) ?? 0) + 1);
      for (const code of codesOf(item.items, "linearRainPredicted")) {
        const key = `${item.operation}|${code}`;
        const list = predictedAt.get(key);
        if (list == null) predictedAt.set(key, [at]);
        else list.push(at);
      }
    });
    index = { subjects, observed, predicted: predictedAt };
    indexCache.set(values, index);
  }
  return index;
}
// P3-C12-ALIAS=A: VPOA50 の系列 s と VPBS50 の系列「K」＋s を同じ運用区分の中でだけ結ぶ。
const ALIAS_SERIES = /^JP[A-Z]{2}\d{12}$/;
const counterpartOf = (operation: Operation, series: string) => ALIAS_SERIES.test(series) ? `${operation}/VPBS50/K${series}` : null;
const aliasOf = (operation: Operation, series: string) => {
  const found = /^K(JP[A-Z]{2}\d{12})$/.exec(series);
  return found == null ? null : `${operation}/VPOA50/${found[1]}`;
};
function recordAt(values: readonly BriefingCurrent[], subject: string | null): Readonly<{ at: number; value: BriefingCurrent }> | null {
  const at = subject == null ? undefined : indexOf(values).subjects.get(subject);
  return at == null ? null : { at, value: values[at] };
}
// 予測の item から covered な区域を除き、区域が 0 になった item を除く（P3-C12-REPLACE.common）。
function withoutAreas(items: readonly BriefingItem[], covered: (code: string) => boolean): readonly BriefingItem[] {
  let removed = false;
  const kept = items.flatMap((item) => {
    if (!predicted(item)) return [item];
    const areas = item.areas.filter((area) => !covered(area.code));
    if (areas.length === item.areas.length) return [item];
    removed = true;
    return areas.length === 0 ? [] : [{ ...item, areas }];
  });
  return removed ? kept : items;
}

// P3-C12-CAPACITY=A と P3-C12-EVICT-OPERATION: 257 件目は (1) retainUntil を過ぎた記録 (2) 記憶（replaced・aliased・cancelled）
// (3) training/test の生きた記録 (4) normal の生きた記録、それぞれ ReportDateTime の古い順で退去する。受ける報が training/test なら
// normal の記録は (1)〜(4) とも候補にせず、候補が無ければ null（受けた記録自身を退去する）。
// ponytail: 満杯の 256 件の素朴な線形の走査（上限は CURRENT_LIMIT で、保持と decode の両方で効く。台帳 47 の例外）。
function evictOne(values: readonly BriefingCurrent[], now: number, incoming: Operation): BriefingCurrent | null {
  const live = (item: BriefingCurrent) => item.effective === "active" || item.effective === "held" || item.effective === "released";
  const tier = (item: BriefingCurrent) => item.retainUntil <= now ? 0 : !live(item) ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: BriefingCurrent | null = null;
  for (const item of values) {
    if (item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// ReportDateTime、同時刻なら Serial（数として）、なお同じなら InfoType の優先。
function compare(candidate: BriefingCandidate, source: ReportRef): number {
  const time = candidate.reportDateTimeMs - reportMs(source);
  if (time !== 0) return Math.sign(time);
  const serial = Number(candidate.source.serialRaw) - Number(source.serialRaw);
  if (serial !== 0) return Math.sign(serial);
  return Math.sign(candidate.infoRank - (infoRankOf(source.infoTypeRaw) ?? 0));
}

// 公開事実（Q-ENUM.revisionOrder の重複の判定と、I-U-B.currentSemantics(6) の見える記録の変化）。
const FACTS = ["effective", "title", "headline", "editorialOffice", "items", "observations", "areas"] as const;
function changed(before: BriefingCurrent | null, value: BriefingCurrent | null): string[] {
  const read = (record: BriefingCurrent | null, field: string): unknown => record == null ? null
    : Object.getOwnPropertyDescriptor(record, field)?.value ?? null;
  return FACTS.filter((field) => !isDeepStrictEqual(read(before, field), read(value, field)));
}

// ---- 系列の current（I-U-B.currentSemantics(1)(3)(4)） ----

// 報が作る自分の記録。予測の採用では発生の記録のある区域を最初から除き（P3-C12-REPLACE=B、時刻を比べない）、VPOA50 は対応報が
// active なら aliased、released の続報は released、それ以外は held（holdUntil は最初の値のまま、P3-C12-VPOA.holdRules (4)）。
function nextOf(candidate: BriefingCandidate, existing: BriefingCurrent | null, values: readonly BriefingCurrent[], now: number): BriefingCurrent {
  const base: Base = { subject: candidate.subject, operation: candidate.operation, series: candidate.series, source: candidate.source };
  if (candidate.cancelled) return memoryOf(base, candidate.headType, "cancelled");
  const text: Text = { title: candidate.title, headline: candidate.headline, editorialOffice: candidate.editorialOffice,
    truncated: candidate.truncated };
  if (candidate.headType === "VPBS50") {
    const index = indexOf(values);
    // 置き換える前の版自身の発生は数えず、この報の発生は数える。
    const own = existing?.effective === "active" ? codesOf(existing.items, "linearRainObserved") : new Set<string>();
    const fresh = codesOf(candidate.items, "linearRainObserved");
    const items = withoutAreas(candidate.items, (code) => fresh.has(code)
      || (index.observed.get(`${candidate.operation}|${code}`) ?? 0) - (own.has(code) ? 1 : 0) > 0);
    return candidate.items.length !== 0 && items.length === 0 ? memoryOf(base, "VPBS50", "replaced")
      : activeOf(base, text, items, candidate.observations);
  }
  if (recordAt(values, counterpartOf(candidate.operation, candidate.series))?.value.effective === "active")
    return recordRainOf(base, text, candidate.areas, "aliased");
  if (existing?.effective === "released") return recordRainOf(base, text, candidate.areas, "released");
  return heldOf(base, text, candidate.areas, existing?.effective === "held" ? existing.holdUntil : now + HOLD_MS);
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title、VPOA50 は末尾に「（対応電文未確認）」。本文は Headline、無ければ item ごとの
// 種別と区域、それも無ければ題。接頭辞・接尾辞は切る範囲の外に置き、本体だけを上限から引いた長さで切る（Q-NOTICE.payload、K5 の F15 の型）。
function payloadOf(operation: Operation, headType: "VPBS50" | "VPOA50", level: Level, title: string, body: string,
  mark: "plain" | "correction" | "cancel"): BriefingNotificationPayload {
  const suffix = headType === "VPOA50" ? UNCONFIRMED : "";
  const titleHead = PREFIX[operation] + (mark === "correction" ? "[訂正] " : mark === "cancel" ? "[取消] " : "");
  const bodyHead = mark === "correction" ? "訂正: " : "";
  return { domain: "weather", level, title: titleHead + cut(title, NOTICE_BOUNDS.title - titleHead.length - suffix.length) + suffix,
    body: mark === "cancel" ? "この情報は取り消されました" : bodyHead + cut(body, NOTICE_BOUNDS.body - bodyHead.length - suffix.length) + suffix };
}
function bodyOf(value: Visible): string {
  if (value.headline !== "") return value.headline;
  const summary = value.headType === "VPBS50" ? value.items.map((item) => [item.condition ?? "種別不明", item.areas.map((area) => area.name).join("・")]
    .filter((part) => part !== "").join(" ")).join(" / ") : "";
  return summary !== "" ? summary : value.title;
}
function intentsFor(source: Readonly<{ subject: string; operation: Operation; source: ReportRef }>, transition: BriefingIntent["transition"],
  payload: BriefingNotificationPayload, generation: number, now: number): BriefingIntent[] {
  // P3-C12-TRAINING=A: training/test は desktop だけ。
  const channels = source.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: `U-B:${source.subject}:${generation}:${channel}`, unit: "U-B", subject: source.subject,
    operation: source.operation, source: source.source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-B の intent は全部 other の群（P3-C12-NOTICE-GROUP=A）。
function a7Order(left: BriefingIntent, right: BriefingIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 終端記録の合計が 98,304 byte を超える分は、最古の終端記録から期限前に回収する。kept は今の配送の更新で終端にした記録で、回収しない
// （owner は更新した記録が残ることで照合する。C8 の Q-C8-IMPL-AMEND(1)）。
function trimTerminal(intents: readonly BriefingIntent[], kept: ReadonlySet<string> = new Set()): readonly BriefingIntent[] {
  let terminal = terminalBytes(intents);
  if (terminal <= TERMINAL_BYTES) return intents;
  const gone = new Set<BriefingIntent>();
  for (const item of intents.filter((value) => value.disposition !== "pending" && !kept.has(value.id))
    .sort((left, right) => left.createdAt - right.createdAt)) {
    if (terminal <= TERMINAL_BYTES) break;
    gone.add(item);
    terminal -= bytes(item) + 1;
  }
  return intents.filter((item) => !gone.has(item));
}
// Q-NOTICE.capacity と P3-C12-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、withdrawn の subject（取消・alias・
// 置換で replaced・遅着の撤回）は全 pending を置き換える。
function admit(current: readonly BriefingIntent[], fresh: readonly BriefingIntent[], withdrawn: ReadonlySet<string>):
  Readonly<{ intents: readonly BriefingIntent[]; admitted: readonly BriefingIntent[]; dropped: number }> {
  const superseded = new Set<BriefingIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.disposition === "pending" && (withdrawn.has(item.subject) || replaced.has(`${item.subject}\n${item.channel}`))) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
  const out = new Set<BriefingIntent>();
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
  // 新しい intent が容量で外れただけなら、既存の intent も終端記録も変わらないので元の配列を返す（C9 の Q-C9-IMPL-AMEND(9)(e)）。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  const intents = trimTerminal([...current.map((item) => superseded.has(item) || out.has(item)
    ? { ...item, disposition: "superseded" as const } : item), ...admitted]);
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- outcome と view ----

function factsOf(value: BriefingCurrent): Readonly<Record<string, JsonValue>> {
  if (value.effective === "active") return { series: value.series, effective: value.effective, title: value.title, headline: value.headline,
    editorialOffice: value.editorialOffice, items: value.items, observations: value.observations, truncated: value.truncated };
  if (value.effective === "released" || value.effective === "aliased" || value.effective === "held")
    return { series: value.series, effective: value.effective, title: value.title, headline: value.headline, editorialOffice: value.editorialOffice,
      areas: value.areas, truncated: value.truncated };
  return { series: value.series, effective: value.effective };
}
function outcomeOf(value: BriefingCurrent, changedFields: readonly string[]): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: factsOf(value), changedFields };
}
// view の subject は識別だけを持つ（事実は currents にあり、二重に載せると snapshot の予算を食う。U-L・U-R の先例）。
const outcomeCache = new WeakMap<BriefingCurrent, SubjectOutcome>();
function shownOutcome(value: BriefingCurrent): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = { ...outcomeOf(value, []), facts: { series: value.series, effective: value.effective } };
    outcomeCache.set(value, found);
  }
  return found;
}
function displaySubject(value: BriefingCurrent): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-B" }>> {
  return { unit: "U-B", operation: value.operation, subject: value.subject, office: null, current: visible(value) ? value : null,
    subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C12-PARAMETERS.adoptionOutcome の順。一入力の変更は一回の参照交換で確定する、spec:616） ----

function receiveCandidate(state: BriefingUnitState, candidate: BriefingCandidate, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const { subject, operation } = candidate;
  const found = recordAt(state.currents, subject);
  const existing = found?.value ?? null;
  let next = nextOf(candidate, existing, state.currents, now);
  const unchanged = (reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason }], diagnostics } });
  if (existing != null) {
    const order = compare(candidate, existing.source);
    // 取消以前の版は stale で、取消した subject を戻さない。同じ版・同じ InfoType は事実が同じなら duplicate、違えば先着を保つ。
    if (order < 0) return unchanged("stale");
    if (order === 0) return changed(existing, next).length === 0 ? unchanged("duplicate")
      : unchanged("stale", [{ level: "WARN", component: "briefing", reason: "briefingRevisionConflict", inputId: candidate.source.inputId, unit: "U-B" }]);
  }
  const withdrawn = new Set<string>();
  const vanished = (diagnostics: readonly DiagnosticDetails[], kept: BriefingUnitState, changes: readonly Change[], change: "semantic" | "revisionOnly"): Result =>
    ({ changes, step: { ...idle(kept), decisions: [{ subject, operation, decision: "changed", reason: null, change, currentEstablished: null }],
      outcomes: [{ kind: "accepted", change, subjects: [] }], diagnostics } });
  // P3-C12-TTL.lateRule（版の比較の後）: 受理の時点で自分の記録の retainUntil を過ぎた報は state を変えない。前の見える記録より新しい
  // 版なら採用して同じ reduce で回収し、前の記録を消してその pending を撤回する（P3-C12-LATE-INVERSION=A、他の subject へ作用しない）。
  if (next.retainUntil <= now) {
    if (found == null || !visible(found.value)) return unchanged("stale");
    withdrawn.add(subject);
    const notices = admit(state.intents, [], withdrawn);
    const result = { ...state, currents: state.currents.filter((_, at) => at !== found.at), intents: notices.intents,
      persistence: dirty(state.persistence, clock.monotonicMs) };
    return vanished([], result, [[found.value, null]], "semantic");
  }

  // P3-C12-CAPACITY=A・P3-C12-EVICT-OPERATION: 退去は入力の前の配列から 1 件を決め、作用は残った記録に当てる。
  let values = state.currents;
  let evicted: BriefingCurrent | null = null;
  const evictedDiagnostic: DiagnosticDetails = { level: "INFO", component: "briefing", reason: "briefingCapacityEvicted", unit: "U-B", count: 1 };
  if (found == null && values.length >= CURRENT_LIMIT) {
    evicted = evictOne(values, now, operation);
    // training/test の報で退去できる記録が無ければ、受けた記録自身を退去する（currents の参照を変えない、通知しない）。採用した取消は
    // その subject の pending を置き換え、intents が変わったときだけ保存世代を進める。
    if (evicted == null) {
      if (candidate.cancelled) withdrawn.add(subject);
      const notices = admit(state.intents, [], withdrawn);
      const kept = notices.intents === state.intents ? state
        : { ...state, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };
      return vanished([evictedDiagnostic], kept, [], "revisionOnly");
    }
    const gone = evicted;
    const remaining = values.filter((item) => item !== gone);
    next = nextOf(candidate, null, remaining, now);
    // 退去の後の候補（対応報が退去で消えた VPOA50 は aliased の 3 時間から held の 2 時間へ変わる）で遅着を判定し直し、遅着なら退去も
    // 確定しない（P3-C12-TTL.lateRule・P3-C12-EVICT-OPERATION(5)、品質レビュー P2）。
    if (next.retainUntil <= now) return unchanged("stale");
    values = remaining;
  }

  // 置換・alias・対応報の取消（P3-C12-REPLACE=B・P3-C12-ALIAS=A・P3-C12-COUNTERPART-CANCEL=B）。edits は values の位置ごとの新しい記録（null は除く）。
  const own = found == null ? undefined : indexOf(values).subjects.get(subject);
  const edits = new Map<number, BriefingCurrent | null>();
  if (candidate.cancelled || next.effective === "aliased" || visible(existing) && next.effective === "replaced") withdrawn.add(subject);
  if (next.effective === "active") {
    const codes = codesOf(next.items, "linearRainObserved");
    const targets = new Set<number>();
    for (const code of codes) for (const at of indexOf(values).predicted.get(`${operation}|${code}`) ?? []) if (at !== own) targets.add(at);
    for (const at of targets) {
      const target = values[at];
      if (target.effective !== "active") continue;
      const items = withoutAreas(target.items, (code) => codes.has(code));
      // replaced になった予測の pending は撤回し、区域が減っただけなら保つ（P3-C12-REPLACE-PENDING=A）。
      if (items.length === 0) withdrawn.add(target.subject);
      edits.set(at, items.length === 0 ? memoryOf(baseOf(target), "VPBS50", "replaced") : activeOf(baseOf(target), textOf(target), items, target.observations));
    }
    const alias = recordAt(values, aliasOf(operation, candidate.series));
    if (alias != null && (alias.value.effective === "held" || alias.value.effective === "released")) {
      edits.set(alias.at, recordRainOf(baseOf(alias.value), textOf(alias.value), alias.value.areas, "aliased"));
      withdrawn.add(alias.value.subject);
    }
  }
  if (candidate.cancelled && candidate.headType === "VPBS50") {
    // 対応報の取消で aliased の VPOA50 を無音で released にし、retainUntil を 2 時間へ付け替える（過ぎていれば除く）。
    const alias = recordAt(values, aliasOf(operation, candidate.series));
    if (alias?.value.effective === "aliased") {
      const released = recordRainOf(baseOf(alias.value), textOf(alias.value), alias.value.areas, "released");
      edits.set(alias.at, released.retainUntil <= now ? null : released);
    }
  }
  if (own != null) edits.set(own, next);
  const currents = [...values.flatMap((item, at) => {
    const value = edits.get(at);
    return value === undefined ? [item] : value == null ? [] : [value];
  }), ...own == null ? [next] : []];

  // Q-NOTICE.generationTable（自分の subject だけ、一 channel 1 件）。訂正は事実が同じでも作る。
  const correction = candidate.infoRank === 2;
  const payload = candidate.cancelled ? visible(existing) ? payloadOf(operation, candidate.headType, "cancel", candidate.title, "", "cancel") : null
    : visible(next) && (correction || !visible(existing) || changed(existing, next).length !== 0)
      ? payloadOf(operation, candidate.headType, "warning", next.title, bodyOf(next), correction ? "correction" : "plain") : null;
  const transition = candidate.cancelled ? "cancelled" as const : correction || visible(existing) ? "updated" as const : "activated" as const;
  const fresh = payload == null ? [] : intentsFor(candidate, transition, payload, state.persistence.currentGeneration + 1, now);
  const notices = admit(state.intents, fresh, withdrawn);
  const result: BriefingUnitState = { ...state, currents, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };

  // change は最終の表示の変化で決める（I-U-B.currentSemantics(6)）。accepted は触れた subject のうち最終の状態に記録が残るもの。
  const touched: Change[] = [[existing, next], ...[...edits].filter(([at]) => at !== own).map(([at, value]): Change => [values[at], value])];
  const shownChange = ([before, value]: Change) => visible(before) !== visible(value) || visible(before) && changed(before, value).length !== 0;
  const change = evicted != null || touched.some(shownChange) ? "semantic" as const : "revisionOnly" as const;
  const decision: Decision = { subject, operation, decision: "changed", reason: null, change,
    currentEstablished: { family: candidate.headType, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } };
  const diagnostics: DiagnosticDetails[] = [];
  if (evicted != null) diagnostics.push(evictedDiagnostic);
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "notificationCapacityEvicted", unit: "U-B",
    count: notices.dropped });
  return {
    changes: [...evicted == null ? [] : [[evicted, null] as const], ...touched],
    step: { state: result, nextDeadline: nextDeadline(result), decisions: [decision], intents: notices.admitted,
      outcomes: [{ kind: "accepted", change, subjects: touched.flatMap(([before, value]) => value == null ? [] : [outcomeOf(value, changed(before, value))]) }],
      diagnostics },
  };
}

function receive(state: BriefingUnitState, input: Extract<BriefingInput, { kind: "receive" }>): Result {
  const parsed = parseBriefing(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C12-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  return receiveCandidate(state, candidate, input.clock);
}

// ---- 期限（I-U-B.deadlines。到来分だけを回収・移行する） ----

// retainUntil の到来で記録を黙って除き、holdUntil の到来で held を released にする（P3-C12-VPOA=A）。通知は期限処理の時刻が
// holdUntil+60 秒より前のときだけ（holdRules (2)）。restore・終了入力（silent）は held を全部無音で released にする（holdRules (3)(5)）。
// ponytail: 256 subject の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: BriefingUnitState, clock: ClockReading, silent: boolean): Readonly<{ state: BriefingUnitState; changes: readonly Change[];
  expiredIntents: number; intents: readonly BriefingIntent[]; dropped: number }> {
  const now = clock.wallTimeMs;
  const held = silent && state.currents.some((item) => item.effective === "held");
  if (!held && deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0, intents: [], dropped: 0 };
  const changes: Change[] = [];
  const generation = state.persistence.currentGeneration + 1;
  const released: BriefingIntent[] = [];
  const currents = !held && minOf(state.currents, recordDeadline) > now ? state.currents : state.currents.flatMap((item) => {
    if (item.retainUntil <= now) { changes.push([item, null]); return []; }
    if (item.effective !== "held" || !silent && item.holdUntil > now) return [item];
    const value = recordRainOf(baseOf(item), textOf(item), item.areas, "released");
    changes.push([item, value]);
    if (!silent && now < item.holdUntil + HOLD_MS && visible(value))
      released.push(...intentsFor(value, "activated", payloadOf(value.operation, "VPOA50", "warning", value.title, bodyOf(value), "plain"),
        generation, now));
    return [value];
  });
  const remaining = minOf(state.intents, (item) => item.expiresAt) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = remaining === state.intents ? 0
    : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  const notices = admit(remaining, released, new Set());
  const persisted = changes.length !== 0 || notices.intents !== state.intents;
  return { state: persisted ? { ...state, currents: changes.length === 0 ? state.currents : currents, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) } : state, changes, expiredIntents, intents: notices.admitted, dropped: notices.dropped };
}

function deadlineStep(state: BriefingUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock, shutdown);
  const diagnostics: DiagnosticDetails[] = [];
  if (applied.expiredIntents !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "notificationExpired", unit: "U-B",
    count: applied.expiredIntents });
  if (applied.dropped !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "notificationCapacityEvicted", unit: "U-B",
    count: applied.dropped });
  return { changes: applied.changes, step: { ...idle(applied.state), intents: applied.intents,
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] : [], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: BriefingUnitState, input: Extract<BriefingInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, BriefingIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changedIntents.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7〜C11 の先例）。更新で終端にした記録は期限前の回収から外す。
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

// Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。先に retainUntil を過ぎた記録を除き、残る held を
// 無音で released にする（相関待ちを再開しない、P3-C12-AC16）。どちらかが起きれば保存世代を進める。
function restore(state: BriefingUnitState, persisted: PersistedBriefingUnit, clock: ClockReading): Result {
  const decoded = briefingUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "briefing",
    reason: "requiredStructureInvalid", unit: "U-B" }] } };
  const applied = collect({ ...decoded.state, persistence: state.persistence }, clock, true);
  const shown = applied.state.currents.filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-B"], coverage: shown.map((item) => item.subject), subjects: [] }],
    diagnostics: applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "briefing", reason: "notificationExpired",
      unit: "U-B", count: applied.expiredIntents }] } };
}

function reduceCore(state: BriefingUnitState, input: BriefingInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, false);
    case "shutdown": return deadlineStep(state, input.clock, true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`briefing input ${String(missing)} is not handled`); }
  }
}

function reduceBriefingUnit(state: BriefingUnitState, input: BriefingInput): BriefingUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active・released）だけを表示の変化にする。
  const merged = new Map<string, { before: BriefingCurrent | null; after: BriefingCurrent | null }>();
  for (const [before, value] of changes) {
    const key = (value ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after: value });
  }
  const displayChanges: BriefingUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after: value }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(value) ? value : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-B", operation: (value ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-B content revision exhausted");
  // P3-C12-N2: U-B は確認 scope を作らない。
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toBriefingView(state: BriefingUnitState): BriefingUnitView {
  const currents = state.currents.filter(visible);
  const subjects = currents.map(shownOutcome);
  return { unit: "U-B", semanticRevision: subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`).sort().join("|"),
  contentRevision: String(state.contentRevision), admission: {}, subjects, currents };
}

// ---- codec（I-U-B.persisted・I-U-B.decode、唯一の BriefingUnitCodec。受理と同じ上限を確かめる） ----

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
// I-U-B.subjects の形（`${operation}/${headType}/${series}`、Q-ENUM.identity の文字と長さ）。
function subjectParts(subject: string): Readonly<{ operation: Operation; headType: "VPBS50" | "VPOA50"; series: string }> | null {
  const match = /^(normal|training|test)\/(VPBS50|VPOA50)\/([\s\S]*)$/.exec(subject);
  const operation = operationOf(match?.[1]);
  const headType = match?.[2] === "VPBS50" || match?.[2] === "VPOA50" ? match[2] : null;
  return match == null || operation == null || headType == null || !validSeries(match[3]) ? null : { operation, headType, series: match[3] };
}
function reportRef(value: unknown, subject: string): ReportRef | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  const parts = subjectParts(subject);
  if (row == null || operation == null || parts == null || row.family !== parts.headType || row.subject !== subject || parts.operation !== operation
    || !isText(row.inputId) || !validInputId(row.inputId) || !isText(row.reportDateTimeRaw) || !validReportDateTime(row.reportDateTimeRaw)
    || !isText(row.serialRaw) || !validSerial(row.serialRaw) || !isText(row.infoTypeRaw) || infoRankOf(row.infoTypeRaw) == null
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  return { inputId: row.inputId, origin: row.origin, operation, family: parts.headType, subject, reportDateTimeRaw: row.reportDateTimeRaw,
    serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
}
function areaRecord(value: unknown): BriefingArea | null {
  const row = record(value);
  return row == null || !isText(row.code) || !validCode(row.code) || !boundedName(row.name, BOUNDS.name) ? null : { code: row.code, name: row.name };
}
const KIND_SET: readonly BriefingKind[] = ["linearRainObserved", "linearRainPredicted", "recordRain", "shortSnow", "unknown"];
// 受理と同じ上限（item 4・区域の延べ 16・kind と condition の一致・予測の item の区域が 0 でない）。
function itemsRecord(value: unknown): BriefingItem[] | null {
  let total = 0;
  const items = list(value, (entry): BriefingItem | null => {
    const row = record(entry);
    const kind = KIND_SET.find((item) => item === row?.kind);
    const condition = row?.condition === null ? null : boundedName(row?.condition, BOUNDS.condition) ? row.condition : undefined;
    const areas = list(row?.areas, areaRecord, LIMITS.areas);
    if (row == null || kind == null || condition === undefined || kind !== kindOf(condition) || areas == null
      || kind === "linearRainPredicted" && areas.length === 0) return null;
    total += areas.length;
    return { kind, condition, areas };
  }, LIMITS.items);
  return items == null || total > LIMITS.areas ? null : items;
}
const PART_SET = ["event", "precipitation", "snowfall"] as const;
const APPROXIMATION_SET = ["exact", "approx", "atLeast", "unknown"] as const;
function observationRecord(value: unknown): BriefingObservation | null {
  const row = record(value);
  const part = PART_SET.find((item) => item === row?.part), approximation = APPROXIMATION_SET.find((item) => item === row?.approximation);
  // 受理が作りうる数（11 文字以下の `-?[0-9]{1,6}(\.[0-9]{1,3})?`）か null。
  const measured = row?.value === null ? null : finite(row?.value) && validValue(String(row.value)) ? row.value : undefined;
  const unit = row?.unit === null ? null : isText(row?.unit) && row.unit !== "" && validUnit(row.unit) ? row.unit : undefined;
  const time = row?.time === null ? null : isText(row?.time) && validTime(row.time) ? row.time : undefined;
  if (row == null || part == null || approximation == null || measured === undefined || unit === undefined || time === undefined
    || !isText(row.areaCode) || !validCode(row.areaCode) || !boundedName(row.areaName, BOUNDS.name) || !boundedName(row.label, BOUNDS.name)) return null;
  return { part, areaCode: row.areaCode, areaName: row.areaName, label: row.label, value: measured, unit, approximation, time };
}
function textRecord(row: Fields): Text | null {
  return typeof row.truncated !== "boolean" || !boundedName(row.title, BOUNDS.title) || !bounded(row.headline, BOUNDS.headline)
    || !validHeadline(row.headline) || !boundedName(row.editorialOffice, BOUNDS.office) ? null
    : { title: row.title, headline: row.headline, editorialOffice: row.editorialOffice, truncated: row.truncated };
}
// 枝ごとに持ってよい事実の field（types.ts の判別共用体）。ほかの枝の field を持つ保存物は拒む。
const FACT_KEYS = ["title", "headline", "editorialOffice", "truncated", "items", "observations", "areas", "holdUntil"] as const;
const BRANCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  "VPBS50/active": ["title", "headline", "editorialOffice", "truncated", "items", "observations"],
  "VPOA50/held": ["title", "headline", "editorialOffice", "truncated", "areas", "holdUntil"],
  "VPOA50/released": ["title", "headline", "editorialOffice", "truncated", "areas"],
  "VPOA50/aliased": ["title", "headline", "editorialOffice", "truncated", "areas"],
};
function currentRecord(value: unknown): BriefingCurrent | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  const parts = isText(row?.subject) ? subjectParts(row.subject) : null;
  if (row == null || operation == null || parts == null || !isText(row.subject) || parts.operation !== operation || row.headType !== parts.headType
    || row.series !== parts.series || !isText(row.effective)) return null;
  const source = reportRef(row.source, row.subject);
  if (source == null) return null;
  const allowed = BRANCH_KEYS[`${parts.headType}/${row.effective}`] ?? [];
  if (FACT_KEYS.some((key) => key in row && !allowed.includes(key))) return null;
  const base: Base = { subject: row.subject, operation, series: parts.series, source };
  const text = textRecord(row);
  let built: BriefingCurrent | null = null;
  if (parts.headType === "VPBS50") {
    if (row.effective === "replaced" || row.effective === "cancelled") built = memoryOf(base, "VPBS50", row.effective);
    else if (row.effective === "active") {
      const items = itemsRecord(row.items), observations = list(row.observations, observationRecord, LIMITS.observations);
      if (text != null && items != null && observations != null) built = activeOf(base, text, items, observations);
    }
  } else if (row.effective === "cancelled") built = memoryOf(base, "VPOA50", "cancelled");
  else {
    const areas = list(row.areas, areaRecord, LIMITS.areas);
    if (text != null && areas != null) {
      if (row.effective === "held") built = finite(row.holdUntil) ? heldOf(base, text, areas, row.holdUntil) : null;
      else if (row.effective === "released" || row.effective === "aliased") built = recordRainOf(base, text, areas, row.effective);
    }
  }
  // retainUntil は source の ReportDateTime と枝・種別の等式（P3-C12-TTL=B）。
  return built != null && row.retainUntil === built.retainUntil ? built : null;
}
const LEVEL_SET: readonly Level[] = ["warning", "critical", "cancel"];
function intentRecord(value: unknown): BriefingIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const source = isText(row?.subject) ? reportRef(row.source, row.subject) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-B.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-B" || !isText(row.subject) || source.operation !== operation
    || payload.domain !== "weather" || !isText(payload.title) || payload.title === "" || !isText(payload.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-B", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision, disposition };
}
function persisted(value: unknown): PersistedBriefingUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord, CURRENT_LIMIT), intents = list(row.intents, intentRecord);
  if (currents == null || intents == null || new Set(currents.map((item) => item.subject)).size !== currents.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  const pending = intents.filter((entry) => entry.disposition === "pending");
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。終端記録は pending との合計で見る（Q-NOTICE.capacity）。
  const pendingBytes = listBytes(pending) + pending.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedBriefingUnit = { schemaVersion: SCHEMA, currents, intents };
  if (pending.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || pendingBytes + terminalBytes(intents) > PENDING_BYTES + TERMINAL_BYTES
    || generationBytes(result) > GENERATION_LIMIT) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const briefingUnitCodec: BriefingUnitCodec = {
  schemaVersion: SCHEMA,
  // contentRevision・persistence は保存しない（I-U-B.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-briefing-unit-v1 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-B.runtimeRows）。
const briefingUnit = {
  unit: "U-B",
  reduce: reduceBriefingUnit,
  toView: toBriefingView,
  persistence: { kind: "durable", codec: briefingUnitCodec },
  confirmationScopeLimit: CURRENT_LIMIT,
  withoutNormal: (state) => ({ ...state, currents: state.currents.filter((item) => item.operation !== "normal") }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => state.currents.filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-B">;

export { briefingUnit, briefingUnitCodec, reduceBriefingUnit, toBriefingView };
