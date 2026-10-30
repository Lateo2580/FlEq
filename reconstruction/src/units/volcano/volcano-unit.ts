import { isDeepStrictEqual } from "node:util";

import type { MaterialValue, Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, NoticeEvidence, NoticeMark, PersistenceStatus, PublishedOutcome, ReportRef, RuntimeDisplaySubject,
  RuntimeUnitDeadline, SubjectOutcome, UnreadableMark, UnreadablePart, WallBasis,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  PersistedVolcanoUnit, VolcanoAlert, VolcanoAlertFamily, VolcanoAreaGroup, VolcanoAshfall, VolcanoAshfallBatch, VolcanoAshfallGroup,
  VolcanoBulletin, VolcanoBulletinView, VolcanoEruption, VolcanoInput, VolcanoIntent, VolcanoKind, VolcanoNotificationPayload,
  VolcanoScheduledAshfall, VolcanoShortfall, VolcanoUnitCodec, VolcanoUnitState, VolcanoUnitStep, VolcanoUnitView, VolcanoUnreadableSite,
} from "../../../contracts/p3-volcano-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { compareVersion, readReportRef, stepVersion } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth"; import { bounded, count, finite, isText, list, operationOf, record } from "../codec-base";
import {
  ASH, ASH_ORDER, BOUNDS, FAMILIES, INFO_RANK, LIMITS, asciiCode, isMarine, parseVolcano, validEventId, validSerial, validVolcanoCode,
} from "../../domains/volcano/volcano";
import type { AlertFacts, VolcanoCandidate, VolcanoEntry } from "../../domains/volcano/volcano";
import {
  applyIntentUpdate, cancelText, freshState, heard, markNotice, noticeId, noticeKind, noticed, raiseEvidence, readIntentState, readNoticeMark, recoveredPayload, restoreStarted,
  shown, updateEvidence, versionDigest,
} from "../notice-mark";
import { cachedMin } from "../expiry";
import {
  RAW_BUDGET, UNREAD_TEXT, compareColumns, droppedIn, fitRawBudget, hasPart, inheritMark, rawTotal, readUnreadableMark, stripAll,
  unreadableMarkBytes,
} from "../unreadable";
import type { CompareColumn } from "../unreadable";

// P3-UNIT-V-001（C9、I-U-V）: U-V の三 slice・定時・batch・解説・復旧不足・通知・容量・codec・射影。

const SCHEMA = "p3-volcano-unit-v7" as const;
// P3-C9-CAPACITY=A・P3-C9-RES-01・RET-01〜06。世代の上限は P3-CODEC-D-LIMIT=A（K5、当初 4 MiB）。
const SLICE_LIMIT = 128, BULLETIN_LIMIT = 64, SHORTFALL_LIMIT = 128, BATCH_LIMIT = 20;
// P3-UM-RES-09: 器は保存する記録の印（警報は陸と海の 2 つで一覧の欄 municipalities・marineAreas、噴火は municipalities、降灰は欄なし）と
// 原文の予算とカードの分だけ広げる。解説は保存しないので数えない。
const GENERATION_LIMIT = 5_242_880 + SLICE_LIMIT * (unreadableMarkBytes("unreadable", 2) + unreadableMarkBytes("marineUnreadable", 2))
  + SLICE_LIMIT * unreadableMarkBytes("unreadable", 1) + SLICE_LIMIT * unreadableMarkBytes("unreadable") + RAW_BUDGET + UNREADABLE_CARDS_MAX_BYTES;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
// P3-C9-SEM-01〜07（元報の ReportDateTime からの絶対の長さ、P3-C9-RETENTION=A。batch は単調時計）。
const DAY_MS = 86_400_000;
const ALERT_RETAIN_MS = 30 * DAY_MS, ERUPTION_VALID_MS = DAY_MS, ERUPTION_RETAIN_MS = 2 * DAY_MS, ASHFALL_RETAIN_MS = 7 * DAY_MS,
  SHORT_RETAIN_MS = 36 * 3_600_000, QUIET_MS = 8_000, MAX_WAIT_MS = 90_000;
const TTL = { desktop: 180_000, sound: 60_000 } as const;

type Level = VolcanoNotificationPayload["level"];
type ActiveAlert = Extract<VolcanoAlert, Readonly<{ effective: "active" }>>;
type ActiveEruption = Extract<VolcanoEruption, Readonly<{ effective: "active" }>>;
type ActiveAshfall = Extract<VolcanoAshfall, Readonly<{ effective: "active" }>>;
type ActiveBulletin = Extract<VolcanoBulletin, Readonly<{ effective: "active" }>>;
type Shown = VolcanoAlert | VolcanoEruption | VolcanoAshfall | VolcanoScheduledAshfall | VolcanoBulletin;
type InternalStep = Omit<VolcanoUnitStep, "displayChanges" | "confirmationEvidence">;
type Decision = VolcanoUnitStep["decisions"][number];
type Change = readonly [before: Shown | null, after: Shown | null];
type Result = Readonly<{ step: InternalStep; changes: readonly Change[] }>;
type Candidate<S extends VolcanoCandidate["slice"]> = Extract<VolcanoCandidate, Readonly<{ slice: S }>>;

const reportMs = (source: ReportRef): number => Date.parse(source.reportDateTimeRaw);
// 期限切れの保留の印のある噴火・降灰は見えない記録として扱う（P3-EF-AC02 (2)）。
const pending = (value: Shown): boolean => "expiryPending" in value && value.expiryPending === true;
const visible = (value: Shown | null): boolean => value != null && value.effective === "active" && !("topAshName" in value) && !pending(value);
const isAlert = (value: Shown): value is VolcanoAlert => "marineSource" in value;
const isBulletin = (value: Shown): value is VolcanoBulletin => "family" in value;
// 警報は source と marineSource の新しい方、ほかは source（P3-C9-MARINE=A）。
const recordMs = (value: Shown): number => isAlert(value)
  ? Math.max(value.source == null ? -Infinity : reportMs(value.source), value.marineSource == null ? -Infinity : reportMs(value.marineSource))
  : reportMs(value.source);
const latestSource = (value: Shown): ReportRef => isAlert(value)
  ? value.source == null || value.marineSource != null && reportMs(value.marineSource) > reportMs(value.source) ? value.marineSource! : value.source
  : value.source;

// ---- byte の加算（I-U-V.computation。受信 1 回で state 全体を直列化しない） ----

const encoder = new TextEncoder();
const byteCache = new WeakMap<object, number>();
function bytes(value: object): number {
  let size = byteCache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; byteCache.set(value, size); }
  return size;
}
const commas = (length: number) => Math.max(length - 1, 0);
const listBytes = (values: readonly object[]): number => 2 + commas(values.length) + values.reduce((sum, item) => sum + bytes(item), 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-V", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, alerts: [], eruptions: [], ashfalls: [], shortfalls: [], intents: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7)・P3-UM-AC11 (10): envelope の inputBoundary・losses・カードの最大（器からは引かない）
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T・U-Q・U-N と同じ予約）。10: 空の配列 5 つ。
function generationBytes(value: PersistedVolcanoUnit): number {
  return emptyEnvelopeBytes + 62 - 10 + listBytes(value.alerts) + listBytes(value.eruptions) + listBytes(value.ashfalls)
    + listBytes(value.shortfalls) + listBytes(value.intents);
}
// 配送の更新で伸びうる分（pending の deliveryGrowth）を 1 回だけ足した世代の byte（P3-CODEC-RES-01）。
const reservedGenerationBytes = (value: PersistedVolcanoUnit): number => generationBytes(value)
  + value.intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);

// ---- 期限（I-U-V.deadlines） ----

const deadlineCache = new WeakMap<readonly object[], number>();
function minOf<T extends object>(values: readonly T[], at: (value: T) => number): number {
  let min = deadlineCache.get(values);
  if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); deadlineCache.set(values, min); }
  return min;
}
// 警報の active は期限で消えない。噴火・降灰の active は validUntil・予報の終わり、記録は retainUntil。
const alertDeadline = (value: VolcanoAlert) => value.effective === "active" ? Infinity : value.retainUntil;
const eruptionDeadline = (value: VolcanoEruption) => value.effective === "active" ? value.validUntil : value.retainUntil;
const ashfallDeadline = (value: VolcanoAshfall) => value.effective === "active" ? value.forecastEndsAt : value.retainUntil;
const retained = (value: { retainUntil: number }) => value.retainUntil;
// P3-EF-AC11 (2): 根拠で当てない種類を比べないよう、表示の期限・回収の期限・保留の記録を別々に持つ（nextDeadline は上の全部の最小）。
const eruptionShown = cachedMin<VolcanoEruption>((item) => visible(item) && item.effective === "active" ? item.validUntil : Infinity);
const ashfallShown = cachedMin<VolcanoAshfall>((item) => visible(item) && item.effective === "active" ? item.forecastEndsAt : Infinity);
const bulletinShown = cachedMin<VolcanoBulletin>((item) => visible(item) ? item.retainUntil : Infinity);
// retainUntil で回収する記録: inactive・保留の印・定時（見えないので active のまま retainUntil で消える）。recallMin と sweep の削除が同じ条件を使う。
const recallable = (value: Shown): boolean => value.effective !== "active" || pending(value) || "topAshName" in value;
const recallMin = cachedMin<Shown>((item) => recallable(item) ? item.retainUntil : Infinity);
const pendingMin = cachedMin<Shown>((item) => pending(item) ? item.retainUntil : Infinity);
const intentMin = cachedMin<VolcanoIntent>((item) => item.expiresAt);
function deadlineAt(state: VolcanoUnitState): number {
  return Math.min(minOf(state.alerts, alertDeadline), minOf(state.eruptions, eruptionDeadline), minOf(state.ashfalls, ashfallDeadline),
    minOf(state.scheduledAshfalls, retained), minOf(state.bulletins, retained), minOf(state.intents, (item) => item.expiresAt));
}
const batchDue = (batch: VolcanoAshfallBatch | null): number | null => batch == null ? null
  : Math.min(batch.lastAtMonotonicMs + QUIET_MS, batch.startedAtMonotonicMs + MAX_WAIT_MS);
function nextDeadline(state: VolcanoUnitState): RuntimeUnitDeadline | null {
  const at = deadlineAt(state), monotonicMs = batchDue(state.batch);
  return at === Infinity && monotonicMs == null ? null : { wallTimeMs: at === Infinity ? null : at, monotonicMs };
}
const shownDeadline = (value: Shown): number => isAlert(value) ? alertDeadline(value) : "validUntil" in value && value.effective === "active"
  ? value.validUntil : "forecastEndsAt" in value && value.effective === "active" ? value.forecastEndsAt : value.retainUntil;
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
function idle(state: VolcanoUnitState): InternalStep {
  return { state, nextDeadline: nextDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}
const persistedChanged = (before: VolcanoUnitState, after: VolcanoUnitState) => before.alerts !== after.alerts
  || before.eruptions !== after.eruptions || before.ashfalls !== after.ashfalls || before.shortfalls !== after.shortfalls
  || before.intents !== after.intents;

// ---- 索引（配列に結び付けた Map。受信ごとに配列を探し直さない、I-U-V.computation） ----

const indexCache = new WeakMap<readonly Shown[], ReadonlyMap<string, number>>();
function indexOf(values: readonly Shown[], subject: string): number | undefined {
  let index = indexCache.get(values);
  if (index == null) { index = new Map(values.map((item, at) => [item.subject, at])); indexCache.set(values, index); }
  return index.get(subject);
}
// 火山コードの無い取消の照合（P3-C9-CANCEL-SCOPE=A の (2)）。運用区分と eventId ごとの記録の位置。警報は family の側ごとの
// identity（land・marine）を鍵にする（1 記録に鍵 2 つまで、P3-AUTH-AC03(3)）。
const eventKeys = (item: Shown): readonly string[] => !isAlert(item) ? [item.eventId]
  : [...item.landEventId == null ? [] : [`land\n${item.landEventId}`], ...item.marineEventId == null ? [] : [`marine\n${item.marineEventId}`]];
const eventCache = new WeakMap<readonly Shown[], ReadonlyMap<string, readonly number[]>>();
function eventMatches(values: readonly Shown[], operation: Operation, key: string): readonly number[] {
  let index = eventCache.get(values);
  if (index == null) {
    const built = new Map<string, number[]>();
    values.forEach((item, at) => { for (const part of eventKeys(item)) {
      const found = `${item.operation}\n${part}`;
      const list = built.get(found);
      if (list == null) built.set(found, [at]); else list.push(at);
    } });
    index = built;
    eventCache.set(values, index);
  }
  return index.get(`${operation}\n${key}`) ?? [];
}
function replaceAt<T>(values: readonly T[], index: number | undefined, value: T): readonly T[] {
  return index == null ? [...values, value] : values.map((item, at) => at === index ? value : item);
}

// P3-C9-CAPACITY=A と P3-OPCAP-AC01: 上限を超える 1 件は (1) retainUntil を過ぎた記録 (2) inactive (3) training/test (4) normal の active、
// それぞれ ReportDateTime の古い順で退去する。受ける報が training/test なら normal の記録は (1)〜(4) とも候補にせず、候補が無ければ
// 受けた記録自身を退去する（null）。
// ponytail: 満杯の slice の素朴な線形の走査（1 入力の上限は VFVO51 の entry 128 × 記録 128、上限は保持と decode で効く）。
// 第 1 段は受けた入力の根拠が verified のときだけ。保留の印のある記録は inactive の段に入る（P3-EF-AC03）。
function evictOne<T extends Shown>(values: readonly T[], now: number, incoming: Operation, verified: boolean,
  skip: ReadonlyMap<string, unknown> = new Map()): T | null {
  const tier = (item: T) => verified && item.retainUntil <= now && !(isAlert(item) && item.effective === "active") ? 0
    : item.effective !== "active" || pending(item) ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: T | null = null;
  for (const item of values) {
    if (item.operation === "normal" && incoming !== "normal" || skip.has(item.subject)) continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || recordMs(item) - recordMs(worst)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}
// 記録を置き換えるか足す。足すときに上限なら 1 件退去する（self は受けた記録自身の退去）。到着の時点で期限を過ぎた記録の無い subject の
// 記録は、同じ reduce で回収されるか slice が満杯なら足さない（dropped。期限を過ぎた記録のために他の記録を退去しない、P3-FINAL-AC01）。
function upsert<T extends Shown>(values: readonly T[], value: T, limit: number, now: number, verified: boolean):
  Readonly<{ values: readonly T[]; evicted: T | null; self: boolean; dropped: boolean }> {
  const index = indexOf(values, value.subject);
  if (index == null && shownDeadline(value) <= now && (value.retainUntil <= now || values.length >= limit))
    return { values, evicted: null, self: false, dropped: true };
  if (index != null || values.length < limit) return { values: replaceAt(values, index, value), evicted: null, self: false, dropped: false };
  const victim = evictOne(values, now, value.operation, verified);
  return victim == null ? { values, evicted: null, self: true, dropped: false }
    : { values: [...values.filter((item) => item !== victim), value], evicted: victim, self: false, dropped: false };
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// P3-VM-AC03: 系列ごとに compareVersion で比べる（報番号・InfoType の順位は使わない）。同じ版の中身には InfoType を含める。
// 降灰の速報・詳細（VFVO54/55）で Head/ReportDateTime と InfoType が同じ組は同じ報で、VFVO55 を採る（P3-VM-D-SAME-REPORT=A の (3)）。
const sameAshfallReport = (ref: ReportRef, source: ReportRef): boolean => ref.family !== source.family
  && [ref.family, source.family].every((family) => family === "VFVO54" || family === "VFVO55")
  && reportMs(ref) === reportMs(source) && ref.infoTypeRaw === source.infoTypeRaw;
// 通知の印（P3-NL-AC02）も中身の比べに入れない。読めない所の印（P3-UM-AC01）も入れない（原文の予算で原文を外した記録を同じ版の再送で食い違いにしない）。
const withoutSource = (value: Shown) => ({ ...value, source: null, marineSource: null, retainUntil: 0, unconfirmed: null, marineUnconfirmed: null,
  notice: null, marineNotice: null, expiryPending: null, unreadable: null, marineUnreadable: null });
type Held = Readonly<{ mark: ReportRef | null; missing: boolean }>;

// ---- 警報（I-U-V.alertSemantics、P3-C9-ALERT-ACTIVE=A・P3-C9-MARINE=A） ----

const INACTIVE_KINDS: ReadonlySet<string> = new Set(["11", "21", "35"]);
// active はレベル 2〜5・22・23・36 と表に無い code。解除の Condition は inactive。
const activeKind = (kind: VolcanoKind): boolean => !INACTIVE_KINDS.has(kind.code) && !(kind.condition ?? "").includes("解除");
function levelOf(code: string): 2 | 3 | 4 | 5 | null {
  return code === "12" ? 2 : code === "13" ? 3 : code === "14" ? 4 : code === "15" ? 5 : null;
}
// P3-C9-NOTICE-LEVELS=C: 通知の段階のレベル（11〜15 は 1〜5、22→2・23→3・36→2、表に無い code は 2）。
function noticeLevel(code: string): number {
  const numeric = /^1[1-5]$/.test(code) ? Number(code) - 10 : null;
  return numeric ?? (code === "23" ? 3 : code === "21" || code === "35" ? 1 : 2);
}
const ALERT_FIELDS = ["effective", "volcanoName", "kind", "lastKind", "level", "headline", "municipalities", "marineAreas", "coordinate"] as const;
const ERUPTION_FIELDS = ["effective", "volcanoName", "flash", "phenomenon", "eventDateTimeRaw", "craterName", "plumeAboveCrater",
  "plumeAboveSeaLevel", "plumeDirection", "headline", "municipalities"] as const;
const ASHFALL_FIELDS = ["effective", "volcanoName", "variant", "headline", "forecastStartsAt", "forecastEndsAt", "groups",
  "omittedGroupCount"] as const;
const SCHEDULED_FIELDS = ["effective", "volcanoName", "topAshName"] as const;
const BULLETIN_FIELDS = ["effective", "title", "headline", "volcanoCodes", "extraordinary", "text", "nextAdvisory"] as const;
function changed(before: Shown | null, after: Shown | null, fields: readonly string[]): string[] {
  const shown = (value: Shown | null) => value != null && value.effective === "active" && !pending(value) ? value : null;
  const read = (value: Shown | null, field: string): unknown => value == null ? null : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  const left = shown(before), right = shown(after);
  return left == null && right == null ? [] : fields.filter((field) => !isDeepStrictEqual(read(left, field), read(right, field)));
}
const fieldsOf = (value: Shown): readonly string[] => isAlert(value) ? ALERT_FIELDS : isBulletin(value) ? BULLETIN_FIELDS
  : "topAshName" in value ? SCHEDULED_FIELDS : value.subject.includes("/volcano:eruption/") ? ERUPTION_FIELDS : ASHFALL_FIELDS;

// P3-UM-AC04: 通知を作るかの判定の比べ（ほかの使い道は changed のまま、Q-UM-PRECHECK-2 (8)(d)）。名前の欄は (name, scope) で分ける
// （(8)(b)）。(i) は ONE、(ii) は LIST、kind・phenomenon は name だけを (name, kind) の欄にして残りは今の比べ。(iii) 区域の種別名
// （scope「area:」）が前後どちらかの印にあれば、一覧の要素から kindName を除いて鍵を作る。警報は採った側（陸上か海上）の印で比べる。
const ONE: Readonly<Record<string, Extract<CompareColumn, Readonly<{ keys: unknown }>>["keys"]>> = {
  volcanoName: [["name", "volcano"]], coordinate: [["coordinate"]], lastKind: [["lastKind"], ["name", "lastKind"]], eventDateTimeRaw: [["eventTime"]] };
const LIST: Readonly<Record<string, string>> = { municipalities: "対象市町村等", marineAreas: "対象海上予報区", volcanoCodes: "bulletinVolcano" };
const areaKind = (scope: string | undefined) => scope?.startsWith("area:") === true;
const sideMark = (value: Shown | null, marine: boolean): UnreadableMark | undefined => value == null || value.effective !== "active" ? undefined
  : isAlert(value) ? marine ? value.marineUnreadable : value.unreadable : "unreadable" in value ? value.unreadable : undefined;
const without = (value: unknown, key: string): unknown => value != null && typeof value === "object" && key in value ? { ...value, [key]: null } : value;
const nameOf = (value: unknown): unknown => value != null && typeof value === "object" && "name" in value ? value.name : null;
function noticeChange<T extends Shown>(before: T | null, after: T, marine = false): Readonly<{ changed: boolean; after: T }> {
  const shown = (value: T | null) => value != null && value.effective === "active" && !pending(value) ? value : null;
  const read = (value: T | null, field: string): unknown => value == null ? null : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  const left = shown(before), right = shown(after);
  if (left == null && right == null) return { changed: false, after };
  const was = sideMark(left, marine), now = sideMark(right, marine);
  const inner = hasPart(was, "name", areaKind) || hasPart(now, "name", areaKind);
  // 区域の一覧は市町村（code）ごとの要素に開いて鍵を作る（1 つの code が読めない版で区域の全体を新しい要素にしない、r1 ヘルツ P2-2）。
  // code の無い区域は code null の 1 要素。ただし code が全部読めずに空になった区域（その位置の scope の part が印にある）は読めた要素に
  // 数えない（r2 ヘルツ P2-B）。噴火の一覧は code の文字列のまま。
  const items = (value: unknown, list: string, mark: UnreadableMark | undefined): readonly unknown[] => !Array.isArray(value) ? []
    : value.flatMap((item: unknown, index) => {
      if (item == null || typeof item !== "object" || !("codes" in item) || !Array.isArray(item.codes)) return [item];
      const kindName = inner || !("kindName" in item) ? null : item.kindName;
      if (item.codes.length !== 0) return item.codes.map((code: unknown) => ({ kindName, code }));
      return hasPart(mark, list, (scope) => scope === String(index)) ? [] : [{ kindName, code: null }];
    });
  const columns: CompareColumn[] = [];
  let changed = false;
  for (const field of fieldsOf(after)) {
    const one = ONE[field], list = LIST[field], l = read(left, field), r = read(right, field);
    if (one != null) columns.push({ keys: one, before: l, after: r });
    else if (list != null) columns.push({ list, before: items(l, list, was), after: items(r, list, now) });
    else if (field === "kind" || field === "phenomenon") {
      columns.push({ keys: [["name", "kind"]], before: nameOf(l), after: nameOf(r) });
      changed ||= !isDeepStrictEqual(without(l, "name"), without(r, "name"));
    } else changed ||= !isDeepStrictEqual(l, r);
  }
  const compared = compareColumns(was, now, columns);
  const mark = compared.mark;
  return { changed: changed || compared.changed, after: mark == null || mark === now ? after
    : isAlert(after) && marine ? { ...after, marineUnreadable: mark } : { ...after, unreadable: mark } };
}
// P3-UM-AC07: 通知の本文の読めなかった名前（空）は「（読めず）」（報の印の (name, scope) の part で見分ける）。記録の値は空のまま。
const named = (value: string | null, mark: UnreadableMark | null, scope: string): string | null =>
  value === "" && hasPart(mark ?? undefined, "name", (item) => item === scope) ? UNREAD_TEXT : value;

const inactive = (value: VolcanoAlert | null): "ended" | "cancelled" => value?.effective === "cancelled" ? "cancelled" : "ended";
type AlertVerdict = Readonly<{ kind: "adopt"; next: VolcanoAlert; conflict: boolean; missing: boolean }>
  | Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale" | "noChange"; held: Held | null }>;
function alertBase(candidate: VolcanoCandidate, subject: string, code: string, existing: VolcanoAlert | null, eventId: string,
  kind: VolcanoKind | null) {
  const ref = { ...candidate.source, subject };
  const marine = isMarine(candidate.family);
  // landKind は VFVO50・VFVO51 の報だけが書く（VFVO50 の取消で null）。
  const landKind = marine ? existing?.landKind ?? null : candidate.cancelled ? null : kind;
  const source = marine ? existing?.source ?? null : ref, marineSource = marine ? ref : existing?.marineSource ?? null;
  // 取消の identity は版と組で family の側ごとに書く。VFVO51 の entry は既存の land 側を保つ（P3-AUTH-AC03(2)）。
  const landEventId = marine ? existing?.landEventId ?? null : candidate.family === "VFVO51" ? existing?.landEventId ?? candidate.eventId
    : candidate.eventId;
  const marineEventId = marine ? candidate.eventId : existing?.marineEventId ?? null;
  const retainUntil = Math.max(source == null ? -Infinity : reportMs(source), marineSource == null ? -Infinity : reportMs(marineSource))
    + ALERT_RETAIN_MS;
  // P3-NL-AC02 (2)(4): 陸上・海上の通知の印は記録へ引き継ぐ。
  return { subject, operation: candidate.operation, volcanoCode: code, eventId, source, marineSource, landKind, landEventId, marineEventId,
    retainUntil, ...existing?.notice == null ? {} : { notice: existing.notice },
    ...existing?.marineNotice == null ? {} : { marineNotice: existing.marineNotice } };
}
// 比べの欄（noticeChange の ONE・LIST・kind）の part か。一覧の欄は区域の種別名（scope「area:」）の part も含む。
function partOfField(field: string, part: UnreadablePart): boolean {
  const one = field === "kind" ? [["name", "kind"] as const] : ONE[field], list = LIST[field];
  return one?.some(([site, scope]) => part.site === site && part.scope === scope) === true
    || list != null && (part.site === list || part.site === "name" && areaKind(part.scope));
}
// P3-UM-AC01 (5)(6): 採用した側（陸上か海上）の印はその報の印に置き換え、もう一方の側の印は保つ。active でない記録は印を持たない。
// VFVO51 の火山 entry は前の記録の事実の一部を持ち越すので、持ち越した欄の part だけを前の陸の印から compare ごと引き継ぐ。置き換えた
// kind・消した lastKind・headline・municipalities の part はこの報の印に任せる（r1 ヘルツ P2-4・Opus P2-1、r2 ヘルツ P2-A）。持ち越す欄は
// judgeAlert の entry の組み立てのとおり: 同じ区分の継続（kind も前の記録のまま）は全部、区分の変化は火山名・海上の区域・座標だけ。
function alertUnreadable(next: VolcanoAlert, marine: boolean, own: UnreadableMark | null, existing: VolcanoAlert | null, entry = false): VolcanoAlert {
  if (next.effective !== "active") return next;
  const { unreadable: _land, marineUnreadable: _sea, ...rest } = next;
  const other = existing?.effective === "active" ? marine ? existing.unreadable : existing.marineUnreadable : undefined;
  const before = entry && existing?.effective === "active" ? existing : null;
  const carried: readonly string[] = before == null ? [] : next.kind === before.kind ? ALERT_FIELDS : ["volcanoName", "marineAreas", "coordinate"];
  const parts = before?.unreadable?.parts.filter((part) => carried.some((field) => partOfField(field, part))) ?? [];
  const kept = before?.unreadable == null || parts.length === 0 ? own ?? undefined : inheritMark(before.unreadable, parts, own);
  const land = marine ? other : kept, sea = marine ? own ?? undefined : other;
  return { ...rest, ...land == null ? {} : { unreadable: land }, ...sea == null ? {} : { marineUnreadable: sea } };
}
// 一つの警報の報（VFVO50・VFSV・VFVO51 の火山 entry）を記録に当てる。版は自分の family の watermark とだけ比べ、kind は
// 別の family と比べて新しいときだけ取る（同じ版で kind が違えば先着を保って食い違い、P3-C9-MARINE=A）。
function judgeAlert(candidate: VolcanoCandidate, existing: VolcanoAlert | null, subject: string, code: string,
  facts: AlertFacts | null, entry: VolcanoEntry | null): AlertVerdict {
  const marine = isMarine(candidate.family);
  const own = existing == null ? null : marine ? existing.marineSource : existing.source;
  const other = existing == null ? null : marine ? existing.source : existing.marineSource;
  const ref = { ...candidate.source, subject };
  if (own != null && compareVersion(own, ref) === "older") return { kind: "unchanged", reason: "stale", held: null };
  // P3-VM-AC03・AC04: 自分の側（陸上／海上）の系列で版と印を決める。もう一方の側の印は保つ。
  const settle = (next: VolcanoAlert, conflict: boolean, same: () => boolean): AlertVerdict => {
    const version = stepVersion(own == null ? null : { version: own, source: own, cancelled: own.infoTypeRaw === "取消" },
      (marine ? existing?.marineUnconfirmed : existing?.unconfirmed) ?? null, ref, same, candidate.cancelled);
    if (version.kind === "older" || version.kind === "duplicate")
      return { kind: "unchanged", reason: version.kind === "older" ? "stale" : "duplicate", held: null };
    if (version.kind === "held") return { kind: "unchanged", reason: "stale", held: version };
    const { unconfirmed: _land, marineUnconfirmed: _marine, ...rest } = next;
    // 警報全体が取消になる採用では両側の印を外す（系列の情報が取消で消えた、AC04 の (b) の (ii)）。
    const whole = next.effective === "cancelled", kept = whole ? null : (marine ? existing?.unconfirmed : existing?.marineUnconfirmed) ?? null;
    const ownMark = whole ? null : version.mark, land = marine ? kept : ownMark, sea = marine ? ownMark : kept;
    return { kind: "adopt", conflict, missing: version.missing, next: alertUnreadable({ ...rest, ...land == null ? {} : { unconfirmed: land },
      ...sea == null ? {} : { marineUnconfirmed: sea } }, marine, candidate.cancelled ? null : candidate.unreadable, existing, entry != null) };
  };
  const before = existing?.effective === "active" ? existing : null;
  const kind = entry?.kind ?? facts?.kind ?? null;
  // VFVO51 の同じ区分の継続は表示の事実を変えない（VFVO50 の事実を保つ）。land 側の新しい版なので、表示はそのままに landKind（Condition
  // を含む報の値）と source を常に進める（revisionOnly、通知しない。Q-C9-IMPL-AMEND(9)(k)）。同じ版の再送だけが duplicate。
  if (entry != null && before != null && activeKind(entry.kind) && before.kind.code === entry.kind.code)
    return settle({ ...before, ...alertBase(candidate, subject, code, existing, before.eventId, entry.kind) }, false, () => true);
  // 陸上と海上の間の kind も compareVersion で比べ、Control/DateTime の後の方を採る。同じ ReportDateTime で kind が食い違えば
  // volcanoRevisionConflict を残す（P3-VM-AC03、残存リスク (2)）。
  const cross = other == null ? "newer" : compareVersion(other, ref);
  const sameKind = kind == null ? before == null : before != null && activeKind(kind) && before.kind.code === kind.code;
  const takeKind = cross === "newer" || cross === "same" && sameKind;
  const crossConflict = other != null && reportMs(other) === reportMs(ref) && !sameKind && !candidate.cancelled;
  const base = alertBase(candidate, subject, code, existing, entry != null && existing != null ? existing.eventId : candidate.eventId, kind);
  let next: VolcanoAlert;
  if (candidate.cancelled && marine && existing?.source != null) {
    // VFVO50 の source がある記録への VFSV の取消は海上の部分だけを取り消す（P3-C9-MARINE=A）。取消の後の active は、残る VFVO50・VFVO51 が
    // 自分の区分（landKind）で支えるかで決め、支えるならその区分に戻す（Q-C9-IMPL-AMEND(9)(a)）。
    const land = existing.landKind;
    next = before != null && land != null && activeKind(land) ? { ...before, ...base, kind: land, level: levelOf(land.code), marineAreas: [] }
      : { ...base, effective: before != null ? "ended" : inactive(existing) };
  } else if (candidate.cancelled) {
    // VFVO50 の取消と、VFSV だけの記録への VFSV の取消は警報全体を cancelled にする。
    next = { ...base, effective: "cancelled" };
  } else if (!takeKind) {
    // kind は先着（か新しい別 family）のまま。active なら自分の field だけを当てる。
    next = before == null ? { ...base, effective: inactive(existing) } : entry != null ? { ...before, ...base }
      : marine ? { ...before, ...base, marineAreas: facts!.marineAreas, truncated: before.truncated || candidate.truncated }
      : { ...before, ...base, volcanoName: facts!.volcanoName, headline: facts!.headline, municipalities: facts!.municipalities,
        coordinate: facts!.coordinate, truncated: before.truncated || candidate.truncated };
  } else if (kind == null || !activeKind(kind)) {
    // inactive の区分・解除。記録の無い VFVO51 の entry は解除・引下げのときだけ ended を作る（P3-C9-ALERT-ACTIVE=A）。
    if (existing == null && entry != null && !/解除|引下げ/.test(kind?.condition ?? ""))
      return { kind: "unchanged", reason: "noChange", held: null };
    // 記録が inactive なら watermark だけを進める（revisionOnly）。
    next = { ...base, effective: before == null ? inactive(existing) : "ended" };
  } else if (entry != null) {
    // VFVO51 の区分の変化: kind・level を置き換え、前の区分の説明（headline・lastKind・municipalities）を消す。
    next = { ...base, effective: "active", volcanoName: before?.volcanoName ?? entry.volcanoName, kind, lastKind: null,
      level: levelOf(kind.code), headline: null, municipalities: [], marineAreas: before?.marineAreas ?? [],
      coordinate: before?.coordinate ?? null, truncated: (before?.truncated ?? false) || entry.truncated };
  } else if (marine) {
    next = { ...base, effective: "active", volcanoName: before?.volcanoName ?? facts!.volcanoName, kind, lastKind: facts!.lastKind,
      level: levelOf(kind.code), headline: before?.headline ?? null, municipalities: before?.municipalities ?? [],
      marineAreas: facts!.marineAreas, coordinate: before?.coordinate ?? facts!.coordinate,
      truncated: (before?.truncated ?? false) || candidate.truncated };
  } else {
    next = { ...base, effective: "active", volcanoName: facts!.volcanoName, kind, lastKind: facts!.lastKind, level: levelOf(kind.code),
      headline: facts!.headline, municipalities: facts!.municipalities, marineAreas: before?.marineAreas ?? [],
      coordinate: facts!.coordinate, truncated: candidate.truncated };
  }
  // 旧保存で分からない identity（null）は同じ版の再送で埋まっても食い違いにしない。分かっている identity どうしの違いは食い違い（P3-AUTH-AC06(2)）。
  return settle(next, crossConflict, () => existing != null && own?.infoTypeRaw === ref.infoTypeRaw && isDeepStrictEqual(withoutSource(existing),
    withoutSource({ ...next, landEventId: existing.landEventId == null ? null : next.landEventId,
      marineEventId: existing.marineEventId == null ? null : next.marineEventId })));
}

// ---- 噴火・降灰・定時・解説の記録 ----

function eruptionOf(candidate: Candidate<"eruption">, existing: VolcanoEruption | null): VolcanoEruption {
  const subject = `${candidate.operation}/volcano:eruption/${candidate.eventId}`;
  const ms = candidate.reportDateTimeMs;
  const base = { subject, operation: candidate.operation, eventId: candidate.eventId, source: { ...candidate.source, subject },
    retainUntil: ms + ERUPTION_RETAIN_MS };
  if (candidate.facts == null) return { ...base, volcanoCode: candidate.volcanoCode ?? existing?.volcanoCode ?? null, effective: "cancelled" };
  return { ...base, volcanoCode: candidate.volcanoCode!, effective: "active", ...candidate.facts, flash: candidate.family === "VFVO56",
    truncated: candidate.truncated, validUntil: ms + ERUPTION_VALID_MS, ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
}
function ashfallOf(candidate: Candidate<"ashfall">, subject: string, code: string): VolcanoAshfall {
  const base = { subject, operation: candidate.operation, eventId: candidate.eventId, source: { ...candidate.source, subject },
    retainUntil: candidate.reportDateTimeMs + ASHFALL_RETAIN_MS, volcanoCode: code };
  if (candidate.facts == null) return { ...base, effective: "cancelled" };
  return { ...base, effective: "active", variant: candidate.family === "VFVO55" ? "VFVO55" : "VFVO54", ...candidate.facts,
    truncated: candidate.truncated, ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
}
function scheduledOf(candidate: Candidate<"scheduled">, subject: string, code: string, existing: VolcanoScheduledAshfall | null):
  VolcanoScheduledAshfall {
  const name = candidate.unreadable?.parts.find((part) => part.site === "name" && part.scope === "volcano");
  return { subject, operation: candidate.operation, eventId: candidate.eventId, source: { ...candidate.source, subject },
    retainUntil: candidate.reportDateTimeMs + SHORT_RETAIN_MS, volcanoCode: code, effective: candidate.cancelled ? "cancelled" : "active",
    volcanoName: candidate.volcanoName ?? existing?.volcanoName ?? "", topAshName: candidate.cancelled ? existing?.topAshName ?? null
      : candidate.topAshName, ...name == null || candidate.cancelled ? {} : { unreadable: { parts: [{ ...name, raw: null }], headline: null } } };
}
function bulletinOf(candidate: Candidate<"bulletin">): VolcanoBulletin {
  const family: VolcanoBulletin["family"] = candidate.family === "VFVO60" ? "VFVO60" : candidate.family === "VZVO40" ? "VZVO40" : "VFVO51";
  const subject = `${candidate.operation}/${family}/${candidate.eventId}`;
  const base = { subject, family, eventId: candidate.eventId, operation: candidate.operation, source: { ...candidate.source, subject },
    retainUntil: candidate.reportDateTimeMs + SHORT_RETAIN_MS };
  if (candidate.facts == null) return { ...base, effective: "cancelled" };
  const { title, headline, volcanoCodes, extraordinary, text, nextAdvisory } = candidate.facts;
  return { ...base, effective: "active", title, headline, volcanoCodes, extraordinary, truncated: candidate.truncated, text, nextAdvisory,
    ...candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
}
// view・snapshot には見出しだけを載せる（P3-C9-SNAPSHOT=A）。
const headingCache = new WeakMap<ActiveBulletin, VolcanoBulletinView>();
function headingOf(value: ActiveBulletin): VolcanoBulletinView {
  let found = headingCache.get(value);
  if (found == null) {
    const { text: _text, nextAdvisory: _next, ...heading } = value;
    found = shown(heading);
    headingCache.set(value, found);
  }
  return found;
}

type Verdict<T> = Readonly<{ kind: "adopt"; next: T; missing: boolean }>
  | Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale"; held: Held | null }>;
function judge<T extends Exclude<Shown, VolcanoAlert>>(candidate: VolcanoCandidate, existing: T | null, built: T): Verdict<T> {
  // P3-NL-AC02 (2)(4): 通知の印は記録へ引き継ぐ。
  const next = existing?.notice == null ? built : { ...built, notice: existing.notice };
  // 同じ報の速報と詳細は詳細を採り、印は外さない。期限切れの保留の印も外さない（同じ報の対の後着で見える状態に戻さない、P3-EF-AC02 (4)）。
  if (existing != null && sameAshfallReport(next.source, existing.source)) return candidate.family === "VFVO55"
    ? { kind: "adopt", next: { ...next, ...existing.unconfirmed == null ? {} : { unconfirmed: existing.unconfirmed },
      ...pending(existing) && next.effective === "active" ? { expiryPending: true } : {} }, missing: false }
    : { kind: "unchanged", reason: "stale", held: null };
  // expired は事実を捨てた記録なので、同じ版の再受信は事実を比べずに duplicate。ただし取消でない版への同じ時刻の取消は勝つ
  // （作者裁定 2026-10-21 昼）。
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
// P3-VM-AC03: 手元の版を残す報の WARN（比べる時刻の欠けは requiredStructureMissing、同じ版の食い違いは volcanoRevisionConflict）と、
// 系列への印（marine は警報の海上の側）。印の byte は reduce の世代の上界の検査を通る。
function hold<T extends Shown>(applied: Applied, candidate: VolcanoCandidate, values: readonly T[], store: (values: readonly T[]) => VolcanoUnitState,
  subject: string, held: Held, marine = false): void {
  applied.diagnostics.push(held.missing ? missingDiagnostic(candidate) : conflictDiagnostic(candidate));
  const index = indexOf(values, subject), found = values[index ?? -1];
  if (found == null || held.mark == null || (marine && isAlert(found) ? found.marineUnconfirmed : found.unconfirmed) === held.mark) return;
  const marked = marine ? { ...found, marineUnconfirmed: held.mark } : { ...found, unconfirmed: held.mark }; applied.state = store(replaceAt(values, index, marked)); applied.changes.push([found, marked]); // P3-UM-AC19 (1): 印も表示差分に積む（無いと再起動まで view に出ない）
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
// series は通知の系列（警報の海上の側だけ "marine"、P3-NL-AC01 (1)）。
type Notice = Readonly<{ subject: string; series: "" | "marine"; operation: Operation; source: ReportRef; transition: VolcanoIntent["transition"];
  payload: VolcanoNotificationPayload }>;
// 取り消した記録の ReportDateTime と火山名（P3-NL-AC10 (2)）。kind は海上の部分だけの取消の種類。
type Cancelled = Readonly<{ at: string | null; name: string | null; kind?: string }>;
// P3-NL-AC09 (1): 取消を通知するのは、取り消した記録が active だったか、その系列の印に通知の証拠があるとき（H19）。火山名は事実を持つ
// 記録だけが持つ。
function cancelledOf(existing: Shown | null, source: ReportRef | null, mark: NoticeMark | undefined): Cancelled | null {
  if (existing == null || !(existing.effective === "active" && !pending(existing)) && !heard(mark)) return null;
  return { at: source?.reportDateTimeRaw ?? null, name: "volcanoName" in existing ? existing.volcanoName : null };
}
// 題は operationPrefix＋Head/Title から「火山名　山名　」を除いた文字列、訂正・取消は前置き（旧築 notifier.ts の notifyVolcano）。
function noticeOf(candidate: VolcanoCandidate, subject: string, transition: VolcanoIntent["transition"], level: Level,
  summary: string, cancelled: Cancelled | null = null): Notice {
  const prefix = PREFIX[candidate.operation], source = { ...candidate.source, subject };
  const series = subject.includes("/volcano:alert/") && isMarine(candidate.family) ? "marine" as const : "" as const;
  if (candidate.cancelled) {
    const text = cancelText(cancelled?.kind ?? candidate.title, cancelled?.at ?? null, cancelled?.name ?? null);
    return { subject, series, operation: candidate.operation, source, transition, payload: { domain: "volcano",
      level: "cancel", title: prefix + text.title, body: text.body } };
  }
  const correction = candidate.infoRank === 2, body = summary === "" ? candidate.title : summary;
  return { subject, series, operation: candidate.operation, source, transition, payload: { domain: "volcano", level,
    title: prefix + (correction ? `[訂正] ${candidate.title}` : candidate.title), body: correction ? `訂正: ${body}` : body } };
}
function plumeText(value: MaterialValue): string | null {
  if (value.kind === "number") return `噴煙${value.value}m`;
  if (value.kind === "range") return `噴煙${value.value}m${value.bound === "lower" ? "以上" : "以下"}`;
  return value.kind === "unknown" ? "噴煙高度不明" : null;
}
const join = (parts: readonly (string | null)[]) => parts.filter((part): part is string => part != null && part !== "").join(" / ");
// P3-NL-AC01: ID は世代番号を含まない。系列の印に同じ版の鍵と種類があれば作らない（定時の batch の通知は記録を持たない）。
function intentsFor(notice: Notice, now: number, mark: NoticeMark | undefined, version: string): VolcanoIntent[] {
  if (noticed(mark, version, noticeKind(notice.transition))) return [];
  // P3-C9-TRAINING=A: training/test は desktop だけ。
  const channels = notice.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: noticeId("U-V", notice.subject, notice.series, notice.source, notice.transition, channel), unit: "U-V",
    subject: notice.subject, operation: notice.operation, source: notice.source, transition: notice.transition, channel, payload: notice.payload,
    createdAt: now, expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending",
    ...freshState("U-V", notice.operation) }));
}
// 系列の記録の印を読み・書き換える（警報の海上の側は marineNotice）。記録の無い subject（定時の batch）は何もしない。
function seriesMark(state: VolcanoUnitState, subject: string, marine: boolean): NoticeMark | undefined {
  for (const values of [state.alerts, state.eruptions, state.ashfalls, state.scheduledAshfalls, state.bulletins] as const) {
    const found = values[indexOf(values, subject) ?? -1];
    if (found != null) return marine && isAlert(found) ? found.marineNotice : found.notice;
  }
  return undefined;
}
function remark(state: VolcanoUnitState, subject: string, marine: boolean,
  change: (mark: NoticeMark | undefined) => NoticeMark | undefined): VolcanoUnitState {
  const apply = <T extends Shown>(values: readonly T[]): readonly T[] => {
    const at = indexOf(values, subject), found = values[at ?? -1];
    if (found == null) return values;
    const before = marine && isAlert(found) ? found.marineNotice : found.notice, after = change(before);
    return after === before ? values : replaceAt(values, at, marine && isAlert(found) ? { ...found, marineNotice: after } : { ...found, notice: after });
  };
  const alerts = apply(state.alerts), eruptions = apply(state.eruptions), ashfalls = apply(state.ashfalls);
  const scheduledAshfalls = apply(state.scheduledAshfalls), bulletins = apply(state.bulletins);
  return alerts === state.alerts && eruptions === state.eruptions && ashfalls === state.ashfalls && scheduledAshfalls === state.scheduledAshfalls
    && bulletins === state.bulletins ? state : { ...state, alerts, eruptions, ashfalls, scheduledAshfalls, bulletins };
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-V の intent は全部 other の群（P3-C9-NOTICE-GROUP=A）。
function a7Order(left: VolcanoIntent, right: VolcanoIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 海上の部分だけの取消の鍵（`${subject}\nVFSV`）。その subject の VFSV の pending だけを置き換える。
const MARINE_PART = "VFSV";
// Q-NOTICE.capacity と P3-C9-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
// 海上の部分だけの取消（marinePart）の通知は、同じ subject の VFSV の pending だけを置き換える（統合担当の決定、Q-C9-IMPL-AMEND(9)）。
function admit(current: readonly VolcanoIntent[], fresh: readonly VolcanoIntent[], cancelled: ReadonlySet<string>, marinePart = false, replacing: readonly VolcanoIntent[] = fresh):
  Readonly<{ intents: readonly VolcanoIntent[]; admitted: readonly VolcanoIntent[]; dropped: number }> {
  const superseded = new Set<VolcanoIntent>();
  const replaced = new Set(replacing.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (cancelled.has(item.subject) || (!marinePart || isMarine(item.source.family))
      && replaced.has(`${item.subject}\n${item.channel}`) || isMarine(item.source.family) && cancelled.has(`${item.subject}\n${MARINE_PART}`))
      superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => !superseded.has(item)), ...fresh];
  const out = new Set<VolcanoIntent>();
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
  // 新しい intent が容量で外れただけなら、既存の intent は変わらないので元の配列を返す（保存世代を進めない）。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  // P3-NL-AC05 (1)(2): 置換・退去した intent は外す（結果は系列の印に残り、終端記録の予算と回収は無い）。
  const intents = [...current.filter((item) => !superseded.has(item) && !out.has(item)), ...admitted];
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- outcome と view ----

function factsOf(value: Shown): Readonly<Record<string, JsonValue>> {
  if (isBulletin(value)) return value.effective === "active" ? headingFacts(headingOf(value))
    : { family: value.family, eventId: value.eventId, effective: value.effective };
  if (value.effective !== "active") return { eventId: value.eventId, effective: value.effective, volcanoCode: value.volcanoCode };
  // 通知の印（P3-NL-AC02）は outcome の事実に出さない。
  // 読めない所の印（P3-UM-AC01）も出さない（原文の本文を outcome に載せない、P3-UM-D-VIEW）。
  if (isAlert(value)) { const { source: _source, marineSource: _marine, notice: _notice, marineNotice: _sea, unreadable: _land, marineUnreadable: _marineMark,
    ...rest } = value; return rest; }
  const { source: _source, notice: _notice, ...rest } = value;
  if (!("unreadable" in rest)) return rest;
  const { unreadable: _mark, ...facts } = rest;
  return facts;
}
const headingFacts = ({ source: _source, ...rest }: VolcanoBulletinView): Readonly<Record<string, JsonValue>> => rest;
function outcomeOf(value: Shown, changedFields: readonly string[] = [], extra: Readonly<Record<string, JsonValue>> = {}): SubjectOutcome {
  const source = latestSource(value);
  return { subject: value.subject, operation: value.operation, informationType: source.infoTypeRaw, transition: value.effective,
    severity: null, source, facts: { ...factsOf(value), ...extra }, changedFields };
}
// view の subject は識別だけを持つ（事実は alerts などにあり、二重に載せると snapshot の予算を食う。U-Q・U-N の先例）。
const outcomeCache = new WeakMap<Shown, SubjectOutcome>();
function shownOutcome(value: Shown): SubjectOutcome {
  let found = outcomeCache.get(value);
  if (found == null) {
    found = { ...outcomeOf(value), facts: { eventId: value.eventId, effective: value.effective } };
    outcomeCache.set(value, found);
  }
  return found;
}
function displaySubject(value: Shown): Extract<RuntimeDisplaySubject, Readonly<{ unit: "U-V" }>> {
  const current = !visible(value) || "topAshName" in value ? null : isBulletin(value) && value.effective === "active" ? headingOf(value)
    : isBulletin(value) ? null : shown(value);
  return { unit: "U-V", operation: value.operation, subject: value.subject, office: null, current, subjects: [shownOutcome(value)] };
}

// ---- 採用の材料 ----

type Applied = {
  state: VolcanoUnitState;
  verified: boolean; // 受けた入力の根拠が verified か（退去の第 1 段、P3-EF-AC03）
  decisions: Decision[];
  changes: Change[];
  subjects: SubjectOutcome[];
  semantic: boolean;
  notice: Notice | null;
  cancelled: Set<string>;
  diagnostics: DiagnosticDetails[];
  outcomes: PublishedOutcome[];
  evicted: number;
  selfEvicted: number;
};
function emptyApplied(state: VolcanoUnitState, verified: boolean): Applied {
  return { state, verified, decisions: [], changes: [], subjects: [], semantic: false, notice: null, cancelled: new Set(), diagnostics: [], outcomes: [], evicted: 0,
    selfEvicted: 0 };
}
const established = (candidate: VolcanoCandidate) => ({ family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs,
  affectedScope: "subject" as const });
function decide(applied: Applied, candidate: VolcanoCandidate, subject: string, verdict: Readonly<{ kind: "adopt" }> |
  Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>, semantic = false): void {
  applied.decisions.push(verdict.kind === "unchanged"
    ? { subject, operation: candidate.operation, decision: "unchanged", reason: verdict.reason }
    : { subject, operation: candidate.operation, decision: "changed", reason: null, change: semantic ? "semantic" : "revisionOnly",
      currentEstablished: established(candidate) });
}
function conflictDiagnostic(candidate: VolcanoCandidate, count?: number): DiagnosticDetails {
  return { level: "WARN", component: "volcano", reason: "volcanoRevisionConflict", inputId: candidate.source.inputId, unit: "U-V",
    ...count == null ? {} : { count } };
}
function missingDiagnostic(candidate: VolcanoCandidate): DiagnosticDetails {
  return { level: "WARN", component: "volcano", reason: "requiredStructureMissing", inputId: candidate.source.inputId, unit: "U-V" };
}
// P3-C9-SHORTFALL=A: live の採用報が同じ運用区分・slice・火山コードの volcano scope の不足より新しければ除く。
// VFVO51 は採用した entry の火山コードを集めて 1 回で照合する（entry ごとに全件を走査しない、Q-CODEC-IMPL-AMEND(1)）。
function liveShortfalls(list: readonly VolcanoShortfall[], candidate: VolcanoCandidate, slice: VolcanoShortfall["slice"],
  code: string | ReadonlySet<string> | null): readonly VolcanoShortfall[] {
  if (list.length === 0 || code == null) return list;
  const codes = typeof code === "string" ? new Set([code]) : code;
  const newer = (known: VolcanoShortfall["lastKnown"]) => {
    if (known == null) return true;
    const time = candidate.reportDateTimeMs - Date.parse(known.reportDateTimeRaw);
    return time !== 0 ? time > 0 : candidate.source.serialRaw !== "" && known.serialRaw !== ""
      && Number(candidate.source.serialRaw) > Number(known.serialRaw);
  };
  const next = list.filter((item) => !(item.scope === "volcano" && item.operation === candidate.operation && item.slice === slice
    && item.volcanoCode != null && codes.has(item.volcanoCode) && newer(item.lastKnown)));
  return next.length === list.length ? list : next;
}

// 記録 1 件の採用を Applied へ積む（slice の差し替え・退去・変化・outcome・decision）。self の退去では記録を残さない。
function place<T extends Shown>(applied: Applied, values: readonly T[], store: (values: readonly T[]) => VolcanoUnitState, before: T | null,
  after: T, candidate: VolcanoCandidate, now: number, extra: Readonly<Record<string, JsonValue>> = {}): boolean {
  const placed = upsert(values, after, isBulletin(after) ? BULLETIN_LIMIT : SLICE_LIMIT, now, applied.verified);
  if (placed.dropped || placed.self) {
    // 足さなかった記録・自身を退去した記録は accepted に載せず currentEstablished も null（D-VANISHED=A、P3-OPCAP-AC02）。
    // 自身の退去は accepted の change を決める退去に数えず、診断にだけ数える。復旧不足の照合は呼び出し側で今どおり行う。
    if (placed.self) applied.selfEvicted++;
    applied.decisions.push({ subject: after.subject, operation: candidate.operation, decision: "changed", reason: null, change: "revisionOnly",
      currentEstablished: null });
    return false;
  }
  const fields = changed(before, after, fieldsOf(after));
  const semantic = fields.length !== 0 || candidate.cancelled && before?.effective === "active";
  if (placed.evicted != null) applied.evicted++;
  applied.state = store(placed.values);
  if (placed.evicted != null) applied.changes.push([placed.evicted, null]);
  applied.changes.push([before, after]);
  applied.subjects.push(outcomeOf(after, fields, extra));
  applied.semantic ||= semantic || placed.evicted != null;
  decide(applied, candidate, after.subject, { kind: "adopt" }, semantic);
  return true;
}

// ---- 受信（P3-C9-SUBJECTS=A。一入力の変更は一回の参照交換で確定する） ----

// P3-EF-AC13 (6): 結び付く相手が 0 件か 2 件以上の取消は受け取り、手元の記録を変えずに WARN を出す（H51 の B）。2 件以上は印（P3-UM-AC19、undecided）。取り直し（P3-REC-AC05 の (a)）では WARN も印も置かず、2 件以上は版が決まらない本文として noChange（owner が held）、0 件は手元に効く記録が無いので stale（確認を止めない）。
function noTarget<T extends VolcanoAlert | VolcanoAshfall>(applied: Applied, candidate: VolcanoCandidate, target?: Readonly<{ values: readonly T[]; store: (values: readonly T[]) => VolcanoUnitState }>): Applied {
  const found = target == null ? [] : eventMatches(target.values, candidate.operation, eventKey(candidate)), recovering = candidate.source.origin === "recovery";
  if (recovering || target == null || found.length < 2) applied.decisions.push({ subject: "", operation: candidate.operation, decision: "unchanged", reason: recovering && found.length < 2 ? "stale" : "noChange" }); else undecided(applied, candidate, target, found);
  if (!recovering) applied.diagnostics.push(missingDiagnostic(candidate)); return applied;
}
// 火山コードの無い取消は、その slice の記録のうち eventId が一致する記録が一つだけのとき結び付く（P3-C9-CANCEL-SCOPE=A の (2)）。
// 警報は VFVO50 の取消を landEventId、VFSV の取消を marineEventId と照らす（P3-AUTH-AC03(3)）。
function codeOf(values: readonly (VolcanoAlert | VolcanoAshfall | VolcanoScheduledAshfall)[], candidate: VolcanoCandidate): string | null {
  if (candidate.volcanoCode != null) return candidate.volcanoCode;
  const key = eventKey(candidate);
  const found = eventMatches(values, candidate.operation, key);
  return found.length === 1 ? values[found[0]].volcanoCode : null;
}
const dueAt = (value: Shown, now: number) => shownDeadline(value) <= now;

function receiveAlert(state: VolcanoUnitState, candidate: Candidate<"alert">, now: number, verified: boolean): Applied {
  const applied = emptyApplied(state, verified);
  const code = codeOf(state.alerts, candidate);
  if (code == null) return noTarget(applied, candidate, { values: state.alerts, store: (alerts) => ({ ...applied.state, alerts }) });
  const subject = `${candidate.operation}/volcano:alert/${code}`;
  const index = indexOf(state.alerts, subject);
  const existing = index == null ? null : state.alerts[index];
  const verdict = judgeAlert(candidate, existing, subject, code, candidate.facts, null);
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict.held != null && candidate.source.origin === "recovery" ? { kind: "unchanged", reason: "noChange" } : verdict);
    if (verdict.held != null && candidate.source.origin !== "recovery") hold(applied, candidate, state.alerts, (alerts) => ({ ...applied.state, alerts }), subject, verdict.held,
      isMarine(candidate.family));
    return applied;
  }
  if (verdict.conflict) applied.diagnostics.push(conflictDiagnostic(candidate));
  if (verdict.missing) applied.diagnostics.push(missingDiagnostic(candidate));
  const compared = noticeChange(existing, verdict.next, isMarine(candidate.family));
  const next = compared.after;
  const facts = candidate.facts;
  const kept = place(applied, applied.state.alerts, (alerts) => ({ ...applied.state, alerts }), existing, next, candidate, now, facts == null ? {}
    : { volcanoActivity: facts.activity, volcanoPrevention: facts.prevention });
  applied.state = { ...applied.state, shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "alert", code) };
  const before = existing?.effective === "active" ? existing : null;
  if (!kept) return applied;
  // 到着の時点で期限を過ぎた報は通知しないが、取消でなくても前の active を述べる pending を全部撤回する（D-WITHDRAW=A、P3-FINAL-AC04）。
  if (dueAt(next, now)) { if (before != null) applied.cancelled.add(subject); return applied; }
  if (candidate.cancelled && isMarine(candidate.family) && existing?.source != null) {
    // 海上の部分だけの取消: VFSV の pending だけを置き換え、海上警報の取消と分かる通知にする（VFVO50 の通知は残す）。
    applied.cancelled.add(`${subject}\n${MARINE_PART}`);
    // 種類は「火山現象に関する海上警報」（P3-NL-AC10 (3)、2026-10-22 作者裁定）。
    const marine = cancelledOf(existing, existing.marineSource, existing.marineNotice);
    if (marine != null) applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "", { ...marine, kind: "火山現象に関する海上警報" });
    return applied;
  }
  if (candidate.cancelled) {
    applied.cancelled.add(subject);
    const cancelled = isMarine(candidate.family) ? cancelledOf(existing, existing?.marineSource ?? null, existing?.marineNotice)
      : cancelledOf(existing, existing?.source ?? null, existing?.notice);
    if (cancelled != null) applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "", cancelled);
    return applied;
  }
  const kind = facts!.kind;
  // inactiveAdoption: 単独の VFVO50・VFSV の inactive の報を、記録の無い火山か inactive の記録に採用した（P3-C9-ALERT-ACTIVE=A）。
  const inactiveAdoption = before == null && next.effective !== "active" && !activeKind(kind) && (existing == null
    || ["newer", "same"].includes(compareVersion((isMarine(candidate.family) ? existing.source : existing.marineSource) ?? null, candidate.source)));
  const correction = candidate.infoRank === 2;
  if (!correction && !compared.changed && !inactiveAdoption) return applied;
  const releasing = /解除|引下げ/.test(kind.condition ?? "");
  const transition = correction ? "updated" : next.effective === "active" ? before == null ? "activated" : "updated"
    : before != null || releasing ? "released" : "updated";
  const level = isMarine(candidate.family) ? facts!.marineCodes.includes("31") ? "warning" : "normal"
    : inactiveAdoption ? releasing ? "normal" : "info" : alertLevel(kind, before);
  const name = next.effective === "active" ? next.volcanoName : facts!.volcanoName;
  const lv = /^1[1-5]$/.test(kind.code) ? `Lv${Number(kind.code) - 10}` : null;
  applied.notice = noticeOf(candidate, subject, transition, level, join([named(name, candidate.unreadable, "volcano"), lv,
    named(kind.name, candidate.unreadable, "kind")]));
  return applied;
}
// P3-C9-NOTICE-LEVELS=C の VFVO50 の段階。
function alertLevel(kind: VolcanoKind, before: ActiveAlert | null): Level {
  const level = noticeLevel(kind.code), condition = kind.condition ?? "";
  if (/引下げ|解除/.test(condition)) return "normal";
  if (condition === "継続") return level >= 2 ? before?.kind.code === kind.code ? "info" : "normal" : "info";
  return level >= 4 ? "critical" : level >= 2 ? "warning" : "normal";
}

function receiveEruption(state: VolcanoUnitState, candidate: Candidate<"eruption">, now: number, verified: boolean): Applied {
  const applied = emptyApplied(state, verified);
  const subject = `${candidate.operation}/volcano:eruption/${candidate.eventId}`;
  const index = indexOf(state.eruptions, subject);
  const existing = index == null ? null : state.eruptions[index];
  const verdict = judge(candidate, existing, eruptionOf(candidate, existing));
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.held != null) hold(applied, candidate, state.eruptions, (eruptions) => ({ ...applied.state, eruptions }), subject, verdict.held);
    return applied;
  }
  const compared = noticeChange(existing, verdict.next);
  const next = compared.after;
  if (verdict.missing) applied.diagnostics.push(missingDiagnostic(candidate));
  const kept = place(applied, applied.state.eruptions, (eruptions) => ({ ...applied.state, eruptions }), existing, next, candidate, now);
  applied.state = { ...applied.state, shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "eruption", next.volcanoCode) };
  const before = existing?.effective === "active" && !pending(existing) ? existing : null;
  if (!kept) return applied;
  if (dueAt(next, now)) { if (before != null) applied.cancelled.add(subject); return applied; }
  if (candidate.cancelled) {
    applied.cancelled.add(subject);
    const cancelled = cancelledOf(existing, existing?.source ?? null, existing?.notice);
    if (cancelled != null) applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "", cancelled);
    return applied;
  }
  if (candidate.infoRank !== 2 && !compared.changed) return applied;
  const facts = candidate.facts!;
  const plume = facts.plumeAboveCrater;
  const strong = facts.phenomenon.code === "51" || facts.phenomenon.code === "56"
    || (plume.kind === "number" || plume.kind === "range" && plume.bound === "lower") && plume.value >= 3_000;
  const level = candidate.family === "VFVO56" ? "critical" : strong ? "normal" : "info";
  applied.notice = noticeOf(candidate, subject, candidate.infoRank === 2 || before != null ? "updated" : "activated", level,
    join([named(facts.volcanoName, candidate.unreadable, "volcano"), named(facts.phenomenon.name, candidate.unreadable, "kind"), plumeText(plume)]));
  return applied;
}

function receiveAshfall(state: VolcanoUnitState, candidate: Candidate<"ashfall">, clock: ClockReading, verified: boolean): Applied {
  const applied = emptyApplied(state, verified);
  const now = clock.wallTimeMs;
  const code = codeOf(state.ashfalls, candidate);
  if (code == null) return noTarget(applied, candidate, { values: state.ashfalls, store: (ashfalls) => ({ ...applied.state, ashfalls }) });
  const subject = `${candidate.operation}/volcano:ashfall/${code}`;
  const index = indexOf(state.ashfalls, subject);
  const existing = index == null ? null : state.ashfalls[index];
  const verdict = judge(candidate, existing, ashfallOf(candidate, subject, code));
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict.held != null && candidate.source.origin === "recovery" ? { kind: "unchanged", reason: "noChange" } : verdict);
    if (verdict.held != null && candidate.source.origin !== "recovery") hold(applied, candidate, state.ashfalls, (ashfalls) => ({ ...applied.state, ashfalls }), subject, verdict.held);
    return applied;
  }
  const compared = noticeChange(existing, verdict.next);
  const next = compared.after;
  if (verdict.missing) applied.diagnostics.push(missingDiagnostic(candidate));
  // P3-C9-BATCH=A: 採用した VFVO54/55 の前に、同じ運用区分の待機中の batch を通知無しで flush する（interrupted）。stale・duplicate の
  // 再送では flush しない（古い再送で新しい定時の通知を消さない、Q-C9-IMPL-AMEND(6)）。
  if (state.batch != null && state.batch.operation === candidate.operation) {
    const interrupted = flushBatch(state, "interrupted");
    applied.state = interrupted.state;
    applied.outcomes.push(interrupted.outcome);
  }
  const kept = place(applied, applied.state.ashfalls, (ashfalls) => ({ ...applied.state, ashfalls }), existing, next, candidate, now);
  applied.state = { ...applied.state, shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "ashfall", code) };
  const before = existing?.effective === "active" && !pending(existing) ? existing : null;
  if (!kept) return applied;
  if (dueAt(next, now)) { if (before != null) applied.cancelled.add(subject); return applied; }
  if (candidate.cancelled) {
    applied.cancelled.add(subject);
    const cancelled = cancelledOf(existing, existing?.source ?? null, existing?.notice);
    if (cancelled != null) applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "", cancelled);
    return applied;
  }
  if (candidate.infoRank !== 2 && !compared.changed) return applied;
  const facts = candidate.facts!;
  applied.notice = noticeOf(candidate, subject, candidate.infoRank === 2 || before != null ? "updated" : "activated",
    candidate.family === "VFVO54" ? "warning" : "normal",
    join([named(facts.volcanoName, candidate.unreadable, "volcano"), `降灰予報（${candidate.family === "VFVO54" ? "速報" : "詳細"}）`, facts.groups[0]?.ashName ?? null]));
  return applied;
}

function receiveScheduled(state: VolcanoUnitState, candidate: Candidate<"scheduled">, clock: ClockReading, verified: boolean): Applied {
  const applied = emptyApplied(state, verified);
  const now = clock.wallTimeMs;
  const code = codeOf(state.scheduledAshfalls, candidate);
  if (code == null) return noTarget(applied, candidate);
  const subject = `${candidate.operation}/VFVO53/${code}`;
  const index = indexOf(state.scheduledAshfalls, subject);
  const existing = index == null ? null : state.scheduledAshfalls[index];
  const verdict = judge(candidate, existing, scheduledOf(candidate, subject, code, existing));
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.held != null) hold(applied, candidate, state.scheduledAshfalls, (scheduledAshfalls) => ({ ...applied.state, scheduledAshfalls }),
      subject, verdict.held);
    return applied;
  }
  const next = verdict.next;
  if (verdict.missing) applied.diagnostics.push(missingDiagnostic(candidate));
  const inBatch = state.batch?.subjects.includes(subject) ?? false;
  // 鍵（運用区分と ReportDateTime）の違う batch は、新しい報で記録を上書きする前に通知付きで flush する（旧 batch の outcome・通知が
  // 新しい報を引かない）。
  const switching = !candidate.cancelled && !dueAt(next, now) && state.batch != null && (state.batch.operation !== candidate.operation
    || state.batch.reportDateTimeRaw !== candidate.source.reportDateTimeRaw);
  if (switching) {
    const flushed = flushBatch(state, "deadline");
    applied.state = flushed.state;
    applied.outcomes.push(flushed.outcome);
    applied.notice = flushed.notice;
  }
  const kept = place(applied, applied.state.scheduledAshfalls, (scheduledAshfalls) => ({ ...applied.state, scheduledAshfalls }), existing, next,
    candidate, now);
  if (candidate.cancelled) {
    // 取消は batch から対象を外す（P3-C9-BATCH=A）。batch に入っていたか記録が active なら取消を通知する。
    const batch = applied.state.batch;
    if (batch != null && inBatch) {
      const subjects = batch.subjects.filter((item) => item !== subject);
      applied.state = { ...applied.state, batch: subjects.length === 0 ? null : { ...batch, subjects } };
    }
    applied.cancelled.add(subject);
    const cancelled = cancelledOf(existing, existing?.source ?? null, existing?.notice);
    if ((inBatch || cancelled != null) && !dueAt(next, now))
      applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "", cancelled ?? { at: existing?.source.reportDateTimeRaw ?? null,
        name: existing?.volcanoName ?? null });
    return applied;
  }
  if (!kept || dueAt(next, now)) return applied;
  // 20 件でただちに flush する。
  const batch = applied.state.batch;
  const subjects = [...(batch?.subjects ?? []).filter((item) => item !== subject), subject];
  applied.state = { ...applied.state, batch: { operation: candidate.operation, reportDateTimeRaw: candidate.source.reportDateTimeRaw,
    startedAtMonotonicMs: batch?.startedAtMonotonicMs ?? clock.monotonicMs, lastAtMonotonicMs: clock.monotonicMs, subjects } };
  if (subjects.length >= BATCH_LIMIT) {
    const flushed = flushBatch(applied.state, "deadline");
    applied.state = flushed.state;
    applied.outcomes.push(flushed.outcome);
    applied.notice = flushed.notice;
  }
  return applied;
}
// VFVO53 の batch を空にする。notify が null でなければ通知を 1 件作る（interrupted・shutdown は無音、P3-C9-BATCH=A）。
function flushBatch(state: VolcanoUnitState, reason: "deadline" | "interrupted" | "shutdown"): Readonly<{ state: VolcanoUnitState; outcome: PublishedOutcome; notice: Notice | null }> {
  const batch = state.batch!;
  const items = batch.subjects.flatMap((subject) => {
    const index = indexOf(state.scheduledAshfalls, subject);
    const found = index == null ? null : state.scheduledAshfalls[index];
    return found != null && found.effective === "active" ? [found] : [];
  });
  const outcome: PublishedOutcome = { kind: "batchCompleted", reason, subjects: items.map((item) => outcomeOf(item)) };
  const next = { ...state, batch: null };
  if (reason !== "deadline" || items.length === 0) return { state: next, outcome, notice: null };
  const last = items.at(-1)!;
  const subject = `${batch.operation}/VFVO53/batch`;
  // batch の中身が 1 件ならその報の単発の形（旧築 volcano-vfvo53-aggregator.ts の flush）、2 件以上は「{件数}火山: 先頭 3 火山 +残り」。
  // P3-UM-AC07（r1 Opus P2-2）: 読めなかった火山名は「（読めず）」。
  const names = items.map((item) => named(item.volcanoName, item.unreadable ?? null, "volcano"));
  const body = items.length === 1 ? join([names[0], "降灰予報（定時）", last.topAshName])
    : `${items.length}火山: ${names.slice(0, 3).join("、")}${items.length > 3 ? ` +${items.length - 3}` : ""}`;
  return { state: next, outcome, notice: { subject, series: "", operation: batch.operation, source: { ...last.source, subject }, transition: "activated",
    payload: { domain: "volcano", level: "info", title: `${PREFIX[batch.operation]}降灰予報（定時）`, body } } };
}

function receiveBulletin(state: VolcanoUnitState, candidate: Candidate<"bulletin">, now: number, verified: boolean): Applied {
  const applied = emptyApplied(state, verified);
  const built = bulletinOf(candidate), subject = built.subject;
  const index = indexOf(state.bulletins, subject);
  const existing = index == null ? null : state.bulletins[index];
  const verdict = judge(candidate, existing, built);
  let notice: Notice | null = null;
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.held != null) hold(applied, candidate, state.bulletins, (bulletins) => ({ ...applied.state, bulletins }), subject, verdict.held);
  } else {
    const compared = noticeChange(existing, verdict.next);
    const next = compared.after;
    if (verdict.missing) applied.diagnostics.push(missingDiagnostic(candidate));
    const kept = place(applied, applied.state.bulletins, (bulletins) => ({ ...applied.state, bulletins }), existing, next, candidate, now);
    const before = existing?.effective === "active" && !pending(existing) ? existing : null;
    if (kept && !dueAt(next, now)) {
      if (candidate.cancelled) {
        applied.cancelled.add(subject);
        const cancelled = cancelledOf(existing, existing?.source ?? null, existing?.notice);
        if (cancelled != null) notice = noticeOf(candidate, subject, "cancelled", "cancel", "", cancelled);
      } else if (candidate.infoRank === 2 || compared.changed) {
        const facts = candidate.facts!;
        const level = candidate.family === "VFVO51" && facts.extraordinary ? "normal" : "info";
        const summary = candidate.family === "VFVO60" ? `${named(facts.volcanoName, candidate.unreadable, "volcano") ?? ""} 推定噴煙流向報`.trim()
          : facts.headline ?? candidate.title;
        notice = noticeOf(candidate, subject, candidate.infoRank === 2 || before != null ? "updated" : "activated", level, summary);
      }
    } else if (kept && before != null) applied.cancelled.add(subject);
  }
  applied.notice = notice;
  if (candidate.family === "VFVO51" && candidate.entries.length !== 0) applyEntries(applied, candidate, now);
  return applied;
}
// P3-C9-VFVO51-ATOMIC=A: 火山 entry を 1 報の 1 版として扱い、どれか一つでも stale・食い違いなら警報の entry を一つも適用しない。
function applyEntries(applied: Applied, candidate: Candidate<"bulletin">, now: number): void {
  const alerts = applied.state.alerts;
  const verdicts = candidate.entries.map((entry) => {
    const subject = `${candidate.operation}/volcano:alert/${entry.volcanoCode}`;
    const index = indexOf(alerts, subject);
    const existing = index == null ? null : alerts[index];
    return { entry, subject, existing, verdict: judgeAlert(candidate, existing, subject, entry.volcanoCode, null, entry) };
  });
  if (verdicts.some(({ verdict }) => verdict.kind === "unchanged" && verdict.reason === "stale")) {
    for (const { subject } of verdicts) decide(applied, candidate, subject, { kind: "unchanged", reason: "stale" });
    applied.diagnostics.push(conflictDiagnostic(candidate, verdicts.length));
    // 印は手元の版を残した entry の警報にだけ付け、警報の配列は 1 回だけ作り直す（P3-VM-AC04、I-U-V.computation）。
    const marks = new Map(verdicts.flatMap(({ subject, verdict }) => verdict.kind === "unchanged" && verdict.held?.mark != null
      ? [[subject, verdict.held.mark] as const] : []));
    if (marks.size !== 0) applied.state = { ...applied.state, alerts: applied.state.alerts.map((item) => {
      const mark = marks.get(item.subject);
      return mark == null || item.unconfirmed === mark ? item : { ...item, unconfirmed: mark };
    }) };
    return;
  }
  // 陸上と海上の間で同じ ReportDateTime の kind の食い違いは、後の kind を採ったうえで WARN を残す（P3-VM-AC03）。
  const conflicts = verdicts.filter(({ verdict }) => verdict.kind === "adopt" && verdict.conflict).length;
  if (conflicts !== 0) applied.diagnostics.push(conflictDiagnostic(candidate, conflicts));
  // 採用する entry の記録を Map に集め、警報の配列は 1 回だけ作り直す（I-U-V.computation、全国の VFVO51 で entry ごとに作り直さない）。
  const nexts = new Map(verdicts.flatMap(({ verdict }) => verdict.kind === "adopt" ? [[verdict.next.subject, verdict.next] as const] : []));
  // 採用が無ければ警報の配列を作り直さない（参照の比較で保存世代を進めない）。
  if (nexts.size === 0) {
    for (const { subject, verdict } of verdicts) if (verdict.kind === "unchanged") decide(applied, candidate, subject, verdict);
    return;
  }
  const values = alerts.map((item) => nexts.get(item.subject) ?? item);
  const kept = new Set<string>();
  // ponytail: 足す entry ごとに満杯の警報を線形に走査して 1 件退去する（上限は entry 128 × 記録 128、I-U-V.computation）。
  let evicted = 0;
  for (const { existing, verdict } of verdicts) {
    if (verdict.kind !== "adopt") continue;
    // 到着の時点で期限を過ぎた記録の無い entry は足さない（警報の inactive は期限と保持が同じなので回収される側だけ、P3-FINAL-AC01）。
    if (existing == null && shownDeadline(verdict.next) <= now) continue;
    if (existing != null || values.length < SLICE_LIMIT) {
      if (existing == null) values.push(verdict.next);
      kept.add(verdict.next.subject);
      continue;
    }
    // 同じ報が採用する記録は退去の候補にしない。
    const victim = evictOne(values, now, verdict.next.operation, applied.verified, nexts);
    if (victim == null) { applied.selfEvicted++; continue; }
    evicted++;
    values.splice(values.indexOf(victim), 1);
    values.push(verdict.next);
    kept.add(verdict.next.subject);
    applied.changes.push([victim, null]);
  }
  const adoptedCodes = new Set<string>();
  for (const { entry, subject, existing, verdict } of verdicts) {
    if (verdict.kind === "unchanged") { decide(applied, candidate, subject, verdict); continue; }
    // 足さなかった entry・自身を退去した entry は accepted に載せない（D-VANISHED=A、P3-OPCAP-AC02）。
    if (!kept.has(subject)) {
      applied.decisions.push({ subject, operation: candidate.operation, decision: "changed", reason: null, change: "revisionOnly",
        currentEstablished: null });
      adoptedCodes.add(entry.volcanoCode);
      continue;
    }
    const next = verdict.next;
    const fields = changed(existing, next, ALERT_FIELDS);
    applied.changes.push([existing, next]);
    // 到着の時点で期限を過ぎた採用が前の active を置き換えるなら、単独の警報と同じく pending を撤回する（D-WITHDRAW=A、P3-FINAL-AC04）。
    if (existing?.effective === "active" && dueAt(next, now)) applied.cancelled.add(subject);
    applied.subjects.push(outcomeOf(next, fields));
    applied.semantic ||= fields.length !== 0;
    decide(applied, candidate, subject, { kind: "adopt" }, fields.length !== 0);
    adoptedCodes.add(entry.volcanoCode);
  }
  // 警報を一つも変えなければ元の配列を保つ（全 entry を足さなかったとき保存世代を進めない、P3-FINAL-AC01(5)）。
  applied.state = { ...applied.state, alerts: kept.size === 0 ? alerts : values,
    shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "alert", adoptedCodes) };
  applied.evicted += evicted;
  applied.semantic ||= evicted !== 0;
}

// 一入力の Applied を確定する: intent の採用と置換、保存世代、到着の時点で期限を過ぎた記録の同じ reduce での回収。
function finish(state: VolcanoUnitState, applied: Applied, clock: ClockReading, basis: WallBasis): Result {
  const now = clock.wallTimeMs, notice = applied.notice, recovering = notice?.source.origin === "recovery"; // 取り直しは intent を作らず、live の新しい intent が置き換える古い pending だけを外す（P3-REC-D-UNIT-ENTRANCE=A）
  // 版の鍵の digest は受理 1 回に 1 回（P3-NL-AC16）。
  const version = notice == null ? "" : versionDigest(notice.source), marine = notice?.series === "marine";
  const fresh = notice == null ? [] : intentsFor(notice, now, seriesMark(applied.state, notice.subject, marine), version);
  const notices = admit(applied.state.intents, recovering ? [] : fresh, applied.cancelled,
    [...applied.cancelled].some((key) => key.endsWith(`\n${MARINE_PART}`)), fresh);
  // P3-NL-AC02 (3): admit を通った版と種類を系列の記録の印に足す（全 channel が断られた版は入れない）。
  const marked = notice == null || notices.admitted.length === 0 ? applied.state
    : remark(applied.state, notice.subject, marine, (mark) => markNotice(mark, version, noticeKind(notice.transition)));
  if (marked !== applied.state) applied.changes = applied.changes.map(([before, after]) => [before, after == null || after.subject !== notice?.subject
    ? after : noticeRecord(marked, after)]);
  let adopted: VolcanoUnitState = { ...marked, intents: notices.intents };
  // P3-UM-AC03 (3): 原文の合計（三 slice と解説の和）が予算を越えたら古い記録の原文から外す（印は残る）。外した記録の view も変わるので
  // 表示の変化に足す（この入力で触れた記録は after を外した記録に揃える）。
  const slices = adopted;
  const fit = fitRawBudget<Shown>(rawTotal(slices.alerts, slices.eruptions, slices.ashfalls, slices.bulletins), RAW_BUDGET,
    () => [...slices.alerts, ...slices.eruptions, ...slices.ashfalls, ...slices.bulletins], (item) => [recordMs(item), item.subject]);
  if (fit != null) {
    const pairs: Change[] = [], push = (before: Shown, after: Shown) => { pairs.push([before, after]); };
    adopted = { ...adopted, alerts: stripAll(adopted.alerts, fit, push), eruptions: stripAll(adopted.eruptions, fit, push),
      ashfalls: stripAll(adopted.ashfalls, fit, push), bulletins: stripAll(adopted.bulletins, fit, push) };
    const fitted = adopted, touched = new Set(applied.changes.flatMap(([, after]) => after == null ? [] : [after.subject]));
    applied.changes = [...applied.changes.map(([before, after]): Change => [before, after == null ? after : noticeRecord(fitted, after)]),
      ...pairs.filter(([before]) => !touched.has(before!.subject))];
  }
  // 保存しない系列（定時・batch・解説）だけの変化では保存世代を進めない（I-U-V.persisted）。
  const stamped = { ...adopted, persistence: persistedChanged(state, adopted) ? dirty(state.persistence, clock.monotonicMs) : state.persistence };
  const collected = deadlineAt(stamped) <= now ? collect(stamped, clock, basis) : null;
  const next = collected?.state ?? stamped;
  if (collected != null) settle(applied, next);
  const diagnostics = [...applied.diagnostics];
  if (applied.evicted + applied.selfEvicted !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "volcanoCapacityEvicted",
    unit: "U-V", count: applied.evicted + applied.selfEvicted });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "notificationCapacityEvicted", unit: "U-V",
    count: notices.dropped });
  const dropped = droppedIn(fit, [...next.alerts, ...next.eruptions, ...next.ashfalls, ...next.bulletins]);
  if (dropped !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "unreadableDropped", unit: "U-V", count: dropped });
  const outcomes: PublishedOutcome[] = [...applied.outcomes];
  if (applied.decisions.some((item) => item.decision === "changed"))
    outcomes.push({ kind: "accepted", change: applied.semantic ? "semantic" : "revisionOnly", subjects: applied.subjects });
  return { changes: [...applied.changes, ...collected?.changes ?? []],
    step: { state: next, nextDeadline: nextDeadline(next), decisions: applied.decisions, intents: notices.admitted, outcomes, diagnostics } };
}

// 印を付け直した後の同じ subject の記録（表示の変化の after を state の記録に揃える）。
function noticeRecord(state: VolcanoUnitState, value: Shown): Shown {
  const values: readonly Shown[] = isAlert(value) ? state.alerts : isBulletin(value) ? state.bulletins : "topAshName" in value
    ? state.scheduledAshfalls : value.subject.includes("/volcano:eruption/") ? state.eruptions : state.ashfalls;
  return values[indexOf(values, value.subject) ?? -1] ?? value;
}

// 受理の結果を回収の後の記録に揃える（D-OUTCOME=A・D-VANISHED=A、P3-FINAL-AC02）。記録が消えた subject は accepted に載せず
// currentEstablished も null、expired になった subject はその記録で載せ、change は前と最終の表示の差で決める。
// ponytail: 回収のある受理だけで、触れた subject ごとに slice の索引を引く（1 入力の subject は VFVO51 の entry 128 まで、P3-FINAL-RES-01）。
function settle(applied: Applied, state: VolcanoUnitState): void {
  const slice = (value: Shown): readonly Shown[] => isAlert(value) ? state.alerts : isBulletin(value) ? state.bulletins
    : "topAshName" in value ? state.scheduledAshfalls : value.subject.includes("/volcano:eruption/") ? state.eruptions : state.ashfalls;
  const finals = new Map<string, Readonly<{ before: Shown | null; after: Shown; last: Shown | null }>>();
  for (const [before, after] of applied.changes) if (after != null) {
    const values = slice(after);
    finals.set(after.subject, { before, after, last: values[indexOf(values, after.subject) ?? -1] ?? null });
  }
  applied.subjects = applied.subjects.flatMap((item) => {
    const found = finals.get(item.subject);
    if (found == null || found.last === found.after) return [item];
    return found.last == null ? [] : [outcomeOf(found.last, changed(found.before, found.last, fieldsOf(found.last)))];
  });
  applied.decisions = applied.decisions.map((item) => {
    const found = finals.get(item.subject);
    if (item.decision !== "changed" || found == null || found.last === found.after) return item;
    const semantic = changed(found.before, found.last, fieldsOf(found.after)).length !== 0;
    return { ...item, change: semantic ? "semantic" : "revisionOnly", currentEstablished: found.last == null ? null : item.currentEstablished };
  });
  applied.semantic = applied.evicted !== 0 || applied.decisions.some((item) => item.decision === "changed" && item.change === "semantic");
}

function receive(state: VolcanoUnitState, input: Extract<VolcanoInput, { kind: "receive" }>): Result {
  const parsed = parseVolcano(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // P3-REC-AC12（C16 発注 4a）・P3-C9-N2: origin=recovery は候補の作成のときだけ owner から届き、警報 VFVO50 と降灰 VFVO54・55 だけ意味を当てて intent を作らない。版が決まらない本文と相手の決まらない取消は印を置かずに noChange（owner が held にする、P3-REC-AC05 の (a)）。
  if (candidate.source.origin === "recovery" && candidate.family !== "VFVO50" && candidate.family !== "VFVO54" && candidate.family !== "VFVO55") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: "", operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  const now = input.clock.wallTimeMs, basis = input.basis ?? "verified", verified = basis === "verified";
  const applied = candidate.slice === "alert" ? receiveAlert(state, candidate, now, verified)
    : candidate.slice === "eruption" ? receiveEruption(state, candidate, now, verified)
    : candidate.slice === "ashfall" ? receiveAshfall(state, candidate, input.clock, verified)
    : candidate.slice === "scheduled" ? receiveScheduled(state, candidate, input.clock, verified)
    : receiveBulletin(state, candidate, now, verified);
  // 相手の無い取消（noTarget、subject が空の決定）は state 全体を変えない。
  if (applied.decisions.some((item) => item.subject === "")) return { changes: [], step: { ...idle(state),
    decisions: applied.decisions, diagnostics: [...parsed.diagnostics, ...applied.diagnostics] } };
  const result = finish(state, applied, input.clock, basis);
  // 受けた報の読めなかった所の WARN を先に置く（P3-EF-AC13 (2)）。
  return parsed.diagnostics.length === 0 ? result : { ...result, step: { ...result.step, diagnostics: [...parsed.diagnostics, ...result.step.diagnostics] } };
}

// ---- 期限（I-U-V.deadlines。到来分だけを回収・flush する） ----

// 時計の根拠ごとの当て方（P3-EF-AC02）: awaiting は何も当てない。unverified は噴火・降灰の表示の期限の来た記録に保留の印を付けるだけ
// （保存しない解説も同じ）。verified は表示の期限の来た記録と保留の記録（時計によらず）を expired にし（解説は除き）、retainUntil・intent を回収する。
// ponytail: 三 slice 各 128・定時 128・解説 64 の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: VolcanoUnitState, clock: ClockReading, basis: WallBasis): Readonly<{ state: VolcanoUnitState; changes: readonly Change[];
  expiredIntents: number }> {
  const now = clock.wallTimeMs, verified = basis === "verified";
  const none = { state, changes: [], expiredIntents: 0 };
  if (basis === "awaiting") return none;
  const recalls = (values: readonly Shown[]) => verified && (recallMin(values) <= now || pendingMin(values) !== Infinity);
  const shows = { eruptions: eruptionShown(state.eruptions) <= now, ashfalls: ashfallShown(state.ashfalls) <= now,
    bulletins: bulletinShown(state.bulletins) <= now };
  if (!shows.eruptions && !shows.ashfalls && !shows.bulletins && !recalls(state.alerts) && !recalls(state.eruptions) && !recalls(state.ashfalls)
    && !recalls(state.scheduledAshfalls) && !recalls(state.bulletins) && !(verified && intentMin(state.intents) <= now)) return none;
  const changes: Change[] = [];
  // 期限で事実を捨てても、通知の印は記録と同じに残る（P3-NL-AC02 (4)）。
  const expired = <T extends VolcanoEruption | VolcanoAshfall>(item: T) => ({ subject: item.subject, operation: item.operation,
    eventId: item.eventId, source: item.source, retainUntil: item.retainUntil, volcanoCode: item.volcanoCode, effective: "expired" as const,
    ...item.notice == null ? {} : { notice: item.notice } });
  // 警報の active は期限で消えず（alertDeadline）、定時は見えないので、表示の期限の来た active は噴火・降灰・解説だけ。
  const sweep = <T extends Shown>(values: readonly T[], shows: boolean, lapse: (value: T) => T): readonly T[] =>
    !shows && !recalls(values) ? values : values.flatMap((item) => {
      let after: T | null = item;
      if (item.effective === "active" && !isAlert(item) && (pending(item) || shownDeadline(item) <= now)) after = lapse(item);
      // 保留の解説は記憶を持たないので、verified では wall によらず除く（時計が後ろへ直っても元の retainUntil まで残さない、P3-EF-AC02 (3)(7)）。
      if (verified && (after.retainUntil <= now && recallable(after) || isBulletin(after) && pending(after))) after = null;
      if (after === item) return [item];
      changes.push([item, after]);
      return after == null ? [] : [after];
    });
  const alerts = sweep(state.alerts, false, (item) => item);
  const eruptions = sweep<VolcanoEruption>(state.eruptions, shows.eruptions, (item) => verified ? expired(item)
    : pending(item) || item.effective !== "active" ? item : { ...item, expiryPending: true });
  const ashfalls = sweep<VolcanoAshfall>(state.ashfalls, shows.ashfalls, (item) => verified ? { ...expired(item), volcanoCode: item.volcanoCode }
    : pending(item) || item.effective !== "active" ? item : { ...item, expiryPending: true });
  const scheduledAshfalls = sweep(state.scheduledAshfalls, false, (item) => item);
  // 保存しない解説も確かめるまでは回収しない（Q-EF-COST (3) の解説 64）。表示の期限は retainUntil で、来たら保留の印を付け verified で除く。
  const bulletins = sweep<VolcanoBulletin>(state.bulletins, shows.bulletins, (item) => pending(item) || item.effective !== "active" ? item
    : { ...item, expiryPending: true });
  const intents = !verified || intentMin(state.intents) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = state.intents.length - intents.length;
  if (changes.length === 0 && intents === state.intents) return none;
  const next = { ...state, alerts, eruptions, ashfalls, scheduledAshfalls, bulletins, intents };
  return { state: { ...next, persistence: persistedChanged(state, next) ? dirty(state.persistence, clock.monotonicMs) : state.persistence },
    changes, expiredIntents };
}

function deadlineStep(state: VolcanoUnitState, clock: ClockReading, basis: WallBasis, shutdown: boolean): Result {
  const applied = collect(state, clock, basis);
  const due = batchDue(applied.state.batch);
  const flushing = shutdown ? applied.state.batch != null : due != null && due <= clock.monotonicMs;
  const flushed = flushing ? flushBatch(applied.state, shutdown ? "shutdown" : "deadline") : null;
  let next = flushed?.state ?? applied.state;
  let admitted: readonly VolcanoIntent[] = [];
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "volcano",
    reason: "notificationExpired", unit: "U-V", count: applied.expiredIntents }];
  if (flushed?.notice != null) {
    const notices = admit(next.intents, intentsFor(flushed.notice, clock.wallTimeMs, undefined, versionDigest(flushed.notice.source)), new Set());
    // 新しい通知が容量で外れただけ（admit が元の配列を返した）なら保存対象は変わらないので世代を進めない。
    if (notices.intents !== next.intents) next = { ...next, intents: notices.intents, persistence: dirty(next.persistence, clock.monotonicMs) };
    admitted = notices.admitted;
    if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "notificationCapacityEvicted", unit: "U-V",
      count: notices.dropped });
  }
  const subjects = applied.changes.flatMap(([before, after]) => after == null || !visible(before) || pending(after) ? [] : [outcomeOf(after, ["effective"])]);
  const batchSubjects = flushed?.outcome.subjects ?? [];
  const outcomes: PublishedOutcome[] = shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [...subjects, ...batchSubjects] }]
    : [...flushed == null ? [] : [flushed.outcome], ...subjects.length === 0 ? [] : [{ kind: "deadlineApplied" as const, subjects }]];
  return { changes: applied.changes, step: { ...idle(next), intents: admitted, outcomes, diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

// P3-NL-AC02 (3)・AC08 (1): intent の系列の印の証拠を上げる（下げない）。警報の海上の側は VFSV の報の intent。
function raiseNotices(state: VolcanoUnitState, raised: readonly Readonly<{ intent: VolcanoIntent; evidence: NoticeEvidence }>[]): VolcanoUnitState {
  return raised.reduce((next, { intent, evidence }) => remark(next, intent.subject, isMarine(intent.source.family),
    (mark) => mark == null ? mark : raiseEvidence(mark, evidence)), state);
}

function intentUpdate(state: VolcanoUnitState, input: Extract<VolcanoInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, VolcanoIntent>();
  const raised: { intent: VolcanoIntent; evidence: NoticeEvidence }[] = [];
  for (const update of updates) {
    const current = originals.get(update.id);
    const updated = current == null ? null : applyIntentUpdate(current, update);
    if (updated == null) continue;
    changedIntents.set(updated.id, updated);
    const evidence = updateEvidence(updated);
    if (evidence != null) raised.push({ intent: updated, evidence });
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7・C8 の先例）。pending でなくなった intent は外す（P3-NL-AC05 (1)）。
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

// ---- 復旧不足の明示解決（I-U-V.shortfallSemantics、P3-C9-SHORTFALL=A） ----

function resolveShortfall(state: VolcanoUnitState, input: Extract<VolcanoInput, { kind: "shortfallResolution" }>): Result {
  const found = state.shortfalls.find((item) => item.id === input.id);
  const operation = found?.operation ?? "normal";
  const subject = `${operation}/shortfall/${input.id}`;
  const fits = found != null && (input.action === "acknowledgeDomainLoss" ? found.scope === "domain" : found.scope === "volcano");
  if (!fits) return { changes: [], step: { ...idle(state), decisions: [{ subject, operation, decision: "unchanged", reason: "noChange" }] } };
  const shortfalls = state.shortfalls.filter((item) => item !== found);
  let next: VolcanoUnitState = { ...state, shortfalls };
  const changes: Change[] = [];
  if (input.action === "clearCurrent") {
    // そのoperation・火山コードの slice の active の記録を、警報は ended、噴火・降灰は expired にする（通知しない）。
    const matches = (item: { operation: Operation; volcanoCode: string | null; effective: string }) => item.operation === found.operation
      && item.volcanoCode === found.volcanoCode && item.effective === "active";
    const end = <T extends Shown>(values: readonly T[], to: (item: T) => T): readonly T[] => values.map((item) => {
      if (!("volcanoCode" in item) || !matches(item)) return item;
      const after = to(item);
      changes.push([item, after]);
      return after;
    });
    // 通知の印は記録と同じに残る（P3-NL-AC02 (4)）。
    const marks = (item: Shown) => ({ ...item.notice == null ? {} : { notice: item.notice },
      ...isAlert(item) && item.marineNotice != null ? { marineNotice: item.marineNotice } : {} });
    if (found.slice === "alert") next = { ...next, alerts: end<VolcanoAlert>(state.alerts, (item) => ({ subject: item.subject,
      operation: item.operation, volcanoCode: item.volcanoCode, eventId: item.eventId, source: item.source, marineSource: item.marineSource,
      landKind: item.landKind, landEventId: item.landEventId, marineEventId: item.marineEventId,
      retainUntil: item.retainUntil, effective: "ended", ...marks(item) })) };
    if (found.slice === "eruption") next = { ...next, eruptions: end<VolcanoEruption>(state.eruptions, (item) => ({ subject: item.subject,
      operation: item.operation, eventId: item.eventId, source: item.source, retainUntil: item.retainUntil, volcanoCode: item.volcanoCode,
      effective: "expired", ...marks(item) })) };
    if (found.slice === "ashfall") next = { ...next, ashfalls: end<VolcanoAshfall>(state.ashfalls, (item) => ({ subject: item.subject,
      operation: item.operation, eventId: item.eventId, source: item.source, retainUntil: item.retainUntil, volcanoCode: item.volcanoCode,
      effective: "expired", ...marks(item) })) };
  }
  next = { ...next, persistence: dirty(state.persistence, input.clock.monotonicMs) };
  return { changes, step: { ...idle(next), decisions: [{ subject, operation, decision: "changed", reason: null, change: "semantic",
    currentEstablished: null }], outcomes: [{ kind: "accepted", change: "semantic", subjects: changes.flatMap(([, after]) =>
    after == null ? [] : [outcomeOf(after, ["effective"])]) }] } };
}

function restore(state: VolcanoUnitState, persisted: PersistedVolcanoUnit, clock: ClockReading, basis: WallBasis): Result {
  const decoded = volcanoUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "volcano",
    reason: "requiredStructureInvalid", unit: "U-V" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。定時・batch・解説は空から始まる。
  // P3-NL-AC08 (1): started のまま残った pending は通知したか不明として外し、系列の印の証拠を unknown にする。
  const restored = restoreStarted(decoded.state.intents);
  const base = { ...raiseNotices(decoded.state, restored.started.map((intent) => ({ intent, evidence: "unknown" as const }))),
    intents: restored.intents, persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs) };
  const applied = collect(base, clock, basis);
  const active: Shown[] = [...applied.state.alerts, ...applied.state.eruptions, ...applied.state.ashfalls].filter(visible);
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "volcano",
    reason: "notificationExpired", unit: "U-V", count: applied.expiredIntents }];
  if (restored.started.length !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "notificationOutcomeUnknown",
    unit: "U-V", count: restored.started.length });
  return { changes: active.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-V"], coverage: active.map((item) => item.subject), subjects: [] }], diagnostics } };
}

function reduceCore(state: VolcanoUnitState, input: VolcanoInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock, input.basis ?? "verified");
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, input.basis ?? "verified", false);
    case "shutdown": return deadlineStep(state, input.clock, input.basis ?? "verified", true);
    case "receive": return receive(state, input);
    case "shortfallResolution": return resolveShortfall(state, input);
    default: { const missing: never = input; throw new Error(`volcano input ${String(missing)} is not handled`); }
  }
}

function reduceVolcanoUnit(state: VolcanoUnitState, input: VolcanoInput): VolcanoUnitStep {
  const { step, changes } = reduceCore(state, input);
  // P3-CODEC-AC02: 配送予約込みの静的上界（RES-04）は 5 MiB の内側なので、超えるのは上界の破れ（実装の誤り）だけ。保存できない候補を
  // 採らず、入力前の state のまま unit 全体の不整合として拒否する（byte で退去しない）。
  if (persistedChanged(state, step.state) && reservedGenerationBytes(step.state) > GENERATION_LIMIT) return { ...idle(state),
    decisions: [{ subject: "", operation: "normal", decision: "rejected", reason: "requiredStructureInvalid" }],
    diagnostics: [{ level: "ERROR", component: "volcanoGenerationLimit", unit: "U-V", reason: "requiredStructureInvalid", count: 1 }],
    displayChanges: [], confirmationEvidence: [] };
  // 同じ subject の変化は最初の before と最後の after にまとめ、view に出る側（active）だけを表示の変化にする。
  const merged = new Map<string, { before: Shown | null; after: Shown | null }>();
  for (const [before, after] of changes) {
    const key = (after ?? before)!.subject;
    const found = merged.get(key);
    merged.set(key, { before: found == null ? before : found.before, after });
  }
  const displayChanges: VolcanoUnitStep["displayChanges"][number][] = [];
  for (const [subject, { before, after }] of merged) {
    const shownBefore = visible(before) ? before : null, shownAfter = visible(after) ? after : null;
    if (shownBefore === shownAfter) continue;
    displayChanges.push({ unit: "U-V", operation: (after ?? before)!.operation, subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  }
  // 復旧不足も view に載る公開の内容（unavailable・復旧不足を「警報なし」に読み替えない、I-U-V.view）。
  const revised = displayChanges.length !== 0 || step.state.shortfalls !== state.shortfalls;
  if (revised && !Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-V content revision exhausted");
  // P3-C9-N2: U-V は確認 scope を作らない。
  return { ...step, state: revised ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence: [] };
}

function toVolcanoView(state: VolcanoUnitState): VolcanoUnitView {
  const alerts = state.alerts.filter((item): item is ActiveAlert => item.effective === "active");
  const eruptions = state.eruptions.filter((item): item is ActiveEruption => item.effective === "active" && !pending(item));
  const ashfalls = state.ashfalls.filter((item): item is ActiveAshfall => item.effective === "active" && !pending(item));
  const bulletins = state.bulletins.filter((item): item is ActiveBulletin => item.effective === "active" && !pending(item));
  const subjects = [...alerts, ...eruptions, ...ashfalls, ...bulletins].map(shownOutcome);
  return { unit: "U-V", semanticRevision: [...subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`), ...state.shortfalls.map((item) => `shortfall:${item.id}`)].sort().join("|"),
  contentRevision: String(state.contentRevision), subjects, alerts: alerts.map((item) => shown(item)),
  eruptions: eruptions.map((item) => shown(item)), ashfalls: ashfalls.map((item) => shown(item)),
  bulletins: bulletins.map(headingOf), shortfalls: state.shortfalls };
}

// ---- codec（I-U-V.persisted・I-U-V.decode、唯一の VolcanoUnitCodec） ----

type Fields = Readonly<Record<string, unknown>>;
const boundedOrNull = (value: unknown, limit: number): value is string | null => value === null || bounded(value, limit);
const ascii = (value: unknown, limit: number): value is string => isText(value) && asciiCode(value, limit);
const familyOf = (value: unknown) => FAMILIES.find((item) => item === value) ?? null;
// I-U-V.subjects の形（運用区分・slice・火山コードか EventID）。
function subjectOperation(subject: string): Operation | null {
  const [operation, middle, last, ...rest] = subject.split("/");
  const op = operationOf(operation);
  if (op == null || rest.length !== 0 || last == null) return null;
  const valid = middle === "volcano:alert" || middle === "volcano:ashfall" ? validVolcanoCode(last)
    : middle === "VFVO53" ? last === "batch" || validVolcanoCode(last)
    : middle === "volcano:eruption" || middle === "VFVO51" || middle === "VFVO60" || middle === "VZVO40" ? validEventId(last) : false;
  return valid ? op : null;
}
function reportRef(value: unknown, subject: string, families: (family: string) => boolean): ReportRef | null {
  const ref = readReportRef(value, LIMITS.controlDateTime), family = familyOf(ref?.family);
  return ref == null || family == null || !families(family) || ref.subject !== subject
    || !bounded(ref.reportDateTimeRaw, LIMITS.reportDateTime)
    || !Number.isFinite(Date.parse(ref.reportDateTimeRaw)) || !validSerial(ref.serialRaw)
    || !INFO_RANK.has(ref.infoTypeRaw) || subjectOperation(subject) !== ref.operation ? null : ref;
}
// P3-VM-AC04: 未確認の印の読み戻し（鍵が無ければ null、不正か allowed でない記録の鍵なら undefined）。
function markOf(row: Fields, key: "unconfirmed" | "marineUnconfirmed", subject: string, families: (family: string) => boolean,
  allowed: boolean): ReportRef | null | undefined {
  if (!(key in row)) return null;
  const mark = reportRef(row[key], subject, families);
  return mark == null || !allowed ? undefined : mark;
}
function kindRecord(value: unknown): VolcanoKind | null {
  const row = record(value);
  return row == null || !ascii(row.code, LIMITS.code) || !bounded(row.name, BOUNDS.kindName) || !boundedOrNull(row.condition, BOUNDS.condition)
    ? null : { code: row.code, name: row.name, condition: row.condition };
}
function groupsRecord(value: unknown, groups: number, codes: number): VolcanoAreaGroup[] | null {
  const parsed = list(value, (entry) => {
    const row = record(entry);
    const values = list(row?.codes, (code) => ascii(code, LIMITS.areaCode) ? code : null);
    return row == null || values == null || !bounded(row.kindName, BOUNDS.areaKind) ? null : { kindName: row.kindName, codes: values };
  }, groups);
  return parsed == null || parsed.reduce((sum, item) => sum + item.codes.length, 0) > codes ? null : parsed;
}
function materialRecord(value: unknown): MaterialValue | null {
  const row = record(value);
  if (row == null) return null;
  if (row.kind === "missing") return { kind: "missing" };
  if (!bounded(row.raw, BOUNDS.value)) return null;
  if (row.kind === "number" && finite(row.value)) return { kind: "number", value: row.value, raw: row.raw };
  if (row.kind === "text" && bounded(row.value, BOUNDS.value)) return { kind: "text", value: row.value, raw: row.raw };
  if (row.kind === "empty" || row.kind === "unknown") return { kind: row.kind, raw: row.raw };
  if (row.kind === "range" && finite(row.value) && (row.bound === "lower" || row.bound === "upper"))
    return { kind: "range", bound: row.bound, value: row.value, raw: row.raw };
  return null;
}
const ALERT_FACT_KEYS = ["volcanoName", "kind", "lastKind", "level", "headline", "municipalities", "marineAreas", "coordinate", "truncated",
  "unreadable", "marineUnreadable"];
const ERUPTION_FACT_KEYS = ["volcanoName", "flash", "phenomenon", "eventDateTimeRaw", "craterName", "plumeAboveCrater", "plumeAboveSeaLevel",
  "plumeDirection", "headline", "municipalities", "truncated", "validUntil", "expiryPending", "unreadable"];
const ASHFALL_FACT_KEYS = ["volcanoName", "variant", "headline", "forecastStartsAt", "forecastEndsAt", "groups", "omittedGroupCount", "truncated",
  "expiryPending", "unreadable"];
// P3-UM-AC01 (2)（VolcanoUnreadableSite）。
const UNREADABLE_SITES: ReadonlySet<string> = new Set(["serial", "cancelVolcano", "lastKind", "coordinate", "name", "eventTime", "対象市町村等",
  "対象海上予報区", "entries", "bulletinVolcano"] satisfies readonly VolcanoUnreadableSite[]);
// P3-UM-AC04 (2): compareKeys を持てる一覧の欄の site（保存する警報・噴火の一覧。解説は保存しない）。
const LIST_SITES: ReadonlySet<string> = new Set(["対象市町村等", "対象海上予報区"] satisfies readonly VolcanoUnreadableSite[]);
// 印の読み戻し（欄が無ければ {}、形の外は null）。key はその記録で印を持てる欄。
function unreadableOf(row: Fields, key: "unreadable" | "marineUnreadable", allowed = true): Readonly<{ unreadable?: UnreadableMark }> | null {
  if (!(key in row)) return {};
  const mark = allowed ? readUnreadableMark(row[key], UNREADABLE_SITES, LIST_SITES) : null;
  return mark == null ? null : { unreadable: mark };
}
// P3-EF-AC05 (1): 保留の印は active の噴火・降灰にだけ置け、値は true だけ。
const pendingOf = (row: Readonly<Record<string, unknown>>): Readonly<{ expiryPending?: true }> | null => !("expiryPending" in row) ? {}
  : row.expiryPending === true ? { expiryPending: true } : null;
const alertFamily = (family: string): family is VolcanoAlertFamily => family === "VFVO50" || family === "VFVO51";
function alertRecord(value: unknown): VolcanoAlert | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !isText(row.volcanoCode) || !validVolcanoCode(row.volcanoCode) || !isText(row.eventId)
    || !validEventId(row.eventId) || row.subject !== `${operation}/volcano:alert/${row.volcanoCode}`) return null;
  const subject = row.subject;
  const source = row.source === null ? null : reportRef(row.source, subject, alertFamily);
  const marineSource = row.marineSource === null ? null : reportRef(row.marineSource, subject, isMarine);
  if (source == null && row.source !== null || marineSource == null && row.marineSource !== null || source == null && marineSource == null)
    return null;
  const latest = Math.max(source == null ? -Infinity : reportMs(source), marineSource == null ? -Infinity : reportMs(marineSource));
  if (row.retainUntil !== latest + ALERT_RETAIN_MS) return null;
  // landKind は source の family の区分で、source が null なら null（値域と上限は kind と同じ）。
  const landKind = row.landKind === null ? null : kindRecord(row.landKind);
  if (landKind == null && row.landKind !== null || source == null && landKind != null) return null;
  // identity の鍵の無い警報は invalid（移行 A1 の旧保存は版で捨てる、P3-VM-AC08）。
  const land = row.landEventId, marine = row.marineEventId;
  const landEventId = land === null ? null : source != null && isText(land) && validEventId(land) ? land : undefined;
  const marineEventId = marine === null ? null : marineSource != null && isText(marine) && validEventId(marine) ? marine : undefined;
  if (landEventId === undefined || marineEventId === undefined) return null;
  // P3-VM-AC04: 陸上・海上の系列ごとの印。その側の版がある側だけが持つ。
  const landMark = markOf(row, "unconfirmed", subject, alertFamily, source != null);
  const seaMark = markOf(row, "marineUnconfirmed", subject, isMarine, marineSource != null);
  // P3-NL-AC02 (5): 陸上・海上の通知の印も、その側の版がある側だけが持つ。
  const notice = "notice" in row ? source == null ? null : readNoticeMark(row.notice) : undefined;
  const marineNotice = "marineNotice" in row ? marineSource == null ? null : readNoticeMark(row.marineNotice) : undefined;
  if (landMark === undefined || seaMark === undefined || notice === null || marineNotice === null) return null;
  const base = { subject, operation, volcanoCode: row.volcanoCode, eventId: row.eventId, source, marineSource, landKind, landEventId,
    marineEventId, retainUntil: row.retainUntil, ...landMark == null ? {} : { unconfirmed: landMark },
    ...seaMark == null ? {} : { marineUnconfirmed: seaMark }, ...notice == null ? {} : { notice },
    ...marineNotice == null ? {} : { marineNotice } };
  if (row.effective !== "active") {
    // active 以外は事実を持たない（types.ts の判別共用体）。
    if (ALERT_FACT_KEYS.some((key) => key in row)) return null;
    return row.effective === "ended" || row.effective === "cancelled" ? { ...base, effective: row.effective } : null;
  }
  const kind = kindRecord(row.kind), last = record(row.lastKind);
  const lastKind = row.lastKind === null ? null : last != null && ascii(last.code, LIMITS.code) && bounded(last.name, BOUNDS.kindName)
    ? { code: last.code, name: last.name } : undefined;
  const municipalities = groupsRecord(row.municipalities, LIMITS.municipalityGroups, LIMITS.municipalityCodes);
  const marineAreas = groupsRecord(row.marineAreas, LIMITS.marineGroups, LIMITS.marineCodes);
  const level = kind == null ? undefined : levelOf(kind.code);
  // P3-UM-AC01 (5): 陸上・海上の印も、その側の版がある側だけが持つ。
  const landUnreadable = unreadableOf(row, "unreadable", source != null), seaUnreadable = unreadableOf(row, "marineUnreadable", marineSource != null);
  if (kind == null || !activeKind(kind) || row.level !== level || level === undefined || lastKind === undefined || municipalities == null
    || marineAreas == null || !bounded(row.volcanoName, BOUNDS.volcanoName) || !boundedOrNull(row.headline, BOUNDS.headline)
    || !(row.coordinate === null || ascii(row.coordinate, LIMITS.coordinate)) || typeof row.truncated !== "boolean"
    || landUnreadable == null || seaUnreadable == null) return null;
  return { ...base, effective: "active", volcanoName: row.volcanoName, kind, lastKind, level, headline: row.headline, municipalities,
    marineAreas, coordinate: row.coordinate, truncated: row.truncated, ...landUnreadable,
    ...seaUnreadable.unreadable == null ? {} : { marineUnreadable: seaUnreadable.unreadable } };
}
function eruptionRecord(value: unknown): VolcanoEruption | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !isText(row.eventId) || !validEventId(row.eventId)
    || row.subject !== `${operation}/volcano:eruption/${row.eventId}`) return null;
  const subject = row.subject;
  const families = (family: string) => family === "VFVO52" || family === "VFVO56";
  const source = reportRef(row.source, subject, families), mark = markOf(row, "unconfirmed", subject, families, true);
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (source == null || mark === undefined || notice === null || row.retainUntil !== reportMs(source) + ERUPTION_RETAIN_MS) return null;
  const base = { subject, operation, eventId: row.eventId, source, retainUntil: row.retainUntil, ...mark == null ? {} : { unconfirmed: mark },
    ...notice == null ? {} : { notice } };
  if (row.effective !== "active") {
    if (ERUPTION_FACT_KEYS.some((key) => key in row) || !(row.volcanoCode === null || isText(row.volcanoCode) && validVolcanoCode(row.volcanoCode)))
      return null;
    return row.effective === "cancelled" || row.effective === "expired" ? { ...base, volcanoCode: row.volcanoCode, effective: row.effective } : null;
  }
  const phenomenon = record(row.phenomenon);
  const crater = materialRecord(row.plumeAboveCrater), seaLevel = materialRecord(row.plumeAboveSeaLevel);
  const municipalities = list(row.municipalities, (code) => ascii(code, LIMITS.areaCode) ? code : null, LIMITS.eruptionAreas);
  if (!isText(row.volcanoCode) || !validVolcanoCode(row.volcanoCode) || phenomenon == null || !ascii(phenomenon.code, LIMITS.code)
    || !bounded(phenomenon.name, BOUNDS.phenomenon) || crater == null || seaLevel == null || municipalities == null
    || !bounded(row.volcanoName, BOUNDS.volcanoName) || typeof row.flash !== "boolean"
    || !(row.eventDateTimeRaw === null || ascii(row.eventDateTimeRaw, LIMITS.eventDateTime)) || !boundedOrNull(row.craterName, BOUNDS.crater)
    || !boundedOrNull(row.plumeDirection, BOUNDS.direction) || !boundedOrNull(row.headline, BOUNDS.headline)
    || typeof row.truncated !== "boolean" || row.validUntil !== reportMs(source) + ERUPTION_VALID_MS) return null;
  const lapsed = pendingOf(row), unreadable = unreadableOf(row, "unreadable");
  if (lapsed == null || unreadable == null) return null;
  return { ...base, volcanoCode: row.volcanoCode, effective: "active", volcanoName: row.volcanoName, flash: row.flash,
    phenomenon: { code: phenomenon.code, name: phenomenon.name }, eventDateTimeRaw: row.eventDateTimeRaw, craterName: row.craterName,
    plumeAboveCrater: crater, plumeAboveSeaLevel: seaLevel, plumeDirection: row.plumeDirection, headline: row.headline, municipalities,
    truncated: row.truncated, validUntil: row.validUntil, ...lapsed, ...unreadable };
}
function ashGroupRecord(value: unknown, startsAt: number, endsAt: number): VolcanoAshfallGroup | null {
  const row = record(value);
  const hazardClass = row?.hazardClass === "ballistic" || row?.hazardClass === "ash" || row?.hazardClass === "unknown" ? row.hazardClass : null;
  const topAreas = list(row?.topAreas, (entry) => {
    const area = record(entry);
    return area == null || !(area.code === null || ascii(area.code, LIMITS.areaCode)) || !bounded(area.name, BOUNDS.areaName)
      || !finite(area.firstForecastEndAt) || area.firstForecastEndAt <= startsAt || area.firstForecastEndAt > endsAt ? null
      : { code: area.code, name: area.name, firstForecastEndAt: area.firstForecastEndAt };
  }, ASH.topAreas);
  if (row == null || hazardClass == null || topAreas == null || !ascii(row.ashCode, LIMITS.code) || !bounded(row.ashName, BOUNDS.ashName)
    || hazardClass !== (ASH_ORDER.get(row.ashCode)?.hazardClass ?? "unknown") || !count(row.areaCount) || row.areaCount < 1
    || !count(row.omittedAreaCount) || topAreas.length !== Math.min(ASH.topAreas, row.areaCount)
    || row.areaCount !== topAreas.length + row.omittedAreaCount || row.areaCount > ASH.areas) return null;
  return { hazardClass, ashCode: row.ashCode, ashName: row.ashName, areaCount: row.areaCount, topAreas, omittedAreaCount: row.omittedAreaCount };
}
function ashfallRecord(value: unknown): VolcanoAshfall | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !isText(row.volcanoCode) || !validVolcanoCode(row.volcanoCode) || !isText(row.eventId)
    || !validEventId(row.eventId) || row.subject !== `${operation}/volcano:ashfall/${row.volcanoCode}`) return null;
  const subject = row.subject;
  const families = (family: string) => family === "VFVO54" || family === "VFVO55";
  const source = reportRef(row.source, subject, families), mark = markOf(row, "unconfirmed", subject, families, true);
  const notice = "notice" in row ? readNoticeMark(row.notice) : undefined;
  if (source == null || mark === undefined || notice === null || row.retainUntil !== reportMs(source) + ASHFALL_RETAIN_MS) return null;
  const base = { subject, operation, eventId: row.eventId, source, retainUntil: row.retainUntil, volcanoCode: row.volcanoCode,
    ...mark == null ? {} : { unconfirmed: mark }, ...notice == null ? {} : { notice } };
  if (row.effective !== "active") {
    if (ASHFALL_FACT_KEYS.some((key) => key in row)) return null;
    return row.effective === "cancelled" || row.effective === "expired" ? { ...base, effective: row.effective } : null;
  }
  const at = reportMs(source);
  // P3-C9-ASHFALL-PROJECTION=A の予報の期間の上限。
  if (!finite(row.forecastStartsAt) || !finite(row.forecastEndsAt) || row.forecastStartsAt >= row.forecastEndsAt
    || row.forecastEndsAt - row.forecastStartsAt > ASH.spanMs || row.forecastStartsAt < at - ASH.beforeReportMs
    || row.forecastEndsAt > at + ASH.spanMs) return null;
  const starts = row.forecastStartsAt, ends = row.forecastEndsAt;
  const groups = list(row.groups, (entry) => ashGroupRecord(entry, starts, ends), ASH.groups);
  if (groups == null || (row.variant !== "VFVO54" && row.variant !== "VFVO55") || !bounded(row.volcanoName, BOUNDS.volcanoName)
    || !boundedOrNull(row.headline, BOUNDS.headline) || !count(row.omittedGroupCount) || typeof row.truncated !== "boolean") return null;
  const lapsed = pendingOf(row), unreadable = unreadableOf(row, "unreadable");
  if (lapsed == null || unreadable == null) return null;
  return { ...base, effective: "active", volcanoName: row.volcanoName, variant: row.variant, headline: row.headline, forecastStartsAt: starts,
    forecastEndsAt: ends, groups, omittedGroupCount: row.omittedGroupCount, truncated: row.truncated, ...lapsed, ...unreadable };
}
const SHORTFALL_REASONS = ["provenanceMissing", "sliceCorrupt", "gateCorrupt", "operationUnknown", "terminalQuarantine"] as const;
function shortfallRecord(value: unknown): VolcanoShortfall | null {
  const row = record(value), known = record(row?.lastKnown);
  const operation = operationOf(row?.operation);
  const slice = row?.slice === "alert" || row?.slice === "eruption" || row?.slice === "ashfall" ? row.slice : null;
  const scope = row?.scope === "volcano" || row?.scope === "domain" ? row.scope : null;
  const reason = SHORTFALL_REASONS.find((item) => item === row?.reason);
  const lastKnown = row?.lastKnown === null ? null : known != null && bounded(known.reportDateTimeRaw, LIMITS.reportDateTime)
    && Number.isFinite(Date.parse(known.reportDateTimeRaw)) && isText(known.serialRaw) && validSerial(known.serialRaw)
    ? { reportDateTimeRaw: known.reportDateTimeRaw, serialRaw: known.serialRaw } : undefined;
  // volcanoCode は scope が volcano のときだけ持つ。
  const code = scope === "volcano" ? isText(row?.volcanoCode) && validVolcanoCode(row.volcanoCode) ? row.volcanoCode : undefined
    : row?.volcanoCode === null ? null : undefined;
  if (row == null || operation == null || slice == null || scope == null || reason == null || lastKnown === undefined || code === undefined
    || !ascii(row.id, 64)) return null;
  return { id: row.id, operation, slice, scope, volcanoCode: code, lastKnown, reason };
}
const LEVEL_SET: readonly Level[] = ["info", "normal", "warning", "critical", "cancel"];
function intentRecord(value: unknown): VolcanoIntent | null {
  const row = record(value), payload = record(row?.payload);
  const operation = operationOf(row?.operation);
  const source = isText(row?.subject) ? reportRef(row.source, row.subject, () => true) : null;
  const level = LEVEL_SET.find((entry) => entry === payload?.level);
  const channel = row?.channel === "desktop" || row?.channel === "sound" ? row.channel : null;
  const transition = (["activated", "updated", "cancelled", "released", "expired"] as const).find((entry) => entry === row?.transition);
  const fields = row == null || operation == null ? null : readIntentState(row, "U-V", operation, level), recovered = payload == null ? null : recoveredPayload(payload);
  // state に残る subject との一致は求めない（解説・定時は復元で空になる、I-U-V.decode）。H27 の 2 欄は対で読む（P3-REC-AC12）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || fields == null || recovered == null || !isText(row.id) || row.unit !== "U-V" || !isText(row.subject) || subjectOperation(row.subject) !== operation
    || source.operation !== operation || payload.domain !== "volcano" || !isText(payload.title) || payload.title === ""
    || !isText(payload.body) || payload.body === "" || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt)
    || !count(row.attempts) || !isText(row.configRevision) || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-V", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "volcano", level, title: payload.title, body: payload.body, ...recovered }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision,
    disposition: "pending", ...fields };
}
const unique = (values: readonly { subject: string }[]) => new Set(values.map((item) => item.subject)).size === values.length;
function persisted(value: unknown): PersistedVolcanoUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  const alerts = list(row.alerts, alertRecord, SLICE_LIMIT), eruptions = list(row.eruptions, eruptionRecord, SLICE_LIMIT);
  const ashfalls = list(row.ashfalls, ashfallRecord, SLICE_LIMIT), shortfalls = list(row.shortfalls, shortfallRecord, SHORTFALL_LIMIT);
  const intents = list(row.intents, intentRecord);
  if (alerts == null || eruptions == null || ashfalls == null || shortfalls == null || intents == null || !unique(alerts)
    || !unique(eruptions) || !unique(ashfalls) || new Set(shortfalls.map((item) => item.id)).size !== shortfalls.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。保存する intent は pending だけ（P3-NL-AC05）。
  const pendingBytes = listBytes(intents) + intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedVolcanoUnit = { schemaVersion: SCHEMA, alerts, eruptions, ashfalls, shortfalls, intents };
  // P3-UM-AC16 (3)(c)（AC03 (1) の数え方）。
  if (intents.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || generationBytes(result) > GENERATION_LIMIT
    || rawTotal(alerts, eruptions, ashfalls) > RAW_BUDGET) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const volcanoUnitCodec: VolcanoUnitCodec = {
  schemaVersion: SCHEMA, maxEnvelopeBytes: GENERATION_LIMIT, // P3-VM-AC05・AC06（修正波 3）: 保存 1 世代の上限。旧い版の一覧は持たない（P3-MIG-AC01・AC02: 版を上げても一覧に足さず、開発機の保存を消す）
  // 定時・batch・解説・contentRevision・persistence は保存しない（I-U-V.persisted、spec:484・:504 の N）。
  encode: (state) => ({ schemaVersion: SCHEMA, alerts: state.alerts, eruptions: state.eruptions, ashfalls: state.ashfalls,
    shortfalls: state.shortfalls, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: `invalid ${SCHEMA} payload` }
      : { kind: "restored", state: { ...value, contentRevision: 0, scheduledAshfalls: [], batch: null, bulletins: [],
        persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-V.runtimeRows）。
const volcanoUnit = {
  unit: "U-V",
  reduce: reduceVolcanoUnit,
  toView: toVolcanoView,
  persistence: { kind: "durable", codec: volcanoUnitCodec },
  confirmationScopeLimit: 512,
  reclaimDeadlineBeforeReceive: true,
  recoveryNotices: (open, adopted, at) => recoveryNotices(open, adopted, at.clock),
  recoveryChanges,
} satisfies UnitModule<"U-V">;

// ---- 取消の相手が決まらない（P3-UM-AC19、H51 の表の 4 行目） ----

const eventKey = (candidate: VolcanoCandidate): string =>
  candidate.slice !== "alert" ? candidate.eventId : `${isMarine(candidate.family) ? "marine" : "land"}\n${candidate.eventId}`;
// (1): eventId の当たる 2 件以上の記録（警報・降灰予報）の全部に「決められなかった」の印（取消の報の ReportRef で subject を記録の subject に
// 替える。海上の警報は marineUnconfirmed）を付け、記録ごとの subject の決定と [before, after] を積む（subject が空の決定は receive の早期 return で
// state ごと捨てられ、changes が無いと印が保存・再起動の後の view で初めて見える）。通知は作らない。
function undecided<T extends VolcanoAlert | VolcanoAshfall>(applied: Applied, candidate: VolcanoCandidate,
  target: Readonly<{ values: readonly T[]; store: (values: readonly T[]) => VolcanoUnitState }>, found: readonly number[]): void {
  const marine = candidate.slice === "alert" && isMarine(candidate.family), values = [...target.values];
  for (const at of found) {
    const before = values[at], mark = { ...candidate.source, subject: before.subject };
    decide(applied, candidate, before.subject, { kind: "unchanged", reason: "noChange" });
    if (isDeepStrictEqual(marine && isAlert(before) ? before.marineUnconfirmed : before.unconfirmed, mark)) continue;
    const after = marine && isAlert(before) ? { ...before, marineUnconfirmed: mark } : { ...before, unconfirmed: mark };
    values[at] = after;
    applied.changes.push([before, after]);
  }
  applied.state = target.store(values);
}

// ---- 取り直しの採用の step（P3-RECOVERY-001 発注 4a、P3-REC-AC10・P3-REC-D-N2-RAISE=A） ----

// H27 の段は警報のレベル（P3-C9-NOTICE-LEVELS=C の対応の後）。active でない火山と記録の無い火山はレベル 1 と読む。
const raiseLevel = (value: VolcanoAlert | undefined): number => value?.effective === "active" ? noticeLevel(value.kind.code) : 1;

/**
 * 候補の部分集合の検査の後に、採用の step で作る H27 の intent（P3-REC-AC10）。open は取り直しを始めた時の state（P3-REC-D-RAISE-BASIS=A）、
 * candidate は採用する state。陸上の警報のレベルが open より上がり、いまも active な火山のうちレベルの最も高い 1 件に info を 1 回（取り直し 1 回で
 * unit に 1 件）。降灰は鳴らさない。通知済みの版（K8 の印）は選ぶ前に除く。無ければ candidate をそのまま返す。
 */
function recoveryNotices(open: VolcanoUnitState, candidate: VolcanoUnitState, clock: ClockReading): VolcanoUnitState {
  const now = clock.wallTimeMs, before = new Map(open.alerts.map((item) => [item.subject, item]));
  let best: Readonly<{ alert: ActiveAlert; source: ReportRef; level: number }> | null = null;
  for (const alert of candidate.alerts) {
    const level = raiseLevel(alert);
    if (alert.effective !== "active" || alert.source == null || level <= raiseLevel(before.get(alert.subject))) continue;
    if (noticed(alert.notice, versionDigest(alert.source), noticeKind("updated"))) continue;
    if (best == null || level > best.level) best = { alert, source: alert.source, level };
  }
  if (best == null) return candidate;
  const { alert, source } = best, version = versionDigest(source);
  const at = new Date(reportMs(source) + 32_400_000).toISOString().slice(11, 16);
  const lv = /^1[1-5]$/.test(alert.kind.code) ? `Lv${Number(alert.kind.code) - 10}` : null;
  const notice: Notice = { subject: alert.subject, series: "", operation: alert.operation, source, transition: "updated",
    payload: { domain: "volcano", level: "info", title: `${PREFIX[alert.operation]}噴火警報・予報（${at} 発表）`,
      body: join([alert.volcanoName, lv, alert.kind.name]), reportDateTime: source.reportDateTimeRaw, recovered: true } };
  const notices = admit(candidate.intents, intentsFor(notice, now, alert.notice, version), new Set());
  if (notices.admitted.length === 0) return candidate;
  // P3-NL-AC02 (3): 引上げの版と種類を陸上の系列の印に足す。
  return { ...remark(candidate, alert.subject, false, (mark) => markNotice(mark, version, noticeKind("updated"))), intents: notices.intents };
}

// P3-REC-AC07（投影の直し、Q-REC-PRECHECK-7 の N2）: 取り直しの採用の step の正味の表示の変化（採用の直前の live → 最終の state）。
// 両状態の記録を鍵の Map で突き合わせ、reduce の merged の loop と同じ述語・displaySubject・鍵で作る。同じ参照の記録は省く（O(N前＋N後)）。
function recoveryChanges(before: VolcanoUnitState, after: VolcanoUnitState): VolcanoUnitStep["displayChanges"] {
  const old = new Map<string, Shown>();
  for (const item of before.alerts) old.set(item.subject, item); for (const item of before.eruptions) old.set(item.subject, item); for (const item of before.ashfalls) old.set(item.subject, item); for (const item of before.bulletins) old.set(item.subject, item);
  const changes: VolcanoUnitStep["displayChanges"][number][] = [];
  const add = (was: Shown | null, now: Shown | null) => {
    const shownBefore = visible(was) ? was : null, shownAfter = visible(now) ? now : null;
    if (shownBefore === shownAfter) return;
    const value = (now ?? was)!;
    changes.push({ unit: "U-V", operation: value.operation, subject: value.subject,
      before: shownBefore == null ? null : displaySubject(shownBefore), after: shownAfter == null ? null : displaySubject(shownAfter) });
  };
  for (const item of [...after.alerts, ...after.eruptions, ...after.ashfalls, ...after.bulletins]) { add(old.get(item.subject) ?? null, item); old.delete(item.subject); }
  for (const item of old.values()) add(item, null);
  return changes;
}

export { recoveryChanges, recoveryNotices, reduceVolcanoUnit, toVolcanoView, volcanoUnit, volcanoUnitCodec };
