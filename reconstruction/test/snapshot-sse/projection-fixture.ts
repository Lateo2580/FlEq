import { readFileSync } from "node:fs";
import { expect } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, RuntimeDisplayChange, RuntimeInput, RuntimePublishedOutcome, RuntimeState, RuntimeStep,
} from "../../contracts/p2-shared-runtime.types";
import type { WeatherTimeseriesSubject } from "../../contracts/p2-weather-timeseries-unit.types";
import type {
  DisplaySnapshot, SnapshotProjectionInput, SnapshotProjectionResult, SnapshotProjectionState,
} from "../../contracts/p2-snapshot-sse.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedRuntimeCalls, linkedUnitCodecs } from "../../src/runtime/composition-root";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { currentSubject } from "../../src/units/eew/eew-unit";
import { displaySubjects } from "../../src/units/weather-current/weather-current-unit";
import { timeseriesSubjectOutcome } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { testNotificationChannels } from "../checkpoint-shutdown/runtime-fixture";

const calls = { ...linkedRuntimeCalls, codecs: linkedUnitCodecs };

function decode(file: string, headType: string, transform: (xml: string) => string = (xml) => xml, inputId = file): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay",
    headType, body: Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8"))) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}

let sequence = 0;
function received(runId: string, material: DecodedMaterial, clock: ClockReading): RuntimeInput {
  sequence += 1;
  return { kind: "mailboxCompleted", clock, completion: { kind: "parser", messageId: material.inputId,
    inputId: material.inputId, runId, encodedByteLength: 0, startedMonotonicMs: clock.monotonicMs,
    completedMonotonicMs: clock.monotonicMs, inputSequence: sequence, result: { kind: "decoded", material } } };
}

function startup(clock: ClockReading, restored: Extract<RuntimeInput, { kind: "startup" }>["restored"] = {
  "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } }): RuntimeStep {
  return reduceRuntime(null, { kind: "startup", runId: "run", clock, notificationChannels: testNotificationChannels, restored }, calls);
}

function step(state: RuntimeState, input: RuntimeInput): RuntimeStep {
  return reduceRuntime(state, input, calls);
}

type Step = Pick<RuntimeStep, "state" | "outcomes" | "displayChanges" | "admissionCounts">;

function projectionInput(value: Step, nowMs: number, overrides: Partial<SnapshotProjectionInput> = {}): SnapshotProjectionInput {
  const { state } = value;
  return {
    streamId: "stream", generatedAt: Number.isNaN(new Date(nowMs).getTime()) ? String(nowMs) : new Date(nowMs).toISOString(), nowMs,
    connection: { state: "connected", disconnectedAt: null, lastInputAt: null },
    worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
    persistence: { "U-E": state.units["U-E"].persistence, "U-W": state.units["U-W"].persistence,
      "U-F": state.units["U-F"].persistence },
    recovery: state.restoration, confirmation: state.confirmation, admissionCounts: value.admissionCounts,
    notificationChannels: state.notificationChannels, channelProbeComplete: state.notificationProbeComplete,
    eew: state.views["U-E"], weatherCurrent: state.views["U-W"], weatherTimeseries: state.views["U-F"],
    outcomes: value.outcomes, displayChanges: value.displayChanges, ...overrides,
  };
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
  transform: (xml: string) => string = (xml) => xml): DecodedMaterial {
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
function combine(first: RuntimeState, inputs: readonly RuntimeInput[]): Step {
  let state = first;
  const outcomes: RuntimeStep["outcomes"][number][] = [], displayChanges: RuntimeDisplayChange[] = [];
  let admissionCounts: RuntimeStep["admissionCounts"] | null = null;
  for (const input of inputs) {
    const next = step(state, input);
    outcomes.push(...next.outcomes);
    displayChanges.push(...next.displayChanges);
    admissionCounts = next.admissionCounts;
    state = next.state;
  }
  if (admissionCounts == null) throw new Error("combine needs at least one input");
  return { state, outcomes, displayChanges, admissionCounts };
}

export { allSubjects, atTime, calls, combine, decode, eewReport, expectConsistent, expectMatchesReference, projected,
  projectionInput, received, reference, startup, step, timeseriesChange, unavailableChange };
export type { Step };
