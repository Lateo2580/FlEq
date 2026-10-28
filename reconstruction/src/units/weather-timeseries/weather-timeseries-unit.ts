import { isDeepStrictEqual } from "node:util"; import { createHash } from "node:crypto";

import type { DiagnosticDetails, JsonValue, NotificationIntent, PersistenceStatus, PublishedOutcome, ReportRef, RuntimeDisplaySubject, RuntimeUnitDeadline, SubjectOutcome, WallBasis } from "../../../contracts/p2-shared-runtime.types";
import type { PersistedWeatherTimeseriesUnit, WeatherTimeseriesInput, WeatherTimeseriesSnapshot, WeatherTimeseriesUnreadableSite,
  WeatherTimeseriesGate, WeatherTimeseriesSubject, WeatherTimeseriesUnitCodec, WeatherTimeseriesUnitState, WeatherTimeseriesUnitStep,
  WeatherTimeseriesUnitView, WeatherTimeseriesPublicSubject, WeatherTimeseriesDetailPeriod, WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse } from "../../../contracts/p2-weather-timeseries-unit.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../checkpoint/checkpoint"; import { readReportRef, stepVersion } from "../../contracts-revision/version";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import { EMPTY, inspect } from "../../domains/weather-timeseries/weather-timeseries";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { applyIntentUpdate, readIntentState, restoreStarted } from "../notice-mark";
import { PENDING_MARK_BYTES, cachedMin } from "../expiry";
import {
  WEATHER_TIMESERIES_RAW_BUDGET, droppedIn, fitRawBudget, markView, rawTotal, readUnreadableMark, stripRaw, unreadableMarkBytes,
} from "../unreadable";

const SCHEMA = "p2-weather-timeseries-unit-v8" as const;
type InternalStep = Omit<WeatherTimeseriesUnitStep, "displayChanges" | "confirmationEvidence">;
// P3-EF-AC10 (5): 器は入力なしで付く期限切れの保留の印の最悪の分（512×21）だけ広げる（33,565,184）。P3-UM-RES-09: 読めない所の印・
// 原文の予算（付加事項の原文が多いので 1 MiB）・カードの分も足す。
const SUBJECT_LIMIT = 512, RETAIN = 7 * 86_400_000;
const LIMIT = 33_554_432 + 512 * PENDING_MARK_BYTES + SUBJECT_LIMIT * unreadableMarkBytes("unreadable") + WEATHER_TIMESERIES_RAW_BUDGET
  + UNREADABLE_CARDS_MAX_BYTES;
const encoder = new TextEncoder();
const cache = new WeakMap<object, number>();
const subjectDeadlineCache = new WeakMap<WeatherTimeseriesUnitState["subjects"], number>();
const outcomeCache = new WeakMap<WeatherTimeseriesSubject, SubjectOutcome>();
type CurrentChange = (before: WeatherTimeseriesSubject | null, after: WeatherTimeseriesSubject | null) => void;
const emptyEnvelopeBytes = serializedEnvelope({ schemaVersion: SCHEMA, unit: "U-F", generation: 0,
  capturedAt: 0, payload: { schemaVersion: SCHEMA, subjects: [], gates: [], intents: [] }, sha256: "0".repeat(64) }).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7)・P3-UM-AC11 (10): envelope の inputBoundary・losses・カードの最大（器からは引かない）

function bytes(value: object): number {
  let size = cache.get(value);
  if (size == null) { size = encoder.encode(JSON.stringify(value)).byteLength; cache.set(value, size); }
  return size;
}
function arrayBytes<T extends object>(values: readonly T[], measure: (item: T) => number = bytes): number {
  return values.reduce((sum, item) => sum + measure(item), Math.max(values.length - 1, 0));
}
// 配送の更新で pending が伸びうる分の予約（P3-INTENT-UPDATE-RESERVE-001）。無いと上限ちょうどの pending が更新で伸び、encode が拒否する。
function reserve(intents: readonly NotificationIntent[]): number {
  return intents.reduce((sum, item) => item.disposition === "pending" ? sum + deliveryGrowth(item) : sum, 0);
}
function measure(subjects: readonly WeatherTimeseriesSubject[], gates: readonly { source: ReportRef }[],
  intents: readonly NotificationIntent[], generation: number, capturedAt: number): number {
  if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isFinite(capturedAt)
    || JSON.stringify(generation).length > 32 || JSON.stringify(capturedAt).length > 32)
    throw new RangeError("invalid U-F checkpoint generation or capture time");
  // P3-EF-AC10 (5): 印の無い active の subject ごとに保留の印の分を予約する（受理の fits と decode が同じ式。退去した subject の予約は数え直しで外れる）。
  return emptyEnvelopeBytes + 62 + arrayBytes(subjects, (item) => bytes(item) + (shows(item) ? PENDING_MARK_BYTES : 0)) + arrayBytes(gates)
    + arrayBytes(intents, (item) => bytes(item) + (item.disposition === "pending" ? deliveryGrowth(item) : 0));
}
const shows = (item: WeatherTimeseriesSubject) => item.effective === "active" && item.expiryPending !== true;
// P3-EF-AC11 (2): 根拠で当てない種類を比べないよう、表示の期限・回収の期限・保留の subject を別々に持つ（nextDeadline は subjectDeadline）。
const displayMin = cachedMin<WeatherTimeseriesSubject>((item) => shows(item) ? item.validUntil ?? Infinity : Infinity);
const recallMin = cachedMin<WeatherTimeseriesSubject>((item) => item.retainUntil);
const pendingMin = cachedMin<WeatherTimeseriesSubject>((item) => item.expiryPending === true ? item.validUntil ?? 0 : Infinity);
// P3-UM-AC01 (6): 読めない所の印は事実と一緒に生きる（active でなくなる形では外す）。
const withoutMark = ({ unreadable: _mark, ...rest }: WeatherTimeseriesSubject): WeatherTimeseriesSubject => rest;
// 表示の上の形（P3-EF-AC04）: 保留の印のある subject は期限切れと同じ noActiveItems に見せる（事実は記憶へ移すまで残す）。
const shownCache = new WeakMap<WeatherTimeseriesSubject, WeatherTimeseriesSubject>();
function shownSubject(item: WeatherTimeseriesSubject): WeatherTimeseriesSubject {
  if (item.expiryPending !== true) return item;
  let found = shownCache.get(item);
  if (found == null) { found = { ...withoutMark(item), ...EMPTY, effective: "noActiveItems", validUntil: null }; shownCache.set(item, found); }
  return found;
}
function dirty(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}
// P3-LIFE-RET-02: receive・容量の unavailable・decode が使う唯一の式。有効期間の後に 7 日を足さない（P3-LIFE-D-FORECAST=A）。
function retainUntil(reportDateTimeMs: number, validUntil: number | null): number {
  return Math.max(reportDateTimeMs + RETAIN, validUntil ?? -Infinity);
}
function subjectDeadline(subjects: WeatherTimeseriesUnitState["subjects"]): number {
  let at = subjectDeadlineCache.get(subjects);
  if (at == null) {
    at = subjects.reduce((min, item) => Math.min(min, item.validUntil ?? Infinity, item.retainUntil), Infinity);
    subjectDeadlineCache.set(subjects, at);
  }
  return at;
}
function deadline(state: WeatherTimeseriesUnitState): RuntimeUnitDeadline | null {
  const wallTimeMs = state.intents.reduce((at, item) => Math.min(at, item.expiresAt), subjectDeadline(state.subjects));
  return wallTimeMs === Infinity ? null : { wallTimeMs, monotonicMs: null };
}
function step(state: WeatherTimeseriesUnitState): InternalStep {
  return { state, nextDeadline: deadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [] };
}
function outcome(original: WeatherTimeseriesSubject, changedFields: readonly string[]): SubjectOutcome {
  // A8-COST: the public outcome of an unchanged subject is reused, so a view rebuild never rescans its periods.
  const reusable = changedFields.length === 0;
  const cached = reusable ? outcomeCache.get(original) : undefined;
  if (cached != null) return cached;
  const item = shownSubject(original);
  const known = item.periods.flatMap((row) => {
    const value = item.values[row[10]];
    return value.kind === "significancy" && value.name.kind !== "empty" && value.name.kind !== "missing" && value.code.kind === "text"
      && /^(?:00|01|11|20|21|22|30|31|41|50|51)$/.test(value.code.raw) ? [value.code.raw] : [];
  });
  const result: SubjectOutcome = { subject: item.subject, operation: item.operation, informationType: item.source?.infoTypeRaw ?? "",
    transition: item.effective, severity: null, source: item.source,
    facts: { effective: item.effective, periodCount: item.periods.length,
      knownMaxCode: known.length === 0 ? null : known.sort().at(-1)! }, changedFields };
  if (reusable) outcomeCache.set(original, result);
  return result;
}
// 時計の根拠ごとに（P3-EF-AC02・AC04）、awaiting は何も当てない。unverified は validUntil の来た active に保留の印を付けるだけ。verified は
// validUntil の来た active と保留の subject（時計によらず）を noActiveItems＋lapsed に移し、retainUntil と intent を回収する。
function collect(state: WeatherTimeseriesUnitState, wallTimeMs: number, monotonicMs: number, change: CurrentChange, basis: WallBasis): {
  state: WeatherTimeseriesUnitState; outcomes: WeatherTimeseriesUnitStep["outcomes"];
  decisions: WeatherTimeseriesUnitStep["decisions"] } {
  const none = { state, decisions: [], outcomes: [] };
  const verified = basis === "verified";
  if (basis === "awaiting") return none;
  const expired: WeatherTimeseriesSubject[] = [];
  const retained: WeatherTimeseriesSubject[] = [];
  let removed = false, marked = false;
  // A8-COST: a cached subject deadline still ahead means no subject expires; skip the subject scan.
  // P3-LIFE-AC05: validUntil と retainUntil が一致するときは validUntil の失効を回収より先に出す。
  // retainUntil が先に過ぎた回収は従来どおり結果を出さない（P2-A8-T06）。
  if (displayMin(state.subjects) <= wallTimeMs || verified && (recallMin(state.subjects) <= wallTimeMs || pendingMin(state.subjects) !== Infinity))
    for (const item of state.subjects) {
      let kept = item;
      const pending = item.expiryPending === true;
      if (item.validUntil != null && (pending || item.validUntil <= wallTimeMs)) {
        if (!verified) {
          if (!pending) { kept = { ...item, expiryPending: true }; change(item, kept); marked = true; }
        } else if (item.retainUntil > wallTimeMs || item.validUntil === item.retainUntil) {
          const { expiryPending: _pending, ...rest } = withoutMark(item);
          kept = { ...rest, ...EMPTY, effective: "noActiveItems" as const, validUntil: null, lapsed: true };
          change(item, kept); expired.push(kept);
        }
      }
      if (verified && item.retainUntil <= wallTimeMs) { removed = true; change(kept, null); continue; }
      retained.push(kept);
    }
  const expiredIntents = verified ? state.intents.filter((item) => item.expiresAt <= wallTimeMs) : [];
  if (!removed && !marked && expired.length === 0 && expiredIntents.length === 0) return none;
  // Intent-only collection keeps the subjects reference so the deadline cache stays valid.
  // gates ⊆ subjects (replace, capacity eviction and persisted() keep it), so only removal orphans a gate.
  const subjects = removed || marked || expired.length !== 0 ? retained : state.subjects;
  const keys = removed ? new Set(subjects.map((item) => item.subject)) : null;
  const next = { ...state, subjects,
    gates: keys == null ? state.gates : state.gates.filter((item) => keys.has(item.subject)),
    intents: expiredIntents.length === 0 ? state.intents : state.intents.filter((item) => item.expiresAt > wallTimeMs),
    persistence: dirty(state.persistence, monotonicMs) };
  return { state: next,
    decisions: expired.map((item) => ({ subject: item.subject, operation: item.operation,
      decision: "changed" as const, reason: null, change: "semantic" as const, currentEstablished: null })),
    outcomes: expired.length === 0 ? [] : [{ kind: "deadlineApplied", subjects: expired.map((item) =>
      outcome(item, ["effective", "periods", "validUntil"])) }] };
}
// AC04/Q-PERIOD: table indexes are local to each snapshot and have no semantic identity.
function periodMeaning(snapshot: WeatherTimeseriesSnapshot, row: WeatherTimeseriesSnapshot["periods"][number]): WeatherTimeseriesDetailPeriod {
  const text = (index: number | null) => index == null ? null : snapshot.strings[index];
  const series = snapshot.series[row[0]], time = series.timeDefines[row[8]], area = snapshot.areas[row[1]],
    kind = snapshot.kinds[row[2]], local = row[5] == null ? null : snapshot.locals[row[5]];
  return [series.meteorologicalInfosPosition, series.timeSeriesInfoPosition,
    [text(time.timeId), text(time.dateTimeRaw), text(time.durationRaw), text(time.name), time.startMs, time.endMs],
    [text(area.code), text(area.name)], [text(kind.status), text(kind.dateTimeRaw), text(kind.dateTimeType)],
    text(row[3]), text(row[4]), local == null ? null : [text(local.code), text(local.areaNameCode),
      text(local.areaName), text(local.name), local.anonymousPosition], text(row[6]), text(row[7]),
    snapshot.attributes[row[9]].map(([name, value]) => [text(name), text(value)]), snapshot.values[row[10]]];
}
function sameSource(left: ReportRef, right: ReportRef): boolean {
  return left.operation === right.operation && left.family === right.family && left.subject === right.subject
    && left.reportDateTimeRaw === right.reportDateTimeRaw && left.serialRaw === right.serialRaw
    && left.infoTypeRaw === right.infoTypeRaw;
}
function replace(state: WeatherTimeseriesUnitState, item: WeatherTimeseriesSubject, change: CurrentChange, mark: ReportRef | null): WeatherTimeseriesUnitState {
  let previous: WeatherTimeseriesSubject | null = null;
  const subjects = state.subjects.filter((old) => {
    if (old.subject !== item.subject) return true;
    previous = old; return false;
  });
  change(previous, item);
  return { ...state,
    subjects: [...subjects, item],
    gates: [...state.gates.filter((old) => old.subject !== item.subject),
      { subject: item.subject, operation: item.operation, source: item.source!, ...mark == null ? {} : { unconfirmed: mark } }] };
}
function fits(state: WeatherTimeseriesUnitState, generation: number, capturedAt: number): boolean {
  return state.subjects.length <= SUBJECT_LIMIT
    && measure(state.subjects, state.gates, state.intents, generation, capturedAt) <= LIMIT;
}
function evict(state: WeatherTimeseriesUnitState, target: string, generation: number, capturedAt: number, change: CurrentChange): WeatherTimeseriesUnitState {
  let next = state;
  const candidates = () => [...next.subjects].filter((item) => item.subject !== target && item.operation !== "normal")
    .sort((a, b) => Date.parse(a.source?.reportDateTimeRaw ?? "") - Date.parse(b.source?.reportDateTimeRaw ?? "")
      || a.subject.localeCompare(b.subject));
  for (const candidate of candidates()) {
    if (candidate.lastKnown == null) continue;
    const replacement = { ...candidate, lastKnown: null };
    change(candidate, replacement);
    next = { ...next, subjects: next.subjects.map((item) => item === candidate ? replacement : item) };
    if (fits(next, generation, capturedAt)) break;
  }
  return next;
}
function reduceWeatherTimeseriesCore(state: WeatherTimeseriesUnitState,
  input: Extract<WeatherTimeseriesInput, { kind: "receive" }>, changed: CurrentChange): InternalStep {
  const checked = inspect(input.material);
  if (checked.kind === "rejected") return { ...step(state),
    decisions: [{ subject: checked.subject, operation: input.material.operation, decision: "rejected", reason: checked.reason }],
    diagnostics: [checked.diagnostic] };
  const candidate = checked.candidate, { source } = candidate, notes = checked.diagnostics;
  const collected = collect(state, input.clock.wallTimeMs, input.clock.monotonicMs, changed, input.basis ?? "verified");
  const base = collected.state;
  const previous = base.subjects.find((item) => item.subject === source.subject);
  const gate = base.gates.find((item) => item.subject === source.subject);
  const snapshot = candidate.cancelled || candidate.validUntil == null || candidate.validUntil <= input.clock.wallTimeMs
    ? EMPTY : candidate.snapshot;
  const effective = candidate.cancelled ? "cancelled" as const : snapshot.periods.length === 0 ? "noActiveItems" as const : "active" as const;
  const normal: WeatherTimeseriesSubject = { ...snapshot, subject: source.subject, operation: source.operation, source,
    effective, unavailableReason: null, lastKnown: null, affectedScope: "subject",
    validUntil: snapshot.periods.length === 0 ? null : candidate.validUntil,
    retainUntil: retainUntil(candidate.reportDateTimeMs, snapshot.periods.length === 0 ? null : candidate.validUntil),
    ...effective !== "active" || candidate.unreadable == null ? {} : { unreadable: candidate.unreadable } };
  // 予報の意味が同じか（表の並びの違いは同じ、P2-A3 の periodMeaning）。採用の change と同じ版の中身の比べに使う。
  const sameMeaning = () => previous != null && previous.effective === normal.effective && previous.validUntil === normal.validUntil
    && previous.periods.length === normal.periods.length && previous.periods.every((row, index) =>
      isDeepStrictEqual(periodMeaning(previous, row), periodMeaning(normal, normal.periods[index])));
  // P3-VM-AC03・AC04: 門の版と compareVersion で比べる。同じ版で同じ報なら duplicate、同じ時刻の取消は取消でない報に勝ち（作者裁定 2026-10-21 昼）、
  // ほかの同じ時刻の食い違いと比べる時刻の欠けは門の版を残して印を付ける（Q-REV-UF の同時刻の訂正）。同じ時刻の食い違いに今の WARN は無い。
  // 同じ報は版の欄と予報の意味が同じもの。予報を持たない記録（期限切れ・取消・容量の unavailable）は事実が無いので版の欄だけで見る。
  const version = stepVersion(gate == null ? null : { version: gate.source, source: gate.source, cancelled: gate.source.infoTypeRaw === "取消" },
    gate?.unconfirmed ?? null, source, () => gate != null && sameSource(source, gate.source)
      && (previous == null || previous.effective !== "active" || sameMeaning()), candidate.cancelled);
  const missing: DiagnosticDetails[] = version.kind !== "older" && version.kind !== "duplicate" && version.missing
    ? [{ level: "WARN", component: "weather-timeseries", reason: "requiredStructureMissing", unit: "U-F", inputId: input.material.inputId }] : [];
  if (version.kind !== "adopt") {
    const unchanged = { ...step(base), decisions: [{ subject: source.subject, operation: source.operation, decision: "unchanged" as const,
      reason: version.kind === "duplicate" ? "duplicate" as const : "stale" as const }], outcomes: collected.outcomes, diagnostics: [...notes, ...missing] };
    if (version.kind !== "held" || gate == null || version.mark == null || gate.unconfirmed === version.mark) return unchanged;
    // 印は保存の byte に入るので fit を通す。収まらなければ印を置かず unit/operation の未確認へ寄せる（P3-CC-AC02・AC07 と同じ最終段の拒否）。
    const marked = { ...base, gates: base.gates.map((item) => item === gate ? { ...gate, unconfirmed: version.mark! } : item) };
    if (!fits(marked, state.persistence.currentGeneration + 1, input.clock.wallTimeMs)) return { ...step(state),
      decisions: [{ subject: source.subject, operation: source.operation, decision: "capacityExceeded" }], diagnostics: [...notes, ...missing,
        { level: "WARN", component: "weather-timeseries", reason: "capacityRejected", unit: "U-F", inputId: input.material.inputId }] };
    const kept = { ...marked, persistence: dirty(state.persistence, input.clock.monotonicMs) };
    return { ...unchanged, state: kept, nextDeadline: deadline(kept) };
  }
  const evidence = { family: "VPWP50", reportDateTimeMs: candidate.reportDateTimeMs, affectedScope: "subject" as const };
  const change = sameMeaning() ? "revisionOnly" as const : "semantic" as const;
  const changedFields = change === "revisionOnly" ? ["source", "retainUntil"] : ["source", "effective", "periods", "validUntil", "retainUntil"];
  let proposed = replace(base, normal, changed, version.mark);
  // P3-UM-AC03 (3): 原文の合計が予算を越えたら古い subject の原文から外す（付加事項の原文を先に、印は残る）。器の退去より先に当てる。
  const raw = fitRawBudget(rawTotal(proposed.subjects), WEATHER_TIMESERIES_RAW_BUDGET, () => proposed.subjects,
    (item) => [Date.parse(item.source?.reportDateTimeRaw ?? ""), item.subject], true);
  if (raw != null) proposed = { ...proposed, subjects: proposed.subjects.map((item) => {
    const after = stripRaw(item, raw);
    if (after !== item) changed(item, after);
    return after;
  }) };
  const generation = state.persistence.currentGeneration + 1;
  if (!fits(proposed, generation, input.clock.wallTimeMs)) {
    proposed = evict(proposed, source.subject, generation, input.clock.wallTimeMs, changed);
    if (!fits(proposed, generation, input.clock.wallTimeMs)) {
      for (const item of [...proposed.subjects].filter((entry) => entry.subject !== source.subject && entry.operation !== "normal")
        .sort((a, b) => Date.parse(a.source?.reportDateTimeRaw ?? "") - Date.parse(b.source?.reportDateTimeRaw ?? "")
          || a.subject.localeCompare(b.subject))) {
        changed(item, null);
        proposed = { ...proposed, subjects: proposed.subjects.filter((entry) => entry !== item),
          gates: proposed.gates.filter((entry) => entry.subject !== item.subject) };
        if (fits(proposed, generation, input.clock.wallTimeMs)) break;
      }
    }
  }
  let adopted = normal, established: typeof evidence | null = evidence;
  if (!fits(proposed, generation, input.clock.wallTimeMs)) {
    const lastKnown: WeatherTimeseriesSnapshot | null = previous == null ? null
      : previous.effective === "unavailable" ? previous.lastKnown
        : { strings: previous.strings, attributes: previous.attributes, values: previous.values,
          series: previous.series, areas: previous.areas, locals: previous.locals, kinds: previous.kinds,
          periods: previous.periods };
    // 無いと normal の retainUntil（長い validUntil）を引き継ぎ、decode が拒否する保存物ができる（P3-LIFE-T04）。
    adopted = { ...withoutMark(normal), ...EMPTY, effective: "unavailable", unavailableReason: "capacityExceeded",
      validUntil: null, retainUntil: retainUntil(candidate.reportDateTimeMs, null), lastKnown };
    proposed = replace(proposed, adopted, changed, version.mark);
    established = null;
    if (!fits(proposed, generation, input.clock.wallTimeMs)) {
      adopted = { ...adopted, lastKnown: null };
      proposed = replace(proposed, adopted, changed, version.mark);
    }
  }
  // P3-CC-AC07: 容量で current にできなかった入力（印か最終段の拒否）ごとに 1 行。P3-WS-AC02: inspect の読み飛ばしの診断は門の決定によらず前に置く。
  const rejected: DiagnosticDetails[] = [...notes, ...missing, ...established == null ? [{ level: "WARN", component: "weather-timeseries",
    reason: "capacityRejected", unit: "U-F", inputId: input.material.inputId } satisfies DiagnosticDetails] : []];
  if (!fits(proposed, generation, input.clock.wallTimeMs)) return { ...step(state),
    decisions: [{ subject: source.subject, operation: source.operation, decision: "capacityExceeded" }], diagnostics: rejected };
  proposed = { ...proposed, persistence: dirty(state.persistence, input.clock.monotonicMs) };
  // P3-UM-AC03 (4): 外した原文は確定した state に残った記録だけ数える（拒否で戻した仮の state の分は数えない）。
  const dropped = droppedIn(raw, proposed.subjects);
  const finalFields = established == null ? ["source", "effective", "periods", "validUntil", "retainUntil",
    "unavailableReason", "lastKnown", "affectedScope"] : changedFields;
  const deadlineOutcomes: PublishedOutcome[] = [];
  for (const event of collected.outcomes) {
    if (event.kind !== "deadlineApplied") { deadlineOutcomes.push(event); continue; }
    const subjects = event.subjects.filter((item) => item.subject !== source.subject);
    if (subjects.length > 0) deadlineOutcomes.push({ kind: "deadlineApplied", subjects });
  }
  return { ...step(proposed), decisions: [{ subject: source.subject, operation: source.operation,
    decision: "changed", reason: null, change: established == null ? "semantic" : change,
    currentEstablished: established }],
    outcomes: [...deadlineOutcomes, { kind: "accepted", change: established == null ? "semantic" : change,
      subjects: [outcome(adopted, finalFields)] }], diagnostics: dropped === 0 ? rejected
      : [...rejected, { level: "INFO", component: "weather-timeseries", reason: "unreadableDropped", unit: "U-F", count: dropped }] };
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function index(value: unknown, length: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < length;
}
function materialValue(value: unknown): boolean {
  const row = object(value);
  if (row == null) return false;
  if (row.kind === "missing") return true;
  if (row.kind === "empty" || row.kind === "unknown") return typeof row.raw === "string";
  if (row.kind === "text") return typeof row.raw === "string" && typeof row.value === "string";
  if (row.kind === "number") return typeof row.raw === "string" && finite(row.value);
  return row.kind === "range" && typeof row.raw === "string" && finite(row.value)
    && (row.bound === "lower" || row.bound === "upper");
}
function compoundField(value: unknown): boolean {
  const row = object(value);
  return row != null && typeof row.name === "string" && Array.isArray(row.attributes)
    && row.attributes.every((entry: unknown) => { const attr = object(entry);
      return attr != null && typeof attr.name === "string" && typeof attr.value === "string"; })
    && (materialValue(row.value) || Array.isArray(row.value) && row.value.every(compoundField));
}
function storedValue(value: unknown): boolean {
  const row = object(value);
  if (row == null) return false;
  if (row.kind === "significancy") return materialValue(row.name) && materialValue(row.code);
  if (row.kind === "peakTime" || row.kind === "criteriaPeriod")
    return Array.isArray(row.fields) && row.fields.every(compoundField);
  return materialValue(value);
}
function reportRef(value: unknown): value is ReportRef {
  const ref = readReportRef(value);
  return ref != null && ref.family === "VPWP50" && ref.subject !== "" && Number.isFinite(Date.parse(ref.reportDateTimeRaw));
}
function snapshot(value: unknown): value is WeatherTimeseriesSnapshot {
  const record = object(value);
  if (record == null || !Array.isArray(record.strings) || !record.strings.every((item) => typeof item === "string")
    || !Array.isArray(record.attributes) || !Array.isArray(record.values) || !Array.isArray(record.series)
    || !Array.isArray(record.areas) || !Array.isArray(record.locals) || !Array.isArray(record.kinds)
    || !Array.isArray(record.periods)) return false;
  const strings = record.strings.length, series = record.series as unknown[];
  const areas = record.areas as unknown[], kinds = record.kinds as unknown[], locals = record.locals as unknown[];
  const attributes = record.attributes as unknown[], values = record.values as unknown[];
  if (!record.attributes.every((set) => Array.isArray(set) && set.every((pair) => Array.isArray(pair)
    && pair.length === 2 && pair.every((entry) => index(entry, strings))))) return false;
  if (!record.values.every(storedValue)) return false;
  if (!series.every((entry) => { const row = object(entry); return row != null
    && Number.isSafeInteger(row.meteorologicalInfosPosition) && Number(row.meteorologicalInfosPosition) >= 0
    && Number.isSafeInteger(row.timeSeriesInfoPosition) && Number(row.timeSeriesInfoPosition) >= 0
    && Array.isArray(row.timeDefines) && row.timeDefines.every((time: unknown) => { const t = object(time);
      return t != null && index(t.timeId, strings) && index(t.dateTimeRaw, strings)
        && index(t.durationRaw, strings) && (t.name === null || index(t.name, strings))
        && finite(t.startMs) && finite(t.endMs) && t.endMs > t.startMs; }); })) return false;
  if (!record.areas.every((entry) => { const row = object(entry); return row != null && index(row.code, strings)
    && (row.name === null || index(row.name, strings)); })) return false;
  if (!record.locals.every((entry) => { const row = object(entry); return row != null
    && [row.code, row.areaNameCode, row.areaName, row.name].every((part) => part === null || index(part, strings))
    && (row.anonymousPosition === null || Number.isSafeInteger(row.anonymousPosition)
      && Number(row.anonymousPosition) >= 0); })) return false;
  if (!record.kinds.every((entry) => { const row = object(entry); return row != null
    && [row.status, row.dateTimeRaw, row.dateTimeType].every((part) => part === null || index(part, strings)); })) return false;
  return record.periods.every((entry) => Array.isArray(entry) && entry.length === 11
    && index(entry[0], series.length) && index(entry[1], areas.length)
    && index(entry[2], kinds.length) && index(entry[3], strings) && index(entry[4], strings)
    && (entry[5] === null || index(entry[5], locals.length)) && index(entry[6], strings)
    && (entry[7] === null || index(entry[7], strings))
    && index(entry[8], (series[entry[0]] as { timeDefines: unknown[] }).timeDefines.length)
    && index(entry[9], attributes.length) && index(entry[10], values.length));
}
function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  const row = object(value);
  return row != null && Object.values(row).every(json);
}
// P3-UM-AC01 (2): 印の site の表（WeatherTimeseriesUnreadableSite）。
const UNREADABLE_SITES: ReadonlySet<string> = new Set(["Body", "MeteorologicalInfos", "TimeSeriesInfo", "TimeDefines", "TimeDefine", "Item", "Area",
  "Kind", "Property", "Part", "Significancy", "skipped", "duplicateValue", "bodyOther", "addition"] satisfies readonly WeatherTimeseriesUnreadableSite[]);
// 要素は確かめたまま使う（measure が object の同一性で byte を cache するので、作り直すと encode のたびに全要素を直列化し直す、P3-IUR-AC06）。
function subjectRow(value: unknown): value is WeatherTimeseriesSubject {
  const item = object(value), source = object(item?.source);
  return snapshot(value) && typeof item?.subject === "string" && item.subject !== ""
    && ["normal", "training", "test"].includes(String(item.operation))
    && ["active", "noActiveItems", "cancelled", "unavailable"].includes(String(item.effective))
    && (item.unavailableReason === null || ["capacityExceeded", "historyUnavailable", "coverageIncomplete"].includes(String(item.unavailableReason)))
    && (item.lastKnown === null || snapshot(item.lastKnown))
    && (item.affectedScope === "subject" || Array.isArray(item.affectedScope)
      && item.affectedScope.every((part: unknown) => typeof part === "string"))
    && (item.validUntil === null || finite(item.validUntil)) && finite(item.retainUntil)
    && (reportRef(item.source) && source?.subject === item.subject && source.operation === item.operation
      || item.source === null && item.effective === "unavailable" && item.unavailableReason === "coverageIncomplete")
    && item.subject.startsWith(`${item.operation}/VPWP50/`) && item.subject.length > `${item.operation}/VPWP50/`.length
    // P3-LIFE-AC06: 旧式（報時刻＋7 日）の保存物もそのまま読み、新式へ引き上げない。
    && (source === null || item.retainUntil === Date.parse(String(source.reportDateTimeRaw)) + RETAIN
      || item.retainUntil === retainUntil(Date.parse(String(source.reportDateTimeRaw)), item.validUntil))
    && (item.effective !== "unavailable" || item.unavailableReason != null
      && Array.isArray(item.periods) && item.periods.length === 0)
    // P3-EF-AC05 (1)(6): 保留の印は active にだけ、lapsed は noActiveItems にだけ置け、値は true だけ。
    && (!("expiryPending" in item) || item.expiryPending === true && item.effective === "active")
    // P3-UM-AC16 (3)(a): 読めない所の印は active にだけ置け、形は表の内。
    && (!("unreadable" in item) || item.effective === "active" && readUnreadableMark(item.unreadable, UNREADABLE_SITES) != null)
    && (!("lapsed" in item) || item.lapsed === true && item.effective === "noActiveItems");
}
function gateRow(value: unknown): value is WeatherTimeseriesGate {
  const gate = object(value), source = object(gate?.source);
  const mark = object(gate?.unconfirmed);
  // P3-VM-AC04: 印は同じ subject・operation の報（取消の後の時刻の無い報の印も残る）。
  return gate != null && typeof gate.subject === "string" && reportRef(gate.source)
    && source?.subject === gate.subject && source.operation === gate.operation
    && (!("unconfirmed" in gate) || reportRef(gate.unconfirmed) && mark?.subject === gate.subject && mark.operation === gate.operation);
}
// subject は文字列であることだけを確かめる（P2-A1-T12 が U-F の intent を別の形の subject で往復させる）。
function intentRow(value: unknown): value is NotificationIntent {
  const item = object(value);
  return item != null && typeof item.id === "string" && item.unit === "U-F" && typeof item.subject === "string"
    && typeof item.operation === "string" && ["normal", "training", "test"].includes(item.operation) && reportRef(item.source)
    && item.source.subject === item.subject && item.source.operation === item.operation
    && typeof item.transition === "string" && ["activated", "updated", "cancelled", "released", "expired"].includes(item.transition)
    && (item.channel === "desktop" || item.channel === "sound") && object(item.payload) != null && json(item.payload)
    && finite(item.createdAt) && finite(item.expiresAt) && finite(item.nextAttemptAt) && item.expiresAt >= item.createdAt
    && Number.isSafeInteger(item.attempts) && Number(item.attempts) >= 0 && typeof item.configRevision === "string"
    && readIntentState(item, "U-F", item.operation, null) != null;
}
function persisted(payload: unknown): PersistedWeatherTimeseriesUnit | null {
  const row = object(payload);
  if (row?.schemaVersion !== SCHEMA || !Array.isArray(row.subjects) || row.subjects.length > SUBJECT_LIMIT
    || !Array.isArray(row.gates) || !Array.isArray(row.intents)) return null;
  const subjects: unknown[] = row.subjects, gates: unknown[] = row.gates, intents: unknown[] = row.intents;
  if (!subjects.every(subjectRow) || !gates.every(gateRow) || !intents.every(intentRow)) return null;
  if (new Set(subjects.map((item) => item.subject)).size !== subjects.length
    || new Set(gates.map((item) => item.subject)).size !== gates.length
    || gates.length > subjects.length
    || subjects.some((item) => item.source !== null && !gates.some((gate) =>
      gate.subject === item.subject && gate.operation === item.operation && isDeepStrictEqual(item.source, gate.source)))
    || gates.some((gate) => !subjects.some((item) => item.subject === gate.subject
      && item.operation === gate.operation && (item.source === null || isDeepStrictEqual(item.source, gate.source))))
    || new Set(intents.map((item) => item.id)).size !== intents.length) return null;
  const value: PersistedWeatherTimeseriesUnit = { schemaVersion: SCHEMA, subjects, gates, intents };
  const pending = intents.filter((item) => item.disposition === "pending");
  if (pending.length > 128 || encoder.encode(JSON.stringify(pending)).byteLength + reserve(pending) > 131_072) return null;
  // P3-UM-AC16 (3)(c): 原文の合計（AC03 (1) の数え方）が予算の内。
  return measure(subjects, gates, intents, 0, 0) <= LIMIT && rawTotal(subjects) <= WEATHER_TIMESERIES_RAW_BUDGET ? value : null;
}
const weatherTimeseriesUnitCodec: WeatherTimeseriesUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p2-weather-timeseries-unit-v1", "p2-weather-timeseries-unit-v2", "p2-weather-timeseries-unit-v3", "p2-weather-timeseries-unit-v4", "p2-weather-timeseries-unit-v5", "p2-weather-timeseries-unit-v6", "p2-weather-timeseries-unit-v7"], maxEnvelopeBytes: LIMIT, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  encode(state) {
    const value = persisted({ schemaVersion: SCHEMA, subjects: state.subjects, gates: state.gates, intents: state.intents });
    if (value == null) throw new Error("invalid U-F checkpoint payload");
    return value;
  },
  decode(payload: JsonValue) {
    const value = persisted(payload);
    return value == null ? { kind: "invalid", reason: `invalid ${SCHEMA} payload` }
      : { kind: "restored", state: { ...value, contentRevision: 0, persistence: { kind: "saved", currentGeneration: 0,
        savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } };
  },
};
function reduceCore(state: WeatherTimeseriesUnitState, input: WeatherTimeseriesInput, changed: CurrentChange): InternalStep {
  if (input.kind === "receive") return reduceWeatherTimeseriesCore(state, input, changed);
  if (input.kind === "restore") {
    const decoded = weatherTimeseriesUnitCodec.decode(input.persisted);
    if (decoded.kind === "invalid") return { ...step(state), decisions: [{ subject: "", operation: "normal",
      decision: "rejected", reason: "requiredStructureInvalid" }], diagnostics: [{ level: "WARN", component: "weather-timeseries",
      reason: "requiredStructureInvalid", unit: "U-F" }] };
    // P3-NL-AC08 (1): started のまま残った pending は通知したか不明（再試行しない）。
    const restored = restoreStarted(decoded.state.intents);
    const base = { ...decoded.state, intents: restored.intents,
      persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, input.clock.monotonicMs) };
    const applied = collect(base, input.clock.wallTimeMs, input.clock.monotonicMs, () => {}, input.basis ?? "verified");
    for (const item of applied.state.subjects) changed(null, item);
    return { ...step(applied.state), outcomes: [{ kind: "recoveryApplied", scope: ["U-F"],
      coverage: applied.state.subjects.map((item) => item.subject), subjects: [] }],
      diagnostics: restored.started.length === 0 ? [] : [{ level: "INFO", component: "weather-timeseries",
        reason: "notificationOutcomeUnknown", unit: "U-F", count: restored.started.length }] };
  }
  if (input.kind === "intentUpdate") {
    const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
    const originals = new Map(state.intents.map((item) => [item.id, item]));
    const changed = new Map<string, NotificationIntent>();
    let persistence = state.persistence;
    for (const update of updates) {
      const current = originals.get(update.id);
      const updated = current == null ? null : applyIntentUpdate(current, update);
      if (updated == null) continue;
      changed.set(updated.id, updated);
      persistence = dirty(persistence, input.clock.monotonicMs);
    }
    if (changed.size === 0) return step(state);
    const adopted = [...changed.values()];
    // P3-NL-AC05 (1): pending でなくなった intent は intents から外す。
    const next = { ...state, intents: state.intents.flatMap((item) => {
      const updated = changed.get(item.id);
      return updated == null ? [item] : updated.disposition === "pending" ? [updated] : [];
    }), persistence };
    return { ...step(next), decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation,
      decision: "changed", reason: null, change: "deliveryOnly", currentEstablished: null })),
      intents: adopted.filter((item) => item.disposition === "pending"),
      outcomes: adopted.map((item) => ({ kind: "accepted", change: "deliveryOnly", subjects: [{ subject: item.subject,
        operation: item.operation, informationType: item.source.infoTypeRaw, transition: item.disposition,
        severity: null, source: item.source, facts: { intentId: item.id }, changedFields: ["intents"] }] })) };
  }
  const applied = collect(state, input.clock.wallTimeMs, input.clock.monotonicMs, changed, input.basis ?? "verified");
  if (input.kind === "deadline") return { ...step(applied.state), decisions: applied.decisions, outcomes: applied.outcomes };
  return { ...step(applied.state), outcomes: [{ kind: "batchCompleted", reason: "shutdown", subjects: [] }] };
}
// P3-UFP-AC01: subject の公開形式。subject の object ごとに 1 回だけ作る（outcomeCache と同じ形）。無いと view を作り直すたびに、
// 変わっていない subject の period まで走査し直す。
const publicCache = new WeakMap<WeatherTimeseriesSubject, WeatherTimeseriesPublicSubject>();
// subject の object を作った step の unit の内容版（Q-UFP-REVISION）。保存しない。reduce を通っていない object（手で組んだ state）は 0。
const revisionOf = new WeakMap<WeatherTimeseriesSubject, number>();
// view-projector.ts の TIMESERIES_SEVERITY の鍵と同じ集合（Q-VALUES.knownCodes）。ずれると要約の件数が変わるので揃えて保つ。
const KNOWN_CODES: ReadonlySet<string> = new Set(["00", "01", "11", "20", "21", "22", "30", "31", "41", "50", "51"]);
function publicSubject(original: WeatherTimeseriesSubject): WeatherTimeseriesPublicSubject {
  const cached = publicCache.get(original);
  if (cached != null) return cached;
  const item = shownSubject(original);
  const areaCodes = new Set<string>(), known = new Set<string>();
  const unknownCode = { unknown: 0, missing: 0, empty: 0 };
  // 要約が数えるのは active の subject だけ（P2-A8-SUMMARY）。
  if (item.effective === "active") for (const row of item.periods) {
    const area = item.strings[item.areas[row[1]].code];
    if (area !== "") areaCodes.add(area);
    const value = item.values[row[10]];
    if (value.kind !== "significancy") continue;
    const reason = value.name.kind === "missing" || value.code.kind === "missing" ? "missing"
      : value.name.kind === "empty" || value.code.kind === "empty" ? "empty" : value.code.kind === "text" ? null : "unknown";
    if (reason == null && value.code.kind === "text" && KNOWN_CODES.has(value.code.raw)) known.add(value.code.raw);
    else unknownCode[reason ?? "unknown"] += 1;
  }
  const result: WeatherTimeseriesPublicSubject = { subject: item.subject, operation: item.operation,
    office: item.subject.slice(`${item.operation}/VPWP50/`.length),
    id: createHash("sha256").update(JSON.stringify(["U-F", item.operation, item.subject]), "utf8").digest("hex"),
    revision: String(revisionOf.get(original) ?? 0), source: item.source, effective: item.effective,
    unavailableReason: item.unavailableReason, validUntil: item.validUntil,
    areaCodes: [...areaCodes].sort(), knownCodes: [...known].sort(), unknownCode,
    periodCount: item.periods.length, lastKnownPeriodCount: item.lastKnown?.periods.length ?? null,
    ...item.effective !== "active" || item.unreadable == null ? {} : { unreadableView: markView(item.unreadable) } };
  publicCache.set(original, result);
  return result;
}
function displaySubject(item: WeatherTimeseriesSubject): Extract<RuntimeDisplaySubject, { unit: "U-F" }> {
  return { unit: "U-F", operation: item.operation, subject: item.subject, office: publicSubject(item).office,
    current: publicSubject(item), subjects: [outcome(item, [])] };
}
function toWeatherTimeseriesView(state: WeatherTimeseriesUnitState): WeatherTimeseriesUnitView {
  return { unit: "U-F", semanticRevision: state.subjects.map((item) =>
    `${item.subject}:${item.source?.reportDateTimeRaw ?? ""}:${item.source?.serialRaw ?? ""}:${item.source?.infoTypeRaw ?? ""}:${shownSubject(item).effective}`)
    .sort().join("|"), contentRevision: String(state.contentRevision), series: state.subjects.map(publicSubject),
    subjects: state.subjects.map((item) => outcome(item, [])) };
}

function reduceWeatherTimeseriesUnit(state: WeatherTimeseriesUnitState, input: WeatherTimeseriesInput): WeatherTimeseriesUnitStep {
  const changes = new Map<string, { before: WeatherTimeseriesSubject | null; after: WeatherTimeseriesSubject | null }>();
  const result = reduceCore(state, input, (before, after) => {
    const key = (after ?? before)!.subject;
    changes.set(key, { before: changes.has(key) ? changes.get(key)!.before : before, after });
  });
  // Q-UFP-REVISION: 新しい object の公開形式を作る前に、その版を記録する。
  if (result.state !== state) for (const { before, after } of changes.values())
    if (after != null && after !== before && !revisionOf.has(after)) revisionOf.set(after, state.contentRevision + 1);
  const subject = displaySubject;
  const displayChanges: WeatherTimeseriesUnitStep["displayChanges"] = result.state === state ? []
    : [...changes].flatMap(([key, { before, after }]) => before === after ? [] : [{
      unit: "U-F" as const, operation: (after ?? before)!.operation, subject: key,
      before: before == null ? null : subject(before), after: after == null ? null : subject(after),
    }]);
  if (displayChanges.length !== 0 && !Number.isSafeInteger(state.contentRevision + 1))
    throw new RangeError("U-F content revision exhausted");
  // 印も入らない最終段の拒否は unit/operation の未確認へ寄せる（P3-CC-AC02）。
  const confirmationEvidence: WeatherTimeseriesUnitStep["confirmationEvidence"] = input.kind === "receive"
    ? result.decisions.flatMap<WeatherTimeseriesUnitStep["confirmationEvidence"][number]>((item) => item.decision === "changed"
      && item.currentEstablished != null ? [{ source: "acceptedReport", scopes: [{ unit: "U-F", operation: item.operation,
        kind: "series", subject: item.subject, office: item.subject.slice(`${item.operation}/VPWP50/`.length) }] }]
      : item.decision === "capacityExceeded" ? [{ source: "capacityExceeded", scopes: [{ unit: "U-F", operation: item.operation,
        kind: "unit" }] }] : []) : [];
  return { ...result, state: displayChanges.length !== 0
    ? { ...result.state, contentRevision: state.contentRevision + 1 } : result.state,
    displayChanges, confirmationEvidence };
}
function reduceWeatherTimeseries(state: WeatherTimeseriesUnitState,
  input: Extract<WeatherTimeseriesInput, { kind: "receive" }>): WeatherTimeseriesUnitStep {
  return reduceWeatherTimeseriesUnit(state, input);
}

// P3-UNIT-TABLE-001: this unit's row; each field is one former unit branch of shared-runtime.ts.
const weatherTimeseriesUnit = {
  unit: "U-F",
  reduce: reduceWeatherTimeseriesUnit,
  toView: toWeatherTimeseriesView,
  persistence: { kind: "durable", codec: weatherTimeseriesUnitCodec },
  confirmationScopeLimit: 512,
  reclaimDeadlineBeforeReceive: false,
} satisfies UnitModule<"U-F">;

// P3-UFP-AC06: 詳細の 1 ページ。読むだけで、state も期限も dirty も動かさない。
const PERIOD_PAGE = 64, INDEX_PAGE = 32, ROW_BUDGET = 61_440, OFFICE_BYTES = 256;
// notice の source の office と同じ切り方（view-projector.ts の wellFormedPrefix、P2-A8-NOTICE.source）。import しない:
// view-projector は publisher 側の module で、owner（この unit）は publisher の module を読まない。
function officePrefix(value: string): Readonly<{ text: string; truncated: boolean }> {
  let text = "", size = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    const scalar = point >= 0xd800 && point <= 0xdfff ? "\ufffd" : char;
    const width = Buffer.byteLength(scalar);
    if (size + width > OFFICE_BYTES) return { text, truncated: true };
    text += scalar;
    size += width;
  }
  return { text, truncated: false };
}
const versionChanged = (revision: string | null): WeatherTimeseriesDetailResponse => ({ kind: "error", reason: "versionChanged", revision });
const invalid: WeatherTimeseriesDetailResponse = { kind: "error", reason: "invalidRequest", revision: null };
function weatherTimeseriesDetail(state: WeatherTimeseriesUnitState, request: WeatherTimeseriesDetailRequest,
  view: Readonly<{ contentRevision: string }>): WeatherTimeseriesDetailResponse {
  const pageOf = (count: number, size: number) => {
    const pageCount = Math.max(1, Math.ceil(count / size));
    return Number.isSafeInteger(request.page) && request.page >= 0 && request.page < pageCount ? pageCount : null;
  };
  if (request.part === "index") {
    if (request.revision !== view.contentRevision) return versionChanged(view.contentRevision);
    const pageCount = pageOf(state.subjects.length, INDEX_PAGE);
    if (pageCount == null) return invalid;
    const entries = state.subjects.slice(request.page * INDEX_PAGE, (request.page + 1) * INDEX_PAGE).map((item) => {
      const pub = publicSubject(item), office = officePrefix(pub.office);
      return { id: pub.id, operation: pub.operation, office: office.text, officeTruncated: office.truncated,
        revision: pub.revision, effective: pub.effective, periodCount: pub.periodCount, lastKnownPeriodCount: pub.lastKnownPeriodCount };
    });
    return { kind: "ok", part: "index", revision: view.contentRevision, page: request.page, pageCount, subjectCount: state.subjects.length, entries };
  }
  const item = state.subjects.find((candidate) => publicSubject(candidate).id === request.id);
  if (item == null) return versionChanged(null);
  const { revision } = publicSubject(item);
  if (request.revision !== revision) return versionChanged(revision);
  const snapshot = request.part === "current" ? shownSubject(item) : item.lastKnown;
  const count = snapshot?.periods.length ?? 0;
  const pageCount = pageOf(count, PERIOD_PAGE);
  if (pageCount == null) return invalid;
  const periods: { index: number; period: WeatherTimeseriesDetailPeriod }[] = [];
  const omitted: { index: number; reason: "pageBudget" }[] = [];
  let used = 0;
  if (snapshot != null) for (let index = request.page * PERIOD_PAGE; index < Math.min(count, (request.page + 1) * PERIOD_PAGE); index++) {
    const row = { index, period: periodMeaning(snapshot, snapshot.periods[index]) };
    // 入らない行は切らずに名前で挙げる。ページは完全な JSON のまま（spec §7.10 (6)）。
    const size = Buffer.byteLength(JSON.stringify(row)) + (periods.length === 0 ? 0 : 1);
    if (used + size > ROW_BUDGET) omitted.push({ index, reason: "pageBudget" });
    else { periods.push(row); used += size; }
  }
  return { kind: "ok", part: request.part, id: request.id, revision, page: request.page, pageCount, periodCount: count, periods, omitted };
}

export { outcome as timeseriesSubjectOutcome, publicSubject as timeseriesPublicSubject, reduceWeatherTimeseries, reduceWeatherTimeseriesUnit,
  toWeatherTimeseriesView, weatherTimeseriesDetail, weatherTimeseriesUnit, weatherTimeseriesUnitCodec };
