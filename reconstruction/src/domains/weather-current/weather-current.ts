import { isDeepStrictEqual } from "node:util";

import type { DecodedMaterial, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  FreshnessRecord,
  JsonValue,
  NotificationIntent,
  PersistenceStatus,
  ReportRef,
  RejectionReason,
  RuntimeUnitDeadline,
  SubjectOutcome,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  WeatherCurrentHistory,
  WeatherCurrentInput,
  WeatherCurrentSnapshot,
  WeatherCurrentTombstone,
  WeatherCurrentUnitState,
  WeatherCurrentUnitStep,
  WeatherCurrentUnavailableReason,
} from "../../../contracts/p2-weather-current-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

const WEATHER_FAMILIES = ["VPWS50", "VPWW55", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61", "VPNO50"] as const;
const WARNING_TYPES = [
  "気象警報・注意報（府県予報区等）",
  "気象警報・注意報（一次細分区域等）",
  "気象警報・注意報（市町村等をまとめた地域等）",
  "気象警報・注意報（市町村等）",
  "気象警報・注意報（高潮予報区間）",
] as const;
const VPNO_TYPE = "気象特別警報報知（府県予報区等）";
const STATUSES = new Set([
  "発表", "継続", "解除", "発表警報・注意報はなし", "警報から注意報",
  "特別警報から警報", "特別警報から注意報", "特別警報から危険警報",
]);

type WeatherFamily = typeof WEATHER_FAMILIES[number];
type Scope = WeatherCurrentSnapshot["scope"];
type ScopeTuple = readonly [WeatherFamily, Scope, string, string, string];

type Candidate = Readonly<{
  operation: Operation;
  family: WeatherFamily;
  subject: string;
  scope: Scope;
  office: string;
  reportDateTimeMs: number | null;
  source: ReportRef;
  cancelled: boolean;
  ignored: boolean;
  affectedScope: readonly string[];
  phenomena: Readonly<Record<string, JsonValue>>;
}>;

type CandidateResult =
  | Readonly<{ kind: "accepted"; candidate: Candidate }>
  | Readonly<{ kind: "rejected"; reason: RejectionReason; diagnostic: DiagnosticDetails; target: Candidate | null }>;

function elements(parent: XmlElement | null, name?: string): readonly XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || node.name === name));
}

function directText(element: XmlElement): string | null {
  const text = element.children.filter((node): node is Extract<XmlNode, { kind: "text" }> => node.kind === "text");
  return text.length === 0 ? null : text.map((node) => node.value).join("");
}

function scalar(element: XmlElement): string | null {
  return elements(element).length === 0 ? (directText(element) ?? "").trim() : null;
}

function attribute(element: XmlElement, name: string): readonly string[] {
  return element.attributes.filter((item) => item.name.toLowerCase() === name.toLowerCase()).map((item) => item.value.trim());
}

function diagnostic(material: DecodedMaterial, reason: RejectionReason): DiagnosticDetails {
  return { level: "WARN", component: "weather-current", reason, inputId: material.inputId, unit: "U-W" };
}

function family(value: string): WeatherFamily | null {
  return WEATHER_FAMILIES.find((candidate) => candidate === value) ?? null;
}

function scopeFor(value: WeatherFamily): Scope {
  return value === "VPWS50" ? "national" : "partial";
}

function scopeToken(tuple: ScopeTuple): string {
  return JSON.stringify(tuple);
}

function allScope(familyValue: WeatherFamily, scope: Scope, office: string): readonly string[] {
  return [scopeToken([familyValue, scope, office, "all", ""])];
}

function normalizeScopes(tokens: readonly string[]): readonly string[] {
  const tuples = tokens.map(parseScopeToken).filter((tuple): tuple is ScopeTuple => tuple != null);
  const all = tuples.find((tuple) => tuple[3] === "all");
  return [...new Set((all == null ? tuples : [all]).map(scopeToken))].sort();
}

function parseScopeToken(token: string): ScopeTuple | null {
  let parsed: unknown;
  try { parsed = JSON.parse(token); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 5 || !parsed.every((value) => typeof value === "string")) return null;
  const [familyValue, scope, office, areaType, areaCode] = parsed;
  const matched = family(familyValue);
  if (matched == null || (scope !== "national" && scope !== "partial") || scope !== scopeFor(matched)
    || office.trim() === "" || office !== office.trim()) return null;
  const allowedArea = areaType === "all" || matched === "VPNO50"
    ? areaType === "all" || areaType === VPNO_TYPE
    : (WARNING_TYPES as readonly string[]).includes(areaType);
  if (!allowedArea || (areaType === "all" ? areaCode !== "" : !/^\d+$/.test(areaCode))) return null;
  const tuple = [matched, scope, office, areaType, areaCode] as ScopeTuple;
  return scopeToken(tuple) === token ? tuple : null;
}

function validScopeSet(tokens: readonly string[]): boolean {
  if (tokens.length === 0 || tokens.some((token, index) => index > 0 && tokens[index - 1] >= token)) return false;
  const tuples = tokens.map(parseScopeToken);
  if (tuples.some((tuple) => tuple == null)) return false;
  const first = tuples[0]!;
  if (tuples.some((tuple) => tuple![0] !== first[0] || tuple![1] !== first[1] || tuple![2] !== first[2])) return false;
  return true;
}

function scopeContains(confirmed: readonly string[], affected: readonly string[]): boolean {
  const confirmation = confirmed.map(parseScopeToken).filter((value): value is ScopeTuple => value != null);
  return affected.map(parseScopeToken).every((target) => target != null && confirmation.some((value) =>
    value[0] === target[0] && value[1] === target[1] && value[2] === target[2]
    && (value[3] === "all" && value[4] === "" || value[3] === target[3] && value[4] === target[4])));
}

function sourceFor(material: DecodedMaterial, familyValue: WeatherFamily, subject: string): ReportRef {
  return {
    inputId: material.inputId, origin: material.origin, operation: material.operation,
    family: familyValue, subject, reportDateTimeRaw: material.reportDateTimeRaw,
    serialRaw: material.serialRaw, infoTypeRaw: material.infoTypeRaw,
  };
}

// AC01/06: one identity check serves both rejection priority and monitoring eligibility.
function inspectIdentity(material: DecodedMaterial) {
  const familyValue = family(material.headType);
  const controls = elements(material.xml, "Control");
  const offices = controls.flatMap((node) => elements(node, "EditorialOffice"));
  const heads = elements(material.xml, "Head");
  const bodies = elements(material.xml, "Body");
  const warnings = bodies.length === 1 ? elements(bodies[0], "Warning") : [];
  const headlines = heads.length === 1 ? elements(heads[0], "Headline") : [];
  const information = headlines.flatMap((node) => elements(node, "Information"))
    .filter((node) => attribute(node, "type")[0] === VPNO_TYPE);
  const items = (familyValue === "VPNO50" ? information : warnings).flatMap((node) => elements(node, "Item"));
  const areas = familyValue === "VPNO50"
    ? items.flatMap((item) => elements(item, "Areas").flatMap((node) => elements(node, "Area")))
    : items.flatMap((item) => elements(item, "Area").length === 1 ? elements(item, "Area") : []);
  let reason: RejectionReason | null = null;
  if (controls.length === 0 || controls.length === 1
    && (offices.length === 0 || offices.some((node) => scalar(node) === "")))
    reason = "identityMissing";
  else if (familyValue !== "VPNO50" && items.some((item) => elements(item, "Area").length === 0)
    || areas.some((area) => elements(area, "Code").length === 0
      || elements(area, "Code").some((code) => scalar(code) === "")))
    reason = "identityMissing";
  else if (controls.length !== 1 || offices.length !== 1 || scalar(offices[0]) == null)
    reason = "identityInvalid";
  else if (familyValue !== "VPNO50" && items.some((item) => elements(item, "Area").length !== 1)
    || areas.some((area) => elements(area, "Code").length !== 1
      || scalar(elements(area, "Code")[0]) == null || !/^\d+$/.test(scalar(elements(area, "Code")[0])!)))
    reason = "identityInvalid";
  return { familyValue, controls, offices, heads, bodies, warnings, headlines, information, items, areas,
    office: offices.length === 1 ? scalar(offices[0]) : null, reason };
}

function candidateTarget(material: DecodedMaterial): Candidate | null {
  const checked = inspectIdentity(material);
  const { familyValue, office } = checked;
  if (checked.reason != null || familyValue == null || office == null) return null;
  const scope = scopeFor(familyValue);
  const subject = `${material.operation}/${familyValue}/${office}`;
  const common = validateSemanticEnvelope(material);
  const tokens: string[] = [];
  if (familyValue === "VPNO50") {
    for (const area of checked.areas)
      tokens.push(scopeToken([familyValue, scope, office, VPNO_TYPE, scalar(elements(area, "Code")[0])!]));
  } else {
    for (const warning of checked.warnings) {
      const types = attribute(warning, "type");
      if (types.length !== 1 || !(WARNING_TYPES as readonly string[]).includes(types[0])) return null;
      for (const item of elements(warning, "Item"))
        tokens.push(scopeToken([familyValue, scope, office, types[0],
          scalar(elements(elements(item, "Area")[0], "Code")[0])!]));
    }
  }
  if (tokens.length === 0) return null;
  return { operation: material.operation, family: familyValue, subject, scope, office,
    reportDateTimeMs: common.kind === "accepted" ? common.envelope.reportDateTimeMs : null,
    source: sourceFor(material, familyValue, subject), cancelled: material.infoTypeRaw === "取消",
    ignored: false, affectedScope: scope === "national" ? allScope(familyValue, scope, office) : normalizeScopes(tokens),
    phenomena: {} };
}

function reject(material: DecodedMaterial, reason: RejectionReason, target = candidateTarget(material)): CandidateResult {
  return { kind: "rejected", reason, diagnostic: diagnostic(material, reason), target };
}

function validateMaterial(material: DecodedMaterial): CandidateResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { ...common, target: candidateTarget(material) };
  const checked = inspectIdentity(material);
  const { familyValue, office, heads, bodies, warnings, headlines, information, items } = checked;
  if (checked.reason != null) return reject(material, checked.reason, null);
  if (familyValue == null || office == null) return reject(material, "requiredStructureInvalid", null);
  const infoTypes = heads.length === 1 ? elements(heads[0], "InfoType") : [];
  if (heads.length === 1 && (infoTypes.length === 0 || infoTypes.some((node) => scalar(node) === "")))
    return reject(material, "requiredStructureMissing");
  if (heads.length !== 1 || infoTypes.length !== 1 || scalar(infoTypes[0]) == null
    || !["発表", "訂正", "取消"].includes(scalar(infoTypes[0])!))
    return reject(material, "requiredStructureInvalid");
  const cancelling = scalar(infoTypes[0]) === "取消";
  const scope = scopeFor(familyValue);
  const subject = `${material.operation}/${familyValue}/${office}`;
  const base = { operation: material.operation, family: familyValue, subject, scope, office,
    reportDateTimeMs: common.envelope.reportDateTimeMs, source: sourceFor(material, familyValue, subject),
    cancelled: cancelling, ignored: false, affectedScope: allScope(familyValue, scope, office), phenomena: {} };
  if (bodies.length === 0) return reject(material, "requiredStructureMissing");
  if (bodies.length !== 1) return reject(material, "requiredStructureInvalid");

  if (familyValue === "VPNO50") {
    if (cancelling) return { kind: "accepted", candidate: { ...base, ignored: true } };
    if (headlines.length === 0 || information.length === 0
      || information.some((node) => elements(node, "Item").length === 0)
      || items.some((item) => elements(item, "Kind").length === 0
        || elements(item, "Kind").some((kind) => elements(kind, "Code").length === 0
          || elements(kind, "Code").some((code) => scalar(code) === ""))
        || elements(item, "Areas").length === 0
        || elements(item, "Areas").some((areas) => elements(areas, "Area").length === 0)))
      return reject(material, "requiredStructureMissing");
    if (headlines.length !== 1 || information.some((node) => attribute(node, "type").length !== 1)
      || items.some((item) => elements(item, "Kind").length !== 1 || elements(item, "Areas").length !== 1
        || elements(item, "Kind").some((kind) => elements(kind, "Code").length !== 1
          || scalar(elements(kind, "Code")[0]) == null || !/^\d{2}$/.test(scalar(elements(kind, "Code")[0])!))))
      return reject(material, "requiredStructureInvalid");
    const terminating = items.filter((item) => scalar(elements(elements(item, "Kind")[0], "Code")[0]) === "00");
    if (terminating.length === 0) return { kind: "accepted", candidate: { ...base, ignored: true } };
    const affectedScope = normalizeScopes(terminating.flatMap((item) => elements(item, "Areas")
      .flatMap((areas) => elements(areas, "Area")).map((area) =>
        scopeToken([familyValue, scope, office, VPNO_TYPE, scalar(elements(area, "Code")[0])!]))));
    return { kind: "accepted", candidate: { ...base, affectedScope,
      phenomena: Object.fromEntries(affectedScope.map((token) => [token, { ended: true }])) } };
  }

  const kinds = items.flatMap((item) => elements(item, "Kind"));
  if (!cancelling && (warnings.length === 0 || warnings.some((warning) => elements(warning, "Item").length === 0))
    || warnings.some((warning) => elements(warning, "Item").length !== 0
      && (attribute(warning, "type").length === 0 || attribute(warning, "type")[0] === ""))
    || items.some((item) => elements(item, "Kind").length === 0)
    || kinds.some((kind) => elements(kind, "Status").length === 0
      || elements(kind, "Status").some((status) => scalar(status) === "")
      || elements(kind, "Status").length === 1 && scalar(elements(kind, "Status")[0]) != null
        && scalar(elements(kind, "Status")[0]) !== "発表警報・注意報はなし"
        && (elements(kind, "Code").length === 0 || elements(kind, "Code").some((code) => scalar(code) === ""))))
    return reject(material, "requiredStructureMissing");
  if (warnings.some((warning) => !(cancelling && elements(warning, "Item").length === 0
      && attribute(warning, "type").length === 0)
      && (attribute(warning, "type").length !== 1 || !(WARNING_TYPES as readonly string[]).includes(attribute(warning, "type")[0])))
    || kinds.some((kind) => elements(kind, "Status").length !== 1 || scalar(elements(kind, "Status")[0]) == null
      || !STATUSES.has(scalar(elements(kind, "Status")[0])!)
      || scalar(elements(kind, "Status")[0]) === "発表警報・注意報はなし" && elements(kind, "Code").length !== 0
      || scalar(elements(kind, "Status")[0]) !== "発表警報・注意報はなし"
        && (elements(kind, "Code").length !== 1 || scalar(elements(kind, "Code")[0]) == null
          || !/^\d{2}$/.test(scalar(elements(kind, "Code")[0])!))))
    return reject(material, "requiredStructureInvalid");

  const rows: Record<string, JsonValue> = {};
  for (const warning of warnings) for (const item of elements(warning, "Item")) {
    const token = scopeToken([familyValue, scope, office, attribute(warning, "type")[0],
      scalar(elements(elements(item, "Area")[0], "Code")[0])!]);
    rows[token] = elements(item, "Kind").map((kind) => {
      const names = elements(kind, "Name"), codes = elements(kind, "Code");
      return { status: scalar(elements(kind, "Status")[0])!,
        code: codes.length === 0 ? null : scalar(codes[0]),
        name: names.length === 1 ? scalar(names[0]) : null };
    });
  }
  return { kind: "accepted", candidate: { ...base, phenomena: rows,
    affectedScope: cancelling || scope === "national" ? base.affectedScope : normalizeScopes(Object.keys(rows)) } };
}

function nextWeatherCurrentDeadline(state: WeatherCurrentUnitState): RuntimeUnitDeadline | null {
  const pending = state.intents;
  return pending.length === 0 ? null
    : { wallTimeMs: Math.min(...pending.map((item) => item.expiresAt)), monotonicMs: null };
}

function dirty(persistence: PersistenceStatus, nowMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1,
    dirtySince: persistence.dirtySince ?? nowMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}

function snapshot(candidate: Candidate): WeatherCurrentSnapshot {
  return { subject: candidate.subject, operation: candidate.operation, scope: candidate.scope,
    office: candidate.office, source: candidate.source, phenomena: candidate.phenomena };
}

function currentFor(state: WeatherCurrentUnitState, candidate: Candidate): WeatherCurrentSnapshot | null {
  const current = candidate.scope === "national" ? state.national[candidate.operation]
    : state.partials.find((item) => item.subject === candidate.subject);
  return current?.subject === candidate.subject && current.office === candidate.office
    && current.source.family === candidate.family ? current : null;
}

// AC07/08: restored subjects are opaque; the stream fields own their identity.
function validateCandidate(material: DecodedMaterial, state: WeatherCurrentUnitState): CandidateResult {
  const result = validateMaterial(material);
  const candidate = result.kind === "accepted" ? result.candidate : result.target;
  if (candidate == null) return result;
  const snapshot = [...Object.values(state.national), ...state.partials,
    ...state.histories.flatMap((item) => item.reports)].find((item) =>
    item?.operation === candidate.operation && item.source.family === candidate.family
    && item.scope === candidate.scope && item.office === candidate.office);
  const record = [...state.unavailable, ...state.tombstones].find((item) => {
    const tuple = parseScopeToken(item.affectedScope[0]);
    return item.operation === candidate.operation && tuple?.[0] === candidate.family
      && tuple[1] === candidate.scope && tuple[2] === candidate.office;
  });
  const subject = snapshot?.subject ?? record?.subject ?? candidate.subject;
  if (subject === candidate.subject) return result;
  const bound = { ...candidate, subject, source: { ...candidate.source, subject } };
  return result.kind === "accepted" ? { ...result, candidate: bound } : { ...result, target: bound };
}

function historyFor(state: WeatherCurrentUnitState, subject: string, operation: Operation): WeatherCurrentHistory | null {
  return state.histories.find((item) => item.subject === subject && item.operation === operation) ?? null;
}

function latestSource(state: WeatherCurrentUnitState, candidate: Candidate): ReportRef | null {
  const sources = [currentFor(state, candidate)?.source,
    ...state.tombstones.filter((item) => item.subject === candidate.subject && item.operation === candidate.operation).map((item) => item.source),
    ...state.unavailable.filter((item) => item.subject === candidate.subject && item.operation === candidate.operation && item.source != null)
      .map((item) => item.source!)].filter((value): value is ReportRef => value != null);
  return sources.sort((left, right) => Date.parse(right.reportDateTimeRaw) - Date.parse(left.reportDateTimeRaw))[0] ?? null;
}

function outcome(candidate: Candidate, transition: string, source: ReportRef | null = candidate.source): SubjectOutcome {
  return { subject: candidate.subject, operation: candidate.operation,
    informationType: candidate.source.infoTypeRaw, transition, severity: null, source,
    facts: { family: candidate.family, scope: candidate.scope, office: candidate.office,
      affectedScope: candidate.affectedScope, phenomena: candidate.phenomena },
    changedFields: ["current", "histories", "ownership", "tombstones", "freshness", "unavailable"],
  };
}

function compareEntry(left: WeatherCurrentSnapshot, right: WeatherCurrentSnapshot): number {
  const time = Date.parse(left.source.reportDateTimeRaw) - Date.parse(right.source.reportDateTimeRaw);
  if (time !== 0) return time;
  const a = [left.operation, left.subject, left.source.inputId];
  const b = [right.operation, right.subject, right.source.inputId];
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function freshnessKey(record: FreshnessRecord): string {
  return `${record.target.operation}\u0000${record.target.family}\u0000${record.target.subject}\u0000${record.target.affectedScope.join("\u0000")}`;
}

function monitor(state: WeatherCurrentUnitState, candidate: Candidate, decision: string, reason: string,
  revisionOrder: FreshnessRecord["revisionOrder"], clockMs: number): WeatherCurrentUnitState {
  const previous = state.freshness.find((record) => record.target.operation === candidate.operation
    && record.target.family === candidate.family && record.target.subject === candidate.subject
    && isDeepStrictEqual(record.target.affectedScope, candidate.affectedScope));
  const current = currentFor(state, candidate);
  const record: FreshnessRecord = {
    target: { operation: candidate.operation, family: candidate.family, subject: candidate.subject,
      affectedScope: candidate.affectedScope },
    candidateSource: candidate.source, currentSource: current?.source ?? null,
    currentSemanticRevision: current == null ? null : `${current.source.reportDateTimeRaw}/${current.source.serialRaw}`,
    decision, reason, revisionOrder,
    freshnessSuspect: revisionOrder === "newer" || previous?.freshnessSuspect === true,
    suspectedSource: revisionOrder === "newer" ? candidate.source : previous?.suspectedSource ?? null,
    confirmedScope: previous?.confirmedScope ?? [],
    clearCondition: "sameTargetScopeAcceptedOrCoverageConfirmed",
  };
  if (previous != null && isDeepStrictEqual(previous, record)) return state;
  const key = freshnessKey(record);
  const freshness = [...state.freshness.filter((item) => freshnessKey(item) !== key), record];
  return { ...state, freshness, persistence: dirty(state.persistence, clockMs) };
}

function clearMonitoring(state: WeatherCurrentUnitState, candidate: Candidate): WeatherCurrentUnitState {
  const freshness = state.freshness.filter((record) => !(record.target.operation === candidate.operation
    && record.target.family === candidate.family && record.target.subject === candidate.subject
    && scopeContains(candidate.affectedScope, record.target.affectedScope)));
  const unavailable = state.unavailable.filter((record) => !(record.operation === candidate.operation
    && record.subject === candidate.subject && scopeContains(candidate.affectedScope, record.affectedScope)));
  return freshness.length === state.freshness.length && unavailable.length === state.unavailable.length
    ? state : { ...state, freshness, unavailable };
}

function historyWith(state: WeatherCurrentUnitState, history: WeatherCurrentHistory | null,
  reports: readonly WeatherCurrentSnapshot[]): readonly WeatherCurrentHistory[] {
  const rest = state.histories.filter((item) => item !== history);
  return reports.length === 0 ? rest : [...rest, { subject: history?.subject ?? reports[0].subject,
    operation: history?.operation ?? reports[0].operation, reports }];
}

function removeSubjects(state: WeatherCurrentUnitState, subjects: ReadonlySet<string>, operation: Operation): WeatherCurrentUnitState {
  if (subjects.size === 0) return state;
  const national = { ...state.national };
  if (national[operation] != null && subjects.has(national[operation]!.subject)) delete national[operation];
  return { ...state, national, partials: state.partials.filter((item) => item.operation !== operation || !subjects.has(item.subject)),
    histories: state.histories.filter((item) => item.operation !== operation || !subjects.has(item.subject)),
    ownership: Object.fromEntries(Object.entries(state.ownership)
      .filter(([key, subject]) => !key.startsWith(`${operation}\u0000`) || !subjects.has(subject))),
    intents: state.intents.filter((item) => item.operation !== operation || !subjects.has(item.subject)) };
}

function addUnavailable(state: WeatherCurrentUnitState, candidate: Candidate, reason: WeatherCurrentUnavailableReason,
  lastKnown: WeatherCurrentSnapshot | null, clockMs: number): WeatherCurrentUnitStep {
  const national = { ...state.national };
  if (candidate.scope === "national" && national[candidate.operation]?.subject === candidate.subject)
    delete national[candidate.operation];
  let next = candidate.scope === "national"
    ? { ...state, national }
    : { ...state, partials: state.partials.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation) };
  const tombstone: WeatherCurrentTombstone = { subject: candidate.subject, operation: candidate.operation,
    source: candidate.source, affectedScope: candidate.affectedScope };
  next = { ...next,
    tombstones: [...next.tombstones.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation), tombstone],
    unavailable: [...next.unavailable.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation),
      { subject: candidate.subject, operation: candidate.operation, reason, source: candidate.source,
        lastKnown, affectedScope: candidate.affectedScope }],
  };
  next = { ...next,
    ownership: Object.fromEntries(Object.entries(next.ownership)
      .filter(([key, subject]) => subject !== candidate.subject || !key.startsWith(`${candidate.operation}\u0000`))),
    intents: next.intents.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation) };
  next = { ...next, persistence: dirty(state.persistence, clockMs) };
  return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
    decisions: [{ subject: candidate.subject, operation: candidate.operation,
      decision: "changed", reason: null, change: "semantic", currentEstablished: null }], intents: [],
    outcomes: [{ kind: "accepted", change: "semantic", subjects: [outcome(candidate, "unavailable")] }], diagnostics: [] };
}

function owned(snapshotValue: WeatherCurrentSnapshot): readonly string[] {
  const result: string[] = [];
  for (const [token, value] of Object.entries(snapshotValue.phenomena)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) if (row != null && typeof row === "object" && !Array.isArray(row)) {
      const status = row.status;
      const code = row.code;
      if (typeof code === "string" && code !== "00" && status !== "解除" && status !== "発表警報・注意報はなし")
        result.push(`${snapshotValue.operation}\u0000${token}\u0000${code}`);
    }
  }
  return result;
}

function applyEnding(state: WeatherCurrentUnitState, candidate: Candidate): WeatherCurrentUnitState {
  const codes = new Set(candidate.affectedScope.map(parseScopeToken).filter((value): value is ScopeTuple => value != null).map((value) => value[4]));
  const ended = (snapshotValue: WeatherCurrentSnapshot): WeatherCurrentSnapshot => {
    if (snapshotValue.operation !== candidate.operation || Date.parse(snapshotValue.source.reportDateTimeRaw) > candidate.reportDateTimeMs!)
      return snapshotValue;
    const phenomena = Object.fromEntries(Object.entries(snapshotValue.phenomena).map(([token, value]) => {
      const tuple = parseScopeToken(token);
      const matches = tuple != null && [...codes].some((code) => tuple[4] === code || code.endsWith("0000") && tuple[4].startsWith(code.slice(0, 2)));
      if (!matches || !Array.isArray(value)) return [token, value];
      return [token, value.filter((row) => !(row != null && typeof row === "object" && !Array.isArray(row)
        && typeof row.code === "string" && /^3\d$/.test(row.code)))];
    }));
    return isDeepStrictEqual(phenomena, snapshotValue.phenomena) ? snapshotValue : { ...snapshotValue, phenomena };
  };
  const national = Object.fromEntries(Object.entries(state.national).map(([operation, value]) => [operation, ended(value!)]));
  const partials = state.partials.map(ended);
  const changedSubjects = new Set([
    ...Object.values(state.national).filter((value): value is WeatherCurrentSnapshot =>
      value != null && national[value.operation] !== value),
    ...state.partials.filter((value, index) => partials[index] !== value),
  ].map((value) => value.subject));
  return { ...state, national, partials,
    intents: state.intents.filter((item) => item.operation !== candidate.operation || !changedSubjects.has(item.subject)),
    histories: state.histories.map((history) => ({ ...history, reports: history.reports.map(ended) })),
    ownership: Object.fromEntries([
      ...Object.values(national).filter((value): value is WeatherCurrentSnapshot => value != null), ...partials,
    ].flatMap((value) => owned(value).map((key) => [key, value.subject]))),
  };
}

function maskSnapshotWithTombstones(state: WeatherCurrentUnitState,
  snapshotValue: WeatherCurrentSnapshot): WeatherCurrentSnapshot {
  let wrapper: WeatherCurrentUnitState = snapshotValue.scope === "national"
    ? { ...state, national: { [snapshotValue.operation]: snapshotValue } }
    : { ...state, national: {}, partials: [snapshotValue] };
  for (const tombstone of state.tombstones) {
    if (tombstone.operation !== snapshotValue.operation || tombstone.source.family !== "VPNO50"
      || Date.parse(tombstone.source.reportDateTimeRaw) < Date.parse(snapshotValue.source.reportDateTimeRaw)) continue;
    const target: Candidate = {
      operation: tombstone.operation, family: "VPNO50", subject: tombstone.subject, scope: "partial",
      office: parseScopeToken(tombstone.affectedScope[0])?.[2] ?? "", reportDateTimeMs: Date.parse(tombstone.source.reportDateTimeRaw),
      source: tombstone.source, cancelled: false, ignored: false,
      affectedScope: tombstone.affectedScope, phenomena: {},
    };
    wrapper = applyEnding(wrapper, target);
  }
  return snapshotValue.scope === "national"
    ? wrapper.national[snapshotValue.operation] ?? snapshotValue
    : wrapper.partials[0] ?? snapshotValue;
}

function reduceWeatherCurrentMeaning(state: WeatherCurrentUnitState,
  input: Extract<WeatherCurrentInput, { kind: "receive" }>): WeatherCurrentUnitStep {
  const validated = validateCandidate(input.material, state);
  if (validated.kind === "rejected") {
    let next = state;
    if (validated.target != null) {
      const latest = latestSource(state, validated.target);
      const order = latest == null || validated.target.reportDateTimeMs == null ? "unknown" : validated.target.reportDateTimeMs > Date.parse(latest.reportDateTimeRaw) ? "newer"
        : validated.target.reportDateTimeMs < Date.parse(latest.reportDateTimeRaw) ? "older" : "same";
      next = monitor(state, validated.target, "rejected", validated.reason, order, input.clock.monotonicMs);
    }
    return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
      decisions: [{ subject: validated.target?.subject ?? "", operation: input.material.operation,
        decision: "rejected", reason: validated.reason }], intents: [], outcomes: [], diagnostics: [validated.diagnostic] };
  }
  const candidate = validated.candidate;
  if (candidate.ignored) return { state, nextDeadline: nextWeatherCurrentDeadline(state),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "noChange" }],
    intents: [], outcomes: [], diagnostics: [] };
  const previous = currentFor(state, candidate);
  const latest = latestSource(state, candidate);
  if (latest != null) {
    const latestMs = Date.parse(latest.reportDateTimeRaw);
    if (candidate.reportDateTimeMs! < latestMs) {
      const next = monitor(state, candidate, "unchanged", "stale", "older", input.clock.monotonicMs);
      return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
        decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "stale" }],
        intents: [], outcomes: [], diagnostics: [] };
    }
    if (candidate.reportDateTimeMs === latestMs) {
      const duplicate = previous != null && previous.source.infoTypeRaw === candidate.source.infoTypeRaw
        && previous.source.serialRaw === candidate.source.serialRaw
        && isDeepStrictEqual(previous.phenomena, candidate.phenomena);
      if (duplicate) return { state, nextDeadline: nextWeatherCurrentDeadline(state),
        decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "duplicate" }],
        intents: [], outcomes: [], diagnostics: [] };
      const next = monitor(state, candidate, "unchanged", "stale", "unknown", input.clock.monotonicMs);
      return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
        decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "unchanged", reason: "stale" }],
        intents: [], outcomes: [], diagnostics: [] };
    }
  }

  if (candidate.family === "VPNO50") {
    let next = applyEnding(state, candidate);
    const tombstone: WeatherCurrentTombstone = { subject: candidate.subject, operation: candidate.operation,
      source: candidate.source, affectedScope: candidate.affectedScope };
    next = { ...next,
      tombstones: [...next.tombstones.filter((item) => !(item.subject === candidate.subject
        && item.operation === candidate.operation && scopeContains(candidate.affectedScope, item.affectedScope))), tombstone],
    };
    next = clearMonitoring(next, candidate);
    next = { ...next, persistence: dirty(state.persistence, input.clock.monotonicMs) };
    return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
      decisions: [{ subject: candidate.subject, operation: candidate.operation,
        decision: "changed", reason: null, change: "semantic", currentEstablished: {
          family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs!, affectedScope: candidate.affectedScope,
        } }], intents: [],
      outcomes: [{ kind: "accepted", change: "semantic", subjects: [outcome(candidate, "released")] }], diagnostics: [] };
  }

  const history = historyFor(state, candidate.subject, candidate.operation);
  if (candidate.cancelled) {
    const reports = history?.reports ?? [];
    if (previous == null || reports.length === 0)
      return addUnavailable(state, candidate, "historyUnavailable", previous, input.clock.monotonicMs);
    const restored = reports[reports.length - 1];
    let next: WeatherCurrentUnitState = candidate.scope === "national"
      ? { ...state, national: { ...state.national, [candidate.operation]: restored } }
      : { ...state, partials: [...state.partials.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation), restored] };
    next = { ...next, histories: historyWith(next, history, reports.slice(0, -1)),
      tombstones: [...next.tombstones.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation),
        { subject: candidate.subject, operation: candidate.operation, source: candidate.source, affectedScope: candidate.affectedScope }] };
    const masked = maskSnapshotWithTombstones(next, restored);
    next = candidate.scope === "national"
      ? { ...next, national: { ...next.national, [candidate.operation]: masked } }
      : { ...next, partials: [...next.partials.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation), masked] };
    const ownership = Object.fromEntries(Object.entries(next.ownership)
      .filter(([key, subject]) => subject !== candidate.subject || !key.startsWith(`${candidate.operation}\u0000`)));
    for (const key of owned(masked)) ownership[key] = candidate.subject;
    next = { ...next, ownership, intents: next.intents.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation),
      persistence: dirty(state.persistence, input.clock.monotonicMs) };
    return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
      decisions: [{ subject: candidate.subject, operation: candidate.operation,
        decision: "changed", reason: null, change: "semantic", currentEstablished: null }], intents: [],
      outcomes: [{ kind: "accepted", change: "semantic",
        subjects: [outcome({ ...candidate, phenomena: masked.phenomena }, "cancelled", masked.source)] }], diagnostics: [] };
  }

  let working = state;
  let diagnostics: DiagnosticDetails[] = [];
  if (candidate.scope === "partial" && previous == null && state.partials.length >= 128) {
    const eligible = [...state.partials].filter((item) => item.operation !== "normal").sort(compareEntry);
    if (eligible.length === 0) return addUnavailable(state, candidate, "capacityExceeded", null, input.clock.monotonicMs);
    working = removeSubjects(state, new Set([eligible[0].subject]), eligible[0].operation);
    diagnostics.push({ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
  }

  const current = currentFor(working, candidate);
  if (current != null) {
    const nationalCount = working.histories.flatMap((item) => item.reports).filter((item) => item.scope === "national").length;
    const partialCount = working.histories.flatMap((item) => item.reports)
      .filter((item) => item.scope === "partial" && item.office === candidate.office && item.source.family === candidate.family).length;
    const limit = candidate.scope === "national" ? 2 : 8;
    const count = candidate.scope === "national" ? nationalCount : partialCount;
    if (count >= limit) {
      const eligible = working.histories.flatMap((item) => item.reports)
        .filter((item) => item.operation !== "normal" && item.scope === candidate.scope
          && (candidate.scope === "national" || item.office === candidate.office && item.source.family === candidate.family))
        .sort(compareEntry);
      if (eligible.length === 0) return addUnavailable(state, candidate, "capacityExceeded", previous, input.clock.monotonicMs);
      const evicted = eligible[0];
      working = { ...working, histories: working.histories.flatMap((item) => {
        const reports = item.reports.filter((report) => report !== evicted);
        return reports.length === 0 ? [] : [{ ...item, reports }];
      }) };
      diagnostics.push({ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    }
  }

  const projected = maskSnapshotWithTombstones(working, snapshot(candidate));
  let next: WeatherCurrentUnitState = candidate.scope === "national"
    ? { ...working, national: { ...working.national, [candidate.operation]: projected } }
    : { ...working, partials: [...working.partials.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation), projected] };
  if (current != null) {
    const activeHistory = historyFor(next, candidate.subject, candidate.operation);
    next = { ...next, histories: historyWith(next, activeHistory, [...(activeHistory?.reports ?? []), current]) };
  }
  const ownership = Object.fromEntries(Object.entries(next.ownership)
    .filter(([key, subject]) => subject !== candidate.subject || !key.startsWith(`${candidate.operation}\u0000`)));
  for (const key of owned(projected)) ownership[key] = candidate.subject;
  next = { ...next, ownership, intents: next.intents.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation),
    tombstones: next.tombstones.filter((item) => item.subject !== candidate.subject || item.operation !== candidate.operation),
  };
  next = clearMonitoring(next, candidate);
  next = { ...next, persistence: dirty(state.persistence, input.clock.monotonicMs) };
  const semantic = previous == null || !isDeepStrictEqual(previous.phenomena, projected.phenomena);
  const change = semantic ? "semantic" as const : "revisionOnly" as const;
  return { state: next, nextDeadline: nextWeatherCurrentDeadline(next),
    decisions: [{ subject: candidate.subject, operation: candidate.operation, decision: "changed", reason: null, change,
      currentEstablished: { family: candidate.family, reportDateTimeMs: candidate.reportDateTimeMs!, affectedScope: candidate.affectedScope } }],
    intents: [], outcomes: [{ kind: "accepted", change,
      subjects: [outcome({ ...candidate, phenomena: projected.phenomena }, previous == null ? "activated" : "updated")] }], diagnostics };
}

function expireIntents(state: WeatherCurrentUnitState, wallTimeMs: number, monotonicMs: number): Readonly<{
  state: WeatherCurrentUnitState;
  expired: readonly NotificationIntent[];
}> {
  const expired = state.intents.filter((item) => item.expiresAt <= wallTimeMs);
  if (expired.length === 0) return { state, expired };
  const ids = new Set(expired.map((item) => item.id));
  return { expired, state: { ...state, intents: state.intents.filter((item) => !ids.has(item.id)),
    persistence: dirty(state.persistence, monotonicMs) } };
}

export {
  WEATHER_FAMILIES,
  WARNING_TYPES,
  VPNO_TYPE,
  dirty,
  expireIntents,
  nextWeatherCurrentDeadline,
  normalizeScopes,
  parseScopeToken,
  addUnavailable as capacityUnavailable,
  reduceWeatherCurrentMeaning,
  scopeContains,
  validateCandidate as validateWeatherCandidate,
  validScopeSet,
};
export type { Candidate, ScopeTuple, WeatherFamily };
