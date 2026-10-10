import type { DecodedMaterial, Operation, ParserMailboxResult } from "../../contracts/p1-parser-boundary.types";
import type { UnitJob, UnitTable } from "../../contracts/p3-unit-table.types";
import type { ExecutionPlace, OwnerOutput } from "../../contracts/p3-execution-split.types";
import type {
  AdmissionRejection,
  CheckpointCapture,
  CheckpointResult,
  ClockReading,
  CurrentConfirmationEvidence,
  DiagnosticDetails,
  DiagnosticEvent,
  NotificationIntentUpdate,
  PersistenceStatus,
  RejectionReason,
  RestoreUnitResult,
  RuntimeAdmission,
  RuntimeDisplayChange,
  RuntimePublishedOutcome,
  RuntimeRestoration,
  RuntimeState,
  RuntimeUnitDeadline,
  RuntimeUnitId,
  RuntimeUnitInputs,
  RuntimeUnitStates,
  RuntimeUnitSteps,
  RuntimeUnitView,
  RuntimeViews,
  SemanticEnvelopeResult,
} from "../../contracts/p2-shared-runtime.types";
import type { CodecMap } from "../checkpoint/checkpoint";
import { normalizeScopes, scopeContains } from "../domains/weather-current/weather-current";
import { boundDiagnosticDetails, boundedString, completeDiagnostic, parserDiagnosticReasons } from "./runtime-diagnostic";
import { classifyHeadType, executionPlaces, runtimeUnits } from "./unit-coverage";

// P3-EXECUTION-SPLIT-001 (C3a) owner core: everything one owner does to its own units, as pure functions of
// the owner state. The owner thread and the test path (1) call these; nothing here touches another place's units.

const EMPTY: readonly never[] = Object.freeze([]);
const operations = ["normal", "training", "test"] as const;
const admissionRecordByteCache = new WeakMap<object, number>();

type OwnerState = Readonly<{
  runId: string;
  place: ExecutionPlace;
  units: Readonly<Partial<RuntimeUnitStates>>;
  admission: RuntimeAdmission;
  deadlines: Readonly<Partial<Record<RuntimeUnitId, RuntimeUnitDeadline | null>>>;
  checkpointAttempts: RuntimeState["checkpointAttempts"];
  // false once the shutdown input was applied: a later parser input is not applied (P2-WIRE-T04).
  accepting: boolean;
  // true once finalized: no deadline and no input is applied (spec §5.9 step 4).
  finalized: boolean;
}>;

type OwnerStep = Readonly<{
  state: OwnerState;
  changedUnits: readonly RuntimeUnitId[];
  // Present [] certifies only this step's generation change (P2-A3-AC10).
  generationInputIds: Readonly<Partial<Record<RuntimeUnitId, readonly string[]>>>;
  views: readonly RuntimeUnitView[];
  outcomes: readonly RuntimePublishedOutcome[];
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  retiredEvents: OwnerOutput["retiredEvents"];
  diagnostics: readonly DiagnosticEvent[];
}>;

type ParserCompletion = Readonly<{ runId: string; inputId: string; result: ParserMailboxResult }>;
type UnitInput = Extract<RuntimeUnitInputs[RuntimeUnitId], { kind: "receive" | "deadline" | "shutdown" | "intentUpdate" }>;

const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const noHistory = { dayKey: null, count: 0, maxInt: null, countedEventIds: [], recent: [] } as const;
const initialUnits: RuntimeUnitStates = {
  "U-E": { schemaVersion: "p2-eew-unit-v1", contentRevision: 0, current: [], gates: [], intents: [], deliveryRecords: [], notificationLatches: [], persistence: cleanPersistence },
  "U-W": { schemaVersion: "p2-weather-current-unit-v1", contentRevision: 0, national: {}, partials: [], histories: [], ownership: {},
    tombstones: [], freshness: [], unavailable: [], intents: [], persistence: cleanPersistence },
  "U-F": { schemaVersion: "p2-weather-timeseries-unit-v1", contentRevision: 0, subjects: [], gates: [], intents: [], persistence: cleanPersistence },
  "U-T": { schemaVersion: "p3-tsunami-unit-v1", contentRevision: 0, forecasts: [], observations: [], intents: [], persistence: cleanPersistence },
  "U-Q": { schemaVersion: "p3-seismic-unit-v1", contentRevision: 0, earthquakes: [], longPeriods: [],
    daily: { normal: noHistory, training: noHistory, test: noHistory }, intents: [], persistence: cleanPersistence },
  "U-N": { schemaVersion: "p3-nankai-unit-v1", contentRevision: 0, currents: [], information: [], intents: [], persistence: cleanPersistence },
  "U-V": { schemaVersion: "p3-volcano-unit-v1", contentRevision: 0, alerts: [], eruptions: [], ashfalls: [], shortfalls: [],
    scheduledAshfalls: [], batch: null, bulletins: [], intents: [], persistence: cleanPersistence },
  "U-L": { schemaVersion: "p3-landslide-unit-v1", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
  "U-R": { schemaVersion: "p3-flood-unit-v1", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
};

const placeUnits = (place: ExecutionPlace): readonly RuntimeUnitId[] =>
  runtimeUnits.filter((unit) => executionPlaces[unit] === place);

function rejection(material: DecodedMaterial, reason: RejectionReason): SemanticEnvelopeResult {
  return {
    kind: "rejected",
    reason,
    diagnostic: boundDiagnosticDetails({ level: "WARN", component: "shared-runtime", reason, inputId: material.inputId }),
  };
}

function reportDateTime(raw: string): number | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (match == null) return null;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) return null;
  const offsetMinutes = match[7] === "Z" ? 0 : (match[8] === "+" ? 1 : -1) * (Number(match[9]) * 60 + Number(match[10]));
  const local = new Date(value + offsetMinutes * 60_000);
  const actual = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  return actual.every((part, index) => part === Number(match[index + 1])) ? value : null;
}

function validateSemanticEnvelope(material: DecodedMaterial): SemanticEnvelopeResult {
  if (!material.xml.children.some((node) => node.kind === "element" && node.name === "Head")) {
    return rejection(material, "headMissing");
  }
  if (material.reportDateTimeRaw.trim() === "") return rejection(material, "reportDateTimeMissing");
  const reportDateTimeMs = reportDateTime(material.reportDateTimeRaw);
  if (reportDateTimeMs == null) return rejection(material, "reportDateTimeInvalid");
  return { kind: "accepted", envelope: { material, reportDateTimeMs } };
}

function parserDiagnostic(reason: string, inputId: string): DiagnosticDetails | null {
  const matched = parserDiagnosticReasons.find((candidate) => candidate === reason);
  if (matched == null) return null;
  return boundDiagnosticDetails({ level: "WARN", component: "parser", reason: matched, inputId });
}

function ownUnit<K extends RuntimeUnitId>(state: OwnerState, unit: K): RuntimeUnitStates[K] {
  const value: RuntimeUnitStates[K] | undefined = state.units[unit];
  if (value == null) throw new Error(`unit ${unit} is not owned by ${state.place}`);
  return value;
}

// Pairs a unit with its own state and the input: each case narrows all three together (P3-C0-NO-AS-FORM 1).
function unitJob(state: OwnerState, unit: RuntimeUnitId, input: UnitInput): UnitJob {
  switch (unit) {
    case "U-E": return { unit, state: ownUnit(state, unit), input };
    case "U-W": return { unit, state: ownUnit(state, unit), input };
    case "U-F": return { unit, state: ownUnit(state, unit), input };
    case "U-T": return { unit, state: ownUnit(state, unit), input };
    case "U-Q": return { unit, state: ownUnit(state, unit), input };
    case "U-N": return { unit, state: ownUnit(state, unit), input };
    case "U-V": return { unit, state: ownUnit(state, unit), input };
    case "U-L": return { unit, state: ownUnit(state, unit), input };
    case "U-R": return { unit, state: ownUnit(state, unit), input };
    default: { const missing: never = unit; throw new Error(`unit ${String(missing)} has no job`); }
  }
}

// The one place a unit reducer is called: the job's unit, state and input cannot come from different units.
function runUnitJob(units: UnitTable, job: UnitJob): RuntimeUnitSteps[RuntimeUnitId] {
  switch (job.unit) {
    case "U-E": return units[job.unit].reduce(job.state, job.input);
    case "U-W": return units[job.unit].reduce(job.state, job.input);
    case "U-F": return units[job.unit].reduce(job.state, job.input);
    case "U-T": return units[job.unit].reduce(job.state, job.input);
    case "U-Q": return units[job.unit].reduce(job.state, job.input);
    case "U-N": return units[job.unit].reduce(job.state, job.input);
    case "U-V": return units[job.unit].reduce(job.state, job.input);
    case "U-L": return units[job.unit].reduce(job.state, job.input);
    case "U-R": return units[job.unit].reduce(job.state, job.input);
    default: { const missing: never = job; throw new Error(`unit job ${String(missing)} is not handled`); }
  }
}

function unitAdmissionCounts(admission: RuntimeAdmission, unit: RuntimeUnitId): Readonly<Record<Operation, number>> {
  const count = (operation: Operation) => {
    const slot = admission[unit]?.[operation];
    return (slot?.records.length ?? 0) + (slot?.overflow ? 1 : 0);
  };
  return { normal: count("normal"), training: count("training"), test: count("test") };
}

function updateAdmission(admission: RuntimeAdmission, unit: RuntimeUnitId,
  decisions: RuntimeUnitSteps[RuntimeUnitId]["decisions"]): RuntimeAdmission {
  let next = admission;
  for (const decision of [...decisions.filter((item) => item.decision === "capacityExceeded"),
    ...decisions.filter((item) => item.decision !== "capacityExceeded")]) {
    if (decision.decision !== "capacityExceeded" && (decision.decision !== "changed" || decision.currentEstablished == null)) continue;
    const operation = decision.operation;
    if (decision.decision === "changed" && next[unit]?.[operation] == null) continue;
    const slot = next[unit]?.[operation] ?? { records: [], overflow: false };
    let records = [...slot.records];
    let overflow = slot.overflow;
    if (decision.decision === "capacityExceeded") {
      const { rejection } = decision;
      const index = records.findIndex((item) => item.family === rejection.family && item.subject === decision.subject);
      const existing = records[index];
      const scope = existing?.affectedScope === "subject" || rejection.affectedScope === "subject" ? "subject" as const
        : existing == null ? rejection.affectedScope : normalizeScopes([...existing.affectedScope, ...rejection.affectedScope]);
      const candidate: AdmissionRejection = { subject: decision.subject, family: rejection.family,
        reportDateTimeMs: Math.max(existing?.reportDateTimeMs ?? -Infinity, rejection.reportDateTimeMs), affectedScope: scope };
      const proposed = index < 0 ? [...records, candidate] : records.map((item, at) => at === index ? candidate : item);
      const bytes = proposed.reduce((sum, record) => {
        let size = admissionRecordByteCache.get(record);
        if (size == null) {
          size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
          admissionRecordByteCache.set(record, size);
        }
        return sum + size;
      }, 2 + Math.max(proposed.length - 1, 0));
      if (proposed.length > 512 || bytes > 262_144) overflow = true;
      else records = proposed;
    } else {
      const evidence = decision.currentEstablished!;
      records = records.flatMap((record) => {
        if (record.family !== evidence.family || record.subject !== decision.subject
          || !(evidence.reportDateTimeMs > record.reportDateTimeMs)) return [record];
        if (record.affectedScope === "subject") return evidence.affectedScope === "subject" ? [] : [record];
        if (evidence.affectedScope === "subject") return [];
        const remaining = record.affectedScope.filter((token) => !scopeContains(evidence.affectedScope as readonly string[], [token]));
        return remaining.length === 0 ? [] : [{ ...record, affectedScope: remaining }];
      });
    }
    const byOperation = { ...next[unit] };
    if (records.length === 0 && !overflow) delete byOperation[operation];
    else byOperation[operation] = { records, overflow };
    next = { ...next, [unit]: byOperation };
  }
  return next;
}

function viewBits(admission: RuntimeAdmission, unit: RuntimeUnitId): number {
  return (admission[unit]?.normal == null ? 0 : 1)
    | (admission[unit]?.training == null ? 0 : 2)
    | (admission[unit]?.test == null ? 0 : 4);
}

// The admission-adjusted public view of one unit (never the unit state).
function projectView<K extends RuntimeUnitId>(state: OwnerState, units: UnitTable, unit: K): RuntimeViews[K] {
  const admission = Object.fromEntries(operations.filter((operation) => state.admission[unit]?.[operation] != null)
    .map((operation) => [operation, "capacityExceeded" as const]));
  const normalBlocked = state.admission[unit]?.normal != null;
  const module = units[unit];
  const source = ownUnit(state, unit);
  const base = module.toView(normalBlocked ? module.withoutNormal(source) : source);
  return { ...base, admission,
    subjects: normalBlocked ? base.subjects.filter((item) => item.operation !== "normal" || module.keepsWhileNormalHidden(item)) : base.subjects,
    contentRevision: `${source.contentRevision}:${viewBits(state.admission, unit)}` };
}

function normalSubjects<K extends RuntimeUnitId>(units: UnitTable, unit: K, state: RuntimeUnitStates[K]) {
  return units[unit].normalDisplaySubjects(state);
}

// One owner request: its reducer calls, then the changes it must report, in the order they happened.
function session(start: OwnerState, units: UnitTable, clock: ClockReading | null) {
  let next = start;
  const changedUnits: RuntimeUnitId[] = [];
  const generationInputIds: Partial<Record<RuntimeUnitId, readonly string[]>> = {};
  const outcomes: RuntimePublishedOutcome[] = [];
  const displayChanges: RuntimeDisplayChange[] = [];
  const confirmationEvidence: CurrentConfirmationEvidence[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const viewUnits = new Set<RuntimeUnitId>();
  const changed = (unit: RuntimeUnitId) => { if (!changedUnits.includes(unit)) changedUnits.push(unit); };
  const diagnose = (details: DiagnosticDetails) => {
    if (clock == null) throw new Error("diagnostic requires an explicit clock");
    diagnostics.push(completeDiagnostic(details, clock, start.runId));
  };
  const reduceUnit = (unit: RuntimeUnitId, unitInput: UnitInput) => {
    const step = runUnitJob(units, unitJob(next, unit, unitInput));
    const previous = ownUnit(next, unit);
    if (step.state.persistence.currentGeneration > previous.persistence.currentGeneration)
      generationInputIds[unit] ??= [];
    if (step.state !== previous) {
      const attempt = next.checkpointAttempts[unit];
      // The first changed durable generation after capture defines the next dirty interval.
      if (attempt != null && attempt.postCaptureDirtySince == null
        && step.state.persistence.currentGeneration > previous.persistence.currentGeneration
        && step.state.persistence.currentGeneration > attempt.generation) {
        next = { ...next, checkpointAttempts: { ...next.checkpointAttempts,
          [unit]: { ...attempt, postCaptureDirtySince: unitInput.clock.monotonicMs } } };
      }
      next = { ...next, units: { ...next.units, [unit]: step.state } };
      changed(unit);
    }
    const admission = updateAdmission(next.admission, unit, step.decisions);
    if (admission !== next.admission) {
      if (viewBits(next.admission, unit) !== viewBits(admission, unit)) viewUnits.add(unit);
      next = { ...next, admission };
      changed(unit);
    }
    const deadline = step.nextDeadline;
    if (deadline != null && (deadline.wallTimeMs == null && deadline.monotonicMs == null
      || deadline.wallTimeMs != null && !Number.isFinite(deadline.wallTimeMs)
      || deadline.monotonicMs != null && !Number.isFinite(deadline.monotonicMs)))
      throw new RangeError("unit returned an invalid deadline");
    const previousDeadline = next.deadlines[unit] ?? null;
    if (deadline?.wallTimeMs !== previousDeadline?.wallTimeMs
      || deadline?.monotonicMs !== previousDeadline?.monotonicMs)
      next = { ...next, deadlines: { ...next.deadlines, [unit]: deadline } };
    for (const outcome of step.outcomes) outcomes.push({ unit, outcome });
    if (step.displayChanges.length !== 0) {
      displayChanges.push(...step.displayChanges);
      viewUnits.add(unit);
    }
    // 表示の変化の無い内容の変化（U-Q の当日履歴の日付の切り替え、P3-C7-SEM-04）も view を出し直す。
    if (step.state.contentRevision !== ownUnit(start, unit).contentRevision) viewUnits.add(unit);
    if (unitInput.kind === "receive") confirmationEvidence.push(...step.confirmationEvidence);
    step.diagnostics.forEach(diagnose);
    return step;
  };
  const applyDeadlines = (targets: readonly RuntimeUnitId[]) => {
    if (clock == null || next.finalized) return;
    for (const unit of targets) {
      const deadline = next.deadlines[unit];
      if (deadline != null && (deadline.wallTimeMs != null && clock.wallTimeMs >= deadline.wallTimeMs
        || deadline.monotonicMs != null && clock.monotonicMs >= deadline.monotonicMs))
        reduceUnit(unit, { kind: "deadline", clock });
    }
  };
  const setPersistence = (unit: RuntimeUnitId, persistence: PersistenceStatus) => {
    next = { ...next, units: { ...next.units, [unit]: { ...ownUnit(next, unit), persistence } } };
    changed(unit);
  };
  // beforeProjection: 印のあるときだけ owner-host が渡す測定時刻の読み口。state が決まった後・射影の前に 1 回呼ぶ（P3-UWR-AC08）。
  const finish = (project = true, beforeProjection?: () => void): OwnerStep => {
    // A normal-admission toggle shows or hides every normal subject of that unit without a unit change.
    for (const unit of placeUnits(start.place)) {
      if ((start.admission[unit]?.normal == null) === (next.admission[unit]?.normal == null)) continue;
      const seen = new Set(displayChanges.filter((item) => item.unit === unit && item.operation === "normal")
        .map((item) => item.subject));
      for (const value of normalSubjects(units, unit, ownUnit(next, unit))) {
        if (seen.has(value.subject)) continue;
        displayChanges.push({ unit, operation: value.operation, subject: value.subject, before: value, after: value });
      }
    }
    // publisher が外す event 単位の確認記録: どの current も持たない event の U-E subject と、view から外れた U-T の VTSE41 subject
    // （I-U-T.confirmationScope。VTSE41 の subject は operation・EventID ごとに 1 つなので、外れた event を残りと照合しない）。
    let retiredEvents: OwnerOutput["retiredEvents"] = EMPTY;
    const leaving = (change: RuntimeDisplayChange) => change.after == null && change.before != null && change.before.current != null
      && (change.before.unit === "U-E" || change.before.unit === "U-T" && "areas" in change.before.current);
    if (displayChanges.some(leaving)) {
      const live = new Set(next.units["U-E"]?.current.map((item) => JSON.stringify([item.operation, item.eventId])));
      const retired: OwnerOutput["retiredEvents"][number][] = [];
      for (const change of displayChanges) {
        if (!leaving(change) || change.before?.current == null || !("eventId" in change.before.current)) continue;
        const unit = change.before.unit === "U-T" ? "U-T" as const : "U-E" as const;
        const eventId = change.before.current.eventId;
        if (unit === "U-T" || !live.has(JSON.stringify([change.operation, eventId]))) retired.push({ unit, operation: change.operation, eventId });
      }
      retiredEvents = retired;
    }
    beforeProjection?.();
    const views = !project || viewUnits.size === 0 ? EMPTY : [...viewUnits].map((unit) => projectView(next, units, unit));
    return { state: next, changedUnits, generationInputIds, views, outcomes, displayChanges, confirmationEvidence,
      retiredEvents, diagnostics };
  };
  return {
    get state() { return next; },
    set state(value: OwnerState) { next = value; },
    reduceUnit, applyDeadlines, diagnose, setPersistence, finish, generationInputIds, displayChanges, outcomes, changed,
  };
}

function checkClock(clock: ClockReading): void {
  if (!Number.isFinite(clock.wallTimeMs) || !Number.isFinite(clock.monotonicMs))
    throw new RangeError("runtime clock must be finite");
}

// Startup restore of the owner's units (P2-A3-AC09 per owner): each unit's restore runs once, the restored
// persistence is never synthesized. Views are projected by ownerViews once restore and deadlines are applied.
function restoreOwner(input: Readonly<{ runId: string; place: ExecutionPlace; clock: ClockReading;
  restored: Readonly<Partial<Record<RuntimeUnitId, RestoreUnitResult>>> }>,
units: UnitTable, codecs: CodecMap<RuntimeUnitStates>): OwnerStep & Readonly<{ restoration: Partial<RuntimeRestoration> }> {
  const own = placeUnits(input.place);
  if (input.runId.length === 0 || own.some((unit) => input.restored[unit] == null)) throw new RangeError("invalid startup input");
  checkClock(input.clock);
  const pick = <T>(value: (unit: RuntimeUnitId) => T) => Object.fromEntries(own.map((unit) => [unit, value(unit)]));
  const start: OwnerState = { runId: input.runId, place: input.place, units: pick((unit) => initialUnits[unit]),
    admission: {}, deadlines: pick(() => null), checkpointAttempts: {}, accepting: true, finalized: false };
  const work = session(start, units, input.clock);
  const restoration: Partial<Record<RuntimeUnitId, RuntimeRestoration[RuntimeUnitId]>> = {};
  const restoreUnit = <K extends RuntimeUnitId>(unit: K) => {
    const restored = input.restored[unit]!;
    if (restored.kind === "empty" || restored.kind === "unavailable") { restoration[unit] = restored; return; }
    const { envelope } = restored;
    const codec = codecs?.[unit];
    if (envelope.unit !== unit || envelope.schemaVersion !== initialUnits[unit].schemaVersion
      || !Number.isSafeInteger(envelope.generation) || envelope.generation < 1
      || !Number.isFinite(envelope.capturedAt) || codec == null)
      throw new RangeError("invalid restored unit envelope");
    const decoded = codec.decode(envelope.payload);
    if (decoded.kind !== "restored") { restoration[unit] = { kind: "unavailable", reason: "noValidSlot" }; return; }
    const persistence: PersistenceStatus = { kind: "saved", currentGeneration: envelope.generation,
      savedGeneration: envelope.generation, savedCapturedAt: envelope.capturedAt, savedAckAt: null, dirtySince: null };
    const seeded = { ...decoded.state, persistence };
    // The one `as`: CodecMap is typed over JsonValue; this unit's own codec made both state and persisted payload.
    // With K generic the whole job escapes the correlated union here, so unit, state and input are checked by eye.
    const step = runUnitJob(units, { unit, state: seeded,
      input: { kind: "restore", persisted: codec.encode(seeded), clock: input.clock } } as UnitJob);
    work.state = { ...work.state, units: { ...work.state.units, [unit]: step.state },
      deadlines: { ...work.state.deadlines, [unit]: step.nextDeadline } };
    restoration[unit] = { kind: "restored" };
    work.changed(unit);
    if (step.state.persistence.currentGeneration > envelope.generation) work.generationInputIds[unit] = [];
    for (const outcome of step.outcomes) work.outcomes.push({ unit, outcome });
    work.displayChanges.push(...step.displayChanges.filter((change) => change.after != null)
      .map((change) => ({ ...change, before: null })));
    step.diagnostics.forEach(work.diagnose);
  };
  for (const unit of own) restoreUnit(unit);
  return { ...work.finish(false), restoration };
}

// Every own unit's current view (startup and the publisher's first mirror).
function ownerViews(state: OwnerState, units: UnitTable): readonly RuntimeUnitView[] {
  return placeUnits(state.place).map((unit) => projectView(state, units, unit));
}

// Deadline request: the owner applies its own units' due deadlines (P3-C3A-DEADLINES).
function deadlineOwner(state: OwnerState, clock: ClockReading, units: UnitTable): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock);
  work.applyDeadlines(placeUnits(state.place));
  return work.finish();
}

function routedUnit(state: OwnerState, completion: ParserCompletion): RuntimeUnitId | undefined {
  const route = completion.result.kind === "decoded" ? classifyHeadType(completion.result.material.headType) : null;
  if (!state.accepting || route?.status !== "ready") return undefined;
  if (executionPlaces[route.unit] !== state.place) throw new Error(`input for ${route.unit} reached the ${state.place} owner`);
  return route.unit;
}

// One parser input: route, receive or exactly one diagnostic (P3-UNIT-TABLE-001, P3-C3A-NONREADY).
function receiveOwner(state: OwnerState, completion: ParserCompletion, clock: ClockReading, units: UnitTable,
  beforeProjection?: () => void): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock);
  if (completion.runId !== state.runId || state.finalized) return work.finish(true, beforeProjection);
  const unit = routedUnit(state, completion);
  const route = completion.result.kind === "decoded" ? classifyHeadType(completion.result.material.headType) : null;
  // Before a receive, a unit that asks for it reclaims its own wall-clock deadline (A4 terminal records).
  // Maintenance has no parser attribution: only the receive below names this input.
  if (unit != null && units[unit].reclaimDeadlineBeforeReceive && state.deadlines[unit]?.wallTimeMs != null)
    work.applyDeadlines([unit]);
  // Units re-run the common Head/date check themselves: one diagnostic per input, and
  // U-W keeps §7.8 freshness monitoring for rejected inputs (A1 freshnessException).
  if (unit != null && completion.result.kind === "decoded") {
    const generationBeforeReceive = ownUnit(work.state, unit).persistence.currentGeneration;
    const received = work.reduceUnit(unit, { kind: "receive", material: completion.result.material, clock });
    if (received.state.persistence.currentGeneration > generationBeforeReceive
      && received.decisions.some((decision) => decision.decision === "changed"))
      work.generationInputIds[unit] = [completion.inputId];
  } else if (completion.result.kind === "rejected") {
    const details = parserDiagnostic(completion.result.diagnostic.reason, completion.result.diagnostic.inputId);
    if (details != null) work.diagnose(details);
  } else if (route?.status === "ignored") {
    // P3-UNIT-TABLE-001: at most one diagnostic per input; ignored headTypes skip the envelope check.
    work.diagnose(boundDiagnosticDetails({ level: "INFO", component: "shared-runtime", reason: "routeIgnored", inputId: completion.inputId }));
  } else {
    const result = validateSemanticEnvelope(completion.result.material);
    if (result.kind === "rejected") work.diagnose(result.diagnostic);
    else if (route?.status === "notPorted")
      work.diagnose(boundDiagnosticDetails({ level: "INFO", component: "shared-runtime", reason: "routeNotPorted",
        unit: route.candidate, inputId: completion.inputId }));
    else if (route?.status === "unlisted")
      work.diagnose(boundDiagnosticDetails({ level: "WARN", component: "shared-runtime", reason: "routeUnlisted", inputId: completion.inputId }));
  }
  return work.finish(true, beforeProjection);
}

// The correlated intent updates of one unit, adopted in one unit input (P2-A1 B4) or not at all (P3-C3A-NOTIFY-ADOPT):
// an update for an intent the unit no longer holds as pending adopts nothing. decision is the fixed decision clock.
function intentUpdateOwner<K extends RuntimeUnitId>(state: OwnerState, unit: K, updates: readonly NotificationIntentUpdate[],
  decision: ClockReading, units: UnitTable): OwnerStep & Readonly<{ adopted: boolean }> {
  checkClock(decision);
  const work = session(state, units, decision);
  const before = ownUnit(state, unit);
  const originals = new Map(before.intents.map((intent) => [intent.id, intent]));
  if (state.finalized || updates.length === 0 || updates.some((update) => originals.get(update.id)?.disposition !== "pending"))
    return { ...work.finish(), adopted: false };
  const previousGeneration = before.persistence.currentGeneration;
  // ponytail: K <= 128, T only byte-bounded (256KiB/16MiB/32MiB); keep O(K + T) batching if budgets grow.
  work.reduceUnit(unit, { kind: "intentUpdate", clock: decision, intentUpdate: updates.length === 1 ? updates[0] : updates });
  const adopted = ownUnit(work.state, unit);
  const intentsById = new Map(adopted.intents.map((intent) => [intent.id, intent]));
  const terminal = units[unit].terminalIntents;
  const recordsById = terminal.kind === "deliveryRecords"
    ? new Map(terminal.records(adopted).map((record) => [record.intentId, record])) : null;
  for (const candidate of updates) {
    const original = originals.get(candidate.id)!;
    if (recordsById != null && candidate.disposition !== "pending") {
      // At the wall deadline A4 reclaims the terminal record in the same adoption.
      const reclaimed = candidate.disposition === "expired" && decision.wallTimeMs >= original.expiresAt;
      const record = recordsById.get(original.id);
      if ((!reclaimed && (record?.disposition !== candidate.disposition || record.expiresAt !== original.expiresAt))
        || intentsById.has(original.id)
        || adopted.persistence.currentGeneration <= previousGeneration)
        throw new Error("unit did not adopt the correlated intent update");
    } else {
      const intent = intentsById.get(original.id);
      if (intent?.attempts !== candidate.attempts || intent.nextAttemptAt !== candidate.nextAttemptAt
        || intent.disposition !== candidate.disposition)
        throw new Error("unit did not adopt the correlated intent update");
    }
  }
  return { ...work.finish(), adopted: true };
}

// The capture of one save attempt: the generation it saves and when (P2-A3-AC10 ordering).
function capturedOwner(state: OwnerState, capture: CheckpointCapture, units: UnitTable): OwnerStep {
  if (!Number.isSafeInteger(capture.generation) || capture.generation < 1 || !Number.isFinite(capture.capturedAt)
    || capture.attemptId.length === 0) throw new RangeError("invalid checkpoint capture");
  const work = session(state, units, null);
  const unit = capture.unit;
  const previous = state.units[unit]?.persistence;
  if (previous != null && capture.generation === previous.currentGeneration
    && capture.generation > (previous.savedGeneration ?? 0) && state.checkpointAttempts[unit] == null) {
    work.state = { ...state, checkpointAttempts: { ...state.checkpointAttempts, [unit]: {
      unit, attemptId: capture.attemptId, generation: capture.generation,
      capturedAt: capture.capturedAt, postCaptureDirtySince: null,
    } } };
  }
  return work.finish();
}

// The result of the owner's own save attempt. dirtySince clears only when the acknowledged generation is current
// (P3-C3A-CHECKPOINT-ACK): an old ack advances savedGeneration and keeps the post-capture dirty time.
function checkpointResultOwner(state: OwnerState, result: CheckpointResult, units: UnitTable): OwnerStep {
  const work = session(state, units, null);
  const unit = runtimeUnits.find((candidate) => candidate === result.unit);
  const previous = unit == null ? undefined : state.units[unit]?.persistence;
  const attempt = unit == null ? undefined : state.checkpointAttempts[unit];
  if (unit == null || previous == null || attempt == null || attempt.attemptId !== result.attemptId
    || attempt.unit !== result.unit || attempt.generation !== result.generation
    || result.generation <= (previous.savedGeneration ?? 0) || result.generation > previous.currentGeneration)
    return work.finish();
  const progress = {
    currentGeneration: previous.currentGeneration, savedGeneration: previous.savedGeneration,
    savedCapturedAt: previous.savedCapturedAt, savedAckAt: previous.savedAckAt, dirtySince: previous.dirtySince,
  };
  if (result.kind === "acknowledged") {
    const saved = previous.currentGeneration === result.generation;
    if (!saved && attempt.postCaptureDirtySince == null)
      throw new Error("checkpoint capture was not ordered before durable updates");
    work.setPersistence(unit, { ...progress, kind: saved ? "saved" : "pending",
      savedGeneration: result.generation, savedCapturedAt: attempt.capturedAt, savedAckAt: result.ackAt,
      dirtySince: saved ? null : attempt.postCaptureDirtySince });
  } else if (result.kind === "failed") {
    work.setPersistence(unit, { ...progress, kind: "failed", stage: result.stage, reason: boundedString(result.reason) });
  } else if (previous.kind !== "uncertain" || previous.attemptedGeneration !== result.generation) {
    work.setPersistence(unit, { ...progress, kind: "uncertain", attemptedGeneration: result.generation });
  }
  if (result.kind !== "uncertain") {
    const attempts = { ...work.state.checkpointAttempts };
    delete attempts[unit];
    work.state = { ...work.state, checkpointAttempts: attempts };
  }
  return work.finish();
}

// spec §5.9 step 3: each unit's declared shutdown input; later parser inputs are not applied.
function shutdownInputOwner(state: OwnerState, clock: ClockReading, units: UnitTable): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock);
  for (const unit of placeUnits(state.place)) work.reduceUnit(unit, { kind: "shutdown", clock });
  work.state = { ...work.state, accepting: false };
  return work.finish();
}

// spec §5.9 step 4: deadlines up to cutoff apply, later ones are evaluated at the next start.
function finalizeOwner(state: OwnerState, cutoff: ClockReading, units: UnitTable): OwnerStep {
  checkClock(cutoff);
  const work = session(state, units, cutoff);
  work.applyDeadlines(placeUnits(state.place));
  work.state = { ...work.state, finalized: true };
  return work.finish();
}

export {
  capturedOwner, checkpointResultOwner, deadlineOwner, finalizeOwner, initialUnits, intentUpdateOwner, ownerViews,
  placeUnits, receiveOwner, restoreOwner, shutdownInputOwner, unitAdmissionCounts, validateSemanticEnvelope,
};
export type { OwnerState, OwnerStep, ParserCompletion };
