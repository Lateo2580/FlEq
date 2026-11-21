import { createHash } from "node:crypto";

import type { MaterialValue, Operation } from "../../contracts/p1-parser-boundary.types";
import type { EewCurrent, EewPredictionIntensity } from "../../contracts/p2-eew-unit.types";
import type { MarkViewed, PersistenceStatus, ReportRef, RuntimeDisplayChange, RuntimeUnitId, RuntimeViews, SubjectUnavailable, UnitId,
  UnreadableCardView } from "../../contracts/p2-shared-runtime.types";
import type { DisplayChannelView, SnapshotProjectionInput, SnapshotProjectionState, VisibleNotice } from "../../contracts/p2-snapshot-sse.types";
import type { EarthquakeEventView, LongPeriodSubject, SeismicIntensityItem, SeismicIntensityValue, SeismicRecentQuake, SeismicUnitView } from "../../contracts/p3-seismic-unit.types";
import type { TsunamiAreaClass, TsunamiForecastSubject, TsunamiObservationSubject, TsunamiUnitView } from "../../contracts/p3-tsunami-unit.types";
import type { KnownCodeTable } from "../../contracts/p4-gis-assets.types";
import type {
  DisplayCutText, DisplayDetailRef, DisplayFromTo, DisplayLevel, DisplayPaint, DisplayStateMark, DisplayValueText, DisplayWireCard,
  DisplayWireSnapshot, EarthquakeRowWire, EarthquakeWire, EewAreaRow, EewCard, EewCardHeader, EewCardLetter, EewMini, EewWire, LongPeriodWire,
  TsunamiForecastRow, TsunamiForecastWire, TsunamiWire,
} from "../../contracts/p4-display-wire.types";
import known from "../../assets/gis/known-codes.v1.json";
import { knownStage } from "../domains/seismic/seismic";
import { KIND_CLASS } from "../domains/tsunami/tsunami";

// P4-DISPLAY-WIRE-001（B0）: 新しい経路の射影。区域の規則・合成・札の字・文字列の上限の表・共通部の写しをここだけに置く（P4-DW-AC02・AC03・AC10）。
// 入力は unit の view と表示差分なので、受理の後も復元の後も同じに効く。state は保存しない。

const table: KnownCodeTable = known;
const SUBAREAS = table.forecastLocalE.map((item) => item.code), CITIES = table.city.map((item) => item.code), TSUNAMI_AREAS = table.tsunamiArea.map((item) => item.code);
const SUBAREA_SET = new Set(SUBAREAS), CITY_SET = new Set(CITIES), TSUNAMI_SET = new Set(TSUNAMI_AREAS);
const OPERATIONS = ["normal", "training", "test"] as const;
const VERSION = "p4-display-wire-v1" as const;

// 表示用の文字列の上限（escape 後の JSON の byte、引用符を除く）の唯一の表（P4-DW-D-STRING-SOURCE、台帳 50）。
const WIRE_LIMITS = {
  eventId: 40, time: 40, hypocenter: 192, coordinate: 64, valueRaw: 32, description: 96, place: 192, firstWave: 48, height: 24,
  unkeyedName: 192, tsunamiEval: 384, cardTitle: 96, cardHeadline: 384, comment: 2048,
} as const;
// 件数の上限（表 §1.2。EEW 6 枚・今日の地震の行・長周期は板待ちの仮の数）。
const WIRE_COUNTS = { eewCards: 6, tsunamiEvents: 3, unkeyed: 8, closed: 4, longPeriods: 2 } as const;
const LETTERS: readonly EewCardLetter[] = ["A", "B", "C", "D", "E", "F"];
// 津波の区分を上から見る順（既知の区分が unknown より先、P4-DW-AC02 の「既知の最大で塗る」）。
const TSUNAMI_ORDER: readonly TsunamiAreaClass[] = ["majorWarning", "warning", "unknown", "advisory", "forecast", "released", "none"];
const TSUNAMI_WEIGHT: Readonly<Record<TsunamiAreaClass, number>> = { majorWarning: 6, warning: 5, unknown: 5, advisory: 3, forecast: 2, released: 1, none: 0 };
const PERSISTENCE_REASON_BYTES = 256, TRUNCATED_MARKER = "[truncated:fieldLimit]";

// ---- 字と段 ----

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const escapedBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value)) - 2;
// boundedString と同じ単位で字の境で切る。印の字は足さず、cut で返す（P4-DW-AC03）。
function cutText(value: string, limit: number): DisplayCutText {
  if (escapedBytes(value) <= limit) return { text: value, cut: false };
  let text = "", bytes = 0;
  for (const character of value) {
    const size = escapedBytes(character);
    if (bytes + size > limit) break;
    text += character;
    bytes += size;
  }
  return { text, cut: true };
}
const cutOrNull = (value: string | null | undefined, limit: number): DisplayCutText | null => value == null ? null : cutText(value, limit);
// 時刻・EventID の生の字は上限を越えたら不明（null）にする（表 §1.3）。
const bounded = (value: string | null | undefined, limit: number): string | null => value == null || escapedBytes(value) > limit ? null : value;
function valueText(raw: string | null | undefined, description: string | null | undefined): DisplayValueText | null {
  if (raw == null) return null;
  const v = cutText(raw, WIRE_LIMITS.valueRaw), desc = description == null ? null : cutText(description, WIRE_LIMITS.description);
  return { v: v.text, desc: desc?.text ?? null, cut: v.cut || desc?.cut === true };
}
const rawOf = (value: MaterialValue): string | null => value.kind === "missing" ? null : value.raw;
const safeNumber = (raw: string): number => { const value = Number(raw.trim()); return Number.isSafeInteger(value) ? value : -1; };

// 震度の段（0〜9）。over は 10、不明は −1、表外は −2、欠けは null。
function level(value: MaterialValue): DisplayLevel {
  if (value.kind === "missing") return null;
  if (value.kind === "unknown") return -1;
  if (value.kind === "text" && value.value.normalize("NFKC").trim() === "over") return 10;
  return knownStage(value) ?? -2;
}
// 塗りの値: To が over か欠けなら From、ほかは To（DS-EEW-09・DS-INT-08 の「札の色は下の値」）。
function paintLevel(from: MaterialValue, to: MaterialValue): DisplayLevel {
  const top = level(to);
  return top == null || top === 10 ? level(from) : top;
}
// カードの最小の欄は「以上」を ＋10 で持つ。
function miniLevel(from: MaterialValue, to: MaterialValue): DisplayLevel {
  const bottom = level(from);
  return level(to) === 10 && bottom != null && bottom >= 0 ? bottom + 10 : paintLevel(from, to);
}
const intensityLevel = (value: SeismicIntensityValue): DisplayLevel => value.kind === "fromTo" ? paintLevel(value.from, value.to) : level(value);
// 長周期階級（0〜4）。over は 10、不明は −1、表外は −2。
function lgLevel(raw: string | null): DisplayLevel {
  if (raw == null) return null;
  const text = raw.normalize("NFKC").trim();
  return /^[0-4]$/.test(text) ? Number(text) : text === "over" ? 10 : text === "不明" ? -1 : -2;
}
function lgSeismic(value: SeismicIntensityValue): DisplayLevel {
  const item = value.kind === "fromTo" ? value.to.kind === "missing" ? value.from : value.to : value;
  return item.kind === "missing" ? null : item.kind === "unknown" ? -1 : lgLevel(item.raw);
}
// 到達の状況（Kind/Code の下 1 桁、0・1・9、表外は −2）。
function arrival(kindCodeRaw: string | null): EewAreaRow["ks"] {
  if (kindCodeRaw == null) return null;
  const digit = /^\d{2}$/.exec(kindCodeRaw.trim())?.[0][1];
  return digit === "0" ? 0 : digit === "1" ? 1 : digit === "9" ? 9 : -2;
}
// Condition はコードで送る（P4-DW-D-CONDITION-CODE）。資料の値は 1 つだけで、表に無い値は unknown。
const conditionCode = (value: string | null): EewAreaRow["cd"] => value == null ? null : value.trim() === "既に主要動到達と推測" ? "arrived" : "unknown";
function marksOf(record: Readonly<{ unconfirmed?: ReportRef; unavailable?: SubjectUnavailable | readonly SubjectUnavailable[]; expiryPending?: true }>): readonly DisplayStateMark[] {
  const marks: DisplayStateMark[] = [];
  if (record.unconfirmed != null) marks.push("unconfirmed");
  if (record.expiryPending === true) marks.push("expiryPending");
  if (record.unavailable != null) marks.push("capacityExceeded");
  return marks;
}
const refOf = (unit: RuntimeUnitId, operation: Operation, subject: string, object: unknown): DisplayDetailRef =>
  ({ id: sha256([unit, operation, subject]), rev: sha256(object) });

// ---- 合成の参照数（表 §5.1） ----

// 区域ごとに段の参照数を持つ。最後の欄は既知でない段の参照（鍵 op|…|code|? に当たる）。0 になったら区域を消す（applyRefs の 0 なら削除）。
type Ranked = Map<string, number[]>;
type Counts = { read: number; recomputed: number; built: number };
const freshCounts = (): Counts => ({ read: 0, recomputed: 0, built: 0 });
function applyRefs(composite: Ranked, slots: number, refs: readonly (readonly [code: string, slot: number])[], delta: 1 | -1, changed: Set<string>): void {
  for (const [code, slot] of refs) {
    const counts = composite.get(code) ?? Array.from({ length: slots + 1 }, () => 0);
    counts[slot] += delta;
    if (counts.every((count) => count === 0)) composite.delete(code); else composite.set(code, counts);
    changed.add(code);
  }
}
// 参照数が変わった区域ごとに段を上から見て最大を引き直す。既知の段が無く既知でない段だけなら −1（塗りなしと分ける）。
function recompute<Value>(composite: Ranked, values: Map<string, Value>, changed: ReadonlySet<string>, pick: (slot: number) => Value,
  unknown: Value, counts: Counts): void {
  for (const code of changed) {
    counts.recomputed++;
    const found = composite.get(code);
    if (found == null) { values.delete(code); continue; }
    let value = unknown;
    for (let slot = found.length - 2; slot >= 0; slot--) if (found[slot] > 0) { value = pick(slot); break; }
    values.set(code, value);
  }
}
function buildPaints<Value>(codes: readonly string[], values: ReadonlyMap<string, Value>, counts: Counts): (readonly [string, Value])[] {
  counts.built++;
  const paints: (readonly [string, Value])[] = [];
  for (const code of codes) { const value = values.get(code); if (value !== undefined) paints.push([code, value]); }
  return paints;
}

// ---- EEW ----

type EewEntry = Readonly<{ subject: string; operation: Operation; paints: readonly (readonly [string, number])[]; header: Omit<EewCardHeader, "letter">;
  rows: readonly EewAreaRow[]; mini: readonly EewMini[]; top: readonly EewAreaRow[] }>;
type EewProjection = Readonly<{
  entries: ReadonlyMap<string, EewEntry>; shown: readonly string[]; letters: ReadonlyMap<string, EewCardLetter>; last: number;
  composite: Ranked; values: ReadonlyMap<string, number>; paints: readonly DisplayPaint[]; wire: EewWire | null;
}>;
const slotOf = (value: DisplayLevel): number => value != null && value >= 0 && value <= 9 ? value : 10;
function eewEntry(current: EewCurrent, counts: Counts): EewEntry {
  // 同じ報の中の同じコードは最も重い段で 1 回数え、1 行にまとめる（同じ段なら到達予想時刻の早い行）。既知でないコードは件数だけ（P4-DW-AC02）。
  const byCode = new Map<string, Readonly<{ row: EewAreaRow; mini: number | null; paint: DisplayLevel; order: number }>>();
  let unknownAreas = 0, rowsSeen = 0;
  current.prediction.areas.forEach((area, index) => {
    counts.read++;
    if (!SUBAREA_SET.has(area.code)) { unknownAreas++; return; }
    rowsSeen++;
    const report = current.reportAreas[index];
    const paint = paintLevel(area.intensity.from, area.intensity.to);
    const row: EewAreaRow = { c: area.code, f: level(area.intensity.from), t: level(area.intensity.to), cd: conditionCode(area.intensity.condition),
      ks: arrival(report?.kindCodeRaw ?? null), at: bounded(report?.arrivalTimeRaw, WIRE_LIMITS.time),
      lg: { f: lgLevel(report?.lgInt?.from ?? null), t: lgLevel(report?.lgInt?.to ?? null) } };
    const found = byCode.get(area.code);
    const heavier = found == null || (paint ?? -3) > (found.paint ?? -3)
      || paint === found.paint && row.at != null && (found.row.at == null || Date.parse(row.at) < Date.parse(found.row.at));
    if (heavier) byCode.set(area.code, { row, mini: miniLevel(area.intensity.from, area.intensity.to), paint, order: found?.order ?? index });
  });
  const kept = [...byCode.values()].sort((left, right) => left.order - right.order);
  const top = [...kept].sort((left, right) => (right.paint ?? -3) - (left.paint ?? -3) || left.order - right.order).slice(0, 2).map((item) => item.row);
  const assumed = current.isAssumedHypocenter;
  const maximum: EewPredictionIntensity = current.prediction.maximum;
  return {
    subject: current.subject, operation: current.operation,
    paints: kept.map((item) => [item.row.c, slotOf(item.paint)] as const),
    header: {
      eventId: current.eventId, operation: current.operation, warning: current.warningClass === "warning", serial: current.serial, final: current.terminal,
      reportTime: bounded(current.source.reportDateTimeRaw, WIRE_LIMITS.time), max: { f: level(maximum.from), t: level(maximum.to) },
      hypo: cutOrNull(current.hypocenterName, WIRE_LIMITS.hypocenter),
      // M と深さは仮定震源の報で出さない（A15b）。
      mag: assumed ? null : valueText(current.magnitude?.raw, current.magnitude?.description), depth: assumed ? null : valueText(current.depthRaw, null),
      epi: cutOrNull(current.coordinateRaw, WIRE_LIMITS.coordinate), assumed, detectOnly: current.detectOnly,
      place: cutOrNull(current.place, WIRE_LIMITS.place), lg: { f: lgLevel(current.maxLgInt?.from ?? null), t: lgLevel(current.maxLgInt?.to ?? null) },
      unread: false, marks: marksOf(current), unknownAreas, dupAreas: rowsSeen - kept.length,
      ref: refOf("U-E", current.operation, current.subject, current),
    },
    rows: kept.map((item) => item.row), mini: kept.map((item) => [item.row.c, item.mini] as const), top,
  };
}
// 札の字: 出た順・空いたら次の字・F の次は空いている一番前・0 枚で A（DS-LAYOUT-06・08・10・11、P4-DW-D-LETTER）。
function nextLetter(letters: ReadonlyMap<string, EewCardLetter>, last: number): number {
  if (letters.size === 0) return 0;
  const used = new Set(letters.values());
  for (let index = last + 1; index < LETTERS.length; index++) if (!used.has(LETTERS[index])) return index;
  return LETTERS.findIndex((letter) => !used.has(letter));
}
function projectEew(previous: EewProjection | null, changes: readonly Change[], counts: Counts): EewProjection {
  if (previous != null && changes.length === 0) return previous;
  const entries = new Map(previous?.entries ?? []), letters = new Map(previous?.letters ?? []), composite: Ranked = new Map(previous?.composite ?? []);
  for (const [code, slots] of composite) composite.set(code, [...slots]);
  const values = new Map(previous?.values ?? []), changed = new Set<string>();
  let shown = [...previous?.shown ?? []], last = previous?.last ?? -1;
  for (const change of changes) {
    const before = entries.get(change.subject);
    if (before != null) {
      counts.read += before.paints.length;
      if (before.operation === "normal") applyRefs(composite, 10, before.paints, -1, changed);
      entries.delete(change.subject);
    }
    const current = change.after?.unit === "U-E" ? change.after.current : null;
    const wasShown = shown.includes(change.subject);
    if (current == null) {
      if (wasShown) { shown = shown.filter((subject) => subject !== change.subject); letters.delete(change.subject); }
      continue;
    }
    const entry = eewEntry(current, counts);
    entries.set(change.subject, entry);
    if (entry.operation === "normal") applyRefs(composite, 10, entry.paints, 1, changed);
    if (wasShown || before != null) continue;
    // 6 枚とも最終報の前の 7 件目（P4-DW-D-SEVENTH-OPERATION=A）: 通常の報は訓練・試験のカードの出た順の最も古いものを外して入る（仮、P4-DW-D-SEVENTH-OPERATION）。
    // 7 件目が訓練・試験の報か、6 枚とも通常の報なら、カードに出ず件数（通常なら合成）に入る（仮）。外した報はカードへ戻さない（E0-1 の板）。
    if (shown.length >= WIRE_COUNTS.eewCards) {
      const victim = entry.operation === "normal" ? shown.find((subject) => entries.get(subject)?.operation !== "normal") : undefined;
      if (victim == null) continue;
      shown = shown.filter((subject) => subject !== victim);
      letters.delete(victim);
    }
    last = nextLetter(letters, last);
    letters.set(change.subject, LETTERS[last]);
    shown.push(change.subject);
  }
  if (letters.size === 0) last = -1;
  recompute(composite, values, changed, (slot) => slot, -1, counts);
  const paints = changed.size === 0 && previous != null ? previous.paints : buildPaints(SUBAREAS, values, counts);
  return { entries, shown, letters, last, composite, values, paints, wire: null };
}
function eewWire(projection: EewProjection): EewWire {
  const cards = projection.shown.flatMap((subject): EewCard[] => {
    const entry = projection.entries.get(subject), letter = projection.letters.get(subject);
    if (entry == null || letter == null) return [];
    const header = { ...entry.header, letter };
    return [projection.shown.length === 1 ? { ...header, rows: entry.rows }
      : projection.shown.length === 2 ? { ...header, mini: entry.mini, top: entry.top } : { ...header, mini: entry.mini }];
  });
  return { cards, composites: [projection.paints], omitted: projection.entries.size - cards.length };
}

// ---- 津波 ----

type ForecastEntry = Readonly<{ operation: Operation; weight: number; reportMs: number; paints: readonly (readonly [string, number])[]; wire: TsunamiForecastWire }>;
type ObservationEntry = Readonly<{ operation: Operation; heights: readonly (readonly [code: string, raw: string, value: number])[] }>;
type TsunamiProjection = Readonly<{
  forecasts: ReadonlyMap<string, ForecastEntry>; observations: ReadonlyMap<string, ObservationEntry>;
  composite: Ranked; values: ReadonlyMap<string, TsunamiAreaClass>; observed: Map<string, Map<string, Readonly<{ count: number; value: number }>>>;
  maxima: ReadonlyMap<string, string>; forecastPaints: readonly (readonly [string, TsunamiAreaClass])[]; observedPaints: readonly (readonly [string, string])[];
}>;
const classOf = (kindCode: string): TsunamiAreaClass => KIND_CLASS.get(kindCode) ?? "unknown";
const heightValue = (value: MaterialValue): number => value.kind === "number" ? value.value : value.kind === "range" ? value.value + (value.bound === "lower" ? 1e-9 : -1e-9) : -Infinity;
function forecastEntry(forecast: MarkViewed<TsunamiForecastSubject>, counts: Counts): ForecastEntry {
  const byCode = new Map<string, TsunamiForecastRow>();
  let unknownAreas = 0, keyed = 0;
  for (const area of forecast.areas) {
    counts.read++;
    if (!TSUNAMI_SET.has(area.code)) { unknownAreas++; continue; }
    keyed++;
    const found = byCode.get(area.code);
    if (found != null && TSUNAMI_WEIGHT[found.k] >= TSUNAMI_WEIGHT[area.areaClass]) continue;
    const height = area.maxHeight == null ? null : rawOf(area.maxHeight.value);
    byCode.set(area.code, { c: area.code, k: area.areaClass, first: { raw: bounded(area.firstHeight.arrivalTimeRaw, WIRE_LIMITS.time),
      cond: cutOrNull(area.firstHeight.condition, WIRE_LIMITS.firstWave) },
    h: height == null ? null : ((cut) => ({ raw: cut.text, cut: cut.cut }))(cutText(height, WIRE_LIMITS.height)) });
  }
  const unkeyed = [...forecast.unkeyedAreas].sort((left, right) => TSUNAMI_WEIGHT[classOf(right.kindCode)] - TSUNAMI_WEIGHT[classOf(left.kindCode)]);
  const rows = [...byCode.values()];
  const weight = Math.max(-1, ...rows.map((row) => TSUNAMI_WEIGHT[row.k]), ...unkeyed.map((item) => TSUNAMI_WEIGHT[classOf(item.kindCode)]));
  return {
    operation: forecast.operation, weight, reportMs: Date.parse(forecast.source.reportDateTimeRaw),
    paints: rows.map((row) => [row.c, TSUNAMI_ORDER.length - 1 - TSUNAMI_ORDER.indexOf(row.k)] as const),
    wire: {
      eventId: forecast.eventId, operation: forecast.operation, serial: safeNumber(forecast.source.serialRaw),
      reportTime: bounded(forecast.source.reportDateTimeRaw, WIRE_LIMITS.time), comment: cutOrNull(forecast.warningComment, WIRE_LIMITS.comment),
      unread: forecast.unreadableView != null, marks: marksOf(forecast), omittedUnkeyed: Math.max(0, unkeyed.length - WIRE_COUNTS.unkeyed),
      unknownAreas, dupAreas: keyed - rows.length, ref: refOf("U-T", forecast.operation, forecast.subject, forecast), rows,
      unkeyed: unkeyed.slice(0, WIRE_COUNTS.unkeyed).map((item) => ({ name: cutText(item.name, WIRE_LIMITS.unkeyedName), k: classOf(item.kindCode) })),
    },
  };
}
function observationEntry(observation: MarkViewed<TsunamiObservationSubject>, counts: Counts): ObservationEntry {
  const heights: (readonly [string, string, number])[] = [];
  for (const station of observation.stations) {
    counts.read++;
    const height = station.maxHeight.height?.value;
    const raw = height == null ? null : rawOf(height);
    if (station.areaCode != null && TSUNAMI_SET.has(station.areaCode) && height != null && raw != null)
      heights.push([station.areaCode, cutText(raw, WIRE_LIMITS.height).text, heightValue(height)]);
  }
  return { operation: observation.operation, heights };
}
function projectTsunami(previous: TsunamiProjection | null, changes: readonly Change[], counts: Counts): TsunamiProjection {
  if (previous != null && changes.length === 0) return previous;
  const forecasts = new Map(previous?.forecasts ?? []), observations = new Map(previous?.observations ?? []);
  const composite: Ranked = new Map([...previous?.composite ?? []].map(([code, slots]) => [code, [...slots]]));
  const values = new Map(previous?.values ?? []), changed = new Set<string>();
  const observed = new Map([...previous?.observed ?? []].map(([code, heights]) => [code, new Map(heights)]));
  const maxima = new Map(previous?.maxima ?? []), observedChanged = new Set<string>();
  const applyHeights = (heights: ObservationEntry["heights"], delta: 1 | -1) => {
    for (const [code, raw, value] of heights) {
      const area = observed.get(code) ?? new Map<string, Readonly<{ count: number; value: number }>>();
      const count = (area.get(raw)?.count ?? 0) + delta;
      if (count === 0) area.delete(raw); else area.set(raw, { count, value });
      if (area.size === 0) observed.delete(code); else observed.set(code, area);
      observedChanged.add(code);
    }
  };
  for (const change of changes) {
    const record = change.after?.unit === "U-T" ? change.after.current : null;
    const oldForecast = forecasts.get(change.subject), oldObservation = observations.get(change.subject);
    counts.read += (oldForecast?.paints.length ?? 0) + (oldObservation?.heights.length ?? 0);
    if (oldForecast != null) { if (oldForecast.operation === "normal") applyRefs(composite, 7, oldForecast.paints, -1, changed); forecasts.delete(change.subject); }
    if (oldObservation != null) { if (oldObservation.operation === "normal") applyHeights(oldObservation.heights, -1); observations.delete(change.subject); }
    if (record == null) continue;
    if ("stations" in record) {
      const entry = observationEntry(record, counts);
      observations.set(change.subject, entry);
      if (entry.operation === "normal") applyHeights(entry.heights, 1);
    } else {
      const entry = forecastEntry(record, counts);
      forecasts.set(change.subject, entry);
      if (entry.operation === "normal") applyRefs(composite, 7, entry.paints, 1, changed);
    }
  }
  recompute(composite, values, changed, (slot) => TSUNAMI_ORDER[TSUNAMI_ORDER.length - 1 - slot], "unknown", counts);
  for (const code of observedChanged) {
    counts.recomputed++;
    const area = observed.get(code);
    if (area == null) { maxima.delete(code); continue; }
    let best: string | null = null, top = -Infinity;
    for (const [raw, { value }] of area) if (best == null || value > top || value === top && raw < best) { best = raw; top = value; }
    if (best != null) maxima.set(code, best);
  }
  return { forecasts, observations, composite, values, observed, maxima,
    forecastPaints: changed.size === 0 && previous != null ? previous.forecastPaints : buildPaints(TSUNAMI_AREAS, values, counts),
    observedPaints: observedChanged.size === 0 && previous != null ? previous.observedPaints : buildPaints(TSUNAMI_AREAS, maxima, counts) };
}
function tsunamiWire(projection: TsunamiProjection, view: TsunamiUnitView, counts: Counts): TsunamiWire {
  // 予報区の行を載せる EventID は 3 件（P4-DW-D-TSUNAMI-COUNT=A）。通常の報が訓練・試験より先（spec:1636 を当てる、統合担当の決め 2026-11-21）、
  // その中で最も重い区分が上、同じ区分は新しい発表が上（表 §1.2）。外したものは件数に数える。
  const ranked = [...projection.forecasts.values()].sort((left, right) => Number(right.operation === "normal") - Number(left.operation === "normal")
    || right.weight - left.weight || right.reportMs - left.reportMs);
  // 閉じた観測の印は 3 区分とも、unit が区分ごとに並べた新しい 4 件と件数を写す（P4-DW-AC07 (1)）。
  const closed = OPERATIONS.map((operation) => {
    const group = view.closedObservations[operation];
    return { items: group.items.map((item) => {
      counts.read++;
      return { eventId: item.eventId, family: item.family, closedAt: item.closedAt,
        ref: refOf("U-T", operation, `${operation}/tsunamiObservation:${item.family}/${item.eventId}`, item) };
    }), omitted: group.omitted };
  });
  return { forecasts: ranked.slice(0, WIRE_COUNTS.tsunamiEvents).map((item) => item.wire), omittedEvents: Math.max(0, ranked.length - WIRE_COUNTS.tsunamiEvents),
    composites: [{ forecast: projection.forecastPaints, observed: projection.observedPaints }], closed };
}

// ---- 地震 ----

type QuakeEntry = Readonly<{ operation: Operation; paints: readonly (readonly [string, number])[]; unknownPaint: number; unknownAreas: number;
  marks: readonly DisplayStateMark[]; ref: DisplayDetailRef }>;
type LongEntry = Readonly<{ operation: Operation; paints: readonly (readonly [string, number])[]; unknownPaint: number; reportMs: number; wire: LongPeriodWire }>;
type QuakeProjection = Readonly<{
  events: ReadonlyMap<string, QuakeEntry>; longs: ReadonlyMap<string, LongEntry>;
  composite: Ranked; values: ReadonlyMap<string, number>; paints: readonly DisplayPaint[]; unknown: number;
  longComposite: Ranked; longValues: ReadonlyMap<string, number>; longPaints: readonly DisplayPaint[]; longUnknown: number;
}>;
// 地域（細分区域）と市区町村の要素を区域の規則に通す。塗るのは level の合う既知コードだけ、既知でないコードは件数（P4-DW-AC02）。
function itemPaints(items: readonly SeismicIntensityItem[], paintLevelOf: "city" | "area", value: (item: SeismicIntensityItem) => DisplayLevel,
  counts: Counts): Readonly<{ paints: (readonly [string, number])[]; unknownPaint: number; unknownAreas: number }> {
  const paints = new Map<string, number>();
  let unknownPaint = 0, unknownAreas = 0;
  for (const item of items) {
    if (item.code == null || item.level !== "city" && item.level !== "area") continue;
    counts.read++;
    const knownCode = (item.level === "city" ? CITY_SET : SUBAREA_SET).has(item.code);
    if (!knownCode) { unknownAreas++; if (item.level === paintLevelOf) unknownPaint++; continue; }
    if (item.level !== paintLevelOf) continue;
    const slot = slotOf(value(item));
    const found = paints.get(item.code);
    // 同じコードは最も重い段で 1 回（既知でない段は既知の段より軽い）。
    if (found == null || found === 10 || slot !== 10 && slot > found) paints.set(item.code, slot);
  }
  return { paints: [...paints], unknownPaint, unknownAreas };
}
function projectQuake(previous: QuakeProjection | null, changes: readonly Change[], counts: Counts): QuakeProjection {
  if (previous != null && changes.length === 0) return previous;
  const events = new Map(previous?.events ?? []), longs = new Map(previous?.longs ?? []);
  const copy = (ranked: Ranked | undefined): Ranked => new Map([...ranked ?? []].map(([code, slots]) => [code, [...slots]]));
  const composite = copy(previous?.composite), longComposite = copy(previous?.longComposite);
  const values = new Map(previous?.values ?? []), longValues = new Map(previous?.longValues ?? []);
  const changed = new Set<string>(), longChanged = new Set<string>();
  let unknown = previous?.unknown ?? 0, longUnknown = previous?.longUnknown ?? 0;
  for (const change of changes) {
    const oldEvent = events.get(change.subject), oldLong = longs.get(change.subject);
    counts.read += (oldEvent?.paints.length ?? 0) + (oldLong?.paints.length ?? 0);
    if (oldEvent != null) { if (oldEvent.operation === "normal") { applyRefs(composite, 10, oldEvent.paints, -1, changed); unknown -= oldEvent.unknownPaint; } events.delete(change.subject); }
    if (oldLong != null) { if (oldLong.operation === "normal") { applyRefs(longComposite, 10, oldLong.paints, -1, longChanged); longUnknown -= oldLong.unknownPaint; } longs.delete(change.subject); }
    const record = change.after?.unit === "U-Q" ? change.after.current : null;
    if (record == null) continue;
    if ("sources" in record) {
      const view: EarthquakeEventView = record;
      const read = itemPaints(view.intensity?.items ?? [], "city", (item) => intensityLevel(item.maxInt), counts);
      const entry: QuakeEntry = { operation: view.operation, paints: read.paints, unknownPaint: read.unknownPaint, unknownAreas: read.unknownAreas,
        marks: marksOf(view), ref: refOf("U-Q", view.operation, view.subject, view) };
      events.set(change.subject, entry);
      if (entry.operation === "normal") { applyRefs(composite, 10, entry.paints, 1, changed); unknown += entry.unknownPaint; }
    } else {
      const long: MarkViewed<LongPeriodSubject> = record;
      const read = itemPaints(long.intensity?.items ?? [], "area", (item) => lgSeismic(item.maxLgInt), counts);
      const entry: LongEntry = { operation: long.operation, paints: read.paints, unknownPaint: read.unknownPaint, reportMs: Date.parse(long.source.reportDateTimeRaw),
        wire: { eventId: long.eventId, operation: long.operation, reportTime: bounded(long.source.reportDateTimeRaw, WIRE_LIMITS.time),
          maxLg: long.intensity == null ? null : lgSeismic(long.intensity.maxLgInt), marks: marksOf(long), unknownAreas: read.unknownAreas,
          ref: refOf("U-Q", long.operation, long.subject, long) } };
      longs.set(change.subject, entry);
      if (entry.operation === "normal") { applyRefs(longComposite, 10, entry.paints, 1, longChanged); longUnknown += entry.unknownPaint; }
    }
  }
  recompute(composite, values, changed, (slot) => slot, -1, counts);
  recompute(longComposite, longValues, longChanged, (slot) => slot, -1, counts);
  return { events, longs, composite, values, unknown, longComposite, longValues, longUnknown,
    paints: changed.size === 0 && previous != null ? previous.paints : buildPaints(CITIES, values, counts),
    longPaints: longChanged.size === 0 && previous != null ? previous.longPaints : buildPaints(SUBAREAS, longValues, counts) };
}
function quakeRow(row: SeismicRecentQuake, operation: Operation, event: QuakeEntry | undefined): EarthquakeRowWire {
  const subject = `${operation}/earthquake/${row.eventId}`;
  return {
    eventId: row.eventId, operation, origin: bounded(row.originTimeRaw, WIRE_LIMITS.time), reportTime: bounded(row.reportDateTimeRaw, WIRE_LIMITS.time),
    hypo: cutOrNull(row.hypocenterName, WIRE_LIMITS.hypocenter), mag: valueText(rawOf(row.magnitude), row.magnitudeDescription),
    depth: valueText(rawOf(row.depth), null), maxInt: intensityLevel(row.maxInt), cancelled: row.cancelled,
    tsunami: cutOrNull(row.tsunamiComment, WIRE_LIMITS.tsunamiEval), strongest: row.strongest, omittedStrongest: row.omittedStrongest,
    marks: event?.marks ?? [], unknownAreas: event?.unknownAreas ?? 0,
    // 日次行の ref は id を必ず持ち、rev は同じ snapshot に event があるときだけ（表 §5.6）。
    ref: { id: sha256(["U-Q", operation, subject]), rev: event?.ref.rev ?? null },
  };
}
function quakeWire(projection: QuakeProjection, view: SeismicUnitView): EarthquakeWire {
  // 長周期の見出しは 2 件（表 §1.2、板待ちの仮の数）。通常の報が先（spec:1636 を当てる、統合担当の決め 2026-11-21）、その中で新しい順。外したものは件数。
  const longs = [...projection.longs.values()].sort((left, right) => Number(right.operation === "normal") - Number(left.operation === "normal") || right.reportMs - left.reportMs);
  return {
    rows: OPERATIONS.flatMap((operation) => view.daily[operation].recent.map((row) => quakeRow(row, operation, projection.events.get(`${operation}/earthquake/${row.eventId}`)))),
    daily: OPERATIONS.map((operation) => ({ operation, count: view.daily[operation].count,
      maxInt: view.daily[operation].maxInt == null ? null : level(view.daily[operation].maxInt) })),
    composites: [{ areas: projection.paints, unknownAreas: projection.unknown }],
    longPeriods: longs.slice(0, WIRE_COUNTS.longPeriods).map((item) => item.wire), omittedLongPeriods: Math.max(0, longs.length - WIRE_COUNTS.longPeriods),
    longPeriodComposites: [{ areas: projection.longPaints, unknownAreas: projection.longUnknown }],
  };
}

// ---- 共通部（今の型のまま、表 §12） ----

const wireCard = (card: UnreadableCardView): DisplayWireCard =>
  ({ ...card, title: cutOrNull(card.title, WIRE_LIMITS.cardTitle), headline: cutOrNull(card.headline, WIRE_LIMITS.cardHeadline) });
// 旧の射影と同じ規則（P2-SNAPSHOT-SSE-001 の RES-05、P3-NFR-AC03 (3)）。旧の関数は T0 まで変えないので写す。
function channel(state: SnapshotProjectionInput["notificationChannels"]["desktop"], probeComplete: boolean, failing: boolean): DisplayChannelView {
  if (!probeComplete) return "checking";
  return state.kind === "unavailable" || state.kind === "isolated" ? state.kind : failing ? "failing" : "available";
}
function boundedPersistence(persistence: SnapshotProjectionInput["persistence"]): SnapshotProjectionInput["persistence"] {
  const result: Partial<Record<UnitId, PersistenceStatus>> = { ...persistence };
  for (const [unit, item] of Object.entries(persistence)) {
    if (item == null || item.kind !== "failed" || Buffer.byteLength(item.reason) <= PERSISTENCE_REASON_BYTES) continue;
    let text = "", size = 0;
    for (const char of item.reason) {
      const point = char.codePointAt(0) ?? 0, scalar = point >= 0xd800 && point <= 0xdfff ? "�" : char, width = Buffer.byteLength(scalar);
      if (size + width > PERSISTENCE_REASON_BYTES - TRUNCATED_MARKER.length) break;
      text += scalar; size += width;
    }
    const known = runtimeUnit(unit);
    if (known != null) result[known] = { ...item, reason: text + TRUNCATED_MARKER };
  }
  return result;
}
const UNIT_IDS: readonly UnitId[] = ["U-E", "U-W", "U-F", "U-T", "U-Q", "U-N", "U-V", "U-L", "U-R", "U-B", "U-M", "U-Y"];
const runtimeUnit = (value: string): UnitId | undefined => UNIT_IDS.find((unit) => unit === value);

// ---- 射影 ----

type Change = Readonly<{ subject: string; after: RuntimeDisplayChange["after"] }>;
type DisplayWireInput = Readonly<{
  projection: SnapshotProjectionInput;
  // 保護 3 分野の view（読めない報のカードを含む形。projection の同じ欄と同じ object）。
  views: Readonly<{ eew: RuntimeViews["U-E"]; tsunami: RuntimeViews["U-T"]; earthquake: RuntimeViews["U-Q"] }>;
  // 分野の items（確認の状態・件数）と画面のお知らせは旧の射影の state から写す（公開の判定には使わない、P4-DW-AC01）。
  domains: SnapshotProjectionState["domains"];
  notices: readonly VisibleNotice[];
}>;
// seen は公開した snapshot を作った view の欄（参照の比べにだけ使い、snapshot には載せない）。
type Seen = Readonly<{
  closed: TsunamiUnitView["closedObservations"]; daily: SeismicUnitView["daily"]; persistence: SnapshotProjectionInput["persistence"];
  eewCards: readonly UnreadableCardView[] | undefined; tsunamiCards: readonly UnreadableCardView[] | undefined; quakeCards: readonly UnreadableCardView[] | undefined;
}>;
type DisplayWireState = Readonly<{
  streamId: string; snapshot: DisplayWireSnapshot | null; seen: Seen | null;
  eew: EewProjection | null; tsunami: TsunamiProjection | null; earthquake: QuakeProjection | null;
}>;
// P4-DW-AC05 の計数（試験が読む）: 変わった subject の区域を読んだ数・引き直した区域の数・公開する配列を組んだ数。
type DisplayWireCounts = Readonly<Record<"eew" | "tsunami" | "earthquake", Counts>>;
type DisplayWireResult =
  | Readonly<{ kind: "unchanged"; state: DisplayWireState; counts: DisplayWireCounts }>
  | Readonly<{ kind: "projected"; state: DisplayWireState; snapshot: DisplayWireSnapshot; counts: DisplayWireCounts }>;

// 同じ subject の変化が 1 step に 2 回あれば最後の after を使う（before は projector の記録から引く）。
function changesOf(changes: readonly RuntimeDisplayChange[], unit: "U-E" | "U-T" | "U-Q"): readonly Change[] {
  const merged = new Map<string, Change>();
  for (const change of changes) if (change.unit === unit) merged.set(`${change.operation}\u0000${change.subject}`, { subject: change.subject, after: change.after });
  return [...merged.values()];
}
// 共通部と分野の包みの比べ（全体を直列化しない、P4-DW-AC05）。比べないのは sequence と generatedAt。
function sameSnapshot(left: DisplayWireSnapshot, right: Omit<DisplayWireSnapshot, "sequence" | "generatedAt">): boolean {
  const sameDomain = <D extends Readonly<{ contentRevision: string; items: readonly unknown[]; wire: unknown; cards: readonly unknown[] }>>(a: D, b: D) =>
    a.wire === b.wire && a.contentRevision === b.contentRevision && a.items.every((item, index) => item === b.items[index])
    && a.cards.length === b.cards.length && a.cards.every((card, index) => card === b.cards[index]);
  const units = (a: DisplayWireSnapshot["persistence"], b: DisplayWireSnapshot["persistence"]) => UNIT_IDS.every((unit) => a[unit] === b[unit]);
  return left.streamId === right.streamId && left.semanticRevision === right.semanticRevision
    && left.connection.state === right.connection.state && left.connection.disconnectedAt === right.connection.disconnectedAt
    && left.connection.lastInputAt === right.connection.lastInputAt && left.worker.state === right.worker.state
    && left.worker.lastProgressAtMonotonicMs === right.worker.lastProgressAtMonotonicMs && left.worker.lastResponseAtMonotonicMs === right.worker.lastResponseAtMonotonicMs
    // digest は参照で、札・進み具合・復元の状態は定数の上界なので字で比べる（旧の射影と同じ、P3-REC-AC14 (6)・AC11・AC16）。
    && units(left.persistence, right.persistence) && left.recovery.digest === right.recovery.digest
    && JSON.stringify([left.recovery.restoration, left.recovery.eewUnverified, left.recovery.progress])
      === JSON.stringify([right.recovery.restoration, right.recovery.eewUnverified, right.recovery.progress])
    && left.channels.desktop === right.channels.desktop && left.channels.sound === right.channels.sound
    && sameDomain(left.current.eew, right.current.eew) && sameDomain(left.current.tsunami, right.current.tsunami)
    && sameDomain(left.current.earthquake, right.current.earthquake)
    && left.notices.length === right.notices.length && left.notices.every((notice, index) => notice === right.notices[index]);
}

function sameClosed(left: TsunamiUnitView["closedObservations"], right: TsunamiUnitView["closedObservations"]): boolean {
  return left === right || OPERATIONS.every((operation) => left[operation].omitted === right[operation].omitted
    && left[operation].items.length === right[operation].items.length && left[operation].items.every((item, index) => {
      const other = right[operation].items[index];
      return item.eventId === other.eventId && item.family === other.family && item.closedAt === other.closedAt;
    }));
}

// 新しい経路の射影。自分の前の snapshot と比べて変わったときだけ projected を返し、旧の射影の projected・unchanged・rejected に依らない（P4-DW-AC01）。
function projectDisplayWire(input: DisplayWireInput, previous: DisplayWireState | null): DisplayWireResult {
  const base = previous != null && previous.streamId === input.projection.streamId ? previous : null;
  const counts: DisplayWireCounts = { eew: freshCounts(), tsunami: freshCounts(), earthquake: freshCounts() };
  const source = input.projection;
  const eewChanges = changesOf(source.displayChanges, "U-E"), tsunamiChanges = changesOf(source.displayChanges, "U-T"), quakeChanges = changesOf(source.displayChanges, "U-Q");
  const eew = projectEew(base?.eew ?? null, eewChanges, counts.eew);
  const tsunami = projectTsunami(base?.tsunami ?? null, tsunamiChanges, counts.tsunami);
  const earthquake = projectQuake(base?.earthquake ?? null, quakeChanges, counts.earthquake);
  const published = base?.snapshot ?? null;
  // view が同じ object のままなら分野の wire も前の object を使う（metadata だけの更新で内容を走査しない）。
  const reuse = <V, W>(view: V, previousView: V | undefined, previousWire: W | undefined, build: () => W): W =>
    previousWire !== undefined && view === previousView ? previousWire : build();
  const { eew: eewView, tsunami: tsunamiView, earthquake: quakeView } = input.views;
  const eewWireValue = eew === base?.eew && published != null ? published.current.eew.wire : eewWire(eew);
  // 閉じた印は view を出し直すたびに別の object になるので、区分ごとの 4 件と件数を欄で比べる（12 件まで）。
  const tsunamiWireValue = tsunami === base?.tsunami && published != null && base?.seen != null && sameClosed(tsunamiView.closedObservations, base.seen.closed)
    ? published.current.tsunami.wire : tsunamiWire(tsunami, tsunamiView, counts.tsunami);
  const quakeWireValue = earthquake === base?.earthquake && published != null
    ? reuse(quakeView.daily, base?.seen?.daily, published.current.earthquake.wire, () => quakeWire(earthquake, quakeView))
    : quakeWire(earthquake, quakeView);
  const cardsOf = <V extends Readonly<{ unreadableCards?: readonly UnreadableCardView[] }>>(view: V, previousCards: readonly UnreadableCardView[] | undefined,
    previousWire: readonly DisplayWireCard[] | undefined): readonly DisplayWireCard[] =>
    reuse(view.unreadableCards, previousCards, previousWire, () => (view.unreadableCards ?? []).map(wireCard));
  const last = base?.seen ?? undefined;
  const current: DisplayWireSnapshot["current"] = {
    eew: { unit: "U-E", contentRevision: eewView.contentRevision, items: input.domains.eew.full.items, wire: eewWireValue,
      cards: cardsOf(eewView, last?.eewCards, published?.current.eew.cards) },
    tsunami: { unit: "U-T", contentRevision: tsunamiView.contentRevision, items: input.domains.tsunami.full.items, wire: tsunamiWireValue,
      cards: cardsOf(tsunamiView, last?.tsunamiCards, published?.current.tsunami.cards) },
    earthquake: { unit: "U-Q", contentRevision: quakeView.contentRevision, items: input.domains.earthquake.full.items, wire: quakeWireValue,
      cards: cardsOf(quakeView, last?.quakeCards, published?.current.earthquake.cards) },
  };
  const shell: Omit<DisplayWireSnapshot, "sequence" | "generatedAt"> = {
    schemaVersion: VERSION, streamId: source.streamId,
    semanticRevision: JSON.stringify([eewView.contentRevision, tsunamiView.contentRevision, quakeView.contentRevision]),
    connection: source.connection, worker: source.worker,
    persistence: published != null && last != null && UNIT_IDS.every((unit) => source.persistence[unit] === last.persistence[unit])
      ? published.persistence : boundedPersistence(source.persistence),
    recovery: source.recovery,
    channels: { desktop: channel(source.notificationChannels.desktop, source.channelProbeComplete, source.channelFailing.desktop),
      sound: channel(source.notificationChannels.sound, source.channelProbeComplete, source.channelFailing.sound) },
    current, notices: input.notices,
  };
  if (published != null && sameSnapshot(published, shell))
    return { kind: "unchanged", state: { streamId: source.streamId, snapshot: published, seen: base?.seen ?? null, eew, tsunami, earthquake }, counts };
  const snapshot: DisplayWireSnapshot = { ...shell, sequence: (published?.sequence ?? 0) + 1, generatedAt: source.generatedAt };
  const seen: Seen = { closed: tsunamiView.closedObservations, daily: quakeView.daily, persistence: source.persistence,
    eewCards: eewView.unreadableCards, tsunamiCards: tsunamiView.unreadableCards, quakeCards: quakeView.unreadableCards };
  return { kind: "projected", state: { streamId: source.streamId, snapshot, seen, eew, tsunami, earthquake }, snapshot, counts };
}

export { WIRE_COUNTS, WIRE_LIMITS, cutText, projectDisplayWire };
export type { DisplayWireCounts, DisplayWireInput, DisplayWireResult, DisplayWireState };
