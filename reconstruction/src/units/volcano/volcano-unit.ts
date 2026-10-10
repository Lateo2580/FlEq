import { isDeepStrictEqual } from "node:util";

import type { MaterialValue, Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, JsonValue, PersistenceStatus, PublishedOutcome, ReportRef, RuntimeDisplaySubject,
  RuntimeUnitDeadline, SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  PersistedVolcanoUnit, VolcanoAlert, VolcanoAlertFamily, VolcanoAreaGroup, VolcanoAshfall, VolcanoAshfallBatch, VolcanoAshfallGroup,
  VolcanoBulletin, VolcanoBulletinView, VolcanoEruption, VolcanoInput, VolcanoIntent, VolcanoKind, VolcanoNotificationPayload,
  VolcanoScheduledAshfall, VolcanoShortfall, VolcanoUnitCodec, VolcanoUnitState, VolcanoUnitStep, VolcanoUnitView,
} from "../../../contracts/p3-volcano-unit.types";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { serializedEnvelope } from "../../checkpoint/checkpoint";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import {
  ASH, ASH_ORDER, BOUNDS, FAMILIES, INFO_RANK, LIMITS, asciiCode, isMarine, parseVolcano, validEventId, validSerial, validVolcanoCode,
} from "../../domains/volcano/volcano";
import type { AlertFacts, VolcanoCandidate, VolcanoEntry } from "../../domains/volcano/volcano";

// P3-UNIT-V-001（C9、I-U-V）: U-V の三 slice・定時・batch・解説・復旧不足・通知・容量・codec・射影。

const SCHEMA = "p3-volcano-unit-v1" as const;
// P3-C9-CAPACITY=A・P3-C9-RES-01・RET-01〜06。世代の上限は P3-CODEC-D-LIMIT=A（K5、当初 4 MiB）。
const SLICE_LIMIT = 128, BULLETIN_LIMIT = 64, SHORTFALL_LIMIT = 128, BATCH_LIMIT = 20, GENERATION_LIMIT = 5_242_880;
const PENDING_ITEMS = 128, PENDING_BYTES = 131_072, TERMINAL_BYTES = 98_304;
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
const visible = (value: Shown | null): boolean => value != null && value.effective === "active" && !("topAshName" in value);
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
// 終端記録の合計（区切りの 1 byte を含む）。受理と decode で同じ式を使う（Q-NOTICE.capacity）。
const terminalBytes = (intents: readonly VolcanoIntent[]): number =>
  intents.reduce((sum, item) => item.disposition === "pending" ? sum : sum + bytes(item) + 1, 0);
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-V", generation: 0, capturedAt: 0,
  payload: { schemaVersion: SCHEMA, alerts: [], eruptions: [], ashfalls: [], shortfalls: [], intents: [] }, sha256: "0".repeat(64) }).byteLength;
// 62: generation と capturedAt が 0 から 32 桁まで伸びる分（U-F・U-T・U-Q・U-N と同じ予約）。10: 空の配列 5 つ。
function generationBytes(value: PersistedVolcanoUnit): number {
  return emptyEnvelopeBytes + 62 - 10 + listBytes(value.alerts) + listBytes(value.eruptions) + listBytes(value.ashfalls)
    + listBytes(value.shortfalls) + listBytes(value.intents);
}
// 配送の更新で伸びうる分（pending の deliveryGrowth）を 1 回だけ足した世代の byte（P3-CODEC-RES-01）。
const reservedGenerationBytes = (value: PersistedVolcanoUnit): number => generationBytes(value)
  + value.intents.reduce((sum, item) => item.disposition === "pending" ? sum + deliveryGrowth(item) : sum, 0);

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

// P3-C9-CAPACITY=A: 上限を超える 1 件は (1) retainUntil を過ぎた記録 (2) inactive (3) training/test (4) 受ける報が normal のときだけ normal、
// それぞれ ReportDateTime の古い順で退去する。受ける報が training/test で (1)〜(3) が無ければ、受けた記録自身を退去する（null）。
// ponytail: 満杯の slice の素朴な線形の走査（1 入力の上限は VFVO51 の entry 128 × 記録 128、上限は保持と decode で効く）。
function evictOne<T extends Shown>(values: readonly T[], now: number, incoming: Operation,
  skip: ReadonlyMap<string, unknown> = new Map()): T | null {
  const tier = (item: T) => item.retainUntil <= now && !(isAlert(item) && item.effective === "active") ? 0
    : item.effective !== "active" ? 1 : item.operation !== "normal" ? 2 : 3;
  let worst: T | null = null;
  for (const item of values) {
    if (tier(item) === 3 && incoming !== "normal" || skip.has(item.subject)) continue;
    const order = worst == null ? -1 : tier(item) - tier(worst) || recordMs(item) - recordMs(worst)
      || (item.subject < worst.subject ? -1 : item.subject > worst.subject ? 1 : 0);
    if (order < 0) worst = item;
  }
  return worst;
}
// 記録を置き換えるか足す。足すときに上限なら 1 件退去する（self は受けた記録自身の退去）。
function upsert<T extends Shown>(values: readonly T[], value: T, limit: number, now: number):
  Readonly<{ values: readonly T[]; evicted: T | null; self: boolean }> {
  const index = indexOf(values, value.subject);
  if (index != null || values.length < limit) return { values: replaceAt(values, index, value), evicted: null, self: false };
  const victim = evictOne(values, now, value.operation);
  return victim == null ? { values, evicted: null, self: true }
    : { values: [...values.filter((item) => item !== victim), value], evicted: victim, self: false };
}

// ---- 版の比較（Q-ENUM.revisionOrder） ----

// P3-ORDER-AC01: ReportDateTime → InfoType の優先 → 同じ family なら Serial（欠落はどの数値よりも小）→ 降灰の速報・詳細は VFVO55 > VFVO54 の辞書順。
function compare(candidate: VolcanoCandidate, source: ReportRef): number {
  const time = candidate.reportDateTimeMs - reportMs(source);
  if (time !== 0) return Math.sign(time);
  const rank = candidate.infoRank - (INFO_RANK.get(source.infoTypeRaw) ?? 0);
  if (rank !== 0) return Math.sign(rank);
  const left = candidate.source.serialRaw, right = source.serialRaw;
  const serial = candidate.family !== source.family || left === right ? 0 : left === "" ? -1 : right === "" ? 1 : Number(left) - Number(right);
  if (serial !== 0) return Math.sign(serial);
  return (candidate.family === "VFVO55" ? 1 : 0) - (source.family === "VFVO55" ? 1 : 0);
}
const withoutSource = (value: Shown) => ({ ...value, source: null, marineSource: null, retainUntil: 0 });

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
  const shown = (value: Shown | null) => value != null && value.effective === "active" ? value : null;
  const read = (value: Shown | null, field: string): unknown => value == null ? null : Object.getOwnPropertyDescriptor(value, field)?.value ?? null;
  const left = shown(before), right = shown(after);
  return left == null && right == null ? [] : fields.filter((field) => !isDeepStrictEqual(read(left, field), read(right, field)));
}
const fieldsOf = (value: Shown): readonly string[] => isAlert(value) ? ALERT_FIELDS : isBulletin(value) ? BULLETIN_FIELDS
  : "topAshName" in value ? SCHEDULED_FIELDS : value.subject.includes("/volcano:eruption/") ? ERUPTION_FIELDS : ASHFALL_FIELDS;

const inactive = (value: VolcanoAlert | null): "ended" | "cancelled" => value?.effective === "cancelled" ? "cancelled" : "ended";
type AlertVerdict = Readonly<{ kind: "adopt"; next: VolcanoAlert; conflict: boolean }>
  | Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale" | "noChange"; conflict: boolean }>;
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
  return { subject, operation: candidate.operation, volcanoCode: code, eventId, source, marineSource, landKind, landEventId, marineEventId,
    retainUntil };
}
// 一つの警報の報（VFVO50・VFSV・VFVO51 の火山 entry）を記録に当てる。版は自分の family の watermark とだけ比べ、kind は
// 別の family と比べて新しいときだけ取る（同じ版で kind が違えば先着を保って食い違い、P3-C9-MARINE=A）。
function judgeAlert(candidate: VolcanoCandidate, existing: VolcanoAlert | null, subject: string, code: string,
  facts: AlertFacts | null, entry: VolcanoEntry | null): AlertVerdict {
  const marine = isMarine(candidate.family);
  const own = existing == null ? null : marine ? existing.marineSource : existing.source;
  const other = existing == null ? null : marine ? existing.source : existing.marineSource;
  const order = own == null ? 1 : compare(candidate, own);
  if (order < 0) return { kind: "unchanged", reason: "stale", conflict: false };
  const before = existing?.effective === "active" ? existing : null;
  const kind = entry?.kind ?? facts?.kind ?? null;
  // VFVO51 の同じ区分の継続は表示の事実を変えない（VFVO50 の事実を保つ）。land 側の新しい版なので、表示はそのままに landKind（Condition
  // を含む報の値）と source を常に進める（revisionOnly、通知しない。Q-C9-IMPL-AMEND(9)(k)）。同じ版の再送だけが duplicate。
  if (entry != null && before != null && activeKind(entry.kind) && before.kind.code === entry.kind.code) return order === 0 ? { kind: "unchanged", reason: "duplicate", conflict: false }
    : { kind: "adopt", next: { ...before, ...alertBase(candidate, subject, code, existing, before.eventId, entry.kind) }, conflict: false };
  const cross = other == null ? 1 : compare(candidate, other);
  const sameKind = kind == null ? before == null : before != null && activeKind(kind) && before.kind.code === kind.code;
  const takeKind = cross > 0 || cross === 0 && sameKind;
  const crossConflict = cross === 0 && !sameKind && !candidate.cancelled;
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
      return { kind: "unchanged", reason: "noChange", conflict: false };
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
  if (order === 0) return existing != null && isDeepStrictEqual(withoutSource(existing), withoutSource({ ...next,
    landEventId: existing.landEventId == null ? null : next.landEventId, marineEventId: existing.marineEventId == null ? null : next.marineEventId }))
    ? { kind: "unchanged", reason: "duplicate", conflict: false } : { kind: "unchanged", reason: "stale", conflict: true };
  return { kind: "adopt", next, conflict: crossConflict };
}

// ---- 噴火・降灰・定時・解説の記録 ----

function eruptionOf(candidate: Candidate<"eruption">, existing: VolcanoEruption | null): VolcanoEruption {
  const subject = `${candidate.operation}/volcano:eruption/${candidate.eventId}`;
  const ms = candidate.reportDateTimeMs;
  const base = { subject, operation: candidate.operation, eventId: candidate.eventId, source: { ...candidate.source, subject },
    retainUntil: ms + ERUPTION_RETAIN_MS };
  if (candidate.facts == null) return { ...base, volcanoCode: candidate.volcanoCode ?? existing?.volcanoCode ?? null, effective: "cancelled" };
  return { ...base, volcanoCode: candidate.volcanoCode!, effective: "active", ...candidate.facts, flash: candidate.family === "VFVO56",
    truncated: candidate.truncated, validUntil: ms + ERUPTION_VALID_MS };
}
function ashfallOf(candidate: Candidate<"ashfall">, subject: string, code: string): VolcanoAshfall {
  const base = { subject, operation: candidate.operation, eventId: candidate.eventId, source: { ...candidate.source, subject },
    retainUntil: candidate.reportDateTimeMs + ASHFALL_RETAIN_MS, volcanoCode: code };
  if (candidate.facts == null) return { ...base, effective: "cancelled" };
  return { ...base, effective: "active", variant: candidate.family === "VFVO55" ? "VFVO55" : "VFVO54", ...candidate.facts,
    truncated: candidate.truncated };
}
function scheduledOf(candidate: Candidate<"scheduled">, subject: string, code: string, existing: VolcanoScheduledAshfall | null):
  VolcanoScheduledAshfall {
  return { subject, operation: candidate.operation, eventId: candidate.eventId, source: { ...candidate.source, subject },
    retainUntil: candidate.reportDateTimeMs + SHORT_RETAIN_MS, volcanoCode: code, effective: candidate.cancelled ? "cancelled" : "active",
    volcanoName: candidate.volcanoName ?? existing?.volcanoName ?? "", topAshName: candidate.cancelled ? existing?.topAshName ?? null
      : candidate.topAshName };
}
function bulletinOf(candidate: Candidate<"bulletin">): VolcanoBulletin {
  const family: VolcanoBulletin["family"] = candidate.family === "VFVO60" ? "VFVO60" : candidate.family === "VZVO40" ? "VZVO40" : "VFVO51";
  const subject = `${candidate.operation}/${family}/${candidate.eventId}`;
  const base = { subject, family, eventId: candidate.eventId, operation: candidate.operation, source: { ...candidate.source, subject },
    retainUntil: candidate.reportDateTimeMs + SHORT_RETAIN_MS };
  if (candidate.facts == null) return { ...base, effective: "cancelled" };
  const { title, headline, volcanoCodes, extraordinary, text, nextAdvisory } = candidate.facts;
  return { ...base, effective: "active", title, headline, volcanoCodes, extraordinary, truncated: candidate.truncated, text, nextAdvisory };
}
// view・snapshot には見出しだけを載せる（P3-C9-SNAPSHOT=A）。
const headingCache = new WeakMap<ActiveBulletin, VolcanoBulletinView>();
function headingOf(value: ActiveBulletin): VolcanoBulletinView {
  let found = headingCache.get(value);
  if (found == null) {
    const { text: _text, nextAdvisory: _next, ...heading } = value;
    found = heading;
    headingCache.set(value, found);
  }
  return found;
}

type Verdict<T> = Readonly<{ kind: "adopt"; next: T }> | Readonly<{ kind: "unchanged"; reason: "duplicate" | "stale"; conflict: boolean }>;
function judge<T extends Shown>(candidate: VolcanoCandidate, existing: T | null, next: T): Verdict<T> {
  if (existing == null) return { kind: "adopt", next };
  const order = compare(candidate, existing.source ?? candidate.source);
  if (order < 0) return { kind: "unchanged", reason: "stale", conflict: false };
  // expired は事実を捨てた記録なので、同じ revision の再受信は事実を比べずに duplicate。
  if (order === 0) return existing.effective === "expired" || isDeepStrictEqual(withoutSource(existing), withoutSource(next))
    ? { kind: "unchanged", reason: "duplicate", conflict: false } : { kind: "unchanged", reason: "stale", conflict: true };
  return { kind: "adopt", next };
}

// ---- 通知（questionResolutions[Q-NOTICE]） ----

const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
type Notice = Readonly<{ subject: string; operation: Operation; source: ReportRef; transition: VolcanoIntent["transition"];
  payload: VolcanoNotificationPayload }>;
// 題は operationPrefix＋Head/Title から「火山名　山名　」を除いた文字列、訂正・取消は前置き（旧築 notifier.ts の notifyVolcano）。
function noticeOf(candidate: VolcanoCandidate, subject: string, transition: VolcanoIntent["transition"], level: Level,
  summary: string): Notice {
  const prefix = PREFIX[candidate.operation], source = { ...candidate.source, subject };
  if (candidate.cancelled) return { subject, operation: candidate.operation, source, transition, payload: { domain: "volcano",
    level: "cancel", title: `${prefix}[取消] ${candidate.title}`, body: "この情報は取り消されました" } };
  const correction = candidate.infoRank === 2, body = summary === "" ? candidate.title : summary;
  return { subject, operation: candidate.operation, source, transition, payload: { domain: "volcano", level,
    title: prefix + (correction ? `[訂正] ${candidate.title}` : candidate.title), body: correction ? `訂正: ${body}` : body } };
}
function plumeText(value: MaterialValue): string | null {
  if (value.kind === "number") return `噴煙${value.value}m`;
  if (value.kind === "range") return `噴煙${value.value}m${value.bound === "lower" ? "以上" : "以下"}`;
  return value.kind === "unknown" ? "噴煙高度不明" : null;
}
const join = (parts: readonly (string | null)[]) => parts.filter((part): part is string => part != null && part !== "").join(" / ");
function intentsFor(notice: Notice, generation: number, now: number): VolcanoIntent[] {
  // P3-C9-TRAINING=A: training/test は desktop だけ。
  const channels = notice.operation === "normal" ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: `U-V:${notice.subject}:${generation}:${channel}`, unit: "U-V", subject: notice.subject,
    operation: notice.operation, source: notice.source, transition: notice.transition, channel, payload: notice.payload, createdAt: now,
    expiresAt: now + TTL[channel], nextAttemptAt: now, attempts: 0, configRevision: SCHEMA, disposition: "pending" }));
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-V の intent は全部 other の群（P3-C9-NOTICE-GROUP=A）。
function a7Order(left: VolcanoIntent, right: VolcanoIntent): number {
  return left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
// 終端記録の合計が 98,304 byte を超える分は、最古の終端記録から期限前に回収する。kept は今の配送の更新で終端にした記録で、回収しない
// （owner は更新した記録が残ることで照合する。C8 の Q-C8-IMPL-AMEND(1)）。kept だけで上限を超える分は元の pending の byte の内側。
function trimTerminal(intents: readonly VolcanoIntent[], kept: ReadonlySet<string> = new Set()): readonly VolcanoIntent[] {
  let terminal = terminalBytes(intents);
  if (terminal <= TERMINAL_BYTES) return intents;
  const gone = new Set<VolcanoIntent>();
  for (const item of intents.filter((value) => value.disposition !== "pending" && !kept.has(value.id))
    .sort((left, right) => left.createdAt - right.createdAt)) {
    if (terminal <= TERMINAL_BYTES) break;
    gone.add(item);
    terminal -= bytes(item) + 1;
  }
  return intents.filter((item) => !gone.has(item));
}
// 海上の部分だけの取消の鍵（`${subject}\nVFSV`）。その subject の VFSV の pending だけを置き換える。
const MARINE_PART = "VFSV";
// Q-NOTICE.capacity と P3-C9-REPLACEMENT=A。新しい intent は同じ subject・channel の pending を、取消は対象 subject の全 pending を置き換える。
// 海上の部分だけの取消（marinePart）の通知は、同じ subject の VFSV の pending だけを置き換える（統合担当の決定、Q-C9-IMPL-AMEND(9)）。
function admit(current: readonly VolcanoIntent[], fresh: readonly VolcanoIntent[], cancelled: ReadonlySet<string>, marinePart = false):
  Readonly<{ intents: readonly VolcanoIntent[]; admitted: readonly VolcanoIntent[]; dropped: number }> {
  const superseded = new Set<VolcanoIntent>();
  const replaced = new Set(fresh.map((intent) => `${intent.subject}\n${intent.channel}`));
  for (const item of current)
    if (item.disposition === "pending" && (cancelled.has(item.subject) || (!marinePart || isMarine(item.source.family))
      && replaced.has(`${item.subject}\n${item.channel}`) || isMarine(item.source.family) && cancelled.has(`${item.subject}\n${MARINE_PART}`)))
      superseded.add(item);
  if (superseded.size === 0 && fresh.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current.filter((item) => item.disposition === "pending" && !superseded.has(item)), ...fresh];
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
  // 新しい intent が容量で外れただけなら、既存の intent も終端記録も変わらないので元の配列を返す（保存世代を進めない）。
  if (superseded.size === 0 && admitted.length === 0 && [...out].every((item) => fresh.includes(item)))
    return { intents: current, admitted: [], dropped: fresh.length };
  const intents = trimTerminal([...current.map((item) => superseded.has(item) || out.has(item)
    ? { ...item, disposition: "superseded" as const } : item), ...admitted]);
  return { intents, admitted, dropped: [...out].filter((item) => !fresh.includes(item)).length + fresh.length - admitted.length };
}

// ---- outcome と view ----

function factsOf(value: Shown): Readonly<Record<string, JsonValue>> {
  if (isBulletin(value)) return value.effective === "active" ? headingFacts(headingOf(value))
    : { family: value.family, eventId: value.eventId, effective: value.effective };
  if (value.effective !== "active") return { eventId: value.eventId, effective: value.effective, volcanoCode: value.volcanoCode };
  if (isAlert(value)) { const { source: _source, marineSource: _marine, ...rest } = value; return rest; }
  const { source: _source, ...rest } = value;
  return rest;
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
    : isBulletin(value) ? null : value;
  return { unit: "U-V", operation: value.operation, subject: value.subject, office: null, current, subjects: [shownOutcome(value)] };
}

// ---- 採用の材料 ----

type Applied = {
  state: VolcanoUnitState;
  decisions: Decision[];
  changes: Change[];
  subjects: SubjectOutcome[];
  semantic: boolean;
  notice: Notice | null;
  cancelled: Set<string>;
  diagnostics: DiagnosticDetails[];
  outcomes: PublishedOutcome[];
  evicted: number;
};
function emptyApplied(state: VolcanoUnitState): Applied {
  return { state, decisions: [], changes: [], subjects: [], semantic: false, notice: null, cancelled: new Set(), diagnostics: [], outcomes: [], evicted: 0 };
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
  after: T, candidate: VolcanoCandidate, now: number, extra: Readonly<Record<string, JsonValue>> = {}): Readonly<{ fields: string[]; kept: boolean }> {
  const placed = upsert(values, after, isBulletin(after) ? BULLETIN_LIMIT : SLICE_LIMIT, now);
  const fields = changed(before, after, fieldsOf(after));
  const semantic = fields.length !== 0 || candidate.cancelled && before?.effective === "active";
  if (placed.evicted != null || placed.self) applied.evicted++;
  applied.state = store(placed.values);
  if (placed.evicted != null) applied.changes.push([placed.evicted, null]);
  if (!placed.self) applied.changes.push([before, after]);
  applied.subjects.push(outcomeOf(after, fields, extra));
  applied.semantic ||= semantic || placed.evicted != null || placed.self;
  decide(applied, candidate, after.subject, { kind: "adopt" }, semantic || placed.self);
  return { fields, kept: !placed.self };
}

// ---- 受信（P3-C9-SUBJECTS=A。一入力の変更は一回の参照交換で確定する） ----

function noTarget(applied: Applied, candidate: VolcanoCandidate): Applied {
  applied.decisions.push({ subject: "", operation: candidate.operation, decision: "rejected", reason: "identityMissing" });
  applied.diagnostics.push({ level: "WARN", component: "volcano", reason: "identityMissing", inputId: candidate.source.inputId, unit: "U-V" });
  return applied;
}
// 火山コードの無い取消は、その slice の記録のうち eventId が一致する記録が一つだけのとき結び付く（P3-C9-CANCEL-SCOPE=A の (2)）。
// 警報は VFVO50 の取消を landEventId、VFSV の取消を marineEventId と照らす（P3-AUTH-AC03(3)）。
function codeOf(values: readonly (VolcanoAlert | VolcanoAshfall | VolcanoScheduledAshfall)[], candidate: VolcanoCandidate): string | null {
  if (candidate.volcanoCode != null) return candidate.volcanoCode;
  const key = candidate.slice !== "alert" ? candidate.eventId : `${isMarine(candidate.family) ? "marine" : "land"}\n${candidate.eventId}`;
  const found = eventMatches(values, candidate.operation, key);
  return found.length === 1 ? values[found[0]].volcanoCode : null;
}
const dueAt = (value: Shown, now: number) => shownDeadline(value) <= now;

function receiveAlert(state: VolcanoUnitState, candidate: Candidate<"alert">, now: number): Applied {
  const applied = emptyApplied(state);
  const code = codeOf(state.alerts, candidate);
  if (code == null) return noTarget(applied, candidate);
  const subject = `${candidate.operation}/volcano:alert/${code}`;
  const index = indexOf(state.alerts, subject);
  const existing = index == null ? null : state.alerts[index];
  const verdict = judgeAlert(candidate, existing, subject, code, candidate.facts, null);
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.conflict) applied.diagnostics.push(conflictDiagnostic(candidate));
    return applied;
  }
  if (verdict.conflict) applied.diagnostics.push(conflictDiagnostic(candidate));
  const next = verdict.next;
  const facts = candidate.facts;
  const { fields, kept } = place(applied, applied.state.alerts, (alerts) => ({ ...applied.state, alerts }), existing, next, candidate, now, facts == null ? {}
    : { volcanoActivity: facts.activity, volcanoPrevention: facts.prevention });
  applied.state = { ...applied.state, shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "alert", code) };
  const before = existing?.effective === "active" ? existing : null;
  if (!kept || dueAt(next, now)) return applied;
  if (candidate.cancelled && isMarine(candidate.family) && existing?.source != null) {
    // 海上の部分だけの取消: VFSV の pending だけを置き換え、海上警報の取消と分かる通知にする（VFVO50 の通知は残す）。
    applied.cancelled.add(`${subject}\n${MARINE_PART}`);
    if (before != null) applied.notice = { ...noticeOf(candidate, subject, "cancelled", "cancel", ""), payload: { domain: "volcano", level: "cancel",
      title: `${PREFIX[candidate.operation]}[取消] 火山現象に関する海上警報`, body: "火山現象に関する海上警報・海上予報が取り消されました" } };
    return applied;
  }
  if (candidate.cancelled) {
    applied.cancelled.add(subject);
    if (before != null) applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "");
    return applied;
  }
  const kind = facts!.kind;
  // inactiveAdoption: 単独の VFVO50・VFSV の inactive の報を、記録の無い火山か inactive の記録に採用した（P3-C9-ALERT-ACTIVE=A）。
  const inactiveAdoption = before == null && next.effective !== "active" && !activeKind(kind) && (existing == null
    || compare(candidate, (isMarine(candidate.family) ? existing.source : existing.marineSource) ?? candidate.source) >= 0);
  const correction = candidate.infoRank === 2;
  if (!correction && fields.length === 0 && !inactiveAdoption) return applied;
  const releasing = /解除|引下げ/.test(kind.condition ?? "");
  const transition = correction ? "updated" : next.effective === "active" ? before == null ? "activated" : "updated"
    : before != null || releasing ? "released" : "updated";
  const level = isMarine(candidate.family) ? facts!.marineCodes.includes("31") ? "warning" : "normal"
    : inactiveAdoption ? releasing ? "normal" : "info" : alertLevel(kind, before);
  const name = next.effective === "active" ? next.volcanoName : facts!.volcanoName;
  const lv = /^1[1-5]$/.test(kind.code) ? `Lv${Number(kind.code) - 10}` : null;
  applied.notice = noticeOf(candidate, subject, transition, level, join([name, lv, kind.name]));
  return applied;
}
// P3-C9-NOTICE-LEVELS=C の VFVO50 の段階。
function alertLevel(kind: VolcanoKind, before: ActiveAlert | null): Level {
  const level = noticeLevel(kind.code), condition = kind.condition ?? "";
  if (/引下げ|解除/.test(condition)) return "normal";
  if (condition === "継続") return level >= 2 ? before?.kind.code === kind.code ? "info" : "normal" : "info";
  return level >= 4 ? "critical" : level >= 2 ? "warning" : "normal";
}

function receiveEruption(state: VolcanoUnitState, candidate: Candidate<"eruption">, now: number): Applied {
  const applied = emptyApplied(state);
  const subject = `${candidate.operation}/volcano:eruption/${candidate.eventId}`;
  const index = indexOf(state.eruptions, subject);
  const existing = index == null ? null : state.eruptions[index];
  const next = eruptionOf(candidate, existing);
  const verdict = judge(candidate, existing, next);
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.conflict) applied.diagnostics.push(conflictDiagnostic(candidate));
    return applied;
  }
  const { fields, kept } = place(applied, applied.state.eruptions, (eruptions) => ({ ...applied.state, eruptions }), existing, next, candidate, now);
  applied.state = { ...applied.state, shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "eruption", next.volcanoCode) };
  const before = existing?.effective === "active" ? existing : null;
  if (!kept || dueAt(next, now)) return applied;
  if (candidate.cancelled) {
    applied.cancelled.add(subject);
    if (before != null) applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "");
    return applied;
  }
  if (candidate.infoRank !== 2 && fields.length === 0) return applied;
  const facts = candidate.facts!;
  const plume = facts.plumeAboveCrater;
  const strong = facts.phenomenon.code === "51" || facts.phenomenon.code === "56"
    || (plume.kind === "number" || plume.kind === "range" && plume.bound === "lower") && plume.value >= 3_000;
  const level = candidate.family === "VFVO56" ? "critical" : strong ? "normal" : "info";
  applied.notice = noticeOf(candidate, subject, candidate.infoRank === 2 || before != null ? "updated" : "activated", level,
    join([facts.volcanoName, facts.phenomenon.name, plumeText(plume)]));
  return applied;
}

function receiveAshfall(state: VolcanoUnitState, candidate: Candidate<"ashfall">, clock: ClockReading): Applied {
  const applied = emptyApplied(state);
  const now = clock.wallTimeMs;
  const code = codeOf(state.ashfalls, candidate);
  if (code == null) return noTarget(applied, candidate);
  const subject = `${candidate.operation}/volcano:ashfall/${code}`;
  const index = indexOf(state.ashfalls, subject);
  const existing = index == null ? null : state.ashfalls[index];
  const next = ashfallOf(candidate, subject, code);
  const verdict = judge(candidate, existing, next);
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.conflict) applied.diagnostics.push(conflictDiagnostic(candidate));
    return applied;
  }
  // P3-C9-BATCH=A: 採用した VFVO54/55 の前に、同じ運用区分の待機中の batch を通知無しで flush する（interrupted）。stale・duplicate の
  // 再送では flush しない（古い再送で新しい定時の通知を消さない、Q-C9-IMPL-AMEND(6)）。
  if (state.batch != null && state.batch.operation === candidate.operation) {
    const interrupted = flushBatch(state, "interrupted");
    applied.state = interrupted.state;
    applied.outcomes.push(interrupted.outcome);
  }
  const { fields, kept } = place(applied, applied.state.ashfalls, (ashfalls) => ({ ...applied.state, ashfalls }), existing, next, candidate, now);
  applied.state = { ...applied.state, shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "ashfall", code) };
  const before = existing?.effective === "active" ? existing : null;
  if (!kept || dueAt(next, now)) return applied;
  if (candidate.cancelled) {
    applied.cancelled.add(subject);
    if (before != null) applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "");
    return applied;
  }
  if (candidate.infoRank !== 2 && fields.length === 0) return applied;
  const facts = candidate.facts!;
  applied.notice = noticeOf(candidate, subject, candidate.infoRank === 2 || before != null ? "updated" : "activated",
    candidate.family === "VFVO54" ? "warning" : "normal",
    join([facts.volcanoName, `降灰予報（${candidate.family === "VFVO54" ? "速報" : "詳細"}）`, facts.groups[0]?.ashName ?? null]));
  return applied;
}

function receiveScheduled(state: VolcanoUnitState, candidate: Candidate<"scheduled">, clock: ClockReading): Applied {
  const applied = emptyApplied(state);
  const now = clock.wallTimeMs;
  const code = codeOf(state.scheduledAshfalls, candidate);
  if (code == null) return noTarget(applied, candidate);
  const subject = `${candidate.operation}/VFVO53/${code}`;
  const index = indexOf(state.scheduledAshfalls, subject);
  const existing = index == null ? null : state.scheduledAshfalls[index];
  const next = scheduledOf(candidate, subject, code, existing);
  const verdict = judge(candidate, existing, next);
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.conflict) applied.diagnostics.push(conflictDiagnostic(candidate));
    return applied;
  }
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
  const { kept } = place(applied, applied.state.scheduledAshfalls, (scheduledAshfalls) => ({ ...applied.state, scheduledAshfalls }), existing, next,
    candidate, now);
  if (candidate.cancelled) {
    // 取消は batch から対象を外す（P3-C9-BATCH=A）。batch に入っていたか記録が active なら取消を通知する。
    const batch = applied.state.batch;
    if (batch != null && inBatch) {
      const subjects = batch.subjects.filter((item) => item !== subject);
      applied.state = { ...applied.state, batch: subjects.length === 0 ? null : { ...batch, subjects } };
    }
    applied.cancelled.add(subject);
    if ((inBatch || existing?.effective === "active") && !dueAt(next, now))
      applied.notice = noticeOf(candidate, subject, "cancelled", "cancel", "");
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
  const names = items.map((item) => item.volcanoName);
  const body = items.length === 1 ? join([last.volcanoName, "降灰予報（定時）", last.topAshName])
    : `${items.length}火山: ${names.slice(0, 3).join("、")}${items.length > 3 ? ` +${items.length - 3}` : ""}`;
  return { state: next, outcome, notice: { subject, operation: batch.operation, source: { ...last.source, subject }, transition: "activated",
    payload: { domain: "volcano", level: "info", title: `${PREFIX[batch.operation]}降灰予報（定時）`, body } } };
}

function receiveBulletin(state: VolcanoUnitState, candidate: Candidate<"bulletin">, now: number): Applied {
  const applied = emptyApplied(state);
  const next = bulletinOf(candidate);
  const subject = next.subject;
  const index = indexOf(state.bulletins, subject);
  const existing = index == null ? null : state.bulletins[index];
  const verdict = judge(candidate, existing, next);
  let notice: Notice | null = null;
  if (verdict.kind === "unchanged") {
    decide(applied, candidate, subject, verdict);
    if (verdict.conflict) applied.diagnostics.push(conflictDiagnostic(candidate));
  } else {
    const { fields, kept } = place(applied, applied.state.bulletins, (bulletins) => ({ ...applied.state, bulletins }), existing, next, candidate, now);
    const before = existing?.effective === "active" ? existing : null;
    if (kept && !dueAt(next, now)) {
      if (candidate.cancelled) {
        applied.cancelled.add(subject);
        if (before != null) notice = noticeOf(candidate, subject, "cancelled", "cancel", "");
      } else if (candidate.infoRank === 2 || fields.length !== 0) {
        const facts = candidate.facts!;
        const level = candidate.family === "VFVO51" && facts.extraordinary ? "normal" : "info";
        const summary = candidate.family === "VFVO60" ? `${facts.volcanoName ?? ""} 推定噴煙流向報`.trim() : facts.headline ?? candidate.title;
        notice = noticeOf(candidate, subject, candidate.infoRank === 2 || before != null ? "updated" : "activated", level, summary);
      }
    }
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
  if (verdicts.some(({ verdict }) => verdict.kind === "unchanged" && verdict.reason === "stale" || verdict.conflict)) {
    for (const { subject } of verdicts) decide(applied, candidate, subject, { kind: "unchanged", reason: "stale" });
    applied.diagnostics.push(conflictDiagnostic(candidate, verdicts.length));
    return;
  }
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
    if (existing != null || values.length < SLICE_LIMIT) {
      if (existing == null) values.push(verdict.next);
      kept.add(verdict.next.subject);
      continue;
    }
    // 同じ報が採用する記録は退去の候補にしない。
    const victim = evictOne(values, now, verdict.next.operation, nexts);
    evicted++;
    if (victim == null) continue;
    values.splice(values.indexOf(victim), 1);
    values.push(verdict.next);
    kept.add(verdict.next.subject);
    applied.changes.push([victim, null]);
  }
  const adoptedCodes = new Set<string>();
  for (const { entry, subject, existing, verdict } of verdicts) {
    if (verdict.kind === "unchanged") { decide(applied, candidate, subject, verdict); continue; }
    const next = verdict.next;
    const fields = changed(existing, next, ALERT_FIELDS);
    const self = !kept.has(subject);
    if (!self) applied.changes.push([existing, next]);
    applied.subjects.push(outcomeOf(next, fields));
    applied.semantic ||= fields.length !== 0 || self;
    decide(applied, candidate, subject, { kind: "adopt" }, fields.length !== 0 || self);
    adoptedCodes.add(entry.volcanoCode);
  }
  applied.state = { ...applied.state, alerts: values, shortfalls: liveShortfalls(applied.state.shortfalls, candidate, "alert", adoptedCodes) };
  applied.evicted += evicted;
  applied.semantic ||= evicted !== 0;
}

// 一入力の Applied を確定する: intent の採用と置換、保存世代、到着の時点で期限を過ぎた記録の同じ reduce での回収。
function finish(state: VolcanoUnitState, applied: Applied, clock: ClockReading): Result {
  const now = clock.wallTimeMs;
  const fresh = applied.notice == null ? [] : intentsFor(applied.notice, state.persistence.currentGeneration + 1, now);
  const notices = admit(applied.state.intents, fresh, applied.cancelled,
    [...applied.cancelled].some((key) => key.endsWith(`\n${MARINE_PART}`)));
  const adopted: VolcanoUnitState = { ...applied.state, intents: notices.intents };
  // 保存しない系列（定時・batch・解説）だけの変化では保存世代を進めない（I-U-V.persisted）。
  const stamped = { ...adopted, persistence: persistedChanged(state, adopted) ? dirty(state.persistence, clock.monotonicMs) : state.persistence };
  const collected = deadlineAt(stamped) <= now ? collect(stamped, clock) : null;
  const next = collected?.state ?? stamped;
  const diagnostics = [...applied.diagnostics];
  if (applied.evicted !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "volcanoCapacityEvicted", unit: "U-V",
    count: applied.evicted });
  if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "notificationCapacityEvicted", unit: "U-V",
    count: notices.dropped });
  const outcomes: PublishedOutcome[] = [...applied.outcomes];
  if (applied.subjects.length !== 0)
    outcomes.push({ kind: "accepted", change: applied.semantic ? "semantic" : "revisionOnly", subjects: applied.subjects });
  return { changes: [...applied.changes, ...collected?.changes ?? []],
    step: { state: next, nextDeadline: nextDeadline(next), decisions: applied.decisions, intents: notices.admitted, outcomes, diagnostics } };
}

function receive(state: VolcanoUnitState, input: Extract<VolcanoInput, { kind: "receive" }>): Result {
  const parsed = parseVolcano(input.material);
  if (parsed.kind === "rejected") return { changes: [], step: { ...idle(state), decisions: [{ subject: parsed.subject,
    operation: input.material.operation, decision: "rejected", reason: parsed.reason }], diagnostics: [parsed.diagnostic] } };
  const { candidate } = parsed;
  // Q-NOTICE.recovery・P3-C9-N2: origin=recovery は適用しない（意味検証の後に同じ state 参照）。
  if (candidate.source.origin === "recovery") return { changes: [], step: { ...idle(state),
    decisions: [{ subject: "", operation: candidate.operation, decision: "unchanged", reason: "noChange" }] } };
  const now = input.clock.wallTimeMs;
  const applied = candidate.slice === "alert" ? receiveAlert(state, candidate, now)
    : candidate.slice === "eruption" ? receiveEruption(state, candidate, now)
    : candidate.slice === "ashfall" ? receiveAshfall(state, candidate, input.clock)
    : candidate.slice === "scheduled" ? receiveScheduled(state, candidate, input.clock)
    : receiveBulletin(state, candidate, now);
  // 識別できない取消の拒否は state 全体を変えない（rejected）。
  if (applied.decisions.some((item) => item.decision === "rejected")) return { changes: [], step: { ...idle(state),
    decisions: applied.decisions, diagnostics: applied.diagnostics } };
  return finish(state, applied, input.clock);
}

// ---- 期限（I-U-V.deadlines。到来分だけを回収・flush する） ----

// ponytail: 三 slice 各 128・定時 128・解説 64 の同時の期限だけが一括の回収になる（上限は保持件数と decode で効く）。
function collect(state: VolcanoUnitState, clock: ClockReading): Readonly<{ state: VolcanoUnitState; changes: readonly Change[];
  expiredIntents: number }> {
  const now = clock.wallTimeMs;
  if (deadlineAt(state) > now) return { state, changes: [], expiredIntents: 0 };
  const changes: Change[] = [];
  const sweep = <T extends Shown>(values: readonly T[], at: (value: T) => number, expire: (value: T) => T): readonly T[] =>
    minOf(values, at) > now ? values : values.flatMap((item) => {
      if (at(item) > now) return [item];
      const after = item.retainUntil <= now ? null : expire(item);
      changes.push([item, after]);
      return after == null ? [] : [after];
    });
  const expired = <T extends VolcanoEruption | VolcanoAshfall>(item: T) => ({ subject: item.subject, operation: item.operation,
    eventId: item.eventId, source: item.source, retainUntil: item.retainUntil, volcanoCode: item.volcanoCode, effective: "expired" as const });
  const alerts = sweep(state.alerts, alertDeadline, (item) => item);
  const eruptions = sweep<VolcanoEruption>(state.eruptions, eruptionDeadline, expired);
  const ashfalls = sweep<VolcanoAshfall>(state.ashfalls, ashfallDeadline, (item) => ({ ...expired(item), volcanoCode: item.volcanoCode }));
  const scheduledAshfalls = sweep(state.scheduledAshfalls, retained, (item) => item);
  const bulletins = sweep(state.bulletins, retained, (item) => item);
  const intents = minOf(state.intents, (item) => item.expiresAt) > now ? state.intents : state.intents.filter((item) => item.expiresAt > now);
  const expiredIntents = intents === state.intents ? 0
    : state.intents.filter((item) => item.disposition === "pending" && item.expiresAt <= now).length;
  const next = { ...state, alerts, eruptions, ashfalls, scheduledAshfalls, bulletins, intents };
  return { state: { ...next, persistence: persistedChanged(state, next) ? dirty(state.persistence, clock.monotonicMs) : state.persistence },
    changes, expiredIntents };
}

function deadlineStep(state: VolcanoUnitState, clock: ClockReading, shutdown: boolean): Result {
  const applied = collect(state, clock);
  const due = batchDue(applied.state.batch);
  const flushing = shutdown ? applied.state.batch != null : due != null && due <= clock.monotonicMs;
  const flushed = flushing ? flushBatch(applied.state, shutdown ? "shutdown" : "deadline") : null;
  let next = flushed?.state ?? applied.state;
  let admitted: readonly VolcanoIntent[] = [];
  const diagnostics: DiagnosticDetails[] = applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "volcano",
    reason: "notificationExpired", unit: "U-V", count: applied.expiredIntents }];
  if (flushed?.notice != null) {
    const notices = admit(next.intents, intentsFor(flushed.notice, next.persistence.currentGeneration + 1, clock.wallTimeMs), new Set());
    // 新しい通知が容量で外れただけ（admit が元の配列を返した）なら保存対象は変わらないので世代を進めない。
    if (notices.intents !== next.intents) next = { ...next, intents: notices.intents, persistence: dirty(next.persistence, clock.monotonicMs) };
    admitted = notices.admitted;
    if (notices.dropped !== 0) diagnostics.push({ level: "INFO", component: "volcano", reason: "notificationCapacityEvicted", unit: "U-V",
      count: notices.dropped });
  }
  const subjects = applied.changes.flatMap(([before, after]) => after == null || !visible(before) ? [] : [outcomeOf(after, ["effective"])]);
  const batchSubjects = flushed?.outcome.subjects ?? [];
  const outcomes: PublishedOutcome[] = shutdown ? [{ kind: "batchCompleted", reason: "shutdown", subjects: [...subjects, ...batchSubjects] }]
    : [...flushed == null ? [] : [flushed.outcome], ...subjects.length === 0 ? [] : [{ kind: "deadlineApplied" as const, subjects }]];
  return { changes: applied.changes, step: { ...idle(next), intents: admitted, outcomes, diagnostics } };
}

// ---- intentUpdate（Q-NOTICE.intentUpdate） ----

function intentUpdate(state: VolcanoUnitState, input: Extract<VolcanoInput, { kind: "intentUpdate" }>): Result {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changedIntents = new Map<string, VolcanoIntent>();
  for (const update of updates) {
    const current = originals.get(update.id);
    if (current == null || update.attempts < current.attempts || current.attempts === update.attempts
      && current.nextAttemptAt === update.nextAttemptAt && current.disposition === update.disposition) continue;
    changedIntents.set(current.id, { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition });
  }
  if (changedIntents.size === 0) return { changes: [], step: idle(state) };
  // 所有配列は一括で索引化して一度だけ置き換える（P2-A4・C5・C7・C8 の先例）。更新で終端にした記録は期限前の回収から外す。
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
    if (found.slice === "alert") next = { ...next, alerts: end<VolcanoAlert>(state.alerts, (item) => ({ subject: item.subject,
      operation: item.operation, volcanoCode: item.volcanoCode, eventId: item.eventId, source: item.source, marineSource: item.marineSource,
      landKind: item.landKind, landEventId: item.landEventId, marineEventId: item.marineEventId,
      retainUntil: item.retainUntil, effective: "ended" })) };
    if (found.slice === "eruption") next = { ...next, eruptions: end<VolcanoEruption>(state.eruptions, (item) => ({ subject: item.subject,
      operation: item.operation, eventId: item.eventId, source: item.source, retainUntil: item.retainUntil, volcanoCode: item.volcanoCode,
      effective: "expired" })) };
    if (found.slice === "ashfall") next = { ...next, ashfalls: end<VolcanoAshfall>(state.ashfalls, (item) => ({ subject: item.subject,
      operation: item.operation, eventId: item.eventId, source: item.source, retainUntil: item.retainUntil, volcanoCode: item.volcanoCode,
      effective: "expired" })) };
  }
  next = { ...next, persistence: dirty(state.persistence, input.clock.monotonicMs) };
  return { changes, step: { ...idle(next), decisions: [{ subject, operation, decision: "changed", reason: null, change: "semantic",
    currentEstablished: null }], outcomes: [{ kind: "accepted", change: "semantic", subjects: changes.flatMap(([, after]) =>
    after == null ? [] : [outcomeOf(after, ["effective"])]) }] } };
}

function restore(state: VolcanoUnitState, persisted: PersistedVolcanoUnit, clock: ClockReading): Result {
  const decoded = volcanoUnitCodec.decode(persisted);
  if (decoded.kind === "invalid") return { changes: [], step: { ...idle(state), decisions: [{ subject: "", operation: "normal",
    decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "volcano",
    reason: "requiredStructureInvalid", unit: "U-V" }] } };
  // Q-NOTICE.restart: 復元で intent を作らず、pending は元の createdAt/expiresAt のまま戻る。定時・batch・解説は空から始まる。
  const applied = collect({ ...decoded.state, persistence: state.persistence }, clock);
  const shown: Shown[] = [...applied.state.alerts, ...applied.state.eruptions, ...applied.state.ashfalls].filter(visible);
  return { changes: shown.map((item): Change => [null, item]), step: { ...idle(applied.state),
    outcomes: [{ kind: "recoveryApplied", scope: ["U-V"], coverage: shown.map((item) => item.subject), subjects: [] }],
    diagnostics: applied.expiredIntents === 0 ? [] : [{ level: "INFO", component: "volcano", reason: "notificationExpired",
      unit: "U-V", count: applied.expiredIntents }] } };
}

function reduceCore(state: VolcanoUnitState, input: VolcanoInput): Result {
  switch (input.kind) {
    case "restore": return restore(state, input.persisted, input.clock);
    case "intentUpdate": return intentUpdate(state, input);
    case "deadline": return deadlineStep(state, input.clock, false);
    case "shutdown": return deadlineStep(state, input.clock, true);
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
  const eruptions = state.eruptions.filter((item): item is ActiveEruption => item.effective === "active");
  const ashfalls = state.ashfalls.filter((item): item is ActiveAshfall => item.effective === "active");
  const bulletins = state.bulletins.filter((item): item is ActiveBulletin => item.effective === "active");
  const subjects = [...alerts, ...eruptions, ...ashfalls, ...bulletins].map(shownOutcome);
  return { unit: "U-V", semanticRevision: [...subjects.map((item) => `${item.subject}:${item.source?.reportDateTimeRaw}:`
    + `${item.source?.serialRaw}:${item.source?.infoTypeRaw}`), ...state.shortfalls.map((item) => `shortfall:${item.id}`)].sort().join("|"),
  contentRevision: String(state.contentRevision), admission: {}, subjects, alerts, eruptions, ashfalls,
  bulletins: bulletins.map(headingOf), shortfalls: state.shortfalls };
}

// ---- codec（I-U-V.persisted・I-U-V.decode、唯一の VolcanoUnitCodec） ----

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const bounded = (value: unknown, limit: number): value is string => isText(value) && value.length <= limit;
const boundedOrNull = (value: unknown, limit: number): value is string | null => value === null || bounded(value, limit);
const ascii = (value: unknown, limit: number): value is string => isText(value) && asciiCode(value, limit);
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
  const row = record(value);
  const operation = operationOf(row?.operation), family = familyOf(row?.family);
  if (row == null || operation == null || family == null || !families(family) || row.subject !== subject
    || !bounded(row.inputId, LIMITS.inputId) || !bounded(row.reportDateTimeRaw, LIMITS.reportDateTime)
    || !Number.isFinite(Date.parse(row.reportDateTimeRaw)) || !isText(row.serialRaw) || !validSerial(row.serialRaw)
    || !isText(row.infoTypeRaw) || !INFO_RANK.has(row.infoTypeRaw) || subjectOperation(subject) !== operation
    || (row.origin !== "live" && row.origin !== "recovery" && row.origin !== "replay")) return null;
  return { inputId: row.inputId, origin: row.origin, operation, family, subject, reportDateTimeRaw: row.reportDateTimeRaw,
    serialRaw: row.serialRaw, infoTypeRaw: row.infoTypeRaw };
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
const ALERT_FACT_KEYS = ["volcanoName", "kind", "lastKind", "level", "headline", "municipalities", "marineAreas", "coordinate", "truncated"];
const ERUPTION_FACT_KEYS = ["volcanoName", "flash", "phenomenon", "eventDateTimeRaw", "craterName", "plumeAboveCrater", "plumeAboveSeaLevel",
  "plumeDirection", "headline", "municipalities", "truncated", "validUntil"];
const ASHFALL_FACT_KEYS = ["volcanoName", "variant", "headline", "forecastStartsAt", "forecastEndsAt", "groups", "omittedGroupCount", "truncated"];
const alertFamily = (family: string): family is VolcanoAlertFamily => family === "VFVO50" || family === "VFVO51";
// legacy は K2 前の旧保存（警報が identity の鍵を持たない payload、P3-AUTH-AC06(2)）。
function alertRecord(value: unknown, legacy: boolean): VolcanoAlert | null {
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
  // 移行 A1: 片側だけの記録は eventId がその側の identity。両側の記録は最後の書き手が分からないので両方 null（推測しない）。
  const land = row.landEventId, marine = row.marineEventId;
  const landEventId = legacy ? marineSource == null ? row.eventId : null
    : land === null ? null : source != null && isText(land) && validEventId(land) ? land : undefined;
  const marineEventId = legacy ? source == null ? row.eventId : null
    : marine === null ? null : marineSource != null && isText(marine) && validEventId(marine) ? marine : undefined;
  if (landEventId === undefined || marineEventId === undefined) return null;
  const base = { subject, operation, volcanoCode: row.volcanoCode, eventId: row.eventId, source, marineSource, landKind, landEventId,
    marineEventId, retainUntil: row.retainUntil };
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
  if (kind == null || !activeKind(kind) || row.level !== level || level === undefined || lastKind === undefined || municipalities == null
    || marineAreas == null || !bounded(row.volcanoName, BOUNDS.volcanoName) || !boundedOrNull(row.headline, BOUNDS.headline)
    || !(row.coordinate === null || ascii(row.coordinate, LIMITS.coordinate)) || typeof row.truncated !== "boolean") return null;
  return { ...base, effective: "active", volcanoName: row.volcanoName, kind, lastKind, level, headline: row.headline, municipalities,
    marineAreas, coordinate: row.coordinate, truncated: row.truncated };
}
function eruptionRecord(value: unknown): VolcanoEruption | null {
  const row = record(value);
  const operation = operationOf(row?.operation);
  if (row == null || operation == null || !isText(row.eventId) || !validEventId(row.eventId)
    || row.subject !== `${operation}/volcano:eruption/${row.eventId}`) return null;
  const subject = row.subject;
  const source = reportRef(row.source, subject, (family) => family === "VFVO52" || family === "VFVO56");
  if (source == null || row.retainUntil !== reportMs(source) + ERUPTION_RETAIN_MS) return null;
  const base = { subject, operation, eventId: row.eventId, source, retainUntil: row.retainUntil };
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
  return { ...base, volcanoCode: row.volcanoCode, effective: "active", volcanoName: row.volcanoName, flash: row.flash,
    phenomenon: { code: phenomenon.code, name: phenomenon.name }, eventDateTimeRaw: row.eventDateTimeRaw, craterName: row.craterName,
    plumeAboveCrater: crater, plumeAboveSeaLevel: seaLevel, plumeDirection: row.plumeDirection, headline: row.headline, municipalities,
    truncated: row.truncated, validUntil: row.validUntil };
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
  const source = reportRef(row.source, subject, (family) => family === "VFVO54" || family === "VFVO55");
  if (source == null || row.retainUntil !== reportMs(source) + ASHFALL_RETAIN_MS) return null;
  const base = { subject, operation, eventId: row.eventId, source, retainUntil: row.retainUntil, volcanoCode: row.volcanoCode };
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
  return { ...base, effective: "active", volcanoName: row.volcanoName, variant: row.variant, headline: row.headline, forecastStartsAt: starts,
    forecastEndsAt: ends, groups, omittedGroupCount: row.omittedGroupCount, truncated: row.truncated };
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
  const disposition = (["pending", "delivered", "expired", "superseded"] as const).find((entry) => entry === row?.disposition);
  // state に残る subject との一致は求めない（解説・定時は復元で空になる、I-U-V.decode）。
  if (row == null || payload == null || operation == null || source == null || level == null || channel == null || transition == null
    || disposition == null || !isText(row.id) || row.unit !== "U-V" || !isText(row.subject) || subjectOperation(row.subject) !== operation
    || source.operation !== operation || payload.domain !== "volcano" || !isText(payload.title) || payload.title === ""
    || !isText(payload.body) || payload.body === "" || !finite(row.createdAt) || !finite(row.expiresAt) || !finite(row.nextAttemptAt)
    || !count(row.attempts) || !isText(row.configRevision) || row.expiresAt < row.createdAt) return null;
  return { id: row.id, unit: "U-V", subject: row.subject, operation, source, transition, channel,
    payload: { domain: "volcano", level, title: payload.title, body: payload.body }, createdAt: row.createdAt,
    expiresAt: row.expiresAt, nextAttemptAt: row.nextAttemptAt, attempts: Number(row.attempts), configRevision: row.configRevision, disposition };
}
const unique = (values: readonly { subject: string }[]) => new Set(values.map((item) => item.subject)).size === values.length;
function persisted(value: unknown): PersistedVolcanoUnit | null {
  const row = record(value);
  if (row == null || row.schemaVersion !== SCHEMA) return null;
  // 旧保存かどうかは payload 単位で見る: 警報が全部 identity の鍵を両方持つか、全部どちらも持たないか（混在は不正、P3-AUTH-AC06(2)）。
  const keyed = Array.isArray(row.alerts) ? row.alerts.map((entry) => { const alert = record(entry);
    return alert == null ? 0 : Number("landEventId" in alert) + Number("marineEventId" in alert); }) : [];
  if (keyed.some((keys) => keys !== keyed[0]) || keyed[0] === 1) return null;
  const legacy = keyed[0] === 0;
  const alerts = list(row.alerts, (entry) => alertRecord(entry, legacy), SLICE_LIMIT), eruptions = list(row.eruptions, eruptionRecord, SLICE_LIMIT);
  const ashfalls = list(row.ashfalls, ashfallRecord, SLICE_LIMIT), shortfalls = list(row.shortfalls, shortfallRecord, SHORTFALL_LIMIT);
  const intents = list(row.intents, intentRecord);
  if (alerts == null || eruptions == null || ashfalls == null || shortfalls == null || intents == null || !unique(alerts)
    || !unique(eruptions) || !unique(ashfalls) || new Set(shortfalls.map((item) => item.id)).size !== shortfalls.length
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  const pending = intents.filter((entry) => entry.disposition === "pending");
  // 受理と同じ式（実 byte＋配送の更新の予約、deliveryGrowth）。終端記録は pending との合計で見る（Q-NOTICE.capacity）。
  const pendingBytes = listBytes(pending) + pending.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  const result: PersistedVolcanoUnit = { schemaVersion: SCHEMA, alerts, eruptions, ashfalls, shortfalls, intents };
  if (pending.length > PENDING_ITEMS || pendingBytes > PENDING_BYTES || pendingBytes + terminalBytes(intents) > PENDING_BYTES + TERMINAL_BYTES
    || generationBytes(result) > GENERATION_LIMIT) return null;
  return result;
}

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const volcanoUnitCodec: VolcanoUnitCodec = {
  schemaVersion: SCHEMA,
  // 定時・batch・解説・contentRevision・persistence は保存しない（I-U-V.persisted、spec:484・:504 の N）。
  encode: (state) => ({ schemaVersion: SCHEMA, alerts: state.alerts, eruptions: state.eruptions, ashfalls: state.ashfalls,
    shortfalls: state.shortfalls, intents: state.intents }),
  decode(payload) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: "invalid p3-volcano-unit-v1 payload" }
      : { kind: "restored", state: { ...value, contentRevision: 0, scheduledAshfalls: [], batch: null, bulletins: [],
        persistence: cleanPersistence } };
  },
};

// P3-UNIT-TABLE-001: この unit の行（I-U-V.runtimeRows）。
const notNormal = <T extends { operation: Operation }>(values: readonly T[]) => values.filter((item) => item.operation !== "normal");
const volcanoUnit = {
  unit: "U-V",
  reduce: reduceVolcanoUnit,
  toView: toVolcanoView,
  persistence: { kind: "durable", codec: volcanoUnitCodec },
  confirmationScopeLimit: 512,
  withoutNormal: (state) => ({ ...state, alerts: notNormal(state.alerts), eruptions: notNormal(state.eruptions),
    ashfalls: notNormal(state.ashfalls), scheduledAshfalls: notNormal(state.scheduledAshfalls), bulletins: notNormal(state.bulletins),
    shortfalls: notNormal(state.shortfalls), batch: state.batch?.operation === "normal" ? null : state.batch }),
  keepsWhileNormalHidden: () => false,
  normalDisplaySubjects: (state) => [...state.alerts, ...state.eruptions, ...state.ashfalls, ...state.bulletins]
    .filter((item) => item.operation === "normal" && visible(item)).map(displaySubject),
  terminalIntents: { kind: "intents" },
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-V">;

export { reduceVolcanoUnit, toVolcanoView, volcanoUnit, volcanoUnitCodec };
