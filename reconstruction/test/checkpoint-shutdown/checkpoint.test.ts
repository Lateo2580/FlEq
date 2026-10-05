import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClockReading, JsonValue, RuntimeUnitId, RuntimeUnitStates, UnitCodec, UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { CheckpointCoordinator, hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import { nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { harnessedRoot } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

import { fixtureState, fixtureValue, fixtureDriver, recordingNotificationAdapter } from "./runtime-fixture";
import type { Fixture } from "./runtime-fixture";

const temporary: string[] = [];
const correlation = { inputIds: ["input-1"], retryReason: "notRetry" as const };

function codec<U extends RuntimeUnitId>(unit: U, counter?: { value: number }, fail?: () => boolean): UnitCodec<RuntimeUnitStates[U], JsonValue> {
  return {
    schemaVersion: "test-v1",
    encode(state) {
      counter && (counter.value += 1);
      if (fail?.()) throw new Error("encode failure");
      if (state == null) throw new Error("missing state");
      return { value: fixtureValue(state),
        ...(!("intentExpiresAt" in state) || typeof state.intentExpiresAt !== "number" ? {} : { intentExpiresAt: state.intentExpiresAt }) };
    },
    decode(payload) {
      if (payload == null || typeof payload !== "object" || Array.isArray(payload)
        || !("value" in payload) || typeof payload.value !== "string") return { kind: "invalid", reason: "invalid test payload" };
      return { kind: "restored", state: { ...fixtureState({ [unit]: { value: payload.value,
        ...(typeof payload.intentExpiresAt === "number" ? { intentExpiresAt: payload.intentExpiresAt } : {}) } }).units[unit],
        activeFixture: null } };
    },
  };
}

async function directory(): Promise<string> {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a3-"));
  temporary.push(path);
  return path;
}

function config(path: string) {
  return { appName: "fleq-p2", legacyAppName: "fleq",
    stateDirectory: join(path, "state"), legacyStateDirectory: join(path, "legacy"),
    diagnosticDirectory: join(path, "diagnostics") } as const;
}

const pending = fixtureState;

// TEST-PATH (2): the publisher with its in-process owners; the fixture driver's stub reducers set the unit states.
function wired(path: string, codecs: CodecMap, clock: () => ClockReading, files?: CheckpointFileSystem) {
  const driver = fixtureDriver();
  const h = harnessedRoot(config(path), codecs, { notificationAdapter: recordingNotificationAdapter(),
    runtimeCalls: driver.calls, clock, checkpointFileSystem: files });
  return { h, driver };
}

// One write-right grant (if any is due) and the owner's checkpointDone reply to it.
async function granted(h: Harness) {
  const from = h.delivered.length;
  const released = h.root.driveCheckpoint();
  await h.settle();
  await released;
  return h.delivered.slice(from).flatMap(({ reply }) => reply.kind === "checkpointDone" ? [reply] : []);
}

// The slot a restart would read: a fresh owner-side coordinator over the same files.
function slot(path: string, unit: UnitId, codecs: CodecMap, files: CheckpointFileSystem = nodeCheckpointFileSystem()) {
  return new CheckpointCoordinator(join(path, "state"), codecs, files, () => ({ wallTimeMs: 0, monotonicMs: 0 }), () => {})
    .restoreUnit(unit);
}

const reasons = async (h: Harness) => (await h.root.readDiagnostics({ limit: 256 })).records.map((event) => event.reason);

class MemoryCheckpointFileSystem implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  fail: "write" | "fileSync" | "close" | "rename" | "directorySync" | "verify" | null = null;

  unlinkSync(path: string): void { this.files.delete(path); }

  readFile(path: string): Uint8Array | null {
    const bytes = this.files.get(path) ?? null;
    return this.fail === "verify" && bytes != null && path.endsWith(".json")
      ? new TextEncoder().encode("invalid") : bytes;
  }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return {
      write: async (data) => { if (this.fail === "write") throw new Error("write failed"); bytes = data.slice(); },
      sync: async () => { if (this.fail === "fileSync") throw new Error("sync failed"); },
      close: async () => { if (this.fail === "close") throw new Error("close failed"); this.files.set(path, bytes); },
    };
  }
  async rename(from: string, to: string): Promise<void> {
    if (this.fail === "rename") throw new Error("rename failed");
    const bytes = this.files.get(from);
    if (bytes == null) throw new Error("temporary file missing");
    this.files.set(to, bytes);
    this.files.delete(from);
  }
  async syncDirectory(): Promise<void> {
    if (this.fail === "directorySync") throw new Error("directory sync failed");
  }
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await fileSystem.rm(path, { recursive: true, force: true });
});

describe("P2 checkpoint", () => {
  it("P2-A3-T01 contractBoundary / AC01: the O07 fixture-backed test codec persists intent data but not active current", async () => {
    // TEST-PATH (1): the owner-side coordinator's capture, write and restore.
    const path = await directory();
    const fixture = await fileSystem.readFile("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
    const codecs = { "U-E": codec("U-E") };
    const coordinator = new CheckpointCoordinator(join(path, "state"), codecs, nodeCheckpointFileSystem(),
      () => ({ wallTimeMs: 1_713_363_299_002, monotonicMs: 2 }), () => {});
    const state = pending({ "U-E": { value: fixture, activeFixture: "active", intentExpiresAt: 1_713_363_314_001 } }, {
      "U-E": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 1 },
    });
    const o07 = { inputIds: ["test__fixtures__37_01_01_240613_VXSE43"], retryReason: "notRetry" as const };
    const captured = coordinator.capture("U-E", state.units["U-E"], 1, "o07", o07);
    if (captured.request == null) throw new Error("checkpoint not captured");
    const output = await coordinator.executeCheckpoint(captured.request, "o07", o07.inputIds, "notRetry");
    expect(output.result.kind).toBe("acknowledged");
    const restored = slot(path, "U-E", codecs);
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") throw new Error("checkpoint not restored");
    expect(codec("U-E").decode(restored.envelope.payload)).toMatchObject({ kind: "restored", state: {
      value: fixture, activeFixture: null, current: [], intentExpiresAt: 1_713_363_314_001,
    } });
  });

  it("P2-A3-T02 contractBoundary / AC02: rename uncertainty reconciles g2 without rolling back in-memory cancellation g3", async () => {
    const path = await directory();
    const adapter = new MemoryCheckpointFileSystem();
    let now = { wallTimeMs: 5_000, monotonicMs: 500 };
    const { h, driver } = wired(path, { "U-F": codec("U-F") }, () => now, adapter);
    await driver.update(h, pending({ "U-F": { value: "active" } }, { "U-F": { kind: "pending",
      currentGeneration: 2, savedGeneration: 1, savedCapturedAt: 1, savedAckAt: 2, dirtySince: 10 } }, "o10"), now,
    { "U-F": correlation.inputIds });
    adapter.fail = "directorySync";
    // The owner captures g2 and starts writing; g3 arrives before the write ends.
    h.pause();
    const released = h.root.driveCheckpoint();
    h.flush();
    const before = h.unit("U-F").persistence;
    now = { wallTimeMs: 5_001, monotonicMs: 501 };
    await driver.update(h, pending({ "U-F": { value: "cancelled" } }, { "U-F": { ...before,
      kind: "pending", currentGeneration: 3, dirtySince: 501 } }, "o10"), now);
    await released;
    expect(h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" ? [reply.result] : []))
      .toMatchObject([{ kind: "uncertain", generation: 2, stage: "directorySync" }]);
    expect(h.unit("U-F")).toMatchObject({ value: "cancelled",
      persistence: { kind: "uncertain", currentGeneration: 3, attemptedGeneration: 2 } });
    adapter.fail = null;
    now = { wallTimeMs: 5_002, monotonicMs: 502 };
    await granted(h);
    expect(h.unit("U-F")).toMatchObject({ value: "cancelled",
      persistence: { kind: "pending", currentGeneration: 3, savedGeneration: 2, dirtySince: 501 } });
    await h.root.diagnostics.flush();
  });

  it("P2-A3-T03 contractBoundary / AC03: a saved U-W is not encoded for another unit's update", async () => {
    const path = await directory();
    const weather = { value: 0 };
    const eew = { value: 0 };
    const clock = { wallTimeMs: 1_000, monotonicMs: 100 };
    const { h, driver } = wired(path, { "U-W": codec("U-W", weather), "U-E": codec("U-E", eew) }, () => clock);
    const state = pending({ "U-W": { value: "saved" }, "U-E": { value: "dirty" } }, {
      "U-W": { kind: "saved", currentGeneration: 1, savedGeneration: 1,
        savedCapturedAt: 1, savedAckAt: 2, dirtySince: null },
      "U-E": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 0 },
    }, "run");
    await driver.update(h, state, clock, { "U-E": correlation.inputIds });
    expect((await granted(h)).map((reply) => reply.unit)).toEqual(["U-E"]);
    expect(weather.value).toBe(0);
    expect(eew.value).toBe(1);
    await h.root.diagnostics.flush();
  });

  it("P2-A3-T04 regression / AC04: a failed oldest unit observes 1/2/4/8/10s backoff without starving U-W", async () => {
    const path = await directory();
    const adapter = new MemoryCheckpointFileSystem();
    let now = 100;
    const { h, driver } = wired(path, { "U-F": codec("U-F"), "U-W": codec("U-W") },
      () => ({ wallTimeMs: 10_000 + now, monotonicMs: now }), adapter);
    await driver.update(h, pending({ "U-F": { value: "cancelled" }, "U-W": { value: "normal" } }, {
      "U-F": { kind: "pending", currentGeneration: 3, savedGeneration: 1,
        savedCapturedAt: 1, savedAckAt: 2, dirtySince: 0 },
      "U-W": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 50 },
    }, "run"), undefined, { "U-F": correlation.inputIds, "U-W": correlation.inputIds });
    adapter.fail = "write";
    expect((await granted(h)).map((reply) => reply.unit)).toEqual(["U-F"]);
    expect(h.root.checkpoint.retryAfter("U-F")).toBe(1_100);

    adapter.fail = null;
    now = 101;
    const dirtySince = h.root.state.mirror["U-W"].persistence.dirtySince!;
    const weather = await granted(h);
    expect(weather.map((reply) => reply.unit)).toEqual(["U-W"]);
    expect(weather[0].measurements.at(-1)!.endedMonotonicMs - dirtySince).toBeLessThanOrEqual(3_000);
    expect(h.root.state.mirror["U-W"].persistence.kind).toBe("saved");

    adapter.fail = "write";
    for (const nextDelay of [2_000, 4_000, 8_000, 10_000, 10_000]) {
      const due = h.root.checkpoint.retryAfter("U-F")!;
      now = due - 1;
      expect(await granted(h)).toEqual([]);
      now = due;
      expect((await granted(h)).map((reply) => reply.unit)).toEqual(["U-F"]);
      expect(h.root.checkpoint.retryAfter("U-F")).toBe(now + nextDelay);
    }
    await h.root.diagnostics.flush();
  });

  it("P2-A3-T05 acceptance / AC05: encode failure, successful stages and idle all have exact attribution", async () => {
    const path = await directory();
    let fail = true;
    let now = { wallTimeMs: 1_000, monotonicMs: 0 };
    const adapter = new MemoryCheckpointFileSystem();
    const { h, driver } = wired(path, { "U-F": codec("U-F", undefined, () => fail) }, () => now, adapter);
    await driver.update(h, pending({ "U-F": { value: "payload" } }, { "U-F": { kind: "pending",
      currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } }, "run-5"),
    now, { "U-F": correlation.inputIds });
    const failed = await granted(h);
    expect(failed).toMatchObject([{ unit: "U-F", result: { kind: "failed", unit: "U-F", generation: 1, stage: "encode",
      encodedByteLength: 0 }, measurements: [{ runId: "run-5", inputIds: ["input-1"], unit: "U-F", generation: 1,
      stage: "encode", bytes: 0, outcome: "failed", retryReason: "notRetry", attemptId: failed[0].result?.attemptId }] }]);
    // TEST-PATH (1) (X10): the failed capture itself names its attempt, unit, generation and capture time.
    const direct = new CheckpointCoordinator(join(path, "direct"), { "U-F": codec("U-F", undefined, () => true) }, adapter,
      () => ({ wallTimeMs: 1_002, monotonicMs: 2 }), () => {});
    const capture = direct.capture("U-F", pending({ "U-F": { value: "payload" } }).units["U-F"], 1, "run-5", correlation);
    expect(capture.capture).toEqual({ attemptId: capture.result!.attemptId, unit: "U-F", generation: 1, capturedAt: 1_002 });
    expect(await reasons(h)).toContain("checkpointEncodeFailed");
    expect(h.owners.get("deferred")!["state"]!.checkpointAttempts["U-F"]).toBeUndefined();
    expect(h.unit("U-F").persistence).toMatchObject({ kind: "failed", stage: "encode" });

    fail = false;
    const due = h.root.checkpoint.retryAfter("U-F")!;
    now = { wallTimeMs: 2_000, monotonicMs: due };
    const [succeeded] = await granted(h);
    const attemptId = succeeded.result?.attemptId;
    expect(succeeded.measurements.map((measurement) => [measurement.stage, measurement.outcome])).toEqual([
      ["encode", "succeeded"], ["write", "succeeded"], ["fileSync", "succeeded"], ["close", "succeeded"],
      ["rename", "succeeded"], ["directorySync", "succeeded"],
    ]);
    expect(succeeded.measurements.every((measurement) => measurement.attemptId === attemptId
      && measurement.unit === "U-F" && measurement.generation === 1
      && measurement.inputIds[0] === "input-1" && measurement.retryReason === "saveFailed")).toBe(true);
    now = { wallTimeMs: 2_002, monotonicMs: due + 2 };
    expect(await granted(h)).toEqual([]);
    await h.root.diagnostics.flush();
  });

  it("P2-A3-T07 contractBoundary / AC07: each filesystem failure stage emits its fixed diagnostic reason", async () => {
    const expected = {
      write: "checkpointWriteFailed", fileSync: "checkpointFileSyncFailed", close: "checkpointCloseFailed",
      rename: "checkpointRenameFailed", directorySync: "checkpointDirectorySyncFailed", verify: "checkpointVerifyFailed",
    } as const;
    for (const [stage, reason] of Object.entries(expected) as [keyof typeof expected, typeof expected[keyof typeof expected]][]) {
      const path = await directory();
      const adapter = new MemoryCheckpointFileSystem();
      // P3-C1: the verify stage no longer follows a steady save; it remains only in reconciliation.
      adapter.fail = stage === "verify" ? "directorySync" : stage;
      const clock = { wallTimeMs: 1_000, monotonicMs: 1 };
      const { h, driver } = wired(path, { "U-F": codec("U-F") }, () => clock, adapter);
      await driver.update(h, pending({ "U-F": { value: "payload" } }, { "U-F": { kind: "pending",
        currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } }, "stages"),
      clock, { "U-F": correlation.inputIds });
      await granted(h);
      if (stage === "verify") {
        adapter.fail = "verify";
        await granted(h);
      }
      expect(await reasons(h)).toContain(reason);
      if (stage === "directorySync") expect(await reasons(h)).toContain("checkpointUncertain");
      await h.root.diagnostics.flush();
    }
  });

  it("P2-A3-T08 contractBoundary / AC08: full-byte hash, two slots, schema and decode gate restoration", async () => {
    const path = await directory();
    const codecs = { "U-F": codec("U-F") };
    let now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const { h, driver } = wired(path, codecs, () => now);
    await driver.update(h, pending({ "U-F": { value: "same" } }, { "U-F": { kind: "pending",
      currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } }, "hash"),
    now, { "U-F": correlation.inputIds });
    await granted(h);
    now = { wallTimeMs: 1_002, monotonicMs: 3 };
    await driver.update(h, pending({ "U-F": { value: "same" } }, { "U-F": { ...h.unit("U-F").persistence, kind: "pending",
      currentGeneration: 9, dirtySince: 3 } }, "hash"), now, { "U-F": correlation.inputIds });
    await granted(h);
    expect(slot(path, "U-F", codecs)).toMatchObject({ kind: "restored", slot: "B", envelope: { generation: 9 } });

    const newerPath = join(path, "state", "U-F-B.json");
    const original = JSON.parse(await fileSystem.readFile(newerPath, "utf8")) as Record<string, unknown>;
    for (const changed of [
      { ...original, generation: 8 }, { ...original, unit: "U-W" },
      { ...original, schemaVersion: "other" }, { ...original, capturedAt: 0 },
    ]) {
      await fileSystem.writeFile(newerPath, JSON.stringify(changed));
      expect(slot(path, "U-F", codecs)).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 1 } });
    }

    await fileSystem.writeFile(join(path, "state", "U-F-A.json"), "invalid");
    const unknown = hashEnvelope({ schemaVersion: "future-v2", unit: "U-F", generation: 9,
      capturedAt: 1, payload: { value: "same", sha256: "payload-field" } });
    await fileSystem.writeFile(newerPath, serializedEnvelope(unknown));
    expect(slot(path, "U-F", codecs)).toEqual({ kind: "unavailable", reason: "unknownSchema" });

    const invalid = hashEnvelope({ schemaVersion: "test-v1", unit: "U-F", generation: 9,
      capturedAt: 1, payload: { invalid: true } });
    await fileSystem.writeFile(newerPath, serializedEnvelope(invalid));
    expect(slot(path, "U-F", codecs)).toEqual({ kind: "unavailable", reason: "noValidSlot" });
    await h.root.diagnostics.flush();
  });
});

// P3-C1: a steady save reads nothing and serializes the envelope once. Records every filesystem call in order.
class RecordingFileSystem extends MemoryCheckpointFileSystem {
  readonly calls: string[] = [];
  syncGate: Promise<void> | null = null;
  readFails = false;
  unlinkSync(path: string): void { this.calls.push("unlink"); super.unlinkSync(path); }
  readFile(path: string): Uint8Array | null {
    this.calls.push("readFile");
    if (this.readFails) throw new Error("EIO: transient read failure");
    return super.readFile(path);
  }
  async open(path: string): Promise<WritableCheckpoint> {
    this.calls.push("open");
    const file = await super.open(path);
    return {
      write: async (data) => { this.calls.push("write"); await file.write(data); },
      sync: async () => { this.calls.push("sync"); await file.sync(); },
      close: async () => { this.calls.push("close"); await file.close(); },
    };
  }
  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename:${to.slice(-6)}`);
    await super.rename(from, to);
  }
  async syncDirectory(): Promise<void> {
    this.calls.push("syncDirectory");
    await this.syncGate;
    await super.syncDirectory();
  }
}

// TEST-PATH (1): the owner-side coordinator alone. save() is one granted save as the owner runs it: capture the
// generation, write it, and tell the coordinator the result was adopted.
function p3Root(path: string, adapter: CheckpointFileSystem) {
  let now = 500;
  const coordinator = new CheckpointCoordinator(join(path, "state"), { "U-F": codec("U-F") }, adapter,
    () => ({ wallTimeMs: 4_500 + now, monotonicMs: now }), () => {});
  const capture = (generation: number, retryReason: "notRetry" | "saveFailed" | "ackUncertain") => {
    const captured = coordinator.capture("U-F", pending({ "U-F": { value: `v${generation}` } }).units["U-F"], generation,
      "p3c1", { ...correlation, retryReason });
    if (captured.request == null) throw new Error("checkpoint not captured");
    return captured.request;
  };
  const save = async (generation: number, at: number, retryReason: "notRetry" | "saveFailed" | "ackUncertain" = "notRetry") => {
    now = at;
    const request = capture(generation, retryReason);
    const output = await coordinator.executeCheckpoint(request, "p3c1", correlation.inputIds, retryReason);
    coordinator.ended(output.result, false);
    return { request, output };
  };
  const reconcile = async (attemptId: string, at: number) => {
    now = at;
    const output = await coordinator.reconcile("U-F", attemptId);
    coordinator.ended(output.result, true);
    return output;
  };
  return { coordinator, capture, save, reconcile };
}

describe("P3-C1 checkpoint step 1", () => {
  const slotsWritten = (adapter: RecordingFileSystem) => adapter.calls.filter((call) => call.startsWith("rename:"))
    .map((call) => call.slice(-6, -5));

  it("P3-C1-T01 acceptance / AC01: after restoreUnit(empty), g1-g3 read nothing and alternate A, B, A", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { coordinator, save } = p3Root(path, adapter);
    expect(coordinator.restoreUnit("U-F")).toEqual({ kind: "empty" });
    adapter.calls.length = 0;
    for (const generation of [1, 2, 3]) {
      const saved = await save(generation, generation * 10);
      expect(saved.output.result.kind).toBe("acknowledged");
    }
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(0);
    expect(slotsWritten(adapter)).toEqual(["A", "B", "A"]);
    expect(slot(path, "U-F", { "U-F": codec("U-F") }, adapter))
      .toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 3 } });
  });

  it("P3-C1-T02 contractBoundary / AC02: after a failed reconciliation the next attempt reads A and B once, then reads return to 0", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { coordinator, save, reconcile } = p3Root(path, adapter);
    coordinator.restoreUnit("U-F");
    adapter.fail = "rename"; // the name is not replaced: reconciliation finds no g1 and fails
    const first = await save(1, 10);
    expect(first.output.result).toMatchObject({ kind: "uncertain", stage: "rename" });
    expect((await reconcile(first.request.attemptId, 20)).result).toMatchObject({ kind: "failed" });
    adapter.fail = null;
    adapter.calls.length = 0;
    const retry = await save(1, 1_020, "ackUncertain");
    expect(retry.output.result.kind).toBe("acknowledged");
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(2);
    expect(retry.output.measurements.map((measurement) => measurement.stage))
      .toEqual(["write", "fileSync", "close", "rename", "directorySync"]);
    adapter.calls.length = 0;
    const next = await save(2, 30_000);
    expect(next.output.result.kind).toBe("acknowledged");
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(0);
  });

  it("P3-C1-T02 contractBoundary / AC02: a restoreUnit failing during the same-generation directory sync is overridden by the ack; the next save reads nothing", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { coordinator, save, reconcile } = p3Root(path, adapter);
    coordinator.restoreUnit("U-F");
    // g1 reaches its slot but the directory sync fails, and the reconciliation cannot read: g1 is retried as is.
    adapter.fail = "directorySync";
    const first = await save(1, 10);
    expect(first.output.result).toMatchObject({ kind: "uncertain", stage: "directorySync" });
    adapter.fail = null;
    adapter.readFails = true;
    expect((await reconcile(first.request.attemptId, 20)).result).toMatchObject({ kind: "failed" });
    adapter.readFails = false;
    let release!: () => void;
    adapter.syncGate = new Promise<void>((resolve) => { release = resolve; });
    adapter.calls.length = 0;
    const retry = save(1, 1_020, "ackUncertain");
    while (!adapter.calls.includes("syncDirectory")) await new Promise((resolve) => setImmediate(resolve));
    // While the found g1 slot's directory sync waits, a public restore fails once and drops the memory.
    adapter.readFails = true;
    expect(coordinator.restoreUnit("U-F")).toMatchObject({ kind: "unavailable" });
    adapter.readFails = false;
    release();
    const retried = await retry;
    expect(retried.output.result.kind).toBe("acknowledged");
    expect(retried.output.measurements.map((measurement) => measurement.stage)).toEqual(["directorySync", "verify"]);
    adapter.syncGate = null;
    adapter.calls.length = 0;
    const next = await save(2, 30_000);
    expect(next.output.result.kind).toBe("acknowledged");
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(0);
  });

  it("P3-C1-T03 contractBoundary / AC03: one envelope stringify per new capture, bytes equal P2's, none on a same-generation retry", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { coordinator, save } = p3Root(path, adapter);
    coordinator.restoreUnit("U-F");
    const stringify = vi.spyOn(JSON, "stringify");
    const envelopeCalls = () => stringify.mock.calls.filter(([value]) => value != null && typeof value === "object" && "payload" in value).length;
    let retry: Awaited<ReturnType<typeof save>>;
    try {
      adapter.fail = "write";
      const failed = await save(1, 10);
      expect(failed.output.result.kind).toBe("failed");
      expect(envelopeCalls()).toBe(1); // the capture's single serialization; the range checks pass numbers
      adapter.fail = null;
      stringify.mockClear();
      retry = await save(1, 1_010, "saveFailed");
      expect(retry.output.result.kind).toBe("acknowledged");
      expect(envelopeCalls()).toBe(0); // the retained bytes are reused
    } finally { stringify.mockRestore(); }
    const request = retry.request;
    const { sha256: _hash, ...unhashed } = request.envelope;
    expect(adapter.files.get(join(path, "state", "U-F-A.json")))
      .toEqual(serializedEnvelope(hashEnvelope(unhashed)));
    expect(request.encodedByteLength).toBe(serializedEnvelope(request.envelope).byteLength);
    expect(coordinator.restoreUnit("U-F")).toMatchObject({ kind: "restored", envelope: { generation: 1, sha256: request.envelope.sha256 } });
  });

  it("P3-C1-T04 acceptance / AC04: a steady save is open, write, sync, close, rename, syncDirectory and waits for the directory sync", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { coordinator, capture } = p3Root(path, adapter);
    coordinator.restoreUnit("U-F"); // the owner's startup restore (its reads are not part of the save)
    const request = capture(1, "notRetry");
    adapter.calls.length = 0;
    let release!: () => void;
    adapter.syncGate = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const running = coordinator.executeCheckpoint(request, "p3c1", correlation.inputIds, "notRetry")
      .then((output) => { settled = true; return output; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.calls).toEqual(["unlink", "unlink", "unlink", "open", "write", "sync", "close", "rename:A.json", "syncDirectory"]);
    expect(settled).toBe(false);
    release();
    expect((await running).result.kind).toBe("acknowledged");
  });

  // A slot placed from outside; restoreUnit teaches the writer what is on disk before the g1 request executes.
  const placed = async (generation: number, payload: string) => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { coordinator, capture } = p3Root(path, adapter);
    coordinator.restoreUnit("U-F");
    const request = capture(1, "notRetry");
    adapter.files.set(join(path, "state", "U-F-A.json"), serializedEnvelope(hashEnvelope({
      schemaVersion: "test-v1", unit: "U-F", generation, capturedAt: 1, payload: { value: payload } })));
    coordinator.restoreUnit("U-F");
    adapter.calls.length = 0;
    const output = await coordinator.executeCheckpoint(request, "p3c1", correlation.inputIds, "notRetry");
    return { adapter, output };
  };

  it("P3-C1-T06 contractBoundary / AC02(3): a memory newer than the request fails without reading or writing (P2-A3-AC09)", async () => {
    const { adapter, output } = await placed(2, "newer");
    expect(output.result).toMatchObject({ kind: "failed", stage: "write" });
    expect(adapter.calls.filter((call) => call === "readFile" || call === "open")).toEqual([]);
  });

  it("P3-C1-T07 contractBoundary / AC02(2): a same-generation slot with another hash fails stage=write without writing", async () => {
    const { adapter, output } = await placed(1, "different");
    expect(output.result).toMatchObject({ kind: "failed", stage: "write" });
    expect(adapter.calls.filter((call) => call === "open")).toEqual([]);
  });
});
