import { isDeepStrictEqual } from "node:util";

import type { MaterialValue, Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, FailureMark, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, ReportRef,
  RuntimeDisplaySubject, RuntimeUnitDeadline, SubjectOutcome, SubjectUnavailable, UnreadableMark, WallBasis,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  PersistedTsunamiUnit, TsunamiAreaClass, TsunamiEstimation, TsunamiForecastArea, TsunamiForecastSubject, TsunamiHeight,
  TsunamiInput, TsunamiIntent, TsunamiNotificationPayload, TsunamiObservationFamily, TsunamiObservationSubject,
  TsunamiReportSeries, TsunamiStation, TsunamiTransitionRecord, TsunamiUnitCodec, TsunamiUnitState, TsunamiUnitStep,
  TsunamiUnitView, TsunamiUnkeyedArea, TsunamiUnreadableSite,
} from "../../../contracts/p3-tsunami-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { compareVersion, controlDateTimeOf, nextMark, readReportRef, stepVersion } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { AREA_RANK, INFO_RANK, KIND_CLASS, parseTsunami, sameStation } from "../../domains/tsunami/tsunami";
import type { ForecastCandidate, ObservationCandidate } from "../../domains/tsunami/tsunami";
import {
  FAILURE_MARKS_MAX_BYTES, readFailureMarks, readUnreadableNotices, extendUnreadableNotices, unreadableBody, unreadableNoticeDue, unreadableSource, withUnreadableNotice, applyIntentUpdate, cancelText, failureNoticeId, fragmentKey, freshState, heard, markNotice, noticeId, noticeKind, noticeMarkBytes, noticed, raiseEvidence,
  readIntentState, readNoticeMark, restoreStarted, shown, updateEvidence, versionDigest,
} from "../notice-mark";
import { PENDING_MARK_BYTES, cachedMin } from "../expiry";
import {
  RAW_BUDGET, droppedIn, fitRawBudget, fitScope, inheritMark, hasPart, rawTotal, readUnreadableMark, stripAll,
  unreadableMarkBytes,
} from "../unreadable";

// P3-TSUNAMI-UNIT-001（C5、I-U-T）: U-T の意味・通知・容量・codec・射影。

const SCHEMA = "p3-tsunami-unit-v9" as const;
// P3-C5-CAPACITY=A と P3-C5-RES-01・RET-01〜03。
const FORECAST_LIMIT = 512, OBSERVATION_LIMIT = 512, STATION_LIMIT = 1024;
// P3-NL-D-CAPACITY=A: 4 MiB に印（予報 512・観測 512×2 family、観測は fragment の鍵 16 件）と失敗の印（operation 3 つ）の最悪の分を足す。
// P3-EF-AC06 (3)・AC10 (5): 入力なしで起きる期限切れの保留の印の分（観測 512×2 family）も足す（4,698,345）。
// P3-UM-RES-09: 読めない所の印（予報 512・観測 512×2 family）・原文の予算・カードの分も足す。
const GENERATION_LIMIT = 4_194_304 + FORECAST_LIMIT * noticeMarkBytes("notice") + OBSERVATION_LIMIT * 2 * noticeMarkBytes("notice", true)
  + FAILURE_MARKS_MAX_BYTES + OBSERVATION_LIMIT * 2 * PENDING_MARK_BYTES
  + (FORECAST_LIMIT + OBSERVATION_LIMIT * 2) * unreadableMarkBytes("unreadable") + RAW_BUDGET + UNREADABLE_CARDS_MAX_BYTES;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C5-SEM-01（観測 24 時間）・SEM-02（非 active 7 日）・SEM-03/04（sound 60 秒・desktop 180 秒）。
const VALID_MS = 86_400_000, RETAIN_MS = 604_800_000;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const FAMILIES = ["VTSE51", "VTSE52"] as const;

type Subject = TsunamiForecastSubject | TsunamiObservationSubject;
type Level = TsunamiNotificationPayload["level"];
type InternalStep = Omit<TsunamiUnitStep, "displayChanges" | "confirmationEvidence">;
type Change = readonly [before: Subject | null, after: Subject | null]; type Marks = Pick<TsunamiUnitState, "failureMarks" | "unreadableNotices">;
// uncovered: この受信が印に結び付けられない取りこぼしを作った（unit/operation の未確認へ、P3-CC-AC02）。
type Result = Readonly<{ step: InternalStep; changes: readonly Change[]; uncovered?: boolean }>;

// I-U-T.computation: 値に結び付けた encode byte を加算する（受信 1 回で state 全体を直列化しない）。
const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
function listBytes(values: readonly object[]): number {
  return values.reduce((sum, item) => sum + bytes(item), 2 + Math.max(values.length - 1, 0));
}
// 配送の更新で pending が伸びうる分の予約（P3-INTENT-UPDATE-RESERVE-001）。無いと上限ちょうどの pending が更新で伸び、decode が拒否する。
function reserve(values: readonly TsunamiIntent[]): number {
  return values.reduce((sum, item) => item.disposition === "pending" ? sum + deliveryGrowth(item) : sum, 0);
}
// 観測 subject は station・推定ごとの加算（station 1 点の更新で 1024 点を直列化し直さない）。印の無い active の観測は、入力なしで付く
// 期限切れの保留の印の分を予約に含める（P3-EF-AC10 (5)。受理の fit と decode の上限の両方がこの和を使い、退去は予約ごと差し引く）。
function subjectBytes(value: Subject): number {
  if (!("stations" in value)) return bytes(value);
  let size = byteCache.get(value);
  if (size == null) {
    size = encoder.encode(JSON.stringify({ ...value, stations: [], estimations: [] })).byteLength - 4
      + listBytes(value.stations) + listBytes(value.estimations) + (visible(value) ? PENDING_MARK_BYTES : 0);
    byteCache.set(value, size);
  }
  return size;
}
function sumBytes(values: readonly Subject[]): number {
  return values.reduce((sum, item) => sum + subjectBytes(item), Math.max(values.length - 1, 0));
}
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-T", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, forecasts: [], observations: [], intents: [], failureMarks: [], unreadableNotices: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7)・P3-UM-AC11 (10): envelope の inputBoundary・losses・カードの最大（器からは引かない）
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F と同じ予約）。
function generationBytes(forecasts: readonly Subject[], observations: readonly Subject[], intents: readonly TsunamiIntent[],
  marks: Marks): number { // P3-UM-AC12 (4): 読めない報の印も failureMarks と同じ加算
  return emptyEnvelopeBytes + 62 + sumBytes(forecasts) + sumBytes(observations)
    + intents.reduce((sum, item) => sum + bytes(item) + deliveryGrowth(item), Math.max(intents.length - 1, 0))
    + [marks.failureMarks, marks.unreadableNotices].reduce((total, list) => total + list.reduce((sum: number, item: object) => sum + bytes(item), Math.max(list.length - 1, 0)), 0);
}

// nextDeadline の最小値は配列に結び付けて持つ（weather-timeseries-unit の先例）。
const deadlineCache = new WeakMap<readonly object[], number>();
function subjectDeadline(values: readonly Subject[]): number {
  let at = deadlineCache.get(values);
  if (at == null) {
    at = values.reduce((min, item) => Math.min(min,
      item.effective === "active" ? ("validUntil" in item ? item.validUntil ?? Infinity : Infinity) : item.retainUntil ?? Infinity), Infinity);
    deadlineCache.set(values, at);
  }
  return at;
}
// P3-EF-AC11 (2): 根拠で当てない種類を比べないよう、観測の表示の期限・回収の期限・保留の観測を別々に持つ（nextDeadline は上の全部の最小）。
const displayMin = cachedMin<TsunamiObservationSubject>((item) => visible(item) ? item.validUntil ?? Infinity : Infinity);
const recallMin = cachedMin<Subject>((item) => item.effective === "active" ? Infinity : item.retainUntil ?? Infinity);
const pendingMin = cachedMin<TsunamiObservationSubject>((item) => item.effective === "active" && item.expiryPending === true ? 0 : Infinity);
function intentDeadline(values: readonly TsunamiIntent[]): number {
  let at = deadlineCache.get(values);
  if (at == null) { at = values.reduce((min, item) => Math.min(min, item.expiresAt), Infinity); deadlineCache.set(values, at); }
  return at;
}
function deadlineAt(state: TsunamiUnitState): number {
  return Math.min(subjectDeadline(state.forecasts), subjectDeadline(state.observations), intentDeadline(state.intents),
    ...state.failureMarks.map((item) => item.until));
}
function nextDeadline(state: TsunamiUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: TsunamiUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}
// 期限切れの保留の印のある観測は見えない記録として扱う（P3-EF-AC06 (1)）。
function visible(value: Subject | null): boolean {
  return value != null && value.effective === "active" && !("stations" in value && value.expiryPending === true);
}
function classOf(area: TsunamiForecastArea | TsunamiUnkeyedArea): TsunamiAreaClass {
  return "areaClass" in area ? area.areaClass : KIND_CLASS.get(area.kindCode) ?? "unknown";
}
// 期限で情報の消えた系列は未確認の印を持たない（P3-VM-AC04 の (b) の (ii)）。読めない所の印も事実と一緒に外す（P3-UM-AC01 (6)）。
function expireObservation({ unconfirmed: _mark, expiryPending: _pending, unreadable: _unreadable, ...value }: TsunamiObservationSubject,
  now: number): TsunamiObservationSubject {
  return { ...value, effective: "expired", stations: [], estimations: [], validUntil: null,
    retainUntil: (value.validUntil ?? now) + RETAIN_MS };
}
// validUntil の来た観測の形（P3-EF-AC02・AC06 (1)）: verified は観測点を捨てて expired、unverified は保留の印、awaiting は active のまま。
function lapseObservation(value: TsunamiObservationSubject, now: number, basis: WallBasis): TsunamiObservationSubject {
  if (basis === "verified") return expireObservation(value, now);
  const active: TsunamiObservationSubject = { ...value, effective: "active", retainUntil: null };
  return basis === "awaiting" ? active : { ...active, expiryPending: true };
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const LEVELS = ["info", "normal", "warning", "critical"] as const;
const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// P2-A4 と同じ区分の注記行。
const LEAD: Readonly<Record<Operation, string>> = { normal: "",
  training: "訓練の電文です。通常運用の警報ではありません。\n", test: "試験の電文です。通常運用の警報ではありません。\n" };
const OBSERVATION_TITLE: Readonly<Record<TsunamiObservationFamily, string>> = {
  VTSE51: "津波観測に関する情報", VTSE52: "沖合の津波観測に関する情報" };

function maxLevel(left: Exclude<Level, "cancel">, right: Exclude<Level, "cancel">): Exclude<Level, "cancel"> {
  return LEVELS.indexOf(left) >= LEVELS.indexOf(right) ? left : right;
}
// P3-C5-NOTICE-LEVELS=A の変化の段階。注意報への発令・引上げ・区域拡大は警報の音（P3-NL-AC11 (1)、H09）。
function riseLevel(value: TsunamiAreaClass): Exclude<Level, "cancel"> {
  return value === "majorWarning" ? "critical" : value === "warning" || value === "unknown" || value === "advisory" ? "warning" : "info";
}
// P3-NL-AC11 (4): 置換・退去の群は intent の群（A7 と同じ欄）で比べる。
function groupRank(intent: TsunamiIntent): number {
  return intent.priorityGroup === "normalTsunamiEmergency" ? 1 : 2;
}
function payloadOf(operation: Operation, level: Level, title: string, body: string, correction: boolean): TsunamiNotificationPayload {
  return { domain: "tsunami", level, title: PREFIX[operation] + (correction ? `[訂正] ${title}` : title),
    body: LEAD[operation] + (correction ? `訂正: ${body}` : body) };
}
// P3-CC-D-PENDING=A・D-FAILNOTICE=A の文面の時刻（報の ReportDateTime を JST の HH:MM に）。
function jstClock(raw: string): string {
  return new Date(Date.parse(raw) + 32_400_000).toISOString().slice(11, 16);
}
const FAIL_BODY = "容量の上限のため、この報を処理できていません。";
// P3-NL-AC01: ID は世代番号を含まない。系列の印に同じ版の鍵と種類（観測は fragment の鍵も）があれば作らない。
// emergency は報が警報以上（未知の区分を含む）への発令・引上げ・区域拡大を含むか（P3-NL-AC11 (2)）。
function intentsFor(source: ReportRef, transition: TsunamiIntent["transition"], payload: TsunamiNotificationPayload,
  now: number, notice: Readonly<{ mark: NoticeMark | undefined; version: string; fragment?: string }>, emergency = false): TsunamiIntent[] {
  if (noticed(notice.mark, notice.version, noticeKind(transition), notice.fragment)) return [];
  // P3-C5-TRAINING=A: training/test は desktop だけ。
  const channels = source.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: noticeId("U-T", source.subject, "", source, transition, channel, notice.fragment), unit: "U-T",
    subject: source.subject, operation: source.operation, source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel],
    nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending", ...freshState("U-T", source.operation, emergency) }));
}

// P3-C5-REPLACEMENT=A と Q-NOTICE.capacity。置換は同じ subject・channel で同群以上の pending だけ、取消は subject の全 pending。lowered（区分の最大が直前の記録より下がった報の subject）は、新しい intent が容量で入るかによらず、その subject の緊急群の pending を外す（P3-C5-REPLACEMENT の ruling、作者の裁定 2026-10-29「保存待ちの古い音を残さない」。r1 の統合担当の決め）。
function admit(current: readonly TsunamiIntent[], fresh: readonly TsunamiIntent[], cancelSubject: string | null, sounding = false, lowered: string | null = null):
  Readonly<{ intents: readonly TsunamiIntent[]; admitted: readonly TsunamiIntent[]; dropped: number }> {
  const pending = current;
  const superseded = new Set(cancelSubject == null ? [] : pending.filter((item) => item.subject === cancelSubject));
  const evicted = new Set<TsunamiIntent>();
  const admitted: TsunamiIntent[] = [];
  let refused = 0; if (lowered != null) for (const item of pending) if (item.subject === lowered && groupRank(item) === 1) superseded.add(item); // 取り直しの候補の intent（origin=recovery）は足さずに置換だけを当てる（P3-REC-D-UNIT-ENTRANCE=A、live なら置き換える古い pending を外す）。採用の step の音（sounding）は足す
  for (const intent of fresh) { if (!sounding && intent.source.origin === "recovery") { for (const item of pending) if (item.subject === intent.subject && item.channel === intent.channel && groupRank(item) >= groupRank(intent)) superseded.add(item); continue; }
    const rank = groupRank(intent);
    const live = pending.filter((item) => !superseded.has(item) && !evicted.has(item));
    const replaced = live.filter((item) => item.subject === intent.subject && item.channel === intent.channel && groupRank(item) >= rank);
    const kept = live.filter((item) => !replaced.includes(item));
    const values = [...kept, ...admitted, intent];
    const out: TsunamiIntent[] = [];
    // 予約込みの byte は初回に数え、退去のたびに 1 件分を引く（受理 1 回を O(pending) に保つ、P3-IUR-RES-03）。
    let count = values.length, size = listBytes(values) + reserve(values);
    const fits = () => count <= PENDING_ITEMS && size <= PENDING_BYTES;
    if (!fits()) {
      // 下位群だけを A7 の選択順の逆（期限・生成時刻・ID の遅い順）で必要数だけ退去する。同群以上は退去しない。
      const lower = kept.filter((item) => groupRank(item) > rank).sort((left, right) => right.expiresAt - left.expiresAt
        || right.createdAt - left.createdAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
      for (const item of lower) {
        if (fits()) break;
        out.push(item);
        count--;
        size -= bytes(item) + 1 + deliveryGrowth(item);
      }
      // channel ごとに全採用か未採用。未採用なら既存の pending を保つ。
      if (!fits()) { refused++; continue; }
    }
    for (const item of replaced) superseded.add(item);
    for (const item of out) evicted.add(item);
    admitted.push(intent);
  }
  // P3-NL-AC05 (1): 置換・退去した intent は intents から外す（結果は系列の印に残る）。
  const intents = [...current.filter((item) => !superseded.has(item) && !evicted.has(item)), ...admitted];
  return { intents, admitted, dropped: evicted.size + refused };
}

// ---- 容量（P3-C5-CAPACITY=A） ----

// training/test の受理は normal の記録を active・非 active とも退去しない（D-OPERATION=A、P3-OPCAP-AC01）。
// 第 1 段は受けた入力の根拠が verified のときだけ。保留の観測は見えない記録の段に入る（P3-EF-AC03・AC06 (5)）。
function tier(value: Subject, now: number, incoming: Operation, verified: boolean): number | null {
  if (value.operation === "normal" && incoming !== "normal") return null;
  if (!visible(value)) return verified && value.retainUntil != null && value.retainUntil <= now ? 0 : 1;
  return value.operation === "normal" ? null : 2;
}
function oldest(left: Subject, right: Subject): number {
  const time = Date.parse(left.source.reportDateTimeRaw) - Date.parse(right.source.reportDateTimeRaw);
  if (time !== 0) return time;
  const a = [left.operation, left.subject, left.source.inputId], b = [right.operation, right.subject, right.source.inputId];
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

// 超過した上限ごとに、その超過を実際に減らす subject だけを (1) 期限切れの非 active (2) 最古の非 active (3) training/test の
// active の順に退去する。受ける報が training/test なら normal の subject は (1)(2) とも候補にしない（P3-OPCAP-AC01）。候補で収まらなければ
// null（capacityExceeded）。
// ponytail: 退去の順は超過の種類ごとに 1 回並べる。退去は稀で上限 512・1024 に限られる（AGENTS.md の稀な一括処理）。
function fit(forecasts: readonly TsunamiForecastSubject[], observations: readonly TsunamiObservationSubject[],
  intents: readonly TsunamiIntent[], marks: Marks, target: string, now: number, incoming: Operation, verified: boolean):
  Readonly<{ forecasts: readonly TsunamiForecastSubject[]; observations: readonly TsunamiObservationSubject[];
    evicted: readonly Subject[] }> | null {
  const obsCount = { VTSE51: 0, VTSE52: 0 }, stationCount = { VTSE51: 0, VTSE52: 0 };
  for (const item of observations) { obsCount[item.family]++; stationCount[item.family] += item.stations.length; }
  let forecastCount = forecasts.length;
  let size = generationBytes(forecasts, observations, intents, marks);
  if (forecastCount <= FORECAST_LIMIT && size <= GENERATION_LIMIT && FAMILIES.every((family) =>
    obsCount[family] <= OBSERVATION_LIMIT && stationCount[family] <= STATION_LIMIT)) return { forecasts, observations, evicted: [] };
  const evicted = new Set<Subject>();
  const remove = (item: Subject) => {
    if (evicted.has(item)) return;
    evicted.add(item);
    size -= subjectBytes(item) + 1;
    if ("stations" in item) { obsCount[item.family]--; stationCount[item.family] -= item.stations.length; return; }
    forecastCount--;
    // P3-C5-OBS-LIFETIME=A: VTSE41 の退去は同じ operation・EventID の forecastEnded の観測を同じ参照交換で消す。
    for (const value of observations) if (value.effective === "forecastEnded" && value.operation === item.operation
      && value.eventId === item.eventId && value.subject !== target) remove(value);
  };
  const run = (pool: readonly Subject[], over: () => boolean): boolean => {
    if (!over()) return true;
    const ranked = pool.flatMap((item) => {
      const rank = item.subject === target || evicted.has(item) ? null : tier(item, now, incoming, verified);
      return rank == null ? [] : [{ item, rank }];
    }).sort((left, right) => left.rank - right.rank || oldest(left.item, right.item));
    for (const { item } of ranked) { if (!over()) break; remove(item); }
    return !over();
  };
  const ok = run(forecasts, () => forecastCount > FORECAST_LIMIT)
    && FAMILIES.every((family) => run(observations.filter((item) => item.family === family), () => obsCount[family] > OBSERVATION_LIMIT))
    && FAMILIES.every((family) => run(observations.filter((item) => item.family === family && item.stations.length > 0),
      () => stationCount[family] > STATION_LIMIT))
    && run([...forecasts, ...observations], () => size > GENERATION_LIMIT);
  if (!ok) return null;
  return { forecasts: forecasts.filter((item) => !evicted.has(item)),
    observations: observations.filter((item) => !evicted.has(item)), evicted: [...evicted] };
}

// ---- outcome と view ----

function highest(value: Subject): TsunamiAreaClass | null {
  if ("stations" in value) return null;
  let best: TsunamiAreaClass | null = null;
  for (const area of [...value.areas, ...value.unkeyedAreas]) {
    const current = classOf(area);
    if (AREA_RANK[current] > 0 && (best == null || AREA_RANK[current] > AREA_RANK[best])) best = current;
  }
  return best;
}
const viewOutcomeCache = new WeakMap<Subject, SubjectOutcome>();
function subjectOutcome(value: Subject, extra: Readonly<Record<string, JsonValue>> | null = null,
  changedFields: readonly string[] = []): SubjectOutcome {
  const reusable = extra == null && changedFields.length === 0;
  const cached = reusable ? viewOutcomeCache.get(value) : undefined;
  if (cached != null) return cached;
  const facts: Record<string, JsonValue> = "stations" in value
    ? { family: value.family, eventId: value.eventId, effective: value.effective, stationCount: value.stations.length }
    : { family: "VTSE41", eventId: value.eventId, effective: value.effective };
  const result: SubjectOutcome = { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw,
    transition: value.effective, severity: highest(value), source: value.source, facts: { ...facts, ...extra }, changedFields };
  if (reusable) viewOutcomeCache.set(value, result);
  return result;
}
function displaySubject(value: Subject): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-T" }>> {
  return { unit: "U-T", operation: value.operation, subject: value.subject, office: null,
    current: shown(value), subjects: [subjectOutcome(value)] };
}

// ---- VTSE41（I-U-T.forecastSemantics、Q-ENUM.revisionOrder） ----

// P3-VM-AC03: 手元の版を残して系列に未確認の印を付ける（同じ時刻の食い違い・比べる時刻の欠け・同じ報の fragment の食い違い）。
// 印は保存の byte に入るので採用と同じ fit を通す。収まらなければ印を置かず unit/operation の未確認へ寄せる（P3-CC-AC02 と同じ）。
function hold(state: TsunamiUnitState, candidate: ForecastCandidate | ObservationCandidate, clock: ClockReading, basis: WallBasis, mark: ReportRef | null,
  missing: boolean): Result {
  const step: InternalStep = { ...idle(state), decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged",
    reason: "stale" }], diagnostics: [{ level: "WARN", component: "tsunami", reason: missing ? "requiredStructureMissing" : "tsunamiRevisionConflict",
    inputId: candidate.source.inputId, unit: "U-T" }] };
  const found = (candidate.kind === "forecast" ? state.forecasts : state.observations).find((item) => item.subject === candidate.subject);
  if (found == null || mark == null || found.unconfirmed === mark) return { changes: [], step };
  const marked = <T extends Subject>(values: readonly T[]): readonly T[] => values.map((item) => item === found ? { ...item, unconfirmed: mark } : item);
  const forecasts = candidate.kind === "forecast" ? marked(state.forecasts) : state.forecasts;
  const observations = candidate.kind === "observation" ? marked(state.observations) : state.observations;
  const fitted = fit(forecasts, observations, state.intents, state, candidate.subject, clock.wallTimeMs, candidate.operation,
    basis === "verified");
  if (fitted == null) return { changes: [], step, uncovered: true };
  const next: TsunamiUnitState = { ...state, forecasts: fitted.forecasts, observations: fitted.observations,
    persistence: dirty(state.persistence, clock.monotonicMs) };
  return { changes: fitted.evicted.map((item): Change => [item, null]), step: { ...step, state: next, nextDeadline: nextDeadline(next),
    diagnostics: [...step.diagnostics, ...fitted.evicted.length === 0 ? [] : [{ level: "INFO" as const, component: "tsunami",
      reason: "tsunamiCapacityEvicted" as const, unit: "U-T" as const, count: fitted.evicted.length }]] } };
}

function transitionOf(from: TsunamiAreaClass, to: TsunamiAreaClass, wasActive: boolean): TsunamiTransitionRecord["transition"] | null {
  const before = AREA_RANK[from], after = AREA_RANK[to];
  if (before === 0) return after === 0 ? null : wasActive ? "expanded" : "issued";
  if (after === 0) return "released";
  return after > before ? "upgraded" : after < before ? "downgraded" : null;
}

function forecastTitle(next: TsunamiForecastSubject, wasActive: boolean): string {
  // Q-NOTICE.payload: 直前が active の released は予報区域が残っていても解除。直前が active でない released は下の式で予報か解除。
  if (next.effective === "released" && wasActive) return "津波警報・注意報の解除";
  const areas = [...next.areas, ...next.unkeyedAreas];
  const named: readonly [TsunamiAreaClass, string][] = [["majorWarning", "大津波警報"], ["warning", "津波警報"]];
  for (const [value, name] of named) if (areas.some((area) => classOf(area) === value)) return name;
  const unknown = areas.find((area) => classOf(area) === "unknown");
  if (unknown != null) return unknown.kindName;
  return areas.some((area) => classOf(area) === "advisory") ? "津波注意報"
    : areas.some((area) => classOf(area) === "forecast") ? "津波予報" : "津波警報・注意報の解除";
}

// origin=recovery（C16 の候補の作成）は意味を当てるが intent を作らない（P3-REC-D-UNIT-ENTRANCE=A。引上げの音は採用の step の recoveryNotices）。
function receiveForecast(state: TsunamiUnitState, candidate: ForecastCandidate, clock: ClockReading, basis: WallBasis): Result {
  const recovering = candidate.source.origin === "recovery";
  const index = state.forecasts.findIndex((item) => item.subject === candidate.subject);
  const existing = index < 0 ? null : state.forecasts[index];
  const unchanged = (reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason }],
      diagnostics } });
  // P3-VM-AC03: compareVersion で比べ、InfoType の順位は使わない。同じ版で中身（InfoType を含む）が違えば先着を保って印を付ける。
  const version = stepVersion(existing == null ? null : { version: existing.source, source: existing.source, cancelled: existing.effective === "cancelled" },
    existing?.unconfirmed ?? null, candidate.source, () => existing != null && existing.source.infoTypeRaw.trim() === candidate.source.infoTypeRaw.trim()
      && (existing.effective === "cancelled" ? candidate.cancelled : !candidate.cancelled
        && isDeepStrictEqual(existing.areas, candidate.areas) && isDeepStrictEqual(existing.unkeyedAreas, candidate.unkeyedAreas)), candidate.cancelled);
  if (version.kind === "older" || version.kind === "duplicate") return unchanged(version.kind === "older" ? "stale" : "duplicate");
  // 取り直しの本文も通常の版の比べだけにかけ、決まらなければ採らない（印も置かず、K7 の印も外さない）。noChange の結果を owner が adopted
  // 以外（held）にし、その unit は確認されない（作者裁定 2026-10-28 午後: 一覧の順による強制の採用はしない）。
  if (version.kind === "held") return recovering ? { changes: [], step: { ...idle(state), decisions: [{ subject: candidate.subject,
    operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } } : hold(state, candidate, clock, basis, version.mark, version.missing);
  // P3-REC-AC08: 取り直しの報は元報の ReportDateTime を時刻にする（採用の時刻から数えると保持の期限が延びる）。
  const now = recovering ? Math.min(clock.wallTimeMs, candidate.reportDateTimeMs) : clock.wallTimeMs;
  const wasActive = existing?.effective === "active";
  // P3-NL-AC02 (2)(4): 印は系列の記録と同じに生きるので、作り直す記録へ引き継ぐ。版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const notice = { mark: existing?.notice, version: versionDigest(candidate.source) };
  const kept = existing?.notice == null ? {} : { notice: existing.notice };
  // P3-C5-TRANSITION-BASIS=A: 保存している区域との差。subject が無いか取消なら直前は全区域 none。
  const prior = existing == null || existing.effective === "cancelled" ? [] : existing.areas;
  const transitions: TsunamiTransitionRecord[] = [];
  let next: TsunamiForecastSubject;
  if (candidate.cancelled) {
    next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, source: candidate.source,
      effective: "cancelled", areas: [], unkeyedAreas: [],
      retainUntil: existing != null && !wasActive && existing.retainUntil != null ? existing.retainUntil : now + RETAIN_MS, ...kept };
  } else {
    const before = new Map(prior.map((area) => [area.code, area]));
    const codes = new Set(candidate.areas.map((area) => area.code));
    for (const area of candidate.areas) {
      const from = before.get(area.code)?.areaClass ?? "none";
      const transition = transitionOf(from, area.areaClass, wasActive);
      if (transition != null) transitions.push({ areaCode: area.code, from, to: area.areaClass, transition });
    }
    for (const area of prior) if (!codes.has(area.code)) {
      const transition = transitionOf(area.areaClass, "none", wasActive);
      if (transition != null) transitions.push({ areaCode: area.code, from: area.areaClass, to: "none", transition });
    }
    // unkeyedAreas は effective と残った区分の段階にだけ数える（P3-C5-KIND-ENUM=B）。
    const active = [...candidate.areas, ...candidate.unkeyedAreas].some((area) => AREA_RANK[classOf(area)] >= 2);
    next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, source: candidate.source,
      effective: active ? "active" : "released", areas: candidate.areas, unkeyedAreas: candidate.unkeyedAreas,
      retainUntil: active ? null : existing?.effective === "released" && existing.retainUntil != null ? existing.retainUntil : now + RETAIN_MS, ...kept,
      ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
  }
  // P3-CC-AC03(3)(4): 印は印の版以上の採用で消える。古い報の採用では active の記録へ引き継ぎ、active でなければ外して unit の未確認へ移す。
  const mark = existing?.unavailable;
  const keep = mark != null && compareVersion(mark.source, candidate.source) === "older";
  if (keep && next.effective === "active") next = { ...next, unavailable: mark };
  if (version.mark != null) next = { ...next, unconfirmed: version.mark };
  const lost = keep && next.effective !== "active";
  const raised = transitions.filter((item) => item.transition === "issued" || item.transition === "expanded" || item.transition === "upgraded");
  const lowered = transitions.some((item) => item.transition === "downgraded" || item.transition === "released");
  const series: TsunamiReportSeries = raised.length !== 0 ? lowered ? "mixed" : "escalation" : lowered ? "deescalation" : "none";

  // P3-C5-OBS-LIFETIME=A: 同じ採用の中で同じ operation・EventID の観測の生死を決める。
  const changes: Change[] = [];
  let observationsChanged = false;
  const observations = state.observations.map((item) => {
    // 保留の観測は予報の生死で形を変えない（見える状態に戻さない、P3-EF-AC06 (5)）。
    if (item.operation !== candidate.operation || item.eventId !== candidate.eventId || item.expiryPending === true) return item;
    let after = item;
    if (next.effective !== "active") {
      if ((item.effective === "active" || item.effective === "forecastEnded") && (item.effective !== "forecastEnded"
        || item.retainUntil !== next.retainUntil)) after = { ...item, effective: "forecastEnded", retainUntil: next.retainUntil };
    } else if (item.effective === "forecastEnded")
      after = item.validUntil != null && item.validUntil > now ? { ...item, effective: "active", retainUntil: null }
        : lapseObservation(item, now, basis);
    if (after !== item) { observationsChanged = true; changes.push([item, after]); }
    return after;
  });

  let fresh: TsunamiIntent[] = [];
  const raisedToWarning = raised.some((item) => AREA_RANK[item.to] >= AREA_RANK.warning);
  if (candidate.cancelled) {
    // P3-NL-AC09 (1): 取消の前に active だったか、系列の印に通知の証拠がある subject だけ通知する（H19）。文面は AC10。
    if (!recovering && existing != null && (wasActive || heard(existing.notice))) {
      const text = cancelText(candidate.title ?? "津波警報・注意報・予報", existing.source.reportDateTimeRaw);
      fresh = intentsFor(candidate.source, "cancelled", payloadOf(candidate.operation, "cancel", text.title, text.body, false), now, notice);
    }
  } else {
    const rising = new Set(raised.map((item) => item.areaCode));
    const change = raised.reduce<Exclude<Level, "cancel">>((level, item) => maxLevel(level, riseLevel(item.to)), "info");
    const remaining = next.effective === "active" ? "normal" : "info";
    const title = forecastTitle(next, wasActive);
    const entries = [...candidate.areas.map((area) => ({ name: area.name, kind: area.kindName, raised: rising.has(area.code) })),
      ...candidate.unkeyedAreas.map((area) => ({ name: area.name, kind: area.kindName, raised: false }))];
    // escalation では上がった区域を先に並べる（Q-NOTICE.payload）。
    const ordered = rising.size === 0 ? entries : [...entries.filter((item) => item.raised), ...entries.filter((item) => !item.raised)];
    const parts = [[...new Set(ordered.map((item) => item.kind))].join("・"), ordered.slice(0, 3).map((item) => item.name).join(", "),
      candidate.headline ?? ""].filter((part) => part !== "");
    const transition = !wasActive && next.effective === "active" ? "activated" : wasActive && next.effective !== "active" ? "released" : "updated";
    fresh = intentsFor(candidate.source, transition, payloadOf(candidate.operation, maxLevel(change, remaining), title,
      parts.length === 0 ? title : parts.join(" / "), candidate.infoRank === 2), now, notice, raisedToWarning);
  }
  changes.push([existing, next]);
  const forecasts = index < 0 ? [...state.forecasts, next] : state.forecasts.map((item, at) => at === index ? next : item);
  const semantic = existing == null || existing.effective !== next.effective || observationsChanged || existing.unavailable !== next.unavailable
    || !isDeepStrictEqual(existing.areas, next.areas) || !isDeepStrictEqual(existing.unkeyedAreas, next.unkeyedAreas);
  const result = adopt(state, candidate, clock, basis, { forecasts, observations, fresh, cancelSubject: candidate.cancelled ? candidate.subject : null,
    semantic, changes, target: next, facts: { areaTransitions: transitions, series }, missing: version.missing, notice,
    emergency: raisedToWarning && !recovering, lowered: !candidate.cancelled && existing != null && existing.effective !== "cancelled" && topRank(next) < topRank(existing) ? candidate.subject : null });
  // uncovered があるのは拒否の結果だけ（refuse）。採用できたときだけ、外した印を unit の未確認へ移す。
  return lost && result.uncovered == null ? { ...result, uncovered: true } : result;
}

// ---- VTSE51/52（P3-C5-OBS-MERGE=A、P3-C5-OBS-LIFETIME=A） ----

function sameRevision(left: TsunamiStation["revision"], right: TsunamiStation["revision"]): boolean {
  // P3-EF-AC13 (5): 同じ版の足し合わせは Serial が読めた報どうしだけ（Number("") は 0 で、空どうしが一致してしまう）。
  return Date.parse(left.reportDateTimeRaw) === Date.parse(right.reportDateTimeRaw) && left.serialRaw !== "" && right.serialRaw !== ""
    && Number(left.serialRaw) === Number(right.serialRaw)
    && left.infoTypeRaw.trim() === right.infoTypeRaw.trim();
}

function receiveObservation(state: TsunamiUnitState, candidate: ObservationCandidate, clock: ClockReading, basis: WallBasis): Result {
  const index = state.observations.findIndex((item) => item.subject === candidate.subject);
  const existing = index < 0 ? null : state.observations[index];
  const unchanged = (reason: "duplicate" | "stale", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason }],
      diagnostics } });
  // stationsを捨てた subject（取消・失効）と保留の観測は、より新しい revision から空の直前として始め直す（保留の観測へ同じ報の fragment を
  // 足して見える状態に戻さない、P3-EF-AC06 (5)）。
  const base = existing == null || existing.effective === "cancelled" || existing.effective === "expired" || existing.expiryPending === true
    ? null : existing;
  const emptyBase = base == null;
  // 受信 1 回につき既存の code → 要素の Map を 1 回作って引く（I-U-T.computation）。
  const stations = new Map((base?.stations ?? []).map((item) => [item.code, item]));
  // P3-VM-D-SAME-REPORT=A: Head/ReportDateTime・Serial・InfoType が同じ報は同じ報で fragment を合成する（Control/DateTime は見ない）。
  // 同じ報でなければ記録の比べる用の Control/DateTime で compareVersion にかける（InfoType の順位と Serial は使わない）。
  const equal = existing != null && sameRevision(existing.source, candidate.source);
  let mark = existing?.unconfirmed ?? null, missing = false;
  if (equal && emptyBase && !candidate.cancelled) return unchanged("stale");
  if (!equal) {
    const version = stepVersion(existing == null ? null : { version: { ...existing.source, controlDateTimeRaw: existing.controlDateTimeRaw },
      source: existing.source, cancelled: existing.effective === "cancelled" }, mark, candidate.source, () => candidate.cancelled
      ? existing?.effective === "cancelled" : existing?.source.infoTypeRaw.trim() === candidate.source.infoTypeRaw.trim() && base != null && candidate.stations.every((item) => { const old = stations.get(item.code); return old != null && sameStation(old, item); })
        && isDeepStrictEqual(base.estimations, candidate.estimations), candidate.cancelled);
    if (version.kind === "older" || version.kind === "duplicate") return unchanged(version.kind === "older" ? "stale" : "duplicate");
    if (version.kind === "held") return hold(state, candidate, clock, basis, version.mark, version.missing);
    ({ mark, missing } = version);
  }
  // 比べる用の Control/DateTime は採った同じ報の fragment の最大（着く順によらない、P3-VM-D-SAME-REPORT=A）。
  const control = equal && existing != null && !(Date.parse(candidate.source.controlDateTimeRaw) > Date.parse(existing.controlDateTimeRaw))
    && Number.isFinite(Date.parse(existing.controlDateTimeRaw)) ? existing.controlDateTimeRaw : candidate.source.controlDateTimeRaw;
  const now = clock.wallTimeMs;
  const wasActive = visible(existing);
  const forecast = state.forecasts.find((item) => item.operation === candidate.operation && item.eventId === candidate.eventId);
  // P3-NL-AC02 (2)(4)・AC03: 印は記録へ引き継ぐ。fragment の鍵は受けた fragment そのものの中身から作り、取消は持たない。
  // 観測点は sameStation と同じく revision を除いた形で鍵にする（P3-UM-AC04 (4)）。
  const kept = existing?.notice == null ? {} : { notice: existing.notice };
  const notice = { mark: existing?.notice, version: versionDigest(candidate.source), ...candidate.cancelled ? {}
    : { fragment: fragmentKey(candidate.stations.map((item) => [item.code, { ...item, revision: null }] as const),
      candidate.estimations.map((item) => [item.areaCode, item] as const)) } };
  // P3-UM-AC04 (4): Serial の読めない版の前後は、中身の鍵が前の版の印の鍵と同じなら通知しない（Serial だけ違う同じ中身の報）。
  // 前の版が見える観測（base）のときだけ（取消・失効の後に印の鍵が残っていても、新しく見える観測は鳴らす）。
  const repeated = base != null && (hasPart(candidate.unreadable ?? undefined, "serial") || hasPart(existing?.unreadable, "serial")) && notice.fragment != null
    && existing?.notice?.fragments?.includes(notice.fragment) === true;
  let next: TsunamiObservationSubject;
  let touched = existing == null || existing.effective !== "active" && existing.effective !== "forecastEnded", late = false;
  if (equal && existing?.effective === "cancelled") {
    // 同じ取消の別の部分は中身を変えない。比べる用の Control/DateTime だけが進みうる。
    if (control === existing.controlDateTimeRaw) return unchanged("duplicate");
    next = { ...existing, controlDateTimeRaw: control };
  } else if (candidate.cancelled) {
    next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, family: candidate.family,
      source: candidate.source, controlDateTimeRaw: control, effective: "cancelled", stations: [], estimations: [], validUntil: null,
      retainUntil: existing != null && existing.effective !== "active" && existing.retainUntil != null ? existing.retainUntil : now + RETAIN_MS, ...kept };
    touched = true;
  } else {
    // 同じ報の中で値が食い違う fragment は手元の値を残して印を付ける（H51、P3-VM-AC03）。
    const conflict = () => hold(state, candidate, clock, basis, nextMark(mark, candidate.source), false);
    for (const item of candidate.stations) {
      const old = stations.get(item.code);
      if (equal && old != null && sameRevision(old.revision, item.revision)) {
        if (!sameStation(old, item)) return conflict();
        continue;
      }
      if (old == null || !sameStation(old, item)) touched = true;
      stations.set(item.code, item);
    }
    let estimations: readonly TsunamiEstimation[];
    if (!equal || base == null) {
      estimations = candidate.estimations;
      if (base != null && !isDeepStrictEqual(base.estimations, estimations)) touched = true;
    } else {
      const merged = new Map(base.estimations.map((item) => [item.areaCode, item]));
      for (const item of candidate.estimations) {
        const old = merged.get(item.areaCode);
        if (old != null && isDeepStrictEqual(old, item)) continue;
        if (old != null) return conflict();
        touched = true;
        merged.set(item.areaCode, item);
      }
      estimations = [...merged.values()];
    }
    const validUntil = candidate.reportDateTimeMs + VALID_MS;
    const ended = forecast != null && forecast.effective !== "active";
    // 中身の同じか部分集合の同じ報の fragment は、比べる用の Control/DateTime だけを進めて通知しない（P3-VM-AC03）。
    if (equal && existing != null && !touched) {
      if (control === existing.controlDateTimeRaw) return unchanged("duplicate");
      next = { ...existing, controlDateTimeRaw: control };
    } else {
      const merged = [...stations.values()];
      next = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation, family: candidate.family,
        source: candidate.source, controlDateTimeRaw: control, effective: ended ? "forecastEnded" : "active", stations: merged,
        estimations, validUntil, retainUntil: ended ? forecast.retainUntil : null, ...mark == null ? {} : { unconfirmed: mark }, ...kept,
        ...observationUnreadable(base, merged, estimations, candidate.unreadable) };
      // 表示の期限を過ぎてから採る観測は期限切れの形にし、鳴らさない（P3-EF-AC05 (5) と同じ形）。
      late = !ended && validUntil <= now;
      if (late) next = lapseObservation(next, now, basis);
    }
  }
  const title = OBSERVATION_TITLE[candidate.family];
  // P3-C5-NOTICE-OBSERVATION=C: 観測は info。forecastEnded のままの採用では作らない（P3-C5-OBS-LIFETIME=A の例外）。
  const cancel = candidate.cancelled && existing != null && (wasActive || heard(existing.notice))
    ? cancelText(candidate.title ?? title, existing.source.reportDateTimeRaw) : null;
  const fresh = next.source !== candidate.source ? [] : candidate.cancelled
    ? cancel != null ? intentsFor(candidate.source, "cancelled", payloadOf(candidate.operation, "cancel", cancel.title, cancel.body, false),
      now, notice) : []
    : visible(next) && !late && !repeated ? intentsFor(candidate.source, wasActive ? "updated" : "activated", payloadOf(candidate.operation,
      "info", title, [candidate.stations.slice(0, 3).map((item) => item.name).join(", "), candidate.headline ?? ""]
        .filter((part) => part !== "").join(" / ") || title, candidate.infoRank === 2), now, notice) : [];
  const observations = index < 0 ? [...state.observations, next] : state.observations.map((item, at) => at === index ? next : item);
  return adopt(state, candidate, clock, basis, { forecasts: state.forecasts, observations, fresh,
    cancelSubject: candidate.cancelled && next.source === candidate.source ? candidate.subject : null,
    semantic: touched || existing?.effective !== next.effective, changes: [[existing, next]], target: next, facts: {}, missing, notice,
    emergency: false });
}

// P3-UM-AC01 (3)(6): 前の版から残した観測点・推定区域（同じ object のまま残った要素）の part は引き継ぎ、残した要素が 0 件の版は丸ごとの
// 置き換えで、この版の印だけにする（旗も外れる）。入力の code の有無では数えない（同じ報の fragment が前の観測点を含んでも、前の要素が残れば旗は残る）。
function observationUnreadable(base: TsunamiObservationSubject | null, stations: readonly TsunamiStation[], estimations: readonly TsunamiEstimation[],
  incoming: UnreadableMark | null): Readonly<{ unreadable?: UnreadableMark }> {
  const previous = base?.unreadable;
  // scope は code を fitScope で切った形なので、照合も同じ形で引く（r1 ヘルツ P3-3: 127 文字の code の印が消えた）。同じ fitScope の値の
  // 要素がこの版で更新・削除されたら、その scope は引き継がない（Q-UM-PRECHECK-2 (8)(f): 先頭が同じ別の code の交互の更新で古い欠片が残らない）。
  const keptStations = keptScopes(base?.stations ?? [], stations, (item) => item.code);
  const keptAreas = keptScopes(base?.estimations ?? [], estimations, (item) => item.areaCode);
  if (previous == null || keptStations.size + keptAreas.size === 0) return incoming == null ? {} : { unreadable: incoming };
  const inherited = previous.parts.filter((part) => part.scope != null
    && (part.site === "station" ? keptStations.has(part.scope) : part.site === "estimation" && keptAreas.has(part.scope)));
  const unreadable = inheritMark(previous, inherited, incoming);
  return unreadable == null ? {} : { unreadable };
}

function keptScopes<T>(before: readonly T[], after: readonly T[], code: (item: T) => string): Set<string> {
  const old = new Set(before), present = new Set(after), kept = new Set<string>(), touched = new Set<string>();
  for (const item of after) (old.has(item) ? kept : touched).add(fitScope(code(item)));
  for (const item of before) if (!present.has(item)) touched.add(fitScope(code(item)));
  for (const scope of touched) kept.delete(scope);
  return kept;
}

// 採用の共通部: 通知の収容、容量の退去、保存世代を一回の参照交換で確定する。
function adopt(state: TsunamiUnitState, candidate: ForecastCandidate | ObservationCandidate, clock: ClockReading, basis: WallBasis, proposal: Readonly<{
  forecasts: readonly TsunamiForecastSubject[]; observations: readonly TsunamiObservationSubject[]; fresh: readonly TsunamiIntent[];
  cancelSubject: string | null; semantic: boolean; changes: readonly Change[]; target: Subject; facts: Readonly<Record<string, JsonValue>>;
  missing: boolean; notice: Readonly<{ version: string; fragment?: string }>; emergency: boolean; lowered?: string | null;
}>): Result {
  const notices = admit(state.intents, proposal.fresh, proposal.cancelSubject, false, proposal.lowered ?? null);
  // P3-NL-AC02 (3): admit を通った版と種類を系列の印に足す（全 channel が断られた版は入れない）。
  let { forecasts, observations, changes } = proposal;
  if (notices.admitted.length !== 0) {
    const target = proposal.target, notice = markNotice(target.notice, proposal.notice.version,
      noticeKind(notices.admitted[0].transition), proposal.notice.fragment);
    if ("stations" in target) {
      const marked = { ...target, notice };
      observations = observations.map((item) => item === target ? marked : item);
      changes = changes.map(([before, after]): Change => [before, after === target ? marked : after]);
    } else {
      const marked = { ...target, notice };
      forecasts = forecasts.map((item) => item === target ? marked : item);
      changes = changes.map(([before, after]): Change => [before, after === target ? marked : after]);
    }
  }
  // P3-UM-AC03 (3): 原文の合計（予報と観測の和）が予算を越えたら古い記録の原文から外す（印は残る）。器の退去（fit）より先に当てる。
  const slices = { forecasts, observations };
  const raw = fitRawBudget<Subject>(rawTotal(slices.forecasts, slices.observations), RAW_BUDGET, () => [...slices.forecasts, ...slices.observations],
    (item) => [Date.parse(item.source.reportDateTimeRaw), item.subject]);
  if (raw != null) {
    const pairs: Change[] = [], push = (before: Subject, after: Subject) => { pairs.push([before, after]); };
    forecasts = stripAll(forecasts, raw, push);
    observations = stripAll(observations, raw, push);
    const touched = new Map(pairs);
    changes = [...changes.map(([before, after]): Change => [before, after == null ? after : touched.get(after) ?? after]),
      ...pairs.filter(([item]) => !changes.some(([, after]) => after === item))];
  }
  const fitted = fit(forecasts, observations, notices.intents, state, candidate.subject, clock.wallTimeMs, candidate.operation,
    basis === "verified");
  if (fitted == null) return refuse(state, candidate, clock, basis, proposal.fresh, proposal.emergency);
  const evidence = { family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" as const };
  const next: TsunamiUnitState = { ...state, forecasts: fitted.forecasts, observations: fitted.observations, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) };
  const change = proposal.semantic || fitted.evicted.length !== 0 ? "semantic" as const : "revisionOnly" as const;
  // P3-VM-D-MISSING=A の (2): 手元の版の無い比べる時刻を欠く報は採って WARN を添える。
  const diagnostics: DiagnosticDetails[] = proposal.missing ? [{ level: "WARN", component: "tsunami", reason: "requiredStructureMissing",
    inputId: candidate.source.inputId, unit: "U-T" }] : [];
  if (fitted.evicted.length !== 0) diagnostics.push({ level: "INFO", component: "tsunami", reason: "tsunamiCapacityEvicted",
    unit: "U-T", count: fitted.evicted.length });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "tsunami", reason: "notificationCapacityEvicted",
    unit: "U-T", count: notices.dropped });
  const dropped = droppedIn(raw, [...fitted.forecasts, ...fitted.observations]);
  if (dropped !== 0) diagnostics.push({ level: "INFO", component: "tsunami", reason: "unreadableDropped", unit: "U-T", count: dropped });
  return {
    changes: [...changes, ...fitted.evicted.map((item): Change => [item, null])],
    step: { state: next, nextDeadline: nextDeadline(next),
      decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "changed", reason: null, change,
        currentEstablished: evidence }],
      intents: notices.admitted,
      outcomes: [{ kind: "accepted", change, subjects: [subjectOutcome(proposal.target, proposal.facts,
        "stations" in proposal.target ? ["observations"] : ["forecasts"])] }],
      diagnostics },
  };
}

// 容量の拒否（P3-CC-AC03・AC04・AC10）。印 → 失敗警報 → 系列の desktop の title の書き換えの順に、前の段を確定した state へ当てる。
// 印は採用と同じ fit を通し（退去の適格性も同じ）、失敗警報と書き換えは追加の退去なしで収まるときだけ当てる。fresh は拒否した報の通知、
// emergency は拒否した報が警報以上への発令・引上げ・区域拡大を含むか（P3-NL-AC11 (4)。operation によらない）。
// ponytail: 拒否のときだけ intents（pending 128 件と終端記録）を数回なめる。平常の受信には足さない（Q-CC-COST）。
function refuse(state: TsunamiUnitState, candidate: ForecastCandidate | ObservationCandidate, clock: ClockReading, basis: WallBasis,
  made: readonly TsunamiIntent[], emergency: boolean, fresh = made.filter((item) => item.source.origin !== "recovery")): Result {
  const now = clock.wallTimeMs, operation = candidate.operation, verified = basis === "verified";
  let forecasts = state.forecasts, observations = state.observations, evicted: readonly Subject[] = [];
  let record: TsunamiForecastSubject | null = null, marked: TsunamiForecastSubject | null = null, covered = false;
  // 印は新しい版の採用が中身を包含する VTSE41 の active の記録だけに付ける。観測は unit の未確認へ寄せる（Q-CC-MARK）。
  const found = candidate.kind === "forecast" ? state.forecasts.find((item) => item.subject === candidate.subject && visible(item)) : undefined;
  if (candidate.kind === "forecast" && found != null) {
    record = found;
    if (found.unavailable != null && ["older", "same"].includes(compareVersion(found.unavailable.source, candidate.source))) covered = true;
    else {
      const next = { ...found, unavailable: { reason: "capacityExceeded" as const, source: candidate.source } };
      const fitted = fit(state.forecasts.map((item) => item === found ? next : item), state.observations, state.intents,
        state, candidate.subject, now, operation, verified);
      if (fitted != null) {
        ({ forecasts, observations, evicted } = fitted);
        marked = next;
        covered = true;
      }
    }
  }
  const fits = (values: readonly TsunamiIntent[], marks: readonly FailureMark[]) =>
    values.length <= PENDING_ITEMS && listBytes(values) + reserve(values) <= PENDING_BYTES
      && generationBytes(forecasts, observations, values, { failureMarks: marks, unreadableNotices: state.unreadableNotices }) <= GENERATION_LIMIT;
  let intents = state.intents, failureMarks = state.failureMarks;
  // D-FAILNOTICE=A: unit×operation の固定の subject。段階は上げるだけで、失敗の印の until まで同じか軽ければ鳴らさない（P3-NL-AC02 (6)）。
  const level = fresh[0]?.payload.level, failSubject = `${operation}/capacityRejected`;
  // P3-EF-AC06 (4): until を過ぎた印も、確かめた時計でなければ有効として扱う（失敗警報を重ねない）。
  const failed = state.failureMarks.find((item) => item.operation === operation && (!verified || item.until > now));
  if (emergency && (level === "warning" || level === "critical") && (failed == null || LEVELS.indexOf(level) > LEVELS.indexOf(failed.level))) {
    const at = jstClock(candidate.source.reportDateTimeRaw);
    const notices = fresh.map((item): TsunamiIntent => ({ ...item, id: failureNoticeId("U-T", failSubject, candidate.source, item.channel),
      subject: failSubject, payload: { ...item.payload, body: FAIL_BODY,
        title: `${PREFIX[operation]}【処理できていません】${item.payload.title.slice(PREFIX[operation].length)}（${at} 発表）` } }));
    const next = [...intents.filter((item) => item.subject !== failSubject), ...notices];
    const marks = [...state.failureMarks.filter((item) => item.operation !== operation),
      { operation, level, until: Math.max(...notices.map((item) => item.expiresAt)) }];
    if (fits(next, marks)) { intents = next; failureMarks = marks; }
  }
  // D-PENDING=A: 失敗した subject のまだ鳴っていない desktop の title にだけ元の報の時刻を付ける（同じ id・期限のまま、音は変えない）。
  const rewritten = intents.map((item) => {
    if (item.subject !== candidate.subject || item.channel !== "desktop" || item.disposition !== "pending") return item;
    const tag = `${PREFIX[item.operation]}【${jstClock(item.source.reportDateTimeRaw)} 発表】`;
    return item.payload.title.startsWith(tag) ? item
      : { ...item, payload: { ...item.payload, title: tag + item.payload.title.slice(PREFIX[item.operation].length) } };
  });
  if (rewritten.some((item, at) => item !== intents[at]) && fits(rewritten, failureMarks)) intents = rewritten;
  const before = new Set(state.intents);
  const touched = forecasts !== state.forecasts || intents !== state.intents;
  const next: TsunamiUnitState = touched ? { ...state, forecasts, observations, intents, failureMarks,
    persistence: dirty(state.persistence, clock.monotonicMs) } : state;
  const diagnostics: DiagnosticDetails[] = [{ level: "WARN", component: "tsunami", reason: "capacityRejected", unit: "U-T",
    inputId: candidate.source.inputId }];
  if (evicted.length !== 0) diagnostics.push({ level: "INFO", component: "tsunami", reason: "tsunamiCapacityEvicted",
    unit: "U-T", count: evicted.length });
  return {
    changes: marked == null ? [] : [[record, marked], ...evicted.map((item): Change => [item, null])], uncovered: !covered,
    step: { state: next, nextDeadline: nextDeadline(next),
      decisions: [marked == null ? { subject: candidate.subject, operation, decision: "capacityExceeded" }
        : { subject: candidate.subject, operation, decision: "changed", reason: null, change: "semantic", currentEstablished: null }],
      intents: intents.filter((item) => !before.has(item)),
      outcomes: marked == null ? [] : [{ kind: "accepted", change: "semantic", subjects: [{ subject: candidate.subject, operation,
        informationType: candidate.source.infoTypeRaw, transition: "unavailable", severity: null, source: candidate.source,
        facts: { family: candidate.family, eventId: candidate.eventId }, changedFields: ["unavailable"] }] }],
      diagnostics },
  };
}

// ---- 期限（I-U-T.deadlines） ----

// 到来した分だけを当てる。到来していなければ同じ state 参照を返す。時計の根拠ごとに（P3-EF-AC02）、awaiting は何も当てず、unverified は
// validUntil の来た観測に保留の印を付けるだけ、verified は観測の失効（保留の観測は時計によらず）と retainUntil・intent・失敗の印の回収まで。
function collect(state: TsunamiUnitState, clock: ClockReading, basis: WallBasis): Readonly<{ state: TsunamiUnitState; changes: readonly Change[];
  expired: readonly TsunamiObservationSubject[]; expiredIntents: number }> {
  const now = clock.wallTimeMs, verified = basis === "verified";
  const none = { state, changes: [], expired: [], expiredIntents: 0 };
  if (basis === "awaiting" || deadlineAt(state) > now && !(verified && pendingMin(state.observations) !== Infinity)) return none;
  const changes: Change[] = [];
  const expired: TsunamiObservationSubject[] = [];
  const forecasts = !verified || recallMin(state.forecasts) > now ? state.forecasts : state.forecasts.filter((item) => {
    if (item.retainUntil == null || item.retainUntil > now) return true;
    changes.push([item, null]);
    return false;
  });
  const touches = displayMin(state.observations) <= now
    || verified && (recallMin(state.observations) <= now || pendingMin(state.observations) !== Infinity);
  const observations = !touches ? state.observations : state.observations.flatMap((item) => {
    if (item.effective !== "active") {
      if (!verified || item.retainUntil == null || item.retainUntil > now) return [item];
      changes.push([item, null]);
      return [];
    }
    if (item.expiryPending !== true && (item.validUntil == null || item.validUntil > now) || !verified && item.expiryPending === true) return [item];
    const after = lapseObservation(item, now, basis);
    if (after.effective === "expired") expired.push(after);
    const kept = after.effective === "active" || after.retainUntil != null && after.retainUntil > now;
    changes.push([item, kept ? after : null]);
    return kept ? [after] : [];
  });
  const intents = !verified || intentDeadline(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - intents.length;
  // P3-NL-AC02 (6)・P3-EF-AC06 (4): until を過ぎた失敗の印は確かめた時計の期限の入力でだけ外す。
  const failureMarks = !verified || state.failureMarks.every((item) => item.until > now) ? state.failureMarks
    : state.failureMarks.filter((item) => item.until > now);
  if (forecasts === state.forecasts && changes.length === 0 && intents === state.intents && failureMarks === state.failureMarks) return none;
  return { state: { ...state, forecasts, observations: changes.length === 0 ? state.observations : observations, intents, failureMarks,
    persistence: dirty(state.persistence, clock.monotonicMs) }, changes, expired, expiredIntents };
}

function deadlineStep(state: TsunamiUnitState, clock: ClockReading, basis: WallBasis, shutdown: boolean): Result {
  const applied = collect(state, clock, basis);
  const subjects = applied.expired.map((item) => subjectOutcome(item, null, ["effective", "stations", "validUntil"]));
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "tsunami",
    reason: "notificationExpired", unit: "U-T", count: applied.expiredIntents }];
  return { changes: applied.changes, step: { ...idle(applied.state),
    decisions: applied.expired.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const,
      reason: null, change: "semantic" as const, currentEstablished: null })),
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects }]
      : subjects.length === 0 ? [] : [{ kind: "deadlineApplied", subjects }],
    diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

// P3-NL-AC02 (3)・AC08 (1): intent の系列の印の証拠を上げる（下げない）。失敗警報は系列の印を持たない。
function raiseNotices(state: TsunamiUnitState, raised: ReadonlyMap<string, NoticeEvidence>): TsunamiUnitState {
  if (raised.size === 0) return state;
  const raise = <T extends Subject>(item: T): T => {
    const evidence = raised.get(item.subject);
    const notice = evidence == null || item.notice == null ? item.notice : raiseEvidence(item.notice, evidence);
    return notice === item.notice ? item : { ...item, notice };
  };
  // ponytail: 更新 1 回に記録を 1 回なめる（予報 512・観測 1,024、更新は 2 件ほど）。受理 1 回の線形 1 回に収まる。
  const forecasts = state.forecasts.map(raise), observations = state.observations.map(raise);
  return forecasts.every((item, at) => item === state.forecasts[at]) && observations.every((item, at) => item === state.observations[at])
    ? state : { ...state, forecasts, observations };
}

function intentUpdate(state: TsunamiUnitState, input: Extract<TsunamiInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changed = new Map<string, TsunamiIntent>();
  const raised = new Map<string, NoticeEvidence>();
  for (const update of updates) {
    const current = originals.get(update.id);
    const updated = current == null ? null : applyIntentUpdate(current, update);
    if (updated == null) continue;
    changed.set(updated.id, updated);
    const evidence = updateEvidence(updated);
    if (evidence != null) raised.set(updated.subject, evidence);
  }
  if (changed.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4 の先例）。pending でなくなった intent は外す（P3-NL-AC05 (1)）。
  const next = { ...raiseNotices(state, raised), intents: state.intents.flatMap((item) => {
    const updated = changed.get(item.id);
    return updated == null ? [item] : updated.disposition === "pending" ? [updated] : [];
  }), persistence: dirty(state.persistence, input.clock.monotonicMs), unreadableNotices: extendUnreadableNotices(state.unreadableNotices, [...changed.values()]) };
  const adopted = [...changed.values()];
  return { changes: [], step: { ...idle(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "deliveryOnly" as const, currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted" as const, change: "deliveryOnly" as const, subjects: [{ subject: item.subject,
      operation: item.operation, informationType: item.source.infoTypeRaw, transition: item.disposition, severity: null,
      source: item.source, facts: { intentId: item.id, channel: item.channel }, changedFields: ["intents"] }] })) } };
}

function restore(state: TsunamiUnitState, persisted: PersistedTsunamiUnit, clock: ClockReading, basis: WallBasis): Result {
  const decoded = tsunamiUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "tsunami",
    reason: "requiredStructureInvalid", unit: "U-T" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。P3-NL-AC08 (1)(4): started のまま残った
  // pending（失敗警報を含む）は通知したか不明として外し、系列の印の証拠を unknown にする。
  const restored = restoreStarted(decoded.state.intents);
  const unknown = new Map(restored.started.map((item) => [item.subject, "unknown" as const]));
  const base = { ...raiseNotices(decoded.state, unknown), intents: restored.intents,
    persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const applied = collect(base, clock, basis);
  const visibleSubjects = [...applied.state.forecasts, ...applied.state.observations].filter(visible);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "tsunami",
    reason: "notificationExpired", unit: "U-T", count: applied.expiredIntents }];
  if (restored.started.length !== 0) diagnostics.push({ level: "INFO", component: "tsunami", reason: "notificationOutcomeUnknown",
    unit: "U-T", count: restored.started.length });
  return { changes: visibleSubjects.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-T"], coverage: visibleSubjects.map((item) => item.subject), subjects: [] }],
    diagnostics } };
}

// 受けた報の読めなかった所の WARN を先に置く（P3-EF-AC13 (2)）。
function warned(result: Result, diagnostics: readonly DiagnosticDetails[]): Result {
  return diagnostics.length === 0 ? result : { ...result, step: { ...result.step, diagnostics: [...diagnostics, ...result.step.diagnostics] } };
}
function receive(state: TsunamiUnitState, input: Extract<TsunamiInput, { kind: "receive" }>): Result {
  const parsed = parseTsunami(input.material);
  const noChange = (subject: string, operation: Operation): Result => ({ changes: [], step: { ...idle(state),
    decisions: [{ subject, operation, decision: "unchanged", reason: "noChange" }] } });
  switch (parsed.kind) {
    case "rejected": return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
      operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
    // Q-ENUM の VTSE51.legalMissing: 観測の無い報は state・watermark を変えず、intent・outcome を出さない（診断は読めなかった所だけ）。
    case "noObservation": return warned(noChange(parsed.subject, parsed.operation), parsed.diagnostics);
    case "accepted": {
      const { candidate } = parsed;
      // P3-REC-AC12（C16 発注 3）: origin=recovery は候補の作成のときだけ owner から届く。VTSE41 は意味を当て（intent は作らない）、
      // 観測（VTSE51・VTSE52）は取り直さない（P3-C5-N2 の range）。
      if (candidate.source.origin === "recovery" && candidate.kind !== "forecast") return noChange(candidate.subject, candidate.operation);
      const basis = input.basis ?? "verified";
      return warned(candidate.kind === "forecast" ? receiveForecast(state, candidate, input.clock, basis)
        : receiveObservation(state, candidate, input.clock, basis), parsed.diagnostics);
    }
    default: { const missing: never = parsed; throw new Error(`tsunami parse result ${String(missing)} is not handled`); }
  }
}

function reduceCore(state: TsunamiUnitState, input: TsunamiInput): Result {
  switch (input.kind) {
    case "unreadable": return unreadableNotice(state, input); case "restore": return restore(state, input.persisted, input.clock, input.basis ?? "verified");
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, input.basis ?? "verified", false);
    case "shutdown": return deadlineStep(state, input.clock, input.basis ?? "verified", true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`tsunami input ${String(missing)} is not handled`); }
  }
}

function reduceTsunamiUnit(state: TsunamiUnitState, input: TsunamiInput): TsunamiUnitStep {
  const { step, changes, uncovered } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: Subject | null; after: Subject | null }>();
  for (const [before, after] of changes) {
    const key = (after ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: TsunamiUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-T", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-T content revision exhausted");
  // I-U-T.confirmationScope: scope は常態を確立した（active になった）VTSE41 の採用からだけ出す。観測は対象外（P3-C5-N2）。
  const confirmationEvidence: TsunamiUnitStep["confirmationEvidence"] = input.kind !== "receive" ? []
    : [...step.decisions.flatMap((item) => {
      const current = item.decision === "changed" && item.currentEstablished?.family === "VTSE41"
        ? step.state.forecasts.find((value) => value.subject === item.subject) : undefined;
      return current?.effective === "active" ? [{ source: "acceptedReport" as const, scopes: [{ unit: "U-T" as const,
        operation: item.operation, kind: "event" as const, eventId: current.eventId }] }] : [];
    }), ...uncovered === true ? [{ source: "capacityExceeded" as const,
      scopes: [{ unit: "U-T" as const, operation: input.material.operation, kind: "unit" as const }] }] : []];
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence };
}

function toTsunamiView(state: TsunamiUnitState): TsunamiUnitView {
  const forecasts = state.forecasts.filter(visible), observations = state.observations.filter(visible);
  const active: Subject[] = [...forecasts, ...observations];
  return { unit: "U-T", semanticRevision: active.map((item) => `${item.subject}:${item.source.reportDateTimeRaw}:${item.source.serialRaw}:`
    + `${item.source.infoTypeRaw}`).sort().join("|"), contentRevision: String(state.contentRevision),
  subjects: active.map((item) => subjectOutcome(item)), forecasts: forecasts.map((item) => shown(item)),
  observations: observations.map((item) => shown(item)) };
}

// ---- 取り直しの採用の step（P3-RECOVERY-001 発注 3、P3-REC-AC06 (a)・AC10） ----

// H27 の音の段（P3-REC-D-RAISE-SOUND=A）: 大津波警報への引上げは critical、津波警報は warning、ほかの引上げは info。
const raiseSound = (to: TsunamiAreaClass): Exclude<Level, "cancel"> => to === "majorWarning" ? "critical" : to === "warning" ? "warning" : "info";

/**
 * 候補の部分集合の検査の後に、採用の step で作る intent（P3-REC-AC06 (a)）。open は取り直しを始めた時の state（P3-REC-D-RAISE-BASIS=A）、
 * candidate は採用する state。(1) H27: いまも有効な引上げ（live の規則で段が上がる区域）を unit で 1 件（段の最も高い subject）、ID と重ねない照合は
 * K8 の印。(2) 取り直しで拾った読めない報のカードがあれば info を 1 件（P3-UM-AC12 の (3)(7)(10)）。(3) 採用の直前の live で保存待ちだった pending を候補の作成が引き下げで外したら、今の段の音を 1 件（loweredNotice、Q-REC-PRECHECK-6 の N4）。無ければ candidate をそのまま返す。
 */
function recoveryNotices(open: TsunamiUnitState, candidate: TsunamiUnitState, recoveryId: string,
  unreadable: Readonly<{ operation: Operation | null; receivedAt: number; inputId: string; headType: string }> | null, clock: ClockReading, live: TsunamiUnitState): TsunamiUnitState {
  const now = clock.wallTimeMs;
  const before = new Map(open.forecasts.map((item) => [item.subject, item]));
  let best: Readonly<{ subject: TsunamiForecastSubject; level: Exclude<Level, "cancel">; names: string[]; kinds: string[] }> | null = null;
  for (const subject of candidate.forecasts) {
    if (subject.effective !== "active") continue;
    const prior = before.get(subject.subject);
    const from = new Map((prior == null || prior.effective === "cancelled" ? [] : prior.areas).map((area) => [area.code, area.areaClass]));
    let level: Exclude<Level, "cancel"> | null = null;
    const names: string[] = [], kinds: string[] = [];
    for (const area of subject.areas) {
      const transition = transitionOf(from.get(area.code) ?? "none", area.areaClass, prior?.effective === "active");
      if (transition !== "issued" && transition !== "expanded" && transition !== "upgraded") continue;
      level = level == null ? raiseSound(area.areaClass) : maxLevel(level, raiseSound(area.areaClass));
      names.push(area.name);
      if (!kinds.includes(area.kindName)) kinds.push(area.kindName);
    }
    // 通知済みの版（K8 の印）は選ぶ前に除く（除かないと、通知済みの系列が別の系列の未通知の引上げを消す）。
    if (level == null || noticed(subject.notice, versionDigest(subject.source), noticeKind("updated"))) continue;
    if (best == null || LEVELS.indexOf(level) > LEVELS.indexOf(best.level)) best = { subject, level, names, kinds };
  }
  const raisedRecord: TsunamiForecastSubject | undefined = best?.subject, lowered = loweredNotice(live, candidate, raisedRecord?.subject, now), fresh: TsunamiIntent[] = [];
  if (best != null) {
    const { subject, level } = best;
    const at = jstClock(subject.source.reportDateTimeRaw);
    const payload = payloadOf(subject.operation, level, `${forecastTitle(subject, true)}（${at} 発表）`,
      `${best.kinds.join("・")} / ${best.names.slice(0, 3).join(", ")}`, false);
    fresh.push(...intentsFor(subject.source, "updated", { ...payload, reportDateTime: subject.source.reportDateTimeRaw, recovered: true }, now,
      { mark: subject.notice, version: versionDigest(subject.source) }, level === "warning" || level === "critical"));
  }
  if (unreadable != null) {
    const operation = unreadable.operation ?? "normal", subject = `${operation}/unreadable`;
    // source は読めない報の入力を指すだけ（版の比べに使わない）。codec の ReportRef の検査に合わせ、時刻は受信時刻、InfoType は発表にする。
    const received = new Date(unreadable.receivedAt).toISOString();
    const source: ReportRef = { inputId: unreadable.inputId, origin: "recovery", operation, family: unreadable.headType, subject,
      reportDateTimeRaw: received, controlDateTimeRaw: "", serialRaw: "", infoTypeRaw: "発表" };
    const payload = payloadOf(operation, "info", "津波の情報（読めない報）を受信", `受信 ${jstClock(received)}。内容を読めませんでした`, false);
    for (const channel of operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const)
      fresh.push({ id: `U-T:${subject}:recovery:${recoveryId}:${channel}`, unit: "U-T", subject, operation, source, transition: "activated", channel,
        payload, createdAt: now, expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending",
        ...freshState("U-T", operation) });
  }
  if (lowered != null) fresh.push(...lowered.intents); if (fresh.length === 0) return candidate; // N4 は H27 と読めない報の後に収容する（枠の境で、先に足した N4 が H27 を拒ませない。r1）
  const notices = admit(candidate.intents, fresh, null, true);
  if (notices.admitted.length === 0) return candidate;
  // P3-NL-AC02 (3): 引上げと今の段の音の版と種類を系列の印に足す（読めない報は系列の印を持たない）。
  const marks = new Map(notices.admitted.map((item) => [item.subject, item.transition] as const)); // 引上げ（H27）と今の段の音（N4）の版と種類
  const forecasts = candidate.forecasts.map((item) => { const transition = item === raisedRecord || item === lowered?.subject ? marks.get(item.subject) : undefined;
    return transition == null ? item : { ...item, notice: markNotice(item.notice, versionDigest(item.source), noticeKind(transition)) }; });
  return { ...candidate, forecasts, intents: notices.intents };
}

// ---- codec（I-U-T.persisted・I-U-T.decode、唯一の TsunamiUnitCodec） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const text = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown): value is number | null => value === null || finite(value);
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function reportRef(value: unknown): ReportRef | null {
  const ref = readReportRef(value);
  return ref == null || !Number.isFinite(Date.parse(ref.reportDateTimeRaw)) || !INFO_RANK.has(ref.infoTypeRaw.trim()) ? null : ref;
}
function materialValue(value: unknown): MaterialValue | null {
  const row = record(value);
  if (row == null) return null;
  if (row.kind === "missing") return { kind: "missing" };
  if ((row.kind === "empty" || row.kind === "unknown") && text(row.raw)) return { kind: row.kind, raw: row.raw };
  if (row.kind === "text" && text(row.raw) && text(row.value)) return { kind: "text", value: row.value, raw: row.raw };
  if (row.kind === "number" && text(row.raw) && finite(row.value)) return { kind: "number", value: row.value, raw: row.raw };
  if (row.kind === "range" && text(row.raw) && finite(row.value) && (row.bound === "lower" || row.bound === "upper"))
    return { kind: "range", bound: row.bound, value: row.value, raw: row.raw };
  return null;
}
function heightOf(value: unknown): TsunamiHeight | null | "invalid" {
  if (value === null) return null;
  const row = record(value);
  const material = materialValue(row?.value);
  if (row == null || material == null || !textOrNull(row.condition) || !textOrNull(row.description)) return "invalid";
  return { value: material, condition: row.condition, description: row.description };
}
// station・推定の高さは parser が作る種類（数値・NaN・範囲表記、Q-ENUM.invalid）だけ。
function measured(height: TsunamiHeight | null): boolean {
  return height == null || height.value.kind === "number" || height.value.kind === "unknown" || height.value.kind === "range";
}
function forecastArea(value: unknown): TsunamiForecastArea | null {
  const row = record(value), first = record(row?.firstHeight);
  const maxHeight = heightOf(row?.maxHeight);
  if (row == null || first == null || maxHeight === "invalid" || !text(row.code) || !/^\d{3}$/.test(row.code) || !text(row.name)
    || !text(row.kindCode) || !text(row.kindName) || !textOrNull(first.arrivalTimeRaw) || !textOrNull(first.condition)
    || row.areaClass !== (KIND_CLASS.get(row.kindCode) ?? "unknown")) return null;
  return { code: row.code, name: row.name, areaClass: KIND_CLASS.get(row.kindCode) ?? "unknown", kindCode: row.kindCode,
    kindName: row.kindName, firstHeight: { arrivalTimeRaw: first.arrivalTimeRaw, condition: first.condition }, maxHeight };
}
function unkeyedArea(value: unknown): TsunamiUnkeyedArea | null {
  const row = record(value);
  return row != null && text(row.name) && text(row.kindCode) && text(row.kindName)
    ? { name: row.name, kindCode: row.kindCode, kindName: row.kindName } : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
// 印（P3-CC-AC05）: 鍵があれば reason と拒否した報の ReportRef を確かめる。所属の確認は呼ぶ側。
function unavailableOf(value: unknown): SubjectUnavailable | null {
  const row = record(value), source = reportRef(row?.source);
  return row?.reason === "capacityExceeded" && source != null ? { reason: "capacityExceeded", source } : null;
}
// P3-VM-AC04: 未確認の印。鍵があれば共有の読み戻しを通し、系列と同じ subject・operation の報であること（取消の後の時刻の無い報の印も残る）。
function unconfirmedOf(row: Fields, subject: string, operation: Operation): ReportRef | null | "invalid" {
  if (!("unconfirmed" in row)) return null;
  const mark = reportRef(row.unconfirmed);
  return mark == null || mark.subject !== subject || mark.operation !== operation ? "invalid" : mark;
}
// P3-UM-AC01 (2)（TsunamiUnreadableSite）・(6): 印は事実を持つ記録だけが持つ（欄が無ければ {}、形の外は null）。
const UNREADABLE_SITES: ReadonlySet<string> = new Set(["serial", "forecastHeight", "station", "estimation"] satisfies readonly TsunamiUnreadableSite[]);
function unreadableOf(row: Fields, allowed: boolean): Readonly<{ unreadable?: UnreadableMark }> | null {
  if (!("unreadable" in row)) return {};
  const mark = allowed ? readUnreadableMark(row.unreadable, UNREADABLE_SITES) : null;
  return mark == null ? null : { unreadable: mark };
}
function forecastSubject(value: unknown): TsunamiForecastSubject | null {
  const row = record(value);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const areas = list(row?.areas, forecastArea), unkeyedAreas = list(row?.unkeyedAreas, unkeyedArea);
  if (row == null || operation == null || source == null || areas == null || unkeyedAreas == null || !text(row.eventId)
    || !/^\d{14}$/.test(row.eventId) || row.subject !== `${operation}/VTSE41/${row.eventId}` || source.subject !== row.subject
    || source.operation !== operation || source.family !== "VTSE41" || !finiteOrNull(row.retainUntil)
    || !unique(areas.map((area) => area.code))) return null;
  const active = [...areas, ...unkeyedAreas].some((area) => AREA_RANK[classOf(area)] >= 2);
  const effective = row.effective === "active" || row.effective === "released" || row.effective === "cancelled" ? row.effective : null;
  if (effective == null || (effective === "cancelled" ? areas.length !== 0 || unkeyedAreas.length !== 0 : active !== (effective === "active"))
    || (effective === "active") !== (row.retainUntil === null)) return null;
  // 印は active の記録だけが持ち、source は同じ subject の VTSE41（版の比較に使う欄は reportRef が確かめる）。
  const mark = "unavailable" in row ? unavailableOf(row.unavailable) : null;
  if ("unavailable" in row && (mark == null || effective !== "active" || mark.source.subject !== row.subject
    || mark.source.operation !== operation || mark.source.family !== "VTSE41")) return null;
  const unconfirmed = unconfirmedOf(row, row.subject, operation);
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  const unreadable = unreadableOf(row, effective !== "cancelled");
  if (unconfirmed === "invalid" || notice === null || unreadable == null) return null;
  return { subject: row.subject, eventId: row.eventId, operation, source, effective, areas, unkeyedAreas, retainUntil: row.retainUntil,
    ...mark == null ? {} : { unavailable: mark }, ...unconfirmed == null ? {} : { unconfirmed }, ...notice == null ? {} : { notice }, ...unreadable };
}
function station(value: unknown): TsunamiStation | null {
  const row = record(value), first = record(row?.firstHeight), max = record(row?.maxHeight), revision = record(row?.revision);
  const maxHeight = heightOf(max?.height);
  if (row == null || first == null || max == null || revision == null || maxHeight === "invalid" || !measured(maxHeight)
    || !text(row.code) || row.code === ""
    || !text(row.name) || !textOrNull(row.areaCode) || !textOrNull(row.areaName) || !textOrNull(row.sensor)
    || !textOrNull(first.arrivalTimeRaw) || !textOrNull(first.initial) || !textOrNull(first.condition)
    || !textOrNull(max.dateTimeRaw) || !textOrNull(max.condition) || !text(revision.reportDateTimeRaw)
    || !text(revision.serialRaw) || !text(revision.infoTypeRaw)) return null;
  return { code: row.code, name: row.name, areaCode: row.areaCode, areaName: row.areaName, sensor: row.sensor,
    firstHeight: { arrivalTimeRaw: first.arrivalTimeRaw, initial: first.initial, condition: first.condition },
    maxHeight: { dateTimeRaw: max.dateTimeRaw, condition: max.condition, height: maxHeight },
    revision: { reportDateTimeRaw: revision.reportDateTimeRaw, serialRaw: revision.serialRaw, infoTypeRaw: revision.infoTypeRaw } };
}
function estimation(value: unknown): TsunamiEstimation | null {
  const row = record(value), first = record(row?.firstHeight), max = record(row?.maxHeight);
  const height = heightOf(max?.height);
  if (row == null || first == null || max == null || height === "invalid" || !measured(height) || !text(row.areaCode) || row.areaCode === ""
    || !text(row.areaName) || !textOrNull(first.arrivalTimeRaw) || !textOrNull(first.condition) || !textOrNull(max.condition)) return null;
  return { areaCode: row.areaCode, areaName: row.areaName, firstHeight: { arrivalTimeRaw: first.arrivalTimeRaw, condition: first.condition },
    maxHeight: { condition: max.condition, height } };
}
function observationSubject(value: unknown): TsunamiObservationSubject | null {
  const row = record(value);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const family = row?.family === "VTSE51" || row?.family === "VTSE52" ? row.family : null;
  const stations = list(row?.stations, station), estimations = list(row?.estimations, estimation);
  const effective = row?.effective === "active" || row?.effective === "cancelled" || row?.effective === "forecastEnded"
    || row?.effective === "expired" ? row.effective : null;
  // 観測は容量の印を持たない（P3-CC-AC03(1)）。
  if (row == null || "unavailable" in row || operation == null || source == null || family == null || stations == null || estimations == null
    || effective == null || !text(row.eventId) || !/^\d{14}$/.test(row.eventId) || !text(row.controlDateTimeRaw)
    || controlDateTimeOf(row.controlDateTimeRaw) !== row.controlDateTimeRaw
    // reducer は serialRaw を数として比べる（Q-ENUM.priorityRule の Serial: 正整数）。
    // 読めなかった Serial は空で保存する（P3-EF-AC13 (5)、Q-EF-PRECHECK-2 (a)）。
    || source.serialRaw !== "" && (!/^[1-9]\d*$/.test(source.serialRaw.trim()) || !Number.isSafeInteger(Number(source.serialRaw)))
    || row.subject !== `${operation}/tsunamiObservation:${family}/${row.eventId}` || source.subject !== row.subject
    || source.operation !== operation || source.family !== family || !finiteOrNull(row.validUntil) || !finiteOrNull(row.retainUntil)
    || !unique(stations.map((item) => item.code)) || !unique(estimations.map((item) => item.areaCode))
    || family === "VTSE51" && estimations.length !== 0
    || (effective === "cancelled" || effective === "expired") && (stations.length !== 0 || estimations.length !== 0)
    || (effective === "active") !== (row.retainUntil === null) || effective === "active" && row.validUntil === null
    // 保留の印は active の観測にだけ置ける（P3-EF-AC06 (1)）。
    || "expiryPending" in row && (row.expiryPending !== true || effective !== "active")) return null;
  const unconfirmed = unconfirmedOf(row, row.subject, operation);
  const notice = "notice" in row ? readNoticeMark(row.notice, true) : undefined;
  const unreadable = unreadableOf(row, effective === "active" || effective === "forecastEnded");
  if (unconfirmed === "invalid" || notice === null || unreadable == null) return null;
  return { subject: row.subject, eventId: row.eventId, operation, family, source, controlDateTimeRaw: row.controlDateTimeRaw, effective, stations,
    estimations, validUntil: row.validUntil, retainUntil: row.retainUntil, ...unconfirmed == null ? {} : { unconfirmed },
    ...notice == null ? {} : { notice }, ...row.expiryPending === true ? { expiryPending: true } : {}, ...unreadable };
}
const SUBJECT_FORM = /^(normal|training|test)\/(?:VTSE41|tsunamiObservation:VTSE5[12])\/\d{14}$/;
// D-FAILNOTICE=A の失敗警報の固定の subject。source は拒否した報なので subject と一致しない（P3-CC-AC05）。
const FAIL_FORM = /^(normal|training|test)\/capacityRejected$/;
// P3-UM-AC12 (10): 取り直しで拾った読めない報の固定の subject（source は読めない報の入力で、subject は同じ形）。
const UNREADABLE_FORM = /^(normal|training|test)\/unreadable$/;
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intent(value: unknown): TsunamiIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const level = LEVEL_SET.find((item) => item === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((item) => item === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-T", operation, level);
  // P3-REC-AC12: 発表時刻と「取り直しで拾った」印は両方あるか両方無いか（項目ごとに確かめる）。
  const recovered = payload == null ? null : payload.recovered === undefined && payload.reportDateTime === undefined ? "none" as const
    : payload.recovered === true && text(payload.reportDateTime) ? { reportDateTime: payload.reportDateTime } : null;
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || fields == null || recovered == null || !text(row.id) || row.unit !== "U-T" || !text(row.subject)
    || (FAIL_FORM.exec(row.subject) ?? UNREADABLE_FORM.exec(row.subject) ?? SUBJECT_FORM.exec(row.subject))?.[1] !== operation
    || (FAIL_FORM.test(row.subject) ? SUBJECT_FORM.exec(source.subject)?.[1] !== operation : source.subject !== row.subject)
    || source.operation !== operation
    || payload.domain !== "tsunami" || !text(payload.title) || payload.title === ""
    || !text(payload.body) || payload.body === "" || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt)
    || !Number.isSafeInteger(row.attempts) || !text(row.configRevision) || row.expiresAt < row.createdAt) return null;
  const attempts = Number(row.attempts);
  if (attempts < 0) return null;
  return { id: row.id, unit: "U-T", subject: row.subject, operation, source, transition, channel,
    payload: recovered === "none" ? { domain: "tsunami", level, title: payload.title, body: payload.body }
      : { domain: "tsunami", level, title: payload.title, body: payload.body, reportDateTime: recovered.reportDateTime, recovered: true },
    createdAt: row.createdAt, expiresAt: row.expiresAt,
    nextAttemptAt: row.nextAttemptAt, attempts, configRevision: row.configRevision, disposition: "pending", ...fields };
}

function persisted(value: unknown): PersistedTsunamiUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const forecasts = list(row.forecasts, forecastSubject), observations = list(row.observations, observationSubject);
  const intents = list(row.intents, intent), failureMarks = readFailureMarks(row.failureMarks), unreadableNotices = readUnreadableNotices(row.unreadableNotices);
  if (forecasts == null || observations == null || intents == null || failureMarks == null || unreadableNotices == null || forecasts.length > FORECAST_LIMIT
    || !unique([...forecasts, ...observations].map((item) => item.subject)) || !unique(intents.map((item) => item.id))) return null;
  for (const family of FAMILIES) {
    const own = observations.filter((item) => item.family === family);
    if (own.length > OBSERVATION_LIMIT || own.reduce((sum, item) => sum + item.stations.length, 0) > STATION_LIMIT) return null;
  }
  // P3-UM-AC16 (3)(c)（AC03 (1) の数え方）。
  if (intents.length > PENDING_ITEMS || listBytes(intents) + reserve(intents) > PENDING_BYTES
    || generationBytes(forecasts, observations, intents, { failureMarks, unreadableNotices }) > GENERATION_LIMIT || rawTotal(forecasts, observations) > RAW_BUDGET) return null;
  return { schemaVersion: SCHEMA, forecasts, observations, intents, failureMarks, unreadableNotices };
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const tsunamiUnitCodec: TsunamiUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p3-tsunami-unit-v1", "p3-tsunami-unit-v2", "p3-tsunami-unit-v3", "p3-tsunami-unit-v4", "p3-tsunami-unit-v5", "p3-tsunami-unit-v6", "p3-tsunami-unit-v7", "p3-tsunami-unit-v8"], maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  // state は reducer が上限の内側で作るので、encode は保存 field だけを並べる（contentRevision・persistence は保存しない）。
  encode: (state) => ({ schemaVersion: SCHEMA, forecasts: state.forecasts, observations: state.observations, intents: state.intents,
    failureMarks: state.failureMarks, unreadableNotices: state.unreadableNotices }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: `invalid ${SCHEMA} payload` }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UM-AC12（P3-UM-D-CARD-SOUND=A）: 読めない津波の報の通知。VTSE41 は warning で津波緊急の群（読めない区分は unknown と同じ）、観測は info。
// training・test は desktop だけ。operation の印の窓（intent の expiresAt の最大）の内で段が上がらなければ鳴らさない。印は保存の世代に入るので、
// 器に収まらなければ鳴らさない（無いと器の際で capture が落ちる）。取り直しの音は recoveryNotices で、ここは通らない（AC12 (10)）。
function unreadableNotice(state: TsunamiUnitState, input: Extract<TsunamiInput, { kind: "unreadable" }>): Result {
  const operation = input.operation ?? "normal", forecast = input.headType === "VTSE41", level = forecast ? "warning" as const : "info" as const;
  const now = input.clock.wallTimeMs;
  if (!unreadableNoticeDue(state.unreadableNotices, operation, level, now)) return { changes: [], step: idle(state) };
  const source = unreadableSource(input, operation);
  const payload = payloadOf(operation, level, "津波の情報（読めない報）を受信", unreadableBody(input.receivedAt), false);
  const fresh = (operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const).map((channel): TsunamiIntent => ({
    id: `U-T:${source.subject}:${input.inputId}:${channel}`, unit: "U-T", subject: source.subject, operation, source, transition: "activated", channel,
    payload, createdAt: now, expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending",
    ...freshState("U-T", operation, forecast) }));
  const notices = admit(state.intents, fresh, null);
  if (notices.admitted.length === 0) return { changes: [], step: idle(state) };
  const unreadableNotices = withUnreadableNotice(state.unreadableNotices, { operation, level, until: Math.max(...notices.admitted.map((item) => item.expiresAt)) });
  if (generationBytes(state.forecasts, state.observations, notices.intents, { failureMarks: state.failureMarks, unreadableNotices }) > GENERATION_LIMIT)
    return { changes: [], step: idle(state) };
  const next: TsunamiUnitState = { ...state, intents: notices.intents, unreadableNotices, persistence: dirty(state.persistence, input.clock.monotonicMs) };
  return { changes: [], step: { ...idle(next), intents: notices.admitted,
    diagnostics: notices.dropped === 0 ? [] : [{ level: "INFO", component: "tsunami", reason: "notificationCapacityEvicted", unit: "U-T", count: notices.dropped }] } };
}

// P3-UNIT-TABLE-001: この unit の行（I-U-T.runtimeRows）。
const tsunamiUnit = {
  unit: "U-T",
  reduce: reduceTsunamiUnit,
  toView: toTsunamiView,
  persistence: { kind: "durable", codec: tsunamiUnitCodec },
  confirmationScopeLimit: 512,
  reclaimDeadlineBeforeReceive: true,
  recoveryNotices: (open, adopted, at) => recoveryNotices(open, adopted, at.recoveryId, at.card, at.clock, at.live),
  recoveryChanges,
} satisfies UnitModule<"U-T">;

// P3-REC-AC07（投影の直し、Q-REC-PRECHECK-7 の N2）: 取り直しの採用の step の正味の表示の変化（採用の直前の live → 最終の state）。
// 両状態の記録を鍵の Map で突き合わせ、reduce の merged の loop と同じ述語・displaySubject・鍵で作る。同じ参照の記録は省く（O(N前＋N後)）。
function recoveryChanges(before: TsunamiUnitState, after: TsunamiUnitState): TsunamiUnitStep["displayChanges"] {
  const old = new Map<string, Subject>();
  for (const item of before.forecasts) old.set(item.subject, item); for (const item of before.observations) old.set(item.subject, item);
  const changes: TsunamiUnitStep["displayChanges"][number][] = [];
  const add = (was: Subject | null, now: Subject | null) => {
    const shownBefore = visible(was) ? was : null, shownAfter = visible(now) ? now : null;
    if (shownBefore === shownAfter) return;
    const value = (now ?? was)!;
    changes.push({ unit: "U-T", operation: value.operation, subject: value.subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  };
  for (const item of [...after.forecasts, ...after.observations]) { add(old.get(item.subject) ?? null, item); old.delete(item.subject); }
  for (const item of old.values()) add(item, null);
  return changes;
}

// Q-REC-PRECHECK-6 の N2・N4: 記録の区分の最大（highest と同じ AREA_RANK、unkeyedAreas を含む。区分が無ければ 0）。
function topRank(value: TsunamiForecastSubject): number {
  return AREA_RANK[highest(value) ?? "none"];
}

// P3-REC-AC12【発注 4c】・Q-REC-PRECHECK-6 の N4: 採用の直前の live にあって候補に無い期限の内の pending（候補の作成の置換が外した保存待ちの音）のうち、
// その subject の候補の記録が取消でなく区分の最大が live の記録より下がったものから、外した level の最も高い subject を 1 つ選び、今の段の音を作る。
// H27 を鳴らす subject と K8 で通知済みの版は選ぶ前に除く。段は live の式の残った区分の段（候補が active なら normal、ほかは info）で、緊急群に入れない。
// ponytail: 採用の step に 1 回だけ、live の pending（128 件まで）を 1 回なめる。受信経路ではない。
function loweredNotice(live: TsunamiUnitState, candidate: TsunamiUnitState, raisedSubject: string | undefined, now: number):
  Readonly<{ subject: TsunamiForecastSubject; intents: readonly TsunamiIntent[] }> | null {
  const kept = new Set(candidate.intents.map((item) => item.id));
  const before = new Map(live.forecasts.map((item) => [item.subject, item])), after = new Map(candidate.forecasts.map((item) => [item.subject, item]));
  let best: Readonly<{ was: TsunamiForecastSubject; next: TsunamiForecastSubject; transition: "released" | "updated"; level: number }> | null = null;
  for (const intent of live.intents) {
    if (kept.has(intent.id) || intent.expiresAt <= now || intent.subject === raisedSubject) continue;
    const was = before.get(intent.subject), next = after.get(intent.subject);
    if (was == null || next == null || next.effective === "cancelled" || topRank(next) >= topRank(was)) continue;
    const transition = was.effective === "active" && next.effective !== "active" ? "released" : "updated";
    if (noticed(next.notice, versionDigest(next.source), noticeKind(transition))) continue;
    const level = intent.payload.level === "cancel" ? -1 : LEVELS.indexOf(intent.payload.level);
    if (best == null || level > best.level) best = { was, next, transition, level };
  }
  if (best == null) return null;
  const { next, transition } = best, areas = [...next.areas, ...next.unkeyedAreas];
  const title = `${forecastTitle(next, best.was.effective === "active")}（${jstClock(next.source.reportDateTimeRaw)} 発表）`;
  const parts = [[...new Set(areas.map((area) => area.kindName))].join("・"), areas.slice(0, 3).map((area) => area.name).join(", ")].filter((part) => part !== "");
  const payload = payloadOf(next.operation, next.effective === "active" ? "normal" : "info", title, parts.length === 0 ? title : parts.join(" / "), false);
  return { subject: next, intents: intentsFor(next.source, transition, { ...payload, reportDateTime: next.source.reportDateTimeRaw, recovered: true }, now,
    { mark: next.notice, version: versionDigest(next.source) }) };
}

export { recoveryChanges, recoveryNotices, reduceTsunamiUnit, toTsunamiView, tsunamiUnit, tsunamiUnitCodec };
