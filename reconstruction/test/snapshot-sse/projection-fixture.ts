import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, RestoreUnitResult, RuntimeAdmissionCounts, RuntimeDisplayChange, RuntimeInput, RuntimePublishedOutcome, RuntimeState,
  RuntimeUnitId, RuntimeViews,
} from "../../contracts/p2-shared-runtime.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { WeatherTimeseriesSubject } from "../../contracts/p2-weather-timeseries-unit.types";
import type {
  DisplaySnapshot, SnapshotProjectionInput, SnapshotProjectionResult, SnapshotProjectionState,
} from "../../contracts/p2-snapshot-sse.types";
import { hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem, snapshotInput } from "../../src/runtime/composition-root";
import type { PublisherInput } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import type { PublisherState } from "../../src/runtime/shared-runtime";
import { currentSubject } from "../../src/units/eew/eew-unit";
import { displaySubjects } from "../../src/units/weather-current/weather-current-unit";
import { timeseriesSubjectOutcome } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { envelope, harnessedRoot, idleChannels, places } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

const calls = linkedRuntimeCalls;

// One report as the host would receive it (bytes, not a decoded tree).
type Report = Readonly<{ headType: string; inputId: string; body: Uint8Array }>;
function decode(file: string, headType: string, transform: (xml: string) => string = (xml) => xml, inputId = file): Report {
  return { headType, inputId, body: Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8"))) };
}

type Input = Readonly<{ kind: "report"; runId: string; report: Report; clock: ClockReading }>
  | Readonly<{ kind: "tick"; clock: ClockReading }> | PublisherInput;
function received(runId: string, report: Report, clock: ClockReading): Input {
  return { kind: "report", runId, report, clock };
}

// The runtime seen whole, as A8 projects it: the publisher's state with each owner's units (TEST-PATH (2)).
type Step = Readonly<{ state: RuntimeState; outcomes: readonly RuntimePublishedOutcome[];
  displayChanges: readonly RuntimeDisplayChange[]; admissionCounts: RuntimeAdmissionCounts }>;

// Each step remembers the run it came from; continuing from a run's latest step reuses it, an earlier one replays.
type Run = { h: Harness; inputs: Input[]; clock: { now: ClockReading }; restored: Restored; units?: UnitTable };
const runs = new WeakMap<RuntimeState, Readonly<{ run: Run; length: number }>>();
const directories: string[] = [];
afterAll(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

type Restored = Readonly<Record<RuntimeUnitId, RestoreUnitResult>>;
const empty: Restored = { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" }, "U-T": { kind: "empty" },
  "U-Q": { kind: "empty" } };

function initialPayload<K extends RuntimeUnitId>(unit: K) {
  const codec = linkedUnitCodecs[unit];
  if (codec == null) throw new Error(`${unit} has no codec`);
  return codec.encode(initialUnits[unit]);
}

// Startup restoration comes from the state directory, so each requested result is written as slot files.
function writeSlots(directory: string, restored: Restored): void {
  mkdirSync(directory, { recursive: true });
  for (const unit of ["U-E", "U-W", "U-F"] as const) {
    const result = restored[unit];
    const codec = linkedUnitCodecs[unit];
    if (codec == null) continue;
    const slot = (name: string, value: Uint8Array | string) => writeFileSync(join(directory, `${unit}-${name}.json`), value);
    const valid = (capturedAt: number, schemaVersion = codec.schemaVersion) => serializedEnvelope(hashEnvelope({
      schemaVersion, unit, generation: 1, capturedAt, payload: initialPayload(unit) }));
    if (result.kind === "restored") slot(result.slot, serializedEnvelope(hashEnvelope({ ...result.envelope })));
    else if (result.kind === "unavailable" && result.reason === "noValidSlot") slot("A", "invalid");
    else if (result.kind === "unavailable" && result.reason === "unknownSchema") slot("A", valid(1, "unknown-schema"));
    else if (result.kind === "unavailable") { slot("A", valid(1)); slot("B", valid(2)); }
  }
}

// Saves go to memory; restore reads the slot files above from disk. Without it every input's immediate save
// (P3-UWR-AC03) would wait on the real disk and the legal-bound runs would pass the test timeout.
function memoryWrites(): CheckpointFileSystem {
  const files = new Map<string, Uint8Array>();
  const disk = nodeCheckpointFileSystem();
  return { readFile: (path) => files.get(path) ?? disk.readFile(path), unlinkSync: (path) => { files.delete(path); },
    mkdir: async () => {}, rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    syncDirectory: async () => {},
    open: async (path) => {
      let bytes = new Uint8Array();
      return { write: async (data) => { bytes = data.slice(); }, sync: async () => {}, close: async () => { files.set(path, bytes); } };
    } };
}

async function open(clock: ClockReading, restored: Restored, units?: UnitTable): Promise<Run> {
  const path = mkdtempSync(join(tmpdir(), "fleq-a8-"));
  directories.push(path);
  writeSlots(join(path, "state"), restored);
  const time = { now: clock };
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs, {
    clock: () => time.now, runtimeCalls: { ...calls, units: units ?? calls.units },
    notificationAdapter: { run: () => new Promise(() => {}), abort: async () => ({}) }, reportFailure: () => {},
    checkpointFileSystem: memoryWrites() });
  const started = h.root.startRuntime("run", clock, idleChannels);
  await h.settle();
  await started;
  h.pause();
  return { h, inputs: [], clock: time, restored, units };
}

let sequence = 0;
// Applies one input synchronously: owners run in-process, so the whole exchange settles in one flush. The previous
// input's save starts at once (P3-UWR-AC03) and holds the owner's next input until it ends (AC04), so the step first
// lets that save end; the step's own save is left running, so its state stays the one before the save (P3-UWR-AC10(7)).
async function apply(run: Run, input: Input): Promise<Pick<Step, "outcomes" | "displayChanges">> {
  const { h } = run;
  await h.settle();
  const from = h.delivered.length;
  run.clock.now = input.clock;
  if (input.kind === "report") {
    const result = h.root.mailbox.enqueue(envelope(input.runId, input.report.headType, input.report.inputId, input.report.body,
      input.clock, ++sequence));
    if (result.kind !== "accepted") throw new Error(`mailbox rejected ${input.report.inputId}`);
    h.root.pump();
  } else if (input.kind === "tick") h.root.tick(input.clock);
  else h.root.dispatch(input);
  h.flush();
  if (h.failures.length !== 0) throw h.failures.shift();
  // Long corpus runs keep only what this step returns (each reply carries whole unit views).
  h.sent.length = 0;
  const outputs = h.delivered.splice(from).flatMap(({ reply }) => "output" in reply ? [reply.output] : []);
  run.inputs.push(input);
  return { outcomes: outputs.flatMap((output) => output.outcomes), displayChanges: outputs.flatMap((output) => output.displayChanges) };
}

function view(run: Run): Step["state"] {
  const { h } = run;
  const publisher = h.root.state;
  const owner = (place: (typeof places)[number]) => h.owners.get(place)!["state"]!;
  const views = (): RuntimeViews => {
    const eew = publisher.mirror["U-E"].view, weather = publisher.mirror["U-W"].view, series = publisher.mirror["U-F"].view;
    const tsunami = publisher.mirror["U-T"].view, seismic = publisher.mirror["U-Q"].view;
    if (eew.unit !== "U-E" || weather.unit !== "U-W" || series.unit !== "U-F" || tsunami.unit !== "U-T" || seismic.unit !== "U-Q")
      throw new Error("mirror view of another unit");
    return { "U-E": eew, "U-W": weather, "U-F": series, "U-T": tsunami, "U-Q": seismic };
  };
  const merged = <V>(pick: (state: ReturnType<typeof owner>) => Readonly<Partial<Record<RuntimeUnitId, V>>>) =>
    places.reduce<Partial<Record<RuntimeUnitId, V>>>((all, place) => ({ ...all, ...pick(owner(place)) }), {});
  return { runId: publisher.runId, units: { "U-E": h.unit("U-E"), "U-W": h.unit("U-W"), "U-F": h.unit("U-F"), "U-T": h.unit("U-T"),
    "U-Q": h.unit("U-Q") },
    views: views(),
    confirmation: publisher.confirmation, restoration: publisher.restoration, admission: merged((state) => state.admission),
    checkpointAttempts: merged((state) => state.checkpointAttempts),
    deadlines: { "U-E": null, "U-W": null, "U-F": null, "U-T": null, "U-Q": null, ...merged((state) => state.deadlines) },
    notificationChannels: publisher.notificationChannels, notificationProbeComplete: publisher.notificationProbeComplete,
    notificationDeadlines: publisher.notificationDeadlines, shutdown: publisher.shutdown };
}

function stepOf(run: Run, outcomes: Step["outcomes"], displayChanges: Step["displayChanges"]): Step {
  const state = view(run);
  const mirror = run.h.root.state.mirror;
  runs.set(state, { run, length: run.inputs.length });
  return { state, outcomes, displayChanges, admissionCounts: { "U-E": mirror["U-E"].admissionCounts,
    "U-W": mirror["U-W"].admissionCounts, "U-F": mirror["U-F"].admissionCounts, "U-T": mirror["U-T"].admissionCounts,
    "U-Q": mirror["U-Q"].admissionCounts } };
}

async function startup(clock: ClockReading, restored: Restored = empty, units?: UnitTable): Promise<Step> {
  const run = await open(clock, restored, units);
  const restoredOutputs = run.h.delivered.flatMap(({ reply }) => reply.kind === "restored" ? [reply.output] : []);
  return stepOf(run, restoredOutputs.flatMap((output) => output.outcomes), restoredOutputs.flatMap((output) => output.displayChanges));
}

// The next step after `state`; an older state is reached again by replaying its inputs on a new run.
async function step(state: RuntimeState, input: Input): Promise<Step> {
  const known = runs.get(state);
  if (known == null) throw new Error("step needs a state from startup() or step()");
  let { run } = known;
  if (run.inputs.length !== known.length) {
    const replay = await open(run.clock.now, run.restored, run.units);
    for (const earlier of run.inputs.slice(0, known.length)) await apply(replay, earlier);
    run = replay;
  }
  const { outcomes, displayChanges } = await apply(run, input);
  return stepOf(run, outcomes, displayChanges);
}

// The publisher state a whole-runtime description gives (A8 reads the mirror only).
function publisherOf(state: RuntimeState, counts: RuntimeAdmissionCounts): PublisherState {
  const mirror = <K extends RuntimeUnitId>(unit: K) => ({ persistence: state.units[unit].persistence,
    admissionCounts: counts[unit], view: state.views[unit],
    pendingIntents: state.units[unit].intents.filter((item) => item.disposition === "pending") });
  return { runId: state.runId, mirror: { "U-E": mirror("U-E"), "U-W": mirror("U-W"), "U-F": mirror("U-F"), "U-T": mirror("U-T"),
    "U-Q": mirror("U-Q") },
    restoration: state.restoration, confirmation: state.confirmation, notificationChannels: state.notificationChannels,
    notificationProbeComplete: state.notificationProbeComplete, notificationDeadlines: state.notificationDeadlines,
    shutdown: state.shutdown };
}

// The product A3 mapping with a fixed stream and a connected, healthy transport.
function projectionInput(value: Step, nowMs: number, overrides: Partial<SnapshotProjectionInput> = {}): SnapshotProjectionInput {
  return { ...snapshotInput({ state: publisherOf(value.state, value.admissionCounts), outcomes: value.outcomes,
    displayChanges: value.displayChanges }, "stream", nowMs, { state: "connected", disconnectedAt: null, lastInputAt: null },
  { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null }), ...overrides };
}

// Reference only (P2-A1-DISPLAY-CHANGES.acceptance): every current subject as an addition.
function allSubjects(state: RuntimeState): RuntimeDisplayChange[] {
  const changes: RuntimeDisplayChange[] = [];
  for (const item of state.units["U-E"].current) changes.push({ unit: "U-E", operation: item.operation, subject: item.subject,
    before: null, after: { unit: "U-E", operation: item.operation, subject: item.subject, office: null, current: item,
      subjects: [currentSubject(item)] } });
  for (const value of displaySubjects(state.units["U-W"]).values())
    changes.push({ unit: "U-W", operation: value.operation, subject: value.subject, before: null, after: value });
  for (const item of state.units["U-F"].subjects) changes.push({ unit: "U-F", operation: item.operation,
    subject: item.subject, before: null, after: { unit: "U-F", operation: item.operation, subject: item.subject,
      office: item.subject.slice(`${item.operation}/VPWP50/`.length), current: item,
      subjects: [timeseriesSubjectOutcome(item, [])] } });
  return changes;
}

function projected(result: SnapshotProjectionResult): Extract<SnapshotProjectionResult, { kind: "projected" }> {
  if (result.kind !== "projected") throw new Error(`expected projected, got ${result.kind}`);
  return result;
}

// Incremental byte/summary accounting must equal one serialization and a from-scratch projection.
function expectConsistent(state: SnapshotProjectionState, snapshot?: DisplaySnapshot, utf8Bytes?: number): void {
  if (snapshot != null) expect(utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(snapshot)));
  for (const key of ["eew", "weatherCurrent", "weatherTimeseries"] as const)
    expect(state.domains[key].utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(state.domains[key].full)));
}

function reference(value: Step, nowMs: number, overrides: Partial<SnapshotProjectionInput> = {}): SnapshotProjectionState {
  return projectSnapshot(projectionInput(value, nowMs, { ...overrides, outcomes: [], displayChanges: allSubjects(value.state) }), null).state;
}

function expectMatchesReference(actual: SnapshotProjectionState, expected: SnapshotProjectionState): void {
  for (const key of ["eew", "weatherCurrent", "weatherTimeseries"] as const) {
    expect(actual.domains[key].full.items).toEqual(expected.domains[key].full.items);
    expect(actual.domains[key].utf8Bytes).toBe(expected.domains[key].utf8Bytes);
    expect(actual.domains[key].areaRefs).toEqual(expected.domains[key].areaRefs);
    expect(actual.domains[key].severityRefs).toEqual(expected.domains[key].severityRefs);
    expect(actual.domains[key].timeRefs).toEqual(expected.domains[key].timeRefs);
  }
  expect(actual.domains.eew.eventRefs).toEqual(expected.domains.eew.eventRefs);
}

function atTime(xml: string, time: string): string {
  return xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`);
}

const STATUS: Readonly<Record<Operation, string>> = { normal: "通常", training: "訓練", test: "試験" };

// A real VXSE43/VXSE45 body under another EventID and/or operation.
function eewReport(eventId: string, operation: Operation = "normal", file = "37_01_01_240613_VXSE43",
  transform: (xml: string) => string = (xml) => xml): Report {
  return decode(file, file.slice(-6), (xml) => transform(xml.replace("<EventID>20240417231454</EventID>", `<EventID>${eventId}</EventID>`)
    .replace("<Status>通常</Status>", `<Status>${STATUS[operation]}</Status>`)), `${file}/${operation}/${eventId}`);
}

// Synthetic owner deltas for notice rules (contract-shaped RuntimeDisplayChange + accepted outcome).
function unavailableChange(state: RuntimeState, office: string | null,
  reason: "capacityExceeded" | "historyUnavailable" | "coverageIncomplete" = "historyUnavailable"):
  Readonly<{ change: RuntimeDisplayChange; outcome: RuntimePublishedOutcome }> {
  const row = [...displaySubjects(state.units["U-W"]).values()][0];
  const current = row.current!;
  const record = { subject: row.subject, operation: row.operation, reason, source: current.source, lastKnown: null,
    affectedScope: [JSON.stringify(["VPWW57", "partial", current.office, "all", ""])] };
  return { change: { unit: "U-W", operation: row.operation, subject: row.subject, before: row,
    after: { ...row, office, unavailable: [record] } },
  outcome: { unit: "U-W", outcome: { kind: "accepted", change: "semantic", subjects: [{ ...row.subjects[0], transition: "unavailable" }] } } };
}

function timeseriesChange(before: WeatherTimeseriesSubject | null, after: WeatherTimeseriesSubject | null):
  Readonly<{ change: RuntimeDisplayChange; outcome: RuntimePublishedOutcome }> {
  const subject = (current: WeatherTimeseriesSubject) => ({ unit: "U-F" as const, operation: current.operation,
    subject: current.subject, office: current.subject.slice(`${current.operation}/VPWP50/`.length), current,
    subjects: [timeseriesSubjectOutcome(current, [])] });
  const target = (after ?? before)!;
  return { change: { unit: "U-F", operation: target.operation, subject: target.subject,
    before: before == null ? null : subject(before), after: after == null ? null : subject(after) },
  outcome: { unit: "U-F", outcome: { kind: "accepted", change: "semantic", subjects: [timeseriesSubjectOutcome(target, [])] } } };
}

// Several runtime steps observed by one projection call (A3 may batch them).
async function combine(first: RuntimeState, inputs: readonly Input[]): Promise<Step> {
  let state = first;
  const outcomes: RuntimePublishedOutcome[] = [], displayChanges: RuntimeDisplayChange[] = [];
  let admissionCounts: RuntimeAdmissionCounts | null = null;
  for (const input of inputs) {
    const next = await step(state, input);
    outcomes.push(...next.outcomes);
    displayChanges.push(...next.displayChanges);
    admissionCounts = next.admissionCounts;
    state = next.state;
  }
  if (admissionCounts == null) throw new Error("combine needs at least one input");
  return { state, outcomes, displayChanges, admissionCounts };
}

export { allSubjects, atTime, calls, combine, decode, eewReport, expectConsistent, expectMatchesReference, projected,
  projectionInput, publisherOf, received, reference, startup, step, timeseriesChange, unavailableChange };
export type { Input, Report, Step };
