import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { ClockReading, NotificationResult } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAbortRequest, NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import { RuntimeCompositionRoot, linkedRuntimeCalls, linkedUnitCodecs } from "../../src/runtime/composition-root";
import { at, eewInput } from "../notification-delivery/delivery-fixture";
import { testNotificationChannels } from "../checkpoint-shutdown/runtime-fixture";

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
  const root = new RuntimeCompositionRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  root.startRuntime("t11", now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  const step = root.dispatch(root.state, eewInput(root.state, now));
  expect(step.notificationAttempts).toHaveLength(1);
  expect(fake.attempts).toEqual(step.notificationAttempts);
  expect(step.state.units["U-E"].persistence).toMatchObject({ kind: "pending", savedGeneration: 0 });
  const captured = root.scheduleCheckpoint(root.state, now, "t11");
  expect(captured?.request).not.toBeNull();
  expect(root.state.units["U-E"].persistence.savedGeneration).toBe(0);
  const attempt = fake.attempts[0];
  now = at(1);
  fake.complete.get(attempt.attemptId)!({ kind: "delivered", attemptId: attempt.attemptId,
    intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(root.state.units["U-E"].deliveryRecords.filter((item) => item.intentId === attempt.intentId))
    .toMatchObject([{ disposition: "delivered" }]);
  expect(root.state.units["U-E"].persistence.savedGeneration).toBe(0);
  await root.diagnostics.flush();
});

it("P2-A3-T11 contractBoundary / AC11: timeout and shutdown forward A1 causes and stop deadlines; only run settles terminal", async () => {
  const fake = adapter();
  const abort = fake.abort;
  fake.abort = async (...args) => { await abort(...args); throw new Error("abort observation rejected"); };
  let now = at(0);
  const root = new RuntimeCompositionRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  const dispatch = vi.spyOn(root, "dispatch");
  root.startRuntime("t11", now, testNotificationChannels);
  root.dispatch(root.state, eewInput(root.state, now));
  expect(fake.attempts).toHaveLength(2);
  now = at(5_000);
  const expired = root.tick(root.state, now);
  expect(expired.abortRequests).toEqual([{ attemptId: fake.attempts.find((item) => item.channel === "desktop")!.attemptId,
    cause: "timeout" }]);
  expect(fake.aborts[0]).toEqual({ request: expired.abortRequests[0],
    stopBy: expired.state.notificationChannels.desktop.kind === "stopping"
      ? expired.state.notificationChannels.desktop.stopByMonotonicMs : NaN });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = root.state.units["U-E"].persistence.currentGeneration;
  const summary = await root.shutdownRuntime(root.state, 0, now);
  expect(fake.aborts[1]?.request.cause).toBe("shutdown");
  expect(fake.aborts[1]?.stopBy).toBeLessThanOrEqual(6_000);
  expect(root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(0);
  expect(summary.reasons).not.toContain("sideEffectFinalization:unconfirmedNotifications");
  expect(root.state.units["U-E"].persistence.currentGeneration).toBeGreaterThanOrEqual(before);
  for (const attempt of fake.attempts)
    expect(dispatch.mock.calls.filter(([, input]) => input.kind === "notificationResult"
      && input.result.attemptId === attempt.attemptId)).toHaveLength(1);
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
  const root = new RuntimeCompositionRoot(await settings(), linkedUnitCodecs, { clock: () => now,
    notificationAdapter: fake, reportFailure: () => {},
    shutdownHooks: { finalizeBatchesAndSideEffects: finalize } });
  root.startRuntime("t11", now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  const attempt = root.dispatch(root.state, eewInput(root.state, now)).notificationAttempts[0];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const stopping = root.shutdownRuntime(root.state, 0, now);
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
  const root = new RuntimeCompositionRoot(await settings(), linkedUnitCodecs, { clock: () => now,
    notificationAdapter: fake, runtimeCalls: { ...linkedRuntimeCalls, applyNotificationResult: () => { throw invariant; } },
    shutdownHooks: { finalizeBatchesAndSideEffects: async () => {
      const attempt = fake.attempts[0];
      fake.complete.get(attempt.attemptId)!({ kind: "aborted", reason: "shutdown", stopped: true,
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
      return { batches: 0, notificationAttempts: 0 };
    } } });
  root.startRuntime("t11", now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  root.dispatch(root.state, eewInput(root.state, now));
  await expect(root.shutdownRuntime(root.state, 0, now)).rejects.toBe(invariant);
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
  const root = new RuntimeCompositionRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  root.startRuntime("t11", now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  root.dispatch(root.state, eewInput(root.state, now));
  const summary = await root.shutdownRuntime(root.state, 0, now);
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
    const root = new RuntimeCompositionRoot(await settings(), linkedUnitCodecs, { clock: () => now,
      notificationAdapter: { run: async () => { throw new Error("run rejected"); }, abort: async () => {} } });
    const dispatch = vi.spyOn(root, "dispatch");
    root.startRuntime("t11", now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
    const attempt = root.dispatch(root.state, eewInput(root.state, now)).notificationAttempts[0];
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dispatch.mock.calls.flatMap(([, input]) => input.kind === "notificationResult" ? [input.result] : []))
      .toEqual([{ kind: "failed", reason: "adapterError", attemptId: attempt.attemptId,
        intentId: attempt.intentId, channel: "sound", completedAt: now }]);
    expect(root.state.notificationChannels.sound.kind).toBe("idle");
    expect(root.state.units["U-E"].intents.find((item) => item.id === attempt.intentId))
      .toMatchObject({ attempts: 1, nextAttemptAt: now.wallTimeMs + 1_000, disposition: "pending" });
    await root.shutdownRuntime(root.state, 0, now);
    expect(root.state.shutdown.stageResults.sideEffectFinalization?.pending.notificationAttempts).toBe(0);
    expect(unhandled).toEqual([]);
    await root.diagnostics.flush();
  } finally { process.off("unhandledRejection", onUnhandled); }
});

it("P2-A3-T11 regression / AC11: a terminal result at TTL does not re-abort its settled run", async () => {
  const fake = adapter();
  let now = at(0);
  const root = new RuntimeCompositionRoot(await settings(), linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  root.startRuntime("t11", now, { desktop: { kind: "unavailable", reason: "backendMissing" }, sound: { kind: "idle" } });
  root.dispatch(root.state, eewInput(root.state, now));
  const attempt = fake.attempts[0];
  now = at(attempt.expiresAt - at(0).wallTimeMs);
  fake.complete.get(attempt.attemptId)!({ kind: "delivered", attemptId: attempt.attemptId,
    intentId: attempt.intentId, channel: attempt.channel, completedAt: now });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fake.aborts).toEqual([]);
  expect(root.state.units["U-E"].intents).toEqual([]);
  await root.diagnostics.flush();
});

it("P2-A3-T11 contractBoundary / R34: unavailable desktop is skipped from first selection, expires at original TTL, and four reasons survive restart", async () => {
  const config = await settings();
  const fake = adapter();
  let now = at(0);
  const root = new RuntimeCompositionRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: fake });
  const started = root.startRuntime("t11", now, { desktop: { kind: "unavailable", reason: "backendMissing" },
    sound: { kind: "unavailable", reason: "backendMissing" } });
  expect(started.diagnostics.filter((item) => item.reason === "notificationAttemptFailed"))
    .toMatchObject([{ level: "WARN", component: "notification-delivery", count: 2 }]);
  const generated = root.dispatch(root.state, eewInput(root.state, now));
  expect(generated.notificationAttempts).toEqual([]);
  expect(fake.attempts).toEqual([]);
  const expiresAt = generated.state.units["U-E"].intents[0].expiresAt;
  now = at(expiresAt - at(0).wallTimeMs);
  const expired = root.tick(root.state, now);
  expect(expired.notificationAttempts).toEqual([]);
  expect(expired.state.units["U-E"].intents.every((item) => item.disposition === "expired")).toBe(true);
  expect(expired.state.notificationDeadlines.desktop).toEqual({});
  for (const reason of ["notificationCapacityEvicted", "notificationAdapterIsolated"] as const)
    root.enqueueDiagnostic({ timestamp: now.wallTimeMs, runId: "t11", level: "WARN", component: "notification-delivery", reason });
  await root.diagnostics.flush();
  const restarted = new RuntimeCompositionRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: adapter() });
  const read = await restarted.readDiagnostics({ limit: 100 });
  expect(new Set(read.records.map((item) => item.reason))).toEqual(new Set([
    "notificationAttemptFailed", "notificationExpired", "notificationCapacityEvicted", "notificationAdapterIsolated",
  ]));
  expect(read.records.filter((item) => item.reason === "notificationAttemptFailed")).toHaveLength(1);
});
