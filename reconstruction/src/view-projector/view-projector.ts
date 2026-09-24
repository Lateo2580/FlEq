import { createHash } from "node:crypto";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { NotificationChannelState } from "../../contracts/p2-notification-delivery.types";
import type {
  DiagnosticDetails,
  ReportRef,
  RuntimeConfirmation,
  RuntimeDisplaySubject,
  RuntimeUnitId,
  RuntimeUnitView,
  UnconfirmedReason,
} from "../../contracts/p2-shared-runtime.types";
import type {
  DisplayAreaSystem,
  DisplayChannelView,
  DisplayDomainProjection,
  DisplayDomainView,
  DisplayNoticeSource,
  DisplaySeverity,
  DisplaySnapshot,
  DisplaySummaryItem,
  SnapshotProjectionInput,
  SnapshotProjectionResult,
  SnapshotProjectionState,
  VisibleNotice,
} from "../../contracts/p2-snapshot-sse.types";
import { VPNO_TYPE, WARNING_TYPES, parseScopeToken } from "../domains/weather-current/weather-current";

// P2-SNAPSHOT-SSE-001 RES-01/03/04/05/06 and P2-A8-NOTICE.
const SNAPSHOT_BYTES = 1_048_576;
const DOMAIN_BUDGET = 65_536;
const COMMON_BUDGET = 65_536;
const STRING_BYTES = 256;
const NOTICE_ITEMS = 64;
const NOTICE_BYTES = 131_072;
const OFFICE_BYTES = 256;
const DATE_LIMIT = 8_640_000_000_000_000;
const OPERATIONS = ["normal", "training", "test"] as const;
const TTL: Readonly<Record<RuntimeUnitId, number>> = { "U-E": 15_000, "U-W": 60_000, "U-F": 60_000 };
const NOTICE_TEXT = {
  eewNew: "緊急地震速報を確認",
  eewWarning: "緊急地震速報が警報に変わりました",
  "U-W": "気象警報の現況を確認できません",
  "U-F": "気象時系列情報を確認できません",
} as const;
const INFORMATION_TYPE = { "U-E": "eew", "U-W": "weather-warning", "U-F": "weather-warning-timeseries" } as const;
const AREA_SYSTEMS: Readonly<Record<RuntimeUnitId, readonly DisplayAreaSystem[]>> = {
  "U-E": ["eewArea"],
  "U-W": ["prefecture", "primary", "municipalityGroup", "municipality", "stormSurge"],
  "U-F": ["forecastArea"],
};
// Fixed key order keeps full and summary items byte-identical whatever order counts arrive in.
const UNAVAILABLE_KEYS = ["capacityExceeded", "historyUnavailable", "coverageIncomplete"] as const;
const UNKNOWN_KEYS = ["unknown", "missing", "empty"] as const;
const FRESHNESS_KEYS = ["headMissing", "reportDateTimeMissing", "reportDateTimeInvalid", "identityMissing",
  "identityInvalid", "requiredStructureMissing", "requiredStructureInvalid", "stale"] as const;
const UNCONFIRMED_KEYS: readonly UnconfirmedReason[] = ["startup", "disconnected", "scopeCapacity", "scopeRetired"];
const SEVERITY_RANK: readonly DisplaySeverity[] = ["specialWarning", "danger", "warning", "advisory", "forecast", "below", "none"];
const NOTICE_FAMILIES: readonly DisplayNoticeSource["family"][] = ["VXSE43", "VXSE45", "VPWS50", "VPWW55", "VPWW57",
  "VPWW58", "VPWW59", "VPWW60", "VPWW61", "VPNO50", "VPWP50"];
// R39: the Code is authoritative; Status text or Name never raises the class.
const WEATHER_SEVERITY = severityTable([
  ["none", ["00"]],
  ["advisory", ["10", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "29"]],
  ["warning", ["02", "03", "04", "05", "06", "07", "08", "09"]],
  ["danger", ["43", "48", "49"]],
  ["specialWarning", ["32", "33", "35", "36", "37", "38", "39"]],
]);
// Q-VALUES.knownCodes (evidenceStage unchanged: not claimed as the official current set).
const TIMESERIES_SEVERITY = severityTable([
  ["none", ["00"]], ["below", ["01", "11"]], ["advisory", ["20", "21", "22"]], ["warning", ["30", "31"]],
  ["danger", ["41"]], ["specialWarning", ["50", "51"]],
]);
const NOT_CURRENT = new Set(["解除", "発表警報・注意報はなし"]);

type Counts<Key extends string> = Partial<Record<Key, number>>;
type Row = {
  activeCount: number;
  unavailable: Counts<typeof UNAVAILABLE_KEYS[number]>;
  unknownCode: Counts<typeof UNKNOWN_KEYS[number]>;
  freshness: Counts<typeof FRESHNESS_KEYS[number]>;
  areaCounts: Counts<DisplayAreaSystem>;
  updatedAt: number | null;
};
// One subject's contribution to its domain: view bytes plus summary keys (P2-A8-SUMMARY/COST).
type Tally = {
  operation: Operation;
  bytes: number;
  active: number;
  areas: Map<string, number>;
  severities: Map<string, number>;
  times: Map<string, number>;
  unavailable: Row["unavailable"];
  unknownCode: Row["unknownCode"];
  freshness: Row["freshness"];
  // U-E only: the non-terminal current's event, independent of the normal mask (notice identity).
  event: Readonly<{ key: string; eventId: string; warningClass: "forecast" | "warning"; source: ReportRef }> | null;
};
type EventRef = Readonly<{ forecast: number; warning: number }>;
type EventRefs = ReadonlyMap<string, EventRef>;
type EventTransition = { operation: Operation; eventId: string; before: "forecast" | "warning" | null;
  after: "forecast" | "warning" | null; warningSource: ReportRef | null; anySource: ReportRef | null; accepted: boolean };
type Change = Readonly<{ unit: RuntimeUnitId; operation: Operation; subject: string;
  before: RuntimeDisplaySubject | null; after: RuntimeDisplaySubject | null }>;
type AnyView = RuntimeUnitView;
type Meta = Readonly<{ admission: Readonly<Record<Operation, number>>; confirmation: RuntimeConfirmation["units"][RuntimeUnitId] }>;
// Keys JSON.stringify([unit, operation, subject]) of this step's accepted semantic A1 outcomes.
type Gates = ReadonlySet<string>;

function severityTable(table: readonly (readonly [DisplaySeverity, readonly string[]])[]): ReadonlyMap<string, DisplaySeverity> {
  return new Map(table.flatMap(([severity, codes]) => codes.map((code) => [code, severity] as const)));
}

function count<Key extends string>(target: Counts<Key>, key: Key, delta: number): void {
  const next = (target[key] ?? 0) + delta;
  if (next < 0) throw new RangeError("display change before does not match the projection");
  target[key] = next;
}

function utf8(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function dateValue(value: number): boolean {
  return Number.isInteger(value) && value >= -DATE_LIMIT && value <= DATE_LIMIT;
}

// Upstream sources are validated by A1 (validateSemanticEnvelope); Date.parse yields the same epoch.
function reportTime(source: ReportRef | null): number | null {
  if (source == null) return null;
  const value = Date.parse(source.reportDateTimeRaw);
  return dateValue(value) ? value : null;
}

function emptyTally(operation: Operation): Tally {
  return { operation, bytes: 0, active: 0, areas: new Map(), severities: new Map(), times: new Map(),
    unavailable: {}, unknownCode: {}, freshness: {}, event: null };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addTime(tally: Tally, source: ReportRef | null): void {
  const at = reportTime(source);
  if (at != null) bump(tally.times, `${tally.operation}|${at}`);
}

function masked(view: AnyView | null, operation: Operation): boolean {
  // Q-R20-CLEAR: the normal publication mask is visible to A8 only as the view's admission flag.
  return view != null && operation === "normal" && view.admission.normal != null;
}

function eewTally(value: RuntimeDisplaySubject | null, hidden: boolean): Tally | null {
  if (value == null || value.unit !== "U-E" || value.current == null) return null;
  const current = value.current;
  const tally = emptyTally(value.operation);
  if (!hidden) tally.bytes = utf8(current) + value.subjects.reduce((sum, item) => sum + utf8(item), 0);
  if (current.terminal) return tally;
  tally.event = { key: `${value.operation}|${current.eventId}`, eventId: current.eventId,
    warningClass: current.warningClass, source: current.source };
  if (hidden) return tally;
  for (const area of current.prediction.areas)
    if (area.code !== "") bump(tally.areas, `${value.operation}|eewArea|${area.code}`);
  addTime(tally, current.source);
  return tally;
}

// Q-ENUM.warningTypes → P2-A8-SUMMARY.areas (VPNO50 府県予報区等 is prefecture too).
const WEATHER_AREA_SYSTEM: ReadonlyMap<string, DisplayAreaSystem> = new Map([
  [WARNING_TYPES[0], "prefecture"], [WARNING_TYPES[1], "primary"], [WARNING_TYPES[2], "municipalityGroup"],
  [WARNING_TYPES[3], "municipality"], [WARNING_TYPES[4], "stormSurge"], [VPNO_TYPE, "prefecture"],
]);

function weatherTally(value: RuntimeDisplaySubject | null, hidden: boolean): Tally | null {
  if (value == null || value.unit !== "U-W") return null;
  const operation = value.operation;
  const tally = emptyTally(operation);
  const current = value.current;
  // A5 keeps restored references in subjects but out of national/partials until re-adopted.
  const restored = current != null && value.subjects[0]?.transition === "restoredUnconfirmed";
  value.subjects.forEach((item, index) => {
    if (!(index === 0 && current != null && hidden)) tally.bytes += utf8(item);
  });
  if (current != null && !hidden && !restored)
    tally.bytes += utf8(current) + (current.scope === "national" ? utf8(operation) + 1 : 0);
  if (current != null && !restored) {
    let active = false;
    for (const [token, rows] of Object.entries(current.phenomena)) {
      if (!Array.isArray(rows)) continue;
      let areaActive = false;
      for (const row of rows) {
        if (row == null || typeof row !== "object" || Array.isArray(row)) continue;
        const code = row.code;
        if (typeof code !== "string" || typeof row.status === "string" && NOT_CURRENT.has(row.status)) continue;
        const severity = WEATHER_SEVERITY.get(code);
        if (code !== "00") {
          areaActive = true;
          if (severity == null) count(tally.unknownCode, "unknown", 1);
        }
        if (severity != null && !hidden) bump(tally.severities, `${operation}|${severity}`);
      }
      if (!areaActive) continue;
      active = true;
      const tuple = parseScopeToken(token);
      const system = tuple == null ? null : WEATHER_AREA_SYSTEM.get(tuple[3]) ?? null;
      if (tuple != null && system != null && tuple[4] !== "" && !hidden) bump(tally.areas, `${operation}|${system}|${tuple[4]}`);
    }
    if (active && !hidden) {
      tally.active = 1;
      addTime(tally, current.source);
    }
  }
  for (const record of value.unavailable) {
    count(tally.unavailable, record.reason, 1);
    addTime(tally, record.source);
  }
  for (const record of value.freshness) {
    if (!record.freshnessSuspect) continue;
    const reason = FRESHNESS_KEYS.find((key) => key === record.reason);
    if (reason != null) count(tally.freshness, reason, 1);
    addTime(tally, record.suspectedSource ?? record.candidateSource);
  }
  return tally;
}

function timeseriesTally(value: RuntimeDisplaySubject | null, hidden: boolean): Tally | null {
  if (value == null || value.unit !== "U-F" || value.current == null) return null;
  const subject = value.current;
  const operation = value.operation;
  const tally = emptyTally(operation);
  if (!hidden) tally.bytes = utf8(subject) + value.subjects.reduce((sum, item) => sum + utf8(item), 0);
  if (subject.effective === "unavailable") {
    if (subject.unavailableReason != null) count(tally.unavailable, subject.unavailableReason, 1);
    addTime(tally, subject.source);
    return tally;
  }
  if (subject.effective !== "active") return tally;
  const areas = new Set<string>();
  for (const row of subject.periods) {
    const area = subject.strings[subject.areas[row[1]].code];
    if (area !== "") areas.add(area);
    const value = subject.values[row[10]];
    if (value.kind !== "significancy") continue;
    const reason = value.name.kind === "missing" || value.code.kind === "missing" ? "missing"
      : value.name.kind === "empty" || value.code.kind === "empty" ? "empty"
        : value.code.kind === "text" ? null : "unknown";
    const severity = reason == null && value.code.kind === "text" ? TIMESERIES_SEVERITY.get(value.code.raw) : undefined;
    if (reason != null || severity == null) count(tally.unknownCode, reason ?? "unknown", 1);
    else if (!hidden) bump(tally.severities, `${operation}|${severity}`);
  }
  if (hidden) return tally;
  tally.active = 1;
  for (const area of areas) bump(tally.areas, `${operation}|forecastArea|${area}`);
  addTime(tally, subject.source);
  return tally;
}

// View bytes excluding subject elements: scalar fields, keys, brackets and element separators.
function fixedBytes(view: AnyView): number {
  const commas = (length: number) => Math.max(length - 1, 0);
  if (view.unit === "U-E")
    return utf8({ ...view, subjects: [], current: [] }) + commas(view.subjects.length) + commas(view.current.length);
  if (view.unit === "U-W")
    return utf8({ ...view, subjects: [], national: {}, partials: [] }) + commas(view.subjects.length)
      + commas(view.partials.length) + commas(Object.keys(view.national).length);
  return utf8({ ...view, series: [], subjects: [] }) + commas(view.series.length) + commas(view.subjects.length);
}

function wrapperBytes(full: Omit<Extract<DisplayDomainView<AnyView>, { delivery: "full" }>, "view">, viewBytes: number): number {
  return utf8({ unit: full.unit, contentRevision: full.contentRevision, items: full.items, delivery: "full", view: 0 })
    - 1 + viewBytes;
}

function applyRefs(refs: Map<string, number>, delta: ReadonlyMap<string, number>, sign: 1 | -1,
  changed: (key: string, present: boolean) => void): void {
  for (const [key, count] of delta) {
    const old = refs.get(key) ?? 0;
    const next = old + sign * count;
    if (next < 0) throw new RangeError("display change before does not match the projection");
    if (next === 0) refs.delete(key); else refs.set(key, next);
    if ((old === 0) !== (next === 0)) changed(key, next !== 0);
  }
}

function addCounts<Key extends string>(keys: readonly Key[], target: Counts<Key>, delta: Counts<Key>, sign: 1 | -1): void {
  for (const key of keys) if (delta[key] != null) count(target, key, sign * (delta[key] ?? 0));
}

// Zero counts are omitted, in the fixed key order.
function nonZero<Key extends string>(keys: readonly Key[], source: Counts<Key>): Counts<Key> {
  const result: Counts<Key> = {};
  for (const key of keys) if ((source[key] ?? 0) > 0) result[key] = source[key];
  return result;
}

function rowFromItem(item: DisplaySummaryItem | null): Row {
  return {
    activeCount: item?.activeCount ?? 0,
    unavailable: { ...item?.unavailable }, unknownCode: { ...item?.unknownCode }, freshness: { ...item?.freshness },
    areaCounts: { ...item?.areaCounts },
    updatedAt: item?.updatedAt ?? null,
  };
}

function confirmationState(slot: RuntimeConfirmation["units"][RuntimeUnitId][Operation]): DisplaySummaryItem["confirmation"] {
  // P2-A1-CONFIRMATION.display: whole marker and unconfirmed scopes are both inside slot.counts.
  const unconfirmed = UNCONFIRMED_KEYS.reduce((sum, key) => sum + (slot.counts[key] ?? 0), 0);
  return { state: unconfirmed === 0 ? "confirmed" : slot.confirmedScopeCount > 0 ? "partial" : "unconfirmed",
    confirmedAt: slot.confirmedAt };
}

function buildItem(unit: RuntimeUnitId, operation: Operation, row: Row, highestSeverity: DisplaySeverity | null,
  meta: Meta): DisplaySummaryItem {
  const slot = meta.confirmation[operation];
  const admission = meta.admission[operation];
  return {
    operation, informationType: INFORMATION_TYPE[unit], activeCount: row.activeCount, highestSeverity,
    areaCounts: Object.fromEntries(AREA_SYSTEMS[unit].map((system) => [system, row.areaCounts[system] ?? 0])),
    updatedAt: row.updatedAt,
    admission: admission > 0 ? { capacityExceeded: admission } : {},
    unavailable: nonZero(UNAVAILABLE_KEYS, row.unavailable),
    unconfirmed: nonZero(UNCONFIRMED_KEYS, slot.counts),
    unknownCode: nonZero(UNKNOWN_KEYS, row.unknownCode),
    freshness: nonZero(FRESHNESS_KEYS, row.freshness),
    confirmation: confirmationState(slot),
  };
}

function highest(refs: ReadonlyMap<string, number>, operation: Operation): DisplaySeverity | null {
  return SEVERITY_RANK.find((severity) => refs.has(`${operation}|${severity}`)) ?? null;
}

function latest(refs: ReadonlyMap<string, number>, operation: Operation): number | null {
  // ponytail: scans this domain's time index (<= its subject count), never subject bodies.
  let result: number | null = null;
  const prefix = `${operation}|`;
  for (const key of refs.keys()) if (key.startsWith(prefix)) {
    const at = Number(key.slice(prefix.length));
    if (result == null || at > result) result = at;
  }
  return result;
}

type DomainStep<View extends AnyView> = Readonly<{
  projection: DisplayDomainProjection<View>;
  eventRefs: EventRefs;
  transitions: readonly EventTransition[];
  tallies: readonly Readonly<{ change: Change; before: Tally | null; after: Tally | null }>[];
}>;

function eventClass(value: EventRef | undefined): "forecast" | "warning" | null {
  return value == null ? null : value.warning > 0 ? "warning" : value.forecast > 0 ? "forecast" : null;
}

function projectDomain<View extends AnyView>(unit: RuntimeUnitId, previous: DisplayDomainProjection<View> | null,
  view: View, changes: readonly Change[], meta: Meta, previousEvents: EventRefs, gates: Gates,
  tallyOf: (value: RuntimeDisplaySubject | null, hidden: boolean) => Tally | null): DomainStep<View> {
  const beforeView = previous?.full.view ?? null;
  if (previous != null && changes.length === 0 && view === beforeView) {
    // Metadata only (admission counts, confirmation): nine slot reads, no subject or element walk.
    const items = previous.full.items.map((item, index) => buildItem(unit, OPERATIONS[index],
      rowFromItem(item), item.highestSeverity, meta));
    const reuse = JSON.stringify(items) === JSON.stringify(previous.full.items);
    if (reuse) return { projection: previous, eventRefs: previousEvents, transitions: [], tallies: [] };
    const full = { ...previous.full, items: [items[0], items[1], items[2]] as const };
    const viewBytes = previous.utf8Bytes - wrapperBytes(previous.full, 0);
    return { projection: { ...previous, full, utf8Bytes: wrapperBytes(full, viewBytes) },
      eventRefs: previousEvents, transitions: [], tallies: [] };
  }
  const rows = OPERATIONS.map((_, index) => rowFromItem(previous?.full.items[index] ?? null));
  // ponytail: copy-on-write indexes are O(index size) per changed domain; mutate in place if that shows up.
  const areaRefs = new Map(previous?.areaRefs), severityRefs = new Map(previous?.severityRefs);
  const timeRefs = new Map(previous?.timeRefs);
  const eventRefs = new Map(previousEvents);
  const timeOps = new Set<Operation>();
  const transitions = new Map<string, EventTransition>();
  let elementBytes = previous == null ? 0 : previous.utf8Bytes - wrapperBytes(previous.full, 0) - fixedBytes(previous.full.view);
  const rowOf = (operation: Operation) => rows[OPERATIONS.indexOf(operation)];
  const apply = (tally: Tally, sign: 1 | -1, change: Change) => {
    const row = rowOf(tally.operation);
    elementBytes += sign * tally.bytes;
    row.activeCount += sign * tally.active;
    addCounts(UNAVAILABLE_KEYS, row.unavailable, tally.unavailable, sign);
    addCounts(UNKNOWN_KEYS, row.unknownCode, tally.unknownCode, sign);
    addCounts(FRESHNESS_KEYS, row.freshness, tally.freshness, sign);
    applyRefs(areaRefs, tally.areas, sign, (key, present) => {
      const system = AREA_SYSTEMS[unit].find((name) => name === key.split("|")[1]);
      if (system != null) count(row.areaCounts, system, present ? 1 : -1);
    });
    applyRefs(severityRefs, tally.severities, sign, () => {});
    applyRefs(timeRefs, tally.times, sign, () => timeOps.add(tally.operation));
    if (tally.event == null) return;
    const { key, eventId, warningClass, source } = tally.event;
    const old = eventRefs.get(key);
    let transition = transitions.get(key);
    if (transition == null) {
      transition = { operation: tally.operation, eventId, before: eventClass(old), after: null,
        warningSource: null, anySource: null, accepted: false };
      transitions.set(key, transition);
    }
    if (gates.has(JSON.stringify([unit, change.operation, change.subject]))) transition.accepted = true;
    if (sign === 1) {
      transition.anySource ??= source;
      if (warningClass === "warning") transition.warningSource ??= source;
    }
    const next = { forecast: (old?.forecast ?? 0) + (warningClass === "forecast" ? sign : 0),
      warning: (old?.warning ?? 0) + (warningClass === "warning" ? sign : 0) };
    if (next.forecast < 0 || next.warning < 0) throw new RangeError("display change before does not match the projection");
    if (next.forecast === 0 && next.warning === 0) eventRefs.delete(key); else eventRefs.set(key, next);
    const before = eventClass(old), after = eventClass(eventRefs.get(key));
    if (before !== after) {
      // U-E class counts are per event (family-deduplicated), not per current.
      if (before != null) applyRefs(severityRefs, new Map([[`${tally.operation}|${before}`, 1]]), -1, () => {});
      if (after != null) applyRefs(severityRefs, new Map([[`${tally.operation}|${after}`, 1]]), 1, () => {});
    }
  };
  const tallies: { change: Change; before: Tally | null; after: Tally | null }[] = [];
  for (const change of changes) {
    const before = previous == null ? null : tallyOf(change.before, masked(beforeView, change.operation));
    const after = tallyOf(change.after, masked(view, change.operation));
    if (before != null) apply(before, -1, change);
    if (after != null) apply(after, 1, change);
    tallies.push({ change, before, after });
  }
  for (const transition of transitions.values())
    transition.after = eventClass(eventRefs.get(`${transition.operation}|${transition.eventId}`));
  for (const operation of timeOps) rowOf(operation).updatedAt = latest(timeRefs, operation);
  const items = OPERATIONS.map((operation, index) => {
    const row = rows[index];
    if (unit !== "U-E") return buildItem(unit, operation, row, highest(severityRefs, operation), meta);
    // A4 warningClass only; the normal mask hides current-derived activity (Q-R20-CLEAR).
    const hidden = masked(view, operation);
    const events = (severityRefs.get(`${operation}|forecast`) ?? 0) + (severityRefs.get(`${operation}|warning`) ?? 0);
    return buildItem(unit, operation, { ...row, activeCount: hidden ? 0 : events },
      hidden ? null : highest(severityRefs, operation), meta);
  });
  const full = { unit, contentRevision: view.contentRevision, items: [items[0], items[1], items[2]] as const,
    delivery: "full" as const, view };
  const utf8Bytes = wrapperBytes(full, fixedBytes(view) + elementBytes);
  // The first projection may measure the whole view once (P2-A8-COST); a mismatch means the startup delta was incomplete.
  if (previous == null && utf8(full) !== utf8Bytes) throw new RangeError(`${unit} startup display changes do not cover its view`);
  return {
    projection: { full, utf8Bytes, areaRefs, severityRefs, timeRefs },
    eventRefs, transitions: [...transitions.values()], tallies,
  };
}

function wellFormedPrefix(value: string): Readonly<{ text: string; truncated: boolean }> {
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

function noticeSource(unit: RuntimeUnitId, source: ReportRef | null, office: string | null): DisplayNoticeSource | null {
  const family = NOTICE_FAMILIES.find((name) => name === source?.family);
  if (source == null || family == null) return null;
  const bounded = office == null ? null : wellFormedPrefix(office);
  return {
    id: sha256([unit, source.operation, source.family, source.subject, source.inputId]),
    family,
    office: bounded?.text ?? null,
    officeTruncated: bounded?.truncated ?? false,
    reportTime: reportTime(source),
  };
}

function notice(targetId: string, unit: RuntimeUnitId, operation: Operation, kind: VisibleNotice["kind"],
  source: DisplayNoticeSource | null, expiresAt: number): VisibleNotice {
  return {
    id: sha256([targetId, kind, source?.id ?? null]), targetId, unit, kind, operation,
    text: kind === "unavailable" ? NOTICE_TEXT[unit === "U-F" ? "U-F" : "U-W"] : NOTICE_TEXT[kind],
    source, expiresAt,
  };
}

function byExpiry(left: VisibleNotice, right: VisibleNotice): number {
  return right.expiresAt - left.expiresAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function priority(item: VisibleNotice): number {
  return item.operation !== "normal" ? 2 : item.unit === "U-E" ? 0 : 1;
}

function selectNotices(values: readonly VisibleNotice[]): Readonly<{ notices: readonly VisibleNotice[]; excluded: number }> {
  const sorted = [...values].sort(byExpiry);
  if (sorted.length <= NOTICE_ITEMS && utf8(sorted) <= NOTICE_BYTES) return { notices: sorted, excluded: 0 };
  const ranked = [...values].sort((left, right) => priority(left) - priority(right) || byExpiry(left, right));
  const kept: VisibleNotice[] = [];
  let size = 2;
  for (const item of ranked) {
    const width = utf8(item) + (kept.length === 0 ? 0 : 1);
    if (kept.length === NOTICE_ITEMS || size + width > NOTICE_BYTES) break;
    kept.push(item);
    size += width;
  }
  return { notices: kept.sort(byExpiry), excluded: values.length - kept.length };
}

type WeatherRecordState = Readonly<{ active: boolean; unavailable: string | null }>;

function weatherState(value: RuntimeDisplaySubject | null, tally: Tally | null): WeatherRecordState {
  if (value == null) return { active: false, unavailable: null };
  if (value.unit === "U-W")
    return { active: (tally?.active ?? 0) > 0,
      unavailable: value.unavailable.length === 0 ? null : JSON.stringify(value.unavailable.map((item) => item.reason).sort()) };
  if (value.unit === "U-F" && value.current != null)
    return { active: (tally?.active ?? 0) > 0,
      unavailable: value.current.effective === "unavailable" ? value.current.unavailableReason ?? "unavailable" : null };
  return { active: false, unavailable: null };
}

function weatherSource(value: RuntimeDisplaySubject): ReportRef | null {
  if (value.unit === "U-W") return value.unavailable.find((item) => item.source != null)?.source ?? null;
  return value.unit === "U-F" ? value.current?.source ?? null : null;
}

function stringLimited(input: SnapshotProjectionInput): boolean {
  const over = (value: string) => Buffer.byteLength(value) > STRING_BYTES;
  return over(input.streamId) || over(input.generatedAt)
    || Object.values(input.persistence).some((item) => item?.kind === "failed" && over(item.reason));
}

function channel(state: NotificationChannelState, probeComplete: boolean): DisplayChannelView {
  if (!probeComplete) return "checking";
  return state.kind === "unavailable" || state.kind === "isolated" ? state.kind : "available";
}

// Everything except sequence/generatedAt and the full view bodies (identified by contentRevision).
function comparable(snapshot: DisplaySnapshot): string {
  const domain = (value: DisplayDomainView<AnyView>) => value.delivery === "full"
    ? [value.contentRevision, "full", value.items] : value;
  return JSON.stringify([snapshot.streamId, snapshot.semanticRevision, snapshot.connection, snapshot.worker,
    snapshot.persistence, snapshot.recovery, snapshot.channels, domain(snapshot.current.eew),
    domain(snapshot.current.weatherCurrent), domain(snapshot.current.weatherTimeseries), snapshot.notices]);
}

function summary<View>(projection: DisplayDomainProjection<View>): DisplayDomainView<View> {
  const { unit, contentRevision, items } = projection.full;
  return { unit, contentRevision, items, delivery: "summary", reason: "snapshotBudget",
    originalBytes: projection.utf8Bytes, budgetBytes: DOMAIN_BUDGET };
}

// previous == null relies on A1's startup step listing every public subject as an addition (P2-A1-DISPLAY-CHANGES).
function projectSnapshot(input: SnapshotProjectionInput, previous: SnapshotProjectionState | null): SnapshotProjectionResult {
  if (previous != null && previous.streamId !== input.streamId)
    throw new RangeError("a new display stream starts from previous = null");
  const changes = new Map<string, Change>();
  for (const change of input.displayChanges) {
    // Same (unit, operation, subject) twice in one step: first before, last after.
    const key = JSON.stringify([change.unit, change.operation, change.subject]);
    const found = changes.get(key);
    changes.set(key, { ...change, before: found == null ? change.before : found.before });
  }
  const gates = new Set<string>();
  const invalidated = new Set<string>();
  for (const item of input.outcomes) if (item.outcome.kind === "accepted") for (const subject of item.outcome.subjects) {
    if (item.outcome.change === "semantic") gates.add(JSON.stringify([item.unit, subject.operation, subject.subject]));
    // A4 cancel/terminal retires the whole event across families, even when this family had no current
    // (then there is no display change at all), so the target comes straight from the outcome's EventID.
    const eventId = subject.facts.eventId;
    if (item.unit === "U-E" && (subject.transition === "cancelled" || subject.transition === "released")
      && typeof eventId === "string") invalidated.add(sha256(["U-E", subject.operation, eventId]));
  }
  const byUnit = (unit: RuntimeUnitId) => [...changes.values()].filter((change) => change.unit === unit);
  const meta = (unit: RuntimeUnitId): Meta => ({ admission: input.admissionCounts[unit], confirmation: input.confirmation.units[unit] });
  const noEvents: EventRefs = new Map();
  const eew = projectDomain("U-E", previous?.domains.eew ?? null, input.eew, byUnit("U-E"), meta("U-E"),
    previous?.domains.eew.eventRefs ?? noEvents, gates, eewTally);
  const weatherCurrent = projectDomain("U-W", previous?.domains.weatherCurrent ?? null, input.weatherCurrent,
    byUnit("U-W"), meta("U-W"), noEvents, gates, weatherTally);
  const weatherTimeseries = projectDomain("U-F", previous?.domains.weatherTimeseries ?? null, input.weatherTimeseries,
    byUnit("U-F"), meta("U-F"), noEvents, gates, timeseriesTally);

  // P2-A8-NOTICE: semantic invalidation, then TTL, then generation, then capacity.
  const clockValid = dateValue(input.nowMs);
  let expiryInvalid = false;
  const created: VisibleNotice[] = [];
  const replaced = new Map<string, DisplayNoticeSource | null>();
  const create = (unit: RuntimeUnitId, operation: Operation, key: string, kind: VisibleNotice["kind"],
    source: DisplayNoticeSource | null) => {
    if (!clockValid) return;
    const expiresAt = input.nowMs + TTL[unit];
    if (!dateValue(expiresAt)) { expiryInvalid = true; return; }
    created.push(notice(sha256([unit, operation, key]), unit, operation, kind, source, expiresAt));
  };
  for (const transition of eew.transitions) {
    const targetId = sha256(["U-E", transition.operation, transition.eventId]);
    // Invalidation wins over generation in the same step.
    if (transition.after == null) invalidated.add(targetId);
    if (invalidated.has(targetId)) continue;
    if (previous == null || !transition.accepted || masked(input.eew, transition.operation)) continue;
    if (transition.before == null)
      create("U-E", transition.operation, transition.eventId, "eewNew",
        noticeSource("U-E", transition.warningSource ?? transition.anySource, null));
    else if (transition.before === "forecast" && transition.after === "warning")
      create("U-E", transition.operation, transition.eventId, "eewWarning",
        noticeSource("U-E", transition.warningSource, null));
  }
  for (const [unit, step] of [["U-W", weatherCurrent], ["U-F", weatherTimeseries]] as const)
    for (const { change, before, after } of step.tallies) {
      const targetId = sha256([unit, change.operation, change.subject]);
      const old = weatherState(change.before, before), next = weatherState(change.after, after);
      if (change.after == null || next.unavailable == null) {
        if (old.unavailable != null || change.after == null) invalidated.add(targetId);
        continue;
      }
      const target = change.after;
      const source = () => noticeSource(unit, weatherSource(target), target.office);
      if (old.unavailable == null) {
        if (previous != null && old.active && gates.has(JSON.stringify([unit, change.operation, change.subject])))
          create(unit, change.operation, change.subject, "unavailable", source());
      } else if (old.unavailable !== next.unavailable) replaced.set(targetId, source());
    }
  // A reason-only change replaces the notice but keeps its original expiresAt.
  let notices = (previous?.notices ?? []).filter((item) => !invalidated.has(item.targetId)).map((item) =>
    replaced.has(item.targetId)
      ? notice(item.targetId, item.unit, item.operation, item.kind, replaced.get(item.targetId) ?? null, item.expiresAt)
      : item);
  if (clockValid) notices = notices.filter((item) => input.nowMs < item.expiresAt);
  const fresh = new Set(created.map((item) => item.targetId));
  notices = [...notices.filter((item) => !fresh.has(item.targetId)), ...created];
  const selected = selectNotices(notices);
  const diagnostics: DiagnosticDetails[] = selected.excluded === 0 ? [] : [{ level: "WARN", component: "view-projector",
    reason: "snapshotNoticeCapacityExceeded", count: selected.excluded }];
  const state = (snapshot: DisplaySnapshot | null): SnapshotProjectionState => ({
    streamId: input.streamId, snapshot, notices: selected.notices,
    domains: { eew: { ...eew.projection, eventRefs: eew.eventRefs },
      weatherCurrent: weatherCurrent.projection, weatherTimeseries: weatherTimeseries.projection },
  });
  const published = previous?.snapshot ?? null;
  if (!clockValid || expiryInvalid)
    return { kind: "rejected", state: state(published), reason: "snapshotClockInvalid", diagnostics };
  if (stringLimited(input)) return { kind: "rejected", state: state(published), reason: "snapshotStringLimitExceeded",
    diagnostics: [...diagnostics, { level: "WARN", component: "view-projector", reason: "snapshotStringLimitExceeded" }] };

  const domains = [eew.projection, weatherCurrent.projection, weatherTimeseries.projection] as const;
  const shell: DisplaySnapshot = {
    schemaVersion: 1, streamId: input.streamId, sequence: (published?.sequence ?? 0) + 1,
    generatedAt: input.generatedAt,
    semanticRevision: JSON.stringify(domains.map((item) => item.full.contentRevision)),
    connection: input.connection, worker: input.worker, persistence: input.persistence, recovery: input.recovery,
    channels: { desktop: channel(input.notificationChannels.desktop, input.channelProbeComplete),
      sound: channel(input.notificationChannels.sound, input.channelProbeComplete) },
    current: { eew: eew.projection.full, weatherCurrent: weatherCurrent.projection.full,
      weatherTimeseries: weatherTimeseries.projection.full },
    notices: selected.notices,
  };
  const shellBytes = utf8({ ...shell, current: { eew: 0, weatherCurrent: 0, weatherTimeseries: 0 } }) - 3;
  const commonBytes = shellBytes - utf8(selected.notices);
  if (commonBytes > COMMON_BUDGET) return { kind: "rejected", state: state(published), reason: "snapshotCommonBudgetExceeded",
    diagnostics: [...diagnostics, { level: "WARN", component: "view-projector", reason: "snapshotCommonBudgetExceeded", count: commonBytes }] };
  // RES-06: only when the complete total exceeds 1 MiB do over-budget domains become summaries.
  const overflow = shellBytes + domains.reduce((sum, item) => sum + item.utf8Bytes, 0) > SNAPSHOT_BYTES;
  const deliver = <View>(projection: DisplayDomainProjection<View>): DisplayDomainView<View> =>
    overflow && projection.utf8Bytes > DOMAIN_BUDGET ? summary(projection) : projection.full;
  const snapshot: DisplaySnapshot = { ...shell, current: { eew: deliver(eew.projection),
    weatherCurrent: deliver(weatherCurrent.projection), weatherTimeseries: deliver(weatherTimeseries.projection) } };
  const domainBytes = (value: DisplayDomainView<AnyView>, projection: DisplayDomainProjection<AnyView>) =>
    value.delivery === "full" ? projection.utf8Bytes : utf8(value);
  const utf8Bytes = shellBytes + domainBytes(snapshot.current.eew, eew.projection)
    + domainBytes(snapshot.current.weatherCurrent, weatherCurrent.projection)
    + domainBytes(snapshot.current.weatherTimeseries, weatherTimeseries.projection);
  if (published != null && comparable(published) === comparable(snapshot))
    return { kind: "unchanged", state: state(published), diagnostics };
  return { kind: "projected", state: state(snapshot), snapshot, utf8Bytes, diagnostics };
}

export { projectSnapshot };
