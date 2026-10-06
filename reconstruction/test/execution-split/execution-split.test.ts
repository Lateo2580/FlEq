import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:http";
import { serialize } from "node:v8";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClockReading, RuntimeUnitDeadline, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { ExecutionPlace, OwnerReply, OwnerRequest } from "../../contracts/p3-execution-split.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { Mailbox } from "../../src/mailbox/mailbox";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { fixtureDriver, fixtureState, recordingNotificationAdapter, stringCodec } from "../checkpoint-shutdown/runtime-fixture";
import { calls, eewEnvelope, notice } from "../notification-delivery/delivery-fixture";
import { envelope, harnessedRoot, idleChannels, manualAdapter, seeded, startHarness, submit, unitBodies } from "./owner-harness";
import type { Harness } from "./owner-harness";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function config() {
  const path = mkdtempSync(join(tmpdir(), "fleq-c3a-"));
  directories.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}
const fixture = (name: string) => readFileSync(`test/fixtures/${name}.xml`);
const doneReplies = (h: Harness) => h.delivered.flatMap(({ place, reply }) => reply.kind === "checkpointDone" ? [{ place, reply }] : []);
const grantsOf = (h: Harness) => h.sent.flatMap(({ request }) => request.kind === "checkpointGrant" ? [request] : []);

// One write-right grant (if any is due) and the owner's checkpointDone reply to it.
async function granted(h: Harness) {
  const from = h.delivered.length;
  const released = h.root.driveCheckpoint();
  await h.settle();
  await released;
  return h.delivered.slice(from).flatMap(({ reply }) => reply.kind === "checkpointDone" ? [reply] : []);
}

// Every object reachable from a value (arrays included), for checks over whole requests and replies.
function* objects(value: unknown): Generator<object> {
  if (value == null || typeof value !== "object") return;
  yield value;
  if (ArrayBuffer.isView(value)) return;
  for (const child of Object.values(value)) yield* objects(child);
}

// Memory checkpoint files with a fault for one unit's slot writes (TEST-PATH (2) only).
function faultyFiles() {
  const files = new Map<string, Uint8Array>();
  const fault: { unit: RuntimeUnitId | null; stage: "write" | "directorySync" | "read" | null } = { unit: null, stage: null };
  const owned = (path: string) => fault.unit != null && path.includes(`${fault.unit}`);
  const system: CheckpointFileSystem = {
    unlinkSync: (path) => { files.delete(path); },
    readFile: (path) => {
      if (fault.stage === "read" && owned(path)) throw new Error("EIO");
      return files.get(path) ?? null;
    },
    mkdir: async () => {},
    open: async (path) => {
      let bytes = new Uint8Array();
      return { write: async (data) => { if (fault.stage === "write" && owned(path)) throw new Error("write failed"); bytes = data.slice(); },
        sync: async () => {}, close: async () => { files.set(path, bytes); } };
    },
    rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    syncDirectory: async () => {
      if (fault.stage === "directorySync" && fault.unit != null && [...files.keys()].some((path) => path.includes(`${fault.unit}-`)))
        throw new Error("directory sync failed");
    },
  };
  return { files, fault, system };
}

describe("P3-C3A execution split (TEST-PATH (2): publisher with in-process owners)", () => {
  it("P3-C3A-T03 contractBoundary / AC02: requests and replies cross as plain data with exactly their kinds' keys", async () => {
    const adapter = manualAdapter();
    let now: ClockReading = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: adapter.adapter });
    await startHarness(h, "t03", now);
    await submit(h, envelope("t03", "VXSE43", "eew", fixture("37_01_01_240613_VXSE43"), now, 1),
      envelope("t03", "VPWS50", "national", fixture("15_18_01_250630_VPWS50"), now, 2),
      envelope("t03", "VPWP50", "series", fixture("81_02_01_260605_VPWP50_high_severity"), now, 3));
    now = { wallTimeMs: now.wallTimeMs + 2_000, monotonicMs: 2_001 };
    h.root.tick(now);
    await h.settle();
    expect(await granted(h)).toHaveLength(1);
    const requestKeys: Readonly<Record<OwnerRequest["kind"], readonly string[]>> = {
      restore: ["clock", "kind", "runId", "sharedMs"], input: ["clock", "envelope", "kind", "sharedMs"],
      deadline: ["clock", "kind", "sharedMs"],
      intentUpdate: ["clock", "decisionClock", "kind", "requestId", "sharedMs", "unit", "updates"],
      checkpointGrant: ["clock", "grantId", "kind", "mode", "retryReason", "sharedMs", "unit"],
      shutdownInput: ["clock", "kind", "sharedMs"], finalize: ["clock", "cutoff", "kind", "sharedMs"],
    };
    const replyKeys: Readonly<Record<OwnerReply["kind"], readonly string[]>> = {
      restored: ["kind", "output", "units"], inputDone: ["decode", "kind", "marks", "output", "processingStartedMs", "settlement"],
      deadlineDone: ["kind", "output"], intentUpdateDone: ["adopted", "kind", "output", "requestId"],
      checkpointDone: ["grantId", "grantStartedMs", "kind", "measurements", "output", "result", "unit", "writeCounts"],
      shutdownInputDone: ["kind", "output"], finalizeDone: ["appliedThrough", "kind", "output"],
    };
    const outputKeys = ["confirmationEvidence", "diagnostics", "displayChanges", "outcomes", "retiredEvents", "units"];
    const deltaKeys = ["admissionCounts", "pendingIntents", "persistence", "unit", "view"];
    const seen = new Set<string>();
    const plain = (value: unknown, allowBytes: boolean) => {
      const found: string[] = [];
      for (const item of objects(value)) {
        const prototype = Object.getPrototypeOf(item);
        if (!(prototype === Object.prototype || prototype === Array.prototype || allowBytes && item instanceof Uint8Array))
          found.push("not plain data");
        const keys = Object.keys(item);
        // No XML node, unit state, terminal intent record or checkpoint envelope anywhere.
        if (keys.includes("children") && keys.includes("attributes")) found.push("XML node");
        if (keys.includes("deliveryRecords")) found.push("terminal intent records");
        if ("schemaVersion" in item && typeof item.schemaVersion === "string" && item.schemaVersion.endsWith("-unit-v1"))
          found.push("unit state");
      }
      // The helper already passed every value through structuredClone; plain prototypes show nothing was lost there.
      expect(found).toEqual([]);
    };
    for (const { request } of h.sent) {
      seen.add(request.kind);
      expect(Object.keys(request).sort(), request.kind).toEqual(requestKeys[request.kind]);
      // Only the parser input carries bytes: the ingress item's encoded body.
      plain(request, request.kind === "input");
      if (request.kind === "input") expect(Object.keys(request.envelope.payload).sort()).toEqual(["item", "kind"]);
    }
    for (const { reply } of h.delivered) {
      seen.add(reply.kind);
      expect(Object.keys(reply).sort(), reply.kind).toEqual(replyKeys[reply.kind]);
      plain(reply, false);
      expect(Object.keys(reply.output).sort()).toEqual(outputKeys);
      for (const delta of reply.output.units) {
        expect(Object.keys(delta).sort()).toEqual(reply.kind === "restored" ? [...deltaKeys, "restoration"].sort() : deltaKeys);
        expect((delta.pendingIntents ?? []).every((intent) => intent.disposition === "pending")).toBe(true);
      }
      if (reply.kind === "restored") for (const unit of reply.units)
        expect(Object.keys(unit).sort()).toEqual([...deltaKeys, "restoration"].sort());
    }
    expect([...seen].sort()).toEqual(["checkpointDone", "checkpointGrant", "deadline", "deadlineDone", "input", "inputDone",
      "intentUpdate", "intentUpdateDone", "restore", "restored"]);
    await h.root.diagnostics.flush();
  });

  it("P3-C3A-T05 contractBoundary / AC06: an ack of a captured g1 keeps g2 pending; the g2 ack saves; an old ack leaves current and intents", async () => {
    let now: ClockReading = { wallTimeMs: 1_713_363_299_001, monotonicMs: 10 };
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const files = nodeCheckpointFileSystem();
    let gated = true;
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: { ...files, syncDirectory: async (path) => { if (gated) await gate; return files.syncDirectory(path); } } });
    await startHarness(h, "t05", now, false);
    await submit(h, envelope("t05", "VXSE43", "first", fixture("37_01_01_240613_VXSE43"), now, 1));
    // The owner captures g1 and holds its directory sync; g2 is adopted after the capture.
    const first = h.root.driveCheckpoint();
    await h.settle();
    expect(h.owners.get("urgent")!["state"]!.checkpointAttempts["U-E"]).toMatchObject({ generation: 1, postCaptureDirtySince: null });
    now = { wallTimeMs: now.wallTimeMs + 1_000, monotonicMs: 1_010 };
    await submit(h, envelope("t05", "VXSE43", "second", fixture("37_01_02_240613_VXSE43"), now, 2));
    const before = h.unit("U-E");
    expect(before.persistence.currentGeneration).toBe(2);
    gated = false;
    release();
    await first;
    await h.settle();
    const [ack] = doneReplies(h);
    expect(ack.reply.result).toMatchObject({ kind: "acknowledged", generation: 1 });
    expect(ack.reply.output.units).toMatchObject([{ unit: "U-E", persistence: { kind: "pending", currentGeneration: 2,
      savedGeneration: 1, dirtySince: 1_010 } }]);
    const after = h.unit("U-E");
    expect(after.current).toBe(before.current);
    expect(after.intents).toBe(before.intents);
    expect(h.root.state.mirror["U-E"].persistence).toMatchObject({ kind: "pending", savedGeneration: 1, dirtySince: 1_010 });
    expect((await granted(h)).map((reply) => reply.result)).toMatchObject([{ kind: "acknowledged", generation: 2 }]);
    expect(h.root.state.mirror["U-E"].persistence).toMatchObject({ kind: "saved", currentGeneration: 2, savedGeneration: 2 });
    await h.root.diagnostics.flush();
  });

  it("P3-C3A-T07 contractBoundary / AC07: a reservation starts the adapter only on its owner's current adoption", async () => {
    const at = (time: number): ClockReading => ({ wallTimeMs: 1_713_363_299_001 + time, monotonicMs: 1 + time });
    let now = at(0);
    const setup = () => {
      const adapter = manualAdapter();
      const seeds = seeded(calls.units);
      const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: adapter.adapter,
        runtimeCalls: { ...calls, units: seeds.units } });
      return { h, adapter, seeds };
    };
    // Holds a place's replies from its first reply of `kind` on, keeping that owner's port order.
    const holdFrom = (h: Harness, place: ExecutionPlace, kind: OwnerReply["kind"]) => {
      let holding = false;
      return h.hold((from, reply) => from === place && (holding ||= reply.kind === kind));
    };
    const updates = (h: Harness) => h.sent.flatMap(({ request }) => request.kind === "intentUpdate" ? [request] : []);
    const cancel = (sequence: number) => envelope("t07", "VXSE43", "cancel", fixture("37_01_03_240613_VXSE43"), now, sequence);

    // (1) The EEW intent is cancelled between the reservation and the owner's adoption: adopted=false, no adapter call,
    // the channel stays idle, and the next choice comes from the updated mirror.
    {
      const { h, adapter } = setup();
      await startHarness(h, "t07", now, false);
      await submit(h, eewEnvelope("t07", now));
      const original = new Set(h.unit("U-E").intents.map((intent) => intent.id));
      h.pause();
      h.root.mailbox.enqueue(cancel(2));
      h.root.pump();
      const release = h.hold((_place, reply) => reply.kind === "intentUpdateDone");
      h.root.dispatch({ kind: "notificationProbeCompleted", channels: idleChannels, clock: now });
      await h.settle();
      // One reservation per channel, both for the cancelled event; the owner adopts neither.
      const reserved = updates(h);
      expect(reserved.map((request) => request.updates.map((update) => original.has(update.id)))).toEqual([[true], [true]]);
      expect(h.held.map(({ reply }) => reply.kind === "intentUpdateDone" && reply.adopted)).toEqual([false, false]);
      expect(h.root.state.notificationChannels).toMatchObject({ desktop: { kind: "idle" }, sound: { kind: "idle" } });
      release();
      h.release();
      await h.settle();
      expect(adapter.runs.filter((run) => original.has(run.attempt.intentId))).toEqual([]);
      // Re-selected from the updated mirror: the cancelled intents are gone, so nothing new is reserved.
      expect(h.root.state.mirror["U-E"].pendingIntents.filter((intent) => original.has(intent.id))).toEqual([]);
      expect(updates(h)).toHaveLength(2);
      expect(h.root.state.notificationChannels).toMatchObject({ desktop: { kind: "idle" }, sound: { kind: "idle" } });
      await h.root.diagnostics.flush();
    }

    // (2)(4)(5)(6) U-W holds a desktop reservation the owner has adopted; an urgent U-E intent takes the channel.
    {
      const { h, adapter, seeds } = setup();
      now = at(0);
      await startHarness(h, "t07", now);
      const weather = holdFrom(h, "weatherCurrent", "intentUpdateDone");
      await seeds.weather(h, { ...initialUnits["U-W"], intents: [notice("w-desktop", "desktop", now.wallTimeMs)] }, null, now);
      const urgent = holdFrom(h, "urgent", "intentUpdateDone");
      await submit(h, eewEnvelope("t07", now));
      // (4) nothing runs before the adoption reply arrives.
      expect(adapter.runs).toEqual([]);
      urgent();
      h.release((place) => place === "urgent");
      await h.settle();
      // (4) each adopted reservation runs the adapter once, after the reply; (5) sound is chosen while U-W waits on desktop.
      expect(adapter.runs.map((run) => [run.attempt.unit, run.attempt.channel]).sort()).toEqual([["U-E", "desktop"], ["U-E", "sound"]]);
      weather();
      h.release();
      await h.settle();
      // (2) the late U-W adoption starts nothing and leaves the channel with U-E.
      expect(adapter.runs).toHaveLength(2);
      expect(h.root.state.notificationChannels.desktop).toMatchObject({ kind: "running", attempt: { unit: "U-E" } });
      // (6) NOTIFY-ADOPT=A: the owner's adoption used one attempt, so the first real failure waits 2 s.
      expect(h.unit("U-W").intents[0]).toMatchObject({ id: "w-desktop", attempts: 1 });
      for (const run of adapter.runs) adapter.finish({ kind: "delivered", attemptId: run.attempt.attemptId,
        intentId: run.attempt.intentId, channel: run.attempt.channel, completedAt: now });
      await h.settle();
      const retry = adapter.runs.find((run) => run.attempt.unit === "U-W")!;
      expect(retry.attempt.intentId).toBe("w-desktop");
      const completedAt = at(100);
      now = completedAt;
      adapter.finish({ kind: "failed", reason: "adapterError", attemptId: retry.attempt.attemptId, intentId: "w-desktop",
        channel: "desktop", completedAt });
      await h.settle();
      expect(h.unit("U-W").intents[0]).toMatchObject({ attempts: 2, nextAttemptAt: completedAt.wallTimeMs + 2_000 });
      await h.root.diagnostics.flush();
    }

    // D3 (use-time check): an adoption that arrives after the intent's expiry, with no tick or input between, starts
    // nothing (X3).
    {
      const { h, adapter } = setup();
      now = at(0);
      await startHarness(h, "t07", now);
      const urgent = holdFrom(h, "urgent", "intentUpdateDone");
      await submit(h, eewEnvelope("t07", now));
      expect(h.held.filter(({ reply }) => reply.kind === "intentUpdateDone" && reply.adopted)).toHaveLength(2);
      now = at(15_001);
      urgent();
      h.release();
      await h.settle();
      expect(adapter.runs).toEqual([]);
      await h.root.diagnostics.flush();
    }

    // (3) A shutdown request voids a reservation whose adoption is still in transit.
    {
      const { h, adapter, seeds } = setup();
      now = at(0);
      await startHarness(h, "t07", now);
      const weather = holdFrom(h, "weatherCurrent", "intentUpdateDone");
      await seeds.weather(h, { ...initialUnits["U-W"], intents: [notice("w-stop", "desktop", now.wallTimeMs)] }, null, now);
      expect(h.held.some(({ reply }) => reply.kind === "intentUpdateDone" && reply.adopted)).toBe(true);
      const stopping = h.root.shutdownRuntime(1, now);
      weather();
      h.release();
      await h.settle();
      await stopping;
      expect(adapter.runs).toEqual([]);
    }

    // (7) NOTIFY-ADOPT=A: a U-E reservation adopted by its owner but void (expired) still makes a later 取消 notify.
    {
      const { h, adapter } = setup();
      now = at(0);
      await startHarness(h, "t07", now);
      const urgent = holdFrom(h, "urgent", "intentUpdateDone");
      await submit(h, eewEnvelope("t07", now));
      expect(h.held.some(({ reply }) => reply.kind === "intentUpdateDone" && reply.adopted)).toBe(true);
      now = at(15_001);
      h.root.tick(now);
      await h.settle();
      urgent();
      h.release();
      await h.settle();
      expect(adapter.runs).toEqual([]);
      await submit(h, cancel(3));
      expect(h.unit("U-E").intents.filter((intent) => intent.payload.level === "cancel")).not.toEqual([]);
      await h.root.diagnostics.flush();
    }
  });

  it("P3-C3A-T12 contractBoundary / AC02: business time follows the injected clock, measured time the shared real clock", async () => {
    // (1) An input sent before a U-F deadline and applied after it (the real clock moved on in transit) is judged as
    // a sequential runtime judges it at the application time.
    const series = "81_03_01_260605_VPWP50_unknown_code";
    const date = Date.parse("2026-06-05T17:00:00+09:00");
    const reading = (wall: number): ClockReading => ({ wallTimeMs: wall, monotonicMs: wall - date + 1 });
    let shared = 0;
    let now = reading(date);
    const split = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter(),
      owners: { sharedNow: () => shared } });
    await startHarness(split, "t12", now);
    await submit(split, envelope("t12", "VPWP50", series, fixture(series), now, 1));
    const validUntil = split.unit("U-F").subjects[0].validUntil!;
    split.pause();
    now = reading(validUntil - 1);
    split.root.mailbox.enqueue(envelope("t12", "VPWP50", series, fixture(series), now, 2));
    split.root.pump();
    shared += 2;
    await split.settle();
    const sequential = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter() });
    now = reading(date);
    await startHarness(sequential, "t12", now);
    await submit(sequential, envelope("t12", "VPWP50", series, fixture(series), now, 1));
    now = reading(validUntil + 1);
    await submit(sequential, envelope("t12", "VPWP50", series, fixture(series), now, 2));
    expect(split.unit("U-F").subjects).toEqual(sequential.unit("U-F").subjects);
    expect(split.unit("U-F").subjects[0].effective).toBe("noActiveItems");
    await Promise.all([split.root.diagnostics.flush(), sequential.root.diagnostics.flush()]);

    // (2) An update the owner applies after a grant was sent but before it is applied is in the capture; capturedAt is
    // the grant's application time and ackAt follows the directory sync.
    {
      let real = 0;
      const clock = { wallTimeMs: 1_800_000_000_000, monotonicMs: 100 };
      const files = faultyFiles();
      const driver = fixtureDriver();
      const h = harnessedRoot(config(), { "U-F": stringCodec("U-F") }, { clock: () => clock, notificationAdapter: recordingNotificationAdapter(),
        runtimeCalls: driver.calls, owners: { sharedNow: () => real },
        checkpointFileSystem: { ...files.system, syncDirectory: async (path) => { real += 5; return files.system.syncDirectory(path); } } });
      await startHarness(h, "t12", clock);
      const dirty = (generation: number) => fixtureState({ "U-F": `v${generation}` }, { "U-F": { kind: "pending",
        currentGeneration: generation, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 1 } }, "t12");
      await driver.update(h, dirty(1), clock);
      h.pause();
      driver.queue(h, dirty(2), clock);
      h.root.pump();
      const released = h.root.driveCheckpoint();
      real += 3;
      await h.settle();
      await released;
      const [done] = doneReplies(h);
      expect(done.reply.result).toMatchObject({ kind: "acknowledged", generation: 2, ackAt: clock.wallTimeMs + 3 + 5 });
      expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "saved", savedGeneration: 2,
        savedCapturedAt: clock.wallTimeMs + 3, savedAckAt: clock.wallTimeMs + 8 });
      await h.root.diagnostics.flush();
    }

    // (3) The injected clock runs 10 s ahead of the real one: business times keep the offset, measured times do not.
    {
      const offset = 10_000;
      const injected = () => ({ wallTimeMs: Date.now() + offset, monotonicMs: performance.now() + offset });
      const markers: { point: string; sequence: number; monotonicMs: number }[] = [];
      const server = await startDisplayServer({ host: "127.0.0.1", port: 0,
        worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
        onMarker: (marker, version) => markers.push({ point: marker.point, sequence: version.sequence, monotonicMs: marker.monotonicMs }) });
      try {
        const inputs: Extract<OwnerReply, { kind: "inputDone" }>[] = [];
        const measurements: { startedMonotonicMs: number; endedMonotonicMs: number }[] = [];
        const h = harnessedRoot(config(), linkedUnitCodecs, { clock: injected, notificationAdapter: recordingNotificationAdapter(),
          owners: { sharedNow: () => performance.now() }, onInputDone: (reply) => inputs.push(reply),
          onMeasurements: (batch) => measurements.push(...batch),
          display: { publish: server.publish, onMarker: (marker, version) =>
            markers.push({ point: marker.point, sequence: version.sequence, monotonicMs: marker.monotonicMs }) } });
        await startHarness(h, "t12", injected(), false);
        await new Promise<void>((resolve, reject) => {
          get({ host: "127.0.0.1", port: server.port, path: "/events", agent: false }, (response) => {
            response.on("data", () => {});
            response.on("error", () => {});
            resolve();
          }).on("error", reject);
        });
        const received = { wallTimeMs: Date.now(), monotonicMs: performance.now() };
        // T0 at receive, T1 at enqueue (the host's measured clock).
        const input = { ...envelope("t12", "VXSE43", "offset", fixture("37_01_01_240613_VXSE43"), received, 1),
          enqueuedMonotonicMs: performance.now() };
        await submit(h, input);
        for (let turn = 0; turn < 20 && !markers.some((marker) => marker.point === "T4" && marker.sequence === 2); turn += 1)
          await new Promise((resolve) => setTimeout(resolve, 5));
        const sent = h.sent.find(({ request }) => request.kind === "input")!.request;
        const [done] = inputs;
        const t3 = markers.find((marker) => marker.point === "T3" && marker.sequence === 2)!.monotonicMs;
        const t4 = markers.find((marker) => marker.point === "T4" && marker.sequence === 2)!.monotonicMs;
        const order = [input.t0MonotonicMs, input.enqueuedMonotonicMs, done.processingStartedMs,
          done.decode!.startedMonotonicMs, done.decode!.endedMonotonicMs, t3, t4];
        expect(order).toEqual([...order].sort((left, right) => left - right));
        // complete starts no earlier than the send (business time, with the offset).
        expect(done.settlement.startedMonotonicMs).toBeGreaterThanOrEqual(sent.clock.monotonicMs);
        expect(done.settlement.startedMonotonicMs - done.processingStartedMs).toBeGreaterThanOrEqual(offset - 1_000);
        const dirtySince = h.root.state.mirror["U-E"].persistence.dirtySince!;
        expect(dirtySince - done.processingStartedMs).toBeGreaterThanOrEqual(offset - 1_000);
        expect(dirtySince - done.processingStartedMs).toBeLessThanOrEqual(offset + 1_000);
        const before = Date.now();
        const [saved] = await granted(h);
        expect(saved.result!.kind).toBe("acknowledged");
        const capturedAt = h.root.state.mirror["U-E"].persistence.savedCapturedAt!;
        expect(capturedAt - before).toBeGreaterThanOrEqual(offset - 1_000);
        expect(capturedAt - before).toBeLessThanOrEqual(offset + 1_000);
        // Measured intervals carry no offset and never run backwards.
        for (const measurement of [...measurements, ...saved.measurements]) {
          expect(measurement.endedMonotonicMs).toBeGreaterThanOrEqual(measurement.startedMonotonicMs);
          expect(Math.abs(measurement.startedMonotonicMs - performance.now())).toBeLessThan(offset / 2);
        }
        await h.root.diagnostics.flush();
      } finally { await server.close(); }
    }

    // (4) A success completed at 14 s on a 15 s intent stays delivered when its owner applies it at 16 s.
    {
      const adapter = manualAdapter();
      const at = (time: number): ClockReading => ({ wallTimeMs: 1_713_363_299_001 + time, monotonicMs: 1 + time });
      let clock = at(0);
      const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => clock, notificationAdapter: adapter.adapter });
      // The attempts start at 10 s (the probe ends then), so a success at 14 s is inside their 15 s timeout and expiry.
      await startHarness(h, "t12", clock, false);
      await submit(h, eewEnvelope("t12", clock));
      clock = at(10_000);
      h.root.dispatch({ kind: "notificationProbeCompleted", channels: idleChannels, clock });
      await h.settle();
      expect(adapter.runs).toHaveLength(2);
      clock = at(16_000);
      for (const run of adapter.runs) adapter.finish({ kind: "delivered", attemptId: run.attempt.attemptId,
        intentId: run.attempt.intentId, channel: run.attempt.channel, completedAt: at(14_000) });
      await h.settle();
      expect(h.unit("U-E").deliveryRecords.filter((record) => adapter.runs.some((run) => run.attempt.intentId === record.intentId))
        .map((record) => record.disposition)).toEqual(["delivered", "delivered"]);
      await h.root.diagnostics.flush();
    }
  });

  it("P3-C3A-T13 contractBoundary / AC15,AC09: owner requests stay bounded, and finalization fixes one cutoff", async () => {
    const at = (time: number): ClockReading => ({ wallTimeMs: 1_713_363_299_001 + time, monotonicMs: 1 + time });
    const channelOf = (id: string) => id.endsWith(":sound") ? "sound" : "desktop";
    // Held replies: one outstanding deadline per owner, at most two intent updates per channel; the next tick after
    // delivery sends one deadline with the latest clock.
    {
      const adapter = manualAdapter();
      let clock = at(0);
      const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => clock, notificationAdapter: adapter.adapter });
      await startHarness(h, "t13", clock);
      await submit(h, eewEnvelope("t13", clock));
      const from = h.sent.length;
      const release = h.hold((place) => place === "urgent");
      for (let tick = 1; tick <= 10; tick += 1) {
        clock = at(tick * 2_000);
        h.root.tick(clock);
        await h.settle();
      }
      const toUrgent = h.sent.slice(from).filter(({ place }) => place === "urgent").map(({ request }) => request);
      expect(toUrgent.filter((request) => request.kind === "deadline")).toHaveLength(1);
      for (const channel of ["desktop", "sound"] as const)
        expect(toUrgent.filter((request) => request.kind === "intentUpdate"
          && request.updates.some((update) => channelOf(update.id) === channel)).length).toBeLessThanOrEqual(2);
      release();
      h.release();
      await h.settle();
      const before = h.sent.length;
      clock = at(22_000);
      h.root.tick(clock);
      const next = h.sent.slice(before).filter(({ place, request }) => place === "urgent" && request.kind === "deadline");
      expect(next.map(({ request }) => request.clock)).toEqual([clock]);
      await h.settle();
      await h.root.diagnostics.flush();
    }
    // An owner whose checkpoint I/O is held still takes and answers inputs.
    {
      let clock = at(0);
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const files = nodeCheckpointFileSystem();
      const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => clock, notificationAdapter: recordingNotificationAdapter(),
        checkpointFileSystem: { ...files, syncDirectory: async (path) => { await gate; return files.syncDirectory(path); } } });
      await startHarness(h, "t13", clock, false);
      await submit(h, envelope("t13", "VXSE43", "first", fixture("37_01_01_240613_VXSE43"), clock, 1));
      const writing = h.root.driveCheckpoint();
      await h.settle();
      clock = at(1_000);
      await submit(h, envelope("t13", "VXSE43", "second", fixture("37_01_02_240613_VXSE43"), clock, 2));
      expect(h.root.checkpoint.grant).not.toBeNull();
      expect(h.delivered.some(({ reply }) => reply.kind === "inputDone" && reply.settlement.inputId === "second")).toBe(true);
      release();
      await writing;
      await h.root.diagnostics.flush();
    }

    // Finalization (spec §5.9): stub units record every deadline they apply, at the clock the owner applies it with.
    const second = (time: number): ClockReading => ({ wallTimeMs: 1_800_000_000_000 + time * 1_000, monotonicMs: time * 1_000 });
    const recordingUnits = (next: (unit: RuntimeUnitId, kind: string) => RuntimeUnitDeadline | null) => {
      const driver = fixtureDriver();
      const applied: { unit: RuntimeUnitId; wallTimeMs: number }[] = [];
      const base = driver.calls.units;
      const wrap = <K extends RuntimeUnitId>(unit: K): UnitTable[K] => ({ ...base[unit], reduce: (state, input) => {
        if (input.kind === "deadline") applied.push({ unit, wallTimeMs: input.clock.wallTimeMs });
        const step = base[unit].reduce(state, input);
        return { ...step, nextDeadline: next(unit, input.kind) ?? step.nextDeadline };
      } });
      return { driver, applied, units: { "U-E": wrap("U-E"), "U-W": wrap("U-W"), "U-F": wrap("U-F") } };
    };
    const codecs = { "U-E": stringCodec("U-E"), "U-W": stringCodec("U-W"), "U-F": stringCodec("U-F") };
    const dirty = (runId: string) => {
      const status = (dirtySince: number) => ({ kind: "pending" as const, currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince });
      return fixtureState({ "U-E": "e", "U-F": "f" }, { "U-E": status(2), "U-F": status(1) }, runId);
    };

    // (1) A deadline request sent at 99 s and applied at 102 s: the cutoff waits for its reply, and no owner applies a
    // deadline later than finalizationAt.
    {
      const { driver, applied, units } = recordingUnits(() => null);
      let clock = second(90);
      const h = harnessedRoot(config(), codecs, { clock: () => clock, notificationAdapter: recordingNotificationAdapter(),
        runtimeCalls: { ...driver.calls, units }, checkpointFileSystem: faultyFiles().system });
      await startHarness(h, "t13", clock);
      await driver.update(h, dirty("t13"), clock);
      clock = second(99);
      const held = h.holdRequests((place, request) => place === "urgent" && request.kind === "deadline");
      h.root.tick(clock);
      await h.settle();
      clock = second(100);
      const stopping = h.root.shutdownRuntime(1, clock);
      await h.settle();
      expect(h.root.state.shutdown.stageResults.mailboxDrain?.result.kind).toBe("completed");
      clock = second(102);
      held();
      h.releaseRequests("urgent");
      expect((await stopping).code).toBe(0);
      const finalizationAt = h.root.state.shutdown.finalizationAt!;
      expect(finalizationAt).toBeGreaterThanOrEqual(second(102).wallTimeMs);
      expect(applied.filter((item) => item.wallTimeMs > finalizationAt)).toEqual([]);
    }

    // (2) Owner B's finalize arrives 2 s late: the cutoff-1 ms deadline applies in both owners, the cutoff+1 ms one in
    // neither, and finalizationAt is the cutoff's wall clock, not B's reply time.
    {
      const cutoff = second(200);
      const deadlines: Partial<Record<RuntimeUnitId, RuntimeUnitDeadline>> = {};
      const { driver, applied, units } = recordingUnits((unit, kind) => {
        if (kind === "receive" && deadlines[unit] == null) deadlines[unit] = { wallTimeMs: cutoff.wallTimeMs - 1, monotonicMs: null };
        if (kind === "deadline") deadlines[unit] = { wallTimeMs: cutoff.wallTimeMs + 1, monotonicMs: null };
        return deadlines[unit] ?? null;
      });
      let clock = second(195);
      const h = harnessedRoot(config(), codecs, { clock: () => clock, notificationAdapter: recordingNotificationAdapter(),
        runtimeCalls: { ...driver.calls, units }, checkpointFileSystem: faultyFiles().system });
      await startHarness(h, "t13", clock);
      for (const unit of ["U-E", "U-F"] as const)
        await submit(h, envelope("t13", unitBodies[unit].headType, `deadline-${unit}`, unitBodies[unit].body, clock, unit === "U-E" ? 1 : 2));
      clock = cutoff;
      const held = h.holdRequests((place, request) => place === "deferred" && request.kind === "finalize");
      const stopping = h.root.shutdownRuntime(1, clock);
      for (let turn = 0; turn < 20 && h.heldRequests.length === 0; turn += 1) await h.settle(1);
      expect(h.heldRequests.map(({ request }) => request.kind)).toEqual(["finalize"]);
      clock = second(202);
      held();
      h.releaseRequests("deferred");
      await stopping;
      expect(applied.filter((item) => item.unit !== "U-W")).toEqual([
        { unit: "U-E", wallTimeMs: cutoff.wallTimeMs }, { unit: "U-F", wallTimeMs: cutoff.wallTimeMs }]);
      expect(h.root.state.shutdown.finalizationAt).toBe(cutoff.wallTimeMs);
    }

    // (3) Owner B's earlier reply (its checkpointDone, holding the write right) is held past the stage deadline: no
    // cutoff, no finalize, no final-save right, every unit unsaved (code 2); B's late reply only releases the right.
    {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { driver, units } = recordingUnits(() => null);
      let clock = second(300);
      const h = harnessedRoot(config(), codecs, { clock: () => clock, notificationAdapter: recordingNotificationAdapter(),
        runtimeCalls: { ...driver.calls, units }, checkpointFileSystem: faultyFiles().system });
      await startHarness(h, "t13", clock);
      await driver.update(h, dirty("t13"), clock);
      const release = h.hold((place, reply) => place === "deferred" && reply.kind === "checkpointDone");
      void h.root.driveCheckpoint();
      for (let turn = 0; turn < 50 && !h.held.some(({ reply }) => reply.kind === "checkpointDone"); turn += 1) await h.settle(1);
      expect(h.held.map(({ reply }) => reply.kind)).toEqual(["checkpointDone"]);
      expect(h.root.checkpoint.grant?.unit).toBe("U-F");
      const granting = grantsOf(h).length;
      const stopping = h.root.shutdownRuntime(1, clock);
      await h.settle();
      clock = second(305);
      await vi.advanceTimersByTimeAsync(5_000);
      clock = second(315);
      await vi.advanceTimersByTimeAsync(10_000);
      const summary = await stopping;
      const { stageResults } = h.root.state.shutdown;
      expect(h.root.state.shutdown.finalizationAt).toBeNull();
      expect(stageResults.sideEffectFinalization?.result.kind).toBe("deadlineExceeded");
      expect(h.sent.some(({ request }) => request.kind === "finalize")).toBe(false);
      expect(grantsOf(h)).toHaveLength(granting);
      expect(stageResults.finalCheckpoint?.pending.unsavedUnits).toBe(3);
      expect(summary.code).toBe(2);
      expect(stageResults.workerClose?.result.kind).toBe("completed");
      expect(h.root.checkpoint.grant).not.toBeNull();
      const mirror = h.root.state.mirror["U-F"];
      release();
      h.release();
      await h.settle();
      expect(h.root.checkpoint.grant).toBeNull();
      expect(h.root.state.mirror["U-F"]).toBe(mirror);
      // AC09: the late reply is only counted (X5).
      expect(h.root.lateReplyCount).toBe(1);
      expect((await h.root.readDiagnostics({ limit: 256 })).records.filter((event) => event.reason === "ownerReplyLate"))
        .toEqual([expect.objectContaining({ level: "WARN", count: 1 })]);
      vi.useRealTimers();
    }

    // (4) After the cutoff, owner A's finalizeDone arrives in time and B's late: A's unit is saved, B's gets no right and
    // counts unsaved, and B's late finalizeDone is not adopted.
    {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { driver, units } = recordingUnits(() => null);
      let clock = second(400);
      const h = harnessedRoot(config(), codecs, { clock: () => clock, notificationAdapter: recordingNotificationAdapter(),
        runtimeCalls: { ...driver.calls, units }, checkpointFileSystem: faultyFiles().system });
      await startHarness(h, "t13", clock);
      await driver.update(h, dirty("t13"), clock);
      const release = h.hold((place, reply) => place === "deferred" && reply.kind === "finalizeDone");
      const granting = grantsOf(h).length;
      const stopping = h.root.shutdownRuntime(1, clock);
      await h.settle();
      clock = second(405);
      await vi.advanceTimersByTimeAsync(5_000);
      await h.settle();
      const summary = await stopping;
      expect(h.root.state.shutdown.finalizationAt).toBe(second(400).wallTimeMs);
      expect(grantsOf(h).slice(granting).map((grant) => grant.unit)).toEqual(["U-E"]);
      expect(summary.persistence["U-E"]).toMatchObject({ kind: "saved" });
      expect(summary.persistence["U-F"]?.kind).not.toBe("saved");
      expect(h.root.state.shutdown.stageResults.finalCheckpoint?.pending.unsavedUnits).toBe(1);
      const mirror = h.root.state.mirror["U-F"];
      release();
      h.release();
      await h.settle();
      expect(h.root.state.mirror["U-F"]).toBe(mirror);
      // AC09: B's late finalizeDone is only counted (X5).
      expect(h.root.lateReplyCount).toBe(1);
      expect((await h.root.readDiagnostics({ limit: 256 })).records.filter((event) => event.reason === "ownerReplyLate"))
        .toHaveLength(1);
      vi.useRealTimers();
    }
  });

  it("P3-C3A-T08 corpusHistory / AC08: VPWS50, VXSE43 and VPWP50 in flight together end as the sequential run", async () => {
    const at: ClockReading = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
    const inputs = () => [envelope("t08", "VPWS50", "weather", fixture("15_18_01_250630_VPWS50"), at, 1),
      envelope("t08", "VXSE43", "eew", fixture("37_01_01_240613_VXSE43"), at, 2),
      envelope("t08", "VPWP50", "series", fixture("81_02_01_260605_VPWP50_high_severity"), at, 3)];
    const run = async (together: boolean) => {
      const published: DisplaySnapshot[] = [];
      const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => at, notificationAdapter: recordingNotificationAdapter(),
        display: { publish: (snapshot) => { published.push(snapshot); } } });
      await startHarness(h, "t08", at);
      if (together) await submit(h, ...inputs());
      else for (const input of inputs()) await submit(h, input);
      await h.root.diagnostics.flush();
      return { h, published };
    };
    const split = await run(true);
    const sequential = await run(false);
    expect(split.h.root.state.mirror).toEqual(sequential.h.root.state.mirror);
    const content = (snapshot: DisplaySnapshot) => ({ ...snapshot, streamId: "", sequence: 0 });
    expect(content(split.published.at(-1)!)).toEqual(content(sequential.published.at(-1)!));
    // Invariants of every intermediate snapshot: the sequence rises, and no unit's view goes back to an older revision.
    const revision = (value: string) => value.split(":").map(Number);
    const older = (left: number[], right: number[]) => left.some((part, index) => part !== right[index])
      && left.findIndex((part, index) => part !== right[index]) >= 0
      && left[left.findIndex((part, index) => part !== right[index])] < right[left.findIndex((part, index) => part !== right[index])];
    for (const [index, snapshot] of split.published.entries()) {
      if (index === 0) continue;
      const before = split.published[index - 1];
      expect(snapshot.sequence).toBeGreaterThan(before.sequence);
      for (const domain of ["eew", "weatherCurrent", "weatherTimeseries"] as const)
        expect(older(revision(snapshot.current[domain].contentRevision), revision(before.current[domain].contentRevision)), domain).toBe(false);
    }
  });

  it("P3-C3A-T11 contractBoundary / AC14: one reply is adopted without serializing the mirror, with one A7 selection; one mailbox pass", async () => {
    const at: ClockReading = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
    let selections = 0;
    const seeds = seeded(calls.units);
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => at, notificationAdapter: manualAdapter().adapter,
      runtimeCalls: { ...calls, units: seeds.units, selectNotificationAttempt: (...args) => {
        selections += 1;
        return calls.selectNotificationAttempt(...args);
      } } });
    await startHarness(h, "t11", at);
    const intents = (unit: RuntimeUnitId, count: number) => Array.from({ length: count }, (_, index) =>
      ({ ...notice(`${unit}-${index}`, index % 2 === 0 ? "desktop" : "sound", at.wallTimeMs), unit }));
    await seeds.weather(h, { ...initialUnits["U-W"], intents: intents("U-W", 128) }, null, at);
    await seeds.series(h, { ...initialUnits["U-F"], intents: intents("U-F", 128) }, null, at);
    await seeds.eew(h, { ...initialUnits["U-E"], intents: intents("U-E", 126).map((intent) => ({ ...intent,
      payload: { domain: "earthquake-eew" as const, level: "warning" as const, title: intent.id, body: intent.id } })) }, null, at);
    h.hold((place, reply) => place === "urgent" && reply.kind === "inputDone");
    await submit(h, envelope("t11", "VXSE43", "eew", fixture("37_01_01_240613_VXSE43"), at, 1));
    const watched = (mirror: typeof h.root.state.mirror) => (["U-E", "U-W", "U-F"] as const)
      .flatMap((unit): unknown[] => [mirror[unit], mirror[unit].pendingIntents, mirror[unit].view]);
    const before = h.root.state.mirror;
    const stringify = vi.spyOn(JSON, "stringify");
    const clone = vi.spyOn(globalThis, "structuredClone");
    selections = 0;
    h.release();
    const after = h.root.state.mirror;
    const targets = new Set<unknown>([before, after, ...watched(before), ...watched(after)]);
    const touched = [...stringify.mock.calls, ...clone.mock.calls].filter(([value]) => targets.has(value));
    stringify.mockRestore();
    clone.mockRestore();
    expect(after["U-E"].pendingIntents).toHaveLength(128);
    expect(touched).toEqual([]);
    expect(selections).toBe(1);
    await h.settle();
    await h.root.diagnostics.flush();

    // RES-08: with 120 pending items, one takeNext decides each entry's ordering domain once (two headType reads per
    // entry: the check and the record); the former pairwise scan read it about n² times.
    const mailbox = new Mailbox();
    const reads = { count: 0 };
    for (let index = 0; index < 120; index += 1) {
      const input = envelope("t11", ["VPWS50", "VPWP50", "VTSE41"][index % 3], `queued-${index}`, new Uint8Array(1), at, index + 1);
      mailbox.enqueue(input);
      const headType = input.payload.item.headType;
      Object.defineProperty(input.payload.item, "headType", { get: () => { reads.count += 1; return headType; } });
    }
    reads.count = 0;
    expect(mailbox.takeNext(2)).not.toBeNull();
    expect(reads.count).toBeLessThanOrEqual(2 * 120);
  });

  it("P3-C3A-T13 regression / AC15: held result and expiry updates neither grow per tick nor reselect their intent (X1)", async () => {
    const at = (time: number): ClockReading => ({ wallTimeMs: 1_713_363_299_001 + time, monotonicMs: 1 + time });
    let clock = at(0);
    const adapter = manualAdapter();
    const seeds = seeded(calls.units);
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => clock, notificationAdapter: adapter.adapter,
      runtimeCalls: { ...calls, units: seeds.units } });
    await startHarness(h, "x1", clock);
    const intent = (id: string, expiresIn: number) => ({ ...notice(id, "desktop", clock.wallTimeMs), expiresAt: clock.wallTimeMs + expiresIn });
    await seeds.weather(h, { ...initialUnits["U-W"], intents: [intent("a", 180_000)] }, null, clock);
    expect(adapter.runs.map((run) => run.attempt.intentId)).toEqual(["a"]);
    // b and c arrive while a runs on desktop.
    await seeds.weather(h, { ...h.unit("U-W"), intents: [...h.unit("U-W").intents, intent("b", 2_000), intent("c", 3_000)] }, null, clock);
    // Every U-W reply waits from its next intent update on (port order kept); b's expiry update takes the update slot.
    let holding = false;
    h.hold((place, reply) => place === "weatherCurrent" && (holding ||= reply.kind === "intentUpdateDone"));
    clock = at(2_500);
    h.root.tick(clock);
    await h.settle();
    clock = at(3_500);
    h.root.tick(clock);
    await h.settle();
    adapter.finish({ kind: "delivered", attemptId: adapter.runs[0].attempt.attemptId, intentId: "a", channel: "desktop", completedAt: clock });
    await h.settle();
    const updates = () => h.sent.flatMap(({ request }) => request.kind === "intentUpdate" ? [request] : []);
    const sent = updates().length;
    const held = () => h.root["heldUpdates"].length;
    expect(held()).toBe(2);
    for (let tick = 1; tick <= 10; tick += 1) {
      clock = at(3_500 + tick * 1_000);
      h.root.tick(clock);
      await h.settle();
    }
    // c's expiry and a's delivered result each wait once; a is not tried again while its result waits.
    expect([held(), updates().length, adapter.runs.length]).toEqual([2, sent, 1]);
    for (let round = 0; round < 6; round += 1) {
      h.release();
      await h.settle();
    }
    const sends = (id: string) => updates().filter((request) => request.updates.some((update) => update.id === id)).length;
    expect([sends("b"), sends("c")]).toEqual([1, 1]);
    expect(sends("a")).toBe(2); // the reservation, then its delivered result
    expect(h.root.state.mirror["U-W"].pendingIntents).toEqual([]);
    expect(h.unit("U-W").intents.map((item) => [item.id, item.disposition])).toEqual([["a", "delivered"]]);
    await h.root.diagnostics.flush();
  });

  it("P3-C3A-T13 regression / AC09: inputs left when the drain stage ends are not sent to an owner (Y1)", async () => {
    let clock: ClockReading = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
    const h: Harness = harnessedRoot(config(), linkedUnitCodecs, { clock: () => clock, notificationAdapter: recordingNotificationAdapter(),
      shutdownHooks: { drainMailbox: async (_deadline, active) => h.root.drainInputs(active) } });
    await startHarness(h, "y1", clock);
    const body = fixture("15_16_02_251222_VPWW57");
    const release = h.hold((place, reply) => place === "weatherCurrent" && reply.kind === "inputDone");
    for (let index = 1; index <= 6; index += 1) h.root.mailbox.enqueue(envelope("y1", "VPWW57", `in-${index}`, body, clock, index));
    h.root.pump();
    await h.settle();
    const inputs = () => h.sent.filter(({ request }) => request.kind === "input").length;
    expect(inputs()).toBe(1);
    const stopping = h.root.shutdownRuntime(6, clock);
    // The drain stage runs out while in-1 is still unanswered.
    clock = { wallTimeMs: clock.wallTimeMs + 10_500, monotonicMs: clock.monotonicMs + 10_500 };
    h.root["wake"]();
    for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setImmediate(done));
    release();
    h.release();
    for (let turn = 0; turn < 10; turn += 1) await h.settle();
    const summary = await stopping;
    expect(inputs()).toBe(1);
    expect(summary).toMatchObject({ pendingInputs: 5 });
    expect(h.root.state.shutdown.stageResults.mailboxDrain?.result.kind).toBe("deadlineExceeded");
    await h.root.diagnostics.flush();
  });

  it("P3-C3A-T11 contractBoundary / AC14,RES-07: per reply at most one view per changed unit, measured here only (Y3)", async () => {
    const at: ClockReading = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
    let serializations = 0;
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0,
      worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
      onSerialize: () => { serializations += 1; } });
    try {
      const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => at, notificationAdapter: manualAdapter().adapter,
        display: { publish: server.publish } });
      await startHarness(h, "y3", at);
      const measure = async (headType: string, name: string, sequence: number) => {
        const from = h.delivered.length;
        const before = serializations;
        await submit(h, envelope("y3", headType, `${name}-${sequence}`, fixture(name), at, sequence));
        const [reply] = h.delivered.slice(from).flatMap(({ reply: item }) => item.kind === "inputDone" ? [item] : []);
        const views = reply.output.units.flatMap((delta) => delta.view == null ? [] : [delta.view]);
        const pending = reply.output.units.flatMap((delta) => delta.pendingIntents ?? []);
        return { units: reply.output.units.map((delta) => delta.unit), views: views.length,
          viewBytes: views.reduce((sum, view) => sum + serialize(view).byteLength, 0),
          pendingIntents: pending.length, pendingBytes: pending.length === 0 ? 0 : serialize(pending).byteLength,
          replyBytes: serialize(reply).byteLength, replies: h.delivered.length - from, serializations: serializations - before };
      };
      const rows = {
        VXSE43: await measure("VXSE43", "37_01_01_240613_VXSE43", 1),
        VPWS50: await measure("VPWS50", "15_18_01_250630_VPWS50", 2),
        VPWP50: await measure("VPWP50", "81_02_01_260605_VPWP50_high_severity", 3),
        duplicate: await measure("VXSE43", "37_01_01_240613_VXSE43", 4),
      };
      for (const row of [rows.VXSE43, rows.VPWS50, rows.VPWP50]) {
        expect(row.views).toBeLessThanOrEqual(row.units.length);
        expect(row.views).toBeLessThanOrEqual(1);
        // One publication serialization per reply at most (reservation adoptions are replies too).
        expect(row.serializations).toBeLessThanOrEqual(row.replies);
      }
      // The same report again changes no view: no unit delta carries one.
      expect(rows.duplicate.views).toBe(0);
      // A save changes U-E's persistence only: its delta comes without a view.
      const [saved] = await granted(h);
      expect(saved.output.units.map((delta) => [delta.unit, delta.view])).toEqual([["U-E", null]]);
      await h.root.diagnostics.flush();
    } finally { await server.close(); }
  });

  it("P3-C3A-T09 contractBoundary / AC05: the write right returns only with its checkpointDone, once per grantId", async () => {
    for (const failure of ["write", "reconcile"] as const) {
      const { fault, system } = faultyFiles();
      let now = 100;
      const clock = () => ({ wallTimeMs: 50_000 + now, monotonicMs: now });
      const driver = fixtureDriver();
      const h = harnessedRoot(config(), { "U-W": stringCodec("U-W"), "U-F": stringCodec("U-F") }, {
        clock, notificationAdapter: recordingNotificationAdapter(), runtimeCalls: driver.calls, checkpointFileSystem: system });
      await startHarness(h, "t09", clock());
      const pending = (dirtySince: number) => ({ kind: "pending" as const, currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince });
      await driver.update(h, fixtureState({ "U-W": "weather", "U-F": "series" }, { "U-W": pending(10), "U-F": pending(20) }, "t09"));
      if (failure === "reconcile") {
        // U-W reaches uncertain first; its reconciliation then cannot read and fails.
        fault.unit = "U-W"; fault.stage = "directorySync";
        expect((await granted(h)).map((reply) => [reply.unit, reply.result?.kind])).toEqual([["U-W", "uncertain"]]);
        fault.stage = "read";
      } else { fault.unit = "U-W"; fault.stage = "write"; }
      // While U-W's reply is held, the dirty U-F gets no grant.
      const release = h.hold((place, reply) => place === "weatherCurrent" && reply.kind === "checkpointDone");
      void h.root.driveCheckpoint();
      await h.settle();
      const held = h.held.map((item) => item.reply).find((reply) => reply.kind === "checkpointDone")!;
      expect(held).toMatchObject({ unit: "U-W", result: { kind: "failed" } });
      const granting = grantsOf(h).length;
      void h.root.driveCheckpoint();
      expect(grantsOf(h)).toHaveLength(granting);
      release();
      h.release();
      await h.settle();
      fault.stage = null;
      const due = h.root.checkpoint.retryAfter("U-W");
      expect(due).toBe(now + 1_000);
      // The ended failure returned the right: U-F is acknowledged within 3 s of becoming dirty.
      const [series] = await granted(h);
      expect(series).toMatchObject({ unit: "U-F", result: { kind: "acknowledged" } });
      expect(series.measurements.at(-1)!.endedMonotonicMs - 20).toBeLessThanOrEqual(3_000);
      // A second delivery of the same grantId changes neither the mirror, the retry nor the right.
      const mirror = h.root.state.mirror["U-W"];
      h.redeliver("weatherCurrent", held);
      expect(h.root.state.mirror["U-W"]).toBe(mirror);
      expect(h.root.checkpoint.retryAfter("U-W")).toBe(due);
      now = due! - 1;
      expect(await granted(h)).toEqual([]);
      now = due!;
      expect((await granted(h)).map((reply) => reply.unit)).toEqual(["U-W"]);
      await h.root.diagnostics.flush();
    }
  });

  // P3-C3B-AC06(a): the failure no longer throws; only the stopped owner gets no further request.
  it("P3-C3A-T10 contractBoundary / AC10: an owner failure stops that owner only and the publisher sends it no further request", async () => {
    let now: ClockReading = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: recordingNotificationAdapter() });
    await startHarness(h, "t10", now);
    expect(h.root.ownerFailed("weatherCurrent", new Error("worker error"))).toBeUndefined();
    const sent = h.sent.length;
    h.root.mailbox.enqueue(envelope("t10", "VXSE43", "after", fixture("37_01_01_240613_VXSE43"), now, 1));
    h.root.pump();
    now = { wallTimeMs: now.wallTimeMs + 1_000, monotonicMs: 1_001 };
    h.root.tick(now);
    await h.root.driveCheckpoint();
    await h.settle();
    const later = h.sent.slice(sent);
    expect(later.filter(({ place }) => place === "weatherCurrent")).toEqual([]);
    expect(later.filter(({ request }) => request.kind === "input" || request.kind === "deadline")
      .map(({ place, request }) => [place, request.kind])).toEqual([["urgent", "input"], ["urgent", "deadline"], ["deferred", "deadline"]]);
    await h.root.diagnostics.flush();
  });
});
