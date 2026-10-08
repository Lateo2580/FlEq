import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CheckpointMeasurement, P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { ClockReading, DiagnosticEvent, RuntimeState, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { e14Acks, e14Index } from "../eew-e01/aux-measures.mjs";
import { fixtureDriver, fixtureState, recordingNotificationAdapter, stringCodec } from "../checkpoint-shutdown/runtime-fixture";
import { calls, notice } from "../notification-delivery/delivery-fixture";
import { envelope, harnessedRoot, idleChannels, park, seeded, startHarness, submit, unitBodies } from "./owner-harness";
import type { Harness } from "./owner-harness";

// P3-UNIT-WRITE-RIGHT-001: TEST-PATH (2) with the fixture driver's stub reducers on a memory file system whose file sync
// can be held per unit, and an injected clock.
const at = (ms: number): ClockReading => ({ wallTimeMs: 1_800_000_000_000 + ms, monotonicMs: ms });
const codecs = { "U-E": stringCodec("U-E"), "U-W": stringCodec("U-W"), "U-F": stringCodec("U-F") };
const units = ["U-E", "U-W", "U-F"] as const;

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function config() {
  const path = mkdtempSync(join(tmpdir(), "fleq-uwr-"));
  directories.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

// Memory checkpoint files; hold(unit, stage) keeps that unit's file sync (or its rename, or the directory sync after its
// rename) open until the returned function is called.
type Stage = "sync" | "rename" | "syncDirectory";
function gatedFiles() {
  const files = new Map<string, Uint8Array>();
  const gates = new Map<string, Promise<void>>();
  const unitOf = (path: string) => units.find((unit) => basename(path).startsWith(unit));
  const gate = (stage: Stage, unit: RuntimeUnitId | undefined) => unit == null ? undefined : park(gates.get(`${stage}:${unit}`));
  // The directory sync names no unit: it follows the latest rename (one save at a time where a test holds it).
  let renamed: RuntimeUnitId | undefined;
  const system: CheckpointFileSystem = {
    unlinkSync: (path) => { files.delete(path); },
    readFile: (path) => files.get(path) ?? null,
    mkdir: async () => {},
    open: async (path) => {
      let bytes = new Uint8Array();
      const unit = unitOf(path);
      return { write: async (data) => { bytes = data.slice(); },
        sync: async () => { await gate("sync", unit); },
        close: async () => { files.set(path, bytes); } };
    },
    rename: async (from, to) => {
      renamed = unitOf(to);
      await gate("rename", renamed);
      files.set(to, files.get(from)!); files.delete(from);
    },
    syncDirectory: async () => { await gate("syncDirectory", renamed); },
  };
  return { system, hold(unit: RuntimeUnitId, stage: Stage = "sync"): () => void {
    let open = () => {};
    const key = `${stage}:${unit}`;
    const held = new Promise<void>((resolve) => { open = resolve; });
    gates.set(key, held);
    return () => {
      if (gates.get(key) === held) gates.delete(key);
      open();
    };
  } };
}

async function runtime(options: Readonly<{ measure?: (observation: P2HostObservation) => void; sharedNow?: () => number }> = {}) {
  let now = at(0);
  const files = gatedFiles();
  const driver = fixtureDriver();
  const measurements: CheckpointMeasurement[] = [];
  const h: Harness = harnessedRoot(config(), codecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter(),
    runtimeCalls: driver.calls, checkpointFileSystem: files.system, onMeasurements: (batch) => { measurements.push(...batch); },
    shutdownHooks: { drainMailbox: (_deadline, active) => h.root.drainInputs(active) },
    ...(options.measure == null ? {} : { measure: options.measure }),
    owners: { measured: options.measure != null, ...(options.sharedNow == null ? {} : { sharedNow: options.sharedNow }) } });
  const recorded = vi.spyOn(h.root.diagnostics, "enqueueDiagnostic");
  await startHarness(h, "uwr", now);
  // The state that raises one unit to `generation` with the given input ID (the stub reducer sets it as is).
  const raised = (unit: RuntimeUnitId, generation: number): RuntimeState => {
    const persistence = h.unit(unit).persistence;
    return fixtureState({ [unit]: `${unit}-${generation}` }, { [unit]: { ...persistence, kind: "pending" as const,
      currentGeneration: generation, dirtySince: persistence.dirtySince ?? now.monotonicMs } }, "uwr");
  };
  return {
    h, root: h.root, files, driver, measurements, raised,
    get now() { return now; },
    set(ms: number) { now = at(ms); },
    // One input that raises the unit, handed over and settled.
    raise: (unit: RuntimeUnitId, generation: number, inputId = `${unit}-${generation}`) =>
      driver.update(h, raised(unit, generation), now, { [unit]: [inputId] }),
    // One input that raises the unit, left in the mailbox and pumped (the driver keeps the target until it is applied).
    queue(unit: RuntimeUnitId, generation: number, inputId = `${unit}-${generation}`) {
      driver.queue(h, raised(unit, generation), now, { [unit]: [inputId] });
      h.root.pump();
    },
    // The host's tick: the root tick, then the write rights (host.ts).
    async tick(ms: number) {
      now = at(ms);
      h.root.tick(now);
      void h.root.driveCheckpoint();
      await h.settle();
    },
    events: (reason: string): DiagnosticEvent[] => recorded.mock.calls.map(([event]) => event).filter((event) => event.reason === reason),
    grants: () => h.sent.flatMap(({ request }) => request.kind === "checkpointGrant" ? [request] : []),
    inputsTo: (place: string) => h.sent.filter((item) => item.place === place && item.request.kind === "input"),
    delayed: (): number => h.root["delayedInputs"].size,
  };
}
type Runtime = Awaited<ReturnType<typeof runtime>>;
const saved = (r: Runtime, unit: RuntimeUnitId) => r.root.state.mirror[unit].persistence;

describe("P3-UNIT-WRITE-RIGHT-001 (TEST-PATH (2))", () => {
  it("P3-UWR-T01 acceptance / AC01,AC05: a held U-W sync neither delays U-E and U-F nor loses U-W's later inputs", async () => {
    const r = await runtime();
    const releaseWeather = r.files.hold("U-W");
    await r.raise("U-W", 1);
    expect(r.root.checkpoint.grantOf("U-W")?.mode).toBe("save");
    // No tick: the replies alone carry U-E and U-F to their acknowledgements.
    await r.raise("U-E", 1);
    await r.raise("U-F", 1);
    expect([saved(r, "U-E"), saved(r, "U-F")]).toMatchObject([{ kind: "saved", savedGeneration: 1 }, { kind: "saved", savedGeneration: 1 }]);
    // U-W's next inputs: the first waits for the hold limit, the second follows at once (HOLD-REPEAT=A).
    r.queue("U-W", 2);
    await r.h.settle();
    await r.tick(1_000);
    r.queue("U-W", 3);
    await r.h.settle();
    expect(r.h.unit("U-W").persistence.currentGeneration).toBe(3);
    for (let second = 2; second <= 11; second += 1) {
      await r.tick(second * 1_000);
      if (second === 5 || second === 11) for (const unit of ["U-E", "U-F"] as const) await r.raise(unit, second === 5 ? 2 : 3);
    }
    expect(r.events("checkpointUncertain").map((event) => event.unit)).toEqual(["U-W"]);
    expect([saved(r, "U-E"), saved(r, "U-F")]).toMatchObject([{ kind: "saved", savedGeneration: 3 }, { kind: "saved", savedGeneration: 3 }]);
    expect(r.root.checkpoint.grantOf("U-W")?.generation).toBe(1);
    releaseWeather();
    await r.h.settle();
    expect(saved(r, "U-W")).toMatchObject({ kind: "saved", savedGeneration: 3 });
    const last = r.measurements.filter((measurement) => measurement.unit === "U-W").at(-1)!;
    expect([last.generation, last.inputIds]).toEqual([3, ["U-W-2", "U-W-3"]]);
    await r.root.diagnostics.flush();
  });

  it("P3-UWR-T02 contractBoundary / AC02,AC03: a right waits for the owner's input, then comes with each reply before the next input", async () => {
    const r = await runtime();
    // (1) U-W's save and its reconciliation both fail at the directory sync: uncertain, retry at 1,000 ms. Not due before
    // it; due at the first reply after it (no tick).
    const sync = vi.spyOn(r.files.system, "syncDirectory").mockRejectedValueOnce(new Error("sync failed"))
      .mockRejectedValueOnce(new Error("sync failed"));
    await r.raise("U-W", 1);
    expect([saved(r, "U-W").kind, r.root.checkpoint.retryAfter("U-W")]).toEqual(["uncertain", 1_000]);
    let from = r.grants().length;
    r.set(999);
    await r.raise("U-E", 1);
    expect(r.grants().slice(from).map((grant) => grant.unit)).toEqual(["U-E"]);
    from = r.grants().length;
    r.set(1_000);
    await r.raise("U-E", 2);
    expect(r.grants().slice(from).map((grant) => [grant.unit, grant.mode])).toEqual([["U-W", "reconcile"], ["U-E", "save"]]);
    sync.mockRestore();
    expect(saved(r, "U-W").kind).toBe("saved");
    // (2) While weatherCurrent's input is in flight (its inputDone held), U-W, dirty by a deadline reply, gets no right; U-E does.
    const held = r.h.hold((place, reply) => place === "weatherCurrent" && reply.kind === "inputDone");
    r.queue("U-W", 2);
    await r.h.settle();
    r.driver.queue(r.h, r.raised("U-W", 3), r.now, { "U-W": ["U-W-3"] });
    from = r.grants().length;
    r.root.tick(r.now);
    await r.h.settle();
    expect(saved(r, "U-W").currentGeneration).toBe(3);
    await r.raise("U-E", 3);
    expect(r.grants().slice(from).map((grant) => grant.unit)).toEqual(["U-E"]);
    // At the inputDone the right comes before the next input waiting in the mailbox.
    held();
    const sent = r.h.sent.length;
    r.h.release();
    await r.h.settle();
    expect(r.h.sent.slice(sent).filter(({ place }) => place === "weatherCurrent").map(({ request }) => request.kind).slice(0, 2))
      .toEqual(["checkpointGrant", "input"]);
    // (3) A generation raised by a deadline request only gets its right at the deadlineDone, with no driveCheckpoint.
    // (U-E: its stub reducer has a due deadline since its first input; the queued input is not handed over here.)
    r.driver.queue(r.h, r.raised("U-E", 4), r.now);
    from = r.grants().length;
    r.root.tick(at(1_001));
    await r.h.settle();
    expect(r.grants().slice(from).map((grant) => grant.unit)).toContain("U-E");
    // (4) A second delivery of a checkpointDone, or one with an old grantId, starts nothing, though U-F's reconciliation
    // is due when they arrive (its save and first reconciliation failed at the directory sync); the next tick grants it.
    const done = r.h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" && reply.unit === "U-E" ? [reply] : []);
    const failing = vi.spyOn(r.files.system, "syncDirectory").mockRejectedValueOnce(new Error("sync failed"))
      .mockRejectedValueOnce(new Error("sync failed"));
    r.set(1_001);
    await r.raise("U-F", 1);
    expect([saved(r, "U-F").kind, r.root.checkpoint.retryAfter("U-F")]).toEqual(["uncertain", 2_001]);
    failing.mockRestore();
    r.set(2_001);
    const repeated = r.grants().length;
    r.h.redeliver("urgent", done[0]);
    r.h.redeliver("urgent", { ...done[0], grantId: "uwr:grant:old" });
    expect(r.grants()).toHaveLength(repeated);
    await r.tick(2_001);
    expect(r.grants().slice(repeated).map((grant) => [grant.unit, grant.mode])).toContainEqual(["U-F", "reconcile"]);
    await r.root.diagnostics.flush();
  });

  it("P3-UWR-T02 contractBoundary / AC03: an intentUpdateDone that raises a generation gives its right with no tick", async () => {
    const seeds = seeded(calls.units);
    let now = at(0);
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter(),
      runtimeCalls: { ...calls, units: seeds.units } });
    await startHarness(h, "uwr", now, false);
    await seeds.weather(h, { ...initialUnits["U-W"], intents: [notice("w-desktop", "desktop", now.wallTimeMs)] }, null, now);
    const from = h.delivered.length;
    h.root.dispatch({ kind: "notificationProbeCompleted", channels: idleChannels, clock: now });
    await h.settle();
    const replies = h.delivered.slice(from).map(({ reply }) => reply.kind);
    const adoption = replies.indexOf("intentUpdateDone");
    expect(adoption).toBeGreaterThanOrEqual(0);
    expect(replies.slice(adoption)).toContain("checkpointDone");
    expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");
    await h.root.diagnostics.flush();
  });

  it("P3-UWR-T03 acceptance / AC04,AC10: a non-urgent input waits for its own save only; deadlines and urgent inputs go on", async () => {
    const r = await runtime();
    const releaseWeather = r.files.hold("U-W");
    await r.raise("U-W", 1);
    r.set(10);
    r.queue("U-W", 2);
    await r.h.settle();
    expect([r.delayed(), r.inputsTo("weatherCurrent")]).toMatchObject([1, [{ request: { kind: "input" } }]]);
    // A deadline request still goes to weatherCurrent; the urgent input is applied.
    const deadlines = r.h.sent.filter(({ place, request }) => place === "weatherCurrent" && request.kind === "deadline").length;
    r.root.tick(r.now);
    await r.h.settle();
    expect(r.h.sent.filter(({ place, request }) => place === "weatherCurrent" && request.kind === "deadline")).toHaveLength(deadlines + 1);
    await submit(r.h, envelope("uwr", unitBodies["U-E"].headType, "eew", unitBodies["U-E"].body, r.now, 900));
    expect(r.h.delivered.some(({ reply }) => reply.kind === "inputDone" && reply.settlement.inputId === "eew")).toBe(true);
    // The tick's deadline raised U-W after the capture, so the ack starts the next save at once (held too); the hold keeps
    // its start.
    expect(r.h.unit("U-W").persistence.currentGeneration).toBe(2);
    r.files.hold("U-W");
    releaseWeather();
    await r.h.settle();
    expect(r.root.checkpoint.grantOf("U-W")?.generation).toBe(2);
    expect(r.delayed()).toBe(1);
    await r.tick(1_009);
    expect(r.delayed()).toBe(1);
    await r.tick(1_010);
    expect([r.delayed(), r.inputsTo("weatherCurrent").length]).toEqual([0, 2]);
    await r.root.diagnostics.flush();
  });

  it("P3-UWR-T03 acceptance / AC04: a held rename or directory sync holds the input too; intent updates still go", async () => {
    for (const stage of ["rename", "syncDirectory"] as const) {
      const r = await runtime();
      const release = r.files.hold("U-W", stage);
      await r.raise("U-W", 1);
      r.queue("U-W", 2);
      await r.h.settle();
      expect([stage, r.delayed()]).toEqual([stage, 1]);
      release();
      await r.h.settle();
      expect([stage, r.delayed(), r.h.unit("U-W").persistence.currentGeneration]).toEqual([stage, 0, 2]);
      await r.root.diagnostics.flush();
    }
    // The notification probe's selection and its result reach weatherCurrent as intent updates while its input is held.
    const seeds = seeded(calls.units);
    const files = gatedFiles();
    const now = at(0);
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter(),
      runtimeCalls: { ...calls, units: seeds.units }, checkpointFileSystem: files.system });
    await startHarness(h, "uwr", now, false);
    const release = files.hold("U-W");
    await seeds.weather(h, { ...initialUnits["U-W"], intents: [notice("w-desktop", "desktop", now.wallTimeMs)] }, null, now);
    // The first input raises U-W and saves at once (held); the second waits for that save.
    await submit(h, envelope("uwr", unitBodies["U-W"].headType, "first", unitBodies["U-W"].body, now, 900));
    expect(h.root.checkpoint.grantOf("U-W")).not.toBeNull();
    await submit(h, envelope("uwr", unitBodies["U-W"].headType, "held", unitBodies["U-W"].body, now, 901));
    expect(h.root["delayedInputs"].size).toBe(1);
    const from = h.sent.length;
    h.root.dispatch({ kind: "notificationProbeCompleted", channels: idleChannels, clock: now });
    await h.settle();
    expect(h.sent.slice(from).filter(({ place, request }) => place === "weatherCurrent" && request.kind === "intentUpdate").length)
      .toBeGreaterThanOrEqual(2);
    expect(h.root["delayedInputs"].size).toBe(1);
    release();
    await h.settle();
    expect(h.root["delayedInputs"].size).toBe(0);
    await h.root.diagnostics.flush();
  });

  it("P3-UWR-T03 acceptance / AC04: another unit's save holds no weatherCurrent input; the own ack sends the held one", async () => {
    const r = await runtime();
    r.files.hold("U-F");
    await r.raise("U-F", 1);
    r.queue("U-W", 1);
    await r.h.settle();
    expect([r.delayed(), r.h.unit("U-W").persistence.currentGeneration]).toEqual([0, 1]);
    const releaseWeather = r.files.hold("U-W");
    await r.raise("U-W", 2);
    r.queue("U-W", 3);
    await r.h.settle();
    expect([r.delayed(), r.h.unit("U-W").persistence.currentGeneration]).toEqual([1, 2]);
    releaseWeather();
    await r.h.settle();
    expect([r.delayed(), r.h.unit("U-W").persistence.currentGeneration]).toEqual([0, 3]);
    await r.root.diagnostics.flush();
  });

  it("P3-UWR-T04 contractBoundary / AC04,AC05: a save longer than 1,000 ms lets the input through once, and the right is kept", async () => {
    const r = await runtime();
    const releaseWeather = r.files.hold("U-W");
    await r.raise("U-W", 1);
    r.queue("U-W", 2);
    await r.h.settle();
    expect(r.delayed()).toBe(1);
    // The tick sends the expired input before its deadline requests, so the input is what raises U-W.
    await r.tick(1_000);
    expect(r.delayed()).toBe(0);
    // Applied between the save's awaits: after the capture, so it is the next save's.
    expect(r.h.owners.get("weatherCurrent")!["state"]!.checkpointAttempts["U-W"]).toMatchObject({ generation: 1, postCaptureDirtySince: 1_000 });
    r.queue("U-W", 3);
    await r.h.settle();
    expect([r.delayed(), r.h.unit("U-W").persistence.currentGeneration]).toEqual([0, 3]);
    for (let second = 2; second <= 20; second += 1) await r.tick(second * 1_000);
    expect(r.root.checkpoint.grantOf("U-W")?.generation).toBe(1);
    // The ack is applied; the next save of the later generations holds an input again.
    r.files.hold("U-W");
    releaseWeather();
    await r.h.settle();
    expect(saved(r, "U-W")).toMatchObject({ savedGeneration: 1 });
    expect(r.root.checkpoint.grantOf("U-W")?.generation).toBe(3);
    r.queue("U-W", 4);
    await r.h.settle();
    expect(r.delayed()).toBe(1);
    await r.root.diagnostics.flush();
  });

  it("P3-UWR-T05 contractBoundary / AC06: a generation raised during a save is acknowledged by the next capture, without a repeated overdue", async () => {
    // U-E by its next input; U-W by its next input sent at the hold limit (P3-UWR-AC04), which also lands between the
    // save's awaits.
    for (const [unit, place, inputId, raisedAt] of [["U-E", "urgent", "eew-2", 10], ["U-W", "weatherCurrent", "weather-2", 1_010]] as const) {
      const records: { t: string; o: P2HostObservation }[] = [];
      const r = await runtime({ measure: (o) => { records.push({ t: "obs", o }); } });
      const release = r.files.hold(unit);
      await r.raise(unit, 1);
      r.set(10);
      if (unit === "U-E") await r.raise(unit, 2, inputId);
      else {
        r.queue(unit, 2, inputId);
        await r.h.settle();
        await r.tick(raisedAt);
      }
      const attempt = r.h.owners.get(place)!["state"]!.checkpointAttempts[unit];
      expect(attempt).toMatchObject({ generation: 1, postCaptureDirtySince: raisedAt });
      await r.tick(3_011);
      expect(r.events("checkpointOverdue").map((event) => [event.unit, event.generation])).toEqual([[unit, 2]]);
      const grants = r.grants().length;
      release();
      await r.h.settle();
      // The ack of g1 leaves the unit pending from the post-capture time, and its reflection gives the one next right.
      expect(r.grants().slice(grants).map((grant) => grant.unit)).toEqual([unit]);
      expect(saved(r, unit)).toMatchObject({ kind: "saved", savedGeneration: 2 });
      expect(r.events("checkpointOverdue")).toHaveLength(1);
      const acks = e14Acks(e14Index(records), { k: 0, inputIds: { "U-E": "none", "U-W": "none", "U-F": "none", [unit]: inputId } });
      expect(acks[units.indexOf(unit)]).toMatchObject({ result: { kind: "acknowledged", generation: 2 } });
      await r.root.diagnostics.flush();
    }
  });

  it("P3-UWR-T06 contractBoundary / AC07: the drain stage sends a held input; final saves still go one at a time after every right returns", async () => {
    const r = await runtime();
    const releaseWeather = r.files.hold("U-W");
    const releaseSeries = r.files.hold("U-F");
    await r.raise("U-W", 1);
    await r.raise("U-F", 1);
    // Both saves are open; each unit's next input waits for its own save.
    const next = (unit: RuntimeUnitId) => ({ ...r.h.unit(unit).persistence, kind: "pending" as const, currentGeneration: 2,
      dirtySince: r.h.unit(unit).persistence.dirtySince ?? r.now.monotonicMs });
    r.driver.queue(r.h, fixtureState({ "U-W": "U-W-2", "U-F": "U-F-2" }, { "U-W": next("U-W"), "U-F": next("U-F") }, "uwr"), r.now,
      { "U-W": ["U-W-2"], "U-F": ["U-F-2"] });
    r.root.pump();
    await r.h.settle();
    expect(r.delayed()).toBe(2);
    const stopping = r.root.shutdownRuntime(10, r.now);
    await r.h.settle();
    // Without a tick, the drain stage sent the held inputs and completed after their inputDone.
    expect(r.root.state.shutdown.stageResults.mailboxDrain?.result.kind).toBe("completed");
    expect([r.h.unit("U-W").persistence.currentGeneration, r.h.unit("U-F").persistence.currentGeneration]).toEqual([2, 2]);
    releaseSeries();
    await r.h.settle();
    expect(r.root.state.shutdown.finalizationAt).toBeNull();
    expect(r.h.sent.some(({ request }) => request.kind === "finalize")).toBe(false);
    releaseWeather();
    const summary = await stopping;
    expect(summary.code).toBe(0);
    // The final saves after the cutoff, one per unit in the writer's order (the same dirtySince goes by UnitId).
    const kinds = r.h.sent.flatMap(({ request }) => request.kind === "finalize" ? ["finalize"] : request.kind === "checkpointGrant" ? [request.unit] : []);
    expect(kinds.slice(kinds.lastIndexOf("finalize") + 1)).toEqual(["U-F", "U-W"]);
    expect([saved(r, "U-W"), saved(r, "U-F")]).toMatchObject([{ savedGeneration: 2 }, { savedGeneration: 2 }]);
  });

  it("P3-UWR-T06 contractBoundary / AC07: one stopped I/O leaves every unit unfixed, and its late ack releases its right only", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = await runtime();
    const releaseWeather = r.files.hold("U-W");
    await r.raise("U-W", 1);
    await r.raise("U-F", 1);
    const stopping = r.root.shutdownRuntime(10, r.now);
    await r.h.settle();
    r.set(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    r.set(15_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const summary = await stopping;
    expect(r.root.state.shutdown.finalizationAt).toBeNull();
    // D4: no cutoff was decided, so all four units (U-T too) count unsaved.
    expect(r.root.state.shutdown.stageResults.finalCheckpoint?.pending.unsavedUnits).toBe(4);
    expect(summary.code).toBe(2);
    // The late ack releases U-W's right only: no mirror change, no input, no grant.
    const mirror = r.root.state.mirror["U-W"];
    const sent = r.h.sent.length;
    releaseWeather();
    await r.h.settle();
    expect([r.root.checkpoint.grantOf("U-W"), r.root.state.mirror["U-W"], r.h.sent.length]).toEqual([null, mirror, sent]);
    vi.useRealTimers();
  });

  it("P3-UWR-T07 contractBoundary / AC08: with the mark, the owner's time before the projection starts E14", async () => {
    // The real weather-current unit, whose view projection takes 30 ms of the shared real clock.
    const weather = linkedUnitTable["U-W"];
    const slow: UnitTable = { ...linkedUnitTable, "U-W": { ...weather, toView: (state) => {
      const until = performance.now() + 30;
      while (performance.now() < until) { /* the projection's own time */ }
      return weather.toView(state);
    } } };
    const vpws50 = readFileSync("test/fixtures/15_18_01_250630_VPWS50.xml");
    const run = async (measured: boolean) => {
      const observed: P2HostObservation[] = [];
      const now = at(0);
      const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter(),
        runtimeCalls: { units: slow }, owners: { measured, sharedNow: () => performance.now() },
        ...(measured ? { measure: (o: P2HostObservation) => { observed.push(o); } } : {}) });
      await startHarness(h, "uwr", now, false);
      await submit(h, envelope("uwr", "VPWS50", "vpws50", vpws50, now, 1));
      const done = h.delivered.flatMap(({ reply }) => reply.kind === "inputDone" ? [reply] : []);
      await h.root.diagnostics.flush();
      return { observed, done };
    };
    const marked = await run(true);
    const row = marked.observed.find((o): o is Extract<P2HostObservation, { kind: "generationRaised" }> => o.kind === "generationRaised");
    if (row?.ownerMonotonicMs == null) throw new Error("generationRaised with the owner's time expected");
    expect(row.monotonicMs - row.ownerMonotonicMs).toBeGreaterThanOrEqual(30);
    expect(marked.done.map((reply) => reply.generationRaisedMs)).toEqual([row.ownerMonotonicMs]);
    const plain = await run(false);
    expect(plain.done.map((reply) => reply.generationRaisedMs)).toEqual([null]);
  });
});
