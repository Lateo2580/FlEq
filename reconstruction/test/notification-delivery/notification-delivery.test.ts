import { promises as fs, readFileSync, readdirSync } from "node:fs";
import * as fileSystem from "node:fs";
import * as childProcess from "node:child_process";
import { probeDesktopBackend } from "../../src/notification-delivery/adapter";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NotificationIntent, NotificationResult, RuntimeState } from "../../contracts/p2-shared-runtime.types";
import { resolveSoundAsset, selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { RuntimeCompositionRoot, linkedUnitCodecs } from "../../src/runtime/composition-root";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { at, background, calls, eewInput, empty, notice, tick } from "./delivery-fixture";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const seed = (intents: readonly NotificationIntent[]): RuntimeState => {
  const state = empty();
  return { ...state, units: { ...state.units, "U-W": { ...state.units["U-W"], intents } } };
};
const key = (item: NotificationIntent) => JSON.stringify([item.unit, item.id]);
const mapSize = (state: RuntimeState) => Object.values(state.notificationDeadlines).reduce((n, map) => n + Object.keys(map).length, 0);

describe("P2-A7 notification delivery", () => {
  it("T01 acceptance C1: real A4 A/B generation preempts the frozen four-pending background on both channels", () => {
    const start = at(0), foreground = at(1_000);
    let current = background(empty(start), foreground);
    let step = reduceRuntime(current, tick(current, at(900)), calls);
    current = step.state;
    const lower = step.notificationAttempts;
    expect(lower.map(item => item.intentId)).toEqual(["lower-desktop", "lower-sound"]);
    expect(current.units["U-W"].intents.filter(item => item.disposition === "pending")).toHaveLength(4);
    const a = reduceRuntime(current, eewInput(current, foreground, "A"), calls);
    expect(a.abortRequests.map(item => item.cause)).toEqual(["higherPriority", "higherPriority"]);
    expect(a.state.units["U-E"].intents).toHaveLength(2);
    const b = reduceRuntime(a.state, eewInput(a.state, at(1_010), "B"), calls);
    expect(b.state.units["U-E"].intents).toHaveLength(4);
    expect(b.notificationAttempts).toEqual([]);
    current = b.state;
    const starts: { event: string; channel: string; elapsed: number }[] = [];
    let active = [] as typeof lower[number][];
    for (const attempt of lower) {
      // Natural completion is +700ms; injected abort close is +50ms.
      step = reduceRuntime(current, { kind: "notificationResult", result: { kind: "aborted", reason: "higherPriority", stopped: true,
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: at(1_050) } }, calls);
      current = step.state; active.push(...step.notificationAttempts);
    }
    for (const [event, generated, complete] of [["A", 1_000, 1_150], ["B", 1_010, 1_250]] as const) {
      const following: typeof active = [];
      expect(active).toHaveLength(2);
      for (const selected of active) {
        expect(selected.payload).toEqual(current.units["U-E"].intents.find(item => item.id === selected.intentId)!.payload);
        expect(selected.subject).toContain(event === "A" ? "20990101000001" : "20990101000002");
        starts.push({ event, channel: selected.channel, elapsed: selected.selectedAtMonotonicMs - generated });
        step = reduceRuntime(current, { kind: "notificationResult", result: { kind: "delivered",
          attemptId: selected.attemptId, intentId: selected.intentId, channel: selected.channel, completedAt: at(complete) } }, calls);
        current = step.state; following.push(...step.notificationAttempts);
      }
      active = following;
    }
    expect(active.map(item => item.intentId)).toEqual(["retry-desktop", "retry-sound"]);
    expect(starts.map(item => item.elapsed)).toEqual([50, 50, 140, 140]);
    console.info("A7 C1 generation-to-call markers", starts);
  });

  it("T02 regression #1: simultaneous TTL/timeout terminal releases the expired channel and dispatches its successor", () => {
    const first = { ...notice("one"), expiresAt: at(5_000).wallTimeMs };
    const next = { ...notice("two"), nextAttemptAt: at(5_000).wallTimeMs };
    const initial = seed([first, next]);
    const selected = reduceRuntime(initial, tick(initial, at(0)), calls);
    const attempt = selected.notificationAttempts[0];
    const terminal: NotificationResult = { kind: "timeout", stopped: true, attemptId: attempt.attemptId,
      intentId: attempt.intentId, channel: attempt.channel, completedAt: at(5_000) };
    const done = reduceRuntime(selected.state, { kind: "notificationResult", result: terminal }, calls);
    expect(done.abortRequests).toContainEqual({ attemptId: attempt.attemptId, cause: "expired" });
    expect(done.notificationAttempts.map(item => item.intentId)).toEqual(["two"]);
    expect(done.state.notificationDeadlines.desktop[key(first)]).toBeUndefined();
    expect(done.diagnostics.some(item => item.reason === "notificationAttemptFailed")).toBe(false);
  });

  it("T02 regression #3: success after the attempt deadline becomes timeout backoff instead of an immediate retry", () => {
    const first = { ...notice("one"), expiresAt: at(15_000).wallTimeMs };
    const initial = seed([first]);
    const selected = reduceRuntime(initial, tick(initial, at(0)), calls);
    const attempt = selected.notificationAttempts[0];
    const done = reduceRuntime(selected.state, { kind: "notificationResult", result: { kind: "delivered",
      attemptId: attempt.attemptId, intentId: attempt.intentId, channel: "desktop", completedAt: at(5_001) } }, calls);
    expect(done.notificationAttempts).toEqual([]);
    expect(done.state.units["U-W"].intents[0]).toMatchObject({ disposition: "pending", nextAttemptAt: at(6_001).wallTimeMs });
    expect(done.state.notificationDeadlines.desktop[key(first)]).toEqual({ retryAtMonotonicMs: 6_001, expiresAtMonotonicMs: 15_000 });
    expect(done.diagnostics.filter(item => item.reason === "notificationAttemptFailed")).toHaveLength(1);
    expect(reduceRuntime(done.state, tick(done.state, at(6_000)), calls).notificationAttempts).toEqual([]);
    expect(reduceRuntime(done.state, tick(done.state, at(6_001)), calls).notificationAttempts).toHaveLength(1);
  });

  it("T03 contractBoundary: A1 adopts 384 keys and reclaims terminal/deleted owners in the same step, including capacity-sized ticks", () => {
    let current = empty();
    const adopted = reduceRuntime(current, eewInput(current, at(0)), calls).state.units["U-E"].intents[0];
    const pending = (unit: NotificationIntent["unit"]) => Array.from({ length: 128 }, (_, i) => ({
      ...(unit === "U-E" ? adopted : notice(`${unit}-${i}`)), unit, id: `${unit}-${i}`,
      channel: i % 2 === 0 ? "desktop" as const : "sound" as const, attempts: 0,
      expiresAt: at(15_000).wallTimeMs, nextAttemptAt: at(0).wallTimeMs,
    }));
    current = { ...current, units: { ...current.units,
      "U-E": { ...current.units["U-E"], intents: pending("U-E").map(item => ({ ...item, payload: adopted.payload })) },
      "U-W": { ...current.units["U-W"], intents: pending("U-W") },
      "U-F": { ...current.units["U-F"], intents: pending("U-F") },
    } };
    const selected = reduceRuntime(current, tick(current, at(0)), calls);
    expect(mapSize(selected.state)).toBe(384);
    expect(selected.notificationAttempts).toHaveLength(2);
    const attempt = selected.notificationAttempts[0];
    const done = reduceRuntime(selected.state, { kind: "notificationResult", result: { kind: "delivered",
      attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: at(1) } }, calls);
    expect(mapSize(done.state)).toBe(383);
    expect(done.state.notificationDeadlines[attempt.channel][JSON.stringify([attempt.unit, attempt.intentId])]).toBeUndefined();
    const removed = done.state.units["U-W"].intents[0];
    current = { ...done.state, units: { ...done.state.units,
      "U-W": { ...done.state.units["U-W"], intents: done.state.units["U-W"].intents.slice(1) } } };
    const collected = reduceRuntime(current, tick(current, at(2)), calls);
    expect(mapSize(collected.state)).toBe(382);
    expect(collected.state.notificationDeadlines[removed.channel][key(removed)]).toBeUndefined();
    const expired = reduceRuntime(collected.state, tick(collected.state, { wallTimeMs: at(0).wallTimeMs - 100, monotonicMs: 15_000 }), calls);
    expect(mapSize(expired.state)).toBe(0);

    // AC04/TIME.complexity: the same real A1/A7 tick with 128 pending + 4000 terminal per weather owner.
    current = empty();
    const large = (unit: "U-W" | "U-F") => [...Array.from({ length: 4_000 }, (_, i) => ({
      ...notice(`${unit}-terminal-${i}`), unit, disposition: "delivered" as const,
    })), ...pending(unit)];
    current = { ...current, units: { ...current.units, "U-W": { ...current.units["U-W"], intents: large("U-W") },
      "U-F": { ...current.units["U-F"], intents: large("U-F") } } };
    const started = performance.now();
    const measured = reduceRuntime(current, tick(current, at(0)), calls);
    console.info(`A7 capacity tick: ${(performance.now() - started).toFixed(2)}ms`);
    expect(mapSize(measured.state)).toBe(256);
    expect(measured.notificationAttempts).toHaveLength(2);
  });

  it("T03 contractBoundary R34: unavailable desktop never attempts and is reclaimed at its original TTL", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const exists = vi.mocked(fileSystem.existsSync).mockClear().mockReturnValue(false);
    const spawn = vi.mocked(childProcess.spawn).mockClear();
    try {
      const desktop = probeDesktopBackend();
      expect(desktop).toEqual({ kind: "unavailable", reason: "backendMissing" });
      expect(exists).toHaveBeenCalledExactlyOnceWith("/usr/bin/notify-send");
      expect(spawn).not.toHaveBeenCalled();
      const original = { ...notice("unavailable"), expiresAt: at(1_000).wallTimeMs };
      const initial = seed([original]);
      const current = { ...initial, notificationChannels: { ...initial.notificationChannels, desktop } };
      const adopted = reduceRuntime(current, tick(current, at(0)), calls);
      const beforeExpiry = reduceRuntime(adopted.state, tick(adopted.state, at(999)), calls);
      expect(beforeExpiry.notificationAttempts).toEqual([]);
      expect(beforeExpiry.state.units["U-W"].intents).toEqual([original]);
      expect(beforeExpiry.diagnostics).toEqual([]);
      const delivery = { intents: beforeExpiry.state.units["U-W"].intents,
        channels: beforeExpiry.state.notificationChannels, deadlines: beforeExpiry.state.notificationDeadlines };
      const expiry = selectNotificationAttempt(delivery, at(1_000));
      expect(expiry.attempts).toEqual([]);
      expect(expiry.state.intents).toEqual([{ ...original, disposition: "expired" }]);
      const reclaimed = reduceRuntime(beforeExpiry.state, tick(beforeExpiry.state, at(1_000)), calls);
      expect(reclaimed.notificationAttempts).toEqual([]);
      expect(reclaimed.state.notificationChannels.desktop).toEqual(desktop);
      expect(reclaimed.state.notificationDeadlines.desktop).toEqual({});
      expect(reclaimed.state.units["U-W"].intents.every(item => item.disposition === "expired" && item.attempts === 0)).toBe(true);
      expect(exists).toHaveBeenCalledTimes(1);
    } finally { platform.mockRestore(); exists.mockRestore(); spawn.mockRestore(); }
  });

  it("T04 corpusHistory: O07 acknowledged pending restores original times; a separate delayed ack does not hold dispatch", async () => {
    const oracle = JSON.parse(readFileSync("reconstruction/tools/corpus/sequences.json", "utf8")) as {
      expectations: { expectedId: string; intents: unknown }[] };
    expect(oracle.expectations.filter(item => [16, 17, 18].some(i => item.expectedId === `expected:O07:${i}`))
      .map(item => item.intents)).toEqual([null, null, null]);
    const directory = await fs.mkdtemp(join(tmpdir(), "fleq-a7-o07-"));
    const settings = { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(directory, "state"),
      legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "diagnostics") } as const;
    let clock = at(0), held = true;
    const gated = { ...calls, selectNotificationAttempt: (state: Parameters<typeof selectNotificationAttempt>[0], now: typeof clock) =>
      held ? { state, attempts: [], abortRequests: [], diagnostics: [] } : selectNotificationAttempt(state, now) };
    const root = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls: gated, clock: () => clock });
    const restoredRoot = new RuntimeCompositionRoot(settings, linkedUnitCodecs, { runtimeCalls: gated, clock: () => clock });
    try {
      root.startRuntime("o07", clock);
      root.dispatch(root.state, eewInput(root.state, clock));
      const original = root.state.units["U-E"].intents;
      expect(original).toHaveLength(2);
      const reservation = root.scheduleCheckpoint(root.state, clock, root.state.runId)!;
      expect(reservation.request).not.toBeNull();
      const saved = await root.executeCheckpoint(reservation.request!, root.state.runId, ["O07:15"], "notRetry");
      root.applyCheckpointResult(root.state, saved.result, clock);
      expect(root.state.units["U-E"].persistence.kind).toBe("saved");
      expect(root.state.units["U-E"].intents).toEqual(original);
      clock = at(500);
      restoredRoot.startRuntime("restored", clock);
      expect(restoredRoot.state.units["U-E"].intents).toEqual(original);
      expect(Object.values(restoredRoot.state.notificationDeadlines.desktop)[0]).toEqual({ retryAtMonotonicMs: 500, expiresAtMonotonicMs: 15_000 });
      held = false;
      const dispatch = restoredRoot.tick(restoredRoot.state, clock);
      const attempt = dispatch.notificationAttempts[0];
      expect(attempt.expiresAt).toBe(original[0].expiresAt);
      // Separate fault: reserve the selected generation but hold its acknowledgement while the adapter result arrives.
      const delayed = restoredRoot.scheduleCheckpoint(restoredRoot.state, clock, restoredRoot.state.runId)!;
      expect(delayed.request).not.toBeNull();
      expect(restoredRoot.state.units["U-E"].persistence.kind).not.toBe("saved");
      clock = at(600);
      restoredRoot.dispatch(restoredRoot.state, { kind: "notificationResult", result: { kind: "failed", reason: "adapterRejected",
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock } });
      const deadline = restoredRoot.state.notificationDeadlines[attempt.channel][JSON.stringify(["U-E", attempt.intentId])];
      expect(deadline).toEqual({ retryAtMonotonicMs: 1_600, expiresAtMonotonicMs: 15_000 });
      const ack = await restoredRoot.executeCheckpoint(delayed.request!, restoredRoot.state.runId, [], "notRetry");
      restoredRoot.applyCheckpointResult(restoredRoot.state, ack.result, clock);
      clock = { wallTimeMs: at(-1_000).wallTimeMs, monotonicMs: 1_599 };
      expect(restoredRoot.tick(restoredRoot.state, clock).notificationAttempts).toEqual([]);
      expect(restoredRoot.state.notificationDeadlines[attempt.channel][JSON.stringify(["U-E", attempt.intentId])]).toEqual(deadline);
      clock = { wallTimeMs: original[0].expiresAt, monotonicMs: 1_600 };
      expect(restoredRoot.tick(restoredRoot.state, clock).notificationAttempts).toEqual([]);
      expect(mapSize(restoredRoot.state)).toBe(0);
      expect(restoredRoot.state.units["U-E"].intents).toEqual([]);
    } finally {
      await root.diagnostics.flush(); await restoredRoot.diagnostics.flush();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("T05 contractBoundary: every WAV uses the same normalization multiplier and sound operation/domain boundaries hold", () => {
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
    const current = seed((["training", "test"] as const).map(operation => ({ ...notice(operation, "sound"), operation })));
    expect(reduceRuntime(current, tick(current, at(0)), calls).notificationAttempts).toEqual([]);
  });
});
