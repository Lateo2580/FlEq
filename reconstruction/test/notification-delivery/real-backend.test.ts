import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ClockReading, NotificationResult, RuntimeInput, RuntimeStep } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import { CheckpointCoordinator } from "../../src/checkpoint/checkpoint";
import { linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { abortNotificationAttempt, probeDesktopBackend, probeSoundBackend, runNotificationAttempt } from "../../src/notification-delivery/adapter";
import { background, calls, eewInput, empty, tick } from "./delivery-fixture";

// Instrument the real spawn boundary without adding callbacks to the contracted adapter API.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const enabled = process.env.FLEQ_A7_C2 === "1";
const target = process.env.FLEQ_A7_C2_OS;
const evidenceDir = "reconstruction/test/notification-delivery/evidence";
// AC02/R32: one verdict path for live observations and the Mac regression trace; otherwise retries
// contaminate stop evidence and same-group player duration is charged to dispatch latency.
function judgeCompetition(results: readonly { attempt: NotificationAttempt; result: NotificationResult }[],
  generatedAt: ReadonlyMap<string, number>, spawnAt: ReadonlyMap<string, number>, closeAt: ReadonlyMap<string, number>,
  abortAt: ReadonlyMap<string, number>, lowerAttemptIds: ReadonlySet<string>,
  backendChannels: readonly NotificationAttempt["channel"][] = ["desktop", "sound"]) {
  const emergency = results.filter(item => item.attempt.unit === "U-E" && backendChannels.includes(item.attempt.channel));
  const firstCalls = emergency.map(({ attempt }) => {
    const generated = generatedAt.get(attempt.intentId), spawned = spawnAt.get(attempt.attemptId);
    const predecessor = attempt.subject.endsWith("20990101000002") ? emergency.find(item =>
      item.attempt.channel === attempt.channel && item.attempt.priorityGroup === attempt.priorityGroup
      && item.attempt.subject.endsWith("20990101000001"))?.attempt : null;
    const predecessorSpawned = predecessor == null ? null : spawnAt.get(predecessor.attemptId);
    const predecessorClosed = predecessor == null ? null : closeAt.get(predecessor.attemptId);
    const observed = generated != null && spawned != null && (predecessor === null
      || predecessor != null && predecessorSpawned != null && predecessorClosed != null);
    const durationMs = generated == null || spawned == null ? null : spawned - generated;
    // Intersection with B's waiting interval. A's queue/save time before spawn stays charged.
    const excludedPredecessorWaitMs = !observed ? null : predecessor == null ? 0
      : Math.max(0, Math.min(spawned!, predecessorClosed!) - Math.max(generated!, predecessorSpawned!));
    const adjustedDurationMs = durationMs == null || excludedPredecessorWaitMs == null ? null : durationMs - excludedPredecessorWaitMs;
    const closeToSpawnMs = spawned == null || predecessorClosed == null ? null : spawned - predecessorClosed;
    const status = !observed ? "blocked" : adjustedDurationMs! >= 0 && adjustedDurationMs! <= 1_000
      && (predecessor == null || closeToSpawnMs! >= 0 && closeToSpawnMs! <= 100) ? "pass" : "fail";
    return { intentId: attempt.intentId, channel: attempt.channel, generatedAt: generated ?? null,
      spawnedAt: spawned ?? null, durationMs, predecessorAttemptId: predecessor?.attemptId ?? null,
      predecessorSpawnedAt: predecessorSpawned ?? null, predecessorClosedAt: predecessorClosed ?? null,
      excludedPredecessorWaitMs, adjustedDurationMs, closeToSpawnMs, status };
  });
  const lower = results.filter(item => lowerAttemptIds.has(item.attempt.attemptId));
  const stopConfirmations = lower.map(({ attempt, result }) => ({ attemptId: attempt.attemptId, result,
    requestedAt: abortAt.get(attempt.attemptId) ?? null, closedAt: closeAt.get(attempt.attemptId) ?? null,
    durationMs: closeAt.has(attempt.attemptId) && abortAt.has(attempt.attemptId)
      ? closeAt.get(attempt.attemptId)! - abortAt.get(attempt.attemptId)! : null }));
  const blockedReason = emergency.length !== backendChannels.length * 2 || emergency.some(item => item.result.kind !== "delivered")
    ? "emergency backend did not deliver the required attempts"
    : lowerAttemptIds.size !== backendChannels.length || lower.length !== backendChannels.length || lower.some(({ result }) => result.kind !== "aborted"
      || !result.stopped || result.reason !== "higherPriority") || stopConfirmations.some(item => item.durationMs == null)
      ? "lower real close not confirmed" : firstCalls.some(item => item.status === "blocked") ? "first-call observation missing" : null;
  const ordered = backendChannels.every(channel => {
    const a = emergency.find(item => item.attempt.channel === channel && item.attempt.subject.endsWith("20990101000001"));
    const b = emergency.find(item => item.attempt.channel === channel && item.attempt.subject.endsWith("20990101000002"));
    if (a == null || b == null || !(spawnAt.get(a.attempt.attemptId)! < spawnAt.get(b.attempt.attemptId)!)) return false;
    const retry = spawnAt.get(`U-W:retry-${channel}:2`);
    return retry == null || retry >= closeAt.get(b.attempt.attemptId)!;
  });
  const status = blockedReason != null ? "blocked" : ordered && firstCalls.every(item => item.status === "pass")
    && stopConfirmations.every(item => item.durationMs! >= 0 && item.durationMs! <= 1_000) ? "pass" : "fail";
  return { firstCalls, stopConfirmations, status, reason: blockedReason ?? (status === "fail" ? "C2 ordering or R32 latency limit exceeded" : null) };
}

async function measure(os: "macos" | "linux-rpi") {
  const backendChannels: readonly NotificationAttempt["channel"][] = os === "macos" ? ["desktop", "sound"] : ["sound"];
  const desktopProbe = os === "linux-rpi" && process.platform === "linux" ? probeDesktopBackend() : null;
  const executables = os === "macos" ? ["/usr/bin/osascript", "/usr/bin/afplay"]
    : ["/usr/bin/notify-send", "/usr/bin/ffplay", "/usr/bin/paplay", "/usr/bin/aplay"];
  const backend = executables.map(path => ({ path, present: existsSync(path), sha256: existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex") : null }));
  const markers: Record<string, unknown>[] = [];
  const record: Record<string, unknown> = { evidenceKind: "C2 A7 standalone artificial A4/A1 competition (not R33 or A3-AC11)",
    os, platform: process.platform, arch: process.arch, node: process.version, backend,
    ...(os === "linux-rpi" ? { desktopProbe, desktopAttempts: 0, backendChannels } : {}),
    session: { dbus: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS), macNotificationPermission: "integrator visually confirmed R31; display not observable by this test" }, markers };
  const save = () => { mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/c2-${os}.detail.json`, JSON.stringify(record, null, 2) + "\n"); };
  const blocked = (reason: string): never => { record.status = "blocked"; record.reason = reason; save(); throw new Error(`C2 blocked: ${reason}`); };
  if ((os === "macos" ? process.platform !== "darwin" : process.platform !== "linux") || os === "macos" && !backend[0].present
    || !backend.slice(1).some(item => item.present))
    blocked("OS, backend or notification session unavailable");
  if (os === "linux-rpi" && desktopProbe?.kind !== "unavailable") blocked("R34 Pi desktop probe did not report unavailable");
  const directory = mkdtempSync(join(tmpdir(), "fleq-a7-c2-"));
  const clock = (): ClockReading => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() });
  const runs: Promise<unknown>[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let interval: ReturnType<typeof setInterval> | undefined;
  const originalSpawn = vi.mocked(childProcess.spawn).getMockImplementation()!;
  let spawning: NotificationAttempt | null = null;
  const spawnAt = new Map<string, number>(), closeAt = new Map<string, number>(), generatedAt = new Map<string, number>();
  const abortAt = new Map<string, number>();
  const lowerAttemptIds = new Set<string>();
  vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
    const attempt = spawning;
    const now = clock();
    const handle = originalSpawn(...args);
    if (attempt != null) {
      spawnAt.set(attempt.attemptId, spawnAt.get(attempt.attemptId) ?? now.monotonicMs);
      markers.push({ kind: "spawn", attemptId: attempt.attemptId, intentId: attempt.intentId, executable: args[0], clock: now });
      handle.once("close", (code, signal) => { const closed = clock(); closeAt.set(attempt.attemptId, closed.monotonicMs);
        markers.push({ kind: "close", attemptId: attempt.attemptId, code, signal, clock: closed }); });
    }
    return handle;
  });
  let current = empty(clock());
  let finished = false;
  try {
    const silent = Buffer.from(readFileSync("reconstruction/assets/sounds/weather-info.wav")); silent.fill(0, 44);
    const probe = join(directory, "silent.wav"); writeFileSync(probe, silent);
    record.soundProbe = await probeSoundBackend(probe, clock);
    if ((record.soundProbe as { kind: string }).kind !== "delivered") blocked("silent probe could not confirm an audio device");
    const start = clock(), foreground = { wallTimeMs: start.wallTimeMs + 1_000, monotonicMs: start.monotonicMs + 1_000 };
    record.start = start; record.foreground = foreground;
    current = background(empty(start), foreground);
    if (desktopProbe != null) current = { ...current, notificationChannels: { ...current.notificationChannels, desktop: desktopProbe } };
    record.background = current.units["U-W"].intents;
    const checkpoint = new CheckpointCoordinator(join(directory, "state"), linkedUnitCodecs, nodeCheckpointFileSystem(), clock,
      event => markers.push({ kind: "diagnostic", event }));
    const queued: { attempt: NotificationAttempt; generation: number }[] = [];
    const results: { attempt: NotificationAttempt; result: NotificationResult }[] = [];
    let checkpointBusy = false;
    let failure: string | null = null;
    function dispatch(input: RuntimeInput) { const step = reduceRuntime(current, input, calls); current = step.state; processStep(step); }
    function pump() {
      if (finished) return;
      if (!checkpointBusy) {
        const reservation = checkpoint.scheduleCheckpoint(current, clock(), current.runId, {
          "U-E": { inputIds: [], retryReason: "notRetry" }, "U-W": { inputIds: [], retryReason: "notRetry" } });
        if (reservation != null) {
          checkpointBusy = true;
          const before = current;
          current = reduceRuntime(current, { kind: "checkpointCaptured", capture: reservation.capture }, calls).state;
          markers.push({ kind: "reservation", capture: reservation.capture, clock: clock() });
          if (reservation.request == null) { failure = "checkpoint encode failed"; return; }
          const write = checkpoint.executeCheckpoint(reservation.request, current.runId, [], "notRetry").then(output => {
            if (finished) return;
            checkpoint.resultMetadata(before, output.result, clock());
            checkpointBusy = false;
            const now = clock();
            dispatch({ kind: "mailboxCompleted", clock: now, completion: { kind: "control", runId: current.runId,
              messageId: "ack", encodedByteLength: 0, startedMonotonicMs: now.monotonicMs, completedMonotonicMs: now.monotonicMs, control: { kind: "checkpointResult", clock: now, result: output.result } } });
          }).catch(error => { failure = String(error); });
          runs.push(write);
        }
      }
      for (let i = queued.length - 1; i >= 0; i--) {
        const { attempt, generation } = queued[i];
        if (attempt.unit !== "U-E" && attempt.unit !== "U-W") throw new Error("unexpected C2 owner");
        const reserved = current.checkpointAttempts[attempt.unit]?.generation ?? current.units[attempt.unit].persistence.savedGeneration ?? 0;
        if (reserved < generation) continue;
        queued.splice(i, 1);
        spawning = attempt;
        const run = runNotificationAttempt(attempt, clock);
        spawning = null;
        runs.push(run.then(result => { results.push({ attempt, result });
          if (!finished) dispatch({ kind: "notificationResult", result }); }));
      }
    }
    function processStep(step: RuntimeStep) {
      for (const request of step.abortRequests) {
        const channel = Object.values(current.notificationChannels).find(value => value.kind === "stopping" && value.attempt.attemptId === request.attemptId);
        if (channel?.kind !== "stopping") continue;
        const requestedAt = clock(); abortAt.set(request.attemptId, requestedAt.monotonicMs);
        markers.push({ kind: "abort", request, clock: requestedAt });
        runs.push(abortNotificationAttempt(request, channel.stopByMonotonicMs, clock));
      }
      for (const attempt of step.notificationAttempts) {
        if (os === "linux-rpi" && attempt.channel === "desktop") record.desktopAttempts = Number(record.desktopAttempts) + 1;
        if (attempt.unit !== "U-E" && attempt.unit !== "U-W") throw new Error("unexpected C2 owner");
        queued.push({ attempt, generation: current.units[attempt.unit].persistence.currentGeneration });
      }
      pump();
    }
    // Reserve the background before offset 0; selecting lower itself remains in the shared foreground dispatch.
    const seeded = reduceRuntime(current, tick(current, start), { ...calls,
      selectNotificationAttempt: state => ({ state, attempts: [], abortRequests: [], diagnostics: [] }) });
    current = seeded.state;
    const accept = (event: "A" | "B", offset: number) => {
      const now = clock();
      const step = reduceRuntime(current, eewInput(current, now, event), calls); current = step.state;
      const intents = current.units["U-E"].intents.filter(item => item.source.inputId === event);
      if (intents.length !== 2) failure = `${event} did not produce two A4 intents`;
      for (const intent of intents) generatedAt.set(intent.id, now.monotonicMs);
      markers.push({ kind: "generation", event, scheduledOffsetMs: offset, clock: now,
        createdAtMonotonicMs: now.monotonicMs, intentIds: intents.map(item => item.id) });
      processStep(step);
    };
    let foregroundStarted = false;
    await new Promise<void>((resolve, reject) => {
      // B's timer is registered against M0+10 BEFORE A/lower, never after close or A spawn.
      timers.push(setTimeout(() => { try { accept("B", 10); } catch (error) { reject(error); } }, Math.max(0, foreground.monotonicMs + 10 - clock().monotonicMs)));
      timers.push(setTimeout(() => {
        try {
          foregroundStarted = true;
          dispatch(tick(current, clock()));
          // Background generation reservation/spawn must have completed synchronously in this dispatch.
          const lower = Object.values(current.notificationChannels).filter(value => value.kind === "running");
          const competing = lower.length === backendChannels.length && lower.every(value => value.kind === "running"
            && spawnAt.has(value.attempt.attemptId) && !closeAt.has(value.attempt.attemptId));
          record.lowerCloseUnobservedAtA = competing;
          if (!competing) { failure = "required lower handles were not spawned and close-unobserved at A"; resolve(); return; }
          for (const channel of lower) if (channel.kind === "running") lowerAttemptIds.add(channel.attempt.attemptId);
          record.lowerAttemptIdsAtA = [...lowerAttemptIds];
          accept("A", 0);
        } catch (error) { reject(error); }
      }, Math.max(0, foreground.monotonicMs - clock().monotonicMs)));
      interval = setInterval(() => {
        if (!foregroundStarted) return;
        try {
          dispatch(tick(current, clock()));
          if (failure != null || results.filter(item => item.attempt.unit === "U-E" && backendChannels.includes(item.attempt.channel)).length >= backendChannels.length * 2) resolve();
          else if (clock().monotonicMs > foreground.monotonicMs + 15_000) { failure = "competition did not complete"; resolve(); }
        } catch (error) { reject(error); }
      }, 10);
    });
    record.results = results;
    if (failure != null) blocked(failure);
    Object.assign(record, judgeCompetition(results, generatedAt, spawnAt, closeAt, abortAt, lowerAttemptIds, backendChannels));
    if (record.status === "blocked") blocked(String(record.reason));
    if (os === "linux-rpi") {
      // R34 TTL evidence is a pure A1 clock input, separate from sound's real backend timings.
      const desktopIntents = [...current.units["U-E"].intents, ...current.units["U-W"].intents]
        .filter(item => item.channel === "desktop" && item.disposition === "pending");
      const now = clock(), expiresAt = Math.max(now.wallTimeMs, ...desktopIntents.map(item => item.expiresAt));
      const expiryClock = { wallTimeMs: expiresAt, monotonicMs: now.monotonicMs + expiresAt - now.wallTimeMs };
      const expired = reduceRuntime(current, tick(current, expiryClock), calls);
      const pendingAfter = [...expired.state.units["U-E"].intents, ...expired.state.units["U-W"].intents]
        .filter(item => item.channel === "desktop" && item.disposition === "pending").length;
      const deadlineKeysAfter = Object.keys(expired.state.notificationDeadlines.desktop).length;
      const attemptsAtExpiry = expired.notificationAttempts.filter(item => item.channel === "desktop").length;
      const status = record.desktopAttempts === 0 && desktopIntents.length === 4 && pendingAfter === 0
        && deadlineKeysAfter === 0 && attemptsAtExpiry === 0 ? "pass" : "fail";
      record.desktopTtlCheck = { evidenceKind: "pure A1 deadline input; not real elapsed time", expiryClock,
        originalIntents: desktopIntents.map(item => ({ id: item.id, expiresAt: item.expiresAt, attempts: item.attempts })),
        pendingAfter, deadlineKeysAfter, attemptsAtExpiry, status };
      if (status === "fail") { record.status = "fail"; record.reason = "R34 desktop attempted or TTL reclamation failed"; }
    }
    save(); expect(record.status).toBe("pass");
  } catch (error) {
    if (record.status == null) { record.status = "blocked"; record.reason = String(error); save(); }
    throw error;
  } finally {
    finished = true; clearInterval(interval); timers.forEach(clearTimeout);
    for (const channel of Object.values(current.notificationChannels)) if (channel.kind === "running" || channel.kind === "stopping")
      await abortNotificationAttempt({ attemptId: channel.attempt.attemptId, cause: "shutdown" }, clock().monotonicMs + 1_000, clock);
    await Promise.allSettled(runs);
    vi.mocked(childProcess.spawn).mockImplementation(originalSpawn);
    rmSync(directory, { recursive: true, force: true });
  }
}

it.skipIf(!enabled || target !== "macos")("C2 macOS real backend", async () => { await measure("macos"); });
it.skipIf(!enabled || target !== "linux-rpi")("C2 Linux Raspberry Pi real backend", async () => { await measure("linux-rpi"); });
it.skipIf(!enabled || target === "macos" || target === "linux-rpi")("C2 requires an explicit supported OS", () => {
  throw new Error("C2 blocked: FLEQ_A7_C2_OS must be macos or linux-rpi");
});

// T01 regression: the original real Mac trace contains lower-desktop:2 and a 1.6s A sound.
// This is an offline verdict check, not a fresh C2 backend run.
it("T01 regression R32: original lower attempts and same-channel predecessor wait determine the verdict", () => {
  const trace = JSON.parse(readFileSync(`${evidenceDir}/c2-macos-r31-observed.detail.json`, "utf8")) as {
    results: { attempt: NotificationAttempt; result: NotificationResult }[];
    firstCalls: { intentId: string; generatedAt: number }[];
    markers: { kind: string; attemptId: string; clock: ClockReading; request?: { attemptId: string } }[];
  };
  const generated = new Map(trace.firstCalls.map(item => [item.intentId, item.generatedAt]));
  const spawned = new Map<string, number>(), closed = new Map<string, number>(), aborted = new Map<string, number>();
  for (const marker of trace.markers) {
    if (marker.kind === "spawn" && !spawned.has(marker.attemptId)) spawned.set(marker.attemptId, marker.clock.monotonicMs);
    if (marker.kind === "close") closed.set(marker.attemptId, marker.clock.monotonicMs);
    if (marker.kind === "abort") aborted.set(marker.request!.attemptId, marker.clock.monotonicMs);
  }
  const initialLower = new Set(["U-W:lower-desktop:1", "U-W:lower-sound:1"]);
  const verdict = judgeCompetition(trace.results, generated, spawned, closed, aborted, initialLower);
  writeFileSync(`${evidenceDir}/c2-macos-r32-reassessment.json`, JSON.stringify({
    evidenceKind: "offline R32 reassessment of integrator Mac observations; not a fresh backend run",
    source: "c2-macos-r31-observed.detail.json",
    sourceSha256: createHash("sha256").update(readFileSync(`${evidenceDir}/c2-macos-r31-observed.detail.json`)).digest("hex"),
    ...verdict,
  }, null, 2) + "\n");
  expect(verdict.status).toBe("pass");
  expect(verdict.stopConfirmations.map(item => item.attemptId).sort()).toEqual([...initialLower].sort());
  const bSound = verdict.firstCalls.find(item => item.intentId.endsWith("000002:2:sound"))!;
  expect(bSound.durationMs).toBeCloseTo(1_630.680917, 5);
  expect(bSound.excludedPredecessorWaitMs).toBeCloseTo(1_608.533125, 5);
  expect(bSound.adjustedDurationMs).toBeCloseTo(22.147792, 5);
  expect(bSound.closeToSpawnMs).toBeCloseTo(1.924875, 5);
  expect(verdict.firstCalls.filter(item => item.predecessorAttemptId == null)
    .every(item => item.excludedPredecessorWaitMs === 0 && item.adjustedDurationMs === item.durationMs)).toBe(true);
  // Same observed series, delayed B dispatch: subtracting A's runtime must not waive the 100ms boundary.
  const b = trace.results.find(item => item.attempt.intentId === bSound.intentId)!.attempt;
  spawned.set(b.attemptId, bSound.predecessorClosedAt! + 101);
  expect(judgeCompetition(trace.results, generated, spawned, closed, aborted, initialLower).status).toBe("fail");
});
