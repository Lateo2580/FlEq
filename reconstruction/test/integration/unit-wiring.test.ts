import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, RuntimeInput, RuntimeState, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import type { WeatherCurrentInput, WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { CheckpointCoordinator, hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import { OwnerHost } from "../../src/runtime/owner-host";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { deadlineOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { eewUnitCodec } from "../../src/units/eew/eew-unit";
import { weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { fixtureState , ownerFixture, testNotificationChannels, recordingNotificationAdapter} from "../checkpoint-shutdown/runtime-fixture";

const calls = { ...linkedRuntimeCalls,
  selectNotificationAttempt: (delivery: NotificationDeliveryState) => ({ state: delivery,
    attempts: [], abortRequests: [], diagnostics: [] }),
};
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

// TEST-PATH (1): one parser input to the owner core.
function received(owner: OwnerState, material: DecodedMaterial, clock: ClockReading) {
  return receiveOwner(owner, { runId: owner.runId, inputId: material.inputId, result: { kind: "decoded", material } },
    clock, calls.units);
}

const eewIntent: EewUnitState["intents"][number] = { id: "U-E:normal/VXSE43/20240417231454:1:sound", unit: "U-E",
  subject: "normal/VXSE43/20240417231454", operation: "normal", source: { inputId: "intent-source",
    origin: "replay", operation: "normal", family: "VXSE43", subject: "normal/VXSE43/20240417231454",
    reportDateTimeRaw: "2024-04-17T23:14:59+09:00", serialRaw: "1", infoTypeRaw: "発表" },
  transition: "activated", channel: "sound", payload: { domain: "earthquake-eew", level: "critical", title: "緊急地震速報（警報）", body: "地震" }, createdAt: 1, expiresAt: 15_001,
  nextAttemptAt: 1, attempts: 0, configRevision: "test", disposition: "pending" };

// TEST-PATH (2): the publisher and its in-process owners; parser inputs travel as the host would enqueue them.
function wired(settings: Awaited<ReturnType<typeof config>>, options: Omit<Parameters<typeof harnessedRoot>[2] & object, never> = {}) {
  return harnessedRoot(settings, linkedUnitCodecs, { notificationAdapter: recordingNotificationAdapter(), runtimeCalls: calls, ...options });
}
let inputSequence = 0;
function report(file: string, transform: (xml: string) => string = (xml) => xml): Buffer {
  return Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8")));
}
function send(h: Harness, runId: string, file: string, headType: string, clock: ClockReading,
  transform: (xml: string) => string = (xml) => xml, inputId = file) {
  return submit(h, envelope(runId, headType, inputId, report(file, transform), clock, ++inputSequence));
}
// The slot a restart would read, through the owner-side coordinator.
function slot(settings: Awaited<ReturnType<typeof config>>, unit: RuntimeUnitId) {
  return new CheckpointCoordinator(settings.stateDirectory, linkedUnitCodecs, nodeCheckpointFileSystem(),
    () => ({ wallTimeMs: 0, monotonicMs: 0 }), () => {}).restoreUnit(unit);
}
async function save(h: Harness) {
  await h.root.driveCheckpoint();
  await h.settle();
}
describe("P2 unit wiring (A1 route, A3 composition root)", () => {
  it("P2-A3-A8-LINK regression: dispatch preserves the observed disconnect clock and sequence", async () => {
    const at = { wallTimeMs: 1_800_000_000_000, monotonicMs: 20 };
    const h = wired(await config(), { clock: () => at });
    await startHarness(h, "run", at, false);
    const started = h.root.state;
    expect(h.root.lastDisconnectedAt).toBeNull();
    h.root.dispatch({ kind: "connectionLost", clock: { ...at, wallTimeMs: at.wallTimeMs - 10 }, acceptedThroughSequence: 17 });
    expect(h.root.lastDisconnectedAt).toBe(at.wallTimeMs - 10);
    expect(h.root.state.confirmation).toMatchObject({ epoch: 1, afterInputSequence: 17 });
    expect(h.root.state.mirror).toBe(started.mirror);
    h.root.dispatch({ kind: "notificationProbeCompleted", channels: testNotificationChannels, clock: at });
    expect(h.root.lastDisconnectedAt).toBe(at.wallTimeMs - 10);
  });

  it("P2-A1-T09 regression / AC09: real EEW capacity rejection hides dedicated current until a newer adoption", () => {
    const first = decode("37_01_01_240613_VXSE43", "VXSE43");
    const at = { wallTimeMs: Date.parse(first.reportDateTimeRaw), monotonicMs: 1 };
    const initial = restoreOwner({ runId: "run", place: "urgent", clock: at, restored: { "U-E": { kind: "empty" } } },
      calls.units, linkedUnitCodecs).state;
    const adopted = received(initial, first, at).state;
    const current = adopted.units["U-E"]!.current[0];
    // Seed only the prior rejection; the follow-ups and dedicated view use the real unit.
    const state: OwnerState = { ...adopted, admission: { "U-E": { normal: { overflow: false,
      records: [{ subject: current.subject, family: current.family,
        reportDateTimeMs: at.wallTimeMs + 2_000, affectedScope: "subject" }],
    } } } };
    const report = (offset: number) => decode("37_01_02_240613_VXSE43", "VXSE43",
      (xml) => atTime(xml, new Date(at.wallTimeMs + offset).toISOString()), `eew-${offset}`);
    const blocked = received(state, report(1_000), at);
    expect(blocked.state.units["U-E"]?.current).toHaveLength(1);
    expect(blocked.views[0]).toMatchObject({ subjects: [], current: [], activeCount: 0,
      admission: { normal: "capacityExceeded" } });
    const cleared = received(blocked.state, report(3_000), at);
    expect(cleared.state.admission["U-E"]?.normal).toBeUndefined();
    expect(cleared.views[0]).toMatchObject({ admission: {}, activeCount: 1,
      current: [{ source: { inputId: "eew-3000" } }] });
  });

  it("P2-A1-T09 regression / A1 AC09, A5 AC14: real VPNO50 ending confirms its scope and unblocks weather views", () => {
    const ending = decode("18_00_01_260830_VPNO50_switch", "VPNO50");
    const at = { wallTimeMs: Date.parse(ending.reportDateTimeRaw), monotonicMs: 1 };
    let state = ownerFixture("weatherCurrent", fixtureState({}, {}, "run"));
    for (const material of [decode("15_18_01_250630_VPWS50", "VPWS50"),
      decode("18_00_01_260830_VPWW55_fukui_L5", "VPWW55")])
      state = received(state, material, at).state;
    state = { ...state, admission: { "U-W": { normal: { overflow: false, records: [{
      family: "VPNO50", subject: "normal/VPNO50/福井地方気象台", reportDateTimeMs: at.wallTimeMs,
      affectedScope: [JSON.stringify(["VPNO50", "partial", "福井地方気象台", "気象特別警報報知（府県予報区等）", "180000"])],
    }] } } } };
    const sameTime = received(state, ending, at);
    expect(sameTime.views[0]).toMatchObject({ admission: { normal: "capacityExceeded" }, subjects: [], national: {}, partials: [] });
    expect(sameTime.state.units["U-W"]?.national.normal).toBeDefined();
    expect(sameTime.state.units["U-W"]?.partials).toHaveLength(1);
    const newer = decode("18_00_01_260830_VPNO50_switch", "VPNO50",
      (xml) => atTime(xml, new Date(at.wallTimeMs + 1_000).toISOString()), "ending-newer");
    const confirmed = received(sameTime.state, newer, at);
    expect(confirmed.state.admission["U-W"]?.normal).toBeUndefined();
    expect(confirmed.outcomes[0]).toMatchObject({ unit: "U-W", outcome: {
      subjects: [{ transition: "released", source: { inputId: "ending-newer" } }] } });
    expect(confirmed.views[0]).toMatchObject({ admission: {}, national: { normal: expect.any(Object) }, partials: [expect.any(Object)] });
  });

  it("P2-A3-T10 regression / AC10: a save carries exactly the input IDs of its unsaved generations", async () => {
    // TEST-PATH (1) (X4, D5 revised): the owner's generation ledger is the only correlation; a grant reads it.
    const at = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
    const settings = await config();
    const replies: OwnerReply[] = [];
    const owner = new OwnerHost({ start: { place: "weatherCurrent", stateDirectory: settings.stateDirectory, publisherTimeOriginMs: 0, measured: false },
      units: calls.units, codecs: linkedUnitCodecs, fileSystem: nodeCheckpointFileSystem(), sharedNow: () => 1,
      reply: (reply) => { replies.push(reply); }, fail: (error) => { throw error; } });
    owner.handle({ kind: "restore", runId: "run", clock: at, sharedMs: 1 });
    owner.handle({ kind: "input", clock: at, sharedMs: 1,
      envelope: envelope("run", "VPWW57", "real", report("15_16_02_251222_VPWW57"), at) });
    owner.handle({ kind: "checkpointGrant", grantId: "grant-1", unit: "U-W", mode: "save", retryReason: "notRetry", clock: at, sharedMs: 1 });
    await vi.waitFor(() => expect(replies.at(-1)?.kind).toBe("checkpointDone"));
    const done = replies.at(-1)!;
    if (done.kind !== "checkpointDone") throw new Error("checkpointDone expected");
    expect(done.result?.kind).toBe("acknowledged");
    expect(done.measurements.map((measurement) => measurement.inputIds)).toEqual(done.measurements.map(() => ["real"]));
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
    const adapter = manualAdapter();
    const h = wired(settings, { clock: () => at, notificationAdapter: adapter.adapter, runtimeCalls: {
      // Each idle channel selects its own unattempted intent (A7 evaluates the channels independently).
      ...calls, selectNotificationAttempt: (delivery: NotificationDeliveryState) => {
        const chosen = delivery.intents.filter((intent) => intent.attempts === 0 && delivery.channels[intent.channel].kind === "idle");
        const attempts: NotificationAttempt[] = chosen.map((intent) => ({
          attemptId: `attempt-${intent.channel}`, intentId: intent.id, unit: intent.unit, subject: intent.subject,
          operation: intent.operation, channel: intent.channel, priorityGroup: "other", payload: {}, soundAsset: null,
          selectedAtMonotonicMs: at.monotonicMs, timeoutAtMonotonicMs: 1_000, expiresAt: intent.expiresAt,
        }));
        const channels = { ...delivery.channels };
        for (const attempt of attempts) channels[attempt.channel] = { kind: "running", attempt };
        return { state: { intents: delivery.intents.map((intent) => chosen.includes(intent) ? { ...intent, attempts: 1, nextAttemptAt: 100 } : intent),
          channels, deadlines: delivery.deadlines }, attempts, abortRequests: [], diagnostics: [] };
      },
    } });
    await startHarness(h, "run", at, false);
    expect(h.root.state.mirror["U-E"].persistence.currentGeneration).toBe(7);
    h.root.dispatch({ kind: "notificationProbeCompleted", channels: testNotificationChannels, clock: at });
    h.root.tick(at);
    await h.settle();
    // Each reservation is one owner update (AC11(d)); both are adopted before either attempt starts.
    expect(h.root.state.mirror["U-E"].persistence.currentGeneration).toBe(9);
    expect(adapter.runs.map((run) => run.attempt.channel)).toEqual(["desktop", "sound"]);
    for (const { attempt } of adapter.runs) adapter.finish({ kind: "delivered", attemptId: attempt.attemptId,
      intentId: attempt.intentId, channel: attempt.channel, completedAt: at });
    await h.settle();
    expect((await h.root.shutdownRuntime(0, at)).code).toBe(0);
    // The final save covers every generation the updates made (the owner ledger had each one).
    expect(h.root.state.mirror["U-E"].persistence.savedGeneration).toBe(h.root.state.mirror["U-E"].persistence.currentGeneration);
  });

  it("P2-A3-T09 acceptance / AC09: startup expiry advances a restored generation and saves it", async () => {
    const settings = await config();
    await fileSystem.mkdir(settings.stateDirectory, { recursive: true });
    const initial = fixtureState();
    const payload = eewUnitCodec.encode({ ...initial.units["U-E"], intents: [eewIntent] });
    const envelopeBytes = hashEnvelope({ schemaVersion: eewUnitCodec.schemaVersion,
      unit: "U-E", generation: 3, capturedAt: 10, payload });
    await fileSystem.writeFile(join(settings.stateDirectory, "U-E-A.json"), serializedEnvelope(envelopeBytes));
    const at = { wallTimeMs: 16_000, monotonicMs: 45 };
    const h = wired(settings, { clock: () => at });
    await startHarness(h, "first", at, false);
    expect(h.root.state.mirror["U-E"].persistence).toMatchObject({ currentGeneration: 4,
      savedGeneration: 3, dirtySince: 45, savedCapturedAt: 10 });
    expect((await h.root.shutdownRuntime(0, at)).code).toBe(0);
    const restarted = wired(settings, { clock: () => at });
    await startHarness(restarted, "second", at, false);
    expect(restarted.root.state.mirror["U-E"].persistence).toMatchObject({ kind: "saved", currentGeneration: 4, savedGeneration: 4 });
    await Promise.all([h.root.diagnostics.flush(), restarted.root.diagnostics.flush()]);
  });

  it("P2-A3-T09 contractBoundary / AC09: an unavailable slot remains intact after a later report", async () => {
    const settings = await config();
    await fileSystem.mkdir(settings.stateDirectory, { recursive: true });
    const payload = weatherCurrentUnitCodec.encode(fixtureState().units["U-W"]);
    const bytes = serializedEnvelope(hashEnvelope({ schemaVersion: "unknown", unit: "U-W",
      generation: 9, capturedAt: 10, payload }));
    const path = join(settings.stateDirectory, "U-W-A.json");
    await fileSystem.writeFile(path, bytes);
    const at = { wallTimeMs: 1_800_000_000_000, monotonicMs: 4 };
    const h = wired(settings, { clock: () => at });
    await startHarness(h, "run", at, false);
    expect(h.root.state.restoration["U-W"]).toEqual({ kind: "unavailable", reason: "unknownSchema" });
    await send(h, "run", "15_16_02_251222_VPWW57", "VPWW57", at);
    expect((await h.root.shutdownRuntime(1, at)).code).toBe(2);
    expect(await fileSystem.readFile(path)).toEqual(Buffer.from(bytes));
    await h.root.diagnostics.flush();
  });

  it("P2-A3-T10 contractBoundary / AC10: an EEW parser step cannot attribute another unit's deadline generation", () => {
    // TEST-PATH (1). AC11(c): another unit's deadline is applied by its own owner on its deadline request, never in the
    // EEW input's step, so the two generations are attributed by separate owner steps.
    const at = { wallTimeMs: 1_713_363_299_001, monotonicMs: 4 };
    const initial = fixtureState({}, { "U-W": { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null } }, "run");
    const state = { ...initial, units: { ...initial.units,
      "U-E": { ...initial.units["U-E"], notificationLatches: [] } }, deadlines: { ...initial.deadlines,
      "U-E": null, "U-W": { wallTimeMs: null, monotonicMs: at.monotonicMs }, "U-F": null } };
    const units = { ...calls.units, "U-W": { ...calls.units["U-W"],
      reduce: (unit: WeatherCurrentUnitState, input: WeatherCurrentInput) =>
        input.kind === "deadline" ? { state: { ...unit, persistence: { ...unit.persistence,
          kind: "pending" as const, currentGeneration: 1, dirtySince: at.monotonicMs } },
          nextDeadline: null, decisions: [], intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] }
          : calls.units["U-W"].reduce(unit, input) } };
    const material = decode("37_01_01_240613_VXSE43", "VXSE43");
    const eew = receiveOwner(ownerFixture("urgent", state), { runId: "run", inputId: material.inputId,
      result: { kind: "decoded", material } }, at, units);
    expect(eew.changedUnits).toEqual(["U-E"]);
    expect(eew.generationInputIds).toEqual({ "U-E": ["37_01_01_240613_VXSE43"] });
    const weather = deadlineOwner(ownerFixture("weatherCurrent", state), at, units);
    expect(weather.changedUnits).toEqual(["U-W"]);
    expect(weather.generationInputIds).toEqual({ "U-W": [] });
  });

  it("P2-A3-T10 contractBoundary / AC10: an empty later generation retains only unsaved earlier input IDs", async () => {
    const at = { wallTimeMs: 1_800_000_000_000, monotonicMs: 4 };
    for (const savedFirst of [false, true]) {
      const measured: string[][] = [];
      const h = wired(await config(), { clock: () => at, onMeasurements: (items) => {
        for (const item of items) if (item.unit === "U-W" && item.stage === "encode") measured.push([...item.inputIds]);
      } });
      await startHarness(h, "run", at, false);
      await send(h, "run", "15_16_02_251222_VPWW57", "VPWW57", at);
      if (savedFirst) await save(h);
      await send(h, "run", "15_16_02_251222_VPWW57", "VPWW57", at, (xml) => atTime(xml, "2020-06-22T22:59:00+09:00"), "stale");
      expect((await h.root.shutdownRuntime(2, at)).code).toBe(0);
      expect(measured.at(-1)).toEqual(savedFirst ? [] : ["15_16_02_251222_VPWW57"]);
      await h.root.diagnostics.flush();
    }
  });

  it("P2-WIRE-T01 acceptance / A3 AC09, A5 AC03, AC07-08: parsed U-W save and product restart", async () => {
    let now = 1_800_000_000_000;
    const clock = () => ({ wallTimeMs: now, monotonicMs: now });
    const files = nodeCheckpointFileSystem();
    let failWrite = false;
    const options = { clock, checkpointFileSystem: { ...files,
      open: (path: string) => failWrite ? Promise.reject(new Error("injected write failure")) : files.open(path) } };
    const settings = await config();
    const h = wired(settings, options);
    expect(() => h.root.state).toThrow("runtime has not received its initial state");
    await startHarness(h, "run-1", clock(), false);
    const others = { "U-E": h.root.state.mirror["U-E"], "U-F": h.root.state.mirror["U-F"] };
    await send(h, "run-1", "15_16_02_251222_VPWW57", "VPWW57", clock());
    expect({ "U-E": h.root.state.mirror["U-E"], "U-F": h.root.state.mirror["U-F"] }).toEqual(others);
    expect(h.root.state.mirror["U-W"].view).toMatchObject({ unit: "U-W",
      subjects: [{ transition: "active", source: { inputId: "15_16_02_251222_VPWW57" } }] });
    await send(h, "run-1", "15_18_01_250630_VPWS50", "VPWS50", clock());
    await save(h);
    expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");

    now++;
    await send(h, "run-1", "15_16_02_251222_VPWW57", "VPWW57", clock(), (xml) => atTime(xml, "2020-06-22T23:01:00+09:00"), "second");
    failWrite = true;
    await save(h);
    expect(h.root.state.mirror["U-W"].persistence.kind).toBe("failed");
    expect(h.unit("U-W").partials[0].source.inputId).toBe("second");
    failWrite = false;
    const summary = await h.root.shutdownRuntime(2, clock());
    const generation = h.root.state.mirror["U-W"].persistence.currentGeneration;
    expect(summary).toMatchObject({ code: 0, persistence: { "U-W": { kind: "saved", savedGeneration: generation } } });

    now++;
    const restarted = wired(settings, options);
    await startHarness(restarted, "run-2", clock(), false);
    expect(restarted.unit("U-W").partials[0].source.inputId).toBe("second");
    expect(restarted.root.state.mirror["U-W"].view).toMatchObject({ national: {}, partials: [],
      subjects: [expect.objectContaining({ transition: "restoredUnconfirmed", facts: expect.objectContaining({
        currentConfirmed: false, savedCapturedAt: restarted.root.state.mirror["U-W"].persistence.savedCapturedAt,
      }) }), expect.objectContaining({ transition: "restoredUnconfirmed" })] });
    await send(restarted, "run-2", "15_16_02_251222_VPWW57", "VPWW57", clock(), (xml) => atTime(xml, "2020-06-22T23:02:00+09:00"), "third");
    expect(restarted.unit("U-W").partials[0].source.inputId).toBe("third");
    expect(restarted.root.state.mirror["U-W"].persistence.currentGeneration).toBeGreaterThan(generation);
    expect(restarted.root.state.mirror["U-W"].view).toMatchObject({ national: {}, partials: [{ source: { inputId: "third" } }],
      subjects: [expect.objectContaining({ transition: "restoredUnconfirmed" }), expect.objectContaining({ transition: "active" })] });
    // No caller correlation: the owner attributes the routed input, so normal shutdown saves it.
    expect((await restarted.root.shutdownRuntime(1, clock())).code).toBe(0);
    expect(slot(settings, "U-W")).toMatchObject({ kind: "restored", envelope: { generation: generation + 1 } });
    const finalRoot = wired(settings, options);
    await startHarness(finalRoot, "run-3", clock(), false);
    expect(finalRoot.unit("U-W").partials[0].source.inputId).toBe("third");
    await Promise.all([h.root.diagnostics.flush(), restarted.root.diagnostics.flush(), finalRoot.root.diagnostics.flush()]);
  });

  it("P2-WIRE-T07 acceptance / A3 AC09, A6 AC07-08: parsed VPWP50 through the linked set, save and product restart", async () => {
    // Within the report's validity and 7-day retention, so neither restore nor receive collects the subject.
    let now = Date.parse("2023-06-22T23:00:00+09:00") + 1_000;
    const clock = () => ({ wallTimeMs: now, monotonicMs: now });
    const settings = await config();
    const h = wired(settings, { clock });
    await startHarness(h, "run-1", clock(), false);
    await send(h, "run-1", "81_01_04_251222_VPWP50", "VPWP50", clock());
    expect(h.unit("U-F").subjects).toMatchObject([
      { subject: "normal/VPWP50/稚内地方気象台", effective: "active", source: { inputId: "81_01_04_251222_VPWP50" } }]);
    const summary = await h.root.shutdownRuntime(1, clock());
    const generation = h.root.state.mirror["U-F"].persistence.currentGeneration;
    expect(summary).toMatchObject({ code: 0, persistence: { "U-F": { kind: "saved", savedGeneration: generation } } });

    now++;
    const restarted = wired(settings, { clock });
    await startHarness(restarted, "run-2", clock(), false);
    expect(restarted.unit("U-F").subjects[0]).toMatchObject({ source: { inputId: "81_01_04_251222_VPWP50" } });
    await send(restarted, "run-2", "81_01_04_251222_VPWP50", "VPWP50", clock(), (xml) => atTime(xml, "2023-06-22T23:30:00+09:00"), "second");
    expect(restarted.unit("U-F").subjects[0]).toMatchObject({ source: { inputId: "second" } });
    expect((await restarted.root.shutdownRuntime(1, clock())).code).toBe(0);
    expect(slot(settings, "U-F")).toMatchObject({ kind: "restored", envelope: { generation: generation + 1 } });
    await Promise.all([h.root.diagnostics.flush(), restarted.root.diagnostics.flush()]);
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
    const h = wired(settings, { clock,
      checkpointFileSystem: { ...files, open: async (path) => { signalOpen(); await openGate; return files.open(path); } },
      onMeasurements: (items) => measured.push(...items.map(({ unit, generation, inputIds }) => ({ unit, generation, inputIds }))) });
    await startHarness(h, "run", clock(), false);
    await send(h, "run", "15_16_02_251222_VPWW57", "VPWW57", clock());
    const firstSave = h.root.driveCheckpoint();
    await openStarted;
    now++;
    // The owner applies this input while its own save waits on the file system (P3-C3A-AC15).
    await send(h, "run", "15_16_02_251222_VPWW57", "VPWW57", clock(), (xml) => atTime(xml, "2020-06-22T23:01:00+09:00"), "second");
    releaseOpen();
    await firstSave;
    await h.settle();
    expect(h.root.state.mirror["U-W"].persistence).toMatchObject({ currentGeneration: 2, savedGeneration: 1 });
    now++;
    await send(h, "run", "15_16_02_251222_VPWW57", "VPWW57", clock(), (xml) => atTime(xml, "2020-06-22T23:02:00+09:00"), "third");
    await h.root.shutdownRuntime(1, clock());

    expect(measured.filter(({ unit }) => unit === "U-W").at(-1)?.inputIds)
      .toEqual(["second", "third"]);
  });

  it("P2-A1-T12 contractBoundary / AC11: VXSE44 with an invalid date is ignored while deadlines still run", () => {
    // TEST-PATH (1). AC11(c): the ignored input changes nothing in its (deferred) owner; U-E's elapsed deadline runs on
    // the urgent owner's next deadline request, not in this input's step.
    const clock = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
    const initial = fixtureState({}, {}, "run");
    const state: RuntimeState = { ...initial, units: { ...initial.units, "U-E": { ...initial.units["U-E"],
      deliveryRecords: [{ intentId: "elapsed", disposition: "delivered", expiresAt: clock.wallTimeMs }] } },
      deadlines: { "U-E": { wallTimeMs: clock.wallTimeMs, monotonicMs: null }, "U-W": null, "U-F": null } };
    const material = decode("37_01_01_240613_VXSE43", "VXSE44", (xml) => xml
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>invalid</ReportDateTime>"), "ignored-44");
    const ignored = receiveOwner(ownerFixture("deferred", state), { runId: "run", inputId: material.inputId,
      result: { kind: "decoded", material } }, clock, calls.units);
    expect(ignored.changedUnits).toEqual([]);
    expect(ignored.diagnostics).toMatchObject([{ reason: "routeIgnored", level: "INFO", inputId: "ignored-44" }]);
    const deadline = deadlineOwner(ownerFixture("urgent", state), clock, calls.units);
    expect(deadline.state.units["U-E"]?.current).toEqual([]);
    expect(deadline.state.units["U-E"]?.deliveryRecords).toEqual([]);
    expect(deadline.changedUnits).toEqual(["U-E"]);
    expect(deadline.generationInputIds).toEqual({ "U-E": [] });
  });

  it("P2-WIRE-T02 acceptance / A4 AC04, AC08 follow-up: parsed EEW is active, leaves nothing durable, and a restart follow-up becomes current", async () => {
    let now = 1_713_363_299_001;
    const clock = () => ({ wallTimeMs: now, monotonicMs: now });
    const settings = await config();
    const h = wired(settings, { clock });
    await startHarness(h, "run-1", clock(), false);
    const others = { "U-W": h.root.state.mirror["U-W"], "U-F": h.root.state.mirror["U-F"] };
    await send(h, "run-1", "37_01_01_240613_VXSE43", "VXSE43", clock());
    expect({ "U-W": h.root.state.mirror["U-W"], "U-F": h.root.state.mirror["U-F"] }).toEqual(others);
    expect(h.root.state.mirror["U-E"].view).toMatchObject({ unit: "U-E", activeCount: 1 });
    expect((await h.root.shutdownRuntime(1, clock())).code).toBe(0);

    now++;
    expect(slot(settings, "U-E")).toMatchObject({ kind: "restored", envelope: {
      payload: { intents: [{ channel: "desktop" }, { channel: "sound" }] },
    } }); // active current is not durable; pending delivery is.
    const restarted = wired(settings, { clock });
    await startHarness(restarted, "run-2", clock(), false);
    await send(restarted, "run-2", "37_01_02_240613_VXSE43", "VXSE43", clock());
    expect(restarted.unit("U-E").current.map((item) => item.serial)).toEqual([2]);
    await Promise.all([h.root.diagnostics.flush(), restarted.root.diagnostics.flush()]);
  });

  it("P2-WIRE-T03 contractBoundary / A1 route: a routed rejection yields one unit diagnostic and no business change", () => {
    const state = fixtureState({}, {}, "run");
    const material = { ...decode("15_16_02_251222_VPWW57", "VPWW57"), reportDateTimeRaw: "" };
    const clock = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
    const step = received(ownerFixture("weatherCurrent", state), material, clock);
    expect(step.diagnostics.map((item) => item.reason)).toEqual(["reportDateTimeMissing"]);
    // Routed, not dropped: U-W records the §7.8 freshness target while its business state stays.
    expect(step.changedUnits).toEqual(["U-W"]);
    expect(step.state.units["U-W"]?.freshness).toMatchObject([{ decision: "rejected", revisionOrder: "unknown" }]);
    expect(step.state.units["U-W"]?.partials).toBe(state.units["U-W"].partials);
    expect(step.state.units["U-W"]?.national).toBe(state.units["U-W"].national);
  });

  it("P2-WIRE-T04 contractBoundary / A1 shutdown: input completed after mailboxDrain is not applied to units", () => {
    // After the shutdown input (spec §5.9 step 3) the owner no longer accepts parser inputs.
    const state: OwnerState = { ...ownerFixture("weatherCurrent", fixtureState({}, {}, "run")), accepting: false };
    const clock = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
    const step = received(state, decode("15_16_02_251222_VPWW57", "VPWW57"), clock);
    expect(step.changedUnits).toEqual([]);
    expect(step.state.units).toBe(state.units);
  });
});
