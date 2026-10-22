import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClockReading, DiagnosticEvent, InputBoundary, InputHole, JsonValue, LossTally, RuntimeUnitId, RuntimeUnitStates, UnitCodec, UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { CheckpointCoordinator, INPUT_BOUNDARY_MAX_BYTES, InputBoundaries, dmdataIdOf, hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { ingestXmlData } from "../../src/ingress/ingress";
import type { CheckpointFileSystem, CodecMap, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import { linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { harnessedRoot, startHarness } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

import { fixtureState, fixtureValue, fixtureDriver, recordingNotificationAdapter, stringCodec } from "./runtime-fixture";
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

// The write rights due now and the owner's checkpointDone replies since the previous look, the immediate saves after
// inputs included (P3-UWR-AC03, AC10(7)).
async function granted(h: Harness) {
  const released = h.root.driveCheckpoint();
  await h.settle();
  await released;
  return h.newDone();
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
    await startHarness(h, "o10", now);
    adapter.fail = "directorySync";
    // The owner captures g2 at the g2 input's immediate grant (P3-UWR-AC03) and starts writing; g3 arrives with a deadline
    // request (never held, P3-UWR-AC04) before the write ends.
    h.pause();
    driver.queue(h, pending({ "U-F": { value: "active" } }, { "U-F": { kind: "pending",
      currentGeneration: 2, savedGeneration: 1, savedCapturedAt: 1, savedAckAt: 2, dirtySince: 10 } }, "o10"), now,
    { "U-F": correlation.inputIds });
    h.root.pump();
    h.flush();
    const before = h.unit("U-F").persistence;
    now = { wallTimeMs: 5_001, monotonicMs: 501 };
    driver.queue(h, pending({ "U-F": { value: "cancelled" } }, { "U-F": { ...before,
      kind: "pending", currentGeneration: 3, dirtySince: 501 } }, "o10"), now);
    h.root.tick(now);
    h.flush();
    // The immediate reconciliation after the uncertain reply waits until the fault is cleared.
    const holding = h.holdRequests((_place, request) => request.kind === "checkpointGrant");
    await h.settle();
    expect(h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" ? [reply.result] : []))
      .toMatchObject([{ kind: "uncertain", generation: 2, stage: "directorySync" }]);
    expect(h.unit("U-F")).toMatchObject({ value: "cancelled",
      persistence: { kind: "uncertain", currentGeneration: 3, attemptedGeneration: 2 } });
    adapter.fail = null;
    now = { wallTimeMs: 5_002, monotonicMs: 502 };
    // Only the reconciliation runs: the g3 save its ack would start at once is kept from the owner.
    holding();
    h.holdRequests((_place, request) => request.kind === "checkpointGrant" && request.mode === "save");
    h.releaseRequests("deferred");
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
    const dirty = (units: readonly ("U-F" | "U-W")[]) => pending({ "U-F": { value: "cancelled" },
      ...(units.includes("U-W") ? { "U-W": { value: "normal" } } : {}) }, {
      "U-F": { kind: "pending", currentGeneration: 3, savedGeneration: 1,
        savedCapturedAt: 1, savedAckAt: 2, dirtySince: 0 },
      ...(units.includes("U-W") ? { "U-W": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 50 } } : {}),
    }, "run");
    // U-F's input saves at once (P3-UWR-AC03) under the write fault; U-W becomes dirty after the fault is cleared.
    adapter.fail = "write";
    await driver.update(h, dirty(["U-F"]), undefined, { "U-F": correlation.inputIds });
    expect((await granted(h)).map((reply) => reply.unit)).toEqual(["U-F"]);
    expect(h.root.checkpoint.retryAfter("U-F")).toBe(1_100);

    adapter.fail = null;
    now = 101;
    const dirtySince = 50;
    await driver.update(h, dirty(["U-F", "U-W"]), undefined, { "U-F": correlation.inputIds, "U-W": correlation.inputIds });
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
      // verify: the uncertain save's reply waits until the verify fault is set, so its immediate reconciliation (P3-UWR-AC03) reads it.
      const holding = stage === "verify" ? h.hold((_place, reply) => reply.kind === "checkpointDone") : null;
      await driver.update(h, pending({ "U-F": { value: "payload" } }, { "U-F": { kind: "pending",
        currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } }, "stages"),
      clock, { "U-F": correlation.inputIds });
      await granted(h);
      if (holding != null) {
        adapter.fail = "verify";
        holding();
        h.release();
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
      capturedAt: 1, payload: { invalid: true }, inputBoundary: null });
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
      schemaVersion: "test-v1", unit: "U-F", generation, capturedAt: 1, payload: { value: payload }, inputBoundary: null })));
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

describe("P3-VM K7 order 1: the restore entrance and the input boundary", () => {
  it("P3-VM-T05 acceptance / AC05: discardable old slots start empty and are overwritten; a slot of an unknown version is never written", async () => {
    const path = await directory();
    const adapter = new MemoryCheckpointFileSystem();
    const codecs = { "U-F": { ...codec("U-F"), discardableSchemaVersions: ["test-v0"] } };
    const file = (side: "A" | "B") => join(path, "state", `U-F-${side}.json`);
    const put = (side: "A" | "B", schemaVersion: string, generation: number) => adapter.files.set(file(side),
      serializedEnvelope(hashEnvelope({ schemaVersion, unit: "U-F", generation, capturedAt: 1, payload: { value: `g${generation}` }, inputBoundary: null })));
    const versionOf = (side: "A" | "B") => (JSON.parse(new TextDecoder().decode(adapter.files.get(file(side)))) as { schemaVersion: string }).schemaVersion;
    // One run's owner-side coordinator over the same files, and one granted save as the owner runs it.
    const run = () => {
      const events: DiagnosticEvent[] = [];
      const coordinator = new CheckpointCoordinator(join(path, "state"), codecs, adapter, () => ({ wallTimeMs: 5_000, monotonicMs: 5 }),
        (event) => { events.push(event); });
      const save = async (generation: number) => {
        const captured = coordinator.capture("U-F", pending({ "U-F": { value: `v${generation}` } }).units["U-F"], generation, "k7", correlation);
        if (captured.request == null) throw new Error("checkpoint not captured");
        const output = await coordinator.executeCheckpoint(captured.request, "k7", correlation.inputIds, "notRetry");
        coordinator.ended(output.result, false);
        return output.result.kind;
      };
      const discarded = () => events.filter((event) => event.reason === "checkpointSchemaDiscarded");
      return { coordinator, save, discarded };
    };

    // (1) old slots only: empty, one INFO, and the first save overwrites an old slot.
    put("A", "test-v0", 3);
    put("B", "test-v0", 4);
    const first = run();
    expect(first.coordinator.restoreUnit("U-F")).toEqual({ kind: "empty" });
    expect(first.discarded()).toMatchObject([{ level: "INFO", unit: "U-F", component: "checkpoint.test-v0" }]);
    expect(await first.save(1)).toBe("acknowledged");
    expect([versionOf("A"), versionOf("B")]).toEqual(["test-v1", "test-v0"]);
    // (2) current A and old B after that save: A is restored and the next save overwrites B.
    const second = run();
    expect(second.coordinator.restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 1 } });
    expect(await second.save(2)).toBe("acknowledged");
    expect([versionOf("A"), versionOf("B")]).toEqual(["test-v1", "test-v1"]);
    // (3) a version outside the list beside the current one: the current slot is restored, the unit saves nothing this run.
    put("B", "future-v9", 9);
    const future = adapter.files.get(file("B"));
    const third = run();
    expect(third.coordinator.restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 1 } });
    expect(third.coordinator.saves("U-F")).toBe(false);
    expect(third.discarded()).toEqual([]);
    expect(adapter.files.get(file("B"))).toBe(future);
    // A save whose writer does not know the slots re-reads them first; finding the unknown version there, it writes nothing.
    expect([await run().save(10), adapter.files.get(file("B")) === future]).toEqual(["failed", true]);
    // (4) a broken slot beside an old one: empty, and the first save overwrites.
    adapter.files.set(file("A"), new TextEncoder().encode("invalid"));
    put("B", "test-v0", 5);
    const fourth = run();
    expect(fourth.coordinator.restoreUnit("U-F")).toEqual({ kind: "empty" });
    expect(fourth.discarded()).toHaveLength(1);
    expect(await fourth.save(1)).toBe("acknowledged");
    expect(run().coordinator.restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 1 } });
  });

  it("P3-VM-T05 acceptance / AC05 (3): beside a slot of an unknown version the publisher grants no save for the run, and the stop is diagnosed", async () => {
    const path = await directory();
    const codecs = { "U-F": stringCodec("U-F") };
    const state = join(path, "state");
    await fileSystem.mkdir(state, { recursive: true });
    await fileSystem.writeFile(join(state, "U-F-A.json"), serializedEnvelope(hashEnvelope({ schemaVersion: codecs["U-F"].schemaVersion,
      unit: "U-F", generation: 1, capturedAt: 1, payload: "g1", inputBoundary: null })));
    const future = serializedEnvelope(hashEnvelope({ schemaVersion: "future-v9", unit: "U-F", generation: 9, capturedAt: 1, payload: "g9" }));
    await fileSystem.writeFile(join(state, "U-F-B.json"), future);
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const { h, driver } = wired(path, codecs, () => now);
    await driver.update(h, pending({ "U-F": "next" }, { "U-F": { kind: "pending", currentGeneration: 2, savedGeneration: 1,
      savedCapturedAt: 1, savedAckAt: null, dirtySince: 0 } }, "frozen"), now, { "U-F": correlation.inputIds });
    await granted(h);
    expect(h.root.state.restoration["U-F"]).toEqual({ kind: "restored" });
    expect(h.root.state.mirror["U-F"].persistence).toMatchObject({ currentGeneration: 2, savedGeneration: 1 });
    expect(h.sent.filter(({ request }) => request.kind === "checkpointGrant" && request.unit === "U-F")).toEqual([]);
    expect(new Uint8Array(await fileSystem.readFile(join(state, "U-F-B.json")))).toEqual(future);
    await h.root.diagnostics.flush();
    expect(await reasons(h)).toContain("checkpointRestoreRejected");
  });

  it("P3-VM-T06 contractBoundary / AC06 (5)(7): the boundary travels with its own generation; an envelope without the field reads as unknown", () => {
    const adapter = new MemoryCheckpointFileSystem();
    const coordinator = () => new CheckpointCoordinator("/state", { "U-F": codec("U-F") }, adapter, () => ({ wallTimeMs: 0, monotonicMs: 0 }), () => {});
    const at = (dmdataId: string, oldestHole: InputHole | null) => ({ receivedAt: { wallTimeMs: 1_000, basis: null }, dmdataTime: null, dmdataId, oldestHole });
    const put = (side: "A" | "B", generation: number, boundary: Readonly<{ inputBoundary?: ReturnType<typeof at> }>) =>
      adapter.files.set(join("/state", `U-F-${side}.json`), serializedEnvelope(hashEnvelope({ schemaVersion: "test-v1", unit: "U-F",
        generation, capturedAt: 1, payload: { value: `g${generation}` }, ...boundary })));
    put("A", 1, { inputBoundary: at("id-1", null) });
    put("B", 2, { inputBoundary: at("id-1", "refused") });
    expect(coordinator().restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "B", envelope: { inputBoundary: at("id-1", "refused") } });
    // (5) a broken newer slot: the older slot comes back with the boundary of its own generation.
    adapter.files.set(join("/state", "U-F-B.json"), new TextEncoder().encode("invalid"));
    expect(coordinator().restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A", envelope: { inputBoundary: at("id-1", null) } });
    // An id outside printable ASCII is a broken slot, as ingress would never carry it.
    put("B", 4, { inputBoundary: at("id 4", null) });
    expect(coordinator().restoreUnit("U-F")).toMatchObject({ kind: "restored", slot: "A" });
  });

  it("P3-VM-AC06 contractBoundary: an input boundary adds at most INPUT_BOUNDARY_MAX_BYTES to the envelope a unit bounds", () => {
    const bytes = (boundary: Readonly<{ inputBoundary?: InputBoundary | null }>) => serializedEnvelope(hashEnvelope({ schemaVersion: "test-v1",
      unit: "U-F", generation: 1, capturedAt: 1, payload: { value: "v" }, ...boundary })).byteLength;
    // The longest JSON of a finite number: sign, "0." and five zeros, then 17 digits.
    const longest = -0.0000012345678901234567;
    expect(JSON.stringify(longest)).toHaveLength(25);
    expect(JSON.stringify(Number.MAX_VALUE).length).toBeLessThan(25);
    const worst: InputBoundary = { receivedAt: { wallTimeMs: longest, basis: "unverified" }, dmdataTime: longest, dmdataId: '"'.repeat(128), oldestHole: "disconnected" };
    expect(bytes({ inputBoundary: worst }) - bytes({})).toBe(INPUT_BOUNDARY_MAX_BYTES);
    expect(bytes({ inputBoundary: null }) - bytes({})).toBeLessThan(INPUT_BOUNDARY_MAX_BYTES);
    // Only printable ASCII ids of 1 to 128 bytes travel, so 128 escaped quotes are the longest id.
    expect(dmdataIdOf("~".repeat(128))).toBe("~".repeat(128));
    expect([dmdataIdOf("a".repeat(129)), dmdataIdOf(""), dmdataIdOf("id 1"), dmdataIdOf("ｉｄ"), dmdataIdOf(1)]).toEqual([null, null, null, null, null]);
  });

  it("P3-VM-AC06 contractBoundary: capture writes an envelope at the unit's limit and fails one byte over it at stage encode without writing", async () => {
    const path = await directory();
    const adapter = new RecordingFileSystem();
    const value = pending({ "U-F": { value: "v1" } }).units["U-F"];
    const coordinator = (maxEnvelopeBytes: number) => new CheckpointCoordinator(join(path, "state"), { "U-F": { ...codec("U-F"), maxEnvelopeBytes } },
      adapter, () => ({ wallTimeMs: 1_000, monotonicMs: 1 }), () => {});
    const size = coordinator(Number.MAX_SAFE_INTEGER).capture("U-F", value, 1, "k7", correlation).request!.encodedByteLength;
    adapter.calls.length = 0;
    const over = coordinator(size - 1).capture("U-F", value, 1, "k7", correlation);
    expect(over).toMatchObject({ request: null, result: { kind: "failed", stage: "encode", encodedByteLength: 0 } });
    const at = coordinator(size);
    const captured = at.capture("U-F", value, 1, "k7", correlation);
    expect(captured.request?.encodedByteLength).toBe(size);
    expect(adapter.calls.filter((call) => call === "open")).toEqual([]);
    expect((await at.executeCheckpoint(captured.request!, "k7", correlation.inputIds, "notRetry")).result.kind).toBe("acknowledged");
  });

  // A WebSocket data frame through ingress, as the host receives it.
  const wsItem = (inputSequence: number, headType: string, id: unknown, origin: "live" | "recovery" = "live") => {
    const frame = Buffer.from(JSON.stringify({ type: "data", id, format: "xml", encoding: "utf-8", compression: null,
      head: { type: headType, test: false }, body: "<Report/>" }));
    const entered = ingestXmlData({ kind: "ws", inputId: `in-${inputSequence}`, inputSequence, receivedAt: 1_000 + inputSequence, origin, frame });
    if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
    return entered.item;
  };
  const boundaryAt = (sequence: number, oldestHole: InputHole | null = null) => ({ receivedAt: { wallTimeMs: 1_000 + sequence, basis: null },
    dmdataTime: null, dmdataId: `id-${sequence}`, oldestHole });

  it("P3-VM-T06 contractBoundary / AC07 (1)(3)(4)(6): the boundary stops before the oldest unresolved input of its unit", () => {
    const boundaries = new InputBoundaries();
    expect(boundaries.boundary("U-T")).toBeNull();
    boundaries.queued(wsItem(9, "VTSE51", "id-9"), null);
    boundaries.completed(9);
    boundaries.queued(wsItem(10, "VTSE52", "id-10"), null);
    boundaries.queued(wsItem(11, "VTSE41", "id-11"), null);
    // (1) the later VTSE41 is handled first by priority: the boundary does not pass the waiting 10.
    boundaries.completed(11);
    expect(boundaries.boundary("U-T")).toEqual(boundaryAt(9));
    // (6) once 10 completes nothing is unresolved and the boundary is the last input of the unit.
    boundaries.completed(10);
    expect(boundaries.boundary("U-T")).toEqual(boundaryAt(11));
    // (3) a recovery input is not part of the list.
    boundaries.queued(wsItem(12, "VTSE41", "id-12", "recovery"), null);
    expect(boundaries.boundary("U-T")).toEqual(boundaryAt(11));
    expect(wsItem(13, "VTSE41", "x".repeat(129)).dmdataId).toBeNull();
    // (4) later holes (another refusal, a disconnect) after more inputs: the oldest hole's position and kind stay.
    boundaries.refused(wsItem(20, "VTSE41", "id-20"), null);
    boundaries.queued(wsItem(21, "VTSE41", "id-21"), null);
    boundaries.completed(21);
    boundaries.refused(wsItem(22, "VTSE41", "id-22"), null);
    boundaries.disconnected(22);
    expect(boundaries.boundary("U-T")).toEqual(boundaryAt(11, "refused"));
    expect(boundaries.boundary("U-Q")).toBeNull();
  });
});

// P3-NL-T06（P3-NL-AC14 の発注 1 の行。owner の数え方は発注 2）: 欄の無い旧い envelope は空として読み、lastAt＋24 時間を過ぎた行は capture で外れる。
it("P3-NL-T06 contractBoundary / AC14: an envelope without losses reads empty, and rows past lastAt + 24 h leave at capture", async () => {
  const path = await directory(), DAY = 86_400_000, now = { wallTimeMs: 100_000_000, monotonicMs: 1 };
  const coordinator = new CheckpointCoordinator(path, { "U-F": codec("U-F") }, nodeCheckpointFileSystem(), () => now, () => {});
  let generation = 0;
  const save = async (losses: readonly LossTally[]) => {
    const captured = coordinator.capture("U-F", pending({ "U-F": { value: "v" } }).units["U-F"], ++generation, "t06", correlation, null, losses);
    const output = await coordinator.executeCheckpoint(captured.request!, "t06", correlation.inputIds, "notRetry");
    coordinator.ended(output.result, false);
    const restored = coordinator.restoreUnit("U-F");
    if (restored.kind !== "restored") throw new Error("the saved slot does not restore");
    return restored.envelope;
  };
  expect(await save([])).not.toHaveProperty("losses");
  const kept = { reason: "notificationOutcomeUnknown" as const, count: 1, lastAt: now.wallTimeMs - DAY + 1 };
  expect((await save([{ reason: "notificationExpired", count: 3, lastAt: now.wallTimeMs - DAY }, kept])).losses).toEqual([kept]);
});

// P3-NL-T07（P3-NL-AC15 の発注 1 の行）: 12 unit とも、形を変えた前の版の slot は捨てて初期状態から始める（印・失敗の印・lastAttempt・
// priorityGroup を含む新しい形の保存→復元は各 unit の試験が持つ）。
it("P3-NL-T07 contractBoundary / AC15: every unit discards a slot of its previous schema and starts empty", async () => {
  const path = await directory();
  await fileSystem.mkdir(path, { recursive: true });
  const units: readonly RuntimeUnitId[] = ["U-E", "U-W", "U-F", "U-T", "U-Q", "U-N", "U-V", "U-L", "U-R", "U-B", "U-M", "U-Y"];
  for (const unit of units) {
    const previous = linkedUnitCodecs[unit]?.discardableSchemaVersions?.at(-1) ?? "";
    await fileSystem.writeFile(join(path, `${unit}-A.json`), serializedEnvelope(hashEnvelope({ schemaVersion: previous, unit, generation: 1, capturedAt: 1,
      payload: {} })));
    const events: DiagnosticEvent[] = [];
    const restored = new CheckpointCoordinator(path, linkedUnitCodecs, nodeCheckpointFileSystem(), () => ({ wallTimeMs: 1, monotonicMs: 1 }),
      (event) => { events.push(event); }).restoreUnit(unit);
    expect([unit, previous !== "", restored.kind, events.some((event) => event.reason === "checkpointSchemaDiscarded")]).toEqual([unit, true, "empty", true]);
  }
});
