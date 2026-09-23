import { promises as disk } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type { CheckpointRequest, DiagnosticEvent, JsonValue, RuntimeState, UnitCodec } from "../../contracts/p2-shared-runtime.types";
import { hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { PersistentDiagnosticSink } from "../../src/checkpoint/persistent-diagnostic-sink";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";
import { fixtureState, fixtureValue, fixtureDriver, stringCodec } from "./runtime-fixture";
import type { ShutdownHooks } from "../../src/runtime/composition-root";
import * as sharedRuntime from "../../src/runtime/shared-runtime";

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

function harness(hooks: ShutdownHooks = {}) {
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
    writeGate: null as Promise<void> | null, summaryGate: null as Promise<void> | null,
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
          await fault.writeGate;
          if (fault.checkpointFailure === "write") { bytes.set(path, data.slice(0, 10)); throw new Error("partial write"); }
          bytes.set(path, data.slice());
        },
        async sync() { if (fault.checkpointFailure === "fileSync") throw new Error("file sync failed"); },
        async close() {
          if (++closes === 1 && fault.checkpointFailure === "close") throw new Error("close failed");
          fault.onClose(); await fault.closeGate;
          if (fault.checkpointFailure === "close") throw new Error("close failed");
        },
      };
    },
    async rename(from, to) {
      fault.onRename(); await fault.renameGate;
      if (fault.checkpointFailure === "rename") throw new Error("rename failed");
      bytes.set(to, bytes.get(from)!); bytes.delete(from); fault.renamed = true;
    },
    async syncDirectory() {
      fault.syncs += 1; fault.onDirectorySync(); await fault.syncGate;
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
  const driver = fixtureDriver();
  const root = new RuntimeCompositionRoot(config, { "U-E": stringCodec("U-E"), "U-F": { ...codec, encode(state) {
    if (fault.checkpointFailure === "encode") throw new Error("encode failed");
    return codec.encode(state);
  } }, "U-W": stringCodec("U-W") }, {
    clock, checkpointFileSystem: fs, diagnosticFileSystem: logs, runtimeCalls: driver.calls,
    shutdownHooks: { closeWorker: async () => { order.push("close"); }, ...hooks },
    onMeasurements: (batch) => measurements.push(...batch), reportFailure: (event) => events.push(event),
  });
  root.startRuntime("review", clock());
  const update = (state: RuntimeState, correlations: Parameters<typeof root.dispatch>[2] = {}) => driver.update(root, state, clock(), correlations);
  const scheduleCheckpoint = (state: RuntimeState, at: ReturnType<typeof clock>, runId: string,
    correlations: Parameters<typeof root.scheduleCheckpoint>[3]) => {
    update(state, correlations);
    return root.scheduleCheckpoint(root.state, at, runId, correlations);
  };
  return { root, update, scheduleCheckpoint, clock, setTime: (value: number) => { now = value; }, setWallOffset: (value: number) => { wallOffset = value; }, bytes, lines, fs, logs, fault,
    events, measurements, order, config };
}

function reserve(h: ReturnType<typeof harness>, state: RuntimeState): CheckpointRequest {
  const scheduled = h.scheduleCheckpoint(state, h.clock(), "review", { "U-F": ids, "U-W": ids });
  expect(scheduled?.request).not.toBeNull();
  return scheduled!.request!;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("R25 regression / AC02,AC05: raw result dispatch cannot bypass durability validation", async () => {
  const h = harness();
  const initial = dirty(1, true);
  const request = reserve(h, initial);
  const clock = h.clock();
  const fabricated = { kind: "acknowledged", unit: request.unit, generation: request.generation,
    attemptId: request.attemptId, encodedByteLength: request.encodedByteLength, ackAt: clock.wallTimeMs } as const;
  const input = { kind: "mailboxCompleted", clock, completion: {
    kind: "control", messageId: request.attemptId, runId: initial.runId, encodedByteLength: request.encodedByteLength,
    startedMonotonicMs: 0, completedMonotonicMs: 0, control: { kind: "checkpointResult", result: fabricated, clock },
  } } as const;
  expect(() => h.root.dispatch(initial, input)).toThrow("operation has not ended");
  expect(h.root.state.units["U-F"].persistence?.savedGeneration).toBeNull();
  expect(h.scheduleCheckpoint(initial, clock, "review", { "U-W": ids })).toBeNull();
  const output = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  const step = h.root.dispatch(initial, { ...input, completion: { ...input.completion,
    control: { ...input.completion.control, result: output.result } } });
  expect(step.state.units["U-F"].persistence?.kind).toBe("saved");
  expect(step.state.checkpointAttempts).toEqual({});
  expect(h.scheduleCheckpoint(initial, clock, "review", { "U-W": ids })?.request?.unit).toBe("U-W");
  await h.root.diagnostics.flush();
});

it("R26 regression / AC04: a rejected reducer call cannot consume the durable result or release its writer", async () => {
  const h = harness();
  const initial = dirty(1, true);
  const request = reserve(h, initial);
  const output = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  const reducer = vi.spyOn(sharedRuntime, "reduceRuntime").mockImplementationOnce(() => { throw new Error("reducer rejected"); });
  expect(() => h.root.applyCheckpointResult(initial, output.result, h.clock())).toThrow("reducer rejected");
  reducer.mockRestore();
  expect(h.scheduleCheckpoint(initial, h.clock(), "review", { "U-W": ids })).toBeNull();
  expect(h.root.state.checkpointAttempts["U-F"]?.attemptId).toBe(request.attemptId);
  expect(h.root.applyCheckpointResult(initial, output.result, h.clock()).state.units["U-F"].persistence?.kind).toBe("saved");
  expect(h.scheduleCheckpoint(initial, h.clock(), "review", { "U-W": ids })?.request?.unit).toBe("U-W");
  expect(h.fault.opens).toBe(1);
  expect(h.measurements.filter((measurement) => measurement.attemptId === request.attemptId)).toHaveLength(7);
  await h.root.diagnostics.flush();
});

it("R27 regression / AC04,AC05: failed capture retains its reservation until A1 adopts the result", async () => {
  for (const [stage, adoption] of [
    ["encode", "delayed"], ["open", "delayed"], ["write", "delayed"],
    ["fileSync", "delayed"], ["rename", "delayed"], ["write", "rejected"],
  ] as const) {
      const h = harness();
      h.fault.checkpointFailure = stage;
      const initial = dirty(1, true);
      const scheduled = h.scheduleCheckpoint(initial, h.clock(), "review", { "U-F": ids })!;
      const result = scheduled.result ?? (await h.root.executeCheckpoint(scheduled.request!,
        "review", ids.inputIds, "notRetry")).result;
      expect(result).toMatchObject({ kind: stage === "rename" ? "uncertain" : "failed",
        attemptId: scheduled.capture.attemptId, unit: "U-F", generation: 1,
        stage: stage === "open" ? "write" : stage });
      expect(h.root.state.checkpointAttempts["U-F"]).toMatchObject(scheduled.capture);
      h.fault.checkpointFailure = null; // A second capture would now be able to write g2.
      if (adoption === "rejected") {
        const reducer = vi.spyOn(sharedRuntime, "reduceRuntime")
          .mockImplementationOnce(() => { throw new Error("result rejected"); });
        expect(() => h.root.applyCheckpointResult(initial, result, h.clock())).toThrow("result rejected");
        reducer.mockRestore();
      }
      h.setTime(25);
      h.update(fixtureState({ "U-F": "final-2" }, {
        "U-F": { ...h.root.state.units["U-F"].persistence!, kind: "pending", currentGeneration: 2, dirtySince: 25 } }));
      const measured = [...h.measurements];
      expect(measured.every((entry) => entry.attemptId === scheduled.capture.attemptId
        && entry.unit === "U-F" && entry.generation === 1 && entry.runId === "review"
        && entry.inputIds.join() === ids.inputIds.join() && entry.retryReason === "notRetry")).toBe(true);
      for (const correlations of [{ "U-F": ids }, { "U-W": ids }, { "U-F": ids, "U-W": ids }]) {
        expect(h.scheduleCheckpoint(h.root.state, h.clock(), "review", correlations),
          `${stage}/${adoption}`).toBeNull();
      }
      expect(h.root.state.checkpointAttempts["U-F"]).toMatchObject({
        ...scheduled.capture, postCaptureDirtySince: 25,
      });
      expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
      expect(h.measurements).toEqual(measured);
      expect(h.fault.opens).toBe(stage === "encode" ? 0 : 1);
      h.root.applyCheckpointResult(h.root.state, result, h.clock());
      expect(h.root.state.units["U-F"].persistence?.currentGeneration).toBe(2);
      if (stage === "rename") {
        // A failed rename has no confirmed slot; reconciliation supplies the terminal failure.
        await h.root.resolveUncertain(h.root.state, "U-F", result.attemptId, h.clock());
      }
      expect(h.root.state.checkpointAttempts["U-F"]).toBeUndefined();
      expect(h.root.state.units["U-F"].persistence).toMatchObject({ kind: "failed", currentGeneration: 2 });
      const due = h.root.checkpoint.retryAfter("U-F")!;
      const retryReason = h.root.checkpoint.retryReason("U-F");
      expect(due).toBe(1_025);
      expect(retryReason).toBe(stage === "rename" ? "ackUncertain" : "saveFailed");
      const originalStages = stage === "encode" ? ["encode"] : stage === "fileSync"
        ? ["encode", "write", "fileSync"] : stage === "rename"
          ? ["encode", "write", "fileSync", "close", "rename", "verify"] : ["encode", "write"];
      expect(h.measurements.filter((entry) => entry.attemptId === result.attemptId).map((entry) => entry.stage))
        .toEqual(originalStages);
      if (stage !== "rename") {
        h.root.applyCheckpointResult(h.root.state, result, h.clock());
        expect(h.root.checkpoint.retryAfter("U-F")).toBe(due);
        expect(h.measurements).toEqual(measured);
      }
      const weather = h.scheduleCheckpoint(h.root.state, h.clock(), "review", {
        "U-F": { ...ids, retryReason }, "U-W": ids,
      })!.request!;
      expect(weather.unit).toBe("U-W");
      h.root.applyCheckpointResult(h.root.state,
        (await h.root.executeCheckpoint(weather, "review", ids.inputIds, "notRetry")).result, h.clock());
      expect(h.root.state.units["U-W"].persistence?.kind).toBe("saved");
      h.setTime(due - 1);
      expect(h.scheduleCheckpoint(h.root.state, h.clock(), "review", { "U-F": { ...ids, retryReason } })).toBeNull();
      h.setTime(due);
      const retry = h.scheduleCheckpoint(h.root.state, h.clock(), "review", { "U-F": { ...ids, retryReason } })!;
      expect(retry.capture).toMatchObject({ unit: "U-F", generation: 2 });
      expect(retry.capture.attemptId).not.toBe(result.attemptId);
      expect(h.root.state.checkpointAttempts["U-F"]).toMatchObject(retry.capture);
      h.root.applyCheckpointResult(h.root.state,
        (await h.root.executeCheckpoint(retry.request!, "review", ids.inputIds, retryReason)).result, h.clock());
      expect(h.root.state.units["U-F"].persistence).toMatchObject({ kind: "saved", currentGeneration: 2, savedGeneration: 2 });
      expect(h.root.state.checkpointAttempts).toEqual({});
      expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
      expect(h.measurements.filter((entry) => entry.stage === "encode")).toHaveLength(3);
      expect(h.measurements.filter((entry) => entry.attemptId === retry.capture.attemptId)).toHaveLength(7);
      await h.root.diagnostics.flush();
  }
});

it("R28 regression / AC04,AC06: shutdown recovers unadopted failures without an explicit result replay", async () => {
  for (const [stage, remaining] of [
    ["encode", true], ["open", true], ["write", true], ["fileSync", true], ["rename", true],
    ["write", false],
  ] as const) {
        const h = harness({ finalizeBatchesAndSideEffects: async () => {
          if (!remaining) h.setTime(50_000);
          return { batches: 0, notificationAttempts: 0 };
        } });
        h.fault.checkpointFailure = stage;
        const initial = dirty(1, true);
        const scheduled = h.scheduleCheckpoint(initial, h.clock(), "review", { "U-F": ids, "U-W": ids })!;
        const result = scheduled.result ?? (await h.root.executeCheckpoint(scheduled.request!,
          "review", ids.inputIds, "notRetry")).result;
        expect(result.kind).toBe(stage === "rename" ? "uncertain" : "failed");
        h.fault.checkpointFailure = null;
        const measured = [...h.measurements];
        const opens = h.fault.opens;
        h.setTime(20_000);
        expect(h.scheduleCheckpoint(h.root.state, h.clock(), "review", { "U-F": ids, "U-W": ids })).toBeNull();
        expect(h.root.state.checkpointAttempts["U-F"]).toMatchObject(scheduled.capture);
        expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
        const apply = vi.spyOn(h.root, "applyCheckpointResult");
        const summary = await h.root.shutdownRuntime(h.root.state, 1, h.clock());
        expect(summary.code, `${stage}/remaining=${remaining}`)
          .toBe(remaining ? stage === "rename" ? 2 : 0 : 3);
        expect(apply.mock.calls.filter(([, applied]) => applied.attemptId === result.attemptId))
          .toHaveLength(remaining ? 1 : 0);
        expect(h.measurements.filter((entry) => entry.attemptId === result.attemptId)).toEqual(measured);
        if (remaining) {
          expect(h.root.state.units["U-W"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
          expect(h.root.state.units["U-F"].persistence).toMatchObject(stage === "rename"
            ? { kind: "uncertain", savedGeneration: null } : { kind: "saved", savedGeneration: 1 });
          expect(h.fault.opens).toBe(opens + (stage === "rename" ? 1 : 2));
          expect(h.measurements.length).toBe(measured.length + (stage === "rename" ? 7 : stage === "encode" ? 14 : 13));
          expect(h.root.state.shutdown.stageResults.finalCheckpoint?.pending.unsavedUnits)
            .toBe(stage === "rename" ? 1 : 0);
          expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
          expect(h.order).toEqual(["summary", "close", "summary"]);
          if (stage !== "rename") {
            expect(h.root.state.checkpointAttempts).toEqual({});
            expect(h.root.restoreUnit("U-F")).toMatchObject({ kind: "restored", envelope: { generation: 1 } });
          }
          expect(h.root.restoreUnit("U-W")).toMatchObject({ kind: "restored", envelope: { generation: 1 } });
        } else {
          expect(h.fault.opens).toBe(opens);
          expect(h.measurements).toEqual(measured);
          expect(h.root.state.checkpointAttempts["U-F"]).toMatchObject(scheduled.capture);
          expect(h.root.state.units["U-W"].persistence?.savedGeneration).toBeNull();
          expect(h.root.state.shutdown.stageResults.finalCheckpoint).toMatchObject({
            result: { kind: "deadlineExceeded" }, pending: { unsavedUnits: 2 },
          });
          expect(h.order).toEqual([]);
        }
        apply.mockRestore();
        await h.root.diagnostics.flush();
  }
});

it("B01 contractBoundary / AC02,AC05: capture precedes post-capture dirty input and A1 owns the correlated ack", async () => {
  for (const outcome of ["acknowledged", "failed", "uncertain"] as const) {
    const reducer = vi.spyOn(sharedRuntime, "reduceRuntime");
    const h = harness();
    const initial = dirty(1, true);
    const request = reserve(h, initial);
    expect(reducer.mock.calls.at(-1)?.[1]).toMatchObject({ kind: "checkpointCaptured",
      capture: { attemptId: request.attemptId, unit: "U-F", generation: 1 } });
    expect(h.root.state.checkpointAttempts["U-F"]?.postCaptureDirtySince).toBeNull();
    h.setTime(500);
    h.update(fixtureState({ "U-F": "final-2" }, {
      "U-F": { ...h.root.state.units["U-F"].persistence!, kind: "pending", currentGeneration: 2, dirtySince: h.clock().monotonicMs } }));
    expect(h.root.state.checkpointAttempts["U-F"]?.postCaptureDirtySince).toBe(h.clock().monotonicMs);
    if (outcome === "failed") h.fault.checkpointFailure = "write";
    if (outcome === "uncertain") h.fault.directorySync = true;
    const output = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
    expect(output.result.kind).toBe(outcome);
    const step = h.root.applyCheckpointResult(initial, output.result, h.clock());
    expect(step).toBe(reducer.mock.results.at(-1)?.value);
    expect(step.state.units["U-F"].persistence?.currentGeneration).toBe(2);
    if (outcome === "uncertain") {
      h.fault.directorySync = false;
      await h.root.resolveUncertain(initial, "U-F", request.attemptId, h.clock());
    }
    if (outcome !== "failed") expect(h.root.state.units["U-F"].persistence).toMatchObject({
      kind: "pending", currentGeneration: 2, savedGeneration: 1, dirtySince: h.clock().monotonicMs,
      savedCapturedAt: request.capturedAt, savedAckAt: h.clock().wallTimeMs,
    });
    expect(h.root.state.checkpointAttempts["U-F"]).toBeUndefined();
    h.fault.checkpointFailure = null;
    const weather = h.scheduleCheckpoint(initial, h.clock(), "review", { "U-W": ids })!.request!;
    const written = await h.root.executeCheckpoint(weather, "review", ids.inputIds, "notRetry");
    h.root.applyCheckpointResult(initial, written.result, h.clock());
    expect(h.root.state.units["U-W"].persistence?.kind).toBe("saved");
    expect(h.root.state.units["U-F"].persistence?.currentGeneration).toBe(2);
    expect(h.root.state.checkpointAttempts).toEqual({});
    await h.root.diagnostics.flush();
    reducer.mockRestore();
  }
});

it("B02 contractBoundary / AC06: A1 retains all earlier stage failures when later stages run", async () => {
  const h = harness({
    drainMailbox: async () => { h.update(dirty(), { "U-F": ids }); throw new Error("private drain detail"); },
    finalizeBatchesAndSideEffects: async () => { throw new Error("private finalize detail"); },
    closeWorker: async () => { throw new Error("private close detail"); },
  });
  h.fault.checkpointFailure = "write";
  const summary = await h.root.shutdownRuntime(fixtureState(), 1, h.clock());
  expect(summary.code).toBe(3);
  expect(summary.reasons).toEqual([
    "mailboxDrain:failed:operationFailed",
    "sideEffectFinalization:failed:operationFailed", "sideEffectFinalization:remainingBatches",
    "sideEffectFinalization:unconfirmedNotifications", "finalCheckpoint:remainingBatches",
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
  const h = harness();
  const state = fixtureState();
  const drain = vi.spyOn(h.root.mailbox, "drainDiagnostics");
  for (let i = 0; i < 200; i += 1) h.root.mailbox.enqueue({
    messageId: String(i), runId: state.runId, t0MonotonicMs: 0, enqueuedMonotonicMs: 0, priorityReason: "control",
    payload: { kind: "control", control: { kind: "shutdownRequested", acceptedThroughSequence: i, clock: h.clock() } },
  });
  for (let second = 0; second <= 6; second += 1) {
    h.setTime(second * 1_000);
    h.root.tick(state, h.clock());
    h.root.tick(state, h.clock());
    h.root.tick(state, { ...h.clock(), monotonicMs: second * 1_000 + 999 });
  }
  expect(drain).toHaveBeenCalledTimes(7);
  const records = (await h.root.readDiagnostics({ limit: 256 })).records;
  expect(records.filter((event) => event.reason === "diagnosticQueueOverflow")).toHaveLength(1);
  expect(records.filter((event) => event.reason === "mailboxStalled")).toEqual([
    expect.objectContaining({ component: "mailbox", timestamp: 1_800_000_005_000, runId: state.runId, durationMs: 5_000 }),
    expect.objectContaining({ component: "mailbox.worker", timestamp: 1_800_000_005_000, runId: state.runId, durationMs: 5_000 }),
  ]);
  expect(records.every((event) => event.runId === state.runId)).toBe(true);
});

it("B04 contractBoundary / AC06: a final-summary-only failure cannot return unconfirmed success", async () => {
  const h = harness();
  let summaries = 0;
  h.fault.onSummary = () => { if (++summaries === 2) h.fault.rewriteFailure = "write"; };
  await expect(h.root.shutdownRuntime(fixtureState(), 1, h.clock()))
    .rejects.toThrow("final shutdown summary could not be persisted");
  expect(h.order).toEqual(["summary", "close", "summary"]);
  expect(h.root.state.shutdown.stage).toBe("completed");
  // The A1 terminal observation is not rewritten by A3 after a persistence error.
  expect(h.root.state.shutdown.stageResults.workerClose?.result.kind).toBe("completed");
  expect(h.events.filter((event) => event.reason === "diagnosticSinkFailed")).toHaveLength(1);
  expect([...h.lines.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
});

it("R01 regression / AC02,AC08: uncertain needs exact hash and successful sync; post-rename verify failure stays uncertain", async () => {
  const h = harness();
  let state = dirty();
  const request = reserve(h, state);
  h.fault.directorySync = true;
  const executed = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  state = h.root.applyCheckpointResult(state, executed.result, h.clock()).state;
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence).toMatchObject({ kind: "uncertain", savedGeneration: null });
  h.fault.directorySync = false;
  const path = [...h.bytes.keys()][0];
  h.bytes.set(path, serializedEnvelope(hashEnvelope({ ...request.envelope, payload: "different payload" })));
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence).toMatchObject({ kind: "failed", savedGeneration: null });

  const verify = harness();
  const r = reserve(verify, dirty());
  verify.fault.verify = true;
  const result = await verify.root.executeCheckpoint(r, "review", ids.inputIds, "notRetry");
  expect(result.result.kind).toBe("uncertain");
  let verifiedState = verify.root.applyCheckpointResult(dirty(), result.result, verify.clock()).state;
  verify.fault.verify = false;
  verifiedState = (await verify.root.resolveUncertain(verifiedState, "U-F", r.attemptId, verify.clock())).state;
  expect(verifiedState.units["U-F"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
  await Promise.all([h.root.diagnostics.flush(), verify.root.diagnostics.flush()]);
});

it("R02 regression / AC04: a running attempt cannot execute twice or relinquish its writer on uncertainty", async () => {
  const h = harness();
  const gate = deferred();
  h.fault.writeGate = gate.promise;
  let state = dirty(1, true);
  const request = reserve(h, state);
  const running = h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  await expect(h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry")).rejects.toThrow(/already executed/);
  state = h.root.applyCheckpointResult(state, { kind: "uncertain", attemptId: request.attemptId,
    unit: request.unit, generation: request.generation, observedAt: h.clock().wallTimeMs,
    stage: "ack", encodedByteLength: request.encodedByteLength }, h.clock()).state;
  expect(h.scheduleCheckpoint(state, h.clock(), "review", { "U-W": ids })).toBeNull();
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence?.kind).toBe("uncertain");
  expect(h.fault.opens).toBe(1);
  gate.resolve();
  await running; // Simulate lost acknowledgement, not a stopped writer.
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence?.kind).toBe("saved");
  expect(h.scheduleCheckpoint(state, h.clock(), "review", { "U-W": ids })?.request?.unit).toBe("U-W");
  expect(h.fault.opens).toBe(1);
  await h.root.diagnostics.flush();
});

it("R03 regression / AC08: a BOM cannot be stripped before the full-byte hash check", async () => {
  const h = harness();
  const request = reserve(h, dirty());
  await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  expect(h.root.restoreUnit("U-F").kind).toBe("restored");
  const path = [...h.bytes.keys()][0];
  const original = h.bytes.get(path)!;
  h.bytes.set(path, Uint8Array.from([0xef, 0xbb, 0xbf, ...original]));
  expect(h.root.restoreUnit("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
  await h.root.diagnostics.flush();
});

it("R04 regression / AC04,AC05: slot EIO returns measured failure and frees the writer for U-W", async () => {
  const h = harness();
  let state = dirty(1, true);
  const request = reserve(h, state);
  h.fault.read = true;
  const failed = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  expect(failed).toMatchObject({ result: { kind: "failed", stage: "write" },
    measurements: [{ stage: "write", outcome: "failed", attemptId: request.attemptId }] });
  state = h.root.applyCheckpointResult(state, failed.result, h.clock()).state;
  expect(h.root.checkpoint.retryAfter("U-F")).toBe(1_000);
  h.fault.read = false;
  const next = h.scheduleCheckpoint(state, h.clock(), "review", { "U-W": ids })!;
  expect(next.request?.unit).toBe("U-W");
  const written = await h.root.executeCheckpoint(next.request!, "review", ids.inputIds, "notRetry");
  expect(h.root.applyCheckpointResult(state, written.result, h.clock()).state.units["U-W"].persistence?.kind).toBe("saved");
  await h.root.diagnostics.flush();
});

it("R05 regression / AC04,AC07: argument clocks monitor an occupied writer without unlocking it", async () => {
  const h = harness();
  const gate = deferred();
  h.fault.writeGate = gate.promise;
  const state = dirty(1, true);
  const request = reserve(h, state);
  const running = h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  h.setTime(20_001);
  expect(h.scheduleCheckpoint(state, h.clock(), "review", { "U-F": ids, "U-W": ids })).toBeNull();
  expect(h.scheduleCheckpoint(state, h.clock(), "review", { "U-F": ids, "U-W": ids })).toBeNull();
  const read = await h.root.readDiagnostics({ limit: 256 });
  expect(read.records.filter((event) => event.reason === "checkpointOverdue")).toHaveLength(2);
  expect(read.records.filter((event) => event.reason === "checkpointUncertain"))
    .toEqual([expect.objectContaining({ attemptId: request.attemptId, durationMs: 20_001 })]);
  expect(h.fault.opens).toBe(1);
  gate.resolve();
  await running;
});

it("R06 regression / AC06: drain and finalize states become the actual final checkpoint, not the starting copy", async () => {
  const reducer = vi.spyOn(sharedRuntime, "reduceRuntime");
  const h = harness({
    drainMailbox: async () => { h.update(dirty(1), { "U-F": ids }); },
    finalizeBatchesAndSideEffects: async () => {
      expect(h.root.state.units["U-F"].persistence?.currentGeneration).toBe(1);
      h.update(dirty(2));
      return { batches: 0, notificationAttempts: 0 };
    },
  });
  const summary = await h.root.shutdownRuntime(fixtureState(), 2, h.clock());
  expect(summary).toMatchObject({ code: 0, persistence: { "U-F": { kind: "saved", currentGeneration: 2, savedGeneration: 2 } } });
  expect(h.root.restoreUnit("U-F")).toMatchObject({ envelope: { generation: 2, payload: "final-2" } });
  expect(h.order).toEqual(["summary", "close", "summary"]);
  const ackCall = reducer.mock.calls.find(([, input]) => input.kind === "mailboxCompleted"
    && input.completion.kind === "control" && input.completion.control.kind === "checkpointResult");
  expect(ackCall?.[0]?.units["U-F"].persistence).toMatchObject({ currentGeneration: 2, savedGeneration: null });
  expect(reducer.mock.calls.find(([state]) => state != null)?.[0]?.shutdown.stage).toBe("running");
  const missing = harness({ drainMailbox: async () => { missing.update(dirty()); } });
  expect(await missing.root.shutdownRuntime(fixtureState(), 2, missing.clock()))
    .toMatchObject({ code: 0, persistence: { "U-F": { savedGeneration: 1 } } });
});

it("R07 regression / AC06: deadlines bound summary and forbid another unit write after a late ack", async () => {
  vi.useFakeTimers();
  const gate = deferred();
  const entered = deferred();
  const h = harness({ drainMailbox: async () => { h.update(dirty(1, true), { "U-F": ids, "U-W": ids }); } });
  h.fault.writeGate = gate.promise;
  h.fault.onOpen = entered.resolve;
  const shutdown = h.root.shutdownRuntime(fixtureState(), 1, h.clock());
  await entered.promise;
  h.setTime(10_000);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await shutdown).toMatchObject({ code: 2, reasons: expect.arrayContaining(["finalCheckpoint:deadlineExceeded"]) });
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.fault.opens).toBe(1);

  const summaryGate = deferred();
  const summaryEntered = deferred();
  const s = harness();
  s.fault.summaryGate = summaryGate.promise;
  s.fault.onSummary = summaryEntered.resolve;
  const blocked = s.root.shutdownRuntime(fixtureState(), 1, s.clock());
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
  const h = harness({ drainMailbox: async () => { h.update(dirty(4), { "U-F": ids }); } });
  expect((await h.root.shutdownRuntime(fixtureState(), 1, h.clock())).code).toBe(0);
  expect(h.measurements.map((m) => m.stage)).toEqual(["encode", "write", "fileSync", "close", "rename", "directorySync", "verify"]);
  expect(new Set(h.measurements.map((m) => m.attemptId)).size).toBe(1);
  expect(h.measurements.every((m) => m.runId === "review" && m.unit === "U-F" && m.generation === 4
    && m.inputIds.join() === ids.inputIds.join() && m.retryReason === "notRetry")).toBe(true);
  expect(h.measurements[0].bytes).toBeGreaterThan(0);
});

it("R09 regression / AC02,AC06: reconciliation uses the shared retry reason and shutdown retries after lost data", async () => {
  const h = harness();
  let state = dirty();
  const request = reserve(h, state);
  h.fault.directorySync = true;
  const executed = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  state = h.root.applyCheckpointResult(state, executed.result, h.clock()).state;
  h.bytes.clear();
  h.fault.directorySync = false;
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(h.root.checkpoint.retryReason("U-F")).toBe("ackUncertain");
  const summary = await h.root.shutdownRuntime(state, 1, h.clock());
  expect(summary).toMatchObject({ code: 0, persistence: { "U-F": { kind: "saved" } } });
  expect(h.measurements.filter((m) => m.attemptId !== request.attemptId).every((m) => m.retryReason === "ackUncertain")).toBe(true);
});

it("R10 regression / AC07: sink exceptions expose only completed fixed diagnostics, never secrets or recursive writes", async () => {
  const h = harness();
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
  const h = harness();
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

it("R13 regression / AC06: shutdown waits for a normal in-flight write and re-evaluates the final generation", async () => {
  vi.useFakeTimers();
  for (const finalGeneration of [1, 2]) {
    const h = harness({ finalizeBatchesAndSideEffects: async () => {
      h.update(dirty(finalGeneration), { "U-F": ids });
      return { batches: 0, notificationAttempts: 0 };
    } });
    const gate = deferred();
    const entered = deferred();
    h.fault.writeGate = gate.promise;
    h.fault.onOpen = entered.resolve;
    const initial = dirty();
    const request = reserve(h, initial);
    const normal = h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
    await entered.promise;
    let finished = false;
    const stopping = h.root.shutdownRuntime(initial, 1, h.clock()).then((summary) => { finished = true; return summary; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(h.order).toEqual([]);
    expect(h.fault.opens).toBe(1);
    h.setTime(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).toBe(false);
    gate.resolve();
    const executed = await normal;
    h.root.applyCheckpointResult(initial, executed.result, h.clock());
    expect(await stopping).toMatchObject({ code: 0, persistence: { "U-F": {
      currentGeneration: finalGeneration, savedGeneration: finalGeneration, kind: "saved",
    } } });
    expect(h.root.restoreUnit("U-F")).toMatchObject({ envelope: { generation: finalGeneration, payload: `final-${finalGeneration}` } });
    expect(h.fault.opens).toBe(finalGeneration);
    expect(h.order).toEqual(["summary", "close", "summary"]);
    expect(h.measurements.filter((measurement) => measurement.attemptId === request.attemptId)).toHaveLength(7);
  }
  const late = harness({ finalizeBatchesAndSideEffects: async () => {
    late.update(dirty(2), { "U-F": ids });
    return { batches: 0, notificationAttempts: 0 };
  } });
  const gate = deferred();
  const entered = deferred();
  late.fault.writeGate = gate.promise;
  late.fault.onOpen = entered.resolve;
  const request = reserve(late, dirty());
  const normal = late.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  await entered.promise;
  const stopping = late.root.shutdownRuntime(dirty(), 1, late.clock());
  await vi.advanceTimersByTimeAsync(0);
  late.setTime(10_000);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await stopping).toMatchObject({ code: 2, reasons: expect.arrayContaining(["finalCheckpoint:deadlineExceeded"]) });
  gate.resolve();
  await normal;
  await vi.advanceTimersByTimeAsync(0);
  expect(late.fault.opens).toBe(1); // The late g1 ack must not start a g2 write after the deadline.
});

it("R14 regression / AC04: ended reconciliation failures retain uncertainty but back off 1/2/4/8/10 seconds", async () => {
  const h = harness();
  let state = dirty(1, true);
  const request = reserve(h, state);
  h.fault.directorySync = true;
  const written = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  state = h.root.applyCheckpointResult(state, written.result, h.clock()).state;
  for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
    state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
    const due = h.root.checkpoint.retryAfter("U-F")!;
    expect(due).toBe(h.clock().monotonicMs + delay);
    expect(state.units["U-F"].persistence).toMatchObject({ kind: "uncertain", savedGeneration: null });
    const syncs = h.fault.syncs;
    const measurements = h.measurements.length;
    for (let repeat = 0; repeat < 3; repeat += 1)
      state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
    h.setTime(due - 1);
    state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
    expect(h.fault.syncs).toBe(syncs);
    expect(h.measurements).toHaveLength(measurements);
    expect(h.root.checkpoint.retryAfter("U-F")).toBe(due);
    h.setTime(due);
  }
  h.fault.directorySync = false;
  const weather = h.scheduleCheckpoint(state, h.clock(), "weather", { "U-W": ids })!.request!;
  const saved = await h.root.executeCheckpoint(weather, "weather", ids.inputIds, "notRetry");
  state = h.root.applyCheckpointResult(state, saved.result, h.clock()).state;
  expect(state.units["U-W"].persistence?.kind).toBe("saved");
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence?.kind).toBe("saved");
  expect(h.root.checkpoint.retryAfter("U-F")).toBeNull();
  await h.root.diagnostics.flush();
});

it("R15 regression / AC05: reconciliation stages are measured once with the original attempt correlation", async () => {
  const h = harness();
  let state = dirty();
  const request = reserve(h, state);
  h.fault.directorySync = true;
  const written = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  state = h.root.applyCheckpointResult(state, written.result, h.clock()).state;
  const before = h.measurements.length;
  const verifies = vi.spyOn(h.root.checkpoint, "restoreUnit");
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  for (let repeat = 0; repeat < 3; repeat += 1)
    state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(h.measurements.slice(before).map((measurement) => [measurement.stage, measurement.outcome]))
    .toEqual([["verify", "succeeded"], ["directorySync", "failed"]]);
  h.fault.directorySync = false;
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence?.kind).toBe("saved");
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

it("R16 contractBoundary / AC07: queue repetitions stay daily, flushes append, and retention removes whole files", async () => {
  const h = harness();
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

it("R17 regression / AC04,AC06: another unit's completed result survives reconciliation until explicit or shutdown application", async () => {
  for (const outcome of ["acknowledged", "failed", "uncertain"] as const) {
    for (const application of ["explicit", "shutdown"] as const) {
      const h = harness();
      let state = dirty(1, true);
      const fire = reserve(h, state);
      h.fault.directorySync = true;
      state = h.root.applyCheckpointResult(state,
        (await h.root.executeCheckpoint(fire, "review", ids.inputIds, "notRetry")).result, h.clock()).state;
      state = (await h.root.resolveUncertain(state, "U-F", fire.attemptId, h.clock())).state;
      h.fault.directorySync = outcome === "uncertain";
      h.fault.checkpointFailure = outcome === "failed" ? "write" : null;
      const weather = h.scheduleCheckpoint(state, h.clock(), "weather", { "U-W": ids })!.request!;
      const gate = deferred();
      h.fault.writeGate = gate.promise;
      const running = h.root.executeCheckpoint(weather, "weather", ids.inputIds, "notRetry");
      state = h.root.state; // checkpointCaptured is itself an A1 state transition.
      expect((await h.root.resolveUncertain(state, "U-F", fire.attemptId, h.clock())).state).toBe(state);
      gate.resolve();
      const ended = await running;
      expect(ended.result.kind).toBe(outcome);
      const measured = h.measurements.length;
      for (const time of [0, 0, 20_000]) {
        h.setTime(time);
        state = (await h.root.resolveUncertain(state, "U-F", fire.attemptId, h.clock())).state;
        expect(h.scheduleCheckpoint(state, h.clock(), "review", { "U-W": ids })).toBeNull();
      }
      expect(h.measurements).toHaveLength(measured);
      h.fault.directorySync = false;
      h.fault.checkpointFailure = null;
      if (application === "explicit") {
        state = h.root.applyCheckpointResult(state, ended.result, h.clock()).state;
        state = (await h.root.resolveUncertain(state, "U-F", fire.attemptId, h.clock())).state;
        if (outcome === "uncertain")
          state = (await h.root.resolveUncertain(state, "U-W", weather.attemptId, h.clock())).state;
      }
      const summary = await h.root.shutdownRuntime(state, 1, h.clock());
      expect(summary.persistence["U-W"]?.kind).toBe(application === "shutdown" && outcome === "uncertain" ? "uncertain" : "saved");
      expect(summary.code).toBe(application === "shutdown" ? 2 : 0);
      expect(h.measurements.filter((measurement) => measurement.attemptId === weather.attemptId && measurement.stage === "write"))
        .toHaveLength(1);
      expect(h.order).toEqual(["summary", "close", "summary"]);
    }
  }
});

it("R18 regression / AC07: shutdown-summary tmp is still reclaimed on restart and counted while unlink fails", async () => {
  {
    const h = harness();
    await h.root.diagnostics.flush();
    const temporary = join(h.config.diagnosticDirectory, "shutdown-summary.json.tmp");
    h.fault.rewriteFailure = "rename";
    h.fault.unlink = true;
    expect((await h.root.shutdownRuntime(fixtureState(), 1, h.clock())).code).toBe(4);
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
  const h = harness();
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

it("I01 contractBoundary / AC04,AC05,AC08: checkpoint fault stages cross recovery, restart and repeated failures", async () => {
  for (const [stage, mode] of [
    ...(["open", "write", "fileSync", "close", "rename", "directorySync", "readFile", "verify"] as const)
      .map((stage) => [stage, "retry"] as const),
    ["close", "restart"], ["rename", "restart"], ["directorySync", "restart"], ["verify", "restart"],
    ["write", "continuous"], ["fileSync", "continuous"], ["readFile", "continuous"], ["verify", "continuous"],
  ] as const) {
      const h = harness();
      let state = dirty(1, true);
      const original = reserve(h, state);
      state = h.root.applyCheckpointResult(state,
        (await h.root.executeCheckpoint(original, "review", ids.inputIds, "notRetry")).result, h.clock()).state;
      state = h.update(fixtureState({ "U-F": "final-2" }, {
        "U-F": { ...state.units["U-F"].persistence!, kind: "pending", currentGeneration: 2, dirtySince: 0 } }));
      const setFault = (active: boolean) => {
        h.fault.checkpointFailure = active && ["open", "write", "fileSync", "close", "rename"].includes(stage)
          ? stage as "open" | "write" | "fileSync" | "close" | "rename" : null;
        h.fault.directorySync = active && stage === "directorySync";
        h.fault.read = active && stage === "readFile";
        h.fault.verify = active && stage === "verify";
        h.fault.renamed = false;
        h.fault.onDirectorySync = () => { if (active && stage === "verify") h.fault.renamed = true; };
      };
      const rounds = mode === "continuous" ? 3 : 1;
      for (let index = 0; index < rounds; index += 1) {
        const request = h.scheduleCheckpoint(state, h.clock(), "failure", {
          "U-F": { ...ids, retryReason: h.root.checkpoint.retryReason("U-F") },
        })!.request!;
        setFault(true);
        const output = await h.root.executeCheckpoint(request, "failure", ids.inputIds, h.root.checkpoint.retryReason("U-F"));
        expect(output.result.kind).toBe(["rename", "directorySync", "verify"].includes(stage) ? "uncertain" : "failed");
        expect(output.measurements.filter((measurement) => measurement.outcome === "failed")).toHaveLength(1);
        expect(output.measurements.every((measurement) => measurement.attemptId === request.attemptId
          && measurement.unit === "U-F" && measurement.generation === 2)).toBe(true);
        state = h.root.applyCheckpointResult(state, output.result, h.clock()).state;
        if (mode === "continuous" && output.result.kind === "uncertain") {
          // A missing/unreadable target turns reconciliation into a completed verify failure.
          h.fault.read = true;
          state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
        }
        setFault(false);
        expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp")).length).toBeLessThanOrEqual(1);
        if (index < rounds - 1) h.setTime(h.root.checkpoint.retryAfter("U-F")!);
      }
      setFault(false);
      const restore = h.root.restoreUnit("U-F");
      expect(restore, `${stage}/${mode}`).toMatchObject({ kind: "restored", envelope: {
        generation: ["directorySync", "verify"].includes(stage) ? 2 : 1,
      } });
      if (mode === "restart") {
        await h.root.diagnostics.flush();
        const driver = fixtureDriver();
        const restarted = new RuntimeCompositionRoot(h.config, { "U-F": codec, "U-W": stringCodec("U-W") }, {
          clock: h.clock, checkpointFileSystem: h.fs, diagnosticFileSystem: h.logs, reportFailure: () => {},
          runtimeCalls: driver.calls,
        });
        expect(restarted.restoreUnit("U-F")).toEqual(restore);
        const restored = restarted.startRuntime("review", h.clock()).state;
        const desired = dirty(3, true);
        const continued = driver.update(restarted, { ...desired, units: { ...desired.units,
          "U-F": { ...desired.units["U-F"], persistence: { ...restored.units["U-F"].persistence,
            kind: "pending", currentGeneration: 3, dirtySince: 0 } },
        } }, h.clock(), { "U-F": ids, "U-W": ids });
        expect(restarted.scheduleCheckpoint(continued, h.clock(), "restart", { "U-F": ids })?.request?.unit).toBe("U-F");
        await restarted.diagnostics.flush();
      } else {
        // The failing unit cannot block a healthy unit after its result was applied.
        const weather = h.scheduleCheckpoint(state, h.clock(), "weather", { "U-W": ids })!.request!;
        const saved = await h.root.executeCheckpoint(weather, "weather", ids.inputIds, "notRetry");
        state = h.root.applyCheckpointResult(state, saved.result, h.clock()).state;
        expect(state.units["U-W"].persistence?.kind).toBe("saved");
        if (state.units["U-F"].persistence?.kind === "uncertain") {
          const attempt = h.measurements.filter((measurement) => measurement.unit === "U-F").at(-1)!.attemptId;
          state = (await h.root.resolveUncertain(state, "U-F", attempt, h.clock())).state;
        }
        if (state.units["U-F"].persistence?.kind !== "saved") {
          h.setTime(h.root.checkpoint.retryAfter("U-F")!);
          const retryReason = h.root.checkpoint.retryReason("U-F");
          const request = h.scheduleCheckpoint(state, h.clock(), "recovery", { "U-F": { ...ids, retryReason } })!.request!;
          state = h.root.applyCheckpointResult(state,
            (await h.root.executeCheckpoint(request, "recovery", ids.inputIds, retryReason)).result, h.clock()).state;
        }
        expect(state.units["U-F"].persistence).toMatchObject({ kind: "saved", savedGeneration: 2 });
        expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
      }
      await h.root.diagnostics.flush();
  }
});

it("I02 contractBoundary / AC04,AC06: held reconciliation excludes other writes and shutdown shares its acknowledgement", async () => {
  vi.useFakeTimers();
  for (const failed of [false, true]) {
    const h = harness();
    let state = dirty(1, true);
    const request = reserve(h, state);
    h.fault.directorySync = true;
    state = h.root.applyCheckpointResult(state,
      (await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry")).result, h.clock()).state;
    h.fault.directorySync = failed;
    const gate = deferred();
    h.fault.syncGate = gate.promise;
    const reconciliation = h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock());
    expect(h.scheduleCheckpoint(state, h.clock(), "weather", { "U-W": ids })).toBeNull();
    expect((await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state).toBe(state);
    const stopped = h.root.shutdownRuntime(state, 1, h.clock());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.order).toEqual([]);
    expect(h.fault.opens).toBe(1);
    gate.resolve();
    await reconciliation;
    const summary = await stopped;
    expect(summary.code).toBe(failed ? 2 : 0);
    expect(summary.persistence["U-F"]?.kind).toBe(failed ? "uncertain" : "saved");
    expect(h.fault.opens).toBe(2);
    expect(h.measurements.filter((measurement) => measurement.stage === "directorySync")).toHaveLength(h.fault.syncs);
    expect(h.order).toEqual(["summary", "close", "summary"]);
  }
});

it("R19 regression / AC08: retrying the same generation preserves the preceding slot instead of creating conflicting twins", async () => {
  const h = harness();
  let state = dirty();
  const first = reserve(h, state);
  state = h.root.applyCheckpointResult(state,
    (await h.root.executeCheckpoint(first, "review", ids.inputIds, "notRetry")).result, h.clock()).state;
  state = h.update(fixtureState({ "U-F": "final-2" }, { "U-F": { ...state.units["U-F"].persistence!, kind: "pending", currentGeneration: 2, dirtySince: 0 } }));
  const second = reserve(h, state);
  h.fault.directorySync = true;
  state = h.root.applyCheckpointResult(state,
    (await h.root.executeCheckpoint(second, "review", ids.inputIds, "notRetry")).result, h.clock()).state;
  h.fault.read = true;
  state = (await h.root.resolveUncertain(state, "U-F", second.attemptId, h.clock())).state;
  h.fault.read = false;
  h.fault.directorySync = false;
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  const retryReason = h.root.checkpoint.retryReason("U-F");
  const retry = h.scheduleCheckpoint(state, h.clock(), "retry", { "U-F": { ...ids, retryReason } })!.request!;
  expect(retry.envelope).toBe(second.envelope);
  expect(retry.capturedAt).toBe(second.capturedAt);
  const opens = h.fault.opens;
  state = h.root.applyCheckpointResult(state,
    (await h.root.executeCheckpoint(retry, "retry", ids.inputIds, retryReason)).result, h.clock()).state;
  expect(state.units["U-F"].persistence?.kind).toBe("saved");
  expect(h.fault.opens).toBe(opens);
  expect(h.measurements.filter((entry) => entry.attemptId === retry.attemptId).map((entry) => entry.stage))
    .toEqual(["directorySync", "verify"]);
  expect([...h.bytes.values()].map((bytes) => JSON.parse(new TextDecoder().decode(bytes)).generation).sort()).toEqual([1, 2]);
  expect(h.root.restoreUnit("U-F")).toMatchObject({ kind: "restored", envelope: { generation: 2 } });
  await h.root.diagnostics.flush();
});

it("P2-A3-T10 contractBoundary / AC10: a later explicit empty step cannot fill an earlier missing attribution", async () => {
  const h = harness();
  const reduce = sharedRuntime.reduceRuntime;
  const fault = vi.spyOn(sharedRuntime, "reduceRuntime");
  fault.mockImplementationOnce((...args) => ({ ...reduce(...args), generationInputIds: {} }));
  h.update(dirty(1));
  fault.mockImplementationOnce((...args) => ({ ...reduce(...args), generationInputIds: { "U-F": [] } }));
  h.update(dirty(2));
  fault.mockRestore();
  expect(() => h.root.scheduleCheckpoint(h.root.state, h.clock(), "review", { "U-F": {
    inputIds: [], retryReason: "notRetry",
  } })).toThrow("unverified checkpoint correlation");
  expect((await h.root.shutdownRuntime(h.root.state, 2, h.clock())).code).toBe(2);
  expect(h.fault.opens).toBe(0);
});

it("P2-A3-T09 contractBoundary / AC09: an identical durable generation is acknowledged without rewriting a slot", async () => {
  const h = harness();
  const request = reserve(h, dirty());
  const slot = join(h.config.stateDirectory, "U-F-A.json");
  const bytes = serializedEnvelope(request.envelope);
  h.bytes.set(slot, bytes);
  const result = await h.root.executeCheckpoint(request, "review", ids.inputIds, ids.retryReason);
  expect(result.result.kind).toBe("acknowledged");
  expect(h.fault.opens).toBe(0);
  expect(h.fault.syncs).toBe(1);
  expect(h.bytes.get(slot)).toEqual(bytes);
  await h.root.diagnostics.flush();
});

it("I03 contractBoundary / AC08: restart selects only valid slots and never restores an orphan checkpoint tmp", async () => {
  for (const scenario of ["empty", "tmp", "leftBroken", "rightBroken", "bothBroken", "schema", "conflict", "payload"] as const) {
    const h = harness();
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
    const restarted = new RuntimeCompositionRoot(h.config, { "U-F": codec }, {
      clock: h.clock, checkpointFileSystem: h.fs, diagnosticFileSystem: h.logs, reportFailure: () => {},
    });
    const restored = restarted.restoreUnit("U-F");
    expect(restored, scenario).toMatchObject(scenario === "empty" || scenario === "tmp" ? { kind: "empty" }
      : scenario === "bothBroken" || scenario === "schema" || scenario === "conflict" ? { kind: "unavailable" }
        : { kind: "restored", envelope: { generation: scenario === "leftBroken" ? 2 : 1 } });
    await restarted.diagnostics.flush();
  }
});

it("R20 regression / AC08: a later rejected restoration cannot expose a previously decoded state", async () => {
  const h = harness();
  const request = reserve(h, dirty());
  const output = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  h.root.applyCheckpointResult(dirty(), output.result, h.clock());
  const restored = h.root.restoreUnit("U-F");
  expect(restored.kind).toBe("restored");
  if (restored.kind !== "restored") throw new Error("checkpoint not restored");
  expect(codec.decode(restored.envelope.payload)).toMatchObject({ kind: "restored", state: { value: "final-1" } });
  h.bytes.set([...h.bytes.keys()][0], new TextEncoder().encode("corrupt"));
  expect(h.root.restoreUnit("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
  await h.root.diagnostics.flush();
});

it("R21 regression / AC08: startup read EIO returns unavailable and recovers after the adapter is released", async () => {
  const h = harness();
  h.fault.read = true;
  for (let repeat = 0; repeat < 3; repeat += 1)
    expect(h.root.restoreUnit("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
  h.fault.read = false;
  expect(h.root.restoreUnit("U-F")).toEqual({ kind: "empty" });
  const request = reserve(h, dirty());
  expect((await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry")).result.kind).toBe("acknowledged");
  expect(h.root.restoreUnit("U-F").kind).toBe("restored");
  await h.root.diagnostics.flush();
});

it("I04 contractBoundary / AC07: append, daily unlink and query read failures recover on restart without admitting cut lines", async () => {
  for (const stage of ["append", "unlink", "readFile"] as const) {
    const h = harness();
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

it("R22 regression / AC04,AC06: reconciliation consumes its own retained durable ack instead of discarding it and doing new I/O", async () => {
  const h = harness();
  const gate = deferred();
  h.fault.writeGate = gate.promise;
  let state = dirty();
  const request = reserve(h, state);
  const executing = h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  state = h.root.applyCheckpointResult(state, { kind: "uncertain", unit: "U-F", generation: 1,
    attemptId: request.attemptId, observedAt: h.clock().wallTimeMs, stage: "ack", encodedByteLength: request.encodedByteLength }, h.clock()).state;
  gate.resolve();
  expect((await executing).result.kind).toBe("acknowledged");
  h.fault.read = true;
  const measured = h.measurements.length;
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence?.kind).toBe("saved");
  expect(h.measurements).toHaveLength(measured);
  expect((await h.root.shutdownRuntime(state, 1, h.clock())).code).toBe(0);
});

it("R23 regression / AC06: normal scheduling cannot introduce a new dirty generation after shutdown finalization", async () => {
  const entered = deferred();
  const gate = deferred();
  const h = harness({ drainMailbox: async () => { h.update(dirty(), { "U-F": ids }); } });
  h.fault.onSummary = entered.resolve;
  h.fault.summaryGate = gate.promise;
  const stopping = h.root.shutdownRuntime(fixtureState(), 1, h.clock());
  await entered.promise;
  expect(h.scheduleCheckpoint(dirty(99), h.clock(), "late", { "U-F": ids })).toBeNull();
  gate.resolve();
  expect(await stopping).toMatchObject({ code: 0, persistence: { "U-F": { currentGeneration: 1, savedGeneration: 1 } } });
  expect(h.measurements.filter((measurement) => measurement.stage === "encode")).toHaveLength(1);
  expect(h.fault.opens).toBe(1);
  const reserved = harness();
  const request = reserve(reserved, dirty());
  expect((await reserved.root.shutdownRuntime(dirty(), 1, reserved.clock())).code).toBe(2);
  await expect(reserved.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry")).rejects.toThrow("worker is stopping");
  expect(reserved.fault.opens).toBe(0);
  const uncertain = harness();
  const pending = reserve(uncertain, dirty());
  uncertain.fault.directorySync = true;
  const state = uncertain.root.applyCheckpointResult(dirty(),
    (await uncertain.root.executeCheckpoint(pending, "review", ids.inputIds, "notRetry")).result, uncertain.clock()).state;
  expect((await uncertain.root.shutdownRuntime(state, 1, uncertain.clock())).code).toBe(2);
  uncertain.fault.directorySync = false;
  const syncs = uncertain.fault.syncs;
  expect((await uncertain.root.resolveUncertain(state, "U-F", pending.attemptId, uncertain.clock())).state.units["U-F"].persistence?.kind)
    .toBe("uncertain");
  expect(uncertain.fault.syncs).toBe(syncs);
});

it("I05 contractBoundary / AC06: each shutdown stage respects faults, deadline edges and dirty-state handoff", async () => {
  vi.useFakeTimers();
  const reducer = vi.spyOn(sharedRuntime, "reduceRuntime");
  for (const stage of ["drain", "finalize", "save", "summary"] as const) {
    for (const mode of ["failure", "within", "timeout", "clockJump", "overallJump"] as const) {
      const gate = deferred();
      const entered = deferred();
      const limit = stage === "drain" || stage === "save" ? 10_000 : 5_000;
      const pause = async () => { entered.resolve(); await gate.promise; if (mode === "failure") throw new Error("stage failed"); };
      const h = harness({
        drainMailbox: async (_deadline, active) => {
          if (stage === "drain") await pause();
          if (active()) h.update(dirty(), { "U-F": ids });
        },
        finalizeBatchesAndSideEffects: async (_deadline, active) => {
          if (stage === "finalize") await pause();
          if (active()) h.update(dirty(2), { "U-F": ids });
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
      const stopped = h.root.shutdownRuntime(fixtureState(), 2, h.clock());
      await entered.promise;
      expect(h.root.mailbox.stats(h.clock().monotonicMs).accepting).toBe(false);
      const late = mode === "timeout" || mode === "clockJump" || mode === "overallJump";
      h.setTime(mode === "overallJump" ? 30_000 : late ? limit : limit - 1);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(limit);
      gate.resolve();
      const summary = await stopped;
      const observations = reducer.mock.calls.filter(([, input]) => input.kind === "shutdownStageResult");
      expect(observations.slice(-4).map(([, input]) => input.kind === "shutdownStageResult" && input.stage))
        .toEqual(["mailboxDrain", "sideEffectFinalization", "finalCheckpoint", "workerClose"]);
      const results = Object.values(h.root.state.shutdown.stageResults);
      expect(results).toHaveLength(4);
      expect(h.root.state.shutdown.stage).toBe("completed");
      expect(reducer.mock.results.at(-1)?.value.shutdownSummary).toBe(summary);
      const observedStage = stage === "drain" ? "mailboxDrain" : stage === "finalize" ? "sideEffectFinalization"
        : stage === "save" ? "finalCheckpoint" : "workerClose";
      expect(h.root.state.shutdown.stageResults[observedStage]?.result.kind)
        .toBe(late ? "deadlineExceeded" : mode === "failure" && stage !== "save" ? "failed" : "completed");
      const expected = mode === "within" ? 0 : stage === "drain" || stage === "finalize" ? 3 : stage === "save" ? 2 : 4;
      expect(summary.code, `${stage}/${mode}`).toBe(expected);
      if (expected === 0) expect(summary.persistence["U-F"]?.savedGeneration).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fault.opens).toBeLessThanOrEqual(1);
      expect(h.measurements.filter((measurement) => measurement.stage === "write")).toHaveLength(h.fault.opens);
      if (mode === "overallJump" || stage === "summary" && mode !== "within") expect(h.order.includes("close")).toBe(false);
      else expect(h.order).toContain("close");
    }
  }
});

it("I06 contractBoundary / AC04,AC07: wall-clock rollback and date crossings cannot bypass monotonic backoff", async () => {
  const h = harness();
  let state = dirty();
  const request = reserve(h, state);
  h.fault.checkpointFailure = "write";
  state = h.root.applyCheckpointResult(state,
    (await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry")).result, h.clock()).state;
  h.fault.checkpointFailure = null;
  const due = h.root.checkpoint.retryAfter("U-F")!;
  const retryReason = h.root.checkpoint.retryReason("U-F");
  for (const wallOffset of [-2 * 86400_000, 2 * 86400_000, -1, 0]) {
    h.setWallOffset(wallOffset);
    for (let repeat = 0; repeat < 3; repeat += 1)
      expect(h.scheduleCheckpoint(state, h.clock(), "retry", { "U-F": { ...ids, retryReason } })).toBeNull();
    expect(h.root.checkpoint.retryAfter("U-F")).toBe(due);
  }
  expect(h.fault.opens).toBe(1);
  h.setTime(due);
  h.setWallOffset(-2 * 86400_000);
  const retry = h.scheduleCheckpoint(state, h.clock(), "retry", { "U-F": { ...ids, retryReason } })!.request!;
  state = h.root.applyCheckpointResult(state,
    (await h.root.executeCheckpoint(retry, "retry", ids.inputIds, retryReason)).result, h.clock()).state;
  expect(state.units["U-F"].persistence?.kind).toBe("saved");
  expect(h.measurements.every((measurement) => measurement.endedMonotonicMs >= measurement.startedMonotonicMs)).toBe(true);
  await h.root.diagnostics.flush();
});

it("I07 contractBoundary / AC04,AC08: checkpoint rename completion followed by a lost response does not duplicate writes", async () => {
  const h = harness();
  const rename = h.fs.rename;
  const injected = vi.spyOn(h.fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to); throw new Error("lost rename response");
  });
  let state = dirty(1, true);
  const request = reserve(h, state);
  const output = await h.root.executeCheckpoint(request, "review", ids.inputIds, "notRetry");
  expect(output.result.kind).toBe("uncertain");
  state = h.root.applyCheckpointResult(state, output.result, h.clock()).state;
  injected.mockRestore();
  state = (await h.root.resolveUncertain(state, "U-F", request.attemptId, h.clock())).state;
  expect(state.units["U-F"].persistence?.kind).toBe("saved");
  expect(h.fault.opens).toBe(1);
  expect([...h.bytes.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  expect(h.scheduleCheckpoint(state, h.clock(), "weather", { "U-W": ids })?.request?.unit).toBe("U-W");
  await h.root.diagnostics.flush();
});

it("R24 regression / AC08 RES-01: same-generation failure then current advancement cannot leave two checkpoint tmp files", async () => {
  const h = harness();
  let state = dirty();
  const save = async () => {
    const retryReason = h.root.checkpoint.retryReason("U-F");
    const request = h.scheduleCheckpoint(state, h.clock(), "tmp-lifetime", { "U-F": { ...ids, retryReason } })!.request!;
    const output = await h.root.executeCheckpoint(request, "tmp-lifetime", ids.inputIds, retryReason);
    state = h.root.applyCheckpointResult(state, output.result, h.clock()).state;
    return request;
  };
  await save(); // A g1
  state = h.update(fixtureState({ "U-F": "final-2" }, { "U-F": { ...state.units["U-F"].persistence!, kind: "pending", currentGeneration: 2, dirtySince: 0 } }));
  h.fault.directorySync = true;
  const g2 = await save(); // B g2, directory durability unknown
  h.fault.read = true;
  state = (await h.root.resolveUncertain(state, "U-F", g2.attemptId, h.clock())).state;
  h.fault.read = false;
  h.fault.directorySync = false;
  h.fault.checkpointFailure = "write";
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  await save(); // The identical g2 is confirmed without invoking the faulty writer.
  expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toHaveLength(0);
  state = h.update(fixtureState({ "U-F": "final-3" }, { "U-F": { ...state.units["U-F"].persistence!, kind: "pending", currentGeneration: 3, dirtySince: 0 } }));
  h.setTime(h.clock().monotonicMs + 1);
  await save(); // partial g3, destination switches to A
  expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toHaveLength(1);
  expect(h.bytes.size).toBe(3);
  h.fault.checkpointFailure = null;
  h.setTime(h.root.checkpoint.retryAfter("U-F")!);
  await save();
  expect(h.root.restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 3 } });
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
      const h = harness();
      let root = h.root;
      const driver = fixtureDriver();
      let state = dirty(1, true);
      const checkBound = () => {
        const owned = [...h.bytes.keys()].filter((path) => basename(path).startsWith("U-F"));
        expect(owned.filter((path) => path.endsWith(".tmp")).length).toBeLessThanOrEqual(1);
        expect(owned.filter((path) => path.endsWith(".json")).length).toBeLessThanOrEqual(2);
        expect(owned.length).toBeLessThanOrEqual(3);
      };
      const set = h.bytes.set.bind(h.bytes);
      h.bytes.set = (path, bytes) => { const result = set(path, bytes); checkBound(); return result; };
      const changeGeneration = (generation: number) => {
        const desired = fixtureState({ "U-F": `final-${generation}` }, {
          "U-F": { ...state.units["U-F"].persistence!, kind: "pending", currentGeneration: generation, dirtySince: 0 } }, state.runId);
        state = root === h.root ? h.update(desired) : driver.update(root, desired, h.clock());
      };
      const request = () => {
        h.setTime(Math.max(h.clock().monotonicMs, root.checkpoint.retryAfter("U-F") ?? 0));
        const retryReason = root.checkpoint.retryReason("U-F");
        const scheduled = root.scheduleCheckpoint(state, h.clock(), restart && root !== h.root ? "restarted" : "lifetime",
          { "U-F": { ...ids, retryReason } })!;
        return { request: scheduled.request!, retryReason };
      };
      const execute = async () => {
        const next = request();
        const result = await root.executeCheckpoint(next.request, root === h.root ? "lifetime" : "restarted", ids.inputIds, next.retryReason);
        state = root.applyCheckpointResult(state, result.result, h.clock()).state;
        return next.request;
      };
      const rejectUncertain = async (attempt: CheckpointRequest) => {
        if (state.units["U-F"].persistence?.kind !== "uncertain") return;
        h.fault.read = true;
        state = (await root.resolveUncertain(state, "U-F", attempt.attemptId, h.clock())).state;
        h.fault.read = false;
      };
      const failAt = (stage: typeof stages[number] | null) => {
        h.fault.checkpointFailure = stage === "directorySync" ? null : stage;
        h.fault.directorySync = stage === "directorySync";
      };
      for (let generation = 1; generation <= baseline; generation += 1) {
        changeGeneration(generation); await execute();
      }
      changeGeneration(baseline + 1);
      failAt("directorySync");
      await rejectUncertain(await execute()); // A/B contains the new, unacknowledged generation.
      failAt(firstStage);
      await rejectUncertain(await execute()); // Same generation, first failure stage.
      checkBound();
      if (advance) changeGeneration(baseline + 2);
      failAt(nextStage);
      const next = request();
      const entered = deferred();
      const gate = deferred();
      if (held) {
        if (nextStage === "close") { h.fault.closeGate = gate.promise; h.fault.onClose = entered.resolve; }
        if (nextStage === "rename") { h.fault.renameGate = gate.promise; h.fault.onRename = entered.resolve; }
        if (nextStage === "directorySync") { h.fault.syncGate = gate.promise; h.fault.onDirectorySync = entered.resolve; }
      }
      const running = root.executeCheckpoint(next.request, "lifetime", ids.inputIds, next.retryReason);
      if (held) {
        await entered.promise;
        const opens = h.fault.opens;
        const unlinks = h.fault.unlinks;
        // Observe uncertainty without treating pending close/rename/sync as stopped.
        state = root.applyCheckpointResult(state, { kind: "uncertain", attemptId: next.request.attemptId,
          unit: "U-F", generation: next.request.generation, observedAt: h.clock().wallTimeMs,
          stage: "ack", encodedByteLength: next.request.encodedByteLength }, h.clock()).state;
        h.setTime(h.clock().monotonicMs + 20_000);
        for (let repeat = 0; repeat < 2; repeat += 1) {
          expect(root.scheduleCheckpoint(state, h.clock(), "other", { "U-W": ids })).toBeNull();
          state = (await root.resolveUncertain(state, "U-F", next.request.attemptId, h.clock())).state;
          root.restoreUnit("U-F"); // Read-only restore never reclaims a live tmp.
        }
        expect(h.fault.opens).toBe(opens);
        expect(h.fault.unlinks).toBe(unlinks);
        checkBound();
        gate.resolve();
      }
      const ended = await running;
      state = root.applyCheckpointResult(state, ended.result, h.clock()).state;
      checkBound();
      await rejectUncertain(next.request);
      failAt(null);
      h.fault.closeGate = h.fault.renameGate = h.fault.syncGate = null;
      if (restart) {
        // The previous operation has ended; this models exclusive ownership after process restart.
        await root.diagnostics.flush();
        root = new RuntimeCompositionRoot(h.config, { "U-F": codec, "U-W": stringCodec("U-W") }, {
          clock: h.clock, checkpointFileSystem: h.fs, diagnosticFileSystem: h.logs, runtimeCalls: driver.calls,
          reportFailure: (event) => h.events.push(event), onMeasurements: (batch) => h.measurements.push(...batch),
        });
        expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
        expect(root.restoreUnit("U-F").kind).toBe("restored");
        state = root.startRuntime("restarted", h.clock()).state;
        if (state.units["U-F"].persistence.currentGeneration < next.request.generation)
          changeGeneration(next.request.generation);
      }
      const saved = state.units["U-F"].persistence.kind === "saved" ? null : await execute();
      expect(root.restoreUnit("U-F")).toMatchObject({ kind: "restored", envelope: { generation: next.request.generation } });
      expect([...h.bytes.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
      expect(h.bytes.size).toBe(2);
      checkBound();
      expect(h.measurements.filter((measurement) => measurement.attemptId === saved?.attemptId && measurement.stage === "write"))
        .toHaveLength(nextStage === "directorySync" ? 0 : 1);
      await root.diagnostics.flush();
    }
});

it("I09 contractBoundary / AC08 RES-01: startup reclaims only owned tmp, and deletion failure blocks a new tmp until recovery", async () => {
  for (const failCleanup of [false, true]) {
    const h = harness();
    const first = reserve(h, dirty());
    h.root.applyCheckpointResult(dirty(), (await h.root.executeCheckpoint(first, "review", ids.inputIds, "notRetry")).result, h.clock());
    const slot = join(h.config.stateDirectory, "U-F-A.json");
    const saved = h.bytes.get(slot)!.slice();
    const foreign = join(h.config.stateDirectory, "unowned.tmp");
    h.bytes.set(foreign, new Uint8Array([7]));
    h.bytes.set(join(h.config.stateDirectory, "U-W.json.tmp"), new Uint8Array([8]));
    // Include residues made by the pre-fix implementation, even its invalid two-tmp state.
    for (const name of ["U-F.json.tmp", "U-F-A.json.tmp", "U-F-B.json.tmp"])
      h.bytes.set(join(h.config.stateDirectory, name), new Uint8Array([9]));
    h.fault.checkpointUnlink = failCleanup;
    const driver = fixtureDriver();
    const restarted = new RuntimeCompositionRoot(h.config, { "U-F": codec }, {
      clock: h.clock, checkpointFileSystem: h.fs, diagnosticFileSystem: h.logs,
      runtimeCalls: driver.calls, reportFailure: () => {},
    });
    expect(restarted.restoreUnit("U-F")).toMatchObject({ kind: "restored", envelope: { generation: 1 } });
    restarted.startRuntime("review", h.clock());
    let state = driver.update(restarted, fixtureState({ "U-F": "final-2" }, { "U-F": {
      kind: "pending", currentGeneration: 2, savedGeneration: 1,
      savedCapturedAt: 0, savedAckAt: 0, dirtySince: 0,
    } }), h.clock(), { "U-F": ids });
    if (failCleanup) {
      const opens = h.fault.opens;
      const scheduled = restarted.scheduleCheckpoint(state, h.clock(), "restart", { "U-F": ids })!.request!;
      const failed = await restarted.executeCheckpoint(scheduled, "restart", ids.inputIds, "notRetry");
      expect(failed.result).toMatchObject({ kind: "failed", stage: "write" });
      expect(failed.measurements).toEqual([expect.objectContaining({ stage: "write", outcome: "failed" })]);
      expect(h.fault.opens).toBe(opens); // Existing over-limit residue cannot be enlarged by another open.
      state = restarted.applyCheckpointResult(state, failed.result, h.clock()).state;
      h.fault.checkpointUnlink = false;
      h.setTime(restarted.checkpoint.retryAfter("U-F")!);
    } else expect([...h.bytes.keys()].filter((path) => basename(path).startsWith("U-F") && path.endsWith(".tmp"))).toEqual([]);
    const retryReason = restarted.checkpoint.retryReason("U-F");
    const request = restarted.scheduleCheckpoint(state, h.clock(), "recovery", { "U-F": { ...ids, retryReason } })!.request!;
    expect((await restarted.executeCheckpoint(request, "recovery", ids.inputIds, retryReason)).result.kind).toBe("acknowledged");
    expect(h.bytes.get(slot)).toEqual(saved);
    expect([...h.bytes.keys()].filter((path) => basename(path).startsWith("U-F"))).toHaveLength(2);
    expect(h.bytes.get(foreign)).toEqual(new Uint8Array([7]));
    expect(h.bytes.get(join(h.config.stateDirectory, "U-W.json.tmp"))).toEqual(new Uint8Array([8]));
    await restarted.diagnostics.flush();
    await h.root.diagnostics.flush();
  }
  const directory = await disk.mkdtemp(join(tmpdir(), "fleq-a3-owned-tmp-"));
  try {
    const stateDirectory = join(directory, "state");
    await disk.mkdir(stateDirectory);
    for (const name of ["U-F.json.tmp", "U-F-A.json.tmp", "U-F-B.json.tmp", "other.tmp"])
      await disk.writeFile(join(stateDirectory, name), "orphan");
    const root = new RuntimeCompositionRoot({ appName: "p2", legacyAppName: "v2", stateDirectory,
      legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "logs") }, { "U-F": codec });
    expect(await disk.readdir(stateDirectory)).toEqual(["other.tmp"]);
    expect(root.restoreUnit("U-F")).toEqual({ kind: "empty" });
    await root.diagnostics.flush();
  } finally { await disk.rm(directory, { recursive: true, force: true }); }
});
