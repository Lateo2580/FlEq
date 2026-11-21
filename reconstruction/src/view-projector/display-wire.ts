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
const refOf = (unit: RuntimeUnitId, operation: Operation, subject: string, object: unknown, counts: Counts): DisplayDetailRef => {
  counts.hashed++;
  return { id: sha256([unit, operation, subject]), rev: sha256(object) };
};

// ---- 合成の参照数（表 §5.1） ----

// 区域ごとに段の参照数を持つ。最後の欄は既知でない段の参照（鍵 op|…|code|? に当たる）。0 になったら区域を消す（applyRefs の 0 なら削除）。
type Ranked = Map<string, number[]>;
// hashed は詳細の参照の rev を作った回数（表示差分のあった subject だけ、P4-DW-AC05）。
type Counts = { read: number; recomputed: number; built: number; hashed: number };
const freshCounts = (): Counts => ({ read: 0, recomputed: 0, built: 0, hashed: 0 });
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

// ---- 射影の state（保存しない） ----
// state は 1 本の列でだけ使う（前の state を別の入力にもう一度渡さない）。受信 1 件の手間を変わった subject と区域に比例させるため、
// Map・参照数・並びの配列はその場で書き換え、全件の複製をしない（P4-DW-AC05、表 §5.1）。

// 並びの配列に二分探索で入れる・外す（並べ替え直さない）。
function insertSorted<T>(list: T[], item: T, compare: (left: T, right: T) => number): void {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (compare(list[middle], item) <= 0) low = middle + 1; else high = middle; }
  list.splice(low, 0, item);
}
function removeSorted<T>(list: T[], item: T, compare: (left: T, right: T) => number): void {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (compare(list[middle], item) < 0) low = middle + 1; else high = middle; }
  for (let index = low; index < list.length && compare(list[index], item) === 0; index++) if (list[index] === item) { list.splice(index, 1); return; }
}
const normalFirst = (left: Readonly<{ operation: Operation }>, right: Readonly<{ operation: Operation }>) =>
  Number(right.operation === "normal") - Number(left.operation === "normal");
const bySubject = (left: Readonly<{ subject: string }>, right: Readonly<{ subject: string }>) => left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0;

// ---- EEW ----

type EewEntry = Readonly<{ subject: string; key: string; operation: Operation; reportMs: number; family: string;
  paints: readonly (readonly [string, number])[]; header: Omit<EewCardHeader, "letter">; rows: readonly EewAreaRow[]; mini: readonly EewMini[]; top: readonly EewAreaRow[] }>;
// カードは（運用区分、EventID）ごとに 1 枚（DS-LAYOUT-05「地震ごと」、統合担当の決め 2026-11-21）。6 枚の上限と omitted も EventID で数える。
type EewProjection = {
  readonly entries: Map<string, EewEntry>; readonly events: Map<string, Set<string>>; shown: string[]; readonly letters: Map<string, EewCardLetter>;
  // カードに出られなかった通常の報の EventID（Map の入れた順が来た順）。枠が空いたら先に来たものから入る（spec:1636 の向き、統合担当の決め）。
  readonly waiting: Map<string, true>; last: number;
  readonly composite: Ranked; readonly values: Map<string, number>; paints: readonly DisplayPaint[]; built: EewWire | null;
};
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
    subject: current.subject, key: `${current.operation}/${current.eventId}`, operation: current.operation, reportMs: Date.parse(current.source.reportDateTimeRaw),
    family: current.family, paints: kept.map((item) => [item.row.c, slotOf(item.paint)] as const),
    header: {
      eventId: current.eventId, operation: current.operation, warning: current.warningClass === "warning", serial: current.serial, final: current.terminal,
      reportTime: bounded(current.source.reportDateTimeRaw, WIRE_LIMITS.time), max: { f: level(maximum.from), t: level(maximum.to) },
      hypo: cutOrNull(current.hypocenterName, WIRE_LIMITS.hypocenter),
      // M と深さは仮定震源の報で出さない（A15b）。
      mag: assumed ? null : valueText(current.magnitude?.raw, current.magnitude?.description), depth: assumed ? null : valueText(current.depthRaw, null),
      epi: cutOrNull(current.coordinateRaw, WIRE_LIMITS.coordinate), assumed, detectOnly: current.detectOnly,
      place: cutOrNull(current.place, WIRE_LIMITS.place), lg: { f: lgLevel(current.maxLgInt?.from ?? null), t: lgLevel(current.maxLgInt?.to ?? null) },
      unread: false, marks: marksOf(current), unknownAreas, dupAreas: rowsSeen - kept.length,
      ref: refOf("U-E", current.operation, current.subject, current, counts),
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
// 読むのは owner の表示差分だけ（view の object は worker を越えるたびに別の参照になるので、参照で比べない、P4-DW-AC05）。
function projectEew(projection: EewProjection | null, changes: readonly Change[], counts: Counts): EewProjection {
  const state: EewProjection = projection ?? { entries: new Map(), events: new Map(), shown: [], letters: new Map(), waiting: new Map(), last: -1, composite: new Map(),
    values: new Map(), paints: [], built: null };
  if (changes.length === 0 && projection != null) return state;
  const changed = new Set<string>();
  const show = (key: string) => { state.last = nextLetter(state.letters, state.last); state.letters.set(key, LETTERS[state.last]); state.shown.push(key); };
  for (const change of changes) {
    const before = state.entries.get(change.subject);
    const current = change.after?.unit === "U-E" ? change.after.current : null;
    if (before != null) {
      counts.read += before.paints.length;
      if (before.operation === "normal") applyRefs(state.composite, 10, before.paints, -1, changed);
    }
    if (current == null) {
      if (before == null) continue;
      state.entries.delete(change.subject);
      const subjects = state.events.get(before.key);
      subjects?.delete(change.subject);
      if (subjects != null && subjects.size === 0) {
        state.events.delete(before.key);
        state.shown = state.shown.filter((key) => key !== before.key);
        state.letters.delete(before.key);
        state.waiting.delete(before.key);
      }
      continue;
    }
    const entry = eewEntry(current, counts);
    state.entries.set(change.subject, entry);
    if (entry.operation === "normal") applyRefs(state.composite, 10, entry.paints, 1, changed);
    const subjects = state.events.get(entry.key);
    if (subjects != null) { subjects.add(change.subject); continue; }
    state.events.set(entry.key, new Set([change.subject]));
    // 6 枚とも最終報の前の 7 件目（P4-DW-D-SEVENTH-OPERATION=A）: 通常の報は訓練・試験のカードの出た順の最も古いものを外して入る（仮）。
    // 7 件目が訓練・試験の報か 6 枚とも通常の報なら、カードに出ず件数（通常なら合成）に入る（仮）。外した訓練・試験の報は戻さない（E0-1 の板）。
    if (state.shown.length >= WIRE_COUNTS.eewCards) {
      const victim = entry.operation === "normal" ? state.shown.find((key) => key.split("/")[0] !== "normal") : undefined;
      if (victim == null) { if (entry.operation === "normal") state.waiting.set(entry.key, true); continue; }
      state.shown = state.shown.filter((key) => key !== victim);
      state.letters.delete(victim);
    }
    show(entry.key);
  }
  for (const key of state.waiting.keys()) { if (state.shown.length >= WIRE_COUNTS.eewCards) break; state.waiting.delete(key); show(key); }
  if (state.letters.size === 0) state.last = -1;
  recompute(state.composite, state.values, changed, (slot) => slot, -1, counts);
  if (changed.size !== 0 || projection == null) state.paints = buildPaints(SUBAREAS, state.values, counts);
  state.built = null;
  return state;
}
// その EventID の報のうち新しい方の family の current をカードにする（同じ時刻なら VXSE43）。
function cardEntry(projection: EewProjection, key: string): EewEntry | null {
  let best: EewEntry | null = null;
  for (const subject of projection.events.get(key) ?? []) {
    const entry = projection.entries.get(subject);
    if (entry != null && (best == null || entry.reportMs > best.reportMs || entry.reportMs === best.reportMs && entry.family === "VXSE43")) best = entry;
  }
  return best;
}
function eewWire(projection: EewProjection): EewWire {
  if (projection.built != null) return projection.built;
  const count = projection.shown.length;
  const cards = projection.shown.flatMap((key): EewCard[] => {
    const entry = cardEntry(projection, key), letter = projection.letters.get(key);
    if (entry == null || letter == null) return [];
    const header = { ...entry.header, letter };
    return [count === 1 ? { ...header, rows: entry.rows } : count === 2 ? { ...header, mini: entry.mini, top: entry.top } : { ...header, mini: entry.mini }];
  });
  projection.built = { cards, composites: [projection.paints], omitted: projection.events.size - cards.length };
  return projection.built;
}

// ---- 津波 ----

type ForecastEntry = Readonly<{ subject: string; operation: Operation; weight: number; reportMs: number; paints: readonly (readonly [string, number])[]; wire: TsunamiForecastWire }>;
type ObservationEntry = Readonly<{ subject: string; operation: Operation; heights: readonly (readonly [code: string, raw: string, value: number])[] }>;
type TsunamiProjection = {
  readonly forecasts: Map<string, ForecastEntry>; readonly ranked: ForecastEntry[]; readonly observations: Map<string, ObservationEntry>;
  readonly composite: Ranked; readonly values: Map<string, TsunamiAreaClass>; readonly observed: Map<string, Map<string, Readonly<{ count: number; value: number }>>>;
  readonly maxima: Map<string, string>; forecastPaints: readonly (readonly [string, TsunamiAreaClass])[]; observedPaints: readonly (readonly [string, string])[];
  revision: string | null; closed: TsunamiUnitView["closedObservations"] | null; built: TsunamiWire | null;
};
// 予報区の行を載せる EventID は 3 件（P4-DW-D-TSUNAMI-COUNT=A）。通常の報が訓練・試験より先（spec:1636 を当てる、統合担当の決め 2026-11-21）、
// その中で最も重い区分が上、同じ区分は新しい発表が上（表 §1.2）。外したものは件数に数える。
const forecastOrder = (left: ForecastEntry, right: ForecastEntry) => normalFirst(left, right) || right.weight - left.weight || right.reportMs - left.reportMs || bySubject(left, right);
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
    subject: forecast.subject, operation: forecast.operation, weight, reportMs: Date.parse(forecast.source.reportDateTimeRaw),
    paints: rows.map((row) => [row.c, TSUNAMI_ORDER.length - 1 - TSUNAMI_ORDER.indexOf(row.k)] as const),
    wire: {
      eventId: forecast.eventId, operation: forecast.operation, serial: safeNumber(forecast.source.serialRaw),
      reportTime: bounded(forecast.source.reportDateTimeRaw, WIRE_LIMITS.time), comment: cutOrNull(forecast.warningComment, WIRE_LIMITS.comment),
      unread: forecast.unreadableView != null, marks: marksOf(forecast), omittedUnkeyed: Math.max(0, unkeyed.length - WIRE_COUNTS.unkeyed),
      unknownAreas, dupAreas: keyed - rows.length, ref: refOf("U-T", forecast.operation, forecast.subject, forecast, counts), rows,
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
  return { subject: observation.subject, operation: observation.operation, heights };
}
function projectTsunami(projection: TsunamiProjection | null, view: RuntimeViews["U-T"], changes: readonly Change[], counts: Counts): TsunamiProjection {
  const state: TsunamiProjection = projection ?? { forecasts: new Map(), ranked: [], observations: new Map(), composite: new Map(), values: new Map(), observed: new Map(),
    maxima: new Map(), forecastPaints: [], observedPaints: [], revision: null, closed: null, built: null };
  // 閉じた印は unit が区分ごとに並べた新しい 4 件と件数を写す（P4-DW-AC07 (1)）。集合が変われば unit が内容版を上げるので、内容版で読む。
  if (view.contentRevision !== state.revision) { state.revision = view.contentRevision; state.closed = view.closedObservations; state.built = null; }
  if (changes.length === 0 && projection != null) return state;
  const changed = new Set<string>(), observedChanged = new Set<string>();
  const applyHeights = (heights: ObservationEntry["heights"], delta: 1 | -1) => {
    for (const [code, raw, value] of heights) {
      const area = state.observed.get(code) ?? new Map<string, Readonly<{ count: number; value: number }>>();
      const count = (area.get(raw)?.count ?? 0) + delta;
      if (count === 0) area.delete(raw); else area.set(raw, { count, value });
      if (area.size === 0) state.observed.delete(code); else state.observed.set(code, area);
      observedChanged.add(code);
    }
  };
  for (const change of changes) {
    const record = change.after?.unit === "U-T" ? change.after.current : null;
    const oldForecast = state.forecasts.get(change.subject), oldObservation = state.observations.get(change.subject);
    counts.read += (oldForecast?.paints.length ?? 0) + (oldObservation?.heights.length ?? 0);
    if (oldForecast != null) {
      if (oldForecast.operation === "normal") applyRefs(state.composite, 7, oldForecast.paints, -1, changed);
      state.forecasts.delete(change.subject);
      removeSorted(state.ranked, oldForecast, forecastOrder);
    }
    if (oldObservation != null) { if (oldObservation.operation === "normal") applyHeights(oldObservation.heights, -1); state.observations.delete(change.subject); }
    if (record == null) continue;
    if ("stations" in record) {
      const entry = observationEntry(record, counts);
      state.observations.set(change.subject, entry);
      if (entry.operation === "normal") applyHeights(entry.heights, 1);
    } else {
      const entry = forecastEntry(record, counts);
      state.forecasts.set(change.subject, entry);
      insertSorted(state.ranked, entry, forecastOrder);
      if (entry.operation === "normal") applyRefs(state.composite, 7, entry.paints, 1, changed);
    }
  }
  recompute(state.composite, state.values, changed, (slot) => TSUNAMI_ORDER[TSUNAMI_ORDER.length - 1 - slot], "unknown", counts);
  for (const code of observedChanged) {
    counts.recomputed++;
    const area = state.observed.get(code);
    if (area == null) { state.maxima.delete(code); continue; }
    let best: string | null = null, top = -Infinity;
    for (const [raw, { value }] of area) if (best == null || value > top || value === top && raw < best) { best = raw; top = value; }
    if (best != null) state.maxima.set(code, best);
  }
  if (changed.size !== 0 || projection == null) state.forecastPaints = buildPaints(TSUNAMI_AREAS, state.values, counts);
  if (observedChanged.size !== 0 || projection == null) state.observedPaints = buildPaints(TSUNAMI_AREAS, state.maxima, counts);
  state.built = null;
  return state;
}
function tsunamiWire(projection: TsunamiProjection, counts: Counts): TsunamiWire {
  if (projection.built != null) return projection.built;
  const closed = projection.closed;
  const built: TsunamiWire = { forecasts: projection.ranked.slice(0, WIRE_COUNTS.tsunamiEvents).map((item) => item.wire),
    omittedEvents: Math.max(0, projection.ranked.length - WIRE_COUNTS.tsunamiEvents),
    composites: [{ forecast: projection.forecastPaints, observed: projection.observedPaints }],
    // 閉じた印は開ける part が無いので ref を付けない（統合担当の決め 2026-11-21、契約適合レビューの P3-5）。
    closed: OPERATIONS.map((operation) => closed == null ? { items: [], omitted: 0 } : { items: closed[operation].items.map((item) => {
      counts.read++;
      return { eventId: item.eventId, family: item.family, closedAt: item.closedAt };
    }), omitted: closed[operation].omitted }) };
  projection.built = built;
  return built;
}

// ---- 地震 ----

type QuakeEntry = Readonly<{ subject: string; operation: Operation; paints: readonly (readonly [string, number])[]; unknownPaint: number; unknownAreas: number;
  marks: readonly DisplayStateMark[]; ref: DisplayDetailRef }>;
type LongEntry = Readonly<{ subject: string; operation: Operation; paints: readonly (readonly [string, number])[]; unknownPaint: number; reportMs: number; wire: LongPeriodWire }>;
type QuakeProjection = {
  readonly events: Map<string, QuakeEntry>; readonly longs: Map<string, LongEntry>; readonly longRanked: LongEntry[];
  readonly composite: Ranked; readonly values: Map<string, number>; paints: readonly DisplayPaint[]; unknown: number;
  readonly longComposite: Ranked; readonly longValues: Map<string, number>; longPaints: readonly DisplayPaint[]; longUnknown: number;
  revision: string | null; built: EarthquakeWire | null;
};
// 長周期の見出しは 2 件（表 §1.2、板待ちの仮の数）。通常の報が先（spec:1636 を当てる、統合担当の決め 2026-11-21）、その中で新しい順。外したものは件数。
const longOrder = (left: LongEntry, right: LongEntry) => normalFirst(left, right) || right.reportMs - left.reportMs || bySubject(left, right);
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
function projectQuake(projection: QuakeProjection | null, view: RuntimeViews["U-Q"], changes: readonly Change[], counts: Counts): QuakeProjection {
  const state: QuakeProjection = projection ?? { events: new Map(), longs: new Map(), longRanked: [], composite: new Map(), values: new Map(), paints: [], unknown: 0,
    longComposite: new Map(), longValues: new Map(), longPaints: [], longUnknown: 0, revision: null, built: null };
  // 当日の行は当日履歴が変わると unit が内容版を上げるので、内容版で読む（P3-C7-SEM-04）。
  if (view.contentRevision !== state.revision) { state.revision = view.contentRevision; state.built = null; }
  if (changes.length === 0 && projection != null) return state;
  const changed = new Set<string>(), longChanged = new Set<string>();
  for (const change of changes) {
    const oldEvent = state.events.get(change.subject), oldLong = state.longs.get(change.subject);
    counts.read += (oldEvent?.paints.length ?? 0) + (oldLong?.paints.length ?? 0);
    if (oldEvent != null) { if (oldEvent.operation === "normal") { applyRefs(state.composite, 10, oldEvent.paints, -1, changed); state.unknown -= oldEvent.unknownPaint; } state.events.delete(change.subject); }
    if (oldLong != null) {
      if (oldLong.operation === "normal") { applyRefs(state.longComposite, 10, oldLong.paints, -1, longChanged); state.longUnknown -= oldLong.unknownPaint; }
      state.longs.delete(change.subject);
      removeSorted(state.longRanked, oldLong, longOrder);
    }
    const record = change.after?.unit === "U-Q" ? change.after.current : null;
    if (record == null) continue;
    if ("sources" in record) {
      const read = itemPaints(record.intensity?.items ?? [], "city", (item) => intensityLevel(item.maxInt), counts);
      const entry: QuakeEntry = { subject: record.subject, operation: record.operation, paints: read.paints, unknownPaint: read.unknownPaint,
        unknownAreas: read.unknownAreas, marks: marksOf(record), ref: refOf("U-Q", record.operation, record.subject, record, counts) };
      state.events.set(change.subject, entry);
      if (entry.operation === "normal") { applyRefs(state.composite, 10, entry.paints, 1, changed); state.unknown += entry.unknownPaint; }
    } else {
      const read = itemPaints(record.intensity?.items ?? [], "area", (item) => lgSeismic(item.maxLgInt), counts);
      const entry: LongEntry = { subject: record.subject, operation: record.operation, paints: read.paints, unknownPaint: read.unknownPaint,
        reportMs: Date.parse(record.source.reportDateTimeRaw),
        wire: { eventId: record.eventId, operation: record.operation, reportTime: bounded(record.source.reportDateTimeRaw, WIRE_LIMITS.time),
          maxLg: record.intensity == null ? null : lgSeismic(record.intensity.maxLgInt), marks: marksOf(record), unknownAreas: read.unknownAreas,
          ref: refOf("U-Q", record.operation, record.subject, record, counts) } };
      state.longs.set(change.subject, entry);
      insertSorted(state.longRanked, entry, longOrder);
      if (entry.operation === "normal") { applyRefs(state.longComposite, 10, entry.paints, 1, longChanged); state.longUnknown += entry.unknownPaint; }
    }
  }
  recompute(state.composite, state.values, changed, (slot) => slot, -1, counts);
  recompute(state.longComposite, state.longValues, longChanged, (slot) => slot, -1, counts);
  if (changed.size !== 0 || projection == null) state.paints = buildPaints(CITIES, state.values, counts);
  if (longChanged.size !== 0 || projection == null) state.longPaints = buildPaints(SUBAREAS, state.longValues, counts);
  state.built = null;
  return state;
}
function quakeRow(row: SeismicRecentQuake, operation: Operation, event: QuakeEntry | undefined): EarthquakeRowWire {
  const subject = `${operation}/earthquake/${row.eventId}`;
  // 最も強い地域のコードも区域の規則を通す（既知の細分区域だけ、既知でないものは件数、P4-DW-AC02）。
  const strongest = row.strongest.filter((code) => SUBAREA_SET.has(code));
  return {
    eventId: row.eventId, operation, origin: bounded(row.originTimeRaw, WIRE_LIMITS.time), reportTime: bounded(row.reportDateTimeRaw, WIRE_LIMITS.time),
    hypo: cutOrNull(row.hypocenterName, WIRE_LIMITS.hypocenter), mag: valueText(rawOf(row.magnitude), row.magnitudeDescription),
    depth: valueText(rawOf(row.depth), null), maxInt: intensityLevel(row.maxInt), cancelled: row.cancelled,
    tsunami: cutOrNull(row.tsunamiComment, WIRE_LIMITS.tsunamiEval), strongest, omittedStrongest: row.omittedStrongest,
    // event があればその既知でない区域の件数（地域の要素を含む）、無ければ最も強い地域のうち既知でないコードの数。
    marks: event?.marks ?? [], unknownAreas: event?.unknownAreas ?? row.strongest.length - strongest.length,
    // 日次行の ref は id を必ず持ち、rev は同じ snapshot に event があるときだけ（表 §5.6）。
    ref: { id: sha256(["U-Q", operation, subject]), rev: event?.ref.rev ?? null },
  };
}
function quakeWire(projection: QuakeProjection, view: SeismicUnitView): EarthquakeWire {
  if (projection.built != null) return projection.built;
  projection.built = {
    rows: OPERATIONS.flatMap((operation) => view.daily[operation].recent.map((row) => quakeRow(row, operation, projection.events.get(`${operation}/earthquake/${row.eventId}`)))),
    daily: OPERATIONS.map((operation) => ({ operation, count: view.daily[operation].count,
      maxInt: view.daily[operation].maxInt == null ? null : level(view.daily[operation].maxInt) })),
    composites: [{ areas: projection.paints, unknownAreas: projection.unknown }],
    longPeriods: projection.longRanked.slice(0, WIRE_COUNTS.longPeriods).map((item) => item.wire),
    omittedLongPeriods: Math.max(0, projection.longRanked.length - WIRE_COUNTS.longPeriods),
    longPeriodComposites: [{ areas: projection.longPaints, unknownAreas: projection.longUnknown }],
  };
  return projection.built;
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
// 新しい経路が読む共通部の欄（旧の射影の入力から、新しい経路が使う欄だけ。publisher は公開ごとに 1 回だけ組む）。
type DisplayWireSource = Pick<SnapshotProjectionInput, "streamId" | "generatedAt" | "connection" | "worker" | "persistence" | "recovery" | "notificationChannels"
  | "channelProbeComplete" | "channelFailing" | "displayChanges">;
type DisplayWireInput = Readonly<{
  projection: DisplayWireSource;
  // 保護 3 分野の view（読めない報のカードを含む形）。
  views: Readonly<{ eew: RuntimeViews["U-E"]; tsunami: RuntimeViews["U-T"]; earthquake: RuntimeViews["U-Q"] }>;
  // 分野の items（確認の状態・件数）と画面のお知らせは旧の射影の state から写す（公開の判定には使わない、P4-DW-AC01）。
  domains: SnapshotProjectionState["domains"];
  notices: readonly VisibleNotice[];
}>;
// seen は公開した snapshot を作った欄（参照の比べにだけ使い、snapshot には載せない）。
// 共通部と読めない報のカードも worker を越えて来るので、参照ではなく欄で比べる（どちらも件数の上限が決まっている）。
type Seen = Readonly<{ persistence: string }>;
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
    // wire とカードはこの射影が作った object（変わらなければ前の object を使う）。items は旧の射影が view の出し直しで作り直すので欄で比べる（3 行の固定）。
    a.wire === b.wire && a.contentRevision === b.contentRevision && JSON.stringify(a.items) === JSON.stringify(b.items) && a.cards === b.cards;
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

// 新しい経路の射影。自分の前の snapshot と比べて変わったときだけ projected を返し、旧の射影の projected・unchanged・rejected に依らない（P4-DW-AC01）。
function projectDisplayWire(input: DisplayWireInput, previous: DisplayWireState | null): DisplayWireResult {
  const base = previous != null && previous.streamId === input.projection.streamId ? previous : null;
  const counts: DisplayWireCounts = { eew: freshCounts(), tsunami: freshCounts(), earthquake: freshCounts() };
  const source = input.projection;
  const { eew: eewView, tsunami: tsunamiView, earthquake: quakeView } = input.views;
  const eew = projectEew(base?.eew ?? null, changesOf(source.displayChanges, "U-E"), counts.eew);
  const tsunami = projectTsunami(base?.tsunami ?? null, tsunamiView, changesOf(source.displayChanges, "U-T"), counts.tsunami);
  const earthquake = projectQuake(base?.earthquake ?? null, quakeView, changesOf(source.displayChanges, "U-Q"), counts.earthquake);
  const published = base?.snapshot ?? null, last = base?.seen ?? undefined, persistenceKey = JSON.stringify(source.persistence);
  // カード（unit ごとに 8 枚まで、P3-UM-AC11）は欄が同じなら前に作ったカードを使う。
  const cardsOf = (cards: readonly UnreadableCardView[] | undefined, previousWire: readonly DisplayWireCard[] | undefined): readonly DisplayWireCard[] => {
    const next = (cards ?? []).map(wireCard);
    return previousWire !== undefined && next.length === previousWire.length && next.every((card, index) => JSON.stringify(card) === JSON.stringify(previousWire[index]))
      ? previousWire : next;
  };
  const current: DisplayWireSnapshot["current"] = {
    eew: { unit: "U-E", contentRevision: eewView.contentRevision, items: input.domains.eew.full.items, wire: eewWire(eew),
      cards: cardsOf(eewView.unreadableCards, published?.current.eew.cards) },
    tsunami: { unit: "U-T", contentRevision: tsunamiView.contentRevision, items: input.domains.tsunami.full.items, wire: tsunamiWire(tsunami, counts.tsunami),
      cards: cardsOf(tsunamiView.unreadableCards, published?.current.tsunami.cards) },
    earthquake: { unit: "U-Q", contentRevision: quakeView.contentRevision, items: input.domains.earthquake.full.items, wire: quakeWire(earthquake, quakeView),
      cards: cardsOf(quakeView.unreadableCards, published?.current.earthquake.cards) },
  };
  const shell: Omit<DisplayWireSnapshot, "sequence" | "generatedAt"> = {
    schemaVersion: VERSION, streamId: source.streamId,
    semanticRevision: JSON.stringify([eewView.contentRevision, tsunamiView.contentRevision, quakeView.contentRevision]),
    connection: source.connection, worker: source.worker,
    persistence: published != null && last != null && persistenceKey === last.persistence ? published.persistence : boundedPersistence(source.persistence),
    recovery: source.recovery,
    channels: { desktop: channel(source.notificationChannels.desktop, source.channelProbeComplete, source.channelFailing.desktop),
      sound: channel(source.notificationChannels.sound, source.channelProbeComplete, source.channelFailing.sound) },
    current, notices: input.notices,
  };
  if (published != null && sameSnapshot(published, shell))
    return { kind: "unchanged", state: { streamId: source.streamId, snapshot: published, seen: last ?? null, eew, tsunami, earthquake }, counts };
  const snapshot: DisplayWireSnapshot = { ...shell, sequence: (published?.sequence ?? 0) + 1, generatedAt: source.generatedAt };
  const seen: Seen = { persistence: persistenceKey };
  return { kind: "projected", state: { streamId: source.streamId, snapshot, seen, eew, tsunami, earthquake }, snapshot, counts };
}

export { WIRE_COUNTS, WIRE_LIMITS, cutText, projectDisplayWire };
export type { DisplayWireCounts, DisplayWireInput, DisplayWireResult, DisplayWireSource, DisplayWireState };
