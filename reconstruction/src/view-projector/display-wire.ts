import { createHash } from "node:crypto";

import type { MaterialValue, Operation } from "../../contracts/p1-parser-boundary.types";
import type { EewCurrent, EewPredictionIntensity } from "../../contracts/p2-eew-unit.types";
import type { LossReason, LossTally, MarkViewed, PersistenceStatus, ReportRef, RuntimeConfirmation, RuntimeDisplayChange, RuntimeDisplaySubject, RuntimeUnitId, RuntimeViews,
  SubjectUnavailable, UnitId, UnreadableCardView } from "../../contracts/p2-shared-runtime.types";
import type { DisplayChannelView, DisplaySummaryItem, SnapshotProjectionInput, SnapshotProjectionState, VisibleNotice } from "../../contracts/p2-snapshot-sse.types";
import type { EarthquakeEventView, LongPeriodSubject, SeismicIntensityItem, SeismicIntensityValue, SeismicRecentQuake, SeismicUnitView } from "../../contracts/p3-seismic-unit.types";
import type { TsunamiAreaClass, TsunamiForecastSubject, TsunamiObservationSubject, TsunamiUnitView } from "../../contracts/p3-tsunami-unit.types";
import type { KnownCodeTable } from "../../contracts/p4-gis-assets.types";
import type {
  DisplayCutText, DisplayDetailRef, DisplayEewWindow, DisplayFromTo, DisplayLevel, DisplayLossRow, DisplayLossWire, DisplayPaint, DisplayRemovalItem, DisplayRemovalWire, DisplayStateMark, DisplayValueText, DisplayWireCard,
  DisplayVocabDomain, DisplayWireSnapshot, EarthquakeRowWire, EarthquakeWire, EewAreaRow, EewCard, EewCardHeader, EewCardLetter, EewMini, EewWire, LongPeriodWire,
  TsunamiForecastRow, TsunamiForecastWire, TsunamiWire, VocabFact, VocabItem, VocabUnit, VocabWire,
} from "../../contracts/p4-display-wire.types";
import known from "../../assets/gis/known-codes.v1.json";
import { knownStage } from "../domains/seismic/seismic";
import { KIND_CLASS } from "../domains/tsunami/tsunami";
import { WIRE_LIMITS, cutText, vocabItem } from "./display-vocab";
import { briefingTally, eewTally, floodTally, landslideTally, localBulletinsTally, nankaiTally, projectDomain, seismicTally, timeseriesTally, tsunamiTally,
  typhoonTally, volcanoTally, weatherTally } from "./view-projector";

// P4-DISPLAY-WIRE-001（B0）: 新しい経路の射影。区域の規則・合成・札の字・文字列の上限の表・共通部の写しをここだけに置く（P4-DW-AC02・AC03・AC10）。
// 入力は unit の view と表示差分なので、受理の後も復元の後も同じに効く。state は保存しない。

const table: KnownCodeTable = known;
const SUBAREAS = table.forecastLocalE.map((item) => item.code), CITIES = table.city.map((item) => item.code), TSUNAMI_AREAS = table.tsunamiArea.map((item) => item.code);
const SUBAREA_SET = new Set(SUBAREAS), CITY_SET = new Set(CITIES), TSUNAMI_SET = new Set(TSUNAMI_AREAS);
const OPERATIONS = ["normal", "training", "test"] as const;
const VERSION = "p4-display-wire-v3" as const;

// 文字列の上限の表 WIRE_LIMITS と cutText は display-vocab.ts に 1 つだけ置く（owner も読むので、domain を読むこの file から移した、P4-DV-AC03）。
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

// ---- 9 分野の語彙（P4-DISPLAY-VOCAB-001） ----

const SNAPSHOT_BYTES = 1_048_576, DOMAIN_BUDGET = 65_536;
// 保護 3 分野・通知・共通部の上界の和（p4-display-wire-max.mjs の newPath.sum、表 §4.1）。9 分野の full の和がこれと合わせて 1 MiB に届かない間は、
// 全体を数えなくても要約にならないと決まる。届きうるときだけ全体を数える（稀な分岐。共通部と保護 3 分野の直列化は全公開の中で 1 回）。
const NEW_PATH_FIXED_BOUND = 377_434;
const VOCAB_KEYS = ["weatherCurrent", "weatherTimeseries", "nankai", "volcano", "landslide", "flood", "briefing", "localBulletins", "typhoon"] as const;
type VocabKey = typeof VOCAB_KEYS[number];
const VOCAB_UNIT: Readonly<Record<VocabKey, VocabUnit>> = { weatherCurrent: "U-W", weatherTimeseries: "U-F", nankai: "U-N", volcano: "U-V", landslide: "U-L",
  flood: "U-R", briefing: "U-B", localBulletins: "U-M", typhoon: "U-Y" };
const utf8 = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const byKey = <T>(make: (key: VocabKey) => T): Readonly<Record<VocabKey, T>> => ({ weatherCurrent: make("weatherCurrent"), weatherTimeseries: make("weatherTimeseries"),
  nankai: make("nankai"), volcano: make("volcano"), landslide: make("landslide"), flood: make("flood"), briefing: make("briefing"), localBulletins: make("localBulletins"),
  typhoon: make("typhoon") });
const commas = (count: number): number => Math.max(count - 1, 0);
// P4-DV-AC06 の計数（試験が読む）: 作り直した項目・直列化した項目・並びの併合で書いた要素の数。
type VocabCounts = { rebuilt: number; serialized: number; moved: number };
type VocabEntry = Readonly<{ item: VocabItem; bytes: number }>;
// 項目は (operation, subject) の鍵で持ち、並びは id の昇順の配列（P4-DV-D-ITEM-ID=A）。itemBytes は項目の JSON の byte の和で、変わった項目の差だけを足し引きする。
type VocabProjection = {
  readonly entries: Map<string, VocabEntry>; sorted: readonly VocabItem[]; itemBytes: number;
  view: RuntimeViews[VocabUnit] | null; facts: readonly VocabFact<"freshnessSuspectCount">[]; wire: VocabWire | null;
  cards: readonly DisplayWireCard[]; cardsBytes: number;
};
const subjectKey = (operation: Operation, subject: string): string => `${operation}\u0000${subject}`;
// 表示差分の after（view の要素と同じ形）を語彙の入力にする。U-W の監視の行は current を持たない。
function vocabSource(value: RuntimeDisplaySubject): Parameters<typeof vocabItem>[0] | null {
  switch (value.unit) {
    case "U-W": return value.current == null ? null : { k: "weatherCurrent.area", value: value.current };
    case "U-F": return value.current == null ? null : { k: "weatherTimeseries.subject", value: value.current };
    case "U-N": {
      const current = value.current;
      if (current == null) return null;
      if (!("line" in current)) return { k: "nankai.information", value: current };
      return current.effective === "active" ? { k: "nankai.current", value: current } : null;
    }
    case "U-V": {
      const current = value.current;
      if (current == null) return null;
      if ("family" in current) return { k: "volcano.bulletin", value: current };
      // 表示差分の after は view に載る active の記録だけ（I-U-V.view）。型は終わった記録も含むので effective で絞る。
      if (current.effective !== "active") return null;
      if ("marineSource" in current) return { k: "volcano.alert", value: current };
      return "flash" in current ? { k: "volcano.eruption", value: current } : { k: "volcano.ashfall", value: current };
    }
    case "U-L": return value.current == null ? null : { k: "landslide.office", value: value.current };
    case "U-R": return value.current == null ? null : { k: "flood.event", value: value.current };
    case "U-B": return value.current == null ? null : { k: "briefing.current", value: value.current };
    case "U-M": {
      const current = value.current;
      if (current == null) return null;
      return "sighted" in current ? { k: "localBulletins.tornado", value: current } : "targetDate" in current ? { k: "localBulletins.heat", value: current }
        : { k: "localBulletins.transient", value: current };
    }
    case "U-Y": return value.current == null ? null : "frames" in value.current ? { k: "typhoon.analysis", value: value.current } : { k: "typhoon.probability", value: value.current };
    default: return null;
  }
}
// id は sha256([unit, operation, subject])、rev は view の object の JSON の sha256（U-W・U-F は公開形の id と revision が同じ式、P4-DV-AC02）。
function idsOf(unit: VocabUnit, source: Parameters<typeof vocabItem>[0]): Readonly<{ id: string; rev: string }> {
  if (source.k === "weatherCurrent.area" || source.k === "weatherTimeseries.subject") return { id: source.value.id, rev: source.value.revision };
  // 不足の記録の subject は unit が使う形（volcano-unit.ts の resolveShortfall）。不足の id をそのまま使うと通常の記録の subject と重なりうる。
  const subject = source.k === "volcano.shortfall" ? `${source.value.operation}/shortfall/${source.value.id}` : source.value.subject;
  return { id: sha256([unit, source.value.operation, subject]), rev: sha256(source.value) };
}
// 受信 1 回の手間: 変わった subject の K 件だけを作り直して直列化し、並びは前の N 件と 1 度だけ併合する（O(N ＋ K log K)、P4-DV-AC06）。
function projectVocab(unit: VocabUnit, projection: VocabProjection | null, view: RuntimeViews[VocabUnit], changes: readonly RuntimeDisplayChange[],
  counts: VocabCounts): VocabProjection {
  const state: VocabProjection = projection ?? { entries: new Map(), sorted: [], itemBytes: 0, view: null, facts: [], wire: null, cards: [], cardsBytes: 2 };
  const updates = new Map<string, Parameters<typeof vocabItem>[0] | null>();
  for (const change of changes) updates.set(subjectKey(change.operation, change.subject), change.after == null ? null : vocabSource(change.after));
  // view の固定の部分（表示差分に来ない欄、表 §6 の 7）は view の object が前と違うときだけ読み直す（view-projector の metadata only と同じ条件）。
  if (view !== state.view) {
    if (view.unit === "U-V") {
      const wanted = new Set(view.shortfalls.map((item) => subjectKey(item.operation, `${item.operation}/shortfall/${item.id}`)));
      for (const [key, entry] of state.entries) if (entry.item.k === "volcano.shortfall" && !wanted.has(key)) updates.set(key, null);
      for (const item of view.shortfalls) {
        const key = subjectKey(item.operation, `${item.operation}/shortfall/${item.id}`), found = state.entries.get(key);
        if (found == null || found.item.rev !== sha256(item)) updates.set(key, { k: "volcano.shortfall", value: item });
      }
    }
    if (view.unit === "U-W" && state.facts[0]?.[1] !== view.freshnessSuspectCount) { state.facts = [["freshnessSuspectCount", view.freshnessSuspectCount]]; state.wire = null; }
    // カードは view に載る（unit ごとに 8 枚、U-M は 16 枚）。view が同じ object なら同じカード。
    const next = (view.unreadableCards ?? []).map(wireCard);
    if (next.length !== state.cards.length || next.some((card, index) => JSON.stringify(card) !== JSON.stringify(state.cards[index]))) {
      state.cards = next;
      state.cardsBytes = utf8(next);
    }
    state.view = view;
  }
  if (updates.size === 0) return state;
  const removed = new Set<string>(), added: VocabItem[] = [];
  for (const [key, source] of updates) {
    const old = state.entries.get(key);
    if (old != null) { removed.add(old.item.id); state.itemBytes -= old.bytes; state.entries.delete(key); }
    if (source == null) continue;
    const item = vocabItem(source, idsOf(unit, source), false);
    counts.rebuilt++;
    const bytes = utf8(item);
    counts.serialized++;
    state.entries.set(key, { item, bytes });
    state.itemBytes += bytes;
    added.push(item);
  }
  // 何も変わらない差分（U-W の監視の行など、項目の無い subject の取消）は並びも wire も前のまま（P4-DV-AC06 の変わらない分野）。
  if (removed.size === 0 && added.length === 0) return state;
  added.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const merged: VocabItem[] = [];
  let index = 0;
  for (const item of state.sorted) {
    if (removed.has(item.id)) continue;
    while (index < added.length && added[index].id < item.id) merged.push(added[index++]);
    merged.push(item);
  }
  while (index < added.length) merged.push(added[index++]);
  counts.moved += merged.length;
  state.sorted = merged;
  state.wire = null;
  return state;
}
// ---- 射影 ----

type Change = Readonly<{ subject: string; after: RuntimeDisplayChange["after"] }>;
// 新しい経路が読む共通部の欄（旧の射影の入力から、新しい経路が使う欄だけ。publisher は公開ごとに 1 回だけ組む）。
type DisplayWireSource = Pick<SnapshotProjectionInput, "streamId" | "generatedAt" | "connection" | "worker" | "persistence" | "recovery" | "notificationChannels"
  | "channelProbeComplete" | "channelFailing" | "displayChanges">;
type DisplayWireViews = Readonly<{
  eew: RuntimeViews["U-E"]; tsunami: RuntimeViews["U-T"]; earthquake: RuntimeViews["U-Q"]; weatherCurrent: RuntimeViews["U-W"]; weatherTimeseries: RuntimeViews["U-F"];
  nankai: RuntimeViews["U-N"]; volcano: RuntimeViews["U-V"]; landslide: RuntimeViews["U-L"]; flood: RuntimeViews["U-R"]; briefing: RuntimeViews["U-B"];
  localBulletins: RuntimeViews["U-M"]; typhoon: RuntimeViews["U-Y"];
}>;
type DisplayWireInput = Readonly<{
  projection: DisplayWireSource;
  // 12 分野の view（読めない報のカードを含む形）。
  views: DisplayWireViews;
  // 包みの items の確認の状態（P4-DV-AC11。旧の射影の state は読まない）。
  confirmation: RuntimeConfirmation;
  // 画面のお知らせは旧の射影の state から写す（本契約の範囲外、表 §12.5）。
  notices: readonly VisibleNotice[]; removalLoss: RemovalLossSource; // removalLoss: P4-REMOVAL-LOSS-001 の材料（file の末尾の RemovalLossSource）
}>;
// seen は公開した snapshot を作った欄（参照の比べにだけ使い、snapshot には載せない）。
// 共通部と読めない報のカードも worker を越えて来るので、参照ではなく欄で比べる（どちらも件数の上限が決まっている）。
type Seen = Readonly<{ persistence: string }>;
type DisplayWireState = Readonly<{
  streamId: string; snapshot: DisplayWireSnapshot | null; seen: Seen | null;
  eew: EewProjection | null; tsunami: TsunamiProjection | null; earthquake: QuakeProjection | null;
  // 12 分野の包みの items を数える新しい経路の自分の state（旧の射影と同じ projectDomain、P4-DV-D-OWN-ITEMS=A。移行中は 1 step に 2 回走る、P4-DV-D-DOUBLE-PROJECTION=A）。
  domains: SnapshotProjectionState["domains"] | null;
  vocab: Readonly<Record<VocabKey, VocabProjection>> | null; removals: DisplayRemovalWire; losses: LossProjection | null; hidden: ReadonlySet<string>; // 後の 3 つは P4-REMOVAL-LOSS-001（保存しない）
}>;
// P4-DW-AC05 の計数（試験が読む）: 変わった subject の区域を読んだ数・引き直した区域の数・公開する配列を組んだ数。
type DisplayWireCounts = Readonly<Record<"eew" | "tsunami" | "earthquake", Counts>>;
type DisplayWireVocabCounts = Readonly<Record<VocabKey, Readonly<VocabCounts>>>;
type DisplayWireResult =
  | Readonly<{ kind: "unchanged"; state: DisplayWireState; counts: DisplayWireCounts; vocabCounts: DisplayWireVocabCounts }>
  | Readonly<{ kind: "projected"; state: DisplayWireState; snapshot: DisplayWireSnapshot; counts: DisplayWireCounts; vocabCounts: DisplayWireVocabCounts }>;

// 同じ subject の変化が 1 step に 2 回あれば最後の after を使う（before は projector の記録から引く）。
function changesOf(changes: readonly RuntimeDisplayChange[], unit: "U-E" | "U-T" | "U-Q"): readonly Change[] {
  const merged = new Map<string, Change>();
  for (const change of changes) if (change.unit === unit) merged.set(`${change.operation}\u0000${change.subject}`, { subject: change.subject, after: change.after });
  return [...merged.values()];
}
// 同じ (unit, operation, subject) の差分が 2 回以上あれば最初の before と最後の after（projectSnapshot と同じ、表 §4.3）。停止の確定の差分は呼び出し側が 1 度だけ前に足す。
function mergedByUnit(changes: readonly RuntimeDisplayChange[]): ReadonlyMap<RuntimeUnitId, readonly RuntimeDisplayChange[]> {
  const merged = new Map<string, RuntimeDisplayChange>();
  for (const change of changes) {
    const key = JSON.stringify([change.unit, change.operation, change.subject]), found = merged.get(key);
    merged.set(key, found == null ? change : { ...change, before: found.before });
  }
  // unit ごとの配列を 1 度作って足す（差分の数に線形）。
  const byUnit = new Map<RuntimeUnitId, RuntimeDisplayChange[]>();
  for (const change of merged.values()) {
    const list = byUnit.get(change.unit);
    if (list == null) byUnit.set(change.unit, [change]); else list.push(change);
  }
  return byUnit;
}
const NO_CHANGES: readonly RuntimeDisplayChange[] = [];
const NO_GATES: ReadonlySet<string> = new Set();
// 12 分野の包みの items（件数の見出し）を新しい経路の差分と確認の状態から数える（P4-DV-AC11）。gates はお知らせにだけ効くので空。
function projectItems(previous: SnapshotProjectionState["domains"] | null, views: DisplayWireViews, byUnit: ReadonlyMap<RuntimeUnitId, readonly RuntimeDisplayChange[]>,
  confirmation: RuntimeConfirmation): SnapshotProjectionState["domains"] {
  const changes = (unit: RuntimeUnitId) => byUnit.get(unit) ?? NO_CHANGES;
  const meta = (unit: RuntimeUnitId) => ({ confirmation: confirmation.units[unit] });
  // 表示差分の無い分野は前の view を渡して projectDomain の metadata only の道に入れる。worker を越えた view は差分が無くても別の object なので、
  // そのまま渡すと索引の Map を写し直す（P4-DW-AC05、H5）。items は差分と確認の状態だけで決まり、view の byte はここでは使わない。
  const view = <View>(unit: RuntimeUnitId, previousView: View | undefined, current: View): View => previousView !== undefined && changes(unit).length === 0 ? previousView : current;
  const none = new Map<string, Readonly<{ forecast: number; warning: number }>>();
  const eew = projectDomain("U-E", previous?.eew ?? null, view("U-E", previous?.eew.full.view, views.eew), changes("U-E"), meta("U-E"), previous?.eew.eventRefs ?? none, NO_GATES, eewTally);
  return {
    eew: { ...eew.projection, eventRefs: eew.eventRefs },
    weatherCurrent: projectDomain("U-W", previous?.weatherCurrent ?? null, view("U-W", previous?.weatherCurrent.full.view, views.weatherCurrent), changes("U-W"), meta("U-W"), none, NO_GATES, weatherTally).projection,
    weatherTimeseries: projectDomain("U-F", previous?.weatherTimeseries ?? null, view("U-F", previous?.weatherTimeseries.full.view, views.weatherTimeseries), changes("U-F"), meta("U-F"), none, NO_GATES, timeseriesTally).projection,
    tsunami: projectDomain("U-T", previous?.tsunami ?? null, view("U-T", previous?.tsunami.full.view, views.tsunami), changes("U-T"), meta("U-T"), none, NO_GATES, tsunamiTally).projection,
    earthquake: projectDomain("U-Q", previous?.earthquake ?? null, view("U-Q", previous?.earthquake.full.view, views.earthquake), changes("U-Q"), meta("U-Q"), none, NO_GATES, seismicTally).projection,
    nankai: projectDomain("U-N", previous?.nankai ?? null, view("U-N", previous?.nankai.full.view, views.nankai), changes("U-N"), meta("U-N"), none, NO_GATES, nankaiTally).projection,
    volcano: projectDomain("U-V", previous?.volcano ?? null, view("U-V", previous?.volcano.full.view, views.volcano), changes("U-V"), meta("U-V"), none, NO_GATES, volcanoTally).projection,
    landslide: projectDomain("U-L", previous?.landslide ?? null, view("U-L", previous?.landslide.full.view, views.landslide), changes("U-L"), meta("U-L"), none, NO_GATES, landslideTally).projection,
    flood: projectDomain("U-R", previous?.flood ?? null, view("U-R", previous?.flood.full.view, views.flood), changes("U-R"), meta("U-R"), none, NO_GATES, floodTally).projection,
    briefing: projectDomain("U-B", previous?.briefing ?? null, view("U-B", previous?.briefing.full.view, views.briefing), changes("U-B"), meta("U-B"), none, NO_GATES, briefingTally).projection,
    localBulletins: projectDomain("U-M", previous?.localBulletins ?? null, view("U-M", previous?.localBulletins.full.view, views.localBulletins), changes("U-M"), meta("U-M"), none, NO_GATES, localBulletinsTally).projection,
    typhoon: projectDomain("U-Y", previous?.typhoon ?? null, view("U-Y", previous?.typhoon.full.view, views.typhoon), changes("U-Y"), meta("U-Y"), none, NO_GATES, typhoonTally).projection,
  };
}
type Items = readonly [DisplaySummaryItem, DisplaySummaryItem, DisplaySummaryItem];
const sameItems = (left: Items, right: Items): boolean => left === right || JSON.stringify(left) === JSON.stringify(right);
// 9 分野の full の包みの byte（語彙の形、表 §4.2）。項目は足し引きした和を使い、包みの残り（items 3 行・分野の値・空の配列）だけを直列化する。
function fullBytes(unit: VocabUnit, contentRevision: string, items: Items, projection: VocabProjection): number {
  return utf8({ unit, contentRevision, items, delivery: "full", wire: { items: [], facts: projection.facts }, cards: [] })
    + projection.itemBytes + commas(projection.sorted.length) + projection.cardsBytes - 2;
}
// 共通部と分野の包みの比べ（全体を直列化しない、P4-DW-AC05）。比べないのは sequence と generatedAt。
function sameSnapshot(left: DisplayWireSnapshot, right: Omit<DisplayWireSnapshot, "sequence" | "generatedAt">): boolean {
  const sameDomain = <D extends Readonly<{ contentRevision: string; items: Items; wire: unknown; cards: readonly unknown[] }>>(a: D, b: D) =>
    // wire とカードはこの射影が作った object（変わらなければ前の object を使う）。items は projectDomain が差分のある step で作り直すので欄で比べる（3 行の固定）。
    a.wire === b.wire && a.contentRevision === b.contentRevision && sameItems(a.items, b.items) && a.cards === b.cards;
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
    // 9 分野の包みは変わらなければ前の object を使う（vocabDomain）。
    && VOCAB_KEYS.every((key) => left.current[key] === right.current[key])
    && left.notices.length === right.notices.length && left.notices.every((notice, index) => notice === right.notices[index]) && left.removals === right.removals && left.losses === right.losses; // 一覧と H39 の欄は参照（P4-RL-AC08 (5)）
}
const sameUnit = <Unit extends VocabUnit>(domain: DisplayVocabDomain<VocabUnit>, unit: Unit): domain is DisplayVocabDomain<Unit> => domain.unit === unit;
// 9 分野の包みを組む。前に公開した包みと同じなら前の object を使う（公開の比べを参照で済ませる）。
function vocabDomain<Unit extends VocabUnit>(unit: Unit, contentRevision: string, items: Items, projection: VocabProjection, summary: number | null,
  previous: DisplayVocabDomain<VocabUnit> | undefined): DisplayVocabDomain<Unit> {
  if (summary != null) {
    if (previous != null && sameUnit(previous, unit) && previous.delivery === "summary" && previous.contentRevision === contentRevision && previous.originalBytes === summary
      && sameItems(previous.items, items)) return previous;
    return { unit, contentRevision, items, delivery: "summary", reason: "snapshotBudget", originalBytes: summary, budgetBytes: DOMAIN_BUDGET };
  }
  const wire = projection.wire ??= { items: projection.sorted, facts: projection.facts };
  if (previous != null && sameUnit(previous, unit) && previous.delivery === "full" && previous.wire === wire && previous.cards === projection.cards
    && previous.contentRevision === contentRevision && sameItems(previous.items, items)) return previous;
  return { unit, contentRevision, items, delivery: "full", wire, cards: projection.cards };
}

// 1 MiB の判定に使う byte（9 分野の和が上界を越えている間だけ）。大きな部分（保護 3 分野の wire・カード・items、通知の 1 件、復旧の digest）は
// object ごとに byte を覚え、変わった object だけを数え直す（P4-DV-AC06、P2-A8-COST の公開ごとに 1 回の直列化）。残りの欄は件数の決まった小さい部分。
const remembered = new WeakMap<object, number>();
function bytesOf(value: object): number {
  const found = remembered.get(value);
  if (found != null) return found;
  const size = utf8(value);
  remembered.set(value, size);
  return size;
}
function protectedBytes(domain: Readonly<{ unit: string; contentRevision: string; items: Items; wire: object; cards: readonly object[] }>): number {
  // 空の items・cards と 0 の wire の字（2・2・1 byte）を覚えた byte に置き換える。
  return utf8({ unit: domain.unit, contentRevision: domain.contentRevision, items: [], wire: 0, cards: [] }) - 5
    + bytesOf(domain.items) + bytesOf(domain.wire) + bytesOf(domain.cards);
}
function commonBytes(shell: Omit<DisplayWireSnapshot, "sequence" | "generatedAt">, sequence: number, generatedAt: string): number {
  const current = Object.fromEntries(Object.keys(shell.current).map((key) => [key, 0])), digest = shell.recovery.digest;
  const notices = shell.notices.reduce((sum, notice) => sum + bytesOf(notice), 0) + commas(shell.notices.length);
  return utf8({ ...shell, sequence, generatedAt, current, notices: [], recovery: { ...shell.recovery, digest: null } }) - Object.keys(current).length
    + notices + (digest == null ? 0 : bytesOf(digest) - 4);
}

// 新しい経路の射影。自分の前の snapshot と比べて変わったときだけ projected を返し、旧の射影の projected・unchanged・rejected に依らない（P4-DW-AC01）。
function projectDisplayWire(input: DisplayWireInput, previous: DisplayWireState | null): DisplayWireResult {
  const base = previous != null && previous.streamId === input.projection.streamId ? previous : null;
  const counts: DisplayWireCounts = { eew: freshCounts(), tsunami: freshCounts(), earthquake: freshCounts() };
  const vocabCounts = byKey((): VocabCounts => ({ rebuilt: 0, serialized: 0, moved: 0 }));
  const source = input.projection;
  const views = input.views;
  const eew = projectEew(base?.eew ?? null, changesOf(source.displayChanges, "U-E"), counts.eew);
  const tsunami = projectTsunami(base?.tsunami ?? null, views.tsunami, changesOf(source.displayChanges, "U-T"), counts.tsunami);
  const earthquake = projectQuake(base?.earthquake ?? null, views.earthquake, changesOf(source.displayChanges, "U-Q"), counts.earthquake);
  const byUnit = mergedByUnit(source.displayChanges), removals = projectRemovals(base?.removals ?? NO_REMOVALS, byUnit, input.removalLoss), losses = projectLosses(base?.losses ?? null, input.removalLoss), hidden = hiddenNotices(base?.hidden ?? NO_HIDDEN, byUnit, eew, input.notices);
  const domains = projectItems(base?.domains ?? null, views, byUnit, input.confirmation);
  const vocab = byKey((key) => projectVocab(VOCAB_UNIT[key], base?.vocab?.[key] ?? null, views[key], byUnit.get(VOCAB_UNIT[key]) ?? NO_CHANGES, vocabCounts[key]));
  const published = base?.snapshot ?? null, last = base?.seen ?? undefined, persistenceKey = JSON.stringify(source.persistence);
  // カード（unit ごとに 8 枚まで、P3-UM-AC11）は欄が同じなら前に作ったカードを使う。
  const cardsOf = (cards: readonly UnreadableCardView[] | undefined, previousWire: readonly DisplayWireCard[] | undefined): readonly DisplayWireCard[] => {
    const next = (cards ?? []).map(wireCard);
    return previousWire !== undefined && next.length === previousWire.length && next.every((card, index) => JSON.stringify(card) === JSON.stringify(previousWire[index]))
      ? previousWire : next;
  };
  const protectedCurrent = {
    eew: { unit: "U-E" as const, contentRevision: views.eew.contentRevision, items: domains.eew.full.items, wire: eewWire(eew),
      cards: cardsOf(views.eew.unreadableCards, published?.current.eew.cards) },
    tsunami: { unit: "U-T" as const, contentRevision: views.tsunami.contentRevision, items: domains.tsunami.full.items, wire: tsunamiWire(tsunami, counts.tsunami),
      cards: cardsOf(views.tsunami.unreadableCards, published?.current.tsunami.cards) },
    earthquake: { unit: "U-Q" as const, contentRevision: views.earthquake.contentRevision, items: domains.earthquake.full.items, wire: quakeWire(earthquake, views.earthquake),
      cards: cardsOf(views.earthquake.unreadableCards, published?.current.earthquake.cards) },
  };
  const itemsOf = (key: VocabKey): Items => domains[key].full.items;
  const bytes = byKey((key) => fullBytes(VOCAB_UNIT[key], views[key].contentRevision, itemsOf(key), vocab[key]));
  const shellOf = (current: DisplayWireSnapshot["current"]): Omit<DisplayWireSnapshot, "sequence" | "generatedAt"> => ({
    schemaVersion: VERSION, streamId: source.streamId,
    semanticRevision: JSON.stringify([views.eew.contentRevision, views.tsunami.contentRevision, views.earthquake.contentRevision,
      ...VOCAB_KEYS.map((key) => views[key].contentRevision)]),
    connection: source.connection, worker: source.worker,
    persistence: published != null && last != null && persistenceKey === last.persistence ? published.persistence : boundedPersistence(source.persistence),
    recovery: source.recovery,
    channels: { desktop: channel(source.notificationChannels.desktop, source.channelProbeComplete, source.channelFailing.desktop),
      sound: channel(source.notificationChannels.sound, source.channelProbeComplete, source.channelFailing.sound) },
    current, notices: hidden.size === 0 ? input.notices : input.notices.filter((notice) => !hidden.has(notice.targetId)), removals, losses: losses.wire,
  });
  const build = (summarize: ReadonlySet<VocabKey>): DisplayWireSnapshot["current"] => ({ ...protectedCurrent,
    weatherCurrent: vocabDomain("U-W", views.weatherCurrent.contentRevision, itemsOf("weatherCurrent"), vocab.weatherCurrent,
      summarize.has("weatherCurrent") ? bytes.weatherCurrent : null, published?.current.weatherCurrent),
    weatherTimeseries: vocabDomain("U-F", views.weatherTimeseries.contentRevision, itemsOf("weatherTimeseries"), vocab.weatherTimeseries,
      summarize.has("weatherTimeseries") ? bytes.weatherTimeseries : null, published?.current.weatherTimeseries),
    nankai: vocabDomain("U-N", views.nankai.contentRevision, itemsOf("nankai"), vocab.nankai, summarize.has("nankai") ? bytes.nankai : null, published?.current.nankai),
    volcano: vocabDomain("U-V", views.volcano.contentRevision, itemsOf("volcano"), vocab.volcano, summarize.has("volcano") ? bytes.volcano : null, published?.current.volcano),
    landslide: vocabDomain("U-L", views.landslide.contentRevision, itemsOf("landslide"), vocab.landslide, summarize.has("landslide") ? bytes.landslide : null,
      published?.current.landslide),
    flood: vocabDomain("U-R", views.flood.contentRevision, itemsOf("flood"), vocab.flood, summarize.has("flood") ? bytes.flood : null, published?.current.flood),
    briefing: vocabDomain("U-B", views.briefing.contentRevision, itemsOf("briefing"), vocab.briefing, summarize.has("briefing") ? bytes.briefing : null,
      published?.current.briefing),
    localBulletins: vocabDomain("U-M", views.localBulletins.contentRevision, itemsOf("localBulletins"), vocab.localBulletins,
      summarize.has("localBulletins") ? bytes.localBulletins : null, published?.current.localBulletins),
    typhoon: vocabDomain("U-Y", views.typhoon.contentRevision, itemsOf("typhoon"), vocab.typhoon, summarize.has("typhoon") ? bytes.typhoon : null, published?.current.typhoon),
  });
  // 全体が 1,048,576 を超えたときだけ、包みが 65,536 を超えた 9 分野を要約にする（view-projector の RES-06 と同じ式、P4-DV-D-SUMMARY-RULE=A）。保護 3 分野は要約にしない（H37）。
  let shell = shellOf(build(new Set()));
  const vocabTotal = VOCAB_KEYS.reduce((sum, key) => sum + bytes[key], 0);
  if (vocabTotal + NEW_PATH_FIXED_BOUND > SNAPSHOT_BYTES) {
    const total = commonBytes(shell, (published?.sequence ?? 0) + 1, source.generatedAt)
      + protectedBytes(protectedCurrent.eew) + protectedBytes(protectedCurrent.tsunami) + protectedBytes(protectedCurrent.earthquake) + vocabTotal;
    if (total > SNAPSHOT_BYTES) shell = shellOf(build(new Set(VOCAB_KEYS.filter((key) => bytes[key] > DOMAIN_BUDGET))));
  }
  const state = (snapshot: DisplayWireSnapshot | null, seen: Seen | null): DisplayWireState =>
    ({ streamId: source.streamId, snapshot, seen, eew, tsunami, earthquake, domains, vocab, removals, losses, hidden });
  if (published != null && sameSnapshot(published, shell)) return { kind: "unchanged", state: state(published, last ?? null), counts, vocabCounts };
  const snapshot: DisplayWireSnapshot = { ...shell, sequence: (published?.sequence ?? 0) + 1, generatedAt: source.generatedAt };
  return { kind: "projected", state: state(snapshot, { persistence: persistenceKey }), snapshot, counts, vocabCounts };
}

// ---- 消えた理由の一覧・H39 の欄・停止の確定で消えた記録のお知らせ（P4-REMOVAL-LOSS-001、表 §3） ----

// publisher が組む材料（P4-RL-AC04 (2)・AC05〜AC08）: at は publisher の wall、restored は表示差分が restored の返信のものか（一覧に載せない）、
// mirror は unit の LossTally の行、hole は H39 の欠け（穴を持たない unit は null）、eewWindow は H28 の外した区間（publisher の手元）。
type RemovalLossSource = Readonly<{ at: number; restored: boolean; mirror: Readonly<Record<UnitId, Readonly<{ losses: readonly LossTally[] }>>>;
  hole: (unit: UnitId) => boolean | null; eewWindow: DisplayEewWindow }>;
const REMOVALS_PER_UNIT = 4;
const NO_REMOVALS: DisplayRemovalWire = {};
const NO_HIDDEN: ReadonlySet<string> = new Set();
// 消える前の記録の最終更新: before の subject の報時刻の最も新しいもの（報時刻を持たなければ null、P4-RL-AC08 (2)）。
function updatedAtOf(before: RuntimeDisplaySubject): number | null {
  let latest: number | null = null;
  for (const item of before.subjects) {
    const time = item.source == null ? Number.NaN : Date.parse(item.source.reportDateTimeRaw);
    if (Number.isFinite(time) && (latest == null || time > latest)) latest = time;
  }
  return latest;
}
// 一覧は mergedByUnit の後の差分から作る（同じ公開で消えて戻った subject は載らない、P4-RL-AC01 (3)）。載せるのは before.current のある消失だけで、
// markCleared と expiredWhileStopped と restored の返信の差分は載せない（AC04 (2)(4)）。分野ごとに新しい 4 件を残し、落とした数を数える（1 件 O(1)）。
function projectRemovals(previous: DisplayRemovalWire, byUnit: ReadonlyMap<RuntimeUnitId, readonly RuntimeDisplayChange[]>, source: RemovalLossSource): DisplayRemovalWire {
  if (source.restored) return previous;
  let next = previous;
  for (const [unit, changes] of byUnit) for (const change of changes) {
    if (change.after != null || change.before?.current == null || change.removal === "markCleared" || change.removal === "expiredWhileStopped") continue;
    const base = { unit, operation: change.operation, at: source.at, ref: { id: sha256([unit, change.operation, change.subject]) } };
    const item: DisplayRemovalItem = change.removal === "expired" ? { ...base, reason: "expired", updatedAt: updatedAtOf(change.before) } : { ...base, reason: change.removal };
    const old = next[unit], items = [item, ...old?.items ?? []];
    next = { ...next, [unit]: { items: items.slice(0, REMOVALS_PER_UNIT), omitted: (old?.omitted ?? 0) + Math.max(0, items.length - REMOVALS_PER_UNIT) } };
  }
  return next;
}

// H39 の 5 区分（P4-RL-AC08 (3)、B0 の表 r7 §13.2）。閉集合の語を全部書くので、語が増えたらコンパイラが止める。
const LOSS_CLASS: Readonly<Record<LossReason, "dropped" | "evicted" | "missed" | "outcomeUnknown" | "unreadable">> = {
  notificationExpired: "dropped", notificationExpiredClockUnverified: "dropped", notificationCapacityEvicted: "dropped", notificationOutcomeUnknown: "outcomeUnknown",
  capacityRejected: "missed", unreadableReport: "unreadable", noticeMarkEvicted: "evicted", seismicStationsFolded: "evicted", unreadableDropped: "evicted",
  eewCapacityEvicted: "evicted", weatherCurrentCapacityEvicted: "evicted", seriesCapacityEvicted: "evicted", tsunamiCapacityEvicted: "evicted", seismicCapacityEvicted: "evicted",
  nankaiCapacityEvicted: "evicted", volcanoCapacityEvicted: "evicted", landslideCapacityEvicted: "evicted", floodCapacityEvicted: "evicted", briefingCapacityEvicted: "evicted",
  localBulletinsCapacityEvicted: "evicted", typhoonCapacityEvicted: "evicted",
};
// seen は欄を作った行の参照と欠けの値。unit ごとに前と同じなら前の欄の object を使い、変わった unit だけ和と rev を作り直す（公開ごとに 12 回 hash しない）。
type LossSeen = Readonly<{ rows: readonly LossTally[]; hole: boolean | null }>;
type LossProjection = Readonly<{ wire: DisplayLossWire; seen: Readonly<Record<UnitId, LossSeen>> }>;
const perUnit = <T>(make: (unit: UnitId) => T): Readonly<Record<UnitId, T>> => ({ "U-E": make("U-E"), "U-W": make("U-W"), "U-F": make("U-F"), "U-T": make("U-T"),
  "U-Q": make("U-Q"), "U-N": make("U-N"), "U-V": make("U-V"), "U-L": make("U-L"), "U-R": make("U-R"), "U-B": make("U-B"), "U-M": make("U-M"), "U-Y": make("U-Y") });
const sameWindow = (left: DisplayEewWindow | undefined, right: DisplayEewWindow): boolean =>
  left != null && left.count === right.count && left.from === right.from && left.to === right.to;
function lossRow(seen: LossSeen, eewWindow: DisplayEewWindow | null): DisplayLossRow {
  const sums = { dropped: 0, evicted: 0, missed: 0, outcomeUnknown: 0, unreadable: 0 };
  for (const row of seen.rows) { const key = LOSS_CLASS[row.reason]; sums[key] = Math.min(sums[key] + row.count, Number.MAX_SAFE_INTEGER); }
  return { ...sums, hole: seen.hole, rev: sha256(seen.rows), ...eewWindow == null ? {} : { eewWindow } };
}
function projectLosses(previous: LossProjection | null, source: RemovalLossSource): LossProjection {
  const seen = perUnit((unit): LossSeen => {
    const rows = source.mirror[unit].losses, hole = source.hole(unit), old = previous?.seen[unit];
    return old != null && old.rows === rows && old.hole === hole ? old : { rows, hole };
  });
  const kept = (unit: UnitId) => previous != null && previous.seen[unit] === seen[unit] && (unit !== "U-E" || sameWindow(previous.wire["U-E"].eewWindow, source.eewWindow));
  if (previous != null && UNIT_IDS.every(kept)) return previous;
  return { seen, wire: perUnit((unit) => previous != null && kept(unit) ? previous.wire[unit] : lossRow(seen[unit], unit === "U-E" ? source.eewWindow : null)) };
}

// P4-RL-AC08 (8): 旧の射影は停止の確定の差分を受けないので、その差分で消えた記録のお知らせが旧の notices に残る。この公開の差分で U-W・U-F の記録が
// 消えた subject と、U-E の EventID の最後の報が外れた（EEW の events の鍵が消えた）EventID の targetId を新しい経路から外す。持つのは旧の notices に
// 今ある targetId だけ（上限は notices の 64 件）で、旧から消えたら捨てる。stream が替われば state ごと捨てる。
function hiddenNotices(previous: ReadonlySet<string>, byUnit: ReadonlyMap<RuntimeUnitId, readonly RuntimeDisplayChange[]>, eew: EewProjection,
  notices: readonly VisibleNotice[]): ReadonlySet<string> {
  const leaving: string[] = [];
  for (const unit of ["U-E", "U-W", "U-F"] as const) for (const change of byUnit.get(unit) ?? NO_CHANGES) {
    if (change.after != null || change.before == null) continue;
    if (change.before.unit !== "U-E") leaving.push(sha256([unit, change.operation, change.subject]));
    else if (change.before.current != null && !eew.events.has(`${change.operation}/${change.before.current.eventId}`))
      leaving.push(sha256(["U-E", change.operation, change.before.current.eventId]));
  }
  if (leaving.length === 0 && previous.size === 0) return previous;
  const present = new Set(notices.map((notice) => notice.targetId));
  const next = new Set([...previous, ...leaving].filter((id) => present.has(id)));
  return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
}

export { WIRE_COUNTS, WIRE_LIMITS, cutText, projectDisplayWire };
export type { DisplayWireCounts, DisplayWireInput, DisplayWireResult, DisplayWireSource, DisplayWireState, DisplayWireVocabCounts, DisplayWireViews };
