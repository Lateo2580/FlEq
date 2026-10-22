import { testNotificationChannels, recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { promises as fs, readFileSync, readdirSync } from "node:fs";
import * as fileSystem from "node:fs";
import * as childProcess from "node:child_process";
import { probeDesktopBackend } from "../../src/notification-delivery/adapter";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClockReading, NotificationIntent, NotificationResult, RuntimeInput } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import { applyNotificationResult, resolveSoundAsset, selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import type { PublisherState } from "../../src/runtime/shared-runtime";
import { harnessedRoot, manualAdapter, park, seeded, startHarness, submit } from "../execution-split/owner-harness";
import { at, background, calls, eewEnvelope, notice } from "./delivery-fixture";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await fs.rm(path, { recursive: true, force: true, maxRetries: 3 }); });
function config() {
  const directory = fileSystem.mkdtempSync(join(tmpdir(), "fleq-a7-"));
  directories.push(directory);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(directory, "state"),
    legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "diagnostics") } as const;
}
// TEST-PATH (2): the real A1/A7 path with in-process owners; attempts end when the test finishes them.
async function delivery(start: ClockReading, options: Readonly<{ probe?: boolean; channels?: Extract<RuntimeInput,
  { kind: "notificationProbeCompleted" }>["channels"] }> = {}) {
  let now = start;
  const seeds = seeded(calls.units);
  const notices = manualAdapter();
  const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => now, notificationAdapter: notices.adapter,
    runtimeCalls: { ...calls, units: seeds.units } });
  await startHarness(h, "a7", start, false);
  if (options.probe !== false) {
    h.root.dispatch({ kind: "notificationProbeCompleted", channels: options.channels ?? testNotificationChannels, clock: start });
    await h.settle();
  }
  return { h, root: h.root, seeds, notices,
    at(time: ClockReading) { now = time; },
    async tick(time: ClockReading) { now = time; h.root.tick(time); await h.settle(); },
    async finish(result: NotificationResult) { now = result.completedAt; notices.finish(result); await h.settle(); },
    started(from: number) { return notices.runs.slice(from).map((run) => run.attempt); } };
}
const key = (item: NotificationIntent) => JSON.stringify([item.unit, item.id]);
const mapSize = (state: PublisherState) => Object.values(state.notificationDeadlines).reduce((n, map) => n + Object.keys(map).length, 0);

describe("P2-A7 notification delivery", () => {
  it("T01 acceptance C1: real A4 A/B generation preempts the frozen four-pending background on both channels", async () => {
    const foreground = at(1_000);
    const d = await delivery(at(900));
    await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: background(foreground) });
    // AC11(d): the lower attempts start once their owner adopted the reservation.
    const lower = d.started(0);
    expect(lower.map(item => item.intentId)).toEqual(["lower-desktop", "lower-sound"]);
    expect(d.h.unit("U-W").intents.filter(item => item.disposition === "pending")).toHaveLength(4);
    d.at(foreground);
    await submit(d.h, eewEnvelope("a7", foreground, "A"));
    expect(d.notices.aborts).toEqual(lower.map((item) => item.attemptId));
    expect(lower.map((item) => d.root.state.notificationChannels[item.channel])).toMatchObject([
      { kind: "stopping", cause: "higherPriority" }, { kind: "stopping", cause: "higherPriority" }]);
    expect(d.h.unit("U-E").intents).toHaveLength(2);
    d.at(at(1_010));
    await submit(d.h, eewEnvelope("a7", at(1_010), "B"));
    expect(d.h.unit("U-E").intents).toHaveLength(4);
    expect(d.started(2)).toEqual([]);
    const starts: { event: string; channel: string; elapsed: number }[] = [];
    let active: NotificationAttempt[] = [];
    for (const attempt of lower) {
      // Natural completion is +700ms; injected abort close is +50ms.
      const before = d.notices.runs.length;
      await d.finish({ kind: "aborted", reason: "higherPriority", stopped: true,
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: at(1_050) });
      active.push(...d.started(before));
    }
    for (const [event, generated, complete] of [["A", 1_000, 1_150], ["B", 1_010, 1_250]] as const) {
      const following: NotificationAttempt[] = [];
      expect(active).toHaveLength(2);
      for (const selected of active) {
        expect(selected.payload).toEqual(d.h.unit("U-E").intents.find(item => item.id === selected.intentId)!.payload);
        expect(selected.subject).toContain(event === "A" ? "20990101000001" : "20990101000002");
        starts.push({ event, channel: selected.channel, elapsed: selected.selectedAtMonotonicMs - generated });
        const before = d.notices.runs.length;
        await d.finish({ kind: "delivered",
          attemptId: selected.attemptId, intentId: selected.intentId, channel: selected.channel, completedAt: at(complete) });
        following.push(...d.started(before));
      }
      active = following;
    }
    expect(active.map(item => item.intentId)).toEqual(["retry-desktop", "retry-sound"]);
    expect(starts.map(item => item.elapsed)).toEqual([50, 50, 140, 140]);
    console.info("A7 C1 generation-to-call markers", starts);
  });

  it("T02 regression #1: simultaneous TTL/timeout terminal releases the expired channel and dispatches its successor", async () => {
    const first = { ...notice("one"), expiresAt: at(5_000).wallTimeMs };
    const next = { ...notice("two"), nextAttemptAt: at(5_000).wallTimeMs };
    const d = await delivery(at(0));
    await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: [first, next] });
    const attempt = d.started(0)[0];
    expect(attempt.intentId).toBe("one");
    await d.finish({ kind: "timeout", stopped: true, attemptId: attempt.attemptId,
      intentId: attempt.intentId, channel: attempt.channel, completedAt: at(5_000) });
    // The run already settled, so its expiry needs no abort call (as before: no abort for the completed run).
    expect(d.notices.aborts).toEqual([]);
    // P3-NL-AC05 (1): 終端の intent は intents から外れる。
    expect(d.h.unit("U-W").intents.some((item) => item.id === "one")).toBe(false);
    expect(d.started(1).map(item => item.intentId)).toEqual(["two"]);
    expect(d.root.state.notificationDeadlines.desktop[key(first)]).toBeUndefined();
    await d.root.diagnostics.flush();
    expect((await d.root.readDiagnostics({ limit: 256 })).records.some(item => item.reason === "notificationAttemptFailed")).toBe(false);
  });

  // P3-NL-AC06 (2): 試行の期限の後の終わり（desktop の timeout）は通知したか不明で終端にし、再試行しない（旧: timeout の backoff）。
  it("T02 regression #3: success after the attempt deadline ends as outcome unknown instead of a retry", async () => {
    const first = { ...notice("one"), expiresAt: at(15_000).wallTimeMs };
    const d = await delivery(at(0));
    await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: [first] });
    const attempt = d.started(0)[0];
    await d.finish({ kind: "delivered",
      attemptId: attempt.attemptId, intentId: attempt.intentId, channel: "desktop", completedAt: at(5_001) });
    expect(d.started(1)).toEqual([]);
    expect(d.h.unit("U-W").intents).toEqual([]);
    await d.root.diagnostics.flush();
    expect((await d.root.readDiagnostics({ limit: 256 })).records.filter(item => item.reason === "notificationAttemptFailed")).toHaveLength(1);
    await d.tick(at(6_001));
    expect(d.started(1)).toEqual([]);
  });

  it("T03 contractBoundary: A1 adopts 384 keys and reclaims terminal/deleted owners in the same step, including capacity-sized ticks", async () => {
    const adoptedRun = await delivery(at(0));
    await submit(adoptedRun.h, eewEnvelope("a7", at(0)));
    const adopted = adoptedRun.h.unit("U-E").intents[0];
    const pending = (unit: NotificationIntent["unit"]) => Array.from({ length: 128 }, (_, i) => ({
      ...(unit === "U-E" ? adopted : notice(`${unit}-${i}`)), unit, id: `${unit}-${i}`,
      channel: i % 2 === 0 ? "desktop" as const : "sound" as const, attempts: 0,
      expiresAt: at(15_000).wallTimeMs, nextAttemptAt: at(0).wallTimeMs,
    }));
    const d = await delivery(at(0));
    await d.seeds.eew(d.h, { ...d.h.unit("U-E"), intents: pending("U-E").map(item => ({ ...item, payload: adopted.payload })) });
    await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: pending("U-W") });
    await d.seeds.series(d.h, { ...d.h.unit("U-F"), intents: pending("U-F") });
    expect(mapSize(d.root.state)).toBe(384);
    expect(d.started(0)).toHaveLength(2);
    const attempt = d.started(0)[0];
    await d.finish({ kind: "delivered",
      attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: at(1) });
    expect(mapSize(d.root.state)).toBe(383);
    expect(d.root.state.notificationDeadlines[attempt.channel][JSON.stringify([attempt.unit, attempt.intentId])]).toBeUndefined();
    const weather = d.h.unit("U-W");
    const removed = weather.intents.find((item) => item.disposition === "pending")!;
    await d.seeds.weather(d.h, { ...weather, intents: weather.intents.filter((item) => item !== removed) }, null, at(2));
    await d.tick(at(2));
    expect(mapSize(d.root.state)).toBe(382);
    expect(d.root.state.notificationDeadlines[removed.channel][key(removed)]).toBeUndefined();
    await d.tick({ wallTimeMs: at(0).wallTimeMs - 100, monotonicMs: 15_000 });
    expect(mapSize(d.root.state)).toBe(0);

    // AC04/TIME.complexity: the same real A1/A7 tick with 128 pending + 4000 terminal per weather owner.
    const large = (unit: "U-W" | "U-F") => [...Array.from({ length: 4_000 }, (_, i) => ({
      ...notice(`${unit}-terminal-${i}`), unit, disposition: "delivered" as const,
    })), ...pending(unit)];
    const big = await delivery(at(0), { probe: false });
    await big.seeds.weather(big.h, { ...big.h.unit("U-W"), intents: large("U-W") });
    await big.seeds.series(big.h, { ...big.h.unit("U-F"), intents: large("U-F") });
    const started = performance.now();
    big.root.dispatch({ kind: "notificationProbeCompleted", channels: testNotificationChannels, clock: at(0) });
    await big.h.settle();
    console.info(`A7 capacity tick: ${(performance.now() - started).toFixed(2)}ms`);
    expect(mapSize(big.root.state)).toBe(256);
    expect(big.started(0)).toHaveLength(2);
  });

  it("T03 contractBoundary R34: unavailable desktop never attempts and is reclaimed at its original TTL", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const exists = vi.mocked(fileSystem.existsSync).mockClear().mockReturnValue(false);
    const spawn = vi.mocked(childProcess.spawn).mockClear();
    try {
      const desktop = probeDesktopBackend();
      expect(desktop).toEqual({ kind: "unavailable", reason: "backendMissing" });
      expect(exists).toHaveBeenCalledExactlyOnceWith("/usr/bin/notify-send");
      expect(spawn).not.toHaveBeenCalled();
      const original = { ...notice("unavailable"), expiresAt: at(1_000).wallTimeMs };
      const d = await delivery(at(0), { channels: { desktop, sound: { kind: "idle" } } });
      await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: [original] });
      await d.tick(at(999));
      expect(d.started(0)).toEqual([]);
      expect(d.h.unit("U-W").intents).toEqual([original]);
      await d.root.diagnostics.flush();
      expect((await d.root.readDiagnostics({ limit: 256 })).records.map((item) => item.reason)).toEqual(["notificationAttemptFailed"]);
      const deliveryState = { intents: d.h.unit("U-W").intents,
        channels: d.root.state.notificationChannels, deadlines: d.root.state.notificationDeadlines };
      const expiry = selectNotificationAttempt(deliveryState, at(1_000));
      expect(expiry.attempts).toEqual([]);
      expect(expiry.state.intents).toEqual([{ ...original, disposition: "expired" }]);
      await d.tick(at(1_000));
      expect(d.started(0)).toEqual([]);
      expect(d.root.state.notificationChannels.desktop).toEqual(desktop);
      expect(d.root.state.notificationDeadlines.desktop).toEqual({});
      expect(d.h.unit("U-W").intents.every(item => item.disposition === "expired" && item.attempts === 0)).toBe(true);
      expect(exists).toHaveBeenCalledTimes(1);
    } finally { platform.mockRestore(); exists.mockRestore(); spawn.mockRestore(); }
  });

  it("T04 corpusHistory: O07 acknowledged pending restores original times; a separate delayed ack does not hold dispatch", async () => {
    const oracle = JSON.parse(readFileSync("reconstruction/tools/corpus/sequences.json", "utf8")) as {
      expectations: { expectedId: string; intents: unknown }[] };
    expect(oracle.expectations.filter(item => [16, 17, 18].some(i => item.expectedId === `expected:O07:${i}`))
      .map(item => item.intents)).toEqual([null, null, null]);
    const settings = config();
    let clock = at(0), held = true;
    const gated = { ...calls, selectNotificationAttempt: (state: Parameters<typeof selectNotificationAttempt>[0], now: typeof clock) =>
      held ? { state, attempts: [], abortRequests: [], diagnostics: [] } : selectNotificationAttempt(state, now) };
    // The restored root's saves can be held at open (the separate delayed acknowledgement below).
    const files = nodeCheckpointFileSystem();
    let gate: Promise<void> | null = null;
    const notices = manualAdapter();
    const h = harnessedRoot(settings, linkedUnitCodecs, { notificationAdapter: notices.adapter, runtimeCalls: gated, clock: () => clock });
    const restored = harnessedRoot(settings, linkedUnitCodecs, { notificationAdapter: notices.adapter, runtimeCalls: gated, clock: () => clock,
      checkpointFileSystem: { ...files, open: async (path) => { await park(gate); return files.open(path); } } });
    try {
      await startHarness(h, "o07", clock, false);
      expect(h.root.state.notificationProbeComplete).toBe(false);
      await submit(h, eewEnvelope("o07", clock));
      expect(h.root.state.notificationChannels.desktop.kind).toBe("idle");
      h.root.dispatch({ kind: "notificationProbeCompleted", channels: testNotificationChannels, clock });
      await h.settle();
      const original = h.unit("U-E").intents;
      expect(original).toHaveLength(2);
      await h.root.driveCheckpoint();
      await h.settle();
      expect(h.root.state.mirror["U-E"].persistence.kind).toBe("saved");
      expect(h.unit("U-E").intents).toEqual(original);
      clock = at(500);
      await startHarness(restored, "restored", clock, false);
      expect(restored.unit("U-E").intents).toEqual(original);
      expect(restored.root.state.notificationProbeComplete).toBe(false);
      expect(Object.values(restored.root.state.notificationDeadlines.desktop)[0]).toEqual({ retryAtMonotonicMs: 500, expiresAtMonotonicMs: 15_000 });
      clock = { wallTimeMs: at(-500).wallTimeMs, monotonicMs: 550 };
      restored.root.tick(clock);
      await restored.settle();
      expect(notices.runs).toEqual([]);
      restored.root.dispatch({ kind: "notificationProbeCompleted", channels: testNotificationChannels, clock });
      await restored.settle();
      expect(Object.values(restored.root.state.notificationDeadlines.desktop)[0]).toEqual({ retryAtMonotonicMs: 500, expiresAtMonotonicMs: 15_000 });
      // Separate fault: grant the selected generation's save but hold its acknowledgement while the adapter result arrives.
      // The selection's adoption saves at once (P3-UWR-AC03), so the gate comes before it (AC10(7)).
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = resolve; });
      held = false;
      restored.root.tick(clock);
      await restored.settle();
      const attempt = notices.runs[0].attempt;
      const startedCount = notices.runs.length;
      expect(attempt.expiresAt).toBe(original[0].expiresAt);
      const delayed = restored.root.checkpoint.grantOf("U-E")?.grantId;
      await restored.settle();
      expect(restored.root.checkpoint.grantOf("U-E")).not.toBeNull();
      expect(restored.root.state.mirror["U-E"].persistence.kind).not.toBe("saved");
      clock = at(600);
      // P3-NL-AC06 (2): 再試行するのは起動しなかった試行（notStarted）。起動した後の失敗は通知したか不明で終端になる。
      notices.finish({ kind: "failed", reason: "notStarted",
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock });
      await restored.settle();
      const deadline = restored.root.state.notificationDeadlines[attempt.channel][JSON.stringify(["U-E", attempt.intentId])];
      expect(deadline).toEqual({ retryAtMonotonicMs: 1_600, expiresAtMonotonicMs: 15_000 });
      release();
      await restored.settle();
      expect(restored.newDone().map((reply) => reply.grantId)).toContain(delayed);
      clock = { wallTimeMs: at(-1_000).wallTimeMs, monotonicMs: 1_599 };
      restored.root.tick(clock);
      await restored.settle();
      expect(notices.runs).toHaveLength(startedCount);
      expect(restored.root.state.notificationDeadlines[attempt.channel][JSON.stringify(["U-E", attempt.intentId])]).toEqual(deadline);
      clock = { wallTimeMs: original[0].expiresAt, monotonicMs: 1_600 };
      restored.root.tick(clock);
      await restored.settle();
      expect(notices.runs).toHaveLength(startedCount);
      expect(mapSize(restored.root.state)).toBe(0);
      expect(restored.unit("U-E").intents).toEqual([]);
    } finally {
      await h.root.diagnostics.flush(); await restored.root.diagnostics.flush();
    }
  });

  it("T05 contractBoundary: every WAV uses the same normalization multiplier and sound operation/domain boundaries hold", async () => {
    const files = readdirSync("reconstruction/assets/sounds").filter(file => file.endsWith(".wav"));
    expect(files).toHaveLength(20);
    let multiplier: number | undefined, peak = 0;
    // Independent first-note sample from sound-design-system: before a second hit and before release.
    // One multiplier is inferred once, then checked across all domains/levels (individual normalization fails).
    for (const [domain, root] of Object.entries({ weather: 261.63, volcano: 392, "earthquake-eew": 523.25, tsunami: 698.46 })) {
      for (const level of ["normal", "info", "warning", "critical", "cancel"] as const) {
        const bytes = readFileSync(`reconstruction/assets/sounds/${domain}-${level}.wav`);
        expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
        expect(resolveSoundAsset({ domain, level })).toBe(`reconstruction/assets/sounds/${domain}-${level}.wav`);
        const chord = domain === "tsunami" ? [0, 1, 6] : [0, 3, 7];
        const notes = level === "normal" ? [0] : level === "info" ? [-3] : level === "cancel" ? [7]
          : level === "critical" ? chord.map(n => n + 12) : chord;
        const gain = { normal: .8, info: .5, warning: .9, critical: 1, cancel: .6 }[level];
        const decay = level === "critical" ? 14 : level === "cancel" ? 8 : 9;
        const t = 400 / 44100;
        const raw = notes.reduce((sum, n) => { const phase = 2 * Math.PI * root * 2 ** (n / 12) * t;
          return sum + Math.sin(phase) + .25 * Math.sin(2 * phase); }, 0) / notes.length * gain * Math.exp(-decay * t);
        const pcm = bytes.readInt16LE(44 + 400 * 2);
        multiplier ??= pcm / raw;
        expect(Math.abs(pcm - raw * multiplier)).toBeLessThan(2);
        for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
      }
    }
    expect(peak).toBe(Math.round(32767 * 10 ** (-3 / 20)));
    expect(resolveSoundAsset({ domain: "unknown", level: "critical" })).toBeNull();
    const d = await delivery(at(0));
    await d.seeds.weather(d.h, { ...d.h.unit("U-W"), intents: (["training", "test"] as const).map(operation => ({ ...notice(operation, "sound"), operation })) });
    await d.tick(at(0));
    expect(d.started(0)).toEqual([]);
  });
});

// P3-NL-T04 (e)（P3-NL-AC06 (2)）: notStarted は再試行（lastAttempt failed）。sound の起動した後の失敗・timeout・上位群の中断は 1 回だけ
// 鳴らし直し（replayed、期限は終わった時＋元の長さ）、鳴らし直しも同じに終わると通知したか不明で終端。desktop の同じ終わりは鳴らし直さない。
it("P3-NL-T04 contractBoundary / AC06 (e): notStarted retries, a started sound replays once, then the outcome is unknown", () => {
  const end = (intent: NotificationIntent, result: (attempt: NotificationAttempt) => NotificationResult) => {
    const deadline = { [JSON.stringify([intent.unit, intent.id])]: { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e12 } };
    const selected = selectNotificationAttempt({ intents: [intent], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: { desktop: intent.channel === "desktop" ? deadline : {}, sound: intent.channel === "sound" ? deadline : {} } }, at(0));
    return applyNotificationResult(selected.state, result(selected.attempts[0]), at(1_000));
  };
  const of = (attempt: NotificationAttempt) => ({ attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: at(1_000) });
  const sound = notice("s", "sound"), desktop = notice("d", "desktop");
  expect(end(sound, (attempt) => ({ kind: "failed", reason: "notStarted", ...of(attempt) })).state.intents[0])
    .toMatchObject({ disposition: "pending", lastAttempt: "failed", replayed: false, expiresAt: sound.expiresAt });
  const unknown = (step: ReturnType<typeof end>) => [step.state.intents[0].disposition, step.diagnostics.some((item) => item.reason === "notificationOutcomeUnknown")];
  for (const result of [(attempt: NotificationAttempt): NotificationResult => ({ kind: "failed", reason: "adapterRejected", ...of(attempt) }),
    (attempt: NotificationAttempt): NotificationResult => ({ kind: "timeout", stopped: true, ...of(attempt) }),
    (attempt: NotificationAttempt): NotificationResult => ({ kind: "aborted", reason: "higherPriority", stopped: true, ...of(attempt) })]) {
    const replay = end(sound, result).state.intents[0];
    expect(replay).toMatchObject({ disposition: "pending", lastAttempt: "failed", replayed: true, expiresAt: at(1_000).wallTimeMs + 60_000 });
    expect(unknown(end(replay, result))).toEqual(["expired", true]);
  }
  expect(unknown(end(desktop, (attempt) => ({ kind: "failed", reason: "adapterRejected", ...of(attempt) })))).toEqual(["expired", true]);
});
