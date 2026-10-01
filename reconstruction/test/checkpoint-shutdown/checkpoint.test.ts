import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonValue, RuntimeState, RuntimeUnitId, RuntimeUnitStates, UnitCodec, UnitId } from "../../contracts/p2-shared-runtime.types";
import { hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";

import { fixtureState, fixtureValue, fixtureDriver , testNotificationChannels, recordingNotificationAdapter} from "./runtime-fixture";
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

function schedule(root: RuntimeCompositionRoot, driver: ReturnType<typeof fixtureDriver>,
  state: RuntimeState, clock: Parameters<RuntimeCompositionRoot["scheduleCheckpoint"]>[1], runId: string,
  correlations: Parameters<RuntimeCompositionRoot["scheduleCheckpoint"]>[3]) {
  driver.update(root, state, clock, correlations);
  return root.scheduleCheckpoint(root.state, clock, runId, correlations);
}

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
    const path = await directory();
    const fixture = await fileSystem.readFile("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
    const driver = fixtureDriver();
    const root = new RuntimeCompositionRoot(config(path), { "U-E": codec("U-E") }, { notificationAdapter: recordingNotificationAdapter(),
      runtimeCalls: driver.calls,
      clock: () => ({ wallTimeMs: 1_713_363_299_002, monotonicMs: 2 }),
    });
    let state = pending({ "U-E": { value: fixture, activeFixture: "active", intentExpiresAt: 1_713_363_314_001 } }, {
      "U-E": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 1 },
    });
    const scheduled = schedule(root, driver, state, { wallTimeMs: 1_713_363_299_002, monotonicMs: 2 }, "o07",
      { "U-E": { inputIds: ["test__fixtures__37_01_01_240613_VXSE43"], retryReason: "notRetry" } })!;
    const output = await root.executeCheckpoint(scheduled.request!, "o07",
      ["test__fixtures__37_01_01_240613_VXSE43"], "notRetry");
    state = root.applyCheckpointResult(state, output.result,
      { wallTimeMs: 1_713_363_299_002, monotonicMs: 3 }).state;
    expect(state.units["U-E"].persistence?.kind).toBe("saved");
    const restored = root.restoreUnit("U-E");
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") throw new Error("checkpoint not restored");
    expect(codec("U-E").decode(restored.envelope.payload)).toMatchObject({ kind: "restored", state: {
      value: fixture, activeFixture: null, current: [], intentExpiresAt: 1_713_363_314_001,
    } });
  });

  it("P2-A3-T02 contractBoundary / AC02: rename uncertainty reconciles g2 without rolling back in-memory cancellation g3", async () => {
    const path = await directory();
    const adapter = new MemoryCheckpointFileSystem();
    const driver = fixtureDriver();
    const root = new RuntimeCompositionRoot(config(path), { "U-F": codec("U-F") }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: adapter,
      runtimeCalls: driver.calls,
      clock: () => ({ wallTimeMs: 5_000, monotonicMs: 500 }),
    });
    let state = pending({ "U-F": { value: "active" } }, { "U-F": { kind: "pending",
      currentGeneration: 2, savedGeneration: 1, savedCapturedAt: 1, savedAckAt: 2, dirtySince: 10 } });
    const scheduled = schedule(root, driver, state, { wallTimeMs: 5_000, monotonicMs: 500 }, "o10",
      { "U-F": correlation })!;
    adapter.fail = "directorySync";
    const output = await root.executeCheckpoint(scheduled.request!, "o10", correlation.inputIds, correlation.retryReason);
    expect(output.result).toMatchObject({ kind: "uncertain", generation: 2, stage: "directorySync" });
    state = driver.update(root, pending({ "U-F": { value: "cancelled" } }, { "U-F": { ...state.units["U-F"].persistence!,
      kind: "pending", currentGeneration: 3, dirtySince: 501 } }), { wallTimeMs: 5_001, monotonicMs: 501 });
    state = root.applyCheckpointResult(state, output.result, { wallTimeMs: 5_001, monotonicMs: 501 }).state;
    expect(state.units["U-F"]).toMatchObject({ value: "cancelled",
      persistence: { kind: "uncertain", currentGeneration: 3, attemptedGeneration: 2 } });
    adapter.fail = null;
    state = (await root.resolveUncertain(state, "U-F", scheduled.request!.attemptId,
      { wallTimeMs: 5_002, monotonicMs: 502 })).state;
    expect(state.units["U-F"]).toMatchObject({ value: "cancelled",
      persistence: { kind: "pending", currentGeneration: 3, savedGeneration: 2, dirtySince: 501 } });
    await root.diagnostics.flush();
  });

  it("P2-A3-T03 contractBoundary / AC03: a saved U-W is not encoded for another unit's update", async () => {
    const path = await directory();
    const weather = { value: 0 };
    const eew = { value: 0 };
    const driver = fixtureDriver();
    const root = new RuntimeCompositionRoot(config(path), {
      "U-W": codec("U-W", weather), "U-E": codec("U-E", eew),
    }, { notificationAdapter: recordingNotificationAdapter(), runtimeCalls: driver.calls, clock: () => ({ wallTimeMs: 1_000, monotonicMs: 100 }) });
    const state = pending({ "U-W": { value: "saved" }, "U-E": { value: "dirty" } }, {
      "U-W": { kind: "saved", currentGeneration: 1, savedGeneration: 1,
        savedCapturedAt: 1, savedAckAt: 2, dirtySince: null },
      "U-E": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 0 },
    });
    const scheduled = schedule(root, driver, state, { wallTimeMs: 1_000, monotonicMs: 100 }, "run",
      { "U-E": correlation });
    expect(scheduled?.request?.unit).toBe("U-E");
    expect(weather.value).toBe(0);
    expect(eew.value).toBe(1);
  });

  it("P2-A3-T04 regression / AC04: a failed oldest unit observes 1/2/4/8/10s backoff without starving U-W", async () => {
    const path = await directory();
    const adapter = new MemoryCheckpointFileSystem();
    let now = 100;
    const driver = fixtureDriver();
    const root = new RuntimeCompositionRoot(config(path), { "U-F": codec("U-F"), "U-W": codec("U-W") }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: adapter,
      runtimeCalls: driver.calls,
      clock: () => ({ wallTimeMs: 10_000 + now, monotonicMs: now }),
    });
    let state = pending({ "U-F": { value: "cancelled" }, "U-W": { value: "normal" } }, {
      "U-F": { kind: "pending", currentGeneration: 3, savedGeneration: 1,
        savedCapturedAt: 1, savedAckAt: 2, dirtySince: 0 },
      "U-W": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 50 },
    });
    adapter.fail = "write";
    let scheduled = schedule(root, driver, state, { wallTimeMs: 10_100, monotonicMs: now }, "run",
      { "U-F": correlation, "U-W": correlation })!;
    let executed = await root.executeCheckpoint(scheduled.request!, "run", correlation.inputIds, correlation.retryReason);
    state = root.applyCheckpointResult(state, executed.result, { wallTimeMs: 10_100, monotonicMs: now }).state;
    expect(root.checkpoint.retryAfter("U-F")).toBe(1_100);

    adapter.fail = null;
    scheduled = schedule(root, driver, state, { wallTimeMs: 10_101, monotonicMs: 101 }, "run",
      { "U-F": { ...correlation, retryReason: "saveFailed" }, "U-W": correlation })!;
    expect(scheduled.request?.unit).toBe("U-W");
    executed = await root.executeCheckpoint(scheduled.request!, "run", correlation.inputIds, correlation.retryReason);
    expect(executed.measurements.at(-1)!.endedMonotonicMs - state.units["U-W"].persistence!.dirtySince!)
      .toBeLessThanOrEqual(3_000);
    state = root.applyCheckpointResult(state, executed.result, { wallTimeMs: 10_102, monotonicMs: 102 }).state;
    expect(state.units["U-W"].persistence?.kind).toBe("saved");

    adapter.fail = "write";
    for (const nextDelay of [2_000, 4_000, 8_000, 10_000, 10_000]) {
      const due = root.checkpoint.retryAfter("U-F")!;
      expect(schedule(root, driver, state, { wallTimeMs: 20_000, monotonicMs: due - 1 }, "run",
        { "U-F": { ...correlation, retryReason: "saveFailed" } })).toBeNull();
      now = due;
      scheduled = schedule(root, driver, state, { wallTimeMs: 20_000 + now, monotonicMs: now }, "run",
        { "U-F": { ...correlation, retryReason: "saveFailed" } })!;
      executed = await root.executeCheckpoint(scheduled.request!, "run", correlation.inputIds, "saveFailed");
      state = root.applyCheckpointResult(state, executed.result, { wallTimeMs: 20_000 + now, monotonicMs: now }).state;
      expect(root.checkpoint.retryAfter("U-F")).toBe(now + nextDelay);
    }
    await root.diagnostics.flush();
  });

  it("P2-A3-T05 acceptance / AC05: encode failure, successful stages and idle all have exact attribution", async () => {
    const path = await directory();
    let fail = true;
    let now = 0;
    const driver = fixtureDriver();
    const adapter = new MemoryCheckpointFileSystem();
    const root = new RuntimeCompositionRoot(config(path), { "U-F": codec("U-F", undefined, () => fail) }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: adapter,
      runtimeCalls: driver.calls,
      clock: () => ({ wallTimeMs: 1_000 + now, monotonicMs: now++ }),
    });
    let state = pending({ "U-F": { value: "payload" } }, { "U-F": { kind: "pending",
      currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } });
    const failed = schedule(root, driver, state, { wallTimeMs: 1_000, monotonicMs: 0 }, "run-5",
      { "U-F": correlation })!;
    expect(failed.capture).toEqual({ attemptId: failed.result!.attemptId, unit: "U-F", generation: 1,
      capturedAt: 1_002 });
    expect(root.state.checkpointAttempts["U-F"]).toMatchObject(failed.capture);
    expect(failed).toMatchObject({ request: null, result: { stage: "encode", encodedByteLength: 0 },
      measurements: [{ runId: "run-5", inputIds: ["input-1"], unit: "U-F", generation: 1,
        stage: "encode", bytes: 0, outcome: "failed", retryReason: "notRetry" }] });
    const failedStep = root.applyCheckpointResult(state, failed.result!, { wallTimeMs: 1_001, monotonicMs: 1 });
    expect((await root.readDiagnostics({ limit: 256 })).records.map((event) => event.reason)).toContain("checkpointEncodeFailed");
    state = failedStep.state;
    expect(state.checkpointAttempts["U-F"]).toBeUndefined();
    expect(state.units["U-F"].persistence).toMatchObject({ kind: "failed", stage: "encode" });

    fail = false;
    const due = root.checkpoint.retryAfter("U-F")!;
    const succeeded = schedule(root, driver, state, { wallTimeMs: 2_000, monotonicMs: due }, "run-5",
      { "U-F": { inputIds: ["input-1"], retryReason: "saveFailed" } })!;
    expect(succeeded.measurements).toHaveLength(1);
    expect(succeeded.measurements[0]).toMatchObject({ stage: "encode", outcome: "succeeded",
      attemptId: succeeded.request?.attemptId });
    const output = await root.executeCheckpoint(succeeded.request!, "run-5", ["input-1"], "saveFailed");
    expect(output.measurements.map((measurement) => measurement.stage)).toEqual([
      "write", "fileSync", "close", "rename", "directorySync",
    ]);
    expect(output.measurements.every((measurement) => measurement.attemptId === succeeded.request?.attemptId
      && measurement.unit === "U-F" && measurement.generation === 1
      && measurement.inputIds[0] === "input-1" && measurement.retryReason === "saveFailed")).toBe(true);
    state = root.applyCheckpointResult(state, output.result, { wallTimeMs: 2_001, monotonicMs: due + 1 }).state;
    expect(schedule(root, driver, state, { wallTimeMs: 2_002, monotonicMs: due + 2 }, "run-5", {})).toBeNull();
    await root.diagnostics.flush();
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
      const driver = fixtureDriver();
      const root = new RuntimeCompositionRoot(config(path), { "U-F": codec("U-F") }, { notificationAdapter: recordingNotificationAdapter(),
        checkpointFileSystem: adapter, runtimeCalls: driver.calls,
        clock: () => ({ wallTimeMs: 1_000, monotonicMs: 1 }),
      });
      const state = pending({ "U-F": { value: "payload" } }, { "U-F": { kind: "pending",
        currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } });
      const scheduled = schedule(root, driver, state, { wallTimeMs: 1_000, monotonicMs: 1 }, "stages",
        { "U-F": correlation })!;
      const output = await root.executeCheckpoint(scheduled.request!, "stages", correlation.inputIds, correlation.retryReason);
      const step = root.applyCheckpointResult(state, output.result, { wallTimeMs: 1_001, monotonicMs: 2 });
      if (stage === "verify") {
        adapter.fail = "verify";
        await root.resolveUncertain(step.state, "U-F", scheduled.request!.attemptId, { wallTimeMs: 1_002, monotonicMs: 3 });
      }
      expect((await root.readDiagnostics({ limit: 256 })).records.map((event) => event.reason)).toContain(reason);
      if (stage === "directorySync") expect((await root.readDiagnostics({ limit: 256 })).records.map((event) => event.reason)).toContain("checkpointUncertain");
      await root.diagnostics.flush();
    }
  });

  it("P2-A3-T08 contractBoundary / AC08: full-byte hash, two slots, schema and decode gate restoration", async () => {
    const path = await directory();
    let now = 1;
    const driver = fixtureDriver();
    const root = new RuntimeCompositionRoot(config(path), { "U-F": codec("U-F") }, { notificationAdapter: recordingNotificationAdapter(),
      runtimeCalls: driver.calls,
      clock: () => ({ wallTimeMs: 1_000 + now, monotonicMs: now++ }),
    });
    let state = pending({ "U-F": { value: "same" } }, { "U-F": { kind: "pending",
      currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } });
    let scheduled = schedule(root, driver, state, { wallTimeMs: 1_000, monotonicMs: 1 }, "hash",
      { "U-F": correlation })!;
    let output = await root.executeCheckpoint(scheduled.request!, "hash", correlation.inputIds, correlation.retryReason);
    state = root.applyCheckpointResult(state, output.result, { wallTimeMs: 1_001, monotonicMs: 2 }).state;
    state = driver.update(root, pending({ "U-F": { value: "same" } }, { "U-F": { ...state.units["U-F"].persistence!, kind: "pending",
      currentGeneration: 9, dirtySince: 3 } }), { wallTimeMs: 3, monotonicMs: 3 }, { "U-F": correlation });
    scheduled = schedule(root, driver, state, { wallTimeMs: 1_002, monotonicMs: 3 }, "hash",
      { "U-F": correlation })!;
    output = await root.executeCheckpoint(scheduled.request!, "hash", correlation.inputIds, correlation.retryReason);
    root.applyCheckpointResult(state, output.result, { wallTimeMs: 1_003, monotonicMs: 4 });
    expect(root.restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "B", envelope: { generation: 9 } });

    const newerPath = join(path, "state", "U-F-B.json");
    const original = JSON.parse(await fileSystem.readFile(newerPath, "utf8")) as Record<string, unknown>;
    for (const changed of [
      { ...original, generation: 8 }, { ...original, unit: "U-W" },
      { ...original, schemaVersion: "other" }, { ...original, capturedAt: 0 },
    ]) {
      await fileSystem.writeFile(newerPath, JSON.stringify(changed));
      expect(root.restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 1 } });
    }

    await fileSystem.writeFile(join(path, "state", "U-F-A.json"), "invalid");
    const unknown = hashEnvelope({ schemaVersion: "future-v2", unit: "U-F", generation: 9,
      capturedAt: 1, payload: { value: "same", sha256: "payload-field" } });
    await fileSystem.writeFile(newerPath, serializedEnvelope(unknown));
    expect(root.restoreUnit("U-F")).toEqual({ kind: "unavailable", reason: "unknownSchema" });

    const invalid = hashEnvelope({ schemaVersion: "test-v1", unit: "U-F", generation: 9,
      capturedAt: 1, payload: { invalid: true } });
    await fileSystem.writeFile(newerPath, serializedEnvelope(invalid));
    expect(root.restoreUnit("U-F")).toEqual({ kind: "unavailable", reason: "noValidSlot" });
    await root.diagnostics.flush();
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

function p3Root(path: string, adapter: CheckpointFileSystem) {
  const driver = fixtureDriver();
  const root = new RuntimeCompositionRoot(config(path), { "U-F": codec("U-F") }, { notificationAdapter: recordingNotificationAdapter(),
    checkpointFileSystem: adapter, runtimeCalls: driver.calls, clock: () => ({ wallTimeMs: 5_000, monotonicMs: 500 }) });
  driver.update(root, pending(), { wallTimeMs: 5_000, monotonicMs: 500 }); // starts the runtime (its restore reads happen here)
  // Saves generation g (reserve, execute, adopt) and returns the next state and the execute output.
  const save = async (previous: RuntimeState, generation: number, at: number,
    retryReason: "notRetry" | "saveFailed" | "ackUncertain" = "notRetry") => {
    const before = previous.units["U-F"].persistence;
    const next = pending({ "U-F": { value: `v${generation}` } }, { "U-F": { kind: "pending", currentGeneration: generation,
      savedGeneration: generation === 1 ? null : before?.savedGeneration ?? null,
      savedCapturedAt: generation === 1 ? null : before?.savedCapturedAt ?? null,
      savedAckAt: generation === 1 ? null : before?.savedAckAt ?? null, dirtySince: at } });
    const clock = { wallTimeMs: 5_000 + at, monotonicMs: at };
    const scheduled = schedule(root, driver, next, clock, "p3c1", { "U-F": { ...correlation, retryReason } })!;
    const output = await root.executeCheckpoint(scheduled.request!, "p3c1", correlation.inputIds, retryReason);
    return { scheduled, output, state: root.applyCheckpointResult(next, output.result,
      { wallTimeMs: 5_001 + at, monotonicMs: at + 1 }).state };
  };
  return { root, driver, save };
}

describe("P3-C1 checkpoint step 1", () => {
  const initial = () => pending({ "U-F": { value: "" } });
  const slotsWritten = (adapter: RecordingFileSystem) => adapter.calls.filter((call) => call.startsWith("rename:"))
    .map((call) => call.slice(-6, -5));

  it("P3-C1-T01 acceptance / AC01: after restoreUnit(empty), g1-g3 read nothing and alternate A, B, A", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { root, save } = p3Root(path, adapter);
    expect(root.restoreUnit("U-F")).toEqual({ kind: "empty" });
    adapter.calls.length = 0;
    let state = initial();
    for (const generation of [1, 2, 3]) {
      const saved = await save(state, generation, generation * 10);
      expect(saved.output.result.kind).toBe("acknowledged");
      state = saved.state;
    }
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(0);
    expect(slotsWritten(adapter)).toEqual(["A", "B", "A"]);
    const fresh = new RuntimeCompositionRoot(config(path), { "U-F": codec("U-F") }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: adapter, runtimeCalls: fixtureDriver().calls, clock: () => ({ wallTimeMs: 6_000, monotonicMs: 600 }) });
    expect(fresh.restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 3 } });
    await root.diagnostics.flush();
  });

  it("P3-C1-T02 contractBoundary / AC02: after a failed reconciliation the next attempt reads A and B once, then reads return to 0", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { root, save } = p3Root(path, adapter);
    root.restoreUnit("U-F");
    adapter.fail = "rename"; // the name is not replaced: reconciliation finds no g1 and fails
    const first = await save(initial(), 1, 10);
    expect(first.output.result).toMatchObject({ kind: "uncertain", stage: "rename" });
    const reconciled = await root.resolveUncertain(first.state, "U-F", first.scheduled.request!.attemptId,
      { wallTimeMs: 5_020, monotonicMs: 20 });
    expect(reconciled.state.units["U-F"].persistence).toMatchObject({ kind: "failed" });
    adapter.fail = null;
    adapter.calls.length = 0;
    const retry = await save(reconciled.state, 1, root.checkpoint.retryAfter("U-F")!, "ackUncertain");
    expect(retry.output.result.kind).toBe("acknowledged");
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(2);
    expect(retry.output.measurements.map((measurement) => measurement.stage))
      .toEqual(["write", "fileSync", "close", "rename", "directorySync"]);
    adapter.calls.length = 0;
    const next = await save(retry.state, 2, 30_000);
    expect(next.output.result.kind).toBe("acknowledged");
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(0);
    await root.diagnostics.flush();
  });

  it("P3-C1-T02 contractBoundary / AC02: a restoreUnit failing during the same-generation directory sync is overridden by the ack; the next save reads nothing", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { root, save } = p3Root(path, adapter);
    root.restoreUnit("U-F");
    // g1 reaches its slot but the directory sync fails, and the reconciliation cannot read: g1 is retried as is.
    adapter.fail = "directorySync";
    const first = await save(initial(), 1, 10);
    expect(first.output.result).toMatchObject({ kind: "uncertain", stage: "directorySync" });
    adapter.fail = null;
    adapter.readFails = true;
    const reconciled = await root.resolveUncertain(first.state, "U-F", first.scheduled.request!.attemptId,
      { wallTimeMs: 5_020, monotonicMs: 20 });
    adapter.readFails = false;
    expect(reconciled.state.units["U-F"].persistence).toMatchObject({ kind: "failed" });
    let release!: () => void;
    adapter.syncGate = new Promise<void>((resolve) => { release = resolve; });
    adapter.calls.length = 0;
    const retry = save(reconciled.state, 1, root.checkpoint.retryAfter("U-F")!, "ackUncertain");
    while (!adapter.calls.includes("syncDirectory")) await new Promise((resolve) => setImmediate(resolve));
    // While the found g1 slot's directory sync waits, a public restore fails once and drops the memory.
    adapter.readFails = true;
    expect(root.restoreUnit("U-F")).toMatchObject({ kind: "unavailable" });
    adapter.readFails = false;
    release();
    const retried = await retry;
    expect(retried.output.result.kind).toBe("acknowledged");
    expect(retried.output.measurements.map((measurement) => measurement.stage)).toEqual(["directorySync", "verify"]);
    adapter.syncGate = null;
    adapter.calls.length = 0;
    const next = await save(retried.state, 2, 30_000);
    expect(next.output.result.kind).toBe("acknowledged");
    expect(adapter.calls.filter((call) => call === "readFile")).toHaveLength(0);
    await root.diagnostics.flush();
  });

  it("P3-C1-T03 contractBoundary / AC03: one envelope stringify per new capture, bytes equal P2's, none on a same-generation retry", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { root, save } = p3Root(path, adapter);
    root.restoreUnit("U-F");
    const stringify = vi.spyOn(JSON, "stringify");
    const envelopeCalls = () => stringify.mock.calls.filter(([value]) => value != null && typeof value === "object" && "payload" in value).length;
    let retry: Awaited<ReturnType<typeof save>>;
    try {
      adapter.fail = "write";
      const failed = await save(initial(), 1, 10);
      expect(failed.output.result.kind).toBe("failed");
      expect(envelopeCalls()).toBe(1); // the capture's single serialization; the range checks pass numbers
      adapter.fail = null;
      stringify.mockClear();
      retry = await save(failed.state, 1, root.checkpoint.retryAfter("U-F")!, "saveFailed");
      expect(retry.output.result.kind).toBe("acknowledged");
      expect(envelopeCalls()).toBe(0); // the retained bytes are reused
    } finally { stringify.mockRestore(); }
    const request = retry.scheduled.request!;
    const { sha256: _hash, ...unhashed } = request.envelope;
    expect(adapter.files.get(join(path, "state", "U-F-A.json")))
      .toEqual(serializedEnvelope(hashEnvelope(unhashed)));
    expect(request.encodedByteLength).toBe(serializedEnvelope(request.envelope).byteLength);
    expect(root.restoreUnit("U-F")).toMatchObject({ kind: "restored", envelope: { generation: 1, sha256: request.envelope.sha256 } });
    await root.diagnostics.flush();
  });

  it("P3-C1-T04 acceptance / AC04: a steady save is open, write, sync, close, rename, syncDirectory and waits for the directory sync", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { root, driver } = p3Root(path, adapter);
    const state = pending({ "U-F": { value: "v1" } }, { "U-F": { kind: "pending", currentGeneration: 1,
      savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 10 } });
    const scheduled = schedule(root, driver, state, { wallTimeMs: 5_010, monotonicMs: 10 }, "p3c1", { "U-F": correlation })!;
    adapter.calls.length = 0; // the first dispatch started the runtime (restoreUnit reads); only the save is recorded
    let release!: () => void;
    adapter.syncGate = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const running = root.executeCheckpoint(scheduled.request!, "p3c1", correlation.inputIds, "notRetry")
      .then((output) => { settled = true; return output; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.calls).toEqual(["unlink", "unlink", "unlink", "open", "write", "sync", "close", "rename:A.json", "syncDirectory"]);
    expect(settled).toBe(false);
    release();
    expect((await running).result.kind).toBe("acknowledged");
    await root.diagnostics.flush();
  });

  // A slot placed from outside; restoreUnit teaches the writer what is on disk before the g1 request executes.
  const placed = async (generation: number, payload: string) => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const { root, driver } = p3Root(path, adapter);
    const state = pending({ "U-F": { value: "v1" } }, { "U-F": { kind: "pending", currentGeneration: 1,
      savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 10 } });
    const scheduled = schedule(root, driver, state, { wallTimeMs: 5_010, monotonicMs: 10 }, "p3c1", { "U-F": correlation })!;
    adapter.files.set(join(path, "state", "U-F-A.json"), serializedEnvelope(hashEnvelope({
      schemaVersion: "test-v1", unit: "U-F", generation, capturedAt: 1, payload: { value: payload } })));
    root.restoreUnit("U-F");
    adapter.calls.length = 0;
    const output = await root.executeCheckpoint(scheduled.request!, "p3c1", correlation.inputIds, "notRetry");
    await root.diagnostics.flush();
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
