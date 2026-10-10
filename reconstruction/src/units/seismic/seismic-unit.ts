import { isDeepStrictEqual } from "node:util";

import type { MaterialValue, Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline,
  SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  EarthquakeContribution, EarthquakeEvent, EarthquakeEventView, EarthquakeFamily, LongPeriodSubject, PersistedSeismicUnit,
  SeismicDailyHistory, SeismicHypocenter, SeismicInput, SeismicIntensityItem, SeismicIntensityObservation, SeismicIntensityValue,
  SeismicIntent, SeismicNotificationPayload, SeismicRecentQuake, SeismicTsunamiComment, SeismicUnitCodec, SeismicUnitState,
  SeismicUnitStep, SeismicUnitView, StrongShakingHold,
} from "../../../contracts/p3-seismic-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import {
  EARTHQUAKE_FAMILIES, INFO_RANK, STAGE_LABEL, knownStage, lgRank, parseSeismic, safetyRank, validEventId, validSerial,
} from "../../domains/seismic/seismic";
import type { EarthquakeCandidate, LongPeriodCandidate, SeismicCandidate } from "../../domains/seismic/seismic";

// P3-UNIT-Q-001（C7、I-U-Q）: U-Q の意味・当日履歴・通知・容量・codec・射影。

const SCHEMA = "p3-seismic-unit-v1" as const;
const OPERATIONS = ["normal", "training", "test"] as const;
// P3-C7-CAPACITY=A・P3-C7-RES-01・RET-01〜05。
const EVENT_LIMIT = 512, LONG_PERIOD_LIMIT = 256, GENERATION_LIMIT = 4_194_304;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 131_072;
// I-U-Q.capacityReserve: 取消記憶だけの記録と当日履歴の上限、強震保持の event に残す事実の予算。
const RESERVE_BYTES = 1_357_385, HOLD_FACTS_BYTES = 2_574_775;
const RECENT_LIMIT = 5, COUNTED_LIMIT = 2048;
// P3-C7-SEM-01〜06。
const EVENT_RETAIN_MS = 86_400_000, LONG_PERIOD_RETAIN_MS = 129_600_000, HOLD_MS = 43_200_000, DAY_MS = 86_400_000;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const FAMILY_ORDER: Readonly<Record<EarthquakeFamily, number>> = { VXSE51: 0, VXSE52: 1, VXSE53: 2, VXSE61: 3 };

type Shown = EarthquakeEvent | LongPeriodSubject;
type Level = SeismicNotificationPayload["level"];
type InternalStep = Omit<SeismicUnitStep, "displayChanges" | "confirmationEvidence">;
type Change = readonly [before: Shown | null, after: Shown | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;
type Daily = SeismicUnitState["daily"];

const isEvent = (value: Shown): value is EarthquakeEvent => "contributions" in value;
const eventKey = (operation: Operation, eventId: string): string => `${operation}/earthquake/${eventId}`;
const keyOf = (value: Shown): string => isEvent(value) ? eventKey(value.operation, value.eventId) : value.subject;
const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
const visible = (value: Shown | null): boolean => value != null
  && (isEvent(value) ? value.contributions.some((item) => item.effective === "active") : value.effective === "active");
// 取消記憶だけの記録（P3-C7-CAPACITY の (4)。byte の超過では退去しない）。
const memoryOnly = (value: Shown): boolean => !visible(value);

// ---- byte の加算（I-U-Q.computation。受信 1 回で state 全体を直列化しない） ----

const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
const commas = (length: number) => Math.max(length - 1, 0);
// event は寄与ごとの加算（311 KB の寄与を持つ event の続報で全寄与を直列化し直さない）。
function shownBytes(value: Shown): number {
  if (!isEvent(value)) return bytes(value);
  let size = byteCache.get(value);
  if (size == null) {
    size = bytes({ ...value, contributions: [] }) + commas(value.contributions.length)
      + value.contributions.reduce((sum, item) => sum + bytes(item), 0);
    byteCache.set(value, size);
  }
  return size;
}
const sumCache = new WeakMap<readonly unknown[], number>();
function listBytes<T>(values: readonly T[], size: (value: T) => number): number {
  let total = sumCache.get(values);
  if (total == null) { total = 2 + commas(values.length) + values.reduce((sum, item) => sum + size(item), 0); sumCache.set(values, total); }
  return total;
}
// countedEventIds は追加のたびに前の配列の byte に 1 件分を足す（2048 件を毎回直列化しない）。
function idsBytes(values: readonly string[]): number {
  return listBytes(values, (id) => encoder.encode(JSON.stringify(id)).byteLength);
}
function historyBytes(value: SeismicDailyHistory): number {
  let size = byteCache.get(value);
  if (size == null) {
    size = bytes({ ...value, countedEventIds: [], recent: [] }) - 4 + idsBytes(value.countedEventIds)
      + listBytes(value.recent, bytes);
    byteCache.set(value, size);
  }
  return size;
}
const DAILY_KEYS = encoder.encode(JSON.stringify({ normal: 0, training: 0, test: 0 })).byteLength - 3;
function dailyBytes(daily: Daily): number {
  return DAILY_KEYS + historyBytes(daily.normal) + historyBytes(daily.training) + historyBytes(daily.test);
}
const intentBytes = (values: readonly SeismicIntent[]) => listBytes(values, bytes);
// 配送の更新で pending が伸びうる分の予約（P3-INTENT-UPDATE-RESERVE-001）。listBytes は配列だけで和を cache するので、予約は横で足す。
// 無いと上限ちょうどの pending が更新で伸び、decode が拒否する。
// 世代の計量でもこの別走査のままにする（intentBytes の sumCache は配列だけが鍵で、size 関数を混ぜると前の和が返る）。
function reserve(values: readonly SeismicIntent[]): number {
  return values.reduce((sum, item) => item.disposition === "pending" ? sum + deliveryGrowth(item) : sum, 0);
}
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-Q", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, earthquakes: [], longPeriods: [], daily: {}, intents: [] }, sha256: "0".repeat(64) }).byteLength;
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T と同じ予約）。
function generationBytes(earthquakes: readonly EarthquakeEvent[], longPeriods: readonly LongPeriodSubject[], daily: Daily,
  intents: readonly SeismicIntent[]): number {
  return emptyEnvelopeBytes + 62 - 8 + listBytes(earthquakes, shownBytes) + listBytes(longPeriods, shownBytes)
    + dailyBytes(daily) + intentBytes(intents) + reserve(intents);
}

// 退去できない記録（取消記憶だけの event・長周期と当日履歴）の byte。配列に結び付けて持つ（受信ごとに直列化しない）。
const reserveCache = new WeakMap<readonly Shown[], number>();
function memoryBytes(values: readonly Shown[]): number {
  let total = reserveCache.get(values);
  if (total == null) { total = values.reduce((sum, item) => memoryOnly(item) ? sum + shownBytes(item) : sum, 0); reserveCache.set(values, total); }
  return total;
}
function reservedBytes(earthquakes: readonly EarthquakeEvent[], longPeriods: readonly LongPeriodSubject[], daily: Daily): number {
  return memoryBytes(earthquakes) + memoryBytes(longPeriods) + dailyBytes(daily);
}

// ---- 期限（I-U-Q.deadlines） ----

const deadlineCache = new WeakMap<readonly object[], number>();
function minOf<T extends object>(values: readonly T[], at: (value: T) => number): number {
  let min = deadlineCache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); deadlineCache.set(values, min); }
  return min;
}
const eventDeadline = (value: EarthquakeEvent) => Math.min(value.retainUntil, value.strongHold?.until ?? Infinity);
// JST の暦日。dayKey の次の JST 0 時で当日履歴を空へ戻す（P3-C7-SEM-04）。
const JST_MS = 32_400_000;
function dayKeyOf(ms: number): string {
  return new Date(ms + JST_MS).toISOString().slice(0, 10);
}
function nextMidnight(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00Z`) - JST_MS + DAY_MS;
}
function dailyDeadline(daily: Daily): number {
  return Math.min(...OPERATIONS.map((operation) => { const key = daily[operation].dayKey; return key == null ? Infinity : nextMidnight(key); }));
}
function deadlineAt(state: SeismicUnitState): number {
  return Math.min(minOf(state.earthquakes, eventDeadline), minOf(state.longPeriods, (item) => item.retainUntil),
    dailyDeadline(state.daily), minOf(state.intents, (item) => item.expiresAt));
}
function nextDeadline(state: SeismicUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: SeismicUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

// ---- 公開事実（I-U-Q.earthquakeSemantics・originTime） ----

// active で ReportDateTime が最も新しい寄与（同時刻は order の先）。事実を持たない寄与は数えない。
function newest(event: EarthquakeEvent, order: readonly EarthquakeFamily[], has: (item: EarthquakeContribution) => boolean):
  EarthquakeContribution | null {
  let best: EarthquakeContribution | null = null;
  for (const item of event.contributions) {
    if (item.effective !== "active" || !order.includes(item.family) || !has(item)) continue;
    if (best == null) { best = item; continue; }
    const time = reportMs(item.source) - reportMs(best.source);
    if (time > 0 || time === 0 && order.indexOf(item.family) < order.indexOf(best.family)) best = item;
  }
  return best;
}
function originOf(event: EarthquakeEvent): string | null {
  return newest(event, ["VXSE61", "VXSE53", "VXSE52"], (item) => item.hypocenter?.originTimeRaw != null)?.hypocenter?.originTimeRaw
    ?? newest(event, ["VXSE51"], (item) => item.targetDateTimeRaw != null)?.targetDateTimeRaw ?? null;
}
const factsCache = new WeakMap<EarthquakeEvent, EarthquakeEventView>();
// 公開事実の全部（観測点まで）。事実の変化・強震保持・当日履歴はこれで決める。
function factsOf(event: EarthquakeEvent): EarthquakeEventView {
  let view = factsCache.get(event);
  if (view != null) return view;
  const hypocenter = newest(event, ["VXSE61", "VXSE53", "VXSE52"], (item) => item.hypocenter != null)?.hypocenter ?? null;
  const intensity = newest(event, ["VXSE53", "VXSE51"], (item) => item.intensity != null)?.intensity ?? null;
  // 津波の有無は VXSE52/53 の新しい方、どちらも無いときだけ VXSE51（評価ではない）。VXSE61 からは取らない。
  const comment = newest(event, ["VXSE53", "VXSE52"], () => true) ?? newest(event, ["VXSE51"], () => true);
  const tsunamiFamily = comment?.tsunamiComment == null ? null : comment.family === "VXSE61" ? null : comment.family;
  view = { subject: eventKey(event.operation, event.eventId), eventId: event.eventId, operation: event.operation,
    sources: event.contributions.filter((item) => item.effective === "active").map((item) => item.source),
    originTimeRaw: originOf(event), hypocenter, intensity, tsunamiComment: tsunamiFamily == null ? null : comment?.tsunamiComment ?? null,
    tsunamiCommentFamily: tsunamiFamily, strongHold: event.strongHold };
  factsCache.set(event, view);
  return view;
}
// view には観測点（IntensityStation）を載せない。全件は state の寄与に残す。urgent の owner は入力ごとに U-Q の view を publisher へ
// 複製して送るので、観測点 1,248 点の event が積もると EEW の待ちが 40 ms を超えた（P3-C7-AC12、台帳 63）。
const VIEW_LEVELS: ReadonlySet<SeismicIntensityItem["level"]> = new Set(["pref", "area", "city"]);
const shownIntensity = new WeakMap<SeismicIntensityObservation, SeismicIntensityObservation>();
const viewCache = new WeakMap<EarthquakeEvent, EarthquakeEventView>();
function eventView(event: EarthquakeEvent): EarthquakeEventView {
  let view = viewCache.get(event);
  if (view != null) return view;
  const facts = factsOf(event);
  let intensity = facts.intensity == null ? null : shownIntensity.get(facts.intensity) ?? null;
  if (facts.intensity != null && intensity == null) {
    intensity = { ...facts.intensity, items: facts.intensity.items.filter((item) => VIEW_LEVELS.has(item.level)) };
    shownIntensity.set(facts.intensity, intensity);
  }
  view = { ...facts, intensity };
  viewCache.set(event, view);
  return view;
}
const FACT_FIELDS = ["originTimeRaw", "hypocenter", "intensity", "tsunamiComment", "tsunamiCommentFamily", "strongHold"] as const;
function changedFacts(before: EarthquakeEventView | null, after: EarthquakeEventView): string[] {
  return FACT_FIELDS.filter((field) => !isDeepStrictEqual(before?.[field] ?? null, after[field]))
    .map((field) => field === "tsunamiCommentFamily" ? "tsunamiComment" : field === "originTimeRaw" ? "hypocenter" : field)
    .filter((field, index, list) => list.indexOf(field) === index);
}

// I-U-Q.strongHold（P3-C7-INTENSITY-CARRY=A）: event が導いた全体 MaxInt が既知の段階の 7 になった採用で作り、既知の段階で 7 未満に
// なったとき・震度を持つ active の寄与が無くなったとき・until の到来だけで外れる。新しい報で延ばさず、発生時刻が変わったときだけ計算し直す。
function holdOf(before: StrongShakingHold | null, view: EarthquakeEventView, candidate: EarthquakeCandidate, now: number): StrongShakingHold | null {
  if (view.intensity == null) return null;
  const stage = knownStage(view.intensity.maxInt);
  if (stage != null && stage < 9) return null;
  const origin = view.originTimeRaw;
  if (before != null) {
    if (origin == null || origin === before.originTimeRaw) return before;
    const until = Date.parse(origin) + HOLD_MS;
    return Number.isFinite(until) && until > now ? { ...before, originTimeRaw: origin, until } : null;
  }
  if (stage !== 9 || origin == null) return null;
  const until = Date.parse(origin) + HOLD_MS;
  if (!Number.isFinite(until) || until <= now) return null;
  const { family, reportDateTimeRaw, serialRaw, infoTypeRaw } = candidate.source;
  return { originTimeRaw: origin, until, establishedBy: { family, reportDateTimeRaw, serialRaw, infoTypeRaw } };
}

// ---- 当日履歴（P3-C7-DAILY=A・P3-C7-DAILY-BASIS=B） ----

const EMPTY_HISTORY: SeismicDailyHistory = { dayKey: null, count: 0, maxInt: null, countedEventIds: [], recent: [] };
// 切り詰めでサロゲートの対を割らない（割ると JSON で \uXXXX の 6 byte になり、予約の式の 1 文字 3 byte を超える）。
const cut = (value: string, limit: number) => {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
};
function boundValue(value: MaterialValue): MaterialValue {
  if (value.kind === "missing") return value;
  if (value.kind === "text") return { ...value, value: cut(value.value, 32), raw: cut(value.raw, 32) };
  return { ...value, raw: cut(value.raw, 32) };
}
function boundIntensity(value: SeismicIntensityValue): SeismicIntensityValue {
  return value.kind === "fromTo" ? { kind: "fromTo", from: boundValue(value.from), to: boundValue(value.to) } : boundValue(value);
}
const boundTime = (value: string | null) => value == null || value.length > 40 ? null : value;
// countedEventIds（最大 2048 件）は配列に結び付けた Set で引く（受信ごとに配列を走査しない、I-U-Q.computation）。
const countedCache = new WeakMap<readonly string[], ReadonlySet<string>>();
function countedSet(values: readonly string[]): ReadonlySet<string> {
  let found = countedCache.get(values);
  if (found == null) { found = new Set(values); countedCache.set(values, found); }
  return found;
}

function nextHistory(history: SeismicDailyHistory, candidate: EarthquakeCandidate, after: EarthquakeEvent, now: number): SeismicDailyHistory {
  const today = dayKeyOf(now);
  const base = history.dayKey === today ? history : { ...EMPTY_HISTORY, dayKey: today };
  let next = base;
  // 件数・最大震度は報の全体 MaxInt が既知の段階のときだけ、受信日に数える。取消で減らさない。
  const maxInt = candidate.contribution.intensity?.maxInt;
  const stage = maxInt == null ? null : knownStage(maxInt);
  if (maxInt != null && maxInt.kind !== "fromTo" && stage != null) {
    const counted = countedSet(base.countedEventIds).has(candidate.eventId);
    const higher = base.maxInt == null || stage > (knownStage(base.maxInt) ?? -1);
    if (!counted || higher) {
      let ids = base.countedEventIds;
      if (!counted && ids.length < COUNTED_LIMIT) {
        ids = [...ids, candidate.eventId];
        sumCache.set(ids, idsBytes(base.countedEventIds) + encoder.encode(JSON.stringify(candidate.eventId)).byteLength
          + (base.countedEventIds.length === 0 ? 0 : 1));
      }
      next = { ...base, count: counted ? base.count : base.count + 1, maxInt: higher ? boundValue(maxInt) : base.maxInt, countedEventIds: ids };
    }
  }
  // recent は event の発生日（無ければ報の ReportDateTime）が受信日と同じときだけ、新しい順に 5 行。
  const view = factsOf(after);
  // 発生時刻の文字列は報のまま（日付として読めなければ recent に入れない）。
  const origin = Date.parse(view.originTimeRaw ?? candidate.source.reportDateTimeRaw);
  if (Number.isFinite(origin) && dayKeyOf(origin) === today) {
    const found = next.recent.find((item) => item.eventId === candidate.eventId);
    const active = visible(after);
    if (active || found != null) {
      const row: SeismicRecentQuake = active || found == null ? { eventId: candidate.eventId,
        originTimeRaw: boundTime(view.originTimeRaw), reportDateTimeRaw: boundTime(candidate.source.reportDateTimeRaw),
        hypocenterName: view.hypocenter?.name == null ? null : cut(view.hypocenter.name, 64),
        magnitude: boundValue(view.hypocenter?.magnitude ?? { kind: "missing" }),
        maxInt: boundIntensity(view.intensity?.maxInt ?? { kind: "missing" }), cancelled: !active }
        : { ...found, cancelled: true };
      next = { ...next, recent: [row, ...next.recent.filter((item) => item.eventId !== candidate.eventId)].slice(0, RECENT_LIMIT) };
    }
  }
  // 何も記録しなかった報は当日履歴を変えない（日付の切り替えは期限の入力で行う）。
  return next === base ? history : next;
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
function intensityLabel(value: SeismicIntensityValue, scale: "intensity" | "lg"): string | null {
  const label = (item: MaterialValue): string | null => {
    if (item.kind === "missing" || item.kind === "empty") return null;
    if (item.kind === "unknown") return "不明";
    // 未入電の「5弱以上」は旧築の通知の表記（境界の段階＋以上・以下）に揃える。
    const bound = item.kind === "range" && scale === "intensity" ? safetyRank(item) : null;
    if (item.kind === "range") return `${bound == null ? item.value : STAGE_LABEL[bound]}${item.bound === "lower" ? "以上" : "以下"}`;
    const stage = scale === "intensity" ? knownStage(item) : lgRank(item);
    return stage == null ? item.raw.trim() : scale === "intensity" ? STAGE_LABEL[stage] : String(stage);
  };
  if (value.kind !== "fromTo") return label(value);
  const from = label(value.from), to = label(value.to);
  return from != null && to != null ? `${from}〜${to}` : from ?? to;
}
function magnitudeLabel(value: MaterialValue): string | null {
  if (value.kind === "missing" || value.kind === "empty") return null;
  if (value.kind === "unknown") return "M不明";
  if (value.kind === "range") return `M${value.value}${value.bound === "lower" ? "以上" : "以下"}`;
  return `M${value.kind === "number" ? value.value : value.raw.trim()}`;
}
// P3-C7-NOTICE-LEVELS=A: その報自身の全体 MaxInt（長周期は全体 MaxLgInt）で決める。
function levelOf(candidate: SeismicCandidate): Level {
  if (candidate.cancelled) return "cancel";
  if (candidate.kind === "longPeriod") {
    const rank = candidate.intensity == null ? null : lgRank(candidate.intensity.maxLgInt);
    return rank != null && rank >= 3 ? "critical" : rank != null && rank >= 1 ? "warning" : "normal";
  }
  const maxInt = candidate.contribution.intensity?.maxInt;
  if (maxInt?.kind === "unknown") return "info";
  const rank = maxInt == null ? null : safetyRank(maxInt);
  return rank != null && rank >= 4 ? "warning" : "normal";
}
function payloadOf(candidate: SeismicCandidate): SeismicNotificationPayload {
  const prefix = PREFIX[candidate.operation];
  if (candidate.cancelled) return { domain: "earthquake-eew", level: "cancel", title: `${prefix}[取消] ${candidate.title}`,
    body: "この情報は取り消されました" };
  const hypocenter = candidate.kind === "longPeriod" ? candidate.hypocenter : candidate.contribution.hypocenter;
  const intensity = candidate.kind === "longPeriod" ? candidate.intensity : candidate.contribution.intensity;
  const maxInt = intensity == null ? null : intensityLabel(intensity.maxInt, "intensity");
  const parts = candidate.kind === "longPeriod"
    ? [hypocenter?.name ?? null, intensity == null ? null : intensityLabel(intensity.maxLgInt, "lg"), maxInt]
      .map((part, index) => part == null || index === 0 ? part : `${index === 1 ? "長周期階級" : "最大震度"}${part}`)
    : [hypocenter?.name ?? null, hypocenter == null ? null : magnitudeLabel(hypocenter.magnitude),
      maxInt == null ? null : `最大震度${maxInt}`];
  const joined = parts.filter((part): part is string => part != null && part !== "").join(" / ");
  // 部品が無ければ地震は Headline、それも無ければ Head/Title。長周期は旧築どおり Head/Title に落ちる。
  const body = joined || (candidate.kind === "earthquake" ? candidate.headline : null) || candidate.title;
  const correction = candidate.infoRank === 2;
  return { domain: "earthquake-eew", level: levelOf(candidate), title: prefix + (correction ? `[訂正] ${candidate.title}` : candidate.title),
    body: correction ? `訂正: ${body}` : body };
}
function intentsFor(candidate: SeismicCandidate, transition: SeismicIntent["transition"], generation: number, now: number): SeismicIntent[] {
  // P3-C7-TRAINING=A: training/test は desktop だけ。
  const channels = candidate.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  const payload = payloadOf(candidate);
  return channels.map((channel) => ({ id: `U-Q:${candidate.subject}:${generation}:${channel}`, unit: "U-Q", subject: candidate.subject,
    operation: candidate.operation, source: candidate.source, transition, channel, payload, createdAt: now,
    expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}

// P3-C7-REPLACEMENT=A の系統: 地震の 4 family は一つ、長周期は別。subject は `${operation}/${family}/${eventId}`。
function lineOf(subject: string): string {
  const [operation, family, ...rest] = subject.split("/");
  return `${operation}/${family === "VXSE62" ? "long" : "quake"}/${rest.join("/")}`;
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-Q の intent は全部 other の群（P3-C7-NOTICE-GROUP=A）。
function a7Order(left: SeismicIntent, right: SeismicIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

// Q-NOTICE.capacity と P3-C7-REPLACEMENT=A。新しい intent は同じ系統・channel の pending を、取消は同じ family subject の全 pending を置き換える。
function admit(current: readonly SeismicIntent[], fresh: readonly SeismicIntent[], cancelSubject: string | null):
  Readonly<{ intents: readonly SeismicIntent[]; admitted: readonly SeismicIntent[]; dropped: number }> {
  const superseded = new Set<SeismicIntent>();
  for (const item of current) {
    if (item.disposition !== "pending") continue;
    if (item.subject === cancelSubject || fresh.some((intent) => intent.subject !== cancelSubject
      && lineOf(intent.subject) === lineOf(item.subject) && intent.channel === item.channel)) superseded.add(item);
  }
  // 置換も新しい intent も無ければ元の配列を返す（保存世代を進めない。終端記録の上限は次に intents を変える admit か期限で揃う、
  // P3-FINAL-AC01(5)）。
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
  const out = new Set<SeismicIntent>();
  // 同じ群の中で A7 の選択順の後ろのものから外す。新しい intent が外れることもある（channel ごとに全採用か未採用）。
  const poolReserve = reserve(pool);
  if (pool.length > PENDING_ITEMS || listBytes(pool, bytes) + poolReserve > PENDING_BYTES) {
    let count = pool.length, size = listBytes(pool, bytes) + poolReserve;
    for (const item of [...pool].sort(a7Order).reverse()) {
      if (count <= PENDING_ITEMS && size <= PENDING_BYTES) break;
      out.add(item);
      count--;
      size -= bytes(item) + 1 + deliveryGrowth(item);
    }
  }
  const admitted = fresh.filter((item) => !out.has(item));
  let intents: SeismicIntent[] = [...current.map((item) => superseded.has(item) || out.has(item)
    ? { ...item, disposition: "superseded" as const } : item), ...admitted];
  // I-U-Q.capacityReserve: 終端記録の合計が 131,072 byte を超える分は最古の終端記録から期限前に回収する（未知 id の更新は no-op）。
  let terminal = intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
  if (terminal > TERMINAL_BYTES) {
    const gone = new Set<SeismicIntent>();
    for (const item of intents.filter((value) => value.disposition !== "pending").sort((left, right) => left.createdAt - right.createdAt)) {
      if (terminal <= TERMINAL_BYTES) break;
      gone.add(item);
      terminal -= bytes(item) + 1;
    }
    intents = intents.filter((item) => !gone.has(item));
  }
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- 容量（P3-C7-CAPACITY=A、P3-C7-CAPACITY-BUDGET=A） ----

function latestMs(value: Shown): number {
  return isEvent(value) ? value.contributions.reduce((max, item) => Math.max(max, reportMs(item.source)), -Infinity) : reportMs(value.source);
}
function oldest(left: Shown, right: Shown): number {
  const time = latestMs(left) - latestMs(right);
  if (time !== 0) return time;
  const a = keyOf(left), b = keyOf(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
// 退去の順: (1) retainUntil を過ぎたもの (2) training/test (3) normal の強震保持の無い event と active の長周期（古い順に一つの順）
// (4) 件数の超過だけ: 最古の取消記憶だけの記録 (5) 強震保持の event の事実が予算を超える分だけ。byte の超過では取消記憶を退去しない。
// ponytail: 退去は稀で件数 512・256 に限られる（AGENTS.md の稀な一括処理）。超過の種類ごとに 1 回並べる。
function fit(earthquakes: readonly EarthquakeEvent[], longPeriods: readonly LongPeriodSubject[], daily: Daily,
  intents: readonly SeismicIntent[], target: Shown, now: number):
  Readonly<{ earthquakes: readonly EarthquakeEvent[]; longPeriods: readonly LongPeriodSubject[]; evicted: readonly Shown[] }> | null {
  let events = earthquakes.length, periods = longPeriods.length;
  let size = generationBytes(earthquakes, longPeriods, daily, intents);
  // decode と同じ予約の境界（I-U-Q.capacityReserve）。受理した報の生の文字列が式の仮定を外れても、保存できない state を作らない。
  let reserve = reservedBytes(earthquakes, longPeriods, daily);
  const targetKey = keyOf(target), targetIsEvent = isEvent(target);
  const countOver = () => targetIsEvent ? events > EVENT_LIMIT : periods > LONG_PERIOD_LIMIT;
  const byteOver = () => size > GENERATION_LIMIT;
  if (!countOver() && !byteOver()) return reserve > RESERVE_BYTES ? null : { earthquakes, longPeriods, evicted: [] };
  const holds = earthquakes.filter((item) => item.strongHold != null && item.operation === "normal");
  let holdBytes = holds.reduce((sum, item) => sum + shownBytes(item), 0);
  const evicted = new Set<Shown>();
  const remove = (item: Shown) => {
    evicted.add(item);
    size -= shownBytes(item) + 1;
    if (memoryOnly(item)) reserve -= shownBytes(item);
    if (!isEvent(item)) { periods--; return; }
    events--;
    if (item.strongHold != null && item.operation === "normal") holdBytes -= shownBytes(item);
  };
  const tier = (item: Shown, byBytes: boolean): number | null => {
    // operationContract: training/test の受理で normal を退去させない。
    if (keyOf(item) === targetKey || evicted.has(item) || target.operation !== "normal" && item.operation === "normal") return null;
    if (byBytes && memoryOnly(item)) return null;
    if (item.retainUntil <= now) return 1;
    if (item.operation !== "normal") return 2;
    if (memoryOnly(item)) return 4;
    return isEvent(item) && item.strongHold != null ? 5 : 3;
  };
  const run = (pool: readonly Shown[], over: () => boolean, byBytes: boolean): boolean => {
    if (!over()) return true;
    const ranked = pool.flatMap((item) => {
      const rank = tier(item, byBytes);
      return rank == null ? [] : [{ item, rank }];
    }).sort((left, right) => left.rank - right.rank || oldest(left.item, right.item));
    for (const { item, rank } of ranked) {
      if (!over()) break;
      if (rank === 5 && holdBytes <= HOLD_FACTS_BYTES) break;
      remove(item);
    }
    return !over();
  };
  const ok = run(targetIsEvent ? earthquakes : longPeriods, countOver, false) && run([...earthquakes, ...longPeriods], byteOver, true);
  if (!ok || reserve > RESERVE_BYTES) return null;
  return { earthquakes: earthquakes.filter((item) => !evicted.has(item)), longPeriods: longPeriods.filter((item) => !evicted.has(item)),
    evicted: [...evicted] };
}

// ---- outcome と view ----

function contributionOutcome(event: EarthquakeEvent, item: EarthquakeContribution): SubjectOutcome {
  return { subject: item.source.subject, operation: event.operation, informationType: item.source.infoTypeRaw,
    transition: item.effective, severity: null, source: item.source,
    facts: { eventId: event.eventId, family: item.family, effective: item.effective }, changedFields: [] };
}
function longPeriodOutcome(value: LongPeriodSubject, facts: Readonly<Record<string, JsonValue>> | null = null,
  changedFields: readonly string[] = []): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: facts ?? { eventId: value.eventId, family: "VXSE62", effective: value.effective },
    changedFields };
}
const outcomeCache = new WeakMap<Shown, readonly SubjectOutcome[]>();
function shownOutcomes(value: Shown): readonly SubjectOutcome[] {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = isEvent(value) ? value.contributions.filter((item) => item.effective === "active").map((item) => contributionOutcome(value, item))
      : [longPeriodOutcome(value)];
    outcomeCache.set(value, found);
  }
  return found;
}
function displaySubject(value: Shown): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-Q" }>> {
  return { unit: "U-Q", operation: value.operation, subject: keyOf(value), office: null,
    current: isEvent(value) ? eventView(value) : value, subjects: shownOutcomes(value) };
}

// ---- 採用 ----

// Q-ENUM.revisionOrder（P3-ORDER-AC01）: family ごとに ReportDateTime → InfoType の優先 → Serial（欠落はどの数値よりも小）の辞書順。
function compare(candidate: SeismicCandidate, source: ReportRef): number {
  const time = candidate.reportDateTimeMs - reportMs(source);
  if (time !== 0) return Math.sign(time);
  const rank = candidate.infoRank - (INFO_RANK.get(source.infoTypeRaw.trim()) ?? 0);
  if (rank !== 0) return Math.sign(rank);
  const left = candidate.source.serialRaw.trim(), right = source.serialRaw.trim();
  return left === right ? 0 : left === "" ? -1 : right === "" ? 1 : Math.sign(Number(left) - Number(right));
}
const withoutSource = (value: EarthquakeContribution | LongPeriodSubject) => ({ ...value, source: null });

function unchanged(state: SeismicUnitState, candidate: SeismicCandidate, reason: "duplicate" | "stale",
  diagnostics: readonly DiagnosticDetails[] = []): Result {
  return { changes: [], step: { ...idle(state), decisions: [{ subject: candidate.subject, operation: candidate.operation,
    decision: "unchanged", reason }], diagnostics } };
}
function conflict(state: SeismicUnitState, candidate: SeismicCandidate): Result {
  return unchanged(state, candidate, "stale", [{ level: "WARN", component: "seismic", reason: "seismicRevisionConflict",
    inputId: candidate.source.inputId, unit: "U-Q" }]);
}

const indexCache = new WeakMap<readonly Shown[], ReadonlyMap<string, number>>();
function indexOf(values: readonly Shown[], key: string): number | undefined {
  let index = indexCache.get(values);
  if (index == null) { index = new Map(values.map((item, at) => [keyOf(item), at])); indexCache.set(values, index); }
  return index.get(key);
}
function replaceAt<T>(values: readonly T[], index: number | undefined, value: T): readonly T[] {
  return index == null ? [...values, value] : values.map((item, at) => at === index ? value : item);
}

function receiveEarthquake(state: SeismicUnitState, candidate: EarthquakeCandidate, clock: ClockReading): Result {
  const index = indexOf(state.earthquakes, eventKey(candidate.operation, candidate.eventId));
  const existing = index == null ? null : state.earthquakes[index];
  const prior = existing?.contributions.find((item) => item.family === candidate.family) ?? null;
  if (prior != null) {
    const order = compare(candidate, prior.source);
    if (order < 0) return unchanged(state, candidate, "stale");
    if (order === 0) return isDeepStrictEqual(withoutSource(prior), withoutSource(candidate.contribution))
      ? unchanged(state, candidate, "duplicate") : conflict(state, candidate);
  }
  const now = clock.wallTimeMs;
  const contributions = [...(existing?.contributions ?? []).filter((item) => item.family !== candidate.family), candidate.contribution]
    .sort((left, right) => FAMILY_ORDER[left.family] - FAMILY_ORDER[right.family]);
  const retainUntil = contributions.reduce((max, item) => Math.max(max, reportMs(item.source)), -Infinity) + EVENT_RETAIN_MS;
  const draft: EarthquakeEvent = { eventId: candidate.eventId, operation: candidate.operation, contributions,
    strongHold: existing?.strongHold ?? null, retainUntil };
  const hold = holdOf(existing?.strongHold ?? null, factsOf(draft), candidate, now);
  const next: EarthquakeEvent = hold === draft.strongHold ? draft : { ...draft, strongHold: hold };
  const before = existing == null ? null : factsOf(existing), after = factsOf(next);
  const fields = visible(next) || visible(existing) ? changedFacts(visible(existing) ? before : null, after) : [];
  const wasActive = prior?.effective === "active";
  // 事実の同じ遅着の報（例: VXSE53 の後の古い VXSE51）は revisionOnly。active だった family の取消は事実が同じでも semantic。
  const semantic = fields.length !== 0 || wasActive && candidate.cancelled;
  const due = next.retainUntil <= now;
  // Q-NOTICE.generationTable: 公開事実の変わった採用・訂正・取消の前に active だった family の取消。期限で回収される報では作らない。
  const notify = !due && (candidate.cancelled ? wasActive : candidate.infoRank === 2 || fields.length !== 0);
  const generation = state.persistence.currentGeneration + 1;
  const fresh = notify ? intentsFor(candidate, candidate.cancelled ? "cancelled" : wasActive ? "updated" : "activated", generation, now) : [];
  const history = nextHistory(state.daily[candidate.operation], candidate, next, now);
  const daily = history === state.daily[candidate.operation] ? state.daily : { ...state.daily, [candidate.operation]: history };
  return adopt(state, candidate, clock, { earthquakes: replaceAt(state.earthquakes, index, next), longPeriods: state.longPeriods, daily,
    fresh, semantic, changes: [[existing, next]], target: next,
    outcome: { subject: candidate.subject, operation: candidate.operation, informationType: candidate.source.infoTypeRaw,
      transition: candidate.contribution.effective, severity: null, source: candidate.source, facts: eventView(next), changedFields: fields } });
}

function receiveLongPeriod(state: SeismicUnitState, candidate: LongPeriodCandidate, clock: ClockReading): Result {
  const index = indexOf(state.longPeriods, candidate.subject);
  const existing = index == null ? null : state.longPeriods[index];
  const next: LongPeriodSubject = { subject: candidate.subject, eventId: candidate.eventId, operation: candidate.operation,
    source: candidate.source, effective: candidate.cancelled ? "cancelled" : "active", title: candidate.cancelled ? "" : candidate.title,
    headline: candidate.cancelled ? null : candidate.headline, hypocenter: candidate.hypocenter, intensity: candidate.intensity,
    retainUntil: candidate.reportDateTimeMs + LONG_PERIOD_RETAIN_MS };
  if (existing != null) {
    const order = compare(candidate, existing.source);
    if (order < 0) return unchanged(state, candidate, "stale");
    if (order === 0) return isDeepStrictEqual(withoutSource(existing), withoutSource(next))
      ? unchanged(state, candidate, "duplicate") : conflict(state, candidate);
  }
  const now = clock.wallTimeMs;
  const wasActive = existing?.effective === "active";
  const semantic = existing == null || !isDeepStrictEqual({ ...existing, source: null, retainUntil: 0 }, { ...next, source: null, retainUntil: 0 });
  const due = next.retainUntil <= now;
  const notify = !due && (candidate.cancelled ? wasActive : candidate.infoRank === 2 || semantic);
  const fresh = notify ? intentsFor(candidate, candidate.cancelled ? "cancelled" : wasActive ? "updated" : "activated",
    state.persistence.currentGeneration + 1, now) : [];
  return adopt(state, candidate, clock, { earthquakes: state.earthquakes, longPeriods: replaceAt(state.longPeriods, index, next),
    daily: state.daily, fresh, semantic, changes: [[existing, next]], target: next,
    outcome: longPeriodOutcome(next, next, semantic ? ["longPeriod"] : []) });
}

// 採用の共通部: 通知の収容、容量の退去、保存世代を一回の参照交換で確定する。到着の時点で期限を過ぎた報は同じ reduce で回収する。
function adopt(state: SeismicUnitState, candidate: SeismicCandidate, clock: ClockReading, proposal: Readonly<{
  earthquakes: readonly EarthquakeEvent[]; longPeriods: readonly LongPeriodSubject[]; daily: Daily; fresh: readonly SeismicIntent[];
  semantic: boolean; changes: readonly Change[]; target: Shown; outcome: SubjectOutcome;
}>): Result {
  const notices = admit(state.intents, proposal.fresh, candidate.cancelled ? candidate.subject : null);
  // 到着の時点で期限を過ぎた記録の無い subject の報は配列へ入れない。同じ reduce で回収される記録のために他の記録を退去しない
  // （P3-FINAL-AC01）。before は受信で引いた索引の結果で、記録の有無を引き直さない（P3-FINAL-RES-01）。
  const due = proposal.target.retainUntil <= clock.wallTimeMs;
  const [before] = proposal.changes[0];
  const fresh = due && before == null;
  const fitted = fit(fresh ? state.earthquakes : proposal.earthquakes, fresh ? state.longPeriods : proposal.longPeriods, proposal.daily,
    notices.intents, proposal.target, clock.wallTimeMs);
  const evidence = { family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" as const };
  if (fitted == null) return { changes: [], step: { ...idle(state), decisions: [{ subject: candidate.subject,
    operation: candidate.operation, decision: "capacityExceeded", rejection: evidence }] } };
  // 保存の射影が変わらなければ保存世代を進めない（P3-X-C3、P3-FINAL-AC01(5)）。
  const stored = fitted.earthquakes !== state.earthquakes || fitted.longPeriods !== state.longPeriods || proposal.daily !== state.daily
    || notices.intents !== state.intents;
  const adopted: SeismicUnitState = { ...state, earthquakes: fitted.earthquakes, longPeriods: fitted.longPeriods, daily: proposal.daily,
    intents: notices.intents, persistence: stored ? dirty(state.persistence, clock.monotonicMs) : state.persistence };
  const collected = due ? collect(adopted, clock) : null;
  const next = collected?.state ?? adopted;
  // 結果は回収の後の state で決める（D-OUTCOME=A・D-VANISHED=A、P3-FINAL-AC02）。期限を過ぎた報の記録は最終の state に残らないので
  // accepted に載せず currentEstablished も null、change は前の表示が消えたかで決める。
  const semantic = due ? visible(before) : proposal.semantic;
  const change = semantic || fitted.evicted.length !== 0 ? "semantic" as const : "revisionOnly" as const;
  const diagnostics: DiagnosticDetails[] = [];
  if (fitted.evicted.length !== 0) diagnostics.push({ level: "INFO", component: "seismic", reason: "seismicCapacityEvicted",
    unit: "U-Q", count: fitted.evicted.length });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "seismic", reason: "notificationCapacityEvicted",
    unit: "U-Q", count: notices.dropped });
  return {
    changes: [...fresh ? [] : proposal.changes, ...fitted.evicted.map((item): Change => [item, null]), ...collected?.changes ?? []],
    step: { state: next, nextDeadline: nextDeadline(next),
      decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "changed", reason: null, change,
        currentEstablished: due ? null : evidence }],
      intents: notices.admitted,
      outcomes: [{ kind: "accepted", change, subjects: due ? [] : [proposal.outcome] }],
      diagnostics },
  };
}

// ---- 期限（I-U-Q.deadlines。到来分だけを回収する） ----

function collect(state: SeismicUnitState, clock: ClockReading): Readonly<{ state: SeismicUnitState; changes: readonly Change[];
  expiredIntents: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0 };
  const changes: Change[] = [];
  // ponytail: event 512・長周期 256 の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
  const earthquakes = minOf(state.earthquakes, eventDeadline) > now ? state.earthquakes : state.earthquakes.flatMap((item) => {
    if (item.retainUntil <= now) { changes.push([item, null]); return []; }
    if (item.strongHold == null || item.strongHold.until > now) return [item];
    const after = { ...item, strongHold: null };
    changes.push([item, after]);
    return [after];
  });
  const longPeriods = minOf(state.longPeriods, (item) => item.retainUntil) > now ? state.longPeriods
    : state.longPeriods.filter((item) => {
      if (item.retainUntil > now) return true;
      changes.push([item, null]);
      return false;
    });
  let daily = state.daily;
  for (const operation of OPERATIONS) {
    const key = daily[operation].dayKey;
    if (key != null && nextMidnight(key) <= now) daily = { ...daily, [operation]: EMPTY_HISTORY };
  }
  const intents = minOf(state.intents, (item) => item.expiresAt) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = intents === state.intents ? 0
    : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  return { state: { ...state, earthquakes, longPeriods, daily, intents, persistence: dirty(state.persistence, clock.monotonicMs) },
    changes, expiredIntents };
}

function deadlineStep(state: SeismicUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock);
  const subjects = applied.changes.flatMap(([before, after]) => after == null || !isEvent(after) ? [] : shownOutcomes(after)
    .map((item) => ({ ...item, facts: eventView(after), changedFields: ["strongHold"] })));
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "seismic",
    reason: "notificationExpired", unit: "U-Q", count: applied.expiredIntents }];
  return { changes: applied.changes, step: { ...idle(applied.state),
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects }]
      : subjects.length === 0 ? [] : [{ kind: "deadlineApplied", subjects }],
    diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: SeismicUnitState, input: Extract<SeismicInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changed = new Map<string, SeismicIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changed.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changed.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5 の先例）。
  const next = { ...state, intents: state.intents.map((item) => changed.get(item.id) ?? item),
    persistence: dirty(state.persistence, input.clock.monotonicMs) };
  const adopted = [...changed.values()];
  return { changes: [], step: { ...idle(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation, decision: "changed" as const, reason: null,
      change: "deliveryOnly" as const, currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted" as const, change: "deliveryOnly" as const, subjects: [{ subject: item.subject,
      operation: item.operation, informationType: item.source.infoTypeRaw, transition: item.disposition, severity: null,
      source: item.source, facts: { intentId: item.id, channel: item.channel }, changedFields: ["intents"] }] })) } };
}

function restore(state: SeismicUnitState, persisted: PersistedSeismicUnit, clock: ClockReading): Result {
  const decoded = seismicUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "seismic",
    reason: "requiredStructureInvalid", unit: "U-Q" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。
  const applied = collect({ ...decoded.state, persistence: state.persistence }, clock);
  const shown: Shown[] = [...applied.state.earthquakes, ...applied.state.longPeriods].filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-Q"], coverage: shown.map(keyOf), subjects: [] }],
    diagnostics: applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "seismic", reason: "notificationExpired",
      unit: "U-Q", count: applied.expiredIntents }] } };
}

function receive(state: SeismicUnitState, input: Extract<SeismicInput, { kind: "receive" }>): Result {
  const parsed = parseSeismic(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C7-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  return candidate.kind === "earthquake" ? receiveEarthquake(state, candidate, input.clock) : receiveLongPeriod(state, candidate, input.clock);
}

function reduceCore(state: SeismicUnitState, input: SeismicInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, false);
    case "shutdown": return deadlineStep(state, input.clock, true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`seismic input ${String(missing)} is not handled`); }
  }
}

function reduceSeismicUnit(state: SeismicUnitState, input: SeismicInput): SeismicUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ鍵の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: Shown | null; after: Shown | null }>();
  for (const [before, after] of changes) {
    const key = keyOf((after ?? before)!);
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: SeismicUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-Q", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  // 当日履歴も view の一部なので、表示の変化が無くても内容の版を進める。
  const bump = displayChanges.length !== 0 || step.state.daily !== state.daily;
  if (bump && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-Q content revision exhausted");
  // P3-C7-N2: U-Q は確認 scope を作らない。
  return { ...step, state: bump ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toSeismicView(state: SeismicUnitState): SeismicUnitView {
  const shownEvents = state.earthquakes.filter(visible), longPeriods = state.longPeriods.filter(visible);
  const subjects = [...shownEvents, ...longPeriods].flatMap(shownOutcomes);
  return { unit: "U-Q", semanticRevision: [...subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`), ...OPERATIONS.map((operation) => `${operation}:`
    + `${state.daily[operation].dayKey ?? ""}:${state.daily[operation].count}`)].sort().join("|"),
  contentRevision: String(state.contentRevision), admission: {}, subjects, earthquakes: shownEvents.map(eventView), longPeriods,
  daily: state.daily };
}

// ---- codec（I-U-Q.persisted・I-U-Q.decode、唯一の SeismicUnitCodec） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
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
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const familyOf = (value: unknown): EarthquakeFamily | null => EARTHQUAKE_FAMILIES.find((item) => item === value) ?? null;
// subject は `${operation}/${family}/${eventId}`（Q-ENUM.identity の EventID）。
function subjectParts(subject: string): Readonly<{ operation: Operation; family: string; eventId: string }> | null {
  const [operation, family, eventId, ...rest] = subject.split("/");
  const op = operationOf(operation);
  return op == null || rest.length !== 0 || eventId == null || !validEventId(eventId) || (familyOf(family) == null && family !== "VXSE62")
    ? null : { operation: op, family, eventId };
}
function reportRef(value: unknown): ReportRef | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !isText(row.inputId) || !isText(row.family) || !isText(row.subject)
    || !isText(row.reportDateTimeRaw) || row.reportDateTimeRaw.length > 25 || !Number.isFinite(Date.parse(row.reportDateTimeRaw))
    || !isText(row.serialRaw) || !validSerial(row.serialRaw) || !isText(row.infoTypeRaw) || !INFO_RANK.has(row.infoTypeRaw)
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  const parts = subjectParts(row.subject);
  if (parts == null || parts.operation !== operation || parts.family !== row.family) return null;
  return { inputId: row.inputId, origin: row.origin, operation, family: row.family, subject: row.subject,
    reportDateTimeRaw: row.reportDateTimeRaw, serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
}
function materialValue(value: unknown): MaterialValue | null {
  const row = record(value);
  if (row == null) return null;
  if (row.kind === "missing") return { kind: "missing" };
  if ((row.kind === "empty" || row.kind === "unknown") && isText(row.raw)) return { kind: row.kind, raw: row.raw };
  if (row.kind === "text" && isText(row.raw) && isText(row.value)) return { kind: "text", value: row.value, raw: row.raw };
  if (row.kind === "number" && isText(row.raw) && finite(row.value)) return { kind: "number", value: row.value, raw: row.raw };
  if (row.kind === "range" && isText(row.raw) && finite(row.value) && (row.bound === "lower" || row.bound === "upper"))
    return { kind: "range", bound: row.bound, value: row.value, raw: row.raw };
  return null;
}
function intensityValue(value: unknown): SeismicIntensityValue | null {
  const row = record(value);
  if (row?.kind !== "fromTo") return materialValue(value);
  const from = materialValue(row.from), to = materialValue(row.to);
  return from == null || to == null ? null : { kind: "fromTo", from, to };
}
function hypocenter(value: unknown): SeismicHypocenter | null | "invalid" {
  if (value === null) return null;
  const row = record(value);
  const latitude = materialValue(row?.latitude), longitude = materialValue(row?.longitude), depthKm = materialValue(row?.depthKm);
  const magnitude = materialValue(row?.magnitude);
  if (row == null || latitude == null || longitude == null || depthKm == null || magnitude == null || typeof row.depthConflict !== "boolean"
    || !textOrNull(row.originTimeRaw) || !textOrNull(row.arrivalTimeRaw) || !textOrNull(row.name) || !textOrNull(row.code)
    || !textOrNull(row.coordinateRaw) || !textOrNull(row.magnitudeType) || !textOrNull(row.magnitudeCondition)
    || !textOrNull(row.magnitudeDescription)) return "invalid";
  return { originTimeRaw: row.originTimeRaw, arrivalTimeRaw: row.arrivalTimeRaw, name: row.name, code: row.code,
    coordinateRaw: row.coordinateRaw, latitude, longitude, depthKm, depthConflict: row.depthConflict, magnitude,
    magnitudeType: row.magnitudeType, magnitudeCondition: row.magnitudeCondition, magnitudeDescription: row.magnitudeDescription };
}
function item(value: unknown): SeismicIntensityItem | null {
  const row = record(value);
  const level = (["pref", "area", "city", "station"] as const).find((entry) => entry === row?.level);
  const maxInt = intensityValue(row?.maxInt), maxLgInt = intensityValue(row?.maxLgInt);
  if (row == null || level == null || maxInt == null || maxLgInt == null || !textOrNull(row.code) || !isText(row.name)
    || !textOrNull(row.parentCode)) return null;
  return { level, code: row.code, name: row.name, parentCode: row.parentCode, maxInt, maxLgInt };
}
function observation(value: unknown): SeismicIntensityObservation | null | "invalid" {
  if (value === null) return null;
  const row = record(value);
  const maxInt = intensityValue(row?.maxInt), maxLgInt = intensityValue(row?.maxLgInt), items = list(row?.items, item);
  if (row == null || maxInt == null || maxLgInt == null || items == null || !textOrNull(row.lgCategory)) return "invalid";
  // Q-ENUM.invalid: 同じ階層の code の重複は採用しない。
  for (const level of ["pref", "area", "city", "station"] as const)
    if (!unique(items.flatMap((entry) => entry.level === level && entry.code != null ? [entry.code] : []))) return "invalid";
  return { maxInt, maxLgInt, lgCategory: row.lgCategory, items };
}
function tsunamiComment(value: unknown): SeismicTsunamiComment | null | "invalid" {
  if (value === null) return null;
  const row = record(value);
  const codes = list(row?.codes, (entry) => isText(entry) ? entry : null);
  return row == null || codes == null || !textOrNull(row.text) ? "invalid" : { codes, text: row.text };
}
function contribution(value: unknown): EarthquakeContribution | null {
  const row = record(value);
  const family = familyOf(row?.family), source = reportRef(row?.source);
  const effective = row?.effective === "active" || row?.effective === "cancelled" ? row.effective : null;
  const facts = { hypocenter: hypocenter(row?.hypocenter), intensity: observation(row?.intensity), comment: tsunamiComment(row?.tsunamiComment) };
  if (row == null || family == null || source == null || effective == null || source.family !== family
    || facts.hypocenter === "invalid" || facts.intensity === "invalid" || facts.comment === "invalid"
    || !textOrNull(row.targetDateTimeRaw) || !isText(row.title) || !textOrNull(row.headline)) return null;
  // cancelled は事実を持たず title は空文字（取消記憶の byte 上限、I-U-Q.decode）。
  if (effective === "cancelled" && (row.title !== "" || row.headline !== null || row.targetDateTimeRaw !== null
    || facts.hypocenter != null || facts.intensity != null || facts.comment != null)) return null;
  return { family, source, effective, targetDateTimeRaw: row.targetDateTimeRaw, title: row.title, headline: row.headline,
    hypocenter: facts.hypocenter, intensity: facts.intensity, tsunamiComment: facts.comment };
}
function strongHold(value: unknown): StrongShakingHold | null | "invalid" {
  if (value === null) return null;
  const row = record(value), by = record(row?.establishedBy);
  if (row == null || by == null || !isText(row.originTimeRaw) || !finite(row.until)
    || row.until !== Date.parse(row.originTimeRaw) + HOLD_MS || familyOf(by.family) == null || !isText(by.family)
    || !isText(by.reportDateTimeRaw) || !isText(by.serialRaw) || !isText(by.infoTypeRaw)) return "invalid";
  return { originTimeRaw: row.originTimeRaw, until: row.until, establishedBy: { family: by.family,
    reportDateTimeRaw: by.reportDateTimeRaw, serialRaw: by.serialRaw, infoTypeRaw: by.infoTypeRaw } };
}
function event(value: unknown): EarthquakeEvent | null {
  const row = record(value);
  const operation = operationOf(row?.operation), contributions = list(row?.contributions, contribution), hold = strongHold(row?.strongHold);
  if (row == null || operation == null || contributions == null || contributions.length === 0 || hold === "invalid"
    // EventID の形は寄与の subject（reportRef の subjectParts）で確かめる。
    || !isText(row.eventId) || !finite(row.retainUntil)
    || !unique(contributions.map((entry) => entry.family))
    || contributions.some((entry) => entry.source.subject !== `${operation}/${entry.family}/${row.eventId}`)) return null;
  return { eventId: row.eventId, operation, contributions, strongHold: hold, retainUntil: row.retainUntil };
}
function longPeriod(value: unknown): LongPeriodSubject | null {
  const row = record(value);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const effective = row?.effective === "active" || row?.effective === "cancelled" ? row.effective : null;
  const facts = { hypocenter: hypocenter(row?.hypocenter), intensity: observation(row?.intensity) };
  if (row == null || operation == null || source == null || effective == null || facts.hypocenter === "invalid"
    || facts.intensity === "invalid" || !isText(row.eventId)
    || row.subject !== `${operation}/VXSE62/${row.eventId}` || source.subject !== row.subject || !isText(row.title)
    || !textOrNull(row.headline) || !finite(row.retainUntil)) return null;
  if (effective === "cancelled" && (row.title !== "" || row.headline !== null || facts.hypocenter != null || facts.intensity != null))
    return null;
  return { subject: row.subject, eventId: row.eventId, operation, source, effective, title: row.title, headline: row.headline,
    hypocenter: facts.hypocenter, intensity: facts.intensity, retainUntil: row.retainUntil };
}
// 当日履歴の文字列の上限（SeismicRecentQuake の注記）。
function boundedValue(value: MaterialValue): boolean {
  return value.kind === "missing" || value.raw.length <= 32 && (value.kind !== "text" || value.value.length <= 32);
}
function recent(value: unknown): SeismicRecentQuake | null {
  const row = record(value);
  const magnitude = materialValue(row?.magnitude), maxInt = intensityValue(row?.maxInt);
  if (row == null || magnitude == null || maxInt == null || !isText(row.eventId) || !validEventId(row.eventId)
    || !textOrNull(row.originTimeRaw) || !textOrNull(row.reportDateTimeRaw) || !textOrNull(row.hypocenterName)
    || typeof row.cancelled !== "boolean" || (row.originTimeRaw?.length ?? 0) > 40 || (row.reportDateTimeRaw?.length ?? 0) > 40
    || (row.hypocenterName?.length ?? 0) > 64 || !boundedValue(magnitude)
    || !(maxInt.kind === "fromTo" ? boundedValue(maxInt.from) && boundedValue(maxInt.to) : boundedValue(maxInt))) return null;
  return { eventId: row.eventId, originTimeRaw: row.originTimeRaw, reportDateTimeRaw: row.reportDateTimeRaw,
    hypocenterName: row.hypocenterName, magnitude, maxInt, cancelled: row.cancelled };
}
function history(value: unknown): SeismicDailyHistory | null {
  const row = record(value);
  const ids = list(row?.countedEventIds, (entry) => isText(entry) && validEventId(entry) ? entry : null);
  const rows = list(row?.recent, recent);
  const maxInt = row?.maxInt === null ? null : materialValue(row?.maxInt);
  if (row == null || ids == null || rows == null || (row.maxInt !== null && (maxInt == null || !boundedValue(maxInt)))
    || !Number.isSafeInteger(row.count) || Number(row.count) < 0 || rows.length > RECENT_LIMIT || ids.length > COUNTED_LIMIT
    || !unique(ids) || !(row.dayKey === null || isText(row.dayKey) && /^\d{4}-\d{2}-\d{2}$/.test(row.dayKey)
      && Number.isFinite(nextMidnight(row.dayKey)))) return null;
  return { dayKey: row.dayKey, count: Number(row.count), maxInt, countedEventIds: ids, recent: rows };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intent(value: unknown): SeismicIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation), source = reportRef(row?.source);
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（容量退去の直後の再起動を unavailable にしない、I-U-Q.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-Q" || !isText(row.subject)
    || subjectParts(row.subject)?.operation !== operation || source.subject !== row.subject
    || payload.domain !== "earthquake-eew" || !isText(payload.title) || payload.title === "" || !isText(payload.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !Number.isSafeInteger(row.attempts)
    || Number(row.attempts) < 0 || !isText(row.configRevision) || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-Q", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "earthquake-eew", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition };
}
function persisted(value: unknown): PersistedSeismicUnit | null {
  const row = record(value), days = record(row?.daily);
  if (row == null || days == null || row.schemaVersion !== SCHEMA) return null;
  const earthquakes = list(row.earthquakes, event), longPeriods = list(row.longPeriods, longPeriod), intents = list(row.intents, intent);
  const normal = history(days.normal), training = history(days.training), test = history(days.test);
  if (earthquakes == null || longPeriods == null || intents == null || normal == null || training == null || test == null
    || earthquakes.length > EVENT_LIMIT || longPeriods.length > LONG_PERIOD_LIMIT
    || !unique(earthquakes.map((entry) => eventKey(entry.operation, entry.eventId))) || !unique(longPeriods.map((entry) => entry.subject))
    || !unique(intents.map((entry) => entry.id))) return null;
  const daily = { normal, training, test };
  const pending = intents.filter((entry) => entry.disposition === "pending");
  if (pending.length > PENDING_ITEMS || listBytes(pending, bytes) + reserve(pending) > PENDING_BYTES || reservedBytes(earthquakes, longPeriods, daily) > RESERVE_BYTES
    || generationBytes(earthquakes, longPeriods, daily, intents) > GENERATION_LIMIT) return null;
  return { schemaVersion: SCHEMA, earthquakes, longPeriods, daily, intents };
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const emptyDaily: Daily = { normal: EMPTY_HISTORY, training: EMPTY_HISTORY, test: EMPTY_HISTORY };
const seismicUnitCodec: SeismicUnitCodec = {
  schemaVersion: SCHEMA,
  // state は reducer が上限の内側で作るので、encode は保存 field だけを並べる（contentRevision・persistence は保存しない）。
  encode: (state) => ({ schemaVersion: SCHEMA, earthquakes: state.earthquakes, longPeriods: state.longPeriods, daily: state.daily,
    intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-seismic-unit-v1 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-Q.runtimeRows）。
const seismicUnit = {
  unit: "U-Q",
  reduce: reduceSeismicUnit,
  toView: toSeismicView,
  persistence: { kind: "durable", codec: seismicUnitCodec },
  confirmationScopeLimit: 512,
  withoutNormal: (state) => ({ ...state, earthquakes: state.earthquakes.filter((item) => item.operation !== "normal"),
    longPeriods: state.longPeriods.filter((item) => item.operation !== "normal"), daily: { ...state.daily, normal: EMPTY_HISTORY } }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => [...state.earthquakes, ...state.longPeriods]
    .filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-Q">;

export { emptyDaily, reduceSeismicUnit, seismicUnit, seismicUnitCodec, toSeismicView };
