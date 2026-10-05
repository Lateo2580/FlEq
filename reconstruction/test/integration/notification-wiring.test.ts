import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { ClockReading, NotificationResult, RuntimeInput } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAbortRequest, NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import { linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { applyNotificationResult } from "../../src/notification-delivery/notification-delivery";
import { at, eewEnvelope } from "../notification-delivery/delivery-fixture";
import { harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

// TEST-PATH (2): the publisher with its in-process owners; the probe result is dispatched after startup.
async function startProbed(h: Harness, clock: ClockReading,
  channels: Extract<RuntimeInput, { kind: "notificationProbeCompleted" }>["channels"]) {
  await startHarness(h, "t11", clock, false);
  h.root.dispatch({ kind: "notificationProbeCompleted", channels, clock });
  await h.settle();
}
const eew = (h: Harness, clock: ClockReading) => submit(h, eewEnvelope("t11", clock));

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

async function settings() {
  const path = await fs.mkdtemp(join(tmpdir(), "fleq-a3-t11-"));
  paths.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

function adapter() {
  const attempts: NotificationAttempt[] = [];
  const aborts: { request: NotificationAbortRequest; stopBy: number }[] = [];
  const complete = new Map<string, (result: NotificationResult) => void>();
  return { attempts, aborts, complete,
    run: (attempt: NotificationAttempt) => {
      attempts.push(attempt);
      return new Promise<NotificationResult>((resolve) => { complete.set(attempt.attemptId, resolve); });
    },
    abort: async (request: NotificationAbortRequest, stopBy: number, clock: () => ClockReading) => {
      aborts.push({ request, stopBy });
      const attempt = attempts.find((item) => item.attemptId === request.attemptId)!;
      complete.get(request.attemptId)!({ kind: request.cause === "timeout" ? "timeout" : "aborted",
        ...(request.cause === "timeout" ? {} : { reason: request.cause }), stopped: true,
        attemptId: request.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() } as NotificationResult);
      return { attemptId: request.attemptId, stopped: true, completedAt: clock() };
    } };
}

it("P2-A3-T11 acceptance / AC11: a dirty owner reservation dispatches before checkpoint acknowledgement and adopts one run result", async () => {
  const fake = adapter();
  let now = at(0);
  // The save's write never completes here: the reservation and its result proceed while the save is in flight.
  const files = nodeCheckpointFileSystem();
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake,
    checkpointFileSystem: { ...files, open: () => new Promise(() => {}) } });
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  expect(fake.attempts).toHaveLength(1);
  expect(h.root.state.mirror["U-E"].persistence).toMatchObject({ kind: "pending", savedGeneration: 0 });
  void h.root.driveCheckpoint();
  await h.settle();
  expect(h.root.checkpoint.grant).not.toBeNull();
  expect(h.root.state.mirror["U-E"].persistence.savedGeneration).toBe(0);
  const attempt = fake.attempts[0];
  now = at(1);
  fake.complete.get(attempt.attemptId)!({ kind: "delivered", attemptId: attempt.attemptId,
    intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
  await h.settle();
  expect(h.unit("U-E").deliveryRecords.filter((item) => item.intentId === attempt.intentId))
    .toMatchObject([{ disposition: "delivered" }]);
  expect(h.root.state.mirror["U-E"].persistence.savedGeneration).toBe(0);
  await h.root.diagnostics.flush();
});

it("P2-A3-T11 contractBoundary / AC11: timeout and shutdown forward A1 causes and stop deadlines; only run settles terminal", async () => {
  const fake = adapter();
  const abort = fake.abort;
  fake.abort = async (...args) => { await abort(...args); throw new Error("abort observation rejected"); };
  let now = at(0);
  const apply = vi.fn((state: NotificationDeliveryState, result: NotificationResult, clock: ClockReading) =>
    applyNotificationResult(state, result, clock));
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake,
    runtimeCalls: { ...linkedRuntimeCalls, applyNotificationResult: apply } });
  await startProbed(h, now, { desktop: { kind: "idle" }, sound: { kind: "idle" } });
  await eew(h, now);
  expect(fake.attempts).toHaveLength(2);
  now = at(5_000);
  h.root.tick(now);
  const desktop = h.root.state.notificationChannels.desktop;
  expect(fake.aborts.map((item) => item.request)).toEqual([{
    attemptId: fake.attempts.find((item) => item.channel === "desktop")!.attemptId, cause: "timeout" }]);
  expect(fake.aborts[0].stopBy).toBe(desktop.kind === "stopping" ? desktop.stopByMonotonicMs : NaN);
  await h.settle();
  const before = h.root.state.mirror["U-E"].persistence.currentGeneration;
  const summary = await h.root.shutdownRuntime(0, now);
  expect(fake.aborts[1]?.request.cause).toBe("shutdown");
  expect(fake.aborts[1]?.stopBy).toBeLessThanOrEqual(6_000);
  expect(h.root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(0);
  expect(summary.reasons).not.toContain("sideEffectFinalization:unconfirmedNotifications");
  expect(h.root.state.mirror["U-E"].persistence.currentGeneration).toBeGreaterThanOrEqual(before);
  // Only the run settles a terminal: each attempt's result reaches A7 once.
  for (const attempt of fake.attempts)
    expect(apply.mock.calls.filter(([, result]) => result.attemptId === attempt.attemptId)).toHaveLength(1);
});

it("P2-A3-T11 contractBoundary / AC11: a failed batch hook still waits for notification until the stage deadline", async () => {
  let now = at(0);
  let finish!: (result: NotificationResult) => void;
  const fake = { run: () => new Promise<NotificationResult>((resolve) => { finish = resolve; }),
    abort: async () => ({ stopped: false }) };
  const finalize = vi.fn(async (_deadline: number, active: () => boolean) => {
    expect(active()).toBe(true);
    throw new Error("batch failed");
  });
  const attempts: NotificationAttempt[] = [];
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now,
    notificationAdapter: { ...fake, run: (value: NotificationAttempt) => { attempts.push(value); return fake.run(); } }, reportFailure: () => {},
    shutdownHooks: { finalizeBatchesAndSideEffects: finalize } });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  const attempt = attempts[0];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const stopping = root.shutdownRuntime(0, now);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(root.state.shutdown.stage).toBe("sideEffectFinalization");
    expect(root.state.shutdown.stageResults.sideEffectFinalization).toBeUndefined();
    now = at(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(root.state.shutdown.stageResults.sideEffectFinalization).toMatchObject({
      result: { kind: "failed", reason: "operationFailed" }, pending: { notificationAttempts: 1, batches: 1 },
    });
    now = at(5_001);
    finish({ kind: "aborted", reason: "shutdown", stopped: true, attemptId: attempt.attemptId,
      intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finalize).toHaveBeenCalledTimes(1);
    await root.diagnostics.flush();
  } finally { vi.useRealTimers(); }
});

it("P2-A3-T11 regression / AC11: a notification result invariant rejects shutdown instead of completing a failed stage", async () => {
  const fake = adapter();
  fake.abort = async (request, _stopBy, clock) => ({ attemptId: request.attemptId, stopped: true, completedAt: clock() });
  const invariant = new Error("A1 result invariant");
  const now = at(0);
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now,
    notificationAdapter: fake, runtimeCalls: { ...linkedRuntimeCalls, applyNotificationResult: () => { throw invariant; } },
    shutdownHooks: { finalizeBatchesAndSideEffects: async () => {
      const attempt = fake.attempts[0];
      fake.complete.get(attempt.attemptId)!({ kind: "aborted", reason: "shutdown", stopped: true,
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
      return { batches: 0, notificationAttempts: 0 };
    } } });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  await expect(root.shutdownRuntime(0, now)).rejects.toBe(invariant);
  expect(root.state.shutdown.stage).toBe("sideEffectFinalization");
  expect(root.state.shutdown.stageResults.sideEffectFinalization).toBeUndefined();
  expect(root.state.notificationChannels.sound.kind).toBe("stopping");
  await root.diagnostics.flush();
});

it("P2-A3-T11 regression / AC11: a resolved but unconfirmed stop remains an isolated shutdown attempt", async () => {
  const fake = adapter();
  fake.abort = async (request, _stopBy, clock) => {
    const attempt = fake.attempts[0];
    fake.complete.get(request.attemptId)!({ kind: "aborted", reason: "shutdown", stopped: false,
      attemptId: request.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() });
    return { attemptId: request.attemptId, stopped: false, completedAt: clock() };
  };
  const now = at(0);
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  const summary = await root.shutdownRuntime(0, now);
  expect(root.state.notificationChannels.sound.kind).toBe("isolated");
  expect(root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(1);
  expect(summary.code).toBe(4);
  expect(summary.reasons).toContain("sideEffectFinalization:unconfirmedNotifications");
});

it("P2-A3-T11 regression / AC11: a rejected run returns one adapterError terminal without unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const now = at(0);
    const attempts: NotificationAttempt[] = [];
    const apply = vi.fn((state: NotificationDeliveryState, result: NotificationResult, clock: ClockReading) =>
      applyNotificationResult(state, result, clock));
    const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now,
      runtimeCalls: { ...linkedRuntimeCalls, applyNotificationResult: apply },
      notificationAdapter: { run: async (value: NotificationAttempt) => { attempts.push(value); throw new Error("run rejected"); },
        abort: async () => {} } });
    const root = h.root;
    await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
    await eew(h, now);
    await h.settle();
    const attempt = attempts[0];
    expect(apply.mock.calls.map(([, result]) => result))
      .toEqual([{ kind: "failed", reason: "adapterError", attemptId: attempt.attemptId,
        intentId: attempt.intentId, channel: "sound", completedAt: now }]);
    expect(root.state.notificationChannels.sound.kind).toBe("idle");
    expect(h.unit("U-E").intents.find((item) => item.id === attempt.intentId))
      .toMatchObject({ attempts: 1, nextAttemptAt: now.wallTimeMs + 1_000, disposition: "pending" });
    await root.shutdownRuntime(0, now);
    expect(root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(0);
    expect(unhandled).toEqual([]);
    await root.diagnostics.flush();
  } finally { process.off("unhandledRejection", onUnhandled); }
});

it("P2-A3-T11 regression / AC11: a terminal result at TTL does not re-abort its settled run", async () => {
  const fake = adapter();
  let now = at(0);
  const h = harnessedRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  await eew(h, now);
  const attempt = fake.attempts[0];
  now = at(attempt.expiresAt - at(0).wallTimeMs);
  fake.complete.get(attempt.attemptId)!({ kind: "delivered", attemptId: attempt.attemptId,
    intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
  await h.settle();
  expect(fake.aborts).toEqual([]);
  expect(h.unit("U-E").intents).toEqual([]);
  await h.root.diagnostics.flush();
});

it("P2-A3-T11 contractBoundary / R34: unavailable desktop is skipped from first selection, expires at original TTL, and four reasons survive restart", async () => {
  const config = await settings();
  const fake = adapter();
  let now = at(0);
  const h = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  const root = h.root;
  await startProbed(h, now, { desktop: { kind: "unavailable", reason: "backendMissing" },
    sound: { kind: "unavailable", reason: "backendMissing" } });
  await root.diagnostics.flush();
  expect((await root.readDiagnostics({ limit: 100 })).records.filter((item) => item.reason === "notificationAttemptFailed"))
    .toMatchObject([{ level: "WARN", component: "notification-delivery", count: 2 }]);
  await eew(h, now);
  expect(fake.attempts).toEqual([]);
  const expiresAt = h.unit("U-E").intents[0].expiresAt;
  now = at(expiresAt - at(0).wallTimeMs);
  // As the host does on each tick: the tick is the liveness answer (P2-A10-AC13), so the mailbox reports no stall.
  root.mailbox.recordWorkerResponse(now.monotonicMs);
  root.tick(now);
  await h.settle();
  expect(fake.attempts).toEqual([]);
  expect(h.unit("U-E").intents.every((item) => item.disposition === "expired")).toBe(true);
  expect(root.state.notificationDeadlines.desktop).toEqual({});
  for (const reason of ["notificationCapacityEvicted", "notificationAdapterIsolated"] as const)
    root.enqueueDiagnostic({ timestamp: now.wallTimeMs, runId: "t11", level: "WARN", component: "notification-delivery", reason });
  await root.diagnostics.flush();
  const restarted = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: adapter() });
  const read = await restarted.root.readDiagnostics({ limit: 100 });
  expect(new Set(read.records.map((item) => item.reason))).toEqual(new Set([
    "notificationAttemptFailed", "notificationExpired", "notificationCapacityEvicted", "notificationAdapterIsolated",
  ]));
  expect(read.records.filter((item) => item.reason === "notificationAttemptFailed")).toHaveLength(1);
});
