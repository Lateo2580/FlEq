import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ClockReading, MailboxEnvelope, NotificationIntent, NotificationResult, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationPriorityGroup } from "../../contracts/p2-notification-delivery.types";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { abortNotificationAttempt, probeDesktopBackend, probeSoundBackend, runNotificationAttempt } from "../../src/notification-delivery/adapter";
import { envelope, harnessedRoot, seeded, startHarness, submit } from "../execution-split/owner-harness";
import { vtse41 } from "../tsunami-unit/tsunami-fixture";
import { background, calls, eewEnvelope } from "./delivery-fixture";
const { judgeLatency } = require("./r32-latency.cjs") as { judgeLatency: (generated: number | undefined,
  spawned: number | undefined, predecessorSpawned?: number | null, predecessorClosed?: number | null,
  hasPredecessor?: boolean) => {
    durationMs: number | null; excludedPredecessorWaitMs: number | null; adjustedDurationMs: number | null;
    closeToSpawnMs: number | null; status: "pass" | "fail" | "blocked";
  } };

// Instrument the real spawn boundary without adding callbacks to the contracted adapter API.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const enabled = process.env.FLEQ_A7_C2 === "1";
const target = process.env.FLEQ_A7_C2_OS;
const evidenceDir = "reconstruction/test/notification-delivery/evidence";
// 緊急の担い手の行（P3-FG-T05）: spawn の計測と判定を C2 と T2 で 1 つに保つため、違いはここだけに置く。reports は受理の順で、
// 2 本目以降の EventID の先行は 1 つ前の報（同群の先行、R32）。ownerAdoption は T05 の (5) を当てる行だけ true。
type Emergency = Readonly<{ label: string; unit: RuntimeUnitId; group: NotificationPriorityGroup; intentKind: string;
  reports: readonly Readonly<{ inputId: string; eventId: string; offsetMs: number; envelope: (now: ClockReading) => MailboxEnvelope }>[];
  file: (os: "macos" | "linux-rpi") => string; evidenceKind: string; piDesktopIntents: number; ownerAdoption: boolean }>;
const c2: Emergency = { label: "C2", unit: "U-E", group: "normalEew", intentKind: "A4",
  reports: [{ inputId: "A", eventId: "20990101000001", offsetMs: 0, envelope: now => eewEnvelope("a7", now, "A") },
    { inputId: "B", eventId: "20990101000002", offsetMs: 10, envelope: now => eewEnvelope("a7", now, "B") }],
  file: os => `${evidenceDir}/c2-${os}.detail.json`, evidenceKind: "C2 A7 standalone artificial A4/A1 competition (not R33 or A3-AC11)",
  piDesktopIntents: 4, ownerAdoption: false };
// P3-C5-E21-LOAD-T-v1 の T2: T1 の第 1 行（tsunami-runtime.test.ts の tsunamiEnvelope と同じ引数の VTSE41）を C2 と同じ条件で。B は無い。
const t2: Emergency = { label: "AC07 T2", unit: "U-T", group: "normalTsunamiEmergency", intentKind: "critical",
  reports: [{ inputId: "T2", eventId: "20990101000011", offsetMs: 0, envelope: now => envelope("a7", "VTSE41", "T2",
    Buffer.from(vtse41({ eventId: "20990101000011", at: new Date(now.wallTimeMs).toISOString(),
      areas: [{ code: "311", name: "千葉県内房", kind: "52" }] })), now, 1) }],
  file: os => `reconstruction/test/final-gate/evidence/ac07-t2-${os}.detail.json`,
  evidenceKind: "AC07 T2 (P3-C5-E21-LOAD-T-v1) real backend tsunami emergency competition, P3-FG-T05",
  piDesktopIntents: 3, ownerAdoption: true };
// AC02/R32: one verdict path for live observations and the Mac regression trace; otherwise retries
// contaminate stop evidence and same-group player duration is charged to dispatch latency.
function judgeCompetition(results: readonly { attempt: NotificationAttempt; result: NotificationResult }[],
  generatedAt: ReadonlyMap<string, number>, spawnAt: ReadonlyMap<string, number>, closeAt: ReadonlyMap<string, number>,
  abortAt: ReadonlyMap<string, number>, lowerAttemptIds: ReadonlySet<string>,
  backendChannels: readonly NotificationAttempt["channel"][] = ["desktop", "sound"], row: Emergency = c2) {
  const emergency = results.filter(item => item.attempt.unit === row.unit && backendChannels.includes(item.attempt.channel));
  const firstCalls = emergency.map(({ attempt }) => {
    const generated = generatedAt.get(attempt.intentId), spawned = spawnAt.get(attempt.attemptId);
    const index = row.reports.findIndex(report => attempt.subject.endsWith(report.eventId));
    const predecessor = index > 0 ? emergency.find(item =>
      item.attempt.channel === attempt.channel && item.attempt.priorityGroup === attempt.priorityGroup
      && item.attempt.subject.endsWith(row.reports[index - 1].eventId))?.attempt : null;
    const predecessorSpawned = predecessor == null ? null : spawnAt.get(predecessor.attemptId);
    const predecessorClosed = predecessor == null ? null : closeAt.get(predecessor.attemptId);
    const { durationMs, excludedPredecessorWaitMs, adjustedDurationMs, closeToSpawnMs, status } = judgeLatency(
      generated, spawned, predecessorSpawned, predecessorClosed, predecessor != null);
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
  const blockedReason = emergency.length !== backendChannels.length * row.reports.length || emergency.some(item => item.result.kind !== "delivered")
    ? "emergency backend did not deliver the required attempts"
    : lowerAttemptIds.size !== backendChannels.length || lower.length !== backendChannels.length || lower.some(({ result }) => result.kind !== "aborted"
      || !result.stopped || result.reason !== "higherPriority") || stopConfirmations.some(item => item.durationMs == null)
      ? "lower real close not confirmed" : firstCalls.some(item => item.status === "blocked") ? "first-call observation missing" : null;
  // 同群の順（報の順に spawn）と固定群（緊急の群の試行の後にだけ U-W の retry）。
  const ordered = backendChannels.every(channel => {
    const series = row.reports.map(report => emergency.find(item => item.attempt.channel === channel && item.attempt.subject.endsWith(report.eventId)));
    if (series.some((item, index) => item == null || item.attempt.priorityGroup !== row.group
      || index > 0 && !(spawnAt.get(series[index - 1]!.attempt.attemptId)! < spawnAt.get(item.attempt.attemptId)!))) return false;
    const retry = spawnAt.get(`U-W:retry-${channel}:2`);
    return retry == null || retry >= closeAt.get(series[series.length - 1]!.attempt.attemptId)!;
  });
  const status = blockedReason != null ? "blocked" : ordered && firstCalls.every(item => item.status === "pass")
    && stopConfirmations.every(item => item.durationMs! >= 0 && item.durationMs! <= 1_000) ? "pass" : "fail";
  return { firstCalls, stopConfirmations, status, reason: blockedReason ?? (status === "fail" ? `${row.label} ordering or R32 latency limit exceeded` : null) };
}

async function measure(os: "macos" | "linux-rpi", row: Emergency = c2) {
  const backendChannels: readonly NotificationAttempt["channel"][] = os === "macos" ? ["desktop", "sound"] : ["sound"];
  const desktopProbe = os === "linux-rpi" && process.platform === "linux" ? probeDesktopBackend() : null;
  const executables = os === "macos" ? ["/usr/bin/osascript", "/usr/bin/afplay"]
    : ["/usr/bin/notify-send", "/usr/bin/ffplay", "/usr/bin/paplay", "/usr/bin/aplay"];
  const backend = executables.map(path => ({ path, present: existsSync(path), sha256: existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex") : null }));
  const markers: Record<string, unknown>[] = [];
  const record: Record<string, unknown> = { evidenceKind: row.evidenceKind,
    os, platform: process.platform, arch: process.arch, node: process.version, backend,
    ...(os === "linux-rpi" ? { desktopProbe, desktopAttempts: 0, backendChannels } : {}),
    session: { dbus: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS), macNotificationPermission: "integrator visually confirmed R31; display not observable by this test" }, markers };
  const save = () => { mkdirSync(dirname(row.file(os)), { recursive: true });
    writeFileSync(row.file(os), JSON.stringify(record, null, 2) + "\n"); };
  const blocked = (reason: string): never => { record.status = "blocked"; record.reason = reason; save(); throw new Error(`${row.label} blocked: ${reason}`); };
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
  // TEST-PATH (2): the publisher and its in-process owners with the real adapter. Selection stays idle until the
  // foreground starts, so the background is selected in the shared foreground dispatch (as before the split).
  let foregroundStarted = false;
  const select: typeof calls.selectNotificationAttempt = (state, ...rest) =>
    foregroundStarted ? calls.selectNotificationAttempt(state, ...rest) : { state, attempts: [], abortRequests: [], diagnostics: [] };
  const seeds = seeded();
  const results: { attempt: NotificationAttempt; result: NotificationResult }[] = [];
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(directory, "state"),
    legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "diagnostics") }, linkedUnitCodecs, {
    clock, runtimeCalls: { ...calls, units: seeds.units, selectNotificationAttempt: select },
    notificationAdapter: {
      run: (attempt, readClock) => {
        if (os === "linux-rpi" && attempt.channel === "desktop") record.desktopAttempts = Number(record.desktopAttempts) + 1;
        spawning = attempt;
        const run = runNotificationAttempt(attempt, readClock);
        spawning = null;
        runs.push(run.then((result) => { results.push({ attempt, result }); }));
        return run;
      },
      abort: (request, stopBy, readClock) => {
        const requestedAt = readClock(); abortAt.set(request.attemptId, requestedAt.monotonicMs);
        markers.push({ kind: "abort", request, clock: requestedAt });
        return abortNotificationAttempt(request, stopBy, readClock);
      },
    } });
  let finished = false;
  try {
    const silent = Buffer.from(readFileSync("reconstruction/assets/sounds/weather-info.wav")); silent.fill(0, 44);
    const probe = join(directory, "silent.wav"); writeFileSync(probe, silent);
    record.soundProbe = await probeSoundBackend(probe, clock);
    if ((record.soundProbe as { kind: string }).kind !== "delivered") blocked("silent probe could not confirm an audio device");
    const start = clock(), foreground = { wallTimeMs: start.wallTimeMs + 1_000, monotonicMs: start.monotonicMs + 1_000 };
    record.start = start; record.foreground = foreground;
    await startHarness(h, "a7", start, false);
    h.root.dispatch({ kind: "notificationProbeCompleted", clock: start,
      channels: { desktop: desktopProbe ?? { kind: "idle" }, sound: { kind: "idle" } } });
    // The background reaches U-W before offset 0; selecting lower itself remains in the shared foreground dispatch.
    await seeds.weather(h, { ...initialUnits["U-W"], intents: background(foreground) }, null, start);
    record.background = h.unit("U-W").intents;
    let failure: string | null = null;
    const accepted: NotificationIntent[] = [];
    const accept = async (report: Emergency["reports"][number]) => {
      const now = clock();
      await submit(h, report.envelope(now));
      const intents = h.unit(row.unit).intents.filter(item => item.source.inputId === report.inputId);
      if (intents.length !== 2) failure = `${report.inputId} did not produce two ${row.intentKind} intents`;
      for (const intent of intents) generatedAt.set(intent.id, now.monotonicMs);
      accepted.push(...intents);
      markers.push({ kind: "generation", event: report.inputId, scheduledOffsetMs: report.offsetMs, clock: now,
        createdAtMonotonicMs: now.monotonicMs, intentIds: intents.map(item => item.id) });
    };
    await new Promise<void>((resolve, reject) => {
      // B's timer is registered against M0+10 BEFORE A/lower, never after close or A spawn.
      for (const report of row.reports.slice(1)) timers.push(setTimeout(() => { accept(report).catch(reject); },
        Math.max(0, foreground.monotonicMs + report.offsetMs - clock().monotonicMs)));
      timers.push(setTimeout(() => {
        (async () => {
          foregroundStarted = true;
          h.root.tick(clock());
          await h.settle();
          // Background reservation/spawn must have completed in this dispatch.
          const lower = Object.values(h.root.state.notificationChannels).filter(value => value.kind === "running");
          const competing = lower.length === backendChannels.length && lower.every(value => value.kind === "running"
            && spawnAt.has(value.attempt.attemptId) && !closeAt.has(value.attempt.attemptId));
          record.lowerCloseUnobservedAtA = competing;
          if (!competing) { failure = "required lower handles were not spawned and close-unobserved at A"; resolve(); return; }
          for (const channel of lower) if (channel.kind === "running") lowerAttemptIds.add(channel.attempt.attemptId);
          record.lowerAttemptIdsAtA = [...lowerAttemptIds];
          await accept(row.reports[0]);
        })().catch(reject);
      }, Math.max(0, foreground.monotonicMs - clock().monotonicMs)));
      interval = setInterval(() => {
        if (!foregroundStarted || finished) return;
        try {
          h.root.tick(clock());
          if (failure != null || results.filter(item => item.attempt.unit === row.unit && backendChannels.includes(item.attempt.channel)).length
            >= backendChannels.length * row.reports.length) resolve();
          else if (clock().monotonicMs > foreground.monotonicMs + 15_000) { failure = "competition did not complete"; resolve(); }
        } catch (error) { reject(error); }
      }, 10);
    });
    record.results = results;
    if (failure != null) blocked(failure);
    Object.assign(record, judgeCompetition(results, generatedAt, spawnAt, closeAt, abortAt, lowerAttemptIds, backendChannels, row));
    if (record.status === "blocked") blocked(String(record.reason));
    if (row.ownerAdoption) {
      // T05 (5): adapter の delivered だけを成功にしない。期限で製品が expired にした結果は、owner に採られた delivered の終端の更新が欠けて落ちる。
      await h.settle();
      const expected = accepted.filter(intent => backendChannels.includes(intent.channel)).map(intent => intent.id);
      const doneOf = new Map(h.delivered.flatMap(({ reply }) => reply.kind === "intentUpdateDone" ? [[reply.requestId, reply.adopted] as const] : []));
      const adopted = h.sent.flatMap(({ request }) => request.kind === "intentUpdate" && doneOf.get(request.requestId) === true
        ? request.updates.filter(update => update.disposition === "delivered" && expected.includes(update.id)).map(update => update.id) : []);
      record.ownerAdoption = { expected, adopted };
      if (expected.some(id => !adopted.includes(id))) { record.status = "fail"; record.reason = "T2 delivered terminal updates not adopted by the owner"; }
    }
    if (os === "linux-rpi") {
      // R34 TTL evidence is a deadline input at the latest desktop expiry, separate from sound's real backend timings.
      const desktopIntents = [...h.unit(row.unit).intents, ...h.unit("U-W").intents]
        .filter(item => item.channel === "desktop" && item.disposition === "pending");
      const now = clock(), expiresAt = Math.max(now.wallTimeMs, ...desktopIntents.map(item => item.expiresAt));
      const expiryClock = { wallTimeMs: expiresAt, monotonicMs: now.monotonicMs + expiresAt - now.wallTimeMs };
      const attemptsBefore = Number(record.desktopAttempts);
      h.root.tick(expiryClock);
      await h.settle();
      const pendingAfter = [...h.unit(row.unit).intents, ...h.unit("U-W").intents]
        .filter(item => item.channel === "desktop" && item.disposition === "pending").length;
      const deadlineKeysAfter = Object.keys(h.root.state.notificationDeadlines.desktop).length;
      const attemptsAtExpiry = Number(record.desktopAttempts) - attemptsBefore;
      const status = record.desktopAttempts === 0 && desktopIntents.length === row.piDesktopIntents && pendingAfter === 0
        && deadlineKeysAfter === 0 && attemptsAtExpiry === 0 ? "pass" : "fail";
      record.desktopTtlCheck = { evidenceKind: "deadline input at the expiry clock; not real elapsed time", expiryClock,
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
    for (const channel of Object.values(h.root.state.notificationChannels)) if (channel.kind === "running" || channel.kind === "stopping")
      await abortNotificationAttempt({ attemptId: channel.attempt.attemptId, cause: "shutdown" }, clock().monotonicMs + 1_000, clock);
    await Promise.allSettled(runs);
    await h.root.diagnostics.flush();
    vi.mocked(childProcess.spawn).mockImplementation(originalSpawn);
    rmSync(directory, { recursive: true, force: true });
  }
}

it.skipIf(!enabled || target !== "macos")("C2 macOS real backend", async () => { await measure("macos"); });
it.skipIf(!enabled || target !== "linux-rpi")("C2 Linux Raspberry Pi real backend", async () => { await measure("linux-rpi"); });
it.skipIf(!enabled || target === "macos" || target === "linux-rpi")("C2 requires an explicit supported OS", () => {
  throw new Error("C2 blocked: FLEQ_A7_C2_OS must be macos or linux-rpi");
});
// P3-FG-T05（AC07）: 本番は -t AC07 で走らせる。名前に C2 を含めない（C2 の command の -t C2 に拾われる）。
const ac07 = process.env.FLEQ_C22_AC07;
it.skipIf(ac07 !== "macos")("AC07 T2 macOS real backend", async () => { await measure("macos", t2); });
it.skipIf(ac07 !== "linux-rpi")("AC07 T2 Linux Raspberry Pi real backend", async () => { await measure("linux-rpi", t2); });
it.skipIf(ac07 == null || ac07 === "macos" || ac07 === "linux-rpi")("AC07 requires an explicit supported OS", () => {
  throw new Error("AC07 T2 blocked: FLEQ_C22_AC07 must be macos or linux-rpi");
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
