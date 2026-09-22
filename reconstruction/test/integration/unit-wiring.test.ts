import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, RuntimeInput, RuntimeState, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import {
  RuntimeCompositionRoot, linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem,
} from "../../src/runtime/composition-root";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { fixtureState } from "../checkpoint-shutdown/runtime-fixture";

// A6 is not delivered: shutdown and deadlines still visit U-F, so it stays empty explicitly.
const calls = { ...linkedRuntimeCalls, reduceWeatherTimeseriesUnit: (state: WeatherTimeseriesUnitState) =>
  ({ state, nextDeadline: null, decisions: [], intents: [], outcomes: [], diagnostics: [] }) };
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await fileSystem.rm(path, { recursive: true, force: true });
});

async function config() {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-p2-wiring-"));
  temporary.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

function decode(file: string, headType: string, transform: (xml: string) => string = (xml) => xml, inputId = file): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay",
    headType, body: Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8"))) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}

function atTime(xml: string, time: string): string {
  return xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`);
}

function parsed(runId: string, material: DecodedMaterial, clock: ClockReading): RuntimeInput {
  return { kind: "mailboxCompleted", clock, completion: { kind: "parser", messageId: material.inputId,
    inputId: material.inputId, runId, encodedByteLength: 0, startedMonotonicMs: clock.monotonicMs,
    completedMonotonicMs: clock.monotonicMs, inputSequence: 1, result: { kind: "decoded", material } } };
}

async function save(root: RuntimeCompositionRoot, unit: RuntimeUnitId, inputIds: readonly string[], clock: () => ClockReading) {
  const scheduled = root.scheduleCheckpoint(root.state, clock(), root.state.runId, { [unit]: { inputIds, retryReason: "notRetry" } });
  if (scheduled?.request == null) throw new Error(`${unit} checkpoint was not captured`);
  const executed = await root.executeCheckpoint(scheduled.request, root.state.runId, inputIds, "notRetry");
  return root.applyCheckpointResult(root.state, executed.result, clock()).state;
}

// The startup entry is not wired yet: restore by hand and continue the restored generation,
// otherwise the next save (generation 1) loses to the older slot on the following restart.
function restart(root: RuntimeCompositionRoot, clock: ClockReading, runId: string): RuntimeState {
  const restored = root.restoreUnit("U-W");
  if (restored.kind !== "restored") throw new Error("U-W was not restored");
  const { generation, capturedAt, payload } = restored.envelope;
  const decoded = weatherCurrentUnitCodec.decode(payload);
  if (decoded.kind !== "restored") throw new Error(decoded.reason);
  const initial = fixtureState({}, { "U-W": { kind: "saved", currentGeneration: generation, savedGeneration: generation,
    savedCapturedAt: capturedAt, savedAckAt: null, dirtySince: null } }, runId);
  const unit = calls.reduceWeatherCurrentUnit(initial.units["U-W"],
    { kind: "restore", persisted: weatherCurrentUnitCodec.encode(decoded.state), clock }).state;
  return { ...initial, units: { ...initial.units, "U-W": unit }, deadlines: { "U-E": null, "U-W": null, "U-F": null } };
}

describe("P2 unit wiring (A1 route, A3 composition root)", () => {
  it("P2-WIRE-T01 acceptance / A5 AC03, AC07 save failure+shutdown, AC08 follow-up: parsed U-W input through a hand-built restart", async () => {
    let now = 1_800_000_000_000;
    const clock = () => ({ wallTimeMs: now, monotonicMs: now });
    const files = nodeCheckpointFileSystem();
    let failWrite = false;
    const options = { runtimeCalls: calls, clock, checkpointFileSystem: { ...files,
      open: (path: string) => failWrite ? Promise.reject(new Error("injected write failure")) : files.open(path) } };
    const settings = await config();
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, options);
    const first = decode("15_16_02_251222_VPWW57", "VPWW57");
    const second = decode("15_16_02_251222_VPWW57", "VPWW57", (xml) => atTime(xml, "2020-06-22T23:01:00+09:00"), "second");

    const received = root.dispatch(fixtureState({}, {}, "run-1"), parsed("run-1", first, clock()));
    expect(received.changedUnits).toEqual(["U-W"]);
    expect(received.views).toMatchObject([{ unit: "U-W", subjects: [{ transition: "active", source: { inputId: first.inputId } }] }]);
    expect((await save(root, "U-W", [first.inputId], clock)).units["U-W"].persistence.kind).toBe("saved");

    now++;
    root.dispatch(root.state, parsed("run-1", second, clock()));
    failWrite = true;
    const failed = await save(root, "U-W", [second.inputId], clock);
    expect(failed.units["U-W"].persistence.kind).toBe("failed");
    expect(failed.units["U-W"].partials[0].source.inputId).toBe("second");
    failWrite = false;
    const summary = await root.shutdownRuntime(root.state, 2, clock());
    const generation = root.state.units["U-W"].persistence.currentGeneration;
    expect(summary).toMatchObject({ code: 0, persistence: { "U-W": { kind: "saved", savedGeneration: generation } } });

    now++;
    const restarted = new RuntimeCompositionRoot(settings, linkedUnitCodecs, options);
    const resumed = restart(restarted, clock(), "run-2");
    expect(resumed.units["U-W"].partials[0].source.inputId).toBe("second");
    const third = decode("15_16_02_251222_VPWW57", "VPWW57", (xml) => atTime(xml, "2020-06-22T23:02:00+09:00"), "third");
    const followUp = restarted.dispatch(resumed, parsed("run-2", third, clock()));
    expect(followUp.changedUnits).toEqual(["U-W"]);
    expect(followUp.state.units["U-W"].partials[0].source.inputId).toBe("third");
    expect(followUp.state.units["U-W"].persistence.currentGeneration).toBeGreaterThan(generation);
    // No caller correlation: the root attributes the routed input, so normal shutdown saves it.
    expect((await restarted.shutdownRuntime(restarted.state, 1, clock())).code).toBe(0);
    const saved = restarted.restoreUnit("U-W");
    expect(saved).toMatchObject({ kind: "restored", envelope: { generation: generation + 1 } });
  });

  it("P2-WIRE-T02 acceptance / A4 AC04, AC08 follow-up: parsed EEW is active, leaves nothing durable, and a restart follow-up becomes current", async () => {
    let now = 1_713_363_299_001;
    const clock = () => ({ wallTimeMs: now, monotonicMs: now });
    const settings = await config();
    const options = { runtimeCalls: calls, clock };
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, options);
    const first = decode("37_01_01_240613_VXSE43", "VXSE43");

    const received = root.dispatch(fixtureState({}, {}, "run-1"), parsed("run-1", first, clock()));
    expect(received.changedUnits).toEqual(["U-E"]);
    expect(received.views).toMatchObject([{ unit: "U-E", activeCount: 1 }]);
    expect((await root.shutdownRuntime(root.state, 1, clock())).code).toBe(0);

    now++;
    const restarted = new RuntimeCompositionRoot(settings, linkedUnitCodecs, options);
    expect(restarted.restoreUnit("U-E")).toEqual({ kind: "empty" }); // active EEW is never durable (AC04)
    const resumed = fixtureState({}, {}, "run-2");
    const followUp = restarted.dispatch(resumed, parsed("run-2", decode("37_01_02_240613_VXSE43", "VXSE43"), clock()));
    expect(followUp.changedUnits).toEqual(["U-E"]);
    expect(followUp.state.units["U-E"].current.map((item) => item.serial)).toEqual([2]);
  });

  it("P2-WIRE-T03 contractBoundary / A1 route: a routed rejection yields one unit diagnostic and no business change", () => {
    const state = fixtureState({}, {}, "run");
    const material = { ...decode("15_16_02_251222_VPWW57", "VPWW57"), reportDateTimeRaw: "" };
    const clock = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
    const step = reduceRuntime(state, parsed("run", material, clock), calls);
    expect(step.diagnostics.map((item) => item.reason)).toEqual(["reportDateTimeMissing"]);
    // Routed, not dropped: U-W records the §7.8 freshness target while its business state stays.
    expect(step.changedUnits).toEqual(["U-W"]);
    expect(step.state.units["U-W"].freshness).toMatchObject([{ decision: "rejected", revisionOrder: "unknown" }]);
    expect(step.state.units["U-W"].partials).toBe(state.units["U-W"].partials);
    expect(step.state.units["U-W"].national).toBe(state.units["U-W"].national);
  });

  it("P2-WIRE-T04 contractBoundary / A1 shutdown: input completed after mailboxDrain is not applied to units", () => {
    const running = fixtureState({}, {}, "run");
    const state = { ...running, shutdown: { ...running.shutdown, stage: "sideEffectFinalization" as const } };
    const clock = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
    const step = reduceRuntime(state, parsed("run", decode("15_16_02_251222_VPWW57", "VPWW57"), clock), calls);
    expect(step.changedUnits).toEqual([]);
    expect(step.state.units).toBe(state.units);
  });
});
