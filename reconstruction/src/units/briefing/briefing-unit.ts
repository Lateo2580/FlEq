import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline,
  SubjectOutcome, UnreadableMark, WallBasis,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  BriefingArea, BriefingCurrent, BriefingInput, BriefingRecordRainCurrent, BriefingReportCurrent, BriefingIntent, BriefingItem, BriefingKind, BriefingNotificationPayload, BriefingObservation,
  BriefingUnitCodec, BriefingUnitState, BriefingUnitStep, BriefingUnitView, BriefingUnreadableSite, PersistedBriefingUnit,
} from "../../../contracts/p3-briefing-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { readReportRef, stepVersion } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth"; import { bounded, count, finite, isText, list, operationOf, record } from "../codec-base";
import { BOUNDS, LIMITS, kindOf, parseBriefing, validCode, validHeadline, validSeries, validUnit } from "../../domains/briefing/briefing";
import type { BriefingCandidate } from "../../domains/briefing/briefing";
import { cut, infoRankOf, validEventId, validName, validReportDateTime, validSerial, validTime, validValue } from "../../domains/flood/flood";
import {
  applyIntentUpdate, cancelText, freshState, heard, markNotice, noticeId, noticeKind, noticed, raiseEvidence, readIntentState, readNoticeMark, restoreStarted,
  shown, updateEvidence, versionDigest,
} from "../notice-mark";
import { cachedMin } from "../expiry";
import {
  RAW_BUDGET, compareColumns, droppedIn, fitRawBudget, hasPart, rawTotal, readUnreadableMark, stripAll, unreadableMarkBytes,
} from "../unreadable";

// P3-UNIT-B-001（C12、I-U-B）: U-B の系列の current・予測の置換・alias・通知・容量・codec・射影。

const SCHEMA = "p3-briefing-unit-v7" as const;
// P3-C12-BOUNDS=A・P3-C12-RES-01・RET-01〜04。P3-UM-RES-09: 器は記録の上限×印 1 件（一覧の欄 observations の 1 つ）＋原文の予算＋カードの分だけ広げる。
const CURRENT_LIMIT = 256;
const GENERATION_LIMIT = 2_097_152 + CURRENT_LIMIT * unreadableMarkBytes("unreadable", 1) + RAW_BUDGET + UNREADABLE_CARDS_MAX_BYTES;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C12-TTL=B（SEM-01・02、元報の ReportDateTime から）と相関の窓（SEM-03、受理の時計から）。
const SHORT_MS = 7_200_000, LONG_MS = 10_800_000, HOLD_MS = 60_000;
// 期限切れの記憶は元報から 9 時間に固定（表示の期限 3 時間＋6 時間。どちらの表示の期限だったかの欄を持たない、P3-EF-AC05 (3) の D9）。
const EXPIRED_MS = 32_400_000;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;
const UNCONFIRMED = "（対応電文未確認）";

type Visible = Extract<BriefingReportCurrent, Readonly<{ effective: "active" }>> | Extract<BriefingRecordRainCurrent, Readonly<{ effective: "released" }>>;
type Level = BriefingNotificationPayload["level"];
type InternalStep = Omit<BriefingUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = BriefingUnitStep["decisions"][number];
type Change = readonly [before: BriefingCurrent | null, after: BriefingCurrent | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;
// eventId と inherited は VPBS50 の記録だけが持つ（VPOA50 は系列が EventID の全体）。VPOA50 の記録を組むときは外す（vpoa50Of）。
type Base = Readonly<{ subject: string; operation: Operation; series: string; eventId: string; inherited?: true; source: ReportRef;
  unconfirmed?: ReportRef; notice?: NoticeMark }>;
type Text = Readonly<{ title: string; headline: string; editorialOffice: string; truncated: boolean; unreadable?: UnreadableMark }>;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// P3-UM-AC03 (3): 原文を外す順は source の ReportDateTime の古い順（同じなら subject の順）。
const rawKey = (item: BriefingCurrent): readonly [number, string] => [reportMs(item.source), item.subject];
// view に載るのは VPBS50 の active と VPOA50 の released だけ（I-U-B.view）。保留の印のある記録は見えない（P3-EF-AC02 (2)）。
const shownKind = (value: BriefingCurrent | null): value is Visible => value?.effective === "active" || value?.effective === "released";
const visible = (value: BriefingCurrent | null): value is Visible => shownKind(value) && value.expiryPending !== true;
const predicted = (item: BriefingItem) => item.kind === "linearRainPredicted";

// ---- 記録の組み立て（retainUntil は P3-C12-TTL=B の等式。decode も同じ関数で確かめる） ----

// 未確認の印は系列の版の採用（取消を含む）と記録の回収でだけ外れ、他の系列の作用（置換・alias）と held の解放では残る（P3-VM-AC04）。
// 通知の印は記録と同じに生きる（P3-NL-AC02 (4)）。
const baseOf = (value: BriefingCurrent): Base => ({ subject: value.subject, operation: value.operation, series: value.series,
  eventId: value.headType === "VPBS50" ? value.eventId : value.series,
  ...value.headType === "VPBS50" && value.inherited === true ? { inherited: true } : {}, source: value.source,
  ...value.unconfirmed == null ? {} : { unconfirmed: value.unconfirmed }, ...value.notice == null ? {} : { notice: value.notice } });
const textOf = (value: Text): Text => ({ title: value.title, headline: value.headline, editorialOffice: value.editorialOffice,
  truncated: value.truncated, ...value.unreadable == null ? {} : { unreadable: value.unreadable } });
const after = (base: Base, ms: number) => reportMs(base.source) + ms;
function activeOf(base: Base, text: Text, items: readonly BriefingItem[], observations: readonly BriefingObservation[]): BriefingCurrent {
  const longer = items.length !== 0 && items.every(predicted);
  return { ...base, headType: "VPBS50", retainUntil: after(base, longer ? LONG_MS : SHORT_MS), effective: "active", ...text, items, observations };
}
const vpoa50Of = ({ eventId: _eventId, inherited: _inherited, ...base }: Base) => base;
// 全部記録雨の VPBS50（items が 1 件以上で全部 recordRain）が系列の subject にあるのは、訂正で系列の記録を引き継いだときだけ（retarget）。
const allRecordRain = (items: readonly BriefingItem[]) => items.length !== 0 && items.every((item) => item.kind === "recordRain");
function memoryOf(base: Base, headType: "VPBS50" | "VPOA50", effective: "replaced" | "cancelled"): BriefingCurrent {
  return headType === "VPOA50" ? { ...vpoa50Of(base), headType, retainUntil: after(base, LONG_MS), effective: "cancelled" }
    : { ...base, headType, retainUntil: after(base, LONG_MS), effective };
}
function recordRainOf(base: Base, text: Text, areas: readonly BriefingArea[], effective: "released" | "aliased"): BriefingCurrent {
  return { ...vpoa50Of(base), headType: "VPOA50", retainUntil: after(base, effective === "aliased" ? LONG_MS : SHORT_MS), effective, ...text, areas };
}
function heldOf(base: Base, text: Text, areas: readonly BriefingArea[], holdUntil: number): BriefingCurrent {
  return { ...vpoa50Of(base), headType: "VPOA50", retainUntil: after(base, SHORT_MS), effective: "held", holdUntil, ...text, areas };
}
function expiredOf(base: Base, headType: "VPBS50" | "VPOA50"): BriefingCurrent {
  return headType === "VPOA50" ? { ...vpoa50Of(base), headType, retainUntil: after(base, EXPIRED_MS), effective: "expired" }
    : { ...base, headType, retainUntil: after(base, EXPIRED_MS), effective: "expired" };
}
// 表示の期限の来た見える記録の形（P3-EF-AC02・AC05 (5)）: verified は記憶、unverified は保留の印、awaiting はそのまま。
function lapsed(value: Visible, basis: WallBasis): BriefingCurrent {
  return basis === "verified" ? expiredOf(baseOf(value), value.headType) : basis === "awaiting" || value.expiryPending === true ? value
    : { ...value, expiryPending: true };
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
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-B", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7)・P3-UM-AC11 (10): envelope の inputBoundary・losses・カードの最大（器からは引かない）
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-R ほかと同じ予約）。4: 空の配列 2 つ。
function generationBytes(value: PersistedBriefingUnit): number {
  return emptyEnvelopeBytes + 62 - 4 + listBytes(value.currents) + listBytes(value.intents);
}

// ---- 期限（I-U-B.deadlines: retainUntil・held の holdUntil・intent の expiresAt の最小） ----

const recordDeadline = (item: BriefingCurrent) => item.effective === "held" ? Math.min(item.retainUntil, item.holdUntil) : item.retainUntil;
// P3-EF-AC11 (2): 根拠で当てない種類を比べないよう、表示の期限・相関の窓・回収の期限・保留の記録・intent の期限を別々に持つ。nextDeadline は
// 根拠によらず全部の最小（保留の記録は元の表示の期限）。
const recordMin = cachedMin<BriefingCurrent>(recordDeadline);
const displayMin = cachedMin<BriefingCurrent>((item) => visible(item) ? item.retainUntil : Infinity);
const holdMin = cachedMin<BriefingCurrent>((item) => item.effective === "held" ? item.holdUntil : Infinity);
const recallMin = cachedMin<BriefingCurrent>((item) => shownKind(item) ? Infinity : item.retainUntil);
const pendingMin = cachedMin<BriefingCurrent>((item) => shownKind(item) && item.expiryPending === true ? item.retainUntil : Infinity);
const intentMin = cachedMin<BriefingIntent>((item) => item.expiresAt);
const deadlineAt = (state: BriefingUnitState): number => Math.min(recordMin(state.currents), intentMin(state.intents));
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
      // 保留の印のある記録は見えないので、置換の発生・予測に数えない。
      if (item.effective !== "active" || item.expiryPending === true) return;
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
function recordAt(values: readonly BriefingCurrent[], subject: string | null): Readonly<{ at: number; value: BriefingCurrent }> | null {
  const at = subject == null ? undefined : indexOf(values).subjects.get(subject);
  return at == null ? null : { at, value: values[at] };
}
// P3-C12-ALIAS=A・P3-EF-AC09 (2): VPBS50 の EventID の全体が「K」＋VPOA50 の全体か、両者が一致するとき、同じ運用区分の中でだけ結ぶ。
// 引くのは記録の EventID の全体で、全体の subject の記録か、系列の subject にあって EventID の全体が一致する記録（retarget で引き継いだ記録）。
function reportAt(values: readonly BriefingCurrent[], operation: Operation, eventId: string) {
  for (const subject of [`${operation}/VPBS50/${eventId}`, `${operation}/VPBS50/${eventId.split("_")[0]}`]) {
    const found = recordAt(values, subject);
    if (found?.value.headType === "VPBS50" && found.value.eventId === eventId) return found;
  }
  return null;
}
const counterpartOf = (values: readonly BriefingCurrent[], operation: Operation, eventId: string) =>
  reportAt(values, operation, `K${eventId}`) ?? reportAt(values, operation, eventId);
const aliasOf = (values: readonly BriefingCurrent[], operation: Operation, eventId: string) =>
  (eventId.startsWith("K") ? recordAt(values, `${operation}/VPOA50/${eventId.slice(1)}`) : null) ?? recordAt(values, `${operation}/VPOA50/${eventId}`);
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
// 第 1 段は受けた入力の根拠が verified のときだけ。保留の印のある記録は記憶の段に入る（P3-EF-AC03）。
function evictOne(values: readonly BriefingCurrent[], now: number, incoming: Operation, verified: boolean): BriefingCurrent | null {
  const live = (item: BriefingCurrent) => visible(item) || item.effective === "held";
  const tier = (item: BriefingCurrent) => verified && item.retainUntil <= now ? 0 : !live(item) ? 1 : item.operation !== "normal" ? 2 : 3;
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

// P3-VM-AC03: 系列ごとに compareVersion で比べる（報番号・InfoType の順位は使わない）。同じ版の中身には InfoType を含める。
// held は手元の版を残して印を付ける報（印は保存の byte に入るが、上界が予算の内側なので fit を要さない、P3-VM-AC08）。
function judge(existing: BriefingCurrent | null, next: BriefingCurrent, candidate: BriefingCandidate) {
  return stepVersion(existing == null ? null : { version: existing.source, source: existing.source, cancelled: existing.effective === "cancelled" },
    existing?.unconfirmed ?? null, candidate.source, () => existing != null && existing.source.infoTypeRaw.trim() === candidate.source.infoTypeRaw.trim()
    // 期限切れの記憶は事実を持たないので InfoType だけで見る（Q-EF-PRECHECK (0)(b)、U-M と同じ）。
    && (existing.effective === "expired" || changed(existing, next).length === 0), candidate.cancelled);
}

// 公開事実（Q-ENUM.revisionOrder の重複の判定と、I-U-B.currentSemantics(6) の見える記録の変化）。
const FACTS = ["effective", "title", "headline", "editorialOffice", "items", "observations", "areas"] as const;
const read = (record: BriefingCurrent | null, field: string): unknown => record == null ? null
  : Object.getOwnPropertyDescriptor(record, field)?.value ?? null;
function changed(before: BriefingCurrent | null, value: BriefingCurrent | null): string[] {
  return FACTS.filter((field) => !isDeepStrictEqual(read(before, field), read(value, field)));
}
// P3-UM-AC04: 通知を作るかの判定の比べ（ほかの使い道は changed のまま、Q-UM-PRECHECK-2 (8)(d)）。(i) editorialOffice (ii) observations
// (iii) items の condition（kind は condition から決まるので一緒に除く）。after は compare・compareKeys を書いた記録。
const markOf = (value: BriefingCurrent | null) => value != null && "unreadable" in value ? value.unreadable : undefined;
const reportOf = (value: BriefingCurrent | null) => value?.headType === "VPBS50" && value.effective === "active" ? value : null;
function noticeChange(before: BriefingCurrent | null, after: BriefingCurrent): Readonly<{ changed: boolean; after: BriefingCurrent }> {
  const was = markOf(before), now = markOf(after);
  const inner = hasPart(was, "condition") || hasPart(now, "condition");
  const items = (value: BriefingCurrent | null) => inner ? reportOf(value)?.items.map(({ condition: _condition, kind: _kind, ...rest }) => rest) ?? null
    : read(value, "items");
  const compared = compareColumns(was, now, [{ keys: [["editorialOffice"]], before: read(before, "editorialOffice"), after: read(after, "editorialOffice") },
    { list: "observation", before: reportOf(before)?.observations ?? [], after: reportOf(after)?.observations ?? [] },
    { keys: [], before: items(before), after: items(after) }]);
  const plain = FACTS.some((field) => field !== "editorialOffice" && field !== "observations" && field !== "items"
    && !isDeepStrictEqual(read(before, field), read(after, field)));
  return { changed: plain || compared.changed,
    after: compared.mark == null || compared.mark === now || !("title" in after) ? after : { ...after, unreadable: compared.mark } };
}

// ---- 系列の current（I-U-B.currentSemantics(1)(3)(4)） ----

// 報が作る自分の記録。予測の採用では発生の記録のある区域を最初から除き（P3-C12-REPLACE=B、時刻を比べない）、VPOA50 は対応報が
// active なら aliased、released の続報は released、それ以外は held（holdUntil は最初の値のまま、P3-C12-VPOA.holdRules (4)）。
function nextOf(candidate: BriefingCandidate, existing: BriefingCurrent | null, values: readonly BriefingCurrent[], now: number): BriefingCurrent {
  // P3-EF-AC09 (1): 訂正で記録雨から系列の記録を引き継いだ印。系列の報（全体で当たらない報）の上書きと取消で外れる。
  const inherited = !candidate.cancelled && candidate.headType === "VPBS50" && candidate.series !== candidate.eventId && allRecordRain(candidate.items);
  const base: Base = { subject: candidate.subject, operation: candidate.operation, series: candidate.series, eventId: candidate.eventId,
    ...inherited ? { inherited: true } : {}, source: candidate.source };
  if (candidate.cancelled) return memoryOf(base, candidate.headType, "cancelled");
  const text: Text = { title: candidate.title, headline: candidate.headline, editorialOffice: candidate.editorialOffice,
    truncated: candidate.truncated, ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
  if (candidate.headType === "VPBS50") {
    const index = indexOf(values);
    // 置き換える前の版自身の発生は数えず、この報の発生は数える。
    const own = existing?.effective === "active" && existing.expiryPending !== true ? codesOf(existing.items, "linearRainObserved") : new Set<string>();
    const fresh = codesOf(candidate.items, "linearRainObserved");
    const items = withoutAreas(candidate.items, (code) => fresh.has(code)
      || (index.observed.get(`${candidate.operation}|${code}`) ?? 0) - (own.has(code) ? 1 : 0) > 0);
    return candidate.items.length !== 0 && items.length === 0 ? memoryOf(base, "VPBS50", "replaced")
      : activeOf(base, text, items, candidate.observations);
  }
  const counterpart = counterpartOf(values, candidate.operation, candidate.eventId)?.value ?? null;
  if (counterpart?.effective === "active" && visible(counterpart)) return recordRainOf(base, text, candidate.areas, "aliased");
  if (existing?.effective === "released") return recordRainOf(base, text, candidate.areas, "released");
  return heldOf(base, text, candidate.areas, existing?.effective === "held" ? existing.holdUntil : now + HOLD_MS);
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title、VPOA50 は末尾に「（対応電文未確認）」。本文は Headline、無ければ item ごとの
// 種別と区域、それも無ければ題。接頭辞・接尾辞は切る範囲の外に置き、本体だけを上限から引いた長さで切る（Q-NOTICE.payload、K5 の F15 の型）。
// 取消は取り消した記録の ReportDateTime（cancelledAt）を書き、「（対応電文未確認）」を付けない（P3-NL-AC10 (3)）。
function payloadOf(operation: Operation, headType: "VPBS50" | "VPOA50", level: Level, title: string, body: string,
  mark: "plain" | "correction" | "cancel", cancelledAt: string | null = null): BriefingNotificationPayload {
  if (mark === "cancel") {
    const text = cancelText(title, cancelledAt);
    return { domain: "weather", level, title: PREFIX[operation] + cut(text.title, NOTICE_BOUNDS.title - PREFIX[operation].length),
      body: cut(text.body, NOTICE_BOUNDS.body) };
  }
  const suffix = headType === "VPOA50" ? UNCONFIRMED : "";
  const titleHead = PREFIX[operation] + (mark === "correction" ? "[訂正] " : "");
  const bodyHead = mark === "correction" ? "訂正: " : "";
  return { domain: "weather", level, title: titleHead + cut(title, NOTICE_BOUNDS.title - titleHead.length - suffix.length) + suffix,
    body: bodyHead + cut(body, NOTICE_BOUNDS.body - bodyHead.length - suffix.length) + suffix };
}
function bodyOf(value: Visible): string {
  if (value.headline !== "") return value.headline;
  const summary = value.headType === "VPBS50" ? value.items.map((item) => [item.condition ?? "種別不明", item.areas.map((area) => area.name).join("・")]
    .filter((part) => part !== "").join(" ")).join(" / ") : "";
  return summary !== "" ? summary : value.title;
}
// P3-NL-AC01: ID は世代番号を含まない。系列の印に同じ版の鍵と種類があれば作らない。
function intentsFor(source: Readonly<{ subject: string; operation: Operation; source: ReportRef }>, transition: BriefingIntent["transition"],
  payload: BriefingNotificationPayload, now: number, mark: NoticeMark | undefined, version: string): BriefingIntent[] {
  if (noticed(mark, version, noticeKind(transition))) return [];
  // P3-C12-TRAINING=A: training/test は desktop だけ。
  const channels = source.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: noticeId("U-B", source.subject, "", source.source, transition, channel), unit: "U-B",
    subject: source.subject, operation: source.operation, source: source.source, transition, channel, payload, createdAt: now,
    expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending",
    ...freshState("U-B", source.operation) }));
}
// P3-NL-AC02 (3): admit を通った intent の版と種類を、その系列の記録の印に足す（全 channel が断られた版は入れない）。
function markAdmitted(currents: readonly BriefingCurrent[], admitted: readonly BriefingIntent[]): readonly BriefingCurrent[] {
  if (admitted.length === 0) return currents;
  const marks = new Map(admitted.map((item) => [item.subject, item]));
  return currents.map((item) => {
    const intent = marks.get(item.subject);
    return intent == null ? item : { ...item, notice: markNotice(item.notice, versionDigest(intent.source), noticeKind(intent.transition)) };
  });
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-B の intent は全部 other の群（P3-C12-NOTICE-GROUP=A）。
function a7Order(left: BriefingIntent, right: BriefingIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// Q-NOTICE.capacity と P3-C12-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、withdrawn の subject（取消・alias・
// 置換で replaced・遅着の撤回）は全 pending を置き換える。
function admit(current: readonly BriefingIntent[], fresh: readonly BriefingIntent[], withdrawn: ReadonlySet<string>, replacing: readonly BriefingIntent[] = fresh):
  Readonly<{ intents: readonly BriefingIntent[]; admitted: readonly BriefingIntent[]; dropped: number }> {
  const superseded = new Set<BriefingIntent>();
  const replaced = new Set(replacing.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (withdrawn.has(item.subject) || replaced.has(`${item.subject}\n${item.channel}`)) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => !superseded.has(item)), ...fresh];
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
  // 新しい intent が容量で外れただけなら、既存の intent は変わらないので元の配列を返す（C9 の Q-C9-IMPL-AMEND(9)(e)）。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  // P3-NL-AC05 (1)(2): 置換・退去した intent は外す（結果は系列の印に残り、終端記録の予算と回収は無い）。
  const intents = [...current.filter((item) => !superseded.has(item) && !out.has(item)), ...admitted];
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
  return { unit: "U-B", operation: value.operation, subject: value.subject, office: null, current: visible(value) ? shown(value) : null,
    subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C12-PARAMETERS.adoptionOutcome の順。一入力の変更は一回の参照交換で確定する、spec:616） ----

function receiveCandidate(state: BriefingUnitState, candidate: BriefingCandidate, clock: ClockReading, basis: WallBasis): Result {
  const now = clock.wallTimeMs, recovering = candidate.source.origin === "recovery";
  const { subject, operation } = candidate;
  const found = recordAt(state.currents, subject);
  const existing = found?.value ?? null;
  let next = nextOf(candidate, existing, state.currents, now);
  const unchanged = (reason: "duplicate" | "stale" | "noChange", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason }], diagnostics } });
  const version = judge(existing, next, candidate);
  const warn = (missing: boolean): DiagnosticDetails => ({ level: "WARN", component: "briefing", inputId: candidate.source.inputId, unit: "U-B",
    reason: missing ? "requiredStructureMissing" : "briefingRevisionConflict" });
  // 取消以前の版は stale で、取消した subject を戻さない。同じ版で中身が同じなら duplicate、違えば先着を保って印を付ける（P3-VM-AC04）。
  if (version.kind !== "adopt") {
    if (version.kind !== "held") return unchanged(version.kind === "duplicate" ? "duplicate" : "stale");
    // P3-REC-AC12（C16 発注 4b-1）: 取り直しの版の決まらない本文は印も WARN も置かずに noChange（owner が held と読む、P3-REC-AC05 の (a)）。
    if (recovering) return unchanged("noChange");
    const marked = found == null || version.mark == null || found.value.unconfirmed === version.mark ? state : { ...state,
      currents: state.currents.map((item, at) => at === found.at ? { ...item, unconfirmed: version.mark! } : item), persistence: dirty(state.persistence, clock.monotonicMs) };
    return { changes: [], step: { ...idle(marked), decisions: [{ subject, operation, decision: "unchanged", reason: "stale" }], diagnostics: [warn(version.missing)] } };
  }
  if (version.mark != null) next = { ...next, unconfirmed: version.mark };
  // P3-NL-AC02 (2)(4): 通知の印は記録へ引き継ぐ。
  if (existing?.notice != null) next = { ...next, notice: existing.notice };
  const withdrawn = new Set<string>();
  const vanished = (diagnostics: readonly DiagnosticDetails[], kept: BriefingUnitState, changes: readonly Change[], change: "semantic" | "revisionOnly"): Result =>
    ({ changes, step: { ...idle(kept), decisions: [{ subject, operation, decision: "changed", reason: null, change, currentEstablished: null }],
      outcomes: [{ kind: "accepted", change, subjects: [] }], diagnostics } });
  // P3-C12-TTL.lateRule（版の比較の後）: 受理の時点で自分の記録の retainUntil を過ぎた報は state を変えない。前の見える記録より新しい
  // 版なら採用し、前の記録の pending を撤回する（P3-C12-LATE-INVERSION=A、他の subject へ作用しない）。採った報の記録は期限切れの形にし
  // （P3-EF-AC05 (5)）、見えない記録の回収は verified のときだけ。鳴らさない。
  if (next.retainUntil <= now) {
    if (found == null || !visible(found.value)) return unchanged("stale");
    withdrawn.add(subject);
    const notices = admit(state.intents, [], withdrawn);
    const late = visible(next) ? lapsed(next, basis) : next;
    const kept = basis === "verified" && late.retainUntil <= now ? null : late;
    const result = { ...state, currents: kept == null ? state.currents.filter((_, at) => at !== found.at)
      : state.currents.map((item, at) => at === found.at ? kept : item), intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) };
    return vanished([], result, [[found.value, kept]], "semantic");
  }

  // P3-C12-CAPACITY=A・P3-C12-EVICT-OPERATION: 退去は入力の前の配列から 1 件を決め、作用は残った記録に当てる。
  let values = state.currents;
  let evicted: BriefingCurrent | null = null;
  const evictedDiagnostic: DiagnosticDetails = { level: "INFO", component: "briefing", reason: "briefingCapacityEvicted", unit: "U-B", count: 1 };
  if (found == null && values.length >= CURRENT_LIMIT) {
    evicted = evictOne(values, now, operation, basis === "verified");
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
  // P3-UM-AC04: 通知の判定の比べ。compare・compareKeys は自分の記録の印に書く。
  const compared = noticeChange(existing, next);
  next = compared.after;

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
    const alias = aliasOf(values, operation, candidate.eventId);
    if (alias != null && (alias.value.effective === "held" || alias.value.effective === "released" && visible(alias.value))) {
      edits.set(alias.at, recordRainOf(baseOf(alias.value), textOf(alias.value), alias.value.areas, "aliased"));
      withdrawn.add(alias.value.subject);
    }
  }
  if (candidate.cancelled && candidate.headType === "VPBS50") {
    // 対応報の取消で aliased の VPOA50 を無音で released にし、retainUntil を 2 時間へ付け替える。過ぎていれば除かず期限切れの形にする
    // （P3-EF-AC09 (2) の例外、AC05 (5)。記憶の期限も過ぎていれば verified で回収する）。
    const alias = aliasOf(values, operation, candidate.eventId);
    if (alias?.value.effective === "aliased") {
      const released = recordRainOf(baseOf(alias.value), textOf(alias.value), alias.value.areas, "released");
      const late = released.retainUntil <= now && visible(released) ? lapsed(released, basis) : released;
      edits.set(alias.at, basis === "verified" && late.retainUntil <= now ? null : late);
    }
  }
  if (own != null) edits.set(own, next);
  const currents = [...values.flatMap((item, at) => {
    const value = edits.get(at);
    return value === undefined ? [item] : value == null ? [] : [value];
  }), ...own == null ? [next] : []];

  // Q-NOTICE.generationTable（自分の subject だけ、一 channel 1 件）。訂正は事実が同じでも作る。
  const correction = candidate.infoRank === 2;
  // P3-NL-AC09 (1): 取消は active だったか、系列の印に通知の証拠があるとき（H19）。
  const payload = candidate.cancelled ? existing != null && (visible(existing) || heard(existing.notice))
    ? payloadOf(operation, candidate.headType, "cancel", candidate.title, "", "cancel", existing.source.reportDateTimeRaw) : null
    : visible(next) && (correction || !visible(existing) || compared.changed)
      ? payloadOf(operation, candidate.headType, "warning", next.title, bodyOf(next), correction ? "correction" : "plain") : null;
  const transition = candidate.cancelled ? "cancelled" as const : correction || visible(existing) ? "updated" as const : "activated" as const;
  // 版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const fresh = payload == null ? [] : intentsFor(candidate, transition, payload, now, existing?.notice, versionDigest(candidate.source));
  // 取り直しは intent を作らず、live の新しい intent が置き換える古い pending だけを外す（P3-REC-D-UNIT-ENTRANCE=A）。
  const notices = admit(state.intents, recovering ? [] : fresh, withdrawn, fresh);
  const marked = markAdmitted(currents, notices.admitted);
  // P3-UM-AC03 (3): 原文の合計が予算を越えたら古い記録の原文から外す（印は残る）。外した記録の view も変わるので表示の変化に足す。
  const fit = fitRawBudget(rawTotal(marked), RAW_BUDGET, () => marked, rawKey);
  const after = new Map<BriefingCurrent, BriefingCurrent>();
  const settled = fit == null ? marked : stripAll(marked, fit, (item, stripped) => { after.set(item, stripped); });
  const result: BriefingUnitState = { ...state, currents: settled, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) };

  // change は最終の表示の変化で決める（I-U-B.currentSemantics(6)）。accepted は触れた subject のうち最終の状態に記録が残るもの。
  // 自分の記録は印を足した後の state の記録（表示の変化の after を state に揃える）。
  const ownAfter = settled === currents ? next : settled[indexOf(settled).subjects.get(subject) ?? -1] ?? next;
  const settle = (value: BriefingCurrent | null) => value == null ? null : after.get(value) ?? value;
  const touched: Change[] = [[existing, ownAfter], ...[...edits].filter(([at]) => at !== own).map(([at, value]): Change => [values[at], settle(value)])];
  const editedValues = new Set(edits.values());
  const stripped: Change[] = [...after].filter(([item]) => item.subject !== subject && !editedValues.has(item));
  const shownChange = ([before, value]: Change) => visible(before) !== visible(value) || visible(before) && changed(before, value).length !== 0;
  const change = evicted != null || touched.some(shownChange) ? "semantic" as const : "revisionOnly" as const;
  const decision: Decision = { subject, operation, decision: "changed", reason: null, change,
    currentEstablished: { family: candidate.headType, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } };
  const diagnostics: DiagnosticDetails[] = version.missing ? [warn(true)] : [];
  if (evicted != null) diagnostics.push(evictedDiagnostic);
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "notificationCapacityEvicted", unit: "U-B",
    count: notices.dropped });
  const dropped = droppedIn(fit, settled);
  if (dropped !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "unreadableDropped", unit: "U-B", count: dropped });
  return {
    changes: [...evicted == null ? [] : [[evicted, null] as const], ...touched, ...stripped],
    step: { state: result, nextDeadline: nextDeadline(result), decisions: [decision], intents: notices.admitted,
      outcomes: [{ kind: "accepted", change, subjects: touched.flatMap(([before, value]) => value == null ? [] : [outcomeOf(value, changed(before, value))]) }],
      diagnostics },
  };
}

// 受けた報の読めなかった所の WARN を先に置く（P3-EF-AC13 (2)）。
function warned(result: Result, diagnostics: readonly DiagnosticDetails[]): Result {
  return diagnostics.length === 0 ? result : { ...result, step: { ...result.step, diagnostics: [...diagnostics, ...result.step.diagnostics] } };
}
function receive(state: BriefingUnitState, input: Extract<BriefingInput, { kind: "receive" }>): Result {
  const parsed = parseBriefing(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // P3-REC-AC12（C16 発注 4b-1）・P3-C12-N2: origin=recovery は候補の作成のときだけ owner から届く。意味を当てて intent を作らない（H27 は無し、
  // P3-REC-D-N2-RAISE-4B=A）。
  return warned(receiveCandidate(state, retarget(candidate, state.currents), input.clock, input.basis ?? "verified"), parsed.diagnostics);
}

// P3-EF-AC09 (1): 訂正で情報タグの組が替わっても記録を動かさない（無いと元の記録が残って 2 枚になる）。系列の報は、同じ運用区分に同じ
// EventID の全体を subject とする記録があればそれを引き継ぐ。EventID の全体で当たる報（全部記録雨・取消）は、全体の記録が無く、「_」より前の
// 系列の記録の EventID の全体が一致すればそれを引き継ぐ（時刻は比べない）。取消が系列の記録に当たるのは、訂正で引き継いだ印のある記録だけ
// （「_」のある取消は記録雨の記録が無ければ記録の無い取消、H19）。
function retarget(candidate: BriefingCandidate, values: readonly BriefingCurrent[]): BriefingCandidate {
  if (candidate.headType !== "VPBS50") return candidate;
  const whole = `${candidate.operation}/VPBS50/${candidate.eventId}`;
  if (candidate.series !== candidate.eventId) return recordAt(values, whole) == null ? candidate
    : { ...candidate, series: candidate.eventId, subject: whole, source: { ...candidate.source, subject: whole } };
  const found = recordAt(values, whole) == null ? reportAt(values, candidate.operation, candidate.eventId) : null;
  return found == null || found.value.subject === whole || candidate.cancelled && !(found.value.headType === "VPBS50" && found.value.inherited === true)
    ? candidate
    : { ...candidate, series: found.value.series, subject: found.value.subject, source: { ...candidate.source, subject: found.value.subject } };
}

// ---- 期限（I-U-B.deadlines。到来分だけを回収・移行する） ----

// holdUntil の到来で held を released にし（P3-C12-VPOA=A）、表示の期限の来た見える記録と、記録の回収は時計の根拠ごとに当てる（P3-EF-AC02:
// awaiting は何も当てない、unverified は保留の印だけ、verified は記憶への移行〔保留の記録は時計によらず〕と retainUntil・intent の回収）。
// 解放の通知は期限処理の時刻が holdUntil+60 秒より前で、見える記録になるときだけ（holdRules (2)）。restore・終了入力（silent）は held を
// 全部無音で released にする（holdRules (3)(5)。期限ではないので根拠によらない）。
// ponytail: 256 subject の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: BriefingUnitState, clock: ClockReading, basis: WallBasis, silent: boolean): Readonly<{ state: BriefingUnitState;
  changes: readonly Change[]; expiredIntents: number; intents: readonly BriefingIntent[]; dropped: number }> {
  const now = clock.wallTimeMs, verified = basis === "verified", applies = basis !== "awaiting";
  const held = silent && holdMin(state.currents) !== Infinity;
  const touches = held || applies && (displayMin(state.currents) <= now || holdMin(state.currents) <= now)
    || verified && (recallMin(state.currents) <= now || pendingMin(state.currents) !== Infinity);
  if (!touches && !(verified && intentMin(state.intents) <= now)) return { state, changes: [], expiredIntents: 0, intents: [], dropped: 0 };
  const changes: Change[] = [];
  const released: BriefingIntent[] = [];
  const currents = !touches ? state.currents : state.currents.flatMap((item) => {
    if (verified && !shownKind(item) && item.retainUntil <= now) { changes.push([item, null]); return []; }
    let value: BriefingCurrent = item;
    if (item.effective === "held" && (silent || applies && item.holdUntil <= now)) value = recordRainOf(baseOf(item), textOf(item), item.areas, "released");
    if (applies && shownKind(value) && (value.expiryPending === true || value.retainUntil <= now)) value = lapsed(value, basis);
    const kept = verified && value.effective === "expired" && value.retainUntil <= now ? null : value;
    if (kept === item) return [item];
    changes.push([item, kept]);
    if (item.effective === "held" && kept != null && !silent && now < item.holdUntil + HOLD_MS && visible(kept))
      released.push(...intentsFor(kept, "activated", payloadOf(kept.operation, "VPOA50", "warning", kept.title, bodyOf(kept), "plain"),
        now, kept.notice, versionDigest(kept.source)));
    return kept == null ? [] : [kept];
  });
  const remaining = !verified || intentMin(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - remaining.length;
  // 取り直しで拾った VPOA50（source が origin=recovery）の解放は鳴らさない。候補の shadow でも採用の後の live でも、本文の間や採用までの時間に
  // よらず解放は起こりうる（P3-REC-D-UNIT-ENTRANCE=A）。置き換える古い pending は live と同じに外す。
  const notices = admit(remaining, released.filter((item) => item.source.origin !== "recovery"), new Set(), released);
  const persisted = changes.length !== 0 || notices.intents !== state.intents;
  // 解放の通知の印は released の記録へ足し、表示の変化の after もその記録に揃える。
  const marked = markAdmitted(changes.length === 0 ? state.currents : currents, notices.admitted);
  const settled = notices.admitted.length === 0 ? changes : changes.map(([before, value]): Change =>
    [before, value == null ? value : marked[indexOf(marked).subjects.get(value.subject) ?? -1] ?? value]);
  return { state: persisted ? { ...state, currents: marked, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) } : state, changes: settled, expiredIntents, intents: notices.admitted, dropped: notices.dropped };
}

function deadlineStep(state: BriefingUnitState, clock: ClockReading, basis: WallBasis, shutdown: boolean): Result {
  const applied = collect(state, clock, basis, shutdown);
  const diagnostics: DiagnosticDetails[] = [];
  if (applied.expiredIntents !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "notificationExpired", unit: "U-B",
    count: applied.expiredIntents });
  if (applied.dropped !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "notificationCapacityEvicted", unit: "U-B",
    count: applied.dropped });
  return { changes: applied.changes, step: { ...idle(applied.state), intents: applied.intents,
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] : [], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

// P3-NL-AC02 (3)・AC08 (1): intent の系列の印の証拠を上げる（下げない）。
function raiseNotices(state: BriefingUnitState, raised: ReadonlyMap<string, NoticeEvidence>): BriefingUnitState {
  if (raised.size === 0) return state;
  let touched = false;
  const currents = state.currents.map((item) => {
    const evidence = raised.get(item.subject);
    const notice = evidence == null || item.notice == null ? item.notice : raiseEvidence(item.notice, evidence);
    if (notice === item.notice) return item;
    touched = true;
    return { ...item, notice };
  });
  return touched ? { ...state, currents } : state;
}

function intentUpdate(state: BriefingUnitState, input: Extract<BriefingInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, BriefingIntent>();
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
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7〜C11 の先例）。pending でなくなった intent は外す（P3-NL-AC05 (1)）。
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

// Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。先に retainUntil を過ぎた記録を除き、残る held を
// 無音で released にする（相関待ちを再開しない、P3-C12-AC16）。どちらかが起きれば保存世代を進める。
function restore(state: BriefingUnitState, persisted: PersistedBriefingUnit, clock: ClockReading, basis: WallBasis): Result {
  const decoded = briefingUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "briefing",
    reason: "requiredStructureInvalid", unit: "U-B" }] } };
  // P3-NL-AC08 (1): started のまま残った pending は通知したか不明として外し、系列の印の証拠を unknown にする。
  const restored = restoreStarted(decoded.state.intents);
  const base = { ...raiseNotices(decoded.state, new Map(restored.started.map((item) => [item.subject, "unknown" as const]))),
    intents: restored.intents, persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const applied = collect(base, clock, basis, true);
  const active = applied.state.currents.filter(visible);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "briefing",
    reason: "notificationExpired", unit: "U-B", count: applied.expiredIntents }];
  if (restored.started.length !== 0) diagnostics.push({ level: "INFO", component: "briefing", reason: "notificationOutcomeUnknown",
    unit: "U-B", count: restored.started.length });
  return { changes: active.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-B"], coverage: active.map((item) => item.subject), subjects: [] }], diagnostics } };
}

function reduceCore(state: BriefingUnitState, input: BriefingInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock, input.basis ?? "verified");
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, input.basis ?? "verified", false);
    case "shutdown": return deadlineStep(state, input.clock, input.basis ?? "verified", true);
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
  contentRevision: String(state.contentRevision), subjects, currents: currents.map((item) => shown(item)) };
}

// ---- codec（I-U-B.persisted・I-U-B.decode、唯一の BriefingUnitCodec。受理と同じ上限を確かめる） ----

type Fields = Readonly<Record<string, unknown>>;
const boundedName = (value: unknown, limit: number): value is string => bounded(value, limit) && validName(value);
// I-U-B.subjects の形（`${operation}/${headType}/${series}`、Q-ENUM.identity の文字と長さ）。
function subjectParts(subject: string): Readonly<{ operation: Operation; headType: "VPBS50" | "VPOA50"; series: string }> | null {
  const match = /^(normal|training|test)\/(VPBS50|VPOA50)\/([\s\S]*)$/.exec(subject);
  const operation = operationOf(match?.[1]);
  const headType = match?.[2] === "VPBS50" || match?.[2] === "VPOA50" ? match[2] : null;
  return match == null || operation == null || headType == null || !validSeries(match[3]) ? null : { operation, headType, series: match[3] };
}
function reportRef(value: unknown, subject: string): ReportRef | null {
  const ref = readReportRef(value);
  const parts = subjectParts(subject);
  return ref == null || parts == null || ref.family !== parts.headType || ref.subject !== subject || parts.operation !== ref.operation
    // 読めなかった Serial は空で保存する（P3-EF-AC13 (5)、Q-EF-PRECHECK-2 (a)）。
    || !validReportDateTime(ref.reportDateTimeRaw) || ref.serialRaw !== "" && !validSerial(ref.serialRaw)
    || infoRankOf(ref.infoTypeRaw) == null ? null : ref;
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
// P3-UM-AC01 (2)（BriefingUnreadableSite）。
const UNREADABLE_SITES: ReadonlySet<string> = new Set(["serial", "editorialOffice", "condition", "observation"] satisfies readonly BriefingUnreadableSite[]);
// P3-UM-AC04 (2): compareKeys を持てる一覧の欄の site。
const LIST_SITES: ReadonlySet<string> = new Set(["observation"] satisfies readonly BriefingUnreadableSite[]);
function textRecord(row: Fields): Text | null {
  const unreadable = "unreadable" in row ? readUnreadableMark(row.unreadable, UNREADABLE_SITES, LIST_SITES) : undefined;
  return unreadable === null || typeof row.truncated !== "boolean" || !boundedName(row.title, BOUNDS.title) || !bounded(row.headline, BOUNDS.headline)
    // 読めなかった官署は空で受ける（P3-EF-AC13）。
    || !validHeadline(row.headline) || !bounded(row.editorialOffice, BOUNDS.office) || row.editorialOffice !== "" && !validName(row.editorialOffice) ? null
    : { title: row.title, headline: row.headline, editorialOffice: row.editorialOffice, truncated: row.truncated, ...unreadable == null ? {} : { unreadable } };
}
// 枝ごとに持ってよい事実の field（types.ts の判別共用体）。ほかの枝の field を持つ保存物は拒む。
// 保留の印は表示の期限を持つ見える記録（VPBS50 の active と VPOA50 の released）にだけ置ける（P3-EF-AC14 (20)）。
const FACT_KEYS = ["title", "headline", "editorialOffice", "truncated", "unreadable", "items", "observations", "areas", "holdUntil", "expiryPending"] as const;
const BRANCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  "VPBS50/active": ["title", "headline", "editorialOffice", "truncated", "unreadable", "items", "observations", "expiryPending"],
  "VPOA50/held": ["title", "headline", "editorialOffice", "truncated", "unreadable", "areas", "holdUntil"],
  "VPOA50/released": ["title", "headline", "editorialOffice", "truncated", "unreadable", "areas", "expiryPending"],
  "VPOA50/aliased": ["title", "headline", "editorialOffice", "truncated", "unreadable", "areas"],
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
  // P3-VM-AC04: 印は同じ系列（subject・operation）の報（取消の後の時刻の無い報の印も残る）。
  const mark = "unconfirmed" in row ? reportRef(row.unconfirmed, row.subject) : undefined;
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (mark === null || notice === null || "expiryPending" in row && row.expiryPending !== true) return null;
  // VPBS50 の EventID の全体は受理と同じ文字と長さで、系列はその全体か「_」より前。VPOA50 は欄を持たない（系列が全体）。
  const eventId = parts.headType === "VPOA50" ? "eventId" in row ? null : parts.series
    : isText(row.eventId) && validEventId(row.eventId) && (row.eventId === parts.series || row.eventId.split("_")[0] === parts.series) ? row.eventId : null;
  // 引き継いだ印は VPBS50 の系列の subject（EventID の全体と違う系列）の記録だけが持て、値は true だけ。active なら全部記録雨。
  const inherited = !("inherited" in row) ? false : row.inherited === true && parts.headType === "VPBS50" && eventId !== parts.series
    && (row.effective !== "active" || allRecordRain(itemsRecord(row.items) ?? [])) ? true : null;
  if (eventId == null || inherited == null) return null;
  const base: Base = { subject: row.subject, operation, series: parts.series, eventId, ...inherited ? { inherited: true } : {}, source,
    ...mark == null ? {} : { unconfirmed: mark }, ...notice == null ? {} : { notice } };
  const text = textRecord(row);
  let built: BriefingCurrent | null = null;
  if (parts.headType === "VPBS50") {
    if (row.effective === "replaced" || row.effective === "cancelled") built = memoryOf(base, "VPBS50", row.effective);
    else if (row.effective === "expired") built = expiredOf(base, "VPBS50");
    else if (row.effective === "active") {
      const items = itemsRecord(row.items), observations = list(row.observations, observationRecord, LIMITS.observations);
      if (text != null && items != null && observations != null) built = activeOf(base, text, items, observations);
    }
  } else if (row.effective === "cancelled") built = memoryOf(base, "VPOA50", "cancelled");
  else if (row.effective === "expired") built = expiredOf(base, "VPOA50");
  else {
    const areas = list(row.areas, areaRecord, LIMITS.areas);
    if (text != null && areas != null) {
      if (row.effective === "held") built = finite(row.holdUntil) ? heldOf(base, text, areas, row.holdUntil) : null;
      else if (row.effective === "released" || row.effective === "aliased") built = recordRainOf(base, text, areas, row.effective);
    }
  }
  // retainUntil は source の ReportDateTime と枝・種別の等式（P3-C12-TTL=B。記憶は元報＋9 時間、P3-EF-AC14 (20)）。保留の印のある記録は印の無い同じ枝の等式。
  return built == null || row.retainUntil !== built.retainUntil ? null : row.expiryPending !== true ? built
    : shownKind(built) ? { ...built, expiryPending: true } : null;
}
const LEVEL_SET: readonly Level[] = ["warning", "critical", "cancel"];
function intentRecord(value: unknown): BriefingIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const source = isText(row?.subject) ? reportRef(row.source, row.subject) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-B", operation, level);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-B.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || fields == null || !isText(row.id) || row.unit !== "U-B" || !isText(row.subject) || source.operation !== operation
    || payload.domain !== "weather" || !isText(payload.title) || payload.title === "" || !isText(payload.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-B", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition: "pending", ...fields };
}
function persisted(value: unknown): PersistedBriefingUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord, CURRENT_LIMIT), intents = list(row.intents, intentRecord);
  if (currents == null || intents == null || new Set(currents.map((item) => item.subject)).size !== currents.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。保存する intent は pending だけ（P3-NL-AC05）。
  const pendingBytes = listBytes(intents) + intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedBriefingUnit = { schemaVersion: SCHEMA, currents, intents };
  // P3-UM-AC16 (3)(c)（AC03 (1) の数え方）。
  if (intents.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || generationBytes(result) > GENERATION_LIMIT
    || rawTotal(currents) > RAW_BUDGET) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const briefingUnitCodec: BriefingUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p3-briefing-unit-v1", "p3-briefing-unit-v2", "p3-briefing-unit-v3", "p3-briefing-unit-v4", "p3-briefing-unit-v5", "p3-briefing-unit-v6"], maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  // contentRevision・persistence は保存しない（I-U-B.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: `invalid ${SCHEMA} payload` }
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
  reclaimDeadlineBeforeReceive: true,
  recoveryChanges,
} satisfies UnitModule<"U-B">;

// P3-REC-AC07（投影の直し、Q-REC-PRECHECK-7 の N2）: 取り直しの採用の step の正味の表示の変化（採用の直前の live → 最終の state）。
// 両状態の記録を鍵の Map で突き合わせ、reduce の merged の loop と同じ述語・displaySubject・鍵で作る。同じ参照の記録は省く（O(N前＋N後)）。
function recoveryChanges(before: BriefingUnitState, after: BriefingUnitState): BriefingUnitStep["displayChanges"] {
  const old = new Map<string, BriefingCurrent>();
  for (const item of before.currents) old.set(item.subject, item);
  const changes: BriefingUnitStep["displayChanges"][number][] = [];
  const add = (was: BriefingCurrent | null, now: BriefingCurrent | null) => {
    const shownBefore = visible(was) ? was : null, shownAfter = visible(now) ? now : null;
    if (shownBefore === shownAfter) return;
    const value = (now ?? was)!;
    changes.push({ unit: "U-B", operation: value.operation, subject: value.subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  };
  for (const item of after.currents) { add(old.get(item.subject) ?? null, item); old.delete(item.subject); }
  for (const item of old.values()) add(item, null);
  return changes;
}

export { briefingUnit, briefingUnitCodec, recoveryChanges, reduceBriefingUnit, toBriefingView };
