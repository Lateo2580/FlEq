import type { DecodedMaterial, ParserMailboxResult } from "../../contracts/p1-parser-boundary.types";
import type { UnitJob, UnitTable } from "../../contracts/p3-unit-table.types";
import type { ExecutionPlace, OwnerOutput } from "../../contracts/p3-execution-split.types";
import type {
  CheckpointCapture,
  CheckpointResult,
  ClockReading,
  CurrentConfirmationEvidence,
  DiagnosticDetails,
  DiagnosticEvent,
  LossTally,
  NotificationIntentUpdate,
  PersistenceStatus,
  RejectionReason,
  RestoreUnitResult,
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
  SemanticEnvelopeResult, WallBasis,
} from "../../contracts/p2-shared-runtime.types";
import type { CodecMap } from "../checkpoint/checkpoint";
import { keptLosses, lossReasons } from "../checkpoint/checkpoint";
import { boundDiagnosticDetails, boundedString, completeDiagnostic, parserDiagnosticReasons } from "./runtime-diagnostic"; import { validInputId } from "../contracts-revision/version";
import { classifyHeadType, executionPlaces, runtimeUnits } from "./unit-coverage"; import type { WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse } from "../../contracts/p2-weather-timeseries-unit.types"; import { weatherTimeseriesDetail } from "../units/weather-timeseries/weather-timeseries-unit";

// P3-EXECUTION-SPLIT-001 (C3a) owner core: everything one owner does to its own units, as pure functions of
// the owner state. The owner thread and the test path (1) call these; nothing here touches another place's units.

const EMPTY: readonly never[] = Object.freeze([]);

type OwnerState = Readonly<{
  runId: string;
  place: ExecutionPlace;
  units: Readonly<Partial<RuntimeUnitStates>>;
  deadlines: Readonly<Partial<Record<RuntimeUnitId, RuntimeUnitDeadline | null>>>;
  checkpointAttempts: RuntimeState["checkpointAttempts"];
  // P3-NL-AC14 (1): unit ごとの H39 の件数（envelope の losses。capture で書き、復元で読む。数え方は発注 2）。
  losses: Readonly<Partial<Record<RuntimeUnitId, readonly LossTally[]>>>;
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
const noHistory = { dayKey: null, count: 0, maxInt: null, counted: [], recent: [] } as const;
const initialUnits: RuntimeUnitStates = {
  "U-E": { schemaVersion: "p2-eew-unit-v4", contentRevision: 0, current: [], gates: [], intents: [], notices: [], persistence: cleanPersistence },
  "U-W": { schemaVersion: "p2-weather-current-unit-v5", contentRevision: 0, national: {}, partials: [], histories: [], ownership: {},
    tombstones: [], freshness: [], unavailable: [], intents: [], unconfirmed: [], persistence: cleanPersistence },
  "U-F": { schemaVersion: "p2-weather-timeseries-unit-v6", contentRevision: 0, subjects: [], gates: [], intents: [], persistence: cleanPersistence },
  "U-T": { schemaVersion: "p3-tsunami-unit-v5", contentRevision: 0, forecasts: [], observations: [], intents: [], failureMarks: [], persistence: cleanPersistence },
  "U-Q": { schemaVersion: "p3-seismic-unit-v5", contentRevision: 0, earthquakes: [], longPeriods: [],
    daily: { normal: noHistory, training: noHistory, test: noHistory }, intents: [], failureMarks: [], persistence: cleanPersistence },
  "U-N": { schemaVersion: "p3-nankai-unit-v6", contentRevision: 0, currents: [], information: [], intents: [], persistence: cleanPersistence },
  "U-V": { schemaVersion: "p3-volcano-unit-v5", contentRevision: 0, alerts: [], eruptions: [], ashfalls: [], shortfalls: [],
    scheduledAshfalls: [], batch: null, bulletins: [], intents: [], persistence: cleanPersistence },
  "U-L": { schemaVersion: "p3-landslide-unit-v6", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
  "U-R": { schemaVersion: "p3-flood-unit-v6", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
  "U-B": { schemaVersion: "p3-briefing-unit-v6", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
  "U-M": { schemaVersion: "p3-local-bulletins-unit-v6", contentRevision: 0, tornado: [], heat: [], transient: [], intents: [], persistence: cleanPersistence },
  "U-Y": { schemaVersion: "p3-typhoon-unit-v6", contentRevision: 0, analysis: [], probability: [], intents: [], persistence: cleanPersistence },
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
  // P3-VM-AC08: 全 unit の受理で、ReportRef の読み戻し（version.ts の readReportRef）と同じ inputId の上限を 1 度だけ当てる。
  if (!validInputId(material.inputId)) return rejection(material, "identityInvalid");
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
    case "U-B": return { unit, state: ownUnit(state, unit), input };
    case "U-M": return { unit, state: ownUnit(state, unit), input };
    case "U-Y": return { unit, state: ownUnit(state, unit), input };
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
    case "U-B": return units[job.unit].reduce(job.state, job.input);
    case "U-M": return units[job.unit].reduce(job.state, job.input);
    case "U-Y": return units[job.unit].reduce(job.state, job.input);
    default: { const missing: never = job; throw new Error(`unit job ${String(missing)} is not handled`); }
  }
}

// The public view of one unit (never the unit state). 容量の拒否で normal を隠さない（P3-CC-AC01）。
function projectView<K extends RuntimeUnitId>(state: OwnerState, units: UnitTable, unit: K): RuntimeViews[K] {
  return units[unit].toView(ownUnit(state, unit));
}

// P3-NL-AC14 (2)(3)(4): 理由ごとの行に件数を足す（閉集合の外・別の unit の行は数えない）。count は安全な整数で飽和させ、lastAt は足した時の
// 手元の wall。何も足さなければ null。ponytail: 行は unit ごとに最大 7（P3-NL-RES-04）なので行の探索は線形。
function addLosses(rows: readonly LossTally[] | undefined, unit: RuntimeUnitId,
  items: readonly Readonly<{ reason: string; unit?: string; count?: number }>[], at: number): readonly LossTally[] | null {
  let next: LossTally[] | null = null;
  for (const item of items) {
    const reason = lossReasons(unit).find((value) => value === item.reason), count = item.count ?? 1;
    if (reason == null || item.unit != null && item.unit !== unit || !Number.isSafeInteger(count) || count < 1) continue;
    next ??= [...rows ?? []];
    const index = next.findIndex((row) => row.reason === reason);
    next[index < 0 ? next.length : index] = { reason, count: Math.min((index < 0 ? 0 : next[index].count) + count, Number.MAX_SAFE_INTEGER), lastAt: at };
  }
  return next;
}
// P3-NL-AC14 (5): 件数だけが変わった入力でもその unit の世代を進めて保存させる（unit の dirty と同じ形。domain の中身と contentRevision は
// 変えない）。無いと断っただけの入力の件数が保存されず、再起動で消える。
function raised(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1, dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}

// One owner request: its reducer calls, then the changes it must report, in the order they happened.
// basis は unit の receive・deadline・restore・shutdown の入力へ運ぶ要求の時計の根拠（P3-EF-AC01 (3)(4)、保存しない）。
function session(start: OwnerState, units: UnitTable, clock: ClockReading | null, basis: WallBasis = "verified") {
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
    // P3-NL-AC14 (4)(5): unit の採用の結果の診断を数える。同じ入力で unit が世代を進めたなら、その世代に含める。
    const losses = addLosses(next.losses[unit], unit, step.diagnostics, unitInput.clock.wallTimeMs);
    if (losses != null) next = { ...next, losses: { ...next.losses, [unit]: losses } };
    const bump = losses != null && step.state.persistence.currentGeneration <= previous.persistence.currentGeneration;
    const persistence = bump ? raised(step.state.persistence, unitInput.clock.monotonicMs) : step.state.persistence;
    if (persistence.currentGeneration > previous.persistence.currentGeneration)
      generationInputIds[unit] ??= [];
    if (step.state !== previous || bump) {
      const attempt = next.checkpointAttempts[unit];
      // The first changed durable generation after capture defines the next dirty interval.
      if (attempt != null && attempt.postCaptureDirtySince == null
        && persistence.currentGeneration > previous.persistence.currentGeneration
        && persistence.currentGeneration > attempt.generation) {
        next = { ...next, checkpointAttempts: { ...next.checkpointAttempts,
          [unit]: { ...attempt, postCaptureDirtySince: unitInput.clock.monotonicMs } } };
      }
      next = { ...next, units: { ...next.units, [unit]: bump ? { ...step.state, persistence } : step.state } };
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
  // force: 根拠が verified に替わった要求で、到来の判定を通さず unit ごとに 1 回当てる（P3-EF-AC02 (7)。時計が後ろへ直っても保留の記録を回収する）。
  // 期限を何も持たない unit（nextDeadline が null）は当てるものが無いので送らない。
  const applyDeadlines = (targets: readonly RuntimeUnitId[], force = false) => {
    if (clock == null || next.finalized) return;
    for (const unit of targets) {
      const deadline = next.deadlines[unit];
      if (deadline != null && (force || deadline.wallTimeMs != null && clock.wallTimeMs >= deadline.wallTimeMs
        || deadline.monotonicMs != null && clock.monotonicMs >= deadline.monotonicMs))
        reduceUnit(unit, { kind: "deadline", clock, basis });
    }
  };
  const setPersistence = (unit: RuntimeUnitId, persistence: PersistenceStatus) => {
    next = { ...next, units: { ...next.units, [unit]: { ...ownUnit(next, unit), persistence } } };
    changed(unit);
  };
  // beforeProjection: 印のあるときだけ owner-host が渡す測定時刻の読み口。state が決まった後・射影の前に 1 回呼ぶ（P3-UWR-AC08）。
  const finish = (project = true, beforeProjection?: () => void): OwnerStep => {
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

// 起動時の owner の unit の復元（owner ごとの P2-A3-AC09）。各 unit の restore は 1 回だけで、復元した persistence を合成しない。view は
// 復元と期限を当てた後に ownerViews が射影する。
function restoreOwner(input: Readonly<{ runId: string; place: ExecutionPlace; clock: ClockReading; basis?: WallBasis;
  restored: Readonly<Partial<Record<RuntimeUnitId, RestoreUnitResult>>> }>,
units: UnitTable, codecs: CodecMap<RuntimeUnitStates>): OwnerStep & Readonly<{ restoration: Partial<RuntimeRestoration> }> {
  const own = placeUnits(input.place);
  if (input.runId.length === 0 || own.some((unit) => input.restored[unit] == null)) throw new RangeError("invalid startup input");
  checkClock(input.clock);
  const pick = <T>(value: (unit: RuntimeUnitId) => T) => Object.fromEntries(own.map((unit) => [unit, value(unit)]));
  const start: OwnerState = { runId: input.runId, place: input.place, units: pick((unit) => initialUnits[unit]),
    deadlines: pick(() => null), checkpointAttempts: {}, losses: {}, accepting: true, finalized: false };
  const work = session(start, units, input.clock, input.basis);
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
    // P3-NL-AC14 (6): lastAt＋24 時間を過ぎた行は復元のときに外す。
    const kept = keptLosses(envelope.losses ?? [], input.clock.wallTimeMs).losses;
    // 唯一の `as`: CodecMap は JsonValue で型付けされ、state と保存の payload はこの unit 自身の codec が作った。K が generic なので
    // ここでは job 全体が相関した union から外れ、unit・state・入力の対応は目で確かめる。
    const step = runUnitJob(units, { unit, state: seeded,
      input: { kind: "restore", persisted: codec.encode(seeded), clock: input.clock, basis: input.basis ?? "verified" } } as UnitJob);
    // P3-NL-AC14 (4)(5) の読み（Q-NL-PRECHECK-2 (1)(i)）: 復元の診断（通知したか不明）も数え、件数だけが変われば世代を進める。
    const losses = addLosses(kept, unit, step.diagnostics, input.clock.wallTimeMs) ?? kept;
    const unitState = losses !== kept && step.state.persistence.currentGeneration <= envelope.generation
      ? { ...step.state, persistence: raised(step.state.persistence, input.clock.monotonicMs) } : step.state;
    work.state = { ...work.state, units: { ...work.state.units, [unit]: unitState },
      deadlines: { ...work.state.deadlines, [unit]: step.nextDeadline }, ...losses == null ? {} : { losses: { ...work.state.losses, [unit]: losses } } };
    restoration[unit] = { kind: "restored" };
    work.changed(unit);
    if (unitState.persistence.currentGeneration > envelope.generation) work.generationInputIds[unit] = [];
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
function deadlineOwner(state: OwnerState, clock: ClockReading, units: UnitTable, basis: WallBasis = "verified", force = false): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock, basis);
  work.applyDeadlines(placeUnits(state.place), force);
  return work.finish();
}

function routedUnit(state: OwnerState, completion: ParserCompletion): RuntimeUnitId | undefined {
  const route = completion.result.kind === "decoded" ? classifyHeadType(completion.result.material.headType) : null;
  if (!state.accepting || route?.status !== "ready") return undefined;
  if (executionPlaces[route.unit] !== state.place) throw new Error(`input for ${route.unit} reached the ${state.place} owner`);
  return route.unit;
}

// parser の入力 1 件: 振り分け、受信、またはちょうど 1 件の診断（P3-UNIT-TABLE-001、P3-C3A-NONREADY）。
function receiveOwner(state: OwnerState, completion: ParserCompletion, clock: ClockReading, units: UnitTable,
  beforeProjection?: () => void, basis: WallBasis = "verified"): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock, basis);
  if (completion.runId !== state.runId || state.finalized) return work.finish(true, beforeProjection);
  const unit = routedUnit(state, completion);
  const route = completion.result.kind === "decoded" ? classifyHeadType(completion.result.material.headType) : null;
  // 受信の前に、求める unit は自分の wall の期限（記録の期限）を回収する。回収は parser の入力に帰属させず、この入力の名を
  // 持つのは下の受信だけ。
  if (unit != null && units[unit].reclaimDeadlineBeforeReceive && state.deadlines[unit]?.wallTimeMs != null)
    work.applyDeadlines([unit]);
  // unit は共通の Head・日時の検査を自分でもう一度行う（入力ごとに診断 1 件）。U-W は拒否した入力でも §7.8 の鮮度の監視を続ける
  // （A1 freshnessException）。
  if (unit != null && completion.result.kind === "decoded") {
    const generationBeforeReceive = ownUnit(work.state, unit).persistence.currentGeneration, lossesBefore = work.state.losses[unit];
    const received = work.reduceUnit(unit, { kind: "receive", material: completion.result.material, clock, basis });
    // 容量の拒否でも失敗警報と title の書き換えで世代が進めば、その世代に帰属させる（P3-CC-AC10(9)、正常採用の扱いにはしない）。
    // U-E の採らない取消が取消の intent と印を足した世代、件数だけが変わった世代も同じ（P3-NL-AC04 (5)・AC14 (5)）。
    if (ownUnit(work.state, unit).persistence.currentGeneration > generationBeforeReceive
      && (received.intents.length !== 0 || work.state.losses[unit] !== lossesBefore
        || received.decisions.some((decision) => decision.decision === "changed" || decision.decision === "capacityExceeded")))
      work.generationInputIds[unit] = [completion.inputId];
  } else if (completion.result.kind === "rejected") {
    const details = parserDiagnostic(completion.result.diagnostic.reason, completion.result.diagnostic.inputId);
    if (details != null) work.diagnose(details);
  } else if (route?.status === "ignored") {
    // P3-UNIT-TABLE-001: 入力ごとに診断は 1 件まで。無視する headType は封筒の検査をしない。
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

// 1 unit の照合済みの intent の更新を 1 回の unit 入力でまとめて採るか、まったく採らない（P2-A1 B4、P3-C3A-NOTIFY-ADOPT）。unit が
// pending として持たない intent への更新は何も採らない。decision は固定した判断の時計。
function intentUpdateOwner<K extends RuntimeUnitId>(state: OwnerState, unit: K, updates: readonly NotificationIntentUpdate[],
  decision: ClockReading, units: UnitTable): OwnerStep & Readonly<{ adopted: boolean }> {
  checkClock(decision);
  const work = session(state, units, decision);
  const before = ownUnit(state, unit);
  const originals = new Map(before.intents.map((intent) => [intent.id, intent]));
  if (state.finalized || updates.length === 0 || updates.some((update) => originals.get(update.id)?.disposition !== "pending"))
    return { ...work.finish(), adopted: false };
  const previousGeneration = before.persistence.currentGeneration;
  // ponytail: unit ごとの pending は 128 件まで（P3-NL-AC05 で終端記録は無い）。上限が増えても O(K) の一括のままにする。
  work.reduceUnit(unit, { kind: "intentUpdate", clock: decision, intentUpdate: updates.length === 1 ? updates[0] : updates });
  const adopted = ownUnit(work.state, unit);
  const intentsById = new Map(adopted.intents.map((intent) => [intent.id, intent]));
  // P3-NL-AC05 (3): 終端の intent は全 unit で印に置き換わるので、intents に無く世代が進んだことで採用を確かめる。
  for (const candidate of updates) {
    const intent = intentsById.get(candidate.id);
    if (candidate.disposition !== "pending" ? intent != null || adopted.persistence.currentGeneration <= previousGeneration
      : intent?.attempts !== candidate.attempts || intent.nextAttemptAt !== candidate.nextAttemptAt
        || intent.disposition !== candidate.disposition || intent.lastAttempt !== candidate.lastAttempt
        || intent.replayed !== candidate.replayed || intent.expiresAt !== candidate.expiresAt)
      throw new Error("unit did not adopt the correlated intent update");
  }
  // P3-NL-AC14 (4): 採用した更新の lossReason を数える（終端の更新だけが持ち、採用で世代は進んでいる）。
  const losses = addLosses(work.state.losses[unit], unit, updates.flatMap((update) => update.lossReason == null ? [] : [{ reason: update.lossReason }]),
    decision.wallTimeMs);
  if (losses != null) work.state = { ...work.state, losses: { ...work.state.losses, [unit]: losses } };
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
  // P3-NL-AC14 (6): capture が envelope から外した行（lastAt＋24 時間を過ぎた行）は、加算元からも外す。無いと外した行が state に残り、
  // 次の加算で再び保存され、再起動を挟むかで同じ入力の件数が変わる。
  const losses = work.state.losses[unit];
  if (losses != null) {
    const kept = keptLosses(losses, capture.capturedAt).losses;
    if (kept?.length !== losses.length) work.state = { ...work.state, losses: { ...work.state.losses, [unit]: kept } };
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
function shutdownInputOwner(state: OwnerState, clock: ClockReading, units: UnitTable, basis: WallBasis = "verified"): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock, basis);
  for (const unit of placeUnits(state.place)) work.reduceUnit(unit, { kind: "shutdown", clock, basis });
  work.state = { ...work.state, accepting: false };
  return work.finish();
}

// spec §5.9 step 4: deadlines up to cutoff apply, later ones are evaluated at the next start.
function finalizeOwner(state: OwnerState, cutoff: ClockReading, units: UnitTable, basis: WallBasis = "verified"): OwnerStep {
  checkClock(cutoff);
  const work = session(state, units, cutoff, basis);
  work.applyDeadlines(placeUnits(state.place));
  work.state = { ...work.state, finalized: true };
  return work.finish();
}

// P3-UFP-AC06: owner の state から U-F の詳細の 1 ページを作る。U-F の関数を直接呼ぶ（Q-UFP-DETAIL-PATH）。
function detailOwner(state: OwnerState, request: WeatherTimeseriesDetailRequest): WeatherTimeseriesDetailResponse {
  const unit = state.units["U-F"];
  if (unit == null) return { kind: "error", reason: "unavailable", revision: null };
  return weatherTimeseriesDetail(unit, request, { contentRevision: String(unit.contentRevision) });
}

export {
  capturedOwner, checkpointResultOwner, deadlineOwner, detailOwner, finalizeOwner, initialUnits, intentUpdateOwner, ownerViews,
  placeUnits, receiveOwner, restoreOwner, shutdownInputOwner, validateSemanticEnvelope,
};
export type { OwnerState, OwnerStep, ParserCompletion };
