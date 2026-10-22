import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationResult } from "../../contracts/p2-shared-runtime.types";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { harnessedRoot, seeded, startHarness } from "../execution-split/owner-harness";
import { calls, notice } from "./delivery-fixture";
import type { NotificationAbortRequest, NotificationAttempt } from "../../contracts/p2-notification-delivery.types";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const child = (pid: number | undefined = 12345) => Object.assign(new EventEmitter(), { pid, kill: vi.fn(() => true) }) as unknown as ChildProcess;
const attempt: NotificationAttempt = { attemptId: "one", intentId: "one", unit: "U-W", subject: "one",
  operation: "normal", channel: "desktop", priorityGroup: "other", payload: { title: "-title", body: "\"body\"\n$(unchanged)" },
  soundAsset: null, selectedAtMonotonicMs: 0, timeoutAtMonotonicMs: 5_000, expiresAt: 15_000 };

it("T02 regression: kill and exit alone do not confirm stop; late close cannot deliver or allow overlap", async () => {
  const { abortNotificationAttempt, runNotificationAttempt } = await import("../../src/notification-delivery/adapter");
  const handle = child();
  vi.mocked(childProcess.spawn).mockReturnValue(handle);
  let now = { wallTimeMs: 0, monotonicMs: 0 };
  const clock = () => now;
  // TEST-PATH (2) decides selection, abort and isolation; the real adapter runs here by hand (its timers are fake).
  vi.useRealTimers();
  const directory = mkdtempSync(join(tmpdir(), "fleq-a7-adapter-"));
  const seeds = seeded(calls.units);
  const started: NotificationAttempt[] = [];
  const aborts: NotificationAbortRequest[] = [];
  let settleRun!: (result: NotificationResult) => void;
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(directory, "state"),
    legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "diagnostics") }, linkedUnitCodecs, {
    clock, runtimeCalls: { ...calls, units: seeds.units },
    notificationAdapter: { run: (value) => { started.push(value); return new Promise((resolve) => { settleRun = resolve; }); },
      abort: async (request) => { aborts.push(request); return {}; } } });
  try {
    await startHarness(h, "a7", now);
    await seeds.weather(h, { ...h.unit("U-W"), intents: [notice("one", "desktop", 0)] });
    const active = started[0];
    vi.useFakeTimers();
    const run = runNotificationAttempt(active, clock);
    vi.useRealTimers();
    await seeds.weather(h, { ...h.unit("U-W"), intents: [] });
    expect(aborts).toEqual([{ attemptId: active.attemptId, cause: "superseded" }]);
    vi.useFakeTimers();
    const stop = abortNotificationAttempt(aborts[0], 1_000, clock);
    expect(handle.kill).toHaveBeenCalledWith("SIGTERM");
    handle.emit("exit", 0);
    now = { wallTimeMs: 100, monotonicMs: 1_000 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stop).toEqual({ attemptId: active.attemptId, stopped: false, completedAt: now });
    expect(await run).toMatchObject({ kind: "aborted", reason: "superseded", stopped: false });
    expect(() => runNotificationAttempt({ ...attempt, attemptId: "two" }, clock)).toThrow("notification channel occupied");
    vi.useRealTimers();
    settleRun(await run);
    await h.settle();
    expect(h.root.state.notificationChannels.desktop.kind).toBe("isolated");
    handle.emit("close", 0);
    expect(await run).toMatchObject({ kind: "aborted", reason: "superseded", stopped: false });
    // The isolated channel takes no new attempt; the successor stays pending (a late success has no run to arrive by).
    await seeds.weather(h, { ...h.unit("U-W"), intents: [notice("two", "desktop", now.wallTimeMs)] });
    expect(h.root.state.notificationChannels.desktop.kind).toBe("isolated");
    expect(started).toHaveLength(1);
    expect(h.unit("U-W").intents[0].disposition).toBe("pending");
    await h.root.diagnostics.flush();
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("T02 regression #2 / R31: argv remains literal and completion samples the actual wall clock", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const { runNotificationAttempt } = await import("../../src/notification-delivery/adapter");
  const handle = child();
  vi.mocked(childProcess.spawn).mockReturnValue(handle);
  let now = { wallTimeMs: 0, monotonicMs: 0 };
  const run = runNotificationAttempt(attempt, () => now);
  expect(childProcess.spawn).toHaveBeenCalledWith("/usr/bin/osascript", ["-e", "on run argv", "-e",
    "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--",
    attempt.payload.title, attempt.payload.body], { shell: false, stdio: "ignore" });
  now = { wallTimeMs: 20_000, monotonicMs: 1 };
  handle.emit("close", 0);
  expect(await run).toMatchObject({ kind: "delivered", completedAt: now });
});

it("T02 regression #4: fallback waits for close, survives synchronous spawn failure, and obeys the original deadline", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { runNotificationAttempt } = await import("../../src/notification-delivery/adapter");
  const first = child(); Object.defineProperty(first, "pid", { value: undefined });
  const last = child();
  const spawn = vi.mocked(childProcess.spawn).mockReset().mockReturnValueOnce(first)
    .mockImplementationOnce(() => { throw new Error("ENOENT"); }).mockReturnValueOnce(last);
  let now = { wallTimeMs: 0, monotonicMs: 0 };
  const sound = { ...attempt, channel: "sound" as const, soundAsset: "reconstruction/assets/sounds/weather-info.wav" as const };
  const run = runNotificationAttempt(sound, () => now);
  first.emit("error", new Error("ENOENT"));
  expect(spawn).toHaveBeenCalledTimes(1);
  first.emit("close", null);
  expect(spawn.mock.calls.map(([exe]) => exe)).toEqual(["/usr/bin/ffplay", "/usr/bin/paplay", "/usr/bin/aplay"]);
  last.emit("close", 0);
  expect(await run).toMatchObject({ kind: "delivered", attemptId: "one" });
  const atDeadline = child(); spawn.mockReset().mockReturnValue(atDeadline);
  const expired = runNotificationAttempt({ ...sound, attemptId: "deadline" }, () => now);
  now = { wallTimeMs: 1, monotonicMs: 5_000 };
  atDeadline.emit("close", 1);
  expect(spawn).toHaveBeenCalledTimes(1);
  // P3-NL-AC06 (3): 起動した後の失敗は次の backend へ進まず、結果の分からない終わり（adapterRejected）で返す。
  expect(await expired).toMatchObject({ kind: "failed", reason: "adapterRejected", attemptId: "deadline" });
});

// P3-NL-T08（P3-NL-AC06 (2)(3)、P3-NL-D-SOUND-BACKEND=B）: 起動しなかった試行は notStarted、起動した後の失敗は次の backend へ進まない。
// probe は無音なので起動した後の失敗の次を試し、鳴った backend の位置を残す。起動した後に失敗した試行の次は列の次の backend から始まる。
it("P3-NL-T08 contractBoundary / AC06: notStarted, no fallback after a launch, probe fallback and the sound backend position", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { probeSoundBackend, runNotificationAttempt } = await import("../../src/notification-delivery/adapter");
  const now = { wallTimeMs: 0, monotonicMs: 0 };
  const sound = { ...attempt, channel: "sound" as const, soundAsset: "reconstruction/assets/sounds/weather-info.wav" as const };
  const spawn = vi.mocked(childProcess.spawn).mockReset().mockImplementation(() => { throw new Error("ENOENT"); });
  expect(await runNotificationAttempt(sound, () => now)).toMatchObject({ kind: "failed", reason: "notStarted" });
  spawn.mockReset();
  expect(await runNotificationAttempt({ ...sound, attemptId: "late", timeoutAtMonotonicMs: 0 }, () => now))
    .toMatchObject({ kind: "failed", reason: "notStarted" });
  expect(spawn).not.toHaveBeenCalled();
  const backend = { index: 0 };
  const first = child(), second = child();
  spawn.mockReset().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const probe = probeSoundBackend("silent.wav", () => now, backend);
  first.emit("close", 1);
  second.emit("close", 0);
  expect([await probe, backend.index]).toMatchObject([{ kind: "delivered" }, 1]);
  const launched = child();
  spawn.mockReset().mockReturnValue(launched);
  const run = runNotificationAttempt({ ...sound, attemptId: "b" }, () => now, backend);
  launched.emit("close", 1);
  expect(await run).toMatchObject({ kind: "failed", reason: "adapterRejected" });
  expect([spawn.mock.calls.map(([exe]) => exe), backend.index]).toEqual([["/usr/bin/paplay"], 2]);
  const last = child();
  spawn.mockReset().mockReturnValue(last);
  const wrap = runNotificationAttempt({ ...sound, attemptId: "c" }, () => now, backend);
  last.emit("close", 1);
  await wrap;
  expect([spawn.mock.calls.map(([exe]) => exe), backend.index]).toEqual([["/usr/bin/aplay"], 0]);
});
