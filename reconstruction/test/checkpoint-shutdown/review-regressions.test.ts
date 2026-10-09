import { promises as disk } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type { DiagnosticEvent, JsonValue, RuntimeState, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import { CheckpointCoordinator, hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap } from "../../src/checkpoint/checkpoint";
import { PersistentDiagnosticSink } from "../../src/checkpoint/persistent-diagnostic-sink";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import type { ShutdownHooks } from "../../src/runtime/composition-root";
import * as ownerRuntime from "../../src/runtime/owner-runtime";
import * as sharedRuntime from "../../src/runtime/shared-runtime";
import { executionPlaces } from "../../src/runtime/unit-coverage";
import { harnessedRoot, park, startHarness } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { fixtureState, fixtureDriver, stringCodec, recordingNotificationAdapter } from "./runtime-fixture";

const codec = stringCodec("U-F");
const ids = { inputIds: ["adopted-input"], retryReason: "notRetry" as const };

function dirty(generation = 1, weather = false): RuntimeState {
  const status = { kind: "pending" as const, currentGeneration: generation, savedGeneration: null,
    savedCapturedAt: null, savedAckAt: null, dirtySince: 0 };
  return fixtureState({ "U-F": `final-${generation}`, ...(weather ? { "U-W": "weather" } : {}) },
    { "U-F": status, ...(weather ? { "U-W": { ...status, dirtySince: 1 } } : {}) });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type Done = Extract<OwnerReply, { kind: "checkpointDone" }>;

// TEST-PATH (2): the publisher with its in-process owners on fault-injecting checkpoint and diagnostic file systems.
// The fixture driver's stub reducers set unit states; checkpoints run by write-right grants (driveCheckpoint).
async function harness(hooks: ShutdownHooks = {}) {
  let now = 0;
  let wallOffset = 0;
  const clock = () => ({ wallTimeMs: 1_800_000_000_000 + now + wallOffset, monotonicMs: now });
  const bytes = new Map<string, Uint8Array>();
  const lines = new Map<string, string>();
  const events: DiagnosticEvent[] = [];
  const measurements: CheckpointMeasurement[] = [];
  const order: string[] = [];
  const fault = { read: false, directorySync: false, verify: false, renamed: false,
    checkpointFailure: null as "encode" | "open" | "write" | "fileSync" | "close" | "rename" | null,
    unlink: false, logRead: false, syncGate: null as Promise<void> | null,
    checkpointUnlink: false, unlinks: 0, closeGate: null as Promise<void> | null, onClose: () => {},
    renameGate: null as Promise<void> | null, onRename: () => {}, onDirectorySync: () => {},
    writeGate: null as Promise<void> | null, summaryGate: null as Promise<void> | null, summaryRenameGate: null as Promise<void> | null,
    appendError: null as Error | null, opens: 0, syncs: 0,
    rewriteFailure: null as "write" | "rename" | null, onOpen: () => {}, onSummary: () => {} };
  const fs: CheckpointFileSystem = {
    unlinkSync(path) {
      fault.unlinks += 1;
      if (fault.checkpointUnlink) throw new Error("checkpoint unlink failed");
      bytes.delete(path);
    },
    readFile(path) {
      if (fault.read) throw new Error("EIO");
      if (fault.verify && fault.renamed && path.endsWith(".json")) return new TextEncoder().encode("invalid");
      return bytes.get(path) ?? null;
    },
    async mkdir() {},
    async open(path) {
      fault.opens += 1;
      fault.onOpen();
      if (fault.checkpointFailure === "open") throw new Error("open failed");
      bytes.set(path, new Uint8Array());
      let closes = 0;
      return {
        async write(data) {
          await park(fault.writeGate);
          if (fault.checkpointFailure === "write") { bytes.set(path, data.slice(0, 10)); throw new Error("partial write"); }
          bytes.set(path, data.slice());
        },
        async sync() { if (fault.checkpointFailure === "fileSync") throw new Error("file sync failed"); },
        async close() {
          if (++closes === 1 && fault.checkpointFailure === "close") throw new Error("close failed");
          fault.onClose(); await park(fault.closeGate);
          if (fault.checkpointFailure === "close") throw new Error("close failed");
        },
      };
    },
    async rename(from, to) {
      fault.onRename(); await park(fault.renameGate);
      if (fault.checkpointFailure === "rename") throw new Error("rename failed");
      bytes.set(to, bytes.get(from)!); bytes.delete(from); fault.renamed = true;
    },
    async syncDirectory() {
      fault.syncs += 1; fault.onDirectorySync(); await park(fault.syncGate);
      if (fault.directorySync) throw new Error("directory sync failed");
    },
  };
  const logs: DiagnosticFileSystem = {
    async mkdir() {},
    async readLastByte(path) { return Buffer.from(lines.get(path) ?? "").at(-1) ?? null; },
    async appendFile(path, data) {
      if (fault.appendError != null) throw fault.appendError;
      lines.set(path, (lines.get(path) ?? "") + data);
    },
    async writeFile(path, data) {
      if (path.endsWith("shutdown-summary.json.tmp")) { order.push("summary"); fault.onSummary(); await fault.summaryGate; }
      if (fault.rewriteFailure === "write") { lines.set(path, ""); throw new Error("ENOSPC after truncate"); }
      lines.set(path, data);
    },
    async rename(from, to) {
      if (to.endsWith("shutdown-summary.json")) await fault.summaryRenameGate;
      if (fault.rewriteFailure === "rename") throw new Error("rename failed");
      lines.set(to, lines.get(from)!);
      lines.delete(from);
    },
    async readFile(path) { if (fault.logRead) throw new Error("log read failed"); return lines.get(path) ?? ""; },
    async files() { return [...lines].map(([path, content]) => ({ name: basename(path), size: Buffer.byteLength(content), mtimeMs: clock().wallTimeMs })); },
    async unlink(path) { if (fault.unlink) throw new Error("unlink failed"); lines.delete(path); },
  };
  const directory = join(tmpdir(), "fleq-a3-review-virtual");
  const config = { appName: "p2", legacyAppName: "v2", stateDirectory: join(directory, "state"),
    legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "diagnostics") };
  const codecs: CodecMap = { "U-E": stringCodec("U-E"), "U-F": { ...codec, encode(state) {
    if (fault.checkpointFailure === "encode") throw new Error("encode failed");
    return codec.encode(state);
  } }, "U-W": stringCodec("U-W"), "U-T": stringCodec("U-T"), "U-Q": stringCodec("U-Q"),
    "U-N": stringCodec("U-N"), "U-V": stringCodec("U-V"), "U-L": stringCodec("U-L") };
  // Another runtime over the same files (a restart), started by the caller.
  const runtime = (driver = fixtureDriver(), units: CodecMap = codecs, closeHooks: ShutdownHooks = {}) => {
    const h = harnessedRoot(config, units, { notificationAdapter: recordingNotificationAdapter(),
      clock, checkpointFileSystem: fs, diagnosticFileSystem: logs, runtimeCalls: driver.calls,
      shutdownHooks: { closeWorker: async () => { order.push("close"); }, ...closeHooks },
      onMeasurements: (batch) => measurements.push(...batch), reportFailure: (event) => events.push(event) });
    return { h, driver };
  };
  const { h, driver } = runtime(undefined, codecs, hooks);
  await startHarness(h, "review", clock());
  // An input saves at once (P3-UWR-AC03): grant() after update() returns the saves the update started.
  const update = (state: RuntimeState, inputIds: Readonly<Partial<Record<RuntimeUnitId, readonly string[]>>> = {}) => {
    h.newDone();
    return driver.update(h, state, clock(), inputIds);
  };
  return { h, root: h.root, driver, runtime, update, clock, codecs,
    setTime: (value: number) => { now = value; }, setWallOffset: (value: number) => { wallOffset = value; },
    bytes, lines, fs, logs, fault, events, measurements, order, config,
    // The owner-side coordinator of a unit: restoreUnit there is what the single-thread root.restoreUnit was.
    restore: (unit: RuntimeUnitId, target: Harness = h) =>
      target.owners.get(executionPlaces[unit])!["checkpoint"].restoreUnit(unit),
    attempt: (target: Harness = h) => target.owners.get("deferred")!["state"]!.checkpointAttempts["U-F"],
    grant: (target: Harness = h) => granted(target),
    // Keeps the reconciliation an uncertain save starts at once (P3-UWR-AC03) from the owner until the returned function
    // is called (the test's next step drives it). Without it the reconciliation runs before the test sets its faults.
    holdReconcile: (target: Harness = h) => {
      const holding = target.holdRequests((_place, request) => request.kind === "checkpointGrant" && request.mode === "reconcile");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holding();
        target.releaseRequests();
      };
    },
    // Drives the due grants and waits for them and for the saves already running (an input's immediate save, P3-UWR-AC03),
    // whose write the test may hold open; await the returned promise after releasing it.
    start: async (target: Harness = h) => {
      const running = target.root.checkpoint.grants;
      const released = target.root.driveCheckpoint();
      await target.settle();
      await released;
      while (running.some((grant) => target.root.checkpoint.grantOf(grant.unit)?.grantId === grant.grantId)) await target.settle();
      target.newDone();
    } };
}

// The write rights due now and the owner's checkpointDone replies since the previous look, the immediate saves after
// inputs included (P3-UWR-AC03, AC10(7)).
async function granted(h: Harness): Promise<Done[]> {
  const released = h.root.driveCheckpoint();
  await h.settle();
  await released;
  return h.newDone();
}
const grants = (h: Harness) => h.sent.flatMap(({ request }) => request.kind === "checkpointGrant" ? [request] : []);

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("R25 regression / AC02,AC05: a forged result reply cannot bypass durability validation", async () => {
  const h = await harness();
  const gate = deferred();
  h.fault.writeGate = gate.promise;
  // U-F's input saves at once (P3-UWR-AC03) and its write waits; U-W becomes dirty after it (AC10(7)).
  await h.update(dirty(1));
  const running = h.start();
  await vi.waitFor(() => expect(h.fault.opens).toBe(1));
  const clock = h.clock();
  const attempt = h.attempt()!;
  const fabricated = { kind: "acknowledged", unit: "U-F", generation: 1, attemptId: attempt.attemptId,
    encodedByteLength: 1, ackAt: clock.wallTimeMs } as const;
  // Only the reply to the current grant is adopted; a forged one changes neither the mirror nor the write right.
  h.root.receive("deferred", { kind: "checkpointDone", grantId: "forged", unit: "U-F", result: fabricated, measurements: [],
    grantStartedMs: null, writeCounts: null, output: { units: [{ unit: "U-F", persistence: { kind: "saved", currentGeneration: 1, savedGeneration: 1,
      savedCapturedAt: attempt.capturedAt, savedAckAt: clock.wallTimeMs, dirtySince: null },
    admissionCounts: { normal: 0, training: 0, test: 0 }, view: null, pendingIntents: null }],
    outcomes: [], displayChanges: [], confirmationEvidence: [], retiredEvents: [], diagnostics: [] } });
  expect(h.root.state.mirror["U-F"].persistence.savedGeneration).toBeNull();
  const before = grants(h.h).length;
  await h.root.driveCheckpoint();
  expect(grants(h.h)).toHaveLength(before);
  gate.resolve();
  await running;
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  expect(h.h.owners.get("deferred")!["state"]!.checkpointAttempts).toEqual({});
  await h.update(dirty(1, true));
  expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
  await h.root.diagnostics.flush();
});

it("R26 regression / AC04: the write right is released only with the owner's applied result", async () => {
  const h = await harness();
  // U-F's input saves at once (P3-UWR-AC03); its reply waits. U-W becomes dirty after it (AC10(7)).
  const release = h.h.hold((_place, reply) => reply.kind === "checkpointDone");
  await h.update(dirty(1));
  void h.root.driveCheckpoint();
  await h.h.settle();
  // AC06: the owner applied its own result; the publisher keeps the right until that reply arrives.
  expect(h.h.unit("U-F").persistence.kind).toBe("saved");
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("pending");
  const before = grants(h.h).length;
  void h.root.driveCheckpoint();
  expect(grants(h.h)).toHaveLength(before);
  release();
  h.h.release();
  await h.h.settle();
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  await h.update(dirty(1, true));
  expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
  expect(h.fault.opens).toBe(2);
  const attempt = h.measurements[0].attemptId;
  expect(h.measurements.filter((measurement) => measurement.attemptId === attempt)).toHaveLength(6);
  await h.root.diagnostics.flush();
});

it("R27 regression / AC04,AC05: a failed capture keeps the write right until its reply, then backs off", async () => {
  for (const [stage, delivery] of [
    ["encode", "once"], ["open", "once"], ["write", "once"],
    ["fileSync", "once"], ["rename", "once"], ["write", "redelivered"],
  ] as const) {
      const h = await harness();
      h.fault.checkpointFailure = stage;
      // Every U-F reply waits, in port order, from the reply of the input's immediate grant (P3-UWR-AC03) on. U-W becomes
      // dirty after the fault is cleared (AC10(7)).
      let holding = false;
      const release = h.h.hold((place, reply) => place === "deferred" && (holding ||= reply.kind === "checkpointDone"));
      await h.update(dirty(1), { "U-F": ids.inputIds });
      void h.root.driveCheckpoint();
      await h.h.settle();
      const [held] = h.h.held.map((item) => item.reply).filter((reply): reply is Done => reply.kind === "checkpointDone");
      const result = held.result!;
      expect(result).toMatchObject({ kind: stage === "rename" ? "uncertain" : "failed",
        unit: "U-F", generation: 1, stage: stage === "open" ? "write" : stage });
      h.fault.checkpointFailure = null; // A second capture would now be able to write g2.
      h.setTime(25);
      // The owner has already applied its result (AC06); the next generation keeps that status. g2 comes with a deadline
      // request while the reply is still in transit: a U-F input would wait for that reply (P3-UWR-AC04; AC10(7)).
      await h.driver.update(h.h, fixtureState({ "U-F": "final-2" }, {
        "U-F": { ...h.h.unit("U-F").persistence, currentGeneration: 2, dirtySince: 25 } }), h.clock(), {}, true);
      expect([h.h.unit("U-F").persistence.currentGeneration, h.root.state.mirror["U-F"].persistence.currentGeneration]).toEqual([2, 1]);
      // While the reply is in transit no unit gets the right, and nothing is measured or backed off yet.
      const before = grants(h.h).length;
      void h.root.driveCheckpoint();
      expect(grants(h.h), `${stage}/${delivery}`).toHaveLength(before);
      expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
      expect(h.measurements).toEqual([]);
      expect(h.fault.opens).toBe(stage === "encode" ? 0 : 1);
      release();
      h.h.release();
      h.h.newDone(); // the released reply; the reconciliation it starts at once (rename) is the next grant()'s
      await h.h.settle();
      const measured = [...h.measurements];
      expect(measured.every((entry) => entry.attemptId === result.attemptId
        && entry.unit === "U-F" && entry.generation === 1 && entry.runId === "review"
        && entry.inputIds.join() === ids.inputIds.join() && entry.retryReason === "notRetry")).toBe(true);
      expect(h.root.state.mirror["U-F"].persistence.currentGeneration).toBe(2);
      if (stage === "rename") {
        // A failed rename has no confirmed slot; reconciliation supplies the terminal failure.
        expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["failed"]);
      }
      expect(h.attempt()).toBeUndefined();
      expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "failed", currentGeneration: 2 });
      const due = h.root.checkpoint.retryAfter("U-F")!;
      const retryReason = h.root.checkpoint.retryReason("U-F");
      expect(due).toBe(1_025);
      expect(retryReason).toBe(stage === "rename" ? "ackUncertain" : "saveFailed");
      const originalStages = stage === "encode" ? ["encode"] : stage === "fileSync"
        ? ["encode", "write", "fileSync"] : stage === "rename"
          ? ["encode", "write", "fileSync", "close", "rename", "verify"] : ["encode", "write"];
      expect(h.measurements.filter((entry) => entry.attemptId === result.attemptId).map((entry) => entry.stage))
        .toEqual(originalStages);
      if (delivery === "redelivered") {
        h.h.redeliver("deferred", held);
        expect(h.root.checkpoint.retryAfter("U-F")).toBe(due);
        expect(h.measurements).toEqual(measured);
      }
      await h.update(dirty(1, true));
      expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
      expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");
      h.setTime(due - 1);
      expect(await h.grant()).toEqual([]);
      h.setTime(due);
      const [retry] = await h.grant();
      expect(retry).toMatchObject({ unit: "U-F", result: { kind: "acknowledged", generation: 2 } });
      expect(retry.result!.attemptId).not.toBe(result.attemptId);
      expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "saved", currentGeneration: 2, savedGeneration: 2 });
      expect(h.h.owners.get("deferred")!["state"]!.checkpointAttempts).toEqual({});
      expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
      expect(h.measurements.filter((entry) => entry.stage === "encode")).toHaveLength(3);
      expect(h.measurements.filter((entry) => entry.attemptId === retry.result!.attemptId)).toHaveLength(6);
      await h.root.diagnostics.flush();
  }
});

it("R28 regression / AC04,AC06: shutdown recovers earlier failures without an explicit result replay", async () => {
  for (const [stage, remaining] of [
    ["encode", true], ["open", true], ["write", true], ["fileSync", true], ["rename", true],
    ["write", false],
  ] as const) {
        const h = await harness({ finalizeBatchesAndSideEffects: async () => {
          if (!remaining) h.setTime(50_000);
          return { batches: 0, notificationAttempts: 0 };
        } });
        // P3-UWR-AC01/AC03 (AC10(9)): U-F's input saves at once under the fault, and a rename failure's reconciliation
        // runs at once too (it finds no slot and fails). U-W, dirty after the fault, saves with its own right.
        h.fault.checkpointFailure = stage;
        await h.update(dirty(1), { "U-F": ids.inputIds });
        const [first] = await h.grant();
        const result = first.result!;
        expect(result.kind).toBe(stage === "rename" ? "uncertain" : "failed");
        h.fault.checkpointFailure = null;
        await h.update(dirty(1, true), { "U-F": ids.inputIds, "U-W": ids.inputIds });
        expect(h.root.state.mirror["U-W"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
        expect(h.root.state.mirror["U-F"].persistence.kind).toBe("failed");
        const measured = [...h.measurements];
        const attempt = h.measurements.filter((entry) => entry.attemptId === result.attemptId);
        const opens = h.fault.opens;
        h.setTime(20_000);
        const summary = await h.root.shutdownRuntime(1, h.clock());
        expect(summary.code, `${stage}/remaining=${remaining}`).toBe(remaining ? 0 : 3);
        expect(h.measurements.filter((entry) => entry.attemptId === result.attemptId)).toEqual(attempt);
        if (remaining) {
          expect(h.root.state.mirror["U-W"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
          expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
          expect(h.fault.opens).toBe(opens + 1);
          expect(h.measurements.length).toBe(measured.length + (stage === "encode" ? 6 : 5));
          expect(h.root.state.shutdown.stageResults.finalCheckpoint?.pending.unsavedUnits).toBe(0);
          expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
          expect(h.order).toEqual(["summary", "close", "summary"]);
          expect(h.h.owners.get("deferred")!["state"]!.checkpointAttempts).toEqual({});
          expect(h.restore("U-F")).toMatchObject({ kind: "restored", envelope: { generation: 1 } });
          expect(h.restore("U-W")).toMatchObject({ kind: "restored", envelope: { generation: 1 } });
        } else {
          expect(h.fault.opens).toBe(opens);
          expect(h.measurements).toEqual(measured);
          expect(h.root.state.mirror["U-W"].persistence.savedGeneration).toBe(1);
          expect(h.root.state.shutdown.stageResults.finalCheckpoint).toMatchObject({
            // D4 (FINALIZE-TIMEOUT=A): no cutoff was decided, so every unit, the clean U-E too, counts unsaved.
            result: { kind: "deadlineExceeded" }, pending: { unsavedUnits: 8 },
          });
          expect(h.order).toEqual([]);
        }
        await h.root.diagnostics.flush();
  }
});

it("B01 contractBoundary / AC02,AC05: capture precedes post-capture dirty input and the owner applies the correlated ack", async () => {
  for (const outcome of ["acknowledged", "failed", "uncertain"] as const) {
    const h = await harness();
    const gate = deferred();
    h.fault.writeGate = gate.promise;
    // U-F's input saves at once (P3-UWR-AC03) and its write waits; U-W becomes dirty at the end (AC10(7)).
    await h.update(dirty(1));
    const running = h.start();
    await vi.waitFor(() => expect(h.fault.opens).toBe(1));
    const capture = h.attempt()!;
    expect(capture).toMatchObject({ unit: "U-F", generation: 1, postCaptureDirtySince: null });
    h.setTime(500);
    // The g2 input waits for U-F's own save (P3-UWR-AC04) until the 1,000 ms hold limit, then reaches the owner mid-write.
    h.driver.queue(h.h, fixtureState({ "U-F": "final-2" }, {
      "U-F": { ...h.h.unit("U-F").persistence, kind: "pending", currentGeneration: 2, dirtySince: h.clock().monotonicMs } }), h.clock());
    h.root.pump();
    await h.h.settle();
    h.setTime(1_500);
    h.root.tick(h.clock());
    await h.h.settle();
    expect(h.attempt()?.postCaptureDirtySince).toBe(h.clock().monotonicMs);
    if (outcome === "failed") h.fault.checkpointFailure = "write";
    if (outcome === "uncertain") h.fault.directorySync = true;
    // The next U-F grant the reply starts at once (the g2 save, or the reconciliation) waits until the test drives it.
    let holding = h.h.holdRequests((place, request) => place === "deferred" && request.kind === "checkpointGrant");
    gate.resolve();
    await running;
    expect(h.h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" ? [reply.result?.kind] : [])).toEqual([outcome]);
    expect(h.h.unit("U-F").persistence.currentGeneration).toBe(2);
    if (outcome === "uncertain") {
      h.fault.directorySync = false;
      holding();
      holding = h.h.holdRequests((place, request) => place === "deferred" && request.kind === "checkpointGrant" && request.mode === "save");
      h.h.releaseRequests("deferred");
      await h.grant();
    }
    if (outcome !== "failed") expect(h.h.unit("U-F").persistence).toMatchObject({
      kind: "pending", currentGeneration: 2, savedGeneration: 1, dirtySince: h.clock().monotonicMs,
      savedCapturedAt: capture.capturedAt, savedAckAt: h.clock().wallTimeMs,
    });
    expect(h.attempt()).toBeUndefined();
    h.fault.checkpointFailure = null;
    await h.update(dirty(1, true));
    expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
    expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");
    expect(h.h.unit("U-F").persistence.currentGeneration).toBe(2);
    expect(h.h.owners.get("deferred")!["state"]!.checkpointAttempts).toEqual({});
    await h.root.diagnostics.flush();
  }
});

it("B02 contractBoundary / AC06: A1 retains all earlier stage failures when later stages run", async () => {
  const h = await harness({
    drainMailbox: async (_deadline, active) => { await h.root.drainInputs(active); throw new Error("private drain detail"); },
    finalizeBatchesAndSideEffects: async () => { throw new Error("private finalize detail"); },
    closeWorker: async () => { throw new Error("private close detail"); },
  });
  h.fault.checkpointFailure = "write";
  h.driver.queue(h.h, dirty(), h.clock(), { "U-F": ids.inputIds });
  const summary = await h.root.shutdownRuntime(1, h.clock());
  expect(summary.code).toBe(3);
  expect(summary.reasons).toEqual([
    "mailboxDrain:failed:operationFailed",
    "sideEffectFinalization:failed:operationFailed", "sideEffectFinalization:remainingBatches",
    "finalCheckpoint:remainingBatches",
    "finalCheckpoint:unsavedUnits", "workerClose:failed:operationFailed",
    "workerClose:remainingBatches", "workerClose:remainingWorkers",
  ]);
  expect(JSON.parse(h.lines.get(join(h.config.diagnosticDirectory, "shutdown-summary.json"))!))
    .toMatchObject({ code: summary.code, reasons: summary.reasons });
  expect(h.fault.opens).toBe(1);
  expect(h.root.state.shutdown.stageResults.finalCheckpoint?.result.kind).toBe("completed");
  expect(h.root.state.shutdown.stageResults.finalCheckpoint?.pending.unsavedUnits).toBe(1);
});

it("B03 contractBoundary / AC07: the 1-second tick completes silent mailbox diagnostics and overflow once", async () => {
  const h = await harness();
  const runId = h.root.state.runId;
  const drain = vi.spyOn(h.root.mailbox, "drainDiagnostics");
  for (let i = 0; i < 200; i += 1) h.root.mailbox.enqueue({
    messageId: String(i), runId, t0MonotonicMs: 0, enqueuedMonotonicMs: 0, priorityReason: "control",
    payload: { kind: "control", control: { kind: "shutdownRequested", acceptedThroughSequence: i, clock: h.clock() } },
  });
  for (let second = 0; second <= 6; second += 1) {
    h.setTime(second * 1_000);
    h.root.tick(h.clock());
    h.root.tick(h.clock());
    h.root.tick({ ...h.clock(), monotonicMs: second * 1_000 + 999 });
  }
  expect(drain).toHaveBeenCalledTimes(7);
  const records = (await h.root.readDiagnostics({ limit: 256 })).records;
  expect(records.filter((event) => event.reason === "diagnosticQueueOverflow")).toHaveLength(1);
  expect(records.filter((event) => event.reason === "mailboxStalled")).toEqual([
    expect.objectContaining({ component: "mailbox", timestamp: 1_800_000_005_000, runId, durationMs: 5_000 }),
    expect.objectContaining({ component: "mailbox.worker", timestamp: 1_800_000_005_000, runId, durationMs: 5_000 }),
  ]);
  expect(records.every((event) => event.runId === runId)).toBe(true);
});

it("B04 contractBoundary / AC06: a final-summary-only failure cannot return unconfirmed success", async () => {
  const h = await harness();
  let summaries = 0;
  h.fault.onSummary = () => { if (++summaries === 2) h.fault.rewriteFailure = "write"; };
  await expect(h.root.shutdownRuntime(1, h.clock()))
    .rejects.toThrow("final shutdown summary could not be persisted");
  expect(h.order).toEqual(["summary", "close", "summary"]);
  expect(h.root.state.shutdown.stage).toBe("completed");
  // The A1 terminal observation is not rewritten by A3 after a persistence error.
  expect(h.root.state.shutdown.stageResults.workerClose?.result.kind).toBe("completed");
  expect(h.events.filter((event) => event.reason === "diagnosticSinkFailed")).toHaveLength(1);
  expect([...h.lines.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
});

it.each(["write", "rename"] as const)("P3-C3B-T09 contractBoundary / AC09: a final summary save cut by the worker-close limit during its %s returns code 4 marked unsaved", async (cut) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // closeWorker は注入時計で期限の 1ms 前に completed で終わる。2 回目の保存は tmp の書込みか rename で止め、段の期限の timer で切る。
  const h = await harness({ closeWorker: async (deadline) => { h.order.push("close"); h.setTime(deadline - 1); } });
  const gate = deferred();
  const entered = deferred();
  const saved = () => [...h.lines].find(([path]) => path.endsWith("shutdown-summary.json"))?.[1];
  let summaries = 0;
  let first: string | undefined;
  h.fault.onSummary = () => {
    if (++summaries !== 2) return;
    first = saved();
    if (cut === "write") h.fault.summaryGate = gate.promise;
    else h.fault.summaryRenameGate = gate.promise;
    entered.resolve();
  };
  const stopping = h.root.shutdownRuntime(1, h.clock());
  await entered.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  const summary = await stopping;
  expect(summary.code).toBe(4);
  expect(summary.reasons).toEqual(["workerClose:summaryNotPersisted"]);
  expect(h.root.state.shutdown.stageResults.workerClose?.result.kind).toBe("completed");
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.order).toEqual(["summary", "close", "summary"]);
  expect(JSON.parse(first!)).toMatchObject({ code: 0, reasons: [] });
  // 書込み中に切れれば 1 回目が残る。rename 中に切れれば、返った後に終わった rename で 2 回目の完全な要約が残る。
  if (cut === "write") expect(saved()).toBe(first);
  else {
    expect(saved()).not.toBe(first);
    expect(JSON.parse(saved()!)).toMatchObject({ code: 0, reasons: [], completedAt: summary.completedAt });
  }
  expect([...h.lines.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
});

// The slot envelope a capture at `capturedAt` would make for the fixture's U-F value.
function fixtureEnvelope(generation: number, capturedAt: number, payload: JsonValue = `final-${generation}`) {
  return hashEnvelope({ schemaVersion: codec.schemaVersion, unit: "U-F", generation, capturedAt, payload });
}

it("R01 regression / AC02,AC08: uncertain needs exact hash and successful sync; post-rename verify failure stays uncertain", async () => {
  const h = await harness();
  h.fault.directorySync = true;
  const reconcile = h.holdReconcile();
  await h.update(dirty());
  expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["uncertain"]);
  reconcile();
  expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["uncertain"]);
  expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "uncertain", savedGeneration: null });
  h.fault.directorySync = false;
  const path = [...h.bytes.keys()][0];
  const { sha256: _hash, ...written } = JSON.parse(new TextDecoder().decode(h.bytes.get(path)!)) as ReturnType<typeof fixtureEnvelope>;
  h.bytes.set(path, serializedEnvelope(hashEnvelope({ ...written, payload: "different payload" })));
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  await h.grant();
  expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "failed", savedGeneration: null });

  // P3-C1: a steady save has no post-rename verify, so the uncertain-then-reconcile property is shown via directory sync.
  const verify = await harness();
  verify.fault.directorySync = true;
  const reconcileVerify = verify.holdReconcile();
  await verify.update(dirty());
  expect((await verify.grant()).map((reply) => reply.result?.kind)).toEqual(["uncertain"]);
  verify.fault.directorySync = false;
  reconcileVerify();
  await verify.grant();
  expect(verify.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });

  // The same-generation confirm read (spec:843) failing after directory sync is still uncertain (stage ack).
  const confirm = await harness();
  confirm.bytes.set(join(confirm.config.stateDirectory, "U-F-A.json"),
    serializedEnvelope(fixtureEnvelope(1, confirm.clock().wallTimeMs)));
  confirm.restore("U-F"); // the memory now names generation 1, so the save takes the recovery path
  confirm.fault.verify = true;
  confirm.fault.onDirectorySync = () => { confirm.fault.renamed = true; };
  confirm.holdReconcile();
  await confirm.update(dirty());
  expect((await confirm.grant()).map((reply) => reply.result)).toMatchObject([{ kind: "uncertain", stage: "ack" }]);
  expect(confirm.fault.opens).toBe(0);
  await Promise.all([h.root.diagnostics.flush(), verify.root.diagnostics.flush(), confirm.root.diagnostics.flush()]);
});

it("R02 regression / AC04: a running attempt cannot execute twice or relinquish its writer before it ends", async () => {
  // TEST-PATH (1): the owner-side coordinator refuses a second execution of the running attempt.
  const direct = await harness();
  const gate = deferred();
  direct.fault.writeGate = gate.promise;
  const coordinator = new CheckpointCoordinator(direct.config.stateDirectory, direct.codecs, direct.fs, direct.clock, () => {});
  const captured = coordinator.capture("U-F", dirty().units["U-F"], 1, "review", ids);
  const executing = coordinator.executeCheckpoint(captured.request!, "review", ids.inputIds, "notRetry");
  await expect(coordinator.executeCheckpoint(captured.request!, "review", ids.inputIds, "notRetry")).rejects.toThrow(/already executed/);
  gate.resolve();
  await executing;

  // The owner replies only when the write has ended, so the right stays held until then.
  const h = await harness();
  const held = deferred();
  h.fault.writeGate = held.promise;
  // U-F's input saves at once (P3-UWR-AC03) and its write waits; U-W becomes dirty after it (AC10(7)).
  await h.update(dirty(1));
  const running = h.start();
  await vi.waitFor(() => expect(h.fault.opens).toBe(1));
  const before = grants(h.h).length;
  void h.root.driveCheckpoint();
  expect(grants(h.h)).toHaveLength(before);
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("pending");
  held.resolve();
  await running;
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  expect(h.fault.opens).toBe(1);
  await h.update(dirty(1, true));
  expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
  await Promise.all([direct.root.diagnostics.flush(), h.root.diagnostics.flush()]);
});

it("R03 regression / AC08: a BOM cannot be stripped before the full-byte hash check", async () => {
  const h = await harness();
  await h.update(dirty());
  await h.grant();
  expect(h.restore("U-F").kind).toBe("restored");
  const path = [...h.bytes.keys()][0];
  const original = h.bytes.get(path)!;
  h.bytes.set(path, Uint8Array.from([0xef, 0xbb, 0xbf, ...original]));
  expect(h.restore("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
  await h.root.diagnostics.flush();
});

it("R04 regression / AC04,AC05: slot EIO returns measured failure and frees the writer for U-W", async () => {
  const h = await harness();
  h.fault.read = true;
  // P3-C1: a steady save reads nothing; EIO is met on the recovery path, which an unreadable restoreUnit opens.
  expect(h.restore("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
  // U-F's input saves at once (P3-UWR-AC03) on that path; U-W becomes dirty after the fault (AC10(7)).
  await h.update(dirty(1));
  const [failed] = await h.grant();
  expect(failed).toMatchObject({ unit: "U-F", result: { kind: "failed", stage: "write" } });
  expect(failed.measurements.filter((measurement) => measurement.stage !== "encode"))
    .toMatchObject([{ stage: "write", outcome: "failed", attemptId: failed.result!.attemptId }]);
  expect(h.root.checkpoint.retryAfter("U-F")).toBe(1_000);
  h.fault.read = false;
  await h.update(dirty(1, true));
  expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
  expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");
  await h.root.diagnostics.flush();
});

it("R05 regression / AC04,AC07: argument clocks monitor an occupied writer without unlocking it", async () => {
  const h = await harness();
  const gate = deferred();
  h.fault.writeGate = gate.promise;
  await h.update(dirty(1));
  const running = h.start();
  await vi.waitFor(() => expect(h.fault.opens).toBe(1));
  const grantId = h.root.checkpoint.grantOf("U-F")!.grantId;
  // P3-UWR-AC01 (AC10(9)): while U-F's write is held, U-W saves with its own right.
  h.fault.writeGate = null;
  await h.update(dirty(1, true));
  expect(h.root.state.mirror["U-W"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
  h.setTime(20_001);
  const before = grants(h.h).length;
  await h.root.driveCheckpoint();
  await h.root.driveCheckpoint();
  expect(grants(h.h)).toHaveLength(before);
  const read = await h.root.readDiagnostics({ limit: 256 });
  expect(read.records.filter((event) => event.reason === "checkpointOverdue").map((event) => event.unit)).toEqual(["U-F"]);
  // The publisher knows the held right by its grant id, not by the owner's attempt id.
  expect(read.records.filter((event) => event.reason === "checkpointUncertain"))
    .toEqual([expect.objectContaining({ attemptId: grantId, durationMs: 20_001 })]);
  expect(h.fault.opens).toBe(2);
  gate.resolve();
  await running;
});

it("R06 regression / AC06: drain and finalize states become the actual final checkpoint, not the starting copy", async () => {
  const h = await harness({
    drainMailbox: async (_deadline, active) => { await h.root.drainInputs(active); },
    finalizeBatchesAndSideEffects: async () => {
      expect(h.root.state.mirror["U-F"].persistence.currentGeneration).toBe(1);
      await h.update(dirty(2));
      return { batches: 0, notificationAttempts: 0 };
    },
  });
  h.driver.queue(h.h, dirty(1), h.clock(), { "U-F": ids.inputIds });
  const summary = await h.root.shutdownRuntime(2, h.clock());
  expect(summary).toMatchObject({ code: 0, persistence: { "U-F": { kind: "saved", currentGeneration: 2, savedGeneration: 2 } } });
  expect(h.restore("U-F")).toMatchObject({ envelope: { generation: 2, payload: "final-2" } });
  expect(h.order).toEqual(["summary", "close", "summary"]);
  // The only save is the final generation 2 (no save of the starting copy).
  expect(h.fault.opens).toBe(1);
  expect(new Set(h.measurements.map((measurement) => measurement.generation))).toEqual(new Set([2]));
  const missing = await harness({ drainMailbox: async (_deadline, active) => { await missing.root.drainInputs(active); } });
  missing.driver.queue(missing.h, dirty(), missing.clock());
  expect(await missing.root.shutdownRuntime(2, missing.clock()))
    .toMatchObject({ code: 0, persistence: { "U-F": { savedGeneration: 1 } } });
});

it("R07 regression / AC06: deadlines bound summary and forbid another unit write after a late ack", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const gate = deferred();
  const entered = deferred();
  const h = await harness({ drainMailbox: async (_deadline, active) => { await h.root.drainInputs(active); } });
  h.driver.queue(h.h, dirty(1, true), h.clock(), { "U-F": ids.inputIds, "U-W": ids.inputIds });
  h.fault.writeGate = gate.promise;
  h.fault.onOpen = entered.resolve;
  const shutdown = h.root.shutdownRuntime(1, h.clock());
  await entered.promise;
  h.setTime(10_000);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await shutdown).toMatchObject({ code: 2, reasons: expect.arrayContaining(["finalCheckpoint:deadlineExceeded"]) });
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await h.h.settle();
  expect(h.fault.opens).toBe(1);

  const summaryGate = deferred();
  const summaryEntered = deferred();
  const s = await harness();
  s.fault.summaryGate = summaryGate.promise;
  s.fault.onSummary = summaryEntered.resolve;
  const blocked = s.root.shutdownRuntime(1, s.clock());
  await summaryEntered.promise;
  s.setTime(5_000);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await blocked).toMatchObject({ code: 4, reasons: ["workerClose:deadlineExceeded", "workerClose:remainingWorkers"] });
  summaryGate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.order).toEqual(["summary"]);
  expect(s.lines.has(join(s.config.diagnosticDirectory, "shutdown-summary.json"))).toBe(false);
  expect([...s.lines.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
});

it("R08 regression / AC05: final-save encode and executed stages reach the same measurement consumer exactly once", async () => {
  // The drain hands over an input accepted before the stop; its owner reaches generation 4.
  const h = await harness({ drainMailbox: async (_deadline, active) => { await h.root.drainInputs(active); } });
  h.driver.queue(h.h, dirty(4), h.clock(), { "U-F": ids.inputIds });
  expect((await h.root.shutdownRuntime(1, h.clock())).code).toBe(0);
  expect(h.measurements.map((m) => m.stage)).toEqual(["encode", "write", "fileSync", "close", "rename", "directorySync"]);
  expect(new Set(h.measurements.map((m) => m.attemptId)).size).toBe(1);
  expect(h.measurements.every((m) => m.runId === "review" && m.unit === "U-F" && m.generation === 4
    && m.inputIds.join() === ids.inputIds.join() && m.retryReason === "notRetry")).toBe(true);
  expect(h.measurements[0].bytes).toBeGreaterThan(0);
});

it("R09 regression / AC02,AC06: reconciliation uses the shared retry reason and shutdown retries after lost data", async () => {
  const h = await harness();
  h.fault.directorySync = true;
  const reconcile = h.holdReconcile();
  await h.update(dirty());
  const [first] = await h.grant();
  h.bytes.clear();
  h.fault.directorySync = false;
  reconcile();
  await h.grant();
  expect(h.root.checkpoint.retryReason("U-F")).toBe("ackUncertain");
  const summary = await h.root.shutdownRuntime(1, h.clock());
  expect(summary).toMatchObject({ code: 0, persistence: { "U-F": { kind: "saved" } } });
  expect(h.measurements.filter((m) => m.attemptId !== first.result!.attemptId).every((m) => m.retryReason === "ackUncertain")).toBe(true);
});

it("R10 regression / AC07: sink exceptions expose only completed fixed diagnostics, never secrets or recursive writes", async () => {
  const h = await harness();
  let appends = 0;
  const adapter: DiagnosticFileSystem = { ...h.logs, async appendFile() {
    appends += 1;
    throw new Error("Authorization: Bearer SECRET\nforged log line");
  } };
  const events: DiagnosticEvent[] = [];
  const sink = new PersistentDiagnosticSink(h.config.diagnosticDirectory, adapter, () => h.clock().wallTimeMs,
    (event) => { events.push(event); sink.enqueueDiagnostic(event); });
  sink.enqueueDiagnostic({ timestamp: h.clock().wallTimeMs, level: "ERROR", component: "checkpoint",
    reason: "checkpointWriteFailed", runId: "review" });
  await sink.flush();
  await sink.flush();
  expect(appends).toBe(1);
  expect(events).toEqual([{ timestamp: h.clock().wallTimeMs, level: "ERROR", component: "diagnosticSink",
    reason: "diagnosticSinkFailed", runId: "diagnosticSink", count: 1 }]);
  expect(JSON.stringify(events)).not.toMatch(/Authorization|Bearer|SECRET|forged|\\n/);
});

it("R11 regression / AC07: restart/read prune daily files, queue faults aggregate per flush, and overflow is nonrecursive", async () => {
  const h = await harness();
  const event: DiagnosticEvent = { timestamp: h.clock().wallTimeMs, level: "ERROR", component: "checkpoint",
    reason: "checkpointWriteFailed", runId: "repeat" };
  const old = { ...event, timestamp: event.timestamp - 8 * 24 * 60 * 60 * 1000 };
  const date = new Date(old.timestamp).toISOString().slice(0, 10);
  h.lines.set(join(h.config.diagnosticDirectory, `diagnostics-${date}.jsonl`), `${JSON.stringify(old)}\n`);
  const restarted = new PersistentDiagnosticSink(h.config.diagnosticDirectory, h.logs, () => h.clock().wallTimeMs, () => {});
  expect((await restarted.readDiagnostics({ limit: 256 })).records).toEqual([]);
  expect(h.lines.size).toBe(0); // mtime is deliberately fresh in the adapter.
  for (let batch = 0; batch < 2; batch += 1) {
    for (let index = 0; index < 10; index += 1) restarted.enqueueDiagnostic(event);
    await restarted.flush();
  }
  expect((await restarted.readDiagnostics({ limit: 256 })).records)
    .toEqual([event, { ...event, count: 9 }, event, { ...event, count: 9 }]);
  h.setTime(8 * 24 * 60 * 60 * 1000);
  expect((await restarted.readDiagnostics({ limit: 256 })).records).toEqual([]);

  const gate = deferred();
  const overflow: DiagnosticEvent[] = [];
  const bounded = new PersistentDiagnosticSink(h.config.diagnosticDirectory,
    { ...h.logs, async appendFile() { await gate.promise; } }, () => h.clock().wallTimeMs,
    (completed) => { overflow.push(completed); bounded.enqueueDiagnostic(completed); });
  for (let index = 0; index <= 256; index += 1)
    bounded.enqueueDiagnostic({ ...event, timestamp: h.clock().wallTimeMs, inputId: String(index) });
  const flushed = bounded.flush();
  gate.resolve();
  await flushed;
  expect(overflow).toEqual([expect.objectContaining({ reason: "diagnosticQueueOverflow", count: 1, runId: "diagnosticSink" })]);
  expect(bounded.droppedCounts().ERROR).toBe(1);
});

it("R16 contractBoundary / AC07: queue repetitions stay daily, flushes append, and retention removes whole files", async () => {
  const h = await harness();
  const day = 24 * 60 * 60 * 1_000;
  const first = Date.parse("2026-09-01T00:00:00Z");
  let now = first + 2 * day + 1_000;
  const sink = new PersistentDiagnosticSink(h.config.diagnosticDirectory, h.logs, () => now, () => {});
  const event: DiagnosticEvent = { timestamp: first, level: "ERROR", component: "checkpoint",
    reason: "checkpointWriteFailed", runId: "daily" };
  // One queue spans three record dates; a later flush appends independent records.
  for (let offset = 0; offset < 3; offset += 1)
    for (let repeat = 0; repeat < 3; repeat += 1) sink.enqueueDiagnostic({ ...event, timestamp: first + offset * day + repeat });
  await sink.flush();
  for (let offset = 0; offset < 3; offset += 1) sink.enqueueDiagnostic({ ...event, timestamp: first + offset * day + 100 });
  await sink.flush();
  expect([...h.lines.keys()].map((path) => basename(path)).sort()).toEqual([
    "diagnostics-2026-09-01.jsonl", "diagnostics-2026-09-02.jsonl", "diagnostics-2026-09-03.jsonl",
  ]);
  const records = (await sink.readDiagnostics({ limit: 256 })).records;
  expect(records.map((record) => [record.timestamp, record.count ?? null])).toEqual([
    [first, null], [first + 1, 2], [first + 100, null],
    [first + day, null], [first + day + 1, 2], [first + day + 100, null],
    [first + 2 * day, null], [first + 2 * day + 1, 2], [first + 2 * day + 100, null],
  ]);
  now = first + 7 * day;
  expect((await sink.readDiagnostics({ limit: 256 })).records).toEqual(records);
  now = first + 8 * day + 2;
  expect((await sink.readDiagnostics({ limit: 256 })).records).toEqual(records.slice(6));
  expect([...h.lines.keys()].map((path) => basename(path))).toEqual(["diagnostics-2026-09-03.jsonl"]);
});

it("R18 regression / AC07: shutdown-summary tmp is still reclaimed on restart and counted while unlink fails", async () => {
  {
    const h = await harness();
    await h.root.diagnostics.flush();
    const temporary = join(h.config.diagnosticDirectory, "shutdown-summary.json.tmp");
    h.fault.rewriteFailure = "rename";
    h.fault.unlink = true;
    expect((await h.root.shutdownRuntime(1, h.clock())).code).toBe(4);
    expect(h.lines.has(temporary)).toBe(true);
    const foreign = join(h.config.diagnosticDirectory, "not-sink-owned.tmp");
    h.lines.set(foreign, "untouched");
    const events: DiagnosticEvent[] = [];
    h.fault.rewriteFailure = null;
    const restart = () => new PersistentDiagnosticSink(h.config.diagnosticDirectory, h.logs,
      () => h.clock().wallTimeMs, (value) => events.push(value));
    await expect(restart().readDiagnostics({ limit: 256 })).rejects.toThrow("diagnostic sink unavailable");
    expect(h.lines.has(temporary)).toBe(true);
    h.setTime(8 * 24 * 60 * 60 * 1_000);
    h.fault.unlink = false;
    expect((await restart().readDiagnostics({ limit: 256 })).records).toEqual([]);
    expect([...h.lines]).toEqual([[foreign, "untouched"]]);
    expect(events).toHaveLength(1);
    expect(h.root.diagnostics.droppedCounts().ERROR).toBe(0);
  }
  const h = await harness();
  await h.root.diagnostics.flush();
  const event: DiagnosticEvent = { timestamp: h.clock().wallTimeMs, level: "INFO", component: "shutdown",
    reason: "shutdownStarted", runId: "capacity" };
  const log = join(h.config.diagnosticDirectory, "diagnostics-2027-01-15.jsonl");
  const orphan = join(h.config.diagnosticDirectory, "shutdown-summary.json.tmp");
  h.lines.set(log, `${JSON.stringify(event)}\n`);
  h.lines.set(orphan, "orphan");
  const adapter: DiagnosticFileSystem = { ...h.logs,
    async files(path) { return (await h.logs.files(path)).map((file) => ({ ...file, size: 60 * 1024 * 1024 })); },
    async unlink(path) { if (path === orphan) throw new Error("tmp locked"); await h.logs.unlink(path); },
  };
  const sink = new PersistentDiagnosticSink(h.config.diagnosticDirectory, adapter, () => h.clock().wallTimeMs, () => {});
  await sink.flush();
  expect([...h.lines.keys()]).toEqual([orphan]); // The preserved summary tmp still counts while cleanup fails.
  const recovered = new PersistentDiagnosticSink(h.config.diagnosticDirectory, h.logs, () => h.clock().wallTimeMs, () => {});
  await recovered.flush();
  expect(h.lines.size).toBe(0);
});

it("I04 contractBoundary / AC07: append, daily unlink and query read failures recover on restart without admitting cut lines", async () => {
  for (const stage of ["append", "unlink", "readFile"] as const) {
    const h = await harness();
    const event: DiagnosticEvent = { timestamp: h.clock().wallTimeMs, level: "ERROR", component: "checkpoint",
      reason: "checkpointWriteFailed", runId: "maintenance" };
    for (let repeat = 0; repeat < 3; repeat += 1) h.root.enqueueDiagnostic(event);
    await h.root.diagnostics.flush();
    const path = [...h.lines.keys()][0];
    const saved = h.lines.get(path)!;
    const expired = { ...event, timestamp: event.timestamp - 8 * 86400_000 };
    const date = new Date(expired.timestamp).toISOString().slice(0, 10);
    h.lines.set(join(h.config.diagnosticDirectory, `diagnostics-${date}.jsonl`), `${JSON.stringify(expired)}\n`);
    h.fault.appendError = stage === "append" ? new Error("append failed") : null;
    h.fault.unlink = stage === "unlink";
    h.fault.logRead = stage === "readFile";
    h.root.enqueueDiagnostic(event);
    await h.root.diagnostics.flush();
    if (stage === "readFile") await expect(h.root.readDiagnostics({ limit: 256 })).rejects.toThrow("diagnostic sink unavailable");
    expect(h.lines.get(path)!.startsWith(saved)).toBe(true);
    expect(h.root.diagnostics.droppedCounts().ERROR).toBe(stage === "append" ? 1 : 0);
    h.fault.appendError = null;
    h.fault.unlink = h.fault.logRead = false;
    expect(h.root.enqueueDiagnostic(event).kind).toBe("dropped");
    h.lines.set(path, h.lines.get(path)! + '{"timestamp":');
    const retained = h.lines.get(path);
    const restarted = new PersistentDiagnosticSink(h.config.diagnosticDirectory, h.logs, () => h.clock().wallTimeMs, () => {});
    const read = await restarted.readDiagnostics({ limit: 256 });
    expect(read.records).toEqual([event, { ...event, count: 2 }, ...(stage === "append" ? [] : [event])]);
    expect(h.lines.get(path)).toBe(retained);
    restarted.enqueueDiagnostic({ ...event, runId: "after-restart" });
    await restarted.flush();
    expect((await restarted.readDiagnostics({ limit: 256 })).records)
      .toEqual([...read.records, { ...event, runId: "after-restart" }]);
    expect(h.lines.get(path)).toBe(retained + "\n" + JSON.stringify({ ...event, runId: "after-restart" }) + "\n");
    expect([...h.lines.keys()]).toEqual([path]);
  }
});

it("R13 regression / AC06: shutdown waits for a normal in-flight write and re-evaluates the final generation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const finalGeneration of [1, 2]) {
    const h = await harness({ finalizeBatchesAndSideEffects: async () => {
      await h.update(dirty(finalGeneration), { "U-F": ids.inputIds });
      return { batches: 0, notificationAttempts: 0 };
    } });
    const gate = deferred();
    const entered = deferred();
    h.fault.writeGate = gate.promise;
    h.fault.onOpen = entered.resolve;
    await h.update(dirty());
    const normal = h.start();
    await entered.promise;
    const attemptId = h.attempt()!.attemptId;
    let finished = false;
    const stopping = h.root.shutdownRuntime(1, h.clock()).then((summary) => { finished = true; return summary; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(h.order).toEqual([]);
    expect(h.fault.opens).toBe(1);
    h.setTime(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).toBe(false);
    gate.resolve();
    await normal;
    expect(await stopping).toMatchObject({ code: 0, persistence: { "U-F": {
      currentGeneration: finalGeneration, savedGeneration: finalGeneration, kind: "saved",
    } } });
    expect(h.restore("U-F")).toMatchObject({ envelope: { generation: finalGeneration, payload: `final-${finalGeneration}` } });
    expect(h.fault.opens).toBe(finalGeneration);
    expect(h.order).toEqual(["summary", "close", "summary"]);
    expect(h.measurements.filter((measurement) => measurement.attemptId === attemptId)).toHaveLength(6);
  }
  const late = await harness({ finalizeBatchesAndSideEffects: async () => {
    await late.update(dirty(2), { "U-F": ids.inputIds });
    return { batches: 0, notificationAttempts: 0 };
  } });
  const gate = deferred();
  const entered = deferred();
  late.fault.writeGate = gate.promise;
  late.fault.onOpen = entered.resolve;
  await late.update(dirty());
  const normal = late.start();
  await entered.promise;
  const stopping = late.root.shutdownRuntime(1, late.clock());
  await vi.advanceTimersByTimeAsync(0);
  // The finalize hook's own update ends before the clock moves (so the stage has no remaining batch).
  await late.h.settle(10);
  // The held write keeps the right, so side-effect finalization never becomes quiet (FINALIZE-TIMEOUT=A, D4), and the
  // final checkpoint stage then waits out its own deadline.
  late.setTime(10_000);
  await vi.advanceTimersByTimeAsync(10_000);
  late.setTime(20_000);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await stopping).toMatchObject({ code: 2, reasons: ["sideEffectFinalization:deadlineExceeded",
    "finalCheckpoint:deadlineExceeded", "finalCheckpoint:unsavedUnits"] });
  gate.resolve();
  await normal;
  await vi.advanceTimersByTimeAsync(0);
  expect(late.fault.opens).toBe(1); // The late g1 ack must not start a g2 write after the deadline.
});

it("R14 regression / AC04: ended reconciliation failures retain uncertainty but back off 1/2/4/8/10 seconds", async () => {
  const h = await harness();
  h.fault.directorySync = true;
  const reconcile = h.holdReconcile();
  await h.update(dirty());
  expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["uncertain"]);
  reconcile();
  let due = 0;
  for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
    expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["uncertain"]);
    due = h.root.checkpoint.retryAfter("U-F")!;
    expect(due).toBe(h.clock().monotonicMs + delay);
    expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "uncertain", savedGeneration: null });
    const syncs = h.fault.syncs;
    const measurements = h.measurements.length;
    for (let repeat = 0; repeat < 3; repeat += 1) expect(await h.grant()).toEqual([]);
    h.setTime(due - 1);
    expect(await h.grant()).toEqual([]);
    expect(h.fault.syncs).toBe(syncs);
    expect(h.measurements).toHaveLength(measurements);
    expect(h.root.checkpoint.retryAfter("U-F")).toBe(due);
    h.setTime(due);
  }
  h.fault.directorySync = false;
  // An uncertain unit does not hold back another unit's save while its reconciliation is not due.
  h.setTime(due - 1);
  await h.update(dirty(1, true));
  expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
  expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");
  h.setTime(due);
  await h.grant();
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
  await h.root.diagnostics.flush();
});

it("R15 regression / AC05: reconciliation stages are measured once with the original attempt correlation", async () => {
  const h = await harness();
  h.fault.directorySync = true;
  const reconcile = h.holdReconcile();
  await h.update(dirty());
  const [written] = await h.grant();
  const request = written.result!;
  const before = h.measurements.length;
  const verifies = vi.spyOn(h.h.owners.get("deferred")!["checkpoint"], "restoreUnit");
  reconcile();
  await h.grant();
  for (let repeat = 0; repeat < 3; repeat += 1) expect(await h.grant()).toEqual([]);
  expect(h.measurements.slice(before).map((measurement) => [measurement.stage, measurement.outcome]))
    .toEqual([["verify", "succeeded"], ["directorySync", "failed"]]);
  h.fault.directorySync = false;
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  await h.grant();
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  const measured = h.measurements.slice(before);
  expect(measured.map((measurement) => measurement.stage)).toEqual(["verify", "directorySync", "verify", "directorySync", "verify"]);
  expect(h.measurements.filter((measurement) => measurement.stage === "directorySync")).toHaveLength(h.fault.syncs);
  expect(measured.filter((measurement) => measurement.stage === "verify")).toHaveLength(verifies.mock.calls.length);
  for (const measurement of measured) {
    expect(measurement).toMatchObject({ attemptId: request.attemptId, runId: "review", unit: "U-F", generation: 1,
      inputIds: ids.inputIds, retryReason: "notRetry", bytes: measurement.stage === "verify" ? request.encodedByteLength : 0 });
    expect(measurement.endedMonotonicMs).toBeGreaterThanOrEqual(measurement.startedMonotonicMs);
  }
  expect(h.measurements.filter((measurement) => measurement.stage === "encode")).toHaveLength(1);
  await h.root.diagnostics.flush();
});

it("R17 regression / AC04,AC06: another unit's completed result is kept whether reconciled before or at shutdown", async () => {
  for (const outcome of ["acknowledged", "failed", "uncertain"] as const) {
    for (const application of ["explicit", "shutdown"] as const) {
      const h = await harness();
      h.fault.directorySync = true;
      const reconcile = h.holdReconcile();
      await h.update(dirty(1));
      expect((await h.grant()).map((reply) => [reply.unit, reply.result?.kind])).toEqual([["U-F", "uncertain"]]);
      h.fault.directorySync = false;
      h.fault.checkpointFailure = outcome === "failed" ? "write" : null;
      const gate = deferred();
      h.fault.writeGate = gate.promise;
      await h.update(dirty(1, true)); // U-W's input saves at once (P3-UWR-AC03); its write waits at the gate
      const running = h.start();
      await vi.waitFor(() => expect(h.root.checkpoint.grantOf("U-W")?.unit).toBe("U-W"));
      // P3-UWR-AC01 (AC10(9)): while U-W writes, U-F's due reconciliation runs with its own right and is acknowledged.
      h.setTime(20_000);
      reconcile();
      await vi.waitFor(() => expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved"));
      expect(h.root.checkpoint.grantOf("U-W")?.unit).toBe("U-W");
      h.fault.directorySync = outcome === "uncertain";
      gate.resolve();
      await running;
      const [weather] = h.h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" && reply.unit === "U-W" ? [reply] : []);
      expect(weather.result!.kind).toBe(outcome);
      h.fault.directorySync = false;
      h.fault.checkpointFailure = null;
      if (application === "explicit") {
        for (let round = 0; round < 3 && (h.root.state.mirror["U-F"].persistence.kind === "uncertain"
          || h.root.state.mirror["U-W"].persistence.kind === "uncertain"); round += 1) {
          h.setTime(Math.max(h.clock().monotonicMs, h.root.checkpoint.retryAfter("U-W") ?? 0));
          await h.grant();
        }
      }
      const summary = await h.root.shutdownRuntime(1, h.clock());
      expect(summary.persistence["U-W"]?.kind).toBe(application === "shutdown" && outcome === "uncertain" ? "uncertain" : "saved");
      expect(summary.persistence["U-F"]?.kind).toBe("saved");
      expect(summary.code).toBe(application === "shutdown" && outcome === "uncertain" ? 2 : 0);
      expect(h.measurements.filter((measurement) => measurement.attemptId === weather.result!.attemptId && measurement.stage === "write"))
        .toHaveLength(1);
      expect(h.order).toEqual(["summary", "close", "summary"]);
    }
  }
});

it("I01 contractBoundary / AC04,AC05,AC08: checkpoint fault stages cross recovery, restart and repeated failures", async () => {
  for (const [stage, mode] of [
    ...(["open", "write", "fileSync", "close", "rename", "directorySync", "readFile", "verify"] as const)
      .map((stage) => [stage, "retry"] as const),
    ["close", "restart"], ["rename", "restart"], ["directorySync", "restart"], ["verify", "restart"],
    ["write", "continuous"], ["fileSync", "continuous"], ["readFile", "continuous"], ["verify", "continuous"],
  ] as const) {
      const h = await harness();
      // U-F's inputs save at once (P3-UWR-AC03): the g2 input comes in the first round, after its faults are set, and its
      // uncertain save's reconciliation waits for the test. U-W becomes dirty after the faults (AC10(7)).
      await h.update(dirty(1));
      expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-F"]);
      const second = fixtureState({ "U-F": "final-2" }, {
        "U-F": { ...h.h.unit("U-F").persistence, kind: "pending", currentGeneration: 2, dirtySince: 0 } });
      const setFault = (active: boolean) => {
        h.fault.checkpointFailure = active && ["open", "write", "fileSync", "close", "rename"].includes(stage)
          ? stage as "open" | "write" | "fileSync" | "close" | "rename" : null;
        h.fault.directorySync = active && stage === "directorySync";
        h.fault.read = active && stage === "readFile";
        h.fault.verify = active && stage === "verify";
        h.fault.renamed = false;
        h.fault.onDirectorySync = () => { if (active && stage === "verify") h.fault.renamed = true; };
      };
      // A steady save has no verify read: the verify stage uses the same-generation confirm of the recovery path,
      // with the slot the g2 capture will produce (a retry keeps its capture time).
      const confirm = serializedEnvelope(fixtureEnvelope(2, h.clock().wallTimeMs));
      const rounds = mode === "continuous" ? 3 : 1;
      for (let index = 0; index < rounds; index += 1) {
        if (stage === "verify") {
          h.bytes.set(join(h.config.stateDirectory, "U-F-B.json"), confirm);
          h.restore("U-F");
        }
        setFault(true);
        if (stage === "readFile") h.restore("U-F"); // An unreadable slot drops the memory, so the save must read.
        const reconcile = h.holdReconcile();
        if (index === 0) await h.update(second);
        const [output] = await h.grant();
        expect(output.unit).toBe("U-F");
        expect(output.result!.kind).toBe(["rename", "directorySync", "verify"].includes(stage) ? "uncertain" : "failed");
        expect(output.measurements.filter((measurement) => measurement.outcome === "failed")).toHaveLength(1);
        expect(output.measurements.every((measurement) => measurement.attemptId === output.result!.attemptId
          && measurement.unit === "U-F" && measurement.generation === 2)).toBe(true);
        if (mode === "continuous" && output.result!.kind === "uncertain") {
          // A missing/unreadable target turns reconciliation into a completed verify failure.
          h.fault.read = true;
          reconcile();
          await h.grant();
        }
        setFault(false);
        reconcile();
        expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp")).length).toBeLessThanOrEqual(1);
        if (index < rounds - 1) h.setTime(h.root.checkpoint.retryAfter("U-F")!);
      }
      setFault(false);
      const restore = h.restore("U-F");
      expect(restore, `${stage}/${mode}`).toMatchObject({ kind: "restored", envelope: {
        generation: ["directorySync", "verify"].includes(stage) ? 2 : 1,
      } });
      if (mode === "restart") {
        await h.root.diagnostics.flush();
        const restarted = h.runtime(fixtureDriver(), { "U-F": codec, "U-W": stringCodec("U-W") });
        await startHarness(restarted.h, "review", h.clock());
        expect(h.restore("U-F", restarted.h)).toEqual(restore);
        const desired = dirty(3);
        await restarted.driver.update(restarted.h, { ...desired, units: { ...desired.units,
          "U-F": { ...desired.units["U-F"], persistence: { ...restarted.h.unit("U-F").persistence,
            kind: "pending", currentGeneration: 3, dirtySince: 0 } },
        } }, h.clock(), { "U-F": ids.inputIds });
        expect((await granted(restarted.h)).map((reply) => reply.unit)).toEqual(["U-F"]);
        await restarted.h.root.diagnostics.flush();
      } else {
        // The failing unit cannot block a healthy unit after its result was applied.
        await h.update(dirty(1, true));
        for (let round = 0; round < 4 && !(h.root.state.mirror["U-W"].persistence.kind === "saved"
          && h.root.state.mirror["U-F"].persistence.kind === "saved"); round += 1) {
          if ((await h.grant()).length === 0) h.setTime(h.root.checkpoint.retryAfter("U-F")!);
        }
        expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");
        expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ kind: "saved", savedGeneration: 2 });
        expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
      }
      await h.root.diagnostics.flush();
  }
});

it("I02 contractBoundary / AC04,AC06: a held reconciliation does not hold back another unit's write, and shutdown waits for both", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const failed of [false, true]) {
    const h = await harness();
    h.fault.directorySync = true;
    const reconcile = h.holdReconcile();
    await h.update(dirty(1));
    expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["uncertain"]);
    h.fault.directorySync = failed;
    const gate = deferred();
    h.fault.syncGate = gate.promise;
    reconcile();
    const reconciliation = h.start();
    await vi.waitFor(() => expect(h.root.checkpoint.grantOf("U-F")?.mode).toBe("reconcile"));
    // P3-UWR-AC01 (AC10(9)): U-W gets its own right and writes while U-F's reconciliation is held.
    await h.update(dirty(1, true));
    expect(h.root.checkpoint.grantOf("U-W")?.mode).toBe("save");
    const stopped = h.root.shutdownRuntime(1, h.clock());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.order).toEqual([]);
    expect(h.fault.opens).toBe(2);
    gate.resolve();
    await reconciliation;
    const summary = await stopped;
    expect(summary.code).toBe(failed ? 2 : 0);
    expect(summary.persistence["U-F"]?.kind).toBe(failed ? "uncertain" : "saved");
    expect(summary.persistence["U-W"]?.kind).toBe(failed ? "uncertain" : "saved");
    expect(h.fault.opens).toBe(2);
    expect(h.measurements.filter((measurement) => measurement.stage === "directorySync")).toHaveLength(h.fault.syncs);
    expect(h.order).toEqual(["summary", "close", "summary"]);
  }
});

it("R19 regression / AC08: retrying the same generation preserves the preceding slot instead of creating conflicting twins", async () => {
  const h = await harness();
  await h.update(dirty());
  await h.grant();
  // The g2 input saves at once (P3-UWR-AC03) under the fault; its reconciliation waits for the test.
  h.fault.directorySync = true;
  const reconcile = h.holdReconcile();
  await h.update(fixtureState({ "U-F": "final-2" }, { "U-F": { ...h.h.unit("U-F").persistence, kind: "pending", currentGeneration: 2, dirtySince: 0 } }));
  const [second] = await h.grant();
  const secondSlot = JSON.parse(new TextDecoder().decode(h.bytes.get(join(h.config.stateDirectory, "U-F-B.json"))!)) as
    ReturnType<typeof fixtureEnvelope>;
  h.fault.read = true;
  reconcile();
  await h.grant();
  h.fault.read = false;
  h.fault.directorySync = false;
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  const opens = h.fault.opens;
  const [retry] = await h.grant();
  expect(retry.result!.attemptId).not.toBe(second.result!.attemptId);
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  expect(h.fault.opens).toBe(opens);
  expect(retry.measurements.map((entry) => entry.stage)).toEqual(["directorySync", "verify"]);
  expect([...h.bytes.values()].map((bytes) => JSON.parse(new TextDecoder().decode(bytes)).generation).sort()).toEqual([1, 2]);
  // The retry kept the earlier capture: same envelope (hash and capture time) in slot B.
  expect(h.restore("U-F")).toMatchObject({ kind: "restored", envelope: { generation: 2,
    sha256: secondSlot.sha256, capturedAt: secondSlot.capturedAt } });
  await h.root.diagnostics.flush();
});

it("P2-A3-T10 contractBoundary / AC10: a later explicit empty step cannot fill an earlier missing attribution", async () => {
  const h = await harness();
  const receive = ownerRuntime.receiveOwner;
  const fault = vi.spyOn(ownerRuntime, "receiveOwner");
  fault.mockImplementationOnce((...args) => ({ ...receive(...args), generationInputIds: {} }));
  await h.update(dirty(1));
  fault.mockImplementationOnce((...args) => ({ ...receive(...args), generationInputIds: { "U-F": [] } }));
  await h.update(dirty(2));
  fault.mockRestore();
  // The owner declines the grant: generation 1 has no known inputs.
  expect((await h.grant()).map((reply) => [reply.unit, reply.result])).toEqual([["U-F", null]]);
  expect((await h.root.shutdownRuntime(2, h.clock())).code).toBe(2);
  expect(h.fault.opens).toBe(0);
});

it("P3-OLB-T03 contractBoundary / AC02: an unknown attribution is not discarded by the 4,096-generation bound", async () => {
  const receive = ownerRuntime.receiveOwner;
  const fault = vi.spyOn(ownerRuntime, "receiveOwner");
  const missing = () => fault.mockImplementationOnce((...args) => ({ ...receive(...args), generationInputIds: {} }));
  // (1) g1 is unknown; a jump past 4,096 generations still leaves the grant declined and the exit code 2.
  const first = await harness();
  missing();
  await first.update(dirty(1));
  await first.update(dirty(5_000), { "U-F": ["late"] });
  expect((await first.grant()).map((reply) => [reply.unit, reply.result])).toEqual([["U-F", null]]);
  expect((await first.root.shutdownRuntime(2, first.clock())).code).toBe(2);
  expect(first.fault.opens).toBe(0);
  // (2) g1 is known and captured (its write held); g2 is unknown, then a jump past 4,096. g1 is acknowledged, later grants decline.
  const second = await harness();
  const gate = deferred();
  second.fault.writeGate = gate.promise;
  await second.update(dirty(1), { "U-F": ["known"] });
  const running = second.start();
  await vi.waitFor(() => expect(second.fault.opens).toBe(1));
  // 契約の文言（sync 保留・入力 1 件）と経路が違う理由: own-save hold が g1 の保存中は同じ unit の入力を留め置くので、
  // ack の前に g2 を入れる順序は期限の経路（byDeadline）でしか作れない。
  const deadline = ownerRuntime.deadlineOwner;
  const deadlineFault = vi.spyOn(ownerRuntime, "deadlineOwner");
  deadlineFault.mockImplementation((...args) => {
    const step = deadline(...args);
    return step.state.units["U-F"]?.persistence.currentGeneration === 2 ? { ...step, generationInputIds: {} } : step;
  });
  await second.driver.update(second.h, dirty(2), second.clock(), {}, true);
  await second.driver.update(second.h, dirty(5_000), second.clock(), {}, true);
  gate.resolve();
  await running;
  expect(second.root.state.mirror["U-F"].persistence).toMatchObject({ savedGeneration: 1 });
  await second.grant();
  const results = second.h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" && reply.unit === "U-F"
    ? [reply.result?.kind ?? null] : []);
  expect(results[0]).toBe("acknowledged");
  expect(results.slice(1).length).toBeGreaterThan(0);
  expect(results.slice(1).every((kind) => kind === null)).toBe(true);
  expect(second.root.state.mirror["U-F"].persistence).toMatchObject({ savedGeneration: 1, currentGeneration: 5_000 });
  expect((await second.root.shutdownRuntime(2, second.clock())).code).toBe(2);
  expect(second.fault.opens).toBe(1);
});

it("P2-A3-T09 contractBoundary / AC09: an identical durable generation is acknowledged without rewriting a slot", async () => {
  const h = await harness();
  const slot = join(h.config.stateDirectory, "U-F-A.json");
  const bytes = serializedEnvelope(fixtureEnvelope(1, h.clock().wallTimeMs));
  h.bytes.set(slot, bytes);
  h.restore("U-F"); // The file was placed from outside; the memory learns it by a read at the same generation.
  await h.update(dirty()); // its input saves at once (P3-UWR-AC03)
  expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["acknowledged"]);
  expect(h.fault.opens).toBe(0);
  expect(h.fault.syncs).toBe(1);
  expect(h.bytes.get(slot)).toEqual(bytes);
  await h.root.diagnostics.flush();
});

it("I03 contractBoundary / AC08: restart selects only valid slots and never restores an orphan checkpoint tmp", async () => {
  for (const scenario of ["empty", "tmp", "leftBroken", "rightBroken", "bothBroken", "schema", "conflict", "payload"] as const) {
    const h = await harness();
    await h.root.diagnostics.flush();
    const a = join(h.config.stateDirectory, "U-F-A.json");
    const b = join(h.config.stateDirectory, "U-F-B.json");
    const envelope = (generation: number, schemaVersion = codec.schemaVersion, payload: JsonValue = "payload") =>
      serializedEnvelope(hashEnvelope({ unit: "U-F", generation, schemaVersion, capturedAt: h.clock().wallTimeMs, payload }));
    const broken = new TextEncoder().encode('{"generation":');
    if (scenario !== "empty" && scenario !== "tmp") {
      h.bytes.set(a, envelope(1)); h.bytes.set(b, envelope(2));
    }
    if (scenario === "tmp") h.bytes.set(`${a}.tmp`, envelope(99));
    if (scenario === "leftBroken" || scenario === "bothBroken") h.bytes.set(a, broken);
    if (scenario === "rightBroken" || scenario === "bothBroken") h.bytes.set(b, broken);
    if (scenario === "schema") { h.bytes.set(a, envelope(1, "old-schema")); h.bytes.set(b, envelope(2, "old-schema")); }
    if (scenario === "conflict") h.bytes.set(a, envelope(2, codec.schemaVersion, "other"));
    if (scenario === "payload") h.bytes.set(b, envelope(2, codec.schemaVersion, { wrong: true }));
    const restarted = h.runtime(fixtureDriver(), { "U-F": codec });
    await startHarness(restarted.h, "restart", h.clock());
    const restored = h.restore("U-F", restarted.h);
    expect(restored, scenario).toMatchObject(scenario === "empty" || scenario === "tmp" ? { kind: "empty" }
      : scenario === "bothBroken" || scenario === "schema" || scenario === "conflict" ? { kind: "unavailable" }
        : { kind: "restored", envelope: { generation: scenario === "leftBroken" ? 2 : 1 } });
    await restarted.h.root.diagnostics.flush();
  }
});

it("R20 regression / AC08: a later rejected restoration cannot expose a previously decoded state", async () => {
  const h = await harness();
  await h.update(dirty());
  await h.grant();
  const restored = h.restore("U-F");
  expect(restored.kind).toBe("restored");
  if (restored.kind !== "restored") throw new Error("checkpoint not restored");
  expect(codec.decode(restored.envelope.payload)).toMatchObject({ kind: "restored", state: { value: "final-1" } });
  h.bytes.set([...h.bytes.keys()][0], new TextEncoder().encode("corrupt"));
  expect(h.restore("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
  await h.root.diagnostics.flush();
});

it("R21 regression / AC08: startup read EIO returns unavailable and recovers after the adapter is released", async () => {
  const h = await harness();
  h.fault.read = true;
  for (let repeat = 0; repeat < 3; repeat += 1)
    expect(h.restore("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
  h.fault.read = false;
  expect(h.restore("U-F")).toEqual({ kind: "empty" });
  await h.update(dirty());
  expect((await h.grant()).map((reply) => reply.result?.kind)).toEqual(["acknowledged"]);
  expect(h.restore("U-F").kind).toBe("restored");
  await h.root.diagnostics.flush();
});

it("R22 regression / AC04,AC06: the owner replies with the durable ack only after its write ends, with no reconciliation I/O", async () => {
  const h = await harness();
  const gate = deferred();
  h.fault.writeGate = gate.promise;
  await h.update(dirty());
  const executing = h.start();
  await vi.waitFor(() => expect(h.fault.opens).toBe(1));
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("pending");
  gate.resolve();
  await executing;
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  expect(h.measurements.map((measurement) => measurement.stage)).toEqual(["encode", "write", "fileSync", "close", "rename", "directorySync"]);
  expect((await h.root.shutdownRuntime(1, h.clock())).code).toBe(0);
});

it("R23 regression / AC06: normal scheduling cannot introduce a new dirty generation after shutdown finalization", async () => {
  const entered = deferred();
  const gate = deferred();
  const h = await harness({ drainMailbox: async (_deadline, active) => { await h.root.drainInputs(active); } });
  h.driver.queue(h.h, dirty(), h.clock(), { "U-F": ids.inputIds });
  h.fault.onSummary = entered.resolve;
  h.fault.summaryGate = gate.promise;
  const stopping = h.root.shutdownRuntime(1, h.clock());
  await entered.promise;
  await h.update(dirty(99));
  expect(await h.grant()).toEqual([]);
  gate.resolve();
  expect(await stopping).toMatchObject({ code: 0, persistence: { "U-F": { currentGeneration: 1, savedGeneration: 1 } } });
  expect(h.measurements.filter((measurement) => measurement.stage === "encode")).toHaveLength(1);
  expect(h.fault.opens).toBe(1);
  const uncertain = await harness();
  uncertain.fault.directorySync = true;
  await uncertain.update(dirty()); // saves at once (P3-UWR-AC03), and its reconciliation fails the same way
  await uncertain.grant();
  expect((await uncertain.root.shutdownRuntime(1, uncertain.clock())).code).toBe(2);
  uncertain.fault.directorySync = false;
  const syncs = uncertain.fault.syncs;
  expect(await uncertain.grant()).toEqual([]);
  expect(uncertain.root.state.mirror["U-F"].persistence.kind).toBe("uncertain");
  expect(uncertain.fault.syncs).toBe(syncs);
});

it("I05 contractBoundary / AC06: each shutdown stage respects faults, deadline edges and dirty-state handoff", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const observe = vi.spyOn(sharedRuntime, "observeStage");
  for (const stage of ["drain", "finalize", "save", "summary"] as const) {
    for (const mode of ["failure", "within", "timeout", "clockJump", "overallJump"] as const) {
      const gate = deferred();
      const entered = deferred();
      const limit = stage === "drain" || stage === "save" ? 10_000 : 5_000;
      const pause = async () => { entered.resolve(); await gate.promise; if (mode === "failure") throw new Error("stage failed"); };
      const h = await harness({
        drainMailbox: async (_deadline, active) => {
          if (stage === "drain") await pause();
          if (active()) await h.root.drainInputs(active);
        },
        finalizeBatchesAndSideEffects: async (_deadline, active) => {
          // AC09: owners take no request once the stage stops them, so the stage's own change comes before its pause.
          if (active()) await h.update(dirty(2), { "U-F": ids.inputIds });
          if (stage === "finalize") await pause();
          return { batches: 0, notificationAttempts: 0 };
        },
      });
      if (stage === "save") {
        h.fault.onOpen = entered.resolve;
        h.fault.writeGate = gate.promise;
        if (mode === "failure") h.fault.checkpointFailure = "write";
      }
      if (stage === "summary") {
        h.fault.onSummary = entered.resolve;
        h.fault.summaryGate = gate.promise;
        if (mode === "failure") h.fault.rewriteFailure = "write";
      }
      h.driver.queue(h.h, dirty(), h.clock(), { "U-F": ids.inputIds });
      const stopped = h.root.shutdownRuntime(2, h.clock());
      await entered.promise;
      expect(h.root.mailbox.stats(h.clock().monotonicMs).accepting).toBe(false);
      const late = mode === "timeout" || mode === "clockJump" || mode === "overallJump";
      h.setTime(mode === "overallJump" ? 30_000 : late ? limit : limit - 1);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(limit);
      gate.resolve();
      const summary = await stopped;
      const observations = observe.mock.calls.map(([, input]) => input.stage);
      expect(observations.slice(-4)).toEqual(["mailboxDrain", "sideEffectFinalization", "finalCheckpoint", "workerClose"]);
      const results = Object.values(h.root.state.shutdown.stageResults);
      expect(results).toHaveLength(4);
      expect(h.root.state.shutdown.stage).toBe("completed");
      expect(observe.mock.results.at(-1)?.type === "return" && observe.mock.results.at(-1)?.value.summary).toBe(summary);
      const observedStage = stage === "drain" ? "mailboxDrain" : stage === "finalize" ? "sideEffectFinalization"
        : stage === "save" ? "finalCheckpoint" : "workerClose";
      expect(h.root.state.shutdown.stageResults[observedStage]?.result.kind)
        .toBe(late ? "deadlineExceeded" : mode === "failure" && stage !== "save" ? "failed" : "completed");
      const expected = mode === "within" ? 0 : stage === "drain" || stage === "finalize" ? 3 : stage === "save" ? 2 : 4;
      expect(summary.code, `${stage}/${mode}`).toBe(expected);
      if (expected === 0) expect(summary.persistence["U-F"]?.savedGeneration).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      await h.h.settle();
      expect(h.fault.opens).toBeLessThanOrEqual(1);
      expect(h.measurements.filter((measurement) => measurement.stage === "write")).toHaveLength(h.fault.opens);
      if (mode === "overallJump" || stage === "summary" && mode !== "within") expect(h.order.includes("close")).toBe(false);
      else expect(h.order).toContain("close");
    }
  }
});

it("I06 contractBoundary / AC04,AC07: wall-clock rollback and date crossings cannot bypass monotonic backoff", async () => {
  const h = await harness();
  await h.update(dirty());
  h.fault.checkpointFailure = "write";
  await h.grant();
  h.fault.checkpointFailure = null;
  const due = h.root.checkpoint.retryAfter("U-F")!;
  for (const wallOffset of [-2 * 86400_000, 2 * 86400_000, -1, 0]) {
    h.setWallOffset(wallOffset);
    for (let repeat = 0; repeat < 3; repeat += 1) expect(await h.grant()).toEqual([]);
    expect(h.root.checkpoint.retryAfter("U-F")).toBe(due);
  }
  expect(h.fault.opens).toBe(1);
  h.setTime(due);
  h.setWallOffset(-2 * 86400_000);
  await h.grant();
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  expect(h.measurements.every((measurement) => measurement.endedMonotonicMs >= measurement.startedMonotonicMs)).toBe(true);
  await h.root.diagnostics.flush();
});

it("I07 contractBoundary / AC04,AC08: checkpoint rename completion followed by a lost response does not duplicate writes", async () => {
  const h = await harness();
  const rename = h.fs.rename;
  const injected = vi.spyOn(h.fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to); throw new Error("lost rename response");
  });
  // U-F's input saves at once (P3-UWR-AC03); its reconciliation waits for the test. U-W becomes dirty after it (AC10(7)).
  const reconcile = h.holdReconcile();
  await h.update(dirty(1));
  expect((await h.grant()).map((reply) => [reply.unit, reply.result?.kind])).toEqual([["U-F", "uncertain"]]);
  injected.mockRestore();
  reconcile();
  await h.grant();
  expect(h.root.state.mirror["U-F"].persistence.kind).toBe("saved");
  expect(h.fault.opens).toBe(1);
  expect([...h.bytes.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  await h.update(dirty(1, true));
  expect((await h.grant()).map((reply) => reply.unit)).toEqual(["U-W"]);
  await h.root.diagnostics.flush();
});

it("R24 regression / AC08 RES-01: same-generation failure then current advancement cannot leave two checkpoint tmp files", async () => {
  const h = await harness();
  await h.update(dirty());
  const save = async () => {
    const replies = await h.grant();
    expect(replies.map((reply) => reply.unit)).toEqual(["U-F"]);
    return replies[0];
  };
  const advance = (generation: number) => h.update(fixtureState({ "U-F": `final-${generation}` }, { "U-F": {
    ...h.h.unit("U-F").persistence, kind: "pending", currentGeneration: generation, dirtySince: 0 } }));
  await save(); // A g1
  // Each advance saves at once (P3-UWR-AC03): the faults come first, and g2's reconciliation waits for the test.
  h.fault.directorySync = true;
  const reconcile = h.holdReconcile();
  await advance(2);
  await save(); // B g2, directory durability unknown
  h.fault.read = true;
  reconcile();
  await save(); // its reconciliation cannot read
  h.fault.read = false;
  h.fault.directorySync = false;
  h.fault.checkpointFailure = "write";
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  await save(); // The identical g2 is confirmed without invoking the faulty writer.
  expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toHaveLength(0);
  await advance(3);
  h.setTime(h.clock().monotonicMs + 1);
  await save(); // partial g3, destination switches to A
  expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toHaveLength(1);
  expect(h.bytes.size).toBe(3);
  h.fault.checkpointFailure = null;
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  await save();
  expect(h.restore("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 3 } });
  expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
  expect(h.bytes.size).toBe(2);
  await h.root.diagnostics.flush();
});

it("I08 contractBoundary / AC04,AC08 RES-01: tmp lifetime is bounded across slot switches, changing generations, held cleanup and restart", async () => {
  const stages = ["write", "close", "rename", "directorySync"] as const;
  for (const [baseline, firstStage, nextStage, advance, held, restart] of [
    [2, "write", "close", true, true, true], [2, "close", "rename", true, true, true],
    [2, "rename", "directorySync", true, true, true], [2, "directorySync", "write", true, false, true],
  ] as const) {
      const h = await harness();
      let target = h.h;
      let driver = h.driver;
      const checkBound = () => {
        const owned = [...h.bytes.keys()].filter((path) => basename(path).startsWith("U-F"));
        expect(owned.filter((path) => path.endsWith(".tmp")).length).toBeLessThanOrEqual(1);
        expect(owned.filter((path) => path.endsWith(".json")).length).toBeLessThanOrEqual(2);
        expect(owned.length).toBeLessThanOrEqual(3);
      };
      const set = h.bytes.set.bind(h.bytes);
      h.bytes.set = (path, bytes) => { const result = set(path, bytes); checkBound(); return result; };
      const changeGeneration = (generation: number) => driver.update(target, fixtureState({ "U-F": `final-${generation}` }, {
        "U-F": { ...target.unit("U-F").persistence, kind: "pending", currentGeneration: generation, dirtySince: 0 } },
      target.root.state.runId), h.clock());
      const due = () => h.setTime(Math.max(h.clock().monotonicMs, target.root.checkpoint.retryAfter("U-F") ?? 0));
      const execute = async () => {
        due();
        const replies = await granted(target);
        expect(replies.map((reply) => reply.unit)).toEqual(["U-F"]);
        return replies[0];
      };
      // A new generation saves at once (P3-UWR-AC03): its faults and gates come first, and an uncertain save's
      // reconciliation waits for rejectUncertain (AC10(7)).
      let reconcile = () => {};
      const rejectUncertain = async () => {
        if (target.root.state.mirror["U-F"].persistence.kind !== "uncertain") { reconcile(); return; }
        h.fault.read = true;
        reconcile();
        await granted(target);
        h.fault.read = false;
      };
      const failAt = (stage: typeof stages[number] | null) => {
        h.fault.checkpointFailure = stage === "directorySync" ? null : stage;
        h.fault.directorySync = stage === "directorySync";
      };
      for (let generation = 1; generation <= baseline; generation += 1) {
        await changeGeneration(generation); await execute();
      }
      failAt("directorySync");
      reconcile = h.holdReconcile(target);
      await changeGeneration(baseline + 1);
      await execute();
      await rejectUncertain(); // A/B contains the new, unacknowledged generation.
      failAt(firstStage);
      reconcile = h.holdReconcile(target);
      await execute();
      await rejectUncertain(); // Same generation, first failure stage.
      checkBound();
      failAt(nextStage);
      const nextGeneration = advance ? baseline + 2 : target.unit("U-F").persistence.currentGeneration;
      due();
      const entered = deferred();
      const gate = deferred();
      if (held) {
        if (nextStage === "close") { h.fault.closeGate = gate.promise; h.fault.onClose = entered.resolve; }
        if (nextStage === "rename") { h.fault.renameGate = gate.promise; h.fault.onRename = entered.resolve; }
        if (nextStage === "directorySync") { h.fault.syncGate = gate.promise; h.fault.onDirectorySync = entered.resolve; }
      }
      reconcile = h.holdReconcile(target);
      const running = advance ? (async () => {
        await changeGeneration(baseline + 2);
        while (target.root.checkpoint.grantOf("U-F")?.mode === "save") await target.settle();
      })() : granted(target);
      if (held) {
        await entered.promise;
        const opens = h.fault.opens;
        const unlinks = h.fault.unlinks;
        // While the attempt holds its close/rename/sync open, no other grant runs and a read-only restore reclaims nothing.
        h.setTime(h.clock().monotonicMs + 20_000);
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const before = grants(target).length;
          void target.root.driveCheckpoint();
          expect(grants(target)).toHaveLength(before);
          h.restore("U-F", target);
        }
        expect(h.fault.opens).toBe(opens);
        expect(h.fault.unlinks).toBe(unlinks);
        checkBound();
        gate.resolve();
      }
      await running;
      checkBound();
      await rejectUncertain();
      failAt(null);
      h.fault.closeGate = h.fault.renameGate = h.fault.syncGate = null;
      if (restart) {
        // The previous operation has ended; this models exclusive ownership after process restart.
        await target.root.diagnostics.flush();
        const restarted = h.runtime(fixtureDriver(), { "U-F": codec, "U-W": stringCodec("U-W") });
        target = restarted.h;
        driver = restarted.driver;
        await startHarness(target, "restarted", h.clock()); // the owners reclaim their tmp files as they restore
        expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
        expect(h.restore("U-F", target).kind).toBe("restored");
        if (target.unit("U-F").persistence.currentGeneration < nextGeneration)
          await changeGeneration(nextGeneration);
      }
      // The restarted runtime's new generation saved at once (P3-UWR-AC03); that save is the one checked below.
      const [immediate] = restart ? target.newDone() : [];
      const saved = target.root.state.mirror["U-F"].persistence.kind === "saved" ? immediate ?? null : await execute();
      expect(h.restore("U-F", target)).toMatchObject({ kind: "restored", envelope: { generation: nextGeneration } });
      expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
      expect(h.bytes.size).toBe(2);
      checkBound();
      expect(h.measurements.filter((measurement) => measurement.attemptId === saved?.result?.attemptId && measurement.stage === "write"))
        .toHaveLength(nextStage === "directorySync" ? 0 : 1);
      await target.root.diagnostics.flush();
    }
});

it("I09 contractBoundary / AC08 RES-01: startup reclaims only owned tmp, and deletion failure blocks a new tmp until recovery", async () => {
  for (const failCleanup of [false, true]) {
    const h = await harness();
    await h.update(dirty());
    await h.grant();
    const slot = join(h.config.stateDirectory, "U-F-A.json");
    const saved = h.bytes.get(slot)!.slice();
    const foreign = join(h.config.stateDirectory, "unowned.tmp");
    h.bytes.set(foreign, new Uint8Array([7]));
    h.bytes.set(join(h.config.stateDirectory, "U-W.json.tmp"), new Uint8Array([8]));
    // Include residues made by the pre-fix implementation, even its invalid two-tmp state.
    for (const name of ["U-F.json.tmp", "U-F-A.json.tmp", "U-F-B.json.tmp"])
      h.bytes.set(join(h.config.stateDirectory, name), new Uint8Array([9]));
    h.fault.checkpointUnlink = failCleanup;
    const restarted = h.runtime(fixtureDriver(), { "U-F": codec });
    await startHarness(restarted.h, "review", h.clock());
    expect(h.restore("U-F", restarted.h)).toMatchObject({ kind: "restored", envelope: { generation: 1 } });
    await restarted.driver.update(restarted.h, fixtureState({ "U-F": "final-2" }, { "U-F": {
      kind: "pending", currentGeneration: 2, savedGeneration: 1,
      savedCapturedAt: 0, savedAckAt: 0, dirtySince: 0,
    } }), h.clock(), { "U-F": ids.inputIds });
    if (failCleanup) {
      const opens = h.fault.opens;
      const [failed] = await granted(restarted.h);
      expect(failed.result).toMatchObject({ kind: "failed", stage: "write" });
      expect(failed.measurements.filter((measurement) => measurement.stage !== "encode"))
        .toEqual([expect.objectContaining({ stage: "write", outcome: "failed" })]);
      expect(h.fault.opens).toBe(opens); // Existing over-limit residue cannot be enlarged by another open.
      h.fault.checkpointUnlink = false;
      h.setTime(restarted.h.root.checkpoint.retryAfter("U-F")!);
    } else expect([...h.bytes.keys()].filter((path) => basename(path).startsWith("U-F") && path.endsWith(".tmp"))).toEqual([]);
    expect((await granted(restarted.h)).map((reply) => reply.result?.kind)).toEqual(["acknowledged"]);
    expect(h.bytes.get(slot)).toEqual(saved);
    expect([...h.bytes.keys()].filter((path) => basename(path).startsWith("U-F"))).toHaveLength(2);
    expect(h.bytes.get(foreign)).toEqual(new Uint8Array([7]));
    expect(h.bytes.get(join(h.config.stateDirectory, "U-W.json.tmp"))).toEqual(new Uint8Array([8]));
    await restarted.h.root.diagnostics.flush();
    await h.root.diagnostics.flush();
  }
  const directory = await disk.mkdtemp(join(tmpdir(), "fleq-a3-owned-tmp-"));
  try {
    const stateDirectory = join(directory, "state");
    await disk.mkdir(stateDirectory);
    for (const name of ["U-F.json.tmp", "U-F-A.json.tmp", "U-F-B.json.tmp", "other.tmp"])
      await disk.writeFile(join(stateDirectory, name), "orphan");
    const owners = harnessedRoot({ appName: "p2", legacyAppName: "v2", stateDirectory,
      legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "logs") }, { "U-F": codec },
    { notificationAdapter: recordingNotificationAdapter() });
    // The owners reclaim their tmp files when they restore at startup.
    await startHarness(owners, "review", { wallTimeMs: 1, monotonicMs: 1 });
    expect(await disk.readdir(stateDirectory)).toEqual(["other.tmp"]);
    expect(owners.owners.get("deferred")!["checkpoint"].restoreUnit("U-F")).toEqual({ kind: "empty" });
    await owners.root.diagnostics.flush();
  } finally { await disk.rm(directory, { recursive: true, force: true }); }
});
