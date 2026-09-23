import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { calls, empty, notice, tick } from "./delivery-fixture";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";

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
  const initial = empty(now);
  const seeded = { ...initial, units: { ...initial.units, "U-W": { ...initial.units["U-W"], intents: [notice("one", "desktop", 0)] } } };
  const selected = reduceRuntime(seeded, tick(seeded, now), calls);
  const active = selected.notificationAttempts[0];
  const run = runNotificationAttempt(active, clock);
  const removed = { ...selected.state, units: { ...selected.state.units, "U-W": { ...selected.state.units["U-W"], intents: [] } } };
  const stopping = reduceRuntime(removed, tick(removed, now), calls);
  expect(stopping.abortRequests).toEqual([{ attemptId: active.attemptId, cause: "superseded" }]);
  const stop = abortNotificationAttempt(stopping.abortRequests[0], 1_000, clock);
  expect(handle.kill).toHaveBeenCalledWith("SIGTERM");
  handle.emit("exit", 0);
  now = { wallTimeMs: 100, monotonicMs: 1_000 };
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await stop).toEqual({ attemptId: active.attemptId, stopped: false, completedAt: now });
  expect(await run).toMatchObject({ kind: "aborted", reason: "superseded", stopped: false });
  expect(() => runNotificationAttempt({ ...attempt, attemptId: "two" }, clock)).toThrow("notification channel occupied");
  const isolated = reduceRuntime(stopping.state, { kind: "notificationResult", result: await run }, calls);
  expect(isolated.state.notificationChannels.desktop.kind).toBe("isolated");
  handle.emit("close", 0);
  expect(await run).toMatchObject({ kind: "aborted", reason: "superseded", stopped: false });
  const successor = { ...isolated.state, units: { ...isolated.state.units, "U-W": { ...isolated.state.units["U-W"],
    intents: [notice("two", "desktop", now.wallTimeMs)] } } };
  const late = reduceRuntime(successor, { kind: "notificationResult", result: { kind: "delivered", attemptId: active.attemptId,
    intentId: active.intentId, channel: "desktop", completedAt: now } }, calls);
  expect(late.state.notificationChannels.desktop.kind).toBe("isolated");
  expect(late.notificationAttempts).toEqual([]);
  expect(late.state.units["U-W"].intents[0].disposition).toBe("pending");
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
  expect(await expired).toMatchObject({ kind: "timeout", stopped: true, attemptId: "deadline" });
});
