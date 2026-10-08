import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClockReading, NotificationIntent, PersistenceStatus, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState, NotificationSelection } from "../../contracts/p2-notification-delivery.types";
import type { DisplaySnapshot, DisplayWorkerView } from "../../contracts/p2-snapshot-sse.types";
import type { CheckpointFileSystem, CodecMap } from "../../src/checkpoint/checkpoint";
import { linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import type { RuntimeUnitStates } from "../../contracts/p2-shared-runtime.types";
import { fixtureDriver, fixtureState, recordingNotificationAdapter, stringCodec } from "../checkpoint-shutdown/runtime-fixture";
import { calls, notice } from "../notification-delivery/delivery-fixture";
import { envelope, harnessedRoot, manualAdapter, seeded, startHarness, submit } from "../execution-split/owner-harness";

// TEST-PATH (2) for P3-EXECUTION-LIFECYCLE-001: in-process owners on a settable clock. tick() is the host's tick
// (host.ts): the root tick, then the owner judgement handed to setWorker; it returns whether the state changed
// (the host's immediate heartbeat).
const EEW_AT = 1_713_363_299_001; // 37_01_01 VXSE43 ReportDateTime + 1 ms
const at = (time: number): ClockReading => ({ wallTimeMs: EEW_AT + time, monotonicMs: time });
const fixture = (name: string) => readFileSync(`test/fixtures/${name}.xml`);
const vxse43 = () => fixture("37_01_01_240613_VXSE43");
const vpwp50 = () => fixture("81_02_01_260605_VPWP50_high_severity");
const stringCodecs: CodecMap<RuntimeUnitStates> = { "U-E": stringCodec("U-E"), "U-W": stringCodec("U-W"), "U-F": stringCodec("U-F") };
// A U-E notice (the EEW unit's intents carry an EEW payload).
const eewNotice = (id: string, createdAt: number, operation: "normal" | "training" = "normal") => ({ ...notice(id, "desktop", createdAt),
  unit: "U-E" as const, operation, payload: { domain: "earthquake-eew" as const, level: "warning" as const, title: id, body: id } });
const pending = (dirtySince: number): PersistenceStatus => ({ kind: "pending", currentGeneration: 1, savedGeneration: null,
  savedCapturedAt: null, savedAckAt: null, dirtySince });

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function config() {
  const path = mkdtempSync(join(tmpdir(), "fleq-c3b-"));
  directories.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

type Options = NonNullable<Parameters<typeof harnessedRoot>[2]>;
async function lifecycle(options: Omit<Options, "clock" | "display"> = {}, codecs: CodecMap<RuntimeUnitStates> = linkedUnitCodecs) {
  let now = at(0);
  const published: DisplaySnapshot[] = [];
  const shown: DisplayWorkerView[] = [];
  const settings = config();
  const h = harnessedRoot(settings, codecs, { notificationAdapter: recordingNotificationAdapter(), ...options, clock: () => now,
    // As the host wires it: the drain stage waits for the mailbox.
    shutdownHooks: { drainMailbox: (_deadline, active) => h.root.drainInputs(active), ...options.shutdownHooks },
    display: { publish: (snapshot) => { published.push(snapshot); }, setWorker: (worker) => { shown.push(worker); } } });
  const recorded = vi.spyOn(h.root.diagnostics, "enqueueDiagnostic");
  await startHarness(h, "run", now);
  const events = () => recorded.mock.calls.map(([event]) => event);
  return {
    h, root: h.root, published, shown, events, settings,
    get now() { return now; },
    set(time: number | ClockReading) { now = typeof time === "number" ? at(time) : time; },
    async tick(time: number): Promise<boolean> {
      now = at(time);
      h.root.tick(now);
      const changed = h.root.setWorker(h.root.monitorOwners(now));
      await h.settle();
      return changed;
    },
    stalls: (component: string) => events().filter((event) => event.reason === "mailboxStalled" && event.component === component),
    stops: (component: string) => events().filter((event) => event.reason === "ownerStopped" && event.component === component),
  };
}
type Lifecycle = Awaited<ReturnType<typeof lifecycle>>;
const sentTo = (l: Lifecycle, place: string, from: number) => l.h.sent.slice(from).filter((item) => item.place === place);

describe("P3-C3B execution lifecycle (TEST-PATH (2))", () => {
  it("P3-C3B-T01 contractBoundary / AC01: each owner is judged by its own replies; tick, input and heartbeat do not restore it", async () => {
    // (1) Inputs that change nothing, every second for 60 s: healthy, no immediate heartbeat.
    {
      const l = await lifecycle();
      const vpww57 = fixture("15_16_02_251222_VPWW57");
      let changes = 0;
      for (let second = 1; second <= 60; second += 1) {
        l.set(second * 1_000);
        await submit(l.h, envelope("run", "VPWW57", `same-${second}`, vpww57, l.now, second));
        if (await l.tick(second * 1_000)) changes += 1;
      }
      expect(changes).toBe(0);
      expect(l.shown.every((worker) => worker.state === "healthy")).toBe(true);
      await l.root.diagnostics.flush();
    }
    // (2) No input and no deadline for 60 s: healthy, no immediate heartbeat.
    {
      const l = await lifecycle();
      let changes = 0;
      for (let second = 1; second <= 60; second += 1) if (await l.tick(second * 1_000)) changes += 1;
      expect(changes).toBe(0);
      expect(l.shown.every((worker) => worker.state === "healthy")).toBe(true);
      await l.root.diagnostics.flush();
    }
    // (3)(5) weatherCurrent answers nothing while it processes VPWS50: healthy at 4.9 s, unresponsive (also stalled) at 5 s
    // with one immediate heartbeat; the EEW meanwhile reaches the snapshot. A WS frame and further ticks do not restore
    // it; the delivered replies do, at that tick.
    {
      const l = await lifecycle();
      await l.tick(1_000);
      const stop = l.h.hold((place) => place === "weatherCurrent");
      l.set(1_500);
      await submit(l.h, envelope("run", "VPWS50", "maximum", fixture("15_18_01_250630_VPWS50"), l.now, 1));
      for (const time of [2_000, 3_000, 4_000, 5_000, 6_000, 6_400]) expect(await l.tick(time)).toBe(false);
      expect(l.shown.at(-1)?.state).toBe("healthy");
      expect(await l.tick(6_500)).toBe(true);
      expect(l.shown.at(-1)?.state).toBe("unresponsive");
      expect(l.stalls("owner.weatherCurrent")).toHaveLength(1);
      expect(l.stalls("owner.weatherCurrent.response")).toHaveLength(1);
      await submit(l.h, envelope("run", "VXSE43", "eew", vxse43(), l.now, 2));
      expect(l.published.at(-1)?.current.eew.items.length).toBeGreaterThan(0);
      l.root.recordInput(l.now.wallTimeMs);
      for (const time of [7_500, 8_500]) expect(await l.tick(time)).toBe(false);
      expect(l.shown.at(-1)?.state).toBe("unresponsive");
      stop();
      l.h.release();
      await l.h.settle();
      expect(await l.tick(9_500)).toBe(true);
      expect(l.shown.at(-1)?.state).toBe("healthy");
      expect(l.stalls("owner.weatherCurrent")).toHaveLength(1);
      await l.root.diagnostics.flush();
    }
    // (4) deferred answers its deadlines but not the input: stalled only, one WARN for owner.deferred.
    {
      const l = await lifecycle();
      await l.tick(1_000);
      l.h.hold((place, reply) => place === "deferred" && reply.kind === "inputDone");
      l.set(1_500);
      await submit(l.h, envelope("run", "VPWP50", "series", vpwp50(), l.now, 1));
      for (const time of [2_000, 3_000, 4_000, 5_000, 6_000]) expect(await l.tick(time)).toBe(false);
      expect(await l.tick(6_500)).toBe(true);
      expect(l.shown.at(-1)?.state).toBe("stalled");
      expect(l.stalls("owner.deferred")).toHaveLength(1);
      expect(l.stalls("owner.deferred.response")).toEqual([]);
      await l.root.diagnostics.flush();
    }
    // (6) Only a checkpointGrant is unanswered (held I/O) while deadlines are answered: neither stalled nor unresponsive.
    {
      const driver = fixtureDriver();
      const l = await lifecycle({ runtimeCalls: driver.calls }, stringCodecs);
      // The input saves at once (P3-UWR-AC03): its reply is held from the start (AC10(7)).
      l.h.hold((place, reply) => place === "weatherCurrent" && reply.kind === "checkpointDone");
      await driver.update(l.h, fixtureState({ "U-W": "weather" }, { "U-W": pending(0) }, "run"), l.now);
      void l.root.driveCheckpoint();
      await l.h.settle();
      expect(l.root.checkpoint.grantOf("U-W")?.unit).toBe("U-W");
      for (let second = 1; second <= 12; second += 1) expect(await l.tick(second * 1_000)).toBe(false);
      expect(l.shown.every((worker) => worker.state === "healthy")).toBe(true);
      await l.root.diagnostics.flush();
    }
  });

  it("P3-C3B-T04 contractBoundary / AC02,AC04: a stopped owner's reservation, attempt, write right, replies and items", async () => {
    const series = (createdAt: number): NotificationIntent => ({ ...notice("f-desktop", "desktop", createdAt), unit: "U-F",
      expiresAt: createdAt + 60_000 });
    // A training notice is in A7's "other" group like the U-F one, with a later expiry: A7 keeps choosing U-F while it lives.
    const eew = (createdAt: number) => eewNotice("e-desktop", createdAt, "training");
    const notifying = async () => {
      const adapter = manualAdapter();
      const seeds = seeded(calls.units);
      const l = await lifecycle({ notificationAdapter: adapter.adapter, runtimeCalls: { ...calls, units: seeds.units } });
      return { l, adapter, seeds };
    };
    // (1) U-F's reservation waits for deferred's adoption when deferred stops: the channel goes to U-E at once.
    {
      const { l, adapter, seeds } = await notifying();
      const held = l.h.hold((place, reply) => place === "deferred" && reply.kind === "intentUpdateDone");
      await seeds.series(l.h, { ...initialUnits["U-F"], intents: [series(l.now.wallTimeMs)] }, null, l.now);
      expect(l.h.held).toHaveLength(1);
      await seeds.eew(l.h, { ...initialUnits["U-E"], intents: [eew(l.now.wallTimeMs)] }, null, l.now);
      expect(adapter.runs).toEqual([]);
      l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
      await l.h.settle();
      expect(adapter.runs.map((run) => run.attempt.unit)).toEqual(["U-E"]);
      held();
      l.h.release();
      const [run] = adapter.runs;
      adapter.finish({ kind: "delivered", attemptId: run.attempt.attemptId, intentId: run.attempt.intentId, channel: "desktop",
        completedAt: at(100) });
      await l.h.settle();
      await l.tick(1_000);
      expect(adapter.runs).toHaveLength(1);
      await l.root.diagnostics.flush();
    }
    // (2) U-F's attempt is running in the adapter when deferred stops: it runs to its end, the channel then frees for
    // U-E, nothing goes to deferred, and one WARN ownerStopped (notification) is written.
    {
      const { l, adapter, seeds } = await notifying();
      await seeds.series(l.h, { ...initialUnits["U-F"], intents: [series(l.now.wallTimeMs)] }, null, l.now);
      expect(adapter.runs.map((run) => run.attempt.unit)).toEqual(["U-F"]);
      l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
      await l.h.settle();
      expect(l.root.state.notificationChannels.desktop.kind).toBe("running");
      const from = l.h.sent.length;
      await seeds.eew(l.h, { ...initialUnits["U-E"], intents: [eew(l.now.wallTimeMs)] }, null, l.now);
      expect(adapter.runs).toHaveLength(1);
      const [run] = adapter.runs;
      adapter.finish({ kind: "delivered", attemptId: run.attempt.attemptId, intentId: run.attempt.intentId, channel: "desktop",
        completedAt: at(100) });
      await l.h.settle();
      expect(adapter.aborts).toEqual([]);
      expect(sentTo(l, "deferred", from)).toEqual([]);
      expect(adapter.runs.map((item) => item.attempt.unit)).toEqual(["U-F", "U-E"]);
      expect(l.stops("notification")).toHaveLength(1);
      await l.root.diagnostics.flush();
    }
    // (3) deferred holds no write right when it stops (its save failed and waits for its retry): U-F gets no grant at
    // the retry time, and U-W, dirty after the stop, is saved with its own right (P3-UWR-AC01/AC05, AC10(9)).
    {
      const driver = fixtureDriver();
      const files = nodeCheckpointFileSystem();
      const l = await lifecycle({ runtimeCalls: driver.calls, checkpointFileSystem: { ...files, open: async (path) => {
        if (path.includes("U-F")) throw new Error("open failed");
        return files.open(path);
      } } }, stringCodecs);
      await driver.update(l.h, fixtureState({ "U-F": "series" }, { "U-F": pending(10) }, "run"), l.now);
      expect(l.root.state.mirror["U-F"].persistence.kind).toBe("failed");
      l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
      const from = l.h.sent.length;
      await driver.update(l.h, fixtureState({ "U-W": "weather", "U-F": "series" }, { "U-W": pending(20), "U-F": pending(10) }, "run"), l.now);
      l.set(1_000);
      const released = l.root.driveCheckpoint();
      await l.h.settle();
      await released;
      expect(l.h.sent.slice(from).flatMap(({ request }) => request.kind === "checkpointGrant" ? [request.unit] : [])).toEqual(["U-W"]);
      expect(l.root.state.mirror["U-W"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
      await l.root.diagnostics.flush();
    }
    // (4) deferred stops before answering its grant: the right is kept (DEAD-WRITE-RIGHT A), U-W is still granted and
    // saved with its own right (P3-UWR-AC05, AC10(4)(9)), and the overdue and uncertain monitors report U-F. Its
    // checkpointDone arriving after the stop changes nothing.
    {
      const driver = fixtureDriver();
      const l = await lifecycle({ runtimeCalls: driver.calls }, stringCodecs);
      l.h.hold((place, reply) => place === "deferred" && reply.kind === "checkpointDone");
      await driver.update(l.h, fixtureState({ "U-W": "weather", "U-F": "series" }, { "U-W": pending(20), "U-F": pending(10) }, "run"), l.now);
      void l.root.driveCheckpoint();
      await l.h.settle();
      expect(l.root.checkpoint.grantOf("U-F")?.unit).toBe("U-F");
      l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
      l.h.release();
      for (let second = 1; second <= 10; second += 1) {
        await l.tick(second * 1_000);
        void l.root.driveCheckpoint();
        await l.h.settle();
      }
      expect(l.root.checkpoint.grantOf("U-F")?.unit).toBe("U-F");
      expect(l.h.sent.filter(({ request }) => request.kind === "checkpointGrant").map(({ request }) => request.kind === "checkpointGrant"
        && request.unit)).toEqual(["U-W", "U-F"]);
      expect(l.root.state.mirror["U-W"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
      expect(l.events().filter((event) => event.reason === "checkpointOverdue").map((event) => event.unit)).toContain("U-F");
      expect(l.events().filter((event) => event.reason === "checkpointUncertain").map((event) => event.unit)).toEqual(["U-F"]);
      await l.root.diagnostics.flush();
    }
    // (5)(6) deferred with 3 pending and 1 in flight: one ERROR for error and exit together, the 4 items leave the
    // mailbox (cancelled +3, completed unchanged, high-water and violations unchanged), nothing more is sent to it,
    // and its reply arriving after the stop is not adopted.
    {
      const l = await lifecycle();
      l.h.hold((place, reply) => place === "deferred" && reply.kind === "inputDone");
      await submit(l.h, ...[1, 2, 3, 4].map((sequence) => envelope("run", "VPWP50", `series-${sequence}`, vpwp50(), l.now, sequence)));
      const stats = () => l.root.mailbox.stats(l.now.monotonicMs);
      const before = stats();
      expect([before.pendingItems, before.inFlightItems]).toEqual([3, 1]);
      const view = l.root.state.mirror["U-F"].view;
      l.root.ownerFailed("deferred", new Error("worker error"));
      l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
      expect(stats()).toMatchObject({ pendingItems: 0, inFlightItems: 0, cancelled: before.cancelled + 3, completed: before.completed,
        highWaterItems: before.highWaterItems, limitViolations: before.limitViolations });
      expect(l.stops("owner.deferred").map((event) => [event.level, event.count])).toEqual([["ERROR", 4]]);
      l.h.release();
      await l.h.settle();
      expect(l.root.state.mirror["U-F"].view).toBe(view);
      expect(stats().completed).toBe(before.completed);
      const from = l.h.sent.length;
      await l.tick(1_000);
      await l.tick(2_000);
      expect(sentTo(l, "deferred", from)).toEqual([]);
      expect(l.shown.at(-1)?.state).toBe("stopped");
      await l.root.diagnostics.flush();
    }
    // (7) HUNG-PLACE-INPUT A: from unresponsive until healthy again deferred's inputs are refused (first WARN with
    // inputId, then one count line at healthy), also while only stalled in between; the EEW place is not; after the
    // replies deferred's input is taken again.
    {
      const l = await lifecycle();
      await l.tick(1_000);
      const silent = { deadlines: true };
      l.h.hold((place, reply) => place === "deferred" && (reply.kind === "inputDone" || silent.deadlines));
      l.set(1_500);
      await submit(l.h, envelope("run", "VPWP50", "series", vpwp50(), l.now, 1));
      for (let second = 2; second <= 7; second += 1) await l.tick(second * 1_000);
      expect(l.shown.at(-1)?.state).toBe("unresponsive");
      // The other owners answered all along: the mailbox's "no owner answered for 5 s" is not reported.
      expect(l.stalls("mailbox.worker")).toEqual([]);
      expect(l.root.refuseInput("refused-1", "VPWP50", l.now)).toBe(true);
      expect(l.root.refuseInput("refused-2", "VPWP50", l.now)).toBe(true);
      expect(l.root.refuseInput("eew", "VXSE43", l.now)).toBe(false);
      silent.deadlines = false;
      l.h.release((_place, reply) => reply.kind === "deadlineDone");
      await l.tick(8_000);
      expect(l.shown.at(-1)?.state).toBe("stalled");
      expect(l.root.refuseInput("refused-3", "VPWP50", l.now)).toBe(true);
      l.h.release();
      await l.h.settle();
      expect(await l.tick(9_000)).toBe(true);
      expect(l.shown.at(-1)?.state).toBe("healthy");
      expect(l.root.refuseInput("accepted", "VPWP50", l.now)).toBe(false);
      expect(l.stops("owner.deferred.response").map((event) => [event.level, event.inputId ?? null, event.count ?? null]))
        .toEqual([["WARN", "refused-1", null], ["WARN", null, 2]]);
      await l.root.diagnostics.flush();
    }
  });

  it("P3-C3B-T05 acceptance / AC03: shutdown with stopped and unresponsive owners (spec:2072)", async () => {
    // U-T stays clean here: this case describes the three earlier units (P3-C5 adds its row only).
    type Dirtied = Exclude<RuntimeUnitId, "U-T">;
    const dirtyState = (ages: Readonly<Record<Dirtied, number>> = { "U-E": 30, "U-W": 20, "U-F": 10 },
      units: readonly Dirtied[] = ["U-E", "U-W", "U-F"]) => {
      const values = { "U-E": "eew", "U-W": "weather", "U-F": "series" } as const;
      return fixtureState(Object.fromEntries(units.map((unit) => [unit, values[unit]])),
        Object.fromEntries(units.map((unit) => [unit, pending(ages[unit])])), "run");
    };
    const dirtyAll = (driver: ReturnType<typeof fixtureDriver>, l: Lifecycle, ages?: Readonly<Record<Dirtied, number>>) =>
      driver.update(l.h, dirtyState(ages), l.now);
    // An input in the running stage saves at once (P3-UWR-AC03). Units that must still be dirty when the final saves start
    // get their inputs in the drain stage instead (AC10(7)).
    const dirtyAtDrain = (driver: ReturnType<typeof fixtureDriver>, l: Lifecycle, units?: readonly Dirtied[]) =>
      driver.queue(l.h, dirtyState(undefined, units), l.now);
    // A unit whose saves fail at open, so it stays dirty through the running stage (P3-UWR-AC03, AC10(7)).
    const failingOpen = (unit: RuntimeUnitId): CheckpointFileSystem => {
      const files = nodeCheckpointFileSystem();
      return { ...files, open: async (path) => {
        if (path.includes(unit)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        return files.open(path);
      } };
    };
    const saved = (l: Lifecycle) => (["U-E", "U-W", "U-F"] as const).filter((unit) => l.root.state.mirror[unit].persistence.kind === "saved");
    const shutdown = async (l: Lifecycle) => {
      const started = performance.now();
      const summary = await l.root.shutdownRuntime(1, l.now);
      return { summary, realMs: performance.now() - started };
    };
    // (1) Normal: every final generation is acknowledged before the summary, and the owners close after it. code 0.
    {
      const driver = fixtureDriver();
      const order: string[] = [];
      let summaryPath = "";
      const l = await lifecycle({ runtimeCalls: driver.calls, shutdownHooks: {
        closeWorker: async () => { order.push(existsSync(summaryPath) ? "close after summary" : "close before summary"); } } }, stringCodecs);
      summaryPath = join(l.settings.diagnosticDirectory, "shutdown-summary.json");
      dirtyAtDrain(driver, l);
      const { summary } = await shutdown(l);
      expect(summary).toMatchObject({ code: 0, reasons: [] });
      expect(saved(l)).toEqual(["U-E", "U-W", "U-F"]);
      expect(order).toEqual(["close after summary"]);
    }
    // (2) U-W's final save fails (ENOSPC): code 2, U-E and U-F saved.
    {
      const driver = fixtureDriver();
      const files = nodeCheckpointFileSystem();
      const checkpointFileSystem: CheckpointFileSystem = { ...files, open: async (path) => {
        if (path.includes("U-W")) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        return files.open(path);
      } };
      const l = await lifecycle({ runtimeCalls: driver.calls, checkpointFileSystem }, stringCodecs);
      dirtyAtDrain(driver, l);
      const { summary } = await shutdown(l);
      expect(summary).toMatchObject({ code: 2, reasons: ["finalCheckpoint:unsavedUnits"] });
      expect(saved(l)).toEqual(["U-E", "U-F"]);
    }
    // (3) deferred stopped before the shutdown with an input in flight: the drain does not wait for it and fails
    // (ownerStopped), deferred gets no shutdownInput or finalize, code 3, U-F counted unsaved.
    {
      const driver = fixtureDriver();
      const l = await lifecycle({ runtimeCalls: driver.calls, checkpointFileSystem: failingOpen("U-F") }, stringCodecs);
      await dirtyAll(driver, l);
      l.h.hold((place, reply) => place === "deferred" && reply.kind === "inputDone");
      await submit(l.h, envelope("run", "VPWP50", "series", vpwp50(), l.now, 50));
      l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
      const from = l.h.sent.length;
      const stopsBefore = l.stops("owner.deferred").length;
      const stopping = l.root.shutdownRuntime(1, l.now);
      // From the shutdown request on, the draining mailbox refuses: no new refusal episode starts (fit L1).
      expect(l.root.refuseInput("after-stop", "VPWP50", l.now)).toBe(false);
      const summary = await stopping;
      expect(l.stops("owner.deferred")).toHaveLength(stopsBefore);
      expect(summary).toMatchObject({ code: 3, inFlightInputs: 1, pendingInputs: 0,
        reasons: ["mailboxDrain:failed:ownerStopped", "mailboxDrain:remainingInputs", "finalCheckpoint:unsavedUnits"] });
      expect(sentTo(l, "deferred", from)).toEqual([]);
      expect(saved(l)).toEqual(["U-E", "U-W"]);
    }
    // (4) FINALIZE-UNHEALTHY A: weatherCurrent is unresponsive (its deadline held for 5 s, no input, no right) when
    // side-effect finalization begins: that stage does not wait, U-E and U-F are saved, U-W is not. code 2.
    {
      const driver = fixtureDriver();
      const l = await lifecycle({ runtimeCalls: driver.calls, checkpointFileSystem: failingOpen("U-W") }, stringCodecs);
      await dirtyAll(driver, l);
      await l.tick(1_000);
      l.h.holdRequests((place, request) => place === "weatherCurrent" && request.kind === "deadline");
      await l.tick(2_000);
      l.set(7_000);
      const from = l.h.sent.length;
      const { summary, realMs } = await shutdown(l);
      expect(summary).toMatchObject({ code: 2, reasons: ["finalCheckpoint:unsavedUnits"] });
      expect(l.root.state.shutdown.stageResults.sideEffectFinalization?.result).toEqual({ kind: "completed" });
      expect(realMs).toBeLessThan(4_000);
      expect(saved(l)).toEqual(["U-E", "U-F"]);
      expect(sentTo(l, "weatherCurrent", from).map(({ request }) => request.kind)).toEqual([]);
    }
    // (5) The write right is held by an owner treated as stopped: the final save stage ends at its start (failed,
    // ownerStopped) and every dirty unit stays unsaved. code 2, without waiting out the 10 s stage limit.
    for (const holder of ["deferred", "weatherCurrent"] as const) {
      const driver = fixtureDriver();
      const l = await lifecycle({ runtimeCalls: driver.calls }, stringCodecs);
      // The holder's unit saves at once (P3-UWR-AC03) and its reply is held; the other units become dirty in the drain.
      const own = holder === "deferred" ? "U-F" : "U-W";
      l.h.hold((place, reply) => place === holder && reply.kind === "checkpointDone");
      await driver.update(l.h, dirtyState(undefined, [own]), l.now);
      dirtyAtDrain(driver, l, (["U-E", "U-W", "U-F"] as const).filter((unit) => unit !== own));
      void l.root.driveCheckpoint();
      await l.h.settle();
      expect(l.root.checkpoint.grantOf(holder === "deferred" ? "U-F" : "U-W")?.unit).toBe(holder === "deferred" ? "U-F" : "U-W");
      if (holder === "deferred") l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
      else {
        l.h.holdRequests((place, request) => place === "weatherCurrent" && request.kind === "deadline");
        await l.tick(1_000);
        l.set(6_000);
      }
      const { summary, realMs } = await shutdown(l);
      expect(summary.code, holder).toBe(2);
      expect(summary.reasons, holder).toEqual(["finalCheckpoint:failed:ownerStopped", "finalCheckpoint:unsavedUnits"]);
      expect(realMs, holder).toBeLessThan(4_000);
      expect(saved(l), holder).toEqual([]);
    }
    // (6) The drain takes 6 s (urgent's input held); deferred was idle with nothing unanswered, so it is not left out.
    {
      const driver = fixtureDriver();
      const l = await lifecycle({ runtimeCalls: driver.calls }, stringCodecs);
      await dirtyAll(driver, l);
      await l.tick(1_000);
      const stop = l.h.hold((place, reply) => place === "urgent" && reply.kind === "inputDone");
      l.set(1_500);
      await submit(l.h, envelope("run", "VXSE43", "eew", vxse43(), l.now, 60));
      l.set(2_000);
      const stopping = l.root.shutdownRuntime(1, l.now);
      await l.h.settle();
      l.set(8_000);
      stop();
      l.h.release();
      const summary = await stopping;
      expect(summary).toMatchObject({ code: 0, reasons: [] });
      expect(saved(l)).toEqual(["U-E", "U-W", "U-F"]);
    }
  });

  it("P3-C3B-T06 acceptance / AC05: E08 with three owners: 1,000 fixed-clock ticks do no content work", async () => {
    const l = await lifecycle();
    const fixed = 1_000;
    await l.tick(fixed);
    const published = l.published.length;
    const sent = l.h.sent.length;
    const delivered = l.h.delivered.length;
    // Counted only while an owner handles a request (the publisher's own projection is A8's and is not counted here).
    const inOwner = { active: false, clone: 0, stringify: 0, parse: 0 };
    for (const owner of l.h.owners.values()) {
      const handle = owner.handle.bind(owner);
      vi.spyOn(owner, "handle").mockImplementation((request) => {
        inOwner.active = true;
        try { handle(request); } finally { inOwner.active = false; }
      });
    }
    const count = (key: "clone" | "stringify" | "parse") => () => { if (inOwner.active) inOwner[key] += 1; };
    const clone = globalThis.structuredClone, stringify = JSON.stringify, parse = JSON.parse;
    vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => { count("clone")(); return clone(value, options); });
    vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => { count("stringify")(); return stringify(...args); });
    vi.spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof JSON.parse>) => { count("parse")(); return parse(...args); });
    let changes = 0;
    for (let index = 0; index < 1_000; index += 1) {
      if (await l.tick(fixed)) changes += 1;
      void l.root.driveCheckpoint();
    }
    const requests = l.h.sent.slice(sent).map(({ request }) => request.kind);
    const replies = l.h.delivered.slice(delivered).map(({ reply }) => reply.kind);
    // The values crossing the boundary, counted apart: one deadline request and its reply per owner and tick. Inside the
    // owner the only copy is the harness's boundary copy of each reply.
    expect([requests.length, requests.every((kind) => kind === "deadline")]).toEqual([3_000, true]);
    expect([replies.length, replies.every((kind) => kind === "deadlineDone")]).toEqual([3_000, true]);
    expect(inOwner).toEqual({ active: false, clone: replies.length, stringify: 0, parse: 0 });
    expect(changes).toBe(0);
    expect(l.published).toHaveLength(published);
    await l.root.diagnostics.flush();
  });

  it("P3-C3B-T08 acceptance / AC08: an input waits for its unit's expiry update held behind the slot, and still makes its intents", async () => {
    // A7 double: one desktop attempt only, so the result update below occupies U-E's desktop update slot.
    let started = false;
    const select = (delivery: NotificationDeliveryState, clock: ClockReading): NotificationSelection => {
      const candidate = delivery.intents.find((value) => value.channel === "desktop" && value.disposition === "pending");
      if (started || delivery.channels.desktop.kind !== "idle" || candidate == null) return { state: delivery, attempts: [], abortRequests: [], diagnostics: [] };
      started = true;
      const attempt: NotificationAttempt = { attemptId: `attempt-${candidate.id}`, intentId: candidate.id, unit: candidate.unit,
        subject: candidate.subject, operation: candidate.operation, channel: "desktop", priorityGroup: "other", payload: candidate.payload,
        soundAsset: null, selectedAtMonotonicMs: clock.monotonicMs, timeoutAtMonotonicMs: clock.monotonicMs + 5_000,
        expiresAt: candidate.expiresAt };
      return { state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "running", attempt } },
        intents: delivery.intents.map((value) => value === candidate ? { ...value, attempts: 1 } : value) },
      attempts: [attempt], abortRequests: [], diagnostics: [] };
    };
    const adapter = manualAdapter();
    const seeds = seeded(calls.units);
    // U-E is not saved here: each U-E reply would start a save at once (P3-UWR-AC03), and its grants would join the
    // requests to urgent counted below (AC10(7)).
    const { "U-E": _eew, ...withoutEew } = linkedUnitCodecs;
    const l = await lifecycle({ notificationAdapter: adapter.adapter, runtimeCalls: { ...calls, units: seeds.units, selectNotificationAttempt: select } },
      withoutEew);
    const occupied = Array.from({ length: 128 }, (_, index) => ({ ...eewNotice(`occupied-${index}`, l.now.wallTimeMs),
      expiresAt: l.now.wallTimeMs + 16_000 }));
    await seeds.eew(l.h, { ...initialUnits["U-E"], intents: occupied }, null, l.now);
    const [run] = adapter.runs;
    const held = l.h.hold((place, reply) => place === "urgent" && reply.kind === "intentUpdateDone");
    adapter.finish({ kind: "delivered", attemptId: run.attempt.attemptId, intentId: run.attempt.intentId, channel: "desktop",
      completedAt: at(100) });
    await l.h.settle();
    expect(l.h.held).toHaveLength(1);
    // The wall clock is behind: the other 127 have expired by the monotonic clock only.
    const late: ClockReading = { wallTimeMs: EEW_AT + 900, monotonicMs: 16_000 };
    l.set(late);
    const from = l.h.sent.length;
    await submit(l.h, envelope("run", "VXSE43", "event", vxse43(), late, 1));
    expect(sentTo(l, "urgent", from)).toEqual([]);
    expect(l.root.mailbox.stats(late.monotonicMs).inFlightItems).toBe(1);
    held();
    l.h.release();
    await l.h.settle();
    const requests = sentTo(l, "urgent", from).map(({ request }) => request);
    expect(requests.map((request) => request.kind)).toEqual(["intentUpdate", "input"]);
    const [expiry] = requests;
    if (expiry.kind !== "intentUpdate") throw new Error("expiry update expected");
    expect([expiry.updates.length, expiry.updates.every((update) => update.disposition === "expired")]).toEqual([127, true]);
    expect(l.h.unit("U-E").intents.map((value) => value.channel)).toEqual(["desktop", "sound"]);
    expect(l.h.unit("U-E").notificationLatches[0].firstReportNotified).toBe(true);
    await l.root.diagnostics.flush();
  });

  it("P3-C3B-T08 regression / AC08,AC03: a delayed input still waiting when the drain stage ends is never sent, and finalization does not wait for it", async () => {
    let started = false;
    const select = (delivery: NotificationDeliveryState, clock: ClockReading): NotificationSelection => {
      const candidate = delivery.intents.find((value) => value.channel === "desktop" && value.disposition === "pending");
      if (started || delivery.channels.desktop.kind !== "idle" || candidate == null) return { state: delivery, attempts: [], abortRequests: [], diagnostics: [] };
      started = true;
      const attempt: NotificationAttempt = { attemptId: `attempt-${candidate.id}`, intentId: candidate.id, unit: candidate.unit,
        subject: candidate.subject, operation: candidate.operation, channel: "desktop", priorityGroup: "other", payload: candidate.payload,
        soundAsset: null, selectedAtMonotonicMs: clock.monotonicMs, timeoutAtMonotonicMs: clock.monotonicMs + 5_000,
        expiresAt: candidate.expiresAt };
      return { state: { ...delivery, channels: { ...delivery.channels, desktop: { kind: "running", attempt } },
        intents: delivery.intents.map((value) => value === candidate ? { ...value, attempts: 1 } : value) },
      attempts: [attempt], abortRequests: [], diagnostics: [] };
    };
    const adapter = manualAdapter();
    const seeds = seeded(calls.units);
    const l = await lifecycle({ notificationAdapter: adapter.adapter, runtimeCalls: { ...calls, units: seeds.units, selectNotificationAttempt: select } });
    const occupied = Array.from({ length: 128 }, (_, index) => ({ ...eewNotice(`occupied-${index}`, l.now.wallTimeMs),
      expiresAt: l.now.wallTimeMs + 16_000 }));
    await seeds.eew(l.h, { ...initialUnits["U-E"], intents: occupied }, null, l.now);
    const [run] = adapter.runs;
    const held = l.h.hold((place, reply) => place === "urgent" && reply.kind === "intentUpdateDone");
    adapter.finish({ kind: "delivered", attemptId: run.attempt.attemptId, intentId: run.attempt.intentId, channel: "desktop",
      completedAt: at(100) });
    await l.h.settle();
    const late: ClockReading = { wallTimeMs: EEW_AT + 900, monotonicMs: 16_000 };
    l.set(late);
    const from = l.h.sent.length;
    await submit(l.h, envelope("run", "VXSE43", "event", vxse43(), late, 1));
    const stopping = l.root.shutdownRuntime(1, late);
    await l.h.settle();
    // Past the drain limit; a tick's replies wake the drain wait, which then ends deadlineExceeded.
    l.set({ wallTimeMs: late.wallTimeMs + 10_500, monotonicMs: late.monotonicMs + 10_500 });
    l.root.tick(l.now);
    await l.h.settle();
    expect(l.root.state.shutdown.stage).toBe("sideEffectFinalization");
    held();
    l.h.release();
    const summary = await stopping;
    expect(l.root.state.shutdown.stageResults.sideEffectFinalization?.result).toEqual({ kind: "completed" });
    expect(sentTo(l, "urgent", from).map(({ request }) => request.kind).filter((kind) => kind === "input" || kind === "shutdownInput"))
      .toEqual(["shutdownInput"]);
    expect(summary).toMatchObject({ code: 3, inFlightInputs: 1 });
    expect(summary.reasons).toEqual(expect.arrayContaining(["mailboxDrain:deadlineExceeded", "mailboxDrain:remainingInputs"]));
    await l.root.diagnostics.flush();
  });

  it("P3-C3B-T05 regression / AC02,AC03: an owner that stops after its finalizeDone gets no grant, and the others are still saved", async () => {
    const driver = fixtureDriver();
    const l = await lifecycle({ runtimeCalls: driver.calls }, stringCodecs);
    // U-F is the oldest dirty unit, so it would be granted first. The units become dirty in the drain stage, so only the
    // final saves save them (an input in the running stage saves at once, P3-UWR-AC03; AC10(7)).
    driver.queue(l.h, fixtureState({ "U-E": "eew", "U-W": "weather", "U-F": "series" },
      { "U-E": pending(30), "U-W": pending(20), "U-F": pending(10) }, "run"), l.now);
    const stop = l.h.hold((place, reply) => place === "urgent" && reply.kind === "finalizeDone");
    const stopping = l.root.shutdownRuntime(1, l.now);
    const fixed = () => l.h.delivered.some(({ place, reply }) => place === "deferred" && reply.kind === "finalizeDone");
    while (!fixed()) await l.h.settle(1);
    l.root.ownerFailed("deferred", new Error("owner thread exited (code 1)"));
    stop();
    l.h.release();
    const summary = await stopping;
    expect(summary).toMatchObject({ code: 2, reasons: ["finalCheckpoint:unsavedUnits"] });
    // The oldest dirty first (U-W, then U-E); U-F, whose owner stopped, gets none.
    expect(l.h.sent.flatMap(({ request }) => request.kind === "checkpointGrant" ? [request.unit] : [])).toEqual(["U-W", "U-E"]);
    expect((["U-E", "U-W", "U-F"] as const).map((unit) => l.root.state.mirror[unit].persistence.kind)).toEqual(["saved", "saved", "pending"]);
  });

  it("P3-C3B-T05 regression / AC03 (P3-C3A-AC09): a finalizeDone handled after the stage's absolute limit, before its timer, is not adopted", async () => {
    const driver = fixtureDriver();
    const l = await lifecycle({ runtimeCalls: driver.calls }, stringCodecs);
    // The units become dirty in the drain stage (an input in the running stage saves at once, P3-UWR-AC03; AC10(7)).
    driver.queue(l.h, fixtureState({ "U-E": "eew", "U-W": "weather", "U-F": "series" },
      { "U-E": pending(30), "U-W": pending(20), "U-F": pending(10) }, "run"), l.now);
    const stop = l.h.hold((place, reply) => place === "weatherCurrent" && reply.kind === "finalizeDone");
    const stopping = l.root.shutdownRuntime(1, l.now);
    while (l.h.held.length === 0) await l.h.settle(1);
    const limit = l.root.state.shutdown.deadlines.sideEffectFinalizationMonotonicMs!;
    // Past the absolute limit by the injected clock; the stage's real timer has not run yet.
    l.set({ wallTimeMs: l.now.wallTimeMs + limit + 1 - l.now.monotonicMs, monotonicMs: limit + 1 });
    stop();
    l.h.release();
    const summary = await stopping;
    expect(summary.code).toBe(2);
    expect(l.root.lateReplyCount).toBeGreaterThanOrEqual(1);
    expect((["U-E", "U-W", "U-F"] as const).map((unit) => l.root.state.mirror[unit].persistence.kind)).toEqual(["saved", "pending", "saved"]);
  });
});
