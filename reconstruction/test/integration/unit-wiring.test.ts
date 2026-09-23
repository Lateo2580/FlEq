import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, NotificationIntent, RuntimeInput, RuntimeState, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import type { WeatherCurrentInput, WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { ingestXmlData } from "../../src/ingress/ingress";
import {
  RuntimeCompositionRoot, linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem,
} from "../../src/runtime/composition-root";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { eewUnitCodec } from "../../src/units/eew/eew-unit";
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

const eewIntent: NotificationIntent = { id: "U-E:normal/VXSE43/20240417231454:1:sound", unit: "U-E",
  subject: "normal/VXSE43/20240417231454", operation: "normal", source: { inputId: "intent-source",
    origin: "replay", operation: "normal", family: "VXSE43", subject: "normal/VXSE43/20240417231454",
    reportDateTimeRaw: "2024-04-17T23:14:59+09:00", serialRaw: "1", infoTypeRaw: "発表" },
  transition: "activated", channel: "sound", payload: { operation: "normal" }, createdAt: 1, expiresAt: 15_001,
  nextAttemptAt: 1, attempts: 0, configRevision: "test", disposition: "pending" };

describe("P2 unit wiring (A1 route, A3 composition root)", () => {
  it("P2-A1-T09 regression / AC09: real EEW capacity rejection hides dedicated current until a newer adoption", () => {
    const first = decode("37_01_01_240613_VXSE43", "VXSE43");
    const at = { wallTimeMs: Date.parse(first.reportDateTimeRaw), monotonicMs: 1 };
    const initial = reduceRuntime(null, { kind: "startup", runId: "run", clock: at, restored: {
      "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" },
    } }, calls).state;
    const adopted = reduceRuntime(initial, parsed("run", first, at), calls).state;
    const current = adopted.units["U-E"].current[0];
    // Seed only the prior rejection; the follow-ups and dedicated view use the real unit.
    const state: RuntimeState = { ...adopted, admission: { "U-E": { normal: { overflow: false,
      records: [{ subject: current.subject, family: current.family,
        reportDateTimeMs: at.wallTimeMs + 2_000, affectedScope: "subject" }],
    } } } };
    const report = (offset: number) => decode("37_01_02_240613_VXSE43", "VXSE43",
      (xml) => atTime(xml, new Date(at.wallTimeMs + offset).toISOString()), `eew-${offset}`);
    const blocked = reduceRuntime(state, parsed("run", report(1_000), at), calls);
    expect(blocked.state.units["U-E"].current).toHaveLength(1);
    expect(blocked.views[0]).toMatchObject({ subjects: [], current: [], activeCount: 0,
      admission: { normal: "capacityExceeded" } });
    const cleared = reduceRuntime(blocked.state, parsed("run", report(3_000), at), calls);
    expect(cleared.state.admission["U-E"]?.normal).toBeUndefined();
    expect(cleared.views[0]).toMatchObject({ admission: {}, activeCount: 1,
      current: [{ source: { inputId: "eew-3000" } }] });
  });

  it("P2-A1-T09 regression / A1 AC09, A5 AC14: real VPNO50 ending confirms its scope and unblocks weather views", () => {
    const ending = decode("18_00_01_260830_VPNO50_switch", "VPNO50");
    const at = { wallTimeMs: Date.parse(ending.reportDateTimeRaw), monotonicMs: 1 };
    let state = fixtureState({}, {}, "run");
    for (const material of [decode("15_18_01_250630_VPWS50", "VPWS50"),
      decode("18_00_01_260830_VPWW55_fukui_L5", "VPWW55")])
      state = reduceRuntime(state, parsed("run", material, at), calls).state;
    state = { ...state, admission: { "U-W": { normal: { overflow: false, records: [{
      family: "VPNO50", subject: "normal/VPNO50/福井地方気象台", reportDateTimeMs: at.wallTimeMs,
      affectedScope: [JSON.stringify(["VPNO50", "partial", "福井地方気象台", "気象特別警報報知（府県予報区等）", "180000"])],
    }] } } } };
    const sameTime = reduceRuntime(state, parsed("run", ending, at), calls);
    expect(sameTime.views[0]).toMatchObject({ admission: { normal: "capacityExceeded" }, subjects: [], national: {}, partials: [] });
    expect(sameTime.state.units["U-W"].national.normal).toBeDefined();
    expect(sameTime.state.units["U-W"].partials).toHaveLength(1);
    const newer = decode("18_00_01_260830_VPNO50_switch", "VPNO50",
      (xml) => atTime(xml, new Date(at.wallTimeMs + 1_000).toISOString()), "ending-newer");
    const confirmed = reduceRuntime(sameTime.state, parsed("run", newer, at), calls);
    expect(confirmed.state.admission["U-W"]?.normal).toBeUndefined();
    expect(confirmed.outcomes[0]).toMatchObject({ subjects: [{ transition: "released", source: { inputId: "ending-newer" } }] });
    expect(confirmed.views[0]).toMatchObject({ admission: {}, national: { normal: expect.any(Object) }, partials: [expect.any(Object)] });
  });

  it("P2-A3-T10 regression / AC10: a rejected explicit correlation leaves adoption and its ledger untouched", async () => {
    const at = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
    const root = new RuntimeCompositionRoot(await config(), linkedUnitCodecs, { runtimeCalls: calls, clock: () => at });
    const initial = root.startRuntime("run", at).state;
    const material = decode("15_16_02_251222_VPWW57", "VPWW57", (xml) => xml, "real");
    const input = parsed("run", material, at);
    expect(() => root.dispatch(initial, input, { "U-W": { inputIds: ["wrong"], retryReason: "notRetry" } }))
      .toThrow("unverified checkpoint correlation");
    expect(root.state).toBe(initial);
    const accepted = root.dispatch(initial, input, { "U-W": { inputIds: ["real"], retryReason: "notRetry" } });
    expect(accepted.outcomes).toHaveLength(1);
    expect(accepted.generationInputIds).toEqual({ "U-W": ["real"] });
    expect((await root.shutdownRuntime(root.state, 1, at)).code).toBe(0);
  });

  it("P2-A3-T10 regression / AC10: two real intent updates in one tick preserve the whole generation interval", async () => {
    const settings = await config();
    const notices = (["desktop", "sound"] as const).map((channel) => ({ ...eewIntent, channel,
      id: `${eewIntent.subject}:1:${channel}` }));
    await fileSystem.mkdir(settings.stateDirectory, { recursive: true });
    await fileSystem.writeFile(join(settings.stateDirectory, "U-E-A.json"), serializedEnvelope(hashEnvelope({
      schemaVersion: eewUnitCodec.schemaVersion, unit: "U-E", generation: 7, capturedAt: 1,
      payload: eewUnitCodec.encode({ ...fixtureState().units["U-E"], intents: notices }),
    })));
    const at = { wallTimeMs: 10, monotonicMs: 10 };
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { clock: () => at, runtimeCalls: {
      ...calls, selectNotificationAttempt: (delivery: NotificationDeliveryState) => {
        const attempts: NotificationAttempt[] = delivery.intents.map((intent) => ({
          attemptId: `attempt-${intent.channel}`, intentId: intent.id, unit: intent.unit, subject: intent.subject,
          operation: intent.operation, channel: intent.channel, priorityGroup: "other", payload: {}, soundAsset: null,
          selectedAtMonotonicMs: at.monotonicMs, timeoutAtMonotonicMs: 1_000, expiresAt: intent.expiresAt,
        }));
        return { state: { intents: delivery.intents.map((intent) => ({ ...intent, attempts: 1, nextAttemptAt: 100 })),
          channels: { desktop: { kind: "running", attempt: attempts[0] }, sound: { kind: "running", attempt: attempts[1] } } },
        attempts, abortAttemptIds: [], dirtyUnits: ["U-E"], diagnostics: [] };
      },
    } });
    const step = root.tick(root.startRuntime("run", at).state, at);
    expect(step.state.units["U-E"].persistence.currentGeneration).toBe(9);
    expect(step.generationInputIds).toEqual({ "U-E": [] });
    expect((await root.shutdownRuntime(root.state, 0, at)).code).toBe(0);
    expect(root.state.units["U-E"].persistence.savedGeneration).toBe(9);
  });

  it("P2-A3-T09 acceptance / AC09: startup expiry advances a restored generation and saves it", async () => {
    const settings = await config();
    await fileSystem.mkdir(settings.stateDirectory, { recursive: true });
    const initial = fixtureState();
    const payload = eewUnitCodec.encode({ ...initial.units["U-E"], intents: [eewIntent] });
    const envelope = hashEnvelope({ schemaVersion: eewUnitCodec.schemaVersion,
      unit: "U-E", generation: 3, capturedAt: 10, payload });
    await fileSystem.writeFile(join(settings.stateDirectory, "U-E-A.json"), serializedEnvelope(envelope));
    const at = { wallTimeMs: 16_000, monotonicMs: 45 };
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls: calls, clock: () => at });
    const started = root.startRuntime("first", at);
    expect(started.state.units["U-E"].persistence).toMatchObject({ currentGeneration: 4,
      savedGeneration: 3, dirtySince: 45, savedCapturedAt: 10 });
    expect(started.generationInputIds).toEqual({ "U-E": [] });
    expect((await root.shutdownRuntime(root.state, 0, at)).code).toBe(0);
    const restarted = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls: calls, clock: () => at });
    expect(restarted.startRuntime("second", at).state.units["U-E"].persistence)
      .toMatchObject({ kind: "saved", currentGeneration: 4, savedGeneration: 4 });
    await restarted.diagnostics.flush();
  });

  it("P2-A3-T09 contractBoundary / AC09: an unavailable slot remains intact after a later report", async () => {
    const settings = await config();
    await fileSystem.mkdir(settings.stateDirectory, { recursive: true });
    const payload = weatherCurrentUnitCodec.encode(fixtureState().units["U-W"]);
    const bytes = serializedEnvelope(hashEnvelope({ schemaVersion: "unknown", unit: "U-W",
      generation: 9, capturedAt: 10, payload }));
    const slot = join(settings.stateDirectory, "U-W-A.json");
    await fileSystem.writeFile(slot, bytes);
    const at = { wallTimeMs: 1_800_000_000_000, monotonicMs: 4 };
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls: calls, clock: () => at });
    expect(root.startRuntime("run", at).state.restoration["U-W"]).toEqual({ kind: "unavailable", reason: "unknownSchema" });
    root.dispatch(root.state, parsed("run", decode("15_16_02_251222_VPWW57", "VPWW57"), at));
    expect((await root.shutdownRuntime(root.state, 1, at)).code).toBe(2);
    expect(await fileSystem.readFile(slot)).toEqual(Buffer.from(bytes));
  });
  it("P2-A3-T10 contractBoundary / AC10: an EEW parser step cannot attribute another unit's deadline generation", () => {
    const at = { wallTimeMs: 1_713_363_299_001, monotonicMs: 4 };
    const initial = fixtureState({}, { "U-W": { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null } }, "run");
    const state = { ...initial, deadlines: { ...initial.deadlines,
      "U-E": null, "U-W": { wallTimeMs: null, monotonicMs: at.monotonicMs }, "U-F": null } };
    const step = reduceRuntime(state, parsed("run", decode("37_01_01_240613_VXSE43", "VXSE43"), at), {
      ...calls, reduceWeatherCurrentUnit: (unit: WeatherCurrentUnitState, input: WeatherCurrentInput) =>
        input.kind === "deadline" ? { state: { ...unit, persistence: { ...unit.persistence,
          kind: "pending" as const, currentGeneration: 1, dirtySince: at.monotonicMs } },
          nextDeadline: null, decisions: [], intents: [], outcomes: [], diagnostics: [] }
          : calls.reduceWeatherCurrentUnit(unit, input),
    });
    expect(step.changedUnits).toEqual(["U-E", "U-W"]);
    expect(step.generationInputIds).toEqual({ "U-W": [] });
  });

  it("P2-A3-T10 contractBoundary / AC10: an empty later generation retains only unsaved earlier input IDs", async () => {
    const at = { wallTimeMs: 1_800_000_000_000, monotonicMs: 4 };
    const first = decode("15_16_02_251222_VPWW57", "VPWW57");
    const stale = decode("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2020-06-22T22:59:00+09:00"), "stale");
    for (const savedFirst of [false, true]) {
      const measured: string[][] = [];
      const root = new RuntimeCompositionRoot(await config(), linkedUnitCodecs, { runtimeCalls: calls,
        clock: () => at, onMeasurements: (items) => {
          for (const item of items) if (item.unit === "U-W" && item.stage === "encode")
            measured.push([...item.inputIds]);
        } });
      root.startRuntime("run", at);
      root.dispatch(root.state, parsed("run", first, at));
      if (savedFirst) await save(root, "U-W", [first.inputId], () => at);
      const latest = root.dispatch(root.state, parsed("run", stale, at));
      expect(latest.generationInputIds).toEqual({ "U-W": [] });
      expect((await root.shutdownRuntime(root.state, 2, at)).code).toBe(0);
      expect(measured.at(-1)).toEqual(savedFirst ? [] : [first.inputId]);
    }
  });
  it("P2-WIRE-T01 acceptance / A3 AC09, A5 AC03, AC07-08: parsed U-W save and product restart", async () => {
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

    expect(() => root.dispatch(fixtureState({}, {}, "run-1"), parsed("run-1", first, clock())))
      .toThrow("runtime has not received its initial state");
    const received = root.dispatch(root.startRuntime("run-1", clock()).state, parsed("run-1", first, clock()));
    expect(received.changedUnits).toEqual(["U-W"]);
    expect(received.views).toMatchObject([{ unit: "U-W", subjects: [{ transition: "active", source: { inputId: first.inputId } }] }]);
    const national = decode("15_18_01_250630_VPWS50", "VPWS50");
    root.dispatch(root.state, parsed("run-1", national, clock()));
    expect((await save(root, "U-W", [first.inputId, national.inputId], clock)).units["U-W"].persistence.kind).toBe("saved");

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
    const startup = restarted.startRuntime("run-2", clock());
    const resumed = startup.state;
    expect(resumed.units["U-W"].partials[0].source.inputId).toBe("second");
    expect(startup.views.find((view) => view.unit === "U-W")).toMatchObject({ national: {}, partials: [],
      subjects: [expect.objectContaining({ transition: "restoredUnconfirmed", facts: expect.objectContaining({
        currentConfirmed: false, savedCapturedAt: resumed.units["U-W"].persistence.savedCapturedAt,
      }) }), expect.objectContaining({ transition: "restoredUnconfirmed" })] });
    const third = decode("15_16_02_251222_VPWW57", "VPWW57", (xml) => atTime(xml, "2020-06-22T23:02:00+09:00"), "third");
    const followUp = restarted.dispatch(resumed, parsed("run-2", third, clock()));
    expect(followUp.changedUnits).toEqual(["U-W"]);
    expect(followUp.state.units["U-W"].partials[0].source.inputId).toBe("third");
    expect(followUp.state.units["U-W"].persistence.currentGeneration).toBeGreaterThan(generation);
    expect(followUp.views[0]).toMatchObject({ national: {}, partials: [{ source: { inputId: "third" } }],
      subjects: [expect.objectContaining({ transition: "restoredUnconfirmed" }), expect.objectContaining({ transition: "active" })] });
    // No caller correlation: the root attributes the routed input, so normal shutdown saves it.
    expect((await restarted.shutdownRuntime(restarted.state, 1, clock())).code).toBe(0);
    const saved = restarted.restoreUnit("U-W");
    expect(saved).toMatchObject({ kind: "restored", envelope: { generation: generation + 1 } });
    const finalRoot = new RuntimeCompositionRoot(settings, linkedUnitCodecs, options);
    const again = finalRoot.startRuntime("run-3", clock()).state;
    expect(again.units["U-W"].partials[0].source.inputId).toBe("third");
    await Promise.all([root.diagnostics.flush(), restarted.diagnostics.flush(), finalRoot.diagnostics.flush()]);
  });

  it("P2-WIRE-T05 regression / A10 AC09: automatic attribution excludes inputs saved by an older ack", async () => {
    let now = 1_800_000_000_000;
    const clock = () => ({ wallTimeMs: now, monotonicMs: now });
    const measured: { unit: string; generation: number; inputIds: readonly string[] }[] = [];
    const files = nodeCheckpointFileSystem();
    let signalOpen!: () => void;
    let releaseOpen!: () => void;
    const openStarted = new Promise<void>((resolve) => { signalOpen = resolve; });
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const settings = await config();
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls: calls, clock,
      checkpointFileSystem: { ...files, open: async (path) => { signalOpen(); await openGate; return files.open(path); } },
      onMeasurements: (items) => measured.push(...items.map(({ unit, generation, inputIds }) => ({ unit, generation, inputIds }))) });
    const first = decode("15_16_02_251222_VPWW57", "VPWW57");
    const second = decode("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2020-06-22T23:01:00+09:00"), "second");
    const third = decode("15_16_02_251222_VPWW57", "VPWW57",
      (xml) => atTime(xml, "2020-06-22T23:02:00+09:00"), "third");

    root.dispatch(root.startRuntime("run", clock()).state, parsed("run", first, clock()));
    const firstSave = save(root, "U-W", [first.inputId], clock);
    await openStarted;
    now++;
    root.dispatch(root.state, parsed("run", second, clock()));
    releaseOpen();
    await firstSave;
    expect(root.state.units["U-W"].persistence).toMatchObject({ currentGeneration: 2, savedGeneration: 1 });
    now++;
    root.dispatch(root.state, parsed("run", third, clock()));
    await root.shutdownRuntime(root.state, 1, clock());

    expect(measured.filter(({ unit }) => unit === "U-W").at(-1)?.inputIds)
      .toEqual(["second", "third"]);
  });

  it("P2-WIRE-T06 regression / A10 AC09: current-only input cannot contribute to an unsaved EEW generation", async () => {
    const clock = () => ({ wallTimeMs: 1_713_363_299_001, monotonicMs: 1 });
    const eewMeasured: { unit: string; inputIds: readonly string[] }[] = [];
    const settings = await config();
    await fileSystem.mkdir(settings.stateDirectory, { recursive: true });
    await fileSystem.writeFile(join(settings.stateDirectory, "U-E-A.json"), serializedEnvelope(hashEnvelope({
      schemaVersion: eewUnitCodec.schemaVersion, unit: "U-E", generation: 1, capturedAt: 1,
      payload: eewUnitCodec.encode({ ...fixtureState().units["U-E"], intents: [eewIntent] }),
    })));
    const eewRoot = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls: calls, clock,
      onMeasurements: (items) => eewMeasured.push(...items.map(({ unit, inputIds }) => ({ unit, inputIds }))) });
    const eewSeeded = eewRoot.startRuntime("eew-run", clock()).state;
    const currentOnly = decode("37_01_01_240613_VXSE43", "VXSE44", (xml) => xml, "current-only");
    const currentStep = eewRoot.dispatch(eewSeeded, parsed("eew-run", currentOnly, clock()));
    expect(currentStep.changedUnits).toEqual(["U-E"]);
    expect(currentStep.state.units["U-E"].persistence.currentGeneration).toBe(2);
    const cancelled = decode("37_01_03_240613_VXSE43", "VXSE43", (xml) => xml, "cancel");
    eewRoot.dispatch(currentStep.state, parsed("eew-run", cancelled, clock()));
    expect(await eewRoot.shutdownRuntime(eewRoot.state, 1, clock())).toMatchObject({ code: 0 });
    expect(eewMeasured.filter(({ unit }) => unit === "U-E").every(({ inputIds }) => inputIds.length === 0)).toBe(true);
    expect(eewMeasured.some(({ unit }) => unit === "U-E")).toBe(true);
  });

  it("P2-WIRE-T02 acceptance / A4 AC04, AC08 follow-up: parsed EEW is active, leaves nothing durable, and a restart follow-up becomes current", async () => {
    let now = 1_713_363_299_001;
    const clock = () => ({ wallTimeMs: now, monotonicMs: now });
    const settings = await config();
    const options = { runtimeCalls: calls, clock };
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, options);
    const first = decode("37_01_01_240613_VXSE43", "VXSE43");

    const received = root.dispatch(root.startRuntime("run-1", clock()).state, parsed("run-1", first, clock()));
    expect(received.changedUnits).toEqual(["U-E"]);
    expect(received.views).toMatchObject([{ unit: "U-E", activeCount: 1 }]);
    expect((await root.shutdownRuntime(root.state, 1, clock())).code).toBe(0);

    now++;
    const restarted = new RuntimeCompositionRoot(settings, linkedUnitCodecs, options);
    expect(restarted.restoreUnit("U-E")).toEqual({ kind: "empty" }); // active EEW is never durable (AC04)
    const resumed = restarted.startRuntime("run-2", clock()).state;
    const followUp = restarted.dispatch(resumed, parsed("run-2", decode("37_01_02_240613_VXSE43", "VXSE43"), clock()));
    expect(followUp.changedUnits).toEqual(["U-E"]);
    expect(followUp.state.units["U-E"].current.map((item) => item.serial)).toEqual([2]);
    await restarted.diagnostics.flush();
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
