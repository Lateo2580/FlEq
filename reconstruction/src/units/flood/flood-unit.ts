import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline,
  SubjectOutcome, UnreadableMark, WallBasis,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  FloodCriteria, FloodCurrent, FloodInput, FloodIntent, FloodKindGroup, FloodNotificationPayload, FloodRiver, FloodStation, FloodUnitCodec,
  FloodUnitState, FloodUnitStep, FloodUnitView, FloodUnreadableSite, PersistedFloodUnit,
} from "../../../contracts/p3-flood-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { INPUT_ID_LIMIT, readReportRef, stepVersion } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth"; import { bounded, count, finite, isText, list, operationOf, record } from "../codec-base";
import {
  BOUNDS, LIMITS, cut, infoRankOf, levelOf, loneSurrogate, parseFlood, validEventId, validHeadType, validKindCode, validName,
  validReportDateTime, validRiverCode, validSerial, validStationCode, validTime, validValue,
} from "../../domains/flood/flood";
import type { FloodCandidate } from "../../domains/flood/flood";
import {
  applyIntentUpdate, cancelText, freshState, heard, markNotice, noticeId, noticeKind, noticed, raiseEvidence, readIntentState, readNoticeMark, recoveredPayload, restoreStarted,
  shown, updateEvidence, versionDigest,
} from "../notice-mark";
import { cachedMin } from "../expiry";
import {
  RAW_BUDGET, UNREAD_TEXT, droppedIn, fitRawBudget, inheritMark, hasPart, rawTotal, readUnreadableMark, stripAll,
  unreadableMarkBytes,
} from "../unreadable";

// P3-UNIT-R-001（C11、I-U-R）: U-R の EventID の current・通知・容量・codec・射影。

const SCHEMA = "p3-flood-unit-v9" as const;
// P3-C11-CAPACITY=A・P3-C11-RES-01（P3-C11-BOUNDS=B）・RET-01〜04。
const CURRENT_LIMIT = 512;
// P3-VM-AC08（作者裁定 2026-10-21 夜）: 器は 16 MiB に、全記録が読み戻しの上限いっぱいの未確認の印を持つ最悪の場合の分を足す（印の無い上界は
// Control/DateTime を含めて 16 MiB の内側）。印 1 つは InfoType の raw が trim で消える U+000B の 6 文字（JSON で 6 byte ずつ）と EventID の「\」40 文字。
// P3-UM-RES-09: 読めない所の印・原文の予算・カードの分も足す。
// 最初の使用で計算する: owner-runtime が H27 の recoveryNotices のために本 module を読むので、domains/flood → shared-runtime → owner-runtime → 本 module
// の循環では LIMITS がまだ無い（無いと landslide-unit や domains/flood から読み始めたときに読み込みで落ちる）。
let generationLimit: number | undefined;
function generationLimitOf(): number {
  if (generationLimit != null) return generationLimit;
  const longest: ReportRef = { inputId: "i".repeat(INPUT_ID_LIMIT), origin: "recovery", operation: "training", family: "VXKO50",
    subject: `training/VXKO50/${"\\".repeat(LIMITS.eventId)}`, reportDateTimeRaw: "0".repeat(LIMITS.reportDateTime),
    controlDateTimeRaw: "0".repeat(LIMITS.controlDateTime), serialRaw: "9".repeat(10), infoTypeRaw: `${"\v".repeat(LIMITS.infoType - 2)}発表` };
  const markGrowth = CURRENT_LIMIT * new TextEncoder().encode(`,"unconfirmed":${JSON.stringify(longest)}`).byteLength;
  return generationLimit = 16_777_216 + markGrowth + CURRENT_LIMIT * unreadableMarkBytes("unreadable") + RAW_BUDGET + UNREADABLE_CARDS_MAX_BYTES;
}
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C11-SEM-01・02（元報の ReportDateTime からの絶対の長さ、P3-C11-RETENTION=A・P3-C11-ACTIVE-EXPIRY=D）。
const RETAIN_MS = 129_600_000, EXPIRED_RETAIN_MS = 151_200_000; // 記憶は表示の期限＋6 時間（P3-EF-D-EXPIRED-MEMORY=A）
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;

type Active = Extract<FloodCurrent, Readonly<{ effective: "active" }>>;
type Level = FloodNotificationPayload["level"];
type InternalStep = Omit<FloodUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = FloodUnitStep["decisions"][number];
type Change = readonly [before: FloodCurrent | null, after: FloodCurrent | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// P3-UM-AC03 (3): 原文を外す順は source の ReportDateTime の古い順（同じなら subject の順）。
const rawKey = (item: FloodCurrent): readonly [number, string] => [reportMs(item.source), item.subject];
// 保留の印のある active は見えない記録として扱う（P3-EF-AC02 (2)）。
const visible = (value: FloodCurrent | null): value is Active => value?.effective === "active" && value.expiryPending !== true;

// ---- byte の加算（I-U-R.computation。受信 1 回で state 全体を直列化しない） ----

const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
const commas = (length: number) => Math.max(length - 1, 0);
const listBytes = (values: readonly object[]): number => 2 + commas(values.length) + values.reduce((sum, item) => sum + bytes(item), 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-R", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, currents: [], intents: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7)・P3-UM-AC11 (10): envelope の inputBoundary・losses・カードの最大（器からは引かない）
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-L ほかと同じ予約）。4: 空の配列 2 つ。
function generationBytes(value: PersistedFloodUnit): number {
  return emptyEnvelopeBytes + 62 - 4 + listBytes(value.currents) + listBytes(value.intents);
}

// ---- 期限（I-U-R.deadlines） ----

// P3-EF-AC11 (2): 根拠で当てない種類を比べないよう、表示の期限・回収の期限・保留の記録・intent の期限を別々に持つ。nextDeadline は
// 根拠によらず全部の最小（保留の記録は元の表示の期限）。
const displayMin = cachedMin<FloodCurrent>((item) => visible(item) ? item.retainUntil : Infinity);
const recallMin = cachedMin<FloodCurrent>((item) => item.effective !== "active" ? item.retainUntil : Infinity);
const pendingMin = cachedMin<FloodCurrent>((item) => item.effective === "active" && item.expiryPending === true ? item.retainUntil : Infinity);
const retainMin = cachedMin<FloodCurrent>((item) => item.retainUntil);
const intentMin = cachedMin<FloodIntent>((item) => item.expiresAt);
const deadlineAt = (state: FloodUnitState): number => Math.min(retainMin(state.currents), intentMin(state.intents));
function nextDeadline(state: FloodUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state);
  return at === Infinity ? null : { wallTimeMs: at, monotonicMs: null };
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: FloodUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}

// ---- 索引（配列に結び付けた Map。受信ごとに配列を探し直さない、I-U-R.computation） ----

const indexCache = new WeakMap<readonly FloodCurrent[], ReadonlyMap<string, number>>();
function indexOf(values: readonly FloodCurrent[], subject: string): number | undefined {
  let index = indexCache.get(values);
  if (index == null) { index = new Map(values.map((item, at) => [item.subject, at])); indexCache.set(values, index); }
  return index.get(subject);
}
function replaceAt<T>(values: readonly T[], index: number | undefined, value: T): readonly T[] {
  return index == null ? [...values, value] : values.map((item, at) => at === index ? value : item);
}

// P3-C11-CAPACITY=A と P3-OPCAP-AC01: 513 件目は (1) retainUntil を過ぎた記録 (2) inactive (3) training/test (4) normal の active、それぞれ
// ReportDateTime の古い順で退去する。受ける報が training/test なら normal の記録は (1)〜(4) とも候補にせず、候補が無ければ null
// （受けた記録自身を退去する）。
// ponytail: 満杯の 512 件の素朴な線形の走査（上限は CURRENT_LIMIT で、保持と decode の両方で効く。台帳 47 の例外）。
// 第 1 段は受けた入力の根拠が verified のときだけ。保留の印のある記録は見えない記録の段に入る（P3-EF-AC03）。
function evictOne(values: readonly FloodCurrent[], now: number, incoming: Operation, verified: boolean): FloodCurrent | null {
  const tier = (item: FloodCurrent) => verified && item.retainUntil <= now ? 0 : !visible(item) ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: FloodCurrent | null = null;
  for (const item of values) {
    if (item.operation === "normal" && incoming !== "normal") continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || reportMs(item.source) - reportMs(worst.source)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// P3-VM-AC03: EventID ごとに compareVersion で比べる（報番号・InfoType の順位は使わない）。同じ版の中身には InfoType を含める。
// held は手元の版を残して印を付ける報（印は保存の byte に入るが、上界が器の内側なので fit を要さない、P3-VM-AC08）。
function judge(existing: FloodCurrent | null, built: FloodCurrent, candidate: FloodCandidate) {
  return stepVersion(existing == null ? null : { version: existing.source, source: existing.source, cancelled: existing.effective === "cancelled" },
    existing?.unconfirmed ?? null, candidate.source, () => existing != null && existing.source.infoTypeRaw.trim() === candidate.source.infoTypeRaw.trim()
    // 期限切れの記憶は事実を持たないので InfoType だけで見る（Q-EF-PRECHECK (0)(b)、U-M と同じ）。
    && (existing.effective === "expired" || changed(existing, built, FACTS).length === 0), candidate.cancelled);
}

// ---- EventID の current（I-U-R.currentSemantics） ----

// 同じ版の重複の判定は公開事実、semantic の判定はそれに basisReportDateTimeRaw を足す（Q-ENUM.revisionOrder・currentSemantics(4)）。
const FACTS = ["effective", "title", "areaName", "kinds", "times", "stations"] as const;
const FIELDS = [...FACTS, "basisReportDateTimeRaw"] as const;
function changed(before: FloodCurrent | null, after: FloodCurrent, fields: readonly string[] = FIELDS): string[] {
  const read = (value: FloodCurrent | null, field: string): unknown => value == null ? null
    : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  return fields.filter((field) => !isDeepStrictEqual(read(before, field), read(after, field)));
}
// 事実を引き継ぐ版の印: 引き継ぐ事実の part（serial 以外）と原文・旗を前の印から保ち、この報の part（serial と、kinds が空になった訳の
// kindName などの全部）を後ろに足す（r1 ヘルツ P2-1: 新しい報の印の null で観測所の印が消えた）。
function keptMark(previous: UnreadableMark | undefined, incoming: UnreadableMark | null): Readonly<{ unreadable?: UnreadableMark }> {
  const unreadable = previous == null ? incoming ?? undefined
    : inheritMark(previous, previous.parts.filter((part) => part.site !== "serial"), incoming);
  return unreadable == null ? {} : { unreadable };
}
function currentOf(candidate: FloodCandidate, existing: FloodCurrent | null): FloodCurrent {
  const base = { subject: candidate.subject, operation: candidate.operation, headType: candidate.headType, eventId: candidate.eventId,
    source: candidate.source, retainUntil: candidate.reportDateTimeMs + RETAIN_MS };
  if (candidate.cancelled) return { ...base, effective: "cancelled" };
  // P3-C11-UNKNOWN=A: 河川の段階を読めない報は active の記録の事実を保ち、事実を出した報の時刻を basis に持つ。
  if (candidate.kinds.length === 0 && visible(existing))
    return { ...base, effective: "active", title: existing.title, areaName: existing.areaName, kinds: existing.kinds, times: existing.times,
      stations: existing.stations, basisReportDateTimeRaw: existing.basisReportDateTimeRaw ?? existing.source.reportDateTimeRaw,
      truncated: existing.truncated, ...keptMark(existing.unreadable, candidate.unreadable),
      ...existing.observedCompare == null ? {} : { observedCompare: existing.observedCompare } };
  // P3-C11-ACTIVE-LEVEL=A: level が 0 でない group（表に無い code を含む）が 1 つでもあれば active、全部 0 なら ended。
  if (candidate.kinds.length !== 0 && candidate.kinds.every((group) => group.level === 0)) return { ...base, effective: "ended" };
  // P3-UM-AC05 (1): 現況の観測レベルの最大を確定できない版は、比べの観測の最大を前の記録の値以上に保つ。
  const observed = candidate.stations.reduce((max, station) => Math.max(max, station.levels[0] ?? -1), -1);
  return { ...base, effective: "active", title: candidate.title, areaName: candidate.areaName, kinds: candidate.kinds, times: candidate.times,
    stations: candidate.stations, basisReportDateTimeRaw: null, truncated: candidate.truncated,
    ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable },
    ...candidate.observedUnknown ? { observedCompare: Math.max(observed, visible(existing) ? compareMax(existing) : -1) } : {} };
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// P3-C11-NOTICE-LEVELS=E（作者裁定）: 表に無い code（null）は warning で、上がったかの比較ではレベル 3 と同じ順位。
const SOUND: ReadonlyMap<number | null, Level> = new Map([[5, "critical"], [4, "warning"],
  [3, "warning"], [2, "normal"], [null, "warning"]]);
const LEVEL_ORDER: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
const louder = (left: Level | null, right: Level | null): Level | null =>
  left == null || right != null && LEVEL_ORDER.indexOf(right) > LEVEL_ORDER.indexOf(left) ? right : left;
const rankOf = (level: FloodKindGroup["level"]): number => level ?? 3;
// 河川ごとの段階。rivers が空の group は group の code を 1 つの河川として数える（Q-NOTICE.level）。
function riverLevels(value: Active): Map<string, FloodKindGroup["level"]> {
  const levels = new Map<string, FloodKindGroup["level"]>();
  for (const group of value.kinds)
    if (group.rivers.length === 0) levels.set(`#${group.code}`, group.level);
    else for (const river of group.rivers) levels.set(river.code, group.level);
  return levels;
}
const observedMax = (value: Active): number => value.stations.reduce((max, station) => Math.max(max, station.levels[0] ?? -1), -1);
// 上昇の比べの相手（AC05 (2)）。
const compareMax = (value: Active): number => value.observedCompare ?? observedMax(value);
// 採用前の記録と比べた機会と段階（P3-C11-NOTICE-LEVELS=E）。changed は河川の段階が変わったか観測の最大が 2 以上へ上がったか。
// raised は上がった段（無ければ null）で、取り直しの H27 が live と同じ段で比べるために使う（P3-REC-D-N2-RAISE-4B=A）。
function noticeOf(before: FloodCurrent | null, after: Active): Readonly<{ changed: boolean; level: Level; raised: Level | null }> {
  if (after.kinds.length === 0) return visible(before) ? { changed: false, level: "normal", raised: null } : { changed: true, level: "warning", raised: "warning" };
  const previous = visible(before) ? riverLevels(before) : new Map<string, FloodKindGroup["level"]>();
  const current = riverLevels(after);
  let rivers = previous.size !== current.size;
  let level: Level | null = null;
  for (const [code, value] of current) {
    const old = previous.get(code);
    if (old !== value) rivers = true;
    if (value !== 0 && (old === undefined ? -Infinity : rankOf(old)) < rankOf(value)) level = louder(level, SOUND.get(value) ?? "warning");
  }
  const observed = observedMax(after);
  if (observed >= 2 && observed > (visible(before) ? compareMax(before) : -1)) level = louder(level, SOUND.get(observed) ?? null);
  return { changed: rivers || level != null, level: level ?? "normal", raised: level };
}
// group ごとの種別名と河川名（P3-UM-AC07: 読めなかった名前〔空〕は「（読めず）」。記録の値は空のまま）。
function riversText(value: Active): string {
  const named = (text: string, site: "kindName" | "riverName") => text === "" && hasPart(value.unreadable, site) ? UNREAD_TEXT : text;
  return value.kinds.map((group) => [named(group.name, "kindName"), group.rivers.map((river) => named(river.name, "riverName"))
    .join("・")].filter((part) => part !== "").join(" ")).join(" / ");
}
// 題は operationPrefix＋訂正・取消の前置き＋Head/Title。本文は Headline、無ければ group ごとの河川名、それも無ければ題。
// 取消は取り消した記録の ReportDateTime（cancelledAt）を書く（P3-NL-AC10）。
function payloadOf(candidate: FloodCandidate, after: FloodCurrent, level: Level, cancelledAt: string | null = null): FloodNotificationPayload {
  const prefix = PREFIX[candidate.operation];
  if (candidate.cancelled) {
    const text = cancelText(candidate.title, cancelledAt);
    return { domain: "weather", level: "cancel", title: cut(prefix + text.title, NOTICE_BOUNDS.title), body: cut(text.body, NOTICE_BOUNDS.body) };
  }
  const correction = candidate.infoRank === 2;
  const groups = visible(after) ? riversText(after) : "";
  const body = candidate.headline ?? (groups !== "" ? groups : candidate.title);
  return { domain: "weather", level, title: cut(prefix + (correction ? `[訂正] ${candidate.title}` : candidate.title), NOTICE_BOUNDS.title),
    body: cut(correction ? `訂正: ${body}` : body, NOTICE_BOUNDS.body) };
}
// P3-NL-AC01: ID は世代番号を含まない。EventID の系列の印に同じ版の鍵と種類があれば作らない（期限の通知は元の報の版から出る）。
function intentsFor(source: Readonly<{ subject: string; operation: Operation; source: ReportRef }>, transition: FloodIntent["transition"],
  payload: FloodNotificationPayload, now: number, channels: readonly ("desktop" | "sound")[], mark: NoticeMark | undefined,
  version: string): FloodIntent[] {
  if (noticed(mark, version, noticeKind(transition))) return [];
  return channels.map((channel) => ({ id: noticeId("U-R", source.subject, "", source.source, transition, channel), unit: "U-R",
    subject: source.subject, operation: source.operation, source: source.source, transition, channel, payload, createdAt: now,
    expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending",
    ...freshState("U-R", source.operation) }));
}
// P3-C11-TRAINING=A: training/test は desktop だけ。
const channelsOf = (operation: Operation) => operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
// A7 の選択順（期限 → 生成時刻 → ID）。U-R の intent は全部 other の群（P3-C11-NOTICE-GROUP=A）。
function a7Order(left: FloodIntent, right: FloodIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// Q-NOTICE.capacity と P3-C11-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
function admit(current: readonly FloodIntent[], fresh: readonly FloodIntent[], cancelled: string | null, replacing: readonly FloodIntent[] = fresh):
  Readonly<{ intents: readonly FloodIntent[]; admitted: readonly FloodIntent[]; dropped: number }> {
  const superseded = new Set<FloodIntent>();
  const replaced = new Set(replacing.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.subject === cancelled || replaced.has(`${item.subject}\n${item.channel}`)) superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => !superseded.has(item)), ...fresh];
  const out = new Set<FloodIntent>();
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

function factsOf(value: FloodCurrent): Readonly<Record<string, JsonValue>> {
  return visible(value) ? { eventId: value.eventId, effective: value.effective, title: value.title, areaName: value.areaName, kinds: value.kinds,
    times: value.times, stations: value.stations, basisReportDateTimeRaw: value.basisReportDateTimeRaw, truncated: value.truncated }
    : { eventId: value.eventId, effective: value.effective };
}
function outcomeOf(value: FloodCurrent, changedFields: readonly string[], extra: Readonly<Record<string, JsonValue>> = {}): SubjectOutcome {
  return { subject: value.subject, operation: value.operation, informationType: value.source.infoTypeRaw, transition: value.effective,
    severity: null, source: value.source, facts: { ...factsOf(value), ...extra }, changedFields };
}
// view の subject は識別だけを持つ（事実は currents にあり、二重に載せると snapshot の予算を食う。U-L ほかの先例）。
const outcomeCache = new WeakMap<FloodCurrent, SubjectOutcome>();
function shownOutcome(value: FloodCurrent): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = { ...outcomeOf(value, []), facts: { eventId: value.eventId, effective: value.effective } };
    outcomeCache.set(value, found);
  }
  return found;
}
// 比べの観測の最大（P3-UM-AC05）は通知の判定の値で、表示には出さない（r1 Opus P3。印の compare も view に出さない）。
function viewed(value: Active) {
  if (value.observedCompare == null) return shown(value);
  const { observedCompare: _compare, ...rest } = value;
  return shown<Active>(rest);
}
function displaySubject(value: FloodCurrent): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-R" }>> {
  return { unit: "U-R", operation: value.operation, subject: value.subject, office: null, current: visible(value) ? viewed(value) : null,
    subjects: [shownOutcome(value)] };
}

// ---- 受信（P3-C11-SUBJECTS=A。一入力は EventID の subject を 1 つだけ変え、一回の参照交換で確定する） ----

function receiveCandidate(state: FloodUnitState, candidate: FloodCandidate, clock: ClockReading, basis: WallBasis): Result {
  const now = clock.wallTimeMs, recovering = candidate.source.origin === "recovery";
  const { subject, operation } = candidate;
  const unchanged = (reason: "duplicate" | "stale" | "noChange", diagnostics: readonly DiagnosticDetails[] = []): Result => ({ changes: [],
    step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason }], diagnostics } });
  // P3-C11-ACTIVE-EXPIRY.lateRule: 受理の時点で ReportDateTime+36 時間を過ぎた報は、記録の有無によらず state を変えない。
  if (candidate.reportDateTimeMs + RETAIN_MS <= now) return unchanged("stale");
  const index = indexOf(state.currents, subject);
  const existing = index == null ? null : state.currents[index];
  const built = currentOf(candidate, existing), version = judge(existing, built, candidate);
  const warn = (missing: boolean): DiagnosticDetails => ({ level: "WARN", component: "flood", inputId: candidate.source.inputId, unit: "U-R",
    reason: missing ? "requiredStructureMissing" : "floodRevisionConflict" });
  // 取消以前の版は stale で、取消した subject を戻さない。同じ版で中身が同じなら duplicate、違えば先着を保って印を付ける（P3-VM-AC04）。
  if (version.kind !== "adopt") {
    if (version.kind !== "held") return unchanged(version.kind === "duplicate" ? "duplicate" : "stale");
    // P3-REC-AC12（C16 発注 4b-1）: 取り直しの版の決まらない本文は印も WARN も置かずに noChange（owner が held と読む、P3-REC-AC05 の (a)）。
    if (recovering) return unchanged("noChange");
    const marked = existing == null || version.mark == null || existing.unconfirmed === version.mark ? state
      : { ...state, currents: replaceAt(state.currents, index, { ...existing, unconfirmed: version.mark }), persistence: dirty(state.persistence, clock.monotonicMs) };
    return { changes: [], step: { ...idle(marked), decisions: [{ subject, operation, decision: "unchanged", reason: "stale" }], diagnostics: [warn(version.missing)] } };
  }
  // P3-NL-AC02 (2)(4): 通知の印は記録へ引き継ぐ。
  let next: FloodCurrent = { ...built, ...version.mark == null ? {} : { unconfirmed: version.mark },
    ...existing?.notice == null ? {} : { notice: existing.notice } };
  const fields = visible(existing) || visible(next) ? changed(existing, next) : [];
  const decided = (change: "semantic" | "revisionOnly"): Decision => ({ subject, operation, decision: "changed", reason: null, change,
    currentEstablished: { family: candidate.headType, reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" } });
  const accepted = (change: "semantic" | "revisionOnly") => ({ kind: "accepted" as const, change,
    subjects: [outcomeOf(next, fields, visible(next) && candidate.headline != null ? { headline: candidate.headline } : {})] });

  let currents: readonly FloodCurrent[];
  let evicted: FloodCurrent | null = null;
  if (index == null && state.currents.length >= CURRENT_LIMIT) {
    evicted = evictOne(state.currents, now, operation, basis === "verified");
    // training/test の報で退去できる記録が無ければ、受けた記録自身を退去する（currents の参照を変えない、通知しない）。採用した取消は
    // その subject の pending を置き換え、intents が変わったときだけ保存世代を進める（C10 の Q-C10-IMPL-AMEND(5)）。記録を残さないので
    // accepted に載せず currentEstablished も null（D-VANISHED=A、P3-OPCAP-AC02）。
    if (evicted == null) {
      const notices = candidate.cancelled ? admit(state.intents, [], subject) : null;
      const kept = notices == null || notices.intents === state.intents ? state
        : { ...state, intents: notices.intents, persistence: dirty(state.persistence, clock.monotonicMs) };
      return { changes: [], step: { ...idle(kept), decisions: [{ subject, operation, decision: "changed", reason: null, change: "revisionOnly",
        currentEstablished: null }], outcomes: [{ kind: "accepted", change: "revisionOnly", subjects: [] }],
        diagnostics: [{ level: "INFO", component: "flood", reason: "floodCapacityEvicted", unit: "U-R", count: 1 }] } };
    }
    const gone = evicted;
    currents = [...state.currents.filter((item) => item !== gone), next];
  } else currents = replaceAt(state.currents, index, next);
  // 退去を伴う受理は decision も outcome も semantic（U-N・U-L と同じ）。
  const change = fields.length !== 0 || evicted != null ? "semantic" as const : "revisionOnly" as const;

  // Q-NOTICE.generationTable。訂正は事実が同じでも作る。記録の無い subject か取消の記録への解除の報（inactiveAdoption）も作る。
  // 記憶だけの取消・ended の記録への解除・河川の段階も観測の最大も上がらない報では作らない。
  const correction = candidate.infoRank === 2;
  const notice = visible(next) ? noticeOf(existing, next) : null;
  // P3-NL-AC09 (1): 取消は active だったか、系列の印に通知の証拠があるとき（H19）。
  const notify = candidate.cancelled ? visible(existing) || heard(existing?.notice) : correction || (notice != null ? notice.changed
    : visible(existing) || existing == null || existing.effective === "cancelled");
  const transition = candidate.cancelled ? "cancelled" as const : correction ? "updated" as const
    : visible(next) ? visible(existing) ? "updated" as const : "activated" as const : "released" as const;
  const level = candidate.cancelled ? "cancel" : notice?.level ?? "normal";
  // 版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const digest = notify ? versionDigest(candidate.source) : "";
  const fresh = notify ? intentsFor(candidate, transition, payloadOf(candidate, next, level, existing?.source.reportDateTimeRaw ?? null), now,
    channelsOf(operation), existing?.notice, digest) : [];
  // 取り直しは intent を作らず、live の新しい intent が置き換える古い pending だけを外す（P3-REC-D-UNIT-ENTRANCE=A）。
  const notices = admit(state.intents, recovering ? [] : fresh, candidate.cancelled ? subject : null, fresh);
  // P3-NL-AC02 (3): admit を通った版と種類を EventID の系列の印に足す（全 channel が断られた版は入れない）。
  if (notices.admitted.length !== 0) {
    const unmarked = next;
    next = { ...unmarked, notice: markNotice(unmarked.notice, digest, noticeKind(transition)) };
    currents = currents.map((item) => item === unmarked ? next : item);
  }
  // P3-UM-AC03 (3): 原文の合計が予算を越えたら古い記録の原文から外す（印は残る）。外した記録の view も変わるので表示の変化に足す。
  const fit = fitRawBudget(rawTotal(currents), RAW_BUDGET, () => currents, rawKey);
  const stripped: Change[] = [];
  if (fit != null) {
    const own = next;
    currents = stripAll(currents, fit, (item, after) => { if (item === own) next = after; else stripped.push([item, after]); });
  }
  const result: FloodUnitState = { ...state, currents, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) };
  const diagnostics: DiagnosticDetails[] = version.missing ? [warn(true)] : [];
  if (evicted != null) diagnostics.push({ level: "INFO", component: "flood", reason: "floodCapacityEvicted", unit: "U-R", count: 1 });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "flood", reason: "notificationCapacityEvicted", unit: "U-R",
    count: notices.dropped });
  const dropped = droppedIn(fit, currents);
  if (dropped !== 0) diagnostics.push({ level: "INFO", component: "flood", reason: "unreadableDropped", unit: "U-R", count: dropped });
  return {
    changes: [...evicted == null ? [] : [[evicted, null] as const], ...stripped, [existing, next]],
    step: { state: result, nextDeadline: nextDeadline(result), decisions: [decided(change)], intents: notices.admitted,
      outcomes: [accepted(change)], diagnostics },
  };
}

// 受けた報の読めなかった所の WARN を先に置く（P3-EF-AC13 (2)）。
function warned(result: Result, diagnostics: readonly DiagnosticDetails[]): Result {
  return diagnostics.length === 0 ? result : { ...result, step: { ...result.step, diagnostics: [...diagnostics, ...result.step.diagnostics] } };
}
function receive(state: FloodUnitState, input: Extract<FloodInput, { kind: "receive" }>): Result {
  const parsed = parseFlood(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // P3-REC-AC12（C16 発注 4b-1）・P3-C11-N2: origin=recovery は候補の作成のときだけ owner から届く。意味を当てて intent を作らない
  // （引上げの音は採用の step の recoveryNotices）。
  return warned(receiveCandidate(state, candidate, input.clock, input.basis ?? "verified"), parsed.diagnostics);
}

// ---- 期限（I-U-R.deadlines。到来分だけを回収する） ----

// P3-C11-ACTIVE-EXPIRY=D: active の記録の回収では desktop だけの期限切れを 1 件作る（ended・cancelled の回収では作らない）。
function expiryPayload(value: Active): FloodNotificationPayload {
  const prefix = PREFIX[value.operation];
  return { domain: "weather", level: "info", title: cut(`${prefix}[期限切れ] ${value.title}`, NOTICE_BOUNDS.title),
    body: cut(`${value.areaName === "" ? "この" : `${value.areaName}の`}洪水予報は36時間続報がなく、現況を確認できません`, NOTICE_BOUNDS.body) };
}
// 期限切れの記憶（P3-EF-AC05 (2)(3)）: 事実を捨て、識別・source・印を残す。
function expiredOf(item: Active): FloodCurrent {
  return { subject: item.subject, operation: item.operation, headType: item.headType, eventId: item.eventId, source: item.source,
    ...item.unconfirmed == null ? {} : { unconfirmed: item.unconfirmed }, ...item.notice == null ? {} : { notice: item.notice },
    retainUntil: reportMs(item.source) + EXPIRED_RETAIN_MS, effective: "expired" };
}
// 根拠ごとの当て方（P3-EF-AC02）: awaiting は何も当てない。unverified は表示の期限の来た記録に保留の印を付けるだけ。verified は表示の
// 期限の来た記録と保留の記録（時計によらず）を記憶に移し、retainUntil の来た記録と intent を回収する。
// ponytail: 512 subject の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
// base は取り直しの候補の受信の前の回収（shadow と当て直し）で渡る shadow の基点。基点で見えていなかった記録（候補が見えるようにした記録）の期限切れの
// intent を足すと候補が live の部分集合でなくなり丸ごと generationConflict になるので作らず、置き換える古い pending だけを外す（P3-REC-D-UNIT-ENTRANCE=A）。
// 基点で見えていた記録の期限は作る（候補は generationConflict になり、通知は live の回収で出る）。採用の後の live の回収も鳴らす。
// 基点は期限の来た記録ごとに鍵で 1 回引く（索引は配列に結び付けて 1 回だけ作る）。
function collect(state: FloodUnitState, clock: ClockReading, basis: WallBasis, base?: FloodUnitState): Readonly<{ state: FloodUnitState; changes: readonly Change[];
  expiredIntents: number; intents: readonly FloodIntent[]; dropped: number }> {
  const now = clock.wallTimeMs, verified = basis === "verified";
  const shows = basis !== "awaiting" && displayMin(state.currents) <= now;
  const recalls = verified && (recallMin(state.currents) <= now || pendingMin(state.currents) !== Infinity);
  if (!shows && !recalls && !(verified && intentMin(state.intents) <= now))
    return { state, changes: [], expiredIntents: 0, intents: [], dropped: 0 };
  const changes: Change[] = [];
  const expiry: FloodIntent[] = [];
  const currents = !shows && !recalls ? state.currents : state.currents.flatMap((item): FloodCurrent[] => {
    let after: FloodCurrent | null = item;
    if (item.effective === "active" && (item.expiryPending === true || item.retainUntil <= now)) {
      // P3-C11-ACTIVE-EXPIRY=D・P3-EF-AC05 (4): 見える記録が見えなくなるときだけ desktop の期限切れを 1 件作る（保留の記録を記憶へ移すときは作らない）。
      if (visible(item)) expiry.push(...intentsFor(item, "expired", expiryPayload(item), now, ["desktop"], item.notice, versionDigest(item.source)));
      after = verified ? expiredOf(item) : item.expiryPending === true ? item : { ...item, expiryPending: true };
    }
    if (verified && after.effective !== "active" && after.retainUntil <= now) after = null;
    if (after !== item) changes.push([item, after]);
    return after == null ? [] : [after];
  });
  const remaining = !verified || intentMin(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - remaining.length;
  const shownAtBase = (subject: string) => base == null || visible(base.currents[indexOf(base.currents, subject) ?? -1] ?? null);
  const notices = admit(remaining, base == null ? expiry : expiry.filter((item) => shownAtBase(item.subject)), null, expiry);
  const persisted = changes.length !== 0 || notices.intents !== state.intents;
  return { state: persisted ? { ...state, currents: changes.length === 0 ? state.currents : currents, intents: notices.intents,
    persistence: dirty(state.persistence, clock.monotonicMs) } : state,
  changes, expiredIntents, intents: notices.admitted, dropped: notices.dropped };
}

function deadlineStep(state: FloodUnitState, clock: ClockReading, basis: WallBasis, shutdown: boolean, base?: FloodUnitState): Result {
  const applied = collect(state, clock, basis, base);
  const diagnostics: DiagnosticDetails[] = [];
  if (applied.expiredIntents !== 0) diagnostics.push({ level: "INFO", component: "flood", reason: "notificationExpired", unit: "U-R",
    count: applied.expiredIntents });
  if (applied.dropped !== 0) diagnostics.push({ level: "INFO", component: "flood", reason: "notificationCapacityEvicted", unit: "U-R",
    count: applied.dropped });
  return { changes: applied.changes, step: { ...idle(applied.state), intents: applied.intents,
    outcomes: shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] : [], diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

// P3-NL-AC02 (3)・AC08 (1): intent の EventID の系列の印の証拠を上げる（下げない）。
function raiseNotices(state: FloodUnitState, raised: ReadonlyMap<string, NoticeEvidence>): FloodUnitState {
  let currents = state.currents;
  for (const [subject, evidence] of raised) {
    const at = indexOf(currents, subject), found = currents[at ?? -1];
    const notice = found?.notice == null ? undefined : raiseEvidence(found.notice, evidence);
    if (found != null && notice !== found.notice) currents = replaceAt(currents, at, { ...found, notice });
  }
  return currents === state.currents ? state : { ...state, currents };
}

function intentUpdate(state: FloodUnitState, input: Extract<FloodInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, FloodIntent>();
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
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7〜C10 の先例）。pending でなくなった intent は外す（P3-NL-AC05 (1)）。
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

// Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。期限を過ぎた記録と intent は、復元の後の
// 最初の期限処理で回収する（active の期限切れの desktop はそこで作る、P3-C11-ACTIVE-EXPIRY=D）。
// P3-NL-AC08 (1): started のまま残った pending は通知したか不明として外し、系列の印の証拠を unknown にする。
function restore(state: FloodUnitState, persisted: PersistedFloodUnit, clock: ClockReading): Result {
  const decoded = floodUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "flood",
    reason: "requiredStructureInvalid", unit: "U-R" }] } };
  const started = restoreStarted(decoded.state.intents);
  const restored = { ...raiseNotices(decoded.state, new Map(started.started.map((item) => [item.subject, "unknown" as const]))),
    intents: started.intents, persistence: started.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const active = restored.currents.filter(visible);
  return { changes: active.map((item): Change => [null, item]), step: { ...idle(restored),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-R"], coverage: active.map((item) => item.subject), subjects: [] }],
    diagnostics: started.started.length === 0 ? [] : [{ level: "INFO", component: "flood", reason: "notificationOutcomeUnknown",
      unit: "U-R", count: started.started.length }] } };
}

function reduceCore(state: FloodUnitState, input: FloodInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, input.basis ?? "verified", false, input.recoveryBase);
    case "shutdown": return deadlineStep(state, input.clock, input.basis ?? "verified", true);
    case "receive": return receive(state, input);
    default: { const missing: never = input; throw new Error(`flood input ${String(missing)} is not handled`); }
  }
}

function reduceFloodUnit(state: FloodUnitState, input: FloodInput): FloodUnitStep {
  const { step, changes } = reduceCore(state, input);
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: FloodCurrent | null; after: FloodCurrent | null }>();
  for (const [before, after] of changes) {
    const key = (after ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: FloodUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-R", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-R content revision exhausted");
  // P3-C11-N2: U-R は確認 scope を作らない。
  return { ...step, state: displayChanges.length !== 0 ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toFloodView(state: FloodUnitState): FloodUnitView {
  const currents = state.currents.filter(visible);
  const subjects = currents.map(shownOutcome);
  return { unit: "U-R", semanticRevision: subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`).sort().join("|"),
  contentRevision: String(state.contentRevision), subjects, currents: currents.map(viewed) };
}

// ---- codec（I-U-R.persisted・I-U-R.decode、唯一の FloodUnitCodec。受理と同じ上限を確かめる） ----

const boundedName = (value: unknown, limit: number): value is string => bounded(value, limit) && validName(value);
// 受理が作りうる数（11 文字以下の `-?[0-9]{1,6}(\.[0-9]{1,3})?`）か null。
const measured = (value: unknown): number | null | undefined => value === null ? null
  : finite(value) && validValue(String(value)) ? value : undefined;
// I-U-R.subjects の形（`${operation}/${headType}/${eventId}`、Q-ENUM.identity の文字と長さ）。
function subjectParts(subject: string): Readonly<{ operation: Operation; headType: string; eventId: string }> | null {
  const match = /^(normal|training|test)\/([A-Z0-9]+)\/([\s\S]*)$/.exec(subject);
  const operation = operationOf(match?.[1]);
  return match == null || operation == null || !validHeadType(match[2]) || !validEventId(match[3]) ? null
    : { operation, headType: match[2], eventId: match[3] };
}
function reportRef(value: unknown, subject: string): ReportRef | null {
  const ref = readReportRef(value);
  const parts = subjectParts(subject);
  return ref == null || parts == null || ref.family !== parts.headType || ref.subject !== subject || parts.operation !== ref.operation
    // 読めなかった Serial は空で保存する（P3-EF-AC13 (5)、Q-EF-PRECHECK-2 (a)）。
    || !validReportDateTime(ref.reportDateTimeRaw) || ref.serialRaw !== "" && !validSerial(ref.serialRaw)
    || infoRankOf(ref.infoTypeRaw) == null ? null : ref;
}
// 受理と同じ上限（group 16・河川の延べ 32・code の形と重複・level と code の一致・rivers が空の group は truncated のときだけ）。
function kindsRecord(value: unknown, truncated: boolean): FloodKindGroup[] | null {
  const codes = new Set<string>();
  let total = 0;
  const groups = list(value, (entry) => {
    const row = record(entry);
    const rivers = list(row?.rivers, (river): FloodRiver | null => {
      const item = record(river);
      // 名前の読めない河川は空の名前で受ける（P3-EF-AC13）。
      if (item == null || !isText(item.code) || !validRiverCode(item.code) || codes.has(item.code) || !bounded(item.name, BOUNDS.name)
        || item.name !== "" && !validName(item.name)) return null;
      codes.add(item.code);
      return { code: item.code, name: item.name };
    }, LIMITS.rivers);
    if (row == null || rivers == null || rivers.length === 0 && !truncated || !isText(row.code) || !validKindCode(row.code)
      // 名前の読めない Kind は空の名前で受ける（P3-EF-AC13）。
      || !bounded(row.name, BOUNDS.name) || row.name !== "" && !validName(row.name) || row.level !== levelOf(row.code)) return null;
    total += rivers.length;
    return { code: row.code, name: row.name, level: levelOf(row.code), rivers };
  }, LIMITS.groups);
  if (groups == null || total > LIMITS.rivers || new Set(groups.map((item) => item.code)).size !== groups.length) return null;
  return groups;
}
const POINT_LEVELS = [0, 1, 2, 3, 4, 5] as const;
function pointLevel(item: unknown): Readonly<{ level: FloodStation["levels"][number] }> | null {
  if (item === null) return { level: null };
  const found = POINT_LEVELS.find((level) => level === item);
  return found == null ? null : { level: found };
}
const CRITERIA_KEYS = ["level1", "level2", "level3", "level4", "level4Plan"] as const;
function stationRecord(value: unknown, points: number, riverCodes: ReadonlySet<string>): FloodStation | null {
  const row = record(value), criteriaRow = record(row?.criteria);
  if (row == null || criteriaRow == null || !isText(row.code) || !validStationCode(row.code) || !boundedName(row.name, BOUNDS.stationName)
    || (row.measurement !== "waterLevel" && row.measurement !== "discharge")) return null;
  const links = list(row.riverCodes, (code) => isText(code) && riverCodes.has(code) ? code : null, LIMITS.sections);
  const values = list(row.values, (item) => {
    const read = measured(item);
    return read === undefined ? null : { value: read };
  });
  const levels = list(row.levels, pointLevel);
  const criteria: { -readonly [K in keyof FloodCriteria]: number | null } = { level1: null, level2: null, level3: null, level4: null, level4Plan: null };
  for (const key of CRITERIA_KEYS) {
    const read = measured(criteriaRow[key]);
    if (read === undefined) return null;
    criteria[key] = read;
  }
  if (links == null || values == null || levels == null || new Set(links).size !== links.length || values.length !== points
    || levels.length !== points) return null;
  return { code: row.code, name: row.name, riverCodes: links, measurement: row.measurement, criteria, values: values.map((item) => item.value),
    levels: levels.map((item) => item.level) };
}
const FACT_KEYS = ["title", "areaName", "kinds", "times", "stations", "basisReportDateTimeRaw", "truncated", "expiryPending", "unreadable",
  "observedCompare"];
// P3-UM-AC01 (2)（FloodUnreadableSite）。
const UNREADABLE_SITES: ReadonlySet<string> = new Set(["serial", "areaName", "kindName", "riverName", "series", "station"] satisfies readonly FloodUnreadableSite[]);
function currentRecord(value: unknown): FloodCurrent | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  const parts = isText(row?.subject) ? subjectParts(row.subject) : null;
  if (row == null || operation == null || parts == null || !isText(row.subject) || parts.operation !== operation || row.headType !== parts.headType
    || row.eventId !== parts.eventId) return null;
  const source = reportRef(row.source, row.subject);
  // 記憶は元報＋42 時間、ほかは effective によらず＋36 時間の等式（P3-EF-AC14 (20)）。
  if (source == null || row.retainUntil !== reportMs(source) + (row.effective === "expired" ? EXPIRED_RETAIN_MS : RETAIN_MS)) return null;
  // P3-VM-AC04: 印は同じ EventID（subject・operation）の報（取消の後の時刻の無い報の印も残る）。
  const mark = "unconfirmed" in row ? reportRef(row.unconfirmed, row.subject) : undefined;
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (mark === null || notice === null) return null;
  const base = { subject: row.subject, operation, headType: parts.headType, eventId: parts.eventId, source, retainUntil: row.retainUntil,
    ...mark == null ? {} : { unconfirmed: mark }, ...notice == null ? {} : { notice } };
  if (row.effective !== "active") {
    // active 以外は事実を持たない（types.ts の判別共用体）。
    if (FACT_KEYS.some((key) => key in row)) return null;
    return row.effective === "ended" || row.effective === "cancelled" || row.effective === "expired" ? { ...base, effective: row.effective } : null;
  }
  if (typeof row.truncated !== "boolean" || !bounded(row.title, BOUNDS.title) || loneSurrogate(row.title)
    || !bounded(row.areaName, BOUNDS.areaName) || row.areaName !== "" && !validName(row.areaName)
    || row.basisReportDateTimeRaw !== null && !(isText(row.basisReportDateTimeRaw) && validReportDateTime(row.basisReportDateTimeRaw))
    || "expiryPending" in row && row.expiryPending !== true
    // P3-UM-AC05 (3)・Q-UM-PRECHECK-2 (8)(e): 比べの観測の最大は -1〜5 の整数。
    || "observedCompare" in row && !(Number.isInteger(row.observedCompare) && Number(row.observedCompare) >= -1 && Number(row.observedCompare) <= 5)) return null;
  const unreadable = "unreadable" in row ? readUnreadableMark(row.unreadable, UNREADABLE_SITES) : undefined;
  if (unreadable === null) return null;
  const kinds = kindsRecord(row.kinds, row.truncated);
  const times = list(row.times, (item) => isText(item) && validTime(item) ? item : null, LIMITS.points);
  if (kinds == null || times == null) return null;
  const rivers = new Set(kinds.flatMap((group) => group.rivers.map((river) => river.code)));
  const stations = list(row.stations, (item) => stationRecord(item, times.length, rivers), LIMITS.stations);
  if (stations == null || new Set(stations.map((item) => `${item.code}\n${item.name}`)).size !== stations.length) return null;
  return { ...base, effective: "active", title: row.title, areaName: row.areaName, kinds, times, stations,
    basisReportDateTimeRaw: row.basisReportDateTimeRaw, truncated: row.truncated, ...row.expiryPending === true ? { expiryPending: true } : {},
    ...unreadable == null ? {} : { unreadable }, ...typeof row.observedCompare === "number" ? { observedCompare: row.observedCompare } : {} };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): FloodIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const source = isText(row?.subject) ? reportRef(row.source, row.subject) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-R", operation, level), recovered = payload == null ? null : recoveredPayload(payload);
  // state に残る subject との一致は求めない（記録の回収の後も pending は期限まで残る、I-U-R.decode）。H27 の 2 欄は対で読む（P3-REC-AC12）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || fields == null || recovered == null || !isText(row.id) || row.unit !== "U-R" || !isText(row.subject) || source.operation !== operation
    || payload.domain !== "weather" || !isText(payload.title) || payload.title === "" || !isText(payload.body) || payload.body === ""
    || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt) || !count(row.attempts) || !isText(row.configRevision)
    || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-R", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "weather", level, title: payload.title, body: payload.body, ...recovered }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition: "pending", ...fields };
}
function persisted(value: unknown): PersistedFloodUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const currents = list(row.currents, currentRecord, CURRENT_LIMIT), intents = list(row.intents, intentRecord);
  if (currents == null || intents == null || new Set(currents.map((item) => item.subject)).size !== currents.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。保存する intent は pending だけ（P3-NL-AC05）。
  const pendingBytes = listBytes(intents) + intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedFloodUnit = { schemaVersion: SCHEMA, currents, intents };
  // P3-UM-AC16 (3)(c)（AC03 (1) の数え方）。
  if (intents.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || generationBytes(result) > generationLimitOf()
    || rawTotal(currents) > RAW_BUDGET) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const floodUnitCodec: FloodUnitCodec = {
  schemaVersion: SCHEMA, get maxEnvelopeBytes() { return generationLimitOf(); }, // P3-VM-AC05・AC06（修正波 3）: 保存 1 世代の上限。旧い版の一覧は持たない（P3-MIG-AC01・AC02: 版を上げても一覧に足さず、開発機の保存を消す）
  // contentRevision・persistence は保存しない（I-U-R.persisted）。
  encode: (state) => ({ schemaVersion: SCHEMA, currents: state.currents, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: `invalid ${SCHEMA} payload` }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-R.runtimeRows）。
const floodUnit = {
  unit: "U-R",
  reduce: reduceFloodUnit,
  toView: toFloodView,
  persistence: { kind: "durable", codec: floodUnitCodec },
  confirmationScopeLimit: 512,
  reclaimDeadlineBeforeReceive: true,
  recoveryNotices: (open, adopted, at) => recoveryNotices(open, adopted, at.clock),
  recoveryChanges,
} satisfies UnitModule<"U-R">;

// ---- 取り直しの採用の step（P3-RECOVERY-001 発注 4b-1、P3-REC-AC10・P3-REC-D-N2-RAISE-4B=A） ----

/**
 * 候補の部分集合の検査の後に、採用の step で作る H27 の intent（P3-REC-AC10）。open は取り直しを始めた時の state（P3-REC-D-RAISE-BASIS=A）、
 * candidate は採用する state。live の音の段（noticeOf）が open より上がり、いまも見える EventID のうち段の最も高い 1 件に info を 1 回
 * （取り直し 1 回で unit に 1 件）。通知済みの版（K8 の印）は選ぶ前に除く。無ければ candidate をそのまま返す。
 */
function recoveryNotices(open: FloodUnitState, candidate: FloodUnitState, clock: ClockReading): FloodUnitState {
  const now = clock.wallTimeMs, before = new Map(open.currents.map((item) => [item.subject, item]));
  let best: Readonly<{ current: Active; rank: number }> | null = null;
  for (const current of candidate.currents) {
    if (!visible(current) || current.retainUntil <= now) continue;
    const raised = noticeOf(before.get(current.subject) ?? null, current).raised;
    if (raised == null || noticed(current.notice, versionDigest(current.source), noticeKind("updated"))) continue;
    const rank = LEVEL_ORDER.indexOf(raised);
    if (best == null || rank > best.rank) best = { current, rank };
  }
  if (best == null) return candidate;
  const { current } = best, { source } = current, version = versionDigest(source);
  const at = new Date(reportMs(source) + 32_400_000).toISOString().slice(11, 16);
  const payload: FloodNotificationPayload = { domain: "weather", level: "info", title: cut(`${PREFIX[current.operation]}${current.title}（${at} 発表）`, NOTICE_BOUNDS.title),
    body: cut(riversText(current) || current.title, NOTICE_BOUNDS.body), reportDateTime: source.reportDateTimeRaw, recovered: true };
  const notices = admit(candidate.intents, intentsFor(current, "updated", payload, now, channelsOf(current.operation), current.notice, version), null);
  if (notices.admitted.length === 0) return candidate;
  // P3-NL-AC02 (3): 引上げの版と種類を EventID の系列の印に足す。
  const currents = candidate.currents.map((item) => item !== current ? item : { ...item, notice: markNotice(item.notice, version, noticeKind("updated")) });
  return { ...candidate, currents, intents: notices.intents };
}

// P3-REC-AC07（投影の直し、Q-REC-PRECHECK-7 の N2）: 取り直しの採用の step の正味の表示の変化（採用の直前の live → 最終の state）。
// 両状態の記録を鍵の Map で突き合わせ、reduce の merged の loop と同じ述語・displaySubject・鍵で作る。同じ参照の記録は省く（O(N前＋N後)）。
function recoveryChanges(before: FloodUnitState, after: FloodUnitState): FloodUnitStep["displayChanges"] {
  const old = new Map<string, FloodCurrent>();
  for (const item of before.currents) old.set(item.subject, item);
  const changes: FloodUnitStep["displayChanges"][number][] = [];
  const add = (was: FloodCurrent | null, now: FloodCurrent | null) => {
    const shownBefore = visible(was) ? was : null, shownAfter = visible(now) ? now : null;
    if (shownBefore === shownAfter) return;
    const value = (now ?? was)!;
    changes.push({ unit: "U-R", operation: value.operation, subject: value.subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  };
  for (const item of after.currents) { add(old.get(item.subject) ?? null, item); old.delete(item.subject); }
  for (const item of old.values()) add(item, null);
  return changes;
}

export { floodUnit, floodUnitCodec, recoveryChanges, recoveryNotices, reduceFloodUnit, toFloodView };
